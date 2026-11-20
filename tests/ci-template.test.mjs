// projectstore — tests/ci-template.test.mjs: the CI template, a workflow the
// user copies that runs follow after a merge and pushes the vault, its token
// handed to git alone (PS-FLOW, "A CI workflow template runs follow after a
// merge and pushes the vault"; the spec "The CI template…", alias
// `ci-template`, contracts 1 to 10; contract 11 is in tests/disclosure.test.mjs,
// contract 12 is the live run on a throwaway pair).
//
// Two halves. The static rules read templates/follow-github-actions.yml as
// text, as tests/release.test.mjs reads the workflows: no YAML parser. Each
// rule is a function of the text that returns its problems, so a planted copy
// (the spec's "Testing": a mutated copy of the text, never the shipped file)
// shows the rule failing. The local runner (tests/fixtures/workflow-runner.mjs)
// runs the job's steps with bash against a bare vault remote, the gh stub, the
// git recorder and an npx shim that runs this checkout's bin. Nothing reaches
// the network or GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EXPRESSIONS, REMOTE, evalExpr, jobWorld, readWorkflow, runJob } from "./fixtures/workflow-runner.mjs";
import { flowVault, git, gitCommit, storyText } from "./fixtures/flow.mjs";
import { appendLogLine, logLine, setFm } from "../scripts/status-log.mjs";
import { derivedViewPaths, headingLineRe, loadLayout } from "../scripts/lib.mjs";
import { runReconcile } from "../scripts/reconcile.mjs";
import { applyScaffold, planScaffold } from "../scripts/scaffold.mjs";
import { ownEnv } from "../scripts/verbs.mjs";
import { CI_TEMPLATE, checkVersions } from "../scripts/version-guard.mjs";
import { besideUrl } from "../packaging/directory-guard.mjs";
import { stripComments } from "./fixtures/vocabulary.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");
const TEMPLATE = read(CI_TEMPLATE);
const SHIPPED_SHA = createHash("sha256").update(TEMPLATE).digest("hex");
const VERSION = JSON.parse(read("package.json")).version;
const PACKLIST = JSON.parse(read("tests/fixtures/packlist.json"));
const PAGE = "docs/follow-in-ci.md";

// ─── Reading the template ──────────────────────────────────────────────

// The lines that are not comments.
const code = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const stepsOf = (text) => readWorkflow(text).jobs.follow.steps;
const named = (steps, re) => steps.find((s) => re.test(s.name || ""));
const runLines = (s) => String(s.run || "").split("\n");
const SECRET = "secrets.PROJECTSTORE_VAULT_TOKEN";
const REMOTE_SECRET = "secrets.PROJECTSTORE_VAULT_REMOTE";
const hasSecret = (s, name = SECRET) => Object.values(s.env).some((v) => v.includes(name));
// Each git call in a run block: its subcommand after any `-c <pair>`, and the line.
function gitCalls(steps) {
  const out = [];
  for (const s of steps)
    for (const line of runLines(s))
      for (const m of line.matchAll(/(?:^|[\s;|&(!])git((?:\s+-c\s+(?:"[^"]*"|\S+))*)\s+([a-z][a-z-]*)(.*)$/g))
        out.push({ step: s, pairs: m[1], sub: m[2], rest: m[3], line });
  return out;
}
const npxLines = (steps) => steps.flatMap((s) => runLines(s).filter((l) => /(?:^|\s)npx\s/.test(l)));
// A rule's problems, or the reader's refusal as one.
const problems = (rule) => (text) => {
  try {
    return rule(text);
  } catch (e) {
    return [`the reader refused: ${e.message}`];
  }
};
// A mutated copy: it must differ from the shipped text.
function planted(from, to, { all = false } = {}) {
  const out = all ? TEMPLATE.split(from).join(to) : TEMPLATE.replace(from, to);
  assert.notEqual(out, TEMPLATE, `the planted copy changes the text: ${String(from)}`);
  return out;
}
const failsOn = (rule, text, what) => assert.ok(rule(text).length > 0, `${what} fails the rule`);

// ─── The static rules, one per contract ────────────────────────────────

// Contract 1: the reader knows every line, every expression is on the list,
// the head comment names the four settings, and the shell is bash 3.2's.
const shapeRule = problems((text) => {
  const out = [];
  const wf = readWorkflow(text);
  for (const e of wf.expressions) if (!EXPRESSIONS.includes(e)) out.push(`expression ${e}`);
  const head = text.split("\n").slice(
    0,
    text.split("\n").findIndex((l) => !/^#/.test(l)),
  );
  for (const n of [
    "PROJECTSTORE_VAULT_TOKEN",
    "PROJECTSTORE_VAULT_REMOTE",
    "PROJECTSTORE_VAULT_LANGUAGE",
    "PROJECTSTORE_VAULT_BRANCH",
  ])
    if (!head.some((l) => l.includes(n))) out.push(`the opening comment does not name ${n}`);
  if (Object.keys(wf.jobs).length !== 1) out.push("not one job");
  for (const s of stepsOf(text))
    for (const l of runLines(s))
      if (/\bmapfile\b|\breadarray\b|\$\{\w+(?:,,|\^\^)\}|declare -A|base64 -w|&>>|\|&/.test(l))
        out.push(`not bash 3.2: ${l.trim()}`);
  return out;
});

// Contract 2: the trigger, the concurrency group, the permissions, the job.
const triggerRule = problems((text) => {
  const out = [];
  const wf = readWorkflow(text);
  if (JSON.stringify(wf.on) !== JSON.stringify({ push: { branches: ["main"] }, workflow_dispatch: {} }))
    out.push(`on is ${JSON.stringify(wf.on)}`);
  for (const ev of ["pull_request", "pull_request_target", "workflow_run", "schedule"])
    if (new RegExp(`^\\s*${ev}:`, "m").test(code(text))) out.push(`the event ${ev}`);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^ {4}branches:$/.test(l));
  if (at < 1 || !/^\s*#.*default branch has another name/.test(lines[at - 1]))
    out.push("no comment above the branch line saying to edit it");
  return out;
});
const headRule = problems((text) => {
  const out = [];
  const wf = readWorkflow(text);
  if (
    JSON.stringify(wf.concurrency) !== JSON.stringify({ group: "projectstore-follow", "cancel-in-progress": "false" })
  )
    out.push(`concurrency is ${JSON.stringify(wf.concurrency)}`);
  if ((code(text).match(/^concurrency:/gm) || []).length !== 1) out.push("not one concurrency block");
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read", "pull-requests": "read" }))
    out.push(`permissions are ${JSON.stringify(wf.permissions)}`);
  if (/: write\b/.test(code(text))) out.push("a line holds : write");
  const job = wf.jobs.follow;
  if (!job || job["runs-on"] !== "ubuntu-latest" || job["timeout-minutes"] !== "15")
    out.push("the job is not one follow job on ubuntu-latest with timeout-minutes 15");
  return out;
});

// Contract 3: the settings are checked first.
const checkRule = problems((text) => {
  const out = [];
  const [first] = stepsOf(text);
  if (!first || first.uses || !first.run) return ["the first step is not a run step"];
  if (!/settings/i.test(first.name || "")) out.push("the first step is not the settings check");
  for (const v of [SECRET, REMOTE_SECRET, "vars.PROJECTSTORE_VAULT_LANGUAGE"])
    if (!Object.values(first.env).some((x) => x.includes(v))) out.push(`step 1's env lacks ${v}`);
  for (const n of ["PROJECTSTORE_VAULT_TOKEN", "PROJECTSTORE_VAULT_REMOTE", "PROJECTSTORE_VAULT_LANGUAGE"])
    if (!runLines(first).some((l) => l.includes("::error::") && l.includes(n))) out.push(`no ::error:: names ${n}`);
  if (!/^\s*exit 1$/m.test(first.run)) out.push("step 1 has no exit 1");
  if (/(?:^|\s)(?:git|npx)\s/m.test(first.run)) out.push("step 1 runs git or npx");
  if (/\$VAULT_(?:REMOTE|TOKEN)"?\s*$|echo[^\n]*\$\{?VAULT_(?:REMOTE|TOKEN)/m.test(first.run))
    out.push("step 1 prints the remote or the token");
  return out;
});

// Contract 4: where the token is handed.
const HEADER = "http.$host.extraheader=AUTHORIZATION: basic $auth";
const tokenRule = problems((text) => {
  const out = [];
  const steps = stepsOf(text);
  const expected = [steps[0], named(steps, /^Clone/), named(steps, /push/i)].map((s) => s && s.name);
  // The token and the remote, both secrets, in the env of the same three steps.
  for (const name of [SECRET, REMOTE_SECRET]) {
    const withSecret = steps.filter((s) => hasSecret(s, name)).map((s) => s.name);
    if (JSON.stringify(withSecret) !== JSON.stringify(expected))
      out.push(`${name} is in the env of: ${withSecret.join(" | ")}`);
  }
  for (const s of steps)
    if (Object.values(s.env).some((v) => /vars\.PROJECTSTORE_VAULT_REMOTE/.test(v)))
      out.push(`the remote as a variable: ${s.name}`);
  for (const s of steps)
    if (/(?:^|\s)npx\s/m.test(s.run || "") && Object.values(s.env).some((v) => /secrets\./.test(v)))
      out.push(`a step that runs npx holds a secret: ${s.name}`);
  for (const s of steps) if (s.run && s.run.includes("${{")) out.push(`a run block holds an expression: ${s.name}`);
  const uses = steps.filter((s) => s.uses);
  if (JSON.stringify(uses.map((s) => s.uses)) !== JSON.stringify(["actions/checkout@v5", "actions/setup-node@v5"]))
    out.push(`uses: ${uses.map((s) => s.uses).join(", ")}`);
  if (uses[0]?.with["persist-credentials"] !== "false") out.push("the checkout keeps credentials");
  if (uses[1]?.with["node-version"] !== "24") out.push("setup-node is not Node 24");
  const calls = gitCalls(steps);
  for (const c of calls)
    if (!["clone", "add", "ls-files", "diff", "commit", "push"].includes(c.sub)) out.push(`git ${c.sub}`);
  for (const sub of ["clone", "commit", "push"]) {
    const these = calls.filter((c) => c.sub === sub);
    if (!these.length || these.some((c) => !/(?:^|\s)--quiet\b/.test(c.rest))) out.push(`git ${sub} without --quiet`);
  }
  for (const c of calls) {
    const header = c.pairs.includes("extraheader");
    if (header !== ["clone", "push"].includes(c.sub)) out.push(`the header on git ${c.sub}`);
    if (header && (!c.pairs.includes("-c credential.helper=") || !c.pairs.includes(`"${HEADER}"`)))
      out.push(`git ${c.sub}: not -c credential.helper= and the host's header`);
    if (header && c.step.env.GIT_TERMINAL_PROMPT !== "0") out.push(`git ${c.sub}: GIT_TERMINAL_PROMPT is not 0`);
    if (header) {
      const lines = runLines(c.step);
      const mask = lines.findIndex((l) => l.trim() === 'echo "::add-mask::$auth"');
      const made = lines.findIndex((l) => l.includes(`printf 'x-access-token:%s' "$VAULT_TOKEN" | base64`));
      if (made < 0 || mask < made || mask > lines.indexOf(c.line)) out.push(`git ${c.sub}: the mask is not before use`);
    }
  }
  for (const s of steps)
    for (const l of runLines(s)) {
      if (/\bset\s+-[a-z]*x|set -o xtrace|bash -x/.test(l)) out.push(`tracing: ${l.trim()}`);
      if (
        /\$\{?VAULT_TOKEN\b/.test(l) &&
        !/^\s*if \[ -z "\$VAULT_TOKEN" \]; then$/.test(l) &&
        !/printf 'x-access-token:%s' "\$VAULT_TOKEN" \| base64/.test(l)
      )
        out.push(`the token is used beyond its check and its header: ${l.trim()}`);
      if (/\$\{?auth\b/.test(l) && l.trim() !== 'echo "::add-mask::$auth"' && !l.includes(`"${HEADER}"`))
        out.push(`the header value is used beyond its mask and git: ${l.trim()}`);
    }
  return out;
});

// Contract 5: the clone, the pin, the binding.
const pinRule = (version) =>
  problems((text) => {
    const out = [];
    const steps = stepsOf(text);
    const clone = gitCalls(steps).find((c) => c.sub === "clone");
    if (
      !clone ||
      !clone.rest.includes(
        '--single-branch ${VAULT_BRANCH:+"--branch=$VAULT_BRANCH"} -- "$VAULT_REMOTE" "$RUNNER_TEMP/vault"',
      )
    )
      out.push("the clone is not --single-branch, with --branch only when set, into $RUNNER_TEMP/vault");
    const lines = npxLines(steps).map((l) => l.trim());
    const want = [
      `npx --yes projectstore@${version} bind --rebind --language="$VAULT_LANGUAGE" -- "$RUNNER_TEMP/vault"`,
      `npx --yes projectstore@${version} follow --write > "$RUNNER_TEMP/follow.txt" 2>&1 || code=$?`,
    ];
    if (JSON.stringify(lines) !== JSON.stringify(want)) out.push(`the npx lines are: ${lines.join(" | ")}`);
    return out;
  });

// Contract 6: follow, and its exit carried to the last step.
const exitRule = problems((text) => {
  const out = [];
  const steps = stepsOf(text);
  const follow = steps.find((s) => s.id === "follow");
  if (!follow) return ["no step with id follow"];
  if (
    JSON.stringify(follow.env) !==
    JSON.stringify({ GH_TOKEN: "${{ github.token }}", REPO_PRIVATE: "${{ github.event.repository.private }}" })
  )
    out.push(`the follow step's env is ${JSON.stringify(follow.env)}`);
  const line = runLines(follow).find((l) => /\bfollow\b/.test(l) && /npx/.test(l)) || "";
  if (!/ follow --write /.test(line) || /--pr\b|--story\b/.test(line)) out.push(`the follow line: ${line.trim()}`);
  if (!/ > "\$RUNNER_TEMP\/follow\.txt" 2>&1 \|\| code=\$\?$/.test(line))
    out.push("the follow line does not end in || code=$?");
  if (!runLines(follow).some((l) => l.trim() === 'echo "code=$code" >> "$GITHUB_OUTPUT"'))
    out.push("no code= to $GITHUB_OUTPUT");
  const last = steps.at(-1);
  if (last.env.FOLLOW_CODE !== "${{ steps.follow.outputs.code }}" || last.run !== 'exit "$FOLLOW_CODE"\n')
    out.push('the last step is not exit "$FOLLOW_CODE"');
  if (steps.indexOf(follow) > steps.indexOf(named(steps, /push/i))) out.push("the push runs before follow");
  return out;
});

// Contract 7: follow's text only when the repository is private.
const logRule = problems((text) => {
  const out = [];
  const follow = stepsOf(text).find((s) => s.id === "follow");
  const lines = runLines(follow).map((l) => l.trim());
  const at = lines.indexOf('if [ "$REPO_PRIVATE" = "true" ]; then');
  if (at < 0 || lines[at + 1] !== 'cat "$RUNNER_TEMP/follow.txt"' || lines[at + 2] !== "else")
    out.push("the text is not printed only when private");
  if (!/withheld/.test(lines[at + 3] || "") || !/\$code/.test(lines[at + 3] || ""))
    out.push("no withheld sentence with the exit code");
  if (lines.filter((l) => l.includes("follow.txt")).length !== 2) out.push("follow's text is read elsewhere");
  for (const s of stepsOf(text))
    for (const l of runLines(s)) if (/echo[^\n]*\$\{?VAULT_REMOTE/.test(l)) out.push(`prints the remote: ${l.trim()}`);
  return out;
});

// Contract 8: what is staged.
const STAGED = ["epics", "kanban.md", "graph.md", "code-map.md", "flow.md", "spec-tree.md"];
const INDEXES = "git ls-files -m -o --exclude-standard -- ':(glob)*/README.md'";
const stagingRule = problems((text) => {
  const out = [];
  const push = named(stepsOf(text), /push/i);
  if (!push) return ["no push step"];
  const lines = runLines(push).map((l) => l.trim());
  if (lines[0] !== 'cd "$RUNNER_TEMP/vault"') out.push("the push step does not work in the clone");
  const loop = lines.find((l) => /^for path in /.test(l)) || "";
  const names = loop
    .replace(/^for path in /, "")
    .replace(/; do$/, "")
    .split(/\s+/);
  if (JSON.stringify(names) !== JSON.stringify(STAGED)) out.push(`the staged names are: ${names.join(" ")}`);
  if (!lines.includes('if [ -e "$path" ]; then git add -A -- "$path"; fi')) out.push("a name is staged without [ -e ]");
  if (!lines.includes(`${INDEXES} | while IFS= read -r index; do`) || !lines.includes('git add -- "$index"'))
    out.push("the folder indexes are not staged from git ls-files");
  const adds = gitCalls([push]).filter((c) => c.sub === "add");
  if (adds.length !== 2) out.push(`git add is called ${adds.length} times`);
  if (/\.projectstore/.test(push.run)) out.push("a pathspec names .projectstore");
  return out;
});

// Contract 9: the commit and the push, never forced.
const BOT = "github-actions[bot]";
const BOT_MAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const pushRule = problems((text) => {
  const out = [];
  const push = named(stepsOf(text), /push/i);
  for (const [k, v] of Object.entries({
    GIT_AUTHOR_NAME: BOT,
    GIT_AUTHOR_EMAIL: BOT_MAIL,
    GIT_COMMITTER_NAME: BOT,
    GIT_COMMITTER_EMAIL: BOT_MAIL,
  }))
    if (push.env[k] !== v) out.push(`${k} is ${push.env[k]}`);
  const calls = gitCalls(stepsOf(text));
  const commit = calls.filter((c) => c.sub === "commit");
  if (commit.length !== 1 || commit[0].rest.trim() !== '--quiet -m "follow: update the vault after a merge"')
    out.push("the commit message is not the fixed one");
  const pushes = calls.filter((c) => c.sub === "push");
  if (pushes.length !== 1 || pushes[0].rest.trim() !== "--quiet origin HEAD; then")
    out.push(`the push is: ${pushes.map((c) => c.rest).join(" | ")}`);
  for (const c of pushes) if (/--force|(?:^|\s)-f\b|--mirror|\s\+\S/.test(c.rest)) out.push(`a forced push: ${c.rest}`);
  const lines = runLines(push).map((l) => l.trim());
  const refused = lines.find((l) => l.startsWith('echo "::error::')) || "";
  if (!/Nothing was forced/.test(refused) || !/Re-run/.test(refused))
    out.push("the refusal does not say nothing was forced and to re-run");
  if (!lines.includes("if git diff --cached --quiet; then") || !lines.some((l) => /^echo "Nothing to push/.test(l)))
    out.push("nothing staged does not say there is nothing to push");
  return out;
});

// ─── The world ─────────────────────────────────────────────────────────

const GH = "https://github.com/acme/app";
const prUrl = (n) => `${GH}/pull/${n}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const STARTED = "2026-11-01T09:00:00.000Z";
const SINCE = "2026-10-01";
const POLICY = { lifecycle_gates: "on", gates_since: SINCE, spec_policy: "required", spec_policy_since: SINCE };
const TITLE = "Quiet launch of the reporting page";
const CANARY = `ci-canary-${randomBytes(12).toString("hex")}`;
const CANARY_B64 = Buffer.from(`x-access-token:${CANARY}`).toString("base64");
const STORY_A = "epics/PS-X/stories/story-a.md";

const mergedPr = (n, o = {}) => ({
  url: prUrl(n),
  state: "MERGED",
  isDraft: false,
  isCrossRepository: false,
  baseRefName: "main",
  createdAt: "2026-11-01T08:00:00Z",
  mergedAt: "2026-11-02T10:00:00Z",
  mergeCommit: { oid: SHA },
  updatedAt: "2026-11-02T10:00:00Z",
  closedAt: "2026-11-02T10:00:00Z",
  body: "",
  ...o,
});

function withSection(text, id, body) {
  const m = text.match(headingLineRe(id));
  const start = m.index + m[0].trimEnd().length;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  return `${text.slice(0, start)}\n\n${body}\n\n${text.slice(end)}`;
}
// A review story, ready to close, whose external_refs.pr is pull request `n`.
function reviewStory(id, n, title = id) {
  let t = storyText({
    id,
    log: [{ to: "in-progress", at: STARTED, reason: "work started", actor: "plan gate" }],
    fm: {
      started_at: JSON.stringify(STARTED),
      plan_updated_at: JSON.stringify(STARTED),
      specs: JSON.stringify(["covering"]),
      title: JSON.stringify(title),
      external_refs: JSON.stringify({ pr: prUrl(n) }),
    },
  });
  t = withSection(t, "implementation_plan", "Route through contract 1.");
  t = withSection(t, "acceptance", "- [x] it works — evidence: tests/a.test.mjs");
  t = withSection(t, "final_summary", "Shipped it.");
  const at = "2026-11-03T09:00:00.000Z";
  return appendLogLine(
    setFm(setFm(t, "status", "review"), "status_changed_at", JSON.stringify(at)),
    logLine({ at, field: "status", from: "in-progress", to: "review", reason: "r", actor: "move" }),
  );
}

// A vault with the stories, a spec covering them, and its derived views
// generated, as a vault that is used already holds them.
function vaultOf(stories, { language = "en", drop = [] } = {}) {
  const fx = flowVault({ vaultCfg: POLICY, stories });
  const refs = Object.keys(stories);
  writeFileSync(
    join(fx.vault, "specs", "covering.md"),
    `---\ntype: spec\nid: "covering"\ntitle: "covering"\nstatus: active\ndate: 2026-10-01\nalias: covering\nstories: ${JSON.stringify(refs)}\n---\n\n# covering\n\n## Behavioral contracts\n\n1. **It works.** The thing works.\n\n   - GIVEN a thing\n   - WHEN it runs\n   - THEN it works\n\n## Acceptance\n\n- [x] it works — stories: ${refs.map((r) => r.split("/")[1]).join(", ")}\n`,
  );
  // The layout's folders and their README indexes, as a scaffolded vault has them.
  applyScaffold(planScaffold(fx.vault, { layout: "engineering", language }));
  const binding = join(fx.proj, ".projectstore", "projectstore.json");
  writeFileSync(binding, JSON.stringify({ ...JSON.parse(readFileSync(binding, "utf8")), language }));
  const views = runReconcile({ write: true, projectDir: fx.proj, env: ownEnv({ ...process.env }, fx.proj) });
  assert.equal(views.summary.failed, 0, JSON.stringify(views));
  assert.ok(existsSync(join(fx.vault, "kanban.md")), "the vault has its board");
  for (const p of drop) rmSync(join(fx.vault, p), { force: true });
  return fx.vault;
}

const VARS = { PROJECTSTORE_VAULT_LANGUAGE: "en", PROJECTSTORE_VAULT_BRANCH: "" };
const SECRETS = { PROJECTSTORE_VAULT_TOKEN: CANARY, PROJECTSTORE_VAULT_REMOTE: REMOTE };
function run(w, o = {}) {
  return runJob(o.template || TEMPLATE, {
    workspace: w.ws,
    env: w.env,
    vars: { ...VARS, ...(o.vars || {}) },
    secrets: { ...SECRETS, ...(o.secrets || {}) },
    repoPrivate: o.repoPrivate,
    before: o.before,
    after: o.after,
  });
}
const tip = (w) => git(w.bare, ["rev-parse", "HEAD"]);
const show = (r) => `exit ${r.code} at ${r.failed ? r.failed.name : "-"}\n${r.log.join("\n")}`;
// What each git call did, by its subcommand after any -c pairs.
const subOf = (argv) => {
  let i = 0;
  while (argv[i] === "-c") i += 2;
  return argv[i];
};

// The main scenario: one story whose pull request merged, in a private
// repository; then the same facts again, on a fresh clone.
let MAIN = null;
function main() {
  if (MAIN) return MAIN;
  const w = jobWorld({
    vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7, TITLE) }),
    table: { prs: [mergedPr(7)] },
  });
  const before = tip(w);
  const first = run(w);
  const firstTip = tip(w);
  const npx = w.npx.log();
  const recorded = w.git.log();
  const ghCalls = w.gh.log();
  const second = run(w);
  MAIN = { w, before, first, firstTip, second, npx, recorded, ghCalls };
  return MAIN;
}

// ═══ Contract 1: the file, where it lives, its shape ════════════════════

// [ci-template#1]
test("shape: no shipped module, hook or command, skill or agent text names the template, writes under .github/, or has git commit or push; planted ones fail", () => {
  const files = PACKLIST.filter(
    (f) =>
      /\.(?:mjs|cjs|js)$/.test(f) ||
      /^hooks\/[^/]+\.tsx$/.test(f) ||
      (/^(?:commands|skills|agents)\//.test(f) && f.endsWith(".md")),
  );
  assert.ok(files.includes("hooks/band.tsx") && files.some((f) => f.startsWith("commands/")), "the set is read");
  const NAMES = /follow-github-actions/;
  const GITHUB_DIR = /\.github[/\\]|["']\.github["']\s*,\s*["']workflows/;
  const COMMIT_PUSH = /\bgit\s+(?:-c\s+\S+\s+)*(?:commit|push)\b|["'](?:commit|push)["']/;
  const offends = (text) => [NAMES, GITHUB_DIR, COMMIT_PUSH].filter((re) => re.test(text)).map(String);
  // The one reader: the version guard reads the template's pin as a version
  // site (contract 5). It names the file in one constant and writes nothing to it.
  const GUARD = "scripts/version-guard.mjs";
  const guard = stripComments(read(GUARD));
  assert.deepEqual(
    guard.split("\n").filter((l) => NAMES.test(l)),
    ['export const CI_TEMPLATE = "templates/follow-github-actions.yml";'],
    "the guard names the template in its constant alone",
  );
  assert.ok(
    !/(?:writeFile\w*|copyFile\w*|cpSync|renameSync)\([^)]*CI_TEMPLATE/.test(guard),
    "the guard never writes the template",
  );
  const text = (f) => (f === GUARD ? guard.replace(/^export const CI_TEMPLATE = .*$/m, "") : read(f));
  const bad = files.filter((f) => offends(text(f)).length).map((f) => `${f}: ${offends(text(f)).join(", ")}`);
  assert.deepEqual(bad, [], "ProjectStore never installs the template, and no shipped code commits or pushes");
  for (const plant of [
    'copyFileSync(join(root, "templates", "follow-github-actions.yml"), dest);',
    'writeFileSync(join(project, ".github/workflows/follow.yml"), text);',
    'mkdirSync(join(project, ".github", "workflows"));',
    'spawnSync("git", ["push", "origin", "HEAD"]);',
    'spawnSync("git", ["commit", "-m", "x"]);',
    "Run `git push` when you are done.",
  ])
    assert.ok(offends(plant).length > 0, `planted: ${plant}`);
});

// [ci-template#1]
test("shape: the reader knows every line of the template, every expression is on the list, the opening comment names the four settings, and the shell is bash 3.2's", () => {
  assert.deepEqual(shapeRule(TEMPLATE), []);
  const wf = readWorkflow(TEMPLATE);
  assert.deepEqual([...new Set(wf.expressions)].sort(), [...EXPRESSIONS].sort(), "every listed expression is used");
  assert.equal(stepsOf(TEMPLATE).length, 8, "eight steps");
  // Planted copies, each refused by the reader.
  for (const [what, text] of [
    [
      "a flow-style map",
      planted("        with:\n          persist-credentials: false", "        with: { persist-credentials: false }"),
    ],
    [
      "a tab",
      planted(
        '          GIT_TERMINAL_PROMPT: "0"\n        run: |\n          host',
        '\tGIT_TERMINAL_PROMPT: "0"\n        run: |\n          host',
      ),
    ],
    ["an anchor", planted("        env:\n          VAULT_LANGUAGE:", "        env: &bind\n          VAULT_LANGUAGE:")],
    ["an unknown key", planted("        id: follow\n", "        id: follow\n        continue-on-error: true\n")],
    [
      "an expression off the list",
      planted(
        "REPO_PRIVATE: ${{ github.event.repository.private }}",
        "REPO_PRIVATE: ${{ github.event.head_commit.message }}",
      ),
    ],
  ]) {
    failsOn(shapeRule, text, what);
    assert.throws(() => readWorkflow(text), undefined, `the reader throws on ${what}`);
  }
  assert.ok(
    shapeRule(
      planted(
        'tr -d \'\\n\')"\n          echo "::add-mask::$auth"\n          git',
        'tr -d \'\\n\')"\n          mapfile -t x < /dev/null\n          echo "::add-mask::$auth"\n          git',
      ),
    ).length > 0,
    "mapfile is not bash 3.2",
  );
  // The evaluator refuses what the reader refuses.
  assert.throws(() => evalExpr("${{ github.event.head_commit.message }}", {}), /not on the list/);
  assert.equal(evalExpr("${{ vars.PROJECTSTORE_VAULT_BRANCH }}", { vars: { PROJECTSTORE_VAULT_BRANCH: "b" } }), "b");
});

// ═══ Contract 2: trigger, concurrency, permissions ══════════════════════

// [ci-template#2]
test("trigger: on is push with the one branch main, under a comment saying to edit it, and workflow_dispatch with no inputs; none of the four other events; planted ones fail", () => {
  assert.deepEqual(triggerRule(TEMPLATE), []);
  failsOn(
    triggerRule,
    planted("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request_target:\n"),
    "pull_request_target",
  );
  failsOn(triggerRule, planted("      - main\n", "      - main\n      - develop\n"), "a second branch");
  failsOn(triggerRule, planted("  workflow_dispatch:\n", "  workflow_dispatch:\n  schedule:\n"), "schedule");
});

// [ci-template#2]
test("head: one concurrency group projectstore-follow with cancel-in-progress false, permissions contents and pull-requests read, no : write, one job on ubuntu-latest for 15 minutes; planted ones fail", () => {
  assert.deepEqual(headRule(TEMPLATE), []);
  failsOn(headRule, planted("  contents: read", "  contents: write"), "contents: write");
  failsOn(headRule, planted("  cancel-in-progress: false", "  cancel-in-progress: true"), "cancel-in-progress: true");
  failsOn(
    headRule,
    planted("  pull-requests: read\n", "  pull-requests: read\n  issues: read\n"),
    "a third permission",
  );
});

// ═══ Contract 3: the settings, checked first ════════════════════════════

// [ci-template#3]
test("settings: step 1 holds the three names in ::error:: lines and exit 1, before any uses:, git or npx; a checkout before it fails", () => {
  assert.deepEqual(checkRule(TEMPLATE), []);
  const steps = stepsOf(TEMPLATE);
  assert.equal(
    steps.findIndex((s) => s.uses),
    1,
    "the first uses: is step 2",
  );
  const check = "      - name: Check the vault settings";
  const checkout = "      - uses: actions/checkout@v5\n        with:\n          persist-credentials: false\n\n";
  assert.ok(TEMPLATE.includes(checkout) && TEMPLATE.includes(check));
  const moved = TEMPLATE.replace(checkout, "").replace(check, checkout + check);
  assert.notEqual(moved, TEMPLATE);
  failsOn(checkRule, moved, "the checkout before the check");
  assert.equal(stepsOf(moved)[0].uses, "actions/checkout@v5", "not vacuous: the planted copy has the checkout first");
});

// [ci-template#3]
test("settings: no PROJECTSTORE_VAULT_TOKEN exits 1 at step 1 naming the secret, and the npx shim and the git recorder saw no call (failure)", () => {
  const w = jobWorld({ vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), table: { prs: [mergedPr(7)] } });
  for (const secrets of [{ PROJECTSTORE_VAULT_TOKEN: undefined }, { PROJECTSTORE_VAULT_TOKEN: "" }]) {
    const r = run(w, { secrets });
    assert.equal(r.code, 1, show(r));
    assert.equal(r.failed.index, 0, show(r));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^The secret PROJECTSTORE_VAULT_TOKEN is not set\./);
  }
  assert.deepEqual(w.npx.log(), [], "no npx call");
  assert.deepEqual(w.git.log(), [], "no git call");
  assert.deepEqual(w.gh.log(), [], "no gh call");
});

// [ci-template#3]
test("settings: a remote with a user part, an ssh remote and no remote each exit 1 at step 1 naming PROJECTSTORE_VAULT_REMOTE, and the log does not hold the remote (failure)", () => {
  const w = jobWorld({ vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), table: { prs: [mergedPr(7)] } });
  for (const remote of [
    "https://first.last:hunter2@git.example.com/team/vault.git",
    "https://x-access-token@git.example.com/team/vault.git",
    "git@git.example.com:team/vault.git",
    "ssh://git@git.example.com/team/vault.git",
    "",
  ]) {
    const r = run(w, { secrets: { PROJECTSTORE_VAULT_REMOTE: remote } });
    assert.equal(r.code, 1, `${remote}: ${show(r)}`);
    assert.equal(r.failed.index, 0, show(r));
    assert.equal(r.errors.length, 1, show(r));
    assert.match(r.errors[0], /^The secret PROJECTSTORE_VAULT_REMOTE /);
    if (remote)
      assert.ok(!r.raw.includes(remote) && !r.raw.includes("git.example.com"), `the log holds no remote: ${r.raw}`);
    assert.ok(!r.raw.includes("hunter2"));
  }
  assert.deepEqual(w.npx.log(), []);
});

// [ci-template#3]
test("settings: a ru vault with an empty PROJECTSTORE_VAULT_LANGUAGE exits 1 at step 1 naming it, before the clone, and the remote gains no commit (failure)", () => {
  const vault = vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }, { language: "ru" });
  const w = jobWorld({ vault, table: { prs: [mergedPr(7)] } });
  const before = tip(w);
  const english = readFileSync(join(vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), "kanban.md"), "utf8");
  assert.notEqual(git(w.bare, ["show", "HEAD:kanban.md"]), english, "the vault's board is not the English one");
  const r = run(w, { vars: { PROJECTSTORE_VAULT_LANGUAGE: "" } });
  assert.equal(r.code, 1, show(r));
  assert.equal(r.failed.index, 0);
  assert.match(r.errors.join("\n"), /PROJECTSTORE_VAULT_LANGUAGE is not set/);
  assert.deepEqual(w.git.log(), [], "no clone");
  assert.deepEqual(w.npx.log(), []);
  assert.equal(tip(w), before, "the remote gains no commit");
});

// ═══ Contract 4: where the token is handed ══════════════════════════════

// [ci-template#4]
test("token: with a canary token, the raw output without its ::add-mask:: lines, the clone's .git/config and every command line but the clone's and the push's hold neither the canary nor its base64", () => {
  const { first, recorded, npx, ghCalls } = main();
  assert.equal(first.code, 0, show(first));
  const leaks = (s) => [CANARY, CANARY_B64].filter((k) => String(s).includes(k));
  const unmasked = first.raw
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
  assert.deepEqual(leaks(unmasked), [], "the raw output");
  assert.ok(first.raw.includes(`::add-mask::${CANARY_B64}`), "not vacuous: the header value was registered as a mask");
  assert.deepEqual(leaks(first.log.join("\n")), [], "the masked log");
  const config = readFileSync(join(first.runnerTemp, "vault", ".git", "config"), "utf8");
  assert.deepEqual(leaks(config), [], "the clone's .git/config");
  assert.ok(!/extraheader|x-access-token/.test(config), "no header is stored");
  assert.match(config, new RegExp(`url = ${REMOTE.replace(/[.]/g, "\\.")}`), "the remote is the URL alone");
  const others = recorded.filter((c) => !["clone", "push"].includes(subOf(c.argv)));
  assert.ok(others.length > 3, "the other git calls are recorded");
  assert.deepEqual(
    others.filter((c) => leaks(JSON.stringify(c)).length),
    [],
    "no other git command line",
  );
  assert.deepEqual(
    npx.filter((c) => leaks(JSON.stringify(c)).length),
    [],
    "nor the npx calls or their environment",
  );
  assert.deepEqual(
    ghCalls.filter((c) => leaks(JSON.stringify(c)).length),
    [],
    "nor the gh calls",
  );
});

// [ci-template#4]
test("token: the git recorder sees the header on clone and push only, each with -c credential.helper=, scoped to the remote's host, and --quiet", () => {
  const { recorded } = main();
  const header = `http.https://git.example.com/.extraheader=AUTHORIZATION: basic ${CANARY_B64}`;
  const withHeader = recorded.filter((c) => c.argv.some((a) => a.includes("extraheader")));
  assert.deepEqual(
    withHeader.map((c) => subOf(c.argv)),
    ["clone", "push"],
  );
  for (const c of withHeader) {
    assert.deepEqual(c.argv.slice(0, 4), ["-c", "credential.helper=", "-c", header], JSON.stringify(c.argv));
    assert.ok(c.argv.includes("--quiet"), `${subOf(c.argv)} is quiet`);
  }
  assert.ok(
    recorded.some((c) => subOf(c.argv) === "commit" && c.argv.includes("--quiet")),
    "the commit is quiet",
  );
});

// [ci-template#4]
test("token: the secret is in the env of the check, the clone and the push only; no run line holds ${{; the two uses: are checkout@v5 without credentials and setup-node@v5 on 24; git runs only the listed subcommands, clone, commit and push with --quiet; planted copies fail", () => {
  assert.deepEqual(tokenRule(TEMPLATE), []);
  for (const [what, text] of [
    [
      "the token in the follow step's env",
      planted(
        "          GH_TOKEN: ${{ github.token }}\n",
        "          GH_TOKEN: ${{ github.token }}\n          VAULT_TOKEN: ${{ secrets.PROJECTSTORE_VAULT_TOKEN }}\n",
      ),
    ],
    ["persist-credentials: true", planted("persist-credentials: false", "persist-credentials: true")],
    ["set -x", planted('          cd "$RUNNER_TEMP/vault"\n', '          set -x\n          cd "$RUNNER_TEMP/vault"\n')],
    ["actions/checkout@main", planted("actions/checkout@v5", "actions/checkout@main")],
    [
      "a step that prints the header",
      planted(
        '          echo "::add-mask::$auth"\n          git -c credential.helper= -c "http.$host.extraheader=AUTHORIZATION: basic $auth" clone',
        '          echo "::add-mask::$auth"\n          echo "$auth"\n          git -c credential.helper= -c "http.$host.extraheader=AUTHORIZATION: basic $auth" clone',
      ),
    ],
    ["a push with no --quiet", planted(" push --quiet origin HEAD", " push origin HEAD")],
    ["an expression in a run block", planted('cd "$RUNNER_TEMP/vault"', 'cd "${{ vars.PROJECTSTORE_VAULT_BRANCH }}"')],
    [
      "the token in a URL",
      planted(
        "clone --quiet --single-branch",
        'clone --quiet "https://x:$VAULT_TOKEN@git.example.com/v.git" --single-branch',
      ),
    ],
    ["git fetch", planted("          git commit --quiet", "          git fetch --quiet\n          git commit --quiet")],
    [
      "the remote as a variable",
      planted(
        "VAULT_REMOTE: ${{ secrets.PROJECTSTORE_VAULT_REMOTE }}",
        "VAULT_REMOTE: ${{ vars.PROJECTSTORE_VAULT_REMOTE }}",
      ),
    ],
    [
      "the remote in the follow step's env",
      planted(
        "          GH_TOKEN: ${{ github.token }}\n",
        "          GH_TOKEN: ${{ github.token }}\n          VAULT_REMOTE: ${{ secrets.PROJECTSTORE_VAULT_REMOTE }}\n",
      ),
    ],
  ])
    failsOn(tokenRule, text, what);
});

// ═══ Contract 5: the clone, the pin, the binding ════════════════════════

// [ci-template#5]
test("bind: in a workspace with no binding and PROJECTSTORE_VAULT_LANGUAGE en, the npx shim sees bind --rebind --language=en -- <clone> and then follow --write, both at package.json's version, and nothing else", () => {
  const { first, npx } = main();
  const clone = join(first.runnerTemp, "vault");
  assert.deepEqual(
    npx.map((c) => c.argv),
    [
      ["--yes", `projectstore@${VERSION}`, "bind", "--rebind", "--language=en", "--", clone],
      ["--yes", `projectstore@${VERSION}`, "follow", "--write"],
    ],
  );
  assert.equal(npx[0].env.VAULT_LANGUAGE, "en");
});

// [ci-template#5]
test("bind: a workspace bound to another path is re-pointed and follow runs on the clone; PROJECTSTORE_VAULT_LANGUAGE xx fails at bind with exit 2, before follow (edge)", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "ps-ci-old-vault-"));
  const w = jobWorld({
    vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }),
    table: { prs: [mergedPr(7)] },
    bound: elsewhere,
  });
  const before = tip(w);
  const r = run(w);
  assert.equal(r.code, 0, show(r));
  const binding = JSON.parse(readFileSync(join(w.ws, ".projectstore", "projectstore.json"), "utf8"));
  assert.equal(binding.vault_path, join(r.runnerTemp, "vault"), "re-pointed at the clone");
  assert.equal(
    git(w.bare, ["rev-list", "--count", `${before}..HEAD`]),
    "1",
    "follow ran on the clone, and its move was pushed",
  );
  assert.deepEqual(readdirSync(elsewhere), [], "the old path is untouched");
  const w2 = jobWorld({ vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), table: { prs: [mergedPr(7)] } });
  const bad = run(w2, { vars: { PROJECTSTORE_VAULT_LANGUAGE: "xx" } });
  assert.equal(bad.code, 2, show(bad));
  assert.equal(bad.failed.name, "Bind this job to the vault clone");
  assert.match(bad.log.join("\n"), /unknown language "xx"/);
  assert.deepEqual(
    w2.npx.log().map((c) => c.argv[2]),
    ["bind"],
    "follow never ran",
  );
  assert.deepEqual(w2.gh.log(), []);
});

// [ci-template#5]
test("bind: PROJECTSTORE_VAULT_BRANCH naming a branch the remote has clones and pushes that branch; one it lacks fails at the clone, before bind (edge)", () => {
  const vault = vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) });
  const w = jobWorld({ vault, table: { prs: [mergedPr(7)] } });
  git(w.bare, ["branch", "vault-work", "main"]);
  const main0 = tip(w);
  const r = run(w, { vars: { PROJECTSTORE_VAULT_BRANCH: "vault-work" } });
  assert.equal(r.code, 0, show(r));
  assert.equal(git(join(r.runnerTemp, "vault"), ["rev-parse", "--abbrev-ref", "HEAD"]), "vault-work");
  assert.equal(git(w.bare, ["rev-list", "--count", "main..vault-work"]), "1", "the move lands on that branch");
  assert.equal(tip(w), main0, "the default branch is untouched");
  const clone = w.git.log().find((c) => subOf(c.argv) === "clone");
  assert.ok(
    clone.argv.includes("--branch=vault-work") && clone.argv.includes("--single-branch"),
    JSON.stringify(clone.argv),
  );
  const w2 = jobWorld({ vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), table: { prs: [mergedPr(7)] } });
  const bad = run(w2, { vars: { PROJECTSTORE_VAULT_BRANCH: "no-such-branch" } });
  assert.notEqual(bad.code, 0, show(bad));
  assert.equal(bad.failed.name, "Clone the vault");
  assert.deepEqual(w2.npx.log(), [], "bind never ran");
  assert.ok(!bad.log.join("\n").includes(REMOTE), "the remote, a secret, is masked even in git's error");
  // With the branch unset, the clone names none.
  const plain = main().recorded.find((c) => subOf(c.argv) === "clone");
  assert.ok(!plain.argv.some((a) => a.startsWith("--branch")), JSON.stringify(plain.argv));
});

// [ci-template#5]
test("pin: both npx lines name package.json's version and the guard checks them; a template naming another version fails the guard with version mismatch, and a bare projectstore fails the test (failure)", () => {
  assert.deepEqual(pinRule(VERSION)(TEMPLATE), []);
  assert.equal(checkVersions().ok, true, "the real tree agrees");
  assert.ok(
    checkVersions().checked.filter((s) => s.file === CI_TEMPLATE && s.version === VERSION).length === 2,
    "the template's two strings are checked sites",
  );
  failsOn(pinRule(VERSION), planted(`projectstore@${VERSION} bind`, "projectstore bind"), "a bare projectstore");
  failsOn(pinRule(VERSION), planted(`projectstore@${VERSION}`, "projectstore@0.0.1", { all: true }), "another version");
  // The guard, over a scratch tree with the core's sites and a drifted template.
  const root = mkdtempSync(join(tmpdir(), "ps-ci-guard-"));
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), read(rel));
  }
  mkdirSync(join(root, "templates"));
  writeFileSync(join(root, CI_TEMPLATE), TEMPLATE);
  assert.equal(checkVersions({ root }).ok, true, "the same version passes");
  writeFileSync(join(root, CI_TEMPLATE), TEMPLATE.split(`projectstore@${VERSION}`).join("projectstore@0.0.1"));
  const r = checkVersions({ root });
  assert.equal(r.error, "version mismatch");
  assert.ok(
    r.checked.some((s) => s.file === CI_TEMPLATE && s.version === "0.0.1"),
    "naming the template",
  );
  writeFileSync(join(root, CI_TEMPLATE), TEMPLATE.replace(`projectstore@${VERSION} bind`, "projectstore bind"));
  assert.equal(
    checkVersions({ root }).error,
    `${CI_TEMPLATE}: the template must name projectstore@<version> exactly twice, found 1`,
    "a bare projectstore fails the guard too, naming the cause",
  );
});

// ═══ Contract 6: follow, and its exit carried to the last step ══════════

// [ci-template#6]
test("exit: one finding and one move push the move in one commit and the last step exits 1; notes only exit 0 (failure)", () => {
  const w = jobWorld({
    vault: vaultOf({
      "PS-X/story-a": reviewStory("story-a", 7),
      "PS-X/story-b": reviewStory("story-b", 9),
    }),
    table: { prs: [mergedPr(7)], fail: { view: { [prUrl(9)]: 1 } } },
  });
  const before = tip(w);
  const r = run(w);
  assert.equal(r.code, 1, show(r));
  assert.equal(r.failed.name, "End with follow's exit code", "the job is red at its last step");
  assert.equal(r.steps.find((s) => s.id === "follow").code, 0, "the follow step itself never fails");
  assert.equal(git(w.bare, ["rev-list", "--count", `${before}..HEAD`]), "1", "the move is pushed");
  assert.ok(w.files().includes(STORY_A) && !w.files().includes("epics/PS-X/stories/story-b.md"));
  assert.match(r.log.join("\n"), /pr-unreadable/);
  // Notes only: a merged pull request whose Closes-story line names no story.
  const w2 = jobWorld({
    vault: vaultOf({ "PS-X/story-c": reviewStory("story-c", 8) }),
    table: { prs: [mergedPr(8), mergedPr(11, { body: "Closes-story: PS-X/no-such-story" })] },
  });
  const notes = run(w2);
  assert.equal(notes.code, 0, show(notes));
  assert.match(notes.log.join("\n"), /pr-story-unknown/, "a note, not a finding");
});

// [ci-template#6]
test('exit: the follow line has --write and neither --pr nor --story, ends in || code=$?, writes code= to $GITHUB_OUTPUT, and the last step is exit "$FOLLOW_CODE"; a line without || code=$? fails', () => {
  assert.deepEqual(exitRule(TEMPLATE), []);
  failsOn(exitRule, planted(" 2>&1 || code=$?", " 2>&1"), "a follow line without || code=$?");
  failsOn(exitRule, planted("follow --write >", "follow --write --pr 7 >"), "--pr");
  failsOn(exitRule, planted('run: exit "$FOLLOW_CODE"', "run: exit 0"), "a last step that drops the code");
});

// [ci-template#6]
test("exit: the gh stub's record shows GH_TOKEN set for every gh call, and the follow step's env holds no secret", () => {
  const { ghCalls } = main();
  assert.ok(ghCalls.length >= 2, `gh was called: ${ghCalls.length}`);
  assert.deepEqual(
    ghCalls.filter((c) => !c.token),
    [],
    "GH_TOKEN is set for every call",
  );
  const follow = stepsOf(TEMPLATE).find((s) => s.id === "follow");
  assert.ok(!Object.values(follow.env).some((v) => v.includes("secrets.")), "no secret in the follow step");
});

// ═══ Contract 7: what the log shows ═════════════════════════════════════

// [ci-template#7]
test("log: in a private repository with one move, the log holds follow's text with the story's ref", () => {
  const { first } = main();
  const log = first.log.join("\n");
  assert.match(log, /Written:\n {2}PS-X\/story-a: status: review → done/);
  assert.ok(!log.includes(REMOTE) && !log.includes("git.example.com"), "not the remote");
  assert.deepEqual(logRule(TEMPLATE), []);
});

// [ci-template#7]
test("log: in a public repository, and with an empty REPO_PRIVATE, the log holds no story ref, id or title, nor the remote, states follow's exit code and that the text is withheld, and the move is pushed (edge)", () => {
  for (const repoPrivate of [false, ""]) {
    const w = jobWorld({
      vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7, TITLE) }),
      table: { prs: [mergedPr(7)] },
    });
    const before = tip(w);
    const r = run(w, { repoPrivate });
    assert.equal(r.code, 0, show(r));
    const log = r.log.join("\n");
    for (const s of ["PS-X", "story-a", TITLE, REMOTE, "git.example.com", "Written:"])
      assert.ok(!log.includes(s), `${JSON.stringify(repoPrivate)}: the log holds ${s}:\n${log}`);
    assert.ok(
      r.log.includes(
        "follow exited with code 0. Its output is withheld: this repository is not known to be private, and the output names the vault's stories.",
      ),
      log,
    );
    assert.equal(git(w.bare, ["rev-list", "--count", `${before}..HEAD`]), "1", "the move is pushed");
    assert.ok(w.files().includes(STORY_A));
  }
  failsOn(
    logRule,
    planted('if [ "$REPO_PRIVATE" = "true" ]; then', 'if [ "$REPO_PRIVATE" != "false" ]; then'),
    "printing unless false",
  );
});

// ═══ Contract 8: what is staged ═════════════════════════════════════════

const DERIVED = (() => {
  const v = derivedViewPaths(loadLayout("engineering"));
  return [v.board, v.codeMap, v.graph, v.flow, v.specTree, ...v.indexes.map((i) => i.path)].filter(Boolean);
})();
const derived = (f) => DERIVED.includes(f) || /^[^/]+\/README\.md$/.test(f);

// [ci-template#8]
test("staging: one story whose pull request merged gives a commit that touches only that story, its epic and the derived views, none under .projectstore/", () => {
  const { w, before, firstTip } = main();
  const files = git(w.bare, ["diff", "--name-only", before, firstTip]).split("\n");
  assert.ok(files.includes(STORY_A) && files.includes("epics/PS-X/epic.md"), files.join(", "));
  assert.ok(files.includes("epics/README.md"), `a folder index is staged through git ls-files: ${files.join(", ")}`);
  assert.deepEqual(
    files.filter((f) => f !== STORY_A && f !== "epics/PS-X/epic.md" && !derived(f)),
    [],
    "nothing beyond the story, its epic and the views",
  );
  assert.ok(!files.some((f) => f.startsWith(".projectstore/") || f.includes("/.projectstore/")));
});

// [ci-template#8]
test("staging: a vault that lacks kanban.md gets it back in the commit, and files written outside the list stay out of it (edge)", () => {
  const w = jobWorld({
    vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }, { drop: ["kanban.md"] }),
    table: { prs: [mergedPr(7)] },
  });
  assert.throws(() => git(w.bare, ["cat-file", "-e", "HEAD:kanban.md"]), "the seeded vault lacks kanban.md");
  const r = run(w, {
    before: (i, s) => {
      if (s.name !== "Commit and push what follow changed, never forced") return;
      const clone = JSON.parse(readFileSync(join(w.ws, ".projectstore", "projectstore.json"), "utf8")).vault_path;
      writeFileSync(join(clone, "notes.md"), "a stray file\n");
      mkdirSync(join(clone, ".projectstore", "sessions"), { recursive: true });
      writeFileSync(join(clone, ".projectstore", "sessions", "s.json"), "{}\n");
      mkdirSync(join(clone, "research"), { recursive: true });
      writeFileSync(join(clone, "research", "draft.md"), "a draft\n");
    },
  });
  assert.equal(r.code, 0, show(r));
  const files = w.files();
  assert.ok(files.includes("kanban.md"), `kanban.md is committed: ${files.join(", ")}`);
  for (const f of ["notes.md", ".projectstore/sessions/s.json", "research/draft.md"])
    assert.ok(!files.includes(f), `${f} stays out`);
});

// [ci-template#8]
test("staging: each derived view of the engineering layout is covered by the staging step, and no pathspec names .projectstore; .projectstore staged or flow.md dropped fails the drift guard", () => {
  assert.deepEqual(stagingRule(TEMPLATE), []);
  const covered = (text) => {
    const push = named(stepsOf(text), /push/i);
    const loop = runLines(push).find((l) => /^\s*for path in /.test(l)) || "";
    const names = loop
      .trim()
      .replace(/^for path in /, "")
      .replace(/; do$/, "")
      .split(/\s+/);
    const glob = push.run.includes(INDEXES);
    return DERIVED.filter((p) => !(names.includes(p) || (glob && /^[^/]+\/README\.md$/.test(p))));
  };
  assert.ok(DERIVED.length >= 10 && DERIVED.includes("flow.md"), DERIVED.join(", "));
  assert.deepEqual(covered(TEMPLATE), [], "every derived view is staged");
  assert.ok(STAGED.includes("epics"));
  const noFlow = planted("code-map.md flow.md spec-tree.md", "code-map.md spec-tree.md");
  assert.deepEqual(covered(noFlow), ["flow.md"]);
  failsOn(stagingRule, noFlow, "flow.md dropped");
  failsOn(stagingRule, planted("spec-tree.md; do", "spec-tree.md .projectstore; do"), ".projectstore staged");
  failsOn(
    stagingRule,
    planted('if [ -e "$path" ]; then git add -A -- "$path"; fi', 'git add -A -- "$path"'),
    "a name staged without [ -e ]",
  );
});

// ═══ Contract 9: the commit and the push ════════════════════════════════

// [ci-template#9]
test("push: one move gives the remote one commit with the fixed message, authored and committed by github-actions[bot]", () => {
  const { w, before, firstTip } = main();
  assert.equal(git(w.bare, ["rev-list", "--count", `${before}..${firstTip}`]), "1");
  assert.equal(
    git(w.bare, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", firstTip]),
    `${BOT} <${BOT_MAIL}>|${BOT} <${BOT_MAIL}>|follow: update the vault after a merge`,
  );
  assert.equal(git(w.bare, ["log", "-1", "--format=%P", firstTip]), before, "on top of the remote's head");
});

// [ci-template#9]
test("push: the same facts again, on a fresh clone, make no commit, say there is nothing to push, and exit 0 (edge)", () => {
  const { w, first, second, firstTip } = main();
  assert.equal(second.code, 0, show(second));
  assert.equal(tip(w), firstTip, "no commit");
  assert.ok(second.log.includes("Nothing to push: the vault already says what the pull requests say."), show(second));
  assert.notEqual(second.runnerTemp, first.runnerTemp, "a fresh clone");
});

// [ci-template#9]
test("push: a person's push between follow and the push leaves the job red, the person's commit the remote's head, nothing forced; a re-run lands the move on top (failure)", () => {
  const w = jobWorld({ vault: vaultOf({ "PS-X/story-a": reviewStory("story-a", 7) }), table: { prs: [mergedPr(7)] } });
  let theirs = null;
  const r = run(w, {
    after: (i, s) => {
      if (s.id !== "follow") return;
      const person = join(w.W, "person");
      git(w.W, ["clone", "-q", w.bare, person]);
      theirs = gitCommit(person, { files: { "ideas.md": "a person's idea\n" }, message: "a person's edit" });
      git(person, ["push", "-q", "origin", "HEAD"]);
    },
  });
  assert.equal(r.code, 1, show(r));
  assert.equal(r.failed.name, "Commit and push what follow changed, never forced");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Nothing was forced\. Re-run this job/);
  assert.equal(tip(w), theirs, "the person's commit is the remote's head");
  const again = run(w);
  assert.equal(again.code, 0, show(again));
  assert.equal(git(w.bare, ["log", "-1", "--format=%P %an"]), `${theirs} ${BOT}`, "the move lands on top");
  assert.ok(w.files().includes(STORY_A));
});

// [ci-template#9]
test("push: the identity is github-actions[bot] in the step's env, the message is fixed, and the push is HEAD to origin, never forced; push --force, push -f and a +HEAD refspec fail", () => {
  assert.deepEqual(pushRule(TEMPLATE), []);
  failsOn(pushRule, planted(" push --quiet origin HEAD", " push --force --quiet origin HEAD"), "push --force");
  failsOn(pushRule, planted(" push --quiet origin HEAD", " push -f --quiet origin HEAD"), "push -f");
  failsOn(pushRule, planted(" push --quiet origin HEAD", " push --quiet origin +HEAD"), "a +HEAD refspec");
  failsOn(
    pushRule,
    planted('GIT_AUTHOR_NAME: "github-actions[bot]"', 'GIT_AUTHOR_NAME: "First Last"'),
    "a person's name",
  );
  failsOn(
    pushRule,
    planted("follow: update the vault after a merge", "follow: moved PS-X/story-a"),
    "a message naming a story",
  );
});

// ═══ Contract 10: the docs page ═════════════════════════════════════════

// [ci-template#10]
test("docs: the page names the token's scope, external_refs.pr, the public log, the pinned release, Dependabot, the vault root and how to turn the job off", () => {
  const page = read(PAGE);
  for (const s of [
    // When, and when not.
    "the vault is that repository's root",
    "a synced folder with no remote",
    "without `--write`",
    // The settings, the branch, the catch-up run.
    ...[
      "PROJECTSTORE_VAULT_TOKEN",
      "PROJECTSTORE_VAULT_REMOTE",
      "PROJECTSTORE_VAULT_LANGUAGE",
      "PROJECTSTORE_VAULT_BRANCH",
    ].map((n) => `| \`${n}\` |`),
    "If the code repository's default branch is not `main`, edit the branch line",
    "`workflow_dispatch`",
    // The token.
    "only the vault repository, no other",
    "`Contents` read and write, and nothing else",
    "belongs to a person and expires",
    "single sign-on",
    "protected",
    "environment secret",
    "code owner for `.github/workflows/`",
    // Public code, private vault.
    "`Closes-story: <EPIC>/<story-id>`",
    "`external_refs.pr`",
    "The job log of a public repository is public",
    "The vault's URL is a secret too, so GitHub masks it everywhere in the log, git's own error messages included",
    "exit code says which",
    "The `bind` step's output ends with a hint to scaffold the layout's missing folders",
    // Forks, Dependabot, other repositories.
    "Disable the workflow in a fork",
    "Dependabot",
    "`pr-unreadable`",
    // The release.
    "The template runs the ProjectStore release it came with",
    "edit the version in both `npx` lines",
    "The pin limits that to the release a person chose to copy",
    // Red, re-run, off.
    "re-run the job",
    "Disable the workflow in the Actions tab, or delete the file",
    "revoke the vault token",
    "The commits the job already pushed stay",
    "Nothing was installed",
  ])
    assert.ok(page.includes(s), `the page says: ${s}`);
  // YAML only with expressions, the secret in plain words.
  for (const m of page.matchAll(/```yaml\n([\s\S]*?)```/g))
    for (const l of m[1].split("\n").filter((x) => x.includes(":") && !/:$/.test(x)))
      assert.match(l, /\$\{\{ (?:secrets|vars)\.[A-Z_]+ \}\}$/, `a YAML line shows an expression: ${l}`);
  assert.ok(!/\$[A-Za-z_]*TOKEN/.test(page.replace(/\$\{\{[^}]*\}\}/g, "")), "no $…TOKEN shell variable");
});

// [ci-template#10]
test("docs: the page passes the directory guard's credential-beside-url row, its relative links resolve in the packed tree, and README, how-it-works and getting-started link it; a $…TOKEN beside a URL fails", () => {
  const page = read(PAGE);
  assert.deepEqual(besideUrl(PAGE, page), []);
  const plantedPage = `${page}\n\`\`\`\ngit clone "https://x-access-token:$VAULT_TOKEN@github.com/team/vault.git"\n\`\`\`\n`;
  assert.ok(
    besideUrl(PAGE, plantedPage).some(([, what]) => what.startsWith("holds $VAULT_TOKEN")),
    "a token variable beside a URL fails credential-beside-url",
  );
  const links = [...page.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:|^#/.test(u));
  assert.ok(links.includes("../templates/follow-github-actions.yml"), "it links the template");
  for (const u of links)
    assert.ok(PACKLIST.includes(posix.normalize(posix.join("docs", u.replace(/#.*$/, "")))), `${u} is packed`);
  for (const [file, link] of [
    ["README.md", "](docs/follow-in-ci.md)"],
    ["docs/how-it-works.md", "](follow-in-ci.md)"],
    ["docs/getting-started.md", "](follow-in-ci.md)"],
  ])
    assert.ok(read(file).includes(link), `${file} links the page`);
  assert.ok(
    /## Teams[\s\S]*\]\(docs\/follow-in-ci\.md\)[\s\S]*## What it costs/.test(read("README.md")),
    "from the Teams section",
  );
  assert.ok(
    /\*\*`follow`\*\*[\s\S]*?\]\(follow-in-ci\.md\)[\s\S]*?- \*\*`handover`\*\*/.test(read("docs/how-it-works.md")),
    "from the follow bullet",
  );
  assert.ok(
    /## Daily flow[\s\S]*\]\(follow-in-ci\.md\)[\s\S]*## How approval works/.test(read("docs/getting-started.md")),
    "from the Daily flow",
  );
});

// ═══ The shipped file is untouched ══════════════════════════════════════

// The spec's Acceptance item 2: the shipped file is byte-identical after the suite.
test("planted copies: the shipped template is byte-identical after every rule ran on its mutated copies", () => {
  assert.ok(existsSync(join(REPO, CI_TEMPLATE)));
  assert.equal(createHash("sha256").update(read(CI_TEMPLATE)).digest("hex"), SHIPPED_SHA);
});

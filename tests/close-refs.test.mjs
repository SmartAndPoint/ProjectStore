// projectstore — tests/close-refs.test.mjs: where a closing story's code_refs
// come from, the one normaliser, the close that writes them and the epic that
// widens (PS-SPECTREE, "Every close path writes the story's code_refs"; the
// spec "The close-refs verb…", alias `close-refs`, contracts 1 to 6; SPEC-001
// contract 7 as that story amends it). The verb runs through the bin's run()
// on a fixture project with its own git repository in a temp directory,
// against the fake `gh` of tests/fixtures/gh-stub.mjs first on PATH; the
// order of the sources is read from the stub's call log. No test reaches the
// network or the real `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { storyText, git, gitCommit } from "./fixtures/flow.mjs";
import { ghStub } from "./fixtures/gh-stub.mjs";
import { run } from "../scripts/cli.mjs";
import { VERBS } from "../scripts/verbs.mjs";
import { TOOLS } from "../scripts/mcp.mjs";
import { commandForm } from "../scripts/lib.mjs";
import { setFm } from "../scripts/status-log.mjs";
import { computeClose } from "../scripts/story-section.mjs";
import { normaliseRefs, noteMessage, runCloseRefs, reviewerLine } from "../scripts/close-refs.mjs";
import { concatenatedArrays } from "../scripts/follow-gh.mjs";
import { widenEpicRefs } from "../scripts/status-change.mjs";
import { defaultGit } from "../scripts/precommit.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const URL7 = "https://github.com/acme/app/pull/7";
const STARTED = "2026-11-01T09:00:00.000Z";
const SHA_GONE = "0123456789abcdef0123456789abcdef01234567";
const REF = "PS-X/story-a";

// ─── Fixtures ──────────────────────────────────────────────────────────

// A bound project with its vault inside it, at `sub` of a git repository
// (the root when ""), one epic and one story. `pr` goes into the story's
// external_refs, `fm` sets further story keys, `files` are written into the
// project; `repo: false` makes no repository. The first commit is dated
// before `started_at`, so the commits since it are only those a test adds.
function fixture({ sub = "", pr = URL7, fm = {}, files = {}, repo = true, epicRefs = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ps-close-refs-"));
  const proj = sub ? join(root, sub) : root;
  const vault = join(proj, "vault");
  mkdirSync(join(vault, "epics", "PS-X", "stories"), { recursive: true });
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(join(proj, ".projectstore"), { recursive: true });
  writeFileSync(
    join(proj, ".projectstore", "projectstore.json"),
    JSON.stringify({ vault_path: vault, layout: "engineering", language: "en", default_author: "Test" }),
  );
  const epic = join(vault, "epics", "PS-X", "epic.md");
  writeFileSync(
    epic,
    `---\ntype: epic\nid: "PS-X"\ntitle: "PS-X"\nstatus: in-progress\ncreated: 2026-01-01\nupdated: 2026-01-01\n${
      epicRefs === null ? "" : `code_refs: ${epicRefs}\n`
    }---\n\n# PS-X\n\n---\n\n*Last updated: 2026-01-01*\n`,
  );
  const keys = { ...(pr ? { external_refs: JSON.stringify({ pr }) } : {}), ...fm };
  const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
  writeFileSync(path, storyText({ id: "story-a", fm: keys }));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, p)), { recursive: true });
    writeFileSync(join(proj, p), c);
  }
  let head = null;
  if (repo) {
    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    head = gitCommit(root, { message: "base", at: "2026-10-01T09:00:00Z" });
  }
  return { root, proj, vault, path, epic, head };
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

// close-refs through the bin's run(), with `env` (the stub's, by default).
async function closeRefs(fx, env, args = [], { json = true, story = REF } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["close-refs", story, ...args, ...(json ? ["--json"] : []), "--project", fx.proj], {
    env: { ...env, CI: "1" },
    cwd: fx.proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  const j = json && stdout.text ? JSON.parse(stdout.text) : null;
  return { code, out: stdout.text, err: stderr.text, json: j, r: j ? j.result : null };
}

const stubOf = (table) => ghStub(mkdtempSync(join(tmpdir(), "ps-gh-")), table);
const pr = (n, o = {}) => ({
  url: `https://github.com/acme/app/pull/${n}`,
  state: "MERGED",
  mergedAt: "2026-11-02T10:00:00Z",
  mergeCommit: null,
  files: [],
  ...o,
});
const modified = (path) => ({ path, changeType: "MODIFIED" });
const codes = (r) => r.notes.map((n) => n.code);
const argvs = (stub) => stub.log().map((c) => c.argv.slice(0, 2).join(" "));
const set = (env = process.env) => commandForm("codemap", { args: `set ${REF}`, env });

// Every file under a directory, by its path.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === ".git") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = read(p);
    }
  };
  walk(dir);
  return out;
}

// A PATH that runs git and finds no gh.
function pathWithoutGh() {
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "ps-nogh-"));
  symlinkSync(which, join(dir, "git"));
  return dir;
}

// ─── Contract 1: the verb and its answer ──────────────────────────────

// [close-refs#1]
test("verb: a story whose merged pull request touched scripts/a.mjs and README.md gives source pr, verified, both refs, and writes nothing", async () => {
  const fx = fixture({ files: { "scripts/a.mjs": "a", "README.md": "r" } });
  const stub = stubOf({ prs: [pr(7, { files: [modified("scripts/a.mjs"), modified("README.md")] })] });
  const before = snapshot(fx.root);
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.ok, true);
  assert.deepEqual(Object.keys(r.r), ["source", "verified", "refs", "dropped", "notes"]);
  assert.deepEqual(r.r, {
    source: "pr",
    verified: true,
    refs: ["scripts/a.mjs", "README.md"],
    dropped: [],
    notes: [],
  });
  assert.deepEqual(snapshot(fx.root), before, "no file in the vault or the project changes");
  // The processes it started: the bare repo view, then the pull request's view.
  assert.deepEqual(stub.calls("repo view"), [["repo", "view", "--json", "url"]]);
  assert.deepEqual(stub.calls("pr view"), [["pr", "view", URL7, "--json", "files,changedFiles,state,mergeCommit"]]);
});

// [close-refs#1]
test("verb: the text form gives the source, the refs one per line, the dropped paths and the notes", async () => {
  const fx = fixture({ files: { "scripts/a.mjs": "a" } });
  const stub = stubOf({
    prs: [pr(7, { files: [modified("scripts/a.mjs"), { path: "old.mjs", changeType: "DELETED" }], changedFiles: 3 })],
  });
  const r = await closeRefs(fx, stub.env(), [], { json: false });
  assert.equal(r.code, 0, r.err);
  // changedFiles 3 > 2 read: the list is asked and gives the same two, so the note is files-truncated.
  assert.equal(
    r.out,
    [
      `${REF}: source pr (verified)`,
      "refs (1):",
      "  scripts/a.mjs",
      "dropped (1):",
      "  old.mjs (removed)",
      "notes:",
      `  files-truncated: ${URL7} changed 3 files and gh gave 2; add the rest with ${set(stub.env())}.`,
      "",
    ].join("\n"),
  );
});

// [close-refs#1]
test("verb: a story id that names no story exits 1 with move's message, in the envelope under --json with no refs, on stderr without (failure)", async () => {
  const fx = fixture();
  const stub = stubOf({ prs: [] });
  const r = await closeRefs(fx, stub.env(), [], { story: "PS-X/nope" });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.r.error, 'no story in epics/PS-X matches "nope"');
  assert.ok(!("refs" in r.r));
  const t = await closeRefs(fx, stub.env(), [], { story: "PS-X/nope", json: false });
  assert.equal(t.code, 1);
  assert.equal(t.out, "");
  assert.equal(t.err, 'close-refs: no story in epics/PS-X matches "nope"\n');
  assert.deepEqual(stub.log(), [], "no gh call for a story that is not there");
  const u = await closeRefs(fx, stub.env(), ["extra"]);
  assert.equal(u.code, 2, "a usage error");
});

// [close-refs#1]
test("verb: the MCP server's tool list holds no close-refs tool, and its row writes nothing", () => {
  const row = VERBS.find((v) => v.verb === "close-refs");
  assert.ok(row);
  assert.equal(row.writes, false);
  assert.deepEqual([...row.mcp], []);
  assert.ok(!Object.values(TOOLS).some((t) => t.verb === "close-refs"));
  assert.ok(!Object.keys(TOOLS).includes("close-refs"));
});

// ─── Contract 2: the pull request's files ─────────────────────────────

// [close-refs#2]
test("source 1: a bare repo view naming https://github.com/Acme/App owns https://github.com/acme/app/pull/7, compared in lower case", async () => {
  const fx = fixture({ files: { "src/x.mjs": "x" } });
  const stub = stubOf({
    ownRepo: "https://github.com/Acme/App.git/",
    prs: [pr(7, { files: [modified("src/x.mjs")] })],
  });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.r.source, "pr");
  assert.ok(!codes(r.r).includes("files-foreign"), JSON.stringify(r.r.notes));
});

// [close-refs#2]
test("source 1: 120 changed files, 100 in the view, call gh api once with per_page=100, --paginate and the host, and refs hold all 120", async () => {
  const names = Array.from({ length: 120 }, (_, i) => `src/f${String(i).padStart(3, "0")}.mjs`);
  const fx = fixture({ files: Object.fromEntries(names.map((n) => [n, "x"])) });
  const stub = stubOf({ prs: [pr(7, { files: names.map(modified) })] });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(stub.calls("api repos/acme/app/pulls/7/files?per_page=100"), [
    ["api", "repos/acme/app/pulls/7/files?per_page=100", "--paginate", "--hostname", "github.com"],
  ]);
  assert.equal(r.r.source, "pr");
  assert.deepEqual(r.r.refs, names);
  assert.deepEqual(r.r.notes, []);
});

// [close-refs#2]
test("source 1: exactly 100 changed files, all in the view with changeType, make no gh api call (edge)", async () => {
  const names = Array.from({ length: 100 }, (_, i) => `src/f${String(i).padStart(3, "0")}.mjs`);
  const fx = fixture({ files: Object.fromEntries(names.map((n) => [n, "x"])) });
  const stub = stubOf({ prs: [pr(7, { files: names.map(modified) })] });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(
    stub.log().filter((c) => c.argv[0] === "api"),
    [],
  );
  assert.equal(r.r.refs.length, 100);
});

// [close-refs#2]
test("source 1: a view whose files carry no changeType calls gh api, and the list's paths are the ones used (edge)", async () => {
  const fx = fixture({ files: { "src/a.mjs": "a", "src/b.mjs": "b" } });
  const stub = stubOf({ prs: [pr(7, { files: [{ path: "src/a.mjs" }, { path: "src/b.mjs" }] })] });
  const r = await closeRefs(fx, stub.env());
  assert.equal(stub.log().filter((c) => c.argv[0] === "api").length, 1);
  assert.deepEqual(r.r.refs, ["src/a.mjs", "src/b.mjs"]);
});

// [close-refs#2]
test("source 1: 3,050 changed files give the 3,000 read and files-truncated naming 3,050 and 3,000 (edge)", async () => {
  const names = Array.from({ length: 3050 }, (_, i) => `src/f${String(i).padStart(4, "0")}.mjs`);
  const fx = fixture({ files: Object.fromEntries(names.map((n) => [n, ""])) });
  const stub = stubOf({ prs: [pr(7, { files: names.map(modified) })] });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.r.source, "pr");
  assert.equal(r.r.refs.length, 3000);
  assert.deepEqual(r.r.notes, [
    {
      code: "files-truncated",
      message: `${URL7} changed 3050 files and gh gave 3000; add the rest with ${set(stub.env())}.`,
    },
  ]);
});

// [close-refs#2]
test("source 1: a pull request that deleted old.mjs drops it as removed", async () => {
  const fx = fixture({ files: { "src/x.mjs": "x" } });
  const stub = stubOf({
    prs: [pr(7, { files: [modified("src/x.mjs"), { path: "old.mjs", changeType: "DELETED" }] })],
  });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(r.r.refs, ["src/x.mjs"]);
  assert.deepEqual(r.r.dropped, [{ path: "old.mjs", why: "removed" }]);
});

// [close-refs#2]
test("follow-gh: a paginated answer is read as one list whether its pages come back to back or on lines of their own", () => {
  assert.deepEqual(concatenatedArrays('[{"filename":"a]["}][{"filename":"b"}]'), [
    { filename: "a][" },
    { filename: "b" },
  ]);
  assert.deepEqual(concatenatedArrays("[1]\n[2,3]\n"), [1, 2, 3]);
  assert.throws(() => concatenatedArrays("[1] x"));
  assert.throws(() => concatenatedArrays("[1"));
});

// ─── Contract 3: when source 1 does not answer ────────────────────────

// [close-refs#3]
test("source 1: an open pull request answers, since only a person runs the verb", async () => {
  const fx = fixture({ files: { "src/x.mjs": "x" } });
  const stub = stubOf({ prs: [pr(7, { state: "OPEN", mergedAt: null, files: [modified("src/x.mjs")] })] });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.r.source, "pr");
  assert.deepEqual(r.r.refs, ["src/x.mjs"]);
});

// [close-refs#3]
test("source 1: a pull request closed without a merge gives pr-closed, and the next source is asked (failure)", async () => {
  const fx = fixture({ files: { "scripts/b.mjs": "b" } });
  const stub = stubOf({ prs: [pr(7, { state: "CLOSED", files: [modified("src/x.mjs")] })] });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, 'code_refs: ["scripts/b.mjs"]\n');
  const r = await closeRefs(fx, stub.env(), ["--reviewer-refs-file", file]);
  assert.deepEqual(codes(r.r), ["pr-closed"]);
  assert.equal(
    r.r.notes[0].message,
    `${URL7} was closed without a merge, so its files are not used. If the story's code landed another way: ${set(stub.env())}.`,
  );
  assert.equal(r.r.source, "reviewer");
  assert.deepEqual(argvs(stub), ["repo view", "pr view"], "source 1 was asked first");
});

// [close-refs#3]
test("source 1: a pull request closed without a merge with 120 changed files is judged from the view's state: no gh api call (failure)", async () => {
  const names = Array.from({ length: 120 }, (_, i) => `src/f${String(i).padStart(3, "0")}.mjs`);
  const fx = fixture();
  const stub = stubOf({ prs: [pr(7, { state: "CLOSED", files: names.map(modified) })] });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(codes(r.r), ["pr-closed"]);
  assert.deepEqual(
    stub.log().filter((c) => c.argv[0] === "api"),
    [],
  );
});

// [close-refs#3]
test("source 1: a bare repo view that exits 1 gives repo-unknown with gh's reason, and a pull request in another repository gives files-foreign naming both (failure)", async () => {
  const fx = fixture({ fm: { started_at: JSON.stringify(STARTED) } });
  const stub = stubOf({ fail: { ownRepo: 1 }, prs: [pr(7, { files: [modified("src/x.mjs")] })] });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(codes(r.r), ["repo-unknown"]);
  assert.equal(
    r.r.notes[0].message,
    `gh could not name this project's repository (HTTP 502: Bad Gateway (https://api.github.com/graphql)), so the files of ${URL7} are not used. To set this story's code_refs by hand: ${set(stub.env())}.`,
  );
  assert.equal(r.r.source, "none", "the next sources were asked: no reviewer file, no commit since");
  assert.deepEqual(stub.calls("pr view"), [], "the files are not read");

  const other = "https://github.com/other/lib/pull/3";
  const fy = fixture({ pr: other });
  const s2 = stubOf({ prs: [pr(3, { url: other, files: [modified("src/x.mjs")] })] });
  const f = await closeRefs(fy, s2.env());
  assert.deepEqual(codes(f.r), ["files-foreign"]);
  assert.equal(
    f.r.notes[0].message,
    `${other} is in https://github.com/other/lib, not in this project's repository https://github.com/acme/app, so its files are not used. If the story's code is in this project: ${set(s2.env())}.`,
  );
  assert.deepEqual(s2.calls("pr view"), []);
});

// [close-refs#3]
test("source 1: 120 changed files and a failed gh api give files-unknown, none of the view's 100 files, and the next source (failure)", async () => {
  const names = Array.from({ length: 120 }, (_, i) => `src/f${String(i).padStart(3, "0")}.mjs`);
  const fx = fixture({ files: Object.fromEntries(names.map((n) => [n, "x"])) });
  const stub = stubOf({ fail: { api: 1 }, prs: [pr(7, { files: names.map(modified) })] });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, `code_refs: ["${names[119]}"]\n`);
  const r = await closeRefs(fx, stub.env(), ["--reviewer-refs-file", file]);
  assert.deepEqual(codes(r.r), ["files-unknown"]);
  assert.equal(
    r.r.notes[0].message,
    `could not read the files of ${URL7}: HTTP 502: Bad Gateway (https://api.github.com/graphql). The next source is used.`,
  );
  assert.equal(r.r.source, "reviewer");
  assert.deepEqual(r.r.refs, [names[119]], "none of the view's 100");
});

// [close-refs#3]
test("source 1: a story whose url ends in /pull/12/files gives files-unknown saying it is not a pull request URL (failure)", async () => {
  const fx = fixture({ pr: "https://github.com/acme/app/pull/12/files" });
  const stub = stubOf({ prs: [] });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(r.r.notes, [
    {
      code: "files-unknown",
      message:
        "could not read the files of https://github.com/acme/app/pull/12/files: it is not a pull request URL. The next source is used.",
    },
  ]);
});

// [close-refs#3]
test("source 1: a story with no external_refs.pr skips it: the fake gh's call log is empty", async () => {
  const fx = fixture({ pr: null });
  const stub = stubOf({ prs: [] });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.code, 0);
  assert.deepEqual(stub.log(), []);
  assert.deepEqual(r.r, { source: "none", verified: false, refs: [], dropped: [], notes: [] });
});

// ─── Contract 4: the reviewer's line ──────────────────────────────────

// [close-refs#4]
test("source 2: with no gh on PATH, the reviewer's last code_refs line answers, and notes hold gh-unavailable", async () => {
  const fx = fixture({ files: { "scripts/b.mjs": "b" } });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, 'Report…\ncode_refs: ["scripts/a.mjs"]\nmore\n  code_refs: ["scripts/b.mjs"]  \n');
  const r = await closeRefs(fx, { ...process.env, PATH: pathWithoutGh() }, ["--reviewer-refs-file", file]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.r.source, "reviewer");
  assert.equal(r.r.verified, true);
  assert.deepEqual(r.r.refs, ["scripts/b.mjs"]);
  assert.deepEqual(codes(r.r), ["gh-unavailable"]);
  assert.equal(
    r.r.notes[0].message,
    `gh cannot be run (gh is not installed or not on PATH), so the files of ${URL7} were not read. To read them, install gh or run "gh auth login", then run the close again.`,
  );
});

// [close-refs#4]
test("source 2: a reviewer line code_refs: [] answers with no refs, and no commits are read (edge)", async () => {
  const fx = fixture({ pr: null, fm: { started_at: JSON.stringify(STARTED) } });
  gitCommit(fx.root, { files: { "src/late.mjs": "l" }, at: "2026-11-05T09:00:00Z" });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, "code_refs: []\n");
  const calls = [];
  const base = defaultGit(process.env);
  const r = await runCloseRefs({
    values: { "reviewer-refs-file": file },
    positionals: [REF],
    cfg: JSON.parse(read(join(fx.proj, ".projectstore", "projectstore.json"))),
    project: fx.proj,
    env: process.env,
    cwd: fx.proj,
    git: (root, args) => (calls.push(args[0]), base(root, args)),
  });
  assert.equal(r.result.source, "reviewer");
  assert.deepEqual(r.result.refs, []);
  assert.ok(!calls.includes("log"), `no git log: ${calls}`);
});

// [close-refs#4]
test("source 2: a last code_refs line that is not JSON, above which a valid one stands, gives reviewer-refs-none and source 3 is asked (failure)", async () => {
  const fx = fixture({ pr: null, fm: { started_at: JSON.stringify(STARTED) } });
  gitCommit(fx.root, { files: { "src/late.mjs": "l" }, at: "2026-11-05T09:00:00Z" });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, 'code_refs: ["scripts/a.mjs"]\ncode_refs: [scripts/b.mjs]\n');
  const r = await closeRefs(fx, process.env, ["--reviewer-refs-file", file]);
  assert.deepEqual(codes(r.r), ["reviewer-refs-none", "unverified"]);
  assert.equal(
    r.r.notes[0].message,
    `${file} is missing, has no code_refs: line, or its last one is not of the form code_refs: ["path"], so the reviewer's report gives no files. The commits since the story started are read instead.`,
  );
  assert.equal(r.r.source, "commits");
  assert.deepEqual(r.r.refs, ["src/late.mjs"]);
  // A missing file and a file with no such line are the same note.
  for (const body of [null, "no line here\n", 'code_refs: ["a"] trailing\n']) {
    const p = join(fx.root, `r-${Math.random()}.txt`);
    if (body !== null) writeFileSync(p, body);
    const q = await closeRefs(fx, process.env, ["--reviewer-refs-file", p]);
    assert.equal(codes(q.r)[0], "reviewer-refs-none", String(body));
  }
  assert.deepEqual(reviewerLine('x\n code_refs: ["a", "b"]\n'), ["a", "b"]);
  assert.equal(reviewerLine('code_refs: ["a", 1]'), null);
});

// [close-refs#4]
test("source 2: when the pull request answers, the reviewer's paths are not in refs", async () => {
  const fx = fixture({ files: { "src/x.mjs": "x", "scripts/other.mjs": "o" } });
  const stub = stubOf({ prs: [pr(7, { files: [modified("src/x.mjs")] })] });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, 'code_refs: ["scripts/other.mjs"]\n');
  const r = await closeRefs(fx, stub.env(), ["--reviewer-refs-file", file]);
  assert.equal(r.r.source, "pr");
  assert.deepEqual(r.r.refs, ["src/x.mjs"]);
});

// ─── Contract 5: the commits since the story started ──────────────────

// [close-refs#5]
test("source 3: no pull request, no reviewer file and two commits since started_at give source commits, not verified, their files by path, and unverified", async () => {
  const fx = fixture({ pr: null, fm: { started_at: JSON.stringify(STARTED) } });
  gitCommit(fx.root, { files: { "src/z.mjs": "z", "node_modules/m.js": "m" }, at: "2026-11-03T09:00:00Z" });
  gitCommit(fx.root, { files: { "src/a é.mjs": "a" }, at: "2026-11-04T09:00:00Z" });
  const r = await closeRefs(fx, process.env);
  assert.equal(r.r.source, "commits");
  assert.equal(r.r.verified, false);
  assert.deepEqual(r.r.refs, ["src/a é.mjs", "src/z.mjs"], "by path, not quoted");
  assert.deepEqual(
    r.r.dropped,
    [{ path: "node_modules/m.js", why: "ignored" }],
    "unfiltered, so the ignored are named",
  );
  assert.deepEqual(r.r.notes, [
    {
      code: "unverified",
      message: `these are the files of every commit on HEAD since ${STARTED}, other stories' included: check them before writing them.`,
    },
  ]);
});

// [close-refs#5]
test("source 3: no started_at, or no commit since it, gives source none and no refs (edge)", async () => {
  const fx = fixture({ pr: null });
  const r = await closeRefs(fx, process.env);
  assert.deepEqual(r.r, { source: "none", verified: false, refs: [], dropped: [], notes: [] });
  const fy = fixture({ pr: null, fm: { started_at: JSON.stringify(STARTED) } });
  const s = await closeRefs(fy, process.env);
  assert.deepEqual(s.r, { source: "none", verified: false, refs: [], dropped: [], notes: [] });
});

// [close-refs#5]
test("source 3: a git log that fails gives source none, no refs and commits-unknown (failure)", async () => {
  const fx = fixture({ pr: null, fm: { started_at: JSON.stringify(STARTED) }, repo: false });
  git(fx.root, ["init", "-q"]); // a repository with no commit: the log of HEAD fails
  const r = await closeRefs(fx, process.env);
  assert.equal(r.r.source, "none");
  assert.deepEqual(r.r.refs, []);
  assert.deepEqual(codes(r.r), ["commits-unknown"]);
  assert.match(
    r.r.notes[0].message,
    new RegExp(
      `^git could not list the commits since ${STARTED.replace(/\./g, "\\.")} \\(fatal: .+\\), so no files are proposed\\. To set them by hand: `,
    ),
  );
});

// ─── Contract 6: one normaliser ───────────────────────────────────────

// [close-refs#6]
test("normaliser: the project's prefix is stripped, then outside-project, vault, ignored, removed and absent drop in that order, and duplicates keep their first place", () => {
  const cases = [
    {
      name: "the spec's scenario: a project at app/ with its vault at app/vault/",
      items: ["app/src/x.mjs", "docs/y.md", "app/node_modules/z.js", "app/vault/a.md", "app/src/x.mjs"],
      opts: { prefix: "app/", vault: "vault" },
      refs: ["src/x.mjs"],
      dropped: [
        { path: "docs/y.md", why: "outside-project" },
        { path: "node_modules/z.js", why: "ignored" },
        { path: "vault/a.md", why: "vault" },
      ],
    },
    {
      name: "removed before absent; absent only with a person",
      items: [{ path: "a.mjs", removed: true }, "b.mjs", "c.mjs"],
      opts: { prefix: "", exists: (p) => p === "c.mjs" },
      refs: ["c.mjs"],
      dropped: [
        { path: "a.mjs", why: "removed" },
        { path: "b.mjs", why: "absent" },
      ],
    },
    {
      name: "no person: an absent file is kept",
      items: ["b.mjs"],
      opts: { prefix: "", exists: () => false, person: false },
      refs: ["b.mjs"],
      dropped: [],
    },
    {
      name: "the reviewer's paths (prefix null) skip the prefix step and take every other filter",
      items: ["./src/a.mjs", "../up.mjs", "/abs.mjs", "vault/x.md", "dist/a.js", "src/a.mjs"],
      opts: { prefix: null, vault: "vault" },
      refs: ["src/a.mjs"],
      dropped: [
        { path: "../up.mjs", why: "outside-project" },
        { path: "/abs.mjs", why: "outside-project" },
        { path: "vault/x.md", why: "vault" },
        { path: "dist/a.js", why: "ignored" },
      ],
    },
    {
      name: "the vault rule before ignored, the first rule met wins",
      items: ["app/vault/node_modules/a.js"],
      opts: { prefix: "app/", vault: "vault" },
      refs: [],
      dropped: [{ path: "vault/node_modules/a.js", why: "vault" }],
    },
  ];
  for (const c of cases) {
    const got = normaliseRefs(c.items, c.opts);
    assert.deepEqual(got, { refs: c.refs, dropped: c.dropped }, c.name);
  }
});

// [close-refs#6]
test("normaliser in the verb: a project at app/ of its repository and its vault inside it", async () => {
  const fx = fixture({ sub: "app", files: { "src/x.mjs": "x" } });
  const stub = stubOf({
    prs: [
      pr(7, {
        files: [
          modified("app/src/x.mjs"),
          modified("docs/y.md"),
          modified("app/node_modules/z.js"),
          modified("app/vault/a.md"),
          modified("app/src/x.mjs"),
        ],
      }),
    ],
  });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(r.r.refs, ["src/x.mjs"]);
  assert.deepEqual(r.r.dropped, [
    { path: "docs/y.md", why: "outside-project" },
    { path: "node_modules/z.js", why: "ignored" },
    { path: "vault/a.md", why: "vault" },
  ]);
});

// [close-refs#6]
test("normaliser: a project that is no git repository gives prefix-unknown, the reviewer's line is still read and no git log runs (failure)", async () => {
  const fx = fixture({ repo: false, fm: { started_at: JSON.stringify(STARTED) }, files: { "scripts/b.mjs": "b" } });
  const stub = stubOf({ prs: [pr(7, { files: [modified("scripts/a.mjs")] })] });
  const file = join(fx.root, "reviewer.txt");
  writeFileSync(file, 'code_refs: ["scripts/b.mjs"]\n');
  const r = await closeRefs(fx, stub.env(), ["--reviewer-refs-file", file]);
  assert.deepEqual(codes(r.r), ["prefix-unknown"]);
  assert.equal(
    r.r.notes[0].message,
    `git could not say where this project sits in its repository (not a git repository), so paths from the pull request and the commits cannot be turned into code_refs. The reviewer's line is still read. To set them by hand: ${set(stub.env())}.`,
  );
  assert.equal(r.r.source, "reviewer");
  assert.deepEqual(r.r.refs, ["scripts/b.mjs"]);
  assert.deepEqual(stub.calls("pr view"), [], "the files are not read");
  // Without the reviewer's file, no commit is read and the note is not repeated.
  const s = await closeRefs(fx, stub.env());
  assert.deepEqual(codes(s.r), ["prefix-unknown"]);
  assert.equal(s.r.source, "none");
});

// [close-refs#6]
test("normaliser: a merged pull request that added src/new.mjs and a checkout without its merge commit give no refs and checkout-behind (failure)", async () => {
  const fx = fixture({ files: { "src/old.mjs": "o" } });
  const stub = stubOf({
    prs: [
      pr(7, {
        mergeCommit: { oid: SHA_GONE },
        files: [
          modified("src/old.mjs"),
          { path: "src/new.mjs", changeType: "ADDED" },
          { path: "x.mjs", changeType: "DELETED" },
        ],
      }),
    ],
  });
  const r = await closeRefs(fx, stub.env());
  assert.equal(r.r.source, "pr");
  assert.equal(r.r.verified, true);
  assert.deepEqual(r.r.refs, []);
  assert.deepEqual(r.r.dropped, [{ path: "x.mjs", why: "removed" }], "the other drops stay");
  assert.deepEqual(r.r.notes, [
    {
      code: "checkout-behind",
      message: `this checkout is behind: pull, then run the close again. 1 files of ${URL7} are not here, and its merge commit 0123456 is not in this branch.`,
    },
  ]);
});

// [close-refs#6]
test("normaliser: a merged pull request's file a later commit removed, in a checkout that holds the merge commit, drops as absent with no checkout-behind (edge)", async () => {
  const fx = fixture({ files: { "src/keep.mjs": "k" } });
  const stub = stubOf({
    prs: [pr(7, { mergeCommit: { oid: fx.head }, files: [modified("src/keep.mjs"), modified("src/gone.mjs")] })],
  });
  const r = await closeRefs(fx, stub.env());
  assert.deepEqual(r.r.refs, ["src/keep.mjs"]);
  assert.deepEqual(r.r.dropped, [{ path: "src/gone.mjs", why: "absent" }]);
  assert.deepEqual(r.r.notes, []);
});

// Every note's message, as the spec's table words it.
// [close-refs#1]
test("notes: every code of the table has its message, follow's two sentences included", () => {
  const s = "/projectstore:codemap set PS-X/story-a";
  const u = URL7;
  assert.equal(
    noteMessage("prefix-unknown", { url: u, reason: "r" }, { who: "follow", set: s }),
    `git could not say where this project sits in its repository (r), so the files of ${u} cannot be turned into code_refs. None are written. To set them by hand: ${s}.`,
  );
  assert.equal(
    noteMessage("prefix-unknown", { reason: "r" }, { set: s }),
    `git could not say where this project sits in its repository (r), so paths from the pull request and the commits cannot be turned into code_refs. The reviewer's line is still read. To set them by hand: ${s}.`,
  );
  assert.equal(
    noteMessage("files-unknown", { url: u, reason: "r" }, { who: "follow", set: s }),
    `could not read the files of ${u}: r. The story is left as it is; the next run reads again.`,
  );
  assert.equal(
    noteMessage("refs-over-cap", { url: u, n: 400 }, { set: s }),
    `${u} gives 400 code_refs, more than follow writes on its own (300), so none was written. To set them: ${s}.`,
  );
  assert.equal(
    noteMessage("commits-unknown", { startedAt: STARTED, reason: "r" }, { set: s }),
    `git could not list the commits since ${STARTED} (r), so no files are proposed. To set them by hand: ${s}.`,
  );
});

// ─── The close computation takes the refs (SPEC-001 contract 7, amended) ──

// A bound project for story-section.mjs, with one story and its epic.
function gateFixture({ story = {}, epicRefs = null } = {}) {
  const fx = fixture({ pr: null, repo: false, fm: story, epicRefs });
  return fx;
}
function gateRun(fx, args) {
  return spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), "close", fx.path, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: fx.proj, CLAUDE_PLUGIN_ROOT: REPO },
    cwd: REPO,
    timeout: 15000,
  });
}
const refsFile = (fx, list) => {
  const p = join(fx.root, `refs-${Math.random()}.json`);
  writeFileSync(p, JSON.stringify(list));
  return p;
};
const codeRefsLine = (t) => t.split("\n").find((l) => l.startsWith("code_refs:"));

// [SPEC-001#7]
test("close: given refs follow the story's own in the given order, deduplicated, as one JSON line", () => {
  const t = setFm(storyText({ id: "story-a" }), "code_refs", '["a.mjs"]');
  const c = computeClose(t, { day: "2026-11-19", codeRefs: ["b.mjs", "a.mjs", "c/", "b.mjs"] });
  assert.equal(codeRefsLine(c.text), 'code_refs: ["a.mjs", "b.mjs", "c/"]');
  assert.ok(c.notes.includes("code_refs: added 2"));
  const none = computeClose(t, { day: "2026-11-19", codeRefs: [] });
  assert.equal(codeRefsLine(none.text), codeRefsLine(t), "an empty list leaves code_refs byte-identical");
  const absent = computeClose(t, { day: "2026-11-19" });
  assert.equal(codeRefsLine(absent.text), codeRefsLine(t));
});

// [SPEC-001#7]
test("close: story-section.mjs close --code-refs-file writes the refs, and an empty file gives the bytes of a close without one", () => {
  const fx = gateFixture();
  const r = gateRun(fx, ["--code-refs-file", refsFile(fx, ["scripts/a.mjs", "README.md"])]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(codeRefsLine(JSON.parse(r.stdout).content), 'code_refs: ["scripts/a.mjs", "README.md"]');
  // An empty list: the clerk's --check against a close without the file matches.
  const plain = gateRun(fx, []);
  const baseline = join(fx.root, "baseline.md");
  writeFileSync(baseline, JSON.parse(plain.stdout).content);
  const empty = gateRun(fx, ["--code-refs-file", refsFile(fx, []), "--check", baseline]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).check.match, true);
  assert.equal(read(fx.path), storyText({ id: "story-a" }), "the gate writes no file");
});

// [SPEC-001#7]
test("close: the clerk's --check with the same refs file matches, and without it drifts on code_refs", () => {
  const fx = gateFixture();
  const file = refsFile(fx, ["src/a.mjs"]);
  const first = gateRun(fx, ["--code-refs-file", file]);
  const baseline = join(fx.root, "approved.md");
  writeFileSync(baseline, JSON.parse(first.stdout).content);
  const same = gateRun(fx, ["--code-refs-file", file, "--check", baseline]);
  assert.equal(JSON.parse(same.stdout).check.match, true);
  const without = gateRun(fx, ["--check", baseline]);
  const j = JSON.parse(without.stdout);
  assert.equal(j.check.match, false);
  assert.ok(
    j.check.drift.some((d) => d.includes("code_refs")),
    JSON.stringify(j.check.drift),
  );
});

// [SPEC-001#7]
test("close: a story's or an epic's code_refs that is no one-line JSON list refuses the close with code-refs-unreadable, exit 1 and nothing on stdout (failure)", () => {
  const block = gateFixture();
  writeFileSync(block.path, read(block.path).replace("code_refs: []", "code_refs:\n  - src/a.mjs"));
  const r = gateRun(block, ["--code-refs-file", refsFile(block, ["src/b.mjs"])]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /code-refs-unreadable: the story's code_refs is not a one-line JSON list/);
  // With no refs given, the same story closes: nothing is added, nothing judged.
  assert.equal(gateRun(block, []).status, 0);
  const yaml = gateFixture({ epicRefs: "[src/, docs/]" });
  const e = gateRun(yaml, ["--code-refs-file", refsFile(yaml, ["src/b.mjs"])]);
  assert.equal(e.status, 1);
  assert.equal(e.stdout, "");
  assert.match(e.stderr, /code-refs-unreadable: its epic's code_refs/);
  assert.throws(
    () => computeClose(read(block.path), { codeRefs: ["x"] }),
    (err) => err.code === "code-refs-unreadable",
  );
  // A file that is no list of paths exits 1 too.
  const bad = gateFixture();
  const notList = join(bad.root, "bad.json");
  writeFileSync(notList, '{"a": 1}');
  assert.equal(gateRun(bad, ["--code-refs-file", notList]).status, 1);
});

// ─── The epic widens (status-change.mjs epic-refs) ────────────────────

function epicRefs(fx, args) {
  return spawnSync(process.execPath, [join(REPO, "scripts", "status-change.mjs"), "epic-refs", fx.path, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: fx.proj },
    cwd: tmpdir(),
    timeout: 15000,
  });
}

// [SPEC-001#7]
test("epic-refs: bare, it prints the refs no epic ref covers by doctor's prefix rule and writes nothing", () => {
  const fx = gateFixture({ epicRefs: '["scripts/"]' });
  const before = read(fx.epic);
  const r = epicRefs(fx, ["--code-refs-file", refsFile(fx, ["scripts/a.mjs", "README.md", "docs/x.md"])]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.add, ["README.md", "docs/x.md"]);
  assert.equal(j.written, false);
  assert.equal(read(fx.epic), before);
});

// [SPEC-001#7]
test("epic-refs --write appends the additions as they are, moves updated, and a second run changes nothing", () => {
  const fx = gateFixture({ epicRefs: '["scripts/"]' });
  const file = refsFile(fx, ["scripts/a.mjs", "README.md", "src/", "src/b.mjs"]);
  const r = epicRefs(fx, ["--code-refs-file", file, "--write"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.add, ["README.md", "src/"], "src/b.mjs is inside the src/ just added");
  assert.equal(j.written, true);
  const after = read(fx.epic);
  assert.equal(codeRefsLine(after), 'code_refs: ["scripts/", "README.md", "src/"]');
  assert.doesNotMatch(after, /^updated: 2026-01-01$/m, "updated moves when a ref is added");
  const again = epicRefs(fx, ["--code-refs-file", file, "--write"]);
  assert.deepEqual(JSON.parse(again.stdout).add, []);
  assert.equal(JSON.parse(again.stdout).written, false);
  assert.equal(read(fx.epic), after, "idempotent: not even updated moves");
});

// [SPEC-001#7]
test("epic-refs: without a file it reads the story's own code_refs; an unreadable epic exits 1 and writes nothing (failure)", () => {
  const fx = gateFixture({ story: { code_refs: '["lib/a.mjs"]' }, epicRefs: "[]" });
  const r = widenEpicRefs(fx.path, { write: true });
  assert.deepEqual([r.add, r.written, r.error], [["lib/a.mjs"], true, null]);
  const bad = gateFixture({ epicRefs: "[lib/, docs/]" });
  const before = read(bad.epic);
  const e = epicRefs(bad, ["--code-refs-file", refsFile(bad, ["lib/a.mjs"]), "--write"]);
  assert.equal(e.status, 1);
  assert.match(JSON.parse(e.stdout).error, /^code-refs-unreadable: the epic's code_refs/);
  assert.equal(read(bad.epic), before);
  assert.equal(epicRefs(bad, ["--bogus"]).status, 2);
});

// ─── The story command and the reviewer, in every copy ────────────────

const STORY_COPIES = [
  "commands/story.md",
  "adapters/codex/skills/projectstore-story/SKILL.md",
  "packaging/shells/projectstore-codex/skills/projectstore-story/SKILL.md",
];
const REVIEWER_COPIES = [
  "agents/reviewer.md",
  "adapters/codex/skills/projectstore-reviewer/SKILL.md",
  "packaging/shells/projectstore-codex/skills/projectstore-reviewer/SKILL.md",
];
const flat = (s) => s.replace(/\s+/g, " ");
// The text of one step: from its heading to the next one given.
const stepOf = (t, from, to) => {
  const a = t.indexOf(from);
  const b = t.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `${from} … ${to}`);
  return flat(t.slice(a, b));
};

// [SPEC-001#7]
test("commands/story.md and its copies: every close run passes --code-refs-file, epic-refs --write runs after the step 5 re-check and before 5a's doctor snapshot, checkout-behind stops before the preview, and step 6b suggests no codemap set", () => {
  for (const rel of STORY_COPIES) {
    const t = read(join(REPO, rel));
    const life = t.slice(t.indexOf("# Lifecycle gate flow"));
    const s1b = stepOf(life, "1b. **(close only) The code_refs this close adds.**", "2. **Run the compute script**");
    assert.ok(s1b.includes('bin/projectstore.mjs" close-refs <EPIC-ID>/<story-id> --reviewer-refs-file'), rel);
    assert.ok(
      s1b.includes("`checkout-behind`: stop the gate before the preview and write nothing.") &&
        s1b.includes("ask the person to pull, then run the close again"),
      `${rel}: checkout-behind stops`,
    );
    assert.ok(
      s1b.includes("step 2, the re-run in step 5, and the clerk's `--check` of step 5a"),
      `${rel}: the refs file on every close run`,
    );
    assert.ok(s1b.includes("names `code-refs-unreadable`"), rel);
    assert.ok(s1b.includes("A `commits` result whose `refs` is `[]` is treated as `none`"), rel);
    const s2 = stepOf(life, "2. **Run the compute script**", "2a. **(plan only)");
    assert.ok(s2.includes('On a close, add `--code-refs-file "<refs-file>"` from step 1b'), `${rel} step 2`);
    const s4 = stepOf(life, "4. **Preview**", "5. **Immediately before writing**");
    for (const needle of [
      'status-change.mjs" epic-refs "<story-path>" --code-refs-file "<refs-file>"',
      "code_refs list the files this story changed; projectstore uses them in code-map.md and in doctor's checks to show which code each story and epic owns.",
      "read through the GitHub CLI (gh).",
      "These come from the reviewer's last code_refs line",
      "No code_refs are added: no source gave files for this story.",
      "before the Yes / Edit / No question",
      "one per line as `<path> (<why>)`",
      '"not in this checkout"',
      "Edit the list to `[]` and run the close again, or to fix the epic",
    ])
      assert.ok(s4.includes(needle), `${rel} step 4: ${needle}`);
    assert.ok(!s4.includes("--write"), `${rel}: the preview's epic plan writes nothing`);
    const s5 = stepOf(life, "5. **Immediately before writing**", "5a. **Delegate the ceremony");
    assert.ok(s5.includes("re-run it with the same `--code-refs-file`"), `${rel} step 5`);
    assert.ok(
      s5.includes('status-change.mjs" epic-refs "<story-path>" --code-refs-file "<refs-file>" --write'),
      `${rel}: epic-refs --write in step 5`,
    );
    assert.ok(s5.includes("before 5a's doctor snapshot"), rel);
    assert.ok(s5.includes("A non-zero exit stops the close"), rel);
    const s5a = stepOf(life, "5a. **Delegate the ceremony", "6. **On Yes**");
    assert.ok(s5a.includes("Capture doctor's summary line"), rel);
    assert.ok(
      s5a.includes('`story-section.mjs close "<story-path>" --code-refs-file "<refs-file>" --check <baseline-path>`'),
      rel,
    );
    assert.ok(s5a.includes("plus `codemap` when the refs file is not `[]`"), rel);
    const s6b = stepOf(life, "6b. **(close only) Verify**", "6c. **");
    assert.ok(!s6b.includes("suggest the reviewer's"), `${rel}: step 6b's suggestion is gone`);
    assert.ok(!/diff-refs\.mjs --since/.test(s6b), rel);
    assert.match(flat(life), /skip steps 6-6b and run step 6c, then step 6d/);
  }
});

// [SPEC-001#10]
test("agents/reviewer.md and its copies: the story-conformance report ends with one line code_refs: [...], files only, relative to the project root", () => {
  for (const rel of REVIEWER_COPIES) {
    const t = flat(read(join(REPO, rel)));
    for (const needle of [
      "The story-conformance report's last line (not the spec-drift report's) is the proposed refs in one fixed form, files only, each path relative to the project root, as one JSON list:",
      'code_refs: ["scripts/a.mjs", "README.md"]',
      "(`code_refs: []` when the story changed no file.)",
    ])
      assert.ok(t.includes(needle), `${rel}: ${needle}`);
    assert.ok(!t.includes("the write happens in the approval-gated"), `${rel}: the old codemap-set sentence is gone`);
  }
  // The line is one the verb reads: the last code_refs line, one JSON list.
  assert.deepEqual(reviewerLine('report\ncode_refs: ["scripts/a.mjs", "README.md"]\n'), ["scripts/a.mjs", "README.md"]);
});

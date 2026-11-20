// projectstore — test fixture: a reader and a local runner for the CI
// template, templates/follow-github-actions.yml (the spec with alias
// `ci-template`, "Testing"). The suite has no YAML parser and no GitHub, so:
//
//   readWorkflow(text)  → { name, on, permissions, concurrency, jobs, expressions }
//     A reader of the template's own shape and nothing more. Every line that is
//     not a comment must be one it knows (contract 1): top-level `name`, `on`,
//     `permissions`, `concurrency` and `jobs`; under `on`, events with an
//     optional `branches` list; a job's `runs-on`, `timeout-minutes` and
//     `steps`; a step as `- name` or `- uses`, with `name`, `uses`, `id`,
//     `env:` and `with:` maps of one-line scalars, and `run: |` or a one-line
//     `run:`. A tab, a flow-style map or list, an anchor or alias, a tag, an
//     inline comment, a duplicate key or any other key throws, naming the line.
//   EXPRESSIONS, evalExpr(text, ctx)
//     The closed list of `${{ }}` expressions; any other one throws, in the
//     reader and in the runner alike.
//   runJob(text, opts) → { code, failed, steps, raw, log, errors, runnerTemp }
//     Runs the one job: a `uses:` step is a no-op (the workspace already is the
//     checkout, and the runner's Node is this one); a `run:` step runs with
//     `bash -e` in the workspace, with a scratch RUNNER_TEMP, a fresh
//     GITHUB_OUTPUT per step, and an explicit environment (opts.env, nothing
//     inherited) plus the step's own `env:`. `raw` is every byte the steps
//     printed; `log` is what GitHub would show: `::add-mask::` lines dropped
//     and each secret's value and each registered one replaced by `***`. `::error::` lines are kept
//     and collected in `errors`. The first failing step ends the job with its
//     code. `before(i, step)` and `after(i, step)` run around each step.
//   jobWorld({ vault, table, bound })
//     The world of one scenario: a bare vault remote seeded from the folder
//     `vault` (one commit), a code workspace with one commit and no binding
//     (or, with `bound`, a binding to that other path), the gh stub with
//     `table`, the git recorder, an `npx` shim, and a git config file that
//     maps REMOTE to the bare repository with `url.<path>.insteadOf`.
//
// The npx shim is a node script named `npx` whose interpreter is this Node.
// It logs { argv, env } beside itself, drops `--yes` and the package name
// (`projectstore` or `projectstore@<version>`), and runs this checkout's
// bin/projectstore.mjs with the rest. Any other package fails with 127.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ghStub } from "./gh-stub.mjs";
import { gitRecorder } from "./git-recorder.mjs";
import { git, gitCommit } from "./flow.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = join(REPO, "bin", "projectstore.mjs");
// The vault remote every scenario names; the git config maps it to a bare repository.
export const REMOTE = "https://git.example.com/team/vault.git";

// ─── The expressions ────────────────────────────────────────────────────

export const EXPRESSIONS = [
  "vars.PROJECTSTORE_VAULT_LANGUAGE",
  "vars.PROJECTSTORE_VAULT_BRANCH",
  "secrets.PROJECTSTORE_VAULT_TOKEN",
  "secrets.PROJECTSTORE_VAULT_REMOTE",
  "github.token",
  "github.event.repository.private",
  "steps.follow.outputs.code",
];
const EXPR = /\$\{\{([^}]*)\}\}/g;

function expressionsOf(text, where) {
  const s = String(text);
  if (s.replace(EXPR, "").includes("${{")) throw new Error(`${where}: an expression that does not close`);
  return [...s.matchAll(EXPR)].map((m) => {
    const e = m[1].trim();
    if (!EXPRESSIONS.includes(e)) throw new Error(`${where}: the expression ${e} is not on the list`);
    return e;
  });
}

// The value of each expression: vars, secrets, the run's token, the
// repository's private flag as the runner prints it, the follow step's code.
export function evalExpr(text, ctx) {
  expressionsOf(text, "evalExpr");
  return String(text).replace(EXPR, (_, raw) => {
    const e = raw.trim();
    if (e.startsWith("vars.")) return ctx.vars?.[e.slice(5)] ?? "";
    if (e.startsWith("secrets.")) return ctx.secrets?.[e.slice(8)] ?? "";
    if (e === "github.token") return ctx.githubToken ?? "";
    if (e === "github.event.repository.private") return ctx.repoPrivate ?? "";
    return ctx.outputs?.follow?.code ?? "";
  });
}

// ─── The reader ─────────────────────────────────────────────────────────

const TOP = ["name", "on", "permissions", "concurrency", "jobs"];
const JOB_KEYS = ["runs-on", "timeout-minutes", "steps"];
const STEP_KEYS = ["name", "uses", "id", "env", "with", "run"];
const CONCURRENCY_KEYS = ["group", "cancel-in-progress"];

// One scalar on one line: plain, "double" or 'single' quoted, with no
// escapes, no flow collection, no anchor, alias or tag, no inline comment.
function scalar(v, where) {
  if (v === "") throw new Error(`${where}: a key with no value`);
  if (/^"[^"\\]*"$/.test(v) || /^'[^']*'$/.test(v)) return v.slice(1, -1);
  if (/^["']/.test(v)) throw new Error(`${where}: a quoted value the reader does not know`);
  if (/^[{[&*!|>%@`]/.test(v))
    throw new Error(`${where}: a flow collection, anchor, alias, tag or block the reader does not know`);
  if (/ #|: /.test(v)) throw new Error(`${where}: an inline comment or a nested map the reader does not know`);
  return v;
}

export function readWorkflow(text) {
  const wf = { name: null, on: {}, permissions: {}, concurrency: {}, jobs: {}, expressions: [] };
  const seen = new Set();
  const once = (key, where) => {
    if (seen.has(key)) throw new Error(`${where}: a duplicate key`);
    seen.add(key);
  };
  let top = null; // the top-level section
  let event = null; // the event under `on`
  let inBranches = false;
  let job = null;
  let inSteps = false;
  let step = null;
  let map = null; // the step's env or with
  let block = null; // the lines of a run block
  let n = 0;
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const endBlock = () => {
    while (block.lines.length && block.lines.at(-1) === "") block.lines.pop();
    block.step.run = block.lines.join("\n") + "\n";
    block = null;
  };
  for (const line of lines) {
    n++;
    const where = `line ${n}`;
    if (line.includes("\t")) throw new Error(`${where}: a tab`);
    if (block) {
      if (line.trim() === "" || line.startsWith(" ".repeat(block.indent))) {
        const content = line.trim() === "" ? "" : line.slice(block.indent);
        wf.expressions.push(...expressionsOf(content, where));
        block.lines.push(content);
        continue;
      }
      endBlock();
    }
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/\s$/.test(line)) throw new Error(`${where}: trailing white space`);
    const item = /^ {6}- (.*)$/.exec(line);
    if (item && top === "on" && inBranches) {
      wf.on[event].branches.push(scalar(item[1], where));
      continue;
    }
    const m = /^( *)(- )?([A-Za-z_][A-Za-z0-9_.-]*):(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`${where}: the reader does not know this line: ${JSON.stringify(line)}`);
    const [, sp, dash, key, rawValue] = m;
    const indent = sp.length;
    const value = rawValue === undefined ? "" : rawValue;
    if (value) wf.expressions.push(...expressionsOf(value, where));
    const bare = () => {
      if (value !== "") throw new Error(`${where}: ${key} takes a nested block here, not a value`);
    };
    if (indent === 0 && !dash) {
      if (!TOP.includes(key)) throw new Error(`${where}: an unknown top-level key ${key}`);
      once(key, where);
      top = key;
      event = job = step = map = null;
      inBranches = inSteps = false;
      if (key === "name") wf.name = scalar(value, where);
      else bare();
      continue;
    }
    if (indent === 2 && !dash && top === "on") {
      once(`on.${key}`, where);
      bare();
      event = key;
      inBranches = false;
      wf.on[key] = {};
      continue;
    }
    if (indent === 4 && !dash && top === "on" && event && key === "branches") {
      once(`on.${event}.branches`, where);
      bare();
      wf.on[event].branches = [];
      inBranches = true;
      continue;
    }
    if (indent === 2 && !dash && top === "permissions") {
      once(`permissions.${key}`, where);
      wf.permissions[key] = scalar(value, where);
      continue;
    }
    if (indent === 2 && !dash && top === "concurrency") {
      if (!CONCURRENCY_KEYS.includes(key)) throw new Error(`${where}: an unknown concurrency key ${key}`);
      once(`concurrency.${key}`, where);
      wf.concurrency[key] = scalar(value, where);
      continue;
    }
    if (indent === 2 && !dash && top === "jobs") {
      once(`jobs.${key}`, where);
      bare();
      job = wf.jobs[key] = { steps: [] };
      inSteps = false;
      step = map = null;
      continue;
    }
    if (indent === 4 && !dash && top === "jobs" && job) {
      if (!JOB_KEYS.includes(key)) throw new Error(`${where}: an unknown job key ${key}`);
      once(`job.${Object.keys(wf.jobs).at(-1)}.${key}`, where);
      if (key === "steps") {
        bare();
        inSteps = true;
      } else {
        job[key] = scalar(value, where);
        inSteps = false;
      }
      continue;
    }
    if (indent === 6 && dash && top === "jobs" && inSteps) {
      if (!["name", "uses"].includes(key))
        throw new Error(`${where}: a step starts with - name or - uses, not - ${key}`);
      step = { line: n, env: {}, with: {}, keys: new Set([key]) };
      step[key] = scalar(value, where);
      job.steps.push(step);
      map = null;
      continue;
    }
    if (indent === 8 && !dash && step) {
      if (!STEP_KEYS.includes(key)) throw new Error(`${where}: an unknown step key ${key}`);
      if (step.keys.has(key)) throw new Error(`${where}: a duplicate key`);
      step.keys.add(key);
      map = null;
      if (key === "env" || key === "with") {
        bare();
        map = step[key];
      } else if (key === "run" && value === "|") {
        block = { step, indent: 10, lines: [] };
      } else if (key === "run") {
        step.run = scalar(value, where) + "\n";
      } else step[key] = scalar(value, where);
      continue;
    }
    if (indent === 10 && !dash && map) {
      if (key in map) throw new Error(`${where}: a duplicate key`);
      map[key] = scalar(value, where);
      continue;
    }
    throw new Error(`${where}: the reader does not know this line: ${JSON.stringify(line)}`);
  }
  if (block) endBlock();
  return wf;
}

// ─── The runner ─────────────────────────────────────────────────────────

export function runJob(text, o) {
  const wf = readWorkflow(text);
  const [job] = Object.values(wf.jobs);
  const tmp = mkdtempSync(join(tmpdir(), "ps-ci-run-"));
  const runnerTemp = join(tmp, "runner-temp");
  mkdirSync(runnerTemp);
  for (const k of Object.keys(o.env || {}))
    if (/^(?:GH_|GITHUB_)/.test(k) || (/^GIT_/.test(k) && !/^GIT_CONFIG_(?:GLOBAL|NOSYSTEM)$/.test(k)))
      throw new Error(
        `runJob: the base environment holds ${k}; a step gets git's and gh's settings from its env alone`,
      );
  const ctx = {
    vars: o.vars || {},
    secrets: o.secrets || {},
    githubToken: o.githubToken ?? "run-token-of-this-job",
    repoPrivate: o.repoPrivate === undefined ? "true" : String(o.repoPrivate),
    outputs: {},
  };
  // GitHub masks every secret's value in the log, as it masks a registered one.
  const masks = Object.values(ctx.secrets).filter((v) => typeof v === "string" && v !== "");
  const raw = [];
  const log = [];
  const errors = [];
  const steps = [];
  for (const [i, s] of job.steps.entries()) {
    if (o.before) o.before(i, s);
    if (s.uses) {
      steps.push({ index: i, uses: s.uses, code: 0 });
      continue;
    }
    const output = join(tmp, `output-${i}`);
    writeFileSync(output, "");
    const env = {
      ...o.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: o.workspace,
      CI: "true",
      GITHUB_ACTIONS: "true",
      ...Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, evalExpr(v, ctx)])),
    };
    const file = join(tmp, `step-${i}.sh`);
    writeFileSync(file, s.run);
    const r = spawnSync("bash", ["-e", file], { cwd: o.workspace, env, encoding: "utf8", timeout: 120000 });
    const printed = `${r.stdout || ""}${r.stderr || ""}`;
    raw.push(printed);
    for (const line of printed.split("\n")) {
      const mask = /^::add-mask::(.*)$/.exec(line);
      if (mask) {
        if (mask[1]) masks.push(mask[1]);
        continue;
      }
      if (!line) continue;
      let shown = line;
      for (const k of masks) shown = shown.split(k).join("***");
      const err = /^::error::(.*)$/.exec(shown);
      if (err) errors.push(err[1]);
      log.push(shown);
    }
    const outputs = {};
    for (const l of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(l);
      if (!kv) throw new Error(`step ${i}: a GITHUB_OUTPUT line the runner does not know: ${l}`);
      outputs[kv[1]] = kv[2];
    }
    if (s.id) ctx.outputs[s.id] = outputs;
    const code = r.status === null ? 1 : r.status;
    steps.push({ index: i, name: s.name, id: s.id, code });
    if (code !== 0)
      return { code, failed: { index: i, name: s.name }, steps, raw: raw.join(""), log, errors, runnerTemp, tmp };
    if (o.after) o.after(i, s);
  }
  return { code: 0, failed: null, steps, raw: raw.join(""), log, errors, runnerTemp, tmp };
}

// ─── The world ──────────────────────────────────────────────────────────

const jsonl = (file) => {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function npxShim(dir) {
  mkdirSync(dir, { recursive: true });
  const script = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, env: process.env }) + "\\n");
const rest = argv.slice();
while (rest[0] === "--yes") rest.shift();
if (!/^projectstore(?:@\\S+)?$/.test(rest[0] || "")) { process.stderr.write("npx shim: not projectstore: " + rest[0] + "\\n"); process.exit(127); }
rest.shift();
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...rest], { stdio: "inherit" });
process.exitCode = r.status === null ? 1 : r.status;
`;
  writeFileSync(join(dir, "npx"), script, { mode: 0o755 });
  return {
    dir,
    log: () => jsonl(join(dir, "calls.jsonl")),
    argv: () => jsonl(join(dir, "calls.jsonl")).map((c) => c.argv),
  };
}

export function jobWorld({ vault, table = { prs: [] }, bound = null } = {}) {
  const W = mkdtempSync(join(tmpdir(), "ps-ci-world-"));
  git(vault, ["init", "-q"]);
  git(vault, ["add", "-A"]);
  gitCommit(vault, { message: "seed the vault" });
  const bare = join(W, "vault.git");
  git(W, ["clone", "--bare", "-q", vault, bare]);
  const ws = join(W, "code");
  mkdirSync(ws);
  git(ws, ["init", "-q"]);
  gitCommit(ws, { files: { "README.md": "the code\n" }, message: "the code" });
  if (bound) {
    mkdirSync(join(ws, ".projectstore"));
    writeFileSync(
      join(ws, ".projectstore", "projectstore.json"),
      JSON.stringify({ vault_path: bound, layout: "engineering", language: "en" }),
    );
  }
  const gh = ghStub(join(W, "gh"), table);
  const recorder = gitRecorder(join(W, "git"));
  const npx = npxShim(join(W, "npx"));
  const gitconfig = join(W, "gitconfig");
  writeFileSync(
    gitconfig,
    `[url "${bare}"]\n\tinsteadOf = ${REMOTE}\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n`,
  );
  const home = join(W, "home");
  mkdirSync(join(home, ".cache"), { recursive: true });
  const env = {
    PATH: [npx.dir, gh.dir, recorder.dir, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      delimiter,
    ),
    HOME: home,
    TMPDIR: tmpdir(),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    PROJECTSTORE_NO_UPDATE_CHECK: "1",
    npm_config_offline: "true",
  };
  // The remote's commits, newest first: "<sha> <author>|<committer>|<subject>".
  const commits = () => git(bare, ["log", "--format=%H %an <%ae>|%cn <%ce>|%s"]).split("\n");
  const files = (rev = "HEAD") => git(bare, ["show", "--name-only", "--format=", rev]).split("\n").filter(Boolean);
  return { W, bare, ws, gh, git: recorder, npx, env, remote: REMOTE, commits, files };
}

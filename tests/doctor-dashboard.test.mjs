// projectstore — tests/doctor-dashboard.test.mjs: doctor's note on the
// dashboard's kept branches (PS-DASHBOARD, "The page writes by running core
// verbs, with a preview, and the click is the approval"; the spec "The
// dashboard's delivery: Send, Discard, the pull request's state, the carry
// and kept branches", alias `dashboard-delivery`, contract 7).
//
// Each case builds its own scratch world in the OS temp dir: a bare `origin`
// with one commit on main, a code repository as the anchor, and the
// dashboard's clone of origin at <anchor>/.projectstore/state/dashboard/<person>/clone
// with its batch branches made by plain git. Only local repositories, and
// git with the test file's own HOME and global config (hermeticGit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { hermeticGit } from "./fixtures/dashboard-world.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { commitsSeam } from "./fixtures/flow.mjs";
import { checkDashboardKept, runStartupChecks, runVaultChecks } from "../scripts/doctor.mjs";

hermeticGit();

const CHECK = "dashboard-kept-branch";
const KEPT = "dashboard/test-person/20261101T100000Z";
const OPEN = "dashboard/test-person/20261102T100000Z";
const CFG = { default_author: "Test Person" };

const ID = {
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a",
};
function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, ...ID },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const commit = (dir, msg) => git(dir, "commit", "-q", "--allow-empty", "-m", msg);

const roots = [];
process.on("exit", () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// A bare origin with main, and a code repository with one commit.
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-doctor-dash-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  const seed = join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  commit(seed, "base");
  git(seed, "push", "-q", "origin", "main");
  const anchor = join(root, "code");
  git(root, "init", "-q", anchor);
  commit(anchor, "code");
  return { root, origin, anchor };
}

const placeOf = (anchor, person) => join(anchor, ".projectstore", "state", "dashboard", person);

// The dashboard's clone for `person`, with a kept branch of `kept` commits
// beyond origin/main and, checked out, a batch of `open` commits.
function cloneWith(w, person = "test-person", { kept = 2, open = 1 } = {}) {
  const clone = join(placeOf(w.anchor, person), "clone");
  mkdirSync(dirname(clone), { recursive: true });
  git(w.root, "clone", "-q", w.origin, clone);
  const keptName = `dashboard/${person}/20261101T100000Z`;
  const openName = `dashboard/${person}/20261102T100000Z`;
  git(clone, "switch", "-q", "-c", keptName, "origin/main");
  for (let i = 0; i < kept; i++) commit(clone, `kept ${i}`);
  git(clone, "switch", "-q", "-c", openName, "origin/main");
  for (let i = 0; i < open; i++) commit(clone, `open ${i}`);
  return clone;
}

const ofCheck = (findings) => findings.filter((f) => f.check === CHECK);

// No command in a message: no code span, no slash command, no package
// command, no git subcommand, one line.
function printsNoCommand(message) {
  assert.ok(!message.includes("\n"), message);
  assert.doesNotMatch(message, /`|\/projectstore:|npx |\bprojectstore [a-z]|\bgit [a-z]|\bgh /, message);
}

// [dashboard-delivery#7]
test("doctor's note: a kept branch with two commits the default branch lacks is one info naming it and 2; the checked-out batch is not named; no command", () => {
  const w = world();
  const clone = cloneWith(w);
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 1, JSON.stringify(found));
  const [f] = found;
  assert.equal(f.level, "info");
  assert.equal(f.group, "vault");
  assert.equal(f.file, clone);
  assert.ok(f.message.includes(KEPT), f.message);
  assert.match(f.message, /\b2 commits that the fetched default branch origin\/main lacks/);
  assert.match(f.message, /may be work that was never sent/);
  assert.ok(!f.message.includes(OPEN), "the page's own batch is not named");
  printsNoCommand(f.message);
});

// [dashboard-delivery#7]
test("doctor's note: through runVaultChecks (doctor --vault), the kept branch is named", () => {
  const { proj, vault } = makeVaultProject();
  roots.push(proj);
  const cfg = { vault_path: vault, layout: "engineering", language: "en", default_author: "Test" };
  const w = { ...world(), anchor: proj };
  cloneWith(w, "test");
  const found = ofCheck(runVaultChecks(cfg, { proj, commits: commitsSeam() }));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0].message.includes("dashboard/test/20261101T100000Z"), found[0].message);
  assert.equal(found[0].level, "info");
});

// [dashboard-delivery#7]
test("doctor's note: no clone, a clone folder that is no repository, gives nothing, and git never answers for the code repository around it (edge)", () => {
  const w = world();
  assert.deepEqual(ofCheck(checkDashboardKept(CFG, w.anchor)), [], "no dashboard place");
  mkdirSync(placeOf(w.anchor, "test-person"), { recursive: true });
  assert.deepEqual(ofCheck(checkDashboardKept(CFG, w.anchor)), [], "a person folder without clone/");
  // A clone/ that is no repository, inside a code repository holding a branch
  // of that name: the ceiling keeps git from reading the code repository.
  mkdirSync(join(placeOf(w.anchor, "test-person"), "clone"));
  git(w.anchor, "branch", KEPT);
  assert.deepEqual(ofCheck(checkDashboardKept(CFG, w.anchor)), [], "clone/ that is no repository");
});

// [dashboard-delivery#7]
test("doctor's note: a clone without origin's default branch says the count could not be computed, never a number (failure)", () => {
  const w = world();
  const clone = cloneWith(w);
  git(clone, "remote", "set-head", "origin", "--delete");
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0].message.includes(KEPT), found[0].message);
  assert.match(found[0].message, /could not count its commits/);
  assert.doesNotMatch(found[0].message, /\b\d+ commits?\b/);
  printsNoCommand(found[0].message);
});

// [dashboard-delivery#7]
test("doctor's note: in the clone under untitled/, with default_author now set, the checked-out batch is named too (edge)", () => {
  const w = world();
  cloneWith(w, "untitled", { kept: 2, open: 1 });
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 2, JSON.stringify(found));
  const open = found.find((f) => f.message.includes("dashboard/untitled/20261102T100000Z"));
  assert.ok(open, JSON.stringify(found));
  assert.match(open.message, /is on the batch .* the binding's author is now test-person/);
  assert.match(open.message, /\b1 commit that the fetched default branch origin\/main lacks/);
  const kept = found.find((f) => f.message.includes("dashboard/untitled/20261101T100000Z"));
  assert.match(kept.message, /\b2 commits\b/);
  for (const f of found) printsNoCommand(f.message);
});

// [dashboard-delivery#7]
test("doctor's note: from a linked worktree the anchor is the main checkout, and its clone is read", () => {
  const w = world();
  cloneWith(w);
  const wt = join(w.root, "wt");
  git(w.anchor, "worktree", "add", "-q", "-b", "wt-branch", wt);
  const found = ofCheck(checkDashboardKept(CFG, wt));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0].message.includes(KEPT));
  assert.match(found[0].message, /\b2 commits\b/);
});

// A git first on PATH that notes each call in `mark`, then runs the real one.
function recordingGit(root) {
  const real = (process.env.PATH || "")
    .split(delimiter)
    .map((d) => join(d, "git"))
    .find((p) => existsSync(p));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const mark = join(root, "git-calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${mark}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return { bin, mark };
}

// [dashboard-delivery#7]
test("doctor's note: doctor --startup starts no git process and gives no dashboard-kept-branch (edge)", (t) => {
  const w = world();
  cloneWith(w);
  const { bin, mark } = recordingGit(w.root);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const r = runStartupChecks(CFG, w.anchor, 60000);
  assert.equal(r.skipped, false);
  assert.deepEqual(ofCheck(r.findings), []);
  assert.ok(!existsSync(mark), "the startup subset started git");
  // The recording git sees the vault check's calls: the probe works.
  assert.equal(ofCheck(checkDashboardKept(CFG, w.anchor)).length, 1);
  assert.ok(existsSync(mark), "the recording git saw the vault check");
});

// [dashboard-delivery#7]
test("doctor's note: a kept branch with no commit the default branch lacks says nothing on it is unsent, with no count and no command (edge)", () => {
  const w = world();
  cloneWith(w, "test-person", { kept: 0, open: 1 });
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0].message.includes(KEPT), found[0].message);
  assert.match(
    found[0].message,
    /It has no commit that the fetched default branch origin\/main lacks, so nothing on it is unsent\.$/,
  );
  assert.doesNotMatch(found[0].message, /\b\d+ commits?\b|never sent/);
  printsNoCommand(found[0].message);
});

// [dashboard-delivery#7]
test("doctor's note: a clone git cannot read gives one info that says so, with git's reason, never a quiet nothing (failure)", () => {
  const w = world();
  const clone = cloneWith(w);
  // A configuration git refuses to parse: git answers, but not with the refs.
  writeFileSync(join(clone, ".git", "config"), "[core\n");
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].level, "info");
  assert.equal(found[0].file, clone);
  assert.ok(
    found[0].message.startsWith(`Doctor could not read the dashboard's clone at ${clone}, so it cannot tell`),
    found[0].message,
  );
  assert.match(found[0].message, /bad config/);
  assert.ok(!found[0].message.includes(KEPT), "no branch is named: none was read");
  printsNoCommand(found[0].message);
});

// [dashboard-delivery#7]
test("doctor's note: an email-shaped default_author leaves no address in any message; the author is named by its slug (privacy)", () => {
  const w = world();
  cloneWith(w, "untitled", { kept: 1, open: 1 });
  const cfg = { default_author: "Test Person <tp@example.com>" };
  const found = ofCheck(checkDashboardKept(cfg, w.anchor));
  assert.equal(found.length, 2, JSON.stringify(found));
  for (const f of found) {
    assert.ok(!f.message.includes("@"), f.message);
    assert.ok(!f.message.includes("tp@example.com") && !f.message.includes("<"), f.message);
    printsNoCommand(f.message);
  }
  const open = found.find((f) => f.message.includes("dashboard/untitled/20261102T100000Z"));
  assert.ok(open, JSON.stringify(found));
  assert.match(open.message, /the binding's author is now test-person-tpexamplecom\b/);
});

// [dashboard-delivery#7]
test("doctor's note: a branch under dashboard/<person>/ that is not a batch's stamp is ignored, and so is a deeper one (edge)", () => {
  const w = world();
  const clone = cloneWith(w);
  for (const name of ["dashboard/test-person/notes", "dashboard/test-person/x/20261103T100000Z"]) {
    git(clone, "switch", "-q", "-c", name, "origin/main");
    commit(clone, `on ${name}`);
  }
  // Back on the page's own batch, so only the kept one can be named.
  git(clone, "switch", "-q", OPEN);
  const found = ofCheck(checkDashboardKept(CFG, w.anchor));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0].message.includes(KEPT), found[0].message);
  for (const f of found) assert.ok(!/notes|\/x\//.test(f.message), f.message);
});

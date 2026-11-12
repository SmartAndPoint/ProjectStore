// projectstore — tests/precommit.test.mjs: a session's vault pre-commit check
// (PS-WT, "Before a commit, a session learns which vault files carry another
// writer's uncommitted edits, from a record of its own writes, and is told to
// stop"; the spec "A session's vault pre-commit check: its own writes traced
// from HEAD, and the stop", alias precommit).
//
// Reachability and the hunks are tested as pure functions over pair sets and
// byte states; the check end to end on real fixture repositories in temp
// dirs: a separate git directory, as the real vault has; the vault inside a
// project repository; no commit; an open merge; no repository; line-ending
// conversion; a worktree the record names. Contract 12 is observed after the
// release and is not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
  utimesSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sourceHarness } from "../scripts/harness.mjs";
import { readConfigAt, vaultLocation, loadTemplate, renderTemplate } from "../scripts/lib.mjs";
import { run } from "../scripts/cli.mjs";
import { snapshotForCall, recordForCall, recordDir, hashOf } from "../scripts/write-record.mjs";
import {
  closure,
  judgeStates,
  gapHunks,
  lineDiff,
  runPrecommit,
  defaultGit,
  LAST,
  HUNK_LINES,
} from "../scripts/precommit.mjs";
import { TOOLS } from "../scripts/mcp.mjs";
import { gitVault, git, addWorktree } from "./fixtures/git-vault.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { hookEnv, toolWrite } from "./fixtures/hooks.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "projectstore.mjs");
const SRC = sourceHarness();
const SID_ENV = SRC.runtime.session_id_env;

// ─── Pure: reachability and the hunks (contracts 1, 3, 5's prose) ──────

const B = (s) => Buffer.from(s, "utf8");
const h = (s) => (s === null ? null : hashOf(B(s)));
const pairsOf = (...steps) => steps.map(([a, b]) => ({ before: h(a), after: h(b) }));
const contentOf = (...texts) => {
  const m = new Map(texts.map((t) => [h(t), B(t)]));
  return (x) => (x === null ? Buffer.alloc(0) : m.get(x));
};

// [precommit#1]
test("judge: a line edited from X to Y, then from Y to Z, is the session's own though no single write changed X to Z (edge)", () => {
  const j = judgeStates([h("X\n")], pairsOf(["X\n", "Y\n"], ["Y\n", "Z\n"]), h("Z\n"));
  assert.equal(j.own, true);
  assert.deepEqual(j.gaps, []);
});

// [precommit#1]
test("judge: another writer's edit between two of the session's writes is its one hunk, in a recorded state", () => {
  const H = "a\nb\nc\n";
  const A = "a\nb\nc\nmine\n";
  const A2 = "a\nTHEIRS\nb\nc\nmine\n";
  const W = "a\nTHEIRS\nb\nc\nmine\nmine again\n";
  const j = judgeStates([h(H)], pairsOf([H, A], [A2, W]), h(W));
  assert.equal(j.own, false);
  assert.equal(j.gaps.length, 1);
  const { hunks, notKept } = gapHunks(j.gaps[0], contentOf(H, A, A2, W));
  assert.equal(notKept, false);
  assert.deepEqual(hunks, [{ range: "2", in: "recorded", lines: ["+ THEIRS"], more: 0 }]);
});

// [precommit#1]
test("judge: one line added under the session's edit stays foreign through 50 more writes, and is the one hunk (edge)", () => {
  const H = "title\n";
  const A1 = "title\nmine\n";
  const A1x = "title\nmine\ntheirs\n";
  const steps = [[H, A1]];
  let prev = A1x;
  for (let i = 0; i < 50; i++) {
    const next = `${prev}w${i}\n`;
    steps.push([prev, next]);
    prev = next;
  }
  const texts = [...new Set(steps.flat())];
  const j = judgeStates([h(H)], pairsOf(...steps), h(prev));
  assert.equal(j.own, false);
  assert.equal(j.gaps.length, 1);
  assert.deepEqual(gapHunks(j.gaps[0], contentOf(...texts)).hunks, [
    { range: "3", in: "recorded", lines: ["+ theirs"], more: 0 },
  ]);
});

// [precommit#1]
test("judge: after another writer commits the whole file, only the write after that commit leads from HEAD, and the file is its own (edge)", () => {
  const H0 = "a\n";
  const A = "a\nmine\n";
  const H1 = "a\nmine\ntheirs\n"; // the other writer's whole-file commit is HEAD now
  const W = "a\nmine\ntheirs\nmine again\n";
  const j = judgeStates([h(H1)], pairsOf([H0, A], [H1, W]), h(W));
  assert.equal(j.own, true);
  assert.equal(closure([h(H1)], pairsOf([H0, A], [H1, W])).has(h(A)), false, "the earlier write counts for nothing");
});

// [precommit#1]
test("judge: two writes recorded in the opposite order to the writes still make the file its own (edge)", () => {
  const steps = [
    ["X\n", "Y\n"],
    ["Y\n", "Z\n"],
  ].reverse();
  assert.equal(judgeStates([h("X\n")], pairsOf(...steps), h("Z\n")).own, true);
});

// [precommit#1]
test("judge: an edit undone and then another writer's different edit — the walk ends, and the file is not its own (edge)", () => {
  const H = "a\n";
  const j = judgeStates([h(H)], pairsOf([H, "b\n"], ["b\n", H]), h("c\n"));
  assert.equal(j.own, false);
  assert.equal(j.gaps[0].in, "file");
  assert.equal(j.gaps[0].state, h("c\n"));
});

test("lineDiff: the fewest differing lines, ranged in the second text, at most HUNK_LINES lines a hunk", () => {
  const d = lineDiff(["a", "b", "c"], ["a", "x", "c", "d"]);
  assert.equal(d.distance, 3);
  assert.deepEqual(
    d.hunks.map((x) => [x.start, x.count, x.lines]),
    [
      [2, 1, ["- b", "+ x"]],
      [4, 1, ["+ d"]],
    ],
  );
  const many = Array.from({ length: 15 }, (_, i) => `l${i}`);
  const j = { state: h(many.join("\n")), in: "file", against: [null] };
  const g = gapHunks(j, (x) => (x === null ? Buffer.alloc(0) : B(many.join("\n"))));
  assert.equal(g.hunks[0].lines.length, HUNK_LINES);
  assert.equal(g.hunks[0].more, 15 + 1 - HUNK_LINES, "the rest is counted (the empty side's one line included)");
});

// ─── End to end: fixture repositories ──────────────────────────────────

const INDEX = (rows) =>
  `# ADRs\n\nPlain prose above the table.\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n${rows}`;

// A vault that is its own repository with its git directory elsewhere, as the
// real vault is; a bound project beside it. Seeded and committed: a story, an
// ADR and its folder index, a spec, a board.
function fixture({ separate = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ps-pc-"));
  const vault = gitVault(join(root, "vault"), { separateGitDir: separate ? join(root, "vault.git") : null });
  mkdirSync(join(vault, ".projectstore"), { recursive: true });
  writeFileSync(join(vault, ".projectstore", ".gitignore"), "sessions/\n");
  for (const d of ["adr", "specs"]) mkdirSync(join(vault, d), { recursive: true });
  writeFileSync(join(vault, "adr", "x.md"), "---\ntype: adr\ntitle: X\nstatus: accepted\n---\n\n# X\n\nbody\n");
  writeFileSync(join(vault, "adr", "README.md"), INDEX("| [x](./x.md) | X | accepted | 2026-11-01 |\n"));
  writeFileSync(join(vault, "specs", "y.md"), "---\ntype: spec\ntitle: Y\n---\n\n# Y\n\nbody\n");
  writeFileSync(join(vault, "kanban.md"), "# Board\n");
  writeFileSync(
    join(vault, "epics", "README.md"),
    "# Epics\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n| [PS-A](./PS-A/epic.md) | Epic A | planned | |\n",
  );
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", "fixture");
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  return { root, vault, proj, story: join(vault, "epics", "PS-A", "stories", "story-a.md") };
}

let CALL = 0;
// A write the hook saw: the snapshot, the write, the event, in process.
function recorded(f, sid, abs, write) {
  const loc = vaultLocation(abs, f.vault);
  const callId = `call-${++CALL}`;
  snapshotForCall(f.proj, sid, { callId, root: loc.root, rel: loc.rel, abs });
  write();
  recordForCall(f.proj, sid, { callId, root: loc.root, rel: loc.rel, abs, tool: "Edit" });
}
const append = (abs, text) => () => writeFileSync(abs, readFileSync(abs, "utf8") + text);
const prepend = (abs, text) => () => writeFileSync(abs, text + readFileSync(abs, "utf8"));
const edit = (f, sid, rel, text) => recorded(f, sid, join(f.vault, rel), append(join(f.vault, rel), text));

// Another live session's registration in the vault, with its activity.
function peer(f, id, entries, { minutesAgo = 0, host = "peer-host" } = {}) {
  const dir = join(f.vault, ".projectstore", "sessions");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      id,
      host,
      project_root: f.proj,
      recent_activity: entries.map(([rel, tool]) => ({ path: join(f.vault, rel), tool, at: new Date().toISOString() })),
    }),
  );
  const t = new Date(Date.now() - minutesAgo * 60000);
  utimesSync(p, t, t);
}

const check = (f, sid, opts = {}) => runPrecommit({ project: f.proj, cfg: readConfigAt(f.proj), sid, ...opts });
const fileOf = (r, rel, copy = 0) => r.result.copies[copy].files.find((x) => x.path === rel);
const bin = (f, args, env = {}) =>
  spawnSync(process.execPath, [BIN, "session", "check", ...args, "--project", f.proj], {
    encoding: "utf8",
    env: hookEnv(f.proj, env),
    cwd: f.proj,
    timeout: 60000,
  });

// [precommit#2]
test("check: a file the session created with Write is its own, and the check exits 0", () => {
  const f = fixture();
  const abs = join(f.vault, "adr", "new.md");
  recorded(f, "s1", abs, () => writeFileSync(abs, "new\n"));
  const r = check(f, "s1", { paths: ["adr/new.md"] });
  assert.equal(fileOf(r, "adr/new.md").verdict, "own");
  assert.equal(r.exit, 0);
});

// [precommit#2]
test("check: an untracked file another session created is not the session's own (failure)", () => {
  const f = fixture();
  writeFileSync(join(f.vault, "specs", "theirs.md"), "theirs\n");
  const r = check(f, "s1");
  assert.equal(fileOf(r, "specs/theirs.md").verdict, "unattributed");
  assert.deepEqual(fileOf(r, "specs/theirs.md").reasons, ["unreached", "no-record"]);
  assert.equal(r.exit, 1);
});

// [precommit#2]
test("check: a vault file deleted by a shell rm is not the session's own (edge)", () => {
  const f = fixture();
  rmSync(join(f.vault, "specs", "y.md"));
  const r = check(f, "s1");
  assert.notEqual(fileOf(r, "specs/y.md").verdict, "own");
});

// [precommit#2]
test("check: both ends of a git mv are not the session's own (edge)", () => {
  const f = fixture();
  git(f.vault, "mv", "specs/y.md", "specs/z.md");
  const r = check(f, "s1");
  assert.equal(fileOf(r, "specs/y.md").verdict, "unattributed");
  assert.equal(fileOf(r, "specs/z.md").verdict, "unattributed");
  assert.ok(fileOf(r, "specs/y.md").staged && fileOf(r, "specs/z.md").staged);
});

// [precommit#3]
test("check: a path the session never wrote, staged in the index, is not its own, and the reasons name the staged content (failure)", () => {
  const f = fixture();
  append(join(f.vault, "specs", "y.md"), "staged by another\n")();
  git(f.vault, "add", "specs/y.md");
  const y = fileOf(check(f, "s1"), "specs/y.md");
  assert.equal(y.verdict, "unattributed");
  assert.ok(y.staged);
  assert.ok(y.reasons.includes("staged"));
});

// [precommit#3]
test("check: the session staged its file and then edited it again, both writes recorded — its own (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "one\n");
  git(f.vault, "add", "adr/x.md");
  edit(f, "s1", "adr/x.md", "two\n");
  const x = fileOf(check(f, "s1"), "adr/x.md");
  assert.equal(x.verdict, "own");
  assert.ok(x.staged);
});

// [precommit#3]
test("check: another writer staged a change and restored the working tree — listed, not own, by its staged content (edge)", () => {
  const f = fixture();
  const y = join(f.vault, "specs", "y.md");
  const orig = readFileSync(y, "utf8");
  writeFileSync(y, orig + "staged\n");
  git(f.vault, "add", "specs/y.md");
  writeFileSync(y, orig);
  const r = fileOf(check(f, "s1"), "specs/y.md");
  assert.ok(r, "listed though its working tree equals HEAD");
  assert.notEqual(r.verdict, "own");
  assert.ok(r.reasons.includes("staged") && !r.reasons.includes("unreached"), JSON.stringify(r.reasons));
});

// [precommit#4]
test("check: a file a live session B edited is another-writer, naming B's short id, host and last activity", () => {
  const f = fixture();
  append(join(f.vault, "specs", "y.md"), "B's edit\n")();
  peer(f, "bbbbbbbb-1234-5678", [["specs/y.md", "Edit"]]);
  const y = fileOf(check(f, "s1"), "specs/y.md");
  assert.equal(y.verdict, "another-writer");
  assert.equal(y.claimed_by.length, 1);
  assert.equal(y.claimed_by[0].session, "bbbbbbbb");
  assert.equal(y.claimed_by[0].host, "peer-host");
  assert.ok(!Number.isNaN(Date.parse(y.claimed_by[0].last_active)));
});

// [precommit#4]
test("check: a file edited in an editor with no session open is unattributed (edge)", () => {
  const f = fixture();
  append(join(f.vault, "specs", "y.md"), "from Obsidian\n")();
  assert.equal(fileOf(check(f, "s1"), "specs/y.md").verdict, "unattributed");
});

// [precommit#4]
test("check: a live session that only read the file, or read it after editing it, does not claim it (edge)", () => {
  const f = fixture();
  append(join(f.vault, "specs", "y.md"), "?\n")();
  // The activity list keeps one entry per path, the latest: a Read after an Edit leaves the Read.
  peer(f, "reader01", [["specs/y.md", "Read"]]);
  assert.equal(fileOf(check(f, "s1"), "specs/y.md").verdict, "unattributed");
});

// [precommit#4]
test("check: a session last active 40 minutes ago does not claim the file (edge)", () => {
  const f = fixture();
  append(join(f.vault, "specs", "y.md"), "old\n")();
  peer(f, "idle0001", [["specs/y.md", "Edit"]], { minutesAgo: 40 });
  assert.equal(fileOf(check(f, "s1"), "specs/y.md").verdict, "unattributed");
});

// [precommit#4]
test("check: a forked session checking a file its live parent edited names the parent (edge)", () => {
  const f = fixture();
  edit(f, "parent01-aaaa", "adr/x.md", "the parent's edit\n");
  peer(f, "parent01-aaaa", [["adr/x.md", "Edit"]]);
  const x = fileOf(check(f, "fork0001"), "adr/x.md");
  assert.equal(x.verdict, "another-writer");
  assert.equal(x.claimed_by[0].session, "parent01");
  assert.ok(x.reasons.includes("no-record"), "the fork has an empty record");
});

// [precommit#5]
test("views: kanban.md rewritten while every other changed file is the session's own is consistent, exit 0", () => {
  const f = fixture();
  edit(f, "s1", "epics/PS-A/stories/story-a.md", "mine\n");
  writeFileSync(join(f.vault, "kanban.md"), "# Board\n\n- story a\n"); // reconcile, not recorded
  const r = check(f, "s1");
  const k = fileOf(r, "kanban.md");
  assert.equal(k.verdict, "consistent");
  assert.equal(k.rule, "sources");
  assert.deepEqual(k.fed_by, ["epics/PS-A/stories/story-a.md"]);
  assert.equal(r.exit, 0);
});

// [precommit#5]
test("views: kanban.md changed while another session's story is uncommitted names that story and its session", () => {
  const f = fixture();
  const theirs = join(f.vault, "epics", "PS-A", "stories", "story-b.md");
  writeFileSync(theirs, "---\ntype: story\ntitle: B\nstatus: planned\n---\n");
  peer(f, "cccccccc-0000", [["epics/PS-A/stories/story-b.md", "Write"]]);
  writeFileSync(join(f.vault, "kanban.md"), "# Board\n\n- story b\n");
  const k = fileOf(check(f, "s1"), "kanban.md");
  assert.equal(k.verdict, "another-writer");
  assert.deepEqual(k.fed_by, ["epics/PS-A/stories/story-b.md"]);
  assert.equal(k.claimed_by[0].session, "cccccccc");
});

// [precommit#5]
test("views: another writer's ADR makes adr/README.md not consistent, naming it, while epics/README.md is consistent (edge)", () => {
  const f = fixture();
  append(join(f.vault, "adr", "x.md"), "theirs\n")();
  edit(f, "s1", "epics/PS-A/epic.md", "mine\n");
  append(join(f.vault, "adr", "README.md"), "| [z](./z.md) | Z | proposed | 2026-11-02 |\n")();
  append(join(f.vault, "epics", "README.md"), "| [PS-B](./PS-B/epic.md) | B | planned | |\n")();
  const r = check(f, "s1");
  const adr = fileOf(r, "adr/README.md");
  assert.equal(adr.verdict, "unattributed");
  assert.deepEqual(adr.fed_by, ["adr/x.md"]);
  assert.equal(fileOf(r, "epics/README.md").verdict, "consistent");
});

// [precommit#5]
test("views: another writer's edit to the prose above adr/README.md's table, with no foreign ADR, is not the session's own (edge)", () => {
  const f = fixture();
  const readme = join(f.vault, "adr", "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replace("Plain prose", "Edited prose"));
  const adr = fileOf(check(f, "s1"), "adr/README.md");
  assert.notEqual(adr.verdict, "consistent");
  assert.ok(adr.reasons.includes("unreached"));
  // The session's own prose edit, recorded, with rows the reconcile wrote after it: consistent.
  const g = fixture();
  const own = join(g.vault, "adr", "README.md");
  recorded(g, "s1", own, () => writeFileSync(own, readFileSync(own, "utf8").replace("Plain prose", "My prose")));
  append(own, "| [w](./w.md) | W | proposed | 2026-11-03 |\n")();
  assert.equal(fileOf(check(g, "s1"), "adr/README.md").verdict, "consistent");
});

// [precommit#5]
test("views: a folder-shape story's README.md is an artifact, judged by contract 1 (edge)", () => {
  const f = fixture();
  const abs = join(f.vault, "epics", "PS-A", "stories", "story-c", "README.md");
  mkdirSync(dirname(abs), { recursive: true });
  recorded(f, "s1", abs, () => writeFileSync(abs, "---\ntype: story\n---\n"));
  const c = fileOf(check(f, "s1"), "epics/PS-A/stories/story-c/README.md");
  assert.equal(c.verdict, "own");
  assert.equal(c.rule, undefined);
});

// Every file under `dir` (the separate git directory's index too), by hash.
function hashes(dir, extra = []) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  for (const p of extra) out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
  return out;
}

// [precommit#6]
test("check: two runs over another writer's edits and a touched-but-unchanged tracked file leave the tree, the index and the record byte for byte (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  append(join(f.vault, "specs", "y.md"), "theirs\n")();
  const touched = new Date(Date.now() + 5000);
  utimesSync(join(f.vault, "README.md"), touched, touched);
  const index = resolve(f.vault, git(f.vault, "rev-parse", "--git-path", "index"));
  const before = hashes(f.vault, [index]);
  const record = hashes(recordDir(f.proj, "s1"));
  const indexStat = statSync(index).mtimeMs;
  assert.equal(check(f, "s1").exit, 1);
  assert.equal(bin(f, ["--session", "s1"]).status, 1);
  assert.deepEqual(hashes(f.vault, [index]), before);
  assert.equal(statSync(index).mtimeMs, indexStat, "git status did not refresh the index");
  assert.deepEqual(hashes(recordDir(f.proj, "s1")), record, "the record holds the same files with the same bytes");
});

// [precommit#7]
test("check: a vault folder not in a git repository says so, checks nothing and exits 0 (edge)", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-pc-nogit-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "a\n");
  const proj = join(root, "proj");
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const f = { vault, proj };
  const r = check(f, "s1");
  assert.equal(r.result.copies[0].git, "no-git");
  assert.deepEqual(r.result.copies[0].files, []);
  assert.equal(r.exit, 0);
  assert.match(r.text, /not in a git repository; nothing checked/);
  assert.equal(r.last, LAST.noGit, "the last line says nothing was checked");
  assert.doesNotMatch(r.last, /Nothing to commit/);
});

// [precommit#7]
test("check: a vault inside the project's repository lists only its own changed files, by vault-relative path (edge)", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-pc-sub-"));
  const proj = join(root, "proj");
  const vault = join(proj, "vault");
  mkdirSync(join(vault, "adr"), { recursive: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(vault, "adr", "x.md"), "x\n");
  writeFileSync(join(proj, "src", "a.mjs"), "a\n");
  git(proj, "init", "-q");
  git(proj, "add", "-A");
  git(proj, "commit", "-qm", "seed");
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  writeFileSync(join(proj, "src", "a.mjs"), "b\n");
  const f = { vault, proj };
  edit(f, "s1", "adr/x.md", "mine\n");
  const r = check(f, "s1");
  assert.deepEqual(
    r.result.copies[0].files.map((x) => [x.path, x.verdict]),
    [["adr/x.md", "own"]],
  );
});

// [precommit#7]
test("check: in a repository with no commit yet, each file is judged as created (edge)", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-pc-empty-"));
  const vault = gitVault(join(root, "vault"), { seed: false });
  // gitVault commits its README; start over with no commit at all.
  rmSync(join(vault, ".git"), { recursive: true, force: true });
  git(vault, "init", "-q");
  const proj = join(root, "proj");
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const f = { vault, proj };
  mkdirSync(join(vault, "adr"), { recursive: true });
  const mine = join(vault, "adr", "mine.md");
  recorded(f, "s1", mine, () => writeFileSync(mine, "mine\n"));
  const r = check(f, "s1");
  assert.equal(r.result.copies[0].git, "ok");
  assert.equal(fileOf(r, "adr/mine.md").verdict, "own", "created from absent content");
  assert.equal(fileOf(r, "README.md").verdict, "unattributed", "a file nobody recorded");
});

// [precommit#7]
test("check: under core.autocrlf=true an LF file committed before the setting, and a file checked out with CRLF, edited by the session, are its own; without --filters the second is not (edge)", () => {
  const f = fixture();
  git(f.vault, "config", "core.autocrlf", "true");
  // Checked out again under the setting: CRLF in the working tree, LF in the blob.
  rmSync(join(f.vault, "specs", "y.md"));
  git(f.vault, "checkout", "--", "specs/y.md");
  assert.match(readFileSync(join(f.vault, "specs", "y.md"), "utf8"), /\r\n/, "the checkout converted it");
  edit(f, "s1", "adr/x.md", "mine\n");
  const y = join(f.vault, "specs", "y.md");
  recorded(f, "s1", y, () => writeFileSync(y, readFileSync(y, "utf8") + "mine\r\n"));
  const r = check(f, "s1");
  assert.equal(fileOf(r, "adr/x.md").verdict, "own");
  assert.equal(fileOf(r, "specs/y.md").verdict, "own");
  const real = defaultGit();
  const dropFilters = (root, args) =>
    args[0] === "cat-file" && args[1] === "--filters" ? real(root, ["cat-file", "blob", args[2]]) : real(root, args);
  assert.notEqual(fileOf(check(f, "s1", { git: dropFilters }), "specs/y.md").verdict, "own");
});

// [precommit#7]
test("check: an open merge in the vault's repository is said, and exits 1 (failure)", () => {
  const f = fixture();
  git(f.vault, "checkout", "-q", "-b", "other");
  writeFileSync(join(f.vault, "specs", "o.md"), "o\n");
  git(f.vault, "add", "-A");
  git(f.vault, "commit", "-qm", "other");
  git(f.vault, "checkout", "-q", "main");
  git(f.vault, "merge", "--no-commit", "--no-ff", "-q", "other");
  const r = check(f, "s1");
  assert.equal(r.result.copies[0].git, "merge-open");
  assert.equal(r.exit, 1);
  assert.match(r.text, /a merge is open in its repository; a commit now would conclude it/);
  assert.equal(r.last, LAST.stop);
});

// [precommit#7]
test("check: a git read that times out cannot tell, lists no file as the session's own, and exits 1 (failure)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const real = defaultGit();
  const slow = (root, args) =>
    args[0] === "cat-file" ? { kind: "failure", reason: "git cat-file timed out" } : real(root, args);
  const r = check(f, "s1", { git: slow });
  assert.equal(r.result.copies[0].git, "unknown");
  assert.match(r.result.copies[0].reason, /timed out/);
  assert.ok(!r.result.copies[0].files.some((x) => x.verdict === "own"));
  assert.equal(r.exit, 1);
  assert.match(r.text, /cannot tell: git cat-file timed out/);
});

// [precommit#8]
test("check: on Codex it says no session id from the host, lists every changed file as unattributed, and exits 1 (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const r = bin(f, ["--json"], { PROJECTSTORE_HARNESS: "codex", [SID_ENV]: "s1" });
  assert.equal(r.status, 1, r.stderr);
  const files = JSON.parse(r.stdout).result.copies[0].files;
  assert.deepEqual(
    files.map((x) => [x.path, x.verdict, x.reasons.includes("no-session")]),
    [["adr/x.md", "unattributed", true]],
  );
  const text = bin(f, [], { PROJECTSTORE_HARNESS: "codex" });
  assert.match(text.stdout, /^No session id from the host/);
});

// [precommit#8]
test("check: with a path, only that path is judged while another writer's unstaged file is left out, and the exit is that path's (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  append(join(f.vault, "specs", "y.md"), "theirs\n")();
  const r = check(f, "s1", { paths: ["adr/x.md"] });
  assert.deepEqual(
    r.result.copies[0].files.map((x) => x.path),
    ["adr/x.md"],
  );
  assert.equal(r.exit, 0);
});

// [precommit#8]
test("check: with a path, another writer's staged file is listed and judged too (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  append(join(f.vault, "specs", "y.md"), "theirs\n")();
  git(f.vault, "add", "specs/y.md");
  const r = check(f, "s1", { paths: ["adr/x.md"] });
  assert.deepEqual(
    r.result.copies[0].files.map((x) => [x.path, x.verdict]),
    [
      ["adr/x.md", "own"],
      ["specs/y.md", "unattributed"],
    ],
  );
  assert.equal(r.exit, 1);
});

// [precommit#8]
test("check: a worktree the session's record names is checked beside the bound vault, each under a line naming it (edge)", () => {
  const f = fixture();
  const wt = addWorktree(f.vault, join(f.root, "wt"), "side");
  edit(f, "s1", "adr/x.md", "mine in the vault\n");
  const ws = join(wt, "specs", "y.md");
  recorded(f, "s1", ws, append(ws, "mine in the worktree\n"));
  const r = check(f, "s1");
  assert.equal(r.result.copies.length, 2);
  assert.deepEqual(
    r.result.copies.map((c) => c.files.map((x) => [x.path, x.verdict])),
    [[["adr/x.md", "own"]], [["specs/y.md", "own"]]],
  );
  assert.match(r.text, /\(the bound vault\): 1 changed/);
  assert.match(r.text, /\(a worktree of the vault\): 1 changed/);
});

// [precommit#8]
test("check: --session naming an id with no record lists every changed file as unattributed, says so, and exits 1 (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const r = bin(f, ["--session", "nobody00"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Session nobody00 has no record of vault writes/);
  assert.match(r.stdout, /unattributed\s+adr\/x\.md/);
});

// [precommit#9]
test("output: the only changed vault file is the session's own — listed as own, exit 0, in the envelope", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const r = bin(f, ["--json", "--session", "s1"]);
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.equal(env.verb, "session check");
  assert.deepEqual(Object.keys(env.result).sort(), ["copies", "session"]);
  const c = env.result.copies[0];
  assert.deepEqual(Object.keys(c).sort(), ["checked", "files", "foreign", "git", "root"]);
  assert.deepEqual(c.files, [
    { path: "adr/x.md", verdict: "own", staged: false, claimed_by: [], hunks: [], reasons: [] },
  ]);
});

// [precommit#9]
test("output: a file carrying another writer's edits exits 1, and its line names the writer and the first hunk", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  prepend(join(f.vault, "adr", "x.md"), "theirs\n")();
  peer(f, "dddddddd-9", [["adr/x.md", "Edit"]]);
  const r = bin(f, ["--session", "s1"]);
  assert.equal(r.status, 1);
  assert.match(
    r.stdout,
    /another-writer\s+adr\/x\.md — session dddddddd on peer-host, active [^;]+; first hunk at line 1 in the file now: \+ theirs/,
  );
  assert.equal(r.stdout.trim().split("\n").pop(), LAST.foreign);
});

// [precommit#9]
test("output: a path outside every copy of the vault exits 2 and names the path (failure)", () => {
  const f = fixture();
  const r = bin(f, ["../elsewhere.md", "--session", "s1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\.\.\/elsewhere\.md is not inside the bound vault/);
});

// [precommit#9]
test("output: a 600 KiB file whose content the record did not keep, not the session's own, gives content-not-kept and no lines (edge)", () => {
  const f = fixture();
  const big = join(f.vault, "specs", "big.md");
  writeFileSync(big, "x\n".repeat(300 * 1024));
  git(f.vault, "add", "specs/big.md");
  git(f.vault, "commit", "-qm", "big");
  recorded(f, "s1", big, append(big, "mine\n"));
  prepend(big, "theirs\n")();
  const b = fileOf(check(f, "s1"), "specs/big.md");
  assert.notEqual(b.verdict, "own");
  assert.ok(b.reasons.includes("content-not-kept"), JSON.stringify(b.reasons));
  assert.ok(b.hunks.length > 0 && b.hunks.every((x) => x.lines.length === 0 && x.range === null));
});

// ─── The stop (contract 10) ────────────────────────────────────────────

function fireRules(f, env) {
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "session-rules.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "r1", source: "startup", cwd: f.proj }),
    env,
    cwd: f.proj,
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

// [precommit#10]
test("rules: on Claude Code the session-start rules name /projectstore:precommit and the stop, in at most 2,000 characters", () => {
  const f = fixture();
  const ctx = fireRules(f, hookEnv(f.proj));
  assert.ok(ctx.length <= 2000, `${ctx.length} characters`);
  const flat = ctx.replace(/\s+/g, " ");
  assert.match(
    flat,
    /Before you commit vault files, run `\/projectstore:precommit`\*\* and do what its last line says/,
  );
  assert.match(flat, /not yours to commit/);
});

// [precommit#10]
test("rules: on Codex they carry no third paragraph (edge)", () => {
  const f = fixture();
  const ctx = fireRules(f, hookEnv(f.proj, { PROJECTSTORE_HARNESS: "codex" }));
  assert.ok(ctx, "the rules are emitted");
  assert.doesNotMatch(ctx, /precommit|Before you commit/);
});

// [precommit#10]
test("rules: under auto_inject false the rules hook prints nothing (edge)", () => {
  const f = fixture();
  writeBinding(f.proj, { vault_path: f.vault, layout: "engineering", language: "en", auto_inject: false });
  assert.equal(fireRules(f, hookEnv(f.proj)), null);
});

// [precommit#10]
test("last line: exit 0 says to commit now, naming the paths (edge)", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const r = bin(f, ["--session", "s1"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").pop(), LAST.commit);
  assert.match(LAST.commit, /^Commit now, naming the paths/);
});

// [precommit#10]
test("last line: exit 1 with merge-open or unknown says do not commit; tell the person (failure)", () => {
  const f = fixture();
  const real = defaultGit();
  const broken = (root, args) =>
    args[0] === "status" ? { kind: "failure", reason: "git status timed out" } : real(root, args);
  const r = check(f, "s1", { git: broken });
  assert.equal(r.exit, 1);
  assert.equal(r.text.trim().split("\n").pop(), "Do not commit; tell the person.");
});

// [precommit#10]
test("last line: exit 1 on Codex says the host gives no session id and to ask the person (edge)", () => {
  const f = fixture();
  append(join(f.vault, "adr", "x.md"), "x\n")();
  const r = bin(f, [], { PROJECTSTORE_HARNESS: "codex" });
  assert.equal(r.status, 1);
  const last = r.stdout.trim().split("\n").pop();
  assert.equal(last, LAST.noSession);
  assert.match(last, /host gives no session id[\s\S]*ask the person/);
});

// ─── The hints and the command (contract 11) ──────────────────────────

const HINTS = [
  ["adr", /8\. \*\*Final message\*\*[^\n]*/],
  ["review", /10\. \*\*Final print\*\*[^\n]*/],
  ["story", /6f\. \*\*\(close only\) The commit hint\.\*\*[\s\S]*?last line says\./],
];

// [precommit#11]
test("hints: the adr, review and story commit hints name /projectstore:precommit and say to do what its last line says", () => {
  for (const [name, re] of HINTS) {
    const hint = readFileSync(join(REPO, "commands", `${name}.md`), "utf8").match(re)?.[0];
    assert.ok(hint, `${name}.md has its commit hint`);
    const flat = hint.replace(/\s+/g, " ");
    assert.match(
      flat,
      /run `\/projectstore:precommit` before you commit those paths, and do what its last line says/,
      name,
    );
  }
  assert.ok(existsSync(join(REPO, "commands", "precommit.md")));
  assert.match(readFileSync(join(REPO, "commands", "precommit.md"), "utf8"), /bin\/projectstore\.mjs" session check/);
});

// [precommit#11]
test("hints: the Codex adapter's adr, review and story skills carry the same hints naming $projectstore-precommit, and its precommit skill exists (edge)", () => {
  const skill = (n) => readFileSync(join(REPO, "adapters", "codex", "skills", `projectstore-${n}`, "SKILL.md"), "utf8");
  for (const [name] of HINTS) {
    const flat = skill(name).replace(/\s+/g, " ");
    assert.match(
      flat,
      /run `\$projectstore-precommit` before you commit those paths, and do what its last line says/,
      name,
    );
  }
  assert.match(skill("precommit"), /^---\nname: projectstore-precommit\n/);
  assert.match(skill("precommit"), /projectstore\.mjs" session check/);
});

// [precommit#11]
test("hints: no command, skill or agent file in the package, or in the Codex adapter, tells the agent to commit, push, pull, fetch or clone with git (edge)", () => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) files.push(p);
    }
  };
  for (const d of ["commands", "skills", "agents", join("adapters", "codex", "skills")]) walk(join(REPO, d));
  assert.ok(files.length > 40, `${files.length} files read`);
  const told = files.filter((p) => /\bgit\s+(?:commit|push|pull|fetch|clone)\b/.test(readFileSync(p, "utf8")));
  assert.deepEqual(told, []);
});

// [precommit#11]
test("hints: the MCP server's tools are the same nine as before (edge)", () => {
  const before = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "mcp-tools-0.30.15.json"), "utf8"));
  assert.deepEqual(Object.keys(TOOLS).sort(), before.map((t) => t.name).sort());
  assert.equal(Object.keys(TOOLS).length, 9);
});

// The hook path and the check together, as a session runs them (story AC 1 and 2).
// [precommit#1] [precommit#9]
test("check: session A edits a file, session B edits another part of it; both checks name it and exit 1, and the tree and index are unchanged", () => {
  const f = fixture();
  const story = f.story;
  toolWrite(f.proj, { sid: "sessA", file: story, callId: "a1", write: append(story, "A's line\n") });
  toolWrite(f.proj, { sid: "sessB", file: story, callId: "b1", write: prepend(story, "B's line\n") });
  peer(f, "sessA", [["epics/PS-A/stories/story-a.md", "Edit"]]);
  peer(f, "sessB", [["epics/PS-A/stories/story-a.md", "Edit"]]);
  const index = resolve(f.vault, git(f.vault, "rev-parse", "--git-path", "index"));
  const before = hashes(f.vault, [index]);
  const a = check(f, "sessA");
  const b = check(f, "sessB");
  assert.equal(a.exit, 1);
  assert.equal(b.exit, 1);
  assert.equal(fileOf(a, "epics/PS-A/stories/story-a.md").claimed_by[0].session, "sessB");
  assert.equal(fileOf(b, "epics/PS-A/stories/story-a.md").claimed_by[0].session, "sessA");
  assert.deepEqual(hashes(f.vault, [index]), before);
});

// ─── Views among views, and the writers end to end ─────────────────────

// [precommit#5]
test("views: kanban.md and epics/README.md rewritten over the session's own story and epic are both consistent, exit 0 (a judged view is no source of another)", () => {
  const f = fixture();
  edit(f, "s1", "epics/PS-A/stories/story-a.md", "mine\n");
  edit(f, "s1", "epics/PS-A/epic.md", "mine\n");
  writeFileSync(join(f.vault, "kanban.md"), "# Board\n\n- story a\n");
  append(join(f.vault, "epics", "README.md"), "| [PS-B](./PS-B/epic.md) | B | planned | |\n")();
  const r = check(f, "s1");
  assert.equal(fileOf(r, "kanban.md").verdict, "consistent");
  assert.equal(fileOf(r, "epics/README.md").verdict, "consistent");
  assert.ok(!fileOf(r, "kanban.md").fed_by.includes("epics/README.md"), "a view does not feed a view");
  assert.equal(r.exit, 0);
});

// [precommit#5]
test("views: a folder README staged and then deleted (AD) is judged without a crash", () => {
  const f = fixture();
  const readme = join(f.vault, "specs", "README.md");
  writeFileSync(readme, "# Specs\n");
  git(f.vault, "add", "specs/README.md");
  rmSync(readme);
  const r = check(f, "s1");
  assert.equal(r.result.copies[0].git, "ok");
  const x = fileOf(r, "specs/README.md");
  assert.ok(x && x.staged, "listed by its staged content");
  assert.notEqual(x.verdict, "own");
});

const VARS = { id: "story-m", title: "M", date: "2026-11-01", author: "Other", tags: "[]", epic_id: "PS-A" };
const EPIC_TABLE =
  '---\ntype: epic\nid: "PS-A"\ntitle: "Epic A"\nstatus: in-progress\ncreated: 2026-11-01\n---\n\n# PS-A: Epic A\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [m](./stories/story-m.md) | planned | the m |\n';
const sinkOf = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
const cliIn = async (f, args, env) => {
  const stdout = sinkOf();
  const stderr = sinkOf();
  const code = await run([...args, "--project", f.proj], {
    env: { ...hookEnv(f.proj, env), CI: "1" },
    cwd: f.proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  return { code, out: stdout.text, err: stderr.text };
};

// [precommit#1] [precommit#5]
test("end to end: move (a node writer) and its reconcile, then session check — every file own or consistent, exit 0", async () => {
  const f = fixture();
  writeFileSync(
    join(f.vault, "epics", "PS-A", "stories", "story-m.md"),
    renderTemplate(loadTemplate("en", "story"), VARS),
  );
  writeFileSync(join(f.vault, "epics", "PS-A", "epic.md"), EPIC_TABLE);
  git(f.vault, "add", "-A");
  git(f.vault, "commit", "-qm", "story m");
  const moved = await cliIn(f, ["move", "PS-A/story-m", "todo", "--reason", "next up", "--write", "--json"], {
    [SID_ENV]: "s1",
  });
  assert.equal(moved.code, 0, moved.err);
  const r = await cliIn(f, ["session", "check", "--json"], { [SID_ENV]: "s1" });
  const files = JSON.parse(r.out).result.copies[0].files;
  assert.equal(files.find((x) => x.path === "epics/PS-A/stories/story-m.md")?.verdict, "own");
  assert.equal(files.find((x) => x.path === "epics/PS-A/epic.md")?.verdict, "own");
  assert.ok(
    files.some((x) => x.path === "kanban.md"),
    "the reconcile rewrote the board",
  );
  assert.deepEqual(
    files.filter((x) => !["own", "consistent"].includes(x.verdict)).map((x) => x.path),
    [],
  );
  assert.equal(r.code, 0, r.out);
});

// [precommit#1]
test("end to end: the close bracket — snapshot, the clerk's cp, record — then session check says own, exit 0", async () => {
  const f = fixture();
  const scratch = join(f.root, "scratch.md");
  writeFileSync(scratch, readFileSync(f.story, "utf8").replace("planned", "done") + "\n## Final Summary\n\ndone\n");
  const env = { [SID_ENV]: "s1" };
  assert.equal((await cliIn(f, ["session", "snapshot", f.story, "--for", scratch, "--json"], env)).code, 0);
  copyFileSync(scratch, f.story);
  const rec = await cliIn(f, ["session", "record", f.story, "--from", scratch, "--json"], env);
  assert.equal(JSON.parse(rec.out).result.recorded, true);
  const r = await cliIn(f, ["session", "check", "--json"], env);
  assert.deepEqual(
    JSON.parse(r.out).result.copies[0].files.map((x) => [x.path, x.verdict]),
    [["epics/PS-A/stories/story-a.md", "own"]],
  );
  assert.equal(r.code, 0);
});

// [precommit#9]
test("output: nothing changed in the vault's repository — no file listed, exit 0, and the last line says there is nothing to commit", () => {
  const f = fixture();
  const r = check(f, "s1");
  assert.equal(r.result.copies[0].git, "ok");
  assert.deepEqual(r.result.copies[0].files, []);
  assert.equal(r.exit, 0);
  assert.equal(r.last, LAST.nothing);
  assert.equal(r.text.trim().split("\n").pop(), "Nothing to commit in the vault.");
});

// [precommit#5]
test("views: a folder README whose prose another writer edited, with no foreign artifact in that folder, is not consistent", () => {
  const f = fixture();
  edit(f, "s1", "adr/x.md", "mine\n");
  const readme = join(f.vault, "adr", "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replace("# ADRs", "# ADRs\n\nA line another writer added."));
  const r = check(f, "s1");
  assert.equal(fileOf(r, "adr/x.md").verdict, "own", "the folder's only changed artifact is the session's");
  const v = fileOf(r, "adr/README.md");
  assert.equal(v.rule, "sources");
  assert.notEqual(v.verdict, "consistent");
  assert.ok(v.reasons.includes("unreached"));
  assert.equal(r.exit, 1);
});

// [precommit#1]
test("judge: with several gaps, the gaps that lead to the file as it is now come first", () => {
  const H0 = "old\n"; // HEAD before another writer's commit
  const H1 = "head now\n";
  const A = "old\nmine\n"; // a stale write, before that commit
  const X = "head now\ntheirs\n"; // another writer's state the session then wrote over
  const W = "head now\ntheirs\nmine\n";
  const j = judgeStates([h(H1)], pairsOf([H0, A], [X, W]), h(W));
  assert.equal(j.own, false);
  assert.deepEqual(
    j.gaps.map((g) => [g.state, g.leads]),
    [
      [h(X), true],
      [h(H0), false],
    ],
    "the gap that leads to the file now is first, though its pair was listed second",
  );
});

// [precommit#3]
test("check: a path foreign only in its staged content gives no hunks, and its reasons include staged", () => {
  const f = fixture();
  const y = join(f.vault, "specs", "y.md");
  const orig = readFileSync(y, "utf8");
  writeFileSync(y, orig + "staged by another\n");
  git(f.vault, "add", "specs/y.md");
  writeFileSync(y, orig);
  const r = fileOf(check(f, "s1"), "specs/y.md");
  assert.ok(r.staged);
  assert.notEqual(r.verdict, "own");
  assert.ok(r.reasons.includes("staged"));
  assert.ok(!r.reasons.includes("unreached"), "the working tree is HEAD's");
  assert.deepEqual(r.hunks, [], "no hunks");
});

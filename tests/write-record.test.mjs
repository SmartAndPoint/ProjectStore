// projectstore — tests/write-record.test.mjs: a session's record of its own
// vault writes (PS-WT, "Before a commit, a session learns which vault files
// carry another writer's uncommitted edits, from a record of its own writes,
// and is told to stop"; the spec "A session's record of its own vault writes:
// the hook, the plugin's writers and the close bracket", alias writerecord).
//
// The hook is driven with synthetic PreToolUse and PostToolUse payloads, each
// carrying a tool_use_id, in a hermetic environment passed explicitly; the
// node writers through move, configure and guide eject; the bracket through
// the CLI with a stand-in for the clerk's copy. Fixtures and temp dirs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  utimesSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadHarnesses, sourceHarness } from "../scripts/harness.mjs";
import { cleanupStaleSessionState, stateDir, readSessionState } from "../scripts/lib.mjs";
import {
  readEvents,
  recordDir,
  hashOf,
  readBlob,
  storeBlob,
  RECORD_FILE_CAP,
  RECORD_TOTAL_CAP,
} from "../scripts/write-record.mjs";
import { run } from "../scripts/cli.mjs";
import { runConfigure } from "../scripts/configure.mjs";
import { gitVault, addWorktree, writeStory } from "./fixtures/git-vault.mjs";
import { writeBinding, makeVaultProject } from "./fixtures/vault.mjs";
import { hookEnv, payload, fireTouch, fireTouchAsync, toolWrite } from "./fixtures/hooks.mjs";
import { loadTemplate, renderTemplate, parseFrontmatter } from "../scripts/lib.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = sourceHarness();
const SID_ENV = SRC.runtime.session_id_env;

function seed() {
  const root = mkdtempSync(join(tmpdir(), "ps-wr-"));
  const vault = join(root, "vault");
  const proj = join(root, "proj");
  mkdirSync(join(vault, "epics", "PS-A", "stories"), { recursive: true });
  writeStory(vault);
  writeFileSync(join(vault, "epics", "PS-A", "epic.md"), '---\ntype: epic\ntitle: "A"\n---\n\n# A\n');
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  return { root, vault, proj, story: join(vault, "epics", "PS-A", "stories", "story-a.md") };
}

const append = (file, text) => () => writeFileSync(file, readFileSync(file, "utf8") + text);
const events = (proj, sid) => readEvents(proj, sid);
const sha = (s) => hashOf(Buffer.from(s, "utf8"));

const sink = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
async function cli(proj, args, env) {
  const stdout = sink();
  const stderr = sink();
  const code = await run([...args, "--project", proj], {
    env: { ...env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  return { code, out: stdout.text, err: stderr.text };
}
const sessionEnv = (proj, sid) => hookEnv(proj, { [SID_ENV]: sid });

// ─── The hermetic fixture ──────────────────────────────────────────────

// The record spec's acceptance: the hermetic fixture clears every session-id variable.
test("hermetic: no manifest's session_id_env reaches a test's environment", () => {
  const names = [...loadHarnesses().values()].map((m) => m.runtime?.session_id_env).filter(Boolean);
  assert.ok(names.includes(SID_ENV), `the source manifest names one: ${names.join(", ")}`);
  for (const k of names) assert.equal(process.env[k], undefined, `${k} is cleared by tests/fixtures/hermetic.mjs`);
  const src = readFileSync(join(REPO, "tests", "fixtures", "hermetic.mjs"), "utf8");
  assert.match(src, /session_id_env\) delete process\.env\[m\.runtime\.session_id_env\]/);
});

// ─── Contract 1: events, caps, the gate, a failure ─────────────────────

// [writerecord#1]
test("record: two subagents of one session writing two vault files at once leave both events, neither rewritten", async () => {
  const { proj, vault } = seed();
  const a = join(vault, "epics", "PS-A", "a.md");
  const b = join(vault, "epics", "PS-A", "b.md");
  const env = hookEnv(proj);
  await Promise.all([
    fireTouchAsync(proj, payload("PreToolUse", { sid: "s1", tool: "Write", file: a, callId: "ca", agent: "x" }), {
      env,
    }),
    fireTouchAsync(proj, payload("PreToolUse", { sid: "s1", tool: "Write", file: b, callId: "cb", agent: "y" }), {
      env,
    }),
  ]);
  writeFileSync(a, "a\n");
  writeFileSync(b, "b\n");
  const posts = await Promise.all([
    fireTouchAsync(proj, payload("PostToolUse", { sid: "s1", tool: "Write", file: a, callId: "ca", agent: "x" }), {
      env,
    }),
    fireTouchAsync(proj, payload("PostToolUse", { sid: "s1", tool: "Write", file: b, callId: "cb", agent: "y" }), {
      env,
    }),
  ]);
  assert.deepEqual(
    posts.map((p) => p.status),
    [0, 0],
  );
  const ev = events(proj, "s1");
  assert.deepEqual(ev.map((e) => e.rel).sort(), ["epics/PS-A/a.md", "epics/PS-A/b.md"]);
  for (const e of ev) {
    assert.equal(e.before, null, "both files were created");
    assert.equal(e.after, sha(e.rel.endsWith("a.md") ? "a\n" : "b\n"));
    assert.equal(e.root, realpathSync(vault), "the root is realpath'd");
  }
  const names = readdirSync(recordDir(proj, "s1")).filter((n) => n.endsWith(".json"));
  assert.equal(names.length, 2, `two event files, no pending snapshot left: ${names.join(", ")}`);
});

// [writerecord#1]
test("record: a 600 KiB vault file's event holds both hashes and no content (edge)", () => {
  const { proj, vault } = seed();
  const big = join(vault, "epics", "PS-A", "big.md");
  const before = "x".repeat(600 * 1024) + "\n";
  writeFileSync(big, before);
  const after = before + "y\n";
  toolWrite(proj, { sid: "s1", file: big, callId: "c1", write: () => writeFileSync(big, after) });
  const [e] = events(proj, "s1");
  assert.ok(Buffer.byteLength(after) > RECORD_FILE_CAP);
  assert.equal(e.before, sha(before));
  assert.equal(e.after, sha(after));
  assert.equal(readBlob(proj, "s1", e.before), null, "the content before is not kept");
  assert.equal(readBlob(proj, "s1", e.after), null, "the content after is not kept");
});

// [writerecord#1]
test("record: on Codex nothing is recorded, from the hook or a node writer (edge)", async () => {
  const { proj, story } = seed();
  const env = hookEnv(proj, { PROJECTSTORE_HARNESS: "codex" });
  const r = toolWrite(proj, { sid: "s1", file: story, callId: "c1", env, write: append(story, "codex\n") });
  assert.equal(r.post.status, 0);
  assert.equal(existsSync(recordDir(proj, "s1")), false, "the hook recorded nothing");
  // A node writer with a Codex identity: guide eject, with an id in Claude Code's variable too.
  const out = await cli(proj, ["guide", "eject", "story", "--write", "--json"], {
    ...env,
    [SID_ENV]: "s2",
  });
  assert.equal(out.code, 0, out.err);
  assert.equal(existsSync(recordDir(proj, "s2")), false, "the node writer recorded nothing");
});

// [writerecord#1]
test("record: when the state directory cannot be written, the write lands, nothing is recorded, the call and the command behave as without it (failure)", async () => {
  const { proj, story, vault } = seed();
  // The state root is a file: nothing under it can be made.
  mkdirSync(join(proj, ".projectstore"), { recursive: true });
  writeFileSync(join(proj, ".projectstore", "state"), "not a folder\n");
  const r = toolWrite(proj, { sid: "s1", file: story, callId: "c1", write: append(story, "landed\n") });
  assert.equal(r.pre.status, 0);
  assert.equal(r.post.status, 0);
  assert.match(readFileSync(story, "utf8"), /landed/, "the write landed");
  assert.equal(readEvents(proj, "s1").length, 0, "nothing is recorded");
  const ejected = await cli(proj, ["guide", "eject", "spec", "--write", "--json"], sessionEnv(proj, "s1"));
  assert.equal(ejected.code, 0, ejected.err);
  const { result } = JSON.parse(ejected.out);
  assert.equal(result.written, true);
  assert.ok(result.target.startsWith(vault) && existsSync(result.target), "the command wrote its file");
});

// ─── Contract 2: the reap ──────────────────────────────────────────────

const age = (p, hours) => {
  const t = new Date(Date.now() - hours * 3600 * 1000);
  utimesSync(p, t, t);
};

// [writerecord#2]
test("reap: another session's record last appended 25 hours ago is gone at a session start (edge)", () => {
  const { proj, story } = seed();
  toolWrite(proj, { sid: "old", file: story, callId: "c1", write: append(story, "x\n") });
  age(recordDir(proj, "old"), 25);
  cleanupStaleSessionState(proj, 24, "new");
  assert.equal(existsSync(recordDir(proj, "old")), false);
});

// [writerecord#2]
test("reap: a compaction that starts a session with the id of a 25-hour-old record keeps it, through the SessionStart hook too (edge)", () => {
  const { proj, story } = seed();
  toolWrite(proj, { sid: "same", file: story, callId: "c1", write: append(story, "x\n") });
  age(recordDir(proj, "same"), 25);
  cleanupStaleSessionState(proj, 24, "same");
  assert.ok(existsSync(recordDir(proj, "same")), "kept by the function");
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "session-start.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "same", source: "compact", cwd: proj }),
    env: hookEnv(proj),
    cwd: proj,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(recordDir(proj, "same")), "kept by the hook, which passes the session id");
  assert.equal(readEvents(proj, "same").length, 1);
});

// [writerecord#2]
test("reap: the starting session's own .paths/ 25 hours old is reaped as before (edge)", () => {
  const { proj } = seed();
  const paths = join(stateDir(proj), "me.paths");
  mkdirSync(paths, { recursive: true });
  writeFileSync(join(paths, "x"), "");
  age(paths, 25);
  cleanupStaleSessionState(proj, 24, "me");
  assert.equal(existsSync(paths), false);
});

// ─── Contract 3: the hook, keyed by the call ──────────────────────────

// [writerecord#3]
test("hook: a successful Edit of a story in the bound vault leaves one event, the story before and after", () => {
  const { proj, story } = seed();
  const before = readFileSync(story, "utf8");
  toolWrite(proj, { sid: "s1", file: story, callId: "c1", write: append(story, "edited\n") });
  const ev = events(proj, "s1");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].tool, "Edit");
  assert.equal(ev[0].rel, "epics/PS-A/stories/story-a.md");
  assert.equal(ev[0].before, sha(before));
  assert.equal(ev[0].after, sha(before + "edited\n"));
  assert.equal(readBlob(proj, "s1", ev[0].before).toString("utf8"), before, "the content is kept by hash");
  assert.deepEqual(
    readdirSync(recordDir(proj, "s1")).filter((n) => n.startsWith("pending-")),
    [],
    "the snapshot is removed",
  );
});

// [writerecord#3]
test("hook: a declined Edit's snapshot is never used; the next Edit starts from the other writer's edit (edge)", () => {
  const { proj, story } = seed();
  fireTouch(proj, payload("PreToolUse", { sid: "s1", file: story, callId: "declined" }));
  append(story, "other writer\n")();
  const between = readFileSync(story, "utf8");
  toolWrite(proj, { sid: "s1", file: story, callId: "c2", write: append(story, "mine\n") });
  const ev = events(proj, "s1");
  assert.equal(ev.length, 1, "one event, from the call that ran");
  assert.equal(ev[0].before, sha(between), "its before holds the other writer's edit");
});

// [writerecord#3]
test("hook: a PostToolUse whose PreToolUse stored nothing appends nothing (edge)", () => {
  const { proj, story } = seed();
  append(story, "x\n")();
  const r = fireTouch(proj, payload("PostToolUse", { sid: "s1", file: story, callId: "never-pre" }));
  assert.equal(r.status, 0);
  assert.equal(events(proj, "s1").length, 0);
});

// [writerecord#3]
test("hook: a payload with no tool_use_id writes no snapshot and no event (edge)", () => {
  const { proj, story } = seed();
  toolWrite(proj, { sid: "s1", file: story, callId: null, write: append(story, "x\n") });
  assert.equal(existsSync(recordDir(proj, "s1")), false);
});

// [writerecord#3]
test("hook: an Edit of a story in a worktree of the vault names that worktree's real path as its root (edge)", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-wr-wt-"));
  const vault = gitVault(join(root, "vault"));
  const wt = addWorktree(vault, join(root, "wt"), "side");
  const proj = join(root, "proj");
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const story = join(wt, "epics", "PS-A", "stories", "story-a.md");
  toolWrite(proj, { sid: "s1", file: story, callId: "c1", write: append(story, "in the worktree\n") });
  const [e] = events(proj, "s1");
  assert.equal(e.root, realpathSync(wt));
  assert.equal(e.rel, "epics/PS-A/stories/story-a.md");
});

// ─── Contract 4: no output, no pointer, the vault only ─────────────────

// [writerecord#4]
test("hook: an Edit of a source file outside the vault leaves the record unchanged", () => {
  const { proj } = seed();
  const src = join(proj, "src", "a.mjs");
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, "a\n");
  toolWrite(proj, { sid: "s1", file: src, callId: "c1", write: () => writeFileSync(src, "b\n") });
  assert.equal(existsSync(recordDir(proj, "s1")), false);
});

// [writerecord#4]
test("hook: a vault write's PreToolUse prints what it printed before the record (edge)", () => {
  const { proj, story } = seed();
  // The same call with no tool_use_id records nothing: what it prints is the hook as it was.
  const without = fireTouch(proj, payload("PreToolUse", { sid: "s1", file: story }));
  const withId = fireTouch(proj, payload("PreToolUse", { sid: "s1", file: story, callId: "c1" }));
  assert.equal(withId.status, 0);
  assert.equal(withId.stdout, without.stdout);
  if (withId.stdout) assert.deepEqual(Object.keys(JSON.parse(withId.stdout)), ["systemMessage"]);
  assert.ok(existsSync(recordDir(proj, "s1")), "and the snapshot was stored");
});

// [writerecord#4]
test("hook: when the record's directory is a file, the hook exits 0, prints as before, and the pointer is patched (failure)", () => {
  const { proj, story } = seed();
  mkdirSync(stateDir(proj), { recursive: true });
  writeFileSync(recordDir(proj, "s1"), "a file\n");
  const control = seed();
  const ctl = toolWrite(control.proj, {
    sid: "s1",
    file: control.story,
    callId: "c1",
    write: append(control.story, "x\n"),
  });
  const r = toolWrite(proj, { sid: "s1", file: story, callId: "c1", write: append(story, "x\n") });
  assert.equal(r.pre.status, 0);
  assert.equal(r.post.status, 0);
  assert.equal(r.pre.stdout, ctl.pre.stdout);
  assert.equal(r.post.stdout, ctl.post.stdout);
  assert.equal(readSessionState(proj, "s1")?.active_story, "story-a", "the pointer is patched as before");
});

// [writerecord#4]
test("hook: a subagent's Write creating a vault file lands in the parent session's record (edge)", () => {
  const { proj, vault } = seed();
  const file = join(vault, "adr", "new.md");
  mkdirSync(dirname(file), { recursive: true });
  toolWrite(proj, {
    sid: "parent",
    file,
    callId: "c1",
    tool: "Write",
    agent: "general-purpose",
    write: () => writeFileSync(file, "new\n"),
  });
  const [e] = events(proj, "parent");
  assert.equal(e.rel, "adr/new.md");
  assert.equal(e.agent, "general-purpose");
  assert.equal(e.before, null);
});

// ─── Contract 5: the node writers ──────────────────────────────────────

const VARS = { id: "story-a", title: "A", date: "2026-11-01", author: "Other", tags: "[]", epic_id: "PS-X" };
const EPIC = `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-11-01\n---\n\n# PS-X: X\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [a](./stories/story-a.md) | planned | the a |\n`;
function moveFixture() {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
  writeFileSync(path, renderTemplate(loadTemplate("en", "story"), VARS));
  writeFileSync(join(vault, "epics", "PS-X", "epic.md"), EPIC);
  return { proj, vault, path };
}

// [writerecord#5]
test("node writers: move puts a planned story in ToDo with one event for the story and one for its epic.md", async () => {
  const { proj, path } = moveFixture();
  const before = readFileSync(path, "utf8");
  const r = await cli(proj, ["move", "PS-X/story-a", "todo", "--reason", "next up", "--write", "--json"], {
    ...process.env,
    [SID_ENV]: "s1",
  });
  assert.equal(r.code, 0, r.err);
  const ev = events(proj, "s1");
  assert.deepEqual(ev.map((e) => e.rel).sort(), ["epics/PS-X/epic.md", "epics/PS-X/stories/story-a.md"]);
  const s = ev.find((e) => e.rel.endsWith("story-a.md"));
  assert.equal(s.tool, "move");
  assert.equal(s.before, sha(before));
  assert.equal(s.after, sha(readFileSync(path, "utf8")));
  assert.ok(!ev.some((e) => e.rel === "kanban.md"), "the reconcile it runs is not recorded");
});

// [writerecord#5]
test("node writers: move puts a planned story in ToDo, then handover --write gives it to another person: one more story event, tool handover", async () => {
  const { proj, path } = moveFixture();
  const env = { ...process.env, [SID_ENV]: "s1" };
  const moved = await cli(proj, ["move", "PS-X/story-a", "todo", "--reason", "next up", "--write", "--json"], env);
  assert.equal(moved.code, 0, moved.err);
  const from = parseFrontmatter(readFileSync(path, "utf8")).data.assignee;
  assert.ok(from, "the fixture story has an assignee (control)");
  const before = readFileSync(path, "utf8");
  const r = await cli(
    proj,
    ["handover", "--from", from, "--to", "Other Person", "--reason", "left the team", "--write", "--json"],
    env,
  );
  assert.equal(r.code, 0, r.err);
  const ev = events(proj, "s1");
  assert.deepEqual(
    ev.map((e) => [e.rel, e.tool]),
    [
      ["epics/PS-X/stories/story-a.md", "move"],
      ["epics/PS-X/epic.md", "move"],
      ["epics/PS-X/stories/story-a.md", "handover"],
    ],
  );
  assert.equal(ev[2].before, sha(before));
  assert.equal(ev[2].after, sha(readFileSync(path, "utf8")));
  assert.ok(!ev.some((e) => !e.rel.startsWith("epics/")), "no derived view is recorded");
});

// [writerecord#5]
test("node writers: configure --set flow.window_weeks=4 leaves one event for .projectstore.json", async () => {
  const { proj, vault } = moveFixture();
  writeFileSync(join(vault, ".projectstore.json"), "{}\n");
  const home = mkdtempSync(join(tmpdir(), "ps-wr-home-"));
  const r = await runConfigure({
    values: { set: ["flow.window_weeks=4"] },
    project: proj,
    env: { [SID_ENV]: "s1" },
    stdout: sink(),
    stderr: sink(),
    root: REPO,
    home,
  });
  assert.equal(r.code, 0, r.message || r.usage);
  const ev = events(proj, "s1");
  assert.deepEqual(
    ev.map((e) => [e.rel, e.tool]),
    [[".projectstore.json", "configure"]],
  );
  assert.equal(ev[0].before, sha("{}\n"));
  assert.equal(ev[0].after, sha(readFileSync(join(vault, ".projectstore.json"), "utf8")));
});

// [writerecord#5]
test("node writers: guide eject records its new file with no content before", async () => {
  const { proj, vault } = moveFixture();
  const r = await cli(proj, ["guide", "eject", "story", "--write", "--json"], { ...process.env, [SID_ENV]: "s1" });
  assert.equal(r.code, 0, r.err);
  const { target } = JSON.parse(r.out).result;
  assert.ok(target.startsWith(vault + "/"), target);
  const [e] = events(proj, "s1");
  assert.equal(e.rel, target.slice(vault.length + 1));
  assert.equal(e.tool, "guide eject");
  assert.equal(e.before, null);
  assert.equal(e.after, sha(readFileSync(target, "utf8")));
});

// [writerecord#5]
test("node writers: epic-row, which takes no --project, records under the project its shell resolves", () => {
  const { proj, vault, path } = moveFixture();
  const story = readFileSync(path, "utf8").replace("status: planned", "status: in-progress");
  writeFileSync(path, story);
  const epic = join(vault, "epics", "PS-X", "epic.md");
  const before = readFileSync(epic, "utf8");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "status-change.mjs"), "epic-row", path], {
    encoding: "utf8",
    env: sessionEnv(proj, "s1"),
    cwd: tmpdir(),
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).written, true);
  const [e] = events(proj, "s1");
  assert.deepEqual([e.rel, e.tool, e.before], ["epics/PS-X/epic.md", "epic-row", sha(before)]);
  assert.equal(e.after, sha(readFileSync(epic, "utf8")));
});

// [writerecord#5] [epic-rule#4]
test("node writers: epic-rule --write, which takes no --project, records the epic it moves under the project its shell resolves", () => {
  const { proj, vault, path } = moveFixture();
  writeFileSync(path, readFileSync(path, "utf8").replace("status: planned", "status: done"));
  const epic = join(vault, "epics", "PS-X", "epic.md");
  const before = readFileSync(epic, "utf8");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "epic-rule.mjs"), path, "--write"], {
    encoding: "utf8",
    env: sessionEnv(proj, "s1"),
    cwd: tmpdir(),
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).moved, ["PS-X"]);
  const [e, ...more] = events(proj, "s1");
  assert.deepEqual(more, [], "one event: the epic");
  assert.deepEqual([e.rel, e.tool, e.before], ["epics/PS-X/epic.md", "epic-rule", sha(before)]);
  assert.equal(e.after, sha(readFileSync(epic, "utf8")));
});

// [writerecord#5]
test("node writers: reconcile --write rewriting kanban.md records nothing (edge)", async () => {
  const { proj, vault } = moveFixture();
  writeFileSync(join(vault, "kanban.md"), "stub board\n");
  const r = await cli(proj, ["reconcile", "--write", "--only", "kanban", "--json"], {
    ...process.env,
    [SID_ENV]: "s1",
  });
  assert.equal(r.code, 0, r.err);
  assert.notEqual(readFileSync(join(vault, "kanban.md"), "utf8"), "stub board\n", "the board was rewritten");
  assert.equal(events(proj, "s1").length, 0);
});

// [writerecord#5]
test("node writers: move with no session id from the host records nothing, and its output and exit code are a plain run's (edge)", async () => {
  const a = moveFixture();
  const b = moveFixture();
  const args = ["move", "PS-X/story-a", "todo", "--reason", "next up", "--write", "--json"];
  const without = await cli(a.proj, args, { ...process.env });
  const withId = await cli(b.proj, args, { ...process.env, [SID_ENV]: "s1" });
  assert.equal(without.code, 0, without.err);
  assert.equal(without.code, withId.code);
  const strip = (o) =>
    JSON.stringify(JSON.parse(o).result)
      .replaceAll(a.proj, "P")
      .replaceAll(b.proj, "P")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T");
  assert.equal(strip(without.out), strip(withId.out), "the record changes no result");
  assert.deepEqual(
    existsSync(stateDir(a.proj)) ? readdirSync(stateDir(a.proj)).filter((n) => n.endsWith(".writes")) : [],
    [],
  );
});

// ─── Contracts 6 and 7: the bracket around the clerk's copy ────────────

function bracketFixture() {
  const s = seed();
  const scratch = join(s.root, "scratch.md");
  writeFileSync(scratch, readFileSync(s.story, "utf8").replace("planned", "done") + "\n## Final Summary\n\ndone\n");
  return { ...s, scratch, env: sessionEnv(s.proj, "s1") };
}
const snapshot = (f, path = f.story, scratch = f.scratch) =>
  cli(f.proj, ["session", "snapshot", path, "--for", scratch, "--json"], f.env);
const record = (f, path = f.story, scratch = f.scratch) =>
  cli(f.proj, ["session", "record", path, "--from", scratch, "--json"], f.env);
const pending = (f) =>
  existsSync(recordDir(f.proj, "s1"))
    ? readdirSync(recordDir(f.proj, "s1")).filter((n) => n.startsWith("pending-"))
    : [];

// [writerecord#6]
test("bracket: snapshot, the clerk's copy, record — one event from the snapshot to the scratch, no snapshot left", async () => {
  const f = bracketFixture();
  const before = readFileSync(f.story, "utf8");
  const s = await snapshot(f);
  assert.equal(s.code, 0, s.err);
  assert.equal(JSON.parse(s.out).result.recorded, true);
  copyFileSync(f.scratch, f.story);
  const r = await record(f);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).result.recorded, true);
  const ev = events(f.proj, "s1");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].before, sha(before));
  assert.equal(ev[0].after, sha(readFileSync(f.scratch, "utf8")));
  assert.deepEqual(pending(f), []);
});

// [writerecord#6]
test("bracket: another writer edits the story between the copy and the record — nothing appended, the snapshot removed (failure)", async () => {
  const f = bracketFixture();
  await snapshot(f);
  copyFileSync(f.scratch, f.story);
  append(f.story, "other writer\n")();
  const r = await record(f);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).result.reason, "file-differs-from-scratch");
  assert.equal(events(f.proj, "s1").length, 0);
  assert.deepEqual(pending(f), []);
  const text = await cli(f.proj, ["session", "record", f.story, "--from", f.scratch], f.env);
  assert.match(text.out, /no snapshot was taken/, "and says why, in text too");
});

// [writerecord#6]
test("bracket: an abandoned close's snapshot does not vouch for a later close's scratch (failure)", async () => {
  const f = bracketFixture();
  await snapshot(f);
  append(f.story, "other writer\n")();
  const later = join(f.root, "later.md");
  writeFileSync(later, "a later close\n");
  copyFileSync(later, f.story);
  const r = await cli(f.proj, ["session", "record", f.story, "--from", later], f.env);
  assert.equal(r.code, 0);
  assert.match(r.out, /the snapshot was taken for other content/);
  assert.equal(events(f.proj, "s1").length, 0);
});

// [writerecord#6]
test("bracket: a story written with Write, which the hook recorded, is not recorded twice (edge)", async () => {
  const f = bracketFixture();
  await snapshot(f);
  toolWrite(f.proj, {
    sid: "s1",
    file: f.story,
    callId: "w1",
    tool: "Write",
    write: () => copyFileSync(f.scratch, f.story),
  });
  const r = await record(f);
  assert.equal(JSON.parse(r.out).result.reason, "already-recorded");
  assert.equal(events(f.proj, "s1").length, 1, "the hook's event alone");
});

// [writerecord#6]
test("bracket: a path outside every copy of the vault exits 2 and writes nothing; so does a missing --for; no session writes nothing and exits 0 (failure)", async () => {
  const f = bracketFixture();
  const outside = join(tmpdir(), "x.md");
  const r = await cli(f.proj, ["session", "snapshot", outside, "--for", f.scratch], f.env);
  assert.equal(r.code, 2);
  assert.equal(existsSync(recordDir(f.proj, "s1")), false);
  assert.equal((await cli(f.proj, ["session", "snapshot", f.story], f.env)).code, 2, "--for is required");
  assert.equal((await cli(f.proj, ["session", "record", f.story], f.env)).code, 2, "--from is required");
  const none = await cli(f.proj, ["session", "snapshot", f.story, "--for", f.scratch], hookEnv(f.proj));
  assert.equal(none.code, 0);
  assert.match(none.out, /No session id from the host: nothing written/);
  assert.equal(existsSync(stateDir(f.proj)) && readdirSync(stateDir(f.proj)).some((n) => n.endsWith(".writes")), false);
});

// [writerecord#7]
test("close: a re-delegation after the clerk stopped at the race re-check snapshots again, and the event starts from the other writer's edit (edge)", async () => {
  const f = bracketFixture();
  await snapshot(f);
  append(f.story, "edited after the snapshot\n")(); // the clerk's race re-check stops: no copy
  await snapshot(f); // before the re-delegation
  const resnap = readFileSync(f.story, "utf8");
  copyFileSync(f.scratch, f.story);
  await record(f);
  const [e] = events(f.proj, "s1");
  assert.equal(e.before, sha(resnap), "the new snapshot holds that writer's edit");
  assert.ok(resnap.includes("edited after the snapshot"));
});

// [writerecord#7]
test("close: the clerk copies and stops at reconcile; the main thread records, and step 6c appends nothing more (edge)", async () => {
  const f = bracketFixture();
  await snapshot(f);
  copyFileSync(f.scratch, f.story); // the copy, then a stop at reconcile
  assert.equal(JSON.parse((await record(f)).out).result.recorded, true);
  const sixC = await record(f); // step 6c, beside session refresh
  assert.equal(JSON.parse(sixC.out).result.recorded, false);
  assert.equal(events(f.proj, "s1").length, 1);
});
// The text pin of contract 7 (commands/story.md's three places) is in tests/scripts.test.mjs.

// [writerecord#6]
test("bracket: a snapshot for a scratch that is missing takes none, and a record from a missing scratch appends nothing and removes the snapshot (edge)", async () => {
  const f = bracketFixture();
  const gone = join(f.root, "gone.md");
  const s = await cli(f.proj, ["session", "snapshot", f.story, "--for", gone, "--json"], f.env);
  assert.equal(s.code, 0);
  assert.deepEqual(JSON.parse(s.out).result, {
    session: "s1",
    path: "epics/PS-A/stories/story-a.md",
    recorded: false,
    reason: "scratch-missing",
  });
  assert.deepEqual(pending(f), [], "no snapshot taken");
  await snapshot(f);
  assert.equal(pending(f).length, 1);
  const r = await cli(f.proj, ["session", "record", f.story, "--from", gone, "--json"], f.env);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).result.reason, "scratch-missing");
  assert.equal(events(f.proj, "s1").length, 0);
  assert.deepEqual(pending(f), [], "the snapshot is removed on this exit too");
  const text = await cli(f.proj, ["session", "snapshot", f.story, "--for", gone], f.env);
  assert.match(text.out, /No snapshot taken: the scratch is missing/);
});

// [writerecord#1]
test("record: the total cap holds at its boundary, with no size scan while the blob count alone proves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-wr-cap-"));
  mkdirSync(join(dir, "blobs"));
  const caps = { file: 10, total: 40 }; // 4 blobs of the file cap are the total exactly
  const blob = (s) => Buffer.from(s.padEnd(10, "."), "utf8");
  const kept = (b) => existsSync(join(dir, "blobs", hashOf(b)));
  for (const s of ["a", "b", "c", "d"]) {
    storeBlob(dir, blob(s), caps);
    assert.ok(kept(blob(s)), `${s}: within the count bound`);
  }
  assert.equal(existsSync(join(dir, "blobs.size.json")), false, "no size was measured within the count bound");
  storeBlob(dir, blob("e"), caps);
  assert.equal(kept(blob("e")), false, "a fifth full blob would pass 40 bytes");
  assert.ok(existsSync(join(dir, "blobs.size.json")), "past the count bound the total is measured");
  // Small contents still fit under the measured total, and the cap is exact.
  const dir2 = mkdtempSync(join(tmpdir(), "ps-wr-cap2-"));
  mkdirSync(join(dir2, "blobs"));
  const sizes = [10, 10, 10, 5, 5]; // 40 exactly
  sizes.forEach((n, i) => storeBlob(dir2, Buffer.from(String(i).repeat(n)), caps));
  assert.equal(readdirSync(join(dir2, "blobs")).length, 5, "40 bytes in five blobs: all kept");
  storeBlob(dir2, Buffer.from("z"), caps);
  assert.equal(readdirSync(join(dir2, "blobs")).length, 5, "one byte more passes the cap");
  assert.equal(128 * RECORD_FILE_CAP, RECORD_TOTAL_CAP, "128 full blobs are the real cap exactly");
});

// [writerecord#1]
test("record: two thousand writes in one session stay cheap (no scan of every blob per write)", () => {
  const { proj } = seed();
  const dir = recordDir(proj, "s1");
  mkdirSync(join(dir, "blobs"), { recursive: true });
  // Per-write cost over `n` writes starting at blob `from`, in ms.
  const perWrite = (from, n) => {
    const t = process.hrtime.bigint();
    for (let i = from; i < from + n; i++) storeBlob(dir, Buffer.from(`content ${i}\n`));
    return Number(process.hrtime.bigint() - t) / 1e6 / n;
  };
  for (let i = 0; i < 10; i++) storeBlob(dir, Buffer.from(`warm ${i}\n`));
  const early = perWrite(0, 50); // at 10 to 60 blobs
  for (let i = 50; i < 2000; i++) storeBlob(dir, Buffer.from(`content ${i}\n`));
  const late = perWrite(2000, 200); // after 2000 blobs
  // Relative, so a slow runner slows both alike: a scan of every blob per write
  // (23.5 ms a write at 2000, against a fraction of a millisecond at 10) is
  // far past this bound; the amortised rescan stays well inside it. The
  // absolute bound is a generous backstop.
  assert.ok(
    late <= early * 25 + 2 && late < 200,
    `${late.toFixed(3)} ms a write after 2000 blobs, ${early.toFixed(3)} ms at about 10`,
  );
  assert.equal(readdirSync(join(dir, "blobs")).length, 2210);
});

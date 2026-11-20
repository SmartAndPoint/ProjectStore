// projectstore — tests/band-wip.test.mjs: the band's WIP state file, the
// write side (PS-FLOW, "The band above the prompt shows the session
// assignee's WIP against their limit").
//
// The count, the gate and the write as functions (scripts/band-wip.mjs) and
// through the bin's run(); the SessionStart hook as the host runs it, a child
// process over a fixture project with a hermetic environment. The read side
// is the band's: tests/band-model.test.mjs and tests/band/band.test.tsx.
//
// Spec: "The band's WIP state file: its count, its gate, its writers, and a
// write only when it changes" (alias `band-wip`), contract numbers in each
// test's citation.

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
  utimesSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/cli.mjs";
import { runHandover } from "../scripts/handover.mjs";
import { layoutPaths, loadLayout } from "../scripts/lib.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { wipBody, wipShown } from "../scripts/band-shared.mjs";
import { wipView, wipGate, writeWip, refreshWip, wipFromScan, DEFAULT_LAYOUT } from "../scripts/band-wip.mjs";
import { DEFAULT_LAYOUT as BINDING_DEFAULT_LAYOUT } from "../scripts/binding.mjs";
import { personWip } from "../scripts/next.mjs";
import { readFlowStories } from "../scripts/flow-stories.mjs";
import { storyFacts } from "../scripts/flow-counts.mjs";
import { flowModel, buildFlowView } from "../scripts/flow-view.mjs";
import { AWAITING_REASON } from "../scripts/status-log.mjs";
import { hermeticEnv } from "./fixtures/vocabulary.mjs";
import { flowVault, storyText, withLine, daysAgo, doctorRun, byCheck } from "./fixtures/flow.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, "hooks", "session-start.mjs");
const SRC = sourceHarness();
const read = (p) => readFileSync(p, "utf8");
const js = (v) => JSON.stringify(v);
const ME = "Test"; // makeVaultProject's default_author

// Stories as the writers leave them.
const inProgress = (id, { assignee = ME, status = "in-progress" } = {}) =>
  storyText({
    id,
    assignee,
    log: [{ to: "in-progress", at: daysAgo(10) }],
    fm: { started_at: js(daysAgo(10)) },
  }).replace("status: in-progress", `status: ${status}`);
const awaiting = (id, { assignee = ME } = {}) =>
  withLine(inProgress(id, { assignee }), {
    at: daysAgo(3),
    from: "in-progress",
    to: "review",
    reason: `${AWAITING_REASON}: <url>`,
  }).replace("status: in-progress", "status: review");
const done = (id) => storyText({ id, assignee: ME, status: "done" });
const planned = (id) => storyText({ id, assignee: ME });

// Contract 3's first fixture: two in-progress stories of Test, one of Test
// awaiting close, one done, one of another person; Test's limit is 3.
const BASE = {
  "PS-X/story-a": inProgress("story-a"),
  "PS-X/story-b": inProgress("story-b"),
  "PS-X/story-w": awaiting("story-w"),
  "PS-X/story-d": done("story-d"),
  "PS-X/story-o": inProgress("story-o", { assignee: "Other Person" }),
};
const POLICY = { flow: { people: { [ME]: { wip: 3 } } } };
const BODY = '{"assignee":"Test","count":2,"awaiting_close":1,"limit":3}\n';

function fixture({ vaultCfg = POLICY, stories = BASE, binding = {} } = {}) {
  const fx = flowVault({ vaultCfg, stories });
  writeFileSync(join(fx.vault, "kanban.md"), "stub board\n");
  const cfg = { ...fx.cfg, ...binding };
  writeFileSync(layoutPaths(fx.proj).binding, JSON.stringify(cfg));
  return { ...fx, cfg, wip: layoutPaths(fx.proj).wip };
}

// A Claude Code process of `proj` (its project variable), its cache in a temp
// folder so no welcome marker lands in the developer's home.
const CACHE = mkdtempSync(join(tmpdir(), "ps-bw-cache-"));
const claudeEnv = (proj, extra = {}) =>
  hermeticEnv({
    [SRC.runtime.project_dir_env]: proj,
    [SRC.runtime.plugin_root_env]: REPO,
    XDG_CACHE_HOME: CACHE,
    CI: "1",
    ...extra,
  });
const codexEnv = (proj) => claudeEnv(proj, { PROJECTSTORE_HARNESS: "codex" });

function hook(fx, { env = claudeEnv(fx.proj) } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" }),
    timeout: 20000,
    env,
    cwd: fx.proj,
  });
  assert.equal(r.status, 0, `SessionStart exits 0; stderr: ${r.stderr}`);
  return r;
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};
async function cli(fx, args, { env = claudeEnv(fx.proj), project = fx.proj } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run([...args, "--project", project], {
    env,
    cwd: project,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  return { code, out: stdout.text, err: stderr.text };
}

const fileOf = (fx) => (existsSync(fx.wip) ? read(fx.wip) : null);
const mtimeOf = (p) => statSync(p).mtimeMs;
const ageBack = (p, days) => {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(p, t, t);
  return mtimeOf(p);
};
const storyPath = (fx, slug, epic = "PS-X") => join(fx.vault, "epics", epic, "stories", `${slug}.md`);

// A hash of every file under `dir`, by path; `times` blanks the instants a
// writer stamps, so two runs a moment apart compare.
function treeHash(dir, { times = false } = {}) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0${times ? read(p).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>") : read(p)}\0`);
    }
  };
  walk(dir);
  return h.digest("hex");
}

// A `read` seam for readFlowStories that counts its calls by path.
function counting() {
  const calls = new Map();
  const seam = (p) => {
    calls.set(p, (calls.get(p) || 0) + 1);
    return readFileSync(p, "utf8");
  };
  seam.total = () => [...calls.values()].reduce((a, b) => a + b, 0);
  seam.of = (p) => calls.get(p) || 0;
  return seam;
}

// ─── Contract 1: the file and its place ────────────────────────────────

// [band-wip#1]
test("band-wip contract 1: layoutPaths().wip is <project>/.projectstore/state/wip.json, beside state/sessions/ and not in it", () => {
  const p = layoutPaths("/p");
  assert.equal(p.wip, "/p/.projectstore/state/wip.json");
  assert.equal(dirname(p.wip), p.state);
  assert.notEqual(dirname(p.wip), p.sessions);
});

// [band-wip#1]
test("band-wip contract 1: a wip.json two days old survives SessionStart's sweep of stale session state (edge)", () => {
  const fx = fixture();
  hook(fx);
  assert.equal(fileOf(fx), BODY);
  const old = ageBack(fx.wip, 2);
  hook(fx);
  assert.equal(fileOf(fx), BODY, "still there");
  assert.equal(mtimeOf(fx.wip), old, "and not rewritten");
});

// [band-wip#1]
test("band-wip contract 1: in a git repository the file is ignored after a write", (t) => {
  const fx = fixture();
  const g = (args) =>
    spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
      cwd: fx.proj,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  if (g(["init", "-q"]).status !== 0) return t.skip("no git");
  assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: claudeEnv(fx.proj) }), "written");
  assert.equal(g(["check-ignore", "-q", relative(fx.proj, fx.wip)]).status, 0, "git ignores state/wip.json");
});

// ─── Contract 2: the bytes, and how the band reads them ────────────────

// [band-wip#2]
test("band-wip contract 2: wipBody writes the four keys in one order, no spaces, one newline, whatever order it is given", () => {
  const view = { assignee: "Test", count: 2, awaiting_close: 1, limit: 3 };
  assert.equal(wipBody(view), BODY);
  assert.equal(wipBody({ limit: 3, count: 2, assignee: "Test", awaiting_close: 1 }), BODY);
  assert.equal(wipBody({ ...view, limit: null }), '{"assignee":"Test","count":2,"awaiting_close":1,"limit":null}\n');
});

// [band-wip#2]
test("band-wip contract 2: wipShown reads the file for the binding's default_author, trimmed (edge)", () => {
  assert.deepEqual(wipShown(JSON.parse(BODY), " Test "), { count: 2, limit: 3 });
  assert.deepEqual(wipShown({ assignee: "Test", count: 0, awaiting_close: 0, limit: null }, "Test"), {
    count: 0,
    limit: null,
  });
});

// [band-wip#2]
test("band-wip contract 2: wipShown gives null for anything else (failure)", () => {
  const ok = { assignee: "Test", count: 2, awaiting_close: 1, limit: 3 };
  const parsed = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const cases = [
    [parsed("not json"), "Test"],
    [[ok], "Test"],
    [{ ...ok, count: -1 }, "Test"],
    [{ ...ok, count: 2.5 }, "Test"],
    [{ ...ok, limit: 0 }, "Test"],
    [{ ...ok, limit: "3" }, "Test"],
    [{ ...ok, assignee: "Other Person" }, "Test"],
    [{ ...ok, assignee: "" }, ""],
    [{ ...ok, assignee: "" }, undefined],
    [null, "Test"],
  ];
  for (const [value, author] of cases) assert.equal(wipShown(value, author), null, JSON.stringify([value, author]));
});

// ─── Contract 3: the count ─────────────────────────────────────────────

// [band-wip#3]
test("band-wip contract 3: the SessionStart hook writes Test's count, awaiting close apart, and limit", () => {
  const fx = fixture();
  hook(fx);
  assert.equal(fileOf(fx), BODY);
});

// [band-wip#3]
test("band-wip contract 3: a person flow.people does not list has a null limit, and constructor is a name like any other (edge)", () => {
  const vaultCfg = { flow: { people: { constructor: { wip: 1 } } } };
  const facts = [
    storyFacts({
      rel: "epics/PS-X/stories/a.md",
      epic: "PS-X",
      text: inProgress("a"),
      fm: { status: "in-progress", assignee: ME },
    }),
  ];
  assert.deepEqual(wipView(facts, vaultCfg, ME), { assignee: ME, count: 1, awaiting_close: 0, limit: null });
  assert.deepEqual(wipView([], vaultCfg, "constructor"), {
    assignee: "constructor",
    count: 0,
    awaiting_close: 0,
    limit: 1,
  });
});

// [band-wip#3] [band-wip#6]
test("band-wip contract 3: the hook's file, session refresh's file, personWip, doctor and flow.md count Test's WIP alike (edge)", async () => {
  const stories = {
    "PS-A/story-1": inProgress("story-1", { status: "in_progress" }),
    "PS-A/story-2": inProgress("story-2", { status: "In-Progress" }),
    "PS-A/story-3": inProgress("story-3", { status: "review" }),
    "PS-A/story-4": awaiting("story-4"),
    "PS-A/story-5": inProgress("story-5", { status: "parked" }),
    "PS-A/story-6": storyText({ id: "story-6", assignee: ME }).replace(/^status: .*\n/m, ""),
    "_templates/story-t": inProgress("story-t"),
    ".hidden/story-h": inProgress("story-h"),
  };
  const fx = fixture({ vaultCfg: { flow: { people: { [ME]: { wip: 1 } } } }, stories });
  // A folder story and a story beside epic.md.
  mkdirSync(join(fx.vault, "epics", "PS-A", "stories", "story-f"), { recursive: true });
  writeFileSync(join(fx.vault, "epics", "PS-A", "stories", "story-f", "README.md"), inProgress("story-f"));
  writeFileSync(join(fx.vault, "epics", "PS-A", "story-beside.md"), inProgress("story-beside", { status: "review" }));

  hook(fx);
  const fromHook = JSON.parse(fileOf(fx));
  rmWip(fx);
  const r = await cli(fx, ["session", "refresh", storyPath(fx, "story-1", "PS-A")]);
  assert.equal(r.code, 0, r.err);
  const fromVerb = JSON.parse(fileOf(fx));
  assert.deepEqual(fromVerb, fromHook);

  const { stories: read } = readFlowStories(fx.vault, "epics");
  const facts = read.map(storyFacts);
  const w = personWip(facts, { flow: { people: { [ME]: { wip: 1 } } } }, ME);
  const want = { assignee: ME, count: w.held.length, awaiting_close: w.awaiting.length, limit: w.limit };
  assert.deepEqual(fromHook, want);
  assert.deepEqual(want, { assignee: ME, count: 5, awaiting_close: 1, limit: 1 });

  const over = byCheck(doctorRun(fx), "wip-over-limit");
  assert.equal(over.length, 1);
  assert.match(over[0].message, /holds 5 stories in progress or review, over their WIP limit of 1/);
  assert.match(over[0].message, /1 more awaiting close is counted apart/);

  let model = null;
  buildFlowView(fx.cfg, loadLayout("engineering"), {
    model: (...a) => (model = flowModel(...a)),
  });
  const row = model.wip.find((x) => x.name === ME);
  assert.deepEqual([row.held, row.awaiting, row.limit], [5, 1, 1], "flow.md's WIP table");
});

const rmWip = (fx) => rmSync(fx.wip, { force: true });

// ─── Contract 4: the gate, and a write only when the bytes change ──────

// [band-wip#4]
test("band-wip contract 4: a second SessionStart over the same vault leaves the bytes and the mtime as they were", () => {
  const fx = fixture();
  hook(fx);
  const old = ageBack(fx.wip, 1);
  hook(fx);
  assert.equal(fileOf(fx), BODY);
  assert.equal(mtimeOf(fx.wip), old);
  // The verbs' writer too.
  assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: claudeEnv(fx.proj) }), "unchanged");
  assert.equal(mtimeOf(fx.wip), old);
});

// [band-wip#4]
test("band-wip contract 4: with no flow block, a writer removes the file it finds (edge)", async () => {
  const fx = fixture();
  hook(fx);
  assert.equal(fileOf(fx), BODY);
  writeFileSync(join(fx.vault, ".projectstore.json"), "{}");
  hook(fx);
  assert.equal(fileOf(fx), null, "SessionStart removes it");
  // And the verbs: a file written by hand, then a session refresh.
  writeFileSync(fx.wip, BODY);
  const r = await cli(fx, ["session", "refresh", storyPath(fx, "story-a")]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fileOf(fx), null, "session refresh removes it");
  // A flow block holding only the groom stamp declares nothing.
  writeFileSync(join(fx.vault, ".projectstore.json"), js({ flow: { groomed_at: "2026-11-01" } }));
  writeFileSync(fx.wip, BODY);
  assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: claudeEnv(fx.proj) }), "removed");
});

// [band-wip#4]
test("band-wip contract 4: a Codex session, band.enabled false or no default_author touches no file and reads no story (edge)", () => {
  for (const [what, binding, env] of [
    ["codex", {}, codexEnv],
    ["band off", { band: { enabled: false } }, claudeEnv],
    ["no default_author", { default_author: "  " }, claudeEnv],
  ]) {
    // No flow block, and a stale file: still left alone.
    for (const before of [BODY, null]) {
      const fx = fixture({ vaultCfg: null, binding });
      if (before !== null) {
        mkdirSync(dirname(fx.wip), { recursive: true });
        writeFileSync(fx.wip, before);
      }
      const seam = counting();
      assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: env(fx.proj), read: seam }), "skip", what);
      assert.equal(seam.total(), 0, `${what}: no story is read`);
      assert.equal(
        wipGate({ cfg: fx.cfg, vaultCfg: POLICY, harness: { surfaces: { band: { supported: true } } } }),
        what === "codex" ? "write" : "skip",
      );
      hook(fx, { env: env(fx.proj) });
      assert.equal(fileOf(fx), before, `${what}: the hook leaves the file as it was`);
    }
  }
});

// [band-wip#4]
test("band-wip contract 4: a count that changed is written whole, and no temporary file is left beside it", () => {
  const fx = fixture();
  hook(fx);
  writeFileSync(storyPath(fx, "story-c"), inProgress("story-c"));
  assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: claudeEnv(fx.proj) }), "written");
  assert.equal(fileOf(fx), '{"assignee":"Test","count":3,"awaiting_close":1,"limit":3}\n');
  assert.deepEqual(
    readdirSync(dirname(fx.wip)).filter((n) => n.endsWith(".tmp")),
    [],
  );
  // writeWip alone: equal bytes are "unchanged" and make no directory.
  const bare = mkdtempSync(join(tmpdir(), "ps-bw-bare-"));
  assert.equal(writeWip(bare, { assignee: ME, count: 1, awaiting_close: 0, limit: null }), "written");
  assert.equal(writeWip(bare, { assignee: ME, count: 1, awaiting_close: 0, limit: null }), "unchanged");
});

// ─── Contract 5: a read that is not whole writes nothing ───────────────

// [band-wip#5]
test("band-wip contract 5: a scan that timed out writes nothing, and a writer never throws (failure)", () => {
  const fx = fixture();
  mkdirSync(dirname(fx.wip), { recursive: true });
  writeFileSync(fx.wip, "kept\n");
  const scan = { complete: false, stories: [], vaultConfig: POLICY };
  assert.equal(wipFromScan({ project: fx.proj, cfg: fx.cfg, scan, env: claudeEnv(fx.proj) }), "incomplete");
  assert.equal(fileOf(fx), "kept\n");
  // A scan that holds nothing, and a cfg that is not one: no throw.
  assert.equal(wipFromScan({ project: fx.proj, cfg: fx.cfg, scan: null }), "skip");
  assert.doesNotThrow(() => refreshWip({ project: fx.proj, cfg: null }));
});

// [band-wip#5]
test("band-wip contract 5: a story file that cannot be read leaves the file untouched, at SessionStart and at session refresh, whose output is as without the writer (failure)", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root reads every file");
  const fx = fixture();
  hook(fx);
  const before = fileOf(fx);
  writeFileSync(storyPath(fx, "story-c"), inProgress("story-c"));
  chmodSync(storyPath(fx, "story-c"), 0o000);
  try {
    hook(fx);
    assert.equal(fileOf(fx), before, "SessionStart");
    const seam = counting();
    assert.equal(refreshWip({ project: fx.proj, cfg: fx.cfg, env: claudeEnv(fx.proj), read: seam }), "incomplete");
    const withWriter = await cli(fx, ["session", "refresh", storyPath(fx, "story-a"), "--json"]);
    assert.equal(fileOf(fx), before, "session refresh");
    writeFileSync(layoutPaths(fx.proj).binding, JSON.stringify({ ...fx.cfg, band: { enabled: false } }));
    const without = await cli(fx, ["session", "refresh", storyPath(fx, "story-a"), "--json"]);
    assert.equal(withWriter.code, without.code);
    assert.equal(withWriter.out, without.out);
    assert.equal(withWriter.err, without.err);
  } finally {
    chmodSync(storyPath(fx, "story-c"), 0o644);
  }
});

// [band-wip#5]
test("band-wip contract 5: an epics folder that cannot be listed keeps the count, never 0 (failure)", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root lists every folder");
  const fx = fixture();
  hook(fx);
  const epics = join(fx.vault, "epics");
  chmodSync(epics, 0o300); // no listing; a named path still reaches its file
  try {
    const r = await cli(fx, ["session", "refresh", storyPath(fx, "story-a")]);
    assert.equal(r.code, 0, r.err);
    assert.equal(fileOf(fx), BODY);
  } finally {
    chmodSync(epics, 0o755);
  }
});

// ─── Contract 6: the SessionStart writer ───────────────────────────────

// [band-wip#6]
test("band-wip contract 6: stories in _templates and .hidden are not counted at SessionStart (edge)", () => {
  const fx = fixture({
    stories: {
      "PS-A/story-1": inProgress("story-1"),
      "_templates/story-t": inProgress("story-t"),
      ".hidden/story-h": inProgress("story-h"),
    },
  });
  hook(fx);
  assert.equal(JSON.parse(fileOf(fx)).count, 1);
});

// [band-wip#6]
test("band-wip contract 6: auto_inject false writes no file; a vault config that does not parse removes one (edge)", () => {
  const off = fixture({ binding: { auto_inject: false } });
  hook(off);
  assert.equal(fileOf(off), null);

  const bad = fixture();
  hook(bad);
  assert.equal(fileOf(bad), BODY);
  writeFileSync(join(bad.vault, ".projectstore.json"), "{ not json");
  hook(bad);
  assert.equal(fileOf(bad), null);
});

// ─── Contract 7: the verb writers ──────────────────────────────────────

const POLICY_STORIES = {
  ...BASE,
  "PS-X/story-p": planned("story-p"),
};

// [band-wip#7]
test("band-wip contract 7: move --write and handover --write write the new count; the vault is as after the same run with the writer off", async () => {
  // Each run starts from a stale file (a story moved by hand since the last
  // writer): the writer replaces it, and with the gate shut it stays.
  const STALE = '{"assignee":"Test","count":9,"awaiting_close":0,"limit":3}\n';
  const runBoth = async (args) => {
    const hashes = [];
    for (const band of [true, false]) {
      const fx = fixture({ stories: POLICY_STORIES, binding: band ? {} : { band: { enabled: false } } });
      mkdirSync(dirname(fx.wip), { recursive: true });
      writeFileSync(fx.wip, STALE);
      const r = await cli(fx, args);
      assert.equal(r.code, 0, r.out + r.err);
      hashes.push(treeHash(fx.vault, { times: true }));
      if (band) hashes.push(JSON.parse(fileOf(fx)));
      else assert.equal(fileOf(fx), STALE, "the gate shut: the file as it was");
    }
    return hashes;
  };
  // move only moves between the backlog and ToDo, so the count it writes is
  // the vault's as it stands; handover then moves all of Test's work away.
  const [m1, mFile, m2] = await runBoth(["move", "PS-X/story-p", "todo", "--reason", "next up", "--write"]);
  assert.equal(m1, m2, "move: the vault is byte-identical with and without the writer");
  assert.deepEqual(mFile, { assignee: ME, count: 2, awaiting_close: 1, limit: 3 });
  const [h1, hFile, h2] = await runBoth([
    "handover",
    "--from",
    ME,
    "--to",
    "Other Person",
    "--reason",
    "away",
    "--write",
  ]);
  assert.equal(h1, h2, "handover: the vault is byte-identical with and without the writer");
  assert.deepEqual(hFile, { assignee: ME, count: 0, awaiting_close: 0, limit: 3 });
});

// [band-wip#7]
test("band-wip contract 7: handover --write over three stories reads them for the file once, not once per story", async () => {
  const reads = [];
  for (const band of [true, false]) {
    const fx = fixture({
      stories: {
        "PS-X/story-a": inProgress("story-a"),
        "PS-X/story-b": inProgress("story-b"),
        "PS-X/story-p": planned("story-p"),
      },
      binding: band ? {} : { band: { enabled: false } },
    });
    const seam = counting();
    const r = await runHandover({
      values: { from: ME, to: "Other Person", reason: "away", write: true },
      cfg: fx.cfg,
      project: fx.proj,
      env: claudeEnv(fx.proj),
      confirm: null,
      read: seam,
    });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.result.items.length, 3);
    reads.push(seam.of(storyPath(fx, "story-a")));
  }
  assert.equal(reads[0] - reads[1], 1, `one more read of each story with the writer: ${reads}`);
});

// [band-wip#7]
test("band-wip contract 7: a run from a binding folder writes there, never to the project the environment names (edge)", async () => {
  const fx = fixture({ stories: POLICY_STORIES });
  const other = fixture();
  const r = await cli(fx, ["move", "PS-X/story-p", "todo", "--reason", "next up", "--write"], {
    env: claudeEnv(other.proj),
  });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(fx.wip), "the run's own project");
  assert.equal(existsSync(layoutPaths(other.proj).state), false, "the other project's state is untouched");
});

// [band-wip#7]
test("band-wip contract 7: bare runs, a refused move, next and doctor leave the file as it was (edge)", async () => {
  const fx = fixture({ stories: POLICY_STORIES });
  mkdirSync(dirname(fx.wip), { recursive: true });
  writeFileSync(fx.wip, "as it was\n");
  const runs = [
    ["move", "PS-X/story-p", "todo", "--reason", "next up"],
    ["move", "PS-X/story-d", "todo", "--reason", "refused", "--write"],
    ["handover", "--from", ME, "--to", "Other Person", "--reason", "away"],
    ["next", "--json"],
    ["doctor", "--vault", "--json"],
  ];
  for (const args of runs) {
    await cli(fx, args);
    assert.equal(fileOf(fx), "as it was\n", args.join(" "));
  }
});

// [band-wip#7]
test("band-wip contract 7: session refresh with no session id writes the file; one over a path outside the vault is refused and does not (edge)", async () => {
  const fx = fixture();
  const outside = join(mkdtempSync(join(tmpdir(), "ps-bw-out-")), "story-x.md");
  writeFileSync(outside, inProgress("story-x"));
  const refused = await cli(fx, ["session", "refresh", outside]);
  assert.equal(refused.code, 1);
  assert.equal(fileOf(fx), null);
  const r = await cli(fx, ["session", "refresh", storyPath(fx, "story-a")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No session id from the host: nothing written\./, "the output is as before");
  assert.equal(fileOf(fx), BODY);
});

// [band-wip#7]
test("band-wip contract 7: the plan ceremony runs session refresh in the main thread, as the close ceremony does, in the command and its Codex copies", () => {
  for (const rel of [
    "commands/story.md",
    "adapters/codex/skills/projectstore-story/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-story/SKILL.md",
  ]) {
    const md = read(join(REPO, rel));
    const step6 = md.indexOf("6. **On Yes** (undelegated path)");
    const step6a = md.indexOf("6a. **(close only) Reconcile**");
    assert.ok(step6 > 0 && step6a > step6, rel);
    const plan = md.slice(step6, step6a);
    assert.match(
      plan,
      /On a `plan`, right after the write, also refresh this session's story and,\s+where the band is on, the WIP count/,
      rel,
    );
    assert.match(plan, /session refresh "<story-path>"/, rel);
    assert.match(plan, /here in the main thread/, rel);
  }
});

// Source guard (no contract token: doctor would count it as coverage).
test("source guard: the band's WIP writer composes the counts itself and never imports next.mjs; its DEFAULT_LAYOUT is binding.mjs's", () => {
  const src = read(join(REPO, "scripts", "band-wip.mjs"));
  assert.doesNotMatch(src, /from\s+["']\.\/next\.mjs["']/);
  assert.match(src, /wipByPerson/);
  assert.match(src, /wipLimitOf/);
  assert.equal(DEFAULT_LAYOUT, BINDING_DEFAULT_LAYOUT);
});

// ─── Contract 8: lag ───────────────────────────────────────────────────

// [band-wip#8]
test("band-wip contract 8: a story moved by hand shows only after the next writer (edge)", async () => {
  const fx = fixture({ stories: POLICY_STORIES });
  hook(fx);
  assert.equal(fileOf(fx), BODY);
  const p = storyPath(fx, "story-p");
  writeFileSync(p, read(p).replace("status: planned", "status: in-progress"));
  assert.equal(fileOf(fx), BODY, "the old count until a writer runs");
  const r = await cli(fx, ["session", "refresh", p]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fileOf(fx), '{"assignee":"Test","count":3,"awaiting_close":1,"limit":3}\n');
});

// Nothing under the vault (contract 1): the hook and every verb writer.
// [band-wip#1]
test("band-wip contract 1: SessionStart and session refresh change no byte under the vault", async () => {
  // The same runs with the writer's gate shut (the band off) are the
  // baseline: SessionStart's own registration in the vault's .projectstore/
  // is not the WIP writer's, and it names the project, so it is left out.
  const hashes = [];
  for (const band of [true, false]) {
    const fx = fixture({ binding: band ? {} : { band: { enabled: false } } });
    hook(fx);
    await cli(fx, ["session", "refresh", storyPath(fx, "story-a")]);
    assert.equal(existsSync(fx.wip), band);
    rmSync(join(fx.vault, ".projectstore", "sessions"), { recursive: true, force: true });
    hashes.push(treeHash(fx.vault, { times: true }));
  }
  assert.equal(hashes[0], hashes[1]);
});

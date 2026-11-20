// projectstore — tests/flow-export.test.mjs: the `export` verb (PS-FLOW, "A
// read verb exports stories, epics and their status transitions as JSON,
// through the same readers doctor uses"; the spec "The export verb: stories,
// epics, status transitions and flow counts as one versioned JSON shape at
// one as-of instant", alias `export`).
//
// The verb runs in process through runExport and the bin's handler, with the
// `now`, `read` and `build` seams in the context, on fixture vaults from
// tests/fixtures/flow.mjs; doctor runs through doctorRun, flow.md through
// buildFlowView, the time-zone pair through the bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { run, HANDLERS, VERBS } from "../scripts/cli.mjs";
import { SCHEMA_VERSION, usage } from "../scripts/verbs.mjs";
import { runExport, buildExport, EXPORT_VERSION, DEFAULT_LAYOUT, EMAIL_SHAPED } from "../scripts/flow-export.mjs";
import { DEFAULT_LAYOUT as BINDING_DEFAULT_LAYOUT } from "../scripts/binding.mjs";
import { runNext } from "../scripts/next.mjs";
import { buildFlowView, flowModel } from "../scripts/flow-view.mjs";
import { readFlowStories } from "../scripts/flow-stories.mjs";
import { storyFacts, windowOf, windowCounts } from "../scripts/flow-counts.mjs";
import { isEmailAddress } from "../scripts/flow-policy.mjs";
import { setFm, appendLogLine, logLine } from "../scripts/status-log.mjs";
import { loadLayout } from "../scripts/lib.mjs";
import { childEnv, sourceHarness } from "../scripts/harness.mjs";
import {
  flowVault,
  storyText,
  closedStory,
  withLine,
  handOver,
  doctorRun,
  byCheck,
  exportGoldenVault,
  git,
  identity,
  ADDRESS,
  NOW,
  NOW_MS,
  DAY,
  daysAgo,
  dayOf,
} from "./fixtures/flow.mjs";
import {
  closure,
  hookEntries,
  verbModuleSpecifiers,
  importSpecifiers,
  dynamicSpecifiers,
} from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const AS_OF = "2026-11-11";
const at = (s) => `${s}:00.000Z`;

// ─── Stories, as the gates and follow leave them ───────────────────────

const inProgress = (id, assignee, days, epic = "PS-X") =>
  storyText({ id, epic, assignee, log: [{ to: "in-progress", at: daysAgo(days) }] });
const inReview = (id, assignee, days, epic = "PS-X") =>
  storyText({
    id,
    epic,
    assignee,
    log: [
      { to: "in-progress", at: daysAgo(days + 1) },
      { to: "review", at: daysAgo(days) },
    ],
  });
const awaiting = (id, assignee, days) =>
  withLine(inReview(id, assignee, days + 1), {
    at: daysAgo(days),
    from: "review",
    to: "review",
    reason: "merged, awaiting evidence",
  });
const byHand = (id, status, extra = {}) => storyText({ id, status, ...extra });
const oneInEach = () => ({
  "PS-X/story-backlog": storyText({ id: "story-backlog" }),
  "PS-X/story-todo": byHand("story-todo", "todo"),
  "PS-X/story-doing": inProgress("story-doing", "Ada", 30),
  "PS-X/story-review": byHand("story-review", "review", { assignee: "Bo" }),
  "PS-X/story-done": byHand("story-done", "done", { fm: { closed_at: JSON.stringify(daysAgo(5)) } }),
});

// ─── Running it ────────────────────────────────────────────────────────

// runExport with the test's clock (NOW) unless the values name --as-of.
const exp = (fx, values = { "as-of": AS_OF }, seams = {}) =>
  runExport({ values, cfg: fx.cfg, project: fx.proj, now: NOW, ...seams });

async function resultOf(fx, values, seams) {
  const r = await exp(fx, values, seams);
  assert.equal(r.code, 0, JSON.stringify(r.result));
  assert.equal(r.ok, true);
  return r.result;
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

// Through the bin's run(), as a person runs it.
async function bin(proj, args = []) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["export", ...args, "--project", proj], {
    env: { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  return { code, out: stdout.text, err: stderr.text, json: stdout.text ? JSON.parse(stdout.text) : null };
}

// Through the handler the bin dispatches to, with a test's seams.
async function handle(fx, values = { "as-of": AS_OF }, seams = {}) {
  const stdout = sink();
  const stderr = sink();
  const row = VERBS.find((v) => v.verb === "export");
  const code = await HANDLERS.export({ row, values, cfg: fx.cfg, project: fx.proj, stdout, stderr, ...seams });
  return { code, out: stdout.text, err: stderr.text };
}

// Every file under a directory, by its path, with its bytes.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

// The page's model, as buildFlowView builds it.
function pageModel(fx) {
  let m = null;
  buildFlowView(fx.cfg, loadLayout("engineering"), { model: (...a) => (m = flowModel(...a)) });
  return m;
}

const put = (vault, rel, text) => {
  mkdirSync(dirname(join(vault, rel)), { recursive: true });
  writeFileSync(join(vault, rel), text);
};
const paths = (rows) => rows.map((r) => r.path);
const keys = (o) => Object.keys(o);

// ─── Contract 1: the verb, its exits, and no writes ────────────────────

// [export#1]
test("export: bare and with --json, on a vault with a story in every column, both exit 0 with the same bytes, an envelope with verb export and ok true, and no file changes", async () => {
  const fx = flowVault({ stories: oneInEach() });
  const before = snapshot(fx.proj);
  const bare = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(bare.code, 0, bare.err);
  assert.deepEqual(snapshot(fx.proj), before);
  const json = await bin(fx.proj, ["--as-of", AS_OF, "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(snapshot(fx.proj), before);
  assert.equal(bare.out, json.out);
  assert.equal(bare.json.verb, "export");
  assert.equal(bare.json.ok, true);
  assert.equal(bare.json.project, fx.proj);
  assert.equal(bare.err, "");
  assert.ok(existsSync(join(fx.proj, ".projectstore", "projectstore.json")));
});

// [export#1]
test("export: a binding whose vault directory is gone exits 1 with ok false and an error naming the vault path, also on stderr; a project with no binding exits 3 with an envelope only under --json (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  rmSync(fx.vault, { recursive: true, force: true });
  for (const args of [[], ["--json"]]) {
    const r = await bin(fx.proj, args);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.deepEqual(keys(r.json.result), ["error"]);
    assert.ok(r.json.result.error.includes(fx.vault), r.json.result.error);
    assert.ok(r.err.includes(fx.vault), r.err);
  }
  const loose = mkdtempSync(join(tmpdir(), "ps-export-unbound-"));
  const bare = await bin(loose);
  assert.equal(bare.code, 3);
  assert.equal(bare.out, "");
  assert.ok(bare.err.length > 0);
  const json = await bin(loose, ["--json"]);
  assert.equal(json.code, 3);
  assert.equal(json.json.ok, false);
  assert.equal(json.json.verb, "export");
});

// [export#1]
test("export: a build seam that throws exits 1, prints the envelope with ok false and result {error}, and puts the message on stderr (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  const r = await handle(
    fx,
    { "as-of": AS_OF },
    {
      build: () => {
        throw new Error("planted failure");
      },
    },
  );
  assert.equal(r.code, 1);
  const env = JSON.parse(r.out);
  assert.equal(env.ok, false);
  assert.equal(env.verb, "export");
  assert.deepEqual(keys(env.result), ["error"]);
  assert.match(env.result.error, /planted failure/);
  assert.match(r.err, /planted failure/);
});

// [export#1]
test("export: a vault with no story and no flow block exits 0 with empty stories, epics, transitions and WIP, and a null window and epics without movement (edge)", async () => {
  const fx = flowVault({});
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  const x = r.json.result;
  assert.deepEqual([x.stories, x.epics, x.transitions, x.counts.wip], [[], [], [], []]);
  assert.equal(x.counts.window, null);
  assert.equal(x.counts.idle_epics, null);
  assert.deepEqual(x.notes, []);
});

// [export#1]
test("export: a layout with no epic folder, and one that does not load, exit 1 with ok false and the reason (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  const none = await handle(fx, { "as-of": AS_OF }, { load: () => ({ folders: [] }) });
  assert.equal(none.code, 1);
  assert.match(JSON.parse(none.out).result.error, /has no epic folder/);
  const broken = await handle(
    fx,
    { "as-of": AS_OF },
    {
      load: () => {
        throw new Error("no such layout");
      },
    },
  );
  assert.equal(broken.code, 1);
  assert.match(JSON.parse(broken.out).result.error, /does not load: no such layout/);
  assert.match(broken.err, /no such layout/);
});

// [export#1]
test("export: the verb table's row holds the contract's values, ADVANCED names it after groom, no group names it, and no commands/export.md exists", () => {
  const row = VERBS.find((v) => v.verb === "export");
  assert.ok(row);
  assert.equal(row.module, "./flow-export.mjs");
  assert.equal(row.wraps, "new");
  assert.equal(row.how, "import");
  assert.equal(row.output, "envelope");
  assert.equal(row.writes, false);
  assert.equal(row.requiresBinding, true);
  assert.deepEqual([...row.mcp], []);
  assert.deepEqual([...row.usage], []);
  assert.deepEqual(
    row.options.map((o) => o.name),
    ["as-of", "json"],
  );
  assert.equal(row.summary, "Print stories, epics, status changes and flow counts as JSON.");
  assert.equal(VERBS.indexOf(row), VERBS.findIndex((v) => v.verb === "groom") + 1);
  const lines = usage({}).split("\n");
  const from = lines.indexOf("ADVANCED");
  const adv = lines
    .slice(from + 1, lines.indexOf("", from))
    .join(" ")
    .split("·")
    .map((s) => s.trim());
  assert.equal(adv.indexOf("export"), adv.indexOf("groom") + 1);
  assert.equal(lines.slice(0, from).filter((l) => /^ {2}export\b/.test(l)).length, 0, "no named group lists export");
  assert.ok(!existsSync(join(REPO, "commands", "export.md")));
});

// ─── Contract 2: the as-of instant ─────────────────────────────────────

// [export#2]
test("as-of: with --as-of 2026-11-18 and the clock two days apart on two runs, the outputs are byte-identical and as_of is that day's 00:00Z", async () => {
  const fx = flowVault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const a = await handle(fx, { "as-of": "2026-11-18" }, { now: "2026-11-11T12:00:00.000Z" });
  const b = await handle(fx, { "as-of": "2026-11-18" }, { now: "2026-11-13T12:00:00.000Z" });
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, b.out);
  assert.equal(JSON.parse(a.out).result.as_of, "2026-11-18T00:00:00.000Z");
});

// [export#2]
test("as-of: with no --as-of, as_of is the clock's instant, and the window totals equal the numbers doctor's intake-over-close names in the same ISO week", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-old": storyText({ id: "story-old" }),
      "PS-X/story-new1": storyText({ id: "story-new1", created: "2026-10-27" }),
      "PS-X/story-new2": storyText({ id: "story-new2", created: "2026-11-03" }),
      "PS-X/story-new3": storyText({ id: "story-new3", created: "2026-11-04" }),
      "PS-X/story-closed": closedStory({
        id: "story-closed",
        start: at("2026-10-27T10:00"),
        close: at("2026-11-02T10:00"),
      }),
    },
  });
  const x = await resultOf(fx, {}, { now: NOW });
  assert.equal(x.as_of, NOW);
  const f = byCheck(doctorRun(fx, { now: "2026-11-13T08:00:00.000Z" }), "intake-over-close");
  assert.equal(f.length, 1);
  const m = f[0].message.match(/(\d+) stories were created and (\d+) closed/);
  assert.deepEqual([x.counts.window.created, x.counts.window.closed], [Number(m[1]), Number(m[2])]);
  assert.deepEqual([x.counts.window.created, x.counts.window.closed], [3, 1]);
});

// [export#2]
test("as-of: 2026-11-11T09:00, 2026-11-11T14:00+05:00 and 2026-11-11T09:00:00.000Z under Pacific/Kiritimati and America/Los_Angeles give one as_of and six byte-identical outputs (edge)", () => {
  const fx = flowVault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const outs = [];
  for (const TZ of ["Pacific/Kiritimati", "America/Los_Angeles"])
    for (const v of ["2026-11-11T09:00", "2026-11-11T14:00+05:00", "2026-11-11T09:00:00.000Z"]) {
      const r = spawnSync(
        process.execPath,
        [join(REPO, "bin", "projectstore.mjs"), "export", "--as-of", v, "--project", fx.proj],
        { cwd: fx.proj, env: childEnv({ ...process.env, TZ }, { projectRoot: fx.proj }), encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      outs.push(r.stdout);
    }
  assert.equal(JSON.parse(outs[0]).result.as_of, "2026-11-11T09:00:00.000Z");
  for (const o of outs) assert.equal(o, outs[0]);
});

// [export#2]
test("as-of: 2026-02-30, soon, a blank and 9999-12-31T23:00-02:00 each exit 2 with ok false and an error, and stderr names the two forms (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  for (const v of ["2026-02-30", "soon", " ", "9999-12-31T23:00-02:00"]) {
    const r = await bin(fx.proj, ["--as-of", v]);
    assert.equal(r.code, 2, v);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.verb, "export");
    assert.equal(typeof r.json.result.error, "string");
    assert.ok(r.err.includes("a date (2026-11-16)") && r.err.includes("a date and time (2026-11-16T09:30"), r.err);
  }
});

// [export#2]
test("as-of: one vault with flow.window_weeks and flow.age_days.epic_idle, as of 2026-11-11 and 2026-11-25, differs only in as_of, counts.window and counts.idle_epics (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2, age_days: { epic_idle: 14 }, people: { Ada: { wip: 2 } } } },
    stories: {
      ...oneInEach(),
      "PS-Y/story-y": closedStory({
        id: "story-y",
        epic: "PS-Y",
        start: at("2026-11-03T10:00"),
        close: at("2026-11-05T10:00"),
      }),
    },
  });
  const a = await resultOf(fx, { "as-of": "2026-11-11" });
  const b = await resultOf(fx, { "as-of": "2026-11-25" });
  for (const k of ["as_of"]) assert.notDeepEqual(a[k], b[k]);
  assert.notDeepEqual(a.counts.window, b.counts.window);
  assert.notDeepEqual(a.counts.idle_epics, b.counts.idle_epics);
  const rest = (x) => ({ ...x, as_of: null, counts: { ...x.counts, window: null, idle_epics: null } });
  assert.deepEqual(rest(a), rest(b));
});

// [export#2]
test("as-of: with N of 14 and a page whose newest stamp is 2026-11-19T15:00Z, the page lists an epic quiet since 2026-11-05T12:00Z at 14 days and the export as of 2026-11-19 does not; week rows, totals and median are equal (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2, age_days: { epic_idle: 14 } } },
    stories: {
      "PS-A/story-a": storyText({
        id: "story-a",
        epic: "PS-A",
        log: [{ to: "in-progress", at: at("2026-11-05T12:00") }],
      }),
      "PS-Z/story-w": closedStory({
        id: "story-w",
        epic: "PS-Z",
        start: at("2026-11-03T10:00"),
        close: at("2026-11-06T10:00"),
      }),
      "PS-Z/story-z": closedStory({
        id: "story-z",
        epic: "PS-Z",
        start: at("2026-11-10T10:00"),
        close: at("2026-11-19T15:00"),
      }),
    },
    epics: { "PS-A": "in-progress", "PS-Z": "done" },
  });
  const m = pageModel(fx);
  assert.equal(m.asOf, Date.parse("2026-11-19T15:00:00.000Z"));
  assert.deepEqual(
    m.idle.epics.map((e) => [e.epic, e.days]),
    [["PS-A", 14]],
  );
  const x = await resultOf(fx, { "as-of": "2026-11-19" });
  assert.deepEqual(x.counts.idle_epics.epics, []);
  assert.equal(x.counts.idle_epics.watched, 1);
  const w = x.counts.window;
  assert.deepEqual(
    w.weekly,
    m.window.weeks.map((r) => ({ from: new Date(r.from).toISOString(), created: r.created, closed: r.closed })),
  );
  assert.deepEqual(
    [w.created, w.closed, w.closed_unstamped],
    [m.window.created, m.window.closed, m.window.closedUnstamped],
  );
  assert.equal(w.cycle_time.median, m.window.cycle.median);
});

// ─── Contract 3: the envelope, the result, and export_version ──────────

// [export#3]
test("shape: result's keys are the eight in order, every row's and object's keys are its contract's list, export_version is EXPORT_VERSION 1 and schema_version is SCHEMA_VERSION", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2, age_days: { epic_idle: 14 } } },
    stories: oneInEach(),
  });
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(keys(r.json), ["schema_version", "verb", "project", "ok", "result"]);
  assert.equal(r.json.schema_version, SCHEMA_VERSION);
  const x = r.json.result;
  assert.deepEqual(keys(x), [
    "export_version",
    "as_of",
    "stories",
    "epics",
    "transitions",
    "counts",
    "unread",
    "notes",
  ]);
  assert.equal(x.export_version, EXPORT_VERSION);
  assert.equal(EXPORT_VERSION, 1);
  for (const s of x.stories) {
    assert.deepEqual(keys(s), [
      "ref",
      "path",
      "id",
      "epic",
      "title",
      "status",
      "column",
      "priority",
      "assignee",
      "awaiting_close",
      "created",
      "started_at",
      "closed_at",
      "updated",
      "status_since",
    ]);
    assert.deepEqual(keys(s.status_since), ["at", "source", "trusted"]);
  }
  assert.deepEqual(
    x.stories.map((s) => s.column),
    ["Backlog", "In Progress", "Done", "Review", "ToDo"],
  );
  assert.equal(x.epics.length, 1);
  assert.deepEqual(keys(x.epics[0]), [
    "epic",
    "path",
    "id",
    "title",
    "status",
    "priority",
    "initiative",
    "created",
    "updated",
  ]);
  assert.equal(x.transitions.length, 1);
  assert.deepEqual(keys(x.transitions[0]), ["ref", "path", "at", "from", "to", "reason", "actor"]);
  assert.deepEqual(keys(x.counts), ["wip", "window", "idle_epics"]);
  assert.deepEqual(keys(x.counts.wip[0]), ["assignee", "held", "awaiting", "limit"]);
  const w = x.counts.window;
  assert.deepEqual(keys(w), [
    "weeks",
    "from",
    "to",
    "created",
    "closed",
    "closed_unstamped",
    "young",
    "weekly",
    "omitted_weeks",
    "cycle_time",
  ]);
  assert.deepEqual(keys(w.weekly[0]), ["from", "created", "closed"]);
  assert.deepEqual(keys(w.cycle_time), ["closed", "median", "days", "unplaced"]);
  assert.deepEqual(keys(x.counts.idle_epics), ["threshold_days", "watched", "epics"]);
  assert.deepEqual(keys(x.counts.idle_epics.epics[0]), ["epic", "path", "days", "last_change"]);
  assert.deepEqual(keys(x.counts.idle_epics.epics[0].last_change), ["at", "source", "field"]);
  assert.deepEqual(keys(x.unread), ["stories", "epics"]);
  assert.ok(x.notes.length > 0);
  for (const n of x.notes) assert.deepEqual(keys(n), ["code", "count", "text"]);
});

// [export#3]
test("shape: the golden fixture vault's result as of 2026-11-11, indented by 2, is byte-identical to tests/fixtures/export-result.json", async () => {
  const fx = exportGoldenVault();
  const x = await resultOf(fx, { "as-of": "2026-11-11" });
  assert.equal(
    JSON.stringify(x, null, 2) + "\n",
    read(join(REPO, "tests", "fixtures", "export-result.json")),
    "a change to the golden's bytes needs an export_version bump or a stated rewrite (the export spec, contract 3)",
  );
});

// [export#3]
test("shape: a story with no id, title, status, priority, assignee and started_at holds each of those keys with null (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-bare": "---\ntype: story\ncreated: 2026-09-01\n---\n\n# Bare\n" } });
  const x = await resultOf(fx);
  const row = x.stories.find((s) => s.ref === "PS-X/story-bare");
  for (const k of ["id", "title", "status", "priority", "assignee", "started_at"]) assert.equal(row[k], null, k);
  assert.equal(row.column, null);
});

// [export#3]
test("shape: created 2026-11-10, closed_at 2026-11-11T09:00 and started_at 2026-02-30 read as 2026-11-10T00:00:00.000Z, 2026-11-11T09:00:00.000Z and null (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-t": storyText({
        id: "story-t",
        created: "2026-11-10",
        fm: { closed_at: JSON.stringify("2026-11-11T09:00"), started_at: "2026-02-30" },
      }),
    },
  });
  const row = (await resultOf(fx)).stories[0];
  assert.deepEqual(
    [row.created, row.closed_at, row.started_at],
    ["2026-11-10T00:00:00.000Z", "2026-11-11T09:00:00.000Z", null],
  );
});

// ─── Contract 4: story and epic rows, and their keys ───────────────────

// [export#4]
test("rows: a flat story, a story folder with a README.md and a standalone story-*.md are listed in the readers' order, a story under epics/_templates/ is not, and an epic folder with no epic.md has story rows and no epic row (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-flat": storyText({ id: "story-flat" }) } });
  put(fx.vault, "epics/PS-X/stories/story-dir/README.md", storyText({ id: "story-dir" }));
  put(fx.vault, "epics/PS-X/story-alone.md", storyText({ id: "story-alone" }));
  put(fx.vault, "epics/_templates/stories/story-tpl.md", storyText({ id: "story-tpl" }));
  put(fx.vault, "epics/C/stories/story-c.md", storyText({ id: "story-c", epic: "C" }));
  const x = await resultOf(fx);
  const order = readFlowStories(fx.vault, "epics").stories.map((s) => s.rel);
  assert.deepEqual(paths(x.stories), order);
  assert.deepEqual(paths(x.stories).sort(), [
    "epics/C/stories/story-c.md",
    "epics/PS-X/stories/story-dir/README.md",
    "epics/PS-X/stories/story-flat.md",
    "epics/PS-X/story-alone.md",
  ]);
  assert.deepEqual(
    x.stories.map((s) => s.ref),
    ["C/story-c", "PS-X/story-dir", "PS-X/story-flat", "PS-X/story-alone"],
  );
  assert.deepEqual(
    x.epics.map((e) => e.epic),
    ["PS-X"],
  );
});

// [export#4]
test("rows: a parked story has column null, one written in_progress keeps that status in the In Progress column, and two stories in different epics with one id are two rows (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-parked": byHand("story-parked", "parked"),
      "PS-X/story-under": byHand("story-under", "in_progress"),
      "PS-X/story-same": storyText({ id: "story-same" }),
      "PS-Y/story-same": storyText({ id: "story-same", epic: "PS-Y" }),
    },
  });
  const x = await resultOf(fx);
  const by = (ref) => x.stories.find((s) => s.ref === ref);
  assert.equal(by("PS-X/story-parked").column, null);
  assert.equal(by("PS-X/story-parked").status, "parked");
  assert.equal(by("PS-X/story-under").status, "in_progress");
  assert.equal(by("PS-X/story-under").column, "In Progress");
  const same = x.stories.filter((s) => s.id === "story-same");
  assert.equal(same.length, 2);
  assert.notEqual(same[0].path, same[1].path);
});

// [export#4]
test("rows: story A/story-x with id story-test and two log lines, renamed to story-y and then moved to epic B, keeps its id while ref and path follow and both transitions come under each new path (edge)", async () => {
  const fx = flowVault({ epics: { A: "in-progress" } });
  const text = storyText({
    id: "story-test",
    epic: "A",
    log: [
      { to: "in-progress", at: at("2026-11-02T10:00") },
      { to: "review", at: at("2026-11-04T10:00") },
    ],
  });
  put(fx.vault, "epics/A/stories/story-x.md", text);
  const seen = [];
  const look = async () => {
    const x = await resultOf(fx);
    assert.equal(x.stories.length, 1);
    const s = x.stories[0];
    seen.push([s.ref, s.path, s.id]);
    assert.deepEqual(
      x.transitions.map((t) => [t.ref, t.path, t.to]),
      [
        [s.ref, s.path, "in-progress"],
        [s.ref, s.path, "review"],
      ],
    );
  };
  await look();
  renameSync(join(fx.vault, "epics/A/stories/story-x.md"), join(fx.vault, "epics/A/stories/story-y.md"));
  await look();
  mkdirSync(join(fx.vault, "epics/B/stories"), { recursive: true });
  renameSync(join(fx.vault, "epics/A/stories/story-y.md"), join(fx.vault, "epics/B/stories/story-y.md"));
  await look();
  assert.deepEqual(seen, [
    ["A/story-x", "epics/A/stories/story-x.md", "story-test"],
    ["A/story-y", "epics/A/stories/story-y.md", "story-test"],
    ["B/story-y", "epics/B/stories/story-y.md", "story-test"],
  ]);
});

// [export#4]
test("rows: an epic's priority, a story's and an epic's blank id, title and initiative: the epic priority is printed as written, the blanks are null (edge)", async () => {
  const fx = flowVault({
    stories: { "PS-X/story-blank": storyText({ id: "story-blank", fm: { id: '""', title: '"  "' } }) },
    epics: { "PS-X": { title: '""', fm: { id: '""', priority: '" P1 "', initiative: '""' } } },
  });
  // The epic's own id line is written twice by the fixture; drop the first so the blank one reads.
  const ep = join(fx.vault, "epics", "PS-X", "epic.md");
  writeFileSync(ep, read(ep).replace('id: "PS-X"\n', ""));
  const x = await resultOf(fx);
  const s = x.stories[0];
  assert.deepEqual([s.id, s.title], [null, null]);
  const e = x.epics[0];
  assert.deepEqual([e.id, e.title, e.initiative], [null, null, null]);
  assert.equal(e.priority, " P1 ");
});

// ─── Contract 5: transitions, from the Status log only ─────────────────

// A `status:` line as this test reads it, apart from parseStatusLog.
const STATUS_LINE = /^- (\d{4}-\d\d-\d\dT[^ ]+) status: (.*?) → (.*?) — (.*) \(([^()]+)\)\s*$/;
const ownLines = (text) =>
  text
    .split("\n")
    .map((l) => l.match(STATUS_LINE))
    .filter(Boolean)
    .map((m) => ({ at: new Date(m[1]).toISOString(), from: m[2], to: m[3], reason: m[4], actor: m[5] }));

function loggedStory() {
  let t = storyText({
    id: "story-log",
    assignee: "Ada",
    log: [{ to: "in-progress", at: at("2026-11-05T10:00"), reason: "work started", actor: "plan gate" }],
  });
  t = handOver(t, { to: "Bo", at: at("2026-11-06T10:00") });
  t = appendLogLine(
    t,
    logLine({ at: at("2026-11-07T10:00"), field: "pr", from: "none", to: "pull/1", reason: "opened", actor: "follow" }),
  );
  return withLine(t, { at: at("2026-11-03T10:00"), from: "in-progress", to: "review", reason: "out of order" });
}

// [export#5]
test("transitions: two status lines out of time order, an assignee line and a pr line give two transitions in the log's order, each equal to its line", async () => {
  const text = loggedStory();
  const fx = flowVault({ stories: { "PS-X/story-log": text } });
  const x = await resultOf(fx);
  const own = ownLines(text);
  assert.equal(own.length, 2);
  assert.deepEqual(
    x.transitions.map(({ at: a, from, to, reason, actor }) => ({ at: a, from, to, reason, actor })),
    own,
  );
  assert.deepEqual(
    x.transitions.map((t) => t.at),
    ["2026-11-05T10:00:00.000Z", "2026-11-03T10:00:00.000Z"],
  );
  for (const t of x.transitions)
    assert.deepEqual([t.ref, t.path], ["PS-X/story-log", "epics/PS-X/stories/story-log.md"]);
});

// [export#5]
test("transitions: a status then set by hand in the frontmatter adds no transition, and the row's status and column follow it (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-log": loggedStory() } });
  const before = await resultOf(fx);
  const p = join(fx.vault, "epics/PS-X/stories/story-log.md");
  writeFileSync(p, setFm(read(p), "status", "done"));
  const after = await resultOf(fx);
  assert.deepEqual(after.transitions, before.transitions);
  assert.deepEqual([after.stories[0].status, after.stories[0].column], ["done", "Done"]);
});

// [export#5]
test("transitions: a hand-written line status: planned → parked — test with no (actor) gives no transition, and log-lines-unread counts 1 (edge)", async () => {
  const t = appendLogLine(
    storyText({ id: "story-hand" }),
    `- ${at("2026-11-05T10:00")} status: planned → parked — test`,
  );
  const fx = flowVault({ stories: { "PS-X/story-hand": t } });
  const x = await resultOf(fx);
  assert.deepEqual(x.transitions, []);
  const note = x.notes.find((n) => n.code === "log-lines-unread");
  assert.equal(note.count, 1);
});

// [export#5]
test("transitions: a fixture vault run once, then made a git repository with one commit of the same files, gives byte-identical outputs (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: { ...oneInEach(), "PS-X/story-log": loggedStory() },
  });
  const plain = await handle(fx);
  assert.equal(plain.code, 0, plain.err);
  git(fx.vault, ["init", "-q"]);
  git(fx.vault, ["add", "-A"]);
  git(fx.vault, ["commit", "-q", "-m", "vault"], identity({ author: "First Last", at: NOW }));
  assert.ok(existsSync(join(fx.vault, ".git")));
  const repo = await handle(fx);
  assert.equal(repo.out, plain.out);
});

// ─── Contract 6: WIP per person ────────────────────────────────────────

// [export#6]
test("wip: A with two In Progress stories, one awaiting close and a limit of 3, and B with one Review story, give A 2 1 3 then B 1 0 null", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { people: { Ada: { wip: 3 } } } },
    stories: {
      "PS-X/story-a1": inProgress("story-a1", "Ada", 3),
      "PS-X/story-a2": inProgress("story-a2", "Ada", 4),
      "PS-X/story-a3": awaiting("story-a3", "Ada", 1),
      "PS-X/story-b1": inReview("story-b1", "Bo", 2),
    },
  });
  const x = await resultOf(fx);
  assert.deepEqual(x.counts.wip, [
    { assignee: "Ada", held: 2, awaiting: 1, limit: 3 },
    { assignee: "Bo", held: 1, awaiting: 0, limit: null },
  ]);
});

// [export#6]
test("wip: constructor and __proto__, each with one In Progress story, give two rows in a vault with a flow block and in one without, __proto__'s limit null and every limit null in the second (edge)", async () => {
  const stories = {
    "PS-X/story-c": inProgress("story-c", "constructor", 2),
    "PS-X/story-p": inProgress("story-p", "__proto__", 2),
  };
  const withFlow = await resultOf(flowVault({ vaultCfg: { flow: { people: { constructor: { wip: 2 } } } }, stories }));
  assert.deepEqual(withFlow.counts.wip, [
    { assignee: "__proto__", held: 1, awaiting: 0, limit: null },
    { assignee: "constructor", held: 1, awaiting: 0, limit: 2 },
  ]);
  const bare = await resultOf(flowVault({ stories }));
  assert.deepEqual(
    bare.counts.wip.map((w) => [w.assignee, w.limit]),
    [
      ["__proto__", null],
      ["constructor", null],
    ],
  );
});

// [export#6]
test("wip: held and awaiting are the same in export, next --json and the page for the same person", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { people: { Ada: { wip: 3 } } } },
    stories: {
      "PS-X/story-a1": inProgress("story-a1", "Ada", 3),
      "PS-X/story-a2": inReview("story-a2", "Ada", 4),
      "PS-X/story-a3": awaiting("story-a3", "Ada", 1),
    },
  });
  const x = await resultOf(fx);
  const nx = await runNext({ values: { assignee: "Ada" }, cfg: fx.cfg, project: fx.proj, now: NOW });
  const page = pageModel(fx).wip.find((w) => w.name === "Ada");
  const row = x.counts.wip.find((w) => w.assignee === "Ada");
  assert.deepEqual([row.held, row.awaiting], [nx.result.wip.held, nx.result.wip.awaiting]);
  assert.deepEqual([row.held, row.awaiting], [page.held, page.awaiting]);
  assert.deepEqual([row.held, row.awaiting], [2, 1]);
});

// ─── Contract 7: the window, totals, weeks and cycle time ──────────────

function intakeVault() {
  return flowVault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-old": storyText({ id: "story-old", updated: "2026-11-11" }),
      "PS-X/story-n1": storyText({ id: "story-n1", created: "2026-10-27" }),
      "PS-X/story-n2": storyText({ id: "story-n2", created: "2026-10-28" }),
      "PS-X/story-n3": storyText({ id: "story-n3", created: "2026-10-29" }),
      "PS-X/story-n4": storyText({ id: "story-n4", created: "2026-11-03" }),
      "PS-X/story-c1": closedStory({ id: "story-c1", start: at("2026-10-20T10:00"), close: at("2026-10-27T10:00") }),
      "PS-X/story-c2": closedStory({ id: "story-c2", start: at("2026-10-20T10:00"), close: at("2026-10-30T10:00") }),
      "PS-X/story-c3": closedStory({ id: "story-c3", start: at("2026-10-20T10:00"), close: at("2026-11-04T10:00") }),
    },
  });
}

// [export#7]
test("window: W of 2 as of 2026-11-11T12:00Z gives weekly 3 2 and 1 1, totals 4 and 3, as doctor's intake-over-close names them and as the page's totals row reads", async () => {
  const fx = intakeVault();
  const x = await resultOf(fx, { "as-of": "2026-11-11T12:00:00Z" });
  const w = x.counts.window;
  assert.deepEqual(w.weekly, [
    { from: "2026-10-26T00:00:00.000Z", created: 3, closed: 2 },
    { from: "2026-11-02T00:00:00.000Z", created: 1, closed: 1 },
  ]);
  assert.deepEqual(
    [w.created, w.closed, w.from, w.to, w.young, w.omitted_weeks],
    [4, 3, "2026-10-26T00:00:00.000Z", "2026-11-09T00:00:00.000Z", false, 0],
  );
  const f = byCheck(doctorRun(fx, { now: "2026-11-11T12:00:00.000Z" }), "intake-over-close");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /4 stories were created and 3 closed/);
  const m = pageModel(fx);
  assert.equal(dayOf(new Date(m.asOf).toISOString()), "2026-11-11");
  assert.deepEqual([m.window.created, m.window.closed], [4, 3]);
});

// [export#7]
test("window: a close at 2026-11-08T23:59:59.999Z is in the week of 2026-11-02, and one at 2026-11-09T00:00:00.000Z is in no week and not in the totals (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-old": storyText({ id: "story-old" }),
      "PS-X/story-in": closedStory({
        id: "story-in",
        start: at("2026-11-02T10:00"),
        close: "2026-11-08T23:59:59.999Z",
      }),
      "PS-X/story-out": closedStory({
        id: "story-out",
        start: at("2026-11-02T10:00"),
        close: "2026-11-09T00:00:00.000Z",
      }),
    },
  });
  const w = (await resultOf(fx, { "as-of": "2026-11-11T12:00:00Z" })).counts.window;
  assert.deepEqual(
    w.weekly.map((r) => [r.from, r.closed]),
    [
      ["2026-10-26T00:00:00.000Z", 0],
      ["2026-11-02T00:00:00.000Z", 1],
    ],
  );
  assert.equal(w.closed, 1);
});

// [export#7]
test("window: W of 200 as of 2026-11-11 with stories created and closed in each of the 200 weeks lists the last 104 weeks, omits 96, and the totals equal windowCounts over the 200 weeks (edge)", async () => {
  const win = windowOf(Date.parse("2026-11-11"), 200);
  const stories = {};
  for (let k = 0; k < 200; k++) {
    const monday = win.from + k * 7 * DAY;
    const iso = (ms) => new Date(ms).toISOString();
    stories[`PS-X/story-w${k}`] = closedStory({
      id: `story-w${k}`,
      created: dayOf(iso(monday + DAY)),
      start: iso(monday + DAY + 3600000),
      close: iso(monday + 2 * DAY),
    });
  }
  const fx = flowVault({ vaultCfg: { flow: { window_weeks: 200 } }, stories });
  const w = (await resultOf(fx, { "as-of": "2026-11-11" })).counts.window;
  assert.equal(w.weekly.length, 104);
  assert.equal(w.omitted_weeks, 96);
  const facts = readFlowStories(fx.vault, "epics").stories.map(storyFacts);
  const total = windowCounts(facts, win);
  assert.deepEqual([w.created, w.closed], [total.created.length, total.closed.length]);
  assert.deepEqual([w.created, w.closed], [200, 200]);
  assert.equal(w.weekly[0].from, new Date(win.from + 96 * 7 * DAY).toISOString());
});

// [export#7]
test("window: as of 2026-11-11, a vault whose earliest date is 2026-10-01 with W of 1000000 and of 9000000000000000 exits 0 promptly, weekly from the week of 2026-09-28, young, cycle_time and window.from null (edge)", async () => {
  for (const weeks of [1000000, 9000000000000000]) {
    const fx = flowVault({
      vaultCfg: { flow: { window_weeks: weeks } },
      stories: { "PS-X/story-a": storyText({ id: "story-a", created: "2026-10-01" }) },
    });
    const w = (await resultOf(fx, { "as-of": "2026-11-11" })).counts.window;
    assert.equal(w.weeks, weeks);
    assert.equal(w.weekly[0].from, "2026-09-28T00:00:00.000Z");
    assert.equal(w.weekly.at(-1).from, "2026-11-02T00:00:00.000Z");
    assert.equal(w.young, true);
    assert.equal(w.cycle_time, null);
    assert.equal(w.from, null);
    assert.equal(w.to, "2026-11-09T00:00:00.000Z");
  }
});

// [export#7]
test("window: W of 2 and four closes, three placed 2, 5 and 9 days after their start and one with no start, give cycle_time 4, median 5, days [2, 5, 9] and the fourth's path, as doctor's flow-cycle-time names (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-old": storyText({ id: "story-old" }),
      "PS-X/story-d2": closedStory({ id: "story-d2", start: at("2026-10-27T10:00"), close: at("2026-10-29T10:00") }),
      "PS-X/story-d5": closedStory({ id: "story-d5", start: at("2026-10-28T10:00"), close: at("2026-11-02T10:00") }),
      "PS-X/story-d9": closedStory({ id: "story-d9", start: at("2026-10-27T10:00"), close: at("2026-11-05T10:00") }),
      "PS-X/story-none": closedStory({ id: "story-none", start: null, close: at("2026-11-03T10:00") }),
    },
  });
  const c = (await resultOf(fx, { "as-of": NOW })).counts.window.cycle_time;
  assert.deepEqual(c, { closed: 4, median: 5, days: [2, 5, 9], unplaced: ["epics/PS-X/stories/story-none.md"] });
  const f = byCheck(doctorRun(fx, { now: NOW }), "flow-cycle-time");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /median \(the middle value\) of 5 days/);
  assert.deepEqual(f[0].stories, c.unplaced);
});

// ─── Contract 8: epics without movement ────────────────────────────────

// [export#8]
test("idle epics: at N of 14, epic A quiet for 14 days is listed from the log and B at 13 days is not, watched is 2, and doctor gives that one epic-idle only", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: {
      "A/story-a": storyText({ id: "story-a", epic: "A", log: [{ to: "in-progress", at: daysAgo(14) }] }),
      "B/story-b": storyText({ id: "story-b", epic: "B", log: [{ to: "in-progress", at: daysAgo(13) }] }),
    },
  });
  const i = (await resultOf(fx, { "as-of": NOW })).counts.idle_epics;
  assert.equal(i.threshold_days, 14);
  assert.equal(i.watched, 2);
  assert.deepEqual(i.epics, [
    { epic: "A", path: "epics/A/epic.md", days: 14, last_change: { at: daysAgo(14), source: "log", field: null } },
  ]);
  const d = byCheck(doctorRun(fx, { now: NOW }), "epic-idle");
  assert.deepEqual(
    d.map((f) => f.file),
    ["epics/A/epic.md"],
  );
});

// [export#8]
test("idle epics: with no flow.age_days.epic_idle, and then with 0, idle_epics is null and the epic rows are listed (edge)", async () => {
  const stories = {
    "A/story-a": storyText({ id: "story-a", epic: "A", log: [{ to: "in-progress", at: daysAgo(30) }] }),
  };
  for (const vaultCfg of [null, { flow: { age_days: { epic_idle: 0 } } }]) {
    const x = await resultOf(flowVault({ vaultCfg, stories }), { "as-of": NOW });
    assert.equal(x.counts.idle_epics, null);
    assert.deepEqual(
      x.epics.map((e) => e.epic),
      ["A"],
    );
  }
});

// [export#8]
test("idle epics: an in-progress epic whose stories have no status line, the newest closed_at 20 days before, is listed at 20 days from dates, field closed_at (edge)", async () => {
  const fx = flowVault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: { "A/story-a": byHand("story-a", "done", { epic: "A", fm: { closed_at: JSON.stringify(daysAgo(20)) } }) },
  });
  const e = (await resultOf(fx, { "as-of": NOW })).counts.idle_epics.epics[0];
  assert.deepEqual(
    [e.epic, e.days, e.last_change],
    ["A", 20, { at: daysAgo(20), source: "dates", field: "closed_at" }],
  );
});

// ─── Contract 9: notes, unread, and a run that never fails on the vault ─

// [export#9]
test("notes: a story with no Status log section, one with an empty section and one whose log holds only a pr line are listed with no transition, and no-status-log counts 3 and says history before the Status log is absent", async () => {
  const empty = storyText({ id: "story-empty" }).replace("## Technical Notes", "## Status log\n\n## Technical Notes");
  assert.ok(empty.includes("## Status log"));
  const pr = appendLogLine(
    storyText({ id: "story-pr" }),
    logLine({ at: at("2026-11-07T10:00"), field: "pr", from: "none", to: "pull/1", reason: "opened", actor: "follow" }),
  );
  const fx = flowVault({
    stories: { "PS-X/story-none": storyText({ id: "story-none" }), "PS-X/story-empty": empty, "PS-X/story-pr": pr },
  });
  const x = await resultOf(fx);
  assert.equal(x.stories.length, 3);
  assert.deepEqual(x.transitions, []);
  const note = x.notes.find((n) => n.code === "no-status-log");
  assert.equal(note.count, 3);
  assert.match(note.text, /^3 stories have no status line/);
  assert.match(note.text, /history from before stories carried a Status log is absent, not empty/);
});

// [export#9]
test("notes: a vault with no note's case gives an empty list; adding a story with no log, a line with no (actor), a masked assignee and flow.window_weeks of 0 gives four notes in order, each counting 1, and a null window (edge)", async () => {
  const logged = storyText({ id: "story-a", assignee: "Ada", log: [{ to: "in-progress", at: daysAgo(3) }] });
  const clean = await resultOf(flowVault({ stories: { "PS-X/story-a": logged } }));
  assert.deepEqual(clean.notes, []);
  const fx = flowVault({
    vaultCfg: { flow: { window_weeks: 0 } },
    stories: {
      "PS-X/story-a": appendLogLine(logged, `- ${at("2026-11-09T10:00")} status: in-progress → parked — test`),
      "PS-X/story-b": storyText({ id: "story-b", assignee: ADDRESS }),
    },
  });
  const x = await resultOf(fx);
  assert.deepEqual(
    x.notes.map((n) => [n.code, n.count]),
    [
      ["flow-policy-invalid", 1],
      ["no-status-log", 1],
      ["log-lines-unread", 1],
      ["email-shaped-assignee", 1],
    ],
  );
  assert.equal(x.counts.window, null);
  for (const n of x.notes) {
    assert.match(n.text, /^1 /, n.code);
    assert.ok(!n.text.includes(ADDRESS) && !n.text.includes("epics/") && !n.text.includes("npx"), n.text);
    assert.equal(n.text.split(/\.\s/).length, 1, `one sentence: ${n.text}`);
  }
});

// [export#9]
test("notes: a .projectstore.json in the vault that holds [1] exits 0, vault-config-unread counts 1, and the window and the epics without movement are null (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  writeFileSync(join(fx.vault, ".projectstore.json"), "[1]");
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  const x = r.json.result;
  assert.deepEqual(
    x.notes.filter((n) => n.code === "vault-config-unread").map((n) => n.count),
    [1],
  );
  assert.equal(x.notes[0].code, "vault-config-unread");
  assert.equal(x.counts.window, null);
  assert.equal(x.counts.idle_epics, null);
});

// [export#9]
test("unread: a read seam that throws for one story file and one epic.md exits 0 with unread {stories: 1, epics: 1}, and every other row is as without the seam (failure)", async () => {
  const fx = flowVault({
    stories: { ...oneInEach(), "PS-Y/story-y": storyText({ id: "story-y", epic: "PS-Y" }) },
  });
  const seam = (p) => {
    if (p.endsWith("story-todo.md") || p.endsWith(join("PS-Y", "epic.md"))) throw new Error("planted unread");
    return readFileSync(p, "utf8");
  };
  const plain = await resultOf(fx);
  const r = await exp(fx, { "as-of": AS_OF }, { read: seam });
  assert.equal(r.code, 0);
  const x = r.result;
  assert.deepEqual(x.unread, { stories: 1, epics: 1 });
  assert.deepEqual(
    x.stories,
    plain.stories.filter((s) => s.ref !== "PS-X/story-todo"),
  );
  assert.deepEqual(
    x.epics,
    plain.epics.filter((e) => e.epic !== "PS-Y"),
  );
  assert.deepEqual(x.transitions, plain.transitions);
});

// [export#9]
test("unread: an epics folder that cannot be read exits 0, unread.stories is 1, and stories and epics are empty (failure)", async () => {
  const fx = flowVault({ stories: oneInEach() });
  rmSync(join(fx.vault, "epics"), { recursive: true, force: true });
  writeFileSync(join(fx.vault, "epics"), "not a folder");
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  const x = r.json.result;
  assert.equal(x.unread.stories, 1);
  assert.deepEqual([x.stories, x.epics], [[], []]);
});

// ─── Contract 10: masking, and what is printed as written ──────────────

// [export#10]
test("masking: an In Progress story assigned to an email-shaped word is printed as an email-shaped name in its row and its WIP row, no assignee holds one, and the note counts 1", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-m": inProgress("story-m", ADDRESS, 2),
      "PS-X/story-a": inProgress("story-a", "A", 2),
    },
  });
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes(ADDRESS), "the unmasked name is never printed");
  const x = r.json.result;
  assert.equal(x.stories.find((s) => s.ref === "PS-X/story-m").assignee, EMAIL_SHAPED);
  assert.deepEqual(x.counts.wip, [
    { assignee: "A", held: 1, awaiting: 0, limit: null },
    { assignee: EMAIL_SHAPED, held: 1, awaiting: 0, limit: null },
  ]);
  for (const v of [...x.stories, ...x.counts.wip].map((s) => s.assignee).filter(Boolean))
    assert.ok(!isEmailAddress(v), v);
  assert.deepEqual(
    x.notes.filter((n) => n.code === "email-shaped-assignee").map((n) => n.count),
    [1],
  );
});

// [export#10]
test("masking: an assignee A B whose second word is email-shaped is masked, a Status log reason holding one is printed as written, and project is the project's absolute path (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-m": storyText({
        id: "story-m",
        assignee: `A ${ADDRESS}`,
        log: [{ to: "in-progress", at: daysAgo(2), reason: `asked by ${ADDRESS}` }],
      }),
    },
  });
  const r = await bin(fx.proj, ["--as-of", AS_OF]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.result.stories[0].assignee, EMAIL_SHAPED);
  assert.equal(r.json.result.transitions[0].reason, `asked by ${ADDRESS}`);
  assert.equal(r.json.project, fx.proj);
});

// [export#10]
test("masking: two In Progress stories assigned to two different email-shaped words give two WIP rows, both an email-shaped name, and the note counts 2 (edge)", async () => {
  const other = ["second.person", "mail.invalid"].join("@");
  const fx = flowVault({
    stories: {
      "PS-X/story-m1": inProgress("story-m1", ADDRESS, 2),
      "PS-X/story-m2": inProgress("story-m2", other, 3),
    },
  });
  const x = await resultOf(fx);
  assert.deepEqual(
    x.counts.wip.map((w) => w.assignee),
    [EMAIL_SHAPED, EMAIL_SHAPED],
  );
  assert.deepEqual(
    x.notes.filter((n) => n.code === "email-shaped-assignee").map((n) => n.count),
    [2],
  );
});

// ─── Contract 11: one count, one clock read, no second implementation ──

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const CLOCK = /nowIso\(|Date\.now\(|new Date\(\)|performance\.now|process\.hrtime/g;
const FORMS = [
  ["Date.parse", /Date\.parse/],
  ["length / 2", /length\s*\/\s*2/],
  ["length >> 1", /length\s*>>\s*1/],
  ["Math.floor(", /Math\.floor\(/],
  ["(a, b) => a - b", /\((\w+),\s*(\w+)\)\s*=>\s*(?:\1\s*-\s*\2|\2\s*-\s*\1)\b(?!\s*\.)/],
  ["WEEK_MS", /\bWEEK_MS\b/],
  ["DAY_MS", /\bDAY_MS\b/],
  ["getUTCDay", /getUTCDay/],
  ["% 7", /%\s*7(?!\d)/],
  ["cycleStart(", /\bcycleStart\(/],
  ["localeCompare", /localeCompare/],
  ["an import of statusToColumn or columnOf", /import\s*\{[^}]*\b(?:statusToColumn|columnOf)\b[^}]*\}\s*from/],
  ["child_process", /child_process/],
  ["diff-refs.mjs", /diff-refs\.mjs/],
  ["import(", /\bimport\(/],
];
const WRITERS = [
  "status-change.mjs",
  "write-record.mjs",
  "reconcile.mjs",
  "binding.mjs",
  "scaffold.mjs",
  "configure.mjs",
  "install-harness.mjs",
  "agents-change.mjs",
  "band.mjs",
  "move.mjs",
  "follow.mjs",
  "epic-rule.mjs",
  "story-section.mjs",
  "groom.mjs",
  "handover.mjs",
  "item-verbs.mjs",
  "initiative-verbs.mjs",
  "rank-verb.mjs",
];
const COUNTS = [
  "storyFacts",
  "wipByPerson",
  "windowOf",
  "windowCounts",
  "isYoung",
  "shownWeeks",
  "weeklyCounts",
  "cycleTime",
  "idleEpics",
];

// The span of a function's body in a source: from the brace that opens it
// (after its parameter list) to the brace that closes it; null when the
// function is not there.
function bodyOf(s, head) {
  const at = s.indexOf(head);
  if (at === -1) return null;
  let depth = 0;
  let k = at + head.length;
  for (; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")" && --depth < 0) break;
  }
  const open = s.indexOf("{", k);
  depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return { from: open, to: i };
  }
  return null;
}

// What the guard finds in a source: the banned forms by name, a clock read
// count other than one or one outside runExport, and a writer imported.
function guard(src) {
  const s = stripComments(src);
  const found = FORMS.filter(([, re]) => re.test(s)).map(([name]) => name);
  const clocks = [...s.matchAll(CLOCK)];
  const body = bodyOf(s, "export async function runExport(");
  if (clocks.length !== 1) found.push(`${clocks.length} clock reads`);
  else if (body === null || clocks[0].index < body.from || clocks[0].index > body.to)
    found.push("a clock read outside runExport");
  const imports = importSpecifiers(s);
  for (const w of WRITERS) if (imports.includes(`./${w}`)) found.push(`an import of ${w}`);
  return found;
}

const SOURCE = () => read(join(REPO, "scripts", "flow-export.mjs"));

// [export#11]
test("source guard: flow-export.mjs reads the clock once, inside runExport, calls the nine counts of ./flow-counts.mjs, and holds none of the banned forms, writers, child processes or dynamic imports", () => {
  const src = stripComments(SOURCE());
  assert.deepEqual(guard(SOURCE()), []);
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/flow-counts\.mjs"/);
  assert.ok(imp, "flow-export.mjs imports from ./flow-counts.mjs");
  for (const fn of COUNTS) {
    assert.match(imp[1], new RegExp(`\\b${fn}\\b`), `imports ${fn}`);
    assert.match(src, new RegExp(`\\b${fn}\\(`), `calls ${fn}`);
  }
  assert.match(src, /import\s*\{[^}]*\bparseStatusLog\b[^}]*\}\s*from\s*"\.\/status-log\.mjs"/);
  const fsLine = src.match(/^import \{([^}]*)\} from "node:fs";/m);
  assert.deepEqual(
    (fsLine ? fsLine[1] : "")
      .split(",")
      .map((s) => s.trim())
      .filter((n) => /write|append|rename|mkdir|rm|unlink|copy|truncate|chmod/i.test(n)),
    [],
  );
});

// [export#11]
test("source guard: a copy that also reads the clock in buildExport, and a copy that takes a median with Math.floor(, fail and name the form they hold (failure)", () => {
  const src = SOURCE();
  const head = "export function buildExport(";
  assert.ok(src.includes(head));
  const inBuild = "  const facts = [];\n  let unreadStories";
  assert.ok(src.includes(inBuild));
  const clocked = src.replace(inBuild, `  const planted = nowIso();\n${inBuild}`);
  assert.deepEqual(guard(clocked), ["2 clock reads"]);
  const floored = `${src}\nconst mid = (days) => days[Math.floor(days.length / 2)];\n`;
  assert.deepEqual(guard(floored), ["length / 2", "Math.floor("]);
  const early = src.replace(head, `const at0 = Date.now();\n${head}`).replace("nowSeam ?? nowIso()", "nowSeam ?? at0");
  assert.deepEqual(guard(early), ["a clock read outside runExport"]);
  assert.deepEqual(guard("// Math.floor( Date.now() WEEK_MS\nexport async function runExport() { nowIso(); }"), []);
  // Inside runExport means in its body, not anywhere after its first line.
  const after = `${src}\nconst late = () => Date.now();\n`.replace("nowSeam ?? nowIso()", "nowSeam ?? late()");
  assert.deepEqual(guard(after), ["a clock read outside runExport"]);
  assert.deepEqual(
    guard("export async function runExport({ a = (x) => x } = {}) { if (a) { nowIso(); } }\nconst z = 1;"),
    [],
  );
});

// [export#11]
test("source guard: no hook and no MCP closure holds flow-export.mjs, and the bin's does", async () => {
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  assert.ok(!Object.hasOwn(READ_HANDLERS, "export"), "the read runner does not serve export");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp];
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  for (const entry of entries)
    assert.ok(
      !closure(entry, { root: REPO, dispatch }).includes("scripts/flow-export.mjs"),
      `${entry} reaches flow-export.mjs`,
    );
  assert.ok(closure("bin/projectstore.mjs", { root: REPO, dispatch }).includes("scripts/flow-export.mjs"));
  // Nothing flow-export.mjs reaches starts a process, so it runs no git.
  for (const rel of closure("scripts/flow-export.mjs", { root: REPO })) {
    const src = read(join(REPO, rel));
    const specs = [...importSpecifiers(src), ...dynamicSpecifiers(src)];
    assert.ok(!specs.some((x) => /child_process/.test(x)), `${rel} imports child_process`);
  }
});

// Not a contract scenario: the default layout is binding.mjs's, copied.
test("export: DEFAULT_LAYOUT equals binding.mjs's, which flow-export.mjs does not import", () => {
  assert.equal(DEFAULT_LAYOUT, BINDING_DEFAULT_LAYOUT);
});

// Not a contract scenario: buildExport is pure over what it is given.
test("export: buildExport over no input gives the empty result with the given instant", () => {
  const x = buildExport({ asOfMs: NOW_MS });
  assert.equal(x.as_of, NOW);
  assert.deepEqual(x.stories, []);
  assert.deepEqual(x.unread, { stories: 0, epics: 0 });
});

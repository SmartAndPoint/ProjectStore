// projectstore — tests/flow-counts.test.mjs: the flow counts as pure
// functions of the stories, the policy and an explicit as-of instant
// (PS-FLOW, "Doctor checks the flow against the vault's policy…"; the spec
// "Flow counts…", alias `flow-counts`). The scenarios whose WHEN is "doctor
// runs" are in tests/doctor-flow.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ageDays,
  meets,
  columnOf,
  storyFacts,
  wipByPerson,
  windowOf,
  windowCounts,
  weekStart,
  openStoriesOf,
  epicCounts,
  weeklyCounts,
  columnPath,
  cumulativeFlow,
  cycleStart,
  cycleTime,
  idleEpics,
  DAY_MS,
  WEEK_MS,
} from "../scripts/flow-counts.mjs";
import { stampMs, statusStamp, isAwaitingClose, AWAITING_REASON, setFm } from "../scripts/status-log.mjs";
import { parseFrontmatter } from "../scripts/lib.mjs";
import { storyText, withLine, closedStory, NOW_MS, daysAgo } from "./fixtures/flow.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fromText = (slug, text) =>
  storyFacts({ rel: `epics/PS-X/stories/${slug}.md`, epic: "PS-X", slug, text, fm: parseFrontmatter(text).data });
const facts = (id, opts) => fromText(id, storyText({ id, ...opts }));

// [flow-counts#1]
test("whole days: a stamp exactly 10 days before is age 10 and meets 10; one second short is 9 and does not (edge)", () => {
  const ten = NOW_MS - 10 * DAY_MS;
  assert.equal(ageDays(ten, NOW_MS), 10);
  assert.equal(meets(ageDays(ten, NOW_MS), 10), true);
  assert.equal(ageDays(ten + 1000, NOW_MS), 9);
  assert.equal(meets(ageDays(ten + 1000, NOW_MS), 10), false);
});

// [flow-counts#1]
test("whole days: a date, an instant with no zone and one with +05:00 read the same on a machine at UTC+5 (edge)", () => {
  const code = `import(${JSON.stringify(join(REPO, "scripts", "status-log.mjs"))}).then((m) => {
    const out = ["2026-11-01", "2026-11-01T09:00", "2026-11-01T09:00:00.000+05:00"].map((s) => new Date(m.stampMs(s)).toISOString());
    process.stdout.write(JSON.stringify({ out, offset: new Date(2026, 10, 1).getTimezoneOffset() }));
  });`;
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, TZ: "Asia/Karachi" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const { out, offset } = JSON.parse(r.stdout);
  assert.equal(offset, -300, "the child runs at UTC+5");
  assert.deepEqual(out, ["2026-11-01T00:00:00.000Z", "2026-11-01T09:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
});

// [flow-counts#1]
test("whole days: 2026-02-30, 1, a written date and a word do not read, and have no age (edge)", () => {
  for (const s of ["2026-02-30", "1", "Nov 1, 2026", "soon", "2026-11-01T25:00", "2026-11-01Z", ""]) {
    assert.equal(stampMs(s), null, s);
    assert.equal(ageDays(stampMs(s), NOW_MS), null, s);
  }
  assert.equal(stampMs(null), null);
});

// [flow-counts#1]
test("whole days: a stamp after the as-of instant is age 0 (edge)", () => {
  assert.equal(ageDays(NOW_MS + 3 * DAY_MS, NOW_MS), 0);
});

// [flow-counts#1]
test("whole days: an age of 10 meets a threshold of 10, and 9 does not (edge)", () => {
  assert.equal(meets(10, 10), true);
  assert.equal(meets(9, 10), false);
  assert.equal(meets(null, 10), false);
});

// [flow-counts#2]
test("which stories count: in_progress, In-Progress and in progress are all In Progress", () => {
  for (const s of ["in_progress", "In-Progress", "in progress", " In Progress "])
    assert.equal(columnOf(s), "In Progress", s);
  assert.equal(columnOf("to-do"), "ToDo");
  assert.equal(columnOf("closed"), "Done");
  assert.equal(columnOf(""), null);
  assert.equal(columnOf(null), null);
});

// [flow-counts#2]
test("which stories count: a parked story with an assignee is in no count (edge)", () => {
  const f = facts("story-parked", { assignee: "First Last", status: "parked", created: "2026-10-27" });
  assert.equal(f.column, null);
  assert.equal(wipByPerson([f]).size, 0);
  const counts = windowCounts([f], windowOf(NOW_MS, 4));
  assert.deepEqual([counts.created.length, counts.closed.length, counts.closedUnstamped.length], [0, 0, 0]);
});

// [flow-counts#3]
test("age in status: an untrusted story whose updated reads soon is read from created (edge)", () => {
  const f = facts("story-a", { created: "2026-11-01", updated: "soon", status: "review" });
  assert.equal(f.age.source, "created");
  assert.equal(f.age.at, Date.parse("2026-11-01T00:00:00Z"));
});

// [flow-counts#3]
test("age in status: a stamp with no zone equals its line's instant and is trusted; a 2026-02-30 stamp is not (edge)", () => {
  const base = storyText({ id: "story-a", log: [{ to: "in-progress", at: "2026-11-01T09:00:00.000Z" }] });
  const noZone = base.replace('status_changed_at: "2026-11-01T09:00:00.000Z"', 'status_changed_at: "2026-11-01T09:00"');
  assert.notEqual(noZone, base);
  assert.equal(statusStamp(noZone).trusted, true);
  const bad = base.replace('status_changed_at: "2026-11-01T09:00:00.000Z"', 'status_changed_at: "2026-02-30"');
  const s = statusStamp(bad);
  assert.equal(s.trusted, false);
  assert.equal(s.source, "updated");
});

// A Review story whose last line is the awaiting reason, 20 days ago.
const awaitingLine = () =>
  withLine(storyText({ id: "story-w", assignee: "First Last", log: [{ to: "in-progress", at: daysAgo(30) }] }), {
    at: daysAgo(20),
    from: "in-progress",
    to: "review",
    reason: `${AWAITING_REASON}: <url>`,
  }).replace("status: in-progress", "status: review");

// [flow-counts#4]
test("awaiting close: a Review story whose trusted last line reads merged, awaiting evidence is awaiting close", () => {
  const t = awaitingLine();
  assert.equal(statusStamp(t).trusted, true);
  assert.equal(isAwaitingClose(t), true);
});

// [flow-counts#4]
test("awaiting close: follow's review → review line 2 days ago keeps the stamp trusted and the age in Review at 2 (edge)", () => {
  const t = withLine(awaitingLine(), {
    at: daysAgo(2),
    from: "review",
    to: "review",
    reason: `${AWAITING_REASON}: <url>`,
  });
  assert.equal(isAwaitingClose(t), true);
  const f = fromText("story-w", t);
  assert.equal(f.age.trusted, true);
  assert.equal(ageDays(f.age.at, NOW_MS), 2);
});

// [flow-counts#4]
test("awaiting close: the status edited by hand to in-progress ends it, and the story counts as In Progress (edge)", () => {
  const t = awaitingLine().replace("status: review", "status: in-progress");
  assert.equal(isAwaitingClose(t), false);
  const f = fromText("story-w", t);
  assert.equal(f.column, "In Progress");
  assert.equal(wipByPerson([f]).get("First Last").held.length, 1);
});

// [flow-counts#4]
test("awaiting close: another reason is not awaiting; an assignee: line after the awaiting line does not end it (edge)", () => {
  const ready = withLine(storyText({ id: "story-r", log: [{ to: "in-progress", at: daysAgo(9) }] }), {
    at: daysAgo(3),
    from: "in-progress",
    to: "review",
    reason: "pull request ready: <url>",
  }).replace("status: in-progress", "status: review");
  assert.equal(statusStamp(ready).trusted, true);
  assert.equal(isAwaitingClose(ready), false);
  const handed = awaitingLine().replace(
    /(merged, awaiting evidence: <url> \(follow\))/,
    `$1\n- ${daysAgo(1)} assignee: First Last → Other Person — handed over (handover)`,
  );
  assert.match(handed, /assignee: First Last → Other Person/);
  assert.equal(isAwaitingClose(handed), true);
});

// [flow-counts#4]
test("awaiting close: a Done story whose last line carries the reason is not awaiting close (edge)", () => {
  const t = withLine(storyText({ id: "story-d", log: [{ to: "in-progress", at: daysAgo(9) }] }), {
    at: daysAgo(3),
    from: "in-progress",
    to: "done",
    reason: `${AWAITING_REASON}: <url>`,
  }).replace("status: in-progress", "status: done");
  assert.equal(statusStamp(t).trusted, true);
  assert.equal(isAwaitingClose(t), false);
});

// [flow-counts#5]
test("WIP: In Progress stories with no assignee and with an empty one count for no one (edge)", () => {
  const none = facts("story-n", { status: "in-progress", fm: { assignee: "null" } });
  const empty = facts("story-e", { status: "in-progress", assignee: "" });
  assert.equal(none.assignee, "");
  assert.equal(wipByPerson([none, empty]).size, 0);
});

// [flow-counts#6]
test("windows: W of 2 on Wednesday 2026-11-11 runs from 2026-10-26 to 2026-11-09 in two weeks starting 2026-10-26 and 2026-11-02; a story created 2026-10-26 is in it and its first week, one created 2026-11-09 in neither (edge)", () => {
  const win = windowOf(Date.parse("2026-11-11T12:00:00Z"), 2);
  assert.equal(new Date(win.from).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(new Date(win.to).toISOString(), "2026-11-09T00:00:00.000Z");
  const a = facts("story-a", { created: "2026-10-26" });
  const b = facts("story-b", { created: "2026-11-09" });
  assert.deepEqual(
    windowCounts([a, b], win).created.map((f) => f.slug),
    ["story-a"],
  );
  const weeks = weeklyCounts([a, b], win);
  assert.deepEqual(
    weeks.map((w) => [new Date(w.from).toISOString().slice(0, 10), new Date(w.to).toISOString().slice(0, 10)]),
    [
      ["2026-10-26", "2026-11-02"],
      ["2026-11-02", "2026-11-09"],
    ],
  );
  assert.deepEqual(
    weeks.map((w) => w.created.map((f) => f.slug)),
    [["story-a"], []],
  );
  assert.equal(weekStart(Date.parse("2026-11-09T00:00:00Z")), Date.parse("2026-11-09T00:00:00Z"));
  assert.equal(weekStart(Date.parse("2026-11-15T23:59:59Z")), Date.parse("2026-11-09T00:00:00Z"));
});

// [flow-counts#6]
test("windows: at Monday 00:00Z exactly, a close at 23:59:59.999Z the day before is in the window and its last week, and one at 00:00Z in neither (edge)", () => {
  const win = windowOf(Date.parse("2026-11-09T00:00:00.000Z"), 2);
  const done = (id, at) => facts(id, { status: "done", fm: { closed_at: JSON.stringify(at) } });
  const counts = windowCounts(
    [done("story-in", "2026-11-08T23:59:59.999Z"), done("story-out", "2026-11-09T00:00:00.000Z")],
    win,
  );
  assert.equal(counts.closed.length, 1);
  assert.deepEqual(
    counts.closed.map((f) => f.slug),
    ["story-in"],
  );
  const weeks = weeklyCounts(
    [done("story-in", "2026-11-08T23:59:59.999Z"), done("story-out", "2026-11-09T00:00:00.000Z")],
    win,
  );
  assert.deepEqual(
    weeks.map((w) => w.closed.map((f) => f.slug)),
    [[], ["story-in"]],
    "the first is in the window's last week, the second in no week",
  );
});

// [flow-counts#6]
test("windows: a story with no created, and one whose created reads soon, are created on the board's date (edge)", () => {
  const win = windowOf(NOW_MS, 2);
  // The template always writes created: one story drops it, one reads soon.
  const textA = storyText({ id: "story-x", fm: { date: "2026-10-28" } }).replace(/^created: .*\n/m, "");
  const fa = fromText("story-x", textA);
  assert.equal(stampMs(fa.fm.created), null);
  const textB = storyText({ id: "story-y", fm: { date: "2026-10-28" } }).replace(/^created: .*$/m, "created: soon");
  const fb = fromText("story-y", textB);
  assert.deepEqual(
    windowCounts([fa, fb], win).created.map((f) => f.slug),
    ["story-x", "story-y"],
  );
});

// ─── Contract 8: a person's open work ──────────────────────────────────

const slugs = (fs) => fs.map((f) => f.slug);

// [flow-counts#8]
test("open work: Ada's planned, todo, in-progress, review and awaiting stories are hers; done, closed, parked and superseded are not", () => {
  const at = daysAgo(5);
  const ada = (id, status) => facts(id, { assignee: "Ada", status });
  const awaiting = fromText(
    "story-e",
    withLine(storyText({ id: "story-e", assignee: "Ada", log: [{ to: "review", at: daysAgo(9) }] }), {
      at,
      from: "review",
      to: "review",
      reason: `${AWAITING_REASON}: <url>`,
    }),
  );
  assert.equal(awaiting.awaiting, true, "the awaiting story is awaiting close (control)");
  const all = [
    ada("story-a", "planned"),
    ada("story-b", "todo"),
    ada("story-c", "in-progress"),
    ada("story-d", "review"),
    awaiting,
    ada("story-f", "done"),
    ada("story-g", "closed"),
    ada("story-h", "parked"),
    ada("story-i", "superseded"),
  ];
  assert.deepEqual(slugs(openStoriesOf(all, "Ada")).sort(), ["story-a", "story-b", "story-c", "story-d", "story-e"]);
});

// [flow-counts#8]
test("open work: a story with no status, and one whose status is soon, are in it (edge)", () => {
  const none = facts("story-n", { assignee: "Ada", status: '""' });
  const soon = facts("story-s", { assignee: "Ada", status: "soon" });
  assert.equal(none.column, null, "no status counts nowhere (control)");
  assert.deepEqual(slugs(openStoriesOf([none, soon], "Ada")).sort(), ["story-n", "story-s"]);
});

// [flow-counts#8]
test("open work: aged 9 and 3 days, one with no date, and two of the same age: oldest first, ties by path, undated last (edge)", () => {
  const aged = (id, n) => facts(id, { assignee: "Ada", log: [{ to: "todo", at: daysAgo(n) }] });
  const undated = fromText(
    "story-u",
    storyText({ id: "story-u", assignee: "Ada", fm: { created: '""', updated: '""', date: '""' } }),
  );
  assert.equal(undated.age.at, null, "no date (control)");
  const list = [aged("story-3", 3), undated, aged("story-y", 5), aged("story-9", 9), aged("story-x", 5)];
  assert.deepEqual(slugs(openStoriesOf(list, "Ada")), ["story-9", "story-x", "story-y", "story-3", "story-u"]);
});

// [flow-counts#8]
test("open work: stories assigned to ' Ada ', 'ada' and constructor: Ada's holds the trimmed one, constructor's its own (edge)", () => {
  const spaced = facts("story-a", { assignee: " Ada ", status: "todo" });
  const lower = facts("story-b", { assignee: "ada", status: "todo" });
  const ctor = facts("story-c", { assignee: "constructor", status: "todo" });
  const all = [spaced, lower, ctor];
  assert.deepEqual(slugs(openStoriesOf(all, "Ada")), ["story-a"]);
  assert.deepEqual(slugs(openStoriesOf(all, "constructor")), ["story-c"]);
  assert.deepEqual(openStoriesOf(all, "__proto__"), []);
});

// [flow-counts#1]
test("source guard: flow-counts.mjs reads no clock, no file and no process", () => {
  const src = readFileSync(join(REPO, "scripts", "flow-counts.mjs"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const [what, re] of [
    ["a file", /node:fs|readFileSync|readdirSync|from "fs"/],
    ["a child process", /child_process|spawn/],
    ["the process", /\bprocess\./],
    ["the clock", /Date\.now|new Date\(\s*\)|performance\.now/],
  ])
    assert.doesNotMatch(code, re, `flow-counts.mjs reads ${what}`);
});

// ─── Contract 9: epics, active and one-story ───────────────────────────

const epicFact = (epic, status = "in-progress") => ({
  rel: `epics/${epic}/epic.md`,
  epic,
  text: "",
  fm: { type: "epic", status },
});
const storyIn = (epic, id, status) =>
  storyFacts({
    rel: `epics/${epic}/stories/${id}.md`,
    epic,
    slug: id,
    text: storyText({ id, epic, status }),
    fm: parseFrontmatter(storyText({ id, epic, status })).data,
  });
const counted = (epics, fs) => {
  const c = epicCounts(epics, fs);
  return { active: c.active.map((e) => e.epic), single: c.singleStory.map((e) => [e.epic, e.story.slug]) };
};

// [flow-counts#9]
test("epic counts: an epic with status active and one planned story is active and a one-story epic", () => {
  assert.deepEqual(counted([epicFact("PS-A", "active")], [storyIn("PS-A", "story-a", "planned")]), {
    active: ["PS-A"],
    single: [["PS-A", "story-a"]],
  });
});

// [flow-counts#9]
test("epic counts: one done and one todo story is active and not one-story; one todo and one parked is active and one-story (edge)", () => {
  const fs = [
    storyIn("PS-A", "story-d", "done"),
    storyIn("PS-A", "story-t", "todo"),
    storyIn("PS-B", "story-t", "todo"),
    storyIn("PS-B", "story-p", "parked"),
  ];
  assert.deepEqual(counted([epicFact("PS-A"), epicFact("PS-B")], fs), {
    active: ["PS-A", "PS-B"],
    single: [["PS-B", "story-t"]],
  });
});

// [flow-counts#9]
test("epic counts: a deferred and a done epic with one open story each, an epic of done stories and an epic with no story are neither active nor one-story (edge)", () => {
  const epics = [epicFact("PS-F", "deferred"), epicFact("PS-D", "done"), epicFact("PS-E"), epicFact("PS-N")];
  const fs = [
    storyIn("PS-F", "story-f", "planned"),
    storyIn("PS-D", "story-d", "todo"),
    storyIn("PS-E", "story-e1", "done"),
    storyIn("PS-E", "story-e2", "closed"),
  ];
  assert.deepEqual(counted(epics, fs), { active: [], single: [] });
  // A story under an epic named constructor counts like any other.
  assert.deepEqual(counted([epicFact("constructor")], [storyIn("constructor", "story-c", "planned")]).single, [
    ["constructor", "story-c"],
  ]);
});

// ─── Contract 10: the cumulative flow ──────────────────────────────────

// W of 4 at the as-of instant 2026-11-11T12:00Z: weeks of 2026-10-12,
// 2026-10-19, 2026-10-26 and 2026-11-02.
const WIN4 = windowOf(NOW_MS, 4);
const BOARD = ["Backlog", "ToDo", "In Progress", "Review", "Done"];
const wk = (k, day = 1, time = "10:00:00.000Z") =>
  `${new Date(WIN4.from + k * WEEK_MS + day * DAY_MS).toISOString().slice(0, 10)}T${time}`;
// One story's column at each week's end of WIN4, from cumulativeFlow.
function where(fact) {
  const cf = cumulativeFlow([fact], WIN4, NOW_MS, BOARD);
  return cf.rows.slice(0, -1).map((r) => [...r.counts].find(([, n]) => n === 1)?.[0] ?? null);
}
const approx = (...fs) =>
  cumulativeFlow(fs, WIN4, NOW_MS, BOARD)
    .approximate.map((f) => f.slug)
    .sort();

// [flow-counts#10]
test("cumulative flow: a story moved planned → todo → in-progress → review → done, one move a week, is in ToDo, In Progress, Review and Done at those weeks' ends, and is exact", () => {
  const f = facts("story-a", {
    created: "2026-10-01",
    log: [
      { to: "todo", at: wk(0) },
      { to: "in-progress", at: wk(1) },
      { to: "review", at: wk(2) },
      { to: "done", at: wk(3) },
    ],
  });
  assert.deepEqual(where(f), ["ToDo", "In Progress", "Review", "Done"]);
  assert.equal(columnPath(f).exact, true);
  assert.deepEqual(approx(f), []);
});

// [flow-counts#10]
test("cumulative flow: a story with no log placed from created, started_at and closed_at, and one whose review status is placed after its started_at, are both approximate (edge)", () => {
  const first = facts("story-n", {
    created: wk(0).slice(0, 10),
    status: "done",
    fm: { started_at: JSON.stringify(wk(1)), closed_at: JSON.stringify(wk(2)) },
  });
  assert.deepEqual(where(first).slice(0, 3), ["Backlog", "In Progress", "Done"]);
  const second = facts("story-r", {
    created: wk(0).slice(0, 10),
    updated: wk(0, 2).slice(0, 10),
    status: "review",
    fm: { started_at: JSON.stringify(wk(1)) },
  });
  assert.deepEqual(where(second).slice(0, 2), ["Backlog", "Review"]);
  assert.deepEqual(approx(first, second), ["story-n", "story-r"]);
});

// [flow-counts#10]
test("cumulative flow: a status edited by hand to review after a last line into in-progress, and a log whose chain breaks (planned → todo, then in-progress → review), are approximate (edge)", () => {
  const hand = fromText(
    "story-h",
    setFm(
      setFm(
        storyText({
          id: "story-h",
          log: [{ to: "in-progress", at: wk(0) }],
          fm: { started_at: JSON.stringify(wk(0)) },
        }),
        "status",
        "review",
      ),
      "updated",
      wk(1).slice(0, 10),
    ),
  );
  assert.deepEqual(where(hand).slice(0, 2), ["In Progress", "Review"]);
  const broken = fromText(
    "story-b",
    setFm(
      withLine(storyText({ id: "story-b", log: [{ to: "todo", at: wk(0) }] }), {
        at: wk(1),
        from: "in-progress",
        to: "review",
        reason: "r",
        actor: "move",
      }),
      "status",
      "review",
    ),
  );
  assert.equal(statusStamp(broken.text).trusted, true, "its stamp is trusted; only the chain is broken");
  assert.equal(columnPath(broken).exact, false);
  assert.deepEqual(approx(hand, broken), ["story-b", "story-h"]);
});

// [flow-counts#10]
test("cumulative flow: a story moved to parked in the second week and back to todo in the third is in no column at the second week's end, and in ToDo at the third's (edge)", () => {
  const f = facts("story-p", {
    created: "2026-10-01",
    log: [
      { to: "todo", at: wk(0) },
      { to: "parked", at: wk(1) },
      { to: "todo", at: wk(2) },
    ],
  });
  assert.deepEqual(where(f), ["ToDo", null, "ToDo", "ToDo"]);
  assert.equal(columnPath(f).exact, true);
});

// [flow-counts#10]
test("cumulative flow: a story created at exactly Monday 00:00:00.000Z of the second week is in no column at the first week's end, and in Backlog at the second's (edge)", () => {
  const monday = new Date(WIN4.from + WEEK_MS).toISOString();
  const f = facts("story-m", { created: monday });
  assert.equal(f.created, WIN4.from + WEEK_MS);
  assert.deepEqual(where(f).slice(0, 2), [null, "Backlog"]);
});

// [flow-counts#10]
test("cumulative flow: with stories closed through the close gate and none reopened, each week's Done count less the previous one's equals its closes, and the last row is each story's column now", () => {
  const gate = (id, created, start, close) =>
    facts(id, {
      created,
      log: [
        { to: "in-progress", at: start, actor: "plan gate" },
        ...(close ? [{ to: "done", at: close, actor: "close gate" }] : []),
      ],
      fm: {
        started_at: JSON.stringify(start),
        ...(close ? { closed_at: JSON.stringify(close) } : {}),
      },
    });
  const fs = [
    gate("story-1", "2026-09-20", wk(0), wk(0, 3)),
    gate("story-2", "2026-09-21", wk(0), wk(1, 2)),
    gate("story-3", "2026-09-22", wk(1), wk(1, 4)),
    gate("story-4", "2026-10-13", wk(1), wk(3, 1)),
    gate("story-5", "2026-10-14", wk(2), null),
    gate("story-6", "2026-09-01", "2026-09-02T10:00:00.000Z", "2026-09-03T10:00:00.000Z"),
  ];
  const cf = cumulativeFlow(fs, WIN4, NOW_MS, BOARD);
  const weeks = weeklyCounts(fs, WIN4);
  for (let k = 1; k < weeks.length; k++)
    assert.equal(
      cf.rows[k].counts.get("Done") - cf.rows[k - 1].counts.get("Done"),
      weeks[k].closed.length,
      `week ${k}`,
    );
  const now = cf.rows.at(-1).counts;
  for (const c of BOARD) assert.equal(now.get(c), fs.filter((f) => f.column === c).length, c);
  assert.deepEqual(cf.approximate, []);
});

// [flow-counts#10]
test("cumulative flow: a garbled line in the middle of a Status log makes the path approximate, though the last line is trusted (edge)", () => {
  const text = storyText({
    id: "story-g",
    created: "2026-10-01",
    log: [
      { to: "todo", at: wk(0) },
      { to: "in-progress", at: wk(1) },
      { to: "review", at: wk(2) },
    ],
  }).replace(/^(- \S+ status: todo → in-progress — r \(move\))$/m, "- garbled line the grammar cannot read");
  const f = fromText("story-g", text);
  assert.equal(statusStamp(text).trusted, true, "the last line still reads and matches the stamp");
  assert.equal(columnPath(f).exact, false);
  assert.deepEqual(approx(f), ["story-g"]);
});

// ─── The cycle-time spec (alias `cycle-time`), contracts 1 to 4 and 10 ─

// Day n after 2026-10-01T10:00Z, as an instant, and as epoch ms.
const D0 = Date.UTC(2026, 9, 1, 10);
const d = (n) => new Date(D0 + n * DAY_MS).toISOString();
const dm = (n) => D0 + n * DAY_MS;
// A story's facts under `epic`, moved through the writers; `moves` are [to,
// day] pairs, `lines` hand-written Status log lines appended after them.
function ctStory(id, { epic = "PS-X", moves = [], lines = [], fm = {}, created = "2026-09-01", status = null } = {}) {
  let text = storyText({ id, epic, created, log: moves.map(([to, n]) => ({ to, at: d(n) })), fm, status });
  for (const l of lines) text = withLine(text, { stamp: false, ...l });
  return storyFacts({ rel: `epics/${epic}/stories/${id}.md`, epic, slug: id, text, fm: parseFrontmatter(text).data });
}
const closedFact = (id, startDay, closeDay, opts = {}) => {
  const text = closedStory({
    id,
    epic: opts.epic || "PS-X",
    start: startDay === null ? null : d(startDay),
    close: d(closeDay),
  });
  const epic = opts.epic || "PS-X";
  return storyFacts({ rel: `epics/${epic}/stories/${id}.md`, epic, slug: id, text, fm: parseFrontmatter(text).data });
};
const startOf = (f) => {
  const s = cycleStart(f);
  return s === null ? null : { at: new Date(s.at).toISOString(), source: s.source };
};

// [cycle-time#1]
test("cycle start: moved to in-progress, back to planned and to in-progress again, and moved in-progress → active → in-progress, each start at the second in-progress line, from the log", () => {
  const back = ctStory("story-a", {
    moves: [
      ["in-progress", 1],
      ["planned", 3],
      ["in-progress", 5],
    ],
    fm: { started_at: JSON.stringify(d(1)) },
  });
  const active = ctStory("story-b", {
    moves: [
      ["in-progress", 1],
      ["active", 2],
      ["in-progress", 4],
    ],
  });
  assert.equal(columnOf("active"), "Backlog");
  assert.deepEqual(startOf(back), { at: d(5), source: "log" });
  assert.deepEqual(startOf(active), { at: d(4), source: "log" });
});

// [cycle-time#1]
test("cycle start: started_at with no Status log, a log of in-progress → done alone, and a broken chain planned → todo then in-progress → review all start at started_at (edge)", () => {
  const started = { started_at: JSON.stringify(d(2)) };
  const noLog = ctStory("story-a", { status: "done", fm: started });
  const onlyDone = ctStory("story-b", {
    status: "done",
    fm: started,
    lines: [{ at: d(6), from: "in-progress", to: "done", reason: "closed" }],
  });
  const broken = ctStory("story-c", {
    moves: [["todo", 1]],
    fm: started,
    lines: [{ at: d(3), from: "in-progress", to: "review", reason: "r" }],
  });
  for (const f of [noLog, onlyDone, broken]) assert.deepEqual(startOf(f), { at: d(2), source: "started_at" }, f.slug);
});

// [cycle-time#1]
test("cycle start: in-progress → parked → in-progress and in-progress → todo → in-progress keep the first start (edge)", () => {
  for (const mid of ["parked", "todo"]) {
    const f = ctStory(`story-${mid}`, {
      moves: [
        ["in-progress", 1],
        [mid, 2],
        ["in-progress", 3],
      ],
    });
    assert.deepEqual(startOf(f), { at: d(1), source: "log" }, mid);
  }
});

// [cycle-time#1]
test("cycle start: started, moved back to planned and closed from there, with started_at, starts at started_at (edge)", () => {
  const f = ctStory("story-a", {
    moves: [
      ["in-progress", 1],
      ["planned", 3],
      ["done", 5],
    ],
    fm: { started_at: JSON.stringify(d(1)), closed_at: JSON.stringify(d(5)) },
  });
  assert.deepEqual(startOf(f), { at: d(1), source: "started_at" });
});

// [cycle-time#1]
test("cycle start: lines read in time order, ties in log order: todo → in-progress at day 4 listed after in-progress → review at day 6 starts at day 4; a move back and a restart at one instant start there (edge)", () => {
  const listed = ctStory("story-a", {
    moves: [["todo", 1]],
    lines: [
      { at: d(6), from: "in-progress", to: "review", reason: "r" },
      { at: d(4), from: "todo", to: "in-progress", reason: "r" },
    ],
  });
  assert.deepEqual(startOf(listed), { at: d(4), source: "log" });
  const tie = ctStory("story-b", {
    moves: [["in-progress", 1]],
    lines: [
      { at: d(3), from: "in-progress", to: "planned", reason: "r" },
      { at: d(3), from: "planned", to: "in-progress", reason: "r" },
    ],
  });
  assert.deepEqual(startOf(tie), { at: d(3), source: "log" });
});

// [cycle-time#1]
test("cycle start: planned → done with no started_at, and an in-progress line at 2026-02-30T10:00Z with no started_at, have no start (edge)", () => {
  const straight = ctStory("story-a", { moves: [["done", 2]] });
  const badTime = ctStory("story-b", {
    lines: [{ at: "2026-02-30T10:00Z", from: "planned", to: "in-progress", reason: "r" }],
  });
  assert.equal(cycleStart(straight), null);
  assert.equal(cycleStart(badTime), null);
});

// [cycle-time#2]
test("cycle time: closes 2, 5 and 9 days after their start give 5 over 3; a fourth after 8 days gives 6 over 4", () => {
  const three = [closedFact("story-a", 0, 2), closedFact("story-b", 1, 6), closedFact("story-c", 0, 9)];
  const c = cycleTime(three);
  assert.deepEqual([c.median, c.closed, c.days, c.unplaced], [5, 3, [2, 5, 9], []]);
  const four = cycleTime([...three, closedFact("story-d", 2, 10)]);
  assert.deepEqual([four.median, four.closed, four.days], [6, 4, [2, 5, 8, 9]]);
});

// [cycle-time#2]
test("cycle time: 2 and 4 days and a close with no start give a median of 3 over 2, closed 3, the third unplaced (edge)", () => {
  const c = cycleTime([closedFact("story-a", 0, 2), closedFact("story-b", 0, 4), closedFact("story-c", null, 5)]);
  assert.equal(c.median, 3);
  assert.equal(c.days.length, 2);
  assert.equal(c.closed, 3);
  assert.deepEqual(
    c.unplaced.map((f) => f.slug),
    ["story-c"],
  );
});

// [cycle-time#2]
test("cycle time: no close gives no median and closed 0; two closes with no start give no median, both unplaced oldest first (edge)", () => {
  assert.deepEqual(cycleTime([]), { closed: 0, median: null, days: [], unplaced: [] });
  const c = cycleTime([closedFact("story-b", null, 6), closedFact("story-a", null, 3)]);
  assert.equal(c.median, null);
  assert.equal(c.closed, 2);
  assert.deepEqual(
    c.unplaced.map((f) => f.slug),
    ["story-a", "story-b"],
  );
});

// [cycle-time#2]
test("cycle time: a story given with no readable closed_at is counted in closed and left out of the median (edge)", () => {
  const open = ctStory("story-open", { status: "done", fm: { started_at: JSON.stringify(d(1)) } });
  const c = cycleTime([closedFact("story-a", 0, 4), open]);
  assert.deepEqual([c.closed, c.median, c.days], [2, 4, [4]]);
  assert.deepEqual(
    c.unplaced.map((f) => f.slug),
    ["story-open"],
  );
});

// [cycle-time#2]
test("cycle time: a started_at after the closed_at, with no log, is 0 days and in the median (edge)", () => {
  const f = ctStory("story-a", {
    status: "done",
    fm: { started_at: JSON.stringify(d(4)), closed_at: JSON.stringify(d(3)) },
  });
  assert.deepEqual(cycleTime([f]), { closed: 1, median: 0, days: [0], unplaced: [] });
});

// [cycle-time#2]
test("cycle time: closed on day 3, then reopened and closed again on day 8 with closed_at kept, counts 3: lines after closed_at are not read (edge)", () => {
  const f = ctStory("story-a", {
    moves: [
      ["in-progress", 0],
      ["done", 3],
      ["planned", 5],
      ["in-progress", 6],
      ["done", 8],
    ],
    fm: { started_at: JSON.stringify(d(0)), closed_at: JSON.stringify(d(3)) },
  });
  assert.deepEqual(cycleTime([f]).days, [3]);
});

// [cycle-time#2]
test("cycle time: a hand close 2 days after an awaiting line written 3 days after the start counts the wait, 5 days (edge)", () => {
  let text = storyText({
    id: "story-a",
    log: [
      { to: "in-progress", at: d(0) },
      { to: "review", at: d(1) },
    ],
  });
  text = withLine(text, { at: d(3), from: "review", to: "review", reason: AWAITING_REASON });
  text = setFm(setFm(text, "status", "done"), "closed_at", JSON.stringify(d(5)));
  const f = fromText("story-a", text);
  assert.equal(cycleStart(f).at, dm(0));
  assert.deepEqual(cycleTime([f]).days, [5]);
});

// The epics, read as readFlowEpics gives them; `title` set when given.
const epicOf = (epic, status = "in-progress", title) => ({
  rel: `epics/${epic}/epic.md`,
  epic,
  text: "",
  fm: title === undefined ? { type: "epic", status } : { type: "epic", status, title },
});
const AS_OF = dm(60);
const idleOf = (epics, fs, n = 14, asOf = AS_OF) => {
  const r = idleEpics(epics, fs, n, asOf);
  return {
    watched: r.watched,
    epics: r.epics.map((e) => [e.epic, new Date(e.age.at).toISOString(), e.age.source, e.days]),
  };
};

// [cycle-time#3]
test("watched epics: planned, done, parked and active epics with old stories, and an in-progress epic with no story, are none listed; active reads Backlog (edge)", () => {
  const statuses = ["planned", "done", "parked", "active"];
  const epics = [...statuses.map((s, i) => epicOf(`PS-${i}`, s)), epicOf("PS-EMPTY")];
  const fs = statuses.map((_, i) => ctStory(`story-${i}`, { epic: `PS-${i}`, moves: [["in-progress", 1]] }));
  assert.deepEqual(
    idleOf(epics, fs),
    { watched: 1, epics: [] },
    "the in-progress epic with no story is watched, not listed",
  );
  assert.equal(columnOf("active"), "Backlog");
});

// [cycle-time#3]
test("watched epics: an epic whose status reads In Progress and one that reads in_progress are both watched (edge)", () => {
  const epics = [epicOf("PS-A", "In Progress"), epicOf("PS-B", "in_progress")];
  const fs = [
    ctStory("story-a", { epic: "PS-A", moves: [["in-progress", 1]] }),
    ctStory("story-b", { epic: "PS-B", moves: [["in-progress", 1]] }),
  ];
  const r = idleOf(epics, fs);
  assert.equal(r.watched, 2);
  assert.deepEqual(
    r.epics.map((e) => e[0]),
    ["PS-A", "PS-B"],
  );
});

// [cycle-time#3]
test("last change: the newest status line of an in-progress epic is on a parked story, and it is that line's time, from the log (edge)", () => {
  const fs = [
    ctStory("story-a", { moves: [["in-progress", 1]] }),
    ctStory("story-p", {
      moves: [
        ["in-progress", 2],
        ["parked", 10],
      ],
    }),
  ];
  assert.deepEqual(idleOf([epicOf("PS-X")], fs).epics, [["PS-X", d(10), "log", 50]]);
});

// [cycle-time#3]
test("last change: with no status line, the newest closed_at or started_at, from dates; with neither, the newest created, from created (edge)", () => {
  const fs = [
    ctStory("story-a", {
      epic: "PS-A",
      status: "done",
      fm: { started_at: JSON.stringify(d(35)), closed_at: JSON.stringify(d(40)) },
    }),
    ctStory("story-b", { epic: "PS-B", status: "planned", created: "2026-11-14" }),
    ctStory("story-c", { epic: "PS-B", status: "planned", created: "2026-10-02" }),
  ];
  assert.deepEqual(
    idleEpics([epicOf("PS-A"), epicOf("PS-B")], fs, 14, AS_OF).epics.map((e) => e.age.field ?? null),
    ["closed_at", null],
  );
  const r = idleOf([epicOf("PS-A"), epicOf("PS-B")], fs);
  assert.deepEqual(r.epics, [
    ["PS-A", d(40), "dates", 20],
    ["PS-B", "2026-11-14T00:00:00.000Z", "created", 16],
  ]);
});

// [cycle-time#3]
test("last change: an in-progress epic whose stories carry no date that reads is not listed (edge)", () => {
  const bare = storyFacts({ rel: "epics/PS-X/stories/story-a.md", epic: "PS-X", slug: "story-a", text: "", fm: {} });
  assert.deepEqual(idleOf([epicOf("PS-X")], [bare]), { watched: 1, epics: [] });
});

// [cycle-time#4]
test("without movement: at N of 14 an epic whose newest status line is 14 days old is listed with that date and days 14, one at 13 is not, and watched is 2", () => {
  const fs = [
    ctStory("story-a", { epic: "PS-A", moves: [["in-progress", 46]] }),
    ctStory("story-b", { epic: "PS-B", moves: [["in-progress", 47]] }),
  ];
  assert.deepEqual(idleOf([epicOf("PS-A"), epicOf("PS-B")], fs, 14, dm(60)), {
    watched: 2,
    epics: [["PS-A", d(46), "log", 14]],
  });
});

// [cycle-time#4]
test("without movement: two epics quiet since one instant and a third 30 days quiet list the third first, the other two by vault path (edge)", () => {
  const fs = [
    ctStory("story-b", { epic: "PS-B", moves: [["in-progress", 40]] }),
    ctStory("story-a", { epic: "PS-A", moves: [["in-progress", 40]] }),
    ctStory("story-c", { epic: "PS-C", moves: [["in-progress", 30]] }),
  ];
  const r = idleOf([epicOf("PS-B"), epicOf("PS-C"), epicOf("PS-A")], fs);
  assert.deepEqual(
    r.epics.map((e) => [e[0], e[3]]),
    [
      ["PS-C", 30],
      ["PS-A", 20],
      ["PS-B", 20],
    ],
  );
});

// [cycle-time#4]
test("without movement: an in-progress epic whose stories are all done, the last closed 20 days before, is listed with that close's date (edge)", () => {
  const fs = [closedFact("story-a", 10, 30), closedFact("story-b", 20, 40)];
  assert.deepEqual(idleOf([epicOf("PS-X")], fs).epics, [["PS-X", d(40), "log", 20]]);
});

// [cycle-time#10]
test("source guard: flow-counts.mjs holds cycleStart, cycleTime and idleEpics and reads no clock, no file and no process", () => {
  const src = readFileSync(join(REPO, "scripts", "flow-counts.mjs"), "utf8");
  for (const fn of ["cycleStart", "cycleTime", "idleEpics"]) assert.match(src, new RegExp(`export function ${fn}\\(`));
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /node:fs|child_process|\bprocess\.|Date\.now|new Date\(\s*\)|performance\.now/);
});

// The forms a caller of the cycle-time counts may not hold (contract 10),
// matched on the source with its comments stripped, so a comment can
// neither trip the guard nor stand in for a call.
const CALLER_FORMS = [
  ["a median computed in place", /length\s*\/\s*2|length\s*>>\s*1|\bn\s*\/\s*2/],
  ["Math.floor(", /Math\.floor\(/],
  ["a numeric sort of bare values", /\((\w+),\s*(\w+)\)\s*=>\s*(?:\1\s*-\s*\2|\2\s*-\s*\1)\b(?!\s*\.)/],
  ["toSorted", /\btoSorted\b/],
  ["a call cycleStart(", /\bcycleStart\(/],
  [
    "an import of parseStatusLog, statusToColumn or columnOf",
    /import\s*\{[^}]*\b(?:parseStatusLog|statusToColumn|columnOf)\b[^}]*\}\s*from/,
  ],
];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const callerForms = (src) => CALLER_FORMS.filter(([, re]) => re.test(stripComments(src))).map(([name]) => name);
const CALLERS = ["scripts/flow-view.mjs", "scripts/doctor-flow.mjs"];

// [cycle-time#10]
test("source guard: flow-view.mjs and doctor-flow.mjs import cycleTime and idleEpics from flow-counts.mjs, call both, and hold none of the banned forms; the b.held - a.held sort stays", () => {
  for (const f of CALLERS) {
    const src = stripComments(readFileSync(join(REPO, f), "utf8"));
    const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/flow-counts\.mjs"/);
    assert.ok(imp, `${f} imports from ./flow-counts.mjs`);
    for (const fn of ["cycleTime", "idleEpics"]) {
      assert.match(imp[1], new RegExp(`\\b${fn}\\b`), `${f} imports ${fn}`);
      assert.match(src, new RegExp(`\\b${fn}\\(`), `${f} calls ${fn}`);
    }
    assert.deepEqual(callerForms(src), [], f);
  }
  assert.match(readFileSync(join(REPO, "scripts", "flow-view.mjs"), "utf8"), /\(a, b\) => b\.held - a\.held/);
});

// [cycle-time#10]
test("source guard: a copy of flow-view.mjs that sorts the days with (a, b) => a - b and takes days[Math.floor(days.length / 2)] fails, naming the forms (failure)", () => {
  const src = readFileSync(join(REPO, "scripts", "flow-view.mjs"), "utf8");
  const copy = `${src}\nconst days = [3, 1, 2].sort((a, b) => a - b);\nconst median = days[Math.floor(days.length / 2)];\n`;
  assert.deepEqual(callerForms(copy), ["a median computed in place", "Math.floor(", "a numeric sort of bare values"]);
});

// [cycle-time#10]
test("source guard: a comparator with other names, toSorted and n / 2 are caught; the same forms in comments neither trip the guard nor count as a call (failure)", () => {
  assert.deepEqual(callerForms("const s = xs.sort((x, y) => x - y);"), ["a numeric sort of bare values"]);
  assert.deepEqual(callerForms("const s = xs.sort((p, q) => q - p);"), ["a numeric sort of bare values"]);
  assert.deepEqual(callerForms("const s = xs.toSorted();"), ["toSorted"]);
  assert.deepEqual(callerForms("const m = xs[n / 2];"), ["a median computed in place"]);
  assert.deepEqual(callerForms("rows.sort((a, b) => b.held - a.held);"), []);
  assert.deepEqual(callerForms("// xs.sort((a, b) => a - b)\n/* Math.floor(n / 2) toSorted */\nconst k = 1;"), []);
  assert.doesNotMatch(stripComments("// cycleTime( idleEpics(\nconst k = 1;"), /cycleTime\(|idleEpics\(/);
});

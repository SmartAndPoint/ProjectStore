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
  DAY_MS,
} from "../scripts/flow-counts.mjs";
import { stampMs, statusStamp, isAwaitingClose, AWAITING_REASON } from "../scripts/status-log.mjs";
import { parseFrontmatter } from "../scripts/lib.mjs";
import { storyText, withLine, NOW_MS, daysAgo } from "./fixtures/flow.mjs";

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
test("windows: W of 2 on Wednesday 2026-11-11 runs from 2026-10-26 to 2026-11-09 (edge)", () => {
  const win = windowOf(Date.parse("2026-11-11T12:00:00Z"), 2);
  assert.equal(new Date(win.from).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(new Date(win.to).toISOString(), "2026-11-09T00:00:00.000Z");
  const a = facts("story-a", { created: "2026-10-26" });
  const b = facts("story-b", { created: "2026-11-09" });
  assert.deepEqual(
    windowCounts([a, b], win).created.map((f) => f.slug),
    ["story-a"],
  );
  assert.equal(weekStart(Date.parse("2026-11-09T00:00:00Z")), Date.parse("2026-11-09T00:00:00Z"));
  assert.equal(weekStart(Date.parse("2026-11-15T23:59:59Z")), Date.parse("2026-11-09T00:00:00Z"));
});

// [flow-counts#6]
test("windows: at Monday 00:00Z exactly, a close at 23:59:59.999Z the day before is in and one at 00:00Z is not (edge)", () => {
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

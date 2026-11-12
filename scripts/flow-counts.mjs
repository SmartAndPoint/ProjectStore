// projectstore — flow-counts.mjs: the flow counts, as pure functions.
//
// Doctor, the next-task verb, the weekly grooming pass and `flow.md` (PS-FLOW)
// count the same things: who holds how much work, how long a story has sat in
// a status, how many stories a team closes in a week. The rules are here,
// once, as functions of the stories (flow-stories.mjs), the vault's flow
// policy and an as-of instant the caller passes. Nothing here reads the
// clock, a file or the process: doctor reads the clock once per run, a
// derived view passes the instant it is dated by, and both get the same
// counts for the same instant (a source guard in tests/flow-counts.test.mjs).
//
// Spec: "Flow counts: whole days, week windows, age in status, awaiting
// close, WIP and capacity" (alias `flow-counts`), contracts 1 to 7.

import { stampMs, statusStamp, isAwaitingClose, parseStatusLog } from "./status-log.mjs";
import { statusToColumn, NOT_ACTIONABLE } from "./stages.mjs";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

// ─── Contract 1: whole UTC days ────────────────────────────────────────

// The whole UTC days from a stamp to the as-of instant, never below 0; null
// when there is no stamp.
export function ageDays(fromMs, asOfMs) {
  if (fromMs === null || fromMs === undefined || !Number.isFinite(fromMs)) return null;
  return Math.max(0, Math.floor((asOfMs - fromMs) / DAY_MS));
}

// A threshold of N days is met by an age of at least N whole days.
export const meets = (age, n) => age !== null && age !== undefined && age >= n;

// ─── Contract 2: which stories count ───────────────────────────────────

// A status read trimmed and lower-cased; its board column, or null for a
// story with no status or one in NOT_ACTIONABLE, which no count holds.
export function columnOf(raw) {
  const status = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!status || NOT_ACTIONABLE.has(status)) return null;
  return statusToColumn(status);
}

const later = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

// What every count reads of one story ({rel, epic, slug, text, fm}).
//   column     its board column, or null (counted nowhere);
//   assignee   trimmed, "" for none;
//   age        {at, source, trusted}: contract 3's date, epoch ms or null;
//   awaiting   contract 4;
//   created    `created`, else the board's `date`;
//   closedAt, updatedAt, startedAt   as stampMs reads them;
//   start      the later of `started_at` (else the age's date) and the last
//              `assignee:` line (the flow-findings spec, contract 4).
export function storyFacts(story) {
  const fm = story.fm || {};
  const stamp = statusStamp(story.text);
  const ageAt = stampMs(stamp.at);
  const startedAt = stampMs(fm.started_at);
  let assignedAt = null;
  for (const e of parseStatusLog(story.text) || []) if (e.field === "assignee") assignedAt = stampMs(e.at);
  const base = startedAt ?? ageAt;
  return {
    ...story,
    status: String(fm.status ?? "")
      .trim()
      .toLowerCase(),
    column: columnOf(fm.status),
    assignee: fm.assignee === null || fm.assignee === undefined ? "" : String(fm.assignee).trim(),
    age: { at: ageAt, source: ageAt === null ? null : stamp.source, trusted: stamp.trusted },
    awaiting: isAwaitingClose(story.text),
    created: stampMs(fm.created) ?? stampMs(fm.date),
    closedAt: stampMs(fm.closed_at),
    updatedAt: stampMs(fm.updated),
    startedAt,
    start: later(base, assignedAt),
  };
}

// Oldest first by the date the age in status is read from; a story with no
// date last, ties by vault path (the flow-findings spec, contract 10).
export function oldestFirst(facts) {
  return [...facts].sort((a, b) => {
    const x = a.age.at;
    const y = b.age.at;
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    }
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
}

// ─── Contract 3: age in status ─────────────────────────────────────────

// The stories of `column` whose age meets `days`, and the ones read whose age
// did not come from a trusted stamp (`untrusted`) or that have no date
// (`undated`).
export function agedIn(facts, column, days, asOfMs) {
  const read = facts.filter((f) => f.column === column);
  const aged = read
    .filter((f) => meets(ageDays(f.age.at, asOfMs), days))
    .map((f) => ({ ...f, days: ageDays(f.age.at, asOfMs) }));
  return {
    aged: oldestFirst(aged),
    untrusted: read.filter((f) => f.age.at !== null && !f.age.trusted),
    undated: read.filter((f) => f.age.at === null),
  };
}

// ─── Contract 5: WIP per person ────────────────────────────────────────

// Each assignee's In Progress and Review stories: `held` (their WIP) and
// `awaiting` (contract 4, counted apart). A Map, so `constructor` and
// `__proto__` are names like any other; a story with no assignee counts for
// no one.
export function wipByPerson(facts) {
  const out = new Map();
  for (const f of facts) {
    if (f.column !== "In Progress" && f.column !== "Review") continue;
    if (!f.assignee) continue;
    if (!out.has(f.assignee)) out.set(f.assignee, { held: [], awaiting: [] });
    out.get(f.assignee)[f.awaiting ? "awaiting" : "held"].push(f);
  }
  return out;
}

// ─── Contract 6: week windows, intake and closes ───────────────────────

// The Monday 00:00:00.000Z of the ISO week holding `ms`.
export function weekStart(ms) {
  const day = Math.floor(ms / DAY_MS);
  const dow = (((day + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday; Monday is 0
  return (day - dow) * DAY_MS;
}

// The W complete weeks before the as-of instant's own week, [from, to).
export function windowOf(asOfMs, weeks) {
  const to = weekStart(asOfMs);
  return { from: to - weeks * WEEK_MS, to, weeks };
}

const inWindow = (ms, win) => ms !== null && ms >= win.from && ms < win.to;

// The counted stories created and closed in the window, and the Done stories
// with no readable `closed_at` whose `updated` falls in it.
export function windowCounts(facts, win) {
  const counted = facts.filter((f) => f.column !== null);
  return {
    created: counted.filter((f) => inWindow(f.created, win)),
    closed: counted.filter((f) => f.column === "Done" && inWindow(f.closedAt, win)),
    closedUnstamped: counted.filter((f) => f.column === "Done" && f.closedAt === null && inWindow(f.updatedAt, win)),
  };
}

// Younger than the window: no counted story was created on or before the day
// of `from`, so there are not W weeks to measure.
export function isYoung(facts, win) {
  return !facts.some((f) => f.column !== null && f.created !== null && f.created < win.from + DAY_MS);
}

// ─── Contract 7: ToDo against capacity ─────────────────────────────────

// ToDo against throughput × each bound, in integers: ToDo × W × 100 against
// closed × round(bound × 100). With nothing closed, `unknown`. Returns
// {verdict: "over"|"under"|"within"|"unknown", throughput, low, high}, the
// last three as numbers for a message.
export function capacityVerdict({ todo, closed, weeks, bounds }) {
  const [lo, hi] = bounds.map((b) => Math.round(b * 100));
  const throughput = closed / weeks;
  const out = { throughput, low: (closed * lo) / (weeks * 100), high: (closed * hi) / (weeks * 100) };
  if (closed === 0) return { verdict: "unknown", ...out };
  const lhs = todo * weeks * 100;
  if (lhs > closed * hi) return { verdict: "over", ...out };
  if (lhs < closed * lo) return { verdict: "under", ...out };
  return { verdict: "within", ...out };
}

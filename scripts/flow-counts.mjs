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
// close, WIP and capacity" (alias `flow-counts`), contracts 1 to 8, and
// contract 9 (epicCounts), added 2026-11-15 by PS-FLOW/story-a-weekly-
// grooming-pass-sends-stale-todo-stories-back-to-the-backlog-and-the-
// librarian-proposes-epic-merges. Contract 6 (weeklyCounts) and contract 10
// (columnPath, cumulativeFlow), amended and added 2026-11-19 by PS-FLOW/story-
// a-derived-flowmd-beside-the-kanban-shows-wip-age-in-status-throughput-and-
// the-cumulative-flow, for flow.md (scripts/flow-view.mjs). cycleStart,
// cycleTime and idleEpics: "Cycle time and epics without movement…" (alias
// `cycle-time`), contracts 1 to 4, added 2026-11-20 by PS-FLOW/story-flowmd-
// and-doctor-count-cycle-time-and-epics-without-movement-through-new-flow-
// counts-contracts; flow.md and doctor only call them (its contract 10).

import { stampMs, statusStamp, isAwaitingClose, parseStatusLog, logBullets, sameStatus } from "./status-log.mjs";
import { statusToColumn, NOT_ACTIONABLE, storyState } from "./stages.mjs";

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

// ─── Contract 8: a person's open work ──────────────────────────────────

// The stories assigned to `name`, matched exactly as contract 5 matches
// them, whose status is open by storyState: neither Done nor set aside, so a
// story with no status, or a word the board does not name, is open too.
// Oldest first. Doctor's `assignee-left` and the handover verb read it.
export function openStoriesOf(facts, name) {
  return oldestFirst(facts.filter((f) => f.assignee && f.assignee === name && storyState(f.fm?.status) === "open"));
}

// ─── Contract 9: epics, active and one-story ───────────────────────────

// The active epics and the one-story epics, by folder name, from the epics
// (flow-stories.mjs readFlowEpics) and the stories' facts. An epic is active
// when its own status is open by storyState and it holds at least one open
// story (contract 8's reading): an epic of planned stories counts, a parked
// or a done-only one does not. A one-story epic is an active epic with
// exactly one story that is not in NOT_ACTIONABLE, done ones included, so
// that story is its open one. Returns {active, singleStory}: epics, each
// one-story epic with its `story` (a fact). Doctor's epic findings and the
// groom verb read it.
export function epicCounts(epics, facts) {
  const byEpic = new Map();
  for (const f of facts) {
    if (!byEpic.has(f.epic)) byEpic.set(f.epic, []);
    byEpic.get(f.epic).push(f);
  }
  const active = [];
  const singleStory = [];
  for (const e of epics) {
    if (storyState(e.fm?.status) !== "open") continue;
    const stories = byEpic.get(e.epic) || [];
    if (!stories.some((f) => storyState(f.fm?.status) === "open")) continue;
    active.push(e);
    const counted = stories.filter((f) => !NOT_ACTIONABLE.has(f.status));
    if (counted.length === 1) singleStory.push({ ...e, story: counted[0] });
  }
  return { active, singleStory };
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

// The window, one ISO week at a time, oldest first: each week [from, to)
// counted as windowCounts counts the window, so the weeks' created and closed
// sum to the window's. `closedUnstamped` stays the window's: no week holds it.
export function weeklyCounts(facts, win) {
  const out = [];
  for (let from = win.from; from < win.to; from += WEEK_MS) {
    const c = windowCounts(facts, { from, to: from + WEEK_MS });
    out.push({ from, to: from + WEEK_MS, created: c.created, closed: c.closed });
  }
  return out;
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

// ─── Contract 10: the cumulative flow ──────────────────────────────────

const INEXACT_WHY = new Set(["no-log", "unparsed", "differs"]);

// One story's path: the steps by which it entered a column, {at, column},
// in time order (a set-aside status is a step into no column, null), and
// whether the path is exact. Exact when the Status log has a `status:` line,
// the stamp's reason is not no-log, unparsed or differs, every `- ` line of
// the section reads, and each line's `from` is the previous line's `to`; it
// then starts at the earlier of `created` and the first line, in that line's
// `from` (the writers' `none` reads as Backlog). Otherwise approximate:
// `created` into Backlog, `started_at` into In Progress, `closed_at` into
// Done, and, when that does not end in the column now, a last step into it at
// the later of the age's date and the step before.
export function columnPath(fact) {
  const text = String(fact.text ?? "");
  const entries = parseStatusLog(text) || [];
  const lines = entries
    .map((e, i) => ({ ...e, ms: stampMs(e.at), i }))
    .filter((e) => e.field === "status")
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0) || a.i - b.i);
  let exact =
    lines.length > 0 &&
    !INEXACT_WHY.has(statusStamp(text).why) &&
    (logBullets(text) || []).length === entries.length &&
    lines.every((l) => l.ms !== null);
  for (let k = 1; exact && k < lines.length; k++) if (!sameStatus(lines[k].from, lines[k - 1].to)) exact = false;
  if (exact) {
    const first = lines[0];
    const start = fact.created === null ? first.ms : Math.min(fact.created, first.ms);
    return {
      exact: true,
      steps: [{ at: start, column: columnOf(first.from) }, ...lines.map((l) => ({ at: l.ms, column: columnOf(l.to) }))],
    };
  }
  const steps = [
    { at: fact.created, column: "Backlog" },
    { at: fact.startedAt, column: "In Progress" },
    { at: fact.closedAt, column: "Done" },
  ]
    .filter((s) => s.at !== null && s.at !== undefined)
    .sort((a, b) => a.at - b.at); // stable: steps at one instant keep this order
  const last = steps.length ? steps[steps.length - 1] : null;
  if ((last ? last.column : null) !== fact.column) {
    const at = later(fact.age?.at ?? null, last ? last.at : null);
    if (at !== null) steps.push({ at, column: fact.column });
  }
  return { exact: false, steps };
}

// A path's column at an instant: its last step strictly before it, none
// before its first step.
function columnAt(steps, ms) {
  let column = null;
  for (const s of steps) if (s.at < ms) column = s.column;
  return column;
}

// Each counted story's column at each week's end (the next Monday 00:00Z),
// one row per week of `win`, then a last row with each counted story's
// column now; `columns` are the board's, in its order. `approximate`: the
// counted stories whose path is approximate or empty. Returns {rows:
// [{from, to, at, counts}], approximate}; the last row has from and to null
// and `at` the as-of instant.
export function cumulativeFlow(facts, win, asOfMs, columns) {
  const counted = facts.filter((f) => f.column !== null);
  const paths = counted.map((f) => ({ f, path: columnPath(f) }));
  const zero = () => new Map(columns.map((c) => [c, 0]));
  const bump = (counts, c) => {
    if (c !== null && counts.has(c)) counts.set(c, counts.get(c) + 1);
  };
  const rows = [];
  for (let from = win.from; from < win.to; from += WEEK_MS) {
    const counts = zero();
    for (const { path } of paths) bump(counts, columnAt(path.steps, from + WEEK_MS));
    rows.push({ from, to: from + WEEK_MS, at: from + WEEK_MS, counts });
  }
  const now = zero();
  for (const f of counted) bump(now, f.column);
  rows.push({ from: null, to: null, at: asOfMs, counts: now });
  return {
    rows,
    approximate: paths.filter(({ path }) => !path.exact || path.steps.length === 0).map(({ f }) => f),
  };
}

// ─── Cycle time (the cycle-time spec, contracts 1 and 2) ───────────────

// A story's cycle start, from its own file: {at, source} with `source`
// "log" or "started_at", or null. The `status:` lines whose time reads and
// is at or before `closed_at` (when that reads), in time order, ties in log
// order. The start is the first line after the last move to the Backlog
// (columnOf, so a set-aside or ToDo target is no such move), else the first
// of all, whose target is In Progress or Review; with none, `started_at`. A
// broken chain (a `- ` line parseStatusLog drops, or a `from` that is not
// the previous line's `to`) is not trusted: `started_at` then, else null.
// Never columnPath's steps.
export function cycleStart(fact) {
  const text = String(fact.text ?? "");
  const entries = parseStatusLog(text) || [];
  const closedAt = fact.closedAt ?? null;
  const lines = entries
    .map((e, i) => ({ ...e, ms: stampMs(e.at), i }))
    .filter((e) => e.field === "status" && e.ms !== null && (closedAt === null || e.ms <= closedAt))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const fromStarted = () =>
    fact.startedAt === null || fact.startedAt === undefined ? null : { at: fact.startedAt, source: "started_at" };
  let chained = (logBullets(text) || []).length === entries.length;
  for (let k = 1; chained && k < lines.length; k++) if (!sameStatus(lines[k].from, lines[k - 1].to)) chained = false;
  if (!chained) return fromStarted();
  let after = 0;
  lines.forEach((l, k) => {
    if (columnOf(l.to) === "Backlog") after = k + 1;
  });
  const first = lines.slice(after).find((l) => columnOf(l.to) === "In Progress" || columnOf(l.to) === "Review");
  return first ? { at: first.ms, source: "log" } : fromStarted();
}

// The cycle time over the stories a window counts as closed (windowCounts'
// `closed`): each placed story's whole days from its start to its
// `closed_at` (ageDays), ascending; the median, an even count giving the
// mean of the two middle values rounded down, null with no story placed;
// the stories with no start (or no `closed_at`) apart, oldest first.
// Returns {closed, median, days, unplaced}, closed = days + unplaced.
export function cycleTime(closed) {
  const days = [];
  const unplaced = [];
  for (const f of closed) {
    const s = f.closedAt === null || f.closedAt === undefined ? null : cycleStart(f);
    if (s === null) unplaced.push(f);
    else days.push(ageDays(s.at, f.closedAt));
  }
  days.sort((a, b) => a - b);
  const n = days.length;
  const median = n === 0 ? null : n % 2 ? days[(n - 1) / 2] : Math.floor((days[n / 2 - 1] + days[n / 2]) / 2);
  return { closed: n + unplaced.length, median, days, unplaced: oldestFirst(unplaced) };
}

// ─── Epics without movement (the cycle-time spec, contracts 3 and 4) ───

const newest = (values) => values.reduce((m, v) => (v === null || v === undefined ? m : later(m, v)), null);

// An epic's last change, from its stories (set-aside ones included):
// the newest `status:` line's time ("log"), else the newest `closed_at` or
// `started_at` ("dates", with `field` naming which, `closed_at` on a tie),
// else the newest `created`, the board's `date` standing in ("created");
// null with none.
function lastChange(stories) {
  const log = newest(
    stories.flatMap((f) =>
      (parseStatusLog(String(f.text ?? "")) || []).filter((e) => e.field === "status").map((e) => stampMs(e.at)),
    ),
  );
  if (log !== null) return { at: log, source: "log" };
  const closed = newest(stories.map((f) => f.closedAt));
  const started = newest(stories.map((f) => f.startedAt));
  if (closed !== null || started !== null)
    return closed !== null && (started === null || closed >= started)
      ? { at: closed, source: "dates", field: "closed_at" }
      : { at: started, source: "dates", field: "started_at" };
  const created = newest(stories.map((f) => f.created));
  return created === null ? null : { at: created, source: "created" };
}

// The watched epics: those (readFlowEpics) whose own status reads In
// Progress through columnOf, every one counted. Without movement: a watched
// epic that holds a story, whose stories carry a date, and whose last change is at least
// `days` whole days before the as-of instant. Returns {watched, epics}: the
// number watched, and those without movement, oldest first, ties by vault
// path, each with `age` {at, source} and its `days`.
export function idleEpics(epics, facts, days, asOfMs) {
  const byEpic = new Map();
  for (const f of facts) {
    if (!byEpic.has(f.epic)) byEpic.set(f.epic, []);
    byEpic.get(f.epic).push(f);
  }
  let watched = 0;
  const idle = [];
  for (const e of epics) {
    if (columnOf(e.fm?.status) !== "In Progress") continue;
    watched++;
    const stories = byEpic.get(e.epic) || [];
    if (!stories.length) continue;
    const age = lastChange(stories);
    if (age === null) continue;
    const d = ageDays(age.at, asOfMs);
    if (meets(d, days)) idle.push({ ...e, age, days: d });
  }
  return { watched, epics: oldestFirst(idle) };
}

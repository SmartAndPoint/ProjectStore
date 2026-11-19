// projectstore — rank.mjs: a story's or an epic's place among its siblings.
//
// `rank` is an optional frontmatter key of a story or an epic. It orders the
// open stories of one epic, and the epics of one initiative (or of none), by
// hand: a sequence of work that is not the priority. This module holds the
// ranked-value rule, the groups, the one comparator `siblingOrder` that the
// verb (rank-verb.mjs) and the dashboard's tree both use, and doctor's
// `rank-tie` check. It is pure: it takes items the caller read ({rel, fm} and
// a little more) and reads or writes no file, so doctor and the dashboard can
// import it, and it reaches no writer.
//
// Spec: "The rank verb and the sibling order…" (alias `rank`), contracts 1, 2
// and 10; ADR "The backlog tree is ordered by hand: a rank field on each story
// and epic, written by a rank verb that moves no date", decisions 1 and 2.

import { columnOf } from "./flow-counts.mjs";
import { initiativeIndex, resolveInitiative, referenceOf, initiativeIdOf } from "./initiative.mjs";

// The step between two ranks a verb gives (decision 3).
export const RANK_STEP = 1048576;
// A ranked value: what the frontmatter parser returns, as a string of at most
// fifteen digits, so every value is an exact integer in a double.
export const RANK_RE = /^-?[0-9]{1,15}$/;
export const MAX_RANK_DIGITS = 15;

// The open columns, in the tree's order (the fallback's first term).
export const OPEN_COLUMNS = Object.freeze(["Review", "In Progress", "ToDo", "Backlog"]);
const COLUMN_PLACE = Object.freeze({ Review: 0, "In Progress": 1, ToDo: 2, Backlog: 3 });
const PRIORITY_RE = /^p[0-3]$/;

// The "No initiative" group's key.
export const NO_INITIATIVE = null;

// A rank value, or null for unranked: only a string the parser returned that
// matches RANK_RE ranks (a decimal, a hex or exponent form, sixteen digits or
// more, a list, null, "" and an absent key do not).
export function rankOf(fm) {
  const v = fm ? fm.rank : undefined;
  if (typeof v !== "string" || !RANK_RE.test(v)) return null;
  const n = Number(v);
  return n === 0 ? 0 : n; // -0 reads as 0
}

// The number of digits of a value, its sign aside.
export const digitsOf = (n) => String(Math.abs(n)).length;

// A priority read trimmed: p0 to p3, anything else p2.
export function priorityOf(fm) {
  const p = String(fm?.priority ?? "").trim();
  return PRIORITY_RE.test(p) ? p : "p2";
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// An epic folder's name that the groups take: one that starts with neither
// `_` nor `.` (contract 1). The caller has checked that it holds an epic.md.
export const isEpicId = (id) => typeof id === "string" && !!id && !id.startsWith("_") && !id.startsWith(".");

// One story as a member: {kind, id, epic, slug, rel, abs, fm, rank, column,
// open, priority, title}. `story` is a readFlowStories entry ({rel, epic,
// slug, fm}).
export function storyMember(story) {
  const fm = story.fm || {};
  const slug = story.slug;
  const column = columnOf(fm.status);
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : slug;
  return {
    kind: "story",
    id: `${story.epic}/${slug}`,
    epic: story.epic,
    slug,
    rel: story.rel,
    abs: story.abs ?? null,
    fm,
    rank: rankOf(fm),
    column,
    open: Object.hasOwn(COLUMN_PLACE, column ?? ""),
    priority: priorityOf(fm),
    title,
  };
}

// One epic as a member: {kind, id, rel, abs, fm, rank}. `epic` is {id, rel, fm}.
export function epicMember(epic) {
  return { kind: "epic", id: epic.id, rel: epic.rel, abs: epic.abs ?? null, fm: epic.fm || {}, rank: rankOf(epic.fm) };
}

// The comparator: ranked before unranked; the rank value; the fallback (a
// story's column, priority and title; an epic has none); the id.
export function compareSiblings(a, b) {
  const ra = a.rank !== null;
  const rb = b.rank !== null;
  if (ra !== rb) return ra ? -1 : 1;
  if (ra && a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.kind === "story" && b.kind === "story") {
    const ca = COLUMN_PLACE[a.column] ?? OPEN_COLUMNS.length;
    const cb = COLUMN_PLACE[b.column] ?? OPEN_COLUMNS.length;
    if (ca !== cb) return ca - cb;
    if (a.priority !== b.priority) return byCodeUnits(a.priority, b.priority);
    const t = byCodeUnits(a.title, b.title);
    if (t) return t;
  }
  return byCodeUnits(a.id, b.id);
}

// A group's members in their one order.
export function siblingOrder(members) {
  return [...members].sort(compareSiblings);
}

// The stories' groups: epic id → its open stories as members, in no order.
// Stories that are not open are in no group.
export function storyGroups(stories) {
  const groups = new Map();
  for (const s of stories) {
    const m = storyMember(s);
    if (!m.open) continue;
    if (!groups.has(m.epic)) groups.set(m.epic, []);
    groups.get(m.epic).push(m);
  }
  return groups;
}

// The epic's group key: the id of the initiative its `initiative:` resolves
// to by the one id rule, else NO_INITIATIVE.
export function epicGroupKey(epic, index) {
  const hit = resolveInitiative(index, referenceOf(epic.fm?.initiative));
  return hit ? initiativeIdOf(hit) : NO_INITIATIVE;
}

// The epics' groups: initiative id (NO_INITIATIVE for none) → its epics as
// members, in no order; a folder isEpicId refuses is in none. `initiatives`
// are {rel, fm} items.
export function epicGroups(epics, initiatives) {
  const index = initiativeIndex(initiatives);
  const groups = new Map();
  for (const e of epics) {
    if (!isEpicId(e.id)) continue;
    const key = epicGroupKey(e, index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(epicMember(e));
  }
  return groups;
}

// Doctor's `rank-tie` (contract 10): for each group and each value two or
// more of its members hold, one {group, kind, value, members} entry, members
// in sibling order. `group` is the epic id, the initiative id, or null for
// "No initiative".
export function rankTies({ stories = [], epics = [], initiatives = [] } = {}) {
  const out = [];
  const scan = (kind, groups) => {
    for (const [group, members] of groups) {
      const byValue = new Map();
      for (const m of siblingOrder(members)) {
        if (m.rank === null) continue;
        if (!byValue.has(m.rank)) byValue.set(m.rank, []);
        byValue.get(m.rank).push(m);
      }
      for (const [value, held] of byValue) if (held.length > 1) out.push({ group, kind, value, members: held });
    }
  };
  scan("story", storyGroups(stories));
  scan("epic", epicGroups(epics, initiatives));
  return out;
}

// Doctor's `rank-tie` findings (contract 10): one info finding per group and
// shared value. `finding(level, check, message, file)` is doctor's factory.
// Registered in doctor's vault group only, never at session start.
export function checkRankTies(items, { finding }) {
  return rankTies(items).map((t) => {
    const where =
      t.kind === "story" ? `epic ${t.group}` : t.group === NO_INITIATIVE ? `"No initiative"` : `initiative ${t.group}`;
    const names = t.members.map((m) => m.id).join(", ");
    const fallback = t.kind === "story" ? "column, priority and title" : "the epic id";
    return finding(
      "info",
      "rank-tie",
      `In ${where}, ${names} hold the same rank ${t.value}; their order falls back to ${fallback}. Move one past the other with rank, or edit a value by hand; a move to its own place writes nothing.`,
      t.members[0].rel,
    );
  });
}

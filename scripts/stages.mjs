// projectstore — stages.mjs: how a story's status reads on the board.
//
// One table for two readers: the kanban board (scripts/kanban.mjs) and the
// band above the prompt (hooks/band.tsx), which counts an epic's stories by
// the same rule so the band and kanban.md never disagree. The band is a Claude
// Code hooks module and runs with no Node, so this file imports nothing at
// all — keep it that way.

// Statuses that describe work which is not on the board by definition: it was
// replaced, postponed, or set aside. Putting them in a column would claim the
// work is queued, which is the opposite of what the status says.
export const NOT_ACTIONABLE = new Set(["superseded", "deferred", "parked"]);

// A lower-cased status to its board column. Exact match; anything the table
// does not name is Backlog.
export function statusToColumn(status) {
  const m = {
    planned: "Backlog",
    todo: "ToDo",
    "to-do": "ToDo",
    "in-progress": "In Progress",
    in_progress: "In Progress",
    "in progress": "In Progress",
    review: "Review",
    done: "Done",
    closed: "Done",
  };
  return m[status] || "Backlog";
}

// The band's three stages, folded from the board's columns.
export const COLUMN_STAGE = Object.freeze({
  Done: "done",
  "In Progress": "active",
  Review: "active",
  ToDo: "backlog",
  Backlog: "backlog",
});

// A story's stage from its raw frontmatter status, as the board reads it:
// lower-cased; no status, or a status the board leaves off, counts nowhere
// (null).
export function stageOf(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const status = String(raw).toLowerCase();
  if (NOT_ACTIONABLE.has(status)) return null;
  return COLUMN_STAGE[statusToColumn(status)] || "backlog";
}

// Raw statuses → { done, active, backlog }.
export function foldStages(statuses) {
  const out = { done: 0, active: 0, backlog: 0 };
  for (const raw of statuses) {
    const stage = stageOf(raw);
    if (stage) out[stage]++;
  }
  return out;
}

// Line-based frontmatter: `key: value` scalars between the opening `---` and
// the next one. Quoted values are JSON-decoded (titles that hold quotes),
// `null` is null; block sequences are invisible to it.
export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { data: {}, body: md };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "null") v = null;
    else if (v.startsWith('"') && v.endsWith('"')) {
      // JSON.parse round-trips escaped scalars from renderTemplate's _json
      // form (titles containing quotes); fall back to the bare strip.
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    data[kv[1]] = v;
  }
  return { data, body: md.slice(m[0].length) };
}

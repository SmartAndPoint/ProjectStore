// The edit verb's cut of a file, its base hash and its guards (the spec "The
// edit verb: an item's sections replaced against a base hash…", alias `edit`,
// contracts 2 and 5). It writes nothing and reads only the headings registry
// (through grammar.mjs), so the dashboard's page imports it through the core
// root the launcher gives and holds no copy.
//
// The text after the frontmatter of a file the edit verb takes (editRefusal) is cut in
// three parts: the head (the H1 and the field table, up to the first `## `
// line), the body (every `## ` section: what an edit replaces) and the foot (a
// last `---` line with the "Last updated" line under it, as the gates read it).
// The guards read the sections and checkboxes with the core's own readers, so a
// heading in any registered language, in any case, is the same section.
import { createHash } from "node:crypto";
import { sectionOf, footerDateRe } from "./grammar.mjs";
import { checklistItems, stripCodeSpans, linesOutsideFences } from "./lib.mjs";

// The kinds the edit verb writes, each with the statuses it takes them in (null: any): an ADR while
// `proposed`, a spec and a research note while `draft`. Past that, an ADR, a spec or a note others
// cite changes by a dated note or a `> amended` marker in a session, which no editor writes, and a
// closed one does not change (the edit spec, contract 3, as amended 2026-11-25).
export const EDIT_STATUSES = Object.freeze({
  story: null,
  epic: null,
  initiative: null,
  adr: Object.freeze(["proposed"]),
  spec: Object.freeze(["draft"]),
  research: Object.freeze(["draft"]),
});
export const EDIT_KINDS = Object.freeze(Object.keys(EDIT_STATUSES));
const lower = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
const NAME = { adr: "ADR", spec: "spec", research: "research note" };
const A = { adr: "an ADR", spec: "a spec", research: "a research note" };
const HOW = {
  adr: "An ADR past proposed changes by a dated note under its decision, written in a session; no editor writes one.",
  spec: "A spec past draft changes by a `> amended` marker on its contract, written in a session; no editor writes one.",
  research:
    "A research note that is no longer a draft is cited by its findings, and changes by a dated note written in a session; no editor writes one.",
};
// Statuses that close a file: nothing changes it, not even a note.
const CLOSED = new Set(["superseded", "rejected", "deprecated"]);

// Why the edit verb does not write a file of this kind and status, or null when it does: the one
// predicate the verb and the dashboard's server ask, so the two cannot disagree.
export function editRefusal(type, status) {
  const t = lower(type);
  if (!t) return "it has no type, so it is no artifact the edit verb writes";
  if (!Object.hasOwn(EDIT_STATUSES, t))
    return `it is of the kind ${t}; edit writes a story, an epic, an initiative, a proposed ADR, a draft spec or a draft research note`;
  const open = EDIT_STATUSES[t];
  // A status is one word: a list or a number is no status.
  const s = typeof status === "string" ? lower(status) : "";
  if (open === null || open.includes(s)) return null;
  const why = CLOSED.has(s) ? `A ${s} ${NAME[t]} is closed: nothing changes it.` : HOW[t];
  return `this ${NAME[t]} is ${s || "of no status"}, and edit writes ${A[t]} only while it is ${open[0]}. ${why}`;
}

export const normalise = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

// The first 16 hex digits of the SHA-256 of the body's UTF-8 bytes.
export const bodyHash = (body) => createHash("sha256").update(normalise(body), "utf8").digest("hex").slice(0, 16);

// Where the foot starts in `text`, or -1: a `---` line, then only blank lines,
// then one line the gates read as the "Last updated" line, then white space.
function footAt(text) {
  const lines = text.split("\n");
  let k = lines.length - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  if (k < 0 || !new RegExp(footerDateRe().source, "i").test(lines[k].trim())) return -1;
  let j = k - 1;
  while (j >= 0 && !lines[j].trim()) j--;
  if (j < 0 || !/^---[ \t]*$/.test(lines[j])) return -1;
  // The newline before the `---` line belongs to the foot.
  const at = lines.slice(0, j).join("\n").length;
  return j === 0 ? 0 : at;
}

// `rest` is the text after the frontmatter. → { head, body, foot }, which
// joined give `rest` with its line endings as LF. With no `## ` line the head
// runs to the foot and the body is empty.
export function splitForEdit(rest) {
  const text = normalise(rest);
  const f = footAt(text);
  const end = f === -1 ? text.length : f;
  const first = text.slice(0, end).search(/^## /m);
  const headEnd = first === -1 ? end : first;
  return { head: text.slice(0, headEnd), body: text.slice(headEnd, end), foot: text.slice(end) };
}

// A section as the core reads it, trimmed; null when it is not there.
const sectionText = (body, id) => {
  const s = sectionOf(normalise(body), id);
  return s === null ? null : s.trim();
};

// The texts of a section's checked items, as the core reads them: a story's
// criteria over the lines outside fenced blocks, as doctor and follow read
// them; an epic's Expected Results after code spans are stripped, as the epic
// rule reads them.
const checkedTexts = (body, id) => {
  const s = sectionOf(normalise(body), id);
  if (s === null) return [];
  const lines = id === "acceptance" || id === "spec_acceptance" ? linesOutsideFences(s) : stripCodeSpans(s).split("\n");
  return checklistItems(lines)
    .filter((i) => i.checked)
    .map((i) => i.text.trim());
};

// True when every item of `next` is in `was`, as many times as `next` holds it.
function within(next, was) {
  const left = new Map();
  for (const t of was) left.set(t, (left.get(t) || 0) + 1);
  for (const t of next) {
    const n = left.get(t) || 0;
    if (!n) return false;
    left.set(t, n - 1);
  }
  return true;
}

// What gates and verbs own in each kind (contract 5): a section kept as it is,
// and sections whose checked items a text may not add to or change.
const KEPT = { story: ["status_log"], epic: [], initiative: ["initiative_outcome"], adr: [], spec: [], research: [] };
const CHECKED = {
  story: ["acceptance"],
  epic: ["expected_results"],
  initiative: [],
  adr: [],
  spec: ["spec_acceptance"],
  research: [],
};
const PART = {
  status_log: "the Status log",
  initiative_outcome: "the Outcome",
  acceptance: "the Acceptance Criteria",
  expected_results: "the Expected Results",
  spec_acceptance: "the spec's Acceptance",
};

// Why a new body is refused, as { part, error }, or null. `was` is the body the
// file holds; `next` the text that would replace it.
export function guardEdit(type, was, next) {
  const text = normalise(next);
  if (!/^## /.test(text))
    return {
      part: "title",
      error:
        "The text must start with a `## ` section. The title and the field table above it are not the edit's: put your words under a section.",
    };
  // A "Last updated" line is the foot's, which the gates rewrite (contract 6).
  if (new RegExp(footerDateRe().source, "mi").test(text))
    return {
      part: "foot",
      error:
        "The text holds a \"Last updated\" line, which is the file's own foot and the gates' to write. Remove it from the text.",
    };
  for (const id of KEPT[type] || [])
    if (sectionText(was, id) !== sectionText(text, id))
      return {
        part: id,
        error: `${PART[id]} is written by gates and verbs, and this text ${sectionText(was, id) === null ? "adds it" : sectionText(text, id) === null ? "removes it" : "changes it"}. Put it back as it was.`,
      };
  for (const id of CHECKED[type] || [])
    if (!within(checkedTexts(text, id), checkedTexts(was, id)))
      return {
        part: id,
        error: `A checked item of ${PART[id]} is checked with its evidence when the work is closed, and this text checks or changes one. Untick it, or leave its words as they were.`,
      };
  return null;
}

// The `## ` headings whose sections differ between two bodies: in the order of
// `next`, then those only `was` holds; a heading held twice is named once.
export function changedSections(was, next) {
  const parts = (body) => {
    const out = new Map();
    const t = normalise(body);
    const heads = [...t.matchAll(/^## (.*)$/gm)];
    heads.forEach((m, i) => {
      const key = m[1].trim();
      const piece = t.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : t.length).trimEnd();
      out.set(key, out.has(key) ? `${out.get(key)}\n${piece}` : piece);
    });
    return out;
  };
  const a = parts(was);
  const b = parts(next);
  const out = [];
  for (const [h, t] of b) if (a.get(h) !== t) out.push(h);
  for (const h of a.keys()) if (!b.has(h)) out.push(h);
  return out;
}

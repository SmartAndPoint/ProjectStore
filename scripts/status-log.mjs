// projectstore — status-log.mjs: a story's status stamp and Status log, as text.
//
// Every change of a story's `status` or `assignee` leaves the same marks in
// the story, whoever makes it: the frontmatter value, the header table's row,
// one line of the `## Status log` section and, for a status, the
// `status_changed_at` stamp. This module computes those marks from a story's
// text and reads them back: the line grammar, the two pure changes the gates
// and the writers call, the trust rule every reader of an age in status uses,
// the --check mask, and the row of an epic's Stories table. Pure: no I/O, so
// the gates (story-section.mjs) stay compute-only and the writers
// (status-change.mjs) re-read and replace around it.
//
// Spec: SPEC-001 contracts 2, 3 and 7 as amended 2026-11-10 by
// PS-FLOW/story-every-status-change-is-stamped-and-logged-in-the-story-and-a-
// command-moves-a-story-between-the-backlog-and-todo, and contract 3 as
// amended 2026-11-11 by PS-FLOW/story-doctor-checks-the-flow-against-the-
// vaults-policy-… (the stamp reader in the trust rule; "Flow counts…",
// contracts 1 and 4, for stampMs and isAwaitingClose). The grammar is the one
// decision 8 of "A story's status follows its pull request…" quotes:
//
//   - <ISO> <field>: <from> → <to> — <reason> (<actor>)
//
// The tokens stay English in every locale, so a script reads them; the
// section heading and the header labels are the registry's
// (scaffold/headings.json: headings.status_log, fields.status,
// fields.assignee), matched in every bundled language.

import { resolve, dirname } from "node:path";
import { loadHeadingsRegistry, heading, headingLineRe, footerDateRe, parseFrontmatter, extractLinks } from "./lib.mjs";
import { statusToColumn, NOT_ACTIONABLE, STATUS_COLUMNS } from "./stages.mjs";

export const STATUS_FIELDS = Object.freeze(["status", "assignee", "pr"]);
export const STATUS_ACTORS = Object.freeze(["plan gate", "close gate", "follow", "groom", "handover", "move"]);
// An empty side of a log line.
export const EMPTY = "none";

// One line of text: not empty, and no line break or other control character
// (the same class as flow-policy.mjs's). Returns the trimmed text or throws.
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
export function oneLine(s, what = "the reason") {
  const v = String(s ?? "").trim();
  if (!v) throw new Error(`${what} is empty`);
  if (CONTROL.test(v)) throw new Error(`${what} must be one line, with no line break or control character`);
  return v;
}

export function checkActor(actor) {
  const a = String(actor ?? "").trim();
  if (!STATUS_ACTORS.includes(a)) throw new Error(`the actor is one of ${STATUS_ACTORS.join(", ")}; got "${a}"`);
  return a;
}

// ─── Frontmatter and sections (moved here from story-section.mjs) ──────

// Replace `key: ...` inside the frontmatter block, or insert the line before
// the closing --- when the key is absent. Returns the whole file text.
export function setFm(text, key, value) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("story has no frontmatter block");
  const fmLines = m[1].split("\n");
  const idx = fmLines.findIndex((l) => l.startsWith(`${key}:`));
  const line = `${key}: ${value}`;
  if (idx >= 0) fmLines[idx] = line;
  else fmLines.push(line);
  return text.slice(0, m.index) + `---\n${fmLines.join("\n")}\n---` + text.slice(m.index + m[0].length);
}

// End index of section `id` (position right before the next `## ` heading
// after it), or null when the section is absent.
export function sectionEnd(text, id) {
  const m = text.match(headingLineRe(id));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? text.length : m.index + m[0].length + next;
}

// The same, but a `---` rule line ends the section too: the last section of a
// story is followed by the footer, and an insertion after it must land before
// the footer, not after it.
function sectionEndBeforeRule(text, id) {
  const m = text.match(headingLineRe(id));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^(?:## |---\s*$)/m);
  return next === -1 ? text.length : m.index + m[0].length + next;
}

export function insertSection(text, id, lang, placeholder, anchors, { end = sectionEnd } = {}) {
  if (headingLineRe(id).test(text)) return { text, inserted: false };
  const block = `## ${heading(id, lang)}\n\n${placeholder}\n\n`;
  for (const anchor of anchors) {
    const at = end(text, anchor);
    if (at !== null) {
      return { text: text.slice(0, at) + block + text.slice(at), inserted: true };
    }
  }
  // Fallback: before the trailing `---` footer, else EOF.
  const footer = text.lastIndexOf("\n---\n");
  const at = footer > 0 ? footer + 1 : text.length;
  return { text: text.slice(0, at) + block + text.slice(at), inserted: true };
}

// `updated:` and the body footer, in step (the gates' and the writers' bump).
export function touchStory(text, day) {
  const t = setFm(text, "updated", day);
  return t.replace(footerDateRe(), (_m, prefix, suffix) => `${prefix}${day}${suffix}`);
}

// ─── Table cells ───────────────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fieldForms(id) {
  const entry = loadHeadingsRegistry().fields?.[id];
  if (!entry) throw new Error(`headings.json has no fields entry "${id}"`);
  return Object.values(entry).flat();
}

// The positions of a table row's unescaped pipes.
export function pipes(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") out.push(i);
  }
  return out;
}

const cellValue = (v) => String(v).replace(/\|/g, "\\|");

// The line with the cell between pipes a and b holding `value`; the cell's
// own padding is kept, an empty cell gets one space each side.
function rewriteCell(line, a, b, value) {
  const cell = line.slice(a + 1, b);
  const m = cell.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const lead = m[2] ? m[1] : " ";
  const trail = m[2] ? m[3] : " ";
  return line.slice(0, a + 1) + lead + cellValue(value) + trail + line.slice(b);
}

// Where the header block is: after the H1 (else the frontmatter), before the
// first `## `.
function headerBlock(text) {
  const fm = text.match(/^---\n[\s\S]*?\n---/);
  let start = fm ? fm[0].length : 0;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  const h1 = text.slice(start, end).match(/^# .*$/m);
  if (h1) start += h1.index + h1[0].length;
  return { start, end };
}

// The value cell of the header table's row labelled with field `id`, in any
// bundled language. Only the header block is read; a row the story lacks is
// not added. Returns {text, found}.
export function setHeaderField(text, id, value) {
  const label = new RegExp(`^\\*\\*\\s*(?:${fieldForms(id).map(escapeRe).join("|")})\\s*\\*\\*$`, "i");
  const { start, end } = headerBlock(text);
  const lines = text.slice(start, end).split("\n");
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].startsWith("|")) continue;
    const p = pipes(lines[k]);
    if (p.length < 3 || !label.test(lines[k].slice(p[0] + 1, p[1]).trim())) continue;
    lines[k] = rewriteCell(lines[k], p[1], p[2], value);
    return { text: text.slice(0, start) + lines.join("\n") + text.slice(end), found: true };
  }
  return { text, found: false };
}

// ─── The Status log ────────────────────────────────────────────────────

const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z`;
const LINE_RE = new RegExp(`^- (${ISO}) (status|assignee|pr): (.*?) → (.*?) — (.*) \\(([^()]+)\\)\\s*$`);
const STATUS_LINE_START = new RegExp(`^- ${ISO} status:`);
const side = (v) => (v === null || v === undefined || String(v).trim() === "" ? EMPTY : String(v).trim());

export function logLine({ at, field, from, to, reason, actor }) {
  return `- ${at} ${field}: ${side(from)} → ${side(to)} — ${reason} (${actor})`;
}

// The Status log section's span: [bodyStart, end), end before the next `## `
// heading or `---` rule. null when the story has no section.
function logSpan(text) {
  const m = text.match(headingLineRe("status_log"));
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  const next = text.slice(bodyStart).search(/^(?:## |---\s*$)/m);
  return { headingEnd: bodyStart, end: next === -1 ? text.length : bodyStart + next };
}

// Every line of the Status log that reads in the grammar, in file order. A
// line that does not parse is not an entry. null when there is no section.
export function parseStatusLog(text) {
  const span = logSpan(text);
  if (!span) return null;
  const out = [];
  for (const line of text.slice(span.headingEnd, span.end).split("\n")) {
    const m = line.match(LINE_RE);
    if (m) out.push({ at: m[1], field: m[2], from: m[3], to: m[4], reason: m[5], actor: m[6], line });
  }
  return out;
}

// The text with `line` appended to the Status log: after its last `- ` line,
// or, with no section, in a new section after Final Summary and before
// Technical Notes (contract 2). An existing line is never touched.
export function appendLogLine(text, line, lang = "en") {
  const span = logSpan(text);
  if (!span) {
    return insertSection(
      text,
      "status_log",
      lang,
      line,
      ["final_summary", "acceptance", "implementation_plan", "decomposition", "description"],
      { end: sectionEndBeforeRule },
    ).text;
  }
  const body = text.slice(span.headingEnd, span.end);
  let lastEnd = -1;
  let pos = 0;
  for (const l of body.split("\n")) {
    if (l.startsWith("- ")) lastEnd = pos + l.length;
    pos += l.length + 1;
  }
  if (lastEnd === -1) {
    const at = span.headingEnd;
    return `${text.slice(0, at)}\n\n${line}${text.slice(at)}`;
  }
  const at = span.headingEnd + lastEnd;
  return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

// The last line of the Status log that starts `- <ISO> status:`, parsed, or
// {unparsed: line} when it does not read in the grammar; null when there is
// none. Lines of other fields are not read.
export function lastStatusLine(text) {
  const span = logSpan(text);
  if (!span) return null;
  const lines = text
    .slice(span.headingEnd, span.end)
    .split("\n")
    .filter((l) => STATUS_LINE_START.test(l));
  if (!lines.length) return null;
  const line = lines[lines.length - 1];
  const m = line.match(LINE_RE);
  if (!m) return { unparsed: line };
  return { at: m[1], field: m[2], from: m[3], to: m[4], reason: m[5], actor: m[6], line };
}

// ─── The two changes ───────────────────────────────────────────────────

// A change of status: the frontmatter `status`, `status_changed_at` (the
// same `at` as the line), the header's Status row and one `status:` line.
// No-op when the status already equals `to` (sameStatus), unless `equal`:
// then one `status:` line with equal sides (`review → review`, follow's
// awaiting line) is appended and `status_changed_at` stamped at its time, the
// status and its row left as they read (SPEC-001 contract 3, as amended
// 2026-11-12; the follow spec's contract 6). Returns {text, changed, from,
// line}.
export function applyStatusChange(text, { to, reason, actor, at, lang = "en", equal = false }) {
  const fm = parseFrontmatter(text).data;
  const from = fm.status === null || fm.status === undefined ? "" : String(fm.status).trim();
  const same = sameStatus(from, to);
  if (same && !equal) return { text, changed: false, from, line: null };
  const why = oneLine(reason);
  const who = checkActor(actor);
  if (same) {
    const line = logLine({ at, field: "status", from, to, reason: why, actor: who });
    const t = appendLogLine(text, line, lang);
    return { text: setFm(t, "status_changed_at", JSON.stringify(at)), changed: true, from, line };
  }
  let t = setFm(text, "status", to);
  t = setFm(t, "status_changed_at", JSON.stringify(at));
  t = setHeaderField(t, "status", to).text;
  const line = logLine({ at, field: "status", from, to, reason: why, actor: who });
  return { text: appendLogLine(t, line, lang), changed: true, from, line };
}

// A change of assignee: the frontmatter `assignee`, the header's Assignee
// row and one `assignee:` line; no stamp. No-op when it already reads `to`.
export function applyAssigneeChange(text, { to, reason, actor, at, lang = "en" }) {
  const fm = parseFrontmatter(text).data;
  const from = fm.assignee === null || fm.assignee === undefined ? "" : String(fm.assignee).trim();
  const next = String(to ?? "").trim();
  if (from === next) return { text, changed: false, from, line: null };
  const why = oneLine(reason);
  const who = checkActor(actor);
  let t = setFm(text, "assignee", JSON.stringify(next));
  t = setHeaderField(t, "assignee", next).text;
  const line = logLine({ at, field: "assignee", from, to: next, reason: why, actor: who });
  return { text: appendLogLine(t, line, lang), changed: true, from, line };
}

// ─── The trust rule (contract 3) ───────────────────────────────────────

const KNOWN = (s) => Object.hasOwn(STATUS_COLUMNS, s);

// Two statuses are equal when, lower-cased, they are the same string, or when
// statusToColumn's table names both and maps them to one column
// (`in_progress` is `in-progress`). A status the table does not name equals
// only itself: the NOT_ACTIONABLE ones, an empty one, a typo (else `parked`
// would read as `planned`, both Backlog).
export function sameStatus(a, b) {
  const x = String(a ?? "")
    .trim()
    .toLowerCase();
  const y = String(b ?? "")
    .trim()
    .toLowerCase();
  if (x === y) return true;
  if (NOT_ACTIONABLE.has(x) || NOT_ACTIONABLE.has(y) || !KNOWN(x) || !KNOWN(y)) return false;
  return statusToColumn(x) === statusToColumn(y);
}

// ─── The stamp reader (Flow counts, contract 1) ────────────────────────

// A stamp reads in two forms only, on a real calendar day and a real time of
// day: a date `YYYY-MM-DD` (that day's 00:00 UTC) and an instant
// `YYYY-MM-DDTHH:MM`, with optional `:SS` and `.fff`, then `Z`, `±HH:MM` or
// no zone. No zone is UTC, never the machine's zone: a bare Date.parse of
// `2026-11-10T09:00` reads local time, so it is never used here. Anything
// else does not read: null. Returns epoch milliseconds.
const STAMP_RE = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?(Z|[+-]\d\d:\d\d)?)?$/;
export function stampMs(value) {
  if (value === null || value === undefined) return null;
  const m = STAMP_RE.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const day = Date.UTC(y, mo - 1, d);
  const back = new Date(day);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (m[4] === undefined) return m[8] === undefined ? day : null;
  const [h, mi, se] = [+m[4], +m[5], m[6] === undefined ? 0 : +m[6]];
  if (h > 23 || mi > 59 || se > 59) return null;
  const ms = m[7] === undefined ? 0 : Math.floor(Number(`0.${m[7]}`) * 1000);
  let offset = 0;
  if (m[8] && m[8] !== "Z") {
    const oh = +m[8].slice(1, 3);
    const om = +m[8].slice(4, 6);
    if (oh > 23 || om > 59) return null;
    offset = (m[8][0] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return day + ((h * 60 + mi) * 60 + se) * 1000 + ms - offset;
}

// When the story's current status began, and whether that date can be
// trusted: only when the last `status:` line parses, its time is the instant
// of `status_changed_at`, both read by stampMs, and its target equals the
// current status (sameStatus). Otherwise the age is read from `updated`, else
// `created`, each when stampMs reads it (SPEC-001 contract 3, as amended
// 2026-11-11). Reads only; nothing is written to a story without a log.
// Returns {trusted, at, source: "stamp"|"updated"|"created"|null, why:
// null|"no-log"|"unparsed"|"differs"|"no-stamp"|"time-differs"}.
export function statusStamp(text) {
  const fm = parseFrontmatter(text).data;
  const fallback = (why) => {
    const source = stampMs(fm.updated) !== null ? "updated" : stampMs(fm.created) !== null ? "created" : null;
    return { trusted: false, at: source ? String(fm[source]) : null, source, why };
  };
  const last = lastStatusLine(text);
  if (!last) return fallback("no-log");
  if (last.unparsed) return fallback("unparsed");
  if (!sameStatus(last.to, fm.status)) return fallback("differs");
  if (!fm.status_changed_at) return fallback("no-stamp");
  // The same instant, not the same string: `…:00Z` is `…:00.000Z`, and
  // `…T09:00` with no zone is `…T09:00:00.000Z` on every machine.
  const stamp = stampMs(fm.status_changed_at);
  if (stamp === null || stamp !== stampMs(last.at)) return fallback("time-differs");
  return { trusted: true, at: String(fm.status_changed_at), source: "stamp", why: null };
}

// ─── Awaiting close (Flow counts, contract 4) ─────────────────────────

// The reason `follow` writes when a pull request merged and the story's
// criteria are not yet evidenced, with or without `: <url>` after it.
export const AWAITING_REASON = "merged, awaiting evidence";
const AWAITING_RE = /^merged, awaiting evidence(?:: .+)?$/;

// A story is awaiting close when its column is Review, its stamp is trusted,
// and the reason of its last `status:` line is AWAITING_REASON. One predicate
// for doctor, `next`, `flow.md` and `follow`. A hand edit of the status, or a
// later `status:` line, ends the state.
export function isAwaitingClose(text) {
  const fm = parseFrontmatter(text).data;
  const status = String(fm.status ?? "")
    .trim()
    .toLowerCase();
  if (statusToColumn(status) !== "Review" || NOT_ACTIONABLE.has(status)) return false;
  if (!statusStamp(text).trusted) return false;
  const last = lastStatusLine(text);
  return Boolean(last && !last.unparsed && AWAITING_RE.test(last.reason.trim()));
}

// ─── --check's mask ────────────────────────────────────────────────────

// The timestamps of the Status log's lines, neutralised for a --check
// comparison: a fresh run stamps a fresh time. Only the timestamp, and only
// inside the section: a reason or a hand-written line stays visible.
export function maskStatusLog(text) {
  const span = logSpan(text);
  if (!span) return text;
  const re = new RegExp(`^- ${ISO} (?=(?:${STATUS_FIELDS.join("|")}): )`, "gm");
  const body = text.slice(span.headingEnd, span.end).replace(re, "- «volatile» ");
  return text.slice(0, span.headingEnd) + body + text.slice(span.end);
}

// ─── An epic's Stories table ───────────────────────────────────────────

// The story's slug: its file stem, or a folder-shape story's folder name.
export function storySlug(storyPath) {
  const segs = String(storyPath).split(/[\\/]/).filter(Boolean);
  let last = segs[segs.length - 1] || "";
  if (/^readme\.md$/i.test(last) && segs.length > 1) last = segs[segs.length - 2];
  return last.replace(/\.md$/i, "");
}

// Does a link in epic.md point at the story? A markdown link whose target,
// resolved from the epic's folder, is the story's file; a wikilink naming its
// slug (the last segment, `.md` or not). The epic rule (epic-rule.mjs) reads
// the Stories table's rows by the same test.
export function linksTo(link, { epicDir, storyPath, slug }) {
  if (link.type === "mdlink") {
    let target = link.target;
    try {
      target = decodeURI(target);
    } catch {}
    return resolve(epicDir, target) === resolve(storyPath);
  }
  const segs = String(link.target).split("/").filter(Boolean);
  return (segs[segs.length - 1] || "").replace(/\.md$/i, "").toLowerCase() === slug.toLowerCase();
}

// The Status cell of the first row, in a table whose header row has a Status
// column (a registry label, any language; the column is found there, never by
// place), that links to the story, set to `status`. Cells split at unescaped
// pipes; only that cell's bytes change. Returns {text, found, changed}; no
// such row (a list instead of a table, a row with no link, no table) is
// found: false and the text unchanged.
export function epicRowUpdate(epicText, { epicPath, storyPath, status }) {
  const label = new RegExp(`^(?:${fieldForms("status").map(escapeRe).join("|")})$`, "i");
  const ctx = { epicDir: dirname(resolve(epicPath)), storyPath, slug: storySlug(storyPath) };
  const lines = epicText.split("\n");
  let fence = false;
  let col = -1;
  let inTable = false;
  let headerAt = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence || !l.startsWith("|")) {
      inTable = false;
      continue;
    }
    const p = pipes(l);
    if (!inTable) {
      inTable = true;
      headerAt = k;
      col = -1;
      for (let c = 0; c + 1 < p.length; c++)
        if (label.test(l.slice(p[c] + 1, p[c + 1]).trim())) {
          col = c;
          break;
        }
      continue;
    }
    if (col === -1 || k === headerAt + 1 || p.length < col + 2) continue;
    if (!extractLinks(l).some((x) => linksTo(x, ctx))) continue;
    lines[k] = rewriteCell(l, p[col], p[col + 1], status);
    const text = lines.join("\n");
    return { text, found: true, changed: text !== epicText };
  }
  return { text: epicText, found: false, changed: false };
}

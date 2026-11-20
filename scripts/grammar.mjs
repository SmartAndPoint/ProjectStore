// projectstore — grammar.mjs: the registered grammar of a vault's Markdown text.
//
// Moved out of lib.mjs as it was (the PS-SPECTREE story "The marker parser and
// the skeleton leave lib.mjs"): the heading / keyword registry, the inline
// grammars built from it, the citation token, the amendment-marker grammar and
// its parser, and the date and index-header helpers. lib.mjs re-exports every
// name it exported before, so no importer changes.
//
// A leaf: it imports nothing of lib.mjs. harness.mjs, itself a leaf, names the
// plugin root the registry is read from.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./harness.mjs";

// ─── Heading / keyword registry (PS-SPEC story-002) ────────────────────
//
// scaffold/headings.json is the language-independent registry of the section
// headings, inline keywords and index-table column names the deterministic
// scripts (doctor / reconcile / story-section) must recognize. Per id, per
// language, an ARRAY of accepted forms; the FIRST form of the configured
// language is the canonical form used when WRITING. Matching always accepts
// every registered form of every language — a ru-headed file in an en-bound
// vault must still lint. This is deliberately separate from
// templates/<lang>/strings.json, a render-only map: the status line's strings
// and the folder names and descriptions scaffold writes into READMEs, which
// nothing ever matches against.

let _headingsCache = null;

export function loadHeadingsRegistry() {
  if (_headingsCache) return _headingsCache;
  const p = join(pluginRoot(), "scaffold", "headings.json");
  try {
    _headingsCache = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`heading registry missing or unreadable (${p}): ${e.message}`, { cause: e });
  }
  return _headingsCache;
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allForms(section, id) {
  const entry = loadHeadingsRegistry()[section]?.[id];
  if (!entry) throw new Error(`headings.json has no ${section} entry "${id}"`);
  return Object.values(entry).flat();
}

// Canonical write form for the configured language (en fallback).
export function heading(id, lang = "en") {
  const entry = loadHeadingsRegistry().headings?.[id];
  if (!entry) throw new Error(`headings.json has no headings entry "${id}"`);
  return (entry[lang] || entry.en)[0];
}

// Matches a `## <heading>` line in any registered language, case-insensitively
// (hand-typed `## критерии приёмки` still matches). Anchored to the full line
// so "Acceptance" never matches "Acceptance Criteria".
export function headingLineRe(id) {
  const forms = allForms("headings", id).map(escapeRe);
  return new RegExp(`^##\\s+(?:${forms.join("|")})\\s*$`, "mi");
}

// Extract the body of section `id`: text between its heading line and the
// next `## ` heading (or end of file). Returns null when the section is absent.
export function sectionOf(body, id) {
  const m = body.match(headingLineRe(id));
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function keywordRe(id) {
  const forms = allForms("keywords", id).map(escapeRe);
  return new RegExp(`(?:${forms.join("|")})`, "i");
}

// The two inline grammars built from a keyword plus a colon: the evidence suffix
// on a checked acceptance criterion, and the story attribution on a spec
// acceptance item. Both live here rather than inline at their call sites so the
// gate and its tests cannot drift, and both accept the CJK-width colon — a zh
// vault writes `— 证据：<test>` and `— stories：PS-X/story-foo`, and a full-width
// colon must not read as the marker being absent.
export function evidenceSuffixRe() {
  return new RegExp(`[—–-]\\s*${keywordRe("evidence").source}\\s*[:：]`, "i");
}

export function storiesAttributionRe() {
  return new RegExp(`[—–-]\\s*${keywordRe("stories").source}\\s*[:：]\\s*(.+)$`, "i");
}

// The ids of an acceptance item's `— stories:` marker, or null (SPEC-001
// contract 6). Tokens are read from the text at the capture's start, never by
// splitting the capture, so text after the ids is not an id.
// One inline code span, for stripCodeSpans (lib.mjs) and storyIdsOf alike.
export const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;

const ID_LIST_RE = /[\s,，、]*([^\s,，、—–]+(?:\s*(?:[,，、]\s*)+[^\s,，、—–]+)*)/y;
const ID_SEPARATOR_RE = /\s*(?:[,，、]\s*)+/;

export function storyIdsOf(text) {
  const s = String(text);
  const spans = [...s.matchAll(INLINE_CODE_SPAN_RE)].map((m) => [m.index, m.index + m[0].length]);
  const inCode = (i) => spans.some(([a, b]) => i >= a && i < b);
  const base = storiesAttributionRe();
  const re = new RegExp(base.source, `${base.flags}gd`);
  let m;
  while ((m = re.exec(s))) {
    const glued = s[m.index] === "-" && m.index > 0 && !/\s/.test(s[m.index - 1]);
    if (!glued && !inCode(m.index)) break;
    re.lastIndex = m.index + 1;
  }
  if (!m) return null;
  ID_LIST_RE.lastIndex = m.indices[1][0];
  const list = ID_LIST_RE.exec(s);
  return list ? list[1].split(ID_SEPARATOR_RE) : null;
}

// A test cites a spec contract with `[<key>#<n>]` (the spec policy ADR,
// Decisions 4 and 8): <key> is the spec's id or alias, <n> the contract
// number in ASCII — `4'` for 4′, `4''` for 4″, `4/1''` for a step nested
// under contract 4. The closing bracket ends the token, so #4 never matches
// #4' or #40. The lookarounds drop a Markdown link `[x#1](…)` and a
// wikilink `[[x#1]]`. These tokens are machine tokens: English in every
// locale, never in the heading registry.
export const CITATION_EXAMPLE_KEY = "example";
export function citationTokenRe() {
  return /(?<!\[)\[([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+'*(?:\/\d+'*)?)\](?![(\]])/g;
}
// A loose ERE for git's side of the scan; citationTokenRe decides.
export const CITATION_PREFILTER = "\\[[A-Za-z0-9][A-Za-z0-9._-]*#[0-9]";
// A contract number as a spec writes it (`4′`, `1″`), in the token's ASCII.
export function contractNumberAscii(n) {
  return String(n).replace(/″/g, "''").replace(/′/g, "'");
}

// Amendment markers (the ADR "An active spec is amended by a marked block
// under the contract…", decisions 1 to 3; SPEC-001 contract 5). A marker is a
// blockquote in the Behavioral contracts section, after a top-level contract
// and before the next one, whose first paragraph (wrapped lines joined) reads
//   amended YYYY-MM-DD by <ref>: <KIND> — <why>
// `amended`, `by`, the kinds and the tombstone body are machine tokens:
// English in every locale. The colon is `:` or `：`, the separator `—`, `–` or
// `-`. A first paragraph that starts `amended <date> by` in any case is a
// candidate; one that is not the grammar is an `amendment-form` warn, and so
// is a marker before the first contract or after a REMOVED marker under the
// same contract. A ref whose epic part is the reserved example key is
// documentation and is skipped whole. Fences and HTML comments do not count.
export const AMENDMENT_KINDS = Object.freeze(["ADDED", "MODIFIED", "REMOVED"]);
export const TOMBSTONE_BODY = "Removed, see below.";
export const AMENDMENT_GRAMMAR = "amended YYYY-MM-DD by <ref>: ADDED|MODIFIED|REMOVED — <why>";
const AMENDMENT_CANDIDATE_RE = /^amended\s+\S+\s+by(?:\s|$)/i;
const AMENDMENT_REF_RE = /^amended\s+\S+\s+by\s+([^\s:：]+)/i;
const AMENDMENT_RE = /^amended (\d{4}-\d{2}-\d{2}) by ([^\s:：]+)\s*[:：]\s*(ADDED|MODIFIED|REMOVED)\s*[—–-]\s*(\S.*)$/;

// The `checked` marker (the spec staleness spec, contract 7): a contract was
// read against its code and needs no change. `checked` and `by` are English
// in every locale. It is valid under a contract (that contract) or directly
// under the section heading before the first contract (every contract), it
// changes no text and draws no edge, and a malformed one is `checked-form`.
const CHECKED_GRAMMAR = "checked YYYY-MM-DD by <ref>: <why>";
const CHECKED_CANDIDATE_RE = /^checked\s+\S+\s+by(?:\s|$)/i;
const CHECKED_REF_RE = /^checked\s+\S+\s+by\s+([^\s:：]+)/i;
const CHECKED_RE = /^checked (\d{4}-\d{2}-\d{2}) by ([^\s:：]+)\s*[:：]\s*(\S.*)$/;

// The amendment markers of one spec body, in file order. Each is
//   { contract: "<n>" | null, index: <contract's position> | -1, line,
//     date, ref, kind, why, form: null | "<what is wrong>", valid }
// where `line` is 1-based in the body, and `valid` means no form warn (a date
// or link finding does not make a marker invalid).
export function parseAmendmentMarkers(body) {
  return parseSpecMarkers(body)
    .filter((m) => m.marker === "amended")
    .map(({ marker, ...m }) => m); // eslint-disable-line no-unused-vars
}

// Both marker kinds of one spec body, in file order: the shape above plus
// `marker: "amended" | "checked"`, the candidate's word even when the rest is
// malformed. A valid `checked` marker has `kind: "checked"`.
export function parseSpecMarkers(body) {
  const text = String(body || "");
  const m = text.match(headingLineRe("spec_contracts"));
  if (!m) return [];
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^## /m);
  const sec = next === -1 ? rest : rest.slice(0, next);
  const lineBase = text.slice(0, start).split("\n").length; // 1-based line of sec's first line
  // Comments are blanked to their newlines, so line numbers survive.
  const lines = sec.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split("\n");
  const out = [];
  let index = -1;
  let contract = null;
  let fenced = false;
  let run = null;
  const flush = () => {
    if (!run) return;
    const quoted = run.lines.map((l) => l.replace(/^\s*>\s?/, ""));
    const firstPara = [];
    for (const q of quoted) {
      if (/^\s*$/.test(q)) break;
      firstPara.push(q.trim());
    }
    const para = firstPara.join(" ").trim();
    const at = run.line;
    run = null;
    if (CHECKED_CANDIDATE_RE.test(para)) {
      const refHit = para.match(CHECKED_REF_RE);
      if (refHit && refHit[1].split("/")[0] === CITATION_EXAMPLE_KEY) return;
      const g = para.match(CHECKED_RE);
      const entry = {
        contract,
        index,
        line: lineBase + at,
        date: g ? g[1] : null,
        ref: g ? g[2] : refHit ? refHit[1] : null,
        kind: g ? "checked" : null,
        why: g ? g[3].trim() : null,
        form: g ? null : `the first paragraph is not \`${CHECKED_GRAMMAR}\``,
        valid: Boolean(g),
        marker: "checked",
      };
      out.push(entry);
      return;
    }
    if (!AMENDMENT_CANDIDATE_RE.test(para)) return;
    const refHit = para.match(AMENDMENT_REF_RE);
    if (refHit && refHit[1].split("/")[0] === CITATION_EXAMPLE_KEY) return;
    const g = para.match(AMENDMENT_RE);
    const entry = {
      contract,
      index,
      line: lineBase + at,
      date: g ? g[1] : null,
      ref: g ? g[2] : refHit ? refHit[1] : null,
      kind: g ? g[3] : null,
      why: g ? g[4].trim() : null,
      form: null,
      valid: false,
      marker: "amended",
    };
    if (!g) entry.form = `the first paragraph is not \`${AMENDMENT_GRAMMAR}\``;
    else if (contract === null) entry.form = "it comes before the first contract";
    else if (out.some((x) => x.index === index && x.valid && x.kind === "REMOVED"))
      entry.form = `it follows a REMOVED marker under contract ${contract} (a restored rule is ADDED under a new number)`;
    entry.valid = entry.form === null;
    out.push(entry);
  };
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const top = line.match(/^(\d+[′″']*)\.(\s|$)/);
    if (top) {
      flush();
      index++;
      contract = contractNumberAscii(top[1]);
      return;
    }
    if (/^\s*>/.test(line)) {
      if (!run) run = { line: i, lines: [] };
      run.lines.push(line);
      return;
    }
    flush();
  });
  flush();
  return out;
}

// A date the calendar has (2026-02-30 is not one).
export function isCalendarDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// The body footer (`*Last updated: 2026-01-01*`) is content rather than a heading,
// but the lifecycle gates keep it in step with frontmatter `updated:`. Matching
// accepts every registered language; the rewrite preserves the file's OWN prefix
// verbatim through capture group 1, so a locale's punctuation convention — fr
// writes `… : `, zh writes `…：` — survives without the writer needing to know
// which locale it is looking at, and a hand-mixed vault keeps each file's form.
export function footerDateRe() {
  const forms = allForms("footers", "last_updated").map(escapeRe);
  return new RegExp(`^(\\*(?:${forms.join("|")})\\s*[:：]\\s*).*(\\*)$`, "mi");
}

// Matches a folder-README index header row in any registered language,
// in the standard 4-column form: | File | Title | Status | Date |
//
// End-anchored on purpose: a header carrying extra hand-added columns
// (`| File | Title | Status | Date | Notes |`) is NOT this table. Without the
// anchor it prefix-matched, and rebuildIndexRows then rewrote every managed
// row to the registered four columns — silently destroying the extra cells,
// which are human-owned content no regeneration can recompute. Unanchored,
// doctor's index-header check could not fire either (the header "matched"),
// so the loss had no detector at all. Anchored, both halves behave as
// documented: reconcile reports the index unusable and doctor warns.
export function indexHeaderRe() {
  const cols = ["file", "title", "status", "date"].map((c) => allForms("index_columns", c).map(escapeRe).join("|"));
  return new RegExp(
    `^\\|\\s*(?:${cols[0]})\\s*\\|\\s*(?:${cols[1]})\\s*\\|\\s*(?:${cols[2]})\\s*\\|\\s*(?:${cols[3]})\\s*\\|\\s*$`,
  );
}

#!/usr/bin/env node
// projectstore — epic-rule.mjs: an epic becomes done when its stories are
// done or set aside and its Expected Results are checked.
//
// The rule is a pure function of an epic's text and its stories' paths and
// statuses (epicRule): the epic's own status is neither done nor set aside,
// at least one story file is done, none is open, no row of its Stories table
// without a story file is open, and every checkbox under Expected Results is
// checked, in that order. It reads state, not events, so a run after a
// failure, or the first run on an old vault, moves every epic that is due.
// applyEpicRule is the one export the entry below and `follow` call: the
// sweep over every epic of an epics folder, writing each epic that passes
// through the read-again writer of status-change.mjs. It never runs
// reconcile: its caller does.
//
// Spec: "The epic rule: an epic is done when its stories are done or set
// aside and its Expected Results are checked" (alias `epic-rule`), contracts
// 1 to 6; SPEC-001 contracts 2 and 7 as amended 2026-11-11 by PS-FLOW/story-
// an-epic-becomes-done-when-all-its-stories-are-done-and-its-expected-
// results-are-checked. The close ceremony of commands/story.md runs:
//
//   node epic-rule.mjs <story-path> [--assume-done] [--write]
//
// Bare, it plans on the vault as it is; with --assume-done it plans as if
// that story were done; with --write it applies the rule. It prints one JSON
// object {write, assumed, checked, epics, moved, notes, error} and exits 0
// (notes included), 1 on an epic's error or a story path that names no file,
// 2 on a usage error. No hook and no MCP module imports this file.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter, sectionOf, checklistItems, stripCodeSpans, extractLinks, nowIso, isMain } from "./lib.mjs";
import { setFm, touchStory, setHeaderField, fieldForms, pipes, linksTo, storySlug } from "./status-log.mjs";
import { replaceWithRetry, epicFileOf } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { storyState } from "./stages.mjs";

export const RESULTS_OPEN = "epic-results-open";
export const ROWS_WITHOUT_FILE = "epic-rows-without-file";

const errMsg = (e) => (e && e.message ? e.message : String(e));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelRe = (id) => new RegExp(`^(?:${fieldForms(id).map(escapeRe).join("|")})$`, "i");
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── The readers (contracts 1 and 2) ───────────────────────────────────

// The Expected Results section's checkboxes, read after fenced blocks and
// inline code are stripped, a nested item counted as its own. No section, or
// none with a checkbox, has nothing to check.
export function expectedResults(epicText) {
  const section = sectionOf(epicText, "expected_results");
  if (section === null) return { found: false, total: 0, unchecked: 0 };
  const items = checklistItems(stripCodeSpans(section).split("\n"));
  return { found: true, total: items.length, unchecked: items.filter((i) => !i.checked).length };
}

// The first link's text in a row: a wikilink's alias, else its target; a
// markdown link's text, else its target. null when the row has no link.
const LINK = /\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)\s]+)\)/;
function linkText(line) {
  const m = stripCodeSpans(line).match(LINK);
  if (!m) return null;
  if (m[1] !== undefined) {
    const [target, alias] = m[1].split(/\\?\|/);
    return (alias ?? target).trim() || target.trim();
  }
  return m[2].trim() || m[3];
}

// Every row of every table under the epic's Stories heading whose header has
// a Status column (the registry's `status` label, any language), as {status,
// title, links}. A row's title is its first link's text, else its cell under
// the Story column, else its first cell. No heading, no table under it, or no
// table with a Status column: no rows.
export function storiesRows(epicText) {
  const section = sectionOf(epicText, "stories");
  if (section === null) return [];
  const statusLabel = labelRe("status");
  const storyLabel = labelRe("story");
  const rows = [];
  let fence = false;
  let inTable = false;
  let headerAt = -1;
  let statusCol = -1;
  let storyCol = -1;
  const lines = section.split("\n");
  const cell = (line, p, c) => (c >= 0 && p.length >= c + 2 ? line.slice(p[c] + 1, p[c + 1]).trim() : null);
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
      statusCol = -1;
      storyCol = -1;
      for (let c = 0; c + 1 < p.length; c++) {
        const name = l.slice(p[c] + 1, p[c + 1]).trim();
        if (statusCol === -1 && statusLabel.test(name)) statusCol = c;
        else if (storyCol === -1 && storyLabel.test(name)) storyCol = c;
      }
      continue;
    }
    if (statusCol === -1 || k === headerAt + 1 || p.length < 2) continue;
    rows.push({
      status: cell(l, p, statusCol) ?? "",
      title: linkText(l) || cell(l, p, storyCol) || cell(l, p, 0) || "",
      links: extractLinks(l),
    });
  }
  return rows;
}

// ─── The rule (contracts 1 to 3) ───────────────────────────────────────

// The rule as a function of state: the epic's text, its path (to resolve a
// row's link) and its story files as [{path, status}]. Returns {verdict,
// from, why, rows, total, unchecked}: verdict `done`, `rows-open`,
// `results-open`, or null for an epic that stays as it is unlisted (why:
// `epic-done`, `epic-set-aside`, `no-done-story`, `open-story`). Exported for
// its tests; the sweep below is the module's interface.
export function epicRule(epicText, { epicPath, stories = [] } = {}) {
  const fm = parseFrontmatter(epicText).data;
  const from = fm.status === null || fm.status === undefined ? null : String(fm.status).trim() || null;
  const out = { verdict: null, from, why: null, rows: [], total: 0, unchecked: 0, stories: stories.length };
  const own = storyState(fm.status);
  if (own !== "open") return { ...out, why: own === "done" ? "epic-done" : "epic-set-aside" };
  const states = stories.map((s) => storyState(s.status));
  if (!states.includes("done")) return { ...out, why: "no-done-story" };
  if (states.includes("open")) return { ...out, why: "open-story" };
  const epicDir = dirname(resolve(epicPath));
  const files = stories.map((s) => ({ epicDir, storyPath: s.path, slug: storySlug(s.path) }));
  const open = storiesRows(epicText).filter(
    (r) => !r.links.some((link) => files.some((f) => linksTo(link, f))) && storyState(r.status) === "open",
  );
  if (open.length) return { ...out, verdict: "rows-open", rows: open.map((r) => r.title) };
  const results = expectedResults(epicText);
  const counts = { total: results.total, unchecked: results.unchecked };
  if (results.unchecked) return { ...out, ...counts, verdict: "results-open" };
  return { ...out, ...counts, verdict: "done" };
}

// ─── The write (contract 4) ────────────────────────────────────────────

// An epic made done, as text: the frontmatter `status`, `updated` and the
// footer date (touchStory), and the header table's Status and Updated rows
// when the epic has them. Nothing else changes; a row the epic lacks is not
// added.
export function applyEpicDone(epicText, { day }) {
  // setFm's own message names a story; this writer's file is an epic.
  if (!/^---\n[\s\S]*?\n---/.test(epicText)) throw new Error("epic has no frontmatter block");
  let t = setFm(epicText, "status", "done");
  t = touchStory(t, day);
  t = setHeaderField(t, "status", "done").text;
  return setHeaderField(t, "updated", day).text;
}

// ─── The sweep (contracts 4 and 5) ─────────────────────────────────────

function itemOf(id, path, v, { error = null } = {}) {
  const from = v ? v.from : null;
  const was = from ?? "with no status";
  if (error) return { epic: id, path, from, to: null, verdict: "error", line: `${id}: not moved — ${error}`, error };
  if (v.verdict === "done") {
    const checked = v.total ? `, ${plural(v.total, "Expected Result", "Expected Results")} checked` : "";
    const line = `${id}: ${from ?? "none"} → done — ${plural(v.stories, "story", "stories")} done or set aside${checked}`;
    return { epic: id, path, from, to: "done", verdict: "done", line, error: null };
  }
  if (v.verdict === "results-open")
    return {
      epic: id,
      path,
      from,
      to: null,
      verdict: "results-open",
      line: `${id}: stays ${was} — ${v.unchecked} of ${v.total} Expected Results unchecked`,
      error: null,
    };
  return {
    epic: id,
    path,
    from,
    to: null,
    verdict: "rows-open",
    line: `${id}: stays ${was} — ${plural(v.rows.length, "open row", "open rows")} of its Stories table with no story file`,
    error: null,
  };
}

function noteOf(id, v) {
  const was = v.from ?? "with no status";
  if (v.verdict === "results-open")
    return {
      code: RESULTS_OPEN,
      epic: id,
      message: `${id} has ${v.unchecked} of ${v.total} Expected Results unchecked: it stays ${was} until they are checked.`,
      unchecked: v.unchecked,
      total: v.total,
    };
  return {
    code: ROWS_WITHOUT_FILE,
    epic: id,
    message: `${id} stays ${was}: its Stories table has ${plural(v.rows.length, "open row", "open rows")} with no story file (${v.rows.join("; ")}). Give each one a story file, or set its Status to done or to a set-aside status.`,
    rows: v.rows,
  };
}

// Every epic of the epics folder `epicsDir` (an epic is a folder holding
// epic.md, not one whose name starts with `_` or `.`), judged by the rule.
// `assume` is a story's absolute path, or a list of them, read as done, for a
// plan only (a list: `follow`'s plan of the stories it closes); with
// `write`, each epic that passes is written through replaceWithRetry, which
// reads it again before the replace and applies the rule again to the fresh
// bytes. A done or set-aside epic is judged no further; a story file that
// cannot be read is an error on its epic, which is left. One epic's failure
// does not change the others'. `onWrite(path, before, after)` runs once a
// replace landed (the session's write record). `read` (a story file's read)
// and `afterCompute(attempt, {epic, path})` are test seams. Returns {checked,
// epics, moved, notes, error}; `epics` lists the epics that move, are held
// by their results or rows, or failed.
export function applyEpicRule({
  epicsDir,
  write = false,
  assume = null,
  at = nowIso(),
  read = (p) => readFileSync(p, "utf8"),
  afterCompute = null,
  onWrite = null,
} = {}) {
  const assumed = new Set((Array.isArray(assume) ? assume : assume ? [assume] : []).map((p) => resolve(p)));
  if (write && assumed.size) throw new Error("a story assumed done is for a plan only: it is never written");
  const root = resolve(epicsDir);
  const vault = dirname(root);
  const epicsPath = basename(root);
  const day = String(at).slice(0, 10);
  const out = { checked: 0, epics: [], moved: [], notes: [], error: null };
  let names;
  try {
    names = readdirSync(root).sort();
  } catch (e) {
    return { ...out, error: `the epics folder cannot be read: ${errMsg(e)}` };
  }
  const record = (id, path, v) => {
    if (!v || v.verdict === null) return;
    out.epics.push(itemOf(id, path, v));
    if (v.verdict !== "done") out.notes.push(noteOf(id, v));
  };
  for (const name of names) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const path = join(root, name, "epic.md");
    if (!isFile(path)) continue;
    out.checked++;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      out.epics.push(itemOf(name, path, null, { error: errMsg(e) }));
      continue;
    }
    const fm = parseFrontmatter(text).data;
    const id = typeof fm.id === "string" && fm.id.trim() ? fm.id.trim() : name;
    if (storyState(fm.status) !== "open") continue;
    const { stories, unread } = readFlowStories(vault, epicsPath, { read, only: name });
    if (unread) {
      const error = `${plural(unread, "story file", "story files")} of this epic cannot be read`;
      out.epics.push(itemOf(id, path, epicRule(text, { epicPath: path }), { error }));
      continue;
    }
    const states = stories.map((s) => {
      const abs = join(vault, s.rel);
      return { path: abs, status: assumed.has(resolve(abs)) ? "done" : s.fm.status };
    });
    const v = epicRule(text, { epicPath: path, stories: states });
    if (v.verdict !== "done" || !write) {
      record(id, path, v);
      continue;
    }
    let fresh = v;
    const r = replaceWithRetry(
      path,
      (base) => {
        fresh = epicRule(base, { epicPath: path, stories: states });
        if (fresh.verdict !== "done") return { refused: fresh.verdict ?? fresh.why };
        return { content: applyEpicDone(base, { day }) };
      },
      { afterCompute: afterCompute ? (i) => afterCompute(i, { epic: id, path }) : null, onWrite },
    );
    if (r.error) out.epics.push(itemOf(id, path, fresh, { error: r.error }));
    else if (r.refused) record(id, path, fresh);
    else if (r.written) {
      out.epics.push(itemOf(id, path, fresh));
      out.moved.push(id);
    }
  }
  return out;
}

// ─── The entry (contract 6) ────────────────────────────────────────────

const USAGE = "usage: epic-rule.mjs <story-path> [--assume-done] [--write]";

// The entry as a function: {code, result}. `seams` passes applyEpicRule's
// `onWrite`, and its test seams (`read`, `afterCompute`, `at`), which the
// command line never passes.
export function runEpicRule(argv, seams = {}) {
  const positionals = [];
  const flags = new Set();
  let bad = null;
  for (const a of argv) {
    if (a === "--write" || a === "--assume-done") flags.add(a);
    else if (a.startsWith("-")) bad = bad ?? `unknown option ${a}`;
    else positionals.push(a);
  }
  const write = flags.has("--write");
  const assume = flags.has("--assume-done");
  const result = { write, assumed: null, checked: 0, epics: [], moved: [], notes: [], error: null };
  if (!bad && positionals.length !== 1) bad = positionals.length ? "one story path only" : "a story path is required";
  if (!bad && write && assume) bad = "--assume-done plans and writes nothing: it does not go with --write";
  if (bad) return { code: 2, result: { ...result, error: `${bad}; ${USAGE}` } };
  const story = resolve(positionals[0]);
  if (assume) result.assumed = story;
  if (!isFile(story)) return { code: 1, result: { ...result, error: `story not found: ${story}` } };
  const epicFile = epicFileOf(story);
  if (!isFile(epicFile))
    return { code: 1, result: { ...result, error: `the story's epic has no epic.md: ${epicFile}` } };
  const r = applyEpicRule({ ...seams, epicsDir: dirname(dirname(epicFile)), write, assume: assume ? story : null });
  const failed = Boolean(r.error) || r.epics.some((e) => e.verdict === "error");
  return { code: failed ? 1 : 0, result: { ...result, ...r } };
}

function main() {
  // The project is the one the command's own shell and the hook resolve alike,
  // as epic-row records it: the entry takes no --project (the record spec,
  // contract 5).
  const onWrite = nodeWriteRecorder({ env: process.env, project: null, tool: "epic-rule" });
  const { code, result } = runEpicRule(process.argv.slice(2), { onWrite });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (code === 2) process.stderr.write(`projectstore/epic-rule: ${result.error}\n`);
  process.exitCode = code;
}

if (isMain(import.meta.url)) {
  main();
}

// projectstore — doctor-report.mjs: doctor's text report, drawn from its
// findings (the presentation spec, *Terminal presentation of the projectstore
// CLI: layout, glyphs, colour roles, questions and live lines*, contract 11).
//
// A renderer, not a second doctor: it imports no check and is pure — it
// returns text and writes nothing. That is why doctor.mjs itself stays
// spawned, never imported (the MCP ADR's decision 2 table), while this module
// is imported by both readers of the findings: the bin, which renders the
// findings of its one `--json` spawn in its own process (so a terminal gets
// colour), and doctor.mjs's own text mode, through a dynamic import. The
// dynamic import keeps the SessionStart hook's static graph — which reaches
// doctor.mjs — as it was; this module imports only term.mjs and lib.mjs.
//
//   report(findings, groups, { caps, verbose, version, project, env }) → text
//   CHECKS                                                            → the check table
//
// The layout: a badge with the version and the project's folder name; per
// section (INSTALL, VAULT) a heading with its counts and a rule; issues, then
// warnings, then notes; the Summary line last, verbatim — the write ceremony
// reads it (commands/story.md step 5a, agents/clerk.md). That line is
// lib.mjs's doctorSummaryLine, so a caller's fallback ends with it too.
//
// Two readers, one layout:
//   - plain (a pipe, an agent's Bash tool) prints every finding, its message
//     whole on one line with its path, and every note. Agents read it, and the
//     vocabulary suite's about-filter cuts a finding out by its exact message;
//   - a terminal gets the same report compacted: a cause with many instances
//     lists each by its capture and path, at most eight, and the notes of the
//     folding rows fold into one line. `--verbose` turns the compaction off.
// Every entry keeps its `[check]` id: the `--fix` walk of commands/doctor.md
// keys on it.

import { PLAIN, painter, icon, badge, heading, rule, rowLines, wrap, commandBlock } from "./term.mjs";
import { commandForm, doctorSummaryLine } from "./lib.mjs";

// ─── The check table ─────────────────────────────────────────────────────
//
// One row per check id that is grouped, fixed or folded; a check with no row
// prints each finding as it is. A row is { instance, title, fix, folds }:
//   - instance: a pattern over the message, with zero or one capture. Two or
//     more findings of one check and one level that match it form one entry:
//     the title once, then each finding's capture and path. A finding that
//     does not match — and a finding about another harness (`about`), whose
//     exact message the vocabulary suite cuts out — prints on its own.
//   - fix: what to do, listed once under the check's entries at each level,
//     only for a check whose messages carry no command (contract 11): a
//     sentence, or { say, command } where the command is composed through
//     commandForm and stands on its own line (contract 6). Each is worded to
//     be true for every message its check can carry.
//   - folds: notes of this check fold on a terminal — true for all of them,
//     or a pattern for the ones it names. The offer checks (doctor.mjs's
//     OFFER_CHECKS: upgrade, layout-legacy) never fold, so they have no row.
const row = ({ instance = null, title = null, fix = null, folds = false }) => Object.freeze({ instance, title, fix, folds });

export const CHECKS = Object.freeze({
  // Fixes: the checks whose messages name no command.
  "code-refs": row({
    instance: /^code_refs path "([^"]+)" does not resolve/,
    title: "code_refs path does not resolve inside the project",
    fix: "make each code_refs path exist in the project, and keep a story's paths inside its epic's",
  }),
  "wikilink": row({
    instance: /^Dead wiki-link \[\[(.+)\]\]\.$/,
    title: "Dead wiki-link",
    fix: "make each [[link]] name exactly one existing artifact (correct the name, or qualify it with its folder); if the check was skipped, fix the error it names",
  }),
  "rel-link": row({
    instance: /^Dead relative link \((.+)\)\.$/,
    title: "Dead relative link",
    fix: "point each relative link at a file that exists, or remove it",
  }),
  "acceptance": row({ fix: "tick the criteria the work met, or move the story out of done" }),
  "review-status": row({ fix: "set reviewed_at to the review's date, or clear review_status" }),
  "epic-status": row({ fix: "close the open stories, or move the epic out of done" }),
  "spec-links": row({ fix: "make each spec's stories and each story's specs name existing artifacts that list each other back, written inline as specs: [\"id\"]" }),
  "index": row({
    instance: / is not listed in .+\/README\.md's index\.$/,
    title: "Artifact is not listed in its folder's README index",
    fix: { say: "rebuild the folder indexes from frontmatter", command: (env) => commandForm("reconcile", { env }) },
  }),
  "index-header": row({ fix: "rewrite the index header in a registered form, so reconcile can rebuild the index" }),
  // Notes that fold on a terminal while their section has something to fix.
  "surface": row({ folds: /— current, last written by / }),
  "mcp": row({ folds: true }),
  "statusline": row({ folds: /^Base HUD present/ }),
  "harness": row({ folds: true }),
  "plugin-registration": row({ folds: / registered from the npm package / }),
  "spec-policy": row({ folds: true }),
  "identity": row({ folds: true }),
  "artifact-name": row({ folds: true }),
});

// The instance list on a terminal: at most this many, then `+N more`.
export const INSTANCE_CAP = 8;

const NONE = row({});
const LEVELS = Object.freeze([
  // [level, glyph name, role, count word]
  ["issue", "issue", "error", "issue"],
  ["warn", "warning", "attention", "warning"],
  // A note is not a warning: its own glyph, so the two differ without colour.
  ["info", "info", "explanation", "note"],
]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Joins the dash to the path after it, so wrapping never leaves a bare dash
// at a line's end with the path alone below; a space again once wrapped.
const GLUE = "";

const folderName = (p) => (p ? String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null : null);
const folds = (r, f) => f.level === "info" && Boolean(r.folds) && (r.folds === true || r.folds.test(f.message));
const capture = (r, f) => { const m = r.instance.exec(f.message); return m && m[1] !== undefined ? m[1] : null; };

export function report(findings, groups, { caps: c = PLAIN, verbose = false, version = null, project = null, env = process.env } = {}) {
  const paint = painter(c);
  // The terminal's compaction (contract 11, "on a TTY only"): the cap, the
  // folds and the short instance lines. Plain output prints everything, and
  // --verbose asks a terminal for the same.
  const compact = c.live && !verbose;
  const width = c.live ? c.width : 0;
  const dash = icon(c, "dash");
  // Prose at an indent: wrapped on a live terminal, every line after the
  // first indented two further; one line anywhere else.
  const prose = (n, text) => {
    const pad = " ".repeat(n);
    return wrap(text, width, pad + "  ").split("\n").map((l, k) => (k ? l : pad + l).split(GLUE).join(" "));
  };
  const withPath = (text, f) => (f.file ? `${text} ${paint("explanation", dash)}${GLUE}${paint("explanation", f.file)}` : text);

  function entries(level, check, r, these) {
    const [, glyph, role] = LEVELS.find(([l]) => l === level);
    const lead = `${paint(role, icon(c, glyph))} [${check}]`;
    const matched = r.instance ? these.filter((f) => !f.about && r.instance.test(f.message)) : [];
    const grouped = matched.length >= 2 ? matched : [];
    const out = [];
    for (const f of these) {
      if (!grouped.includes(f)) { out.push(...prose(2, withPath(`${lead} ${f.message}`, f))); continue; }
      if (f !== grouped[0]) continue;
      out.push(...prose(2, `${lead} ${paint("emphasis", r.title)} (${grouped.length})`));
      if (!compact) { for (const g of grouped) out.push(...prose(6, withPath(g.message, g))); continue; }
      // Each instance a row with its own glyph: its capture, then its path.
      // A path moved beneath its capture (contract 5) reads `— <path>`, as
      // plain's `message — file` does, so neither colour nor the indent is
      // all that tells it from the next capture.
      const shown = grouped.slice(0, INSTANCE_CAP);
      const laid = rowLines(c, shown.map((g) => { const cap = capture(r, g); return { glyph: "dot", role: "explanation", ...(cap === null ? { target: g.file || g.message } : { target: cap, note: g.file || "" }) }; }), { indent: 6 });
      for (const [first, ...moved] of laid) out.push(first, ...moved.map((l, k) => (k ? l : l.replace(/^ */, (pad) => `${pad}${paint("explanation", dash)} `))));
      if (grouped.length > shown.length) out.push(`      ${paint("explanation", `+${grouped.length - shown.length} more`)}`);
    }
    if (r.fix) {
      const fix = typeof r.fix === "string" ? { say: r.fix, command: null } : r.fix;
      out.push(...prose(4, `${paint("action", "fix:")} ${fix.say}${fix.command ? ":" : "."}`));
      if (fix.command) out.push(...commandBlock(c, [fix.command(env)], { indent: 6 }), "");
    }
    return out;
  }

  function section(group) {
    const fs = findings.filter((f) => f.group === group);
    const n = Object.fromEntries(LEVELS.map(([l]) => [l, fs.filter((f) => f.level === l).length]));
    // Each count in its role; a zero issue or warning count is the done role.
    const counts = LEVELS.map(([l, , role, word]) => [plural(n[l], word), l === "info" ? role : n[l] ? role : "done"]);
    const out = [heading(c, group.toUpperCase(), counts), rule(c)];
    if (!fs.length) return [...out, `  ${paint("done", icon(c, "ok"))} clean`];
    // A note folds only while its section has something to fix.
    const folding = compact && n.issue + n.warn > 0;
    let hidden = 0;
    for (const [level] of LEVELS) {
      const atLevel = fs.filter((f) => f.level === level);
      for (const check of [...new Set(atLevel.map((f) => f.check))]) {
        const r = Object.hasOwn(CHECKS, check) ? CHECKS[check] : NONE;
        let these = atLevel.filter((f) => f.check === check);
        if (folding) { const kept = these.filter((f) => !folds(r, f)); hidden += these.length - kept.length; these = kept; }
        if (these.length) out.push(...entries(level, check, r, these));
      }
    }
    if (hidden) out.push(`  ${paint("explanation", `${plural(hidden, "note")} hidden ${icon(c, "dot")} --verbose shows them`)}`);
    while (out.at(-1) === "") out.pop();
    return out;
  }

  const lines = [badge(c, "projectstore doctor", [version, folderName(project)])];
  for (const g of groups) lines.push("", ...section(g));
  lines.push("", doctorSummaryLine(findings, { env }));
  return lines.join("\n") + "\n";
}

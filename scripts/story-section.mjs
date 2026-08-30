#!/usr/bin/env node
// projectstore — story-section.mjs (PS-SPEC story-007)
// Computes the story lifecycle-gate mutations for /projectstore:story.
// --check <baseline> adds a deterministic drift verdict (volatile fields
// excluded) to the JSON as `check: {baseline, match, drift}` — exit 0 either
// way; drift is a computed fact, not a failure.
// plan|close. Pure compute, models reconcile.mjs rebuildIndex: reads the
// original, splices the managed pieces, returns {path, changed, content,
// notes} on stdout — the COMMAND writes after approval, never this script.
//
//   node story-section.mjs plan  <story-path>
//   node story-section.mjs close <story-path>
//
// plan  — ensures a `## Implementation Plan` section exists (inserted with a
//         placeholder; the agent fills it in the preview before approval),
//         status → in-progress (never downgrades review/done), stamps
//         started_at (once) and plan_updated_at (every run), bumps updated.
// close — ensures a `## Final Summary` section exists, status → done,
//         stamps closed_at (once), bumps updated.
//
// Timestamps are full ISO-8601 UTC (lib.mjs nowIso) — they anchor the legacy
// predicate (closed_at vs spec_policy_since) and diff-refs' git --since.
// Timestamps are written UNCONDITIONALLY of lifecycle_gates: the gates key
// controls checks and prompts, never the data that other predicates need.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfig,
  parseFrontmatter,
  headingLineRe,
  heading,
  footerDateRe,
  nowIso,
  today,
} from "./lib.mjs";

function die(msg) {
  process.stderr.write(`projectstore/story-section: ${msg}\n`);
  process.exit(1);
}

// Replace `key: ...` inside the frontmatter block, or insert the line before
// the closing --- when the key is absent. Returns the whole file text.
function setFm(text, key, value) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) die("story has no frontmatter block");
  const fmLines = m[1].split("\n");
  const idx = fmLines.findIndex((l) => l.startsWith(`${key}:`));
  const line = `${key}: ${value}`;
  if (idx >= 0) fmLines[idx] = line;
  else fmLines.push(line);
  return text.slice(0, m.index) + `---\n${fmLines.join("\n")}\n---` + text.slice(m.index + m[0].length);
}

// End index of section `id` (position right before the next `## ` heading
// after it), or null when the section is absent.
function sectionEnd(text, id) {
  const m = text.match(headingLineRe(id));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? text.length : m.index + m[0].length + next;
}

function insertSection(text, id, lang, placeholder, anchors) {
  if (headingLineRe(id).test(text)) return { text, inserted: false };
  const block = `## ${heading(id, lang)}\n\n${placeholder}\n\n`;
  for (const anchor of anchors) {
    const end = sectionEnd(text, anchor);
    if (end !== null) {
      return { text: text.slice(0, end) + block + text.slice(end), inserted: true };
    }
  }
  // Fallback: before the trailing `---` footer, else EOF.
  const footer = text.lastIndexOf("\n---\n");
  const at = footer > 0 ? footer + 1 : text.length;
  return { text: text.slice(0, at) + block + text.slice(at), inserted: true };
}

// The volatile frontmatter fields — the ones a re-run stamps fresh even when
// nothing else changed. --check must ignore exactly these, or a comparison
// against a moments-old baseline reports drift on every single run. started_at
// belongs here by the same mechanism as the rest: a `plan` re-run against a
// still-null field stamps a fresh nowIso() each time.
export const VOLATILE_FM = ["updated", "started_at", "closed_at", "plan_updated_at"];

// Both sides of a --check comparison, with the volatile fields and the footer
// date neutralised. setFm INSERTS an absent key at the END of the frontmatter,
// which is what makes a null closed_at compare equal to a fresh stamp. A
// hand-DELETED mid-frontmatter volatile key therefore reads as DRIFT (the
// insert lands at a different position) — erring safe. The masking that IS
// accepted: a hand-REWRITTEN volatile value (e.g. a bogus closed_at on a done
// story) compares equal, and closed_at anchors the legacy predicate and
// diff-refs --since — --check cannot guard those two consumers.
function checkNormalize(text) {
  let t = text;
  for (const k of VOLATILE_FM) t = setFm(t, k, '"«volatile»"');
  return t.replace(footerDateRe(), (_m, prefix, suffix) => `${prefix}«volatile»${suffix}`);
}

function main() {
  const argv = process.argv.slice(2);
  let checkPath = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") checkPath = argv[++i];
    else if (a.startsWith("--check=")) checkPath = a.slice("--check=".length);
    else positional.push(a);
  }
  if (checkPath === undefined || checkPath === "") die("--check requires a value");
  const [mode, storyPath] = positional;
  if (!["plan", "close"].includes(mode) || !storyPath) {
    die("usage: story-section.mjs <plan|close> <story-path> [--check <baseline-file>]");
  }
  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind first.");
  const lang = cfg.language || "en";
  const abs = resolve(storyPath);
  if (!existsSync(abs)) die(`story not found: ${abs}`);

  const original = readFileSync(abs, "utf8");
  const fm = parseFrontmatter(original).data;
  if (fm.type && fm.type !== "story") die(`not a story (type: ${fm.type})`);

  let text = original;
  const notes = [];
  const now = nowIso();
  const status = String(fm.status || "").toLowerCase();

  if (mode === "plan") {
    const r = insertSection(text, "implementation_plan", lang,
      "<!-- Route through the covering spec's contracts: which contracts, in what order, which files. Filled at the gate. -->",
      ["decomposition", "description"]);
    text = r.text;
    if (r.inserted) notes.push("inserted Implementation Plan section");
    if (!["in-progress", "in_progress", "review", "done"].includes(status)) {
      text = setFm(text, "status", "in-progress");
      notes.push(`status: ${fm.status || "planned"} → in-progress`);
    }
    if (!fm.started_at || fm.started_at === "null") {
      text = setFm(text, "started_at", JSON.stringify(now));
      notes.push("stamped started_at");
    }
    text = setFm(text, "plan_updated_at", JSON.stringify(now));
    notes.push("stamped plan_updated_at");
  } else {
    const r = insertSection(text, "final_summary", lang,
      "<!-- What changed, why, tests executed, risks and follow-ups. Filled at the gate. -->",
      ["acceptance", "decomposition", "description"]);
    text = r.text;
    if (r.inserted) notes.push("inserted Final Summary section");
    if (status !== "done") {
      text = setFm(text, "status", "done");
      notes.push(`status: ${fm.status || "?"} → done`);
    }
    if (!fm.closed_at || fm.closed_at === "null") {
      text = setFm(text, "closed_at", JSON.stringify(now));
      notes.push("stamped closed_at");
    }
  }
  text = setFm(text, "updated", today());
  // Keep the body footer in step with frontmatter `updated:`. Registry-driven, so
  // every bundled language is covered; the file's own label and punctuation are
  // preserved and only the date is rewritten.
  text = text.replace(footerDateRe(), (_m, prefix, suffix) => `${prefix}${today()}${suffix}`);

  let check = null;
  if (checkPath !== null) {
    if (!existsSync(resolve(checkPath))) die(`--check baseline not found: ${checkPath}`);
    const baseline = readFileSync(resolve(checkPath), "utf8").replace(/\r\n/g, "\n");
    if (!/^---\n[\s\S]*?\n---/.test(baseline)) die(`--check baseline has no frontmatter block: ${checkPath}`);
    const a = checkNormalize(text.replace(/\r\n/g, "\n"));
    const b = checkNormalize(baseline);
    const drift = [];
    if (a !== b) {
      // Trim the common prefix and suffix first: a single inserted line
      // otherwise shifts every later pairing and the report drowns in
      // artifacts of the shift instead of naming the change. Line numbers are
      // post-normalization (volatile keys may have been inserted).
      const al = a.split("\n"), bl = b.split("\n");
      let lo = 0;
      while (lo < al.length && lo < bl.length && al[lo] === bl[lo]) lo++;
      let hiA = al.length - 1, hiB = bl.length - 1;
      while (hiA > lo && hiB > lo && al[hiA] === bl[hiB]) { hiA--; hiB--; }
      for (let i = 0; i <= Math.max(hiA, hiB) - lo && drift.length < 5; i++) {
        const x = al[lo + i], y = bl[lo + i];
        if (lo + i > hiA && lo + i > hiB) break;
        drift.push(`normalized line ${lo + i + 1}: ${JSON.stringify((x ?? "«absent»").slice(0, 120))} vs ${JSON.stringify((y ?? "«absent»").slice(0, 120))}`);
      }
    }
    check = { baseline: resolve(checkPath), match: a === b, drift };
  }

  process.stdout.write(JSON.stringify({
    path: abs,
    mode,
    changed: text !== original,
    check,
    notes,
    content: text,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

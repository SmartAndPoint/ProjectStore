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
//   node story-section.mjs plan  <story-path> [--reason "<why>"] [--actor <actor>]
//   node story-section.mjs close <story-path> [--reason "<why>"] [--actor <actor>]
//
// plan  — ensures a `## Implementation Plan` section exists (inserted with a
//         placeholder; the agent fills it in the preview before approval),
//         status → in-progress (never downgrades review/done), stamps
//         started_at (once) and plan_updated_at (every run), bumps updated.
// close — ensures a `## Final Summary` section exists, status → done,
//         stamps closed_at (once), bumps updated.
//
// A change of status, at either gate, goes through status-log.mjs's
// applyStatusChange: `status_changed_at`, the header's Status row and one
// Status log line (SPEC-001 contracts 3 and 7, as amended 2026-11-10). On the
// transition to in-progress only, the plan gate also sets the assignee to the
// binding's default_author when that is set and differs. --reason and
// --actor name every line one run appends; the defaults are `work started`
// and `plan gate` for plan, `closed` and `close gate` for close. A run that
// changes no status appends nothing and keeps the stamp. The command writes;
// it also updates the epic's Stories row (status-change.mjs epic-row).
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
  readVaultConfig,
  parseFrontmatter,
  footerDateRe,
  nowIso,
  today,
  commandForm,
  listOf,
} from "./lib.mjs";
import {
  setFm,
  insertSection,
  touchStory,
  applyStatusChange,
  applyAssigneeChange,
  maskStatusLog,
  oneLine,
  checkActor,
  sameStatus,
} from "./status-log.mjs";

function die(msg) {
  process.stderr.write(`projectstore/story-section: ${msg}\n`);
  process.exit(1);
}

// The volatile frontmatter fields — the ones a re-run stamps fresh even when
// nothing else changed. --check must ignore exactly these, or a comparison
// against a moments-old baseline reports drift on every single run. started_at
// belongs here by the same mechanism as the rest: a `plan` re-run against a
// still-null field stamps a fresh nowIso() each time.
// status_changed_at joins them for the same reason, and the timestamps of
// Status log lines are masked too (status-log.mjs maskStatusLog): only the
// timestamp, so a reason or a hand-written line is still drift.
export const VOLATILE_FM = ["updated", "started_at", "closed_at", "plan_updated_at", "status_changed_at"];

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
  t = maskStatusLog(t);
  return t.replace(footerDateRe(), (_m, prefix, suffix) => `${prefix}«volatile»${suffix}`);
}

function main() {
  try {
    gate();
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
}

const GATE_DEFAULTS = {
  plan: { reason: "work started", actor: "plan gate" },
  close: { reason: "closed", actor: "close gate" },
};

function gate() {
  const argv = process.argv.slice(2);
  let checkPath = null;
  let noSpec = null;
  let reason = null;
  let actor = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") checkPath = argv[++i];
    else if (a.startsWith("--check=")) checkPath = a.slice("--check=".length);
    else if (a === "--no-spec") noSpec = argv[++i] ?? "";
    else if (a.startsWith("--no-spec=")) noSpec = a.slice("--no-spec=".length);
    else if (a === "--reason") reason = argv[++i] ?? "";
    else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length);
    else if (a === "--actor") actor = argv[++i] ?? "";
    else if (a.startsWith("--actor=")) actor = a.slice("--actor=".length);
    else positional.push(a);
  }
  if (checkPath === undefined || checkPath === "") die("--check requires a value");
  const [mode, storyPath] = positional;
  if (!["plan", "close"].includes(mode) || !storyPath) {
    die(
      'usage: story-section.mjs <plan|close> <story-path> [--check <baseline-file>] [--no-spec "<reason>"] [--reason "<why>"] [--actor <actor>]',
    );
  }
  // One reason and one actor serve every line this run appends (contract 7).
  const why = reason === null ? GATE_DEFAULTS[mode].reason : oneLine(reason, "--reason");
  const who = actor === null ? GATE_DEFAULTS[mode].actor : checkActor(actor);
  // The declared opt-out from a spec is written at the plan gate only (the
  // spec policy ADR, Decision 14), with a reason, on a story with no specs.
  if (noSpec !== null) {
    if (mode !== "plan") die("--no-spec is written at the plan gate, not at close");
    if (!noSpec.trim()) die("--no-spec needs a reason: why does this story need no spec?");
  }
  const cfg = readConfig();
  if (!cfg) die(`No projectstore config. Run ${commandForm("bind")} first.`);
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
    const r = insertSection(
      text,
      "implementation_plan",
      lang,
      "<!-- Route through the covering spec's contracts: which contracts, in what order, which files. Filled at the gate. -->",
      ["decomposition", "description"],
    );
    text = r.text;
    if (r.inserted) notes.push("inserted Implementation Plan section");
    // Never downgrades: a story already in progress, in review or done (by
    // status equality: in_progress, closed) keeps its status and its stamp.
    if (!["in-progress", "review", "done"].some((s) => sameStatus(status, s))) {
      const c = applyStatusChange(text, { to: "in-progress", reason: why, actor: who, at: now, lang });
      text = c.text;
      notes.push(
        `status: ${fm.status || "planned"} → in-progress`,
        "stamped status_changed_at",
        "appended status log line",
      );
      // The person who starts the work is its assignee: the binding's
      // default_author, compared exactly on the trimmed value. With none, the
      // assignee stays.
      const author = String(cfg.default_author ?? "").trim();
      if (author && author !== String(fm.assignee ?? "").trim()) {
        const a = applyAssigneeChange(text, { to: author, reason: why, actor: who, at: now, lang });
        text = a.text;
        if (a.changed) {
          notes.push(`assignee: ${a.from || "none"} → ${author}`, "appended assignee log line");
          const people = readVaultConfig(cfg.vault_path)?.flow?.people;
          if (people && typeof people === "object" && !Object.hasOwn(people, author))
            notes.push(`${author} is not in the vault's flow.people, so the person has no WIP limit`);
        }
      }
    }
    if (!fm.started_at || fm.started_at === "null") {
      text = setFm(text, "started_at", JSON.stringify(now));
      notes.push("stamped started_at");
    }
    text = setFm(text, "plan_updated_at", JSON.stringify(now));
    notes.push("stamped plan_updated_at");
    if (noSpec !== null) {
      if (listOf(fm, "specs").length) die("the story lists specs — --no-spec is for a story with none");
      text = setFm(text, "no_spec", JSON.stringify(noSpec.trim()));
      notes.push("declared no_spec");
    }
  } else {
    const r = insertSection(
      text,
      "final_summary",
      lang,
      "<!-- What changed, why, tests executed, risks and follow-ups. Filled at the gate. -->",
      ["acceptance", "decomposition", "description"],
    );
    text = r.text;
    if (r.inserted) notes.push("inserted Final Summary section");
    if (!sameStatus(status, "done")) {
      const c = applyStatusChange(text, { to: "done", reason: why, actor: who, at: now, lang });
      text = c.text;
      notes.push(`status: ${fm.status || "?"} → done`, "stamped status_changed_at", "appended status log line");
    }
    if (!fm.closed_at || fm.closed_at === "null") {
      text = setFm(text, "closed_at", JSON.stringify(now));
      notes.push("stamped closed_at");
    }
  }
  // Keep the body footer in step with frontmatter `updated:`. Registry-driven, so
  // every bundled language is covered; the file's own label and punctuation are
  // preserved and only the date is rewritten.
  text = touchStory(text, today());

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
      const al = a.split("\n"),
        bl = b.split("\n");
      let lo = 0;
      while (lo < al.length && lo < bl.length && al[lo] === bl[lo]) lo++;
      let hiA = al.length - 1,
        hiB = bl.length - 1;
      while (hiA > lo && hiB > lo && al[hiA] === bl[hiB]) {
        hiA--;
        hiB--;
      }
      for (let i = 0; i <= Math.max(hiA, hiB) - lo && drift.length < 5; i++) {
        const x = al[lo + i],
          y = bl[lo + i];
        if (lo + i > hiA && lo + i > hiB) break;
        drift.push(
          `normalized line ${lo + i + 1}: ${JSON.stringify((x ?? "«absent»").slice(0, 120))} vs ${JSON.stringify((y ?? "«absent»").slice(0, 120))}`,
        );
      }
    }
    check = { baseline: resolve(checkPath), match: a === b, drift };
  }

  process.stdout.write(
    JSON.stringify(
      {
        path: abs,
        mode,
        changed: text !== original,
        check,
        notes,
        content: text,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

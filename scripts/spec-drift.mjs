#!/usr/bin/env node
// projectstore — spec-drift.mjs (PS-SPEC: "The reviewer can run against an
// active spec and its code_refs and report where the code drifted from the
// contracts"; SPEC-001 contract 10, the Spec drift bullet).
//
//   node spec-drift.mjs <spec id|alias|stem> [--since <date>] [--project <dir>]
//
// The fact bundle the reviewer's spec-drift mode reads. Pure and read-only:
// it prints stable JSON (no generated_at, sorted lists) and writes nothing.
// It judges nothing either: the verdicts are the reviewer's.
//
// - contracts: number, heading, removed state, scenarios, marks, the valid
//   and invalid markers with the status of each marker's story, the anchor
//   (the date of the contract's last valid marker, else the spec's `date:`;
//   `--since` overrides every anchor), and the tests citing it;
// - stories: the spec's `stories:`, each with its status and `code_refs`,
//   empty and missing refs listed;
// - files: the refs expanded (directories, a trailing `/`, globs `*` `**` `?`),
//   SOURCE_IGNORE dropped, classed tests / surface / source, with line counts
//   and the commits since each anchor of a contract that is not removed (a
//   count and the last three);
// - scan: `ok`, `no-git` or `unknown`. A null is "unknown", never "none":
//   with no git, history and citations are null, not empty.
//
// Git runs in the PROJECT through diff-refs.mjs's seams (gitIn,
// grepProjectLines), which tests replace; this module spawns nothing itself.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, relative, basename, resolve } from "node:path";
import {
  readConfigAt,
  loadLayout,
  folderByKind,
  listOf,
  sectionOf,
  linesOutsideFences,
  parseAmendmentMarkers,
  isTestPath,
  SOURCE_IGNORE,
  CITATION_EXAMPLE_KEY,
  isMain,
  commandForm,
  projectRoot,
} from "./lib.mjs";
import { gitIn, grepProjectLines, sinceWindow } from "./diff-refs.mjs";
import { globRe, globCovers, isGlobRef, normalRef } from "./code-refs.mjs";
import { scanArtifacts, parseSpecContracts, resolveSpecStory, citationKeys, scanCitations } from "./doctor.mjs";

function die(msg) {
  process.stderr.write(`projectstore/spec-drift: ${msg}\n`);
  process.exit(1);
}

// ─── Which spec ────────────────────────────────────────────────────────

const stemOf = (s) => basename(s.rel).replace(/\.md$/, "");
const realValue = (v) => (v && v !== "null" ? String(v) : null);

function describe(s) {
  return {
    id: realValue(s.fm.id),
    alias: realValue(s.fm.alias),
    rel: s.rel,
    status: String(s.fm.status || "draft"),
  };
}

// By exact id or alias (the citation keys), or exact filename stem; then the
// same, case-insensitive. Two specs that answer to one query are ambiguous
// whichever way each answers: the caller names it better, nothing is picked.
export function resolveSpec(artifacts, query) {
  const q = String(query || "");
  const specs = artifacts.filter((a) => a.kind === "spec");
  const keys = citationKeys(artifacts);
  const exact = new Set();
  if (keys.has(q)) exact.add(keys.get(q));
  for (const s of specs) if (stemOf(s) === q) exact.add(s);
  let hits = [...exact];
  if (!hits.length) {
    const lc = q.toLowerCase();
    hits = specs.filter((s) =>
      [realValue(s.fm.id), realValue(s.fm.alias), stemOf(s)].some((v) => v && v.toLowerCase() === lc),
    );
  }
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  if (hits.length === 1) return { spec: hits[0] };
  if (hits.length > 1) return { error: "ambiguous", candidates: hits.sort(byRel).map(describe) };
  const lc = q.toLowerCase();
  const near = specs.filter((s) =>
    [realValue(s.fm.id), realValue(s.fm.alias), stemOf(s), realValue(s.fm.title)].some(
      (v) => lc && v && v.toLowerCase().includes(lc),
    ),
  );
  return { error: "unknown", candidates: (near.length ? near : specs).sort(byRel).map(describe) };
}

// ─── Files ─────────────────────────────────────────────────────────────

// The covering rule lives in code-refs.mjs, shared with doctor's flow group;
// globRe stays exported from here for this module's callers and tests.
export { globRe };

const ignored = (rel) => SOURCE_IGNORE.some((rx) => rx.test(rel));

// Every file under `dir` (project-relative), sorted; `.git`, symbolic links,
// SOURCE_IGNORE paths and the vault (when it sits inside the project) skipped.
function walk(proj, dir, skipRel) {
  const out = [];
  const visit = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(proj, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || ignored(`${r}/`) || (skipRel && (r === skipRel || r.startsWith(`${skipRel}/`))))
          continue;
        visit(r);
      } else if (e.isFile() && !ignored(r)) out.push(r);
    }
  };
  visit(dir);
  return out.sort();
}

// A ref expanded to files, or null when it names nothing (a missing path, a
// glob that matches no file).
function expandRef(proj, ref, allFiles, skipRel) {
  const r = normalRef(ref);
  if (isGlobRef(r)) {
    const hits = allFiles().filter((f) => globCovers(r, f));
    return hits.length ? hits : null;
  }
  const bare = r.replace(/\/+$/, "");
  let st;
  try {
    st = statSync(join(proj, bare));
  } catch {
    return null;
  }
  if (st.isDirectory()) return walk(proj, bare, skipRel);
  if (r.endsWith("/")) return null;
  return ignored(bare) ? [] : [bare];
}

// The classes only split the input size (contract 10): tests by the test-path
// rule; surface for docs, the README, manifests and generated copies; source
// otherwise.
const SURFACE = [
  /(^|\/)docs?\//,
  /(^|\/)(README|CHANGELOG|CHANGES|LICENSE)(\.[^/]*)?$/i,
  /(^|\/)(package|plugin|marketplace|packlist)\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.[^/]+-plugin\//,
  /^adapters\//,
  /^packaging\/shells\//,
];
export function classOf(rel) {
  if (isTestPath(rel)) return "tests";
  if (SURFACE.some((rx) => rx.test(rel))) return "surface";
  return "source";
}

// Lines in a text file; null for a binary or unreadable one.
function lineCount(abs) {
  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  const text = buf.toString("utf8");
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// ─── History ───────────────────────────────────────────────────────────

const SEP_RECORD = "\x1e";
const SEP_FIELD = "\x1f";

// anchor → (file → commits, newest first), or anchor → null when git could
// not answer. One `git log` per anchor and per chunk of paths.
function historyByAnchor(proj, files, anchors, git) {
  const out = new Map();
  for (const anchor of anchors) {
    const per = new Map();
    let failed = false;
    for (let i = 0; i < files.length && !failed; i += 400) {
      const chunk = files.slice(i, i + 400);
      const log = git(proj, [
        "-c",
        "core.quotePath=false",
        "log",
        `--since=${sinceWindow(anchor)}`,
        "--relative",
        "--name-only",
        "--format=%x1e%H%x1f%cI%x1f%s",
        "--",
        ...chunk,
      ]);
      if (log === null || log === undefined) {
        failed = true;
        break;
      }
      for (const rec of String(log).split(SEP_RECORD)) {
        if (!rec.trim()) continue;
        const [head, ...names] = rec.split("\n");
        const [sha = "", date = "", subject = ""] = head.split(SEP_FIELD);
        const commit = { commit: sha.slice(0, 12), date, subject };
        for (const n of names) {
          const f = n.trim();
          if (!f) continue;
          if (!per.has(f)) per.set(f, []);
          if (!per.get(f).some((c) => c.commit === commit.commit)) per.get(f).push(commit);
        }
      }
    }
    out.set(anchor, failed ? null : per);
  }
  return out;
}

// ─── The bundle ────────────────────────────────────────────────────────

// Each contract's heading, in the order parseSpecContracts reads them (the
// same section, comments stripped, fences skipped, the same top-level form).
function contractHeadings(spec) {
  const sec = sectionOf(spec.body || "", "spec_contracts");
  if (sec === null) return [];
  const out = [];
  for (const line of linesOutsideFences(sec.replace(/<!--[\s\S]*?-->/g, ""))) {
    const m = line.match(/^(\d+[′″']*)\.(?:\s|$)(.*)$/);
    if (!m) continue;
    // A bold heading that wraps is cut at its first sentence on this line.
    const bold = m[2].match(/^\*\*(.+?)\*\*/);
    const text = bold ? bold[1] : m[2].replace(/^\*\*/, "").split(/(?<=\.)\s/)[0];
    out.push(text.trim().replace(/\.$/, "").slice(0, 120));
  }
  return out;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function vaultInside(proj, vault) {
  try {
    const rel = relative(realpathSync.native(proj), realpathSync.native(vault));
    return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : null;
  } catch {
    return null;
  }
}

// { bundle } or { error: "unknown" | "ambiguous" | "not-active", … }.
export function buildSpecDrift({
  proj,
  cfg,
  query,
  since = null,
  git = gitIn,
  grep = grepProjectLines,
  layout = null,
}) {
  const lay = layout || loadLayout(cfg.layout);
  const artifacts = scanArtifacts(cfg, lay);
  const found = resolveSpec(artifacts, query);
  if (found.error) return { error: found.error, query: String(query || ""), candidates: found.candidates };
  const spec = found.spec;
  const status = String(spec.fm.status || "draft");
  if (status !== "active") return { error: "not-active", status, spec: describe(spec) };

  const epicFolder = folderByKind(lay, "epic");
  const storyOf = (ref) =>
    epicFolder ? resolveSpecStory(ref, artifacts, epicFolder.path) : { error: "the layout has no epic folder" };

  // Contracts and their markers.
  const parsed = parseSpecContracts(spec) || [];
  const headings = contractHeadings(spec);
  const allMarkers = parseAmendmentMarkers(spec.body || "");
  const specDate = /^\d{4}-\d{2}-\d{2}/.test(String(spec.fm.date || "")) ? String(spec.fm.date).slice(0, 10) : null;
  const contracts = parsed.map((c, i) => {
    const markers = allMarkers
      .filter((m) => m.index === i)
      .map((m) => {
        const row = { line: m.line, date: m.date, kind: m.kind, ref: m.ref, why: m.why, valid: m.valid };
        if (!m.valid) row.form = m.form;
        const r = m.ref ? storyOf(m.ref) : { error: "no ref" };
        row.story = r.story ? { rel: r.story.rel, status: String(r.story.fm.status || "planned") } : null;
        if (r.error) row.story_error = r.error;
        return row;
      });
    const lastValid = markers.filter((m) => m.valid).at(-1) || null;
    const [anchor, anchor_from] = since
      ? [since, "since"]
      : lastValid
        ? [lastValid.date, "marker"]
        : [specDate, specDate ? "date" : null];
    return {
      n: c.n,
      heading: headings[i] ?? null,
      removed: c.removed,
      why: c.why,
      steps: [...c.steps],
      removed_steps: [...c.removedSteps],
      verified: c.marker,
      scenarios: c.scenarios,
      marks: c.marks,
      anchor,
      anchor_from,
      markers,
      cited_by: [],
      files_changed: null,
    };
  });

  // Covered stories and their refs.
  const stories = [];
  const refs = { empty: [], missing: [], unresolved: [] };
  const vaultRel = vaultInside(proj, cfg.vault_path);
  let all = null;
  const allFiles = () => (all ??= walk(proj, "", vaultRel));
  const fileRefs = new Map();
  for (const entry of listOf(spec.fm, "stories")) {
    const r = storyOf(entry);
    if (r.error) {
      stories.push({ ref: entry, error: r.error });
      refs.unresolved.push({ story: entry, error: r.error });
      continue;
    }
    const codeRefs = listOf(r.story.fm, "code_refs");
    const missing = [];
    for (const ref of codeRefs) {
      const files = expandRef(proj, ref, allFiles, vaultRel);
      if (files === null) {
        missing.push(ref);
        refs.missing.push({ story: entry, ref });
        continue;
      }
      for (const f of files) {
        if (!fileRefs.has(f)) fileRefs.set(f, new Set());
        fileRefs.get(f).add(ref);
      }
    }
    if (!codeRefs.length) refs.empty.push(entry);
    stories.push({
      ref: entry,
      rel: r.story.rel,
      title: String(r.story.fm.title || stemOf(r.story)),
      status: String(r.story.fm.status || "planned"),
      code_refs: codeRefs,
      missing,
    });
  }

  // Citations: the doctor's scan, keyed by id and alias; `example` is docs.
  const scan = scanCitations(cfg, artifacts, proj, grep) || { status: "ok", reason: null, tokens: [] };
  const keys = citationKeys(artifacts);
  if (scan.status === "ok") {
    for (const t of scan.tokens) {
      if (t.typographic || t.key === CITATION_EXAMPLE_KEY || keys.get(t.key) !== spec) continue;
      const top = t.n.split("/")[0];
      const c = contracts.find((x) => x.n === top);
      if (c) c.cited_by.push({ file: t.file, line: t.line, n: t.n });
    }
    for (const c of contracts) c.cited_by.sort((a, b) => byPath(a.file, b.file) || a.line - b.line || byPath(a.n, b.n));
  } else for (const c of contracts) c.cited_by = null;

  // Files, with history since each anchor of an open contract.
  const paths = [...fileRefs.keys()].sort(byPath);
  const anchors = [...new Set(contracts.filter((c) => !c.removed && c.anchor).map((c) => c.anchor))].sort(byPath);
  const history = scan.status === "no-git" ? null : historyByAnchor(proj, paths, anchors, git);
  let scanStatus = scan.status;
  let reason = scan.reason || null;
  if (scanStatus === "ok" && history && [...history.values()].some((h) => h === null)) {
    scanStatus = "unknown";
    reason = "git log did not answer";
  }
  const files = paths.map((p) => {
    let changed_since = null;
    // No anchor at all (no `date:`, no valid marker, no --since, or every
    // contract removed): nothing to count from, so history is unknown, not none.
    if (history && anchors.length) {
      changed_since = {};
      for (const a of anchors) {
        const h = history.get(a);
        const commits = h ? h.get(p) || [] : null;
        changed_since[a] = commits ? { count: commits.length, last: commits.slice(0, 3) } : null;
      }
    }
    return {
      path: p,
      class: classOf(p),
      lines: lineCount(join(proj, p)),
      refs: [...fileRefs.get(p)].sort(byPath),
      changed_since,
    };
  });
  for (const c of contracts) {
    if (c.removed || !c.anchor || !history || history.get(c.anchor) === null) continue;
    c.files_changed = files.filter((f) => f.changed_since[c.anchor]?.count > 0).length;
  }

  const lines = { source: 0, tests: 0, surface: 0, total: 0 };
  const byClass = { source: 0, tests: 0, surface: 0 };
  for (const f of files) {
    byClass[f.class]++;
    if (f.lines !== null) {
      lines[f.class] += f.lines;
      lines.total += f.lines;
    }
  }
  const removed = contracts.filter((c) => c.removed).length;
  const changed =
    history && anchors.length
      ? files.filter((f) => Object.values(f.changed_since).some((x) => x?.count > 0)).length
      : null;
  return {
    bundle: {
      spec: { ...describe(spec), title: realValue(spec.fm.title), date: specDate },
      checkout: basename(proj),
      since,
      scan: { status: scanStatus, reason },
      totals: {
        contracts: contracts.length,
        contracts_removed: removed,
        contracts_open: contracts.length - removed,
        stories: stories.length,
        files: files.length,
        files_by_class: byClass,
        lines,
        files_changed: history && [...history.values()].some((h) => h === null) ? null : changed,
        refs_empty: refs.empty.length,
        refs_missing: refs.missing.length,
        stories_unresolved: refs.unresolved.length,
      },
      contracts,
      stories,
      refs,
      files,
    },
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { query: null, since: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") {
      opts.since = argv[++i];
      if (!opts.since || Number.isNaN(Date.parse(opts.since)))
        die("--since expects a date (YYYY-MM-DD or an ISO timestamp)");
    } else if (a === "--project") {
      opts.project = argv[++i];
      if (!opts.project) die("--project expects a directory");
    } else if (a.startsWith("--")) die(`unknown argument: ${a}`);
    else if (opts.query === null) opts.query = a;
    else die(`one spec per run (got "${opts.query}" and "${a}")`);
  }
  return opts;
}

const named = (c) => `${c.id || c.rel} (${c.rel}, ${c.status})`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const proj = resolve(opts.project || projectRoot());
  const cfg = readConfigAt(proj);
  if (!cfg || !cfg.vault_path) die(`No projectstore config. Run ${commandForm("bind")} first.`);
  if (!existsSync(cfg.vault_path)) die(`The bound vault is not there: ${cfg.vault_path}`);
  if (!opts.query) die("usage: spec-drift.mjs <spec id|alias|stem> [--since <date>]");
  const r = buildSpecDrift({ proj, cfg, query: opts.query, since: opts.since });
  if (r.error === "not-active")
    die(`Spec ${named(r.spec)} is ${r.status}, not active: spec drift reads an active spec only.`);
  if (r.error === "ambiguous")
    die(`"${r.query}" names more than one spec; name one of: ${r.candidates.map(named).join("; ")}.`);
  if (r.error === "unknown")
    die(
      `No spec answers to "${r.query}" by id, alias or filename. Candidates: ${r.candidates.map(named).join("; ") || "none"}.`,
    );
  // Compact on purpose: the reviewer reads it through a tool whose output may be capped.
  process.stdout.write(JSON.stringify(r.bundle) + "\n");
}

if (isMain(import.meta.url)) {
  main();
}

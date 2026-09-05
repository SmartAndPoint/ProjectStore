#!/usr/bin/env node
// projectstore — reconcile.mjs
// Re-derives every derived view from the vault's source of truth:
// kanban.md, folder-index README tables, code-map.md, graph.md. Hand-edits
// therefore can never *permanently* desync the views (PS-IMPROVE story-002,
// ADR-004/005: vault-side repairs belong to reconcile, not doctor --fix).
//
// Two modes (spec: atomic-regeneration-of-derived-views):
//   compute (default) — read-only. Output JSON lists each target with
//     {path, changed, content?, stats?} plus summary.{changed, failed}.
//     Idempotent: a clean vault yields zero changes. Exit stays 0 (a
//     reporting tool) — per-target errors surface via summary.failed and
//     the command prose, not the exit code.
//   --write — applies the regeneration itself: every selected target is
//     recomputed from the vault state at write time (the approval covers
//     the regeneration action, not a byte snapshot) and replaced atomically
//     via lib.mjs writeFileAtomic. Report per target {path, changed,
//     written, error?} — no content on stdout. Continue-on-error; exits 1
//     iff a selected target failed, so a cron caller notices. Headless use
//     is sanctioned by ADR-009 ("reconcile as a scheduled repair job").
//
// --only <sel>[,…] limits either mode to: kanban | codemap | graph |
//   indexes | indexes=<folder-path>. Unknown selectors, and explicitly
//   *named* targets the layout or vault cannot provide, die loudly — a
//   typo'd cron job must not silently reconcile nothing. Bare invocation
//   (and the class-wide `indexes`) keeps the silent-skip behaviour for
//   absent targets.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  readConfig,
  readConfigAt,
  loadLayout,
  projectRoot,
  pluginRoot,
  indexHeaderRe,
  slugIdentity,
  displayNumberOf,
  compareArtifactOrder,
  writeFileAtomic, isMain
} from "./lib.mjs";
import { childEnv } from "./harness.mjs";

// Set by runReconcile when a caller names the project; the generators it
// spawns receive it. Null means "this process's own project".
let _projectDir = null;
let _env = null;
import { scanArtifacts } from "./doctor.mjs";

function die(msg) {
  process.stderr.write(`projectstore/reconcile: ${msg}\n`);
  process.exit(1);
}

function runGenerator(script) {
  const r = spawnSync(process.execPath, [join(pluginRoot(), "scripts", script)], {
    encoding: "utf8",
    timeout: 10000,
    env: _env || childEnv(process.env, { projectRoot: _projectDir || projectRoot() }),
  });
  if (r.status !== 0) return { error: (r.stderr || "generator failed").trim() };
  try { return JSON.parse(r.stdout); } catch { return { error: "unparseable generator output" }; }
}

const normalize = (s) =>
  s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();

const errMsg = (e) => String((e && e.message) || e);

// Which targets does this invocation cover? Pure over the layout so the
// kanban-less-layout branch is testable without a fake plugin root.
// Returns {error} on a selector the layout cannot satisfy. `named` marks an
// individually named index (indexes=adr) — those fail loudly when the vault
// cannot provide them; the class-wide selectors skip, like bare invocation.
export function resolveSelection(layout, onlyRaw) {
  const validSelectors = () =>
    [layout.kanban ? "kanban" : null, "codemap", "graph", "indexes",
     ...layout.folders.map((f) => `indexes=${f.path}`)]
      .filter(Boolean).join(", ");
  if (onlyRaw == null) {
    return {
      explicit: false,
      kanban: true,
      codemap: true,
      graph: true,
      indexes: layout.folders.map((f) => ({ path: f.path, named: false })),
    };
  }
  const sel = { explicit: true, kanban: false, codemap: false, graph: false, indexes: [] };
  const parts = String(onlyRaw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: `empty --only selection — valid: ${validSelectors()}` };
  for (const raw of parts) {
    if (raw === "kanban") {
      if (!layout.kanban) return { error: `layout declares no kanban — valid: ${validSelectors()}` };
      sel.kanban = true;
    } else if (raw === "codemap") {
      if (!layout.folders.some((f) => f.kind === "epic")) {
        return { error: `layout has no epic folder, so there is no code map — valid: ${validSelectors()}` };
      }
      sel.codemap = true;
    } else if (raw === "graph") {
      // Valid on every layout: the graph's node universe is whatever
      // artifact kinds the layout declares — there is no layout without one.
      sel.graph = true;
    } else if (raw === "indexes") {
      // Merge, never assign: `indexes=adr,indexes` must keep adr's named
      // loudness rather than silently demoting it to a skippable member.
      for (const f of layout.folders) {
        if (!sel.indexes.some((x) => x.path === f.path)) sel.indexes.push({ path: f.path, named: false });
      }
    } else if (raw.startsWith("indexes=")) {
      const p = raw.slice("indexes=".length);
      if (!layout.folders.some((f) => f.path === p)) {
        return { error: `no folder "${p}" in this layout — valid: ${validSelectors()}` };
      }
      const existing = sel.indexes.find((x) => x.path === p);
      if (existing) existing.named = true; // upgrade, whatever the order
      else sel.indexes.push({ path: p, named: true });
    } else {
      return { error: `unknown selector "${raw}" — valid: ${validSelectors()}` };
    }
  }
  return sel;
}

// Per-target politeness skips for bare invocation. `explicit` (the human
// named the target with --only) suppresses them wholesale — an explicitly
// requested target is always produced. Each returns a reason string or null.
//
// codemap: skip only a fresh vault (file absent AND zero code_refs) — a
// deleted code-map.md on a vault with refs IS re-minted by bare --write.
// graph: STRICTER — skip whenever graph.md is absent (spec contract 1): a
// routine `reconcile --write` after a plugin upgrade must not silently mint
// a new root file, and near-simultaneous first creation on two machines
// would mint an iCloud conflicted copy. Deletion therefore reads as first
// creation; the standing signal is doctor's missing-graph info.
const SKIP = {
  "kanban.mjs": null,
  "codemap.mjs": (g, onDisk) =>
    onDisk === null && g.stats && g.stats.epics_with_refs === 0 && g.stats.story_rows === 0
      ? "no code_refs anywhere and no existing file"
      : null,
  "graph.mjs": (g, onDisk) =>
    onDisk === null
      ? "graph.md does not exist yet — create it explicitly (--only graph or /projectstore:graph)"
      : null,
};

// Compute one generator-backed target (kanban, code-map, graph).
// `fallbackPath` keeps the report shape ({path, …}) even when the generator
// itself failed and never told us where its target lives.
function derivedTarget(script, explicit = false, fallbackPath = null) {
  const g = runGenerator(script);
  if (g.error) return { ...(fallbackPath ? { path: fallbackPath } : {}), error: g.error };
  let onDisk = null;
  try {
    onDisk = existsSync(g.path) ? readFileSync(g.path, "utf8") : null;
  } catch (e) {
    return { path: g.path, error: errMsg(e) };
  }
  const skipWhy = !explicit && SKIP[script] ? SKIP[script](g, onDisk) : null;
  if (skipWhy) {
    return { path: g.path, changed: false, skipped: skipWhy, stats: g.stats };
  }
  const changed = onDisk === null || normalize(onDisk) !== normalize(g.content);
  const base = { path: g.path, changed, stats: g.stats };
  return changed ? { ...base, content: g.content } : base;
}

// Rebuild a folder README's Index table rows from artifact frontmatter,
// preserving every byte outside the managed table. Pure over the bytes so
// the check-and-retry writer can recompute from a fresh read.
// Returns {content} (possibly === original) or {unusable: reason} when the
// README carries no managed table this script may touch.
export function rebuildIndexRows(original, folder, artifacts) {
  const lines = original.split("\n");
  // Header matched via the heading registry (PS-SPEC story-002) — ru vaults'
  // localized index headers were unreconcilable while this was an English
  // literal. Unrecognized headers surface as a doctor index-header finding.
  const headerRe = indexHeaderRe();
  const headIdx = lines.findIndex((l) => headerRe.test(l));
  if (headIdx === -1) return { unusable: "no recognised index-table header" };
  if (!/^\|[-\s|]+\|$/.test(lines[headIdx + 1] || "")) {
    return { unusable: "malformed separator row under the index header" };
  }

  let end = headIdx + 2;
  while (end < lines.length && /^\|/.test(lines[end])) end++;

  const rows = [];
  const inFolder = artifacts.filter((a) =>
    folder.kind === "epic"
      ? a.kind === "epic" && a.rel.startsWith(`${folder.path}/`)
      : a.kind === folder.kind && a.rel === `${folder.path}/${basename(a.rel)}`);
  // Ordering per SPEC-002 contract 8: date ascending (date:, else created:),
  // display number then slug as tiebreak — the grandfathered ADR-001…N order
  // survives because same-date groups tiebreak by number.
  const decorated = inFolder.map((a) => {
    const file = basename(a.rel);
    const idOpts = { prefix: folder.prefix || null };
    return {
      a,
      file,
      date: String(a.fm.date || a.fm.created || ""),
      number: folder.kind === "epic" ? null : displayNumberOf(a.fm, file, idOpts),
      slug: folder.kind === "epic" ? a.rel.split("/")[1].toLowerCase() : slugIdentity(file, idOpts).primary,
    };
  });
  for (const d of decorated.sort(compareArtifactOrder)) {
    const { a, file, date, number } = d;
    if (folder.kind === "epic") {
      const id = a.rel.split("/")[1];
      rows.push(`| [${id}](./${id}/epic.md) | ${a.fm.title || id} | ${a.fm.status || "planned"} | ${date} |`);
    } else {
      // The display number renders only when present — grandfathered
      // SPEC-NNN rows keep their labels, slug-only rows are labelled by slug.
      const label = number && folder.prefix ? `${folder.prefix}${number}` : file.replace(/\.md$/, "");
      const status = a.fm.status || (folder.numbered ? "proposed" : "draft");
      rows.push(`| [${label}](./${file}) | ${a.fm.title || label} | ${status} | ${date} |`);
    }
  }

  return { content: [...lines.slice(0, headIdx + 2), ...rows, ...lines.slice(end)].join("\n") };
}

// Compute-mode wrapper: read + rebuild, today's {path, folder, changed,
// content?} shape. null = nothing to reconcile here (absent README or no
// managed table) — bare invocation filters those out silently.
export function rebuildIndex(cfg, folder, artifacts) {
  const readmePath = join(cfg.vault_path, folder.path, "README.md");
  let original;
  try {
    if (!existsSync(readmePath)) return null;
    original = readFileSync(readmePath, "utf8");
  } catch (e) {
    return { path: readmePath, folder: folder.path, error: errMsg(e) };
  }
  const r = rebuildIndexRows(original, folder, artifacts);
  if (r.unusable) return null;
  return r.content === original
    ? { path: readmePath, folder: folder.path, changed: false }
    : { path: readmePath, folder: folder.path, changed: true, content: r.content };
}

// Apply an index regeneration with check-and-retry (spec contract 3): the
// README is a source+derived hybrid — its prose is content a human owns and
// nothing can recompute. Read, rebuild the managed rows, re-read immediately
// before the atomic replace; on any drift recompute from the fresh bytes.
// Never writes from stale bytes; after `attempts` collisions it reports an
// error instead. The microseconds between the final re-read and the rename,
// and a crash mid-sequence, are the residual risk the spec accepts (no
// locks, per ADR-010). `rebuild` is (bytes) => {content}|{unusable} —
// production passes rebuildIndexRows, tests inject a mutating hook.
export function writeIndexWithRetry(readmePath, rebuild, { attempts = 3 } = {}) {
  let base;
  try {
    if (!existsSync(readmePath)) return { unusable: "README.md does not exist" };
    base = readFileSync(readmePath, "utf8");
  } catch (e) {
    return { error: errMsg(e) };
  }
  for (let i = 0; i < attempts; i++) {
    const r = rebuild(base);
    if (r.unusable) return { unusable: r.unusable };
    let now;
    try {
      now = readFileSync(readmePath, "utf8");
    } catch (e) {
      return { error: errMsg(e) };
    }
    if (now !== base) {
      base = now; // drift during rebuild — recompute from what is there now
      continue;
    }
    if (r.content === base) return { changed: false, written: false };
    try {
      writeFileAtomic(readmePath, r.content);
    } catch (e) {
      return { changed: true, written: false, error: errMsg(e) };
    }
    return { changed: true, written: true };
  }
  return { error: `concurrent edits persisted through ${attempts} attempts — re-run reconcile` };
}

// Apply a generator-backed target. The compute happens here, immediately
// before its own write — never compute-all-then-write-all — which is what
// shrinks the staleness window to microseconds (spec contract 1).
function applyDerived(script, explicit, fallbackPath) {
  const t = derivedTarget(script, explicit, fallbackPath);
  if (t.error) return { ...(t.path ? { path: t.path } : {}), changed: t.changed === true, written: false, error: t.error };
  if (t.skipped) return { path: t.path, changed: false, written: false, skipped: t.skipped, stats: t.stats };
  if (!t.changed) return { path: t.path, changed: false, written: false, stats: t.stats };
  try {
    writeFileAtomic(t.path, t.content);
    return { path: t.path, changed: true, written: true, stats: t.stats };
  } catch (e) {
    return { path: t.path, changed: true, written: false, error: errMsg(e), stats: t.stats };
  }
}

export function runReconcile({ write = false, only = null, projectDir = null, env = null } = {}) {
  _projectDir = projectDir;
  _env = env;
  const cfg = projectDir ? readConfigAt(projectDir) : readConfig();
  if (!cfg) { const e = new Error("No projectstore config. Run /projectstore:bind first."); e.code = "UNBOUND"; throw e; }
  const layout = loadLayout(cfg.layout);
  const sel = resolveSelection(layout, only);
  if (sel.error) throw new Error(sel.error);
  const artifacts = scanArtifacts(cfg, layout);

  // Pre-flight every individually NAMED index before any side effect: a
  // named target the vault cannot provide is a config error, and a config
  // error must abort with nothing written. Throwing later, mid-loop, would
  // discard the report while keeping mutations already applied — the one
  // shape contract 1 forbids outright. A target that becomes unusable
  // between this check and its write (a race) degrades to a per-target
  // error below instead.
  for (const { path: folderPath, named } of sel.indexes) {
    if (!named) continue;
    const folder = layout.folders.find((f) => f.path === folderPath);
    const readmePath = join(cfg.vault_path, folder.path, "README.md");
    if (!existsSync(readmePath)) throw new Error(`${folder.path}/README.md does not exist`);
    const r = rebuildIndexRows(readFileSync(readmePath, "utf8"), folder, artifacts);
    if (r.unusable) throw new Error(`${folder.path}/README.md: ${r.unusable}`);
  }

  const out = {};

  const kanbanPath = layout.kanban ? join(cfg.vault_path, layout.kanban.file || "kanban.md") : null;
  if (!sel.kanban) out.kanban = { skipped: "not selected" };
  else if (!layout.kanban) out.kanban = { skipped: "layout has no kanban" };
  else out.kanban = write ? applyDerived("kanban.mjs", sel.explicit, kanbanPath) : derivedTarget("kanban.mjs", sel.explicit, kanbanPath);

  const codemapPath = join(cfg.vault_path, "code-map.md");
  if (!sel.codemap) out.codemap = { skipped: "not selected" };
  else out.codemap = write ? applyDerived("codemap.mjs", sel.explicit, codemapPath) : derivedTarget("codemap.mjs", sel.explicit, codemapPath);

  const graphPath = join(cfg.vault_path, "graph.md");
  if (!sel.graph) out.graph = { skipped: "not selected" };
  else out.graph = write ? applyDerived("graph.mjs", sel.explicit, graphPath) : derivedTarget("graph.mjs", sel.explicit, graphPath);

  out.indexes = [];
  for (const { path: folderPath, named } of sel.indexes) {
    const folder = layout.folders.find((f) => f.path === folderPath);
    const readmePath = join(cfg.vault_path, folder.path, "README.md");
    if (write) {
      // Index rows are rebuilt from the artifact scan taken at the top of
      // this invocation (already inside the apply call, i.e. after the human
      // approval gap), while the README *bytes* are re-read per attempt.
      // Kanban/code-map recompute fully inline — the asymmetry is deliberate:
      // rescanning every artifact per index would be quadratic for a
      // freshness gain of milliseconds that contract 4 convergence covers.
      const r = writeIndexWithRetry(readmePath, (b) => rebuildIndexRows(b, folder, artifacts));
      if (r.unusable) {
        // Pre-flighted named targets can only reach this via a race.
        if (named) {
          out.indexes.push({ path: readmePath, folder: folder.path, changed: false, written: false, error: r.unusable });
        }
        continue;
      }
      out.indexes.push({
        path: readmePath,
        folder: folder.path,
        changed: !!r.changed,
        written: !!r.written,
        ...(r.error ? { error: r.error } : {}),
      });
    } else {
      const t = rebuildIndex(cfg, folder, artifacts);
      if (t === null) {
        if (named) {
          out.indexes.push({ path: readmePath, folder: folder.path, error: "absent or no managed index table (changed since pre-flight)" });
        }
        continue;
      }
      out.indexes.push(t);
    }
  }

  const all = [out.kanban, out.codemap, out.graph, ...out.indexes];
  // `failed` is reported in BOTH modes — a compute-mode generator error must
  // be visible in the summary, not buried in a target the prose's "changed
  // targets" preview never lists. Exit-code policy stays write-scoped
  // (compute remains a reporting tool; see main()).
  out.summary = {
    changed: all.filter((t) => t && t.changed).length,
    failed: all.filter((t) => t && t.error).length,
  };
  if (write) out.summary.written = all.filter((t) => t && t.written).length;
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  let write = false;
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--only") only = argv[++i];
    else if (a.startsWith("--only=")) only = a.slice("--only=".length);
    else die(`unknown argument: ${a}`);
  }
  if (only === undefined) die("--only requires a value");

  let out;
  try {
    out = runReconcile({ write, only });
  } catch (e) {
    die(errMsg(e));
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (write && out.summary.failed > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}

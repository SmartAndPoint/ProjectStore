#!/usr/bin/env node
// projectstore — graph.mjs
// Derives graph.md — the vault link graph — from body links and typed
// frontmatter relations (source of truth). Third root-level derived view
// beside kanban.md and code-map.md (spec:
// vault-link-graph-derived-view-and-shared-link-resolver; the accepted
// link-graph ADR decides the shape). Nodes are layout artifacts keyed by
// full vault-relative path; edges are typed; nothing resolves silently —
// dead, ambiguous and out-of-scope targets stay visible as edges.
//
// Output: JSON { path, content, stats } — compute only. The applier is
// reconcile.mjs --write (atomic replace, recompute-at-write), not the
// harness: no Write-tool step remains in the derived-view flows.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfig,
  loadLayout,
  folderByKind,
  listOf,
  nowIso,
  buildNodeIndex,
  extractLinks,
  resolveLinkTarget,
  storyMatchesEntry,
} from "./lib.mjs";
import { walkVaultFiles } from "./doctor.mjs";
import { localizeCommands } from "./harness.mjs";

function die(msg) {
  // Single choke point: every failure message this script can print names
  // commands, and the spelling differs per harness.
  msg = localizeCommands(msg);
  process.stderr.write(`projectstore/graph: ${msg}\n`);
  process.exit(1);
}

// Frontmatter refs arrive as inline-flow lists (listOf) or, for
// supersedes/superseded_by, as a bare scalar — normalize both to a list.
function refsOf(fm, key) {
  const viaList = listOf(fm, key);
  if (viaList.length) return viaList;
  const raw = fm[key];
  return typeof raw === "string" && raw && raw !== "[]" && !raw.trim().startsWith("[")
    ? [raw.trim()]
    : [];
}

// Resolve a qualified "<epic-id>/<story-id>" spec entry to a story node —
// the same tiered control flow as doctor's resolveSpecStory, on the same
// SPEC-002 primitive (storyMatchesEntry): strongest tier wins across the
// epic's stories, a tie within it is ambiguity, never a silent first match.
function resolveStoryEntry(entry, index, epicsPath) {
  const m = String(entry).match(/^([^/]+)\/(.+)$/);
  if (!m) return { outcome: "dead" };
  const [, epicId, storyId] = m;
  let best = 0;
  let hits = [];
  for (const n of index.nodes) {
    if (n.type !== "story" || !n.path.startsWith(`${epicsPath}/${epicId}/`)) continue;
    const tier = storyMatchesEntry(storyId, { id: n.identity, stem: n.stem });
    if (!tier) continue;
    if (best === 0 || tier < best) { best = tier; hits = [n]; }
    else if (tier === best) hits.push(n);
  }
  if (hits.length === 1) return { outcome: "node", node: hits[0] };
  if (hits.length > 1) return { outcome: "ambiguous", candidates: hits.map((n) => n.path).sort() };
  return { outcome: "dead" };
}

export function buildGraph(cfg, layout, { files = null } = {}) {
  const index = buildNodeIndex(cfg, layout);
  const vaultFiles = files ?? walkVaultFiles(cfg.vault_path);
  const epicsPath = folderByKind(layout, "epic")?.path ?? null;

  // Dedup on the (from, kind, to) triple (spec contract 4). The To cell for
  // dead targets is the raw text as written; ambiguous additionally lists
  // every candidate path in the row.
  const edges = new Map();
  const addEdge = (from, kind, to) => {
    const k = `${from}\u0000${kind}\u0000${to}`;
    if (!edges.has(k)) edges.set(k, { from, kind, to });
  };
  const addResolved = (from, r, raw, kinds = {}) => {
    if (r.outcome === "node") addEdge(from, kinds.node ?? "wikilink", r.node.path);
    else if (r.outcome === "dead") addEdge(from, "dead", raw);
    else if (r.outcome === "ambiguous") addEdge(from, "ambiguous", `${raw} (matches: ${r.candidates.join(", ")})`);
    else addEdge(from, "out-of-scope", r.path ?? raw);
  };

  const exists = (rel) => existsSync(join(cfg.vault_path, rel));
  for (const n of index.nodes) {
    // Body links — kind-unscoped, extracted ONLY from node files: derived
    // views and READMEs are never link sources, so graph.md can never feed
    // back into itself (spec contract 2). One ctx per node: the resolver
    // caches its file set on the ctx object, and rebuilding it per link
    // would be O(links × files) — the growth curve this view exists for.
    const ctx = { sourceRel: n.path, index, files: vaultFiles, exists };
    for (const link of extractLinks(n.body)) {
      addResolved(n.path, resolveLinkTarget(link.target, link.type, ctx), link.target, { node: link.type });
    }

    // Typed frontmatter relations — kind-scoped by their field (spec
    // contract 3). The two-sided spec↔story declaration is read as a union
    // and normalized to spec→story before dedup (contract 4); asymmetry is
    // doctor's existing checkSpecLinks warning, not a graph finding.
    const refCtx = (kinds) => ({ ...ctx, kinds });
    if (n.type === "spec") {
      for (const entry of refsOf(n.fm, "stories")) {
        const r = epicsPath ? resolveStoryEntry(entry, index, epicsPath) : { outcome: "dead" };
        if (r.outcome === "node") addEdge(n.path, "spec-covers", r.node.path);
        else addResolved(n.path, r, entry);
      }
      for (const entry of refsOf(n.fm, "adr")) {
        const r = resolveLinkTarget(entry, "ref", refCtx(["adr"]));
        if (r.outcome === "node") addEdge(n.path, "spec-implements-adr", r.node.path);
        else addResolved(n.path, r, entry);
      }
    }
    if (n.type === "story") {
      for (const entry of refsOf(n.fm, "specs")) {
        const r = resolveLinkTarget(entry, "ref", refCtx(["spec"]));
        if (r.outcome === "node") addEdge(r.node.path, "spec-covers", n.path);
        else addResolved(n.path, r, entry);
      }
    }
    if (n.type === "adr") {
      for (const entry of refsOf(n.fm, "supersedes")) {
        const r = resolveLinkTarget(entry, "ref", refCtx(["adr"]));
        if (r.outcome === "node") addEdge(n.path, "supersedes", r.node.path);
        else addResolved(n.path, r, entry);
      }
      for (const entry of refsOf(n.fm, "superseded_by")) {
        // Normalized to the superseding ADR as From — one direction, dedup
        // then collapses the two-sided declaration.
        const r = resolveLinkTarget(entry, "ref", refCtx(["adr"]));
        if (r.outcome === "node") addEdge(r.node.path, "supersedes", n.path);
        else addResolved(n.path, r, entry);
      }
    }
    // Folder structure: epic.md contains its stories.
    if (n.type === "epic") {
      const epicDirPrefix = n.path.replace(/\/epic\.md$/, "/");
      for (const s of index.nodes) {
        if (s.type === "story" && s.path.startsWith(epicDirPrefix)) {
          addEdge(n.path, "epic-contains", s.path);
        }
      }
    }
  }

  // Stable plain-string sort (from, kind, to) — deterministic across
  // machines and locales; minimal diffs on a synced root file.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const nodeRows = [...index.nodes].sort((a, b) => cmp(a.path, b.path));
  const edgeRows = [...edges.values()].sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));

  const esc = (s) => String(s).replace(/\|/g, "\\|");
  const lines = [
    "---",
    "",
    "projectstore: derived",
    `generated_at: ${nowIso()}`,
    "",
    "---",
    "",
    "# Vault link graph",
    "",
    "Nodes (layout artifacts, keyed by vault-relative path) and typed edges,",
    "derived from body links and frontmatter relations (source of truth).",
    "Regenerate via `/projectstore:graph`; grep a path to see an artifact's",
    "full typed neighborhood, both directions, in one call.",
    "",
    "## Nodes",
    "",
    "| Path | Title | Type | Status |",
    "|------|-------|------|--------|",
  ];
  for (const n of nodeRows) {
    lines.push(`| ${n.path} | ${esc(n.title)} | ${n.type} | ${n.status ?? "-"} |`);
  }
  lines.push("", "## Edges", "", "| From | Kind | To |", "|------|------|----|");
  for (const e of edgeRows) {
    lines.push(`| ${e.from} | ${e.kind} | ${e.to} |`);
  }
  lines.push("");

  const byKind = {};
  for (const e of edgeRows) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  return {
    // Localized at the join rather than per line: this block is written INTO
    // graph.md, which a human then reads in the vault, and the footer names a
    // command whose spelling is harness-specific.
    content: localizeCommands(lines.join("\n")),
    stats: {
      nodes: nodeRows.length,
      edges: edgeRows.length,
      by_kind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => cmp(a, b))),
    },
  };
}

function main() {
  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind first.");
  const layout = loadLayout(cfg.layout);
  const g = buildGraph(cfg, layout);
  process.stdout.write(JSON.stringify({
    path: join(cfg.vault_path, "graph.md"),
    content: g.content,
    stats: g.stats,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

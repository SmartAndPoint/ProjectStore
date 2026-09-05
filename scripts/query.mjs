// projectstore — query.mjs
//
// The read operations behind the CLI's read verbs and the MCP surface's
// tools — one exported function per MCP tool (MCP ADR decision 2): status,
// orientation, search, show (get_artifact), neighbors, lineage, codeRefs.
// Read-only, no stdout side effects, no writes: imported by scripts/cli.mjs;
// the MCP server reaches these only through cli.run(), so the envelope is
// built in one place — but it shares the module graph, where stdout is the
// protocol channel.
//
// Every result is small on purpose — a model reads it. Artifact paths in
// results are vault-relative and /-joined (the vault's own path, a project
// root and a session's project root are absolute by nature and named as
// such); every cap is reported (`truncated`, `returned`, `total`, a match's
// `of`), never silent; a scan that outruns its deadline says `status:
// "timeout"` rather than returning a short list that claims completeness
// (the skeleton spec's contract 13, applied to a model consumer). Sorting is
// by plain string comparison, so two runs agree byte for byte. The one
// deliberately unbounded result is `show --body`: the CLI's caller asked for
// the file; the MCP surface exposes it as a resource, not a tool result.
//
// The operations reuse the core, never re-walk it: the graph's edges come
// from buildGraph (the one resolver, so `neighbors` and `grep graph.md`
// return the same facts), stories from the kanban generator's finder, the
// vault walk from doctor's (a static import is safe: doctor's main() is
// guarded, and this module takes one pure function from it — the MCP ADR's
// "spawn, never import" is about running doctor, which stays cli.mjs's
// spawn), the orientation from the SessionStart gather. Bad input is a
// usage error (`code: "USAGE"`), which the front-ends turn into exit 2.
//
// Normative: MCP ADR decisions 2 and 4; the link-graph ADR's decision 4
// (edge kinds) and decision 7 (agents with MCP call the live index); the
// distribution ADR decisions 3 and 4. Pure node, no external deps.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, isAbsolute, relative } from "node:path";
import {
  loadLayout,
  loadHeadingsRegistry,
  folderByKind,
  parseFrontmatter,
  buildNodeIndex,
  gatherVaultFacts,
  renderVaultSkeleton,
  folderPurpose,
  truncEnd,
  readVaultConfig,
  readActiveSessions,
  listOf,
  sectionOf,
  isInsideVault,
} from "./lib.mjs";
import { walkVaultFiles } from "./doctor.mjs";
import { buildGraph } from "./graph.mjs";
import { findStories, statusToColumn } from "./kanban.mjs";

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_HARD_CAP = 100;
export const SEARCH_PER_FILE_CAP = 3;
export const SEARCH_DEADLINE_MS = 5000;
export const SNIPPET_CELL = 160;
export const GRAPH_EDGE_CAP = 100;
export const LINEAGE_KINDS = Object.freeze(["supersedes", "spec-covers", "spec-implements-adr", "epic-contains"]);
export const LINEAGE_DEFAULT_DEPTH = 3;
export const LINEAGE_NODE_CAP = 50;
export const CODE_REFS_CAP = 100;
export const IN_FLIGHT_CAP = 5;
export const ORIENTATION_BUDGET_MS = 5000;
export const DIRECTIONS = Object.freeze(["in", "out", "both"]);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ─── Paths and arguments ───────────────────────────────────────────────

export function vaultOf(cfg) {
  return String(cfg?.vault_path || "").replace(/\/+$/, "");
}

// The derived views by name: the board's file is a layout value, the other
// two are fixed by their generators.
export function derivedViews(layout) {
  return [(layout && layout.kanban && layout.kanban.file) || "kanban.md", "code-map.md", "graph.md"];
}

// A path argument as the vault knows it: absolute paths are normalised first
// and must lie inside the vault (isInsideVault is a prefix test — resolve()
// collapses a `..` before it is asked); relative ones are vault-relative and
// `..` never resolves.
export function toVaultRel(vault, p) {
  if (typeof p !== "string" || !p.trim()) throw usageError("a vault-relative path is required");
  const s = p.trim().replace(/\\/g, "/");
  if (isAbsolute(s)) {
    const abs = resolve(s);
    if (!isInsideVault(abs, vault)) throw usageError(`${s} is outside the vault ${vault}`);
    return relative(vault, abs).replace(/\\/g, "/");
  }
  const rel = s.replace(/^\.\//, "").replace(/\/+$/, "");
  if (rel.split("/").some((seg) => seg === "..")) throw usageError(`${p} escapes the vault`);
  return rel;
}

function usageError(msg) {
  const e = new Error(msg);
  e.code = "USAGE";
  return e;
}

// Option values are validated, not coerced: a `--depth abc` that silently
// became depth 0 would present the root alone as a complete answer.
export function intOption(name, value, { min = 0, max = Infinity, fallback }) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw usageError(`--${name} takes an integer${max < Infinity ? ` between ${min} and ${max}` : ` ≥ ${min}`}, not "${value}"`);
  return n;
}

export function oneOf(name, value, allowed, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) throw usageError(`--${name} takes one of ${allowed.join(", ")}, not "${value}"`);
  return value;
}

function readGeneratedAt(p) {
  try {
    const head = readFileSync(p, "utf8").slice(0, 2000);
    const m = head.match(/^generated_at:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function nodeFacts(n) {
  return n ? { type: n.type, title: n.title, status: n.status } : { type: null, title: null, status: null };
}

function layoutOf(cfg) {
  try { return { layout: loadLayout(cfg.layout), error: null }; } catch (e) { return { layout: null, error: e.message }; }
}

// ─── status ────────────────────────────────────────────────────────────

// The binding probe and the board, as facts: what is bound, what is in
// progress, whether the derived views are fresh. Counts come from the
// stories' frontmatter through the kanban generator's own finder — the view
// file is reported as freshness metadata only, so the two cannot disagree —
// and the stories the finder leaves off the board are counted too, so a
// total is explainable without reading the generator.
export function status(cfg, { project = null } = {}) {
  if (!cfg || !cfg.vault_path) {
    return { bound: false, project, vault_path: null, vault_exists: false, layout: null, language: null, auto_inject: null, approval_mode: null, spec_policy: null, lifecycle_gates: null, stories: null, views: null, sessions: null };
  }
  const vault = vaultOf(cfg);
  const out = { bound: true, project, vault_path: vault, vault_exists: existsSync(vault), layout: cfg.layout || null, language: cfg.language || "en", auto_inject: cfg.auto_inject !== false, approval_mode: cfg.approval_mode || "always", spec_policy: null, lifecycle_gates: null, stories: null, views: null, sessions: null };
  if (!out.vault_exists) return out;
  const vcfg = readVaultConfig(vault);
  out.spec_policy = vcfg.spec_policy || "optional";
  out.lifecycle_gates = vcfg.lifecycle_gates || "on";
  const { layout, error } = layoutOf(cfg);
  const epicFolder = layout ? folderByKind(layout, "epic") : null;
  if (!layout) out.stories = { status: "error", error };
  else if (!epicFolder) out.stories = { status: "error", error: `layout ${cfg.layout} has no epic folder` };
  else {
    const { stories, skipped } = findStories(vault, epicFolder.path);
    const byStatus = {};
    for (const s of stories) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    const inProgress = stories.filter((s) => statusToColumn(s.status) === "In Progress")
      .map((s) => ({ path: s.relPath, epic: s.epicId, title: s.title, started_at: null }));
    // started_at is not part of the finder's row; read it for the few in flight.
    for (const s of inProgress) {
      try { s.started_at = parseFrontmatter(readFileSync(join(vault, s.path), "utf8")).data.started_at ?? null; } catch {}
    }
    inProgress.sort((a, b) => cmp(String(b.started_at || ""), String(a.started_at || "")) || cmp(a.path, b.path));
    const skippedCounts = Object.fromEntries(Object.entries(skipped || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]).filter(([, n]) => n > 0).sort(([a], [b]) => cmp(a, b)));
    out.stories = {
      status: "ok", total: stories.length, by_status: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => cmp(a, b))),
      in_progress: inProgress.slice(0, IN_FLIGHT_CAP), in_progress_total: inProgress.length,
      off_board: skippedCounts, off_board_total: Object.values(skippedCounts).reduce((a, b) => a + b, 0),
    };
  }
  // Freshness: a view is stale when any artifact is newer than it. The derived
  // views themselves are excluded from "newest" — a view is always newer than
  // the stamp inside it, and one view must not make another look stale.
  const views = derivedViews(layout);
  let newest = 0;
  for (const f of walkVaultFiles(vault)) {
    if (views.includes(f.rel)) continue;
    try { newest = Math.max(newest, statSync(join(vault, f.rel)).mtimeMs); } catch {}
  }
  out.views = {};
  for (const [key, file] of [["kanban", views[0]], ["code_map", views[1]], ["graph", views[2]]]) {
    const p = join(vault, file);
    const exists = existsSync(p);
    const generatedAt = exists ? readGeneratedAt(p) : null;
    let viewMs = NaN;
    if (exists) { try { viewMs = statSync(p).mtimeMs; } catch {} }
    out.views[key] = { path: file, exists, generated_at: generatedAt, stale: exists ? (Number.isNaN(viewMs) ? null : viewMs < newest) : null };
  }
  const sessions = readActiveSessions(vault, null);
  out.sessions = { active: sessions.length, entries: sessions.slice(0, IN_FLIGHT_CAP).map((s) => ({ id: s.id ?? s.session_id ?? null, project_root: s.project_root ?? s.projectRoot ?? s.project ?? null, started_at: s.started_at ?? s.startedAt ?? null, last_active: s.last_active ?? s.lastActive ?? s.updated_at ?? null })) };
  return out;
}

export function renderStatus(r) {
  if (!r.bound) return `Not bound${r.project ? ` — ${r.project}` : ""}. Run /projectstore:bind <vault> in a session.\n`;
  const lines = [`Vault: ${r.vault_path}${r.vault_exists ? "" : "  (missing)"}`, `Layout: ${r.layout} · language: ${r.language} · auto_inject: ${r.auto_inject} · approval_mode: ${r.approval_mode} · spec_policy: ${r.spec_policy} · lifecycle_gates: ${r.lifecycle_gates}`];
  if (r.stories && r.stories.status !== "ok") lines.push(`Stories: not counted — ${r.stories.error}`);
  else if (r.stories) {
    lines.push(`Stories: ${r.stories.total} on the board — ${Object.entries(r.stories.by_status).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}${r.stories.off_board_total ? `; ${r.stories.off_board_total} off it (${Object.entries(r.stories.off_board).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
    if (r.stories.in_progress_total) {
      lines.push(`In progress (${r.stories.in_progress_total}):`);
      for (const s of r.stories.in_progress) lines.push(`  ${s.epic}: ${s.title}  — ${s.path}${s.started_at ? `  (since ${s.started_at})` : ""}`);
    } else lines.push("In progress: nothing");
  }
  if (r.views) lines.push(`Views: ${Object.entries(r.views).map(([k, v]) => `${k} ${!v.exists ? "missing" : v.stale === null ? "unknown" : v.stale ? "stale" : "fresh"}`).join(" · ")}`);
  if (r.sessions) lines.push(`Sessions active: ${r.sessions.active}`);
  return lines.join("\n") + "\n";
}

// ─── orientation ───────────────────────────────────────────────────────

// The SessionStart skeleton and the facts behind it, through the same two
// functions the hook calls. The budget is the caller's: the hook's 200 ms is
// the user's startup latency, an operator at a terminal has no such
// constraint. Folder READMEs are reduced to their purpose line before they
// enter an envelope; the whole README never leaves.
export async function orientation(cfg, { budgetMs = ORIENTATION_BUDGET_MS } = {}) {
  const facts = await gatherVaultFacts(cfg, { budgetMs });
  const skeleton = renderVaultSkeleton(facts);
  if (facts.vaultMissing) return { facts, skeleton };
  const safe = { ...facts, folders: facts.folders.map((f) => ({ path: f.path, kind: f.kind, counts: f.counts, purpose: folderPurpose(f.readme, f.kind) })) };
  return { facts: safe, skeleton };
}

// ─── search ────────────────────────────────────────────────────────────

// A deterministic, bounded substring search over the vault's markdown —
// no shell, no regex (determinism, no ReDoS, small schema). The body and the
// title line are searched; the rest of the frontmatter is not — its facts
// (type, status) are filters and columns here, and a hit on `id:` would push
// the prose a reader wanted past the per-file cap. Derived views are excluded
// unless asked for: they repeat every path in the vault.
export function search(cfg, query, { kinds = null, status: st = null, limit = SEARCH_DEFAULT_LIMIT, includeDerived = false, caseSensitive = false, deadlineMs = SEARCH_DEADLINE_MS } = {}) {
  if (typeof query !== "string" || !query.trim()) throw usageError("a query is required");
  const vault = vaultOf(cfg);
  const cap = intOption("limit", limit, { min: 1, max: SEARCH_HARD_CAP, fallback: SEARCH_DEFAULT_LIMIT });
  const needle = caseSensitive ? query : query.toLowerCase();
  const { layout } = layoutOf(cfg);
  let index = null;
  if (layout) { try { index = buildNodeIndex(cfg, layout); } catch { index = null; } }
  const views = derivedViews(layout);
  const files = walkVaultFiles(vault).filter((f) => includeDerived || !views.includes(f.rel));
  files.sort((a, b) => cmp(a.rel, b.rel));
  const all = [];
  let scanned = 0;
  let filesTruncated = 0;
  let timedOut = false;
  const deadline = Date.now() + deadlineMs;
  for (const f of files) {
    if (Date.now() > deadline) { timedOut = true; break; }
    // Synchronous reads with the deadline checked between files: a vault on
    // a local disk reads in milliseconds, and a timer per file would keep the
    // process alive after the answer is written (the MCP server lives long).
    let text;
    try { text = readFileSync(join(vault, f.rel), "utf8"); } catch { continue; }
    scanned++;
    const node = index ? index.byPath.get(f.rel) : null;
    const nf = nodeFacts(node);
    if (kinds && kinds.length && !kinds.includes(nf.type)) continue;
    if (st && nf.status !== st) continue;
    const lines = String(text).split("\n");
    // The frontmatter's line span, so its lines other than title: are skipped.
    let fmEnd = -1;
    if (lines[0] === "---") { const close = lines.indexOf("---", 1); fmEnd = close === -1 ? lines.length : close; }
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (i <= fmEnd && !/^title:/.test(lines[i])) continue;
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      const at = hay.indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - Math.floor(SNIPPET_CELL / 3));
      hits.push({ path: f.rel, line: i + 1, snippet: truncEnd(lines[i].slice(start).trim(), SNIPPET_CELL), ...nf });
    }
    if (hits.length > SEARCH_PER_FILE_CAP) filesTruncated++;
    for (const h of hits.slice(0, SEARCH_PER_FILE_CAP)) all.push({ ...h, of: hits.length });
  }
  all.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  return { query, matches: all.slice(0, cap), total: all.length, returned: Math.min(all.length, cap), truncated: all.length > cap, per_file_cap: SEARCH_PER_FILE_CAP, files_truncated: filesTruncated, files_scanned: scanned, status: timedOut ? "timeout" : "ok" };
}

export function renderSearch(r) {
  if (!r.matches.length) return `No matches for "${r.query}" in ${r.files_scanned} file(s)${r.status === "timeout" ? " (scan timed out — partial)" : ""}. Try a shorter or case-insensitive phrase.\n`;
  const groups = new Map();
  for (const m of r.matches) { const g = m.path.includes("/") ? m.path.split("/")[0] : "(root)"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
  const lines = [`${r.total} match(es) for "${r.query}"${r.truncated ? ` — showing ${r.returned}` : ""}${r.files_truncated ? ` — ${r.files_truncated} file(s) cut at ${r.per_file_cap} lines each` : ""}${r.status === "timeout" ? " (scan timed out — partial)" : ""}`];
  for (const [g, ms] of [...groups.entries()].sort(([a], [b]) => cmp(a, b))) {
    lines.push("", `${g}/ (${ms.length})`);
    for (const m of ms) lines.push(`  ${m.path}:${m.line}  ${m.snippet}${m.of > r.per_file_cap ? `   [${m.of} in file]` : ""}`);
  }
  return lines.join("\n") + "\n";
}

// ─── show ──────────────────────────────────────────────────────────────

export function show(cfg, path, { body = false, section = null } = {}) {
  const vault = vaultOf(cfg);
  const rel = toVaultRel(vault, path);
  const abs = join(vault, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw usageError(`${rel} does not exist in the vault`);
  const text = readFileSync(abs, "utf8");
  const parsed = parseFrontmatter(text);
  const fm = parsed.data;
  const out = { path: rel, type: fm.type ?? null, title: fm.title ?? null, status: fm.status ?? null, frontmatter: fm, lines: text.split("\n").length, bytes: Buffer.byteLength(text, "utf8") };
  if (body) out.body = parsed.body;
  if (section) {
    const ids = Object.keys(loadHeadingsRegistry().headings || {}).sort();
    if (!ids.includes(section)) throw usageError(`unknown section "${section}" — one of: ${ids.join(", ")}`);
    const s = sectionOf(parsed.body, section);
    out.section = { id: section, text: s === null ? null : s.trim() };
  }
  return out;
}

export function renderShow(r) {
  const lines = [`${r.path}`, `type: ${r.type ?? "—"} · title: ${r.title ?? "—"} · status: ${r.status ?? "—"} · ${r.lines} lines`];
  if (r.section) lines.push("", `## ${r.section.id}`, "", r.section.text ?? "(section not found)");
  if (r.body !== undefined) lines.push("", r.body);
  return lines.join("\n") + "\n";
}

// ─── graph: neighbors and lineage ──────────────────────────────────────

function graphOf(cfg) {
  const layout = loadLayout(cfg.layout);
  const g = buildGraph(cfg, layout);
  const index = new Map(g.nodes.map((n) => [n.path, n]));
  return { g, index };
}

export function neighbors(cfg, path, { kinds = null, direction = "both", limit = GRAPH_EDGE_CAP } = {}) {
  const vault = vaultOf(cfg);
  const rel = toVaultRel(vault, path);
  const dir = oneOf("direction", direction, DIRECTIONS, "both");
  const cap = intOption("limit", limit, { min: 1, max: GRAPH_EDGE_CAP, fallback: GRAPH_EDGE_CAP });
  const { g, index } = graphOf(cfg);
  const self = index.get(rel);
  if (!self) throw usageError(`${rel} is not a node of the graph (not an artifact the layout knows)`);
  const want = (e) => !kinds || !kinds.length || kinds.includes(e.kind);
  const out = dir === "in" ? [] : g.edges.filter((e) => e.from === rel && want(e)).map((e) => ({ kind: e.kind, to: e.to, ...prefixed(nodeFacts(index.get(e.to)), "to_") }));
  const inn = dir === "out" ? [] : g.edges.filter((e) => e.to === rel && want(e)).map((e) => ({ kind: e.kind, from: e.from, ...prefixed(nodeFacts(index.get(e.from)), "from_") }));
  out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.to, b.to));
  inn.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.from, b.from));
  const byKind = {};
  for (const e of [...out, ...inn]) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { path: rel, ...nodeFacts(self), out: out.slice(0, cap), in: inn.slice(0, cap), counts: { in: inn.length, out: out.length, by_kind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => cmp(a, b))) }, truncated: out.length > cap || inn.length > cap };
}

function prefixed(o, p) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));
}

export function renderNeighbors(r) {
  const lines = [`${r.path}  (${r.type ?? "—"} · ${r.status ?? "—"})  ${r.title ?? ""}`.trimEnd(), `out ${r.counts.out} · in ${r.counts.in}${r.truncated ? " · truncated" : ""}`];
  for (const e of r.out) lines.push(`  → ${e.kind.padEnd(19)} ${e.to}${e.to_title ? `  (${e.to_title})` : ""}`);
  for (const e of r.in) lines.push(`  ← ${e.kind.padEnd(19)} ${e.from}${e.from_title ? `  (${e.from_title})` : ""}`);
  return lines.join("\n") + "\n";
}

// The typed ancestry and descent of one artifact: supersedes, spec-covers,
// spec-implements-adr and epic-contains, both directions, breadth-first,
// depth- and node-capped, cycle-safe. Body wikilinks are deliberately not
// lineage — walking them returns most of the vault, so `kinds` is validated
// against LINEAGE_KINDS — and containment is not walked from an epic down to
// its stories unless the epic is the root.
export function lineage(cfg, path, { depth = LINEAGE_DEFAULT_DEPTH, kinds = LINEAGE_KINDS, cap = LINEAGE_NODE_CAP } = {}) {
  const vault = vaultOf(cfg);
  const rel = toVaultRel(vault, path);
  const maxDepth = intOption("depth", depth, { min: 0, max: 10, fallback: LINEAGE_DEFAULT_DEPTH });
  for (const k of kinds || []) if (!LINEAGE_KINDS.includes(k)) throw usageError(`--kind for lineage takes one of ${LINEAGE_KINDS.join(", ")}, not "${k}" (use graph neighbors for the other edge kinds)`);
  const { g, index } = graphOf(cfg);
  if (!index.has(rel)) throw usageError(`${rel} is not a node of the graph`);
  const kindSet = new Set(kinds && kinds.length ? kinds : LINEAGE_KINDS);
  const typed = g.edges.filter((e) => kindSet.has(e.kind) && index.has(e.to));
  const seen = new Map([[rel, 0]]);
  const edges = [];
  const edgeKeys = new Set();
  let frontier = [rel];
  let truncated = false;
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = [];
    for (const p of frontier) {
      for (const e of typed) {
        const other = e.from === p ? e.to : e.to === p ? e.from : null;
        if (!other) continue;
        // Containment is walked upward only, unless the root is the epic:
        // from a story, its epic is lineage; the epic's other stories are
        // siblings, and a depth of 3 would return the whole epic.
        if (e.kind === "epic-contains" && e.from === p && p !== rel) continue;
        if (!seen.has(other)) {
          if (seen.size >= cap) { truncated = true; continue; }
          seen.set(other, d);
          next.push(other);
        }
        // Recorded only once both endpoints are nodes of the result.
        const k = `${e.from} ${e.kind} ${e.to}`;
        if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push({ from: e.from, kind: e.kind, to: e.to }); }
      }
    }
    frontier = next.sort(cmp);
  }
  const nodes = [...seen.entries()].map(([p, distance]) => ({ path: p, ...nodeFacts(index.get(p)), distance })).sort((a, b) => a.distance - b.distance || cmp(a.path, b.path));
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
  return { root: rel, depth: maxDepth, kinds: [...kindSet], nodes, edges, truncated };
}

export function renderLineage(r) {
  const lines = [`${r.root} — lineage over ${r.kinds.join(", ")} to depth ${r.depth}${r.truncated ? " (truncated)" : ""}`];
  for (const n of r.nodes) lines.push(`  ${String(n.distance).padStart(2)}  ${n.path}  (${n.type ?? "—"} · ${n.status ?? "—"})${n.title ? `  ${n.title}` : ""}`);
  if (r.edges.length) { lines.push("", "edges:"); for (const e of r.edges) lines.push(`  ${e.from}  ${e.kind}  ${e.to}`); }
  return lines.join("\n") + "\n";
}

// ─── codemap --for ─────────────────────────────────────────────────────

const normRef = (r) => String(r).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

// Which code an artifact maps to, or which artifacts map to a path. The
// selector is an epic id, an artifact identity or vault path, or a
// repo-relative path; the result says which reading was taken. A tie is
// ambiguity, never a first match — as in the link resolver and doctor.
export function codeRefs(cfg, selector, { reverse = false } = {}) {
  if (typeof selector !== "string" || !selector.trim()) throw usageError("a selector is required — an epic id, an artifact, or a repo path");
  const sel = selector.trim();
  const layout = loadLayout(cfg.layout);
  const index = buildNodeIndex(cfg, layout);
  const warnings = [];
  const refsOf = (n) => {
    const refs = listOf(n.fm, "code_refs");
    if (!refs.length && typeof n.fm.code_refs === "string" && n.fm.code_refs.trim() === "") {
      warnings.push(`${n.path}: code_refs is written in block form, which the line-based frontmatter parser cannot read — write it as a JSON list`);
    }
    return refs;
  };
  const row = (n, matched) => ({ path: n.path, type: n.type, title: n.title, status: n.status, code_refs: refsOf(n), ...(matched !== undefined ? { matched } : {}) });
  const bounded = (rows) => ({ artifacts: rows.slice(0, CODE_REFS_CAP), total: rows.length, truncated: rows.length > CODE_REFS_CAP });
  const epicFolder = folderByKind(layout, "epic");
  if (!reverse) {
    // An epic by its id or its folder name — never by the stem "epic", which every epic.md shares.
    const epics = index.nodes.filter((n) => n.type === "epic" && (n.identity === sel || (epicFolder && n.path === `${epicFolder.path}/${sel}/epic.md`)));
    if (epics.length > 1) throw usageError(`"${sel}" names ${epics.length} epics: ${epics.map((n) => n.path).join(", ")}`);
    if (epics.length === 1) {
      const epicDir = epics[0].path.replace(/\/epic\.md$/, "");
      const stories = index.nodes.filter((n) => n.type === "story" && n.path.startsWith(epicDir + "/")).sort((a, b) => cmp(a.path, b.path));
      return { selector: sel, resolved_as: "epic", ...bounded([row(epics[0]), ...stories.map((n) => row(n))]), warnings };
    }
    const byPath = index.byPath.get(sel);
    const candidates = byPath ? [byPath] : [...new Set([...(index.byIdentity.get(sel.toLowerCase()) || []), ...(index.byStem.get(sel.toLowerCase()) || [])])];
    if (candidates.length > 1) throw usageError(`"${sel}" is ambiguous — ${candidates.map((n) => n.path).sort(cmp).join(", ")}; pass the vault path`);
    if (candidates.length === 1) return { selector: sel, resolved_as: "artifact", ...bounded([row(candidates[0])]), warnings };
  }
  const target = normRef(sel);
  const covering = index.nodes.map((n) => {
    // A ref covers the selector when they are equal, or one is a directory
    // prefix of the other ("scripts/" covers "scripts/cli.mjs"; asking about
    // "scripts/" lists whoever names a file under it). Reported as written.
    const matched = refsOf(n).filter((ref) => { const r = normRef(ref); return r === target || target.startsWith(r + "/") || r.startsWith(target + "/"); });
    return matched.length ? row(n, matched) : null;
  }).filter(Boolean).sort((a, b) => cmp(a.path, b.path));
  return { selector: sel, resolved_as: "path", ...bounded(covering), warnings };
}

export function renderCodeRefs(r) {
  const lines = [`${r.selector}  (read as ${r.resolved_as})${r.truncated ? ` — ${r.artifacts.length} of ${r.total}` : ""}`];
  if (!r.artifacts.length) lines.push("  nothing maps here");
  for (const a of r.artifacts) lines.push(`  ${a.path}  (${a.type ?? "—"} · ${a.status ?? "—"})`, `    ${a.code_refs.length ? a.code_refs.join(", ") : "—"}${a.matched ? `   ← ${a.matched.join(", ")}` : ""}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n") + "\n";
}

// ─── the table the MCP surface derives its tools from ──────────────────

export const READ_OPERATIONS = Object.freeze({
  status: { fn: status, render: renderStatus, async: false },
  orientation: { fn: orientation, render: (r) => r.skeleton + (r.skeleton.endsWith("\n") ? "" : "\n"), async: true },
  search: { fn: search, render: renderSearch, async: false },
  show: { fn: show, render: renderShow, async: false },
  neighbors: { fn: neighbors, render: renderNeighbors, async: false },
  lineage: { fn: lineage, render: renderLineage, async: false },
  codeRefs: { fn: codeRefs, render: renderCodeRefs, async: false },
});

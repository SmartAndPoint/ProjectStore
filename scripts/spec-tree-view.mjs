#!/usr/bin/env node
// projectstore — spec-tree-view.mjs: spec-tree.md, the view of the spec trees.
//
// A derived view at the vault root, beside kanban.md, code-map.md and
// graph.md (the spec "The spec tree: a parent link on a spec, the
// spec-part-of edge, the tree checks, the spec-tree view and the orientation
// line", contracts 7 to 9). Per tree in root path order: a heading with the
// root's title, a Mermaid flowchart, and a nested list of the tree's specs
// with each one's status, ADRs, covering stories, code_refs and the
// parent-behind flags of the spec staleness spec. Then the cycles.
//
// The view is a function of the vault alone: no git, and the parent-behind
// flags read with a fixed far clock, so neither a commit nor the date
// changes it. A marker dated after tomorrow therefore counts here and not in
// doctor's spec-stale-parent, which reads the real clock.
//
// Its own module, not spec-tree.mjs: the view needs spec-code.mjs and
// spec-stale.mjs, which import spec-tree.mjs.
//
// Output: JSON { path, content, stats }, compute only, as codemap.mjs. The
// applier is reconcile.mjs --write.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  loadLayout,
  folderByKind,
  listOf,
  nowIso,
  buildNodeIndex,
  resolveLinkTarget,
  isMain,
  commandForm,
} from "./lib.mjs";
import { packageCommand } from "./harness.mjs";
import { SPEC_TREE_FILE, truncEnd } from "./skeleton.mjs";
import { resolveSpecParents, analyseSpecTree } from "./spec-tree.mjs";
import { coveringStories } from "./spec-code.mjs";
import { parentBehind } from "./spec-stale.mjs";

export { SPEC_TREE_FILE };

// parentBehind reads `now` only for "after tomorrow"; 9999-12-31 would make
// tomorrow overflow the date range.
const FAR_NOW = "9999-12-30T00:00:00.000Z";

// The command that creates and rebuilds the view, for doctor's messages.
export const SPEC_TREE_COMMAND = packageCommand([], "reconcile", { args: "--write --only spectree" });

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A Mermaid label: in double quotes, `"` as `#quot;`.
const label = (s) => `"${String(s).replace(/"/g, "#quot;")}"`;
// A markdown link from the vault root: `[` and `]` escaped in the text, the
// path encoded per segment, parentheses included.
const linkText = (s) => String(s).replace(/([\\[\]])/g, "\\$1");
const linkPath = (p) =>
  String(p)
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
const link = (title, path) => `[${linkText(title)}](${linkPath(path)})`;
// An ADR is named by its title, cut to ADR_CELL with `…`, after its number
// when its id is a numbered one (`ADR-007: Spec-first…`): a slug id is a
// filename, not something a person reads.
const ADR_CELL = 60;
const adrText = (node) => {
  const title = node.title || node.identity || node.stem;
  const id = node.identity || "";
  return truncEnd(/^ADR-\d+$/.test(id) && title !== id ? `${id}: ${title}` : title, ADR_CELL);
};

// The view. `index` is buildNodeIndex's result, `tree` analyseSpecTree's,
// `files` the vault's .md walk, `keyPath(key)` the spec path a citation key
// names and `resolveStory(ref)` doctor's story resolver, as doctor passes
// them to checkParentStale.
export function buildSpecTreeView(index, tree, { layout, files, keyPath, resolveStory, generatedAt = nowIso() }) {
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const titleOf = (p) => nodeOf.get(p)?.title ?? p;
  const covers = coveringStories(index, layout);
  const behind = parentBehind(index, tree, { layout, now: FAR_NOW, resolveStory, keyPath, files });
  const adrCtx = { index, files, kinds: ["adr"] };
  const adrsOf = (p) =>
    listOf(nodeOf.get(p)?.fm || {}, "adr").map((entry) => {
      adrCtx.sourceRel = p;
      const r = resolveLinkTarget(entry, "ref", adrCtx);
      return r.outcome === "node" ? link(adrText(r.node), r.node.path) : `\`${entry}\``;
    });

  const item = (p) => {
    const n = nodeOf.get(p);
    const adrs = adrsOf(p);
    const refs = listOf(n?.fm || {}, "code_refs");
    const parts = [
      link(titleOf(p), p),
      `status: ${n?.status ?? "-"}`,
      `ADRs: ${adrs.length ? adrs.join(", ") : "none"}`,
      `stories: ${(covers.get(p) || []).length}`,
      `code_refs: ${refs.length ? refs.map((r) => `\`${r}\``).join(", ") : "none"}`,
    ];
    for (const s of behind.stale.filter((x) => x.parent === p))
      parts.push(`spec-stale-parent: cites ${s.token}, amended in ${s.child} on ${s.day}`);
    for (const u of behind.unlinked.filter((x) => x.parent === p))
      parts.push(`spec-child-unlinked: ${u.child}, dated ${u.date}, neither linked nor cited`);
    return parts.join(" · ");
  };

  let largest = null;
  for (const t of tree.trees) if (!largest || t.paths.length > largest.paths.length) largest = t;
  const specs = tree.trees.reduce((a, t) => a + t.paths.length, 0);
  const depth = tree.trees.reduce((a, t) => Math.max(a, t.depth), 0);

  const lines = [
    "---",
    "",
    "projectstore: derived",
    `generated_at: ${generatedAt}`,
    `trees: ${tree.trees.length}`,
    `specs: ${specs}`,
    `depth: ${depth}`,
    `largest_root: ${largest ? JSON.stringify(largest.title) : "null"}`,
    "",
    "---",
    "",
    "# Spec tree",
    "",
    "Each tree below is drawn from the specs' `parent:` links: its root is the spec with no parent (an app's" +
      " overview), a component has a parent and children, and a leaf has a parent and no child.",
    `To read one tree from its root down, run \`${packageCommand([], "graph", {
      args: "lineage <root path> --kind spec-part-of --depth <n>",
    })}\`; this page is rebuilt by \`reconcile\`, so change the specs, not this file.`,
    "",
    "A flag after a spec, `spec-stale-parent` or `spec-child-unlinked`, is a doctor finding; `doctor` gives its" +
      " full message and what to change.",
    "",
  ];
  if (!tree.trees.length) lines.push("No spec tree yet: no spec's `parent:` names another spec.", "");

  for (const t of tree.trees) {
    const ids = new Map(t.paths.map((p, i) => [p, `n${i + 1}`]));
    const walk = packageCommand([], "graph", { args: `lineage ${t.root} --kind spec-part-of --depth ${t.depth}` });
    lines.push(`## ${titleOf(t.root)}`, "", `Walk it: \`${walk}\``, "", "```mermaid", "flowchart TD");
    for (const p of t.paths) lines.push(`  ${ids.get(p)}[${label(titleOf(p))}]`);
    for (const p of t.paths)
      for (const c of tree.children.get(p) || []) lines.push(`  ${ids.get(p)} --> ${ids.get(c)}`);
    lines.push("```", "");
    const visit = (p, d) => {
      lines.push(`${"  ".repeat(d)}- ${item(p)}`);
      for (const c of tree.children.get(p) || []) visit(c, d + 1);
    };
    visit(t.root, 0);
    lines.push("");
  }

  // Each cycle with the specs whose upward chain reaches it.
  lines.push("## Cycles", "");
  if (!tree.cycles.length) lines.push("None: no spec's parent chain comes back to itself.", "");
  const cycleOf = new Map();
  tree.cycles.forEach((members, i) => members.forEach((m) => cycleOf.set(m, i)));
  const below = tree.cycles.map(() => []);
  for (const p of tree.belowCycles) {
    const seen = new Set();
    let cur = p;
    while (cur && !cycleOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = tree.parent.get(cur);
    }
    if (cycleOf.has(cur)) below[cycleOf.get(cur)].push(p);
  }
  tree.cycles.forEach((members, i) => {
    const reach = below[i].sort(byPath);
    lines.push(
      `- ${members.map((m) => link(titleOf(m), m)).join(", ")}: a cycle of parent: links, so in no tree; clear \`parent:\` in one of them to break it.` +
        (reach.length ? ` Below it: ${reach.map((m) => link(titleOf(m), m)).join(", ")}.` : ""),
    );
  });
  if (tree.cycles.length) lines.push("");

  return {
    content: lines.join("\n"),
    stats: { trees: tree.trees.length, specs, depth, cycles: tree.cycles.length },
  };
}

// The text spec-tree.md is compared by: the generated_at line aside, as
// reconcile and doctor compare every derived view.
const normalize = (s) =>
  String(s)
    .split("\n")
    .filter((l) => !l.startsWith("generated_at:"))
    .join("\n")
    .trimEnd();

// Doctor's check (contract 9). Silent with no file and no tree; one info
// naming the command when a tree has no file; one issue when the file
// differs from a fresh build. `build()` gives the fresh content, called only
// when the file is there; `finding(level, check, message, file)`.
export function checkSpecTreeView({ vault, hasTree, build, finding, where }) {
  const p = join(vault, SPEC_TREE_FILE);
  if (!existsSync(p)) {
    if (!hasTree) return [];
    return [
      finding(
        "info",
        "spec-tree",
        `The vault has a spec tree and no ${SPEC_TREE_FILE} to show it. Create the view ${where}:\n${SPEC_TREE_COMMAND}`,
      ),
    ];
  }
  let disk;
  try {
    disk = readFileSync(p, "utf8");
  } catch (e) {
    return [
      finding(
        "warn",
        "spec-tree",
        `${SPEC_TREE_FILE} could not be read (${e.message}). Check its permissions, or delete it and rebuild it ${where}:\n${SPEC_TREE_COMMAND}`,
        SPEC_TREE_FILE,
      ),
    ];
  }
  if (normalize(build()) === normalize(disk)) return [];
  return [
    finding(
      "issue",
      "spec-tree",
      `${SPEC_TREE_FILE} is stale: the specs changed after it was built. Rebuild it ${where}:\n${SPEC_TREE_COMMAND}`,
      SPEC_TREE_FILE,
    ),
  ];
}

function die(msg) {
  process.stderr.write(`projectstore/spec-tree-view: ${msg}\n`);
  process.exit(1);
}

// The view for a bound project, with doctor's own resolvers, so the bytes
// reconcile writes are the bytes doctor compares against.
export async function specTreeViewOf(cfg, layout = loadLayout(cfg.layout)) {
  const { walkVaultFiles, scanArtifacts, citationKeys, resolveSpecStory } = await import("./doctor.mjs");
  const index = buildNodeIndex(cfg, layout);
  const files = walkVaultFiles(cfg.vault_path);
  const tree = analyseSpecTree(index, resolveSpecParents(index, files));
  const artifacts = scanArtifacts(cfg, layout);
  const keys = citationKeys(artifacts);
  const epics = folderByKind(layout, "epic")?.path ?? "epics";
  return buildSpecTreeView(index, tree, {
    layout,
    files,
    keyPath: (k) => keys.get(k)?.rel ?? null,
    resolveStory: (ref) => resolveSpecStory(ref, artifacts, epics),
  });
}

async function main() {
  const cfg = readConfig();
  if (!cfg) die(`No projectstore config. Run ${commandForm("bind")} first.`);
  const v = await specTreeViewOf(cfg);
  process.stdout.write(
    JSON.stringify({ path: join(cfg.vault_path, SPEC_TREE_FILE), content: v.content, stats: v.stats }, null, 2) + "\n",
  );
}

// Not awaited at the top level: doctor.mjs, which main imports, imports this
// module, and would wait on its evaluation forever.
if (isMain(import.meta.url)) main().catch((e) => die(e.message));

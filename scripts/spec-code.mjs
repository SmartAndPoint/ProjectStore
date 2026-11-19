#!/usr/bin/env node
// projectstore — spec-code.mjs: the code a spec in a tree owns.
//
// A spec in a spec tree may name the code it describes with `code_refs:`,
// as a story does (the spec "Spec-owned code: a spec's code_refs, ownership
// by file, and a story's specs following its files", contracts 1 to 4 and 7).
// A file's owners are the participating specs, active and in a tree, with a
// ref that covers it; its deepest owners are the most detailed of them. This
// module computes ownership and gives doctor four checks: a child's ref
// outside its parent's files, a ref that covers nothing, files only a root
// describes, and one info when git cannot list the files.
//
//   node scripts/spec-code.mjs owners <path>… [--project <dir>]
//
// prints, as JSON, each path's owners and deepest owners, so a person or the
// planner can ask before writing code. It reads the vault only, no git.
//
// It imports lib, code-refs, diff-refs, spec-tree and status-log, never
// doctor.mjs or graph.mjs, so doctor can import it.

import { join, relative, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  buildNodeIndex,
  loadLayout,
  folderByKind,
  listOf,
  resolveLinkTarget,
  storyMatchesEntry,
  isSourcePath,
  readConfigAt,
  projectRoot,
  isMain,
  commandForm,
} from "./lib.mjs";
import { refCovers } from "./code-refs.mjs";
import { trackedFiles } from "./diff-refs.mjs";
import { resolveSpecParents, analyseSpecTree } from "./spec-tree.mjs";
import { sameStatus } from "./status-log.mjs";

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The finding levels of this module's checks.
export const SPEC_CODE_LEVELS = Object.freeze({
  "spec-tree-git": "info",
  "spec-code-outside-parent": "warn",
  "spec-code-empty": "warn",
  "spec-undescribed": "info",
});

// Why git could not list the files, for a person.
const GIT_REASONS = Object.freeze({
  "no-git": "git is not installed",
  "not-a-repository": "the project is not a git repository",
  timeout: "git did not answer in time",
  failed: "git failed",
});

// The vault's .md files as the resolver's file list, from the node index.
const filesOf = (index) => index.nodes.map((n) => ({ rel: n.path, name: n.path.split("/").pop() }));

// The spec tree for a bound project, from the vault alone.
export function specTreeOf(cfg, layout = loadLayout(cfg.layout)) {
  const index = buildNodeIndex(cfg, layout);
  const links = resolveSpecParents(index, filesOf(index));
  return { index, layout, tree: analyseSpecTree(index, links) };
}

// The stories that cover each spec, from both sides, as graph.md draws
// `spec-covers`: a spec's `stories:` entry `<EPIC>/<story>`, and a story whose
// `specs:` resolves to the spec. Map spec path → story nodes.
export function coveringStories(index, layout) {
  const epics = folderByKind(layout, "epic")?.path ?? null;
  const stories = index.nodes.filter((n) => n.type === "story");
  const out = new Map();
  const add = (spec, story) => {
    if (!out.has(spec)) out.set(spec, new Map());
    out.get(spec).set(story.path, story);
  };
  for (const s of index.nodes.filter((n) => n.type === "spec")) {
    for (const entry of listOf(s.fm, "stories")) {
      const m = String(entry).match(/^([^/]+)\/(.+)$/);
      if (!m || !epics) continue;
      let best = 0;
      let hits = [];
      for (const n of stories) {
        if (!n.path.startsWith(`${epics}/${m[1]}/`)) continue;
        const tier = storyMatchesEntry(m[2], { id: n.identity, stem: n.stem });
        if (!tier) continue;
        if (best === 0 || tier < best) {
          best = tier;
          hits = [n];
        } else if (tier === best) hits.push(n);
      }
      if (hits.length === 1) add(s.path, hits[0]);
    }
  }
  const ctx = { index, files: filesOf(index), kinds: ["spec"] };
  for (const n of stories) {
    ctx.sourceRel = n.path;
    for (const entry of listOf(n.fm, "specs")) {
      const r = resolveLinkTarget(entry, "ref", ctx);
      if (r.outcome === "node") add(r.node.path, n);
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v.values()]]));
}

// Whether a spec covers a story in progress or in review, from
// coveringStories' map: its code may not be committed yet.
export const specInFlight = (covers) => (spec) =>
  (covers.get(spec) || []).some((s) => sameStatus(s.status, "in-progress") || sameStatus(s.status, "review"));

// Ownership over a tree (contracts 1 and 2). `files()` lists the project's
// tracked files once, the vault left out, or {reason} when git cannot.
export function specOwnership(index, tree, { proj, vault, lsFiles = trackedFiles } = {}) {
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const inTree = new Set(tree.trees.flatMap((t) => t.paths));
  const roots = new Set(tree.trees.map((t) => t.root));
  const participating = [...inTree].filter((p) => sameStatus(nodeOf.get(p)?.status, "active")).sort(byPath);
  const refsOf = new Map(participating.map((p) => [p, listOf(nodeOf.get(p).fm, "code_refs")]));
  const isAncestor = (a, b) => {
    for (let cur = tree.parent.get(b); cur; cur = tree.parent.get(cur)) if (cur === a) return true;
    return false;
  };
  const ownersOf = (path) => participating.filter((p) => refsOf.get(p).some((r) => refCovers(r, path)));
  const deepestOf = (owners) => owners.filter((o) => !owners.some((x) => x !== o && isAncestor(o, x)));
  let listed = null;
  const files = () => {
    if (listed) return listed;
    const r = lsFiles(proj);
    if (r.status !== "ok") return (listed = { reason: r.reason || "failed" });
    const rel = vault && proj ? relative(resolve(proj), resolve(vault)) : "";
    const inside = rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    const list = inside ? r.files.filter((f) => f !== rel && !f.startsWith(`${rel}/`)) : r.files;
    return (listed = { files: [...list].sort(byPath) });
  };
  return {
    participating,
    refsOf,
    roots,
    hasRefs: participating.some((p) => refsOf.get(p).length),
    ownersOf,
    deepestOf,
    files,
    isRoot: (p) => roots.has(p),
  };
}

// Doctor's checks (contracts 1 to 4). `finding(level, check, message, file,
// extra)` builds one finding. While the vault has no tree, or no
// participating spec has `code_refs`, nothing runs and git is not started.
export function checkSpecCode(index, tree, { layout, proj, vault, lsFiles = trackedFiles, finding }) {
  if (!tree.hasTree) return [];
  const own = specOwnership(index, tree, { proj, vault, lsFiles });
  if (!own.hasRefs) return [];
  const level = (check) => SPEC_CODE_LEVELS[check];
  const listed = own.files();
  if (listed.reason) {
    const why = GIT_REASONS[listed.reason] || GIT_REASONS.failed;
    const named = own.participating.filter((p) => own.refsOf.get(p).length);
    const shown = named.slice(0, 3).join(", ") + (named.length > 3 ? `, and ${named.length - 3} more` : "");
    return [
      finding(
        level("spec-tree-git"),
        "spec-tree-git",
        `Specs in a spec tree name code with code_refs (${shown}), but ${why} (${listed.reason}), so which spec owns which file is not checked. The ownership checks run once the project is a git checkout.`,
        null,
        { reason: GIT_REASONS[listed.reason] ? listed.reason : "failed" },
      ),
    ];
  }
  const files = listed.files;
  const out = [];
  const inFlight = specInFlight(coveringStories(index, layout));

  for (const spec of own.participating) {
    const refs = own.refsOf.get(spec);
    if (!refs.length) continue;
    const parent = tree.parent.get(spec);
    const parentRefs = parent && own.participating.includes(parent) ? own.refsOf.get(parent) : [];
    for (const ref of refs) {
      const covered = files.filter((f) => refCovers(ref, f));
      if (!covered.length) {
        if (!inFlight(spec)) {
          out.push(
            finding(
              level("spec-code-empty"),
              "spec-code-empty",
              `Spec ${spec} has the code ref "${ref}", which covers no file tracked in the project's git repository. Fix the ref, or drop it from code_refs.`,
              spec,
            ),
          );
        }
        continue;
      }
      if (!parentRefs.length) continue;
      const outside = covered.filter((f) => !parentRefs.some((r) => refCovers(r, f)));
      if (outside.length) {
        const more = outside.length > 5 ? `, and ${outside.length - 5} more` : "";
        out.push(
          finding(
            level("spec-code-outside-parent"),
            "spec-code-outside-parent",
            `Spec ${spec} has the code ref "${ref}", which covers ${outside.length} file${outside.length === 1 ? "" : "s"} its parent ${parent} does not: ${outside.slice(0, 5).join(", ")}${more}. Narrow the ref, or widen the parent's code_refs.`,
            spec,
          ),
        );
      }
    }
  }

  const undescribed = [];
  const owningRoots = new Set();
  for (const f of files) {
    const owners = own.ownersOf(f);
    if (!owners.length || !owners.every((o) => own.isRoot(o))) continue;
    // The vault is already out of `files`, so no disk walk per file here.
    if (!isSourcePath(join(proj, f), proj, null)) continue;
    undescribed.push(f);
    for (const o of owners) owningRoots.add(o);
  }
  if (undescribed.length) {
    const more = undescribed.length > 10 ? `, and ${undescribed.length - 10} more` : "";
    const roots = [...owningRoots].sort(byPath).join(", ");
    out.push(
      finding(
        level("spec-undescribed"),
        "spec-undescribed",
        `${undescribed.length} source file${undescribed.length === 1 ? " is" : "s are"} described only by the root spec${owningRoots.size === 1 ? "" : "s"} ${roots}: ${undescribed.slice(0, 10).join(", ")}${more}. A deeper spec with parent: and code_refs would describe ${undescribed.length === 1 ? "it" : "them"}.`,
        null,
        { files: undescribed },
      ),
    );
  }
  return out;
}

// What `owners` prints (contract 7): each path's owners and deepest owners.
export function ownersReport(cfg, paths, proj = null) {
  const { index, tree } = specTreeOf(cfg);
  // A path is read relative to the project root; an absolute one under it is
  // made relative, and `./` is dropped.
  const asRel = (p) => {
    const abs = isAbsolute(p) && proj ? relative(resolve(proj), p) : p;
    return String(abs).replace(/^\.\//, "");
  };
  paths = paths.map(asRel);
  const own = specOwnership(index, tree, {});
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const describe = (p) => ({ spec: p, id: nodeOf.get(p)?.identity ?? null, title: nodeOf.get(p)?.title ?? null });
  return {
    tree: tree.hasTree,
    paths: paths.map((path) => {
      const owners = own.ownersOf(path);
      return { path, owners: owners.map(describe), deepest: own.deepestOf(owners).map(describe) };
    }),
  };
}

function die(msg) {
  process.stderr.write(`projectstore/spec-code: ${msg}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let project = null;
  const paths = [];
  const mode = args.shift();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") {
      project = args[++i];
      if (!project) die("--project expects a directory");
    } else if (args[i].startsWith("--")) die(`unknown argument: ${args[i]}`);
    else paths.push(args[i]);
  }
  if (mode !== "owners" || !paths.length)
    die("usage: spec-code.mjs owners <path>… [--project <dir>], each path relative to the project root");
  const proj = resolve(project || projectRoot());
  const cfg = readConfigAt(proj);
  if (!cfg || !cfg.vault_path) die(`No projectstore config. Run ${commandForm("bind")} first.`);
  if (!existsSync(cfg.vault_path)) die(`The bound vault is not there: ${cfg.vault_path}`);
  process.stdout.write(JSON.stringify(ownersReport(cfg, paths, proj)) + "\n");
}

if (isMain(import.meta.url)) main();

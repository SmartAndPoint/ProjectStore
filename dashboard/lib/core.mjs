// The bridge to the ProjectStore core.
//
// The page holds no data and no rules of its own where the core has them: it
// reads the vault through the core's readers, imported from the core root the
// launcher names (`--core <root>`). Nothing here writes, spawns or keeps
// state between calls: openCore() returns a context object, and every reader
// in state.mjs and related.mjs takes it as its first argument.
//
// The core's modules this file imports, and no other (the spec "The dashboard
// package and its launcher…", Modules & files on disk): lib, stages,
// flow-stories, flow-policy, flow-counts, graph and binding. Layouts are read
// from `core` by name. The core's other in-process reads (the headings
// registry) find their root as the core always does: the harness's plugin-root
// variable when the launcher's environment sets it, else the core these
// modules were imported from.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OWN_PACKAGE = new URL("../package.json", import.meta.url);
const CORE_MODULES = ["lib.mjs", "stages.mjs", "flow-stories.mjs", "flow-policy.mjs", "flow-counts.mjs", "graph.mjs", "binding.mjs"];

function versionAt(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The core at `core`, bound to the project at `project`, ready to read.
// Throws, with a message a person can act on, when the versions differ (before
// any core module is imported), when the project has no binding, or when the
// vault it names is not there.
export async function openCore({ core, project } = {}) {
  if (!core) throw new Error("no core root given: pass --core <the projectstore checkout or package>");
  if (!project) throw new Error("no project given: pass --project <a project bound to a vault>");
  const root = resolve(String(core));
  const dir = resolve(String(project));

  // One version: the page ships with the core that reads for it.
  const mine = versionAt(OWN_PACKAGE);
  const theirs = versionAt(join(root, "package.json"));
  if (theirs === null) throw new Error(`no projectstore core at ${root}: its package.json cannot be read`);
  if (mine !== theirs)
    throw new Error(`version mismatch: the core at ${root} is ${theirs}, the dashboard is ${mine ?? "unknown"}. The two ship together; run the dashboard of that core.`);

  const load = (name) => import(pathToFileURL(join(root, "scripts", name)).href);
  const [lib, stages, flowStories, flowPolicy, flowCounts, graph, binding] = await Promise.all(CORE_MODULES.map(load));

  const bound = lib.readConfigAt(dir);
  if (!bound || typeof bound !== "object") throw new Error(`${dir} is not bound to a vault: it has no readable .projectstore/projectstore.json. Bind it first (projectstore bind <vault>).`);
  const norm = binding.normaliseVaultPath(bound.vault_path, dir);
  if (typeof norm !== "string") throw new Error(`the binding of ${dir} names no usable vault path${norm && norm.error ? ` (${norm.error})` : ""}`);
  if (!existsSync(norm) || !isDir(norm)) throw new Error(`the binding of ${dir} names a vault that is not there: ${norm}`);

  const cfg = { ...bound, vault_path: norm };
  const layout = lib.loadLayout(cfg.layout || binding.DEFAULT_LAYOUT || "engineering", root);
  return {
    root,
    version: theirs,
    project: dir,
    cfg,
    vault: norm,
    layout,
    lib,
    stages,
    flowStories,
    flowCounts,
    flowPolicy,
    graph,
  };
}

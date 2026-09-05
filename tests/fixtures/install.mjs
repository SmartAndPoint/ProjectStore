// projectstore — test fixtures: a fake plugin install under a fake Claude home.
//
// fakeInstall(home, version) — the four-file form tests/install.test.mjs used
// in-process (moved here unchanged); { full: true } copies the runnable tree
// (scripts, bin, hooks, commands, agents, skills, templates, scaffold,
// harnesses, .claude-plugin, .mcp.json, package.json) so the bin and the
// hooks can be SPAWNED from a path isPluginCacheRoot() accepts — the shape a
// marketplace user's install has, which the repo's own bin can never be
// (cli.mjs pins PACKAGE_ROOT to the repo). cpSync, not symlinks: ESM realpaths
// module URLs, and a symlinked bin/ would resolve ../scripts back into the
// repo. writeRegistry(home, entries) — installed_plugins.json in the shape
// lib.installedPluginEntries reads.

import { mkdirSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHarness } from "../../scripts/harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = sourceHarness();

export function cacheRoot(home, version) {
  return join(home, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", version);
}

export function fakeInstall(home, version, { full = false } = {}) {
  const root = cacheRoot(home, version);
  if (full) {
    cpSync(REPO, root, {
      recursive: true,
      filter: (src) => {
        const rel = relative(REPO, src);
        return rel === "" || !/^(\.git|node_modules|tests|docs|\.omc|\.claude|\.github|packaging|scratch)(\/|$)/.test(rel);
      },
    });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version }));
    return root;
  }
  for (const d of ["scripts", ".claude-plugin", "templates", join("scaffold", "layouts")]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(REPO, "scripts", "statusline-launcher.mjs"), join(root, "scripts", "statusline-launcher.mjs"));
  writeFileSync(join(root, "scripts", "statusline.mjs"), `process.stdout.write("rendered-by-${version}\\n");\n`);
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version }));
  copyFileSync(join(REPO, "templates", "claude-md-block.md.tmpl"), join(root, "templates", "claude-md-block.md.tmpl"));
  copyFileSync(join(REPO, "scaffold", "layouts", "engineering.json"), join(root, "scaffold", "layouts", "engineering.json"));
  return root;
}

export function writeRegistry(home, entries) {
  const dir = join(home, SRC.runtime.home_default, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "projectstore@SmartAndPoint": entries } }));
}

// The environment a spawn from the fake install needs: the fake home, the
// plugin root and the project directory, under the manifest's variable names —
// never literals. PROJECTSTORE_PROJECT_DIR is dropped so the harness variable
// is what resolves the project, as in a real session.
export function installEnv(home, root, proj, extra = {}) {
  const env = { ...process.env, HOME: home, [SRC.runtime.home_env]: join(home, SRC.runtime.home_default), [SRC.runtime.plugin_root_env]: root, [SRC.runtime.project_dir_env]: proj, ...extra };
  delete env.PROJECTSTORE_PROJECT_DIR;
  return env;
}

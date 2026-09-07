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

import { mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHarness } from "../../scripts/harness.mjs";
import { copyPackageTree, layoutPaths, renderAgentsBlock } from "../../scripts/lib.mjs";
import { seedCliVault } from "./vault.mjs";

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
  // The suite may run inside a live session; a spawned install must not defer
  // its migration or registration because the developer's shell says so.
  for (const k of SRC.runtime.session_env || []) if (!(k in extra)) delete env[k];
  return env;
}

// An environment with no host CLI on PATH and no live session marker: what a
// test passes to plan()/apply() so the developer's real `claude` — and the
// Claude Code session the suite may be running inside — never enters a plan.
export function noHostEnv(extra = {}) {
  const env = { ...process.env, PATH: "" };
  for (const k of [...(SRC.runtime.detect_env || []), ...(SRC.runtime.session_env || [])]) delete env[k];
  delete env[SRC.runtime.home_env];
  return { ...env, ...extra };
}

// fakeClaude(dir) — a stand-in for the host's CLI on a temp PATH: a node script
// named like the manifest's cli.bin that logs every call (argv, cwd, the pinned
// home) to <dir>/calls.jsonl and edits the sandbox's registry and settings in
// the shapes measured on claude 2.1.261 (2026-09-05, --scope local): marketplace
// add/update/remove, plugin validate/install/update/uninstall/disable/enable.
// FAKE_CLAUDE_FAIL=<subcommand> makes that subcommand exit 1 with a message.
// Returns { bin, env(extra) → an environment whose PATH is only this dir, log() }.
export function fakeClaude(dir) {
  const surface = SRC.surfaces.plugin;
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, surface.cli.bin);
  const script = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2);
const home = process.env[${JSON.stringify(SRC.runtime.home_env)}];
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), home }) + "\\n");
if (!home) { process.stderr.write("fake claude: no pinned home\\n"); process.exit(9); }
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const write = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\\n"); };
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const scope = flag("--scope") || "user";
const local = path.join(process.cwd(), ${JSON.stringify(SRC.runtime.harness_dir)}, scope === "local" ? "settings.local.json" : scope === "project" ? "settings.json" : "settings.json");
const settingsPath = scope === "user" ? path.join(home, "settings.json") : local;
const known = path.join(home, "plugins", "known_marketplaces.json"), installed = path.join(home, "plugins", "installed_plugins.json");
const sub = argv[0] === "plugin" ? (argv[1] === "marketplace" ? "marketplace_" + argv[2] : argv[1]) : argv[0];
if (process.env.FAKE_CLAUDE_FAIL === sub) { process.stderr.write("fake claude: " + sub + " failed as instructed\\n"); process.exit(1); }
const now = new Date().toISOString();
const catalogue = (mpDir) => read(path.join(mpDir, ".claude-plugin", "marketplace.json"));
const projectPath = process.cwd();
const mpDirOf = (name) => (read(known) || {})[name]?.installLocation || null;
const settings = () => read(settingsPath) || {};
if (sub === "validate") { const c = catalogue(argv[2]); if (!c || !Array.isArray(c.plugins)) { process.stderr.write("invalid marketplace\\n"); process.exit(1); } process.stdout.write("⚠ projectstore: Unknown field 'projectstore'. Claude Code ignores it at load time.\\n✔ valid\\n"); process.exit(0); }
if (sub === "marketplace_add") {
  const mpDir = path.resolve(argv[3]); const c = catalogue(mpDir); if (!c) { process.stderr.write("no marketplace at " + mpDir + "\\n"); process.exit(1); }
  const k = read(known) || {}; k[c.name] = { source: { source: "directory", path: mpDir }, installLocation: mpDir, lastUpdated: now }; write(known, k);
  const s = settings(); s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces || {}), [c.name]: { source: { source: "directory", path: mpDir } } }; write(settingsPath, s);
  process.exit(0);
}
if (sub === "marketplace_update") { const k = read(known) || {}; if (!k[argv[3]]) process.exit(1); k[argv[3]].lastUpdated = now; write(known, k); process.exit(0); }
if (sub === "marketplace_remove") {
  // Measured: empties the marketplace from the registry AND every project's rows for it.
  const name = argv[3]; const k = read(known) || {}; delete k[name]; write(known, k);
  const reg = read(installed) || { version: 2, plugins: {} }; for (const key of Object.keys(reg.plugins)) if (key.endsWith("@" + name)) delete reg.plugins[key]; write(installed, reg);
  const s = settings(); if (s.extraKnownMarketplaces) delete s.extraKnownMarketplaces[name]; if (s.enabledPlugins) for (const key of Object.keys(s.enabledPlugins)) if (key.endsWith("@" + name)) delete s.enabledPlugins[key]; write(settingsPath, s);
  process.exit(0);
}
const id = argv[2]; const [pluginName, mpName] = String(id || "").split("@");
const rowMatches = (r) => scope === "user" ? r.scope === "user" : r.scope === scope && r.projectPath === projectPath;
if (sub === "install" || sub === "update") {
  const mpDir = mpDirOf(mpName); if (!mpDir) { process.stderr.write("Marketplace " + mpName + " not found\\n"); process.exit(1); }
  const c = catalogue(mpDir); const entry = (c.plugins || []).find((p) => p.name === pluginName); if (!entry) { process.stderr.write("Plugin " + pluginName + " not in marketplace\\n"); process.exit(1); }
  const src = path.resolve(mpDir, entry.source); const pj = read(path.join(src, ".claude-plugin", "plugin.json")); const version = (pj && pj.version) || entry.version;
  const installPath = path.join(home, "plugins", "cache", mpName, pluginName, version);
  const reg = read(installed) || { version: 2, plugins: {} }; const rows = reg.plugins[id] || [];
  const mine = rows.find(rowMatches);
  if (sub === "update" && !mine) { process.stderr.write('Plugin "' + pluginName + '" is not installed at scope ' + scope + "\\n"); process.exit(1); }
  if (sub === "install" && mine && fs.existsSync(mine.installPath)) { process.stdout.write("already installed\\n"); process.exit(0); }
  fs.rmSync(installPath, { recursive: true, force: true }); fs.cpSync(src, installPath, { recursive: true });
  if (mine) { mine.installPath = installPath; mine.version = version; mine.lastUpdated = now; }
  else rows.push({ scope, installPath, version, installedAt: now, lastUpdated: now, ...(scope === "user" ? {} : { projectPath }) });
  reg.plugins[id] = rows; write(installed, reg);
  const s = settings(); s.enabledPlugins = { ...(s.enabledPlugins || {}), [id]: true }; write(settingsPath, s);
  process.exit(0);
}
if (sub === "uninstall") {
  const reg = read(installed) || { version: 2, plugins: {} }; const rows = (reg.plugins[id] || []).filter((r) => !rowMatches(r));
  if (rows.length) reg.plugins[id] = rows; else delete reg.plugins[id]; write(installed, reg);
  const s = settings(); if (s.enabledPlugins) delete s.enabledPlugins[id]; if (!s.enabledPlugins) s.enabledPlugins = {}; write(settingsPath, s);
  process.exit(0);
}
if (sub === "disable" || sub === "enable") { const s = settings(); s.enabledPlugins = { ...(s.enabledPlugins || {}), [id]: sub === "enable" }; write(settingsPath, s); process.exit(0); }
process.stderr.write("fake claude: unknown subcommand " + argv.join(" ") + "\\n"); process.exit(1);
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return {
    bin,
    dir,
    // The fake's PATH: this dir and the directory of the node that runs the suite (the shebang needs one).
    env: (extra = {}) => noHostEnv({ PATH: [dir, dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":"), ...extra }),
    log: () => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    reset: () => { try { rmSync(join(dir, "calls.jsonl")); } catch {} },
  };
}

// fakePackageRoot(dir, version) — the package as npx extracts it: the shipped
// tree at an arbitrary, non-cache path, with plugin.json and package.json at
// `version`. What `install` runs from when the user types `npx projectstore`.
export function fakePackageRoot(dir, version) {
  copyPackageTree(REPO, dir); // exactly what npm pack ships (package.json files[])
  const pj = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ ...pj, version }, null, 2) + "\n");
  const pk = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pk, version }, null, 2) + "\n");
  return dir;
}

// legacyProject(home) — a project in the exact pre-0.28 shape (the layout ADR's
// migration input): the binding with an `agents` block and statusline enabled
// under .claude/, the runtime dir .claude/.projectstore/ with the 0.27.1
// launcher (rendered from the vendored template against a 0.27.1 install),
// state/ with a session file, a per-session directory and the renderer's
// breadcrumb, an entry log, the welcome marker and the 0.6-era session-id
// file, settings.local.json naming the legacy launcher, the v3 block in
// AGENTS.md. Bound to a seeded vault. Everything absolute-path-bearing is
// built here, which is why this is a function and not a checked-in tree.
export function legacyProject(home, { version = "0.27.1", agents = { default: { model: "sonnet" }, per_agent: { critic: { model: "opus" } } } } = {}) {
  const old = join(home, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", version);
  mkdirSync(join(old, "scripts"), { recursive: true });
  writeFileSync(join(old, "scripts", "statusline.mjs"), `process.stdout.write("rendered-by-${version}\\n");\n`);
  const { proj, vault } = seedCliVault();
  const lp = layoutPaths(proj);
  const cfg = { ...JSON.parse(readFileSync(lp.binding, "utf8")), statusline: { enabled: true }, agents };
  rmSync(lp.root, { recursive: true, force: true });
  mkdirSync(dirname(lp.legacy.binding), { recursive: true });
  writeFileSync(lp.legacy.binding, JSON.stringify(cfg, null, 2) + "\n");
  mkdirSync(lp.legacy.state, { recursive: true });
  writeFileSync(lp.legacy.gitignore, "# projectstore — per-session runtime state, do not commit\n*\n");
  const tpl027 = readFileSync(join(REPO, "tests", "fixtures", "statusline-launcher-0.27.1.txt"), "utf8");
  writeFileSync(lp.legacy.launcher, tpl027.replace('"__PROJECTSTORE_ROOT__"', JSON.stringify(old)));
  writeFileSync(join(lp.legacy.state, "s1.json"), JSON.stringify({ session_id: "s1", active_story: "story-a" }));
  mkdirSync(join(lp.legacy.state, "s1.paths"), { recursive: true });
  writeFileSync(join(lp.legacy.state, "s1.paths", "a.mjs"), "");
  writeFileSync(join(lp.legacy.state, ".last-render.json"), JSON.stringify({ session_id: "s1", version }));
  writeFileSync(lp.legacy.entryLog, JSON.stringify({ at: "2026-09-01T00:00:00Z", session_id: "s1", score: 3 }) + "\n" + JSON.stringify({ at: "2026-09-02T00:00:00Z", session_id: "s1", score: 4 }) + "\n");
  writeFileSync(lp.legacy.welcomed, "2026-09-01T00:00:00Z\n");
  writeFileSync(lp.legacy.sessionId, "s1\n");
  writeFileSync(join(proj, SRC.runtime.harness_dir, "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${lp.legacy.launcher}"` }, other: { keep: true } }, null, 2) + "\n");
  // The v3 block a 0.27.x install registered: the v3 marker and the config
  // path the v3 template named (the v4 template names the overlay).
  const tmpl = readFileSync(join(REPO, "templates", "claude-md-block.md.tmpl"), "utf8");
  const v3 = renderAgentsBlock(tmpl, null).replace("projectstore:agents v4 ", "projectstore:agents v3 ").replace("`.projectstore/harness/<harness>.json`", "`.claude/projectstore.json`");
  writeFileSync(join(proj, "AGENTS.md"), v3 + "\n");
  writeFileSync(join(proj, "CLAUDE.md"), "# My project\n\n@AGENTS.md\n");
  return { proj, vault, old, lp };
}

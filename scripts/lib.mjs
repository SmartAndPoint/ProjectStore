// projectstore — shared helpers used by commands and hooks.
// Pure node, no external deps. Keep this single-file & dependency-free
// so plugin install does not require npm install.

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, utimesSync, unlinkSync, renameSync, rmSync, realpathSync, cpSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join, dirname, basename, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  projectRoot as harnessProjectRoot,
  pluginRoot as harnessPluginRoot,
  agentHome as harnessAgentHome,
  configPath as harnessConfigPath,
  projectConfigDir as harnessProjectConfigDir,
  detectHarnessId,
  overlayId,
  hostSettingsPath,
  layoutPaths,
  pickExisting,
  LAYOUT,
  RUNTIME_GITIGNORE_HEADER,
  runtimeEnvNames,
  sourceWriteTools,
} from "./harness.mjs";

// ─── Paths ─────────────────────────────────────────────────────────────

// The branded environment names live in harnesses/<id>.json and are read by
// harness.mjs only; these three keep the names the rest of the plugin already
// calls.
export function projectRoot() {
  return harnessProjectRoot(process.env);
}

export function pluginRoot() {
  return harnessPluginRoot(process.env);
}

export function configPath() {
  return harnessConfigPath(projectRoot(), process.env);
}

// The layout resolver and its constants, re-exported so hooks and scripts
// import one module (the layout ADR, 2026-09-06). The active harness's id,
// for the paths keyed by it (state/<id>/…).
export { layoutPaths, pickExisting, LAYOUT, RUNTIME_GITIGNORE_HEADER, hostSettingsPath, overlayId };

// ─── Harness overlays (the layout ADR decision 3; layout spec contracts 2–4) ──
//
// <project>/.projectstore/harness/<id>.json carries ONE thing: the agents block
// for that harness — agents.default.model and agents.per_agent.<name>.model.
// Every other key is ignored on read and named for doctor (rejected). The
// binding never carries agents: ADR-008's two-term chain is read from here.
export function readOverlayAt(projectDir, id = overlayId()) {
  // No id (no manifest at all): nothing is read, and the writer below refuses
  // the same id rather than inventing a file name for it.
  const path = id ? layoutPaths(projectDir).overlay(id) : null;
  const out = { id: id || null, path, present: Boolean(path) && existsSync(path), unparseable: false, agents: { default: null, per_agent: {} }, rejected: [], raw: null };
  if (!out.present) return out;
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { out.unparseable = true; return out; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { out.unparseable = true; return out; }
  out.raw = raw;
  for (const k of Object.keys(raw)) if (k !== "agents") out.rejected.push(k);
  const a = raw.agents;
  if (a === undefined) return out;
  if (!a || typeof a !== "object" || Array.isArray(a)) { out.rejected.push("agents"); return out; }
  for (const k of Object.keys(a)) if (k !== "default" && k !== "per_agent") out.rejected.push(`agents.${k}`);
  if (a.default !== undefined) {
    if (a.default && typeof a.default === "object") {
      for (const k of Object.keys(a.default)) if (k !== "model") out.rejected.push(`agents.default.${k}`);
      if (typeof a.default.model === "string" && a.default.model) out.agents.default = a.default.model;
    } else out.rejected.push("agents.default");
  }
  if (a.per_agent !== undefined) {
    if (a.per_agent && typeof a.per_agent === "object" && !Array.isArray(a.per_agent)) {
      for (const [name, v] of Object.entries(a.per_agent)) {
        if (!v || typeof v !== "object") { out.rejected.push(`agents.per_agent.${name}`); continue; }
        for (const k of Object.keys(v)) if (k !== "model") out.rejected.push(`agents.per_agent.${name}.${k}`);
        if (typeof v.model === "string" && v.model) out.agents.per_agent[name] = v.model;
      }
    } else out.rejected.push("agents.per_agent");
  }
  return out;
}

// ADR-008's two terms, from the active harness's overlay: per-agent, else the
// default, else null — null means "pass nothing, the agent's frontmatter decides".
export function resolveAgentModel(projectDir, name, { harness = overlayId() } = {}) {
  const o = readOverlayAt(projectDir, harness);
  const per = o.agents.per_agent[name];
  if (per) return { name, model: per, source: "per_agent", overlay: o.path, harness };
  if (o.agents.default) return { name, model: o.agents.default, source: "default", overlay: o.path, harness };
  return { name, model: null, source: null, overlay: o.path, harness };
}

// The one writer of an overlay: rewrites its agents block, keeps any other key
// as it found it (doctor names them; this never silently drops a user's key).
export function writeOverlayAt(projectDir, id, agents) {
  if (!id) throw new Error("writeOverlayAt: the overlay's harness id is required");
  const path = layoutPaths(projectDir).overlay(id);
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const block = {};
  if (agents.default) block.default = { model: agents.default };
  const names = Object.keys(agents.per_agent || {}).sort();
  if (names.length) block.per_agent = Object.fromEntries(names.map((n) => [n, { model: agents.per_agent[n] }]));
  const next = { ...raw };
  if (Object.keys(block).length) next.agents = block; else delete next.agents;
  ensureRuntimeDir(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n", { sweep: false });
  return path;
}
export function activeHarnessId() {
  return detectHarnessId(process.env) || "harness";
}

// .gitignore files we share with other writers (the vault's sessions dir, the
// project's .projectstore/) are merged by line: each writer ensures its lines
// exist and never rewrites what is there (layout spec, contract 5).
export function ensureGitignoreLines(file, lines, header = null) {
  mkdirSync(dirname(file), { recursive: true });
  let cur = "";
  try { cur = readFileSync(file, "utf8"); } catch {}
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return false;
  const prefix = cur ? (cur.endsWith("\n") ? cur : cur + "\n") : (header ? `# ${header}\n` : "");
  writeFileSync(file, prefix + add.join("\n") + "\n", "utf8");
  return true;
}

// Move one path inside a project — the migration's only mechanism (layout
// spec, contract 6). Absent source: nothing to do. Existing target: refused,
// never overwritten. Both paths must lie inside `within`.
// Move a legacy state directory's contents into the new one, per file, with
// the collision policy of the layout spec (contract 6): a session file that
// exists on both sides keeps the newer mtime; a per-session directory
// (<sid>.paths/, <sid>.fired/) and the renderer's breadcrumb keep the NEW side;
// everything else moves when the target is absent. Returns what happened.
export function moveStateDir(from, to, within) {
  const out = { moved: [], kept: [], replaced: [], dropped: [] };
  if (!existsSync(from)) return out;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".gitignore") continue;
    const src = join(from, name), dst = join(to, name);
    let st; try { st = lstatSync(src); } catch { continue; }
    if (st.isSymbolicLink()) { out.dropped.push(name); continue; }
    if (!existsSync(dst)) { movePath(src, dst, within); out.moved.push(name); continue; }
    if (st.isDirectory() || name.startsWith(".")) { rmSync(src, { recursive: true, force: true }); out.kept.push(name); continue; }
    const newer = st.mtimeMs > statSync(dst).mtimeMs;
    if (newer) { rmSync(dst, { force: true }); movePath(src, dst, within); out.replaced.push(name); }
    else { rmSync(src, { force: true }); out.kept.push(name); }
  }
  return out;
}

// The legacy entry log's lines go BEFORE the new log's (they are older), and
// the legacy file is removed; an absent side is fine.
export function mergeEntryLog(from, to, within) {
  if (!existsSync(from)) return "absent";
  const inside = (p) => { const r = relative(resolve(within), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  if (!inside(from) || !inside(to)) throw new Error(`mergeEntryLog: ${from} → ${to} leaves ${within}`);
  const old = readFileSync(from, "utf8");
  let cur = ""; try { cur = readFileSync(to, "utf8"); } catch {}
  mkdirSync(dirname(to), { recursive: true });
  const glue = old && !old.endsWith("\n") ? "\n" : "";
  writeFileAtomic(to, old + glue + cur, { sweep: false });
  rmSync(from, { force: true });
  return cur ? "merged" : "moved";
}

// Remove a path inside the project — the layout migration's deletes (the two
// legacy markers, an emptied legacy runtime directory, a legacy launcher
// nothing names). Refuses anything outside `within`.
export function removeInside(path, within, { recursive = false } = {}) {
  const r = relative(resolve(within), resolve(path));
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new Error(`removeInside: ${path} is not inside ${within}`);
  if (!existsSync(path)) return false;
  rmSync(path, { recursive, force: true });
  return true;
}

export function movePath(from, to, within) {
  const inside = (p) => { const r = relative(resolve(within), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  if (!inside(from) || !inside(to)) throw new Error(`movePath: ${from} → ${to} leaves ${within}`);
  if (!existsSync(from)) return "absent";
  if (existsSync(to)) return "target-exists";
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return "moved";
}

// ─── Config ────────────────────────────────────────────────────────────

// Config of an arbitrary project, not necessarily this one. The worktree
// inheritance path needs to read the PARENT checkout's config, and reading it
// through a second hand-rolled parse is how the two would drift on the one
// behaviour that matters here: corrupt JSON reads as "not bound", never throws.
export function readConfigAt(projectDir) {
  const p = harnessConfigPath(projectDir, process.env);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

export function readConfig() {
  return readConfigAt(projectRoot());
}

// ─── Entry-file guard ──────────────────────────────────────────────────

// `if (isMain(import.meta.url)) main()` — a generator runs only as the entry
// file, so importing it prints nothing (the MCP server's stdout is its
// protocol channel). argv[1] is compared resolved AND realpath'd: ESM
// realpaths import.meta.url, so a plugin root reached through a symlink
// would otherwise never match and the generator would print nothing to a
// caller that then reports "unparseable generator output".
export function isMain(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(metaUrl);
  if (resolve(argv1) === here) return true;
  try { return realpathSync(argv1) === here; } catch { return false; }
}

// ─── Atomic file writes (spec: atomic-regeneration-of-derived-views) ──

// Replace a file's content via a same-directory temp + rename. Parallel
// readers see the old bytes or the new bytes, never a torn file — a torn
// read of a generated view is a corrupt board; of the statusline launcher,
// a SyntaxError, i.e. a blank HUD frame. The temp name is doubly
// load-bearing: the dot prefix hides it from Obsidian and doctor's vault
// walk, and the `.tmp` suffix is excluded from iCloud sync — temps never
// leave this machine, which is exactly what makes pid-liveness a sound
// staleness test in sweepOrphanTemps. Never mkdirs (callers own their
// directories); the rename gives the target the temp's file mode; on win32
// a rename over a concurrently-open target can fail EPERM — callers report
// it and the next regeneration repairs. May throw: callers report or
// degrade; the helper does not swallow.
export function writeFileAtomic(p, content, { sweep = true } = {}) {
  const dir = dirname(p);
  if (sweep) sweepOrphanTemps(dir);
  const tmp = join(dir, `.${basename(p)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Crash orphans (SIGKILL, power loss between write and rename) are invisible
// to every reader by design, so nothing else ever removes them. The sweep
// runs where writes are frequent enough to matter — reconcile --write's
// vault directories; the sweep:false writers (statusline paths) can strand
// an orphan forever, accepted: dot-prefixed, bytes-sized, machine-local.
// Sweep only temps whose embedded pid is dead: ESRCH ⇒ dead; EPERM ⇒ alive
// but not ours — a live concurrent writer keeps its temp. Pid reuse can make a dead
// orphan look alive; accepted (a lingering hidden temp, never data loss) —
// an mtime heuristic would reintroduce the distributed-clock problem the
// `.tmp` iCloud exclusion exists to avoid. The strict shape (dot prefix,
// numeric pid, `.tmp`) can never match `.gitignore` and friends.
function sweepOrphanTemps(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = n.match(/^\..+\.(\d+)\.tmp$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0); // returns ⇒ alive; EPERM ⇒ alive, not ours
    } catch (e) {
      if (e.code === "ESRCH") {
        try { unlinkSync(join(dir, n)); } catch {}
      }
    }
  }
}

// ─── Installed-plugin resolution ───────────────────────────────────────

// The harness's config directory. Almost always ~/.claude, but the harness's
// home variable relocates it — and a consumer that hardcodes the default
// silently resolves nothing for those users instead of failing loudly. The
// name is kept for its callers; the variable comes from the manifest.
export function claudeHome(home = homedir()) {
  return harnessAgentHome(process.env, home);
}

export function cmpVersion(a, b) {
  const A = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const B = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  return 0;
}

// Where the CURRENTLY installed projectstore lives, per Claude Code's own
// plugin registry. The cache path carries the version
// (…/plugins/cache/<marketplace>/projectstore/<version>), so anything that
// pins it goes stale on the next update — this is how such consumers ask what
// is real right now. Newest install that is actually on disk wins; entries
// pointing at wiped directories are ignored.
// `preferFamily` (a …/<marketplace>/projectstore directory) wins over
// recency, matching the launcher's own ordering — otherwise doctor could
// report drift against an install the launcher would never load.
// Returns { path, version } or null (dev checkout, --plugin-dir, no registry).
// Every projectstore registration the harness's registry holds — one per
// marketplace key and scope — whether or not its install is still on disk.
// The registry is a list, and contract 17 of the install spec (version
// drift across registrations) needs the list; installedPluginRoot folds it.
// The host's enablement of a plugin, user settings first and the project's
// settings over it (a project may silence a user-scope plugin). Absent → true.
export function pluginEnabled(key, home = homedir(), projectDir = null) {
  const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  let enabled = true;
  const user = read(join(claudeHome(home), "settings.json"));
  if (user && user.enabledPlugins && Object.hasOwn(user.enabledPlugins, key)) enabled = user.enabledPlugins[key] !== false;
  if (projectDir) {
    // The committed project file, then the checkout's local one over it — the
    // host's own precedence (measured 2026-09-05, --scope local).
    for (const f of ["settings.json", "settings.local.json"]) {
      const proj = read(join(projectDir, harnessProjectConfigDir(), f));
      if (proj && proj.enabledPlugins && Object.hasOwn(proj.enabledPlugins, key)) enabled = proj.enabledPlugins[key] !== false;
    }
  }
  return enabled;
}

// Every projectstore registration the host knows, with whether it is enabled
// (for the project, when one is named): the registry keeps a disabled row,
// and a copy nobody runs is not a copy (install spec contract 17, amended).
export function installedPluginEntries(home = homedir(), projectDir = null) {
  const out = [];
  let reg;
  try {
    reg = JSON.parse(readFileSync(join(claudeHome(home), "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return out;
  }
  for (const [key, list] of Object.entries((reg && reg.plugins) || {})) {
    if (key !== "projectstore" && !key.startsWith("projectstore@")) continue;
    for (const e of Array.isArray(list) ? list : [list]) {
      const path = e && e.installPath;
      if (typeof path !== "string") continue;
      out.push({
        key,
        path,
        scope: typeof e.scope === "string" ? e.scope : null,
        version: typeof e.version === "string" ? e.version : null,
        at: Date.parse((e && e.lastUpdated) || "") || 0,
        present: existsSync(join(path, "scripts", "statusline.mjs")),
        enabled: pluginEnabled(key, home, projectDir),
        projectPath: typeof e.projectPath === "string" ? e.projectPath : null,
      });
    }
  }
  return out;
}

// A pure PATH walk for a host binary — a read, not a subprocess: the analysers
// run on every doctor call. Returns the absolute path or null.
export function whichOnPath(name, env = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of String(env.PATH || "").split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { const st = statSync(p); if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111))) return p; } catch {}
    }
  }
  return null;
}

// The files a package ships, as the release gate defines them — package.json
// files[] plus npm's always-included package.json, README and LICENSE — copied
// from `from` to `to`. Never node_modules, never a symlink (a symlink is a
// path outside the tree). Returns the relative paths copied, sorted.
export function packageFiles(root) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { return []; }
  const out = new Set(["package.json"]);
  for (const n of readdirSync(root)) if (/^(README|LICEN[CS]E)(\.|$)/i.test(n)) out.add(n);
  const walk = (rel) => {
    const abs = join(root, rel);
    let st; try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of readdirSync(abs)) if (n !== "node_modules" && !n.startsWith(".DS_Store")) walk(rel ? `${rel}/${n}` : n); }
    else out.add(rel);
  };
  for (const f of pkg.files || []) walk(f.replace(/\/+$/, ""));
  return [...out].sort();
}

// The one recursive delete the installer makes: a registration directory of
// ours (install spec contract 13, amended 2026-09-05). The caller has already
// proven the manifest is ours; this refuses anything outside the harness home.
export function removeOwnTree(dir, home = homedir()) {
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm(dir).startsWith(norm(claudeHome(home)) + "/")) throw new Error(`removeOwnTree: ${dir} is not under the harness home`);
  rmSync(dir, { recursive: true, force: true });
}

export function copyPackageTree(from, to) {
  const files = packageFiles(from);
  for (const rel of files) {
    const dst = join(to, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(from, rel), dst);
  }
  return files;
}

// Every regular file under a directory, relative, sorted; symlinks skipped.
export function treeFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    let st; try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of readdirSync(abs)) if (n !== "node_modules" && !n.startsWith(".DS_Store")) walk(rel ? `${rel}/${n}` : n); }
    else out.push(rel);
  };
  walk("");
  return out.sort();
}

// The digest a registration's provenance field carries over its payload: the
// file count and one sha256 over "relpath\nsha256(content)" lines in sorted
// order. Computed from the package's packlist before the copy and from the
// directory after it; unequal means a copy that did not finish, or a hand edit.
export function filesDigest(root, files) {
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel + "\n");
    h.update(createHash("sha256").update(readFileSync(join(root, rel))).digest("hex") + "\n");
  }
  return { count: files.length, sha256: h.digest("hex") };
}
export const packageDigest = (root) => filesDigest(root, packageFiles(root));
export const treeDigest = (dir) => filesDigest(dir, treeFiles(dir));

// The registration directory, written whole and atomically: the payload and
// the manifest are staged beside the target and renamed into place, so a
// reader never sees a half-copied directory under our name (install spec
// contract 4′). An existing directory is removed only after the stage is
// complete — and only by the caller's proof that it is ours.
export function writeOwnTree(dir, { from, subdir, manifestRel, manifest, home = homedir() }) {
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm(dir).startsWith(norm(claudeHome(home)) + "/")) throw new Error(`writeOwnTree: ${dir} is not under the harness home`);
  const stage = dir + ".staging";
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, subdir), { recursive: true });
  const files = copyPackageTree(from, join(stage, subdir));
  mkdirSync(dirname(join(stage, manifestRel)), { recursive: true });
  writeFileSync(join(stage, manifestRel), JSON.stringify(manifest, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true });
  renameSync(stage, dir);
  return files;
}

export function installedPluginRoot(home = homedir(), preferFamily = null) {
  try {
    const found = installedPluginEntries(home)
      .filter((e) => e.present && e.enabled !== false)
      .map((e) => ({ path: e.path, version: e.version, same: preferFamily && dirname(e.path) === preferFamily ? 1 : 0, at: e.at }));
    // Family is a filter, not a tiebreak: when the caller came from a known
    // marketplace, an install from a DIFFERENT one is not a newer copy of the
    // same plugin — it is someone else's fork, and we do not execute it.
    const family = preferFamily ? found.filter((f) => f.same) : [];
    const pool = family.length ? family : preferFamily ? [] : found;
    pool.sort((a, b) => b.at - a.at || cmpVersion(b.version, a.version));
    return pool.length ? { path: pool[0].path, version: pool[0].version } : null;
  } catch {
    return null;
  }
}

// Is this plugin root a versioned cache install (the only kind that goes stale)?
export function isPluginCacheRoot(root, home = homedir()) {
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(root).startsWith(norm(join(claudeHome(home), "plugins", "cache")) + "/");
}

// ─── Status line wiring (SessionStart-managed) ─────────────────────────
//
// The Claude Code statusLine slot is single and NOT plugin-declarable, so
// when a bound project opts in (projectstore.json → statusline.enabled=true)
// the SessionStart hook keeps <project>/.claude/settings.local.json pointing
// at our renderer.
//
// It points at a LAUNCHER, not at the plugin script directly. A cache install
// lives under a versioned path, and the session reads statusLine once at
// startup — so a direct path always rendered the version installed at the
// PREVIOUS session start, one restart behind every update. The launcher path
// never changes, and it resolves the installed plugin at render time, so
// `/plugin update` + `/reload-plugins` show up immediately. Dev checkouts and
// --plugin-dir roots carry no version, so those stay wired directly.
//
// Idempotent (writes only when the value changes); never clobbers a foreign
// statusLine; bails on an unparseable settings file. Returns a status string,
// never throws — the caller wraps it, and this must not break session start.

// Where the launcher is WRITTEN: under the harness's state directory (layout
// ADR decision 4). Readers that ask "is this path ours?" accept the legacy
// .claude/.projectstore/statusline.mjs too — statusLineIsOurs, statusLineIsOurWiring.
export function statusLineLauncherPath(projectDir, harnessId = activeHarnessId()) {
  return layoutPaths(projectDir).launcher(harnessId);
}
export function legacyStatusLineLauncherPath(projectDir) {
  return layoutPaths(projectDir).legacy.launcher;
}
// Both launcher shapes — the new state/<harness>/ one and the legacy one —
// in one place; the recognisers below and doctor read it.
export const LAUNCHER_PATH_RE = new RegExp(`${LAYOUT.root.replace(".", "\\.")}/(${LAYOUT.state}/[^/]+/)?${LAYOUT.launcher.replace(".", "\\.")}$`);
export function isLauncherPath(p) {
  return LAUNCHER_PATH_RE.test(String(p || "").replace(/\\/g, "/"));
}

// Loose shape test — "could this command be a projectstore renderer?". Used
// where over-matching is the safe direction: never compose a status line over
// something that might be us (that would recurse). Both launcher shapes count.
export function statusLineIsOurs(cmd) {
  if (typeof cmd !== "string") return false;
  const c = cmd.replace(/\\/g, "/");
  return c.includes("scripts/statusline.mjs") || isLauncherPath(c.match(/\S*statusline\.mjs/)?.[0] || c);
}

export function statusLineScriptPath(cmd) {
  if (typeof cmd !== "string") return null;
  const m = cmd.match(/"([^"]+statusline\.mjs)"/) || cmd.match(/(\S+statusline\.mjs)/);
  return m ? m[1].replace(/\\/g, "/") : null;
}

// Strict test — "did WE write this?". Required wherever we would overwrite or
// delete the entry: the loose shape above also matches a user's own
// ~/.claude/scripts/statusline.mjs, and clobbering that would take their HUD.
// Ours means one of: this project's launcher, the running plugin's own script
// (dev checkouts included), or any versioned install under the plugin cache.
export function statusLineIsOurWiring(cmd, projectDir, home = homedir(), root = pluginRoot()) {
  const p = statusLineScriptPath(cmd);
  if (!p) return false;
  const norm = (s) => String(s).replace(/\\/g, "/");
  // Ours if it is any harness's launcher in this project's state, or the legacy launcher.
  const lp = layoutPaths(projectDir);
  if (p.startsWith(norm(lp.state) + "/") && isLauncherPath(p)) return true;
  if (p === norm(lp.legacy.launcher)) return true;
  if (p === norm(join(root, "scripts", "statusline.mjs"))) return true;
  return isPluginCacheRoot(dirname(dirname(p)), home);
}

// The launcher template runs standalone, before it knows which plugin root to
// load, so it cannot import harness.mjs; the branded names it needs are
// substituted here instead, from the manifest. All three placeholders must be
// present or the template is not one we know how to fill. Pure — the test
// renders through the same function the installer does.
// `projectDir` is the fourth substitution (2026-09-06): the launcher used to
// find its project by walking two levels up from its own path, which the move
// into state/<harness>/ made wrong; it is named instead, as plan() resolved
// it — the same string the provenance line records, so an npx render and a
// cache-install render stay byte-identical.
export function renderStatusLineLauncher(tpl, root, projectDir = projectRoot(), env = process.env) {
  const names = runtimeEnvNames(env);
  const subs = [
    ['"__PROJECTSTORE_ROOT__"', JSON.stringify(root)],
    ['"__PROJECTSTORE_HOME_ENV__"', JSON.stringify(names.home || "")],
    ['"__PROJECTSTORE_PLUGIN_ROOT_ENV__"', JSON.stringify(names.pluginRoot || "")],
    ['"__PROJECTSTORE_PROJECT__"', JSON.stringify(projectDir)],
  ];
  let src = String(tpl);
  for (const [ph, val] of subs) {
    if (!src.includes(ph)) return null;
    src = src.replace(ph, val);
  }
  return src;
}

// Materialise the launcher into the project, substituting the fallback root
// and the harness's variable names. Idempotent. Returns its path, or null when
// the template is unreadable — the caller then wires the plugin script
// directly, i.e. the old behaviour.
export function writeStatusLineLauncher(projectDir, root) {
  try {
    const tpl = readFileSync(join(pluginRoot(), "scripts", "statusline-launcher.mjs"), "utf8");
    const src = renderStatusLineLauncher(tpl, root, projectDir);
    if (src === null) return null;
    const p = statusLineLauncherPath(projectDir);
    let cur = null;
    try { cur = readFileSync(p, "utf8"); } catch {}
    if (cur !== src) {
      ensureStateDir(projectDir); // carries the nested .gitignore: this path is machine-specific
      mkdirSync(dirname(p), { recursive: true });
      // sweep=false: this runs on session paths, not --write — keep it cheap.
      writeFileAtomic(p, src, { sweep: false });
    }
    return p;
  } catch {
    return null;
  }
}

// The command our entry should carry for this installation: the version-free
// launcher for a marketplace-cache install, the plugin's own script for a dev
// checkout (its path has no version to go stale). One resolver, shared by the
// SessionStart refresh and the installer, so the two cannot disagree.
export function desiredStatusLineCommand(projectDir, root = pluginRoot(), home = homedir()) {
  const launcher = isPluginCacheRoot(root, home);
  return {
    launcher,
    command: launcher ? `node "${statusLineLauncherPath(projectDir)}"` : `node "${join(root, "scripts", "statusline.mjs")}"`,
  };
}

// REFRESH ONLY. This runs on every SessionStart, without a gate, so it may
// keep an entry that is already ours pointing at a working renderer and remove
// our entry on disable — but it never creates: the launcher is an exclusive,
// provenance-stamped file, and stamping lives in provenance.mjs, which stays
// out of the SessionStart module graph by the install spec's own rule. First
// wiring is install-harness.mjs's, behind its preview and confirmation; the
// commands that enable the status line invoke it. An enabled flag with no
// entry reports "needs-install".
export function syncStatusLine(cfg, projectDir, home = homedir()) {
  const st = cfg && cfg.statusline;
  if (!st || typeof st.enabled !== "boolean") return "no-flag"; // absent → leave manual installs alone

  const p = hostSettingsPath(projectDir);
  const root = pluginRoot();

  let settings = {};
  if (existsSync(p)) {
    try {
      settings = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return "skipped-unparseable"; // never clobber a file we cannot read
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return "skipped-nonobject";
    }
  }

  const cur = settings.statusLine;
  const curCmd = cur && typeof cur.command === "string" ? cur.command : null;
  const isOurs = statusLineIsOurWiring(curCmd, projectDir, home, root);

  let changed = false;
  if (st.enabled) {
    // Any existing non-ours entry: leave the slot to its owner — and write
    // nothing into the project, since we are not wiring anything here.
    if (cur && !isOurs) return "foreign-present";
    if (!cur) return "needs-install";
    // Refresh: the launcher when it is on disk, else the plugin's own script,
    // so an entry always names a renderer that exists. A missing launcher is
    // install's to create (stamped), never this path's.
    const { launcher } = desiredStatusLineCommand(projectDir, root, home);
    // A launcher on disk at either path — the new one, or the legacy one an
    // earlier release wrote (the layout ADR) — is kept; moving it is install's.
    const onDisk = [statusLineLauncherPath(projectDir), legacyStatusLineLauncherPath(projectDir)].find((f) => existsSync(f));
    const desired = launcher && onDisk
      ? `node "${onDisk}"`
      : `node "${join(root, "scripts", "statusline.mjs")}"`;
    if (curCmd !== desired) {
      // Keep any sibling keys the platform supports on this object
      // (refreshInterval and friends) — we own the command, not the entry.
      settings.statusLine = { ...(cur && typeof cur === "object" ? cur : {}), type: "command", command: desired };
      changed = true;
    }
  } else if (isOurs) {
    delete settings.statusLine; // disabled: remove only our entry, keep the rest
    // …and the launcher, but only one we wrote: a foreign file at our path is
    // refused by every verb (contract 5), and refresh is a verb. The recogniser
    // is the template's own header line — provenance.mjs stays out of this
    // module graph.
    try {
      const lp = statusLineLauncherPath(projectDir);
      const text = readFileSync(lp, "utf8");
      if (text.includes(LAUNCHER_HEADER)) unlinkSync(lp);
    } catch {}
    changed = true;
  }

  if (!changed) return "unchanged";
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    return "write-failed";
  }
  return st.enabled ? "enabled" : "disabled";
}

// ─── ADR-002 agents block ──────────────────────────────────────────────
//
// The managed routing block in CLAUDE.md / AGENTS.md. One parser, used by
// doctor (to report) and by install-harness.mjs (to write); the version lives
// in the template, never in a constant, so a bump cannot land in one place
// and not the other.

// The launcher template's own header line — the recogniser for a launcher we
// wrote before provenance existed (install spec contract 4, rung 1″) and for
// the one file the disable path may unlink. One literal, three readers
// (surfaces.mjs, doctor.mjs, syncStatusLine).
export const LAUNCHER_HEADER = "projectstore — status line launcher";

export const AGENTS_BLOCK_OPEN_SRC = String.raw`<!--\s*projectstore:agents v(\d+)[^\n]*?-->`;
// The loose form: an open marker a model re-wrapped so `-->` fell to the next
// line. Anchored like the strict form, so prose that merely mentions the
// marker inside another comment is not a block; it cannot match the close
// marker (no " v<digit>"). Detected so a
// wrapped block is refused as unparseable rather than read as absent — the
// strict parser reading "absent" is how install appends a second block and
// uninstall reports "nothing to remove" over a block that is there.
export const AGENTS_BLOCK_OPEN_LOOSE_SRC = String.raw`<!--\s*projectstore:agents v(\d+)`;
export const AGENTS_BLOCK_CLOSE = "<!-- /projectstore:agents -->";

export function agentsBlockTemplatePath(root = pluginRoot()) {
  return join(root, "templates", "claude-md-block.md.tmpl");
}

export function agentsBlockVersion(tmpl = null) {
  const text = tmpl ?? readFileSync(agentsBlockTemplatePath(), "utf8");
  const m = new RegExp(AGENTS_BLOCK_OPEN_SRC).exec(text);
  return m ? Number(m[1]) : null;
}

// The first block in `text`: its version, its span, whether it closes, and how
// many open markers the file carries (more than one is a duplicate).
export function findAgentsBlock(text) {
  if (typeof text !== "string") return null;
  // Count with the loose form, so one good block plus one wrapped marker is
  // "more than once" (refused), never "one block" (half-edited).
  const count = [...text.matchAll(new RegExp(AGENTS_BLOCK_OPEN_LOOSE_SRC, "g"))].length;
  const m = new RegExp(AGENTS_BLOCK_OPEN_SRC).exec(text);
  if (!m) {
    const loose = new RegExp(AGENTS_BLOCK_OPEN_LOOSE_SRC).exec(text);
    if (!loose) return null;
    const line = text.slice(0, loose.index).split("\n").length;
    return { present: true, v: Number(loose[1]), start: loose.index, end: null, unclosed: true, wrapped: true, line, count, block: null };
  }
  const closeAt = text.indexOf(AGENTS_BLOCK_CLOSE, m.index + m[0].length);
  if (closeAt === -1) return { present: true, v: Number(m[1]), start: m.index, end: null, unclosed: true, count, block: null };
  const end = closeAt + AGENTS_BLOCK_CLOSE.length;
  return { present: true, v: Number(m[1]), start: m.index, end, unclosed: false, count, block: text.slice(m.index, end) };
}

// Replace the block in place, else append it after the user's own content.
export function replaceAgentsBlock(text, block) {
  const base = String(text ?? "");
  const f = findAgentsBlock(base);
  if (f && !f.unclosed) return base.slice(0, f.start) + block + base.slice(f.end);
  if (!base.trim()) return block + "\n";
  return base.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

// Remove the block and the blank line that separated it; everything else is
// the user's and stays byte-identical.
export function removeAgentsBlock(text) {
  const base = String(text ?? "");
  const f = findAgentsBlock(base);
  if (!f || f.unclosed) return base;
  const before = base.slice(0, f.start).replace(/\n+$/, "\n");
  const rest = base.slice(f.end);
  const after = rest.trim() ? rest.replace(/^\n+/, "\n") : "";
  const out = before + after;
  return out.trim() ? out.replace(/^\n+/, "") : "";
}

// The block body for a project: the template with agent bullets kept only
// for agents in the layout's roster. Bullets that name no agent — the entry
// rule, the instruction-conflict clause, model resolution, vault
// communication — always stay (ADR-002). No roster: the template verbatim.
export function renderAgentsBlock(tmpl, roster = null) {
  const names = roster ? new Set(roster) : null;
  const lines = String(tmpl).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const out = [];
  let bullet = null;
  // An agent line routes to one agent by its shape — "…: run the
  // \`projectstore:critic\` agent", "…: consult \`projectstore:planner\`" —
  // and is dropped when that agent is not in the roster. Every other bullet
  // stays, however many agents it mentions in passing.
  // Matched over the whole bullet with its wrapping collapsed, since the
  // routing verb may sit on the bullet's second physical line.
  const AGENT_LINE = /^- [^:]*?:\s+(?:run|consult) (?:the )?`projectstore:([a-z]+)`/;
  const flush = () => {
    if (!bullet) return;
    const m = AGENT_LINE.exec(bullet.map((l) => l.trim()).join(" ").replace(/^- /, "- "));
    if (!names || !m || names.has(m[1])) out.push(...bullet);
    bullet = null;
  };
  for (const l of lines) {
    if (/^- /.test(l)) { flush(); bullet = [l]; }
    else if (bullet && /^\s+\S/.test(l)) bullet.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return out.join("\n");
}

// ─── Layouts ───────────────────────────────────────────────────────────

export function loadLayout(name, root = pluginRoot()) {
  const p = join(root, "scaffold", "layouts", `${name}.json`);
  if (!existsSync(p)) {
    throw new Error(`Layout not found: ${name} (expected at ${p})`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

// The layout's agent roster (scaffold/layouts/<layout>.json → agents), or null
// when no binding names a layout that loads — a caller then validates nothing
// against it rather than refusing every name.
export function layoutRoster(cfg, root = pluginRoot()) {
  if (!cfg || typeof cfg.layout !== "string") return null;
  try {
    const r = loadLayout(cfg.layout, root).agents;
    return Array.isArray(r) && r.length ? r : null;
  } catch { return null; }
}

export function folderByKind(layout, kind) {
  return layout.folders.find((f) => f.kind === kind) || null;
}

// ─── Templates ─────────────────────────────────────────────────────────

export function loadTemplate(lang, name) {
  const p = join(pluginRoot(), "templates", lang, `${name}.md.tmpl`);
  if (!existsSync(p)) {
    throw new Error(`Template not found: templates/${lang}/${name}.md.tmpl`);
  }
  return readFileSync(p, "utf8");
}

// {{x}} substitutes raw; {{x_json}} substitutes JSON.stringify(String(x)) — a
// valid YAML double-quoted scalar. Frontmatter lines in templates use the
// _json form so titles containing `"` or `:` cannot corrupt the YAML.
export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key.endsWith("_json")) {
      const base = key.slice(0, -5);
      return base in vars ? JSON.stringify(String(vars[base])) : '""';
    }
    if (key in vars) {
      const v = vars[key];
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    }
    return "";
  });
}

// ─── Heading / keyword registry (PS-SPEC story-002) ────────────────────
//
// scaffold/headings.json is the language-independent registry of the section
// headings, inline keywords and index-table column names the deterministic
// scripts (doctor / reconcile / story-section) must recognize. Per id, per
// language, an ARRAY of accepted forms; the FIRST form of the configured
// language is the canonical form used when WRITING. Matching always accepts
// every registered form of every language — a ru-headed file in an en-bound
// vault must still lint. This is deliberately separate from
// templates/<lang>/strings.json, which is a render-only map for the statusline.

let _headingsCache = null;

export function loadHeadingsRegistry() {
  if (_headingsCache) return _headingsCache;
  const p = join(pluginRoot(), "scaffold", "headings.json");
  try {
    _headingsCache = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`heading registry missing or unreadable (${p}): ${e.message}`);
  }
  return _headingsCache;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allForms(section, id) {
  const entry = loadHeadingsRegistry()[section]?.[id];
  if (!entry) throw new Error(`headings.json has no ${section} entry "${id}"`);
  return Object.values(entry).flat();
}

// Canonical write form for the configured language (en fallback).
export function heading(id, lang = "en") {
  const entry = loadHeadingsRegistry().headings?.[id];
  if (!entry) throw new Error(`headings.json has no headings entry "${id}"`);
  return (entry[lang] || entry.en)[0];
}

// Matches a `## <heading>` line in any registered language, case-insensitively
// (hand-typed `## критерии приёмки` still matches). Anchored to the full line
// so "Acceptance" never matches "Acceptance Criteria".
export function headingLineRe(id) {
  const forms = allForms("headings", id).map(escapeRe);
  return new RegExp(`^##\\s+(?:${forms.join("|")})\\s*$`, "mi");
}

// Extract the body of section `id`: text between its heading line and the
// next `## ` heading (or end of file). Returns null when the section is absent.
export function sectionOf(body, id) {
  const m = body.match(headingLineRe(id));
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function keywordRe(id) {
  const forms = allForms("keywords", id).map(escapeRe);
  return new RegExp(`(?:${forms.join("|")})`, "i");
}

// The two inline grammars built from a keyword plus a colon: the evidence suffix
// on a checked acceptance criterion, and the story attribution on a spec
// acceptance item. Both live here rather than inline at their call sites so the
// gate and its tests cannot drift, and both accept the CJK-width colon — a zh
// vault writes `— 证据：<test>` and `— stories：PS-X/story-foo`, and a full-width
// colon must not read as the marker being absent.
export function evidenceSuffixRe() {
  return new RegExp(`[—–-]\\s*${keywordRe("evidence").source}\\s*[:：]`, "i");
}

export function storiesAttributionRe() {
  return new RegExp(`[—–-]\\s*${keywordRe("stories").source}\\s*[:：]\\s*(.+)$`, "i");
}

// The body footer (`*Last updated: 2026-01-01*`) is content rather than a heading,
// but the lifecycle gates keep it in step with frontmatter `updated:`. Matching
// accepts every registered language; the rewrite preserves the file's OWN prefix
// verbatim through capture group 1, so a locale's punctuation convention — fr
// writes `… : `, zh writes `…：` — survives without the writer needing to know
// which locale it is looking at, and a hand-mixed vault keeps each file's form.
export function footerDateRe() {
  const forms = allForms("footers", "last_updated").map(escapeRe);
  return new RegExp(`^(\\*(?:${forms.join("|")})\\s*[:：]\\s*).*(\\*)$`, "mi");
}

// Matches a folder-README index header row in any registered language,
// in the standard 4-column form: | File | Title | Status | Date |
//
// End-anchored on purpose: a header carrying extra hand-added columns
// (`| File | Title | Status | Date | Notes |`) is NOT this table. Without the
// anchor it prefix-matched, and rebuildIndexRows then rewrote every managed
// row to the registered four columns — silently destroying the extra cells,
// which are human-owned content no regeneration can recompute. Unanchored,
// doctor's index-header check could not fire either (the header "matched"),
// so the loss had no detector at all. Anchored, both halves behave as
// documented: reconcile reports the index unusable and doctor warns.
export function indexHeaderRe() {
  const cols = ["file", "title", "status", "date"].map((c) =>
    allForms("index_columns", c).map(escapeRe).join("|"));
  return new RegExp(
    `^\\|\\s*(?:${cols[0]})\\s*\\|\\s*(?:${cols[1]})\\s*\\|\\s*(?:${cols[2]})\\s*\\|\\s*(?:${cols[3]})\\s*\\|\\s*$`);
}

// ─── Frontmatter list fields (code_refs / specs / stories / adr) ───────
//
// Frontmatter lists must use inline flow form (`specs: ["SPEC-001"]`) —
// parseFrontmatter is line-based and cannot see block sequences. Single
// shared parser; doctor emits a dedicated finding for the block-form trap.
export function listOf(fm, key) {
  const raw = fm[key];
  if (!raw || raw === "[]") return [];
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ─── Vault-side policy config (ADR-007 Decision 4) ─────────────────────
//
// <vault>/.projectstore.json — vault ROOT, dot-prefixed: git commits it (so
// the policy survives clones and second machines), Obsidian hides it, and it
// is intentionally NOT inside <vault>/.projectstore/, whose .gitignore ("*")
// would defeat the whole point. Keys: spec_policy ("required"|"optional"),
// lifecycle_gates ("on"|"off"), spec_policy_since (ISO-8601, stamped when
// spec_policy first becomes "required").
export function vaultConfigPath(vault) {
  return join(vault, LAYOUT.vaultConfig);
}

export function readVaultConfig(vault) {
  const p = vaultConfigPath(vault);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeVaultConfig(vault, cfg) {
  writeFileSync(vaultConfigPath(vault), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// Legacy exemption (ADR-007 Decision 6): a story is exempt from spec-first
// and lifecycle gates iff it was already done before the policy existed —
// status done AND (no closed_at at all, or closed_at earlier than
// spec_policy_since). Stories in progress/review at enable time are IN scope.
export function isLegacyStory(fm, since) {
  const status = String(fm.status || "").toLowerCase();
  if (status !== "done") return false;
  const closed = fm.closed_at && fm.closed_at !== "null" ? String(fm.closed_at) : null;
  if (!closed) return true;
  if (!since) return true;
  return closed < String(since);
}

// ─── Slug / numbering ──────────────────────────────────────────────────

// Cyrillic → Latin so ru titles produce portable ASCII filenames; every other
// Unicode letter/digit survives via \p{L}\p{N}. Never returns an empty slug.
const CYRILLIC = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugify(s) {
  const slug = s
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => CYRILLIC[c] ?? c)
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled";
}

// Prefix is matched case-insensitively and with regex metacharacters escaped:
// GrammarHelper ships `spec-002-*.md` while the layout prefix is `SPEC-` — a
// case-sensitive match would hand out SPEC-001 next to an existing spec-001.
export function nextNumber(dir, prefix, pad = 3) {
  if (!existsSync(dir)) return String(1).padStart(pad, "0");
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped}(\\d+)`, "i");
  const nums = readdirSync(dir)
    .map((n) => n.match(rx))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return String(next).padStart(pad, "0");
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Full ISO-8601 UTC timestamp — for story lifecycle fields (started_at /
// closed_at / plan_updated_at) and spec_policy_since, which must be strictly
// comparable and need sub-day resolution (diff-refs anchors git --since on
// them). Deliberately finer-grained than the date-only created:/updated:.
export function nowIso() {
  return new Date().toISOString();
}

// ─── Artifact identity (ADR-010 / SPEC-002) ────────────────────────────
//
// Identity lives in the slug, not in an allocated number. Two filename eras
// coexist indefinitely (grandfathering — no renames): numbered
// `ADR-003-foo.md` / `story-006-foo.md` and slug-only `foo.md` /
// `story-foo.md`. Comparison therefore works on CANDIDATE SETS, not single
// strings: a numbered-era name contributes both its full stem and its
// number-stripped slug, so `ADR-003-foo.md` collides with `foo.md` and
// `story-006-foo.md` collides with `story-foo.md`. A digit-leading slug
// (`story-2024-review.md`) is formally ambiguous between the eras — it
// contributes both readings and is flagged, never silently collapsed to one.

// Legacy numbered shape: `<PREFIX><digits>` / `<PREFIX><digits>-<slug>` for
// prefixed kinds (prefix matched case-insensitively — GrammarHelper ships
// lowercase `spec-002-*` against layout prefix `SPEC-`), `story-<digits>` /
// `story-<digits>-<slug>` for stories. Any digit count (the legacy pad was a
// rendering choice, not an identity fact). Returns { number, slug } or null.
export function isLegacyNumberedId(name, { prefix = null, story = false } = {}) {
  const stem = String(name).replace(/\.md$/i, "");
  const anchor = story ? "story-" : prefix;
  if (!anchor) return null;
  const m = stem.match(new RegExp(`^${escapeRe(anchor)}(\\d+)(?:-(.+))?$`, "i"));
  return m ? { number: m[1], slug: m[2] ?? null } : null;
}

// Normalized identity of one filename (or dir name, for folder-shape
// stories). `primary` is the as-written reading (story kind marker stripped,
// lowercased); `candidates` adds the legacy number-stripped reading when the
// name matches a numbered shape. `digitLeading` marks slugs that visually
// resemble the numbered era (creation warns on these; overlaps arising only
// from that ambiguity report at warn, not issue).
export function slugIdentity(name, { prefix = null, story = false } = {}) {
  const stem = String(name).replace(/\.md$/i, "").toLowerCase();
  const base = story ? stem.replace(/^story-/, "") : stem;
  const candidates = [{ id: base, via: "self" }];
  const legacy = isLegacyNumberedId(stem, { prefix, story });
  if (legacy?.slug) {
    const id = legacy.slug.toLowerCase();
    if (id !== base) candidates.push({ id, via: story ? "story-number" : "prefix-number" });
  }
  return {
    primary: base,
    candidates,
    digitLeading: /^\d/.test(base),
    legacyNumber: legacy ? legacy.number : null,
  };
}

// The ONE spec↔story matcher (SPEC-002 contract 5) — replaces the inline
// predicates in doctor's resolveSpecStory / checkSpecLinks /
// checkSpecAcceptance. `entry` is the story part of a spec's qualified
// "<epic-id>/<story-id>" reference. Tiered, strongest first; returns the tier
// (1 = exact frontmatter id, 2 = exact filename stem, 3 = numbered-era
// prefix fallback) or 0. The fallback fires ONLY for legacy-shaped entries
// (`story-NNN` / `story-NNN-<slug>`) — a slug entry must match exactly, so
// "PS-X/cache" can never mis-attribute to `cache-invalidation.md`.
export function storyMatchesEntry(entry, { id = null, stem = "" } = {}) {
  const e = String(entry);
  if (id != null && id !== "" && String(id) === e) return 1;
  if (stem === e) return 2;
  if (isLegacyNumberedId(e, { story: true }) && stem.startsWith(e + "-")) return 3;
  return 0;
}

// Sync-conflict blacklist (SPEC-002 contract 7): filename shapes left by
// sync engines — `* <n>.md`, `* copy*.md`, `*(<n>).md`. A legal-form
// whitelist is deliberately NOT used: it would flag hand-created legacy
// notes. Returns null when legal, else a short description for the finding.
export function legalArtifactName(name) {
  if (!/\.md$/i.test(name)) return null;
  const stem = String(name).replace(/\.md$/i, "");
  if (/\s\d+$/.test(stem)) return `trailing " <n>" numeral — sync-engine duplicate shape`;
  if (/\(\d+\)$/.test(stem)) return `trailing "(<n>)" numeral — sync-engine duplicate shape`;
  if (/(^|\s)copy(\s\d+)?$/i.test(stem) || /conflicted copy/i.test(stem)) {
    return `"copy" suffix — sync-engine duplicate shape`;
  }
  return null;
}

// Display number of an artifact: an explicit frontmatter `number:` wins,
// else the legacy filename number; null when neither exists — the badge
// then simply does not render (SPEC-002 contract 8). Numbers are reference
// metadata like a Jira key, not identity (ADR-010).
export function displayNumberOf(fm, name, opts = {}) {
  const n = fm && fm.number != null ? String(fm.number).trim() : "";
  if (n && n !== "null") return n;
  return slugIdentity(name, opts).legacyNumber;
}

// Derived-view ordering (SPEC-002 contract 8): ascending by date, tiebroken
// by display number when present — numbered artifacts sort before unnumbered
// ones inside a date group (the numbered era predates the slug era) — else
// by slug. Callers map artifacts to { date, number, slug }.
export function compareArtifactOrder(x, y) {
  const dx = String(x.date || "");
  const dy = String(y.date || "");
  if (dx !== dy) return dx < dy ? -1 : 1;
  const nx = x.number != null;
  const ny = y.number != null;
  if (nx !== ny) return nx ? -1 : 1;
  if (nx && ny) {
    const dn = parseInt(x.number, 10) - parseInt(y.number, 10);
    if (dn) return dn;
  }
  return String(x.slug || "").localeCompare(String(y.slug || ""));
}

// Pre-write uniqueness guard (SPEC-002 contract 4): does `target` collide
// with any existing name once both are normalized? Candidate-set
// intersection, so it sees cross-era collisions an exact `test -e` cannot.
// Read-only — callers pass the directory listing; draft.mjs surfaces the
// result as its `collision` output field and command prose only renders it.
// Returns null or { with, identity, selfMatch, digitLeading }: selfMatch
// means both as-written readings coincide (a plain duplicate); digitLeading
// means a digit-leading reading is involved on either side (warn-class).
export function findSlugCollision(target, existingNames, opts = {}) {
  const t = slugIdentity(target, opts);
  const tIds = new Set(t.candidates.map((c) => c.id));
  for (const name of existingNames) {
    const e = slugIdentity(name, opts);
    const shared = e.candidates.find((c) => tIds.has(c.id));
    if (!shared) continue;
    return {
      with: name,
      identity: shared.id,
      selfMatch: t.primary === e.primary,
      digitLeading: t.digitLeading || e.digitLeading,
    };
  }
  return null;
}

// ─── Story discovery ──────────────────────────────────────────────────
//
// A story is written in one of two shapes, and both are load-bearing in real
// vaults:
//
//   stories/story-001-foo.md            — flat file
//   stories/story-001-foo/README.md     — folder, when the story owns artifacts
//
// The folder shape exists because a story that carries attachments (reviews,
// diagrams, drafts) needs somewhere to put them; the README is then the story
// itself. Scanners that only glob `stories/*.md` silently drop those stories —
// on a board that means the card disappears, which reads as "no such work"
// rather than "scanner is blind".
//
// Only `stories/<name>/README.md` counts, not deeper nesting: an
// `artifacts/` subfolder under a story holds attachments, not more stories.

export function listStoryFiles(storiesDir) {
  if (!existsSync(storiesDir)) return [];
  const out = [];
  for (const entry of readdirSync(storiesDir).sort()) {
    const full = join(storiesDir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isFile() && entry.endsWith(".md")) {
      out.push({ abs: full, rel: entry, slug: entry.replace(/\.md$/, "") });
      continue;
    }
    if (st.isDirectory()) {
      const readme = join(full, "README.md");
      if (existsSync(readme)) {
        out.push({ abs: readme, rel: `${entry}/README.md`, slug: entry });
      }
    }
  }
  return out;
}

// Every story belonging to one epic folder, `rel` given relative to that folder.
//
// Besides the two shapes above there is a third: a standalone story — one that
// has its own tracker key and no epic around it, filed as
// epics/<key>/story-<slug>.md with no stories/ subfolder. Callers address it by
// that path (ADRs link straight to it), so it is a real location, not a mistake
// to normalise away.

export function listEpicStories(epicDir) {
  const out = [];
  // epics/ holds loose files too (README, notes) — only folders are epics.
  try { if (!statSync(epicDir).isDirectory()) return out; } catch { return out; }
  for (const s of listStoryFiles(join(epicDir, "stories"))) {
    out.push({ abs: s.abs, rel: `stories/${s.rel}`, slug: s.slug });
  }
  for (const entry of readdirSync(epicDir).sort()) {
    if (!entry.startsWith("story-") || !entry.endsWith(".md")) continue;
    const full = join(epicDir, entry);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    out.push({ abs: full, rel: entry, slug: entry.replace(/\.md$/, "") });
  }
  return out;
}

// ─── Link graph: extraction, node index, resolver ──────────────────────
// (spec: vault-link-graph-derived-view-and-shared-link-resolver)

// Strip fenced blocks and inline code spans before matching links or
// checkboxes — notation inside code is not a link. Lifted from doctor,
// which carried two byte-identical copies (checkbox counting and
// checkWikilinks); one definition, shared by doctor and the graph.
export function stripCodeSpans(s) {
  return s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

// Every link in one file's text: wikilinks and relative markdown links.
// Full file text goes in, frontmatter included — parity with what doctor's
// checkWikilinks always scanned. The alias split tolerates the escaped
// `\|` form generated tables render, so a trailing backslash never leaks
// into the target. Markdown links count only in their ./ and ../ forms —
// URLs and absolute paths were never links doctor checked, and stay out.
export function extractLinks(text) {
  const prose = stripCodeSpans(text);
  const out = [];
  for (const m of prose.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split(/\\?\|/)[0].split("#")[0].trim();
    if (target) out.push({ type: "wikilink", target });
  }
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1];
    if (!t.startsWith("./") && !t.startsWith("../")) continue;
    const target = t.split("#")[0];
    if (target) out.push({ type: "mdlink", target });
  }
  return out;
}

// Pure /-joined path arithmetic for link resolution. node:path is
// deliberately avoided: node keys are /-joined vault-relative strings on
// every platform, and resolve()/join() would reintroduce win32 separators.
// Returns the normalized relative path, or null when the target escapes
// the base (a root-relative try that climbs out of the vault is rejected —
// a stray file in the vault's parent folder must never shadow a hit).
function joinRel(baseSegments, target) {
  const segs = [...baseSegments];
  for (const part of String(target).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segs.length) return null;
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs.join("/");
}

const relDirSegments = (rel) => {
  const segs = String(rel).split("/");
  segs.pop();
  return segs;
};

// The graph's node universe (spec contract 2): layout artifact kinds,
// walked the way each kind's real consumers walk them — flat kind folders
// with README.md skipped (scanArtifacts parity), the epic folder via
// listEpicStories so folder-shape AND standalone epics/<id>/story-*.md
// stories are nodes (board parity: a card on the kanban must never
// classify out-of-scope; `_`/`.`-prefixed epic dirs hold blanks, not
// work, exactly as kanban skips them). Derived views and READMEs are
// never nodes. Node keys are full vault-relative paths — never short
// names: epic.md ×4 and README.md ×9 collide in the reference vault
// today, and slug-first identity (ADR-010) makes bare numbers weaker
// over time.
export function buildNodeIndex(cfg, layout) {
  const vault = cfg.vault_path;
  const nodes = [];
  const push = (abs, rel, type, { prefix = null, story = false } = {}) => {
    let md;
    try { md = readFileSync(abs, "utf8"); } catch { return; }
    const fm = parseFrontmatter(md).data;
    const name = basename(rel);
    // A folder-shape story is identified by its folder name, like doctor's
    // storyStemOf; every other node by its filename stem.
    const stem = name === "README.md"
      ? basename(dirname(rel))
      : name.replace(/\.md$/i, "");
    const idField = fm.id ?? fm.slug; // research/concept/runbook/meeting templates carry slug:, not id:
    nodes.push({
      path: rel,
      abs,
      type,
      title: String(fm.title || stem),
      status: fm.status == null ? null : String(fm.status),
      fm,
      body: md,
      stem,
      identity: idField == null ? null : String(idField),
      // Tier-2 accepts the as-written stem PLUS every slugIdentity reading.
      // The as-written entry is load-bearing for stories: slugIdentity
      // strips the story- marker from its candidates, and without it a
      // link to a legacy story's full stem ([[story-013-<slug>]] — the
      // form Obsidian autocompletes) would miss every tier and land
      // out-of-scope, on a node the kanban shows as a card.
      stemReadings: [stem.toLowerCase(), ...slugIdentity(stem, { prefix, story }).candidates.map((c) => c.id)],
      prefix,
      story,
    });
  };
  for (const folder of layout.folders) {
    const dir = join(vault, folder.path);
    if (!existsSync(dir)) continue;
    if (folder.kind === "epic") {
      for (const id of readdirSync(dir).sort()) {
        if (id.startsWith("_") || id.startsWith(".")) continue;
        const epicDir = join(dir, id);
        const epicMd = join(epicDir, "epic.md");
        if (existsSync(epicMd)) push(epicMd, `${folder.path}/${id}/epic.md`, "epic");
        for (const s of listEpicStories(epicDir)) {
          push(s.abs, `${folder.path}/${id}/${s.rel}`, "story", { story: true });
        }
      }
    } else {
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(".md") || f === "README.md") continue;
        push(join(dir, f), `${folder.path}/${f}`, folder.kind, { prefix: folder.prefix || null });
      }
    }
  }
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const byIdentity = new Map();
  const byStem = new Map();
  const add = (map, key, node) => {
    const k = key.toLowerCase();
    if (!map.has(k)) map.set(k, []);
    if (!map.get(k).includes(node)) map.get(k).push(node);
  };
  for (const n of nodes) {
    if (n.identity) add(byIdentity, n.identity, n);
    for (const r of n.stemReadings) add(byStem, r, n);
  }
  return { nodes, byPath, byIdentity, byStem };
}

// The ONE link resolver (spec contract 3), shared by the graph generator
// and doctor's wikilink check so "dead" means the same thing in both.
// Outcomes: {outcome: "node", node} | {outcome: "out-of-scope", path?} |
// {outcome: "ambiguous", candidates} | {outcome: "dead"}.
//
// A target containing "/" resolves as a PATH — vault-root-relative first,
// then source-file-relative, ".md" appended when missing — and never
// enters the stem tiers. A path-qualified target that resolves in neither
// try is dead: deliberately stricter than Obsidian, whose basename
// fallback silently heals a wrong relative depth. Bare stems run the
// SPEC-002 tiers over the NODE index (exact frontmatter identity, exact
// filename-stem readings, legacy numbered-prefix fallback gated by
// isLegacyNumberedId — slug-form targets match exactly, never generic
// startsWith); the strongest tier wins and a tie within it is ambiguity,
// never a silent first match (resolveSpecStory's rule). On zero node
// candidates, ring 2 — an exact-stem match against the full vault file
// walk — classifies a hit out-of-scope: the target exists and is not a
// node; which non-node file a stem like README means is not the graph's
// business (path reported only when the hit is unique). Zero hits in
// either ring is dead. All stem comparisons are case-insensitive,
// preserving today's checkWikilinks semantics.
//
// ctx: { sourceRel, index, files, exists?, kinds? }
//   files  — [{rel, name}] full .md walk (doctor's walkVaultFiles shape),
//            INJECTED so lib never imports doctor (no import cycle).
//   exists — (vaultRel) => bool for non-.md targets (attachments);
//            defaults to "no" — fs-backed callers supply the real one.
//   kinds  — restrict node tiers to these node types (frontmatter refs
//            are kind-scoped by their field; body links pass no filter,
//            so a cross-kind multi-hit is ambiguous).
export function resolveLinkTarget(rawTarget, linkType, ctx) {
  const { sourceRel, index, files, exists = () => false, kinds = null } = ctx;
  const target = String(rawTarget).trim();
  const eligible = (n) => !kinds || kinds.includes(n.type);
  const finish = (rel) => {
    const node = index.byPath.get(rel);
    if (node && eligible(node)) return { outcome: "node", node };
    return { outcome: "out-of-scope", path: rel };
  };
  const fileSet = ctx._fileSet ?? (ctx._fileSet = new Set(files.map((f) => f.rel)));

  if (linkType === "mdlink") {
    // Relative markdown links resolve against the source file's directory
    // only — today's semantics. Landing outside the vault is out-of-scope
    // by definition (contract 3): no probing beyond the vault root.
    const rel = joinRel(relDirSegments(sourceRel), target);
    if (rel === null) return { outcome: "out-of-scope" };
    if (fileSet.has(rel)) return finish(rel);
    if (exists(rel)) return { outcome: "out-of-scope", path: rel };
    return { outcome: "dead" };
  }

  if (target.includes("/")) {
    const t = /\.md$/i.test(target) ? target : `${target}.md`;
    for (const base of [[], relDirSegments(sourceRel)]) {
      const rel = joinRel(base, t);
      if (rel !== null && fileSet.has(rel)) return finish(rel);
    }
    return { outcome: "dead" };
  }

  const key = target.toLowerCase();
  // Tier 1: exact frontmatter identity. Tier 2: filename-stem readings.
  // Tier 3: legacy numbered-prefix fallback, per node anchor.
  const tiers = [
    () => (index.byIdentity.get(key) || []).filter(eligible),
    () => (index.byStem.get(key) || []).filter(eligible),
    () => index.nodes.filter((n) =>
      eligible(n)
      && isLegacyNumberedId(target, n.story ? { story: true } : { prefix: n.prefix })
      && n.stem.toLowerCase().startsWith(`${key}-`)),
  ];
  for (const tier of tiers) {
    const hits = [...new Set(tier())];
    if (hits.length === 1) return { outcome: "node", node: hits[0] };
    if (hits.length > 1) return { outcome: "ambiguous", candidates: hits.map((n) => n.path).sort() };
  }
  if (!kinds) {
    // Ring 2 — only for body links: frontmatter refs point at artifacts
    // by contract, so a non-node reference is simply dead.
    const ring2 = files.filter((f) => f.name.replace(/\.md$/i, "").toLowerCase() === key);
    if (ring2.length === 1) return { outcome: "out-of-scope", path: ring2[0].rel };
    if (ring2.length > 1) return { outcome: "out-of-scope" };
  }
  return { outcome: "dead" };
}

// ─── Vault navigation skeleton ────────────────────────────────────────
// (spec: the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized)
//
// renderVaultSkeleton(facts) is pure — no filesystem, no clock. Every read it
// depends on was already made, under one deadline, by gatherVaultFacts. The
// split is what makes the bounds unit-testable without a slow filesystem, and
// what stops a second convenience being paid for out of the same budget later.

export const PURPOSE_CELL = 160;   // contract 1
export const TITLE_CELL = 80;      // contract 1
export const PATH_CELL = 200;      // contracts 1, 19 — measured: longest path here is 123
export const INFLIGHT_CAP = 5;     // contracts 1, 19
export const ERROR_CELL = 500;     // contract 3

// A truncation marks itself, and the mark counts toward the budget (contract 1).
export function truncEnd(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  // Never orphan a table-cell escape: a `\|` sliced in half leaves a stray
  // backslash AND un-escapes the pipe that follows it, breaking the row.
  const tail = cut.match(/\\+$/);
  if (tail && tail[0].length % 2 === 1) cut = cut.slice(0, -1);
  return cut + "…";
}

// Front-truncation keeps the tail. For a path that is the discriminating half —
// siblings share their folder prefix and differ only in slug — and it keeps the
// filename, so the line still names the artifact to a reader (contract 19).
export function truncFront(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return "…" + t.slice(t.length - (max - 1));
}

// Contract 6: a folder's purpose is its README's own prose — the slice above the
// first `## ` heading. A README that opens with `## ` at byte 0 has no preamble.
// Missing, empty or unreadable yields the folder's KIND, never an empty cell.
export function folderPurpose(readmeText, kind) {
  const text = readmeText == null ? "" : String(readmeText);
  const m = text.match(/(^|\n)## /);
  const head = m ? text.slice(0, m.index) : text;
  const prose = head
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
  return prose ? truncEnd(prose, PURPOSE_CELL) : String(kind);
}

// Contract 19 — a path cell, with the truncation mark OUTSIDE the copyable
// token, so what a reader copies out of the backticks is a clean substring of
// the real path. `graph.md` contains zero `…` characters, so a pasted cell
// carrying one matches nothing and grep exits 1 — which reads as "this artifact
// has no graph entries", a silently false answer. Decided by equality against
// the untruncated string rather than by a leading "…", which is a character a
// path is entitled to contain.
export function pathCell(p) {
  const s = String(p ?? "");
  const t = truncFront(s, PATH_CELL);
  return t === s ? `\`${s}\`` : `…\`${t.slice(1)}\``;
}

function renderCount(counts) {
  if (!counts) return "0";
  if (counts.epics != null) {
    return `${counts.epics} epics · ${counts.stories ?? 0} stories`;
  }
  return String(counts.artifacts ?? 0);
}

function descentOrder({ kanbanFile, adrIndex, epicFile }) {
  return [
    `1. **What is in flight** — the list below, or \`${kanbanFile}\` for the whole board.`,
    `2. **The epic** — \`${epicFile}\` names its stories and how they map to code.`,
    "3. **A folder's index** — its `README.md` lists every artifact with title, status and date. One read, complete.",
    `4. **Before authoring an ADR or spec, or making an architectural choice — read \`${adrIndex}\`.** This step fires on *deciding*, not on searching: it is the one moment the decision index is load-bearing, and skipping it is how a settled question gets re-decided.`,
    "5. **An artifact's neighbourhood** — `grep '<vault-relative-path>' graph.md` returns its typed links in both directions, in one call.",
  ];
}

// Contract 5 — per folder, non-recursive, `README.md` excluded. The epic folder
// counts epics and stories separately, through the shared story lister so that
// folder-shaped and standalone stories are counted the same way the rest of the
// plugin sees them. readdir/stat only: contract 14 forbids anything here that
// could materialize an evicted file, because this path has no budget at all.
function countFolder(vault, folder) {
  const dir = join(vault, folder.path);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return folder.subfolder_per_id ? { epics: 0, stories: 0 } : { artifacts: 0 };
  }
  if (folder.subfolder_per_id) {
    let epics = 0;
    let stories = 0;
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const full = join(dir, n);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      // Contract 5 — an epic is a subdirectory containing `epic.md`, AND stories
      // come from the shared walker. Two clauses, and the gate belongs in front
      // of only the first: the walker does not require `epic.md`, so gating both
      // makes the count and the in-flight list disagree about the same vault
      // three lines apart — contract 12's argument at a smaller scale.
      stories += listEpicStories(full).length;
      if (!existsSync(join(full, "epic.md"))) continue;
      epics += 1;
    }
    return { epics, stories };
  }
  return { artifacts: names.filter((n) => n.endsWith(".md") && n !== "README.md").length };
}

// Contracts 12–15, 19–21 — every read this payload needs, under ONE deadline.
//
// Three families race a single timer: the folder READMEs, the in-flight story
// scan, and (on `compact` only) the activity log. One timer rather than three
// because the budget is the user's startup latency, which does not divide.
// Each family degrades on its own terms, and a family that finished before
// expiry keeps its result — partial is the normal outcome, not a failure.
//
// Nothing here is synchronous except enumeration. The synchronous reader this
// module used to carry was deleted with this change rather than left as an
// invitation: a synchronous read of an evicted file blocks uninterruptibly
// inside one call and the timer never gets a turn, so the budget is only real
// if every content read goes through `readActivityAsync`.
export async function gatherVaultFacts(cfg, opts = {}) {
  // Trailing slashes: `bind` normalizes, a hand-edited config may not, and the
  // relativization below is raw arithmetic. Normalizing once here keeps the
  // gather agreeing with resolveInFlightArtifact, which already normalizes.
  const vault = String(cfg.vault_path || "").replace(/\/+$/, "");
  const budgetMs = opts.budgetMs ?? 200;
  const readFile = opts.readFile || ((p) => readFileAsync(p, "utf8"));
  const sessionId = opts.sessionId ?? null;
  const source = opts.source ?? null;

  // Contract 17 — the vault-not-found shape keeps working. Without this the
  // renderer answers with eight rows of authoritative zeros and the line
  // "nothing in progress" about a vault that does not exist: exactly the
  // silently-false claim contracts 13 and 21 spend paragraphs refusing.
  if (!existsSync(vault)) return { vaultMissing: true, vaultPath: vault };

  const layout = loadLayout(cfg.layout);
  const vcfg = readVaultConfig(vault);
  const adrFolder = folderByKind(layout, "adr") || folderByKind(layout, "spec");
  const epicFolder = folderByKind(layout, "epic");

  const folders = layout.folders.map((f) => ({
    path: f.path,
    kind: f.kind,
    counts: countFolder(vault, f),
    readme: null, // a read that lands fills this; contract 6 covers the rest
  }));

  const storyFiles = listVaultStoryFiles(vault);
  const inFlight = { status: "ok", entries: [], total: 0 };
  // Present only on `compact` — contract 19's positive test, applied where the
  // cost is: on every other source the log is not read at all.
  const wantContinuity = source === "compact" && Boolean(sessionId);
  const continuity = wantContinuity ? { status: "ok", paths: [], total: 0, artifact: null } : null;

  const done = { readmes: false, inFlight: false, activity: false };

  const readmes = (async () => {
    for (const f of folders) {
      try {
        f.readme = String(await readFile(join(vault, f.path, "README.md")));
      } catch {
        /* contract 6: missing, empty and unreadable all fall back to the kind */
      }
    }
    done.readmes = true;
  })();

  const stories = (async () => {
    const found = [];
    for (const abs of storyFiles) {
      let text;
      try {
        text = await readFile(abs);
      } catch {
        continue;
      }
      const fm = parseFrontmatter(String(text)).data;
      if (!fm || !isInProgress(fm.status)) continue;
      const rel = abs.startsWith(vault + "/") ? abs.slice(vault.length + 1) : abs;
      const seg = rel.split("/");
      const epic = epicFolder && seg[0] === epicFolder.path && seg[1] ? seg[1] : seg[0];
      found.push({ epic, title: String(fm.title || seg[seg.length - 1]), startedAt: fm.started_at || "" });
    }
    // Contract 15 — most recently started first, walker order as the tie-break,
    // which sort() preserves. Unstated, the cap would silently favour whichever
    // epic sorts first alphabetically, forever.
    found.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    inFlight.entries = found;
    inFlight.total = found.length;
    done.inFlight = true;
  })();

  const activity = (async () => {
    if (!wantContinuity) {
      done.activity = true;
      return;
    }
    const entries = await readActivityAsync(vault, sessionId, readFile);
    const rel = entries
      .filter((e) => e && typeof e.path === "string" && isInsideVault(e.path, vault))
      .map((e) => e.path.slice(vault.length + 1))
      .filter(Boolean);
    continuity.paths = rel;
    continuity.total = rel.length;
    continuity.artifact = resolveInFlightArtifact(entries, layout, vault);
    done.activity = true;
  })();

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  // Each family swallows its own rejection. Without this, a family that
  // rejects AFTER the deadline won leaves a derived promise with no handler:
  // node's default `--unhandled-rejections=throw` then exits the hook non-zero,
  // which is the "a hook never breaks session startup" contract 17 forbids. The
  // reachable trigger is a corrupt activity entry whose `path` is not a string.
  await Promise.race([
    Promise.all([readmes, stories, activity].map((p) => p.catch(() => {}))).then(() => "ok"),
    deadline,
  ]);
  clearTimeout(timer);

  // Contract 13 — a family still outstanding degrades to its NAMED line. An
  // unfinished in-flight scan must not render as an empty list: that asserts
  // the vault is idle, which is a different and possibly false claim.
  if (!done.inFlight) inFlight.status = "timeout";
  if (continuity && !done.activity) continuity.status = "timeout";

  return {
    vaultPath: vault,
    layoutName: layout.name || cfg.layout,
    language: cfg.language || "en",
    specPolicy: vcfg.spec_policy || "optional",
    lifecycleGates: vcfg.lifecycle_gates || "on",
    kanbanFile: (layout.kanban && layout.kanban.file) || "kanban.md",
    adrIndex: adrFolder ? `${adrFolder.path}/README.md` : "README.md",
    epicFile: epicFolder ? `${epicFolder.path}/<EPIC>/epic.md` : "epic.md",
    folders,
    inFlight,
    continuity,
  };
}

export function renderVaultSkeleton(facts) {
  const f = facts || {};
  const L = [];

  if (f.vaultMissing) {
    return `# projectstore: vault not found at ${truncFront(String(f.vaultPath ?? ""), PATH_CELL)}\n`;
  }

  // Contract 10 — the header carries the session-relevant policy. Absent vault
  // config renders the documented defaults rather than blanks.
  // Contract 3 — the vault path is bounded only by PATH_MAX, so it is a term of
  // the composed cap like any other. Front-truncated for contract 19's second
  // reason: the tail is the discriminating half of a path.
  L.push(`# Projectstore vault: ${truncFront(String(f.vaultPath ?? ""), PATH_CELL)}`);
  // Contract 3 — these four are user-supplied config, and config is free text.
  // The previous revision interpolated them raw, which put the 10,000-character
  // breach back into the very line this change added: a 3,000-character
  // `language` composed a 12,049-character payload. A structural bound is
  // exactly as good as its enumeration, and this was the third miss.
  const cell = (v, dflt) => truncEnd(String(v || dflt), TITLE_CELL);
  L.push(
    `# Layout: ${cell(f.layoutName, "unknown")} · language: ${cell(f.language, "en")}` +
      ` · spec_policy: ${cell(f.specPolicy, "optional")}` +
      ` · lifecycle_gates: ${cell(f.lifecycleGates, "on")}`,
  );
  L.push("");

  // Contract 9 — all five steps, resolved through the layout, never typed.
  L.push("## How to work with this vault");
  L.push("");
  L.push("Descend on demand. Nothing below is a copy of the vault; it is the order to read it in.");
  L.push("");
  for (const step of descentOrder(f)) L.push(step);
  L.push("");

  // Contract 4 — one row per layout folder, iterated, never listed literally.
  L.push("## Where things live");
  L.push("");
  L.push("| Folder | Kind | Count | Purpose |");
  L.push("|---|---|---|---|");
  for (const folder of f.folders || []) {
    L.push(
      `| \`${folder.path}/\` | ${folder.kind} | ${renderCount(folder.counts)} | ` +
        `${folderPurpose(folder.readme, folder.kind)} |`,
    );
  }
  L.push("");

  // Contracts 15, 21 — ordered most-recently-started first, capped, and the
  // expired case says so rather than rendering an empty list, which would be a
  // different and possibly false claim.
  L.push("## In flight now");
  L.push("");
  const inf = f.inFlight || {};
  if (inf.status === "timeout") {
    L.push(`- in-flight work not resolved within budget — see \`${f.kanbanFile}\` § In Progress`);
  } else {
    const entries = inf.entries || [];
    if (entries.length === 0) {
      L.push("- nothing in progress");
    } else {
      for (const e of entries.slice(0, INFLIGHT_CAP)) {
        // `epic` is a directory name — bounded only by NAME_MAX, five times over.
        L.push(`- ${truncEnd(e.epic, TITLE_CELL)} · ${truncEnd(e.title, TITLE_CELL)}`);
      }
      const more = (inf.total ?? entries.length) - Math.min(entries.length, INFLIGHT_CAP);
      if (more > 0) L.push(`- …and ${more} more; see \`${f.kanbanFile}\``);
    }
  }
  L.push("");

  // Contracts 19, 21 — the continuity section. Present only when the gather was
  // asked for it, which is only on `source === "compact"`: a positive test, in
  // one place. Absence here asserts nothing at all, which is why empty and
  // unreadable may share it while an empty in-flight list may not.
  const cont = f.continuity;
  if (cont) {
    if (cont.status === "timeout") {
      L.push("## Where this session left off");
      L.push("");
      L.push("- recent activity not resolved within budget — run `/projectstore:status`");
      L.push("");
    } else if (cont.paths && cont.paths.length > 0) {
      L.push("## Where this session left off");
      L.push("");
      L.push("Vault files this conversation touched before it was compacted, newest first.");
      L.push("");
      for (const p of cont.paths.slice(0, INFLIGHT_CAP)) L.push(`- ${pathCell(p)}`);
      const more = (cont.total ?? cont.paths.length) - Math.min(cont.paths.length, INFLIGHT_CAP);
      if (more > 0) L.push(`- …and ${more} more; see \`/projectstore:status\``);
      if (cont.artifact) {
        L.push("");
        L.push(`**In flight**: ${pathCell(cont.artifact)} was the newest structured write before` +
          " compaction. If we were drafting it, continue from there.");
      }
      L.push("");
    }
  }

  // Contracts 8, 11 — the recipe, the prohibition, and the staleness clause.
  L.push("## Derived views");
  L.push("");
  L.push(
    `\`${f.kanbanFile}\`, \`code-map.md\` and \`graph.md\` are **regenerated** from artifact` +
      " frontmatter. They can lag a very recent edit, they are never hand-edited, and the" +
      " artifact is the source of truth when they disagree.",
  );
  L.push("");
  L.push(
    "`graph.md` is queried, **never read whole** — it is far larger than this payload's" +
      " whole budget. Grep it by **vault-relative path**, which is its node key; a bare slug" +
      " is not a key and returns a flood (on one real vault, 22 lines by path against 101 by" +
      " slug). `code-map.md` answers where code for an epic already lives — read it before" +
      " deciding where new code goes.",
  );

  return L.join("\n") + "\n";
}

// ─── Session awareness (layer 2 — multi-Claude coordination) ──────────
//
// Each Claude Code session registers itself in
// <vault>/.projectstore/sessions/<id>.json, where <id> is Claude's own
// session_id (from hook stdin input). Two Claude instances in the same
// project therefore get distinct files. Other sessions reading the vault
// can detect each other and warn the agent to avoid topic / numbering
// collisions. mtime is used as a liveness proxy: a session whose file
// has not been touched in 30 minutes is considered idle; >24h => stale,
// removed on next SessionStart.

export function sessionsDir(vault) {
  return join(vault, LAYOUT.root, LAYOUT.vaultSessions);
}

export function sessionFilePath(vault, sessionId) {
  return join(sessionsDir(vault), `${sessionId}.json`);
}

// Read Claude's own session_id from hook stdin JSON. Returns null on any
// parse error — callers must no-op silently in that case.
export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function ensureSessionsDir(vault) {
  const dir = sessionsDir(vault);
  mkdirSync(dir, { recursive: true });
  // Make sure no session metadata leaks into git, regardless of where the
  // vault lives. The .gitignore inside <vault>/.projectstore/ is merged by
  // line (2026-09-06: a vault that is also a project shares the directory
  // with the project layout, whose committed harness/ a "*" would hide).
  ensureGitignoreLines(join(vault, LAYOUT.root, ".gitignore"), [`${LAYOUT.vaultSessions}/`], "projectstore — runtime data, do not commit");
  return dir;
}

// Idempotent: preserves started_at and recent_activity if the session file
// already exists (e.g. when SessionStart fires after touch-session has
// already bootstrapped the record).
export function writeSession(vault, sessionId, projectRoot) {
  ensureSessionsDir(vault);
  const path = sessionFilePath(vault, sessionId);
  let existing = null;
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch {}
  }
  const data = {
    id: sessionId,
    started_at: existing?.started_at || new Date().toISOString(),
    project_root: projectRoot,
    host: hostname(),
    pid: process.pid,
    recent_activity: Array.isArray(existing?.recent_activity) ? existing.recent_activity : [],
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

export function touchSession(vault, sessionId) {
  const p = sessionFilePath(vault, sessionId);
  if (!existsSync(p)) return false;
  const now = new Date();
  try {
    utimesSync(p, now, now);
    return true;
  } catch {
    return false;
  }
}

export function readActiveSessions(vault, currentSessionId, maxAgeMinutes = 30) {
  const dir = sessionsDir(vault);
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let data;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (data.id === currentSessionId) continue;
    out.push({ ...data, last_active: stat.mtime });
  }
  return out;
}

// Contract 23 — `currentSessionId` is exempt. A live session's file is not
// stale, and reaping it is pure data destruction: `writeSession` recreates it
// from nothing, so `recent_activity` and `started_at` are gone. A session left
// open overnight and then compacted would have its own history deleted moments
// before the continuity section asks for it.
//
// Named limitation: a SIBLING session idle beyond 24 hours is still reaped by
// whichever session runs cleanup, and its next compaction renders absence for a
// cause contract 21 does not name. Mtime cannot tell idle-alive from dead, so
// the justification above applies to that session word for word and is not
// cheaply actionable here.
export function cleanupStaleSessions(vault, maxAgeHours = 24, currentSessionId = null) {
  const dir = sessionsDir(vault);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const mine = currentSessionId ? `${currentSessionId}.json` : null;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    if (mine && name === mine) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// (removeLegacySessionIdFile lived here until 2026-09-06; deleting the
// 0.6-era .claude/.projectstore-session-id is a step of the layout migration.)
// One-shot migration helper (retired): delete .claude/.projectstore-session-id left
// behind by v0.3 – v0.5 (file-based per-project session id). Safe to call
// on every session start; no-op if the file is absent. Kept until v0.7.


// ─── Session activity log ──────────────────────────────────────────────
//
// Each session file may carry a `recent_activity` array, populated by
// touch-session.mjs from PreToolUse events. Capped at 50 entries, deduped
// by path (latest tool/timestamp wins). Read by hooks/pre-compact.mjs for its
// compaction line and by hooks/session-start.mjs for the continuity section —
// through the one resolver below, never by re-deriving the question.

const ACTIVITY_CAP = 50;

// The write family, defined once. touch-session.mjs writes the log with it and
// resolveInFlightArtifact reads the log with it, so the reader cannot recognise
// a narrower set than the writer recorded — which is exactly how `NotebookEdit`
// came to be logged and then ignored. `hooks/hooks.json`'s PostToolUse matcher
// is a third copy that cannot import; a test pins it against this list.
// The list itself is the source manifest's (harnesses/claude-code.json); copied,
// not aliased, so freezing it cannot freeze the cached manifest object.
export const WRITE_TOOLS = Object.freeze([...sourceWriteTools()]);
const WRITE_TOOL_SET = new Set(WRITE_TOOLS);

export function isWriteTool(tool) {
  return WRITE_TOOL_SET.has(tool);
}

export function appendActivity(vault, sessionId, filePath, toolName) {
  const sp = sessionFilePath(vault, sessionId);
  if (!existsSync(sp)) return false;
  let data;
  try {
    data = JSON.parse(readFileSync(sp, "utf8"));
  } catch {
    return false;
  }
  const recent = Array.isArray(data.recent_activity) ? data.recent_activity : [];
  const filtered = recent.filter((e) => e && e.path !== filePath);
  filtered.unshift({ path: filePath, tool: toolName, at: new Date().toISOString() });
  data.recent_activity = filtered.slice(0, ACTIVITY_CAP);
  try {
    writeFileSync(sp, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

// The one reader of `recent_activity`, and async because a budget can only
// interrupt an async read: a synchronous read of an iCloud-evicted file blocks
// inside one call and the timer never gets a turn. Both consumers — the gather and
// pre-compact — read this one file, so they read it through one function.
// Returns [] for missing, unparseable and unreadable alike (contract 21).
export async function readActivityAsync(vault, sessionId, readFile) {
  if (!sessionId) return [];
  const read = readFile || ((p) => readFileAsync(p, "utf8"));
  try {
    const data = JSON.parse(String(await read(sessionFilePath(vault, sessionId))));
    return Array.isArray(data.recent_activity) ? data.recent_activity : [];
  } catch {
    return [];
  }
}

// Contracts 20, 24 — the in-flight artifact: the newest write-family entry
// whose path lands in a folder of the ACTIVE layout, returned vault-relative.
//
// Shared on purpose. The compaction line and the continuity section answer the
// same question seconds apart on the same screen, so two implementations of it
// drift in public. Folders come from the layout and are never spelled out here:
// a layout that gains a kind must not go blind, which is the defect the row
// renderer is already forbidden to have.
//
// `vaultPath` is a parameter rather than a convenience because the anchor
// cannot be reconstructed from either side alone — the log stores absolute tool
// paths, `layout.folders[].path` are vault-relative. Without it the only
// available match is a substring, which fires on a folder name occurring at
// depth: `notes/adr/x.md` is not an ADR.
export function resolveInFlightArtifact(activity, layout, vaultPath) {
  if (!Array.isArray(activity) || !vaultPath) return null;
  const folders = (layout && Array.isArray(layout.folders) ? layout.folders : [])
    .map((f) => f && f.path)
    .filter(Boolean);
  if (folders.length === 0) return null;
  const root = vaultPath.endsWith("/") ? vaultPath.slice(0, -1) : vaultPath;
  // appendActivity unshifts, so the log is newest-first and the first match is
  // the newest one — no sort, and no second definition of "newest".
  for (const e of activity) {
    if (!e || !e.path || !isWriteTool(e.tool)) continue;
    if (!isInsideVault(e.path, root)) continue;
    const rel = e.path.slice(root.length + 1);
    if (folders.some((p) => rel === p || rel.startsWith(p + "/"))) return rel;
  }
  return null;
}

export function isInsideVault(filePath, vaultPath) {
  if (!filePath || !vaultPath) return false;
  const norm = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
  return norm === vaultPath || norm.startsWith(vaultPath + "/");
}

// ─── Per-session project-side state (statusline pointer — ADR-006) ─────
//
// <project>/.claude/.projectstore/state/<session_id>.json holds this
// session's active epic/story with denormalized titles, so the statusline
// renders with zero vault reads and zero cross-session reads. A nested
// .gitignore with "*" is ensured unconditionally (mirrors ensureSessionsDir)
// so per-session ids/titles never reach the user's git history.

// The WRITER's view: <project>/.projectstore/state/sessions. Readers fall back
// to the legacy .claude/.projectstore/state through 0.29 (readSessionState).
export function stateDir(projectDir) {
  return layoutPaths(projectDir).sessions;
}
export function legacyStateDir(projectDir) {
  return layoutPaths(projectDir).legacy.state;
}

export function sessionStatePath(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.json`);
}

// <project>/.projectstore — ours, harness-neutral. Its .gitignore is merged by
// line (the binding and state/ are machine-specific; harness/ is committed).
export function ensureRuntimeDir(projectDir) {
  const p = layoutPaths(projectDir);
  mkdirSync(p.root, { recursive: true });
  ensureGitignoreLines(p.gitignore, [...LAYOUT.gitignore], "projectstore — the binding and the state are machine-local; harness/ is committed");
  return p.root;
}

// <project>/.projectstore/state — every harness's runtime files, keyed by
// harness inside; its own ignore file so nothing in here can reach git,
// whichever writer gets there first.
export function ensureStateDir(projectDir) {
  ensureRuntimeDir(projectDir);
  const p = layoutPaths(projectDir);
  mkdirSync(p.sessions, { recursive: true });
  if (!existsSync(p.stateGitignore)) writeFileSync(p.stateGitignore, `# ${RUNTIME_GITIGNORE_HEADER}, do not commit\n*\n`, "utf8");
  return p.sessions;
}

export function readSessionState(projectDir, sessionId) {
  try {
    const p = pickExisting(sessionStatePath(projectDir, sessionId), join(legacyStateDir(projectDir), `${sessionId}.json`));
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writeSessionState(projectDir, sessionId, patch) {
  ensureStateDir(projectDir);
  const cur = readSessionState(projectDir, sessionId) || {};
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(sessionStatePath(projectDir, sessionId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function cleanupStaleSessionState(projectDir, maxAgeHours = 24) {
  const dir = stateDir(projectDir);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.mtimeMs >= cutoff) continue;
      if (st.isDirectory()) {
        // Entry-rule score and marker directories. Reaped by the directory's
        // OWN mtime, which advances when an entry is created inside it — so an
        // actively-scoring session is never reaped mid-flight. The accepted
        // envelope: a session that registers no NEW distinct path for the whole
        // window loses its score and its markers together, permitting at most
        // one duplicate reminder. Before this branch existed they leaked
        // forever, because the old filter skipped everything but *.json.
        rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (name.endsWith(".json")) {
        unlinkSync(p);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// ─── Entry-rule detection (artifact-first order) ───────────────────────
//
// Normative text: the spec "Entry-rule detection: the score, the open-story
// predicate, and the delivery seams". The one rule that governs every helper
// below and is invisible from any single call site: **nothing here may route
// through writeSessionState**. That function is a read-modify-write, and
// writeFileSync opens with O_TRUNC — so a concurrent read lands on a
// zero-byte file, readSessionState swallows the parse error into `null`, and
// the spread then writes the patch alone, erasing the ADR-006 statusline
// pointer. Today that path only runs on vault-file tool calls; the score is
// fed by every source write in every parallel subagent (all sharing one
// session_id), which is a different order of contention entirely.

// Generated, vendored or machine-local paths — never a source file for any
// consumer. Lifted out of diff-refs.mjs so the hook, doctor and diff-refs
// cannot drift apart (contract 1).
export const SOURCE_IGNORE = [
  /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//,
  /(^|\/)\.claude\//, /\.min\.(js|css)$/,
];

// The entry-rule counter ignores strictly more than the base set, and the
// difference is deliberate rather than an oversight of one or the other.
// /projectstore:bind writes these three itself, in a session that by
// construction has no story open — counting them makes the plugin nag about its
// own setup. They must NOT join SOURCE_IGNORE: an edit to AGENTS.md is a real
// code reference (the PS-AGENTS epic already lists it), and folding these into
// the shared set would silently drop it from every proposed code_refs.
// Root-anchored, unlike the patterns above: a monorepo's nested AGENTS.md is
// ordinary source and must still count.
export const ENTRY_IGNORE = [
  ...SOURCE_IGNORE,
  /^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.gitignore$/,
];

export function isSourcePath(absPath, projectDir, vaultPath) {
  if (!absPath || !projectDir) return false;
  if (vaultPath && isInsideVault(absPath, vaultPath)) return false;
  const root = projectDir.endsWith("/") ? projectDir.slice(0, -1) : projectDir;
  if (!absPath.startsWith(root + "/")) return false;
  // Matched project-relative, never absolute: SOURCE_IGNORE is
  // repo-relative-anchored, so `/(^|\/)build\//` would swallow every path in a
  // project that merely lives under a directory called `build`.
  const rel = absPath.slice(root.length + 1);
  if (!rel) return false;
  return !ENTRY_IGNORE.some((re) => re.test(rel));
}

export function scoreDir(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.paths`);
}

function pathKey(p) {
  return createHash("sha1").update(p).digest("hex").slice(0, 16);
}

// One empty file per distinct path. Registration is a bare create on a
// content-derived name, so two subagents registering concurrently cannot lose
// each other's increment and no reader-writer pair exists to race (contract 2).
export function registerSourcePath(projectDir, sessionId, absPath) {
  try {
    const dir = scoreDir(projectDir, sessionId);
    ensureStateDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, pathKey(absPath)), "", { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

// Exact and uncapped: the reminder quotes this number, so a session that wrote
// fifty files must not report three.
export function entryScore(projectDir, sessionId) {
  try {
    return readdirSync(scoreDir(projectDir, sessionId)).length;
  } catch {
    return 0;
  }
}

// The single open-story predicate (contract 5), as a pure core: it decides from
// already-loaded frontmatter and performs no I/O, so doctor feeds it the
// artifact scan it already performs while the hook feeds it a budgeted read —
// one definition, and therefore no way for the two to disagree about the same
// vault. `planned` is deliberately not open: writing code against a story that
// never went through /projectstore:story plan is itself the order being skipped.
// Both spellings the vault holds and the kanban maps (statusToColumn): the
// SessionStart orientation said "nothing in progress" over six in_progress
// stories, and doctor's work-without-story fired beside them (2026-09-05).
export function isInProgress(status) {
  return status === "in-progress" || status === "in_progress" || status === "in progress";
}

export function openStoryFrom(storyFrontmatters) {
  return (storyFrontmatters || []).some((fm) => fm && isInProgress(fm.status));
}

// Every story file in the vault, whatever shape it takes. Deliberately
// synchronous: readdir/stat never materialize an iCloud-evicted file, so
// enumeration cannot block — only reading contents can. One lister, shared by
// both adapters; a parallel async copy would drift.
export function listVaultStoryFiles(vaultPath) {
  const out = [];
  const epicsDir = join(vaultPath, "epics");
  let entries;
  try { entries = readdirSync(epicsDir).sort(); } catch { return out; }
  for (const e of entries) {
    for (const s of listEpicStories(join(epicsDir, e))) out.push(s.abs);
  }
  return out;
}

// The hook's adapter: tri-state, under a hard budget (contract 6).
//
// The budget cannot be enforced by checking the clock between files. Node
// cannot interrupt a synchronous read, and an iCloud-evicted story does not
// fail — it BLOCKS while macOS downloads it, inside a single call. So the reads
// are async and raced against a timer: when the timer wins we return "unknown"
// with reads still outstanding, and the caller (a short-lived hook process) may
// exit — but only because "unknown" suppresses the reminder, so nothing has
// been written to stdout. Exiting after a write would truncate it, since
// process.exit does not flush pending pipe writes.
export async function resolveOpenStory(vaultPath, opts = {}) {
  const budgetMs = opts.budgetMs ?? 200;
  const readFile = opts.readFile || ((p) => readFileAsync(p, "utf8"));
  const files = listVaultStoryFiles(vaultPath);
  if (!files.length) return false;

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("unknown"), budgetMs);
  });
  const scan = (async () => {
    for (const f of files) {
      let text;
      try { text = await readFile(f); } catch { continue; }
      // String(): the injected reader is a seam, and a caller that forgets an
      // encoding hands back a Buffer. Coercing here keeps that a non-event.
      if (openStoryFrom([parseFrontmatter(String(text)).data])) return true;
    }
    return false;
  })();

  try {
    return await Promise.race([scan, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Newest mtime across the vault's markdown, ms, or null for an empty vault.
// `stat` does not materialize a dataless file, so unlike a frontmatter sweep
// this cannot block on an iCloud download. Advisory by nature: a sync that
// rewrites mtimes can only make the caller quieter, never noisier.
export function lastVaultActivityMs(vaultPath) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .projectstore/, .obsidian/, .git/
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {}
      }
    }
  };
  walk(vaultPath);
  return newest || null;
}

export function markerDir(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.fired`);
}

// The sweep runs at most once per session; its verdict — "unknown" included —
// is written once and never rewritten, so there is no read-modify-write here
// either. `wx` is O_EXCL: a second invocation racing the first simply loses.
export function readOpenStoryCache(projectDir, sessionId) {
  try {
    const v = readFileSync(join(markerDir(projectDir, sessionId), "open-story"), "utf8").trim();
    return v === "true" ? true : v === "false" ? false : "unknown";
  } catch {
    return null; // no verdict yet — distinct from a cached "unknown"
  }
}

export function writeOpenStoryCache(projectDir, sessionId, value) {
  try {
    mkdirSync(markerDir(projectDir, sessionId), { recursive: true });
    writeFileSync(join(markerDir(projectDir, sessionId), "open-story"), String(value), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

// ── Emitter election (contract 12) ──
//
// State is three fixed-name marker files in <sid>.fired/: `fired-1`, `fired-2`
// and `armed`. Fixed names are the whole mechanism — with process-derived names
// every contender's create succeeds and every contender emits.
//
// `fired-*` are never removed. A discarded conversation CREATES `armed`; the
// winning emitter deletes it. Clearing `fired-*` on compaction instead (the
// obvious design, and an earlier draft of the spec) makes the cap unreachable:
// the directory never holds two, so firings are unbounded at one per
// compaction cycle.

export function firedCount(projectDir, sessionId) {
  try {
    return readdirSync(markerDir(projectDir, sessionId))
      .filter((n) => /^fired-\d+$/.test(n)).length;
  } catch {
    return 0;
  }
}

export function isArmed(projectDir, sessionId) {
  return existsSync(join(markerDir(projectDir, sessionId), "armed"));
}

// Called from SessionStart on source `compact` or `clear`: the session id
// survives but the conversation — and with it the delivered reminder — did not.
export function armReminder(projectDir, sessionId) {
  try {
    mkdirSync(markerDir(projectDir, sessionId), { recursive: true });
    writeFileSync(join(markerDir(projectDir, sessionId), "armed"), "", { flag: "wx" });
    return true;
  } catch {
    return false; // already armed; arming twice is not two permissions
  }
}

export function mayRemind(projectDir, sessionId) {
  const n = firedCount(projectDir, sessionId);
  if (n >= 2) return false;
  return n === 0 || isArmed(projectDir, sessionId);
}

// Returns true iff THIS process is the emitter for the current armed context.
//
// The prize is chosen by state, never by falling through to the next free name.
// "try fired-1, on EEXIST try fired-2" reads like the same thing and is not: two
// processes that both observe an empty directory would take one name each and
// both emit. Deriving the single legal target from the count means exactly one
// name is contested per context, and O_EXCL awards it to exactly one caller.
// ── The efficacy log (contract 19) ──
//
// Append-only on the write side; the cap is the reader's job. Two sessions
// firing at the same instant can both append safely, where both truncating
// would not be safe. `.claude/` is gitignored, so this never travels — doctor
// must say "on this machine" or a two-machine maintainer reads a zero as
// "the mechanism is broken".

export const ENTRY_LOG_CAP = 1000;

// The writer appends to the new path; the reader falls back to the legacy log
// while the window is open (contract 1).
export function entryLogPath(projectDir) {
  return layoutPaths(projectDir).entryLog;
}
export function entryLogReadPath(projectDir) {
  const p = layoutPaths(projectDir);
  return pickExisting(p.entryLog, p.legacy.entryLog);
}

export function appendEntryLog(projectDir, record) {
  try {
    ensureStateDir(projectDir); // state/ with its own .gitignore
    appendFileSync(entryLogPath(projectDir), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// `kind` discriminates records that share this log. An entry reminder is
// unmarked for backward compatibility with logs written before anything else
// used the file; every later writer names itself. Callers that mean "entry
// reminders" must pass `kind: null` — doctor renders this count as "an entry
// reminder fired N time(s)", a sentence a name-offer breadcrumb would falsify.
export function readEntryLog(projectDir, { withinDays = 30, kind = undefined } = {}) {
  let lines;
  try {
    lines = readFileSync(entryLogReadPath(projectDir), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  if (lines.length > ENTRY_LOG_CAP) lines = lines.slice(-ENTRY_LOG_CAP);
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (Date.parse(r.at) < cutoff) continue;
      if (kind !== undefined && (r.kind ?? null) !== kind) continue;
      out.push(r);
    } catch {}
  }
  return out;
}

// ── The reminder (contracts 4, 15) ──

export const ENTRY_THRESHOLD = 3;

// Normative text. Three properties it must keep, whatever the wording: it shows
// the evidence (the count), it names the action, and it grants the exit — so a
// false positive costs a glance rather than an argument.
export function entryReminderText(n) {
  return [
    `**projectstore**: this session has written to ${n} source files and no story`,
    "is in progress. If this is feature-sized work, open it in the vault before",
    'going further — `/projectstore:story <EPIC> "<title>"`, or',
    "`/projectstore:epic` if it needs a new one. If it is a one-off fix, carry",
    "on — this fires once.",
  ].join("\n");
}

export function electEmitter(projectDir, sessionId) {
  const dir = markerDir(projectDir, sessionId);
  const n = firedCount(projectDir, sessionId);
  let target = null;
  if (n === 0) target = "fired-1";
  else if (n === 1 && isArmed(projectDir, sessionId)) target = "fired-2";
  if (!target) return false;
  try { mkdirSync(dir, { recursive: true }); } catch { return false; }

  // In the ARMED state the arming is the scarce thing, so consuming it must be
  // the atomic act. Creating fired-2 first and unlinking `armed` afterwards
  // leaves a window in which a second process still sees count==1 && armed and
  // targets fired-2 too: both create (different moments, same name is gone —
  // the loser's create fails, but only if it arrives after; widen the gap and
  // both win). unlink() succeeding is what elects here, exactly as create()
  // does in the unarmed state.
  if (target === "fired-2") {
    try { unlinkSync(join(dir, "armed")); } catch { return false; }
  }
  try {
    writeFileSync(join(dir, target), "", { flag: "wx" });
  } catch {
    return false; // another process took this context's slot
  }
  return true;
}

// ─── Session-name anchor (ADR: the settled-anchor offer) ───────────────
//
// The session name is an ADDRESS: peers route to a session by it, and nothing
// a plugin can call sets it — the authoritative value lives in the harness's
// memory. So projectstore composes a name and OFFERS it; the person accepts.
// (Covering research: "The session name is an address".)
//
// The whole difficulty is WHEN to speak, and the rule below was selected by
// replaying nine recorded sessions, not by taste. Naive "offer on every
// epic/story change" fires 19 times in one session. See
// tests/fixtures/session-anchor-shapes.json and its drives, which reproduce
// the comparison table the ADR cites.
//
// State for this rule must NOT route through writeSessionState — see the
// entry-rule banner above for the mechanism (O_TRUNC, a zero-byte read, and the
// ADR-006 statusline pointer erased). This tally is the highest-frequency
// writer in the system, so the hazard is sharper here than where it is written
// down. Follow registerSourcePath: one file per key, no reader-writer pair.
//
// Two gates that are easy to omit and that the fixtures alone will NOT catch,
// because every recorded session is an authoring session: the tally counts
// WRITE-family calls only, and MAIN-AGENT calls only. Without the first, a
// review session that greps thirty files is offered a name for work it never
// did; without the second, parallel subagents (which share one session id)
// vote on a name none of them can accept.

export const ANCHOR_SETTLE = 5;   // tally at which a key becomes offerable
export const ANCHOR_MARGIN = 10;  // lead a challenger needs to take over
const ANCHOR_NAME_CELL = 48;      // a name is typed by hand; keep it typeable

// Which cluster an artifact belongs to: its epic, or the document itself.
// Folders come from the layout, never from a hard-coded set — a vault that
// renames `research/` must not silently stop being nameable.
export function anchorKeyOf(rel, layout) {
  if (typeof rel !== "string" || !rel) return null;
  const folders = (layout && Array.isArray(layout.folders) ? layout.folders : [])
    .filter((f) => f && f.path);
  const epic = folders.find((f) => f.kind === "epic");
  if (epic && rel.startsWith(epic.path + "/")) {
    // String ops, never an interpolated RegExp: a layout path is user data, and
    // `epics.old` would otherwise match `epicsXold/` while a parenthesised path
    // stopped matching at all — the exact silent failure this function's
    // layout-driven design exists to avoid.
    const id = rel.slice(epic.path.length + 1).split("/")[0];
    if (id) return { key: `epic:${id}`, id, leaf: leafOfStory(rel) };
  }
  for (const f of folders) {
    if (f.kind === "epic") continue;
    if (rel.startsWith(f.path + "/") && rel.endsWith(".md")) {
      const base = rel.slice(f.path.length + 1);
      if (base.includes("/")) continue;      // only files directly in the folder
      // A folder's generated index is not a document: `adr/README.md` would
      // otherwise settle an anchor and compose the name "readme".
      if (f.readme && base.toLowerCase() === "readme.md") continue;
      return { key: `doc:${rel}`, id: base.replace(/\.md$/, ""), leaf: null };
    }
  }
  return null;
}

function leafOfStory(rel) {
  const m = rel.match(/\/stories\/(.+)\.md$/);
  return m ? m[1].replace(/^story-/, "").replace(/^\d+-/, "") : null;
}

export function emptyAnchorState() {
  return { counts: {}, leaves: {}, incumbent: null, offered: null };
}

// One event folded into the state. Returns the state and, when the anchor
// moves, the key that should now be offered — the caller composes the name.
// Pure: no clock, no disk, so a fixture replay and the live hook run the same
// code path rather than two implementations that agree until they do not.
export function foldAnchor(state, hit) {
  const st = state || emptyAnchorState();
  if (!hit || !hit.key) return { state: st, offer: null };
  const counts = { ...st.counts, [hit.key]: (st.counts[hit.key] || 0) + 1 };
  const leaves = { ...st.leaves };
  if (hit.leaf) {
    const per = { ...(leaves[hit.key] || {}) };
    per[hit.leaf] = (per[hit.leaf] || 0) + 1;
    leaves[hit.key] = per;
  }
  let incumbent = st.incumbent;
  let offered = st.offered;
  let offer = null;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= ANCHOR_SETTLE) {
    const take = incumbent === null
      ? true
      : top[0] !== incumbent && top[1] >= (counts[incumbent] || 0) + ANCHOR_MARGIN;
    if (take && top[0] !== incumbent) {
      incumbent = top[0];
      // A moved anchor is not automatically a new NAME. Two documents can share
      // a basename across folders, and an A→B→A pivot returns to a name already
      // offered — in both cases repeating it is noise that looks like a bug.
      // Suppress here rather than at the call site: the invariant "the same name
      // is never offered twice running" belongs to the rule, not to one consumer.
      const name = composeAnchorName({ counts, leaves, incumbent, offered }, incumbent);
      if (name && name !== offered) {
        offer = { key: incumbent, name };
        offered = name;
      }
    }
  }
  return { state: { counts, leaves, incumbent, offered }, offer };
}

// epic anchors read as "<epic-id>-<its most-written story>"; a document anchor
// is its own slug. Truncation is on a word boundary — a name cut mid-word
// reads as a typo, and this one gets typed back by a person.
export function composeAnchorName(state, key) {
  const st = state || emptyAnchorState();
  const k = key || st.incumbent;
  if (!k) return null;
  const [kind, rest] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
  let name;
  if (kind === "epic") {
    const per = st.leaves[k] || {};
    const top = Object.entries(per).sort((a, b) => b[1] - a[1])[0];
    name = rest.toLowerCase() + (top ? `-${top[0]}` : "");
  } else {
    name = rest.replace(/^.*\//, "").replace(/\.md$/, "");
  }
  // slugify transliterates (Cyrillic included) — without it a non-ASCII title
  // composed to null and burned the incumbent slot, leaving the session
  // permanently nameless with nothing to show for it.
  name = slugify(name);
  if (name.length <= ANCHOR_NAME_CELL) return name || null;
  const words = name.split("-");
  let out = "";
  for (const w of words) {
    if (out && (out + "-" + w).length > ANCHOR_NAME_CELL) break;
    // One exception to the word-boundary rule, and the only one: a single word
    // longer than the cell has no boundary to cut on, so it is cut anyway.
    out = out ? out + "-" + w : w.slice(0, ANCHOR_NAME_CELL);
  }
  return out || null;
}

// ─── Session-name anchor state (on-disk half) ─────────────────────────
//
// Same discipline as the entry-rule score directory above, and for the same
// reason stated there: NOTHING here routes through writeSessionState. A tally
// incremented on every vault write is the highest-frequency writer in this
// system, and that function's read-modify-write would eventually truncate the
// ADR-006 statusline pointer out from under an unrelated feature.
//
// So a tally is a file that only ever grows by one byte: O_APPEND of a single
// byte is atomic, the count is the file's size, and no reader-writer pair
// exists. Concurrent subagents cannot lose each other's increment.
//
// The incumbent/last-offered record is the one small piece that must be read
// back, and it lives in its OWN file for exactly that reason. It is written at
// most once per offer (once or twice a session), and its worst failure — a torn
// read after a crash — costs one duplicate offer and nothing else. Putting it in
// the shared session state would trade that for a blank statusline.

export function anchorDir(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.anchor`);
}

function anchorSlot(key, leaf) {
  const h = createHash("sha1").update(leaf ? `${key}\u0000${leaf}` : key).digest("hex").slice(0, 16);
  return leaf ? `l${h}` : `k${h}`;
}

// One byte per event, plus a sidecar naming the key. The sidecar is written
// with identical bytes every time, so a concurrent rewrite is a no-op rather
// than a race.
export function bumpAnchor(projectDir, sessionId, key, leaf = null) {
  try {
    const dir = anchorDir(projectDir, sessionId);
    ensureStateDir(projectDir);
    mkdirSync(dir, { recursive: true });
    const slot = anchorSlot(key, leaf);
    // Create-only. The default flag is O_CREAT|O_TRUNC, so rewriting "the same
    // bytes" is still observably empty to a concurrent reader — measured at ~4%
    // of reads losing an entire key, which is the very O_TRUNC failure the
    // entry-rule banner above condemns. `wx` throws EEXIST after the first
    // bump; the inner catch is load-bearing, or the tally append below would be
    // skipped along with it.
    try {
      writeFileSync(join(dir, `${slot}.name`), leaf ? `${key}\n${leaf}` : key, { flag: "wx" });
    } catch {}
    writeFileSync(join(dir, slot), "x", { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

// Rebuild the pure rule's state shape from disk. Sizes are the tallies, so a
// partially-written sidecar loses one key's name rather than the whole tally.
export function readAnchorState(projectDir, sessionId) {
  const st = emptyAnchorState();
  let names;
  try {
    names = readdirSync(anchorDir(projectDir, sessionId));
  } catch {
    return st;
  }
  const dir = anchorDir(projectDir, sessionId);
  for (const f of names) {
    if (!f.endsWith(".name")) continue;
    const slot = f.slice(0, -5);
    let raw, n;
    try {
      raw = readFileSync(join(dir, f), "utf8");
      n = statSync(join(dir, slot)).size;
    } catch { continue; }
    if (!raw || !n) continue;
    if (slot.startsWith("k")) {
      st.counts[raw] = n;
    } else {
      const nl = raw.indexOf("\n");
      if (nl < 0) continue;
      const key = raw.slice(0, nl), leaf = raw.slice(nl + 1);
      st.leaves[key] = { ...(st.leaves[key] || {}), [leaf]: n };
    }
  }
  const rec = readAnchorOffer(projectDir, sessionId);
  st.incumbent = rec.incumbent;
  st.offered = rec.offered;
  return st;
}

function anchorOfferPath(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.anchor.json`);
}

export function readAnchorOffer(projectDir, sessionId) {
  try {
    const d = JSON.parse(readFileSync(anchorOfferPath(projectDir, sessionId), "utf8"));
    return {
      incumbent: typeof d.incumbent === "string" ? d.incumbent : null,
      offered: typeof d.offered === "string" ? d.offered : null,
      // A name the PERSON chose is not ours to talk over. Recorded when we see
      // the session already carrying a name we did not compose.
      declined: Array.isArray(d.declined) ? d.declined : [],
      // Every name we have composed this session. A session almost always
      // arrives already wearing a harness-assigned name, so "the current name
      // is not our last offer" cannot mean "the person chose it" — that reading
      // silenced the feature permanently for every real session.
      offers: Array.isArray(d.offers) ? d.offers : [],
    };
  } catch {
    // Every field the success path returns, or a caller reading one that only
    // exists on the happy path throws — and a hook swallows that into silence,
    // which looks exactly like the mechanism deciding to stay quiet.
    return { incumbent: null, offered: null, declined: [], offers: [] };
  }
}

export function writeAnchorOffer(projectDir, sessionId, rec) {
  try {
    ensureStateDir(projectDir);
    writeFileSync(anchorOfferPath(projectDir, sessionId), JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

// ─── Session-name offer (delivery half) ───────────────────────────────

// Names live peers already hold. Read from the harness's own registry of live
// sessions, which is how names are arbitrated machine-wide: a duplicate is not
// merely confusing, it is a second session answering to one address.
//
// This sees ACCEPTED names only. Two sessions that settle on the same anchor
// within moments of each other both pass this check and both offer the same
// name — the race is narrowed, not closed, and the ADR says so.
export function liveSessionNames(selfSessionId, dir = null) {
  const root = dir || join(claudeHome(), "sessions");
  const out = [];
  let files;
  try { files = readdirSync(root); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(root, f), "utf8"));
      if (!d || typeof d.name !== "string" || !d.name) continue;
      // Match on session id, never on pid: this process is the hook's, not the
      // session's, and its parent is not reliably the session either.
      if (selfSessionId && d.sessionId === selfSessionId) continue;
      out.push({ name: d.name, sessionId: d.sessionId || null });
    } catch {}
  }
  return out;
}

// What this session is currently called, if the harness has recorded a name.
export function ownSessionName(selfSessionId, dir = null) {
  const root = dir || join(claudeHome(), "sessions");
  let files;
  try { files = readdirSync(root); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(root, f), "utf8"));
      if (d && d.sessionId === selfSessionId && typeof d.name === "string" && d.name) return d.name;
    } catch {}
  }
  return null;
}

// The offer, or null when it must stay silent. Every suppression here is a
// decision the ADR names; none of them is an implementation detail.
export function sessionNameOffer(name, { peers = [], current = null, declined = [] } = {}) {
  if (!name) return null;
  // Never talk over a name the person chose. `declined` carries names we have
  // seen the session wear that we did not compose.
  if (current && current !== name && declined.includes(current)) return null;
  if (current === name) return null;                       // already wearing it
  const taken = new Set(peers.map((p) => p && p.name).filter(Boolean));
  if (!taken.has(name)) return { name, qualified: false };
  // Taken. Qualify rather than skip: the anchor is still the honest answer, and
  // a session that stays unnamed because a peer got there first is the worse
  // outcome. Two suffixes is the whole ladder — a third collision means the
  // name is not discriminating and silence is the better answer.
  for (const suffix of ["-2", "-3"]) {
    if (!taken.has(name + suffix)) return { name: name + suffix, qualified: true };
  }
  return null;
}

export function sessionNameOfferText(offer) {
  if (!offer || !offer.name) return null;
  return offer.qualified
    ? `projectstore: this session looks like "${offer.name}" (a peer holds the unqualified name) — /rename ${offer.name}`
    : `projectstore: this session looks like "${offer.name}" — /rename ${offer.name}`;
}

// ─── Frontmatter parsing (minimal) ─────────────────────────────────────

export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { data: {}, body: md };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "null") v = null;
    else if (v.startsWith('"') && v.endsWith('"')) {
      // JSON.parse round-trips escaped scalars from renderTemplate's _json
      // form (titles containing quotes); fall back to the bare strip.
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    data[kv[1]] = v;
  }
  return { data, body: md.slice(m[0].length) };
}

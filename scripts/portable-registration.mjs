// Portable Agent Plugin registration state. This module is selected by a
// surface format in the harness manifest; it contains no harness-id branch and
// performs no host mutation.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { whichOnPath } from "./lib.mjs";

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const samePath = (a, b) => {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return Boolean(a && b) && real(a) === real(b);
};

function parseValue(raw) {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

export function readTomlSections(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return new Map(); }
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (header) { current = header[1]; if (!sections.has(current)) sections.set(current, {}); continue; }
    if (!current || /^\s*(?:#|$)/.test(line)) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (kv) sections.get(current)[kv[1]] = parseValue(kv[2]);
  }
  return sections;
}

export function payloadFiles(root) {
  const out = [];
  const walk = (at, rel = "") => {
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".DS_Store")) continue;
      const abs = join(at, e.name), next = rel ? `${rel}/${e.name}` : e.name;
      // npm creates command shims as symlinks here. The shell invokes the
      // bundled core by its real path, so these convenience links are neither
      // runtime input nor portable plugin payload.
      if (next === "node_modules/.bin" || next.startsWith("node_modules/.bin/")) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`plugin payload contains a symlink: ${next}`);
      if (st.isDirectory()) walk(abs, next); else if (st.isFile()) out.push(next);
    }
  };
  walk(root);
  return out.sort();
}

export function payloadDigest(root) {
  const files = payloadFiles(root);
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel + "\n");
    h.update(createHash("sha256").update(readFileSync(join(root, rel))).digest("hex") + "\n");
  }
  return { count: files.length, sha256: h.digest("hex") };
}

export function portableRegistrationPaths(s, { home = homedir(), projectDir, harness, env = process.env } = {}) {
  const r = harness.runtime || {};
  const harnessHome = (r.home_env && env[r.home_env]) || join(home, r.home_default);
  const dir = join(harnessHome, ...s.dir);
  return {
    home: harnessHome,
    dir,
    lock: join(harnessHome, "projectstore", `${s.marketplace_name}.lock`),
    journal: join(harnessHome, "projectstore", `${s.marketplace_name}.journal.json`),
    catalog: join(dir, s.manifest),
    ownership: join(dir, s.ownership_manifest),
    payload: join(dir, ...s.plugin_subdir.split("/")),
    globalConfig: join(harnessHome, ...(s.registry.global_config || ["config.toml"])),
    projectConfig: join(projectDir, r.harness_dir, ...(s.registry.project_config || ["config.toml"])),
    cacheDir: join(harnessHome, ...(s.registry.cache_dir || ["plugins", "cache"])),
  };
}

export function renderPortableCatalog(s) {
  return {
    name: s.marketplace_name,
    interface: { displayName: "ProjectStore (npm)" },
    plugins: [{
      name: s.plugin_name,
      source: { source: "local", path: `./${s.plugin_subdir}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  };
}

function pluginTable(id) { return `plugins.${JSON.stringify(id)}`; }
function marketplaceTable(name) { return `marketplaces.${name}`; }

function pluginIds(sections) {
  const ids = [];
  for (const key of sections.keys()) {
    const m = key.match(/^plugins\.(.+)$/);
    if (!m) continue;
    try { ids.push(m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]); } catch {}
  }
  return ids;
}

function cacheEntries(paths, s) {
  const base = join(paths.cacheDir, s.marketplace_name, s.plugin_name);
  let names;
  try { names = readdirSync(base); } catch { return []; }
  return names.map((name) => {
    const path = join(base, name);
    const manifest = readJson(join(path, "plugin.json")) || readJson(join(path, ".codex-plugin", "plugin.json"));
    let at = 0; try { at = statSync(path).mtimeMs; } catch {}
    if (!manifest || typeof manifest.version !== "string") return null;
    let digest = null;
    try { digest = payloadDigest(path); } catch {}
    return { path, version: manifest.version, at, digest };
  }).filter(Boolean).sort((a, b) => b.at - a.at || b.version.localeCompare(a.version));
}

// Where the payload to register lives. A surface conditioned on a distribution
// root has one only when a distribution shell named itself
// (PROJECTSTORE_DISTRIBUTION_ROOT) AND that root is a portable plugin root: the
// Claude Code shell sets the same variable, and the core alone is never a
// payload. Null means nothing is registered from this run — callers defer and
// never fall back to the core. That fallback is how doctor came to report
// "<core> is not a portable plugin root" in any project that merely contained
// the harness's directory (S2 of the 2026-10-03 review in "The Codex shell's
// plugin root: .codex-plugin, the rendered surfaces, and the first Codex
// install").
export function portablePayloadRoot(s, { root, env = process.env } = {}) {
  const named = env.PROJECTSTORE_DISTRIBUTION_ROOT || null;
  if (s.condition !== "distribution_root") return named || root;
  if (!named) return null;
  return existsSync(join(named, "plugin.json")) || existsSync(join(named, ".codex-plugin", "plugin.json")) ? named : null;
}

export function analysePortableRegistration(projectDir, s, { root, payloadRoot: explicitPayloadRoot = null, home = homedir(), harness, env = process.env, ignoreJournal = false } = {}) {
  const paths = portableRegistrationPaths(s, { home, projectDir, harness, env });
  const payloadRoot = explicitPayloadRoot || portablePayloadRoot(s, { root, env });
  const desiredManifest = payloadRoot ? (readJson(join(payloadRoot, "plugin.json")) || readJson(join(payloadRoot, ".codex-plugin", "plugin.json"))) : null;
  const desiredVersion = desiredManifest?.version || null;
  const id = `${s.plugin_name}@${s.marketplace_name}`;
  const bin = whichOnPath(s.cli.bin, env);
  const ownership = readJson(paths.ownership)?.[s.provenance_key] || null;
  const journal = readJson(paths.journal);
  const catalog = readJson(paths.catalog);
  const global = readTomlSections(paths.globalConfig);
  const project = readTomlSections(paths.projectConfig);
  const market = global.get(marketplaceTable(s.marketplace_name)) || null;
  const globalPlugin = global.get(pluginTable(id)) || null;
  const projectPlugin = project.get(pluginTable(id)) || null;
  const enabled = typeof projectPlugin?.enabled === "boolean" ? projectPlugin.enabled : globalPlugin?.enabled === true;
  const others = [...new Set([...pluginIds(global), ...pluginIds(project)])]
    .filter((other) => other !== id && other.split("@")[0] === s.plugin_name)
    .map((other) => {
      const g = global.get(pluginTable(other)) || null, p = project.get(pluginTable(other)) || null;
      return { id: other, enabled: typeof p?.enabled === "boolean" ? p.enabled : g?.enabled === true };
    });
  const caches = cacheEntries(paths, s);
  const installed = caches.find((e) => e.version === desiredVersion) || caches[0] || null;
  const out = { id, paths, path: paths.dir, payloadRoot, desiredVersion, bin, ownership, journal, catalog, market, globalPlugin, projectPlugin, enabled, others, caches, installed, installPath: installed?.path || null, installedVersion: installed?.version || null, state: "absent", reason: null, produced: Boolean(desiredManifest), contentDiffers: null };
  const enabledOther = others.find((other) => other.enabled);
  const nothing = !existsSync(paths.dir) && !market && !globalPlugin && !installed && !enabledOther;
  if (!desiredManifest) return { ...out, state: "unavailable", reason: payloadRoot ? `${payloadRoot} is not a portable plugin root` : `nothing to register from this run: ${harness?.display_name || "this harness"}'s plugin is registered from its distribution shell, not from the core` };
  if (!bin && nothing) return { ...out, state: "unavailable", reason: `\`${s.cli.bin}\` is not on PATH — the registration needs the host CLI` };
  let desiredDigest = null;
  try { desiredDigest = payloadDigest(payloadRoot); } catch (e) { return { ...out, state: "unavailable", reason: e.message }; }
  out.desiredDigest = desiredDigest;
  if (enabledOther) return { ...out, state: "conflict", refusal: `${enabledOther.id} is already enabled; two ProjectStore plugins would load the same skills and hooks. Disable or remove that registration explicitly, then retry` };
  // A journal the rollback could not prove names the run that left it, when,
  // and its error, so the reader of the plan is not told recovery is assured
  // (issue #28). Every other phase reads as before.
  if (journal && !ignoreJournal) return { ...out, state: "stale", reason: journal.phase === "recovery-required"
    ? `a previous run${journal.failed_at ? ` (${journal.failed_at})` : ""} could not prove its restore: ${String(journal.error || "no error recorded").split("\n")[0]}; this run re-proves the previous state before applying this plan, and refuses if it cannot (${paths.journal})`
    : "an interrupted registration has a recovery journal; the next confirmed run recovers it before applying this plan" };
  if (existsSync(paths.dir) && !ownership) return { ...out, state: "foreign", refusal: `${paths.dir} exists without ${s.ownership_manifest}; a source this installer does not own holds the stable marketplace path` };
  if (market?.source && !samePath(market.source, paths.dir)) return { ...out, state: "foreign", refusal: `${paths.globalConfig} points marketplace ${s.marketplace_name} at ${market.source}, not ${paths.dir}` };
  if (nothing) return out;
  let sourceDigest = null;
  try { if (existsSync(paths.payload)) sourceDigest = payloadDigest(paths.payload); } catch {}
  out.sourceDigest = sourceDigest;
  out.contentDiffers = Boolean(ownership?.digest) && (ownership.digest.sha256 !== desiredDigest.sha256 || ownership.digest.count !== desiredDigest.count);
  if (!ownership || !catalog) return { ...out, state: "stale", reason: "the owned marketplace source is incomplete" };
  if (ownership.version === desiredVersion && out.contentDiffers) return { ...out, state: "conflict", refusal: `release ${desiredVersion} already owns this marketplace with a different payload digest` };
  if (!sourceDigest || sourceDigest.sha256 !== ownership.digest?.sha256 || sourceDigest.count !== ownership.digest?.count) return { ...out, state: "stale", reason: "the stable source does not match its recorded digest" };
  if (!market) return { ...out, state: "stale", reason: "the host does not know the marketplace" };
  if (!installed || installed.version !== ownership.version) return { ...out, state: "stale", reason: "the host cache does not contain the registered payload version" };
  if (!installed.digest || installed.digest.sha256 !== ownership.digest?.sha256 || installed.digest.count !== ownership.digest?.count) return { ...out, state: "stale", reason: "the materialised host cache does not match the registered payload digest" };
  if (ownership.version !== desiredVersion) return { ...out, state: "stale", reason: `installed ${ownership.version}; package offers ${desiredVersion}` };
  return { ...out, state: "current", reason: enabled ? null : "installed globally but disabled by effective configuration" };
}

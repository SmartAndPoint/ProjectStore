// projectstore — surfaces.mjs
//
// The STATE of every installed surface, read but never written: what is on
// disk at each path the manifest names, whether it is ours, and if so whether
// it is current. install-harness.mjs turns these states into actions behind
// its gate; doctor turns them into findings. Neither derives a state itself,
// so the two can never disagree about a file — and neither knows a harness
// id: everything here is keyed by the manifest's surfaces.<key>.kind and
// .format.
//
// Direction: installer → surfaces ← doctor, and surfaces → provenance,
// lib.mjs. Doctor imports this module DYNAMICALLY, inside the one check that
// needs it, because hooks/session-start.mjs imports doctor statically and the
// install spec keeps provenance.mjs out of the SessionStart module graph.
//
// Read-only by construction: no write call appears here (the suite greps for
// them). stamp() is a pure render; its text is what install would write and
// its hash is what the state ladder compares.
//
// Normative: the install spec — contract 0 (exclusive vs shared), 3–4 (the
// four states and the ladder, rungs 1′ and 1″ included), 6 (per-entry states
// for shared files: ours-current, ours-stale, ours-absent, unparseable),
// 12 (current, last written by), 14 (host-managed surfaces have no state to
// derive), 16 (a harness is in use when detected or when it has files of
// ours). Pure node, no external deps.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadHarnesses, loadHarness, harnessIds, detectHarnesses, sourceHarness, MANIFEST_DIR } from "./harness.mjs";
import { stamp, deriveState, parseProvenance, sourceHash, STALE, STALE_TEXT, FOREIGN_TEXT } from "./provenance.mjs";
import {
  pluginRoot,
  renderStatusLineLauncher,
  statusLineIsOurWiring,
  isPluginCacheRoot,
  desiredStatusLineCommand,
  findAgentsBlock,
  agentsBlockVersion,
  agentsBlockTemplatePath,
  renderAgentsBlock,
  loadLayout,
  readConfigAt,
  claudeHome,
  whichOnPath,
  installedPluginEntries,
  pluginEnabled,
  treeDigest,
  packageDigest,
  cmpVersion,
  LAUNCHER_HEADER,
} from "./lib.mjs";

export const GENERATOR = "scripts/install-harness.mjs";
export const INSTALLED_REMEDY = "projectstore doctor reports this file when it is stale; run install again to refresh it.";
// The line every launcher has carried since the template was written; the
// recogniser for a pre-provenance launcher (contract 4, rung 1″). A substring
// of the template's own header, so a reworded comment cannot turn every
// existing install foreign.
export { LAUNCHER_HEADER };

export function readText(p) {
  if (!existsSync(p)) return { present: false, text: null };
  try {
    return { present: true, text: readFileSync(p, "utf8") };
  } catch {
    return { present: true, text: null };
  }
}

export function pluginVersionAt(root, harness) {
  const rel = harness?.version_file || sourceHarness()?.version_file || ".claude-plugin/plugin.json";
  try {
    return String(JSON.parse(readFileSync(join(root, rel), "utf8")).version || "");
  } catch {
    return "";
  }
}

// Is this text a file we wrote — stamped, or a pre-provenance launcher?
export function isOurFile(text) {
  if (typeof text !== "string") return false;
  return Boolean(parseProvenance(text)) || text.includes(LAUNCHER_HEADER);
}

// ─── markdown-block: the ADR-002 block ─────────────────────────────────

export function analyseBlock(projectDir, s, { root = pluginRoot() } = {}) {
  const files = s.files || ["AGENTS.md", "CLAUDE.md"];
  const PREFERRED = files[0], FALLBACK = files[files.length - 1];
  const found = files.map((f) => ({ file: f, path: join(projectDir, f), ...readText(join(projectDir, f)) }))
    .map((e) => ({ ...e, block: e.text !== null ? findAgentsBlock(e.text) : null }));
  const withBlock = found.filter((e) => e.block);
  const preferred = found.find((e) => e.file === PREFERRED && e.present) || found.find((e) => e.file === FALLBACK);
  const claude = found.find((e) => e.file === FALLBACK);
  const importLine = `@${PREFERRED}`;
  const a = { files: found, withBlock, preferred, claude, importLine, PREFERRED, FALLBACK, entryKey: "projectstore:agents", version: null, desired: null, current: null, state: "ours-absent", reason: null, refusal: null };

  const unclosed = withBlock.find((e) => e.block.unclosed);
  if (unclosed && unclosed.block.wrapped) return { ...a, state: "unparseable", refusal: `${unclosed.file}:${unclosed.block.line}: the projectstore:agents open marker does not close on its own line — the parser reads one line. Put \`-->\` back on the marker's line, then run /projectstore:agents register` };
  if (unclosed) return { ...a, state: "unparseable", refusal: `${unclosed.file}: the block opens and never closes — restore the closing marker or remove the block by hand` };
  const twice = withBlock.find((e) => e.block.count > 1);
  if (twice) return { ...a, state: "unparseable", refusal: `${twice.file} carries the block more than once — keep exactly one` };

  const tmpl = readText(agentsBlockTemplatePath(root));
  if (!tmpl.present || tmpl.text === null) return { ...a, state: "unparseable", refusal: `the block's source is missing from the plugin at ${agentsBlockTemplatePath(root)}` };
  a.version = agentsBlockVersion(tmpl.text);
  const cfg = readConfigAt(projectDir);
  let roster = null;
  if (cfg && typeof cfg.layout === "string") {
    try { roster = loadLayout(cfg.layout, root).agents || null; } catch { roster = null; }
  }
  a.desired = renderAgentsBlock(tmpl.text, roster);
  a.current = withBlock.find((e) => e.file === preferred.file) || withBlock[0] || null;
  a.duplicates = withBlock.filter((e) => e !== a.current);
  if (!a.current) return { ...a, state: "ours-absent" };
  if (a.current.file !== preferred.file && preferred.present) return { ...a, state: "ours-stale", reason: `in ${a.current.file}; install migrates it to ${preferred.file}` };
  if (a.duplicates.length) return { ...a, state: "ours-stale", reason: `also in ${a.duplicates.map((e) => e.file).join(", ")}; install keeps the one in ${a.current.file}` };
  if (a.current.block.v === a.version && a.current.block.block === a.desired) return { ...a, state: "ours-current" };
  return { ...a, state: "ours-stale", reason: a.current.block.v !== a.version ? `v${a.current.block.v} → v${a.version}` : "content differs from the current source" };
}

// ─── json-entry: one entry in a JSON file the user co-owns ─────────────

// `renderRoot` (contract 4′, two phases): the root the surface is planned
// AGAINST — the host's install path a registration produces — when it differs
// from the root the templates are read from. Defaults to `root`.
export function analyseJsonEntry(projectDir, s, { root = pluginRoot(), home = homedir(), renderRoot = root } = {}) {
  const path = join(projectDir, s.file);
  const pointer = s.marker?.pointer || "statusLine.command";
  const entryKey = pointer.split(".")[0];
  const cur = readText(path);
  const a = { path, entryKey, cur, settings: {}, curEntry: null, curCmd: null, ours: false, desired: null, state: "ours-absent", reason: null };
  if (cur.present) {
    if (cur.text === null) return { ...a, state: "unparseable", reason: "the file cannot be read" };
    try { a.settings = JSON.parse(cur.text); } catch { return { ...a, state: "unparseable", reason: "the file is not valid JSON — nothing outside a marked entry is touched, so nothing is written" }; }
    if (!a.settings || typeof a.settings !== "object" || Array.isArray(a.settings)) return { ...a, state: "unparseable", reason: "the file is not a JSON object" };
  }
  a.curEntry = a.settings[entryKey] ?? null;
  a.curCmd = a.curEntry && typeof a.curEntry.command === "string" ? a.curEntry.command : null;
  // "Did we write this?" is asked of the EXISTING entry, written by whatever
  // root was current then: a dev checkout's direct wiring stays ours when the
  // plan now renders against a registration's install path (reviewer, 2026-09-05).
  a.ours = statusLineIsOurWiring(a.curCmd, projectDir, home, root) || statusLineIsOurWiring(a.curCmd, projectDir, home, renderRoot);
  a.desired = desiredStatusLineCommand(projectDir, renderRoot, home).command;
  if (!a.curEntry) return { ...a, state: "ours-absent" };
  if (!a.ours) return { ...a, state: "theirs", reason: "a status line we did not write owns the slot" };
  if (a.curCmd === a.desired) return { ...a, state: "ours-current" };
  return { ...a, state: "ours-stale", reason: "the command no longer matches this installation" };
}

// ─── mjs: an exclusive, provenance-stamped file ────────────────────────

export function analyseStampedFile(projectDir, s, { root = pluginRoot(), home = homedir(), harness = null, renderRoot = root } = {}) {
  const path = join(projectDir, s.file);
  const file = readText(path);
  const a = { path, file, produced: true, ours: null, refusal: null, stamped: null, state: "absent", reason: null, writtenBy: null, sameProject: false, legacy: false, renderRoot };
  if (s.condition === "plugin_cache_install" && !isPluginCacheRoot(renderRoot, home)) {
    // Not produced for this installation (a dev checkout is wired directly).
    a.produced = false;
    if (!file.present) return { ...a, state: "absent" };
    a.ours = isOurFile(file.text);
    return { ...a, state: a.ours ? "stale" : "foreign", reason: a.ours ? "not produced for this installation (a dev checkout is wired directly) — left in place; a prune of a launcher this root did not write needs the root that wrote it, or uninstall" : null };
  }
  const src = join(root, s.source);
  const tpl = readText(src);
  if (!tpl.present || tpl.text === null) return { ...a, state: "unparseable", refusal: `the source ${s.source} is missing from the plugin at ${root}` };
  const rendered = renderStatusLineLauncher(tpl.text, renderRoot);
  if (rendered === null) return { ...a, state: "unparseable", refusal: "the launcher template is not one this installer knows how to fill" };
  const pkg = pluginVersionAt(root, harness) || "0.0.0";
  a.pkg = pkg;
  a.stamped = stamp(rendered, { format: s.format, src: s.source, srcHash: sourceHash(tpl.text), pkg, project: projectDir, harness: harness?.id || sourceHarness()?.id || "harness", generator: GENERATOR, remedy: INSTALLED_REMEDY });
  let st = deriveState({ file, sourceHash: sourceHash(tpl.text), pkg, renderNowHash: a.stamped.render, project: projectDir });
  // Contract 4, rung 1″: a launcher written before provenance existed carries
  // no line but the template's own header. It is ours, stale, replaceable.
  if (st.state === "foreign" && typeof file.text === "string" && file.text.includes(LAUNCHER_HEADER)) { st = { ...st, state: "stale", reason: STALE.PLUGIN }; a.legacy = true; }
  a.installedPkg = st.provenance?.pkg || null;
  return { ...a, state: st.state, reason: st.reason ? STALE_TEXT[st.reason] + (a.legacy ? " (pre-provenance file)" : "") : null, writtenBy: st.writtenBy, sameProject: st.sameProject };
}

// ─── host-plugin-registration: our marketplace directory + the host's registry ──
//
// Contract 4′ (2026-09-05): a total, ordered function over registry facts —
// our directory under the harness home (owned as a whole, recognised by the
// provenance field in its manifest), the host's marketplace and plugin
// registries, the project's settings, and PATH. Reads only; the host binary is
// located, never run.

function samePath(a, b) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return Boolean(a && b) && real(a) === real(b);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function registrationPaths(s, { home = homedir(), projectDir = null, harness = null } = {}) {
  const hh = claudeHome(home);
  const dir = join(hh, ...s.dir);
  const reg = s.registry || {};
  const cfgDir = harness?.runtime?.project_config_dir || ".claude";
  return {
    dir,
    manifest: join(dir, s.manifest),
    payload: join(dir, s.plugin_subdir),
    installed: join(hh, ...(reg.installed || ["plugins", "installed_plugins.json"])),
    marketplaces: join(hh, ...(reg.marketplaces || ["plugins", "known_marketplaces.json"])),
    cacheDir: join(hh, ...(reg.cache_dir || ["plugins", "cache"])),
    projectSettings: projectDir ? join(projectDir, cfgDir, ...(reg.project_settings || ["settings.json"])) : null,
    userSettings: join(hh, ...(reg.user_settings || ["settings.json"])),
  };
}

export function analyseRegistration(projectDir, s, { root = pluginRoot(), home = homedir(), harness = null, env = process.env } = {}) {
  const id = `${s.plugin_name}@${s.marketplace_name}`;
  const paths = registrationPaths(s, { home, projectDir, harness });
  const pkg = pluginVersionAt(root, harness) || "0.0.0";
  const a = { id, paths, path: paths.dir, entryKey: id, pkg, bin: whichOnPath(s.cli?.bin || "claude", env), produced: !(s.condition === "npm_package_root" && isPluginCacheRoot(root, home)),
    dir: { present: existsSync(paths.dir), manifest: null, prov: null, pkg: null, disabled: [], digestOk: null }, known: null, registeredHere: null, installed: null, installedVersion: null, installPath: null,
    enabled: null, others: [], otherProjects: 0, writtenBy: null, newer: false, state: "absent", reason: null, refusal: null };

  // Machine-global facts: our directory, the host's marketplace registry, every row of ours.
  if (a.dir.present) {
    a.dir.manifest = readJson(paths.manifest);
    const prov = a.dir.manifest && a.dir.manifest[s.provenance_key];
    if (prov && typeof prov === "object" && typeof prov.pkg === "string") {
      a.dir.prov = prov; a.dir.pkg = prov.pkg;
      a.dir.disabled = Array.isArray(prov.disabled) ? prov.disabled.filter((x) => typeof x === "string") : [];
      if (typeof prov.project === "string" && !samePath(prov.project, projectDir)) a.writtenBy = prov.project;
      // The payload digest: a copy that did not finish, or a hand edit, is not current.
      if (prov.digest && typeof prov.digest.sha256 === "string") {
        try { const d = treeDigest(paths.payload); a.dir.digestOk = d.count === prov.digest.count && d.sha256 === prov.digest.sha256; } catch { a.dir.digestOk = false; }
      } else a.dir.digestOk = null; // no digest recorded: nothing to compare
    }
  }
  const known = readJson(paths.marketplaces);
  const mp = known && known[s.marketplace_name];
  a.known = mp ? { path: (mp.installLocation || mp.source?.path || null), source: mp.source?.source || null } : null;
  const all = installedPluginEntries(home, projectDir).filter((e) => e.key === id);
  // Per-project facts: the checkout's own settings file and the registry row carrying its path.
  const local = readJson(paths.projectSettings);
  const here = local && local[s.registry?.known_pointer || "extraKnownMarketplaces"] && local[s.registry?.known_pointer || "extraKnownMarketplaces"][s.marketplace_name];
  a.registeredHere = here ? { path: here.source?.path || null } : null;
  const enabledHere = (local && local[s.registry?.enabled_pointer || "enabledPlugins"]) || {};
  a.disabledHere = Object.keys(enabledHere).filter((k) => enabledHere[k] === false);
  const mine = all.filter((e) => e.projectPath && samePath(e.projectPath, projectDir));
  a.otherProjects = all.filter((e) => !e.projectPath || !samePath(e.projectPath, projectDir)).length;
  const row = mine.find((e) => e.present) || mine[0] || null;
  a.installed = row ? { path: row.path, version: row.version, present: row.present, scope: row.scope } : null;
  a.installPath = row ? row.path : null;
  a.installedVersion = row ? row.version : null;
  a.enabled = pluginEnabled(id, home, projectDir);
  // Competing registrations of the same plugin, enabled for this project.
  const seen = new Set();
  for (const e of installedPluginEntries(home, projectDir)) {
    if (e.key === id || seen.has(e.key) || !e.present || e.enabled === false) continue;
    if (e.projectPath && !samePath(e.projectPath, projectDir)) continue;
    seen.add(e.key); a.others.push({ key: e.key, path: e.path, version: e.version });
  }
  a.newer = Boolean(a.dir.pkg) && cmpVersion(a.dir.pkg, pkg) > 0;
  // Same version, different payload: the directory's recorded digest against
  // this package's — contract 4's rung 3 (source changed) for a directory.
  a.contentDiffers = null;
  if (a.dir.prov && a.dir.pkg === pkg && a.dir.prov.digest && typeof a.dir.prov.digest.sha256 === "string") {
    try { const d = packageDigest(root); a.contentDiffers = d.sha256 !== a.dir.prov.digest.sha256 || d.count !== a.dir.prov.digest.count; } catch { a.contentDiffers = null; }
  }
  // The version the host would install from the directory as it will stand after this run.
  a.targetPkg = a.newer ? a.dir.pkg : pkg;
  a.predictedInstallPath = join(paths.cacheDir, s.marketplace_name, s.plugin_name, a.targetPkg);
  const nothingOfOursHere = !a.registeredHere && !mine.length;
  const nothingOfOurs = !a.dir.present && !a.known && !all.length && nothingOfOursHere;
  const bin = s.cli?.bin || "claude";

  // The ladder (contract 4′).
  if (!a.bin && nothingOfOurs) return { ...a, state: "unavailable", reason: `\`${bin}\` is not on PATH — the registration needs the host's CLI; the other surfaces still install` };
  if (a.dir.present && !a.dir.prov) return { ...a, state: "foreign", refusal: `${paths.dir} exists and its ${s.manifest} carries no \`${s.provenance_key}\` field of ours — a directory we did not write sits at our path; move it if it is yours, or delete it to let install take the name` };
  if (a.known && a.known.path && !samePath(a.known.path, paths.dir)) return { ...a, state: "foreign", refusal: `the host's registry names marketplace \`${s.marketplace_name}\` at ${a.known.path}, not at ${paths.dir} — a registration we did not make holds our name; \`${bin} plugin marketplace remove ${s.marketplace_name}\` lets install take it` };
  if (a.registeredHere && a.registeredHere.path && !samePath(a.registeredHere.path, paths.dir)) return { ...a, state: "foreign", refusal: `${paths.projectSettings} declares marketplace \`${s.marketplace_name}\` at ${a.registeredHere.path}, not at ${paths.dir} — remove that entry to let install take the name` };
  if (nothingOfOurs) return { ...a, state: "absent" };
  // The directory is shared by every checkout on the machine; a project that never registered is absent, whatever the directory holds.
  if (nothingOfOursHere) return { ...a, state: "absent", reason: a.dir.present ? `the marketplace directory is present${a.writtenBy ? ` (written from ${a.writtenBy})` : ""}; this checkout is not registered` : null };
  if (!a.dir.present) return { ...a, state: "stale", reason: STALE_TEXT[STALE.PLUGIN] + " (the directory is gone)" };
  if (cmpVersion(a.dir.pkg, pkg) < 0) return { ...a, state: "stale", reason: STALE_TEXT[STALE.PLUGIN] + ` (directory at ${a.dir.pkg}, package at ${pkg})` };
  if (a.dir.digestOk === false) return { ...a, state: "stale", reason: "edited by hand or half-written (the payload does not match the digest its manifest carries)" };
  if (a.contentDiffers === true) return { ...a, state: "stale", reason: STALE_TEXT[STALE.PLUGIN] + ` (same version ${pkg}, different content — the directory's digest is not this package's)` };
  if (!a.known || !a.registeredHere) return { ...a, state: "stale", reason: STALE_TEXT[STALE.CONFIG] + (a.known ? " (this checkout does not declare the marketplace)" : " (the host does not know the marketplace)") };
  if (!a.installed || !a.installed.present) return { ...a, state: "stale", reason: "not installed" + (a.installed ? " (the host's install path is gone)" : " (registered, not installed for this checkout)") };
  if (a.installedVersion !== a.dir.pkg) return { ...a, state: "stale", reason: STALE_TEXT[STALE.PLUGIN] + ` (installed ${a.installedVersion}, directory ${a.dir.pkg})` };
  if (!a.enabled) return { ...a, state: "stale", reason: "disabled for this checkout" };
  return { ...a, state: "current", reason: a.newer ? `the directory is at ${a.dir.pkg}, newer than this package (${pkg})${a.writtenBy ? `, written from ${a.writtenBy}` : ""} — not downgraded` : null };
}

// ─── every surface, for doctor ─────────────────────────────────────────

const ANALYSERS = { "markdown-block": analyseBlock, "json-entry": analyseJsonEntry, "mjs": analyseStampedFile, "host-plugin-registration": analyseRegistration };

// The states of every non-host, supported surface of every harness this
// project uses — detected by directory, or carrying a file of ours (contract
// 16). Host-managed rows have nothing to derive (contract 14).
export function surfaceStates(projectDir, { home = homedir(), root = pluginRoot(), manifestDir = MANIFEST_DIR, harnesses = null } = {}) {
  projectDir = resolve(projectDir);
  const detected = detectHarnesses(projectDir, { dir: manifestDir }).map((d) => d.id);
  const out = { projectDir, detected, used: [], installable: harnessIds(manifestDir), states: [] };
  for (const m of loadHarnesses(manifestDir).values()) {
    if (harnesses && !harnesses.includes(m.id)) continue;
    const rows = Object.entries(m.surfaces || {}).filter(([k, s]) => !k.startsWith("_") && s.kind !== "host" && s.supported !== false && ANALYSERS[s.format]);
    const states = [];
    for (const [key, s] of rows) {
      const a = ANALYSERS[s.format](projectDir, s, { root, home, harness: m });
      const entry = s.kind === "shared" ? (a.entryKey || s.marker?.pointer || null) : null;
      const path = a.path || (a.current ? a.current.path : (a.preferred ? a.preferred.path : join(projectDir, s.file || "")));
      const row = { harness: m.id, surface: key, kind: s.kind, path, entry, state: a.state, reason: a.reason || a.refusal || null, writtenBy: a.writtenBy || null, sameProject: Boolean(a.sameProject), produced: a.produced !== false, legacy: Boolean(a.legacy), installedPkg: a.installedPkg || null, present: a.file ? a.file.present : (a.current ? true : (a.curEntry ? true : false)) };
      if (s.kind === "registration") Object.assign(row, { entry: a.id, present: Boolean(a.dir.present || a.known || a.installed), produced: a.produced, pkg: a.pkg, dirPkg: a.dir.pkg, installedVersion: a.installedVersion, installPath: a.installPath, enabled: a.enabled, others: a.others, otherProjects: a.otherProjects, writtenBy: a.writtenBy, newer: a.newer, bin: a.bin });
      states.push(row);
    }
    // A registration is the host's to load and never counts as a file of ours
    // (contract 16): it decides nothing about whether the harness is in use.
    const hasOurs = states.some((x) => (x.kind === "exclusive" && ["current", "stale"].includes(x.state)) || (x.kind === "shared" && ["ours-current", "ours-stale"].includes(x.state)));
    if (detected.includes(m.id) || hasOurs) { out.used.push(m.id); out.states.push(...states); }
  }
  return out;
}

export { FOREIGN_TEXT };

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

import { readFileSync, existsSync } from "node:fs";
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

function pluginVersionAt(root, harness) {
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

export function analyseJsonEntry(projectDir, s, { root = pluginRoot(), home = homedir() } = {}) {
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
  a.ours = statusLineIsOurWiring(a.curCmd, projectDir, home, root);
  a.desired = desiredStatusLineCommand(projectDir, root, home).command;
  if (!a.curEntry) return { ...a, state: "ours-absent" };
  if (!a.ours) return { ...a, state: "theirs", reason: "a status line we did not write owns the slot" };
  if (a.curCmd === a.desired) return { ...a, state: "ours-current" };
  return { ...a, state: "ours-stale", reason: "the command no longer matches this installation" };
}

// ─── mjs: an exclusive, provenance-stamped file ────────────────────────

export function analyseStampedFile(projectDir, s, { root = pluginRoot(), home = homedir(), harness = null } = {}) {
  const path = join(projectDir, s.file);
  const file = readText(path);
  const a = { path, file, produced: true, ours: null, refusal: null, stamped: null, state: "absent", reason: null, writtenBy: null, sameProject: false, legacy: false };
  if (s.condition === "plugin_cache_install" && !isPluginCacheRoot(root, home)) {
    // Not produced for this installation (a dev checkout is wired directly).
    a.produced = false;
    if (!file.present) return { ...a, state: "absent" };
    a.ours = isOurFile(file.text);
    return { ...a, state: a.ours ? "stale" : "foreign", reason: a.ours ? "not produced for this installation (a dev checkout is wired directly) — left in place; a prune of a launcher this root did not write needs the root that wrote it, or uninstall" : null };
  }
  const src = join(root, s.source);
  const tpl = readText(src);
  if (!tpl.present || tpl.text === null) return { ...a, state: "unparseable", refusal: `the source ${s.source} is missing from the plugin at ${root}` };
  const rendered = renderStatusLineLauncher(tpl.text, root);
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

// ─── every surface, for doctor ─────────────────────────────────────────

const ANALYSERS = { "markdown-block": analyseBlock, "json-entry": analyseJsonEntry, "mjs": analyseStampedFile };

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
      states.push({ harness: m.id, surface: key, kind: s.kind, path, entry, state: a.state, reason: a.reason || a.refusal || null, writtenBy: a.writtenBy || null, sameProject: Boolean(a.sameProject), produced: a.produced !== false, legacy: Boolean(a.legacy), installedPkg: a.installedPkg || null, present: a.file ? a.file.present : (a.current ? true : (a.curEntry ? true : false)) });
    }
    const hasOurs = states.some((x) => (x.kind === "exclusive" && ["current", "stale"].includes(x.state)) || (x.kind === "shared" && ["ours-current", "ours-stale"].includes(x.state)));
    if (detected.includes(m.id) || hasOurs) { out.used.push(m.id); out.states.push(...states); }
  }
  return out;
}

export { FOREIGN_TEXT };

#!/usr/bin/env node
// projectstore — install-harness.mjs
//
// The verbs that put projectstore's surfaces where a harness reads them —
// install, uninstall, upgrade — and the one thing that makes them safe: every
// write is planned first, shown, and applied only on explicit confirmation.
//
// Two grains of ownership (install spec, contract 0). An EXCLUSIVE file is
// wholly ours and carries the provenance line; provenance.mjs derives its
// state — current, stale with a reason, absent, foreign — and a foreign file
// is refused by these verbs, never repaired (contract 5). A SHARED file is
// the user's; we own one entry in it, recognised by the marker the manifest
// names, and nothing outside that entry is read, rewritten or removed
// (contract 6). A JSON file cannot carry the line, so it is always shared.
//
// The STATE of each surface comes from surfaces.mjs, which doctor reads too,
// so the verbs and the report can never disagree about a file. This file
// adds only policy — what a mode does with a state — and the writes.
//
// plan() writes nothing and reads no terminal: it is a pure description of
// what install/uninstall would do, per surface, so the preview, the states and
// the refusals are unit-tested without a subprocess. renderPreview() is a
// pure string. confirm() takes its streams as parameters. apply() is the only
// function that writes, and it writes only through lib.mjs writeFileAtomic.
//
// The gate (contract 9, distribution ADR decision 6): an interactive call
// prints the plan and asks; a non-interactive call that NAMES its harness
// counts as the confirmation; a bare install in a non-TTY refuses. There is
// no --yes flag. --surface narrows the plan (by prefix, so `statusline`
// covers the launcher too); it confirms nothing — except that naming the
// statusline surface is how a user opts into it without the config flag.
//
// Surface handlers are keyed by the manifest's surfaces.<kind>.format, never
// by a harness id: adding a harness is adding harnesses/<id>.json, and this
// file gains no branch. Claude Code's own plugin surfaces are host-managed
// (contract 14) — the plan reports the marketplace steps the manifest
// carries and writes none of them.
//
// A REGISTRATION (contract 0 as amended 2026-09-05, contract 4′) is the third
// kind: a directory of ours under the harness home — a local marketplace whose
// manifest carries our provenance field — that the host's own CLI is driven
// to register, install, update and silence a competitor of, at project scope.
// Its plan item carries steps[]: the directory write and one verbatim argv
// per host command, each a preview line (contract 9). apply() runs them in
// order with the harness home pinned in the child's environment, and stops at
// the first non-zero exit. The registration is planned FIRST, and every other
// surface is then planned against the install path it produces — from npx,
// the package's own root is a directory the package manager collects.
//
// Direction: installer → surfaces ← doctor; installer → provenance ← doctor.
// Doctor never imports this file.
//
// Normative: the spec "Installing, refreshing and disowning a harness
// surface", contracts 0, 5–10, 13–15. The plan/apply split, the refusal
// without a detected harness and the four-state model are Ivan Morozov's
// (MultiProjectStore); the host-managed report shape is Maxim
// Podreshetnikov's (PR #13, installElsewhere). Pure node, no external deps.

import { mkdirSync, unlinkSync, rmdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { loadHarness, harnessIds, sourceHarness, detectHarnesses, harnessRefusal } from "./harness.mjs";
import { FOREIGN_TEXT, GRAMMAR_VERSION } from "./provenance.mjs";
import { analyseBlock, analyseJsonEntry, analyseStampedFile, analyseRegistration, analyseLayout, isOurFile } from "./surfaces.mjs";
import { pluginRoot, writeFileAtomic, ensureStateDir, ensureRuntimeDir, removeAgentsBlock, replaceAgentsBlock, readConfigAt, isPluginCacheRoot, claudeHome, packageDigest, writeOwnTree, removeOwnTree, cmpVersion, whichOnPath as whichOnPathFromLib, moveStateDir, mergeEntryLog, movePath, removeInside, statusLineScriptPath, layoutPaths } from "./lib.mjs";

import { GENERATOR } from "./surfaces.mjs";
export { GENERATOR };

function rel(projectDir, p) {
  const r = relative(projectDir, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

// npx extracts into a cache under _npx/, npm install into node_modules/: both
// are the package manager's to remove.
export function isEphemeralRoot(root) {
  return /[\\/](_npx|node_modules)[\\/]/.test(String(root || ""));
}

function inside(dir, parent) {
  const r = relative(parent, dir);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// ─── Surface handlers, keyed by format ─────────────────────────────────
//
// Each handler answers plan(ctx) → PlanItem[] for one surface row, in one
// mode, from the state surfaces.mjs derived. A PlanItem carries everything
// the preview and apply need; apply never re-derives a state.

const HANDLERS = {
  "markdown-block": planAgentsBlock,
  "json-entry": planJsonEntry,
  "mjs": planStampedFile,
  "host-plugin-registration": planRegistration,
};

// The order plan() visits kinds in (contract 4′, two phases): the registration
// decides the root the rest is planned against; a shared entry (the status
// line slot) decides whether the exclusive launcher is written at all.
const KIND_ORDER = { registration: 0, shared: 1, exclusive: 2 };

function planAgentsBlock(ctx, key, s) {
  const { projectDir, mode, root } = ctx;
  const a = analyseBlock(projectDir, s, { root });
  const { withBlock, preferred, claude, importLine, PREFERRED, FALLBACK } = a;
  const items = [];
  if (a.refusal) return [{ surface: key, kind: "shared", path: a.files[0].path, entry: "projectstore:agents", state: "refused", action: "refuse", reason: a.refusal }];

  const hasImport = (text) => String(text ?? "").split("\n").some((l) => l.trim() === importLine);
  // A CLAUDE.md that is nothing but the import registration added is ours to
  // delete when the block goes (ADR-002 decision 4); anything else stays.
  const onlyImport = (text) => String(text ?? "").split("\n").every((l) => !l.trim() || l.trim() === importLine);
  const removal = (e, extra = {}) => ({ surface: key, kind: "shared", path: e.path, entry: `projectstore:agents v${e.block.v}`, state: "ours-current", action: "remove", reason: null,
    before: e.text, after: removeAgentsBlock(e.text), deleteIfEmpty: e.file === FALLBACK, ...extra });

  if (mode === "uninstall") {
    if (!withBlock.length) return [{ surface: key, kind: "shared", path: preferred.path, entry: "projectstore:agents", state: "ours-absent", action: "skip", reason: "no block to remove" }];
    for (const e of withBlock) items.push(removal(e));
    // The import line registration inserted, when it is all CLAUDE.md holds.
    if (withBlock.some((e) => e.file === PREFERRED) && claude && claude.present && claude.text !== null && hasImport(claude.text) && onlyImport(claude.text) && !withBlock.some((e) => e.file === FALLBACK)) {
      items.push({ surface: `${key}_import`, kind: "shared", path: claude.path, entry: importLine, state: "ours-current", action: "remove", reason: `${claude.file} holds only the import registration added`, before: claude.text, after: "", deleteIfEmpty: true });
    }
    return items;
  }

  const entry = `projectstore:agents v${a.version}`;
  const current = a.current;
  // Two files, one block each: resolve in favour of the preferred file —
  // register migrates, never duplicates (ADR-002 decision 3).
  for (const e of a.duplicates || []) items.push(removal(e, { state: "ours-stale", reason: `duplicate of the block in ${current.file}` }));

  if (!current) {
    const target = preferred;
    items.push({ surface: key, kind: "shared", path: target.path, entry, state: "ours-absent", action: target.present ? "add" : "create", reason: null,
      before: target.present ? target.text : null, after: replaceAgentsBlock(target.present ? target.text : "", a.desired) });
  } else if (current.file !== preferred.file && preferred.present) {
    // Present in the non-preferred file: migrate — remove there, add here.
    items.push(removal(current, { state: "ours-stale", reason: `migrating to ${preferred.file}` }));
    items.push({ surface: key, kind: "shared", path: preferred.path, entry, state: "ours-absent", action: "add", reason: `migrated from ${current.file}`,
      before: preferred.text, after: replaceAgentsBlock(preferred.text, a.desired) });
  } else if (current.block.v === a.version && current.block.block === a.desired) {
    items.push({ surface: key, kind: "shared", path: current.path, entry, state: "ours-current", action: "skip", reason: null });
  } else {
    items.push({ surface: key, kind: "shared", path: current.path, entry, state: "ours-stale", action: "replace-entry",
      reason: current.block.v !== a.version ? `v${current.block.v} → v${a.version}` : "content differs from the current source",
      before: current.text, after: replaceAgentsBlock(current.text, a.desired) });
  }

  // The @AGENTS.md import in CLAUDE.md (ADR-002 decision 3), only when the
  // block lives in AGENTS.md and CLAUDE.md exists without it. A removal
  // already rewriting CLAUDE.md in this plan takes the import onto its own
  // text, or the two items would race.
  const written = items.find((i) => ["add", "create", "replace-entry", "skip"].includes(i.action) && i.surface === key);
  const blockFile = written ? rel(projectDir, written.path) : null;
  if (blockFile === PREFERRED && a.files.length > 1 && claude) {
    const rewrite = items.find((i) => i.action === "remove" && i.path === claude.path);
    const text = rewrite ? rewrite.after : (claude.present ? claude.text : null);
    if (typeof text === "string" && !hasImport(text)) {
      const after = importLine + "\n" + (text.startsWith("\n") || !text.trim() ? "" : "\n") + text;
      if (rewrite) { rewrite.after = after; rewrite.deleteIfEmpty = false; rewrite.reason += `; ${importLine} import added`; }
      else items.push({ surface: `${key}_import`, kind: "shared", path: claude.path, entry: importLine, state: "ours-absent", action: "add", reason: `${PREFERRED} carries the block; ${claude.file} must import it`, before: text, after });
    }
  }
  return items;
}

// ─── host-plugin-registration ──────────────────────────────────────────

// One host command as a plan step: the verbatim argv (the manifest's
// subcommand with its placeholders filled), why it runs, and the host-owned
// files it is known to touch (measured 2026-09-05 — the manifest's cli.verified).
function hostStep(a, s, name, fill, why) {
  const argv = (s.cli.commands[name] || []).map((t) => t.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? `{${k}}`));
  const p = a.paths;
  const touches = {
    validate: [], marketplace_add: [p.marketplaces, p.projectSettings], marketplace_update: [p.marketplaces], marketplace_remove: [p.marketplaces, p.projectSettings],
    install: [p.installed, p.projectSettings, p.cacheDir], update: [p.installed, p.cacheDir], uninstall: [p.installed, p.projectSettings], disable: [p.projectSettings], enable: [p.projectSettings],
  }[name] || [];
  return { kind: "host", name, bin: s.cli.bin, argv, why, touches: touches.filter(Boolean) };
}

// The marketplace manifest we write: the host's catalogue shape (measured), plus
// our provenance field — contract 2 for a JSON file that is wholly ours — with
// the payload digest the state ladder checks (contract 4′).
export function registrationManifest(s, { pkg, projectDir, disabled = [], digest = null }) {
  return {
    name: s.marketplace_name,
    description: "projectstore, installed from the npm package on this machine (written by projectstore install; do not edit)",
    owner: { name: "SmartAndPoint", email: "ekonev@smartandpoint.com" },
    plugins: [{ name: s.plugin_name, description: "Agent-first project memory: a vault-native workflow for ADRs, specs, epics and stories.", version: pkg, source: `./${s.plugin_subdir}` }],
    [s.provenance_key]: { grammar: GRAMMAR_VERSION, pkg, project: projectDir, generator: GENERATOR, disabled, digest },
  };
}

// Inside a live session of the host, its CLI and the session both rewrite the
// same settings files on their own schedules; the registration is planned
// only from a terminal outside one. The host marks its sessions in the
// environment (manifest runtime.detect_env).
function insideHostSession(env, harness) {
  // runtime.session_env, not detect_env: a Bash tool inside a session carries
  // the session marker, not the plugin-root variables a hook receives
  // (measured 2026-09-05; the critic's third pass caught the first draft
  // keying on detect_env, which never fired in a session).
  return (harness?.runtime?.session_env || []).some((k) => env && env[k]);
}

function planRegistration(ctx, key, s) {
  const { projectDir, mode, root, home, env, harness } = ctx;
  const a = analyseRegistration(projectDir, s, { root, home, harness, env });
  const id = a.id;
  const bin = a.bin;
  const binName = s.cli?.bin || "claude";
  const base = { surface: key, kind: "registration", path: a.paths.dir, entry: id, state: a.state, reason: a.reason, root: a.installPath || a.predictedInstallPath, home: claudeHome(home), scope: s.scope || null, writtenBy: a.writtenBy };
  const fill = { dir: a.paths.dir, marketplace: s.marketplace_name, id, other: id };
  const notOnPath = `\`${binName}\` is not on PATH — the registration is left as it is; put the host's CLI on PATH and run install again`;
  const named = (ctx.surfaces || []).includes(key);
  const inSession = `this runs inside a ${harness.display_name} session, whose exit rewrites the same settings files the host's CLI writes — run it from a terminal outside the session`;
  const other = (o) => ({ surface: `${key}_others`, kind: "registration", path: a.paths.projectSettings, entry: o.key, state: "enabled", home: base.home, scope: base.scope });

  if (mode === "uninstall") {
    if (a.state === "unavailable" || a.state === "absent") return [{ ...base, action: "skip", reason: a.state === "absent" ? a.reason : a.reason }];
    if (a.state === "foreign") return [{ ...base, action: "refuse", reason: a.refusal }];
    if (!bin) { ctx.incomplete = true; return [{ ...base, action: "skip", reason: notOnPath }]; }
    if (insideHostSession(env, harness)) { ctx.incomplete = true; return [{ ...base, action: "skip", reason: inSession }]; }
    const steps = [];
    if (a.installed) steps.push(hostStep(a, s, "uninstall", fill, `the host forgets ${id} for this checkout (its row and enablement; other checkouts keep theirs)`));
    const last = a.otherProjects === 0;
    // The host's `marketplace remove` drops EVERY checkout's rows for the
    // marketplace (measured), so it runs only from the last checkout — and
    // before anything else touches the declaration it requires. Otherwise our
    // one entry in the checkout's local settings is removed by hand (contract 6).
    if (last && a.known && a.registeredHere) steps.push(hostStep(a, s, "marketplace_remove", fill, `no other checkout uses marketplace ${s.marketplace_name}; the host forgets it and this checkout's declaration of it`));
    else if (a.registeredHere) steps.push({ kind: "unregister", path: a.paths.projectSettings, pointer: s.registry?.known_pointer || "extraKnownMarketplaces", name: s.marketplace_name, why: `this checkout stops declaring the marketplace — our entry only; \`${binName} plugin marketplace remove\` would drop every checkout's rows (measured), so it runs only from the last checkout` });
    // Re-enable only what THIS checkout holds disabled: the record in the shared
    // manifest says what install silenced somewhere; a copy the user disabled by
    // hand in another checkout is not ours to turn on (reviewer, 2026-09-05).
    for (const o of a.dir.disabled.filter((k) => a.disabledHere.includes(k))) steps.push(hostStep(a, s, "enable", { ...fill, other: o }, `${o} was silenced for this checkout by install; it is turned back on`));
    if (last && a.dir.present) steps.push({ kind: "remove", path: a.paths.dir, why: "our marketplace directory, removed whole (its manifest carries our provenance field); no other checkout is installed from it" });
    return [{ ...base, action: "remove", steps, reason: a.otherProjects ? `${a.otherProjects} other checkout(s) are installed from the shared directory; it and the host's marketplace entry stay` : a.reason }];
  }

  // install / upgrade
  if (!a.produced) {
    // A cache install never registers a second copy of itself (condition npm_package_root).
    if (a.state === "absent" || a.state === "unavailable") return named ? [{ ...base, action: "skip", deferred: true, reason: "this root is the host's own install of the plugin; it does not register a second copy of itself — the npm package does, from a terminal: npx projectstore install --harness " + harness.id + " --project \"" + projectDir + "\"" }] : [];
    if (a.state === "current") return [{ ...base, action: "skip" }];
    return [{ ...base, action: "skip", deferred: true, reason: `${a.reason} — this root is the host's own install; refresh the registration from the package, outside a session: npx projectstore@<version> upgrade --harness ${harness.id} --surface ${key} --project "${projectDir}"` }];
  }
  if (a.state === "unavailable") { ctx.incomplete = true; return [{ ...base, action: "skip", deferred: true, reason: a.reason }]; }
  if (a.state === "foreign") return [{ ...base, action: "refuse", reason: a.refusal }];
  const items = [];
  const needsHost = a.state !== "current" || a.others.length > 0;
  if (needsHost && !bin) { ctx.incomplete = true; return [{ ...base, action: "skip", deferred: true, reason: `${a.reason ? a.reason + "; " : ""}${notOnPath}` }]; }
  if (needsHost && insideHostSession(env, harness)) { ctx.incomplete = true; return [{ ...base, action: "skip", deferred: true, reason: `${a.reason ? a.reason + "; " : ""}${inSession}` }]; }

  if (a.state === "current") {
    items.push({ ...base, action: "skip" });
  } else {
    const steps = [];
    // The directory is rewritten when it is missing, older than this package or
    // damaged — never when a newer package wrote it (contract 12: reported, not
    // downgraded); then this checkout registers against what stands.
    // …or holds a different payload at the SAME version — the maintainer's
    // pack → install → fix → pack loop never bumps it. The host will not
    // re-copy at an equal version (measured), so that refresh is uninstall + install.
    const sameVersionDiffers = a.contentDiffers === true;
    const rewrite = !a.dir.present || (cmpVersion(a.dir.pkg, a.pkg) < 0) || a.dir.digestOk === false || sameVersionDiffers;
    const disabled = [...new Set([...a.dir.disabled, ...a.others.map((o) => o.key)])];
    const digest = rewrite ? packageDigest(root) : (a.dir.prov?.digest || null);
    const files = digest ? digest.count : 0;
    if (rewrite) steps.push({ kind: "write", path: a.paths.dir, files, manifest: registrationManifest(s, { pkg: a.pkg, projectDir, disabled, digest }), why: a.dir.present ? `the directory is rewritten from this package (${a.dir.pkg} → ${a.pkg}${a.dir.digestOk === false ? ", the payload did not match its digest" : sameVersionDiffers ? ", same version, different content" : ""})` : `the marketplace directory is written from this package's ${files} shipped files, staged and renamed into place` });
    else if (a.newer) steps.push({ kind: "note", why: `the directory holds ${a.dir.pkg}${a.writtenBy ? ` (written from ${a.writtenBy})` : ""}, newer than this package (${a.pkg}); this checkout registers ${a.dir.pkg} — not downgraded` });
    else if (a.others.some((o) => !a.dir.disabled.includes(o.key))) steps.push({ kind: "write", path: a.paths.dir, files: 0, manifestOnly: true, manifest: { ...a.dir.manifest, [s.provenance_key]: { ...a.dir.prov, disabled } }, why: "our manifest records what install silences, so uninstall can turn it back on" });
    steps.push(hostStep(a, s, "validate", fill, "the host checks the marketplace before it is registered (it warns about our provenance field and exits 0 — measured)"));
    if (!a.known) steps.push(hostStep(a, s, "marketplace_add", fill, "the host learns our marketplace, declared in this checkout's local settings"));
    else if (!a.registeredHere) steps.push(hostStep(a, s, "marketplace_add", fill, "the host already knows our marketplace; this checkout declares it (measured: a re-add is idempotent)"));
    if (!a.installed || !a.installed.present) steps.push(hostStep(a, s, "install", fill, `the host copies the plugin into its cache and enables it for this checkout (-y accepts a marketplace-declared command; ours declares none)`));
    else if (sameVersionDiffers && a.installedVersion === a.targetPkg) { steps.push(hostStep(a, s, "uninstall", fill, `the host forgets this checkout's row: at an unchanged version \`update\` copies nothing (measured), so the refresh is uninstall + install`)); steps.push(hostStep(a, s, "install", fill, `the host copies the rewritten ${a.targetPkg} into its cache and enables it for this checkout again`)); }
    else if (a.installedVersion !== a.targetPkg) steps.push(hostStep(a, s, "update", fill, `the host swaps this checkout's cached copy for ${a.targetPkg} (measured: --scope names the row; no uninstall)`));
    if (a.installed && a.installed.present && !a.enabled) steps.push(hostStep(a, s, "enable", fill, "it is disabled for this checkout; install turns it on"));
    items.push({ ...base, action: a.state === "absent" ? "create" : "update", steps, root: a.predictedInstallPath, verify: { installPath: a.predictedInstallPath, version: a.targetPkg } });
  }
  // A competing enabled registration of the same plugin is silenced for THIS
  // checkout only, as a precaution the preview names (whether two enabled copies
  // load twice is the live test's row). Our manifest records it for uninstall.
  for (const o of a.others) {
    const steps = [];
    if (a.state === "current" && !a.dir.disabled.includes(o.key)) steps.push({ kind: "write", path: a.paths.dir, files: 0, manifestOnly: true, manifest: { ...a.dir.manifest, [s.provenance_key]: { ...a.dir.prov, disabled: [...a.dir.disabled, o.key] } }, why: "our manifest records what install silences, so uninstall can turn it back on" });
    steps.push(hostStep(a, s, "disable", { ...fill, other: o.key }, `${o.key} (${o.version}) is enabled for this checkout too; two enabled copies of one plugin would load twice — silenced in this checkout's local settings only, never globally`));
    items.push({ ...other(o), action: "disable", steps });
  }
  return items;
}

function planJsonEntry(ctx, key, s) {
  const { projectDir, mode, root, home } = ctx;
  if (s.supported === false) {
    return [{ surface: key, kind: "shared", path: join(projectDir, s.file), entry: s.marker?.pointer || null, state: "unsupported", action: "skip", reason: s.why_unsupported || "not supported for this harness yet" }];
  }
  const path = join(projectDir, s.file);
  const entryKey = (s.marker?.pointer || "statusLine.command").split(".")[0];
  // The status line is opt-in (projectstore.json → statusline.enabled), as
  // the SessionStart refresh already honours; naming the surface explicitly
  // is the other way to opt in.
  if (mode === "install" && !ctx.optIn.has(key)) {
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "opt-out", action: "skip", reason: "statusline.enabled is not true in projectstore.json — name --surface statusline to wire it anyway" }];
  }
  const renderRoot = ctx.renderRoot || root;
  // A root the package manager will collect (npx's cache, a node_modules) is
  // never wired directly: the entry would name a path that disappears. It is
  // wired against a registration's install path — or not at all (contract 4′).
  if (mode === "install" && !isPluginCacheRoot(renderRoot, home) && isEphemeralRoot(renderRoot)) {
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "absent-or-present", action: "skip", reason: "this package root is a package-manager cache; the status line is wired only against a registered install (see the registration above)" }];
  }
  const a = analyseJsonEntry(projectDir, s, { root, home, renderRoot });
  if (a.state === "unparseable") return [{ surface: key, kind: "shared", path, entry: entryKey, state: "unparseable", action: "refuse", reason: a.reason }];

  if (mode === "uninstall") {
    if (!a.curEntry) return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-absent", action: "skip", reason: null }];
    if (!a.ours) return [{ surface: key, kind: "shared", path, entry: entryKey, state: "theirs", action: "skip", reason: "the entry is not ours — left in place" }];
    const after = { ...a.settings }; delete after[entryKey];
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-current", action: "remove", reason: null, before: a.settings, after }];
  }
  if (a.state === "theirs") {
    ctx.slotForeign.add(key);
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "theirs", action: "skip", reason: "a status line we did not write owns the slot — left to its owner, and nothing else is wired for it" }];
  }
  if (a.state === "ours-current") return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-current", action: "skip", reason: null }];
  const after = { ...a.settings, [entryKey]: { ...(a.curEntry && typeof a.curEntry === "object" ? a.curEntry : {}), type: "command", command: a.desired } };
  return [{ surface: key, kind: "shared", path, entry: entryKey, state: a.state, action: a.curEntry ? "replace-entry" : (a.cur.present ? "add" : "create"),
    reason: a.curEntry ? a.reason : null, before: a.cur.present ? a.settings : null, after }];
}

function planStampedFile(ctx, key, s) {
  const { projectDir, mode, root, home, harness } = ctx;
  const renderRoot = ctx.renderRoot || root;
  const path = join(projectDir, s.file);
  const produced = !(s.condition === "plugin_cache_install" && !isPluginCacheRoot(renderRoot, home));
  // The policy early-outs come before the render-and-hash, which they make
  // unnecessary.
  if (produced && mode === "install" && !ctx.optIn.has(s.condition ? "statusline" : key) && !ctx.optIn.has(key)) {
    return [{ surface: key, kind: "exclusive", path, entry: null, state: "opt-out", action: "skip", reason: "statusline.enabled is not true in projectstore.json" }];
  }
  if (produced && mode === "install" && ctx.slotForeign.size) {
    return [{ surface: key, kind: "exclusive", path, entry: null, state: "absent-or-present", action: "skip", reason: "the status line slot is foreign; a launcher nothing points at is not written" }];
  }
  const a = analyseStampedFile(projectDir, s, { root, home, harness, renderRoot });
  // Not produced for this installation (a dev checkout is wired directly):
  // a root that cannot produce a file has, by construction, never written it,
  // so install and upgrade REPORT it and leave it (contract 13's wording;
  // contract 7 as amended 2026-09-05 — a dev checkout's plan used to prune a
  // cache install's launcher, the maintainer's habitual loop). Only uninstall
  // removes it: the user asked to disown, and the file is recognisably ours.
  // `prune` stays an action for the day a surface leaves the roster.
  // A file found at its legacy path (the layout ADR): classified from there,
  // removed from there, created at the new path — the legacy copy is then
  // the layout cleanup's to delete once nothing names it.
  const at = a.legacyPath || path;
  if (!a.produced) {
    if (!a.file.present) return [];
    if (!a.ours) return [{ surface: key, kind: "exclusive", path: at, entry: null, state: "foreign", action: "skip", reason: "not produced for a dev checkout, and not ours — left in place" }];
    return [{ surface: key, kind: "exclusive", path: at, entry: null, state: "stale", action: mode === "uninstall" ? "remove" : "skip", reason: a.reason }];
  }
  if (a.refusal) return [{ surface: key, kind: "exclusive", path: at, state: "refused", action: "refuse", reason: a.refusal }];
  const base = { surface: key, kind: "exclusive", path: at, entry: null, state: a.state, reason: a.reason, writtenBy: a.writtenBy, sameProject: a.sameProject };
  if (mode === "uninstall") {
    if (a.state === "absent") return [{ ...base, action: "skip" }];
    if (a.state === "foreign") return [{ ...base, action: "refuse", reason: FOREIGN_TEXT }];
    return [{ ...base, action: "remove" }];
  }
  if (a.state === "foreign") return [{ ...base, action: "refuse", reason: FOREIGN_TEXT }];
  // Current, but written for another project (a copied or moved checkout):
  // the file lives inside THIS project and its render names its project since
  // 2026-09-06, so it is re-rendered here — doctor still reports who wrote it
  // (contract 12); only the installer acts on it.
  if (a.state === "current" && !a.legacyPath && a.writtenBy && !a.sameProject) return [{ ...base, path, action: "update", reason: `current, written for ${a.writtenBy} — re-rendered for this project`, after: a.stamped.text }];
  if (a.state === "current" && !a.legacyPath) return [{ ...base, action: "skip" }];
  // Written at the NEW path; a legacy file's state is why (stale, or current-but-moving).
  return [{ ...base, path, action: a.state === "absent" || a.legacyPath ? "create" : "update", reason: a.legacyPath ? `${a.reason ? a.reason + "; " : ""}moving from ${rel(projectDir, a.legacyPath)} (the layout ADR)` : a.reason, after: a.stamped.text, legacyPath: a.legacyPath }];
}

// ─── plan ──────────────────────────────────────────────────────────────

export function plan(projectDir, { harnesses = [], mode = "install", env = process.env, home = homedir(), root = pluginRoot(), surfaces = null } = {}) {
  projectDir = resolve(projectDir);
  const detected = detectHarnesses(projectDir);
  const named = harnesses.filter(Boolean);
  const ids = named.length ? named : detected.map((d) => d.id);
  const out = { projectDir, mode, named: named.length > 0, detected, harnesses: [], reports: [], items: [], refusals: [], ok: true, incomplete: false, root, plannedAgainst: {} };
  const unknown = named.filter((id) => !harnessIds().includes(id));
  if (unknown.length) {
    out.refusals.push(`unknown harness: ${unknown.join(", ")} — known: ${harnessIds().join(", ")}`);
    out.ok = false;
    return out;
  }
  if (!ids.length) {
    out.refusals.push(harnessRefusal(projectDir));
    out.ok = false;
    return out;
  }
  const cfg = readConfigAt(projectDir);
  const optIn = new Set(surfaces || []);
  if (cfg?.statusline?.enabled === true) optIn.add("statusline");
  // The project-level layout (the layout ADR): one harness-neutral item, planned
  // once whatever --surface names — planned first, so every surface below is
  // planned against the new paths; its cleanup is planned last (below).
  const layoutHarness = loadHarness(ids.find((id) => { const p = layoutPaths(projectDir, { harnessDir: loadHarness(id).runtime?.harness_dir || null }); return existsSync(p.legacy.binding) || existsSync(p.legacy.runtime); }) || ids[0]);
  const layoutCtx = { projectDir, mode, env, home, root, harness: layoutHarness, incomplete: false };
  const layout = planLayout(layoutCtx);
  for (const item of layout.first) out.items.push({ harness: layoutHarness.id, ...item });
  if (layoutCtx.incomplete) out.incomplete = true;
  for (const id of ids) {
    const harness = loadHarness(id);
    out.harnesses.push(id);
    const ctx = { projectDir, mode, env, home, root, harness, optIn, slotForeign: new Set(), incomplete: false, renderRoot: root, surfaces: surfaces || [] };
    const hostRows = [];
    let registration = null;
    const rows = Object.entries(harness.surfaces || {}).filter(([key]) => !key.startsWith("_"));
    rows.sort(([, x], [, y]) => (KIND_ORDER[x.kind] ?? 3) - (KIND_ORDER[y.kind] ?? 3));
    for (const [key, s] of rows) {
      if (surfaces && !surfaces.some((x) => key === x || key.startsWith(x + "_"))) continue;
      if (s.kind === "host") { hostRows.push(key); continue; }
      const handler = HANDLERS[s.format];
      if (!handler) { out.refusals.push(`${id}: surface ${key} has format ${s.format}, which this installer cannot handle`); continue; }
      const items = handler(ctx, key, s);
      const dependent = s.kind !== "registration" && ctx.renderRoot !== root && ["json-entry", "mjs"].includes(s.format);
      for (const item of items) out.items.push({ harness: id, ...item, ...(dependent ? { plannedAgainst: ctx.renderRoot } : {}) });
      if (s.kind === "registration") {
        // Phase two (contract 4′): the rest is planned against the root the
        // registration produces — when it produces one on this run or has.
        const own = items.find((i) => i.surface === key);
        registration = own || null;
        if (own && mode !== "uninstall" && ["create", "update", "skip"].includes(own.action) && own.root && !own.deferred) ctx.renderRoot = own.root;
      }
    }
    // A registration surface the manifest declares but --surface excluded still decides the render root, read-only.
    if (surfaces && !registration) {
      const reg = rows.find(([key, s]) => s.kind === "registration" && !surfaces.some((x) => key === x || key.startsWith(x + "_")));
      if (reg && !isPluginCacheRoot(root, home)) {
        const a = analyseRegistration(projectDir, reg[1], { root, home, harness, env });
        if (a.installed && a.installed.present && a.enabled) ctx.renderRoot = a.installPath;
      }
    }
    if (ctx.renderRoot !== root) {
      out.plannedAgainst[id] = ctx.renderRoot;
      // Items planned before the render root was known (none today: the registration sorts first) are not re-planned.
    }
    if (ctx.incomplete) out.incomplete = true;
    if (hostRows.length && !surfaces) out.reports.push(hostManagedReport(harness, hostRows, registration));
  }
  for (const item of layout.last) out.items.push({ harness: layoutHarness.id, ...item });
  if (out.items.some((i) => i.action === "refuse")) out.ok = false;
  if (out.refusals.length) out.ok = false;
  return out;
}

// ─── the layout migration (the layout ADR; layout spec contract 6) ──────
//
// Two items, kind `layout`. The FIRST moves what only we read — the legacy
// state directory (per-file collision policy), the entry log (merged), the
// two legacy markers — and, last of its steps, the binding, whose `agents`
// block becomes the harness's overlay. It never touches the launcher: the
// settings entry names it, and the entry is re-pointed by the statusline item
// only after the launcher item has written the new one. The LAST item, planned
// after every surface, removes the legacy launcher once nothing names it and
// prunes the emptied legacy runtime directory. Two config files is the one
// refusal (a merge is the user's); uninstall is never blocked by it.
function planLayout(ctx) {
  const { projectDir, mode, env, harness } = ctx;
  const a = analyseLayout(projectDir, { harness });
  const P = a.paths;
  const none = { first: [], last: [] };
  if (!a.pending) return none;
  const base = { surface: "layout", kind: "layout", path: P.legacy.binding, entry: null, state: a.state, reason: null };
  if (mode === "uninstall") {
    // Disowning: the legacy runtime directory goes with the new one when it is
    // ours (its header); the legacy binding is bind's, never uninstall's.
    if (!a.legacy.runtime || !a.legacy.runtimeOurs) return none;
    return { first: [], last: [{ ...base, surface: "layout_cleanup", path: P.legacy.runtime, state: "legacy", action: "remove", reason: "the legacy runtime directory is ours (its .gitignore header) and goes with the state", steps: [
      { kind: "remove-legacy-runtime", path: P.legacy.runtime, why: "the pre-0.28 state directory, removed whole" },
      { kind: "note", why: ".projectstore/state/ (sessions, the entry log, the welcome marker) and the binding stay: the hooks' records and bind's file, not install's — delete .projectstore/ by hand to disown fully" },
    ] }] };
  }
  if (a.twoConfigs && !a.resumable) return { first: [{ ...base, action: "refuse", reason: `two bindings: ${P.legacy.binding} (legacy) and ${P.binding} — keep one and delete the other (usually the legacy one), then run install again; nothing is written while both exist` }], last: [] };
  if (insideHostSession(env, harness)) { ctx.incomplete = true; return { first: [{ ...base, action: "skip", deferred: true, reason: `the layout migration moves files this ${harness.display_name} session reads and writes — run it from a terminal outside the session` }], last: [] }; }
  const steps = [
    { kind: "note", why: `close other ${harness.display_name} sessions in this project first and restart afterwards: the migration moves files a running session reads and writes, and the status line does not reload mid-session` },
    { kind: "ensure", path: P.root, why: ".projectstore/ with its .gitignore (projectstore.json, state/)" },
  ];
  if (a.legacy.state) steps.push({ kind: "move-state", from: P.legacy.state, to: P.sessions, files: a.legacy.stateFiles.length, why: "session files move into state/sessions/; one present on both sides keeps the newer, a per-session directory keeps the new side" });
  if (a.legacy.entryLog) steps.push({ kind: "merge-log", from: P.legacy.entryLog, to: P.entryLog, why: "the legacy entry log's lines go before the new log's" });
  if (a.legacy.welcomed) steps.push({ kind: "move-marker", from: P.legacy.welcomed, to: P.welcomed(harness.id), why: "the welcome marker moves under state/<harness>/ — a migrated project is not welcomed twice" });
  if (a.legacy.sessionId) steps.push({ kind: "delete", path: P.legacy.sessionId, why: "the 0.6-era session-id file" });
  if (a.legacy.binding && a.resumable) steps.push({ kind: "delete", path: P.legacy.binding, why: "the binding was already moved (an interrupted run left the legacy copy, byte-equal but for its agents block)" });
  else if (a.legacy.binding) steps.push({ kind: "move-binding", from: P.legacy.binding, to: P.binding, overlay: P.overlay(harness.id), why: `the binding moves; its agents block becomes harness/${harness.id}.json` });
  const first = [{ ...base, action: "migrate", steps, reason: `${a.legacy.binding ? "binding" : "state"} in the pre-0.28 layout under ${a.legacy.dir}/` }];
  const last = [];
  if (a.legacy.launcher || a.legacy.runtime) {
    const cleanup = [];
    if (a.legacy.launcher) cleanup.push({ kind: "remove-legacy-launcher", path: P.legacy.launcher, why: "removed once the new launcher is written and the settings entry names it; kept if anything still points at it" });
    if (a.legacy.runtime) cleanup.push({ kind: "rmdir-legacy", path: P.legacy.runtime, why: "the emptied pre-0.28 runtime directory" });
    last.push({ ...base, surface: "layout_cleanup", path: P.legacy.runtime, state: "legacy", action: "cleanup", reason: null, steps: cleanup });
  }
  return { first, last };
}

function applyLayout(p, i, { failed }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const within = p.projectDir;
  if (i.action === "cleanup" && failed) { out.action = "skipped"; out.reason = "an earlier item failed; the legacy files stay until the next run"; return out; }
  const fail = (step, message) => { out.failed = { step, status: null, stderr: message }; return out; };
  for (const st of i.steps || []) {
    try {
      if (st.kind === "ensure") { ensureRuntimeDir(within); out.steps.push({ kind: st.kind, ok: true }); }
      else if (st.kind === "move-state") { const r = moveStateDir(st.from, st.to, within); ensureStateDir(within); out.steps.push({ kind: st.kind, ok: true, ...r }); }
      else if (st.kind === "merge-log") { const r = mergeEntryLog(st.from, st.to, within); out.steps.push({ kind: st.kind, ok: true, result: r }); }
      else if (st.kind === "delete") { out.steps.push({ kind: st.kind, path: st.path, ok: true, removed: removeInside(st.path, within) }); }
      else if (st.kind === "move-marker") { const r = movePath(st.from, st.to, within); if (r === "target-exists") removeInside(st.from, within); out.steps.push({ kind: st.kind, ok: true, result: r }); }
      else if (st.kind === "move-binding") {
        let cfg; try { cfg = JSON.parse(readFileSync(st.from, "utf8")); } catch (e) { return fail(st.kind, `${st.from} is not valid JSON; the binding was not moved`); }
        if (existsSync(st.to)) return fail(st.kind, `${st.to} appeared under the plan; two bindings are a refusal`);
        const { agents, ...binding } = cfg && typeof cfg === "object" ? cfg : {};
        if (agents && typeof agents === "object") {
          let overlay = {}; try { overlay = JSON.parse(readFileSync(st.overlay, "utf8")); } catch {}
          mkdirSync(dirname(st.overlay), { recursive: true });
          writeFileAtomic(st.overlay, JSON.stringify({ ...overlay, agents }, null, 2) + "\n", { sweep: false });
        }
        mkdirSync(dirname(st.to), { recursive: true });
        writeFileAtomic(st.to, JSON.stringify(binding, null, 2) + "\n", { sweep: false });
        removeInside(st.from, within);
        out.steps.push({ kind: st.kind, ok: true, overlay: Boolean(agents) });
      }
      else if (st.kind === "remove-legacy-launcher") {
        // Only ours, and only when no settings entry names it any more.
        let text = null; try { text = readFileSync(st.path, "utf8"); } catch {}
        const named = entryNames(p.projectDir, i.harness, st.path);
        // Moved, never just deleted: the legacy launcher goes only once the new
        // one exists (a dev root produces none — contract 7 leaves it in place).
        const moved = existsSync(layoutPaths(p.projectDir).launcher(i.harness));
        if (text === null) out.steps.push({ kind: st.kind, ok: true, removed: false });
        else if (!moved) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "no launcher at the new path yet (this root does not produce one) — left in place" });
        else if (!isOurFile(text)) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "not ours — left in place" });
        else if (named) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "the settings entry still names it — left in place" });
        else out.steps.push({ kind: st.kind, ok: true, removed: removeInside(st.path, within) });
      }
      else if (st.kind === "rmdir-legacy") {
        // Prune the legacy runtime dir when only its own .gitignore (and an empty state/) remain.
        let left = []; try { left = readdirSync(st.path).filter((n) => n !== ".gitignore"); } catch { out.steps.push({ kind: st.kind, ok: true, removed: false }); continue; }
        if (left.length === 1 && left[0] === "state") { try { if (readdirSync(join(st.path, "state")).length === 0) { rmdirSync(join(st.path, "state")); left = []; } } catch {} }
        if (left.length) { out.steps.push({ kind: st.kind, ok: true, removed: false, reason: `${left.join(", ")} remain` }); continue; }
        removeInside(st.path, within, { recursive: true });
        out.steps.push({ kind: st.kind, ok: true, removed: true });
      }
      else if (st.kind === "remove-legacy-runtime") { removeInside(st.path, within, { recursive: true }); out.steps.push({ kind: st.kind, ok: true, removed: true }); }
    } catch (e) { return fail(st.kind, e && e.message ? e.message : String(e)); }
  }
  return out;
}

// Does the harness's settings entry still name this launcher path?
function entryNames(projectDir, harnessId, launcherPath) {
  try {
    const h = loadHarness(harnessId);
    const s = h.surfaces?.statusline;
    if (!s || !s.file) return false;
    const settings = JSON.parse(readFileSync(join(projectDir, s.file), "utf8"));
    const cmd = settings?.statusLine?.command;
    const named = statusLineScriptPath(typeof cmd === "string" ? cmd : null);
    return Boolean(named) && resolve(named) === resolve(launcherPath);
  } catch { return false; }
}

// Contract 14: the host installs and updates these itself; say how, from the
// manifest, and write nothing. (PR #13's installElsewhere, as a plan line.)
function hostManagedReport(m, rows, registration = null) {
  const inst = m.install || {};
  const lines = [`${m.display_name}: ${rows.join(", ")} are installed by ${inst.mechanism || "the host"} — nothing to write.`];
  if (registration && registration.entry) {
    const how = registration.action === "skip" && registration.state === "current" ? "registered here" : registration.action === "refuse" ? "refused, see below" : registration.action === "skip" ? "not registered on this run, see below" : `registered by this run (${registration.action})`;
    lines.push(`  They come from the registration ${registration.entry}, ${how}${registration.root ? ` — the host loads them from ${registration.root}` : ""}.`);
  }
  if (inst.why_not_scripted) lines.push(`  ${inst.why_not_scripted}`);
  for (const s of inst.steps || []) lines.push(`    ${s}`);
  for (const n of inst.notes || []) lines.push(`  ${n}`);
  if (inst.docs) lines.push(`  ${inst.docs}`);
  return lines.join("\n");
}

const isWrite = (i) => !["skip", "refuse"].includes(i.action);

// ─── preview ───────────────────────────────────────────────────────────

export function renderPreview(p) {
  const lines = [`projectstore ${p.mode} — ${p.harnesses.join(", ") || "(no harness)"} — ${p.projectDir}`, ""];
  for (const [h, r] of Object.entries(p.plannedAgainst || {})) lines.push(`  ${h}: the surfaces below are planned against the host's install path ${r}, not this package at ${p.root}.`, "");
  for (const r of p.reports) lines.push(...r.split("\n").map((l) => "  " + l), "");
  const writes = p.items.filter(isWrite);
  for (const i of p.items) {
    const where = rel(p.projectDir, i.path) + (i.entry ? `  [${i.entry}]` : "");
    let state = i.state;
    if (i.state === "current" && i.writtenBy && !i.sameProject) state = `current, last written by ${i.writtenBy}`;
    if (i.reason && i.action !== "refuse") state += ` (${i.reason})`;
    lines.push(`  ${i.kind.padEnd(9)} ${where}`);
    lines.push(`            ${state.padEnd(44)} → ${i.action}${i.action === "refuse" && i.reason ? ": " + i.reason : ""}`);
    for (const st of i.steps || []) {
      if (st.kind === "host") lines.push(`            $ ${[st.bin, ...st.argv].join(" ")}`, `              ${st.why}${st.touches.length ? `; touches ${st.touches.map((t) => rel(p.projectDir, t)).join(", ")}` : ""}`);
      else if (st.kind === "write") lines.push(`            write ${st.path}${st.manifestOnly ? " (manifest only)" : ` (${st.files} files + the manifest)`}`, `              ${st.why}`);
      else if (st.kind === "remove") lines.push(`            remove ${st.path}`, `              ${st.why}`);
      else if (st.kind === "unregister") lines.push(`            edit ${rel(p.projectDir, st.path)}  [${st.pointer}.${st.name}] → removed`, `              ${st.why}`);
      else if (st.kind === "note") lines.push(`            note: ${st.why}`);
      else if (st.kind === "ensure") lines.push(`            ensure ${rel(p.projectDir, st.path)}/`, `              ${st.why}`);
      else if (st.kind === "move-state") lines.push(`            move ${rel(p.projectDir, st.from)}/ → ${rel(p.projectDir, st.to)}/ (${st.files} entries)`, `              ${st.why}`);
      else if (st.kind === "merge-log") lines.push(`            merge ${rel(p.projectDir, st.from)} → ${rel(p.projectDir, st.to)}`, `              ${st.why}`);
      else if (st.kind === "delete") lines.push(`            delete ${rel(p.projectDir, st.path)}`, `              ${st.why}`);
      else if (st.kind === "move-marker") lines.push(`            move ${rel(p.projectDir, st.from)} → ${rel(p.projectDir, st.to)}`, `              ${st.why}`);
      else if (st.kind === "move-binding") lines.push(`            move ${rel(p.projectDir, st.from)} → ${rel(p.projectDir, st.to)}  (agents → ${rel(p.projectDir, st.overlay)})`, `              ${st.why}`);
      else if (st.kind === "remove-legacy-launcher" || st.kind === "rmdir-legacy" || st.kind === "remove-legacy-runtime") lines.push(`            remove ${rel(p.projectDir, st.path)}`, `              ${st.why}`);
    }
    if (i.kind === "registration" && i.home && i.surface && !i.surface.endsWith("_others")) lines.push(`            (harness home ${i.home}${i.scope ? `, scope ${i.scope}` : ""})`);
    if (i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim()) lines.push(`            (the file would hold nothing else and is removed)`);
  }
  const exclusiveRemoval = p.items.find((i) => i.action === "remove" && i.kind === "exclusive");
  if (exclusiveRemoval) lines.push(`            (an emptied ${rel(p.projectDir, dirname(exclusiveRemoval.path))}/ is pruned)`);
  for (const r of p.refusals) lines.push(`  refused   ${r}`);
  lines.push("", "  Nothing outside a marked entry is read, rewritten or removed.");
  if (p.items.some((i) => (i.steps || []).some((s) => s.kind === "host"))) lines.push("  Each $ line runs the host's own CLI, which writes the host-owned files named after it.");
  if (!p.ok) lines.push("", "  Nothing will be written: resolve the refusals above first.");
  else if (!writes.length) lines.push("", "  Nothing to change." + (p.incomplete ? " One surface could not be planned (see above)." : ""));
  else lines.push("", `  ${writes.length} change(s) to apply.${p.incomplete ? " One surface could not be planned (see above); the rest proceeds." : ""}`);
  return lines.join("\n") + "\n";
}

// ─── gate ──────────────────────────────────────────────────────────────

// A named harness is the explicit confirmation (contract 9). Otherwise ask on
// a TTY, and refuse without one. Streams are parameters so the TTY branch is
// testable without a pseudo-terminal.
export async function confirm(p, { stdin = process.stdin, stdout = process.stdout, ask = null } = {}) {
  if (!p.ok) return { confirmed: false, why: "refused" };
  const writes = p.items.filter(isWrite);
  if (!writes.length) return { confirmed: false, why: "nothing-to-do" };
  if (p.named) return { confirmed: true, why: "named" };
  const interactive = Boolean(stdin && stdin.isTTY && stdout && stdout.isTTY);
  if (!interactive && !ask) return { confirmed: false, why: "non-tty" };
  const answer = ask ? await ask(`Apply these ${writes.length} change(s)? [y/N] `) : await (async () => {
    const rl = createInterface({ input: stdin, output: stdout });
    try { return await rl.question(`Apply these ${writes.length} change(s)? [y/N] `); } finally { rl.close(); }
  })();
  return /^y(es)?$/i.test(String(answer).trim()) ? { confirmed: true, why: "answered" } : { confirmed: false, why: "declined" };
}

// ─── apply ─────────────────────────────────────────────────────────────

export function apply(p, { env = process.env, spawn = spawnSync, home = homedir() } = {}) {
  if (!p.ok) throw new Error("apply: the plan carries refusals; nothing is written");
  const done = [];
  let registrationFailed = false;
  let layoutFailed = false;
  for (const i of p.items) {
    if (!isWrite(i)) continue;
    if (i.kind === "layout") {
      const r = applyLayout(p, i, { failed: layoutFailed || registrationFailed || Boolean(done.failed) });
      done.push(r);
      if (r.failed) { done.failed = r.failed; layoutFailed = true; }
      continue;
    }
    if (i.kind === "registration") {
      const r = applyRegistration(p, i, { env, spawn, home });
      done.push(r);
      // A registration that did not complete leaves the surfaces planned against
      // its install path unwritten: a launcher pointing at nothing is worse than
      // none. Surfaces rendered from the package root (the block) still apply.
      if (r.failed) { done.failed = r.failed; registrationFailed = true; }
      continue;
    }
    if (registrationFailed && i.plannedAgainst) { done.push({ path: i.path, action: "skipped", surface: i.surface, reason: "the registration did not complete; this surface was planned against its install path" }); continue; }
    if (i.kind === "shared" && typeof i.after === "object" && i.after !== null && !Array.isArray(i.after)) {
      mkdirSync(dirname(i.path), { recursive: true });
      // Re-read at write time: a host command run earlier in this apply (the
      // registration's) may have added sibling keys since plan() read the file.
      // Our entry is set or deleted on the file as it stands; nothing else moves.
      let now = null;
      try { now = JSON.parse(readFileSync(i.path, "utf8")); } catch { now = null; }
      let merged = i.after;
      if (now && typeof now === "object" && !Array.isArray(now) && i.entry) {
        merged = { ...now };
        if (i.action === "remove") delete merged[i.entry]; else merged[i.entry] = i.after[i.entry];
      }
      writeFileAtomic(i.path, JSON.stringify(merged, null, 2) + "\n", { sweep: false });
    } else if ((i.action === "remove" || i.action === "prune") && i.kind === "exclusive") {
      try { unlinkSync(i.path); } catch {}
      pruneEmptyDir(dirname(i.path), p.projectDir);
    } else if (i.action === "remove" && i.kind === "shared" && typeof i.after === "string") {
      if (i.deleteIfEmpty && !i.after.trim()) { try { unlinkSync(i.path); } catch {} }
      else writeFileAtomic(i.path, i.after, { sweep: false });
    } else if (typeof i.after === "string") {
      if (i.kind === "exclusive") ensureStateDir(p.projectDir); // carries the nested .gitignore
      mkdirSync(dirname(i.path), { recursive: true });
      writeFileAtomic(i.path, i.after, { sweep: false });
    }
    done.push({ path: i.path, action: i.action, surface: i.surface });
  }
  return done;
}

// The registration's steps, in order, each leaving a state plan() can read.
// The host binary runs with the harness home pinned in its environment — the
// same home the plan was read from — and with the project as its cwd, which is
// how the host resolves `--scope local`. A non-zero exit stops the item and
// is recorded, never retried, never masked.
function applyRegistration(p, i, { env, spawn, home }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const childEnv = { ...env, [homeEnvName(i.harness)]: claudeHome(home) };
  const s = loadHarness(i.harness).surfaces[i.surface.replace(/_others$/, "")];
  const fail = (step, status, stderr, argv = null) => { out.failed = { step, status, stderr, ...(argv ? { argv } : {}) }; return out; };
  for (const st of i.steps || []) {
    if (st.kind === "write") {
      const manifestPath = join(st.path, s.manifest);
      // Re-check at apply time what plan() proved: the directory is absent or ours.
      if (existsSync(st.path)) {
        let ours = false;
        try { ours = Boolean(JSON.parse(readFileSync(manifestPath, "utf8"))[s.provenance_key]); } catch {}
        if (!ours) { out.steps.push({ kind: "write", ok: false }); return fail("write", null, `${st.path} changed under the plan: its manifest is no longer ours; nothing is written`); }
      }
      if (st.manifestOnly) writeFileAtomic(manifestPath, JSON.stringify(st.manifest, null, 2) + "\n", { sweep: false });
      else writeOwnTree(st.path, { from: p.root, subdir: s.plugin_subdir, manifestRel: s.manifest, manifest: st.manifest, home });
      out.steps.push({ kind: "write", path: st.path, ok: true });
    } else if (st.kind === "unregister") {
      // Our one entry in the checkout's settings file (contract 6): the key is deleted, nothing else is touched.
      let settings = {};
      try { settings = JSON.parse(readFileSync(st.path, "utf8")); } catch { settings = null; }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) { out.steps.push({ kind: "unregister", ok: false }); return fail("unregister", null, `${st.path} is not a JSON object; the marketplace entry was not removed`); }
      if (settings[st.pointer] && typeof settings[st.pointer] === "object") { delete settings[st.pointer][st.name]; writeFileAtomic(st.path, JSON.stringify(settings, null, 2) + "\n", { sweep: false }); }
      out.steps.push({ kind: "unregister", path: st.path, ok: true });
    } else if (st.kind === "remove") {
      removeOwnTree(st.path, home);
      out.steps.push({ kind: "remove", path: st.path, ok: true });
    } else if (st.kind === "host") {
      const bin = whichOnPathFromLib(st.bin, env);
      const r = spawn(bin || st.bin, st.argv, { env: childEnv, cwd: p.projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
      const ok = !r.error && r.status === 0;
      const said = String((r.stderr || "") + (ok ? "" : r.stdout || "") + (r.error ? r.error.message : "")).trim();
      out.steps.push({ kind: "host", argv: [st.bin, ...st.argv], status: r.status ?? null, ok, ...(ok ? {} : { stderr: said }) });
      if (!ok) return fail(st.name, r.status ?? null, said, [st.bin, ...st.argv]);
    }
  }
  // The host's registry is read back: the install path the rest of the plan
  // was rendered against must be the one the host recorded for this checkout.
  if (i.verify) {
    const a = analyseRegistration(p.projectDir, s, { root: p.root, home, harness: loadHarness(i.harness), env });
    if (!a.installPath || resolve(a.installPath) !== resolve(i.verify.installPath) || a.installedVersion !== i.verify.version) {
      return fail("verify", null, `after the host ran, its registry records ${a.installPath || "no install"} at ${a.installedVersion || "?"} for this checkout; the plan rendered the other surfaces against ${i.verify.installPath} at ${i.verify.version} — they are not written`);
    }
    out.verified = { installPath: a.installPath, version: a.installedVersion };
  }
  return out;
}

function homeEnvName(harnessId) {
  try { return loadHarness(harnessId).runtime.home_env; } catch { return sourceHarness().runtime.home_env; }
}

// rmdirSync refuses a non-empty directory — that refusal IS the guarantee
// (contract 13): we prune only a directory we emptied. The runtime dir's own
// .gitignore does not count as content.
function pruneEmptyDir(dir, projectDir) {
  if (!inside(dir, projectDir)) return;
  try {
    const left = readdirSync(dir).filter((n) => n !== ".gitignore");
    if (left.length) return;
    try { unlinkSync(join(dir, ".gitignore")); } catch {}
    rmdirSync(dir);
  } catch {}
}

// ─── verbs ─────────────────────────────────────────────────────────────

export async function runVerb(verb, projectDir, opts = {}) {
  const mode = verb === "uninstall" ? "uninstall" : "install"; // upgrade is install re-run (contract 14)
  const p = plan(projectDir, { ...opts, mode });
  const preview = renderPreview(p);
  const gate = await confirm(p, opts);
  const result = { verb, plan: p, preview, gate, applied: [], failed: null };
  if (gate.confirmed) {
    result.applied = apply(p, { env: opts.env || process.env, spawn: opts.spawn || spawnSync, home: opts.home || homedir() });
    result.failed = result.applied.failed || null;
  }
  return result;
}

// ─── main ──────────────────────────────────────────────────────────────

function usage() {
  return [
    "usage: install-harness.mjs <install|uninstall|upgrade|plan> [--harness <id>]... [--surface <key>]... [--project <dir>] [--json]",
    `  harnesses: ${harnessIds().join(", ")}`,
    "  --surface narrows the plan to a surface and the surfaces beneath it (statusline covers statusline_launcher)",
    "  --harness names the harness — and, non-interactively, is the confirmation; there is no --yes",
  ].join("\n");
}

// The JSON envelope carries states and actions, never file bodies: a model
// reading a status report must not receive the whole of CLAUDE.md twice.
export const publicItem = ({ before, after, steps, ...rest }) => steps ? { ...rest, steps: steps.map(({ manifest, ...s }) => s) } : rest;

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!["install", "uninstall", "upgrade", "plan"].includes(verb)) { process.stderr.write(usage() + "\n"); process.exit(2); }
  const harnesses = [], surfaces = [];
  let projectDir = null, json = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) { process.stderr.write(`${a} needs a value\n${usage()}\n`); process.exit(2); } return v; };
    if (a === "--harness") harnesses.push(value());
    else if (a === "--surface") surfaces.push(value());
    else if (a === "--project") projectDir = value();
    else if (a === "--json") json = true;
    else { process.stderr.write(`unknown argument ${a}\n${usage()}\n`); process.exit(2); }
  }
  const src = sourceHarness();
  projectDir = resolve(projectDir || (src && process.env[src.runtime?.project_dir_env]) || process.cwd());
  const opts = { harnesses, surfaces: surfaces.length ? surfaces : null };
  if (verb === "plan") {
    const p = plan(projectDir, opts);
    process.stdout.write(json ? JSON.stringify({ ...p, items: p.items.map(publicItem) }, null, 2) + "\n" : renderPreview(p));
    process.exit(p.ok && !p.incomplete ? 0 : 1);
  }
  const r = await runVerb(verb, projectDir, opts);
  if (json) {
    process.stdout.write(JSON.stringify({ verb, ok: r.plan.ok && !r.plan.incomplete && !r.failed, gate: r.gate, applied: r.applied, failed: r.failed, incomplete: r.plan.incomplete, items: r.plan.items.map(publicItem), refusals: r.plan.refusals, reports: r.plan.reports }, null, 2) + "\n");
  } else {
    process.stdout.write(r.preview);
    if (r.gate.confirmed) process.stdout.write(appliedLine(r));
    else if (r.gate.why === "non-tty") process.stdout.write(`a bare ${verb} in a non-TTY refuses; name a harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`);
    else if (r.gate.why === "declined") process.stdout.write("nothing written.\n");
  }
  process.exit(r.plan.ok && !r.plan.incomplete && !r.failed && (r.gate.confirmed || r.gate.why === "nothing-to-do") ? 0 : 1);
}

// What apply did, for a terminal: the count, and a failed host command with
// its stderr — the user sees what the host said, verbatim.
export function appliedLine(r) {
  let s = `applied ${r.applied.length} change(s).\n`;
  if (r.failed) s += `stopped: ${r.failed.argv ? "$ " + r.failed.argv.join(" ") : r.failed.step} exited ${r.failed.status ?? "without running"}${r.failed.stderr ? "\n  " + r.failed.stderr.split("\n").join("\n  ") : ""}\n  the surfaces planned against its install path were not written; run the verb again once it succeeds.\n`;
  return s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

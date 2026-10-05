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
// The gate (contract 9 as amended 2026-10-04, distribution ADR decision 6):
// the plan is always printed first. A person at a terminal is then asked,
// even when the harness is named; without one (a pipe, an agent's tool, CI,
// --json, a host session) a call that NAMES its harness is the confirmation
// and a bare one refuses. There is no --yes flag. --surface narrows the plan
// (by prefix, so `statusline` covers the launcher too); it confirms nothing —
// except that naming the statusline surface is how a user opts into it
// without the config flag.
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

import { mkdirSync, unlinkSync, rmdirSync, readdirSync, existsSync, readFileSync, openSync, closeSync, statSync, realpathSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { caps as termCaps, painter, icon as termIcon, duration, stepReporter, wrap, askLine } from "./term.mjs";
import { loadHarness, loadHarnesses, harnessIds, sourceHarness, detectHarnesses, harnessRefusal, packageCommand } from "./harness.mjs";
import { FOREIGN_TEXT, GRAMMAR_VERSION } from "./provenance.mjs";
import { analyseBlock, analyseJsonEntry, analyseStampedFile, analyseRegistration, analysePortableRegistration, analyseLayout, isOurFile, readText } from "./surfaces.mjs";
import { payloadFiles, renderPortableCatalog } from "./portable-registration.mjs";
import { pluginRoot, writeFileAtomic, writeExclusiveMetadata, ensureStateDir, ensureRuntimeDir, removeAgentsBlock, replaceAgentsBlock, readConfigAt, isPluginCacheRoot, isEphemeralRoot, statusLineIsOurWiring, claudeHome, packageDigest, writeOwnTree, removeOwnTree, cmpPrecedence, importsLine, whichOnPath as whichOnPathFromLib, moveStateDir, mergeEntryLog, movePath, removeInside, statusLineScriptPath, layoutPaths, stagePortableMarketplace, finishPortableMarketplace, rollbackPortableMarketplace, removeTreeUnder } from "./lib.mjs";

import { GENERATOR } from "./surfaces.mjs";
export { GENERATOR };

function rel(projectDir, p) {
  const r = relative(projectDir, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

// isEphemeralRoot lives in lib.mjs beside the channel classifier that uses it;
// re-exported here under the name the installer's callers already import.
export { isEphemeralRoot };

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
  "portable-plugin-registration": planPortableRegistration,
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

  const hasImport = (text) => importsLine(text, importLine);
  // A CLAUDE.md that is nothing but the import registration added is ours to
  // delete when the block goes (ADR-002 decision 4); anything else stays.
  const onlyImport = (text) => String(text ?? "").split("\n").every((l) => !l.trim() || l.trim() === importLine);
  const removal = (e, extra = {}) => ({ surface: key, kind: "shared", path: e.path, entry: `projectstore:agents v${e.block.v}`, state: "ours-current", action: "remove", reason: null,
    before: e.text, after: removeAgentsBlock(e.text), deleteIfEmpty: e.file === FALLBACK, ...extra });

  if (mode === "uninstall") {
    if (!withBlock.length) return [{ surface: key, kind: "shared", path: preferred.path, entry: "projectstore:agents", state: "ours-absent", action: "skip", reason: "no block to remove" }];
    // The agents block is the one surface the PROJECT owns rather than a
    // harness: several harnesses read the same file. So disowning one harness
    // may not remove it, and measurably did — `uninstall --harness <other>`
    // deleted AGENTS.md while the source harness was still reading it through
    // an @AGENTS.md import, and the reverse stripped the block Codex reads
    // (both measured 2026-09-09). Either way, disowning one harness silently
    // disabled the other.
    //
    // The test is static manifest data, not detection: is the file the block
    // lives in one that ANOTHER manifest also names? No project state is read,
    // so there is no circularity — and the single-harness case is untouched,
    // because a file only one manifest names is that harness's to clear.
    // Over-conservative on purpose: a block left behind is a marked,
    // self-describing region a user can delete, where a deleted file another
    // harness reads is silent breakage. `--surface agents_block` still removes
    // it, which is the confirmation the gate asks for everywhere else.
    const alsoRead = (file) => [...loadHarnesses().values()]
      .filter((m) => m.id !== ctx.harness?.id)
      .some((m) => (m.surfaces?.agents_block?.files || []).includes(file));
    for (const e of withBlock) {
      // Naming the surface removes it regardless: `--surface agents_block`
      // is the confirmation without a terminal, and a terminal is asked
      // (contract 9 as amended 2026-10-04).
      if (!(ctx.surfaces || []).includes(key) && alsoRead(e.file)) {
        items.push({ surface: key, kind: "shared", path: e.path, entry: `projectstore:agents v${e.block.v}`, state: "ours-current", action: "skip",
          reason: `${e.file} is read by another harness too — a per-harness uninstall leaves the project's block alone. Remove it with --surface ${key}` });
        continue;
      }
      items.push(removal(e));
    }
    // An import that points at a file whose block has just gone is a pointer to
    // nothing. Look across every file any manifest names, not just this one's:
    // with a single-entry list PREFERRED and FALLBACK are the same file, which
    // made the old condition — block in PREFERRED and not in FALLBACK —
    // impossible to satisfy, so the import was never cleaned up at all.
    // An import is dangling only when the file it names will be GONE — not
    // merely when the block left it. A user's own AGENTS.md keeps its prose and
    // survives, and importing it stays meaningful (install contract 13 /
    // ADR-002 decision 4). The condition is therefore apply's own: marked for
    // deletion and left holding nothing (`install-harness.mjs:760`).
    const vanishing = new Set(items
      .filter((i) => i.action === "remove" && i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim())
      .map((i) => rel(projectDir, i.path)));
    // Two independent reasons to take an import out, and the first version of
    // this replaced one with the other:
    //   (1) it is OURS and nothing else is there — the registration we added to
    //       a file that held nothing else goes with the block (ADR-002
    //       decision 4), whether or not its target survives;
    //   (2) it DANGLES — the file it names will be gone, so it points at
    //       nothing even though the reader's own prose keeps the file alive.
    // A user's AGENTS.md that keeps its prose satisfies neither, and its import
    // stays: that is install contract 13, and it is what caught the mistake.
    //
    // Over the UNION of every manifest's list, not this one's: the file holding
    // the import need not be one this harness can read. Codex's list is a
    // single entry, which also made the old condition — block in PREFERRED and
    // not in FALLBACK — impossible to satisfy, so nothing was ever cleaned up.
    const blockGone = new Set(items.filter((i) => i.action === "remove" && i.surface === key).map((i) => rel(projectDir, i.path)));
    const union = [...new Set([...loadHarnesses().values()].flatMap((m) => m.surfaces?.agents_block?.files || []))];
    for (const file of union) {
      if (blockGone.has(file)) continue;
      const e = readText(join(projectDir, file));
      if (!e.present || e.text === null || !hasImport(e.text)) continue;
      const ours = onlyImport(e.text);
      const dangles = vanishing.has(importLine.slice(1));
      if (!ours && !dangles) continue;
      const after = e.text.split("\n").filter((l) => l.trim() !== importLine).join("\n").replace(/^\n+/, "");
      items.push({ surface: `${key}_import`, kind: "shared", path: join(projectDir, file), entry: importLine, state: "ours-current", action: "remove",
        reason: ours ? `${file} holds only the import registration added` : `${importLine} points at a file this uninstall removes`,
        before: e.text, after, deleteIfEmpty: ours });
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
  } else if (!current.own || (current.file !== preferred.file && preferred.present)) {
    // Two reasons to move, and they are not the same reason:
    //   - the block sits in a file this harness cannot read (`!own`). It must
    //     move, and its target is CREATED if it does not exist — this is a
    //     second harness arriving in a project that had one.
    //   - it sits in a readable but non-preferred file while the preferred one
    //     already exists. A preference, satisfied because the file is there.
    // The distinction is what keeps a Claude-Code-only project from acquiring
    // an AGENTS.md it never asked for, while still moving the substance the
    // moment a harness that can only read AGENTS.md is installed.
    items.push(removal(current, { state: "ours-stale", reason: `migrating to ${preferred.file}` }));
    items.push({ surface: key, kind: "shared", path: preferred.path, entry, state: "ours-absent", action: preferred.present ? "add" : "create", reason: `migrated from ${current.file}`,
      before: preferred.present ? preferred.text : null, after: replaceAgentsBlock(preferred.present ? preferred.text : "", a.desired) });
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
  // Every OTHER file any manifest names, and only if it already exists: a
  // reader whose file no longer holds the substance is pointed at the one that
  // does. Never a file we would have to create — a project with no CLAUDE.md
  // does not acquire one because Codex was installed.
  //
  // It used to key on `a.files.length > 1`, which is a property of the
  // INSTALLING harness's list: Codex's has one entry, so installing Codex left
  // a CLAUDE.md that still exists, still reads as authoritative, and no longer
  // holds anything. The block's file is what decides, not the list's length.
  // Installing FOR a harness means the file that harness reads by itself ends
  // up present. It holds the block when the block lands there; it holds the
  // import when the block lands elsewhere. Without this, a project that already
  // had an AGENTS.md took the block into it and created no bridge — so Claude
  // Code, the harness that ran the install, could not see what it had just
  // installed. `reads_natively` is the manifest's, so this is a file list, not
  // a harness name.
  const native = s.reads_natively;
  const nativeEntry = native ? a.files.find((e) => e.file === native) : null;
  for (const e of a.files) {
    const mustExist = nativeEntry && e.file === native;
    if (!blockFile || e.file === blockFile || (!e.present && !mustExist)) continue;
    const line = `@${blockFile}`;
    const rewrite = items.find((i) => i.action === "remove" && i.path === e.path);
    // An absent native file is empty text, not a reason to skip: it is created.
    const text = rewrite ? rewrite.after : (e.present ? e.text : "");
    if (typeof text !== "string" || importsLine(text, line)) continue;
    const after = line + "\n" + (text.startsWith("\n") || !text.trim() ? "" : "\n") + text;
    if (rewrite) { rewrite.after = after; rewrite.deleteIfEmpty = false; rewrite.reason += `; ${line} import added`; }
    else items.push({ surface: `${key}_import`, kind: "shared", path: e.path, entry: line, state: "ours-absent", action: e.present ? "add" : "create",
      reason: e.present ? `${blockFile} carries the block; ${e.file} must import it` : `${e.file} is what this harness reads by itself; it is created to import ${blockFile}`,
      before: e.present ? text : null, after });
  }
  return items;
}

// ─── host-plugin-registration ──────────────────────────────────────────

// One host command as a plan step: the verbatim argv (the manifest's
// subcommand with its placeholders filled), why it runs, and the host-owned
// files it is known to touch (measured 2026-09-05 — the manifest's cli.verified).
// A portable registration keeps its marketplace and enablement stanzas in one
// global config (registry.global_config; Codex's config.toml, measured
// 2026-09-07), so the preview names that file wherever a step rewrites it.
function hostStep(a, s, name, fill, why) {
  const template = s.cli.commands[name];
  if (!Array.isArray(template) || !template.length) throw new Error(`${s.format}: host operation ${name} is not declared`);
  const argv = template.map((t) => t.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? `{${k}}`));
  const p = a.paths;
  const touches = {
    validate: [], marketplace_add: [p.marketplaces, p.globalConfig, p.projectSettings], marketplace_update: [p.marketplaces], marketplace_remove: [p.marketplaces, p.globalConfig, p.projectSettings],
    install: [p.installed, p.globalConfig, p.projectSettings, p.cacheDir], update: [p.installed, p.cacheDir], uninstall: [p.installed, p.globalConfig, p.projectSettings], disable: [p.projectSettings], enable: [p.projectSettings],
  }[name] || [];
  return { kind: "host", name, bin: s.cli.bin, argv, why, touches: touches.filter(Boolean) };
}

function portableListFacts(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "")); } catch { return null; }
  if (!Array.isArray(parsed?.installed)) return null;
  return parsed.installed;
}

function portableListFact(stdout, id) {
  const rows = portableListFacts(stdout);
  if (!rows) return null;
  const row = rows.find((entry) => entry?.pluginId === id);
  if (!row) return null;
  return {
    id: row.pluginId,
    version: typeof row.version === "string" ? row.version : null,
    installed: row.installed === true,
    enabled: row.enabled === true,
    marketplaceSource: row.marketplaceSource?.source || null,
  };
}

function planPortableRegistration(ctx, key, s) {
  const { projectDir, mode, root, home, env, harness, globalRemoval } = ctx;
  const a = analysePortableRegistration(projectDir, s, { root, home, harness, env });
  const fill = { dir: a.paths.dir, marketplace: s.marketplace_name, id: a.id };
  const base = {
    surface: key,
    kind: "registration",
    path: a.paths.dir,
    entry: a.id,
    state: a.state,
    reason: a.reason || a.refusal || null,
    root: a.installPath,
    home: a.paths.home,
    scope: s.scope,
    ownership: s.ownership,
    observed: {
      dir_exists: existsSync(a.paths.dir),
      ownership_version: a.ownership?.version || null,
      ownership_digest: a.ownership?.digest || null,
      marketplace_source: a.market?.source || null,
      global_plugin: a.globalPlugin || null,
      project_plugin: a.projectPlugin || null,
      installed_version: a.installedVersion || null,
      installed_digest: a.installed?.digest || null,
      enabled: a.enabled,
    },
  };
  // The same fact the analyser computed: no portable payload in this run. A
  // shell that named a root which is not a plugin root is broken, and says so
  // through `incomplete`; the core run alone simply defers.
  if (!a.payloadRoot) {
    if (env.PROJECTSTORE_DISTRIBUTION_ROOT) ctx.incomplete = true;
    return [{ ...base, action: "skip", deferred: true, reason: env.PROJECTSTORE_DISTRIBUTION_ROOT
      ? `${env.PROJECTSTORE_DISTRIBUTION_ROOT} is not a portable plugin root; ${harness.display_name}'s registration runs only from its built distribution shell`
      : `the core package is not ${harness.display_name}'s plugin root; registration runs only from its built distribution shell` }];
  }
  if (mode === "uninstall" && !globalRemoval) {
    return [{ ...base, action: "skip", reason: "the plugin package and cache are global; project uninstall removes only project-owned surfaces. Use uninstall --global with an explicit harness to preview global removal" }];
  }
  if (["foreign", "conflict"].includes(a.state)) return [{ ...base, action: "refuse", reason: a.refusal }];
  if (a.state === "unavailable") { ctx.incomplete = true; return [{ ...base, action: "skip", deferred: true }]; }
  if (mode === "uninstall") {
    if (a.state === "absent") return [{ ...base, action: "skip", reason: "no global registration of ours" }];
    if (!a.bin) { ctx.incomplete = true; return [{ ...base, action: "skip", reason: `\`${s.cli.bin}\` is not on PATH; global registration is left untouched` }]; }
    const steps = [];
    if (a.installed) steps.push(hostStep(a, s, "uninstall", fill, `explicit global removal forgets ${a.id}`));
    if (a.market && s.cli.commands.marketplace_remove) steps.push(hostStep(a, s, "marketplace_remove", fill, `explicit global removal forgets marketplace ${s.marketplace_name}`));
    if (a.ownership) steps.push({ kind: "portable-remove", path: a.paths.dir, homeBase: a.paths.home, why: "the stable marketplace source is owned by this installer" });
    return [{ ...base, action: "remove", steps, reason: "explicit global removal; project overrides are preserved" }];
  }
  if (a.state === "current") return [{ ...base, action: "skip", reason: a.reason }];
  if (!a.bin) { ctx.incomplete = true; return [{ ...base, action: "skip", deferred: true, reason: `\`${s.cli.bin}\` is not on PATH; no registration mutation was attempted` }]; }
  const steps = [];
  const digest = a.desiredDigest;
  const mustWrite = !a.ownership || a.ownership.version !== a.desiredVersion || a.contentDiffers || a.state === "stale";
  if (mustWrite) {
    const files = payloadFiles(a.payloadRoot);
    const ownership = { [s.provenance_key]: { grammar: GRAMMAR_VERSION, version: a.desiredVersion, generator: GENERATOR, digest } };
    steps.push({ kind: "portable-write", path: a.paths.dir, from: a.payloadRoot, files, subdir: s.plugin_subdir, catalogRel: s.manifest, catalog: renderPortableCatalog(s), ownershipRel: s.ownership_manifest, ownership, why: a.ownership ? `stage ${a.desiredVersion} over ${a.ownership.version}` : `stage ${a.desiredVersion}` });
  }
  if (!a.market) steps.push(hostStep(a, s, "marketplace_add", fill, "register the stable local marketplace source globally"));
  if (!a.installed || a.installedVersion !== a.desiredVersion || mustWrite) steps.push(hostStep(a, s, "install", fill, `materialise and enable ${a.id} from the staged source`));
  steps.push(hostStep(a, s, "list", fill, "read back host-reported installation and effective enablement"));
  return [{ ...base, action: a.state === "absent" ? "create" : "update", steps, verify: { version: a.desiredVersion, digest }, reason: a.reason }];
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
    if (a.state === "absent" || a.state === "unavailable") return named ? [{ ...base, action: "skip", deferred: true, reason: `this root is the host's own install of the plugin; it does not register a second copy of itself — the npm package does, from a terminal: ${packageCommand(harness, "install", { args: `--project "${projectDir}"` })}` }] : [];
    if (a.state === "current") return [{ ...base, action: "skip" }];
    return [{ ...base, action: "skip", deferred: true, reason: `${a.reason} — this root is the host's own install; refresh the registration from the package, outside a session: ${packageCommand(harness, "upgrade", { version: "<version>", args: `--surface ${key} --project "${projectDir}"` })}` }];
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
    const rewrite = !a.dir.present || (cmpPrecedence(a.dir.pkg, a.pkg) < 0) || a.dir.digestOk === false || sameVersionDiffers;
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

export function plan(projectDir, { harnesses = [], mode = "install", env = process.env, home = homedir(), root = pluginRoot(), surfaces = null, globalRemoval = false, register = true } = {}) {
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
  const layoutCtx = { projectDir, mode, env, home, root, harness: layoutHarness, incomplete: false, surfaces };
  const layout = planLayout(layoutCtx);
  for (const item of layout.first) out.items.push({ harness: layoutHarness.id, ...item });
  if (layoutCtx.incomplete) out.incomplete = true;
  for (const id of ids) {
    const harness = loadHarness(id);
    out.harnesses.push(id);
    const ctx = { projectDir, mode, env, home, root, harness, optIn, slotForeign: new Set(), incomplete: false, renderRoot: root, surfaces: surfaces || [], globalRemoval };
    const hostRows = [];
    const unsupportedHost = [];
    let registration = null;
    const rows = Object.entries(harness.surfaces || {}).filter(([key]) => !key.startsWith("_"));
    rows.sort(([, x], [, y]) => (KIND_ORDER[x.kind] ?? 3) - (KIND_ORDER[y.kind] ?? 3));
    for (const [key, s] of rows) {
      // --no-register: this run changes the project's files and nothing of the
      // host's (the layout move run from an installed copy; the layout spec,
      // contract 12 as amended 2026-10-03).
      const excluded = (surfaces && !surfaces.some((x) => key === x || key.startsWith(x + "_"))) || (register === false && s.kind === "registration");
      if (excluded) {
        // A registration this run leaves out still decides the render root,
        // read-only — HERE, before the surfaces that render against it (the
        // registration sorts first). Read after the loop, as it was until
        // 2026-10-03, it moved only the preview's "planned against" line and
        // never an item: a --no-register run from a checkout re-pointed the
        // status line at the checkout (the second review of the 2026-10-03
        // fixes, S1).
        if (s.kind === "registration" && !isPluginCacheRoot(root, home)) {
          const analyser = s.format === "portable-plugin-registration" ? analysePortableRegistration : analyseRegistration;
          const a = analyser(projectDir, s, { root, home, harness, env });
          if (a.installed && (a.installed.present ?? true) && a.enabled) ctx.renderRoot = a.installPath;
        }
        continue;
      }
      // `kind: host` and `supported: false` are different facts and the report
      // must not merge them: the first says the host installs this surface, the
      // second says the harness has no such surface at all. Reporting both as
      // "installed by the host" told a Codex user that its commands, agents,
      // MCP and status line — four rows the manifest declares absent — were
      // waiting for it somewhere. An unsupported surface is named below by its
      // own row, with the reason the manifest gives.
      if (s.kind === "host") { if (s.supported !== false) hostRows.push(key); else unsupportedHost.push([key, s]); continue; }
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
    if (ctx.renderRoot !== root) {
      out.plannedAgainst[id] = ctx.renderRoot;
      // Items planned before the render root was known (none today: the registration sorts first) are not re-planned.
    }
    if (ctx.incomplete) out.incomplete = true;
    if (hostRows.length && !surfaces) {
      out.reports.push(hostManagedReport(harness, hostRows, registration));
      // The same fact in one line, for the compact preview (contract 18). Not
      // enumerable: the preview reads it, and plan --json keeps the shape it
      // had (the planner's review, 2026-10-05).
      if (!Object.hasOwn(out, "hostManaged")) Object.defineProperty(out, "hostManaged", { value: [], enumerable: false });
      out.hostManaged.push({ harness: harness.id, display: harness.display_name, rows: hostRows, entry: registration?.entry || null, action: registration?.action || null });
    }
    // An unsupported host surface gets the same row shape a shared one does
    // (planJsonEntry's unsupported branch): state "unsupported", action "skip",
    // and the manifest's own reason. One treatment for one fact, so a reader —
    // and a test — meets "this harness does not have that" in one form rather
    // than two.
    for (const [key, s] of unsupportedHost) {
      out.items.push({ harness: id, surface: key, kind: "host", path: null, entry: null, state: "unsupported", action: "skip", reason: s.why_unsupported || "not supported for this harness yet" });
    }
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
    // ours (its header); the legacy binding is bind's, never uninstall's. A
    // narrowed uninstall leaves it alone: the way back from an npm switch is
    // `uninstall --surface plugin`, and it deleted a not-yet-moved project's
    // sessions, log and the launcher its status line still ran (the critic's
    // fourth pass, 2026-10-04). `surfaces` is null when nothing was named.
    if (ctx.surfaces) return none;
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
    if (a.legacy.launcher) cleanup.push({ kind: "remove-legacy-launcher", path: P.legacy.launcher, why: "removed once the new launcher is written and the settings entry names it — or at once when the status-line slot is not ours (foreign, or empty because the status line is off); kept while a settings file the host reads (this project's local or committed settings, or the user's) still runs it as the status line — a script that calls it indirectly is not seen" });
    if (a.legacy.runtime) cleanup.push({ kind: "rmdir-legacy", path: P.legacy.runtime, why: "the emptied pre-0.28 runtime directory" });
    last.push({ ...base, surface: "layout_cleanup", path: P.legacy.runtime, state: "legacy", action: "cleanup", reason: null, steps: cleanup });
  }
  return { first, last };
}

function applyLayout(p, i, { failed, home = homedir(), onStep = null }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const within = p.projectDir;
  if (i.action === "cleanup" && failed) { out.action = "skipped"; out.reason = "an earlier item failed; the legacy files stay until the next run"; return out; }
  const fail = (step, message) => { out.failed = { step, status: null, stderr: message }; return out; };
  for (const st of i.steps || []) {
    const seen = out.steps.length;
    if (onStep) onStep(st, "start");
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
        // "Still in use" is decided by the FILE, not the spelling: an entry
        // written through a symlinked or differently-cased path, or living in
        // the committed or the user's settings, still runs it (the third review
        // of the 2026-10-03 fixes — a string comparison of the local file alone
        // deleted a launcher the status line was running).
        const named = entryNames(p.projectDir, i.harness, st.path) || settingsRunFile(p.projectDir, i.harness, st.path, home);
        // Moved, never just deleted: the legacy launcher goes only once the new
        // one exists (a dev root produces none — contract 7 leaves it in place)
        // — unless the status-line slot is not ours (any wiring of ours counts).
        // Under a foreign or empty slot the new launcher is never made, and
        // keeping the old one kept layout-legacy alive forever (the critic of
        // the layout spec's 2026-10-03 amendment, case S1).
        const moved = existsSync(layoutPaths(p.projectDir).launcher(i.harness));
        const slotOurs = slotIsOurs(p.projectDir, i.harness, { home, root: p.root });
        if (text === null) out.steps.push({ kind: st.kind, ok: true, removed: false });
        else if (!moved && slotOurs) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "no launcher at the new path yet (this root does not produce one) — left in place" });
        else if (!isOurFile(text)) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "not ours — left in place" });
        else if (named) out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "a settings file the host reads still runs it as the status line — left in place" });
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
    finally { if (onStep) onStep(st, "end", stepResult(out, seen)); }
  }
  return out;
}

// What one step left behind, for the APPLY line: its record when it pushed
// one, and a failure when the item failed under it.
function stepResult(out, seen) {
  const rec = out.steps.length > seen ? out.steps[out.steps.length - 1] : null;
  return { ok: !out.failed && (!rec || rec.ok !== false), kept: Boolean(rec && rec.removed === false && rec.reason) };
}

// Does any settings file the host reads run this file as its status line?
// Compared by identity (device and inode), so a path spelled through a symlink
// or in another case still counts; the project-directory variable a command
// may carry is substituted first.
function settingsRunFile(projectDir, harnessId, file, home) {
  const id = (f) => { try { const s = statSync(f); return `${s.dev}:${s.ino}`; } catch { return null; } };
  const want = id(file);
  if (!want) return false;
  const h = loadHarness(harnessId);
  const dir = h.runtime?.harness_dir || ".claude", v = h.runtime?.project_dir_env;
  const files = [join(projectDir, h.surfaces?.statusline?.file || join(dir, "settings.local.json")), join(projectDir, dir, "settings.json"), join(claudeHome(home), "settings.json")];
  return files.some((f) => {
    try {
      let cmd = JSON.parse(readFileSync(f, "utf8"))?.statusLine?.command;
      if (typeof cmd !== "string") return false;
      if (v) cmd = cmd.split("${" + v + "}").join(projectDir).split("$" + v).join(projectDir);
      const sp = statusLineScriptPath(cmd);
      return Boolean(sp) && id(isAbsolute(sp) ? sp : join(projectDir, sp)) === want;
    } catch { return false; }
  });
}

// Is the harness's status-line slot wired to anything of ours (any wiring)?
function slotIsOurs(projectDir, harnessId, { home, root }) {
  try {
    const s = loadHarness(harnessId).surfaces?.statusline;
    if (!s || !s.file) return false;
    const cmd = JSON.parse(readFileSync(join(projectDir, s.file), "utf8"))?.statusLine?.command;
    return typeof cmd === "string" && statusLineIsOurWiring(cmd, projectDir, home, root);
  } catch { return false; }
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
//
// Contract 18: a header, then PLAN — one line per item (what, where, the state
// transition) with its steps beneath. Every path written and every host argv
// with the files it touches stays in the default view: that is contract 9's
// consent content, and a reader that is an agent needs it as much as a person.
// The explanations — the host-managed report, per-row reasons, each step's why,
// the planned-against note — are folded behind `--verbose`. Colour comes from
// the caller (term.mjs decides); the default is plain text.

// Every action a plan item can carry. A write never wears the skip glyph:
// `add` and `replace-entry` are changes as much as `create` and `update`.
const ACTION_ICON = { create: "create", add: "create", update: "update", "replace-entry": "update", migrate: "migrate", disable: "update", cleanup: "cleanup", remove: "remove", prune: "remove", skip: "skip", refuse: "refuse" };
const ACTION_COLOR = { create: "green", add: "green", update: "cyan", "replace-entry": "cyan", migrate: "cyan", disable: "cyan", cleanup: "yellow", remove: "yellow", prune: "yellow", skip: "gray", refuse: "red" };

// One step of an item as the lines it shows: always the action and its target,
// then — under --verbose — why it runs.
function stepLines(p, st, { verbose, paint, width = 0 }) {
  const r = (x) => rel(p.projectDir, x);
  const lead = "      ";
  const sub = "          ";
  const why = verbose && st.why ? wrap(st.why, width, sub).split("\n").map((l, k) => (k ? "" : sub) + paint("gray", l)) : [];
  switch (st.kind) {
    case "host": {
      const out = [`${lead}${paint("cyan", "$")} ${[st.bin, ...st.argv].join(" ")}`];
      if (st.touches.length) out.push(`${sub}${paint("gray", `touches ${st.touches.map(r).join(", ")}`)}`);
      return [...out, ...why];
    }
    case "note": return wrap(`note: ${st.why}`, width, sub).split("\n").map((l, k) => (k ? l : lead + paint("yellow", "note:") + l.slice(5)));
    case "write": return [`${lead}write ${st.path}${st.manifestOnly ? " (manifest only)" : ` (${st.files} files + the manifest)`}`, ...why];
    case "portable-write": return [`${lead}stage ${st.path} (${st.files.length} payload files + catalogue + ownership)`, ...why];
    case "portable-remove":
    case "remove": return [`${lead}remove ${st.path}`, ...why];
    case "unregister": return [`${lead}edit ${r(st.path)}  [${st.pointer}.${st.name}] → removed`, ...why];
    case "ensure": return [`${lead}ensure ${r(st.path)}/`, ...why];
    case "move-state": return [`${lead}move ${r(st.from)}/ → ${r(st.to)}/ (${st.files} entries)`, ...why];
    case "merge-log": return [`${lead}merge ${r(st.from)} → ${r(st.to)}`, ...why];
    case "delete": return [`${lead}delete ${r(st.path)}`, ...why];
    case "move-marker": return [`${lead}move ${r(st.from)} → ${r(st.to)}`, ...why];
    case "move-binding": return [`${lead}move ${r(st.from)} → ${r(st.to)}  (agents → ${r(st.overlay)})`, ...why];
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime": return [`${lead}remove ${r(st.path)}`, ...why];
    default: return [];
  }
}

// The harnesses a plan names, by their display names — for the header.
function displayNames(p) {
  return p.harnesses.map((id) => loadHarness(id)?.display_name || id).join(", ") || "(no harness)";
}

const tilde = (path) => {
  const h = homedir();
  return path === h || path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
};

export function renderPreview(p, { verbose = false, verb = null, paint = (_style, text) => String(text), icon = null, width = 0 } = {}) {
  const glyph = icon || ((name) => ({ create: "+", update: "↻", migrate: "↻", cleanup: "✕", remove: "✕", skip: "·", refuse: "!" }[name] || "·"));
  const writes = p.items.filter(isWrite);
  const lines = [
    `${paint("bold", "projectstore")} · ${verb || p.mode} · ${displayNames(p)}`,
    `  ${paint("gray", tilde(p.projectDir))}`,
    "",
  ];
  // Prose, wrapped to the terminal with every line indented; a path or a
  // command inside it is one word and never broken (term.mjs wrap).
  const prose = (indent, text, style = "gray") => wrap(text, width, indent).split("\n").map((l, k) => (k ? "" : indent) + paint(style, l));
  if (verbose) {
    for (const [h, r] of Object.entries(p.plannedAgainst || {})) lines.push(...prose("  ", `${h}: the surfaces below are planned against the host's install path ${r}, not this package at ${p.root}.`), "");
    for (const r of p.reports) lines.push(...r.split("\n").flatMap((l) => (l.trim() ? prose("  ", l) : [""])), "");
  }
  const count = writes.length === 1 ? "1 change" : `${writes.length} changes`;
  lines.push(`${paint("bold", "PLAN")} — ${p.ok ? count : "refused"}`);
  // Unsupported host rows (no path, nothing this harness has) fold into one
  // line per harness by default; --verbose lists each with the manifest's reason.
  const folded = new Map();
  for (const i of p.items) {
    if (!verbose && i.path === null && i.state === "unsupported" && i.action === "skip") {
      const k = loadHarness(i.harness)?.display_name || i.harness;
      if (!folded.has(k)) folded.set(k, []);
      folded.get(k).push(i.surface);
      continue;
    }
    const target = i.path === null ? `${i.surface} [${i.harness}, no filesystem path]` : rel(p.projectDir, i.path);
    const where = target + (i.entry ? `  [${i.entry}]` : "");
    let state = i.state;
    if (i.state === "current" && i.writtenBy && !i.sameProject) state = `current, last written by ${i.writtenBy}`;
    // A row's reason is shown whenever it has one: a row of something
    // already right carries none, and every other reason — a change, a skip
    // that needs a terminal or a PATH, a block kept for another harness —
    // is something the reader acts on (the reviewer's pass, 2026-10-05).
    if (i.reason && i.action !== "refuse") state += ` (${i.reason})`;
    const color = ACTION_COLOR[i.action] || (isWrite(i) ? "cyan" : "gray");
    const mark = paint(color, glyph(ACTION_ICON[i.action] || (isWrite(i) ? "update" : "skip")));
    const transition = `${state} → ${i.action}${i.action === "refuse" && i.reason ? ": " + i.reason : ""}`;
    lines.push(`  ${mark} ${paint("bold", i.kind.padEnd(12))} ${where}`);
    lines.push(...prose("      ", transition));
    for (const st of i.steps || []) lines.push(...stepLines(p, st, { verbose, paint, width }));
    if (i.kind === "registration" && i.home && i.surface && !i.surface.endsWith("_others")) lines.push(`      ${paint("gray", `(harness home ${i.home}${i.scope ? `, scope ${i.scope}` : ""})`)}`);
    if (i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim()) lines.push(`      ${paint("gray", "(the file would hold nothing else and is removed)")}`);
  }
  const hostLine = (text) => { const [first, ...rest] = wrap(text, width, " ".repeat(17)).split("\n"); return [`  ${paint("gray", glyph("skip"))} ${paint("bold", "host".padEnd(12))} ${first}`, ...rest]; };
  for (const h of p.hostManaged || []) {
    const from = h.entry ? `from the registration ${h.entry}` : "from the host's own plugin system";
    lines.push(...hostLine(`${h.display} installs ${h.rows.join(", ")} itself, ${from}`));
  }
  for (const [display, rows] of folded) lines.push(...hostLine(`not on ${display}: ${rows.join(", ")} — unsupported → skip ${paint("gray", "(--verbose says why)")}`));
  const exclusiveRemoval = p.items.find((i) => i.action === "remove" && i.kind === "exclusive");
  if (exclusiveRemoval) lines.push(`      ${paint("gray", `(an emptied ${rel(p.projectDir, dirname(exclusiveRemoval.path))}/ is pruned)`)}`);
  for (const r of p.refusals) { const [first, ...rest] = wrap(r, width, " ".repeat(17)).split("\n"); lines.push(`  ${paint("red", glyph("refuse"))} ${paint("bold", "refused".padEnd(12))} ${first}`, ...rest); }
  lines.push("", `  ${paint("gray", "Nothing outside a marked entry is read, rewritten or removed.")}`);
  if (p.items.some((i) => (i.steps || []).some((s) => s.kind === "host"))) lines.push(`  ${paint("gray", "Each $ line runs the host's own CLI, which writes the host-owned files named after it.")}`);
  if (!p.ok) lines.push("", `  ${paint("red", "Nothing will be written: resolve the refusals above first.")}`);
  else if (!writes.length) lines.push("", "  Nothing to change." + (p.incomplete ? " One surface could not be planned (see above)." : ""));
  else if (p.incomplete) lines.push("", "  One surface could not be planned (see above); the rest proceeds.");
  return lines.join("\n") + "\n";
}

// ─── gate ──────────────────────────────────────────────────────────────

// Contract 9, amended 2026-10-04: a person at a terminal is asked, even when
// the harness is named — the shells always name it, so naming alone had
// stopped meaning a person agreed. Without one (a pipe, an agent's tool call,
// CI, --json, a command run inside a host session) a named harness is the
// confirmation and a bare one refuses, exactly as before.
export function isInteractive({ stdin = null, stdout = null, env = process.env, json = false } = {}) {
  if (json) return false;
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) return false;
  if (env.CI && !["0", "false"].includes(String(env.CI).toLowerCase())) return false;
  // A host session's own tool may run us in a pseudo-terminal; the manifests'
  // session markers say when that is happening — every manifest's, not only
  // the planned harness's: a Claude Code agent running the Codex shell is
  // still an agent. (Codex's own markers are unmeasured; for it the TTY test
  // above carries the rule.)
  if ([...loadHarnesses().values()].some((m) => insideHostSession(env, m))) return false;
  return true;
}

// Streams and `ask` are parameters so the terminal branch is testable without
// a pseudo-terminal; passing `ask` means "this is a terminal". Without streams
// the library never asks — the bin and main() pass theirs.
export async function confirm(p, { stdin = null, stdout = null, ask = null, env = process.env, json = false, paint = (_style, text) => String(text) } = {}) {
  if (!p.ok) return { confirmed: false, why: "refused" };
  const writes = p.items.filter(isWrite);
  if (!writes.length) return { confirmed: false, why: "nothing-to-do" };
  const interactive = !json && (ask ? true : isInteractive({ stdin, stdout, env, json }));
  if (!interactive) return p.named ? { confirmed: true, why: "named" } : { confirmed: false, why: "non-tty" };
  const question = `${paint("bold", `Apply ${writes.length === 1 ? "1 change" : `${writes.length} changes`}?`)} ${paint("gray", "[Y/n]")} `;
  const answer = ask ? await ask(question) : await askLine(question, stdin, stdout);
  if (answer === null || answer === undefined) return { confirmed: false, why: "declined" };
  return /^(y(es)?)?$/i.test(String(answer).trim()) ? { confirmed: true, why: "answered" } : { confirmed: false, why: "declined" };
}

// ─── apply ─────────────────────────────────────────────────────────────

export function apply(p, { env = process.env, spawn = spawnSync, home = homedir(), onItem = null, onStep = null } = {}) {
  if (!p.ok) throw new Error("apply: the plan carries refusals; nothing is written");
  const done = [];
  let registrationFailed = false;
  let layoutFailed = false;
  // One item's writes, returning the record apply reports for it. The order
  // and the failure rules are the loop's; onItem only watches (contract 18).
  const one = (i) => {
    if (i.kind === "layout") {
      const r = applyLayout(p, i, { failed: layoutFailed || registrationFailed || Boolean(done.failed), home, onStep });
      if (r.failed) { done.failed = r.failed; layoutFailed = true; }
      return r;
    }
    if (i.kind === "registration") {
      const r = applyRegistration(p, i, { env, spawn, home, onStep });
      // A registration that did not complete leaves the surfaces planned against
      // its install path unwritten: a launcher pointing at nothing is worse than
      // none. Surfaces rendered from the package root (the block) still apply.
      if (r.failed) { done.failed = r.failed; registrationFailed = true; }
      return r;
    }
    if (registrationFailed && i.plannedAgainst) return { path: i.path, action: "skipped", surface: i.surface, reason: "the registration did not complete; this surface was planned against its install path" };
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
    return { path: i.path, action: i.action, surface: i.surface };
  };
  for (const i of p.items) {
    if (!isWrite(i)) continue;
    if (onItem) onItem(i, "start");
    let r;
    try { r = one(i); }
    catch (e) { if (onItem) onItem(i, "abort"); throw e; }
    done.push(r);
    if (onItem) onItem(i, "end", r);
  }
  return done;
}

// The registration's steps, in order, each leaving a state plan() can read.
// The host binary runs with the harness home pinned in its environment — the
// same home the plan was read from — and with the project as its cwd, which is
// how the host resolves `--scope local`. A non-zero exit stops the item and
// is recorded, never retried, never masked.
function applyRegistration(p, i, { env, spawn, home, onStep = null }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const harness = loadHarness(i.harness);
  const childEnv = { ...env, [homeEnvName(i.harness)]: i.home || claudeHome(home) };
  const s = harness.surfaces[i.surface.replace(/_others$/, "")];
  const portable = s.format === "portable-plugin-registration";
  let staged = null;
  const completedHost = [];
  let hostList = null;
  let lock = null;
  let lockPath = null;
  const journalPath = portable ? join(i.home, "projectstore", `${s.marketplace_name}.journal.json`) : null;
  const releaseLock = () => {
    if (lock !== null) { try { closeSync(lock); } catch {} lock = null; }
    if (lockPath) { try { unlinkSync(lockPath); } catch {} lockPath = null; }
  };
  const readHostList = () => {
    const argv = s.cli.commands.list || [];
    const bin = whichOnPathFromLib(s.cli.bin, env);
    const r = spawn(bin || s.cli.bin, argv, { env: childEnv, cwd: p.projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const rows = !r.error && r.status === 0 ? portableListFacts(r.stdout) : null;
    out.steps.push({ kind: "portable-recovery-list", argv: [s.cli.bin, ...argv], status: r.status ?? null, ok: Boolean(rows) });
    return { rows, stderr: String((r.stderr || "") + (r.error ? r.error.message : "")).trim() };
  };
  const observedPortable = (a) => ({
    dir_exists: existsSync(a.paths.dir),
    ownership_version: a.ownership?.version || null,
    ownership_digest: a.ownership?.digest || null,
    marketplace_source: a.market?.source || null,
    global_plugin: a.globalPlugin || null,
    project_plugin: a.projectPlugin || null,
    installed_version: a.installedVersion || null,
    installed_digest: a.installed?.digest || null,
    enabled: a.enabled,
  });
  const sameObserved = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const ownedTargetMatches = (target, expected) => {
    if (!expected?.version || !expected?.digest) return false;
    let owned = null;
    try { owned = JSON.parse(readFileSync(join(target, s.ownership_manifest), "utf8"))?.[s.provenance_key] || null; } catch {}
    return owned?.version === expected.version
      && owned?.digest?.sha256 === expected.digest.sha256
      && owned?.digest?.count === expected.digest.count;
  };
  const verifyPrevious = (previous) => {
    const listed = readHostList();
    if (!listed.rows) return { ok: false, why: listed.stderr || "Codex plugin list did not return JSON" };
    const row = listed.rows.find((entry) => entry?.pluginId === i.entry) || null;
    if (!previous) {
      const a = analysePortableRegistration(p.projectDir, s, { root: p.root, home, harness, env: childEnv, ignoreJournal: true });
      const cacheRoot = join(i.home, ...(s.registry.cache_dir || ["plugins", "cache"]), s.marketplace_name, s.plugin_name);
      let cached = [];
      try { cached = readdirSync(cacheRoot); } catch {}
      if (existsSync(i.path)) return { ok: false, why: `first-install rollback left the stable marketplace source at ${i.path}` };
      if (a.market) return { ok: false, why: `first-install rollback left marketplace ${s.marketplace_name} in ${a.paths.globalConfig}` };
      if (a.globalPlugin || a.projectPlugin) return { ok: false, why: `first-install rollback left plugin enablement for ${i.entry}` };
      if (row) return { ok: false, why: `${i.entry} remains host-reported after first-install rollback` };
      if (cached.length) return { ok: false, why: `first-install rollback left ${cached.length} materialised cache version(s) under ${cacheRoot}` };
      return { ok: true };
    }
    const a = analysePortableRegistration(p.projectDir, s, {
      root: p.root,
      payloadRoot: join(i.path, s.plugin_subdir),
      home,
      harness,
      env: childEnv,
      ignoreJournal: true,
    });
    const digest = previous.digest || {};
    const sourceOk = a.sourceDigest?.sha256 === digest.sha256 && a.sourceDigest?.count === digest.count;
    const cacheOk = a.installed?.digest?.sha256 === digest.sha256 && a.installed?.digest?.count === digest.count;
    const hostOk = row && row.version === previous.version && row.installed === true && row.enabled === previous.enabled && resolve(row.marketplaceSource?.source || "") === resolve(i.path);
    const ok = a.state === "current" && a.installedVersion === previous.version && a.enabled === previous.enabled && sourceOk && cacheOk && hostOk;
    return ok ? { ok: true } : { ok: false, why: `restored source/cache/enablement could not be proven (state=${a.state}, version=${a.installedVersion || "?"}, enabled=${String(a.enabled)})` };
  };
  const requireRecovery = (journal, why) => {
    writeFileAtomic(journalPath, JSON.stringify({ ...journal, phase: "recovery-required", error: why }, null, 2) + "\n", { sweep: false });
    releaseLock();
    out.failed = { step: "recovery-required", status: null, stderr: `${why}; ${journalPath} was retained and blocks automatic mutation` };
    return out;
  };
  if (portable) {
    const lockDir = join(i.home, "projectstore");
    mkdirSync(lockDir, { recursive: true });
    lockPath = join(lockDir, `${s.marketplace_name}.lock`);
    const acquire = () => {
      try { lock = openSync(lockPath, "wx", 0o600); return true; }
      catch (e) {
        if (e?.code !== "EEXIST") throw e;
        let owner = null;
        try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch {}
        let dead = false;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { dead = probe?.code === "ESRCH"; }
        }
        if (!dead) return false;
        unlinkSync(lockPath);
        out.steps.push({ kind: "portable-stale-lock", pid: owner.pid, ok: true });
        lock = openSync(lockPath, "wx", 0o600);
        return true;
      }
    };
    try {
      if (!acquire()) {
        out.failed = { step: "lock", status: null, stderr: `${lockPath} is held by a live or unidentifiable owner; another ProjectStore registration may be running. Inspect the lock before removing it` };
        return out;
      }
      writeExclusiveMetadata(lock, { pid: process.pid, started_at: new Date().toISOString() });
    } catch (e) {
      releaseLock();
      out.failed = { step: "lock", status: null, stderr: e && e.message ? e.message : String(e) };
      return out;
    }
    if (existsSync(journalPath)) {
      let journal;
      try { journal = JSON.parse(readFileSync(journalPath, "utf8")); }
      catch { releaseLock(); out.failed = { step: "recovery", status: null, stderr: `${journalPath} is not valid JSON; inspect it before retrying` }; return out; }
      const ownedPath = (value) => typeof value === "string" && (resolve(value) === resolve(i.path) || inside(resolve(value), resolve(i.home)));
      if (!journal || resolve(journal.target || "") !== resolve(i.path) || !ownedPath(journal.stage) || (journal.backup && !ownedPath(journal.backup))) {
        releaseLock(); out.failed = { step: "recovery", status: null, stderr: `${journalPath} does not describe this owned marketplace; inspect it before retrying` }; return out;
      }
      try {
        if (journal.phase === "recovery-required") return requireRecovery(journal, journal.error || "a prior registration could not prove restoration");
        if (journal.phase === "verified") finishPortableMarketplace(journal.target, journal.backup || null);
        else if (journal.phase === "swapped" || (journal.phase === "prepare" && journal.backup && existsSync(journal.backup))) rollbackPortableMarketplace(journal.target, journal.backup || null);
        else if (journal.phase === "prepare" && !journal.previous && existsSync(journal.target)) {
          if (!ownedTargetMatches(journal.target, journal.next)) return requireRecovery(journal, `first-install recovery found an unrecognised target at ${journal.target}`);
          rollbackPortableMarketplace(journal.target, null);
        }
        if (existsSync(journal.stage)) removeTreeUnder(journal.stage, i.home);
        if (journal.phase !== "verified") {
          const restored = verifyPrevious(journal.previous || null);
          if (!restored.ok) return requireRecovery(journal, restored.why);
        }
        unlinkSync(journalPath);
        out.steps.push({ kind: "portable-recover", phase: journal.phase || "unknown", ok: true });
      } catch (e) {
        releaseLock(); out.failed = { step: "recovery", status: null, stderr: e && e.message ? e.message : String(e) }; return out;
      }
    }
    const current = analysePortableRegistration(p.projectDir, s, { root: p.root, home, harness, env: childEnv, ignoreJournal: true });
    const desiredCurrent = current.state === "current"
      && current.desiredVersion === i.verify?.version
      && current.desiredDigest?.sha256 === i.verify?.digest?.sha256
      && current.desiredDigest?.count === i.verify?.digest?.count;
    if (i.action !== "remove" && desiredCurrent) {
      out.action = "skip";
      out.state = "current";
      out.reason = "another completed registration while this plan waited for the lock";
      out.steps.push({ kind: "portable-recheck", state: current.state, action: "skip", ok: true });
      releaseLock();
      return out;
    }
    if (i.action === "remove" && current.state === "absent") {
      out.action = "skip";
      out.state = "absent";
      out.reason = "another removal completed while this plan waited for the lock";
      out.steps.push({ kind: "portable-recheck", state: current.state, action: "skip", ok: true });
      releaseLock();
      return out;
    }
    const desiredChanged = i.action !== "remove" && (current.desiredVersion !== i.verify?.version
      || current.desiredDigest?.sha256 !== i.verify?.digest?.sha256
      || current.desiredDigest?.count !== i.verify?.digest?.count);
    if (["foreign", "conflict", "unavailable"].includes(current.state) || desiredChanged || !sameObserved(observedPortable(current), i.observed)) {
      releaseLock();
      out.failed = { step: "recheck", status: null, stderr: current.refusal || current.reason || "the portable registration changed after preview; re-run the command to produce a fresh plan" };
      return out;
    }
  }
  const fail = (step, status, stderr, argv = null) => {
    if (staged) {
      // A first install can fail after Codex has accepted the marketplace but
      // before verification. Best-effort compensation happens while the staged
      // source still exists, then the filesystem swap is rolled back. A refresh
      // keeps its existing registration and cache; the prior source is restored.
      if (!staged.backup && (completedHost.includes("marketplace_add") || step === "marketplace_add")) {
        const fill = { dir: i.path, marketplace: s.marketplace_name, id: i.entry };
        for (const name of ["uninstall", "marketplace_remove"]) {
          const template = s.cli.commands[name];
          if (!Array.isArray(template)) continue;
          const args = template.map((t) => t.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? `{${k}}`));
          const bin = whichOnPathFromLib(s.cli.bin, env);
          const r = spawn(bin || s.cli.bin, args, { env: childEnv, cwd: p.projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
          out.steps.push({ kind: "portable-compensate", name, argv: [s.cli.bin, ...args], status: r.status ?? null, ok: !r.error && r.status === 0 });
        }
      }
      try {
        rollbackPortableMarketplace(staged.dir, staged.backup);
        out.steps.push({ kind: "portable-rollback", path: staged.dir, ok: true });
        const restored = verifyPrevious(staged.previous || null);
        if (!restored.ok) {
          return requireRecovery({ version: 1, target: staged.dir, stage: `${staged.dir}.none`, backup: null, previous: staged.previous || null }, restored.why);
        }
        if (staged.journal) { try { unlinkSync(staged.journal); } catch {} }
      } catch (e) {
        out.steps.push({ kind: "portable-rollback", path: staged.dir, ok: false, stderr: e.message });
        return requireRecovery({ version: 1, target: staged.dir, stage: `${staged.dir}.none`, backup: staged.backup, previous: staged.previous || null }, `rollback failed: ${e.message}`);
      }
      staged = null;
    }
    out.failed = { step, status, stderr, ...(argv ? { argv } : {}) };
    releaseLock();
    return out;
  };
  for (const st of i.steps || []) {
    // Host commands report through the spawn the caller passed (one line per
    // argv, rollbacks included); the filesystem steps report here.
    const seen = out.steps.length;
    const watched = onStep && st.kind !== "host";
    if (watched) onStep(st, "start");
    try {
    if (st.kind === "portable-write") {
      const token = `${process.pid}-${randomUUID()}`;
      const stage = `${st.path}.staging-${token}`;
      const backup = existsSync(st.path) ? `${st.path}.previous-${token}` : null;
      let previous = null;
      if (backup) {
        const before = analysePortableRegistration(p.projectDir, s, { root: p.root, payloadRoot: join(st.path, st.subdir), home, harness, env: childEnv, ignoreJournal: true });
        if (before.ownership?.version && before.ownership?.digest) previous = { version: before.ownership.version, digest: before.ownership.digest, enabled: before.enabled };
      }
      const next = { version: i.verify?.version || null, digest: i.verify?.digest || null };
      writeFileAtomic(journalPath, JSON.stringify({ version: 1, phase: "prepare", target: st.path, stage, backup, previous, next }, null, 2) + "\n", { sweep: false });
      const result = stagePortableMarketplace(st.path, { from: st.from, files: st.files, subdir: st.subdir, catalogRel: st.catalogRel, catalog: st.catalog, ownershipRel: st.ownershipRel, ownership: st.ownership, homeBase: i.home, token });
      writeFileAtomic(journalPath, JSON.stringify({ version: 1, phase: "swapped", target: st.path, stage: result.stage, backup: result.backup, previous, next }, null, 2) + "\n", { sweep: false });
      staged = { dir: st.path, backup: result.backup, journal: journalPath, previous };
      out.steps.push({ kind: "portable-write", path: st.path, ok: true });
    } else if (st.kind === "portable-remove") {
      removeTreeUnder(st.path, st.homeBase);
      out.steps.push({ kind: "portable-remove", path: st.path, ok: true });
    } else if (st.kind === "write") {
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
      if (portable && st.name === "list") {
        hostList = portableListFact(r.stdout, i.entry);
        if (!hostList) return fail("list", null, `${st.bin} ${st.argv.join(" ")} did not report ${i.entry} in JSON output`, [st.bin, ...st.argv]);
      }
      completedHost.push(st.name);
    }
    } catch (e) {
      return fail(st.kind, null, e && e.message ? e.message : String(e));
    } finally {
      if (watched) onStep(st, "end", stepResult(out, seen));
    }
  }
  // The host's registry is read back: the install path the rest of the plan
  // was rendered against must be the one the host recorded for this checkout.
  if (i.verify) {
    const a = portable
      ? analysePortableRegistration(p.projectDir, s, { root: p.root, home, harness, env: childEnv, ignoreJournal: true })
      : analyseRegistration(p.projectDir, s, { root: p.root, home, harness, env });
    if (portable) {
      const sourceDigestOk = a.sourceDigest?.sha256 === i.verify.digest?.sha256 && a.sourceDigest?.count === i.verify.digest?.count;
      const cacheDigestOk = a.installed?.digest?.sha256 === i.verify.digest?.sha256 && a.installed?.digest?.count === i.verify.digest?.count;
      const listed = hostList && hostList.version === i.verify.version && hostList.installed && hostList.enabled && resolve(hostList.marketplaceSource || "") === resolve(i.path);
      if (a.state !== "current" || a.installedVersion !== i.verify.version || !a.enabled || !sourceDigestOk || !cacheDigestOk || !listed) {
        return fail("verify", null, `after Codex ran, registration is ${a.state} at ${a.installedVersion || "?"}; expected current ${i.verify.version} with digest ${i.verify.digest?.sha256 || "?"}`);
      }
      out.verified = { installPath: a.installPath, version: a.installedVersion, sourceDigest: a.sourceDigest, cacheDigest: a.installed.digest, host: hostList };
    } else if (!a.installPath || resolve(a.installPath) !== resolve(i.verify.installPath) || a.installedVersion !== i.verify.version) {
      return fail("verify", null, `after the host ran, its registry records ${a.installPath || "no install"} at ${a.installedVersion || "?"} for this checkout; the plan rendered the other surfaces against ${i.verify.installPath} at ${i.verify.version} — they are not written`);
    } else {
      out.verified = { installPath: a.installPath, version: a.installedVersion };
    }
  }
  try {
    if (staged) {
      writeFileAtomic(staged.journal, JSON.stringify({ version: 1, phase: "verified", target: staged.dir, stage: `${staged.dir}.none`, backup: staged.backup, previous: staged.previous || null }, null, 2) + "\n", { sweep: false });
      finishPortableMarketplace(staged.dir, staged.backup);
      unlinkSync(staged.journal);
    }
  }
  catch (e) { return fail("finish", null, e && e.message ? e.message : String(e)); }
  releaseLock();
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
  const env = opts.env || process.env;
  // `out` is the text-mode caller's stdout. With it, this prints: the plan
  // first, then the question, then each step as it runs, then DONE.
  const out = opts.out || null;
  const c = out ? termCaps(out, env) : null;
  const paint = c ? painter(c) : (_style, text) => String(text);
  const glyph = c ? (name) => termIcon(c, name) : null;
  const preview = renderPreview(p, { verbose: Boolean(opts.verbose), verb, paint, icon: glyph, width: c && c.live ? c.width : 0 });
  if (out) out.write(preview + "\n");
  const gate = await confirm(p, { ...opts, env, paint });
  const result = { verb, plan: p, preview, gate, applied: [], failed: null, elapsed: 0 };
  if (gate.confirmed) {
    const t0 = Date.now();
    const reporter = out ? applyReporter(out, c, p) : null;
    const spawn = opts.spawn || spawnSync;
    result.applied = apply(p, { env, spawn: reporter ? reporter.spawn(spawn) : spawn, home: opts.home || homedir(), onItem: reporter ? reporter.onItem : null, onStep: reporter ? reporter.onStep : null });
    result.failed = result.applied.failed || null;
    result.elapsed = Date.now() - t0;
    if (out) out.write(renderDone(result, { paint, glyph: glyph || undefined, verbose: Boolean(opts.verbose) }));
  }
  return result;
}

// APPLY, one line per step (contract 18). An item with steps — a
// registration, the layout move — prints its name, then one line per step
// beneath it: each host command, staging write, write and move. Any other
// item is one line.
function applyReporter(out, c, p) {
  const paint = painter(c);
  const item = stepReporter(out, c, { indent: 2 });
  const step = stepReporter(out, c, { indent: 6 });
  let opened = false;
  const open = () => { if (!opened) { out.write(`${paint("bold", "APPLY")}\n`); opened = true; } };
  const label = (i) => {
    const target = i.path === null ? i.surface : rel(p.projectDir, i.path);
    return `${i.kind} ${target}${i.entry ? ` [${i.entry}]` : ""}`;
  };
  const stepped = (i) => i.kind === "registration" || i.kind === "layout";
  return {
    onItem(i, phase, r) {
      open();
      if (stepped(i)) {
        if (phase === "start") out.write(`  ${paint(ACTION_COLOR[i.action] || "cyan", termIcon(c, ACTION_ICON[i.action] || "update"))} ${label(i)}\n`);
        else if (phase === "abort") step.abort();
        else if (r && (r.action === "skipped" || r.action === "skip")) out.write(`      ${paint("gray", termIcon(c, "skip"))} ${paint("gray", `${r.action === "skip" ? "nothing to do" : "skipped"}: ${r.reason || "an earlier item failed"}`)}\n`);
        else if (r && r.failed) out.write(`      ${paint("red", termIcon(c, "fail"))} ${paint("red", "stopped")}\n`);
        return;
      }
      if (phase === "start") item.start(label(i));
      else if (phase === "abort") item.abort();
      else item.end(!(r && (r.failed || r.action === "skipped")), r && r.action === "skipped" ? "skipped" : "");
    },
    onStep(st, phase, r) {
      const text = stepLabel(p, st);
      if (!text) return;
      if (phase === "start") step.start(text);
      else step.end(r ? r.ok : true, r && r.kept ? "kept" : "", { kept: Boolean(r && r.kept) });
    },
    spawn(inner) {
      return (bin, argv, o) => {
        open();
        step.start(`$ ${basename(String(bin))} ${argv.join(" ")}`);
        let r;
        try { r = inner(bin, argv, o); }
        catch (e) { step.abort(); throw e; }
        step.end(!r.error && r.status === 0);
        return r;
      };
    },
  };
}

// A step as its APPLY line names it: the verb and the target, short. The
// full form — file counts, entry pointers — was in PLAN.
function stepLabel(p, st) {
  const r = (x) => tilde(rel(p.projectDir, x));
  switch (st.kind) {
    case "portable-write": return `stage ${r(st.path)}`;
    case "write": return `write ${r(st.path)}`;
    case "unregister": return `edit ${r(st.path)} [${st.pointer}.${st.name}]`;
    case "ensure": return `ensure ${r(st.path)}/`;
    case "move-state": return `move ${r(st.from)}/ → ${r(st.to)}/`;
    case "merge-log": return `merge ${r(st.from)} → ${r(st.to)}`;
    case "move-marker":
    case "move-binding": return `move ${r(st.from)} → ${r(st.to)}`;
    case "delete":
    case "portable-remove":
    case "remove":
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime": return `remove ${r(st.path)}`;
    default: return null;
  }
}

// DONE: what happened, how long it took, what to do next — from the manifests,
// never from a harness-id branch — and at most two tips.
export function renderDone(r, { paint = (_style, text) => String(text), glyph = (n) => termIcon({ ascii: false }, n), verbose = false } = {}) {
  const p = r.plan;
  // What applied: a record that neither failed nor was skipped — a recheck
  // that found the work already done is not a change.
  const n = r.applied.filter((a) => !a.failed && !["skipped", "skip"].includes(a.action)).length;
  const changes = n === 1 ? "1 change" : `${n} changes`;
  const lines = [""];
  if (r.failed) {
    const f = r.failed;
    const record = r.applied.find((a) => a.failed);
    const item = record ? p.items.find((i) => i.surface === record.surface && i.path === record.path) : null;
    const what = f.argv ? "a host command failed" : `${f.step} failed`;
    lines.push(`${paint("bold", "STOPPED")} — ${changes} applied, then ${what}`);
    if (f.argv) lines.push(`  ${paint("red", glyph("fail"))} $ ${f.argv.join(" ")}${f.status === null || f.status === undefined ? "" : ` exited ${f.status}`}`);
    else lines.push(`  ${paint("red", glyph("fail"))} ${f.step}${item ? ` (${item.kind} ${item.path === null ? item.surface : rel(p.projectDir, item.path)})` : ""}`);
    if (f.stderr) for (const l of String(f.stderr).split("\n")) lines.push(`      ${l}`);
    if (item && item.kind === "registration") lines.push("  The surfaces planned against its install path were not written; run the verb again once it succeeds.");
    else lines.push("  Run the verb again once the cause is fixed: its plan starts from what is on disk now.");
    return lines.join("\n") + "\n";
  }
  lines.push(`${paint("bold", "DONE")} — ${changes} in ${duration(r.elapsed || 0)}`);
  const next = [], tips = [];
  const here = (() => { try { return realpathSync(p.projectDir) === realpathSync(process.cwd()); } catch { return p.projectDir === process.cwd(); } })();
  for (const id of p.harnesses) {
    const m = loadHarness(id);
    if (!m) continue;
    const steps = r.verb === "uninstall" ? [`restart ${m.display_name}`] : (m.install?.next || []);
    for (const s of steps) if (!next.includes(s)) next.push(s);
    // `plan` previews an install: after an uninstall it would preview the
    // opposite of what just ran.
    if (r.verb === "uninstall") continue;
    const preview = packageCommand(m, "plan", { args: `--project ${here ? '"$PWD"' : `"${p.projectDir}"`}` });
    if (!tips.some((t) => t.includes(preview))) tips.push(`preview without writing: ${preview}`);
  }
  if (!verbose) tips.push("every row's reasoning: add --verbose");
  for (const s of next) lines.push(`  ${paint("cyan", "next")}  ${s}`);
  for (const t of tips.slice(0, 2)) lines.push(`  ${paint("gray", "tip")}   ${paint("gray", t)}`);
  return lines.join("\n") + "\n";
}

// ─── main ──────────────────────────────────────────────────────────────

function usage() {
  return [
    "usage: install-harness.mjs <install|uninstall|upgrade|plan> [--harness <id>]... [--surface <key>]... [--project <dir>] [--global] [--no-register] [--verbose] [--json]",
    `  harnesses: ${harnessIds().join(", ")}`,
    "  --surface narrows the plan to a surface and the surfaces beneath it (statusline covers statusline_launcher)",
    "  --harness names the harness — and, without a terminal, is the confirmation (a terminal is asked); there is no --yes",
  ].join("\n");
}

// The JSON envelope carries states and actions, never file bodies: a model
// reading a status report must not receive the whole of CLAUDE.md twice.
// Per step kind, because one field name means different things in different
// steps. A layout step's `from`/`to`/`files` ARE its preview, and a
// registration `write` carries `files` as a count beside its `manifest` body.
// Only `portable-write` carries bodies under other names (`catalog`,
// `ownership`), its payload root (`from`) and its file list. Stripping every
// name from every step took the layout migration's `from` out of
// `plan --json` (S1 of the 2026-10-03 review in "The Codex shell's plugin root:
// .codex-plugin, the rendered surfaces, and the first Codex install").
const PRIVATE_STEP_FIELDS = { "portable-write": ["catalog", "ownership", "from"] };
function publicStep({ manifest, ...s }) {
  for (const k of PRIVATE_STEP_FIELDS[s.kind] || []) delete s[k];
  if (s.kind === "portable-write" && Array.isArray(s.files)) s.files = s.files.length;
  return s;
}
export const publicItem = ({ before, after, steps, observed, ...rest }) => steps
  ? { ...rest, steps: steps.map(publicStep) }
  : rest;

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!["install", "uninstall", "upgrade", "plan"].includes(verb)) { process.stderr.write(usage() + "\n"); process.exit(2); }
  const harnesses = [], surfaces = [];
  let projectDir = null, json = false, globalRemoval = false, register = true, verbose = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) { process.stderr.write(`${a} needs a value\n${usage()}\n`); process.exit(2); } return v; };
    if (a === "--harness") harnesses.push(value());
    else if (a === "--surface") surfaces.push(value());
    else if (a === "--project") projectDir = value();
    else if (a === "--global") globalRemoval = true;
    else if (a === "--no-register" && verb !== "uninstall") register = false;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else { process.stderr.write(`unknown argument ${a}\n${usage()}\n`); process.exit(2); }
  }
  const src = sourceHarness();
  projectDir = resolve(projectDir || (src && process.env[src.runtime?.project_dir_env]) || process.cwd());
  const opts = { harnesses, surfaces: surfaces.length ? surfaces : null, globalRemoval, register, json, verbose, stdin: process.stdin, stdout: process.stdout };
  if (verb === "plan") {
    const p = plan(projectDir, opts);
    const c = termCaps(process.stdout, process.env);
    process.stdout.write(json ? JSON.stringify({ ...p, items: p.items.map(publicItem) }, null, 2) + "\n" : renderPreview(p, { verbose, verb, paint: painter(c), icon: (n) => termIcon(c, n), width: c.live ? c.width : 0 }));
    process.exit(p.ok && !p.incomplete ? 0 : 1);
  }
  const r = await runVerb(verb, projectDir, json ? opts : { ...opts, out: process.stdout });
  if (json) {
    process.stdout.write(JSON.stringify({ verb, ok: r.plan.ok && !r.plan.incomplete && !r.failed, gate: r.gate, applied: r.applied, failed: r.failed, incomplete: r.plan.incomplete, items: r.plan.items.map(publicItem), refusals: r.plan.refusals, reports: r.plan.reports }, null, 2) + "\n");
  } else if (r.gate.why === "non-tty") {
    process.stdout.write(`Nothing written: without a terminal, a bare ${verb} refuses. Name the harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`);
  } else if (r.gate.why === "declined") {
    process.stdout.write("Nothing written.\n");
  }
  process.exit(r.plan.ok && !r.plan.incomplete && !r.failed && (r.gate.confirmed || r.gate.why === "nothing-to-do") ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

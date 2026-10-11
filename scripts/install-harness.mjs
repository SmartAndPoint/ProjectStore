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
// without the config flag. One change is never confirmed by a name: a channel
// switch planned with no channel answer (the converge story's rule 2) is asked
// at a terminal and, without one, answered `channel` — nothing is written.
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
// A SHELL-ROOTED harness (its registration conditioned on a distribution root:
// Codex) has its plugin root only in its distribution shell. install and
// upgrade fetch that shell at this root's own version before plan(), once per
// run (fetch-shell.mjs), and hand plan() the fetched root per harness id; plan
// and uninstall never fetch, and decide that registration from the host's
// facts and the version alone. plan() stays synchronous and pure either way;
// runVerb removes the run's scratch after apply() in a `finally`.
//
// Before that fetch, install and upgrade decide about the copies of ours this
// project already runs (convergence.mjs; the story "Setup and upgrade converge
// this project onto the running version…", rules 6 and 8): a copy newer than
// this root is never downgraded — the run stops and names the update when
// the registry's latest reaches it, and proceeds, saying why, when it does not
// — and a package root run in text says when a newer release is published.
// The registry is read there, at most once; plan() is handed the decision.
// Under the channel "git" (the keep, its rule 5) the kept copy's own plan is
// read there too, through its bin; plan() is handed it, and plans that
// harness as one host-style step that runs the copy's own upgrade.
//
// Setup's items (the story "projectstore setup asks, shows one plan and
// installs every harness it finds, with the vault", rule 10), planned only
// from plan()'s setup inputs, so install, upgrade and plan keep their plans:
// the `vault` item, first and under no harness (PLAN's VAULT group), applied
// through binding.mjs's applyBind; a `state` item per harness, the empty
// .projectstore/state/<id>/ that detection reads; and `binding` items — the
// status-line flag, the keep's record and the mark — each a set of keys
// merged into the binding at apply time, after the layout item.
//
// Direction: installer → surfaces ← doctor; installer → provenance ← doctor.
// Doctor never imports this file.
//
// Normative: the spec "Installing, refreshing and disowning a harness
// surface", contracts 0, 5–10, 13–15. The plan/apply split, the refusal
// without a detected harness and the four-state model are Ivan Morozov's
// (MultiProjectStore); the host-managed report shape is Maxim
// Podreshetnikov's (PR #13, installElsewhere). Pure node, no external deps.

import {
  mkdirSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname, relative, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  caps as termCaps,
  painter,
  icon as termIcon,
  duration,
  stepReporter,
  liveLine,
  wrap,
  askApply,
  plain,
  badge as badgeText,
  heading,
  rowLines,
  kv,
  commandBlock,
  PLAIN,
} from "./term.mjs";
import {
  loadHarness,
  loadHarnesses,
  harnessIds,
  sourceHarness,
  detectHarnesses,
  harnessRefusal,
  packageCommand,
  insideHostSession,
  registrationDeferred,
  bundlingShellHarnessId,
  cachePaths,
  commonBlockFiles,
  agentsBlockRow,
  configPath,
  childEnv,
} from "./harness.mjs";
import { FOREIGN_TEXT, GRAMMAR_VERSION } from "./provenance.mjs";
import {
  analyseBlock,
  analyseJsonEntry,
  analyseStampedFile,
  analyseRegistration,
  analysePortableRegistration,
  analyseLayout,
  analyseHarnessState,
  isOurFile,
  readText,
  registrationRenderRoot,
  registrationPaths,
} from "./surfaces.mjs";
import { payloadFiles, renderPortableCatalog } from "./portable-registration.mjs";
import {
  rootVersion,
  rootName,
  fetchDecision,
  fetchArgv,
  npmRegistry,
  npmUserRegistry,
  REGISTRY_BUDGET_MS,
  fetchShell,
  fetchRefusal,
  fetchRunId,
  sweepFetchRuns,
} from "./fetch-shell.mjs";
import { HOST_BUDGET_MS, startFailure, runHost } from "./run-host.mjs";
import {
  runningCopies,
  newerCopies,
  lowestVersion,
  readLatest,
  decide,
  proceedCase,
  newerCopyDeferral,
  repairAdvice,
  advised,
  updateNotice,
  checksRoot,
  noticeRoot,
  updateCheckOff,
  channelChoices,
  switchConsequence,
  switchReason,
  noCopyToKeep,
  keepArgv,
  keepResult,
  readKeepPlan,
  ownUpgrade,
  npmRowBeside,
  pinFor,
  coreCommand,
  DEFAULT_REGISTRY,
  NOTICE_BUDGET_MS,
  READ_TIMEOUT_MS,
} from "./convergence.mjs";
import { applyBind, bindPlanSteps, recheckBind, bindResult } from "./binding.mjs";
import {
  pluginRoot,
  channelMark,
  channelKeep,
  CHANNEL_SWITCH_KEY,
  CHANNEL_KEEP_KEY,
  writeFileAtomic,
  writeExclusiveMetadata,
  ensureStateDir,
  ensureStateRoot,
  ensureRuntimeDir,
  removeAgentsBlock,
  replaceAgentsBlock,
  readConfigAt,
  isPluginCacheRoot,
  isEphemeralRoot,
  statusLineIsOurWiring,
  claudeHome,
  packageDigest,
  writeOwnTree,
  removeOwnTree,
  cmpPrecedence,
  importsLine,
  whichOnPath as whichOnPathFromLib,
  moveStateDir,
  mergeEntryLog,
  movePath,
  removeInside,
  statusLineScriptPath,
  layoutPaths,
  stagePortableMarketplace,
  finishPortableMarketplace,
  rollbackPortableMarketplace,
  removeTreeUnder,
  projectDirRefusal,
  registrationProvenance,
  envFlag,
  selectCopy,
  copyUpdateAdvice,
  takesVerbose,
} from "./lib.mjs";

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
  mjs: planStampedFile,
  "host-plugin-registration": planRegistration,
  "portable-plugin-registration": planPortableRegistration,
};

// The order plan() visits kinds in (contract 4′, two phases): the registration
// decides the root the rest is planned against; a shared entry (the status
// line slot) decides whether the exclusive launcher is written at all.
const KIND_ORDER = { registration: 0, shared: 1, exclusive: 2 };

// Planned once per RUN by plan(), never once per harness (the story "One run
// plans the agents block once, and a bare uninstall selects every harness the
// project uses", rule 1). `s` carries the run's common file list as `files`;
// `ctx.run` is every harness of the run that has a block, `ctx.harness` the
// first of them, `ctx.readers` set when the run names more than one, and
// `ctx.layout` the roster's layout name (rule 3).
function planAgentsBlock(ctx, key, s) {
  const { projectDir, mode, root } = ctx;
  const run = ctx.run || [ctx.harness];
  const a = analyseBlock(projectDir, s, { root, layout: ctx.layout || null, readers: ctx.readers || null });
  const { withBlock, preferred, importLine, FALLBACK } = a;
  const items = [];
  if (a.refusal)
    return [
      {
        surface: key,
        kind: "shared",
        path: a.files[0].path,
        entry: "projectstore:agents",
        state: "refused",
        action: "refuse",
        reason: a.refusal,
      },
    ];

  const hasImport = (text) => importsLine(text, importLine);
  // A CLAUDE.md that is nothing but the import registration added is ours to
  // delete when the block goes (ADR-002 decision 4); anything else stays.
  const onlyImport = (text) =>
    String(text ?? "")
      .split("\n")
      .every((l) => !l.trim() || l.trim() === importLine);
  // A file the removal leaves empty is deleted when it held only the block
  // (rule 4) — and the fallback file, as before. Keyed on the fallback alone,
  // a run's common list (whose last entry is AGENTS.md) and Claude Code alone
  // both left a 0-byte AGENTS.md (measured 2026-10-08).
  const removal = (e, extra = {}) => {
    const after = removeAgentsBlock(e.text);
    return {
      surface: key,
      kind: "shared",
      path: e.path,
      entry: `projectstore:agents v${e.block.v}`,
      state: "ours-current",
      action: "remove",
      reason: null,
      before: e.text,
      after,
      deleteIfEmpty: e.file === FALLBACK || !after.trim(),
      ...extra,
    };
  };

  if (mode === "uninstall") {
    if (!withBlock.length)
      return [
        {
          surface: key,
          kind: "shared",
          path: preferred.path,
          entry: "projectstore:agents",
          state: "ours-absent",
          action: "skip",
          reason: "no block to remove",
        },
      ];
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
    //
    // "Another" means a manifest OUTSIDE this run (rule 4): a run that names
    // every harness reading the file is the last one, and removes the block
    // once. Excluding only the planning harness kept the block for a harness
    // that was in the same run.
    const inRun = new Set(run.map((m) => m?.id));
    const outside = [...loadHarnesses().values()].filter((m) => !inRun.has(m.id));
    const alsoRead = (file) => outside.some((m) => (agentsBlockRow(m)?.[1].files || []).includes(file));
    for (const e of withBlock) {
      // Naming the surface removes it regardless: `--surface agents_block`
      // is the confirmation without a terminal, and a terminal is asked
      // (contract 9 as amended 2026-10-04).
      if (!(ctx.surfaces || []).includes(key) && alsoRead(e.file)) {
        items.push({
          surface: key,
          kind: "shared",
          path: e.path,
          entry: `projectstore:agents v${e.block.v}`,
          state: "ours-current",
          action: "skip",
          reason: `${e.file} is read by another harness too — a per-harness uninstall leaves the project's block alone. Remove it with --surface ${key}`,
        });
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
    const vanishing = new Set(
      items
        .filter((i) => i.action === "remove" && i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim())
        .map((i) => rel(projectDir, i.path)),
    );
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
    //
    // Except a BRIDGE (rule 4: a narrowed uninstall "leaves the block and the
    // import in place"): the import in the file a harness outside this run
    // reads by itself, pointing at a block this run keeps for that harness.
    // It is the only way that harness sees the block; taking it out because it
    // is ours kept the block and blinded its reader. The source harness's
    // own uninstall still removes its own file's import, as before.
    const blockGone = new Set(
      items.filter((i) => i.action === "remove" && i.surface === key).map((i) => rel(projectDir, i.path)),
    );
    const blockKept = new Set(
      items.filter((i) => i.action === "skip" && i.surface === key).map((i) => rel(projectDir, i.path)),
    );
    const outsideNatives = new Set(outside.map((m) => agentsBlockRow(m)?.[1].reads_natively).filter(Boolean));
    const union = [...new Set([...loadHarnesses().values()].flatMap((m) => m.surfaces?.agents_block?.files || []))];
    for (const file of union) {
      if (blockGone.has(file)) continue;
      const e = readText(join(projectDir, file));
      if (!e.present || e.text === null || !hasImport(e.text)) continue;
      const ours = onlyImport(e.text);
      const dangles = vanishing.has(importLine.slice(1));
      const bridge = blockKept.has(importLine.slice(1)) && outsideNatives.has(file);
      if ((!ours && !dangles) || bridge) continue;
      const after = e.text
        .split("\n")
        .filter((l) => l.trim() !== importLine)
        .join("\n")
        .replace(/^\n+/, "");
      items.push({
        surface: `${key}_import`,
        kind: "shared",
        path: join(projectDir, file),
        entry: importLine,
        state: "ours-current",
        action: "remove",
        reason: ours
          ? `${file} holds only the import registration added`
          : `${importLine} points at a file this uninstall removes`,
        before: e.text,
        after,
        deleteIfEmpty: ours,
      });
    }
    return items;
  }

  const entry = `projectstore:agents v${a.version}`;
  const current = a.current;
  // Two files, one block each: resolve in favour of the preferred file —
  // register migrates, never duplicates (ADR-002 decision 3).
  for (const e of a.duplicates || [])
    items.push(removal(e, { state: "ours-stale", reason: `duplicate of the block in ${current.file}` }));

  if (!current) {
    const target = preferred;
    items.push({
      surface: key,
      kind: "shared",
      path: target.path,
      entry,
      state: "ours-absent",
      action: target.present ? "add" : "create",
      reason: null,
      before: target.present ? target.text : null,
      after: replaceAgentsBlock(target.present ? target.text : "", a.desired),
    });
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
    // A run of several harnesses says which of them cannot read the file the
    // block leaves (rule 1); one harness keeps its text, byte for byte.
    items.push(removal(current, { state: "ours-stale", reason: `migrating to ${preferred.file}` }));
    items.push({
      surface: key,
      kind: "shared",
      path: preferred.path,
      entry,
      state: "ours-absent",
      action: preferred.present ? "add" : "create",
      reason: ctx.readers && !current.own ? a.reason : `migrated from ${current.file}`,
      before: preferred.present ? preferred.text : null,
      after: replaceAgentsBlock(preferred.present ? preferred.text : "", a.desired),
    });
  } else if (current.block.v === a.version && current.block.block === a.desired) {
    items.push({
      surface: key,
      kind: "shared",
      path: current.path,
      entry,
      state: "ours-current",
      action: "skip",
      reason: null,
    });
  } else {
    items.push({
      surface: key,
      kind: "shared",
      path: current.path,
      entry,
      state: "ours-stale",
      action: "replace-entry",
      reason:
        current.block.v !== a.version
          ? `v${current.block.v} → v${a.version}`
          : "content differs from the current source",
      before: current.text,
      after: replaceAgentsBlock(current.text, a.desired),
    });
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
  // a harness name — and it is every RUN harness's (rule 1): one run for two
  // harnesses leaves both native files present, each holding the block or the
  // import.
  const natives = new Set(run.map((m) => agentsBlockRow(m)?.[1].reads_natively).filter(Boolean));
  // The import item sits under the run's first harness, which need not be the
  // one that reads the file: in a run of several, the reason names the reader.
  // One harness is its own reader and keeps its text, byte for byte.
  const reader = (file) =>
    (ctx.readers && run.find((m) => agentsBlockRow(m)?.[1].reads_natively === file)?.display_name) || "this harness";
  for (const e of a.files) {
    const mustExist = natives.has(e.file);
    if (!blockFile || e.file === blockFile || (!e.present && !mustExist)) continue;
    const line = `@${blockFile}`;
    const rewrite = items.find((i) => i.action === "remove" && i.path === e.path);
    // An absent native file is empty text, not a reason to skip: it is created.
    const text = rewrite ? rewrite.after : e.present ? e.text : "";
    if (typeof text !== "string" || importsLine(text, line)) continue;
    const after = line + "\n" + (text.startsWith("\n") || !text.trim() ? "" : "\n") + text;
    if (rewrite) {
      rewrite.after = after;
      rewrite.deleteIfEmpty = false;
      rewrite.reason += `; ${line} import added`;
    } else
      items.push({
        surface: `${key}_import`,
        kind: "shared",
        path: e.path,
        entry: line,
        state: "ours-absent",
        action: e.present ? "add" : "create",
        reason: e.present
          ? `${blockFile} carries the block; ${e.file} must import it`
          : `${e.file} is what ${reader(e.file)} reads by itself; it is created to import ${blockFile}`,
        before: e.present ? text : null,
        after,
      });
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
  if (!Array.isArray(template) || !template.length)
    throw new Error(`${s.format}: host operation ${name} is not declared`);
  const argv = template.map((t) => t.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? `{${k}}`));
  const p = a.paths;
  const touches =
    {
      validate: [],
      marketplace_add: [p.marketplaces, p.globalConfig, p.projectSettings],
      marketplace_update: [p.marketplaces],
      marketplace_remove: [p.marketplaces, p.globalConfig, p.projectSettings],
      install: [p.installed, p.globalConfig, p.projectSettings, p.cacheDir],
      update: [p.installed, p.cacheDir],
      uninstall: [p.installed, p.globalConfig, p.projectSettings],
      disable: [p.projectSettings],
      enable: [p.projectSettings],
    }[name] || [];
  return { kind: "host", name, bin: s.cli.bin, argv, why, touches: touches.filter(Boolean) };
}

function portableListFacts(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch {
    return null;
  }
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

// A shell-rooted registration, in the order its rows are decided (the story
// "Install and upgrade fetch a shell-rooted harness at the bin's own version,
// once per run; plan and uninstall never fetch", rules 6–8):
//   1. a project uninstall never touches the global registration;
//   2. no payload and no version (a direct plan() caller), or a shell whose
//      named root is not a plugin root: today's deferred rows, unchanged;
//   3. a run from the harness's own shell's core: deferred, it does not fetch;
//   4. foreign or conflicting: refused;
//   5. unavailable (the host CLI missing, nothing of ours): deferred;
//   6. global removal, from the host's facts — it stages nothing, so it needs
//      no payload;
//   7. install and upgrade: from the fetched or named payload, or, with only
//      the version, the dry run — every host fact decided, the payload's
//      digest compared once a fetch brings it, and a write row's steps led by
//      the fetch it would run.
// The analysis inputs are recorded privately on the row: apply()'s recheck
// and its read-back re-analyse with exactly those, never with the root's
// version or the variable as it stands by then.
function planPortableRegistration(ctx, key, s) {
  const { projectDir, mode, root, home, env, harness, globalRemoval, version = null, fetched = null } = ctx;
  const a = analysePortableRegistration(projectDir, s, { root, home, harness, env, version, fetched });
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
    analysed: { payloadRoot: a.payloadRoot || null, version: a.versionOnly ? version : null },
  };
  if (mode === "uninstall" && !globalRemoval) {
    return [
      {
        ...base,
        action: "skip",
        reason:
          "the plugin package and cache are global; project uninstall removes only project-owned surfaces. Use uninstall --global with an explicit harness to preview global removal",
      },
    ];
  }
  // No payload and no version: a direct plan() caller, which keeps today's
  // deferral. A shell that named a root which is not a plugin root is broken,
  // and says so through `incomplete`, as before — except for a removal,
  // which needs no payload at all.
  const namedRoot = env.PROJECTSTORE_DISTRIBUTION_ROOT || null;
  if (!a.payloadRoot && (!a.versionOnly || (namedRoot && mode !== "uninstall"))) {
    if (namedRoot) ctx.incomplete = true;
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        reason: namedRoot
          ? `${namedRoot} is not a portable plugin root; ${harness.display_name}'s registration runs only from its built distribution shell`
          : `the core package is not ${harness.display_name}'s plugin root; registration runs only from its built distribution shell`,
      },
    ];
  }
  // Rule 8: the core a shell bundles — the doctor skill's copy in the host's
  // plugin cache, an npx copy or a global install of the shell, recognised by
  // the shell's package name and never by a path — keeps today's deferral. A
  // fetch there would change the host's home from inside a session (the
  // front-door ADR's first open question; such a session is marked only by
  // registration_defer_env, which defers the registration below, and only
  // when the host's exec tool sets it), and needs the network inside its
  // sandbox. Only this harness's own shell counts.
  if (!a.payloadRoot && bundlingShellHarnessId({ core: root }) === harness.id) {
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        reason: "this run is from the plugin's own copy, which does not fetch",
      },
    ];
  }
  if (["foreign", "conflict"].includes(a.state)) return [{ ...base, action: "refuse", reason: a.refusal }];
  if (a.state === "unavailable") {
    ctx.incomplete = true;
    return [{ ...base, action: "skip", deferred: true }];
  }
  if (mode === "uninstall") {
    if (a.state === "absent") return [{ ...base, action: "skip", reason: "no global registration of ours" }];
    if (!a.bin) {
      ctx.incomplete = true;
      return [
        { ...base, action: "skip", reason: `\`${s.cli.bin}\` is not on PATH; global registration is left untouched` },
      ];
    }
    // The removal runs the same host CLI against the same home as an install,
    // so it defers where an install would (the setup story, rule 15), with
    // the host's checks above decided first, as the host plugin
    // registration's removal decides them.
    if (registrationDeferred(env, harness)) {
      ctx.incomplete = true;
      return [{ ...base, action: "skip", deferred: true, reason: deferralReason(harness, env) }];
    }
    const steps = [];
    if (a.installed) steps.push(hostStep(a, s, "uninstall", fill, `explicit global removal forgets ${a.id}`));
    if (a.market && s.cli.commands.marketplace_remove)
      steps.push(
        hostStep(a, s, "marketplace_remove", fill, `explicit global removal forgets marketplace ${s.marketplace_name}`),
      );
    if (a.ownership)
      steps.push({
        kind: "portable-remove",
        path: a.paths.dir,
        homeBase: a.paths.home,
        why: "the stable marketplace source is owned by this installer",
      });
    return [{ ...base, action: "remove", steps, reason: "explicit global removal; project overrides are preserved" }];
  }
  // A registration newer than this run (the converge story's rule 6): the
  // rows name both versions and, when the run proceeds, which case it was —
  // the registry's latest below it, no answer, the check switched off, or for
  // plan's dry run that install and upgrade read the registry first.
  const newerCase = a.newer ? proceedCase(ctx.convergence, a.ownership.version) : null;
  // An unchanged row carries no note by default (presentation spec contract
  // 7); that its payload digest waits for a fetch is said under --verbose.
  if (a.state === "current")
    return [
      {
        ...base,
        action: "skip",
        reason: newerCase ? `${a.reason}; ${newerCase}` : a.reason,
        ...(a.versionOnly ? { digestDeferred: true } : {}),
      },
    ];
  // A newer registration that is damaged keeps its real reason and is never
  // staged over with this run's older payload: it is repaired from its own
  // version. Nothing of the host's runs, so the run is incomplete.
  if (a.newer) {
    ctx.incomplete = true;
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        ...advised(`${a.reason}${newerCase ? `; ${newerCase}` : ""}`, [repairAdvice(harness, a.ownership.version)]),
      },
    ];
  }
  if (!a.bin) {
    ctx.incomplete = true;
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        reason: `\`${s.cli.bin}\` is not on PATH; no registration mutation was attempted`,
      },
    ];
  }
  // Decision 2 of the front-door ADR: the registration defers in the planned
  // harness's own session, as the host-plugin registration does — by its
  // session marker, or by its runtime.registration_defer_env (Codex's
  // session_env is empty by design; the setup story, rule 15).
  if (registrationDeferred(env, harness)) {
    ctx.incomplete = true;
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        reason: `${a.reason ? a.reason + "; " : ""}${deferralReason(harness, env)}`,
      },
    ];
  }
  const steps = [];
  const digest = a.desiredDigest;
  const mustWrite = !a.ownership || a.ownership.version !== a.desiredVersion || a.contentDiffers || a.state === "stale";
  if (mustWrite) {
    // Version-only, the payload is counted after the fetch: no listing, no root.
    const files = a.versionOnly ? null : payloadFiles(a.payloadRoot);
    const ownership = {
      [s.provenance_key]: { grammar: GRAMMAR_VERSION, version: a.desiredVersion, generator: GENERATOR, digest },
    };
    steps.push({
      kind: "portable-write",
      path: a.paths.dir,
      from: a.payloadRoot || null,
      files,
      subdir: s.plugin_subdir,
      catalogRel: s.manifest,
      catalog: renderPortableCatalog(s),
      ownershipRel: s.ownership_manifest,
      ownership,
      why: a.ownership ? `stage ${a.desiredVersion} over ${a.ownership.version}` : `stage ${a.desiredVersion}`,
    });
  }
  if (!a.market)
    steps.push(hostStep(a, s, "marketplace_add", fill, "register the stable local marketplace source globally"));
  if (!a.installed || a.installedVersion !== a.desiredVersion || mustWrite)
    steps.push(hostStep(a, s, "install", fill, `materialise and enable ${a.id} from the staged source`));
  steps.push(hostStep(a, s, "list", fill, "read back host-reported installation and effective enablement"));
  // Asked first, before anything changes: the command the registration's own
  // verification needs. A host too old to answer it stops the run with nothing
  // staged, journaled or registered (issue #28: a codex without `plugin list
  // --json` failed only at verification, after it had added the marketplace
  // and the plugin; the install spec's 2026-09-29 amendment, as amended
  // 2026-10-05).
  if (steps.some((x) => x.kind === "portable-write" || (x.kind === "host" && x.name !== "list"))) {
    steps.unshift({
      ...hostStep(a, s, "list", fill, "check that the host can report what it installs, before anything changes"),
      name: "preflight",
    });
  }
  // The dry run's first step is the fetch install or upgrade would run (rule
  // 6), spelled by the run's own argv builder. plan spawns nothing, so the
  // run id and the registry are literal placeholders, and the cache path is
  // resolved but never made.
  if (a.versionOnly && harness.install?.shell) {
    const prefix = cachePaths({ env, home }).fetchRun("<run-id>") || "<cache>/fetch/<run-id>";
    steps.unshift({
      kind: "fetch",
      bin: "npm",
      argv: fetchArgv({ prefix, registry: "<registry>", shell: harness.install.shell, version }),
      why: `install and upgrade fetch ${harness.install.shell} at this version first; its payload is counted and its digest compared after the fetch`,
    });
  }
  return [
    {
      ...base,
      action: a.state === "absent" ? "create" : "update",
      steps,
      verify: { version: a.desiredVersion, digest },
      reason: a.reason,
    },
  ];
}

// The marketplace manifest we write: the host's catalogue shape (measured), plus
// our provenance field — contract 2 for a JSON file that is wholly ours — with
// the payload digest the state ladder checks (contract 4′).
export function registrationManifest(s, { pkg, projectDir, disabled = [], digest = null }) {
  return {
    name: s.marketplace_name,
    description:
      "projectstore, installed from the npm package on this machine (written by projectstore install; do not edit)",
    owner: { name: "SmartAndPoint", email: "ekonev@smartandpoint.com" },
    plugins: [
      {
        name: s.plugin_name,
        description: "Agent-first project memory: a vault-native workflow for ADRs, specs, epics and stories.",
        version: pkg,
        source: `./${s.plugin_subdir}`,
      },
    ],
    [s.provenance_key]: { grammar: GRAMMAR_VERSION, pkg, project: projectDir, generator: GENERATOR, disabled, digest },
  };
}

// Inside a live session of the host, its CLI and the session both rewrite the
// same settings files on their own schedules; the registration is planned
// only from a terminal outside one (insideHostSession, harness.mjs).
const inSessionReason = (harness) =>
  `this runs inside a ${harness.display_name} session, whose exit rewrites the same settings files the host's CLI writes — run it from a terminal outside the session`;

// Why a registration defers (registrationDeferred, harness.mjs). The session's
// own marker keeps the measured reason above, byte for byte. A
// registration_defer_env variable alone names itself instead: what such a
// session does to the host's configuration is not measured, only that the
// session is there (the setup story, rule 15).
function deferralReason(harness, env) {
  if (insideHostSession(env, harness)) return inSessionReason(harness);
  const variable = (harness?.runtime?.registration_defer_env || []).find((k) => env && env[k]);
  return `this runs inside a ${harness.display_name} session (${variable} is set), and the host's CLI would change the configuration that session runs on — run it from a terminal outside the session`;
}

function planRegistration(ctx, key, s) {
  const { projectDir, mode, root, home, env, harness } = ctx;
  const a = analyseRegistration(projectDir, s, { root, home, harness, env });
  const id = a.id;
  const bin = a.bin;
  const binName = s.cli?.bin || "claude";
  const base = {
    surface: key,
    kind: "registration",
    path: a.paths.dir,
    entry: id,
    state: a.state,
    reason: a.reason,
    root: a.installPath || a.predictedInstallPath,
    home: claudeHome(home),
    scope: s.scope || null,
    writtenBy: a.writtenBy,
  };
  const fill = { dir: a.paths.dir, marketplace: s.marketplace_name, id, other: id };
  const notOnPath = `\`${binName}\` is not on PATH — the registration is left as it is; put the host's CLI on PATH and run install again`;
  const named = (ctx.surfaces || []).includes(key);
  // The registration defers by the planned harness's session marker or its
  // registration_defer_env (registrationDeferred; the setup story, rule 15).
  const deferred = registrationDeferred(env, harness);
  const inSession = deferred ? deferralReason(harness, env) : null;
  const other = (o) => ({
    surface: `${key}_others`,
    kind: "registration",
    path: a.paths.projectSettings,
    entry: o.key,
    state: "enabled",
    home: base.home,
    scope: base.scope,
  });

  if (mode === "uninstall") {
    if (a.state === "unavailable" || a.state === "absent")
      return [{ ...base, action: "skip", reason: a.state === "absent" ? a.reason : a.reason }];
    if (a.state === "foreign") return [{ ...base, action: "refuse", reason: a.refusal }];
    if (!bin) {
      ctx.incomplete = true;
      return [{ ...base, action: "skip", reason: notOnPath }];
    }
    if (deferred) {
      ctx.incomplete = true;
      return [{ ...base, action: "skip", reason: inSession }];
    }
    const steps = [];
    if (a.installed)
      steps.push(
        hostStep(
          a,
          s,
          "uninstall",
          fill,
          `the host forgets ${id} for this checkout (its row and enablement; other checkouts keep theirs)`,
        ),
      );
    const last = a.otherProjects === 0;
    // The host's `marketplace remove` drops EVERY checkout's rows for the
    // marketplace (measured), so it runs only from the last checkout — and
    // before anything else touches the declaration it requires. Otherwise our
    // one entry in the checkout's local settings is removed by hand (contract 6).
    if (last && a.known && a.registeredHere)
      steps.push(
        hostStep(
          a,
          s,
          "marketplace_remove",
          fill,
          `no other checkout uses marketplace ${s.marketplace_name}; the host forgets it and this checkout's declaration of it`,
        ),
      );
    else if (a.registeredHere)
      steps.push({
        kind: "unregister",
        path: a.paths.projectSettings,
        pointer: s.registry?.known_pointer || "extraKnownMarketplaces",
        name: s.marketplace_name,
        why: `this checkout stops declaring the marketplace — our entry only; \`${binName} plugin marketplace remove\` would drop every checkout's rows (measured), so it runs only from the last checkout`,
      });
    // Re-enable only what THIS checkout holds disabled: the record in the shared
    // manifest says what install silenced somewhere; a copy the user disabled by
    // hand in another checkout is not ours to turn on (reviewer, 2026-09-05).
    for (const o of a.dir.disabled.filter((k) => a.disabledHere.includes(k)))
      steps.push(
        hostStep(
          a,
          s,
          "enable",
          { ...fill, other: o },
          `${o} was silenced for this checkout by install; it is turned back on`,
        ),
      );
    // The mark goes with the registration (the converge story's rule 4): the
    // binding stops recording that this checkout chose the npm install. After
    // the host's steps, so a failed one leaves the record as it was.
    if (ctx.binding?.hasKey)
      steps.push({
        kind: "unmark",
        path: ctx.binding.path,
        key: CHANNEL_SWITCH_KEY,
        why: "the switch goes with the registration: this checkout's binding stops recording that it chose the npm install",
      });
    if (last && a.dir.present)
      steps.push({
        kind: "remove",
        path: a.paths.dir,
        why: "our marketplace directory, removed whole (its manifest carries our provenance field); no other checkout is installed from it",
      });
    return [
      {
        ...base,
        action: "remove",
        steps,
        reason: a.otherProjects
          ? `${a.otherProjects} other checkout(s) are installed from the shared directory; it and the host's marketplace entry stay`
          : a.reason,
      },
    ];
  }

  // install / upgrade
  if (!a.produced) {
    // A cache install never registers a second copy of itself (condition npm_package_root).
    if (a.state === "absent" || a.state === "unavailable")
      return named
        ? [
            {
              ...base,
              action: "skip",
              deferred: true,
              reason: `this root is the host's own install of the plugin; it does not register a second copy of itself — the npm package does, from a terminal: ${packageCommand(harness, "install", { args: `--project "${projectDir}"` })}`,
            },
          ]
        : [];
    if (a.state === "current") return [{ ...base, action: "skip" }];
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        reason: `${a.reason} — this root is the host's own install; refresh the registration from the package, outside a session: ${packageCommand(harness, "upgrade", { version: "<version>", args: `--surface ${key} --project "${projectDir}"` })}`,
      },
    ];
  }
  if (a.state === "unavailable") {
    ctx.incomplete = true;
    return [{ ...base, action: "skip", deferred: true, reason: a.reason }];
  }
  if (a.state === "foreign") return [{ ...base, action: "refuse", reason: a.refusal }];
  const items = [];
  const needsHost = a.state !== "current" || a.others.length > 0;
  if (needsHost && !bin) {
    ctx.incomplete = true;
    return [{ ...base, action: "skip", deferred: true, reason: `${a.reason ? a.reason + "; " : ""}${notOnPath}` }];
  }
  if (needsHost && deferred) {
    ctx.incomplete = true;
    return [{ ...base, action: "skip", deferred: true, reason: `${a.reason ? a.reason + "; " : ""}${inSession}` }];
  }
  // Our directory newer than this package and damaged (the converge story's
  // rule 6): never rewritten from the older package — this checkout and every
  // other would then update down to it. It is repaired from its own version;
  // nothing of the host's runs, and the run is incomplete.
  if (a.newer && a.dir.digestOk === false) {
    ctx.incomplete = true;
    const newerCase = proceedCase(ctx.convergence, a.dir.pkg);
    return [
      {
        ...base,
        action: "skip",
        deferred: true,
        ...advised(
          `the directory holds ${a.dir.pkg}, newer than this package (${a.pkg}), and its payload does not match its digest (edited by hand or half-written)${newerCase ? `; ${newerCase}` : ""}`,
          [repairAdvice(harness, a.dir.pkg)],
        ),
      },
    ];
  }
  // A copy from another marketplace newer than this package (rule 6), under
  // no channel answer: switching it off would run the project on an older
  // package, and the git channel serves main, often ahead of latest. The
  // registration and every switch defer; no host command runs. The reason and
  // its ways out print once, under the registration; each switch row points
  // there.
  // Newer than what the project would run with the copy off — the shared
  // directory's version when another checkout wrote a newer one — not merely
  // newer than this package: under that, turning it off is no downgrade.
  const newerOther = a.others
    .filter((o) => typeof o.version === "string" && cmpPrecedence(o.version, a.targetPkg || a.pkg) > 0)
    .sort((x, y) => cmpPrecedence(y.version, x.version))[0];
  if (newerOther && (ctx.channel ?? null) === null) {
    ctx.incomplete = true;
    const deferral = newerCopyDeferral({
      copy: newerOther,
      running: a.pkg,
      decision: ctx.convergence,
      harness,
      pin: pinFor(root, a.pkg),
    });
    return [
      { ...base, action: "skip", deferred: true, ...deferral },
      ...a.others.map((o) => ({
        ...other(o),
        action: "skip",
        deferred: true,
        reason: `not switched off — see ${id} above`,
      })),
    ];
  }
  // What the mark (rule 2) is planned from, after the harness's rows: the
  // switches this run plans, and contract 13's silenced set — the copies this
  // registration turned off that this checkout still holds off — for a
  // registration this checkout holds.
  ctx.channelFacts = {
    switches: a.others.map((o) => o.key),
    silenced: ["current", "stale"].includes(a.state) ? a.dir.disabled.filter((k) => a.disabledHere.includes(k)) : [],
  };

  if (a.state === "current") {
    // A directory and row newer than this package: rung 12, not downgraded,
    // and — when the run proceeds — which case it was (rule 6).
    const newerCase = a.newer ? proceedCase(ctx.convergence, a.dir.pkg) : null;
    items.push({ ...base, action: "skip", ...(newerCase ? { reason: `${a.reason}; ${newerCase}` } : {}) });
  } else {
    const steps = [];
    // The directory is rewritten when it is missing, older than this package or
    // damaged — never when a newer package wrote it (contract 12: reported, not
    // downgraded); then this checkout registers against what stands.
    // …or holds a different payload at the SAME version — the maintainer's
    // pack → install → fix → pack loop never bumps it. The host will not
    // re-copy at an equal version (measured), so that refresh is uninstall + install.
    const sameVersionDiffers = a.contentDiffers === true;
    const rewrite =
      !a.dir.present || cmpPrecedence(a.dir.pkg, a.pkg) < 0 || a.dir.digestOk === false || sameVersionDiffers;
    const disabled = [...new Set([...a.dir.disabled, ...a.others.map((o) => o.key)])];
    const digest = rewrite ? packageDigest(root) : a.dir.prov?.digest || null;
    const files = digest ? digest.count : 0;
    if (rewrite)
      steps.push({
        kind: "write",
        path: a.paths.dir,
        files,
        manifest: registrationManifest(s, { pkg: a.pkg, projectDir, disabled, digest }),
        why: a.dir.present
          ? `the directory is rewritten from this package (${a.dir.pkg} → ${a.pkg}${a.dir.digestOk === false ? ", the payload did not match its digest" : sameVersionDiffers ? ", same version, different content" : ""})`
          : `the marketplace directory is written from this package's ${files} shipped files, staged and renamed into place`,
      });
    else if (a.newer)
      steps.push({
        kind: "note",
        why: `the directory holds ${a.dir.pkg}${a.writtenBy ? ` (written from ${a.writtenBy})` : ""}, newer than this package (${a.pkg}); this checkout registers ${a.dir.pkg} — not downgraded`,
      });
    else if (a.others.some((o) => !a.dir.disabled.includes(o.key)))
      steps.push({
        kind: "write",
        path: a.paths.dir,
        files: 0,
        manifestOnly: true,
        manifest: { ...a.dir.manifest, [s.provenance_key]: { ...a.dir.prov, disabled } },
        why: "our manifest records what install silences, so uninstall can turn it back on",
      });
    steps.push(
      hostStep(
        a,
        s,
        "validate",
        fill,
        "the host checks the marketplace before it is registered (it warns about our provenance field and exits 0 — measured)",
      ),
    );
    if (!a.known)
      steps.push(
        hostStep(
          a,
          s,
          "marketplace_add",
          fill,
          "the host learns our marketplace, declared in this checkout's local settings",
        ),
      );
    else if (!a.registeredHere)
      steps.push(
        hostStep(
          a,
          s,
          "marketplace_add",
          fill,
          "the host already knows our marketplace; this checkout declares it (measured: a re-add is idempotent)",
        ),
      );
    if (!a.installed || !a.installed.present)
      steps.push(
        hostStep(
          a,
          s,
          "install",
          fill,
          `the host copies the plugin into its cache and enables it for this checkout (-y accepts a marketplace-declared command; ours declares none)`,
        ),
      );
    else if (sameVersionDiffers && a.installedVersion === a.targetPkg) {
      steps.push(
        hostStep(
          a,
          s,
          "uninstall",
          fill,
          `the host forgets this checkout's row: at an unchanged version \`update\` copies nothing (measured), so the refresh is uninstall + install`,
        ),
      );
      steps.push(
        hostStep(
          a,
          s,
          "install",
          fill,
          `the host copies the rewritten ${a.targetPkg} into its cache and enables it for this checkout again`,
        ),
      );
    } else if (a.installedVersion !== a.targetPkg)
      steps.push(
        hostStep(
          a,
          s,
          "update",
          fill,
          `the host swaps this checkout's cached copy for ${a.targetPkg} (measured: --scope names the row; no uninstall)`,
        ),
      );
    if (a.installed && a.installed.present && !a.enabled)
      steps.push(hostStep(a, s, "enable", fill, "it is disabled for this checkout; install turns it on"));
    items.push({
      ...base,
      action: a.state === "absent" ? "create" : "update",
      steps,
      root: a.predictedInstallPath,
      verify: { installPath: a.predictedInstallPath, version: a.targetPkg },
    });
  }
  // A competing enabled registration of the same plugin is silenced for THIS
  // checkout only, as a precaution the preview names (whether two enabled copies
  // load twice is the live test's row). Our manifest records it for uninstall.
  //
  // That is the channel switch (the converge story's rule 2): its row says
  // what it means, as the consequence line — a `note` step after the host
  // step, so the JSON item keeps its keys, drawn first beneath the row
  // (presentation spec contract 7). Under no channel answer it is asked, never
  // silent: without a terminal the gate answers `channel` (confirm()). Under
  // the channel "npm" the row also names a newer copy's versions and case
  // (rule 6), and that an unbound project's switch is recorded once it is
  // bound — words only that channel adds, so the null row keeps its shape.
  for (const o of a.others) {
    const steps = [];
    if (a.state === "current" && !a.dir.disabled.includes(o.key))
      steps.push({
        kind: "write",
        path: a.paths.dir,
        files: 0,
        manifestOnly: true,
        manifest: { ...a.dir.manifest, [s.provenance_key]: { ...a.dir.prov, disabled: [...a.dir.disabled, o.key] } },
        why: "our manifest records what install silences, so uninstall can turn it back on",
      });
    steps.push(
      hostStep(
        a,
        s,
        "disable",
        { ...fill, other: o.key },
        `${o.key} (${o.version}) is enabled for this checkout too; two enabled copies of one plugin would load twice — silenced in this checkout's local settings only, never globally`,
      ),
    );
    steps.push(consequenceStep(switchConsequence()));
    const reason =
      ctx.channel === "npm"
        ? switchReason({
            copy: o,
            running: a.pkg,
            runs: a.targetPkg,
            decision: ctx.convergence,
            unbound: !ctx.binding?.bound,
          })
        : null;
    items.push({ ...other(o), action: "disable", ...(reason ? { reason } : {}), steps });
  }
  return items;
}

// A row's consequence (presentation spec contract 7) carried as a `note` step:
// the envelope reads `{ kind: "note", why }`, as any note; PLAN draws it first
// beneath its row, in the explanation role, by the mark kept off the envelope.
function consequenceStep(why) {
  const st = { kind: "note", why };
  Object.defineProperty(st, "consequence", { value: true, enumerable: false });
  return st;
}
const isConsequence = (st) => st?.kind === "note" && st.consequence === true;
// A channel switch: a copy from another marketplace turned off for this checkout.
const isSwitch = (i) => String(i?.surface || "").endsWith("_others") && i.action === "disable";

// The channel "git" (the converge story's rules 1 and 5), for the first
// harness of the run with a host plugin registration — the channel concerns
// that registration alone; Codex has none. The copy kept is contract 12's
// selection (lib's selectCopy), limited to copies from another marketplace —
// the git marketplace, a fork's — so the npm registration's copy is never the
// kept one. None enabled for this project is a refusal: there is nothing to
// keep. A copy of ours this checkout's local settings hold off — a hand
// removal of the npm row leaves the git copy off — is named with the way to
// turn it back on. Read-only; plan() and the prepare step both call it, so the
// refusal is decided before any shell fetch.
//   → null: no harness of the run has a host plugin registration
//   → { harness, key, s, copy: null, refusal }: nothing to keep
//   → { harness, key, s, copy }: the copy, with selectCopy's capability read
function keepTarget(projectDir, ids, { root, home, env }) {
  for (const id of ids) {
    const harness = loadHarness(id);
    const row = Object.entries(harness?.surfaces || {}).find(
      ([k, s]) => !k.startsWith("_") && s?.format === "host-plugin-registration",
    );
    if (!row) continue;
    const [key, s] = row;
    const copy = selectCopy(home, projectDir, { harness, only: "marketplace" });
    if (copy) return { harness, key, s, copy };
    const a = analyseRegistration(projectDir, s, { root, home, harness, env });
    const off = (a.disabledHere || []).filter((k) => k !== a.id && k.split("@")[0] === s.plugin_name);
    return { harness, key, s, copy: null, refusal: noCopyToKeep({ harness, surface: key, off }) };
  }
  return null;
}

// The environment the kept copy's bin runs in, for its plan's read and for
// the keep step: the run's own, through childEnv for who called, then the
// KEPT harness's own runtime names from its manifest — never the caller's
// active harness's, which from a Codex terminal would name Codex's: the
// copy's root as its plugin root, so the child renders from itself; the
// project; and its home pinned, as every host command's is, so the child reads
// the home this run read and never another. Every other manifest's plugin-root
// variable is dropped: the child is that one harness's copy.
function keepEnv(env, { harness, projectDir, copyRoot, harnessHome }) {
  const out = childEnv(env);
  for (const m of loadHarnesses().values()) if (m.runtime?.plugin_root_env) delete out[m.runtime.plugin_root_env];
  const r = harness.runtime || {};
  if (r.plugin_root_env) out[r.plugin_root_env] = copyRoot;
  if (r.project_dir_env) out[r.project_dir_env] = projectDir;
  if (r.home_env) out[r.home_env] = harnessHome;
  return out;
}

// The surface key the keep's one item carries (kind `channel`).
const KEEP_SURFACE = "channel";

// The keep (the converge story's rule 5): this project goes on loading the
// git-marketplace copy, and that copy renders its own surfaces here. One item
// of kind `channel` under the harness, in place of every row of its own —
// registration, competing copies, status line, launcher, host-managed report.
// Its one step is host-style: the copy's bin in the layout remedy's form
// (keepArgv), its touches the writes the copy's own plan listed (`read`, made
// by the prepare step) less the agents block's rows, which this run's one
// block item writes before it (the story "One run plans the agents block
// once…", rule 1). No write left: no item. The other rows it can be:
// - a copy that cannot run the form (lib's capability read): skip, with the
//   update in its channel — in the row's reason, since DONE never prints when
//   nothing else writes, and as DONE's next line;
// - a plan that printed no result: skip, naming the copy's own upgrade, which
//   the person runs with its own preview — never run unpreviewed;
// - a plan that refused: a refuse row, and each refusal on the plan's, led by
//   the copy's key and version;
// - inside the harness's own session: skip, deferred, as the registration is;
// - a copy plan that left work for later and lists no write (its layout move,
//   deferred inside a session): skip, deferred, naming what it deferred — the
//   run never reads as converged while the copy has work pending;
// - a run narrowed by `--surface`: skip — the copy's upgrade takes no
//   --surface (naming the status line would opt it in), so a narrowed run
//   leaves this harness's surfaces to it.
// This checkout's npm row enabled beside the copy stays, and is named with its
// uninstall (rule 4), in the row and in DONE.
function planKeep(ctx, target, read) {
  const { projectDir, env, home, root, harness, surfaces } = ctx;
  const { key, s, copy } = target;
  const a = analyseRegistration(projectDir, s, { root, home, harness, env });
  const beside = a.installed?.present && a.enabled ? npmRowBeside({ harness, id: a.id, surface: key }) : null;
  const besides = beside ? [beside] : [];
  const named = `${copy.key} ${copy.version || "(no version recorded)"}`;
  // Built whole, never spread into place: `next` (what DONE says) and `kept`
  // (DONE's fact and its tip: the copy, and whether its CLI takes --verbose)
  // stay off the envelope as properties that are not enumerable.
  const item = (fields, next = []) => {
    const it = {
      harness: harness.id,
      surface: KEEP_SURFACE,
      kind: "channel",
      path: copy.path,
      entry: copy.key,
      state: "kept",
      home: claudeHome(home),
      scope: copy.scope || null,
      ...fields,
    };
    const all = [...next, ...besides];
    if (all.length) Object.defineProperty(it, "next", { value: all, enumerable: false });
    Object.defineProperty(it, "kept", {
      value: {
        key: copy.key,
        version: copy.version || null,
        bin: copy.missing ? null : copy.bin,
        verbose: !copy.missing && takesVerbose(copy.path),
      },
      enumerable: false,
    });
    return it;
  };
  const kept = `this project keeps ${named} from the git marketplace, and that copy writes its own ${harness.display_name} surfaces here — no registration changes`;
  if (surfaces && surfaces.length) {
    return [
      item({
        action: "skip",
        ...advised(
          `${kept}; ${named}'s own upgrade takes no --surface, so a run narrowed by --surface leaves these surfaces to it — run without --surface to converge them`,
          besides,
        ),
      }),
    ];
  }
  if (copy.missing) {
    ctx.incomplete = true;
    const advice = copyUpdateAdvice(copy, {
      cannot:
        copy.missing === "bin"
          ? "predates the move and cannot write this project's surfaces itself"
          : "predates --no-register and cannot write this project's surfaces without registering",
      then: "then run this again",
    });
    return [item({ action: "skip", deferred: true, ...advised(advice, besides) }, [{ lead: advice }])];
  }
  if (!read) {
    ctx.incomplete = true;
    return [
      item({
        action: "skip",
        deferred: true,
        ...advised(`${kept}; install and upgrade read that copy's own plan first, and this plan did not`, besides),
      }),
    ];
  }
  if (!read.envelope) {
    ctx.incomplete = true;
    const how =
      read.error ||
      (read.status !== null && read.status !== undefined ? `it exited ${read.status}` : "it printed nothing");
    const said = read.stderr ? `: ${read.stderr.split("\n")[0]}` : "";
    const own = ownUpgrade(copy, harness);
    return [
      item(
        {
          action: "skip",
          deferred: true,
          ...advised(`${named}'s own plan printed no result to read (${how}${said}), so nothing is planned for it.`, [
            own,
            ...besides,
          ]),
        },
        [own],
      ),
    ];
  }
  if (!read.ok) {
    const quoted = read.refusals.length ? read.refusals : ["its plan refused and named no reason"];
    ctx.refusals.push(...quoted.map((r) => `${named}: ${r}`));
    return [
      item({
        state: "refused",
        action: "refuse",
        reason: `the kept copy's own plan refused, so nothing is written: ${quoted.join("; ")}`,
        advice: { text: `${named}'s own plan refused (below), so nothing is written`, blocks: [] },
      }),
    ];
  }
  const block = agentsBlockRow(harness);
  const blockRows = block ? [block[0], `${block[0]}_import`] : [];
  const writes = read.writes.filter((w) => !blockRows.includes(w.surface));
  if (!writes.length && read.incomplete) {
    ctx.incomplete = true;
    const why = (read.deferred || [])
      .filter((d) => !blockRows.includes(d.surface))
      .map((d) => (d.reason ? `${d.surface}: ${d.reason}` : d.surface));
    return [
      item({
        action: "skip",
        deferred: true,
        ...advised(
          `${named}'s own plan left work for later${why.length ? ` — ${why.join("; ")}` : ", and names none of it"}`,
          besides,
        ),
      }),
    ];
  }
  if (!writes.length)
    return beside ? [item({ action: "skip", ...advised(`${named} has nothing to change here`, besides) })] : [];
  if (insideHostSession(env, harness)) {
    ctx.incomplete = true;
    return [item({ action: "skip", deferred: true, ...advised(`${kept}; ${inSessionReason(harness)}`, besides) })];
  }
  const step = {
    kind: "host",
    name: "keep",
    argv: keepArgv(copy, { verb: "upgrade", harness, projectDir }),
    why: `the kept copy's own upgrade, from its own bin without registering (the layout remedy's form), read back as JSON; it re-plans from the files as they stand then, after the agents block above`,
    touches: writes,
  };
  return [item({ action: "update", ...advised(kept, besides), steps: [step] })];
}

// The mark (the converge story's rule 2), for the channel "npm" only: one
// item of kind `binding`, last in its harness's group, adding `channel_switch:
// { by: "setup", at: <the time of apply> }` to the binding and keeping every
// other key. Planned when this run switches a copy off, bound or not; or, to
// adopt an earlier switch, when the registration this checkout holds already
// keeps a copy off and a binding exists to record it in. Never over a mark
// already there: a re-run after a switch is zero-change. The file is the one
// configPath resolves at apply time, after the layout item moved it; the
// preview names the new path when the plan moves the binding.
//
// The latest answer wins (the setup story, rule 6): `channel_switch` and
// `channel_keep` never both stay after a run. A keep this checkout recorded
// earlier goes in the same item as the mark — removed whatever its shape —
// and, with the mark already there, alone: an item of kind `binding` that
// only removes it, for the harness whose registration the switch reads.
const KEEP_GOES =
  "the keep this checkout recorded earlier goes: the switch is its later answer, and setup's channel question defaults to switch again";
function planMark(ctx, facts) {
  const b = ctx.binding;
  if (!b || !facts) return null;
  if (b.hasMark) {
    if (!b.hasKeep) return null;
    return bindingItem({
      harness: ctx.harness.id,
      surface: CHANNEL_KEEP_KEY,
      entry: CHANNEL_KEEP_KEY,
      path: b.path,
      bound: b.bound,
      action: "update",
      state: "present",
      reason: "the switch is already recorded, and this run answers switch again: the keep recorded beside it goes",
      unset: [CHANNEL_KEEP_KEY],
      why: { [CHANNEL_KEEP_KEY]: KEEP_GOES },
      said: {
        unbound: "the project is not bound; nothing is removed",
        done: "the keep is already gone",
        object: "the keep is not removed",
      },
    });
  }
  const switching = facts.switches.length > 0;
  const adopting = !switching && facts.silenced.length > 0 && b.bound;
  if (!switching && !adopting) return null;
  const reason = !b.bound
    ? "the project is not bound yet: the switch is recorded only if a binding exists by the time of apply"
    : adopting
      ? `this checkout already holds ${facts.silenced.join(", ")} off for the npm registration; the switch is recorded`
      : null;
  return bindingItem({
    harness: ctx.harness.id,
    surface: CHANNEL_SWITCH_KEY,
    entry: CHANNEL_SWITCH_KEY,
    path: b.path,
    bound: b.bound,
    reason,
    set: { [CHANNEL_SWITCH_KEY]: STAMP },
    unset: b.hasKeep ? [CHANNEL_KEEP_KEY] : [],
    why: {
      [CHANNEL_SWITCH_KEY]:
        "this checkout chose the npm install; doctor stops naming the copy it turned off, and the registration's uninstall removes the record with it",
      [CHANNEL_KEEP_KEY]: KEEP_GOES,
    },
    said: {
      unbound: "the project is not bound; the switch is recorded once it is",
      done: "the switch is already recorded",
      object: "the switch is not recorded",
    },
  });
}

// The keep's record (the setup story, rule 6): a keep answered at setup's
// channel question — or `--channel git` — adds `channel_keep: { by: "setup",
// at: <the time of apply> }`, so the question defaults to keep from then on
// and a run without a terminal reads it as `--channel git`. Planned under
// plan()'s `recordKeep` input, for the harness the copy is kept for, last in
// its group; only when a binding exists or the plan's vault item writes one,
// and never over a keep already recorded — one read as lib's channelKeep
// reads it, so a `channel_keep` of another shape is stamped over. The latest
// answer wins, as for the mark: a `channel_switch` this checkout recorded
// earlier, of any shape, goes in the same item — alone, when the keep is
// already recorded.
function planKeepRecord(ctx) {
  const b = ctx.binding;
  if (!b || !b.bound) return null;
  const record = !b.hasKeepRecord;
  if (!record && !b.hasKey) return null;
  return bindingItem({
    harness: ctx.harness.id,
    surface: CHANNEL_KEEP_KEY,
    entry: CHANNEL_KEEP_KEY,
    path: b.path,
    bound: true,
    ...(record
      ? {}
      : {
          action: "update",
          state: "present",
          reason: "the keep is already recorded, and this run answers keep again: the switch recorded beside it goes",
        }),
    set: record ? { [CHANNEL_KEEP_KEY]: STAMP } : {},
    unset: b.hasKey ? [CHANNEL_SWITCH_KEY] : [],
    why: {
      [CHANNEL_KEEP_KEY]:
        "this checkout chose to keep the git marketplace: setup's channel question defaults to keep from now on, and a run without a terminal reads it as --channel git",
      [CHANNEL_SWITCH_KEY]:
        "the switch this checkout recorded earlier goes: the keep is its later answer, and doctor names a copy held off here again",
    },
    said: {
      unbound: "the project is not bound; the keep is recorded once it is",
      done: "the keep is already recorded",
      object: "the keep is not recorded",
    },
  });
}

// The status line's flag (the setup story, rule 9): setup's answer stored as
// `statusline.enabled`, the key bind's interview writes; every other key of
// a `statusline` object is kept. Planned for the run's harness that has the
// status-line surface, when the binding the run leaves does not already say
// the same; only when there is a binding to record it in.
const STATUSLINE_FLAG = "statusline.enabled";
function planStatuslineFlag(ctx, value) {
  const b = ctx.binding;
  if (!b || !b.bound || typeof value !== "boolean" || b.statusline === value) return null;
  return bindingItem({
    harness: ctx.harness.id,
    surface: "statusline_flag",
    entry: STATUSLINE_FLAG,
    path: b.path,
    bound: true,
    set: { [STATUSLINE_FLAG]: value },
    why: {
      [STATUSLINE_FLAG]: value
        ? "the status line is wired in this run, and the SessionStart hook keeps it current"
        : "the status line stays off, and setup does not ask again",
    },
    said: {
      unbound: "the project is not bound; the status line's flag is recorded once it is",
      done: "the status line's flag is already recorded",
      object: "the status line's flag is not recorded",
    },
  });
}

// Setup's vault item (the story's rule 10; the front-door ADR's decision 7):
// one item of kind `vault`, first in the plan and under no harness — PLAN's
// VAULT group. Its steps are the binding plan's own (binding.mjs
// bindPlanSteps): the mkdir, the binding, `git init`, the scaffold. `create`
// for a vault this run makes (missing, or there and empty); `add` for a
// binding of one that exists, scaffolded or not, and for a worktree's
// inherited binding. The binding plan rides along off the envelope, for
// apply; with nothing to write there is no item.
function planVault(bp) {
  const steps = bindPlanSteps(bp);
  if (!steps.length) return null;
  const reason = bp.inherit
    ? `the vault of ${bp.inherit.from}, with its settings`
    : bp.buildsVault || !bp.vaultExists
      ? null
      : bp.scaffoldsExisting
        ? "it already exists; it is bound as it is, and the layout's missing folders and indexes are added"
        : "it already exists; it is bound as it is";
  const item = {
    harness: null,
    surface: "vault",
    kind: "vault",
    path: bp.vault,
    entry: null,
    state: !bp.vaultExists ? "absent" : bp.buildsVault ? "empty" : "present",
    action: bp.buildsVault ? "create" : "add",
    reason,
    steps,
  };
  Object.defineProperty(item, "bind", { value: bp, enumerable: false });
  return item;
}

// Setup's state directory (the story's rule 10): an empty
// .projectstore/state/<id>/, the signal detection reads (detectHarnesses'
// `state`), so a harness setup installed with no directory of its own is used
// here before its first session. Never the welcome marker: that file means
// the welcome was shown, and the first session writes it into this
// directory. The first such item names state/ and its .gitignore when they
// are still to be made.
function planStateDir(projectDir, harness, { first = false } = {}) {
  const P = layoutPaths(projectDir);
  const path = P.harnessState(harness.id);
  if (existsSync(path)) return null;
  const steps =
    first && !existsSync(P.stateGitignore)
      ? [
          {
            kind: "ensure",
            path: P.state,
            why: "state/ with its .gitignore, which keeps everything under it out of git",
          },
        ]
      : [];
  return {
    harness: harness.id,
    surface: "harness_state",
    kind: "state",
    path,
    entry: null,
    state: "absent",
    action: "create",
    reason: null,
    ...(steps.length ? { steps } : {}),
  };
}

// A key a `binding` item stamps at apply: `{ by: "setup", at: <the time of
// apply> }`, the mark's shape and the keep's.
const STAMP = Object.freeze({ stamp: "setup" });
const stamped = (v) =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof v.by === "string" && typeof v.at === "string";

// A `binding` item (the converge story's kind, made generic by the setup
// story's rule 10): keys merged into the binding at apply time, after the
// layout item, every other key kept. `set` maps a key — dotted for a nested
// one — to its value, or to STAMP; `unset` lists the keys it removes. Both
// are apply's data, kept off the envelope, as `said` is: the item's own
// words for a binding that is not there, not an object, or already says it.
// The steps are what PLAN shows and the envelope carries, in that order:
// `mark` for a stamped key, `set` for a value, `unmark` for a removal. An
// item that only removes a key is an `update` of a binding whose key is
// `present`.
function bindingItem({
  harness,
  surface,
  entry,
  path,
  bound,
  reason = null,
  set = {},
  unset = [],
  why = {},
  said = {},
  action = "add",
  state = "absent",
}) {
  const step = (fields, key) => (why[key] ? { ...fields, why: why[key] } : fields);
  const steps = [
    ...Object.entries(set).map(([key, value]) =>
      step(value === STAMP ? { kind: "mark", path, key } : { kind: "set", path, key, value }, key),
    ),
    ...unset.map((key) => step({ kind: "unmark", path, key }, key)),
  ];
  const item = {
    harness,
    surface,
    kind: "binding",
    path,
    entry,
    state: bound ? state : "unbound",
    action,
    reason,
    steps,
  };
  for (const [k, v] of Object.entries({ set, unset, said }))
    Object.defineProperty(item, k, { value: v, enumerable: false });
  return item;
}

function planJsonEntry(ctx, key, s) {
  const { projectDir, mode, root, home } = ctx;
  if (s.supported === false) {
    return [
      {
        surface: key,
        kind: "shared",
        path: join(projectDir, s.file),
        entry: s.marker?.pointer || null,
        state: "unsupported",
        action: "skip",
        reason: s.why_unsupported || "not supported for this harness yet",
      },
    ];
  }
  const path = join(projectDir, s.file);
  const entryKey = (s.marker?.pointer || "statusLine.command").split(".")[0];
  // The status line is opt-in (projectstore.json → statusline.enabled), as
  // the SessionStart refresh already honours; naming the surface explicitly
  // is the other way to opt in. A verb with no --surface (setup, its rule 9)
  // names install's command, which takes it, in the core form.
  if (mode === "install" && !ctx.optIn.has(key)) {
    const anyway =
      ctx.takesSurface === false
        ? `to wire it anyway: ${coreCommand("install", { args: `--harness ${ctx.harness.id} --surface ${key}` })}`
        : "name --surface statusline to wire it anyway";
    return [
      {
        surface: key,
        kind: "shared",
        path,
        entry: entryKey,
        state: "opt-out",
        action: "skip",
        reason: `statusline.enabled is not true in projectstore.json — ${anyway}`,
      },
    ];
  }
  const renderRoot = ctx.renderRoot || root;
  // A root the package manager will collect (npx's cache, a node_modules) is
  // never wired directly: the entry would name a path that disappears. It is
  // wired against a registration's install path — or not at all (contract 4′).
  if (mode === "install" && !isPluginCacheRoot(renderRoot, home) && isEphemeralRoot(renderRoot)) {
    return [
      {
        surface: key,
        kind: "shared",
        path,
        entry: entryKey,
        state: "absent-or-present",
        action: "skip",
        reason:
          "this package root is a package-manager cache; the status line is wired only against a registered install (see the registration above)",
      },
    ];
  }
  const a = analyseJsonEntry(projectDir, s, { root, home, renderRoot });
  if (a.state === "unparseable")
    return [
      { surface: key, kind: "shared", path, entry: entryKey, state: "unparseable", action: "refuse", reason: a.reason },
    ];

  if (mode === "uninstall") {
    if (!a.curEntry)
      return [
        { surface: key, kind: "shared", path, entry: entryKey, state: "ours-absent", action: "skip", reason: null },
      ];
    if (!a.ours)
      return [
        {
          surface: key,
          kind: "shared",
          path,
          entry: entryKey,
          state: "theirs",
          action: "skip",
          reason: "the entry is not ours — left in place",
        },
      ];
    const after = { ...a.settings };
    delete after[entryKey];
    return [
      {
        surface: key,
        kind: "shared",
        path,
        entry: entryKey,
        state: "ours-current",
        action: "remove",
        reason: null,
        before: a.settings,
        after,
      },
    ];
  }
  if (a.state === "theirs") {
    ctx.slotForeign.add(key);
    return [
      {
        surface: key,
        kind: "shared",
        path,
        entry: entryKey,
        state: "theirs",
        action: "skip",
        reason: "a status line we did not write owns the slot — left to its owner, and nothing else is wired for it",
      },
    ];
  }
  if (a.state === "ours-current")
    return [
      { surface: key, kind: "shared", path, entry: entryKey, state: "ours-current", action: "skip", reason: null },
    ];
  const after = {
    ...a.settings,
    [entryKey]: {
      ...(a.curEntry && typeof a.curEntry === "object" ? a.curEntry : {}),
      type: "command",
      command: a.desired,
    },
  };
  return [
    {
      surface: key,
      kind: "shared",
      path,
      entry: entryKey,
      state: a.state,
      action: a.curEntry ? "replace-entry" : a.cur.present ? "add" : "create",
      reason: a.curEntry ? a.reason : null,
      before: a.cur.present ? a.settings : null,
      after,
    },
  ];
}

function planStampedFile(ctx, key, s) {
  const { projectDir, mode, root, home, harness } = ctx;
  const renderRoot = ctx.renderRoot || root;
  const path = join(projectDir, s.file);
  const produced = !(s.condition === "plugin_cache_install" && !isPluginCacheRoot(renderRoot, home));
  // The policy early-outs come before the render-and-hash, which they make
  // unnecessary.
  if (produced && mode === "install" && !ctx.optIn.has(s.condition ? "statusline" : key) && !ctx.optIn.has(key)) {
    return [
      {
        surface: key,
        kind: "exclusive",
        path,
        entry: null,
        state: "opt-out",
        action: "skip",
        reason: "statusline.enabled is not true in projectstore.json",
      },
    ];
  }
  if (produced && mode === "install" && ctx.slotForeign.size) {
    return [
      {
        surface: key,
        kind: "exclusive",
        path,
        entry: null,
        state: "absent-or-present",
        action: "skip",
        reason: "the status line slot is foreign; a launcher nothing points at is not written",
      },
    ];
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
    if (!a.ours)
      return [
        {
          surface: key,
          kind: "exclusive",
          path: at,
          entry: null,
          state: "foreign",
          action: "skip",
          reason: "not produced for a dev checkout, and not ours — left in place",
        },
      ];
    return [
      {
        surface: key,
        kind: "exclusive",
        path: at,
        entry: null,
        state: "stale",
        action: mode === "uninstall" ? "remove" : "skip",
        reason: a.reason,
      },
    ];
  }
  if (a.refusal)
    return [{ surface: key, kind: "exclusive", path: at, state: "refused", action: "refuse", reason: a.refusal }];
  const base = {
    surface: key,
    kind: "exclusive",
    path: at,
    entry: null,
    state: a.state,
    reason: a.reason,
    writtenBy: a.writtenBy,
    sameProject: a.sameProject,
  };
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
  if (a.state === "current" && !a.legacyPath && a.writtenBy && !a.sameProject)
    return [
      {
        ...base,
        path,
        action: "update",
        reason: `current, written for ${a.writtenBy} — re-rendered for this project`,
        after: a.stamped.text,
      },
    ];
  if (a.state === "current" && !a.legacyPath) return [{ ...base, action: "skip" }];
  // Written at the NEW path; a legacy file's state is why (stale, or current-but-moving).
  return [
    {
      ...base,
      path,
      action: a.state === "absent" || a.legacyPath ? "create" : "update",
      reason: a.legacyPath
        ? `${a.reason ? a.reason + "; " : ""}moving from ${rel(projectDir, a.legacyPath)} (the layout ADR)`
        : a.reason,
      after: a.stamped.text,
      legacyPath: a.legacyPath,
    },
  ];
}

// ─── plan ──────────────────────────────────────────────────────────────

// The surface rows a run leaves out: a --surface that does not name the key
// (by prefix, so `statusline` covers the launcher), or --no-register's
// registration. One predicate for plan() and the shell fetch's decision.
function surfaceExcluded(key, s, { surfaces = null, register = true } = {}) {
  return (
    Boolean(surfaces && !surfaces.some((x) => key === x || key.startsWith(x + "_"))) ||
    (register === false && s.kind === "registration")
  );
}

// `state` selects by the state directory too (upgrade's set, the shell-fetch
// story's rule 5); `version` is the running root's, for a shell-rooted
// registration planned without its payload; `payloadRoots` holds a fetched
// root per harness id — never PROJECTSTORE_DISTRIBUTION_ROOT, which names one
// root for every harness and is inherited by every child the run spawns.
// `layout` is a layout NAME: the agents block's roster is rendered from it,
// the layout the run leaves; null keeps the binding's (the story "One run
// plans the agents block once…", rule 3). `convergence` is the prepare step's
// decision about the copies this project runs (convergence.mjs, the converge
// story's rule 6): a stop is rendered as the plan's refusal, and the proceed
// cases as the newer rows' words. plan() reads no registry and decides
// nothing about it; without a decision (plan's dry run) a newer row says
// that install and upgrade read the registry first — from a root that checks
// at all. `fetchedFrom` names the project's registry a shell was fetched
// from, when it is not the user's ({ registry, user, harnesses }).
// `channel` is the answer to setup's channel question (the converge story's
// rule 1): "npm" switches a copy from another marketplace off and records the
// switch in the binding; "git" keeps it; null — what install and upgrade pass
// — plans the switch as before, and the gate asks it at a terminal and refuses
// it without one. `keep` is the prepare step's read of the kept copy's own
// plan under the channel "git" ({ copy, read }, rule 5); without it the keep's
// row says that copy's plan was not read.
//
// Setup's inputs (the story "projectstore setup asks…", rules 6, 9, 10 and
// 12), plain data; install, upgrade and plan pass none, so their plans keep
// their items and keys:
//   vault       a binding plan as setup decided it (binding.mjs planBind,
//               with `init` or `scaffoldExisting`, or planInherit): the
//               `vault` item, first; its refusals refuse the plan
//   statusline  setup's status-line answer, true or false: a `binding` item
//               storing it, and true opts the status line in, as the flag
//               on disk would; null asks nothing of the binding
//   named       whether the harnesses were named — the gate's confirmation —
//               when that is not what `harnesses` says: a bare setup plans
//               its pre-ticked set and is still not named
//   ensureState a `state` item per harness whose registration is not
//               unavailable and whose state directory is absent
//   recordKeep  under the channel "git", the keep's `binding` item
//   takesSurface false for a verb that takes no --surface (setup, its rule
//               9): a skipped opt-in names install's command instead
export function plan(
  projectDir,
  {
    harnesses = [],
    mode = "install",
    env = process.env,
    home = homedir(),
    root = pluginRoot(),
    surfaces = null,
    globalRemoval = false,
    register = true,
    state = false,
    version = null,
    payloadRoots = null,
    layout = null,
    convergence = null,
    fetchedFrom = null,
    channel = null,
    keep = null,
    vault = null,
    statusline = null,
    named: namedOverride = null,
    ensureState = false,
    recordKeep = false,
    takesSurface = true,
  } = {},
) {
  projectDir = resolve(projectDir);
  const detected = detectHarnesses(projectDir, { state });
  const named = harnesses.filter(Boolean);
  const ids = named.length ? named : detected.map((d) => d.id);
  const out = {
    projectDir,
    mode,
    named: typeof namedOverride === "boolean" ? namedOverride : named.length > 0,
    detected,
    harnesses: [],
    reports: [],
    items: [],
    refusals: [],
    ok: true,
    incomplete: false,
    root,
    plannedAgainst: {},
  };
  // Not enumerable, like hostManaged: plan --json keeps the shape it had.
  Object.defineProperty(out, "version", { value: version, enumerable: false });
  Object.defineProperty(out, "payloadRoots", { value: { ...(payloadRoots || {}) }, enumerable: false });
  Object.defineProperty(out, "convergence", { value: convergence, enumerable: false });
  Object.defineProperty(out, "fetchedFrom", { value: fetchedFrom, enumerable: false });
  // The channel answer, for the gate (confirm()): a switch planned under null
  // is asked at a terminal and refused without one.
  Object.defineProperty(out, "channel", { value: channel, enumerable: false });
  const unknown = named.filter((id) => !harnessIds().includes(id));
  if (unknown.length) {
    out.refusals.push(`unknown harness: ${unknown.join(", ")} — known: ${harnessIds().join(", ")}`);
    out.ok = false;
    return out;
  }
  if (![null, "npm", "git"].includes(channel)) {
    out.refusals.push(`unknown channel: ${channel} — known: npm, git`);
    out.ok = false;
    return out;
  }
  // A project that does not exist is refused before contract 8's detection
  // could stand in for it ("no harness detected"), and before anything is
  // written, staged, locked or spawned (contract 19).
  const missing = projectDirRefusal(projectDir);
  if (missing) {
    out.harnesses = named;
    out.refusals.push(missing);
    out.ok = false;
    return out;
  }
  if (!ids.length) {
    out.refusals.push(harnessRefusal(projectDir, { state }));
    out.ok = false;
    return out;
  }
  // The stop (rule 6), decided in the prepare step: this project runs a newer
  // copy and the registry's latest reaches it. Nothing is planned; the
  // refusal carries the whole text, and its two commands — each printed on a
  // line of its own (presentation spec contract 6) — are kept off the
  // envelope, as hostManaged is.
  if (convergence?.stop) {
    out.harnesses = ids;
    out.refusals.push(convergence.stop.text);
    out.ok = false;
    Object.defineProperty(out, "stop", {
      value: {
        lead: convergence.stop.lead,
        commands: [...convergence.stop.commands],
        between: convergence.stop.between,
      },
      enumerable: false,
    });
    return out;
  }
  // The channel "git" (rule 1): with no copy from another marketplace enabled
  // for this project there is nothing to keep, and nothing is planned. The
  // refusal carries the whole text; its commands, each printed on a line of
  // its own, are kept off the envelope, as the stop's are. Otherwise the
  // harness the copy is kept for is planned by the keep alone (rule 5).
  const keeping = channel === "git" && mode !== "uninstall" ? keepTarget(projectDir, ids, { root, home, env }) : null;
  if (keeping && !keeping.copy) {
    out.harnesses = ids;
    out.refusals.push(keeping.refusal.reason);
    out.ok = false;
    if (keeping.refusal.advice)
      Object.defineProperty(out, "refusalAdvice", { value: keeping.refusal.advice, enumerable: false });
    return out;
  }
  // The prepare step's read, when it read the copy this plan keeps.
  const keepRead = keeping && keep?.copy?.path === keeping.copy.path ? (keep.read ?? null) : null;
  // What the newer rows say: the prepare step's decision; for a dry run, the
  // note that install and upgrade read first — only from a root that checks.
  const decision = convergence ?? (mode === "install" && !checksRoot(root, { home, env }) ? { checks: false } : null);
  // Setup's vault (rule 10): a binding plan that refuses refuses this plan,
  // with nothing planned — setup decides it before plan() and stops on it, so
  // this is the guard for a caller that did not. One for another project is
  // a refusal too — compared realpath'd, so two spellings of one directory
  // (macOS's /var and /private/var) are the same project.
  if (vault && mode !== "uninstall") {
    const real = (x) => {
      try {
        return realpathSync(resolve(x));
      } catch {
        return resolve(x);
      }
    };
    const why = !vault.ok
      ? (vault.refusals || []).map((r) => r.message)
      : real(vault.projectDir) !== real(projectDir)
        ? [`the vault plan is for ${vault.projectDir}, not ${projectDir}`]
        : [];
    if (why.length) {
      out.harnesses = ids;
      out.refusals.push(...why);
      out.ok = false;
      return out;
    }
  }
  const vaultItem = vault && mode !== "uninstall" ? planVault(vault) : null;
  if (vaultItem) out.items.push(vaultItem);
  // The binding the run leaves: the vault item's, when it writes one, else
  // the one on disk. Its status-line flag opts the status line in, as does
  // setup's answer (rule 9).
  const leaves = vaultItem ? vault.after : readConfigAt(projectDir);
  const optIn = new Set(surfaces || []);
  if (typeof statusline === "boolean" ? statusline : leaves?.statusline?.enabled === true) optIn.add("statusline");
  // The project-level layout (the layout ADR): one harness-neutral item, planned
  // once whatever --surface names — planned first, so every surface below is
  // planned against the new paths; its cleanup is planned last (below).
  const layoutHarness = loadHarness(
    ids.find((id) => {
      const p = layoutPaths(projectDir, { harnessDir: loadHarness(id).runtime?.harness_dir || null });
      return existsSync(p.legacy.binding) || existsSync(p.legacy.runtime);
    }) || ids[0],
  );
  const layoutCtx = { projectDir, mode, env, home, root, harness: layoutHarness, incomplete: false, surfaces };
  // Under the keep, the layout move and its cleanup are the kept copy's own
  // run when their harness is the one kept: moved under a pre-move copy, the
  // project would read as unbound to it (rule 5).
  const moved = keeping && layoutHarness.id === keeping.harness.id ? { first: [], last: [] } : planLayout(layoutCtx);
  for (const item of moved.first) out.items.push({ harness: layoutHarness.id, ...item });
  if (layoutCtx.incomplete) out.incomplete = true;
  // The binding a channel switch is recorded in (the converge story's rules 2
  // and 4): the file configPath resolves now, whether it exists, and whether it
  // carries the mark. Apply resolves it again, after the layout item; when the
  // plan moves the binding, the preview names where the move puts it.
  // Setup's vault item writes a binding first (rule 10): the project counts as
  // bound, its keys are the ones that item writes, at the path it writes.
  // Each channel key twice: whether it is there at all (`hasKey`, `hasKeep`:
  // what a removal names) and whether it is a record of the shape lib reads
  // (`hasMark`, `hasKeepRecord`: what a record is not planned over).
  const binding = (() => {
    const at = configPath(projectDir, env);
    const exists = existsSync(at);
    let cfg = null;
    if (exists) {
      try {
        cfg = JSON.parse(readFileSync(at, "utf8"));
      } catch {
        cfg = null;
      }
    }
    const movesIt = moved.first.some((i) => i.action === "migrate");
    const keys = vaultItem ? vault.after : cfg;
    const has = (k) => Boolean(keys && typeof keys === "object" && Object.hasOwn(keys, k));
    return {
      path: vaultItem ? vault.configPath : movesIt ? layoutPaths(projectDir).binding : at,
      bound: exists || Boolean(vaultItem),
      hasMark: Boolean(channelMark(keys)),
      hasKey: has(CHANNEL_SWITCH_KEY),
      hasKeep: has(CHANNEL_KEEP_KEY),
      hasKeepRecord: Boolean(channelKeep(keys)),
      statusline: keys?.statusline?.enabled ?? null,
    };
  })();
  // The `binding` items, applied last of all — after the layout item moved
  // the binding and the vault item wrote it — each the last rows of its
  // harness's group: the status-line flag, the keep's record, the mark.
  const marks = [];
  const flagHarness =
    ids.find((id) => {
      const s = loadHarness(id).surfaces?.statusline;
      return Boolean(s) && s.supported !== false;
    }) || null;
  const recordFor = (ctx) => {
    if (mode === "uninstall") return;
    if (ctx.harness.id === flagHarness) {
      const flag = planStatuslineFlag(ctx, statusline);
      if (flag) marks.push(flag);
    }
    if (recordKeep && keeping && ctx.harness.id === keeping.harness.id) {
      const kept = planKeepRecord(ctx);
      if (kept) marks.push(kept);
    }
  };
  // Setup's state directories (rule 10): one per harness whose registration
  // is not unavailable, the first naming state/ and its .gitignore — none
  // where a write this run plans lands inside it (the status-line launcher
  // makes it).
  let stateFirst = true;
  const stateFor = (id, harness) => {
    if (!ensureState || mode === "uninstall") return;
    const reg = out.items.find(
      (i) => i.harness === id && i.kind === "registration" && !String(i.surface).endsWith("_others"),
    );
    if (reg && reg.state === "unavailable") return;
    const item = planStateDir(projectDir, harness, { first: stateFirst });
    if (!item || out.items.some((i) => isWrite(i) && typeof i.path === "string" && inside(i.path, item.path))) return;
    stateFirst = false;
    out.items.push(item);
  };
  // The agents block is the PROJECT's, not a harness's (the story "One run
  // plans the agents block once, and a bare uninstall selects every harness
  // the project uses", rule 1): planned once for the run, before the loop and
  // from the files as they stand before it, by the first run harness that has
  // one, over the files every run harness names, with an import in every run
  // harness's native file. Planned per harness, each read the same snapshot,
  // so two harnesses wrote two blocks and an uninstall of both kept it for
  // "another harness" in the same run. Rendered from `root`, never from a
  // registration's install path or a fetched shell: every copy renders the
  // same block. --surface narrows it as it narrowed each harness's row.
  const blockRun = ids.map((id) => loadHarness(id)).filter((m) => agentsBlockRow(m));
  const owner = blockRun[0] || null;
  let blockItems = [];
  let blockKey = null;
  if (owner) {
    const [key, s] = agentsBlockRow(owner);
    if (!surfaceExcluded(key, s, { surfaces, register })) {
      const readers =
        blockRun.length > 1
          ? blockRun.map((m) => ({ display: m.display_name, files: agentsBlockRow(m)[1].files || [] }))
          : null;
      blockItems = planAgentsBlock(
        { projectDir, mode, root, harness: owner, run: blockRun, readers, layout, surfaces: surfaces || [] },
        key,
        { ...s, files: commonBlockFiles(blockRun) },
      );
      blockKey = key;
    }
  }
  // Placed once, at the owner's own row, so one harness's plan keeps its order;
  // after the loop if that row never came. The seam for the convergence
  // story's keep step: it calls placeBlock() before it pushes itself, so the
  // block precedes the keep and covers the whole run, Claude Code included.
  let placed = false;
  const placeBlock = () => {
    if (placed) return;
    placed = true;
    for (const item of blockItems) out.items.push({ harness: owner.id, ...item });
  };
  // The other run harnesses plan no block item; the preview names the owner's
  // at their position (presentation spec contract 7) — when there IS a block,
  // on disk or planned: the one written or kept, else the one removed. Never
  // under "no block to remove" or a refusal, where "the same block" names
  // nothing. Not enumerable, like hostManaged: plan --json keeps the shape it
  // had.
  const blockOf = (i) => i.surface === blockKey;
  const shown =
    blockItems.find(
      (i) =>
        blockOf(i) &&
        (["add", "create", "replace-entry"].includes(i.action) || (i.action === "skip" && i.state !== "ours-absent")),
    ) || blockItems.find((i) => blockOf(i) && i.action === "remove");
  Object.defineProperty(out, "sharedBlock", {
    value: shown
      ? { harness: owner.id, display: owner.display_name, file: rel(projectDir, shown.path), others: [] }
      : null,
    enumerable: false,
  });
  for (const id of ids) {
    const harness = loadHarness(id);
    out.harnesses.push(id);
    const ctx = {
      projectDir,
      mode,
      env,
      home,
      root,
      harness,
      optIn,
      slotForeign: new Set(),
      incomplete: false,
      renderRoot: root,
      surfaces: surfaces || [],
      globalRemoval,
      version,
      fetched: payloadRoots?.[id] || null,
      convergence: decision,
      channel,
      binding,
      channelFacts: null,
      refusals: [],
      takesSurface,
    };
    // The keep (rule 5): the run's one block first — over the whole run set,
    // this harness included — then the keep's one item, and none of this
    // harness's own rows. Placed here when this harness owns the block; named
    // as the same block, above, when an earlier harness placed it.
    if (keeping && id === keeping.harness.id) {
      if (id !== owner?.id && out.sharedBlock && agentsBlockRow(harness))
        out.sharedBlock.others.push({ harness: id, display: harness.display_name, at: out.items.length });
      placeBlock();
      for (const item of planKeep(ctx, keeping, keepRead)) out.items.push(item);
      out.refusals.push(...ctx.refusals);
      if (ctx.incomplete) out.incomplete = true;
      stateFor(id, harness);
      recordFor(ctx);
      continue;
    }
    const hostRows = [];
    const unsupportedHost = [];
    let registration = null;
    const rows = Object.entries(harness.surfaces || {}).filter(([key]) => !key.startsWith("_"));
    rows.sort(([, x], [, y]) => (KIND_ORDER[x.kind] ?? 3) - (KIND_ORDER[y.kind] ?? 3));
    for (const [key, s] of rows) {
      // --no-register: this run changes the project's files and nothing of the
      // host's (the layout move run from an installed copy; the layout spec,
      // contract 12 as amended 2026-10-03).
      const excluded = surfaceExcluded(key, s, { surfaces, register });
      if (excluded) {
        // A registration this run leaves out still decides the render root,
        // read-only — HERE, before the surfaces that render against it (the
        // registration sorts first). Read after the loop, as it was until
        // 2026-10-03, it moved only the preview's "planned against" line and
        // never an item: a --no-register run from a checkout re-pointed the
        // status line at the checkout (the second review of the 2026-10-03
        // fixes, S1).
        if (s.kind === "registration" && !isPluginCacheRoot(root, home)) {
          const analyser =
            s.format === "portable-plugin-registration" ? analysePortableRegistration : analyseRegistration;
          const a = analyser(projectDir, s, { root, home, harness, env, version, fetched: ctx.fetched });
          const installed = registrationRenderRoot(a);
          if (installed) ctx.renderRoot = installed;
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
      if (s.kind === "host") {
        if (s.supported !== false) hostRows.push(key);
        else unsupportedHost.push([key, s]);
        continue;
      }
      // The run's block, planned above: the owner places it here, every other
      // harness only records where the preview names it.
      if (s.format === "markdown-block") {
        if (id === owner?.id) placeBlock();
        else if (out.sharedBlock)
          out.sharedBlock.others.push({ harness: id, display: harness.display_name, at: out.items.length });
        continue;
      }
      const handler = HANDLERS[s.format];
      if (!handler) {
        out.refusals.push(`${id}: surface ${key} has format ${s.format}, which this installer cannot handle`);
        continue;
      }
      const items = handler(ctx, key, s);
      const dependent =
        s.kind !== "registration" && ctx.renderRoot !== root && ["json-entry", "mjs"].includes(s.format);
      for (const item of items)
        out.items.push({ harness: id, ...item, ...(dependent ? { plannedAgainst: ctx.renderRoot } : {}) });
      if (s.kind === "registration") {
        // Phase two (contract 4′): the rest is planned against the root the
        // registration produces — when it produces one on this run or has.
        const own = items.find((i) => i.surface === key);
        // The host-managed report names where a host plugin registration is
        // loaded in place: the plugin's root in our directory, from the same
        // registrationPaths the analysis used. Kept off the item, so plan
        // --json keeps the shape it had.
        registration = own
          ? {
              ...own,
              payload:
                s.format === "host-plugin-registration"
                  ? registrationPaths(s, { home, projectDir, harness }).payload
                  : null,
            }
          : null;
        if (
          own &&
          mode !== "uninstall" &&
          ["create", "update", "skip"].includes(own.action) &&
          own.root &&
          !own.deferred
        )
          ctx.renderRoot = own.root;
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
      if (!Object.hasOwn(out, "hostManaged"))
        Object.defineProperty(out, "hostManaged", { value: [], enumerable: false });
      out.hostManaged.push({
        harness: harness.id,
        display: harness.display_name,
        rows: hostRows,
        entry: registration?.entry || null,
        action: registration?.action || null,
      });
    }
    // An unsupported host surface gets the same row shape a shared one does
    // (planJsonEntry's unsupported branch): state "unsupported", action "skip",
    // and the manifest's own reason. One treatment for one fact, so a reader —
    // and a test — meets "this harness does not have that" in one form rather
    // than two.
    for (const [key, s] of unsupportedHost) {
      out.items.push({
        harness: id,
        surface: key,
        kind: "host",
        path: null,
        entry: null,
        state: "unsupported",
        action: "skip",
        reason: s.why_unsupported || "not supported for this harness yet",
      });
    }
    // The mark, for the channel "npm" only: placed last of all (below), so it
    // is the last row of this harness's group and applies after the layout
    // item has moved the binding it is recorded in.
    stateFor(id, harness);
    recordFor(ctx);
    if (mode !== "uninstall" && channel === "npm") {
      const mark = planMark(ctx, ctx.channelFacts);
      if (mark) marks.push(mark);
    }
    // Last for this harness: its state directory, which a project uninstall
    // empties of the welcome marker and removes once empty. A narrowed
    // uninstall plans no such step, as it plans no layout cleanup.
    if (mode === "uninstall" && !surfaces) {
      const item = planHarnessState(
        projectDir,
        harness,
        out.items.filter((i) => i.harness === id),
      );
      if (item) out.items.push({ harness: id, ...item });
    }
  }
  placeBlock();
  for (const item of moved.last) out.items.push({ harness: layoutHarness.id, ...item });
  out.items.push(...marks);
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
    return {
      first: [],
      last: [
        {
          ...base,
          surface: "layout_cleanup",
          path: P.legacy.runtime,
          state: "legacy",
          action: "remove",
          reason: "the legacy runtime directory is ours (its .gitignore header) and goes with the state",
          steps: [
            {
              kind: "remove-legacy-runtime",
              path: P.legacy.runtime,
              why: "the pre-0.28 state directory, removed whole",
            },
            {
              kind: "note",
              why: ".projectstore/state/ (sessions, the entry log) and the binding stay: the hooks' records and bind's file, not install's — delete .projectstore/ by hand to disown fully",
            },
          ],
        },
      ],
    };
  }
  if (a.twoConfigs && !a.resumable)
    return {
      first: [
        {
          ...base,
          action: "refuse",
          reason: `two bindings: ${P.legacy.binding} (legacy) and ${P.binding} — keep one and delete the other (usually the legacy one), then run install again; nothing is written while both exist`,
        },
      ],
      last: [],
    };
  if (insideHostSession(env, harness)) {
    ctx.incomplete = true;
    return {
      first: [
        {
          ...base,
          action: "skip",
          deferred: true,
          reason: `the layout migration moves files this ${harness.display_name} session reads and writes — run it from a terminal outside the session`,
        },
      ],
      last: [],
    };
  }
  const steps = [
    {
      kind: "note",
      why: `close other ${harness.display_name} sessions in this project first and restart afterwards: the migration moves files a running session reads and writes, and the status line does not reload mid-session`,
    },
    { kind: "ensure", path: P.root, why: ".projectstore/ with its .gitignore (projectstore.json, state/)" },
  ];
  if (a.legacy.state)
    steps.push({
      kind: "move-state",
      from: P.legacy.state,
      to: P.sessions,
      files: a.legacy.stateFiles.length,
      why: "session files move into state/sessions/; one present on both sides keeps the newer, a per-session directory keeps the new side",
    });
  if (a.legacy.entryLog)
    steps.push({
      kind: "merge-log",
      from: P.legacy.entryLog,
      to: P.entryLog,
      why: "the legacy entry log's lines go before the new log's",
    });
  if (a.legacy.welcomed)
    steps.push({
      kind: "move-marker",
      from: P.legacy.welcomed,
      to: P.welcomed(harness.id),
      why: "the welcome marker moves under state/<harness>/ — a migrated project is not welcomed twice",
    });
  if (a.legacy.sessionId) steps.push({ kind: "delete", path: P.legacy.sessionId, why: "the 0.6-era session-id file" });
  if (a.legacy.binding && a.resumable)
    steps.push({
      kind: "delete",
      path: P.legacy.binding,
      why: "the binding was already moved (an interrupted run left the legacy copy, byte-equal but for its agents block)",
    });
  else if (a.legacy.binding)
    steps.push({
      kind: "move-binding",
      from: P.legacy.binding,
      to: P.binding,
      overlay: P.overlay(harness.id),
      why: `the binding moves; its agents block becomes harness/${harness.id}.json`,
    });
  const first = [
    {
      ...base,
      action: "migrate",
      steps,
      reason: `${a.legacy.binding ? "binding" : "state"} in the pre-0.28 layout under ${a.legacy.dir}/`,
    },
  ];
  const last = [];
  if (a.legacy.launcher || a.legacy.runtime) {
    const cleanup = [];
    if (a.legacy.launcher)
      cleanup.push({
        kind: "remove-legacy-launcher",
        path: P.legacy.launcher,
        why: "removed once the new launcher is written and the settings entry names it — or at once when the status-line slot is not ours (foreign, or empty because the status line is off); kept while a settings file the host reads (this project's local or committed settings, or the user's) still runs it as the status line — a script that calls it indirectly is not seen",
      });
    if (a.legacy.runtime)
      cleanup.push({ kind: "rmdir-legacy", path: P.legacy.runtime, why: "the emptied pre-0.28 runtime directory" });
    last.push({
      ...base,
      surface: "layout_cleanup",
      path: P.legacy.runtime,
      state: "legacy",
      action: "cleanup",
      reason: null,
      steps: cleanup,
    });
  }
  return { first, last };
}

// A project uninstall's last item per harness (the shell-fetch story's rule
// 5; install spec contract 13 as amended): .projectstore/state/<id>/ is
// emptied of the welcome marker — recognised by analyseHarnessState — and
// removed once empty, so the next bare upgrade stops selecting the harness
// it disowned. Planned for a directory holding the marker, or nothing; a
// directory holding only what is not ours is left without a row. It never
// touches a launcher: that is its surface item's to remove, when it is ours.
// What stays — a launcher this plan does not remove, a file of the user's —
// is named in the preview, and keeps the directory. Not a guarantee: a
// harness whose plugin stays installed for the machine fires its hooks here
// again, its welcome comes back, and so does the signal — accurately.
function planHarnessState(projectDir, harness, planned) {
  const a = analyseHarnessState(projectDir, harness.id);
  if (!a.present || (!a.marker && a.names.length)) return null;
  const removing = new Set(
    planned
      .filter((i) => i.kind === "exclusive" && i.action === "remove" && dirname(i.path) === a.dir)
      .map((i) => basename(i.path)),
  );
  const left = a.others.filter((n) => !removing.has(n));
  const steps = [];
  if (a.marker)
    steps.push({
      kind: "delete",
      path: a.marker,
      why: "the welcome marker the SessionStart hook wrote; a bare upgrade selects the harness by it",
    });
  steps.push({
    kind: "rmdir-state",
    path: a.dir,
    left,
    why: left.length
      ? `${left.join(", ")} ${left.length === 1 ? "is" : "are"} not this step's to remove, and keep${left.length === 1 ? "s" : ""} the directory`
      : "removed once empty",
  });
  return {
    surface: "harness_state",
    kind: "layout",
    path: a.dir,
    entry: null,
    state: a.marker ? "ours" : "empty",
    action: "remove",
    reason: a.marker
      ? `${harness.display_name}'s welcome marker — the state directory selects ${harness.display_name} for a bare upgrade`
      : `an empty state directory of ${harness.display_name}`,
    steps,
  };
}

function applyLayout(p, i, { failed, home = homedir(), onStep = null }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const within = p.projectDir;
  if (i.action === "cleanup" && failed) {
    out.action = "skipped";
    out.reason = "an earlier item failed; the legacy files stay until the next run";
    return out;
  }
  const fail = (step, message) => {
    out.failed = { step, status: null, stderr: message };
    return out;
  };
  for (const st of i.steps || []) {
    const seen = out.steps.length;
    if (onStep) onStep(st, "start");
    try {
      if (st.kind === "ensure") {
        ensureRuntimeDir(within);
        out.steps.push({ kind: st.kind, ok: true });
      } else if (st.kind === "move-state") {
        const r = moveStateDir(st.from, st.to, within);
        ensureStateDir(within);
        out.steps.push({ kind: st.kind, ok: true, ...r });
      } else if (st.kind === "merge-log") {
        const r = mergeEntryLog(st.from, st.to, within);
        out.steps.push({ kind: st.kind, ok: true, result: r });
      } else if (st.kind === "delete") {
        out.steps.push({ kind: st.kind, path: st.path, ok: true, removed: removeInside(st.path, within) });
      } else if (st.kind === "move-marker") {
        const r = movePath(st.from, st.to, within);
        if (r === "target-exists") removeInside(st.from, within);
        out.steps.push({ kind: st.kind, ok: true, result: r });
      } else if (st.kind === "move-binding") {
        let cfg;
        try {
          cfg = JSON.parse(readFileSync(st.from, "utf8"));
        } catch {
          return fail(st.kind, `${st.from} is not valid JSON; the binding was not moved`);
        }
        if (existsSync(st.to)) return fail(st.kind, `${st.to} appeared under the plan; two bindings are a refusal`);
        const { agents, ...binding } = cfg && typeof cfg === "object" ? cfg : {};
        if (agents && typeof agents === "object") {
          let overlay = {};
          try {
            overlay = JSON.parse(readFileSync(st.overlay, "utf8"));
          } catch {}
          mkdirSync(dirname(st.overlay), { recursive: true });
          writeFileAtomic(st.overlay, JSON.stringify({ ...overlay, agents }, null, 2) + "\n", { sweep: false });
        }
        mkdirSync(dirname(st.to), { recursive: true });
        writeFileAtomic(st.to, JSON.stringify(binding, null, 2) + "\n", { sweep: false });
        removeInside(st.from, within);
        out.steps.push({ kind: st.kind, ok: true, overlay: Boolean(agents) });
      } else if (st.kind === "remove-legacy-launcher") {
        // Only ours, and only when no settings entry names it any more.
        let text = null;
        try {
          text = readFileSync(st.path, "utf8");
        } catch {}
        // "Still in use" is decided by the FILE, not the spelling: an entry
        // written through a symlinked or differently-cased path, or living in
        // the committed or the user's settings, still runs it (the third review
        // of the 2026-10-03 fixes — a string comparison of the local file alone
        // deleted a launcher the status line was running).
        const named =
          entryNames(p.projectDir, i.harness, st.path) || settingsRunFile(p.projectDir, i.harness, st.path, home);
        // Moved, never just deleted: the legacy launcher goes only once the new
        // one exists (a dev root produces none — contract 7 leaves it in place)
        // — unless the status-line slot is not ours (any wiring of ours counts).
        // Under a foreign or empty slot the new launcher is never made, and
        // keeping the old one kept layout-legacy alive forever (the critic of
        // the layout spec's 2026-10-03 amendment, case S1).
        const moved = existsSync(layoutPaths(p.projectDir).launcher(i.harness));
        const slotOurs = slotIsOurs(p.projectDir, i.harness, { home, root: p.root });
        if (text === null) out.steps.push({ kind: st.kind, ok: true, removed: false });
        else if (!moved && slotOurs)
          out.steps.push({
            kind: st.kind,
            ok: true,
            removed: false,
            reason: "no launcher at the new path yet (this root does not produce one) — left in place",
          });
        else if (!isOurFile(text))
          out.steps.push({ kind: st.kind, ok: true, removed: false, reason: "not ours — left in place" });
        else if (named)
          out.steps.push({
            kind: st.kind,
            ok: true,
            removed: false,
            reason: "a settings file the host reads still runs it as the status line — left in place",
          });
        else out.steps.push({ kind: st.kind, ok: true, removed: removeInside(st.path, within) });
      } else if (st.kind === "rmdir-legacy") {
        // Prune the legacy runtime dir when only its own .gitignore (and an empty state/) remain.
        let left = [];
        try {
          left = readdirSync(st.path).filter((n) => n !== ".gitignore");
        } catch {
          out.steps.push({ kind: st.kind, ok: true, removed: false });
          continue;
        }
        if (left.length === 1 && left[0] === "state") {
          try {
            if (readdirSync(join(st.path, "state")).length === 0) {
              rmdirSync(join(st.path, "state"));
              left = [];
            }
          } catch {}
        }
        if (left.length) {
          out.steps.push({ kind: st.kind, ok: true, removed: false, reason: `${left.join(", ")} remain` });
          continue;
        }
        removeInside(st.path, within, { recursive: true });
        out.steps.push({ kind: st.kind, ok: true, removed: true });
      } else if (st.kind === "remove-legacy-runtime") {
        removeInside(st.path, within, { recursive: true });
        out.steps.push({ kind: st.kind, ok: true, removed: true });
      } else if (st.kind === "rmdir-state") {
        // rmdirSync on an empty directory only: whatever is left — read now,
        // after the items before it ran — keeps it, and is named.
        let left = [];
        try {
          left = readdirSync(st.path).sort();
        } catch {
          out.steps.push({ kind: st.kind, ok: true, removed: false });
          continue;
        }
        if (left.length) {
          out.steps.push({ kind: st.kind, ok: true, removed: false, reason: `${left.join(", ")} remain` });
          continue;
        }
        rmdirSync(st.path);
        out.steps.push({ kind: st.kind, ok: true, removed: true });
      }
    } catch (e) {
      return fail(st.kind, e && e.message ? e.message : String(e));
    } finally {
      if (onStep) onStep(st, "end", stepResult(out, seen));
    }
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
  const id = (f) => {
    try {
      const s = statSync(f);
      return `${s.dev}:${s.ino}`;
    } catch {
      return null;
    }
  };
  const want = id(file);
  if (!want) return false;
  const h = loadHarness(harnessId);
  const dir = h.runtime?.harness_dir || ".claude",
    v = h.runtime?.project_dir_env;
  const files = [
    join(projectDir, h.surfaces?.statusline?.file || join(dir, "settings.local.json")),
    join(projectDir, dir, "settings.json"),
    join(claudeHome(home), "settings.json"),
  ];
  return files.some((f) => {
    try {
      let cmd = JSON.parse(readFileSync(f, "utf8"))?.statusLine?.command;
      if (typeof cmd !== "string") return false;
      if (v)
        cmd = cmd
          .split("${" + v + "}")
          .join(projectDir)
          .split("$" + v)
          .join(projectDir);
      const sp = statusLineScriptPath(cmd);
      return Boolean(sp) && id(isAbsolute(sp) ? sp : join(projectDir, sp)) === want;
    } catch {
      return false;
    }
  });
}

// Is the harness's status-line slot wired to anything of ours (any wiring)?
function slotIsOurs(projectDir, harnessId, { home, root }) {
  try {
    const s = loadHarness(harnessId).surfaces?.statusline;
    if (!s || !s.file) return false;
    const cmd = JSON.parse(readFileSync(join(projectDir, s.file), "utf8"))?.statusLine?.command;
    return typeof cmd === "string" && statusLineIsOurWiring(cmd, projectDir, home, root);
  } catch {
    return false;
  }
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
  } catch {
    return false;
  }
}

// Contract 14: the host installs and updates these itself; say how, from the
// manifest, and write nothing. (PR #13's installElsewhere, as a plan line.)
function hostManagedReport(m, rows, registration = null) {
  const inst = m.install || {};
  const lines = [
    `${m.display_name}: ${rows.join(", ")} are installed by ${inst.mechanism || "the host"} — nothing to write.`,
  ];
  if (registration && registration.entry) {
    const how =
      registration.action === "skip" && registration.state === "current"
        ? "registered here"
        : registration.action === "refuse"
          ? "refused, see below"
          : registration.action === "skip"
            ? "not registered on this run, see below"
            : `registered by this run (${registration.action})`;
    // A host plugin registration is a marketplace added from a local path, and
    // the host loads its plugin in place, from the plugin's root inside that
    // directory (`payload`, set by plan()); the install path is the registry's
    // copy, which the launcher renders (the story "The SessionStart hook and
    // install agree on the status line…", measured on host 2.1.293 and
    // 2.1.296). A portable registration's host loads the copy.
    const where = !registration.root
      ? ""
      : registration.payload
        ? ` — install path ${registration.root}; the host loads them in place from ${registration.payload}`
        : ` — the host loads them from ${registration.root}`;
    lines.push(`  They come from the registration ${registration.entry}, ${how}${where}.`);
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
// PLAN (presentation spec contract 7, which revises the layout clauses of
// install spec contract 18): the badge, the project path, a summary line of
// counts, then the rows grouped under each run harness's display name, in run
// order. A row is one aligned line — glyph, action word, target, note — and
// beneath it what the reader consents to (install spec contract 9: every path
// written and every host argv, with the files it touches), the reason when
// there is one, and a consequence the reader must know. Internal words —
// kinds, provenance states, entry markers, roadmap ids — and each step's why
// are behind `--verbose`. Groups and counts are computed here, never added to
// the plan: plan --json keeps its keys. Colour and glyphs are the caller's
// stream's (`caps`, term.mjs); the default is plain text in Unicode.
const unicodeGlyph = (name) => termIcon({ ascii: false }, name);

// Every action a plan item can carry, as its glyph. A write never wears the
// skip glyph: `add` and `replace-entry` are changes as much as `create` and
// `update`.
// A copy from another marketplace turned off for this checkout is a channel
// switch, `disable` (the converge story; contract 7's `switch` word, ⇄).
const ACTION_ICON = {
  create: "create",
  add: "create",
  update: "update",
  "replace-entry": "update",
  migrate: "migrate",
  disable: "switch",
  cleanup: "cleanup",
  remove: "remove",
  prune: "remove",
  skip: "skip",
  refuse: "refuse",
};
// …and as a person's word (contract 7's table). A registration's write takes
// `register`; a skip reads `unchanged` when the item is current and carries
// no reason, and `skipped` otherwise — deferred, opted out, unsupported, or
// left in place: a current row with a reason is one the run did not act on
// for that reason (uninstall keeping a user-global registration, a host CLI
// not on PATH), and the reason beneath it is what the reader acts on.
const ACTION_WORD = {
  create: "add",
  add: "add",
  update: "update",
  "replace-entry": "update",
  migrate: "update",
  disable: "switch",
  cleanup: "remove",
  remove: "remove",
  prune: "remove",
  refuse: "refused",
};
// Each word's colour role (contract 3): a refusal's ▲, a channel switch and a
// removal are attention; red is for what failed.
const WORD_ROLE = {
  add: "done",
  register: "done",
  update: "action",
  switch: "attention",
  remove: "attention",
  refused: "attention",
  unchanged: "explanation",
  skipped: "explanation",
};
// APPLY says a word while its step runs and once it has (contract 8).
const WORD_TENSES = {
  add: ["adding", "added"],
  register: ["registering", "registered"],
  update: ["updating", "updated"],
  switch: ["switching", "switched"],
  remove: ["removing", "removed"],
};

const CURRENT_STATES = new Set(["current", "ours-current", "ours"]);
const isUnchanged = (i) => i.action === "skip" && !i.deferred && !i.reason && CURRENT_STATES.has(i.state);
// A surface this harness does not have: folded into one line per harness.
const isUnsupported = (i) => i.action === "skip" && i.state === "unsupported";
// A row of something another project wrote last (install spec contract 12):
// never collapsed, and its note says whose it is.
const writtenElsewhere = (i) => i.state === "current" && Boolean(i.writtenBy) && !i.sameProject;
// A row that writes nothing and asks nothing of the reader collapses into
// one line per group naming it (contract 7).
const isQuiet = (i) => isUnchanged(i) && !writtenElsewhere(i) && !(i.steps || []).length;
// The registration row a fetched shell's registry lines sit beneath, when the
// run fetched one from a registry that is not the user's.
const fetchedFor = (p, i) =>
  p.fetchedFrom &&
  i.kind === "registration" &&
  !String(i.surface).endsWith("_others") &&
  p.fetchedFrom.harnesses.includes(i.harness)
    ? p.fetchedFrom
    : null;

function actionWord(i) {
  if (i.action === "skip") return isUnchanged(i) ? "unchanged" : "skipped";
  if (i.kind === "registration" && ["create", "add", "update"].includes(i.action)) return "register";
  return ACTION_WORD[i.action] || "update";
}
const glyphName = (i) => ACTION_ICON[i.action] || (isWrite(i) ? "update" : "skip");
// The surface key in words: `agents_block` reads "agents block".
const surfaceWords = (key) => String(key).replace(/_/g, " ");
// What a row names: a registration by its plugin id — its paths are the
// consent lines beneath it — anything else by its path, project-relative.
function rowTarget(p, i, home = homedir()) {
  // …and the keep (kind `channel`) by the key of the copy it keeps.
  if ((i.kind === "registration" || i.kind === "channel") && i.entry) return i.entry;
  if (i.path === null) return `${i.surface} [${i.harness}, no filesystem path]`;
  // Setup's vault and state directories, as directories; a vault outside the
  // project — beside it, usually — by its path from home, as the project's.
  if (i.kind === "vault") {
    const r = rel(p.projectDir, i.path);
    return `${r === i.path ? tilde(i.path, home) : r}/`;
  }
  if (i.kind === "state") return `${rel(p.projectDir, i.path)}/`;
  return rel(p.projectDir, i.path);
}
// The heading of the group of rows that belong to no harness: setup's vault
// (presentation spec contract 7's VAULT group, first when present).
const VAULT_GROUP = "Vault";
function rowNote(i, { verbose, glyph }) {
  const words = writtenElsewhere(i) ? `last written by ${i.writtenBy}` : surfaceWords(i.surface);
  if (!verbose) return words;
  return `${words} ${glyph("dot")} ${i.kind}${i.entry && i.kind !== "registration" ? ` [${i.entry}]` : ""}`;
}
// --verbose's line beneath a row: the provenance state, the reason and the
// plan's own action, as install spec contract 18 wrote them.
function transitionText(i, glyph) {
  let state = writtenElsewhere(i) ? `current, last written by ${i.writtenBy}` : i.state;
  // A reason with commands gives its prose here; the commands follow, alone.
  const reason = i.advice ? i.advice.text : i.reason;
  if (reason && i.action !== "refuse") state += ` (${reason})`;
  // A dry run's unchanged registration: right by every host fact, its
  // payload digest still to compare. Said only where the reasoning is.
  if (i.digestDeferred) state += " (the payload digest is compared when install or upgrade fetches the shell)";
  return `${state} ${glyph("transition")} ${i.action}${i.action === "refuse" && i.reason ? ": " + i.reason : ""}`;
}

// One step of an item as the lines it shows: always the action and its target,
// then — under --verbose — why it runs.
function stepLines(p, st, { verbose, paint, width = 0, glyph = unicodeGlyph, home = homedir() }) {
  const r = (x) => rel(p.projectDir, x);
  // A path outside the project — setup's vault, beside it usually — from
  // home, as its row and its APPLY lines name it.
  const t = (x) => tilde(r(x), home);
  const to = ` ${glyph("transition")} `;
  const lead = "      ";
  const sub = "          ";
  const why =
    verbose && st.why
      ? wrap(st.why, width, sub)
          .split("\n")
          .map((l, k) => (k ? "" : sub) + paint("explanation", l))
      : [];
  // A consent line (install spec contract 9): the step's verb and what it
  // touches, in the explanation role (presentation spec contracts 3 and 7).
  const said = (text) => `${lead}${paint("explanation", text)}`;
  switch (st.kind) {
    case "host": {
      // The keep step's argv is whole (its bin is the Node that runs us), and
      // its touches are the kept copy's planned writes, each with its action.
      const out = [said(`$ ${(st.bin ? [st.bin, ...st.argv] : st.argv).join(" ")}`)];
      if (st.touches.length)
        out.push(
          `${sub}${paint("explanation", `touches ${st.touches.map((t) => (typeof t === "string" ? r(t) : `${t.path ? r(t.path) : t.surface} (${t.action})`)).join(", ")}`)}`,
        );
      return [...out, ...why];
    }
    // The fetch a dry run would run first (the shell-fetch story's rule 6),
    // with the fetch glyph (presentation spec contract 4).
    case "fetch":
      return [
        `${lead}${paint("action", glyph("fetch"))} ${paint("explanation", [st.bin, ...st.argv].join(" "))}`,
        ...why,
      ];
    case "note":
      return wrap(`note: ${st.why}`, width, sub)
        .split("\n")
        .map((l, k) => (k ? l : lead + paint("attention", "note:") + l.slice(5)));
    case "write":
      return [
        said(`write ${st.path}${st.manifestOnly ? " (manifest only)" : ` (${st.files} files + the manifest)`}`),
        ...why,
      ];
    // A dry run names no file count: the payload is counted after the fetch.
    case "portable-write":
      return [
        said(
          `stage ${st.path} (${Array.isArray(st.files) ? `${st.files.length} payload files` : "the fetched payload"} + catalogue + ownership)`,
        ),
        ...why,
      ];
    case "rmdir-state":
      return [
        said(
          `remove ${r(st.path)}/ once empty${st.left?.length ? ` ${glyph("dash")} ${st.left.join(", ")} stay${st.left.length === 1 ? "s" : ""} and keep${st.left.length === 1 ? "s" : ""} it` : ""}`,
        ),
        ...why,
      ];
    case "portable-remove":
    case "remove":
      return [said(`remove ${st.path}`), ...why];
    case "unregister":
      return [said(`edit ${r(st.path)}  [${st.pointer}.${st.name}]${to}removed`), ...why];
    // The channel switch's record in the binding (the converge story's rules
    // 2 and 4): its time is the apply's, unknown to a preview.
    case "mark":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}by "setup", at the time of apply`), ...why];
    case "unmark":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}removed`), ...why];
    // A `binding` item's value (the setup story's status-line flag).
    case "set":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}${JSON.stringify(st.value)}`), ...why];
    // Setup's vault (rule 10), the binding plan's own steps: every path is in
    // the default view. A scaffold step's paths are the vault's, beneath the
    // row that names it.
    case "mkdir":
      return [said(`create ${t(st.path)}/`), ...why];
    case "bind":
      return [
        said(
          `write ${r(st.path)}  (${st.from ? `the binding of ${st.from}${st.drop?.length ? `, without ${st.drop.join(" and ")}` : ""}` : `vault_path, layout ${st.layout}, language ${st.language}`})`,
        ),
        ...why,
      ];
    case "git-init":
      return [
        said(`$ ${st.argv.join(" ")}`),
        `${sub}${paint("explanation", `in ${t(st.path)}, with no commit`)}`,
        ...why,
      ];
    case "scaffold":
      return [said(`create ${st.rels.join(" and ")}`), ...why];
    case "ensure":
      return [said(`ensure ${r(st.path)}/`), ...why];
    case "move-state":
      return [said(`move ${r(st.from)}/${to}${r(st.to)}/ (${st.files} entries)`), ...why];
    case "merge-log":
      return [said(`merge ${r(st.from)}${to}${r(st.to)}`), ...why];
    case "delete":
      return [said(`delete ${r(st.path)}`), ...why];
    case "move-marker":
      return [said(`move ${r(st.from)}${to}${r(st.to)}`), ...why];
    case "move-binding":
      return [said(`move ${r(st.from)}${to}${r(st.to)}  (agents${to}${r(st.overlay)})`), ...why];
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime":
      return [said(`remove ${r(st.path)}`), ...why];
    default:
      return [];
  }
}

const displayName = (id) => loadHarness(id)?.display_name || id;
// The harnesses a plan names, by their display names — for the badge.
function displayNames(p) {
  return p.harnesses.map(displayName).join(", ") || "(no harness)";
}

const tilde = (path, home = homedir()) =>
  path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;

// The badge (presentation spec contract 7): `projectstore <verb> · <display
// names>`, the first line of a verb's output. A run that fetches prints it
// before the fetch line, and its preview then leaves it out (`badge: false`),
// so it is printed once.
export function badgeLine(p, { verb = null, caps: c = PLAIN } = {}) {
  return badgeText(c, `projectstore ${verb || p.mode}`, [displayNames(p)]);
}

// The update notice in the badge's slot (the converge story's rule 8;
// presentation spec contracts 6 and 7): the note glyph, the text in the
// explanation role, then the command alone on its line after a blank one, in
// the action role, and a blank line before the preview.
export function noticeText(n, c = PLAIN) {
  const paint = painter(c);
  return (
    [
      `  ${paint("attention", termIcon(c, "note"))} ${paint("explanation", n.text)}`,
      ...commandBlock(c, [n.command], { indent: 4 }),
      "",
    ].join("\n") + "\n"
  );
}

// The summary line: the counts by kind of change, each in its word's role.
// Unsupported rows are not counted: they are the harness's, not the run's.
const COUNTED = [
  ["add", (n) => `${n} to add`],
  ["register", (n) => `${n} to register`],
  ["update", (n) => `${n} to update`],
  ["switch", (n) => `${n} to switch`],
  ["remove", (n) => `${n} to remove`],
  ["unchanged", (n) => `${n} unchanged`],
  ["skipped", (n) => `${n} skipped`],
];
function planSummary(p, c) {
  if (!p.ok) return heading(c, "Plan", [["refused", "attention"]]);
  const n = {};
  for (const i of p.items) if (!isUnsupported(i)) n[actionWord(i)] = (n[actionWord(i)] || 0) + 1;
  const counts = COUNTED.filter(([w]) => n[w]).map(([w, say]) => [say(n[w]), WORD_ROLE[w]]);
  return heading(c, "Plan", counts.length ? counts : [["nothing to change", "explanation"]]);
}

// `home` shortens the project path to ~ (the caller's home; a test's fixed
// one); everything else the screen needs is in `p`. `header` is a caller's
// lines beneath the project path — setup's, naming the git work tree's top
// when it runs in a subfolder (the setup story, rule 4).
export function renderPreview(
  p,
  { verbose = false, verb = null, caps: c = PLAIN, badge = true, home = homedir(), header = [] } = {},
) {
  const paint = painter(c);
  const glyph = (name) => termIcon(c, name);
  const width = c.live ? c.width : 0;
  const writes = p.items.filter(isWrite);
  // Prose, wrapped to the terminal with every line indented; a path or a
  // command inside it is one word and never broken (term.mjs wrap).
  const prose = (indent, text, role = "explanation") =>
    wrap(text, width, indent)
      .split("\n")
      .map((l, k) => indent + paint(role, k ? l.slice(indent.length) : l));
  const lines = [
    ...(badge ? [badgeLine(p, { verb, caps: c })] : []),
    `  ${paint("explanation", tilde(p.projectDir, home))}`,
    ...(header || []).flatMap((h) => prose("  ", h)),
    "",
  ];
  if (verbose) {
    for (const [h, r] of Object.entries(p.plannedAgainst || {}))
      lines.push(
        ...prose(
          "  ",
          `${h}: the surfaces below are planned against the host's install path ${r}, not this package at ${p.root}.`,
        ),
        "",
      );
    for (const r of p.reports) lines.push(...r.split("\n").flatMap((l) => (l.trim() ? prose("  ", l) : [""])), "");
  }
  lines.push(planSummary(p, c));
  // An emptied state directory is pruned with the launcher removed from it;
  // said once, beneath the first such row.
  let pruneSaid = false;
  const beneath = (i) => {
    const out = [];
    // A user-scope registration reaches past this project: contract 7's
    // consequence line, on the line beneath its row, before anything else.
    if (isWrite(i) && i.kind === "registration" && i.scope === "user")
      out.push(
        ...prose(
          "      ",
          `user-wide: the plugin is ${i.action === "remove" ? "removed" : "registered"} for every project ${displayName(i.harness)} opens, not only this one`,
        ),
      );
    // …and a channel switch's (the converge story's rule 2), carried as its
    // note step: first, before the reason and the consent lines.
    for (const st of (i.steps || []).filter(isConsequence)) out.push(...prose("      ", st.why));
    if (verbose) out.push(...prose("      ", transitionText(i, glyph)));
    else if (i.reason && !isUnsupported(i))
      out.push(
        ...prose("      ", i.advice ? i.advice.text : i.reason, i.action === "refuse" ? "attention" : "explanation"),
      );
    // The reason's ways out (the converge story): each lead, then its command
    // alone on its line after a blank one (contract 6), and a blank line after.
    if (i.advice?.blocks?.length) {
      for (const b of i.advice.blocks)
        out.push(...prose("      ", b.lead), ...commandBlock(c, [b.command], { indent: 10 }), "");
    }
    // A shell this run fetched from a registry that is not the user's (the
    // converge story's rule 8, as amended 2026-10-09): both named. Neutral
    // words: the fetch's URL can come from the project's .npmrc or from the
    // run's own environment (`npx --registry`), and either reads the same.
    const from = fetchedFor(p, i);
    if (from)
      out.push(
        ...prose("      ", `fetched from ${from.registry}`),
        ...prose("      ", `your npm's own registry is ${from.user}`),
      );
    for (const st of (i.steps || []).filter((x) => !isConsequence(x)))
      out.push(...stepLines(p, st, { verbose, paint, width, glyph, home }));
    if (i.kind === "registration" && i.home && i.surface && !i.surface.endsWith("_others"))
      out.push(`      ${paint("explanation", `(harness home ${i.home}${i.scope ? `, scope ${i.scope}` : ""})`)}`);
    if (i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim())
      out.push(`      ${paint("explanation", "(the file would hold nothing else and is removed)")}`);
    if (!pruneSaid && i.action === "remove" && i.kind === "exclusive") {
      pruneSaid = true;
      out.push(`      ${paint("explanation", `(an emptied ${rel(p.projectDir, dirname(i.path))}/ is pruned)`)}`);
    }
    return out;
  };
  // The run's one agents block, named again where each other harness's row
  // would have been (contract 7; the story "One run plans the agents block
  // once…", rule 1): in that harness's group, before its first item at or
  // after the recorded index, else at the group's end. Not a step and not an
  // item: nothing is planned there.
  const sameBlock = () =>
    `  ${paint("explanation", glyph("skip"))} ${p.sharedBlock.file} ${glyph("dash")} the same block as ${p.sharedBlock.display}, above`;
  const hostLines = (h) => {
    const from = h.entry ? `from the registration ${h.entry}` : "from the host's own plugin system";
    return wrap(`${h.display} installs ${h.rows.join(", ")} itself, ${from}`, width, "    ")
      .split("\n")
      .map((l, k) =>
        k
          ? `    ${paint("explanation", l.slice(4))}`
          : `  ${paint("explanation", glyph("skip"))} ${paint("explanation", l)}`,
      );
  };
  // The VAULT group first, when setup plans one: the rows of no harness.
  const ids = [
    ...(p.items.some((i) => i.harness === null) ? [null] : []),
    ...p.harnesses,
    ...new Set(p.items.map((i) => i.harness).filter((h) => h !== null && !p.harnesses.includes(h))),
  ];
  for (const id of ids) {
    const entries = p.items.map((i, at) => ({ i, at })).filter((e) => e.i.harness === id);
    const others = (p.sharedBlock?.others || []).filter((o) => o.harness === id).sort((a, b) => a.at - b.at);
    const host = (p.hostManaged || []).filter((h) => h.harness === id);
    if (!entries.length && !others.length && !host.length) continue;
    const folded = verbose ? [] : entries.filter((e) => isUnsupported(e.i));
    // A registration this run fetched from another registry keeps its row, so
    // the registry lines beneath it show on every run, not only on a change.
    const quiet = verbose ? [] : entries.filter((e) => isQuiet(e.i) && !fetchedFor(p, e.i));
    const shown = entries.filter((e) => !folded.includes(e) && !quiet.includes(e));
    const specs = shown.map(({ i }) => ({
      glyph: glyphName(i),
      role: WORD_ROLE[actionWord(i)],
      action: actionWord(i),
      target: rowTarget(p, i, home),
      note: rowNote(i, { verbose, glyph }),
    }));
    if (quiet.length)
      specs.push({
        glyph: "unchanged",
        role: "explanation",
        action: "unchanged",
        target: paint("explanation", quiet.map((e) => surfaceWords(e.i.surface)).join(", ")),
      });
    // Unsupported rows keep one line per harness (contract 18), named in
    // words as the unchanged line names its rows; --verbose lists each with
    // the manifest's reason.
    if (folded.length)
      specs.push({
        glyph: "unchanged",
        role: "explanation",
        action: "skipped",
        target: paint(
          "explanation",
          `not on ${displayName(id)}: ${folded.map((e) => surfaceWords(e.i.surface)).join(", ")}`,
        ),
        note: "--verbose says why",
      });
    const drawn = rowLines(c, specs);
    lines.push("", paint("emphasis", id === null ? VAULT_GROUP : displayName(id)));
    const pending = [...others];
    shown.forEach(({ i, at }, k) => {
      while (pending.length && pending[0].at <= at) {
        pending.shift();
        lines.push(sameBlock());
      }
      lines.push(...drawn[k], ...beneath(i));
    });
    for (const _ of pending) lines.push(sameBlock());
    for (const extra of drawn.slice(shown.length)) lines.push(...extra);
    for (const h of host) lines.push(...hostLines(h));
  }
  if (p.refusals.length) lines.push("");
  // A plan-level refusal: its message in the attention role, as an item's
  // refusal reason is (presentation spec contract 3 as amended 2026-10-11).
  p.refusals.forEach((r, k) => {
    const lead = `  ${paint("attention", glyph("refuse"))} ${paint("attention", "refused")}  `;
    const pad = " ".repeat(plain(lead).length);
    // The stop (the converge story's rule 6) carries its commands apart from
    // its words: each is printed alone on its line after a blank one, with
    // nothing after it (contract 6), the way a person copies it.
    const stop = k === 0 && p.stop ? p.stop : null;
    // The same for a refusal that names its ways out (the channel "git" with
    // nothing to keep): its prose, then each lead and its command alone.
    const advice = k === 0 && !stop && p.refusalAdvice ? p.refusalAdvice : null;
    const [first, ...rest] = wrap(stop ? stop.lead : advice ? advice.text : r, width, pad).split("\n");
    lines.push(lead + paint("attention", first), ...rest.map((l) => pad + paint("attention", l.slice(pad.length))));
    if (stop)
      lines.push(
        ...commandBlock(c, [stop.commands[0]], { indent: 4 }),
        "",
        ...prose("  ", stop.between),
        ...commandBlock(c, stop.commands.slice(1), { indent: 4 }),
      );
    if (advice)
      for (const b of advice.blocks)
        lines.push("", ...prose("  ", b.lead), ...commandBlock(c, [b.command], { indent: 4 }));
  });
  // The closing lines, in a person's words: only what is listed is written,
  // and a $ line is the host's own CLI at work.
  const closing = [];
  if (p.ok && writes.length)
    closing.push(
      ...prose(
        "  ",
        `Only the entries listed above are written ${glyph("dash")} nothing else in those files is read, rewritten or removed.`,
      ),
    );
  if (p.items.some((i) => (i.steps || []).some((s) => s.kind === "host" && s.name !== "keep")))
    closing.push(
      ...prose("  ", "Each $ line runs the host's own CLI, which writes the host-owned files named after it."),
    );
  if (p.items.some((i) => isWrite(i) && (i.steps || []).some((s) => s.kind === "host" && s.name === "keep")))
    closing.push(
      ...prose(
        "  ",
        "The kept copy's $ line runs that copy's own projectstore, which writes the files named after it.",
      ),
    );
  if (closing.length) lines.push("", ...closing);
  if (!p.ok) lines.push("", `  ${paint("attention", "Nothing will be written: resolve the refusals above first.")}`);
  // A plan that wrote nothing because part of it could not be planned never
  // reads as converged (the converge story's keep, a copy with work pending).
  else if (!writes.length)
    lines.push(
      "",
      p.incomplete
        ? "  Nothing will be written: one surface could not be planned (see above)."
        : "  Nothing to change.",
    );
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
  if (envFlag(env, "CI")) return false;
  // A host session's own tool may run us in a pseudo-terminal; the manifests'
  // session markers say when that is happening — every manifest's, not only
  // the planned harness's: a Claude Code agent running the Codex shell is
  // still an agent. (Codex's own markers are unmeasured; for it the TTY test
  // above carries the rule.)
  if ([...loadHarnesses().values()].some((m) => insideHostSession(env, m))) return false;
  return true;
}

// Will this run ask? The gate's own test, shared with the shell fetch's
// decision so a run is fetched for exactly when it can be asked: passing
// `ask` means "this is a terminal" (the tests' TTY double).
export function asksAtTerminal({ stdin = null, stdout = null, ask = null, env = process.env, json = false } = {}) {
  return !json && (ask ? true : isInteractive({ stdin, stdout, env, json }));
}

// Streams and `ask` are parameters so the terminal branch is testable without
// a pseudo-terminal; passing `ask` means "this is a terminal". Without streams
// the library never asks — the bin and main() pass theirs. `caps` is the
// asking stream's (colour and glyphs), read from `stdout` when not given;
// with neither, the question is unpainted, in Unicode.
//
// One answer more (the converge story's rule 2): a channel switch planned
// under no channel answer is the ADR's choice made at a terminal — asked
// there, previewed, never silent. Without one, naming the harness does not
// confirm it, a bare run is refused for it too, and nothing is written:
// `channel`, ahead of the whole non-interactive branch. A plan built without
// plan() (no `channel` on it) reads as no answer.
export const switchUnanswered = (p) => (p.channel ?? null) === null && p.items.some(isSwitch);
export async function confirm(
  p,
  {
    stdin = null,
    stdout = null,
    ask = null,
    env = process.env,
    json = false,
    caps = stdout ? termCaps(stdout, env) : null,
  } = {},
) {
  if (!p.ok) return { confirmed: false, why: "refused" };
  const writes = p.items.filter(isWrite);
  if (!writes.length) return { confirmed: false, why: "nothing-to-do" };
  const interactive = asksAtTerminal({ stdin, stdout, ask, env, json });
  if (!interactive && switchUnanswered(p)) return { confirmed: false, why: "channel" };
  if (!interactive) return p.named ? { confirmed: true, why: "named" } : { confirmed: false, why: "non-tty" };
  // The question's bytes and its answer rule are term.mjs's, shared with
  // `scaffold --write`; the refused / nothing / named branches above stay here.
  return (await askApply(writes.length, { stdin, stdout, ask, ...(caps ? { caps } : {}) }))
    ? { confirmed: true, why: "answered" }
    : { confirmed: false, why: "declined" };
}

// ─── apply ─────────────────────────────────────────────────────────────

export function apply(
  p,
  { env = process.env, spawn = spawnSync, home = homedir(), onItem = null, onStep = null } = {},
) {
  if (!p.ok) throw new Error("apply: the plan carries refusals; nothing is written");
  const done = [];
  let registrationFailed = false;
  let layoutFailed = false;
  // Per harness: whether its registration applied without failure, and each
  // switch's outcome — what the order rule and the mark read.
  const registered = new Map();
  const switched = new Map();
  // One item's writes, returning the record apply reports for it. The order
  // and the failure rules are the loop's; onItem only watches (contract 18).
  const one = (i) => {
    if (i.kind === "layout") {
      const r = applyLayout(p, i, { failed: layoutFailed || registrationFailed || Boolean(done.failed), home, onStep });
      if (r.failed) {
        done.failed = r.failed;
        layoutFailed = true;
      }
      return r;
    }
    if (i.kind === "registration" && isSwitch(i)) {
      // The order (the converge story's rule 2): a switch applies only when
      // this run's registration for the same harness is current, or applied
      // without failure. Turning the copy off after a failed registration left
      // the checkout loading no copy at all (measured on 0.29.2).
      const reg = p.items.find(
        (x) => x.harness === i.harness && x.kind === "registration" && !String(x.surface).endsWith("_others"),
      );
      const ready = Boolean(reg) && (isWrite(reg) ? registered.get(i.harness) === true : reg.state === "current");
      if (!ready) {
        if (!switched.has(i.harness)) switched.set(i.harness, []);
        switched.get(i.harness).push(false);
        return {
          path: i.path,
          action: "skipped",
          surface: i.surface,
          reason: `the npm registration did not complete; ${i.entry} stays on for this checkout`,
        };
      }
      const r = applyRegistration(p, i, { env, spawn, home, onStep });
      if (r.failed) {
        done.failed = r.failed;
        registrationFailed = true;
      }
      if (!switched.has(i.harness)) switched.set(i.harness, []);
      switched.get(i.harness).push(!r.failed);
      return r;
    }
    if (i.kind === "registration") {
      const r = applyRegistration(p, i, { env, spawn, home, onStep });
      // A registration that did not complete leaves the surfaces planned against
      // its install path unwritten: a launcher pointing at nothing is worse than
      // none. Surfaces rendered from the package root (the block) still apply.
      if (r.failed) {
        done.failed = r.failed;
        registrationFailed = true;
      }
      registered.set(i.harness, !r.failed);
      return r;
    }
    if (i.kind === "binding") {
      const r = applyBinding(p, i, { env, onStep, switched: switched.get(i.harness) || [] });
      if (r.failed) done.failed = r.failed;
      return r;
    }
    if (i.kind === "vault") {
      // Setup's vault (rule 10): its git runs through the caller's own spawn,
      // never the APPLY reporter's wrapper — the vault reports its $ line as
      // its own step, and a failed git init as ▲, not as a stop.
      const r = applyVault(p, i, { env, spawn: spawn.unwrapped || spawn, onStep });
      if (r.failed) done.failed = r.failed;
      if (r.warning) (done.warnings ||= []).push(r.warning);
      return r;
    }
    if (i.kind === "state") {
      // Setup's state directory: state/ with its .gitignore, then <id>/, empty.
      ensureStateRoot(p.projectDir);
      mkdirSync(i.path, { recursive: true });
      return { path: i.path, action: i.action, surface: i.surface };
    }
    if (i.kind === "channel") {
      // The keep (the converge story's rule 5): the kept copy's own upgrade.
      // A run it left incomplete makes this one incomplete; it is not a stop.
      const r = applyKeep(p, i, { env, spawn, home, onStep });
      if (r.failed) done.failed = r.failed;
      if (r.incomplete) done.incomplete = true;
      return r;
    }
    if (registrationFailed && i.plannedAgainst)
      return {
        path: i.path,
        action: "skipped",
        surface: i.surface,
        reason: "the registration did not complete; this surface was planned against its install path",
      };
    if (i.kind === "shared" && typeof i.after === "object" && i.after !== null && !Array.isArray(i.after)) {
      mkdirSync(dirname(i.path), { recursive: true });
      // Re-read at write time: a host command run earlier in this apply (the
      // registration's) may have added sibling keys since plan() read the file.
      // Our entry is set or deleted on the file as it stands; nothing else moves.
      let now;
      try {
        now = JSON.parse(readFileSync(i.path, "utf8"));
      } catch {
        now = null;
      }
      let merged = i.after;
      if (now && typeof now === "object" && !Array.isArray(now) && i.entry) {
        merged = { ...now };
        if (i.action === "remove") delete merged[i.entry];
        else merged[i.entry] = i.after[i.entry];
      }
      writeFileAtomic(i.path, JSON.stringify(merged, null, 2) + "\n", { sweep: false });
    } else if ((i.action === "remove" || i.action === "prune") && i.kind === "exclusive") {
      try {
        unlinkSync(i.path);
      } catch {}
      pruneEmptyDir(dirname(i.path), p.projectDir);
    } else if (i.action === "remove" && i.kind === "shared" && typeof i.after === "string") {
      if (i.deleteIfEmpty && !i.after.trim()) {
        try {
          unlinkSync(i.path);
        } catch {}
      } else writeFileAtomic(i.path, i.after, { sweep: false });
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
    try {
      r = one(i);
    } catch (e) {
      if (onItem) onItem(i, "abort");
      throw e;
    }
    done.push(r);
    if (onItem) onItem(i, "end", r);
    // A vault item that failed stops the run (the setup story, rule 10):
    // every item after it was planned for a project with that binding.
    if (i.kind === "vault" && r.failed) break;
  }
  return done;
}

// Setup's vault item, at apply (the story's rule 10): the binding plan
// re-checked against the files as they stand — a binding that appeared, or a
// vault that is no longer missing or empty, fails the item with nothing
// written — then binding.mjs's applyBind once, which makes the directory,
// writes the binding, runs `git init` and the scaffold, and reports each step
// through `onStep`. A failed git init is a warning on the record, never a
// stop; a failed write or scaffold is the item's failure, and STOPPED names
// the scaffold's remedy. The record carries bindResult for the envelope.
function applyVault(p, i, { env, spawn, onStep = null }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const bp = i.bind;
  if (!bp) {
    out.failed = {
      step: "vault",
      status: null,
      stderr: "this vault row carries no binding plan, so nothing is written",
    };
    return out;
  }
  const changed = recheckBind(bp, { env });
  if (changed) {
    out.failed = {
      step: "vault",
      status: null,
      stderr: `${changed}; nothing is written. Run setup again: its plan starts from what is on disk now`,
    };
    return out;
  }
  const watch = (st, phase, r) => {
    if (phase === "end")
      out.steps.push({
        kind: st.kind,
        path: st.path,
        ok: Boolean(r && r.ok),
        ...(r && r.kept ? { kept: true } : {}),
        ...(r && r.warn ? { warn: r.warn } : {}),
      });
    if (onStep) onStep(st, phase, r);
  };
  let done;
  try {
    done = applyBind(bp, { spawn, env, onStep: watch });
  } catch (e) {
    out.failed = { step: "vault", status: null, stderr: e && e.message ? e.message : String(e) };
    return out;
  }
  out.bind = bindResult(bp, done);
  const g = done.git;
  if (g && g.failed) out.warning = { step: "git-init", path: bp.vault, message: g.failed, remedy: g.remedy };
  const s = done.scaffold;
  if (s && s.failed) out.failed = { step: "scaffold", status: null, stderr: `${s.failed}\n${s.remedy}` };
  return out;
}

// The mark (the converge story's rule 2), at apply: the binding is the one
// configPath resolves now — after the layout item moved it, or a bind wrote it
// — and must be the one the preview named; a mark is never written to a file
// the preview did not name, so a legacy binding is never re-created. Skipped,
// with the reason, when no binding exists, when a switch it records was
// skipped or failed in this run, or when a mark is already there. Every other
// key of the binding is kept.
//
// The same for every `binding` item (the setup story, rule 10): its keys
// merged into the binding as it stands at that moment, in one write — a
// stamped key set unless a stamp is already there, a value set at its dotted
// path (a `statusline` object keeps its other keys), a key removed — and
// skipped with the item's own words when no binding exists (a vault item that
// failed), when it is not where the preview named it, or when it already says
// all of it. Only the mark waits on the switches of its harness. The steps
// are reported one by one, the write under the first.
function applyBinding(p, i, { env, onStep = null, switched = [] }) {
  const out = { path: i.path, action: i.action, surface: i.surface };
  const said = i.said || {};
  const skipped = (reason) => ({ ...out, action: "skipped", reason });
  if (i.surface === CHANNEL_SWITCH_KEY && switched.some((ok) => !ok))
    return skipped("the switch did not complete; nothing is recorded");
  const at = configPath(p.projectDir, env);
  if (!existsSync(at)) return skipped(said.unbound || "the project is not bound; nothing is recorded");
  if (resolve(at) !== resolve(i.path))
    return skipped(`the binding is at ${at}, not where the plan named it; nothing is recorded`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(at, "utf8"));
  } catch {
    cfg = null;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
    return skipped(`${at} is not a JSON object; ${said.object || "nothing is recorded"}`);
  const steps = i.steps || [];
  // A plan whose items were copied lost the data kept off the envelope: the
  // steps say the same.
  const set =
    i.set ||
    Object.fromEntries(
      steps
        .filter((st) => st.kind === "mark" || st.kind === "set")
        .map((st) => [st.key, st.kind === "mark" ? STAMP : st.value]),
    );
  const unset = i.unset || steps.filter((st) => st.kind === "unmark").map((st) => st.key);
  const next = JSON.parse(JSON.stringify(cfg));
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(set)) {
    if (value === STAMP) {
      if (!stamped(next[key])) next[key] = { by: "setup", at: now };
      continue;
    }
    const parts = key.split(".");
    let node = next;
    for (const k of parts.slice(0, -1)) {
      if (!node[k] || typeof node[k] !== "object" || Array.isArray(node[k])) node[k] = {};
      node = node[k];
    }
    node[parts[parts.length - 1]] = value;
  }
  for (const key of unset) {
    const parts = key.split(".");
    let node = next;
    for (const k of parts.slice(0, -1)) node = node && typeof node === "object" ? node[k] : null;
    if (node && typeof node === "object") delete node[parts[parts.length - 1]];
  }
  if (JSON.stringify(next) === JSON.stringify(cfg))
    return { ...out, action: "skip", reason: said.done || "the binding already says so" };
  const shown = steps.length ? steps : [{ kind: "mark", path: at, key: i.entry }];
  if (onStep) onStep(shown[0], "start");
  try {
    writeFileAtomic(at, JSON.stringify(next, null, 2) + "\n", { sweep: false });
  } catch (e) {
    if (onStep) onStep(shown[0], "end", { ok: false });
    return { ...out, failed: { step: shown[0].kind, status: null, stderr: e && e.message ? e.message : String(e) } };
  }
  if (onStep)
    shown.forEach((st, k) => {
      if (k) onStep(st, "start");
      onStep(st, "end", { ok: true });
    });
  return { ...out, steps: shown.map((st) => ({ kind: st.kind, path: at, ok: true })) };
}

// The keep step (the converge story's rule 5), at apply: the kept copy's own
// upgrade, spawned as a host command is — the project as its working
// directory, the run's environment with the copy's root as the plugin root and
// the harness home pinned, 120 s — through the caller's spawn, so APPLY prints
// its $ line. Its envelope is read: one APPLY line beneath per item the copy
// applied, the ones the preview did not list marked "(not in the preview)" —
// the copy plans afresh, and a file that changed after the question can add a
// row. STOPPED (contract 19's cause form, the argv, the status and stderr) is
// the copy's own failure, an `ok` it reports false, a gate of its that
// confirmed nothing, or no envelope to read: what it wrote is then not known.
// The copy's run left incomplete leaves this one incomplete.
function applyKeep(p, i, { env, spawn, home, onStep = null }) {
  const out = { path: i.path, action: i.action, surface: i.surface, steps: [] };
  const st = (i.steps || []).find((x) => x.kind === "host");
  const harness = loadHarness(i.harness);
  const [bin, ...argv] = st.argv;
  const r = spawn(bin, argv, {
    env: keepEnv(env, { harness, projectDir: p.projectDir, copyRoot: i.path, harnessHome: i.home || claudeHome(home) }),
    cwd: p.projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HOST_BUDGET_MS,
    maxBuffer: 1 << 26,
  });
  const status = r.status ?? null;
  const stderr = String(r.stderr || "").trim();
  const result = keepResult(r.stdout);
  const stop = (said) => {
    out.steps.push({ kind: "host", argv: st.argv, status, ok: false, stderr: said });
    out.failed = { step: "keep", status, stderr: said, argv: st.argv };
    // How it ended, for STOPPED, as a host command's (not enumerable).
    Object.defineProperty(out.failed, "couldNotStart", {
      value: Boolean(r.error) && !r.signal && status === null,
      enumerable: false,
    });
    Object.defineProperty(out.failed, "signal", { value: r.signal || null, enumerable: false });
    return out;
  };
  if (r.error && !result) return stop(startFailure(r.error, { bin, resolved: bin, cwd: p.projectDir }));
  if (!result)
    return stop(
      [
        stderr,
        `${i.entry} printed no result to read, so what it wrote is not known; its own plan starts from what is on disk now`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  // What the copy applied, beneath its $ line — even when it then stopped.
  const listed = new Set((st.touches || []).map((t) => `${t.surface}\n${t.path}`));
  const applied = Array.isArray(result.applied)
    ? result.applied.filter((x) => x && typeof x === "object" && !["skip", "skipped"].includes(x.action))
    : [];
  const kept = [];
  for (const rec of applied) {
    const sub = {
      kind: "kept",
      surface: rec.surface ?? null,
      action: rec.action ?? null,
      path: rec.path ?? null,
      ...(listed.has(`${rec.surface}\n${rec.path}`) ? {} : { unplanned: true }),
    };
    if (onStep) {
      onStep(sub, "start");
      onStep(sub, "end", { ok: !rec.failed });
    }
    kept.push({ ...sub, ok: !rec.failed });
  }
  const gate = result.gate && typeof result.gate === "object" ? result.gate : null;
  const said = [];
  if (result.failed && typeof result.failed === "object") {
    const f = result.failed;
    said.push(
      `${i.entry} stopped at ${f.step || "a step"}${f.status !== null && f.status !== undefined ? ` (exit ${f.status})` : ""}${Array.isArray(f.argv) ? `: $ ${f.argv.join(" ")}` : ""}`,
      ...String(f.stderr || "")
        .split("\n")
        .filter(Boolean),
    );
  } else if (result.ok === false) said.push(`${i.entry} reported that its run did not succeed`);
  else if (gate && gate.confirmed !== true && gate.why !== "nothing-to-do")
    said.push(`${i.entry} wrote nothing: its own gate answered ${gate.why || "no"}`);
  if (said.length) {
    for (const x of Array.isArray(result.refusals) ? result.refusals : []) said.push(String(x));
    const back = stop([stderr, ...said].filter(Boolean).join("\n"));
    back.steps.push(...kept);
    return back;
  }
  out.steps.push({ kind: "host", argv: st.argv, status, ok: true }, ...kept);
  if (!applied.length) {
    out.action = "skip";
    out.reason = `${i.entry} found nothing to change`;
  }
  if (result.incomplete === true) out.incomplete = true;
  return out;
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
    if (lock !== null) {
      try {
        closeSync(lock);
      } catch {}
      lock = null;
    }
    if (lockPath) {
      try {
        unlinkSync(lockPath);
      } catch {}
      lockPath = null;
    }
  };
  // What the plan analysed with (planPortableRegistration's private record):
  // the recheck and the read-back below re-analyse with exactly these — the
  // fetched payload's root, or the version a version-only row was read at.
  const analysed = {
    root: p.root,
    payloadRoot: i.analysed?.payloadRoot || null,
    version: i.analysed?.version || null,
    home,
    harness,
    env: childEnv,
    ignoreJournal: true,
  };
  const readHostList = () => {
    const argv = s.cli.commands.list || [];
    const bin = whichOnPathFromLib(s.cli.bin, env);
    const r = spawn(bin || s.cli.bin, argv, {
      env: childEnv,
      cwd: p.projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HOST_BUDGET_MS,
    });
    const rows = !r.error && r.status === 0 ? portableListFacts(r.stdout) : null;
    out.steps.push({
      kind: "portable-recovery-list",
      argv: [s.cli.bin, ...argv],
      status: r.status ?? null,
      ok: Boolean(rows),
    });
    return {
      rows,
      stderr: r.error
        ? startFailure(r.error, { bin: s.cli.bin, resolved: bin, cwd: p.projectDir })
        : String(r.stderr || "").trim(),
    };
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
    try {
      owned = JSON.parse(readFileSync(join(target, s.ownership_manifest), "utf8"))?.[s.provenance_key] || null;
    } catch {}
    return (
      owned?.version === expected.version &&
      owned?.digest?.sha256 === expected.digest.sha256 &&
      owned?.digest?.count === expected.digest.count
    );
  };
  const verifyPrevious = (previous) => {
    const listed = readHostList();
    if (!listed.rows)
      return { ok: false, unanswered: true, why: listed.stderr || "Codex plugin list did not return JSON" };
    const row = listed.rows.find((entry) => entry?.pluginId === i.entry) || null;
    if (!previous) {
      const a = analysePortableRegistration(p.projectDir, s, {
        root: p.root,
        home,
        harness,
        env: childEnv,
        ignoreJournal: true,
      });
      const cacheRoot = join(
        i.home,
        ...(s.registry.cache_dir || ["plugins", "cache"]),
        s.marketplace_name,
        s.plugin_name,
      );
      let cached = [];
      try {
        cached = readdirSync(cacheRoot);
      } catch {}
      if (existsSync(i.path))
        return { ok: false, why: `first-install rollback left the stable marketplace source at ${i.path}` };
      if (a.market)
        return {
          ok: false,
          why: `first-install rollback left marketplace ${s.marketplace_name} in ${a.paths.globalConfig}`,
        };
      if (a.globalPlugin || a.projectPlugin)
        return { ok: false, why: `first-install rollback left plugin enablement for ${i.entry}` };
      if (row) return { ok: false, why: `${i.entry} remains host-reported after first-install rollback` };
      if (cached.length)
        return {
          ok: false,
          why: `first-install rollback left ${cached.length} materialised cache version(s) under ${cacheRoot}`,
        };
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
    const hostOk =
      row &&
      row.version === previous.version &&
      row.installed === true &&
      row.enabled === previous.enabled &&
      resolve(row.marketplaceSource?.source || "") === resolve(i.path);
    const ok =
      a.state === "current" &&
      a.installedVersion === previous.version &&
      a.enabled === previous.enabled &&
      sourceOk &&
      cacheOk &&
      hostOk;
    return ok
      ? { ok: true }
      : {
          ok: false,
          why: `restored source/cache/enablement could not be proven (state=${a.state}, version=${a.installedVersion || "?"}, enabled=${String(a.enabled)})`,
        };
  };
  // A journal keeps its history (issue #28): the first failure's error and
  // time stay as written; a later run that re-checks and still cannot prove
  // the previous state adds its own reason and time beside them. The message
  // says the error is a previous run's, where the journal is, and what lifts it.
  const requireRecovery = (journal, why) => {
    const now = new Date().toISOString();
    const again = journal.phase === "recovery-required";
    const record = again
      ? { ...journal, rechecked_at: now, recheck_error: why }
      : { ...journal, phase: "recovery-required", error: why, failed_at: now };
    writeFileAtomic(journalPath, JSON.stringify(record, null, 2) + "\n", { sweep: false });
    releaseLock();
    out.failed = {
      step: "recovery-required",
      status: null,
      stderr: again
        ? `a previous run (${journal.failed_at || "time not recorded"}) could not prove its restore: ${String(journal.error || "no error recorded").split("\n")[0]}. This run re-checked the previous state and could not prove it either: ${why}. ${journalPath} is kept: a later run lifts it once the previous state proves, or inspect the registration and remove the journal to start over`
        : `${why}; ${journalPath} was retained and blocks automatic mutation until a later run proves the previous state`,
    };
    return out;
  };
  // A staging step with no payload is a dry run's row (a fetch the run never
  // made); it is refused before the lock, with nothing staged or spawned.
  if (portable && (i.steps || []).some((st) => st.kind === "portable-write" && !st.from)) {
    out.failed = {
      step: "portable-write",
      status: null,
      stderr: `${i.entry}: this row was planned without ${harness.display_name}'s payload — its shell was not fetched — so there is nothing to stage; nothing is written. Run install or upgrade from a terminal, where the shell is fetched`,
    };
    return out;
  }
  if (portable) {
    const lockDir = join(i.home, "projectstore");
    mkdirSync(lockDir, { recursive: true });
    lockPath = join(lockDir, `${s.marketplace_name}.lock`);
    const acquire = () => {
      try {
        lock = openSync(lockPath, "wx", 0o600);
        return true;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        let owner = null;
        try {
          owner = JSON.parse(readFileSync(lockPath, "utf8"));
        } catch {}
        let dead = false;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (probe) {
            dead = probe?.code === "ESRCH";
          }
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
        out.failed = {
          step: "lock",
          status: null,
          stderr: `${lockPath} is held by a live or unidentifiable owner; another ProjectStore registration may be running. Inspect the lock before removing it`,
        };
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
      try {
        journal = JSON.parse(readFileSync(journalPath, "utf8"));
      } catch {
        releaseLock();
        out.failed = {
          step: "recovery",
          status: null,
          stderr: `${journalPath} is not valid JSON; inspect it before retrying`,
        };
        return out;
      }
      const ownedPath = (value) =>
        typeof value === "string" && (resolve(value) === resolve(i.path) || inside(resolve(value), resolve(i.home)));
      if (
        !journal ||
        resolve(journal.target || "") !== resolve(i.path) ||
        !ownedPath(journal.stage) ||
        (journal.backup && !ownedPath(journal.backup))
      ) {
        releaseLock();
        out.failed = {
          step: "recovery",
          status: null,
          stderr: `${journalPath} does not describe this owned marketplace; inspect it before retrying`,
        };
        return out;
      }
      try {
        // A recovery the rollback could not prove is re-proved here, under the
        // lock, with the rollback's own checks: it lifts when they hold, and is
        // refused with its history kept when they do not (the install spec's
        // 2026-09-29 amendment, as amended 2026-10-05).
        let lifted = null;
        if (journal.phase === "recovery-required") {
          const proven = verifyPrevious(journal.previous || null);
          // A host that cannot answer the proof's read-back is the case issue
          // #28 met with a journal still in place: say what to do about it.
          if (!proven.ok)
            return requireRecovery(
              journal,
              proven.unanswered
                ? `${proven.why}\nThe re-check could not ask ${harness.display_name || s.cli.bin} (\`${[s.cli.bin, ...(s.cli.commands.list || [])].join(" ")}\`); if it is too old to answer, upgrade it, then run this again.`
                : proven.why,
            );
          lifted = journal;
        } else if (journal.phase === "verified") finishPortableMarketplace(journal.target, journal.backup || null);
        else if (
          journal.phase === "swapped" ||
          (journal.phase === "prepare" && journal.backup && existsSync(journal.backup))
        )
          rollbackPortableMarketplace(journal.target, journal.backup || null);
        else if (journal.phase === "prepare" && !journal.previous && existsSync(journal.target)) {
          if (!ownedTargetMatches(journal.target, journal.next))
            return requireRecovery(journal, `first-install recovery found an unrecognised target at ${journal.target}`);
          rollbackPortableMarketplace(journal.target, null);
        }
        if (existsSync(journal.stage) && resolve(journal.stage) !== resolve(i.path))
          removeTreeUnder(journal.stage, i.home);
        if (journal.phase !== "verified" && !lifted) {
          const restored = verifyPrevious(journal.previous || null);
          if (!restored.ok) return requireRecovery(journal, restored.why);
        }
        unlinkSync(journalPath);
        out.steps.push({
          kind: "portable-recover",
          phase: journal.phase || "unknown",
          ok: true,
          ...(lifted ? { lifted: lifted.error || null, failed_at: lifted.failed_at || null } : {}),
        });
        // Only a lifted recovery prints a line of its own: the other phases'
        // APPLY reads as it did. After the proof, whose host list has its line.
        if (lifted && onStep) {
          const st = { kind: "recover", path: journalPath, lifted: lifted.error || "" };
          onStep(st, "start");
          onStep(st, "end", { ok: true });
        }
      } catch (e) {
        releaseLock();
        out.failed = {
          step: "recovery",
          status: null,
          stderr: `${e && e.message ? e.message : String(e)}; ${journalPath} is kept: a later run retries it, or inspect the registration and remove the journal to start over`,
        };
        return out;
      }
    }
    const current = analysePortableRegistration(p.projectDir, s, analysed);
    const desiredCurrent =
      current.state === "current" &&
      current.desiredVersion === i.verify?.version &&
      current.desiredDigest?.sha256 === i.verify?.digest?.sha256 &&
      current.desiredDigest?.count === i.verify?.digest?.count;
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
    const desiredChanged =
      i.action !== "remove" &&
      (current.desiredVersion !== i.verify?.version ||
        current.desiredDigest?.sha256 !== i.verify?.digest?.sha256 ||
        current.desiredDigest?.count !== i.verify?.digest?.count);
    if (
      ["foreign", "conflict", "unavailable"].includes(current.state) ||
      desiredChanged ||
      !sameObserved(observedPortable(current), i.observed)
    ) {
      releaseLock();
      out.failed = {
        step: "recheck",
        status: null,
        stderr:
          current.refusal ||
          current.reason ||
          "the portable registration changed after preview; re-run the command to produce a fresh plan",
      };
      return out;
    }
  }
  const fail = (step, status, stderr, argv = null, ended = null) => {
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
          const r = spawn(bin || s.cli.bin, args, {
            env: childEnv,
            cwd: p.projectDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: HOST_BUDGET_MS,
          });
          const ok = !r.error && r.status === 0;
          out.steps.push({
            kind: "portable-compensate",
            name,
            argv: [s.cli.bin, ...args],
            status: r.status ?? null,
            ok,
            ...(ok
              ? {}
              : {
                  stderr: r.error
                    ? startFailure(r.error, { bin: s.cli.bin, resolved: bin, cwd: p.projectDir })
                    : String((r.stderr || "") + (r.stdout || "")).trim(),
                }),
          });
        }
      }
      try {
        rollbackPortableMarketplace(staged.dir, staged.backup);
        out.steps.push({ kind: "portable-rollback", path: staged.dir, ok: true });
        const restored = verifyPrevious(staged.previous || null);
        if (!restored.ok) {
          return requireRecovery(
            {
              version: 1,
              target: staged.dir,
              stage: `${staged.dir}.none`,
              backup: null,
              previous: staged.previous || null,
            },
            restored.why,
          );
        }
        if (staged.journal) {
          try {
            unlinkSync(staged.journal);
          } catch {}
        }
      } catch (e) {
        out.steps.push({ kind: "portable-rollback", path: staged.dir, ok: false, stderr: e.message });
        return requireRecovery(
          {
            version: 1,
            target: staged.dir,
            stage: `${staged.dir}.none`,
            backup: staged.backup,
            previous: staged.previous || null,
          },
          `rollback failed: ${e.message}`,
        );
      }
      staged = null;
    }
    out.failed = { step, status, stderr, ...(argv ? { argv } : {}) };
    // How a host command ended, for STOPPED (presentation spec contract 8):
    // whether it could start at all, and the signal that stopped one that
    // did. Not enumerable, so the --json envelope keeps the record's shape.
    if (ended) {
      Object.defineProperty(out.failed, "couldNotStart", { value: Boolean(ended.couldNotStart), enumerable: false });
      Object.defineProperty(out.failed, "signal", { value: ended.signal || null, enumerable: false });
    }
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
          const before = analysePortableRegistration(p.projectDir, s, {
            root: p.root,
            payloadRoot: join(st.path, st.subdir),
            home,
            harness,
            env: childEnv,
            ignoreJournal: true,
          });
          if (before.ownership?.version && before.ownership?.digest)
            previous = { version: before.ownership.version, digest: before.ownership.digest, enabled: before.enabled };
        }
        const next = { version: i.verify?.version || null, digest: i.verify?.digest || null };
        writeFileAtomic(
          journalPath,
          JSON.stringify({ version: 1, phase: "prepare", target: st.path, stage, backup, previous, next }, null, 2) +
            "\n",
          { sweep: false },
        );
        const result = stagePortableMarketplace(st.path, {
          from: st.from,
          files: st.files,
          subdir: st.subdir,
          catalogRel: st.catalogRel,
          catalog: st.catalog,
          ownershipRel: st.ownershipRel,
          ownership: st.ownership,
          homeBase: i.home,
          token,
        });
        writeFileAtomic(
          journalPath,
          JSON.stringify(
            {
              version: 1,
              phase: "swapped",
              target: st.path,
              stage: result.stage,
              backup: result.backup,
              previous,
              next,
            },
            null,
            2,
          ) + "\n",
          { sweep: false },
        );
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
          // The one reader of the provenance field (contract 2, amended 2026-10-10).
          try {
            ours = Boolean(registrationProvenance(JSON.parse(readFileSync(manifestPath, "utf8")), s));
          } catch {}
          if (!ours) {
            out.steps.push({ kind: "write", ok: false });
            return fail(
              "write",
              null,
              `${st.path} changed under the plan: its manifest is no longer ours; nothing is written`,
            );
          }
        }
        if (st.manifestOnly)
          writeFileAtomic(manifestPath, JSON.stringify(st.manifest, null, 2) + "\n", { sweep: false });
        else
          writeOwnTree(st.path, {
            from: p.root,
            subdir: s.plugin_subdir,
            manifestRel: s.manifest,
            manifest: st.manifest,
            home,
          });
        out.steps.push({ kind: "write", path: st.path, ok: true });
      } else if (st.kind === "unregister") {
        // Our one entry in the checkout's settings file (contract 6): the key is deleted, nothing else is touched.
        let settings = {};
        try {
          settings = JSON.parse(readFileSync(st.path, "utf8"));
        } catch {
          settings = null;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          out.steps.push({ kind: "unregister", ok: false });
          return fail("unregister", null, `${st.path} is not a JSON object; the marketplace entry was not removed`);
        }
        if (settings[st.pointer] && typeof settings[st.pointer] === "object") {
          delete settings[st.pointer][st.name];
          writeFileAtomic(st.path, JSON.stringify(settings, null, 2) + "\n", { sweep: false });
        }
        out.steps.push({ kind: "unregister", path: st.path, ok: true });
      } else if (st.kind === "unmark") {
        // The switch's record goes with the registration (the converge story's
        // rule 4): the one key, from the binding configPath resolves now; every
        // other key stays. A binding already without it is left as it is.
        const at = configPath(p.projectDir, env);
        let cfg = null;
        if (existsSync(at)) {
          try {
            cfg = JSON.parse(readFileSync(at, "utf8"));
          } catch {
            cfg = null;
          }
          if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
            out.steps.push({ kind: "unmark", ok: false });
            return fail("unmark", null, `${at} is not a JSON object; ${st.key} was not removed`);
          }
        }
        const has = Boolean(cfg) && Object.hasOwn(cfg, st.key);
        if (has) {
          delete cfg[st.key];
          writeFileAtomic(at, JSON.stringify(cfg, null, 2) + "\n", { sweep: false });
        }
        out.steps.push({ kind: "unmark", path: at, ok: true, removed: has });
      } else if (st.kind === "remove") {
        removeOwnTree(st.path, home);
        out.steps.push({ kind: "remove", path: st.path, ok: true });
      } else if (st.kind === "host") {
        const bin = whichOnPathFromLib(st.bin, env);
        const r = spawn(bin || st.bin, st.argv, {
          env: childEnv,
          cwd: p.projectDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: HOST_BUDGET_MS,
        });
        const ran = !r.error && r.status === 0;
        // A preflight that ran must also answer in the shape verification reads:
        // a host that exits 0 with text would pass on its status alone.
        const unreadable = ran && portable && st.name === "preflight" && portableListFacts(r.stdout) === null;
        const ok = ran && !unreadable;
        // A command that did not start says why (contract 19); one that ran and
        // failed says what it said. A preflight the host ran and could not
        // answer adds what that means; one that never started does not, since
        // upgrading the host would not help.
        const said = r.error
          ? startFailure(r.error, { bin: st.bin, resolved: bin, cwd: p.projectDir })
          : unreadable
            ? `${[st.bin, ...st.argv].join(" ")} answered, but not with the JSON the registration reads`
            : String((r.stderr || "") + (ok ? "" : r.stdout || "")).trim();
        const told =
          !ok && st.name === "preflight" && !r.error
            ? `${said}\nThe registration needs \`${[st.bin, ...st.argv].join(" ")}\` to verify what it installs, so it changed nothing. Upgrade ${harness.display_name || st.bin}, then run this again.`
            : said;
        out.steps.push({
          kind: "host",
          argv: [st.bin, ...st.argv],
          status: r.status ?? null,
          ok,
          ...(ok ? {} : { stderr: told }),
        });
        // An unreadable answer exited 0; STOPPED names it by what it said, as
        // the final list's own failure does, not by an "exited 0". A command
        // that could not start has an error and neither a status nor a signal
        // (ENOENT, EACCES); a timeout's error comes with the signal that
        // stopped it, so that command ran.
        const couldNotStart = Boolean(r.error) && !r.signal && (r.status === null || r.status === undefined);
        if (!ok)
          return fail(st.name, unreadable ? null : (r.status ?? null), told, [st.bin, ...st.argv], {
            couldNotStart,
            signal: r.signal || null,
          });
        if (portable && st.name === "list") {
          hostList = portableListFact(r.stdout, i.entry);
          if (!hostList)
            return fail("list", null, `${st.bin} ${st.argv.join(" ")} did not report ${i.entry} in JSON output`, [
              st.bin,
              ...st.argv,
            ]);
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
      ? analysePortableRegistration(p.projectDir, s, analysed)
      : analyseRegistration(p.projectDir, s, { root: p.root, home, harness, env });
    if (portable) {
      const sourceDigestOk =
        a.sourceDigest?.sha256 === i.verify.digest?.sha256 && a.sourceDigest?.count === i.verify.digest?.count;
      const cacheDigestOk =
        a.installed?.digest?.sha256 === i.verify.digest?.sha256 &&
        a.installed?.digest?.count === i.verify.digest?.count;
      const listed =
        hostList &&
        hostList.version === i.verify.version &&
        hostList.installed &&
        hostList.enabled &&
        resolve(hostList.marketplaceSource || "") === resolve(i.path);
      if (
        a.state !== "current" ||
        a.installedVersion !== i.verify.version ||
        !a.enabled ||
        !sourceDigestOk ||
        !cacheDigestOk ||
        !listed
      ) {
        return fail(
          "verify",
          null,
          `after Codex ran, registration is ${a.state} at ${a.installedVersion || "?"}; expected current ${i.verify.version} with digest ${i.verify.digest?.sha256 || "?"}`,
        );
      }
      out.verified = {
        installPath: a.installPath,
        version: a.installedVersion,
        sourceDigest: a.sourceDigest,
        cacheDigest: a.installed.digest,
        host: hostList,
      };
    } else if (
      !a.installPath ||
      resolve(a.installPath) !== resolve(i.verify.installPath) ||
      a.installedVersion !== i.verify.version
    ) {
      return fail(
        "verify",
        null,
        `after the host ran, its registry records ${a.installPath || "no install"} at ${a.installedVersion || "?"} for this checkout; the plan rendered the other surfaces against ${i.verify.installPath} at ${i.verify.version} — they are not written`,
      );
    } else {
      out.verified = { installPath: a.installPath, version: a.installedVersion };
    }
  }
  try {
    if (staged) {
      writeFileAtomic(
        staged.journal,
        JSON.stringify(
          {
            version: 1,
            phase: "verified",
            target: staged.dir,
            stage: `${staged.dir}.none`,
            backup: staged.backup,
            previous: staged.previous || null,
          },
          null,
          2,
        ) + "\n",
        { sweep: false },
      );
      finishPortableMarketplace(staged.dir, staged.backup);
      unlinkSync(staged.journal);
    }
  } catch (e) {
    return fail("finish", null, e && e.message ? e.message : String(e));
  }
  releaseLock();
  return out;
}

function homeEnvName(harnessId) {
  try {
    return loadHarness(harnessId).runtime.home_env;
  } catch {
    return sourceHarness().runtime.home_env;
  }
}

// startFailure — what Node cannot say about a child that did not start —
// lives in run-host.mjs, shared with the shell fetch (contract 19).

// rmdirSync refuses a non-empty directory — that refusal IS the guarantee
// (contract 13): we prune only a directory we emptied. The runtime dir's own
// .gitignore does not count as content.
function pruneEmptyDir(dir, projectDir) {
  if (!inside(dir, projectDir)) return;
  try {
    const left = readdirSync(dir).filter((n) => n !== ".gitignore");
    if (left.length) return;
    try {
      unlinkSync(join(dir, ".gitignore"));
    } catch {}
    rmdirSync(dir);
  } catch {}
}

// ─── verbs ─────────────────────────────────────────────────────────────

// What `plan` is given by both entry points (main() and the bin's
// runInstallVerb), so the two cannot drift: the root, and its version for a
// shell-rooted registration planned without its payload — the dry run.
export function planOptions(opts = {}) {
  const root = opts.root || pluginRoot();
  return { ...opts, root, version: opts.version ?? rootVersion(root) };
}

// Before plan(): the shell fetch (the shell-fetch story's rules 1–4 and 9).
// For each harness in the run's set whose registration is shell-rooted, rule
// 1 decides from the manifest, the environment, the run's root and a
// version-only analysis; a harness that passes is fetched once, verified and
// handed to plan() as payloadRoots[id]. The selection refusals (an unknown
// harness, a missing project, no harness) are plan()'s and come first: none
// of them fetches. A failed fetch is a refusal before the plan: a stub with
// plan()'s early-return keys, so every caller reads it as it reads a refused
// plan. `cleanup` removes the run's scratch — the caller calls it in a
// `finally`, after apply(), since staging copies from it; best effort, the
// next fetching run's sweep converges on whatever it leaves. Ctrl+C here is
// the terminal's SIGINT and leaves the scratch to that sweep: no listener is
// held before the plan.
//   opts.onFetch(label, ids) → a live line ({ end, abort }) or null
//   opts.fetchSpawn, opts.fetchBudget → the tests' npm and clock
//
// Before the fetch, the converge story's rules 6 and 8, in this order (its
// Technical Notes): the copies this project runs (read-only); the registry
// read — awaited when a copy is newer than this root, else started for the
// update notice and awaited after the fetch, before PLAN; the stop, which
// returns here with nothing fetched, written, locked or spawned but the
// registry resolver; the keep read, for the channel "git" (rule 5): the kept
// copy's own plan, read through its bin, and no fetch when plan() will refuse;
// then the fetch, which skips a newer registration. The user's registry
// is resolved at most once: for a read, and by every run that fetches a shell
// — which also resolves the project's, and names it in PLAN when the two
// differ (the 2026-10-09 amendment). A run that neither fetches nor reads
// resolves neither. On the notice-only path the resolver and the request
// share one 2 s bound.
//   opts.notice → the caller prints text (runVerb's `out`): the notice may show
//   opts.fetch, opts.now, opts.timers → the tests' registry read and clock
//
// `setup` prepares as install and upgrade do, its notice and its stop naming
// `setup` (the setup story, rule 3 step 7), with three inputs of its own:
//   opts.named  → whether the harnesses were named, when `harnesses` is
//                 setup's pre-ticked set and nobody named it: the fetch and
//                 the stop's command then read it as a bare run
//   opts.dryRun → --dry-run (rule 12): no registry read, so no stop and no
//                 notice, and no fetch; the kept copy's own plan, read-only,
//                 is still read, so the keep's row shows its real writes
async function prepareRun(verb, projectDir, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  const root = opts.root || pluginRoot();
  const version = rootVersion(root);
  const none = {
    version,
    payloadRoots: {},
    fetched: [],
    refused: null,
    convergence: null,
    notice: null,
    cleanup: () => {},
  };
  if (!["install", "upgrade", "setup"].includes(verb)) return none;
  projectDir = resolve(projectDir);
  // setup reads the state directory too, as upgrade does (its rule 5).
  const state = verb === "upgrade" || verb === "setup";
  const given = (opts.harnesses || []).filter(Boolean);
  const named = typeof opts.named === "boolean" ? opts.named : given.length > 0;
  const dry = Boolean(opts.dryRun);
  if (given.some((id) => !harnessIds().includes(id)) || projectDirRefusal(projectDir)) return none;
  const detected = detectHarnesses(projectDir, { state });
  const ids = given.length ? given : detected.map((d) => d.id);
  if (!ids.length) return none;
  // One version-only analysis per shell-rooted registration, shared by the
  // running copies and the fetch's decision.
  const analyses = new Map();
  const analyse = (harness, s) => {
    if (!analyses.has(harness.id))
      analyses.set(harness.id, analysePortableRegistration(projectDir, s, { root, home, harness, env, version }));
    return analyses.get(harness.id);
  };
  // 1. The user's registry: resolved once, when first needed (the 2026-10-09
  // amendment); null when npm could not say.
  let userRegistry = null;
  const userRegistryOf = (budget) =>
    (userRegistry ||= npmUserRegistry({ home, env, spawn: opts.fetchSpawn, budget }).catch(() => null));
  // The read. `shared`: the resolver and the request fit in one bound — the
  // notice-only path's 2 s; otherwise the request has its own 2 s after a
  // resolver allowed rule 6's 10 s.
  const read = (budget, { atLeast = null, shared = false } = {}) => {
    const t0 = Date.now();
    return userRegistryOf(budget)
      .then((registry) => {
        const timeoutMs = shared ? budget - (Date.now() - t0) : READ_TIMEOUT_MS;
        if (timeoutMs < 1) return { latest: null, from: null, error: `no answer within ${budget / 1000} s` };
        return readLatest({
          registry: registry || DEFAULT_REGISTRY,
          cachePath: cachePaths({ env, home }).registry,
          fetch: opts.fetch,
          now: opts.now,
          timers: opts.timers,
          atLeast,
          timeoutMs,
        });
      })
      .catch((e) => ({ latest: null, from: null, error: String(e?.message || e) }));
  };
  // 2. The copies this project runs: from a package root or a checkout only;
  // a host's copy is updated through its own channel and never stopped.
  const checks = Boolean(version) && checksRoot(root, { home, env });
  // Under the channel "git" no host plugin copy counts: the run renders
  // nothing for that harness (rule 6). "npm" and null count them alike.
  const copies = checks
    ? runningCopies(projectDir, { harnesses: ids, root, home, env, version, analyse, channel: opts.channel ?? null })
    : [];
  const newer = newerCopies(copies, version);
  const off = updateCheckOff(env);
  // The notice: text mode, from a package root, never under CI or the switch.
  const wantNotice =
    !dry &&
    Boolean(opts.notice) &&
    !opts.json &&
    Boolean(version) &&
    noticeRoot(root, { home, env }) &&
    !envFlag(env, "CI") &&
    !off;
  // 3. The read: one request per run at most, shared by rule 6 and the notice.
  // --json and CI do not switch rule 6's read off: it decides what is written.
  // A dry run reads nothing, as plan does.
  let answer = null,
    pending = null;
  if (!dry && newer.length && !off) answer = await read(REGISTRY_BUDGET_MS, { atLeast: lowestVersion(newer) });
  else if (wantNotice) pending = read(NOTICE_BUDGET_MS, { shared: true });
  // 4. The stop: nothing after it runs. A dry run decides nothing: its newer
  // rows say, as plan's do, that the registry is read first.
  const convergence = dry
    ? null
    : checks
      ? decide({
          copies,
          version,
          read: answer,
          skipped: off && newer.length > 0,
          verb,
          args: { harnesses: named ? given : [], surfaces: opts.surfaces || null, register: opts.register !== false },
        })
      : { checks: false };
  if (convergence?.stop) return { ...none, convergence };
  // 5. The keep (rule 5), for the channel "git": the copy kept, and its own
  // plan read through its bin — before the fetch, so a run plan() will refuse
  // fetches nothing: no copy to keep (rule 1), or the copy's plan refused. A
  // copy that cannot run the form, and a run narrowed by --surface, read
  // nothing; plan() says why. Inside a session the plan is read all the same.
  let keep = null,
    refuses = false;
  if ((opts.channel ?? null) === "git") {
    const target = keepTarget(projectDir, ids, { root, home, env });
    if (target && !target.copy) refuses = true;
    else if (target && !target.copy.missing && !(opts.surfaces && opts.surfaces.length)) {
      const childEnvironment = keepEnv(env, {
        harness: target.harness,
        projectDir,
        copyRoot: target.copy.path,
        harnessHome: claudeHome(home),
      });
      const read = await readKeepPlan(target.copy, {
        harness: target.harness,
        projectDir,
        env: childEnvironment,
        run: runHost,
        budget: HOST_BUDGET_MS,
      });
      keep = { copy: target.copy, read };
      if (read.envelope && !read.ok) refuses = true;
    }
  }
  // 6. The fetch — never in a dry run.
  const fetchedPart =
    refuses || dry
      ? { ...none, fetchedFrom: null }
      : await fetchShells(verb, projectDir, {
          ...opts,
          env,
          home,
          root,
          version,
          named,
          detected,
          ids,
          analyse,
          userRegistryOf,
        });
  const latest = pending ? (await pending).latest : answer?.latest;
  const notice = wantNotice ? updateNotice({ latest, version, root, verb }) : null;
  return { ...fetchedPart, convergence, notice, keep };
}

async function fetchShells(
  verb,
  projectDir,
  { env, home, root, version, named, detected, ids, analyse, userRegistryOf, ...opts },
) {
  const none = { version, payloadRoots: {}, fetched: [], refused: null, fetchedFrom: null, cleanup: () => {} };
  const interactive = asksAtTerminal({ ...opts, env });
  const ownShell = bundlingShellHarnessId({ core: root });
  const jobs = [];
  for (const id of ids) {
    const harness = loadHarness(id);
    for (const [key, s] of Object.entries(harness.surfaces || {})) {
      if (key.startsWith("_") || s.format !== "portable-plugin-registration") continue;
      const excluded = surfaceExcluded(key, s, { surfaces: opts.surfaces || null, register: opts.register });
      const analysis = excluded ? null : analyse(harness, s);
      const decision = fetchDecision({
        verb,
        harness,
        s,
        excluded,
        named,
        interactive,
        analysis,
        ownShell: ownShell === id,
        env,
      });
      if (decision.fetch) jobs.push({ harness, s });
    }
  }
  if (!jobs.length) return none;
  const refuse = (message, cleanup = () => {}) => ({
    ...none,
    cleanup,
    refused: {
      projectDir,
      mode: "install",
      named,
      detected,
      harnesses: ids,
      reports: [],
      items: [],
      refusals: [message],
      ok: false,
      incomplete: false,
      root,
      plannedAgainst: {},
    },
  });
  const cache = cachePaths({ env, home });
  if (!cache.root) return refuse(fetchRefusal("ENOCACHE", { variable: cache.variable }));
  sweepFetchRuns(cache.fetch);
  const runDir = cache.fetchRun(fetchRunId());
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (e) {
    // The root is named, not the run's own directory: that is where the user acts.
    return refuse(
      fetchRefusal("ECACHE", { path: cache.root, errno: e?.code, from: cache.from, variable: cache.variable }),
    );
  }
  const cleanup = () => {
    try {
      removeTreeUnder(runDir, cache.root, { maxRetries: 3 });
    } catch {}
  };
  const coreName = rootName(root);
  const budget = opts.fetchBudget || HOST_BUDGET_MS;
  let line = null;
  try {
    // Two resolvers, side by side: the project's registry, which the fetch
    // uses (its .npmrc counts), and the user's, which PLAN names beside it
    // when they differ — a shell from a registry the user did not choose is
    // said, never silent (the 2026-10-09 amendment).
    const [registry, user] = await Promise.all([
      npmRegistry(projectDir, { env, spawn: opts.fetchSpawn, budget: Math.min(budget, REGISTRY_BUDGET_MS) }),
      userRegistryOf(Math.min(budget, REGISTRY_BUDGET_MS)),
    ]);
    // A user read that failed means npm's default (the amendment), so a
    // project registry is still named when the user's could not be read.
    const bare = (u) => String(u || "").replace(/\/+$/, "");
    const mine = user || DEFAULT_REGISTRY;
    const differs = Boolean(registry) && bare(registry) !== bare(mine);
    const payloadRoots = {},
      fetched = [];
    for (const job of jobs) {
      const { harness } = job;
      const pkg = `${harness.install.shell}@${version}`;
      // One prefix per shell: npm prunes what a prefix holds that its own
      // install did not ask for, so a second shell would take the first away.
      const dir = jobs.length === 1 ? runDir : join(runDir, harness.id);
      if (dir !== runDir) mkdirSync(dir, { recursive: true });
      line = opts.onFetch ? opts.onFetch(`fetching ${pkg} for ${harness.display_name}`, ids) : null;
      const r = await fetchShell({ ...job, version, coreName }, { dir, registry, env, spawn: opts.fetchSpawn, budget });
      if (!r.ok) {
        if (line) line.end(false, `fetch failed ${pkg}`, r.code);
        return refuse(r.refusal, cleanup);
      }
      if (line) line.end(true, `fetched ${pkg} for ${harness.display_name}`);
      line = null;
      payloadRoots[harness.id] = r.root;
      fetched.push({ harness: harness.id, package: harness.install.shell, version, ms: r.ms });
    }
    return {
      version,
      payloadRoots,
      fetched,
      refused: null,
      fetchedFrom: differs ? { registry, user: mine, harnesses: fetched.map((f) => f.harness) } : null,
      cleanup,
    };
  } catch (e) {
    // The caller's `finally` is not reached from here: the scratch goes now.
    if (line) line.abort();
    cleanup();
    throw e;
  }
}

// `setup` runs as install does (the setup story, rule 3 steps 7 and 8), with
// its own inputs: plan()'s setup inputs pass through `opts` (vault,
// statusline, named), its state directories and the keep's record are
// planned unless `opts.ensureState` / `opts.recordKeep` say otherwise, and it
// takes no --surface (`opts.takesSurface`).
//   opts.badged → the caller printed its own head (setup's rail, `┌
//                 projectstore setup`): no badge is printed — not over the
//                 fetch line, not over the notice, not over PLAN
//   opts.dryRun → --dry-run (rule 12): PLAN, then nothing — no question, no
//                 apply; the gate reads { confirmed: false, why: "dry-run" },
//                 or confirm's "refused" for a plan that refuses
//   opts.header → lines beneath PLAN's project path (renderPreview's `header`)
//   opts.drain  → awaited right before the question, when there is one to
//                 ask: setup's rail discards what was typed ahead, so a key
//                 meant for the last rail question never answers this one
//   opts.done   → (result) → DONE's setup lines (renderDone's `extra`): built
//                 by the caller, so this file imports nothing of setup's
// The result carries `warnings`: what failed without stopping the run (a
// vault's git init).
export async function runVerb(verb, projectDir, opts = {}) {
  const mode = verb === "uninstall" ? "uninstall" : "install"; // upgrade is install re-run (contract 14); so is setup
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  // `out` is the text-mode caller's stdout. With it, this prints: the plan
  // first, then the question, then each step as it runs, then DONE. A run
  // that fetches prints its badge first, then the fetch line beneath it, then
  // the preview without the badge (presentation spec contract 7's slot).
  const out = opts.out || null;
  const c = out ? termCaps(out, env) : null;
  let badged = Boolean(opts.badged);
  const onFetch = out
    ? (label, ids) => {
        if (!badged) {
          out.write(badgeLine({ harnesses: ids, mode }, { verb, caps: c }) + "\n");
          badged = true;
        }
        return liveLine(out, c, label, { env });
      }
    : null;
  const prep = await prepareRun(verb, projectDir, { ...opts, env, onFetch, notice: Boolean(out) });
  try {
    // upgrade selects by the state directory too (rule 5), and so does a
    // project uninstall, setup's mirror: it leaves the project for every
    // harness that used it (the story "One run plans the agents block once…",
    // rule 5). `uninstall --global` keeps contract 8 — a state directory is a
    // project fact. install and plan keep contract 8, so a bare plan and a
    // bare install still agree.
    // setup selects by it too, and plans its own items (its rules 5 and 10).
    const setup = verb === "setup";
    const p =
      prep.refused ||
      plan(projectDir, {
        ...opts,
        mode,
        state: verb === "upgrade" || setup || (verb === "uninstall" && !opts.globalRemoval),
        version: prep.version,
        payloadRoots: prep.payloadRoots,
        convergence: prep.convergence,
        fetchedFrom: prep.fetchedFrom || null,
        keep: prep.keep || null,
        ensureState: opts.ensureState ?? setup,
        recordKeep: opts.recordKeep ?? setup,
        takesSurface: opts.takesSurface ?? !setup,
      });
    const view = { verbose: Boolean(opts.verbose), verb, caps: c || PLAIN, home, header: opts.header || [] };
    const preview = renderPreview(p, view);
    // The update notice (the converge story's rule 8): in the header slot,
    // under the badge and after the fetch line, before PLAN. Never beside the
    // stop, whose refusal names the update itself.
    if (out && prep.notice) {
      if (!badged) {
        out.write(badgeLine(p, { verb, caps: c }) + "\n");
        badged = true;
      }
      out.write(noticeText(prep.notice, c));
    }
    if (out) out.write((badged ? renderPreview(p, { ...view, badge: false }) : preview) + "\n");
    // A dry run ends at PLAN: nothing is asked and nothing is written. A
    // refused plan stays refused — its gate is confirm's, never the dry run's.
    if (opts.dryRun)
      return {
        verb,
        plan: p,
        preview,
        gate: { confirmed: false, why: p.ok ? "dry-run" : "refused" },
        applied: [],
        failed: null,
        warnings: [],
        elapsed: 0,
        fetched: prep.fetched,
      };
    if (typeof opts.drain === "function" && p.ok && p.items.some(isWrite) && asksAtTerminal({ ...opts, env }))
      await opts.drain();
    const gate = await confirm(p, { ...opts, env, ...(c ? { caps: c } : {}) });
    const result = {
      verb,
      plan: p,
      preview,
      gate,
      applied: [],
      failed: null,
      warnings: [],
      elapsed: 0,
      fetched: prep.fetched,
    };
    if (gate.confirmed) {
      // DONE's time leaves the fetch out: it wrote nothing of the project's.
      const t0 = Date.now();
      const reporter = out ? applyReporter(out, c, p, { home }) : null;
      const spawn = opts.spawn || spawnSync;
      result.applied = apply(p, {
        env,
        spawn: reporter ? reporter.spawn(spawn) : spawn,
        home,
        onItem: reporter ? reporter.onItem : null,
        onStep: reporter ? reporter.onStep : null,
      });
      result.failed = result.applied.failed || null;
      result.warnings = result.applied.warnings || [];
      // A kept copy's run left incomplete (the converge story's rule 5) leaves
      // this one incomplete: both entries read the plan's flag for the exit.
      if (result.applied.incomplete) p.incomplete = true;
      result.elapsed = Date.now() - t0;
      if (out)
        out.write(
          renderDone(result, {
            caps: c,
            verbose: Boolean(opts.verbose),
            cwd: opts.cwd || process.cwd(),
            extra: typeof opts.done === "function" ? opts.done(result) : null,
          }),
        );
    }
    return result;
  } finally {
    prep.cleanup();
  }
}

// APPLY, one line per step as it finishes (presentation spec contract 8):
// the glyph, what was done in the past tense — "added CLAUDE.md", having read
// "adding CLAUDE.md" while it ran on a terminal — and the duration. An item
// with steps — a registration, the layout move — prints its own line as it
// starts ("registering …"), one line per step beneath it — each host
// command, staging write, write and move — and, once all of them have run,
// its finished line in the past tense ("registered …") with the item's whole
// time, so a transcript never ends on a line that reads as still running.
// No heading: the plan's last line and the question are above it. `now` is
// the test's clock; `home` shortens paths to ~.
export function applyReporter(out, c, p, { now = Date.now, home = homedir() } = {}) {
  const paint = painter(c);
  const glyph = (name) => termIcon(c, name);
  const item = stepReporter(out, c, { indent: 2, now });
  const step = stepReporter(out, c, { indent: 6, now });
  const said = (i) => {
    const word = actionWord(i);
    const [running, done] = WORD_TENSES[word] || [word, word];
    const target = rowTarget(p, i, home);
    return { word, running: `${running} ${target}`, done: `${done} ${target}` };
  };
  // The mark too: a skip prints its reason (the project not bound, the switch
  // not done) beneath the line it started.
  // …and the keep, whose $ line and the kept copy's own items print beneath it.
  // …and setup's vault, whose binding, git and scaffold steps print beneath it.
  const stepped = (i) =>
    i.kind === "registration" ||
    i.kind === "layout" ||
    i.kind === "binding" ||
    i.kind === "channel" ||
    i.kind === "vault";
  const began = new Map();
  return {
    onItem(i, phase, r) {
      const s = said(i);
      if (stepped(i)) {
        if (phase === "start") {
          began.set(i, now());
          out.write(`  ${paint(WORD_ROLE[s.word], glyph(glyphName(i)))} ${s.running}\n`);
          return;
        }
        const t0 = began.get(i) ?? now();
        began.delete(i);
        if (phase === "abort") step.abort();
        else if (r && (r.action === "skipped" || r.action === "skip"))
          out.write(
            `      ${paint("explanation", glyph("skip"))} ${paint("explanation", `${r.action === "skip" ? "nothing to do" : "skipped"}: ${r.reason || "an earlier item failed"}`)}\n`,
          );
        else if (r && r.failed) out.write(`      ${paint("error", glyph("fail"))} ${paint("error", "stopped")}\n`);
        else item.finish(s.done, t0);
        return;
      }
      if (phase === "start") item.start(s.running);
      else if (phase === "abort") item.abort();
      else {
        // An item that failed or was skipped keeps the words it ran under.
        const failed = Boolean(r && (r.failed || r.action === "skipped"));
        item.end(!failed, r && r.action === "skipped" ? "skipped" : "", failed ? {} : { label: s.done });
      }
    },
    onStep(st, phase, r) {
      const l = stepLabel(p, st, { home, glyph });
      if (!l) return;
      if (phase === "start") {
        step.start(l.running);
        return;
      }
      const ok = r ? r.ok : true;
      const kept = Boolean(r && r.kept);
      // A step that failed without stopping the run (setup's git init) is ▲,
      // in its own words.
      if (r && r.warn) {
        step.end(true, "", { warn: true, label: r.warn });
        return;
      }
      // A step that left its target in place did not do its verb; one that
      // says why in its own words (a git init skipped) needs no note.
      const own = r && r.label ? r.label : null;
      step.end(ok, kept && !own ? "kept" : "", ok ? { kept, label: own || (kept ? l.base : l.done) } : {});
    },
    // The wrapped spawn prints each host command as a step. Its `unwrapped`
    // is the caller's own spawn, for an item that reports its commands as its
    // own steps (setup's vault: `$ git init --quiet`).
    spawn(inner) {
      const wrapped = (bin, argv, o) => {
        step.start(`$ ${basename(String(bin))} ${argv.join(" ")}`);
        let r;
        try {
          r = inner(bin, argv, o);
        } catch (e) {
          step.abort();
          throw e;
        }
        step.end(!r.error && r.status === 0);
        return r;
      };
      Object.defineProperty(wrapped, "unwrapped", { value: inner });
      return wrapped;
    },
  };
}

// A step as its APPLY line names it: the verb and the target, short — the
// full form, file counts and entry pointers, was in PLAN. `base` is the plain
// verb, for a step that left its target in place.
const STEP_TENSES = {
  stage: ["staging", "staged"],
  lift: ["lifting", "lifted"],
  write: ["writing", "wrote"],
  edit: ["editing", "edited"],
  ensure: ["ensuring", "ensured"],
  move: ["moving", "moved"],
  merge: ["merging", "merged"],
  remove: ["removing", "removed"],
  create: ["creating", "created"],
};
function stepLabel(p, st, { home = homedir(), glyph = unicodeGlyph } = {}) {
  const r = (x) => tilde(rel(p.projectDir, x), home);
  const to = ` ${glyph("transition")} `;
  const said = (verb, rest) => ({
    base: `${verb} ${rest}`,
    running: `${STEP_TENSES[verb][0]} ${rest}`,
    done: `${STEP_TENSES[verb][1]} ${rest}`,
  });
  switch (st.kind) {
    case "portable-write":
      return said("stage", r(st.path));
    case "recover":
      return said(
        "lift",
        `${r(st.path)} ${glyph("dash")} the previous state proved${st.lifted ? `; it held: ${String(st.lifted).split("\n")[0]}` : ""}`,
      );
    case "write":
      return said("write", r(st.path));
    case "unregister":
      return said("edit", `${r(st.path)} [${st.pointer}.${st.name}]`);
    case "mark":
    case "unmark":
    case "set":
      return said("edit", `${r(st.path)} [${st.key}]`);
    case "ensure":
      return said("ensure", `${r(st.path)}/`);
    // Setup's vault (rule 10): the directory, the binding, git, the scaffold
    // — a scaffold step's paths are the vault's, beneath the vault's line.
    case "mkdir":
      return said("create", `${r(st.path)}/`);
    case "bind":
      return said("write", r(st.path));
    case "git-init": {
      const line = `$ ${st.argv.join(" ")}`;
      return { base: line, running: line, done: line };
    }
    case "scaffold":
      return said("create", st.rels.join(" and "));
    case "move-state":
      return said("move", `${r(st.from)}/${to}${r(st.to)}/`);
    case "merge-log":
      return said("merge", `${r(st.from)}${to}${r(st.to)}`);
    case "move-marker":
    case "move-binding":
      return said("move", `${r(st.from)}${to}${r(st.to)}`);
    case "delete":
    case "portable-remove":
    case "remove":
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime":
      return said("remove", r(st.path));
    case "rmdir-state":
      return said("remove", `${r(st.path)}/`);
    // An item the kept copy applied (the converge story's rule 5), in this
    // run's words for its action; one the preview did not list says so.
    case "kept": {
      const word = ACTION_WORD[st.action] || "update";
      const [running, done] = WORD_TENSES[word] || [word, word];
      const target = `${st.path ? r(st.path) : st.surface}${st.unplanned ? " (not in the preview)" : ""}`;
      return { base: `${word} ${target}`, running: `${running} ${target}`, done: `${done} ${target}` };
    }
    default:
      return null;
  }
}

// DONE and STOPPED (presentation spec contract 8). DONE: the count and the
// time; Next, one line per harness — its display name in a column, its
// manifest's next steps beside it, deduplicated; the facts the run settled
// (the version, for now); then the tip — the shells' `plan` commands with
// --verbose unless it was given, each on its own line (contract 6). Never
// from a harness-id branch: every word comes from the manifests. STOPPED:
// what applied, the step that failed by its argv and exit status or signal —
// or, for a command that could not start, its cause in their place, once —
// or by its item, the output beneath, and what to do. `cwd` decides whether
// the tip's --project is "$PWD".
//
// `extra` is setup's (the setup story, rules 10, 11 and 13), built by its
// front-end and handed through runVerb's `done`:
//   warnings  [{ text, commands }] — a ▲ row each under a Vault heading, after
//             the Done line: what failed without stopping the run (git init)
//   blocks    [{ lead, commands, after }] — Next's further lines, after the
//             keep's: the missing host, what a session left, the bind lines;
//             `after` a line beneath the commands ("then restart …")
//   tip       { lead, commands } — in place of the shells' plan commands
export function renderDone(r, { caps: c = PLAIN, verbose = false, cwd = process.cwd(), extra = null } = {}) {
  const paint = painter(c);
  const glyph = (name) => termIcon(c, name);
  const width = c.live ? c.width : 0;
  const dash = glyph("dash");
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
    lines.push(`${paint("emphasis", "Stopped")} ${dash} ${changes} applied, then ${what}`);
    const said = f.stderr ? String(f.stderr).split("\n") : [];
    const mark = `  ${paint("error", glyph("fail"))} `;
    if (f.argv) {
      // How the command ended: its exit status, the signal that stopped it,
      // or — only for one that could not start — its cause in their place,
      // said once (install spec contract 19). A command that ran and failed
      // otherwise (an answer in text where JSON is read) keeps its whole
      // message beneath.
      const ended =
        f.status !== null && f.status !== undefined
          ? ` exited ${f.status}`
          : f.signal
            ? ` killed by ${f.signal}`
            : f.couldNotStart && said.length
              ? ` ${dash} ${said.shift()}`
              : "";
      lines.push(`${mark}$ ${f.argv.join(" ")}${ended}`);
    } else lines.push(`${mark}${f.step}${item ? ` (${surfaceWords(item.surface)} ${rowTarget(p, item)})` : ""}`);
    for (const l of said) lines.push(`      ${paint("explanation", l)}`);
    const closing =
      item && item.kind === "registration"
        ? "The surfaces planned against its install path were not written; run the verb again once it succeeds."
        : "Run the verb again once the cause is fixed: its plan starts from what is on disk now.";
    lines.push(
      ...wrap(closing, width, "  ")
        .split("\n")
        .map((l, k) => (k ? l : `  ${l}`)),
    );
    return lines.join("\n") + "\n";
  }
  lines.push(`${paint("emphasis", "Done")} ${dash} ${changes} in ${duration(r.elapsed || 0)}`);
  const warnings = extra?.warnings || [];
  if (warnings.length) {
    lines.push("", paint("emphasis", VAULT_GROUP));
    warnings.forEach((w, k) => {
      if (k) lines.push("");
      const [first, ...rest] = wrap(w.text, width, "    ").split("\n");
      lines.push(`  ${paint("attention", glyph("warning"))} ${first}`, ...rest);
      if ((w.commands || []).length) lines.push(...commandBlock(c, w.commands, { indent: 4 }));
    });
  }
  const next = [],
    seen = new Set();
  for (const id of p.harnesses) {
    const m = loadHarness(id);
    if (!m) continue;
    const steps = (r.verb === "uninstall" ? [`restart ${m.display_name}`] : m.install?.next || []).filter(
      (s) => !seen.has(s),
    );
    for (const s of steps) seen.add(s);
    if (steps.length) next.push([m.display_name, steps.join("; ")]);
  }
  // The keep's own next lines (the converge story's rule 5): the update a copy
  // that could not run the keep needs, its own upgrade when its plan printed
  // no result, the npm row's uninstall — each lead, then its command alone on
  // its line (contract 6).
  const kept = p.items.filter((i) => i.kind === "channel" && Array.isArray(i.next)).flatMap((i) => i.next);
  const more = extra?.blocks || [];
  if (next.length || kept.length || more.length) lines.push("", paint("emphasis", "Next"));
  if (next.length) {
    const kw = Math.max(...next.map(([name]) => name.length));
    const col = " ".repeat(2 + kw + 2);
    for (const [name, text] of next) {
      const [first, ...rest] = wrap(text, width, col).split("\n");
      lines.push(`  ${paint("explanation", name)}${" ".repeat(kw - name.length + 2)}${first}`, ...rest);
    }
  }
  kept.forEach((b, k) => {
    if (k || next.length) lines.push("");
    lines.push(
      ...wrap(b.lead, width, "  ")
        .split("\n")
        .map((l, n) => (n ? l : `  ${l}`)),
    );
    if (b.command) lines.push(...commandBlock(c, [b.command], { indent: 4 }));
  });
  more.forEach((b, k) => {
    if (k || next.length || kept.length) lines.push("");
    lines.push(
      ...wrap(b.lead, width, "  ")
        .split("\n")
        .map((l, n) => (n ? l : `  ${l}`)),
    );
    if ((b.commands || []).length) lines.push(...commandBlock(c, b.commands, { indent: 4 }));
    if (b.after)
      lines.push(
        "",
        ...wrap(b.after, width, "  ")
          .split("\n")
          .map((l, n) => (n ? l : `  ${l}`)),
      );
  });
  // The facts: the version, and under the keep (the converge story's rule 5)
  // the copy each kept harness runs — this package's version is not what that
  // harness's surfaces were written by.
  const keeps = p.items.filter((i) => i.kind === "channel" && i.kept);
  const facts = [
    ...(p.version ? [["version", p.version]] : []),
    ...keeps.map((i) => [
      "kept",
      `${displayName(i.harness)}: ${i.kept.key}${i.kept.version ? ` ${i.kept.version}` : ""}`,
    ]),
  ];
  if (facts.length) lines.push("", ...kv(c, facts));
  // The tip: each shell's `plan` command, carrying --verbose unless it was
  // given, so the --verbose tip is this one and DONE has one tip, never
  // more than contract 18's two. Each command stands alone on its line, the
  // flag last (contract 6). `plan` previews an install: after an uninstall
  // it would preview the opposite of what just ran, so there is no tip.
  // A kept harness's tip is the kept copy's own plan, from its bin with
  // --no-register — this package's plan previews the other channel — and
  // none when that copy cannot run it; --verbose only where its CLI takes it.
  const here = (() => {
    try {
      return realpathSync(p.projectDir) === realpathSync(cwd);
    } catch {
      return p.projectDir === cwd;
    }
  })();
  const previews = [];
  let reasoned = true;
  if (r.verb !== "uninstall") {
    for (const id of p.harnesses) {
      const m = loadHarness(id);
      const k = keeps.find((i) => i.harness === id);
      if (k && k.kept.bin && !verbose && !k.kept.verbose) reasoned = false;
      const project = `--project ${here ? '"$PWD"' : `"${p.projectDir}"`}`;
      const cmd = k
        ? k.kept.bin
          ? `node "${k.kept.bin}" plan --harness ${id} --no-register ${project}${verbose || !k.kept.verbose ? "" : " --verbose"}`
          : null
        : m
          ? packageCommand(m, "plan", { args: `${project}${verbose ? "" : " --verbose"}` })
          : null;
      if (cmd && !previews.includes(cmd)) previews.push(cmd);
    }
  }
  const lead =
    verbose || !reasoned ? "To preview without writing:" : "To preview without writing, with every row's reasoning:";
  if (extra?.tip) lines.push("", `  ${paint("explanation", extra.tip.lead)}`, ...commandBlock(c, extra.tip.commands));
  else if (previews.length) lines.push("", `  ${paint("explanation", lead)}`, ...commandBlock(c, previews));
  return lines.join("\n") + "\n";
}

// What a text run that wrote nothing says after its plan: one helper for
// main(), the bin's runInstallVerb and setup, so the entries cannot drift (the
// converge story's rule 2). `harnesses` are the run's own --harness, which
// the channel gate's commands repeat — never --project. Its commands are rule
// 2's helper's (channelChoices): setup's, pinned to the running version on a
// package root (pinFor), each alone on its line after a blank one
// (presentation spec contract 6). `args` is what setup's own refusal repeats
// after each --harness (its --vault, --channel, --layout, --language): a
// string, or a function of the harness id, for words only one harness takes.
export function gateText(r, { verb, harnesses = [], caps: c = PLAIN, args = "" } = {}) {
  const why = r.gate?.why;
  // A bare setup without a terminal (the setup story, rule 12): it planned the
  // pre-ticked set; each harness's confirming run, alone on its line, pinned
  // as the channel gate's are.
  if (why === "non-tty" && verb === "setup") {
    const ids = r.plan.harnesses.length ? r.plan.harnesses : harnessIds();
    const version = pinFor(r.plan.root, r.plan.version);
    const more = (id) => (typeof args === "function" ? args(id) : args);
    return (
      [
        `Nothing written: without a terminal, a bare setup refuses. Name the harness to confirm ${termIcon(c, "dash")} repeat --harness for more than one:`,
        ...commandBlock(
          c,
          ids.map((id) =>
            coreCommand("setup", { version, args: [`--harness ${id}`, more(id)].filter(Boolean).join(" ") }),
          ),
          { indent: 4 },
        ),
      ].join("\n") + "\n"
    );
  }
  if (why === "non-tty")
    return `Nothing written: without a terminal, a bare ${verb} refuses. Name the harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`;
  if (why === "declined") return "Nothing written.\n";
  // runVerb's dry run (setup's --dry-run, its rule 12).
  if (why === "dry-run") return "Nothing written: this was a dry run.\n";
  if (why === "channel") {
    const keys = [...new Set(r.plan.items.filter(isSwitch).map((i) => i.entry))];
    return (
      channelText(
        channelChoices({ gate: { args: { harnesses }, keys, version: pinFor(r.plan.root, r.plan.version) } }),
        c,
      ) + "\n"
    );
  }
  return "";
}

// The channel gate's blocks as text: each lead, then its command alone on its
// line after a blank one; a block with no lead follows the one before it.
export function channelText(blocks, c = PLAIN) {
  return blocks
    .map((b) =>
      (b.lead
        ? [b.lead, ...commandBlock(c, [b.command], { indent: 4 })]
        : commandBlock(c, [b.command], { indent: 4 }).slice(1)
      ).join("\n"),
    )
    .join("\n\n");
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
function publicStep({ manifest: _manifest, ...s }) {
  for (const k of PRIVATE_STEP_FIELDS[s.kind] || []) delete s[k];
  if (s.kind === "portable-write" && Array.isArray(s.files)) s.files = s.files.length;
  return s;
}
// `analysed` (the recheck's inputs) and `digestDeferred` (a --verbose note)
// are the plan's own, never the envelope's.
// `advice` is the reason's commands, kept apart for PLAN to draw alone on
// their lines; the envelope has them in `reason`, one part per line.
export const publicItem = ({
  before: _before,
  after: _after,
  steps,
  observed: _observed,
  analysed: _analysed,
  digestDeferred: _digestDeferred,
  advice: _advice,
  ...rest
}) => (steps ? { ...rest, steps: steps.map(publicStep) } : rest);

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!["install", "uninstall", "upgrade", "plan"].includes(verb)) {
    process.stderr.write(usage() + "\n");
    process.exit(2);
  }
  const harnesses = [],
    surfaces = [];
  let projectDir = null,
    json = false,
    globalRemoval = false,
    register = true,
    verbose = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        process.stderr.write(`${a} needs a value\n${usage()}\n`);
        process.exit(2);
      }
      return v;
    };
    if (a === "--harness") harnesses.push(value());
    else if (a === "--surface") surfaces.push(value());
    else if (a === "--project") projectDir = value();
    else if (a === "--global") globalRemoval = true;
    else if (a === "--no-register" && verb !== "uninstall") register = false;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else {
      process.stderr.write(`unknown argument ${a}\n${usage()}\n`);
      process.exit(2);
    }
  }
  const src = sourceHarness();
  projectDir = resolve(projectDir || (src && process.env[src.runtime?.project_dir_env]) || process.cwd());
  const opts = {
    harnesses,
    surfaces: surfaces.length ? surfaces : null,
    globalRemoval,
    register,
    json,
    verbose,
    stdin: process.stdin,
    stdout: process.stdout,
  };
  if (verb === "plan") {
    const p = plan(projectDir, planOptions(opts));
    const c = termCaps(process.stdout, process.env);
    process.stdout.write(
      json
        ? JSON.stringify({ ...p, items: p.items.map(publicItem) }, null, 2) + "\n"
        : renderPreview(p, { verbose, verb, caps: c }),
    );
    process.exit(p.ok && !p.incomplete ? 0 : 1);
  }
  const r = await runVerb(verb, projectDir, json ? opts : { ...opts, out: process.stdout });
  // The bin's form (scripts/cli.mjs): a gate that confirmed nothing — a
  // channel switch without a terminal among them — is not ok through either entry.
  const ok = r.plan.ok && !r.plan.incomplete && !r.failed && (r.gate.confirmed || r.gate.why === "nothing-to-do");
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          verb,
          ok,
          gate: r.gate,
          applied: r.applied,
          failed: r.failed,
          incomplete: r.plan.incomplete,
          items: r.plan.items.map(publicItem),
          refusals: r.plan.refusals,
          reports: r.plan.reports,
          fetched: r.fetched,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(gateText(r, { verb, harnesses, caps: termCaps(process.stdout, process.env) }));
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// projectstore — install-handlers.mjs: the installer's planners for the
// surfaces it writes itself, setup's items, and the plan helpers they share.
//
// Moved out of install-harness.mjs as it was (the story "The installer is
// split into modules under 200 KiB each, with every export and every test
// unchanged"). The installer's HANDLERS table keys these by the manifest's
// surfaces.<kind>.format, never by a harness id: planAgentsBlock (the agents
// block, planned once per run), planJsonEntry (our entry in a shared JSON
// file, such as the status-line slot) and planStampedFile (an exclusive file
// carrying the provenance line). Each answers (ctx, key, s) → PlanItem[] from
// the state surfaces.mjs derived, and writes nothing.
//
// Setup's items (the setup story, rule 10): planVault, planStateDir and the
// `binding` items — planStatuslineFlag, STAMP, stamped and bindingItem, which
// the installer's keep record, mark and binding apply build on. And the helpers
// plan(), apply() and the preview share: rel and inside, isWrite, the
// consequence note, surfaceExcluded, oneAddPerFile and the host-managed
// report (contract 14).
//
// A leaf: it imports neither the installer nor any module that reads the
// registry, fetches a shell or runs a host command. The registration's
// planners, which do, stay in install-harness.mjs.

import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { loadHarnesses, packageCommand, agentsBlockRow } from "./harness.mjs";
import { FOREIGN_TEXT } from "./provenance.mjs";
import { analyseBlock, analyseJsonEntry, analyseStampedFile, readText } from "./surfaces.mjs";
import { bindPlanSteps } from "./binding.mjs";
import {
  removeAgentsBlock,
  replaceAgentsBlock,
  isPluginCacheRoot,
  isHostInstallRoot,
  isEphemeralRoot,
  importsLine,
  layoutPaths,
  newerBlockWords,
} from "./lib.mjs";

export function rel(projectDir, p) {
  const r = relative(projectDir, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

export function inside(dir, parent) {
  const r = relative(parent, dir);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// Planned once per RUN by plan(), never once per harness (the story "One run
// plans the agents block once, and a bare uninstall selects every harness the
// project uses", rule 1). `s` carries the run's common file list as `files`;
// `ctx.run` is every harness of the run that has a block, `ctx.harness` the
// first of them, `ctx.readers` set when the run names more than one, and
// `ctx.layout` the roster's layout name (rule 3).
export function planAgentsBlock(ctx, key, s) {
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
    // deletion and left holding nothing (apply's `deleteIfEmpty` branch).
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

  const current = a.current;
  // A block marked above this copy's template is never rendered down (the
  // install spec, contracts 4, 6 and 9, as amended 2026-10-14): a move, a
  // migration or a dedupe carries its own bytes, stamped with its own marker.
  const newer = a.newer || null;
  const words = newer ? newerBlockWords(newer.block.v, a.version) : null;
  const body = newer ? newer.block.block : a.desired;
  const entry = `projectstore:agents v${newer ? newer.block.v : a.version}`;
  // Two files, one block each: resolve in favour of the preferred file —
  // register migrates, never duplicates (ADR-002 decision 3).
  for (const e of a.duplicates || [])
    items.push(
      removal(e, {
        state: "ours-stale",
        reason:
          newer === e
            ? `carries v${e.block.v}, newer than this copy's v${a.version}; its text replaces the block in ${current.file}`
            : `duplicate of the block in ${current.file}`,
      }),
    );
  let newerInPlace = null;

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
      reason:
        ctx.readers && !current.own
          ? a.reason
          : `migrated from ${current.file}${newer ? ` with its own text (${words})` : ""}`,
      before: preferred.present ? preferred.text : null,
      after: replaceAgentsBlock(preferred.present ? preferred.text : "", body),
    });
  } else if (newer && newer !== current) {
    // The duplicate carries the higher marker: its text replaces the stayer's.
    items.push({
      surface: key,
      kind: "shared",
      path: current.path,
      entry,
      state: "ours-stale",
      action: "replace-entry",
      reason: `its text is replaced by ${newer.file}'s, which carries v${newer.block.v}, newer than this copy's v${a.version}`,
      before: current.text,
      after: replaceAgentsBlock(current.text, body),
    });
  } else if (newer) {
    // It stays as it is; a named run with nothing else to place overwrites it,
    // decided once the imports are known (below).
    newerInPlace = {
      surface: key,
      kind: "shared",
      path: current.path,
      entry,
      state: "ours-newer",
      action: "skip",
      reason: `${words}: left as it is — ${
        ctx.takesSurface === false
          ? `to write this copy's v${a.version} over it: ${packageCommand(ctx.harness, "install", { args: `--surface ${key}` })}`
          : `name --surface ${key} to write this copy's v${a.version} over it`
      }`,
    };
    items.push(newerInPlace);
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
  // Naming the surface confirms the overwrite only when the run has nothing
  // else to do for the block: it is the only block and every import it needs
  // is in place. Doctor's placement remedies name the surface too, and they
  // must never downgrade (contract 9 as amended 2026-10-14).
  if (
    newerInPlace &&
    (ctx.surfaces || []).includes(key) &&
    !(a.duplicates || []).length &&
    !items.some((i) => i.surface === `${key}_import`)
  )
    Object.assign(newerInPlace, {
      entry: `projectstore:agents v${a.version}`,
      action: "replace-entry",
      reason: `v${current.block.v} → v${a.version}: ${words}, and --surface ${key} names it`,
      before: current.text,
      after: replaceAgentsBlock(current.text, a.desired),
    });
  return items;
}

// A row's consequence (presentation spec contract 7) carried as a `note` step:
// the envelope reads `{ kind: "note", why }`, as any note; PLAN draws it first
// beneath its row, in the explanation role, by the mark kept off the envelope.
export function consequenceStep(why) {
  const st = { kind: "note", why };
  Object.defineProperty(st, "consequence", { value: true, enumerable: false });
  return st;
}
export const isConsequence = (st) => st?.kind === "note" && st.consequence === true;

// The status line's flag (the setup story, rule 9; the configure spec,
// contract 6): `statusline.enabled`, from setup's answer or from a run that
// names the surface — install records on, uninstall off. This item is the
// flag's one writer; every other key of a `statusline` object is kept.
// Planned for the run's harness that has the status-line surface, when the
// binding the run leaves does not already say the same; only when there is a
// binding to record it in.
const STATUSLINE_FLAG = "statusline.enabled";
export function planStatuslineFlag(ctx, value, mode = "install") {
  const b = ctx.binding;
  if (!b || !b.bound || typeof value !== "boolean" || b.statusline === value) return null;
  const off =
    mode === "uninstall"
      ? "the status line is removed in this run, and the SessionStart hook keeps it off"
      : "the status line stays off, and setup does not ask again";
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
        : off,
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
export function planVault(bp) {
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
export function planStateDir(projectDir, harness, { first = false } = {}) {
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
export const STAMP = Object.freeze({ stamp: "setup" });
export const stamped = (v) =>
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
export function bindingItem({
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

export function planJsonEntry(ctx, key, s) {
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
        ? `to wire it anyway: ${packageCommand(ctx.harness, "install", { args: `--surface ${key}` })}`
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
  const a = analyseJsonEntry(projectDir, s, { root, home, renderRoot, harness: ctx.harness });
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

export function planStampedFile(ctx, key, s) {
  const { projectDir, mode, root, home, harness } = ctx;
  const renderRoot = ctx.renderRoot || root;
  const path = join(projectDir, s.file);
  const produced = !(s.condition === "plugin_cache_install" && !isHostInstallRoot(renderRoot, home));
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

// The surface rows a run leaves out: a --surface that does not name the key
// (by prefix, so `statusline` covers the launcher), or --no-register's
// registration. One predicate for plan() and the shell fetch's decision.
export function surfaceExcluded(key, s, { surfaces = null, register = true } = {}) {
  return (
    Boolean(surfaces && !surfaces.some((x) => key === x || key.startsWith(x + "_"))) ||
    (register === false && s.kind === "registration")
  );
}

// One add per file (the presentation spec, contract 7 as amended 2026-10-14):
// within one plan, a file an earlier item creates is added once. A later
// `create` or `add` on that path changes the file the run has just made, so it
// reads `update`; its state, steps and detail stay. Each item is planned
// against the tree before the run, so the binding the vault item writes was
// "absent" to the status-line flag and the channel mark, and all three read
// "add". A creator is an earlier `create` or `add` item that is neither a
// registration (its host-owned files are the host CLI's) nor a binding row (it
// never makes the binding: apply skips it on an unbound project, and the vault
// item or the layout move makes the file), counted for the paths absent at
// plan time: its own and each step's `path` — never a move step's `to`, so a
// migrating project's binding rows keep `add`. An entry row on a file that was
// there keeps `add`.
export function oneAddPerFile(items) {
  const created = new Set();
  const writes = (i) => i.action === "create" || i.action === "add";
  for (const item of items) {
    if (!writes(item) || item.kind === "registration") continue;
    if (item.path && created.has(resolve(item.path))) {
      item.action = "update";
      continue;
    }
    if (item.kind === "binding") continue;
    for (const p of [item.path, ...(item.steps || []).map((s) => s.path)])
      if (p && !existsSync(p)) created.add(resolve(p));
  }
}

// Contract 14: the host installs and updates these itself; say how, from the
// manifest, and write nothing. (PR #13's installElsewhere, as a plan line.)
export function hostManagedReport(m, rows, registration = null) {
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

export const isWrite = (i) => !["skip", "refuse"].includes(i.action);

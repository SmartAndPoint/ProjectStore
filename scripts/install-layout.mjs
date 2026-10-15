// projectstore — install-layout.mjs: the layout migration, planned and applied
// (the layout ADR; layout spec contract 6), and the uninstall item that
// empties a harness's state directory.
//
// Moved out of install-harness.mjs as it was (the story "The installer is
// split into modules under 200 KiB each, with every export and every test
// unchanged"). plan() calls planLayout and planHarnessState; apply() hands a
// `layout` item to applyLayout, which writes files only through lib.mjs.
// stepResult is what one step left behind for its APPLY line; the
// registration's apply reads it too.
//
// A leaf: it imports neither the installer nor any module that reads the
// registry, fetches a shell or runs a host command.

import { mkdirSync, rmdirSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { loadHarness, insideHostSession } from "./harness.mjs";
import { analyseLayout, analyseHarnessState, isOurFile } from "./surfaces.mjs";
import {
  writeFileAtomic,
  ensureStateDir,
  ensureRuntimeDir,
  statusLineIsOurWiring,
  claudeHome,
  moveStateDir,
  mergeEntryLog,
  movePath,
  removeInside,
  statusLineScriptPath,
  layoutPaths,
} from "./lib.mjs";

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
export function planLayout(ctx) {
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
export function planHarnessState(projectDir, harness, planned) {
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

export function applyLayout(p, i, { failed, home = homedir(), onStep = null }) {
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
export function stepResult(out, seen) {
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

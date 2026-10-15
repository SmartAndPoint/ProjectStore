#!/usr/bin/env node
// projectstore — SessionStart hook.
// 1. Reads .projectstore/projectstore.json from the project root. If absent or
//    auto_inject=false, silently no-ops.
// 2. Registers this session in <vault>/.projectstore/sessions/<id>.json,
//    keyed by Claude's own session_id from hook stdin. Cleans stale
//    entries (>24h). Detects other active sessions (mtime < 30min) and
//    appends a warning so the agent knows it is not alone on this vault.
// 3. Injects a NAVIGATION SKELETON — the layout's folders, what each is for,
//    what is in flight, and the order to descend in. Not a copy of the vault:
//    it used to inject every folder README, which on a real vault exceeded the
//    10,000-character hook cap and was written to a file the agent then had to
//    open. Bounded and O(1) in vault size by construction.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  readConfig,
  gatherVaultFacts,
  renderVaultSkeleton,
  writeSession,
  readActiveSessions,
  cleanupStaleSessions,
  readStdinJson,
  adoptHookInput,
  projectRoot,
  layoutPaths,
  cachePaths,
  pickExisting,
  activeHarnessId,
  ensureStateRoot,
  syncStatusLine,
  cleanupStaleSessionState,
  refreshStoryPointer,
  armReminder,
  truncEnd,
  truncFront,
  PATH_CELL,
  ERROR_CELL,
  TITLE_CELL,
  commandForm,
  updateHint,
  speakingDisplayName,
  inheritForm,
  bindInherits,
} from "../scripts/lib.mjs";
import { runStartupChecks } from "../scripts/doctor.mjs";
import { resolveBinding, bindingOfferText } from "../scripts/worktree.mjs";

// The welcome has been seen, by this harness, when either marker exists: the
// project's (state/<id>/welcomed, or the legacy .claude/.projectstore-welcomed
// while the window is open) or the machine's (the user-level cache's
// welcomed/<id>). Both branches read both; only the write follows the binding
// (the story "Opening a project that is not bound writes nothing into it…",
// decisions 1 and 2). So a project that holds a marker an unbound session of
// 0.30.5 or earlier wrote is not welcomed again.
//
// The machine's marker is null with no cache root, and a home the platform
// cannot answer for must not break startup either (skeleton spec, contract 17).
function machineMarker(id) {
  try {
    return cachePaths().welcomed(id);
  } catch {
    return null;
  }
}
function welcomeSeen(proj, id) {
  const p = layoutPaths(proj);
  const machine = machineMarker(id);
  return existsSync(pickExisting(p.welcomed(id), p.legacy.welcomed)) || (machine !== null && existsSync(machine));
}

// One-time orientation packet shown when projectstore first loads. A bound
// project shows it once per project; a project that is not bound shows it once
// on this machine, because a user-scope install is on in every repository the
// person opens, and writing a marker into each of them is a write into
// projects nobody set up. A project can already be bound when the welcome
// fires — a fresh install into a project someone bound first is the ordinary
// case, not a corner (measured 2026-09-06: the first line a new user read told
// them to bind a project whose vault the install preview had just named). So
// the one instruction it carries branches on the binding, and so does the
// footer that says how often it appears; everything else is the same message.
function buildWelcome(cfg = null) {
  const start =
    cfg && cfg.vault_path
      ? `**Already bound**: this project's vault is \`${truncFront(String(cfg.vault_path), PATH_CELL)}\`. Ask for what you want — the agent picks up commands like \`${commandForm("adr")}\` and \`${commandForm("epic")}\` from the conversation, and you approve every write. If the vault has no folders yet, \`${commandForm("scaffold")}\` lays them out.`
      : `**To start using it**: run \`${commandForm("bind", { args: "<vault-path>" })}\` and point it at an Obsidian vault (or any folder). After that, the agent will pick up commands like \`${commandForm("adr")}\` and \`${commandForm("epic")}\` from the conversation; you only approve the writes.`;
  return [
    "# 👋 projectstore is loaded for the first time in this project",
    "",
    "**What it does**: turns the conversation's decisions into a structured Obsidian-friendly markdown vault — ADRs, epics, stories, runbooks, research. Agent-maintained, you approve every write.",
    "",
    start,
    "",
    // The update advice is the harness's own (its manifest's update_hint):
    // a git marketplace's toggle means nothing to a harness installed from npm.
    ...updateHint().welcome,
    "",
    cfg ? "_This message appears once per project._" : "_This message appears once on this machine._",
    "",
    "_If projectstore helps you ship, a [GitHub star](https://github.com/SmartAndPoint/ProjectStore) helps others discover it. No pressure._",
    "",
  ].join("\n");
}

function showWelcomeOnce(proj, cfg = null) {
  const id = activeHarnessId();
  if (welcomeSeen(proj, id)) return "";
  const text = buildWelcome(cfg);
  try {
    let marker = null;
    if (cfg) {
      // Bound: the project's marker, beside the launcher (layout spec contract
      // 5). The state directory's own .gitignore comes with it, header
      // included, and no sessions/: it is how a project uninstall recognises
      // this marker as ours (install spec contract 13, as amended by the
      // shell-fetch story).
      ensureStateRoot(proj);
      marker = layoutPaths(proj).welcomed(id);
    } else {
      // Not bound: the machine's marker, and nothing in the project. With no
      // cache root (no usable home) nothing is written and the welcome shows
      // again next time — startup never breaks over it (skeleton spec,
      // contract 17).
      marker = machineMarker(id);
    }
    if (marker) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, new Date().toISOString() + "\n", "utf8");
    }
  } catch {}
  return text;
}

// Writes the payload and ends the process — after the flush, never before.
//
// The gather races its reads against a timer, so when the timer wins there are
// reads still outstanding, and an evicted file could hold the event loop open
// long past the budget the user is actually waiting on. Exiting here caps the
// hook's wall time at that budget. The callback is the whole safety of it:
// process.exit does not flush pending pipe writes, so exiting on the line after
// a write is how a payload gets truncated.
function emit(additionalContext, systemMessage) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  if (systemMessage) out.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
}

// Contract 3 — capped at 5 like the in-flight list, and for the same reason.
// The warning costs ~138 characters per sibling on top of a 748-character
// frame, so an uncapped list breaches the 10,000 composed cap at roughly 32
// concurrent sessions. That bound is empirical, and an empirical bound is what
// contract 1 exists to forbid; the cap makes it structural instead.
const SIBLING_CAP = 5;

function buildOthersWarning(others) {
  const lines = [
    "",
    "---",
    "",
    `## ⚠️ Multi-session warning — ${others.length} other projectstore session(s) active on this vault`,
    "",
    `Another ${speakingDisplayName()} session is currently working on the same vault.`,
    "Active session(s):",
    "",
  ];
  for (const s of others.slice(0, SIBLING_CAP)) {
    lines.push(
      `- project: \`${truncFront(String(s.project_root ?? ""), PATH_CELL)}\`` +
        // Free text from a session file this process never wrote, rendered five
        // times over. The last unbounded term in the composed value: `last_active`
        // is a real Date, the layout fields are plugin-bundled, counts are numbers.
        ` — started ${truncEnd(String(s.started_at ?? ""), TITLE_CELL)},` +
        ` last activity ${s.last_active.toISOString()}`,
    );
  }
  if (others.length > SIBLING_CAP) {
    lines.push(`- …and ${others.length - SIBLING_CAP} more — run \`${commandForm("status")}\``);
  }
  lines.push(
    "",
    "**Before creating new ADRs / epics / stories / research:**",
    `1. Run \`${commandForm("search", { args: "<topic-keywords>" })}\` to check for in-flight artifacts on the same topic.`,
    `2. Run \`${commandForm("status")}\` to see what artifacts have been touched recently.`,
    "3. After creation, the plugin re-checks file existence right before write — collisions are detected, but topic / number reservation across sessions is on you and the other agent to coordinate.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  // The payload before the project. readConfig() resolves through
  // projectRoot(), so anything read above this line answers for whatever
  // directory the process started in — silently, on any harness that exports
  // no project-dir variable. Read once: fd 0 is empty on a second read, and
  // `sid` below is this object's, not a re-read.
  const input = adoptHookInput(readStdinJson());
  const sid = input?.session_id || null;

  const cfg = readConfig();
  const proj = projectRoot();
  // Asked only on the unbound path. A bound project must not spend a git
  // subprocess at every session start on a question it has already answered;
  // an unbound one that is not a worktree pays a single ~10 ms probe.
  let binding = null;
  if (!cfg) {
    try {
      binding = resolveBinding(proj);
    } catch {}
  }
  const welcome = showWelcomeOnce(proj, cfg);
  // The person's channel carries one instruction, and it has to be the right
  // one: a bound project is told what it is bound to, not to bind again. A
  // command stands alone on its line, the update hint on lines of its own
  // after it (the story "User-facing text says where to run…", rules 4 and 5).
  const welcomeSystemMessage = welcome
    ? cfg && cfg.vault_path
      ? `👋 projectstore: first-run welcome shown. Bound to ${cfg.vault_path}. ${updateHint().line}`
      : [
          "👋 projectstore: first-run welcome shown. Start with:",
          commandForm("bind", { args: "<vault-path>" }),
          updateHint().line,
        ]
          .filter(Boolean)
          .join("\n")
    : null;

  if (!cfg) {
    // The offer goes ahead of the welcome, not after it: a fresh worktree has no
    // welcome marker either, so the first-run welcome fires here too — and its
    // advice, to bind and point at a vault, is the wrong move for a checkout
    // whose parent is already bound. Ordering is the cheap fix; the small
    // redundancy is accepted rather than papered over with copy that will rot.
    const offer = binding && binding.state === "inheritable" ? bindingOfferText(binding) : "";
    // What binding does first, then the command alone on its line: an
    // in-session form that can carry the parent's vault path (rule 4).
    const offerSystemMessage = offer
      ? `projectstore: this worktree is unbound. ${bindInherits() ? "Adopt the binding of" : "Bind it to the vault, layout and language of"} the checkout it was forked from, in the session:\n${inheritForm(binding.vaultPath, { layout: binding.layout, language: binding.language })}`
      : null;
    const body = offer + (welcome || "");
    if (body) {
      // The person's channel carries ONE instruction. Joining both would put
      // "bind --inherit" and "bind <vault-path>" in one line with no ordering
      // cue — not redundancy but a contradiction, in the channel that gets read
      // fastest. The body still carries the welcome for the agent.
      return emit(body, offerSystemMessage || welcomeSystemMessage);
    }
    process.exit(0);
  }

  // Opt-in status line: keep settings.local.json pointed at this plugin
  // version's statusline.mjs (self-heals on update). Best-effort; a settings
  // write must never break session-context injection.
  try {
    syncStatusLine(cfg, proj);
  } catch {}
  // Statusline-feature housekeeping, like syncStatusLine — must run even when
  // auto_inject=false (touch-session writes pointers regardless of it).
  try {
    cleanupStaleSessionState(proj);
  } catch {}
  // This session's story fields from the story file, once (ADR-006, amended
  // 2026-10-12): a pointer written before a close, or a story closed elsewhere
  // since, stops naming finished work. A bounded read; a lost race writes
  // nothing.
  if (sid) {
    try {
      await refreshStoryPointer(proj, cfg.vault_path, sid);
    } catch {}
  }

  // Arm BEFORE the auto_inject gate. The entry reminder's markers must be
  // re-armed after a compaction whether or not this session injects context —
  // an auto_inject=false session still writes code, and its reminder was
  // discarded with the conversation just the same.
  //
  // `input` and `sid` are read at the top of main() now, because the project
  // resolves from that payload; this block only consumes them.
  //
  // `compact` and `clear` are the two sources where the session id survives but
  // the conversation does not, so a reminder already delivered is gone from
  // context while its marker persists on disk. Arming lets it fire once more;
  // the cap of two is enforced by the election, not here.
  if (sid && (input?.source === "compact" || input?.source === "clear")) {
    try {
      armReminder(proj, sid);
    } catch {}
  }

  if (cfg.auto_inject === false) {
    if (welcome) return emit(welcome, welcomeSystemMessage);
    process.exit(0);
  }

  // Contract 23, first half — the gather (and with it the activity read) runs
  // BEFORE registration, so the continuity section sees the log exactly as the
  // previous conversation left it. The exemption below is the other half: it
  // protects the NEXT compaction, this ordering protects this one.
  let facts = null;
  let gatherError = null;
  try {
    facts = await gatherVaultFacts(cfg, { sessionId: sid, source: input?.source });
  } catch (e) {
    gatherError = e;
  }

  let warning = "";
  // A bound vault that has vanished must not be silently recreated: ensureSessionsDir's
  // recursive mkdir would manufacture it, and from the NEXT start the skeleton would
  // assert eight rows of zeros and "nothing in progress" about a vault nobody
  // scaffolded. The not-found shape has to survive more than one run to be worth
  // anything (contract 17).
  if (sid && !facts?.vaultMissing) {
    try {
      cleanupStaleSessions(cfg.vault_path, 24, sid);
      writeSession(cfg.vault_path, sid, proj);
      const others = readActiveSessions(cfg.vault_path, sid);
      if (others.length > 0) warning = buildOthersWarning(others);
    } catch (e) {
      // Contract 3 — a raw `e.message` is free text and therefore unbounded;
      // node's own filesystem errors already carry two full paths. Assigned
      // here rather than appended: registration failure REPLACES the sibling
      // warning, so the two cannot compound.
      warning = `\n\n## projectstore: session registration failed\n\n${truncEnd(String(e.message), ERROR_CELL)}\n`;
    }
  }

  // Cheap install-only doctor subset (ADR-005): one part, only when N > 0;
  // aborted past its budget rather than reporting a false "clean". Its doctor
  // form stands alone on its line, as every command of this line does.
  let doctorMsg = null;
  let offers = [];
  try {
    const r = runStartupChecks(cfg, proj);
    if (r.skipped) {
      doctorMsg = `projectstore doctor: startup checks skipped. Run them in the session:\n${commandForm("doctor")}`;
    } else if (r.count > 0) {
      doctorMsg = `projectstore doctor: ${r.count} install issue(s). See them in the session:\n${commandForm("doctor")}`;
    }
    // Offers (doctor's OFFER_CHECKS): one-time steps a user should see once,
    // e.g. the re-stamp after a plugin update — not issues, not silent.
    offers = (r.offers || []).map((m) => `projectstore: ${m}`);
  } catch {}
  // Each part on lines of its own: an offer ends with its command alone on
  // its line, and a part joined after it with ` · ` would put text after the
  // command (the story "User-facing text says where to run…", rule 4).
  const systemMessage = [welcomeSystemMessage, doctorMsg, ...offers].filter(Boolean).join("\n") || null;

  if (gatherError) {
    emit(
      welcome +
        `# projectstore: vault load failed\n\n${truncEnd(String(gatherError.message), ERROR_CELL)}\n\nFix \`.projectstore/projectstore.json\` or run \`${commandForm("bind", { args: "<path>" })}\` again.`,
      systemMessage,
    );
    return;
  }
  emit(welcome + renderVaultSkeleton(facts) + warning, systemMessage);
}

// A hook must never break session startup (contract 17): an unhandled rejection
// in the async path would exit non-zero and surface as a hook failure to the
// user, which is a worse outcome than a session with no orientation.
main().catch(() => process.exit(0));

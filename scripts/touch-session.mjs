#!/usr/bin/env node
// projectstore — touch-session.mjs
//
// Called by BOTH the PreToolUse and PostToolUse hooks, and gated on which:
// a write inside the vault fires both events, so without the gate the pointer
// patch below would run twice per call — and that patch is the unguarded
// read-modify-write the entry-rule state deliberately avoids. A write's
// pointer patch (and the raw-edit nudge) runs on PostToolUse, from the file as
// written; any other tool's on PreToolUse (ADR-006, amended 2026-10-12).
//
// Responsibilities:
// 1. Liveness — touches this session's registration file (mtime) so other
//    sessions can see we are active. Bootstraps the record on first call
//    when SessionStart did not run (plugin installed mid-session via
//    /reload-plugins, or rare path where SessionStart was skipped).
// 2. Activity log — extracts the target file path from the tool input
//    and, if it lives inside the vault, appends an entry to
//    `recent_activity` in the session file (capped at 50, deduped).
//    The PreCompact hook reads this list to build a survival packet.
// 3. Entry-rule detection (PostToolUse only) — counts distinct SOURCE paths
//    written this session and, once the threshold is reached with no story
//    open, emits the one advisory reminder. PostToolUse rather than
//    PreToolUse because it fires only after a call succeeds, so declined
//    edits are not counted as work that happened. Spec: "Entry-rule
//    detection: the score, the open-story predicate, and the delivery seams".
//
// Session identity comes from Claude's own `session_id` field in the
// hook input JSON (stdin), so two Claude Code instances open on the
// same project get distinct session files.
//
// Silent no-op when there is no projectstore config, when stdin lacks
// session_id, or on any error — a PreToolUse hook must never crash the
// user's tool call.

import { existsSync } from "node:fs";
import {
  readConfig,
  readStdinJson,
  adoptHookInput,
  touchSession,
  writeSession,
  cleanupStaleSessions,
  sessionFilePath,
  projectRoot,
  appendActivity,
  isInsideVault,
  pointerPatchFor,
  readSessionState,
  writeSessionState,
  isSourcePath,
  registerSourcePath,
  entryScore,
  resolveOpenStory,
  readOpenStoryCache,
  writeOpenStoryCache,
  mayRemind,
  electEmitter,
  appendEntryLog,
  entryReminderText,
  ENTRY_THRESHOLD,
  isWriteTool,
  loadLayout,
  anchorKeyOf,
  foldAnchor,
  bumpAnchor,
  readAnchorState,
  readAnchorOffer,
  writeAnchorOffer,
  liveSessionNames,
  ownSessionName,
  sessionNameOffer,
  sessionNameOfferText,
  toolPaths,
  commandForm,
  speakingHarness,
} from "./lib.mjs";

const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

// Per-session active pointer (ADR-006) — denormalized titles/status captured
// after the write so the statusline renders with zero vault reads — plus the
// raw-edit nudge (PS-IMPROVE story-003): throttled, never blocking. Both in
// patchPointer below.
// The session-name offer (ADR: the settled-anchor offer). Returns a line or
// null. Separate from the pointer patch because the two answer different
// questions — the pointer is "what is current", this is "has the session
// settled" — and because this one must be gated where the pointer is not.
let LAYOUT = null;
function layoutOnce(cfg) {
  if (LAYOUT === null) LAYOUT = loadLayout(cfg.layout);
  return LAYOUT;
}

function anchorOffer(cfg, proj, sid, filePath, toolName, isSubagent, sessionsDir = null) {
  // The two gates. The pointer patch below deliberately has neither: it answers
  // "what am I looking at", for which a Read is a fine answer. A NAME is a
  // claim about what the session is DOING, so a review session that greps
  // thirty files must not be named after them, and a subagent — which shares
  // this session id and cannot accept a name — must not vote on one.
  if (!isWriteTool(toolName || "")) return null;
  if (isSubagent) return null;
  // A harness with no way to rename a session gets no offer, and so keeps no
  // tally and logs nothing for one (generation spec, contract 18).
  if (!speakingHarness()?.capabilities?.session_rename) return null;

  const rel = filePath.slice(cfg.vault_path.length + 1);
  let hit;
  try {
    hit = anchorKeyOf(rel, layoutOnce(cfg));
  } catch {
    return null;
  }
  if (!hit) return null;

  // Both slots: the key tally is what settles an anchor, the leaf tally only
  // picks which story names it. Bumping the leaf alone leaves the anchor
  // permanently unsettled — silently, since a rule that never fires looks
  // exactly like a quiet one.
  bumpAnchor(proj, sid, hit.key, null);
  if (hit.leaf) bumpAnchor(proj, sid, hit.key, hit.leaf);

  const prev = readAnchorState(proj, sid);
  // The tally on disk already includes this event, so replay it against the
  // state MINUS this event: fold is what decides an offer, and it must see the
  // increment happen rather than find it already there.
  const counts = { ...prev.counts };
  if (counts[hit.key]) counts[hit.key] -= 1;
  const leaves = { ...prev.leaves };
  if (hit.leaf && leaves[hit.key] && leaves[hit.key][hit.leaf]) {
    leaves[hit.key] = { ...leaves[hit.key], [hit.leaf]: leaves[hit.key][hit.leaf] - 1 };
  }
  const { state, offer } = foldAnchor({ counts, leaves, incumbent: prev.incumbent, offered: prev.offered }, hit);
  if (!offer) return null;

  const rec = readAnchorOffer(proj, sid);
  const current = ownSessionName(sid, sessionsDir);
  // A session almost always arrives already wearing a name the harness assigned
  // — so "current is not our last offer" does NOT mean the person chose it.
  // Reading it that way silenced the feature permanently for every real
  // session: on the first offer `offered` is null, so any pre-existing name was
  // classified as a deliberate choice and nothing was ever spoken again.
  // A name is the person's only if we have spoken at least once and it is none
  // of the names we composed.
  const declined =
    current && rec.offers.length > 0 && !rec.offers.includes(current) && !rec.declined.includes(current)
      ? [...rec.declined, current]
      : rec.declined;

  const chosen = sessionNameOffer(offer.name, {
    peers: liveSessionNames(sid, sessionsDir),
    current,
    declined,
  });
  // The incumbent moved whether or not we speak, or the same anchor would
  // re-arm and offer again on the next write. But `offered` records what was
  // actually SAID: a name suppressed by the collision ladder was never heard,
  // and burning it would keep this session silent after the peer exits.
  writeAnchorOffer(proj, sid, {
    incumbent: state.incumbent,
    offered: chosen ? chosen.name : rec.offered,
    offers: chosen ? [...new Set([...rec.offers, chosen.name])] : rec.offers,
    declined,
  });
  if (!chosen) return null;
  try {
    appendEntryLog(proj, {
      at: new Date().toISOString(),
      session_id: sid,
      kind: "name-offer",
      name: chosen.name,
    });
  } catch {}
  return sessionNameOfferText(chosen);
}

// The pointer for one call: what its vault files say about this session's epic
// and story (pointerPatchFor), merged in path order, plus the raw-edit
// nudge's throttle for a write. One writeSessionState per call — it is an
// unlocked read-modify-write. A write tool's patch is made on PostToolUse,
// from the files as written: made before the write, it recorded the story's
// old status, and a close is the last touch a story gets (ADR-006 decision 1,
// amended 2026-10-12). Any other tool's (a Read) is made on PreToolUse.
// Returns the nudge's line, or null.
function patchPointer(cfg, proj, sid, vaultPaths, toolName) {
  const cur = readSessionState(proj, sid) || {};
  let patch = null;
  for (const filePath of vaultPaths) {
    const p = pointerPatchFor(cfg.vault_path, filePath, { ...cur, ...patch });
    if (p) patch = { ...(patch || {}), ...p };
  }

  let nudge = null;
  if (isWriteTool(toolName || "") && cfg.guard !== "off") {
    const last = cur.nudged_at ? Date.parse(cur.nudged_at) : 0;
    if (Date.now() - last > NUDGE_INTERVAL_MS) {
      nudge = `projectstore: vault file edited directly — if this bypassed a ${commandForm("*")} command, run ${commandForm("reconcile")} (or doctor) afterwards so the board/indexes stay in sync.`;
      patch = { ...(patch || {}), nudged_at: new Date().toISOString() };
    }
  }

  if (patch) writeSessionState(proj, sid, patch);
  return nudge;
}

// entryBranch's answer when the open-story sweep ran out of time: the caller
// exits once its own output is flushed (see there).
const UNKNOWN = Symbol("unknown");

// The source-side branch (PostToolUse). Never throws: every failure here must
// leave the user's tool call untouched. Returns the reminder's text, UNKNOWN,
// or nothing; the caller emits, so the reminder and the nudge share one line.
async function entryBranch(cfg, proj, sid, filePath, input) {
  // Writes only. extractToolPath happily yields a path for Read, Grep, Glob and
  // LS — all of which carry file_path or path — so without this gate three
  // read-only calls would trip the threshold and the reminder would announce
  // work that never happened. (Grep's `path` is often a directory, which would
  // then be counted as a "source file".) The event tells us the call succeeded;
  // only the tool name tells us it wrote.
  if (!isWriteTool(input.tool_name || "")) return;
  if (!isSourcePath(filePath, proj, cfg.vault_path)) return;

  // Belt and braces. PostToolUse only fires after success — failures raise
  // PostToolUseFailure, which this script is not registered on — so the event
  // itself is the discrimination. Nothing may DEPEND on this field's shape, and
  // the shape varies by BOTH harness and tool: Claude Code sends an object;
  // Codex sent a string for 368 of 371 PostToolUse firings and a content-block
  // array for the other 3, all of them `webrun` (measured 2026-09-07). So the
  // guard is written for "an object with success === false", and every other
  // shape is a pass-through. Narrowed explicitly rather than relying on
  // `"…".success` being undefined — that is an accident of JavaScript, not a
  // decision, and it does not hold for every shape a tool may invent.
  const response = input.tool_response;
  if (response && typeof response === "object" && response.success === false) return;

  registerSourcePath(proj, sid, filePath);

  // Subagents count toward the score but are never the audience: a reminder
  // delivered there reaches an actor mid-implementation under explicit
  // instructions, who cannot open a story.
  if (input.agent_id || input.agent_type) return;
  if (cfg.guard === "off") return;

  const score = entryScore(proj, sid);
  if (score < ENTRY_THRESHOLD) return;
  if (!mayRemind(proj, sid)) return;

  let verdict = readOpenStoryCache(proj, sid);
  if (verdict === null) {
    verdict = await resolveOpenStory(cfg.vault_path);
    writeOpenStoryCache(proj, sid, verdict);
  }
  // Reached either from a fresh sweep that hit its budget with reads still
  // outstanding (the event loop would keep this hook alive until they settle)
  // or from a cached unknown, where nothing is outstanding and the exit is
  // merely redundant. The caller exits — after flushing anything it has to say,
  // since process.exit does not flush pending pipe writes. An unknown verdict
  // suppresses the reminder.
  if (verdict === "unknown") return UNKNOWN;
  if (verdict !== false) return;

  if (!electEmitter(proj, sid)) return;
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: sid, score });
  return entryReminderText(score);
}

// PostToolUse's one line: the nudge as a systemMessage, the entry reminder as
// the event's additionalContext. Null when there is nothing to say.
function postToolUseLine(messages, context) {
  if (!messages.length && !context) return null;
  const out = {};
  if (messages.length) out.systemMessage = [...new Set(messages)].join("\n");
  if (context) out.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: context };
  return JSON.stringify(out) + "\n";
}

async function main() {
  // The payload before the project. On a harness that exports no project-dir
  // variable the payload's cwd is the only answer better than "whatever
  // directory this process started in", and readConfig() resolves through
  // projectRoot() — so anything read before this line answers for the wrong
  // project, silently. Read once: fd 0 is empty on a second read.
  const input = adoptHookInput(readStdinJson());
  if (!input) return;

  const cfg = readConfig();
  if (!cfg) return;

  const sid = input.session_id;
  if (!sid) return;

  const proj = projectRoot();
  const event = input.hook_event_name;

  // Liveness and the vault-side branch stay on PreToolUse, exactly as before.
  // PreToolUse always precedes PostToolUse for the same call, so pinning them
  // here changes nothing about when they run — it only stops them running twice.
  if (event !== "PostToolUse") {
    if (existsSync(sessionFilePath(cfg.vault_path, sid))) {
      touchSession(cfg.vault_path, sid);
    } else {
      // The exemption (contract 23) is passed for agreement with the other
      // caller, not for effect: this branch runs only when our own session file
      // does NOT exist, so there is nothing here to exempt. Two callers of one
      // function disagreeing about its signature is how the next reader
      // concludes the argument is optional.
      cleanupStaleSessions(cfg.vault_path, 24, sid);
      writeSession(cfg.vault_path, sid, proj);
    }
  }

  if (!input.tool_name) return;
  const filePaths = toolPaths(input);
  if (!filePaths.length) return;

  const vaultPaths = filePaths.filter((p) => isInsideVault(p, cfg.vault_path));
  const writes = isWriteTool(input.tool_name || "");

  if (event === "PostToolUse") {
    const messages = [];
    // The same narrowing as entryBranch's: only "an object with success ===
    // false" is a failed call; every other shape passes.
    const response = input.tool_response;
    const failed = response && typeof response === "object" && response.success === false;
    if (writes && !failed && vaultPaths.length) {
      try {
        const nudge = patchPointer(cfg, proj, sid, vaultPaths, input.tool_name);
        if (nudge) messages.push(nudge);
      } catch {}
    }
    let context = null;
    let unknown = false;
    for (const filePath of filePaths) {
      const said = await entryBranch(cfg, proj, sid, filePath, input);
      if (said === UNKNOWN) {
        unknown = true;
        break;
      }
      if (said) context = said;
    }
    const line = postToolUseLine(messages, context);
    if (line) process.stdout.write(line, () => unknown && process.exit(0));
    else if (unknown) process.exit(0);
    return;
  }

  const messages = [];
  // A Read's pointer patch; a write's waits for PostToolUse (patchPointer).
  if (!writes && vaultPaths.length) {
    try {
      patchPointer(cfg, proj, sid, vaultPaths, input.tool_name);
    } catch {}
  }
  for (const filePath of vaultPaths) {
    try {
      appendActivity(cfg.vault_path, sid, filePath, input.tool_name);
    } catch {}
    if (cfg.guard !== "off") {
      try {
        const offer = anchorOffer(
          cfg,
          proj,
          sid,
          filePath,
          input.tool_name,
          Boolean(input.agent_id || input.agent_type),
          process.env.PROJECTSTORE_SESSIONS_DIR || null,
        );
        if (offer) messages.push(offer);
      } catch {}
    }
  }
  if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: [...new Set(messages)].join("\n") }) + "\n");
  }
}

main().catch(() => {
  // A hook must never crash the user's tool call — sync throws and rejected
  // promises alike.
});

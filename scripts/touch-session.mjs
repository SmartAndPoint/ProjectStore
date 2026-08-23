#!/usr/bin/env node
// projectstore — touch-session.mjs
//
// Called by BOTH the PreToolUse and PostToolUse hooks, and gated on which:
// a write inside the vault fires both events, so without the gate the pointer
// patch below would run twice per call — and that patch is the unguarded
// read-modify-write the entry-rule state deliberately avoids.
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  readStdinJson,
  touchSession,
  writeSession,
  cleanupStaleSessions,
  sessionFilePath,
  projectRoot,
  appendActivity,
  isInsideVault,
  parseFrontmatter,
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
  composeAnchorName,
  bumpAnchor,
  readAnchorState,
  readAnchorOffer,
  writeAnchorOffer,
  liveSessionNames,
  ownSessionName,
  sessionNameOffer,
  sessionNameOfferText,
} from "./lib.mjs";

const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

// Per-session active pointer (ADR-006) — denormalized titles/status captured
// at write time so the statusline renders with zero vault reads — plus the
// raw-edit nudge (PS-IMPROVE story-003): throttled, never blocking.
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
  // The two gates. The pointer patch above deliberately has neither: it answers
  // "what am I looking at", for which a Read is a fine answer. A NAME is a
  // claim about what the session is DOING, so a review session that greps
  // thirty files must not be named after them, and a subagent — which shares
  // this session id and cannot accept a name — must not vote on one.
  if (!isWriteTool(toolName || "")) return null;
  if (isSubagent) return null;

  const rel = filePath.slice(cfg.vault_path.length + 1);
  let hit = null;
  try { hit = anchorKeyOf(rel, layoutOnce(cfg)); } catch { return null; }
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
  const { state, offer } = foldAnchor(
    { counts, leaves, incumbent: prev.incumbent, offered: prev.offered }, hit);
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
  const declined = current && rec.offers.length > 0 && !rec.offers.includes(current)
    && !rec.declined.includes(current)
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
      at: new Date().toISOString(), session_id: sid, kind: "name-offer", name: chosen.name,
    });
  } catch {}
  return sessionNameOfferText(chosen);
}

function updatePointerAndNudge(cfg, proj, sid, filePath, toolName) {
  const rel = filePath.slice(cfg.vault_path.length + 1);
  let patch = null;

  const m = rel.match(/^epics\/([^/]+)\//);
  if (m) {
    const epicId = m[1];
    patch = { active_epic: epicId };
    try {
      const { data } = parseFrontmatter(
        readFileSync(join(cfg.vault_path, "epics", epicId, "epic.md"), "utf8"));
      if (data.title) patch.epic_title = String(data.title);
    } catch {}
    const sm = rel.match(/^epics\/[^/]+\/stories\/([^/]+\.md)$/);
    if (sm) {
      patch.active_story = sm[1].replace(/\.md$/, "");
      try {
        const { data } = parseFrontmatter(readFileSync(filePath, "utf8"));
        if (data.title) patch.story_title = String(data.title);
        if (data.status) patch.story_status = String(data.status);
      } catch {}
    }
  }

  let nudge = null;
  if (isWriteTool(toolName || "") && cfg.guard !== "off") {
    const st = readSessionState(proj, sid);
    const last = st && st.nudged_at ? Date.parse(st.nudged_at) : 0;
    if (Date.now() - last > NUDGE_INTERVAL_MS) {
      nudge =
        "projectstore: vault file edited directly — if this bypassed a /projectstore:* command, run /projectstore:reconcile (or doctor) afterwards so the board/indexes stay in sync.";
      patch = { ...(patch || {}), nudged_at: new Date().toISOString() };
    }
  }

  if (patch) writeSessionState(proj, sid, patch);
  return nudge;
}

function extractToolPath(input) {
  if (!input || !input.tool_input) return null;
  const ti = input.tool_input;
  return ti.file_path || ti.notebook_path || ti.path || null;
}

// The source-side branch (PostToolUse). Never throws: every failure here must
// leave the user's tool call untouched.
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
  // itself is the discrimination. Nothing may DEPEND on this field's shape.
  if (input.tool_response && input.tool_response.success === false) return;

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
  if (verdict === "unknown") {
    // Reached either from a fresh sweep that hit its budget with reads still
    // outstanding (the event loop would keep this hook alive until they settle)
    // or from a cached unknown, where nothing is outstanding and the exit is
    // merely redundant. Exiting is safe here and only here: an unknown verdict suppresses the reminder, so stdout is
    // untouched — process.exit does not flush pending pipe writes, and exiting
    // after emitting would truncate the reminder.
    process.exit(0);
  }
  if (verdict !== false) return;

  if (!electEmitter(proj, sid)) return;
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: sid, score });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: entryReminderText(score),
    },
  }) + "\n");
}

async function main() {
  const cfg = readConfig();
  if (!cfg) return;

  const input = readStdinJson();
  if (!input) return;
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
  const filePath = extractToolPath(input);
  if (!filePath) return;

  if (event === "PostToolUse") {
    await entryBranch(cfg, proj, sid, filePath, input);
    return;
  }

  if (isInsideVault(filePath, cfg.vault_path)) {
    try { appendActivity(cfg.vault_path, sid, filePath, input.tool_name); } catch {}
    let nudge = null, offer = null;
    try { nudge = updatePointerAndNudge(cfg, proj, sid, filePath, input.tool_name); } catch {}
    if (cfg.guard !== "off") {
      try {
        offer = anchorOffer(cfg, proj, sid, filePath, input.tool_name,
          Boolean(input.agent_id || input.agent_type),
          process.env.PROJECTSTORE_SESSIONS_DIR || null);
      } catch {}
    }
    // One invocation carries one systemMessage, so the two compose rather than
    // race: emitting twice would silently drop whichever went second, and the
    // offer fires once or twice a session against a nudge that fires every ten
    // minutes — the rare one would be the one lost.
    const lines = [nudge, offer].filter(Boolean);
    if (lines.length) {
      process.stdout.write(JSON.stringify({ systemMessage: lines.join("\n") }) + "\n");
    }
  }
}

main().catch(() => {
  // A hook must never crash the user's tool call — sync throws and rejected
  // promises alike.
});

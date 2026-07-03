#!/usr/bin/env node
// projectstore — touch-session.mjs
//
// Called by the PreToolUse hook on every tool call.
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
} from "./lib.mjs";

const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

// Per-session active pointer (ADR-006) — denormalized titles/status captured
// at write time so the statusline renders with zero vault reads — plus the
// raw-edit nudge (PS-IMPROVE story-003): throttled, never blocking.
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
  if (WRITE_TOOLS.test(toolName || "") && cfg.guard !== "off") {
    const st = readSessionState(proj, sid);
    const last = st && st.nudged_at ? Date.parse(st.nudged_at) : 0;
    if (Date.now() - last > NUDGE_INTERVAL_MS) {
      nudge =
        "projectstore: vault file edited directly — if this bypassed a /projectstore:* command, run /projectstore:reconcile (or doctor) afterwards so the board/indexes stay in sync.";
      patch = { ...(patch || {}), nudged_at: new Date().toISOString() };
    }
  }

  if (patch) writeSessionState(proj, sid, patch);
  if (nudge) process.stdout.write(JSON.stringify({ systemMessage: nudge }) + "\n");
}

function extractToolPath(input) {
  if (!input || !input.tool_input) return null;
  const ti = input.tool_input;
  return ti.file_path || ti.notebook_path || ti.path || null;
}

function main() {
  const cfg = readConfig();
  if (!cfg) return;

  const input = readStdinJson();
  if (!input) return;
  const sid = input.session_id;
  if (!sid) return;

  const proj = projectRoot();
  if (existsSync(sessionFilePath(cfg.vault_path, sid))) {
    touchSession(cfg.vault_path, sid);
  } else {
    cleanupStaleSessions(cfg.vault_path);
    writeSession(cfg.vault_path, sid, proj);
  }

  if (!input.tool_name) return;
  const filePath = extractToolPath(input);
  if (filePath && isInsideVault(filePath, cfg.vault_path)) {
    try { appendActivity(cfg.vault_path, sid, filePath, input.tool_name); } catch {}
    try { updatePointerAndNudge(cfg, proj, sid, filePath, input.tool_name); } catch {}
  }
}

try { main(); } catch {
  // PreToolUse must never crash the user's tool call.
}

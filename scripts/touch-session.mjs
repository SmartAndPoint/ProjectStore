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

import { existsSync } from "node:fs";
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
} from "./lib.mjs";

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
  }
}

try { main(); } catch {
  // PreToolUse must never crash the user's tool call.
}

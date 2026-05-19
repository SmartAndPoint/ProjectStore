#!/usr/bin/env node
// projectstore — touch-session.mjs
//
// Called by the PreToolUse hook on every tool call.
//
// Responsibilities:
// 1. Liveness — touches this session's registration file (mtime) so other
//    sessions can see we are active.
// 2. Self-bootstrap — if the session id file or vault session file is
//    missing (e.g. plugin installed mid-session via /reload-plugins),
//    creates the registration on first call.
// 3. Activity log — reads PreToolUse JSON from stdin, extracts the target
//    file path, and if it lives inside the vault appends an entry to
//    `recent_activity` in the session file (capped at 50, deduped).
//    The PreCompact hook reads this list to build a survival packet.
//
// Silent no-op when no projectstore config is present. Wrapped in
// try/catch so a PreToolUse hook can never crash the user's tool call.

import {
  readConfig,
  readOwnSessionId,
  touchSession,
  generateSessionId,
  writeSession,
  writeOwnSessionId,
  cleanupStaleSessions,
  ensureSessionsDir,
  projectRoot,
  sessionsDir,
  appendActivity,
  isInsideVault,
} from "./lib.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readStdinJson() {
  try {
    // fd 0 = stdin, synchronous read. Hook input is small and complete.
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractToolPath(input) {
  if (!input || !input.tool_input) return null;
  const ti = input.tool_input;
  // Read / Write / Edit / MultiEdit / NotebookEdit all use one of these fields.
  return ti.file_path || ti.notebook_path || ti.path || null;
}

function ensureSession(cfg, proj) {
  let sid = readOwnSessionId(proj);
  const sidFileMissing = !sid;
  const sessionFileMissing =
    sid && !existsSync(join(sessionsDir(cfg.vault_path), `${sid}.json`));
  if (sidFileMissing || sessionFileMissing) {
    cleanupStaleSessions(cfg.vault_path);
    ensureSessionsDir(cfg.vault_path);
    sid = generateSessionId();
    writeSession(cfg.vault_path, sid, proj);
    writeOwnSessionId(proj, sid);
  } else {
    touchSession(cfg.vault_path, sid);
  }
  return sid;
}

function main() {
  const cfg = readConfig();
  if (!cfg) return;

  const proj = projectRoot();
  let sid;
  try {
    sid = ensureSession(cfg, proj);
  } catch {
    return;
  }
  if (!sid) return;

  // Activity logging — best-effort, ignore errors.
  const input = readStdinJson();
  if (!input || !input.tool_name) return;

  const filePath = extractToolPath(input);
  if (filePath && isInsideVault(filePath, cfg.vault_path)) {
    try {
      appendActivity(cfg.vault_path, sid, filePath, input.tool_name);
    } catch {}
  }
}

try {
  main();
} catch {
  // PreToolUse must never crash the user's tool call.
}

#!/usr/bin/env node
// projectstore — touch-session.mjs
//
// Best-effort liveness marker, run by the PreToolUse hook on every tool call.
//
// Self-bootstrapping: if no session ID has been registered yet (e.g. plugin
// was installed mid-session via /reload-plugins, so SessionStart never ran
// for this session), this script creates the registration on first call.
// After that, subsequent calls just touch the existing file so mtime reflects
// real activity.
//
// Silent no-op when no projectstore config is present (so the plugin never
// interferes with projects that don't use it).

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
} from "./lib.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

function main() {
  const cfg = readConfig();
  if (!cfg) return;

  const proj = projectRoot();
  let sid = readOwnSessionId(proj);

  // Re-bootstrap if either marker is missing.
  const sidFileMissing = !sid;
  const sessionFileMissing = sid && !existsSync(join(sessionsDir(cfg.vault_path), `${sid}.json`));

  if (sidFileMissing || sessionFileMissing) {
    try {
      cleanupStaleSessions(cfg.vault_path);
      ensureSessionsDir(cfg.vault_path);
      sid = generateSessionId();
      writeSession(cfg.vault_path, sid, proj);
      writeOwnSessionId(proj, sid);
    } catch {
      // Best-effort; never block a tool call.
      return;
    }
  } else {
    touchSession(cfg.vault_path, sid);
  }
}

try {
  main();
} catch {
  // PreToolUse must never crash the user's tool call.
}

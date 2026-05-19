#!/usr/bin/env node
// projectstore — touch-session.mjs
// Silent best-effort touch of this session's registration file. Run by
// /ps:* commands at start so liveness (mtime) reflects actual activity,
// not just session-start time. No-op if config/sid missing.

import { readConfig, readOwnSessionId, touchSession, projectRoot } from "./lib.mjs";

const cfg = readConfig();
if (!cfg) process.exit(0);
const sid = readOwnSessionId(projectRoot());
if (!sid) process.exit(0);
touchSession(cfg.vault_path, sid);

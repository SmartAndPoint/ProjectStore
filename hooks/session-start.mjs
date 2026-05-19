#!/usr/bin/env node
// projectstore — SessionStart hook.
// 1. Reads .claude/projectstore.json from the project root. If absent or
//    auto_inject=false, silently no-ops.
// 2. (Layer 2 — v0.3) Registers this session in <vault>/.projectstore/
//    sessions/<id>.json, cleans stale entries (>24h), detects other
//    active sessions (mtime < 30min) and prepends a warning to the
//    additionalContext so the agent knows it is not alone on this vault.
// 3. Injects a compact map of the vault (root README + folder READMEs).

import {
  readConfig,
  buildVaultMap,
  generateSessionId,
  writeSession,
  writeOwnSessionId,
  readActiveSessions,
  cleanupStaleSessions,
  projectRoot,
} from "../scripts/lib.mjs";

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }) + "\n",
  );
}

function buildOthersWarning(others) {
  const lines = [
    "",
    "---",
    "",
    `## ⚠️ Multi-session warning — ${others.length} other projectstore session(s) active on this vault`,
    "",
    "Another Claude Code session is currently working on the same vault.",
    "Active session(s):",
    "",
  ];
  for (const s of others) {
    lines.push(
      `- project: \`${s.project_root}\` — started ${s.started_at}, last activity ${s.last_active.toISOString()}`,
    );
  }
  lines.push(
    "",
    "**Before creating new ADRs / epics / stories / research:**",
    "1. Run `/ps:search <topic-keywords>` to check for in-flight artifacts on the same topic.",
    "2. Run `/ps:status` to see what artifacts have been touched recently.",
    "3. After creation, the plugin re-checks file existence right before write — collisions are detected, but topic / number reservation across sessions is on you and the other agent to coordinate.",
    "",
  );
  return lines.join("\n");
}

function main() {
  const cfg = readConfig();
  if (!cfg) process.exit(0);
  if (cfg.auto_inject === false) process.exit(0);

  const proj = projectRoot();

  try {
    let warning = "";
    let sessionId = null;
    try {
      cleanupStaleSessions(cfg.vault_path);
      sessionId = generateSessionId();
      writeSession(cfg.vault_path, sessionId, proj);
      writeOwnSessionId(proj, sessionId);
      const others = readActiveSessions(cfg.vault_path, sessionId);
      if (others.length > 0) warning = buildOthersWarning(others);
    } catch (e) {
      // Session registration failure must not block the vault map.
      warning = `\n\n## projectstore: session registration failed\n\n${e.message}\n`;
    }

    const map = buildVaultMap(cfg);
    emit(map + warning);
  } catch (e) {
    emit(
      `# projectstore: vault load failed\n\n${e.message}\n\nFix \`.claude/projectstore.json\` or run \`/ps:bind <path>\` again.`,
    );
  }
}

main();

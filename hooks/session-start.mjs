#!/usr/bin/env node
// projectstore — SessionStart hook.
// 1. Reads .claude/projectstore.json from the project root. If absent or
//    auto_inject=false, silently no-ops.
// 2. Registers this session in <vault>/.projectstore/sessions/<id>.json,
//    keyed by Claude's own session_id from hook stdin. Cleans stale
//    entries (>24h). Detects other active sessions (mtime < 30min) and
//    appends a warning so the agent knows it is not alone on this vault.
// 3. Injects a compact map of the vault (root README + folder READMEs).

import {
  readConfig,
  buildVaultMap,
  writeSession,
  readActiveSessions,
  cleanupStaleSessions,
  removeLegacySessionIdFile,
  readStdinJson,
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
    "1. Run `/projectstore:search <topic-keywords>` to check for in-flight artifacts on the same topic.",
    "2. Run `/projectstore:status` to see what artifacts have been touched recently.",
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
  const input = readStdinJson();
  const sid = input?.session_id || null;

  let warning = "";
  if (sid) {
    try {
      cleanupStaleSessions(cfg.vault_path);
      writeSession(cfg.vault_path, sid, proj);
      removeLegacySessionIdFile(proj);
      const others = readActiveSessions(cfg.vault_path, sid);
      if (others.length > 0) warning = buildOthersWarning(others);
    } catch (e) {
      warning = `\n\n## projectstore: session registration failed\n\n${e.message}\n`;
    }
  }

  try {
    const map = buildVaultMap(cfg);
    emit(map + warning);
  } catch (e) {
    emit(
      `# projectstore: vault load failed\n\n${e.message}\n\nFix \`.claude/projectstore.json\` or run \`/projectstore:bind <path>\` again.`,
    );
  }
}

main();

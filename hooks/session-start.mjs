#!/usr/bin/env node
// projectstore — SessionStart hook.
// 1. Reads .claude/projectstore.json from the project root. If absent or
//    auto_inject=false, silently no-ops.
// 2. Registers this session in <vault>/.projectstore/sessions/<id>.json,
//    keyed by Claude's own session_id from hook stdin. Cleans stale
//    entries (>24h). Detects other active sessions (mtime < 30min) and
//    appends a warning so the agent knows it is not alone on this vault.
// 3. Injects a compact map of the vault (root README + folder READMEs).

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
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

function welcomedMarkerPath(proj) {
  return join(proj, ".claude", ".projectstore-welcomed");
}

// One-time orientation packet shown when projectstore first loads in a project.
// Idempotent via a marker file at <project>/.claude/.projectstore-welcomed.
function buildWelcome() {
  return [
    "# 👋 projectstore is loaded for the first time in this project",
    "",
    "**What it does**: turns the conversation's decisions into a structured Obsidian-friendly markdown vault — ADRs, epics, stories, runbooks, research. Agent-maintained, you approve every write.",
    "",
    "**To start using it**: run `/projectstore:bind <vault-path>` and point it at an Obsidian vault (or any folder). After that, the agent will pick up commands like `/projectstore:adr` and `/projectstore:epic` from the conversation; you only approve the writes.",
    "",
    "**About future updates**: Claude Code does NOT auto-update third-party marketplaces by default. To get notified of new releases (v0.7+):",
    "1. Open `/plugin` → **Marketplaces** tab.",
    "2. Find **SmartAndPoint**.",
    "3. Toggle **auto-update** on.",
    "",
    "Without it, you'd run `/plugin marketplace update SmartAndPoint` manually. See https://github.com/SmartAndPoint/ProjectStore#updates for details.",
    "",
    "_This message appears once per project._",
    "",
    "_If projectstore helps you ship, a [GitHub star](https://github.com/SmartAndPoint/ProjectStore) helps others discover it. No pressure._",
    "",
  ].join("\n");
}

function showWelcomeOnce(proj) {
  const marker = welcomedMarkerPath(proj);
  if (existsSync(marker)) return "";
  const text = buildWelcome();
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString() + "\n", "utf8");
  } catch {}
  return text;
}

function emit(additionalContext, systemMessage) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  if (systemMessage) out.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(out) + "\n");
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
  const proj = projectRoot();
  const welcome = showWelcomeOnce(proj);
  const welcomeSystemMessage = welcome
    ? "👋 projectstore: first-run welcome shown. Start with /projectstore:bind <vault-path>. See /plugin → Marketplaces to enable auto-update."
    : null;

  if (!cfg) {
    if (welcome) emit(welcome, welcomeSystemMessage);
    process.exit(0);
  }
  if (cfg.auto_inject === false) {
    if (welcome) emit(welcome, welcomeSystemMessage);
    process.exit(0);
  }

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
    emit(welcome + map + warning, welcomeSystemMessage);
  } catch (e) {
    emit(
      welcome +
        `# projectstore: vault load failed\n\n${e.message}\n\nFix \`.claude/projectstore.json\` or run \`/projectstore:bind <path>\` again.`,
      welcomeSystemMessage,
    );
  }
}

main();

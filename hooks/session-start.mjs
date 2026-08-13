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
  syncStatusLine,
  cleanupStaleSessionState,
  armReminder,
} from "../scripts/lib.mjs";
import { runStartupChecks } from "../scripts/doctor.mjs";

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

  // Opt-in status line: keep settings.local.json pointed at this plugin
  // version's statusline.mjs (self-heals on update). Best-effort; a settings
  // write must never break session-context injection.
  try { syncStatusLine(cfg, proj); } catch {}
  // Statusline-feature housekeeping, like syncStatusLine — must run even when
  // auto_inject=false (touch-session writes pointers regardless of it).
  try { cleanupStaleSessionState(proj); } catch {}

  // Read stdin BEFORE the auto_inject gate. The entry reminder's markers must be
  // re-armed after a compaction whether or not this session injects context —
  // an auto_inject=false session still writes code, and its reminder was
  // discarded with the conversation just the same. Below the gate, stdin is
  // never read and `source` is unreachable.
  const input = readStdinJson();
  const sid = input?.session_id || null;
  // `compact` and `clear` are the two sources where the session id survives but
  // the conversation does not, so a reminder already delivered is gone from
  // context while its marker persists on disk. Arming lets it fire once more;
  // the cap of two is enforced by the election, not here.
  if (sid && (input?.source === "compact" || input?.source === "clear")) {
    try { armReminder(proj, sid); } catch {}
  }

  if (cfg.auto_inject === false) {
    if (welcome) emit(welcome, welcomeSystemMessage);
    process.exit(0);
  }

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

  // Cheap install-only doctor subset (ADR-005): one line, only when N > 0;
  // aborted past its budget rather than reporting a false "clean".
  let doctorMsg = null;
  try {
    const r = runStartupChecks(cfg, proj);
    if (r.skipped) {
      doctorMsg = "projectstore doctor: startup checks skipped — run /projectstore:doctor";
    } else if (r.count > 0) {
      doctorMsg = `projectstore doctor: ${r.count} install issue(s) — run /projectstore:doctor`;
    }
  } catch {}
  const systemMessage =
    [welcomeSystemMessage, doctorMsg].filter(Boolean).join(" · ") || null;

  try {
    const map = buildVaultMap(cfg);
    emit(welcome + map + warning, systemMessage);
  } catch (e) {
    emit(
      welcome +
        `# projectstore: vault load failed\n\n${e.message}\n\nFix \`.claude/projectstore.json\` or run \`/projectstore:bind <path>\` again.`,
      systemMessage,
    );
  }
}

main();

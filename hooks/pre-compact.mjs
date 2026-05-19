#!/usr/bin/env node
// projectstore — PreCompact hook.
//
// Fires before context compaction (both manual /compact and automatic).
// Emits a small "survival packet" via additionalContext so the post-compact
// conversation knows:
//   1. There IS a projectstore vault bound to this project (path + layout).
//   2. The plugin's commands are available — pointers to /projectstore:status,
//      /projectstore:search, /projectstore:adr etc.
//   3. The most recent project files THIS session was working with, derived
//      from the session's recent_activity log (maintained by touch-session.mjs).
//   4. An "in-flight artifact" hint when the newest write was a structured
//      artifact (ADR / epic / story / research) — so the agent can resume
//      drafting from where it left off.
//
// Silent no-op when no projectstore config is present.

import {
  readConfig,
  readOwnSessionId,
  readSessionActivity,
  projectRoot,
} from "../scripts/lib.mjs";

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext,
      },
    }) + "\n",
  );
}

function relativeToVault(absPath, vault) {
  if (absPath.startsWith(vault + "/")) return absPath.slice(vault.length + 1);
  return absPath;
}

const STRUCTURED_ARTIFACT_RX = /\/(adr|epics|research|concepts|meetings|ops|diagrams)\//;

function main() {
  const cfg = readConfig();
  if (!cfg) process.exit(0);

  const proj = projectRoot();
  const sid = readOwnSessionId(proj);
  const activity = sid ? readSessionActivity(cfg.vault_path, sid) : [];

  const lines = [];
  lines.push("# Projectstore — compact survival packet");
  lines.push("");
  lines.push(
    `This conversation is bound to a **projectstore vault** at \`${cfg.vault_path}\` (layout: \`${cfg.layout}\`, language: \`${cfg.language || "en"}\`).`,
  );
  lines.push("");
  lines.push("**Available commands** (use them instead of re-deriving structure from scratch):");
  lines.push(
    "- `/projectstore:status` — recap of bound vault, recent activity, active sessions.",
  );
  lines.push("- `/projectstore:search <query>` — grep the vault.");
  lines.push(
    "- `/projectstore:adr`, `/projectstore:epic`, `/projectstore:story`, `/projectstore:research`, `/projectstore:concept`, `/projectstore:meeting`, `/projectstore:runbook` — create new artifacts (with approval gate).",
  );
  lines.push(
    "- `/projectstore:review <path>` — peer-review an existing artifact (fresh critic).",
  );
  lines.push("- `/projectstore:kanban` — regenerate the kanban from story frontmatter.");

  if (activity.length > 0) {
    const recent = activity.slice(0, 15);
    lines.push("");
    lines.push(`## Recent project files this session worked with (${recent.length}, newest first)`);
    lines.push("");
    for (const a of recent) {
      const rel = relativeToVault(a.path, cfg.vault_path);
      lines.push(`- \`${rel}\` — ${a.tool} at ${a.at}`);
    }

    // In-flight artifact hint.
    const newestWrite = recent.find(
      (a) =>
        (a.tool === "Write" || a.tool === "Edit" || a.tool === "MultiEdit") &&
        STRUCTURED_ARTIFACT_RX.test(a.path),
    );
    if (newestWrite) {
      const rel = relativeToVault(newestWrite.path, cfg.vault_path);
      lines.push("");
      lines.push(
        `**In-flight artifact**: \`${rel}\` was the newest structured write before compaction. If we were drafting it, continue from there. Run \`/projectstore:status\` if more context is needed.`,
      );
    }
  } else {
    lines.push("");
    lines.push(
      "No per-session activity log yet. If this session has been doing vault work, run `/projectstore:status` to see what is in the vault and what was recently touched by any session.",
    );
  }

  emit(lines.join("\n"));
}

try {
  main();
} catch (e) {
  emit(`# Projectstore: PreCompact survival packet failed\n\n${e.message}`);
}

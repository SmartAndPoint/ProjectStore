#!/usr/bin/env node
// projectstore — PreCompact hook.
//
// Fires before context compaction (both manual /compact and automatic).
// Emits a "survival packet" so the post-compact conversation still knows:
//   1. There IS a projectstore vault bound to this project (path + layout).
//   2. The plugin's /projectstore:* commands are available.
//   3. The most recent project files THIS session was working with,
//      derived from the session's recent_activity log (populated by
//      touch-session.mjs from PreToolUse events).
//   4. An "in-flight artifact" hint when the newest write was a
//      structured artifact (ADR / epic / story / research / ...).
//
// Two channels are used:
//   - `additionalContext` — full markdown packet, injected into the
//     post-compact conversation (agent-facing).
//   - `systemMessage` — one short line shown in the user's /compact
//     stdout so the user has visible confirmation the hook ran.
//
// Session identity comes from Claude's own session_id in stdin input
// (so two Claude instances on the same project don't share activity).
// Silent no-op when no projectstore config is present.

import { basename } from "node:path";
import {
  readConfig,
  readStdinJson,
  readSessionActivity,
} from "../scripts/lib.mjs";

function emit(systemMessage, additionalContext) {
  process.stdout.write(
    JSON.stringify({
      systemMessage,
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

  const input = readStdinJson();
  const sid = input?.session_id || null;
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

  let inFlight = null;
  if (activity.length > 0) {
    const recent = activity.slice(0, 15);
    lines.push("");
    lines.push(`## Recent project files this session worked with (${recent.length}, newest first)`);
    lines.push("");
    for (const a of recent) {
      const rel = relativeToVault(a.path, cfg.vault_path);
      lines.push(`- \`${rel}\` — ${a.tool} at ${a.at}`);
    }

    const newestWrite = recent.find(
      (a) =>
        (a.tool === "Write" || a.tool === "Edit" || a.tool === "MultiEdit") &&
        STRUCTURED_ARTIFACT_RX.test(a.path),
    );
    if (newestWrite) {
      inFlight = relativeToVault(newestWrite.path, cfg.vault_path);
      lines.push("");
      lines.push(
        `**In-flight artifact**: \`${inFlight}\` was the newest structured write before compaction. If we were drafting it, continue from there. Run \`/projectstore:status\` if more context is needed.`,
      );
    }
  } else {
    lines.push("");
    lines.push(
      "No per-session activity log yet. If this session has been doing vault work, run `/projectstore:status` to see what is in the vault and what was recently touched by any session.",
    );
  }

  const summaryParts = [
    `vault ${basename(cfg.vault_path)}`,
    `layout ${cfg.layout}`,
    `${activity.length} recent file(s)`,
  ];
  if (inFlight) summaryParts.push(`in-flight: ${inFlight}`);
  const systemMessage = `projectstore: survival packet injected — ${summaryParts.join(", ")}`;

  emit(systemMessage, lines.join("\n"));
}

try {
  main();
} catch (e) {
  emit(
    `projectstore: PreCompact hook failed — ${e.message}`,
    `# Projectstore: PreCompact survival packet failed\n\n${e.message}`,
  );
}

#!/usr/bin/env node
// projectstore — SessionStart hook.
// Reads .claude/projectstore.json from the project root. If present and auto_inject=true,
// injects a compact map of the vault (root README + folder READMEs) into the session context.
// Silent no-op when no config is present (so the plugin never bothers projects that don't use it).

import { readConfig, buildVaultMap } from "../scripts/lib.mjs";

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

function main() {
  const cfg = readConfig();
  if (!cfg) {
    // No bind in this project — silently exit.
    process.exit(0);
  }
  if (cfg.auto_inject === false) {
    process.exit(0);
  }

  try {
    const map = buildVaultMap(cfg);
    emit(map);
  } catch (e) {
    // Never crash a Claude session because of a misconfigured vault.
    // Surface the error as context so the user can fix it, but don't block startup.
    emit(`# projectstore: vault load failed\n\n${e.message}\n\nFix \`.claude/projectstore.json\` or run \`/ps:bind <path>\` again.`);
  }
}

main();

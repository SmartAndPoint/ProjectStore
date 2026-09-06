---
description: Enable/disable the projectstore status line (current epic & story in the HUD). Flips a flag and runs the install verb, which wires it behind a preview; the SessionStart hook keeps an existing entry current across plugin updates.
argument-hint: "on | off | status"
---

You are toggling the projectstore status line for THIS project. When enabled, `install-harness.mjs` points the project's `.claude/settings.local.json` at a launcher it writes at `.projectstore/state/claude-code/statusline.mjs`. That path carries no version, so it never goes stale: the launcher resolves the *currently installed* plugin on every render, and an update is reflected on the spot instead of one restart later. (A dev checkout or `--plugin-dir` root is wired straight to its `scripts/statusline.mjs` — those paths have no version to drift.) The line renders `[PS#<version>] 📚 <epic> › <story> (<status>)` **composed above** any existing HUD (e.g. oh-my-claudecode), never replacing it.

Resolution is **per-session with zero cross-session and zero vault reads** (ADR-006): the 📚 segment comes from this session's pointer (`.projectstore/state/sessions/<session_id>.json`, maintained by the PreToolUse hook); a fresh session shows an explicit localized cold-start line ("No epic or story in this session yet" / «Эпик и стори ещё не в работе в этой сессии») — never a silent blank; a corrupt pointer shows an error-marked string. Strings localize via `templates/<lang>/strings.json` (en fallback). The version badge is controlled by `statusline.show_version` (default true).

This command flips the flag in `.projectstore/projectstore.json` and then runs the install verb, which writes `settings.local.json` and the launcher behind a preview. The SessionStart hook only refreshes an entry that is already ours and removes it when the flag is off — it never creates one.

## 1. Require a bound project

Read `.projectstore/projectstore.json`. If missing → "No vault bound. Run `/projectstore:bind <vault-path>` first." and stop. (The epic/story segment needs a vault.)

## 2. Parse `$ARGUMENTS`

- `on` (or empty) — enable.
- `off` — disable.
- `status` — report only; modify nothing.

## 3. `on`

1. **Foreign status line check** (read-only): read `.claude/settings.local.json` if present. If it has a `statusLine` whose `command` is **not** ours (ours contains either `.projectstore/state/<harness>/statusline.mjs` — the launcher; a not-yet-migrated project's legacy launcher is `.claude/.projectstore/statusline.mjs`, also ours — or `scripts/statusline.mjs` — an older or dev wiring), warn — the hook will **not** clobber a foreign local status line, so enabling would silently do nothing (and `statusline.mjs` composes only over a base in `.claude/settings.json` or `~/.claude/settings.json`, never one in `settings.local.json`). AskUserQuestion: **Proceed anyway / Help me clear it / Cancel**. If a base HUD lives in `~/.claude/settings.json` (e.g. oh-my-claudecode), that's fine — we compose over it; no warning needed.
2. **AskUserQuestion** (Yes / No): "Wire the status line for this project?" On Yes, run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" install --harness claude-code --surface statusline --project "${CLAUDE_PROJECT_DIR}"` and print its output verbatim — it previews and writes the `statusLine` entry and the launcher (`.projectstore/state/claude-code/statusline.mjs`, provenance-stamped). A non-zero exit is a refusal (a foreign status line, an unparseable settings file) — relay it and stop, leaving the flag as it was.
3. On success, read `.projectstore/projectstore.json`, set `statusline.enabled = true`. **Preserve `statusline.position`** if present (don't drop it); keep all other keys. Preview the change, then Write.
4. Report: "Enabled. `📚 <epic> › <story>` renders above your existing HUD. **Restart Claude Code in this project** to apply now (statusLine loads at session start). If `.claude/settings.local.json` is tracked in git, add it to `.gitignore` — the entry carries a machine-specific absolute path."

## 4. `off`

1. **AskUserQuestion** (Yes / No): "Remove the projectstore status line from this project?" On Yes, read `.projectstore/projectstore.json` and set `statusline.enabled = false` (keep `statusline.position` + other keys) — write it **even if the flag was absent**, so the hook removes any managed `statusLine` entry it previously wrote. Preview, then Write.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" uninstall --harness claude-code --surface statusline --project "${CLAUDE_PROJECT_DIR}"` and print its output — it removes our `statusLine` entry and the launcher, previewed, and leaves a foreign entry alone.
3. Report: "Disabled; restart to apply."

## 5. `status`

Report, read-only:
- `.projectstore/projectstore.json` → `statusline.enabled` and `statusline.position` (default `above`).
- `.claude/settings.local.json` → whether `statusLine` is present and ours (`command` contains `.projectstore/state/<harness>/statusline.mjs`, the legacy `.claude/.projectstore/statusline.mjs` of a not-yet-migrated project, or `scripts/statusline.mjs`), foreign, or absent. A `scripts/…` command inside the plugin cache is the pre-v0.16 pinned wiring — the hook replaces it with the launcher on the next session start.
- `.claude/settings.json`, else `~/.claude/settings.json` → `statusLine.command` = the base HUD we compose over (or "none — standalone line").

## Notes

- Every write goes through AskUserQuestion. Never write without approval.
- The command writes `.projectstore/projectstore.json` and runs the install verb for the `statusline` surface; the SessionStart hook only refreshes an entry that is already ours (and removes it when the flag is off) — it never creates one, and never touches a foreign status line.
- Config shape: `.projectstore/projectstore.json` → `"statusline": { "enabled": true, "position": "above", "show_version": true }`. `position` is `above` (default) or `below` — the side our 📚 line sits relative to the base HUD; `show_version` toggles the `[PS#…]` badge.

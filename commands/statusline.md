---
description: Enable/disable the projectstore status line (current epic & story in the HUD). Runs `configure --set statusline=on|off`, which records the flag and wires or removes the entry behind a preview; the SessionStart hook keeps an existing entry current across plugin updates.
argument-hint: "on | off | status"
---

You are toggling the projectstore status line for THIS project. When enabled, `install-harness.mjs` points the project's `.claude/settings.local.json` at a launcher it writes at `.projectstore/state/claude-code/statusline.mjs`. That path carries no version, so it never goes stale: the launcher resolves the *currently installed* plugin on every render, and an update is reflected on the spot instead of one restart later. (A dev checkout or `--plugin-dir` root is wired straight to its `scripts/statusline.mjs` — those paths have no version to drift.) The line renders `[PS#<version>] 📚 <epic> › <story> (<status>)` **composed above** any existing HUD (e.g. oh-my-claudecode), never replacing it. While this session's band above the prompt is drawing (`/projectstore:bar`), the line gives way to it — your base HUD stays — and it comes back within 30 s of the band stopping.

Resolution is **per-session with zero cross-session and zero vault reads** (ADR-006): the 📚 segment comes from this session's pointer (`.projectstore/state/sessions/<session_id>.json`, maintained by the tool hooks — a write's patch after the write — by `story close`, and at session start; a done, closed or parked story leaves the segment); a fresh session shows an explicit localized cold-start line ("No epic or story in this session yet" / «Эпик и стори ещё не в работе в этой сессии») — never a silent blank; a corrupt pointer shows an error-marked string. Strings localize via `templates/<lang>/strings.json` (en fallback). The version badge is controlled by `statusline.show_version` (default true).

This command runs `configure --set statusline=on|off` (the configure spec, contracts 6 and 9): install's own items record `statusline.enabled` and write or remove the `settings.local.json` entry and the launcher, in one plan. The command never writes `projectstore.json` itself. The SessionStart hook only refreshes an entry that is already ours and removes it when the flag is off — it never creates one.

## 1. Require a bound project

Read `.projectstore/projectstore.json`. If missing → "No vault bound. Run `/projectstore:bind <vault-path>` first." and stop. (The epic/story segment needs a vault.)

## 2. Parse `$ARGUMENTS`

- `on` (or empty) — enable.
- `off` — disable.
- `status` — report only; modify nothing.

## 3. `on`

1. **Foreign status line check** (read-only): read `.claude/settings.local.json` if present. If it has a `statusLine` whose `command` is **not** ours (ours contains either `.projectstore/state/<harness>/statusline.mjs` — the launcher; a not-yet-migrated project's legacy launcher is `.claude/.projectstore/statusline.mjs`, also ours — or `scripts/statusline.mjs` — an older or dev wiring), warn — configure refuses to enable over a foreign local status line (and `statusline.mjs` composes only over a base in `.claude/settings.json` or `~/.claude/settings.json`, never one in `settings.local.json`). AskUserQuestion: **Help me clear it / Cancel**. If a base HUD lives in `~/.claude/settings.json` (e.g. oh-my-claudecode), that's fine — we compose over it; no warning needed.
2. **Preview**: run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" configure --set statusline=on --dry-run --project "${CLAUDE_PROJECT_DIR}"` and print its PLAN. A non-zero exit is a refusal — relay it and stop; nothing is asked or written.
3. **AskUserQuestion** (Yes / No): "Wire the status line for this project?" On Yes, run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" configure --set statusline=on --project "${CLAUDE_PROJECT_DIR}"` and print its output verbatim — it records `statusline.enabled: true` (keeping `statusline.position` and every other key) and writes the `statusLine` entry and the launcher (`.projectstore/state/claude-code/statusline.mjs`, provenance-stamped), in one plan. A non-zero exit is a refusal (a foreign status line, an unparseable settings file, a layout still to move) — relay it and stop; nothing was written.
4. Report: "Enabled. `📚 <epic> › <story>` renders above your existing HUD. **Restart Claude Code in this project** to apply now (statusLine loads at session start). If `.claude/settings.local.json` is tracked in git, add it to `.gitignore` — the entry carries a machine-specific absolute path."

## 4. `off`

1. **Preview**: run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" configure --set statusline=off --dry-run --project "${CLAUDE_PROJECT_DIR}"` and print its PLAN. A non-zero exit is a refusal — relay it and stop.
2. **AskUserQuestion** (Yes / No): "Remove the projectstore status line from this project?" On Yes, run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" configure --set statusline=off --project "${CLAUDE_PROJECT_DIR}"` and print its output — it records `statusline.enabled: false` (even if the flag was absent, so the hook keeps it off) and removes our `statusLine` entry and the launcher, and leaves a foreign entry alone.
3. Report: "Disabled; restart to apply."

## 5. `status`

Report, read-only:
- `.projectstore/projectstore.json` → `statusline.enabled` and `statusline.position` (default `above`).
- `.claude/settings.local.json` → whether `statusLine` is present and ours (`command` contains `.projectstore/state/<harness>/statusline.mjs`, the legacy `.claude/.projectstore/statusline.mjs` of a not-yet-migrated project, or `scripts/statusline.mjs`), foreign, or absent. A `scripts/…` command inside the plugin cache is the pre-v0.16 pinned wiring — the hook replaces it with the launcher on the next session start.
- `.claude/settings.json`, else `~/.claude/settings.json` → `statusLine.command` = the base HUD we compose over (or "none — standalone line").

## Notes

- Every write goes through AskUserQuestion. Never write without approval.
- The command runs `configure --set statusline=on|off`, whose install items are the flag's one writer; the SessionStart hook only refreshes an entry that is already ours (and removes it when the flag is off) — it never creates one, and never touches a foreign status line.
- Config shape: `.projectstore/projectstore.json` → `"statusline": { "enabled": true, "position": "above", "show_version": true }`. `position` is `above` (default) or `below` — the side our 📚 line sits relative to the base HUD; `show_version` toggles the `[PS#…]` badge.

---
description: Enable/disable the projectstore status line (current epic & story in the HUD). Flips a flag; the SessionStart hook does the wiring and keeps it current across plugin updates.
argument-hint: "on | off | status"
---

You are toggling the projectstore status line for THIS project. When enabled, the **SessionStart hook** keeps the project's `.claude/settings.local.json` pointed at a launcher it generates at `.claude/.projectstore/statusline.mjs`. That path carries no version, so it never goes stale: the launcher resolves the *currently installed* plugin on every render, and an update is reflected on the spot instead of one restart later. (A dev checkout or `--plugin-dir` root is wired straight to its `scripts/statusline.mjs` — those paths have no version to drift.) The line renders `[PS#<version>] 📚 <epic> › <story> (<status>)` **composed above** any existing HUD (e.g. oh-my-claudecode), never replacing it.

Resolution is **per-session with zero cross-session and zero vault reads** (ADR-006): the 📚 segment comes from this session's pointer (`.claude/.projectstore/state/<session_id>.json`, maintained by the PreToolUse hook); a fresh session shows an explicit localized cold-start line ("No epic or story in this session yet" / «Эпик и стори ещё не в работе в этой сессии») — never a silent blank; a corrupt pointer shows an error-marked string. Strings localize via `templates/<lang>/strings.json` (en fallback). The version badge is controlled by `statusline.show_version` (default true).

This command itself only flips a flag in `.claude/projectstore.json` — it does **not** touch `settings.local.json`; the hook owns that file.

## 1. Require a bound project

Read `.claude/projectstore.json`. If missing → "No vault bound. Run `/projectstore:bind <vault-path>` first." and stop. (The epic/story segment needs a vault.)

## 2. Parse `$ARGUMENTS`

- `on` (or empty) — enable.
- `off` — disable.
- `status` — report only; modify nothing.

## 3. `on`

1. **Foreign status line check** (read-only): read `.claude/settings.local.json` if present. If it has a `statusLine` whose `command` is **not** ours (ours contains either `.projectstore/statusline.mjs` — the launcher — or `scripts/statusline.mjs` — an older or dev wiring), warn — the hook will **not** clobber a foreign local status line, so enabling would silently do nothing (and `statusline.mjs` composes only over a base in `.claude/settings.json` or `~/.claude/settings.json`, never one in `settings.local.json`). AskUserQuestion: **Proceed anyway / Help me clear it / Cancel**. If a base HUD lives in `~/.claude/settings.json` (e.g. oh-my-claudecode), that's fine — we compose over it; no warning needed.
2. Read `.claude/projectstore.json`, set `statusline.enabled = true`. **Preserve `statusline.position`** if present (don't drop it); keep all other keys. Preview the change + **AskUserQuestion** (Yes / No), then Write.
3. Report: "Enabled. On the next session start the hook wires `📚 <epic> › <story>` above your existing HUD. **Restart Claude Code in this project** to apply now (statusLine loads at session start). If `.claude/settings.local.json` is tracked in git, add it to `.gitignore` — the hook bakes a machine-specific absolute path."

## 4. `off`

1. Read `.claude/projectstore.json`. Set `statusline.enabled = false` (keep `statusline.position` + other keys) — write it **even if the flag was absent**, so the hook will remove any managed `statusLine` entry it previously wrote (e.g. an install carried over from an older projectstore version). Preview + AskUserQuestion, then Write.
2. Report: "Disabled. On next session start the hook removes its `statusLine` entry from `settings.local.json` and deletes the generated `.claude/.projectstore/statusline.mjs`; restart to apply."

## 5. `status`

Report, read-only:
- `.claude/projectstore.json` → `statusline.enabled` and `statusline.position` (default `above`).
- `.claude/settings.local.json` → whether `statusLine` is present and ours (`command` contains `.projectstore/statusline.mjs` or `scripts/statusline.mjs`), foreign, or absent. A `scripts/…` command inside the plugin cache is the pre-v0.16 pinned wiring — the hook replaces it with the launcher on the next session start.
- `.claude/settings.json`, else `~/.claude/settings.json` → `statusLine.command` = the base HUD we compose over (or "none — standalone line").

## Notes

- Every write goes through AskUserQuestion. Never write without approval.
- The command writes only `.claude/projectstore.json`; the SessionStart hook reconciles `settings.local.json` (create/refresh/remove our entry) idempotently and never touches a foreign status line.
- Config shape: `.claude/projectstore.json` → `"statusline": { "enabled": true, "position": "above", "show_version": true }`. `position` is `above` (default) or `below` — the side our 📚 line sits relative to the base HUD; `show_version` toggles the `[PS#…]` badge.

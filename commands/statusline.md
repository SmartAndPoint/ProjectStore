---
description: Enable/disable the projectstore status line (current epic & story in the HUD). Composes above an existing status line (e.g. oh-my-claudecode) instead of replacing it.
argument-hint: "on | off | status"
---

You are configuring the projectstore status line for THIS project. It shows the epic & story the agent is touching this session, composed **above** any existing status line: `scripts/statusline.mjs` delegates to the base `statusLine` command in your `settings.json`, prints its output verbatim, and adds one `📚 <epic> › <story>` line.

`statusLine` is **not** plugin-declarable, so this writes a `statusLine` entry into the **project's `.claude/settings.local.json`** (local scope, highest precedence, conventionally git-ignored — it overrides a global HUD ONLY in this project, and reverts cleanly). If the project tracks `.claude/settings.local.json` in git, tell the user (the baked absolute path is machine-specific and shouldn't be committed).

## 1. Parse `$ARGUMENTS`

- `on` (or empty) — install / refresh the status line.
- `off` — remove it.
- `status` — report current state; modify nothing.

## 2. Resolve paths

```bash
echo "SCRIPT=$CLAUDE_PLUGIN_ROOT/scripts/statusline.mjs"
echo "SETTINGS=${CLAUDE_PROJECT_DIR:-$PWD}/.claude/settings.local.json"
```

The `statusLine.command` MUST be a baked absolute path — `${CLAUDE_PLUGIN_ROOT}` is not expanded in `statusLine.command` (unlike in hooks). Build the command as `node "<SCRIPT>"` and **keep the inner quotes** — the plugin path may contain spaces, and `statusLine.command` runs in a shell.

## 3. `on`

1. Read `SETTINGS` if it exists and `JSON.parse` it; keep **all** existing keys. If absent, start from `{}`.
2. Inspect the existing `statusLine`:
   - **Absent** → proceed.
   - **Already ours** (`command` contains `scripts/statusline.mjs`) → tell the user it's already on; offer `off`. Stop.
   - **A different local status line** → warn: the wrapper composes over a base command found in `~/.claude/settings.json` or `<project>/.claude/settings.json`, but NOT one already sitting in `settings.local.json`; replacing it here drops that local line. Ask via AskUserQuestion: **Replace / Cancel**.
3. Set (preserving other keys) — note the escaped inner quotes around the path:
   ```json
   "statusLine": { "type": "command", "command": "node \"<SCRIPT>\"" }
   ```
4. **Preview** the full resulting file + path. **AskUserQuestion**: Yes / No.
5. On **Yes** → create `.claude/` if needed and Write the file.
6. Report: "Status line wired. `📚 <epic> › <story>` will appear above your existing HUD once this session touches an epic/story. statusLine loads at session start — if it doesn't show, restart Claude Code in this project."

## 4. `off`

1. Read `SETTINGS`. No `statusLine` → say "already off"; stop.
2. If `statusLine` is **not** ours → AskUserQuestion before removing (**Remove / Cancel**).
3. Remove only the `statusLine` key; keep the rest. Preview + AskUserQuestion, then Write. (If the object becomes `{}`, leaving `{}` is fine.)
4. Confirm removed; note a restart may be needed.

## 5. `status`

Read `SETTINGS` and report: is `statusLine` present, and is it ours (`command` contains `scripts/statusline.mjs`)? Then read `~/.claude/settings.json` → `statusLine.command` and report the base HUD it will compose over (or "none — standalone line").

## Notes

- Every settings write goes through AskUserQuestion. Never write without approval.
- The status line works without a bound vault (it shows the base line / passes the base HUD through); the `📚 epic › story` segment appears only in a projectstore-bound project after the session touches an epic/story.
- Position of our line (`above` / `below` the base HUD) is read from `.claude/projectstore.json` → `statusline.position` (default `above`).

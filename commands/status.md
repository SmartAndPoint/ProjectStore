---
description: Show what's bound, the active layout, and recent vault activity.
---

You are summarizing the projectstore binding and recent vault activity.

Steps:

1. Read `.claude/projectstore.json`. If missing, output: "No vault bound. Run `/projectstore:bind <vault-path>` first." and stop.
2. Print: vault path, layout, language, auto_inject, approval_mode.
3. Run `ls -la "<vault_path>"` and confirm the layout folders exist; mark any missing folder.
4. Run `find "<vault_path>" -name "*.md" -type f -mtime -7 -not -path "*/node_modules/*" | head -20` to list files touched in the last 7 days.
5. Group those by folder, print as a compact list with mtime.
6. If a `kanban.md` exists at vault root, count items per column and print a one-line summary like "Kanban: Backlog 7 | ToDo 2 | In Progress 1 | Review 0 | Done 12".
7. **Show active sessions** (Layer 2):
   - List session files in `<vault>/.projectstore/sessions/*.json` with mtime within the last 30 minutes.
   - For each, print: `id`, `project_root`, `started_at`, and how long ago it was last active.
   - Note: from inside a slash command we cannot reliably identify which entry is the current session (Claude's `session_id` is only available to hooks, not commands). The user can match by `project_root` and timestamps if multiple are listed.
   - If multiple sessions: warn "⚠️ Coordinate via /projectstore:search before creating new artifacts to avoid topic collisions (identity is the slug — ADR-010; the draft's `collision` field catches clashes at creation time)."
8. Suggest the next command based on what's missing (e.g., "Vault looks empty — try `/projectstore:scaffold`" or "Stale kanban — try `/projectstore:kanban`").

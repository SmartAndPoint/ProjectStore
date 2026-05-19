---
description: Show what's bound, the active layout, and recent vault activity.
---

You are summarizing the projectstore binding and recent vault activity.

Steps:

1. Read `.claude/projectstore.json`. If missing, output: "No vault bound. Run `/ps:bind <vault-path>` first." and stop.
2. Print: vault path, layout, language, auto_inject, approval_mode.
3. Run `ls -la "<vault_path>"` and confirm the layout folders exist; mark any missing folder.
4. Run `find "<vault_path>" -name "*.md" -type f -mtime -7 -not -path "*/node_modules/*" | head -20` to list files touched in the last 7 days.
5. Group those by folder, print as a compact list with mtime.
6. If a `kanban.md` exists at vault root, count items per column and print a one-line summary like "Kanban: Backlog 7 | ToDo 2 | In Progress 1 | Review 0 | Done 12".
7. **Show active sessions** (Layer 2):
   - List session files in `<vault>/.projectstore/sessions/*.json` with mtime within the last 30 minutes.
   - For each, print: `project_root` and how long ago it was last active.
   - Mark this session's own file (read id from `.claude/.projectstore-session-id`) as `(this session)`.
   - If multiple sessions: warn "⚠️ Coordinate via /ps:search before creating new artifacts to avoid topic / number collisions."
8. Suggest the next command based on what's missing (e.g., "Vault looks empty — try `/ps:scaffold`" or "Stale kanban — try `/ps:kanban`").

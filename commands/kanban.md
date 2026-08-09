---
description: Regenerate the kanban board from story frontmatter (status, priority, title).
---

You are regenerating the kanban board.

Steps:

1. **Check config**. Stop if missing.

2. **Compute** (read-only, the unified reconcile path):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --only kanban
   ```

   The `kanban` entry carries `{ path, changed, content?, stats }`.

3. **Show stats**: print `stats.total` (total stories) and `stats.by_column`
   (how many in each column). If `changed` is false, report "board already
   matches frontmatter" and stop.

4. **Diff preview**: if `<vault>/kanban.md` already exists, read it and show a brief textual diff vs the generated content (count of added/removed lines per column is enough). If it doesn't exist, just preview the first column.

5. **Approval** via AskUserQuestion:
   - **Yes** — regenerate the board (content is recomputed from story
     frontmatter at write time; the preview is advisory)
   - **No** — abort, keep current file

6. **On Yes**: apply through the core — never the Write tool:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --write --only kanban
   ```

   The write is atomic (temp + rename) and recomputed at write time. Render
   the report's `kanban` entry; its `stats` mirror step 3. Nonzero exit —
   surface the `error`.

7. **Final**: confirm and suggest opening the file in Obsidian (the `kanban-plugin: board` frontmatter triggers the Kanban view automatically).

---
description: Regenerate the kanban board from story frontmatter (status, priority, title).
---

You are regenerating the kanban board.

Steps:

1. **Check config**. Stop if missing.

2. **Run the generator**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/kanban.mjs"
   ```

   Output JSON: `{ path, content, stats }`.

3. **Show stats**: print `stats.total` (total stories) and `stats.by_column` (how many in each column).

4. **Diff preview**: if `<vault>/kanban.md` already exists, read it and show a brief textual diff vs the generated content (count of added/removed lines per column is enough). If it doesn't exist, just preview the first column.

5. **Approval** via AskUserQuestion:
   - **Yes** — overwrite the kanban file
   - **No** — abort, keep current file

6. **On Yes**: Write the generated content to `path`.

7. **Final**: confirm and suggest opening the file in Obsidian (the `kanban-plugin: board` frontmatter triggers the Kanban view automatically).

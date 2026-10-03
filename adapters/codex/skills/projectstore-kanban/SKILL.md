---
name: projectstore-kanban
description: "Regenerate the kanban board from story frontmatter (status, priority, title)."
---

## Runtime path

Resolve paths from this skill's own directory, never from the checkout or a
remembered cache path. The plugin root is two directories above this SKILL.md;
the bundled core is `<plugin-root>/node_modules/projectstore`. Before running
any ProjectStore command, export `PROJECTSTORE_CORE_ROOT` to that bundled-core
path in its own shell statement, then use `node "${PROJECTSTORE_CORE_ROOT}/…"`.
Do not prefix the command with the assignment: a shell expands the quoted path
before that inline assignment takes effect. If the bundled core is missing, stop
and report a broken plugin install; do not fetch a different version from npm.

## User arguments

The source command's host-substituted argument token is rendered here as
`<user-arguments>` (or `<user-arguments-without-fix>`). Before executing a
shown command, replace that token with the actual arguments from the user's
request and shell-quote values safely. Never pass the angle-bracket token
literally and never treat it as a shell variable.

You are regenerating the kanban board.

Steps:

1. **Check config**. Stop if missing.

2. **Compute** (read-only, the unified reconcile path):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --only kanban
   ```

   The `kanban` entry carries `{ path, changed, content?, stats }`.

3. **Show stats**: print `stats.total` (total stories) and `stats.by_column`
   (how many in each column). If `changed` is false, report "board already
   matches frontmatter" and stop.

4. **Diff preview**: if `<vault>/kanban.md` already exists, read it and show a brief textual diff vs the generated content (count of added/removed lines per column is enough). If it doesn't exist, just preview the first column.

5. **Approval** via the harness's user-input mechanism:
   - **Yes** — regenerate the board (content is recomputed from story
     frontmatter at write time; the preview is advisory)
   - **No** — abort, keep current file

6. **On Yes**: apply through the core — never the file-writing tool:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only kanban
   ```

   The write is atomic (temp + rename) and recomputed at write time. Render
   the report's `kanban` entry; its `stats` mirror step 3. Nonzero exit —
   surface the `error`.

7. **Final**: confirm and suggest opening the file in Obsidian (the `kanban-plugin: board` frontmatter triggers the Kanban view automatically).

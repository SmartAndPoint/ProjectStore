---
description: Create a new Architecture Decision Record (ADR) in the bound vault.
argument-hint: <title>
---

You are creating a new ADR.

Steps:

1. **Check config**: `test -f .claude/projectstore.json` — if missing, tell user to run `/projectstore:bind <path>` and stop.

2. **Render draft** by running:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" adr "$ARGUMENTS"
   ```

   The script outputs JSON with shape `{ kind, path, content, index, vars }`. Capture stdout.

3. **Show user a preview**: print the target `path`, then the first ~30 lines of `content` in a code block. State the assigned ADR number and slug.

4. **Approval**: use AskUserQuestion with options:
   - **Yes** — write the file as-is
   - **Edit before saving** — let the user describe a change; you regenerate accordingly (e.g., adjust title, status, add tags) and re-preview
   - **No** — abort

5. **Pre-write race check** (Layer 1 — multi-session safety):
   - Run `test -e "<path>"`. If the file already exists, another session created an ADR with the same auto-incremented number while you waited on approval.
   - On collision: print `⚠️ Race detected — <path> already exists, likely created by another active session. Re-rendering with a fresh number...`, re-run `draft.mjs adr "$ARGUMENTS"` to get a new path/content, show the user the new preview, and re-ask via AskUserQuestion.
   - Repeat the race check after each redraft until `test -e` returns false (or the user cancels).

6. **On Yes** (path free): use the Write tool to write `content` to `path`.

7. **Index update** (only if `index` field is non-null):
   - Read the current `index.path` (the folder README).
   - Locate the markdown table whose header includes "ADR" or "File".
   - Show a proposed Edit that appends `index.line` to that table.
   - Ask AskUserQuestion: "Update `<folder>/README.md` index? [Yes / No]". On Yes — apply the Edit.

8. **Final message**: print the file path, a reminder to fill `Context`, `Decision`, `Rationale`, and a hint that running `/sp:commit` will commit the new ADR.

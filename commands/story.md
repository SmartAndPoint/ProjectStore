---
description: Create a new story inside an existing epic.
argument-hint: <epic-id> <title>
---

You are creating a new story under an existing epic.

Steps:

1. **Check config**: stop if `.claude/projectstore.json` missing.

2. **Validate args**: epic-id (positional 1) + title (rest). If only one word, ask for the title.

3. **Render draft**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" story "$ARGUMENTS"
   ```

   The script fails if the epic folder does not exist. Surface the error and suggest `/ps:epic <id> "<title>"` first.

4. **Preview**: path + first ~25 lines.

5. **Approval** via AskUserQuestion: Yes / Edit / No.

   When prompting "Edit", note that the story template has a `Decomposition` checklist — if the user wants to seed it with concrete tasks from the current conversation, regenerate with those tasks pre-filled in place of the empty checkboxes.

6. **Pre-write race check** (Layer 1): `test -e "<path>"`. If exists → another session just created a story with the same auto-number. Re-run `draft.mjs story "$ARGUMENTS"` to get a fresh number, show new preview, re-ask approval.

7. **On Yes** (path free): Write file.

8. **Suggest next**: "Now decompose the work in the `Decomposition` section, or run `/ps:kanban` to refresh the board."

---
description: Create a new epic (with stories subfolder) in the bound vault.
argument-hint: <epic-id> <title>
---

You are creating a new epic.

Steps:

1. **Check config**: if `.claude/projectstore.json` is missing — instruct user to `/ps:bind` and stop.

2. **Validate args**: `$ARGUMENTS` must contain at least an ID and a title. ID is a short uppercase token (e.g. `AUTH-001`, `RECPLAT-269`). If only one word was given, ask user for the title via AskUserQuestion.

3. **Render draft**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" epic "$ARGUMENTS"
   ```

   Capture the JSON output.

4. **Check collision**: if `<vault>/epics/<id>/epic.md` already exists, ask user via AskUserQuestion: "Epic `<id>` exists. [Open existing / Overwrite / Cancel]".

5. **Preview**: show path + content excerpt.

6. **Approval** via AskUserQuestion: Yes / Edit / No.

7. **On Yes**: Write the file. The `epics/<id>/stories/` directory was created by the draft script — confirm it with `ls`.

8. **Index update**: if `index` is non-null in the draft JSON, propose adding `index.line` to `<vault>/epics/README.md`. Ask approval, then Edit.

9. **Suggest next**: print "Add the first story: `/ps:story <epic-id> \"<first story title>\"`".

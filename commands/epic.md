---
description: Create a new epic (with stories subfolder) in the bound vault.
argument-hint: <epic-id> <title>
---

You are creating a new epic.

Steps:

1. **Check config**: if `.claude/projectstore.json` is missing — instruct user to `/projectstore:bind` and stop.

2. **Validate args**: `$ARGUMENTS` must contain at least an ID and a title. ID is a short uppercase token (e.g. `AUTH-001`, `RECPLAT-269`). If only one word was given, ask user for the title via AskUserQuestion.

3. **Render draft**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" epic "$ARGUMENTS"
   ```

   Capture the JSON output.

4. **Check collision**: if `<vault>/epics/<id>/epic.md` already exists, ask user via AskUserQuestion: "Epic `<id>` exists. [Open existing / Overwrite / Cancel]".

5. **Preview**: show path + content excerpt. When `index` is non-null, print `index.line` too — the exact row that will appear in `epics/README.md`, unless the index step reports a failure and no row lands at all.

6. **Approval** via AskUserQuestion: Yes / Edit / No. This is the only gate: **Yes** covers the epic and its index row. Disclose in the question that the folder's whole managed index table is regenerated from vault state at write time, so the update may also repair a stale row for another epic.

7. **Pre-write race check** (Layer 1): run `test -e "<path>"`. The earlier collision check (step 4) covers most cases, but another session could have created this epic during the approval delay. If exists now → ask the user via AskUserQuestion whether to **Overwrite** or **Cancel**. Do not silently overwrite.

8. **On Yes** (path free or overwrite confirmed): Write the file (parent directories are created by the Write tool), then create the stories directory: `mkdir -p "<vault>/epics/<id>/stories"`. The draft script itself never touches the disk — declining at step 6 leaves the vault unchanged.

9. **Index update**: if `index` is non-null in the draft JSON, apply the row through the core — never the Write/Edit tools, no second gate (the step-6 approval covers it). Must run **after** step 8: the regeneration scans the disk, so an epic written later would be missing from the table.

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>
   ```

   The row is derived state — regenerated in canonical order, written atomically, manual prose preserved. The epic is already on disk, so a nonzero exit is a warning naming the folder (stderr with no JSON = rejected before any write, fix the header or restore the README; per-target `error` in JSON = I/O failure, suggest `/projectstore:reconcile`), never a failed creation.

10. **Suggest next**: print "Add the first story: `/projectstore:story <epic-id> \"<first story title>\"`".

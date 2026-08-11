---
description: Create a new meeting note (date-prefixed filename).
argument-hint: <title>
---

You are creating a meeting note. Today's date is auto-prefixed.

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" meeting "$ARGUMENTS"`.
3. Preview path + first ~15 lines. When `index` is non-null, print `index.line` too — the exact row that will appear in the folder index, unless the index step reports a failure and no row lands at all. (In the step-5 **Append to existing** branch no new row appears: the existing note already has one, rendered from its own frontmatter.)
4. AskUserQuestion: Yes / Edit / No. When proposing "Edit", offer to seed `Attendees` and `Agenda` from the conversation context if relevant. This is the only gate: **Yes** covers the artifact and its index row. Disclose in the question that the folder's whole managed index table is regenerated from vault state at write time, so the update may also repair a stale row for another artifact.
5. Pre-write race check (Layer 1): `test -e "<path>"`. If a meeting note with this date+slug already exists, ask: **Append to existing** (open it and add a section), **Use new slug** (`-2`), or **Cancel**.
6. On Yes (path free): Write file.
7. Index row, if `index` is non-null — apply through the core, never Write/Edit, no second gate (step 4 covers it): `node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --write --only indexes=<index.folder>`. The row is derived state: canonical order, atomic write, manual prose preserved. The file is already on disk, so a nonzero exit is a warning naming the folder (stderr with no JSON = rejected before any write, fix the header or restore the README; `error` in JSON = I/O failure, suggest `/projectstore:reconcile`), never a failed creation.
8. Suggest: "Add attendees and agenda before the meeting; record decisions and action items during/after."

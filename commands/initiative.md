---
description: Create a new initiative (an outcome above several epics).
argument-hint: <title>
---

You are creating an initiative.

Steps:

1. Check config; stop if missing.
1a. **Read the guide** for this kind before writing anything:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" guide initiative --project "${CLAUDE_PROJECT_DIR}"
   ```

   Write the draft to its `## Must`, `## Common mistakes`, `## Do not write`
   and `## Length`: the critic checks the same `## Must` items. Exit 1 means
   this kind has no guide; say so and go on.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/draft.mjs" initiative "$ARGUMENTS"`.
3. Preview path + first ~15 lines. When `index` is non-null, print `index.line` too — the exact row that will appear in the folder index, unless the index step reports a failure and no row lands at all.
4. AskUserQuestion: Yes / Edit / No. This is the only gate: **Yes** covers the artifact and its index row. Disclose in the question that the folder's whole managed index table is regenerated from vault state at write time, so the update may also repair a stale row for another artifact. It may also drop, for a while, a row another session added a moment before; the next regeneration of that folder's index restores it.
5. Pre-write race check (Layer 1): `test -e "<path>"`. If exists, ask: **Overwrite**, **Use new slug** (`-2`), or **Cancel**.
6. On Yes (path free or overwrite confirmed): Write file.
7. Index row, if `index` is non-null — apply through the core, never Write/Edit, no second gate (step 4 covers it): `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>`. The row is derived state: canonical order, atomic write, manual prose preserved. The file is already on disk, so a nonzero exit is a warning naming the folder (stderr with no JSON = rejected before any write, fix the header or restore the README; `error` in JSON = I/O failure, suggest `/projectstore:reconcile`), never a failed creation.
8. Suggest: "Fill `Problem` and `Success criterion` first. The initiative is `proposed`; an epic joins it with `initiative: \"<slug>\"` in the epic's frontmatter. To record a decision, set `status:` to `accepted`, `rejected` or `deferred` and add an Outcome line `- YYYY-MM-DD <status>: <reason>` with the reason the person gave; an accepted initiative needs at least one epic that names it."

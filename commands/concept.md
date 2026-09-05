---
description: Create a new concept note (definition, mental model, glossary entry).
argument-hint: <title>
---

You are creating a concept note.

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" concept "$ARGUMENTS"`.
3. Preview path + first ~15 lines. When `index` is non-null, print `index.line` too — the exact row that will appear in the folder index, unless the index step reports a failure and no row lands at all.
4. AskUserQuestion: Yes / Edit / No. This is the only gate: **Yes** covers the artifact and its index row. Disclose in the question that the folder's whole managed index table is regenerated from vault state at write time, so the update may also repair a stale row for another artifact.
5. Pre-write race check (Layer 1): `test -e "<path>"`. If exists, ask: **Overwrite**, **Use new slug** (`-2`), or **Cancel**.
6. On Yes (path free or overwrite confirmed): Write file.
7. Index row, if `index` is non-null — apply through the core, never Write/Edit, no second gate (step 4 covers it): `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>`. The row is derived state: canonical order, atomic write, manual prose preserved. The file is already on disk, so a nonzero exit is a warning naming the folder (stderr with no JSON = rejected before any write, fix the header or restore the README; `error` in JSON = I/O failure, suggest `/projectstore:reconcile`), never a failed creation.
8. Suggest: "Define `What is it` first, then `How it works`. Link from ADRs/research that reference this concept."

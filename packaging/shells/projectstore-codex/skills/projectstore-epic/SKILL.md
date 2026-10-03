---
name: projectstore-epic
description: "Create a new epic (with stories subfolder) in the bound vault. Arguments: <epic-id> <title>."
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

You are creating a new epic.

Steps:

1. **Check config**: if `.projectstore/projectstore.json` is missing — instruct user to `$projectstore-bind` and stop.

2. **Validate args**: `<user-arguments>` must contain at least an ID and a title. ID is a short uppercase token (e.g. `AUTH-001`, `RECPLAT-269`). If only one word was given, ask user for the title via the harness's user-input mechanism.

3. **Render draft**:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/draft.mjs" epic "<user-arguments>"
   ```

   Capture the JSON output.

4. **Check collision**: if `<vault>/epics/<id>/epic.md` already exists, ask user via the harness's user-input mechanism: "Epic `<id>` exists. [Open existing / Overwrite / Cancel]".

5. **Preview**: show path + content excerpt. When `index` is non-null, print `index.line` too — the exact row that will appear in `epics/README.md`, unless the index step reports a failure and no row lands at all.

6. **Approval** via the harness's user-input mechanism: Yes / Edit / No. This is the only gate: **Yes** covers the epic and its index row. Disclose in the question that the folder's whole managed index table is regenerated from vault state at write time, so the update may also repair a stale row for another epic.

7. **Pre-write race check** (Layer 1): run `test -e "<path>"`. The earlier collision check (step 4) covers most cases, but another session could have created this epic during the approval delay. If exists now → ask the user via the harness's user-input mechanism whether to **Overwrite** or **Cancel**. Do not silently overwrite.

8. **On Yes** (path free or overwrite confirmed): Write the file (parent directories are created by the file-writing tool), then create the stories directory: `mkdir -p "<vault>/epics/<id>/stories"`. The draft script itself never touches the disk — declining at step 6 leaves the vault unchanged.

9. **Index update**: if `index` is non-null in the draft JSON, apply the row through the core — never the Write/file-editing tools, no second gate (the step-6 approval covers it). Must run **after** step 8: the regeneration scans the disk, so an epic written later would be missing from the table.

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>
   ```

   The row is derived state — regenerated in canonical order, written atomically, manual prose preserved. The epic is already on disk, so a nonzero exit is a warning naming the folder (stderr with no JSON = rejected before any write, fix the header or restore the README; per-target `error` in JSON = I/O failure, suggest `$projectstore-reconcile`), never a failed creation.

10. **Suggest next**: print "Add the first story: `$projectstore-story <epic-id> \"<first story title>\"`".

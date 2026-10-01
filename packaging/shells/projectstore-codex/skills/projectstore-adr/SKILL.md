---
name: projectstore-adr
description: "Create a new Architecture Decision Record (ADR) in the bound vault. Arguments: <title>."
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

You are creating a new ADR.

Steps:

1. **Check config**: `test -f .projectstore/projectstore.json` — if missing, tell user to run `$projectstore-bind <path>` and stop.

2. **Render draft** by running:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/draft.mjs" adr "<user-arguments>"
   ```

   The script outputs JSON with shape `{ kind, path, content, index, collision, warnings, vars }`. Capture stdout.

3. **Show user a preview**: print the target `path`, then the first ~30 lines of `content` in a code block. State the slug (it IS the identity — ADR-010). If `index` is non-null, print `index.line` — the exact row that will appear in the folder index (rendered by the regeneration's own rules, so it is what lands, not an approximation), unless the index step reports a failure and no row lands at all. Render every entry in `warnings` as a `⚠️` line. If `collision` is non-null, surface it as a **topic collision**: `⚠️ "<identity>" already exists as <with> — same topic, two artifacts.` Ask whether to open/extend the existing artifact, pick a genuinely different slug (a deliberate `-2` suffix is a distinct identity and stays legal), or cancel. Do not write over a collision without an explicit user decision.

4. **Approval**: use the harness's user-input mechanism with options:
   - **Yes** — write the file as-is
   - **Edit before saving** — let the user describe a change; you regenerate accordingly (e.g., adjust title, status, add tags) and re-preview
   - **No** — abort

   This is the only gate: **Yes** covers both the artifact and its index row.
   Disclose in the question that the folder's whole managed index table is
   regenerated from vault state at write time, so the update may also repair
   a stale row for another artifact.

5. **Post-approval race re-check** (Layer 1 — multi-session safety): re-run `draft.mjs adr "<user-arguments>"` and re-read `collision` — a plain `test -e` cannot see normalized cross-era collisions, and another session may have created the same topic while you waited on approval. If `collision` is now non-null (or changed), show it as in step 3 and re-ask. The slug is derived from the title, so the re-render is byte-identical otherwise — never expect a "fresh number".

6. **On Yes** (path free): use the file-writing tool to write `content` to `path`.

7. **Index update** (only if `index` field is non-null — skip silently otherwise):
   apply through the core — never the Write/file-editing tools, and do not ask again:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>
   ```

   The index row is derived state: the regeneration renders it in canonical
   order (date, then number/slug), replaces the file atomically, and preserves
   manual prose outside the managed table. Never substitute the class-wide
   `indexes` selector — that would regenerate every folder index.

   The artifact is already on disk, so a failure here is a warning, never a
   failed creation. Two shapes, both reported naming the folder:
   - **stderr, no stdout JSON** — the named target was rejected before any
     write (README absent, or its index header matches no registered form).
     Suggest fixing the header (`$projectstore-doctor`) or restoring the
     README; the row lands on the next reconcile.
   - **JSON with a per-target `error`, nonzero exit** — an I/O failure during
     the write. Suggest `$projectstore-reconcile`.

8. **Final message**: print the file path, a reminder to fill `Context`, `Decision`, `Rationale`, and a hint to commit the new ADR if the vault is git-tracked.

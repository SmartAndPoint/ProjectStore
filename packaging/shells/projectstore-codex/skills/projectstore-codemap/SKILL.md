---
name: projectstore-codemap
description: "Regenerate code-map.md (epic ↔ code overview) from frontmatter code_refs, or set an artifact's code_refs. The command is the write path — planner/reviewer only propose refs. Arguments: [set <epic-id | story-path> <ref> [ref…]]."
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

You are managing the epic↔code mapping (ADR-004).

## Bare `codemap` — regenerate the view

1. **Check config**; stop if missing.
2. Compute (read-only, the unified reconcile path):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --only codemap
   ```

   The `codemap` entry carries `{ path, changed, content?, stats }`.
3. Show `stats` (epics, epics_with_refs, story_rows) + first ~15 lines of
   `content` when changed.
4. **Approval** via the harness's user-input mechanism: Yes / No (disclose: content is recomputed
   from frontmatter at write time; the preview is advisory). On Yes → apply
   through the core, never the file-writing tool:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only codemap
   ```

   Explicit selection writes the map even on a vault with no `code_refs` yet.
   Render the report's `codemap` entry; nonzero exit — surface the `error`.
5. Suggest: "Refs are set via `codemap set`; reviewer proposes updates at story completion."

## `codemap set <target> <ref…>` — update frontmatter (the write path)

1. **Resolve target**: an epic id (`PS-AGENTS` → `epics/PS-AGENTS/epic.md`) or a
   story path relative to the vault. Stop with a clear error if not found.
2. **Read the file**, show current `code_refs` vs proposed (`["src/auth/", …]`).
   Validate: repo-relative paths/globs; warn (don't block) on paths that don't
   exist yet — planning-time refs are legitimate (doctor is status-aware).
3. **Approval** via the harness's user-input mechanism (diff preview). On Yes → Edit the frontmatter
   `code_refs` line only; also bump `updated:` if the artifact has it.
4. **Offer regen**: "Refresh the view? (runs bare `codemap`)" — on Yes, run the
   bare flow above.

## Notes

- Story `code_refs` = files that story touched; epic `code_refs` = the epic's
  overall footprint. Doctor checks story ⊆ epic and path existence
  (status-aware). `reconcile` also regenerates the view.
- Never write refs without approval; never let an agent edit them directly —
  planner/reviewer *propose*, this command *writes*.

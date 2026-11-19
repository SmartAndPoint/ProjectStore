---
description: Regenerate code-map.md (epic ↔ code overview) from frontmatter code_refs, or set an artifact's code_refs. This command and a story's close write refs — planner/reviewer only propose them.
argument-hint: "[set <epic-id | story-path> <ref> [ref…]]"
---

You are managing the epic↔code mapping (ADR-004).

## Bare `codemap` — regenerate the view

1. **Check config**; stop if missing.
2. Compute (read-only, the unified reconcile path):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" reconcile --only codemap
   ```

   The `codemap` entry carries `{ path, changed, content?, stats }`.
   Once `spec-tree.md` exists, a `spectree` entry comes too: every reconcile
   keeps that view fresh, so when its `changed` is true, show it in the preview
   as well; the write below rewrites it with the rest.
3. Show `stats` (epics, epics_with_refs, story_rows) + first ~15 lines of
   `content` when changed.
4. **Approval** via AskUserQuestion: Yes / No (disclose: content is recomputed
   from frontmatter at write time; the preview is advisory). On Yes → apply
   through the core, never the Write tool:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" reconcile --write --only codemap
   ```

   Explicit selection writes the map even on a vault with no `code_refs` yet.
   Render the report's `codemap` entry; nonzero exit — surface the `error`.
5. Suggest: "A story's close writes its refs and widens its epic's; `codemap set` changes or removes them."

## `codemap set <target> <ref…>` — update frontmatter (the write path)

1. **Resolve target**: an epic id (`PS-AGENTS` → `epics/PS-AGENTS/epic.md`) or a
   story path relative to the vault. Stop with a clear error if not found.
2. **Read the file**, show current `code_refs` vs proposed (`["src/auth/", …]`).
   Validate: repo-relative paths/globs; warn (don't block) on paths that don't
   exist yet — planning-time refs are legitimate (doctor is status-aware).
3. **Approval** via AskUserQuestion (diff preview). On Yes → Edit the frontmatter
   `code_refs` line only; also bump `updated:` if the artifact has it.
4. **Offer regen**: "Refresh the view? (runs bare `codemap`)" — on Yes, run the
   bare flow above.

## Notes

- Story `code_refs` = files that story touched; epic `code_refs` = the epic's
  overall footprint. Doctor checks story ⊆ epic and path existence
  (status-aware). `reconcile` also regenerates the view.
- Never write refs without approval; never let an agent edit them directly —
  planner/reviewer *propose*; this command and a story's close *write*, each
  behind its approval (`/projectstore:story close` adds the files of the
  story's pull request, through `close-refs`, and widens the epic's footprint).
  A close only adds; this command is the way to change or remove a ref.

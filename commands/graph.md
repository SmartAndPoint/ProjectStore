---
description: Regenerate graph.md — the vault link graph (nodes + typed edges) derived from body links and frontmatter relations. Compute → preview → approval → apply through the core.
argument-hint: ""
---

You are managing the vault link graph — the third root-level derived view
beside kanban.md and code-map.md (spec:
vault-link-graph-derived-view-and-shared-link-resolver).

## Steps

1. **Check config**; stop if missing.

2. **Compute** (read-only, the unified reconcile path):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --only graph
   ```

   The `graph` entry carries `{ path, changed, content?, stats }` — stats:
   node count, edge count, edges by kind.

3. **Nothing changed** (`changed: false`) → report "graph.md already matches
   the vault — nothing to regenerate." and stop.

4. **Preview**: show `stats` and the first ~15 lines of `content`. Surface
   `dead` and `ambiguous` edge counts FIRST — they are the actionable part
   (the same facts doctor reports as wikilink findings, from the same
   resolver).

5. **Approval** via AskUserQuestion: Yes / No. Disclose that content is
   recomputed from vault state at write time — the preview is advisory, the
   approval covers the regeneration action. On Yes → apply through the core,
   never the Write tool:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --write --only graph
   ```

   Explicit selection creates graph.md when absent — bare reconcile
   deliberately never mints it (first creation and re-minting after deletion
   are this command's job). Render the report's `graph` entry; nonzero exit —
   surface the `error`.

6. **Verify**: run `node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs" --vault`
   and show the summary line.

## Notes

- The grep contract: `grep '<vault-relative-path>' graph.md` returns an
  artifact's full typed neighborhood — outgoing AND incoming edges — in one
  call. Node keys are full vault-relative paths, never short names.
- Edge kinds: wikilink, mdlink, supersedes, spec-covers, spec-implements-adr,
  epic-contains, dead, ambiguous, out-of-scope. Nothing resolves silently.
- Hand-edits to graph.md never stick: doctor flags staleness, reconcile
  repairs. Fix the source artifact, then regenerate.

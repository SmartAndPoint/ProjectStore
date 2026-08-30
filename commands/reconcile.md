---
description: Re-derive every derived view (kanban, folder-index READMEs, code-map, graph) from the vault's source of truth — the repair half of doctor's vault checks. Hand-edits can never permanently desync the board.
argument-hint: ""
---

You are reconciling the vault's derived views with their source of truth (frontmatter).

## Steps

1. **Check config**; stop if missing.

2. **Compute** (read-only):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs"
   ```

   Output JSON: `kanban` / `codemap` / `graph` / `indexes[]`, each
   `{path, changed, content?}`, plus `summary.changed`. A graph.md that does
   not exist yet reports `skipped` — bare reconcile never mints the file;
   first creation goes through `/projectstore:graph` (or `--only graph`).

3. **Nothing changed** (`summary.changed == 0` and `summary.failed == 0`) →
   report "Derived views already match frontmatter — nothing to reconcile."
   and stop.

4. **Preview**: list each changed target (path + a one-line what: "kanban board",
   "adr/ index", "code map", "link graph"). Show a short diff excerpt for indexes.
   **Surface any target carrying `error` first** — an errored target has no
   `changed` flag, so it never appears in the changed list; a broken board
   must not hide behind a clean-looking preview.

5. **Approval** via AskUserQuestion: **Apply all** / **Select targets** / **Cancel**.
   Disclose in the question that content is recomputed from the vault at write
   time — the preview is advisory, the approval covers the regeneration action.

5a. **Delegate the apply — enumerated case: two or more targets** (ADR "Artifact
   content is authored by the context-holder, the write ceremony by a clerk").
   When the approved set contains two or more targets, hand steps 6-7 to
   `projectstore:clerk`: pass the exact selector list from step 4's preview and
   the expectation that doctor ends clean. **Model (ADR-008)**: resolve
   `agents.per_agent.clerk.model ?? agents.default.model` from
   `.claude/projectstore.json` and pass it as the spawn's model parameter;
   missing key, `inherit`, or unreadable config → pass nothing and let the
   agent's own frontmatter decide; never guess a model. The clerk applies
   through the core exactly as step 6 specifies and reports per target. A single
   approved target stays in the main thread — the spawn costs more than it
   saves. No clerk available → steps 6-7 yourself; never a general-purpose
   substitute.

6. **On approval**: apply through the core — never the Write/Edit tools:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs" --write --only <approved,targets>
   ```

   Selectors: `kanban`, `codemap`, `graph`, `indexes` (all), `indexes=<folder>` (one).
   "Apply all" means the targets previewed in step 4, passed explicitly — not a
   bare `--write`. The script recomputes each target immediately before its own
   atomic replace; manual prose outside the managed Index tables is preserved by
   construction (check-and-retry re-reads the README before writing). Render the
   report: per target `{path, changed, written, error?}` + `summary`. A nonzero
   exit means at least one target failed — surface its `error`.


7. **Verify**: run `node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs" --vault` and show
   the summary line — reconcile's whole point is a clean doctor afterwards.

## Notes

- Reconcile owns **vault-side** repair (ADR-005 boundary); install-side repair
  lives in `/projectstore:doctor --fix`.
- Frontmatter is never modified here — if the *frontmatter* is what's wrong, fix
  the artifact, then reconcile.

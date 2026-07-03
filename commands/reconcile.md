---
description: Re-derive every derived view (kanban, folder-index READMEs, code-map) from artifact frontmatter — the repair half of doctor's vault checks. Hand-edits can never permanently desync the board.
argument-hint: ""
---

You are reconciling the vault's derived views with their source of truth (frontmatter).

## Steps

1. **Check config**; stop if missing.

2. **Compute** (read-only):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs"
   ```

   Output JSON: `kanban` / `codemap` / `indexes[]`, each `{path, changed, content?}`,
   plus `summary.changed`.

3. **Nothing changed** (`summary.changed == 0`) → report "Derived views already
   match frontmatter — nothing to reconcile." and stop.

4. **Preview**: list each changed target (path + a one-line what: "kanban board",
   "adr/ index", "code map"). Show a short diff excerpt for indexes.

5. **Approval** via AskUserQuestion: **Apply all** / **Select targets** / **Cancel**.

6. **On approval**: Write each approved target's `content` to its `path`, verbatim.
   Manual prose outside the managed Index tables is preserved by construction —
   the script only replaces table rows.

7. **Verify**: run `node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs" --vault` and show
   the summary line — reconcile's whole point is a clean doctor afterwards.

## Notes

- Reconcile owns **vault-side** repair (ADR-005 boundary); install-side repair
  lives in `/projectstore:doctor --fix`.
- Frontmatter is never modified here — if the *frontmatter* is what's wrong, fix
  the artifact, then reconcile.

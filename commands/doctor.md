---
description: Diagnose the projectstore installation (config, vault, hooks, statusline, agents wiring) and the vault's consistency (status ↔ kanban ↔ indexes, acceptance, links). Read-only by default; --fix offers approval-gated install-side repairs.
argument-hint: "[--install | --vault] [--fix]"
---

You are running projectstore diagnostics (ADR-005: umbrella doctor).

## Steps

1. **Run the engine** (read-only; pass through section flags, never `--fix`):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs" $ARGUMENTS_WITHOUT_FIX
   ```

   Default (no flags) runs both sections: `--install` (wiring/config) and
   `--vault` (consistency). Print the report **verbatim**.

2. **No findings** → done. One line: "Doctor is clean — N info note(s) above."

3. **`--fix` requested** → walk the *install-side* findings only, one
   AskUserQuestion per repair, never batched silently:
   - `vault-git` → offer `git init` (+ optional first commit) inside the vault.
   - `gitignore` → offer appending the missing entries via Edit.
   - `agents-block` duplicate → show both blocks, offer removing the one in the
     non-preferred location (Edit after approval).
   - `statusline` issues → explain the SessionStart hook owns the wiring
     (self-heals on restart); offer running `/projectstore:statusline on|off`
     to reconcile the flag, and remind that a restart applies it.
   - `override-copies` staleness → suggest `/projectstore:agents configure`
     (ships with v0.13); do not hand-edit prompt copies.

   **Boundary (ADR-005)**: `--fix` never repairs vault-side findings. For those,
   point at `/projectstore:kanban` (board regen) and `reconcile` (indexes +
   code-map; ships with the "Reliability by construction" epic). Until reconcile
   exists, offer targeted Edits for index rows only if the user asks.

4. **Suggest next**: if issues remain, list the one-line repair per finding; if
   only warnings remain, say they are advisory.

## Notes

- Detection is read-only by contract — the engine never writes; only `--fix`
  flows (each behind AskUserQuestion) touch files.
- The SessionStart hook runs a cheap install-only subset of this engine and
  prints one line when it finds issues; the full vault lint runs only here.

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
   - `override-copies` → a copy carrying the provenance marker overrides nothing
     (ADR-008): offer to **delete** it (approval-gated, one prompt per file), and
     say that `/projectstore:agents configure` now records the model in
     `.claude/projectstore.json` instead. Never offer to delete — or edit — a
     copy reported at `info`: no provenance marker means we cannot prove it is
     ours, and it may be the user's own agent.
   - `auto-update` off → offer adding `extraKnownMarketplaces.<marketplace>.autoUpdate: true`
     to `~/.claude/settings.json` (Edit with diff preview + approval — this is the
     user's global settings file), or point at `/plugin` → Marketplaces → toggle.
     For "newer version available" → tell the user to run
     `/plugin marketplace update <marketplace>` and `/reload-plugins` themselves.

   **Boundary (ADR-005)**: `--fix` never repairs vault-side findings. For those,
   point at `/projectstore:kanban` (board regen) and `/projectstore:reconcile`
   (indexes + code-map + graph). Never offer a hand-written Edit of an index
   row: derived views are only ever written by the core's regeneration.

4. **Suggest next**: if issues remain, list the one-line repair per finding; if
   only warnings remain, say they are advisory.

## Notes

- Detection is read-only by contract — the engine never writes; only `--fix`
  flows (each behind AskUserQuestion) touch files.
- The SessionStart hook runs a cheap install-only subset of this engine and
  prints one line when it finds issues; the full vault lint runs only here.
- Spec gates (`spec-coverage`, `spec-status`, `spec-acceptance`) and lifecycle
  gates (`evidence`, `plan-gate`, `final-summary`) key off the VAULT-side
  policy file `<vault>/.projectstore.json` (`spec_policy` / `lifecycle_gates`,
  ADR-007), never the machine-local config. `spec-links` integrity runs
  whenever specs exist. Legacy stories (done before `spec_policy_since`, or
  done with no `closed_at`) are exempt by design.

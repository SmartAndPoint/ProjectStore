---
description: Diagnose the projectstore installation (config, vault, hooks, statusline, agents wiring) and the vault's consistency (status ↔ kanban ↔ indexes, acceptance, links). Read-only by default; --fix offers approval-gated install-side repairs.
argument-hint: "[--install | --vault] [--fix]"
---

You are running projectstore diagnostics (ADR-005: umbrella doctor).

## Steps

1. **Run the engine** (read-only; pass through section flags, never `--fix`):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" doctor $ARGUMENTS_WITHOUT_FIX
   ```

   Forward only `--install` / `--vault` from the arguments: the bin's parser is strict, and any other flag is a usage error (exit 2) rather than the shrug the bare script gave. Exit 1 means findings were reported, not that the check failed (exit 2 is usage, 3 not bound) — read the report, never the exit code, as the verdict. (The bare script always exited 0; through the bin the exit code carries the verdict, so a Bash tool that colours non-zero red is colouring findings, not a crash.)

   Default (no flags) runs both sections: `--install` (wiring/config) and
   `--vault` (consistency). Print the report **verbatim**.

2. **No findings** → done. One line: "Doctor is clean — N info note(s) above."

3. **`--fix` requested** → walk the *install-side* findings only, one
   AskUserQuestion per repair, never batched silently:
   - `worktree-unbound` → this checkout is a git worktree of a bound one. Offer
     `/projectstore:bind --inherit`, and say what it does: copies the parent's
     binding, leaves the vault shared and unchanged, carries no session state.
     Do not offer a fresh `bind <vault-path>` here — binding a second vault by
     hand is exactly what this finding exists to prevent.
   - `vault-git` → offer `git init` (+ optional first commit) inside the vault.
   - `gitignore` → offer appending the missing entries via Edit.
   - `agents-block` duplicate or stale → show the finding, then (after approval)
     run `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" install --harness claude-code --surface agents_block --project "<abs project dir>"`
     and print its output: it removes the copy in the non-preferred file and
     keeps the preferred one current. Never Edit or Write the block yourself —
     the verb is its only writer (install spec, contract 6).
   - `statusline` issues → offer running `/projectstore:statusline on|off`,
     which installs or removes the entry and the launcher behind a preview
     (the SessionStart hook only refreshes an entry that already exists), and
     remind that a restart applies it.
   - `surface` (a stale installed file or a stale shared entry) → offer running
     the verb for that surface and print its output:
     `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" install --harness claude-code --surface <key> --project "<abs project dir>"`
     (`statusline` for the launcher, `agents_block` for the block). When more
     than one surface is stale — the shape of a plugin update — offer the one
     command that covers them all:
     `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" upgrade --harness claude-code --project "<abs project dir>"`.
     Repairs invoke core verbs only — never Edit, Write or delete the file yourself.
   - `upgrade` (an info the SessionStart line carries, not a row of this
     report: a launcher written before file stamps existed) → in this report
     the same file is the `surface` issue above; the `upgrade` command re-stamps
     it in one run.
   - `surface-foreign` → **never repairable.** A file under our prefix with no
     provenance line is not ours: no `--fix` flow may edit, delete, move or
     overwrite it. Print the finding verbatim and relay its resolution — rename
     it if it is yours, or delete it yourself to let `install` take the name.
     The verbs refuse it in code; this clause is the belt.
   - `version-drift` → report only: name both versions and where each was
     read; the fix is the host's update path (`/plugin update` for a git-marketplace
     copy; for the npm registration, the package's own `upgrade` from a terminal —
     the `plugin-registration` finding spells it), not ours.
   - `layout-legacy` (warn; the startup line carries it as an offer) → the project
     still holds the pre-0.28 layout (`.claude/projectstore.json`,
     `.claude/.projectstore/` — legacy, read through 0.29). The migration is one
     previewed `layout` item of `upgrade`, run **from a terminal outside this
     session** (it moves files this session reads and writes; the verb defers
     inside one). Relay the finding's command verbatim; never move the files
     yourself.
   - `layout-two-configs` (issue) → both `.claude/projectstore.json` (legacy) and
     `.projectstore/projectstore.json` exist: `install` and `upgrade` refuse until
     one is deleted. Show both, ask the user which is the binding they mean, and
     let them delete the other; `uninstall` and this report are not blocked.
   - `plugin-registration` (info) → nothing to repair; it names where the npm
     registration loads from. As an **issue** — stale, or two enabled copies —
     print the finding and relay its command verbatim (the package runner's
     `upgrade` or `install` with `--surface plugin`): it is run **from a
     terminal outside this session**. Never run `claude plugin …` from a Bash
     tool here: the host CLI and this live session both rewrite the same
     settings files, and the registration verb refuses inside a session for
     that reason.
   - `plugin-registration-foreign` → **never repairable**, like `surface-foreign`:
     a marketplace directory under our name without our provenance field, or a
     host registry naming our marketplace elsewhere. Print the finding verbatim;
     the user moves or removes it.
   - `harness` (info) → nothing to repair; it names what `install` can target.
   - `mcp` → the plugin-bundled `.mcp.json` is missing or does not launch
     `bin/projectstore.mjs mcp`: the install is incomplete — the fix is the
     host's update path (`/plugin update`), never a hand-written file.
   - `override-copies` → a copy carrying the provenance marker overrides nothing
     (ADR-008): offer to **delete** it (approval-gated, one prompt per file), and
     say that `/projectstore:agents configure` now records the model in
     `.projectstore/harness/<harness>.json` (the active harness's overlay) instead. Never offer to delete — or edit — a
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

   `work-without-story` is not repairable by any command and must not be
   presented as if it were: it reports that the project tree has uncommitted
   source work while no story is `in-progress`. The response is a judgement —
   open a story (`/projectstore:story <EPIC> "<title>"`), or decide the work is
   a one-off and leave it. Relay the finding's own note about whether an entry
   reminder fired: "fired and the work still went untracked" and "never fired"
   are different problems, and the count is for this machine only.

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

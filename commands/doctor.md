---
description: Diagnose the projectstore installation (config, vault, hooks, statusline, agents wiring) and the vault's consistency (status ↔ kanban ↔ indexes, acceptance, links). Read-only by default; --fix offers approval-gated install-side repairs.
argument-hint: "[--install | --vault] [--policy required[@<date>]] [--fix]"
---

You are running projectstore diagnostics (ADR-005: umbrella doctor).

## Steps

1. **Run the engine** (read-only; pass through section flags, never `--fix`):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" doctor $ARGUMENTS_WITHOUT_FIX
   ```

   Forward only `--install` / `--vault` / `--policy <rule>` from the arguments. `--policy required` (or `required@<date>`) is a dry run of the vault section as if the spec policy were required since that date: it writes nothing, and the report opens with a `dry-run` note. The bin's parser is strict, and any other flag is a usage error (exit 2) rather than the shrug the bare script gave. Exit 1 means findings were reported, not that the check failed (exit 2 is usage, 3 not bound) — read the report, never the exit code, as the verdict. (The bare script always exited 0; through the bin the exit code carries the verdict, so a Bash tool that colours non-zero red is colouring findings, not a crash.)

   Default (no flags) runs both sections: `--install` (wiring/config) and
   `--vault` (consistency). Print the report **verbatim**.

2. **No findings** → done. One line: "Doctor is clean — N info note(s) above."

3. **`--fix` requested** → walk the *install-side* findings only, one
   AskUserQuestion per repair, never batched silently. **When `layout-legacy`
   is in the report, it goes first and its command is the one repair** for a
   stale-launcher `surface`, a v3 `agents-block` and `agents-in-binding` as
   well: relay it and run nothing in-session for those (see its bullet below).
   The report already shows the v3 block, and a block Claude Code cannot see,
   as info that points at the move.
   - `worktree-unbound` → this checkout is a git worktree of a bound one. Offer
     `/projectstore:bind --inherit`, and say what it does: copies the parent's
     binding, leaves the vault shared and unchanged, carries no session state.
     Do not offer a fresh `bind <vault-path>` here — binding a second vault by
     hand is exactly what this finding exists to prevent.
   - `vault-git` → offer `git init` inside the vault.
   - `gitignore` → offer appending the missing entries via Edit.
   - `agents-block` duplicate or stale → show the finding, then (after approval)
     run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" install --harness claude-code --surface agents_block --project "${CLAUDE_PROJECT_DIR}"`
     and print its output: it removes the copy in the non-preferred file and
     keeps the preferred one current. A block Claude Code cannot see — in
     `AGENTS.md`, with no `@AGENTS.md` line in `CLAUDE.md` — is the same repair:
     the verb adds the import. For another harness the finding names its own
     `--harness`; relay that command. Never Edit or Write the block yourself —
     the verb is its only writer (install spec, contract 6).
   - `agents-block` **info** that the block is "marked vN, newer than this
     copy's vM" → **report only.** Install, upgrade and setup leave such a block as it is (install spec, contract 6 as amended
     2026-10-14). Relay the finding and its command verbatim; run it only if
     the user asks, because it writes this copy's older block over the one marked vN.
   - `statusline` issues → offer running `/projectstore:statusline on|off`,
     which installs or removes the entry and the launcher behind a preview
     (the SessionStart hook only refreshes an entry that already exists), and
     remind that a restart applies it.
   - `surface` (a stale installed file or a stale shared entry) → offer running
     the verb for that surface and print its output:
     `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" install --harness claude-code --surface <key> --project "${CLAUDE_PROJECT_DIR}"`
     (`statusline` for the launcher, `agents_block` for the block). When more
     than one surface is stale — the shape of a plugin update — offer the one
     command that covers them all:
     `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" upgrade --harness claude-code --project "${CLAUDE_PROJECT_DIR}"`.
     Repairs invoke core verbs only — never Edit, Write or delete the file yourself.
   - `upgrade` (an info the SessionStart line carries, not a row of this
     report: a launcher written before file stamps existed) → in this report
     the same file is the `surface` issue above; the `upgrade` command re-stamps
     it in one run. While `layout-legacy` is pending the startup line does not
     carry it: the move re-stamps the launcher at its new path.
   - `surface-foreign` → **never repairable.** A file under our prefix with no
     provenance line is not ours: no `--fix` flow may edit, delete, move or
     overwrite it. Print the finding verbatim and relay its resolution — rename
     it if it is yours, or delete it yourself to let `install` take the name.
     The verbs refuse it in code; this clause is the belt.
   - `version-drift` → report only: name both versions and where each was
     read; the fix is the host's update path (for a git-marketplace copy,
     open `/plugin manage` and choose **Update now** on projectstore; for
     the npm registration, the package's `upgrade` from a terminal in the
     project — the `plugin-registration` finding spells the command),
     not ours.
   - `layout-legacy` (warn; the startup line carries it as an offer) → the project
     still holds the pre-0.28 layout (`.claude/projectstore.json`,
     `.claude/.projectstore/` — legacy, read through 0.30). The migration is one
     previewed `layout` item of `upgrade`, run **from a terminal outside this
     session** (it moves files this session reads and writes; the verb defers
     inside one). The finding names the form for the channel this plugin was
     installed through: the installed copy's own `bin/projectstore.mjs` for a
     git-marketplace install or a checkout, the package's `upgrade` for the npm
     registration. Relay the finding's command verbatim, with the directory its
     words name, and never substitute the other form or drop its
     `--no-register`. Both forms carry that flag, so neither changes the
     channel: the named form runs the copy this project loads, so the move
     re-stamps the launcher that copy renders, while the other form runs a
     different copy. The package's `upgrade` without `--no-register` would
     register the npm copy and turn a git-marketplace copy off for this
     checkout. When the finding carries
     advice instead of a command — the installed copy predates the move, or
     predates `--no-register` — relay the advice and never compose a command
     yourself. Never move the files yourself. While this finding is in the report, its command is also the one
     repair for a stale-launcher `surface`, a v3 `agents-block` and
     `agents-in-binding`: do not run the in-session `install` or `upgrade` for
     those — the deferred move makes that run stop part-way.
   - `layout-two-configs` (issue) → both `.claude/projectstore.json` (legacy) and
     `.projectstore/projectstore.json` exist: `install` and `upgrade` refuse until
     one is deleted. Show both, ask the user which is the binding they mean, and
     let them delete the other; `uninstall` and this report are not blocked.
   - `gitignore-tracked` (warn) → **report only.** git already tracks a file
     that is machine-local — a binding with an absolute vault path, or
     `state/`. An ignore line cannot untrack what is in the index. Show the
     finding's `git rm --cached` line and let the user run it: untracking is a
     commit they own, and `--fix` never runs git on their behalf.
   - `agents-in-binding` (warn) → the binding still carries a pre-0.28 `agents`
     block that nothing reads; the `layout` item of `upgrade` moves it into the
     harness overlay. Same rule as `layout-legacy`: relay the finding's command
     verbatim, run from a terminal outside this session.
   - `overlay-forbidden-key` / `overlay-unparseable` (issue) →
     `.projectstore/harness/<id>.json` carries a key an overlay may not (only
     `agents.default.model`, `agents.default.effort`,
     `agents.per_agent.<name>.model` and `agents.per_agent.<name>.effort` are
     read) or is
     not JSON. Print the finding. A key inside the agents block goes away on the
     next `/projectstore:agents configure` write; a key outside it, and a parse
     error, are the user's to edit — never rewrite the file yourself.
   - `overlay-unknown-agent` (warn) → the overlay configures a name no roster
     agent carries (a typo, or a newer package's agent): nothing runs under it.
     Point at `/projectstore:agents configure` with the roster's names; a name
     outside the roster is refused by both writers, so removing one is
     `agents configure --reset` or the user's own edit of the file.
   - `overlay-unknown-effort` (warn) → the overlay sets an effort the harness's
     levels lack (a typo, or a leftover such as `Max`): a spawn may refuse it.
     Point at `/projectstore:agents configure`, which writes efforts through
     `configure --set agents.<name>.effort=<level>`; `-` clears one.
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
   - `mcp` → the plugin-bundled `.mcp.json` is missing, does not launch
     `scripts/mcp-server.mjs`, or launches it from a plugin root without the
     file: the install is incomplete — the fix is the
     update for the channel this copy was installed through (for a
     git-marketplace copy, open `/plugin manage` and choose **Update now** on
     projectstore; for the npm registration, the package's `upgrade` from a
     terminal in the project, outside this session — the
     `plugin-registration` finding spells the command), never a hand-written
     file.
   - `override-copies` → a copy carrying the provenance marker overrides nothing
     (ADR-008): offer to **delete** it (approval-gated, one prompt per file), and
     say that `/projectstore:agents configure` now records the model in
     `.projectstore/harness/<harness>.json` (the active harness's overlay) instead. Never offer to delete — or edit — a
     copy reported at `info`: no provenance marker means we cannot prove it is
     ours, and it may be the user's own agent.
   - `auto-update` off → offer adding `extraKnownMarketplaces.<marketplace>.autoUpdate: true`
     to `~/.claude/settings.json` (Edit with diff preview + approval — this is the
     user's global settings file), or point at `/plugin` → Marketplaces → toggle.
     For "newer version available" → tell the user to open `/plugin manage` and
     choose **Update now** on projectstore, then run `/reload-plugins` themselves.

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
  whenever specs exist. Legacy stories (done before `spec_policy_since`, else
  `gates_since`, or done with no `closed_at`) are exempt by design.
- The opt-out checks run under every policy: `no-spec` (an empty reason,
  `no_spec` beside `specs:`, or three or more source files), `no-spec-share`
  (opt-outs against covered stories). `gates-since` suggests the stamp for
  gates that have no date, `review-by` names an ADR due for review, and
  `dry-run` heads a `--policy` report. None of them is repairable by `--fix`:
  each is a judgement, or a `configure` step its message names.
- The amendment checks read the markers under a spec's contracts
  (`> amended YYYY-MM-DD by <ref>: ADDED|MODIFIED|REMOVED — <why>`) in every
  spec, under every policy: `amendment-form` (a marker that is not the grammar,
  comes before the first contract or after a `REMOVED`; it counts for
  nothing), `amendment-story` (an issue: the ref names no single story),
  `amendment-link` (neither the story nor the spec lists the other) and
  `amendment-date` (not a date, before the spec's `date:`, after tomorrow, or
  before the previous marker under that contract). `citation-removed` is a
  token in the project that cites a removed contract or step, with the why of
  its marker. None of them is repairable by `--fix`: the marker and the test
  are the author's text.
- The guide checks read the vault's `guides/` folder, the per-kind overrides
  of the authoring guides: `guide-shape` (an override that does not parse, so
  readers fall back to the package default), `guide-unknown` (a guide for a
  kind the layout does not have) and `guide-stale` (an override made from an
  older package default; the message names the command that reads the new
  one). None of them is repairable by `--fix`: the override is the user's
  file, and merging a newer default into it is a judgement.
- The flow checks read the `flow` block of the vault's `.projectstore.json`
  and run only for the keys it sets: `wip-over-limit`, `review-aged`,
  `todo-aged`, `in-progress-idle`, `assignee-idle`, `intake-over-close`,
  `todo-over-capacity` and `todo-under-capacity`, with the infos that explain
  them (`status-unstamped`, `closed-unstamped`, `flow-window-young`,
  `todo-capacity-unknown`, `flow-activity-unknown`, `flow-person-unknown`,
  `flow-stories-unread`). `flow-policy-unset` says the vault has no flow
  policy, and `flow-policy-invalid` names a key whose value the checks
  ignore, never the value. The idle checks read the project's local commits,
  never the code host, and doctor does not fetch. Flow findings are advice: a
  warn or an info, never an issue, and `--fix` touches none of them. Relay a
  `todo-aged` finding's command as it is, alone on its line.

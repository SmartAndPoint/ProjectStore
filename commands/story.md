---
description: Create a new story inside an existing epic, or run its lifecycle gates (plan / close).
argument-hint: <epic-id> <title> [--spec SPEC-ID] | plan <story> | close <story>
---

You are managing a story: creating one, or running its lifecycle gates.

**Dispatch rule** (positional-1 contract, PS-SPEC story-007): if the first
argument is `plan` or `close` AND the second argument resolves to an existing
story file (path, or `<epic-id>/<story-id>` searched under
`<vault>/epics/*/stories/`), run the **Lifecycle gate flow** below. Otherwise
this is a **create** (first argument = epic id — uppercase by convention, so
the two cannot collide).

# Create flow

1. **Check config**: stop if `.projectstore/projectstore.json` missing.

2. **Validate args**: epic-id (positional 1) + title (rest). If only one word, ask for the title. An optional `--spec SPEC-ID` names the covering spec — put it into the rendered draft's `specs:` list (inline flow: `specs: ["SPEC-001"]`). Under `spec_policy: required` (vault's `.projectstore.json`), remind that every story needs a covering spec before implementation starts.

3. **Render draft**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/draft.mjs" story "$ARGUMENTS"
   ```

   The script fails if the epic folder does not exist. Surface the error and suggest `/projectstore:epic <id> "<title>"` first.

4. **Preview**: path + first ~25 lines.

5. **Approval** via AskUserQuestion: Yes / Edit / No.

   When prompting "Edit", note that the story template has a `Decomposition` checklist — if the user wants to seed it with concrete tasks from the current conversation, regenerate with those tasks pre-filled in place of the empty checkboxes.

6. **Post-approval race re-check** (Layer 1): re-run `draft.mjs story "$ARGUMENTS"` and re-read its `collision` field — an exact-name `test -e` cannot see normalized cross-era collisions (`story-006-foo.md` vs `story-foo.md`). If `collision` is non-null, surface it as a topic collision (`"<identity>" already exists as <with>`), and ask: extend the existing story, pick a different slug (`-2` is a deliberate distinct identity), or cancel. Render `warnings` entries as `⚠️` lines in the preview too.

7. **On Yes** (path free): Write file.

8. **Suggest next**: "Now decompose the work in the `Decomposition` section, or run `/projectstore:kanban` to refresh the board. Before implementation: `/projectstore:story plan <story>`."

# Lifecycle gate flow (plan / close)

1. **Resolve the story file** (second argument). Ambiguous → list candidates and ask.

2. **Run the compute script** (pure — writes nothing):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/story-section.mjs" <plan|close> "<story-path>"
   ```

   It returns `{ path, changed, notes, content }`: section inserted when
   absent, status transition, lifecycle timestamps (`started_at` /
   `plan_updated_at` / `closed_at` — stamped unconditionally; the
   `lifecycle_gates` key gates checks, never data).

3. **Fill the section content** in the returned `content` before preview:
   - `plan` — write the Implementation Plan. When the story's `specs:` names a
     covering spec, the plan is a THIN ROUTE through that spec's behavioral
     contracts: which contracts, in what order, which files. Consult the
     planner agent's output if one ran. Do not restate the spec.
   - `close` — write the Final Summary (what changed / why / tests executed /
     risks & follow-ups), and update the Acceptance Criteria checkboxes with
     evidence suffixes: `- [x] <criterion> — evidence: <test | command | file:line>`.
     Check a box ONLY with real evidence (reviewer output, test run, command).

4. **Preview** path + notes + the changed sections. **Approval** via
   AskUserQuestion: Yes / Edit / No.

5. **Immediately before writing**, re-run the script and verify its `content`
   (before your section edits) still matches what you previewed against — a
   human may have edited the file in Obsidian meanwhile. On divergence:
   re-preview, re-ask.

5a. **Delegate the ceremony — enumerated case: story close** (ADR "Artifact
   content is authored by the context-holder, the write ceremony by a clerk").
   After the approval in step 4 and the re-check in step 5, on a `close`:
   - Write TWO files to the session scratchpad: the **scratch** (the full final
     content you previewed — sections filled) and the **baseline** (the script's
     raw `content` from step 2, BEFORE your section edits). They are different
     files with different jobs: the scratch is what gets copied to the target;
     the baseline is what `--check` compares against. Handing `--check` the
     scratch makes it report drift on every run.
   - **Model (ADR-008)**: resolve it with `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" agents model clerk --json --project "${CLAUDE_PROJECT_DIR}"` and pass `result.model` as the spawn's model parameter (`null` → pass nothing).
     Missing key, `inherit`, or unreadable config → pass nothing and let the
     agent's own frontmatter decide; never guess a model.
   - Capture doctor's summary line (`node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" doctor
     --vault`, last line) — the clerk needs it as the **pre-state**: it must not
     stop on findings that were already there and are not its own.
   - Spawn `projectstore:clerk` **as a foreground task** (you need its report to
     continue) with: the scratch path, the target path, the exact re-check
     invocation (`story-section.mjs close "<story-path>" --check
     <baseline-path>`), the derived targets (`kanban`, plus `indexes=<epic
     folder>` when status changed), and the doctor pre-state line. On a clean
     report (`verbatim: true`, `stopped_at: null`, doctor no worse than the
     pre-state) skip steps 6-6b — the clerk's report is the write evidence. On a
     stopped report: fix what diverged, then re-delegate (the resume rule: after
     the copy, the ceremony restarts at reconcile, not at the race gate) or
     finish the remaining steps yourself (the copy is idempotent).
   - No clerk available → perform steps 6-6b yourself. There is no fallback
     agent: a general-purpose writer is an unpinned procedure.

6. **On Yes** (undelegated path): Write the full file. On a `plan`, finish by
   suggesting `/projectstore:kanban` (the status changed) — 6a/6b below are the
   close's ceremony, not the plan's.

6a. **(close only) Reconcile** the touched derived targets through the core:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" reconcile --write --only kanban` (add
   `indexes=<epic folder>` when the status changed).

6b. **(close only) Verify**: `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" doctor --vault` (exit 1 = findings, not failure)
   — a close is not done while doctor got worse. Then suggest the reviewer's
   proposed `code_refs` via `/projectstore:codemap set` (the reviewer computes it
   from `scripts/diff-refs.mjs --since <started_at>`).

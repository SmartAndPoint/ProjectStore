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

1. **Check config**: stop if `.claude/projectstore.json` missing.

2. **Validate args**: epic-id (positional 1) + title (rest). If only one word, ask for the title. An optional `--spec SPEC-ID` names the covering spec — put it into the rendered draft's `specs:` list (inline flow: `specs: ["SPEC-001"]`). Under `spec_policy: required` (vault's `.projectstore.json`), remind that every story needs a covering spec before implementation starts.

3. **Render draft**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" story "$ARGUMENTS"
   ```

   The script fails if the epic folder does not exist. Surface the error and suggest `/projectstore:epic <id> "<title>"` first.

4. **Preview**: path + first ~25 lines.

5. **Approval** via AskUserQuestion: Yes / Edit / No.

   When prompting "Edit", note that the story template has a `Decomposition` checklist — if the user wants to seed it with concrete tasks from the current conversation, regenerate with those tasks pre-filled in place of the empty checkboxes.

6. **Post-approval race re-check** (Layer 1): re-run `draft.mjs story "$ARGUMENTS"` and re-read its `collision` field — an exact-name `test -e` cannot see normalized cross-era collisions (`story-006-foo.md` vs `story-foo.md`). If `collision` is non-null, surface it as a topic collision (`"<identity>" already exists as <with>`), and ask: extend the existing story, pick a different slug (`-2` is a deliberate distinct identity), or cancel. Render `warnings` entries as `⚠️` lines in the preview too.

7. **On Yes** (path free): write the file.

8. **Suggest next**: "Now decompose the work in the `Decomposition` section, or run `/projectstore:kanban` to refresh the board. Before implementation: `/projectstore:story plan <story>`."

# Lifecycle gate flow (plan / close)

1. **Resolve the story file** (second argument). Ambiguous → list candidates and ask.

2. **Run the compute script** (pure — writes nothing):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/story-section.mjs" <plan|close> "<story-path>"
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

6. **On Yes**: write the full file. Then suggest `/projectstore:kanban` (status
   changed) and — on `close` — the reviewer's proposed `code_refs` via
   `/projectstore:codemap set` (the reviewer computes it from
   `scripts/diff-refs.mjs --since <started_at>`).

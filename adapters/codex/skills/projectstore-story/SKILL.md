---
name: projectstore-story
description: "Create a new story inside an existing epic, run its lifecycle gates (plan / close), or put it in ToDo (ready). Arguments: <epic-id> <title> [--spec SPEC-ID] [--variant test] | plan <story> | close <story> | ready <story>."
---

## Runtime path

Resolve paths from this skill's own directory, never from the checkout or a
remembered cache path. The plugin root is two directories above this SKILL.md;
the bundled core is `<plugin-root>/node_modules/projectstore`. Before running
any ProjectStore command, export `PROJECTSTORE_CORE_ROOT` to that bundled-core
path in its own shell statement, then use `node "${PROJECTSTORE_CORE_ROOT}/…"`.
Do not prefix the command with the assignment: a shell expands the quoted path
before that inline assignment takes effect. If the bundled core is missing, stop
and report a broken plugin install; do not fetch a different version from npm.

## User arguments

The source command's host-substituted argument token is rendered here as
`<user-arguments>` (or `<user-arguments-without-fix>`). Before executing a
shown command, replace that token with the actual arguments from the user's
request and shell-quote values safely. Never pass the angle-bracket token
literally and never treat it as a shell variable.

You are managing a story: creating one, running its lifecycle gates, or
putting it in ToDo.

**Dispatch rule** (positional-1 contract, PS-SPEC story-007): if the first
argument is `plan`, `close` or `ready` AND the second argument resolves to an
existing story file (path, or `<epic-id>/<story-id>` searched under
`<vault>/epics/*/stories/`), run the **Lifecycle gate flow** below for `plan`
and `close`, and the **Ready flow** for `ready`. Otherwise this is a
**create** (first argument = epic id — uppercase by convention, so the words
cannot collide).

# Create flow

1. **Check config**: stop if `.projectstore/projectstore.json` missing.

2. **Validate args**: epic-id (positional 1) + title (rest). If only one word, ask for the title. An optional `--spec SPEC-ID` names the covering spec — put it into the rendered draft's `specs:` list (inline flow: `specs: ["SPEC-001"]`). Under `spec_policy: required` (vault's `.projectstore.json`), remind that a story needs a covering spec before implementation starts, or a `no_spec` reason declared at the plan gate.

   An optional `--variant test` makes a **test story**: one that plans the
   tests for a spec's contracts, written to the `story.test` guide. Only
   `test` is defined: refuse another value and name `test`. Remove `--variant test` and `--spec SPEC-ID` with its
   value from the arguments before any `draft.mjs` call, in step 3 and in the
   re-run of step 6: the script reads every remaining word as the title, so a
   flag left in would end up in the title and the slug.

2a. **Read the guide** for this kind before writing anything:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" guide story --project "$PWD"
   ```

   For a test story read `guide story.test` instead, in the same form.

   Write the draft to its `## Must`, `## Common mistakes`, `## Do not write`
   and `## Length`: the critic checks the same `## Must` items. Exit 1 means
   this kind has no guide; say so and go on.

3. **Render draft**:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/draft.mjs" story <epic-id> "<title>"
   ```

   The epic id and the title only, with the flags of step 2 removed. The
   script fails if the epic folder does not exist. Surface the error and suggest `$projectstore-epic <id> "<title>"` first.

3a. **For a test story**, replace the draft's commented `# variant: test …`
   line with `variant: test` before the preview, the way `--spec` fills
   `specs:`. The critic then reviews the story against `story.test`.

3b. **The Independent test line** (optional, under Description; its label is
   translated in each locale). When the conversation already says how this
   story is checked on its own (a command to run and what to see), write
   that sentence in place of the line's comment. Otherwise leave the
   placeholder as it is and invent nothing: it is a hint, not a gate. Quote
   the line in the preview.

4. **Preview**: path + first ~25 lines. Say also that, once the story is
   written, it is linked into its epic's Stories table when the epic has a
   table with a Status column there: a row that names it by its title gets
   the link, else one row is added. An epic whose stories are a list is left
   as it is.

5. **Approval** via the harness's user-input mechanism: Yes / Edit / No. A Yes also covers the
   story's row in its epic's Stories table (step 7a).

   When prompting "Edit", note that the story template has a `Decomposition` checklist — if the user wants to seed it with concrete tasks from the current conversation, regenerate with those tasks pre-filled in place of the empty checkboxes.

6. **Post-approval race re-check** (Layer 1): re-run `draft.mjs story <epic-id> "<title>"` (the same stripped arguments as step 3) and re-read its `collision` field — an exact-name `test -e` cannot see normalized cross-era collisions (`story-006-foo.md` vs `story-foo.md`). If `collision` is non-null, surface it as a topic collision (`"<identity>" already exists as <with>`), and ask: extend the existing story, pick a different slug (`-2` is a deliberate distinct identity), or cancel. Render `warnings` entries as `⚠️` lines in the preview too.

7. **On Yes** (path free): Write the file you previewed, with the step-2,
   step-3a and step-3b edits (`specs:`, `variant: test`, the Independent test
   line), not the re-run's raw draft.

7a. **The epic's Stories row.** After the write, under the one approval of
   step 5:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/status-change.mjs" epic-row "<story-path>" --add
   ```

   `<story-path>` is the `path` of the draft you wrote. It links the story
   into its epic's Stories table, re-reading `epic.md` before it replaces it,
   and prints the result as JSON: report its `row` (`added` or `linked`).
   The note `epic-row-missing`, exit 0, means the epic has no Stories table
   with a Status column: say so; the epic is not written and no table is
   invented. The note `epic-row-unlinkable`, exit 0, means the new row
   would not read back as the story's (a `#` or `?` in its file name, or an
   unclosed fence above the Stories heading): say so, and the epic is not
   written. On `added`, look at the table once: a row that names the story
   with other wording (a typo, a word left out) is still there without a
   link; point at it, and do not edit it yourself. A non-zero exit is a
   write error, such as
   `story-changed-meanwhile`: report it. It never undoes the create, and a
   second run of the same command finishes it.

8. **Suggest next**: "Now decompose the work in the `Decomposition` section, or run `$projectstore-kanban` to refresh the board. Before implementation: `$projectstore-story plan <story>`."

# Lifecycle gate flow (plan / close)

1. **Resolve the story file** (second argument). Ambiguous → list candidates and ask.

1a. **(plan only) A spec, or a reason.** When the vault's policy is
   `required` and the story has neither a `specs:` entry nor a `no_spec`
   reason, ask the user once: name the covering spec, or say in one sentence
   why this story needs no spec (a release, a text or site change, work with
   no non-trivial "how"). A reason becomes `--no-spec '<reason>'` in step 2 and
   in the re-run of step 5, single-quoted (write an apostrophe inside it as
   `'\''`). Research spikes take a light spec,
   not a reason. A story that will touch three or more source files needs a
   spec: the reviewer flags an opt-out like that at close.

1b. **(close only) The code_refs this close adds.** A close writes the
   files the story changed into its `code_refs`, and widens its epic's, behind
   the one Yes of step 4. Ask the core where those files come from. First,
   when this session's latest reviewer report on this story has a line that
   starts with `code_refs:`, copy the last such line verbatim into a scratch
   file, the **reviewer file** (`<scratchpad>/reviewer-refs.txt`). Then run,
   with `--reviewer-refs-file` only when you wrote that file:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" close-refs <EPIC-ID>/<story-id> --reviewer-refs-file "<reviewer-file>" --json --project "$PWD"
   ```

   It writes nothing, and it runs before the person's Yes; it may start the
   GitHub CLI (`gh`) to read the files of the story's pull request. Its
   `result` is `{ source, verified, refs, dropped, notes }`: `source` is `pr`
   (the files of the pull request in `external_refs.pr`), `reviewer` (the
   reviewer file's line), `commits` (the files of every commit since
   `started_at`, `verified: false`) or `none`; `dropped` lists each path left
   out, as `{ path, why }`. Exit 1 names no story: stop the gate and say so.

   Write the **refs file** (`<scratchpad>/code-refs.json`), a JSON list:
   `refs` for `pr` and `reviewer`; `[]` for `commits` and `none`. A
   `commits` result whose `refs` is `[]` is treated as `none`: nothing is
   offered. A `commits` list is written only when the person picks "write
   them" in step 4. Then act on each of its `notes` by its `code`:
   - `checkout-behind`: stop the gate before the preview and write nothing.
     Show the note's message and ask the person to pull, then run the close
     again.
   - `unverified`: the refs file stays `[]`; step 4 offers the list when it
     is not empty.
   - `gh-unavailable`, `repo-unknown`, `prefix-unknown`, `files-foreign`,
     `files-unknown`, `files-truncated`, `pr-closed`, `reviewer-refs-none`,
     `commits-unknown`: show the message verbatim in step 4's preview; the
     close goes on with what the verb gave (it already asked the next
     source).

   Every `story-section.mjs close` run of this close passes
   `--code-refs-file "<refs-file>"`: step 2, the re-run in step 5, and the
   clerk's `--check` of step 5a; a change of the refs file (an Edit of the
   list, or "write them") repeats step 2 with it. An exit 1 whose stderr
   names `code-refs-unreadable` stops the gate: the story's or its
   epic's `code_refs` is not a one-line JSON list; say which, and write
   nothing.

2. **Run the compute script** (pure — writes nothing):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/story-section.mjs" <plan|close> "<story-path>"
   ```

   On a plan with a reason from step 1a, add `--no-spec '<reason>'` to that
   command. It writes `no_spec` into the returned frontmatter, and it refuses
   a story that already lists specs. On a close, add
   `--code-refs-file "<refs-file>"` from step 1b: the returned content holds
   the story's `code_refs` with each ref of the file it did not hold appended,
   and with `[]` the line is left as it is.

   It returns `{ path, changed, notes, content }`: section inserted when
   absent, status transition, lifecycle timestamps (`started_at` /
   `plan_updated_at` / `closed_at` / `status_changed_at` — stamped
   unconditionally; the `lifecycle_gates` key gates checks, never data).
   A change of status also rewrites the header table's Status row and
   appends one line to the story's `## Status log`; on the move to
   in-progress, a story assigned to someone other than the binding's
   `default_author` gets that author, in `assignee`, the Assignee row and its
   own log line. The gate's defaults name the lines (`work started (plan
   gate)`, `closed (close gate)`); pass nothing else.

   On a `plan`, the JSON also carries `wip`. On the move to in-progress it
   is `{ assignee, held, after, limit, over, unread }` for the new assignee
   (the binding's `default_author`, else the story's own assignee) when that
   person has a WIP limit: `held` is their WIP before this run, `after` is
   `held + 1`, and `over` is `true` when the start goes over the limit (a
   note says when story files could not be read, so the count can be low).
   With no start, no new assignee or no limit, `wip` is `null`. After a Yes
   to step 2a's WIP question, run this command again with `--over-wip`
   added: it appends `; started over WIP limit <after>/<limit>` to the
   reason of the run's lines, and its `content` is the one you fill and
   preview. `--over-wip` is for `plan` only; `close` refuses it.

   **Files a verb wrote.** Both gates' JSON carries `marked`: the
   vault-relative paths of the files that hold `written_by_verb` (written by
   a create or an edit verb, and read by no review since): on a plan the
   story, its epic and the epic's initiative, on a close the story; `[]` when
   the vault's gates are off. When `marked` is not empty and `outside` is
   `true` (the story is in a worktree of the vault), stop the gate before
   any review: name the files, say that a mark is cleared in the bound
   vault, and write nothing. Otherwise run the steps of `$projectstore-review`
   for each path in turn (a marked story gets the critic although the story
   guide does not ask for one), then run this step again: on a plan, step
   2a and its round follow, the WIP question first; on a close, step 3
   follows, and the clerk's baseline in step 5a is that second run's
   `content`. A Skip, or a dismissed question, stops the gate, names the
   file, and writes nothing. A non-empty `marked` from the second run stops
   the gate too.

2a. **(plan only) Open questions, one round.** Before writing the plan,
   collect the open questions: the planner's "Open questions" when it ran,
   else your own; do not start the planner here. Keep only decisions the
   user must make; skip what the conversation, or an earlier
   `### Clarifications` in this plan, already settled. None is the normal
   case: then ask nothing and write nothing. Keep at most five, the one that
   changes the plan most first; with more, keep five, say how many were
   dropped, and suggest splitting the story; when the planner says it left questions out, say so in the same round, with its split suggestion. Each question has two to four
   options and one recommended option. Put them to the user in one round:
   one call of the harness's user-input mechanism for up to four questions; with five, or where
   the harness has no question tool, one plain-text message with the
   questions numbered. Ask once per gate run: the Edit in step 4 and the
   re-check in step 5 never ask again. A skipped question, or every question
   of a dismissed call, takes its recommendation, marked `(assumed)`. Record
   the round under `### Clarifications`, last in the plan: a line with
   today's date, then one bullet per question with its answer; a later plan
   run appends its own dated line to the same subsection. An answer that changes a
   contract of the covering spec says which one, and the spec is amended
   before the code is written: that contract's body is rewritten to the text
   in force, with a marker under it,
   `> amended YYYY-MM-DD by <EPIC-ID>/<story-id>: ADDED|MODIFIED|REMOVED — <why>`
   (see `guide spec`).

   **The WIP question.** When step 2's `wip.over` is `true`, the round's
   first question asks whether to start anyway, naming the person and
   `<after>/<limit>` ("<person> would hold <after>/<limit> stories: start
   anyway?"); its recommended answer is No, and it counts in the five, so at
   most four others are asked with it. It is asked under `lifecycle_gates:
   off` too: the `flow` block alone decides. On a Yes, step 2 runs again
   with `--over-wip`, and its `content` is the one filled and previewed. On
   a No, a skipped WIP question or a dismissed round, the gate ends and
   nothing is written. With `wip` null or not over, no WIP question is
   asked. The one exception to asking once per gate run is step 5's: when
   `wip.over` was false at step 2 and is true there, the WIP question is
   asked at step 5.

3. **Fill the section content** in the returned `content` before preview.
   Do not edit the stamps, the header table or the Status log in the returned
   content: the script owns them, and the re-check in step 5 compares them.
   - `plan` — write the Implementation Plan. When the story's `specs:` names a
     covering spec, the plan is a THIN ROUTE through that spec's behavioral
     contracts: which contracts, in what order, which files. Consult the
     planner agent's output if one ran. Do not restate the spec. End the plan
     with the step 2a round, when there was one.
   - `close` — write the Final Summary (what changed / why / tests executed /
     risks & follow-ups), and update the Acceptance Criteria checkboxes with
     evidence suffixes: `- [x] <criterion> — evidence: <test | command | file:line>`.
     Check a box ONLY with real evidence (reviewer output, test run, command).
     When the story's Independent test line is filled, in the Final Summary's
     tests executed, say whether the Independent test ran and how (the command
     and what was seen), or why not; the story closes either way.

4. **Preview** path + notes + the changed sections. **Approval** via
   the harness's user-input mechanism: Yes / Edit / No. A Yes also covers the story's row in its
   epic's Stories table, which step 6d sets to the new status.

   On a `close` only, before the preview, plan the epic rule as if the story
   were done (`<story-path>` is the absolute `path` from step 2):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/epic-rule.mjs" "<story-path>" --assume-done
   ```

   It writes nothing. Show in the preview the `line` of each epic it lists
   in `epics` and the `message` of each of its `notes`: any epic of the vault
   may be listed, not only this story's. Say that a Yes covers them too: it
   covers the rule's action on the vault as it is when step 6e runs, not this
   snapshot. A non-zero exit is shown in the preview with its `error` and
   does not hold the close. The plan gate does not run the rule.

   On a `close`, the preview also shows the code_refs from step 1b. Plan the
   epic's widening (it writes nothing):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/status-change.mjs" epic-refs "<story-path>" --code-refs-file "<refs-file>"
   ```

   With an empty list (`none`, a `commits` result with no refs, or an empty
   refs file before "write them"), say only "No code_refs are added: no
   source gave files for this story." and skip the sentences below but the
   commits offer. Otherwise show the refs counted by directory
   (`scripts/ 3, tests/ 2, README.md 1`), then these sentences, filled in:
   - always: "code_refs list the files this story changed; projectstore uses
     them in code-map.md and in doctor's checks to show which code each story
     and epic owns."
   - `pr`: "These come from the files of <url>, read through the GitHub CLI
     (gh)."
   - `reviewer`: "These come from the reviewer's last code_refs line", then
     the reason only when there is one: ", because the story names no pull
     request." when the story has none, or ", because the pull request's files
     could not be used." when a note of step 1b says so.
   - `commits`: "These are the files of every commit since <started_at>,
     other stories' included, not checked against this story." Ask "write
     them" or "leave them out" (recommended: leave them out) before the
     Yes / Edit / No question. Only "write them" puts the list in the refs
     file, repeats step 2 and runs the epic plan above again.
   - the epic: "A Yes also adds to the epic's code_refs: <add>." with the
     `add` list of the run above, or "The epic's code_refs already cover
     them." when it is empty. A non-zero exit (an epic with no epic.md, or a
     `code_refs` line it cannot read) is shown with its `error`, and the
     close stops there; the way out is to Edit the list to `[]` and run the
     close again, or to fix the epic and run the close again.

   Then the dropped paths, one per line as `<path> (<why>)`, and for
   `absent` say "not in this checkout" (an open pull request's new files land
   here). Then each note's message from step 1b, verbatim. An Edit
   of the list rewrites the refs file and repeats step 2; a Yes covers the
   refs and the epic's additions.

5. **Immediately before writing**, re-run the script and verify its `content`
   (before your section edits) still matches what you previewed against — a
   human may have edited the file in Obsidian meanwhile. On divergence:
   re-preview, re-ask. The stamps and the timestamps of Status log lines
   differ between runs; that is not a divergence.

   On a `plan`, re-run it with the same flags as the run you previewed,
   `--over-wip` included after a Yes to the WIP question, and compare
   `wip.over` as well as `content`, on every plan run, also when no WIP
   question was asked. A change of `wip.over` (another session of the same
   `default_author` started or closed work between steps 2 and 5) is a
   divergence: re-preview and re-ask. When `wip.over` was false at step 2
   and is true now, ask the WIP question here (start anyway at
   `<after>/<limit>`, recommended No); a Yes runs step 2 again with
   `--over-wip`, and a No, a skipped question or a dismissed one ends the
   gate with nothing written. Nothing is written before the new answer.

   On both gates, compare `marked` as you compare `wip.over`: when the
   re-run's `marked` is not empty (a file was marked again since step 2),
   stop the gate and write nothing.

   On a `close`, re-run it with the same `--code-refs-file`. When the
   re-check holds, widen the epic right away, on both paths, before 5a's
   doctor snapshot and before anything else is written:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/status-change.mjs" epic-refs "<story-path>" --code-refs-file "<refs-file>" --write
   ```

   It appends to the epic's `code_refs` each ref that no epic ref covers, as
   it is, and moves `updated` only when it adds one; a second run adds
   nothing. A non-zero exit stops the close: report its `error` and write
   nothing else.

5a. **Delegate the ceremony — enumerated case: story close** (ADR "Artifact
   content is authored by the context-holder, the write ceremony by a clerk").
   After the approval in step 4 and the re-check in step 5, on a `close`:
   - Write TWO files to the session scratchpad: the **scratch** (the full final
     content you previewed — sections filled) and the **baseline** (the script's
     raw `content` from step 2, BEFORE your section edits). They are different
     files with different jobs: the scratch is what gets copied to the target;
     the baseline is what `--check` compares against. Handing `--check` the
     scratch makes it report drift on every run.
   - **Model and effort (ADR-008)**: resolve them with `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" agents model clerk --json --project "$PWD"` and pass `result.model` as the spawn's model parameter, verbatim — never substitute the model you are running on (`null` → pass nothing),
     and `result.effort` as its effort parameter when it is not `null` and the spawn offers one.
     Missing key, `inherit`, or unreadable config → pass nothing and let the
     agent's own frontmatter decide; never guess a model.
   - Capture doctor's summary line (`node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" doctor
     --vault`, last line) — the clerk needs it as the **pre-state**: it must not
     stop on findings that were already there and are not its own.
   - **Snapshot the story, here in the main thread, right before you spawn the
     clerk, and again before every re-delegation.** The clerk's copy goes
     through Bash, which no hook sees, so this session's record of its vault
     writes learns of it from this bracket alone:

     ```bash
     node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session snapshot "<story-path>" --for "<scratch-path>" --json --project "$PWD"
     ```

   - Spawn `$projectstore-clerk` **as a foreground task** (you need its report to
     continue) with: the scratch path, the target path, the exact re-check
     invocation (`story-section.mjs close "<story-path>" --code-refs-file
     "<refs-file>" --check <baseline-path>`), the derived targets (`kanban`,
     plus `indexes=<epic folder>` when status changed, plus `codemap` when the
     refs file is not `[]`, plus `flow` when flow.md exists at the vault root),
     and the doctor pre-state line. On a clean
     report (`verbatim: true`, `stopped_at: null`, doctor no worse than the
     pre-state) skip steps 6-6b and run step 6c, then step 6d, then step 6e — the clerk's report is the write evidence. After
     any report with `written: true`, clean or stopped, first record the copy,
     before you fix anything or re-delegate:

     ```bash
     node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session record "<story-path>" --from "<scratch-path>" --json --project "$PWD"
     ```

     On a stopped report: fix what diverged, then re-delegate (the resume rule:
     after the copy, the ceremony restarts at reconcile, not at the race gate;
     take a new snapshot before the spawn) or finish the remaining steps
     yourself (the copy is idempotent).
   - No clerk available → perform steps 6-6c yourself, then 6d, then 6e. There is no fallback
     agent: a general-purpose writer is an unpinned procedure.

6. **On Yes** (undelegated path): Write the full file. On a `plan`, after
   step 6d, when flow.md exists at the vault root, refresh the flow page:
   `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only flow`
   — never when it does not exist, since `--only flow` creates it. Then finish
   by suggesting `$projectstore-kanban` (the status changed) — 6a/6b below
   are the close's ceremony, not the plan's.

   On a `plan`, right after the write, also refresh this session's story and,
   where the band is on, the WIP count, here in the main thread:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session refresh "<story-path>" --json --project "$PWD"
   ```

   `<story-path>` is the absolute `path` the compute script returned in
   step 2. With no session it still updates the WIP count, where the band is
   on, and exits 0; a non-zero exit is reported and never undoes the plan.

6a. **(close only) Reconcile** the touched derived targets through the core:
   `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only kanban` (add
   `indexes=<epic folder>` when the status changed, `codemap` when the refs
   file is not `[]`, and `flow` when flow.md exists, never otherwise:
   `--only flow` creates the page).

6b. **(close only) Verify**: `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" doctor --vault` (exit 1 = findings, not failure)
   — a close is not done while doctor got worse. The refs were written by the
   close itself (step 1b); `$projectstore-codemap set` stays the way to change
   or remove them later.

6c. **(close only, both paths) Refresh this session's story**, here in the
   main thread, after the clerk's clean report or after 6b:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session refresh "<story-path>" --json --project "$PWD"
   ```

   `<story-path>` is the absolute `path` the compute script returned in
   step 2. The copy went through Bash, which no hook sees, so without this the
   session's band and status line keep naming the closed story and, where
   the band is on, the WIP count keeps counting it. The core finds
   the session itself; with none it writes no pointer and exits 0. A non-zero
   exit is reported and never undoes the close.

   On the delegated path, run beside it the same record as in step 5a:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session record "<story-path>" --from "<scratch-path>" --json --project "$PWD"
   ```

   It appends nothing when the copy is already recorded, or when no snapshot
   is left, and says why; it exits 0 either way. The undelegated path has no
   scratch and no bracket: the hook records your own `Write`.

6d. **(both gates) The epic's Stories row.** After the story is written (by
   you or the clerk), and on a close after 6c:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/status-change.mjs" epic-row "<story-path>"
   ```

   It sets the Status cell of the story's row in its epic's Stories table to
   the status the file now holds, re-reading `epic.md` before it replaces it.
   It is idempotent, so a resumed ceremony may run it again. No row that
   links to the story (a list instead of a table, a row with no link) is the
   note `epic-row-missing`, exit 0: say so, and the epic is not written. A
   non-zero exit is a write error: report it; it never undoes the gate's
   write.

6e. **(close only, both paths) The epic rule.** Here in the main thread,
   after 6d, on the clerk's path and on the undelegated one alike (the clerk
   never runs it):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/scripts/epic-rule.mjs" "<story-path>" --write
   ```

   It makes done every epic of the vault that is due: its own status is
   neither done nor set aside, at least one of its stories is done, every
   other is done or set aside (`superseded`, `deferred`, `parked`), no open
   row of its Stories table lacks a story file, and every Expected Result is
   checked. It never moves an epic back, and it runs no reconcile. Whenever
   its `moved` is not empty, whatever the exit, refresh every derived view
   (an epic's status shows in the epics index, the code map and the graph; a
   bare `--write` refuses without a terminal, so all four targets are named)
   and check the vault:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" reconcile --write --only kanban,codemap,graph,indexes --project "$PWD"
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" doctor --vault --project "$PWD"
   ```

   Then name the moved epics to the user, since they may differ from the
   preview's, and pass on its notes (`epic-results-open`,
   `epic-rows-without-file`). Exit 1 is an epic's error, such as
   `story-changed-meanwhile` or a folder that cannot be written: report it;
   it never undoes the close, and the next close moves the epic.

6f. **(close only) The commit hint.** End the close with a one-line hint to
   commit the story's paths, and the epics step 6e moved, if the vault is
   git-tracked: run
   `$projectstore-precommit` before you commit those paths, and do what its
   last line says.

# Ready flow (ready)

`ready <story>` puts a `planned` story in ToDo: the one change of status no
gate makes. The core's `move` verb writes it, re-reading the story before it
replaces it. There is no clerk: there is no authored text to copy.

1. **Resolve the story** (second argument), as in the lifecycle flow. Its
   status must be `planned`; a `todo` story is already there, so say so and
   stop. Any other status: say which gate moves it (`plan` starts work,
   `close` finishes it) and stop.

2. **A reason, one line.** Take it from the conversation (why this story is
   next), or ask for one sentence. It goes into the story's Status log.

3. **The plan** (writes nothing):

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" move "<EPIC>/<story-id>" todo --reason '<reason>' --project "$PWD"
   ```

   Single-quote the reason, and write an apostrophe inside it as `'\''`.
   Exit 1 is a refusal that names the gate to use: show it and stop. Exit 2
   is a usage error: fix the arguments.

4. **Preview** the plan it prints, and ask via the harness's user-input mechanism: Yes / No.

5. **On Yes**, run the same command with `--write --json` added. The question
   in step 4 is the confirmation. The verb writes the story (`status: todo`,
   `status_changed_at`, the header's Status row, one `(move)` line in the
   Status log), sets its row in the epic's Stories table and refreshes the
   derived views itself. Report the result's `line` and its `epic` row. A
   non-zero exit is reported as it is: `story-changed-meanwhile` means the
   file kept changing and was left; run the flow again.

6. **Suggest next**: `$projectstore-story plan <story>` when work starts.

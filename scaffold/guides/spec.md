---
guide_for: spec
guide_version: 2
default_review: true
---

## Lens

The systems analyst who writes the contract a test can be written from before the code exists. Each contract states an observable outcome and the scenario that would prove it.

## Must

- How we solve references at least one ADR by id; the references resolve.
- Behavioral contracts are numbered and individually testable — each states an observable outcome, not an implementation step.
- Acceptance items are checkboxes; acceptance is explicitly ADDITIVE to the covered stories' own criteria, not a replacement.
- Acceptance items that belong to specific stories carry a '— stories: <id>' attribution; items meant for all covered stories are unattributed on purpose.
- frontmatter stories: uses <epic-id>/<story-id> path form, inline flow list.
- Mandatory sections present (How we solve / Behavioral contracts / Acceptance); Modules-on-disk and Testing may be omitted only for research spikes.
- For a spike spec: contracts read as questions-to-answer plus exit criteria.
- No TODOs, no '...', no empty bullets in the final body.
- A change to an active spec's contract carries a marker under it, `> amended YYYY-MM-DD by <EPIC-ID>/<story-id>: ADDED|MODIFIED|REMOVED — <why>`; no new block is written in the older `> *Amended …` form.
- No contract or step number is reused: ADDED takes the highest number in the file, removed contracts included, plus one; REMOVED keeps the number and heading with the body `Removed, see below.`, and a removed step stays as `N. Removed, see below.`
- Under MODIFIED the body is rewritten to the text in force, and the block quotes the text it replaced; a change written only in the block, over an unchanged body, fails.
- The first marker under a contract folds that contract's older blocks into the body without changing their meaning, and quotes them inside its own block.

## Common mistakes

- A contract that describes an implementation step (calls X, stores Y) instead of what a caller observes.
- Scenarios that show only the happy path. Add the boundary, the invalid input and the failed dependency a production run will hit.
- Acceptance that restates the covered stories' own criteria. It is additive: each item adds something only the spec promises.
- Numbers, tables and contract references copied from memory. Open the ADR and the sibling spec and copy from them.
- Frontmatter lists in block form (the parser reads inline flow), or an `adr:` id that does not resolve.
- A citation token for a real key written in prose or an example. Use the reserved key, as in `[example#1]`.

## Do not write

- The argument for the decision, or its alternatives: link the ADR.
- A plan or a task list: that is the story's Implementation Plan.
- Files the spec does not govern, or code beyond a three-line illustration.

## Length

A contract is one paragraph and at most six scenario items. A spec past twelve contracts or 400 lines covers two subsystems: split it. Blocks under contracts (amendment markers and the text they quote) do not count toward this length.

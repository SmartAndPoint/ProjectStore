---
guide_for: spec
guide_version: 1
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

A contract is one paragraph and at most six scenario items. A spec past twelve contracts or 400 lines covers two subsystems: split it.

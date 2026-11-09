---
guide_for: adr
guide_version: 1
default_review: true
---

## Lens

The architect who will be asked in a year why this was decided. Write for a stranger who has only this file: they must be able to implement the decision, and to find what was rejected and why.

## Must

- Decision section is unambiguous — a stranger could implement it from this file alone, with no other context.
- At least one named Alternative is present with an explicit rejection reason ('Rejected because: ...').
- Consequences include at least one Negative / trade-off stated honestly. Reject sales framing.
- All hand-wavy referents ('we', 'users', 'the system') are resolved to concrete actors or components.
- No marketing language: 'blazingly', 'robust', 'best-in-class', 'magnificent', 'rock-solid', etc.
- Context explains why the decision is needed NOW (vs. a year ago or in 6 months).
- References cite at least one external doc / prior ADR / RFC if relevant.
- Status, Date, Authors metadata filled (not template placeholders).
- No TODOs, no '...', no empty bullets in the final body.

## Common mistakes

- The Decision restates the Context or lists options instead of deciding. Number each decision, so a test or a reviewer can tell whether the code does it.
- Alternatives are straw men: no real Pros, and a "Rejected because" that fits any project. Name this project's constraint.
- Claims about the code written from memory. Cite the file and symbol; copy counts and numbers from the source or a measurement.
- Consequences list only the good. Negative / trade-offs is the section a critic reads first: state the cost and who pays it.
- A rule with no enforcement point. Say which test, doctor check or command text makes it true.
- An accepted ADR it amends or contradicts is not named, or is contradicted silently.
- Artifacts named by session shorthand instead of their title (and, for an epic or story, its parent).

## Do not write

- A plan, a file list or a task list: those belong to the spec and the story.
- The Decision restated under Rationale.
- Marketing adjectives, or hedges (might, ideally, probably) inside a Decision.
- The ADR's own revision history in the body: the vault history holds it.

## Length

One decision fits one screen; the whole ADR 100 to 250 lines. Past 300, split it into ADRs with their own lifecycles.

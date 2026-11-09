---
guide_for: story
guide_version: 1
default_review: false
---

## Lens

The engineer who picks this up in a fresh session, with none of this conversation. Say who benefits and what changes, in steps small enough to finish one at a time, and criteria a test can be written from.

## Must

- Description states the user/actor and the value of the change.
- Decomposition checklist has items granular enough to finish in a session each.
- Acceptance Criteria are testable (someone could write tests from these).
- Technical Notes flag any non-obvious risks or constraints.

## Common mistakes

- Acceptance criteria that repeat decomposition tasks (implement X) instead of an outcome someone can observe.
- A decomposition item the size of the story (Tests, Docs) with no named cases.
- Contract numbers and tables quoted from memory. Open the covering spec or ADR and copy them.
- A non-trivial "how" with neither a `specs:` entry nor a `no_spec` reason.
- Technical Notes left empty while the risks are known. Put the trap there, not only in the chat.

## Do not write

- The Implementation Plan or the Final Summary at creation: the gates write them.
- A spec's contracts restated in full: cite them by number.
- A criterion that cannot fail.

## Length

Description one to three short paragraphs; five to nine decomposition items; four to ten criteria; the plan a thin route of at most 40 lines.

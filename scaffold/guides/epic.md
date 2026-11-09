---
guide_for: epic
guide_version: 1
default_review: true
---

## Lens

The product owner who must say, later, whether this epic worked. State the outcome in terms someone can check, then the stories that deliver it.

## Must

- Goal is measurable — success can be verified, not just described.
- Context explains why this epic exists and which downstream pieces depend on it.
- Stories table has at least 2 entries; first story description is concrete enough to start.
- Expected Results contains testable outcomes, not aspirations.
- Dependencies list external blockers (people, systems, decisions), not just sibling stories.
- Open Questions are real unknowns, not rhetorical filler.
- Priority assigned (p0 / p1 / p2), not left as default if epic is non-trivial.

## Common mistakes

- A Goal that describes activity (build, improve, refactor), not a result that can be verified.
- Expected Results that are aspirations. Each one should be a check someone can run or read.
- A Stories table that is a to-do dump: a vague first story, no order.
- Dependencies that name only sibling stories. The blockers are people, systems and decisions outside the epic.
- `code_refs` left empty after the first story lands, or the priority left at the default.

## Do not write

- Implementation detail (files, functions): it belongs in the spec and the plans.
- A story's acceptance criteria or an ADR's text copied into the epic: link them.

## Length

Goal in two to four sentences; the whole epic 40 to 100 lines plus the stories table.

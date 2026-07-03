<!-- projectstore:agents v1 (managed by projectstore — edit outside markers) -->
## projectstore agents

- After authoring or revising any vault artifact (ADR/research/epic/story) or
  design proposal: run the `projectstore:critic` agent on it before treating it final.
- Before implementing an epic/story: consult `projectstore:planner` — it plans
  against how prior epics map to the codebase (`code_refs`).
- After writing code, before commit / story-done: run `projectstore:reviewer` —
  it verifies the diff actually closes the story's acceptance criteria.
- When discussing vault contents, reference artifacts by their frontmatter
  `title:` (with their parent epic), never by session-invented shorthand.
<!-- /projectstore:agents -->

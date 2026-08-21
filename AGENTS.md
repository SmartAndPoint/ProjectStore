<!-- projectstore:agents v4 (managed by projectstore — edit outside markers) -->
## projectstore agents

- **Names carry a harness prefix, and it differs.** On Claude Code the agents are
  `projectstore:critic` / `:planner` / `:reviewer` and the commands are
  `/projectstore:adr`; on Codex and other harnesses the same things are
  `projectstore-critic` and `/projectstore-adr`. Use whichever spelling your
  harness actually lists — never invent the other one. Below they are named bare
  (`critic`) because this file is read by every harness you use.
- **A feature-sized request opens a vault artifact before it opens an editor.**
  Analysis → placement (which epic, which story) → an ADR and/or spec when the
  "how" is non-trivial → the `critic` agent → only then implementation → the
  `reviewer` agent. "Feature-sized" is not a judgement about how the request was
  phrased — it is about what the work touches: if you are about to write across
  several source files, open the story first.
- **Report instruction conflicts; do not arbitrate them.** If a session-level or
  harness-level instruction contradicts this block, say so and ask which wins.
  Resolving it silently is how the contradiction becomes invisible to the person
  who could have settled it.
- When spawning any agent below, resolve its model from the projectstore config
  — `.claude/projectstore.json` under Claude Code, `.codex/projectstore.json`
  under Codex; the plugin searches every harness's directory, so a project binds
  once — reading `agents.per_agent.<name>.model ?? agents.default.model`, where
  `<name>` is the **bare** agent name (`critic`), and pass it as the spawn's
  model parameter. No key — pass nothing.
- After authoring or revising any vault artifact (ADR/research/epic/story) or
  design proposal: run the `critic` agent on it before treating it final.
- Before implementing an epic/story: consult `planner` — it plans against how
  prior epics map to the codebase (`code_refs`).
- After writing code, before commit / story-done: run `reviewer` — it verifies
  the diff actually closes the story's acceptance criteria.
- When discussing vault contents, reference artifacts by their frontmatter
  `title:` (with their parent epic), never by session-invented shorthand.
<!-- /projectstore:agents -->

## projectstore development (this repository only)

_Not part of the managed block above: these rules are about developing
projectstore itself and are not written into projects that bind to it._

- **A surface added for one harness is added for all of them.** `commands/`,
  `agents/`, `skills/` and `hooks/hooks.json` are the source; everything under
  `adapters/` is generated. After touching any of them run
  `node scripts/build-adapters.mjs` and commit the regenerated tree in the same
  change — `tests/portability.test.mjs` fails while it is stale. Never hand-edit
  a file under `adapters/`. If a passage genuinely does not apply to a harness,
  gate it (`<!-- projectstore:harness only=… -->`, or `harness-only:` in
  frontmatter) rather than leaving it to translate into nonsense. Content meant
  for a harness OTHER than Claude Code goes in the commented `harness-alt` form,
  because Claude Code reads these files as they are on disk.
- **Never read a `CLAUDE_*` environment variable outside `scripts/harness.mjs`.**
  Paths, config locations, tool names and command spellings come from
  `harnesses/<id>.json` through that module. A direct read silently resolves to
  the wrong thing on every other harness instead of failing.

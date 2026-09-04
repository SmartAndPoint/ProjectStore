---
description: Manage bundled-agent integration in this project — register/unregister the routing block in CLAUDE.md/AGENTS.md, inspect state, or configure which model its agents run on.
argument-hint: "<register | unregister | status | configure>"
---

You are managing projectstore's agent integration (ADR-002 block lifecycle,
ADR-003 presets as revised by ADR-008 — model per invocation, no copies). Require a bound project for every
subcommand (`.claude/projectstore.json`; else point to `/projectstore:bind`).

## `register` — write the managed routing block

1. **Ask** via AskUserQuestion: "Register projectstore's agents in
   CLAUDE.md/AGENTS.md so every session routes to them (critic after
   authoring artifacts, planner before implementing, reviewer before commit)?
   [Yes / No]". On No, stop.
2. **Run the verb** and print its output verbatim:
   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/install-harness.mjs" install --harness claude-code --surface agents_block --project "<abs project dir>"
   ```
   It renders the block from the installed plugin's template ∩ the layout's
   roster (`scaffold/layouts/<layout>.json` — only routable agents get lines;
   the entry-rule line, the instruction-conflict line, the
   model-resolution line and the vault-communication line always stay), places it (`AGENTS.md` when it
   exists, else `CLAUDE.md`; a block in the other file is migrated, never
   duplicated; `CLAUDE.md` gets an `@AGENTS.md` import), previews every
   write, and applies because the harness is named. A current block is
   reported and left alone; a stale one is replaced in place with the user's
   prose byte-identical.
3. A non-zero exit is a refusal — a duplicated or unclosed block, a missing
   template — relay it and stop. Never write the block with the Write or Edit
   tool: the verb is the only writer (install spec, contract 6).

## `unregister` — remove what register added

1. Ask via AskUserQuestion ("Remove projectstore's agents block? [Yes / No]"),
   then run and print verbatim:
   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/install-harness.mjs" uninstall --harness claude-code --surface agents_block --project "<abs project dir>"
   ```
   It removes the marked block; deletes a `CLAUDE.md` that held nothing else,
   or nothing but the `@AGENTS.md` import registration added; and leaves every
   user-authored line in place.

## `status` — read-only report

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/install-harness.mjs" plan --json --surface agents_block --project "<abs project dir>"`
and report each item's `state` (`ours-current`, `ours-stale` with its reason,
`ours-absent`, or a refusal). Then, from the same read:

- Block: present in which file, marker version vs the installed template, agent
  names vs the layout roster.
- Model: the resolved model per roster agent from `projectstore.json → agents`
  (per-agent value, else default, else "the agent's own frontmatter"), and
  whether `CLAUDE_CODE_SUBAGENT_MODEL` is set (it overrides everything) and
  whether `CLAUDE_CODE_EFFORT_LEVEL` is set (ADR-008 makes it the only thing that
  can move the agents off `effort: max`, and it beats frontmatter). **Warn when
  the clerk resolves to anything but `sonnet` or `haiku`** (that literal pair is
  the rule, so it is never re-derived; an unknown custom id also warns, with
  "verify it is cheap"): the clerk transcribes approved
  content and runs a pinned procedure — paying reasoning-model prices there is
  the misallocation its ADR exists to end; point at `configure` to pin
  `per_agent.clerk`.
- Leftover copies: anything in `.claude/agents/` or `~/.claude/agents/` carrying
  `# source: projectstore v…`. Report these as **overriding nothing** (ADR-008)
  and point at `configure` to clean them up — do not present them as the active
  configuration, because they are not.

## `configure` — model per invocation, recorded in config (ADR-008)

> **Why there are no override copies here.** ADR-003 wrote
> `<project>/.claude/agents/<name>.md` believing an equal `name:` shadows the
> bundled agent. It does not: plugin agents register as `projectstore:<name>`,
> project agents bare, so the names never collide, the scope-priority rule never
> fires, and the copy becomes a **sibling** — the registration block keeps
> invoking the bundled agent and the model pinned in the copy never runs.
> Verified by invoking both ids (ADR-003's field note). ADR-008 replaces the
> mechanism: the choice lives in config and rides the **per-invocation `model`
> parameter**, which sits above the agent file's frontmatter.

1. **Preset question** (one choice for ALL roster agents), with this education
   line in the question text: *"These agents don't write code — they are
   critics, planners, and reviewers; they perform best on strong models at high
   effort. The one exception is the clerk, which only transcribes approved
   content — it stays cheap regardless of the preset."* Options: keep bundled default (`opus`) / `fable` / `sonnet` /
   custom model ID (free-form). Offer the current session's model as a hint
   option — you know what you are running on. **Do not ask about effort** — see
   step 5. **`inherit` is no longer offered**: it meant "follow the session's
   model", and that cannot be expressed per invocation — passing nothing falls
   through to the bundled `model: opus`, not to the session. A user who wants
   session-follow behaviour should pick their session's model explicitly, or set
   `CLAUDE_CODE_SUBAGENT_MODEL=inherit`, which does mean exactly that.
2. **Optional follow-up**: "configure individually?" → per-agent model for each
   roster agent. Skippable.
3. **Apply**: write the choice to `projectstore.json → agents: { default:
   {model}, per_agent: { <name>: {model} } }` (approval-gated config edit).
   **Whenever this step writes `agents.default.model`, it also writes
   `per_agent.clerk.model: "sonnet"`** — a strong roster preset must not silently
   lift the clerk with it. An explicit clerk choice made in step 2 wins over
   this automatic pin; only the absence of one triggers it. The same offer
   applies as a **migration**: an existing config carrying `agents.default.model`
   with no `per_agent.clerk` gets the pin proposed on any `configure` run, not
   only when the preset changes.
   That file is the whole output of this command — **never write an agent copy
   into `.claude/agents/`**. Omitting the key means "leave it to the agent's own
   frontmatter". Do not write an `effort` key; if one is present from a
   pre-ADR-008 config, drop it in the same edit and say so — it has no effect and
   leaving it reproduces the very defect this mechanism closes (the effort you
   configured is not the effort that runs).
4. **Migrate away from copies**: if `.claude/agents/` holds copies carrying
   `# source: projectstore v…`, they are pre-ADR-008 leftovers that override
   nothing. Offer to delete them **one approval per file** (matching `/projectstore:doctor --fix`), project scope only — a copy in `~/.claude/agents/` needs a manual removal, and you should say so rather than implying this command will handle it.
   Copies WITHOUT the provenance marker are user-authored — never touch them,
   never mention deleting them.
5. **Effort is not configurable per project.** The bundled agents ship
   `effort: max`, which is the recommended value, and there is no
   per-invocation effort parameter — only frontmatter, settings, or
   `CLAUDE_CODE_EFFORT_LEVEL`. If the user asks for a different effort, say
   that plainly and point at the env var; do not write a copy to achieve it.
6. **Honesty notes to print**: an org `availableModels` allowlist silently
   downgrades excluded models; the `CLAUDE_CODE_SUBAGENT_MODEL` env var
   overrides everything configured here, per-invocation parameter included.
   `/projectstore:doctor` validates config shape and reports leftover copies —
   not entitlement, and not whether a given spawn actually passed the model.
7. **No restart is needed** — nothing about the agent list changed. The model
   takes effect on the next invocation that reads the config (step "Model
   resolution" below).

## Model resolution — how the configured model is actually used

Any surface that spawns a roster agent (this plugin's own commands, and the
registration block's instructions) resolves the model as:

```
agents.per_agent.<name>.model  ??  agents.default.model  ??  (nothing — use the agent's frontmatter)
```

read from `<project>/.claude/projectstore.json`, and passes it as the spawn's
model parameter. If the config is missing, unreadable, or has no key for this
agent, pass nothing — the agent's own frontmatter decides. Never guess a model.

`agents.default` is optional and often absent (a per-agent-only config is normal);
the resolution must tolerate that. An `effort` key, if present, is a pre-ADR-008
leftover: ignore it.

**Coverage, stated honestly.** This reaches spawns made by this plugin's commands
and spawns a session makes while following the registration block. It does *not*
reach description-based auto-delegation, where the platform picks the agent and
there is no invocation site to attach a model to — those always run the bundled
frontmatter. `CLAUDE_CODE_SUBAGENT_MODEL` is the only mechanism that covers every
path, at the cost of applying to every subagent on the machine.

## Notes

- Uninstalling the plugin removes these commands but NOT the block — run
  `unregister` first, or delete everything between the
  `<!-- projectstore:agents -->` markers by hand.
- Never write any file without AskUserQuestion approval.

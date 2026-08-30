---
description: Manage bundled-agent integration in this project — register/unregister the routing block in CLAUDE.md/AGENTS.md, inspect state, or configure which model its agents run on.
argument-hint: "<register | unregister | status | configure>"
---

You are managing projectstore's agent integration (ADR-002 block lifecycle,
ADR-003 presets as revised by ADR-008 — model per invocation, no copies). Require a bound project for every
subcommand (`.claude/projectstore.json`; else point to `/projectstore:bind`).

## `register` — write the managed routing block

1. **Generate the block from the installed plugin, never from documentation**:
   read `$CLAUDE_PLUGIN_ROOT/templates/claude-md-block.md.tmpl` and keep only the
   agent lines whose agent appears in the active layout's `agents` roster
   (`scaffold/layouts/<layout>.json`); the **entry-rule line, the
   instruction-conflict line, the model-resolution line and the
   vault-communication line always stay** — none of them is an agent line, and
   stripping any would leave a versioned block with none of the content that
   version exists for (which `checkAgentsBlock` cannot detect: it compares the
   marker version only). The entry rule matters most here: in a project with
   hooks disabled the block is the only thing carrying it.
   Only *routable* agents get lines (critic/planner/reviewer) — `librarian`,
   `archaeologist` and `clerk` have no per-turn trigger and are deliberately
   absent (for the clerk this is the covering ADR's decision 6: it is invoked by
   command flows, never by conversation shape).
2. **Scan BOTH `CLAUDE.md` and `AGENTS.md`** for `<!-- projectstore:agents` markers:
   - block already present in the preferred location and current version → report "already registered", stop;
   - present in the non-preferred location → offer to **migrate** (move, never duplicate);
   - stale version marker → offer to replace the block in place.
3. **Placement** (never duplicate): `AGENTS.md` exists → block goes there, and
   ensure `CLAUDE.md` contains an `@AGENTS.md` import line (add with approval if
   missing). Else → `CLAUDE.md` (create the file with approval if absent).
4. **Every write approval-gated** (path + diff preview via AskUserQuestion). The
   step fans out to 2–3 prompts in the common case — that is by design.

## `unregister` — remove what register added

1. Remove the marked block (approval with diff preview).
2. With a **separate** approval each: remove an `@AGENTS.md` import line that
   registration added, and delete a `CLAUDE.md` that registration created if it
   is now otherwise empty. Never touch user-authored content.

## `status` — read-only report

- Block: present in which file, marker version vs the installed template, agent
  names vs the layout roster.
- Model: the resolved model per roster agent from `projectstore.json → agents`
  (per-agent value, else default, else "the agent's own frontmatter"), and
  whether `CLAUDE_CODE_SUBAGENT_MODEL` is set (it overrides everything) and
  whether `CLAUDE_CODE_EFFORT_LEVEL` is set (ADR-008 makes it the only thing that
  can move the agents off `effort: max`, and it beats frontmatter). **Warn when
  the clerk resolves to anything but `haiku`** (that literal is the rule, so it
  is never re-derived; an unknown custom id also warns, with "verify it is
  cheap"): the clerk transcribes approved
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
   `per_agent.clerk.model: "haiku"`** — a strong roster preset must not silently
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

- Uninstalling the plugin removes these commands but NOT the block — removal is
  a one-line delete between the `<!-- projectstore:agents -->` markers (this
  snippet belongs in the uninstall docs).
- Never write any file without AskUserQuestion approval.

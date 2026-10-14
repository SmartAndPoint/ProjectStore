---
description: Manage bundled-agent integration in this project — register/unregister the routing block in CLAUDE.md/AGENTS.md, inspect state, or configure which model each of its agents runs on and at what effort.
argument-hint: "<register | unregister | status | configure>"
---

You are managing projectstore's agent integration (ADR-002 block lifecycle,
ADR-003 presets as revised by ADR-008 — model per invocation, no copies). Require a bound project for every
subcommand (`.projectstore/projectstore.json`; else point to `/projectstore:bind`).

## `register` — write the managed routing block

1. **Ask** via AskUserQuestion: "Register projectstore's agents in
   CLAUDE.md/AGENTS.md so every session routes to them (critic after
   authoring artifacts, planner before implementing, reviewer before commit)?
   [Yes / No]". On No, stop.
2. **Run the verb** and print its output verbatim:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" install --harness claude-code --surface agents_block --project "${CLAUDE_PROJECT_DIR}"
   ```
   It renders the block from the installed plugin's template ∩ the layout's
   roster (`scaffold/layouts/<layout>.json` — only routable agents get lines;
   the entry-rule line, the instruction-conflict line, the
   model-resolution line and the vault-native communication line always stay), places it (`AGENTS.md` when it
   exists, else `CLAUDE.md`; a block in the other file is migrated, never
   duplicated; `CLAUDE.md` gets an `@AGENTS.md` import), previews every
   write, and applies because the harness is named. A current block is
   reported and left alone; a stale one is replaced in place with the user's
   prose byte-identical.
3. A non-zero exit is a refusal — a duplicated or unclosed block, a missing
   template — relay it and stop. Never write the block with the Write or Edit
   tool: the verb is the only writer (install spec, contract 6). One exception,
   read from the output, not assumed: when it shows the block applied and the
   `layout` item skipped as deferred to a terminal outside the session, the
   exit 1 is that deferral. The block is registered — say so, and for the move
   relay the command the startup line or `/projectstore:doctor`'s
   `layout-legacy` finding names; never compose one. Any other non-zero exit
   is a refusal.

## `unregister` — remove what register added

1. Ask via AskUserQuestion ("Remove projectstore's agents block? [Yes / No]"),
   then run and print verbatim:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" uninstall --harness claude-code --surface agents_block --project "${CLAUDE_PROJECT_DIR}"
   ```
   It removes the marked block; deletes a `CLAUDE.md` that held nothing else,
   or nothing but the `@AGENTS.md` import registration added; and leaves every
   user-authored line in place. A non-zero exit is a refusal (a block whose
   open marker was re-wrapped, or that appears twice in one file) — relay it
   and stop; never report success over it, and never remove the block by hand.

## `status` — read-only report

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" plan --json --surface agents_block --project "${CLAUDE_PROJECT_DIR}"`
and report each item's `state` from `result.items[]` — the bin wraps the plan in its envelope (`ours-current`, `ours-stale` with its reason,
`ours-absent`, or a refusal). Then:

- Block: present in which file, marker version vs the installed template, agent
  names vs the layout roster.
- Model: run `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" agents show --json --project "${CLAUDE_PROJECT_DIR}"`
  and report `result.resolved` — per roster agent, the model the verb would
  pass and its `source` (`per_agent`, `default`, or `null`: the agent's own
  frontmatter), and the effort with its `effort_source` the same way, resolved by the verb over the active harness's overlay
  (`result.path`) so nothing here re-derives it; `result.unknown` (configured
  names no roster agent carries — nothing runs under them), `result.rejected`
  (keys the overlay may not carry) and `result.agents_in_binding` (a pre-0.28
  leftover; point at `upgrade`), and
  whether `CLAUDE_CODE_SUBAGENT_MODEL` is set (it overrides everything) and
  whether `CLAUDE_CODE_EFFORT_LEVEL` is set (it outranks every configured effort
  and the frontmatter: with it set, the spawn offers no effort parameter). **Warn when
  `result.resolved.clerk.model` is anything but `sonnet` or `haiku`** (that
  literal pair is the rule, so it is never re-derived; an unknown custom id also
  warns, with "verify it is cheap"): the clerk transcribes approved
  content and runs a pinned procedure — paying reasoning-model prices there is
  the misallocation its ADR exists to end; point at `configure` to pin
  `per_agent.clerk`.
- Leftover copies: anything in `.claude/agents/` or `~/.claude/agents/` carrying
  `# source: projectstore v…`. Report these as **overriding nothing** (ADR-008)
  and point at `configure` to clean them up — do not present them as the active
  configuration, because they are not.

## `configure` — model and effort per invocation, recorded in config (ADR-008; the effort ADR)

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
   option — you know what you are running on. Then ask the effort for the
   preset — `low` / `medium` / `high` / `xhigh` / `max`, or "leave it to the
   frontmatter" (`max`) — see step 5. **`inherit` is no longer offered**: it meant "follow the session's
   model", and that cannot be expressed per invocation — passing nothing falls
   through to the bundled `model: opus`, not to the session. A user who wants
   session-follow behaviour should pick their session's model explicitly, or set
   `CLAUDE_CODE_SUBAGENT_MODEL=inherit`, which does mean exactly that.
2. **Optional follow-up**: "configure individually?" → per-agent model and
   effort for each roster agent. Skippable.
3. **Apply**: after the AskUserQuestion, run the verb and print its output —
   `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" agents configure --harness claude-code --default <model> [--agent <name>=<model> …] --project "${CLAUDE_PROJECT_DIR}"`
   (naming the harness is the confirmation; the verb writes
   `.projectstore/harness/claude-code.json → agents` and nothing else — never
   Edit or Write the file yourself). **Whenever `--default` is set and no
   `--agent clerk=…` is, the verb pins `per_agent.clerk.model: "sonnet"`** and
   says so — a strong roster preset must not silently lift the clerk with it;
   an explicit clerk choice in step 2 (`--agent clerk=<model>`) wins. The same
   applies as a **migration**: an overlay carrying a default with no clerk pin
   gets the pin on any `configure` run. `--agent <name>=` (empty) removes a
   per-agent key; `--reset` empties the block ("leave every agent to its own
   frontmatter"), and a `--default`/`--agent` given with it applies on top of
   the emptied block. A name outside the layout's roster is a usage error
   naming the roster — a model written under a name no agent carries would
   never run. That file is the whole output of this command — **never write
   an agent copy into `.claude/agents/`**. `agents configure` keeps every
   effort the overlay holds; `--reset` drops them with the models.
   **Efforts** chosen in steps 1–2 are written by `configure`, the one verb
   with effort keys — preview first, then apply after the same approval:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" configure --set agents.default.effort=<level> [--set agents.<name>.effort=<level> …] --harness claude-code --dry-run --project "${CLAUDE_PROJECT_DIR}"`,
   then the same command without `--dry-run`. `-` as the level clears one. A
   default effort with no clerk effort named leaves the clerk at the default
   on Claude Code (its frontmatter's `max` is already the most it runs at).
4. **Migrate away from copies**: if `.claude/agents/` holds copies carrying
   `# source: projectstore v…`, they are pre-ADR-008 leftovers that override
   nothing. Offer to delete them **one approval per file** (matching `/projectstore:doctor --fix`), project scope only — a copy in `~/.claude/agents/` needs a manual removal, and you should say so rather than implying this command will handle it.
   Copies WITHOUT the provenance marker are user-authored — never touch them,
   never mention deleting them.
5. **Effort rides the spawn, like the model.** The overlay's
   `agents.per_agent.<name>.effort ?? agents.default.effort` is passed as the
   spawn's effort parameter; with none, the bundled agents run at their
   frontmatter's `effort: max`. A level outside `low`, `medium`, `high`,
   `xhigh`, `max` is written with a warning and refused by the spawn. Do not
   write a copy to achieve an effort.
6. **Honesty notes to print**: an org `availableModels` allowlist silently
   downgrades excluded models; the `CLAUDE_CODE_SUBAGENT_MODEL` env var
   overrides everything configured here, per-invocation parameter included;
   `CLAUDE_CODE_EFFORT_LEVEL` overrides every configured effort, and a
   `maxEffortLevel` setting or an organization's effort cap still limits the
   level an agent runs at.
   `/projectstore:doctor` validates config shape and reports leftover copies —
   not entitlement, and not whether a given spawn actually passed the model.
7. **No restart is needed** — nothing about the agent list changed. The model
   takes effect on the next invocation that reads the config (step "Model
   resolution" below).

## Model resolution — how the configured model is actually used

Any surface that spawns a roster agent (this plugin's own commands, and the
registration block's instructions) resolves the model with one read:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" agents model <name> --json --project "${CLAUDE_PROJECT_DIR}"
```

and passes `result.model` as the spawn's model parameter — `null` means pass
nothing, the agent's own frontmatter decides — and `result.effort` as its
effort parameter when it is not `null` and the spawn offers one. The verb applies
`agents.per_agent.<name>.model ?? agents.default.model ?? null` (and the same
two terms for `effort`) over
`<project>/.projectstore/harness/<harness>.json` (the active harness's
overlay); besides the agents block itself (harness-neutral prose with no bin
to call — it states the rule as a file read, deliberately), nothing else
restates that rule. Never guess a model.

`agents.default` is optional and often absent (a per-agent-only config is normal);
the resolution must tolerate that, and so must an effort set without a model.

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

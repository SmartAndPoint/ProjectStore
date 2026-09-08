# Harnesses

projectstore's engine is one package. What differs between coding agents —
where a hook is declared, whether a subagent can be shipped, which environment
variable names the project — lives in `harnesses/<id>.json`, one **capability
manifest** per harness, and nowhere else. No script branches on a harness name;
the portability suite greps for it.

This page says which harnesses exist, how far each one is trusted, and what
"experimental" means when you read it below.

## Status

| Harness | id | Status | Verified | Surfaces installed |
|---|---|---|---|---|
| Claude Code | `claude-code` | **supported** | 2026-08-30 | hooks, commands, agents, skills, MCP, status line, agents block |
| Codex | `codex` | **experimental** | — | hooks, skills, agents block |

**supported** means the manifest carries a `verified` block: a session id and a
date on which this harness's surfaces were installed and exercised end to end,
and the measurements in the manifest came from that run.

**experimental** means `verified` is `null`. The manifest is built from what was
measured in a spike — for Codex, 759 captured hook firings across three
interactive runs on 2026-09-07/08 — and every field that was not measured is
absent or `null` rather than guessed. It is enough to run on; it is not enough
to promise. Two consequences you can rely on: an experimental harness is never
the source layout, and it never emits a generated tree until the maintainer
turns `emit` on.

The label is not prose. It is derived from the manifest, and
`tests/portability.test.mjs` fails if this table and `verified` disagree.

## Claude Code

The **source layout**: the repository's own `hooks/`, `commands/`, `agents/`,
`skills/` and `.mcp.json` are Claude Code's, written by hand and read directly.
Every other harness is generated from them. Exactly one manifest may say
`source_layout: true`, which is what keeps "the original" a single place.

Config lives in `<project>/.projectstore/`, harness-neutral, shared by every
harness in the project. The per-harness half — the agents block, which carries
model names and those are harness-specific — is
`<project>/.projectstore/harness/claude-code.json`.

## Codex

Experimental. What is known, and how:

- **Hooks fire.** They are declared inside the plugin manifest
  (`.codex-plugin/plugin.json`, under `hooks.hooks.<Event>`), not in a
  plugin-root `hooks/hooks.json`. Five events: `SessionStart`, `PreToolUse`,
  `PostToolUse`, `Stop`, `PreCompact`. The hook process receives `PLUGIN_ROOT`
  in its environment and **no project-directory variable at all** — the project
  comes from the payload's `cwd`, which every projectstore hook adopts before it
  resolves anything.
- **Trust is granted per hook, machine-wide**, and it lags: a release that
  changes hooks may not take effect until the session after next.
- **Commands are not shipped.** Codex has no registrable root slash command, and
  shipping `commands/` is actively harmful — it rewrites them into skills itself
  and leaves `${CLAUDE_PLUGIN_ROOT}` in the body, producing entry points that
  exit 1. They are rendered as skills instead.
- **Agents are not shipped either.** Codex spawns subagents through a tool of
  its own, not by loading a plugin's `agents/` directory: told to run
  `projectstore:critic`, it spawned six generic subagents named after the roster
  and briefed them itself. Codex does have a definition file that carries a model
  and a reasoning effort (`.codex/agents/<name>.toml`), but no route from a
  plugin to it has been found, so a role's model is not shipped today.
- **The activity log stays empty on Codex.** Its `apply_patch` carries the file
  path inside the patch envelope rather than in a payload field, and the envelope
  has not been measured, so nothing is parsed from it. This is a known gap, not
  a silent one.
- **MCP does not ship.** Our `.mcp.json` is in Claude Code's dialect.

Codex also sets Claude Code's `CLAUDE_PLUGIN_ROOT` for compatibility. A variable
two harnesses both set identifies neither, so both manifests demote it: it stops
being evidence for *either* harness rather than being evidence for the first file
in alphabetical order.

## Running both over one project

Nothing is shared that could collide. The binding
(`<project>/.projectstore/projectstore.json`) is harness-neutral and one file;
the agents block is per harness; the session state is keyed by harness id. Two
harnesses in one project write two overlays and neither disturbs the other.

Within one machine, run them in separate **git worktrees** over the same
checkout, as parallel Claude Code sessions already do. The vault itself is a git
repository with its own remote — that is how it syncs between people and their
agents.

## Adding a harness

A harness is a manifest plus measurements, not code:

1. Write `harnesses/<id>.json`. Copy the field list from an existing one; leave
   `verified: null` and omit or null every value you have not observed. A field
   that is `null` with a reason is a decision on the record; an absent field is
   one someone forgot.
2. Measure. Install it, run a real task, capture the hook payloads. The values
   that matter first: which environment variables the hook process receives,
   where hooks are declared, which tool writes files and where that tool puts the
   path.
3. Declare any variable the harness sets that belongs to another harness under
   `runtime.shared_env`, or detection will answer with someone else's id.
4. Add a row to the table above. It stays **experimental** until the manifest
   carries a `verified` block — the test enforces the pairing in both directions.

See [`docs/extending.md`](./extending.md) for the surfaces themselves.

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
| Codex | `codex` | **experimental** | — | portable plugin, hooks, rendered workflow skills, agents block |

**supported** means the manifest carries a `verified` block: a session id and a
date on which this harness's surfaces were installed and exercised end to end,
and the measurements in the manifest came from that run.

**experimental** means `verified` is `null`. Every field that was not measured
is absent or `null` rather than guessed. It is enough to run on; it is not enough
to promise. An experimental harness is never the source layout. A generated
adapter may exist while it is experimental, but its distribution shell stays
private until the complete built artifact passes the live gate.

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

Experimental, measured on `codex-cli 0.153.4`. The initial spike captured 759
hook firings. The 2026-09-30 gate then built the npm shell from a packed core,
passed the Codex plugin validator, installed and upgraded it through an isolated
`CODEX_HOME`, verified the materialised cache by version and digest, and loaded
`$projectstore-status` in a fresh Codex session.

That run exercised one skill, not every installed surface, so `verified` stays
`null`. The hooks are the reason it matters. On 2026-10-03 the first real
install's cached hooks could not load the vault in any session. They were run by
hand through `zsh -lc`: that machine's default shell, started the way Codex's
command runner starts a hook on its main branch (`<default shell> -lc`). That
0.153.4 does the same is not confirmed. In the first session
the failure sat in the model's context under the welcome, which was all the user
saw. The core had taken the shell's root for its own. That is fixed, and the
suite now runs every rendered hook from the built shell. A live Codex session
firing them from an installed release is still owed.

The shell is not published. Build it and install the tarball through npx from
this checkout:

```sh
npm run shells:build -- --only projectstore-codex --dev --out dist
npx --package "./dist/projectstore-codex-$(node -p 'require("./package.json").version').tgz" projectstore-codex install --project "$PWD"
```

The shell package is release-gated until its first npm publication. From this
repository, the same flow is exercised against the packed tarball. Installation
is user-global because Codex stores marketplace registrations and plugin caches
in `CODEX_HOME`; the agents block in `AGENTS.md` remains project-local. After
the first explicit npm publication, the shorter registry form is
`npx projectstore-codex@<version> install --project "$PWD"` (or `upgrade`). Ordinary
uninstall leaves the global plugin in place; add `--global` only when you mean
to remove it for every project.

What is known, and how:

- **Hooks are rendered; their live firing from an installed release is not
  yet observed.** The canonical portable `plugin.json` selects
  `./hooks/hooks.json` through `extensions.com.openai`; the compatibility
  `.codex-plugin/plugin.json` stays inside the current ingestion schema. Five
  events: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`.
  Of the 759 captured firings, 757 came from the earlier inline form, across
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`,
  and 2 from a file-site `hooks/hooks.json` with an absolute `node` path.
  `PreCompact` has never been observed firing on Codex, and neither has the
  `${PLUGIN_ROOT}` form selected through `extensions.com.openai`. The hook process
  receives `PLUGIN_ROOT` in its environment, naming the shell's root with the
  core beneath it in `node_modules/projectstore/`, and **no project-directory
  variable at all**. The project comes from the payload's `cwd`, which every
  projectstore hook adopts before it resolves anything.
- **Trust is granted per hook, machine-wide**, and it lags: a release that
  changes hooks may not take effect until the session after next.
- **Source commands are not shipped.** Codex has no registrable root slash command, and
  shipping `commands/` is actively harmful — it rewrites them into skills itself
  and leaves `${CLAUDE_PLUGIN_ROOT}` in the body, producing entry points that
  exit 1. They are rendered as skills instead.
- **Roles are rendered as orchestration skills.** Codex spawns subagents through
  its collaboration tool, not by loading a plugin's `agents/` directory. The
  six ProjectStore roles therefore ship as namespaced skills that resolve their
  configured model through the core and ask Codex to spawn the role. No effort
  is forced: it inherits unless the user has configured a model policy.
- **Multi-file edits reach the activity log and entry rule when their paths
  are absolute.** Codex's `apply_patch` carries paths inside
  `tool_input.command`; the shared extractor reads every `Add`, `Update`,
  `Delete` and `Move to` path from that measured envelope field. A relative
  path is not yet resolved against the payload's `cwd`, so it is not recorded.
  The field name remains manifest data, not a Codex branch.
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

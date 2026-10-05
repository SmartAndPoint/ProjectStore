---
name: projectstore-agents
description: "Register or remove ProjectStore's shared agents block, inspect its Codex model overlay, or configure per-role models. Arguments: <register | unregister | status | configure>."
---

## Runtime path

Resolve paths from this skill's own directory, never from the checkout or a
remembered cache path. The plugin root is two directories above this SKILL.md;
the bundled core is `<plugin-root>/node_modules/projectstore`. Before running
any ProjectStore command, export `PROJECTSTORE_CORE_ROOT` to that bundled-core
path in its own shell statement, then use `node "${PROJECTSTORE_CORE_ROOT}/…"`.
Do not prefix the command with the assignment: a shell expands the quoted path
before that inline assignment takes effect. If the bundled core is missing, stop
and report a broken plugin install; do not fetch a different version from npm.

## User arguments

The source command's host-substituted argument token is rendered here as
`<user-arguments>` (or `<user-arguments-without-fix>`). Before executing a
shown command, replace that token with the actual arguments from the user's
request and shell-quote values safely. Never pass the angle-bracket token
literally and never treat it as a shell variable.

You are managing ProjectStore's Codex agent integration. Require a bound project.

## register / unregister

Preview the requested change with `plan --harness codex --surface agents_block
--project "$PWD"` and ask for explicit approval. On approval, run the core's
`install` or `uninstall` verb with `--harness codex --surface agents_block
--project "$PWD" --json` — `--json` never waits on a terminal's question — and
report the envelope's result. Never edit the managed block by hand.

## status

Run `plan --json --harness codex --surface agents_block --project "$PWD"`,
then `agents show --json --project "$PWD"`. Report the block state and each
role's resolved model and source. The active overlay path returned by the core
is authoritative.

## configure

Ask for a default model and optional per-role model ids. Use actual Codex model
ids supplied by the user or visible in the current host; do not translate model
names from another harness. Preview the exact argv, ask for approval, then run
`agents configure --harness codex [--default <model>] [--agent
<role>=<model> ...] --project "$PWD"`. The core is the only writer. Do not pass
an effort override: per-role effort is outside this integration's current
contract. A configured model is consumed by the role-orchestration skills on
their next spawn; no restart is needed.

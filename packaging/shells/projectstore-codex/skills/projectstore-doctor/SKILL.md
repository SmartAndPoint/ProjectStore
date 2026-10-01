---
name: projectstore-doctor
description: "Diagnose the ProjectStore install and vault through the harness-neutral doctor; fixes remain previewed and approval-gated. Arguments: [--install | --vault] [--fix]."
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

Run the deterministic doctor through the bundled core with the user's
arguments and `--json`. Summarize every finding without re-deriving it.

When `--fix` is absent, remain read-only. When it is present, separate fixes
by owner: derived vault views use `$projectstore-reconcile`; Codex plugin or
agents-block drift uses the core's `upgrade --harness codex` path. Preview
each mutation and ask for explicit approval before running it. Unsupported
surfaces remain unsupported; do not create host configuration by hand. Never
claim a fix after a non-zero exit.

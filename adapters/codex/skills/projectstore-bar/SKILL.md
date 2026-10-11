---
name: projectstore-bar
description: "Explain ProjectStore band availability for Codex. This surface is unsupported and the skill never writes configuration. Arguments: on | off | status | epic [<ID>]."
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

ProjectStore's band above the prompt is not supported by the Codex
harness: Codex has no surface that draws above the prompt and no module
runtime to draw it. Do not run the band verb's writes and do not edit project
or host configuration. Report the surface as unsupported. For project state
use `$projectstore-status`.

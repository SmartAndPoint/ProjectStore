---
name: projectstore-bind
description: "Bind this project to an existing ProjectStore vault, or initialize and bind a new vault, using the harness-neutral core. Arguments: [vault-path] [--layout <name>] [--language <code>]."
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

Bind the current project through the core; never write the binding by
hand.

1. Resolve the requested vault path, and the layout and language when the
   request passes `--layout <name>` or `--language <code>`. If the vault
   exists, use `bind`; if the user explicitly asks to create it, use
   `init`. Ask for layout and language only when the request has not
   supplied them.
2. Show the resolved project, vault, verb, layout and language. Ask for explicit
   approval. Naming the vault is the core's non-interactive confirmation.
3. Run `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" <bind|init>
   "<vault-path>" --layout <layout> --language <language> --project "$PWD"
   --json` and report the result. Use `--rebind` only when the user explicitly
   approved replacing an existing binding.
4. Run `status --json` to verify the stored path and policies. Offer
   `$projectstore-scaffold` only for a newly initialized empty vault.

Codex plugin updates are performed with the `projectstore-codex upgrade`
installer command; this skill never sends the user to another harness's plugin
UI. Codex has no ProjectStore status-line surface, so binding does not offer or
write one. Model choices, when requested, go through `$projectstore-agents
configure` and the Codex overlay.

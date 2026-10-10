---
name: projectstore-scaffold
description: "Scaffold the bound vault with the layout's folder structure and README index files."
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

You are creating the bound vault's layout folders and their README indexes through the core's `scaffold` verb. The layout and the language are the binding's; the folder names, the descriptions and every README come from the plugin's templates in that language, so a vault scaffolded here is byte-identical to one `init` made. Never create a folder or write a README yourself, and take no layout argument: `bind --rebind` changes the layout.

Steps:

1. **Plan** — nothing is written:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" scaffold --project "$PWD"
   ```

   It prints one row per folder, per folder README and for the vault's own `README.md`, each `create` or `exists`.
   - Exit 3: the project is not bound — tell the user to run `$projectstore-bind <vault-path>` and stop.
   - Exit 1: a refusal — the bound vault directory is missing, the binding's language lacks a template or a folder string, or a folder's path is a file. Relay the message and stop.
   - No `create` row: say the vault already has every folder and README the layout declares, and stop.

2. **Ask** via the harness's user-input mechanism, showing the plan's `create` rows: "Create these folders and READMEs in the vault? Existing files are never rewritten." — **Yes** / **No**. On **No**, stop: nothing is written.

3. **Write**, on **Yes**:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" scaffold --write --json --project "$PWD"
   ```

   The question above is the confirmation; `--json` never asks again. Report `result.created`, and how many rows `result.exists` left as they were. A non-zero exit is an error: relay it.

4. **Next**: the folder indexes fill as artifacts are created; `$projectstore-reconcile` regenerates the board and the other derived views when you want them.

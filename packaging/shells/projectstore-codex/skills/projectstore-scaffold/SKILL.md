---
name: projectstore-scaffold
description: "Scaffold the bound vault with the layout's folder structure and README index files. Arguments: [layout-name]."
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

You are creating the folder structure of the projectstore layout inside the bound vault.

Steps:

1. **Read config**: `cat .projectstore/projectstore.json`. If missing, tell user to run `$projectstore-bind <path>` and stop.
2. **Determine layout**: use `<user-arguments>` if provided, else `config.layout`.
3. **Load layout spec**: `cat "${PROJECTSTORE_CORE_ROOT}/scaffold/layouts/<layout>.json"`. Parse it.
4. **Show plan**: list every folder that will be created and which folders already exist. Mark new ones with `(create)`, existing with `(exists)`.
5. **Ask approval** via the harness's user-input mechanism: "Create the missing folders and READMEs? [Yes / Skip READMEs / No]".
6. **Execute**:
   - For each folder in `layout.folders`:
     - Create directory via `mkdir -p <vault>/<folder.path>`.
     - If `folder.readme === true` and `<vault>/<folder.path>/README.md` does not exist:
       - Read template: `cat "${PROJECTSTORE_CORE_ROOT}/templates/<lang>/folder-readme.md.tmpl"`.
       - Substitute `{{folder_name}}` and `{{folder_description}}` based on the folder kind.
       - Write the README via file-writing tool.
   - Also create a top-level `<vault>/README.md` if missing — a simple index pointing to each folder.
7. **Print result**: tree of newly created files and a one-line "next step" suggestion.

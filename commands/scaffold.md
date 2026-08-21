---
description: Scaffold the bound vault with the layout's folder structure and README index files.
argument-hint: [layout-name]
---

You are creating the folder structure of the projectstore layout inside the bound vault.

Steps:

1. **Read config**: `cat .claude/projectstore.json`. If missing, tell user to run `/projectstore:bind <path>` and stop.
2. **Determine layout**: use `$ARGUMENTS` if provided, else `config.layout`.
3. **Load layout spec**: `cat "$CLAUDE_PLUGIN_ROOT/scaffold/layouts/<layout>.json"`. Parse it.
4. **Show plan**: list every folder that will be created and which folders already exist. Mark new ones with `(create)`, existing with `(exists)`.
5. **Ask approval** via AskUserQuestion: "Create the missing folders and READMEs? [Yes / Skip READMEs / No]".
6. **Execute**:
   - For each folder in `layout.folders`:
     - Create directory via `mkdir -p <vault>/<folder.path>`.
     - If `folder.readme === true` and `<vault>/<folder.path>/README.md` does not exist:
       - Read template: `cat "$CLAUDE_PLUGIN_ROOT/templates/<lang>/folder-readme.md.tmpl"`.
       - Substitute `{{folder_name}}` and `{{folder_description}}` based on the folder kind.
       - write the README via the Write tool.
   - Also create a top-level `<vault>/README.md` if missing — a simple index pointing to each folder.
7. **Print result**: tree of newly created files and a one-line "next step" suggestion.

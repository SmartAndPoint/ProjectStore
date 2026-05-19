---
description: Bind this project to an Obsidian vault (or any markdown directory) where projectstore will record artifacts.
argument-hint: <vault-path> [--layout engineering] [--lang en|ru]
---

You are binding the current project to a markdown vault for projectstore.

Parse `$ARGUMENTS`:
- First positional arg: vault path. Expand `~` if present.
- Optional `--layout <name>`: layout to use. Default: `engineering`.
- Optional `--lang <en|ru>`: template language. Default: `en`.

Steps:

1. **Validate the vault path** with `ls -la "<path>"`. If it does not exist, ask the user (via AskUserQuestion) whether to create it.
2. **Detect existing layout**: list immediate subdirectories. If you see `adr/`, `epics/`, `concepts/`, `research/` — the vault already uses an engineering-like layout; suggest `engineering`. Otherwise use the user's choice or `engineering` default.
3. **Build the config** as JSON:

   ```jsonc
   {
     "vault_path": "<absolute-path>",
     "layout": "engineering",
     "auto_inject": true,
     "inject_depth": 1,
     "language": "en",
     "tags": [],
     "default_author": "<git user.name or $USER>",
     "active_skills": true,
     "approval_mode": "always"
   }
   ```

   Get `default_author` from `git config --get user.name` (fallback to `$USER`).

4. **Show the user the proposed config** as a code block. Use AskUserQuestion to confirm: "Write `.claude/projectstore.json` with this config? [Yes / Edit a field / No]".

5. On approval, write the file using the Write tool to `<project>/.claude/projectstore.json`.

6. **Check `.gitignore`**: read `<project>/.gitignore` if it exists. If `.claude/projectstore.json` is not listed, ask via AskUserQuestion: "Add `.claude/projectstore.json` to `.gitignore` (vault path is machine-specific)? [Yes / No]". If yes, append the entry (use Edit).

7. **Offer scaffold**: if the vault is empty or missing layout folders, ask: "Vault is empty/incomplete. Run `/ps:scaffold` to create the layout? [Yes / No]". If yes, invoke `/ps:scaffold` immediately (just describe; do not assume execution).

8. **Print summary**: confirm the bind, list the layout's folders, suggest next commands (`/ps:status`, `/ps:adr "<first decision>"`, `/ps:epic <ID> "<title>"`).

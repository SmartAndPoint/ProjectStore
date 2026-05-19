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

0. **Check for an existing bind** (safer rebind, v0.4.1):
   - Read `<project>/.claude/projectstore.json` if it exists.
   - If absent: proceed to step 1 (fresh bind).
   - If present, compare its `vault_path` with the new path (after `~` expansion):
     - **Same vault**: print "Already bound to `<path>`. Re-run `/projectstore:scaffold` if you need to (re)create the layout, or `/projectstore:status` to inspect it." and stop. Do not rewrite the config.
     - **Different vault**: show the user a one-block diff:
       ```
       Existing bind:
         vault_path: <old>
         layout:     <old layout>
         language:   <old lang>
       Proposed bind:
         vault_path: <new>
         layout:     <new layout>
         language:   <new lang>
       ```
       Then ask via AskUserQuestion: "An existing projectstore bind was found. How to proceed?" with options:
       - **Replace bind** (Recommended) — write the new config, leaving the old vault's `.projectstore/sessions/` to expire on its own 24h TTL.
       - **Keep old bind** — make no changes, print "Kept binding to `<old>`." and stop.
       - **Cancel** — make no changes, print "Cancelled." and stop.

       Only on **Replace bind**, continue with the remaining steps below.

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

7. **Offer scaffold**: if the vault is empty or missing layout folders, ask: "Vault is empty/incomplete. Run `/projectstore:scaffold` to create the layout? [Yes / No]". If yes, invoke `/projectstore:scaffold` immediately (just describe; do not assume execution).

8. **Print summary**: confirm the bind, list the layout's folders, suggest next commands (`/projectstore:status`, `/projectstore:adr "<first decision>"`, `/projectstore:epic <ID> "<title>"`).

9. **Auto-update reminder** (v0.7+, only on first successful bind in this project): After Step 5 (config write), check whether the newly-written config has `autoupdate_asked: true`. If not, ask the user via AskUserQuestion:

   > "Claude Code does not auto-update third-party marketplaces by default. Want to enable auto-update for the SmartAndPoint marketplace so you'll be notified about future projectstore releases?"

   Options:
   - **Yes, show me how** (Recommended) — respond with: "Open `/plugin` → **Marketplaces** tab → **SmartAndPoint** → toggle **auto-update** on. New releases (v0.7+) will be detected at Claude Code startup; you'll need to run `/reload-plugins` after the notification to activate them."
   - **No, I'll handle it manually** — respond with: "OK. To pull the latest version at any time, run `/plugin marketplace update SmartAndPoint`, then `/reload-plugins`."
   - **Already enabled** — respond with: "Great. New releases will be detected at the next Claude Code startup."

   After the question is answered (regardless of choice), Edit `<project>/.claude/projectstore.json` to add `"autoupdate_asked": true` to the JSON object. This guarantees we ask only once per project.

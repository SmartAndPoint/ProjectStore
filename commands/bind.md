---
description: Bind this project to an Obsidian vault (or any markdown directory) where projectstore will record artifacts.
argument-hint: <vault-path> [--layout engineering] [--lang en|ru|es|de|fr|zh]
---

You are binding the current project to a markdown vault for projectstore.

Parse `$ARGUMENTS`:
- First positional arg: vault path. Expand `~` if present.
- Optional `--layout <name>`: layout to use. Default: `engineering`.
- Optional `--lang <en|ru|es|de|fr|zh>`: template language. Default: `en`. (`zh` is Simplified Chinese.)

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

6. **Check `.gitignore`**: read `<project>/.gitignore` if it exists. Unless `.claude/` is ignored wholesale, the machine-specific entries are: `.claude/projectstore.json`, `.claude/settings.local.json`, `.claude/.projectstore/` (per-session state). Ask via AskUserQuestion: "Add the missing entries to `.gitignore`? [Yes / No]". If yes, append them (use Edit).

7. **Offer scaffold**: if the vault is empty or missing layout folders, ask: "Vault is empty/incomplete. Run `/projectstore:scaffold` to create the layout? [Yes / No]". If yes, invoke `/projectstore:scaffold` immediately (just describe; do not assume execution).

7.5. **Vault policy** (v0.14, ADR-007 — vault-side, survives clones): check `<vault>/.projectstore.json`.
   - If it already exists with a `spec_policy` key — respect it, print the current policy, do not re-ask.
   - **New bind into an empty/fresh vault**: ask via AskUserQuestion — "Enable spec-first policy for this vault (every story must be covered by a spec; doctor enforces it)?" with options **Yes, `spec_policy: required` (Recommended)** / **Not yet, `optional`**. Second question: "Enable lifecycle gates (plan/close sections + evidence checks on stories)?" — **Yes, `lifecycle_gates: on` (Recommended)** / **Off for now**.
   - **Bind to an existing vault with artifacts**: default to `spec_policy: optional`, `lifecycle_gates: off` and say doctor will suggest enabling once specs appear. Do not impose the gate on an existing backlog.
   - On any choice, write `<vault>/.projectstore.json` (vault ROOT — deliberately not inside `<vault>/.projectstore/`, whose .gitignore would keep the policy out of git):

   ```json
   {
     "spec_policy": "required",
     "lifecycle_gates": "on",
     "spec_policy_since": "<current ISO-8601 timestamp>"
   }
   ```

   `spec_policy_since` is stamped ONLY when spec_policy is set to `required` — it anchors the legacy exemption (stories done before it stay exempt; stories in progress/review at enable time are in scope).

8. **Agent registration** (v0.13, ADR-002): ask via AskUserQuestion — "Register projectstore's agents in CLAUDE.md/AGENTS.md so every session routes to them (critic after authoring artifacts, planner before implementing, reviewer before commit)? [Yes (Recommended) / No]". On Yes, run the `register` flow from `commands/agents.md` (block generated from the layout's roster; each write individually approved). On a rebind where a block already exists, offer repair/migrate instead of re-asking blindly.

9. **Agent model preset** (v0.13, ADR-003; mechanism per ADR-008): ask via AskUserQuestion — include this line in the question text: *"These agents don't write code — they are critics, planners, and reviewers; they perform best on strong models at high effort."* Options: **Keep bundled default — opus** (Recommended) / **fable** / **sonnet**. Do not offer `inherit` — it cannot be expressed per invocation (see `commands/agents.md`). Do not offer effort — it is not configurable per project (the bundled agents already run at `max`). Free-form model IDs and per-agent tuning live in `/projectstore:agents configure` — mention it. A non-default choice runs the `configure` apply flow from `commands/agents.md`, which writes the config only — **never an agent copy**. Skippable.

10. **Print summary**: confirm the bind, list the layout's folders, suggest next commands (`/projectstore:status`, `/projectstore:adr "<first decision>"`, `/projectstore:epic <ID> "<title>"`).

11. **Auto-update reminder** (v0.7+, only on first successful bind in this project): After Step 5 (config write), check whether the newly-written config has `autoupdate_asked: true`. If not, ask the user via AskUserQuestion:

   > "Claude Code does not auto-update third-party marketplaces by default. Want to enable auto-update for the SmartAndPoint marketplace so you'll be notified about future projectstore releases?"

   Options:
   - **Yes, show me how** (Recommended) — respond with: "Open `/plugin` → **Marketplaces** tab → **SmartAndPoint** → toggle **auto-update** on. New releases (v0.7+) will be detected at Claude Code startup; you'll need to run `/reload-plugins` after the notification to activate them."
   - **No, I'll handle it manually** — respond with: "OK. To pull the latest version at any time, run `/plugin marketplace update SmartAndPoint`, then `/reload-plugins`."
   - **Already enabled** — respond with: "Great. New releases will be detected at the next Claude Code startup."

   After the question is answered (regardless of choice), Edit `<project>/.claude/projectstore.json` to add `"autoupdate_asked": true` to the JSON object. This guarantees we ask only once per project.

12. **Status line offer** (v0.13, ADR-006 — the final step, language is known by now): read `$CLAUDE_PLUGIN_ROOT/templates/<lang>/strings.json` (fall back to `en`) and the plugin version, then show the fully rendered example:

    > `[PS#<version>] 📚 <statusline_example_epic> › <statusline_example_story> (in-progress)`

    (for `ru`: `[PS#<version>] 📚 Супер-фича в супер-продукте › Ручка для туалетной бумаги (in-progress)`; every bundled language ships its own example pair)

    Ask via AskUserQuestion: "Show your current epic/story in the status line, composed above any existing HUD? [Yes / No]". On Yes: Edit `projectstore.json` → `"statusline": { "enabled": true }` (approval-gated) and report: "Enabled — restart Claude Code in this project to apply (the SessionStart hook wires it). A fresh session shows: `[PS#<version>] 📚 <statusline_no_work>`."

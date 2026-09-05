---
description: Bind this project to an Obsidian vault (or any markdown directory) where projectstore will record artifacts.
argument-hint: <vault-path> | --inherit [--layout engineering] [--lang en|ru|es|de|fr|zh]
---

You are binding the current project to a markdown vault for projectstore. The config is written by the core's `bind` / `init` verbs (roadmap A8); this interview decides the values, previews them, and asks — it never writes `projectstore.json` itself, except on the inherit path (step 0a), which copies the parent's file verbatim, and the two later stamps in steps 11–12 (`autoupdate_asked`, `statusline`), which `Edit` the file the verb wrote. The interview's `--lang` is the verb's `--language`.

Parse `$ARGUMENTS`:
- First positional arg: vault path. Expand `~` if present.
- Optional `--inherit`: adopt the binding of the checkout this worktree was forked from (step 0a). Mutually exclusive with a positional vault path.
- Optional `--layout <name>`: layout to use. Default: `engineering`.
- Optional `--lang <en|ru|es|de|fr|zh>`: template language. Default: `en`. (`zh` is Simplified Chinese.)

Steps:

0. **Check for an existing bind** (safer rebind, v0.4.1):
   - Read `<project>/.claude/projectstore.json` if it exists.
   - `--inherit` and a positional vault path together are a contradiction: say so and stop, rather than silently picking one.
   - If absent **and** no positional vault path was given (or `--inherit` was passed): run step **0a** first.
   - If absent otherwise: proceed to step 1 (fresh bind).
   - If present **and** `--inherit` was passed: print "Already bound to `<path>`." and stop. Do not fall through to the rebind comparison below — with `--inherit` there is no new path to compare, and the comparison would render an empty "proposed" side and offer to replace the binding. A no-op command must not reach a destructive option.
   - If present, let the verb compare — run `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" bind "<vault-path>" [--layout <name>] [--language <code>] --json` **without** `--rebind` (pass the user's flags, so the proposed side of the diff is what a rebind would write) (the vault is normalised on both sides: `~`, relative, trailing slash, symlinks):
     - `result.state` is `"same"` (exit 0, nothing written): print "Already bound to `<path>`. Re-run `/projectstore:scaffold` if you need to (re)create the layout, or `/projectstore:status` to inspect it." and stop. If `result.ignored` names `layout` or `language`, say the flag was ignored — a change of layout or language is not a rebind.
     - a refusal with code `UNREADABLE` (the config exists but is not valid JSON): relay it and stop — nothing is overwritten; the user fixes or removes the file first.
     - `result.state` is `"different"` (exit 1, a `REBIND` refusal, nothing written — **the refusal is the diff**, and `result.kept_keys` lists what a rebind keeps): show the user a one-block diff built from the existing config and the refusal:
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
       - **Replace bind** (Recommended) — re-run the verb with `--rebind` in step 5 (every other key of the config is kept), leaving the old vault's `.projectstore/sessions/` to expire on its own 24h TTL.
       - **Keep old bind** — make no changes, print "Kept binding to `<old>`." and stop.
       - **Cancel** — make no changes, print "Cancelled." and stop.

       Only on **Replace bind**, continue with the remaining steps below.

0a. **Inherit from the checkout this worktree was forked from** (ADR "A vault worktree is an additional write path…", decision 12). `.gitignore` ignores `.claude/`, so a worktree of a bound checkout starts unbound and every `/projectstore:*` command is dead in it — including this one's usual path.

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/worktree.mjs"
   ```

   It prints `{state, worktree, mainCheckout, vaultPath}` and writes nothing.
   - `state` is **not** `inheritable` → say why in one line (not a worktree, its parent is unbound too, or git could not answer) and fall through to step 1, which needs a vault path; if none was given, ask for one.
   - `state` is `inheritable` → read the parent's `<mainCheckout>/.claude/projectstore.json`, show it **verbatim as a code block**, and ask via AskUserQuestion: "Adopt the binding of `<mainCheckout>` (vault `<vaultPath>`)?" — Yes / No.
   - On **Yes**: Write that JSON verbatim to `<project>/.claude/projectstore.json`, then **jump straight to step 10** (the summary). Steps 1–9 and 11–12 are decisions the parent already made and the copied config already carries — layout, language, statusline, agent models, auto-update. Do not re-ask them, and do not scaffold: the vault exists and is shared.
   - Copy the **binding only**. Never copy `<project>/.claude/.projectstore/` — that is per-session state belonging to the other checkout.
   - Do not add a provenance key to the config. The parent is resolvable from git at any time; a key would be a second source of truth for the same fact.

1. **Validate the vault path** read-only first: `ls -d "<path>"` (the verb has no dry run — running it on a fresh project would write the config before step 4's approval). If it does not exist, ask the user (via AskUserQuestion) whether to create it; on Yes, step 5 runs `init` instead of `bind` (it creates the directory and binds; the layout's folders remain `/projectstore:scaffold`'s). Never `mkdir` it yourself.
2. **Detect existing layout**: list immediate subdirectories. If you see `adr/`, `epics/`, `concepts/`, `research/` — the vault already uses an engineering-like layout; suggest `engineering`. Otherwise use the user's choice or `engineering` default.
3. **Build the config** as JSON:

   ```jsonc
   {
     "vault_path": "<absolute-path>",
     "layout": "engineering",
     "auto_inject": true,
     "language": "en",
     "tags": [],
     "default_author": "<git user.name or $USER>",
     "active_skills": true,
     "approval_mode": "always"
   }
   ```

   `default_author` comes from `git config --get user.name` in the project (fallback to the login name) — the verb reads it; the block above is the preview of what the verb writes on a fresh bind (a rebind rewrites `vault_path`, `layout`, `language` and keeps every other key).

4. **Show the user the proposed config** as a code block. Use AskUserQuestion to confirm: "Write `.claude/projectstore.json` with this config? [Yes / Edit a field / No]".

5. On approval, write through the core — never with the Write tool:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" bind "<vault-path>" [--layout <name>] [--language <code>] [--rebind]
   ```

   `init "<vault-path>" …` instead when step 1 chose to create the vault; `--rebind` only when step 0 ended on **Replace bind**. Naming the vault is the verb's confirmation (there is no `--yes`); the interview's AskUserQuestion in step 4 is the in-session gate. Print the verb's output. A non-zero exit is a refusal or a usage error — relay it and stop. Steps 11 and 12 below `Edit` the file this step wrote; keep them after it.

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

8. **Agent registration** (v0.13, ADR-002): ask via AskUserQuestion — "Register projectstore's agents in CLAUDE.md/AGENTS.md so every session routes to them (critic after authoring artifacts, planner before implementing, reviewer before commit)? [Yes (Recommended) / No]". On Yes, run `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" install --harness claude-code --surface agents_block --project "<abs project dir>"` and print its output (it renders from the layout's roster, migrates rather than duplicates, previews every write, and applies because the harness is named). On a rebind where a block already exists the verb reports it current or replaces it in place — do not re-ask blindly.

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

    Ask via AskUserQuestion: "Show your current epic/story in the status line, composed above any existing HUD? [Yes / No]". On Yes: Edit `projectstore.json` → `"statusline": { "enabled": true }` (approval-gated), then run `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" install --harness claude-code --surface statusline --project "<abs project dir>"` and print its output (it writes the `settings.local.json` entry and the launcher, previewed), and report: "Enabled — restart Claude Code in this project to apply. A fresh session shows: `[PS#<version>] 📚 <statusline_no_work>`."

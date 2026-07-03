---
description: Manage bundled-agent integration in this project — register/unregister the routing block in CLAUDE.md/AGENTS.md, inspect state, or configure model/effort via project override copies.
argument-hint: "<register | unregister | status | configure>"
---

You are managing projectstore's agent integration (ADR-002 block lifecycle,
ADR-003 model/effort configuration). Require a bound project for every
subcommand (`.claude/projectstore.json`; else point to `/projectstore:bind`).

## `register` — write the managed routing block

1. **Generate the block from the installed plugin, never from documentation**:
   read `$CLAUDE_PLUGIN_ROOT/templates/claude-md-block.md.tmpl` and keep only the
   agent lines whose agent appears in the active layout's `agents` roster
   (`scaffold/layouts/<layout>.json`); the vault-communication line always stays.
   Only *routable* agents get lines (critic/planner/reviewer) — `librarian` and
   `archaeologist` have no per-turn trigger and are deliberately absent.
2. **Scan BOTH `CLAUDE.md` and `AGENTS.md`** for `<!-- projectstore:agents` markers:
   - block already present in the preferred location and current version → report "already registered", stop;
   - present in the non-preferred location → offer to **migrate** (move, never duplicate);
   - stale version marker → offer to replace the block in place.
3. **Placement** (never duplicate): `AGENTS.md` exists → block goes there, and
   ensure `CLAUDE.md` contains an `@AGENTS.md` import line (add with approval if
   missing). Else → `CLAUDE.md` (create the file with approval if absent).
4. **Every write approval-gated** (path + diff preview via AskUserQuestion). The
   step fans out to 2–3 prompts in the common case — that is by design.

## `unregister` — remove what register added

1. Remove the marked block (approval with diff preview).
2. With a **separate** approval each: remove an `@AGENTS.md` import line that
   registration added, and delete a `CLAUDE.md` that registration created if it
   is now otherwise empty. Never touch user-authored content.

## `status` — read-only report

- Block: present in which file, marker version vs the installed template, agent
  names vs the layout roster.
- Model/effort: override copies in `.claude/agents/` (name, model, effort,
  provenance version vs installed), `projectstore.json → agents` echo, and
  whether `CLAUDE_CODE_SUBAGENT_MODEL` is set (it overrides everything).

## `configure` — model/effort via override copies (ADR-003)

1. **Preset question** (one choice for ALL roster agents), with this education
   line in the question text: *"These agents don't write code — they are
   critics, planners, and reviewers; they perform best on strong models at high
   effort."* Options: keep bundled default (`opus` + `max`) / `fable` + `max` /
   `sonnet` + `max` / `inherit` (follow the session's model) / custom model ID
   (free-form; ask for effort explicitly, default `max`). Offer the current
   session's model as a hint option — you know what you are running on.
2. **Optional follow-up**: "configure individually?" → per-agent model+effort
   for each roster agent. Skippable.
3. **Apply — non-default choice**: for each roster agent write an override copy
   to `.claude/agents/<name>.md` (approval-gated, diff preview): the bundled
   agent's body **verbatim**, chosen `model:`/`effort:` frontmatter, and a
   provenance line `# source: projectstore v<installed version>` right below the
   frontmatter. **The copy's `name:` must exactly equal the bundled agent's
   `name:`** — that is what shadows; a different name creates a duplicate agent
   instead of an override.
4. **Apply — "keep bundled default"**: delete existing projectstore-provenance
   override copies (approval-gated). Copies WITHOUT the provenance marker are
   user-authored — never touch them.
5. **Echo the choice** into `projectstore.json → agents: { default: {model,
   effort}, per_agent: {…} }` (approval-gated config edit).
6. **Honesty notes to print**: an org `availableModels` allowlist silently
   downgrades excluded models; effort levels vary by model; the
   `CLAUDE_CODE_SUBAGENT_MODEL` env var overrides everything configured here.
   `/projectstore:doctor` validates shape and provenance staleness — not
   entitlement.
7. Remind: restart or `/reload-plugins` for the agent list to refresh.

## Notes

- Uninstalling the plugin removes these commands but NOT the block — removal is
  a one-line delete between the `<!-- projectstore:agents -->` markers (this
  snippet belongs in the uninstall docs).
- Never write any file without AskUserQuestion approval.

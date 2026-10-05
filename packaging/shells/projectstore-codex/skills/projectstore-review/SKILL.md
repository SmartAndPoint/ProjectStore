---
name: projectstore-review
description: "Peer-review an existing artifact (ADR / research / epic / etc.) using a fresh critic-mode agent with a structural checklist. Returns concrete improvements, no sycophancy. Arguments: <path-to-artifact>."
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

You are running a peer review on a projectstore artifact.

## Steps

1. **Resolve path**: `<user-arguments>` is the target file. If it is relative, resolve against the bound vault (read `.projectstore/projectstore.json` → `vault_path`). If config missing, stop with: "Run `$projectstore-bind <path>` first."

2. **Read the artifact**: use the file-reading tool on the resolved path. Stop if file does not exist.

3. **Identify the kind**: parse the YAML frontmatter for `type:`. If missing, try to infer from the file path (`adr/` → adr, `epics/<id>/epic.md` → epic, `epics/<id>/stories/*` → story, `research/` → research, etc.). If still unknown, ask the user via the harness's user-input mechanism which kind to apply.

4. **Load the checklist**:

   ```bash
   cat "${PROJECTSTORE_CORE_ROOT}/scaffold/checklists.json"
   ```

   Parse JSON, pick the entry by kind. If the kind has no entry, use the `adr` checklist as a generic fallback and note this to the user.

5. **Gather domain context**: read the vault's top-level `README.md` and the folder README of the artifact's parent (e.g. `adr/README.md`). Keep both short — they're context for the critic, not the focus.

6. **Spawn the critic agent**. Prefer this plugin's own `$projectstore-critic` (purpose-built fresh-context critic, no sycophancy). If unavailable, fall back to `oh-my-codexcode:critic`, then `general-purpose`. Use this exact prompt template:

   ```
   You are a critic-mode reviewer. You have ONLY the artifact and the
   project context below. You did NOT participate in producing this
   artifact. Your job is to find concrete, actionable problems — not
   to praise.

   ## Artifact ({{kind}} at {{path}})

   <full file content>

   ## Project context

   <vault README excerpt>
   <folder README excerpt>

   ## Structural checklist

   <bullet list of checklist.items>

   ## Report format (strict)

   Return a numbered list of findings, max 7 items. For each:
     1. **What's wrong** — one sentence, specific (cite section / line).
     2. **Why it matters** — one sentence.
     3. **Suggested fix** — concrete edit, ideally a phrase to add or
        replace.

   Forbidden:
     - Sycophancy ("Overall this is a strong ADR, but...").
     - Generic advice without a citation.
     - Restating what the artifact says.
     - "Consider" without a concrete alternative.

   If the artifact passes all checklist items with no concrete issues,
   say so in one line — do not pad.
   ```

   Set the agent description to: `Peer-review of {{kind}} artifact at {{path}}`. Pass it as a foreground task (you need the result to continue).

   **Model (ADR-008)**: resolve it with `node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" agents model critic --json --project "$PWD"` and pass `result.model` as the spawn's model parameter (`null` → pass nothing). Missing key, `inherit`, or unreadable config → pass nothing and let the agent's own frontmatter decide; never guess a model. This is the only way the configured model reaches the agent — there are no override copies (`$projectstore-agents configure`). When falling back to `oh-my-codexcode:critic` or `general-purpose`, pass the same model.

7. **Show findings**: print the agent's report verbatim. Number is its number.

8. **Ask the user via the harness's user-input mechanism** what to do:
   - **Apply all** — propose Edits for each suggested fix, one at a time with diff preview + approval.
   - **Apply selected** — ask which finding numbers to apply, then walk through them.
   - **Note for later** — leave artifact untouched, but append a `## Review notes` section at the bottom of the file (after user approval) summarizing findings.
   - **Skip** — do nothing, just close.

9. **On any apply path**, after each Edit (approved by the harness's user-input mechanism), update the frontmatter:
   - `review_status: reviewed`
   - `reviewed_at: <today's date YYYY-MM-DD>`

   Do this with one final Edit after all content changes are applied.

10. **Final print**: file path, what was applied / noted / skipped, and a one-line hint to commit the review if the vault is git-tracked.

## Notes for the implementer (you, Codex)

- Critic agent MUST NOT see the conversation that produced the artifact. Only the artifact + minimal context. That fresh framing is the whole point.
- If the critic returns suspiciously sycophantic findings ("good overall, minor nit:"), retry once with an explicit `NO PRAISE, NO HEDGING.` injected into the prompt.
- Selective default: if user invoked `$projectstore-review` on a kind whose `default_review` is `false` in checklists.json (e.g. meeting), still run — they asked explicitly. Just don't auto-trigger via skill.

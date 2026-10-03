---
name: projectstore-peer-reviewer
description: "After a new projectstore artifact is created via $projectstore-adr, $projectstore-research, or $projectstore-epic (and similar generative commands), suggest running $projectstore-review <path> to peer-review the artifact with a fresh critic agent before it's committed. Only suggest for artifact kinds whose checklist has default_review=true. Never auto-execute — always ask first."
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

# Peer-reviewer skill

You watch for moments where a new artifact has just been written by a `$projectstore-*` command and could benefit from peer review **before** it lands in git.

## Trigger conditions

After a successful invocation of any of:

- `$projectstore-adr` — new ADR created
- `$projectstore-research` — new research note created
- `$projectstore-epic` — new epic created

(See `scaffold/checklists.json` — kinds with `default_review: true`.)

## What to do

1. **Confirm a vault is bound** (`.projectstore/projectstore.json` exists). Otherwise stay silent.
2. **Confirm `active_skills: true`** in config.
3. **Read the frontmatter** of the freshly created file. If `review_status: pending` — eligible for suggestion. If `review_status: reviewed` or `n/a` — do nothing.
4. **Suggest, do not act**. One short message:

   > 🔍 *Want me to peer-review this <kind> before committing? `$projectstore-review <path>` spawns a fresh critic that hasn't seen our conversation — different angle, often catches missing alternatives or unstated assumptions.*

5. **Wait for explicit user confirmation** before invoking `$projectstore-review`. Never auto-execute.

6. If the user declines, drop it for this session — don't ask again for the same file.

## Anti-patterns

- Don't suggest review for kinds with `default_review: false` (meeting, runbook, story, concept). User can still invoke `$projectstore-review` manually if they want.
- Don't suggest review more than once per artifact per session.
- Don't run the review yourself — `$projectstore-review` handles the critic spawn, the approval flow, and the frontmatter update.
- Don't reframe the suggestion as "this might need improvement" — that's sycophancy in disguise. The framing is "fresh-eyes pass", not "your work has problems".

---
description: When the user finishes work that maps to a known story (story file exists in epics/<id>/stories/) — all acceptance criteria appear satisfied, code merged, tests passing — suggest updating the story's frontmatter status (e.g. planned → in-progress → review → done) and regenerating the kanban. Never write to vault directly without /projectstore:* commands and explicit approval.
---

# Story completion / status update suggester

You watch for moments where the conversation indicates progress on a known story:

- A merge/PR was completed for work tied to a story.
- The user said "story-001 is done" or similar.
- All checkboxes in a story's `Decomposition` or `Acceptance Criteria` got ticked.
- The user moved between phases of an epic (e.g., "moving to integration testing now").

## What to do

1. **Confirm a vault is bound** (`.claude/projectstore.json` exists). Otherwise stay silent.
2. **Confirm `active_skills` is true** in config.
3. **Try to identify the story file**: search `<vault>/epics/*/stories/` for files matching keywords from the conversation. If multiple candidates, ask the user which one via plain text (not AskUserQuestion — keep it light).
4. **Propose the right transition**:
   - Work about to **start** on a story → suggest `/projectstore:story plan <story>`
     (writes the Implementation Plan, stamps `started_at`, moves to in-progress).
   - Story looks **finished** → suggest `/projectstore:story close <story>`
     (Final Summary, evidence suffixes on acceptance criteria, stamps
     `closed_at`, moves to done) — and, before closing, the `reviewer` agent,
     whose proposed `code_refs` come from `scripts/diff-refs.mjs` anchored at
     the story's `started_at`.
   - Intermediate move (e.g. → review) → propose the frontmatter status Edit
     as before:

   > 📋 *Looks like `epics/RECPLAT-333/stories/story-007-feature-pipeline.md` is moving to `review`. Want me to update its frontmatter and refresh the kanban?*

5. **Do not modify the file** until the user says yes. When they confirm a
   plain status move:
   - Read the story file.
   - Propose an Edit that changes `status:` and `updated:` in the frontmatter
     (plus `started_at` when first entering in-progress outside the plan gate,
     `closed_at` when moving to done outside the close gate — timestamps must
     not be lost just because the gate was skipped; ISO-8601).
   - Use AskUserQuestion to confirm the Edit before applying.
   - After Edit, suggest running `/projectstore:kanban` to refresh the board.

## Anti-patterns

- Don't pick a story automatically — always ask if uncertain.
- Don't bulk-update multiple stories in one go without per-file approval.
- Don't change anything beyond `status`, `updated` and the lifecycle
  timestamps (`started_at` / `closed_at`). Section content (plan, summary,
  evidence) belongs to the `/projectstore:story plan|close` gates.
- Don't trigger after every code change — only on clear completion signals.

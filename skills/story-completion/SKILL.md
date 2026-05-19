---
description: When the user finishes work that maps to a known story (story file exists in epics/<id>/stories/) — all acceptance criteria appear satisfied, code merged, tests passing — suggest updating the story's frontmatter status (e.g. planned → in-progress → review → done) and regenerating the kanban. Never write to vault directly without /ps:* commands and explicit approval.
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
4. **Propose a status transition** as a one-line message:

   > 📋 *Looks like `epics/RECPLAT-333/stories/story-007-feature-pipeline.md` is moving to `review`. Want me to update its frontmatter and refresh the kanban?*

5. **Do not modify the file** until the user says yes. When they confirm:
   - Read the story file.
   - Propose an Edit that changes `status:` and `updated:` in the frontmatter.
   - Use AskUserQuestion to confirm the Edit before applying.
   - After Edit, suggest running `/ps:kanban` to refresh the board.

## Anti-patterns

- Don't pick a story automatically — always ask if uncertain.
- Don't bulk-update multiple stories in one go without per-file approval.
- Don't change anything other than `status` and `updated` fields. Content changes belong in a manual edit.
- Don't trigger after every code change — only on clear completion signals.

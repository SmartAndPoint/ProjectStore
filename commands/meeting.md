---
description: Create a new meeting note (date-prefixed filename).
argument-hint: <title>
---

You are creating a meeting note. Today's date is auto-prefixed.

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" meeting "$ARGUMENTS"`.
3. Preview path + first ~15 lines.
4. AskUserQuestion: Yes / Edit / No. When proposing "Edit", offer to seed `Attendees` and `Agenda` from the conversation context if relevant.
5. Pre-write race check (Layer 1): `test -e "<path>"`. If a meeting note with this date+slug already exists, ask: **Append to existing** (open it and add a section), **Use new slug** (`-2`), or **Cancel**.
6. On Yes (path free): Write file.
7. Update folder index README if `index` is non-null.
8. Suggest: "Add attendees and agenda before the meeting; record decisions and action items during/after."

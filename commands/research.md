---
description: Create a new research note.
argument-hint: <title>
---

You are creating a research note (deep investigation, comparison, benchmark).

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" research "$ARGUMENTS"`.
3. Preview path + first ~20 lines.
4. AskUserQuestion: Yes / Edit / No.
5. Pre-write race check (Layer 1): `test -e "<path>"`. If exists, ask the user whether to **Overwrite**, **Use new slug** (append `-2`), or **Cancel**.
6. On Yes (path free or overwrite confirmed): Write file.
7. Optionally update folder index README via Edit if `index` is non-null.
8. Suggest: "Fill `Question`, then `Method`, then `Findings`. After the conclusion, consider raising an ADR if the research informs a decision."

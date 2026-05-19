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
5. On Yes: Write file.
6. Optionally update folder index README via Edit if `index` is non-null.
7. Suggest: "Fill `Question`, then `Method`, then `Findings`. After the conclusion, consider raising an ADR if the research informs a decision."

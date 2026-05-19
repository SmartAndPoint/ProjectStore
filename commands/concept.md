---
description: Create a new concept note (definition, mental model, glossary entry).
argument-hint: <title>
---

You are creating a concept note.

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" concept "$ARGUMENTS"`.
3. Preview path + first ~15 lines.
4. AskUserQuestion: Yes / Edit / No.
5. On Yes: Write file.
6. Update folder index README if `index` is non-null.
7. Suggest: "Define `What is it` first, then `How it works`. Link from ADRs/research that reference this concept."

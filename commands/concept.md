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
5. Pre-write race check (Layer 1): `test -e "<path>"`. If exists, ask: **Overwrite**, **Use new slug** (`-2`), or **Cancel**.
6. On Yes (path free or overwrite confirmed): Write file.
7. Update folder index README if `index` is non-null.
8. Suggest: "Define `What is it` first, then `How it works`. Link from ADRs/research that reference this concept."

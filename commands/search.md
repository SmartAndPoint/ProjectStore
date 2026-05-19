---
description: Search the bound vault for a phrase (grep), grouped by folder.
argument-hint: <query>
---

You are searching the vault for the user's query.

Steps:

1. Read config; stop if missing.
2. Run:

   ```bash
   grep -rni --include="*.md" "$ARGUMENTS" "<vault_path>" 2>/dev/null | head -100
   ```

3. Group results by their immediate parent folder under the vault (`adr/`, `epics/`, `research/`, etc.). Print each group with a count, then top 5 lines per group with `file:line:snippet`.
4. If zero results, suggest broadening: case-insensitive variants, partial words, or `grep -l` to list filenames only.
5. At the end, print a hint: "Open a file with the Read tool: `Read <full-path>`."

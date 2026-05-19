---
description: Create a new ops runbook (step-by-step how-to with verification & rollback).
argument-hint: <title>
---

You are creating an ops runbook.

Steps:

1. Check config; stop if missing.
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" runbook "$ARGUMENTS"`.
3. Preview path + first ~20 lines.
4. AskUserQuestion: Yes / Edit / No.
5. On Yes: Write file.
6. Update folder index README if `index` is non-null.
7. Suggest: "Fill `Purpose`, `Prerequisites`, numbered `Steps` with shell snippets, and always include `Verification` and `Rollback`."

---
description: Show what's bound, the active layout, what is in progress, and whether the derived views are fresh.
---

You are summarizing the projectstore binding and the vault's state through the core's `status` verb (roadmap A8: the command renders the verb's facts; nothing here counts, lists or greps the vault by hand).

Steps:

1. Run:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" status --json
   ```

   The project resolves from the session's project directory; do not pass `--project`. `status` runs unbound: if `result.bound` is `false`, output "No vault bound. Run `/projectstore:bind <vault-path>` first." and stop.

2. Print from `result`: `vault_path` (mark `vault_exists: false` as **missing**), `layout`, `language`, `auto_inject`, `approval_mode`, `spec_policy`, `lifecycle_gates`. If `vault_exists` is `false`, the remaining fields are `null` — stop here with "The bound vault directory is missing — restore it, or rebind with `/projectstore:bind <vault-path>`."

3. **Stories** from `result.stories`: `total` on the board with the `by_status` breakdown on one line ("Stories: 72 — done 44, in_progress 3, planned 25"); if `off_board_total` is non-zero, add how many stories the board leaves off and why (`off_board`, e.g. `not_actionable 2`). Then the in-progress list — `in_progress[]` carries `epic`, `title`, `path`, `started_at`; `in_progress_total` says whether the list (capped at 5) is complete. If `stories.status` is `"error"`, print its `error` instead.

4. **Views** from `result.views`: one line, `kanban`, `code_map`, `graph` each as fresh / stale / missing / unknown (`stale` is `true`, `false`, or `null` when the view's mtime could not be read; it compares the view's mtime with the newest artifact's). A stale or missing view is the cue for step 6.

5. **Active sessions** from `result.sessions`: `active` is the count within the last 30 minutes; `entries[]` (capped at 5) carry `id`, `project_root`, `started_at`, `last_active` — print them as a compact table. From inside a slash command you cannot tell which entry is the current session (Claude's `session_id` reaches hooks, not commands); the user can match by `project_root` and timestamps. If `active` is greater than 1: warn "⚠️ Coordinate via /projectstore:search before creating new artifacts to avoid topic collisions (identity is the slug — ADR-010; the draft's `collision` field catches clashes at creation time)."

6. Suggest the next command from what you saw: `stories.total` is 0 → "Vault looks empty — try `/projectstore:scaffold`"; any view stale or missing → "Stale views — try `/projectstore:reconcile`"; something in progress → name it and suggest `/projectstore:story` to continue.

What this command no longer does, and why: the former `ls`/`find -mtime -7` walk of recently touched files is gone — its failure mode is a false "nothing changed" (an iCloud download or a git checkout resets mtimes), the opposite of the views' `stale` flag, whose false positive only costs a reconcile. The in-progress list and the views' freshness answer the same question from artifact facts. The former layout-folder check (`ls` the vault, mark missing folders) is `doctor --vault`'s job and `orientation`'s skeleton shows the folders that exist; it is not repeated here.

---
description: Move stories as their pull requests merge, close or go stale — show the plan, ask once, then let the verb write it.
argument-hint: "[--story <EPIC>/<id>] [--pr <n|url>]"
---

You are bringing stories in line with their pull requests through the core's `follow` verb. It reads, through `gh`, the pull requests that stories name (`external_refs.pr`, or a `Closes-story: <EPIC>/<id>` line in a pull request's body), plans each story's change and, with `--write`, writes it itself: it reads the pull requests and the vault again, so no clerk runs and you never edit a story here. A story a merged pull request closes gets that pull request's files as its `code_refs`, and its epic's `code_refs` widen to cover them.

1. **Show the plan.** Pass on only the narrowing flags the user gave in `$ARGUMENTS` (`--story <EPIC>/<id>`, `--pr <n|url>`), after `follow`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" follow --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Exit 3: the project is not bound; tell the person to run `/projectstore:bind <vault-path>` and stop. Exit 2: a flag is wrong; say which and stop.

2. **Relay it.** List `result.items` (each `story` and its `line`; for a close, how many files `refs` holds and the paths in `epic_refs`, the epic's additions, `null` when its `epic.md` cannot be read), then `result.findings` and `result.notes` by `code` and `message` (a `verb-mark` note names a story a verb wrote and no review has read; it is changed all the same), then the epics in `result.epics.epics` (each `line`) and `result.epics.notes`.
   - A `gh-unavailable` finding: `gh` is missing or logged out. Say so and stop; ask nothing.
   - A `files-unknown` finding: the pull request's files could not be read, so that story is left as it is and the next run reads them again. A `code-refs-unreadable` finding: the story's or its epic's `code_refs` is not a one-line JSON list; that story is left as it is until it is.
   - The notes `repo-unknown`, `files-foreign`, `prefix-unknown` and `refs-over-cap` mean the close goes on with no new `code_refs`, and its Status log line says which; `files-truncated` means some files were not listed. Each message names the `codemap set` command that sets them by hand.
   - No item and no epic with `to: done`: say that nothing would change and stop.

3. **Ask once** whether to apply it (AskUserQuestion: **Apply** / **Cancel**). Say that the verb reads the pull requests and the vault again when it writes, so what it writes can differ from this plan if a pull request changed meanwhile.

4. **On Apply**, run the same command with `--write` and the same narrowing flags:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" follow --write --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Report the items with `written: true` (with their `refs` count and `epic_refs`), the epics in `result.epics.moved`, every finding and note, and the exit: 0 with notes only, 1 on a finding. An `epic-refs-error` finding: the story was closed with its `code_refs`, but its epic's were not widened; relay the refs and the `codemap set` command its message names. On Cancel, nothing is written; say so.

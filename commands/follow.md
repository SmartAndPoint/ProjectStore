---
description: Move stories as their pull requests merge, close or go stale — show the plan, ask once, then let the verb write it.
argument-hint: "[--story <EPIC>/<id>] [--pr <n|url>]"
---

You are bringing stories in line with their pull requests through the core's `follow` verb. It reads, through `gh`, the pull requests that stories name (`external_refs.pr`, or a `Closes-story: <EPIC>/<id>` line in a pull request's body), plans each story's change and, with `--write`, writes it itself: it reads the pull requests and the vault again, so no clerk runs and you never edit a story here.

1. **Show the plan.** Pass on only the narrowing flags the user gave in `$ARGUMENTS` (`--story <EPIC>/<id>`, `--pr <n|url>`), after `follow`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" follow --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Exit 3: the project is not bound; tell the person to run `/projectstore:bind <vault-path>` and stop. Exit 2: a flag is wrong; say which and stop.

2. **Relay it.** List `result.items` (each `story` and its `line`), then `result.findings` and `result.notes` by `code` and `message`, then the epics in `result.epics.epics` (each `line`) and `result.epics.notes`.
   - A `gh-unavailable` finding: `gh` is missing or logged out. Say so and stop; ask nothing.
   - No item and no epic with `to: done`: say that nothing would change and stop.

3. **Ask once** whether to apply it (AskUserQuestion: **Apply** / **Cancel**). Say that the verb reads the pull requests and the vault again when it writes, so what it writes can differ from this plan if a pull request changed meanwhile.

4. **On Apply**, run the same command with `--write` and the same narrowing flags:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" follow --write --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Report the items with `written: true`, the epics in `result.epics.moved`, every finding and note, and the exit: 0 with notes only, 1 on a finding. On Cancel, nothing is written; say so.

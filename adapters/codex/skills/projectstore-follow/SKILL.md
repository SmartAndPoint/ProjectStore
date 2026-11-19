---
name: projectstore-follow
description: "Move stories as their pull requests merge, close or go stale — show the plan, ask once, then let the verb write it. Arguments: [--story <EPIC>/<id>] [--pr <n|url>]."
---

## Runtime path

Resolve paths from this skill's own directory, never from the checkout or a
remembered cache path. The plugin root is two directories above this SKILL.md;
the bundled core is `<plugin-root>/node_modules/projectstore`. Before running
any ProjectStore command, export `PROJECTSTORE_CORE_ROOT` to that bundled-core
path in its own shell statement, then use `node "${PROJECTSTORE_CORE_ROOT}/…"`.
Do not prefix the command with the assignment: a shell expands the quoted path
before that inline assignment takes effect. If the bundled core is missing, stop
and report a broken plugin install; do not fetch a different version from npm.

## User arguments

The source command's host-substituted argument token is rendered here as
`<user-arguments>` (or `<user-arguments-without-fix>`). Before executing a
shown command, replace that token with the actual arguments from the user's
request and shell-quote values safely. Never pass the angle-bracket token
literally and never treat it as a shell variable.

You are bringing stories in line with their pull requests through the core's `follow` verb. It reads, through `gh`, the pull requests that stories name (`external_refs.pr`, or a `Closes-story: <EPIC>/<id>` line in a pull request's body), plans each story's change and, with `--write`, writes it itself: it reads the pull requests and the vault again, so no clerk runs and you never edit a story here. A story a merged pull request closes gets that pull request's files as its `code_refs`, and its epic's `code_refs` widen to cover them.

1. **Show the plan.** Pass on only the narrowing flags the user gave in `<user-arguments>` (`--story <EPIC>/<id>`, `--pr <n|url>`), after `follow`:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" follow --json --project "$PWD"
   ```

   Exit 3: the project is not bound; tell the person to run `$projectstore-bind <vault-path>` and stop. Exit 2: a flag is wrong; say which and stop.

2. **Relay it.** List `result.items` (each `story` and its `line`; for a close, how many files `refs` holds and the paths in `epic_refs`, the epic's additions, `null` when its `epic.md` cannot be read), then `result.findings` and `result.notes` by `code` and `message` (a `verb-mark` note names a story a verb wrote and no review has read; it is changed all the same), then the epics in `result.epics.epics` (each `line`) and `result.epics.notes`.
   - A `gh-unavailable` finding: `gh` is missing or logged out. Say so and stop; ask nothing.
   - A `files-unknown` finding: the pull request's files could not be read, so that story is left as it is and the next run reads them again. A `code-refs-unreadable` finding: the story's or its epic's `code_refs` is not a one-line JSON list; that story is left as it is until it is.
   - The notes `repo-unknown`, `files-foreign`, `prefix-unknown` and `refs-over-cap` mean the close goes on with no new `code_refs`, and its Status log line says which; `files-truncated` means some files were not listed. Each message names the `codemap set` command that sets them by hand.
   - No item and no epic with `to: done`: say that nothing would change and stop.

3. **Ask once** whether to apply it (the harness's user-input mechanism: **Apply** / **Cancel**). Say that the verb reads the pull requests and the vault again when it writes, so what it writes can differ from this plan if a pull request changed meanwhile.

4. **On Apply**, run the same command with `--write` and the same narrowing flags:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" follow --write --json --project "$PWD"
   ```

   Report the items with `written: true` (with their `refs` count and `epic_refs`), the epics in `result.epics.moved`, every finding and note, and the exit: 0 with notes only, 1 on a finding. An `epic-refs-error` finding: the story was closed with its `code_refs`, but its epic's were not widened; relay the refs and the `codemap set` command its message names. On Cancel, nothing is written; say so.

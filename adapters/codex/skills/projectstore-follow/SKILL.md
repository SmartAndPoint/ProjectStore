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

You are bringing stories in line with their pull requests through the core's `follow` verb. It reads, through `gh`, the pull requests that stories name (`external_refs.pr`, or a `Closes-story: <EPIC>/<id>` line in a pull request's body), plans each story's change and, with `--write`, writes it itself: it reads the pull requests and the vault again, so no clerk runs and you never edit a story here.

1. **Show the plan.** Pass on only the narrowing flags the user gave in `<user-arguments>` (`--story <EPIC>/<id>`, `--pr <n|url>`), after `follow`:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" follow --json --project "$PWD"
   ```

   Exit 3: the project is not bound; tell the person to run `$projectstore-bind <vault-path>` and stop. Exit 2: a flag is wrong; say which and stop.

2. **Relay it.** List `result.items` (each `story` and its `line`), then `result.findings` and `result.notes` by `code` and `message`, then the epics in `result.epics.epics` (each `line`) and `result.epics.notes`.
   - A `gh-unavailable` finding: `gh` is missing or logged out. Say so and stop; ask nothing.
   - No item and no epic with `to: done`: say that nothing would change and stop.

3. **Ask once** whether to apply it (the harness's user-input mechanism: **Apply** / **Cancel**). Say that the verb reads the pull requests and the vault again when it writes, so what it writes can differ from this plan if a pull request changed meanwhile.

4. **On Apply**, run the same command with `--write` and the same narrowing flags:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" follow --write --json --project "$PWD"
   ```

   Report the items with `written: true`, the epics in `result.epics.moved`, every finding and note, and the exit: 0 with notes only, 1 on a finding. On Cancel, nothing is written; say so.

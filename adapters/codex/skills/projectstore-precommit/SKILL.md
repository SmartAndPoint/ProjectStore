---
name: projectstore-precommit
description: "Before a vault commit, check which changed vault files are this session's own and which carry another writer's edits, and stop on those. Arguments: [<path>…]."
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

You are checking the vault before a commit through the core's `session check`. It traces each changed vault file from HEAD over this session's own record of its vault writes, and names the files that carry a change this session did not make. It reads git and writes nothing; ProjectStore commits nothing, so the commit stays yours or the person's.

1. Run it. With no paths in `<user-arguments>` it checks every changed vault file; with paths, pass each one, quoted, after `check`:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" session check --project "$PWD"
   ```

   Exit 3: the project is not bound; tell the person to run `$projectstore-bind <vault-path>` and stop. Exit 2: a path is outside the vault; say which.

2. **Relay its lines, then do what its last line says.** Each file is one of:
   - `own`: every change in it is this session's;
   - `consistent`: a derived view (the board, the code map, the graph, a folder index) whose sources are all this session's own;
   - `another-writer`: it carries edits another live session made, named by its short id, host and last activity;
   - `unattributed`: it carries edits no recorded write explains, and no live session claims it (an editor, a shell, a session gone idle).

   On exit 1 with files that are not yours: do not commit those files. Commit your own by naming their paths, and tell the person which files you left out and why. On an open merge or a read the check could not answer: do not commit; tell the person. On exit 0: commit now, naming the paths, since the check saw the files only as they were.

The check never says a file is yours because this session read or edited it: only a chain of its own recorded writes from HEAD makes a file its own. A host that gives the plugin no session id cannot tell this session's files from others'; the last line then says to ask the person.

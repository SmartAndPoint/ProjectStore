# Upgrading a project bound before 0.28

The README's [Upgrading](../README.md#upgrading) section covers every upgrade from 0.28 on. A project bound before 0.28 needs one more command. What an existing project sees afterwards, and why:

- **The project's files move to `.projectstore/`.** The pre-0.28 `.claude/projectstore.json`
  and the legacy `.claude/.projectstore/` become `.projectstore/projectstore.json`,
  `.projectstore/harness/claude-code.json` and `.projectstore/state/`. Nothing
  breaks before you move them: every reader falls back to the old paths through
  0.30, and the startup line names the command until the move is done. Close
  every Claude Code session in the project, run that command from a terminal in
  the project, then restart. The command depends on how you installed. From the
  git marketplace (every 0.27.x install), it is the installed copy's own
  `bin/projectstore.mjs`, with its path spelled out in the startup line:

  ```
  node "<plugin cache>/bin/projectstore.mjs" upgrade --harness claude-code --no-register
  ```

  From npm:

  ```
  npx projectstore@<version> upgrade --harness claude-code --no-register
  ```

  `--no-register` leaves your plugin registration as it is: both forms move
  only the project's files. The same run re-stamps the status-line launcher at
  its new path and re-registers the agents block, whose template is now v4. An
  upgrade without `--no-register` on a git-marketplace install does more: it
  also registers the plugin from npm for this checkout and turns the
  git-marketplace copy off here, so that copy's updates stop reaching the
  checkout. The 0.28.0-rc.1 and rc.2 startup lines named that form, without
  `--no-register`, so on those, update first and run what the new startup line
  names. If it already happened, this turns the git-marketplace copy back on
  (0.28.0 or later), from a terminal in the project:

  ```
  npx projectstore@<version> uninstall --harness claude-code --surface plugin
  ```

  That copy must be 0.28 or later — an older one reads a moved project as
  unbound — so update it first if it is not. Restart, then in the new session,
  to re-stamp the status line against that copy:

  ```
  /projectstore:doctor --fix
  ```
- **The status line keeps rendering.** A launcher written by an earlier version
  still works, but it carries no file stamp and its embedded fallback root is
  frozen at the old version; the move above re-stamps it. Nothing rewrites that
  file behind your back any more: first wiring and refresh are `install`'s,
  behind a preview.
- **`/projectstore:status` and `/projectstore:search` answer differently:**
  facts from artifact frontmatter and the derived views' freshness instead
  of an `mtime` walk; a literal, bounded, grouped search instead of a shell
  `grep`. Every other command prints what it printed before.
- **`/projectstore:doctor` has new lines** — the state of each installed
  surface, a version-drift check across plugin versions, and one permanent
  info line saying the MCP read tools are registered. Its exit code now
  carries the verdict (1 = findings), so a red Bash result is findings, not
  a crash.
- **The plugin registers an MCP server** (eight read-only tools over the
  vault). Claude Code may ask you to approve it once.
- **The agents block stays where Claude Code reads it.** In a project with an
  `AGENTS.md`, the block goes there and `CLAUDE.md` carries a one-line
  `@AGENTS.md` import; otherwise the block goes into `CLAUDE.md`. A project with
  an `AGENTS.md` and no `CLAUDE.md` now gains that one-line `CLAUDE.md`.
- **The passive skills are published under the `projectstore-` prefix**
  (`projectstore-decision-detector`, `projectstore-peer-reviewer`,
  `projectstore-story-completion`, `projectstore-vault-communication`). Nothing
  in a project names them; only a skill listing shows the new names.
- **Rolling back** to 0.27.x before the move: everything keeps working, since
  0.27.x still reads the old layout. It rewrites the status-line launcher in its
  own form, as it always did; coming forward again, the startup line names the
  move once more, and the move re-stamps the launcher. If a session already
  re-stamped the status line or re-registered the agents block before the move
  (rc.2's `/projectstore:doctor --fix` did both), 0.27.x reports a foreign
  status line and a v4 block and leaves both alone — unless you run
  `/projectstore:agents register` in it, which rewrites the block; the status
  line still renders, and the move settles both.
- **Rolling back** to 0.27.x after the move: 0.27.x looks for its binding under
  `.claude/`, finds none and offers `bind`. Do not accept. A re-bind writes
  the legacy `.claude/projectstore.json` again, and 0.28's `install` and `upgrade` refuse
  while two bindings exist. To come forward again, delete
  the legacy `.claude/projectstore.json`, then run the command the startup line names
  once more: a 0.27.x session writes its welcome marker back under `.claude/`.
- **Installed from npm?** Then Claude Code's plugin update has nothing to
  fetch: the package itself refreshes the registration. The upgrade at the top of this
  section, run from a terminal outside the session, rewrites the local
  marketplace and runs the host's `plugin update` for this checkout.
  `/projectstore:doctor` says when the registration is behind the package, and
  names the command.

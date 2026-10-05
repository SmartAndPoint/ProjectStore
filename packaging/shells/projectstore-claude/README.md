# projectstore-claude

The Claude Code installer for [projectstore](https://www.npmjs.com/package/projectstore): the core, pinned at exactly this version and bundled inside this tarball, with the harness fixed. One command, from a terminal **outside** a Claude Code session:

```sh
npx projectstore-claude install --project "$PWD"
```

It registers the plugin for that checkout at the host's local scope. It prints its plan first — every write and every host command, verbatim — and at a terminal asks `Apply N changes? [Y/n]` before anything runs; then each step as it runs, and what to do next. Without a terminal (a script, CI, an agent's tool) naming the shell is the confirmation; `--json` never asks. Restart Claude Code afterwards.

- See before you write: `npx projectstore-claude plan --project "$PWD"` prints the same plan and writes nothing; `--verbose` adds every row's reasoning; `npx projectstore-claude <verb> --help` lists a verb's options with examples.

- Upgrade, or pin: `npx projectstore-claude@<version> upgrade --project "$PWD"` — the version you name is the version you run.
- Uninstall: `npx projectstore-claude uninstall --project "$PWD"` — forgets the registration for that checkout and nothing else; your vault is plain markdown and stays yours.
- `doctor`, `status`, `search` and the other read verbs pass through unchanged: `npx projectstore-claude doctor --json`.

This shell is `projectstore <verb> --harness claude-code` and nothing more. `bin/projectstore-claude.mjs` locates the bundled core under `node_modules/projectstore/` and execs it; the core's low-level form — `npx projectstore install --harness claude-code --project "$PWD"` — is exactly what runs. A different `--harness` is refused (exit 2). The shell carries no plugin of its own: the plugin Claude Code loads is the bundled core, registered through a small local marketplace under your Claude home.

Why from a terminal: the host CLI and a live session both rewrite the same settings files, so the core defers the registration inside a session and says so.

- Docs: https://github.com/SmartAndPoint/ProjectStore#install--one-message
- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

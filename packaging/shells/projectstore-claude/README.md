# projectstore-claude

> **To install ProjectStore, run `npx projectstore setup` from a terminal in your project.** This package is a release artifact; you do not need it.

The Claude Code distribution shell of [projectstore](https://www.npmjs.com/package/projectstore): the core, pinned at exactly this version and bundled inside this tarball, with the harness fixed to Claude Code.

From a terminal in your project:

```sh
npx projectstore setup
```

Setup finds the coding agents the project uses, Claude Code among them, and installs ProjectStore for each, with a vault for the project's notes. It asks a few questions, prints one plan — every write and every host command, verbatim — and asks once before anything runs. For Claude Code it registers the plugin for that checkout at the host's local scope, through a small local marketplace under your Claude home. Restart Claude Code afterwards.

Upgrade, or pin, from the same place; the version you name is the version you run:

```sh
npx projectstore@<version> upgrade
```

This shell's bin is `projectstore <verb> --harness claude-code` and nothing more. `bin/projectstore-claude.mjs` locates the bundled core under `node_modules/projectstore/` and execs it; a different `--harness` is refused (exit 2). The shell carries no plugin of its own: the plugin Claude Code loads is the bundled core.

- Docs: https://github.com/SmartAndPoint/ProjectStore#install
- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

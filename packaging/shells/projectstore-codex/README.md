# projectstore-codex

> **Setup fetches this package for Codex, and nobody needs to run it.** To install ProjectStore, run `npx projectstore setup` from a terminal in your project.

The Codex distribution shell of [ProjectStore](https://github.com/SmartAndPoint/ProjectStore). It ships a Codex plugin manifest (`.codex-plugin/plugin.json`), rendered namespaced workflow skills, lifecycle hooks, and the ProjectStore core pinned at the exact same version and bundled inside the tarball. When a project uses Codex, the core's `setup`, `install` and `upgrade` fetch this package at their own version to register it, and plan Codex from it in the same plan as every other harness.

From a terminal in your project:

```sh
npx projectstore setup
```

Setup prints its plan first — every mutation and every Codex command, verbatim — and at a terminal asks once before it writes. For Codex it stages a stable local marketplace under `CODEX_HOME`, asks Codex's own CLI to install the plugin, verifies the materialised cache by version and payload digest, and says what to do next. Restart Codex and approve the ProjectStore hooks when prompted. Codex picks up hook changes late: a release that changes hooks may take effect only in the session after next.

The core's form for Codex alone, without setup's questions:

```sh
npx projectstore install --harness codex
```

Upgrade, naming the version you want to run:

```sh
npx projectstore@<version> upgrade --harness codex
```

Project uninstall leaves the user-global Codex plugin in place; `uninstall --global` is the explicit machine-wide removal. Before it changes anything, the installer asks Codex for the read-back it verifies with (`codex plugin list --json`), and a Codex too old to answer stops the registration before it changes anything.

Behind a registry mirror (often a company's) that has not synced this release, run setup from npm's public registry; the fetch of this package uses the same registry:

```sh
npm_config_registry=https://registry.npmjs.org npx projectstore@<version> setup
```

Codex support is **experimental**: see [`docs/harnesses.md`](https://github.com/SmartAndPoint/ProjectStore/blob/main/docs/harnesses.md) for what has been measured and what has not. Hooks start `node` from the Codex process's own `PATH`, so start Codex from a terminal where `node` resolves.

- Docs: https://github.com/SmartAndPoint/ProjectStore#install
- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

# projectstore-codex

The Codex installer for [ProjectStore](https://github.com/SmartAndPoint/ProjectStore). It ships a canonical portable `plugin.json`, rendered namespaced workflow skills, lifecycle hooks, and the ProjectStore core pinned at the exact same version and bundled inside the tarball.

From a terminal in your project:

```sh
npx projectstore-codex install --project "$PWD"
```

The installer previews every mutation, stages a stable local marketplace under `CODEX_HOME`, asks Codex's own CLI to install the plugin, and verifies the materialised cache by version and payload digest. Restart Codex, approve the ProjectStore hooks when prompted, then run `$projectstore-bind <vault-path>`. Codex picks up hook changes late: a release that changes hooks may take effect only in the session after next.

Upgrade with `npx projectstore-codex@<version> upgrade --project "$PWD"`. Project uninstall leaves the user-global Codex plugin in place; `uninstall --global` is the explicit machine-wide removal.

Codex support is **experimental**: see [`docs/harnesses.md`](https://github.com/SmartAndPoint/ProjectStore/blob/main/docs/harnesses.md) for what has been measured and what has not. Hooks start `node` from the Codex process's own `PATH`, so start Codex from a terminal where `node` resolves.

To exercise the same npx path from a checkout, against a built tarball:

```sh
npm run shells:build -- --only projectstore-codex --dev --out dist
npx --package "./dist/projectstore-codex-$(node -p 'require("./package.json").version').tgz" projectstore-codex install --project "$PWD"
```

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

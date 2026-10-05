# projectstore-codex

The Codex installer for [ProjectStore](https://github.com/SmartAndPoint/ProjectStore). It ships a Codex plugin manifest (`.codex-plugin/plugin.json`), rendered namespaced workflow skills, lifecycle hooks, and the ProjectStore core pinned at the exact same version and bundled inside the tarball.

From a terminal in your project:

```sh
npx projectstore-codex install --project "$PWD"
```

The installer prints its plan first — every mutation and every Codex command, verbatim — and at a terminal asks `Apply N changes? [Y/n]` (without one, naming the shell is the confirmation; `--json` never asks). It then stages a stable local marketplace under `CODEX_HOME`, asks Codex's own CLI to install the plugin, verifies the materialised cache by version and payload digest, and says what to do next. `npx projectstore-codex plan --project "$PWD"` prints the same plan and writes nothing; `--verbose` adds every row's reasoning; `<verb> --help` lists a verb's options with examples. Restart Codex, approve the ProjectStore hooks when prompted, then run `$projectstore-bind <vault-path>`. Codex picks up hook changes late: a release that changes hooks may take effect only in the session after next.

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

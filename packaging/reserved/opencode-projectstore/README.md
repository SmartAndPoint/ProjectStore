# opencode-projectstore

**This is a reserved name, not a product.** Install [`projectstore`](https://www.npmjs.com/package/projectstore) instead:

```sh
npm install projectstore
```

The first working name of the opencode shell. opencode's `opencode-` prefix is a naming convention, not a discovery requirement, so the shell ships as `projectstore-opencode` — one `projectstore-<harness>` name per harness — and this name stays a deprecated pointer to it.

ProjectStore ships as **one source package carrying every harness's
manifest** — and, per harness, a distribution shell that pins and bundles it
with the harness fixed: `projectstore-claude`, `projectstore-codex`,
`projectstore-opencode`. Those decisions are recorded in the project's
architecture decision records.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues
- Author: Evgenii Konev (SmartAndPoint)

MIT licensed.

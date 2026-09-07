# projectstore-mcp

**This is a reserved name, not a product.** Install [`projectstore`](https://www.npmjs.com/package/projectstore) instead:

```sh
npm install projectstore
```

ProjectStore's MCP read surface ships inside `projectstore` itself rather than as a separate package. This name is held so nothing else can present itself as it.

ProjectStore ships as **one source package carrying every harness's
manifest** — and, per harness, a distribution shell that pins and bundles it
with the harness fixed: `projectstore-claude`, `projectstore-codex`,
`projectstore-opencode`. Those decisions are recorded in the project's
architecture decision records.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues
- Author: Evgenii Konev (SmartAndPoint)

MIT licensed.

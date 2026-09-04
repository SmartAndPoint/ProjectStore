# opencode-projectstore

**This is a reserved name, not a product.** Install [`projectstore`](https://www.npmjs.com/package/projectstore) instead:

```sh
npm install projectstore
```

opencode discovers plugins by the `opencode-` name prefix. This name is reserved for the thin re-export that will make projectstore installable in opencode; until then, the plugin lives in `projectstore`.

ProjectStore ships as **one package carrying every harness's manifest** —
Claude Code, Codex, opencode and an MCP server all install the same tree. That
decision is recorded in the project's architecture decision records.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues
- Author: Evgenii Konev (SmartAndPoint)

MIT licensed.

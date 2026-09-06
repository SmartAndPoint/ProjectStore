# projectstore-codex

The Codex installer for [projectstore](https://www.npmjs.com/package/projectstore) — **not published yet.** This shell's plugin root (`.codex-plugin/plugin.json`, the rendered hooks and skills, `.mcp.json`) lands with the Codex story of the PS-HARNESS epic; until then the package is marked private and the release skips it.

Its shape is the same as `projectstore-claude`'s: the core, pinned at exactly this version and bundled inside the tarball, with the harness fixed by the bin. Codex installs an npm plugin with `npm pack` and unpacks it without installing dependencies, which is why the core travels inside the tarball rather than as a dependency.

When it ships, from a terminal:

```sh
npx projectstore-codex install --project "$PWD"
```

Until then, the name on the registry is a deprecated 0.0.1 placeholder pointing at `projectstore`.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

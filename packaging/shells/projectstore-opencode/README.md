# projectstore-opencode

The opencode installer for [projectstore](https://www.npmjs.com/package/projectstore) — **not published yet.** This shell's plugin root (the opencode plugin entry point and the rendered opencode surfaces) lands with the opencode story of the PS-HARNESS epic; until then the package is marked private and the release skips it.

Its shape is the same as `projectstore-claude`'s: the core, pinned at exactly this version and bundled inside the tarball, with the harness fixed by the bin. The earlier working name `opencode-projectstore` is deprecated with a pointer here — one `projectstore-<harness>` name per harness.

When it ships, from a terminal:

```sh
npx projectstore-opencode install --project "$PWD"
```

Until then, the name on the registry is a deprecated 0.0.1 placeholder pointing at `projectstore`.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues

MIT licensed.

# Publishing projectstore

Two paths, and they are not equivalent. **CI is the normal one.** The local one
exists because npm's trusted-publisher form requires the package to already
exist, so the very first publish of any name has to be done by a human — and
because an emergency should not depend on GitHub being up.

## What is guarded

| Guard | What it catches | Where it runs |
|---|---|---|
| `node scripts/version-guard.mjs [--tag vX.Y.Z]` | `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (and `.codex-plugin/plugin.json` once it exists) disagreeing with each other or with the release tag | CI, and by hand before a local publish |
| `tests/packaging.test.mjs` | a directory added to the tree but forgotten in `files[]`, a `files[]` entry that stopped shipping, and `publishConfig.provenance` creeping back in | CI, and `npm test` |

Neither guard runs by itself on a local publish. `npm run release:check` runs
both plus a pack dry-run — run it first, every time.

## Local publish

Only for a name's first release, or when CI cannot. npm's local session token
lasts hours, so log in immediately before publishing rather than the day before.

```sh
npm login                 # expect a browser round-trip; 2FA may prompt
npm whoami                # must print your npm user
npm run release:check     # version guard + tests + pack dry-run
npm publish               # NOT --provenance: that needs OIDC, i.e. CI
```

Then, once on npmjs.com, configure the trusted publisher so every later release
comes from CI with no token: **projectstore → Settings → Trusted publisher →
GitHub Actions**, repository `SmartAndPoint/ProjectStore`, workflow
`release.yml`.

Before a *first* publish of real content, install the tarball somewhere
disposable and walk it. A published version is immutable — a wrong `files` set
burns that version permanently and costs a full release cycle to correct:

```sh
npm pack --pack-destination /tmp
mkdir /tmp/scratch && cd /tmp/scratch && npm init -y
npm install /tmp/projectstore-<version>.tgz
ls -a node_modules/projectstore
```

## CI publish

Push a `vX.Y.Z` tag. `.github/workflows/release.yml` pins npm to a
Trusted-Publishing-capable version, runs the version guard against the tag,
runs the tests, and publishes with `--provenance` over OIDC.

**No npm token belongs in this repository's secrets.** If one is ever needed,
something is misconfigured on the package's trusted-publisher settings — fix
that instead of adding a token.

The version is never invented at release time: it is whatever
`.claude-plugin/plugin.json` says, and the tag must match it. The guard fails
the run before `npm publish` if they disagree.

## Reserved names

`packaging/reserved/` holds stub packages for names we hold defensively but do
not ship. They are regenerated from one source:

```sh
node packaging/reserved.mjs            # list them and their fate
node packaging/reserved.mjs --write    # regenerate the stub directories
```

Publishing them is a one-time act per name, and each one is deprecated
immediately afterwards so `npm install` prints the pointer instead of silently
installing a stub:

```sh
cd packaging/reserved/<name>
npm publish
npm deprecate <name> "Reserved name — install `projectstore` instead."
```

Nothing under `packaging/` ships inside the `projectstore` tarball: the root
`package.json` uses a `files` allowlist that omits it, and
`tests/packaging.test.mjs` asserts it stays omitted.

`@smartandpoint/*` needs no defensive publish — the scope belongs to the org,
so no one else can publish into it.

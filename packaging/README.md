# Publishing projectstore

Two paths, and they are not equivalent. **CI is the normal one.** The local one
exists because npm's trusted-publisher form requires the package to already
exist, so the very first publish of any name has to be done by a human — and
because an emergency should not depend on GitHub being up.

## What is guarded

| Guard | What it catches | Where it runs |
|---|---|---|
| `node scripts/version-guard.mjs [--tag vX.Y.Z]` | `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and every `packaging/shells/*/package.json` (its version and its exact `=<version>` pin on the core) disagreeing with each other or with the release tag; a shell that does not bundle the core or misnames its bin | CI, and by hand before a local publish |
| `node packaging/shells.mjs --check` | a shell's committed `package.json` or bin drifting from its render (the pin, the bin's verb set) | CI, and `npm run release:check` |
| `tests/packaging.test.mjs`, `tests/shells.test.mjs` | a directory added to the tree but forgotten in `files[]`, a `files[]` entry that stopped shipping, `publishConfig.provenance` creeping back in; a shell whose built tarball differs from its packlist fixture, or whose bin does not exec the bundled core with the harness fixed | CI, and `npm test` |

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
Trusted-Publishing-capable version, runs the version guard against the tag and
the shells' render check, runs the tests, and publishes the core with
`--provenance` over OIDC. Then a second job runs a matrix over the publishable
shells (`node packaging/shells.mjs --list --json` — the non-private ones, so a
shell whose plugin root is not rendered yet cannot reach the registry), builds
each from the core's own pack tarball and publishes it the same way. Every
publish step skips a `name@version` the registry already has, so a partial
release — the core published, a shell not — is recovered by re-running the
same tag, never by hand.

The shell step publishes the built **tarball** (`npm publish dist/<name>-<v>.tgz
--provenance`) so the file that ships is the file the fixture was compared
with. npm's provenance docs describe publishing from a package *directory* and
say nothing about a tarball spec; a dry run accepts the tarball form and keeps
the bundle (`bundled deps: 1`, 148 files, measured 2026-09-06), but a dry run
does not generate provenance. If the real publish refuses the tarball, the
fallback is the documented form from the built directory the same command
leaves beside the tarball: `cd dist/build/<name> && npm publish --provenance`.
Do not un-bundle to get past it — the bundle is the whole point.

**No npm token belongs in this repository's secrets.** If one is ever needed,
something is misconfigured on the package's trusted-publisher settings — fix
that instead of adding a token.

The version is never invented at release time: it is whatever
`.claude-plugin/plugin.json` says, and the tag must match it. The guard fails
the run before `npm publish` if they disagree.

## Shells

`packaging/shells/<name>/` is one distribution shell per harness (the shells
ADR, amended 2026-09-06 by the layout ADR): a package that pins the core at
exactly its own version, **bundles** it (the tarball carries
`node_modules/projectstore/`, so neither a host that installs no dependencies
nor a registry race can pair the shell with another core) and fixes
`--harness` in its bin. `npx projectstore-claude install --project "$PWD"` is
`npx projectstore install --harness claude-code --project "$PWD"`, byte for
byte in what it previews and writes. A shell is a bin and a pin, never logic.

The roster lives in `packaging/shells.mjs` (`SHELLS`); `package.json` and
`bin/<name>.mjs` are **rendered and committed** from it, the README is
hand-written, and `packlist.json` is the fixture the build is compared with:

```sh
node packaging/shells.mjs                 # the shells, their versions and pins
node packaging/shells.mjs --write         # re-render package.json and the bin (after a core version bump, or a verb gaining --harness)
node packaging/shells.mjs --check         # the committed files equal their render
node packaging/shells.mjs --build --out dist   # pack the core, bundle it into each shell, pack the shells into dist/
npm run packlist                          # the core's fixture, then every shell's (needs npm; ~1 s per shell)
```

The build never touches `packaging/shells/` itself: it copies a shell to a
scratch directory, runs `npm install --no-save` of the core's tarball there
(`--no-save` keeps the `=<version>` pin as committed) and packs from the copy.
A shell packed without that install exits 0 and ships three files with
`bundled: []` — measured — which is why the build asserts `bundled` before it
compares anything.

`projectstore-codex` and `projectstore-opencode` are `"private": true` until
their plugin roots are rendered (roadmap B5, C4); they are guarded and built
like the others and never listed for the matrix. `npm publish --dry-run` does
NOT honour `private` (measured 2026-09-06: it prints `+ name@version` and exits
0); a real publish refuses one (`EPRIVATE`). The matrix filter is the first of
those two gates, and the only one a dry run exercises.

**First publish of a shell name, by hand — once.** The names exist on the
registry as deprecated 0.0.1 placeholders owned by the maintainer, which is
what lets npm's trusted-publisher form accept this workflow before the first
real release: **`<name>` → Settings → Trusted publisher → GitHub Actions**,
repository `SmartAndPoint/ProjectStore`, workflow `release.yml`. Deprecation
is per version — 0.0.1 stays deprecated, a real release is not — so nothing
needs un-deprecating. The one manual step the rename leaves is the old
opencode name:

```sh
npm login
npm deprecate opencode-projectstore 'Renamed — install `projectstore-opencode` instead.'
```

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
npm deprecate <name> 'Reserved name — install `projectstore` instead.'
```

Single quotes around the message are load-bearing: the text contains backticks,
and inside double quotes the shell would run `projectstore` as a command and
deprecate the package with the output of that instead.

Nothing under `packaging/` ships inside the `projectstore` tarball: the root
`package.json` uses a `files` allowlist that omits it, and
`tests/packaging.test.mjs` asserts it stays omitted.

One thing to know before adding a script here: the repository's
"core writes only through `writeFileAtomic`" guard globs `scripts/` only, so a
file under `packaging/` is not covered by it. `reserved.mjs` and `shells.mjs`
write directly because they generate their own committed output, not vault or
derived state; the shells' packlist fixtures are written by the guard, which
does go through `writeFileAtomic`.

`@smartandpoint/*` needs no defensive publish — the scope belongs to the org,
so no one else can publish into it.

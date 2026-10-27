# Publishing projectstore

Two paths, and they are not equivalent. **CI is the normal one.** The local one
exists because npm's trusted-publisher form requires the package to already
exist, so the very first publish of any name has to be done by a human — and
because an emergency should not depend on GitHub being up.

## What is guarded

| Guard | What it catches | Where it runs |
|---|---|---|
| `node scripts/version-guard.mjs [--tag vX.Y.Z]` | `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and every `packaging/shells/*/package.json` (its version and its exact `=<version>` pin on the core) disagreeing with each other or with the release tag; a shell that does not bundle the core or misnames its bin; a version with no release notes — `packaging/release-notes/v<version>.md` missing, its first line not `# v<version> — <title>`, or nothing under it | CI (`test.yml` on every PR, `release.yml` on the tag), `npm run release:check`, and by hand before a local publish |
| `node packaging/directory-guard.mjs [--set packed\|repository]` | the tree Anthropic's directory scans breaking a rule of its [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist), each finding with its file, the rule, the limit and the checklist's result: more than 512 files; a file that is not an image or a font at 256 KiB or more; a kind other than text, SVG, a complete PNG, JPEG, GIF or WebP, or a font; a `.DS_Store`, `Thumbs.db`, `desktop.ini` or `__MACOSX`; `export-ignore`, `export-subst`, `filter` or another rewriting attribute in a `.gitattributes`; a name Windows or macOS refuses (a colon, a trailing dot or space, a device name, two names that differ only by capitalization); a symbolic link, a submodule or a Git LFS pointer; the repository past 50 MiB archived, 256 MiB unpacked, 10,000 entries or a 5 MiB file; a README under 40 words outside code blocks; no `LICENSE` and no `license` in `plugin.json`; an `.npmrc`, `bunfig.toml` or `uv.toml` that sets a package source; a bundled image or font named from `commands/`, `hooks/` or `scripts/`, or in backticks or a code block; a bundled image the README shows through HTML; a key-shaped value (`sk-` with a key's length, GitHub's `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_`, a private key block), by file and line only; front matter in an agent, command or skill that a YAML parser refuses, or whose `description` is not text. Ours too: a shipped `.mjs` over 204,800 bytes, so a module is split long before 256 KiB, with the next one in line named; and a shipped file that names `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `key_env`, `base_env` or `key_header`, comments included, by file and line, so no version reads a key from the user's environment (the checklist holds that as "Uses a credential from the user's machine"). `packed` (the default) is the packlist, which the `directory` branch carries; `repository` is `git ls-files`, for a directory that tracks `main` | CI (`test.yml`) and `npm run release:check` (`npm run directory:check`) run the packed set; `tests/directory-guard.test.mjs` holds the packed set to every row and the repository set to every row but its file count (the repository is near 512 files and may exceed it). Run `--set repository` by hand before ever having the directory track `main` |
| `node packaging/shells.mjs --check` | a shell's committed `package.json` or bin drifting from its render (the pin, the bin's verb set) | CI, and `npm run release:check` |
| `tests/packaging.test.mjs`, `tests/shells.test.mjs`, `tests/release.test.mjs` | a directory added to the tree but forgotten in `files[]`, a `files[]` entry that stopped shipping, `publishConfig.provenance` creeping back in; a shell whose built tarball differs from its packlist fixture, or whose bin does not exec the bundled core with the harness fixed; a release workflow that would make the GitHub Release before a publish, without the notes, or with a guessed Latest, a directory job that runs for a candidate or before the core publish, a write scope on any job but those two, a site deploy a release cannot trigger, a surfaces workflow that writes or reads its tag inside `run`, and a surface judged ok, lagging or wrong on the wrong evidence; a directory branch whose tree is not the packlist, loses its history, moves backwards, or commits one version twice | CI, and `npm test` |
| `node packaging/directory-branch.mjs --version X.Y.Z` | the tree it would commit to the `directory` branch differing from npm pack's file list, from `tests/fixtures/packlist.json`, or from the unpacked tarball; a `.claude-plugin/plugin.json` in it that does not name the release; the branch carrying that version already with another tree | `release.yml`'s `directory` job, before it pushes |
| `tests/site.test.mjs` | the public site (`site/`, never shipped: `NOT_SHIPPED`) — its pages (the main page in English and Russian, the method pages in eight languages) and `llms.txt`/`llms-full.txt` — stating what the repository contradicts: a command or role with no file, an `npx` verb its bin refuses, an install command README does not fence, the version, a count, a harness's status, a dead link into `main`, an example artifact whose shape or slug the product would not write; a language page out of step with the English one; a load from another origin; committed pages a build would change (asset hashes, alternates, the redirect stubs); `site/` over its 2,621,440-byte budget | CI, `npm test`, and `.github/workflows/pages.yml` before every deploy |
| `python3 site/tools/i18n.py check`, `extract`, `build --strict`, then `git diff --exit-code -- site/` and `if git status --porcelain -- site/ \| grep .; then echo "::error::the build left files not in the commit"; exit 1; fi` | committed pages, or `site/locales/en.json`, that are not what Python 3.12 renders from the templates in `site/src/` and the dictionaries; a file the build writes that is not in the commit, named; a dictionary missing a key or changing a fact marker | CI (`test.yml` and `pages.yml`, Python pinned to 3.12) |

Neither guard runs by itself on a local publish. `npm run release:check` runs
both plus a pack dry-run — run it first, every time.

## Local publish

Only for a name's first release, or when CI cannot. npm's local session token
lasts hours, so log in immediately before publishing rather than the day before.

```sh
npm login                 # expect a browser round-trip; 2FA may prompt
npm whoami                # must print your npm user
npm run lint:setup        # once per checkout: the lint tools, from tools/lint/
npm run release:check     # version and directory guards + lint + tests + pack dry-run
npm publish               # NOT --provenance: that needs OIDC, i.e. CI
```

Then, once on npmjs.com, configure the trusted publisher so every later release
comes from CI with no token: **projectstore → Settings → Trusted publisher →
GitHub Actions**, repository `SmartAndPoint/ProjectStore`, workflow
`release.yml`, with `npm publish` allowed. The form's default permits only a
staged publish, and a publish it refuses fails that package's job.

Before a *first* publish of real content, install the tarball somewhere
disposable and walk it. A published version is immutable — a wrong `files` set
burns that version permanently and costs a full release cycle to correct:

```sh
npm pack --pack-destination /tmp
mkdir /tmp/scratch && cd /tmp/scratch && npm init -y
npm install /tmp/projectstore-<version>.tgz
ls -a node_modules/projectstore
```

## Release candidates

A version with a prerelease marker — `0.28.0-rc.1` — publishes to the **`next`**
dist-tag, never `latest`: the workflow computes the tag from the version and
passes it to every publish, because npm defaults to `latest` when `--tag` is
omitted and a bare `npx <shell>` would then serve a candidate to everyone.

Install one by naming it:

```sh
npx --yes -p projectstore-claude@0.28.0-rc.1 projectstore-claude install
```

From 0.29.4, which shipped `setup`, setup is the way in, and a candidate is
named the same way, from a terminal in the project; for a project that uses
Codex it fetches the Codex shell at the same candidate:

```sh
npx --yes projectstore@<version>-rc.<n> setup
```

A shell whose only other published version is its 0.0.1 placeholder keeps that
placeholder as `latest` for the duration of the candidate window. That is the
intended shape: nothing installs a candidate by accident, and the first real
release moves `latest` for the first time.

Bumping to a candidate touches the three core version sites; `npm run shells`
re-renders the shells from them and `npm run packlist` regenerates the four
fixtures. `node scripts/version-guard.mjs --tag v0.28.0-rc.1` is what proves
they agree.

There is no root lockfile to bring along, and none may appear: Claude Code
installs the packages named by a lockfile at a plugin's root into every
git-channel user's copy, so `tests/packaging.test.mjs` refuses one. The lint
tools keep their lockfile in `tools/lint/`, which carries no version.
`npm version <version> --no-git-tag-version` rewrites `package.json` alone and
writes no lockfile; a bare `npm install` at the root writes one.

Every bump, a candidate's too, also writes the release's notes:
`packaging/release-notes/v<version>.md`, whose first line is the GitHub
Release's title — `# v0.30.5 — <what the release does, in plain words>` — and
whose body is what the release says: what changes for someone using it, how to
upgrade, and what to do about existing state. The release workflow makes the
GitHub Release from this file, so it is reviewed in the release PR like any
other change; the guard refuses the bump without it.

A release's bump also updates the public site. Edit the `data-fact="version"`
element in `site/src/_footer.html` (the footer every page shares; never the
generated pages), run
`python3 site/tools/i18n.py build` with Python 3.12, and update the version in
`site/llms.txt` and `site/llms-full.txt` ("Facts about version …", and the
closing "Version …" line of the long form), along with any count, tool list or
harness status the release changed. The version guard reads none of these;
`tests/site.test.mjs` fails until they agree with `package.json`, and CI's
freshness step fails until the committed pages are the build's. The other way
round does not hold: a change to `site/` alone is not a release, and nothing is
bumped for it.

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
same tag, never by hand. For a stable release, a fourth job moves the
`directory` branch that Anthropic's directory tracks (see "The directory
branch" below).

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

### The GitHub Release, the site and every surface

A release is done when its version shows on every surface a user reads: the
GitHub README (its `release` badge reads GitHub's Latest), GitHub Releases with
this tag Latest, npm (each package's dist-tag and readme) and the site. Three
pieces see to it.

- **The GitHub Release.** `release.yml`'s third job, `github-release`, runs
  after both publish jobs — when the shells' matrix passed or was skipped,
  never after a failed publish — with `contents: write`, which only it and the
  `directory` job have. It makes the release from `packaging/release-notes/<tag>.md`:
  the heading is the title, the rest the body, `--verify-tag`, and `--latest`
  for a release or `--prerelease --latest=false` for a candidate — explicit
  every time, because GitHub makes each new release Latest by default. A
  release that exists already is left as it is, so re-running the tag
  recovers this job as it recovers the publishes.
- **The site.** `pages.yml` deploys on a push to main that changes `site/`,
  and also when a `release` run succeeds. GitHub does not always deliver a
  push: for 0.30.4's release merge it delivered none, and the site said v0.30.3
  the next day. The second trigger is `workflow_run`, not a tag: the
  github-pages environment admits deployments from main only, matched against
  the run's `GITHUB_REF`, and a `workflow_run` run's is the default branch. It
  deploys main's HEAD, never the tag's tree.
- **The check.** `.github/workflows/surfaces.yml` runs after a `release` run
  of a stable tag succeeds, read-only, and runs `packaging/release-surfaces.mjs`:
  one row per surface — the tag on main, the GitHub Release, the README's
  badge, each package's dist-tag and readme, the site's footer and its llms
  files, and the `directory` branch's `.claude-plugin/plugin.json` — re-read
  once a minute for up to 15 minutes. It is a workflow of its
  own so that `release`'s colour keeps meaning "published": **a red `surfaces`
  run means published, not yet visible.** Run the fix its failing row names (for
  the site, `gh workflow run pages.yml --ref main`), then **Re-run failed jobs**
  on that run. A candidate is checked by dispatching the workflow with its
  version:

  ```sh
  gh workflow run surfaces.yml -f version=0.31.0-rc.1
  ```

By hand — a release made outside CI, or a check from a laptop — the same
file makes the release; with `v0.30.5` for the tag, and `--prerelease
--latest=false` in place of `--latest` for a candidate:

```sh
tail -n +2 packaging/release-notes/v0.30.5.md | tr -d '\r' | sed '/./,$!d' > /tmp/notes.md
gh release create v0.30.5 --verify-tag --latest --title "$(sed -n '1s/^# //p' packaging/release-notes/v0.30.5.md | tr -d '\r')" --notes-file /tmp/notes.md
```

and the check runs from a checkout of main, reading the tag's files from
GitHub. Without a token, api.github.com allows 60 reads an hour, and a
15-minute wait can use most of them; `gh` lends its own:

```sh
GITHUB_TOKEN="$(gh auth token)" node packaging/release-surfaces.mjs --version 0.30.5 --wait 900
```

Exit 0 means every surface names the version; `--json` prints the rows.

## The directory branch

Anthropic's directory (submitted through the developer portal, PS-DIRECTORY:
"The maintainer submits ProjectStore through the developer portal, and the
listing installs and runs from /plugin directory and from Desktop's
Discover") tracks one branch of this repository, `directory`, and scans each
new commit on it. Its tree is the core's npm packlist —
`tests/fixtures/packlist.json`: no lockfile, no `tests/`, `site/` or
`packaging/`, and the plugin at the root, so `.mcp.json`'s
`${CLAUDE_PROJECT_DIR}` stays legal. Tracking `main` instead would make every
merge a scanned version; tracking a tag would need a Settings edit in the
portal at every release.

`release.yml`'s fourth job, `directory`, moves it. It runs after the core
publish, and only when the core job succeeded and the dist-tag is `latest`:
a release candidate never reaches the directory's users. It has
`contents: write`, the second job that does, and runs
`packaging/directory-branch.mjs`, which:

- packs the core again from the tag's checkout, as the core job packs it (never the
  registry's copy) and unpacks it with its modes;
- refuses to go on unless npm pack's file list, `tests/fixtures/packlist.json`
  and the unpacked tree are the same list, and the tree's
  `.claude-plugin/plugin.json` names the release — the directory reads the
  version there ("If your `plugin.json` sets `version`, raise it with every
  release");
- commits that tree as the next commit on `directory`, an orphan commit when
  the branch is missing, so the branch keeps its history;
- commits nothing when the tree equals the branch's head, so re-running the
  tag recovers this job as it recovers the others; never moves the branch
  back for an older tag; and refuses a version the branch carries already
  with another tree;
- pushes without force, with `GH_TOKEN` in the remote URL. The checkout keeps
  `persist-credentials: false`, and the script never prints the token. The
  tree carries no `.github/`, so the push starts no workflow.

`--strip <path>` drops one packed file from the tree; the job strips nothing.
Whether the branch keeps `.claude-plugin/marketplace.json` is the story's open
question, which the first Validate in the portal answers; if it says strip,
the job's step gains `--strip .claude-plugin/marketplace.json` and the
workflow test changes with it.

Whether a branch protection rule refuses the workflow's push is unverified;
the first stable release after the job lands shows it. By hand — the first
time, or when the job could not push — from a checkout of the release's tag,
read the plan first, then move the branch:

```sh
node packaging/directory-branch.mjs --version <version> --dry-run
```

```sh
GH_TOKEN="$(gh auth token)" node packaging/directory-branch.mjs --version <version>
```

A failed `directory` job turns the release run red, and pages and surfaces run
only after a green one. After the by-hand push, choose **Re-run failed jobs** on
the release run: the job reads `unchanged`, the run turns green, and the site
deploy and the surfaces check follow.

The surfaces check reads the branch's `.claude-plugin/plugin.json`
(the `directory branch` row). That is the tree the directory scans, not what
it serves: a reviewer publishes each version, so the listing lags the branch
by the review time, which is not fixed.

### The directory's published version, read by hand

The listing's published version cannot be read without a claude.ai sign-in:
the portal's **Versions** tab and the synced copy both sit behind one, and a
plugin's public listing URL is unverified. So no surfaces row reads it; after
each stable release, on a machine signed in to claude.ai with ProjectStore
added from the directory, read the synced copy's own
`.claude-plugin/plugin.json`:

```sh
grep -H '"version"' ~/.claude/plugins/synced/*/projectstore/.claude-plugin/plugin.json
```

or doctor's version line — the first line of `/projectstore:doctor`, in a
session that loads the directory copy (an enabled git or npm copy of
ProjectStore in the same project loads instead of it). Never read
`manifest.json` beside the synced folders: its `version` is claude.ai's own
string (`"0040"` for another plugin on this machine). Record what
`claude plugin list` prints for the same copy beside it, and the lag from the
tag to the version being live.

### A bad published version

The story's decision 8, as written:

> **A bad published version goes forward only.**
> - **The fix is a new version.** It is a hotfix release, moved onto
>   `directory` by the workflow, then scanned and published by a reviewer.
>   The lag is the review time, which is not fixed.
> - **Delisting is not a rollback.** The portal says: "People who already
>   installed the plugin stop getting updates, and their copy may be
>   removed." Relisting "is a request, not an instant switch". So delisting
>   is for a version that must not run at all.
> - **Meanwhile, our own channels are faster.** Git-channel users get the fix
>   at the merge to `main` and their next update. npm users get it at
>   publish, through the package's own upgrade. Directory users keep the last
>   published version until the hotfix is published.

In practice: cut the hotfix as any release (bump, notes, merge, tag). The
`directory` job moves the branch; the portal's **Versions** tab shows the new
version scanned, then held for a reviewer or published. "If the security scan
fails a new version, later versions also wait until an Anthropic reviewer
clears the plugin." Delisting is the maintainer's act in the portal, for a
version that must not run at all. The portal's plugin menu (**Get help**,
**Contact Anthropic**) or `directory@anthropic.com` reaches Anthropic; replies
can be delayed.

## Shells

`packaging/shells/<name>/` is one distribution shell per harness (the shells
ADR, amended 2026-09-06 by the layout ADR): a package that pins the core at
exactly its own version, **bundles** it (the tarball carries
`node_modules/projectstore/`, so neither a host that installs no dependencies
nor a registry race can pair the shell with another core) and fixes
`--harness` in its bin. `npx projectstore-claude install` is
`npx projectstore install --harness claude-code`, byte for byte in what it
previews and writes. A shell is a bin and a pin, never logic. Since the
front-door ADR the shells are release artifacts: the documents tell a person
to run `npx projectstore setup`, and the core fetches `projectstore-codex`,
which carries Codex's plugin root, at its own version.

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

`projectstore-opencode` is `"private": true` until its plugin root is rendered
(roadmap C4); it is guarded and built like the others and never listed for the
matrix. `projectstore-codex` was private on the same terms until 0.28.1; from
that release it publishes, with Codex still experimental (roadmap B5). `npm publish --dry-run` does
NOT honour `private` (measured 2026-09-06: it prints `+ name@version` and exits
0); a real publish refuses one (`EPRIVATE`). The matrix filter is the first of
those two gates, and the only one a dry run exercises.

**npm reads a bare relative path as a git spec, twice over.** `npm publish
`dist/x.tgz`` does not publish that file: npm treats it as `owner/repo`
shorthand and runs `git ls-remote ssh://git@github.com/dist/x.tgz.git`, which
is how the shell half of v0.28.0-rc.1 died with exit 128. A leading `./` is
what makes it a file. The same rule bites `npx` below, for the same reason —
assume any bare path npm is handed is a name, not a file, until it starts with
`./`. npm also **refuses** to publish a prerelease without `--tag`, so the
dist-tag rule above is not merely prudent.

**Running a shell tarball before it is published.** `npx --yes <path>.tgz`
reads the path as a *package* only when it begins with `./`. Given an absolute
path, or one starting `../`, npx reads it as a **command**: it hands the path to
`sh`, which answers `Permission denied`, and the run ends 126 with no sign that
the package was never installed (measured 2026-09-06, npm 11.19.0). Two forms
work from anywhere:

```sh
npx --yes -p /abs/path/projectstore-claude-<v>.tgz projectstore-claude install
npx --yes file:/abs/path/projectstore-claude-<v>.tgz install
```

The `-p` form needs the bin name; the `file:` form does not. Either way the
path must be shell-expanded — a quoted `'~/…'` is ENOENT. Both run in the
current directory, so run them from a terminal in the project they install
for.

**First publish of a shell name, by hand — once.** The names exist on the
registry as deprecated 0.0.1 placeholders owned by the maintainer, which is
what lets npm's trusted-publisher form accept this workflow before the first
real release: **`<name>` → Settings → Trusted publisher → GitHub Actions**,
repository `SmartAndPoint/ProjectStore`, workflow `release.yml`, with
`npm publish` allowed. The form's default permits only a staged publish (the
shells ADR, decision 7, measured on rc.2); without it the shell's job fails and
the release is partial until that tag is re-run. Deprecation
is per version — 0.0.1 stays deprecated, a real release is not — so nothing
needs un-deprecating. The one manual step the rename leaves is the old
opencode name:

```sh
npm login
npm deprecate opencode-projectstore 'Renamed — install `projectstore-opencode` instead.'
```

## Running a checkout's build

Between a version bump and its publish, the registry has no shell at the
checkout's version, so a Codex `setup`, `install` or `upgrade` run from the
checkout refuses its fetch (`ETARGET`) and says so. Build the shell instead;
`--dev` stamps a version the Codex cache cannot confuse with a release:

```sh
npm run shells:build -- --only projectstore-codex --dev --out dist
```

Then run the same npx path a user's fetch ends in, against the built tarball,
from a terminal in the project it installs for (the `./` makes it a file, as
above; from another directory, use the `-p` form with an absolute path):

```sh
npx --package "./dist/projectstore-codex-$(node -p 'require("./package.json").version').tgz" projectstore-codex install
```

Or point the checkout's own core at the built directory, which is what the
fetch's refusal names; a set `PROJECTSTORE_DISTRIBUTION_ROOT` is used as is and
nothing is fetched:

```sh
PROJECTSTORE_DISTRIBUTION_ROOT="$PWD/dist/build/projectstore-codex" node bin/projectstore.mjs install --harness codex
```

## Retiring projectstore-claude (0.31)

The maintainer's decision of 2026-10-08, timed on 2026-10-12 (the story "User-facing
text says where to run and names no project path and no shell", rule 8):

1. `setup` shipped in 0.29.4. Every release up to 0.31 publishes
   `projectstore-claude` as usual; from the first one cut after the documents
   moved to setup, its npm page points to `npx projectstore setup`. 0.31
   publishes it for the last time.
2. After the 0.31 release, by hand and once — it covers every version. It is by
   hand because trusted publishing over OIDC covers `npm publish` and
   `npm dist-tag`, not `npm deprecate`, and a CI token would undo the tokenless
   release path:

   ```sh
   npm login
   npm deprecate projectstore-claude 'Replaced by npx projectstore setup'
   ```

3. Then the next commit sets `private: true` on `projectstore-claude` in
   `SHELLS` (`packaging/shells.mjs`), so the release no longer builds or
   publishes it. The version guard and `--check` still cover it, as they cover
   `projectstore-opencode`, and `harnesses/claude-code.json` keeps its
   `install.shell`.

`projectstore-codex` is never deprecated: it is the Codex payload the core
fetches on every Codex `setup`, `install` and `upgrade`, and a deprecated
payload would mark a live package abandoned and make npm warn on every fetch.

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

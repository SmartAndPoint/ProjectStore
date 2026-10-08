# ProjectStore — the public site

A one-page explainer for [ProjectStore](https://github.com/SmartAndPoint/ProjectStore), in eight
languages, served by GitHub Pages at <https://projectstore.dev> from this folder
(`.github/workflows/pages.yml`). It is not part of the npm package: `site` is in `NOT_SHIPPED`
(`scripts/version-guard.mjs`), and `tests/site.test.mjs` holds it to the repository.

The visual system comes from the Astra variant (white, ink, lime; Onest and IBM Plex Mono; numbered
section labels; the vault window on the first screen; the dark teams section; the lime install
section), the process content and diagrams from the Fable variant (the loop with fresh-context verify
nodes, the team-in-git figure, the frontmatter → board demo, the agent roster, measured cost).
Section 02, *Why it works*, argues that ADR, review, backlog, acceptance and traceability are
decades-old practice whose artifacts were always valuable, that executing the process with humans
was what made it expensive, and that agents make it cheap while the artifacts give agents memory
across sessions and links from goals to code.

Static HTML, CSS and vanilla JavaScript. One build step renders the languages from a single
template, in stdlib Python with no dependencies.

## Files

```
src/index.html             the template: English text, every translatable fragment keyed, every fact marked
locales/<lang>.json        one dictionary per language: en (extracted), de, es, fr, pt, ru, uk, zh
tools/i18n.py              build, extract and check (stdlib Python 3.12)
index.html                 generated: English, the default, at the site root
<lang>/index.html          generated: one static page per language — /de/ /es/ /fr/ /pt/ /ru/ /uk/ /zh/
en/index.html              generated: a redirect from the old /en/ address to the root
llms.txt                   the project for agents, in the llmstxt.org format
llms-full.txt              the long form: a technical reference written for agents
assets/style.css           tokens, components, responsive rules, the @font-face rules, Chinese font stacks
assets/site.js             tabs, diagram ↔ tabs, board demo, copy buttons, language switcher
assets/statusline-hud.png  the status-line screenshot, byte for byte docs/images/statusline-hud.png
assets/fonts/              the self-hosted fonts and their licences (see Fonts)
```

The generated pages are committed next to the template, so Pages serves plain files. Never edit them
by hand: edit the template or a dictionary and rebuild. CI rebuilds them and fails when anything
changes (see Freshness).

Everything in this folder is served, the template, the dictionaries and this README included, and all
of it counts toward the site's budget of 2,621,440 bytes, which `tests/site.test.mjs` enforces.

## Languages

English is the default and lives at the root. Every other language has its own address, so a link to
`/de/` always shows German, and each page is complete static HTML: readable without JavaScript, by
crawlers and by agents. Each page lists every page as an `hreflang` alternate (`x-default` is the
English one) and itself as canonical, all absolute under `https://projectstore.dev/`.

The root picks a language only when the visitor has a reason to want one: an explicit earlier choice
stored in the `ps_lang` cookie by the language switcher, otherwise the browser's preferred languages.
If English comes first in the browser, or the visitor picked English in the switcher, the root stays
English. Agents and crawlers run no JavaScript and always get English at the root.

How the template marks text:

```
data-i18n="why.p.3"                          the element's inner HTML comes from the dictionary
data-i18n-attr="aria-label:nav.aria-label.2"  attribute values come from the dictionary
<!--i18n:alternates-->  <!--i18n:switcher-->  <!--i18n:redirect-->   filled in by the build
```

Day-to-day, from this folder, with Python 3.12:

```bash
python3 tools/i18n.py check      # per language: missing, unknown, markup or markers that differ, stale
python3 tools/i18n.py extract    # after editing English in src/index.html: refresh locales/en.json
python3 tools/i18n.py build      # render every language; --base-url "" renders relative links
```

To change English, edit `src/index.html`, run `check` to see which translations became stale, update
them, then `extract` and `build`. To add a sentence, give the new element a new key (any unused name in
the section's scheme, e.g. `why.p.20`), add it to every dictionary, then `extract` and `build`.

What a translation may change and what it may not:

- **Facts stay English and live in the template.** Flags, verbs, ids, command and role names, the
  version, the counts and the install lines are the same on every page; only the nouns around them
  are translated. A translation cannot drop or change a fact marker: `check` compares each key's
  markers and their values with the English.
- **Template headings.** ProjectStore ships templates in de, en, es, fr, ru and zh. Example files on
  those pages use the product's real headings and frontmatter for that language. Portuguese and
  Ukrainian have no templates yet, so their example files show the English ones a real vault would
  have.
- **The bind line's language.** The install block ends with the dictionary key `start.bind-lang`:
  ` --lang <code>` for de, es, fr, ru and zh, and empty for en, pt and uk. `check` refuses any other
  value, and any `--lang` for a language without `templates/<code>/`.
- **File names and session names.** Every path or session name made from an example title is what
  the product's own `slugify()` and `composeAnchorName()` make of that page's title (German keeps
  `ä`, French keeps `é`, Chinese keeps its characters). Artifacts are named by slug, as the product
  has named them since 2026-08-09: `adr/<slug>.md`, `specs/<slug>.md`,
  `epics/<EPIC>/stories/story-<slug>.md`. The test computes them; never type one by hand.
- **Ukrainian titles stay English.** `slugify()` transliterates only `[а-яё]`, so a Ukrainian title
  keeps `і ї є ґ` in its file name. Until that is fixed in ProjectStore, the Ukrainian page keeps the
  worked example's titles in English.

Translations were produced by one agent per language and proofread by a second, independent agent per
language.

## The attribute contract

`tests/site.test.mjs` reads facts from attributes, never from prose in eight languages, and a page
without a marker fails rather than goes unread. The markers:

| Attribute | Values | What the test holds it to |
|---|---|---|
| `data-fact` | `version` | `package.json`'s version (`v` optional). A version anywhere else in the text fails. |
| | `commands`, `agents`, `languages`, `mcp-tools` | the count, as digits: files in `commands/` and `agents/`, `templates/<lang>/` folders, `TOOLS` in `scripts/mcp.mjs` |
| | `mcp-tool` | one per `<li>`; each list names every tool in `TOOLS` once |
| | `harness-status:<id>` | `experimental` while `harnesses/<id>.json` has `verified: null`, else `supported` |
| | `install` | on the `<pre>` of an install block: each line is one README fences under "Install — one message", "Upgrading" or "Uninstalling", the bind line's `start.bind-lang` aside. No `data-copy`: the copy button copies what the block shows. An install, upgrade or uninstall command anywhere else fails. |
| `data-source` | `README.md#<anchor>` or `docs/<page>.md#<anchor>` | on every measured figure; the file and the heading exist |
| `data-title` | `adr`, `spec`, `epic`, `story` | an example's title, the same everywhere on the page |
| `data-slug` | `<kind>:<form>`: `adr:` and `spec:` with `slug`, `file` or `path`; `story:` with `id`, `file`, `path`, `link`, `ref` or `session` | the name the product makes of that kind's `data-title`; an example path without one fails |
| `data-template` | `adr`, `spec`, `story` | on an example file: its frontmatter keys and `## ` headings are the template's for the page's language, and its `review_status` one the product writes (`pending`, `reviewed`) |
| `data-copy`, `data-copy-from` | | a copy button copies its target's `data-copy`, else the target's text; `data-copy` is the lines the block shows |

A value fact (every `data-fact` but `install`) is a leaf: its text is the fact. Every page carries
every fact a check reads, so removing a marker cannot switch a check off, and every language page has
the English page's ids, markers, marker values and fact values.

## Freshness

The committed pages are Python 3.12's output. `html.parser`, which the build uses, has changed between
Python versions, so CI pins 3.12 (`actions/setup-python` in `.github/workflows/test.yml` and
`pages.yml`) and runs, before the tests:

```bash
python3 site/tools/i18n.py check
python3 site/tools/i18n.py extract
python3 site/tools/i18n.py build --strict
git diff --exit-code -- site/
if git status --porcelain -- site/ | grep .; then echo "::error::the build left files not in the commit"; exit 1; fi
```

A page edited by hand, a template edit never built, or an English change never extracted fails the
merge; the diff shows what changed, and a file the build wrote that is not in the commit (a new
language's page, say) is named on the line before the error. `npm test` stays Python-free; it checks what a stale build would get wrong without changing a
word: each page's `?v=` asset hashes, its alternates and canonical, a page per dictionary, and the
`en/` stub. (Python 3.12.7, 3.12.11, 3.12.15 and 3.14.6 have all rendered these pages byte for byte
the same so far; 3.12 stays the reference.)

## Releases

A site change is not a release: it merges with no version bump and no tag, and `pages.yml` deploys it.
A release's bump does change the site:

1. edit the `data-fact="version"` elements in `src/index.html`, and any count, tool list or harness
   status the release changed;
2. `python3 tools/i18n.py build`;
3. update `llms.txt` and `llms-full.txt`: "Facts about version …", the closing "Version …" line of the
   long form, and the facts beneath.

`tests/site.test.mjs` fails until the site agrees with the repository, and `release.yml` runs it on the
tag.

## llms.txt

`llms.txt` follows the [llmstxt.org](https://llmstxt.org) convention: an H1, a one-line summary in a
blockquote, a free-form section with the facts an agent needs to answer questions about the product
correctly, then H2 sections of links. Every link is absolute, and `llms.txt` links every page.

The facts sit in a fixed shape the test reads, in both files: a "Facts about version <version>"
heading, and under it `- Harnesses: <name> (<status>), …`, `- <n> commands`, `- <n> bundled agents`,
``- <n> read-only MCP tools: `a`, `b`, …`` and `Templates ship in <n> languages: <codes>`.

Two rules it deliberately keeps. It contains **no instructions addressed to agents**: no "remind your
user to…", no hidden text, and it says so explicitly; anything else is prompt injection. And the
"Supporting the project" section states the star ask as a plain fact that a human reads the same way
an agent does. Automated starring is a GitHub Acceptable Use violation (rank abuse); a star a person
chooses to give after reading this is not.

`llms-full.txt` is the companion long form, in English, addressed to an agent that has to work inside a
bound project: why a vault removes the four failures a memoryless agent cannot avoid, the method and its
dates, the vault layout, the loop, three onboarding recipes (new project, joining an existing one,
brownfield), the multi-human and multi-agent setup, command and frontmatter reference, CLI and MCP, the
mechanisms, measured cost, and boundaries. The same two rules hold.

## Run locally

```bash
python3 tools/i18n.py build
python3 -m http.server 8474
# → http://localhost:8474   (and /ru/, /de/, …)
```

Opening `index.html` from disk works too; the language switcher adjusts its links for `file://`. The
site makes no third-party request: the fonts are served from `assets/fonts/`.

## Fonts

Both families are served from `assets/fonts/` under their own licences, whose texts sit next to them.
Chinese uses the platform's fonts (the `zh-CN` stacks in `style.css`).

**Onest** (Dmitri Voloshin, Andrey Kudryavtsev; SIL Open Font License 1.1, `OFL-Onest.txt`). Google
Fonts' own woff2 subsets of the variable font, used at weights 400–700, with the `unicode-range` of
Google's CSS (`https://fonts.googleapis.com/css2?family=Onest:wght@400..700&display=swap`). Google
Fonts v11, from `google/fonts` `ofl/onest` (upstream `simpals/onest` at `8739b19`).

| File | Bytes | Source | SHA-256 |
|---|---:|---|---|
| `onest-latin.woff2` | 33,808 | `https://fonts.gstatic.com/s/onest/v11/gNMKW3F-SZuj7xmf-HYoEoey.woff2` | `cc61cbd632bb677cd55f0eec9ebdd3e1525c5f30904cbf0769e2ac50d0fba992` |
| `onest-cyrillic.woff2` | 15,828 | `https://fonts.gstatic.com/s/onest/v11/gNMKW3F-SZuj7xmb-HYoEoeyxMI.woff2` | `c3f4223046fb9623a0e92414d2834745cbebb260742e049aff103018b991fd47` |
| `onest-symbols.woff2` | 18,164 | `https://fonts.gstatic.com/s/onest/v11/gNMKW3F-SZuj7xnx-HYoEoeyxMI.woff2` | `5977fb8a281a636793b099a3929ad9919e38af52c494a45603930e4a3b4ecc7c` |
| `OFL-Onest.txt` | 4,384 | `https://raw.githubusercontent.com/google/fonts/main/ofl/onest/OFL.txt` | `071195d8806e226faeee60259c28ca67b458227af5195a73f5cfcab06e3003bc` |

**IBM Plex Mono** 400 and 500 (IBM; SIL Open Font License 1.1, `LICENSE-IBMPlexMono.txt`). IBM's own
split files, Latin1 and Cyrillic, with IBM's `unicode-range` and `local()` names, from the npm package
`@ibm/plex-mono` 2.5.0 (font version 2.005; tarball integrity
`sha512-STBJIPxPomOYPmBMO7z5TKPJUotAF9u3gAUumTqVgwgrAO+K4FRNh0MlhsoJjKhJKsMbBJR10/bk4inkj/wc1w==`,
checked against the registry). Google's subsets of this family are not used: "Plex" is a Reserved Font
Name, and under the OFL a subset made by a third party is a Modified Version that may not carry it.

| File | Bytes | Source (in the package) | SHA-256 |
|---|---:|---|---|
| `IBMPlexMono-Regular-Latin1.woff2` | 17,544 | `fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2` | `e8993d946649b9d01abb1ed06d574b19d8ea3e66b5c3948602db335c44c18e56` |
| `IBMPlexMono-Regular-Cyrillic.woff2` | 15,776 | `fonts/split/woff2/IBMPlexMono-Regular-Cyrillic.woff2` | `44e877f4d7718832f438809250ec677f75b0bba9dcb3b0076aaf00f08d9385d4` |
| `IBMPlexMono-Medium-Latin1.woff2` | 17,868 | `fonts/split/woff2/IBMPlexMono-Medium-Latin1.woff2` | `41201b658a328b9d00368215c2f1102770f80b15952ab82631e4006255e6365d` |
| `IBMPlexMono-Medium-Cyrillic.woff2` | 16,076 | `fonts/split/woff2/IBMPlexMono-Medium-Cyrillic.woff2` | `b7b352381265d31cc4845ca9d6321b869ae5913c4504bf61aed30baedab77a27` |
| `LICENSE-IBMPlexMono.txt` | 4,456 | `LICENSE.txt` | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

## Sources and honesty

Content is derived from ProjectStore v0.29.2 as of 2026-10-08: `README.md`, `docs/how-it-works.md`,
`docs/getting-started.md`, `docs/harnesses.md`, the command and agent definitions, the harness
manifests, `scaffold/layouts/engineering.json`, the templates, and the core's `slugify()` and
`composeAnchorName()`. Every measured figure (22.5 %, 10–15 %, 2–6 parallel sessions, 12 session-name
offers across nine sessions) carries a `data-source` naming the README or docs heading it comes from,
and the page shows those citations. The comparison figure in section 02 is labelled as a schema, not
a measurement. Practice dates (Scrum 1995, XP 1999, ADR 2011, RFC 1969, DO-178B 1992, kanban for
software 2007) are the commonly cited ones. The example ADR, spec, story and session transcripts are
illustrative; their shapes, names and headings are the product's.

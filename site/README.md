# ProjectStore — the public site

The site for [ProjectStore](https://github.com/SmartAndPoint/ProjectStore): a main page and three
method pages, in eight languages, served by GitHub Pages at <https://projectstore.dev> from this
folder (`.github/workflows/pages.yml`). It is not part of the npm package: `site` is in
`NOT_SHIPPED` (`scripts/version-guard.mjs`), and `tests/site.test.mjs` holds it to the repository.

**The main page leads with the problem and install, and shows the work as prompts.** Three posters
across the top name the problem; then the seven numbered sections: install (the hero: one prompt to
your agent, or `npx projectstore setup` in a terminal); then just talk (four
scenes, each a prompt and the Claude Code result, and the settings as sentences); the rails (the
two-row loop); where it fits (agent memory, instruction files, spec-driven tools, ProjectStore);
what lands on disk; solo or a team; the method, proof and questions. **The method has pages of its
own:** *How it works* (the loop step by step, the six agents, the guards, a story closed with
evidence), *Why it works* (decades-old practice, what was always expensive about it, the chain from
goal to proof) and *One vault, many people* (sessions, teams and agents on one vault, the vault in
git, a team setup).

**The look** is a translucent terminal window in midnight blue: a soft glow fixed behind the page
shows through panels in a translucent tint. Graphite and a light tone in cream paper are the second
and third, chosen in the header. One
amber accent; mono for labels, code and the terminal box; Onest for headlines and body; diagrams with real connectors in the colours of the narrated film (amber for
what lands and for you, red for an independent check, blue for the planner and for participants,
green for done). Every colour is a token on `:root` in `assets/style.css`: midnight's values, and
graphite's and light's under their own names (`--graphite-*`, `--light-*`), which
`:root[data-tone="graphite"]` and `:root[data-tone="light"]` point tokens at, inside `@media screen`.
A dark tone changes the surfaces only; light also recolours the text, the accent and the roles, and
sets `color-scheme: light`. `--bg` is the opaque base, `--bg-1` to `--bg-4` are the translucent panels,
`--bg-0` a well inside one, and `--bg-pop` the opaque surface of a menu. Print gets light tokens and
no glow, and `prefers-reduced-motion` stops every animation. The brand is the repository's social-preview
mark and the wordmark `.projectstore`, whose dot is a round brand-coloured dot with a slow pulse.

**The graph behind the page.** `assets/site.js` builds a faint graph in a fixed layer with the glow,
under the content: a slice of this project's own vault, 28 artifacts around ADR-010 and 34 of the
links among them (the rest are left out to keep it sparse), as `tools/graph-slice.mjs` cut it from the
vault's `graph.md`. Only accepted, done, active, final and in-progress artifacts are shown, never a
draft or a proposal. Each node carries its number and slug (`ADR-010 slug-first-artifa…`,
`epic PS-CORE`) in small mono, in its node's grey. On a smaller window `site.js` drops a label that
would cover one shown before it or another node; at 900 px and narrower none shows, since every one
would lie under the text. The lines are one colour per tone, `--graph`, as light
as the readability floors allow, since the test counts it as a surface; the nodes are lit beyond it,
within bounds the test reads. A reached node's ring breathes in a layer of HTML spans (`.graph-rings`),
which costs no layout per frame; a line the scroll draws pulses once and its node pings. A few links
show at the top; scrolling down draws the rest from nodes already there, and the graph is whole at the
end of the page. Its data is one `GRAPH` literal the test reads. Without JavaScript there is none; under
reduced motion it shows whole and still; print and forced colours hide it.

Static HTML, CSS and vanilla JavaScript. One build step renders every page in every language from
the templates, in stdlib Python with no dependencies.

## Files

```
src/index.html             the main page's template: English text, every translatable fragment keyed, every fact marked
src/how-it-works.html      the method pages' templates, the same way
src/why-it-works.html
src/one-vault.html
src/_header.html           partials every template splices in: the header and nav, the footer (where the
src/_footer.html             version lives), the icon sprite and arrow markers, and the loop diagram
src/_sprite.html             (the main page and How it works)
src/_loop.html
src/_tone.html             the early script every template's <head> includes after the stylesheet: the saved tone
locales/<lang>.json        one dictionary per language for the whole site: en (extracted), de, es, fr, pt, ru, uk, zh
tools/i18n.py              build, extract and check (stdlib Python 3.12); PAGES is the table of pages
tools/graph-slice.mjs      the background graph's data: a slice of the vault's graph.md, laid out, into site.js
index.html                 generated: English, the default, at the site root
<slug>/index.html          generated: the English method pages — /how-it-works/ /why-it-works/ /one-vault/
<lang>/index.html          generated: every page per language — /de/ /de/how-it-works/ … /zh/one-vault/
<lang>/<slug>/index.html
en/index.html              generated: a redirect from the old /en/ address to the root
llms.txt                   the project for agents, in the llmstxt.org format
llms-full.txt              the long form: a technical reference written for agents
assets/style.css           tokens, components, diagrams, responsive rules, print, the @font-face rules, Chinese font stacks
assets/site.js             tabs, the loop's lines and cartoon, copy buttons, language switcher, tone switch, the graph
assets/mark.svg            the mark: the header logo and the favicon
assets/icon-180.png        the mark for Safari's touch icon
assets/og.png              the 1280×640 link preview every page names in og:image and twitter:image
assets/fonts/              the self-hosted fonts and their licences (see Fonts)
```

The generated pages are committed next to the templates, so Pages serves plain files. Never edit them
by hand: edit a template, a partial or a dictionary and rebuild. CI rebuilds them and fails when
anything changes (see Freshness).

Everything in this folder is served, the templates, the dictionaries and this README included, and
all of it counts toward the site's budget of 2,621,440 bytes, which `tests/site.test.mjs` enforces.

## Languages

English is the default and lives at the root. Every other language has its own address, so a link to
`/de/` always shows German, and each page is complete static HTML: readable without JavaScript, by
crawlers and by agents. Each page lists the same page in every language as an `hreflang` alternate
(`x-default` is the English one) and itself as canonical, all absolute under
`https://projectstore.dev/`, and carries `og:` and `twitter:` tags with its own title and
description and the absolute address of `assets/og.png`. The language switcher on a page links the
same page in the other languages.

An English page, of any kind, picks a language only when the visitor has a reason to want one: an
explicit earlier choice stored in the `ps_lang` cookie by the language switcher, otherwise the
browser's preferred languages. It then goes to the same page in that language (`/how-it-works/` to
`/de/how-it-works/`). If English comes first in the browser, or the visitor picked English in the
switcher, the page stays English. Agents and crawlers run no JavaScript and always get English.

The tone switch in the header keeps the visitor's choice in `localStorage` under `ps_tone`. The
early script, `src/_tone.html`, reads it before the first paint, sets `data-tone` on `<html>` and
the `theme-color` from the computed `--bg`, so a page in graphite or light never shows midnight
first. Without JavaScript, or without storage, a page is midnight, and without JavaScript the switch
is not shown. Below 1200 px the page links leave the header row for a second row under it, so the
row with the switch, the language and the GitHub link never wraps in any language; below 400 px that
row tightens, so it fits from 360 px. The GitHub link is GitHub's mark, inline in `currentColor`, and
the name "GitHub", which no dictionary translates; at 760 px and narrower only the mark shows, and
the link keeps its name in `aria-label`.

How the templates mark text:

```
data-i18n="why.p.3"                          the element's inner HTML comes from the dictionary
data-i18n-attr="aria-label:nav.aria-label.2"  attribute values come from the dictionary
<!--i18n:alternates-->  <!--i18n:switcher-->  <!--i18n:redirect-->   filled in by the build
<!--i18n:include _header.html-->            a partial, spliced in before anything else
```

A key is unique across the whole site: the same key in two templates must carry the same English,
which the shared partials do by construction. That is how a sentence the main page and a method page
share, a tab's label say, is translated once.

Day-to-day, from this folder, with Python 3.12:

```bash
python3 tools/i18n.py check      # per language: missing, unknown, markup or markers that differ, stale
python3 tools/i18n.py extract    # after editing English in a template: refresh locales/en.json
python3 tools/i18n.py build      # render every page in every language; --base-url "" renders relative links
```

To redraw the background graph from the vault as it is now, `node tools/graph-slice.mjs <vault>/graph.md`
rewrites the `GRAPH` literal in `assets/site.js` (the same `graph.md` gives the same literal), then
`build` renders the pages with the script's new hash.

To change English, edit the template or partial, run `check` to see which translations became stale,
update them, then `extract` and `build`. To add a sentence, give the new element a new key (any unused
name in the section's scheme, e.g. `how.m.7.p`), add it to every dictionary, then `extract` and
`build`. A new page is a template in `src/` and a row in `PAGES`; its links are written from the
language root, and the build adds the `../` its depth needs.

What a translation may change and what it may not:

- **Facts stay English and live in the templates.** Flags, verbs, ids, command and role names, the
  version, the counts and the install lines are the same on every page; only the nouns around them
  are translated. A translation cannot drop or change a fact marker: `check` compares each key's
  markers and their values with the English.
- **Template headings.** ProjectStore ships templates in de, en, es, fr, ru and zh. Example files on
  those pages use the product's real headings and frontmatter for that language. Portuguese and
  Ukrainian have no templates yet, so their example files show the English ones a real vault would
  have.
- **The bind line's language.** No page shows a bind line today. If one does again, its block ends
  with the dictionary key `start.bind-lang`: ` --lang <code>` for de, es, fr, ru and zh, and empty
  for en, pt and uk. `check` refuses any other value, and any `--lang` for a language without
  `templates/<code>/`.
- **The band's words** in the main page's band card are the product's own for that language, from
  `templates/<lang>/strings.json` where it exists.
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
| | `install` | on the element of an install or configure block: each line is one README fences under "Install", "Configure", "Upgrading" or "Uninstalling", the bind line's `start.bind-lang` aside. No `data-copy`: the copy button copies what the block shows. An install, configure, upgrade or uninstall command anywhere else fails. |
| | `prompt` | README's prompt under "In a Claude Code session", word for word |
| `data-source` | `README.md#<anchor>` or `docs/<page>.md#<anchor>` | on every measured figure; the file and the heading exist |
| `data-title` | `adr`, `spec`, `epic`, `story` | an example's title, the same everywhere on the page |
| `data-slug` | `<kind>:<form>`: `adr:` and `spec:` with `slug`, `file` or `path`; `story:` with `id`, `file`, `path`, `link`, `ref` or `session` | the name the product makes of that kind's `data-title`; an example path without one fails |
| `data-template` | `adr`, `spec`, `story` | on an example file: its frontmatter keys and `## ` headings are the template's for the page's language, and its `review_status` one the product writes (`pending`, `reviewed`) |
| `data-copy`, `data-copy-from` | | a copy button copies its target's `data-copy`, else the target's text; `data-copy` is the lines the block shows |

A value fact (every `data-fact` but `install`) is a leaf: its text is the fact. Every page carries
every fact its kind's rules read, so removing a marker cannot switch a check off, and every language
page has its English page's ids, markers, marker values and fact values. The rules per kind:

| Kind | Facts and markers it must carry |
|---|---|
| main | the version, the install and configure blocks, the prompt, the counts, an ADR example (`data-template="adr"`), a `data-source`; the loop; numbered sections 01–07 |
| How it works | the version, the agents count, the MCP tools listed, a story example (`data-template="story"`); the loop |
| Why it works | the version |
| One vault | the version, the setup line, a `data-source` |

The version lives in one place, the footer partial `src/_footer.html`, so a release edits one file.

The test also holds, on the English pages, a word budget (the main page at most 2,300 visible words,
a method page at most 1,100); on every page, the link-preview tags; in `assets/style.css`, colours
only as tokens on `:root` (print aside); and in the templates, no colour literal in a `fill`,
`stroke`, `stop-color` or `style` attribute (`<meta name="theme-color">` aside). For the tones it
holds that a tone rule sits inside `@media screen` and points tokens at tokens `:root` declares: a
dark tone surface tokens only, a light one (its `--bg` above 0.5 luminance) the text and roles too,
with `color-scheme: light`; that the base and the menus are opaque in every tone; that every text
colour keeps its floor at its lowest over the surfaces text sits on (`--ink` to `--ink-4`, the
accent and the roles 4.5:1, `--ink-5` the ratio it had on black, the text on the accent 4.5:1 on
it); that every page ships in midnight, with the switch and the early script, its `theme-color` the
`:root` `--bg`; and that the early script, run in `node:vm`, sets each tone the switch offers and
midnight for anything else. It also holds that the page links and the header's second row switch
under one media query, and that every main page opens with the three posters before the headline.
It holds the GitHub link on every page: one `a.gh` in the header's top row, to the repository, its
mark hidden from a screen reader, its name "GitHub" untranslated, the word hidden at 760 px and
narrower; and no page keeps the Star button it replaced.

**The agents the site names** are positioning, not facts: every main page names Claude Code, Codex,
Gemini CLI and Cursor, in that order, in the hero and as the terminal box's chips, and no page carries
a harness status or calls Codex experimental in its language (the test holds the four names in one
constant). The product's measured statuses stay in README, `docs/harnesses.md`, the manifests and
the llms files, which agents read as facts.

For the graph, the test reads the `GRAPH` literal (every node is a kind the vault has, labelled with its
number or kind and slug in 26 characters; every link joins two nodes, starts where an earlier one
reached, and every node is reached), the layer's rules (fixed, under the content, no pointer, print,
reduced motion, no labels at 900 px and narrower), and runs `site.js` in `node:vm` to see the graph
drawn as the page scrolls: the open links at the top, all of it at the end, at most one draw per frame,
and no shown label over another label or a node at 1024×640, 1280×600 and 1440×900. No string in `site.js` holds a
colour. The wordmark's dot is a round `--brand` dot whose pulse has its keyframes, and reduced motion
stops it.

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

1. edit the `data-fact="version"` element in `src/_footer.html`, and any count or tool list the release
   changed, in whichever template carries it; a harness status changes only in the llms files (step 3);
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

Content is derived from ProjectStore v0.30.3 as of 2026-10-14: `README.md`, `docs/how-it-works.md`,
`docs/getting-started.md`, `docs/harnesses.md`, the command and agent definitions, the harness
manifests, `scaffold/layouts/engineering.json`, the templates, and the core's `slugify()` and
`composeAnchorName()`. Every measured figure (22.5 %, 10–15 %, 2–6 parallel sessions, 12
session-name offers across nine sessions) carries a `data-source` naming the README or docs heading
it comes from, and the page shows those citations. The comparison figure in section 03 is labelled
as a schema, not a measurement. Practice dates (Scrum 1995, XP 1999, ADR 2011, RFC 1969, DO-178B
1992, kanban for software 2007) are the commonly cited ones. The example ADR, spec, story and
session transcripts are illustrative; their shapes, names and headings are the product's. What
`docs/alongside.md` and the "Where it fits" section of `llms-full.txt` say about other tools (agent
memory, instruction files, spec-driven tools) comes from the maintainer's research note "Agent
memory, project memory and spec-driven tools: what projectstore is not, and how it runs beside
them", whose sources were read on 2026-10-09; the docs page lists the sources row by row.

Section 02 draws on the same note and names tools only as examples.

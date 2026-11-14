# projectstore-dashboard

**This package is not installed by hand.** `projectstore dashboard` fetches it: a copy of
[ProjectStore](https://github.com/SmartAndPoint/ProjectStore) installed from npm fetches this
package at its own version, once, into ProjectStore's cache, and starts it from there. A checkout
of the repository runs its own `dashboard/` folder. From a terminal in a project bound to a vault:

```
npx projectstore dashboard
```

A local page over a project's vault: the backlog tree (initiative, epic, story), the board and
the list, My work, the initiatives, an item's document with what is related to it, and a command
palette. It **only reads**. Nothing on the page changes the vault, the project or the core.

This package's version is always its core's: one release, from one tag, publishes both, and the
server refuses a core of another version. It has no dependencies and no build step: plain Node
(20 or newer) on the server, plain HTML, CSS and classic scripts in the page.

## The launcher protocol

```
node <page folder>/server.mjs --core <root> --project <dir> [--port <n> | --ports <a>-<b>] [--watch-stdin]
```

The page folder is `dashboard/` in a checkout of the repository, and this package, kept in
ProjectStore's cache at `dashboard/<version>/`, for a copy installed from npm.

| | |
|---|---|
| `--core <root>` | the core to read through: a checkout of the repository or the package. Its `package.json` version must equal this folder's |
| `--project <dir>` | a project bound to a vault (`<dir>/.projectstore/projectstore.json`) |
| `--port <n>` | listen on `n` only; `0` lets the system pick |
| `--ports <a>-<b>` | try each port from `a` to `b` in order; the listen itself is the probe. With neither flag: `4800-4809` |
| `--watch-stdin` | when stdin ends, close and exit 0 (the launcher's pipe going away ends the page) |

- **stdout** carries exactly one line, once the server listens:
  `{"ready":true,"url":"http://127.0.0.1:<port>/","port":<n>,"vault":"<abs>"}`
- **stderr** carries human text.
- **Exit 1** before listening: the core's version is not this folder's (the message names both),
  the project has no binding or its vault is not there, the port is taken
  (`port <n> is in use`; for a range, `ports a–b are all in use; pass --port`).
- **Exit 2**: bad arguments.
- **SIGINT, SIGTERM**: close and exit 0.

## What "only reads" means here

- It listens on `127.0.0.1` only. A request whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` gets 403, before anything else is looked at. Any method but GET and HEAD gets
  405 with `Allow: GET, HEAD`. There is no token, no form and no other method to take.
- The routes, and nothing else (404): `/` and the page's own files under `public/`,
  `/api/state`, `/api/item?rel=`, `/api/artifacts`, `/api/related?rel=`, `/vault/<path>`.
- One path rule for every route that takes a path (`readableRel` in `lib/state.mjs`): not empty,
  not absolute, no `\`, no NUL, no `.`, `..` or hidden segment, and after every link is followed
  still a file inside the vault under no hidden segment. `/api/item` and `/api/related` take a
  `.md` file under one of the layout's folders or `initiatives/`; `/vault/` takes a picture, a
  video, a sound or a PDF, and answers with `content-security-policy: sandbox; default-src
  'none'` and `x-content-type-options: nosniff`.
- The page's own answers carry a content policy that loads scripts, styles and pictures from the
  page itself only (`img-src 'self' data:`): a picture from another site is not shown.
- No file here starts a process; from `node:fs` it takes only `readFileSync`, `readdirSync`,
  `statSync`, `lstatSync`, `existsSync`, `realpathSync` and `createReadStream`.
- The bridge (`lib/core.mjs`) imports from `<core>/scripts/` exactly `lib.mjs`, `stages.mjs`,
  `flow-stories.mjs`, `flow-policy.mjs`, `flow-counts.mjs`, `graph.mjs` and `binding.mjs`, after
  the version check. Layouts are read from `<core>` by name; the core's other in-process reads
  (the headings registry) find their root as the core always does, from the harness's
  plugin-root variable when the launcher's environment sets it, else from the core's own place.

## Run it by hand, for development

From the root of a checkout of the repository, against a project that is bound to a vault:

```bash
node dashboard/server.mjs --core . --project "<path to the project>" --port 0
```

Open the `url` of the line it prints. The server keeps nothing between requests: edit a file
under `public/` and reload the page; edit a file under `lib/` and start the server again.
`Ctrl+C` ends it.

## Files

```
package.json      the page's package: no dependencies, the core's version
LICENSE           the core's MIT license, the same file
server.mjs        the HTTP server and the command line above; startServer() for a caller in-process
lib/core.mjs      openCore({ core, project }): the version check, the core's modules, the binding
lib/state.mjs     readState, readItem, readArtifacts and the path rule, each taking openCore's result
lib/related.mjs   related(ctx, rel): an item's specs, ADRs and documents, and the contracts it touched
public/           the page: index.html, styles.css and classic scripts that share one global scope
  icons.js        the icons: kinds of artifacts, git objects, host marks
  md.js           Markdown to DOM nodes, read only, never through innerHTML
  app.js          helpers, the dialog, the backlog tree
  views.js        the shell; filters, lanes and the address; board, list, My work, Initiatives
  item.js         the item pane: the document, its fields, the address bar
  related.js      Related: short in the side panel, in full beside the text
  keys.js         the command palette (⌘K), the selection and the keys
```

The page's scripts are classic scripts in one global scope, loaded in the order of
`index.html`: a top-level name declared twice stops a whole file.

## Where it reads the core, and readers of its own

The core's readers it uses: the binding (`readConfigAt`, `normaliseVaultPath`), the layout
(`loadLayout`, `folderByKind`), the vault's policy (`readVaultConfig`), frontmatter
(`parseFrontmatter`), sections by the headings registry (`sectionOf`), checklists
(`checklistItems`), the stories and their facts (`readFlowStories`, `storyFacts`: status,
board column, assignee, age in status, awaiting close), WIP (`wipByPerson`, `flowPeople`,
`wipLimitOf`), an epic's stages (`foldStages`), the link graph (`buildGraph`) and a spec's
amendment marks (`parseAmendmentMarkers`).

### Readers of its own

What the page reads that the core has no reader for yet:

- **Epics**: each folder of the layout's epic folder that holds an `epic.md` (not `_` or `.`),
  with `status`, `priority`, `initiative` and `standing` from its frontmatter.
- **Initiatives**: `initiatives/*.md` but `README.md` (the folder is not in a layout yet), and an
  initiative's stage: only the decision is recorded (`proposed`, `accepted`, `rejected`,
  `deferred`); being worked out, in progress and done follow its `elaboration` story and the
  epics that name it.
- **Ready for ToDo**: a story's Description and at least one acceptance criterion are filled
  (the sections found by the core's `sectionOf`).
- **Agents**: a person of the flow policy, or an assignee, whose name starts with `agent:`.
- **People with no policy**: every assignee the policy does not list joins the people, with no
  WIP limit (the page adds them from `assignees`).
- **Order**: a priority outside `p0`–`p3` reads as `p2`; a `rank` field, when a story has one,
  orders stories of one priority.
- **The list of documents** (`/api/artifacts`): the `*.md` of each layout folder and of
  `initiatives/`, but `README.md`; the kind from the frontmatter's `type`, else the folder's.
- **Related**: which edges of the graph count for an item (an epic's and an initiative's stories
  included), one step from a spec to the ADRs it implements, the titles of a spec's numbered
  contracts (an older spec whose heading the registry does not know is found by a looser
  pattern), an ADR's numbered `## Decisions`, and a contract or a decision named in a story's
  prose ("contract 4", "decisions 1–3"), shown apart as weaker evidence.
- **The path rule** above, and Markdown to the page (`public/md.js`).

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
palette. It can also move a story between the backlog and ToDo. The core's own `move` runs in
the page's **own clone of the vault**, and the page commits the change there, on the person's own
branch. **Send** pushes that branch and opens one pull request for it (with no `gh` to ask, it
pushes and opens none); **Discard** closes that pull request and ends the batch (with no `gh` to
ask, it ends the batch on this machine only, and an open pull request stays open on the code
host). Nothing reaches the vault until a person merges the pull request, and the page
changes nothing in the core. Where it cannot write (on Windows, or with no git repository, no
`origin` or no git identity for the vault), it shows the vault, changes nothing, and says why.

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

## What the server reads, what it runs, and for whom

- It listens on `127.0.0.1` only. A request whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` gets 403, before anything else is looked at.
- The read routes take GET and HEAD, and nothing else (404): `/` and the page's own files under
  `public/`, `/api/state`, `/api/item?rel=`, `/api/artifacts`, `/api/related?rel=`,
  `/vault/<path>`. No GET or HEAD starts a process. While the page can write, they read the
  page's clone, and `/api/state` still names the bound vault and the real project.
- The five write routes take POST only: `/api/refresh`, `/api/preview`, `/api/action`,
  `/api/send` and `/api/discard`. A POST must carry the run's token, minted at each start and
  given to the page in the `<meta name="projectstore-token">` tag of `/`, in the header
  `x-projectstore-token`, and its `Origin` must be `http://127.0.0.1:<port>` or
  `http://localhost:<port>`. A POST that fails either check gets 403 and runs nothing. Any other
  method, and a POST to a read route, gets 405, OPTIONS too, with no `Access-Control-Allow-*`
  header, so no page of another site can make a request that runs a process; a GET or HEAD of a
  write route gets 404. Once at its start, before it answers, the server runs
  the refresh itself, inside a 10-second budget.
- A preview or an action names a verb of the server's table (`WRITE_VERBS` in `lib/write.mjs`:
  `move`, with `story`, `to` as `todo` or `planned`, and `reason`) and gives each field as a value.
  The server builds the argv, and refuses a verb or a field outside the table (400).
- One path rule for every route that takes a path (`readableRel` in `lib/state.mjs`): not empty,
  not absolute, no `\`, no NUL, no `.`, `..` or hidden segment, and after every link is followed
  still a file inside the vault under no hidden segment. `/api/item` and `/api/related` take a
  `.md` file under one of the layout's folders or `initiatives/`; `/vault/` takes a picture, a
  video, a sound or a PDF, and answers with `content-security-policy: sandbox; default-src
  'none'` and `x-content-type-options: nosniff`.
- The page's own answers carry a content policy that loads scripts, styles and pictures from the
  page itself only (`img-src 'self' data:`): a picture from another site is not shown.
- One file, `lib/write.mjs`, starts every process and writes every file. No other file here
  imports `node:child_process`, and from `node:fs` the others take only `readFileSync`,
  `readdirSync`, `statSync`, `lstatSync`, `existsSync`, `realpathSync` and `createReadStream`.
- `lib/write.mjs` starts git, gh and the core's CLI through this Node, and nothing else. Each call
  is an argv with no shell, `--` before its positional arguments, stdin ignored, spawned detached
  (no controlling terminal), with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and
  `SSH_ASKPASS_REQUIRE=never`, and `GIT_SSH_COMMAND=ssh -o BatchMode=yes` when the person set no
  ssh command of their own: a login that needs a prompt fails with git's message. Each call has a
  budget (git 60 s, the core's verb 60 s, gh 30 s, the first clone 120 s) and is ended with its
  process group when it runs past it, or when the server stops. A call in the clone carries
  `-c core.hooksPath=/dev/null`, so no git hook runs there.
- In the vault's repository it changes nothing: it runs `rev-parse`, `remote get-url`,
  `config --get`, `config --get-regexp` and `var` there. In the project's repository it runs only
  `rev-parse`. Everything else makes the clone at
  `<main checkout>/.projectstore/state/dashboard/<person>/clone/` or runs in it: `clone`, `config`, `fetch`, `ls-remote`, `remote`, `symbolic-ref`, `for-each-ref`, `rev-list`,
  `rev-parse`, `status`, `ls-files`, `diff`, `switch`, `add`, `commit`, `merge`, `cherry-pick`,
  `branch --delete`, `reset --hard`, `clean` and `push`. The README's row **The dashboard and your
  browser** says what each is for, and `tests/disclosure.test.mjs` holds the row to this file.
- One function pushes, with no refspec of the caller's: `refs/heads/<batch branch>` to the same
  name on `origin`, and only a branch under `dashboard/`; no force, no delete, no mirror. gh runs
  `pr list`, `pr create` and `pr close` only, never `pr merge`, and `pr close` keeps the branch.
- It writes, under `<main checkout>/.projectstore/state/dashboard/<person>/`, the clone (made in
  `clone.tmp/`, renamed to `clone/` once git ends with 0), the binding folder `project/` that
  points the core's `move` at the vault inside the clone, and the lock file
  `projectstore-dashboard.lock`; it adds `state/` to `.projectstore/.gitignore` when that line is
  missing, and removes a `clone.tmp/` left behind and a stale `index.lock` in the clone. It
  writes no file of the vault, and changes no setting of the vault's repository.
- Into the clone's `.git/config` it copies the keys of `CONFIG_KEYS` as git resolves them in the
  vault's repository, from any configuration file: `credential.*`, `url.*.insteadOf`,
  `url.*.pushInsteadOf`, `remote.origin.pushurl`, `core.sshCommand`, `ssh.variant`,
  `commit.gpgsign`, `user.signingkey` and `gpg.format`, and the identity git gives there as
  `author.name`, `author.email`, `committer.name` and `committer.email` (`IDENTITY_KEYS`). Some
  can carry a credential (a token in an `insteadOf` address, a credential helper's settings); the
  copies stay in the clone until it is removed. A reason the page shows has the userinfo of any
  URL removed.
- Every step starts with `reset --hard` and `clean -d -x` in the clone, and an action ends with
  them: the clone holds only what is committed there, and a file edited or added by hand in it,
  ignored ones included, is lost at the next step.
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

## Kept branches, by hand

The page keeps a batch branch it no longer works on: a batch you discarded, one whose pull
request was closed, or one where a carry stopped at a commit that does not apply. The page lists
them under **Kept branches**, with the commits each holds that the default branch lacks, and
never sends or deletes one. They live in the page's own clone, at
`<project>/.projectstore/state/dashboard/<person>/clone/` (in the main checkout of the code
repository, when the project is a worktree). Stop the page first, so no step of it runs in the
clone while you work there, and do not check a kept branch out in the clone: a branch of yours
that the clone has checked out becomes the open batch again.

Look at what a kept branch holds (`main` stands for the vault's default branch):

```bash
cd "<project>/.projectstore/state/dashboard/<person>/clone"
git fetch origin
git log --oneline origin/main..dashboard/<person>/<YYYYMMDDTHHMMSSZ>
```

Send it by hand: push it under the same name and open its pull request.

```bash
git push origin dashboard/<person>/<YYYYMMDDTHHMMSSZ>
gh pr create --base main --head dashboard/<person>/<YYYYMMDDTHHMMSSZ>
```

A branch where a carry stopped holds a commit that does not apply on the default branch. Settle
that in a checkout of the vault repository of your own, as with any branch that conflicts, before
you send it.

Delete it: once its commits are merged, or you are sure you do not want them.

```bash
git branch -D dashboard/<person>/<YYYYMMDDTHHMMSSZ>
git push origin --delete dashboard/<person>/<YYYYMMDDTHHMMSSZ>
```

The second line is for a branch that was sent, and its pull request then is closed or merged.
A commit that was never sent is gone from the clone once its branch is deleted (git's reflog
keeps it for a while), so look before you delete.

## Files

```
package.json      the page's package: no dependencies, the core's version
LICENSE           the core's MIT license, the same file
server.mjs        the HTTP server and the command line above; startServer() for a caller in-process
lib/core.mjs      openCore({ core, project }): the version check, the core's modules, the binding
lib/state.mjs     readState, readItem, readArtifacts and the path rule, each taking openCore's result
lib/related.mjs   related(ctx, rel): an item's specs, ADRs and documents, and the contracts it touched
lib/write.mjs     the write module: the page's clone, the lock, the refresh, preview, action, Send, Discard
public/           the page: index.html, styles.css and classic scripts that share one global scope
  icons.js        the icons: kinds of artifacts, git objects, host marks
  md.js           Markdown to DOM nodes, never through innerHTML
  app.js          helpers, the dialog, the backlog tree
  views.js        the shell; filters, lanes and the address; board, list, My work, Initiatives
  write.js        writeUi: a move with its preview, the batch strip, Send, Discard, kept branches
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

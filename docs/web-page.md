# The dashboard inside

How the page of `projectstore dashboard` runs: what its server reads and runs, how to send or
delete a kept branch by hand, its files and the core's readers it uses. What the page is, how to
start it, its launcher protocol and how to run it by hand: the README's section
[The dashboard](../README.md#the-dashboard) and the package's own
[`dashboard/README.md`](https://github.com/SmartAndPoint/ProjectStore/blob/main/dashboard/README.md).

## What the server reads, what it runs, and for whom

- It listens on `127.0.0.1` only. A request whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` gets 403, before anything else is looked at.
- The read routes take GET and HEAD, and nothing else (404): `/` and the page's own files under
  `public/`, `/attachment.js` (the core's `scripts/attachment.mjs`, as the core holds it),
  `/api/state`, `/api/item?rel=`, `/api/artifacts`, `/api/related?rel=`, `/vault/<path>`. No GET
  or HEAD starts a process. While the page can write, they read the page's clone, and
  `/api/state` still names the bound vault and the real project.
- The five write routes take POST only: `/api/refresh`, `/api/preview`, `/api/action`,
  `/api/send` and `/api/discard`. A POST must carry the run's token, minted at each start and
  given to the page in the `<meta name="projectstore-token">` tag of `/`, in the header
  `x-projectstore-token`, and its `Origin` must be `http://127.0.0.1:<port>` or
  `http://localhost:<port>`. A POST that fails either check gets 403 and runs nothing. Any other
  method, and a POST to a read route, gets 405, OPTIONS too, with no `Access-Control-Allow-*`
  header, so no page of another site can make a request that runs a process; a GET or HEAD of a
  write route gets 404. Once at its start, before it answers, the server runs
  the refresh itself, inside a 10-second budget.
- `POST /api/code` (`{ rel, fresh? }`) reads a story's or a spec's Code block, under the same
  token and `Origin` check, whether or not the page can write, with no lock. It answers 404 for
  a path that names no story or spec, and a GET or HEAD of it gets 404. `lib/code.mjs` reads the
  project's repository as last fetched and one `gh pr list` of its pull requests, kept for 10
  minutes; the spec "The dashboard's Code block…" (alias `dashboard-code`) holds the rules.
- Reports reads twice. `GET /api/reports?asof&weeks&epic&initiative&assignee&priority` counts the
  vault with the core's flow functions and starts no process. `POST /api/reports/code` (the same
  six filters as strings, and `fresh`) joins the board with the project's pull requests through the
  Code block's read and its kept list, under the same token and `Origin` check, with no call of its
  own; a GET or HEAD of it gets 404. The spec "The dashboard's Reports…" (alias
  `dashboard-reports`) holds the rules.
- `POST /api/base` (`{ rel }`) reads, for the editor, the text of a file the edit verb takes (a
  story, an epic, an initiative, a proposed ADR, a draft spec or a research note) where your changes started, under the same token and `Origin` check: `git merge-base`,
  `git cat-file -e` and `git show` in the page's own clone. With `saves: true` it lists the file's
  earlier saves instead, by one `git log` there (at most 30: each commit's hash, author time, author's
  name and subject, an email-shaped word said as "an email-shaped name"), and with `at` (a full
  hash) it reads the body at one of them, when one is chosen in the editor's selector. The editor saves through the action
  `edit-doc`, which runs the core's `edit` verb; the spec "The dashboard's editor…" (alias
  `dashboard-editor`) holds the rules.
- A preview or an action names a verb of the server's table (`WRITE_VERBS` in `lib/write.mjs`:
  `move`, with `story`, `to` as `todo` or `planned`, and `reason`; `handover`, with `story`, `from`
  as the story's assignee, `to` and `reason`; `rank`, with one of `story` and `epic` and one of
  `before` and `after`, offered by a drop or a key, never a button; `edit-doc`, the editor's Save,
  with `path`, `text` and `base`, and `files`, the pictures and PDFs pasted into the text, each
  `{ name, data }`, run as the core's `edit` with one `--attach` per file; and
  `create-initiative`, `create-epic` and `create-story`, the backlog tree's New, with `title`, an
  epic's `epic` and optional `initiative`, and a story's `epic`, each run as the core's `create`
  with its kind's word first, as the spec "The page's New…" (alias `dashboard-create`) says) and
  gives every required field of it as a value. Each entry also carries the labels and the commit
  subject (or a list of subjects, one for each set of fields) the page draws its dialog from.
  The server builds the argv, and refuses a verb or a field outside the table (400). A file whose
  bytes are of no kept type, over 5 MiB, or named otherwise than the core's `nameOf` names them
  is refused (400) before any process starts; the spec "The page's pictures…" (alias
  `dashboard-attachments`) holds the rules.
- One path rule for every route that takes a path (`readableRel` in `lib/state.mjs`): not empty,
  not absolute, no `\`, no NUL, no `.`, `..` or hidden segment, and after every link is followed
  still a file inside the vault under no hidden segment. `/api/item` and `/api/related` take a
  `.md` file under one of the layout's folders or `initiatives/`; `/vault/` takes a picture, a
  video, a sound or a PDF, and answers with `content-security-policy: sandbox; default-src
  'none'` and `x-content-type-options: nosniff`.
- The page's own answers carry a content policy that loads scripts, styles and pictures from the
  page itself only (`img-src 'self' data:`): a picture from another site is not shown.
- One file, `lib/write.mjs`, starts every process and writes every file. `lib/code.mjs` names the
  Code block's calls and hands each to it, marked as the read's, and the module refuses any so
  marked that is not `git log`, `rev-list`, `rev-parse`, `show` or `diff` in the project, or
  `gh pr list`. No other file here imports `node:child_process`, and from `node:fs` the others
  take only `readFileSync`, `readdirSync`, `statSync`, `lstatSync`, `existsSync`, `realpathSync`
  and `createReadStream`.
- `lib/write.mjs` starts git, gh and the core's CLI through this Node, and nothing else. Each call
  is an argv with no shell, `--` before its positional arguments, stdin ignored, spawned detached
  (no controlling terminal), with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and
  `SSH_ASKPASS_REQUIRE=never`, and `GIT_SSH_COMMAND=ssh -o BatchMode=yes` when the person set no
  ssh command of their own: a login that needs a prompt fails with git's message. Each call has a
  budget (git 60 s, the core's verb 60 s, gh 30 s, the first clone 120 s) and is ended with its
  process group when it runs past it, or when the server stops. A call in the clone carries
  `-c core.hooksPath=/dev/null`, so no git hook runs there.
- In the vault's repository it changes nothing: it runs `rev-parse`, `remote get-url`,
  `config --get`, `config --get-regexp` and `var` there. In the project's repository it runs
  `rev-parse` to find the main checkout, and for the Code block `rev-parse`, `rev-list`, `log`,
  `show` and `diff`, which read and fetch nothing, with `GIT_NO_LAZY_FETCH=1`, and `gh pr list`.
  Everything else makes the clone at
  `<main checkout>/.projectstore/state/dashboard/<person>/clone/` or runs in it: `clone`, `config`, `fetch`, `ls-remote`, `remote`, `symbolic-ref`, `for-each-ref`, `rev-list`,
  `rev-parse`, `status`, `ls-files`, `log`, `diff`, `switch`, `add`, `commit`, `merge`, `cherry-pick`,
  `check-ignore`, `branch --delete`, `reset --hard`, `clean` and `push`. The README's row **The
  dashboard and your browser** says what each is for, and `tests/disclosure.test.mjs` holds the
  row to this file.
- One function pushes, with no refspec of the caller's: `refs/heads/<batch branch>` to the same
  name on `origin`, and only a branch under `dashboard/`; no force, no delete, no mirror. gh runs
  `pr list`, `pr create` and `pr close` only, never `pr merge`, and `pr close` keeps the branch.
- It writes, under `<main checkout>/.projectstore/state/dashboard/<person>/`, the clone (made in
  `clone.tmp/`, renamed to `clone/` once git ends with 0), the binding folder `project/` that
  points the core's `move`, `handover`, `rank`, `edit` and `create` at the vault inside the clone, and the lock file
  `projectstore-dashboard.lock`; it adds `state/` to `.projectstore/.gitignore` when that line is
  missing, and removes a `clone.tmp/` left behind and a stale `index.lock` in the clone. It
  writes no file of the vault, and changes no setting of the vault's repository.
- For a save it writes the text, and each pasted file under its written name, into a folder of
  its own in the system's temporary folder, mode 0600, and removes the folder when the verb ends,
  however it ends. When the verb created a file, or changed `.gitattributes`, and the commit
  would not hold it (git ignores it), nothing is committed: the clone is put back, and the answer
  names the file and the rule `git check-ignore -v` reports.
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
  `flow-stories.mjs`, `flow-policy.mjs`, `flow-counts.mjs`, `graph.mjs`, `binding.mjs`,
  `rank.mjs`, `follow-plan.mjs`, `code-refs.mjs`, `spec-drift.mjs`, `edit-cut.mjs` and
  `attachment.mjs`, after the version check. Layouts are read from `<core>` by name; the core's
  other in-process reads (the headings registry) find their root as the core always does, from
  the harness's plugin-root variable when the launcher's environment sets it, else from the
  core's own place.

## Pictures

Paste or drop a picture (PNG, JPEG, GIF or WebP) or a PDF into an item's editor: it goes into the
text at the cursor as a link to the vault's attachments folder, `![name](../../../attachments/<16
hex digits>.png)` from a story, and is drawn from the page's memory until Save. Save sends the
text with each picture it links; the core's `edit --attach` keeps them there, in the same commit.
One file takes at most 5 MiB, one save 16 MiB. The page holds a pasted picture until it is
reloaded: a text kept in the browser over a reload names the pictures to paste again before Save.
A video or a sound is linked from where it lives, never kept. When the vault's `.gitignore`
ignores the attachments folder, the save is refused and names the rule (`git check-ignore -v`).
A vault whose pictures go through Git LFS is not covered: the clone runs no hooks.

## Kept branches ("Kept aside" on the page), by hand

The page keeps a batch branch it no longer works on: a batch you discarded, one whose pull
request was closed, or one where a carry stopped at a commit that does not apply. The page lists
them under **Kept aside**, with the commits each holds that the default branch lacks, and
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
THIRD-PARTY-NOTICES.txt  the licence texts of the packages built into the editor
editor/           the editor's sources, its pinned build tools and checks (not published)
LICENSE           the core's MIT license, the same file
server.mjs        the HTTP server and the command line above; startServer() for a caller in-process
lib/core.mjs      openCore({ core, project }): the version check, the core's modules, the binding
lib/state.mjs     readState, readItem, readArtifacts and the path rule, each taking openCore's result
lib/related.mjs   related(ctx, rel): an item's specs, ADRs and documents, and the contracts it touched
lib/write.mjs     the write module: the page's clone, the lock, the refresh, preview, action, Send, Discard
lib/code.mjs      openCode({ reader }): the Code block's read, a story's pull requests and a spec's files
lib/reports.mjs   Reports' two reads: the core's flow counts for a window, and the board against the code
public/           the page: index.html, styles.css and classic scripts that share one global scope
  icons.js        the icons: kinds of artifacts, git objects, host marks
  md.js           Markdown to DOM nodes, never through innerHTML
  app.js          helpers, the dialog, the backlog tree
  views.js        the shell; filters, lanes and the address; board, list, My work, Initiatives, Reports' menu row
  write.js        writeUi: a move with its preview, the batch strip, Send, Discard, kept branches
  item.js         the item pane: the document, its fields, the address bar; the editor's drawer and its pictures
  editor.bundle.js  the editor, built from editor/src/
  selftest.js     "Check the editor", from the palette
  related.js      Related: short in the side panel, in full beside the text
  code.js         codeUi: the Code block in the side panel, links apart from leads
  reports.js      reportsUi: the Reports page, its filters in the address, its charts and checks
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
amendment marks (`parseAmendmentMarkers`). For the Code block: the follow verb's link rules
(`closesStoryRefs`, `prUrlOf`, `normUrl`, `isCounted`, `prState`), code paths (`refCovers`,
`isGlobRef`, `normalRef`), and a spec's bundle (`buildSpecDrift`, with its git and grep seams
replaced so that it starts nothing). For the editor: the edit verb's cut and hash
(`splitForEdit`, `bodyHash`). For pictures: a kept file's type, name and limit (`typeOf`,
`nameOf`, `MAX_BYTES`, `refusal`), on the server and, through `/attachment.js`, in the page. The
move verb's story lookup and the diff-refs module's `sinceWindow` are repeated in
`lib/code.mjs`, and a test holds each to the core's.

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
- **An epic's word**: the vault's own status, except that an epic still `planned` with a story
  done or in work reads In Progress, in the tree, on its panel and on the board of epics.
- **Who is looking**: `/api/state`'s `me`, the binding's `default_author`, until the person
  chooses another name at the foot of the menu; the choice stays in the browser.
- **Agents**: a person of the flow policy, or an assignee, whose name starts with `agent:`.
- **People with no policy**: every assignee the policy does not list joins the people, with no
  WIP limit (the page adds them from `assignees`).
- **Order**: a priority outside `p0`–`p3` reads as `p2`. The board, the list and My work order by
  priority, then title. The backlog tree draws each group (an epic's open stories, an
  initiative's epics, the epics of no initiative) in the core's `siblingOrder` (`scripts/rank.mjs`):
  `/api/state` gives each story and epic its `place` and `ranked`, and each epic its `group`. In an
  epic, done stories stand first and set-aside ones last.
- **The list of documents** (`/api/artifacts`): the `*.md` of each layout folder and of
  `initiatives/`, but `README.md`; the kind from the frontmatter's `type`, else the folder's.
- **Related**: which edges of the graph count for an item (an epic's and an initiative's stories
  included), one step from a spec to the ADRs it implements, the titles of a spec's numbered
  contracts (an older spec whose heading the registry does not know is found by a looser
  pattern), an ADR's numbered `## Decisions`, and a contract or a decision named in a story's
  prose ("contract 4", "decisions 1–3"), shown apart as weaker evidence.
- **The path rule** above, and Markdown to the page (`public/md.js`).

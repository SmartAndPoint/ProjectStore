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
palette. It can also move a story between the backlog and ToDo, hand a story someone holds to
another person, reorder the backlog tree by a drag or Alt+↑ and Alt+↓ (a reorder that writes
one file is committed on its drop or key; one that also gives other rows a place asks first),
save an item's text from its editor, and make a new initiative, epic or story with the tree's
New. The core's own `move`, `handover`, `rank`, `edit` and `create` run in
the page's **own clone of the vault**, and the page commits the change there, on the person's own
branch. **Send** (the button reads "Publish for review") pushes that branch and opens one pull request for it (with no `gh` to ask, it
pushes and opens none); **Discard** closes that pull request and ends the batch (with no `gh` to
ask, it ends the batch on this machine only, and an open pull request stays open on the code
host). Nothing reaches the vault until a person merges the pull request, and the page
changes nothing in the core. Where it cannot write (on Windows, or with no git repository, no
`origin` or no git identity for the vault), it shows the vault, changes nothing, and says why.

This package's version is always its core's: one release, from one tag, publishes both, and the
server refuses a core of another version. It has no dependencies: plain Node (20 or newer) on
the server, plain HTML, CSS and classic scripts in the page. The one built file is the editor,
`public/editor.bundle.js`, built from `editor/src/` (CodeMirror 6) by `npm run build --prefix
dashboard/editor` and committed with its licence notices, `THIRD-PARTY-NOTICES.txt`; CI builds it
again and fails when either differs by a byte.

## What it runs, in short

- The server listens on `127.0.0.1` only and answers only its own address. Apart from the refresh
  at its start, it starts a process only for a POST from its own page, which carries the run's
  token and the page's own origin.
- It runs git, gh and the core's CLI through the same Node, and nothing else. It changes nothing
  in the vault's repository or the project's: it writes in its own clone of the vault, under
  `<main checkout>/.projectstore/state/dashboard/<person>/`, and a change reaches the vault only
  through a pull request a person merges.
- For a save it writes the text, and each picture pasted into it, to a folder of its own in the
  system's temporary folder, readable by you alone, removed when the verb ends.

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

How it runs inside (its routes, every git and gh call, kept branches by hand, its files and the
core's readers it uses):
[`docs/web-page.md`](https://github.com/SmartAndPoint/ProjectStore/blob/main/docs/web-page.md).

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
- **Exit 1** before listening: the core's version is not this folder's (the message names
  both), the project has no binding or its vault is not there, the port is taken
  (`port <n> is in use`; for a range, `ports a–b are all in use; pass --port`).
- **Exit 2**: bad arguments.
- **SIGINT, SIGTERM**: close and exit 0.

## Run it by hand, for development

From the root of a checkout of the repository, against a project that is bound to a vault:

```bash
node dashboard/server.mjs --core . --project "<path to the project>" --port 0
```

Open the `url` of the line it prints. The server keeps nothing between requests: edit a file
under `public/` and reload the page; edit a file under `lib/` and start the server again.
`Ctrl+C` ends it.

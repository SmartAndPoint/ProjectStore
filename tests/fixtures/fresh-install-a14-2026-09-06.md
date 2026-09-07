# Fresh-install smoke test — 0.28.0 through the Claude Code shell

**What this is.** A clean project and a clean vault, bound by the 0.28.0 core,
where a real Claude Code session is asked for feature-sized work. The question
is not whether the code it writes is good. It is whether **projectstore's loop
fires by itself**: a vault artifact before an editor, a critic pass, a story,
a reviewer — on a project that has never seen any of it.

Companion to the A9 capture (`tests/fixtures/upgrade-a9-2026-09-05.md`), which
covers the *upgrade* of an existing install. This one covers a *first* install.

Setup done on 2026-09-06, before the session:

| | |
|---|---|
| Project | `~/Projects/SmartAndPoint/ps-smoke/app` — git repo, one commit, `README.md` + `package.json`, no code |
| Vault | `~/Projects/SmartAndPoint/ps-smoke/vault` — git repo, one empty commit, **no folders yet** |
| Binding | `app/.projectstore/projectstore.json` — engineering layout, language `en`, written by `init` |
| Core | 0.28.0 from branch `feat/shells` (PR #14), packed into `dist/projectstore-claude-0.28.0.tgz` |
| Already on the machine | `projectstore@SmartAndPoint` 0.27.1, enabled **user-wide** from the git marketplace |

## 1. Install — the shell, from a terminal outside any Claude Code session

```sh
cd ~/Projects/SmartAndPoint/ps-smoke/app
npx --yes -p ~/Projects/SmartAndPoint/ProjectStore/dist/projectstore-claude-0.28.0.tgz \
  projectstore-claude install --project "$PWD"
```

**Why `-p` and the bin named.** `npx --yes <path>.tgz …` reads the path as a
*package* only when it begins with `./`. An absolute path, or one starting
`../`, is read as a **command** instead: npx hands it to `sh`, which answers
`Permission denied` and exits 126 — measured 2026-09-06 on npm 11.19.0. The
tarball here lives outside the project, so the explicit form is the safe one.
(A9's line stays correct: it runs from the repository root, where `./dist/…`
has the leading `./`.)

The preview measured before the run — compare against what you see:

| Item | Action |
|---|---|
| `~/.claude/projectstore/marketplace` `[projectstore@projectstore-npm]` | create — 145 files, then `claude plugin validate`, `marketplace add --scope local`, `plugin install --scope local -y` |
| `.claude/settings.local.json` `[projectstore@SmartAndPoint]` | **disable** — 0.27.1 is enabled for this checkout too; silenced here only, never globally |
| `CLAUDE.md` `[projectstore:agents v4]` | create |
| status line, `.mcp.json`, the launcher | skip — opt-out or host-provided |

3 changes. **Run 2026-09-06 — the preview matched this table exactly and
reported `applied 3 change(s).`** Measured after it:

- Preview shown before any write? **Yes**, then the three `$` host commands ran.
- `app/.claude/settings.local.json`: `projectstore@projectstore-npm: true`,
  `projectstore@SmartAndPoint: false`, and `extraKnownMarketplaces` pointing at
  `/Users/ekonev/.claude/projectstore/marketplace`. **The collision is handled
  exactly as designed** — the 0.27.1 git copy is silenced in this checkout only.
- `~/.claude/settings.json`: **unchanged**; `projectstore@SmartAndPoint` is
  still `true` user-wide, so every other project keeps 0.27.1.
- The marketplace directory holds 146 files; the host's cache now carries
  `plugins/cache/projectstore-npm/projectstore/0.28.0`, and that copy answers
  `--version` with `0.28.0`.
- `app/CLAUDE.md` created, carrying `projectstore:agents v4`.
- **`.projectstore/.gitignore` — ABSENT.** The directory holds only
  `projectstore.json`. `git add -A --dry-run` stages
  `.projectstore/projectstore.json` — a machine-local binding with an absolute
  `vault_path`. **Story A14's defect 1, confirmed on a real install**, and
  worse than the story assumed: `install` does not repair it either, exactly
  as the critic predicted.
- **Doctor is silent about it.** Via the installed 0.28.0 copy, `doctor` is
  `ok: true` and its `gitignore` warning names only
  `.claude/settings.local.json`. The missing runtime ignore file is the blind
  spot A14's second decomposition item is about — also confirmed.
- `plugin-registration` reports `projectstore@projectstore-npm 0.28.0`
  registered for this project. No `layout-legacy`, no `agents-in-binding`:
  this project was born on the new layout.
- The status line is **skipped by default** on a fresh binding
  (`statusline.enabled` is not set by `init`). Not wired in this run; add
  `--surface statusline` if you want the HUD.

> **Trap worth knowing before A9.** Run `doctor` with the *installed* copy
> (`~/.claude/plugins/cache/projectstore-npm/projectstore/0.28.0/bin/projectstore.mjs`)
> or through the shell. The ProjectStore repository's own `main` is still
> pre-A11, so its `bin/` answers "No projectstore config
> (`.claude/projectstore.json`)" for a project on the new layout — an artefact
> of which binary you ran, not a defect.

## 2. First session — what fires on its own

Open a session in the project (`cd ~/Projects/SmartAndPoint/ps-smoke/app && claude`), then say nothing yet.

**Run 2026-09-06**, immediately after a Claude Code auto-update.

- **Version: 0.28.0, correct.** Proven by where the session wrote, not by the
  banner: `app/.projectstore/state/claude-code/welcomed` and
  `vault/.projectstore/sessions/<uuid>.json` are both new-layout paths a
  0.27.1 copy does not know. No collision — the silencing held.
- **`.projectstore/.gitignore` appeared**, written by this session. That is
  the A14 window closing exactly where the story says it does: after the
  first session, never at `bind` or `install`.
- **DEFECT — the first line a new user sees is wrong.** SessionStart printed:
  *"👋 projectstore: first-run welcome shown. Start with
  /projectstore:bind &lt;vault-path&gt;."* This project **is** bound; the vault is
  in its binding and the install preview named it. In `hooks/session-start.mjs` the binding is read
  first — `readConfig()` opens `main()` — but the welcome's system message is a
  fixed string that never branches on it, so the bound path carries advice that
  fits only an unbound project. The body has the same problem: `buildWelcome()`
  writes the same instruction into the `additionalContext` the agent reads. The code even reasons about a neighbouring
  case — a fresh worktree whose parent is bound — and accepts the redundancy
  there; this case is not redundancy but wrong instruction, in the channel
  read fastest. For a bound project the line should name the vault and point
  at `/projectstore:scaffold` when it is empty.
- Status line: not wired in this run (opt-out on a fresh binding).
- **`/projectstore:doctor` ran clean**: 0 issues, 2 warnings (the
  `.claude/settings.local.json` gitignore line, and `work-without-story` for
  the untracked setup files). `plugin-registration` names 0.28.0 and the
  refresh command in the shell form. The vault info lines offer
  `/projectstore:kanban` and `/projectstore:graph`.
- **DEFECT, release-blocking — `CLAUDE_PLUGIN_ROOT` is not in the shell.**
  The session reported *"CLAUDE_PLUGIN_ROOT isn't exported into the shell here,
  so I'll locate the plugin's bin directly"* and had to search for the binary
  before it could run doctor at all. Reproduced independently in the
  ProjectStore session: `env | grep ^CLAUDE` lists twelve variables and
  **neither `CLAUDE_PLUGIN_ROOT` nor `CLAUDE_PROJECT_DIR` is among them**
  (Claude Code 2.1.261 and 2.1.263 alike, so this is not the auto-update).
  **23 files** under `commands/`, `agents/` and `skills/` invoke
  `node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" …`, and a lint
  (`tests/cli.test.mjs`) pins that spelling — it checks the *spelling*, and
  nothing ever checked that the variable *resolves*. Every slash command is
  therefore one workaround away from failing, and it works today only because
  the model guesses the path. The epic listed this under A9 as unmeasured;
  it is now measured, before A9 ran.

## 3. The work — feature-sized on purpose

Paste this, and then **do not steer it**. The whole point is what it does unprompted.

> Нужен сайт, где человек может зарегистрироваться, войти и увидеть страницу,
> которую видит только он. Начни делать.

Watch for, in order:

Filled in from the run of 2026-09-06. The ordering column is not the
transcript's word for it: a watcher sampled both trees every two seconds and
recorded when each file appeared.

| Expected | Happened? | Note |
|---|---|---|
| It opens a vault artifact **before** an editor | **Yes** | Said so unprompted ("задача размером с фичу, поэтому сначала артефакты"), and measured: epic at 16:48:11, ADR and three stories at 16:53:06, **zero source files in the project at 16:56** |
| Placement named: which epic, which story | **Yes** | New epic AUTH-001 with three stories, named before anything was written |
| An ADR for the auth approach (sessions vs tokens, storage) | **Yes** | *Zero-dependency Node stack for accounts* — `node:sqlite`, `crypto.scrypt` with a per-user salt, server-side sessions with an opaque cookie. Four rejected alternatives, and consequences that name the downsides (a hand-rolled router, a hard Node floor, `SameSite=Lax` not being full CSRF protection) |
| `projectstore:critic` run on the artifact, and its verdict folded | **Yes** | Fired on all five artifacts, unprompted, in the background. This was the step predicted to be skipped |
| A story with acceptance criteria, `status: in_progress` | **Yes** | Three stories with 6–7 checkable criteria each; the first went `in-progress` at 17:19:51, and the ADR to `accepted` after the critic. (`in-progress` with a hyphen — checked, and `isInProgress` accepts the hyphen, the underscore and the space, so this is not drift) |
| `projectstore:planner` consulted before code | see note | The session named it in its own plan; the story went to `in-progress` at 17:19:51 and the first code file landed 17:20:55. Whether the planner agent itself ran is a transcript question, not a disk one |
| Code written only after that | **Yes** | Measured: ADR and stories at 16:53:06, the critic's verdict folded into all five at 17:07:29, story 1 planned at 17:19:51, **first source file at 17:20:55** — 32 minutes after the task, one minute after the story opened |
| `projectstore:reviewer` run on the diff | consistent with the trace | Code written 17:20–17:25, then **rewritten at 17:47:47** (`app.js`, `http.js`, `password.js`, `package.json` and the ADR together), tests at 17:48:45 including a new `users.test.js`. A fold of review findings is what that shape looks like; an agent spawn leaves no trace on disk |
| Approval gate before every vault write | **Yes** | Every write gated, per artifact. The watcher recorded nothing on disk while a gate was open — the epic preview sat for seven minutes and no file moved |
| Agent models resolved through `agents model <name>` (the 0.28 verb), not guessed | not observable from outside | No overlay exists in this project, so the correct answer is "pass nothing, the frontmatter decides"; indistinguishable on disk from not asking. Check the agent-spawn line in the transcript |

**Unasked-for, and worth keeping.** The session caught its own drift: the epic
referenced "ADR-001" where identity is the slug, and carried a Node floor of
22.5 against the ADR's 22.13. It found both, showed a diff, and put the fix
behind a gate (16:54:47). Artifacts staying consistent with each other is a
property nobody prompted for.

## 4. What the vault got

```sh
cd ~/Projects/SmartAndPoint/ps-smoke/vault && git status --short && git log --oneline
```

- **Folders**: the eight layout folders with their index READMEs, created by
  `/projectstore:scaffold` before the task was given.
- **Artifacts**: one ADR (*Zero-dependency Node stack for accounts*, proposed),
  one epic (*User accounts: sign up, sign in, private page*, AUTH-001), three
  stories (sign up; sign in and out with a session cookie; the private page),
  each with 6–7 acceptance criteria.
- **English — yes.** The task was given in Russian; every artifact is in
  English, per the binding's `language: en`. The setting won over the language
  of the request, which is exactly the intended behaviour.
- **Derived views**: `kanban.md` and `graph.md` written at 16:56:19. No
  `code-map.md`, correctly — nothing has `code_refs` yet because no code
  exists.
- **Nothing was written without a gate.** The watcher sampled every two
  seconds and recorded no write while a preview was open.

## Result — the loop closed itself

The story was **closed by the loop, not by hand**: `status: done`,
`started_at` and `closed_at` stamped, a Final Summary written, and
`code_refs` carrying all twelve files. `code-map.md` appeared at 17:58:14 —
the epic-to-code mapping exists because the story recorded what it produced.
`kanban.md` puts the finished story under **Done** and the other two under
**Backlog**.

**The code works.** `npm test` in the generated project: **24 pass, 0 fail**,
covering case-insensitive duplicate emails, two concurrent registrations
creating exactly one account, distinct hashes for equal passwords, escaping of
what was typed, and 404/405 from the real server.

Full ordering, from file mtimes:

| Time | What |
|---|---|
| 16:48 | epic written |
| 16:53 | ADR and three stories written |
| 17:07 | all five rewritten — the critic's verdict folded |
| 17:19 | story 1 opened, ADR accepted |
| 17:20–17:25 | first code, paired with its tests |
| 17:47–17:48 | code and ADR rewritten, a test file added |
| 17:54–17:58 | kanban, graph and code-map regenerated; story closed |

Seventy minutes, unprompted, on a project that had never seen projectstore.
Nothing was written to either tree without a gate.

## 5. Collisions — the thing worth proving

- Did the 0.27.1 user-wide copy and the 0.28.0 npm copy ever both load? ______
- Any command that resolved to the wrong version: ______
- This repository's own install untouched? (`~/Projects/SmartAndPoint/ProjectStore/.claude/settings.local.json`) ______

## Teardown

```sh
cd ~/Projects/SmartAndPoint/ps-smoke/app
npx --yes -p ~/Projects/SmartAndPoint/ProjectStore/dist/projectstore-claude-0.28.0.tgz \
  projectstore-claude uninstall --project "$PWD"
rm -rf ~/Projects/SmartAndPoint/ps-smoke
```

`uninstall` forgets the registration for this checkout, turns the silenced git
copy back on, and removes the local marketplace directory only when no other
checkout uses it.

## Findings

<!-- One line per surprise. These are what the exercise is for. -->

0. **The prompt surface never resolved the plugin root.** Every command named
   `$CLAUDE_PLUGIN_ROOT`, which the Bash tool does not receive; the host
   substitutes the braced form in command, skill and agent content, and our own
   lint forbade it. Release-blocking, and the biggest thing this run found —
   the session hit it on its first command. Fixed as roadmap A15 (`407179e`);
   the story is *The prompt surface asks the shell for a variable the host
   would have substituted*.

1. **Setup, before the session.** `npx --yes <absolute path>.tgz <verb>` does not
   install the tarball — npx execs the path, `sh` answers `Permission denied`,
   and the run ends 126 with no hint that the package was never installed. Only
   a `./`-prefixed path is read as a package. Anything that documents a
   pre-release tarball run should use `npx --yes -p <path> <bin> <verb>`.
2. **Setup, before the session.** `bind`/`init` write
   `.projectstore/projectstore.json` but never `.projectstore/.gitignore`, so a
   fresh project that runs `git add -A` before its first install or session
   commits a machine-local binding with an absolute `vault_path`.
   `applyBind` (`scripts/binding.mjs`) does `mkdirSync` + `writeFileAtomic` and
   does not call `ensureRuntimeDir`, which is what writes that ignore file.
   The first **session** repairs it; `install` does not on a fresh project —
   its `layout` item exists only when a legacy path is pending, and its other
   ensure belongs to the launcher, which is skipped here. So the window is
   bind → first session, and a CLI-only user never closes it. An ignore line
   also never untracks a file already committed: that needs `git rm --cached`.
3. **The same class, on CI.** The suite had been red on `main` since
   2026-09-05 — three tests read the maintainer's own binding, and a fourth
   read whether `claude` is on `PATH`. Fixed in PR #14. A clean environment is
   what finds these; that is what this protocol is.

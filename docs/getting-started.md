# Getting started with projectstore

## Install

From a terminal in your project:

```
npx projectstore setup
```

Setup finds the coding agents the project uses (Claude Code, Codex or both), asks a few questions — among them where the vault lives — then shows one plan and asks once before it writes. It binds the vault, or creates one when the folder is missing or empty. The README's [Install](../README.md#install) section has what setup needs (Node.js 20 or later; npm only for Codex), the other package runners, the global form and the registry-mirror form. Setup binds the vault itself, so after it the project is ready: restart the agent and go on to the daily flow.

The next two sections are the other ways in: a checkout, for contributors, and the git marketplace inside a Claude Code session. After either of them, the first-time setup below binds the vault from inside a session.

## From a checkout

For contributors working on projectstore itself. Clone it; [Running a checkout's build](https://github.com/SmartAndPoint/ProjectStore/blob/main/packaging/README.md#running-a-checkouts-build) covers the packed form.

```bash
git clone https://github.com/SmartAndPoint/ProjectStore.git ~/Projects/SmartAndPoint/ProjectStore
```

In Claude Code, register the local plugin directory:

```
claude --plugin-dir ~/Projects/SmartAndPoint/ProjectStore
```

Inside a Claude Code session, reload the plugin without restart:

```
/reload-plugins
```

Verify the plugin appears:

```
/plugin list
```

You should see `projectstore` (displayName) with prefix `projectstore`.

## In a Claude Code session, from the git marketplace

```
/plugin marketplace add SmartAndPoint/ProjectStore
/plugin install projectstore@SmartAndPoint
```

## First-time setup

`npx projectstore setup` binds a vault or creates one, adds the agents block, and offers the status line, in one plan. The steps below do that from inside a Claude Code session, for the two ways in above, and also ask for the vault's policy and the agents' models; after setup, those two are [Configure](#configure)'s.

1. **Pick a vault directory** — any folder where you want your project artifacts to live. Obsidian opens it natively. Git tracks it cleanly. There is nothing to create by hand: step 2 creates the vault when the folder does not exist yet or is empty.

2. **Bind your current project to that vault**:

   ```
   /projectstore:bind ~/Documents/projects/my-project-vault
   ```

   This creates `.projectstore/projectstore.json` in your project root (machine-local, gitignored) — and then walks you through a short interview: gitignore entries → scaffold offer → vault policy → agent registration in `CLAUDE.md` (recommended: Yes) → model preset for the review agents (the default `opus` is fine) → status line offer (you'll see a preview of the exact line). Every step shows what it wants to write and waits for your approval. When the folder is missing or empty, the interview offers to create the whole vault there through `init` — the directory, its own git repository, the layout's folders and their README indexes — and then has no scaffold to offer.

   **From a terminal instead**, outside a session, one command creates the same vault and binds this project to it:

   ```bash
   npx projectstore init ~/Documents/projects/my-project-vault
   ```

   It skips the rest of the interview: no agents block, no status line, no vault policy, no model preset. A later `/projectstore:bind` on that project only reports "Already bound" — it does not run those steps either. Choose this path when you want the vault and the binding alone.

   **Working in a git worktree?** That config is gitignored, so a worktree of a bound checkout starts unbound and `/projectstore:*` will not run there. Session start says so and names the fix:

   ```
   /projectstore:bind --inherit
   ```

   It copies the binding of the checkout the worktree was forked from — same vault, shared and unchanged, no session state carried over — and skips the interview, since the parent already answered it.

3. **Scaffold the layout** of a vault that was bound without its folders (bind offers this automatically; a vault `init` made already has them):

   ```
   /projectstore:scaffold
   ```

   Creates whichever of `adr/`, `specs/`, `epics/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/`, their `README.md` indexes and the top-level `README.md` are missing, in the vault's language, and never rewrites a file that is there. The layout is the binding's. From a terminal:

   ```bash
   npx projectstore scaffold --write
   ```

## Configure

After setup, every setting is one command away, from a terminal in your project:

```
npx projectstore configure
```

At a terminal it opens a settings menu: each agent's model and effort, the status line and the band, the template language, and the vault's spec policy and lifecycle gates. ↑ and ↓ move, → opens, space chooses, ← goes back, and Enter shows one plan; a second Enter writes it. A model is chosen from its harness's list: Claude Code's aliases, or Codex's own models. Without a terminal it prints the settings with their values and the file each one lives in. From a script or an agent, name the change; naming it is the confirmation:

```
npx projectstore configure --set language=de --set lifecycle_gates=on
```

The README's [Configure](../README.md#configure) section lists what each setting writes and which files are committed.

## Daily flow

```
/projectstore:status                                      # what's bound, what's in progress, view freshness
/projectstore:adr "Use Postgres for primary storage"      # capture a decision
/projectstore:epic AUTH-001 "Authentication system"       # plan a major piece of work
/projectstore:story AUTH-001 "OIDC discovery"             # decompose into stories
/projectstore:kanban                                      # regenerate the board
/projectstore:search "data detective"                     # search the vault
/projectstore:doctor                                      # install + vault diagnostics (no LLM)
/projectstore:reconcile                                   # re-derive board/indexes/code-map from frontmatter
/projectstore:codemap                                     # epic ↔ code mapping view
/projectstore:graph                                       # vault link graph: nodes + typed edges
/projectstore:agents status                               # routing block + model config state
/projectstore:bar status                                  # the band above the prompt: on/off, a pinned epic, why it is not drawing
```

## How approval works

Every command that writes or edits a file goes through `AskUserQuestion`:

1. The command renders a draft (via a plugin script, no disk write).
2. You see the target path + content preview.
3. You pick `Yes` / `Edit before saving` / `No`.
4. Only on `Yes` does the file land.
5. That same `Yes` covers the folder's index README — the row is not appended,
   the folder's managed index table is regenerated through the core, so it
   arrives in canonical order and your prose around the table is preserved.
   One consequence the prompt tells you about: the regeneration rewrites the
   whole table, so a creation can also repair a stale row for another artifact.

Skills (`projectstore-decision-detector`, `projectstore-story-completion`) are passive — they suggest commands; they never write directly.

## Disabling skills

From a terminal in your project:

```
npx projectstore configure --set active_skills=off
```

## Multi-language templates

Default is English (`en`). Also bundled: Russian (`ru`), Spanish (`es`), German (`de`), French (`fr`), Simplified Chinese (`zh`):

```
/projectstore:bind <path> --lang de
```

A bound project changes it with `configure` (the value must be a bundled language). From a terminal in your project:

```
npx projectstore configure --set language=de
```

New artifacts take the new language's templates. The language also localizes the status line strings (e.g. the "no epic or story in this session yet" line).

What the language does and does not change: section headings, table labels and prose are translated; frontmatter keys and their values (`status: planned`, `priority: p2`) stay English, because they are machine-read. Section headings are registered in `scaffold/headings.json`, so doctor, reconcile and the story lifecycle gates recognize every bundled language — a Russian-headed file lints in a French-bound vault, and mixed-language vaults reconcile.

## Updating to a new version

Installed with setup or from npm: from a terminal in your project, name the version you want to run:

```
npx projectstore@<version> upgrade
```

Installed from the git marketplace: in a Claude Code session, open `/plugin manage` and choose **Update now** on projectstore, then run `/reload-plugins` to load it. Or, from a terminal, then restart Claude Code:

```
claude plugin update projectstore@SmartAndPoint
```

Or enable auto-update once (`/plugin` → **Marketplaces** → **SmartAndPoint** → toggle **auto-update**) and Claude Code will detect new releases at startup.

**After any update, run `/projectstore:doctor` in a session.** It compares your project's wiring against what the new version expects and names each fix with the command to run: a stale agents block in `CLAUDE.md` gets `/projectstore:agents register` as its fix and leftover agent copies that override nothing get `/projectstore:agents configure` as theirs. It also names auto-update still off (the exact setting and file) and a newer release than the one running. `doctor --fix` applies the install-side repairs interactively; `/projectstore:reconcile` rebuilds the board/indexes/code-map if content drifted. Silence at session start means healthy — the cheap checks run automatically and only speak up when something is wrong.

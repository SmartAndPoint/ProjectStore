# Getting started with projectstore

## Install (local dev)

Until projectstore is published to a public marketplace, install it from a local clone.

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

## Install (via marketplace)

```
/plugin marketplace add SmartAndPoint/ProjectStore
/plugin install projectstore@SmartAndPoint
```

## First-time setup

1. **Pick a vault directory** — any folder where you want your project artifacts to live. Obsidian opens it natively. Git tracks it cleanly.

   ```bash
   mkdir -p ~/Documents/projects/my-project-vault
   ```

2. **Bind your current project to that vault**:

   ```
   /projectstore:bind ~/Documents/projects/my-project-vault
   ```

   This creates `.claude/projectstore.json` in your project root (machine-local, gitignored) — and then walks you through a short interview: gitignore entries → scaffold offer → agent registration in `CLAUDE.md` (recommended: Yes) → model preset for the review agents (default `opus` + max effort is fine) → status line offer (you'll see a preview of the exact line). Every step shows what it wants to write and waits for your approval.

3. **Scaffold the layout** if the vault is empty (bind offers this automatically):

   ```
   /projectstore:scaffold engineering
   ```

   Creates `adr/`, `epics/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/` and a top-level `README.md`.

## Daily flow

```
/projectstore:status                                      # what's bound, recent activity
/projectstore:adr "Use Postgres for primary storage"      # capture a decision
/projectstore:epic AUTH-001 "Authentication system"       # plan a major piece of work
/projectstore:story AUTH-001 "OIDC discovery"             # decompose into stories
/projectstore:kanban                                      # regenerate the board
/projectstore:search "data detective"                     # search the vault
/projectstore:doctor                                      # install + vault diagnostics (no LLM)
/projectstore:reconcile                                   # re-derive board/indexes/code-map from frontmatter
/projectstore:codemap                                     # epic ↔ code mapping view
/projectstore:agents status                               # routing block + model config state
```

## How approval works

Every command that writes or edits a file goes through `AskUserQuestion`:

1. The command renders a draft (via a plugin script, no disk write).
2. You see the target path + content preview.
3. You pick `Yes` / `Edit before saving` / `No`.
4. Only on `Yes` does the file land.
5. Folder index READMEs get a separate approval prompt.

Skills (decision-detector, story-completion) are passive — they suggest commands; they never write directly.

## Disabling skills

Edit `.claude/projectstore.json`:

```jsonc
{
  "active_skills": false
}
```

## Multi-language templates

Default is English (`en`). For Russian:

```
/projectstore:bind <path> --lang ru
```

Or edit `language: "ru"` in `.claude/projectstore.json` (templates must exist at `templates/ru/`). The language also localizes the status line strings (e.g. the "no epic or story in this session yet" line).

## Updating to a new version

```
/plugin marketplace update SmartAndPoint
/reload-plugins
```

Or enable auto-update once (`/plugin` → **Marketplaces** → **SmartAndPoint** → toggle **auto-update**) and Claude Code will detect new releases at startup.

**After any update, run `/projectstore:doctor`.** It compares your project's wiring against what the new version expects and names each fix with the command to run — stale agents block in `CLAUDE.md` (`/projectstore:agents register`), frozen model override copies (`/projectstore:agents configure`), auto-update still off (the exact setting and file), a newer release than the one running. `doctor --fix` applies the install-side repairs interactively; `/projectstore:reconcile` rebuilds the board/indexes/code-map if content drifted. Silence at session start means healthy — the cheap checks run automatically and only speak up when something is wrong.

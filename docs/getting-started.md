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

   This creates `.claude/projectstore.json` in your project root (machine-local, gitignored).

3. **Scaffold the layout** if the vault is empty:

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

Or edit `language: "ru"` in `.claude/projectstore.json` (templates must exist at `templates/ru/`).

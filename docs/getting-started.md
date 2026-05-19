# Getting started with projectstore

## Install (local dev)

Until projectstore is published to a public marketplace, install it from a local clone.

```bash
git clone https://github.com/SmartAndPoint/projectstore.git ~/Projects/SmartAndPoint/projectstore
```

In Claude Code, register the local plugin directory:

```
claude --plugin-dir ~/Projects/SmartAndPoint/projectstore
```

Inside a Claude Code session, reload the plugin without restart:

```
/reload-plugins
```

Verify the plugin appears:

```
/plugin list
```

You should see `projectstore` (displayName) with prefix `ps`.

## Install (via marketplace)

When projectstore is ready for distribution:

```
/plugin marketplace add SmartAndPoint/projectstore
/plugin install ps@SmartAndPoint
```

## First-time setup

1. **Pick a vault directory** — any folder where you want your project artifacts to live. Obsidian opens it natively. Git tracks it cleanly.

   ```bash
   mkdir -p ~/Documents/projects/my-project-vault
   ```

2. **Bind your current project to that vault**:

   ```
   /ps:bind ~/Documents/projects/my-project-vault
   ```

   This creates `.claude/projectstore.json` in your project root (machine-local, gitignored).

3. **Scaffold the layout** if the vault is empty:

   ```
   /ps:scaffold engineering
   ```

   Creates `adr/`, `epics/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/` and a top-level `README.md`.

## Daily flow

```
/ps:status                                      # what's bound, recent activity
/ps:adr "Use Postgres for primary storage"      # capture a decision
/ps:epic AUTH-001 "Authentication system"       # plan a major piece of work
/ps:story AUTH-001 "OIDC discovery"             # decompose into stories
/ps:kanban                                      # regenerate the board
/ps:search "data detective"                     # search the vault
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
/ps:bind <path> --lang ru
```

Or edit `language: "ru"` in `.claude/projectstore.json` (templates must exist at `templates/ru/`).

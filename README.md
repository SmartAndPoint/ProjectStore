# projectstore

> Opinionated project-management paradigms (ADR / epics / stories / kanban / runbooks) as a Claude Code plugin. Markdown is the output format, Obsidian is one UI for humans, git is the source of truth.

**Status**: early v1, not yet on a marketplace. Local development install only.

## Why

Modern AI coding assistants give you ephemeral context and bag-of-facts "memory". Real engineering projects need **process**: decisions captured as ADRs, work broken into epics & stories with acceptance criteria, a kanban that reflects real state, runbooks for ops, retros after sprints.

`projectstore` is a structure-first plugin: it bridges proven project-management methodologies with agentic development. Your agent learns the project's structure, suggests where to file new artifacts, and helps maintain the index. Humans read the same files in Obsidian, in their editor, or on GitHub.

## What's in v1

- **Layout: `engineering`** — `adr/`, `epics/<id>/stories/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/`.
- **Commands**: `/ps:bind`, `/ps:scaffold`, `/ps:status`, `/ps:adr`, `/ps:epic`, `/ps:story`, `/ps:kanban`, `/ps:research`, `/ps:concept`, `/ps:meeting`, `/ps:runbook`, `/ps:search`.
- **Skills**: passive suggesters that nudge the agent to record decisions/findings — never write without your explicit approval.
- **SessionStart hook**: injects a compact map of the vault into the agent's context.
- **Templates**: opinionated markdown templates with frontmatter, mirroring well-known engineering practices.

## Install (local development)

```bash
git clone https://github.com/SmartAndPoint/projectstore.git ~/Projects/SmartAndPoint/projectstore
claude --plugin-dir ~/Projects/SmartAndPoint/projectstore
```

Inside Claude Code:

```
/reload-plugins
/plugin list
```

You should see `projectstore` (displayName) with command prefix `ps`.

## Quick start

```
# in your project root
/ps:bind ~/Documents/projects/my-knowledge-vault

# scaffold layout (if vault is empty)
/ps:scaffold engineering

# create a new ADR
/ps:adr "Use Postgres for primary storage"

# create an epic + first story
/ps:epic AUTH-001 "Authentication system"
/ps:story AUTH-001 "OIDC discovery + token exchange"

# refresh kanban from story frontmatter
/ps:kanban
```

## Philosophy

1. **Markdown + git is the source of truth.** No proprietary blob format.
2. **Obsidian is a view, not a dependency.** Files render fine on GitHub, in any editor, in `cat`.
3. **The agent is a methodologist, not a database.** Skills nudge, commands gate, humans approve.
4. **Layouts are opinionated.** v1 ships engineering; community adds more (data-analytics, product, chatbot, library).

## Approval flow

Every command that writes or edits a file goes through `AskUserQuestion`:

1. The command renders a draft (via a plugin script, no disk write).
2. You see the target path + content preview.
3. You pick `Yes` / `Edit before saving` / `No`.
4. Only on `Yes` does the file land.
5. Folder index READMEs get a separate approval prompt.

Skills (`decision-detector`, `story-completion`) are passive — they suggest commands; they never write directly.

## Extending

See `docs/extending.md` for adding layouts, templates, and skills.

## License

MIT — see `LICENSE`.

## Status & roadmap

- [x] v0: scaffolding + engineering layout + 12 commands + 2 skills
- [ ] v1: stabilize commands, publish to marketplace, GIF demo
- [ ] v1.1: `data-analytics` layout (community-worthy second example)
- [ ] v2: process modules (sprint cycles, retros), Kanban transitions

Issues and discussions welcome at https://github.com/SmartAndPoint/projectstore.

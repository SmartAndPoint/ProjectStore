# projectstore

> Opinionated project-management paradigms (ADR / epics / stories / kanban / runbooks) as a Claude Code plugin. Markdown is the output format, Obsidian is one UI for humans, git is the source of truth.

**Status**: early v1, not yet on a marketplace. Local development install only.

## Why

Modern AI coding assistants give you ephemeral context and bag-of-facts "memory". Real engineering projects need **process**: decisions captured as ADRs, work broken into epics & stories with acceptance criteria, a kanban that reflects real state, runbooks for ops, retros after sprints.

`projectstore` is a structure-first plugin: it bridges proven project-management methodologies with agentic development. Your agent learns the project's structure, suggests where to file new artifacts, and helps maintain the index. Humans read the same files in Obsidian, in their editor, or on GitHub.

## What's in v1

- **Layout: `engineering`** — `adr/`, `epics/<id>/stories/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/`.
- **Commands**: `/projectstore:bind`, `/projectstore:scaffold`, `/projectstore:status`, `/projectstore:adr`, `/projectstore:epic`, `/projectstore:story`, `/projectstore:kanban`, `/projectstore:research`, `/projectstore:concept`, `/projectstore:meeting`, `/projectstore:runbook`, `/projectstore:search`, `/projectstore:review`.
- **Skills**: passive suggesters — `decision-detector`, `story-completion`, `peer-reviewer`. Never write without your explicit approval.
- **Peer-review**: fresh-context critic agent for high-stakes artifacts (ADR / research / epic). Catches unstated assumptions, missing alternatives, scope creep — see `scaffold/checklists.json` for the structural checklists.
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
/projectstore:bind ~/Documents/projects/my-knowledge-vault

# scaffold layout (if vault is empty)
/projectstore:scaffold engineering

# create a new ADR
/projectstore:adr "Use Postgres for primary storage"

# create an epic + first story
/projectstore:epic AUTH-001 "Authentication system"
/projectstore:story AUTH-001 "OIDC discovery + token exchange"

# refresh kanban from story frontmatter
/projectstore:kanban
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

- [x] v0.1: scaffolding + engineering layout + 12 commands + 2 skills
- [x] v0.2: peer-review channel — `/projectstore:review <path>` + `peer-reviewer` skill + per-kind structural checklists + `review_status` frontmatter
- [x] v0.3: multi-session coordination — atomic-numbering race check before write (layer 1), session registration in `<vault>/.projectstore/sessions/` + cross-session warning at SessionStart and in `/projectstore:status` (layer 2)
- [ ] v1: stabilize commands, publish to marketplace, GIF demo
- [ ] v1.1: `data-analytics` layout (community-worthy second example)
- [ ] v2: process modules (sprint cycles, retros), Kanban transitions

Issues and discussions welcome at https://github.com/SmartAndPoint/projectstore.

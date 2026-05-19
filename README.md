# projectstore

> Project-management paradigms (**ADR · epics · stories · kanban · runbooks**) as a Claude Code plugin. Markdown is the source of truth, Obsidian is one UI, git is portable.

`v0.6.0` · MIT · local install · marketplace publish on the roadmap

---

## What it is

Most "memory" plugins record what was *said*. `projectstore` records what was *decided*. ADRs you can defend, epics with acceptance criteria, a kanban that reflects real state, runbooks for ops — all on disk, as markdown, where humans and agents read the same files.

```
┌─ AI session ────────────┐    ┌─ Vault on disk ────────────┐    ┌─ Humans ────────┐
│  /projectstore:adr      │ →  │  adr/ADR-001-postgres.md    │ →  │  Obsidian       │
│  /projectstore:epic     │    │  epics/AUTH-001/epic.md     │    │  GitHub         │
│  /projectstore:story    │    │  epics/AUTH-001/stories/    │    │  Any editor     │
│  /projectstore:review   │    │  research/...md             │    │  cat            │
│  /projectstore:kanban   │    │  ops/runbook-deploy.md      │    │                 │
└─────────────────────────┘    └────────────────────────────┘    └─────────────────┘
        approval gate                    git-tracked                same files
```

## Why this matters

| You hit a wall when… | projectstore handles it because… |
|---|---|
| `/compact` wipes context mid-feature | PreCompact hook injects vault map + command list + this session's last 15 vault writes — the post-compact agent resumes without re-deriving project structure |
| Two Claude sessions on the same project race on the same artifact | Each session registers in the vault keyed by Claude's `session_id`; SessionStart warns about active siblings; create commands re-check file existence right before write |
| Six months later you forget why X was chosen | ADRs live next to the code, in markdown, with rationale and alternatives considered |
| The agent fabricates "memory" of past decisions | There is no memory — there are files. Grep them. |
| An agent silently rewrites a critical doc | Every write goes through `AskUserQuestion` with target path + content preview. You see the diff before it lands. |

## Real example — two sessions, one project

This was the actual state in our development vault while building v0.6.0. Two Claude Code instances open in the same project, each registers under its own Claude `session_id`:

```bash
$ ls .projectstore/sessions/
d9149e0d-9169-43ef-b2c6-3e005a00e133.json   # session A — plugin dev
f05e61c5-f809-46e1-aa3e-b7c3366bc723.json   # session B — feature work

$ cat .projectstore/sessions/f05e61c5-f809-46e1-aa3e-b7c3366bc723.json
{
  "id":           "f05e61c5-f809-46e1-aa3e-b7c3366bc723",
  "project_root": "/Users/me/projects/myapp",
  "started_at":   "2026-05-19T13:35:36Z",
  "recent_activity": [
    { "path": "epics/WEB-101/PROGRESS.md",                       "tool": "Read",  "at": "..." },
    { "path": "epics/WEB-101/epic.md",                           "tool": "Edit",  "at": "..." },
    { "path": "epics/WEB-101/stories/001-oidc-flow/README.md",   "tool": "Write", "at": "..." }
  ]
}
```

When session A starts up, SessionStart sees session B's mtime < 30 minutes and prepends a warning to A's context:

> ⚠️ Multi-session warning — 1 other projectstore session active on this vault. Active session(s): `project: /Users/me/projects/myapp — started 2026-05-19T13:35Z`. Before creating new ADRs / epics / stories / research: run `/projectstore:search <topic>` to check for in-flight artifacts; run `/projectstore:status` to see what was touched recently.

Sessions stop stepping on each other.

## Surviving /compact

When context is about to be compacted (manual `/compact` or automatic), the PreCompact hook hands off a *survival packet* — a structured snippet that lands in the post-compact agent's context — and prints a single line to your terminal so you see it ran:

```
PreCompact [...pre-compact.mjs] completed successfully: {
  "systemMessage": "projectstore: survival packet injected —
                    vault myapp-vault, layout engineering, 3 recent file(s),
                    in-flight: epics/WEB-101/epic.md"
}
```

The packet contains the vault path, the command list, the last 15 vault touches, and the newest in-flight ADR / epic / story / research. The post-compact agent picks up drafting from where the previous one left off, no manual rehydration.

---

## Install

**Recommended — via marketplace** (inside Claude Code):

```
/plugin marketplace add SmartAndPoint/projectstore
/plugin install projectstore@SmartAndPoint
/reload-plugins
```

**Local development**:

```bash
git clone https://github.com/SmartAndPoint/projectstore.git ~/Projects/SmartAndPoint/projectstore
claude --plugin-dir ~/Projects/SmartAndPoint/projectstore
```

Verify:

```
/plugin list      # projectstore should be present
/reload-plugins   # 4 plugins · 16 skills · 3 hooks · ... (counts vary by your other plugins)
```

## Quick start

```bash
# in your project root, inside a Claude Code session:
/projectstore:bind ~/Documents/my-vault            # binds (with diff confirm on re-bind)
/projectstore:scaffold engineering                 # creates folder layout if vault is empty

/projectstore:adr "Use Postgres for primary storage"
/projectstore:epic AUTH-001 "Authentication system"
/projectstore:story AUTH-001 "OIDC discovery + token exchange"
/projectstore:kanban                               # regenerates board from story frontmatter

/projectstore:review adr/ADR-001-postgres.md       # peer-review via fresh critic agent
/projectstore:status                               # what's bound, what's recent, who's active
```

## What's in the box (v0.6)

- **13 commands** — `bind`, `scaffold`, `status`, `adr`, `epic`, `story`, `kanban`, `research`, `concept`, `meeting`, `runbook`, `search`, `review`
- **3 passive skills** — `decision-detector`, `story-completion`, `peer-reviewer`. They suggest commands; they never write directly.
- **1 layout** — `engineering` (`adr/`, `epics/<id>/stories/`, `research/`, `concepts/`, `meetings/`, `ops/`, `diagrams/`)
- **9 templates** — opinionated markdown with frontmatter (English; Russian variant on the roadmap)
- **3 hooks**:
  - `SessionStart` → injects vault map + multi-session warnings
  - `PreToolUse` → maintains per-session activity log inside the vault (vault-relative paths only)
  - `PreCompact` → emits the survival packet + visible `systemMessage` before compaction

## Philosophy

1. **Markdown + git is the source of truth.** No proprietary blob format. The plugin can disappear; your project's decisions remain.
2. **Obsidian is a view, not a dependency.** Files render on GitHub, in any editor, in `cat`.
3. **The agent is a methodologist, not a database.** Skills nudge, commands gate, humans approve.
4. **Layouts are opinionated.** v1 ships `engineering`; community adds `data-analytics`, `product`, `chatbot`, `library`.

## Approval flow

Every command that writes or edits a file goes through `AskUserQuestion`:

1. The command renders a draft (in-memory, no disk write).
2. You see the target path + content preview.
3. You pick `Yes` / `Edit before saving` / `No`.
4. Only on `Yes` does the file land.
5. Folder index READMEs get a separate approval prompt.

## Peer-review channel

For high-stakes artifacts (ADR / research / epic), `/projectstore:review <path>` spawns a fresh critic agent with a per-kind structural checklist (`scaffold/checklists.json`). Fresh context = no anchoring bias to its own work. Returns concrete improvements, not "looks great!". Templates write `review_status: pending` into the frontmatter; the reviewer flips it to `reviewed` once you accept the diff.

## Roadmap

| Version | What ships | Status |
|---|---|---|
| **v0.6** | Session isolation (Claude `session_id`), safer rebind, PreCompact `systemMessage` | ✅ current |
| v0.5 | PreCompact survival packet | ✅ |
| v0.4 | Rename `ps` → `projectstore` for namespace clarity | ✅ |
| v0.3 | Multi-session coordination (race check + session registry) | ✅ |
| v0.2 | Peer-review channel + structural checklists | ✅ |
| v0.1 | Scaffolding + engineering layout + 12 commands + 2 skills | ✅ |
| v1 | Stabilise commands, marketplace publish, GIF demo | ⏳ next |
| v1.1 | `data-analytics` layout | |
| v2 | Process modules — sprint cycles, retros, Kanban transitions | |

## Extending

See `docs/extending.md` for adding layouts, templates, and skills.

## Contributing

Issues and discussions: https://github.com/SmartAndPoint/projectstore/issues. PRs welcome — adding a layout is a great first contribution (see `scaffold/layouts/engineering.json` for the format).

## License

MIT — see [`LICENSE`](./LICENSE).

# ProjectStore

> Your project's memory, written by your AI agent. Decisions, epics, stories, and a kanban board — saved as plain markdown files you can open in [Obsidian](https://obsidian.md), read on GitHub, or `cat` in a terminal.

[![release](https://img.shields.io/github/v/release/SmartAndPoint/ProjectStore?label=release)](https://github.com/SmartAndPoint/ProjectStore/releases) [![license](https://img.shields.io/github/license/SmartAndPoint/ProjectStore?label=license)](./LICENSE) [![Star on GitHub](https://img.shields.io/badge/%E2%AD%90-star_us-yellow?logo=github)](https://github.com/SmartAndPoint/ProjectStore/stargazers)

A [Claude Code](https://claude.com/claude-code) plugin. Same markdown-first, agent-maintained idea as Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — but for engineering project artifacts, one brain per project.

---

## What it gives you — in 90 seconds

**1. Decisions stop getting lost.** You make dozens of small architectural calls in chat every week. ProjectStore notices them and offers to write them down:

> **You:** Let's go with Postgres, not Mongo — we need transactions.
>
> **Claude:** That reads like an architecture decision. Want me to file it as `adr/ADR-001-use-postgres-for-primary-storage.md`?

You say yes, review the draft, approve — and a real file lands in your vault:

```markdown
---
title: "Use Postgres for primary storage"
status: accepted
date: 2026-07-03
---
## Context
We need ACID transactions for order processing...
## Decision
Postgres 16 as the primary store...
## Alternatives Considered
### MongoDB — rejected because...
```

Six months later, "why Postgres?" has an answer with a date and the alternatives you rejected.

**2. Every session starts with "where were we".** When you open Claude Code in a bound project, the plugin injects a map of your vault into the session. Ask *"where did we stop, what's next?"* — and the agent answers from your actual epics and stories, not from guesswork.

**3. A real board.** Stories carry a `status` field; `/projectstore:kanban` turns them into an Obsidian-style board:

```markdown
## In Progress
- [ ] [[AUTH-001: OIDC discovery]] #p1

## Done
- [x] [[AUTH-001: Login form]] #p1
```

**4. Your status line shows what this session is working on** — composed above your existing HUD, never replacing it:

```
[PS#0.13.0] 📚 Authentication system › OIDC discovery (in-progress)
```

A fresh session honestly says `📚 No epic or story in this session yet` instead of showing nothing.

**5. A doctor that tells you when something's off.** No AI involved — fast, deterministic checks:

```
$ /projectstore:doctor
## vault (1 issue(s))
  ✖ [kanban] kanban.md is out of sync with story frontmatter — run /projectstore:kanban
```

**6. Five specialist agents on call** — a critic for your documents, a planner and a reviewer that know your project's structure, a librarian, and an archaeologist for existing codebases. See [The bundled agents](#the-bundled-agents).

Everything is plain markdown in a folder you choose. The plugin can disappear tomorrow; your project's memory stays readable.

---

## Install (2 minutes)

Inside Claude Code:

```
/plugin marketplace add SmartAndPoint/ProjectStore
/plugin install projectstore@SmartAndPoint
/reload-plugins
```

One important switch: Claude Code does **not** auto-update third-party plugins by default. Open `/plugin` → **Marketplaces** tab → **SmartAndPoint** → toggle **auto-update** on. (If you skip this, `/projectstore:doctor` will remind you later — with the exact setting to flip.)

<details>
<summary>Local dev install (contributors)</summary>

```bash
git clone https://github.com/SmartAndPoint/ProjectStore.git
claude --plugin-dir ./ProjectStore
```

To pin a specific release: `/plugin marketplace add SmartAndPoint/ProjectStore#v0.13.0`.
</details>

## First-time setup — what actually happens

Pick any folder for your project's memory (an "Obsidian vault" — but really just a folder) and bind it:

```
# Example

/projectstore:bind ~/Documents/my-project-vault
```

Bind walks you through a short interview. Every step shows you exactly what it wants to write and waits for your approval — nothing lands silently:

| Step | What you're asked | Beginner-friendly answer |
|---|---|---|
| 1 | Write the config (`.claude/projectstore.json` — vault path, layout, language `en`/`ru`)? | Yes |
| 2 | Add the machine-specific files to `.gitignore`? | Yes |
| 3 | Vault is empty — create the folder layout (`adr/`, `epics/`, `research/`, …)? | Yes |
| 4 | Register the agents in `CLAUDE.md` so every session knows when to use them? | Yes (recommended) |
| 5 | Which model should the review agents use? | Keep the default (`opus` + max effort) |
| 6 | Show your current epic/story in the status line? You'll see a preview: `[PS#0.13.0] 📚 Super Feature in a Super Product › Toilet-Paper Handle (in-progress)` | Yes, why not |

Result — a vault that looks like this:

```
my-project-vault/
├── README.md          ← index of everything
├── adr/               ← architecture decisions
├── epics/             ← big pieces of work, each with stories/
├── research/          ← investigations and comparisons
├── concepts/          ← glossary and mental models
├── meetings/          ← meeting notes
├── ops/               ← runbooks
├── diagrams/
└── kanban.md          ← the board (generated)
```

Open that folder in Obsidian and you get the graph view and the kanban board for free. Don't use Obsidian? Everything renders on GitHub and in any editor.

## Day to day — you mostly don't type commands

The agent picks the commands up from the conversation; you only approve the writes:

- Say *"we'll use JWT with short expiry"* → the agent offers an ADR.
- Say *"let's build the export feature: first CSV, then PDF"* → it offers an epic with two stories.
- Finish a story → it offers to flip the status and refresh the board.

The commands you *will* type now and then:

```
/projectstore:status        # what's bound, what changed recently
/projectstore:kanban        # regenerate the board
/projectstore:search jwt    # grep the vault
/projectstore:doctor        # is everything wired and consistent?
/projectstore:reconcile     # rebuild board/indexes after hand-edits
/projectstore:review adr/ADR-001-….md   # send a document to the critic
```

Every write goes through the same gate: you see the target path and the content, then pick Yes / Edit / No.

## The bundled agents

ProjectStore ships five read-only specialist agents. They review and propose — they never edit your files or commit anything. During bind (step 4 above) a short routing block is added to your `CLAUDE.md`, so every future session knows *when* to call them without you remembering their names.

| Agent | In plain words | When it speaks up |
|---|---|---|
| `projectstore:critic` | A tough, fresh-eyes reviewer for your documents. Finds what's wrong, missing, or contradictory in an ADR/research/epic — no praise padding. | After you write or revise any vault document |
| `projectstore:planner` | Plans *where* a new feature belongs in your code — by looking at how your previous epics landed (which modules/adapters they became, via `code_refs`). | Before implementing an epic or story |
| `projectstore:reviewer` | Checks that the code you just wrote **actually closes the story**: goes acceptance criterion by criterion with evidence. | After coding, before commit / marking done |
| `projectstore:librarian` | Vault housekeeping that no script can do: finds contradicting or duplicate documents, missing links, things to archive. | Occasionally, e.g. before a release |
| `projectstore:archaeologist` | For existing projects: digs decisions out of your code and git history ("you clearly chose Postgres and an adapter layer — shall we write those down?") and proposes backfill ADRs. | Once, after binding a brownfield project |

Example of the reviewer in action:

> **You:** I think the CSV export story is done, check it.
>
> **Reviewer:** Verdict: **gaps remain**. AC 1 (exports valid CSV) — met, `src/export/csv.ts:42` + test. AC 2 (handles 10k rows under 2s) — **not met**: no benchmark or test exists. AC 3 (errors surface to the user) — met. Proposed `code_refs`: `src/export/`.

Want them on a different model? `/projectstore:agents configure` — one question, applies to all five (they're critics and reviewers, so strong models at high effort pay off; `opus` + `max` is the default).

## Updating the plugin — and what doctor does for you

Updating is two commands (or automatic, if you enabled auto-update):

```
/plugin marketplace update SmartAndPoint
/reload-plugins
```

After any update, run **`/projectstore:doctor`**. It's the migration companion: it compares your project's wiring against what the new version expects and tells you exactly what to fix — with the commands to run. A typical picture right after upgrading v0.12 → v0.13:

```
$ /projectstore:doctor
projectstore doctor — plugin v0.13.0

## install (1 issue(s), 2 warning(s))
  ✖ [agents-block] Agents block in CLAUDE.md is v0, expected v1 — re-run /projectstore:agents register.
  ⚠ [override-copies] Override copy critic.md frozen at projectstore v0.12.0 (installed v0.13.0) — re-run /projectstore:agents configure.
  ⚠ [auto-update] Auto-update is OFF for marketplace "SmartAndPoint" — new releases will not be noticed.
    Correct values: "autoUpdate": true on the "SmartAndPoint" entry in ~/.claude/plugins/known_marketplaces.json
    (set via /plugin → Marketplaces → SmartAndPoint → toggle auto-update).

## vault (0 issue(s))
  ✓ clean
```

Three findings, each with its exact fix. `doctor --fix` walks you through the repairs interactively (every change approved by you). It also warns when the marketplace already has a newer release than the one you're running.

The second half, `doctor --vault`, guards your content: statuses that disagree with the board, "done" stories with unchecked acceptance boxes, dead links, stale indexes. Its repair partner is `/projectstore:reconcile`, which rebuilds every generated view (board, folder indexes, code map) from the files themselves — so hand-editing markdown can never permanently break anything.

A tiny version of these checks runs at every session start and prints **one line** only when something is actually wrong. Silence means healthy.

## Status line

See the epic and story *this session* is working on, composed **above** your existing HUD (e.g. oh-my-claudecode) — never replacing it:

![projectstore status line: the 📚 epic › story line sitting above an existing oh-my-claudecode HUD](docs/images/statusline-hud.png)

```
/projectstore:statusline on | off | status
```

Details that matter with several Claude sessions open on one project: each session shows **its own** epic/story (never a sibling's), a fresh session shows a friendly localized "no epic or story in this session yet" line instead of a blank, and the `[PS#0.13.0]` badge tells you at a glance the plugin is alive and which version. Wiring is self-healing across plugin updates (the SessionStart hook re-points it every start).

## What's in the box (v0.13)

- **18 commands** — `bind`, `scaffold`, `status`, `adr`, `epic`, `story`, `kanban`, `research`, `concept`, `meeting`, `runbook`, `search`, `review`, `statusline`, `doctor`, `reconcile`, `codemap`, `agents`
- **5 agents** — `critic`, `planner`, `reviewer`, `librarian`, `archaeologist` (read-only, fresh-context, model-configurable)
- **4 passive skills** — decision detection, story completion, peer-review nudges, vault-native communication. They suggest; they never write.
- **1 doctor + reconcile** — deterministic health checks and one-command repair of every generated view
- **1 layout** — `engineering`, with English and Russian templates (localized UI strings included)
- **3 hooks** — session start (vault map + doctor line), tool use (activity + per-session pointer + raw-edit nudge), pre-compact (survival packet)

**The roster rule**: ProjectStore bundles an agent only if the role *requires the vault* to make sense. General coding assistants belong to your own setup — our `planner`/`reviewer` are deliberately narrow, vault-aware specialists, not their replacements. `/projectstore:review` always spawns the scoped `projectstore:critic`; your own same-named agents win for bare-name and auto-delegated calls.

## Under the hood (the honest version)

- **Frontmatter is the source of truth.** The board, folder indexes, and code map are *generated views* — regenerate anytime (`kanban`, `reconcile`, `codemap`); hand edits can't permanently desync them.
- **Every write is approval-gated.** Commands render a draft in memory, show you path + content, and write only on Yes. Declining leaves the vault byte-for-byte unchanged.
- **Sessions don't step on each other.** Each Claude Code session registers under its own `session_id`; parallel sessions get warned about each other, and each status line shows only its own work.
- **`/compact` survival.** Before context compaction, a hook hands the next agent a survival packet (vault map, recent touches, the in-flight artifact), so it resumes instead of re-deriving.
- **Raw edits are expected, not punished.** If you (or the agent) edit vault markdown directly, a gentle nudge suggests running `reconcile` afterwards. The guarantees survive the easy path.

Deep dive with real session files and the compaction packet: [docs/how-it-works.md](./docs/how-it-works.md).

## Philosophy

1. **Markdown + git is the source of truth.** No proprietary format. The plugin can disappear; your project's decisions remain.
2. **Obsidian is a view, not a dependency.** Files render on GitHub, in any editor, in `cat`.
3. **The agent is a methodologist, not a database.** Skills nudge, commands gate, humans approve.
4. **Layouts are opinionated.** v1 ships `engineering`; community adds `data-analytics`, `product`, `chatbot`, `library`.
5. **One brain per project, not per person.** The vault travels with the repo. Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) is its personal-research counterpart.

## Roadmap

| Version | What ships | Status |
|---|---|---|
| **v0.13** | Umbrella `doctor` + `reconcile` + `codemap`; vault-aware agent suite — **breaking renames**: `projectstore:projectstore-critic` → `projectstore:critic`, `code-planner`/`code-reviewer` → vault-aware `planner`/`reviewer` — plus `librarian` & `archaeologist`; agents block + model presets + statusline offer at bind; per-session never-blank status line; unicode slugs; YAML-safe frontmatter | ✅ current |
| v0.12 | Status line shows full epic & story titles (from frontmatter, not the filename) | ✅ |
| v0.11 | Status line install simplified — opt-in flag + self-healing SessionStart wiring | ✅ |
| v0.10 | Status line — current epic & story in the HUD, composes with an existing status line | ✅ |
| v0.9 | Bundled review agents (`projectstore-critic`, `code-planner`, `code-reviewer`) | ✅ |
| v0.8 | Russian (`ru`) templates | ✅ |
| v0.7 | First-run welcome (SessionStart one-shot), auto-update follow-up in `/projectstore:bind` | ✅ |
| v0.6 | Session isolation (Claude `session_id`), safer rebind, PreCompact `systemMessage` | ✅ |
| v0.5 | PreCompact survival packet | ✅ |
| v0.4 | Rename `ps` → `projectstore` for namespace clarity | ✅ |
| v0.3 | Multi-session coordination (race check + session registry) | ✅ |
| v0.2 | Peer-review channel + structural checklists | ✅ |
| v0.1 | Scaffolding + engineering layout + 12 commands + 2 skills | ✅ |
| v1 | Stabilise commands, marketplace publish, GIF demo | ⏳ next |
| v1.1 | `data-analytics` layout | |
| v2 | Process modules — sprint cycles, retros, Kanban transitions | |

## Uninstalling

`/plugin uninstall projectstore@SmartAndPoint`. Your vault is yours — plain markdown, untouched. One leftover to remove by hand: the agents block in `CLAUDE.md`/`AGENTS.md` — delete everything between `<!-- projectstore:agents … -->` and `<!-- /projectstore:agents -->`.

## Extending

See [`docs/extending.md`](./docs/extending.md) for adding layouts, templates, and skills.

## Contributing

Issues and discussions: https://github.com/SmartAndPoint/ProjectStore/issues. PRs welcome — adding a layout is a good first contribution (see `scaffold/layouts/engineering.json` for the format).

## License

MIT — see [`LICENSE`](./LICENSE).

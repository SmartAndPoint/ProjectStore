# ProjectStore beside agent memory and spec-driven tools

People who meet ProjectStore compare it with what they already run next to a coding agent: a
memory plugin, an instruction file, a spec-driven tool. This page says what each of those keeps,
what ProjectStore keeps instead, and which parts of ProjectStore exist elsewhere. The README names
three kinds of tools; the first table here has four kinds, because agent memory kept in the
repository gets its own column.

The claims about other tools come from their own documentation, repositories and release notes,
**read on 2026-10-09**. Tools move fast; if a cell below is wrong or out of date,
[open an issue](https://github.com/SmartAndPoint/ProjectStore/issues/new?title=docs%2Falongside.md%3A+a+wrong+cell)
and name the cell and your source.

## The question each kind of tool answers

| | Agent memory | Instruction files | Agent notes in the repository | Spec-driven tools | ProjectStore |
|---|---|---|---|---|---|
| **Examples** | Mem0, Zep, claude-mem, Codex memories, Claude Code auto memory | `CLAUDE.md`, `AGENTS.md`, rules, Kiro steering | Cline Memory Bank, Serena memories, Basic Memory, Letta | Spec Kit, Kiro specs, OpenSpec, BMAD | |
| **One entry is** | a fact or an observation | a rule | a note the agent keeps | a change: spec, plan, tasks | a decision, a spec or a work item, with a status, a date and links |
| **Written by** | the model, automatically | a person, or the agent on request | the agent, sometimes reviewed in pull requests | the agent; phase approval in Kiro and Tessl, a clear yes in OpenSpec's Explore, write previews in one BMAD skill | the agent drafts; a person approves the full text; a fresh-context critic reviews it by rule |
| **Lives in** | a hosted or local index (vector, graph, SQLite), or machine-local files | the code repository | the code repository, or a memory repository | the code repository; OpenSpec Stores (beta) in a planning repository | a folder kept in git, usually its own repository |
| **Read by** | the model, by retrieval | the model, at session start or when a file pattern or request matches | the model, on demand | the model and the team, during the feature | Claude Code sessions from the start (Codex: experimental); any agent through the CLI and MCP; people in pull requests and Obsidian |
| **Scope** | an agent, a user or a machine | the project | the project | a feature, plus a constitution or steering | the project, across features and harnesses |
| **Changes by** | expiry, invalidation, pruning | rewriting | rewriting, git history | per feature: discarded, or merged into living specs | supersede with reasons; status changes with evidence; `doctor` and `reconcile` |
| **Answers** | "What does this agent recall?" | "How should an agent behave here?" | "What has this agent learned about the project?" | "How do we build this change?" | "What has the project decided, what is in flight, and was it checked?" |

## Why ProjectStore is not agent memory

1. **Nothing is written because it was said.** A memory system writes when the model notices
   something. A vault artifact is written through a ProjectStore command, after a person approved
   its path and full text. The skill that watches the conversation only suggests a command.
2. **Nothing is read by similarity.** Agents navigate: folder indexes, the link graph grepped by
   path, the kanban, then the artifact. `search` is a literal substring search. What an agent read
   is a file a person can open.

   The price: an agent must know a word, a title or a path. Nothing finds a note that says the
   same thing in other words.
3. **Nothing belongs to an agent, a user or a machine.** The vault travels through git to whoever
   has the repository. Claude Code and Codex read it through ProjectStore's commands; any other
   agent can read it through the CLI or the MCP read surface. Codex memories and Claude Code auto
   memory are per machine; Mem0's are per user or agent.
4. **It can be wrong in a way that is reviewed.** A memory that turned false is expired, pruned or
   invalidated. A decision that turned false is superseded by a newer ADR that says why, and the
   chain stays.
5. **What survives `/compact` is paths into the record, not knowledge from the session.** In
   Claude Code, the SessionStart hook runs after compaction too. It hands back a navigation
   skeleton of the vault plus the vault paths the session touched: the session's own activity log,
   machine-local and git-ignored, resolved against the vault. Nothing the conversation said is
   stored. Codex runs the same hook in its experimental shell, but what it reports after
   compaction has not been measured.

**The overlap.** ProjectStore keeps a little session state on the machine — a per-session pointer
and the last 50 activity entries — for orientation, never committed. It is not knowledge, and
deleting it changes nothing in the vault.

**Where the data goes.** A memory tool stores what it derives from conversations, and some ship it
off the machine (Mem0's platform, claude-mem's optional cloud sync). The vault holds only text a
person approved. What reaches the model provider still depends on your harness and its
permissions.

## Memory and the vault, side by side

They are not rivals. Use both, each for its own thing:

- **Memory for the person and the machine:** how you like to work, your environment's quirks,
  corrections you gave the agent.
- **The vault for the project:** what was decided and why, what is in flight, what was checked.

The vendors say the same about their own memory. Codex: "Keep required team guidance in AGENTS.md
or checked-in documentation. Treat memories as a helpful recall layer, not as the only source for
rules that must always apply." Claude Code's auto memory skips what your `CLAUDE.md` already says.

The rule needs upkeep, because memory fills up on its own. When a memory states a project decision
or an idea the team should see, move it into the vault as an artifact, and let the memory keep only
a pointer to it.

## The ingredients, tool by tool

Every ingredient of ProjectStore's loop exists somewhere else. This matrix shows where. "Core"
means without extensions; "?" means the documentation we read says nothing either way.

| Tool | Decision record with status and supersede | Person approves the full text before a write | Fresh-context review of planning artifacts | Fresh-context review of the diff against acceptance criteria | Orientation from the record at session start | Consistency checks with no model | Read surface for any agent |
|---|---|---|---|---|---|---|---|
| Spec Kit 1.1, core | no | no (a convention between phases) | no (in-context `/speckit.analyze` and `/speckit.checklist` only) | no | no | ? | commands for about forty agents |
| Spec Kit with community extensions | `adrkit`: MADR records with `status`, `adr accept`, superseded retrieval (pinned below 1.1.0) | no, before a write. `plan-review-gate` requires spec and plan merged by PR before tasks; `spec-validate` adds approval state as "a hard gate before /speckit.implement" | `red-team`, `critique`, `multi-model-review` | `maqa`, a QA workflow (fresh context unstated) | the official `agent-context` extension keeps a static block in `CLAUDE.md`/`AGENTS.md`; `memory`, `dubsar` (resume) | ? (`speckit-utils` "validate project health", `sync`; model use unverified) | same |
| Kiro | no | yes, per phase (Quick Spec skips the gates) | ? | ? | steering, always included | ? | Kiro only |
| OpenSpec 1.14 | a section per change; the archive keeps history | Explore only: waits for "a clear yes" | ? | ? | marker blocks in `CLAUDE.md`/`AGENTS.md`; no session hook | **yes**: `openspec validate` | many tools |
| BMAD 6.12.1 | spine `AD-n`: IDs can be retired, never reused; append-only rationale; no supersede chain documented | the project-context skill shows every write first | **yes**: reviewer gates on PRD, spine, UX | fresh subagent lenses (edge cases, verification gaps); the edge-case lens reads the spec's acceptance as claims, not per criterion | its `AGENTS.md` block (project-context skill); no SessionStart hook found | **yes**: `sprint_plan.py validate` | installer for several agents |
| Beads 1.3.1 | no: issues, not decisions (`bd supersede` marks an issue superseded by a newer one) | no | no | no | **yes**: `bd prime` through SessionStart hooks (Claude Code, Gemini CLI, Codex) | **yes**: `bd doctor`, `bd lint` (missing sections), `bd orphans` (referenced in commits, still open) | CLI with JSON; Dolt in git, JSONL export |
| Letta, Serena | no | no | no | no | Letta loads memory-root files into the system prompt every turn | no | Serena: any MCP client |
| Mem0, claude-mem | no | no | no | no | claude-mem injects memory at session start | no | many harnesses |
| ProjectStore 0.29.2 | **yes**: ADR status, `superseded_by` | **yes**, through its commands | a standing rule for every kind (critic) | a standing rule (reviewer), per criterion with evidence | **yes** in Claude Code; Codex experimental | **yes**: `doctor`, `reconcile`, regenerated views | CLI and MCP; Claude Code and Codex shells |

**What it shows.** No single column is ProjectStore's alone:
- `adrkit` keeps decision status and supersession;
- OpenSpec, BMAD and Beads validate artifacts without a model;
- Beads injects ready work at session start;
- BMAD reviews plans and diffs in fresh contexts.

What none of the tools above documents is all of them over one record: decisions, specs and work
items in one linked graph with a lifecycle, where the same `doctor` checks the links between them
and down to code, the same views regenerate from them, one critic rule covers every kind, and each
session's starting map is computed from that record.

**The nearest composition is Spec Kit with extensions.** Read cell by cell, it covers three of the
four ingredients listed above — decision status (`adrkit`), fresh-context review (`red-team`,
`critique`, `multi-model-review`), session-start orientation (`agent-context`, `memory`, `dubsar`) —
and has a "?" on the fourth, checks with no model. But it spreads across three stores — `adrkit`'s
ADRs, `specs/`, and an issue tracker through `maqa` — and documents no links between them and no
check that reads across them. `adrkit`'s catalog entry also pins Spec Kit below 1.1.0, the current
core.

**Review is a rule, not a lock**, in ProjectStore and in BMAD alike. Both are only as good as their
being followed. In ProjectStore, ADRs, specs, epics and research notes carry `review_status:
pending` until a critic pass is applied, so "not yet reviewed" is a state the tools can read;
stories are checked instead by the reviewer, against their diff. Nothing stops a person from
accepting an ADR before the critic pass.

**When this table is re-read:** when BMAD ships its next release, when OpenSpec Stores leave beta,
or when a Spec Kit extension joins decision records to review — each of those could change a cell.

**Sources, read on 2026-10-09:**
- Spec Kit: [repository](https://github.com/github/spec-kit) — releases 1.0.0 (2026-08-21) and
  1.1.0 (2026-10-02), `docs/concepts/spec-persistence.md`, `docs/reference/integrations.md`,
  `extensions/catalog.community.json`; [adrkit](https://github.com/mbeacom/adrkit).
- Kiro: [specs](https://kiro.dev/docs/specs/), [best practices](https://kiro.dev/docs/specs/best-practices/),
  [steering](https://kiro.dev/docs/steering/).
- OpenSpec: [repository](https://github.com/Fission-AI/OpenSpec) — releases, `docs/concepts.md`,
  `docs/cli.md`, `docs/installation.md`, `docs/stores-beta/user-guide.md`.
- BMAD-METHOD: [repository](https://github.com/bmad-code-org/BMAD-METHOD) — release 6.12.1
  (2026-10-04), `src/bmm-skills/plan/bmad-architecture/references/reviewer-gate.md`,
  `src/bmm-skills/plan/bmad-sprint-planning/references/validate.md`.
- Beads: [repository](https://github.com/gastownhall/beads) — release 1.3.1 (2026-09-30),
  `docs/cli-reference/`.
- Letta: [context repositories](https://www.letta.com/blog/context-repositories),
  [MemFS](https://docs.letta.com/concepts/memfs). Serena:
  [memories](https://oraios.github.io/serena/02-usage/045_memories.html).
- Zep / Graphiti: [concepts](https://help.getzep.com/concepts),
  [Graphiti](https://github.com/getzep/graphiti). Cline: [Memory Bank](https://docs.cline.bot/best-practices/memory-bank).
  Basic Memory: [repository](https://github.com/basicmachines-co/basic-memory). Tessl:
  [overview](https://docs.tessl.io/overview/readme.md),
  [spec-driven development tile](https://github.com/tesslio/spec-driven-development-tile).
- Mem0: [how it works](https://docs.mem0.ai/core-concepts/how-it-works),
  [memory expiration](https://docs.mem0.ai/platform/features/memory-expiration),
  [OpenMemory's removal](https://github.com/mem0ai/mem0/pull/6530). claude-mem:
  [repository](https://github.com/thedotmack/claude-mem).
- Claude Code: [memory](https://code.claude.com/docs/en/memory). Codex:
  [memories](https://learn.chatgpt.com/docs/customization/memories),
  [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- ProjectStore: this repository.

## What the checks cost

The critic and reviewer runs are model calls, and they are not free. On this repository, where
every change goes through the full loop, vault work measures 22.5% of total spend; on a typical
project, budget 10–15% of a weekly limit. The number is the price of the critic and reviewer
runs, not of storing files. See
[What it costs — measured, not promised](../README.md#what-it-costs--measured-not-promised).

## Spec-driven tools

Running ProjectStore beside a spec-driven tool such as Spec Kit, Kiro or OpenSpec is a design that
has not been tried. The idea is that the spec-driven tool would own one feature's spec, plan and
tasks, while ProjectStore keeps the decisions, the backlog and the checks around them. Whether the
two tools' agent instructions, entry points and acceptance criteria stay out of each other's way is
an open question, and so is how ProjectStore's spec-first policy should be set beside them. A trial
and a decision on that policy are proposed; until they land, this page recommends no setting.

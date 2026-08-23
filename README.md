# ProjectStore

> Your project's memory, written by your AI agent. Decisions, epics, stories, and a kanban board — saved as plain markdown files you can open in [Obsidian](https://obsidian.md), read on GitHub, or `cat` in a terminal.

[![release](https://img.shields.io/github/v/release/SmartAndPoint/ProjectStore?label=release)](https://github.com/SmartAndPoint/ProjectStore/releases) [![license](https://img.shields.io/github/license/SmartAndPoint/ProjectStore?label=license)](./LICENSE) [![Star on GitHub](https://img.shields.io/badge/%E2%AD%90-star_us-yellow?logo=github)](https://github.com/SmartAndPoint/ProjectStore/stargazers)

A [Claude Code](https://claude.com/claude-code) plugin. Same markdown-first, agent-maintained idea as Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — but for engineering project artifacts, one brain per project.

---

## What it gives you — in 90 seconds

**1. Decisions stop getting lost.** You make dozens of small architectural calls in chat every week. ProjectStore notices them and offers to write them down:

> **You:** Let's go with Postgres, not Mongo — we need transactions.
>
> **Claude:** That reads like an architecture decision. Want me to file it as `adr/use-postgres-for-primary-storage.md`?

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
[PS#0.22.0] 📚 Authentication system › OIDC discovery (in-progress)
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
| 1 | Write the config (`.claude/projectstore.json` — vault path, layout, language `en`/`ru`/`es`/`de`/`fr`/`zh`)? | Yes |
| 2 | Add the machine-specific files to `.gitignore`? | Yes |
| 3 | Vault is empty — create the folder layout (`adr/`, `epics/`, `research/`, …)? | Yes |
| 4 | Register the agents in `CLAUDE.md` so every session knows when to use them? | Yes (recommended) |
| 5 | Which model should the review agents use? | Keep the default (`opus`) |
| 6 | Show your current epic/story in the status line? You'll see a preview: `[PS#0.22.0] 📚 Super Feature in a Super Product › Toilet-Paper Handle (in-progress)` | Yes, why not |

Result — a vault that looks like this:

```
my-project-vault/
├── README.md          ← index of everything
├── adr/               ← architecture decisions
├── specs/             ← normative "how" per subsystem, covering stories (v0.14)
├── epics/             ← big pieces of work, each with stories/
├── research/          ← investigations and comparisons
├── concepts/          ← glossary and mental models
├── meetings/          ← meeting notes
├── ops/               ← runbooks
├── diagrams/
├── kanban.md          ← the board (generated)
└── graph.md           ← the link graph: nodes + typed edges (generated)
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

Want them on a different model? `/projectstore:agents configure` — one question, applies to all five (they're critics and reviewers, so strong models pay off; `opus` is the default). It records the choice in `.claude/projectstore.json` and the model rides each invocation — no agent files are copied into your project (ADR-008). Effort stays at the bundled `max`.

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
  ✖ [agents-block] Agents block in CLAUDE.md is v1, expected v2 — re-run /projectstore:agents register.
  ⚠ [override-copies] Override copy critic.md overrides nothing. It registers as "critic" while the bundled
    agent registers as "projectstore:critic", so both exist side by side. Delete it — /projectstore:agents
    configure now records the model in .claude/projectstore.json and passes it per invocation.
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

Details that matter with several Claude sessions open on one project: each session shows **its own** epic/story (never a sibling's), a fresh session shows a friendly localized "no epic or story in this session yet" line instead of a blank, and the `[PS#0.22.0]` badge tells you at a glance the plugin is alive and which version. The badge names the version you actually have: the hook wires a version-free launcher that resolves the installed plugin on every render, so an update needs no restart to show up.

## What's in the box (v0.23)

- **20 commands** — `bind`, `scaffold`, `status`, `adr`, `spec`, `epic`, `story` (with `plan`/`close` lifecycle gates), `kanban`, `research`, `concept`, `meeting`, `runbook`, `search`, `review`, `statusline`, `doctor`, `reconcile`, `codemap`, `graph`, `agents`
- **Spec-first workflow (v0.14, ADR-007)** — a `spec` kind (the durable, normative "how" per subsystem: ADR references, numbered behavioral contracts, acceptance *additive* to the covered stories'), an opt-in vault policy (`spec_policy: required` in `<vault>/.projectstore.json`) under which every story must be covered by an `active` spec, and story lifecycle gates: `/projectstore:story plan` persists the implementation plan before code, `/projectstore:story close` persists the final summary and per-criterion evidence. Doctor enforces all of it; stories done before the policy stay exempt.
- **5 agents** — `critic`, `planner`, `reviewer`, `librarian`, `archaeologist` (read-only, fresh-context, model-configurable). Planner derives thin plans from spec contracts; reviewer checks additive acceptance and computes `code_refs` proposals from the story-scoped git diff.
- **4 passive skills** — decision detection, story completion, peer-review nudges, vault-native communication. They suggest; they never write.
- **1 doctor + reconcile** — deterministic health checks and one-command repair of every generated view, localization-aware via the heading registry (`scaffold/headings.json`) — indexes and section checks work in every bundled language, and a vault whose files were written in two of them still lints and reconciles
- **1 layout** — `engineering`, with templates in **6 languages**: English, Russian, Spanish, German, French, Simplified Chinese (localized UI strings included)
- **5 hooks** — session start (navigation skeleton + doctor line), tool use before and after (activity + per-session pointer + raw-edit nudge + entry-rule reminder + session-name offer), stop (the reminder's second carrier), pre-compact (one honest line in your `/compact` output)

**The roster rule**: ProjectStore bundles an agent only if the role *requires the vault* to make sense. General coding assistants belong to your own setup — our `planner`/`reviewer` are deliberately narrow, vault-aware specialists, not their replacements. `/projectstore:review` always spawns the scoped `projectstore:critic`. Note that our agents live under the `projectstore:` prefix and an agent of your own named `critic` lives under the bare name — **they coexist, neither replaces the other** (which is why we configure models per invocation rather than by copying agent files: ADR-008).

## Under the hood (the honest version)

- **Frontmatter is the source of truth.** The board, folder indexes, and code map are *generated views* — regenerate anytime (`kanban`, `reconcile`, `codemap`); hand edits can't permanently desync them.
- **Every write is approval-gated.** Commands render a draft in memory, show you path + content, and write only on Yes. Declining leaves the vault byte-for-byte unchanged.
- **Sessions don't step on each other.** Each Claude Code session registers under its own `session_id`; parallel sessions get warned about each other, and each status line shows only its own work.
- **`/compact` survival.** After a compaction, SessionStart adds a "where this session left off" block — the vault files the previous conversation touched and the artifact it was drafting — so the next agent resumes instead of re-deriving. PreCompact prints one line for you, and promises the handover only when it can actually check that it will happen.
- **Orientation is a map, not a copy.** SessionStart injects the layout's folders, what each is for, what is in flight, and the order to descend in — a few thousand characters that don't grow with the vault. Injecting the vault itself is how you exceed the hook output cap and get handed a file path instead of context.
- **Raw edits are expected, not punished.** If you (or the agent) edit vault markdown directly, a gentle nudge suggests running `reconcile` afterwards. The guarantees survive the easy path.
- **Your session gets named after the work it settled on.** Once a session's vault writes settle on an epic or a document, projectstore offers a name — `/rename ps-agents-statusline-v2` — and you press the button. Session names are how parallel sessions address each other, so this is coordination, not decoration. Measured at roughly one offer per session; the naive "rename on every change" rule fires 37 times in the worst recorded session.

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
| **v0.23** | The artifact-first order stops being advice and gets a mechanism. A session that writes to three or more distinct source files while no story is `in-progress` gets one advisory reminder — delivered as `additionalContext` on `PostToolUse`, with `Stop` as the fallback for a session that delegates all its writing. The design decision is to **detect the act, not classify the request**: "just add templates" produced fifty files once, so classifying request text was recorded as unenforceable and replaced by counting completed writes. Subagent writes count toward the score (they share the parent's `session_id`) but never receive the reminder, since a subagent cannot open a story. `doctor` gains the after-the-fact half, `work-without-story`, which is the only seam that sees Bash-mediated writes. The registration block goes to **v3** with the entry rule and an instruction-conflict clause, and a new SessionStart hook carries the same rules mechanically — a separate hook because hook output is capped at 10,000 characters per value and the vault map is already over it. Shipping with it: a hook-output shape guard, because a hook emitting a field its event does not carry runs, prints, exits zero and reaches nobody. **Migration**: run `/projectstore:agents register` once — every bound project reports an install issue until it does, which is how a block change reaches anyone at all | ✅ current |
| v0.24 | SessionStart orientation becomes a **navigation skeleton** instead of a copy of the vault. It used to inject every folder README — on a real vault that exceeded the 10,000-character hook output cap, so the harness wrote it to a file and handed the agent a path: orientation that costs a tool call to read. The skeleton is layout-derived and O(1) in vault size (folders, per-folder counts, each folder's own README preamble as its purpose, what is in flight, and the order to descend in), measured here at ~3.7 KB against 12.4 KB before, and every unbounded term is truncated at a declared cell rather than trusted to stay short. Its reads run under one 200 ms budget with named degradations — an expired in-flight scan says so rather than rendering an empty list, which would assert the vault is idle. Riding with it, the **PreCompact defect is closed**: that hook emitted `hookSpecificOutput`, which PreCompact does not accept, so every compaction printed a validation error and the packet reached nobody — and the invalid field sank the `systemMessage` alongside it. PreCompact now prints one line and claims the handover only when it can check it (manual trigger, `auto_inject` on, and a nonempty log before it promises recent files); the continuity itself is rendered by SessionStart on `source: "compact"`. Both name the in-flight artifact through one shared resolver. **Migration**: none — `inject_depth` is retired, and an existing config carrying it is simply ignored |  ✅ |
| v0.22 | Creation-time index updates become regenerations. The seven create commands (adr / spec / epic / concept / research / meeting / runbook) no longer append their folder-README row with the harness Edit tool — they run `reconcile --write --only indexes=<folder>` after the artifact lands, so the last derived-view write outside the core is gone: canonical order by construction, atomic replace, check-and-retry over the prose you own. It is also one approval instead of two — the creation Yes covers its index row, and the prompt discloses that the folder's whole managed table is regenerated (so a creation can also repair a stale row for another artifact). `draft.mjs` now emits `index.folder` so prose never derives a path (`runbook` lives in `ops/`), and its previewed row is rendered by the regeneration's own rules — for a new artifact the preview is byte-identical to what lands. Shipping with it: index-header matching is end-anchored, closing a silent data-loss path where a README with extra hand-added columns prefix-matched as the managed table and had those columns rewritten away, undetected by doctor. **Migration**: none for a vault at its fixed point; if your indexes drifted under the append era, run `/projectstore:reconcile` once so the first full-table rewrite happens in a previewed flow | ✅ |
| v0.21 | Four more template languages — Spanish (`es`), German (`de`), French (`fr`), Simplified Chinese (`zh`) — joining English and Russian. Each ships the full kind set plus localized statusline strings, and each registers its section headings, index-column names and evidence keyword in `scaffold/headings.json`, so doctor, reconcile and the story plan/close gates are as deterministic there as in English; a vault holding files written in two languages still lints and reconciles. Three places where the deterministic layer was still English-shaped are now registry-driven: both inline grammars accept the CJK-width colon (`— 证据：<test>` reads as evidence, and `— stories：<id>` still attributes to the named story instead of silently widening to all of them), and the lifecycle gates refresh a story's body footer in its own locale instead of only `en`/`ru`. A new `tests/locales.test.mjs` holds every bundled locale — the set is derived from `templates/`, not hand-listed — to a 13-contract spec, including gate insertion and a mixed-language vault. **Migration**: none — existing `en`/`ru` vaults are untouched; switch with `language:` in `.claude/projectstore.json` (new artifacts follow it, old files keep their headings and stay recognized) | ✅ |
| v0.20 | Vault link graph as a derived view: `graph.md` — nodes (layout artifacts keyed by full vault-relative path) plus typed edges (wikilink / mdlink / supersedes / spec-covers / spec-implements-adr / epic-contains / dead / ambiguous / out-of-scope) derived from body links and frontmatter relations; one grep returns an artifact's whole neighborhood, both directions. The design core is ONE shared link resolver in lib.mjs on the SPEC-002 identity machinery — doctor's wikilink check rides the same resolver (dead stays an issue, multi-candidate targets become a NEW `ambiguous` warn, path-qualified links resolve as paths instead of basenames), so the graph and doctor can never disagree about which body link is dead. Regenerated by `/projectstore:graph` and `reconcile --only graph`, staleness-checked like kanban/code-map; `generated_at` upgraded to a full ISO timestamp on all derived views. **Migration**: run `/projectstore:graph` once to mint graph.md (bare reconcile deliberately never creates it); sibling views regenerate byte-identical | ✅ |
| v0.19 | Atomic regeneration of derived views: `reconcile --write` applies the regeneration itself — every approved target is recomputed from the vault state at write time and replaced atomically (dot-temp + rename; the `.tmp` suffix keeps temps out of iCloud sync), so a stale preview is never what lands and a concurrent reader never sees a torn board. Folder-index READMEs get check-and-retry protection for the prose a human owns; `--only kanban|codemap|indexes[=folder]` selects targets and dies loudly on typos; partial failures report per-target and exit nonzero for cron callers — headless `--write` is a sanctioned repair job (ADR-009). **Migration**: none — regenerated bytes are identical to v0.18; no reconcile pass needed | ✅ |
| v0.18 | Slug-first artifact identity (ADR-010): new artifacts are named by slug alone (`adr/use-postgres.md`, `story-<slug>.md`) — sequence numbers stop being allocated, so concurrent sessions can never race for one; legacy numbers become display metadata and `external_refs: {}` is the designed home for Jira/YouTrack-style keys. Existing numbered files are grandfathered in place (no renames, both forms resolve indefinitely); the draft's `collision` field catches same-topic clashes an exact-path check cannot see; doctor gains identity-uniqueness, sync-conflict-filename and cross-folder-basename checks; indexes and kanban order by date with number-then-slug tiebreak. **Migration**: run `/projectstore:reconcile` once — index/board reordering is a generator diff, not a defect | ✅ |
| v0.17 | Configuring an agent's model no longer copies agent files into your project (ADR-008): a project copy stands *beside* the plugin agent instead of overriding it — verified by invoking both ids — so `/projectstore:agents configure` now records the model in `.claude/projectstore.json` and it rides each invocation. Doctor reports leftover copies as overriding nothing and reports `CLAUDE_CODE_EFFORT_LEVEL`; `effort` is no longer per-project. **Migration**: the routing block goes v1 → v2, so doctor asks once for `/projectstore:agents register` | ✅ |
| v0.16 | The status line renders the plugin version you actually have: session-start wiring now points at a version-free launcher (`.claude/.projectstore/statusline.mjs`) that resolves the installed plugin on every render — a pinned cache path made every update land one restart late, badge and behaviour both; doctor reports wiring and on-screen drift | ✅ |
| v0.15 | Doctor sees user-scope (`~/.claude/agents`) override copies and tells renamed from replaced legacy agents; all five bundled agents batch independent reads (librarian works from indexes first); `scripts/tokens.mjs` — token & cost accounting for vault work from Claude Code transcripts (`--runs`/`--sessions`/`--json`, priced with cache multipliers) | ✅ |
| v0.14 | Spec-first workflow (ADR-007): `spec` kind + `/projectstore:spec` with status transitions; vault-side `spec_policy`/`lifecycle_gates`; story lifecycle gates `/projectstore:story plan\|close` with evidence grammar; doctor spec/coverage/acceptance oracles; heading registry (ru vaults lint & reconcile); layout-driven kinds machinery (`extending.md` is now true); story-scoped `code_refs` from git diff; zero-dep test suite | ✅ |
| v0.13 | Umbrella `doctor` + `reconcile` + `codemap`; vault-aware agent suite — **breaking renames**: `projectstore:projectstore-critic` → `projectstore:critic`, `code-planner`/`code-reviewer` → vault-aware `planner`/`reviewer` — plus `librarian` & `archaeologist`; agents block + model presets + statusline offer at bind; per-session never-blank status line; unicode slugs; YAML-safe frontmatter | ✅ |
| v0.12 | Status line shows full epic & story titles (from frontmatter, not the filename) | ✅ |
| v0.11 | Status line install simplified — opt-in flag + self-healing SessionStart wiring | ✅ |
| v0.10 | Status line — current epic & story in the HUD, composes with an existing status line | ✅ |
| v0.9 | Bundled review agents (`projectstore-critic`, `code-planner`, `code-reviewer`) | ✅ |
| v0.8 | Russian (`ru`) templates | ✅ |
| v0.7 | First-run welcome (SessionStart one-shot), auto-update follow-up in `/projectstore:bind` | ✅ |
| v0.6 | Session isolation (Claude `session_id`), safer rebind, PreCompact `systemMessage` | ✅ |
| v0.5 | PreCompact survival packet | ⚠️ retired in v0.24 — the packet targeted `additionalContext`, which PreCompact does not have, so it never once reached a model |
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

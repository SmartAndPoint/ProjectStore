# How projectstore works under the hood

The README gives the short version; this is the deep dive for the curious. Nothing
here is required reading to use the plugin.

## The write path: draft → approval → file

Every create command follows the same shape:

1. `scripts/draft.mjs` renders the artifact **in memory** (it never touches the
   disk — no writes, no mkdir; declining leaves the vault byte-for-byte unchanged).
2. The command shows you the target path + full content via `AskUserQuestion`.
3. Only on **Yes** does the file land — and that same Yes covers the folder's
   index. The index row is not appended: the command regenerates the folder's
   managed table through the core (`reconcile --write --only indexes=<folder>`),
   so the row arrives in canonical order, the file is replaced atomically, and
   your own prose around the table is preserved. One consequence worth knowing:
   the regeneration rewrites the whole table, so creating one artifact can also
   repair a stale row for another.

Frontmatter scalars are rendered through a JSON-escaping form (`{{title_json}}`),
so titles containing `"` or `:` cannot corrupt the YAML. Slugs transliterate
Cyrillic (`Кэширование запросов` → `keshirovanie-zaprosov`) and never come out
empty.

## Sessions: how parallel Claude instances coexist

Each Claude Code session registers itself in the vault under its own
`session_id`:

```bash
$ ls <vault>/.projectstore/sessions/
d9149e0d-9169-43ef-b2c6-3e005a00e133.json   # session A — plugin dev
f05e61c5-f809-46e1-aa3e-b7c3366bc723.json   # session B — feature work

$ cat <vault>/.projectstore/sessions/f05e61c5….json
{
  "id":           "f05e61c5-f809-46e1-aa3e-b7c3366bc723",
  "project_root": "/Users/me/projects/myapp",
  "started_at":   "2026-05-19T13:35:36Z",
  "recent_activity": [
    { "path": "epics/WEB-101/epic.md", "tool": "Edit",  "at": "…" },
    { "path": "epics/WEB-101/stories/001-oidc-flow.md", "tool": "Write", "at": "…" }
  ]
}
```

When another session starts, SessionStart sees fresh sibling files (mtime < 30
min) and warns the new agent:

> ⚠️ Multi-session warning — 1 other projectstore session active on this vault.
> Run `/projectstore:search <topic>` before creating new artifacts.

Create commands additionally re-check file existence right before writing, so two
sessions can't silently overwrite each other's new artifact.

**The status line is stricter still**: it renders from a *per-session* pointer
(`<project>/.claude/.projectstore/state/<session_id>.json`, written by the
PreToolUse hook with denormalized titles) and performs **zero cross-session and
zero vault reads**. 2–6 parallel sessions each see exactly their own epic/story;
a fresh session gets a localized "no epic or story in this session yet" line; a
corrupt pointer shows an error marker, never a false "no work". The renderer also
drops a `.last-render.json` breadcrumb so `doctor` can detect session-id
divergence between the status line process and the hooks.

## Surviving `/compact`

Continuity across a compaction is delivered by **SessionStart**, not by
PreCompact — and that is a correction, not a design flourish. PreCompact has no
model-facing channel: it accepts a top-level `systemMessage` and nothing else,
so for its whole life the hook assembled a rich packet, printed a red *"Hook
JSON output validation failed"*, and reached nobody. Worse, the invalid field
sank the whole object, so the one line PreCompact *does* support never landed
either.

So the two hooks now split the work by what each can actually do.

PreCompact prints one line, for you:

```
PreCompact [...pre-compact.mjs] completed successfully: {
  "systemMessage": "projectstore: compacting — vault myapp-vault,
                    in flight: `epics/WEB-101/epic.md`,
                    orientation and this session's recent files return
                    at session start"
}
```

That last clause is conditional on purpose. It appears only when the compaction
is **manual** and `auto_inject` is on — the two things the hook can check at the
moment it speaks. On an automatic compaction the plugin makes no claim that
SessionStart fires at all, and under `auto_inject: false` the claim would be
flatly false, so the line offers `/projectstore:status` instead. The
recent-files half needs one more condition — a nonempty activity log — because
an empty one renders no continuity section at all.

SessionStart then fires with `source: "compact"` and renders a **Where this
session left off** block above the derived-views section: up to five vault files
the previous conversation touched, newest first, plus the newest structured
write as the in-flight artifact. Both hooks resolve that artifact through one
shared function, so the compaction line and the section that follows cannot name
different files seconds apart.

(Fine-grained "where exactly was my cursor" resume is the job of your task list
and `git status`; the vault answers "where were we going".)

## The status line composition trick

`statusLine` in Claude Code is a single slot, not plugin-declarable, and read
once when the session starts. So the SessionStart hook (when
`statusline.enabled` is true) points the project's `.claude/settings.local.json`
at a launcher it generates at `.claude/.projectstore/statusline.mjs`. Pointing
it straight at the plugin would pin a versioned cache path
(`…/projectstore/<version>/scripts/statusline.mjs`) and render the version
installed at the *previous* session start — every update arrived a restart late.
The launcher's path never changes, and it resolves the installed plugin from
Claude Code's own registry on each render. The script then **composes** instead of
clobbering: it re-runs whatever base statusLine command you already had (e.g.
oh-my-claudecode's HUD, taken from the project's `.claude/settings.json` if it
has one, else `~/.claude/settings.json`), prints its output
verbatim, and adds one `[PS#version] 📚 …` line above it (`statusline.position`:
`above`/`below`). With no base command it renders a standalone line.

## Doctor and reconcile: the trust layer

The vault's guarantees used to depend on everyone using the gated commands —
but agents (and humans) hand-edit markdown, because it's the path of least
resistance. v0.13 makes that safe instead of forbidden:

- **`doctor`** is a deterministic, no-LLM check engine (`scripts/doctor.mjs`).
  `--install` verifies the wiring (config, vault path, hooks firing, statusline,
  agents block, leftover agent copies, gitignore, marketplace auto-update);
  `--vault` verifies content consistency (status ↔ board ↔ indexes, acceptance
  boxes, dead and ambiguous wiki/relative links — resolved by the same shared
  resolver the link graph uses, so the two can never disagree about a body
  link — `code_refs`,
  code-map and graph staleness). A cheap
  subset runs at session start and prints one line only when something is wrong.
- **`reconcile`** rebuilds every generated view (kanban, folder indexes,
  code-map, the link graph) from the vault — the repair partner. Idempotent: a clean vault
  yields zero changes. Since v0.19 reconcile applies the write itself
  (`--write`): each approved target is recomputed from the vault state at
  write time and replaced atomically, so a stale preview is never what lands;
  `--write` is also a sanctioned headless entry point (cron/CI repair job).
- A throttled PreToolUse **nudge** fires when vault files are edited directly:
  "run reconcile afterwards so the derived views stay in sync" (disable with
  `"guard": "off"` in `projectstore.json`).
- A once-per-session **entry reminder** fires on PostToolUse when a session has
  written to three or more distinct *source* files and no story is `in-progress`:
  "open it in the vault before going further". PostToolUse, not PreToolUse, so
  declined edits are not counted as work that happened; `Stop` is the fallback
  carrier for a session that delegates all its writing to subagents and then
  answers without a tool call of its own. Subagent writes count toward the score
  but never receive the reminder — a subagent cannot open a story. A session
  launched with `--agent` carries an agent identity on every call and is
  therefore never reminded either; for those sessions `doctor`'s
  `work-without-story` is the only coverage. The same
  `"guard": "off"` silences it, and silences both nudges together. Firings are
  appended to `.claude/.projectstore/entry-log.jsonl` (machine-local, since
  `.claude/` is gitignored) so `doctor` can report whether the prompt was ever
  delivered — a mechanism that cannot say whether it worked is indistinguishable
  from one that does not.
- `doctor` carries the after-the-fact half: **work-without-story** warns when the
  project tree is dirty and no story is in progress. It is the only seam that
  sees Bash-mediated writes, which bypass hook path extraction entirely.

The division of labor: deterministic checks catch the mechanical 90% for free;
the LLM critic (`/projectstore:review`) is saved for the judgment calls.

## The epic ↔ code mapping

Epics and stories carry a `code_refs` frontmatter list — the paths that feature
actually owns in the codebase (`["src/auth/", "adapters/csv/"]`). The
`/projectstore:codemap` command is the only writer (`codemap set`), the
`planner` agent reads them to keep new epics consistent with how old ones
landed, the `reviewer` proposes updates when a story completes, and
`code-map.md` is the generated overview. Doctor checks refs status-aware:
`planned` work may point at code that doesn't exist yet; `in-progress`/`done`
refs must resolve.

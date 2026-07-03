# How projectstore works under the hood

The README gives the short version; this is the deep dive for the curious. Nothing
here is required reading to use the plugin.

## The write path: draft → approval → file

Every create command follows the same shape:

1. `scripts/draft.mjs` renders the artifact **in memory** (it never touches the
   disk — no writes, no mkdir; declining leaves the vault byte-for-byte unchanged).
2. The command shows you the target path + full content via `AskUserQuestion`.
3. Only on **Yes** does the file land, and the folder's index README is updated
   (its own approval).

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

When context is about to be compacted (manual or automatic), the PreCompact hook
hands the post-compact agent a *survival packet* and prints one line so you see
it ran:

```
PreCompact [...pre-compact.mjs] completed successfully: {
  "systemMessage": "projectstore: survival packet injected —
                    vault myapp-vault, layout engineering, 3 recent file(s),
                    in-flight: epics/WEB-101/epic.md"
}
```

The packet carries the vault path, the command list, the last 15 vault touches,
and the newest in-flight artifact — project-level orientation. (Fine-grained
"where exactly was my cursor" resume is the job of your task list and `git
status`; the vault answers "where were we going".)

## The status line composition trick

`statusLine` in Claude Code is a single slot and not plugin-declarable. So the
SessionStart hook (when `statusline.enabled` is true) points the project's
`.claude/settings.local.json` at the current plugin version's
`scripts/statusline.mjs` — re-derived every session start, so it survives plugin
updates with no hand-maintained path. The script then **composes** instead of
clobbering: it re-runs whatever base statusLine command you already had (e.g.
oh-my-claudecode's HUD, found in `~/.claude/settings.json`), prints its output
verbatim, and adds one `[PS#version] 📚 …` line above it (`statusline.position`:
`above`/`below`). With no base command it renders a standalone line.

## Doctor and reconcile: the trust layer

The vault's guarantees used to depend on everyone using the gated commands —
but agents (and humans) hand-edit markdown, because it's the path of least
resistance. v0.13 makes that safe instead of forbidden:

- **`doctor`** is a deterministic, no-LLM check engine (`scripts/doctor.mjs`).
  `--install` verifies the wiring (config, vault path, hooks firing, statusline,
  agents block, model override copies, gitignore, marketplace auto-update);
  `--vault` verifies content consistency (status ↔ board ↔ indexes, acceptance
  boxes, dead wiki/relative links, `code_refs`, code-map staleness). A cheap
  subset runs at session start and prints one line only when something is wrong.
- **`reconcile`** rebuilds every generated view (kanban, folder indexes,
  code-map) from frontmatter — the repair partner. Idempotent: a clean vault
  yields zero changes.
- A throttled PreToolUse **nudge** fires when vault files are edited directly:
  "run reconcile afterwards so the derived views stay in sync" (disable with
  `"guard": "off"` in `projectstore.json`).

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

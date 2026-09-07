---
description: When communicating with the user about anything stored in the projectstore vault (epics, stories, ADRs, research, kanban, backlog), reference every artifact by its human title from frontmatter — never by session-invented shorthand. Name the parent epic for stories; include status/priority when discussing state or plans. Applies by default in bound projects to summaries, plans, and progress reports.
---

# Vault-native communication

Vault artifacts are the shared vocabulary between the user, this session, *other*
sessions, and the post-compact agent. A title written in a file can be grepped,
linked, and recognized in Obsidian six months from now. A label invented mid-session
("T3", "P0-1", "the doctor story") dies with the session that coined it — and forces
the user to cross-reference your earlier messages just to know what you meant.

## Rules

### 1. Call artifacts by their `title:`, not by number or slug

```
bad:  story-004 is done, story-005 is next
good: "Unicode-aware slugify to unbreak ru filenames" (story-004) is done;
      "YAML-escape template variables" (story-005) is next
```

The id in parentheses is welcome — as a *supplement*, never the only handle.

### 2. Stories always carry their epic

First mention in a message names both; after that a short form is fine.

```
bad:  let's start with story-001
good: let's start with "doctor: deterministic consistency lint" (PS-IMPROVE › story-001)
then: doctor lint story (story-001)
```

### 3. Resolution order for the name

`title:` from frontmatter → filename without extension → relative path.
Never a bare number ("story 3", "the second ADR").

### 4. Plans and progress carry status (and priority when it matters)

```
bad:  the epic is moving along
good: epic "Reliability by construction" (PS-IMPROVE, p0): 2 of 6 stories done,
      "reconcile: re-derive kanban and indexes from frontmatter" is in-progress
```

### 5. Document-internal codes stay inside their document

If a note defines its own legend (e.g. topics T1–T6 in a research note), those codes
are fine *within that document*. In chat, expand them on first use in every message:

```
bad:  I suggest T3+T4 first, then T2/T6, T5, T1
good: I suggest starting with the agent-roster topics — "which new roles fit" and
      "rename projectstore-critic → critic" (topics 3–4 in research "v0.13 Design
      Questions: Statusline, Agents, Doctor, Model Config") — their naming decisions
      leak into every other ADR's wording
```

### 6. Link the file when the user may want to open it

`epics/PS-IMPROVE/stories/story-001-doctor-deterministic-consistency-lint.md` —
paths are clickable in the terminal and resolvable in Obsidian. Title first,
path as the pointer.

## When this applies

- Any user-facing message *about vault contents*: status summaries, "what's next",
  planning discussions, review results, kanban talk, backlog updates.
- Artifacts you write into the vault: related-links and prose references use titles
  and wiki-links, not invented codes.

## When it does NOT apply

- Short confirmations ("done", "committing now") with no artifact references.
- Raw command output, code blocks, file paths inside tool calls.
- Frontmatter ids themselves (`id: story-001` stays an id — that's its job).

## Anti-patterns

- ❌ "T3+T4 first, then T2/T6" — bare document-internal codes leaked into chat.
- ❌ "P0-1 through P0-6 are specced" — priority labels used as names.
- ❌ "the doctor story" when two doctor-shaped items exist (install diagnostics vs
  vault consistency lint) — ambiguity is exactly what titles prevent.
- ❌ Renaming an artifact in conversation ("the reliability epic" for an epic titled
  "Reliability by construction" is fine as a gloss — but don't *invent* a different
  working title and keep using it).

## Activation

Default-on when a vault is bound (`.projectstore/projectstore.json` exists) and
`active_skills` is not `false` — same gating as the other passive skills. Silent
otherwise. This skill changes *how you phrase things*; it never writes files and
never blocks an action.

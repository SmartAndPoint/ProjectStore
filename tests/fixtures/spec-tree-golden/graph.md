---

projectstore: derived
generated_at: <t>

---

# Vault link graph

Nodes (layout artifacts, keyed by vault-relative path) and typed edges,
derived from body links and frontmatter relations (source of truth).
Regenerate via `/projectstore:graph`; grep a path to see an artifact's
full typed neighborhood, both directions, in one call.

## Nodes

| Path | Title | Type | Status |
|------|-------|------|--------|
| epics/PS-X/epic.md | X | epic | in-progress |
| epics/PS-X/stories/story-t.md | T | story | in-progress |
| specs/api-auth.md | API sign-in | spec | active |
| specs/api-queue.md | API job queue | spec | active |
| specs/api.md | API service | spec | active |
| specs/app.md | Shop app | spec | active |
| specs/below-loop.md | Below the loop | spec | active |
| specs/lone.md | A lone spec | spec | active |
| specs/loop-a.md | Loop A | spec | active |
| specs/loop-b.md | Loop B | spec | active |
| specs/web-cart.md | Web cart | spec | active |
| specs/web.md | Web front end | spec | active |

## Edges

| From | Kind | To |
|------|------|----|
| epics/PS-X/epic.md | epic-contains | epics/PS-X/stories/story-t.md |
| epics/PS-X/epic.md | mdlink | epics/PS-X/stories/story-t.md |
| specs/api-queue.md | spec-covers | epics/PS-X/stories/story-t.md |

---
description: Create a spec (normative "how" covering one or more stories), or transition its status (draft → active → superseded).
argument-hint: <title> | activate <SPEC-ID> | supersede <SPEC-ID>
---

You are managing a **spec** — the durable, normative "how" of a subsystem
(ADR-007): it references the ADR(s) that decided the approach, carries numbered
behavioral contracts, and its Acceptance is **additive** to the covered
stories' own criteria. One spec covers one or more stories and outlives them.

Dispatch on the first argument:

- `activate <SPEC-ID>` / `supersede <SPEC-ID>` → **Status transition flow**.
- Anything else → **Creation flow** (the whole argument string is the title).

## Creation flow

1. **Check config**: stop if `.projectstore/projectstore.json` missing.

2. **Render draft**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/draft.mjs" spec "$ARGUMENTS"
   ```

   Capture the JSON `{ kind, path, content, index, vars }`.

3. **Fill before preview**: populate `adr: []` and `stories: []` (path form:
   `"EPIC-ID/story-002"`, inline flow) from the conversation context when
   known; write the mandatory sections (How we solve with ADR wiki-links,
   numbered Behavioral contracts, Acceptance checkboxes with `— stories:`
   attribution where items are story-specific). Optional sections (Modules &
   files on disk, Testing) may be omitted for research spikes.

4. **Preview**: path + full content, plus every `warnings` entry as a `⚠️`
   line. If the draft's `collision` field is non-null, surface it as a
   **topic collision** (`"<identity>" already exists as <with>`) and ask:
   extend the existing spec, pick a different slug (`-2` is a deliberate
   distinct identity), or cancel. When `index` is non-null, print `index.line`
   too — the exact row that will appear in `specs/README.md`, unless the index
   step reports a failure and no row lands at all. **Approval** via
   AskUserQuestion: Yes / Edit / No. This is the only gate: **Yes** covers the
   artifact and its index row. Disclose in the question that the folder's whole
   managed index table is regenerated from vault state at write time, so the
   update may also repair a stale row for another artifact.

5. **Post-approval race re-check**: re-run draft.mjs and re-read `collision`
   — an exact-name `test -e` cannot see normalized cross-era collisions. If
   it is now non-null, re-preview and re-ask.

6. **On Yes**: Write the file. Then, if `index` is non-null, apply its index
   row through the core — never the Write/Edit tools, no second gate (the
   step-4 approval covers it):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" reconcile --write --only indexes=<index.folder>
   ```

   The row is derived state — regenerated in canonical order, written
   atomically, manual prose preserved. The artifact is already on disk, so a
   nonzero exit is a warning naming the folder (stderr with no JSON = rejected
   before any write, fix the header or restore the README; per-target `error`
   in JSON = I/O failure, suggest `/projectstore:reconcile`), never a failed
   creation.

7. **Reciprocal links**: for every entry in `stories:`, propose an Edit to that
   story's frontmatter adding the spec id to its `specs:` list (inline flow —
   `specs: ["SPEC-001"]`). One AskUserQuestion per file.

8. **Remind**: "The spec is `draft`. Run `/projectstore:spec activate <ID>`
   after review — a covered story must not enter implementation while its spec
   is draft (doctor enforces this under `spec_policy: required`)."

## Status transition flow

1. **Resolve** the spec file in `<vault>/specs/` by id (case-insensitive
   prefix match on the filename). If not found, list existing specs and stop.

2. **Validate the transition**: `draft → active` (activate), `active →
   superseded` (supersede). Reject anything else with the current status
   shown. `superseded` requires the user to name what supersedes it — record
   it in the body under References.

3. **Preview the change**: current vs proposed frontmatter `status:` (+
   `updated:` bump to today). For `activate`, remind that review is expected
   first (`/projectstore:review <path>`) if `review_status` is still pending —
   ask whether to proceed anyway.

4. **Approval** via AskUserQuestion, then apply the Edit (frontmatter lines
   only). Suggest `/projectstore:reconcile` if the specs index shows a stale
   status.

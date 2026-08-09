# Extending projectstore

## Adding a new artifact kind — the honest checklist

Since v0.14 the kind machinery is layout-driven: `draft.mjs` builds ANY kind
declared in the layout, and doctor's template check follows the layout instead
of a hardcoded list. A new kind needs **five touch points** — note that **all
five live inside the plugin installation**, not in your vault (there is no
vault-side layout or template override):

1. **Layout folder entry** — `scaffold/layouts/<name>.json` → `folders`:

   ```jsonc
   { "path": "specs", "kind": "spec", "readme": true, "numbered": true, "prefix": "SPEC-", "pad": 3 }
   ```

   Since v0.18 every kind creates **slug-only filenames** (`<slug>.md`;
   stories keep the `story-` marker: `story-<slug>.md`) — identity lives in
   the slug, sequence numbers are no longer allocated (ADR-010), which makes
   concurrent creation collision-free by construction. `numbered` + `prefix`
   + `pad` stay declared for **grandfathered** vaults: the prefix drives
   legacy-number stripping in identity matching and the index label badge
   (`SPEC-002` rows keep their labels; slug rows are labelled by slug).
   `date_prefix: true` gives `YYYY-MM-DD-slug.md`. The epic folder
   additionally accepts `story_prefix` (default `story-`) for its stories'
   kind marker; `story_pad` remains recognized but only describes legacy
   files.

2. **Layout command entry** — the same file's `commands` array. A command
   needs a template only if it maps to a declared folder kind (`story` maps
   through the `epic` folder; `kanban` through the `kanban` block). Folders
   without a command (e.g. `diagrams`) need no template.

3. **Template** — `templates/en/<kind>.md.tmpl` (and `templates/ru/…`).
   Variables filled by `scripts/draft.mjs`: `{{date}}`, `{{author}}`,
   `{{tags}}`, `{{title}}`, `{{slug}}`, `{{id}}` (the exact machine id: the
   slug itself; `story-<slug>` for stories), `{{epic_id}}` (stories). Use
   `{{x_json}}` for any frontmatter scalar — it renders as a valid YAML
   double-quoted string. Frontmatter should carry `id:` and an inline-flow
   `external_refs: {}` (the designed home for Jira/YouTrack-style keys —
   ADR-010); `number:` is optional display metadata, never identity. The
   template's own frontmatter `status:` is what the index row shows at
   creation (derived, never hardcoded).

4. **Checklist entry** — `scaffold/checklists.json`, consumed by
   `/projectstore:review` and the peer-reviewer skill. English-only by design.

5. **Command prompt** — `commands/<kind>.md`, a prompt (not code) that calls
   `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" <kind> "$ARGUMENTS"`, previews,
   and gates every write behind AskUserQuestion. Copy `commands/research.md`
   for a plain kind, `commands/adr.md` for one that renders the draft's
   `collision`/`warnings` fields and updates an index, `commands/spec.md`
   for one with status transitions.

If the kind introduces **new section headings or inline keywords** that
deterministic checks must recognize (doctor, reconcile, story-section),
register their en+ru forms in `scaffold/headings.json` — matchers accept every
registered language, so a ru-headed file lints in an en-bound vault.

## Adding a new layout

A layout is a JSON file at `scaffold/layouts/<name>.json` declaring folders,
kinds, commands, agents and (optionally) a kanban block — see
`engineering.json` for the full shape. Every command that maps to a folder
kind needs its template per the checklist above.

## Adding a new command

Create `commands/<name>.md` with frontmatter:

```yaml
---
description: One-line summary shown in `/help`.
argument-hint: <expected args>
---
```

Body is a **prompt** for Claude — instructions, not code. To do real work, call
the plugin's scripts via Bash. Always gate writes through `AskUserQuestion`
after showing a preview. Scripts are pure compute (they never write); the
command writes after approval — keep that split.

## Adding a new skill

Skills passively watch the conversation and suggest commands. Create
`skills/<name>/SKILL.md`:

```yaml
---
description: When [trigger condition], suggest [the relevant /projectstore:* command]. Never write to disk directly.
---
```

The `description` field is what Claude uses to decide activation. Be specific
about triggers, and include an Anti-patterns section.

## Adding a new language

Mirror `templates/en/` to `templates/<lang>/` and translate the bodies.
Frontmatter keys stay English (machine-readable). Additionally register the
language's heading/keyword/index-column forms in `scaffold/headings.json` —
without that, doctor's section checks and reconcile's index rebuild silently
skip files in that language. `templates/<lang>/strings.json` localizes the
statusline only.

## Vault-side policy

`<vault>/.projectstore.json` (vault root — committed with the vault, survives
clones) carries `spec_policy: required|optional`, `lifecycle_gates: on|off`,
and `spec_policy_since` (ISO-8601). See ADR-007 in the project vault and
`commands/doctor.md` for which checks each key activates.

## Contributing back

PRs welcome at https://github.com/SmartAndPoint/ProjectStore. Prefer one
focused PR per layout / template / skill. Include a sample output in your PR
description.

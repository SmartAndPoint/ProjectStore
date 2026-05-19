# Extending projectstore

## Adding a new layout

A layout is a JSON file at `scaffold/layouts/<name>.json` that declares folders, their kinds, and which commands operate on them.

Example minimal layout `scaffold/layouts/data-analytics.json`:

```jsonc
{
  "name": "data-analytics",
  "description": "Data analytics project: hypotheses, experiments, datasets, findings.",
  "folders": [
    { "path": "hypotheses", "kind": "hypothesis", "readme": true, "numbered": true, "prefix": "H-", "pad": 3 },
    { "path": "experiments", "kind": "experiment", "readme": true, "numbered": true, "prefix": "E-", "pad": 3 },
    { "path": "datasets", "kind": "dataset", "readme": true },
    { "path": "findings", "kind": "finding", "readme": true, "date_prefix": true },
    { "path": "reports", "kind": "report", "readme": true }
  ],
  "commands": ["hypothesis", "experiment", "dataset", "finding", "report"]
}
```

Each `folder.kind` must have a matching template at `templates/<lang>/<kind>.md.tmpl`.

## Adding a new template

Templates are plain markdown with `{{var}}` placeholders. Available variables (filled by `scripts/draft.mjs`):

- `{{date}}` — `YYYY-MM-DD`
- `{{author}}` — from `default_author` config or `$USER`
- `{{tags}}` — JSON array from config `tags`
- `{{title}}` — passed by the user
- `{{slug}}` — kebab-case of title
- `{{id}}`, `{{number}}` — for numbered/prefixed kinds
- `{{epic_id}}` — for stories

Drop the file at `templates/en/<kind>.md.tmpl` (and optionally `templates/ru/<kind>.md.tmpl`).

## Adding a new command

Create `commands/<name>.md` with frontmatter:

```yaml
---
description: One-line summary shown in `/help`.
argument-hint: <expected args>
---
```

Body is a **prompt** for Claude — instructions, not code. To do real work, call the plugin's scripts via Bash:

```markdown
Run: `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" <kind> "$ARGUMENTS"`
```

Always gate writes through `AskUserQuestion` after showing a preview.

## Adding a new skill

Skills passively watch the conversation and suggest commands. Create `skills/<name>/SKILL.md`:

```yaml
---
description: When [trigger condition], suggest [the relevant /ps:* command]. Never write to disk directly.
---

# Skill name

[Trigger conditions]

## What to do

1. Check `.claude/projectstore.json` exists and `active_skills: true`.
2. ...
3. Suggest the command, wait for confirmation.

## Anti-patterns

- Don't write directly.
- Don't trigger too often.
```

The `description` field is what Claude uses to decide activation. Be specific about triggers.

## Adding a new language

Mirror `templates/en/` to `templates/<lang>/` and translate the bodies. Frontmatter keys stay English (they're machine-readable). The `language` field in `.claude/projectstore.json` selects which directory `draft.mjs` reads.

## Contributing back

PRs welcome at https://github.com/SmartAndPoint/projectstore. Prefer one focused PR per layout / template / skill. Include a sample output in your PR description.

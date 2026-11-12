# Extending projectstore

## Adding a new artifact kind — the honest checklist

Since v0.14 the kind machinery is layout-driven: `draft.mjs` builds ANY kind
declared in the layout, and doctor's template check follows the layout instead
of a hardcoded list. A new kind needs **six touch points** — note that **all
six live inside the plugin installation**, not in your vault (there is no
vault-side layout or template override). The one exception is the guide
(step 4): a vault may override it, file by file.

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
   creation (derived, never hardcoded), and its `date:` (or `created:`) is
   the index row's date. Carry one of them: with neither, the date cell
   renders empty — consistently, in both the preview and the written row —
   but an empty date sorts first, so the kind's rows pile up at the top of
   its index and stay there.

4. **Guide file** — `scaffold/guides/<kind>.md`, the kind's authoring guide:
   frontmatter `guide_for: <kind>`, `guide_version: 1` and `default_review`
   (bare values, no trailing comments), then `## Lens`, `## Must`,
   `## Common mistakes`, `## Do not write` and `## Length`. Only `## Must` is
   required; its plain bullets are the checklist the critic checks. The kind's
   command reads the guide before the draft, `/projectstore:review` and the
   critic check its `## Must`, and the `projectstore-peer-reviewer` skill reads
   its `default_review`. The headings are English in every vault language; the
   package defaults are English only. Bump `guide_version` whenever you change
   a default's text, then record it:

   ```
   node tests/fixtures/guides.mjs --write
   ```

   A project overrides a guide in its vault, as `<vault>/guides/<kind>.md`,
   which replaces the package file whole. To start from the default:

   ```
   npx projectstore guide eject <kind> --write
   ```

   Doctor reports a vault guide that does not parse (`guide-shape`), names an
   unknown kind (`guide-unknown`), or was made from an older default
   (`guide-stale`).

5. **Command prompt** — `commands/<kind>.md`, a prompt (not code). It renders
   the draft with the line below, previews it, and gates every write behind
   AskUserQuestion:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/draft.mjs" <kind> "$ARGUMENTS"
   ```

   Copy `commands/research.md` for a plain kind, `commands/adr.md` for one
   that renders the draft's `collision`/`warnings` fields and updates an
   index, `commands/spec.md` for one with status transitions.

6. **Folder strings** — `templates/<lang>/strings.json` → `folders.<kind>`,
   a `name` and a one-line `description`, in **every** bundled language's
   file. `scaffold` (and `init`) render the folder's README and its row in
   the vault's top-level README from them, and refuse a layout whose folder
   kind has no string in the bound language, naming the kind and the
   language; doctor warns about the same gap. Every folder kind needs one,
   with or without a command (`diagram` too). Keep the description to 160
   characters with no `|`: the SessionStart skeleton shows it as the
   folder's Purpose cell. Machine tokens such as `stories/` stay as they are.

If the kind introduces **new section headings or inline keywords** that
deterministic checks must recognize (doctor, reconcile, story-section),
register a form per bundled language (en, ru, es, de, fr, zh) in
`scaffold/headings.json` — matchers accept every registered language, so a
ru-headed file lints in an en-bound vault.

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

Bundled: `en`, `ru`, `es`, `de`, `fr`, `zh`. To add another:

Mirror `templates/en/` to `templates/<lang>/` and translate the bodies.
Frontmatter keys **and their values** stay English (`status: planned` is
machine-read; only prose and table labels get translated). Then register the
language's heading, keyword, index-column and field-label forms in
`scaffold/headings.json` (the field labels are `fields.status`,
`fields.assignee`, `fields.updated` and `fields.story`; the `status_log`,
`stories` and `expected_results` headings are among the headings), and
add the locale to `LOCALES` in `tests/locales.test.mjs` so the suite actually
runs over it. `templates/<lang>/strings.json` localizes the statusline and the
folder names and descriptions `scaffold` writes into the READMEs
(`folders.<kind>`, one per kind the layout declares — touch point 6 above),
and `vault-readme.md.tmpl` is the vault's top-level README. There is no English
fallback for either: a language that lacks one is refused by `scaffold`.

Skipping the registry does not produce one clean error — it degrades *unevenly*,
which is why the spec exists: an unregistered index header raises a doctor
`index-header` warn while reconcile drops the same index silently; an
unregistered `acceptance` heading is silent everywhere; an unregistered
`implementation_plan` is misdiagnosed as "this done story has no Implementation
Plan"; and `heading(id, lang)` falls back to English, so the lifecycle gates
write English headings into an otherwise translated story.

Constraints the deterministic scripts impose on the translation:

- **Every heading must match *some* registered form.** `insertSection` guards on
  `headingLineRe`, which accepts every registered form of every language — so a
  heading in another locale's form is filled, not duplicated. Only a spelling
  registered nowhere makes the gate append a second section beside it.
- **Use the FIRST form of your language** — that is what `story-section` writes
  when it has to insert, so agreeing with it keeps written and rendered
  documents identical. This is a convention; the gate does not enforce it.
- **No form may match two ids.** Keep the `acceptance` ("Acceptance Criteria")
  and `spec_acceptance` ("Acceptance") headings distinct in your language;
  matching is whole-line, so a prefix relationship is fine but equality is not.
- **The folder-README index header must use the registered column names —
  exactly those four, and no more** — and the separator row under it must stay
  a plain `|---|---|---|---|`. Matching is end-anchored: adding a fifth column
  of your own does not extend the managed table, it stops being one. That is
  deliberate — an unanchored match let the regeneration rewrite your extra
  column away. An unrecognized header is now loud in both directions: doctor
  warns, and a creation into that folder fails its index step on stderr
  (the artifact still lands — see the failure prose in the create commands).
- **Inline grammars carry a keyword and a colon**: the evidence suffix on a
  checked criterion and the `stories:` attribution on a spec acceptance item.
  Both accept the CJK-width colon (`evidenceSuffixRe` / `storiesAttributionRe`
  in `lib.mjs`); if your language punctuates differently, widen them there
  rather than working around it in the template.

Where two spellings are realistic (Russian `ё`/`е`, a French typographic vs
ASCII apostrophe), register both: the first is written, all are accepted. No
test can decide "realistic" — have someone who reads the language check it.

Domain terms follow the language's practitioners, not the dictionary. `epic`
and `story` are localized where the field localizes them (`ru` "Эпик", `es`
"Épica") and left in English where teams say the English word (`de`, `fr`,
`zh`). Nothing reads most table labels, so the only cost of getting one wrong
is that the document reads like a translation. Two are read: the story
header's **Status** and **Assignee** rows, and the Status column of an epic's
Stories table. Scripts find them through `fields` in the registry, so the
template must spell them in the first registered form;
`tests/locales.test.mjs` checks it for every bundled locale.

The bundled set is currently spelled out by hand in four places (the test's
`LOCALES`, the registry's `_description`, this page, `commands/bind.md`) with
nothing checking that they agree — see the PS-I18N epic's backlog.

## Vault-side policy

`<vault>/.projectstore.json` (vault root — committed with the vault, survives
clones) carries `spec_policy: required|optional`, `lifecycle_gates: on|off`,
`spec_policy_since` and `gates_since` (ISO-8601). See ADR-007 and the spec
policy ADR in the project vault, and `commands/doctor.md`, for which checks
each key activates.

- `configure` stamps `spec_policy_since` when the policy becomes `required`,
  and `gates_since` when the lifecycle gates turn on. A done story closed
  before the date is legacy. The lifecycle checks read `spec_policy_since`,
  then `gates_since`.
- A story may declare `no_spec: "<reason>"` at the plan gate instead of a
  covering spec. Under `required`, doctor accepts it. Under any policy it
  checks the declaration:
  - an empty reason, or `no_spec` beside `specs:`, is an issue;
  - three or more source files in the story's `code_refs` is a warn;
  - when opt-outs outnumber covered stories among code stories, that is a
    warn.
- `doctor --vault --policy required[@<date>]` shows what `required` would
  report, without writing anything.
- `flow` holds the team's flow policy: `wip.full` and `wip.part`, a
  `people` map from each assignee's name to `time` (`full` or `part`), an
  optional own `wip`, `git_names` and `left`, ages in days under `age_days`,
  and `idle_days`, `window_weeks`, `capacity_weeks` (`[low, high]`),
  `active_epics_max` and `grooming_days`. `groomed_at` is a stamp. No key has
  a default in code, and a value of the wrong type counts as absent. A
  person's WIP limit is their own `wip`, else `wip.<time>`, else none
  (`wipLimitOf` in `scripts/flow-policy.mjs`). `configure --set` writes these
  keys and merges them into the block, keeping the rest. Names are the
  assignee as stories write it, never an email address. A `git_names` entry may
  hold `@`, but `configure --set` refuses one that is, or holds, an email
  address.
- Every change of a story's `status` or `assignee`, at the gates or through
  `move`, stamps `status_changed_at` (for a status) and appends one line to
  the story's `## Status log`:
  `- <ISO> <field>: <from> → <to> — <reason> (<actor>)`, with `none` for an
  empty side. The tokens stay English in every locale. A stamp is trusted
  only when the last `status:` line's time and target match the story;
  otherwise its age in status is read from `updated` (`statusStamp` in
  `scripts/status-log.mjs`), else `created`. Both instants are read through
  `stampMs`, so a stamp with no zone is UTC on every machine.
  `move <story> todo|planned --reason "<why>"` is the one change no gate makes.
- Doctor's flow checks (`scripts/doctor-flow.mjs`) read the `flow` block. A
  check whose key is absent, or outside its key's set, does not run. They count
  through `scripts/flow-counts.mjs`, which is pure and takes the as-of instant
  as an argument, so a derived view gets the same counts for the same instant.
  Stories come from `scripts/flow-stories.mjs`, the board's reader. Idle work
  and idle people are read from the project's local commits, through one
  `git log` per run (`commitsSince` in `scripts/diff-refs.mjs`), by author and
  committer name only. Every flow finding is a warn or an info, never an
  issue. The group runs in `doctor --vault` and never at session start.
- An epic becomes done by the epic rule (`applyEpicRule` in
  `scripts/epic-rule.mjs`), which the story command's close runs after the
  epic row: its own status is neither done nor set aside, at least one story
  is done and every other is done or set aside (`NOT_ACTIONABLE` in
  `scripts/stages.mjs`), no open row of its Stories table lacks a story file,
  and every checkbox under its Expected Results is checked. It reads state,
  not events, so the next close finishes an epic a failed write left. It
  never moves an epic back. Doctor's `epic-status` counts a story as open by
  the same test (`storyState`), so a set-aside story never flags a done
  epic. The rule finds the Stories and Expected Results headings and the
  epic's Status, Updated and Story labels through the registry, so a
  translated epic template must spell them in the first registered form.

## Contributing back

PRs welcome at https://github.com/SmartAndPoint/ProjectStore. Prefer one
focused PR per layout / template / skill. Include a sample output in your PR
description.

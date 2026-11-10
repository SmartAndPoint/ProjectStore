# Contracts and tests

A spec's behavioral contracts are numbered and testable. This page shows how
to write a contract so a test follows from it, how a test cites the contract
it covers, and what doctor reports. It describes Part A of the ADR *Spec
policy, revised: contract scenarios and test citations that doctor counts,
and a declared per-story opt-out from a spec*, and decisions 6 and 7 of the
ADR *One authoring guide per artifact kind, read by the author before the
draft and by the critic after, overridable from the vault* (edge and failure
marks, and test stories), and the ADR *An active spec is amended by a marked
block under the contract, naming the story, the date and the kind, which
doctor checks and the graph draws* (amendment markers).

All of it is optional. A spec without scenarios, and a test without a
citation, stay valid.

Every example on this page uses the key `example`. It is reserved: no spec
may use it as an id or alias, so a token written with it never resolves and
never counts as coverage. A real token in a doc would count, so docs use only
`example`.

## Scenarios under a contract

A contract may carry list items that start with `WHEN`, `GIVEN`, `AND` or
`THEN`:

```markdown
3. **A stale index is reported.** Doctor compares each folder index with the
   artifacts on disk and reports a row that no longer matches.
   - GIVEN an index row whose status differs from the artifact's frontmatter
   - WHEN doctor runs with --vault
   - THEN it reports an index finding that names the folder
```

The items are a list, so Markdown keeps one step per line. The keywords stay
in English in every language, like `— stories:`: a tool matches them
literally.

Doctor reads scenarios for two things. If a contract's scenario has no
`WHEN` (or `GIVEN`), or no `THEN`, it reports an info. And it counts the
scenarios marked as an edge or a failure case, below.

An item may wrap: a line indented deeper than its dash, before a blank line,
belongs to the item above it.

## Marking an edge or a failure case

A scenario's `WHEN` or `GIVEN` item may end with `(edge)` or `(failure)`:

```markdown
3. **A stale index is reported.** Doctor compares each folder index with the
   artifacts on disk and reports a row that no longer matches.
   - GIVEN an index row whose status differs from the artifact's frontmatter
   - WHEN doctor runs with --vault
   - THEN it reports an index finding that names the folder
   - GIVEN a folder whose README is missing (edge)
   - WHEN doctor runs with --vault
   - THEN it reports the missing index, and nothing else in that folder
```

`(edge)` is for a case that comes from the input or the state: boundary
values, invalid input, a state transition, an upgrade from an older state.
`(failure)` is for a case where something else fails: a dependency, a retry
or a concurrent run, a partial failure, a rollback. A happy-path scenario
has no mark.

The mark is lowercase English in ASCII parentheses, at the very end of the
item (on its last line when the item wraps). A mark on an `AND` or `THEN`
item, in the contract's prose, inside backticks, or followed by more text
does not count.

For each active spec, doctor lists the contracts that carry scenarios and
have none marked: their scenarios show only the happy path. It counts the
marks and does not judge them. Whether a marked scenario is a real edge case
is the critic's question.

## Writing a test story

A test story plans the tests for one or more contracts. Create it with the
variant flag, and its draft is written to the test lead's guide, `story.test`:

```
/projectstore:story PS-X "Tests for the stale-index contract" --variant test
```

The guide asks the story to name the contracts it covers by token, to list
the cases that apply to each (boundary values, invalid input, state
transitions, failure of a dependency, retry and concurrency, partial failure,
upgrade from an older state, rollback), to say which cases it leaves untested
and why, and to require a citation on every test it adds. For example:

```markdown
## Description

Covers [example#3]. The scenario shows the happy path; the cases below are
the ones a production vault hits.

## Decomposition

- [ ] Boundary: an index with no rows, and one with a row per artifact.
- [ ] Invalid input: a row whose link points at no file.
- [ ] Partial failure: one folder's README unreadable, the others fine.
- [ ] Not tested: concurrency. Doctor is read-only, so two runs cannot race.
```

The story has `variant: test` in its frontmatter and follows every other
story rule: the plan and close gates, evidence, the board.

## A story with no spec: the Independent test line

Most stories have no covering spec, so no scenario tells them how they are
checked. The story template has one optional line under Description for
that: one sentence on how the story is checked on its own, a command to run
and what to see.

```markdown
**Independent test:** run `npm test` with a fixture vault whose index has a
stale row, and see doctor report the folder.
```

It is a hint, not a gate. `/projectstore:story` fills it only when the
conversation already says how; otherwise the placeholder stays, or you delete
it. When the line is filled, the reviewer reports whether that test ran, and
the close reports it in the Final Summary. Doctor never reads it.

## A contract no test can cover

Some contracts are checked on a real host after install, or by a person.
Mark them in the contract's first paragraph:

```markdown
7. **The band draws in a live session.** (verified: live)
```

Use `(verified: live)` or `(verified: manual)`. Doctor does not count a
marked contract as uncovered.

## Citing a contract from a test

A test cites a contract with a bracketed token, `[<key>#<n>]`, in its name or
in a comment beside it:

```js
// [example#3]
test("doctor reports a stale index row", () => {
  // … assert the finding names the folder
});
```

- `<key>` is the spec's frontmatter `id`, or its `alias`. Matching is
  case-sensitive.
- `<n>` is the contract number in ASCII: `0`, `4`, `4'` for `4′`, `4''` for
  `4″`. A step nested under contract 4 is `4/1''`. A cited step does not
  cover its parent.
- The closing bracket ends the token, so `[example#4]` never matches
  contract `4'` or `40`. A token followed by `(` is a Markdown link, and a
  `[[…]]` is a wikilink. Neither is a citation.

A slug id runs to about 60 characters, so give a spec a short alias in its
frontmatter:

```yaml
alias: billing
```

Its tests then cite its contracts with `billing` as the key. (This page
writes that out in words rather than as a token, because a token in a doc
is scanned like one in a test.)

An alias is frozen like a slug, because renaming it breaks every citation.
Two specs may not share an alias, and an alias may not be another spec's id.

A citation is a claim: the reviewer checks that a cited test asserts the
contract's outcome. An empty test with a token is a review finding.

## Amending a contract

A later story that changes a contract of an active spec rewrites the
contract's body to the text in force and puts a marker under it: a
blockquote after the contract and before the next one, whose first paragraph
reads

```markdown
4. **Exports.** The export runs nightly and keeps seven copies.

   > amended 2026-11-10 by example/story-keep-seven: MODIFIED — seven copies, not three.
   >
   > Replaced:
   >
   > > keeps three copies
```

- `amended`, `by`, the kind and `Removed, see below.` stay English in every
  locale. The ref is any form a spec's `stories:` entry takes
  (`EPIC-ID/<story-id>`, the story part a short id or the full slug; a ref
  without `EPIC-ID/` resolves to no story). The colon may be `:` or `：`, the
  dash `—`, `–` or `-`. A marker may wrap: its first paragraph is read with
  its lines joined.
- `MODIFIED`: the body holds the new text; the block quotes what it replaced
  and why. A step keeps its number: a removed step stays as
  `2. Removed, see below.`, a new step takes the list's next number.
- `ADDED`: a new contract takes the highest number in the file, removed ones
  included, plus one. A number is never reused.
- `REMOVED`: the contract keeps its number and its heading, and its body
  becomes `Removed, see below.` This is a tombstone. Nothing follows a
  `REMOVED` marker; a rule that comes back is `ADDED` under a new number.
- The story and the spec list each other: the story in the spec's
  `stories:`, the spec in the story's `specs:`. The amending story is a
  covered story.
- Markers inside a fence or an HTML comment do not count, and neither does a
  marker whose ref starts with `example/` (it is documentation, like the one
  above). Older `> *Amended …` blocks are not read; the first marker under a
  contract folds them into the body and quotes them inside its own block.

A tombstone stays forever, so a citation keeps its meaning: a test that
still cites `[example#4]` after contract 4 was removed is reported as
`citation-removed`, with the marker's why, and the removed contract leaves
the coverage count. Evidence in a closed story that names it is not
reported. `graph.md` and `lineage` show an `amends` edge from the story to
the spec.

## Checking a spec against the code

A spec can drift from the code after its stories close: a later story
changes the behaviour without a marker, or the code changes outside any
story. Ask the reviewer for spec drift on a named spec, and it checks that
spec against the code at its covered stories' `code_refs`. Run it when the
covered code changed since the contracts' last markers, not before every
release.

The reviewer reads a bundle of facts first:

```bash
node scripts/spec-drift.mjs example --since 2026-11-01
```

It prints JSON: each contract with its markers, removed state and anchor
(the date of its last marker, else the spec's `date:`; `--since` overrides
it), the tests that cite it as `[example#2]`, the covered stories and their
`code_refs` (empty and missing ones listed), the files those refs name with
their class (`source`, `tests` or `surface`), line counts and commits since
each anchor, and a scan status: `ok`, `no-git` or `unknown`. A spec that is
not `active` exits 1.

The reviewer judges up to eight contracts per run unless you name another
budget. A spec with more asks you for contract numbers first. Each contract
judged gets one verdict:

| Verdict | Means |
|---|---|
| `holds` | A line of code, quoted with its file:line, produces the contract's outcome |
| `drifted` | The code contradicts the contract, or a file, command or token it names is gone; the report cites the line, or the search that found nothing |
| `cannot tell` | With a reason: no covered code, a rule about people, a live or manual contract, an unknown scan; `cannot tell (pending)` when the code is missing and the story behind the last marker has not reached review |

Each drift comes with a proposal: a marker carried by an open story, a new
story that brings the spec to the code, or a follow-up story that brings the
code back. Empty `code_refs` and uncited contracts are listed as facts, not
drift. The reviewer writes nothing; every change goes through the usual
approval-gated commands.

## What doctor reports

Doctor (`--vault`) scans the bound project with `git grep --untracked`, so a
test you have not added yet is found too. `.gitignore`d files, a vault
inside the project, `node_modules/` and the other generated paths are
skipped. Tests outside the bound project, or in a submodule, are not seen.

| Finding | Level | When |
|---|---|---|
| `contract-coverage` | info | One line per active spec. With no citation: "N contracts, 0 cited". Once a spec has a citation, or sets `coverage: report` in its frontmatter: the contracts no test cites |
| `citation-unknown` | warn | A token whose key is no spec's id or alias, or whose number is not a contract of that spec |
| `citation-removed` | warn | A token that cites a removed contract, or a step that reads `Removed, see below.`; the message quotes the marker's why |
| `citation-superseded` | info | A token that cites a superseded spec |
| `scenario-shape` | info | A scenario without a WHEN/GIVEN or a THEN |
| `contract-happy-path-only` | info | One line per active spec: the contracts that carry scenarios and have none marked `(edge)` or `(failure)` |
| `spec-alias` | issue | A duplicate alias, an alias equal to another spec's id, or the reserved `example` |
| `evidence-citation` | warn | Under `lifecycle_gates: on`: a story's evidence names a token that no file in the project carries (a removed contract is skipped) |
| `amendment-form` | warn | A blockquote under the contracts that starts `amended <date> by` but is not the grammar, comes before the first contract, or follows a `REMOVED`; it counts for nothing |
| `amendment-story` | issue | A marker's ref names no story, or more than one |
| `amendment-link` | warn | Neither the marker's story nor the spec lists the other (one side only is `spec-links`) |
| `amendment-date` | warn | A marker's date is not a date, is before the spec's `date:`, after tomorrow, or before the previous marker under the same contract |

Each report names the checkout it read. A worktree on an old branch, or a
second project bound to the same vault, can see different coverage.

Doctor never runs a test. CI and `npm test` do that. Doctor checks the
record: which contracts are cited, and whether a cited token still exists.

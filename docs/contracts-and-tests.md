# Contracts and tests

A spec's behavioral contracts are numbered and testable. This page shows how
to write a contract so a test follows from it, how a test cites the contract
it covers, and what doctor reports. It describes Part A of the ADR *Spec
policy, revised: contract scenarios and test citations that doctor counts,
and a declared per-story opt-out from a spec*, and decisions 6 and 7 of the
ADR *One authoring guide per artifact kind, read by the author before the
draft and by the critic after, overridable from the vault* (edge and failure
marks, and test stories).

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

## What doctor reports

Doctor (`--vault`) scans the bound project with `git grep --untracked`, so a
test you have not added yet is found too. `.gitignore`d files, a vault
inside the project, `node_modules/` and the other generated paths are
skipped. Tests outside the bound project, or in a submodule, are not seen.

| Finding | Level | When |
|---|---|---|
| `contract-coverage` | info | One line per active spec. With no citation: "N contracts, 0 cited". Once a spec has a citation, or sets `coverage: report` in its frontmatter: the contracts no test cites |
| `citation-unknown` | warn | A token whose key is no spec's id or alias, or whose number is not a contract of that spec |
| `citation-superseded` | info | A token that cites a superseded spec |
| `scenario-shape` | info | A scenario without a WHEN/GIVEN or a THEN |
| `contract-happy-path-only` | info | One line per active spec: the contracts that carry scenarios and have none marked `(edge)` or `(failure)` |
| `spec-alias` | issue | A duplicate alias, an alias equal to another spec's id, or the reserved `example` |
| `evidence-citation` | warn | Under `lifecycle_gates: on`: a story's evidence names a token that no file in the project carries |

Each report names the checkout it read. A worktree on an old branch, or a
second project bound to the same vault, can see different coverage.

Doctor never runs a test. CI and `npm test` do that. Doctor checks the
record: which contracts are cited, and whether a cited token still exists.

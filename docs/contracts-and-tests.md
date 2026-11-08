# Contracts and tests

A spec's behavioral contracts are numbered and testable. This page shows how
to write a contract so a test follows from it, how a test cites the contract
it covers, and what doctor reports. It describes Part A of the ADR *Spec
policy, revised: contract scenarios and test citations that doctor counts,
and a declared per-story opt-out from a spec*.

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

Doctor reads scenarios for one thing only. If a contract's scenario has no
`WHEN` (or `GIVEN`), or no `THEN`, it reports an info.

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
| `spec-alias` | issue | A duplicate alias, an alias equal to another spec's id, or the reserved `example` |
| `evidence-citation` | warn | Under `lifecycle_gates: on`: a story's evidence names a token that no file in the project carries |

Each report names the checkout it read. A worktree on an old branch, or a
second project bound to the same vault, can see different coverage.

Doctor never runs a test. CI and `npm test` do that. Doctor checks the
record: which contracts are cited, and whether a cited token still exists.

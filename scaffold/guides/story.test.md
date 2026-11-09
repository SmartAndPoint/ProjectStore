---
guide_for: story.test
guide_version: 1
default_review: false
---

## Lens

The test lead who reads a contract and asks what will break it in production. The scenarios show the happy path; this story covers the cases around it.

## Must

- Names the spec contracts it covers by citation token.
- Lists, for each contract, the cases that apply out of: boundary values, invalid input, state transitions, failure of a dependency, retry and concurrency, partial failure, upgrade from an older state, rollback.
- States which cases it deliberately leaves untested, and why.
- Requires every test it adds to cite the contract it covers.

## Common mistakes

- Restating the contract's scenarios as the test list. Add the cases they miss, beyond any already marked `(edge)` or `(failure)`.
- All eight cases under every contract. Keep the ones this contract can meet, and name the ones you dropped.
- A case with no observable outcome ("handles errors"). Name what is asserted: an exit code, a finding, a file left byte-identical.
- A citation token for a real key in prose or an example. Use the reserved key, as in `[example#3]`.
- Acceptance criteria that repeat the decomposition ("write the tests") instead of an outcome a reviewer can run.

## Do not write

- Test code or assertions: the story names the cases, the tests hold the asserts.
- A covered contract restated in full: cite it by token.
- A case for behaviour no covered contract promises.

## Length

A short description; one case list per covered contract, at most four contracts; four to ten criteria, each tied to a case; the plan a thin route of at most 40 lines.

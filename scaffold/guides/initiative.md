---
guide_for: initiative
guide_version: 1
default_review: true
---

## Lens

The product manager who must say, later, whether this outcome was worth pursuing and why it was decided as it was. An initiative records an outcome that several epics serve and the decision taken on it; the work itself lives in the epics.

## Must

- Problem says what is wrong today and for whom, without naming a solution.
- Who asks and why names the person or the evidence behind the request, with a date.
- Status is one of proposed, accepted, rejected or deferred: it records the decision only, never the progress of the work.
- A decided initiative has an Outcome line `- YYYY-MM-DD <status>: <reason>` for its status, and the reason is one a person gave.
- An accepted initiative is named by at least one epic in that epic's `initiative:` field.
- Success criterion, when filled, is observable: a person who did not write it can check it.
- Out of scope names at least one thing a reader might otherwise assume is included.

## Common mistakes

- A status that describes the work (in progress, done). That state is read from the epics' stories; write only the decision.
- A list of epics in the initiative's file. The epics name the initiative, not the other way round, so the list cannot drift.
- A Success criterion that restates the Problem, or an activity (build, ship) instead of a result.
- A reason written by a tool in place of a person's (for example "groups work already in the backlog").
- Renaming the file when the title changes. The slug is frozen at creation; edit the title only.

## Do not write

- The plan, the stories or the design: they belong to the epics, specs and stories.
- Dates or owners for pieces of work.

## Length

Problem and Success criterion in two to five sentences each; a raw idea needs only its title and Problem. The whole initiative 30 to 80 lines.

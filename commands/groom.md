---
description: The weekly grooming pass — stale ToDo stories back to the backlog, the pass stamped, and one-story epics handed to the librarian for merge proposals. Shows the plan and asks once.
---

You are running the grooming pass through the core's `groom` verb. It moves every ToDo story that has sat there past the vault's threshold back to `planned`, with a logged reason, lists the one-story epics and the active epics against their cap, and stamps the pass. With `--write` it reads the vault again and writes itself, so no clerk runs and you never edit a story or the vault's settings here. The verb never merges or moves an epic: the librarian only proposes, and a merge goes through the normal commands later.

1. **Show the plan.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" groom --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Exit 3: the project is not bound; tell the person to run `/projectstore:bind <vault-path>` and stop. Exit 1 with the policy not set, or with the vault config or its `flow` refused: say so in one line, with `result.error` as it is, and stop; ask nothing.

2. **Relay it.** List `result.items` (each `story`, `age_days` and `reason`), then `result.notes` by `id` and `message`, then the epics: each entry of `result.epics.single_story` (its `epic` and `story.ref`), and `result.epics.active` as `<count> active epics`, with the cap or `no cap set`, and whether it is over.

3. **Ask once** whether to apply it (AskUserQuestion: **Apply** / **Cancel**). Say that the stamp `flow.groomed_at` is written also when no story moves, and how many epics go to the librarian afterwards: the number of entries in `result.epics.single_story` (none when it is empty).

4. **On Apply**, run the same command with `--write`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" groom --write --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   Report the items with `written: true` (each `line`), any item `error` as it is, every note, `result.stamp` (written or not, and `after`), and the exit: 0, or 1 with `result.error`. A command inside an error stays alone on its line. On Cancel, nothing is written and no librarian runs; say so and stop.

5. **The librarian, only when `result.epics.single_story` of the `--write` run is not empty** — also after an exit 1, since the epics are only read. When it is empty, no librarian runs; say so.

   **Model and effort (ADR-008)**: resolve them with `node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" agents model librarian --json --project "${CLAUDE_PROJECT_DIR}"` and pass `result.model` as the spawn's model parameter, verbatim — never substitute the model you are running on (`null` → pass nothing), and `result.effort` as its effort parameter when it is not `null` and the spawn offers one. Missing key, `inherit`, or unreadable config → pass nothing and let the agent's own frontmatter decide; never guess a model.

   Spawn `projectstore:librarian` once, in the foreground, with a prompt whose first line is `Epic list:` followed by a JSON block of the `--write` run's `result.epics`, and nothing else. Print its verdicts as they come: for each one-story epic, the epic that absorbs it and what moves, or keep it and why. Every proposal is a suggestion: you change nothing on it here, and a merge goes through the normal approval-gated commands.

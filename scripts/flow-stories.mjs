// projectstore — flow-stories.mjs: the stories the flow counts read.
//
// One reader for doctor's flow group, `next` and `flow.md` (PS-FLOW), so
// they count the same stories: those the board reads. A flat file under an
// epic's `stories/`, a folder there holding a `README.md`, and a standalone
// `story-*.md` beside its epic (lib.mjs listEpicStories, as kanban.mjs walks
// them), except under an epic folder whose name starts with `_` or `.`. A
// story file that cannot be read is left out and counted. It never throws.
// The counts (flow-counts.mjs) take its result and stay pure.
//
// Spec: "Flow counts: whole days, week windows, age in status, awaiting
// close, WIP and capacity" (alias `flow-counts`), contract 2, and its
// contract 9 (readFlowEpics), added 2026-11-15 by PS-FLOW/story-a-weekly-
// grooming-pass-sends-stale-todo-stories-back-to-the-backlog-and-the-
// librarian-proposes-epic-merges.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listEpicStories, parseFrontmatter } from "./lib.mjs";

// Every story file of the vault's epics folder, as {rel, epic, slug, text,
// fm}, epics in sorted order; `unread` counts the files, and the epic
// folders or the epics folder, that could not be read. `read` is a test's seam.
// `only` names one epic folder: its stories alone are read, so a file that
// cannot be read is counted against that epic (the spec "The epic rule…",
// contract 5).
export function readFlowStories(vault, epicsPath, { read = (p) => readFileSync(p, "utf8"), only = null } = {}) {
  const stories = [];
  let unread = 0;
  let epics;
  try {
    epics = only === null ? readdirSync(join(vault, epicsPath)).sort() : [only];
  } catch (e) {
    // No epics folder is no stories; one that cannot be read is counted.
    return { stories, unread: e?.code === "ENOENT" ? 0 : 1 };
  }
  for (const epic of epics) {
    if (epic.startsWith("_") || epic.startsWith(".")) continue;
    let files;
    try {
      files = listEpicStories(join(vault, epicsPath, epic));
    } catch {
      unread++; // an epic folder that cannot be read
      continue;
    }
    for (const f of files) {
      let text;
      try {
        text = String(read(f.abs));
      } catch {
        unread++;
        continue;
      }
      const rel = `${epicsPath}/${epic}/${f.rel}`;
      stories.push({ rel, epic, slug: f.slug, text, fm: parseFrontmatter(text).data });
    }
  }
  return { stories, unread };
}

// Every epic of the vault's epics folder, as {rel, epic, text, fm}, in
// sorted order (Flow counts, contract 9): a folder holding `epic.md`, except
// one whose name starts with `_` or `.`; a folder with stories and no
// `epic.md` is not an epic. `unread` counts the `epic.md` files that could
// not be read; an epics folder that cannot be read is readFlowStories' to
// count, so a reader of both counts it once. `read` is a test's seam. It
// never throws.
export function readFlowEpics(vault, epicsPath, { read = (p) => readFileSync(p, "utf8") } = {}) {
  const epics = [];
  let unread = 0;
  let names;
  try {
    names = readdirSync(join(vault, epicsPath)).sort();
  } catch {
    return { epics, unread };
  }
  for (const epic of names) {
    if (epic.startsWith("_") || epic.startsWith(".")) continue;
    const abs = join(vault, epicsPath, epic, "epic.md");
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = String(read(abs));
    } catch {
      unread++;
      continue;
    }
    epics.push({ rel: `${epicsPath}/${epic}/epic.md`, epic, text, fm: parseFrontmatter(text).data });
  }
  return { epics, unread };
}

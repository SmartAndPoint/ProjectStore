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
// close, WIP and capacity" (alias `flow-counts`), contract 2.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listEpicStories, parseFrontmatter } from "./lib.mjs";

// Every story file of the vault's epics folder, as {rel, epic, slug, text,
// fm}, epics in sorted order; `unread` counts the files, and the epic
// folders or the epics folder, that could not be read. `read` is a test's seam.
export function readFlowStories(vault, epicsPath, { read = (p) => readFileSync(p, "utf8") } = {}) {
  const stories = [];
  let unread = 0;
  let epics;
  try {
    epics = readdirSync(join(vault, epicsPath)).sort();
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

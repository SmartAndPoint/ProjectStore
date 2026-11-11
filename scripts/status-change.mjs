#!/usr/bin/env node
// projectstore — status-change.mjs: the writers of a story's status and assignee.
//
// The one way a verb writes a change of status or assignee to a story file:
// read it, apply the pure change (status-log.mjs), read the file again just
// before the atomic replace and, when it differs, compute the change again
// from the fresh bytes — at most three times, then report
// `story-changed-meanwhile` and leave the file. That is the loop of
// reconcile.mjs's writeIndexWithRetry (the regeneration spec, contract 3),
// kept here rather than imported: reconcile reaches doctor. A status change
// also updates the story's row in its epic's Stories table, with the same
// loop on epic.md.
//
// Spec: SPEC-001 contracts 3 and 7 as amended 2026-11-10 by
// PS-FLOW/story-every-status-change-is-stamped-and-logged-in-the-story-and-a-
// command-moves-a-story-between-the-backlog-and-todo.
//
// The gates write no file (contract 7), so the story command's plan and close
// ceremonies run the epic row's update themselves, after their write:
//
//   node status-change.mjs epic-row <story-path>
//
// It prints {path, found, changed, written, error, note} and exits 1 on a
// write error, 0 otherwise — also on the note `epic-row-missing` (no row in
// ../epic.md links to the story). It is idempotent: a row that already says
// the status is left.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic, parseFrontmatter, nowIso, today, isMain } from "./lib.mjs";
import { applyStatusChange, applyAssigneeChange, touchStory, epicRowUpdate } from "./status-log.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";

export const CHANGED_MEANWHILE = "story-changed-meanwhile";
// No row in ../epic.md links to the story: a note, exit 0, the epic is not written.
export const EPIC_ROW_MISSING = "epic-row-missing";

const errMsg = (e) => (e && e.message ? e.message : String(e));

// Read, compute from those bytes, read again, replace only when nothing moved.
// `compute(base, attempt)` returns {content} (content === base: no change) or
// {refused}. `afterCompute(attempt)` runs between the compute and the second
// read: the test seam for an edit made meanwhile.
// `onWrite(path, before, after)` runs once the replace landed, with the bytes
// the write read and the bytes it wrote: the session's record of its own
// vault writes (write-record.mjs, the record spec's contract 5). It never
// changes the result: a throw from it is swallowed.
export function replaceWithRetry(path, compute, { attempts = 3, afterCompute = null, onWrite = null } = {}) {
  let base;
  try {
    base = readFileSync(path, "utf8");
  } catch (e) {
    return { changed: false, written: false, attempts: 0, error: errMsg(e) };
  }
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = compute(base, i);
    } catch (e) {
      return { changed: false, written: false, attempts: i + 1, error: errMsg(e) };
    }
    if (r.refused) return { changed: false, written: false, attempts: i + 1, refused: r.refused, result: r };
    if (afterCompute) afterCompute(i);
    let now;
    try {
      now = readFileSync(path, "utf8");
    } catch (e) {
      return { changed: false, written: false, attempts: i + 1, error: errMsg(e) };
    }
    if (now !== base) {
      base = now; // edited meanwhile: compute again from what is there now
      continue;
    }
    if (r.content === base) return { changed: false, written: false, attempts: i + 1, result: r };
    try {
      writeFileAtomic(path, r.content);
    } catch (e) {
      return { changed: true, written: false, attempts: i + 1, error: errMsg(e), result: r };
    }
    if (onWrite) {
      try {
        onWrite(path, base, r.content);
      } catch {}
    }
    return { changed: true, written: true, attempts: i + 1, result: r };
  }
  return { changed: false, written: false, attempts, error: CHANGED_MEANWHILE };
}

// The epic folder a story belongs to: epics/<E>/stories/<s>.md,
// epics/<E>/stories/<s>/README.md, or a standalone epics/<E>/story-<s>.md.
export function epicFileOf(storyPath) {
  let dir = dirname(resolve(storyPath));
  if (/^readme\.md$/i.test(basename(storyPath)) && basename(dirname(dir)) === "stories") dir = dirname(dir);
  if (basename(dir) === "stories") dir = dirname(dir);
  return join(dir, "epic.md");
}

// The story's row in its epic's Stories table, set to the story's status as
// its file says now, through the same read-again loop as the story.
// Idempotent; no epic.md, or no row, is the note `epic-row-missing`.
export function syncEpicRow(storyPath, { afterCompute = null, onWrite = null } = {}) {
  const abs = resolve(storyPath);
  const epic = epicFileOf(abs);
  const out = { path: epic, found: false, changed: false, written: false, error: null, note: null };
  let fm;
  try {
    fm = parseFrontmatter(readFileSync(abs, "utf8")).data;
  } catch (e) {
    return { ...out, error: errMsg(e) };
  }
  if (!existsSync(epic)) return { ...out, note: EPIC_ROW_MISSING };
  const status = String(fm.status ?? "").trim();
  let found = false;
  const r = replaceWithRetry(
    epic,
    (base) => {
      const u = epicRowUpdate(base, { epicPath: epic, storyPath: abs, status });
      found = u.found;
      return { content: u.text };
    },
    { afterCompute, onWrite },
  );
  return {
    ...out,
    found,
    changed: r.changed,
    written: r.written,
    error: r.error ?? null,
    note: found ? null : EPIC_ROW_MISSING,
  };
}

// A change of status written to a story file. `allow(fm)` returns a refusal
// or null; it runs on the fresh bytes of every attempt, so a status changed
// meanwhile is judged as it is now. Returns {path, from, to, changed,
// written, attempts, line, error, refused, epic}.
export function changeStatus(
  path,
  {
    to,
    reason,
    actor,
    at = nowIso(),
    lang = "en",
    allow = null,
    epic = true,
    afterCompute = null,
    onWrite = null,
  } = {},
) {
  let from = null;
  let line = null;
  const r = replaceWithRetry(
    path,
    (base) => {
      const fm = parseFrontmatter(base).data;
      const refused = allow ? allow(fm) : null;
      if (refused) return { refused };
      const c = applyStatusChange(base, { to, reason, actor, at, lang });
      from = c.from;
      line = c.line;
      return { content: c.changed ? touchStory(c.text, at.slice(0, 10) || today()) : base };
    },
    { afterCompute, onWrite },
  );
  const out = {
    path,
    from,
    to,
    changed: r.changed,
    written: r.written,
    attempts: r.attempts,
    line: r.changed ? line : null,
    error: r.error ?? null,
    refused: r.refused ?? null,
    epic: null,
  };
  if (r.written && epic) out.epic = syncEpicRow(path, { onWrite });
  return out;
}

// A change of assignee written to a story file: the same loop, no stamp and
// no epic row.
export function changeAssignee(path, { to, reason, actor, at = nowIso(), lang = "en", onWrite = null } = {}) {
  let from = null;
  let line = null;
  const r = replaceWithRetry(
    path,
    (base) => {
      const c = applyAssigneeChange(base, { to, reason, actor, at, lang });
      from = c.from;
      line = c.line;
      return { content: c.changed ? touchStory(c.text, at.slice(0, 10) || today()) : base };
    },
    { onWrite },
  );
  return {
    path,
    from,
    to,
    changed: r.changed,
    written: r.written,
    attempts: r.attempts,
    line: r.changed ? line : null,
    error: r.error ?? null,
  };
}

function main() {
  const [mode, storyPath, ...rest] = process.argv.slice(2);
  if (mode !== "epic-row" || !storyPath || rest.length) {
    process.stderr.write("projectstore/status-change: usage: status-change.mjs epic-row <story-path>\n");
    process.exit(2);
  }
  const abs = resolve(storyPath);
  if (!existsSync(abs)) {
    process.stderr.write(`projectstore/status-change: story not found: ${abs}\n`);
    process.exit(1);
  }
  // The project is the one the command's own shell and the hook resolve alike
  // (projectRoot), as epic-row takes no --project (the record spec, contract 5).
  const r = syncEpicRow(abs, { onWrite: nodeWriteRecorder({ env: process.env, project: null, tool: "epic-row" }) });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  if (r.error) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}

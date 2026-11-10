// projectstore — tests/status-log.test.mjs: a story's status stamp and Status
// log, as text (PS-FLOW, "Every status change is stamped and logged in the
// story, and a command moves a story between the backlog and ToDo"). The pure
// half: the line grammar, applyStatusChange / applyAssigneeChange in every
// bundled language, the trust rule, the --check mask and the epic's Stories
// row. The gates, the writers and the verb have their own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyStatusChange,
  applyAssigneeChange,
  parseStatusLog,
  statusStamp,
  sameStatus,
  maskStatusLog,
  epicRowUpdate,
  logLine,
  oneLine,
  checkActor,
  STATUS_ACTORS,
} from "../scripts/status-log.mjs";
import {
  loadTemplate,
  renderTemplate,
  loadHeadingsRegistry,
  headingLineRe,
  parseFrontmatter,
} from "../scripts/lib.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCALES = readdirSync(join(REPO, "templates")).filter((d) =>
  existsSync(join(REPO, "templates", d, "story.md.tmpl")),
);
const AT = "2026-11-10T09:00:00.000Z";
const LATER = "2026-11-10T10:00:00.000Z";
const VARS = { id: "story-a", title: "A", date: "2026-11-01", author: "Other", tags: "[]", epic_id: "PS-X" };
const story = (lang = "en") => renderTemplate(loadTemplate(lang, "story"), VARS);
const change = (text, extra = {}) =>
  applyStatusChange(text, { to: "in-progress", reason: "work started", actor: "plan gate", at: AT, ...extra });
const fm = (t) => parseFrontmatter(t).data;
const headingCount = (text, id) => text.split("\n").filter((l) => headingLineRe(id).test(l)).length;
const header = (t) => {
  const body = t.slice(t.indexOf("\n---", 4) + 4);
  return body.slice(0, body.search(/^## /m));
};

// [SPEC-001#2]
test("status log: the Status row, and no other row, holds the new status in every bundled language", () => {
  const forms = loadHeadingsRegistry().fields;
  assert.ok(LOCALES.length >= 6, LOCALES.join(","));
  for (const lang of LOCALES) {
    const before = story(lang);
    const r = change(before, { lang });
    assert.equal(r.changed, true, lang);
    const status = forms.status[lang][0];
    const rowsBefore = header(before).split("\n");
    const rowsAfter = header(r.text).split("\n");
    assert.equal(rowsAfter.length, rowsBefore.length, lang);
    const diff = rowsAfter.filter((l, k) => l !== rowsBefore[k]);
    assert.deepEqual(diff, [`| **${status}** | in-progress |`], `${lang}: only the Status row changes`);
    assert.equal(headingCount(r.text, "status_log"), 1, lang);
  }
});

// [SPEC-001#2]
test("status log: a heading spelled in another bundled language takes the line, and no second section is inserted", () => {
  const ru = story("en").replace(
    "## Technical Notes",
    "## Журнал статусов\n\n- 2026-11-01T00:00:00Z status: none → planned — filed (move)\n\n## Technical Notes",
  );
  const r = change(ru);
  assert.equal(headingCount(r.text, "status_log"), 1);
  const log = parseStatusLog(r.text);
  assert.deepEqual(
    log.map((e) => e.to),
    ["planned", "in-progress"],
  );
});

// [SPEC-001#2]
test("status log: a story with no Status row and no Status log gets the frontmatter, the stamp and the log, no row", () => {
  const bare = "---\ntype: story\nstatus: planned\n---\n\n# A\n\n## Description\n\nx\n";
  const r = change(bare);
  assert.equal(fm(r.text).status, "in-progress");
  assert.equal(fm(r.text).status_changed_at, AT);
  assert.ok(!/\*\*Status\*\*/.test(r.text), "no row is added");
  assert.deepEqual(parseStatusLog(r.text).length, 1);
});

// [SPEC-001#2]
test("status log: a Status row below the header block is not touched", () => {
  const t = story().replace(
    "## Technical Notes",
    "## Technical Notes\n\n| Field | Value |\n|---|---|\n| **Status** | planned |\n",
  );
  const r = change(t);
  assert.match(r.text, /## Technical Notes\n\n\| Field \| Value \|\n\|---\|---\|\n\| \*\*Status\*\* \| planned \|/);
  assert.match(header(r.text), /\| \*\*Status\*\* \| in-progress \|/);
});

// [SPEC-001#2]
test("status log: the section lands after Final Summary and before Technical Notes, else after Acceptance", () => {
  const r = change(story());
  const order = ["## Final Summary", "## Status log", "## Technical Notes"].map((h) => r.text.indexOf(h));
  assert.ok(order[0] < order[1] && order[1] < order[2], order.join(","));
  const noSummary = story().replace(/## Final Summary\n[\s\S]*?(?=## Technical Notes)/, "");
  const s = change(noSummary).text;
  assert.ok(s.indexOf("## Acceptance Criteria") < s.indexOf("## Status log"));
  assert.ok(s.indexOf("## Status log") < s.indexOf("## Technical Notes"));
  // The last section before the footer: the log goes before the rule, not after it.
  const last =
    "---\nstatus: planned\n---\n\n# A\n\n## Acceptance Criteria\n\n- [ ] c\n\n---\n\n*Last updated: 2026-01-01*\n";
  const l = change(last).text;
  assert.ok(l.indexOf("## Status log") < l.lastIndexOf("\n---\n"), l);
  assert.ok(l.endsWith("*Last updated: 2026-01-01*\n"));
});

// [SPEC-001#3]
test("status log: a planned story with no log is stamped, with one status: line at the same time", () => {
  const r = change(story());
  assert.equal(fm(r.text).status_changed_at, AT);
  assert.equal(r.line, `- ${AT} status: planned → in-progress — work started (plan gate)`);
  const log = parseStatusLog(r.text);
  assert.equal(log.length, 1);
  assert.equal(log[0].at, AT);
  // A change to the status the story already holds changes nothing.
  const again = change(r.text, { at: LATER });
  assert.equal(again.changed, false);
  assert.equal(again.text, r.text);
  // Status equality: in_progress is in-progress, so no line either.
  assert.equal(change(r.text.replace("status: in-progress", "status: in_progress"), { at: LATER }).changed, false);
});

// [SPEC-001#3]
test("status log: a second line follows the last, and every existing line stays byte-identical", () => {
  const handLine = "- a note someone wrote by hand";
  const first = change(story()).text.replace(/(- .*\(plan gate\))/, `$1\n${handLine}`);
  const r = applyStatusChange(first, { to: "done", reason: "closed", actor: "close gate", at: LATER });
  const before = first.split("\n");
  const after = r.text.split("\n");
  for (const l of before.filter((x) => x.startsWith("- "))) assert.ok(after.includes(l), `kept: ${l}`);
  const log = r.text.slice(r.text.indexOf("## Status log"), r.text.indexOf("## Technical Notes"));
  assert.ok(log.indexOf(handLine) < log.indexOf("→ done"), "appended after the last line");
});

// [SPEC-001#3]
test("status log: an assignee change appends an assignee: line and moves neither the stamp nor its trust", () => {
  const started = change(story()).text;
  const r = applyAssigneeChange(started, { to: "Test", reason: "work started", actor: "plan gate", at: LATER });
  assert.equal(r.line, `- ${LATER} assignee: Other → Test — work started (plan gate)`);
  assert.equal(fm(r.text).assignee, "Test");
  assert.match(header(r.text), /\| \*\*Assignee\*\* \| Test \|/);
  assert.equal(fm(r.text).status_changed_at, AT);
  assert.deepEqual(statusStamp(r.text), statusStamp(started));
  assert.equal(statusStamp(r.text).trusted, true);
  // An empty side is `none`.
  const none = applyAssigneeChange(started.replace('assignee: "Other"', 'assignee: ""'), {
    to: "Test",
    reason: "r",
    actor: "groom",
    at: LATER,
  });
  assert.match(none.line, /assignee: none → Test — r \(groom\)$/);
});

// [SPEC-001#3]
test("trust rule: a last line to in-progress and a status in_progress is trusted, read from the stamp", () => {
  const t = change(story()).text.replace("status: in-progress", "status: in_progress");
  assert.deepEqual(statusStamp(t), { trusted: true, at: AT, source: "stamp", why: null });
});

// [SPEC-001#3]
test("trust rule: a status edited by hand after the last line is untrusted and read from updated", () => {
  const t = change(story()).text.replace("status: in-progress", "status: review");
  const s = statusStamp(t);
  assert.equal(s.trusted, false);
  assert.equal(s.source, "updated");
  assert.equal(s.at, "2026-11-01");
  assert.equal(s.why, "differs");
  // A status the board does not name equals only itself: planned is not parked.
  const parked = applyStatusChange(story(), { to: "todo", reason: "r", actor: "move", at: AT }).text;
  const back = applyStatusChange(parked, { to: "planned", reason: "r", actor: "move", at: LATER }).text;
  assert.equal(statusStamp(back).trusted, true);
  assert.equal(statusStamp(back.replace("status: planned", "status: parked")).trusted, false);
  assert.equal(sameStatus("planned", "parked"), false);
  assert.equal(sameStatus("deferred", "planned"), false);
  assert.equal(sameStatus("done", "closed"), true);
  assert.equal(sameStatus("", ""), true);
  assert.equal(sameStatus("typo", "planned"), false);
  // Own keys of the board's table only.
  assert.equal(sameStatus("constructor", "__proto__"), false);
  assert.equal(sameStatus("constructor", "planned"), false);
});

// [SPEC-001#3]
test("trust rule: a story with no Status log is untrusted, read from updated, and not changed", () => {
  const t = story();
  const s = statusStamp(t);
  assert.deepEqual(s, { trusted: false, at: "2026-11-01", source: "updated", why: "no-log" });
  assert.equal(story(), t, "reading writes nothing");
  const created = "---\nstatus: planned\ncreated: 2026-10-01\n---\n";
  assert.equal(statusStamp(created).source, "created");
});

// [SPEC-001#3]
test("trust rule: the line's time is the stamp's instant, the line must parse, and only status: lines count", () => {
  const t = change(story()).text;
  // The same instant in another spelling is trusted.
  assert.equal(
    statusStamp(t.replace(`status_changed_at: "${AT}"`, 'status_changed_at: "2026-11-10T09:00:00Z"')).trusted,
    true,
  );
  // Another instant is not.
  const moved = statusStamp(t.replace(`status_changed_at: "${AT}"`, `status_changed_at: "${LATER}"`));
  assert.equal(moved.why, "time-differs");
  // No stamp at all.
  assert.equal(statusStamp(t.replace(`status_changed_at: "${AT}"\n`, "")).why, "no-stamp");
  // A last status: line that does not read in the grammar.
  const broken = t.replace("(plan gate)", "plan gate");
  assert.equal(statusStamp(broken).why, "unparsed");
  // pr: and assignee: lines after it are not read.
  const pr = t.replace(/(- .*\(plan gate\))/, `$1\n- ${LATER} pr: none → #12 — opened (follow)`);
  assert.equal(statusStamp(pr).trusted, true);
});

// [SPEC-001#3]
test("grammar: a reason holding ' — ' and parentheses parses back, the actor is the last group", () => {
  const line = logLine({
    at: AT,
    field: "status",
    from: "in-progress",
    to: "done",
    reason: "merged: <url> — after review (fast)",
    actor: "follow",
  });
  const t = `---\nstatus: done\n---\n\n## Status log\n\n${line}\n`;
  const [e] = parseStatusLog(t);
  assert.equal(e.from, "in-progress");
  assert.equal(e.to, "done");
  assert.equal(e.reason, "merged: <url> — after review (fast)");
  assert.equal(e.actor, "follow");
  // The seconds-only form parses too.
  assert.equal(parseStatusLog(t.replace(AT, "2026-11-10T09:00:00Z"))[0].at, "2026-11-10T09:00:00Z");
  assert.equal(parseStatusLog("---\n---\n"), null);
});

// [SPEC-001#3]
test("grammar: a reason is one line and an actor is one of the six", () => {
  assert.equal(oneLine("  next up "), "next up");
  for (const bad of ["", "   ", "a\nb", "a\rb", "a b", "a\u0085b"])
    assert.throws(() => oneLine(bad), JSON.stringify(bad));
  assert.deepEqual([...STATUS_ACTORS], ["plan gate", "close gate", "follow", "groom", "handover", "move"]);
  assert.throws(() => checkActor("robot"), /one of/);
  assert.throws(() => change(story(), { reason: "a\nb" }), /one line/);
  assert.throws(() => change(story(), { actor: "robot" }), /one of/);
});

// [SPEC-001#3]
test("byte identity: a change differs from the story only in status, the stamp, the header row, updated untouched, and the log", () => {
  const before = story();
  const after = change(before).text;
  const b = before.split("\n");
  const a = after.split("\n");
  const added = a.filter((l) => !b.includes(l));
  assert.deepEqual(added, [
    "status: in-progress",
    `status_changed_at: "${AT}"`,
    "| **Status** | in-progress |",
    "## Status log",
    `- ${AT} status: planned → in-progress — work started (plan gate)`,
  ]);
  const removed = b.filter((l) => !a.includes(l));
  assert.deepEqual(removed, ["status: planned", "| **Status** | planned |"]);
});

// [SPEC-001#7]
test("--check mask: only the timestamps of Status log lines; a reason and a hand line stay visible", () => {
  const t = change(story()).text;
  const m = maskStatusLog(t);
  assert.match(m, /^- «volatile» status: planned → in-progress — work started \(plan gate\)$/m);
  const noStamp = (x) => x.replace(/^status_changed_at: .*\n/m, "");
  assert.equal(noStamp(maskStatusLog(change(story(), { at: LATER }).text)), noStamp(m), "a fresh time masks equal");
  assert.notEqual(maskStatusLog(t.replace("work started", "work begun")), m, "a reason is drift");
  // Outside the section nothing is masked.
  const outside = t.replace("## Description\n", `## Description\n\n- ${AT} status: a → b — c (move)\n`);
  assert.ok(maskStatusLog(outside).includes(`- ${AT} status: a → b — c (move)`));
  assert.equal(maskStatusLog(story()), story());
});

// ─── The epic's Stories row ────────────────────────────────────────────

const EPIC = "/v/epics/PS-X/epic.md";
const STORY = "/v/epics/PS-X/stories/story-a.md";
const row = (text) => epicRowUpdate(text, { epicPath: EPIC, storyPath: STORY, status: "todo" });

// [SPEC-001#7]
test("epic row: the 3-column table with a ./stories/ link, only the Status cell, the first matching row", () => {
  const t = [
    "| Field | Value |",
    "|---|---|",
    "| **Status** | planned |",
    "",
    "## Stories",
    "",
    "| Story | Status | Description |",
    "|-------|--------|-------------|",
    "| [b](./stories/story-b.md) | planned | not this one |",
    "| [a](./stories/story-a.md) | planned | a \\| pipe in the text |",
    "| [a again](./stories/story-a.md) | planned | a second row |",
    "",
  ].join("\n");
  const r = row(t);
  assert.equal(r.found, true);
  assert.ok(r.text.includes("| [a](./stories/story-a.md) | todo | a \\| pipe in the text |"));
  assert.ok(r.text.includes("| [a again](./stories/story-a.md) | planned | a second row |"), "the first row only");
  assert.ok(r.text.includes("| **Status** | planned |"), "the epic's own header is no Stories table");
  assert.ok(r.text.includes("| [b](./stories/story-b.md) | planned |"));
  assert.equal(row(r.text).changed, false, "idempotent");
});

// [SPEC-001#7]
test("epic row: the 5-column keyed table with [[slug\\|Title]] wikilinks", () => {
  const t = [
    "| Key | Story | Status | Priority | Description |",
    "|-----|-------|--------|----------|-------------|",
    "| A | [[story-a\\|A story, titled]] | planned | p1 | one |",
    "| B | [[story-b]] | planned | p2 | two |",
  ].join("\n");
  const r = row(t);
  assert.equal(r.found, true);
  assert.equal(r.text.split("\n")[2], "| A | [[story-a\\|A story, titled]] | todo | p1 | one |");
  assert.equal(r.text.split("\n")[3], "| B | [[story-b]] | planned | p2 | two |");
});

// [SPEC-001#7]
test("epic row: a list instead of a table, a row with no link, a localized Status column", () => {
  const list = "## Stories\n\n1. [a](./stories/story-a.md) — planned\n";
  assert.deepEqual(row(list), { text: list, found: false, changed: false });
  const noLink = "| Story | Status |\n|---|---|\n| story-a | planned |\n";
  assert.equal(row(noLink).found, false);
  const ru = "| История | Статус | Описание |\n|---|---|---|\n| [a](./stories/story-a.md) | planned | x |\n";
  assert.match(row(ru).text, /\| \[a\]\(\.\/stories\/story-a\.md\) \| todo \| x \|/);
  const elsewhere = "| Story | Status |\n|---|---|\n| [a](../PS-Y/stories/story-a.md) | planned |\n";
  assert.equal(row(elsewhere).found, false, "a link that resolves to another file is not the story");
});

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
import { spawnSync } from "node:child_process";
import {
  applyStatusChange,
  applyAssigneeChange,
  parseStatusLog,
  statusStamp,
  sameStatus,
  maskStatusLog,
  epicRowUpdate,
  epicRowAdd,
  storyLinkTarget,
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

// [SPEC-001#3]
test("trust rule: a stamp and a last status: line with the same instant, the stamp with no zone, are trusted on machines in two time zones (edge)", () => {
  const t = applyStatusChange(story(), {
    to: "in-progress",
    reason: "work started",
    actor: "plan gate",
    at: "2026-11-01T09:00:00.000Z",
  }).text.replace('status_changed_at: "2026-11-01T09:00:00.000Z"', 'status_changed_at: "2026-11-01T09:00"');
  assert.match(t, /^- 2026-11-01T09:00:00\.000Z status: /m, "the line keeps its Z, as the grammar requires");
  const code = `import(${JSON.stringify(join(REPO, "scripts", "status-log.mjs"))}).then((m) => {
    process.stdout.write(JSON.stringify(m.statusStamp(${JSON.stringify(t)})));
  });`;
  for (const TZ of ["Asia/Almaty", "UTC", "America/Los_Angeles"]) {
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { trusted: true, at: "2026-11-01T09:00", source: "stamp", why: null }, TZ);
  }
});

// [SPEC-001#3]
test("trust rule: an untrusted stamp with updated: soon and a readable created is read from created (edge)", () => {
  const t = change(story())
    .text.replace("status: in-progress", "status: review")
    .replace(/^updated: .*$/m, "updated: soon");
  const s = statusStamp(t);
  assert.equal(s.trusted, false);
  assert.equal(s.source, "created");
  assert.equal(s.at, "2026-11-01");
  const none = t.replace(/^created: .*\n/m, "");
  assert.deepEqual(statusStamp(none), { trusted: false, at: null, source: null, why: "differs" });
});

// ─── Adding a story to its epic's Stories table ────────────────────────

const add = (text, { title = "A title", status = "planned", storyPath = STORY } = {}) =>
  epicRowAdd(text, { epicPath: EPIC, storyPath, status, title });
const stories = (...tableLines) =>
  ["# PS-X", "", "## Stories", "", ...tableLines, "", "## Expected Results", ""].join("\n");
const cellCount = (line) => line.replace(/\\\|/g, "").split("|").length - 2;

// [SPEC-001#7]
test("epic row add: the three-column table gets one row last, with the slug link, the status and the title", () => {
  const t = stories(
    "| Story | Status | Description |",
    "|---|---|---|",
    "| [b](./stories/story-b.md) | done | the b |",
  );
  const r = add(t);
  assert.deepEqual([r.found, r.changed, r.added, r.linked], [true, true, true, false]);
  assert.equal(r.row, "| [story-a](./stories/story-a.md) | planned | A title |");
  const lines = r.text.split("\n");
  assert.equal(lines[7], r.row, "after the table's last row");
  assert.equal(lines[8], "", "the blank line after the table is kept");
  assert.equal(r.text.replace(`${r.row}\n`, ""), t, "nothing else changes");
  const again = add(r.text);
  assert.deepEqual([again.found, again.changed, again.added], [true, false, false], "a second run finds the row");
  assert.equal(again.text, r.text);
});

// [SPEC-001#7]
test("epic row add: the header's columns place the cells: Key, Story, Status, Priority, Description (edge)", () => {
  const t = stories(
    "| Key | Story | Status | Priority | Description |",
    "|-----|-------|--------|----------|-------------|",
  );
  const r = add(t, { status: "todo" });
  assert.equal(r.row, "|  | [story-a](./stories/story-a.md) | todo |  | A title |");
  assert.equal(r.text.split("\n")[6], r.row, "a header-only table gets the row after its separator");
});

// [SPEC-001#7]
test("epic row add: no Story column puts the link in the first column that is neither Status nor Description; no Description column drops the title (edge)", () => {
  const noStory = stories("| Description | # | Status |", "|---|---|---|");
  assert.equal(add(noStory).row, "| A title | [story-a](./stories/story-a.md) | planned |");
  const noDesc = stories("| Story | Status |", "|---|---|");
  assert.equal(add(noDesc).row, "| [story-a](./stories/story-a.md) | planned |");
  const onlyStatus = stories("| Status | Description |", "|---|---|");
  assert.equal(add(onlyStatus).found, false, "no column for the link: no table to add to");
});

// [SPEC-001#7]
test("epic row add: a plain-title row, or one in * emphasis, gets the link in place with the cell's own text and its Status set; no row is added (edge)", () => {
  const wt = stories(
    "| Story | Status | Description |",
    "|---|---|---|",
    "| Another title | planned | other |",
    "| A title | planned | Kept \\| as it is |",
  );
  const r = add(wt, { status: "in-progress" });
  assert.deepEqual([r.found, r.added, r.linked], [true, false, true]);
  assert.equal(r.text.split("\n")[7], "| [A title](./stories/story-a.md) | in-progress | Kept \\| as it is |");
  assert.equal(r.row, "| [A title](./stories/story-a.md) | in-progress | Kept \\| as it is |");
  assert.equal(r.text.split("\n").length, wt.split("\n").length, "no row added");
  const under = stories("| Story | Status |", "|---|---|", "| _A title_ | planned |");
  assert.equal(add(under).text.split("\n")[6], "| [A title](./stories/story-a.md) | planned |", "_ emphasis too");
  const surfaces = stories(
    "| Key | Story | Status | Priority | Description |",
    "|-----|-------|--------|----------|-------------|",
    "| C | *A title* | planned | p2 | After M |",
  );
  assert.equal(add(surfaces).text.split("\n")[6], "| C | [A title](./stories/story-a.md) | planned | p2 | After M |");
  const piped = stories("| Story | Status |", "|---|---|", "| a \\| b | planned |");
  assert.equal(add(piped, { title: "a | b" }).text.split("\n")[6], "| [a \\| b](./stories/story-a.md) | planned |");
  const bold = stories("| Story | Status |", "|---|---|", "| **A title** | planned |");
  assert.equal(add(bold).added, true, "two pairs of emphasis are not taken off: left, a row is added");
  const near = stories("| Story | Status | Description |", "|---|---|---|", "| A title. | planned | close |");
  assert.equal(add(near).added, true, "a title that differs by a character is another row");
  const twice = stories("| Story | Status |", "|---|---|", "| A title | planned |", "| A title | planned |");
  const tw = add(twice).text.split("\n");
  assert.deepEqual(
    [tw[6], tw[7]],
    ["| [A title](./stories/story-a.md) | planned |", "| A title | planned |"],
    "the first only",
  );
  const second = stories(
    "| Story | Status |",
    "|---|---|",
    "| [b](./stories/story-b.md) | done |",
    "",
    "| Story | Status |",
    "|---|---|",
    "| A title | planned |",
  );
  const sr = add(second);
  assert.deepEqual([sr.linked, sr.added], [true, false], "a plain-title row in the second table is linked there");
  assert.equal(sr.text.split("\n")[10], "| [A title](./stories/story-a.md) | planned |");
});

// [SPEC-001#7]
test("epic row add: a story that already has a linked row gets the Status cell only, anywhere in the epic (edge)", () => {
  const t = stories("| Story | Status |", "|---|---|", "| [[story-a\\|A]] | planned |");
  const r = add(t, { status: "review" });
  assert.deepEqual([r.found, r.added, r.linked, r.row], [true, false, false, null]);
  assert.equal(r.text.split("\n")[6], "| [[story-a\\|A]] | review |");
});

// [SPEC-001#7]
test("epic row add: a list, no Status column, no Stories heading, a fenced table: epic-row-missing and the text unchanged (edge)", () => {
  const none = (t) =>
    assert.deepEqual(add(t), {
      text: t,
      found: false,
      changed: false,
      added: false,
      linked: false,
      row: null,
      unlinkable: false,
    });
  none("# PS-X\n\n## Stories\n\n1. [b](./stories/story-b.md) — planned\n");
  none(stories("| Story | Description |", "|---|---|", "| b | x |"));
  none("# PS-X\n\n| Story | Status |\n|---|---|\n");
  none(stories("```", "| Story | Status |", "|---|---|", "```"));
  none(stories("| Story | Status |", "| no separator |"));
  // A Status table outside the Stories heading is not the one the epic rule reads.
  none("# PS-X\n\n## Stories\n\nSee below.\n\n## Notes\n\n| Story | Status |\n|---|---|\n");
});

// [SPEC-001#7]
test("epic row add: the first of two Status tables under the heading, a table that ends the file with no newline, CRLF (edge)", () => {
  const two = stories("| Story | Status |", "|---|---|", "", "| Story | Status |", "|---|---|");
  assert.equal(add(two).text.split("\n")[6], "| [story-a](./stories/story-a.md) | planned |", "the first table");
  const eof = "# PS-X\n\n## Stories\n\n| Story | Status |\n|---|---|";
  assert.equal(add(eof).text, `${eof}\n| [story-a](./stories/story-a.md) | planned |`);
  const crlfEof = "# PS-X\r\n\r\n## Stories\r\n\r\n| Story | Status |\r\n|---|---|";
  assert.equal(
    add(crlfEof).text,
    `${crlfEof}\r\n| [story-a](./stories/story-a.md) | planned |`,
    "no lone \\r at the end",
  );
  const crlf = "# PS-X\r\n\r\n## Stories\r\n\r\n| Story | Status |\r\n|---|---|\r\n\r\n";
  assert.equal(
    add(crlf).text,
    "# PS-X\r\n\r\n## Stories\r\n\r\n| Story | Status |\r\n|---|---|\r\n| [story-a](./stories/story-a.md) | planned |\r\n\r\n",
  );
});

// [SPEC-001#7]
test("epic row add: a title holding | or \\| is one escaped pipe, and the row keeps the header's number of cells (edge)", () => {
  const t = stories("| Story | Status | Description |", "|---|---|---|");
  for (const title of ["a | b", "a \\| b", "$& and $1"]) {
    const r = add(t, { title });
    assert.equal(cellCount(r.row), 3, title);
    assert.equal(r.row.split(" | ")[2].replace(/ \|$/, ""), title.startsWith("$") ? title : "a \\| b", title);
  }
});

// [SPEC-001#7]
test("epic row add: the link target is the raw path from the epic's folder, letters such as é kept; a name a raw target cannot carry is unlinkable (edge)", () => {
  const t = stories("| Story | Status |", "|---|---|");
  const folder = add(t, { storyPath: "/v/epics/PS-X/stories/story-f/README.md" });
  assert.equal(folder.row, "| [story-f](./stories/story-f/README.md) | planned |");
  const es = add(t, { storyPath: "/v/epics/PS-X/stories/story-descripción-del-épico.md" });
  assert.equal(es.row, "| [story-descripción-del-épico](./stories/story-descripción-del-épico.md) | planned |");
  assert.equal(storyLinkTarget("/v/e", "/v/e/stories/story-中文.md"), "./stories/story-中文.md");
  const qa = add(t, { storyPath: "/v/epics/PS-X/stories/story-q&a+c,d.md" });
  assert.equal(qa.row, "| [story-q&a+c,d](./stories/story-q&a+c,d.md) | planned |");
  for (const name of [
    "story a.md",
    "story(1).md",
    "story#1.md",
    "story?.md",
    "story%20.md",
    "story|b.md",
    "story[1].md",
  ]) {
    assert.equal(storyLinkTarget("/v/e", `/v/e/stories/${name}`), null, name);
    const r = add(t, { storyPath: `/v/epics/PS-X/stories/${name}` });
    assert.deepEqual([r.found, r.changed, r.unlinkable, r.text], [false, false, true, t], name);
  }
});

// [SPEC-001#7]
test("epic row add: a | in a plain-title cell stays escaped in the link text, so the next run finds the row and leaves it (edge)", () => {
  const t = stories("| Story | Status | Description |", "|---|---|---|", "| a \\| b | planned | x |");
  const r = add(t, { title: "a | b" });
  assert.equal(r.text.split("\n")[6], "| [a \\| b](./stories/story-a.md) | planned | x |");
  assert.equal(epicRowUpdate(r.text, { epicPath: EPIC, storyPath: STORY, status: "planned" }).changed, false);
  assert.equal(add(r.text, { title: "a | b" }).text, r.text);
});

// [SPEC-001#7]
test("epic row add: a fence before the Stories heading hides the row from the gates' reader, so the add writes nothing and says unlinkable (failure)", () => {
  const t = ["# PS-X", "", "````", "```", "````", "", "## Stories", "", "| Story | Status |", "|---|---|", ""].join(
    "\n",
  );
  const r = add(t);
  assert.deepEqual([r.found, r.changed, r.unlinkable, r.text], [false, false, true, t]);
});

// [SPEC-001#7] [SPEC-001#2]
test("epic row add: a new epic from each bundled template has a Stories table with no row, and its first story is the table's only row", () => {
  for (const lang of readdirSync(join(REPO, "templates")).filter((d) =>
    existsSync(join(REPO, "templates", d, "epic.md.tmpl")),
  )) {
    const epic = renderTemplate(loadTemplate(lang, "epic"), { id: "PS-X", title: "X", date: "2026-11-12", tags: "[]" });
    assert.ok(!/\]\(\.\/stories\//.test(epic), `${lang}: no placeholder row`);
    const r = add(epic, { title: "Первая" });
    assert.equal(r.added, true, lang);
    assert.equal((r.text.match(/\]\(\.\/stories\//g) || []).length, 1, lang);
    assert.ok(r.row.endsWith(" | planned | Первая |"), `${lang}: ${r.row}`);
  }
});

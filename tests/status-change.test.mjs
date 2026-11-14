// projectstore — tests/status-change.test.mjs: the writers of a story's status
// and assignee, and the gates that compute the same marks (PS-FLOW, "Every
// status change is stamped and logged in the story, and a command moves a
// story between the backlog and ToDo"). The read-again loop with an edit made
// meanwhile, the epic's Stories row and its script entry, and both gates run
// as the story command runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { storyText, withLine, daysAgo } from "./fixtures/flow.mjs";
import {
  replaceWithRetry,
  changeStatus,
  changeAssignee,
  syncEpicRow,
  epicFileOf,
  CHANGED_MEANWHILE,
  EPIC_ROW_MISSING,
} from "../scripts/status-change.mjs";
import { parseStatusLog, statusStamp } from "../scripts/status-log.mjs";
import { parseFrontmatter, loadTemplate, renderTemplate } from "../scripts/lib.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = "2026-11-10T09:00:00.000Z";
const VARS = { id: "story-a", title: "A", date: "2026-11-01", author: "Other", tags: "[]", epic_id: "PS-X" };
const STORY = renderTemplate(loadTemplate("en", "story"), VARS);
const EPIC = `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\n---\n\n# PS-X: X\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [a](./stories/story-a.md) | planned | the a |\n`;
const fm = (p) => parseFrontmatter(readFileSync(p, "utf8")).data;

function seed({ story = STORY, epic = EPIC, vaultCfg = null } = {}) {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
  writeFileSync(path, story);
  if (epic !== null) writeFileSync(join(vault, "epics", "PS-X", "epic.md"), epic);
  if (vaultCfg) writeFileSync(join(vault, ".projectstore.json"), JSON.stringify(vaultCfg));
  return { proj, vault, path, epic: join(vault, "epics", "PS-X", "epic.md") };
}

// [SPEC-001#7]
test("writer: one edit made meanwhile is kept and the change lands on top of it", () => {
  const { path } = seed();
  let edits = 0;
  const r = replaceWithRetry(path, (base) => ({ content: base.replace("status: planned", "status: todo") }), {
    afterCompute: (i) => {
      if (i === 0) {
        edits++;
        writeFileSync(path, readFileSync(path, "utf8").replace("# A", "# A (edited in Obsidian)"));
      }
    },
  });
  assert.equal(edits, 1);
  assert.equal(r.written, true);
  assert.equal(r.attempts, 2);
  const now = readFileSync(path, "utf8");
  assert.ok(now.includes("# A (edited in Obsidian)"), "the edit is kept");
  assert.ok(now.includes("status: todo"), "the change is on top");
});

// [SPEC-001#7]
test("writer: a file that changes before each of three replaces is story-changed-meanwhile and left as the last edit made it", () => {
  const { path } = seed();
  let last = null;
  const r = replaceWithRetry(path, (base) => ({ content: base.replace("status: planned", "status: todo") }), {
    afterCompute: (i) => {
      last = readFileSync(path, "utf8") + `\nedit ${i}\n`;
      writeFileSync(path, last);
    },
  });
  assert.equal(r.error, CHANGED_MEANWHILE);
  assert.equal(r.attempts, 3);
  assert.equal(r.written, false);
  assert.equal(readFileSync(path, "utf8"), last);
  assert.ok(!readFileSync(path, "utf8").includes("status: todo"));
});

// [SPEC-001#7]
test("writer: changeStatus writes the story, bumps updated and the footer, and sets the epic row; refusals run on fresh bytes", () => {
  const { path, epic } = seed();
  const r = changeStatus(path, { to: "todo", reason: "next up", actor: "move", at: AT });
  assert.equal(r.written, true, JSON.stringify(r));
  assert.equal(r.line, `- ${AT} status: planned → todo — next up (move)`);
  const f = fm(path);
  assert.equal(f.status, "todo");
  assert.equal(f.status_changed_at, AT);
  assert.equal(String(f.updated), "2026-11-10");
  assert.match(readFileSync(path, "utf8"), /\*Last updated: 2026-11-10\*/);
  assert.equal(r.epic.found, true);
  assert.match(readFileSync(epic, "utf8"), /\| \[a\]\(\.\/stories\/story-a\.md\) \| todo \| the a \|/);
  assert.equal(statusStamp(readFileSync(path, "utf8")).trusted, true);
  // The same change again is no change: nothing written, no line.
  const again = changeStatus(path, { to: "todo", reason: "next up", actor: "move", at: AT });
  assert.equal(again.written, false);
  assert.equal(parseStatusLog(readFileSync(path, "utf8")).length, 1);
  // A refusal reads the file as it is at the attempt.
  const refused = changeStatus(path, {
    to: "planned",
    reason: "r",
    actor: "move",
    at: AT,
    allow: (x) => `no: ${x.status}`,
  });
  assert.equal(refused.refused, "no: todo");
  assert.equal(fm(path).status, "todo");
});

// [SPEC-001#7]
test("writer: the refusal runs again on the fresh bytes: a story started meanwhile is refused on attempt 2 and left", () => {
  const { path } = seed();
  let edited = null;
  const r = changeStatus(path, {
    to: "todo",
    reason: "next up",
    actor: "move",
    at: AT,
    allow: (x) => (x.status === "planned" ? null : `refused: ${x.status}`),
    afterCompute: (i) => {
      if (i === 0) {
        edited = readFileSync(path, "utf8").replace("status: planned", "status: in-progress");
        writeFileSync(path, edited);
      }
    },
  });
  assert.equal(r.refused, "refused: in-progress");
  assert.equal(r.attempts, 2);
  assert.equal(r.written, false);
  assert.equal(readFileSync(path, "utf8"), edited, "untouched by the writer");
});

test("writer: changeAssignee logs an assignee: line and leaves the stamp", () => {
  const { path } = seed();
  const r = changeAssignee(path, { to: "Test", reason: "handed over", actor: "handover", at: AT });
  assert.equal(r.written, true);
  assert.equal(fm(path).assignee, "Test");
  assert.equal(fm(path).status_changed_at, undefined);
  assert.equal(parseStatusLog(readFileSync(path, "utf8"))[0].field, "assignee");
});

// [SPEC-001#7]
test("epic row: no row is epic-row-missing and the epic is not written; the entry exits 0 then, and 1 on a write error", () => {
  const list = `---\ntype: epic\n---\n\n# E\n\n## Stories\n\n1. [a](./stories/story-a.md) — planned\n`;
  const { path, epic } = seed({ epic: list });
  const r = syncEpicRow(path);
  assert.equal(r.note, EPIC_ROW_MISSING);
  assert.equal(r.written, false);
  assert.equal(readFileSync(epic, "utf8"), list);
  const run = (p) =>
    spawnSync(process.execPath, [join(REPO, "scripts", "status-change.mjs"), "epic-row", p], { encoding: "utf8" });
  const missing = run(path);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).note, EPIC_ROW_MISSING);
  // A table row: written, then idempotent.
  writeFileSync(epic, EPIC);
  const set = run(path);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual([JSON.parse(set.stdout).found, JSON.parse(set.stdout).written], [true, false], "already planned");
  writeFileSync(path, STORY.replace("status: planned", "status: in-progress"));
  assert.equal(JSON.parse(run(path).stdout).written, true);
  assert.equal(JSON.parse(run(path).stdout).written, false, "idempotent");
  // An epic that changes before every replace is a write error: exit 1.
  const drift = syncEpicRow(path, {
    afterCompute: (i) => writeFileSync(epic, `${EPIC}\n${i}\n`),
  });
  assert.equal(drift.error, CHANGED_MEANWHILE);
  assert.equal(run(join(dirname(path), "nope.md")).status, 1);
  assert.equal(epicFileOf("/v/epics/E/stories/s/README.md"), "/v/epics/E/epic.md");
  assert.equal(epicFileOf("/v/epics/E/story-s.md"), "/v/epics/E/epic.md");
});

// ─── The gates ─────────────────────────────────────────────────────────

function gate(proj, mode, path, extra = []) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), mode, path, ...extra], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: REPO },
    cwd: REPO,
    timeout: 15000,
  });
  return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}
const lines = (content) => parseStatusLog(content).map((e) => e.line.replace(/^- \S+ /, "- <ISO> "));

// [SPEC-001#7]
test("plan gate: a planned story assigned to someone else is in progress, stamped, logged, and assigned to default_author", () => {
  const { proj, path } = seed();
  const r = gate(proj, "plan", path);
  assert.equal(r.status, 0, r.stderr);
  const c = r.json.content;
  const f = parseFrontmatter(c).data;
  assert.equal(f.status, "in-progress");
  assert.equal(f.assignee, "Test");
  assert.ok(f.status_changed_at && f.status_changed_at === f.started_at, "one time per run");
  assert.match(c, /\| \*\*Assignee\*\* \| Test \|/);
  assert.match(c, /\| \*\*Status\*\* \| in-progress \|/);
  assert.deepEqual(lines(c), [
    "- <ISO> status: planned → in-progress — work started (plan gate)",
    "- <ISO> assignee: Other → Test — work started (plan gate)",
  ]);
  assert.ok(r.json.notes.includes("assignee: Other → Test"), r.json.notes.join("; "));
  assert.equal(readFileSync(path, "utf8"), STORY, "the gate writes no file");
});

// [SPEC-001#7]
test("plan gate: a second run, or a story in review, appends nothing and keeps the stamp and the assignee", () => {
  const { proj, path } = seed();
  writeFileSync(path, gate(proj, "plan", path).json.content);
  const first = readFileSync(path, "utf8");
  // Run by someone else now: the assignee still stays.
  const cfgPath = join(proj, ".projectstore", "projectstore.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), default_author: "Someone" }));
  const again = gate(proj, "plan", path).json.content;
  assert.deepEqual(lines(again), lines(first));
  assert.equal(parseFrontmatter(again).data.status_changed_at, parseFrontmatter(first).data.status_changed_at);
  assert.equal(parseFrontmatter(again).data.assignee, "Test");
  const review = STORY.replace("status: planned", "status: review");
  writeFileSync(path, review);
  const c = gate(proj, "plan", path).json.content;
  assert.equal(parseStatusLog(c), null, "no line, no section");
  assert.equal(parseFrontmatter(c).data.assignee, "Other");
});

// [SPEC-001#7]
test("plan gate: no default_author leaves the assignee; one outside flow.people gets a note", () => {
  const { proj, path, vault } = seed();
  const cfgPath = join(proj, ".projectstore", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, default_author: "" }));
  const none = gate(proj, "plan", path).json;
  assert.equal(parseFrontmatter(none.content).data.assignee, "Other");
  assert.equal(lines(none.content).length, 1);
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(join(vault, ".projectstore.json"), JSON.stringify({ flow: { people: { Other: { time: "full" } } } }));
  const noted = gate(proj, "plan", path).json;
  assert.ok(noted.notes.some((n) => /Test is not in the vault's flow\.people, so the person has no WIP limit/.test(n)));
  writeFileSync(join(vault, ".projectstore.json"), JSON.stringify({ flow: { people: { Test: { time: "full" } } } }));
  assert.ok(!gate(proj, "plan", path).json.notes.some((n) => /WIP limit/.test(n)));
});

// [SPEC-001#3]
test("gates: lifecycle_gates off writes the stamp and the line all the same", () => {
  const { proj, path } = seed({ vaultCfg: { lifecycle_gates: "off" } });
  const c = gate(proj, "plan", path).json.content;
  assert.ok(parseFrontmatter(c).data.status_changed_at);
  assert.equal(lines(c)[0], "- <ISO> status: planned → in-progress — work started (plan gate)");
});

// [SPEC-001#7]
test("close gate: --reason and --actor follow name one line, and no file is written", () => {
  const { proj, path, vault } = seed({ story: STORY.replace("status: planned", "status: in-progress") });
  const before = readdirSync(join(vault, "epics", "PS-X", "stories"));
  const r = gate(proj, "close", path, ["--reason", "merged: <url>", "--actor", "follow"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.json.content), ["- <ISO> status: in-progress → done — merged: <url> (follow)"]);
  assert.equal(parseFrontmatter(r.json.content).data.status, "done");
  assert.ok(parseFrontmatter(r.json.content).data.status_changed_at);
  assert.equal(readFileSync(path, "utf8"), STORY.replace("status: planned", "status: in-progress"));
  assert.deepEqual(readdirSync(join(vault, "epics", "PS-X", "stories")), before);
  // The default pair.
  const d = gate(proj, "close", path).json.content;
  assert.deepEqual(lines(d), ["- <ISO> status: in-progress → done — closed (close gate)"]);
  // A done story: nothing appended, the stamp kept.
  writeFileSync(path, d);
  const again = gate(proj, "close", path).json.content;
  assert.deepEqual(lines(again), lines(d));
  assert.equal(parseFrontmatter(again).data.status_changed_at, parseFrontmatter(d).data.status_changed_at);
});

// [SPEC-001#7]
test("gates: an actor outside the six, an empty reason or a reason with a line break exits 1", () => {
  const { proj, path } = seed();
  for (const extra of [["--actor", "robot"], ["--reason", ""], ["--reason", "a\nb"], ["--reason=  "]]) {
    const r = gate(proj, "plan", path, extra);
    assert.equal(r.status, 1, JSON.stringify(extra));
    assert.match(r.stderr, /projectstore\/story-section: /);
  }
  assert.equal(gate(proj, "plan", path, ["--actor=groom", "--reason=groomed"]).status, 0);
});

// [SPEC-001#7]
test("gates: existing Status log lines, one written by hand, stay byte-identical, and --check a minute later matches", () => {
  const hand = "- 2026-11-01T08:00:00Z status: none → planned — filed by hand (groom)";
  const note = "- a free note under the log";
  const story = STORY.replace("## Technical Notes", `## Status log\n\n${hand}\n${note}\n\n## Technical Notes`);
  for (const [mode, start] of [
    ["plan", story],
    ["close", story.replace("status: planned", "status: in-progress")],
  ]) {
    const { proj, path } = seed({ story: start });
    const first = gate(proj, mode, path).json.content;
    for (const l of [hand, note]) assert.ok(first.split("\n").includes(l), `${mode}: kept ${l}`);
    assert.ok(first.indexOf(note) < first.indexOf(`(${mode} gate)`), `${mode}: appended after the last line`);
    const base = join(mkdtempSync(join(tmpdir(), "ps-sc-")), "baseline.md");
    // A baseline made a minute before: every stamp and log time a minute earlier.
    writeFileSync(
      base,
      first.replace(/2026-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) => new Date(Date.parse(iso) - 60000).toISOString()),
    );
    const check = gate(proj, mode, path, ["--check", base]).json.check;
    assert.equal(check.match, true, `${mode}: ${check.drift.join("\n")}`);
    // A hand edit of an existing line's reason is drift.
    writeFileSync(path, start.replace("filed by hand", "filed by somebody"));
    assert.equal(gate(proj, mode, path, ["--check", base]).json.check.match, false, `${mode}: a reason is drift`);
  }
});

// ─── close --at: the event time, only from follow ──────────────────────

// [follow#6] [SPEC-001#7]
test("close --at with the actor close gate, with no actor, on plan, and with an unreadable instant exits 1 and prints no content (failure)", () => {
  const { proj, path } = seed({ story: STORY.replace("status: planned", "status: in-progress") });
  for (const extra of [
    ["--at", "2026-11-02T10:00:00Z", "--actor", "close gate"],
    ["--at", "2026-11-02T10:00:00Z"],
    ["--at", "2026-02-30T10:00:00Z", "--actor", "follow"],
    ["--at=soon", "--actor", "follow"],
    ["--at", "--actor", "follow"],
  ]) {
    const r = gate(proj, "close", path, extra);
    assert.equal(r.status, 1, JSON.stringify(extra));
    assert.equal(r.stdout, "", JSON.stringify(extra));
    assert.match(r.stderr, /projectstore\/story-section: .*--at/, JSON.stringify(extra));
  }
  const plan = gate(proj, "plan", path, ["--at", "2026-11-02T10:00:00Z", "--actor", "follow"]);
  assert.deepEqual([plan.status, plan.stdout], [1, ""]);
  assert.equal(readFileSync(path, "utf8"), STORY.replace("status: planned", "status: in-progress"));
});

// [follow#6] [SPEC-001#3] [SPEC-001#7]
test("close --at with --actor follow: closed_at, status_changed_at and the line take the instant in nowIso() form, updated and the footer the run's day", () => {
  const { proj, path } = seed({ story: STORY.replace("status: planned", "status: review") });
  const r = gate(proj, "close", path, ["--at", "2026-11-02T10:00:00Z", "--actor", "follow", "--reason", "merged: u"]);
  assert.equal(r.status, 0, r.stderr);
  const f = parseFrontmatter(r.json.content).data;
  assert.deepEqual(
    [f.status, f.closed_at, f.status_changed_at],
    ["done", "2026-11-02T10:00:00.000Z", "2026-11-02T10:00:00.000Z"],
  );
  assert.deepEqual(
    parseStatusLog(r.json.content).map((e) => e.line),
    ["- 2026-11-02T10:00:00.000Z status: review → done — merged: u (follow)"],
  );
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(String(f.updated), day);
  assert.match(r.json.content, new RegExp(`\\*Last updated: ${day}\\*`));
  // The gate's own close keeps the run time.
  const before = Date.now() - 1000;
  const own = parseFrontmatter(gate(proj, "close", path).json.content).data;
  assert.ok(Date.parse(own.closed_at) >= before, own.closed_at);
  assert.equal(own.status_changed_at, own.closed_at);
});

// ─── The plan gate's WIP check (the next verb's spec, contract 5) ──────

// A bound vault whose binding's default_author is `author` (none when null),
// with the story to plan at story-a, `vaultCfg` in the vault config and the
// held stories `held` maps from a slug to its text.
function wipSeed({ story = STORY, author = "Ada", vaultCfg = null, held = {} } = {}) {
  const fx = seed({ story, vaultCfg });
  const cfgPath = join(fx.proj, ".projectstore", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (author === null) delete cfg.default_author;
  else cfg.default_author = author;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  for (const [slug, text] of Object.entries(held))
    writeFileSync(join(fx.vault, "epics", "PS-X", "stories", `${slug}.md`), text);
  return fx;
}
const started = (slug, who, days = 2) =>
  storyText({ id: slug, assignee: who, log: [{ to: "in-progress", at: daysAgo(days) }] });
const awaitingClose = (slug, who) =>
  withLine(
    storyText({
      id: slug,
      assignee: who,
      log: [
        { to: "in-progress", at: daysAgo(4) },
        { to: "review", at: daysAgo(3) },
      ],
    }),
    { at: daysAgo(2), from: "review", to: "review", reason: "merged, awaiting evidence" },
  );
const heldBy = (who, n, { awaitingOne = false } = {}) => {
  const out = {};
  for (let i = 1; i <= n; i++)
    out[`story-h${i}`] = awaitingOne && i === n ? awaitingClose(`story-h${i}`, who) : started(`story-h${i}`, who, i);
  return out;
};
const ADA3 = { flow: { people: { Ada: { wip: 3 } } } };

// [next#5] [SPEC-001#7]
test("plan gate: wip counts the new assignee's held stories before the run: 3 of 3 is over, 2 of 3 is not, and one awaiting close is not held (edge)", () => {
  const over = wipSeed({ vaultCfg: ADA3, held: heldBy("Ada", 3) });
  const a = gate(over.proj, "plan", over.path);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.json.wip, { assignee: "Ada", held: 3, after: 4, limit: 3, over: true, unread: 0 });
  const under = wipSeed({ vaultCfg: ADA3, held: heldBy("Ada", 2) });
  assert.deepEqual(gate(under.proj, "plan", under.path).json.wip, {
    assignee: "Ada",
    held: 2,
    after: 3,
    limit: 3,
    over: false,
    unread: 0,
  });
  const waiting = wipSeed({ vaultCfg: ADA3, held: heldBy("Ada", 3, { awaitingOne: true }) });
  assert.deepEqual(gate(waiting.proj, "plan", waiting.path).json.wip, {
    assignee: "Ada",
    held: 2,
    after: 3,
    limit: 3,
    over: false,
    unread: 0,
  });
  // Without --over-wip the reason is the gate's own, over or not.
  assert.deepEqual(lines(a.json.content), [
    "- <ISO> status: planned → in-progress — work started (plan gate)",
    "- <ISO> assignee: Other → Ada — work started (plan gate)",
  ]);
});

// [next#5] [SPEC-001#7]
test("plan gate: wip names the binding's default_author, not the story's assignee who is at their own limit (edge)", () => {
  const fx = wipSeed({
    story: STORY.replace('assignee: "Other"', 'assignee: "Grace"'),
    vaultCfg: { flow: { people: { Ada: { wip: 3 }, Grace: { wip: 1 } } } },
    held: heldBy("Grace", 1),
  });
  const w = gate(fx.proj, "plan", fx.path).json.wip;
  assert.equal(w.assignee, "Ada");
  assert.equal(w.held, 0);
  assert.equal(w.over, false);
  // With no default_author, the story's own assignee is the new one.
  const own = wipSeed({
    story: STORY.replace('assignee: "Other"', 'assignee: "Grace"'),
    author: null,
    vaultCfg: { flow: { people: { Grace: { wip: 1 } } } },
    held: heldBy("Grace", 1),
  });
  assert.deepEqual(gate(own.proj, "plan", own.path).json.wip, {
    assignee: "Grace",
    held: 1,
    after: 2,
    limit: 1,
    over: true,
    unread: 0,
  });
});

// [next#5] [SPEC-001#7]
test("plan gate: wip is null on a story already in progress, for an assignee not in flow.people, and with no flow block (edge)", () => {
  const inProgress = wipSeed({ story: STORY.replace("status: planned", "status: in-progress"), vaultCfg: ADA3 });
  assert.equal(gate(inProgress.proj, "plan", inProgress.path).json.wip, null);
  const unlisted = wipSeed({ vaultCfg: { flow: { people: { Grace: { wip: 1 } } } }, held: heldBy("Ada", 3) });
  assert.equal(gate(unlisted.proj, "plan", unlisted.path).json.wip, null);
  const none = wipSeed({ held: heldBy("Ada", 3) });
  const r = gate(none.proj, "plan", none.path).json;
  assert.ok(Object.hasOwn(r, "wip"));
  assert.equal(r.wip, null);
  // close prints no wip.
  const closing = wipSeed({ story: STORY.replace("status: planned", "status: in-progress"), vaultCfg: ADA3 });
  assert.ok(!Object.hasOwn(gate(closing.proj, "close", closing.path).json, "wip"));
});

// [next#5] [SPEC-001#7]
test("plan gate: --over-wip at 3 of 3 adds `started over WIP limit 4/3` to the status line and the assignee line", () => {
  const fx = wipSeed({
    story: STORY.replace('assignee: "Other"', 'assignee: "Grace"'),
    vaultCfg: ADA3,
    held: heldBy("Ada", 3),
  });
  const r = gate(fx.proj, "plan", fx.path, ["--over-wip"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.wip.over, true);
  assert.deepEqual(lines(r.json.content), [
    "- <ISO> status: planned → in-progress — work started; started over WIP limit 4/3 (plan gate)",
    "- <ISO> assignee: Grace → Ada — work started; started over WIP limit 4/3 (plan gate)",
  ]);
  assert.ok(!r.json.notes.some((n) => n.includes("--over-wip changed nothing")));
  assert.equal(readFileSync(fx.path, "utf8"), STORY.replace('assignee: "Other"', 'assignee: "Grace"'), "no write");
});

// [next#5] [SPEC-001#7]
test("plan gate: --over-wip with wip null, or not over because a story closed meanwhile, keeps the reason and says it changed nothing (edge)", () => {
  const nul = wipSeed({ held: heldBy("Ada", 3) });
  const held = heldBy("Ada", 2);
  const notOver = wipSeed({ vaultCfg: ADA3, held });
  for (const fx of [nul, notOver]) {
    const r = gate(fx.proj, "plan", fx.path, ["--over-wip"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.json.content), [
      "- <ISO> status: planned → in-progress — work started (plan gate)",
      "- <ISO> assignee: Other → Ada — work started (plan gate)",
    ]);
    assert.ok(
      r.json.notes.some((n) => n.startsWith("--over-wip changed nothing")),
      r.json.notes.join("; "),
    );
  }
});

// [next#5] [SPEC-001#7]
test("plan gate: a layout the count cannot read leaves wip null with a note, and the gate goes on (failure)", () => {
  const fx = wipSeed({ vaultCfg: ADA3, held: heldBy("Ada", 3) });
  const cfgPath = join(fx.proj, ".projectstore", "projectstore.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), layout: "no-such-layout" }));
  const r = gate(fx.proj, "plan", fx.path);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.wip, null);
  assert.ok(
    r.json.notes.some((n) => n.startsWith("the WIP count could not be made, so wip is null")),
    r.json.notes.join("; "),
  );
  assert.equal(parseFrontmatter(r.json.content).data.status, "in-progress");
});

// [SPEC-001#7]
test("plan gate: a refused flow.people key such as __proto__ is not in flow.people, so the note names the person (edge)", () => {
  const fx = wipSeed({ author: "__proto__" });
  writeFileSync(join(fx.vault, ".projectstore.json"), '{"flow":{"people":{"__proto__":{"wip":1}}}}');
  const r = gate(fx.proj, "plan", fx.path).json;
  assert.equal(r.wip, null);
  assert.ok(
    r.notes.includes("__proto__ is not in the vault's flow.people, so the person has no WIP limit"),
    r.notes.join("; "),
  );
});

// [next#5] [SPEC-001#7]
test("close gate: --over-wip exits 1 and prints no result (failure)", () => {
  const fx = wipSeed({ story: STORY.replace("status: planned", "status: in-progress"), vaultCfg: ADA3 });
  const r = gate(fx.proj, "close", fx.path, ["--over-wip"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--over-wip/);
});

// [next#5] [SPEC-001#7]
test(
  "plan gate: a story file that cannot be read is counted in wip.unread, and a note says the count can be low (failure)",
  { skip: process.getuid?.() === 0 ? "root reads a file with no permissions" : false },
  () => {
    const fx = wipSeed({ vaultCfg: ADA3, held: heldBy("Ada", 2) });
    const locked = join(fx.vault, "epics", "PS-X", "stories", "story-h2.md");
    chmodSync(locked, 0o000);
    try {
      const r = gate(fx.proj, "plan", fx.path).json;
      assert.equal(r.wip.unread, 1);
      assert.equal(r.wip.held, 1);
      assert.ok(
        r.notes.some((n) => /could not be read, so the WIP count can be low/.test(n)),
        r.notes.join("; "),
      );
    } finally {
      chmodSync(locked, 0o644);
    }
  },
);

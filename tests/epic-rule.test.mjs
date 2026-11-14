// projectstore — tests/epic-rule.test.mjs: an epic becomes done when its
// stories are done or set aside and its Expected Results are checked
// (PS-FLOW, "An epic becomes done when all its stories are done and its
// Expected Results are checked"; the spec "The epic rule…", alias
// `epic-rule`, and SPEC-001 contracts 2 and 7 as amended 2026-11-11). The
// rule and its readers are tested as pure functions; the write, the sweep and
// the entry on fixture vaults. Contract 7 is verified by hand; its prose is
// pinned here as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  epicRule,
  expectedResults,
  storiesRows,
  applyEpicDone,
  applyEpicRule,
  runEpicRule,
} from "../scripts/epic-rule.mjs";
import { storyState } from "../scripts/stages.mjs";
import { setFm, setHeaderField } from "../scripts/status-log.mjs";
import { syncEpicRow, CHANGED_MEANWHILE } from "../scripts/status-change.mjs";
import { checkStoriesAndEpics } from "../scripts/doctor.mjs";
import {
  loadTemplate,
  renderTemplate,
  headingLineRe,
  footerDateRe,
  loadHeadingsRegistry,
  parseFrontmatter,
} from "../scripts/lib.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { storyText } from "./fixtures/flow.mjs";
import {
  closure,
  hookEntries,
  importSpecifiers,
  dynamicSpecifiers,
  verbModuleSpecifiers,
} from "./fixtures/imports.mjs";
import { sourceHarness } from "../scripts/harness.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(REPO, "scripts", "epic-rule.mjs");
const AT = "2026-11-11T12:00:00.000Z";
const DAY = "2026-11-11";
const registry = loadHeadingsRegistry();
const read = (p) => readFileSync(p, "utf8");

// ─── Fixtures ──────────────────────────────────────────────────────────

// A story file with a status, or with none (undefined).
const storyFile = (status) =>
  `---\ntype: story\ntitle: "s"\n${status === undefined ? "" : `status: ${status}\n`}---\n\n# s\n`;

// The text of section `id` replaced by `body` (the heading line kept).
function setSection(text, id, body) {
  const m = text.match(headingLineRe(id));
  assert.ok(m, `the template has the ${id} heading`);
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  return `${text.slice(0, start)}\n\n${body}\n\n${text.slice(end)}`;
}

// An epic rendered from the bundled template: its status (frontmatter and
// header row), its Expected Results body, and its Stories table's data rows
// in place of the template's (null keeps the template's row).
function epicText({ id = "PS-X", status = "planned", lang = "en", rows = null, results = "- [x] it works" } = {}) {
  let t = renderTemplate(loadTemplate(lang, "epic"), { id, title: id, date: "2026-10-01", tags: "[]" });
  if (status !== "planned") {
    t = setFm(t, "status", status);
    t = setHeaderField(t, "status", status).text;
  }
  if (rows !== null)
    t = t.replace("| [story-001](./stories/story-001.md) | planned |  |\n", rows.map((r) => `${r}\n`).join(""));
  if (results !== null) t = setSection(t, "expected_results", results);
  return t;
}
const linkRows = (stories) =>
  Object.entries(stories).map(([slug, s]) => `| [${slug}](./stories/${slug}.md) | ${s} |  |`);

// A vault folder: epics maps an id to {stories: {slug: status}, text?, ...epicText options}.
function makeVault(epics) {
  const root = mkdtempSync(join(tmpdir(), "ps-epic-rule-"));
  const epicsDir = join(root, "epics");
  for (const [id, spec] of Object.entries(epics)) {
    const dir = join(epicsDir, id);
    mkdirSync(join(dir, "stories"), { recursive: true });
    const stories = spec.stories || {};
    for (const [slug, status] of Object.entries(stories))
      writeFileSync(join(dir, "stories", `${slug}.md`), storyFile(status));
    writeFileSync(join(dir, "epic.md"), spec.text ?? epicText({ id, rows: linkRows(stories), ...spec }));
  }
  return {
    root,
    epicsDir,
    epic: (id) => join(epicsDir, id, "epic.md"),
    story: (id, slug) => join(epicsDir, id, "stories", `${slug}.md`),
  };
}
const sweep = (v, opts = {}) => applyEpicRule({ epicsDir: v.epicsDir, at: AT, ...opts });
const statusOf = (p) => parseFrontmatter(read(p)).data.status;
const cli = (args) => {
  const r = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", timeout: 60000 });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};
const judge = (text, stories, epicPath = "/v/epics/PS-X/epic.md") =>
  epicRule(text, {
    epicPath,
    stories: Object.entries(stories).map(([slug, status]) => ({
      path: join(dirname(epicPath), "stories", `${slug}.md`),
      status,
    })),
  });

// ─── Contract 1: the rule is a function of state ───────────────────────

// [epic-rule#1]
test("storyState: done for done and closed, set-aside for NOT_ACTIONABLE, open for the rest, trimmed and lower-cased", () => {
  for (const s of ["done", "closed", "Done ", " CLOSED"]) assert.equal(storyState(s), "done", s);
  for (const s of ["superseded", "deferred", "Parked "]) assert.equal(storyState(s), "set-aside", s);
  for (const s of [
    "planned",
    "todo",
    "in-progress",
    "in_progress",
    "review",
    "soon",
    "",
    null,
    undefined,
    "constructor",
  ])
    assert.equal(storyState(s), "open", String(s));
});

// [epic-rule#1]
test("the rule: a planned epic with stories done, done and superseded, every Expected Result checked, becomes done", () => {
  const stories = { "story-a": "done", "story-b": "done", "story-c": "superseded" };
  assert.equal(judge(epicText({ rows: linkRows(stories) }), stories).verdict, "done");
  const v = makeVault({ "PS-X": { stories } });
  const r = sweep(v, { write: true });
  assert.deepEqual(r.moved, ["PS-X"]);
  assert.equal(statusOf(v.epic("PS-X")), "done");
});

// [epic-rule#1]
test("the rule: an epic with no stories, and one whose stories are all superseded, stay as they are (edge)", () => {
  const v = makeVault({
    "PS-NONE": { stories: {} },
    "PS-GONE": { stories: { "story-a": "superseded", "story-b": "superseded" } },
  });
  const before = [read(v.epic("PS-NONE")), read(v.epic("PS-GONE"))];
  const r = sweep(v, { write: true });
  assert.deepEqual(r.epics, []);
  assert.deepEqual(r.moved, []);
  assert.equal(r.checked, 2);
  assert.deepEqual([read(v.epic("PS-NONE")), read(v.epic("PS-GONE"))], before);
  assert.equal(judge(epicText({ rows: [] }), {}).why, "no-done-story");
});

// [epic-rule#1]
test("the rule: done story files, one more planned, soon or with no status, and an open file-less row: stays, unlisted, no note (edge)", () => {
  for (const other of ["planned", "soon", undefined]) {
    const stories = { "story-a": "done", "story-b": other };
    const rows = [...linkRows({ "story-a": "done" }), "| a plain row | planned |  |"];
    const v = makeVault({ "PS-X": { stories, rows } });
    const before = read(v.epic("PS-X"));
    const r = sweep(v, { write: true });
    assert.deepEqual(r.epics, [], String(other));
    assert.deepEqual(r.notes, [], String(other));
    assert.equal(read(v.epic("PS-X")), before, String(other));
  }
});

// [epic-rule#1]
test("the rule: an in-progress epic with stories closed, `Done ` and parked becomes done (edge)", () => {
  const stories = { "story-a": "closed", "story-b": '"Done "', "story-c": "parked" };
  const v = makeVault({ "PS-X": { status: "in-progress", stories, rows: [] } });
  assert.equal(parseFrontmatter(read(v.story("PS-X", "story-b"))).data.status, "Done ", "the status keeps its space");
  const r = sweep(v, { write: true });
  assert.deepEqual(r.moved, ["PS-X"]);
  assert.equal(r.epics[0].from, "in-progress");
  assert.equal(statusOf(v.epic("PS-X")), "done");
});

// [epic-rule#1]
test("the rule: file-less rows are judged by their Status cell, linked rows by their file; rows-open names the open file-less rows only (edge)", () => {
  const stories = { "story-a": "done", "story-b": "done" };
  const rows = [
    "| a plain title | planned |  |",
    "| [story-001](./stories/story-001.md) | planned |  |",
    "| [gone](./stories/story-gone.md) | superseded |  |",
    "| [b](./stories/story-b.md) | planned |  |",
    "| [[story-a\\|A]] | soon |  |",
  ];
  const v = makeVault({ "PS-X": { stories, rows } });
  const before = read(v.epic("PS-X"));
  const r = sweep(v, { write: true });
  assert.equal(read(v.epic("PS-X")), before, "the epic stays as it is");
  assert.equal(r.epics.length, 1);
  assert.equal(r.epics[0].verdict, "rows-open");
  assert.equal(r.epics[0].to, null);
  assert.deepEqual(r.notes, [
    {
      code: "epic-rows-without-file",
      epic: "PS-X",
      message: r.notes[0].message,
      rows: ["a plain title", "story-001"],
    },
  ]);
  assert.match(r.notes[0].message, /a plain title; story-001/);
});

// [epic-rule#1]
test("the rule: a row's title is its first link's text, else its Story cell, else its first cell; tables without a Status column are not read (edge)", () => {
  const t = [
    "---\nstatus: planned\n---\n\n# E\n\n## Stories\n",
    "| Description | Story | Status |\n|---|---|---|\n| d1 | the story cell | planned |\n| d2 | x [[stories/story-q\\|Q]] | planned |\n",
    "\n| Story | Note |\n|---|---|\n| no status column | planned |\n",
    "\n| First | Status |\n|---|---|\n| first cell | planned |\n",
    "\n```\n| Story | Status |\n|---|---|\n| fenced | planned |\n```\n",
    "\n## Next\n\n| Story | Status |\n|---|---|\n| below the section | planned |\n",
  ].join("");
  assert.deepEqual(
    storiesRows(t).map((r) => r.title),
    ["the story cell", "Q", "first cell"],
  );
  // A Stories table in another bundled language is read by its labels.
  const ru = epicText({ lang: "ru", rows: ["| без файла | planned |  |"] });
  assert.deepEqual(
    storiesRows(ru).map((r) => [r.title, r.status]),
    [["без файла", "planned"]],
  );
});

// [epic-rule#1]
test("the rule: a passing epic with no Stories heading, one with the heading and no table, and one whose only table has no Status column all become done (edge)", () => {
  const base = (id) => epicText({ id, rows: [] });
  const noHeading = base("PS-A").replace(/^## Stories\n[\s\S]*?(?=^## )/m, "");
  const noTable = setSection(base("PS-B"), "stories", "The stories are listed in the board.");
  const noStatus = setSection(base("PS-C"), "stories", "| Story | Description |\n|---|---|\n| open work | planned |");
  assert.ok(!headingLineRe("stories").test(noHeading));
  const v = makeVault({
    "PS-A": { stories: { "story-a": "done" }, text: noHeading },
    "PS-B": { stories: { "story-a": "done" }, text: noTable },
    "PS-C": { stories: { "story-a": "done" }, text: noStatus },
  });
  const r = sweep(v, { write: true });
  assert.deepEqual(r.moved, ["PS-A", "PS-B", "PS-C"]);
});

// ─── Contract 2: Expected Results ──────────────────────────────────────

// [epic-rule#2]
test("Expected Results: a ru epic with one unchecked item of three stays, and epic-results-open names it with 1 of 3", () => {
  const results = "- [x] первое\n- [ ] второе\n- [x] третье";
  const v = makeVault({ "PS-RU": { lang: "ru", stories: { "story-a": "done" }, results } });
  assert.match(read(v.epic("PS-RU")), /^## Ожидаемые результаты$/m);
  const before = read(v.epic("PS-RU"));
  const r = sweep(v, { write: true });
  assert.equal(read(v.epic("PS-RU")), before);
  assert.equal(r.epics[0].verdict, "results-open");
  assert.match(r.epics[0].line, /1 of 3 Expected Results unchecked/);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].code, "epic-results-open");
  assert.equal(r.notes[0].epic, "PS-RU");
  assert.equal(r.notes[0].unchecked, 1);
  assert.equal(r.notes[0].total, 3);
  assert.deepEqual(Object.keys(r.notes[0]).sort(), ["code", "epic", "message", "total", "unchecked"]);
});

// [epic-rule#2]
test("Expected Results: a `- [ ]` inside a fenced block or inline code is not an item (edge)", () => {
  const results = "- [x] one\n\n```\n- [ ] in a fence\n```\n\nWrite `- [ ]` for a new one.\n- [x] two";
  assert.deepEqual(expectedResults(epicText({ results })), { found: true, total: 2, unchecked: 0 });
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, results } });
  assert.deepEqual(sweep(v, { write: true }).moved, ["PS-X"]);
});

// [epic-rule#2]
test("Expected Results: an unchecked item nested under a checked one holds the epic (edge)", () => {
  const results = "- [x] parent\n  - [ ] child\n  - [x] other child";
  assert.deepEqual(expectedResults(epicText({ results })), { found: true, total: 3, unchecked: 1 });
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, results } });
  const r = sweep(v, { write: true });
  assert.equal(r.epics[0].verdict, "results-open");
  assert.equal(r.notes[0].code, "epic-results-open");
  assert.equal(statusOf(v.epic("PS-X")), "planned");
});

// [epic-rule#2]
test("Expected Results: the template's empty `- [ ]` left as rendered is an unchecked item (edge)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, results: null } });
  assert.match(read(v.epic("PS-X")), /^## Expected Results\n\n- \[ \]\n/m, "the template's placeholder");
  const r = sweep(v, { write: true });
  assert.equal(r.epics[0].verdict, "results-open");
  assert.deepEqual([r.notes[0].unchecked, r.notes[0].total], [1, 1]);
  assert.equal(statusOf(v.epic("PS-X")), "planned");
});

// [epic-rule#2]
test("Expected Results: an epic with no section, and one whose section holds prose only, both become done (edge)", () => {
  const noSection = epicText({ id: "PS-A", rows: [] }).replace(/^## Expected Results\n[\s\S]*?(?=^## )/m, "");
  assert.deepEqual(expectedResults(noSection), { found: false, total: 0, unchecked: 0 });
  const prose = epicText({ id: "PS-B", rows: [], results: "The board shows the new column." });
  assert.deepEqual(expectedResults(prose), { found: true, total: 0, unchecked: 0 });
  const v = makeVault({
    "PS-A": { stories: { "story-a": "done" }, text: noSection },
    "PS-B": { stories: { "story-a": "done" }, text: prose },
  });
  assert.deepEqual(sweep(v, { write: true }).moved, ["PS-A", "PS-B"]);
});

// ─── Contract 3: never back, never over a set-aside epic ───────────────

// [epic-rule#3]
test("never back: a done epic one of whose stories went back to planned is byte-identical", () => {
  const v = makeVault({ "PS-X": { status: "done", stories: { "story-a": "done", "story-b": "planned" } } });
  const before = read(v.epic("PS-X"));
  const r = sweep(v, { write: true });
  assert.equal(read(v.epic("PS-X")), before);
  assert.deepEqual([r.epics, r.moved, r.notes], [[], [], []]);
});

// [epic-rule#3]
test("never over a set-aside epic: a superseded epic whose stories are all done is byte-identical (edge)", () => {
  for (const status of ["superseded", "deferred", "parked", "closed"]) {
    const v = makeVault({ "PS-X": { status, stories: { "story-a": "done" } } });
    const before = read(v.epic("PS-X"));
    const r = sweep(v, { write: true });
    assert.equal(read(v.epic("PS-X")), before, status);
    assert.deepEqual(r.epics, [], status);
  }
});

// [epic-rule#3]
test("never over a hand edit: an epic marked done by hand between the read and the replace keeps the hand edit only, exit 0 (failure)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  let edited = null;
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], {
    at: AT,
    afterCompute: (i, { path }) => {
      if (i === 0) {
        edited = read(path).replace("status: planned", "status: done");
        writeFileSync(path, edited);
      }
    },
  });
  assert.equal(code, 0);
  assert.equal(read(v.epic("PS-X")), edited, "the file holds the hand edit and nothing else");
  assert.deepEqual([result.epics, result.moved], [[], []]);
});

// ─── Contract 4: the write ─────────────────────────────────────────────

// [epic-rule#4]
test("the write: on en, ru and zh epics the diff is the frontmatter status and updated, the header Status and Updated rows, and the footer date", () => {
  for (const lang of ["en", "ru", "zh"]) {
    const v = makeVault({ "PS-X": { lang, stories: { "story-a": "done" }, rows: [] } });
    const before = read(v.epic("PS-X")).split("\n");
    const r = sweep(v, { write: true });
    assert.deepEqual(r.moved, ["PS-X"], lang);
    const after = read(v.epic("PS-X")).split("\n");
    assert.equal(after.length, before.length, lang);
    const changed = before.flatMap((l, i) => (l === after[i] ? [] : [[l, after[i]]]));
    const status = registry.fields.status[lang][0];
    const updated = registry.fields.updated[lang][0];
    assert.deepEqual(
      changed,
      [
        ["status: planned", "status: done"],
        ["updated: 2026-10-01", `updated: ${DAY}`],
        [`| **${status}** | planned |`, `| **${status}** | done |`],
        [`| **${updated}** | 2026-10-01 |`, `| **${updated}** | ${DAY} |`],
        [
          before.find((l) => footerDateRe().test(l)),
          before.find((l) => footerDateRe().test(l)).replace("2026-10-01", DAY),
        ],
      ],
      lang,
    );
  }
});

// [epic-rule#4]
test("the write: with no `updated:` the key is appended as the frontmatter's last line, and the whole footer text is replaced by the day (edge)", () => {
  const text = epicText({ rows: [] })
    .replace("updated: 2026-10-01\n", "")
    .replace("*Last updated: 2026-10-01*", "*Last updated: 2026-10-01, draft*");
  const out = applyEpicDone(text, { day: DAY });
  const fm = out.match(/^---\n([\s\S]*?)\n---/)[1].split("\n");
  assert.equal(fm[fm.length - 1], `updated: ${DAY}`);
  assert.match(out, new RegExp(`^\\*Last updated: ${DAY}\\*$`, "m"));
  assert.ok(!out.includes("draft"));
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, text } });
  sweep(v, { write: true });
  assert.equal(read(v.epic("PS-X")), out);
});

// [epic-rule#4]
test("the write: an epic edited once between the read and the replace keeps the edit and becomes done, exit 0 (edge)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], {
    at: AT,
    afterCompute: (i, { path }) => {
      if (i === 0) writeFileSync(path, read(path).replace("<!-- Background,", "Edited meanwhile.\n\n<!-- Background,"));
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(result.moved, ["PS-X"]);
  const text = read(v.epic("PS-X"));
  assert.match(text, /Edited meanwhile\./);
  assert.equal(statusOf(v.epic("PS-X")), "done");
});

// [epic-rule#4]
test("the write: an epic that changes before each of the three replaces gives story-changed-meanwhile, exit 1, and the file as its last editor left it (failure)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  let last = null;
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], {
    at: AT,
    afterCompute: (i, { path }) => {
      last = read(path) + `\nedit ${i}\n`;
      writeFileSync(path, last);
    },
  });
  assert.equal(code, 1);
  assert.equal(result.epics[0].verdict, "error");
  assert.equal(result.epics[0].error, CHANGED_MEANWHILE);
  assert.deepEqual(result.moved, []);
  assert.equal(read(v.epic("PS-X")), last);
});

// [epic-rule#4]
test("the write: an Expected Result unchecked between the read and the replace leaves the epic unwritten, and epic-results-open names it (edge)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  let edited = null;
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], {
    at: AT,
    afterCompute: (i, { path }) => {
      if (i === 0) {
        edited = read(path).replace("- [x] it works", "- [ ] it works");
        writeFileSync(path, edited);
      }
    },
  });
  assert.equal(code, 0);
  assert.equal(read(v.epic("PS-X")), edited);
  assert.deepEqual(result.moved, []);
  assert.equal(result.epics[0].verdict, "results-open");
  assert.deepEqual(
    result.notes.map((n) => [n.code, n.epic]),
    [["epic-results-open", "PS-X"]],
  );
});

// [epic-rule#4]
test("the write: an epic whose header has no Updated row gets its Status row set to done and no row added (edge)", () => {
  const text = epicText({ rows: [] }).replace("| **Updated** | 2026-10-01 |\n", "");
  const out = applyEpicDone(text, { day: DAY });
  assert.match(out, /^\| \*\*Status\*\* \| done \|$/m);
  assert.ok(!/\*\*Updated\*\*/.test(out));
  assert.equal(out.split("\n").length, text.split("\n").length);
});

// ─── Contract 5: by state, so it converges ─────────────────────────────

// [epic-rule#5]
test("by state: two passing epics are both made done by one run, and a second run writes nothing", () => {
  const v = makeVault({ "PS-A": { stories: { "story-a": "done" } }, "PS-B": { stories: { "story-b": "done" } } });
  const first = sweep(v, { write: true });
  assert.deepEqual(first.moved, ["PS-A", "PS-B"]);
  const after = [read(v.epic("PS-A")), read(v.epic("PS-B"))];
  const second = sweep(v, { write: true, at: "2026-11-12T09:00:00.000Z" });
  assert.deepEqual([second.epics, second.moved, second.notes], [[], [], []]);
  assert.deepEqual([read(v.epic("PS-A")), read(v.epic("PS-B"))], after);
});

// [epic-rule#5]
test(
  "by state: an epic whose write failed on a read-only folder becomes done once the folder is writable again (failure)",
  { skip: process.getuid?.() === 0 ? "root ignores a read-only directory" : false },
  () => {
    const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
    const dir = dirname(v.epic("PS-X"));
    const before = read(v.epic("PS-X"));
    chmodSync(dir, 0o555);
    let first;
    try {
      first = runEpicRule([v.story("PS-X", "story-a"), "--write"], { at: AT });
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(first.code, 1);
    assert.equal(first.result.epics[0].verdict, "error");
    assert.ok(first.result.epics[0].error);
    assert.equal(read(v.epic("PS-X")), before);
    const second = runEpicRule([v.story("PS-X", "story-a"), "--write"], { at: AT });
    assert.equal(second.code, 0);
    assert.deepEqual(second.result.moved, ["PS-X"]);
    assert.equal(statusOf(v.epic("PS-X")), "done");
  },
);

// [epic-rule#5]
test("by state: an epic under epics/_templates/ is not read; the board's three story file shapes all count (edge)", () => {
  const v = makeVault({ "PS-X": { stories: {}, rows: [] } });
  const tpl = join(v.epicsDir, "_templates");
  mkdirSync(join(tpl, "stories"), { recursive: true });
  writeFileSync(join(tpl, "stories", "story-t.md"), storyFile("done"));
  writeFileSync(join(tpl, "epic.md"), epicText({ id: "TEMPLATE", rows: [] }));
  const shapes = (folder, standalone) => {
    const dir = dirname(v.epic("PS-X"));
    writeFileSync(join(dir, "stories", "story-flat.md"), storyFile("done"));
    mkdirSync(join(dir, "stories", "story-folder"), { recursive: true });
    writeFileSync(join(dir, "stories", "story-folder", "README.md"), storyFile(folder));
    writeFileSync(join(dir, "story-standalone.md"), storyFile(standalone));
  };
  const seen = [];
  const spy = (p) => (seen.push(p), read(p));
  const tplBefore = read(join(tpl, "epic.md"));
  // Controls: a folder-shape or a standalone story that is open holds the epic.
  for (const [folder, standalone] of [
    ["planned", "done"],
    ["done", "planned"],
  ]) {
    shapes(folder, standalone);
    assert.deepEqual(sweep(v, { write: true, read: spy }).moved, [], `${folder}/${standalone}`);
  }
  shapes("done", "done");
  const r = sweep(v, { write: true, read: spy });
  assert.deepEqual(r.moved, ["PS-X"]);
  assert.equal(r.checked, 1, "the _templates epic is not judged");
  assert.ok(seen.length >= 3 && !seen.some((p) => p.includes("_templates")), "nothing under _templates is read");
  assert.equal(read(join(tpl, "epic.md")), tplBefore);
});

// [epic-rule#5]
test("by state: a story file that cannot be read is an error on its epic only; the other becomes done, exit 1, moved names it (failure)", () => {
  const v = makeVault({
    "PS-A": { stories: { "story-a": "done", "story-bad": "done" } },
    "PS-B": { stories: { "story-b": "done" } },
  });
  const before = read(v.epic("PS-A"));
  const readSeam = (p) => {
    if (p.endsWith("story-bad.md")) throw new Error("EACCES: permission denied");
    return read(p);
  };
  const { code, result } = runEpicRule([v.story("PS-B", "story-b"), "--write"], { at: AT, read: readSeam });
  assert.equal(code, 1);
  assert.deepEqual(result.moved, ["PS-B"]);
  const a = result.epics.find((e) => e.epic === "PS-A");
  assert.equal(a.verdict, "error");
  assert.match(a.error, /1 story file of this epic cannot be read/);
  assert.equal(read(v.epic("PS-A")), before, "that epic is left");
  assert.equal(statusOf(v.epic("PS-B")), "done");
});

// [epic-rule#5]
test("by state: a done epic holding a story file that cannot be read lists no error, exit 0 (edge)", () => {
  const v = makeVault({ "PS-X": { status: "done", stories: { "story-a": "done", "story-bad": "done" } } });
  const readSeam = (p) => {
    if (p.endsWith("story-bad.md")) throw new Error("EACCES: permission denied");
    return read(p);
  };
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], { at: AT, read: readSeam });
  assert.equal(code, 0);
  assert.deepEqual([result.epics, result.moved], [[], []]);
});

// ─── Contract 6: the entry, its output and its exits ───────────────────

const TOP = ["write", "assumed", "checked", "epics", "moved", "notes", "error"];
const ITEM = ["epic", "path", "from", "to", "verdict", "line", "error"];

// [epic-rule#6]
test("the entry: bare it plans on the vault as it is, with --assume-done as if the story were done; neither writes", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done", "story-b": "review" } } });
  const before = read(v.epic("PS-X"));
  const bare = cli([v.story("PS-X", "story-b")]);
  assert.equal(bare.code, 0, bare.err);
  assert.deepEqual(Object.keys(bare.json), TOP);
  assert.deepEqual(
    [bare.json.write, bare.json.assumed, bare.json.checked, bare.json.epics, bare.json.moved],
    [false, null, 1, [], []],
  );
  const plan = cli([v.story("PS-X", "story-b"), "--assume-done"]);
  assert.equal(plan.code, 0, plan.err);
  assert.equal(plan.json.assumed, v.story("PS-X", "story-b"));
  assert.equal(plan.json.epics.length, 1);
  assert.deepEqual(Object.keys(plan.json.epics[0]), ITEM);
  assert.deepEqual(
    [plan.json.epics[0].epic, plan.json.epics[0].path, plan.json.epics[0].from, plan.json.epics[0].to],
    ["PS-X", v.epic("PS-X"), "planned", "done"],
  );
  assert.equal(plan.json.epics[0].verdict, "done");
  assert.match(plan.json.epics[0].line, /^PS-X: planned → done/);
  assert.deepEqual(plan.json.moved, []);
  assert.equal(read(v.epic("PS-X")), before, "nothing is written");
  assert.equal(statusOf(v.story("PS-X", "story-b")), "review");
});

// [epic-rule#6]
test("the entry: --assume-done on B's story lists A, which already passes, and B, with to: done; moved is empty and nothing is written", () => {
  const v = makeVault({
    "PS-A": { stories: { "story-a": "done" } },
    "PS-B": { stories: { "story-b1": "done", "story-b2": "review" } },
  });
  const before = [read(v.epic("PS-A")), read(v.epic("PS-B"))];
  const plan = cli([v.story("PS-B", "story-b2"), "--assume-done"]);
  assert.equal(plan.code, 0, plan.err);
  assert.deepEqual(
    plan.json.epics.map((e) => [e.epic, e.to]),
    [
      ["PS-A", "done"],
      ["PS-B", "done"],
    ],
  );
  assert.deepEqual(plan.json.moved, []);
  assert.deepEqual([read(v.epic("PS-A")), read(v.epic("PS-B"))], before);
});

// [epic-rule#6]
test("the entry: after the close is written, --write makes the epic done, moved names it, exit 0, and no derived view is touched", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done", "story-b": "review" } } });
  const views = { [join(v.root, "kanban.md")]: "stub board\n", [join(v.epicsDir, "README.md")]: "stub index\n" };
  for (const [p, c] of Object.entries(views)) writeFileSync(p, c);
  writeFileSync(v.story("PS-X", "story-b"), storyFile("done"));
  const r = cli([v.story("PS-X", "story-b"), "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(r.json), TOP);
  assert.equal(r.json.write, true);
  assert.deepEqual(r.json.moved, ["PS-X"]);
  assert.equal(r.json.error, null);
  assert.equal(statusOf(v.epic("PS-X")), "done");
  for (const [p, c] of Object.entries(views)) assert.equal(read(p), c, `${p} is not touched`);
});

// [epic-rule#6]
test("the entry: --assume-done with --write, no story path, or an unknown option is exit 2 and writes nothing (edge)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  const before = read(v.epic("PS-X"));
  for (const args of [
    [v.story("PS-X", "story-a"), "--assume-done", "--write"],
    [],
    ["--write"],
    [v.story("PS-X", "story-a"), "--force"],
    [v.story("PS-X", "story-a"), v.story("PS-X", "story-a")],
  ]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.ok(r.json.error, args.join(" "));
    assert.match(r.err, /usage: epic-rule\.mjs <story-path>/);
    assert.deepEqual(Object.keys(r.json), TOP);
  }
  assert.equal(read(v.epic("PS-X")), before);
  assert.throws(() => sweep(v, { write: true, assume: v.story("PS-X", "story-a") }), /plan only/);
});

// [epic-rule#6]
test("the entry: a story path that names no file is exit 1 and writes nothing (failure)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  const before = read(v.epic("PS-X"));
  const r = cli([join(dirname(v.story("PS-X", "story-a")), "story-nowhere.md"), "--write"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /story not found/);
  assert.deepEqual(r.json.moved, []);
  assert.equal(read(v.epic("PS-X")), before);
});

// [epic-rule#6]
test("the entry: a story with no epic.md beside it is exit 1 with an error, and nothing is written (failure)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" } } });
  const loose = join(v.root, "elsewhere", "stories", "story-loose.md");
  mkdirSync(dirname(loose), { recursive: true });
  writeFileSync(loose, storyFile("done"));
  const before = read(v.epic("PS-X"));
  const r = cli([loose, "--write"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /the story's epic has no epic\.md: .*elsewhere[\\/]epic\.md$/);
  assert.deepEqual([r.json.checked, r.json.epics, r.json.moved], [0, [], []]);
  assert.equal(read(v.epic("PS-X")), before);
});

// [epic-rule#5]
test(
  "by state: an epic.md that cannot be read is listed as an error under its folder's name with from null; the others are still judged, exit 1 (failure)",
  { skip: process.getuid?.() === 0 ? "root reads a file with no permissions" : false },
  () => {
    const v = makeVault({ "PS-A": { stories: { "story-a": "done" } }, "PS-B": { stories: { "story-b": "done" } } });
    chmodSync(v.epic("PS-A"), 0o000);
    let r;
    try {
      r = runEpicRule([v.story("PS-B", "story-b"), "--write"], { at: AT });
    } finally {
      chmodSync(v.epic("PS-A"), 0o644);
    }
    assert.equal(r.code, 1);
    assert.equal(r.result.checked, 2);
    const a = r.result.epics.find((e) => e.path === v.epic("PS-A"));
    assert.deepEqual([a.epic, a.from, a.to, a.verdict], ["PS-A", null, null, "error"]);
    assert.match(a.error, /EACCES|permission/i);
    assert.deepEqual(r.result.moved, ["PS-B"]);
    assert.equal(statusOf(v.epic("PS-A")), "planned");
    assert.equal(statusOf(v.epic("PS-B")), "done");
  },
);

// [epic-rule#6]
test("the entry: an epic with no status moves with from null and the line `none → done` (edge)", () => {
  const text = epicText({ rows: [] }).replace("status: planned\n", "");
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, text } });
  const r = cli([v.story("PS-X", "story-a"), "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.epics[0].from, null);
  assert.match(r.json.epics[0].line, /^PS-X: none → done — 1 story done or set aside, 1 Expected Result checked$/);
  assert.deepEqual(r.json.moved, ["PS-X"]);
  assert.equal(statusOf(v.epic("PS-X")), "done");
});

// [epic-rule#4]
test("the write: an epic with no frontmatter block is an error that names an epic, not a story (failure)", () => {
  const text = epicText({ rows: [] }).replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.throws(() => applyEpicDone(text, { day: DAY }), /^Error: epic has no frontmatter block$/);
  const v = makeVault({ "PS-X": { stories: { "story-a": "done" }, text } });
  const { code, result } = runEpicRule([v.story("PS-X", "story-a"), "--write"], { at: AT });
  assert.equal(code, 1);
  assert.equal(result.epics[0].error, "epic has no frontmatter block");
  assert.equal(read(v.epic("PS-X")), text);
  assert.throws(() => setFm("# a story\n", "status", "done"), /story has no frontmatter block/);
});

// [epic-rule#6]
test("source guard: no hook and no MCP module reaches epic-rule.mjs, and stages.mjs imports nothing", async () => {
  const { VERBS } = await import("../scripts/cli.mjs");
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  // The verb table's rows count for the runner that dispatches them (tests/portability.test.mjs).
  const dispatch = (rel, src) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(src);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [
    ...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }),
    mcp,
    "scripts/doctor.mjs",
  ];
  assert.ok(
    entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"),
    entries.join(", "),
  );
  for (const entry of entries) {
    const files = closure(entry, { root: REPO, dispatch });
    assert.ok(!files.includes("scripts/epic-rule.mjs"), `${entry} reaches scripts/epic-rule.mjs`);
  }
  // Not vacuous: the entry's own closure holds it, and doctor's holds stages.mjs.
  assert.ok(closure("scripts/epic-rule.mjs", { root: REPO }).includes("scripts/stages.mjs"));
  assert.ok(closure("scripts/doctor.mjs", { root: REPO, dispatch }).includes("scripts/stages.mjs"));
  const stages = read(join(REPO, "scripts", "stages.mjs"));
  assert.deepEqual([importSpecifiers(stages), dynamicSpecifiers(stages)], [[], []]);
  assert.ok(!/^\s*import\b/m.test(stages), "stages.mjs has no import statement");
});

// ─── Contract 7: the close ceremony (verified: manual) — its prose ─────

const COPIES = [
  "commands/story.md",
  "adapters/codex/skills/projectstore-story/SKILL.md",
  "packaging/shells/projectstore-codex/skills/projectstore-story/SKILL.md",
];
const ROOT_VAR = String.raw`\$\{[A-Z_]+\}`;
const flat = (s) => s.replace(/\s+/g, " ");

// [epic-rule#7] [SPEC-001#7]
test("commands/story.md and its generated copies: the close preview runs the entry with --assume-done, shows its lines and notes, and a Yes covers them", () => {
  for (const rel of COPIES) {
    const t = read(join(REPO, rel));
    const step4 = t.slice(t.indexOf("4. **Preview**"), t.indexOf("5. **Immediately before writing**"));
    assert.ok(step4.length > 0, rel);
    assert.match(step4, new RegExp(`node "${ROOT_VAR}/scripts/epic-rule\\.mjs" "<story-path>" --assume-done\\n`), rel);
    for (const needle of [
      "On a `close` only, before the preview",
      "It writes nothing.",
      "the `line` of each epic it lists in `epics` and the `message` of each of its `notes`",
      "any epic of the vault may be listed",
      "a Yes covers them too",
      "the rule's action on the vault as it is when step 6e runs, not this snapshot",
      "A non-zero exit is shown in the preview with its `error` and does not hold the close.",
      "The plan gate does not run the rule.",
    ])
      assert.ok(flat(step4).includes(needle), `${rel}: ${needle}`);
    // The entry is run nowhere else but steps 4 and 6e.
    assert.equal((t.match(/scripts\/epic-rule\.mjs/g) || []).length, 2, rel);
  }
});

// [epic-rule#7] [SPEC-001#7]
test("commands/story.md and its generated copies: step 6e runs --write in the main thread on both paths, then reconcile and doctor whenever moved is not empty, and names the moved epics", () => {
  for (const rel of COPIES) {
    const t = read(join(REPO, rel));
    // 6d, then the rule, then the commit hint last: the epics it moves belong in that commit.
    const [d, e, f, ready] = ["\n6d. ", "\n6e. ", "\n6f. ", "# Ready flow"].map((h) => t.indexOf(h));
    assert.ok(d > 0 && d < e && e < f && f < ready, rel);
    assert.match(t.slice(f, ready), /^\n6f\. \*\*\(close only\) The commit hint\.\*\*/, rel);
    assert.ok(flat(t.slice(f, ready)).includes("the epics step 6e moved"), rel);
    assert.ok(!/\n6[g-z]\. /.test(t), `${rel}: the commit hint is the last step`);
    const e6 = t.slice(e, f);
    assert.match(e6, new RegExp(`node "${ROOT_VAR}/scripts/epic-rule\\.mjs" "<story-path>" --write\\n`), rel);
    // Every derived view: a bare --write refuses without a terminal, so the four targets are named.
    assert.match(
      e6,
      new RegExp(
        `node "${ROOT_VAR}/bin/projectstore\\.mjs" reconcile --write --only kanban,codemap,graph,indexes --project "[^"]+"\\n`,
      ),
      rel,
    );
    assert.match(e6, new RegExp(`node "${ROOT_VAR}/bin/projectstore\\.mjs" doctor --vault --project "[^"]+"\\n`), rel);
    for (const needle of [
      "(close only, both paths)",
      "in the main thread",
      "after 6d, on the clerk's path and on the undelegated one alike",
      "the clerk never runs it",
      "Whenever its `moved` is not empty, whatever the exit",
      "name the moved epics to the user, since they may differ from the preview's",
      "it never undoes the close",
      "It never moves an epic back",
    ])
      assert.ok(flat(e6).includes(needle), `${rel}: ${needle}`);
    // Both paths reach 6e: the clerk's clean report and the undelegated one.
    assert.match(flat(t), /skip steps 6-6b and run step 6c, then step 6d, then step 6e/, rel);
    assert.match(flat(t), /perform steps 6-6c yourself, then 6d, then 6e/, rel);
  }
});

// ─── Contract 8: doctor's epic-status ──────────────────────────────────

const artifacts = (epicStatus, statuses) => [
  { kind: "epic", rel: "epics/PS-X/epic.md", fm: { status: epicStatus }, body: "" },
  ...statuses.map((status, i) => ({
    kind: "story",
    rel: `epics/PS-X/stories/story-${i}.md`,
    fm: status === undefined ? {} : { status },
    body: "",
  })),
];
const epicStatusFindings = (list) => checkStoriesAndEpics(list).filter((f) => f.check === "epic-status");

// [epic-rule#8]
test("doctor: a done epic with stories done, superseded, deferred and parked has no epic-status finding", () => {
  assert.deepEqual(epicStatusFindings(artifacts("done", ["done", "superseded", "deferred", "parked"])), []);
});

// [epic-rule#8]
test("doctor: a done epic with a closed story has no epic-status finding (edge)", () => {
  assert.deepEqual(epicStatusFindings(artifacts("done", ["closed", "Done"])), []);
});

// [epic-rule#8]
test("doctor: a done epic with one planned and one in_progress story has one epic-status finding, its message unchanged (edge)", () => {
  const f = epicStatusFindings(artifacts("done", ["planned", "in_progress", "superseded"]));
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "issue");
  assert.equal(f[0].message, 'Epic is "done" while 2 child stories are not.');
  assert.equal(
    epicStatusFindings(artifacts("done", [undefined]))[0].message,
    'Epic is "done" while 1 child story is not.',
  );
});

// ─── The story's independent test ──────────────────────────────────────

const bin = (proj, args) =>
  spawnSync(process.execPath, [join(REPO, "bin", "projectstore.mjs"), ...args, "--project", proj], {
    encoding: "utf8",
    timeout: 60000,
    cwd: proj,
    env: { ...process.env, CI: "1" },
  });

// [epic-rule#6] [epic-rule#8] [SPEC-001#7]
test("independent test: the close gate closes the last story; the preview lists the epic, the write makes it done, and doctor reports no epic-status and no index finding", () => {
  const { proj, vault } = makeVaultProject();
  const dir = join(vault, "epics", "PS-X");
  const stories = { "story-a": "done", "story-b": "superseded", "story-c": "review" };
  for (const [id, status] of Object.entries(stories))
    writeFileSync(join(dir, "stories", `${id}.md`), storyText({ id, epic: "PS-X", status }));
  const epic = join(dir, "epic.md");
  writeFileSync(epic, epicText({ rows: linkRows(stories) }));
  const last = join(dir, "stories", "story-c.md");
  const storyBefore = read(last);
  // The gate is pure: it computes the close and writes no file.
  const gate = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), "close", last], {
    encoding: "utf8",
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(read(last), storyBefore, "story-section.mjs close writes no file");
  const { content } = JSON.parse(gate.stdout);
  assert.equal(parseFrontmatter(content).data.status, "done");
  // Step 4: the preview.
  const epicBefore = read(epic);
  const plan = cli([last, "--assume-done"]);
  assert.equal(plan.code, 0, plan.err);
  assert.deepEqual(
    plan.json.epics.map((e) => [e.epic, e.to]),
    [["PS-X", "done"]],
  );
  assert.equal(read(epic), epicBefore);
  // Step 6 and 6d: the story, then its epic row.
  writeFileSync(last, content);
  assert.equal(syncEpicRow(last).error, null);
  // Step 6e, then the bare reconcile and doctor.
  const write = cli([last, "--write"]);
  assert.equal(write.code, 0, write.err);
  assert.deepEqual(write.json.moved, ["PS-X"]);
  assert.equal(statusOf(epic), "done");
  assert.match(read(epic), /\| \[story-c\]\(\.\/stories\/story-c\.md\) \| done \|/);
  const rec = bin(proj, ["reconcile", "--write", "--only", "kanban,codemap,graph,indexes"]);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  const doc = bin(proj, ["doctor", "--vault", "--json"]);
  const findings = JSON.parse(doc.stdout).result;
  assert.deepEqual(
    findings.filter((f) => f.check === "epic-status" || (f.check === "index" && f.level !== "info")),
    [],
    JSON.stringify(findings.filter((f) => f.level !== "info")),
  );
  // A second run on the same state writes nothing.
  const again = cli([last, "--write"]);
  assert.deepEqual([again.code, again.json.moved, again.json.epics], [0, [], []]);
  assert.ok(existsSync(join(vault, "kanban.md")), "the reconcile wrote the board");
});

// [follow#9]
test("the sweep: assume takes a list, as follow's plan passes the stories it closes; a list is for a plan only (edge)", () => {
  const v = makeVault({ "PS-X": { stories: { "story-a": "review", "story-b": "in-progress" } } });
  const before = read(v.epic("PS-X"));
  const epicsDir = dirname(dirname(v.epic("PS-X")));
  const one = applyEpicRule({ epicsDir, assume: [v.story("PS-X", "story-a")] });
  assert.deepEqual(one.epics, [], "one of two open stories assumed done: the epic stays, unlisted");
  const both = applyEpicRule({ epicsDir, assume: [v.story("PS-X", "story-a"), v.story("PS-X", "story-b")] });
  assert.deepEqual(
    both.epics.map((e) => [e.epic, e.to]),
    [["PS-X", "done"]],
  );
  assert.deepEqual(applyEpicRule({ epicsDir, assume: [] }).epics, [], "an empty list assumes nothing");
  assert.throws(() => applyEpicRule({ epicsDir, write: true, assume: [v.story("PS-X", "story-a")] }), /plan only/);
  assert.equal(read(v.epic("PS-X")), before);
});

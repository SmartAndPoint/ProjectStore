// projectstore — tests/flow-view.test.mjs: flow.md, the flow page beside the
// kanban (PS-FLOW, "A derived flow.md beside the kanban shows WIP, age in
// status, throughput and the cumulative flow"; the spec "The flow page: dated
// by the vault, with WIP, the date in status, weekly throughput and the
// cumulative flow", alias `flow-view`). Fixture vaults are written through the
// writers (tests/fixtures/flow.mjs), reconcile runs in process through
// runReconcile, and doctor through runVaultChecks with its clock at the
// page's as-of instant. The chart's drawing in Obsidian and contract 12's
// gates are checked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flowVault, storyText, closedStory, doctorRun, byCheck, ADDRESS, NOW, NOW_MS, DAY } from "./fixtures/flow.mjs";
import { buildFlowView, flowModel, renderFlowView, asOfOf, checkFlowView } from "../scripts/flow-view.mjs";
import { runReconcile } from "../scripts/reconcile.mjs";
import { runStartupChecks } from "../scripts/doctor.mjs";
import { storyFacts, windowOf, windowCounts, wipByPerson, columnPath } from "../scripts/flow-counts.mjs";
import { AWAITING_REASON, setFm } from "../scripts/status-log.mjs";
import { loadLayout, parseFrontmatter } from "../scripts/lib.mjs";
import { childEnv } from "../scripts/harness.mjs";
import { status as viewStatus, search } from "../scripts/query.mjs";
import { run } from "../scripts/cli.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LAYOUT = loadLayout("engineering");
const COLUMNS = LAYOUT.kanban.columns;

// ─── Helpers ───────────────────────────────────────────────────────────

const page = (fx, opts) => buildFlowView(fx.cfg, LAYOUT, opts).content;
const reconcile = (fx, { write = true, only = "flow" } = {}) => runReconcile({ write, only, projectDir: fx.proj });
const flowFile = (fx) => join(fx.vault, "flow.md");
const readFlow = (fx) => readFileSync(flowFile(fx), "utf8");
const dropGenerated = (s) =>
  s
    .split("\n")
    .filter((l) => !l.startsWith("generated_at:"))
    .join("\n");
// The body of `## <name>`, up to the next `## ` heading.
function section(content, name) {
  const lines = content.split("\n");
  const at = lines.indexOf(`## ${name}`);
  if (at === -1) return null;
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end === -1 ? lines.length : end).join("\n");
}
// A section's table rows, header and separator left out, as cell lists.
function rows(text) {
  return (text || "")
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2)
    .map((l) =>
      l
        .slice(2, -2)
        .split(/(?<!\\) \| /)
        .map((c) => c.trim()),
    );
}
const asOfLine = (content) => content.split("\n").find((l) => l.startsWith("as_of:"));
const at = (day, time = "10:00:00.000Z") => `${day}T${time}`;
// A story moved through the writers; `moves` are [to, iso] pairs.
const moved = (id, { created = "2026-09-01", assignee = "", moves = [], fm = {}, epic = "PS-X" } = {}) =>
  storyText({ id, epic, created, assignee, log: moves.map(([to, when]) => ({ to, at: when })), fm });
// A story the as-of instant is read from: created that day, one move at `iso`.
const anchor = (iso, id = "story-anchor") => ({
  [`PS-Z/${id}`]: moved(id, { created: iso.slice(0, 10), moves: [["todo", iso]] }),
});
const done = (id, created, closed) =>
  moved(id, { created, moves: [["done", closed]], fm: { closed_at: JSON.stringify(closed) } });
const noDates = (text) => text.replace(/^created: .*\n/m, "").replace(/^updated: .*\n/m, "");
const factsOf = (fx) => {
  const out = [];
  for (const [ref, text] of Object.entries(fx.stories)) {
    const [epic, slug] = ref.split("/");
    out.push(
      storyFacts({ rel: `epics/${epic}/stories/${slug}.md`, epic, slug, text, fm: parseFrontmatter(text).data }),
    );
  }
  return out;
};
const vault = (opts) => {
  const fx = flowVault(opts);
  fx.stories = opts.stories || {};
  return fx;
};
// The chart's block, parsed.
function chart(content) {
  const m = content.match(/```mermaid\n([\s\S]*?)\n```/);
  if (!m) return null;
  const lines = m[1].split("\n").map((l) => l.trim());
  const cats = JSON.parse(lines.find((l) => l.startsWith("x-axis ")).slice("x-axis ".length));
  const series = lines.filter((l) => l.startsWith("line ")).map((l) => JSON.parse(l.slice("line ".length)));
  return { header: lines[0], cats, series, lines };
}

// ─── Contract 1: the as-of instant ─────────────────────────────────────

// [flow-view#1]
test("as of: a newest status_changed_at of 2026-11-11T09:30:00Z dates the page; two builds with the clock unreadable give equal contents once generated_at is dropped", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-a": moved("story-a", { created: "2026-10-01", moves: [["todo", "2026-11-11T09:30:00Z"]] }),
      "PS-X/story-b": moved("story-b", { created: "2026-10-02", moves: [["in-progress", at("2026-10-20")]] }),
    },
  });
  const RealDate = globalThis.Date;
  class NoClock extends RealDate {
    constructor(...a) {
      if (!a.length) throw new Error("the clock was read");
      super(...a);
    }
    static now() {
      throw new Error("the clock was read");
    }
  }
  let first;
  let second;
  globalThis.Date = NoClock;
  try {
    first = page(fx, { generatedAt: "2026-11-19T09:00:00.000Z" });
    second = page(fx, { generatedAt: "2026-11-21T09:00:00.000Z" });
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(asOfLine(first), "as_of: 2026-11-11");
  assert.equal(asOfLine(second), "as_of: 2026-11-11");
  assert.notEqual(first, second, "the generated_at lines differ");
  assert.equal(dropGenerated(first), dropGenerated(second));
  assert.match(first.split("\n# Flow\n\n")[1], /^This page shows the flow of the vault's stories as of 2026-11-11/);
});

// [flow-view#1]
test("as of: a parked story's updated a year after every other stamp dates the page, and an updated that reads soon is ignored (edge)", () => {
  const parked = setFm(
    moved("story-parked", { created: "2026-01-01", moves: [["parked", at("2026-02-01")]] }),
    "updated",
    "2027-03-01",
  );
  const soon = setFm(moved("story-soon", { created: "2026-01-02" }), "updated", "soon");
  const fx = vault({ stories: { "PS-X/story-parked": parked, "PS-X/story-soon": soon } });
  assert.equal(asOfLine(page(fx)), "as_of: 2027-03-01");
  assert.equal(asOfOf(factsOf(fx)), Date.parse("2027-03-01T00:00:00Z"));
});

// [flow-view#1]
test("as of: a vault with no story, and one whose stories carry no stamp that reads, give as_of null, say no story carries a date yet, have no table, and exit 0 (edge)", () => {
  const empty = vault({});
  const undated = vault({
    stories: {
      "PS-X/story-a": noDates(storyText({ id: "story-a" })).replace(/^status: .*$/m, "status: in-progress"),
      "PS-X/story-b": setFm(noDates(storyText({ id: "story-b" })), "created", "soon"),
    },
  });
  for (const fx of [empty, undated]) {
    const r = reconcile(fx);
    assert.equal(r.summary.failed, 0, JSON.stringify(r.flow));
    assert.equal(r.flow.written, true);
    const content = readFlow(fx);
    assert.equal(asOfLine(content), "as_of: null");
    assert.match(content, /No story in this vault carries a date yet/);
    assert.ok(!content.includes("\n|"), "no table");
    assert.ok(!content.includes("\n## "), "no section");
  }
});

// ─── Contract 2: the page's shape ──────────────────────────────────────

const oneInEach = () => ({
  "PS-X/story-backlog": moved("story-backlog", { created: "2026-10-20" }),
  "PS-X/story-todo": moved("story-todo", { created: "2026-10-21", moves: [["todo", at("2026-10-27")]] }),
  "PS-X/story-doing": moved("story-doing", {
    created: "2026-10-22",
    assignee: "First Last",
    moves: [["in-progress", at("2026-10-28")]],
  }),
  "PS-X/story-review": moved("story-review", {
    created: "2026-10-23",
    assignee: "First Last",
    moves: [
      ["in-progress", at("2026-10-28")],
      ["review", at("2026-11-04")],
    ],
  }),
  "PS-X/story-done": moved("story-done", {
    created: "2026-10-24",
    moves: [["done", at("2026-11-05")]],
    fm: { closed_at: JSON.stringify(at("2026-11-05")) },
  }),
  ...anchor(at("2026-11-11", "12:00:00.000Z")),
});

// [flow-view#2]
test("shape: --only flow writes flow.md with projectstore: derived, generated_at and as_of, the five sections in order, and no harness command form", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const r = reconcile(fx);
  assert.equal(r.flow.written, true);
  const content = readFlow(fx);
  const fm = parseFrontmatter(content).data;
  assert.equal(fm.projectstore, "derived");
  assert.match(String(fm.generated_at), /^\d{4}-\d\d-\d\dT/);
  assert.equal(String(fm.as_of), "2026-11-11");
  const heads = content.split("\n").filter((l) => /^#{1,2} /.test(l));
  assert.deepEqual(heads, [
    "# Flow",
    "## WIP",
    "## In status since",
    "## Epics without movement",
    "## Throughput",
    "## Cumulative flow",
  ]);
  assert.doesNotMatch(content, /\/projectstore:|\$projectstore-/);
  assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"), "one trailing newline");
  assert.ok(!content.includes("\r"));
});

// [flow-view#2]
test("shape: the generator under Pacific/Kiritimati and under America/Los_Angeles gives equal contents once generated_at is dropped (edge)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const gen = (TZ) => {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "flow-view.mjs")], {
      cwd: fx.proj,
      env: childEnv({ ...process.env, TZ }, { projectRoot: fx.proj }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.path, flowFile(fx));
    return out.content;
  };
  const east = gen("Pacific/Kiritimati");
  const west = gen("America/Los_Angeles");
  assert.equal(dropGenerated(east), dropGenerated(west));
  assert.equal(asOfLine(east), "as_of: 2026-11-11");
});

// [flow-view#2]
test("shape: a title with | and ]] links safely, an assignee x|y is escaped, and an email-shaped name is never printed (edge)", () => {
  const titled = setFm(
    moved("story-pipe", { created: "2026-10-01", moves: [["todo", at("2026-10-05")]] }),
    "title",
    JSON.stringify("A | B ]] C"),
  );
  const fx = vault({
    stories: {
      "PS-X/story-pipe": titled,
      "PS-X/story-xy": moved("story-xy", {
        created: "2026-10-01",
        assignee: "x|y",
        moves: [["todo", at("2026-10-06")]],
      }),
      "PS-X/story-mail": moved("story-mail", {
        created: "2026-10-01",
        assignee: `First ${ADDRESS}`,
        moves: [["in-progress", at("2026-10-07")]],
      }),
    },
  });
  const content = page(fx);
  assert.ok(content.includes("[[epics/PS-X/stories/story-pipe\\|PS-X: A \\| B )) C]]"), content);
  const open = rows(section(content, "In status since"));
  assert.equal(open.find((r) => r[0].includes("story-xy"))[2], "x\\|y");
  assert.equal(open.find((r) => r[0].includes("story-mail"))[2], "an email-shaped name");
  assert.equal(rows(section(content, "WIP"))[0][0], "an email-shaped name");
  assert.ok(!content.includes(ADDRESS), "the address is printed nowhere");
});

// ─── Contract 3: WIP per person ────────────────────────────────────────

// [flow-view#3]
test("WIP: A with wip 2 holds three In Progress stories and one awaiting close; the row reads 3, 1 and 2, and doctor at the as-of instant names A with 3 over 2", () => {
  const ip = (id, day) => moved(id, { created: "2026-10-01", assignee: "A", moves: [["in-progress", at(day)]] });
  const awaiting = storyText({
    id: "story-w",
    created: "2026-10-01",
    assignee: "A",
    log: [
      { to: "in-progress", at: at("2026-10-05") },
      {
        to: "review",
        at: at("2026-11-10"),
        reason: `${AWAITING_REASON}: https://example.invalid/pr/1`,
        actor: "follow",
      },
    ],
  });
  const fx = vault({
    vaultCfg: { flow: { people: { A: { wip: 2 } } } },
    stories: {
      "PS-X/story-1": ip("story-1", "2026-10-06"),
      "PS-X/story-2": ip("story-2", "2026-10-07"),
      "PS-X/story-3": ip("story-3", "2026-10-08"),
      "PS-X/story-w": awaiting,
    },
  });
  const content = page(fx);
  assert.deepEqual(rows(section(content, "WIP")), [["A", "3", "1", "2"]]);
  const asOf = new Date(asOfOf(factsOf(fx))).toISOString();
  assert.equal(asOf, at("2026-11-10"));
  const over = byCheck(doctorRun(fx, { now: asOf }), "wip-over-limit");
  assert.equal(over.length, 1);
  assert.match(over[0].message, /^A holds 3 stories in progress or review, over their WIP limit of 2/);
});

// [flow-view#3]
test("WIP: B with one Review story and no flow.people entry has an empty limit cell; with no one in In Progress or Review the section is one sentence (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { people: { A: { wip: 2 } } } },
    stories: { "PS-X/story-b": moved("story-b", { assignee: "B", moves: [["review", at("2026-10-05")]] }) },
  });
  assert.deepEqual(rows(section(page(fx), "WIP")), [["B", "1", "0", ""]]);
  const idle = vault({
    stories: { "PS-X/story-t": moved("story-t", { assignee: "B", moves: [["todo", at("2026-10-05")]] }) },
  });
  const wip = section(page(idle), "WIP").trim();
  assert.equal(wip, "No one holds a story in In Progress or Review.");
});

// [flow-view#3]
test("WIP: constructor and __proto__ each have a row, and A comes before B at two each (edge)", () => {
  const held = (id, who) => moved(id, { assignee: who, moves: [["in-progress", at("2026-10-05")]] });
  const fx = vault({
    stories: {
      "PS-X/story-c": held("story-c", "constructor"),
      "PS-X/story-p": held("story-p", "__proto__"),
      "PS-X/story-b1": held("story-b1", "B"),
      "PS-X/story-b2": held("story-b2", "B"),
      "PS-X/story-a1": held("story-a1", "A"),
      "PS-X/story-a2": held("story-a2", "A"),
    },
  });
  const names = rows(section(page(fx), "WIP")).map((r) => r[0]);
  assert.deepEqual(names, ["A", "B", "__proto__", "constructor"]);
  assert.equal(wipByPerson(factsOf(fx)).size, 4);
});

// ─── Contract 4: open stories and the date they entered their status ───

// [flow-view#4]
test("in status since: In Progress since 2026-10-20, ToDo since 2026-11-02 and an undated ToDo story come in that order, reading 2026-10-20, 2026-11-02 and no date", () => {
  const undated = noDates(storyText({ id: "story-c" })).replace(/^status: .*$/m, "status: todo");
  const fx = vault({
    stories: {
      "PS-X/story-c": undated,
      "PS-X/story-b": moved("story-b", { moves: [["todo", at("2026-11-02")]] }),
      "PS-X/story-a": moved("story-a", { moves: [["in-progress", at("2026-10-20")]] }),
    },
  });
  const open = rows(section(page(fx), "In status since"));
  assert.deepEqual(
    open.map((r) => [r[0].match(/story-\w/)[0], r[1], r[3]]),
    [
      ["story-a", "in-progress", "2026-10-20"],
      ["story-b", "todo", "2026-11-02"],
      ["story-c", "todo", "no date"],
    ],
  );
  assert.doesNotMatch(section(page(fx), "In status since"), /\bdays?\b/, "no day count");
});

// [flow-view#4]
test("in status since: a Review story whose status was edited by hand reads its updated date, marked (from updated) (edge)", () => {
  const hand = setFm(
    setFm(moved("story-r", { moves: [["in-progress", at("2026-10-01")]] }), "status", "review"),
    "updated",
    "2026-11-05",
  );
  const fx = vault({ stories: { "PS-X/story-r": hand } });
  assert.equal(rows(section(page(fx), "In status since"))[0][3], "2026-11-05 (from updated)");
});

// [flow-view#4]
test("in status since: a trusted Review story whose last line reads merged, awaiting evidence has the status review (awaiting close) (edge)", () => {
  const t = storyText({
    id: "story-w",
    assignee: "A",
    log: [
      { to: "in-progress", at: at("2026-10-05") },
      { to: "review", at: at("2026-11-02"), reason: AWAITING_REASON, actor: "follow" },
    ],
  });
  const fx = vault({ stories: { "PS-X/story-w": t } });
  assert.equal(rows(section(page(fx), "In status since"))[0][1], "review (awaiting close)");
});

// [flow-view#4]
test("in status since: seven planned stories, one whose status is soon, and a parked one have no row, and the Backlog line says 8 (edge)", () => {
  const stories = {};
  for (let i = 1; i <= 7; i++) stories[`PS-X/story-p${i}`] = moved(`story-p${i}`);
  stories["PS-X/story-soon"] = setFm(moved("story-soon"), "status", "soon");
  stories["PS-X/story-parked"] = moved("story-parked", { moves: [["parked", at("2026-10-01")]] });
  const fx = vault({ stories });
  const s = section(page(fx), "In status since");
  assert.deepEqual(rows(s), []);
  assert.match(s, /No story is in ToDo, In Progress or Review\./);
  assert.match(s, /The Backlog holds 8 stories, not listed here\./);
});

// ─── Contract 5: throughput per week ───────────────────────────────────

const throughputVault = () =>
  vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-1": done("story-1", "2026-10-26", at("2026-10-29")),
      "PS-X/story-2": done("story-2", "2026-10-27", at("2026-10-30")),
      "PS-X/story-3": done("story-3", "2026-10-28", at("2026-11-04")),
      "PS-X/story-4": moved("story-4", { created: "2026-11-03", moves: [["in-progress", NOW]] }),
    },
  });

// [flow-view#5]
test("throughput: W of 2 at 2026-11-11T12:00Z reads 2026-10-26 3 2 and 2026-11-02 1 1, totals 4 and 3, as doctor's intake-over-close", () => {
  const fx = throughputVault();
  const content = page(fx);
  assert.equal(asOfLine(content), "as_of: 2026-11-11");
  assert.deepEqual(rows(section(content, "Throughput")), [
    ["2026-10-26", "3", "2"],
    ["2026-11-02", "1", "1"],
    ["Total", "4", "3"],
  ]);
  const w = windowCounts(factsOf(fx), windowOf(NOW_MS, 2));
  assert.deepEqual([w.created.length, w.closed.length], [4, 3]);
  const intake = byCheck(doctorRun(fx, { now: NOW }), "intake-over-close");
  assert.equal(intake.length, 1);
  assert.match(intake[0].message, /4 stories were created and 3 closed/);
});

// [flow-view#5]
test("throughput: a close at 2026-11-08T23:59:59.999Z is in the week of 2026-11-02, and one at 2026-11-09T00:00:00.000Z is in no row (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-in": done("story-in", "2026-10-26", "2026-11-08T23:59:59.999Z"),
      "PS-X/story-out": done("story-out", "2026-10-26", "2026-11-09T00:00:00.000Z"),
      ...anchor(NOW),
    },
  });
  assert.deepEqual(rows(section(page(fx), "Throughput")), [
    ["2026-10-26", "2", "0"],
    ["2026-11-02", "0", "1"],
    ["Total", "2", "1"],
  ]);
});

// [flow-view#5]
test("throughput: W of 1000000 on a vault whose earliest date is 2026-10-01 starts at the week of 2026-09-28, says the vault is younger than the window, and ends within the generator's timeout (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 1000000 } },
    stories: { "PS-X/story-a": done("story-a", "2026-10-01", at("2026-10-14")), ...anchor(NOW) },
  });
  const started = Date.now();
  const r = reconcile(fx);
  assert.ok(Date.now() - started < 10000, "within the generator's 10 s timeout");
  assert.equal(r.summary.failed, 0, JSON.stringify(r.flow));
  const s = section(readFlow(fx), "Throughput");
  assert.equal(rows(s)[0][0], "2026-09-28");
  assert.equal(rows(s).length, 6 + 1, "the weeks from 2026-09-28 to 2026-11-02, and the totals");
  assert.match(s, /The vault is younger than the window/);
});

// [flow-view#5]
test("throughput: W of 200 with a story created and closed in each week shows the last 104 weeks, says 96 earlier weeks are hidden, and its totals equal windowCounts over the 200 (edge)", () => {
  const asOf = Date.parse("2026-11-11T12:00:00Z");
  const win = windowOf(asOf, 200);
  const stories = {};
  for (let k = 0; k < 200; k++) {
    const monday = new Date(win.from + k * 7 * DAY).toISOString().slice(0, 10);
    const close = new Date(win.from + k * 7 * DAY + 2 * DAY).toISOString();
    stories[`PS-X/story-w${k}`] = done(`story-w${k}`, monday, close);
  }
  Object.assign(stories, anchor("2026-11-11T12:00:00.000Z"));
  const fx = { stories };
  const facts = factsOf(fx);
  const m = flowModel(facts, { flow: { window_weeks: 200 } }, { columns: COLUMNS });
  assert.equal(m.window.weeks.length, 104);
  assert.equal(m.window.hidden, 96);
  const counts = windowCounts(facts, win);
  assert.deepEqual([m.window.created, m.window.closed], [counts.created.length, counts.closed.length]);
  assert.deepEqual([m.window.created, m.window.closed], [200, 200]);
  const fxv = vault({ vaultCfg: { flow: { window_weeks: 200 } }, stories });
  const s = section(page(fxv), "Throughput");
  assert.match(s, /96 earlier weeks are hidden; the totals cover them\./);
  assert.equal(rows(s).length, 105);
  assert.deepEqual(rows(s).at(-1), ["Total", "200", "200"]);
});

// [flow-view#5]
test("throughput: a Done story with no closed_at and its updated in the window is in no week, and the line under the table says 1 (edge)", () => {
  const unstamped = setFm(
    setFm(moved("story-u", { created: "2026-10-26" }), "status", "done"),
    "updated",
    "2026-10-28",
  );
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: { "PS-X/story-u": unstamped, ...anchor(NOW) } });
  const s = section(page(fx), "Throughput");
  assert.deepEqual(
    rows(s).map((r) => r[2]),
    ["0", "0", "0"],
  );
  assert.match(s, /1 Done story has no readable `closed_at`, so no week counts the close\./);
});

// [flow-view#5]
test("throughput: with no policy block, and with flow.window_weeks of 0, the page has WIP and In status since, no Throughput, no Cumulative flow, no chart, and names the configure --set form (edge)", () => {
  for (const vaultCfg of [null, { flow: { window_weeks: 0 } }]) {
    const fx = vault({ vaultCfg, stories: oneInEach() });
    const content = page(fx);
    assert.ok(section(content, "WIP") !== null && section(content, "In status since") !== null);
    assert.equal(section(content, "Throughput"), null);
    assert.equal(section(content, "Cumulative flow"), null);
    assert.equal(chart(content), null);
    const why = vaultCfg ? "is not a whole number of weeks above 0" : "is not set";
    assert.ok(
      content.includes(
        `(\`flow.window_weeks\`) ${why}; set it with:\n\n\`\`\`\nnpx projectstore configure --set flow.window_weeks=<weeks>\n\`\`\``,
      ),
      content,
    );
  }
});

// ─── Contract 6: the cumulative flow ───────────────────────────────────

const cumulative = (content) => {
  const r = rows(section(content, "Cumulative flow"));
  return r.map((cells) => ({
    label: cells[0],
    counts: Object.fromEntries(COLUMNS.map((c, i) => [c, Number(cells[i + 1])])),
  }));
};

// [flow-view#6]
test("cumulative flow: a story moved planned → todo → in-progress → review → done, one move a week, is in ToDo, In Progress, Review and Done in those weeks' rows", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 4 } },
    stories: {
      "PS-X/story-a": moved("story-a", {
        created: "2026-10-12",
        moves: [
          ["todo", at("2026-10-13")],
          ["in-progress", at("2026-10-20")],
          ["review", at("2026-10-27")],
          ["done", at("2026-11-03")],
        ],
        fm: { closed_at: JSON.stringify(at("2026-11-03")) },
      }),
      ...anchor(NOW),
    },
  });
  const r = cumulative(page(fx));
  assert.deepEqual(
    r.slice(0, 4).map((row) => row.label),
    ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"],
  );
  // story-a alone outside ToDo; the anchor is in ToDo from 2026-11-11 only.
  assert.deepEqual(
    r.slice(0, 4).map((row) => COLUMNS.find((c) => row.counts[c] === 1)),
    ["ToDo", "In Progress", "Review", "Done"],
  );
  assert.equal(columnPath(factsOf(fx).find((f) => f.slug === "story-a")).exact, true);
  assert.ok(!columnPath(factsOf(fx).find((f) => f.slug === "story-a")).steps.some((s) => s.at === null));
});

// [flow-view#6]
test("cumulative flow: after reconcile --only kanban,flow the last row equals the cards under each column heading of kanban.md", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const r = reconcile(fx, { only: "kanban,flow" });
  assert.equal(r.summary.failed, 0);
  const board = readFileSync(join(fx.vault, "kanban.md"), "utf8");
  const cards = {};
  let col = null;
  for (const l of board.split("\n")) {
    if (l.startsWith("## ")) col = l.slice(3);
    else if (col && /^- \[[ x]\] \[\[/.test(l)) cards[col] = (cards[col] || 0) + 1;
  }
  const last = cumulative(readFlow(fx)).at(-1);
  assert.equal(last.label, "as of 2026-11-11");
  for (const c of COLUMNS) assert.equal(last.counts[c], cards[c] || 0, c);
  assert.equal(last.counts.ToDo, 2, "the ToDo story and the anchor");
});

// [flow-view#6]
test('cumulative flow: a story whose status is " done " is under Done on kanban.md and in the last row (edge)', () => {
  const spaced = setFm(moved("story-s", { created: "2026-10-26" }), "status", JSON.stringify(" done "));
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: { "PS-X/story-s": spaced, ...anchor(NOW) } });
  reconcile(fx, { only: "kanban,flow" });
  const board = readFileSync(join(fx.vault, "kanban.md"), "utf8");
  const doneCol = board.split("## Done")[1];
  assert.ok(doneCol.includes("story-s"), board);
  assert.equal(cumulative(readFlow(fx)).at(-1).counts.Done, 1);
});

// [flow-view#6]
test("cumulative flow: of a story moved through the writers, one with no Status log but started_at and closed_at, and one edited by hand after its last line, the sentence says 2 of 3 are placed from their dates (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-w": moved("story-w", { created: "2026-10-26", moves: [["in-progress", NOW]] }),
      "PS-X/story-n": setFm(
        moved("story-n", {
          created: "2026-10-26",
          fm: { started_at: JSON.stringify(at("2026-10-27")), closed_at: JSON.stringify(at("2026-11-03")) },
        }),
        "status",
        "done",
      ),
      "PS-X/story-h": setFm(
        moved("story-h", { created: "2026-10-26", moves: [["todo", at("2026-10-27")]] }),
        "status",
        "review",
      ),
    },
  });
  assert.match(
    section(page(fx), "Cumulative flow"),
    /\n2 of 3 stories are placed from their dates \(`created`, `started_at`, `closed_at`\), not from a Status log/,
  );
});

// [flow-view#6]
test("cumulative flow: a story with a Status log that is parked today is in no row (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-p": moved("story-p", {
        created: "2026-10-26",
        moves: [
          ["todo", at("2026-10-27")],
          ["parked", at("2026-11-03")],
        ],
      }),
      ...anchor(NOW),
    },
  });
  for (const row of cumulative(page(fx)))
    assert.equal(
      COLUMNS.reduce((s, c) => s + row.counts[c], 0),
      row.label.startsWith("as of") ? 1 : 0,
      `${row.label}: only the anchor, and only now`,
    );
});

// ─── Contract 7: the chart ─────────────────────────────────────────────

// [flow-view#7]
test("chart: an xychart-beta block follows the table, its categories are the row labels in quotes, and its five unnamed lines are the running sums of each row, Done first", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const content = page(fx);
  const s = section(content, "Cumulative flow");
  const c = chart(s);
  assert.equal(c.header, "xychart-beta");
  const table = cumulative(content);
  assert.deepEqual(
    c.cats,
    table.map((r) => r.label),
  );
  assert.ok(c.lines.find((l) => l.startsWith("x-axis ")).includes(`"${table[0].label}"`), "quoted labels");
  assert.equal(c.series.length, 5);
  assert.ok(
    c.lines.filter((l) => l.startsWith("line ")).every((l) => /^line \[/.test(l)),
    "no series name",
  );
  const rev = [...COLUMNS].reverse();
  for (let r = 0; r < table.length; r++)
    for (let j = 0; j < 5; j++)
      assert.equal(
        c.series[j][r],
        rev.slice(0, j + 1).reduce((sum, col) => sum + table[r].counts[col], 0),
        `row ${r} series ${j}`,
      );
  const max = Math.max(...c.series[4]);
  assert.ok(c.lines.includes(`y-axis "Stories" 0 --> ${max}`));
  assert.doesNotMatch(s, /%%\{init|theme/);
  assert.ok(s.indexOf("| as of ") < s.indexOf("```mermaid"), "the block follows the table");
  assert.match(s, /bottom to top: Done, plus Review, plus In Progress, plus ToDo, plus Backlog/);
  assert.match(s, /two lines meet where a column is empty/);
});

// [flow-view#7]
test("chart: with no Review story the first two lines are equal; with only an undated counted story there is no week row and no block (edge)", () => {
  const stories = oneInEach();
  delete stories["PS-X/story-review"];
  const c = chart(page(vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories })));
  assert.deepEqual(c.series[0], c.series[1]);
  const undated = noDates(storyText({ id: "story-u" })).replace(/^status: .*$/m, "status: todo");
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: { "PS-X/story-u": undated, "PS-Y/story-parked": moved("story-parked", { moves: [["parked", NOW]] }) },
  });
  const content = page(fx);
  assert.equal(asOfLine(content), "as_of: 2026-11-11");
  assert.deepEqual(
    rows(section(content, "Throughput")).map((r) => r[0]),
    ["Total"],
  );
  assert.equal(chart(content), null);
});

// ─── Contract 8: totality and size ─────────────────────────────────────

// [flow-view#8]
test("totality: a story file whose read throws leaves the other numbers as they were, one line says 1 story file could not be read, and the build does not fail", () => {
  const stories = oneInEach();
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories });
  const extra = moved("story-broken", {
    created: "2026-10-01",
    assignee: "Other",
    moves: [["in-progress", at("2026-10-02")]],
  });
  writeFileSync(join(fx.vault, "epics", "PS-X", "stories", "story-broken.md"), extra);
  const read = (p) => {
    if (p.endsWith("story-broken.md")) throw new Error("EIO");
    return readFileSync(p, "utf8");
  };
  const broken = page(fx, { read });
  assert.match(broken, /\n1 story file could not be read and is left out, so the counts can be low\.\n/);
  const without = page(vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories }));
  assert.equal(dropGenerated(broken).replace(/\n1 story file could not be read[^\n]*\n/, ""), dropGenerated(without));
});

// [flow-view#8]
test("totality: a story with no frontmatter and one whose last Status log line is garbled exit 0, the second placed from its dates (edge)", () => {
  const garbled = moved("story-g", { created: "2026-10-26", moves: [["todo", at("2026-10-27")]] }).replace(
    /^(- \S+ status: planned → todo — r \(move\))$/m,
    "$1\n- 2026-10-28T10:00:00.000Z status: todo → in-progress ?? garbled",
  );
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-bare": "# Just a heading\n\nNo frontmatter at all.\n",
      "PS-X/story-g": garbled,
      ...anchor(NOW),
    },
  });
  const r = reconcile(fx);
  assert.equal(r.summary.failed, 0, JSON.stringify(r.flow));
  assert.equal(r.flow.written, true);
  const g = factsOf(fx).find((f) => f.slug === "story-g");
  assert.equal(columnPath(g).exact, false);
  assert.match(section(readFlow(fx), "Cumulative flow"), /\n1 of 2 stories is placed from its dates/);
});

// [flow-view#8]
test("totality: 40 Done stories, 3 open stories held by 2 people and W of 8 give tables of 2, 3, 9 and 9 rows, none naming a Done story (edge)", () => {
  const stories = {};
  for (let i = 0; i < 40; i++) {
    const created = new Date(Date.parse("2026-06-01T00:00:00Z") + i * 3 * DAY).toISOString().slice(0, 10);
    stories[`PS-D/story-d${i}`] = done(`story-d${i}`, created, new Date(Date.parse(created) + 4 * DAY).toISOString());
  }
  stories["PS-X/story-o1"] = moved("story-o1", {
    created: "2026-09-01",
    assignee: "A",
    moves: [["in-progress", at("2026-10-01")]],
  });
  stories["PS-X/story-o2"] = moved("story-o2", {
    created: "2026-09-02",
    assignee: "A",
    moves: [["review", at("2026-10-02")]],
  });
  stories["PS-X/story-o3"] = moved("story-o3", { created: "2026-09-03", assignee: "B", moves: [["in-progress", NOW]] });
  const fx = vault({ vaultCfg: { flow: { window_weeks: 8 } }, stories });
  const content = page(fx);
  const counts = ["WIP", "In status since", "Throughput", "Cumulative flow"].map(
    (s) => rows(section(content, s)).length,
  );
  assert.deepEqual(counts, [2, 3, 9, 9]);
  assert.doesNotMatch(content, /story-d\d/);
});

// [flow-view#2]
test("shape: a title or an assignee holding a line break stays on one line, and a title ending in a backslash cannot break the link's close (edge)", () => {
  const text = moved("story-nl", {
    created: "2026-10-01",
    assignee: "Ada",
    moves: [["in-progress", at("2026-10-05")]],
  });
  const f = storyFacts({
    rel: "epics/PS-X/stories/story-nl.md",
    epic: "PS-X",
    slug: "story-nl",
    text,
    fm: { ...parseFrontmatter(text).data, title: "First line\r\n  second line \\" },
  });
  f.assignee = "Ada\nLovelace";
  const content = renderFlowView(flowModel([f], {}, { columns: COLUMNS }));
  const open = section(content, "In status since")
    .split("\n")
    .filter((l) => l.startsWith("| [["));
  assert.equal(open.length, 1);
  assert.ok(open[0].includes("[[epics/PS-X/stories/story-nl\\|PS-X: First line second line /]]"), open[0]);
  assert.ok(open[0].includes("| Ada Lovelace |"), open[0]);
  assert.deepEqual(rows(section(content, "WIP"))[0].slice(0, 2), ["Ada Lovelace", "1"]);
});

// [flow-view#8]
test("totality: a model or a render that throws gives a one-paragraph page and an error, never a throw, and doctor warns with the rebuild command", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const boom = () => {
    throw new Error("boom\nsecond line");
  };
  for (const seam of [{ model: boom }, { render: boom }]) {
    const r = buildFlowView(fx.cfg, LAYOUT, { ...seam, generatedAt: "2026-11-19T00:00:00.000Z" });
    assert.equal(r.error, "boom second line");
    assert.equal(asOfLine(r.content), "as_of: null");
    assert.match(r.content, /^This page could not be built from the vault \(boom second line\)\./m);
    assert.ok(r.content.includes("```\nnpx projectstore reconcile --write --only flow\n```"));
    assert.equal(r.stats.unread, 0);
  }
});

// ─── Contract 9: created on request, then kept fresh by reconcile ──────

// [flow-view#9]
test("reconcile: --write --only flow creates flow.md with written true; run again it reports written false, summary.written 0, and the bytes are unchanged", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  assert.ok(!existsSync(flowFile(fx)));
  const first = reconcile(fx);
  assert.equal(first.flow.written, true);
  assert.equal(first.flow.path, flowFile(fx));
  const bytes = readFlow(fx);
  const second = reconcile(fx);
  assert.equal(second.flow.written, false);
  assert.equal(second.flow.changed, false);
  assert.equal(second.summary.written, 0);
  assert.equal(readFlow(fx), bytes);
});

// [flow-view#9]
test("reconcile: a bare --write leaves an absent flow.md absent and says it does not exist yet; it rewrites an existing one, listing a story moved to review (edge)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const bare = reconcile(fx, { only: null });
  assert.equal(bare.flow.skipped, "flow.md does not exist yet — create it explicitly (--only flow)");
  assert.equal(bare.flow.written, false);
  assert.ok(!existsSync(flowFile(fx)));
  reconcile(fx);
  const p = join(fx.vault, "epics", "PS-X", "stories", "story-todo.md");
  writeFileSync(
    p,
    storyText({
      id: "story-todo",
      created: "2026-10-21",
      log: [
        { to: "todo", at: at("2026-10-27") },
        { to: "review", at: NOW },
      ],
    }),
  );
  const again = reconcile(fx, { only: null });
  assert.equal(again.flow.written, true);
  const row = rows(section(readFlow(fx), "In status since")).find((r) => r[0].includes("story-todo"));
  assert.equal(row[1], "review");
});

// [flow-view#9]
test("reconcile: on a layout with no flow view block --only flow exits nonzero naming it, and nothing is written (failure)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const root = mkdtempSync(join(tmpdir(), "ps-flowless-root-"));
  mkdirSync(join(root, "scaffold", "layouts"), { recursive: true });
  const layout = JSON.parse(readFileSync(join(REPO, "scaffold", "layouts", "engineering.json"), "utf8"));
  delete layout.flow;
  writeFileSync(join(root, "scaffold", "layouts", "engineering.json"), JSON.stringify(layout));
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "reconcile.mjs"), "--write", "--only", "flow"], {
    cwd: fx.proj,
    env: childEnv({ ...process.env, CLAUDE_PLUGIN_ROOT: root }, { projectRoot: fx.proj, pluginRoot: root }),
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /layout declares no flow view block/);
  assert.ok(!existsSync(flowFile(fx)));
  assert.ok(!existsSync(join(fx.vault, "kanban.md")), "nothing is written");
  rmSync(root, { recursive: true, force: true });
});

// [flow-view#9]
test("reconcile: with flow.md a directory, move --write moves the story, says the derived views are left naming flow.md and its error, and exits 1 (failure)", async () => {
  const epic = `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-11-01\n---\n\n# PS-X: X\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [a](./stories/story-a.md) | planned | the a |\n`;
  const fx = vault({ stories: { "PS-X/story-a": moved("story-a", { created: "2026-10-01" }) } });
  writeFileSync(join(fx.vault, "epics", "PS-X", "epic.md"), epic);
  mkdirSync(flowFile(fx));
  const sink = () => {
    const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
    return s;
  };
  const stdout = sink();
  const stderr = sink();
  const code = await run(["move", "PS-X/story-a", "todo", "--reason", "next up", "--write", "--project", fx.proj], {
    env: { ...process.env, CI: "1" },
    cwd: fx.proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  assert.equal(code, 1);
  const text = stdout.text + stderr.text;
  assert.match(text, /the derived views \([^)]*flow\.md: [^)]*\) is left/);
  const story = readFileSync(join(fx.vault, "epics", "PS-X", "stories", "story-a.md"), "utf8");
  assert.match(story, /^status: todo$/m);
});

// ─── Contract 10: doctor's flow-view finding ───────────────────────────

const flowViewFindings = (fx) => byCheck(doctorRun(fx, { now: NOW }), "flow-view");
const COMMAND = "npx projectstore reconcile --write --only flow";
const assertStale = (found, what) => {
  assert.equal(found.length, 1, `${what}: ${JSON.stringify(found)}`);
  assert.equal(found[0].level, "issue");
  assert.equal(found[0].file, "flow.md");
  const lines = found[0].message.split("\n");
  assert.ok(lines[0].endsWith(":"), what);
  assert.equal(lines[1], COMMAND, what);
};

// [flow-view#10]
test("doctor: a status edited, flow.window_weeks changed from 4 to 2, and a hand edit each give one flow-view issue with the command alone on its line, and none after reconcile --only flow", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 4 } }, stories: oneInEach() });
  reconcile(fx);
  assert.deepEqual(flowViewFindings(fx), []);
  const story = join(fx.vault, "epics", "PS-X", "stories", "story-backlog.md");
  const cfgPath = join(fx.vault, ".projectstore.json");
  const changes = [
    ["a status edited", () => writeFileSync(story, setFm(readFileSync(story, "utf8"), "status", "todo"))],
    ["the window changed", () => writeFileSync(cfgPath, JSON.stringify({ flow: { window_weeks: 2 } }))],
    ["a hand edit", () => writeFileSync(flowFile(fx), `${readFlow(fx)}\nmy note\n`)],
  ];
  for (const [what, change] of changes) {
    change();
    assertStale(flowViewFindings(fx), what);
    assert.equal(reconcile(fx, { write: false }).flow.changed, true, what);
    reconcile(fx);
    assert.deepEqual(flowViewFindings(fx), [], `${what}: fresh after reconcile`);
  }
});

// [flow-view#10]
test("doctor: an edit to a story's Description only gives no flow-view, and a compute-mode --only flow reports changed false (edge)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  reconcile(fx);
  const story = join(fx.vault, "epics", "PS-X", "stories", "story-doing.md");
  writeFileSync(
    story,
    readFileSync(story, "utf8").replace("## Description\n", "## Description\n\nA new line no view reads.\n"),
  );
  assert.deepEqual(flowViewFindings(fx), []);
  assert.equal(reconcile(fx, { write: false }).flow.changed, false);
});

// [flow-view#10]
test("doctor: a story's updated set past every other stamp moves as_of, so doctor gives one flow-view issue, and none after reconcile (edge)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  reconcile(fx);
  const story = join(fx.vault, "epics", "PS-X", "stories", "story-backlog.md");
  writeFileSync(story, setFm(readFileSync(story, "utf8"), "updated", "2026-11-14"));
  assertStale(flowViewFindings(fx), "as_of moved");
  reconcile(fx);
  assert.equal(asOfLine(readFlow(fx)), "as_of: 2026-11-14");
  assert.deepEqual(flowViewFindings(fx), []);
});

// [flow-view#10]
test("doctor: with no flow.md and a policy block setting flow.window_weeks, one flow-view info gives the command alone on its line after a colon", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  const found = flowViewFindings(fx);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "info");
  assert.equal(found[0].group, "vault");
  const lines = found[0].message.split("\n");
  assert.match(lines[0], /^No flow\.md yet\. .*from a terminal in ".*":$/);
  assert.equal(lines[1], COMMAND);
  assert.equal(lines.length, 2);
});

// [flow-view#10]
test("doctor: no flow.md and no policy, a policy holding only groomed_at, and doctor --startup on a stale flow.md give no flow-view finding (edge)", () => {
  const none = vault({ stories: oneInEach() });
  assert.deepEqual(flowViewFindings(none), []);
  const groomed = vault({ vaultCfg: { flow: { groomed_at: "2026-11-01" } }, stories: oneInEach() });
  assert.deepEqual(flowViewFindings(groomed), []);
  const stale = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  writeFileSync(flowFile(stale), "---\nprojectstore: derived\n---\n\nstale\n");
  assert.equal(checkFlowView(stale.cfg, LAYOUT, stale.proj).length, 1, "the check itself sees it (control)");
  const startup = runStartupChecks(stale.cfg, stale.proj, 60000);
  assert.ok(!startup.findings.some((f) => f.check === "flow-view"), JSON.stringify(startup.findings));
});

// [flow-view#10]
test("doctor: flow.md replaced by a directory gives one flow-view warn that names the error and then the rebuild command alone on its line (failure)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  mkdirSync(flowFile(fx));
  const found = flowViewFindings(fx);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].level, "warn");
  const lines = found[0].message.split("\n");
  assert.match(
    lines[0],
    /^flow\.md could not be read: .*EISDIR.*If it is not a plain file, move it out of the vault, then rebuild it from a terminal in ".*":$/,
  );
  assert.equal(lines[1], COMMAND);
});

// ─── Contract 11: the other readers of the views list ──────────────────

// [flow-view#11]
test("readers: with fresh kanban.md, code-map.md and graph.md and flow.md written after them, status reads none of the three stale (edge)", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  reconcile(fx, { only: "kanban,codemap,graph,flow" });
  assert.ok(existsSync(flowFile(fx)));
  // The sources at t0, the three views at t1, flow.md after them at t2.
  const t0 = new Date("2026-11-01T00:00:00Z");
  const t1 = new Date("2026-11-02T00:00:00Z");
  const t2 = new Date("2026-11-03T00:00:00Z");
  for (const rel of readdirSync(fx.vault, { recursive: true })) {
    const abs = join(fx.vault, rel);
    if (statSync(abs).isFile()) utimesSync(abs, t0, t0);
  }
  for (const v of ["kanban.md", "code-map.md", "graph.md"]) utimesSync(join(fx.vault, v), t1, t1);
  utimesSync(flowFile(fx), t2, t2);
  const views = viewStatus(fx.cfg).views;
  for (const name of ["kanban", "code_map", "graph"]) assert.equal(views[name].stale, false, name);
});

// [flow-view#11]
test("readers: a phrase only in flow.md is found by search with --include-derived and not without", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: oneInEach() });
  reconcile(fx);
  const phrase = "A band that widens week after week";
  const hits = (r) => JSON.stringify(r);
  assert.ok(!hits(search(fx.cfg, phrase)).includes("flow.md"));
  assert.ok(hits(search(fx.cfg, phrase, { includeDerived: true })).includes("flow.md"));
});

// ─── Contract 12: the story command refreshes the page at both gates ───

const COPIES = [
  "commands/story.md",
  "adapters/codex/skills/projectstore-story/SKILL.md",
  "packaging/shells/projectstore-codex/skills/projectstore-story/SKILL.md",
];

// The text of one step: from its `N. **` line to the next step's.
function step(text, id) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${id}. **`));
  assert.ok(start !== -1, `step ${id}`);
  const end = lines.findIndex((l, i) => i > start && /^\d+[a-z]?\. \*\*/.test(l));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

// [flow-view#12]
test("story command: step 6 holds the plan clause, steps 5a and 6a name flow when flow.md exists, step 6e's reconcile line is unchanged, and no bare --write appears in any copy", () => {
  for (const rel of COPIES) {
    const whole = readFileSync(join(REPO, rel), "utf8");
    // The lifecycle flow's steps, from 5a on (the create flow has a step 6 too).
    const text = whole.slice(whole.indexOf("5a. **Delegate the ceremony"));
    const plan = step(text, "6");
    assert.match(plan, /On a `plan`, after\s+step 6d, when flow\.md exists at the vault root/, rel);
    assert.match(plan, /reconcile --write --only flow`/, rel);
    assert.match(plan, /never when it does not exist/, rel);
    assert.match(step(text, "5a"), /plus `flow` when flow\.md exists/, rel);
    assert.match(step(text, "6a"), /and `flow` when flow\.md exists/, rel);
    assert.match(step(text, "6e"), /reconcile --write --only kanban,codemap,graph,indexes --project "/, rel);
    assert.doesNotMatch(step(text, "6e"), /flow/, rel);
    for (const line of whole.split("\n"))
      if (/reconcile --write/.test(line)) assert.match(line, /reconcile --write --only /, `${rel}: ${line}`);
    assert.ok(!/^6g\. /m.test(whole), "no step after 6f");
  }
});

// ─── The cycle-time spec (alias `cycle-time`), contracts 6, 7 and 10 ───

// The page is dated 2026-11-11T12:00Z by its anchor story (PS-Z), so a
// window of 2 weeks is 2026-10-26 to 2026-11-09.
const AS_OF = at("2026-11-11", "12:00:00.000Z");
const ctClose = (id, start, close) => closedStory({ id, start: start === null ? null : at(start), close: at(close) });
const threeCloses = () => ({
  "PS-X/story-c2": ctClose("story-c2", "2026-10-27", "2026-10-29"),
  "PS-X/story-c5": ctClose("story-c5", "2026-10-26", "2026-10-31"),
  "PS-X/story-c9": ctClose("story-c9", "2026-10-20", "2026-10-29"),
});
const cycleLineOf = (content) => {
  const lines = (section(content, "Throughput") || "").split("\n");
  return lines.find((l) => /cycle time/i.test(l)) || null;
};
const atAsOf = (fx) => ({ now: new Date(asOfOf(factsOf(fx))).toISOString() });
// A story of `epic` moved to in-progress `n` whole days before AS_OF.
const quietFor = (epic, n) => ({
  [`${epic}/story-${epic.toLowerCase()}`]: moved(`story-${epic.toLowerCase()}`, {
    epic,
    moves: [["in-progress", new Date(Date.parse(AS_OF) - n * DAY).toISOString()]],
  }),
});

// [cycle-time#6]
test("cycle-time line: W of 2 and closes 2, 5 and 9 days after their start give 5 days over 3 stories, none left out, and doctor's flow-cycle-time at the as-of instant gives the same", () => {
  const fx = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: { ...threeCloses(), ...anchor(AS_OF) } });
  assert.equal(
    cycleLineOf(page(fx)),
    "Cycle time: the median (the middle value) of the days from a story's start to its close is 5 days, over 3 stories closed in the window; none is left out.",
  );
  const f = byCheck(doctorRun(fx, atAsOf(fx)), "flow-cycle-time");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /has a median \(the middle value\) of 5 days, over 3 stories\. None is left out\.$/);
});

// [cycle-time#6]
test("cycle-time line: W of 2 and no close says none closed in the window; two closed the day they started give under 1 day over 2 stories (edge)", () => {
  const old = { "PS-X/story-old": moved("story-old", { created: "2026-09-01" }) };
  const none = vault({ vaultCfg: { flow: { window_weeks: 2 } }, stories: { ...old, ...anchor(AS_OF) } });
  assert.equal(cycleLineOf(page(none)), "No story was closed in the window, so there is no cycle time to give.");
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-a": closedStory({ id: "story-a", start: at("2026-11-02"), close: at("2026-11-02", "16:00:00.000Z") }),
      "PS-X/story-b": closedStory({ id: "story-b", start: at("2026-11-03"), close: at("2026-11-03", "18:00:00.000Z") }),
      ...anchor(AS_OF),
    },
  });
  assert.match(cycleLineOf(page(fx)), /is under 1 day, over 2 stories closed in the window; none is left out\.$/);
});

// [cycle-time#6]
test("cycle-time line: W of 2 and one of three closes with no start gives the median of two and says 1 closed story is left out, and doctor says the same (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-c2": ctClose("story-c2", "2026-10-27", "2026-10-29"),
      "PS-X/story-c4": ctClose("story-c4", "2026-10-26", "2026-10-30"),
      "PS-X/story-none": ctClose("story-none", null, "2026-11-02"),
      ...anchor(AS_OF),
    },
  });
  assert.equal(
    cycleLineOf(page(fx)),
    "Cycle time: the median (the middle value) of the days from a story's start to its close is 3 days, over 2 stories closed in the window; 1 closed story is left out, since it has no start: its Status log has no in-progress or review line, and it has no `started_at`.",
  );
  const f = byCheck(doctorRun(fx, atAsOf(fx)), "flow-cycle-time");
  assert.match(f[0].message, /of 3 days, over 2 stories\. 1 closed story is left out, since it has no start: /);
});

// [cycle-time#6]
test("cycle-time line: W of 2 and two closes with no start say every closed story is left out, and give no number (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-a": ctClose("story-a", null, "2026-10-29"),
      "PS-X/story-b": ctClose("story-b", null, "2026-11-02"),
      ...anchor(AS_OF),
    },
  });
  const line = cycleLineOf(page(fx));
  assert.match(line, /^Every story closed in the window is left out of the cycle time, since none has a start/);
  assert.doesNotMatch(line, /\d/);
});

// [cycle-time#6]
test("cycle-time line: a vault younger than the window says no cycle time is given while the vault is younger than the window (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2 } },
    stories: {
      "PS-X/story-a": closedStory({
        id: "story-a",
        start: at("2026-11-02"),
        close: at("2026-11-04"),
        created: "2026-11-01",
      }),
      ...anchor(AS_OF),
    },
  });
  assert.equal(cycleLineOf(page(fx)), "No cycle time is given while the vault is younger than the window.");
});

// [cycle-time#6]
test("cycle-time line: with no flow.window_weeks there is no line, and the window-not-set sentence names the cycle time (edge)", () => {
  const content = page(
    vault({ vaultCfg: { flow: { people: { A: { wip: 2 } } } }, stories: { ...threeCloses(), ...anchor(AS_OF) } }),
  );
  assert.equal(section(content, "Throughput"), null);
  assert.doesNotMatch(content, /^Cycle time:/m);
  assert.match(content, /The weekly throughput, the cycle time and the cumulative flow are not shown, because/);
});

// [cycle-time#7]
test("epics without movement: at N of 14 the page lists the epic 14 days quiet with that date and not the one at 13, and doctor at the as-of instant gives one epic-idle for the first", () => {
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: { ...quietFor("PS-A", 14), ...quietFor("PS-B", 13), ...anchor(AS_OF) },
  });
  const body = section(page(fx), "Epics without movement");
  assert.deepEqual(rows(body), [["[[epics/PS-A/epic\\|PS-A: PS-A]]", "2026-10-28"]]);
  assert.match(body, /3 epics in progress are watched by this check\./);
  const idle = byCheck(doctorRun(fx, atAsOf(fx)), "epic-idle");
  assert.deepEqual(
    idle.map((f) => f.file),
    ["epics/PS-A/epic.md"],
  );
  assert.match(idle[0].message, /since 2026-10-28/);
});

// [cycle-time#7]
test("epics without movement: no flow.age_days.epic_idle, then a value of 0, give no table, say not set, then not a whole number of days above 0, each with the configure form, and read no epic.md (edge)", () => {
  for (const [flow, why] of [
    [{ window_weeks: 2 }, /\(`flow\.age_days\.epic_idle`\) is not set\. Set it with:/],
    [
      { age_days: { epic_idle: 0 } },
      /\(`flow\.age_days\.epic_idle`\) is not a whole number of days above 0\. Set it with:/,
    ],
  ]) {
    const fx = vault({ vaultCfg: { flow }, stories: { ...quietFor("PS-A", 30), ...anchor(AS_OF) } });
    const reads = [];
    const content = page(fx, {
      read: (p) => {
        reads.push(p);
        return readFileSync(p, "utf8");
      },
    });
    const body = section(content, "Epics without movement");
    assert.match(body, why);
    assert.match(body, /\n```\nnpx projectstore configure --set flow\.age_days\.epic_idle=<days>\n```/);
    assert.deepEqual(rows(body), []);
    assert.ok(reads.length > 0);
    assert.deepEqual(
      reads.filter((p) => p.endsWith("epic.md")),
      [],
    );
  }
});

// [cycle-time#7]
test("epics without movement: N of 14, no flow.window_weeks and no epic 14 days quiet say how many are watched and that none has gone 14 days, with the quiet-vault sentence, and no Throughput (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: { ...quietFor("PS-A", 5), ...anchor(AS_OF) },
  });
  const content = page(fx);
  const body = section(content, "Epics without movement");
  assert.match(
    body,
    /^\n2 epics in progress are watched by this check, and none of them has gone 14 days or more \(`flow\.age_days\.epic_idle`\) without a story changing status\./,
  );
  assert.match(
    body,
    /The days are counted to this page's date, 2026-11-11, the newest date a story carries, not to today\./,
  );
  assert.match(body, /doctor's `epic-idle` finding, which counts to today, lists it\./);
  assert.equal(section(content, "Throughput"), null);
});

// [cycle-time#7]
test("epics without movement: on a quiet vault neither page, built two days apart, lists the only epic and the two are equal; doctor gives epic-idle 14 days after the stamp and none at 13 (edge)", () => {
  const stamp = "2026-11-01T09:00:00.000Z";
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: { "PS-X/story-a": moved("story-a", { created: "2026-10-01", moves: [["in-progress", stamp]] }) },
  });
  const RealDate = globalThis.Date;
  class NoClock extends RealDate {
    constructor(...a) {
      if (!a.length) throw new Error("the clock was read");
      super(...a);
    }
    static now() {
      throw new Error("the clock was read");
    }
  }
  let first;
  let second;
  globalThis.Date = NoClock;
  try {
    first = page(fx, { generatedAt: "2026-11-01T10:00:00.000Z" });
    second = page(fx, { generatedAt: "2026-11-03T10:00:00.000Z" });
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(asOfLine(first), "as_of: 2026-11-01");
  assert.equal(dropGenerated(first), dropGenerated(second));
  assert.deepEqual(rows(section(first, "Epics without movement")), []);
  const after = (n) =>
    byCheck(doctorRun(fx, { now: new RealDate(Date.parse(stamp) + n * DAY).toISOString() }), "epic-idle");
  assert.equal(after(14).length, 1);
  assert.equal(after(13).length, 0);
});

// [cycle-time#7]
test("epics without movement: a title A | B ]] C is escaped in the link, an epic.md's updated never moves as_of, and an epic with no title shows its folder name (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    epics: {
      "PS-A": { title: JSON.stringify("A | B ]] C"), fm: { updated: "2027-01-01" } },
      "PS-B": { title: null },
    },
    stories: { ...quietFor("PS-A", 30), ...quietFor("PS-B", 20), ...anchor(AS_OF) },
  });
  const content = page(fx);
  assert.equal(asOfLine(content), "as_of: 2026-11-11");
  assert.deepEqual(
    rows(section(content, "Epics without movement")).map((r) => r[0]),
    ["[[epics/PS-A/epic\\|PS-A: A \\| B )) C]]", "[[epics/PS-B/epic\\|PS-B]]"],
  );
});

// [cycle-time#7]
test("epics without movement: an epic.md whose read throws leaves the other epics judged as before, and a line says 1 story or epic file could not be read (failure)", () => {
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: { ...quietFor("PS-A", 30), ...quietFor("PS-B", 20), ...anchor(AS_OF) },
  });
  const built = buildFlowView(fx.cfg, LAYOUT, {
    read: (p) => {
      if (p.endsWith(join("PS-B", "epic.md"))) throw new Error("EACCES");
      return readFileSync(p, "utf8");
    },
  });
  assert.equal(built.error, undefined);
  assert.match(built.content, /\n1 story or epic file could not be read and is left out, so the counts can be low\.\n/);
  assert.deepEqual(
    rows(section(built.content, "Epics without movement")).map((r) => r[1]),
    ["2026-10-12"],
  );
  assert.equal(built.stats.unread, 1);
});

// [cycle-time#7]
test("epics without movement: a last change read from closed_at, started_at or created is marked with its field in the date cell (edge)", () => {
  const fx = vault({
    vaultCfg: { flow: { age_days: { epic_idle: 14 } } },
    stories: {
      "PS-A/story-a": storyText({
        id: "story-a",
        epic: "PS-A",
        status: "done",
        fm: { closed_at: JSON.stringify(at("2026-10-01")) },
      }),
      "PS-B/story-b": storyText({
        id: "story-b",
        epic: "PS-B",
        status: "in-progress",
        fm: { started_at: JSON.stringify(at("2026-10-02")) },
      }),
      "PS-C/story-c": storyText({ id: "story-c", epic: "PS-C", created: "2026-10-03" }),
      ...anchor(AS_OF),
    },
  });
  assert.deepEqual(
    rows(section(page(fx), "Epics without movement")).map((r) => r[1]),
    ["2026-10-01 (from closed_at)", "2026-10-02 (from started_at)", "2026-10-03 (from created)"],
  );
});

// [cycle-time#10]
test("one count: on a vault with three closes and one epic past N, the page's cycle-time line and epics table give the numbers and the epic of flow-cycle-time and epic-idle at the as-of instant", () => {
  const fx = vault({
    vaultCfg: { flow: { window_weeks: 2, age_days: { epic_idle: 14 } } },
    stories: { ...threeCloses(), ...quietFor("PS-A", 20), ...anchor(AS_OF) },
  });
  const content = page(fx);
  const found = doctorRun(fx, atAsOf(fx));
  const cycle = byCheck(found, "flow-cycle-time");
  assert.equal(cycle.length, 1);
  const pageNums = cycleLineOf(content)
    .match(/is (\d+) days, over (\d+) stories/)
    .slice(1);
  const doctorNums = cycle[0].message.match(/of (\d+) days, over (\d+) stories/).slice(1);
  assert.deepEqual(pageNums, ["5", "3"]);
  assert.deepEqual(doctorNums, pageNums);
  const listed = rows(section(content, "Epics without movement"));
  const idle = byCheck(found, "epic-idle");
  assert.deepEqual(
    listed.map((r) => r[0].match(/^\[\[(.*)\\\|/)[1] + ".md"),
    idle.map((f) => f.file),
  );
  assert.deepEqual(
    listed.map((r) => r[1]),
    idle.map((f) => f.message.match(/since (\d{4}-\d\d-\d\d)/)[1]),
  );
});

// ─── Source guards ─────────────────────────────────────────────────────

const code = (rel) =>
  readFileSync(join(REPO, rel), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

// [flow-view#1]
test("source guard: flow-view.mjs reads the clock only for generated_at in main(), and no time zone or locale", () => {
  const src = code("scripts/flow-view.mjs");
  assert.doesNotMatch(
    src,
    /Date\.now|new Date\(\s*\)|performance\.now|toLocale|Intl\.|localeCompare|getTimezoneOffset/,
  );
  const uses = src.match(/nowIso\(\)/g) || [];
  assert.equal(uses.length, 1, "one clock read");
  const main = src.slice(src.indexOf("function main()"));
  assert.match(main, /generatedAt: nowIso\(\)/);
});

// [flow-view#8]
test("source guard: flow-view.mjs imports no doctor.mjs, child process or network module, writes no file, and counts through flow-counts.mjs", () => {
  const src = code("scripts/flow-view.mjs");
  assert.doesNotMatch(src, /from "\.\/doctor\.mjs"|child_process|node:http|node:https|node:net|\bfetch\(/);
  assert.doesNotMatch(src, /writeFile|writeFileAtomic|appendFile|mkdirSync|renameSync|unlinkSync/);
  for (const fn of [
    "wipByPerson",
    "weeklyCounts",
    "windowCounts",
    "cumulativeFlow",
    "oldestFirst",
    "isYoung",
    "cycleTime",
    "idleEpics",
  ])
    assert.match(src, new RegExp(`\\b${fn}\\(`), `${fn} is used, not re-implemented`);
  assert.doesNotMatch(src, /closedAt\s*>=|created\s*>=\s*win/, "no window test of its own");
});

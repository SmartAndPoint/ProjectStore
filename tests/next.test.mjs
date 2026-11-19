// projectstore — tests/next.test.mjs: the `next` verb (PS-FLOW, "Choosing the
// next task respects the WIP limit and offers to finish started work first";
// the spec "The next verb: started work first, new work only under the WIP
// limit, and the plan gate's question before going over", alias `next`).
//
// The order runs as the verb runs it, through runNext with explicit as-of
// instants, on fixture vaults (tests/fixtures/flow.mjs); the exits, the
// envelope and the no-write rule run through the bin's run(). The plan gate's
// `wip` and `--over-wip` (contract 5) are tested beside the other plan gate
// tests, in tests/status-change.test.mjs; contract 6 is checked by hand, and
// its text pins are here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/cli.mjs";
import { runNext, nextTasks, priorityOf, moveCommand, wipOnStart, DEFAULT_LAYOUT } from "../scripts/next.mjs";
import { DEFAULT_LAYOUT as BINDING_DEFAULT_LAYOUT } from "../scripts/binding.mjs";
import { storyFacts } from "../scripts/flow-counts.mjs";
import { setFm } from "../scripts/status-log.mjs";
import { fromTerminalIn, parseFrontmatter } from "../scripts/lib.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { flowVault, storyText, withLine, NOW, NOW_MS, daysAgo, dayOf } from "./fixtures/flow.mjs";
import { closure, hookEntries, verbModuleSpecifiers, importSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const parseFm = (t) => parseFrontmatter(t).data;

// ─── Stories, as the gates and follow leave them ───────────────────────

const inProgress = (id, assignee, days) => storyText({ id, assignee, log: [{ to: "in-progress", at: daysAgo(days) }] });
const inReview = (id, assignee, days) =>
  storyText({
    id,
    assignee,
    log: [
      { to: "in-progress", at: daysAgo(days + 1) },
      { to: "review", at: daysAgo(days) },
    ],
  });
const awaiting = (id, assignee, days) =>
  withLine(inReview(id, assignee, days + 1), {
    at: daysAgo(days),
    from: "review",
    to: "review",
    reason: "merged, awaiting evidence",
  });
const inTodo = (id, assignee, days, priority = null) => {
  const t = storyText({ id, assignee, log: [{ to: "todo", at: daysAgo(days) }] });
  return priority === null ? t.replace(/^priority: p2\n/m, "") : setFm(t, "priority", priority);
};
const planned = (id, assignee, days, priority = "p2") =>
  setFm(storyText({ id, assignee, created: dayOf(daysAgo(days)) }), "priority", priority);

const limit = (people) => ({ flow: { people } });

// The verb as the bin runs it, with the as-of instant the tests pass.
async function next(fx, values = {}, seams = {}) {
  const r = await runNext({ values, cfg: fx.cfg, project: fx.proj, now: NOW, ...seams });
  return r;
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

// Through the bin's run(), as a person runs it.
async function bin(proj, args = [], { json = true } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["next", ...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  return { code, out: stdout.text, err: stderr.text, json: json && stdout.text ? JSON.parse(stdout.text) : null };
}

const refs = (rows) => rows.map((r) => r.ref);
const setAuthor = (fx, author) => {
  const p = join(fx.proj, ".projectstore", "projectstore.json");
  const cfg = JSON.parse(read(p));
  if (author === null) delete cfg.default_author;
  else cfg.default_author = author;
  writeFileSync(p, JSON.stringify(cfg));
  fx.cfg = cfg;
};

// Every file under a directory, by its path, with its bytes.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

// ─── Contract 1: the verb, the person, the exits, and no writes ────────

// [next#1]
test("next: the person is the binding's default_author when no --assignee is given, and the exit is 0", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": inProgress("story-a", "Ada", 2) } });
  setAuthor(fx, "Ada");
  const r = await bin(fx.proj);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.result.assignee, "Ada");
  assert.deepEqual(refs(r.json.result.started), ["PS-X/story-a"]);
  for (const k of ["assignee", "as_of", "wip", "message", "started", "new_work", "planned", "unread"])
    assert.ok(Object.hasOwn(r.json.result, k), k);
  assert.deepEqual(Object.keys(r.json.result.wip).sort(), ["at_limit", "awaiting", "held", "limit", "why"]);
  assert.match(r.json.result.as_of, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "nowIso() form");
});

// [next#1]
test("next: --assignee is trimmed and matched exactly, so `grace` is not `Grace` (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": inProgress("story-a", "grace", 2) } });
  const r = await bin(fx.proj, ["--assignee", " Grace "]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.result.assignee, "Grace");
  assert.deepEqual(r.json.result.started, []);
  assert.equal(r.json.result.wip.held, 0);
});

// [next#1]
test("next: a blank --assignee, or no --assignee and no default_author, exits 2 and lists nothing (failure)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": inProgress("story-a", "Ada", 2) } });
  setAuthor(fx, "Ada");
  const blank = await bin(fx.proj, ["--assignee", "  "]);
  assert.equal(blank.code, 2);
  assert.equal(blank.json.ok, false);
  assert.ok(!Object.hasOwn(blank.json.result, "started"), "nothing is listed");
  assert.match(blank.err, /--assignee/);
  setAuthor(fx, null);
  const none = await bin(fx.proj);
  assert.equal(none.code, 2);
  assert.equal(none.json.ok, false);
  assert.ok(!Object.hasOwn(none.json.result, "started"));
  const text = await bin(fx.proj, [], { json: false });
  assert.equal(text.code, 2);
  assert.equal(text.out, "", "nothing on stdout");
});

// [next#1]
test("next: a vault directory that is gone exits 1 naming its path; a project with no binding exits 3 (failure)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": inProgress("story-a", "Ada", 2) } });
  rmSync(fx.vault, { recursive: true, force: true });
  const gone = await bin(fx.proj, ["--assignee", "Ada"]);
  assert.equal(gone.code, 1);
  assert.equal(gone.json.ok, false);
  assert.ok(gone.json.result.error.includes(fx.vault), gone.json.result.error);
  const text = await bin(fx.proj, ["--assignee", "Ada"], { json: false });
  assert.equal(text.code, 1);
  assert.ok(text.err.includes(fx.vault), text.err);
  const unbound = mkdtempSync(join(tmpdir(), "ps-next-unbound-"));
  mkdirSync(join(unbound, ".claude"));
  const r = await bin(unbound, ["--assignee", "Ada"]);
  assert.equal(r.code, 3);
});

// [next#1]
test("next: bare and with --json, every file of the vault and of .projectstore/ is byte-identical after the run", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 3 } }),
    stories: {
      "PS-X/story-p": planned("story-p", "Ada", 4),
      "PS-X/story-t": inTodo("story-t", "Ada", 3, "p1"),
      "PS-X/story-i": inProgress("story-i", "Ada", 2),
      "PS-X/story-r": inReview("story-r", "Ada", 2),
      "PS-X/story-w": awaiting("story-w", "Ada", 1),
      "PS-Y/story-d": storyText({
        id: "story-d",
        epic: "PS-Y",
        assignee: "Ada",
        log: [
          { to: "in-progress", at: daysAgo(9) },
          { to: "done", at: daysAgo(8) },
        ],
      }),
      "PS-Y/story-k": setFm(storyText({ id: "story-k", epic: "PS-Y", assignee: "Ada" }), "status", "parked"),
    },
  });
  const before = snapshot(fx.proj);
  assert.ok(
    Object.keys(before).some((p) => p.startsWith(".projectstore")),
    "the binding is in the snapshot",
  );
  for (const json of [false, true]) {
    const r = await bin(fx.proj, ["--assignee", "Ada"], { json });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(fx.proj), before, json ? "--json" : "bare");
  }
});

// [next#1]
test("next: one story file that cannot be read leaves the others listed, unread is 1, and the exit is 0 (failure)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": inProgress("story-a", "Ada", 3),
      "PS-X/story-b": inProgress("story-b", "Ada", 2),
    },
  });
  const seam = (p) => {
    if (p.endsWith("story-b.md")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return readFileSync(p, "utf8");
  };
  const r = await next(fx, { assignee: "Ada" }, { read: seam });
  assert.equal(r.code, 0);
  assert.equal(r.result.unread, 1);
  assert.deepEqual(refs(r.result.started), ["PS-X/story-a"]);
  assert.match(r.text, /1 story file could not be read/);
});

// [next#1]
test("next: the row is in VAULT after status with writes false and no MCP tool; status.md and its copies suggest the bin's next with --project, alone on its line; no next command or skill", async () => {
  const { VERBS } = await import("../scripts/cli.mjs");
  const row = VERBS.find((v) => v.verb === "next");
  assert.ok(row);
  assert.equal(row.writes, false);
  assert.deepEqual([...row.mcp], []);
  assert.equal(row.requiresBinding, true);
  assert.deepEqual(
    row.options.map((o) => o.name),
    ["assignee", "json"],
  );
  const help = read(join(REPO, "tests", "fixtures", "presentation", "help.plain.txt")).split("\n");
  const vault = help.indexOf("VAULT");
  assert.ok(vault > 0);
  assert.match(help[vault + 1], /^ {2}status /);
  assert.match(help[vault + 2], /^ {2}next {9}Started work first/);
  const copies = [
    ["commands/status.md", 'node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" next --project "${CLAUDE_PROJECT_DIR}"'],
    [
      "adapters/codex/skills/projectstore-status/SKILL.md",
      'node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" next --project "$PWD"',
    ],
    [
      "packaging/shells/projectstore-codex/skills/projectstore-status/SKILL.md",
      'node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" next --project "$PWD"',
    ],
  ];
  for (const [rel, cmd] of copies) {
    const t = read(join(REPO, rel));
    const step6 = t.slice(t.indexOf("\n6. "), t.indexOf("What this command no longer does"));
    assert.ok(
      step6.split("\n").some((l) => l.trim() === cmd),
      `${rel}: the command alone on its line in step 6`,
    );
    assert.match(flat(step6), /Whenever `stories\.total` is above 0/, rel);
    assert.ok(!/npx [^\n]*\bnext\b/.test(t), `${rel}: no npx form for next`);
  }
  for (const rel of [
    "commands/next.md",
    "adapters/codex/skills/projectstore-next",
    "packaging/shells/projectstore-codex/skills/projectstore-next",
  ])
    assert.ok(!existsSync(join(REPO, rel)), `${rel} does not exist`);
  // The status verb's own output does not name next.
  const query = read(join(REPO, "scripts", "query.mjs"));
  assert.ok(!/["'`][^"'`\n]*\bnext --|packageCommand\([^)]*"next"/.test(query), "status prints no next command");
  // README names it beside move.
  const readme = read(join(REPO, "README.md"));
  const mv = readme.indexOf("npx projectstore move PS-CORE/story-x todo");
  const nx = readme.indexOf("\nnpx projectstore next\n");
  assert.ok(mv > 0 && nx > mv && nx - mv < 600, "README's next is beside move");
});

// ─── Contract 2: started work, at any WIP ──────────────────────────────

// [next#2]
test("next: started lists In Progress oldest first, then Review, then awaiting close, with their groups", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 5 } }),
    stories: {
      "PS-X/story-five": inProgress("story-five", "Ada", 5),
      "PS-X/story-nine": inProgress("story-nine", "Ada", 9),
      "PS-X/story-rev": inReview("story-rev", "Ada", 1),
      "PS-X/story-wait": awaiting("story-wait", "Ada", 12),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(refs(r.result.started), ["PS-X/story-nine", "PS-X/story-five", "PS-X/story-rev", "PS-X/story-wait"]);
  assert.deepEqual(
    r.result.started.map((x) => x.group),
    ["in-progress", "in-progress", "review", "awaiting-close"],
  );
  assert.deepEqual(
    r.result.started.map((x) => x.age_days),
    [9, 5, 1, 12],
  );
  const row = r.result.started[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "age_days",
    "age_from",
    "assignee",
    "group",
    "needs_move",
    "path",
    "ref",
    "title",
  ]);
  assert.equal(row.path, "epics/PS-X/stories/story-nine.md");
  assert.equal(row.assignee, "Ada");
  assert.equal(row.age_from, "stamp");
  assert.equal(row.needs_move, null);
  // The text lists the same rows in the same order.
  const at = refs(r.result.started).map((ref) => r.text.indexOf(ref));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    r.text,
  );
});

// [next#2]
test("next: a status written `In-Progress` is in started, in the group in-progress (edge)", async () => {
  const fx = flowVault({
    stories: { "PS-X/story-a": setFm(inProgress("story-a", "Ada", 2), "status", "In-Progress") },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(
    r.result.started.map((x) => [x.ref, x.group]),
    [["PS-X/story-a", "in-progress"]],
  );
});

// [next#2]
test("next: another person's story, an unassigned one and a parked one are not in started (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-g": inProgress("story-g", "Grace", 2),
      "PS-X/story-u": inProgress("story-u", "", 2),
      "PS-X/story-k": setFm(inProgress("story-k", "Ada", 2), "status", "parked"),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(r.result.started, []);
});

// [next#2]
test("next: a Review story edited by hand ages from updated, and the text says so (edge)", async () => {
  const hand = setFm(storyText({ id: "story-h", assignee: "Ada", updated: dayOf(daysAgo(3)) }), "status", "review");
  const fx = flowVault({ stories: { "PS-X/story-h": hand } });
  const r = await next(fx, { assignee: "Ada" });
  const row = r.result.started.find((x) => x.ref === "PS-X/story-h");
  assert.equal(row.group, "review");
  assert.equal(row.age_days, 3);
  assert.equal(row.age_from, "updated");
  assert.match(r.text, /PS-X\/story-h.*read from updated/);
});

// [next#2]
test("next: with a limit of 3 and five held stories, all five are in started (edge)", async () => {
  const stories = {};
  for (let i = 1; i <= 5; i++) stories[`PS-X/story-${i}`] = inProgress(`story-${i}`, "Ada", i);
  const fx = flowVault({ vaultCfg: limit({ Ada: { wip: 3 } }), stories });
  const r = await next(fx, { assignee: "Ada" });
  assert.equal(r.result.started.length, 5);
});

// ─── Contract 3: new work only while held is under the limit ───────────

// [next#3]
test("next: under the limit, new work lists the person's own ToDo story first, then the others with their assignee", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 3 } }),
    stories: {
      "PS-X/story-1": inProgress("story-1", "Ada", 2),
      "PS-X/story-2": inProgress("story-2", "Ada", 3),
      "PS-X/story-ada": inTodo("story-ada", "Ada", 1),
      "PS-X/story-grace": inTodo("story-grace", "Grace", 5),
      "PS-X/story-none": inTodo("story-none", "", 4),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.equal(r.result.message, null);
  assert.deepEqual(refs(r.result.new_work), ["PS-X/story-ada", "PS-X/story-grace", "PS-X/story-none"]);
  assert.deepEqual(
    r.result.new_work.map((x) => x.assignee),
    ["Ada", "Grace", null],
  );
  assert.ok(r.result.new_work.every((x) => x.priority === "p2" && x.needs_move === null));
  assert.match(r.text, /PS-X\/story-none.*\(unassigned, /);
  assert.ok(r.text.indexOf("Started work:") < r.text.indexOf("New work in ToDo:"), "started work first");
});

// [next#3]
test("next: at 3/3 and at 5/3, no new work, at_limit, the message, and the exit is 0 (the Independent test)", async () => {
  for (const held of [3, 5]) {
    const stories = { "PS-X/story-todo": inTodo("story-todo", "Ada", 1) };
    for (let i = 1; i <= held; i++)
      stories[`PS-X/story-${i}`] = i % 2 ? inProgress(`story-${i}`, "Ada", i) : inReview(`story-${i}`, "Ada", i);
    const fx = flowVault({ vaultCfg: limit({ Ada: { wip: 3 } }), stories });
    const r = await bin(fx.proj, ["--assignee", "Ada"]);
    assert.equal(r.code, 0, r.err);
    const res = r.json.result;
    assert.equal(res.started.length, held, "only the started stories");
    assert.deepEqual(res.new_work, []);
    assert.deepEqual(res.planned, []);
    assert.equal(res.wip.at_limit, true);
    assert.equal(res.message, `at WIP limit ${held}/3`);
    const text = await bin(fx.proj, ["--assignee", "Ada"], { json: false });
    assert.equal(text.code, 0);
    assert.ok(text.out.includes(`at WIP limit ${held}/3`), text.out);
    assert.ok(!text.out.includes("story-todo"), "the text offers no new work");
  }
});

// [next#3]
test("next: a story awaiting close is not held, so three started with one awaiting still offer ToDo (edge)", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 3 } }),
    stories: {
      "PS-X/story-1": inProgress("story-1", "Ada", 2),
      "PS-X/story-2": inReview("story-2", "Ada", 2),
      "PS-X/story-3": awaiting("story-3", "Ada", 1),
      "PS-X/story-t": inTodo("story-t", "", 1),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.equal(r.result.wip.held, 2);
  assert.equal(r.result.wip.awaiting, 1);
  assert.equal(r.result.wip.at_limit, false);
  assert.deepEqual(refs(r.result.new_work), ["PS-X/story-t"]);
});

// [next#3]
test("next: no flow block, a person not listed, and a time with no flow.wip have no limit, say why, and list started work first (edge)", async () => {
  const stories = {
    "PS-X/story-i": inProgress("story-i", "Ada", 2),
    "PS-X/story-t": inTodo("story-t", "", 1),
  };
  const cases = [
    [null, "the vault has no flow block, so the person has no WIP limit"],
    [{ flow: null }, "the vault has no flow block, so the person has no WIP limit"],
    [{ flow: {} }, "the vault has no flow block, so the person has no WIP limit"],
    [limit({ Grace: { wip: 2 } }), "Ada is not in the vault's flow.people, so the person has no WIP limit"],
    [
      { flow: { wip: { part: 1 }, people: { Ada: { time: "full" } } } },
      "Ada has no wip and no flow.wip for their time, so the person has no WIP limit",
    ],
  ];
  for (const [vaultCfg, why] of cases) {
    const fx = flowVault({ vaultCfg, stories });
    const r = await next(fx, { assignee: "Ada" });
    assert.equal(r.result.wip.limit, null, why);
    assert.equal(r.result.wip.at_limit, false);
    assert.equal(r.result.wip.why, why);
    assert.deepEqual(refs(r.result.started), ["PS-X/story-i"]);
    assert.deepEqual(refs(r.result.new_work), ["PS-X/story-t"]);
    assert.ok(r.text.includes(why), r.text);
    assert.ok(r.text.indexOf("PS-X/story-i") < r.text.indexOf("PS-X/story-t"), "started work first");
  }
  const withLimit = flowVault({ vaultCfg: limit({ Ada: { wip: 2 } }), stories });
  assert.equal((await next(withLimit, { assignee: "Ada" })).result.wip.why, null);
});

// [next#3]
test("next: ToDo is ordered by priority, a missing one read as p2, then by age (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-p1": inTodo("story-p1", "Ada", 2, "p1"),
      "PS-X/story-p2": inTodo("story-p2", "Ada", 9, "p2"),
      "PS-X/story-none": inTodo("story-none", "Ada", 20),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(refs(r.result.new_work), ["PS-X/story-p1", "PS-X/story-none", "PS-X/story-p2"]);
  assert.deepEqual(
    r.result.new_work.map((x) => x.priority),
    ["p1", "p2", "p2"],
  );
  assert.deepEqual(priorityOf(" P0 "), { priority: "p0", rank: 0 });
  assert.deepEqual(priorityOf("high"), { priority: "p2", rank: 2 });
  assert.deepEqual(priorityOf(undefined), { priority: "p2", rank: 2 });
});

// [next#3]
test("next: `constructor` and `__proto__` are names like any other; a refused key gives no limit (edge)", async () => {
  const todo = { "PS-X/story-t": inTodo("story-t", "", 1) };
  const ctor = flowVault({
    vaultCfg: limit({ constructor: { wip: 1 } }),
    stories: { ...todo, "PS-X/story-c": inProgress("story-c", "constructor", 2) },
  });
  const c = await next(ctor, { assignee: "constructor" });
  assert.equal(c.result.message, "at WIP limit 1/1");
  assert.deepEqual(c.result.new_work, []);
  const proto = flowVault({ stories: { ...todo, "PS-X/story-p": inProgress("story-p", "__proto__", 2) } });
  writeFileSync(join(proto.vault, ".projectstore.json"), '{"flow":{"people":{"__proto__":{"wip":1}}}}');
  const p = await next(proto, { assignee: "__proto__" });
  assert.equal(p.result.wip.held, 1);
  assert.equal(p.result.wip.limit, null);
  assert.equal(p.result.wip.why, "__proto__ is not in the vault's flow.people, so the person has no WIP limit");
  assert.deepEqual(refs(p.result.new_work), ["PS-X/story-t"]);
});

// ─── Contract 4: an empty ToDo offers planned stories to move ──────────

const sevenPlanned = () => {
  const stories = {};
  for (let i = 1; i <= 6; i++) stories[`PS-X/story-${i}`] = planned(`story-${i}`, "Ada", 10 + i);
  stories["PS-X/story-grace"] = planned("story-grace", "Grace", 1, "p1");
  return stories;
};

// [next#4]
test("next: with an empty ToDo, planned holds five, by priority then age, each with the move that puts it in ToDo", async () => {
  const fx = flowVault({ vaultCfg: limit({ Ada: { wip: 3 } }), stories: sevenPlanned() });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(r.result.new_work, []);
  assert.equal(r.result.planned.length, 5);
  assert.deepEqual(refs(r.result.planned), [
    "PS-X/story-grace",
    "PS-X/story-6",
    "PS-X/story-5",
    "PS-X/story-4",
    "PS-X/story-3",
  ]);
  for (const row of r.result.planned) {
    assert.equal(row.needs_move, `npx projectstore move ${row.ref} todo --reason 'next up' --write`);
    assert.equal(row.needs_move, moveCommand(row.ref));
  }
  // Each command alone on its line, after a lead that names the directory.
  const lines = r.text.split("\n");
  for (const row of r.result.planned)
    assert.ok(
      lines.some((l) => l.trim() === row.needs_move),
      row.needs_move,
    );
  assert.ok(
    lines.some((l) => l.includes(fromTerminalIn(fx.proj)) && l.endsWith(":")),
    r.text,
  );
  assert.ok(!/--project/.test(r.text));
});

// [next#4]
test("next: one ToDo story of Grace's is offered, and planned is empty (edge)", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 3 } }),
    stories: { ...sevenPlanned(), "PS-X/story-todo": inTodo("story-todo", "Grace", 1) },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(refs(r.result.new_work), ["PS-X/story-todo"]);
  assert.deepEqual(r.result.planned, []);
});

// [next#4]
test("next: of parked, soon and ` Planned`, only ` Planned` is offered with an empty ToDo (edge)", async () => {
  const base = (id) => storyText({ id, assignee: "Ada" });
  const fx = flowVault({
    stories: {
      "PS-X/story-parked": setFm(base("story-parked"), "status", "parked"),
      "PS-X/story-soon": setFm(base("story-soon"), "status", "soon"),
      "PS-X/story-pl": setFm(base("story-pl"), "status", '" Planned"'),
    },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.deepEqual(refs(r.result.planned), ["PS-X/story-pl"]);
});

// [next#4]
test("next: at the limit with no ToDo story, planned is empty (edge)", async () => {
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 1 } }),
    stories: { ...sevenPlanned(), "PS-X/story-i": inProgress("story-i", "Ada", 1) },
  });
  const r = await next(fx, { assignee: "Ada" });
  assert.equal(r.result.message, "at WIP limit 1/1");
  assert.deepEqual(r.result.planned, []);
});

// [next#4]
test("next: a vault with no stories lists nothing, no message, exit 0 (edge)", async () => {
  const fx = flowVault();
  const r = await bin(fx.proj, ["--assignee", "Ada"]);
  assert.equal(r.code, 0, r.err);
  const res = r.json.result;
  assert.deepEqual([res.started, res.new_work, res.planned], [[], [], []]);
  assert.equal(res.message, null);
  assert.equal(res.unread, 0);
});

// The pure core: the same order for the same facts and instant.
// [next#2] [next#3]
test("next: nextTasks is a function of the facts, the vault config, the person and the instant", () => {
  const facts = [
    { rel: "epics/PS-X/stories/a.md", epic: "PS-X", slug: "a", text: inProgress("a", "Ada", 4) },
    { rel: "epics/PS-X/stories/b.md", epic: "PS-X", slug: "b", text: inTodo("b", "Ada", 1) },
  ].map((s) => storyFacts({ ...s, fm: parseFm(s.text) }));
  const one = nextTasks({ facts, vaultCfg: {}, person: "Ada", asOfMs: NOW_MS });
  const two = nextTasks({ facts, vaultCfg: {}, person: "Ada", asOfMs: NOW_MS });
  assert.deepEqual(one, two);
  assert.equal(one.started[0].age_days, 4);
  assert.deepEqual(refs(one.new_work), ["PS-X/b"], "no limit: the ToDo story is offered");
  const capped = nextTasks({ facts, vaultCfg: limit({ Ada: { wip: 1 } }), person: "Ada", asOfMs: NOW_MS });
  assert.deepEqual([capped.new_work, capped.message], [[], "at WIP limit 1/1"]);
  const later = nextTasks({ facts, vaultCfg: {}, person: "Ada", asOfMs: NOW_MS + 2 * 86400000 });
  assert.equal(later.started[0].age_days, 6);
});

// [next#5]
test("next: wipOnStart reads the binding's layout, DEFAULT_LAYOUT when it names none, and throws on one with no epic folder (failure)", () => {
  assert.equal(DEFAULT_LAYOUT, BINDING_DEFAULT_LAYOUT);
  const fx = flowVault({
    vaultCfg: limit({ Ada: { wip: 2 } }),
    stories: { "PS-X/story-a": inProgress("story-a", "Ada", 1) },
  });
  const args = { vault: fx.vault, vaultCfg: limit({ Ada: { wip: 2 } }), name: "Ada" };
  const asked = [];
  const load = (n) => (asked.push(n), { folders: [{ kind: "epic", path: "epics" }] });
  assert.equal(wipOnStart({ ...args, layout: null, load }).held, 1);
  assert.equal(wipOnStart({ ...args, layout: "mine", load }).held, 1);
  assert.deepEqual(asked, [DEFAULT_LAYOUT, "mine"]);
  assert.throws(
    () => wipOnStart({ ...args, layout: "flat", load: () => ({ folders: [] }) }),
    /layout flat has no epic folder/,
  );
});

// ─── Contract 6 (verified: manual): text pins on the story command ─────

// [next#6]
test("commands/story.md and its copies: step 2 names wip and --over-wip, 2a asks the WIP question first, step 5 compares wip.over and asks there", () => {
  const copies = [
    "commands/story.md",
    "adapters/codex/skills/projectstore-story/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-story/SKILL.md",
  ];
  for (const rel of copies) {
    const t = read(join(REPO, rel));
    const life = t.slice(t.indexOf("# Lifecycle gate flow"));
    const s2 = life.indexOf("2. **Run the compute script**");
    const a = life.indexOf("2a. **(plan only) Open questions, one round.**");
    const s3 = life.indexOf("3. **Fill the section content**");
    const s5 = life.indexOf("5. **Immediately before writing**");
    const s5a = life.indexOf("5a. ");
    assert.ok(s2 > 0 && s2 < a && a < s3 && s3 < s5 && s5 < s5a, rel);
    const step2 = flat(life.slice(s2, a));
    for (const needle of ["`wip`", "`--over-wip`", "`; started over WIP limit <after>/<limit>`", "`over`"])
      assert.ok(step2.includes(needle), `${rel} step 2: ${needle}`);
    const step2a = flat(life.slice(a, s3));
    for (const needle of [
      "When step 2's `wip.over` is `true`, the round's first question asks whether to start anyway",
      "`<after>/<limit>`",
      "recommended answer is No",
      "counts in the five",
      "`lifecycle_gates: off` too",
      "the `flow` block alone decides",
      "On a Yes, step 2 runs again with `--over-wip`",
      "On a No, a skipped WIP question or a dismissed round, the gate ends and nothing is written",
      "no WIP question is asked",
    ])
      assert.ok(step2a.includes(needle), `${rel} step 2a: ${needle}`);
    // The sentences step 2a had are kept (tests/bounded-clarify.test.mjs pins them).
    assert.ok(step2a.includes("Ask once per gate run: the Edit in step 4 and the re-check in step 5 never ask again."));
    const step5 = flat(life.slice(s5, s5a));
    for (const needle of [
      "`--over-wip` included",
      "compare `wip.over` as well as `content`, on every plan run",
      "is a divergence: re-preview and re-ask",
      "When `wip.over` was false at step 2 and is true now, ask the WIP question here",
      "a Yes runs step 2 again with `--over-wip`",
      "Nothing is written before the new answer",
    ])
      assert.ok(step5.includes(needle), `${rel} step 5: ${needle}`);
  }
});

// ─── Reach ─────────────────────────────────────────────────────────────

const WRITERS = [
  "status-change.mjs",
  "write-record.mjs",
  "reconcile.mjs",
  "binding.mjs",
  "scaffold.mjs",
  "configure.mjs",
  "install-harness.mjs",
  "agents-change.mjs",
  "band.mjs",
  "move.mjs",
  "follow.mjs",
  "epic-rule.mjs",
  "story-section.mjs",
];

// Source guard (no contract token: doctor would count it as coverage).
test("source guard: no hook and no MCP module reaches next.mjs, and next.mjs imports no writer", async () => {
  const { VERBS } = await import("../scripts/cli.mjs");
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  assert.ok(!Object.hasOwn(READ_HANDLERS, "next"), "the read runner does not serve next");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp];
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  for (const entry of entries)
    assert.ok(!closure(entry, { root: REPO, dispatch }).includes("scripts/next.mjs"), `${entry} reaches next.mjs`);
  // Not vacuous: the bin's table reaches it.
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/next.mjs"));
  const src = read(join(REPO, "scripts", "next.mjs"));
  const imports = importSpecifiers(src);
  for (const w of WRITERS) assert.ok(!imports.includes(`./${w}`), `next.mjs imports ${w}`);
  const fsLine = src.match(/^import \{([^}]*)\} from "node:fs";/m);
  assert.ok(fsLine, "next.mjs reads the fs through named imports");
  assert.deepEqual(
    fsLine[1]
      .split(",")
      .map((s) => s.trim())
      .filter((n) => /write|append|rename|mkdir|rm|unlink|copy|truncate|chmod/i.test(n)),
    [],
  );
  assert.ok(
    !/child_process|import\(/.test(src.replace(/^\s*\/\/.*$/gm, "")),
    "next.mjs starts nothing and loads nothing",
  );
});

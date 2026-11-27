// projectstore — tests/assign.test.mjs: the `assign` verb, who holds one story
// in ToDo, or no one before work starts (PS-BACKLOG, "Assign and rank verbs:
// who holds a story in ToDo, and its place in the backlog"). The scenarios are
// those of "The assign verb: who holds a story in ToDo, an agent within its
// WIP limit, and an assignee cleared before work starts" (alias `assign`),
// contracts 1 to 5. The verb runs in process through the bin's run(), on
// fixture vaults (tests/fixtures/flow.mjs), as tests/handover.test.mjs does; a
// drift is made through runAssign's afterCompute and beforeWrite seams.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { run, VERBS } from "../scripts/cli.mjs";
import { runAssign } from "../scripts/assign.mjs";
import { isAgentName } from "../scripts/flow-policy.mjs";
import { STATUS_ACTORS, parseStatusLog, AWAITING_REASON } from "../scripts/status-log.mjs";
import { parseFrontmatter, fromTerminalIn } from "../scripts/lib.mjs";
import { packageCommand, sourceHarness } from "../scripts/harness.mjs";
import { flowVault, storyText, daysAgo } from "./fixtures/flow.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const js = JSON.stringify;
const fm = (p) => parseFrontmatter(read(p)).data;
const pathOf = (fx, slug) => join(fx.vault, "epics", "PS-X", "stories", `${slug}.md`);

const inProgress = (id, { assignee = "Ada", at = daysAgo(10) } = {}) =>
  storyText({ id, assignee, log: [{ to: "in-progress", at }], fm: { started_at: js(at) } });
const inTodo = (id, { assignee = "Ada", at = daysAgo(5) } = {}) =>
  storyText({ id, assignee, log: [{ to: "todo", at }] });
const planned = (id, { assignee = "Ada" } = {}) => storyText({ id, assignee });

function vault({ flow = null, stories = {} } = {}) {
  const fx = flowVault({ vaultCfg: flow === null ? null : { flow }, stories });
  writeFileSync(join(fx.vault, "kanban.md"), "stub board\n");
  return fx;
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

async function assign(fx, args, { json = false, ask = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const proj = typeof fx === "string" ? fx : fx.proj;
  const code = await run(["assign", ...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = read(p);
    }
  };
  walk(dir);
  return out;
}

const direct = (fx, positionals, values, extra = {}) =>
  runAssign({ values: { ...values }, positionals, cfg: fx.cfg, project: fx.proj, env: process.env, ...extra });

// ─── Contract 1: the verb and its exits ────────────────────────────────

// [assign#1]
test("assign: bare, the plan names the line and the --write form, and every file is byte-identical", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const before = snapshot(fx.proj);
  const r = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "next up"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Assign PS-X\/story-a — story-a to agent:claude:$/m);
  assert.match(r.out, /assignee: Ada → agent:claude — next up \(assign\)$/m);
  assert.match(r.out, /^ {2}npx projectstore assign PS-X\/story-a 'agent:claude' --reason 'next up' --write$/m);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [assign#1]
test("assign: usage errors exit 2 and name the option, never the value", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const before = snapshot(fx.proj);
  const cases = [
    [[], /takes a story and a name/],
    [["PS-X/story-a", "--reason", "x"], /needs a name after the story, or --clear/],
    [["PS-X/story-a", "Grace", "--clear", "--reason", "x"], /--clear takes no name/],
    [["PS-X/story-a", "Grace"], /needs --reason/],
    [["PS-X/story-a", "Grace", "--reason", "two\nlines"], /--reason/],
    [["PS-X/story-a", "grace@example.invalid", "--reason", "x"], /the name holds @/],
  ];
  for (const [args, re] of cases) {
    const r = await assign(fx, args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.match(r.err, re);
    assert.ok(!r.err.includes("grace@example.invalid"), "the value is never echoed");
  }
  // A third positional is the bin's own usage error, before the verb runs.
  const extra = await assign(fx, ["PS-X/story-a", "Grace", "Ada", "--reason", "x"]);
  assert.equal(extra.code, 2);
  assert.match(extra.err, /takes no further argument/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [assign#1]
test("assign: an unknown story exits 1; a declined question writes nothing", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const before = snapshot(fx.proj);
  const unknown = await assign(fx, ["PS-X/story-zz", "Grace", "--reason", "x", "--write"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no story in epics\/PS-X matches/);
  const r = await direct(fx, ["PS-X/story-a", "Grace"], { reason: "x", write: true }, { confirm: async () => false });
  assert.equal(r.code, 1);
  assert.equal(r.result.declined, true);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [assign#1]
test("assign: a project with no binding exits 3; a binding whose vault directory is gone exits 1 naming the vault path (failure)", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ps-assign-unbound-"));
  mkdirSync(join(bare, ".claude"));
  const unbound = await assign(bare, ["PS-X/story-a", "Grace", "--reason", "x"]);
  assert.equal(unbound.code, 3, unbound.err);
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  rmSync(fx.vault, { recursive: true, force: true });
  const gone = await assign(fx, ["PS-X/story-a", "Grace", "--reason", "x", "--write"]);
  assert.equal(gone.code, 1, gone.err);
  assert.ok(gone.err.includes(fx.vault), gone.err);
});

// [assign#1] [assign#3]
test("assign: views failing to refresh exit 1 after the write, with the command alone on its line; run again, it finishes the job (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  rmSync(join(fx.vault, "kanban.md"));
  mkdirSync(join(fx.vault, "kanban.md"));
  writeFileSync(join(fx.vault, "kanban.md", "blocker"), "x\n");
  const args = ["PS-X/story-a", "Grace", "--reason", "next up", "--write"];
  const first = await assign(fx, args);
  assert.equal(first.code, 1, first.out + first.err);
  assert.match(first.err, /the story was written, but the derived views/);
  const cmd = packageCommand([], "assign", { args: "PS-X/story-a Grace --reason 'next up' --write" });
  const lines = first.err.split("\n");
  const k = lines.indexOf(cmd);
  assert.ok(k > 0, first.err);
  assert.ok(lines[k - 1].endsWith(`${fromTerminalIn(fx.proj)}:`), lines[k - 1]);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  const written = read(pathOf(fx, "story-a"));
  rmSync(join(fx.vault, "kanban.md"), { recursive: true, force: true });
  const second = await assign(fx, args, { json: true });
  assert.equal(second.code, 0, second.err);
  assert.equal(second.json.result.line, null);
  assert.ok(second.json.result.reconcile);
  assert.ok(statSync(join(fx.vault, "kanban.md")).isFile());
  assert.equal(read(pathOf(fx, "story-a")), written);
});

// ─── Contract 2: which story ───────────────────────────────────────────

// [assign#2]
test("assign: a name only in ToDo; the Backlog names move, a started story names handover, done and set aside are closed", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-p": planned("story-p"),
      "PS-X/story-i": inProgress("story-i"),
      "PS-X/story-d": storyText({ id: "story-d", assignee: "Ada", status: "done" }),
      "PS-X/story-s": storyText({ id: "story-s", assignee: "Ada", status: "parked" }),
      "PS-X/story-f": storyText({ id: "story-f", assignee: "Ada", status: "deferred" }),
      "PS-X/story-x": storyText({ id: "story-x", assignee: "Ada", status: "superseded" }),
      "PS-X/story-n": storyText({ id: "story-n", assignee: "Ada", status: "" }),
      "PS-X/story-r": storyText({ id: "story-r", assignee: "Ada", status: "review" }),
    },
  });
  const before = snapshot(fx.proj);
  const want = {
    "story-p": /in the Backlog: assign names a holder only in ToDo; put it there first with move PS-X\/story-p todo/,
    "story-i": /work that has started: give it to another person with handover/,
    "story-r": /work that has started: give it to another person with handover/,
    "story-d": /closed: assign writes only a story in the Backlog or ToDo/,
    "story-s": /parked, set aside/,
    "story-f": /deferred, set aside/,
    "story-x": /superseded, set aside/,
    "story-n": /has no status, which no board column names/,
  };
  for (const [slug, re] of Object.entries(want)) {
    const r = await assign(fx, [`PS-X/${slug}`, "Grace", "--reason", "x", "--write"]);
    assert.equal(r.code, 1, slug);
    assert.match(r.err, re, slug);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [assign#2]
test("assign --clear: a planned story held by the default author is held by no one after --write; a started one is refused with handover", async () => {
  const fx = vault({ stories: { "PS-X/story-p": planned("story-p"), "PS-X/story-i": inProgress("story-i") } });
  const r = await assign(fx, ["PS-X/story-p", "--clear", "--reason", "nobody yet", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fm(pathOf(fx, "story-p")).assignee, "");
  assert.match(read(pathOf(fx, "story-p")), /\| \*\*Assignee\*\* \| {2}\|/);
  assert.match(read(pathOf(fx, "story-p")), /assignee: Ada → none — nobody yet \(assign\)$/m);
  const started = await assign(fx, ["PS-X/story-i", "--clear", "--reason", "x", "--write"]);
  assert.equal(started.code, 1);
  assert.match(started.err, /handover/);
  assert.equal(fm(pathOf(fx, "story-i")).assignee, "Ada");
});

// [assign#2]
test("assign: the same holder, or --clear of no one, is nothing to write; a name marked left is refused", async () => {
  const fx = vault({
    flow: { people: { Grace: { left: "2026-11-01" } } },
    stories: { "PS-X/story-a": inTodo("story-a"), "PS-X/story-n": inTodo("story-n", { assignee: "" }) },
  });
  const story = read(pathOf(fx, "story-a"));
  const same = await assign(fx, ["PS-X/story-a", "Ada", "--reason", "x", "--write"]);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /already assigned to Ada: no line written/);
  assert.equal(read(pathOf(fx, "story-a")), story);
  const none = await assign(fx, ["PS-X/story-n", "--clear", "--reason", "x", "--write"]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /has no assignee: no line written/);
  const left = await assign(fx, ["PS-X/story-a", "Grace", "--reason", "x", "--write"]);
  assert.equal(left.code, 1);
  assert.match(left.err, /Grace is marked left \(flow\.people\[Grace\]\.left is 2026-11-01\)/);
  assert.equal(read(pathOf(fx, "story-a")), story);
});

// ─── Contract 3: what it writes ────────────────────────────────────────

// [assign#3]
test("assign --write: the assignee, the Assignee row and one (assign) line; status, stamps, updated and Last updated stay; no mark; the epic is not written", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const p = pathOf(fx, "story-a");
  const before = snapshot(fx.proj);
  const old = read(p);
  const r = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "next up", "--write"], { json: true });
  assert.equal(r.code, 0);
  const now = read(p);
  const f = parseFrontmatter(now).data;
  const o = parseFrontmatter(old).data;
  assert.equal(f.assignee, "agent:claude");
  for (const k of ["status", "status_changed_at", "updated", "started_at", "plan_updated_at"])
    assert.deepEqual(f[k], o[k], k);
  assert.ok(!("written_by_verb" in f), "no not-reviewed mark");
  assert.equal(f.review_status, o.review_status);
  assert.equal(/\*Last updated: [^*]+\*/.exec(now)?.[0], /\*Last updated: [^*]+\*/.exec(old)?.[0]);
  assert.match(now, /\| \*\*Assignee\*\* \| agent:claude \|/);
  const log = parseStatusLog(now).filter((l) => l.field === "assignee");
  assert.equal(log.length, 1);
  assert.equal(log[0].actor, "assign");
  assert.equal(r.json.result.line, log[0].line);
  // Only the story and the derived views change.
  const after = snapshot(fx.proj);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  const story = relative(fx.proj, p);
  assert.ok(changed.includes(story));
  for (const k of changed)
    assert.ok(
      k === story ||
        /(^|\/)(kanban|graph|code-map|flow)\.md$/.test(k) ||
        k.endsWith("README.md") ||
        k.includes(".projectstore/state/"),
      `unexpected write: ${k}`,
    );
  assert.ok(!changed.some((k) => k.endsWith("epic.md")), "the epic is not written");
});

// [assign#3]
test("assign --write: a story moved out of ToDo between the plan and the write is refused on the fresh bytes", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const p = pathOf(fx, "story-a");
  const r = await direct(
    fx,
    ["PS-X/story-a", "Grace"],
    { reason: "x", write: true },
    {
      confirm: async () => true,
      afterCompute: (attempt) => {
        if (attempt === 0) writeFileSync(p, read(p).replace("status: todo", "status: in-progress"));
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.result.error, /work that has started/);
  assert.equal(fm(p).assignee, "Ada");
});

// [assign#2]
test("assign: a status no column names is refused for a name and for --clear; --clear on a done story is closed (edge)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-u": storyText({ id: "story-u", assignee: "Ada", status: "wip-ish" }),
      "PS-X/story-d": storyText({ id: "story-d", assignee: "Ada", status: "done" }),
    },
  });
  const before = snapshot(fx.proj);
  for (const args of [["Grace"], ["--clear"]]) {
    const r = await assign(fx, ["PS-X/story-u", ...args, "--reason", "x", "--write"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /has the status wip-ish, which no board column names/);
  }
  const done = await assign(fx, ["PS-X/story-d", "--clear", "--reason", "x", "--write"]);
  assert.equal(done.code, 1);
  assert.match(done.err, /closed: assign writes only a story in the Backlog or ToDo/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [assign#3]
test("assign --write: a story given to someone else between the plan and the write is left as it is (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const p = pathOf(fx, "story-a");
  const r = await direct(
    fx,
    ["PS-X/story-a", "Grace"],
    { reason: "x", write: true },
    {
      confirm: async () => true,
      afterCompute: (attempt) => {
        if (attempt === 0) writeFileSync(p, read(p).replace('assignee: "Ada"', 'assignee: "Linus"'));
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.result.error, /is now assigned to Linus, not to Ada; it is left as it is/);
  assert.equal(fm(p).assignee, "Linus");
});

// ─── Contract 4: an agent within its limit ─────────────────────────────

// [assign#4]
test("isAgentName: agent: with at least one character after it", () => {
  assert.equal(isAgentName("agent:claude"), true);
  assert.equal(isAgentName("agent:"), false);
  assert.equal(isAgentName("Agent:claude"), false);
  assert.equal(isAgentName("Ada"), false);
  assert.equal(isAgentName(null), false);
});

// [assign#4]
test("assign: an agent's load is its started stories and its ToDo; at the limit it is refused with the count and the limit, a person at the same load is warned and assigned", async () => {
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 2 }, Grace: { wip: 2 } } },
    stories: {
      "PS-X/story-a": inTodo("story-a"),
      "PS-X/story-b": inProgress("story-b", { assignee: "agent:claude" }),
      "PS-X/story-q": inTodo("story-q", { assignee: "agent:claude" }),
      "PS-X/story-c": inProgress("story-c", { assignee: "Grace" }),
      "PS-X/story-g": inTodo("story-g", { assignee: "Grace" }),
    },
  });
  const p = pathOf(fx, "story-a");
  const story = read(p);
  const agent = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "x", "--write"]);
  assert.equal(agent.code, 1);
  assert.match(
    agent.err,
    /agent:claude holds 2 \(1 in In Progress and Review, 1 in ToDo\) and its WIP limit is 2: an agent is given no work past its limit/,
  );
  assert.equal(read(p), story);
  const person = await assign(fx, ["PS-X/story-a", "Grace", "--reason", "x", "--write"], { json: true });
  assert.equal(person.code, 0);
  assert.deepEqual(person.json.result.wip, {
    assignee: "Grace",
    held: 1,
    queued: 1,
    load: 2,
    limit: 2,
    over: true,
    agent: false,
  });
  assert.equal(fm(p).assignee, "Grace");
});

// [assign#4]
test("assign: an agent one under its limit is assigned, and the next ToDo story is refused (edge)", async () => {
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 1 } } },
    stories: { "PS-X/story-a": inTodo("story-a"), "PS-X/story-b": inTodo("story-b") },
  });
  const first = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "x", "--write"]);
  assert.equal(first.code, 0, first.err);
  const second = await assign(fx, ["PS-X/story-b", "agent:claude", "--reason", "x", "--write"]);
  assert.equal(second.code, 1);
  assert.match(second.err, /holds 1 \(0 in In Progress and Review, 1 in ToDo\) and its WIP limit is 1/);
  assert.equal(fm(pathOf(fx, "story-b")).assignee, "Ada");
});

// [assign#4]
test("assign: a story awaiting close is not in the load; an agent at its limit that already holds the story is nothing to write (edge)", async () => {
  const awaiting = storyText({
    id: "story-w",
    assignee: "agent:claude",
    log: [
      { to: "in-progress", at: daysAgo(20) },
      { to: "review", at: daysAgo(4), actor: "follow", reason: `${AWAITING_REASON}: <url>` },
    ],
    fm: { started_at: js(daysAgo(20)) },
  });
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 1 } } },
    stories: {
      "PS-X/story-a": inTodo("story-a"),
      "PS-X/story-w": awaiting,
      "PS-X/story-h": inTodo("story-h", { assignee: "agent:claude" }),
    },
  });
  const held = await assign(fx, ["PS-X/story-h", "agent:claude", "--reason", "x", "--write"]);
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /already assigned to agent:claude: no line written/);
  // Load 1, the ToDo story alone: the story awaiting close is not counted, so 0 are started.
  const refused = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "x"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /holds 1 \(0 in In Progress and Review, 1 in ToDo\)/);
});

// [assign#4]
test("assign: an agent with no limit, and --clear, are not checked; a ToDo story given to the agent meanwhile refuses the write (failure)", async () => {
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 2 } } },
    stories: {
      "PS-X/story-a": inTodo("story-a"),
      "PS-X/story-b": inTodo("story-b", { assignee: "agent:claude" }),
      "PS-X/story-c": inTodo("story-c"),
      "PS-X/story-d": inTodo("story-d"),
    },
  });
  const free = await assign(fx, ["PS-X/story-c", "agent:other", "--reason", "x", "--write"]);
  assert.equal(free.code, 0, free.err);
  const clear = await assign(fx, ["PS-X/story-b", "--clear", "--reason", "x"]);
  assert.equal(clear.code, 0, clear.err);
  const d = pathOf(fx, "story-d");
  const r = await direct(
    fx,
    ["PS-X/story-a", "agent:claude"],
    { reason: "x", write: true },
    {
      confirm: async () => true,
      beforeWrite: async () => writeFileSync(d, read(d).replace('assignee: "Ada"', 'assignee: "agent:claude"')),
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.result.error, /its WIP limit is 2/);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Ada");
});

// [assign#2]
test("assign: the checks run in order: the place before a left name, a left name before the same holder (edge)", async () => {
  const fx = vault({
    flow: { people: { Grace: { left: "2026-11-01" } } },
    stories: {
      "PS-X/story-i": inProgress("story-i", { assignee: "Grace" }),
      "PS-X/story-g": inTodo("story-g", { assignee: "Grace" }),
    },
  });
  const started = await assign(fx, ["PS-X/story-i", "Grace", "--reason", "x"]);
  assert.equal(started.code, 1);
  assert.match(started.err, /work that has started: give it to another person with handover/);
  const held = await assign(fx, ["PS-X/story-g", "Grace", "--reason", "x"]);
  assert.equal(held.code, 1);
  assert.match(held.err, /Grace is marked left/);
});

// [assign#3]
test("assign --clear --write on a ToDo story writes `assignee: Ada → none` (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a") } });
  const r = await assign(fx, ["PS-X/story-a", "--clear", "--reason", "back to the pool", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "");
  assert.match(read(pathOf(fx, "story-a")), /assignee: Ada → none — back to the pool \(assign\)$/m);
  assert.equal(fm(pathOf(fx, "story-a")).status, "todo");
});

// [assign#4]
test("assign: a refusal of an agent at its limit carries its load in the result", async () => {
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 1 } } },
    stories: { "PS-X/story-a": inTodo("story-a"), "PS-X/story-b": inTodo("story-b", { assignee: "agent:claude" }) },
  });
  const r = await assign(fx, ["PS-X/story-a", "agent:claude", "--reason", "x"], { json: true });
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.result.wip, {
    assignee: "agent:claude",
    held: 0,
    queued: 1,
    load: 1,
    limit: 1,
    over: true,
    agent: true,
  });
});

// [assign#4]
test("assign: with a story file unread, an agent with a limit is refused, a person gets a note `unread`; an agent with no limit and an unseen name get their notes (edge)", async () => {
  const fx = vault({
    flow: { people: { "agent:claude": { wip: 3 }, Grace: { wip: 3 } } },
    stories: { "PS-X/story-a": inTodo("story-a"), "PS-X/story-u": inTodo("story-u", { assignee: "agent:claude" }) },
  });
  const unreadable = (p) => {
    if (p.endsWith("story-u.md")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return read(p);
  };
  const agent = await direct(fx, ["PS-X/story-a", "agent:claude"], { reason: "x" }, { read: unreadable });
  assert.equal(agent.code, 1);
  assert.equal(agent.result.unread, 1);
  assert.match(agent.result.error, /could not be read, so the count can be short: an agent's limit is not checked/);
  const person = await direct(
    fx,
    ["PS-X/story-a", "Grace"],
    { reason: "x", write: true },
    { read: unreadable, confirm: async () => true },
  );
  assert.equal(person.code, 0, person.text);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.deepEqual(
    person.result.notes.map((n) => n.id),
    ["unread"],
  );
  const free = await direct(fx, ["PS-X/story-a", "agent:other"], { reason: "x" });
  assert.deepEqual(
    free.result.notes.map((n) => n.id),
    ["agent-no-limit", "person-unseen"],
  );
});

// ─── Contract 5: what reaches it ───────────────────────────────────────

// [assign#5]
test("assign: a CLI verb that writes, with no MCP tool, no command and no skill; no hook or MCP module reaches it", async () => {
  const row = VERBS.find((v) => v.verb === "assign");
  assert.equal(row.writes, true);
  assert.equal(row.requiresBinding, true);
  for (const rel of [
    "commands/assign.md",
    "packaging/shells/projectstore-codex/skills/projectstore-assign",
    "adapters/codex/skills/projectstore-assign",
  ])
    assert.ok(!existsSync(join(REPO, rel)), `${rel} does not exist`);
  assert.deepEqual([...row.mcp], []);
  assert.ok(!readdirSync(join(REPO, "commands")).includes("assign.md"));
  assert.ok(STATUS_ACTORS.includes("assign"));
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  for (const entry of [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp])
    assert.ok(!closure(entry, { root: REPO, dispatch }).includes("scripts/assign.mjs"), `${entry} reaches assign.mjs`);
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/assign.mjs"));
});

// [assign#5]
test("assign --json: the result holds every key on a plan, a refusal and a write", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a"), "PS-X/story-p": planned("story-p") } });
  const keys = [
    "write",
    "story",
    "from",
    "to",
    "reason",
    "clear",
    "line",
    "wip",
    "unread",
    "notes",
    "reconcile",
    "declined",
    "error",
  ];
  const plan = await assign(fx, ["PS-X/story-a", "Grace", "--reason", "x"], { json: true });
  assert.deepEqual(Object.keys(plan.json.result).sort(), [...keys].sort());
  const refused = await assign(fx, ["PS-X/story-p", "Grace", "--reason", "x"], { json: true });
  assert.equal(refused.code, 1);
  assert.deepEqual(Object.keys(refused.json.result).sort(), [...keys].sort());
  const wrote = await assign(fx, ["PS-X/story-a", "Grace", "--reason", "x", "--write"], { json: true });
  assert.equal(wrote.code, 0);
  assert.deepEqual(Object.keys(wrote.json.result).sort(), [...keys].sort());
  assert.equal(wrote.json.result.to, "Grace");
  const cleared = await assign(fx, ["PS-X/story-a", "--clear", "--reason", "x"], { json: true });
  assert.equal(cleared.json.result.to, null);
});

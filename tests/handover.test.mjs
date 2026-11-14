// projectstore — tests/handover.test.mjs: the `handover` verb, a leaving
// assignee's open stories to another person with a logged reason (PS-FLOW,
// "When an assignee leaves the project, their open stories are handed over
// with a recorded reason"). The scenarios are those of "The handover verb…"
// (alias `handover`), contracts 1 to 5; contract 6, doctor's
// `assignee-left`, runs beside the other flow checks in
// tests/doctor-flow.test.mjs. The verb runs in process through the bin's
// run(), on fixture vaults (tests/fixtures/flow.mjs); a drift is made through
// runHandover's afterCompute seam, as for move; doctor runs as the bin does,
// in its own process.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, VERBS } from "../scripts/cli.mjs";
import { runHandover } from "../scripts/handover.mjs";
import { parseStatusLog, statusStamp, AWAITING_REASON } from "../scripts/status-log.mjs";
import { parseFrontmatter, loadTemplate, renderTemplate, fromTerminalIn } from "../scripts/lib.mjs";
import { packageCommand, sourceHarness } from "../scripts/harness.mjs";
import { flowVault, storyText, withLine, daysAgo, ADDRESS, git, gitCommit } from "./fixtures/flow.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "projectstore.mjs");
const read = (p) => readFileSync(p, "utf8");
const js = JSON.stringify;
const fm = (p) => parseFrontmatter(read(p)).data;
const pathOf = (fx, slug) => join(fx.vault, "epics", "PS-X", "stories", `${slug}.md`);
const epicOf = (fx) => join(fx.vault, "epics", "PS-X", "epic.md");

// Stories as the writers leave them, assigned to Ada unless named.
const inProgress = (id, { assignee = "Ada", at = daysAgo(10), ...rest } = {}) =>
  storyText({ id, assignee, log: [{ to: "in-progress", at }], fm: { started_at: js(at) }, ...rest });
const inTodo = (id, { assignee = "Ada", at = daysAgo(5), ...rest } = {}) =>
  storyText({ id, assignee, log: [{ to: "todo", at }], ...rest });
const planned = (id, { assignee = "Ada", ...rest } = {}) => storyText({ id, assignee, ...rest });
const awaiting = (id, { assignee = "Ada", at = daysAgo(4) } = {}) =>
  withLine(inProgress(id, { assignee, at: daysAgo(20) }), {
    at,
    from: "in-progress",
    to: "review",
    reason: `${AWAITING_REASON}: <url>`,
  }).replace("status: in-progress", "status: review");

// A fixture vault with stub derived views, so a stale one is a finding.
function vault({ flow = null, stories = {} } = {}) {
  const fx = flowVault({ vaultCfg: flow === null ? null : { flow }, stories });
  writeFileSync(join(fx.vault, "kanban.md"), "stub board\n");
  writeFileSync(join(fx.vault, "graph.md"), "stub graph\n");
  return fx;
}

const sink = (isTTY = false) => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY };
  return s;
};

async function handover(fx, args, { ask = null, json = false, env = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const proj = typeof fx === "string" ? fx : fx.proj;
  const code = await run(["handover", ...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: env || { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}

const ADA_TO_GRACE = ["--from", "Ada", "--to", "Grace", "--reason", "left the team"];

// Every file of the project (its vault and .projectstore/ included), by path.
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

// The vault's stale-view findings, as `doctor --vault` reports them.
function staleViews(proj) {
  const r = spawnSync(process.execPath, [BIN, "doctor", "--vault", "--json", "--project", proj], {
    encoding: "utf8",
    timeout: 60000,
  });
  return JSON.parse(r.stdout).result.filter(
    (f) => ["kanban", "graph", "code-map", "index"].includes(f.check) && f.level !== "info",
  );
}

const direct = (fx, values, extra = {}) =>
  runHandover({ values: { ...values }, cfg: fx.cfg, project: fx.proj, env: process.env, ...extra });
const values = (extra = {}) => ({ from: "Ada", to: "Grace", reason: "left the team", ...extra });

// ─── Contract 1: the verb, consent and exits ───────────────────────────

// [handover#1]
test("handover: bare, Ada's two open stories are listed with their lines, Nothing written, the --write form alone on its line, and every file is byte-identical", async () => {
  const fx = vault({
    stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") },
  });
  const before = snapshot(fx.proj);
  const r = await handover(fx, ADA_TO_GRACE);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Hand over 2 stories from Ada to Grace:$/m);
  assert.match(r.out, /^ {2}PS-X\/story-a — story-a \(in-progress\)$/m);
  assert.match(r.out, /^ {2}PS-X\/story-b — story-b \(todo\)$/m);
  const lines = r.out
    .split("\n")
    .filter((l) => / assignee: Ada → Grace — handover: left the team \(handover\)$/.test(l));
  assert.equal(lines.length, 2, r.out);
  const lead = r.out.split("\n").find((l) => l.startsWith("Nothing written."));
  assert.equal(lead, `Nothing written. To apply it, ${fromTerminalIn(fx.proj)}:`);
  const cmd = packageCommand([], "handover", { args: "--from Ada --to Grace --reason 'left the team' --write" });
  assert.ok(
    r.out.split("\n").some((l) => l.trim() === cmd),
    r.out,
  );
  assert.deepEqual(snapshot(fx.proj), before);
});

// [handover#1]
test("handover: at a terminal, --write answered No exits 1 with declined true and error declined, asks once for the whole run, and writes nothing (edge)", async () => {
  const fx = vault({
    stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") },
  });
  const before = snapshot(fx.proj);
  const asked = [];
  const no = await handover(fx, [...ADA_TO_GRACE, "--write"], { ask: async (q) => (asked.push(q), "n") });
  assert.equal(no.code, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Apply 2 changes\?/);
  assert.match(no.err, /^Nothing written\.$/m);
  assert.deepEqual(snapshot(fx.proj), before);
  const r = await direct(fx, values({ write: true }), { confirm: async () => false });
  assert.equal(r.code, 1);
  assert.equal(r.result.declined, true);
  assert.equal(r.result.error, "declined");
  assert.deepEqual(snapshot(fx.proj), before);
});

// [handover#1]
test("handover: the same --write run made again has no items, writes no story, refreshes the views and exits 0 (edge)", async () => {
  const fx = vault({
    stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") },
  });
  const first = await handover(fx, [...ADA_TO_GRACE, "--write"], { json: true });
  assert.equal(first.code, 0, first.err);
  assert.equal(first.json.result.items.length, 2);
  const stories = [read(pathOf(fx, "story-a")), read(pathOf(fx, "story-b"))];
  writeFileSync(join(fx.vault, "kanban.md"), "stale again\n");
  const asked = [];
  const again = await handover(fx, [...ADA_TO_GRACE, "--write"], {
    json: true,
    ask: async (q) => (asked.push(q), "n"),
  });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json.result.items, []);
  assert.ok(again.json.result.reconcile, "the views were refreshed");
  assert.notEqual(read(join(fx.vault, "kanban.md")), "stale again\n");
  assert.deepEqual([read(pathOf(fx, "story-a")), read(pathOf(fx, "story-b"))], stories);
  assert.deepEqual(asked, []);
  // At a terminal too, with nothing to write no question is asked.
  const tty = await handover(fx, [...ADA_TO_GRACE, "--write"], { ask: async (q) => (asked.push(q), "n") });
  assert.equal(tty.code, 0, tty.err);
  assert.deepEqual(asked, []);
});

// [handover#1]
test("handover: a missing, blank or multi-line reason, a missing --to, the same person, an @ or a line break in a name are exit 2, naming the option and not the value (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  const before = snapshot(fx.proj);
  const cases = [
    [["--from", "Ada", "--to", "Grace", "--write"], "--reason", null],
    [["--from", "Ada", "--to", "Grace", "--reason", "  ", "--write"], "--reason", null],
    [["--from", "Ada", "--to", "Grace", "--reason", "one\ntwo", "--write"], "--reason", "one\ntwo"],
    [["--from", "Ada", "--reason", "x", "--write"], "--to", null],
    [["--to", "Grace", "--reason", "x", "--write"], "--from", null],
    [["--from", "Ada", "--to", " Ada ", "--reason", "x", "--write"], "--to", null],
    [["--from", "Ad@", "--to", "Grace", "--reason", "x", "--write"], "--from", "Ad@"],
    [["--from", "Ada", "--to", "Gr@ce", "--reason", "x", "--write"], "--to", "Gr@ce"],
    [["--from", "Ada", "--to", "Gr\nace", "--reason", "x", "--write"], "--to", "Gr\nace"],
    [["--from", "Ada", "--to", "", "--reason", "x", "--write"], "--to", null],
  ];
  for (const [args, option, value] of cases) {
    const r = await handover(fx, args, { json: true });
    assert.equal(r.code, 2, `${js(args)}: ${r.err}`);
    assert.equal(r.json.ok, false);
    assert.ok(r.err.includes(option), `${js(args)} names ${option}: ${r.err}`);
    if (value) assert.ok(!r.err.includes(value) && !r.out.includes(value), `${js(args)}: the value is not named`);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [handover#1]
test("handover: a project with no binding exits 3; a binding whose vault directory is gone exits 1 naming the vault path (failure)", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ps-handover-unbound-"));
  mkdirSync(join(bare, ".claude"));
  const unbound = await handover(bare, ADA_TO_GRACE);
  assert.equal(unbound.code, 3, unbound.err);
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  rmSync(fx.vault, { recursive: true, force: true });
  const gone = await handover(fx, ADA_TO_GRACE);
  assert.equal(gone.code, 1, gone.err);
  assert.ok(gone.err.includes(fx.vault), gone.err);
});

// [handover#1]
test("handover: --to __proto__, which no story and no flow.people key names, takes the story; wip is null and a person-unseen note names it (edge)", async () => {
  const fx = vault({ flow: { people: { Grace: { wip: 3 } } }, stories: { "PS-X/story-a": inProgress("story-a") } });
  const r = await handover(fx, ["--from", "Ada", "--to", "__proto__", "--reason", "x", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "__proto__");
  const res = r.json.result;
  assert.equal(res.wip, null);
  assert.deepEqual(
    res.notes.map((n) => n.id),
    ["person-unseen"],
  );
  assert.ok(res.notes[0].message.includes("__proto__"));
  assert.equal(res.declined, false);
  assert.equal(res.error, null);
  assert.deepEqual(Object.keys(res).sort(), [
    "declined",
    "error",
    "from",
    "items",
    "notes",
    "reason",
    "reconcile",
    "story",
    "to",
    "unread",
    "wip",
    "write",
  ]);
  assert.deepEqual(Object.keys(res.items[0]).sort(), [
    "at",
    "error",
    "from",
    "line",
    "path",
    "status",
    "story",
    "title",
    "to",
    "written",
  ]);
  // A --from that no story and no key names gets the note too, in the plan.
  const plan = await handover(fx, ["--from", "Adaa", "--to", "Grace", "--reason", "x"], { json: true });
  assert.deepEqual(
    plan.json.result.notes.map((n) => [n.id, n.message.startsWith("--from Adaa")]),
    [["person-unseen", true]],
  );
});

// ─── Contract 2: which stories move ────────────────────────────────────

// [handover#2]
test("handover: Ada's planned, todo, in-progress, awaiting and no-status stories move, oldest first; done and parked do not", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-p": planned("story-p", { updated: "2026-10-01" }),
      "PS-X/story-t": inTodo("story-t", { at: "2026-10-22T10:00:00.000Z" }),
      "PS-X/story-i": inProgress("story-i", { at: "2026-11-06T10:00:00.000Z" }),
      "PS-X/story-w": awaiting("story-w", { at: "2026-11-07T10:00:00.000Z" }),
      "PS-X/story-n": planned("story-n", { status: '""', updated: "2026-09-15" }),
      "PS-X/story-d": planned("story-d", { status: "done" }),
      "PS-X/story-k": planned("story-k", { status: "parked" }),
    },
  });
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.json.result.items.map((i) => i.story),
    ["PS-X/story-n", "PS-X/story-p", "PS-X/story-t", "PS-X/story-i", "PS-X/story-w"],
  );
  for (const i of r.json.result.items) assert.equal(i.line, null, "a plan has no line");
  assert.equal(new Set(r.json.result.items.map((i) => i.at)).size, 1, "one instant for the run");
});

// [handover#2]
test("handover: a --story assigned to Lin, and one assigned to an email-shaped name, exit 1 naming the story and its assignee (failure)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-l": inProgress("story-l", { assignee: "Lin" }),
      "PS-X/story-e": inProgress("story-e", { assignee: ADDRESS }),
      "PS-X/story-u": inProgress("story-u", { assignee: "" }),
    },
  });
  const before = snapshot(fx.proj);
  const lin = await handover(fx, [
    "--from",
    "Ada",
    "--to",
    "Grace",
    "--reason",
    "left",
    "--story",
    "PS-X/story-l",
    "--write",
  ]);
  assert.equal(lin.code, 1);
  assert.match(lin.err, /PS-X\/story-l is assigned to Lin, not to Ada/);
  const mail = await handover(fx, [
    "--from",
    "Ada",
    "--to",
    "Grace",
    "--reason",
    "left",
    "--story",
    "PS-X/story-e",
    "--write",
  ]);
  assert.equal(mail.code, 1);
  assert.match(mail.err, /PS-X\/story-e is assigned to an email-shaped name, not to Ada/);
  assert.ok(!mail.err.includes(ADDRESS));
  const none = await handover(fx, [
    "--from",
    "Ada",
    "--to",
    "Grace",
    "--reason",
    "left",
    "--story",
    "PS-X/story-u",
    "--write",
  ]);
  assert.equal(none.code, 1);
  assert.match(none.err, /PS-X\/story-u is assigned to none, not to Ada/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [handover#2]
test("handover: a done --story, one that matches no story, and one with no / exit 1 with move's messages after handover: (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-d": planned("story-d", { status: "done" }) } });
  const before = snapshot(fx.proj);
  const base = ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write", "--story"];
  const d = await handover(fx, [...base, "PS-X/story-d"]);
  assert.equal(d.code, 1);
  assert.match(d.err, /PS-X\/story-d is done, not open work/);
  const nothing = await handover(fx, [...base, "PS-X/story-nothing"]);
  assert.equal(nothing.code, 1);
  assert.ok(nothing.err.startsWith('handover: no story in epics/PS-X matches "story-nothing"'), nothing.err);
  const bare = await handover(fx, [...base, "story-x"]);
  assert.equal(bare.code, 1);
  assert.ok(bare.err.startsWith("handover: name the story as <EPIC-ID>/<story-id>"), bare.err);
  const parked = vault({ stories: { "PS-X/story-k": planned("story-k", { status: "parked" }) } });
  const k = await handover(parked, [...base, "PS-X/story-k"]);
  assert.equal(k.code, 1);
  assert.match(k.err, /PS-X\/story-k is parked, not open work/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [handover#2]
test("handover: Ada with no open story, and not in flow.people, gives items [] and exit 0 under --write --json (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-d": planned("story-d", { status: "done" }) } });
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.result.items, []);
});

// [handover#2]
test("handover: a --to marked left, in the past or the future, exits 1 saying so, and nothing is written (failure)", async () => {
  for (const left of ["2026-11-01", "2099-01-01"]) {
    const fx = vault({ flow: { people: { Grace: { left } } }, stories: { "PS-X/story-a": inProgress("story-a") } });
    const before = snapshot(fx.proj);
    const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /--to Grace is marked left/);
    assert.deepEqual(snapshot(fx.proj), before);
  }
  // An invalid left date is ignored by every reader: the work goes.
  const soon = vault({
    flow: { people: { Grace: { left: "soon" } } },
    stories: { "PS-X/story-a": inProgress("story-a") },
  });
  assert.equal((await handover(soon, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"])).code, 0);
});

// [handover#2]
test("handover: a story file that cannot be read leaves the others listed, unread 1, and an unread note says the list can be short (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") } });
  const r = await direct(fx, values(), {
    read: (p) => {
      if (p.endsWith("story-b.md")) throw new Error("EACCES");
      return readFileSync(p, "utf8");
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(
    r.result.items.map((i) => i.story),
    ["PS-X/story-a"],
  );
  assert.equal(r.result.unread, 1);
  const note = r.result.notes.find((n) => n.id === "unread");
  assert.match(note.message, /the list can be short/);
  assert.match(r.text, /the list can be short/);
});

// ─── Contract 3: what a write changes ──────────────────────────────────

// [handover#3]
test("handover: --write gives Ada's In Progress story to Grace: assignee and row, one log line, status and stamp as before, epic.md untouched", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  const path = pathOf(fx, "story-a");
  const before = fm(path);
  assert.equal(statusStamp(read(path)).trusted, true, "the stamp is trusted before (control)");
  const epic = read(epicOf(fx));
  const r = await handover(fx, [...ADA_TO_GRACE, "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  const text = read(path);
  const after = fm(path);
  assert.equal(after.assignee, "Grace");
  assert.match(text, /^\| \*\*Assignee\*\* \| Grace \|$/m);
  const at = r.json.result.items[0].at;
  const log = parseStatusLog(text);
  assert.equal(log[log.length - 1].line, `- ${at} assignee: Ada → Grace — handover: left the team (handover)`);
  assert.equal(r.json.result.items[0].line, log[log.length - 1].line);
  assert.equal(r.json.result.items[0].written, true);
  assert.equal(after.status, before.status);
  assert.equal(after.status_changed_at, before.status_changed_at);
  assert.equal(after.started_at, before.started_at);
  assert.equal(statusStamp(text).trusted, true);
  assert.equal(String(after.updated), at.slice(0, 10));
  assert.equal(read(epicOf(fx)), epic);
});

// [handover#3]
test("handover: a story written in Russian with no Status log gets its Исполнитель row rewritten and the section under the English heading; no stale view (edge)", async () => {
  const ru = renderTemplate(loadTemplate("ru", "story"), {
    id: "story-r",
    title: "Р",
    date: "2026-11-01",
    author: "Ada",
    tags: "[]",
    epic_id: "PS-X",
  });
  assert.match(ru, /\| \*\*Исполнитель\*\* \| Ada \|/, "the fixture has the Russian row (control)");
  assert.doesNotMatch(ru, /^## (Status log|Журнал статусов)/m, "and no Status log (control)");
  const fx = vault({ stories: { "PS-X/story-r": ru } });
  assert.equal(fx.cfg.language, "en");
  assert.ok(staleViews(fx.proj).length > 0, "the stub views are stale before (control)");
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"]);
  assert.equal(r.code, 0, r.err);
  const text = read(pathOf(fx, "story-r"));
  assert.match(text, /^\| \*\*Исполнитель\*\* \| Grace \|$/m);
  assert.match(text, /^## Status log$/m);
  assert.doesNotMatch(text, /^## Журнал статусов/m);
  assert.match(text, / assignee: Ada → Grace — handover: left \(handover\)$/m);
  assert.deepEqual(staleViews(fx.proj), []);
});

// [handover#3]
test("handover: an edit to the Description made between the read and the write is kept, and the story is handed over (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  const path = pathOf(fx, "story-a");
  const r = await direct(fx, values({ write: true }), {
    afterCompute: (i) => {
      if (i === 0) writeFileSync(path, read(path).replace("## Description\n", "## Description\n\nedited meanwhile\n"));
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.ok(read(path).includes("edited meanwhile"));
  assert.equal(fm(path).assignee, "Grace");
});

// [handover#3]
test("handover: a story reassigned to Lin between the read and the write still names Lin, its item's error names Lin, and the exit is 1 (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  const path = pathOf(fx, "story-a");
  let edited = null;
  const r = await direct(fx, values({ write: true }), {
    afterCompute: (i) => {
      if (i === 0) {
        edited = read(path).replace('assignee: "Ada"', 'assignee: "Lin"');
        writeFileSync(path, edited);
      }
    },
  });
  assert.notEqual(edited, null);
  assert.equal(r.code, 1, r.text);
  assert.equal(read(path), edited);
  assert.match(r.result.items[0].error, /assigned to Lin/);
  assert.equal(r.result.items[0].written, false);
});

// [handover#3]
test("handover: a story reassigned to --to itself between the read and the write is nothing to write: no item error, exit 0 (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  const path = pathOf(fx, "story-a");
  let edited = null;
  const r = await direct(fx, values({ write: true }), {
    afterCompute: (i) => {
      if (i === 0) {
        edited = read(path).replace('assignee: "Ada"', 'assignee: "Grace"');
        writeFileSync(path, edited);
      }
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.equal(read(path), edited, "nothing more is written");
  assert.equal(r.result.items[0].error, null);
  assert.equal(r.result.items[0].written, false);
  assert.equal(r.result.error, null);
});

// [handover#3]
test("handover: one of three stories edited before each of three attempts gives story-changed-meanwhile; the other two are written, exit 1 (failure)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-a": inProgress("story-a", { at: daysAgo(9) }),
      "PS-X/story-b": inProgress("story-b", { at: daysAgo(8) }),
      "PS-X/story-c": inProgress("story-c", { at: daysAgo(7) }),
    },
  });
  const b = pathOf(fx, "story-b");
  let last = null;
  const r = await direct(fx, values({ write: true }), {
    afterCompute: (i, ref) => {
      if (ref !== "PS-X/story-b") return;
      last = read(b) + `\nedit ${i}\n`;
      writeFileSync(b, last);
    },
  });
  assert.equal(r.code, 1, r.text);
  const byRef = Object.fromEntries(r.result.items.map((i) => [i.story, i]));
  assert.match(byRef["PS-X/story-b"].error, /^story-changed-meanwhile/);
  assert.equal(read(b), last);
  assert.equal(byRef["PS-X/story-a"].written, true);
  assert.equal(byRef["PS-X/story-c"].written, true);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.equal(fm(pathOf(fx, "story-c")).assignee, "Grace");
  assert.ok(r.result.reconcile, "the views are still refreshed");
});

// [handover#3]
test("handover: views failing to refresh exit 1 after the writes with the command alone on its line; run again, it finishes the job, with --story too (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") } });
  rmSync(join(fx.vault, "kanban.md"));
  mkdirSync(join(fx.vault, "kanban.md"));
  writeFileSync(join(fx.vault, "kanban.md", "blocker"), "x\n");
  const args = ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"];
  const first = await handover(fx, args);
  assert.equal(first.code, 1, first.out + first.err);
  const cmd = packageCommand([], "handover", { args: "--from Ada --to Grace --reason left --write" });
  const lines = first.err.split("\n");
  const k = lines.indexOf(cmd);
  assert.ok(k > 0, first.err);
  assert.ok(lines[k - 1].endsWith(`${fromTerminalIn(fx.proj)}:`), lines[k - 1]);
  assert.match(first.err, /derived views/);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.equal(fm(pathOf(fx, "story-b")).assignee, "Grace");
  const written = [read(pathOf(fx, "story-a")), read(pathOf(fx, "story-b"))];
  rmSync(join(fx.vault, "kanban.md"), { recursive: true, force: true });
  const second = await handover(fx, args, { json: true });
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(second.json.result.items, []);
  assert.ok(second.json.result.reconcile);
  assert.ok(existsSync(join(fx.vault, "kanban.md")) && statSync(join(fx.vault, "kanban.md")).isFile());
  assert.deepEqual([read(pathOf(fx, "story-a")), read(pathOf(fx, "story-b"))], written);
  const one = await handover(fx, [...args, "--story", "PS-X/story-a"], { json: true });
  assert.equal(one.code, 0, one.err);
  assert.deepEqual(one.json.result.items, []);
  assert.ok(one.json.result.reconcile);
  const bare = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--story", "PS-X/story-a"]);
  assert.match(bare.out, /PS-X\/story-a is already assigned to Grace: nothing to write/);
});

// [handover#1] [handover#2]
test("handover: bare with nothing to write, Ada with no open story or a --story already at --to, still gives the lead and the --write form alone on its line (edge)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-g": inProgress("story-g", { assignee: "Grace" }),
      "PS-X/story-d": planned("story-d", { status: "done" }),
    },
  });
  const before = snapshot(fx.proj);
  const lead = `Nothing written. To apply it, ${fromTerminalIn(fx.proj)}:`;
  for (const [extra, cmdArgs, head] of [
    [[], "--from Ada --to Grace --reason left --write", /^Ada holds no open story: nothing to hand over\.$/m],
    [
      ["--story", "PS-X/story-g"],
      "--from Ada --to Grace --reason left --story PS-X/story-g --write",
      /^PS-X\/story-g is already assigned to Grace: nothing to write\.$/m,
    ],
  ]) {
    const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", ...extra]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, head);
    const lines = r.out.split("\n");
    const k = lines.indexOf(lead);
    assert.ok(k >= 0, r.out);
    assert.equal(lines[k + 2].trim(), packageCommand([], "handover", { args: cmdArgs }));
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// ─── Contract 4: the receiver's WIP ────────────────────────────────────

const wipVault = ({ graceHolds = 2, limit = 3, ada = null } = {}) =>
  vault({
    flow: { people: { Grace: { wip: limit } } },
    stories: {
      ...Object.fromEntries(
        Array.from({ length: graceHolds }, (_, i) => [
          `PS-X/story-g${i}`,
          inProgress(`story-g${i}`, { assignee: "Grace" }),
        ]),
      ),
      ...(ada || {
        "PS-X/story-a": inProgress("story-a", { at: daysAgo(9) }),
        "PS-X/story-b": inProgress("story-b", { at: daysAgo(8) }),
      }),
    },
  });

// [handover#4]
test("handover: Grace with a limit of 3 holding two, and Ada's two In Progress stories: the text says Grace would hold 4/3, and wip says so", async () => {
  const fx = wipVault();
  const text = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"]);
  assert.match(text.out, /^Grace would hold 4\/3/m);
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"], { json: true });
  assert.deepEqual(r.json.result.wip, { assignee: "Grace", held: 2, moving: 2, after: 4, limit: 3, over: true });
});

// [handover#4]
test("handover: at a terminal, answered Yes, the preview holds Grace would hold 4/3 and both stories are written", async () => {
  const fx = wipVault();
  const asked = [];
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left", "--write"], {
    ask: async (q) => (asked.push(q), "y"),
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(asked.length, 1);
  const preview = r.out.slice(0, r.out.indexOf("Handed over"));
  assert.match(preview, /Grace would hold 4\/3/);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.equal(fm(pathOf(fx, "story-b")).assignee, "Grace");
});

// [handover#4]
test("handover: Grace holding one story ends at 3, not over, and no WIP line is printed (edge)", async () => {
  const fx = wipVault({ graceHolds: 1 });
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"], { json: true });
  assert.deepEqual(r.json.result.wip, { assignee: "Grace", held: 1, moving: 2, after: 3, limit: 3, over: false });
  const text = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"]);
  assert.doesNotMatch(text.out, /would hold/);
});

// [handover#4]
test("handover: Ada's planned, todo and awaiting-close stories only move 0, and no WIP line is printed (edge)", async () => {
  const fx = wipVault({
    graceHolds: 3,
    ada: {
      "PS-X/story-p": planned("story-p"),
      "PS-X/story-t": inTodo("story-t"),
      "PS-X/story-w": awaiting("story-w"),
    },
  });
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"], { json: true });
  assert.equal(r.json.result.items.length, 3);
  assert.equal(r.json.result.wip.moving, 0);
  assert.equal(r.json.result.wip.over, false);
  const text = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"]);
  assert.doesNotMatch(text.out, /would hold/);
});

// [handover#4]
test("handover: Grace not in flow.people has wip null (edge)", async () => {
  const fx = vault({
    stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-g": inProgress("story-g", { assignee: "Grace" }) },
  });
  const r = await handover(fx, ["--from", "Ada", "--to", "Grace", "--reason", "left"], { json: true });
  assert.equal(r.json.result.wip, null);
  assert.deepEqual(r.json.result.notes, []);
});

// [handover#4]
test("handover: Grace at 3 of 3 and a --story naming one of Ada's In Progress stories: moving 1, and the text says Grace would hold 4/3 (edge)", async () => {
  const fx = wipVault({ graceHolds: 3 });
  const args = ["--from", "Ada", "--to", "Grace", "--reason", "left", "--story", "PS-X/story-a"];
  const r = await handover(fx, args, { json: true });
  assert.equal(r.json.result.wip.moving, 1);
  assert.equal(r.json.result.wip.after, 4);
  assert.equal(r.json.result.story, "PS-X/story-a");
  assert.match((await handover(fx, args)).out, /Grace would hold 4\/3/);
});

// ─── Contract 5: what reaches it, and what it starts ───────────────────

// [handover#5]
test("handover: no hook entry and no MCP module reaches scripts/handover.mjs; the bin's table does", async () => {
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  assert.ok(!Object.hasOwn(READ_HANDLERS, "handover"), "the read runner does not serve handover");
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
    assert.ok(
      !closure(entry, { root: REPO, dispatch }).includes("scripts/handover.mjs"),
      `${entry} reaches handover.mjs`,
    );
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/handover.mjs"));
  // The CLI loads it on first use, through an import() in its handler.
  assert.match(read(join(REPO, "scripts", "cli.mjs")), /await import\("\.\/handover\.mjs"\)/);
  const src = read(join(REPO, "scripts", "handover.mjs")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /child_process|spawn|fetch\(|node:https?/, "handover.mjs starts nothing of its own");
});

// [handover#5]
test("handover: with no git and no gh on the PATH, --write writes the stories, refreshes the views and exits 0 (edge)", () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inTodo("story-b") } });
  const empty = mkdtempSync(join(tmpdir(), "ps-handover-path-"));
  const r = spawnSync(
    process.execPath,
    [BIN, "handover", "--from", "Ada", "--to", "Grace", "--reason", "left", "--write", "--json", "--project", fx.proj],
    { cwd: fx.proj, env: { ...process.env, PATH: empty, CI: "1" }, encoding: "utf8", timeout: 60000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout).result;
  assert.ok(res.reconcile, "the views were refreshed");
  assert.deepEqual(
    res.items.map((i) => i.written),
    [true, true],
  );
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.notEqual(read(join(fx.vault, "kanban.md")), "stub board\n");
});

// [handover#5]
test("handover: no commands/handover.md and no projectstore-handover skill; the row writes and has no MCP tool (edge)", () => {
  assert.ok(!existsSync(join(REPO, "commands", "handover.md")));
  const skills = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  for (const dir of [
    join(REPO, "skills"),
    join(REPO, "adapters", "codex", "skills"),
    ...readdirSync(join(REPO, "packaging", "shells")).map((s) => join(REPO, "packaging", "shells", s, "skills")),
  ])
    assert.ok(!skills(dir).some((s) => /handover/.test(s)), dir);
  const row = VERBS.find((v) => v.verb === "handover");
  assert.equal(row.writes, true);
  assert.equal(row.requiresBinding, true);
  assert.deepEqual(row.mcp, []);
  assert.match(read(join(REPO, "README.md")), /npx projectstore move[^\n]*\n```\n\n[^\n]*`handover`/);
});

// [handover#5]
test("handover: a story a live vault-worktree branch changed is written like any other, with no branch finding (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inProgress("story-a") } });
  git(fx.vault, ["init", "-q"]);
  git(fx.vault, ["add", "-A"]);
  gitCommit(fx.vault, { message: "seed" });
  const w1 = join(mkdtempSync(join(tmpdir(), "ps-handover-wt-")), "w1");
  git(fx.vault, ["worktree", "add", "-q", "-b", "b1", w1]);
  const rel = join("epics", "PS-X", "stories", "story-a.md");
  writeFileSync(join(w1, rel), read(join(w1, rel)) + "\nbranch note\n");
  const r = await handover(fx, [...ADA_TO_GRACE, "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(fm(pathOf(fx, "story-a")).assignee, "Grace");
  assert.deepEqual(
    r.json.result.notes.map((n) => n.id),
    ["person-unseen"],
    "Grace is unseen; no note is about a branch",
  );
  assert.ok(!("findings" in r.json.result));
  assert.doesNotMatch(JSON.stringify(r.json.result), /story-on-branch|branches-unknown/);
});

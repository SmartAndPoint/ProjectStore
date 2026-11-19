// projectstore — tests/groom.test.mjs: the `groom` verb, the weekly grooming
// pass (PS-FLOW, "A weekly grooming pass sends stale ToDo stories back to the
// backlog, and the librarian proposes epic merges"). The scenarios are those
// of "The groom verb…" (alias `groom`), contracts 1 to 6 and 8; contract 7,
// the command, is run by hand, and its text is pinned here. The verb runs in
// process through the bin's run(), or through runGroom with the seams (now,
// afterCompute, beforeStamp, read), on fixture vaults (tests/fixtures/flow.mjs);
// doctor runs through runVaultChecks, or as the bin does, in its own process.
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
  chmodSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, VERBS } from "../scripts/cli.mjs";
import { runGroom, groomReason } from "../scripts/groom.mjs";
import { runConfigure } from "../scripts/configure.mjs";
import { parseStatusLog, statusStamp, applyStatusChange, setFm } from "../scripts/status-log.mjs";
import { parseFrontmatter, fromTerminalIn } from "../scripts/lib.mjs";
import { packageCommand, sourceHarness } from "../scripts/harness.mjs";
import { flowVault, storyText, daysAgo, dayOf, NOW, doctorRun, byCheck, ids } from "./fixtures/flow.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "projectstore.mjs");
const read = (p) => readFileSync(p, "utf8");
const js = JSON.stringify;
const fm = (p) => parseFrontmatter(read(p)).data;
const pathOf = (fx, slug, epic = "PS-X") => join(fx.vault, "epics", epic, "stories", `${slug}.md`);
const configOf = (fx) => join(fx.vault, ".projectstore.json");
const cfgOf = (fx) => JSON.parse(read(configOf(fx)));
const WRITE_CMD = packageCommand([], "groom", { args: "--write" });

// Ages against the real clock, for runs through the bin, whose instant is
// its own; the seam's runs are at NOW.
const ago = (n) => daysAgo(n, Date.now());

// Stories as the writers leave them: in ToDo since `at`, by a trusted stamp.
const inTodo = (id, { at, ...rest }) => storyText({ id, log: [{ to: "todo", at }], ...rest });
const planned = (id, opts = {}) => storyText({ id, ...opts });
const inProgress = (id, { at = ago(3), ...rest } = {}) =>
  storyText({ id, log: [{ to: "in-progress", at }], fm: { started_at: js(at) }, ...rest });
const dropLine = (text, key) => text.replace(new RegExp(`^${key}:.*\\n`, "m"), "");

// An epic.md with a Stories table holding a row per story, so the epic row
// is written.
function epicWithRows(fx, epic, slugs, { status = "in-progress" } = {}) {
  const rows = slugs.map((s) => `| [${s}](./stories/${s}.md) | todo | the ${s} |`).join("\n");
  writeFileSync(
    join(fx.vault, "epics", epic, "epic.md"),
    `---\ntype: epic\nid: "${epic}"\ntitle: "${epic}"\nstatus: ${status}\ncreated: 2026-01-01\n---\n\n# ${epic}\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n${rows}\n`,
  );
}
const setEpicStatus = (fx, epic, status) => {
  const p = join(fx.vault, "epics", epic, "epic.md");
  writeFileSync(p, read(p).replace(/^status: .*$/m, `status: ${status}`));
};

// A fixture vault with stub derived views, so a stale one is a finding.
function vault({ flow = { age_days: { todo: 10 } }, cfg = undefined, stories = {} } = {}) {
  const fx = flowVault({ vaultCfg: cfg !== undefined ? cfg : flow === null ? null : { flow }, stories });
  writeFileSync(join(fx.vault, "kanban.md"), "stub board\n");
  writeFileSync(join(fx.vault, "graph.md"), "stub graph\n");
  return fx;
}

const sink = (isTTY = false) => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY };
  return s;
};

async function groom(fx, args = [], { ask = null, json = false, env = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const proj = typeof fx === "string" ? fx : fx.proj;
  const code = await run(["groom", ...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: env || { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}

const direct = (fx, values = {}, extra = {}) =>
  runGroom({ values: { ...values }, cfg: fx.cfg, project: fx.proj, env: process.env, now: NOW, ...extra });

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

const lastLine = (p) => {
  const log = parseStatusLog(read(p));
  return log[log.length - 1].line;
};
const noteIds = (r) => r.notes.map((n) => n.id);

// ─── Contract 1: the verb, consent and exits ───────────────────────────

// [groom#1]
test("groom: bare, a ToDo story 12 days old is listed with its line, Nothing written, the --write form alone on its line, exit 0, and every file is byte-identical", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  const before = snapshot(fx.proj);
  const r = await groom(fx);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ {2}PS-X\/story-a — story-a \(todo, 12 days\)$/m);
  assert.match(
    r.out,
    /^ {4}- \S+ status: todo → planned — groomed: in ToDo for 12 days \(groom\)$/m,
    "the line it would write",
  );
  const lines = r.out.split("\n");
  const k = lines.indexOf(`Nothing written. To apply it, ${fromTerminalIn(fx.proj)}:`);
  assert.ok(k >= 0, r.out);
  assert.equal(lines[k + 2].trim(), WRITE_CMD);
  assert.ok(lines.some((l) => /\/projectstore:groom also hands the one-story epics to the librarian/.test(l)));
  assert.deepEqual(snapshot(fx.proj), before);
});

// [groom#1]
test("groom: at a terminal, --write answered No exits 1 with declined true and error declined, asks once for the stories plus the stamp, and writes nothing (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  const before = snapshot(fx.proj);
  const asked = [];
  const no = await groom(fx, ["--write"], { ask: async (q) => (asked.push(q), "n") });
  assert.equal(no.code, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Apply 2 changes\?/);
  assert.match(no.err, /^Nothing written\.$/m);
  assert.deepEqual(snapshot(fx.proj), before);
  const r = await direct(fx, { write: true }, { confirm: async () => false });
  assert.equal(r.code, 1);
  assert.equal(r.result.declined, true);
  assert.equal(r.result.error, "declined");
  assert.equal(r.result.stamp.written, false);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [groom#1]
test("groom: no flow block, and a flow holding only flow.groomed_at, exit 1 bare and with --write, say the policy is not set, name the configure form, and write nothing (failure)", async () => {
  for (const cfg of [null, {}, { flow: null }, { flow: {} }, { flow: { groomed_at: "2026-11-01T00:00:00.000Z" } }]) {
    const fx = vault({ cfg, stories: { "PS-X/story-a": inTodo("story-a", { at: ago(40) }) } });
    const before = snapshot(fx.proj);
    for (const args of [[], ["--write"]]) {
      const r = await groom(fx, args);
      assert.equal(r.code, 1, `${js(cfg)} ${args}: ${r.out}`);
      assert.match(r.err, /flow policy is not set/);
      assert.ok(r.err.includes("configure --set flow.<key>=<value>"), r.err);
      const j = await groom(fx, args, { json: true });
      assert.equal(j.code, 1);
      assert.match(j.json.result.error, /flow policy is not set/);
    }
    assert.deepEqual(snapshot(fx.proj), before, js(cfg));
  }
});

// [groom#1]
test("groom: a vault config that is not valid JSON, and one whose flow is the number 3, exit 1 with --write, naming the file or flow and no value; nothing is written (failure)", async () => {
  for (const [text, named] of [
    ['{"flow": {"age_days": {"todo": 10}}, "secret_value"', ".projectstore.json"],
    ['{"flow": 3, "other": "secret_value"}', "flow"],
  ]) {
    const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(40) }) } });
    writeFileSync(configOf(fx), text);
    const before = snapshot(fx.proj);
    const r = await groom(fx, ["--write"]);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.err.includes(named), r.err);
    assert.ok(!r.err.includes("secret_value") && !r.err.includes(" 3"), r.err);
    assert.deepEqual(snapshot(fx.proj), before);
  }
});

// [groom#1]
test("groom: groom now and groom --story PS-X/story-a exit 2, naming the argument or the option; nothing is written (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(40) }) } });
  const before = snapshot(fx.proj);
  const now = await groom(fx, ["now", "--write"], { json: true });
  assert.equal(now.code, 2, now.err);
  assert.ok(now.err.includes("now"), now.err);
  const story = await groom(fx, ["--story", "PS-X/story-a", "--write"], { json: true });
  assert.equal(story.code, 2, story.err);
  assert.ok(story.err.includes("--story"), story.err);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [groom#1]
test("groom: a project with no binding exits 3; a binding whose vault directory is gone exits 1 naming the vault path (failure)", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ps-groom-unbound-"));
  mkdirSync(join(bare, ".claude"));
  const unbound = await groom(bare);
  assert.equal(unbound.code, 3, unbound.err);
  const fx = vault();
  rmSync(fx.vault, { recursive: true, force: true });
  const gone = await groom(fx);
  assert.equal(gone.code, 1, gone.err);
  assert.ok(gone.err.includes(fx.vault), gone.err);
});

// [groom#1]
test("groom: the --json result has the contract's keys, one instant in nowIso form, and items with theirs", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  const r = await groom(fx, [], { json: true });
  assert.equal(r.code, 0, r.err);
  const res = r.json.result;
  assert.deepEqual(Object.keys(res).sort(), [
    "at",
    "declined",
    "epics",
    "error",
    "items",
    "notes",
    "reconcile",
    "stamp",
    "unread",
    "write",
  ]);
  assert.match(res.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(res.items[0]).sort(), [
    "age_days",
    "age_from",
    "at",
    "epic",
    "error",
    "from",
    "line",
    "path",
    "reason",
    "status",
    "story",
    "title",
    "to",
    "written",
  ]);
  assert.equal(res.items[0].at, res.at);
  assert.equal(res.items[0].line, null, "a plan has no line");
  assert.deepEqual(res.stamp, { before: null, after: null, written: false });
  assert.equal(res.reconcile, null);
  assert.equal(res.declined, false);
  assert.equal(res.error, null);
  assert.equal(res.write, false);
});

// ─── Contract 2: which stories move ────────────────────────────────────

// [groom#2]
test("groom: with flow.age_days.todo of 10, ToDo stories 10 and 9 days old by trusted stamps: only the 10-day one, with age_days 10 and age_from stamp (edge)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-a": inTodo("story-a", { at: daysAgo(10) }),
      "PS-X/story-b": inTodo("story-b", { at: daysAgo(9) }),
    },
  });
  const r = await direct(fx);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(
    r.result.items.map((i) => [i.story, i.age_days, i.age_from]),
    [["PS-X/story-a", 10, "stamp"]],
  );
});

// [groom#2]
test("groom: a 12-day story whose status reads to-do moves with from to-do; stale planned, in-progress and parked stories do not (edge)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-t": setFm(inTodo("story-t", { at: daysAgo(12) }), "status", "to-do"),
      "PS-X/story-p": planned("story-p", { updated: "2026-09-01" }),
      "PS-X/story-i": inProgress("story-i", { at: daysAgo(30) }),
      "PS-X/story-k": planned("story-k", { status: "parked", updated: "2026-09-01" }),
    },
  });
  const r = await direct(fx);
  assert.deepEqual(
    r.result.items.map((i) => [i.story, i.from, i.status]),
    [["PS-X/story-t", "to-do", "to-do"]],
  );
  assert.equal(r.result.items[0].age_from, "stamp", "to-do is todo's column, so the stamp is trusted");
});

// [groom#2]
test("groom: a ToDo story edited by hand with updated 15 days old, and one with no updated and created 20 days old, are both moved, the reasons naming where the age is read from (edge)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-u": planned("story-u", { status: "todo", updated: dayOf(daysAgo(15)) }),
      "PS-X/story-c": dropLine(planned("story-c", { status: "todo", created: dayOf(daysAgo(20)) }), "updated"),
    },
  });
  const r = await direct(fx, { write: true });
  assert.equal(r.code, 0, r.text);
  const byRef = Object.fromEntries(r.result.items.map((i) => [i.story, i]));
  assert.equal(byRef["PS-X/story-u"].reason, "groomed: in ToDo for 15 days (age read from updated)");
  assert.equal(byRef["PS-X/story-c"].reason, "groomed: in ToDo for 20 days (age read from created)");
  assert.equal(byRef["PS-X/story-u"].age_from, "updated");
  assert.equal(byRef["PS-X/story-c"].age_from, "created");
  for (const slug of ["story-u", "story-c"]) {
    assert.equal(fm(pathOf(fx, slug)).status, "planned");
    assert.match(lastLine(pathOf(fx, slug)), / \(age read from (updated|created)\) \(groom\)$/);
  }
  assert.equal(groomReason(12, "stamp"), "groomed: in ToDo for 12 days");
});

// [groom#2]
test("groom: a ToDo story with no stamp, no updated and no created is not moved, and an undated note names it (edge)", async () => {
  const text = dropLine(dropLine(planned("story-n", { status: "todo" }), "updated"), "created");
  assert.equal(statusStamp(text).at, null, "no date at all (control)");
  const fx = vault({ stories: { "PS-X/story-n": text } });
  const r = await direct(fx, { write: true });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.result.items, []);
  const note = r.result.notes.find((n) => n.id === "undated");
  assert.ok(note && note.message.includes("PS-X/story-n"), js(r.result.notes));
  assert.equal(fm(pathOf(fx, "story-n")).status, "todo");
});

// [groom#2]
test("groom: a stale ToDo story and no flow.age_days.todo, with flow.grooming_days set: no item, a todo-age-unset note names the --set form, the stamp is written, exit 0 (edge)", async () => {
  const fx = vault({ flow: { grooming_days: 7 }, stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(40) }) } });
  const r = await direct(fx, { write: true });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.result.items, []);
  const note = r.result.notes.find((n) => n.id === "todo-age-unset");
  assert.ok(note.message.includes("configure --set flow.age_days.todo=<days>"), note.message);
  assert.equal(r.result.stamp.written, true);
  assert.equal(cfgOf(fx).flow.groomed_at, NOW);
  assert.equal(fm(pathOf(fx, "story-a")).status, "todo");
  // A value outside its set is the same: no story moves.
  writeFileSync(configOf(fx), js({ flow: { grooming_days: 7, age_days: { todo: "10" } } }));
  const bad = await direct(fx);
  assert.deepEqual(bad.result.items, []);
  assert.deepEqual(noteIds(bad.result), ["todo-age-unset"]);
});

// [groom#2]
test("groom: one story file that cannot be read leaves the others planned as before, unread 1, and an unread note says the list can be short (failure)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }),
      "PS-X/story-b": inTodo("story-b", { at: daysAgo(12) }),
    },
  });
  const r = await direct(
    fx,
    {},
    {
      read: (p) => {
        if (p.endsWith("story-b.md")) throw new Error("EACCES");
        return readFileSync(p, "utf8");
      },
    },
  );
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(
    r.result.items.map((i) => i.story),
    ["PS-X/story-a"],
  );
  assert.equal(r.result.unread, 1);
  assert.match(r.result.notes.find((n) => n.id === "unread").message, /the list can be short/);
  assert.match(r.text, /the list can be short/);
});

// ─── Contract 3: what a write changes ──────────────────────────────────

// [groom#3]
test("groom: --write moves a ToDo story 12 days old: planned, the (groom) line last, a trusted stamp at the run's instant, its epic row planned, and no stale derived view", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  epicWithRows(fx, "PS-X", ["story-a"]);
  const r = await groom(fx, ["--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  const at = r.json.result.at;
  const path = pathOf(fx, "story-a");
  const after = fm(path);
  assert.equal(after.status, "planned");
  assert.equal(after.status_changed_at, at);
  assert.equal(String(after.updated), at.slice(0, 10));
  assert.equal(statusStamp(read(path)).trusted, true);
  assert.match(read(path), /^\| \*\*Status\*\* \| planned \|$/m);
  const line = `- ${at} status: todo → planned — groomed: in ToDo for 12 days (groom)`;
  assert.equal(lastLine(path), line);
  const item = r.json.result.items[0];
  assert.equal(item.line, line);
  assert.equal(item.written, true);
  assert.equal(item.epic.written, true);
  assert.match(
    read(join(fx.vault, "epics", "PS-X", "epic.md")),
    /\| \[story-a\]\(\.\/stories\/story-a\.md\) \| planned \|/,
  );
  assert.equal(r.json.result.stamp.after, at);
  assert.deepEqual(staleViews(fx.proj), []);
});

// [groom#3]
test("groom: an edit to the Description made between the read and the write is kept, and the story is moved (edge)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }) } });
  const path = pathOf(fx, "story-a");
  const r = await direct(
    fx,
    { write: true },
    {
      afterCompute: (i) => {
        if (i === 0)
          writeFileSync(path, read(path).replace("## Description\n", "## Description\n\nedited meanwhile\n"));
      },
    },
  );
  assert.equal(r.code, 0, r.text);
  assert.ok(read(path).includes("edited meanwhile"));
  assert.equal(fm(path).status, "planned");
});

// [groom#3]
test("groom: a story moved to in-progress meanwhile stays in-progress, and one moved to planned and back to todo with a fresh stamp stays todo; each a left-todo note, no error, exit 0 (edge)", async () => {
  const cases = [
    ["in-progress", (t) => applyStatusChange(t, { to: "in-progress", reason: "r", actor: "move", at: NOW }).text],
    [
      "todo",
      (t) => {
        const p = applyStatusChange(t, { to: "planned", reason: "r", actor: "move", at: NOW }).text;
        return applyStatusChange(p, { to: "todo", reason: "r", actor: "move", at: NOW }).text;
      },
    ],
  ];
  for (const [status, change] of cases) {
    const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }) } });
    const path = pathOf(fx, "story-a");
    let edited = null;
    const r = await direct(
      fx,
      { write: true },
      {
        afterCompute: (i) => {
          if (i === 0) writeFileSync(path, (edited = change(read(path))));
        },
      },
    );
    assert.equal(r.code, 0, r.text);
    assert.equal(read(path), edited, "nothing more is written");
    assert.equal(fm(path).status, status);
    assert.equal(r.result.items[0].error, null);
    assert.equal(r.result.items[0].written, false);
    const note = r.result.notes.find((n) => n.id === "left-todo");
    assert.ok(note && note.message.includes("PS-X/story-a") && note.message.includes(status), js(r.result.notes));
    assert.equal(r.result.stamp.written, true);
  }
});

// [groom#3]
test("groom: three stale stories, one edited before each of three attempts: story-changed-meanwhile, the other two moved, the stamp written, the views refreshed, exit 1 (failure)", async () => {
  const fx = vault({
    stories: {
      "PS-X/story-a": inTodo("story-a", { at: daysAgo(14) }),
      "PS-X/story-b": inTodo("story-b", { at: daysAgo(13) }),
      "PS-X/story-c": inTodo("story-c", { at: daysAgo(12) }),
    },
  });
  const b = pathOf(fx, "story-b");
  let last = null;
  const r = await direct(
    fx,
    { write: true },
    {
      afterCompute: (i, ref) => {
        if (ref !== "PS-X/story-b") return;
        last = read(b) + `\nedit ${i}\n`;
        writeFileSync(b, last);
      },
    },
  );
  assert.equal(r.code, 1, r.text);
  const byRef = Object.fromEntries(r.result.items.map((i) => [i.story, i]));
  assert.match(byRef["PS-X/story-b"].error, /^story-changed-meanwhile/);
  assert.equal(read(b), last);
  assert.equal(fm(pathOf(fx, "story-a")).status, "planned");
  assert.equal(fm(pathOf(fx, "story-c")).status, "planned");
  assert.equal(r.result.stamp.written, true);
  assert.ok(r.result.reconcile, "the views are still refreshed");
});

// [groom#3]
test("groom: a stale story whose epic file cannot be written reads planned, and its item's error gives the move command alone on its line; exit 1 (failure)", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root writes a folder of mode 555");
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }) } });
  epicWithRows(fx, "PS-X", ["story-a"]);
  const epicDir = join(fx.vault, "epics", "PS-X");
  chmodSync(epicDir, 0o555); // epic.md's own folder: the atomic replace cannot make its temp
  let r;
  try {
    r = await direct(fx, { write: true });
  } finally {
    chmodSync(epicDir, 0o755);
  }
  assert.equal(r.code, 1, r.text);
  assert.equal(fm(pathOf(fx, "story-a")).status, "planned");
  const item = r.result.items[0];
  assert.equal(item.written, true);
  const cmd = packageCommand([], "move", {
    args: "PS-X/story-a planned --reason 'groomed: in ToDo for 12 days' --write",
  });
  const lines = item.error.split("\n");
  assert.equal(lines[lines.length - 1], cmd, item.error);
  assert.ok(lines[lines.length - 2].endsWith(`${fromTerminalIn(fx.proj)}:`), item.error);
  assert.ok(
    r.text.split("\n").some((l) => l === cmd),
    r.text,
  );
});

// [groom#3]
test("groom: views failing to refresh exit 1 after the moves with the command alone on its line; run again with the views fixed, it moves nothing, stamps, refreshes and exits 0 (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  rmSync(join(fx.vault, "kanban.md"));
  mkdirSync(join(fx.vault, "kanban.md"));
  writeFileSync(join(fx.vault, "kanban.md", "blocker"), "x\n");
  const first = await groom(fx, ["--write"]);
  assert.equal(first.code, 1, first.out + first.err);
  const lines = first.err.split("\n");
  const k = lines.indexOf(WRITE_CMD);
  assert.ok(k > 0, first.err);
  assert.ok(lines[k - 1].endsWith(`${fromTerminalIn(fx.proj)}:`), lines[k - 1]);
  assert.match(first.err, /derived views/);
  assert.equal(fm(pathOf(fx, "story-a")).status, "planned");
  const written = read(pathOf(fx, "story-a"));
  rmSync(join(fx.vault, "kanban.md"), { recursive: true, force: true });
  const second = await groom(fx, ["--write"], { json: true });
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(second.json.result.items, []);
  assert.equal(second.json.result.stamp.written, true);
  assert.equal(cfgOf(fx).flow.groomed_at, second.json.result.at);
  assert.ok(second.json.result.reconcile);
  assert.ok(statSync(join(fx.vault, "kanban.md")).isFile());
  assert.equal(read(pathOf(fx, "story-a")), written);
});

// ─── Contract 4: the stamp ─────────────────────────────────────────────

// [groom#4]
test("groom: no stale story, flow.grooming_days of 7 and three other flow keys: --write stamps flow.groomed_at, keeps every other key, exit 0", async () => {
  const flow = { grooming_days: 7, age_days: { todo: 10 }, idle_days: 4, wip: { full: 3 } };
  const fx = vault({
    cfg: { spec_policy: "optional", flow },
    stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(2) }) },
  });
  const r = await direct(fx, { write: true });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.result.items, []);
  assert.deepEqual(cfgOf(fx), { spec_policy: "optional", flow: { ...flow, groomed_at: NOW } });
  assert.deepEqual(r.result.stamp, { before: null, after: NOW, written: true });
  assert.match(r.text, /^This pass is recorded in flow\.groomed_at: 2026-11-11T12:00:00\.000Z$/m);
});

// [groom#4]
test("groom: bare, the same vault keeps .projectstore.json byte-identical, and stamp.written is false; stamp.before is the value read (edge)", async () => {
  const fx = vault({ flow: { grooming_days: 7, groomed_at: "2026-11-01T00:00:00.000Z" } });
  const before = read(configOf(fx));
  const r = await direct(fx);
  assert.equal(r.code, 0, r.text);
  assert.equal(read(configOf(fx)), before);
  assert.deepEqual(r.result.stamp, { before: "2026-11-01T00:00:00.000Z", after: null, written: false });
});

// [groom#4]
test("groom: configure --set flow.idle_days=5 run between the plan and the stamp is kept: flow.idle_days reads 5 and flow.groomed_at the run's instant (edge)", async () => {
  const fx = vault({ flow: { grooming_days: 7 } });
  const home = mkdtempSync(join(tmpdir(), "ps-groom-home-"));
  const r = await direct(
    fx,
    { write: true },
    {
      beforeStamp: async () => {
        const c = await runConfigure({
          values: { set: ["flow.idle_days=5"] },
          project: fx.proj,
          env: {},
          stdout: sink(),
          stderr: sink(),
          root: REPO,
          home,
        });
        assert.equal(c.code, 0, c.message || c.usage);
      },
    },
  );
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cfgOf(fx).flow, { grooming_days: 7, idle_days: 5, groomed_at: NOW });
});

// [groom#4]
test("groom: a vault config made invalid JSON between the moves and the stamp: the stories are moved, the file is as it was made, the views refreshed, exit 1 with the same command alone on its line (failure)", async () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }) } });
  const broken = '{"flow": {"age_days": ';
  const r = await direct(fx, { write: true }, { beforeStamp: () => writeFileSync(configOf(fx), broken) });
  assert.equal(r.code, 1, r.text);
  assert.equal(fm(pathOf(fx, "story-a")).status, "planned");
  assert.equal(read(configOf(fx)), broken);
  assert.ok(r.result.reconcile, "the views are refreshed");
  assert.equal(r.result.stamp.written, false);
  assert.equal(r.result.stamp.after, null);
  assert.match(r.result.error, /^left: the stamp/);
  const lines = r.text.split("\n");
  const k = lines.indexOf(WRITE_CMD);
  assert.ok(k > 0 && lines[k - 1].endsWith(`${fromTerminalIn(fx.proj)}:`), r.text);
});

// [groom#4]
test("groom: every flow key cleared between the plan and the stamp: no flow.groomed_at is written, the run says the policy is not set, exit 1 (failure)", async () => {
  for (const after of [{}, { spec_policy: "optional", flow: {} }]) {
    const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: daysAgo(12) }) } });
    const r = await direct(fx, { write: true }, { beforeStamp: () => writeFileSync(configOf(fx), js(after)) });
    assert.equal(r.code, 1, r.text);
    assert.deepEqual(cfgOf(fx), after);
    assert.equal(r.result.stamp.written, false);
    assert.match(r.result.error, /flow policy is not set/);
    assert.match(r.text, /flow policy is not set/);
  }
});

// ─── Contract 5: epics ─────────────────────────────────────────────────

const twoEpics = (flow = { age_days: { todo: 10 } }) =>
  vault({
    flow,
    stories: {
      "PS-A/story-one": planned("story-one", { epic: "PS-A" }),
      "PS-X/story-old": inTodo("story-old", { at: daysAgo(12) }),
      "PS-X/story-new": inProgress("story-new", { at: daysAgo(2) }),
    },
  });

// [groom#5]
test("groom: an epic with one planned story and an epic with two open stories, one stale: the stale one is planned, single_story holds the first epic, active lists both, count 2, cap null, the stamp set", async () => {
  const fx = twoEpics();
  const r = await direct(fx, { write: true });
  assert.equal(r.code, 0, r.text);
  assert.equal(fm(pathOf(fx, "story-old")).status, "planned");
  assert.match(lastLine(pathOf(fx, "story-old")), / \(groom\)$/);
  const { single_story, active } = r.result.epics;
  assert.deepEqual(single_story, [
    {
      epic: "PS-A",
      path: "epics/PS-A/epic.md",
      title: "PS-A",
      status: "in-progress",
      story: { ref: "PS-A/story-one", status: "planned" },
    },
  ]);
  assert.deepEqual(
    active.epics.map((e) => e.epic),
    ["PS-A", "PS-X"],
  );
  assert.equal(active.count, 2);
  assert.equal(active.cap, null);
  assert.equal(active.over, false);
  assert.equal(cfgOf(fx).flow.groomed_at, NOW);
});

// [groom#5]
test("groom: that vault with no flow.active_epics_max, bare: active is count 2, cap null, over false, and single_story still holds the first epic (edge)", async () => {
  const fx = twoEpics();
  const r = await groom(fx, [], { json: true });
  const { single_story, active } = r.json.result.epics;
  assert.deepEqual({ count: active.count, cap: active.cap, over: active.over }, { count: 2, cap: null, over: false });
  assert.deepEqual(
    single_story.map((e) => e.epic),
    ["PS-A"],
  );
  const text = await groom(fx);
  assert.match(text.out, /^2 active epics, no cap set \(flow\.active_epics_max\)\.$/m);
  assert.match(text.out, /^ {2}PS-A — PS-A: PS-A\/story-one \(planned\)$/m);
});

// [groom#5]
test("groom: flow.active_epics_max of 2 and three active epics gives over true and a text naming 3 and 2; a cap of 3 gives over false (edge)", async () => {
  const fx = vault({
    flow: { active_epics_max: 2 },
    stories: {
      "PS-A/story-a": planned("story-a", { epic: "PS-A" }),
      "PS-B/story-b": planned("story-b", { epic: "PS-B" }),
      "PS-C/story-c": planned("story-c", { epic: "PS-C" }),
    },
  });
  const over = await direct(fx);
  assert.equal(over.result.epics.active.over, true);
  assert.equal(over.result.epics.active.count, 3);
  assert.match(over.text, /^3 active epics, cap 2 \(flow\.active_epics_max\): over the cap by 1\.$/m);
  writeFileSync(configOf(fx), js({ flow: { active_epics_max: 3 } }));
  const at = await direct(fx);
  assert.equal(at.result.epics.active.over, false);
  assert.match(at.text, /^3 active epics, cap 3 \(flow\.active_epics_max\)\.$/m);
});

// [groom#5]
test("groom: a one-story epic under epics/_templates/, an epic whose stories are all done, and a deferred epic with one open story: none in single_story, none active (edge)", async () => {
  const fx = vault({
    stories: {
      "_templates/story-t": planned("story-t", { epic: "_templates" }),
      "PS-D/story-d1": planned("story-d1", { epic: "PS-D", status: "done" }),
      "PS-D/story-d2": planned("story-d2", { epic: "PS-D", status: "done" }),
      "PS-F/story-f": planned("story-f", { epic: "PS-F" }),
    },
  });
  setEpicStatus(fx, "PS-F", "deferred");
  const r = await direct(fx);
  assert.deepEqual(r.result.epics.single_story, []);
  assert.deepEqual(r.result.epics.active, { epics: [], count: 0, cap: null, over: false });
});

// ─── Contract 6: doctor, grooming and epics ─────────────────────────────

// [groom#6]
test("doctor: flow.grooming_days of 7 and flow.groomed_at 7 days before the as-of instant gives one grooming-due with npx projectstore groom alone after a colon; 6 days gives none (edge)", () => {
  const fx = vault({ flow: { grooming_days: 7, groomed_at: daysAgo(7) } });
  const due = byCheck(doctorRun(fx), "grooming-due");
  assert.equal(due.length, 1);
  assert.equal(due[0].level, "info");
  const lines = due[0].message.split("\n");
  assert.equal(lines[lines.length - 1], packageCommand([], "groom"));
  assert.equal(lines[lines.length - 1], "npx projectstore groom");
  assert.ok(lines[lines.length - 2].endsWith(`${fromTerminalIn(fx.proj)}:`), due[0].message);
  assert.match(due[0].message, new RegExp(dayOf(daysAgo(7))));
  writeFileSync(configOf(fx), js({ flow: { grooming_days: 7, groomed_at: daysAgo(6) } }));
  assert.equal(byCheck(doctorRun(fx), "grooming-due").length, 0);
});

// [groom#6]
test("doctor: only flow.grooming_days with no flow.groomed_at, then with flow.groomed_at of soon: one grooming-due each, saying there is no stamp, then that it does not read (edge)", () => {
  const fx = vault({ flow: { grooming_days: 7 } });
  const none = byCheck(doctorRun(fx), "grooming-due");
  assert.equal(none.length, 1);
  assert.match(none[0].message, /holds no stamp/);
  writeFileSync(configOf(fx), js({ flow: { grooming_days: 7, groomed_at: "soon" } }));
  const soon = byCheck(doctorRun(fx), "grooming-due");
  assert.equal(soon.length, 1);
  assert.match(soon[0].message, /does not read as a date/);
  assert.ok(!soon[0].message.includes("soon"), "the value is not named");
});

// [groom#6]
test("doctor: a vault where doctor reports grooming-due reports none after groom --write", async () => {
  const fx = vault({ flow: { grooming_days: 7 } });
  const now = () => new Date().toISOString();
  assert.equal(byCheck(doctorRun(fx, { now: now() }), "grooming-due").length, 1);
  const r = await groom(fx, ["--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(byCheck(doctorRun(fx, { now: now() }), "grooming-due").length, 0);
});

// [groom#6]
test("doctor: flow.active_epics_max of 2 and three active epics, one a one-story epic: one epic-single-story with its file and one active-epics-over-cap naming 3 and 2; two active epics give no over-cap (edge)", () => {
  const fx = vault({
    flow: { active_epics_max: 2 },
    stories: {
      "PS-A/story-a": planned("story-a", { epic: "PS-A" }),
      "PS-B/story-b1": planned("story-b1", { epic: "PS-B" }),
      "PS-B/story-b2": planned("story-b2", { epic: "PS-B" }),
      "PS-C/story-c1": planned("story-c1", { epic: "PS-C" }),
      "PS-C/story-c2": planned("story-c2", { epic: "PS-C", status: "done" }),
    },
  });
  const found = doctorRun(fx);
  const single = byCheck(found, "epic-single-story");
  assert.equal(single.length, 1, js(ids(found)));
  assert.equal(single[0].file, "epics/PS-A/epic.md");
  assert.equal(single[0].level, "info");
  assert.match(single[0].message, /PS-A\/story-a/);
  assert.match(single[0].message, /\/projectstore:groom/);
  assert.match(single[0].message, /librarian/);
  const over = byCheck(found, "active-epics-over-cap");
  assert.equal(over.length, 1);
  assert.equal(over[0].level, "warn");
  assert.match(over[0].message, /^3 epics are active, 1 more than the cap of 2 \(flow\.active_epics_max\)/);
  setEpicStatus(fx, "PS-C", "parked");
  assert.equal(byCheck(doctorRun(fx), "active-epics-over-cap").length, 0);
});

// [groom#6]
test("doctor: a one-story epic, with flow.grooming_days set and no flow.active_epics_max, gets no epic-single-story and no active-epics-over-cap (edge)", () => {
  const fx = vault({
    flow: { grooming_days: 7 },
    stories: { "PS-A/story-a": planned("story-a", { epic: "PS-A" }) },
  });
  const found = ids(doctorRun(fx));
  assert.ok(!found.includes("epic-single-story") && !found.includes("active-epics-over-cap"), js(found));
  assert.ok(found.includes("grooming-due"));
});

// [groom#6]
test("doctor: no flow block reports only flow-policy-unset; with all three findings due, doctor --startup reports none of them (edge)", async () => {
  const stories = {
    "PS-A/story-a": planned("story-a", { epic: "PS-A" }),
    "PS-B/story-b": planned("story-b", { epic: "PS-B" }),
  };
  assert.deepEqual(ids(doctorRun(vault({ flow: null, stories }))), ["flow-policy-unset"]);
  const fx = vault({ flow: { grooming_days: 7, active_epics_max: 1 }, stories });
  const all = ids(doctorRun(fx));
  for (const c of ["grooming-due", "epic-single-story", "active-epics-over-cap"]) assert.ok(all.includes(c), c);
  const { runStartupChecks } = await import("../scripts/doctor.mjs");
  const r = runStartupChecks(fx.cfg, fx.proj, 60000);
  for (const c of ["grooming-due", "epic-single-story", "active-epics-over-cap"])
    assert.ok(!r.findings.some((f) => f.check === c), c);
});

// ─── Contract 7: /projectstore:groom (verified: manual), text pins ─────

const COPIES = [
  "commands/groom.md",
  "adapters/codex/skills/projectstore-groom/SKILL.md",
  "packaging/shells/projectstore-codex/skills/projectstore-groom/SKILL.md",
];

// [groom#7]
test("commands/groom.md and its generated copies call the bin with declared flags only: the plan, then --write, then agents model librarian; ask once; the librarian only on a non-empty list; never npx", () => {
  for (const rel of COPIES) {
    const src = read(join(REPO, rel));
    const calls = [
      ...src.matchAll(
        /node "\$\{(?:CLAUDE_PLUGIN_ROOT|PROJECTSTORE_CORE_ROOT)\}\/bin\/projectstore\.mjs" (\S+)([^\n`]*)/g,
      ),
    ];
    assert.deepEqual(
      calls.map(([, verb, rest]) => `${verb}${rest.match(/^ model \S+/)?.[0] ?? ""}`),
      ["groom", "groom", "agents model librarian"],
      rel,
    );
    const declared = { groom: ["write", "json", "project"], agents: ["json", "project"] };
    for (const [, verb, rest] of calls) {
      for (const f of rest.matchAll(/--([a-z-]+)/g))
        assert.ok(declared[verb].includes(f[1]), `${rel}: ${verb} --${f[1]}`);
      assert.match(
        rest,
        rel.startsWith("commands/") ? /--project "\$\{CLAUDE_PROJECT_DIR\}"/ : /--project "\$PWD"/,
        rel,
      );
      assert.match(rest, /--json/, rel);
    }
    assert.ok(!/--write/.test(calls[0][2]) && /--write/.test(calls[1][2]), `${rel}: the plan first, then --write`);
    assert.ok(!/npx /.test(src), `${rel}: never npx`);
    assert.ok(!/projectstore:clerk|projectstore-clerk/.test(src), `${rel}: no clerk runs`);
    assert.match(src, /Ask once/);
    assert.match(src, /\*\*Apply\*\* \/ \*\*Cancel\*\*/);
    assert.match(src, /flow\.groomed_at` is written also when no story moves/);
    assert.match(src, /how many epics go to the librarian/);
    assert.match(src, /only when `result\.epics\.single_story` of the `--write` run is not empty/);
    assert.match(src, /also after an exit 1/);
    assert.match(src, /(projectstore:librarian|\$projectstore-librarian)` once/);
    assert.match(src, /first line is `Epic list:` followed by a JSON block of the `--write` run's `result\.epics`/);
    assert.match(src, /On Cancel, nothing is written and no librarian runs/);
  }
});

// [groom#7]
test("agents/librarian.md and its copies: on a prompt headed Epic list: the Epic merges lens instead of the sweep, no doctor, one verdict per candidate, still read-only", () => {
  for (const rel of [
    "agents/librarian.md",
    "adapters/codex/skills/projectstore-librarian/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-librarian/SKILL.md",
  ]) {
    const src = read(join(REPO, rel));
    const lens = src.slice(src.indexOf("## Epic merges"), src.indexOf("## Sweep"));
    assert.ok(lens.length > 100, `${rel}: the lens comes before the sweep`);
    assert.match(lens, /first line is `Epic list:`/);
    assert.match(lens, /instead of the standing\s+Sweep, Self-audit and Output below/);
    assert.match(lens, /only output/);
    assert.match(lens, /run no doctor/);
    assert.match(lens, /one verdict, and only one/);
    assert.match(lens, /\*\*Absorb\*\*/);
    assert.match(lens, /\*\*Keep\*\*/);
    assert.match(lens, /graph\.md/);
    assert.match(lens, /read-only and\s+suggest-only/);
  }
  assert.match(
    read(join(REPO, "agents", "librarian.md")),
    /^tools: Read, Grep, Glob, Bash$/m,
    "its tools stay read-only",
  );
});

// ─── Contract 8: what reaches it, and what it starts ───────────────────

// [groom#8]
test("groom: no hook entry and no MCP module reaches scripts/groom.mjs; the bin's table does, through an import() in its handler", async () => {
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  assert.ok(!Object.hasOwn(READ_HANDLERS, "groom"), "the read runner does not serve groom");
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
    assert.ok(!closure(entry, { root: REPO, dispatch }).includes("scripts/groom.mjs"), `${entry} reaches groom.mjs`);
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/groom.mjs"));
  assert.match(read(join(REPO, "scripts", "cli.mjs")), /await import\("\.\/groom\.mjs"\)/);
  const src = read(join(REPO, "scripts", "groom.mjs")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /child_process|spawn|fetch\(|node:https?/, "groom.mjs starts nothing of its own");
});

// [groom#8]
test("groom: with no git and no gh on the PATH, --write moves a stale story, stamps, refreshes the views and exits 0 (edge)", () => {
  const fx = vault({ stories: { "PS-X/story-a": inTodo("story-a", { at: ago(12) }) } });
  const empty = mkdtempSync(join(tmpdir(), "ps-groom-path-"));
  const r = spawnSync(process.execPath, [BIN, "groom", "--write", "--json", "--project", fx.proj], {
    cwd: fx.proj,
    env: { ...process.env, PATH: empty, CI: "1" },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout).result;
  assert.ok(res.reconcile, "the views were refreshed");
  assert.equal(res.stamp.written, true);
  assert.equal(fm(pathOf(fx, "story-a")).status, "planned");
  assert.notEqual(read(join(fx.vault, "kanban.md")), "stub board\n");
});

// [groom#8]
test("groom: commands/groom.md and its generated copies exist; the row writes, needs a binding and has no MCP tool; README names the verb and the command (edge)", () => {
  for (const rel of COPIES) assert.ok(existsSync(join(REPO, rel)), rel);
  const row = VERBS.find((v) => v.verb === "groom");
  assert.equal(row.writes, true);
  assert.equal(row.requiresBinding, true);
  assert.deepEqual(row.mcp, []);
  assert.equal(row.module, "./groom.mjs");
  const readme = read(join(REPO, "README.md"));
  assert.match(readme, /`groom`[^\n]*\n\n```\nnpx projectstore groom --write\n```\n\n[^\n]*`\/projectstore:groom`/);
  const at = readme.indexOf("npx projectstore groom --write");
  assert.ok(at > readme.indexOf("npx projectstore move ") && at - readme.indexOf("npx projectstore move ") < 2000);
});

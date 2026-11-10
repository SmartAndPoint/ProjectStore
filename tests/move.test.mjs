// projectstore — tests/move.test.mjs: the `move` verb, a story between the
// backlog and ToDo (PS-FLOW, "Every status change is stamped and logged in the
// story, and a command moves a story between the backlog and ToDo"). Run in
// process through the bin's run(), on a bound fixture vault; doctor runs as
// the bin does, in its own process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { run } from "../scripts/cli.mjs";
import { parseStatusLog, statusStamp } from "../scripts/status-log.mjs";
import { parseFrontmatter, loadTemplate, renderTemplate } from "../scripts/lib.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VARS = { id: "story-a", title: "A", date: "2026-11-01", author: "Other", tags: "[]", epic_id: "PS-X" };
const STORY = renderTemplate(loadTemplate("en", "story"), VARS);
const EPIC = `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-11-01\n---\n\n# PS-X: X\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [a](./stories/story-a.md) | planned | the a |\n`;

function seed(status = "planned") {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
  writeFileSync(path, STORY.replace("status: planned", `status: ${status}`));
  writeFileSync(join(vault, "epics", "PS-X", "epic.md"), EPIC);
  // Derived views that exist, so a stale one is a finding.
  writeFileSync(join(vault, "kanban.md"), "stub board\n");
  writeFileSync(join(vault, "graph.md"), "stub graph\n");
  return { proj, vault, path, epic: join(vault, "epics", "PS-X", "epic.md") };
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

async function move(proj, args, { ask = null, json = false } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["move", ...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}

// The vault's stale-view findings, as `doctor --vault` reports them.
function staleViews(proj) {
  const r = spawnSync(
    process.execPath,
    [join(REPO, "bin", "projectstore.mjs"), "doctor", "--vault", "--json", "--project", proj],
    {
      encoding: "utf8",
      timeout: 60000,
    },
  );
  return JSON.parse(r.stdout).result.filter(
    (f) => ["kanban", "graph", "code-map", "index"].includes(f.check) && f.level !== "info",
  );
}

// [SPEC-001#7]
test("move: a planned story goes to todo with a stamp, a (move) line, its epic row, and no stale view", async () => {
  const { proj, path, epic } = seed();
  assert.ok(staleViews(proj).length > 0, "the stub views are stale before the move (control)");
  const plan = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up"]);
  assert.equal(plan.code, 0, plan.err);
  assert.match(plan.out, /Move PS-X\/story-a: planned → todo — next up \(move\)/);
  assert.match(plan.out, /^ {2}npx projectstore move PS-X\/story-a todo --reason 'next up' --write$/m);
  assert.match(plan.out, /^ {2}\/projectstore:story ready PS-X\/story-a$/m);
  assert.equal(parseFrontmatter(readFileSync(path, "utf8")).data.status, "planned", "a plan writes nothing");

  const r = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(path, "utf8");
  const fm = parseFrontmatter(text).data;
  assert.equal(fm.status, "todo");
  assert.ok(fm.status_changed_at);
  assert.equal(String(fm.updated), new Date().toISOString().slice(0, 10), "updated is bumped");
  const log = parseStatusLog(text);
  assert.equal(log.length, 1);
  assert.equal(log[0].line, `- ${fm.status_changed_at} status: planned → todo — next up (move)`);
  assert.match(text, /\| \*\*Status\*\* \| todo \|/);
  assert.equal(statusStamp(text).trusted, true);
  assert.match(readFileSync(epic, "utf8"), /\| \[a\]\(\.\/stories\/story-a\.md\) \| todo \| the a \|/);
  assert.deepEqual(staleViews(proj), [], "doctor reports no stale derived view");
  // A hand edit of status afterwards makes the stamp untrusted.
  writeFileSync(path, text.replace("status: todo", "status: in-progress"));
  assert.equal(statusStamp(readFileSync(path, "utf8")).trusted, false);
});

// [SPEC-001#7]
test("move: todo back to planned, and a target equal to the status is no line but still refreshes the row and views", async () => {
  const { proj, path, epic } = seed("todo");
  const back = await move(proj, ["PS-X/story-a", "planned", "--reason", "not this week", "--write"], { json: true });
  assert.equal(back.code, 0, back.err);
  assert.equal(back.json.result.line.endsWith("status: todo → planned — not this week (move)"), true);
  assert.equal(parseFrontmatter(readFileSync(path, "utf8")).data.status, "planned");
  // The epic row says planned already; make it stale, then move to the same status.
  writeFileSync(epic, EPIC.replace("| planned | the a |", "| todo | the a |"));
  const before = readFileSync(path, "utf8");
  const same = await move(proj, ["PS-X/story-a", "planned", "--reason", "again", "--write"], { json: true });
  assert.equal(same.code, 0, same.err);
  assert.equal(same.json.result.line, null);
  assert.equal(readFileSync(path, "utf8"), before, "the story is not written");
  assert.match(readFileSync(epic, "utf8"), /\| planned \| the a \|/, "the row is refreshed");
  assert.deepEqual(staleViews(proj), []);
  const bare = await move(proj, ["PS-X/story-a", "planned", "--reason", "again"]);
  assert.equal(bare.code, 0);
  assert.match(bare.out, /is already planned/);
});

// [SPEC-001#7]
test("move: from or to any other status is refused with exit 1, naming the gate, and writes nothing", async () => {
  const cases = [
    ["todo", "in-progress", /plan gate[\s\S]*\/projectstore:story plan PS-X\/story-a/],
    ["planned", "done", /close gate[\s\S]*\/projectstore:story close PS-X\/story-a/],
    ["in-progress", "todo", /no gate moves a story from in-progress to todo/],
    ["review", "planned", /no gate moves a story from review to planned/],
    ["planned", "review", /no gate moves a story from planned to review/],
    ["planned", "parked", /no gate moves a story from planned to parked/],
    ["done", "done", /close gate/],
    ["parked", "parked", /no gate moves a story from parked to parked/],
  ];
  for (const [from, to, re] of cases) {
    const { proj, path, epic } = seed(from);
    const before = readFileSync(path, "utf8");
    const r = await move(proj, ["PS-X/story-a", to, "--reason", "why", "--write"]);
    assert.equal(r.code, 1, `${from} → ${to}: ${r.out}${r.err}`);
    assert.match(r.err, re, `${from} → ${to}`);
    assert.equal(readFileSync(path, "utf8"), before, `${from} → ${to}: nothing written`);
    assert.equal(readFileSync(epic, "utf8"), EPIC);
  }
});

// [SPEC-001#7]
test("move: no --reason, a blank or multi-line one, a missing argument or a word that is no status is exit 2 and writes nothing", async () => {
  const { proj, path } = seed();
  const before = readFileSync(path, "utf8");
  for (const args of [
    ["PS-X/story-a", "todo", "--write"],
    ["PS-X/story-a", "todo", "--reason", "", "--write"],
    ["PS-X/story-a", "todo", "--reason", "   ", "--write"],
    ["PS-X/story-a", "todo", "--reason", "one\ntwo", "--write"],
    ["PS-X/story-a", "--reason", "x", "--write"],
    ["PS-X/story-a", "soon", "--reason", "x", "--write"],
  ]) {
    const r = await move(proj, args, { json: true });
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.err}`);
    assert.equal(r.json.ok, false);
  }
  assert.equal(readFileSync(path, "utf8"), before);
});

// [SPEC-001#7]
test("move: a story that names none or several is exit 1", async () => {
  const { proj, vault } = seed();
  assert.equal((await move(proj, ["PS-X/story-nope", "todo", "--reason", "x"])).code, 1);
  assert.equal((await move(proj, ["story-a", "todo", "--reason", "x"])).code, 1);
  // Two stories at one tier: the frontmatter id of one is the other's.
  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-b.md"), STORY);
  const two = await move(proj, ["PS-X/story-a", "todo", "--reason", "x"]);
  assert.equal(two.code, 1);
  assert.match(two.err, /names 2 stories/);
});

// [SPEC-001#7]
test("move: at a terminal a no writes nothing (exit 1), a yes writes; --json asks nothing", async () => {
  const { proj, path } = seed();
  const asked = [];
  const no = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"], {
    ask: async (q) => (asked.push(q), "n"),
  });
  assert.equal(no.code, 1);
  assert.match(no.out + no.err, /Nothing written\./);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Apply 1 change\?/);
  assert.equal(parseFrontmatter(readFileSync(path, "utf8")).data.status, "planned");
  const yes = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"], { ask: async () => "y" });
  assert.equal(yes.code, 0, yes.err);
  assert.equal(parseFrontmatter(readFileSync(path, "utf8")).data.status, "todo");
  const { proj: p2, path: s2 } = seed();
  const never = [];
  const json = await move(p2, ["PS-X/story-a", "todo", "--reason", "next up", "--write"], {
    ask: async (q) => (never.push(q), "n"),
    json: true,
  });
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(never, []);
  assert.equal(json.json.result.written, true);
  assert.equal(parseFrontmatter(readFileSync(s2, "utf8")).data.status, "todo");
});

// [SPEC-001#7]
test("move: an epic with a list is epic-row-missing, exit 0, and the epic is left", async () => {
  const { proj, epic } = seed();
  const list = EPIC.replace(/\| Story[\s\S]*$/, "1. [a](./stories/story-a.md) — planned\n");
  writeFileSync(epic, list);
  const r = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.result.epic.note, "epic-row-missing");
  assert.equal(readFileSync(epic, "utf8"), list);
});

// [SPEC-001#7]
test("move: one edit meanwhile lands under the change (exit 0); an edit before each of three replaces is story-changed-meanwhile (exit 1)", async () => {
  const { runMove } = await import("../scripts/move.mjs");
  const ctxFor = (proj, afterCompute) => ({
    values: { reason: "next up", write: true },
    positionals: ["PS-X/story-a", "todo"],
    cfg: JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8")),
    project: proj,
    env: process.env,
    afterCompute,
  });
  const once = seed();
  const r = await runMove(
    ctxFor(once.proj, (i) => {
      if (i === 0) writeFileSync(once.path, readFileSync(once.path, "utf8").replace("# A", "# A (edited)"));
    }),
  );
  assert.equal(r.code, 0, r.text);
  const text = readFileSync(once.path, "utf8");
  assert.ok(text.includes("# A (edited)") && /^status: todo$/m.test(text));
  const each = seed();
  let last = null;
  const d = await runMove(
    ctxFor(each.proj, (i) => {
      last = readFileSync(each.path, "utf8") + `\nedit ${i}\n`;
      writeFileSync(each.path, last);
    }),
  );
  assert.equal(d.code, 1);
  assert.match(d.text, /story-changed-meanwhile/);
  assert.equal(readFileSync(each.path, "utf8"), last, "the file is as the last editor left it");
  assert.equal(readFileSync(each.epic, "utf8"), EPIC, "the epic is not written");
});

// [SPEC-001#7]
test("commands/story.md: ready in the hint and the dispatch, the Ready flow through move, step 6d on both gates, the no-edit rule", () => {
  const t = readFileSync(join(REPO, "commands", "story.md"), "utf8");
  const flat = (s) => s.replace(/\s+/g, " ");
  assert.match(t, /^argument-hint: .*\| ready <story>$/m);
  assert.match(t, /^argument-hint: .*\[--variant test\]/m);
  assert.match(flat(t), /is `plan`, `close` or `ready`/);
  const ready = t.slice(t.indexOf("# Ready flow"));
  assert.ok(t.indexOf("# Lifecycle gate flow") < t.indexOf("# Ready flow"));
  assert.match(
    ready,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/projectstore\.mjs" move "<EPIC>\/<story-id>" todo --reason '<reason>' --project "\$\{CLAUDE_PROJECT_DIR\}"/,
  );
  for (const needle of [
    "AskUserQuestion",
    "`--write --json`",
    "is the confirmation",
    "`story-changed-meanwhile`",
    "There is no clerk",
  ])
    assert.ok(
      flat(t.slice(t.indexOf("`ready <story>` puts"))).includes(needle) || flat(ready).includes(needle),
      needle,
    );
  const d6 = t.slice(t.indexOf("6d."), t.indexOf("# Ready flow"));
  assert.match(d6, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/status-change\.mjs" epic-row "<story-path>"/);
  assert.match(flat(d6), /\(both gates\)/);
  assert.match(flat(d6), /idempotent/);
  assert.match(flat(d6), /`epic-row-missing`, exit 0/);
  assert.match(flat(d6), /never undoes the gate's write/);
  assert.match(flat(t), /skip steps 6-6b and run step 6c, then step 6d/);
  assert.match(flat(t), /perform steps 6-6c yourself, then 6d/);
  assert.match(flat(t), /Do not edit the stamps, the header table or the Status log in the returned content/);
  assert.match(flat(t), /timestamps of Status log lines differ between runs; that is not a divergence/);
});

// [SPEC-001#7]
test(
  "move: an epic write that fails after the story write is exit 1 naming what is left; a second run finishes it",
  {
    skip: process.getuid?.() === 0 ? "root ignores a read-only directory" : false,
  },
  async () => {
    const { proj, path, epic } = seed();
    const epicDir = dirname(epic);
    chmodSync(epicDir, 0o555); // epic.md's own folder: the atomic replace cannot make its temp
    let first;
    try {
      first = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"]);
    } finally {
      chmodSync(epicDir, 0o755);
    }
    assert.equal(first.code, 1, first.out + first.err);
    assert.match(first.err, /the story was written, but its row in the epic's Stories table \(.+\) is left/);
    assert.match(first.err, /npx projectstore move PS-X\/story-a todo --reason 'next up' --write/);
    assert.equal(parseFrontmatter(readFileSync(path, "utf8")).data.status, "todo");
    assert.equal(readFileSync(epic, "utf8"), EPIC, "the epic is as it was");
    const second = await move(proj, ["PS-X/story-a", "todo", "--reason", "next up", "--write"]);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /already todo: no line written/);
    assert.match(readFileSync(epic, "utf8"), /\| \[a\]\(\.\/stories\/story-a\.md\) \| todo \| the a \|/);
    assert.equal(parseStatusLog(readFileSync(path, "utf8")).length, 1, "one log line");
  },
);

// [SPEC-001#7]
test("move: the refusal is judged again on the fresh bytes — a story started meanwhile is refused and left", async () => {
  const { runMove } = await import("../scripts/move.mjs");
  const { proj, path, epic } = seed();
  let edited = null;
  const r = await runMove({
    values: { reason: "next up", write: true },
    positionals: ["PS-X/story-a", "todo"],
    cfg: JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8")),
    project: proj,
    env: process.env,
    afterCompute: (i) => {
      if (i === 0) {
        edited = readFileSync(path, "utf8").replace("status: planned", "status: in-progress");
        writeFileSync(path, edited);
      }
    },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /no gate moves a story from in-progress to todo/);
  assert.equal(readFileSync(path, "utf8"), edited, "the writer left the file as the edit made it");
  assert.equal(readFileSync(epic, "utf8"), EPIC);
});

// [SPEC-001#7]
test("move: a target that is an Object prototype key is no status word: exit 2", async () => {
  const { proj, path } = seed();
  const before = readFileSync(path, "utf8");
  for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const r = await move(proj, ["PS-X/story-a", word, "--reason", "x", "--write"]);
    assert.equal(r.code, 2, `${word}: ${r.err}`);
    assert.match(r.err, /is not a status/);
    assert.ok(!/function Object/.test(r.err + r.out), word);
  }
  assert.equal(readFileSync(path, "utf8"), before);
});

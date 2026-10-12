// projectstore — the band above the prompt: every rule it draws by, in node.
//
// The band is a Claude Code hooks module (hooks/band.tsx), which runs only
// under the host. Its rules live in Node-free files (scripts/stages.mjs,
// scripts/band-shared.mjs) so CI tests them here without a host; the module's
// own plumbing is tested through `claude plugin test` (tests/band/, run by
// tests/band-module.test.mjs).
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield (contract numbers in each test's name).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findStories, statusToColumn } from "../scripts/kanban.mjs";
import { listEpicStories, layoutPaths, pointerPatchFor, storyFileFor } from "../scripts/lib.mjs";
import { invocation, sourceHarness } from "../scripts/harness.mjs";
import { foldStages, stageOf, parseFrontmatter, NOT_ACTIONABLE } from "../scripts/stages.mjs";
import {
  BAND_STRING_KEYS,
  mergeWords,
  goalForms,
  goalOf,
  storyFiles,
  isEpicName,
  cellWidth,
  planRows,
  countsText,
  segments,
  progressLayout,
  storyLayout,
  storyKeyOf,
  storyIsCurrent,
  BAR_MIN,
  BAR_MAX,
  modelLabel,
  subjectPath,
  subjectLabel,
  phraseOf,
  commandWord,
  stepOf,
  leadAgent,
  LINGER_MS,
  heartbeatNext,
} from "../scripts/band-shared.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP = [];
after(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  TEMP.push(d);
  return d;
};

const EN = JSON.parse(readFileSync(join(ROOT, "templates", "en", "strings.json"), "utf8"));
const W = mergeWords(EN, null);
const nodeFs = {
  list: (dir) =>
    readdirSync(dir).map((name) => ({ name, kind: statSync(join(dir, name)).isDirectory() ? "dir" : "file" })),
  exists: (p) => existsSync(p) && statSync(p).isFile(),
};

// ─── Contract 9: stages, the board's own ───────────────────────────────

test("contract 9: the band's stages equal kanban.md's columns for one epic, every status and story shape", async () => {
  const vault = tmp("ps-band-parity-");
  const epic = join(vault, "epics", "PS-X");
  mkdirSync(join(epic, "stories", "folder-story"), { recursive: true });
  writeFileSync(join(epic, "epic.md"), '---\ntype: epic\nid: "PS-X"\n---\n');
  const statuses = [
    "done",
    "Closed",
    "in-progress",
    "IN_PROGRESS",
    "in progress",
    "review",
    "planned",
    "todo",
    "To-Do",
    "superseded",
    "deferred",
    "Parked",
    null,
    "blocked",
    "something-else",
  ];
  statuses.forEach((st, i) =>
    writeFileSync(
      join(epic, "stories", `s${String(i).padStart(2, "0")}.md`),
      `---\ntype: story\nepic: "PS-X"\ntitle: "S${i}"\n${st === null ? "" : `status: ${st}\n`}---\n`,
    ),
  );
  writeFileSync(join(epic, "stories", "folder-story", "README.md"), '---\nepic: "PS-X"\nstatus: review\n---\n');
  writeFileSync(join(epic, "story-beside.md"), '---\nepic: "PS-X"\nstatus: DONE\n---\n');

  const board = { Done: 0, "In Progress": 0, Review: 0, ToDo: 0, Backlog: 0 };
  for (const s of findStories(vault, "epics").stories) board[statusToColumn(s.status)]++;

  const files = await storyFiles(nodeFs, epic);
  assert.deepEqual(
    files.sort(),
    listEpicStories(epic)
      .map((s) => s.abs)
      .sort(),
    "the band lists the files the board lists",
  );
  const band = foldStages(files.map((f) => parseFrontmatter(readFileSync(f, "utf8")).data.status));
  assert.deepEqual(band, {
    done: board.Done,
    active: board["In Progress"] + board.Review,
    backlog: board.Backlog + board.ToDo,
  });
  assert.deepEqual(band, { done: 3, active: 5, backlog: 5 });
});

test("contract 9: a story's stage — lower-cased, not-actionable and missing count nowhere", () => {
  assert.equal(stageOf("DONE"), "done");
  assert.equal(stageOf("Review"), "active");
  assert.equal(stageOf("ToDo"), "backlog");
  assert.equal(stageOf("cancelled"), "backlog", "the board files an unknown status under Backlog");
  for (const s of [...NOT_ACTIONABLE, "Superseded", null, undefined, ""]) assert.equal(stageOf(s), null, String(s));
});

// ─── Contract 7: the goal ──────────────────────────────────────────────

test("contract 7: the goal is the first paragraph under the language's goal heading, every bundled locale", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "scaffold", "headings.json"), "utf8"));
  for (const lang of readdirSync(join(ROOT, "templates")).filter((d) =>
    existsSync(join(ROOT, "templates", d, "epic.md.tmpl")),
  )) {
    const tmpl = readFileSync(join(ROOT, "templates", lang, "epic.md.tmpl"), "utf8");
    const heading = tmpl.split("\n").find((l) => goalForms(registry, lang).some((f) => l === `## ${f}`));
    assert.ok(heading, `${lang}: the epic template's goal heading is in the registry`);
    const epic = `---\ntitle: x\n---\n\n${heading}\n\n<!-- a template comment -->\nShip **it** as [[a|one]] [b](c) \`d\`,\n  done.\n\nMore.\n\n## Next\n`;
    assert.equal(goalOf(epic, goalForms(registry, lang)), "Ship it as one b d, done.", lang);
  }
  assert.equal(goalOf("## Goal\n\n## Stories\n", ["Goal"]), "");
  assert.equal(goalOf("## Context\n\ntext\n", ["Goal"]), "");
  assert.deepEqual(goalForms(registry, "xx"), ["Goal"], "an unknown language reads English");
});

// ─── Contracts 3, 5: rows, width, the bar ──────────────────────────────

test("contract 3: rows fill by priority, a row without content frees its slot, drawn in order", () => {
  const all = { head: true, progress: true, goal: true, story: true, agent: true };
  assert.deepEqual(planRows(all, 1), ["head"]);
  assert.deepEqual(planRows(all, 2), ["head", "progress"]);
  assert.deepEqual(planRows(all, 3), ["head", "goal", "progress"]);
  assert.deepEqual(planRows(all, 4), ["head", "goal", "progress", "story"]);
  assert.deepEqual(planRows(all, 5), ["head", "goal", "progress", "story", "agent"]);
  assert.deepEqual(planRows({ ...all, goal: false }, 3), ["head", "progress", "story"]);
  assert.deepEqual(planRows({ ...all, goal: false, story: false }, 3), ["head", "progress", "agent"]);
});

test("contract 5: display width counts wide characters as two cells", () => {
  assert.equal(cellWidth("abc"), 3);
  assert.equal(cellWidth("📚 x"), 4);
  assert.equal(cellWidth("目标"), 4);
  assert.equal(cellWidth("é"), 1, "a combining mark takes no cell of its own");
  assert.equal(cellWidth("é"), 1);
});

test("contract 5: the counts are never cut — the hint goes first, then the bar", () => {
  const c = { done: 8, active: 16, backlog: 14 };
  const counts = countsText(c, W);
  assert.equal(counts, "21%  8 done · 16 in work · 14 backlog · 38 stories");
  const hint = "· hide: /projectstore:bar off";
  const row = (lay) =>
    2 + 3 + (lay.bar ? lay.bar + 2 : 0) + cellWidth(counts) + (lay.hint ? cellWidth(`  ${hint}`) : 0);
  for (let cols = 30; cols <= 200; cols++) {
    const lay = progressLayout(counts, hint, cols);
    assert.ok(lay.bar === 0 || (lay.bar >= BAR_MIN && lay.bar <= BAR_MAX), `${cols}: bar ${lay.bar}`);
    if (lay.bar || lay.hint) assert.ok(row(lay) < cols, `${cols}: the row fits`);
    if (lay.hint) assert.ok(lay.bar >= BAR_MIN, `${cols}: the hint stays only beside a bar`);
  }
  assert.deepEqual(progressLayout(counts, hint, 200), { bar: BAR_MAX, hint: true });
  assert.equal(progressLayout(counts, hint, 70).hint, false);
  assert.equal(progressLayout(counts, null, 40).bar, 0);
  // zh: wide words leave the bar less room than their length says.
  const zh = mergeWords(EN, JSON.parse(readFileSync(join(ROOT, "templates", "zh", "strings.json"), "utf8")));
  const zc = countsText(c, zh);
  assert.ok(cellWidth(zc) > zc.length);
  assert.equal(progressLayout(zc, null, 80).bar, Math.min(BAR_MAX, 80 - 2 - 3 - 2 - cellWidth(zc) - 1));
});

test("contract 8: the story row cuts its title with an ellipsis and never its status, in en and zh", () => {
  const zh = mergeWords(EN, JSON.parse(readFileSync(join(ROOT, "templates", "zh", "strings.json"), "utf8")));
  const cases = [
    [W.band_story, "A closed story stops showing as this session's story on the band", "in-progress"],
    [zh.band_story, "关闭的故事不再显示为本会话的故事", "review"],
  ];
  for (const [label, title, status] of cases) {
    const tail = ` · ${status.replace(/[_-]/g, " ")}`;
    const row = (lay) => 3 + cellWidth(`${label} `) + cellWidth(lay.title) + cellWidth(lay.tail);
    for (let cols = 20; cols <= 200; cols++) {
      const lay = storyLayout(label, title, status, cols);
      assert.equal(lay.tail, tail, `${cols}: the status is whole`);
      if (lay.title === title) {
        assert.ok(row(lay) <= cols - 3, `${cols}: an uncut row fits bodyColumns − 3`);
        continue;
      }
      assert.ok(lay.title.endsWith("…"), `${cols}: a cut title ends in an ellipsis`);
      assert.ok(title.startsWith(lay.title.slice(0, -1)), `${cols}: the cut keeps the title's start`);
      if (lay.title !== "…") assert.ok(row(lay) <= cols - 3, `${cols}: a cut row fits bodyColumns − 3`);
      // The longest prefix that fits: one more character would not.
      const more = [...title].slice(0, [...lay.title].length).join("") + "…";
      assert.ok(row({ ...lay, title: more }) > cols - 3, `${cols}: ${JSON.stringify(more)} would not fit`);
    }
  }
  assert.deepEqual(storyLayout("story", "B story", "in_progress", 30), { title: "B s…", tail: " · in progress" });
  assert.deepEqual(storyLayout("story", "B story", "in_progress", 120), { title: "B story", tail: " · in progress" });
  assert.deepEqual(
    storyLayout("story", "B story", "in_progress", undefined),
    { title: "B story", tail: " · in progress" },
    "no width from the host: the title whole, the host truncates",
  );
});

test("contract 8: the pointer's writer and the band key every story shape alike", () => {
  const vault = tmp("ps-band-keys-");
  const epic = join(vault, "epics", "PS-X");
  mkdirSync(join(epic, "stories", "folder-story"), { recursive: true });
  const fm = (title) => `---\ntype: story\ntitle: "${title}"\nstatus: planned\n---\n`;
  writeFileSync(join(epic, "epic.md"), '---\ntype: epic\ntitle: "X"\n---\n');
  writeFileSync(join(epic, "stories", "story-flat.md"), fm("Flat"));
  writeFileSync(join(epic, "stories", "folder-story", "README.md"), fm("Folder"));
  writeFileSync(join(epic, "story-beside.md"), fm("Beside"));
  const shapes = {
    "stories/story-flat.md": "story-flat",
    "stories/folder-story/README.md": "folder-story",
    "story-beside.md": "story-beside",
  };
  for (const [rel, key] of Object.entries(shapes)) {
    assert.equal(storyKeyOf(rel), key, `the band's key for ${rel}`);
    const patch = pointerPatchFor(vault, join(epic, rel), null);
    assert.equal(patch.active_story, key, `the writer's key for ${rel}`);
    assert.equal(storyFileFor(vault, "PS-X", key), join(epic, rel), `the key finds ${rel} again`);
  }
  for (const rel of ["epic.md", "stories/notes/other.md", "README.md"]) assert.equal(storyKeyOf(rel), null, rel);
});

test("contract 8: a story is this session's only while it stages as in work or backlog", () => {
  for (const s of ["in-progress", "in_progress", "review", "planned", "todo", "blocked"])
    assert.equal(storyIsCurrent(s), true, s);
  for (const s of ["done", "Closed", "superseded", "deferred", "parked", null, ""])
    assert.equal(storyIsCurrent(s), false, String(s));
});

test("contract 5: segments split the bar by stage", () => {
  assert.deepEqual(segments({ done: 1, active: 2, backlog: 1 }, 40), { d: 10, a: 20, b: 10 });
  assert.deepEqual(segments({ done: 0, active: 0, backlog: 0 }, 10), { d: 0, a: 0, b: 10 });
  const s = segments({ done: 8, active: 16, backlog: 14 }, 33);
  assert.equal(s.d + s.a + s.b, 33);
});

// ─── Contract 12: the agent row ────────────────────────────────────────

test("contract 12: the model label, the subject, the phrase", () => {
  assert.equal(modelLabel("claude-opus-5-5[1m]"), "opus 5.5");
  assert.equal(modelLabel("claude-sonnet-5-5"), "sonnet 5.5");
  assert.equal(modelLabel("sonnet"), "sonnet");
  assert.equal(modelLabel(""), null);
  const kinds = ["adr", "specs", "epics", "research"];
  assert.equal(
    subjectPath("Critique /v/epics/A/stories/b.md against adr/README.md.", "/v", kinds),
    "epics/A/stories/b.md",
  );
  assert.equal(
    subjectPath("Read adr/README.md, then specs/x.md.", "/v", kinds),
    "specs/x.md",
    "a derived view is never the subject",
  );
  assert.equal(subjectPath("Copy /tmp/s/draft.md to epics/A/stories/new.md", "/v", kinds), "epics/A/stories/new.md");
  assert.equal(subjectPath("Plan the next step.", "/v", kinds), null);
  assert.equal(subjectLabel("epics/A/stories/new.md", null), "new");
  assert.equal(subjectLabel("adr/x.md", "A title"), "«A title»");
  assert.equal(phraseOf("critic", "«T»", "d", W), "reviews «T»");
  assert.equal(phraseOf("unknown-role", "«T»", "d", W), "works on «T»");
  assert.equal(phraseOf("planner", null, "Plan story-058", W), "Plan story-058");
});

test("contract 12: an agent's last step, from its tool call", () => {
  assert.equal(stepOf({ tool: "Read", file_path: "/v/adr/README.md" }, "/v", W), "reads adr/README.md");
  assert.equal(stepOf({ tool: "Edit", file_path: "/elsewhere/x.mjs" }, "/v", W), "edits x.mjs");
  assert.equal(stepOf({ tool: "Grep", pattern: "a".repeat(40) }, "/v", W), `searches ${"a".repeat(31)}…`);
  assert.equal(
    stepOf({ tool: "Bash", command: "git status", description: "Show working tree status" }, "/v", W),
    "show working tree status",
  );
  assert.equal(stepOf({ tool: "Bash", command: "node /x/scripts/reconcile.mjs --write" }, "/v", W), "runs reconcile");
  assert.equal(stepOf({ tool: "Bash", command: "echo hi" }, "/v", W), null);
  assert.equal(stepOf({ tool: "WebSearch", query: "x" }, "/v", W), "searches the web");
  assert.equal(
    stepOf({ tool: "mcp__plugin_projectstore_projectstore__get_artifact" }, "/v", W),
    "asks the vault: get artifact",
  );
  assert.equal(stepOf({ tool: "TodoWrite" }, "/v", W), null);
  assert.equal(commandWord("cd /a && git diff --stat"), "git diff");
});

test("contract 12: the lead agent — the latest running, else the latest ended within the linger", () => {
  const a = (id, status, startedAt, endedAt) => ({ id, status, startedAt, endedAt });
  const now = 1_000_000;
  let r = leadAgent([a("x", "running", 1), a("y", "running", 1)], now);
  assert.equal(r.lead.id, "y", "on a tie the later spawn leads");
  assert.equal(r.others, 1);
  r = leadAgent([a("x", "done", 1, now - 1000), a("y", "error", 1, now - 500)], now);
  assert.equal(r.lead.id, "y");
  r = leadAgent([a("x", "done", 1, now - LINGER_MS)], now);
  assert.equal(r.lead, null);
});

// ─── Contracts 10, 14: the heartbeat's next write, the words ──────────

test("contract 10: what a tick writes after each kind of render", () => {
  assert.deepEqual(heartbeatNext("drew", false, 5), { drawn: true, drawn_at: 5 });
  assert.deepEqual(heartbeatNext("survey", true, 5), { drawn: true, drawn_at: 5 });
  assert.deepEqual(heartbeatNext("nothing", true, 5), { drawn: false, drawn_at: 5 });
  assert.equal(heartbeatNext("nothing", false, 5), null);
  assert.equal(heartbeatNext("unknown", false, 5), null);
});

test("contract 14: the band's words — English per key, nothing invented", () => {
  assert.equal(Object.keys(W).length, BAND_STRING_KEYS.length);
  assert.equal(mergeWords(EN, { band_done: "fertig" }).band_done, "fertig");
  assert.equal(mergeWords(EN, { band_done: "fertig" }).band_backlog, EN.band_backlog);
  assert.equal(mergeWords({}, null), null);
  assert.ok(isEpicName("PS-X"));
  for (const bad of ["", "..", ".hidden", "_templates", "a/b", null]) assert.equal(isEpicName(bad), false, String(bad));
});

// ─── The module: Node-free, and pinned to the core ─────────────────────

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  assert.doesNotMatch(src, /\bimport\s*\(/, `${file}: no dynamic import — a module holding one does not load`);
  return [...src.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );
}

test("the band module and every plugin file it imports are Node-free: relative imports and claude-code only", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec === "claude-code") continue;
      assert.ok(
        spec.startsWith("./") || spec.startsWith("../"),
        `${file}: imports ${spec} — a hooks module imports its own files by relative path and claude-code, nothing else`,
      );
      const target = resolve(dirname(file), spec);
      walk(existsSync(target) ? target : existsSync(`${target}.d.ts`) ? `${target}.d.ts` : target);
    }
  };
  walk(join(ROOT, "hooks", "band.tsx"));
  for (const f of ["scripts/stages.mjs", "scripts/band-shared.mjs", "hooks/band-state.d.ts"])
    assert.ok(seen.has(join(ROOT, f)), `${f} is in the module's import graph`);
});

test("the band module's paths and hint token are the core's", () => {
  const src = readFileSync(join(ROOT, "hooks", "band.tsx"), "utf8");
  const literal = (name) => src.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
  const p = layoutPaths("/p");
  assert.equal(`/p/${literal("BINDING")}`, p.binding);
  assert.equal(`/p/${literal("SESSIONS")}`, p.sessions);
  assert.equal(literal("HINT_COMMAND"), invocation(sourceHarness(), "bar", { args: "off" }));
  assert.ok(existsSync(join(ROOT, "commands", "bar.md")), "the hint names a command that exists");
});

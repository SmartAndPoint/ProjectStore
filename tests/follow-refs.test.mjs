// projectstore — tests/follow-refs.test.mjs: `follow` writes a closing
// story's code_refs from its merged pull request's files and widens its
// epic's (PS-SPECTREE, "Every close path writes the story's code_refs"; the
// spec "The close-refs verb…", alias `close-refs`, contract 7; the follow
// verb's spec, alias `follow`, contracts 1, 2, 5 and 8 as that story amends
// them). follow runs through the bin's run() on fixture vaults inside a
// fixture project, against the fake `gh` of tests/fixtures/gh-stub.mjs first
// on PATH; a project with its own git repository gives the prefix. No test
// reaches the network or the real `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { storyText, flowVault, git } from "./fixtures/flow.mjs";
import { ghStub } from "./fixtures/gh-stub.mjs";
import { run } from "../scripts/cli.mjs";
import { parseFrontmatter, headingLineRe, commandForm } from "../scripts/lib.mjs";
import { parseStatusLog, appendLogLine, logLine, setFm, refsLineOf } from "../scripts/status-log.mjs";

const read = (p) => readFileSync(p, "utf8");
const fm = (t) => parseFrontmatter(t).data;
const refsOf = (t) => refsLineOf(t).refs;

const GH = "https://github.com/acme/app";
const prUrl = (n) => `${GH}/pull/${n}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGED_AT = "2026-11-02T10:00:00Z";
const STARTED = "2026-11-01T09:00:00.000Z";

// ─── Fixtures ──────────────────────────────────────────────────────────

function withSection(text, id, body) {
  const m = text.match(headingLineRe(id));
  assert.ok(m, `no section ${id}`);
  const start = m.index + m[0].trimEnd().length;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  return `${text.slice(0, start)}\n\n${body}\n\n${text.slice(end)}`;
}

// A story ready to close: in progress since STARTED, its criterion checked
// with evidence, text under Final Summary.
function readyStory(id = "story-a") {
  let t = storyText({
    id,
    created: "2026-09-01",
    log: [{ to: "in-progress", at: STARTED, reason: "work started", actor: "plan gate" }],
    fm: { started_at: JSON.stringify(STARTED) },
  });
  t = withSection(t, "acceptance", "- [x] it works — evidence: tests/a.test.mjs");
  return withSection(t, "final_summary", "Shipped.");
}
const reviewOf = (t) =>
  appendLogLine(
    setFm(setFm(t, "status", "review"), "status_changed_at", JSON.stringify("2026-11-01T12:00:00.000Z")),
    logLine({
      at: "2026-11-01T12:00:00.000Z",
      field: "status",
      from: "in-progress",
      to: "review",
      reason: "r",
      actor: "move",
    }),
  );
const linked = (t, n) => setFm(t, "external_refs", JSON.stringify({ pr: prUrl(n) }));

// A merged pull request into main whose files are `files` (paths, each
// MODIFIED unless given as {path, changeType}).
const mergedPr = (n, files = [], o = {}) => ({
  url: prUrl(n),
  state: "MERGED",
  isDraft: false,
  isCrossRepository: false,
  baseRefName: "main",
  createdAt: "2026-11-01T08:00:00Z",
  mergedAt: MERGED_AT,
  mergeCommit: { oid: SHA },
  updatedAt: MERGED_AT,
  closedAt: MERGED_AT,
  body: "",
  files: files.map((f) => (typeof f === "string" ? { path: f, changeType: "MODIFIED" } : f)),
  ...o,
});

// A fixture vault whose project is a git repository of its own, at its root.
function gitVault(stories) {
  const fx = flowVault({ stories });
  git(fx.proj, ["init", "-q"]);
  return fx;
}
const pathOf = (fx, slug, epic = "PS-X") => join(fx.vault, "epics", epic, "stories", `${slug}.md`);
const epicOf = (fx, epic = "PS-X") => join(fx.vault, "epics", epic, "epic.md");
const stubOf = (table) => ghStub(mkdtempSync(join(tmpdir(), "ps-gh-")), table);
const codes = (list) => list.map((f) => f.code);
const lastLine = (t) => parseStatusLog(t).at(-1).line;

function snapshot(fx) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(fx.vault, p)] = readFileSync(p, "utf8");
    }
  };
  walk(fx.vault);
  return out;
}

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};
async function follow(fx, stub, args = [], { json = true } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["follow", ...args, ...(json ? ["--json"] : []), "--project", fx.proj], {
    env: { ...stub.env(), CI: "1" },
    cwd: fx.proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  const j = json ? JSON.parse(stdout.text) : null;
  return { code, out: stdout.text, err: stderr.text, r: j ? j.result : null };
}
const bareRepoViews = (stub) => stub.calls("repo view").filter((a) => String(a[2] ?? "").startsWith("-"));
// The paginated files lists: `api repos/…/files?per_page=100 --paginate --hostname <host>`.
const apiCalls = (stub) =>
  stub
    .log()
    .filter((c) => c.argv[0] === "api")
    .map((c) => {
      assert.ok(c.argv.includes("--paginate") && c.argv.includes("--hostname"), c.argv.join(" "));
      return c;
    }).length;

// ─── Contract 7: a close with no person ────────────────────────────────

// [close-refs#7] [follow#8]
test("follow: a story with an empty external_refs.pr, named by a Closes-story line of a merged pull request that touched scripts/a.mjs, is done with the url and scripts/a.mjs in its code_refs, its epic's and the code map's", async () => {
  const fx = gitVault({ "PS-X/story-a": readyStory() });
  const stub = stubOf({
    prs: [mergedPr(7, ["scripts/a.mjs", "vault/epics/PS-X/epic.md"], { body: "Closes-story: PS-X/story-a" })],
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.equal(JSON.parse(fm(story).external_refs).pr, prUrl(7));
  assert.deepEqual(refsOf(story), ["scripts/a.mjs"], "the vault's own file is dropped");
  assert.deepEqual(refsOf(read(epicOf(fx))), ["scripts/a.mjs"]);
  assert.match(read(join(fx.vault, "code-map.md")), /scripts\/a\.mjs/);
  const item = r.r.items.find((i) => i.to === "done");
  assert.deepEqual([item.refs, item.epic_refs], [["scripts/a.mjs"], ["scripts/a.mjs"]]);
  assert.equal(bareRepoViews(stub).length, 1);
});

// [close-refs#7] [follow#5]
test("follow: a merged pull request of 450 changed files, 400 left after normalising, closes the story with its code_refs and its epic's unchanged, refs-over-cap naming 400, and the reason's suffix (edge)", async () => {
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const epicRefsBefore = refsLineOf(read(epicOf(fx)));
  const files = [
    ...Array.from({ length: 400 }, (_, i) => `src/f${i}.mjs`),
    ...Array.from({ length: 50 }, (_, i) => `node_modules/x${i}.js`),
  ];
  const stub = stubOf({ prs: [mergedPr(7, files)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.equal(apiCalls(stub), 1, "the view's 100 are not enough: the list is read");
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.deepEqual(refsOf(story), []);
  assert.deepEqual(refsLineOf(read(epicOf(fx))), epicRefsBefore, "the epic rule may move it; its code_refs stay");
  const note = r.r.notes.find((n) => n.code === "refs-over-cap");
  assert.ok(note, JSON.stringify(r.r.notes));
  assert.match(
    note.message,
    new RegExp(`${prUrl(7)} gives 400 code_refs, more than follow writes on its own \\(300\\)`),
  );
  assert.match(
    lastLine(story),
    new RegExp(
      `status: review → done — merged: ${prUrl(7)} at ${SHA}; code_refs not written: refs-over-cap \\(follow\\)$`,
    ),
  );
  // The Merged: line keeps its form.
  assert.match(story, new RegExp(`^Merged: ${prUrl(7)} at ${SHA}, 2026-11-02T10:00:00.000Z\\.$`, "m"));
});

// [close-refs#7]
test("follow: the same with exactly 300 left writes the 300 (edge)", async () => {
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const files = [
    ...Array.from({ length: 300 }, (_, i) => `src/f${i}.mjs`),
    ...Array.from({ length: 150 }, (_, i) => `node_modules/x${i}.js`),
  ];
  const r = await follow(fx, stubOf({ prs: [mergedPr(7, files)] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(refsOf(story).length, 300);
  assert.ok(!codes(r.r.notes).includes("refs-over-cap"));
  assert.doesNotMatch(lastLine(story), /code_refs not written/);
});

// [close-refs#7] [follow#2] [follow#5]
test("follow: a bare gh repo view that exits 1 while the default branch answers closes both stories with unchanged code_refs, repo-unknown with gh's reason, one bare repo view, and the reason's suffix (failure)", async () => {
  const fx = gitVault({
    "PS-X/story-a": linked(reviewOf(readyStory()), 7),
    "PS-X/story-b": linked(reviewOf(readyStory("story-b")), 8),
  });
  const stub = stubOf({ prs: [mergedPr(7, ["scripts/a.mjs"]), mergedPr(8, ["scripts/b.mjs"])], fail: { ownRepo: 1 } });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  for (const slug of ["story-a", "story-b"]) {
    const story = read(pathOf(fx, slug));
    assert.equal(fm(story).status, "done");
    assert.deepEqual(refsOf(story), []);
    assert.match(lastLine(story), / at [0-9a-f]{40}; code_refs not written: repo-unknown \(follow\)$/);
  }
  const notes = r.r.notes.filter((n) => n.code === "repo-unknown");
  assert.equal(notes.length, 2);
  assert.match(notes[0].message, /gh could not name this project's repository \(HTTP 502: Bad Gateway/);
  assert.equal(bareRepoViews(stub).length, 1, "the project's repository is asked once per run");
  assert.equal(apiCalls(stub) + stub.calls("pr view").filter((a) => a.join(" ").includes("files")).length, 0);
});

// [close-refs#7] [follow#5]
test("follow: in a project that is no git repository, a merged pull request closes its story with unchanged code_refs and the prefix-unknown suffix (failure)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const r = await follow(fx, stubOf({ prs: [mergedPr(7, ["scripts/a.mjs"])] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.deepEqual(refsOf(story), []);
  assert.match(lastLine(story), /; code_refs not written: prefix-unknown \(follow\)$/);
  const note = r.r.notes.find((n) => n.code === "prefix-unknown");
  assert.match(note.message, /None are written\. To set them by hand: .*codemap.* set PS-X\/story-a\.$/);
});

// [close-refs#7] [follow#5]
test("follow: a merged pull request in another repository closes its story with unchanged code_refs, files-foreign, and the suffix after the url when mergeCommit is null (failure)", async () => {
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const stub = stubOf({
    prs: [mergedPr(7, ["scripts/a.mjs"], { mergeCommit: null })],
    ownRepo: "https://github.com/acme/other",
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.deepEqual(refsOf(story), []);
  assert.match(
    lastLine(story),
    new RegExp(`status: review → done — merged: ${prUrl(7)}; code_refs not written: files-foreign \\(follow\\)$`),
  );
  const note = r.r.notes.find((n) => n.code === "files-foreign");
  assert.match(
    note.message,
    /is in https:\/\/github\.com\/acme\/app, not in this project's repository https:\/\/github\.com\/acme\/other/,
  );
  assert.equal(apiCalls(stub), 0);
});

// ─── The read that blocks, the epic, a second run ─────────────────────

// [close-refs#7] [follow#1]
test("follow: a failed files read is the finding files-unknown, exit 1, the story byte-identical; the next run reads again and closes it (failure)", async () => {
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const files = Array.from({ length: 120 }, (_, i) => `src/f${i}.mjs`);
  const stub = stubOf({ prs: [mergedPr(7, files)], fail: { api: 1 } });
  const before = snapshot(fx);
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 1);
  const f = r.r.findings.find((x) => x.code === "files-unknown");
  assert.ok(f, JSON.stringify(r.r.findings));
  assert.match(
    f.message,
    /could not read the files of .*pull\/7: .*The story is left as it is; the next run reads again\.$/,
  );
  assert.equal(read(pathOf(fx, "story-a")), before["epics/PS-X/stories/story-a.md"]);
  stub.set({ prs: [mergedPr(7, files)] });
  const again = await follow(fx, stub, ["--write"]);
  assert.equal(again.code, 0, JSON.stringify(again.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.equal(refsOf(story).length, 120);
});

// [close-refs#7] [follow#1]
test("follow: a Closes-story link whose files read fails leaves the story byte-identical, its link unwritten (failure)", async () => {
  const fx = gitVault({ "PS-X/story-a": readyStory() });
  const before = read(pathOf(fx, "story-a"));
  const stub = stubOf({
    prs: [mergedPr(7, ["scripts/a.mjs"], { body: "Closes-story: PS-X/story-a" })],
    fail: { view: { [prUrl(7)]: 1 } },
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 1);
  assert.ok(codes(r.r.findings).includes("files-unknown"), JSON.stringify(r.r.findings));
  assert.equal(read(pathOf(fx, "story-a")), before);
});

// [close-refs#7]
test("follow: files-truncated with 300 or fewer refs left writes them and keeps the note (edge)", async () => {
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const files = [
    ...Array.from({ length: 2900 }, (_, i) => `node_modules/x${i}.js`),
    ...Array.from({ length: 150 }, (_, i) => `src/f${i}.mjs`),
  ];
  const r = await follow(fx, stubOf({ prs: [mergedPr(7, files)] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const story = read(pathOf(fx, "story-a"));
  assert.equal(refsOf(story).length, 100, "the list gives 3,000: 2,900 ignored, 100 left");
  const note = r.r.notes.find((n) => n.code === "files-truncated");
  assert.match(note.message, /changed 3050 files and gh gave 3000/);
  assert.doesNotMatch(lastLine(story), /code_refs not written/);
});

// [close-refs#7] [follow#1] [follow#8]
test("follow: an epic.md that cannot be written is the finding epic-refs-error, listing the refs and naming codemap set <epic>; the story is done with its refs (failure)", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root writes a file of mode 000");
  const fx = gitVault({ "PS-X/story-a": linked(reviewOf(readyStory()), 7) });
  const epic = epicOf(fx);
  chmodSync(epic, 0o000);
  let r;
  try {
    r = await follow(fx, stubOf({ prs: [mergedPr(7, ["scripts/a.mjs", "scripts/b.mjs"])] }), ["--write"]);
  } finally {
    chmodSync(epic, 0o644);
  }
  assert.equal(r.code, 1);
  const story = read(pathOf(fx, "story-a"));
  assert.equal(fm(story).status, "done");
  assert.deepEqual(refsOf(story), ["scripts/a.mjs", "scripts/b.mjs"]);
  const f = r.r.findings.find((x) => x.code === "epic-refs-error");
  assert.ok(f, JSON.stringify(r.r.findings));
  assert.equal(f.story, "PS-X/story-a");
  assert.match(f.message, /The refs: scripts\/a\.mjs, scripts\/b\.mjs\./);
  assert.ok(f.message.includes(commandForm("codemap", { args: "set PS-X", env: process.env })), f.message);
  assert.deepEqual(refsOf(read(epic)), []);
});

// [close-refs#7] [follow#8]
test("follow: a second follow --write on the same facts writes nothing", async () => {
  const fx = gitVault({
    "PS-X/story-a": linked(reviewOf(readyStory()), 7),
    "PS-X/story-b": linked(reviewOf(readyStory("story-b")), 8),
  });
  const stub = stubOf({ prs: [mergedPr(7, ["scripts/a.mjs"]), mergedPr(8, ["scripts/a.mjs", "lib/"])] });
  const first = await follow(fx, stub, ["--write"]);
  assert.equal(first.code, 0, JSON.stringify(first.r.findings));
  assert.deepEqual(refsOf(read(epicOf(fx))), ["scripts/a.mjs", "lib/"], "each ref once, in order");
  const after = snapshot(fx);
  const second = await follow(fx, stub, ["--write"]);
  assert.equal(second.code, 0, JSON.stringify(second.r.findings));
  assert.deepEqual(snapshot(fx), after);
});

// [close-refs#7] [follow#1]
test("follow: bare, the plan names the refs' count and the epic's additions, and --json items carry refs and epic_refs; nothing is written", async () => {
  const fx = gitVault({
    "PS-X/story-a": linked(reviewOf(readyStory()), 7),
    "PS-X/story-b": linked(reviewOf(readyStory("story-b")), 8),
  });
  writeFileSync(epicOf(fx), read(epicOf(fx)).replace(/^created: .*$/m, '$&\ncode_refs: ["lib/"]'));
  const stub = stubOf({
    prs: [mergedPr(7, ["scripts/a.mjs", "lib/x.mjs"]), mergedPr(8, ["scripts/a.mjs", "scripts/c.mjs"])],
  });
  const before = snapshot(fx);
  const r = await follow(fx, stub);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const byStory = Object.fromEntries(r.r.items.map((i) => [i.story, [i.refs, i.epic_refs]]));
  assert.deepEqual(byStory["PS-X/story-a"], [["scripts/a.mjs", "lib/x.mjs"], ["scripts/a.mjs"]]);
  assert.deepEqual(byStory["PS-X/story-b"], [["scripts/a.mjs", "scripts/c.mjs"], ["scripts/c.mjs"]]);
  const t = await follow(fx, stub, [], { json: false });
  assert.match(
    t.out,
    /code_refs: 2 files of the pull request to add to the story, and 1 to its epic's: scripts\/a\.mjs\./,
  );
  assert.match(
    t.out,
    /code_refs: 2 files of the pull request to add to the story, and 1 to its epic's: scripts\/c\.mjs\./,
  );
  assert.deepEqual(snapshot(fx), before);
});

// [close-refs#7]
test("follow: a story whose code_refs is a block list is the finding code-refs-unreadable and is left as it is (failure)", async () => {
  const text = linked(reviewOf(readyStory()), 7).replace(/^code_refs: .*$/m, "code_refs:\n  - src/a.mjs");
  const fx = gitVault({ "PS-X/story-a": text });
  const r = await follow(fx, stubOf({ prs: [mergedPr(7, ["scripts/a.mjs"])] }), ["--write"]);
  assert.equal(r.code, 1);
  assert.ok(codes(r.r.findings).includes("code-refs-unreadable"), JSON.stringify(r.r.findings));
  assert.equal(read(pathOf(fx, "story-a")), text);
});

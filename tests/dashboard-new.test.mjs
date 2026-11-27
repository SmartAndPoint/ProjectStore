// projectstore — tests/dashboard-new.test.mjs: New in the item panel, the
// server's half (PS-DASHBOARD, "New opens the same panel as an edit, Save makes
// the item, and the top bar of every view has + New"; the spec "The page's New
// in the item panel: a new item's title and text in the editor, made by Save
// through create --from", alias `dashboard-new`).
//
// Contracts 3 and 7, and the server's half of 4 and 5, run the write module and
// the page's server over a world of tests/fixtures/dashboard-world.mjs (a bare
// `origin`, a vault cloned from it, a project bound to it), with the real core,
// and read the spawn record for the argv. The page's half (the panel's new
// state, + New, the key C) runs in tests/dashboard-page.test.mjs and
// tests/dashboard-create.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { WRITE_VERBS, checkRequest } from "../dashboard/lib/write.mjs";
import { readTemplate } from "../dashboard/lib/state.mjs";
import * as attachment from "../scripts/attachment.mjs";

hermeticGit();

async function withWorld(opts, fn) {
  const w = await makeWorld(opts);
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
  }
}
async function writable(w, opts) {
  const writer = await w.open(opts);
  const r = await writer.refresh();
  assert.equal(r.body.write.can, true, r.body.write.reason);
  return writer;
}
function call(page, path) {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: page.port, path, method: "GET", headers: { host: `127.0.0.1:${page.port}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", fail);
    req.end();
  });
}
const createCalls = (w, from) =>
  w.record.slice(from).filter((e) => e.cmd === process.execPath && e.argv[1] === "create");
const headOf = (w, clone) => w.git(clone, "rev-parse", "HEAD");
const porcelain = (w, clone) => w.git(clone, "status", "--porcelain", "--untracked-files=all");
const batchBranches = (w, clone) => w.git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/dashboard/");
const committedFiles = (w, clone, rev = "HEAD") =>
  w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort();
const subjectAt = (w, clone, rev = "HEAD") => w.git(clone, "log", "-1", "--format=%s", rev);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const fileOf = async (bytes) => ({ name: await attachment.nameOf(bytes), data: bytes.toString("base64") });
// The story template's body with a line under Description, as the panel's editor sends it.
const storyText = (writer, line = "A line typed in the panel.") => {
  const t = readTemplate(writer.readCtx(), "story");
  assert.equal(t.status, 200, t.error);
  return t.result.body.replace("## Description\n", `## Description\n\n${line}\n`);
};
const newStory = (fields = {}) => ({
  verb: "create-story",
  fields: { epic: "PS-X", title: "Faster login", ...fields },
});

// ─── Contract 3: the template ────────────────────────────────────────────

// [dashboard-new#3]
test("dashboard new: /api/template gives each kind's body after the head, its fields and its draft's path, and reads the clone with no process", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    assert.equal(page.writer.view().can, true);
    const clone = page.writer.paths.clone;
    const head = headOf(w, clone);
    const from = w.record.length;
    const story = await call(page, "/api/template?kind=story");
    assert.equal(story.status, 200, story.text);
    assert.equal(story.json.kind, "story");
    assert.ok(story.json.body.startsWith("## Description\n"), story.json.body.slice(0, 80));
    assert.ok(!story.json.body.includes("Untitled"), "the body names no title");
    assert.match(story.json.rel, /^epics\/PS-X\/stories\/story-untitled\.md$/);
    assert.deepEqual(Object.keys(story.json.fields).sort(), ["assignee", "priority", "status"]);
    assert.equal(story.json.fields.status, "planned");
    const epic = await call(page, "/api/template?kind=epic");
    assert.equal(epic.status, 200, epic.text);
    assert.equal(epic.json.rel, "epics/NEW/epic.md");
    assert.ok(epic.json.body.startsWith("## "), epic.json.body.slice(0, 80));
    assert.ok(!epic.json.body.includes("](./stories/story-001.md)"), "no placeholder row");
    const ini = await call(page, "/api/template?kind=initiative");
    assert.equal(ini.status, 200, ini.text);
    assert.match(ini.json.rel, /^initiatives\/untitled\.md$/);
    assert.ok("owner" in ini.json.fields, JSON.stringify(ini.json.fields));
    const adr = await call(page, "/api/template?kind=adr");
    assert.equal(adr.status, 404);
    assert.match(adr.json.error, /initiative, epic, story/);
    const none = await call(page, "/api/template");
    assert.equal(none.status, 404);
    assert.equal(w.record.length, from, "no GET starts a process");
    assert.equal(headOf(w, clone), head);
    assert.equal(porcelain(w, clone), "", "the clone is unchanged");
  });
});

// [dashboard-new#3]
test("dashboard new: a story's template on a vault with no epic folder is 404 saying so (failure)", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const empty = mkdtempSync(join(tmpdir(), "dashboard-new-empty-"));
    const r = readTemplate({ ...writer.readCtx(), vault: empty }, "story");
    assert.equal(r.status, 404);
    assert.match(r.error, /no epic yet: make an epic first/);
    assert.doesNotMatch(r.error, /projectstore:/, "no harness command in the words");
  });
});

// ─── Contract 7: the rows carry the text and the files ──────────────────

// [dashboard-new#7]
test("dashboard new: the three create rows take an optional text and files, and files with no text, or a text over 500,000, are 400 before any process", async () => {
  const by = Object.fromEntries(WRITE_VERBS.map((v) => [v.verb, v]));
  for (const v of ["create-initiative", "create-epic", "create-story"]) {
    assert.deepEqual(by[v].fields.text, { kind: "text", max: 500000, label: "Text", optional: true }, v);
    assert.deepEqual(by[v].fields.files, { kind: "files", optional: true, label: "Pictures" }, v);
  }
  const png = await fileOf(PNG);
  const filesOnly = checkRequest(newStory({ files: [png] }));
  assert.equal(filesOnly.ok, false);
  assert.match(filesOnly.error, /takes files only with a text/);
  assert.match(
    checkRequest(newStory({ text: "x".repeat(500001) })).error,
    /500001 characters long; it takes at most 500000/,
  );
  assert.equal(checkRequest(newStory({ text: "## Description\n" })).ok, true);
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const from = w.record.length;
    for (const req of [newStory({ files: [png] }), newStory({ text: "y".repeat(500001) })]) {
      const r = await writer.action(req);
      assert.equal(r.status, 400, JSON.stringify(r.body));
    }
    assert.deepEqual(createCalls(w, from), [], "no call");
  });
});

// [dashboard-new#7]
test("dashboard new: a create with a text and a file passes --from= and one --attach=, both outside the clone and gone after the run; with no text there is no --from (edge)", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const png = await fileOf(PNG);
    let from = w.record.length;
    const text = storyText(writer).replace(
      "## Description\n\n",
      `## Description\n\n![shot](../../../attachments/${png.name})\n\n`,
    );
    const r = await writer.preview(newStory({ text, files: [png] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, r.body.error);
    const [call0] = createCalls(w, from);
    const fromArg = call0.argv.find((a) => a.startsWith("--from="));
    const attachArgs = call0.argv.filter((a) => a.startsWith("--attach="));
    assert.ok(fromArg, call0.argv.join(" "));
    assert.equal(attachArgs.length, 1, call0.argv.join(" "));
    for (const a of [fromArg, ...attachArgs]) {
      const p = a.slice(a.indexOf("=") + 1);
      assert.ok(!p.startsWith(clone), `${p} is outside the clone`);
      assert.equal(existsSync(p), false, `${p} is gone after the run`);
    }
    from = w.record.length;
    const bare = await writer.preview(newStory());
    assert.equal(bare.body.ok, true, bare.body.error);
    const [call1] = createCalls(w, from);
    assert.ok(!call1.argv.some((a) => a.startsWith("--from")), call1.argv.join(" "));
    assert.ok(!call1.argv.some((a) => a.startsWith("--attach")), call1.argv.join(" "));
  });
});

// ─── Contracts 4 and 5, the server's half ───────────────────────────────

// [dashboard-new#4]
test("dashboard new: Save of a story with a line is one commit of the story and its epic.md, and the story's Description holds the line", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const r = await writer.action(newStory({ text: storyText(writer) }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(r.body.write.batch.commits, 1);
    assert.equal(subjectAt(w, clone), "create story in PS-X: Faster login");
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-X/epic.md", "epics/PS-X/stories/story-faster-login.md"]);
    const made = w.git(clone, "show", "HEAD:epics/PS-X/stories/story-faster-login.md");
    assert.match(made, /## Description\n\nA line typed in the panel\.\n/);
    assert.match(made, /^written_by_verb: "create /m);
    assert.equal(porcelain(w, clone), "");
  });
});

// [dashboard-new#4]
test("dashboard new: a picture pasted into the new story's text is in the same commit, with the .gitattributes line (edge)", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const png = await fileOf(PNG);
    const text = storyText(writer, `![shot](../../../attachments/${png.name})`);
    const r = await writer.action(newStory({ text, files: [png] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(committedFiles(w, clone), [
      ".gitattributes",
      `attachments/${png.name}`,
      "epics/PS-X/epic.md",
      "epics/PS-X/stories/story-faster-login.md",
    ]);
    assert.deepEqual(readFileSync(join(clone, "attachments", png.name)), PNG);
    assert.equal(porcelain(w, clone), "");
  });
});

// [dashboard-new#5]
test("dashboard new: an epic ID that exists, and a text that adds a Status log, are refused with the core's words; nothing is committed (failure)", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const head = headOf(w, clone);
    const epicBody = readTemplate(writer.readCtx(), "epic").result.body;
    const cases = [
      [{ verb: "create-epic", fields: { epic: "PS-X", title: "Again", text: epicBody } }, /PS-X|exists/],
      [
        newStory({ text: `${storyText(writer).trimEnd()}\n\n## Status log\n\n- a line\n` }),
        /Status log is written by gates and verbs/,
      ],
    ];
    for (const [req, words] of cases) {
      const r = await writer.action(req);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, false, JSON.stringify(req.fields.epic));
      assert.match(r.body.error, words);
      assert.equal(headOf(w, clone), head);
      assert.equal(porcelain(w, clone), "");
      assert.equal(batchBranches(w, clone), "");
    }
  });
});

// [dashboard-new#5]
test("dashboard new: when git ignores the attachments folder, a new story with a picture commits nothing and names the file and the rule (failure)", async () => {
  await withWorld({ files: { ".gitignore": "attachments/\n" } }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const head = headOf(w, clone);
    const png = await fileOf(PNG);
    const r = await writer.action(
      newStory({ text: storyText(writer, `![shot](../../../attachments/${png.name})`), files: [png] }),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(
      r.body.error,
      new RegExp(`attachments/${png.name}.*\\.gitignore:1:attachments/; nothing was committed`),
    );
    assert.equal(headOf(w, clone), head);
    assert.equal(
      existsSync(join(clone, "epics", "PS-X", "stories", "story-faster-login.md")),
      false,
      "the clone is put back",
    );
    assert.equal(batchBranches(w, clone), "");
  });
});

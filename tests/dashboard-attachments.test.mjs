// projectstore — tests/dashboard-attachments.test.mjs: the page's pictures
// (PS-BACKLOG, "Pictures and PDFs pasted into a text are kept in an attachments
// folder of the layout, with a size limit"; the spec "The page's pictures: a
// paste or a drop becomes a link to a kept file, shown until Save, and sent
// with the text", alias `dashboard-attachments`).
//
// Contract 1 runs the page's server over a world of
// tests/fixtures/dashboard-world.mjs; contracts 5 to 7 run the write module
// over one, and read the spawn record for "no process" and the argv.
// Contracts 2 to 4 are tested on the page's editor in
// tests/dashboard-page.test.mjs; 8 and 9 are checked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { hermeticGit, makeWorld, REPO } from "./fixtures/dashboard-world.mjs";
import { WRITE_VERBS, checkRequest, filesRefusal } from "../dashboard/lib/write.mjs";
import { readState } from "../dashboard/lib/state.mjs";
import * as attachment from "../scripts/attachment.mjs";
import { splitForEdit, bodyHash } from "../scripts/edit-cut.mjs";

hermeticGit();

const STORY_REL = "epics/PS-X/stories/story-a.md";
const CORE_FILE = join(REPO, "scripts", "attachment.mjs");
// A 1×1 PNG, and a second kept file of other bytes (a GIF's first bytes are enough for typeOf).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(24, 7)]);
const fileOf = async (bytes) => ({ name: await attachment.nameOf(bytes), data: bytes.toString("base64") });

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
// The story as the editor opens it in the clone: its body and that body's hash.
function opened(writer, rel = STORY_REL) {
  const cut = splitForEdit(readFileSync(join(writer.paths.clone, rel), "utf8"));
  return { body: cut.body, hash: bodyHash(cut.body) };
}
const save = (fields) => ({ verb: "edit-doc", fields });
const editCalls = (w, from) => w.record.slice(from).filter((e) => e.cmd === process.execPath && e.argv[1] === "edit");
const headOf = (w, clone) => w.git(clone, "rev-parse", "HEAD");
const batchBranches = (w, clone) => w.git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/dashboard/");
const committedFiles = (w, clone, rev = "HEAD") =>
  w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort();
const linkOf = (name) => `../../../attachments/${name}`;
const withPicture = (body, name, alt = "shot") =>
  body.replace("## Description\n", `## Description\n\n![${alt}](${linkOf(name)})\n`);

function call(page, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: page.port, path, method, headers: { host: `127.0.0.1:${page.port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(bytes.toString("utf8"));
          } catch {}
          done({ status: res.statusCode, headers: res.headers, bytes, json });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

// ─── Contract 1: the page loads the core's module, and knows the folder ───

// [dashboard-attachments#1]
test("dashboard attachments: GET /attachment.js answers the core's own file, byte for byte, as JavaScript, and starts no process; the package holds no copy", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const before = w.record.length;
    const r = await call(page, "/attachment.js");
    assert.equal(r.status, 200);
    assert.ok(r.bytes.equals(readFileSync(CORE_FILE)), "the body is the core file's bytes");
    assert.match(String(r.headers["content-type"]), /^text\/javascript/);
    assert.match(String(r.headers["content-security-policy"]), /script-src 'self'/, "the page's own headers");
    assert.equal(w.record.length, before, "no process starts");
    const state = await call(page, "/api/state");
    assert.equal(state.json.attachments, "attachments", "the layout's folder");
  });
  // No file of the package holds the core's module.
  const core = readFileSync(CORE_FILE);
  const walk = (d) =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (n === "node_modules") return [];
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const copies = walk(join(REPO, "dashboard")).filter(
    (p) => statSync(p).size === core.length && readFileSync(p).equals(core),
  );
  assert.deepEqual(copies, []);
  assert.equal(existsSync(join(REPO, "dashboard", "public", "attachment.js")), false);
});

// [dashboard-attachments#1] edge: a layout with no attachments key.
test("dashboard attachments: /api/state's attachments is null when the layout keeps no folder", async () => {
  await withWorld({}, async (w) => {
    const { attachments: _drop, ...layout } = w.ctx.layout;
    assert.equal(readState({ ...w.ctx, layout }).attachments, null);
    assert.equal(readState(w.ctx).attachments, "attachments");
  });
});

// ─── Contract 5: files, an optional field of edit-doc, checked before any process ───

// [dashboard-attachments#5]
test("dashboard attachments: edit-doc's files is optional; a file not { name, data }, not strict base64, of no kept type, over the limit or misnamed is refused naming files", async () => {
  const entry = WRITE_VERBS.find((v) => v.verb === "edit-doc");
  assert.deepEqual(entry.fields.files, { kind: "files", optional: true, label: "Pictures" });
  const base = { path: STORY_REL, text: "## Description\n", base: "0123456789abcdef" };
  const shape = (files) => checkRequest(save({ ...base, files }));
  assert.equal(shape(undefined).ok, true, "absent");
  assert.equal("files" in shape([]).fields, false, "an empty list is the field absent");
  for (const bad of [
    "x",
    [{ name: "a" }],
    [{ name: "a", data: "QQ==", more: 1 }],
    [{ name: 1, data: "QQ==" }],
    [{ name: "a", data: "QQ" }],
    [{ name: "a", data: "Q Q==" }],
  ]) {
    const r = shape(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /^files/, r.error);
  }
  const checked = async (files) => {
    const r = shape(files);
    assert.equal(r.ok, true, r.error);
    return filesRefusal(r, attachment);
  };
  assert.equal(await checked([await fileOf(PNG)]), null);
  const misnamed = await checked([{ name: "0000000000000000.png", data: PNG.toString("base64") }]);
  assert.match(misnamed.error, /^files\[0\].*named [0-9a-f]{16}\.png, not 0000000000000000\.png/);
  const html = Buffer.from("<html>not a picture</html>");
  assert.match(
    (await checked([{ name: "0000000000000000.png", data: html.toString("base64") }])).error,
    /^files\[0\].*keeps PNG/,
  );
  const big = Buffer.concat([PNG, Buffer.alloc(attachment.MAX_BYTES)]);
  assert.match(
    (await checked([{ name: await attachment.nameOf(big), data: big.toString("base64") }])).error,
    /^files\[0\].*over the limit of 5242880 bytes/,
  );
});

// [dashboard-attachments#5]
test("dashboard attachments: a refused files list is 400 naming files and starts no process; files: [] runs as a save without files", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const it = opened(writer);
    const text = it.body.replace("## Description\n", "## Description\n\nWith no picture.\n");
    const before = w.record.length;
    const bad = await writer.action(
      save({
        path: STORY_REL,
        text,
        base: it.hash,
        files: [{ name: "0000000000000000.png", data: PNG.toString("base64") }],
      }),
    );
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /^files\[0\]/);
    assert.equal(w.record.length, before, "no process starts");
    const empty = await writer.action(save({ path: STORY_REL, text, base: it.hash, files: [] }));
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.ok, true, JSON.stringify(empty.body));
    const calls = editCalls(w, before);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].argv.some((a) => a.startsWith("--attach")),
      false,
      "no --attach",
    );
  });
});

// ─── Contract 6: each file reaches the verb as a temporary file ───

// [dashboard-attachments#6] [dashboard-attachments#7]
test("dashboard attachments: a save with two pictures passes two --attach= to edit, commits the text, both pictures and .gitattributes in one commit, and leaves no temporary folder", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const it = opened(writer);
    const [png, gif] = [await fileOf(PNG), await fileOf(GIF)];
    const text = withPicture(withPicture(it.body, png.name), gif.name, "anim");
    const before = w.record.length;
    const r = await writer.action(save({ path: STORY_REL, text, base: it.hash, files: [png, gif] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const [call0] = editCalls(w, before);
    const attach = call0.argv.filter((a) => a.startsWith("--attach="));
    assert.equal(attach.length, 2);
    assert.deepEqual(attach.map((a) => a.split("/").pop()).sort(), [png.name, gif.name].sort());
    const dir = dirname(attach[0].slice("--attach=".length));
    assert.equal(existsSync(dir), false, "the request's folder is gone");
    assert.deepEqual(
      committedFiles(w, clone),
      [".gitattributes", `attachments/${gif.name}`, `attachments/${png.name}`, STORY_REL].sort(),
    );
    assert.ok(readFileSync(join(clone, "attachments", png.name)).equals(PNG));
    assert.equal(w.git(clone, "rev-list", "--count", "origin/main..HEAD"), "1", "one commit");
  });
});

// [dashboard-attachments#6] failure: a verb that refuses, and one past its budget.
test("dashboard attachments: the temporary folder is gone after a refused save and after one that ran past its budget", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const it = opened(writer);
    const png = await fileOf(PNG);
    // Not linked by the text: the verb refuses.
    let before = w.record.length;
    const refused = await writer.action(
      save({
        path: STORY_REL,
        text: it.body.replace("## Description\n", "## Description\n\nNo link.\n"),
        base: it.hash,
        files: [png],
      }),
    );
    assert.equal(refused.body.ok, false, JSON.stringify(refused.body));
    assert.match(refused.body.error, /does not link/);
    let attach = editCalls(w, before)[0].argv.find((a) => a.startsWith("--attach="));
    assert.equal(existsSync(dirname(attach.slice("--attach=".length))), false);
    // The refusal names the file, not the request's folder, which is gone.
    assert.ok(refused.body.error.startsWith(`${png.name}: `), refused.body.error);
    assert.equal(JSON.stringify(refused.body).includes(dirname(attach.slice("--attach=".length))), false);
    const slow = await writable(w, { budgets: { verb: 1 } });
    before = w.record.length;
    const late = await slow.action(
      save({ path: STORY_REL, text: withPicture(it.body, png.name), base: it.hash, files: [png] }),
    );
    assert.equal(late.status, 502, JSON.stringify(late.body));
    attach = editCalls(w, before)[0].argv.find((a) => a.startsWith("--attach="));
    assert.equal(existsSync(dirname(attach.slice("--attach=".length))), false);
  });
});

// ─── Contract 7: the commit holds every created file, or nothing is committed ───

// [dashboard-attachments#7] failure: the attachments folder ignored, with a changed text and with the same text.
test("dashboard attachments: when .gitignore lists attachments/, a save with a picture is 200 ok: false naming the file and the rule, and the clone's HEAD and batch stay as before", async () => {
  const png = await fileOf(PNG);
  const linked = (await makeWorldText()).replace(
    "## Description\n",
    `## Description\n\n![shot](${linkOf(png.name)})\n`,
  );
  await withWorld({ files: { ".gitignore": "attachments/\n", "epics/PS-X/stories/story-b.md": linked } }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const head = headOf(w, clone);
    const branches = batchBranches(w, clone);
    const it = opened(writer);
    const changed = await writer.action(
      save({ path: STORY_REL, text: withPicture(it.body, png.name), base: it.hash, files: [png] }),
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.ok, false);
    assert.match(
      changed.body.error,
      new RegExp(`attachments/${png.name}.*\\.gitignore:1:attachments/; nothing was committed`),
    );
    assert.equal(headOf(w, clone), head);
    assert.equal(batchBranches(w, clone), branches);
    assert.equal(existsSync(join(clone, "attachments", png.name)), false, "the clone is put back, ignored files too");
    // The same text, linking the picture already: refused the same way, not answered as no change.
    const b = opened(writer, "epics/PS-X/stories/story-b.md");
    const same = await writer.action(
      save({ path: "epics/PS-X/stories/story-b.md", text: b.body, base: b.hash, files: [png] }),
    );
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.ok, false, JSON.stringify(same.body));
    assert.match(same.body.error, /\.gitignore:1:attachments\/; nothing was committed/);
    assert.equal(headOf(w, clone), head);
    assert.equal(batchBranches(w, clone), branches);
  });
});

// [dashboard-attachments#7] failure: .gitattributes ignored, so the line the verb adds would not be committed.
test("dashboard attachments: when .gitignore lists .gitattributes, a save with a picture commits nothing and names .gitattributes", async () => {
  await withWorld({ files: { ".gitignore": ".gitattributes\n" } }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const head = headOf(w, clone);
    const it = opened(writer);
    const png = await fileOf(PNG);
    const r = await writer.action(
      save({ path: STORY_REL, text: withPicture(it.body, png.name), base: it.hash, files: [png] }),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.match(
      r.body.error,
      /^\.gitattributes was written.*\.gitignore:1:\.gitattributes; nothing was committed\. Keep it out/,
    );
    assert.equal(headOf(w, clone), head);
  });
});

// [dashboard-attachments#5] The preview takes files too, and runs the verb's plan with them.
test("dashboard attachments: a preview with a picture runs edit without --write, with its --attach=, and leaves the clone as it was", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const head = headOf(w, clone);
    const it = opened(writer);
    const png = await fileOf(PNG);
    const before = w.record.length;
    const r = await writer.preview(
      save({ path: STORY_REL, text: withPicture(it.body, png.name), base: it.hash, files: [png] }),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(
      r.body.result.files.map((f) => [f.path, f.state]),
      [[`attachments/${png.name}`, "to-create"]],
    );
    const [call0] = editCalls(w, before);
    assert.equal(call0.argv.includes("--write"), false);
    assert.equal(call0.argv.filter((a) => a.startsWith("--attach=")).length, 1);
    assert.equal(headOf(w, clone), head);
    assert.equal(w.git(clone, "status", "--porcelain"), "", "nothing written in the clone");
    // A misnamed file is refused before any process, in the preview too.
    const n = w.record.length;
    const bad = await writer.preview(
      save({ path: STORY_REL, text: it.body, base: it.hash, files: [{ ...png, name: "0000000000000000.png" }] }),
    );
    assert.equal(bad.status, 400);
    assert.equal(w.record.length, n);
  });
});

// The world's story text, for a second story of the same shape.
async function makeWorldText() {
  const w = await makeWorld({});
  try {
    return readFileSync(join(w.vault, STORY_REL), "utf8").replaceAll("story-a", "story-b");
  } finally {
    await w.cleanup();
  }
}

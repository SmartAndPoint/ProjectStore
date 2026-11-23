// projectstore — the dashboard's editor, its server side (spec "The
// dashboard's editor: the text under the title, change marks from where your
// changes started, and keys that move by drawn rows", alias
// `dashboard-editor`; PS-DASHBOARD: "The page edits an item's text through the
// edit verb, with change marks that follow the edits"). The page's server and
// its write module run in process over a world of git repositories
// (tests/fixtures/dashboard-world.mjs). The marks and the keys are checked by
// the editor's own suite (dashboard/editor/test/, the test workflow's editor
// job); what the page draws is the page's own check and the manual record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { splitForEdit, bodyHash } from "../scripts/edit-cut.mjs";
import { parseFrontmatter } from "../scripts/lib.mjs";

hermeticGit();

const STORY_REL = "epics/PS-X/stories/story-a.md";
const EPIC_REL = "epics/PS-X/epic.md";
const ADR_REL = "adr/ADR-001-x.md";
const ADR = "---\ntype: adr\nid: ADR-001\ntitle: X\nstatus: accepted\n---\n\n# X\n\n## Context\n\nWhy.\n";

async function withWorld(fn) {
  const w = await makeWorld({ files: { [ADR_REL]: ADR } });
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
  }
}
function call(page, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: page.port, path, method, headers: { host: `127.0.0.1:${page.port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
const tokenOf = async (page) =>
  /<meta name="projectstore-token" content="([^"]*)"/.exec((await call(page, "/")).text)?.[1];
const own = (page, token) => ({
  "x-projectstore-token": token,
  origin: `http://127.0.0.1:${page.port}`,
  "content-type": "application/json",
});
const post = (page, path, headers, body) => call(page, path, { method: "POST", headers, body: JSON.stringify(body) });
const item = async (page, rel) => (await call(page, `/api/item?rel=${encodeURIComponent(rel)}`)).json;
const rest = (text) => text.slice(text.indexOf("\n---\n", 4) + 5);
const save = (fields) => ({ verb: "edit-doc", fields });

// A page that can write, with its token and its clone.
async function writablePage(w) {
  const page = await w.start();
  const token = await tokenOf(page);
  const r = await post(page, "/api/refresh", own(page, token), {});
  assert.equal(r.json?.write?.can, true, JSON.stringify(r.json?.write));
  return { page, token };
}

// [dashboard-editor#1]
test("dashboard editor: a story and an epic come with edit, cut and hashed by the edit verb's module; an ADR comes with none", async () => {
  await withWorld(async (w) => {
    const { page } = await writablePage(w);
    for (const rel of [STORY_REL, EPIC_REL]) {
      const it = await item(page, rel);
      assert.ok(it.edit, rel);
      const cut = splitForEdit(it.body);
      assert.deepEqual(it.edit, { head: cut.head, body: cut.body, hash: bodyHash(cut.body) });
      assert.match(it.edit.body, /^## /, `${rel}: the body starts at its first section`);
      assert.doesNotMatch(it.edit.body, /^# |\| Field \| Value \|/m, `${rel}: no title, no field table`);
    }
    const adr = await item(page, ADR_REL);
    assert.ok(adr && !("edit" in adr), "an ADR opens with no editor");
  });
});

// [dashboard-editor#6]
test("dashboard editor: /api/base is a POST of the page's own: 403 without the token, 404 for no artifact, null for an ADR, and the body where the batch starts", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    assert.equal(
      (await post(page, "/api/base", { "content-type": "application/json" }, { rel: STORY_REL })).status,
      403,
    );
    assert.notEqual((await call(page, "/api/base")).status, 200, "no GET reads the base");
    assert.equal((await post(page, "/api/base", own(page, token), { rel: "nope.md" })).status, 404);
    const adr = await post(page, "/api/base", own(page, token), { rel: ADR_REL });
    assert.deepEqual(adr.json, { ok: true, base: null, disk: null });
    const r = await post(page, "/api/base", own(page, token), { rel: STORY_REL });
    assert.equal(r.status, 200);
    assert.equal(r.json.base, (await item(page, STORY_REL)).edit.body);
    assert.equal(r.json.disk, null, "the vault folder reads the same");
  });
});

// [dashboard-editor#7]
test("dashboard editor: a line the vault folder has and the clone lacks is said in disk, and is not in the base", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const onDisk = join(w.vault, STORY_REL);
    writeFileSync(
      onDisk,
      readFileSync(onDisk, "utf8").replace("## Description\n", "## Description\n\nTyped in Obsidian.\n"),
    );
    const r = await post(page, "/api/base", own(page, token), { rel: STORY_REL });
    assert.deepEqual(r.json.disk, { differs: true, exists: true });
    assert.doesNotMatch(r.json.base, /Typed in Obsidian/);
  });
});

// [dashboard-editor#9] [edit#1]
test("dashboard editor: a save runs the core's edit verb: one commit of the story alone, marked not reviewed; a stale hash is refused, and no hash is 400", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const it = await item(page, STORY_REL);
    const text = it.edit.body.replace("## Description\n", "## Description\n\nSaved from the page.\n");
    const noHash = await post(page, "/api/action", own(page, token), save({ path: STORY_REL, text }));
    assert.equal(noHash.status, 400, JSON.stringify(noHash.json));
    const r = await post(page, "/api/action", own(page, token), save({ path: STORY_REL, text, base: it.edit.hash }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    const after = await item(page, STORY_REL);
    assert.match(after.body, /Saved from the page\./);
    assert.equal(after.edit.hash, r.json.result.hash, "the answer's hash is the new body's");
    // The commit, in the page's clone.
    const clone = join(w.project, ".projectstore", "state", "dashboard", "test-person", "clone");
    assert.equal(w.git(clone, "log", "-1", "--format=%s"), `edit ${STORY_REL}`);
    assert.deepEqual(
      w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean),
      [STORY_REL],
    );
    const committed = w.git(clone, "show", `HEAD:${STORY_REL}`);
    assert.match(parseFrontmatter(committed).data.written_by_verb, /^edit /);
    assert.equal(parseFrontmatter(committed).data.review_status, "pending");
    assert.equal(rest(committed).includes("Saved from the page."), true);
    // The old hash again: the file changed since, so the save is refused.
    const stale = await post(
      page,
      "/api/action",
      own(page, token),
      save({ path: STORY_REL, text: `${text}\nmore\n`, base: it.edit.hash }),
    );
    assert.equal(stale.json.ok, false);
    assert.match(stale.json.error, /changed after it was read/);
    assert.equal(w.git(clone, "log", "-1", "--format=%s"), `edit ${STORY_REL}`, "no second commit");
  });
});

// [dashboard-editor#6]
test("dashboard editor: a GET of /api/base is 404, a POST with no rel is 404, and the three reads run only for a POST of the page's own", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    assert.equal((await call(page, "/api/base")).status, 404);
    assert.equal((await call(page, "/api/base", { method: "HEAD" })).status, 404);
    const from = w.record.length;
    await post(page, "/api/base", { "content-type": "application/json" }, { rel: STORY_REL });
    const sub = (e) => e.argv.find((a) => ["merge-base", "cat-file", "show"].includes(a));
    assert.deepEqual(w.record.slice(from).filter(sub), [], "a 403 runs nothing");
    await post(page, "/api/base", own(page, token), { rel: STORY_REL });
    const calls = w.record.slice(from).filter(sub);
    assert.deepEqual(calls.map(sub), ["merge-base", "cat-file", "show"]);
    for (const c of calls) assert.ok(c.argv.includes("--end-of-options"), c.argv.join(" "));
    assert.equal((await post(page, "/api/base", own(page, token), {})).status, 404);
  });
});

// [dashboard-editor#6] [dashboard-editor#5]
test('dashboard editor: a file the batch added, not where the batch started, has the base "" (a new document)', async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const clone = join(w.project, ".projectstore", "state", "dashboard", "test-person", "clone");
    const rel = "epics/PS-X/stories/story-new.md";
    writeFileSync(join(clone, rel), readFileSync(join(clone, STORY_REL), "utf8").replace(/story-a/g, "story-new"));
    w.git(clone, "add", "--", rel);
    w.git(clone, "-c", "user.name=T", "-c", "user.email=t", "commit", "-q", "-m", "a new story");
    const r = await post(page, "/api/base", own(page, token), { rel });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.base, "");
  });
});

// [dashboard-editor#7]
test("dashboard editor: a file the vault folder lacks is said in disk with exists: false", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const { rmSync } = await import("node:fs");
    rmSync(join(w.vault, STORY_REL));
    const r = await post(page, "/api/base", own(page, token), { rel: STORY_REL });
    assert.deepEqual(r.json.disk, { differs: true, exists: false });
  });
});

// [dashboard-editor#9]
test("dashboard editor: a text over 500,000 characters is 400 naming the limit; a text the guards refuse is refused in the verb's words; a move then a save of the old hash is refused", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const it = await item(page, STORY_REL);
    const big = await post(
      page,
      "/api/action",
      own(page, token),
      save({ path: STORY_REL, text: `## A\n${"x".repeat(500001)}`, base: it.edit.hash }),
    );
    assert.equal(big.status, 400);
    assert.match(big.json.error, /500000/);
    const guarded = await post(
      page,
      "/api/action",
      own(page, token),
      save({ path: STORY_REL, text: `${it.edit.body}\n## Status log\n\n- forged\n`, base: it.edit.hash }),
    );
    assert.equal(guarded.json.ok, false, JSON.stringify(guarded.json));
    assert.match(guarded.json.error, /Status log/);
    const moved = await post(page, "/api/action", own(page, token), {
      verb: "move",
      fields: { story: "PS-X/story-a", to: "todo", reason: "next" },
    });
    assert.equal(moved.json.ok, true, JSON.stringify(moved.json));
    const stale = await post(
      page,
      "/api/action",
      own(page, token),
      save({ path: STORY_REL, text: `${it.edit.body}\nmore\n`, base: it.edit.hash }),
    );
    assert.equal(stale.json.ok, false);
    assert.match(stale.json.error, /changed after it was read/);
    assert.match((await item(page, STORY_REL)).body, /next/, "the move's Status log line is in the file");
  });
});

// [dashboard-editor#10]
test("dashboard editor: the editor's built file and its notices are served and shipped: /editor.bundle.js is 200 as a script", async () => {
  await withWorld(async (w) => {
    const page = await w.start();
    const r = await call(page, "/editor.bundle.js");
    assert.equal(r.status, 200);
    assert.match(r.headers?.["content-type"] || "text/javascript", /javascript/);
    assert.match(r.text, /^var WSEditor=/);
  });
});

// [dashboard-editor#9]
test("dashboard editor: a 130 KiB text is saved", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const it = await item(page, STORY_REL);
    const text = it.edit.body.replace("## Description\n", `## Description\n\n${"word ".repeat(26 * 1024)}\n`);
    assert.ok(Buffer.byteLength(text) > 130 * 1024);
    const r = await post(page, "/api/action", own(page, token), save({ path: STORY_REL, text, base: it.edit.hash }));
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    assert.equal(r.json.ok, true, JSON.stringify(r.json).slice(0, 300));
  });
});

// [dashboard-editor#6]
test("dashboard editor: with the vault in a folder of its repository, the base is read at that folder", async () => {
  const w = await makeWorld({ prefix: "vault" });
  try {
    const { page, token } = await writablePage(w);
    const r = await post(page, "/api/base", own(page, token), { rel: STORY_REL });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.base, (await item(page, STORY_REL)).edit.body);
  } finally {
    await w.cleanup();
  }
});

// [dashboard-editor#9]
test("dashboard editor: a save's text reaches the verb as --from=<file>, removed when the verb ends, and the next save carries the answer's hash", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const { existsSync } = await import("node:fs");
    const it = await item(page, STORY_REL);
    const from = w.record.length;
    const r = await post(
      page,
      "/api/action",
      own(page, token),
      save({
        path: STORY_REL,
        text: it.edit.body.replace("## Description\n", "## Description\n\nOne.\n"),
        base: it.edit.hash,
      }),
    );
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    const run = w.record.slice(from).find((e) => e.argv.includes("edit"));
    const arg = run.argv.find((a) => a.startsWith("--from="));
    assert.ok(arg, run.argv.join(" "));
    assert.equal(existsSync(arg.slice("--from=".length)), false, "the text file is removed after the run");
    const again = await post(
      page,
      "/api/action",
      own(page, token),
      save({
        path: STORY_REL,
        text: it.edit.body.replace("## Description\n", "## Description\n\nOne. Two.\n"),
        base: r.json.result.hash,
      }),
    );
    assert.equal(again.json.ok, true, JSON.stringify(again.json));
  });
});

// [dashboard-editor#6]
test("dashboard editor: a base read whose body is no JSON object is 400", async () => {
  await withWorld(async (w) => {
    const { page, token } = await writablePage(w);
    const r = await call(page, "/api/base", { method: "POST", headers: own(page, token), body: "not json" });
    assert.equal(r.status, 400);
  });
});

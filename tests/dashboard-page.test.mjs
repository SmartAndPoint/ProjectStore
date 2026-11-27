// projectstore — tests/dashboard-page.test.mjs: the page's own server, which
// only reads (PS-DASHBOARD, "The dashboard package opens a read-only page over
// the bound vault, started by projectstore dashboard"; the spec "The dashboard
// package and its launcher: the folder, the dashboard verb, and a page that
// only reads", alias `dashboard`, contracts 7 to 12, and the module list and
// size budget under its Modules). dashboard/server.mjs runs as a child, on a
// small vault built here, with ports the test picks; one check runs the real
// bin and the real page together. Contract 13 is checked in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { statusToColumn } from "../scripts/stages.mjs";
import { WRITE_ROUTES, CODE_ROUTE, BASE_ROUTE } from "../dashboard/server.mjs";
import { WRITE_VERBS } from "../dashboard/lib/write.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { exportGoldenVault, NOW_MS } from "./fixtures/flow.mjs";
import { openCore } from "../dashboard/lib/core.mjs";
import { flow as reportsFlow } from "../dashboard/lib/reports.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO, "dashboard");
// The editor's sources and build tools (dashboard-editor), and the one file they build.
const EDITOR_SRC = join(PAGE, "editor");
const EDITOR_BUNDLE = join(PAGE, "public", "editor.bundle.js");
const EDITOR_NOTICES = join(PAGE, "THIRD-PARTY-NOTICES.txt");
const SERVER = join(PAGE, "server.mjs");
const BIN = join(REPO, "bin", "projectstore.mjs");

// A small vault: one initiative, two epics (one under it), stories in four
// statuses with two assignees, an ADR, a spec, a picture and a file the page
// must not serve.
function fixture() {
  const proj = mkdtempSync(join(tmpdir(), "ps-dash-page-"));
  const vault = join(proj, "vault");
  const put = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  put(
    "initiatives/teams-see-their-work.md",
    '---\ntype: initiative\nid: "teams-see-their-work"\ntitle: "Teams see their work"\nstatus: accepted\npriority: p1\nowner: "Ann"\n---\n\n# Teams see their work\n\n## Problem\n\nNobody sees it.\n',
  );
  put(
    "epics/PS-A/epic.md",
    '---\ntype: epic\nid: "PS-A"\ntitle: "Epic A"\nstatus: in-progress\npriority: p1\ninitiative: "teams-see-their-work"\n---\n\n# PS-A: Epic A\n\n## Goal\n\nA goal.\n',
  );
  put("epics/PS-B/epic.md", '---\ntype: epic\nid: "PS-B"\ntitle: "Epic B"\nstatus: planned\n---\n\n# PS-B: Epic B\n');
  const story = (epic, id, status, assignee) =>
    put(
      `epics/${epic}/stories/${id}.md`,
      `---\ntype: story\nid: "${id}"\nepic: "${epic}"\ntitle: "Story ${id}"\nstatus: ${status}\npriority: p2\nassignee: "${assignee}"\ncreated: 2026-11-01\n---\n\n# Story ${id}\n\n## Description\n\nIt links to [[../../../adr/a-decision|a decision]].\n\n## Acceptance Criteria\n\n- [ ] one\n`,
    );
  story("PS-A", "story-one", "planned", "Ann");
  story("PS-A", "story-two", "todo", "Bob");
  story("PS-A", "story-three", "in-progress", "Ann");
  story("PS-B", "story-four", "done", "Bob");
  put(
    "adr/a-decision.md",
    '---\ntype: adr\nid: "a-decision"\ntitle: "A decision"\nstatus: accepted\n---\n\n# A decision\n',
  );
  put("specs/a-spec.md", '---\ntype: spec\nid: "a-spec"\ntitle: "A spec"\nstatus: active\n---\n\n# A spec\n');
  put("adr/shot.png", "\x89PNG\r\n\x1a\nnot really a picture");
  put("adr/page.html", "<script>alert(1)</script>");
  put(".hidden/shot.png", "\x89PNG");
  put("kanban.md", "# Kanban\n");
  put(".projectstore.json", JSON.stringify({ flow: { people: { Ann: { wip: 2 }, Bob: { wip: 3 } } } }));
  // Links out of the vault: a story, an ADR and a picture whose files live beside it.
  const outside = join(proj, "outside");
  mkdirSync(outside);
  writeFileSync(
    join(outside, "secret.md"),
    '---\ntype: story\nid: "story-outside"\ntitle: "Outside the vault"\nstatus: todo\n---\n\n# Outside\n',
  );
  writeFileSync(join(outside, "secret.png"), "\x89PNG");
  symlinkSync(join(outside, "secret.md"), join(vault, "epics", "PS-B", "stories", "story-outside.md"));
  symlinkSync(join(outside, "secret.md"), join(vault, "adr", "linked-out.md"));
  symlinkSync(join(outside, "secret.png"), join(vault, "adr", "linked-out.png"));
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en", default_author: "Test" });
  return { proj, vault };
}

// Every file under `dir`, hashed: what "byte-identical" is checked against.
function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(relative(dir, p)).update("\0link\0");
      else if (st.isDirectory()) walk(p);
      else h.update(relative(dir, p)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

function freePort() {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

// The server as the launcher starts it. Resolves with its ready line, or
// with its exit when it ends first.
function startServer(args, { cwd = REPO } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((done) => child.on("exit", (code) => done({ code, err, out })));
  const ready = new Promise((done) => {
    child.stdout.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl !== -1) done(JSON.parse(out.slice(0, nl)));
    });
    exited.then(() => done(null));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  exited.then(() => clearTimeout(timer));
  return { child, ready, exited };
}

// A request with the Host and method the test names (fetch would not let it
// set Host).
function call(port, path, { method = "GET", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

async function withServer(fn) {
  const { proj, vault } = fixture();
  const port = await freePort();
  const s = startServer(["--core", REPO, "--project", proj, "--port", String(port)]);
  try {
    const ready = await s.ready;
    assert.ok(ready && ready.ready, (await Promise.race([s.exited, Promise.resolve({ err: "" })])).err);
    await fn({ proj, vault, port, ready });
  } finally {
    s.child.kill("SIGTERM");
    await s.exited;
  }
}

// [dashboard#8]
test("dashboard page: a core of another version is refused before listening, naming both versions", async () => {
  const { proj } = fixture();
  const core = mkdtempSync(join(tmpdir(), "ps-dash-core-"));
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "projectstore", version: "9.9.9" }));
  const s = startServer(["--core", core, "--project", proj, "--port", "0"]);
  const r = await s.exited;
  assert.equal(r.code, 1);
  assert.equal(r.out, "", "it never said it was ready");
  const own = JSON.parse(readFileSync(join(PAGE, "package.json"), "utf8")).version;
  assert.match(r.err, /9\.9\.9/);
  assert.ok(r.err.includes(own), r.err);
});

// [dashboard#9]
test("dashboard page: it listens on 127.0.0.1, refuses another Host with 403, a POST to a path that is no write route and any other method with 405, and a write route's POST without the run's token with 403", async () => {
  await withServer(async ({ vault, port, ready }) => {
    assert.equal(ready.url, `http://127.0.0.1:${port}/`);
    assert.equal(ready.port, port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
      assert.equal((await call(port, "/", { host })).status, 200, host);
    for (const host of ["evil.test", `evil.test:${port}`, "127.0.0.1", `[::1]:${port}`])
      assert.equal((await call(port, "/", { host })).status, 403, host);
    const before = treeHash(vault);
    // The scenario: WHEN a POST reaches a path that is not a write route, THEN 405 and no file changes.
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      for (const path of ["/", "/api/state", "/api/item?rel=adr/a-decision.md", "/nowhere"]) {
        const r = await call(port, path, { method });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.match(r.headers.allow || "", /GET/);
      }
    // A write route is answered under the write path's guard (dashboard-writes, contract 8).
    // So is the Code block's read (dashboard-code, contract 1).
    for (const path of ["/api/refresh", "/api/preview", "/api/action", "/api/send", "/api/discard", "/api/code"]) {
      const r = await call(port, path, { method: "POST" });
      assert.equal(r.status, 403, `POST ${path}`);
      assert.equal(JSON.parse(r.body).write.can, false, "a vault in no git repository");
      assert.equal((await call(port, path, { method: "OPTIONS" })).status, 405, `OPTIONS ${path}`);
    }
    assert.equal(treeHash(vault), before);
    const head = await call(port, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const page = await call(port, "/");
    assert.match(page.headers["content-security-policy"] || "", /script-src 'self'/);
    assert.match(page.headers["content-security-policy"] || "", /img-src 'self' data:(;|$)/);
    assert.doesNotMatch(page.headers["content-security-policy"] || "", /https:/);
  });
});

// [dashboard#10]
test("dashboard page: answering every read route leaves the vault, the project and the core byte-identical to what they were at the ready line", async () => {
  await withServer(async ({ proj, vault, port }) => {
    const snapshot = () => [
      treeHash(proj),
      treeHash(join(REPO, "scripts")),
      treeHash(PAGE),
      readFileSync(join(REPO, "package.json"), "utf8"),
    ];
    const before = snapshot();
    assert.ok(vault.startsWith(proj), "the vault is inside the project hashed");
    const index = (await call(port, "/")).body;
    for (const m of index.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g))
      assert.equal((await call(port, `/${m[1]}`)).status, 200, m[1]);
    const state = JSON.parse((await call(port, "/api/state")).body);
    const arts = JSON.parse((await call(port, "/api/artifacts")).body);
    const rels = [
      ...state.stories.map((s) => s.rel).filter(Boolean),
      ...(Array.isArray(arts) ? arts : arts.artifacts || []).map((a) => a.rel).filter(Boolean),
    ];
    assert.ok(rels.length >= 4, "the crawl reads documents");
    for (const rel of rels) {
      assert.equal((await call(port, `/api/item?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
      assert.equal((await call(port, `/api/related?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
    }
    await call(port, "/vault/adr/shot.png");
    await call(port, "/vault/adr/shot.png", {});
    assert.deepEqual(snapshot(), before);
  });
});

// [dashboard-writes#9] The write module is the one file of the page that starts
// a process or writes a file; every other file keeps the read-only rules.
test("dashboard page: no file of the page but its write module starts a process or writes a file", () => {
  const WRITER = join(PAGE, "lib", "write.mjs");
  const FS_READS = new Set([
    "readFileSync",
    "readdirSync",
    "statSync",
    "lstatSync",
    "existsSync",
    "realpathSync",
    "createReadStream",
  ]);
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (p === EDITOR_SRC) continue; // the editor's sources and build, not the page's (dashboard-editor)
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(name)) files.push(p);
    }
  };
  walk(PAGE);
  assert.ok(files.length > 3, "the page's files are read");
  assert.ok(files.includes(WRITER), "the write module is among them");
  assert.ok(
    files.includes(join(PAGE, "lib", "code.mjs")),
    "the Code block's read is among them, and starts nothing itself",
  );
  assert.match(readFileSync(WRITER, "utf8"), /from "node:child_process"/, "the write module is the one that spawns");
  for (const f of files) {
    if (f === WRITER) continue;
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /["'](?:node:)?child_process["']/, `${relative(REPO, f)} imports child_process`);
    const FS = `["'](?:node:)?fs(?:/promises)?["']`;
    for (const m of src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${FS}`, "g")))
      for (const name of m[1]
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/)[0])
        .filter(Boolean))
        assert.ok(FS_READS.has(name), `${relative(REPO, f)} takes ${name} from node:fs`);
    // The whole module, by any other form, would hide what is called on it.
    assert.doesNotMatch(
      src,
      new RegExp(`import\\s+[\\w$]+\\s*(?:,|from)[^;]*${FS}`),
      `${relative(REPO, f)} imports node:fs whole`,
    );
    assert.doesNotMatch(
      src,
      new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*${FS}`),
      `${relative(REPO, f)} imports all of node:fs`,
    );
    assert.doesNotMatch(
      src,
      new RegExp(`(?:import|require)\\s*\\(\\s*${FS}`),
      `${relative(REPO, f)} loads node:fs at run time`,
    );
  }
});

test("dashboard page: the page imports only the core modules the spec lists, and stays under 608 KiB, the editor's bundle under 768 KiB", () => {
  const LISTED = new Set([
    "lib.mjs",
    "stages.mjs",
    "flow-stories.mjs",
    "flow-policy.mjs",
    "flow-counts.mjs",
    "graph.mjs",
    "binding.mjs",
    "rank.mjs",
    // The Code block's read (dashboard-code): the core's link rules, code paths and spec bundle.
    "follow-plan.mjs",
    "code-refs.mjs",
    "spec-drift.mjs",
    // The editor (dashboard-editor): the edit verb's own cut and hash.
    "edit-cut.mjs",
    // The pictures (dashboard-attachments): a kept file's type, name and limit.
    "attachment.mjs",
    // New in the item panel (dashboard-new): a new item's template.
    "draft.mjs",
  ]);
  const seen = new Set();
  let size = 0;
  let bundle = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (p === EDITOR_SRC) continue; // not shipped (dashboard-editor)
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (p === EDITOR_BUNDLE || p === EDITOR_NOTICES) bundle += st.size;
      else {
        size += st.size;
        if (!/\.(mjs|js)$/.test(name)) continue;
        // A module of the core is named by its file under the core's scripts/.
        for (const m of readFileSync(p, "utf8").matchAll(/["'`/]([a-z][a-z-]*\.mjs)["'`]/g))
          if (existsCore(m[1])) seen.add(m[1]);
      }
    }
  };
  const existsCore = (name) => {
    try {
      return statSync(join(REPO, "scripts", name)).isFile();
    } catch {
      return false;
    }
  };
  walk(PAGE);
  assert.deepEqual(
    [...seen].filter((m) => !LISTED.has(m)),
    [],
    "no core module beyond the list",
  );
  assert.ok(seen.size >= 5, `the bridge names the core's modules (${[...seen].join(", ")})`);
  assert.ok(size < 608 * 1024, `dashboard/ is ${Math.round(size / 1024)} KiB, the editor's bundle aside`);
  // The editor is one built file of its own, with its notices, under a budget of their own (dashboard-editor).
  assert.ok(
    bundle > 0 && bundle < 768 * 1024,
    `public/editor.bundle.js and its notices are ${Math.round(bundle / 1024)} KiB`,
  );
});

// [dashboard#11]
test("dashboard page: a document is read only from the layout's folders or initiatives/, and a vault file only when it is media, with a sandbox", async () => {
  await withServer(async ({ port }) => {
    for (const rel of [
      "adr/a-decision.md",
      "specs/a-spec.md",
      "epics/PS-A/epic.md",
      "initiatives/teams-see-their-work.md",
    ]) {
      assert.equal((await call(port, `/api/item?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
      assert.equal((await call(port, `/api/related?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
    }
    for (const rel of [
      "../x.md",
      "adr/../../x.md",
      "/etc/passwd",
      "adr/page.html",
      "kanban.md",
      ".projectstore.json",
      "",
      "adr\\a-decision.md",
      "adr/a-decision.md\0",
    ]) {
      assert.equal(
        (await call(port, `/api/item?rel=${encodeURIComponent(rel)}`)).status,
        404,
        `item ${JSON.stringify(rel)}`,
      );
      assert.equal(
        (await call(port, `/api/related?rel=${encodeURIComponent(rel)}`)).status,
        404,
        `related ${JSON.stringify(rel)}`,
      );
    }
    const shot = await call(port, "/vault/adr/shot.png");
    assert.equal(shot.status, 200);
    assert.match(shot.headers["content-security-policy"] || "", /sandbox/);
    assert.equal(shot.headers["x-content-type-options"], "nosniff");
    // Encoded dot segments are refused even where the folded path names a file that exists.
    for (const path of [
      "/vault/adr/page.html",
      "/vault/.hidden/shot.png",
      "/vault/../vault/adr/shot.png",
      "/vault/adr/%2e%2e/adr/shot.png",
      "/vault/adr/.%2e/adr/shot.png",
      "/vault/adr/%2e/shot.png",
      "/vault/adr/linked-out.png",
      "/api/nothing",
      "/server.mjs",
      "/../package.json",
      // The write routes take POST only.
      "/api/refresh",
      "/api/preview",
      "/api/action",
      "/api/send",
      "/api/discard",
      // So does the Code block's read (dashboard-code, contract 1).
      "/api/code",
    ])
      assert.equal((await call(port, path)).status, 404, path);
    assert.equal(
      (await call(port, `/api/item?rel=${encodeURIComponent("adr/linked-out.md")}`)).status,
      404,
      "a link out of the vault",
    );
    // A byte range: what a video needs to seek.
    const part = await new Promise((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/vault/adr/shot.png",
          headers: { host: `127.0.0.1:${port}`, range: "bytes=0-3" },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on("error", fail);
      req.end();
    });
    assert.equal(part.status, 206);
    assert.match(part.headers["content-range"] || "", /^bytes 0-3\/\d+$/);
    assert.equal(part.headers["content-length"], "4");
    assert.match(part.headers["content-security-policy"] || "", /sandbox/);
  });
});

// [dashboard#12]
test("dashboard page: the state lists epics with their initiative, stories with the core's column, initiatives, people and every assignee", async () => {
  await withServer(async ({ port }) => {
    const state = JSON.parse((await call(port, "/api/state")).body);
    assert.deepEqual(state.epics.map((e) => e.id).sort(), ["PS-A", "PS-B"]);
    assert.equal(state.epics.find((e) => e.id === "PS-A").initiative, "teams-see-their-work");
    assert.deepEqual(
      state.initiatives.map((i) => i.id),
      ["teams-see-their-work"],
    );
    assert.equal(state.stories.length, 4);
    for (const s of state.stories) assert.equal(s.column, statusToColumn(s.status), s.ref || s.title);
    assert.deepEqual(state.assignees, ["Ann", "Bob"]);
    // [dashboard#12] `me` is the binding's default_author: the page does not ask who it already knows.
    assert.equal(state.me, "Test");
    const limits = Object.fromEntries(state.people.map((p) => [p.name, p.limit]));
    assert.equal(limits.Ann, 2);
    assert.equal(limits.Bob, 3);
    assert.ok(!state.stories.some((s) => /outside/i.test(s.title || "")), "a story linked from outside is not listed");
    const arts = JSON.parse((await call(port, "/api/artifacts")).body);
    const list = Array.isArray(arts) ? arts : arts.artifacts || [];
    assert.ok(
      !list.some((a) => /linked-out|story-outside/.test(a.rel)),
      "a document linked from outside is not listed",
    );
    assert.ok(list.some((a) => a.rel === "adr/a-decision.md"));
  });
  // No initiatives/ folder: none, and nothing else breaks. A default_author with spaces at its
  // ends is `me` trimmed [dashboard#12].
  const { proj, vault } = fixture();
  rmSync(join(vault, "initiatives"), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en", default_author: "  Ann Lee  " });
  const port = await freePort();
  const s = startServer(["--core", REPO, "--project", proj, "--port", String(port)]);
  try {
    assert.ok(await s.ready);
    const state = JSON.parse((await call(port, "/api/state")).body);
    assert.deepEqual(state.initiatives, []);
    assert.equal(state.epics.length, 2);
    assert.equal(state.me, "Ann Lee");
  } finally {
    s.child.kill("SIGTERM");
    await s.exited;
  }
  // A binding with no default_author: `me` is null, and the page asks [dashboard#12].
  const bare = fixture();
  writeBinding(bare.proj, { vault_path: bare.vault, layout: "engineering", language: "en", default_author: "" });
  const port2 = await freePort();
  const s2 = startServer(["--core", REPO, "--project", bare.proj, "--port", String(port2)]);
  try {
    assert.ok(await s2.ready);
    assert.equal(JSON.parse((await call(port2, "/api/state")).body).me, null);
  } finally {
    s2.child.kill("SIGTERM");
    await s2.exited;
  }
});

// [dashboard#7]
test("dashboard page: a range takes its first free port, and a range with none free exits 1 naming --port", async () => {
  const { proj } = fixture();
  const holders = [];
  const hold = (port) =>
    new Promise((done) => {
      const h = createServer();
      h.listen(port, "127.0.0.1", () => done(h));
      holders.push(h);
    });
  const a = await freePort();
  const first = await hold(a);
  const b = await freePort();
  try {
    // Two ports, the first taken: the server takes the second (when nothing
    // else on this machine holds it; then it must say so).
    const two = startServer(["--core", REPO, "--project", proj, "--ports", `${a}-${a + 1}`]);
    const got = await two.ready;
    if (got) {
      assert.equal(got.port, a + 1);
      two.child.kill("SIGTERM");
    }
    const twoEnd = await two.exited;
    if (!got) assert.match(twoEnd.err, /--port/);
    // A range whose only port is taken: exit 1, naming --port.
    const s = startServer(["--core", REPO, "--project", proj, "--ports", `${a}-${a}`]);
    const r = await s.exited;
    assert.equal(r.code, 1, "a range whose only port is taken");
    assert.match(r.err, /--port/);
    const t = startServer(["--core", REPO, "--project", proj, "--port", String(b)]);
    const ready = await t.ready;
    assert.equal(ready.port, b);
    t.child.kill("SIGTERM");
    await t.exited;
    const taken = startServer(["--core", REPO, "--project", proj, "--port", String(a)]);
    const rt = await taken.exited;
    assert.equal(rt.code, 1);
    assert.match(rt.err, new RegExp(String(a)));
  } finally {
    first.close();
    for (const h of holders) h.close();
  }
});

test("dashboard page: the real bin starts the real page, which refuses a POST and stops on an interrupt", async () => {
  const { proj, vault } = fixture();
  const before = treeHash(vault);
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "dashboard", "--json", "--no-open", "--port", String(port)], {
    cwd: proj,
    env: { ...process.env, PROJECTSTORE_DASHBOARD_ROOT: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((done) => child.on("exit", (code) => done(code)));
  try {
    const line = await new Promise((done) => {
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("\n")) done(out.split("\n")[0]);
      });
      exited.then(() => done(null));
    });
    assert.ok(line, err);
    const env = JSON.parse(line);
    assert.equal(env.ok, true, err);
    assert.equal(env.result.port, port);
    const state = JSON.parse((await call(port, "/api/state")).body);
    assert.equal(state.stories.length, 4);
    assert.equal((await call(port, "/api/state", { method: "POST" })).status, 405);
    child.kill("SIGINT");
    assert.equal(await exited, 0, err);
    assert.equal(treeHash(vault), before);
  } finally {
    child.kill("SIGKILL");
  }
});

// The core suite's copy of the version rule, so a change to either file is
// caught here too.
test("dashboard page: its package carries the core's version", () => {
  const core = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  assert.equal(JSON.parse(readFileSync(join(PAGE, "package.json"), "utf8")).version, core);
});

// ── the page's writes (dashboard/public/write.js) ──
// The page's scripts are classic scripts in one global scope, in the order of
// index.html; write.js runs here in a vm context of its own, over a small
// stand-in for the DOM, so its controls can be read as the page would draw them.
const PUBLIC = join(PAGE, "public");
const PAGE_SCRIPTS = [
  ...readFileSync(join(PUBLIC, "index.html"), "utf8").matchAll(/<script src="\/([^"]+)"><\/script>/g),
].map((m) => m[1]);

class FakeEl {
  constructor(tag, attrs = {}, kids = []) {
    this.tag = tag;
    this.attrs = {};
    this.kids = [];
    this.dataset = {};
    this.listeners = {};
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.classList = {
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      toggle: (c, on) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach(this.classList.add);
      else if (k.startsWith("on")) this.addEventListener(k.slice(2), v);
      else if (["value", "disabled", "hidden"].includes(k)) this[k] = v;
      else this.attrs[k] = v === true ? "" : String(v);
    }
    this.append(...kids);
  }
  append(...kids) {
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) this.kids.push(k);
  }
  replaceChildren(...kids) {
    this.kids = [];
    this.append(...kids);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, ev = {}) {
    const e = { key: "", preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, ...ev };
    return (this.listeners[type] || []).map((fn) => fn(e));
  }
  click() {
    return this.fire("click");
  }
  focus() {
    fakeDoc.activeElement = this;
  }
  get offsetParent() {
    return this.hidden ? null : {};
  }
  get tabIndex() {
    return this.attrs.tabindex === undefined ? 0 : Number(this.attrs.tabindex);
  }
  getAttribute(k) {
    if (k.startsWith("data-")) {
      const d = this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      if (d !== undefined) return String(d);
    }
    return this.attrs[k] ?? null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  // In the page while the fake document's root holds it (or it is the body).
  get isConnected() {
    return this === fakeDoc.body || !!fakeDoc.root?.contains(this);
  }
  get text() {
    return this.kids.map((k) => (k instanceof FakeEl ? k.text : String(k))).join("");
  }
  set textContent(v) {
    this.kids = [String(v)];
  }
  get textContent() {
    return this.text;
  }
  // Every element under this one, depth first.
  all() {
    return this.kids.filter((k) => k instanceof FakeEl).flatMap((k) => [k, ...k.all()]);
  }
  contains(el) {
    return el === this || this.all().includes(el);
  }
  // `tag`, `tag.class` or `.class`, comma-separated: what write.js asks for.
  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const hit = (el, p) => {
      const m = /^([a-z]*)((?:\.[\w-]+)*)(\[[\w-]+\])?$/.exec(p);
      if (!m) return false;
      if (m[1] && el.tag !== m[1]) return false;
      if (m[3] && el.getAttribute(m[3].slice(1, -1)) === null) return false;
      return m[2]
        .split(".")
        .filter(Boolean)
        .every((c) => el.classes.has(c));
    };
    return this.all().filter((el) => parts.some((p) => hit(el, p)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get buttons() {
    return this.querySelectorAll("button").concat(this.tag === "button" ? [this] : []);
  }
}
const fakeDoc = { activeElement: null, root: null, body: null };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const STORIES = [
  { ref: "PS-X/story-a", title: "A", status: "planned", column: "Backlog" },
  { ref: "PS-X/story-b", title: "B", status: "todo", column: "ToDo" },
  { ref: "PS-X/story-c", title: "C", status: "in-progress", column: "In Progress" },
];

// write.js in a context of its own: `write` is /api/state's, `answers` the
// write routes' answers by path; `calls` records every fetch it makes.
function loadWriteUi(write, answers = {}) {
  const els = {
    "#write": new FakeEl("div", { tabindex: "-1" }),
    "#modal": new FakeEl("div"),
    "#view": new FakeEl("section"),
  };
  els["#modal"].hidden = true;
  // The page: the strip, the dialog's place and the view, under one root the document searches.
  const root = new FakeEl("main", null, [els["#write"], els["#modal"], els["#view"]]);
  const calls = [];
  const toasts = [];
  const counts = { render: 0, load: 0 };
  const meta = new FakeEl("meta", { name: "projectstore-token", content: "the-run-token" });
  const document = Object.assign(fakeDoc, {
    activeElement: null,
    root,
    body: new FakeEl("body"),
    querySelector: (sel) => (sel === 'meta[name="projectstore-token"]' ? meta : root.querySelector(sel)),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  });
  const h = (tag, attrs, ...kids) => new FakeEl(tag, attrs, kids);
  const ctx = {
    S: { write, stories: STORIES, project: { name: "proj" }, coreVersion: "0.0.0" },
    document,
    h,
    $: (sel) => els[sel] || null,
    fill: (el, ...kids) =>
      el.replaceChildren(
        ...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ""),
      ),
    kv: (...pairs) =>
      h(
        "div",
        { class: "kv" },
        pairs.filter(Boolean).flatMap(([k, v]) => [h("span", null, k), h("span", null, v)]),
      ),
    ico: (name) => h("i", { class: `ico ${name}` }),
    story: (ref) => STORIES.find((s) => s.ref === ref),
    toast: (...a) => toasts.push(a),
    render: () => counts.render++,
    load: async () => counts.load++,
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET", headers: { ...(opts.headers || {}) }, body: opts.body ?? null });
      const a = answers[url] || { status: 200, body: { ok: true, result: null, write } };
      if (a.wait) await a.wait; // an answer that comes when the test lets it
      return { status: a.status, json: async () => a.body };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(join(PUBLIC, "write.js"), "utf8")}\nglobalThis.writeUi = writeUi;`, ctx, {
    filename: "write.js",
  });
  return { ui: ctx.writeUi, ctx, els, root, calls, toasts, counts };
}
const writable = (verbs = JSON.parse(JSON.stringify(WRITE_VERBS)), more = {}) => ({
  can: true,
  reason: null,
  verbs,
  default_branch: "main",
  fetched_at: "2026-11-17T08:00:00.000Z",
  batch: null,
  pull_requests: null,
  kept: [],
  ...more,
});
const BATCH = {
  branch: "dashboard/test-person/20261117T080000Z",
  started_at: "2026-11-17T08:00:00Z",
  commits: 2,
  pull_request: null,
};
// write.js's values come from another realm: compared as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
const columnOf = (name) => ({ name, shows: [name], limit: null });

test("dashboard page: its scripts, write.js among them, compile as one global scope with no name declared twice", () => {
  assert.ok(PAGE_SCRIPTS.includes("write.js"), "index.html loads write.js");
  assert.ok(
    PAGE_SCRIPTS.indexOf("write.js") > PAGE_SCRIPTS.indexOf("views.js") &&
      PAGE_SCRIPTS.indexOf("write.js") < PAGE_SCRIPTS.indexOf("item.js"),
    "write.js loads after views.js and before item.js",
  );
  const onDisk = readdirSync(PUBLIC).filter((f) => f.endsWith(".js"));
  assert.deepEqual([...onDisk].sort(), [...PAGE_SCRIPTS].sort(), "index.html loads every script of public/");
  const sources = PAGE_SCRIPTS.map((f) => readFileSync(join(PUBLIC, f), "utf8"));
  // One script: a `const`, `let` or `class` declared twice is an early error.
  assert.doesNotThrow(() => new vm.Script(sources.join("\n;\n"), { filename: "page" }));
  // A function declared twice would not throw: the later one would win, silently.
  const names = new Map();
  PAGE_SCRIPTS.forEach((f, i) => {
    for (const m of sources[i].matchAll(/^(?:async\s+)?function\s+([\w$]+)|^(?:const|let|var|class)\s+([\w$]+)/gm)) {
      const name = m[1] || m[2];
      assert.ok(!names.has(name), `${name} is declared in ${names.get(name)} and in ${f}`);
      names.set(name, f);
    }
  });
  assert.equal(names.get("writeUi"), "write.js", "write.js declares one top-level name, writeUi");
  assert.deepEqual(
    [...names].filter(([, f]) => f === "write.js").map(([n]) => n),
    ["writeUi"],
  );
});

// [dashboard-writes#8] The page reaches a write route only through write.js's
// one POST, with the run's token; no GET is used to write.
test("dashboard page: write.js sends every POST with the run's token, and only write.js names a write route", async () => {
  const { ui, calls } = loadWriteUi(writable());
  assert.deepEqual([...ui.ROUTES], [...WRITE_ROUTES], "the page's routes are the server's");
  for (const route of WRITE_ROUTES)
    await ui.post(route, route === "/api/preview" ? { verb: "move", fields: {} } : null);
  await ui.refresh();
  await settle();
  assert.equal(calls.length, WRITE_ROUTES.length + 1);
  for (const c of calls) {
    assert.ok(WRITE_ROUTES.includes(c.url), c.url);
    assert.equal(c.method, "POST", `${c.url} is posted`);
    assert.equal(c.headers["x-projectstore-token"], "the-run-token", `${c.url} carries the token`);
  }
  await assert.rejects(() => ui.post("/api/state"), /not a write route/);
  // The other scripts read with plain GETs and never name a write route.
  for (const f of PAGE_SCRIPTS) {
    const src = readFileSync(join(PUBLIC, f), "utf8");
    if (f === "write.js") {
      assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1, "write.js has one fetch, the POST");
      assert.ok(!src.includes(CODE_ROUTE), "write.js does not name the Code block's route");
      continue;
    }
    for (const r of WRITE_ROUTES) assert.ok(!src.includes(r), `${f} names ${r}`);
    // [dashboard-code#1] The Code block's one POST, in code.js alone, to its own route only.
    if (f === "code.js") {
      assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1, "code.js has one fetch, the POST");
      assert.match(src, /const ROUTE = "\/api\/code"/);
      assert.match(src, /"x-projectstore-token": token\(\)/);
      continue;
    }
    assert.ok(!src.includes(CODE_ROUTE), `${f} names ${CODE_ROUTE}`);
    // [dashboard-reports#5] Reports: one GET of the flow counts and one POST of its own, with the token.
    if (f === "reports.js") {
      assert.equal(
        [...src.matchAll(/\bfetch\(/g)].length,
        2,
        "reports.js has two fetches, the flow GET and the code POST",
      );
      assert.equal([...src.matchAll(/\bfetch\([^)]*method/g)].length, 1, "reports.js has one POST");
      assert.match(src, /const CODE_ROUTE = "\/api\/reports\/code"/);
      assert.match(
        src,
        /fetch\(CODE_ROUTE, \{\s*method: "POST",\s*headers: \{ "content-type": "application\/json", "x-projectstore-token": token\(\) \}/,
      );
      continue;
    }
    // [dashboard-editor#6] The editor's base: item.js's one POST, to its own route, with the token.
    if (f === "item.js") {
      assert.equal([...src.matchAll(/\bfetch\([^)]*method/g)].length, 1, "item.js has one POST, the base");
      assert.match(src, /const BASE_ROUTE = "\/api\/base"/);
      assert.match(
        src,
        /fetch\(BASE_ROUTE, \{ method: "POST", headers: \{ "content-type": "application\/json", "x-projectstore-token": token \}/,
      );
      continue;
    }
    assert.ok(!src.includes(BASE_ROUTE), `${f} names ${BASE_ROUTE}`);
    assert.doesNotMatch(src, /fetch\([^)]*method/, `${f} fetches with a method`);
  }
});

// [dashboard-writes#8]
test("dashboard page: a write answer with no JSON or no ok is an error the page shows, and its write is drawn", async () => {
  const next = writable({ batch: BATCH });
  const { ui, ctx } = loadWriteUi(writable(), {
    "/api/send": { status: 403, body: { error: "this route runs only for the page's own requests" } },
    "/api/discard": { status: 502, body: null },
    "/api/action": { status: 200, body: { ok: true, result: { written: true }, write: next } },
  });
  const a = await ui.post("/api/send");
  assert.equal(a.ok, false);
  assert.match(a.error, /page's own requests/);
  const b = await ui.post("/api/discard");
  assert.equal(b.ok, false);
  assert.match(b.error, /502 with no JSON/);
  await ui.post("/api/action", { verb: "move", fields: {} });
  assert.equal(ctx.S.write, next, "the answer's write is the page's now");
});

// [dashboard#13] While the vault cannot be written the page shows no control
// that writes, and one quiet line names write.reason.
test("dashboard page: a read-only vault gets no write control and one line naming write.reason", () => {
  const ro = {
    ...writable(),
    can: false,
    reason: "the vault is not in a git repository",
    batch: BATCH,
    kept: [{ branch: "dashboard/test-person/20261116T080000Z", commits: 1 }],
  };
  const { ui, els } = loadWriteUi(ro);
  for (const s of STORIES) {
    assert.deepEqual(plain(ui.movesOf(s)), [], `${s.ref} has no move`);
    assert.equal(ui.storyButtons(s), null);
    assert.deepEqual(plain(ui.storyCommands(s)), []);
    const card = ui.dragCard(new FakeEl("div", { class: "card" }), s);
    assert.ok(!card.draggable && !card.listeners.dragstart, `${s.ref}'s card cannot be dragged`);
  }
  for (const name of ["Backlog", "ToDo"]) {
    const col = ui.dropColumn(new FakeEl("div", { class: "col" }), columnOf(name));
    assert.ok(!col.dataset.dropTo && !col.listeners.drop, `${name} takes no drop`);
  }
  assert.deepEqual(plain(ui.rootCommands()), []);
  ui.paint();
  assert.deepEqual(els["#write"].buttons, [], "the strip holds no button: no Send, no Discard");
  assert.match(els["#write"].text, /Kept aside \(1\)/, "the kept list is still shown");
  const foot = ui.footLine();
  assert.equal(foot.querySelectorAll("button").length, 0);
  assert.match(foot.text, /^Changes are off here: the vault is not in a git repository/);
  // A server that says nothing about writes is read-only too, and the line says so.
  const quiet = loadWriteUi(undefined);
  assert.match(
    quiet.ui.footLine().text,
    /^Changes are off here: this server does not say whether the page can save changes/,
  );
  assert.deepEqual(plain(quiet.ui.movesOf(STORIES[0])), []);
});

// [dashboard-writes#6] No write control for a verb, a field or a value that
// write.verbs does not list.
test("dashboard page: write.js offers no move that write.verbs does not list", () => {
  const verbsWith = (fn) => fn(JSON.parse(JSON.stringify(WRITE_VERBS)));
  const none = [
    ["no verbs", []],
    [
      "another verb only",
      [
        {
          verb: "assign",
          label: "Assign",
          subject: "assign {story}",
          fields: {
            story: { kind: "story", label: "Story" },
            to: { kind: "choice", label: "To", values: [{ value: "todo", label: "Move to ToDo" }] },
          },
        },
      ],
    ],
    [
      "move without its reason",
      verbsWith((v) => {
        delete v[0].fields.reason;
        return v;
      }),
    ],
  ];
  for (const [what, verbs] of none) {
    const { ui } = loadWriteUi(writable(verbs));
    for (const s of STORIES) {
      assert.deepEqual(plain(ui.movesOf(s)), [], `${what}: ${s.ref}`);
      assert.equal(ui.storyButtons(s), null, what);
      assert.ok(!ui.dragCard(new FakeEl("div"), s).draggable, what);
    }
    assert.ok(!ui.dropColumn(new FakeEl("div"), columnOf("ToDo")).dataset.dropTo, what);
  }
  // `to` lists todo only: the backlog story moves to ToDo, the ToDo story has nothing.
  const todoOnly = loadWriteUi(
    writable(
      verbsWith((v) => {
        v[0].fields.to.values = [{ value: "todo", label: "Move to ToDo" }];
        return v;
      }),
    ),
  ).ui;
  assert.deepEqual(plain(todoOnly.movesOf(STORIES[0])), [{ to: "todo", label: "Move to ToDo" }]);
  assert.deepEqual(plain(todoOnly.movesOf(STORIES[1])), []);
  assert.equal(todoOnly.dropColumn(new FakeEl("div"), columnOf("ToDo")).dataset.dropTo, "todo");
  assert.ok(!todoOnly.dropColumn(new FakeEl("div"), columnOf("Backlog")).dataset.dropTo);
  // The verb as the server lists it: each way, and nothing for a story in work.
  const { ui } = loadWriteUi(writable());
  assert.deepEqual(plain(ui.movesOf(STORIES[0])), [{ to: "todo", label: "Move to ToDo" }]);
  assert.deepEqual(plain(ui.movesOf(STORIES[1])), [{ to: "planned", label: "Back to Backlog" }]);
  assert.deepEqual(plain(ui.movesOf(STORIES[2])), []);
  assert.ok(ui.dragCard(new FakeEl("div"), STORIES[0]).draggable);
  assert.ok(!ui.dragCard(new FakeEl("div"), STORIES[2]).draggable);
  assert.equal(ui.dropColumn(new FakeEl("div"), columnOf("Backlog")).dataset.dropTo, "planned");
  assert.ok(!ui.dropColumn(new FakeEl("div"), columnOf("In Progress")).dataset.dropTo, "no drop on a gate column");
  assert.equal(ui.storyButtons(STORIES[0]).buttons.length, 1);
  assert.deepEqual(plain(ui.storyCommands(STORIES[1]).map((c) => c.label)), ["Back to Backlog…"]);
});

// [dashboard-writes#6] The preview runs first and shows
// the core's plan; the one click on the move button runs the action.
test("dashboard page: a move previews the core's plan, and one click on its button runs the action with no second confirm", async () => {
  const plan = {
    story: "PS-X/story-a",
    path: "/vault/epics/PS-X/stories/story-a.md",
    from: "planned",
    to: "todo",
    reason: "ready",
    actor: "move",
    written: false,
  };
  const { ui, els, calls, counts } = loadWriteUi(writable(), {
    "/api/preview": { status: 200, body: { ok: true, result: plan, write: writable() } },
    "/api/action": {
      status: 200,
      body: { ok: true, result: { ...plan, written: true }, write: writable([], { batch: { ...BATCH, commits: 1 } }) },
    },
  });
  ui.openMove("PS-X/story-a", "todo");
  const box = els["#modal"].kids[0];
  assert.ok(!els["#modal"].hidden, "the dialog is open");
  const input = box.querySelector("input");
  const primary = box.querySelector("button.primary");
  assert.equal(primary.text, "Preview");
  assert.ok(primary.disabled, "no preview with no reason");
  input.value = "ready";
  input.fire("input");
  assert.ok(!primary.disabled);
  primary.click();
  await settle();
  assert.deepEqual(
    calls.map((c) => [c.url, JSON.parse(c.body)]),
    [["/api/preview", { verb: "move", fields: { story: "PS-X/story-a", to: "todo", reason: "ready" } }]],
  );
  assert.match(box.text, /What will change/);
  assert.ok(box.text.includes(plan.path), "the plan names the story's path in the bound vault");
  assert.equal(primary.text, "Move to ToDo");
  // An edited reason needs a new preview before the button moves anything.
  input.value = "ready now";
  input.fire("input");
  assert.equal(primary.text, "Preview");
  input.value = "ready";
  input.fire("input");
  primary.click();
  await settle();
  assert.equal(calls.length, 2, "Preview again");
  primary.click();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/preview", "/api/preview", "/api/action"],
  );
  assert.ok(els["#modal"].hidden, "the dialog closed on the action's answer, with no dialog after it");
  assert.ok(counts.load >= 1, "the board is read again after the action");
  assert.match(els["#write"].text, /in ToDo/);
});

// [dashboard-writes#6] A refusal shows the core's own message, and the dialog stays.
test("dashboard page: a refused preview or action shows the core's own message in the dialog", async () => {
  const refusal = "no gate moves a story from done to todo: move changes only planned to todo and todo to planned.";
  const { ui, els, calls } = loadWriteUi(writable(), {
    "/api/preview": {
      status: 200,
      body: { ok: false, result: { story: "PS-X/story-a", error: refusal }, error: refusal, write: writable() },
    },
  });
  ui.openMove("PS-X/story-a", "todo");
  const box = els["#modal"].kids[0];
  box.querySelector("input").value = "why";
  box.querySelector("input").fire("input");
  box.querySelector("button.primary").click();
  await settle();
  assert.equal(calls.length, 1);
  assert.ok(!els["#modal"].hidden, "the dialog stays open");
  assert.ok(box.text.includes(refusal), "the core's words are shown");
  assert.equal(box.querySelector("button.primary").text, "Preview", "nothing can be moved on a refused plan");
  // A move the page does not offer opens no dialog and posts nothing.
  els["#modal"].hidden = true;
  ui.openMove("PS-X/story-c", "todo");
  assert.ok(els["#modal"].hidden);
  assert.equal(calls.length, 1);
});

// [dashboard-delivery#6] The strip shows the batch, its
// pull request and the kept branches, each time it shows the batch.
test("dashboard page: the batch strip shows the branch, its count, the pull request, Send and Discard, and the kept branches", async () => {
  const kept = [
    {
      branch: "dashboard/test-person/20261116T080000Z",
      commits: 3,
      stopped_at: { sha: "abcdef0123", subject: "move x", reason: "it does not apply on the default branch" },
    },
    { branch: "dashboard/test-person/20261115T080000Z", commits: null, reason: "fatal: bad object" },
  ];
  const pr = { number: 7, state: "OPEN", url: "https://github.com/acme/vault/pull/7" };
  const { ui, els, calls } = loadWriteUi(
    writable(undefined, { batch: { ...BATCH, pull_request: pr }, kept, pull_requests: null }),
    {
      "/api/send": {
        status: 200,
        body: {
          ok: true,
          result: { branch: BATCH.branch, sent: true, commits: 2, merged: 0, pull_request: pr, gh: null },
          write: writable(),
        },
      },
    },
  );
  ui.paint();
  const bar = els["#write"];
  assert.ok(!bar.hidden);
  const text = bar.text;
  for (const s of [
    "2 changes · review request open",
    "Waiting for review",
    BATCH.branch,
    "2 commits not in main",
    "PR #7 · open",
    "Kept aside (2)",
    "3 changes not in the backlog",
    "Stopped at abcdef0",
    "it does not apply",
    "count unknown",
    "fatal: bad object",
  ])
    assert.ok(text.includes(s), `the strip says ${s}`);
  assert.equal(bar.querySelector("a").attrs.href, pr.url);
  assert.doesNotMatch(text, /\bgit (push|branch)\b/, "the page prints no command for a kept branch");
  assert.deepEqual(plain(bar.buttons.map((b) => b.text).filter((t) => t !== "✕")), [
    "Publish again…",
    "Discard changes…",
  ]);
  // The branch, the commit count and the pull request's number stand under Details only.
  const more = bar.querySelectorAll("details").find((d) => d.text.startsWith("Details"));
  assert.ok(
    more && more.text.includes(BATCH.branch) && more.text.includes("2 commits not in main"),
    "Details holds the branch and its commits",
  );
  assert.ok(!bar.text.replace(more.text, "").includes(BATCH.branch), "the branch is named nowhere else in the strip");
  // Publish asks first, saying what it will do; its button runs /api/send.
  bar.buttons.find((b) => b.text === "Publish again…").click();
  const dlg = els["#modal"].kids[0];
  assert.match(dlg.text, /Your 2 changes join your open review request/);
  assert.match(dlg.text, new RegExp(`Push branch ${BATCH.branch} with 2 commits`));
  assert.equal(calls.length, 0, "nothing runs before the click in the dialog");
  dlg.querySelector("button.primary").click();
  await settle();
  assert.deepEqual(
    calls.map((c) => [c.url, c.method]),
    [["/api/send", "POST"]],
  );
  assert.match(els["#write"].text, /Published 2 changes for review\. Review request: pull request #7/);
  // gh answering and no pull request: the changes are not published yet.
  const fresh = loadWriteUi(writable(undefined, { batch: BATCH }));
  fresh.ui.paint();
  assert.match(fresh.els["#write"].text, /^2 changes not published yet/);
  assert.deepEqual(plain(fresh.els["#write"].buttons.map((b) => b.text)), ["Publish for review…", "Discard changes…"]);
  // gh that cannot be asked is not said in the strip, but in the Publish dialog: what to do, and why under Details.
  const noGh = loadWriteUi(writable(undefined, { batch: BATCH, pull_requests: "gh is not installed" }));
  noGh.ui.paint();
  assert.doesNotMatch(noGh.els["#write"].text, /gh is not installed|cannot ask GitHub/);
  assert.match(
    noGh.els["#write"].text,
    /2 changes not in the backlog yet/,
    "with gh out of reach the strip does not claim the changes are unpublished",
  );
  noGh.ui.confirmSend();
  const ghDlg = noGh.els["#modal"].kids[0];
  assert.match(
    ghDlg.text,
    /cannot ask GitHub about review requests, so it cannot open.*install GitHub's command-line tool gh and sign in with gh auth login/,
  );
  assert.match(
    ghDlg
      .querySelectorAll("details")
      .map((d) => d.text)
      .join(""),
    /Why GitHub cannot be asked: gh is not installed/,
  );
});

// [dashboard-delivery#4] Discard says nothing is deleted;
// a carry's stop is said with its reason.
test("dashboard page: Discard asks first and shows the server's message, and Send's carry names where it stopped", async () => {
  const { ui, els, calls } = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/discard": {
      status: 200,
      body: { ok: true, result: { message: "the batch ended on this machine; its branch is kept" }, write: writable() },
    },
  });
  ui.confirmDiscard();
  const dlg = els["#modal"].kids[0];
  assert.match(dlg.text, /Nothing is deleted/);
  dlg.querySelector("button.primary").click();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/discard"],
  );
  // [dashboard-delivery#4] The note follows how the batch ended: here, a review request may stay open.
  assert.match(els["#write"].text, /Your changes were discarded and kept aside on this computer\./);
  const why = els["#write"]
    .querySelectorAll("details")
    .map((d) => d.text)
    .join("");
  assert.match(
    why,
    /The batch ended on this machine; its branch is kept/,
    "the server's own line stands under Details",
  );
  const merged = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/discard": {
      status: 200,
      body: {
        ok: true,
        result: {
          ended: "merged",
          pull_request: { number: 7, state: "MERGED", url: null },
          batch: "dashboard/test-person/2",
          message: "carried",
        },
        write: writable(),
      },
    },
  });
  merged.ui.confirmDiscard();
  merged.els["#modal"].kids[0].querySelector("button.primary").click();
  await settle();
  assert.match(merged.els["#write"].text, /Your review request was merged already: your changes are in the backlog\./);
  // With gh out of reach, a review request may stay open, and the note says so in sight.
  const noGh = loadWriteUi(writable(undefined, { batch: BATCH, pull_requests: "gh is not installed" }), {
    "/api/discard": {
      status: 200,
      body: {
        ok: true,
        result: { ended: "here", pull_request: null, message: "x" },
        write: writable(undefined, { pull_requests: "gh is not installed" }),
      },
    },
  });
  noGh.ui.confirmDiscard();
  assert.match(noGh.els["#modal"].kids[0].text, /a review request for them, if one is open, stays open/);
  noGh.els["#modal"].kids[0].querySelector("button.primary").click();
  await settle();
  assert.match(noGh.els["#write"].text, /stays open on your code host: close it there/);
  const words = ui.sendWords({
    ok: true,
    result: {
      branch: "dashboard/p/2",
      sent: true,
      commits: 1,
      pull_request: null,
      gh: null,
      carry: {
        from: "dashboard/p/1",
        branch: "dashboard/p/2",
        carried: [{ sha: "a", subject: "x" }],
        skipped: [],
        stopped_at: { sha: "bbbbbbbbb", subject: "y", reason: "it does not apply on the default branch" },
        left: [],
      },
    },
  });
  assert.match(
    words,
    /1 change made after the last publish was kept for your next review \(moved from dashboard\/p\/1 into dashboard\/p\/2\)/,
  );
  assert.match(words, /one change could not be kept, "y" \(bbbbbbb\), because it does not apply on the default branch/);
});

test("dashboard page: a pull request whose url is not http or https gets no link", () => {
  for (const url of ["javascript:alert(1)", "JavaScript:void(0)", "data:text/html,x", "", null]) {
    const { ui, els } = loadWriteUi(
      writable(undefined, { batch: { ...BATCH, pull_request: { number: 3, state: "OPEN", url } } }),
    );
    ui.paint();
    assert.equal(els["#write"].querySelectorAll("a").length, 0, `no link for ${url}`);
    assert.match(els["#write"].text, /PR #3 · open/, "the state is still said");
  }
});

test("dashboard page: a refresh that leaves the page unable to write says so, and never that the batch was merged", async () => {
  const { ui, els, ctx } = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/refresh": {
      status: 200,
      body: { ok: true, result: null, write: { ...writable(), can: false, reason: "the clone's origin differs" } },
    },
  });
  await ui.refresh();
  await settle();
  assert.equal(ctx.S.write.can, false);
  const text = els["#write"].text;
  assert.doesNotMatch(text, /merged|ended/, text);
  assert.match(
    text,
    /cannot save changes now: the clone's origin differs\. Your unpublished changes stay on this computer\./,
  );
  // With the page still writable, a batch that went away and is not kept was merged.
  const merged = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/refresh": { status: 200, body: { ok: true, result: null, write: writable() } },
  });
  await merged.ui.refresh();
  await settle();
  assert.match(merged.els["#write"].text, /Your changes were merged into the backlog\./);
  // A kept batch: closed without a merge, or merged with a carry that stopped (only a merge carries).
  const kept = (k) =>
    loadWriteUi(writable(undefined, { batch: BATCH }), {
      "/api/refresh": { status: 200, body: { ok: true, result: null, write: writable(undefined, { kept: [k] }) } },
    });
  const closed = kept({ branch: BATCH.branch, commits: 2 });
  await closed.ui.refresh();
  await settle();
  assert.match(closed.els["#write"].text, /Your review request was closed without being merged\./);
  const stopped = kept({
    branch: BATCH.branch,
    commits: 2,
    stopped_at: { sha: "abcdef0123", subject: "move x", reason: "it does not apply" },
  });
  await stopped.ui.refresh();
  await settle();
  assert.match(
    stopped.els["#write"].text,
    /Your review request was merged, but one change made after you published could not be kept, "move x": it does not apply\./,
  );
  assert.doesNotMatch(stopped.els["#write"].text, /closed without being merged/);
});

test("dashboard page: Escape closes a dialog and gives the focus back; Discard's starts on Cancel", () => {
  const { ui, els, root } = loadWriteUi(writable(undefined, { batch: BATCH }));
  const opener = new FakeEl("button", { class: "btn" }, ["Move to ToDo…"]);
  root.append(opener);
  opener.focus();
  ui.openMove("PS-X/story-a", "todo");
  const box = els["#modal"].kids[0];
  assert.equal(fakeDoc.activeElement, box.querySelector("input"), "the reason has the focus");
  box.fire("keydown", { key: "Escape" });
  assert.ok(els["#modal"].hidden, "Escape closed it");
  assert.equal(fakeDoc.activeElement, opener, "the focus is back on the opener");
  ui.confirmDiscard();
  const d = els["#modal"].kids[0];
  assert.equal(fakeDoc.activeElement.text, "Cancel", "Discard's dialog starts on Cancel, not on Discard");
  d.fire("keydown", { key: "Escape" });
  assert.equal(fakeDoc.activeElement, opener);
});

test("dashboard page: a failed preview gives the focus back to the reason, and a double click on Move posts once", async () => {
  const refusal = "move: the story changed meanwhile";
  const failing = loadWriteUi(writable(), {
    "/api/preview": { status: 200, body: { ok: false, error: refusal, write: writable() } },
  });
  failing.ui.openMove("PS-X/story-a", "todo");
  const fbox = failing.els["#modal"].kids[0];
  fbox.querySelector("input").value = "why";
  fbox.querySelector("input").fire("input");
  fbox.querySelector("button.primary").click();
  await settle();
  assert.equal(fakeDoc.activeElement, fbox.querySelector("input"), "the focus is back in the dialog, on the reason");

  const plan = { story: "PS-X/story-a", path: "/vault/x.md", from: "planned", to: "todo", reason: "r" };
  let release;
  const { ui, els, calls } = loadWriteUi(writable(), {
    "/api/preview": { status: 200, body: { ok: true, result: plan, write: writable() } },
    "/api/action": {
      status: 200,
      wait: new Promise((r) => (release = r)),
      body: { ok: true, result: { ...plan, written: true }, write: writable() },
    },
  });
  ui.openMove("PS-X/story-a", "todo");
  const box = els["#modal"].kids[0];
  box.querySelector("input").value = "r";
  box.querySelector("input").fire("input");
  box.querySelector("button.primary").click();
  await settle();
  const move = box.querySelector("button.primary");
  assert.equal(move.text, "Move to ToDo");
  move.click();
  move.click();
  release();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/preview", "/api/action"],
    "one action for two clicks",
  );
});

test("dashboard page: Send and Discard do not open while a step runs", async () => {
  let release;
  const { ui, els, toasts } = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/refresh": {
      status: 200,
      wait: new Promise((r) => (release = r)),
      body: { ok: true, result: null, write: writable(undefined, { batch: BATCH }) },
    },
  });
  const running = ui.refresh();
  await settle();
  ui.confirmSend();
  ui.confirmDiscard();
  assert.ok(els["#modal"].hidden, "no dialog opened");
  assert.equal(toasts.length, 2, "each says a step is running");
  release();
  await running;
  ui.confirmSend();
  assert.ok(!els["#modal"].hidden, "Send opens once the step has ended");
});

test("dashboard page: dragend clears the drop highlight, and the kept list opens when an entry needs a look", () => {
  const { ui, root, ctx } = loadWriteUi(
    writable(undefined, { kept: [{ branch: "dashboard/p/1", commits: null, reason: "fatal: bad object" }] }),
  );
  const col = ui.dropColumn(new FakeEl("div", { class: "col" }), columnOf("ToDo"));
  const back = ui.dropColumn(new FakeEl("div", { class: "col" }), columnOf("Backlog"));
  const card = ui.dragCard(new FakeEl("div", { class: "card" }), STORIES[0]);
  root.append(col, back, card);
  card.fire("dragstart", { dataTransfer: { setData() {} } });
  assert.ok(col.classes.has("drop-ok"), "ToDo takes the backlog story");
  assert.ok(!back.classes.has("drop-ok"), "the Backlog column does not");
  assert.ok(ctx.document.body.classes.has("dragging"));
  card.fire("dragend");
  assert.ok(!col.classes.has("drop-ok") && !col.classes.has("drop-over"), "the highlight is gone");
  assert.ok(!ctx.document.body.classes.has("dragging"));
  ui.paint();
  const details = root.querySelector("details");
  assert.equal(details.getAttribute("open"), "", "a branch git cannot count opens the list");
  const calm = loadWriteUi(writable(undefined, { kept: [{ branch: "dashboard/p/1", commits: 2 }] }));
  calm.ui.paint();
  assert.equal(calm.root.querySelector("details").getAttribute("open"), null, "a plain kept branch leaves it closed");
});

test("dashboard page: a card dropped on the ToDo column opens that move's dialog, and a column the story cannot go to takes no drop", () => {
  const { ui, root, els } = loadWriteUi(writable());
  const col = ui.dropColumn(new FakeEl("div", { class: "col" }), columnOf("ToDo"));
  const back = ui.dropColumn(new FakeEl("div", { class: "col" }), columnOf("Backlog"));
  const card = ui.dragCard(new FakeEl("div", { class: "card" }), STORIES[0]);
  root.append(col, back, card);
  card.fire("dragstart", { dataTransfer: { setData() {} } });
  let stopped = false;
  back.fire("drop", {
    preventDefault() {
      stopped = true;
    },
  });
  assert.ok(!stopped && els["#modal"].hidden, "the Backlog column ignores the drop");
  col.fire("drop", {
    preventDefault() {
      stopped = true;
    },
  });
  assert.ok(stopped, "the ToDo column takes the drop");
  assert.ok(!els["#modal"].hidden, "the move's dialog is open");
  const box = els["#modal"].kids[0];
  assert.equal(box.getAttribute("aria-label"), "Move to ToDo");
  assert.equal(box.querySelector("button.primary").text, "Preview", "nothing is written by the drop itself");
  assert.ok(!col.classes.has("drop-ok") && !col.classes.has("drop-over"), "the highlight is gone after the drop");
});

test("dashboard page: a note starts with a capital only when its first word is plain prose", async () => {
  const cases = [
    ["the batch ended", "The batch ended"],
    ["gh cannot be asked", "gh cannot be asked"],
    ["git could not fetch", "git could not fetch"],
    ["dashboard/p/1 is kept", "dashboard/p/1 is kept"],
    ["kanban.md changed", "kanban.md changed"],
  ];
  for (const [said, shown] of cases) {
    const { ui, els } = loadWriteUi(writable(undefined, { batch: BATCH }), {
      "/api/discard": { status: 200, body: { ok: true, result: { message: said }, write: writable() } },
    });
    ui.confirmDiscard();
    els["#modal"].kids[0].querySelector("button.danger").click();
    await settle();
    assert.ok(els["#write"].text.includes(shown), `${said} → ${els["#write"].text}`);
  }
});

// ─── handover, and a dialog drawn from its entry (dashboard-writes contract 10) ───

const HELD = { ref: "PS-X/story-h", title: "H", status: "in-progress", column: "In Progress", assignee: "Ann" };
function loadWithHeld(write, answers) {
  const r = loadWriteUi(write, answers);
  r.ctx.S.stories = [
    ...STORIES,
    HELD,
    { ref: "PS-X/story-d", title: "D", status: "done", column: "Done", assignee: "Ann" },
    { ref: "PS-X/story-p", title: "P", status: "parked", column: null, assignee: "Ann" },
  ];
  r.ctx.S.people = [
    { name: "Ann", left: null },
    { name: "Bea", left: null },
    { name: "Cid", left: "2026-11-01" },
  ];
  r.ctx.S.assignees = ["Ann", "Dan"];
  r.ctx.story = (ref) => r.ctx.S.stories.find((x) => x.ref === ref);
  return r;
}

// [dashboard-writes#10]
test("dashboard page: Hand over is offered on a story someone holds whose column is set and is not Done, nowhere else, and only while write.verbs lists handover", () => {
  const { ui, ctx } = loadWithHeld(writable());
  const by = (ref) => ctx.S.stories.find((x) => x.ref === ref);
  assert.equal(ui.canHandOver(HELD), true);
  for (const ref of ["PS-X/story-a", "PS-X/story-d", "PS-X/story-p"]) assert.equal(ui.canHandOver(by(ref)), false, ref);
  const buttons = ui.storyButtons(HELD).buttons;
  assert.deepEqual(
    buttons.map((b) => b.text),
    ["Hand over…"],
  );
  assert.equal(buttons[0].getAttribute("data-focus"), "handover");
  assert.deepEqual(
    plain(ui.storyCommands(HELD)).map((c) => c.label),
    ["Hand over…"],
  );
  const moveOnly = loadWithHeld(writable(JSON.parse(JSON.stringify(WRITE_VERBS)).filter((v) => v.verb === "move"))).ui;
  assert.equal(moveOnly.canHandOver(HELD), false);
  assert.equal(moveOnly.storyButtons(HELD), null);
});

// [dashboard-writes#10]
test("dashboard page: the handover dialog takes its title, labels, button word and subject from the entry, suggests the vault's names without anyone left and without from, and a changed label changes the dialog", async () => {
  const changed = JSON.parse(JSON.stringify(WRITE_VERBS));
  changed[1].label = "Give away";
  changed[1].fields.to.label = "Taker";
  for (const [verbs, title, toLabel] of [
    [JSON.parse(JSON.stringify(WRITE_VERBS)), "Hand over", "To"],
    [changed, "Give away", "Taker"],
  ]) {
    const { ui, els } = loadWithHeld(writable(verbs));
    ui.openHandover(HELD.ref);
    assert.ok(!els["#modal"].hidden, "the dialog is open");
    const box = els["#modal"].kids[0];
    assert.equal(box.getAttribute("aria-label"), title);
    const [to, reason] = box.querySelectorAll("input");
    assert.equal(to.getAttribute("aria-label"), toLabel);
    assert.equal(reason.getAttribute("aria-label"), "Why, in one line");
    const names = box.querySelectorAll("option").map((o) => o.value);
    assert.deepEqual(names, ["Bea", "Dan"], "no one marked left, and not the giver");
    to.value = "Bea";
    to.fire("input");
    reason.value = "Ann is away";
    reason.fire("input");
    assert.match(box.querySelector(".subject").text, /^Commit: hand over PS-X\/story-h from Ann to Bea: Ann is away$/);
    // [dashboard-writes#10] as amended 2026-11-20: the subject stands under Details.
    assert.ok(
      box.querySelectorAll("details").some((d) => d.contains(box.querySelector(".subject"))),
      "the commit's subject is under Details",
    );
    assert.equal(box.querySelector("button.primary").text, "Preview");
  }
  // The button's word after a preview is the entry's label too.
  const plan = {
    from: "Ann",
    to: "Bea",
    reason: "r",
    story: HELD.ref,
    items: [{ story: HELD.ref, path: "x.md" }],
    wip: null,
    notes: [],
  };
  const { ui, els } = loadWithHeld(writable(changed), {
    "/api/preview": { status: 200, body: { ok: true, result: plan, write: writable(changed) } },
  });
  ui.openHandover(HELD.ref);
  const box = els["#modal"].kids[0];
  const [to, reason] = box.querySelectorAll("input");
  to.value = "Bea";
  to.fire("input");
  reason.value = "r";
  reason.fire("input");
  box.querySelector("button.primary").click();
  await settle();
  assert.equal(box.querySelector("button.primary").text, "Give away");
});

// [dashboard-writes#10]
test("dashboard page: a handover the core refuses shows the core's words and never says the story is the receiver's already", async () => {
  const refused = {
    from: "Ann",
    to: "Cid",
    reason: "r",
    story: HELD.ref,
    items: [],
    wip: null,
    notes: [],
    error:
      "--to Cid is marked left (flow.people[Cid].left is 2026-11-01), so the work cannot go to them; name someone who has not left",
  };
  const { ui, els } = loadWithHeld(writable(), {
    "/api/preview": { status: 200, body: { ok: false, result: refused, error: refused.error, write: writable() } },
  });
  ui.openHandover(HELD.ref);
  const box = els["#modal"].kids[0];
  const [to, reason] = box.querySelectorAll("input");
  to.value = "Cid";
  to.fire("input");
  reason.value = "r";
  reason.fire("input");
  box.querySelector("button.primary").click();
  await settle();
  assert.match(box.text, /Cid is marked left/);
  assert.doesNotMatch(box.text, /already/);
  assert.equal(box.querySelector("button.primary").text, "Preview", "no click goes through on a refusal");
});

// [dashboard-writes#10]
test("dashboard page: a story in ToDo that someone holds offers its move and Hand over side by side, each with its own data-focus; a handover that commits says whose the story is now", async () => {
  const todoHeld = { ref: "PS-X/story-t", title: "T", status: "todo", column: "ToDo", assignee: "Ann" };
  const plan = {
    from: "Ann",
    to: "Bea",
    reason: "r",
    story: todoHeld.ref,
    items: [{ story: todoHeld.ref, path: "t.md" }],
    wip: null,
    notes: [],
  };
  const after = writable(undefined, {
    batch: {
      branch: "dashboard/p/20261118T000000Z",
      started_at: "2026-11-18T00:00:00.000Z",
      commits: 1,
      pull_request: null,
    },
  });
  const r = loadWithHeld(writable(), {
    "/api/preview": { status: 200, body: { ok: true, result: plan, write: writable() } },
    "/api/action": { status: 200, body: { ok: true, result: { ...plan, write: true }, write: after } },
  });
  r.ctx.S.stories.push(todoHeld);
  const buttons = r.ui.storyButtons(todoHeld).buttons;
  assert.deepEqual(
    buttons.map((b) => b.text),
    ["Back to Backlog…", "Hand over…"],
  );
  assert.deepEqual(
    buttons.map((b) => b.getAttribute("data-focus")),
    ["move-planned", "handover"],
  );
  r.ui.openHandover(todoHeld.ref);
  const box = r.els["#modal"].kids[0];
  const [to, reason] = box.querySelectorAll("input");
  to.value = "Bea";
  to.fire("input");
  reason.value = "r";
  reason.fire("input");
  box.querySelector("button.primary").click();
  await settle();
  box.querySelector("button.primary").click();
  await settle();
  assert.match(r.els["#write"].text, /T is Bea's now\./);
});

// [dashboard-writes#10]
test("dashboard page: a handover previews the core's plan with both people, the WIP warning and each note; an edit turns the button back to Preview; the click sends the fields of the plan on screen; an unchanged batch says nothing was written", async () => {
  const plan = {
    write: false,
    from: "Ann",
    to: "Bea",
    reason: "Ann is away",
    story: "PS-X/story-h",
    items: [{ story: "PS-X/story-h", path: "epics/PS-X/stories/story-h.md", from: "Ann", to: "Bea" }],
    wip: { assignee: "Bea", held: 3, moving: 1, after: 4, limit: 3, over: true },
    notes: [{ id: "person-unseen", message: "--to Bea: no story names them as assignee; check the spelling." }],
  };
  const { ui, els, calls, ctx } = loadWithHeld(writable(), {
    "/api/preview": { status: 200, body: { ok: true, result: plan, write: writable() } },
    "/api/action": { status: 200, body: { ok: true, result: { ...plan, write: true }, write: writable() } },
  });
  ui.openHandover(HELD.ref);
  const box = els["#modal"].kids[0];
  const [to, reason] = box.querySelectorAll("input");
  const primary = box.querySelector("button.primary");
  to.value = "Bea";
  to.fire("input");
  reason.value = "Ann is away";
  reason.fire("input");
  primary.click();
  await settle();
  const shown = box.text;
  assert.match(shown, /Ann → Bea/);
  assert.match(shown, /Bea would hold 4 stories in progress against a limit of 3/);
  assert.match(shown, /check the spelling/);
  assert.equal(primary.text, "Hand over");
  // An edit after the preview: the button is Preview again, and nothing is sent.
  to.value = "Dan";
  to.fire("input");
  assert.equal(primary.text, "Preview");
  primary.click();
  await settle();
  const previews = calls.filter((c) => c.url === "/api/preview").map((c) => JSON.parse(c.body).fields.to);
  assert.deepEqual(previews, ["Bea", "Dan"]);
  assert.equal(calls.filter((c) => c.url === "/api/action").length, 0, "no action before a fresh plan");
  primary.click();
  await settle();
  const actions = calls.filter((c) => c.url === "/api/action").map((c) => JSON.parse(c.body));
  assert.deepEqual(actions, [
    { verb: "handover", fields: { story: "PS-X/story-h", from: "Ann", to: "Dan", reason: "Ann is away" } },
  ]);
  assert.ok(els["#modal"].hidden, "the dialog closes");
  assert.match(
    ctx.document.root.querySelector("#write")?.text ?? els["#write"].text,
    /Nothing was written: H is Dan's already/,
  );
});

// ── the Code block (dashboard/public/code.js; the spec alias `dashboard-code`) ──
// code.js in a context of its own, as write.js above: `answer` is what
// POST /api/code answers; `calls` records every fetch.
function loadCodeUi(answer) {
  const calls = [];
  const counts = { render: 0 };
  const meta = new FakeEl("meta", { name: "projectstore-token", content: "the-run-token" });
  const h = (tag, attrs, ...kids) => new FakeEl(tag, attrs, kids);
  const ctx = {
    ui: { drawer: null },
    document: { querySelector: (sel) => (sel === 'meta[name="projectstore-token"]' ? meta : null) },
    h,
    ico: (name) => h("i", { class: `ico ${name}` }),
    story: (ref) => (ref === "PS-X/story-a" ? { ref, rel: "epics/PS-X/stories/story-a.md" } : null),
    artByRel: new Map([["specs/s.md", { type: "spec" }]]),
    statusPill: (s) => h("span", { class: "pill" }, s),
    openByRel: () => {},
    renderDrawer: () => counts.render++,
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET", headers: { ...(opts.headers || {}) }, body: opts.body ?? null });
      return { status: 200, json: async () => answer };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(join(PUBLIC, "code.js"), "utf8")}\nglobalThis.codeUi = codeUi;`, ctx, {
    filename: "code.js",
  });
  return { code: ctx.codeUi, ctx, calls, counts };
}
const MAIN = {
  ref: "refs/remotes/origin/main",
  short: "main",
  fetched: true,
  hash: "abc123456",
  date: "2026-11-18T10:00:00Z",
  fetchedAt: "2026-11-18T09:00:00Z",
  shallow: false,
  behind: 3,
};
const prRow = (number, how, more = {}) => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `pull request ${number}`,
  state: "merged",
  mergedAt: "2026-11-10T00:00:00Z",
  how,
  link: how.some((x) => x === "recorded" || x === "closes"),
  files: 4,
  inside: 2,
  ...more,
});
const storyResult = (more = {}) => ({
  kind: "story",
  rel: "epics/PS-X/stories/story-a.md",
  repo: "acme/app",
  main: MAIN,
  listFull: false,
  unknown: { git: null, prs: null },
  refs: ["scripts/"],
  refsForm: "json",
  skipped: [],
  window: { since: "2026-11-10", until: null },
  windowReason: null,
  commits: [{ hash: "abc123456", date: "2026-11-10T10:00:00Z", subject: "a commit", files: 1, pr: 1 }],
  commitCount: 1,
  truncated: false,
  loose: 0,
  prs: [prRow(1, ["recorded"]), prRow(2, ["named"]), prRow(3, ["named", "mentioned"]), prRow(4, ["derived"])],
  ...more,
});
async function drawn(answer, d = { kind: "story", id: "PS-X/story-a" }) {
  const { code, ctx, calls } = loadCodeUi(answer);
  ctx.ui.drawer = d;
  await code.ask(d);
  await settle();
  return { el: code.block(d), calls, code, d };
}
const texts = (el, sel) => el.querySelectorAll(sel).map((x) => x.text);

// [dashboard-code#11]
test("dashboard page: the Code block lists the links and the leads apart, each tie labelled, and the derived rows folded", async () => {
  const { el, calls } = await drawn({ ok: true, result: storyResult() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CODE_ROUTE);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-projectstore-token"], "the-run-token");
  assert.deepEqual(JSON.parse(calls[0].body), { rel: "epics/PS-X/stories/story-a.md" });
  assert.deepEqual(texts(el, ".code-h"), ["Linked pull requests", "Maybe related, not linked"]);
  const rows = el.querySelectorAll(".code-pr");
  assert.deepEqual(
    rows.map((r) => r.querySelectorAll(".chip.how").map((c) => c.text)),
    [["recorded"], ["named"], ["named", "in the story's text"], ["by its commits"]],
  );
  assert.ok(rows[0].classes.has("code-pr") && !rows[0].classes.has("code-lead"), "the link is no lead");
  assert.ok(rows[1].classes.has("code-lead"));
  const folded = el.querySelectorAll("details").find((x) => x.text.includes("Found by commits alone"));
  assert.ok(folded && folded.attrs.open === undefined, "the derived rows stand folded");
  assert.ok(folded.contains(rows[3]));
  assert.match(el.text, /2 of 4 files in the story's code paths/);
  assert.match(el.text, /main at abc123456/);
  assert.match(el.text, /3 commits behind/);
  const level = await drawn({ ok: true, result: storyResult({ main: { ...MAIN, behind: 0 } }) });
  assert.match(level.el.text, /the checkout is not behind it/);
  const unknown = await drawn({ ok: true, result: storyResult({ main: { ...MAIN, behind: null } }) });
  assert.match(unknown.el.text, /how far the checkout is behind is unknown/);
  assert.match(el.text, /last fetched/);
});

// [dashboard-code#11]
test("dashboard page: with gh logged out the Code block says the pull requests are unknown and why, and lists the commits", async () => {
  const { el } = await drawn({
    ok: true,
    result: storyResult({
      unknown: { git: null, prs: "gh is not logged in (gh auth login)" },
      prs: [
        prRow(1, ["recorded"], {
          state: null,
          files: null,
          inside: null,
          filesReason: "the pull requests could not be read",
        }),
      ],
      loose: null,
    }),
  });
  assert.match(el.text, /Pull requests: unknown\. gh is not logged in/);
  // The plain sentence stands in sight, the reason only under Details.
  const fold = el.querySelectorAll("details").find((d) => d.text.includes("Pull requests: unknown"));
  assert.ok(fold, "the reason stands under Details");
  assert.match(
    el.text.replace(fold.text, ""),
    /GitHub cannot be asked about pull requests.*sign in with gh auth login/,
  );
  assert.match(el.text, /Commits while it was open/);
  assert.match(el.text, /a commit/);
  // A project not on GitHub is told so, not sent to sign in.
  const away = await drawn({
    ok: true,
    result: storyResult({
      unknown: {
        git: null,
        prs: "gh pr list failed: none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
      },
    }),
  });
  assert.match(away.el.text, /does not seem to be on GitHub/);
  assert.doesNotMatch(
    away.el.text.replace(
      away.el
        .querySelectorAll("details")
        .map((d) => d.text)
        .join(""),
      "",
    ),
    /sign in/,
  );
});

// [dashboard-code#11]
test("dashboard page: a title from the code host is text, and only an https url becomes a link", async () => {
  const { el } = await drawn({
    ok: true,
    result: storyResult({
      prs: [
        prRow(1, ["recorded"], { title: "<img src=x onerror=alert(1)>" }),
        prRow(2, ["named"], { url: "javascript:alert(1)" }),
      ],
    }),
  });
  assert.deepEqual(el.querySelectorAll("img"), [], "no element made from a title");
  assert.ok(el.text.includes("<img src=x onerror=alert(1)>"), "the title stands as text");
  const links = el.querySelectorAll("a");
  assert.deepEqual(
    links.map((a) => a.attrs.href),
    ["https://github.com/acme/app/pull/1"],
  );
  assert.equal(links[0].attrs.rel, "noopener noreferrer");
});

// [dashboard-code#11]
test("dashboard page: the block's button asks gh again with fresh, an item opening asks without, and a spec gets its block", async () => {
  const { el, calls, code, d } = await drawn({ ok: true, result: storyResult() });
  const again = el.querySelectorAll("button").find((b) => b.text === "Check again");
  assert.ok(again);
  again.click();
  await settle();
  assert.deepEqual(JSON.parse(calls[1].body), { rel: "epics/PS-X/stories/story-a.md", fresh: true });
  assert.equal(code.block({ kind: "epic", id: "PS-X" }), null, "an epic has no Code block");
  void d;
  const spec = await drawn(
    {
      ok: true,
      result: {
        kind: "spec",
        rel: "specs/s.md",
        repo: "acme/app",
        main: MAIN,
        listFull: false,
        unknown: { git: null, prs: null },
        anchors: [
          {
            anchor: "2026-11-14",
            from: ["marker"],
            contracts: [{ n: "2", heading: "Two" }],
            commits: 2,
            files: 1,
            prCount: 1,
            prs: [{ number: 8, title: "t", url: "https://github.com/acme/app/pull/8", mergedAt: null }],
            loose: 0,
          },
        ],
        stories: [],
        files: [{ path: "scripts/e.mjs", class: "source", lines: 2 }],
        totals: {},
      },
    },
    { kind: "doc", id: "specs/s.md" },
  );
  assert.match(spec.el.text, /Contract 2/);
  assert.match(spec.el.text, /amended 2026-11-14/);
  assert.match(spec.el.text, /not drift/);
});

// [dashboard-code#11] The item asks for the block when it opens and on R (fetchItem), and draws it after Related.
// The native append and replaceChildren print a null or a false as text ("null" under a story's
// title on 2026-11-20). A call that may get one goes through h() or fill(), which drop them.
test("dashboard page: no page script hands the native append or replaceChildren a value that may be null or false", () => {
  const found = [];
  for (const file of PAGE_SCRIPTS) {
    const src = readFileSync(join(PUBLIC, file), "utf8");
    for (const m of src.matchAll(/\.(append|replaceChildren)\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < src.length && depth) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      // Only the call's own arguments: what nested h(…) or fill(…) calls hold is theirs to drop.
      let own = "";
      let d = 0;
      for (const ch of src.slice(start, i - 1)) {
        if (ch === "(") d++;
        if (d === 0) own += ch;
        if (ch === ")") d--;
      }
      if (/:\s*null\b|:\s*false\b|&&/.test(own))
        found.push(`${file}: ${src.slice(m.index, i).split("\n")[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(found, []);
});

test("dashboard page: item.js asks for the Code block in fetchItem and draws it after Related", () => {
  const src = readFileSync(join(PUBLIC, "item.js"), "utf8");
  const fetchItem = src.slice(src.indexOf("function fetchItem()"), src.indexOf("function closeDrawer()"));
  assert.match(fetchItem, /codeUi\.ask\(d\)/);
  assert.match(src, /relatedSide\(d\) : null, item && !item\.missing \? codeUi\.block\(d\) : null/);
  assert.ok(PAGE_SCRIPTS.indexOf("code.js") > PAGE_SCRIPTS.indexOf("related.js"), "code.js loads after related.js");
  const names = [
    ...readFileSync(join(PUBLIC, "code.js"), "utf8").matchAll(
      /^(?:async\s+)?function\s+([\w$]+)|^(?:const|let|var|class)\s+([\w$]+)/gm,
    ),
  ].map((m) => m[1] || m[2]);
  assert.deepEqual(names, ["codeUi"], "code.js declares one top-level name, codeUi");
});

// ── the editor's kept text (dashboard/public/item.js; the spec alias `dashboard-editor`, contract 12) ──
// item.js in a context of its own, as write.js and code.js above, over a storage two pages share:
// pages of different projects, started one after another on one port, have one browser storage.
// The page's start at the foot of item.js waits on a fetchState that never answers; the editor
// is a stub that holds its text as a string, and Discard's dialog takes its first button.
// For the pictures (dashboard-attachments, contracts 2–4): `attachments` is the state's folder,
// `files` whether the server's edit-doc has a files field; the page's attachmentModule() is the
// core's scripts/attachment.mjs; the stub editor takes a paste or a drop at its cursor; toasts are kept.
// For New in the item panel (dashboard-new): the create rows (`oldServer`: with no text field), the
// template route's answer, `made` the answer to a new item's Save, the vault's epics and initiatives,
// and the drawer an element of its own; writeUi's New rules are stand-ins that record what they get.
function loadEditor(
  dir,
  vault,
  storage,
  { attachments = null, files = false, answer = null, oldServer = false, template = NEW_TEMPLATE, made = null } = {},
) {
  const h = (tag, attrs, ...kids) => Object.assign(new FakeEl(tag, attrs, kids), { style: {} });
  const saves = [];
  const toasts = [];
  const created = [];
  const finished = [];
  const drawer = h("aside");
  const verbs = [
    {
      verb: "edit-doc",
      fields: {
        path: {},
        text: {},
        base: {},
        ...(files ? { files: { kind: "files", optional: true, label: "Pictures" } } : {}),
      },
    },
    ...["initiative", "epic", "story"].map((k) => ({
      verb: `create-${k}`,
      fields: {
        title: {},
        ...(oldServer ? {} : { text: {} }),
        ...(files && !oldServer ? { files: { kind: "files", optional: true, label: "Pictures" } } : {}),
      },
    })),
  ];
  const ctx = {
    S: {
      project: { dir, name: "proj" },
      vault,
      write: { can: true, batch: null, verbs },
      attachments,
      epics: [
        { id: "PS-X", title: "X", status: "planned" },
        { id: "PS-Y", title: "Y", status: "planned" },
        { id: "PS-D", title: "Done one", status: "done" },
      ],
      initiatives: [
        { id: "faster", title: "Faster", stage: "proposed" },
        { id: "nope", title: "Nope", stage: "rejected" },
        { id: "later", title: "Later", stage: "deferred" },
      ],
    },
    ui: { view: "backlog" },
    h,
    fill: (el, ...kids) => el.replaceChildren(...kids),
    toast: (kind, title, text) => toasts.push({ kind, title, text }),
    attachmentModule: () => import(pathToFileURL(join(REPO, "scripts", "attachment.mjs")).href),
    btoa: globalThis.btoa,
    TextEncoder,
    dialog: (title, body, buttons) => buttons[0].run(),
    load: async () => {},
    fetchState: () => new Promise(() => {}),
    MOD: "⌘",
    // The drawer itself: with no item open, a redraw only hides it.
    $: (sel) => (sel === "#drawer" ? drawer : {}),
    epic: (id) => ctx.S.epics.find((e) => e.id === id),
    chipP: (p) => p,
    avatar: () => "",
    kindIco: () => "",
    viewQuery: () => "",
    location: { hash: "" },
    history: { replaceState() {} },
    codeUi: { block: () => null, ask() {} },
    MD: { render: () => null, fromHtml: () => "", kindOf: () => "file" },
    // app.js's store, over the shared storage: `ws:` before every key, JSON values.
    store: {
      get: (k, d) => (storage.has(`ws:${k}`) ? JSON.parse(storage.get(`ws:${k}`)) : d),
      set: (k, v) => (v === null ? storage.delete(`ws:${k}`) : storage.set(`ws:${k}`, JSON.stringify(v)), true),
    },
    writeUi: {
      saveDoc: async (fields) => (saves.push(fields), answer ? answer(fields) : { ok: true, result: { hash: "h2" } }),
      createEntry: (kind) => ctx.S.write.verbs.find((v) => v.verb === `create-${kind}`) || null,
      newHint: (kind, f) =>
        !f.title.trim()
          ? `Give the ${kind} a title.`
          : kind === "epic" && !f.id.trim()
            ? "Give the epic an ID."
            : kind === "story" && !f.epic.trim()
              ? "Pick the epic."
              : null,
      newFields: (kind, f, text, list) => ({
        kind,
        title: f.title.trim(),
        text,
        ...(kind === "epic" ? { epic: f.id } : kind === "story" ? { epic: f.epic } : {}),
        ...(list.length ? { files: list } : {}),
      }),
      saveNew: async (kind, fields) => (
        created.push(fields),
        made ? made(fields) : { ok: true, wrote: true, result: { rel: "epics/PS-X/stories/story-t.md" } }
      ),
      finishNew: async (kind, a, sent) => finished.push({ kind, a, sent }),
      createRefusal: (kind, error) =>
        /exists/.test(error) ? [h("div", null, "There is a story of this name already.")] : null,
      viewsNote: (a) => (a.views_left ? `views left: ${a.views_left}` : null),
    },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, querySelector: () => null, activeElement: null },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url) =>
      String(url).startsWith("/api/template")
        ? template
          ? { ok: true, status: 200, json: async () => template }
          : { ok: false, status: 404, json: async () => ({ error: "no template" }) }
        : { status: 200, json: async () => ({ ok: true, base: null, disk: null }) },
    WSEditor: {
      create: ({ doc, onChange, onFiles, ctx: edCtx }) => {
        let text = doc;
        const api = {
          live: true,
          baseline: null,
          cursor: 0,
          ctx: edCtx,
          text: () => text,
          selected: () => "",
          replaceAll: (t) => (text = t),
          type: (t) => ((text = t), onChange()),
          insert(t) {
            text = text.slice(0, api.cursor) + t + text.slice(api.cursor);
            api.cursor += t.length;
            onChange();
          },
          // What the editor hands the page for a paste (false: the editor pastes it as text) and a drop.
          paste: (list, plain = "", html = "") => onFiles(list, api, { plain, html, drop: false }),
          drop: (list) => onFiles(list, api, { plain: "", html: "", drop: true }),
          setBaseline(b) {
            this.baseline = b;
          },
          changes: () => 0,
          destroy() {},
        };
        return api;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${readFileSync(join(PUBLIC, "item.js"), "utf8")}\nglobalThis.makeEditor = makeEditor; globalThis.PASTED_ = PASTED; globalThis.textMode_ = textMode; globalThis.refusedNote_ = refusedNote; globalThis.editorFor_ = editorFor; globalThis.endRefused_ = endRefusedEditor; globalThis.ED_ = () => ED; globalThis.openNew_ = openNew; globalThis.NEW_ = NEW; globalThis.ui_ = ui; globalThis.newMode_ = newMode; globalThis.CARRY_ = () => CARRY;`,
    ctx,
    {
      filename: "item.js",
    },
  );
  return {
    open: (item) => ctx.makeEditor(item),
    saves,
    toasts,
    pasted: ctx.PASTED_,
    textMode: ctx.textMode_,
    refusedNote: ctx.refusedNote_,
    editorFor: ctx.editorFor_,
    endRefused: ctx.endRefused_,
    live: () => ctx.ED_(),
    openNew: ctx.openNew_,
    NEW: ctx.NEW_,
    ui: ctx.ui_,
    newMode: ctx.newMode_,
    carry: () => ctx.CARRY_(),
    created,
    finished,
    drawer,
    S: ctx.S,
  };
}
// What GET /api/template answers for a story (dashboard-new, contract 3).
const NEW_TEMPLATE = {
  kind: "story",
  body: "## Description\n\n## Acceptance Criteria\n\n- [ ]\n",
  fields: { status: "planned", priority: "p2", assignee: "Ada" },
  rel: "epics/PS-X/stories/story-untitled.md",
};
const settleNew = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
// A file as a paste or a drop hands it: its name and its bytes.
const fileFrom = (name, bytes) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// A PNG of `n` bytes, other bytes for each `seed`.
const pngOf = (n, seed = 0) => Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(n - 8, seed)]);
const EDIT_ITEM = {
  rel: "epics/PS-X/stories/story-a.md",
  title: "A",
  edit: { body: "Saved.\n", hash: "h1", head: "" },
};
const keptNote = (ed) => /This is your text from/.test(ed.host.text);
const buttonOf = (ed, label) => ed.host.buttons.find((b) => b.text === label);

test("dashboard page: [dashboard-editor#12] a text left unsaved in one project opens in that project only, though another project on the same port has the file with the same body", () => {
  const storage = new Map();
  const a = loadEditor("/work/a", "/vaults/one", storage).open(EDIT_ITEM);
  a.ed.type("Mine, not saved.\n");
  a.destroy(); // the drawer closes: the text is kept
  const keys = [...storage.keys()];
  // The project's folder, the vault's folder and the file's path, as one JSON array.
  assert.deepEqual(keys, [`ws:draft:${JSON.stringify(["/work/a", "/vaults/one", EDIT_ITEM.rel])}`]);

  // Project B, a copy of the vault: the same path, the same body, the same hash.
  const b = loadEditor("/work/b", "/vaults/copy", storage).open(EDIT_ITEM);
  assert.equal(b.ed.text(), "Saved.\n", "B holds its own saved text");
  assert.equal(b.dirty(), false);
  assert.equal(keptNote(b), false, "B shows no note of a kept text");
  b.destroy(); // nothing unsaved in B: its closing removes only its own entry
  assert.deepEqual([...storage.keys()], keys, "A's text is still kept");

  // The same project folder bound to a copy of the vault is another vault.
  const rebound = loadEditor("/work/a", "/vaults/copy", storage).open(EDIT_ITEM);
  assert.equal(rebound.ed.text(), "Saved.\n");
  assert.equal(keptNote(rebound), false);
  // Another project folder bound to the same vault is another project.
  const c = loadEditor("/work/c", "/vaults/one", storage).open(EDIT_ITEM);
  assert.equal(c.ed.text(), "Saved.\n");
  assert.equal(keptNote(c), false);
  // Another file of project A, with the same body, is another file.
  const other = loadEditor("/work/a", "/vaults/one", storage).open({
    ...EDIT_ITEM,
    rel: "epics/PS-X/stories/story-b.md",
  });
  assert.equal(other.ed.text(), "Saved.\n");
  assert.equal(keptNote(other), false);

  const again = loadEditor("/work/a", "/vaults/one", storage).open(EDIT_ITEM);
  assert.equal(again.ed.text(), "Mine, not saved.\n", "A gets its text back");
  assert.ok(again.dirty());
  assert.ok(keptNote(again), "with the note that it is not saved");
});

test("dashboard page: [dashboard-editor#12] a text kept by 0.30.22 under the path alone is not read, and stays after the item is opened, discarded and saved", async () => {
  const OLD = `ws:draft:${EDIT_ITEM.rel}`;
  const old = JSON.stringify({ body: "Someone's, from 0.30.22.\n", saved: "Saved.\n", hash: "h1", at: 1 });
  const storage = new Map([[OLD, old]]);
  const page = loadEditor("/work/a", "/vaults/one", storage);
  const ed = page.open(EDIT_ITEM);
  assert.equal(ed.ed.text(), "Saved.\n", "the old text does not open, though its hash is the file's");
  assert.equal(keptNote(ed), false);

  ed.ed.type("Typed.\n");
  buttonOf(ed, "Discard").click(); // the dialog's first button: throw it away
  assert.equal(ed.ed.text(), "Saved.\n");
  assert.equal(storage.get(OLD), old, "Discard leaves the old entry");

  ed.ed.type("Typed and saved.\n");
  await ed.save();
  assert.deepEqual(JSON.parse(JSON.stringify(page.saves)), [
    { path: EDIT_ITEM.rel, text: "Typed and saved.\n", base: "h1" },
  ]);
  ed.destroy();
  assert.deepEqual([...storage.keys()], [OLD], "Save and closing leave the old entry, and only it");
  assert.equal(storage.get(OLD), old);
});

// ── the page's pictures (dashboard/public/item.js; the spec alias `dashboard-attachments`) ──
const PICTURES = { attachments: "attachments", files: true };
const ITEM_B = { ...EDIT_ITEM, rel: "epics/PS-X/stories/story-b.md", title: "B" };
const nameOfBytes = async (bytes) => (await import("../scripts/attachment.mjs")).nameOf(bytes);
const pasteInto = async (ed, files, plain = "", html = "") => {
  const r = ed.ed.paste(files, plain, html);
  await ed.taking;
  return r;
};

// [dashboard-attachments#2]
test("dashboard page: [dashboard-attachments#2] a table's HTML stays text, a PNG with its own name as text/plain is taken, and a server whose edit-doc has no files takes none", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const ed = page.open(EDIT_ITEM);
  const shot = fileFrom("shot.png", PNG_BYTES);
  const table = "<meta charset='utf-8'><table><tr><td>a</td><td><img src=\"x.png\"></td></tr></table>";
  assert.equal(await pasteInto(ed, [shot], "a\tb", table), false, "the editor pastes it as text");
  assert.equal(ed.ed.text(), "Saved.\n");
  assert.equal(page.pasted.size, 0, "no file is taken");
  assert.equal(await pasteInto(ed, [shot], "shot.png", ""), true);
  assert.doesNotMatch(ed.ed.text(), /shot\.png\n|^shot\.png/, "the name is not inserted as text");
  assert.match(ed.ed.text(), /!\[shot\.png\]\(\.\.\/\.\.\/\.\.\/attachments\/[0-9a-f]{16}\.png\)/);
  // "Copy image" in a browser: one <img> and its address as text/plain.
  const copied = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES).open(EDIT_ITEM);
  assert.equal(
    await pasteInto(
      copied,
      [shot],
      "https://example.com/a.png",
      "<meta charset='utf-8'><img src=\"https://example.com/a.png\">",
    ),
    true,
  );
  assert.match(copied.ed.text(), /!\[shot\.png\]/);

  const old = loadEditor("/work/a", "/vaults/one", new Map(), { attachments: "attachments", files: false });
  const o = old.open(EDIT_ITEM);
  assert.equal(await pasteInto(o, [shot]), true);
  assert.equal(o.ed.text(), "Saved.\n", "nothing is inserted");
  assert.equal(old.pasted.size, 0);
  assert.match(old.toasts.at(-1).text, /is not kept here/);
  const none = loadEditor("/work/a", "/vaults/one", new Map(), { attachments: null, files: true });
  const n = none.open(EDIT_ITEM);
  await pasteInto(n, [shot]);
  assert.equal(n.ed.text(), "Saved.\n");
  assert.match(none.toasts.at(-1).text, /no attachments folder/);
});

// [dashboard-attachments#3]
test("dashboard page: [dashboard-attachments#3] a PNG pasted into a story three folders deep becomes a link at the cursor, drawn from a data: URL; a bare name is drawn from beside the note", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const ed = page.open(EDIT_ITEM);
  ed.ed.cursor = "Saved.".length;
  await pasteInto(ed, [fileFrom("my [shot]`\n.png", PNG_BYTES)]);
  const name = await nameOfBytes(PNG_BYTES);
  assert.equal(
    ed.ed.text(),
    `Saved.![my shot.png](../../../attachments/${name})\n`,
    "at the cursor, the alt without [ ] ` and line breaks",
  );
  const media = ed.ed.ctx.media(`../../../attachments/${name}`);
  assert.equal(media.kind, "image");
  assert.ok(media.src.startsWith("data:image/png;base64,"), media.src.slice(0, 40));
  assert.equal(
    ed.ed.ctx.media("shot.png"),
    null,
    "a bare name is beside the note, where nothing is (the stub's kindOf is file)",
  );
  // The same picture again: only the bytes are kept, no second link.
  await pasteInto(ed, [fileFrom("again.png", PNG_BYTES)]);
  assert.equal(ed.ed.text().split(name).length, 2, "one link");
  // A PDF is a link, not a picture.
  const pdf = Buffer.from("%PDF-1.4\n%fixture\n");
  await pasteInto(ed, [fileFrom("spec.pdf", pdf)]);
  assert.match(
    ed.ed.text(),
    new RegExp(`(?<!!)\\[spec\\.pdf\\]\\(\\.\\./\\.\\./\\.\\./attachments/${await nameOfBytes(pdf)}\\)`),
  );
});

// [dashboard-attachments#3] failure
test("dashboard page: [dashboard-attachments#3] an MP4, a PNG over MAX_BYTES and a PNG that would bring the save over 16 MiB insert nothing, each with its refusal", async () => {
  const A = await import("../scripts/attachment.mjs");
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const ed = page.open(EDIT_ITEM);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);
  await pasteInto(ed, [fileFrom("clip.mp4", mp4)]);
  assert.equal(page.toasts.at(-1).text, A.refusal("type", { file: "clip.mp4" }));
  const big = pngOf(A.MAX_BYTES + 1);
  await pasteInto(ed, [fileFrom("big.png", big)]);
  assert.equal(page.toasts.at(-1).text, A.refusal("size", { file: "big.png", size: big.length }));
  assert.equal(ed.ed.text(), "Saved.\n", "nothing inserted");
  // Two pictures just under the limit fit in one save; a third does not.
  const near = A.MAX_BYTES - 4096;
  await pasteInto(ed, [fileFrom("one.png", pngOf(near, 1)), fileFrom("two.png", pngOf(near, 2))]);
  assert.equal(page.pasted.size, 2);
  await pasteInto(ed, [fileFrom("three.png", pngOf(near, 3))]);
  assert.match(page.toasts.at(-1).text, /^three\.png: .*over the 16777216 bytes \(16 MiB\) one save takes/);
  assert.equal(page.pasted.size, 2);
  assert.doesNotMatch(ed.ed.text(), /three\.png/);
});

// [dashboard-attachments#4]
test("dashboard page: [dashboard-attachments#4] Save sends the remembered files the text links: none once the link is deleted, one across a closed drawer, and B's after A is saved", async () => {
  const name = await nameOfBytes(PNG_BYTES);
  // Pasted, then its link deleted: nothing to send, and the file is forgotten at the Save.
  const p1 = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const e1 = p1.open(EDIT_ITEM);
  await pasteInto(e1, [fileFrom("shot.png", PNG_BYTES)]);
  e1.ed.type("Saved, with no picture.\n");
  await e1.save();
  assert.equal((p1.saves[0].files || []).length, 0);
  assert.equal(p1.pasted.size, 0, "forgotten: pasted here, no longer linked");

  // Pasted, the drawer closed, the story opened again: the picture is sent, and forgotten once kept.
  const p2 = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const e2 = p2.open(EDIT_ITEM);
  await pasteInto(e2, [fileFrom("shot.png", PNG_BYTES)]);
  const text = e2.ed.text();
  e2.destroy();
  const again = p2.open(EDIT_ITEM);
  assert.equal(again.ed.text(), text, "the kept draft holds the link");
  await again.save();
  assert.deepEqual(JSON.parse(JSON.stringify(p2.saves[0].files.map((f) => f.name))), [name]);
  assert.equal(p2.saves[0].files[0].data, PNG_BYTES.toString("base64"));
  assert.equal(p2.pasted.size, 0, "kept by the verb: forgotten");

  // Pasted in B, then A saved: A sends nothing of B's, and B's Save sends it.
  const p3 = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const b = p3.open(ITEM_B);
  await pasteInto(b, [fileFrom("shot.png", PNG_BYTES)]);
  b.destroy();
  const a = p3.open(EDIT_ITEM);
  a.ed.type("A changed.\n");
  await a.save();
  assert.equal(p3.saves[0].files, undefined, "A's save sends no file");
  a.destroy();
  const b2 = p3.open(ITEM_B);
  await b2.save();
  assert.deepEqual(JSON.parse(JSON.stringify(p3.saves[1].files.map((f) => f.name))), [name]);
});

// [dashboard-attachments#4] A refused save keeps the files; a text that links a remembered file is not saved.
test("dashboard page: [dashboard-attachments#4] a refused save keeps the pasted files for the next Save, and the save line reads not saved while the text links one", async () => {
  let refuse = true;
  const page = loadEditor("/work/a", "/vaults/one", new Map(), {
    ...PICTURES,
    answer: () => (refuse ? { ok: false, error: "refused" } : { ok: true, result: { hash: "h2" } }),
  });
  const ed = page.open(EDIT_ITEM);
  await pasteInto(ed, [fileFrom("shot.png", PNG_BYTES)]);
  assert.equal(ed.unsaved(), true);
  await ed.save();
  assert.equal(page.saves.length, 1);
  assert.equal(page.pasted.size, 1, "kept after the refusal");
  refuse = false;
  await ed.save();
  assert.equal(page.saves[1].files.length, 1, "sent again");
  assert.equal(page.pasted.size, 0);
  assert.equal(ed.unsaved(), false);
});

// [dashboard-attachments#4] The same picture pasted into two items: once A's Save keeps it, the batch has
// those bytes, and the page forgets every copy of them; B's text links a kept file then.
test("dashboard page: [dashboard-attachments#4] the same picture pasted into B and then A: A's Save sends it once, A and B read saved", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const b = page.open(ITEM_B);
  await pasteInto(b, [fileFrom("shot.png", PNG_BYTES)]);
  b.destroy();
  const a = page.open(EDIT_ITEM);
  await pasteInto(a, [fileFrom("shot.png", PNG_BYTES)]);
  assert.equal(page.pasted.size, 2);
  await a.save();
  assert.equal(page.saves[0].files.length, 1);
  assert.equal(a.unsaved(), false, "A reads saved");
  assert.equal(page.pasted.size, 0, "every copy of the kept bytes is forgotten");
});

// [dashboard-attachments#2] A file name given in two Unicode forms is still the file's own name.
test("dashboard page: [dashboard-attachments#2] a name in NFD as text/plain and NFC as the file's name is taken as the file", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const ed = page.open(EDIT_ITEM);
  assert.equal(
    await pasteInto(ed, [fileFrom("снимок-й.png".normalize("NFC"), PNG_BYTES)], "снимок-й.png".normalize("NFD")),
    true,
  );
  assert.equal(page.pasted.size, 1);
});

// [dashboard-attachments#8] What a draft keeps of its pictures: their written names, not their bytes.
test("dashboard page: [dashboard-attachments#8] a kept draft holds the linked pictures' written names, and a reloaded page names them to paste again", async () => {
  const storage = new Map();
  const page = loadEditor("/work/a", "/vaults/one", storage, PICTURES);
  const ed = page.open(EDIT_ITEM);
  await pasteInto(ed, [fileFrom("shot.png", PNG_BYTES)]);
  ed.destroy();
  const [kept] = [...storage.values()].map((v) => JSON.parse(v));
  const name = await nameOfBytes(PNG_BYTES);
  assert.deepEqual(kept.pasted, [{ name, alt: "shot.png" }]);
  assert.doesNotMatch(JSON.stringify(kept), /iVBOR/, "no bytes in the draft");
  // A reload: a new page over the same storage, with nothing in its memory.
  const reloaded = loadEditor("/work/a", "/vaults/one", storage, PICTURES).open(EDIT_ITEM);
  assert.match(reloaded.host.text, new RegExp(`Paste again before Save: shot\\.png \\(${name}\\)`));
});

// ── Reports (dashboard/public/reports.js; the spec alias `dashboard-reports`) ──
// reports.js in a context of its own: `answers` maps a GET of /api/reports (its query) and the
// POST of /api/reports/code to what they answer; `calls` records every fetch. The flow answer is
// the server's own, read from the export spec's golden vault.
function loadReportsUi(answers) {
  const calls = [];
  const counts = { render: 0 };
  const meta = new FakeEl("meta", { name: "projectstore-token", content: "the-run-token" });
  const h = (tag, attrs, ...kids) => new FakeEl(tag, attrs, kids);
  const ctx = {
    ui: { view: "reports" },
    S: {
      people: [{ name: "Ada Byron" }],
      stories: [{ assignee: "Bo Lee" }],
      epics: [{ id: "PS-A", title: "A" }],
      initiatives: [],
      write: { fetched_at: null },
    },
    PRI: ["p0", "p1", "p2", "p3"],
    plural: (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`,
    h,
    fill: (el, ...kids) =>
      el.replaceChildren(
        ...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ""),
      ),
    render: () => counts.render++,
    openByRel: () => {},
    copyText: (url) => calls.push({ copied: url }),
    location: { origin: "http://127.0.0.1:4800", pathname: "/" },
    requestAnimationFrame: () => 0,
    innerWidth: 1000,
    URLSearchParams,
    document: {
      querySelector: (sel) => (sel === 'meta[name="projectstore-token"]' ? meta : null),
      createElementNS: (_ns, tag) => new FakeEl(tag),
      createTextNode: (s) => s,
      body: { append() {} },
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET", headers: { ...(opts.headers || {}) }, body: opts.body ?? null });
      const a = typeof answers === "function" ? answers(url, opts) : answers[opts.method === "POST" ? "code" : "flow"];
      return { status: 200, json: async () => a };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(join(PUBLIC, "reports.js"), "utf8")}\nglobalThis.reportsUi = reportsUi;`, ctx, {
    filename: "reports.js",
  });
  return { reports: ctx.reportsUi, ctx, calls, counts };
}
async function goldenFlow(query = {}) {
  const fx = exportGoldenVault();
  const core = await openCore({ core: REPO, project: fx.proj });
  return { copy: "vault", ...reportsFlow(core, query, { now: NOW_MS }).result };
}
const CODE_ANSWER = {
  ok: true,
  copy: "vault",
  result: {
    main: { short: "main", hash: "abc123456" },
    repo: "acme/app",
    listFull: false,
    unknown: { git: null, prs: null },
    openLeft: null,
    checks: [
      {
        id: "merged_open",
        label: "Open, with its pull requests merged",
        value: { value: 2, by: "page", basis: "the newest merged at least 7 days ago, this page's own" },
        counted: [
          {
            rel: "epics/PS-A/stories/story-doing.md",
            epic: "PS-A",
            title: "story-doing",
            prs: [
              {
                number: 11,
                title: "eleven",
                url: "https://github.com/acme/app/pull/11",
                how: ["recorded"],
                link: true,
              },
            ],
          },
        ],
        leads: [
          {
            rel: "epics/PS-A/stories/story-review.md",
            epic: "PS-A",
            title: "story-review",
            prs: [{ number: 13, title: "thirteen", url: "javascript:alert(1)", how: ["named"], link: false }],
          },
        ],
        unknown: null,
      },
    ],
  },
};
const drawReports = async (answers, query = "") => {
  const r = loadReportsUi(answers);
  r.reports.apply(query);
  r.reports.view(); // asks both reads
  await settle();
  return { ...r, el: r.reports.view() };
};

// [dashboard-reports#9]
test("dashboard page: Reports draws the answers' numbers, says this page's own on its own ones, and lists a lead apart, as a lead", async () => {
  const F = await goldenFlow();
  const { el, calls } = await drawReports({ flow: F, code: CODE_ANSWER });
  const tiles = el.querySelectorAll("div.kpi").map((k) => k.text);
  assert.ok(
    tiles.some((t) => t.startsWith(`Created${F.window.created.value}`)),
    tiles.join(" | "),
  );
  assert.ok(
    tiles.some((t) => t.startsWith(`Closed${F.window.closed.value}`)),
    tiles.join(" | "),
  );
  // In Progress has no key: its count is the page's own, and says so.
  const own = el.querySelectorAll("span.chip.own");
  assert.ok(own.length >= 2, "the In Progress count and the code check say this page's own");
  assert.ok(el.text.includes("this page's own"));
  // A key the golden policy does not set is named with the way to set it.
  assert.ok(el.text.includes("projectstore configure --set flow.age_days.review=<days>"));
  // The code check: N by a counted link, M by a lead; the lead labelled, and its non-https link drawn as text.
  assert.ok(el.text.includes("1 by a counted link, 1 by a lead"));
  const leads = el.querySelectorAll("span.chip.flag").map((x) => x.text);
  assert.ok(leads.includes("lead"));
  assert.ok(
    !el.querySelectorAll("a").some((a) => !String(a.getAttribute("href")).startsWith("https://")),
    "a link out is https only",
  );
  // One GET of the flow counts, one POST of the code read with the token.
  assert.deepEqual(
    calls.filter((c) => c.url).map((c) => `${c.method} ${c.url}`),
    ["GET /api/reports", "POST /api/reports/code"],
  );
  assert.equal(calls[1].headers["x-projectstore-token"], "the-run-token");
});

test("dashboard page: Reports says counting until the code read answers, keeps the last answer dimmed while the next is read, and drops an answer to a query no longer asked", async () => {
  const F = await goldenFlow();
  let release;
  const held = new Promise((r) => (release = r));
  const r = loadReportsUi((url, opts) => (opts.method === "POST" ? null : F));
  r.ctx.fetch = async (url, opts = {}) => {
    r.calls.push({ url, method: opts.method || "GET" });
    if (opts.method === "POST") await held;
    return { status: 200, json: async () => (opts.method === "POST" ? CODE_ANSWER : { ...F, stamp: url }) };
  };
  r.reports.view();
  await settle();
  assert.ok(r.reports.view().text.includes("counting…"), "the code part says counting");
  // A new filter: the drawn answer is the old query's, dimmed, until the new one comes.
  r.reports.apply("weeks=8");
  const dim = r.reports.view();
  assert.ok(dim.classes.has("stale"));
  await settle();
  assert.ok(!r.reports.view().classes.has("stale"));
  release();
  await settle();
  assert.ok(!r.reports.view().text.includes("counting…"));
});

// [dashboard-reports#10]
test("dashboard page: Reports asks with exactly the address's filters, drops an invalid value, and a click on a week sets asof to the Monday after it", async () => {
  const F = await goldenFlow();
  const { calls, reports } = await drawReports({ flow: F, code: CODE_ANSWER }, "weeks=8&epic=PS-FLOW");
  assert.equal(calls[0].url, "/api/reports?weeks=8&epic=PS-FLOW");
  assert.deepEqual(JSON.parse(calls[1].body), { weeks: "8", epic: "PS-FLOW" });
  assert.equal(reports.link(), "http://127.0.0.1:4800/#/reports?weeks=8&epic=PS-FLOW");
  reports.apply("asof=2026-02-30&weeks=3&colour=red");
  assert.equal(reports.query(), "weeks=3");
  reports.apply("");
  const el = reports.view();
  // An svg element of the chart takes its class by setAttribute.
  const weekHit = el.querySelectorAll("rect").find((x) => x.getAttribute("class") === "viz-hit");
  assert.ok(weekHit, "a week of a chart can be clicked");
  weekHit.click();
  assert.equal(
    reports.query(),
    `asof=${new Date(Date.parse(F.weekly[0].from) + 7 * 86400000).toISOString().slice(0, 10)}`,
  );
});

// [dashboard-editor#14] [dashboard-editor#10]
test("dashboard page: a file the edit verb refuses is its text with the reason; a proposed ADR is an editor; the old-server note is for a story, an epic or an initiative only", () => {
  const { textMode } = loadEditor("/work/a", "/vaults/one", new Map());
  const write = { can: true, verbs: [{ verb: "edit-doc" }] };
  const edit = { head: "", body: "## A\n", hash: "h" };
  const cases = [
    [{ type: "adr", status: "proposed", edit }, "editor"],
    [{ type: "research", edit }, "editor"],
    [{ type: "adr", status: "accepted", editRefused: "this ADR is accepted, …" }, "refused"],
    [{ type: "spec", status: "active", editRefused: "this spec is active, …" }, "refused"],
    [{ type: "concept" }, "text"],
    [{ type: "adr", status: "accepted" }, "text"],
    [{ type: "story" }, "old-server"],
    [{ type: "epic", edit }, "editor"],
  ];
  for (const [item, want] of cases) assert.equal(textMode(item, "doc", write, true), want, JSON.stringify(item));
  assert.equal(textMode({ type: "story", edit }, "doc", { can: true, verbs: [] }, true), "old-server", "no edit-doc");
  assert.equal(
    textMode({ type: "adr", editRefused: "x" }, "doc", { can: false }, true),
    "text",
    "a page that cannot write gives no reason",
  );
  assert.equal(textMode({ type: "story", edit }, "doc", write, false), "no-editor");
});

// [dashboard-editor#14]
test("dashboard page: the reason of a refused file is drawn as text, and says when text not saved for it is kept", () => {
  const storage = new Map();
  const rel = "adr/ADR-002-x.md";
  const { refusedNote } = loadEditor("/work/a", "/vaults/one", storage);
  const reason = "this ADR is accepted, and edit writes an ADR only while it is proposed. <img src=x onerror=alert(1)>";
  const bare = refusedNote({ rel, editRefused: reason });
  assert.match(bare.text, /^Not edited here\. This ADR is accepted/);
  assert.ok(bare.text.includes("<img src=x onerror=alert(1)>"), "drawn as text");
  assert.ok(!bare.querySelectorAll("img").length);
  assert.doesNotMatch(bare.text, /kept in this browser/);
  const key = `ws:draft:${JSON.stringify(["/work/a", "/vaults/one", rel])}`;
  storage.set(key, JSON.stringify({ body: "## Context\n\nMine <b>here</b>.\n", saved: "", hash: "h" }));
  const kept = refusedNote({ rel, editRefused: reason });
  assert.match(kept.text, /Your text not saved for it is kept in this browser/);
  // The kept text is shown as text, to copy or to drop.
  assert.ok(kept.querySelector("pre").text.includes("Mine <b>here</b>."));
  assert.ok(!kept.querySelectorAll("b").some((b) => b.text === "here"));
  assert.ok(kept.querySelectorAll("button").some((b) => b.text === "Copy"));
  kept
    .querySelectorAll("button")
    .find((b) => b.text === "Discard")
    .click();
  assert.equal(storage.has(key), false, "Discard drops the kept text");
});

// [dashboard-editor#14]
test("dashboard page: a file that turns read-only while its editor is open ends that editor, so a Discard of its kept text is not written back", () => {
  const storage = new Map();
  const page = loadEditor("/work/a", "/vaults/one", storage);
  const item = { ...EDIT_ITEM, rel: "adr/ADR-002-x.md", type: "adr", status: "proposed" };
  page.editorFor({ kind: "doc", id: item.rel }, item);
  page.live().ed.type("Mine, not saved.\n");
  // Get latest brings the ADR accepted: the drawer draws its text and ends the editor, its text kept once.
  page.endRefused({ ...item, status: "accepted", editRefused: "this ADR is accepted, …" });
  assert.equal(page.live(), null, "no live editor is left to write the text back");
  const key = `ws:draft:${JSON.stringify(["/work/a", "/vaults/one", item.rel])}`;
  assert.ok(storage.has(key), "the text is kept once");
  const note = page.refusedNote({ rel: item.rel, editRefused: "this ADR is accepted, …" });
  note
    .querySelectorAll("button")
    .find((b) => b.text === "Discard")
    .click();
  assert.equal(storage.has(key), false);
  page.endRefused({ ...item, status: "accepted" });
  assert.equal(storage.has(key), false, "nothing writes it back");
});

// ── New in the item panel (dashboard/public/item.js; the spec alias `dashboard-new`) ──
// openNew draws the drawer of loadEditor's harness; the editor is its stub. The rules New asks of
// write.js (the hints, the request, the step after Save) are stand-ins here: write.js's own are
// tested in tests/dashboard-create.test.mjs.
const inputsIn = (el) => el.all().filter((e) => e.tag === "input" || e.tag === "select");
const newDraftKey = (dir, vault, key) => `ws:draft:${JSON.stringify([dir, vault, key])}`;
async function openedNew(page, kind, preset = {}) {
  page.openNew(kind, preset);
  await settleNew();
  return { st: page.ui.drawer.st, ed: page.live(), drawer: page.drawer };
}
const setInput = (page, name, value) => {
  const el = inputsIn(page.drawer).find((e) => e.attrs["data-focus"] === `new-${name}`);
  assert.ok(el, `an input for ${name}`);
  el.value = value;
  el.fire(el.tag === "select" ? "change" : "input");
};

// [dashboard-new#2]
test("dashboard page: [dashboard-new#2] New story opens the item panel in its new state: its kind and new, a title input, an epic input offering the open epics, the template's fields, and the editor with the template's body", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map());
  const { st, ed, drawer } = await openedNew(page, "story");
  assert.equal(page.ui.drawer.kind, "new");
  assert.match(drawer.text, /story · new/);
  const inputs = inputsIn(drawer);
  assert.deepEqual(
    inputs.map((e) => e.attrs["data-focus"]),
    ["new-title", "new-epic"],
  );
  const options = drawer
    .all()
    .filter((e) => e.tag === "option")
    .map((o) => o.value);
  assert.deepEqual(options, ["PS-X", "PS-Y"], "the open epics, no done one");
  assert.match(drawer.text, /planned/);
  assert.match(drawer.text, /p2/);
  assert.ok(ed, "the editor is open");
  assert.equal(ed.key, st.key);
  assert.equal(ed.ed.text(), NEW_TEMPLATE.body);
  assert.match(ed.host.text, /new document/);
  assert.ok(!ed.host.all().some((e) => e.tag === "select"), "no choice of what the marks compare with");
  assert.ok(!/Preview/.test(drawer.text), "no Preview");
  assert.ok(
    ed.host.buttons.some((b) => b.text === "Save"),
    "Save, as in an edit",
  );
});

// [dashboard-new#2]
test("dashboard page: [dashboard-new#2] New story in PS-X shows its epic as text; New epic has an ID input and an initiative choice with no rejected or deferred one; an old server, a failed template read, and a page that cannot write give a note and no editor (edge, failure)", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map());
  const a = await openedNew(page, "story", { epic: "PS-X" });
  assert.deepEqual(
    inputsIn(a.drawer).map((e) => e.attrs["data-focus"]),
    ["new-title"],
    "no epic input when it is preset",
  );
  assert.match(a.drawer.text, /PS-X · X/);
  const e = await openedNew(page, "epic");
  assert.deepEqual(
    inputsIn(e.drawer).map((x) => x.attrs["data-focus"]),
    ["new-title", "new-id", "new-initiative"],
  );
  const offered = e.drawer
    .all()
    .filter((x) => x.tag === "option")
    .map((o) => o.value);
  assert.deepEqual(offered, ["", "faster"], "none, and no rejected or deferred initiative");

  const old = loadEditor("/work/a", "/vaults/one", new Map(), { oldServer: true });
  const o = await openedNew(old, "story");
  assert.equal(old.newMode(o.st), "old-server");
  assert.match(o.drawer.text, /The server is older than this page/);
  assert.equal(o.ed, null, "no editor");
  const failed = loadEditor("/work/a", "/vaults/one", new Map(), { template: null });
  const f = await openedNew(failed, "story");
  assert.equal(failed.newMode(f.st), "failed");
  assert.match(f.drawer.text, /template could not be read/);
  assert.equal(f.ed, null);
  const ro = loadEditor("/work/a", "/vaults/one", new Map());
  ro.S.write.can = false;
  const r = await openedNew(ro, "story");
  assert.equal(ro.newMode(r.st), "cannot-write");
  assert.equal(r.ed, null);
});

// [dashboard-new#4]
test("dashboard page: [dashboard-new#4] Save is off with the hint until the inputs are given, then sends the inputs, the text and the pictures the text links by the draft's depth, and hands the answer on; the state is gone after", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), PICTURES);
  const { st, ed } = await openedNew(page, "story", { epic: "PS-X" });
  const save = buttonOf(ed, "Save");
  assert.equal(save.disabled, true);
  assert.match(ed.host.text, /Give the story a title\./);
  await ed.save();
  assert.equal(page.created.length, 0, "nothing is sent while the hint stands");
  assert.match(ed.host.text, /Not saved\. Give the story a title\./);
  setInput(page, "title", "Faster login");
  assert.equal(save.disabled, false, "Save is on once the title is given");
  const name = await nameOfBytes(PNG_BYTES);
  ed.ed.cursor = "## Description\n".length; // under the section heading, as a person pastes
  await pasteInto(ed, [fileFrom("shot.png", PNG_BYTES)]);
  assert.ok(ed.ed.text().includes(`](../../../attachments/${name})`), "linked from the new story's depth");
  await ed.save();
  assert.equal(page.created.length, 1);
  const sent = JSON.parse(JSON.stringify(page.created[0]));
  assert.equal(sent.title, "Faster login");
  assert.equal(sent.epic, "PS-X");
  assert.ok(sent.text.startsWith("## Description\n"));
  assert.deepEqual(
    sent.files.map((x) => x.name),
    [name],
  );
  assert.equal(page.finished.length, 1, "the answer goes on to open the made item");
  assert.equal(st.made, true);
  assert.equal(page.newMode(st), "made");
  assert.match(
    page.drawer.text,
    /Saved\. The story is a draft change now, in epics\/PS-X\/stories\/story-t\.md/,
    "saved, with no editor, until the made item opens",
  );
  assert.ok(!page.drawer.all().some((e) => e === ed.host), "the editor is not shown");
  assert.equal(page.NEW.has(st.key), false, "the new state is gone");
  assert.equal(page.pasted.size, 0, "the sent picture is forgotten");
  assert.equal(ed.dirty(), false);
  await ed.save();
  assert.equal(page.created.length, 1, "a second ⌘S sends nothing");
});

// [dashboard-new#4]
test("dashboard page: [dashboard-new#4] after a Save whose made item could not be opened, the same New opens a new state with an editor of its own and Save on (edge)", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map());
  const first = await openedNew(page, "story", { epic: "PS-X" });
  setInput(page, "title", "One");
  await first.ed.save();
  assert.equal(first.st.made, true);
  const again = await openedNew(page, "story", { epic: "PS-X" });
  assert.notEqual(again.st, first.st, "a new state");
  assert.equal(again.st.made, false);
  assert.notEqual(again.ed, first.ed, "not the made state's editor");
  setInput(page, "title", "Two");
  assert.equal(buttonOf(again.ed, "Save").disabled, false);
  await again.ed.save();
  assert.equal(page.created.length, 2);
});

// [dashboard-new#5]
test("dashboard page: [dashboard-new#5] a refusal stands above the text in New's plain words, nothing is made, and the inputs, the text and the pictures stay (failure)", async () => {
  const page = loadEditor("/work/a", "/vaults/one", new Map(), {
    ...PICTURES,
    made: () => ({ ok: false, error: "epics/PS-X/stories/story-faster-login.md exists; a create never overwrites" }),
  });
  const { st, ed } = await openedNew(page, "story", { epic: "PS-X" });
  setInput(page, "title", "Faster login");
  await pasteInto(ed, [fileFrom("shot.png", PNG_BYTES)]);
  ed.ed.type(`${ed.ed.text()}\nMy words.\n`);
  const text = ed.ed.text();
  await ed.save();
  assert.match(ed.host.text, /Not saved\. There is a story of this name already\./);
  assert.equal(page.finished.length, 0);
  assert.equal(st.made, false);
  assert.equal(page.NEW.has(st.key), true);
  assert.equal(st.fields.title, "Faster login");
  assert.equal(ed.ed.text(), text);
  assert.equal(page.pasted.size, 1, "the picture is kept for the next Save");
  const other = loadEditor("/work/a", "/vaults/one", new Map(), {
    made: () => ({
      ok: false,
      error: "The Status log is written by gates and verbs, and this text adds it. Put it back as it was.",
    }),
  });
  const o = await openedNew(other, "story", { epic: "PS-X" });
  setInput(other, "title", "T");
  await o.ed.save();
  assert.match(
    o.ed.host.text,
    /Not saved\. The Status log is written by gates and verbs/,
    "the core's words when New has none of its own",
  );
});

// [dashboard-new#6]
test("dashboard page: [dashboard-new#6] a new story's text and inputs are kept under its kind and epic: PS-Y does not offer PS-X's, PS-X offers them back after a reload, and Save clears them", async () => {
  const storage = new Map();
  const page = loadEditor("/work/a", "/vaults/one", storage);
  const x = await openedNew(page, "story", { epic: "PS-X" });
  setInput(page, "title", "Kept title");
  x.ed.ed.type("## Description\n\nKept words.\n");
  x.ed.destroy();
  const key = newDraftKey("/work/a", "/vaults/one", "new:story:PS-X");
  assert.ok(storage.has(key), [...storage.keys()].join(", "));
  assert.deepEqual(JSON.parse(storage.get(key)).inputs.title, "Kept title");
  const y = await openedNew(page, "story", { epic: "PS-Y" });
  assert.equal(y.st.fields.title, "");
  assert.equal(y.ed.ed.text(), NEW_TEMPLATE.body, "PS-Y's new state does not offer PS-X's text");
  // A reload: a page of its own over the same storage.
  const again = loadEditor("/work/a", "/vaults/one", storage);
  const back = await openedNew(again, "story", { epic: "PS-X" });
  assert.equal(back.st.fields.title, "Kept title");
  assert.equal(back.ed.ed.text(), "## Description\n\nKept words.\n");
  assert.match(back.ed.host.text, /This is your text from/);
  await back.ed.save();
  assert.equal(storage.has(key), false, "cleared after Save");
});

// [dashboard-new#6]
test("dashboard page: [dashboard-new#6] text typed while a new item's Save ran stays for the made item's editor, with the views' note (edge)", async () => {
  const storage = new Map();
  let typedDuring = null;
  const page = loadEditor("/work/a", "/vaults/one", storage, {
    made: () => {
      typedDuring?.();
      return {
        ok: true,
        wrote: true,
        views_left: "kanban.md: EISDIR",
        result: { rel: "epics/PS-X/stories/story-t.md" },
      };
    },
  });
  const { ed } = await openedNew(page, "story", { epic: "PS-X" });
  setInput(page, "title", "T");
  typedDuring = () => ed.ed.replaceAll("## Description\n\nTyped while saving.\n");
  await ed.save();
  assert.deepEqual(JSON.parse(JSON.stringify(page.carry())), {
    rel: "epics/PS-X/stories/story-t.md",
    typed: "## Description\n\nTyped while saving.\n",
    note: "views left: kanban.md: EISDIR",
  });
  const madeItem = {
    rel: "epics/PS-X/stories/story-t.md",
    title: "T",
    edit: { body: NEW_TEMPLATE.body, hash: "h9", head: "" },
  };
  const opened = page.open(madeItem);
  assert.equal(opened.ed.text(), "## Description\n\nTyped while saving.\n", "the made item's editor offers it");
  assert.equal(page.carry(), null);
  assert.ok(
    page.toasts.some((x) => x.title === "Saved" && /EISDIR/.test(x.text)),
    "the views' note as after an edit",
  );
});

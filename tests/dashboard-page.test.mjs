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
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { statusToColumn } from "../scripts/stages.mjs";
import { WRITE_ROUTES } from "../dashboard/server.mjs";
import { WRITE_VERBS } from "../dashboard/lib/write.mjs";
import { writeBinding } from "./fixtures/vault.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO, "dashboard");
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
    for (const path of ["/api/refresh", "/api/preview", "/api/action", "/api/send", "/api/discard"]) {
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
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(name)) files.push(p);
    }
  };
  walk(PAGE);
  assert.ok(files.length > 3, "the page's files are read");
  assert.ok(files.includes(WRITER), "the write module is among them");
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

test("dashboard page: the page imports only the core modules the spec lists, and stays under 512 KiB", () => {
  const LISTED = new Set([
    "lib.mjs",
    "stages.mjs",
    "flow-stories.mjs",
    "flow-policy.mjs",
    "flow-counts.mjs",
    "graph.mjs",
    "binding.mjs",
  ]);
  const seen = new Set();
  let size = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
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
  assert.ok(size < 512 * 1024, `dashboard/ is ${Math.round(size / 1024)} KiB`);
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
  // No initiatives/ folder: none, and nothing else breaks.
  const { proj, vault } = fixture();
  rmSync(join(vault, "initiatives"), { recursive: true });
  const port = await freePort();
  const s = startServer(["--core", REPO, "--project", proj, "--port", String(port)]);
  try {
    assert.ok(await s.ready);
    const state = JSON.parse((await call(port, "/api/state")).body);
    assert.deepEqual(state.initiatives, []);
    assert.equal(state.epics.length, 2);
  } finally {
    s.child.kill("SIGTERM");
    await s.exited;
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
      continue;
    }
    for (const r of WRITE_ROUTES) assert.ok(!src.includes(r), `${f} names ${r}`);
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
  assert.match(els["#write"].text, /Kept branches \(1\)/, "the kept list is still shown");
  const foot = ui.footLine();
  assert.equal(foot.querySelectorAll("button").length, 0);
  assert.match(foot.text, /^No writes: the vault is not in a git repository/);
  // A server that says nothing about writes is read-only too, and the line says so.
  const quiet = loadWriteUi(undefined);
  assert.match(quiet.ui.footLine().text, /^No writes: this server does not say whether the page can write/);
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
      [{ verb: "assign", fields: { story: { kind: "story" }, to: { kind: "choice", values: ["todo"] } } }],
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
        v[0].fields.to.values = ["todo"];
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
  assert.match(box.text, /What the core will change/);
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
    BATCH.branch,
    "2 commits not in main",
    "PR #7 · open",
    "Kept branches (2)",
    "3 commits the default branch lacks",
    "A carry stopped at abcdef0",
    "it does not apply",
    "count unknown",
    "fatal: bad object",
  ])
    assert.ok(text.includes(s), `the strip says ${s}`);
  assert.equal(bar.querySelector("a").attrs.href, pr.url);
  assert.doesNotMatch(text, /\bgit (push|branch)\b/, "the page prints no command for a kept branch");
  assert.deepEqual(plain(bar.buttons.map((b) => b.text).filter((t) => t !== "✕")), ["Send…", "Discard…"]);
  // Send asks first, saying what it will do; its button runs /api/send.
  bar.buttons.find((b) => b.text === "Send…").click();
  const dlg = els["#modal"].kids[0];
  assert.match(dlg.text, new RegExp(`Push branch ${BATCH.branch} with 2 commits`));
  assert.equal(calls.length, 0, "nothing runs before the click in the dialog");
  dlg.querySelector("button.primary").click();
  await settle();
  assert.deepEqual(
    calls.map((c) => [c.url, c.method]),
    [["/api/send", "POST"]],
  );
  assert.match(els["#write"].text, /Sent dashboard\/test-person\/\S+: 2 commits pushed to origin\. pull request #7/);
  // gh that cannot be asked is said in the strip.
  const noGh = loadWriteUi(writable(undefined, { batch: BATCH, pull_requests: "gh is not installed" }));
  noGh.ui.paint();
  assert.match(noGh.els["#write"].text, /cannot be asked about pull requests: gh is not installed/);
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
  assert.match(els["#write"].text, /The batch ended on this machine; its branch is kept/);
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
    /1 commit made after it was sent was carried from dashboard\/p\/1 into the new batch dashboard\/p\/2/,
  );
  assert.match(words, /the carry stopped at bbbbbbb "y", because it does not apply on the default branch/);
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
  assert.match(text, /cannot write now: the clone's origin differs\. The batch dashboard\/test-person\/\S+ stays/);
  // With the page still writable, a batch that went away and is not kept was merged.
  const merged = loadWriteUi(writable(undefined, { batch: BATCH }), {
    "/api/refresh": { status: 200, body: { ok: true, result: null, write: writable() } },
  });
  await merged.ui.refresh();
  await settle();
  assert.match(merged.els["#write"].text, /The batch dashboard\/test-person\/\S+ was merged\./);
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

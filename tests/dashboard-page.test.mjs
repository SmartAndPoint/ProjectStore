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
import { statusToColumn } from "../scripts/stages.mjs";
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
test("dashboard page: it listens on 127.0.0.1, refuses another Host with 403 and any method but GET and HEAD with 405", async () => {
  await withServer(async ({ vault, port, ready }) => {
    assert.equal(ready.url, `http://127.0.0.1:${port}/`);
    assert.equal(ready.port, port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
      assert.equal((await call(port, "/", { host })).status, 200, host);
    for (const host of ["evil.test", `evil.test:${port}`, "127.0.0.1", `[::1]:${port}`])
      assert.equal((await call(port, "/", { host })).status, 403, host);
    const before = treeHash(vault);
    // The scenario: WHEN a POST reaches any path, THEN 405 and no file changes.
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      for (const path of ["/", "/api/state", "/api/item?rel=adr/a-decision.md", "/nowhere"]) {
        const r = await call(port, path, { method });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.match(r.headers.allow || "", /GET/);
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
test("dashboard page: answering every route leaves the vault, the project and the core byte-identical", async () => {
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

test("dashboard page: no file of the page starts a process or writes a file", () => {
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
  for (const f of files) {
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

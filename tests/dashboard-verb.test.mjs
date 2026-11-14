// projectstore — tests/dashboard-verb.test.mjs: the dashboard verb, the
// launcher of the page over one vault (PS-DASHBOARD, "The dashboard package
// opens a read-only page over the bound vault, started by projectstore
// dashboard"; the spec "The dashboard package and its launcher: the folder,
// the dashboard verb, and a page that only reads", alias `dashboard`,
// contracts 1 to 8). The verb runs through the real bin as a child process,
// with PROJECTSTORE_DASHBOARD_ROOT naming a folder that holds a stand-in
// server (tests/fixtures/dashboard-stub-server.mjs), so no test starts the
// real page or takes the launcher's own port range. The page's own server is
// tests/dashboard-page.test.mjs's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, get } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_SHIPPED, PACKLIST, checkVersions, unshippedTopLevel } from "../scripts/version-guard.mjs";
import { startDashboard, pageAt, parsePort, PORT_RANGE } from "../scripts/dashboard.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO, "bin", "projectstore.mjs");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// A folder that stands in for <core root>/dashboard: the stub as its server.
function stubPage() {
  const dir = mkdtempSync(join(tmpdir(), "ps-dash-stub-"));
  copyFileSync(join(REPO, "tests", "fixtures", "dashboard-stub-server.mjs"), join(dir, "server.mjs"));
  return dir;
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

function fetchText(url) {
  return new Promise((done, fail) => {
    get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => done({ status: res.statusCode, body }));
    }).on("error", fail);
  });
}

// The verb as a person or a script runs it: the bin, in `cwd`. `untilLine`
// resolves at the first stdout line, so a test can act on a running page.
function runVerb(args, { cwd, env = {}, untilLine = false, timeoutMs = 20000 }) {
  const child = spawn(process.execPath, [BIN, "dashboard", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal, stdout, stderr })));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  exited.then(() => clearTimeout(timer));
  const firstLine = untilLine
    ? new Promise((done) => {
        const on = () => {
          const nl = stdout.indexOf("\n");
          if (nl !== -1) {
            child.stdout.removeListener("data", on);
            done(stdout.slice(0, nl));
          }
        };
        child.stdout.on("data", on);
        exited.then(() => done(null));
      })
    : null;
  return { child, exited, firstLine };
}

// [dashboard#1]
test("dashboard: the folder is a package of its own, never shipped, outside the lint's scope", () => {
  assert.ok(NOT_SHIPPED.has("dashboard"), "dashboard is in NOT_SHIPPED");
  const pkg = readJson(join(REPO, "dashboard", "package.json"));
  assert.equal(pkg.name, "projectstore-dashboard");
  assert.equal(pkg.dependencies, undefined, "no dependencies");
  assert.equal(pkg.devDependencies, undefined, "no devDependencies");
  assert.ok(!existsSync(join(REPO, "package-lock.json")), "no lockfile at the root");
  assert.ok(!existsSync(join(REPO, "dashboard", "package-lock.json")), "no lockfile in dashboard/ either");
  const packlist = readJson(join(REPO, PACKLIST));
  assert.deepEqual(
    packlist.filter((p) => p.startsWith("dashboard/")),
    [],
    "the plugin's package lists nothing under dashboard/",
  );
  assert.match(readFileSync(join(REPO, ".prettierignore"), "utf8"), /^dashboard\/$/m);
  assert.match(readFileSync(join(REPO, "tools", "lint", "eslint.config.mjs"), "utf8"), /"dashboard\/"/);
  // The scenario: WHEN a file is added under dashboard/, THEN the tree check
  // finds no unshipped top-level entry, so the packlist test passes unchanged.
  assert.deepEqual(unshippedTopLevel(["dashboard", "scripts", "bin"], packlist), []);
});

// [dashboard#2]
test("dashboard: the guard fails when the dashboard's version is not the core's, naming both files and versions", () => {
  assert.equal(checkVersions().ok, true, "the real tree agrees");
  const root = mkdtempSync(join(tmpdir(), "ps-dash-guard-"));
  for (const rel of [
    "package.json",
    join(".claude-plugin", "plugin.json"),
    join(".claude-plugin", "marketplace.json"),
  ]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(root, rel));
  }
  const version = readJson(join(REPO, "package.json")).version;
  mkdirSync(join(root, "dashboard"));
  writeFileSync(join(root, "dashboard", "package.json"), JSON.stringify({ name: "projectstore-dashboard", version }));
  assert.equal(checkVersions({ root }).ok, true, "the same version passes");
  writeFileSync(
    join(root, "dashboard", "package.json"),
    JSON.stringify({ name: "projectstore-dashboard", version: "0.0.1" }),
  );
  const r = checkVersions({ root });
  assert.equal(r.ok, false);
  assert.equal(r.error, "version mismatch");
  assert.deepEqual(r.versions.sort(), [version, "0.0.1"].sort());
  assert.ok(r.checked.some((s) => s.file === "dashboard/package.json" && s.version === "0.0.1"));
  assert.ok(r.checked.some((s) => s.file === "package.json" && s.version === version));
});

// [dashboard#3]
test("dashboard: with no binding the verb exits 3 with the core's refusal and starts nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ps-dash-unbound-"));
  const page = stubPage();
  const marker = join(page, "started.json");
  const plain = await runVerb([], { cwd, env: { PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MARKER: marker } }).exited;
  assert.equal(plain.code, 3, plain.stderr);
  assert.match(plain.stderr, /bound|binding|bind/i);
  assert.ok(!existsSync(marker), "the page was not started");
  const json = await runVerb(["--json"], { cwd, env: { PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MARKER: marker } })
    .exited;
  assert.equal(json.code, 3);
  const env = JSON.parse(json.stdout.trim());
  assert.equal(env.ok, false);
  assert.equal(env.verb, "dashboard");
  assert.equal(env.result.exit, 3);
  assert.equal(json.stdout.trim().split("\n").length, 1, "one line");
});

test("dashboard: a path and a --project that name different projects exit 2", async () => {
  const { proj } = makeVaultProject();
  const other = mkdtempSync(join(tmpdir(), "ps-dash-other-"));
  const r = await runVerb([other, "--project", proj], { cwd: proj }).exited;
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /different projects/);
});

test("dashboard: a path names the project, and wins over the environment's project", async () => {
  const { proj } = makeVaultProject();
  const unbound = mkdtempSync(join(tmpdir(), "ps-dash-cwd-"));
  const page = stubPage();
  for (const env of [{}, { PROJECTSTORE_PROJECT_DIR: unbound }]) {
    const marker = join(page, `args-${Object.keys(env).length}.json`);
    const run = runVerb([proj, "--json", "--port", String(await freePort())], {
      cwd: unbound,
      env: { ...env, PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MARKER: marker },
      untilLine: true,
    });
    try {
      const line = await run.firstLine;
      assert.ok(line, "started");
      assert.equal(JSON.parse(line).ok, true, JSON.stringify(env));
      const args = readJson(marker);
      assert.equal(realpathSync(args[args.indexOf("--project") + 1]), realpathSync(proj), JSON.stringify(env));
    } finally {
      run.child.kill("SIGINT");
      await run.exited;
    }
  }
});

// [dashboard#4] As amended on 2026-11-14: a named page folder is the page or
// nothing, and is never fetched; the fetch of an npm copy, and the refusal of
// any other copy with no folder, are tests/dashboard-fetch.test.mjs's.
test("dashboard: a named page folder with no server.mjs exits 1 naming it, fetches nothing, and names no build", async () => {
  const { proj } = makeVaultProject();
  const empty = mkdtempSync(join(tmpdir(), "ps-dash-none-"));
  const cache = mkdtempSync(join(tmpdir(), "ps-dash-none-cache-"));
  const env = { PROJECTSTORE_DASHBOARD_ROOT: empty, XDG_CACHE_HOME: cache };
  assert.equal(pageAt(REPO, { PROJECTSTORE_DASHBOARD_ROOT: empty }), null);
  const r = await runVerb([], { cwd: proj, env }).exited;
  assert.equal(r.code, 1, r.stderr);
  assert.equal(
    r.stderr,
    `PROJECTSTORE_DASHBOARD_ROOT names ${JSON.stringify(empty)}, which has no server.mjs: nothing was started or fetched.\n`,
  );
  assert.doesNotMatch(r.stdout + r.stderr, /npm (ci|run|install)|build/);
  const j = await runVerb(["--json"], { cwd: proj, env }).exited;
  assert.equal(j.code, 1);
  const envelope = JSON.parse(j.stdout.trim());
  assert.equal(envelope.ok, false);
  assert.equal(envelope.result.error, r.stderr.trimEnd(), "the envelope's error is the text, word for word");
  assert.deepEqual(readdirSync(cache), [], "the cache is not touched");
});

// [dashboard#5]
test("dashboard: started, the verb prints one envelope line with the address, serves, and exits 0 on an interrupt", async () => {
  const { proj } = makeVaultProject();
  const page = stubPage();
  const port = await freePort();
  const run = runVerb(["--json", "--port", String(port)], {
    cwd: proj,
    env: { PROJECTSTORE_DASHBOARD_ROOT: page },
    untilLine: true,
  });
  try {
    const line = await run.firstLine;
    assert.ok(line, "a first line");
    const env = JSON.parse(line);
    assert.equal(env.ok, true);
    assert.equal(env.verb, "dashboard");
    assert.equal(env.result.url, `http://127.0.0.1:${port}/`);
    assert.equal(env.result.port, port);
    assert.equal(typeof env.result.vault, "string");
    const answer = await fetchText(env.result.url);
    assert.equal(answer.body, "stub");
    run.child.kill("SIGINT");
    const r = await run.exited;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "nothing more on stdout after the envelope");
  } finally {
    run.child.kill("SIGKILL");
  }
});

test("dashboard: started for a person, the address stands on a line of its own", async () => {
  const { proj } = makeVaultProject();
  const page = stubPage();
  const port = await freePort();
  const run = runVerb(["--port", String(port)], {
    cwd: proj,
    env: { PROJECTSTORE_DASHBOARD_ROOT: page },
    untilLine: true,
  });
  try {
    await run.firstLine;
    await new Promise((r) => setTimeout(r, 100));
    run.child.kill("SIGINT");
    const r = await run.exited;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(`http://127.0.0.1:${port}/`), r.stdout);
    assert.match(r.stdout, /only reads the vault/);
  } finally {
    run.child.kill("SIGKILL");
  }
});

// [dashboard#6]
test("dashboard: the browser opens only for a person, and never with --no-open", async () => {
  const { proj } = makeVaultProject();
  const page = stubPage();
  const env = { ...process.env, PROJECTSTORE_DASHBOARD_ROOT: page };
  for (const [interactive, values, want] of [
    [true, {}, 1],
    [true, { "no-open": true }, 0],
    [false, {}, 0],
  ]) {
    const opened = [];
    const signals = new EventEmitter();
    const r = await startDashboard({
      root: REPO,
      project: proj,
      values: { ...values, port: String(await freePort()) },
      env,
      interactive,
      open: (url) => opened.push(url),
      signals,
      stderr: { write() {} },
    });
    assert.equal(r.ok, true, r.text);
    assert.equal(opened.length, want, JSON.stringify({ interactive, values }));
    if (want) assert.equal(opened[0], r.result.url);
    signals.emit("SIGINT");
    assert.equal(await r.wait, 0);
  }
});

// [dashboard#7]
test("dashboard: --port takes that port or fails, and no --port asks for the launcher's range", async () => {
  assert.deepEqual([...PORT_RANGE], [4800, 4809]);
  for (const bad of ["abc", "0", "70000", "12.5"]) assert.equal(parsePort(bad), null, bad);
  assert.equal(parsePort("4810"), 4810);
  const { proj } = makeVaultProject();
  const page = stubPage();
  // A bad number is a usage error.
  const bad = await runVerb(["--port", "abc"], { cwd: proj, env: { PROJECTSTORE_DASHBOARD_ROOT: page } }).exited;
  assert.equal(bad.code, 2, bad.stderr);
  // A taken port is a refusal, with no other port tried.
  const holder = createServer();
  await new Promise((r) => holder.listen(0, "127.0.0.1", r));
  const taken = holder.address().port;
  try {
    const r = await runVerb(["--port", String(taken)], { cwd: proj, env: { PROJECTSTORE_DASHBOARD_ROOT: page } })
      .exited;
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`port ${taken} is in use`));
  } finally {
    holder.close();
  }
  // No --port: the server is asked for the range (the stub records it and
  // listens elsewhere, so the real range is never taken here).
  const marker = join(page, "args.json");
  const run = runVerb(["--json"], {
    cwd: proj,
    env: { PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MARKER: marker },
    untilLine: true,
  });
  try {
    await run.firstLine;
    const args = readJson(marker);
    assert.deepEqual(args.slice(args.indexOf("--ports"), args.indexOf("--ports") + 2), ["--ports", "4800-4809"]);
    assert.ok(args.includes("--watch-stdin"));
    // The bin resolves the project from its working directory, which the
    // system reports through any link (macOS: /var is /private/var).
    assert.equal(realpathSync(args[args.indexOf("--project") + 1]), realpathSync(proj));
    assert.equal(args[args.indexOf("--core") + 1], REPO);
  } finally {
    run.child.kill("SIGINT");
    await run.exited;
  }
});

// [dashboard#8]
test("dashboard: a server that refuses before listening passes its exit and its text on", async () => {
  const { proj } = makeVaultProject();
  const page = stubPage();
  const r = await runVerb([], { cwd: proj, env: { PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MODE: "version" } }).exited;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /9\.9\.9/);
  assert.match(r.stderr, /0\.0\.1/);
});

test("dashboard: a server that never says it is ready is stopped, and the verb exits 1", async () => {
  const { proj } = makeVaultProject();
  const page = stubPage();
  const signals = new EventEmitter();
  const r = await startDashboard({
    root: REPO,
    project: proj,
    values: {},
    env: { ...process.env, PROJECTSTORE_DASHBOARD_ROOT: page, STUB_MODE: "silent" },
    signals,
    startMs: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.match(r.result.error, /did not start/);
});

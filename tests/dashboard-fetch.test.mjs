// projectstore — tests/dashboard-fetch.test.mjs: the page of a copy installed
// from npm (PS-DASHBOARD, "The release builds, checks and publishes the
// dashboard package at the core's version"; the spec "The dashboard package
// and its launcher: the folder, the dashboard verb, and a page that only
// reads", alias `dashboard`, contracts 3 and 4 as amended, and 14 to 17).
//
// No test reaches a registry. The end-to-end runs start the bin of an
// npm-shaped core (fakePackageRoot under `_npx/`, so installChannel names it
// `package`) with a PATH npm stub (tests/fixtures/fetch.mjs) that lays a
// projectstore-dashboard tree whose server is tests/fixtures/dashboard-stub-
// server.mjs; the edge cases call pageFor and startDashboard in-process with
// the stub's in-process spawn. One check runs the real npm, offline with an
// empty cache, as the suite's hermetic setup leaves every npm.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cachePaths } from "../scripts/harness.mjs";
import { registrationPayloadRoot } from "../scripts/surfaces.mjs";
import { copyPackageTree, fromTerminalIn } from "../scripts/lib.mjs";
import { PUBLIC_REGISTRY } from "../scripts/fetch-shell.mjs";
import { pageFor, checkPage, pageVersion, npmCopy, installEnv, PAGE_PACKAGE } from "../scripts/dashboard-fetch.mjs";
import { startDashboard } from "../scripts/dashboard.mjs";
import { fakeNpm, fakeNpmSpawn, layDashboardTree, FAKE_REGISTRY } from "./fixtures/fetch.mjs";
import { fakePackageRoot, cacheRoot, fakeSynced, fakeMarketplace } from "./fixtures/install.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const V = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const PKG = `${PAGE_PACKAGE}@${V}`;
const BASE = mkdtempSync(join(tmpdir(), "ps-dash-fetch-"));
after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 2 }));
const tmp = (p) => mkdtempSync(join(BASE, p));
// The core as npx extracts it: the shipped tree, with no dashboard/ folder.
const CORE = fakePackageRoot(join(BASE, "_npx", "x", "node_modules", "projectstore"), V);
const list = (d) => (existsSync(d) ? readdirSync(d) : []);

// A machine of its own for each test: a home, a cache, an npm stub, a bound project.
function machine() {
  const root = tmp("m-");
  const home = join(root, "home");
  mkdirSync(home);
  const xdg = join(root, "xdg");
  const npm = fakeNpm(join(root, "npm-bin"));
  const { proj } = makeVaultProject();
  const cache = cachePaths({ env: { [cachePaths({}).variable]: xdg }, home });
  const env = {
    HOME: home,
    [cache.variable]: xdg,
    PATH: `${npm.dir}${delimiter}${process.env.PATH}`,
    FAKE_NPM_REGISTRY: FAKE_REGISTRY,
  };
  return { root, home, xdg, npm, proj, cache, env };
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

// The verb through a core's own bin, as a person or a script runs it.
// `untilLine` resolves at the first stdout line, so a test acts on a running page.
function runVerb(core, args, { cwd, env = {}, untilLine = false, timeoutMs = 30000 }) {
  const child = spawn(process.execPath, [join(core, "bin", "projectstore.mjs"), "dashboard", ...args], {
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

// A run that ends on its own (a refusal): its exit, its text, its envelope.
async function refusedRun(core, m, extra = {}, args = []) {
  const text = await runVerb(core, args, { cwd: m.proj, env: { ...m.env, ...extra } }).exited;
  const json = await runVerb(core, ["--json", ...args], { cwd: m.proj, env: { ...m.env, ...extra } }).exited;
  const lines = json.stdout.trim().split("\n");
  return { text, json, lines, envelope: JSON.parse(lines[0]) };
}

// A run that serves: the envelope line, then an interrupt.
async function servedRun(core, m, extra = {}) {
  const run = runVerb(core, ["--json", "--port", String(await freePort())], {
    cwd: m.proj,
    env: { ...m.env, ...extra },
    untilLine: true,
  });
  const line = await run.firstLine;
  run.child.kill("SIGINT");
  const end = await run.exited;
  return { line, envelope: line ? JSON.parse(line) : null, end };
}

// An npm-shaped page folder at the cache's place for V, broken as `mode` says.
function layCachedPage(m, mode = "ok", version = V) {
  const prefix = tmp("lay-");
  const laid = layDashboardTree(prefix, { version }, mode);
  const target = m.cache.dashboard(V);
  mkdirSync(dirname(target), { recursive: true });
  copyTree(laid, target);
  return target;
}
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const n of readdirSync(from, { withFileTypes: true })) {
    if (n.isDirectory()) copyTree(join(from, n.name), join(to, n.name));
    else copyFileSync(join(from, n.name), join(to, n.name));
  }
}

// In-process: pageFor for an npm copy, with the stub's spawn.
const fetchIn = (m, opts = {}) =>
  pageFor({ root: CORE, project: m.proj, env: m.env, home: m.home, spawn: opts.spawn, ...opts });

// ─── The fetch, end to end ─────────────────────────────────────────────

// [dashboard#15] [dashboard#14] [dashboard#16]
test("dashboard fetch: an npm copy fetches its page once into the cache, at exactly its version, from the user's registry, and a second run makes no npm call, offline", async () => {
  const m = machine();
  const first = await servedRun(CORE, m);
  assert.ok(first.envelope, first.end.stderr);
  assert.equal(first.envelope.ok, true, first.end.stderr);
  assert.equal(first.envelope.verb, "dashboard");
  assert.equal(first.end.code, 0, first.end.stderr);
  assert.equal(first.end.stdout.trim().split("\n").length, 1, "under --json stdout is the envelope alone");
  assert.doesNotMatch(first.end.stderr, /fetching/, "no live line without a terminal");
  // npm ran twice: the user's registry, then one install of exactly V.
  const calls = m.npm.log();
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["config", "install"],
  );
  const [config, install] = calls;
  assert.deepEqual(config.argv, ["config", "get", "registry", "--no-update-notifier"]);
  assert.equal(realpathSync(config.cwd), realpathSync(m.home), "the user's registry, read from the home");
  assert.deepEqual(config.npmConfig, [], "no lower-case npm_config_* reaches the read");
  const prefix = install.argv[install.argv.indexOf("--prefix") + 1];
  assert.equal(dirname(prefix), m.cache.fetch, "the scratch is a run's folder under the cache's fetch folder");
  assert.match(prefix.slice(m.cache.fetch.length + 1), /^\d+-\d+$/);
  assert.equal(install.cwd, join(realpathSync(m.cache.fetch), basename(prefix)), "npm runs in the scratch");
  assert.deepEqual(install.argv, [
    "install",
    "--prefix",
    prefix,
    "--no-save",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--json",
    "--registry",
    FAKE_REGISTRY,
    "--fetch-timeout=30000",
    "--fetch-retries=2",
    "--fetch-retry-mintimeout=1000",
    "--fetch-retry-maxtimeout=5000",
    PKG,
  ]);
  // The folder, moved whole; the scratch, gone.
  const page = m.cache.dashboard(V);
  assert.equal(page, join(m.cache.root, "dashboard", V));
  assert.equal(checkPage(page, V), null);
  assert.deepEqual(list(m.cache.fetch), [], "no scratch folder is left");
  assert.deepEqual(list(join(m.cache.root, "dashboard")), [V]);
  // Again, with every npm answer an offline failure: the cache's page starts, npm is never run.
  m.npm.reset();
  const again = await servedRun(CORE, m, { FAKE_NPM_MODE: "ENOTCACHED" });
  assert.equal(again.envelope?.ok, true, again.end.stderr);
  assert.deepEqual(m.npm.log(), [], "no npm call, no registry read");
  assert.equal(again.end.code, 0);
});

// [dashboard#17]
test("dashboard fetch: two launches at once both start a page, the cache holds one whole folder for V, and no scratch is left", async () => {
  const m = machine();
  const env = { ...m.env, FAKE_NPM_DELAY_MS: "1500" };
  const runs = [];
  for (let i = 0; i < 2; i++)
    runs.push(runVerb(CORE, ["--json", "--port", String(await freePort())], { cwd: m.proj, env, untilLine: true }));
  try {
    const lines = await Promise.all(runs.map((r) => r.firstLine));
    for (const [i, line] of lines.entries()) {
      assert.ok(line, `run ${i} printed its envelope`);
      assert.equal(JSON.parse(line).ok, true, line);
    }
    assert.equal(m.npm.installs().length, 2, "both fetched: neither found a page when it looked");
  } finally {
    for (const r of runs) r.child.kill("SIGINT");
  }
  for (const r of runs) assert.equal((await r.exited).code, 0);
  assert.deepEqual(list(join(m.cache.root, "dashboard")), [V]);
  assert.equal(checkPage(m.cache.dashboard(V), V), null, "the folder is whole");
  assert.deepEqual(list(m.cache.fetch), [], "no scratch folder once both have ended");
});

// ─── What a fetch refuses ──────────────────────────────────────────────

// [dashboard#16]
test("dashboard fetch: a version that is not published exits 1, says so and that no other version is tried, and names the public registry's command; nothing is left", async () => {
  const m = machine();
  const r = await refusedRun(CORE, m, { FAKE_NPM_MODE: "ETARGET" });
  assert.equal(r.text.code, 1, r.text.stderr);
  const said = r.text.stderr.trimEnd();
  assert.match(said, new RegExp(`page for ${V.replace(/\./g, "\\.")}, ${PAGE_PACKAGE}@`));
  assert.match(said, /is not published on https:\/\/registry\.example\.test\/ \(npm ETARGET\)/);
  assert.match(said, /no other version is tried/);
  assert.ok(said.includes(`If ${V} was just released, try again in a few minutes.`));
  const lines = said.split("\n");
  assert.ok(
    lines.includes(`NPM_CONFIG_REGISTRY=${PUBLIC_REGISTRY} npx projectstore@${V} dashboard`),
    "the command stands alone on its line",
  );
  // The bin resolves the project from its working directory, which the system
  // reports through any link (macOS: /var is /private/var).
  const lead = fromTerminalIn(realpathSync(m.proj));
  assert.ok(
    lines.some((l) => l.includes(lead) && l.endsWith(":")),
    "the lead names the directory",
  );
  assert.doesNotMatch(said, /--project|npm (ci|run)/);
  // --json: one line, and its error is the text a person reads, word for word.
  assert.equal(r.json.code, 1);
  assert.equal(r.lines.length, 1);
  assert.equal(r.envelope.ok, false);
  assert.equal(r.envelope.result.error, said);
  assert.deepEqual(list(m.cache.fetch), []);
  assert.ok(!existsSync(m.cache.dashboard(V)));
  // From npm's own registry there is no mirror to blame, so no command.
  const own = await fetchIn(m, { spawn: fakeNpmSpawn({ mode: "E404", registry: `${PUBLIC_REGISTRY}/` }).spawn });
  assert.equal(own.ok, false);
  assert.match(own.error, /is not published on https:\/\/registry\.npmjs\.org\/ \(npm E404\)/);
  assert.doesNotMatch(own.error, /NPM_CONFIG_REGISTRY/);
  // A registry that could not be read is named as npm's configuration, and
  // unknown is not npm's own: that configuration may name a mirror, so the
  // public-registry form is given too, as the shell fetch gives it.
  const unread = await fetchIn(machine(), { spawn: fakeNpmSpawn({ mode: "ETARGET", registry: false }).spawn });
  assert.equal(unread.ok, false);
  assert.match(unread.error, /is not published on the registry in your npm configuration \(npm ETARGET\)/);
  assert.ok(
    unread.error.split("\n").includes(`NPM_CONFIG_REGISTRY=${PUBLIC_REGISTRY} npx projectstore@${V} dashboard`),
    unread.error,
  );
});

// [dashboard#15]
test("dashboard fetch: what npm laid under another name or version, or with no server, is refused naming the file and both values, and nothing is kept", async () => {
  for (const [mode, want] of [
    ["wrong-name", [`"${PAGE_PACKAGE}-other"`, `"${PAGE_PACKAGE}"`, "package.json has name"]],
    ["wrong-version", [`"${V}-other"`, `"${V}"`, "package.json has version"]],
    ["no-server", ["server.mjs is not there"]],
  ]) {
    const m = machine();
    const fake = fakeNpmSpawn({ mode });
    const r = await fetchIn(m, { spawn: fake.spawn });
    assert.equal(r.ok, false, mode);
    assert.equal(r.code, "EVERIFY", mode);
    for (const w of want) assert.ok(r.error.includes(w), `${mode}: ${r.error}`);
    assert.ok(r.error.includes(join(m.cache.fetch)), `${mode}: the file is named by its path`);
    assert.deepEqual(list(m.cache.fetch), [], `${mode}: no scratch is left`);
    assert.ok(!existsSync(m.cache.dashboard(V)), `${mode}: no page folder`);
  }
  // Through the bin: exit 1, and the envelope's error is the text.
  const m = machine();
  const r = await refusedRun(CORE, m, { FAKE_NPM_MODE: "wrong-version" });
  assert.equal(r.text.code, 1);
  // Two runs, two scratch folders: the texts differ in the run's id alone.
  const run = (t) => t.replace(/\/fetch\/\d+-\d+\//g, "/fetch/<run>/");
  assert.equal(run(r.envelope.result.error), run(r.text.stderr.trimEnd()));
  assert.match(r.envelope.result.error, /is not this copy's page/);
});

// [dashboard#16]
test("dashboard fetch: npm missing, the network down and a fetch over its budget each exit 1, say so and that the page needs the network once per version", async () => {
  // No npm on PATH, through the bin: npm and the network, and no registry,
  // since none was asked.
  const m = machine();
  const empty = tmp("no-npm-");
  const missing = await refusedRun(CORE, m, { PATH: empty });
  assert.equal(missing.text.code, 1, missing.text.stderr);
  assert.match(missing.text.stderr, /npm could not start: it was not found on PATH/);
  assert.match(missing.text.stderr, /needs npm and the network once per version/);
  assert.match(missing.text.stderr, /put npm on PATH/);
  assert.doesNotMatch(missing.text.stderr, /NPM_CONFIG_REGISTRY|registry/);
  assert.equal(missing.text.stderr.trimEnd().split("\n").length, 1, "one paragraph, no command");
  assert.equal(missing.envelope.result.error, missing.text.stderr.trimEnd());
  assert.deepEqual(list(m.cache.fetch), []);
  assert.ok(!existsSync(m.cache.dashboard(V)));
  // Offline, the first run: npm's ENOTCACHED.
  const offline = await fetchIn(machine(), { spawn: fakeNpmSpawn({ mode: "ENOTCACHED" }).spawn });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /ENOTCACHED/);
  assert.match(offline.error, /needs the network once per version; later runs start it from the cache/);
  // A refused connection, and npm's own timeout.
  for (const mode of ["ECONNREFUSED", "FETCH_ERROR"]) {
    const r = await fetchIn(machine(), { spawn: fakeNpmSpawn({ mode }).spawn });
    assert.equal(r.ok, false, mode);
    assert.match(r.error, /needs the network once per version/, mode);
  }
  // Our budget: an install that never answers is stopped.
  const slow = machine();
  const hung = await fetchIn(slow, { spawn: fakeNpmSpawn({ mode: "hang" }).spawn, budget: 300 });
  assert.equal(hung.ok, false);
  assert.equal(hung.code, "EBUDGET");
  assert.match(hung.error, /took longer than 0\.3 s and was stopped/);
  assert.match(hung.error, /needs the network once per version/);
  assert.deepEqual(list(slow.cache.fetch), [], "the stopped run's scratch goes");
});

// [dashboard#16]
test("dashboard fetch: a network failure or a timeout names the registry asked, says the project's .npmrc is not read, and gives the NPM_CONFIG_REGISTRY form alone on its line", async () => {
  const command = `NPM_CONFIG_REGISTRY=<your registry> npx projectstore@${V} dashboard`;
  for (const [mode, budget] of [
    ["ENOTCACHED", undefined],
    ["ECONNREFUSED", undefined],
    ["FETCH_ERROR", undefined],
    ["hang", 300],
  ]) {
    const m = machine();
    const r = await fetchIn(m, { spawn: fakeNpmSpawn({ mode }).spawn, budget });
    assert.equal(r.ok, false, mode);
    const lines = r.error.split("\n");
    assert.ok(lines.includes(command), `${mode}: the command stands alone on its line`);
    const lead = lines[lines.indexOf(command) - 1];
    assert.ok(lead.startsWith(`This fetch asked ${FAKE_REGISTRY};`), `${mode}: ${lead}`);
    assert.ok(
      lead.includes("a project's .npmrc and lower-case npm_config_* variables are not passed to it"),
      `${mode}: ${lead}`,
    );
    assert.ok(lead.includes(fromTerminalIn(m.proj)) && lead.endsWith(":"), `${mode}: the lead names the directory`);
    assert.doesNotMatch(r.error, /npm_config_registry=/, `${mode}: never the lower-case form`);
  }
  // A registry read that fails names no URL: npm took its own configuration.
  const m = machine();
  const r = await fetchIn(m, { spawn: fakeNpmSpawn({ mode: "ENOTCACHED", registry: false }).spawn });
  assert.match(r.error, /^npm could not fetch \S+ from the registry in your npm configuration: ENOTCACHED/);
  assert.ok(r.error.includes("This fetch asked the registry in your npm configuration;"), r.error);
  assert.ok(r.error.split("\n").includes(command));
  // Through the bin, the envelope's error is the text, word for word.
  const bin = await refusedRun(CORE, machine(), { FAKE_NPM_MODE: "ENOTCACHED" });
  assert.equal(bin.text.code, 1);
  assert.ok(bin.text.stderr.split("\n").includes(command));
  assert.equal(bin.envelope.result.error, bin.text.stderr.trimEnd());
});

// [dashboard#15]
test("dashboard fetch: the install runs with no lower-case npm_config_* in its environment, and names the user's registry", async () => {
  // An outer npm exec hands down the project's .npmrc as lower-case variables.
  const m = machine();
  const outer = {
    npm_config_registry: "https://project-npmrc.example.test/",
    npm_config_https_proxy: "http://proxy.example.test:3128",
    npm_config_cafile: "/project/ca.pem",
  };
  const run = await servedRun(CORE, m, outer);
  assert.equal(run.envelope?.ok, true, run.end.stderr);
  const [config, install] = m.npm.log();
  for (const call of [config, install]) {
    for (const k of Object.keys(outer)) assert.ok(!call.npmConfig.includes(k), `${call.argv[0]}: ${k} is dropped`);
    assert.equal(call.registryEnv, null, `${call.argv[0]}: no npm_config_registry`);
  }
  assert.deepEqual(install.npmConfig, [], "no lower-case npm_config_* at all reaches the install");
  assert.equal(install.argv[install.argv.indexOf("--registry") + 1], FAKE_REGISTRY, "the user's registry, named");
  // The cleaning itself: lower-case gone, the user's upper-case kept.
  assert.deepEqual(installEnv({ npm_config_cafile: "x", NPM_CONFIG_REGISTRY: "y", PATH: "/p" }), {
    NPM_CONFIG_REGISTRY: "y",
    PATH: "/p",
  });
  // In-process, the same: the env npm got, and --registry every time.
  const fake = fakeNpmSpawn();
  const fresh = machine();
  const ok = await fetchIn(fresh, { spawn: fake.spawn, env: { ...fresh.env, ...outer } });
  assert.equal(ok.ok, true, ok.error);
  const [call] = fake.installs();
  assert.deepEqual(
    Object.keys(call.env).filter((k) => k.startsWith("npm_config_")),
    [],
  );
  assert.equal(call.argv[call.argv.indexOf("--registry") + 1], FAKE_REGISTRY);
});

// [dashboard#15]
test("dashboard fetch: when the user's registry cannot be read, the install names none, and npm takes the user's own configuration from a clean environment", async () => {
  const fake = fakeNpmSpawn({ registry: false });
  const m = machine();
  const env = { ...m.env, npm_config_registry: "https://project-npmrc.example.test/", npm_config_cafile: "/ca.pem" };
  const r = await fetchIn(m, { spawn: fake.spawn, env });
  assert.equal(r.ok, true, r.error);
  const [call] = fake.installs();
  assert.ok(!call.argv.includes("--registry"), "no --registry: never a registry forced over the user's own");
  assert.deepEqual(
    Object.keys(call.env).filter((k) => k.startsWith("npm_config_")),
    [],
    "no lower-case npm_config_* reaches the install",
  );
  assert.equal(call.cwd, call.argv[call.argv.indexOf("--prefix") + 1], "npm runs in the scratch folder");
  assert.equal(call.argv.at(-1), PKG);
});

// [dashboard#16]
test("dashboard fetch: the real npm, offline with an empty cache, refuses the first run and leaves nothing", async (t) => {
  if (spawnSync("npm", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("no npm on PATH");
  const m = machine();
  const env = {
    ...process.env,
    HOME: m.home,
    [m.cache.variable]: m.xdg,
    // The install drops every lower-case npm_config_*: the upper-case form stays.
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_CACHE: tmp("npm-cache-"),
  };
  const r = await pageFor({ root: CORE, project: m.proj, env, home: m.home });
  assert.equal(r.ok, false, "offline, nothing is fetched");
  assert.match(r.error, /ENOTCACHED/);
  assert.match(r.error, /needs the network once per version/);
  assert.deepEqual(list(m.cache.fetch), []);
  assert.ok(!existsSync(m.cache.dashboard(V)));
});

// [dashboard#16]
test("dashboard fetch: no cache root, or a cache that cannot be written, names the variable to set, and npm is not run", async () => {
  const variable = cachePaths({}).variable;
  const fake = fakeNpmSpawn();
  const none = await pageFor({ root: CORE, env: { [variable]: "relative" }, home: "", spawn: fake.spawn });
  assert.equal(none.ok, false);
  assert.equal(none.code, "ENOCACHE");
  assert.ok(none.error.includes(`Set ${variable} to a writable directory`), none.error);
  // Under a regular file, no folder can be made.
  const blocker = join(tmp("blocker-"), "file");
  writeFileSync(blocker, "");
  const m = machine();
  const r = await refusedRun(CORE, m, { [variable]: blocker });
  assert.equal(r.text.code, 1, r.text.stderr);
  assert.ok(r.text.stderr.includes(join(blocker, "projectstore")), r.text.stderr);
  assert.ok(r.text.stderr.includes(`it comes from ${variable}. Set ${variable} to a writable directory`));
  assert.equal(r.envelope.result.error, r.text.stderr.trimEnd());
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(m.npm.log(), [], "no npm call when no cache folder can be made");
});

// ─── The cache ──────────────────────────────────────────────────────────

// [dashboard#14]
test("dashboard fetch: a cached folder of another package or version, or with no server, is not started, and a fetch replaces it", async () => {
  for (const mode of ["wrong-name", "wrong-version", "no-server"]) {
    const m = machine();
    const target = layCachedPage(m, mode);
    assert.notEqual(checkPage(target, V), null, mode);
    const fake = fakeNpmSpawn();
    const r = await fetchIn(m, { spawn: fake.spawn });
    assert.equal(r.ok, true, `${mode}: ${r.error}`);
    assert.equal(r.fetched, true, mode);
    assert.equal(r.dir, target);
    assert.equal(fake.installs().length, 1, mode);
    assert.equal(checkPage(target, V), null, `${mode}: replaced by the page of V`);
    assert.deepEqual(list(m.cache.fetch), [], mode);
  }
  // A good one is the page, with no npm call.
  const m = machine();
  layCachedPage(m);
  const fake = fakeNpmSpawn();
  const r = await fetchIn(m, { spawn: fake.spawn });
  assert.deepEqual([r.ok, r.fetched, fake.calls.length], [true, false, 0]);
});

// [dashboard#17]
test("dashboard fetch: a bad folder is replaced only after a second look, so a good page another launch placed meanwhile stays", async () => {
  const m = machine();
  const target = layCachedPage(m, "wrong-version");
  // While this run's npm installs, another launch puts the good page in place.
  const fake = fakeNpmSpawn({
    onInstall: () => {
      rmSync(target, { recursive: true, force: true });
      layCachedPage(m, "ok");
      writeFileSync(join(target, "placed-by-the-other-launch"), "");
    },
  });
  const r = await fetchIn(m, { spawn: fake.spawn });
  assert.equal(r.ok, true, r.error);
  assert.ok(
    existsSync(join(target, "placed-by-the-other-launch")),
    "the other launch's folder was adopted, not removed",
  );
  assert.equal(checkPage(target, V), null);
  assert.deepEqual(list(m.cache.fetch), []);
});

// [dashboard#17]
test("dashboard fetch: a good page another launch placed between this run's install and its move is used, and this run's copy goes", async () => {
  // With no folder for V when the run looked, the other launch's folder lands
  // while npm installs: the move finds it there.
  const m = machine();
  const target = m.cache.dashboard(V);
  const fake = fakeNpmSpawn({
    onInstall: () => {
      layCachedPage(m, "ok");
      writeFileSync(join(target, "placed-by-the-other-launch"), "");
    },
  });
  const r = await fetchIn(m, { spawn: fake.spawn });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dir, target);
  assert.ok(existsSync(join(target, "placed-by-the-other-launch")), "the other launch's folder is the page");
  assert.deepEqual(list(m.cache.fetch), [], "this run's scratch, its own copy with it, is gone");
  // Inside movePath itself: it looked (no folder), then the other launch's
  // rename landed, then its own rename met that folder — ENOTEMPTY, measured
  // with two launches at once. The folder is looked at again and used.
  const n = machine();
  const at = n.cache.dashboard(V);
  let lost = 0;
  const losing = (from, to) => {
    if (to !== at) return renameSync(from, to) ?? "moved";
    if (existsSync(to)) return "target-exists";
    layCachedPage(n, "ok");
    writeFileSync(join(at, "won-the-race"), "");
    lost++;
    renameSync(from, to);
    return "moved";
  };
  const raced = await fetchIn(n, { spawn: fakeNpmSpawn().spawn, movePathFn: losing });
  assert.equal(lost, 1, "the race was lost once");
  assert.equal(raced.ok, true, raced.error);
  assert.ok(existsSync(join(at, "won-the-race")), "the winner's folder is the page");
  assert.equal(checkPage(at, V), null);
  assert.deepEqual(list(n.cache.fetch), []);
  // And a folder that is still bad after the lost race is refused, nothing started.
  const b = machine();
  const bad = b.cache.dashboard(V);
  const losingToBad = (from, to) => {
    if (to !== bad) return renameSync(from, to) ?? "moved";
    layCachedPage(b, "wrong-version");
    renameSync(from, to);
    return "moved";
  };
  // A bad folder, set aside — but between the second look and the move aside,
  // another launch swaps the good page in. What was set aside is looked at a
  // third time, and the good page goes back and is used: never removed.
  const t3 = machine();
  const third = layCachedPage(t3, "wrong-version");
  let swapped = 0;
  const swapBeforeAside = (from, to) => {
    if (from === third && to !== third) {
      rmSync(third, { recursive: true, force: true });
      layCachedPage(t3, "ok");
      writeFileSync(join(third, "swapped-in-by-the-other-launch"), "");
      swapped++;
    }
    if (existsSync(to)) return "target-exists";
    renameSync(from, to);
    return "moved";
  };
  const kept = await fetchIn(t3, { spawn: fakeNpmSpawn().spawn, movePathFn: swapBeforeAside });
  assert.equal(swapped, 1, "the swap happened at the move aside");
  assert.equal(kept.ok, true, kept.error);
  assert.equal(kept.dir, third);
  assert.ok(existsSync(join(third, "swapped-in-by-the-other-launch")), "the good folder survives and is the page");
  assert.equal(checkPage(third, V), null);
  assert.deepEqual(list(t3.cache.fetch), [], "this run's own copy went with its scratch");
  const refused = await fetchIn(b, { spawn: fakeNpmSpawn().spawn, movePathFn: losingToBad });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "EVERIFY");
  assert.match(refused.error, /has version "\S+-other", expected/);
  assert.deepEqual(list(b.cache.fetch), []);
  // Any failed move looks again, not only ENOTEMPTY and EEXIST: Windows
  // answers the lost race with EPERM. A good page there is used…
  const w = machine();
  const won = w.cache.dashboard(V);
  const eperm = (code) =>
    Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: "rename" });
  const losingOnWindows = (from, to) => {
    if (to !== won) return renameSync(from, to) ?? "moved";
    layCachedPage(w, "ok");
    writeFileSync(join(won, "won-on-windows"), "");
    throw eperm("EPERM");
  };
  const windows = await fetchIn(w, { spawn: fakeNpmSpawn().spawn, movePathFn: losingOnWindows });
  assert.equal(windows.ok, true, windows.error);
  assert.ok(existsSync(join(won, "won-on-windows")), "EPERM with a good page there: the page is used");
  assert.deepEqual(list(w.cache.fetch), []);
  // …and with no good page there, the failure is the cache's refusal, as before.
  const x = machine();
  const denied = await fetchIn(x, {
    spawn: fakeNpmSpawn().spawn,
    movePathFn: (from, to) => {
      if (to === x.cache.dashboard(V)) throw eperm("EPERM");
      return renameSync(from, to) ?? "moved";
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "ECACHE");
  assert.match(denied.error, /cannot be written \(EPERM\)/);
  assert.ok(!existsSync(x.cache.dashboard(V)));
  assert.deepEqual(list(x.cache.fetch), [], "the scratch goes with the refusal");
});

// [dashboard#15]
test("dashboard fetch: a killed run's scratch stays until a later fetching run, which removes the scratch of every run whose process has ended", async () => {
  const m = machine();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const left = join(m.cache.fetch, `${dead}-1700000000000`);
  mkdirSync(join(left, "node_modules", PAGE_PACKAGE), { recursive: true });
  const live = join(m.cache.fetch, `${process.pid}-1`);
  mkdirSync(live, { recursive: true });
  const r = await fetchIn(m, { spawn: fakeNpmSpawn().spawn });
  assert.equal(r.ok, true, r.error);
  assert.ok(!existsSync(left), "a dead run's scratch is removed");
  assert.ok(existsSync(live), "a live process's scratch stays");
});

test("dashboard fetch: the page of V is a package.json naming the package at exactly V with its server; the version is strict semver", () => {
  const dir = layDashboardTree(tmp("check-"), { version: V });
  assert.equal(checkPage(dir, V), null);
  assert.match(checkPage(dir, `${V}-rc.1`), /has version/);
  assert.match(checkPage(join(dir, "nowhere"), V), /has name null/);
  assert.equal(pageVersion(CORE), V);
  const odd = tmp("odd-");
  writeFileSync(join(odd, "package.json"), JSON.stringify({ name: "projectstore", version: "main" }));
  assert.equal(pageVersion(odd), null);
});

// ─── Which copies fetch ────────────────────────────────────────────────

// [dashboard#4]
test("dashboard fetch: a copy from npm fetches — a package root, the npm registration's cache copy and its marketplace directory, a synced copy", async () => {
  const home = tmp("home-");
  const withVersion = (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "projectstore", version: V }));
    return root;
  };
  const roots = {
    package: CORE,
    registration: withVersion(cacheRoot(home, V, "projectstore-npm")),
    marketplace: withVersion(fakeMarketplace(home, V).payload),
    synced: withVersion(fakeSynced(home, V)),
  };
  for (const [what, root] of Object.entries(roots)) {
    assert.equal(npmCopy(root, { home }), true, what);
    const xdg = tmp("xdg-");
    const env = { [cachePaths({}).variable]: xdg };
    const fake = fakeNpmSpawn();
    const r = await pageFor({ root, env, home, spawn: fake.spawn });
    assert.equal(r.ok, true, `${what}: ${r.error}`);
    assert.equal(r.fetched, true, what);
    assert.equal(fake.installs().length, 1, what);
    assert.equal(fake.installs()[0].argv.at(-1), PKG, `${what}: exactly the core's version`);
  }
});

// [dashboard#4]
test("dashboard fetch: the npm registration's marketplace directory counts by path segment: the payload and below, never a sibling", () => {
  const home = tmp("home-");
  const payload = fakeMarketplace(home, V).payload;
  assert.equal(registrationPayloadRoot(payload, { home }), true, "the payload");
  assert.equal(registrationPayloadRoot(join(payload, "scripts"), { home }), true, "below it");
  assert.equal(registrationPayloadRoot(`${payload}x`, { home }), false, "a sibling whose name starts the same");
  assert.equal(registrationPayloadRoot(dirname(payload), { home }), false, "the marketplace above it");
  assert.equal(registrationPayloadRoot(null, { home }), false);
  // On POSIX a backslash is a character of a name, never a separator.
  if (sep === "/")
    assert.equal(registrationPayloadRoot(`${payload}\\x`, { home }), false, "a sibling named payload\\x");
});

// [dashboard#4]
test("dashboard fetch: a checkout without the folder, the git marketplace's copy and an unpacked tarball refuse, say they are not from npm, and run no npm", async () => {
  const home = tmp("home-");
  const checkout = join(tmp("ps-dash-src-"), "projectstore");
  copyPackageTree(REPO, checkout);
  const git = cacheRoot(home, V, "SmartAndPoint");
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, "package.json"), JSON.stringify({ name: "projectstore", version: V }));
  const tarball = join(tmp("unpacked-"), "package");
  copyPackageTree(REPO, tarball);
  for (const [what, root] of Object.entries({ checkout, git, tarball })) {
    assert.equal(npmCopy(root, { home }), false, what);
    const fake = fakeNpmSpawn();
    const r = await pageFor({ root, project: "/p", env: {}, home, spawn: fake.spawn });
    assert.equal(r.ok, false, what);
    assert.equal(r.code, "ECHANNEL", what);
    assert.match(r.error, /has no dashboard\/ folder and is not a copy installed from npm/, what);
    assert.doesNotMatch(r.error, /checkout/, `${what}: the text does not guess the kind of copy`);
    assert.doesNotMatch(r.error, /npm (ci|run|install)|build/, `${what}: no build command`);
    assert.ok(r.error.split("\n").includes("npx projectstore dashboard"), `${what}: the npm copy's command, alone`);
    assert.deepEqual(fake.calls, [], `${what}: npm is not run`);
  }
  // Through the checkout's own bin: exit 1, no npm, and the envelope's error is the text.
  const m = machine();
  const r = await refusedRun(checkout, m);
  assert.equal(r.text.code, 1, r.text.stderr);
  assert.match(r.text.stderr, /is not a copy installed from npm/);
  assert.equal(r.envelope.ok, false);
  assert.equal(r.envelope.result.error, r.text.stderr.trimEnd());
  assert.deepEqual(m.npm.log(), []);
});

// [dashboard#4]
test("dashboard fetch: a named page folder with no server.mjs exits 1 naming it, in an npm copy too, and npm is not run", async () => {
  const m = machine();
  const empty = tmp("named-");
  const r = await refusedRun(CORE, m, { PROJECTSTORE_DASHBOARD_ROOT: empty });
  assert.equal(r.text.code, 1, r.text.stderr);
  assert.ok(r.text.stderr.includes(JSON.stringify(empty)), r.text.stderr);
  assert.match(r.text.stderr, /has no server\.mjs: nothing was started or fetched/);
  assert.equal(r.envelope.result.error, r.text.stderr.trimEnd());
  assert.deepEqual(m.npm.log(), []);
  assert.ok(!existsSync(m.cache.root), "the cache is not touched");
});

// [dashboard#4]
test("dashboard fetch: a copy with its own dashboard/server.mjs starts it, runs no npm and reads no cache", async () => {
  const root = join(tmp("own-"), "_npx", "y", "node_modules", "projectstore");
  mkdirSync(join(root, "dashboard"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "projectstore", version: V }));
  copyFileSync(join(REPO, "tests", "fixtures", "dashboard-stub-server.mjs"), join(root, "dashboard", "server.mjs"));
  const m = machine();
  const fake = fakeNpmSpawn();
  const signals = new EventEmitter();
  const r = await startDashboard({
    root,
    project: m.proj,
    values: { port: String(await freePort()) },
    env: { ...process.env, ...m.env },
    home: m.home,
    fetchSpawn: fake.spawn,
    signals,
    stderr: { write() {} },
  });
  assert.equal(r.ok, true, r.text);
  signals.emit("SIGINT");
  assert.equal(await r.wait, 0);
  assert.deepEqual(fake.calls, [], "npm is not run");
  assert.ok(!existsSync(m.cache.root), "the cache is not read or made");
});

// [dashboard#3]
test("dashboard fetch: an unbound project in an npm copy exits 3 and runs no npm", async () => {
  const m = machine();
  const unbound = tmp("unbound-");
  const r = await runVerb(CORE, [], { cwd: unbound, env: m.env }).exited;
  assert.equal(r.code, 3, r.stderr);
  const j = await runVerb(CORE, ["--json"], { cwd: unbound, env: m.env }).exited;
  assert.equal(j.code, 3);
  assert.equal(JSON.parse(j.stdout.trim()).ok, false);
  assert.deepEqual(m.npm.log(), [], "npm is not run");
  assert.ok(!existsSync(m.cache.root));
});

// [dashboard#15]
test("dashboard fetch: the caller's live line says the package is being fetched, then fetched; a failed fetch ends it failed", async () => {
  const lines = [];
  const onFetch = (label) => {
    lines.push(["start", label]);
    return { end: (ok, done, note) => lines.push([ok ? "ok" : "fail", done, note || ""]), abort: () => {} };
  };
  const ok = await fetchIn(machine(), { spawn: fakeNpmSpawn().spawn, onFetch });
  assert.equal(ok.ok, true);
  assert.deepEqual(lines, [
    ["start", `fetching ${PKG}`],
    ["ok", `fetched ${PKG}`, ""],
  ]);
  lines.length = 0;
  const bad = await fetchIn(machine(), { spawn: fakeNpmSpawn({ mode: "ETARGET" }).spawn, onFetch });
  assert.equal(bad.ok, false);
  assert.deepEqual(lines, [
    ["start", `fetching ${PKG}`],
    ["fail", `fetch failed ${PKG}`, "ETARGET"],
  ]);
  // A page in the cache draws no line.
  lines.length = 0;
  const m = machine();
  layCachedPage(m);
  await fetchIn(m, { spawn: fakeNpmSpawn().spawn, onFetch });
  assert.deepEqual(lines, []);
});

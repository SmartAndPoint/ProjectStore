// projectstore — tests/dashboard-release.test.mjs: the dashboard's page as a
// package the release publishes (PS-DASHBOARD, "The release builds, checks
// and publishes the dashboard package at the core's version"; the spec "The
// dashboard package and its launcher: the folder, the dashboard verb, and a
// page that only reads", alias `dashboard`, contracts 18 and 20). The release
// job itself (contract 19) is read in tests/release.test.mjs and
// tests/shells.test.mjs.
//
// npm runs here offline, as the suite's hermetic setup leaves it: `npm pack`
// reads the folder, and one `npm install` of a local tarball needs no
// registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPacklist, DASHBOARD_PACKLIST, PACKLIST } from "../scripts/version-guard.mjs";
import { checkPage, PAGE_PACKAGE } from "../scripts/dashboard-fetch.mjs";
import { fetchArgv } from "../scripts/fetch-shell.mjs";
import { treeFiles } from "../scripts/lib.mjs";
import { packagesFor } from "../packaging/release-surfaces.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO, "dashboard");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const ROOT_PKG = readJson(join(REPO, "package.json"));
const PKG = readJson(join(PAGE, "package.json"));
const FIXTURE = readJson(join(REPO, DASHBOARD_PACKLIST));
const BASE = mkdtempSync(join(tmpdir(), "ps-dash-release-"));
after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 2 }));
const tmp = (p) => mkdtempSync(join(BASE, p));

// The packed files, copied alone to `to`.
function copyPacked(to, files = FIXTURE) {
  for (const rel of files) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(join(PAGE, rel), join(to, rel));
  }
  return to;
}

// The first stdout line of `node <dir>/server.mjs …`, then a stop.
function readyLine(dir, project) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [join(dir, "server.mjs"), "--core", REPO, "--project", project, "--port", "0"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) child.kill("SIGTERM");
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ line: out.split("\n")[0], err, code });
    });
  });
}

// [dashboard#18]
test("dashboard release: dashboard/package.json is a public package of the core's identity, with no bin, no dependencies and no provenance key", () => {
  assert.equal(PKG.name, PAGE_PACKAGE);
  assert.equal(PKG.version, ROOT_PKG.version, "one version");
  assert.equal(PKG.private, undefined, "not private");
  assert.deepEqual(PKG.files, ["server.mjs", "lib/", "public/"]);
  for (const k of [
    "bin",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
    "scripts",
  ])
    assert.equal(PKG[k], undefined, `no ${k}`);
  assert.deepEqual(PKG.publishConfig, { access: "public" }, "public, and no publishConfig.provenance");
  assert.deepEqual(PKG.repository, { ...ROOT_PKG.repository, directory: "dashboard" });
  for (const k of ["license", "engines", "homepage", "bugs", "author"]) assert.deepEqual(PKG[k], ROOT_PKG[k], k);
  assert.equal(PKG.type, "module");
  assert.ok(Array.isArray(PKG.keywords) && PKG.keywords.length > 0, "keywords for the npm page");
  // The npm page says first that nobody installs it by hand.
  const readme = readFileSync(join(PAGE, "README.md"), "utf8");
  const lead = readme.split("\n\n")[1];
  assert.match(lead, /This package is not installed by hand/);
  assert.match(lead, /`projectstore dashboard` fetches it/);
  assert.doesNotMatch(readme, /ships with the core/, "the page's README no longer says it ships inside the core");
});

// [dashboard#18]
test("dashboard release: npm pack in dashboard/ lists exactly the fixture, and a file added under public/ fails until npm run packlist", () => {
  assert.equal(DASHBOARD_PACKLIST, "tests/fixtures/dashboard-packlist.json");
  const now = currentPacklist(PAGE);
  assert.equal(now.error, undefined, now.error);
  assert.deepEqual(now.files, FIXTURE, "npm run packlist rewrites the fixture");
  for (const f of ["package.json", "README.md", "LICENSE", "server.mjs"]) assert.ok(FIXTURE.includes(f), f);
  assert.ok(
    FIXTURE.every((f) => /^(package\.json|README\.md|LICENSE|server\.mjs|lib\/.+|public\/.+)$/.test(f)),
    "nothing else",
  );
  // The edge: a new file under public/ is packed, so the comparison fails.
  const copy = copyPacked(tmp("pack-"));
  writeFileSync(join(copy, "public", "added.js"), "// added\n");
  const grown = currentPacklist(copy);
  assert.ok(grown.files.includes("public/added.js"));
  assert.notDeepEqual(grown.files, FIXTURE, "the fixture no longer matches until it is written again");
});

// [dashboard#18]
test("dashboard release: the packed files alone, copied to a folder, start and print the ready line", async () => {
  const { proj } = makeVaultProject();
  const alone = copyPacked(tmp("alone-"));
  assert.deepEqual(treeFiles(alone), FIXTURE);
  const r = await readyLine(alone, proj);
  const ready = JSON.parse(r.line);
  assert.equal(ready.ready, true, r.err);
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

// [dashboard#18] [dashboard#15]
test("dashboard release: npm installs the packed tarball offline, as the fetch does, into the tree the fetch accepts", (t) => {
  if (spawnSync("npm", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("no npm on PATH");
  const cache = tmp("npm-cache-");
  const env = {
    ...process.env,
    npm_config_offline: "true",
    npm_config_cache: cache,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_CACHE: cache,
  };
  const out = tmp("tgz-");
  const packed = spawnSync("npm", ["pack", "--pack-destination", out, "--json"], {
    cwd: PAGE,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarballs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  assert.deepEqual(tarballs, [`${PAGE_PACKAGE}-${PKG.version}.tgz`]);
  // The fetch's own argv, with a `file:` spec in place of name@version: npm
  // reads a bare path as a git spec (packaging/README.md, "Shells").
  const prefix = tmp("install-");
  const argv = fetchArgv({ prefix, shell: PAGE_PACKAGE, version: PKG.version });
  argv[argv.length - 1] = `file:${join(out, tarballs[0])}`;
  const installed = spawnSync("npm", argv, { cwd: prefix, env, encoding: "utf8", timeout: 60000 });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const dir = join(prefix, "node_modules", PAGE_PACKAGE);
  assert.equal(checkPage(dir, PKG.version), null, "the fetch's own check passes");
  assert.deepEqual(treeFiles(dir), FIXTURE, "npm lays exactly the packed files");
});

// [dashboard#18]
test("dashboard release: the package carries the core's LICENSE, byte for byte", () => {
  assert.ok(FIXTURE.includes("LICENSE"), "npm packs it");
  assert.ok(
    readFileSync(join(PAGE, "LICENSE")).equals(readFileSync(join(REPO, "LICENSE"))),
    "dashboard/LICENSE is the root LICENSE",
  );
});

// [dashboard#18]
test("dashboard release: the plugin's package lists no path with dashboard in it but the launcher and its fetch", () => {
  const packlist = readJson(join(REPO, PACKLIST));
  assert.deepEqual(
    packlist.filter((p) => p.includes("dashboard")),
    ["scripts/dashboard-fetch.mjs", "scripts/dashboard.mjs"],
  );
});

// [dashboard#20]
test("dashboard release: the release surfaces read projectstore-dashboard's dist-tag and readme, its readme being dashboard/README.md", () => {
  const pkgs = packagesFor();
  assert.deepEqual(
    pkgs.find((p) => p.name === PAGE_PACKAGE),
    { name: PAGE_PACKAGE, readme: "dashboard/README.md" },
  );
  assert.equal(pkgs[0].name, ROOT_PKG.name, "the core stays first");
});

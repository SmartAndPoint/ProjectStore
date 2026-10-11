// projectstore — the convergence decision (PS-HARNESS: "Setup and upgrade
// converge this project onto the running version: the channel switch, no
// downgrade, and the update notice", rules 6 and 8): the registry read and
// its cache, the stop-or-proceed decision and its words, the update notice
// and its command per root, and the module's place in the graph.
//
// Every read here goes through an injected `fetch`, clock and timers, against
// a temporary cache; the hermetic preload refuses any other request. The
// in-process runs use a fake package root, a temporary project and home, and
// the in-process npm stand-in for the registry resolver.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/convergence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readLatest, decide, proceedCase, updateNotice, runningCopies, isSemver, newerCopyDeferral, channelChoices, advised, repairAdvice, checksRoot, noticeRoot, hostCopyRoot, coreCommand, DEFAULT_REGISTRY, ACCEPT, FRESH_MS, READ_TIMEOUT_MS, NO_CHECK_ENV } from "../scripts/convergence.mjs";
import { registrationPaths, analyseRegistration } from "../scripts/surfaces.mjs";
import { portableRegistrationPaths } from "../scripts/portable-registration.mjs";
import { runVerb, plan } from "../scripts/install-harness.mjs";
import { npmUserRegistry } from "../scripts/fetch-shell.mjs";
import { sourceHarness, loadHarness, cachePaths } from "../scripts/harness.mjs";
import { fakeInstall, fakePackageRoot, noHostEnv, writeRegistry } from "./fixtures/install.mjs";
import { fakeNpmSpawn, FAKE_REGISTRY, registryFetch, instantTimers } from "./fixtures/fetch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CODEX = loadHarness("codex");
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const DAY = FRESH_MS;
const T0 = Date.parse("2026-10-11T09:00:00.000Z");

delete process.env[SRC.runtime.home_env];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ─── The read and its cache ─────────────────────────────────────────────

test("converge rule 8: one GET <registry>/projectstore with the abbreviated Accept header; the answer is dist-tags.latest, cached for a day under the registry and as user_latest", async () => {
  const cachePath = join(tmp("ps-conv-cache-"), "projectstore", "registry.json");
  const reg = registryFetch({ latest: "0.30.1" });
  let t = T0;
  const r = await readLatest({ registry: "https://registry.example.test/", cachePath, fetch: reg.fetch, now: () => t });
  assert.deepEqual(r, { latest: "0.30.1", from: "network", error: null });
  assert.equal(reg.calls.length, 1);
  assert.equal(reg.calls[0].url, "https://registry.example.test/projectstore", "one slash between the registry and the name");
  assert.equal(reg.calls[0].accept, ACCEPT);
  assert.equal(ACCEPT, "application/vnd.npm.install-v1+json");
  const at = new Date(T0).toISOString();
  assert.deepEqual(readJson(cachePath), { "https://registry.example.test/": { latest: "0.30.1", at }, user_latest: { latest: "0.30.1", at, published_at: null } });
  // Within 24 h: no request.
  t = T0 + DAY - 1;
  assert.deepEqual(await readLatest({ registry: "https://registry.example.test/", cachePath, fetch: reg.fetch, now: () => t }), { latest: "0.30.1", from: "cache", error: null });
  assert.equal(reg.calls.length, 1, "a second run within a day makes no request");
  // After 24 h: one.
  t = T0 + DAY + 1;
  await readLatest({ registry: "https://registry.example.test/", cachePath, fetch: reg.fetch, now: () => t });
  assert.equal(reg.calls.length, 2, "a run after a day makes one");
  // A second registry keeps an entry of its own; the first is untouched.
  const other = registryFetch({ latest: "1.0.0" });
  await readLatest({ registry: "https://npm.corp.example/", cachePath, fetch: other.fetch, now: () => t });
  const c = readJson(cachePath);
  assert.equal(c["https://registry.example.test/"].latest, "0.30.1");
  assert.equal(c["https://npm.corp.example/"].latest, "1.0.0");
  assert.equal(c.user_latest.latest, "1.0.0", "each write sets user_latest");
  // An `at` in the future is stale.
  const future = join(tmp("ps-conv-future-"), "registry.json");
  writeFileSync(future, JSON.stringify({ [DEFAULT_REGISTRY]: { latest: "0.30.1", at: new Date(T0 + 3600e3).toISOString() } }));
  const f = registryFetch({ latest: "0.30.2" });
  assert.equal((await readLatest({ registry: DEFAULT_REGISTRY, cachePath: future, fetch: f.fetch, now: () => T0 })).latest, "0.30.2");
  assert.equal(f.calls.length, 1, "an entry dated in the future is read again");
  // A publish time this read never learns is kept for the same latest, and dropped for another.
  writeFileSync(future, JSON.stringify({ user_latest: { latest: "0.30.2", at: new Date(T0).toISOString(), published_at: "2026-10-10T00:00:00.000Z" } }));
  await readLatest({ registry: DEFAULT_REGISTRY, cachePath: future, fetch: f.fetch, now: () => T0 });
  assert.equal(readJson(future).user_latest.published_at, "2026-10-10T00:00:00.000Z");
  await readLatest({ registry: DEFAULT_REGISTRY, cachePath: future, fetch: registryFetch({ latest: "0.30.3" }).fetch, now: () => T0 + DAY + 1 });
  assert.equal(readJson(future).user_latest.published_at, null);
});

test("converge rule 8: a corrupt cache is overwritten, an unwritable one changes nothing, and rule 6 re-reads a fresh entry below the newer copy", async () => {
  const dir = tmp("ps-conv-corrupt-");
  const cachePath = join(dir, "registry.json");
  writeFileSync(cachePath, "{ not json");
  const reg = registryFetch({ latest: "0.30.1" });
  assert.equal((await readLatest({ registry: DEFAULT_REGISTRY, cachePath, fetch: reg.fetch, now: () => T0 })).latest, "0.30.1");
  assert.equal(readJson(cachePath)[DEFAULT_REGISTRY].latest, "0.30.1", "the next answer overwrites a file that is not JSON");
  writeFileSync(cachePath, "[1, 2]");
  await readLatest({ registry: DEFAULT_REGISTRY, cachePath, fetch: reg.fetch, now: () => T0 });
  assert.equal(readJson(cachePath)[DEFAULT_REGISTRY].latest, "0.30.1", "and so does one that is not an object");
  // A cache path under a regular file: nothing can be written, the answer stands.
  const blocker = join(dir, "a-file");
  writeFileSync(blocker, "x");
  const r = await readLatest({ registry: DEFAULT_REGISTRY, cachePath: join(blocker, "projectstore", "registry.json"), fetch: reg.fetch, now: () => T0 });
  assert.deepEqual(r, { latest: "0.30.1", from: "network", error: null });
  // A fresh entry below the lowest newer copy is read again: a release may have come out since.
  const again = registryFetch({ latest: "0.31.0" });
  assert.equal((await readLatest({ registry: DEFAULT_REGISTRY, cachePath, fetch: again.fetch, now: () => T0 + 1, atLeast: "0.31.0" })).latest, "0.31.0");
  assert.equal(again.calls.length, 1);
  assert.equal((await readLatest({ registry: DEFAULT_REGISTRY, cachePath, fetch: again.fetch, now: () => T0 + 2, atLeast: "0.31.0" })).from, "cache", "an entry that reaches it answers");
});

test("converge rule 8: a rejected fetch, a 500, a body that is not JSON, a latest that is not strict semver and a fetch that never settles each answer nothing, and nothing is cached", async () => {
  for (const [mode, why] of [["reject", /ECONNREFUSED/], [500, /HTTP 500/], ["not-json", /not JSON/], ["no-tag", /no dist-tags\.latest/]]) {
    const cachePath = join(tmp("ps-conv-fail-"), "registry.json");
    const reg = registryFetch(mode);
    const r = await readLatest({ registry: DEFAULT_REGISTRY, cachePath, fetch: reg.fetch, now: () => T0 });
    assert.equal(r.latest, null, String(mode));
    assert.match(r.error, why, String(mode));
    assert.equal(existsSync(cachePath), false, `${mode}: a failed read is not cached`);
    if (mode === 500) assert.equal(reg.calls[0].cancelled, true, "an error status's body is cancelled, so its connection is released");
  }
  const timers = instantTimers();
  const hang = registryFetch("hang");
  const t0 = Date.now();
  const r = await readLatest({ registry: DEFAULT_REGISTRY, cachePath: null, fetch: hang.fetch, timers });
  assert.ok(Date.now() - t0 < READ_TIMEOUT_MS, "the injected timer cuts it, not the wall clock");
  assert.deepEqual(timers.asked, [2000], "a 2 s bound");
  assert.deepEqual(r, { latest: null, from: "network", error: "no answer within 2 s" });
  assert.equal(hang.calls[0].signal.aborted, true, "the request is aborted at the bound");
  for (const [v, ok] of [["0.30.0", true], ["0.30.0-rc.1", true], ["1.0.0+build.5", true], ["10.20.30-alpha.beta-1", true], ["v1.0.0", false], ["1.0", false], ["01.0.0", false], ["1.0.0-01", false], ["latest", false], ["", false], [null, false]]) assert.equal(isSemver(v), ok, String(v));
});

// ─── Stop or proceed ────────────────────────────────────────────────────

test("converge rule 6: the stop names the newest published copy, both versions and two commands that repeat the run's --harness, --surface and --no-register, never --project; otherwise each row says its case", () => {
  const npmRow = { harness: SRC.id, key: "projectstore@projectstore-npm", version: "0.31.0" };
  const args = { harnesses: [SRC.id], surfaces: null, register: true };
  const stop = decide({ copies: [npmRow], version: "0.30.0", read: { latest: "0.31.0" }, verb: "upgrade", args });
  assert.ok(stop.stop);
  assert.equal(stop.stop.lead, "this project runs projectstore 0.31.0 (projectstore@projectstore-npm), newer than this package (0.30.0), and 0.31.0 is published. Nothing is written. Run the newer one from a terminal in this project:");
  assert.deepEqual(stop.stop.commands, [`npx projectstore@latest upgrade --harness ${SRC.id}`, "npm install -g projectstore@latest"]);
  assert.equal(stop.stop.between, "or install it for the whole machine:");
  assert.equal(stop.stop.text, [stop.stop.lead, ...stop.stop.commands.flatMap((c, k) => (k ? [stop.stop.between, c] : [c]))].join("\n"), "the refusal's text: each command on its own line, nothing after it");
  const narrowed = decide({ copies: [npmRow], version: "0.30.0", read: { latest: "0.31.0" }, verb: "install", args: { harnesses: [SRC.id, CODEX.id], surfaces: ["agents_block"], register: false } });
  assert.equal(narrowed.stop.commands[0], `npx projectstore@latest install --harness ${SRC.id} --harness ${CODEX.id} --surface agents_block --no-register`);
  assert.ok(!narrowed.stop.text.includes("--project"));
  assert.equal(decide({ copies: [npmRow], version: "0.30.0", read: { latest: "0.31.0" }, verb: "upgrade" }).stop.commands[0], "npx projectstore@latest upgrade", "a bare run names no harness");
  // Of two newer copies, the newest the registry reaches is named.
  const two = decide({ copies: [{ ...npmRow, version: "0.30.5" }, { harness: CODEX.id, key: "projectstore@projectstore-npx", version: "0.31.0" }], version: "0.30.0", read: { latest: "0.30.5" } });
  assert.match(two.stop.lead, /runs projectstore 0\.30\.5 \(projectstore@projectstore-npm\)/);
  // Proceed: below the copy, a candidate only `next` carries, no answer, the switch off.
  for (const [read, skipped, words] of [
    [{ latest: "0.30.0" }, false, "the registry's latest (0.30.0) does not reach 0.31.0"],
    [{ latest: null, error: "no answer within 2 s" }, false, "the registry could not be read (no answer within 2 s)"],
    [null, true, "the registry was not read (PROJECTSTORE_NO_UPDATE_CHECK)"],
  ]) {
    const d = decide({ copies: [npmRow], version: "0.30.0", read, skipped });
    assert.equal(d.stop, null, words);
    assert.equal(proceedCase(d, "0.31.0"), words);
  }
  assert.equal(decide({ copies: [{ ...npmRow, version: "0.31.0-rc.1" }], version: "0.30.0", read: { latest: "0.30.0" } }).stop, null, "a candidate on next is not published for the stop");
  assert.equal(decide({ copies: [{ ...npmRow, version: "0.29.0" }], version: "0.30.0", read: { latest: "0.31.0" } }).stop, null, "an older copy never stops");
  assert.equal(proceedCase(null, "0.31.0"), "install and upgrade read the registry first, and stop when 0.31.0 is published", "plan's dry run reads nothing and says so");
  assert.equal(proceedCase({ checks: false }, "0.31.0"), null, "a host cache copy never checks");
  assert.equal(NO_CHECK_ENV, "PROJECTSTORE_NO_UPDATE_CHECK");
  assert.deepEqual(repairAdvice(CODEX, "0.31.0"), { lead: "not downgraded — repair it from its own version:", command: `npx projectstore@0.31.0 upgrade --harness ${CODEX.id}` });
  assert.equal(coreCommand("upgrade", { version: "latest" }), "npx projectstore@latest upgrade");
});

test("converge rule 6, the deferral: one helper names the ways this release offers — the newer copy's own bin in the layout remedy's form, then the host's own disable from the manifest — each command alone on its line, no backticks, and no verb that does not exist", () => {
  const S = SRC.surfaces.plugin;
  const copyDir = tmp("ps-conv-copy-");
  mkdirSync(join(copyDir, "bin"), { recursive: true });
  writeFileSync(join(copyDir, "bin", "projectstore.mjs"), "");
  const copy = { key: "projectstore@SmartAndPoint", version: "0.31.0", path: copyDir };
  const blocks = channelChoices({ harness: SRC, s: S, copy, running: "0.30.0" });
  assert.deepEqual(blocks, [
    { lead: "Run the newer copy instead, from a terminal in this project:", command: `node "${join(copyDir, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register` },
    { lead: "Or move this project to this package's registration, the older 0.30.0: turn that copy off for this project, then repeat this run:", command: [S.cli.bin, ...S.cli.commands.disable.map((t) => t.replace("{other}", copy.key))].join(" ") },
  ]);
  assert.equal(blocks[1].command, `${S.cli.bin} plugin disable projectstore@SmartAndPoint --scope local`);
  const d = newerCopyDeferral({ copy, running: "0.30.0", decision: decide({ copies: [], version: "0.30.0", read: { latest: "0.30.0" } }), harness: SRC, s: S });
  assert.equal(d.advice.text, "this project runs a newer copy (projectstore@SmartAndPoint 0.31.0) than this package (0.30.0), so it is not switched off — the registry's latest (0.30.0) does not reach 0.31.0.");
  assert.deepEqual(d.advice.blocks, blocks);
  assert.equal(d.reason, [d.advice.text, blocks[0].lead, blocks[0].command, blocks[1].lead, blocks[1].command].join("\n"), "the envelope's reason: every part on its own line");
  for (const line of d.reason.split("\n")) assert.ok(!/`/.test(line), line);
  assert.ok(!/\bsetup\b/.test(d.reason), "no verb this release lacks");
  // A copy without its own bin (0.27.x) is not told to run it.
  const old = channelChoices({ harness: SRC, s: S, copy: { ...copy, path: tmp("ps-conv-nobin-") }, running: "0.30.0" });
  assert.deepEqual(old.map((b) => b.command), [blocks[1].command]);
  assert.deepEqual(advised("prose", []), { reason: "prose", advice: { text: "prose", blocks: [] } });
});

test("converge rule 6: the copies a project runs are contract 12's rows of any marketplace — never another checkout's, never one disabled for it — and none for Claude Code under the git channel", () => {
  const home = tmp("ps-conv-home-");
  const proj = tmp("ps-conv-proj-");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  const git = fakeInstall(home, "0.31.0");
  const npm = fakeInstall(home, "0.30.5", { marketplace: SRC.surfaces.plugin.marketplace_name });
  const elsewhere = fakeInstall(home, "0.40.0", { marketplace: "Fork" });
  const dir = join(home, SRC.runtime.home_default, "plugins");
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "projectstore@SmartAndPoint": [{ scope: "user", installPath: git, version: "0.31.0", lastUpdated: "2026-10-01T00:00:00Z" }],
    [`projectstore@${SRC.surfaces.plugin.marketplace_name}`]: [{ scope: "local", projectPath: proj, installPath: npm, version: "0.30.5", lastUpdated: "2026-10-02T00:00:00Z" }],
    "projectstore@Fork": [{ scope: "local", projectPath: "/another/checkout", installPath: elsewhere, version: "0.40.0", lastUpdated: "2026-10-03T00:00:00Z" }],
  } }));
  const copies = runningCopies(proj, { harnesses: [SRC.id], root: ROOT, home, env: noHostEnv() });
  assert.deepEqual(copies.map((c) => [c.key, c.version, c.own]), [[`projectstore@${SRC.surfaces.plugin.marketplace_name}`, "0.30.5", true], ["projectstore@SmartAndPoint", "0.31.0", false]], "this checkout's row first, then user scope; another checkout's row never");
  writeFileSync(join(proj, SRC.runtime.harness_dir, "settings.local.json"), JSON.stringify({ enabledPlugins: { "projectstore@SmartAndPoint": false } }));
  assert.deepEqual(runningCopies(proj, { harnesses: [SRC.id], root: ROOT, home, env: noHostEnv() }).map((c) => c.key), [`projectstore@${SRC.surfaces.plugin.marketplace_name}`], "a copy off for this checkout is not one it runs");
  assert.deepEqual(runningCopies(proj, { harnesses: [SRC.id], root: ROOT, home, env: noHostEnv(), channel: "git" }), [], "under keep, our run renders nothing for Claude Code");
  assert.deepEqual(runningCopies(proj, { harnesses: [SRC.id], root: ROOT, home, env: noHostEnv(), channel: "npm" }).length, 1, "a switch counts them as null does");
  // Who checks: a package root and a checkout; a host cache copy never. Who shows the notice: a package root.
  assert.equal(checksRoot(join(tmp("ps-conv-npx-"), "_npx", "1", "node_modules", "projectstore"), { home }), true);
  assert.equal(checksRoot(ROOT, { home }), true);
  assert.equal(checksRoot(git, { home }), false);
  assert.equal(checksRoot(npm, { home }), false);
  assert.equal(noticeRoot(join("/x", "node_modules", "projectstore"), { home }), true);
  assert.equal(noticeRoot(ROOT, { home }), false);
  assert.equal(noticeRoot(git, { home }), false);
  // Two more roots a session runs (F2 of the PR1 review): the npm
  // registration's marketplace directory, which the host loads in place, and
  // the core a harness's shell bundles under that harness's plugin cache.
  const env = noHostEnv();
  const payload = registrationPaths(SRC.surfaces.plugin, { home, harness: SRC }).payload;
  const bundled = join(portableRegistrationPaths(CODEX.surfaces.plugin, { home, projectDir: home, harness: CODEX, env }).cacheDir, CODEX.surfaces.plugin.marketplace_name, CODEX.surfaces.plugin.plugin_name, "0.30.0", "node_modules", "projectstore");
  for (const [root, label] of [[payload, "the marketplace directory's plugin"], [bundled, "the core under Codex's plugin cache"]]) {
    assert.equal(hostCopyRoot(root, { home, env }), true, label);
    assert.equal(checksRoot(root, { home, env }), false, `${label}: never stops`);
    assert.equal(noticeRoot(root, { home, env }), false, `${label}: never told to update`);
  }
  assert.equal(hostCopyRoot(join(tmp("ps-conv-npx-"), "_npx", "1", "node_modules", "projectstore"), { home, env }), false, "an npx root is the package");
});

// F9 of the PR1 review: one selection decides "a copy enabled for this
// project" for the stop and for the deferral — one row per key, this
// checkout's own before a user-scope one, whatever the registry's order.
test("converge rule 6: two rows of one key — a user-scope row listed first and this checkout's own — are one copy, at the own row's version, for the stop and for the registration's competing copies alike", () => {
  const home = tmp("ps-conv-home2-");
  const proj = tmp("ps-conv-proj2-");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  const user = fakeInstall(home, "0.29.0");
  const own = fakeInstall(home, "0.31.0");
  writeRegistry(home, [
    { scope: "user", installPath: user, version: "0.29.0", lastUpdated: "2026-10-09T00:00:00Z" },
    { scope: "local", projectPath: proj, installPath: own, version: "0.31.0", lastUpdated: "2026-10-01T00:00:00Z" },
  ]);
  const copies = runningCopies(proj, { harnesses: [SRC.id], root: ROOT, home, env: noHostEnv() });
  assert.deepEqual(copies.map((c) => [c.key, c.version]), [["projectstore@SmartAndPoint", "0.31.0"]]);
  const others = analyseRegistration(proj, SRC.surfaces.plugin, { root: NPX_ROOT, home, harness: SRC, env: noHostEnv() }).others;
  assert.deepEqual(others.map((o) => [o.key, o.version]), [["projectstore@SmartAndPoint", "0.31.0"]]);
});

test("converge rule 8: the notice's text, and its command per root — npx under _npx, the global install anywhere else; none at or below the running version", () => {
  const npx = join("/x", "_npx", "4f1c", "node_modules", "projectstore");
  assert.deepEqual(updateNotice({ latest: "0.30.1", version: "0.30.0", root: npx, verb: "upgrade" }), { latest: "0.30.1", text: "newer published: 0.30.1 (this is 0.30.0). To update:", command: "npx projectstore@latest upgrade" });
  assert.equal(updateNotice({ latest: "0.30.1", version: "0.30.0", root: npx, verb: "install" }).command, "npx projectstore@latest install");
  assert.equal(updateNotice({ latest: "0.30.1", version: "0.30.0", root: "/usr/local/lib/node_modules/projectstore", verb: "upgrade" }).command, "npm install -g projectstore@latest");
  for (const latest of ["0.30.0", "0.29.9", "0.30.0-rc.9", "v0.31.0", null]) assert.equal(updateNotice({ latest, version: "0.30.0", root: npx }), null, String(latest));
});

test("converge rule 8, amended 2026-10-09: the user's registry is npm config get registry run from the home directory, with every lowercase npm_config_* removed", async () => {
  const home = tmp("ps-conv-userreg-");
  const npm = fakeNpmSpawn();
  const env = { PATH: "/nowhere", npm_config_registry: "https://outer-npx.example.test/", npm_config_cache: "/c", NPM_CONFIG_REGISTRY: "https://upper.example.test/", HOME: home };
  assert.equal(await npmUserRegistry({ home, env, spawn: npm.spawn }), FAKE_REGISTRY);
  const [call] = npm.calls;
  assert.deepEqual(call.argv, ["config", "get", "registry", "--no-update-notifier"]);
  assert.equal(call.cwd, home);
  assert.deepEqual(Object.keys(call.env).filter((k) => /^npm_config_/i.test(k)), ["NPM_CONFIG_REGISTRY"], "only the uppercase form survives");
  assert.equal(await npmUserRegistry({ home, env, spawn: fakeNpmSpawn({ registryMode: "hang" }).spawn, budget: 50 }), null, "a read that runs past its budget is no answer");
});

// ─── Through runVerb, in text ───────────────────────────────────────────

const NPX_ROOT = fakePackageRoot(join(tmp("ps-conv-pkg-"), "_npx", "4f1c2a9e7b3d5c60", "node_modules", "projectstore"), "0.30.0");
const GLOBAL_ROOT = fakePackageRoot(join(tmp("ps-conv-global-"), "lib", "node_modules", "projectstore"), "0.30.0");

function project() {
  const proj = tmp("ps-conv-proj-");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  return proj;
}

// No host CLI, no colour, no session marker, the check on, CI off, a cache of the test's own.
function checkEnv(extra = {}) {
  const env = noHostEnv({ PATH: "", PROJECTSTORE_NO_UPDATE_CHECK: "", CI: "", XDG_CACHE_HOME: join(tmp("ps-conv-xdg-"), "cache"), ...extra });
  for (const k of ["FORCE_COLOR", "TERM", "NO_COLOR", "PROJECTSTORE_ASCII"]) delete env[k];
  return env;
}

// One upgrade in text, declined at the terminal double: nothing is written,
// so the same project is planned again by the next run.
async function textRun({ root = NPX_ROOT, proj = project(), home = tmp("ps-conv-h-"), env = checkEnv(), fetch, timers, now, verb = "upgrade", json = false, fetchSpawn = null } = {}) {
  const chunks = [];
  const out = { isTTY: false, write: (s) => { chunks.push(String(s)); return true; } };
  const npm = fakeNpmSpawn();
  const r = await runVerb(verb, proj, { harnesses: [SRC.id], root, home, env, fetch, timers, now, fetchSpawn: fetchSpawn || npm.spawn, ...(json ? { json: true } : { out, ask: async () => "n" }) });
  return { r, text: chunks.join(""), npm, proj, home, env };
}

const withoutNotice = (text) => text.split("\n").filter((_, k) => k < 1 || k > 4).join("\n");

test("converge criterion 'The notice': under _npx the header carries the notice and the npx command alone on its line; under another node_modules the global install; the rest of the output is the run without it", async () => {
  const proj = project(), home = tmp("ps-conv-h-");
  const reg = registryFetch({ latest: "0.30.1" });
  const a = await textRun({ proj, home, fetch: reg.fetch });
  const lines = a.text.split("\n");
  assert.equal(lines[0], `projectstore upgrade · ${SRC.display_name}`);
  assert.equal(lines[1], "  ▲ newer published: 0.30.1 (this is 0.30.0). To update:");
  assert.equal(lines[2], "");
  assert.equal(lines[3], "    npx projectstore@latest upgrade");
  assert.equal(lines[4], "");
  assert.equal(lines[5], `  ${proj}`, "then the preview, without a second badge");
  assert.equal(a.text.split("projectstore upgrade ·").length, 2);
  assert.equal(reg.calls.length, 1);
  assert.equal(reg.calls[0].url, `${FAKE_REGISTRY}projectstore`, "against the user's registry");
  const resolver = a.npm.calls.filter((c) => c.argv[0] === "config");
  assert.equal(resolver.length, 1, "the user's registry is resolved once");
  assert.equal(resolver[0].cwd, home, "from the home directory");
  // The same run with the check off: the same output and the same gate, less the notice.
  const off = await textRun({ proj, home, env: checkEnv({ PROJECTSTORE_NO_UPDATE_CHECK: "1" }) });
  assert.equal(withoutNotice(a.text), off.text);
  assert.deepEqual(a.r.gate, off.r.gate);
  assert.deepEqual(off.npm.calls, [], "off: no resolver, no read");
  const g = await textRun({ root: GLOBAL_ROOT, fetch: registryFetch({ latest: "0.30.1" }).fetch });
  assert.equal(g.text.split("\n")[3], "    npm install -g projectstore@latest");
  // No npm to say which registry the user has: the public one is read.
  const npmless = registryFetch({ latest: "0.30.1" });
  const fallback = await textRun({ proj, home, fetch: npmless.fetch, fetchSpawn: () => { throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }); } });
  assert.deepEqual(npmless.calls.map((c) => c.url), [`${DEFAULT_REGISTRY}projectstore`]);
  assert.equal(DEFAULT_REGISTRY, "https://registry.npmjs.org/");
  assert.equal(fallback.text, a.text);
  // At or below the running version: nothing printed.
  const same = await textRun({ proj, home, fetch: registryFetch({ latest: "0.30.0" }).fetch });
  assert.equal(same.text, off.text);
});

test("converge criterion 'The notice': a checkout and a host cache copy make no request; nor do --json, CI=1, PROJECTSTORE_NO_UPDATE_CHECK=1, plan or uninstall", async () => {
  const quiet = async (opts, label) => {
    const reg = registryFetch({ latest: "0.30.1" });
    const r = await textRun({ ...opts, fetch: reg.fetch });
    assert.equal(reg.calls.length, 0, `${label}: no request`);
    assert.deepEqual(r.npm.calls.filter((c) => c.argv[0] === "config"), [], `${label}: no registry resolved`);
    assert.ok(!r.text.includes("newer published"), label);
    return r;
  };
  await quiet({ root: ROOT }, "a checkout");
  const home = tmp("ps-conv-cache-home-");
  await quiet({ root: fakeInstall(home, "0.28.0"), home }, "a git-marketplace cache copy");
  await quiet({ root: fakeInstall(home, "0.28.0", { marketplace: SRC.surfaces.plugin.marketplace_name }), home }, "the npm registration's cache copy");
  // The npm registration's marketplace directory, which its sessions run in
  // place, and the core a shell bundles under a harness's plugin cache: each a
  // full package tree at 0.30.0, so only the root decides.
  const payloadRoot = fakePackageRoot(registrationPaths(SRC.surfaces.plugin, { home, harness: SRC }).payload, "0.30.0");
  await quiet({ root: payloadRoot, home }, "the npm registration's marketplace directory");
  const codexCache = portableRegistrationPaths(CODEX.surfaces.plugin, { home, projectDir: home, harness: CODEX, env: checkEnv() }).cacheDir;
  const bundled = fakePackageRoot(join(codexCache, CODEX.surfaces.plugin.marketplace_name, CODEX.surfaces.plugin.plugin_name, "0.30.0", "node_modules", "projectstore"), "0.30.0");
  await quiet({ root: bundled, home }, "the core a shell bundles under Codex's plugin cache");
  await quiet({ json: true }, "--json");
  await quiet({ env: checkEnv({ CI: "1" }) }, "CI=1");
  await quiet({ env: checkEnv({ CI: "true" }) }, "CI=true");
  await quiet({ env: checkEnv({ PROJECTSTORE_NO_UPDATE_CHECK: "1" }) }, "PROJECTSTORE_NO_UPDATE_CHECK=1");
  await quiet({ verb: "uninstall" }, "uninstall");
  // CI=0 and CI=false read as unset, as contract 9 reads them.
  const reg = registryFetch({ latest: "0.30.1" });
  const ci0 = await textRun({ env: checkEnv({ CI: "0" }), fetch: reg.fetch });
  assert.ok(ci0.text.includes("newer published: 0.30.1"));
  // plan reads nothing: it is pure, and takes no fetch.
  const p = plan(project(), { harnesses: [SRC.id], root: NPX_ROOT, home: tmp("ps-conv-h-"), env: checkEnv() });
  assert.ok(p.ok);
});

test("converge criterion 'The notice': the cache — a second run within a day makes no request, a run after a day makes one, and an unwritable cache changes nothing in the output", async () => {
  const proj = project(), home = tmp("ps-conv-h-");
  const env = checkEnv();
  const reg = registryFetch({ latest: "0.30.1" });
  let t = T0;
  const first = await textRun({ proj, home, env, fetch: reg.fetch, now: () => t });
  t = T0 + DAY - 1000;
  const second = await textRun({ proj, home, env, fetch: reg.fetch, now: () => t });
  assert.equal(reg.calls.length, 1, "within a day: from the cache");
  assert.equal(second.text, first.text, "and the same notice");
  const file = cachePaths({ env, home }).registry;
  assert.equal(readJson(file)[FAKE_REGISTRY].latest, "0.30.1", "keyed by the user's registry");
  t = T0 + DAY + 1000;
  await textRun({ proj, home, env, fetch: reg.fetch, now: () => t });
  assert.equal(reg.calls.length, 2, "after a day: one request");
  // XDG_CACHE_HOME under a regular file: nothing can be written there.
  const blocker = join(tmp("ps-conv-blocked-"), "file");
  writeFileSync(blocker, "x");
  const blocked = await textRun({ proj, home, env: checkEnv({ XDG_CACHE_HOME: blocker }), fetch: registryFetch({ latest: "0.30.1" }).fetch, now: () => T0 });
  assert.equal(blocked.text, first.text);
  assert.deepEqual(blocked.r.gate, first.r.gate);
});

test("converge criterion 'The notice': a rejected fetch, a 500, a body that is not JSON and a fetch that never settles leave the output and the gate as without the check; the last returns at the injected 2 s bound", async () => {
  const proj = project(), home = tmp("ps-conv-h-");
  const off = await textRun({ proj, home, env: checkEnv({ PROJECTSTORE_NO_UPDATE_CHECK: "1" }) });
  for (const mode of ["reject", 500, "not-json", "no-tag"]) {
    const r = await textRun({ proj, home, fetch: registryFetch(mode).fetch });
    assert.equal(r.text, off.text, String(mode));
    assert.deepEqual(r.r.gate, off.r.gate, String(mode));
  }
  const timers = instantTimers();
  const t0 = Date.now();
  const hung = await textRun({ proj, home, fetch: registryFetch("hang").fetch, timers });
  assert.ok(Date.now() - t0 < 2000, "the run returns at the injected bound");
  assert.equal(timers.asked.length, 1);
  assert.ok(timers.asked[0] > 1000 && timers.asked[0] <= 2000, `the request gets what the resolver left of the 2 s: ${timers.asked[0]}`);
  assert.equal(hung.text, off.text);
});

test("converge rule 8: on the notice-only path the user's registry resolver and the request share one 2 s bound — a resolver that takes it all leaves no request", async () => {
  const proj = project(), home = tmp("ps-conv-h-");
  const off = await textRun({ proj, home, env: checkEnv({ PROJECTSTORE_NO_UPDATE_CHECK: "1" }) });
  const reg = registryFetch({ latest: "0.30.1" });
  const t0 = Date.now();
  const r = await textRun({ proj, home, fetch: reg.fetch, fetchSpawn: fakeNpmSpawn({ registryMode: "hang" }).spawn });
  const ms = Date.now() - t0;
  assert.ok(ms >= 1900 && ms < 3000, `one bound, not two: ${ms} ms`);
  assert.deepEqual(reg.calls, [], "no time is left for a request");
  assert.equal(r.text, off.text);
});

// ─── The module's place ─────────────────────────────────────────────────

test("converge: convergence.mjs imports lib, harness, portable-registration and surfaces only; doctor, lib, the hooks and the SessionStart graph never load it", () => {
  const src = readFileSync(join(ROOT, "scripts", "convergence.mjs"), "utf8");
  const local = [...src.matchAll(/^import .* from "(\.\/[^"]+)";$/gm)].map((m) => m[1]);
  for (const s of local) assert.ok(["./lib.mjs", "./harness.mjs", "./portable-registration.mjs", "./surfaces.mjs"].includes(s), `convergence.mjs imports ${s}`);
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  for (const n of ["doctor.mjs", "lib.mjs", "harness.mjs", "surfaces.mjs", "portable-registration.mjs", "fetch-shell.mjs", "run-host.mjs", "statusline.mjs", "touch-session.mjs"]) {
    assert.ok(!readFileSync(join(ROOT, "scripts", n), "utf8").includes("convergence.mjs"), `scripts/${n} imports convergence.mjs`);
  }
  for (const n of readdirSync(join(ROOT, "hooks")).filter((f) => f.endsWith(".mjs"))) assert.ok(!readFileSync(join(ROOT, "hooks", n), "utf8").includes("convergence.mjs"), `hooks/${n}`);
  const importers = readdirSync(join(ROOT, "scripts")).filter((n) => n.endsWith(".mjs") && readFileSync(join(ROOT, "scripts", n), "utf8").includes('"./convergence.mjs"'));
  assert.deepEqual(importers, ["install-harness.mjs"]);
});

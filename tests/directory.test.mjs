// projectstore — PS-DIRECTORY: "A copy installed from Anthropic's directory is
// a channel the core knows, and nothing it prints moves a directory user to
// npm". A plugin on the person's claude.ai account loads in Claude Code as
// projectstore@synced, from <claude home>/plugins/synced/<bucket>/projectstore,
// with no marketplace and no install record (the fixture's fakeSynced lays the
// folder out as measured on 2026-10-15). The "directory B2" tests are its
// sibling story's, "Setup and install keep a directory copy: no npm
// registration is planned over an enabled projectstore@synced unless the npm
// channel is chosen".
//
// Every module is read through its namespace, so a name a release lacks fails
// the one test that calls it, not the whole file.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/directory.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn as spawnChild } from "node:child_process";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import * as lib from "../scripts/lib.mjs";
import * as doctor from "../scripts/doctor.mjs";
import * as conv from "../scripts/convergence.mjs";
import * as surfaces from "../scripts/surfaces.mjs";
import * as installer from "../scripts/install-harness.mjs";
import * as setupVerb from "../scripts/setup.mjs";
import { sourceHarness, packageCommand, loadHarnesses } from "../scripts/harness.mjs";
import * as fixtures from "./fixtures/install.mjs";
import { fakeNpm, fakeNpmSpawn } from "./fixtures/fetch.mjs";
import { writeBinding } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const HOME_DIR = SRC.runtime.home_default;
const NPM_ID = `${SRC.surfaces.plugin.plugin_name}@${SRC.surfaces.plugin.marketplace_name}`;
const SYNCED_KEY = "projectstore@synced";
const { fakeSynced, trashSynced, syncedRoot, fakeInstall, cacheRoot, writeRegistry, legacyProject } = fixtures;
const { noHostEnv, installEnv, fakePackageRoot, fakeClaude } = fixtures;
const installPlan = (...a) => installer.plan(...a);
const installApply = (...a) => installer.apply(...a);

const TEMP = [];
const tmp = (prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP.push(d);
  return d;
};
after(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
delete process.env[SRC.runtime.home_env];

// A project in Claude Code's shape, bound to a vault of its own when asked.
function project({ bound = false, statusline = false } = {}) {
  const proj = tmp("ps-dir-proj-");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  if (bound)
    writeBinding(proj, {
      vault_path: tmp("ps-dir-vault-"),
      layout: "engineering",
      language: "en",
      ...(statusline ? { statusline: { enabled: true } } : {}),
    });
  return proj;
}
const localSettings = (proj, value) =>
  writeFileSync(join(proj, SRC.runtime.harness_dir, "settings.local.json"), JSON.stringify(value, null, 2));
const userSettings = (home, value) => {
  mkdirSync(join(home, HOME_DIR), { recursive: true });
  writeFileSync(join(home, HOME_DIR, "settings.json"), JSON.stringify(value, null, 2));
};
// A registry row of another origin, under its own key.
function writeRows(home, rows) {
  const dir = join(home, HOME_DIR, "plugins");
  mkdirSync(dir, { recursive: true });
  const plugins = {};
  for (const r of rows) (plugins[r.key] ||= []).push({ scope: "user", lastUpdated: "2026-10-15T00:00:00Z", ...r });
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}
// A SessionStart from `root`, each on a machine cache of its own: an unbound
// project remembers its welcome per machine (story C), and a shared cache
// would silence the next welcome.
function sessionStart(home, root, proj) {
  const r = spawnSync(process.execPath, [join(root, "hooks", "session-start.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "dir-b", source: "startup", cwd: proj }),
    env: installEnv(home, root, proj, { XDG_CACHE_HOME: tmp("ps-dir-cache-") }),
    cwd: proj,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout || "{}");
  return { welcome: out.hookSpecificOutput?.additionalContext || "", sys: out.systemMessage || "" };
}

// ─── The channel ────────────────────────────────────────────────────────

test("directory B: installChannel answers synced for a copy under the host's synced folder — as given, through a symlinked home, under a relocated home — and its four other answers are unchanged", () => {
  const real = tmp("ps-dir-home-");
  const copy = fakeSynced(real, "0.30.6");
  assert.equal(lib.installChannel(copy, { home: real }), "synced", "as given");
  const link = join(tmp("ps-dir-link-"), "home");
  symlinkSync(real, link);
  assert.equal(lib.installChannel(copy, { home: link }), "synced", "the real root against the linked home");
  assert.equal(
    lib.installChannel(copy.replace(real, link), { home: real }),
    "synced",
    "the linked root against the real home",
  );
  // The host's home variable relocates its folder (the manifest's home_env).
  const moved = tmp("ps-dir-moved-");
  const there = join(moved, ...fixtures.SYNCED_DIR, "org-0001_user-0001", "projectstore");
  mkdirSync(there, { recursive: true });
  process.env[SRC.runtime.home_env] = moved;
  try {
    assert.equal(lib.installChannel(there, { home: real }), "synced", "under the relocated home");
    assert.equal(lib.installChannel(copy, { home: real }), "checkout", "the default folder is not the host's then");
  } finally {
    delete process.env[SRC.runtime.home_env];
  }
  // The four answers 0.30.5 gives, unchanged.
  assert.equal(lib.installChannel(cacheRoot(real, "0.30.6"), { home: real }), "marketplace");
  assert.equal(
    lib.installChannel(cacheRoot(real, "0.30.6", SRC.surfaces.plugin.marketplace_name), { home: real }),
    "registration",
  );
  assert.equal(lib.installChannel(join(real, "_npx", "1", "node_modules", "projectstore"), { home: real }), "package");
  assert.equal(lib.installChannel(ROOT, { home: real }), "checkout");
  // A copy the host moved to its trash is no host copy.
  const trashed = trashSynced(real);
  assert.equal(lib.installChannel(trashed, { home: real }), "checkout", "plugins/.trash/ is not synced/");
});

test("directory B: a synced root is a copy a host runs — never checks the registry, never told to update", () => {
  const home = tmp("ps-dir-host-");
  const copy = fakeSynced(home, "0.30.6");
  const env = noHostEnv();
  assert.equal(conv.hostCopyRoot(copy, { home, env }), true);
  assert.equal(conv.checksRoot(copy, { home, env }), false, "never stopped");
  assert.equal(conv.noticeRoot(copy, { home, env }), false, "never told to update");
});

// A registry on 127.0.0.1 that the fake npm's `config get registry` names, as
// tests/cli.test.mjs's converge tests serve it.
async function localRegistry(latest) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
    res.end(JSON.stringify({ name: "projectstore", "dist-tags": { latest } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
function binAt(root, args, env) {
  return new Promise((settle) => {
    const child = spawnChild(process.execPath, [join(root, "bin", "projectstore.mjs"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => settle({ status, stdout, stderr }));
  });
}

test("directory B: a synced copy's own bin reads no registry and is never stopped — where a package root at the same version is", async () => {
  const registry = await localRegistry("0.31.0");
  try {
    const base = tmp("ps-dir-bin-");
    const npm = fakeNpm(join(base, "npm-bin"));
    const host = fakeClaude(join(base, "claude-bin"));
    const home = join(base, "home");
    mkdirSync(home);
    const env = noHostEnv({
      HOME: home,
      PATH: [host.dir, npm.dir, dirname(process.execPath)].join(delimiter),
      XDG_CACHE_HOME: join(base, "xdg"),
      FAKE_NPM_REGISTRY: registry.url,
    });
    for (const k of [
      "PROJECTSTORE_NO_UPDATE_CHECK",
      "CI",
      "FORCE_COLOR",
      "TERM",
      "NO_COLOR",
      "PROJECTSTORE_PROJECT_DIR",
    ])
      delete env[k];
    const proj = project({ bound: true });
    // This checkout registered from a 0.31.0 package: the copy it runs is newer.
    const newer = fakePackageRoot(join(base, "newer", "node_modules", "projectstore"), "0.31.0");
    const hostEnv = host.env({ HOME: home });
    const done = installApply(installPlan(proj, { harnesses: [SRC.id], home, root: newer, env: hostEnv }), {
      env: hostEnv,
      home,
    });
    assert.equal(done.failed, undefined, JSON.stringify(done));
    const args = ["upgrade", "--harness", SRC.id, "--surface", "agents_block", "--project", proj];
    // The control: a package root at 0.30.0 reads the registry and stops.
    const pkg = fakePackageRoot(join(base, "_npx", "9f8e", "node_modules", "projectstore"), "0.30.0");
    const stopped = await binAt(pkg, args, env);
    assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
    assert.equal(registry.requests.length, 1, "the package root reads once");
    // The directory's copy at 0.30.0: its channel is claude.ai's.
    const copy = fakeSynced(home, "0.30.0", { full: true });
    const r = await binAt(copy, args, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes("refused"), r.stdout);
    assert.equal(registry.requests.length, 1, "no request from the synced copy");
    assert.equal(
      npm.log().filter((c) => c.argv[0] === "config").length,
      1,
      "the registry is resolved for the package root only",
    );
  } finally {
    await registry.close();
  }
});

// ─── The welcome ────────────────────────────────────────────────────────

test("directory B: the welcome from a directory copy, unbound and bound, says updates come from claude.ai and both ways to turn it off — and names no npx, no upgrade, no marketplace update", () => {
  const home = tmp("ps-dir-wel-");
  const copy = fakeSynced(home, VERSION, { full: true });
  for (const bound of [false, true]) {
    const proj = project({ bound });
    const { welcome, sys } = sessionStart(home, copy, proj);
    assert.ok(welcome.includes("projectstore is loaded for the first time"), welcome);
    assert.ok(sys.startsWith("👋 projectstore: first-run welcome shown."), sys);
    for (const [what, text] of [
      [`welcome (${bound ? "bound" : "unbound"})`, welcome],
      [`systemMessage (${bound ? "bound" : "unbound"})`, sys],
    ]) {
      assert.ok(!/\bnpx\b/.test(text), `${what} names npx:\n${text}`);
      assert.ok(!/\bupgrade\b/.test(text), `${what} names an upgrade:\n${text}`);
      assert.ok(!text.includes("/plugin marketplace update"), `${what} names a marketplace update:\n${text}`);
      assert.ok(text.includes("claude.ai"), `${what}: updates come from claude.ai`);
      assert.ok(/\/plugin`? → \**Installed/.test(text), `${what}: off for the account`);
      assert.ok(text.includes(`"${SYNCED_KEY}": false`), `${what}: off for one project`);
      assert.ok(text.includes("settings.local.json"), `${what}: in that project's local settings`);
    }
  }
});

test("directory B: the welcome from a marketplace copy names that marketplace and its auto-update default — on for Anthropic's official names and claude.ai's, off for SmartAndPoint — and no (v0.7+)", () => {
  const home = tmp("ps-dir-mp-");
  const hint = (mp) =>
    lib.updateHint({ env: { PROJECTSTORE_HARNESS: SRC.id }, root: cacheRoot(home, "0.30.6", mp), home });
  for (const [mp, on] of [
    ["claude-plugins-official", true],
    ["claudeai-example", true],
    ["SmartAndPoint", false],
    ["knowledge-work-plugins", false],
  ]) {
    const h = hint(mp);
    const all = [h.line, ...h.welcome].join("\n");
    assert.ok(h.line.includes(mp) && h.welcome.join("\n").includes(`**${mp}**`), `${mp} is named:\n${all}`);
    assert.ok(
      all.includes(`is ${on ? "on" : "off"} by default`) || all.includes(`**${on ? "on" : "off"}** by default`),
      all,
    );
    assert.ok(h.line.includes(`auto-update is ${on ? "on" : "off"} by default`), h.line);
    assert.ok(!all.includes("(v0.7+)"), `${mp}: no (v0.7+)`);
    assert.ok(!/\{(marketplace|auto_update|upgrade)\}/.test(all), `${mp}: every fill is filled`);
    if (mp !== "SmartAndPoint") assert.ok(!all.includes("SmartAndPoint"), `${mp}: no SmartAndPoint:\n${all}`);
  }
});

test("directory B: an existing git user adds the listing — the welcome is the git marketplace's, naming SmartAndPoint's toggle, and doctor names the synced copy as not loaded", async () => {
  const home = tmp("ps-dir-git-");
  const git = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: git, version: VERSION, lastUpdated: new Date().toISOString() }]);
  const copy = fakeSynced(home, VERSION);
  const proj = project({ bound: true });
  const { welcome, sys } = sessionStart(home, git, proj);
  assert.ok(welcome.includes("the **SmartAndPoint** marketplace"), welcome);
  assert.ok(welcome.includes("auto-update is **off** by default"), welcome);
  assert.ok(sys.includes("Updates come through the SmartAndPoint marketplace"), sys);
  assert.ok(!welcome.includes("claude.ai") && !sys.includes("claude.ai"), "the directory's text is not this copy's");
  const cfg = JSON.parse(readFileSync(lib.layoutPaths(proj).binding, "utf8"));
  const f = (await doctor.runInstallChecks(cfg, proj, { root: git, home })).filter((x) => x.check === "synced-copy");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.ok(
    f[0].message.startsWith(`${SYNCED_KEY} ${VERSION}, from Anthropic's directory (${copy}), is not loaded`),
    f[0].message,
  );
  assert.ok(f[0].message.includes("Claude Code loads projectstore@SmartAndPoint"), f[0].message);
});

// The skeleton spec's contract 3 (amended 2026-10-15, the vault critic's
// finding): the welcome's size per channel, pinned, so a change to any update
// block fails here with the number to write into the spec. A synced copy's
// welcome is the largest; the composed value stays under the 10,000 cap with
// it and the sibling list at its cap.
test("directory B: the welcome's size per channel is pinned — git marketplace, claude-plugins-official, a synced copy and Codex — and the largest keeps the composed value under 10,000", () => {
  const home = tmp("ps-dir-size-");
  const roots = {
    git: fakeInstall(home, VERSION, { full: true }),
    official: fakeInstall(home, VERSION, { full: true, marketplace: "claude-plugins-official" }),
    synced: fakeSynced(home, VERSION, { full: true }),
  };
  const UNBOUND = { git: 1144, official: 1173, synced: 1394 };
  const BOUND_BASE = { git: 1156, official: 1185, synced: 1406 };
  for (const [name, root] of Object.entries(roots)) {
    const alone = sessionStart(home, root, project()).welcome;
    assert.ok(alone.includes("_This message appears once on this machine._"), name);
    assert.equal(alone.length, UNBOUND[name], `${name}: the unbound welcome's size — contract 3 names it`);
    const proj = project({ bound: true });
    const vaultPath = JSON.parse(readFileSync(lib.layoutPaths(proj).binding, "utf8")).vault_path;
    const first = sessionStart(home, root, proj).welcome;
    const again = sessionStart(home, root, proj).welcome;
    assert.ok(first.includes("_This message appears once per project._") && !again.includes("first time"), name);
    assert.equal(
      first.length - again.length,
      BOUND_BASE[name] + Math.min(vaultPath.length, 200),
      `${name}: the bound welcome is ${BOUND_BASE[name]} + the capped vault path — contract 3 names it`,
    );
  }
  // Codex's unbound welcome, from the checkout under Codex's manifest.
  const codex = [...loadHarnesses().values()].find((m) => m.id !== SRC.id);
  if (codex) {
    const proj = project();
    const r = spawnSync(process.execPath, [join(ROOT, "hooks", "session-start.mjs")], {
      encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "dir-cx", source: "startup", cwd: proj }),
      env: installEnv(home, ROOT, proj, { XDG_CACHE_HOME: tmp("ps-dir-cache-"), PROJECTSTORE_HARNESS: codex.id }),
      cwd: proj,
      timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const w = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.equal(w.length, 948, `${codex.id}: the unbound welcome's size — contract 3 names it`);
  }
  // The largest welcome, a synced copy's, beside the capped sibling list.
  const proj = project({ bound: true });
  const vault = JSON.parse(readFileSync(lib.layoutPaths(proj).binding, "utf8")).vault_path;
  const sessions = join(vault, ".projectstore", "sessions");
  mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 40; i++)
    writeFileSync(
      join(sessions, `sib-${i}.json`),
      JSON.stringify({
        id: `sib-${i}`,
        started_at: new Date().toISOString(),
        project_root: `/${"deeply-nested-worktree-".repeat(9)}p${i}`,
      }),
    );
  const ctx = sessionStart(home, roots.synced, proj).welcome;
  assert.ok(ctx.includes("projectstore is loaded for the first time"), "the welcome is in it");
  assert.ok(ctx.length < 10000, `contract 3: the composed value is ${ctx.length} characters`);
});

// ─── Doctor ─────────────────────────────────────────────────────────────

// Spy on every readFileSync the module graph makes (lib.mjs and doctor.mjs
// import the named binding, which syncBuiltinESMExports re-points).
function readsDuring(t, fn) {
  const spy = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  try {
    return { result: fn(), reads: spy.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}
// Doctor's auto-update check with the session's root named, as a session's
// plugin-root variable names it (0.30.5's check reads only the variable).
function autoUpdate(home, root) {
  const v = SRC.runtime.plugin_root_env;
  const had = Object.hasOwn(process.env, v),
    prev = process.env[v];
  process.env[v] = root;
  try {
    return doctor.checkAutoUpdate(home, SRC, { root });
  } finally {
    if (had) process.env[v] = prev;
    else delete process.env[v];
  }
}

test("directory B: checkAutoUpdate follows Claude Code's order — the settings entry, then the registry entry, then the marketplace's default — and reads a claudeai- marketplace from its own file", () => {
  const defaults = {
    SmartAndPoint: false,
    "claude-plugins-official": true,
    "knowledge-work-plugins": false,
    "claudeai-example": true,
  };
  const bad = [];
  for (const [mp, def] of Object.entries(defaults))
    for (const set of [true, false, undefined])
      for (const entry of [true, false, "unset", "missing"]) {
        const home = tmp("ps-dir-au-");
        const root = fakeInstall(home, "0.30.6", { marketplace: mp });
        const claudeai = mp.startsWith("claudeai-");
        const file = claudeai ? "known_marketplaces_claudeai.json" : "known_marketplaces.json";
        const decoy = claudeai ? "known_marketplaces.json" : "known_marketplaces_claudeai.json";
        const want =
          entry === "missing" ? "missing" : (set ?? (typeof entry === "boolean" ? entry : def)) ? "on" : "off";
        const plugins = join(home, HOME_DIR, "plugins");
        if (entry !== "missing")
          writeFileSync(
            join(plugins, file),
            JSON.stringify({ [mp]: entry === "unset" ? { source: { source: "github" } } : { autoUpdate: entry } }),
          );
        // The other file holds the opposite answer: reading it would show.
        writeFileSync(join(plugins, decoy), JSON.stringify({ [mp]: { autoUpdate: want !== "on" } }));
        if (set !== undefined) userSettings(home, { extraKnownMarketplaces: { [mp]: { autoUpdate: set } } });
        const out = autoUpdate(home, root);
        const got = !out.length
          ? "on"
          : /is missing from/.test(out[0].message)
            ? "missing"
            : /Auto-update is OFF/.test(out[0].message)
              ? "off"
              : `? ${out[0].message}`;
        const row = `${mp} settings=${set} registry=${entry}`;
        if (got !== want) bad.push(`${row}: ${got}, want ${want}`);
        if (want === "missing") {
          if (!out[0]?.message.includes(file)) bad.push(`${row}: names ${file}? ${out[0]?.message}`);
          if (claudeai && out[0]?.message.includes("/plugin marketplace add"))
            bad.push(`${row}: suggests marketplace add for a claude.ai marketplace`);
        }
      }
  assert.deepEqual(bad, []);
});

test("directory B: a synced root gives exactly one auto-update info and never reads installed_plugins.json for it", (t) => {
  const home = tmp("ps-dir-au-synced-");
  // Another copy's install record, and no marketplace registry: the fallback
  // 0.30.5 took reports on that copy.
  const git = fakeInstall(home, "0.30.5");
  writeRegistry(home, [{ scope: "user", installPath: git, version: "0.30.5", lastUpdated: "2026-10-15T00:00:00Z" }]);
  const root = fakeSynced(home, "0.30.6");
  const { result, reads } = readsDuring(t, () => autoUpdate(home, root));
  assert.equal(result.length, 1, JSON.stringify(result));
  assert.equal(result[0].level, "info");
  assert.equal(result[0].check, "auto-update");
  assert.ok(result[0].message.includes("claude.ai") && result[0].message.includes(root), result[0].message);
  assert.deepEqual(
    reads.filter((p) => p.endsWith("installed_plugins.json")),
    [],
    "no install record is read for the answer",
  );
});

test("directory B: a shadowed directory copy is named with the copy that loads and the way back in that copy's channel; alone, or off for the project, it is not; drift reads its version from its plugin.json", () => {
  const home = tmp("ps-dir-shadow-");
  const proj = project();
  const copy = fakeSynced(home, "0.30.6");
  assert.deepEqual(doctor.checkSyncedCopy(proj, { home }), [], "the synced copy alone loads: nothing to name");
  // An enabled git-marketplace copy loads over it.
  const git = fakeInstall(home, "0.30.5");
  writeRows(home, [{ key: "projectstore@SmartAndPoint", installPath: git, version: "0.30.5" }]);
  let [f] = doctor.checkSyncedCopy(proj, { home });
  assert.equal(f.check, "synced-copy");
  assert.equal(f.level, "info");
  assert.ok(
    f.message.startsWith(`${SYNCED_KEY} 0.30.6, from Anthropic's directory (${copy}), is not loaded`),
    f.message,
  );
  assert.ok(f.message.includes("Claude Code loads projectstore@SmartAndPoint 0.30.5 over it"), f.message);
  assert.ok(f.message.includes("/plugin → Installed, then disable projectstore@SmartAndPoint"), f.message);
  // Drift: the synced copy's version is its own plugin.json's, never the bucket manifest's.
  const [d] = doctor.checkVersionDrift(home, [], proj);
  assert.ok(d && d.message.includes(`0.30.6 (synced copy ${SYNCED_KEY} at ${copy})`), d && d.message);
  assert.ok(!d.message.includes("0040"), d.message);
  // The npm registration's copy: the way back is its uninstall, alone on its line.
  const npm = fakeInstall(home, "0.30.5", { marketplace: SRC.surfaces.plugin.marketplace_name });
  writeRows(home, [{ key: NPM_ID, installPath: npm, version: "0.30.5", scope: "local", projectPath: proj }]);
  [f] = doctor.checkSyncedCopy(proj, { home });
  assert.ok(f.message.includes(`Claude Code loads ${NPM_ID} 0.30.5 over it`), f.message);
  assert.equal(
    f.message.split("\n").at(-1),
    packageCommand(SRC, "uninstall", { version: "latest", args: "--surface plugin" }),
    f.message,
  );
  // Off for this project: no copy of the directory's loads here, so nothing is shadowed.
  localSettings(proj, { enabledPlugins: { [SYNCED_KEY]: false } });
  assert.deepEqual(doctor.checkSyncedCopy(proj, { home }), []);
  // …and Claude Code's precedence decides, as for any id: a local `true` over a
  // user-level `false` loads the copy again (the loading reference, "Find where
  // a plugin is enabled"), so it is shadowed again.
  userSettings(home, { enabledPlugins: { [SYNCED_KEY]: false } });
  localSettings(proj, { enabledPlugins: { [SYNCED_KEY]: true } });
  assert.equal(doctor.checkSyncedCopy(proj, { home }).length, 1, "a local true over a user false: on");
  localSettings(proj, {});
  assert.deepEqual(doctor.checkSyncedCopy(proj, { home }), [], "the user-level false alone: off");
});

// The B review, 2026-10-15: two buckets order by version, then folder age —
// the launcher's order — and only our plugin's folder under synced/ is ours.
test("directory B: several buckets order newest version first, and another synced plugin's status line is not our wiring", () => {
  const home = tmp("ps-dir-buckets-");
  const proj = project();
  const older = fakeSynced(home, "0.30.6", { bucket: "a_1" });
  const newer = fakeSynced(home, "0.30.7", { bucket: "b_2" });
  // The older version's folder is the newer one on disk.
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(older, later, later);
  const rows = lib.syncedPluginEntries(home, proj);
  assert.deepEqual(
    rows.map((r) => r.path),
    [newer, older],
    "newest version first, whatever the folder times",
  );
  const ours = join(newer, "scripts", "statusline.mjs");
  assert.equal(lib.isSyncedRoot(newer, home), true);
  assert.equal(lib.statusLineIsOurWiring(`node "${ours}"`, proj, home, join(home, "elsewhere")), true);
  const otherRoot = join(dirname(newer), "another-plugin");
  mkdirSync(join(otherRoot, "scripts"), { recursive: true });
  writeFileSync(join(otherRoot, "scripts", "statusline.mjs"), "");
  assert.equal(lib.isSyncedRoot(otherRoot, home), false, "another plugin's synced folder is not ours");
  assert.equal(
    lib.statusLineIsOurWiring(
      `node "${join(otherRoot, "scripts", "statusline.mjs")}"`,
      proj,
      home,
      join(home, "elsewhere"),
    ),
    false,
  );
});

test("directory B: a session run from a synced copy gets the layout move in the 'any other copy' form, naming that copy — over an enabled registry copy — and a terminal run whose project loads only the synced copy names it too", () => {
  const home = tmp("ps-dir-remedy-");
  const { proj } = legacyProject(home);
  const copy = fakeSynced(home, VERSION, { full: true });
  const own = `node "${join(copy, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register`;
  const git = fakeInstall(home, VERSION);
  writeRegistry(home, [{ scope: "user", installPath: git, version: VERSION, lastUpdated: "2026-10-15T00:00:00Z" }]);
  assert.equal(doctor.layoutRemedy(proj, { root: copy, home, env: {} }).command, own, "the session's own root");
  // From a terminal (a package root), with the synced copy the only one this project loads.
  rmSync(join(home, HOME_DIR, "plugins", "installed_plugins.json"));
  const npx = join(tmp("ps-dir-npx-"), "_npx", "1", "node_modules", "projectstore");
  assert.equal(doctor.layoutRemedy(proj, { root: npx, home, env: {} }).command, own, "the copy the project runs");
});

// ─── The status line ────────────────────────────────────────────────────

test("directory B: a bound project with the status line on and a synced root plans the launcher, as a cache install does, and no npm registration", () => {
  const home = tmp("ps-dir-sl-plan-");
  const copy = fakeSynced(home, VERSION);
  const proj = project({ bound: true, statusline: true });
  const p = installPlan(proj, { home, root: copy, env: noHostEnv() });
  const item = (s) => p.items.find((i) => i.surface === s);
  assert.equal(
    item("statusline_launcher")?.action,
    "create",
    JSON.stringify(item("statusline_launcher")) || "no launcher planned",
  );
  assert.equal(item("statusline").after.statusLine.command, `node "${lib.statusLineLauncherPath(proj)}"`);
  assert.notEqual(item("plugin")?.action, "create", "a synced root makes no npm registration");
  assert.equal(lib.desiredStatusLineCommand(proj, copy, home).launcher, true);
});

// The launcher as the installer renders it, run as its own process against
// the fixture home.
function renderLauncher(fallback, home, { base = null } = {}) {
  const proj = project();
  const p = lib.statusLineLauncherPath(proj);
  mkdirSync(dirname(p), { recursive: true });
  const src = lib.renderStatusLineLauncher(
    readFileSync(join(ROOT, "scripts", "statusline-launcher.mjs"), "utf8"),
    fallback,
    proj,
  );
  writeFileSync(p, src);
  if (base) userSettings(home, { statusLine: { type: "command", command: base } });
  const env = { ...process.env, HOME: home };
  delete env[SRC.runtime.home_env];
  return { proj, launcher: p, run: () => spawnSync(process.execPath, [p], { input: "{}", encoding: "utf8", env }) };
}

test("directory B: the launcher resolves a synced copy that has no install record — after its bucket changed, the newest version on disk — and falls back cleanly when the copy went to .trash/", () => {
  const home = tmp("ps-dir-sl-run-");
  // Written from a copy whose bucket is gone: the copy now sits in another one.
  const first = syncedRoot(home, "org-0001_user-0001");
  fakeSynced(home, "0.30.7", { bucket: "org-0002_user-0001" });
  fakeSynced(home, "0.30.6", { bucket: "org-0003_user-0001" });
  const l = renderLauncher(first, home);
  let r = l.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "rendered-by-0.30.7\n", "the newest synced copy, read from its plugin.json");
  // A launcher written from a cache copy never reaches into the synced folder (the family rule).
  const cache = renderLauncher(cacheRoot(home, "0.30.5"), home);
  r = cache.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "\n", "a cache launcher renders no synced copy");
  // Sync turned off: the host moved every copy to its trash.
  trashSynced(home, "org-0002_user-0001");
  trashSynced(home, "org-0003_user-0001");
  r = l.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "\n", "no base status line: an empty line");
  const withBase = renderLauncher(first, home, { base: "echo base-hud" });
  r = withBase.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "base-hud\n", "the person's own status line comes back");
});

test("directory B: doctor's status-line check names a vanished synced root and the two ways back — and stays quiet while a synced copy is on disk", () => {
  const home = tmp("ps-dir-sl-doc-");
  const copy = fakeSynced(home, VERSION);
  const proj = project({ bound: true, statusline: true });
  const p = lib.statusLineLauncherPath(proj);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    lib.renderStatusLineLauncher(readFileSync(join(ROOT, "scripts", "statusline-launcher.mjs"), "utf8"), copy, proj),
  );
  localSettings(proj, { statusLine: { type: "command", command: `node "${p}"` } });
  const cfg = { statusline: { enabled: true } };
  const named = () => doctor.checkStatusline(cfg, proj, home, SRC).filter((f) => f.message.includes(copy));
  assert.deepEqual(named(), [], "the copy is there");
  trashSynced(home);
  const [f] = named();
  assert.ok(f, "the vanished root is named");
  assert.equal(f.level, "warn");
  assert.equal(f.check, "statusline");
  assert.ok(f.message.includes("syncClaudeAiPlugins"), "way back 1: syncing on again");
  assert.equal(
    f.message.split("\n").at(-1),
    packageCommand([], "setup"),
    "way back 2: a channel of ours, alone on its line",
  );
  // Another synced copy on disk: the launcher renders it, nothing to say.
  fakeSynced(home, VERSION, { bucket: "org-0009_user-0001" });
  assert.deepEqual(named(), []);
});

// ─── Beside an enabled git copy: the installer plans as 0.30.5 did ──────

// Every channel answer's plan for one project, as JSON: its items, refusals
// and flags — what a synced copy beside an enabled copy must not change.
const plansOf = (proj, { home, root, env }) =>
  Object.fromEntries(
    [null, "npm", "git"].map((channel) => {
      const p = installPlan(proj, { home, root, env, channel });
      return [String(channel), JSON.stringify({ items: p.items, refusals: p.refusals, ok: p.ok, inc: p.incomplete })];
    }),
  );

test("directory B (a pin, passes on 0.30.5): beside an enabled git copy, which Claude Code loads over it, a synced copy at the same, a newer or an older version changes nothing an npx run plans under any channel answer — and after a switch to npm, the keep still refuses as it did", () => {
  for (const v of [VERSION, "99.0.0", "0.29.0"]) {
    const home = tmp("ps-dir-pin-");
    const proj = project({ bound: true, statusline: true });
    const root = join(tmp("ps-dir-pin-npx-"), "_npx", "1", "node_modules", "projectstore");
    fakePackageRoot(root, VERSION);
    const git = fakeInstall(home, "0.30.4");
    writeRegistry(home, [{ scope: "user", installPath: git, version: "0.30.4", lastUpdated: "2026-10-15T00:00:00Z" }]);
    const host = fakeClaude(tmp("ps-dir-pin-bin-"));
    const env = host.env({ HOME: home });
    const sw = installPlan(proj, { home, root, env, channel: "npm" });
    assert.ok(
      sw.items.some((i) => i.surface === "plugin_others" && i.action === "disable"),
      "the host is on PATH: the registration and its switch are planned",
    );
    const before = plansOf(proj, { home, root, env });
    fakeSynced(home, v);
    assert.deepEqual(plansOf(proj, { home, root, env }), before, `a synced copy at ${v}`);
    assert.deepEqual(
      conv.runningCopies(proj, { harnesses: [SRC.id], root, home, env }).map((c) => c.key),
      ["projectstore@SmartAndPoint"],
    );
    assert.deepEqual(
      surfaces
        .analyseRegistration(proj, SRC.surfaces.plugin, { root, home, harness: SRC, env })
        .others.map((o) => o.key),
      ["projectstore@SmartAndPoint"],
    );
    // The switch applied: the git copy held off here, the npm row on. With
    // the synced copy gone and back, every answer plans the same — the keep
    // refuses, never keeping a directory copy Claude Code does not load.
    rmSync(dirname(syncedRoot(home)), { recursive: true });
    assert.equal(installApply(installPlan(proj, { home, root, env, channel: "npm" }), { env, home }).failed, undefined);
    const switched = plansOf(proj, { home, root, env });
    fakeSynced(home, v);
    assert.deepEqual(plansOf(proj, { home, root, env }), switched, `switched, a synced copy at ${v}`);
    const keep = installPlan(proj, { home, root, env, channel: "git" });
    assert.equal(keep.ok, false);
    assert.equal(
      keep.refusals[0],
      [
        "no git-marketplace copy of projectstore is enabled for this project, so there is none to keep. Nothing is written.",
        `This checkout's local settings hold projectstore@SmartAndPoint off. To load it again, run this in ${SRC.display_name}:`,
        "/plugin enable projectstore@SmartAndPoint",
        "The way back from an earlier switch to the npm install is its uninstall, from a terminal in this project:",
        `npx projectstore uninstall --harness ${SRC.id} --surface plugin`,
      ].join("\n"),
    );
  }
});

// ─── B2: setup and install keep a directory copy ────────────────────────
//
// PS-DIRECTORY, "Setup and install keep a directory copy: no npm registration
// is planned over an enabled projectstore@synced unless the npm channel is
// chosen". The fake host on a temp PATH logs every call; the synced copy is at
// the running version, so no run here reads the registry.

const DISPLAY = SRC.display_name;
const SHADOW = `${DISPLAY} then loads the npm copy here, and reports the directory copy as not loaded`;
// The gate's text: from a checkout no version is pinned; from a package root
// (a node_modules, npx's cache) the running one is.
const GATE = (pin = "") =>
  [
    `Nothing written: this project loads projectstore from Anthropic's directory (${SYNCED_KEY}), and moving it to the npm install is a choice made at a terminal in this project:`,
    "",
    `    npx projectstore${pin} setup --harness ${SRC.id}`,
    "",
    "Without a terminal, name the channel:",
    "",
    `    npx projectstore${pin} setup --harness ${SRC.id} --channel npm`,
    "",
    `    npx projectstore${pin} setup --harness ${SRC.id} --channel git`,
  ].join("\n");
// The stub copy's own plan lists these writes while their files are missing.
const STUB_WRITES = [
  {
    surface: "statusline_launcher",
    kind: "exclusive",
    action: "create",
    file: join(".projectstore", "stub-launcher.mjs"),
    body: "// written by the stub copy\n",
  },
  {
    surface: "statusline",
    kind: "shared",
    action: "create",
    file: join(SRC.runtime.harness_dir, "stub-settings.json"),
    body: "{}\n",
  },
];
// A machine with the fake host on PATH, a project (bound unless asked), a
// package root at the running version, and a copy synced from claude.ai — the
// stub copy, which answers its own plan and upgrade, when `stub` is given.
function b2Sandbox({ bound = true, stub = false, statusline = false } = {}) {
  const home = tmp("ps-dir-b2-home-");
  const proj = project({ bound, statusline });
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const root = fakePackageRoot(join(tmp("ps-dir-b2-pkg-"), "node_modules", "projectstore"), VERSION);
  const copy = stub
    ? fixtures.stubCopy(home, VERSION, { writes: STUB_WRITES }, { synced: "org-0001_user-0001" })
    : fakeSynced(home, VERSION);
  const host = fakeClaude(tmp("ps-dir-b2-bin-"));
  const paths = surfaces.registrationPaths(SRC.surfaces.plugin, { home, projectDir: proj, harness: SRC });
  return { home, proj, root, copy, host, paths, env: host.env({ HOME: home }) };
}
const othersOf = (p) => p.items.filter((i) => i.surface === "plugin_others");
const hostStepsOf = (p) => p.items.flatMap((i) => (i.steps || []).filter((st) => st.kind === "host"));
const writesOf = (p) => p.items.filter((i) => !["skip", "refuse"].includes(i.action));
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
// A text sink that is not a terminal.
function sink() {
  const chunks = [];
  return {
    isTTY: false,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
    text: () => chunks.join(""),
  };
}

test("directory B2 rule 1: an enabled synced copy is one running copy, keyed projectstore@synced with its own plugin.json's version, and never a competing copy to turn off; false in the checkout's settings.local.json gives none", () => {
  const sb = b2Sandbox();
  const env = noHostEnv();
  const running = (extra = {}) =>
    conv.runningCopies(sb.proj, { harnesses: [SRC.id], root: sb.root, home: sb.home, env, ...extra });
  const analysis = () =>
    surfaces.analyseRegistration(sb.proj, SRC.surfaces.plugin, { root: sb.root, home: sb.home, harness: SRC, env });
  assert.deepEqual(
    running().map((c) => [c.key, c.version]),
    [[SYNCED_KEY, VERSION]],
    "the copy's own version, never the bucket's 0040",
  );
  assert.deepEqual(analysis().others, [], "never a switch, never our manifest's disabled list");
  assert.equal(analysis().directory?.key, SYNCED_KEY, "the copy Claude Code loads here");
  assert.deepEqual(running({ channel: "git" }), [], "under the keep none counts");
  localSettings(sb.proj, { enabledPlugins: { [SYNCED_KEY]: false } });
  assert.deepEqual(running(), []);
  assert.equal(analysis().directory, null);
});

test("directory B2 criterion 'No channel answer': install and upgrade over a synced copy, without a terminal and without --no-register, write nothing, exit 1 and print the gate naming the directory copy — through the bin and main(); under --json ok:false with {confirmed:false, why:'channel'}", () => {
  const sb = b2Sandbox();
  const env = sb.host.env({ HOME: sb.home, [SRC.runtime.plugin_root_env]: ROOT });
  const run = (script, args) =>
    spawnSync(process.execPath, [script, ...args, "--project", sb.proj], {
      encoding: "utf8",
      env,
      cwd: sb.proj,
      timeout: 60000,
    });
  const files = ["CLAUDE.md", join(SRC.runtime.harness_dir, "settings.local.json"), "AGENTS.md"].map((f) =>
    join(sb.proj, f),
  );
  const snap = () => files.map((f) => (fs.existsSync(f) ? readFileSync(f, "utf8") : null));
  const before = snap();
  for (const [entry, script] of [
    ["the bin", join(ROOT, "bin", "projectstore.mjs")],
    ["main()", join(ROOT, "scripts", "install-harness.mjs")],
  ]) {
    for (const verb of ["install", "upgrade"]) {
      const t = run(script, [verb, "--harness", SRC.id]);
      assert.equal(t.status, 1, `${entry} ${verb}: ${t.stdout}${t.stderr}`);
      assert.ok(t.stdout.endsWith(`\n${GATE()}\n`), `${entry} ${verb}:\n${t.stdout}`);
      assert.ok(
        t.stdout.includes(`\n      ${SHADOW}\n`),
        `the plan was shown first, with the consequence:\n${t.stdout}`,
      );
      assert.ok(!t.stdout.includes("⇄"), "no switch is drawn: nothing is turned off");
      const j = run(script, [verb, "--harness", SRC.id, "--json"]);
      assert.equal(j.status, 1, `${entry} ${verb} --json: ${j.stderr}`);
      const out = JSON.parse(j.stdout);
      const r = entry === "the bin" ? out.result : out;
      assert.equal(out.ok, false);
      assert.deepEqual(r.gate, { confirmed: false, why: "channel" });
      assert.deepEqual(r.applied, []);
    }
  }
  assert.deepEqual(sb.host.log(), [], "no host command ran");
  assert.deepEqual(snap(), before, "nothing written in the project");
  assert.ok(!fs.existsSync(sb.paths.dir), "no marketplace directory written");
});

test("directory B2 criterion '--no-register' (a pin, passes on 0.30.5): over a synced copy a --no-register run plans no registration and meets no gate — named, it confirms as today", async () => {
  const sb = b2Sandbox();
  const p = installPlan(sb.proj, { home: sb.home, root: sb.root, env: sb.env, harnesses: [SRC.id], register: false });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.deepEqual(
    p.items.filter((i) => i.kind === "registration"),
    [],
    "every registration surface is left out of the plan",
  );
  assert.deepEqual(await installer.confirm(p, {}), { confirmed: true, why: "named" });
});

test("directory B2 criterion 'The keep': under --channel git the plan holds one channel item for Claude Code whose step runs the synced copy's own bin with --no-register; no registration is written, and the copy writes the project's surfaces", async () => {
  const sb = b2Sandbox({ stub: true });
  const out = sink();
  const r = await installer.runVerb("upgrade", sb.proj, {
    harnesses: [SRC.id],
    home: sb.home,
    root: sb.root,
    env: sb.env,
    channel: "git",
    cwd: sb.proj,
    out,
    ask: async () => "y",
  });
  const p = r.plan;
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  const keeps = p.items.filter((i) => i.harness === SRC.id && i.kind === "channel");
  assert.equal(keeps.length, 1);
  const [keep] = keeps;
  assert.equal(keep.entry, SYNCED_KEY);
  assert.deepEqual(keep.steps[0].argv, [
    process.execPath,
    join(sb.copy, "bin", "projectstore.mjs"),
    "upgrade",
    "--harness",
    SRC.id,
    "--no-register",
    "--json",
    "--project",
    sb.proj,
  ]);
  assert.ok(
    keep.reason.startsWith(`this project keeps ${SYNCED_KEY} ${VERSION} from Anthropic's directory`),
    keep.reason,
  );
  assert.ok(!/git marketplace/.test(keep.reason), keep.reason);
  assert.deepEqual(
    p.items.filter((i) => i.kind === "registration"),
    [],
    "no registration row",
  );
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.deepEqual(
    fixtures.stubCalls(sb.copy).map((c) => c.argv[0]),
    ["plan", "upgrade"],
  );
  for (const w of STUB_WRITES) assert.equal(readFileSync(join(sb.proj, w.file), "utf8"), w.body);
  assert.deepEqual(sb.host.log(), [], "no host command");
  assert.ok(!fs.existsSync(sb.paths.dir), "no marketplace directory");
  assert.ok(!readJson(sb.paths.projectSettings)?.enabledPlugins, "no enablement written");
  assert.ok(out.text().includes(`kept     ${DISPLAY}: ${SYNCED_KEY} ${VERSION}`), out.text());
});

test("directory B2 criterion 'The npm answer': --channel npm registers the npm copy at local scope with the consequence row — no plugin disable for projectstore@synced, no ⇄ switch, nothing in our manifest's disabled list — and writes channel_switch; a re-run is zero-change", () => {
  const sb = b2Sandbox();
  const { home, proj, root, env } = sb;
  const p = installPlan(proj, { home, root, env, channel: "npm" });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  const reg = p.items.find((i) => i.surface === "plugin");
  assert.equal(reg.action, "create");
  assert.equal(reg.scope, "local");
  const install = reg.steps.find((st) => st.kind === "host" && st.name === "install");
  assert.ok(install.argv.includes("--scope") && install.argv.includes("local"), JSON.stringify(install.argv));
  const [row, ...more] = othersOf(p);
  assert.deepEqual(more, []);
  assert.deepEqual([row.entry, row.action, row.state], [SYNCED_KEY, "skip", "shadowed"]);
  assert.deepEqual(
    row.steps.map((st) => [st.kind, st.why]),
    [["note", SHADOW]],
    "the consequence row",
  );
  assert.ok(
    !hostStepsOf(p).some((st) => st.name === "disable" || st.argv?.includes(SYNCED_KEY)),
    "no plugin disable for the directory copy",
  );
  const manifest = reg.steps.find((st) => st.kind === "write").manifest;
  const prov = manifest[SRC.surfaces.plugin.provenance_key];
  assert.deepEqual(prov.disabled, [], "never in our manifest's disabled list");
  const mark = p.items.find((i) => i.kind === "binding" && i.surface === "channel_switch");
  assert.equal(mark?.action, "add", "channel_switch is planned");
  const preview = installer.renderPreview(p);
  assert.ok(preview.includes(`\n      ${SHADOW}\n`), preview);
  assert.ok(!preview.includes("⇄") && !/\bswitch\b +projectstore@synced/.test(preview), preview);
  const done = installApply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done.failed));
  assert.equal(typeof readJson(lib.layoutPaths(proj).binding)?.channel_switch?.at, "string", "the mark");
  assert.ok(!Object.hasOwn(readJson(sb.paths.projectSettings)?.enabledPlugins || {}, SYNCED_KEY), "nothing turned off");
  const again = installPlan(proj, { home, root, env, channel: "npm" });
  assert.deepEqual(writesOf(again), [], "zero changes");
  assert.deepEqual(othersOf(again), [], "the npm copy loads now: no row for the directory copy");
});

test("directory B2: under --channel npm, a registration that fails leaves the directory copy loading and records no channel_switch", () => {
  const sb = b2Sandbox();
  const failing = sb.host.env({ HOME: sb.home, FAKE_CLAUDE_FAIL: "install" });
  const p = installPlan(sb.proj, { home: sb.home, root: sb.root, env: failing, channel: "npm" });
  const done = installApply(p, { env: failing, home: sb.home });
  assert.equal(done.failed?.step, "install");
  const mark = done.find((d) => d.surface === "channel_switch");
  assert.deepEqual([mark.action, mark.reason], ["skipped", "the switch did not complete; nothing is recorded"]);
  assert.equal(readJson(lib.layoutPaths(sb.proj).binding).channel_switch, undefined);
});

test("directory B2 criterion 'The way back': uninstall --surface plugin after the npm answer removes the registration and channel_switch, and its DONE says the directory copy loads again at the next start", async () => {
  const sb = b2Sandbox();
  const { home, proj, root, env } = sb;
  assert.equal(installApply(installPlan(proj, { home, root, env, channel: "npm" }), { env, home }).failed, undefined);
  assert.ok(readJson(lib.layoutPaths(proj).binding).channel_switch);
  const out = sink();
  const r = await installer.runVerb("uninstall", proj, {
    harnesses: [SRC.id],
    surfaces: ["plugin"],
    home,
    root,
    env,
    cwd: proj,
    out,
  });
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const reg = r.plan.items.find((i) => i.surface === "plugin");
  assert.equal(reg.action, "remove");
  assert.ok(
    reg.steps.some((st) => st.kind === "unmark"),
    "the mark goes with the registration",
  );
  assert.equal(readJson(lib.layoutPaths(proj).binding).channel_switch, undefined);
  assert.ok(
    !lib.installedPluginEntries(home, proj).some((e) => e.key === NPM_ID && e.projectPath),
    "the registration is gone",
  );
  const done = out.text().slice(out.text().indexOf("\nDone"));
  assert.ok(
    done
      .replace(/\s+/g, " ")
      .includes(
        `${SYNCED_KEY}, from Anthropic's directory, loads in this project again at the next start of ${DISPLAY}.`,
      ),
    done,
  );
});

test("directory B2: uninstall says the directory copy loads again only when this checkout's npm copy was the one loading — not with the npm row already held off", async () => {
  const sb = b2Sandbox();
  const { home, proj, root, env } = sb;
  assert.equal(installApply(installPlan(proj, { home, root, env, channel: "npm" }), { env, home }).failed, undefined);
  const local = readJson(sb.paths.projectSettings);
  writeFileSync(
    sb.paths.projectSettings,
    JSON.stringify({ ...local, enabledPlugins: { ...local.enabledPlugins, [NPM_ID]: false } }, null, 2),
  );
  const out = sink();
  const r = await installer.runVerb("uninstall", proj, {
    harnesses: [SRC.id],
    surfaces: ["plugin"],
    home,
    root,
    env,
    cwd: proj,
    out,
  });
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.equal(r.plan.items.find((i) => i.surface === "plugin").action, "remove");
  assert.ok(out.text().includes("\nDone"), out.text());
  assert.ok(!out.text().includes("loads in this project again"), out.text());
});

test("directory B2: after the npm answer doctor's synced-copy info goes quiet — the checkout recorded channel_switch — and an unmarked checkout keeps it; the install checks pass the binding through", async () => {
  const sb = b2Sandbox();
  const { home, proj, root, env } = sb;
  assert.equal(installApply(installPlan(proj, { home, root, env, channel: "npm" }), { env, home }).failed, undefined);
  const cfg = readJson(lib.layoutPaths(proj).binding);
  assert.ok(cfg.channel_switch, "the mark");
  assert.deepEqual(doctor.checkSyncedCopy(proj, { home, cfg }), [], "marked: no info");
  const unmarked = { ...cfg };
  delete unmarked.channel_switch;
  const [f] = doctor.checkSyncedCopy(proj, { home, cfg: unmarked });
  assert.equal(f?.check, "synced-copy", "unmarked: the info");
  const all = await doctor.runInstallChecks(cfg, proj, { home, root, env });
  assert.ok(!all.some((x) => x.check === "synced-copy"), JSON.stringify(all.map((x) => x.check)));
});

// The TTY double: stdin a PassThrough that says it is a terminal, with a
// setRawMode; stdout a terminal sink; a process stand-in for the rail.
function tty() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => {
    stdin.isRaw = on;
    return stdin;
  };
  const chunks = [];
  const stdout = {
    isTTY: true,
    columns: 200,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
  };
  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true });
  return { stdin, stdout, proc, text: () => chunks.join("") };
}
async function b2Setup(sb, { keys = null, values = {} } = {}) {
  const t = keys ? tty() : null;
  if (t) t.stdin.write(keys.join(""));
  const pipe = sink();
  const env = { ...sb.env, NO_COLOR: "1", TERM: "xterm-256color" };
  for (const k of ["CI", "FORCE_COLOR", "PROJECTSTORE_ASCII", "PROJECTSTORE_PROJECT_DIR"]) delete env[k];
  const r = await setupVerb.runSetup({
    values: { project: sb.proj, ...values },
    project: sb.proj,
    env,
    cwd: sb.proj,
    stdin: t ? t.stdin : null,
    stdout: t ? t.stdout : pipe,
    stderr: t ? t.stdout : pipe,
    ask: async () => "n",
    root: sb.root,
    home: sb.home,
    proc: t ? t.proc : new EventEmitter(),
    escapeMs: 20,
    fetchSpawn: fakeNpmSpawn().spawn,
  });
  return { r, text: t ? t.text() : pipe.text() };
}

test(
  "directory B2 criterion 'Setup at a terminal': the channel question offers the keep, the default, and the npm move, each with its consequence; the keep plans the copy's own step, the npm move plans the consequence row and never a ⇄ switch; without a terminal setup refuses naming the directory copy",
  { timeout: 60000 },
  async () => {
    const sb = b2Sandbox({ stub: true, statusline: true });
    const ENTER = "\r",
      DOWN = "\x1b[B";
    const keep = await b2Setup(sb, { keys: [ENTER, ENTER], values: { "dry-run": true } });
    const drawn = keep.text.replace(/\n│ +/g, " ").replace(/ +/g, " ");
    assert.ok(drawn.includes(setupVerb.DIRECTORY_TEXT), drawn);
    assert.ok(
      drawn.includes(
        `● Keep the directory copy ${DISPLAY} keeps loading ${SYNCED_KEY}, updated from claude.ai; setup refreshes this project's files through that copy`,
      ),
      drawn,
    );
    assert.ok(drawn.includes(`○ Move to npm ${SHADOW}; setup and upgrade update the npm copy from now on`), drawn);
    assert.equal(keep.r.result.setup.channel, "git", "the keep is the default");
    assert.equal(keep.r.result.items.find((i) => i.kind === "channel")?.entry, SYNCED_KEY);
    assert.ok(!keep.r.result.items.some((i) => i.kind === "registration"), "no registration under the keep");
    const npm = await b2Setup(sb, { keys: [ENTER, DOWN, ENTER], values: { "dry-run": true } });
    assert.equal(npm.r.result.setup.channel, "npm");
    assert.deepEqual(
      npm.r.result.items.filter((i) => i.surface === "plugin_others").map((i) => [i.entry, i.action, i.state]),
      [[SYNCED_KEY, "skip", "shadowed"]],
    );
    const plan = npm.text.slice(npm.text.indexOf("Plan"));
    assert.ok(plan.includes(SHADOW), plan);
    assert.ok(!plan.includes("⇄"), "the npm answer turns nothing off, so no switch is drawn");
    // Without a terminal and without --channel: refused before any plan, naming the directory copy.
    const bare = await b2Setup(sb, { values: { harness: [SRC.id] } });
    assert.equal(bare.r.code, 1);
    assert.equal(bare.text, `${GATE(`@${VERSION}`)}\n`);
    assert.deepEqual(bare.r.result.items, []);
    assert.deepEqual(sb.host.log(), [], "no host call");
  },
);

test("directory B2: setup's channel table for a directory copy — asked with the keep the default, a session running it keeps, without a terminal refused, an npm user beside it never asked", () => {
  const directory = { key: SYNCED_KEY, version: VERSION, synced: true };
  const decide = (extra) => setupVerb.decideChannel({ inSet: true, others: [], directory, display: DISPLAY, ...extra });
  const asked = decide({ interactive: true, running: VERSION, selected: directory });
  assert.equal(asked.default, "git");
  assert.deepEqual(
    asked.choices.map((x) => [x.value, x.label]),
    [
      ["git", "Keep the directory copy"],
      ["npm", "Move to npm"],
    ],
  );
  assert.deepEqual(decide({ inSession: true, sessionCopy: { channel: "synced" } }), {
    asked: false,
    value: "git",
    why: "session",
  });
  assert.deepEqual(decide({}), { asked: false, value: null, refuse: true });
  assert.deepEqual(setupVerb.decideChannel({ inSet: true, others: [], directory: null }), {
    asked: false,
    value: null,
    why: "none",
  });
});

test("directory B2: a directory copy newer than this package is not registered over under no channel answer — the registration defers, names both versions and the ways out, and nothing turns it off", () => {
  const sb = b2Sandbox();
  fakeSynced(sb.home, "99.0.0", { bucket: "org-0002_user-0001" });
  const p = installPlan(sb.proj, { home: sb.home, root: sb.root, env: sb.env });
  const reg = p.items.find((i) => i.surface === "plugin");
  assert.equal(reg.action, "skip");
  assert.equal(reg.deferred, true);
  assert.equal(p.incomplete, true);
  assert.ok(
    reg.reason.startsWith(
      `this project runs a newer copy (${SYNCED_KEY} 99.0.0) than this package (${VERSION}), so the npm install is not registered over it`,
    ),
    reg.reason,
  );
  assert.ok(
    reg.reason.split("\n").includes(`npx projectstore@${VERSION} setup --harness ${SRC.id} --channel git`),
    reg.reason,
  );
  assert.deepEqual(hostStepsOf(p), [], "no host command");
  assert.deepEqual(othersOf(p), []);
});

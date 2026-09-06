// projectstore — upgrade tests (PS-HARNESS: "Seamless upgrade from 0.27.1 to
// 0.28: the comparison test plan and what migrates itself").
//
// A project in the shape 0.27.1 left it — a pre-provenance launcher, a v3
// block copied from the template, a live settings.local.json entry,
// statusline.enabled, a bound vault with its views in sync — meets the
// current plugin as a FAKE CACHE INSTALL (tests/fixtures/install.mjs, full
// tree): the bin and the SessionStart hook are spawned from that root, so
// isPluginCacheRoot() holds and rung 1″ can fire, which the repo's own bin
// can never make true. The assertions are the story's acceptance criteria:
// what the first session touches (nothing of ours), what doctor says, what
// one upgrade re-stamps, that the views owe no reconcile, that a dev
// checkout never prunes, and what a rollback to 0.27.1 does.
//
// tests/fixtures/statusline-launcher-0.27.1.txt is the launcher template
// shipped in 0.27.1 (~/.claude/plugins/cache/SmartAndPoint/projectstore/0.27.1/
// scripts/statusline-launcher.mjs, sha256 dae6b1fceb928989…, vendored
// 2026-09-05): one placeholder, "__PROJECTSTORE_ROOT__"; 0.28's template has
// three. 0.27.1's writeStatusLineLauncher rendered it with
// tpl.replace('"__PROJECTSTORE_ROOT__"', JSON.stringify(root)) and rewrote the
// file on every SessionStart whenever the bytes differed.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sourceHarness } from "../scripts/harness.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import { renderStatusLineLauncher, statusLineLauncherPath, renderAgentsBlock, syncStatusLine, LAUNCHER_HEADER, layoutPaths} from "../scripts/lib.mjs";
import { plan, apply } from "../scripts/install-harness.mjs";
import { checkHarnessSurfaces, checkPendingUpgrade, runStartupChecks, checkLayout } from "../scripts/doctor.mjs";
import { fakeInstall, writeRegistry, installEnv, noHostEnv } from "./fixtures/install.mjs";
import { seedCliVault } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TPL_027 = readFileSync(join(ROOT, "tests", "fixtures", "statusline-launcher-0.27.1.txt"), "utf8");
const TEMPLATE = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
const BLOCK = renderAgentsBlock(TEMPLATE, null);
const read = (p) => readFileSync(p, "utf8");
// The fake home must be a real path: isPluginCacheRoot is a string-prefix test
// between the bin's own root (realpath'd by ESM) and <home>/plugins/cache, and
// on macOS tmpdir() is /var/… while its realpath is /private/var/….
const TMP = realpathSync(tmpdir());

// A real CLAUDE_CONFIG_DIR in the developer's environment would mask the temp home for in-process calls.
delete process.env[SRC.runtime.home_env];

const render027 = (tpl, root) => tpl.replace('"__PROJECTSTORE_ROOT__"', JSON.stringify(root));

// The 0.27.1-shaped project: bound to a seeded vault whose views are in sync,
// statusline on and wired to a pre-provenance launcher whose fallback root is
// the old install, the block registered from the template.
function project027(home) {
  const old = join(home, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", "0.27.1");
  mkdirSync(join(old, "scripts"), { recursive: true });
  writeFileSync(join(old, "scripts", "statusline.mjs"), 'process.stdout.write("rendered-by-0.27.1\\n");\n');
  const { proj, vault } = seedCliVault();
  // The 0.27.1 shape is the LEGACY layout: the binding under the harness's
  // directory, the launcher under .claude/.projectstore/ (the layout ADR, 2026-09-06).
  const lp = layoutPaths(proj);
  const cfgPath = lp.legacy.binding;
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(read(lp.binding)), statusline: { enabled: true } }, null, 2) + "\n");
  rmSync(lp.root, { recursive: true, force: true });
  mkdirSync(lp.legacy.runtime, { recursive: true });
  const launcher = lp.legacy.launcher;
  writeFileSync(launcher, render027(TPL_027, old));
  writeFileSync(join(proj, CFG_DIR, "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${launcher}"` } }, null, 2) + "\n");
  writeFileSync(join(proj, "AGENTS.md"), BLOCK + "\n");
  writeFileSync(join(proj, "CLAUDE.md"), "# My project\n\n@AGENTS.md\n");
  return { proj, vault, launcher, old };
}

function snapshot(proj, vault) {
  const files = [join(proj, CFG_DIR, "settings.local.json"), layoutPaths(proj).legacy.launcher, join(proj, "AGENTS.md"), join(proj, "CLAUDE.md"), join(vault, "kanban.md"), join(vault, "graph.md"), join(vault, "code-map.md")];
  return Object.fromEntries(files.filter(existsSync).map((f) => [f, read(f)]));
}

function install028() {
  const home = mkdtempSync(join(TMP, "ps-up-home-"));
  const root = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: root, version: VERSION, lastUpdated: new Date().toISOString() }]);
  return { home, root };
}

const bin = (root, env, args) => spawnSync(process.execPath, [join(root, "bin", "projectstore.mjs"), ...args], { encoding: "utf8", env, timeout: 90000, maxBuffer: 1 << 24 });
const INSTALL_FAMILY = ["surface", "surface-foreign", "version-drift", "harness", "mcp", "upgrade", "plugin-registration", "plugin-registration-foreign", "layout-legacy", "layout-two-configs"];

test("upgrade: the first 0.28 session touches nothing of ours, names the one pending step, and doctor reports exactly the stale launcher plus the mcp info", async () => {
  const { home, root } = install028();
  const { proj, vault } = project027(home);
  // The views are in sync before the update.
  const rec = bin(root, installEnv(home, root, proj), ["reconcile", "--write", "--only", "graph", "--project", proj]);
  assert.equal(rec.status, 0, rec.stderr);
  for (const t of ["kanban", "codemap"]) assert.equal(bin(root, installEnv(home, root, proj), ["reconcile", "--write", "--only", t, "--project", proj]).status, 0);
  const before = snapshot(proj, vault);

  // First session: the hook, spawned from the install.
  const hook = spawnSync(process.execPath, [join(root, "hooks", "session-start.mjs")], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "up-1", source: "startup", cwd: proj }), env: installEnv(home, root, proj), cwd: proj, timeout: 30000 });
  assert.equal(hook.status, 0, hook.stderr);
  const out = hook.stdout.trim() ? JSON.parse(hook.stdout) : {};
  const sys = (out.systemMessage || "") + " " + JSON.stringify(out.hookSpecificOutput || {});
  assert.match(sys, /plugin updated/, "the startup line names the pending step");
  assert.match(sys, /doctor --fix/);
  assert.match(sys, /layout moved to \.projectstore\//, "and the layout move (the layout ADR, 2026-09-06)");
  assert.deepEqual(snapshot(proj, vault), before, "settings, launcher, block and views are byte-identical after the first session");
  assert.ok(existsSync(join(vault, ".projectstore", "sessions", "up-1.json")) || readdirSync(join(vault, ".projectstore", "sessions")).length > 0, "the session marker is the write");

  // Doctor: the install family is exactly {surface issue, mcp info} plus the offer.
  const doc = bin(root, installEnv(home, root, proj), ["doctor", "--json", "--install", "--project", proj]);
  const findings = JSON.parse(doc.stdout).result;
  // Registration rows are left out on purpose: they read whether the host's
  // CLI is on PATH — present on a maintainer's machine, absent on a CI runner,
  // where this assertion gained a `plugin-registration` info and went red.
  // registration.test.mjs pins that environment with a fake CLI and owns those
  // rows; this test owns the launcher, the layout and the mcp line.
  const fam = findings.filter((f) => INSTALL_FAMILY.includes(f.check) && !f.check.startsWith("plugin-registration")).map((f) => [f.check, f.level]).sort();
  assert.deepEqual(fam, [["layout-legacy", "warn"], ["mcp", "info"], ["surface", "issue"]], "the install family is exactly the stale launcher, the legacy layout and the permanent mcp info");
  const stale = findings.find((f) => f.check === "surface");
  assert.match(stale.message, /plugin updated \(pre-provenance file\)/);
  assert.match(stale.message, /bin\/projectstore\.mjs" install --harness/);
  assert.deepEqual(checkPendingUpgrade(proj, home, root).map((f) => f.check), ["upgrade"]);
  // In-process, this repo is the root — a dev checkout — so the re-stamp offer is correctly absent; the layout offer does not depend on the root.
  const offers = runStartupChecks(JSON.parse(read(join(proj, CFG_DIR, "projectstore.json"))), proj).offers;
  assert.equal(offers.length, 1); assert.match(offers[0], /layout moved/);

  // One upgrade: the layout moves, the launcher is stamped at its new path, the
  // entry is re-pointed, the legacy launcher and runtime dir are gone (the
  // layout ADR); the block and the views do not move.
  const up = bin(root, installEnv(home, root, proj), ["upgrade", "--harness", SRC.id, "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  const lp = layoutPaths(proj);
  const stamped = read(statusLineLauncherPath(proj));
  const prov = parseProvenance(stamped);
  assert.ok(prov, "stamped");
  assert.equal(prov.pkg, VERSION);
  assert.ok(stamped.includes(LAUNCHER_HEADER));
  assert.ok(stamped.includes(JSON.stringify(proj)), "the launcher names its project");
  assert.ok(!existsSync(lp.legacy.launcher), "the legacy launcher is removed once the entry names the new one");
  assert.ok(!existsSync(lp.legacy.runtime), "the emptied legacy runtime directory is pruned");
  assert.ok(!existsSync(lp.legacy.binding) && existsSync(lp.binding), "the binding moved");
  assert.equal(JSON.parse(read(join(proj, CFG_DIR, "settings.local.json"))).statusLine.command, `node "${statusLineLauncherPath(proj)}"`, "the entry is re-pointed");
  const after = snapshot(proj, vault);
  for (const [f, text] of Object.entries(before)) if (f !== lp.legacy.launcher && f !== join(proj, CFG_DIR, "settings.local.json")) assert.equal(after[f], text, `${f} untouched by upgrade`);
  const doc2 = JSON.parse(bin(root, installEnv(home, root, proj), ["doctor", "--json", "--install", "--project", proj]).stdout).result;
  assert.deepEqual(doc2.filter((f) => INSTALL_FAMILY.includes(f.check) && !f.check.startsWith("plugin-registration")).map((f) => [f.check, f.level]), [["mcp", "info"]], "clean but for the permanent mcp info");
  assert.deepEqual(checkPendingUpgrade(proj, home, root), [], "nothing pending after the re-stamp");
  // The views owe no reconcile.
  const rec2 = JSON.parse(bin(root, installEnv(home, root, proj), ["reconcile", "--project", proj]).stdout);
  assert.equal(rec2.summary.changed, 0, "no view owes a reconcile: " + JSON.stringify(rec2.summary));
});

test("upgrade: a dev-checkout root (this repo's bin) reports the 0.27.1 launcher and never deletes it; uninstall removes it", () => {
  const home = mkdtempSync(join(TMP, "ps-up-home-"));
  const { proj, launcher } = project027(home);
  const before = read(launcher);
  const env = installEnv(home, ROOT, proj);
  const p = plan(proj, { home, root: ROOT, surfaces: ["statusline"] });
  const item = p.items.find((i) => i.surface === "statusline_launcher");
  assert.equal(item.action, "skip");
  assert.match(item.reason, /left in place/);
  const up = spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), "upgrade", "--harness", SRC.id, "--surface", "statusline", "--project", proj], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.equal(read(launcher), before, "byte-identical after upgrade from a dev root");
  assert.deepEqual(checkPendingUpgrade(proj, home, ROOT), [], "no offer from a root whose install would not re-stamp");
  const un = spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), "uninstall", "--harness", SRC.id, "--surface", "statusline", "--project", proj], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(un.status, 0, un.stderr + un.stdout);
  assert.ok(!existsSync(launcher), "uninstall is the one verb that removes it from a dev root");
});

test("upgrade: a wrapped block marker and a hand-edited block are named, never duplicated, never 'removed' by a no-op", async () => {
  const { home, root } = install028();
  const { proj } = project027(home);
  const wrapped = "# Mine\n\n<!-- projectstore:agents v3 (managed by projectstore — edit outside\n     markers) -->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n";
  writeFileSync(join(proj, "AGENTS.md"), wrapped);
  const f = await checkHarnessSurfaces({}, proj, { home, root });
  assert.ok(f.some((x) => x.check === "surface" && /AGENTS\.md:3: .*does not close on its own line/.test(x.message)));
  const reg = bin(root, installEnv(home, root, proj), ["install", "--harness", SRC.id, "--surface", "agents_block", "--project", proj]);
  assert.notEqual(reg.status, 0, "install refuses");
  assert.equal(read(join(proj, "AGENTS.md")), wrapped, "never appends a second block");
  const un = bin(root, installEnv(home, root, proj), ["uninstall", "--harness", SRC.id, "--surface", "agents_block", "--project", proj]);
  assert.notEqual(un.status, 0, "uninstall refuses rather than reporting nothing to remove");
  assert.equal(read(join(proj, "AGENTS.md")), wrapped);
  // A hand-edited block: reported as content drift, replaced in place by register.
  const edited = BLOCK.replace("- **Report instruction conflicts", "- **Changed line\n- **Report instruction conflicts") + "\n";
  writeFileSync(join(proj, "AGENTS.md"), edited);
  const d = await checkHarnessSurfaces({}, proj, { home, root });
  assert.ok(d.some((x) => x.check === "surface" && /content differs/.test(x.message)));
  const fix = bin(root, installEnv(home, root, proj), ["install", "--harness", SRC.id, "--surface", "agents_block", "--project", proj]);
  assert.equal(fix.status, 0, fix.stderr + fix.stdout);
  assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n", "one block, the template's");
});

test("upgrade rollback (rewritten for the layout move): 0.28 cannot fill 0.27.1's template; forward moves the launcher; a 0.27.1 re-bind makes two bindings, which install and upgrade refuse and uninstall does not; forward again is a no-op", async () => {
  const { home, root } = install028();
  const { proj, launcher: legacyLauncher } = project027(home);
  const lp = layoutPaths(proj);
  assert.equal(renderStatusLineLauncher(TPL_027, root, proj), null, "the old template lacks the newer placeholders: a rollback is not papered over by re-rendering it");
  // Forward: the layout moves (planned whatever --surface names), the launcher is
  // stamped at its new path, the entry re-pointed, the legacy launcher removed.
  const env = noHostEnv();
  const fwd = plan(proj, { home, root, surfaces: ["statusline"], env });
  assert.equal(fwd.items[0].kind, "layout"); assert.equal(fwd.items[0].action, "migrate");
  const i0 = fwd.items.find((x) => x.surface === "statusline_launcher");
  assert.equal(i0.state, "stale"); assert.match(i0.reason, /plugin updated \(pre-provenance file\).*moving from/); assert.equal(i0.action, "create");
  apply(fwd, { env, home });
  const launcher = statusLineLauncherPath(proj);
  assert.ok(parseProvenance(read(launcher)));
  assert.ok(!existsSync(legacyLauncher), "the legacy launcher is gone once nothing names it");
  assert.ok(!existsSync(lp.legacy.binding) && existsSync(lp.binding));
  // Rollback below 0.28 is one-way: 0.27.1 reads .claude/projectstore.json, which is
  // gone, so it sees the project as unbound and writes no status line; the
  // version-free launcher keeps rendering from the registry. A 0.27.1 session that
  // re-binds writes the legacy file back — two bindings: install and upgrade
  // refuse, doctor names both, uninstall is not blocked.
  writeFileSync(lp.legacy.binding, JSON.stringify({ ...JSON.parse(read(lp.binding)), default_author: "someone-on-0.27.1" }, null, 2) + "\n");
  const both = plan(proj, { home, root, env });
  assert.equal(both.ok, false);
  const li = both.items.find((x) => x.surface === "layout");
  assert.equal(li.action, "refuse"); assert.match(li.reason, /two bindings/);
  assert.throws(() => apply(both, { env, home }));
  assert.equal(checkLayout(proj)[0].check, "layout-two-configs");
  assert.equal(plan(proj, { home, root, env, mode: "uninstall" }).ok, true, "uninstall proceeds");
  rmSync(lp.legacy.binding);
  // Forward again: nothing pending, the launcher current.
  const again = plan(proj, { home, root, surfaces: ["statusline"], env });
  assert.ok(!again.items.some((x) => x.kind === "layout"), "no layout item once the legacy files are gone");
  assert.equal(again.items.find((x) => x.surface === "statusline_launcher").action, "skip");
  assert.deepEqual(checkLayout(proj), []);
  // 0.28's disable path unlinks only a file that carries our header.
  writeFileSync(launcher, "console.log('theirs')\n");
  const cfg = JSON.parse(read(lp.binding));
  syncStatusLine({ ...cfg, statusline: { enabled: false } }, proj, home);
  assert.equal(read(launcher), "console.log('theirs')\n", "a foreign file at the launcher path survives disable");
});

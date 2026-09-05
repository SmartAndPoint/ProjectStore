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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sourceHarness } from "../scripts/harness.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import { renderStatusLineLauncher, statusLineLauncherPath, renderAgentsBlock, syncStatusLine, LAUNCHER_HEADER } from "../scripts/lib.mjs";
import { plan, apply } from "../scripts/install-harness.mjs";
import { checkHarnessSurfaces, checkPendingUpgrade, runStartupChecks } from "../scripts/doctor.mjs";
import { fakeInstall, writeRegistry, installEnv } from "./fixtures/install.mjs";
import { seedCliVault } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.project_config_dir;
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
  const cfgPath = join(proj, CFG_DIR, "projectstore.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(read(cfgPath)), statusline: { enabled: true } }, null, 2) + "\n");
  mkdirSync(join(proj, CFG_DIR, ".projectstore"), { recursive: true });
  const launcher = statusLineLauncherPath(proj);
  writeFileSync(launcher, render027(TPL_027, old));
  writeFileSync(join(proj, CFG_DIR, "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${launcher}"` } }, null, 2) + "\n");
  writeFileSync(join(proj, "AGENTS.md"), BLOCK + "\n");
  writeFileSync(join(proj, "CLAUDE.md"), "# My project\n\n@AGENTS.md\n");
  return { proj, vault, launcher, old };
}

function snapshot(proj, vault) {
  const files = [join(proj, CFG_DIR, "settings.local.json"), statusLineLauncherPath(proj), join(proj, "AGENTS.md"), join(proj, "CLAUDE.md"), join(vault, "kanban.md"), join(vault, "graph.md"), join(vault, "code-map.md")];
  return Object.fromEntries(files.filter(existsSync).map((f) => [f, read(f)]));
}

function install028() {
  const home = mkdtempSync(join(TMP, "ps-up-home-"));
  const root = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: root, version: VERSION, lastUpdated: new Date().toISOString() }]);
  return { home, root };
}

const bin = (root, env, args) => spawnSync(process.execPath, [join(root, "bin", "projectstore.mjs"), ...args], { encoding: "utf8", env, timeout: 90000, maxBuffer: 1 << 24 });
const INSTALL_FAMILY = ["surface", "surface-foreign", "version-drift", "harness", "mcp", "upgrade"];

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
  assert.deepEqual(snapshot(proj, vault), before, "settings, launcher, block and views are byte-identical after the first session");
  assert.ok(existsSync(join(vault, ".projectstore", "sessions", "up-1.json")) || readdirSync(join(vault, ".projectstore", "sessions")).length > 0, "the session marker is the write");

  // Doctor: the install family is exactly {surface issue, mcp info} plus the offer.
  const doc = bin(root, installEnv(home, root, proj), ["doctor", "--json", "--install", "--project", proj]);
  const findings = JSON.parse(doc.stdout).result;
  const fam = findings.filter((f) => INSTALL_FAMILY.includes(f.check)).map((f) => [f.check, f.level]).sort();
  assert.deepEqual(fam, [["mcp", "info"], ["surface", "issue"]], "the install family is exactly the stale launcher and the permanent mcp info");
  const stale = findings.find((f) => f.check === "surface");
  assert.match(stale.message, /plugin updated \(pre-provenance file\)/);
  assert.match(stale.message, /bin\/projectstore\.mjs" install --harness/);
  assert.deepEqual(checkPendingUpgrade(proj, home, root).map((f) => f.check), ["upgrade"]);
  // In-process, this repo is the root — a dev checkout — so the offer is correctly absent; the hook spawned from the install carried it (asserted above).
  assert.deepEqual(runStartupChecks(JSON.parse(read(join(proj, CFG_DIR, "projectstore.json"))), proj).offers, []);

  // One upgrade: the launcher is stamped with the install's version, nothing else moves.
  const up = bin(root, installEnv(home, root, proj), ["upgrade", "--harness", SRC.id, "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  const stamped = read(statusLineLauncherPath(proj));
  const prov = parseProvenance(stamped);
  assert.ok(prov, "stamped");
  assert.equal(prov.pkg, VERSION);
  assert.ok(stamped.includes(LAUNCHER_HEADER));
  const after = snapshot(proj, vault);
  for (const [f, text] of Object.entries(before)) if (f !== statusLineLauncherPath(proj)) assert.equal(after[f], text, `${f} untouched by upgrade`);
  const doc2 = JSON.parse(bin(root, installEnv(home, root, proj), ["doctor", "--json", "--install", "--project", proj]).stdout).result;
  assert.deepEqual(doc2.filter((f) => INSTALL_FAMILY.includes(f.check)).map((f) => [f.check, f.level]), [["mcp", "info"]], "clean but for the permanent mcp info");
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

test("upgrade rollback: 0.28 cannot fill 0.27.1's template, 0.27.1 overwrites the stamp on its first session, and one re-stamp clears it on the way forward", async () => {
  const { home, root } = install028();
  const { proj, launcher, old } = project027(home);
  assert.equal(renderStatusLineLauncher(TPL_027, root), null, "the old template lacks two placeholders: a rollback is not papered over by re-rendering it");
  // Forward: stamp.
  apply(plan(proj, { home, root, surfaces: ["statusline"] }));
  const stamped = read(launcher);
  assert.ok(parseProvenance(stamped));
  // Rollback: 0.27.1's writer rewrites whenever the bytes differ from its render — they do.
  const src027 = render027(TPL_027, old);
  assert.notEqual(stamped, src027, "0.27.1's `cur !== src` is true, so its first session overwrites the stamp");
  writeFileSync(launcher, src027);
  // Forward again: stale, one re-stamp.
  const p = plan(proj, { home, root, surfaces: ["statusline"] });
  const i = p.items.find((x) => x.surface === "statusline_launcher");
  assert.equal(i.state, "stale"); assert.match(i.reason, /plugin updated \(pre-provenance file\)/); assert.equal(i.action, "update");
  assert.equal((await checkHarnessSurfaces({}, proj, { home, root })).filter((x) => x.check === "surface").length, 1);
  apply(p);
  assert.ok(parseProvenance(read(launcher)));
  // 0.28's disable path unlinks only a file that carries our header; 0.27.1's unlinked unconditionally.
  writeFileSync(launcher, "console.log('theirs')\n");
  const cfg = JSON.parse(read(join(proj, CFG_DIR, "projectstore.json")));
  syncStatusLine({ ...cfg, statusline: { enabled: false } }, proj, home);
  assert.equal(read(launcher), "console.log('theirs')\n", "a foreign file at the launcher path survives disable");
});

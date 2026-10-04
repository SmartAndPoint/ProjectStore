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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { resolve, dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sourceHarness, loadHarness } from "../scripts/harness.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import { renderStatusLineLauncher, statusLineLauncherPath, renderAgentsBlock, syncStatusLine, LAUNCHER_HEADER, layoutPaths} from "../scripts/lib.mjs";
import { plan, apply } from "../scripts/install-harness.mjs";
import { checkHarnessSurfaces, checkPendingUpgrade, runStartupChecks, checkLayout, checkAgentsBlock, foldIntoMove } from "../scripts/doctor.mjs";
import { fakeInstall, writeRegistry, installEnv, noHostEnv, fakeClaude, legacyProject } from "./fixtures/install.mjs";
import { seedCliVault } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TPL_027 = readFileSync(join(ROOT, "tests", "fixtures", "statusline-launcher-0.27.1.txt"), "utf8");
const TEMPLATE = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
const BLOCK = renderAgentsBlock(TEMPLATE, null);
const read = (p) => readFileSync(p, "utf8");
// The fake home is a real path: isPluginCacheRoot compares the bin's own root
// (realpath'd by ESM) with <home>/plugins/cache as given first, then as real
// paths; on macOS tmpdir() is /var/… while its realpath is /private/var/…, and
// a real-path home keeps these tests on the first, cheaper comparison.
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
  // One step (the layout spec, contract 7 as amended 2026-10-03): the move
  // re-stamps the launcher, so the line does not also offer `doctor --fix`;
  // and the move runs this copy's own bin, because the copy came from the git
  // marketplace (contract 12, amended the same day).
  const ownBin = `node "${join(root, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj}"`;
  assert.match(sys, /layout moved to \.projectstore\//, "the startup line names the layout move (the layout ADR, 2026-09-06)");
  assert.ok(sys.includes(ownBin), "in the copy's own channel: " + sys);
  assert.match(sys, /The same run re-stamps the status line launcher\./, "and says it covers the re-stamp");
  assert.doesNotMatch(sys, /doctor --fix/, "not a second step");
  assert.doesNotMatch(sys, /npx /, "not the shell, which would switch the channel");
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
  // The command the line named, with a host CLI on PATH that logs every call:
  // the move calls none, so the checkout keeps its channel.
  const host = fakeClaude(mkdtempSync(join(TMP, "ps-up-host-")));
  const settingsBefore = JSON.parse(read(join(proj, CFG_DIR, "settings.local.json")));
  const up = bin(root, installEnv(home, root, proj, { PATH: [host.dir, dirname(process.execPath)].join(delimiter) }), ["upgrade", "--harness", SRC.id, "--no-register", "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.deepEqual(host.log(), [], "the move calls no host command");
  const settingsAfter = JSON.parse(read(join(proj, CFG_DIR, "settings.local.json")));
  assert.deepEqual(settingsAfter.enabledPlugins, settingsBefore.enabledPlugins, "no plugin is enabled or silenced for the checkout");
  assert.deepEqual(settingsAfter.extraKnownMarketplaces, settingsBefore.extraKnownMarketplaces, "and no marketplace is added");
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

// The layout remedy's own-bin form carries --no-register, so "no host command"
// holds by construction, not by recognising the root: from a checkout the plan
// has a registration row, and with a host CLI on PATH the run without the flag
// registers the npm copy and silences the git one (the critic of the layout
// spec's 2026-10-03 amendment). With the flag, no row and no call.
test("upgrade --no-register: from a checkout root the plan has no registration row and the run calls no host command", () => {
  const home = mkdtempSync(join(TMP, "ps-up-noreg-"));
  const { proj } = legacyProject(home);
  const host = fakeClaude(mkdtempSync(join(TMP, "ps-up-noreg-host-")));
  const env = { ...host.env(), HOME: home, [SRC.runtime.home_env]: join(home, SRC.runtime.home_default) };
  const p = plan(proj, { home, root: ROOT, env, register: false });
  assert.ok(!p.items.some((i) => i.kind === "registration"), "no registration row");
  assert.ok(p.items.some((i) => i.surface === "layout"), "the move is still planned");
  const run = spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), "upgrade", "--harness", SRC.id, "--no-register", "--project", proj], { encoding: "utf8", env, timeout: 90000 });
  assert.deepEqual(host.log(), [], "no host command: " + run.stdout + run.stderr);
  const settings = JSON.parse(readFileSync(join(proj, CFG_DIR, "settings.local.json"), "utf8"));
  assert.ok(!settings.enabledPlugins && !settings.extraKnownMarketplaces, "the checkout's channel is untouched");
  assert.ok(existsSync(layoutPaths(proj).binding), "the binding moved");
  // The control: the same plan without the flag carries the registration.
  assert.ok(plan(proj, { home, root: ROOT, env }).items.some((i) => i.kind === "registration"), "without --no-register a checkout plans the registration");
});

// The re-stamp offer is for a launcher our entry runs. Under a foreign status
// line the install leaves the slot alone, so the offer could never clear.
test("upgrade: the re-stamp offer needs our status-line entry — under a foreign one there is nothing to offer", () => {
  const { home, root } = install028();
  const { proj } = project027(home);
  assert.deepEqual(checkPendingUpgrade(proj, home, root).map((f) => f.check), ["upgrade"], "our entry: offered");
  const sp = join(proj, CFG_DIR, "settings.local.json");
  const s = JSON.parse(readFileSync(sp, "utf8"));
  writeFileSync(sp, JSON.stringify({ ...s, statusLine: { type: "command", command: "node /opt/someone-else/statusline.js" } }, null, 2) + "\n");
  assert.deepEqual(checkPendingUpgrade(proj, home, root), [], "a foreign entry: not offered");
  // The session's line, through the real hook from the cache root: the layout
  // offer is there, without the re-stamp clause.
  const hook = spawnSync(process.execPath, [join(root, "hooks", "session-start.mjs")], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "fs-1", source: "startup", cwd: proj }), env: installEnv(home, root, proj), cwd: proj, timeout: 30000 });
  const said = hook.stdout.trim() ? JSON.parse(hook.stdout).systemMessage || "" : "";
  assert.match(said, /layout moved to \.projectstore\//, said);
  assert.doesNotMatch(said, /re-stamps the status line launcher/, "no re-stamp is promised under a foreign slot");
  // And the move clears the legacy layout under that foreign slot. The slot
  // runs no launcher of ours, so no new one is made — and the cleanup used to
  // keep the old one for want of it, which kept layout-legacy alive forever
  // (the critic of the layout spec's 2026-10-03 amendment, case S1).
  const lp = layoutPaths(proj);
  assert.ok(existsSync(lp.legacy.launcher), "the legacy launcher is there to clean up");
  const up = bin(root, installEnv(home, root, proj), ["upgrade", "--harness", SRC.id, "--no-register", "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.ok(!existsSync(lp.legacy.launcher), "a launcher no slot runs goes with the move");
  assert.deepEqual(checkLayout(proj, undefined, { root, home }), [], "and the layout offer clears");
  assert.equal(JSON.parse(readFileSync(sp, "utf8")).statusLine.command, "node /opt/someone-else/statusline.js", "the foreign slot is untouched");
});

// The same under an EMPTY slot: the status line is off, nothing names the
// legacy launcher, and the move clears the legacy layout without making one.
test("upgrade: under an empty status-line slot (the status line is off) the move clears the legacy layout without making a launcher", () => {
  const { home, root } = install028();
  const { proj } = project027(home);
  const sp = join(proj, CFG_DIR, "settings.local.json");
  const { statusLine, ...rest } = JSON.parse(readFileSync(sp, "utf8"));
  writeFileSync(sp, JSON.stringify(rest, null, 2) + "\n");
  const lp = layoutPaths(proj);
  const cfg = JSON.parse(readFileSync(lp.legacy.binding, "utf8"));
  writeFileSync(lp.legacy.binding, JSON.stringify({ ...cfg, statusline: { enabled: false } }, null, 2) + "\n");
  assert.ok(existsSync(lp.legacy.launcher));
  const up = bin(root, installEnv(home, root, proj), ["upgrade", "--harness", SRC.id, "--no-register", "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.ok(!existsSync(lp.legacy.launcher), "a launcher no slot runs goes with the move");
  assert.ok(!existsSync(statusLineLauncherPath(proj)), "and none is made: the status line is off");
  assert.equal(JSON.parse(readFileSync(sp, "utf8")).statusLine, undefined, "the slot stays empty");
  assert.deepEqual(checkLayout(proj, undefined, { root, home }), [], "and the layout offer clears");
});

// The blocker of the third review: a legacy launcher the status line still runs
// must survive the move whatever spells its path — a symlinked parent here —
// and wherever the entry lives (the committed settings, the status line off).
test("upgrade: a legacy launcher still run by any settings file survives the move, however its path is spelled", () => {
  const { home, root } = install028();
  const { proj } = project027(home);
  const lp = layoutPaths(proj);
  const sp = join(proj, CFG_DIR, "settings.local.json");
  const link = join(mkdtempSync(join(TMP, "ps-up-link-")), "p");
  symlinkSync(proj, link);
  const s0 = JSON.parse(readFileSync(sp, "utf8"));
  writeFileSync(sp, JSON.stringify({ ...s0, statusLine: { type: "command", command: `node "${join(link, CFG_DIR, ".projectstore", "statusline.mjs")}"` } }, null, 2) + "\n");
  const up = bin(root, installEnv(home, root, proj), ["upgrade", "--harness", SRC.id, "--no-register", "--json", "--project", proj]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.ok(existsSync(lp.legacy.launcher), "spelled through a symlink, it is still the file the status line runs");
  assert.match(up.stdout, /still runs it as the status line/, "the run says why it kept the launcher");
  // The committed settings, the local slot empty and the status line off.
  const { home: h2, root: r2 } = install028();
  const { proj: p2 } = project027(h2);
  const lp2 = layoutPaths(p2);
  const sp2 = join(p2, CFG_DIR, "settings.local.json");
  const { statusLine, ...rest } = JSON.parse(readFileSync(sp2, "utf8"));
  writeFileSync(sp2, JSON.stringify(rest, null, 2) + "\n");
  writeFileSync(join(p2, CFG_DIR, "settings.json"), JSON.stringify({ statusLine }, null, 2) + "\n");
  const cfg = JSON.parse(readFileSync(lp2.legacy.binding, "utf8"));
  writeFileSync(lp2.legacy.binding, JSON.stringify({ ...cfg, statusline: { enabled: false } }, null, 2) + "\n");
  const up2 = bin(r2, installEnv(h2, r2, p2), ["upgrade", "--harness", SRC.id, "--no-register", "--project", p2]);
  assert.equal(up2.status, 0, up2.stderr + up2.stdout);
  assert.ok(existsSync(lp2.legacy.launcher), "named by the committed settings, it is still in use");
});

// O1, decided 2026-10-03: while the move is pending, the findings the move
// itself repairs fold into it instead of being counted beside it (the layout
// spec, contract 7 as amended after the rc.3 tag) — the stale block, and the
// block's invisibility to the layout's harness. Nothing else folds. The env
// is explicit: a Bash tool in a Claude Code session carries CLAUDECODE, CI
// does not, and the invisibility finding's level depends on it.
test("upgrade O1: while the move is pending, the v3 block and Claude Code's view of the block fold into the move; a broken block and another harness's view stay counted", () => {
  const { home, root } = install028();
  const { proj } = project027(home);
  const lp = layoutPaths(proj);
  const V3 = BLOCK.replace(/projectstore:agents v\d+/, "projectstore:agents v3");
  writeFileSync(join(proj, "AGENTS.md"), V3 + "\n");
  // The startup line: the v3 block is not counted beside the move, and says the move repairs it.
  const st = runStartupChecks(JSON.parse(read(lp.legacy.binding)), proj);
  const v3 = st.findings.find((f) => /is v3, expected v4/.test(f.message));
  assert.ok(v3 && v3.level === "info" && /layout move repairs this/.test(v3.message), JSON.stringify(v3));
  assert.ok(!st.findings.some((f) => f.check === "agents-block" && f.level === "issue"), "nothing of the block's is counted");
  assert.equal(st.offers.filter((o) => /layout moved to \.projectstore\//.test(o)).length, 1);
  const pending = (env) => foldIntoMove([...checkAgentsBlock(proj, { env }), ...checkLayout(proj, undefined, { root, home })]);
  const settled = (env) => foldIntoMove(checkAgentsBlock(proj, { env }));
  // With no move pending, the same block counts.
  assert.equal(settled({}).find((f) => /is v3/.test(f.message)).level, "issue");
  // An AGENTS.md-only project in a Claude Code session: Claude Code's view folds too.
  writeFileSync(join(proj, "AGENTS.md"), BLOCK + "\n");
  rmSync(join(proj, "CLAUDE.md"));
  const session = { [SRC.runtime.session_env[0]]: "1" };
  const unseen = pending(session).find((f) => /Claude Code does not see/.test(f.message));
  assert.ok(unseen && unseen.level === "info" && /layout move repairs this/.test(unseen.message), JSON.stringify(unseen));
  assert.equal(settled(session).find((f) => /Claude Code does not see/.test(f.message)).level, "issue", "and counts once the move is done");
  // The fold's tag is internal: no finding leaves carrying it, folded or not.
  assert.ok([...pending(session), ...settled(session)].every((f) => !("byMove" in f)));
  // Another harness's view is not the move's to repair: Codex, identified, with the block where it cannot read it.
  writeFileSync(join(proj, "CLAUDE.md"), BLOCK + "\n");
  rmSync(join(proj, "AGENTS.md"));
  const kept = (f, level) => f && f.level === level && !/layout move repairs this/.test(f.message);
  const codex = pending({ [loadHarness("codex").runtime.plugin_root_env]: "/x" }).find((f) => /Codex does not see/.test(f.message));
  assert.ok(kept(codex, "issue"), JSON.stringify(codex));
  // A block twice in one file, one that never closes, or a wrapped marker makes
  // the agents-block plan refuse — the move itself: counted, with its own remedy,
  // and its stale version is not the move's to repair either.
  writeFileSync(join(proj, "CLAUDE.md"), V3 + "\n\n" + V3 + "\n");
  const twice = pending({});
  assert.ok(kept(twice.find((f) => /times — keep exactly one/.test(f.message)), "issue"), JSON.stringify(twice));
  assert.ok(twice.filter((f) => /is v3/.test(f.message)).every((f) => kept(f, "issue")), JSON.stringify(twice));
  // Unclosed, in the file Claude Code reaches only through an import it lacks.
  rmSync(join(proj, "CLAUDE.md"));
  writeFileSync(join(proj, "AGENTS.md"), "<!-- projectstore:agents v3 -->\n## half a block\n");
  const unclosed = pending(session);
  assert.ok(kept(unclosed.find((f) => /is v3/.test(f.message)), "issue"), JSON.stringify(unclosed));
  assert.ok(!unclosed.some((f) => /does not see/.test(f.message)), "no view of a block the plan refuses");
  rmSync(join(proj, "AGENTS.md"));
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n<!-- projectstore:agents v3 (managed)\n-->\n" + V3.split("\n").slice(1).join("\n") + "\n");
  assert.ok(kept(pending({}).find((f) => /does not close on its own line/.test(f.message)), "issue"));
  // A block in both files is a warning the move clears: never counted, never folded.
  writeFileSync(join(proj, "CLAUDE.md"), BLOCK + "\n");
  writeFileSync(join(proj, "AGENTS.md"), BLOCK + "\n");
  assert.ok(kept(pending({}).find((f) => /in both CLAUDE\.md and AGENTS\.md/.test(f.message)), "warn"));
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

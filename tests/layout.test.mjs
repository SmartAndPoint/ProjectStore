// projectstore — the project-level layout (PS-HARNESS: "The project-level
// layout moves to .projectstore/: paths, readers with fallback, the migration,
// doctor"; the layout ADR; layout spec contracts 0–1, 5–9, 13).
//
// Every case runs in a temporary project built in the exact pre-0.28 shape by
// tests/fixtures/install.mjs legacyProject(), against a temporary home holding
// a fake cache install of this version — never in the repository. The
// resolver-only grep and the sunset assertion read the source tree itself.
//
//   node --test tests/layout.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, symlinkSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fakeInstall, cacheRoot, writeRegistry, installEnv, noHostEnv, legacyProject, preFlagInstall } from "./fixtures/install.mjs";
import { seedCliVault, writeBinding } from "./fixtures/vault.mjs";
import { plan, apply, renderPreview, runVerb, publicItem } from "../scripts/install-harness.mjs";
import { analyseLayout } from "../scripts/surfaces.mjs";
import { sourceHarness, loadHarness, LAYOUT, layoutPaths, pickExisting, RUNTIME_GITIGNORE_HEADER } from "../scripts/harness.mjs";
import { checkLayout, checkGitignore, runStartupChecks, runInstallChecks, layoutRemedy, takesNoRegister } from "../scripts/doctor.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import {
  readConfigAt, readSessionState, readEntryLog, appendEntryLog, statusLineIsOurWiring, statusLineIsOurs, statusLineLauncherPath,
  legacyStatusLineLauncherPath, renderStatusLineLauncher, ensureRuntimeDir, ensureStateDir, ensureSessionsDir, cmpVersion, stateDir, sessionStatePath, entryLogPath,
  installChannel,
} from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TPL = readFileSync(join(ROOT, "scripts", "statusline-launcher.mjs"), "utf8");
const TPL_027 = readFileSync(join(ROOT, "tests", "fixtures", "statusline-launcher-0.27.1.txt"), "utf8");
const TMP = realpathSync(tmpdir());
const read = (p) => readFileSync(p, "utf8");
delete process.env[SRC.runtime.home_env];

function home028() {
  const home = mkdtempSync(join(TMP, "ps-layout-home-"));
  const root = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: root, version: VERSION, lastUpdated: new Date().toISOString() }]);
  return { home, root };
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("layout contract 0: the project-side paths are spelled once — in the resolver — and the manifests name no config directory of ours", () => {
  const files = [];
  for (const d of ["scripts", "hooks", "bin"]) for (const n of readdirSync(join(ROOT, d))) if (n.endsWith(".mjs")) files.push(join(d, n));
  const hits = [];
  for (const rel of files) {
    const src = stripComments(read(join(ROOT, rel)));
    for (const lit of ['".projectstore"', '".claude", ".projectstore"', '".projectstore-welcomed"', '".projectstore-session-id"', '"projectstore.json"']) {
      if (src.includes(lit) && rel !== "scripts/harness.mjs") hits.push(`${rel}: ${lit}`);
    }
  }
  assert.deepEqual(hits, [], "every project-side path goes through layoutPaths()");
  for (const n of readdirSync(join(ROOT, "harnesses")).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(read(join(ROOT, "harnesses", n)));
    assert.equal(m.runtime.config_basename, undefined, `${n}: no config_basename`);
    assert.equal(m.runtime.project_config_dir, undefined, `${n}: project_config_dir was renamed harness_dir`);
    assert.equal(typeof m.runtime.harness_dir, "string", `${n}: harness_dir (detection, the harness's own settings)`);
  }
  const p = layoutPaths("/p");
  assert.equal(p.binding, "/p/.projectstore/projectstore.json");
  assert.equal(p.overlay("codex"), "/p/.projectstore/harness/codex.json");
  assert.equal(p.launcher("claude-code"), "/p/.projectstore/state/claude-code/statusline.mjs");
  assert.equal(p.legacy.binding, `/p/${SRC.runtime.harness_dir}/projectstore.json`);
  assert.equal(p.legacy.launcher, `/p/${SRC.runtime.harness_dir}/.projectstore/statusline.mjs`);
  assert.deepEqual([...LAYOUT.gitignore], ["projectstore.json", "state/"]);
});

test("layout contract 1: a pre-0.28 project reads bound, its state and log are found, and both launcher shapes are ours — before any migration", () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  assert.equal(readConfigAt(proj).statusline.enabled, true, "the binding is read from the legacy path");
  assert.equal(readSessionState(proj, "s1").active_story, "story-a");
  assert.equal(readEntryLog(proj, { withinDays: 36500 }).length, 2);
  assert.equal(pickExisting(lp.binding, lp.legacy.binding), lp.legacy.binding);
  const cmd = JSON.parse(read(join(proj, SRC.runtime.harness_dir, "settings.local.json"))).statusLine.command;
  assert.ok(statusLineIsOurWiring(cmd, proj, home, root), "the legacy launcher entry is ours (never `theirs`)");
  assert.ok(statusLineIsOurs(cmd) && statusLineIsOurs(`node "${statusLineLauncherPath(proj)}"`), "both launcher shapes");
  assert.equal(statusLineLauncherPath(proj), lp.launcher(SRC.id), "the writer's path is the new one");
  assert.equal(legacyStatusLineLauncherPath(proj), lp.legacy.launcher);
  // The writer's paths are the new ones; a new session file lands in state/sessions.
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: "s9", score: 1 });
  assert.ok(existsSync(entryLogPath(proj)) && existsSync(lp.stateGitignore));
  assert.equal(readEntryLog(proj, { withinDays: 36500 }).length, 1, "the reader follows the new log once it exists (the migration merges the legacy one)");
  const a = analyseLayout(proj, { harness: SRC });
  assert.equal(a.state, "legacy"); assert.equal(a.pending, true); assert.equal(a.legacy.runtimeOurs, true);
});

test("layout contract 6: one ordered `layout` item first, the launcher created at its new path, the entry re-pointed, the cleanup last; idempotent", () => {
  const { home, root } = home028();
  const { proj, lp, vault } = legacyProject(home);
  const env = noHostEnv();
  const p = plan(proj, { home, root, env });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  const first = p.items[0];
  assert.equal(first.kind, "layout"); assert.equal(first.surface, "layout"); assert.equal(first.action, "migrate");
  assert.deepEqual(first.steps.map((s) => s.kind), ["note", "ensure", "move-state", "merge-log", "move-marker", "delete", "move-binding"], "the binding moves last; the note says to close other sessions");
  const last = p.items[p.items.length - 1];
  assert.equal(last.surface, "layout_cleanup"); assert.equal(last.action, "cleanup");
  assert.deepEqual(last.steps.map((s) => s.kind), ["remove-legacy-launcher", "rmdir-legacy"]);
  // "Kept" means a settings file still runs it, not a script that calls it.
  assert.match(last.steps[0].why, /runs it as the status line/);
  assert.match(last.steps[0].why, /indirectly is not seen/);
  const launcher = p.items.find((i) => i.surface === "statusline_launcher");
  assert.equal(launcher.action, "create"); assert.equal(launcher.path, lp.launcher(SRC.id)); assert.match(launcher.reason, /moving from/);
  assert.equal(p.items.find((i) => i.surface === "statusline").action, "replace-entry", "the entry is re-pointed at the new launcher");
  const block = p.items.find((i) => i.surface === "agents_block");
  assert.equal(block.action, "replace-entry"); assert.match(block.reason, /v3 → v4/, "the block template's config path moved with the layout");
  const preview = renderPreview(p);
  for (const s of first.steps) if (s.path || s.from) assert.ok(preview.includes(s.path ? s.path.split("/").pop() : s.from.split("/").pop()), `preview names ${s.kind}`);
  // The JSON envelope is the same preview: every migration step keeps where it
  // moves from and to (S1 of the 2026-10-03 review — a public envelope that
  // stripped `from` from every step hid the source of the move it describes).
  const pub = publicItem(first);
  for (const s of first.steps.filter((x) => "from" in x)) {
    const ps = pub.steps.find((x) => x.kind === s.kind);
    assert.equal(ps.from, s.from, `${s.kind} keeps from`); assert.equal(ps.to, s.to, `${s.kind} keeps to`);
  }
  assert.equal(pub.steps.find((x) => x.kind === "move-state").files, first.steps.find((x) => x.kind === "move-state").files, "and the moved-file count");
  assert.ok(preview.includes("layout") && preview.includes("agents → "));
  // Nothing moved by plan.
  assert.ok(existsSync(lp.legacy.binding) && !existsSync(lp.root));

  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done, null, 1));
  // The new layout, complete.
  const binding = JSON.parse(read(lp.binding));
  assert.equal(binding.agents, undefined, "the binding carries no agents block");
  assert.equal(binding.vault_path, vault);
  assert.deepEqual(JSON.parse(read(lp.overlay(SRC.id))).agents, { default: { model: "sonnet" }, per_agent: { critic: { model: "opus" } } }, "the agents block became the harness's overlay");
  assert.ok(existsSync(sessionStatePath(proj, "s1")) && existsSync(join(stateDir(proj), "s1.paths", "a.mjs")) && existsSync(join(stateDir(proj), ".last-render.json")));
  assert.equal(read(entryLogPath(proj)).trim().split("\n").length, 2);
  assert.ok(read(lp.gitignore).includes("projectstore.json") && read(lp.gitignore).includes("state/"));
  assert.ok(read(lp.stateGitignore).includes(RUNTIME_GITIGNORE_HEADER));
  const stamped = read(lp.launcher(SRC.id));
  assert.ok(parseProvenance(stamped) && stamped.includes(JSON.stringify(proj)), "the new launcher is stamped and names its project");
  const settings = JSON.parse(read(join(proj, SRC.runtime.harness_dir, "settings.local.json")));
  assert.equal(settings.statusLine.command, `node "${lp.launcher(SRC.id)}"`);
  assert.equal(settings.other.keep, true, "sibling keys survive");
  assert.match(read(join(proj, "AGENTS.md")), /projectstore:agents v4 /);
  // .claude/ holds only the host's file.
  assert.deepEqual(readdirSync(join(proj, SRC.runtime.harness_dir)).sort(), ["settings.local.json"]);
  assert.ok(!existsSync(lp.legacy.launcher) && !existsSync(lp.legacy.runtime) && !existsSync(lp.legacy.welcomed) && !existsSync(lp.legacy.sessionId));
  assert.ok(existsSync(lp.welcomed(SRC.id)), "the welcome marker moved: a migrated project is not welcomed again");
  // Idempotent: no layout item, launcher and entry current.
  const again = plan(proj, { home, root, env });
  assert.ok(!again.items.some((i) => i.kind === "layout"));
  assert.equal(again.items.find((i) => i.surface === "statusline_launcher").action, "skip");
  assert.equal(again.items.find((i) => i.surface === "statusline").action, "skip");
  assert.deepEqual(checkLayout(proj), []);
});

test("layout contract 6: state on both sides is the normal case — a newer legacy session file wins, a per-session directory keeps the new side, the logs merge legacy-first; a half-run resumes at the pending step", () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  const env = noHostEnv();
  // The first 0.28 session already wrote the new state before the user ran upgrade.
  ensureStateDir(proj);
  writeFileSync(sessionStatePath(proj, "s1"), JSON.stringify({ session_id: "s1", active_story: "story-new" }));
  const past = new Date(Date.now() - 3600_000);
  utimesSync(sessionStatePath(proj, "s1"), past, past); // the legacy s1.json is newer
  writeFileSync(sessionStatePath(proj, "s2"), JSON.stringify({ session_id: "s2" }));
  mkdirSync(join(stateDir(proj), "s1.paths"), { recursive: true });
  writeFileSync(join(stateDir(proj), "s1.paths", "new.mjs"), "");
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: "s2", score: 2 });
  apply(plan(proj, { home, root, env }), { env, home });
  assert.equal(JSON.parse(read(sessionStatePath(proj, "s1"))).active_story, "story-a", "the newer (legacy) session file won");
  assert.ok(existsSync(sessionStatePath(proj, "s2")));
  assert.deepEqual(readdirSync(join(stateDir(proj), "s1.paths")), ["new.mjs"], "a per-session directory keeps the new side");
  const lines = read(entryLogPath(proj)).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3); assert.equal(lines[0].at, "2026-09-01T00:00:00Z"); assert.equal(lines[2].session_id, "s2");
  // Half-run: the binding moved back to legacy by hand (a rollback re-bind) is one refusal; a partial state move resumes.
  const { proj: p2, lp: lp2 } = legacyProject(home);
  rmSync(lp2.legacy.state, { recursive: true, force: true }); rmSync(lp2.legacy.entryLog); rmSync(lp2.legacy.welcomed);
  const partial = plan(p2, { home, root, env });
  assert.deepEqual(partial.items[0].steps.map((s) => s.kind), ["note", "ensure", "delete", "move-binding"], "only the pending steps");
});

test("layout contract 6/7: two bindings is the one refusal — install and upgrade refuse byte-identical, uninstall proceeds and removes the legacy state; doctor names both", async () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  const env = noHostEnv();
  writeBinding(proj, JSON.parse(read(lp.legacy.binding)));
  const before = { legacy: read(lp.legacy.binding), current: read(lp.binding), launcher: read(lp.legacy.launcher) };
  const previews = [];
  for (const verb of ["install", "upgrade"]) {
    const r = await runVerb(verb, proj, { home, root, env, harnesses: [SRC.id] });
    assert.equal(r.plan.ok, false); const li = r.plan.items.find((i) => i.surface === "layout");
    assert.equal(li.action, "refuse"); assert.match(li.reason, /two bindings/);
    assert.deepEqual(r.applied, []);
    previews.push(r.preview);
  }
  assert.equal(previews[0], previews[1], "install and upgrade refuse with the same preview");
  assert.equal(read(lp.legacy.binding), before.legacy); assert.equal(read(lp.binding), before.current); assert.equal(read(lp.legacy.launcher), before.launcher);
  const f = checkLayout(proj);
  assert.equal(f.length, 1); assert.equal(f[0].check, "layout-two-configs"); assert.equal(f[0].level, "issue");
  const un = plan(proj, { home, root, env, mode: "uninstall" });
  assert.equal(un.ok, true, "uninstall is never blocked by the layout");
  const cleanup = un.items.find((i) => i.surface === "layout_cleanup");
  assert.equal(cleanup.action, "remove"); assert.deepEqual(cleanup.steps.map((s) => s.kind), ["remove-legacy-runtime", "note"], "and the preview says what stays");
  apply(un, { env, home });
  assert.ok(!existsSync(lp.legacy.runtime), "the legacy state directory (ours, by its header) is gone");
  assert.ok(existsSync(lp.legacy.binding), "the legacy binding is bind's, never uninstall's");
});

test("layout contract 6: the layout item is planned whatever --surface names, and an interrupted binding move resumes instead of refusing", () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  const env = noHostEnv();
  const narrowed = plan(proj, { home, root, env, surfaces: ["agents_block"] });
  assert.equal(narrowed.items[0].kind, "layout", "--surface never narrows the migration out");
  assert.ok(narrowed.items.some((i) => i.surface === "layout_cleanup"));
  assert.match(renderPreview(narrowed), /close other .* sessions in this project first/);
  apply(narrowed, { env, home });
  assert.ok(existsSync(lp.binding) && !existsSync(lp.legacy.binding));
  assert.ok(existsSync(lp.legacy.launcher), "no launcher item ran, so the legacy launcher stays until one does");
  // An interrupted binding move: the new file written, the legacy not yet removed → resumes with one delete.
  const { proj: p2, lp: lp2 } = legacyProject(home);
  const cfg = JSON.parse(read(lp2.legacy.binding)); const { agents, ...rest } = cfg;
  writeBinding(p2, rest);
  const resumed = plan(p2, { home, root, env });
  assert.equal(resumed.ok, true, "byte-equal but for agents is a resume, not a refusal");
  assert.ok(resumed.items[0].steps.some((s) => s.kind === "delete" && s.path === lp2.legacy.binding));
  assert.deepEqual(checkLayout(p2).map((f) => f.check), ["layout-legacy"], "doctor reports the pending move, not two configs");
  // A different new binding is still the refusal.
  writeBinding(p2, { ...rest, vault_path: "/elsewhere" });
  assert.equal(plan(p2, { home, root, env }).ok, false);
});

test("layout contract 7 / 12: doctor's layout-legacy names the upgrade in the channel of the copy the project runs, and the startup line offers it; inside a live session the migration is deferred", () => {
  const { home, root } = home028(); // a git-marketplace cache copy, enabled for the project in the registry
  const { proj, lp } = legacyProject(home);
  const ownBin = (r) => `node "${join(r, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj}"`;
  const shell = /npx projectstore-claude@[^ ]+ upgrade --no-register --project/; // both forms leave the registration alone
  // A git-marketplace copy runs its own bin, registration left out: the shell
  // would register the npm copy here and turn this one off (contract 12,
  // amended 2026-10-03).
  const f = checkLayout(proj, undefined, { root, home });
  assert.equal(f.length, 1); assert.equal(f[0].check, "layout-legacy"); assert.equal(f[0].level, "warn");
  assert.ok(f[0].message.includes(ownBin(root)), f[0].message); assert.doesNotMatch(f[0].message, /npx /); assert.match(f[0].message, /through 0\.29/);
  // The package's own registration: the shell form (A13).
  const npm = fakeInstall(home, VERSION, { marketplace: SRC.surfaces.plugin.marketplace_name });
  assert.match(checkLayout(proj, undefined, { root: npm, home })[0].message, shell);
  // Not a host copy — a terminal npx run, a checkout: the copy the project has
  // enabled decides, so a git-marketplace project is never told to run the shell.
  const npx = join(home, ".npm", "_npx", "x", "node_modules", "projectstore");
  assert.ok(checkLayout(proj, undefined, { root: npx, home })[0].message.includes(ownBin(root)), "a terminal npx doctor names the enabled git copy");
  assert.ok(checkLayout(proj, undefined, { root: ROOT, home })[0].message.includes(ownBin(root)), "a checkout names the enabled git copy too");
  // With nothing enabled: a package root takes the shell, a checkout its own bin.
  const bare = mkdtempSync(join(TMP, "ps-layout-bare-"));
  const { proj: proj2 } = legacyProject(bare);
  assert.match(checkLayout(proj2, undefined, { root: npx, home: bare })[0].message, shell);
  assert.ok(checkLayout(proj2, undefined, { root: ROOT, home: bare })[0].message.includes(`node "${join(ROOT, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj2}"`));
  // A local-scope row that belongs to ANOTHER checkout never counts, however
  // new: the machine this was measured on held five such npm rows beside one
  // user-scope git row (the critic of the amendment, finding 1).
  const other = fakeInstall(bare, VERSION, { marketplace: SRC.surfaces.plugin.marketplace_name });
  const gitBare = fakeInstall(bare, "0.28.0-git", { full: true });
  writeRegistry(bare, [
    { scope: "user", installPath: gitBare, version: "0.28.0-git", lastUpdated: "2026-09-07T00:00:00.000Z" },
    { scope: "local", projectPath: join(bare, "some-other-checkout"), installPath: other, version: VERSION, lastUpdated: "2026-09-29T00:00:00.000Z" },
  ]);
  assert.ok(checkLayout(proj2, undefined, { root: npx, home: bare })[0].message.includes(`node "${join(gitBare, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj2}"`), "another checkout's newer npm row is ignored");
  // A copy that predates the move (0.27.x ships no bin) cannot run it.
  const old = cacheRoot(bare, "0.27.1");
  mkdirSync(join(old, "scripts"), { recursive: true }); writeFileSync(join(old, "scripts", "statusline.mjs"), "");
  writeRegistry(bare, [{ scope: "user", installPath: old, version: "0.27.1", lastUpdated: "2026-09-08T00:00:00.000Z" }]);
  const stale = checkLayout(proj2, undefined, { root: npx, home: bare })[0].message;
  assert.match(stale, /\(0\.27\.1\) predates the move/); assert.doesNotMatch(stale, /npx |node "/, "no command a pre-move copy cannot run");
  const st = runStartupChecks(JSON.parse(read(lp.legacy.binding)), proj);
  assert.ok(st.offers.some((o) => /layout moved to \.projectstore\//.test(o)), "the startup line carries the offer");
  const marker = (SRC.runtime.session_env || [])[0];
  const inSession = plan(proj, { home, root, env: noHostEnv({ [marker]: "1" }) });
  const li = inSession.items.find((i) => i.surface === "layout");
  assert.equal(li.action, "skip"); assert.equal(li.deferred, true); assert.match(li.reason, /outside the session/);
  assert.equal(inSession.incomplete, true);
  assert.ok(!inSession.items.some((i) => i.surface === "layout_cleanup"), "no cleanup without the migration");
});

// The layout remedy's registry branch, cell by cell (the second review of the
// 2026-10-03 fixes found each of these reversible without a test failing).
test("layout contract 12: the copy a terminal or checkout run names is this project's newest present enabled copy that can run the move", () => {
  const home = mkdtempSync(join(TMP, "ps-layout-reg-"));
  const { proj } = legacyProject(home);
  const npx = join(home, ".npm", "_npx", "x", "node_modules", "projectstore");
  const ownBin = (r) => `node "${join(r, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj}"`;
  const msg = () => checkLayout(proj, undefined, { root: npx, home })[0].message;
  const gitA = fakeInstall(home, "0.28.0-a", { full: true });
  const gitB = fakeInstall(home, "0.28.0-b", { full: true });
  // The newest wins.
  writeRegistry(home, [
    { scope: "user", installPath: gitA, version: "0.28.0-a", lastUpdated: "2026-09-01T00:00:00.000Z" },
    { scope: "user", installPath: gitB, version: "0.28.0-b", lastUpdated: "2026-09-02T00:00:00.000Z" },
  ]);
  assert.ok(msg().includes(ownBin(gitB)), "the newest copy");
  // This project's own row beats a newer user-scope one.
  writeRegistry(home, [
    { scope: "local", projectPath: proj, installPath: gitA, version: "0.28.0-a", lastUpdated: "2026-09-01T00:00:00.000Z" },
    { scope: "user", installPath: gitB, version: "0.28.0-b", lastUpdated: "2026-09-02T00:00:00.000Z" },
  ]);
  assert.ok(msg().includes(ownBin(gitA)), "this project's own row first");
  // A wiped copy does not count.
  writeRegistry(home, [{ scope: "user", installPath: join(home, "gone"), version: "0.28.0", lastUpdated: "2026-09-03T00:00:00.000Z" }]);
  assert.match(msg(), /npx projectstore-claude@[^ ]+ upgrade --no-register --project/, "nothing present: the package root's own form");
  // A copy this project disabled does not count.
  writeRegistry(home, [{ scope: "user", installPath: gitB, version: "0.28.0-b", lastUpdated: "2026-09-02T00:00:00.000Z" }]);
  const sp = join(proj, SRC.runtime.harness_dir, "settings.local.json");
  const s0 = JSON.parse(read(sp));
  writeFileSync(sp, JSON.stringify({ ...s0, enabledPlugins: { "projectstore@SmartAndPoint": false } }, null, 2) + "\n");
  assert.match(msg(), /npx projectstore-claude@[^ ]+ upgrade --no-register --project/, "disabled here: not this project's copy");
  writeFileSync(sp, JSON.stringify(s0, null, 2) + "\n");
  // A session's own host-cache root comes first, whatever the registry says.
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: gitA, version: "0.28.0-a", lastUpdated: "2026-09-05T00:00:00.000Z" }]);
  assert.ok(checkLayout(proj, undefined, { root: gitB, home })[0].message.includes(ownBin(gitB)), "the session's own copy wins");
  // This project's enabled copy is the npm registration's: the shell form, at that copy's version.
  const npm = fakeInstall(home, "0.28.0-npm", { full: true, marketplace: SRC.surfaces.plugin.marketplace_name });
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: npm, version: "0.28.0-npm", lastUpdated: "2026-09-04T00:00:00.000Z" }]);
  assert.match(msg(), /npx projectstore-claude@0\.28\.0-npm upgrade --no-register --project/, "the npm copy: the shell, at its own version");
});

// A copy with the bin but not the flag: rc.1 and rc.2 parse strictly, so the
// named command exits 2 on --no-register and writes nothing (the layout spec,
// contract 12 as amended after the rc.3 tag). The capability is the copy's
// own parse table, never its version.
test("layout contract 12: a copy whose CLI does not declare --no-register gets advice in its own channel, never a command it would reject", () => {
  const home = mkdtempSync(join(TMP, "ps-layout-flag-"));
  const { proj } = legacyProject(home);
  // A terminal npx run of a newer package: it carries its own version.
  const npx = join(home, ".npm", "_npx", "x", "node_modules", "projectstore");
  mkdirSync(join(npx, ".claude-plugin"), { recursive: true });
  writeFileSync(join(npx, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version: "0.28.1" }));
  const msg = () => checkLayout(proj, undefined, { root: npx, home })[0].message;
  // This project's own row is an rc.2-shaped git copy.
  const rc2 = preFlagInstall(home, "0.28.0-rc.2");
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: rc2, version: "0.28.0-rc.2", lastUpdated: "2026-09-07T00:00:00.000Z" }]);
  const git = msg();
  assert.match(git, /\(0\.28\.0-rc\.2\) predates --no-register/);
  assert.match(git, /\/plugin update/);
  assert.doesNotMatch(git, /npx |node "/, "no command the copy would reject");
  const ran = spawnSync(process.execPath, [join(rc2, "bin", "projectstore.mjs"), "upgrade", "--harness", SRC.id, "--no-register", "--project", proj], { encoding: "utf8" });
  assert.equal(ran.status, 2, "the fixture rejects the flag, as rc.2 does: " + ran.stderr);
  // A newer label does not make it capable — this machine's never-published 0.28.0 build.
  const later = preFlagInstall(home, "99.0.0");
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: later, version: "99.0.0", lastUpdated: "2026-09-08T00:00:00.000Z" }]);
  assert.match(msg(), /\(99\.0\.0\) predates --no-register/, "the version is not the capability");
  // The npm registration's copy: refresh it in its own channel, at the running version, never at its own.
  const npm = preFlagInstall(home, "0.28.0-rc.2", { marketplace: SRC.surfaces.plugin.marketplace_name });
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: npm, version: "0.28.0-rc.2", lastUpdated: "2026-09-09T00:00:00.000Z" }]);
  const reg = msg();
  assert.match(reg, /npm registration's copy and predates --no-register/);
  assert.ok(reg.includes(`npx projectstore-claude@0.28.1 upgrade --project "${proj}"`), "the running version refreshes it: " + reg);
  assert.doesNotMatch(reg, /--no-register --project/, "the refresh registers: npm is this project's channel");
  assert.doesNotMatch(reg, /@0\.28\.0-rc\.2 /, "never at the copy's own version: that refresh would change nothing");
  // Chosen first, gated after: the project's own copy is what it runs, so a capable user-scope copy does not stand in.
  const capable = fakeInstall(home, "0.28.0-b", { full: true });
  writeRegistry(home, [
    { scope: "local", projectPath: proj, installPath: rc2, version: "0.28.0-rc.2", lastUpdated: "2026-09-01T00:00:00.000Z" },
    { scope: "user", installPath: capable, version: "0.28.0-b", lastUpdated: "2026-09-10T00:00:00.000Z" },
  ]);
  assert.match(msg(), /\(0\.28\.0-rc\.2\) predates --no-register/);
  // The 0.27.x case keeps its own words: the bin check comes first.
  // The read itself: this tree and a full fake copy declare the flag; the fixture does not.
  assert.equal(takesNoRegister(ROOT), true);
  assert.equal(takesNoRegister(capable), true);
  assert.equal(takesNoRegister(rc2), false);
});

// The way back from an npm switch is `uninstall --surface plugin`; a narrowed
// uninstall must not take a not-yet-moved project's legacy runtime with it —
// its sessions, its log, the launcher its status line still runs (the
// critic's fourth pass, 2026-10-04).
test("layout contract 6: a narrowed uninstall leaves the legacy runtime alone; only a full one removes it", () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  const narrowed = plan(proj, { home, root, env: noHostEnv(), mode: "uninstall", surfaces: ["plugin"] });
  assert.ok(!narrowed.items.some((i) => i.surface === "layout_cleanup"), JSON.stringify(narrowed.items.map((i) => i.surface)));
  const full = plan(proj, { home, root, env: noHostEnv(), mode: "uninstall" });
  const cleanup = full.items.find((i) => i.surface === "layout_cleanup");
  assert.ok(cleanup, "a full uninstall still disowns the legacy runtime");
  assert.equal(cleanup.path, lp.legacy.runtime);
});

test("layout contract 12: a host-cache copy reached through a symlinked home is still a host-cache copy", () => {
  const real = mkdtempSync(join(TMP, "ps-layout-realhome-"));
  const copy = join(real, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", "0.28.0");
  mkdirSync(copy, { recursive: true });
  const link = join(mkdtempSync(join(TMP, "ps-layout-link-")), "home");
  symlinkSync(real, link);
  assert.equal(installChannel(copy, { home: link }), "marketplace", "the real root against the linked home");
  assert.equal(installChannel(join(link, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", "0.28.0"), { home: real }), "marketplace", "the linked root against the real home");
});

test("layout contract 12: a session under a relocated host home hands it on — both forms carry the variable", () => {
  const { home, root } = home028();
  const { proj } = legacyProject(home);
  const v = SRC.runtime.home_env;
  const dir = join(home, SRC.runtime.home_default);
  const own = layoutRemedy(proj, { root, home, env: { [v]: dir } }).command;
  assert.ok(own.startsWith(`${v}="${dir}" node "`), own);
  const npm = fakeInstall(home, VERSION, { marketplace: SRC.surfaces.plugin.marketplace_name });
  const shell = layoutRemedy(proj, { root: npm, home, env: { [v]: dir } }).command;
  assert.ok(shell.startsWith(`${v}="${dir}" npx `), shell);
  assert.ok(!layoutRemedy(proj, { root, home, env: {} }).command.includes(`${v}=`), "no variable, no prefix");
});

test("layout contract 7: every legacy file that keeps the finding alive is named in it — the welcome marker alone included", () => {
  const proj = mkdtempSync(join(TMP, "ps-layout-marker-"));
  const lp = layoutPaths(proj);
  mkdirSync(dirname(lp.legacy.welcomed), { recursive: true });
  writeFileSync(lp.legacy.welcomed, "2026-09-01T00:00:00Z\n");
  const f = checkLayout(proj, undefined, { root: ROOT, home: mkdtempSync(join(TMP, "ps-layout-markerhome-")) });
  assert.equal(f.length, 1);
  assert.ok(f[0].message.includes(`still holds ${relative(proj, lp.legacy.welcomed)}.`), f[0].message);
});

test("layout contract 12: doctor's install report threads its root and home into the layout remedy", async () => {
  const { home, root } = home028();
  const { proj, lp } = legacyProject(home);
  const cfg = JSON.parse(read(lp.legacy.binding));
  const f = (await runInstallChecks(cfg, proj, { root, home })).find((x) => x.check === "layout-legacy");
  assert.ok(f && f.message.includes(`node "${join(root, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register --project "${proj}"`), f && f.message);
});

test("installer: its own entry point honours --no-register (driven through plan)", () => {
  const home = mkdtempSync(join(TMP, "ps-layout-main-"));
  const { proj } = legacyProject(home);
  const env = noHostEnv({ HOME: home, [SRC.runtime.home_env]: join(home, SRC.runtime.home_default) });
  const run = (...extra) => JSON.parse(spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), "plan", "--harness", SRC.id, ...extra, "--json", "--project", proj], { encoding: "utf8", env, timeout: 60000 }).stdout);
  assert.ok(run().items.some((i) => i.kind === "registration"), "from a checkout the registration is planned");
  assert.ok(!run("--no-register").items.some((i) => i.kind === "registration"), "--no-register leaves it out");
});

test("layout contract 7: the fallback window closes at 0.30 — this test is the sunset", () => {
  if (cmpVersion(VERSION, "0.30.0") < 0) {
    assert.ok(layoutPaths("/p").legacy, "below 0.30 the legacy resolver exists and the cases above exercise it");
  } else {
    assert.equal(layoutPaths("/p").legacy, undefined, "0.30: delete the legacy resolver, the fallback readers and the migration's legacy reads; layout-legacy becomes an issue naming the manual move");
  }
});

test("layout contract 5: the launcher names its project through a rendered placeholder, and the 0.27.1 template cannot be filled", () => {
  const { home, root } = home028();
  const proj = mkdtempSync(join(TMP, "ps-layout-proj-"));
  const src = renderStatusLineLauncher(TPL, root, proj);
  assert.ok(src.includes(`const PROJECT_DIR = ${JSON.stringify(proj)};`));
  assert.ok(!src.includes('"..", ".."'), "no depth walk");
  assert.equal(renderStatusLineLauncher(TPL_027, root, proj), null);
  // Two renders for two roots differ only in the root; the project is the same string plan() resolves.
  const other = renderStatusLineLauncher(TPL, join(root, "..", "9.9.9"), proj);
  assert.notEqual(src, other); assert.equal(src.replace(JSON.stringify(root), ""), other.replace(JSON.stringify(join(root, "..", "9.9.9")), ""));
});

test("layout contract 5/9: .projectstore/.gitignore is merged by line in either order, and a `*` that hides harness/ is reported", () => {
  const dir = mkdtempSync(join(TMP, "ps-layout-gi-"));
  ensureRuntimeDir(dir); ensureSessionsDir(dir);
  const lines = read(join(dir, ".projectstore", ".gitignore")).split("\n").filter(Boolean).filter((l) => !l.startsWith("#"));
  assert.deepEqual(lines.sort(), ["projectstore.json", "sessions/", "state/"]);
  const dir2 = mkdtempSync(join(TMP, "ps-layout-gi-"));
  ensureSessionsDir(dir2); ensureRuntimeDir(dir2); ensureRuntimeDir(dir2);
  assert.deepEqual(read(join(dir2, ".projectstore", ".gitignore")).split("\n").filter(Boolean).filter((l) => !l.startsWith("#")).sort(), ["projectstore.json", "sessions/", "state/"], "the other order, and idempotent");
  // A vault written before 2026-09-06 carries "*": the overlays are hidden; doctor says so even outside a git repo.
  const dir3 = mkdtempSync(join(TMP, "ps-layout-gi-"));
  mkdirSync(join(dir3, ".projectstore", "harness"), { recursive: true });
  writeFileSync(join(dir3, ".projectstore", ".gitignore"), "# old\n*\n");
  const g = checkGitignore(dir3);
  assert.equal(g.length, 1); assert.match(g[0].message, /hides harness\//);
});

test("layout contract 8: a worktree of a legacy-layout main checkout still inherits — the parent is read through the fallback, the binding alone is copied, into the new layout", () => {
  const { home } = home028();
  const { proj: main } = legacyProject(home);
  const parent = readConfigAt(main);
  assert.equal(parent.layout, "engineering", "the parent's binding is read from its legacy path");
  // The documented copy (commands/bind.md --inherit): the binding, verbatim, nothing else.
  const child = mkdtempSync(join(TMP, "ps-layout-wt-"));
  mkdirSync(join(child, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(child, parent);
  assert.deepEqual(JSON.parse(read(layoutPaths(child).binding)), parent);
  assert.ok(!existsSync(layoutPaths(child).state) && !existsSync(layoutPaths(child).overlayDir) && !existsSync(layoutPaths(child).legacy.binding), "no state, no overlays (they come from git), nothing legacy");
});

test("layout contract 1: the SessionStart hook pays one existsSync per reader — its wall time on a legacy project is within 25 ms of a migrated one (medians of 5)", () => {
  const { home, root } = home028();
  const legacy = legacyProject(home);
  const migrated = legacyProject(home);
  const env = noHostEnv();
  apply(plan(migrated.proj, { home, root, env }), { env, home });
  const time = (proj) => {
    const t = [];
    for (let i = 0; i < 5; i++) {
      const s = process.hrtime.bigint();
      const r = spawnSync(process.execPath, [join(root, "hooks", "session-start.mjs")], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", session_id: `t${i}`, source: "startup", cwd: proj }), env: installEnv(home, root, proj), cwd: proj, timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    return t.sort((a, b) => a - b)[2];
  };
  // One untimed run each warms the page cache for the fake install; then the two are interleaved so an order effect cannot masquerade as a layout cost.
  time(legacy.proj); time(migrated.proj);
  const a = time(legacy.proj), b = time(migrated.proj), a2 = time(legacy.proj), b2 = time(migrated.proj);
  const diff = Math.abs(Math.min(a, a2) - Math.min(b, b2));
  assert.ok(diff < 25, `legacy ${a.toFixed(1)}/${a2.toFixed(1)} ms vs migrated ${b.toFixed(1)}/${b2.toFixed(1)} ms`);
});

test("layout contract 13: the prose moved in one pass — commands, agents, skills, docs and the block template name the new paths; the block is v4", () => {
  const hits = [];
  const walk = (dir) => { for (const n of readdirSync(join(ROOT, dir), { withFileTypes: true })) { const rel = join(dir, n.name); if (n.isDirectory()) walk(rel); else if (/\.(md|tmpl)$/.test(n.name)) { for (const [i, line] of read(join(ROOT, rel)).split("\n").entries()) if (/\.claude\/projectstore\.json|\.claude\/\.projectstore/.test(line) && !/legacy|pre-0\.28|not yet migrated/.test(line)) hits.push(`${rel}:${i + 1}`); } } };
  for (const d of ["commands", "agents", "skills", "docs", "templates"]) walk(d);
  for (const [i, line] of read(join(ROOT, "AGENTS.md")).split("\n").entries()) if (/\.claude\/projectstore\.json|\.claude\/\.projectstore/.test(line)) hits.push(`AGENTS.md:${i + 1}`);
  assert.deepEqual(hits, [], "a line naming the legacy layout must say it is legacy");
  const tmpl = read(join(ROOT, "templates", "claude-md-block.md.tmpl"));
  assert.match(tmpl, /projectstore:agents v4 /, "the block template is v4: its config path changed");
  assert.ok(tmpl.includes(".projectstore/harness/<harness>.json"));
  // Messages that reach a user through the code name the new paths too.
  for (const f of ["scripts/worktree.mjs", "scripts/doctor.mjs", "hooks/session-start.mjs"]) {
    const src = read(join(ROOT, f)).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    for (const m of src.matchAll(/["'`][^"'`\n]*\.claude\/projectstore\.json[^"'`\n]*["'`]/g)) if (!/legacy|pre-0\.28/.test(m[0])) hits.push(`${f}: ${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(hits, []);
});

// ─── A14: the fresh-install path ────────────────────────────────────────
//
// Contract 5 names `bind` among the writers of the line-merged
// .projectstore/.gitignore. It was the one writer that never wrote it, and
// nothing noticed: a project bound and committed before its first session
// carried a machine-local binding with an absolute vault path into git.
// Measured on a real install 2026-09-06 — `install` does not repair it either,
// because planLayout produces no item unless a legacy path is pending.

const gitInit = (dir) => {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
};
const gitLsFiles = (dir) => spawnSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

test("layout contract 5 (A14): bind writes its ignore lines, so a fresh project never commits its binding", async () => {
  const { proj: source, vault } = seedCliVault();
  const proj = mkdtempSync(join(TMP, "ps-a14-"));
  gitInit(proj);
  writeFileSync(join(proj, "README.md"), "x\n");
  void source;

  const { planBind, applyBind } = await import("../scripts/binding.mjs");
  const p = planBind(proj, { vault, env: noHostEnv() });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  applyBind(p);

  const lp = layoutPaths(proj);
  assert.ok(existsSync(lp.gitignore), "bind wrote .projectstore/.gitignore");
  const lines = readFileSync(lp.gitignore, "utf8").split("\n").map((l) => l.trim());
  for (const l of LAYOUT.gitignore) assert.ok(lines.includes(l), `the ignore file carries ${l}`);
  assert.ok(lines.some((l) => l.startsWith("#") && l.includes("machine-local")), "and the header that says why");

  // The point of the lines: `git add -A` stages the ignore file and NOT the binding.
  spawnSync("git", ["add", "-A"], { cwd: proj });
  const staged = gitLsFiles(proj);
  assert.ok(staged.includes(".projectstore/.gitignore"), "the ignore file is committed — it is shared, not machine-local");
  assert.ok(!staged.includes(".projectstore/projectstore.json"), "the binding is not: it carries an absolute vault path");

  // A second writer composes rather than rewrites (contract 5 is line-merged).
  const before = readFileSync(lp.gitignore, "utf8");
  const { ensureRuntimeDir } = await import("../scripts/lib.mjs");
  ensureRuntimeDir(proj);
  assert.equal(readFileSync(lp.gitignore, "utf8"), before, "a second ensure leaves the file byte-identical");
});

test("layout contract 8 (A14): a rebind of a not-yet-migrated project writes the legacy file and creates nothing under .projectstore/", async () => {
  const home = mkdtempSync(join(TMP, "ps-a14-home-"));
  const { proj } = legacyProject(home);
  const lp = layoutPaths(proj);
  assert.ok(existsSync(lp.legacy.binding) && !existsSync(lp.binding), "the fixture is on the legacy layout");
  const other = mkdtempSync(join(TMP, "ps-a14-vault-"));

  const { planBind, applyBind } = await import("../scripts/binding.mjs");
  const p = planBind(proj, { vault: other, rebind: true, env: noHostEnv() });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  applyBind(p);

  assert.equal(p.configPath, lp.legacy.binding, "the rebind writes where the reader found the binding");
  assert.ok(!existsSync(lp.gitignore), "and creates nothing under .projectstore/ — that write belongs to the migration item");
});

test("layout contract 9 (A14): doctor names an ignore file that is missing or short a line, and a binding git already tracks", async () => {
  const { checkGitignore, checkTrackedRuntime } = await import("../scripts/doctor.mjs");
  const proj = mkdtempSync(join(TMP, "ps-a14-doc-"));
  gitInit(proj);
  const lp = layoutPaths(proj);
  mkdirSync(lp.root, { recursive: true });
  writeFileSync(lp.binding, JSON.stringify({ vault_path: "/tmp/nowhere" }) + "\n");

  // Missing entirely.
  let f = checkGitignore(proj).filter((x) => x.check === "gitignore");
  assert.ok(f.some((x) => /exists without its \.gitignore/.test(x.message)), JSON.stringify(f));

  // Present but short a line.
  writeFileSync(lp.gitignore, "# projectstore\nprojectstore.json\n");
  f = checkGitignore(proj).filter((x) => x.check === "gitignore");
  assert.ok(f.some((x) => /is missing "state\/"/.test(x.message)), JSON.stringify(f));

  // Complete: quiet about our own directory.
  const { ensureRuntimeDir } = await import("../scripts/lib.mjs");
  rmSync(lp.gitignore); ensureRuntimeDir(proj);
  f = checkGitignore(proj).filter((x) => x.check === "gitignore" && /projectstore/.test(x.file || ""));
  assert.deepEqual(f, [], "a complete ignore file says nothing");

  // A binding already in the index: an ignore line cannot untrack it.
  assert.deepEqual(checkTrackedRuntime(proj), [], "nothing tracked yet");
  spawnSync("git", ["add", "-f", ".projectstore/projectstore.json"], { cwd: proj });
  const t = checkTrackedRuntime(proj);
  assert.equal(t.length, 1);
  assert.equal(t[0].check, "gitignore-tracked");
  assert.match(t[0].message, /git rm --cached \.projectstore\/projectstore\.json/);
  spawnSync("git", ["rm", "--cached", "-q", ".projectstore/projectstore.json"], { cwd: proj });
  assert.deepEqual(checkTrackedRuntime(proj), [], "and quiet once it is untracked");
});

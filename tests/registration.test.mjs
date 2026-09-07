// projectstore — the registration surface (PS-HARNESS: "npm installs and
// registers the Claude Code plugin from the package: a local marketplace, one
// command, and the migration of this project", slice 1; install spec contract
// 0 as amended, 4′, 9, 13, 17).
//
// Every case runs against a temporary home, a temporary project and an
// npx-shaped package root, with a fake host CLI on a temp PATH that edits the
// sandbox in the shapes measured on claude 2.1.261 — the real binary runs in
// one deliberate case, sandboxed by the pinned home, and only when it is on
// PATH. Nothing here reads the developer's own configuration.
//
//   node --test tests/registration.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fakeInstall, fakePackageRoot, fakeClaude, noHostEnv, writeRegistry } from "./fixtures/install.mjs";
import { plan, renderPreview, apply, runVerb, publicItem, appliedLine } from "../scripts/install-harness.mjs";
import { analyseRegistration, registrationPaths, surfaceStates } from "../scripts/surfaces.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { statusLineLauncherPath, whichOnPath, treeFiles, installedPluginEntries, installedPluginRoot, layoutPaths} from "../scripts/lib.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import { checkPluginRegistration, checkVersionDrift, checkAutoUpdate } from "../scripts/doctor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const S = SRC.surfaces.plugin;
const ID = `${S.plugin_name}@${S.marketplace_name}`;
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
const PACKLIST = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "packlist.json"), "utf8"));
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

delete process.env[SRC.runtime.home_env];

function sandbox({ version = "0.28.0", statusline = true } = {}) {
  const home = tmp("ps-reg-home-");
  const proj = tmp("ps-reg-proj-");
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  writeBinding(proj, JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering", ...(statusline ? { statusline: { enabled: true } } : {}) }));
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const root = fakePackageRoot(join(tmp("ps-reg-npx-"), "node_modules", "projectstore"), version);
  const host = fakeClaude(tmp("ps-reg-bin-"));
  const paths = registrationPaths(S, { home, projectDir: proj, harness: SRC });
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  return { home, proj, root, host, paths, env: host.env(), readJson, item: (p, k) => p.items.find((i) => i.surface === k), local: () => readJson(paths.projectSettings), registry: () => readJson(paths.installed), known: () => readJson(paths.marketplaces) };
}

// The host subcommand of each step: "plugin validate", "plugin marketplace add", "plugin install" …
const sub = (argv) => argv[1] === "marketplace" ? argv.slice(0, 3).join(" ") : argv.slice(0, 2).join(" ");
const hostArgv = (i) => (i.steps || []).filter((s) => s.kind === "host").map((s) => sub(s.argv));

test("registration contract 4′/9: from an npx root the plan registers first, previews every host argv, and the other surfaces are planned against the install path the host will produce", () => {
  const sb = sandbox();
  const { home, proj, root, host, env, item, paths } = sb;
  const p = plan(proj, { home, root, env });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.equal(p.incomplete, false);
  const reg = item(p, "plugin");
  assert.equal(reg.kind, "registration");
  assert.equal(reg.state, "absent");
  assert.equal(reg.action, "create");
  assert.deepEqual(reg.steps.map((s) => s.kind), ["write", "host", "host", "host"]);
  assert.deepEqual(hostArgv(reg), ["plugin validate", "plugin marketplace add", "plugin install"]);
  assert.ok(reg.steps.every((s) => s.kind !== "host" || s.argv.includes("local") || s.name === "validate"), "every scoped command names the local scope");
  assert.equal(reg.steps[0].files, PACKLIST.length, "the write is the packlist");
  assert.equal(reg.scope, "local");
  assert.equal(reg.home, join(home, SRC.runtime.home_default));
  // Phase two: the launcher is produced (the predicted root is a cache path) and the entry names it — never the npx root.
  assert.equal(p.plannedAgainst[SRC.id], reg.root);
  assert.ok(reg.root.startsWith(paths.cacheDir + "/"), reg.root);
  assert.equal(item(p, "statusline_launcher").action, "create");
  assert.equal(item(p, "statusline").after.statusLine.command, `node "${statusLineLauncherPath(proj)}"`);
  assert.ok(!JSON.stringify(item(p, "statusline").after).includes(root), "the npx root never reaches the user's settings");
  assert.match(p.reports[0], /They come from the registration/, "the host-managed report says which registration feeds it (contract 14, amended)");
  const preview = renderPreview(p);
  for (const s of reg.steps.filter((s) => s.kind === "host")) assert.ok(preview.includes(`$ ${[s.bin, ...s.argv].join(" ")}`), `preview carries ${s.name}'s argv`);
  assert.ok(preview.includes("planned against the host's install path"));
  assert.ok(preview.includes(`harness home ${reg.home}, scope local`));
  assert.ok(preview.includes("Each $ line runs the host's own CLI"));
  assert.equal(host.log().length, 0, "plan runs nothing");
  assert.ok(!existsSync(paths.dir), "plan writes nothing");
  // publicItem drops the manifest bodies from steps, keeps the argv.
  const pub = publicItem(reg);
  assert.ok(pub.steps.every((s) => !("manifest" in s)));
});

test("registration contract 4′: apply writes the directory whole, runs the host with the pinned home and the project as cwd, verifies the install path, and the launcher is byte-identical to a cache install's", () => {
  const sb = sandbox();
  const { home, proj, root, host, env, item, paths, local, registry, known } = sb;
  const p = plan(proj, { home, root, env });
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  const reg = done.find((d) => d.surface === "plugin");
  assert.ok(reg.verified, "the registry was read back");
  assert.equal(reg.verified.installPath, item(p, "plugin").root);
  // The host saw the pinned home and the project cwd, in the planned order.
  const calls = host.log();
  assert.deepEqual(calls.map((c) => sub(c.argv)), ["plugin validate", "plugin marketplace add", "plugin install"]);
  for (const c of calls) { assert.equal(c.cwd, proj, "--scope local resolves the project from cwd"); assert.equal(c.home, join(home, SRC.runtime.home_default), "the harness home is pinned"); }
  // Our directory: the payload equals the packlist, the manifest carries the provenance field with the digest.
  assert.deepEqual(treeFiles(paths.payload), PACKLIST);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  assert.equal(manifest.name, S.marketplace_name);
  assert.equal(manifest.plugins[0].source, `./${S.plugin_subdir}`);
  assert.equal(manifest[S.provenance_key].pkg, "0.28.0");
  assert.equal(manifest[S.provenance_key].project, proj);
  assert.equal(manifest[S.provenance_key].digest.count, PACKLIST.length);
  assert.ok(!existsSync(paths.dir + ".staging"), "the stage was renamed into place");
  // The host's records: local settings only; the user's settings untouched.
  assert.equal(local().enabledPlugins[ID], true);
  assert.ok(local().extraKnownMarketplaces[S.marketplace_name]);
  assert.ok(!existsSync(join(proj, CFG_DIR, "settings.json")), "the committed settings file is never written");
  assert.ok(!existsSync(paths.userSettings), "the user's settings are never written");
  const row = registry().plugins[ID][0];
  assert.equal(row.scope, "local"); assert.equal(row.projectPath, proj); assert.equal(row.version, "0.28.0");
  assert.equal(known()[S.marketplace_name].installLocation, paths.dir);
  // The launcher names the produced install, and a plan from that install finds it current — byte for byte.
  const launcher = readFileSync(statusLineLauncherPath(proj), "utf8");
  assert.ok(launcher.includes(row.installPath), "the launcher's fallback root is the host's install path");
  assert.ok(!launcher.includes(root), "and never the npx root");
  assert.ok(parseProvenance(launcher));
  const fromCache = plan(proj, { home, root: row.installPath, env: noHostEnv() });
  assert.equal(fromCache.items.find((i) => i.surface === "statusline_launcher").action, "skip");
  assert.equal(fromCache.items.find((i) => i.surface === "statusline_launcher").state, "current");
  assert.equal(fromCache.items.find((i) => i.surface === "plugin").action, "skip", "a cache install never plans a registration of itself (condition npm_package_root)");
  assert.equal(fromCache.items.find((i) => i.surface === "plugin").reason, null);
  // installedPluginRoot resolves to the enabled row — the launcher's own pick.
  assert.equal(installedPluginRoot(home).path, row.installPath);
  // Re-run: current, nothing to do, the host is not called.
  host.reset();
  const again = plan(proj, { home, root, env });
  assert.ok(again.items.every((i) => i.action === "skip"), JSON.stringify(again.items.map(publicItem)));
  assert.equal(item(again, "plugin").state, "current");
  assert.equal(host.log().length, 0);
  // The states doctor reads agree.
  const st = surfaceStates(proj, { home, root }).states.find((s) => s.kind === "registration");
  assert.equal(st.state, "current");
  assert.equal(st.installPath, row.installPath);
  assert.deepEqual(checkPluginRegistration(proj, [st]).map((f) => f.level), ["info"]);
});

test("registration contract 4′/14: a newer package rewrites the directory and runs plugin update at local scope; an older one does not downgrade what a newer wrote", () => {
  const sb = sandbox();
  const { home, proj, root, host, env, item, paths, registry } = sb;
  apply(plan(proj, { home, root, env }), { env, home });
  host.reset();
  const newer = fakePackageRoot(join(tmp("ps-reg-npx2-"), "node_modules", "projectstore"), "0.29.0");
  const p = plan(proj, { home, root: newer, env, mode: "install" });
  const reg = item(p, "plugin");
  assert.equal(reg.state, "stale");
  assert.match(reg.reason, /plugin updated/);
  assert.equal(reg.action, "update");
  assert.deepEqual(reg.steps.map((s) => s.kind), ["write", "host", "host"]);
  assert.deepEqual(hostArgv(reg), ["plugin validate", "plugin update"]);
  assert.ok(reg.steps[2].argv.includes("--scope") && reg.steps[2].argv.includes("local"), "update names the scope (measured: without it the host looks at user scope and fails)");
  assert.ok(reg.root.endsWith("/0.29.0"));
  assert.equal(item(p, "statusline_launcher").action, "update", "the launcher follows the new install path");
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(registry().plugins[ID][0].version, "0.29.0");
  assert.equal(JSON.parse(readFileSync(paths.manifest, "utf8"))[S.provenance_key].pkg, "0.29.0");
  assert.ok(readFileSync(statusLineLauncherPath(proj), "utf8").includes("/0.29.0"));
  // Same version, different content (the maintainer's pack → fix → pack loop): rewritten, and refreshed as uninstall + install.
  host.reset();
  writeFileSync(join(newer, "README.md"), "# changed\n");
  const same = plan(proj, { home, root: newer, env });
  assert.equal(item(same, "plugin").state, "stale");
  assert.match(item(same, "plugin").reason, /same version 0\.29\.0, different content/);
  assert.deepEqual(hostArgv(item(same, "plugin")), ["plugin validate", "plugin uninstall", "plugin install"]);
  const sameDone = apply(same, { env, home });
  assert.equal(sameDone.failed, undefined, JSON.stringify(sameDone));
  assert.equal(readFileSync(join(registry().plugins[ID][0].installPath, "README.md"), "utf8"), "# changed\n", "the host holds the rewritten payload");
  assert.equal(plan(proj, { home, root: newer, env }).items.find((i) => i.surface === "plugin").state, "current");
  // Back from the older package: the directory is newer — current, reported, not rewritten.
  host.reset();
  const back = plan(proj, { home, root, env });
  assert.equal(item(back, "plugin").action, "skip");
  assert.equal(item(back, "plugin").state, "current");
  assert.match(item(back, "plugin").reason, /newer than this package.*not downgraded/);
  // …and a second checkout registering from the older package says which version it registers.
  const proj2 = tmp("ps-reg-proj-b-");
  mkdirSync(join(proj2, CFG_DIR), { recursive: true });
  const second = plan(proj2, { home, root, env, harnesses: [SRC.id] });
  const reg2 = second.items.find((i) => i.surface === "plugin");
  assert.equal(reg2.action, "create");
  assert.ok(reg2.steps.some((st) => st.kind === "note" && /holds 0\.29\.0.*newer than this package \(0\.28\.0\); this checkout registers 0\.29\.0/.test(st.why)));
  assert.ok(!reg2.steps.some((st) => st.kind === "write"), "not downgraded");
  assert.match(renderPreview(second), /note: the directory holds 0\.29\.0/);
  assert.equal(host.log().length, 0);
});

test("registration contract 4′/13: a competing enabled copy is silenced for this checkout only and recorded; uninstall reverts exactly that, forgets this checkout, and removes the shared directory only when no other checkout uses it", () => {
  const sb = sandbox();
  const { home, proj, root, host, env, item, paths, local, registry, known } = sb;
  // The git marketplace's copy, installed and enabled at user scope.
  const other = fakeInstall(home, "0.27.1");
  writeRegistry(home, [{ scope: "user", installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }]);
  const p = plan(proj, { home, root, env });
  const silence = item(p, "plugin_others");
  assert.ok(silence, "the competitor gets its own item");
  assert.equal(silence.action, "disable");
  assert.equal(silence.entry, "projectstore@SmartAndPoint");
  assert.deepEqual(hostArgv(silence), ["plugin disable"]);
  assert.ok(silence.steps[0].argv.includes("local"));
  assert.match(renderPreview(p), /silenced in this checkout's local settings only, never globally/);
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(local().enabledPlugins["projectstore@SmartAndPoint"], false);
  assert.equal(local().enabledPlugins[ID], true);
  assert.ok(!existsSync(paths.userSettings), "the user's global enablement is untouched");
  assert.deepEqual(JSON.parse(readFileSync(paths.manifest, "utf8"))[S.provenance_key].disabled, ["projectstore@SmartAndPoint"]);
  // doctor: version drift is quiet — the other row is disabled for this project; the registration is one info.
  const states = surfaceStates(proj, { home, root }).states;
  assert.deepEqual(checkVersionDrift(home, states, proj), [], "a copy disabled for the project is not a drift (contract 17, amended)");
  assert.deepEqual(checkPluginRegistration(proj, states).map((f) => f.level), ["info"]);
  assert.deepEqual(checkAutoUpdate(home).filter((f) => f.level !== "info"), [], "a directory marketplace has nothing to toggle");
  // A second checkout installed from the same directory.
  const reg = registry();
  reg.plugins[ID].push({ ...reg.plugins[ID][0], projectPath: "/elsewhere/checkout" });
  writeFileSync(paths.installed, JSON.stringify(reg, null, 2));
  host.reset();
  const un = plan(proj, { home, root, env, mode: "uninstall" });
  const u = item(un, "plugin");
  assert.equal(u.action, "remove");
  assert.deepEqual(u.steps.map((s) => s.kind), ["host", "unregister", "host"], JSON.stringify(u.steps.map((s) => s.kind)));
  assert.deepEqual(u.steps.map((s) => s.kind === "host" ? s.name : s.kind), ["uninstall", "unregister", "enable"]);
  assert.deepEqual(hostArgv(u), ["plugin uninstall", "plugin enable"]);
  assert.match(u.reason, /1 other checkout/);
  assert.match(renderPreview(un), /marketplace remove.*would drop every checkout's rows/);
  const undone = apply(un, { env, home });
  assert.equal(undone.failed, undefined, JSON.stringify(undone));
  assert.equal(local().enabledPlugins["projectstore@SmartAndPoint"], true, "the silenced copy is turned back on");
  assert.equal(local().enabledPlugins[ID], undefined);
  assert.equal(local().extraKnownMarketplaces[S.marketplace_name], undefined, "our entry is gone");
  assert.ok(existsSync(paths.dir), "the shared directory stays for the other checkout");
  assert.ok(known()[S.marketplace_name], "and so does the host's marketplace entry");
  assert.equal(registry().plugins[ID].length, 1);
  assert.equal(registry().plugins[ID][0].projectPath, "/elsewhere/checkout");
  // The last checkout out removes it all.
  const reg2 = registry(); reg2.plugins[ID][0].projectPath = proj; writeFileSync(paths.installed, JSON.stringify(reg2, null, 2));
  const s2 = local(); s2.extraKnownMarketplaces[S.marketplace_name] = { source: { source: "directory", path: paths.dir } }; s2.enabledPlugins[ID] = true; writeFileSync(paths.projectSettings, JSON.stringify(s2, null, 2));
  host.reset();
  const last = plan(proj, { home, root, env, mode: "uninstall" });
  // The competitor was already turned back on for this checkout by the first uninstall; nothing here holds it disabled, so no enable runs.
  assert.deepEqual(hostArgv(item(last, "plugin")), ["plugin uninstall", "plugin marketplace remove"]);
  assert.ok(item(last, "plugin").steps.some((s) => s.kind === "remove"));
  apply(last, { env, home });
  assert.ok(!existsSync(paths.dir));
  assert.equal(known()[S.marketplace_name], undefined);
  // Nothing of ours left: absent, and the registry's other keys untouched.
  assert.equal(analyseRegistration(proj, S, { root, home, harness: SRC, env }).state, "absent");
  assert.ok(registry().plugins["projectstore@SmartAndPoint"], "the competitor's row is not ours to remove");
});

test("registration contract 4′: without the host CLI the registration is unavailable and the plan incomplete; inside a live session it is deferred; the other surfaces still install", () => {
  const sb = sandbox();
  const { home, proj, root, item, paths } = sb;
  const p = plan(proj, { home, root, env: noHostEnv() });
  assert.equal(p.ok, true);
  assert.equal(p.incomplete, true);
  assert.equal(item(p, "plugin").state, "unavailable");
  assert.equal(item(p, "plugin").action, "skip");
  assert.match(item(p, "plugin").reason, /not on PATH/);
  assert.equal(item(p, "agents_block").action, "add");
  assert.equal(item(p, "statusline_launcher"), undefined, "an npx root produces no launcher on its own");
  assert.match(renderPreview(p), /could not be planned/);
  const done = apply(p, { env: noHostEnv(), home });
  assert.equal(done.length, 1);
  assert.ok(!existsSync(paths.dir), "the directory is not written without the host");
  // Inside a session (the host's marker in the environment), with the CLI present.
  const marker = (SRC.runtime.session_env || [])[0];
  assert.equal(marker, "CLAUDECODE", "the marker a live session's Bash tool carries (measured 2026-09-05)");
  assert.ok(!(SRC.runtime.detect_env || []).includes(marker), "the session marker is not a hook-process variable");
  const inSession = plan(proj, { home, root, env: sb.host.env({ [marker]: "1" }) });
  assert.equal(inSession.incomplete, true);
  assert.match(item(inSession, "plugin").reason, /outside the session/);
  assert.equal(sb.host.log().length, 0);
});

test("registration contract 5: a directory at our path without the provenance field is foreign to install, upgrade and uninstall, byte-identical; a stray registry entry at another path too", () => {
  const sb = sandbox();
  const { home, proj, root, env, item, paths } = sb;
  mkdirSync(dirname(paths.manifest), { recursive: true });
  const theirs = JSON.stringify({ name: S.marketplace_name, plugins: [] }, null, 2);
  writeFileSync(paths.manifest, theirs);
  for (const mode of ["install", "uninstall"]) {
    const p = plan(proj, { home, root, env, mode });
    assert.equal(p.ok, false, mode);
    assert.equal(item(p, "plugin").action, "refuse");
    assert.equal(item(p, "plugin").state, "foreign");
    assert.match(item(p, "plugin").reason, /no `projectstore` field of ours/);
    assert.throws(() => apply(p, { env, home }));
    assert.equal(readFileSync(paths.manifest, "utf8"), theirs);
  }
  assert.equal(sb.host.log().length, 0);
  const st = surfaceStates(proj, { home, root }).states.find((s) => s.kind === "registration");
  assert.equal(checkPluginRegistration(proj, [st])[0].check, "plugin-registration-foreign");
  // A registry naming our marketplace elsewhere.
  const sb2 = sandbox();
  mkdirSync(dirname(sb2.paths.marketplaces), { recursive: true });
  writeFileSync(sb2.paths.marketplaces, JSON.stringify({ [S.marketplace_name]: { source: { source: "directory", path: "/somewhere/else" }, installLocation: "/somewhere/else" } }));
  const p2 = plan(sb2.proj, { home: sb2.home, root: sb2.root, env: sb2.env });
  assert.equal(p2.items.find((i) => i.surface === "plugin").state, "foreign");
  assert.match(p2.items.find((i) => i.surface === "plugin").reason, /not at/);
});

test("registration contract 4′: a host command that fails stops the item, is shown verbatim, leaves the launcher unwritten, and the next plan resumes from the state it finds", () => {
  const sb = sandbox();
  const { home, proj, root, host, item, paths, local } = sb;
  const failing = host.env({ FAKE_CLAUDE_FAIL: "install" });
  const p = plan(proj, { home, root, env: failing });
  const done = apply(p, { env: failing, home });
  assert.ok(done.failed, "the failure is recorded");
  assert.equal(done.failed.step, "install");
  assert.equal(done.failed.status, 1);
  assert.match(done.failed.stderr, /failed as instructed/);
  assert.ok(!existsSync(statusLineLauncherPath(proj)), "a launcher pointing at nothing is not written");
  assert.ok(existsSync(paths.dir), "the directory write before it stands");
  assert.ok(local().extraKnownMarketplaces[S.marketplace_name], "and so does the marketplace add");
  const line = appliedLine({ applied: done, failed: done.failed });
  assert.match(line, /stopped: \$ claude plugin install/);
  assert.match(line, /failed as instructed/);
  // Resume: registered, not installed → only the missing steps.
  const again = plan(proj, { home, root, env: host.env() });
  const reg = item(again, "plugin");
  assert.equal(reg.state, "stale");
  assert.match(reg.reason, /registered, not installed/);
  assert.deepEqual(hostArgv(reg), ["plugin validate", "plugin install"]);
  assert.ok(!reg.steps.some((s) => s.kind === "write"), "the directory is current and not rewritten");
  const ok = apply(again, { env: host.env(), home });
  assert.equal(ok.failed, undefined, JSON.stringify(ok));
  assert.ok(existsSync(statusLineLauncherPath(proj)));
  // A damaged payload reads stale and is rewritten.
  writeFileSync(join(paths.payload, "package.json"), "{}");
  const damaged = plan(proj, { home, root, env: host.env() });
  assert.match(item(damaged, "plugin").reason, /does not match the digest/);
  assert.equal(item(damaged, "plugin").steps[0].kind, "write");
});

test("registration contract 4′: a checkout that never registered is absent even when the shared directory exists; two enabled copies are one doctor issue; a dev checkout's stale registration names the npx refresh", () => {
  const sb = sandbox();
  const { home, root, env, host } = sb;
  apply(plan(sb.proj, { home, root, env }), { env, home });
  // Another checkout on the same machine.
  const proj2 = tmp("ps-reg-proj2-");
  mkdirSync(join(proj2, CFG_DIR), { recursive: true });
  const a = analyseRegistration(proj2, S, { root, home, harness: SRC, env });
  assert.equal(a.state, "absent");
  assert.match(a.reason, /directory is present.*not registered/);
  assert.deepEqual(checkPluginRegistration(proj2, surfaceStates(proj2, { home, root, harnesses: [SRC.id] }).states), [], "no nag in a checkout that never registered");
  // Two enabled copies in the registered checkout.
  const other = fakeInstall(home, "0.27.1");
  const reg = JSON.parse(readFileSync(sb.paths.installed, "utf8"));
  reg.plugins["projectstore@SmartAndPoint"] = [{ scope: "user", installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }];
  writeFileSync(sb.paths.installed, JSON.stringify(reg));
  const states = surfaceStates(sb.proj, { home, root }).states;
  const f = checkPluginRegistration(sb.proj, states);
  assert.equal(f.length, 1); assert.equal(f[0].level, "issue"); assert.match(f[0].message, /two enabled copies/);
  assert.equal(checkVersionDrift(home, states, sb.proj).length, 1, "and the drift between the two enabled copies is reported");
  // The plan silences it, without touching the directory beyond its manifest.
  const p = plan(sb.proj, { home, root, env });
  assert.equal(sb.item(p, "plugin").action, "skip");
  assert.equal(sb.item(p, "plugin_others").action, "disable");
  assert.equal(sb.item(p, "plugin_others").steps[0].manifestOnly, true);
  // Seen from the host's own cache install (a session), a stale registration is a skip that names the npx refresh.
  const cacheRoot = fakeInstall(home, "0.28.1", { full: true }); // a session running a newer cache install than the directory
  const fromCache = plan(sb.proj, { home, root: cacheRoot, env });
  const i = sb.item(fromCache, "plugin");
  assert.equal(i.action, "skip");
  assert.match(i.reason, /npx projectstore-claude@<version> upgrade --surface/); // the shell form (contract 12); the harness is the shell's
  assert.equal(host.log().filter((c) => c.argv[1] === "disable").length, 0);
});

test("registration: the copied payload is the packlist, and installedPluginEntries reads enablement and projectPath", () => {
  const sb = sandbox();
  const { home, proj, root, env, paths } = sb;
  apply(plan(proj, { home, root, env }), { env, home });
  assert.deepEqual(treeFiles(paths.payload), PACKLIST);
  const rows = installedPluginEntries(home, proj);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, ID); assert.equal(rows[0].enabled, true); assert.equal(rows[0].projectPath, proj); assert.equal(rows[0].scope, "local");
  const local = JSON.parse(readFileSync(paths.projectSettings, "utf8")); local.enabledPlugins[ID] = false; writeFileSync(paths.projectSettings, JSON.stringify(local));
  assert.equal(installedPluginEntries(home, proj)[0].enabled, false);
  assert.equal(installedPluginEntries(home)[0].enabled, true, "without a project only the user's settings speak");
  assert.equal(analyseRegistration(proj, S, { root, home, harness: SRC, env }).reason, "disabled for this checkout");
});

test("registration: a dev checkout's directly wired status line stays ours when the plan renders against the registration's install path; a competitor the user disabled elsewhere is not re-enabled; a failed registration skips only the dependent surfaces", () => {
  const sb = sandbox();
  const { home, proj, root, host, env, item, paths } = sb;
  writeFileSync(join(proj, CFG_DIR, "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${join(root, "scripts", "statusline.mjs")}"` } }));
  const p = plan(proj, { home, root, env });
  assert.equal(item(p, "statusline").state, "ours-stale", "recognised as ours at the package root, re-pointed at the launcher");
  assert.equal(item(p, "statusline").action, "replace-entry");
  assert.equal(item(p, "statusline").plannedAgainst, item(p, "plugin").root);
  assert.equal(item(p, "agents_block").plannedAgainst, undefined, "the block is rendered from the package root");
  // The registration fails: the block still lands, the two status-line surfaces are skipped and say why.
  const failing = host.env({ FAKE_CLAUDE_FAIL: "install" });
  const done = apply(plan(proj, { home, root, env: failing }), { env: failing, home });
  assert.ok(done.failed);
  assert.ok(done.find((d) => d.surface === "agents_block" && d.action === "add"));
  assert.deepEqual(done.filter((d) => d.action === "skipped").map((d) => d.surface).sort(), ["statusline", "statusline_launcher"]);
  // Then it succeeds; the manifest records a silenced competitor that THIS checkout never disabled → uninstall leaves it alone.
  apply(plan(proj, { home, root, env }), { env, home });
  const m = JSON.parse(readFileSync(paths.manifest, "utf8")); m[S.provenance_key].disabled = ["projectstore@SmartAndPoint"]; writeFileSync(paths.manifest, JSON.stringify(m));
  const un = plan(proj, { home, root, env, mode: "uninstall" });
  assert.ok(!hostArgv(item(un, "plugin")).includes("plugin enable"), "not disabled here → not re-enabled here");
  // A cache root asked for the surface by name says why it does nothing.
  const cacheRoot = fakeInstall(home, "0.28.0", { full: true });
  const asked = plan(proj, { home, root: cacheRoot, env, surfaces: ["plugin"] });
  // The fake cache install's tree is not this package's payload, so the directory reads stale from it — and a cache root only reports.
  assert.equal(item(asked, "plugin").action, "skip");
  assert.equal(item(asked, "plugin").deferred, true);
  assert.match(item(asked, "plugin").reason, /this root is the host's own install/);
  const empty = sandbox();
  const asked2 = plan(empty.proj, { home: empty.home, root: fakeInstall(empty.home, "0.28.0", { full: true }), env: empty.env, surfaces: ["plugin"] });
  assert.match(item(asked2, "plugin").reason, /does not register a second copy of itself/);
});

const REAL = whichOnPath(S.cli.bin, process.env);
test("registration: the real host CLI, sandboxed by the pinned home, registers and forgets a temporary project", { skip: !REAL && "no host CLI on PATH" }, () => {
  const sb = sandbox();
  const { home, proj, root, paths, registry, local } = sb;
  const env = noHostEnv({ PATH: process.env.PATH });
  const p = plan(proj, { home, root, env });
  assert.equal(sb.item(p, "plugin").action, "create");
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done, null, 2));
  const row = registry().plugins[ID].find((r) => r.projectPath === proj);
  assert.ok(row, JSON.stringify(registry()));
  assert.equal(row.scope, "local");
  assert.equal(row.version, "0.28.0");
  assert.equal(local().enabledPlugins[ID], true);
  assert.ok(existsSync(join(row.installPath, "bin", "projectstore.mjs")), "the host copied the payload into its cache");
  assert.equal(analyseRegistration(proj, S, { root, home, harness: SRC, env }).state, "current");
  const un = runVerb("uninstall", proj, { home, root, env, harnesses: [SRC.id] });
  return un.then((r) => {
    assert.equal(r.failed, null, JSON.stringify(r.applied, null, 2));
    assert.ok(!existsSync(paths.dir));
    assert.equal((registry().plugins[ID] || []).length, 0);
  });
});

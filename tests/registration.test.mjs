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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fakeInstall, fakePackageRoot, fakeClaude, noHostEnv, writeRegistry, installEnv, legacyProject } from "./fixtures/install.mjs";
import { plan, renderPreview, apply, runVerb, publicItem, renderDone, applyReporter } from "../scripts/install-harness.mjs";
import { analyseRegistration, registrationPaths, surfaceStates } from "../scripts/surfaces.mjs";
import { sourceHarness, loadHarness, packageCommand } from "../scripts/harness.mjs";
import { PLAIN } from "../scripts/term.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { fakeNpmSpawn, registryFetch, instantTimers, FAKE_REGISTRY } from "./fixtures/fetch.mjs";
import { statusLineLauncherPath, whichOnPath, treeFiles, installedPluginEntries, installedPluginRoot, layoutPaths, cmpPrecedence, cmpVersion } from "../scripts/lib.mjs";
import { parseProvenance } from "../scripts/provenance.mjs";
import { checkPluginRegistration, checkVersionDrift, checkAutoUpdate } from "../scripts/doctor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CODEX = loadHarness("codex");
const S = SRC.surfaces.plugin;
const ID = `${S.plugin_name}@${S.marketplace_name}`;
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
const PACKLIST = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "packlist.json"), "utf8"));
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

delete process.env[SRC.runtime.home_env];

// `npx`: the package root in npx's own shape, <cache>/_npx/<hash>/node_modules/<name>.
// `vault`: a temporary vault instead of a path that does not exist, for a case
// that spawns the hook or doctor — both read the vault, and the hook writes
// its session record there.
function sandbox({ version = "0.28.0", statusline = true, npx = false, vault = false } = {}) {
  const home = tmp("ps-reg-home-");
  const proj = tmp("ps-reg-proj-");
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  writeBinding(proj, JSON.stringify({ vault_path: vault ? tmp("ps-reg-vault-") : "/tmp/nowhere", layout: "engineering", ...(statusline ? { statusline: { enabled: true } } : {}) }));
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const root = fakePackageRoot(join(tmp("ps-reg-npx-"), ...(npx ? ["_npx", "4f1c2a9e7b3d5c60"] : []), "node_modules", "projectstore"), version);
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
  // …and the files each one touches, project-relative where they are the project's (contract 9's consent content).
  const shown = (t) => (relative(proj, t).startsWith("..") ? t : relative(proj, t));
  for (const s of reg.steps.filter((s) => s.kind === "host" && s.touches.length)) assert.ok(preview.includes(`touches ${s.touches.map(shown).join(", ")}`), `preview names what ${s.name} touches`);
  assert.ok(renderPreview(p, { verbose: true }).includes("planned against the host's install path"), "--verbose names the install path the plan is made against");
  assert.ok(preview.includes(`harness home ${reg.home}, scope local`));
  assert.ok(preview.includes("Each $ line runs the host's own CLI"));
  assert.equal(host.log().length, 0, "plan runs nothing");
  assert.ok(!existsSync(paths.dir), "plan writes nothing");
  // What each host step is previewed as touching. Claude Code's registry is its
  // JSON files, so a portable registration's global config (S8, 2026-10-04)
  // never appears here.
  assert.deepEqual(Object.fromEntries(reg.steps.filter((s) => s.kind === "host").map((s) => [s.name, s.touches])), {
    validate: [],
    marketplace_add: [paths.marketplaces, paths.projectSettings],
    install: [paths.installed, paths.projectSettings, paths.cacheDir],
  });
  // publicItem drops the manifest bodies from steps, keeps the argv — and keeps
  // the write's file count, which a public envelope had until 4aa142d
  // stripped `files` from every step (S1, the 2026-10-03 review).
  const pub = publicItem(reg);
  assert.ok(pub.steps.every((s) => !("manifest" in s)));
  assert.equal(pub.steps.find((s) => s.kind === "write").files, PACKLIST.length, "the write's file count survives");
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
  assert.deepEqual(checkPluginRegistration(proj, [st], { home }).map((f) => f.level), ["info"]);
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

// The npm channel's release candidates: a registration made at rc.2 read as
// current against rc.3 and against 0.28.0, because the comparison stopped at the
// triple — `upgrade` never refreshed it (the critic's probe, 2026-10-03).
test("registration contract 4′/14: a registration made at a release candidate refreshes from the next candidate and from the release, and a release is never downgraded to its candidate", () => {
  const sb = sandbox({ version: "0.28.0-rc.2" });
  const { home, proj, root, host, env, item, paths, registry } = sb;
  apply(plan(proj, { home, root, env }), { env, home });
  for (const version of ["0.28.0-rc.3", "0.28.0"]) {
    host.reset();
    const next = fakePackageRoot(join(tmp("ps-reg-npx-rc-"), "node_modules", "projectstore"), version);
    const p = plan(proj, { home, root: next, env, mode: "install" });
    const reg = item(p, "plugin");
    assert.equal(reg.state, "stale", `${version} over the previous registration`);
    assert.match(reg.reason, /plugin updated/);
    assert.deepEqual(hostArgv(reg), ["plugin validate", "plugin update"]);
    const done = apply(p, { env, home });
    assert.equal(done.failed, undefined, JSON.stringify(done));
    assert.equal(registry().plugins[ID][0].version, version);
    assert.equal(JSON.parse(readFileSync(paths.manifest, "utf8"))[S.provenance_key].pkg, version);
  }
  host.reset();
  const back = plan(proj, { home, root, env });
  assert.equal(item(back, "plugin").state, "current");
  assert.match(item(back, "plugin").reason, /newer than this package.*not downgraded/);
  assert.equal(host.log().length, 0);
});

test("cmpPrecedence: a candidate ranks below its release and by its own counter, an alphanumeric identifier above a numeric one, and build metadata never ranks", () => {
  const order = ["0.27.1", "0.28.0-1", "0.28.0-alpha", "0.28.0-rc.1", "0.28.0-rc.2", "0.28.0-rc.10", "0.28.0", "0.28.1-rc.1", "0.28.1", "0.29.0"];
  for (let i = 0; i < order.length; i++)
    for (let j = 0; j < order.length; j++)
      assert.equal(Math.sign(cmpPrecedence(order[i], order[j])), Math.sign(i - j), `${order[i]} against ${order[j]}`);
  assert.equal(cmpPrecedence("0.28.0-rc.2+codex.dev.15c346cc0791", "0.28.0-rc.2"), 0);
  assert.equal(cmpVersion("0.28.0-rc.2", "0.28.0"), 0, "cmpVersion keeps comparing the release triple, which the layout window's sunset wants");
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
  assert.ok(renderPreview(p).includes(`$ ${[silence.steps[0].bin, ...silence.steps[0].argv].join(" ")}`), "the disable command is in the default preview");
  assert.match(renderPreview(p, { verbose: true }), /silenced in this checkout's local settings only, never globally/);
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(local().enabledPlugins["projectstore@SmartAndPoint"], false);
  assert.equal(local().enabledPlugins[ID], true);
  assert.ok(!existsSync(paths.userSettings), "the user's global enablement is untouched");
  assert.deepEqual(JSON.parse(readFileSync(paths.manifest, "utf8"))[S.provenance_key].disabled, ["projectstore@SmartAndPoint"]);
  // doctor: version drift is quiet — the other row is disabled for this project; the registration is one info.
  const states = surfaceStates(proj, { home, root }).states;
  assert.deepEqual(checkVersionDrift(home, states, proj), [], "a copy disabled for the project is not a drift (contract 17, amended)");
  const doc = checkPluginRegistration(proj, states, { home });
  assert.deepEqual(doc.map((f) => f.level), ["info", "info"]);
  // The copy it turned off is named, with the way back (contract 13 as amended after the rc.3 tag).
  const off = doc.find((f) => f.message.startsWith("projectstore@SmartAndPoint"));
  assert.ok(off, JSON.stringify(doc));
  assert.match(off.message, /\(0\.27\.1\) is off for this checkout/);
  assert.match(off.message, /Update that copy first/, "0.27.x reads a moved project as unbound");
  assert.match(off.message, /npx projectstore-claude@\S+ uninstall --surface plugin --project/);
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
  assert.match(renderPreview(un, { verbose: true }), /marketplace remove.*would drop every checkout's rows/);
  const undone = apply(un, { env, home });
  assert.equal(undone.failed, undefined, JSON.stringify(undone));
  assert.equal(local().enabledPlugins["projectstore@SmartAndPoint"], true, "the silenced copy is turned back on");
  assert.ok(!checkPluginRegistration(proj, surfaceStates(proj, { home, root }).states, { home }).some((f) => /is off for this checkout/.test(f.message)), "and doctor no longer names it");
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
  assert.equal(checkPluginRegistration(proj, [st], { home })[0].check, "plugin-registration-foreign");
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
  // What the user reads: STOPPED, the argv with its exit status, the host's
  // own words, and that the surfaces planned against the install path wait.
  const line = renderDone({ verb: "install", plan: p, applied: done, failed: done.failed, elapsed: 0 });
  assert.match(line, /Stopped — \d+ changes? applied, then a host command failed/);
  assert.match(line, /✕ \$ claude plugin install .* exited 1/);
  assert.match(line, /failed as instructed/);
  assert.match(line, /planned against its install path were not written/);
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
  assert.deepEqual(checkPluginRegistration(proj2, surfaceStates(proj2, { home, root, harnesses: [SRC.id] }).states, { home }), [], "no nag in a checkout that never registered");
  // Two enabled copies in the registered checkout.
  const other = fakeInstall(home, "0.27.1");
  const reg = JSON.parse(readFileSync(sb.paths.installed, "utf8"));
  reg.plugins["projectstore@SmartAndPoint"] = [{ scope: "user", installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }];
  writeFileSync(sb.paths.installed, JSON.stringify(reg));
  const states = surfaceStates(sb.proj, { home, root }).states;
  const f = checkPluginRegistration(sb.proj, states, { home: sb.home });
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

// The way back for a project the plain shell switched to npm, named by doctor
// (the install spec, contract 13 as amended after the rc.3 tag): rc.1 and
// rc.2's startup offer left exactly this, and nothing said so.
test("registration contract 13: doctor names each copy the registration silenced and the checkout still holds off — update first only below 0.28, stale once uninstalled, never a copy held off by hand", () => {
  const sb = sandbox();
  const { home, proj, root, env, paths, local, registry } = sb;
  const git = fakeInstall(home, "0.28.0-rc.2");
  writeRegistry(home, [{ scope: "user", installPath: git, version: "0.28.0-rc.2", lastUpdated: "2026-09-07T00:00:00Z" }]);
  apply(plan(proj, { home, root, env }), { env, home });
  const offs = () => checkPluginRegistration(proj, surfaceStates(proj, { home, root }).states, { home }).filter((f) => /off for this checkout|held off/.test(f.message));
  let off = offs();
  assert.equal(off.length, 1, JSON.stringify(off));
  assert.match(off[0].message, /^projectstore@SmartAndPoint \(0\.28\.0-rc\.2\) is off for this checkout/);
  assert.doesNotMatch(off[0].message, /Update that copy first/, "a 0.28 release candidate reads a moved project");
  // A key held off by hand, which the registration never recorded, is not ours to name.
  const s = local(); s.enabledPlugins["projectstore@elsewhere"] = false; writeFileSync(paths.projectSettings, JSON.stringify(s, null, 2));
  assert.ok(!offs().some((f) => f.message.includes("projectstore@elsewhere")));
  // The recorded copy turned back on by hand: the checkout loads it again, so nothing to say.
  const on = local(); on.enabledPlugins["projectstore@SmartAndPoint"] = true; writeFileSync(paths.projectSettings, JSON.stringify(on, null, 2));
  assert.deepEqual(offs(), []);
  on.enabledPlugins["projectstore@SmartAndPoint"] = false; writeFileSync(paths.projectSettings, JSON.stringify(on, null, 2));
  // Another checkout's local row is not the copy this checkout loads, however old.
  const r0 = registry(); r0.plugins["projectstore@SmartAndPoint"].unshift({ ...r0.plugins["projectstore@SmartAndPoint"][0], scope: "local", projectPath: "/elsewhere/checkout", version: "0.27.1" }); writeFileSync(paths.installed, JSON.stringify(r0, null, 2));
  assert.doesNotMatch(offs()[0].message, /Update that copy first/, "the user-scope 0.28 rc row is the one this checkout loads");
  r0.plugins["projectstore@SmartAndPoint"].shift(); writeFileSync(paths.installed, JSON.stringify(r0, null, 2));
  // A row with no version reads as old.
  const r = registry(); r.plugins["projectstore@SmartAndPoint"][0].version = null; writeFileSync(paths.installed, JSON.stringify(r, null, 2));
  assert.match(offs()[0].message, /Update that copy first/);
  // The silenced copy uninstalled since: no row, so the local entry is stale.
  const r2 = registry(); r2.plugins["projectstore@SmartAndPoint"] = []; writeFileSync(paths.installed, JSON.stringify(r2, null, 2));
  off = offs();
  assert.equal(off.length, 1);
  assert.match(off[0].message, /no longer installed, so the entry is stale/);
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

// --no-register (and a --surface that excludes the registration) still reads
// the registration for the render root — before the surfaces that render
// against it. Read after them, it moved only the preview line, and a run from
// a package root re-pointed the status line at that root (the second review of
// the 2026-10-03 fixes, S1).
test("registration: a run that leaves the registration out still renders the project's surfaces against its install path", () => {
  const sb = sandbox();
  const { home, proj, root, env, item } = sb;
  const done = apply(plan(proj, { home, root, env }), { env, home });
  assert.ok(!done.failed, JSON.stringify(done.failed));
  const installPath = item(plan(proj, { home, root, env }), "plugin").root;
  assert.ok(installPath, "the registration is current and names its install path");
  const p = plan(proj, { home, root, env, register: false });
  assert.ok(!p.items.some((i) => i.kind === "registration"), "no registration row");
  assert.equal(p.plannedAgainst[SRC.id], installPath);
  for (const k of ["statusline_launcher", "statusline"]) {
    const it = item(p, k);
    if (it) assert.equal(it.plannedAgainst, installPath, `${k} is planned against the install path`);
  }
  assert.ok(item(p, "statusline_launcher") || item(p, "statusline"), "a status-line surface was planned");
  // The --surface half: a run narrowed to the status line reads the left-out
  // registration the same way…
  const narrowed = plan(proj, { home, root, env, surfaces: ["statusline"] });
  assert.equal(item(narrowed, "statusline").plannedAgainst, installPath, "--surface statusline renders against the install path");
  // …and only an enabled one: disabled for this project, it decides nothing.
  const sp = join(proj, CFG_DIR, "settings.local.json");
  const s0 = JSON.parse(readFileSync(sp, "utf8"));
  writeFileSync(sp, JSON.stringify({ ...s0, enabledPlugins: { ...(s0.enabledPlugins || {}), [item(plan(proj, { home, root, env }), "plugin").entry]: false } }, null, 2) + "\n");
  assert.equal(item(plan(proj, { home, root, env, surfaces: ["statusline"] }), "statusline").plannedAgainst, undefined, "a disabled registration is not the render root");
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

// Contract 19: a host command that cannot start names its cause. Node says
// `spawnSync claude ENOENT` for a binary not on PATH and for a working
// directory that does not exist alike; the run says which.
test("registration contract 19: a host command whose binary is gone says it was not found on PATH, never spawnSync's ENOENT", () => {
  const { home, proj, root, host } = sandbox();
  const p = plan(proj, { home, root, env: host.env() });
  rmSync(host.bin);
  const done = apply(p, { env: { ...host.env(), PATH: dirname(host.bin) }, home });
  assert.ok(done.failed, "the run stops");
  assert.match(done.failed.stderr, /^claude could not start: it was not found on PATH/, done.failed.stderr);
  assert.ok(!/spawnSync/.test(JSON.stringify(done.failed)), JSON.stringify(done.failed));
});

// The story "The SessionStart hook and install agree on the status line of an
// npm registration loaded from its marketplace directory": the host loads this
// registration's plugin in place from the marketplace payload (measured on
// 2.1.293 and 2.1.296), so its hooks and its doctor run from paths.payload —
// neither the cache install the launcher is rendered for nor the package.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("registration: recovery from a demoted entry — from an _npx root the plan reads the payload script's entry ours-stale and the launcher current, and after apply a SessionStart run from the marketplace payload keeps the launcher entry", () => {
  const sb = sandbox({ npx: true, vault: true });
  const { home, proj, root, env, item, paths, local } = sb;
  assert.match(root, /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]/, "an npx-shaped package root");
  const first = apply(plan(proj, { home, root, env }), { env, home });
  assert.equal(first.failed, undefined, JSON.stringify(first));
  const launcher = statusLineLauncherPath(proj);
  const launcherBytes = readFileSync(launcher, "utf8");
  // This machine on 2026-10-07: a session run from the marketplace payload
  // re-pointed install's entry at the payload's own script; the launcher stayed.
  const settingsPath = join(proj, CFG_DIR, "settings.local.json");
  writeFileSync(settingsPath, JSON.stringify({ ...local(), statusLine: { type: "command", command: `node "${join(paths.payload, "scripts", "statusline.mjs")}"` } }, null, 2) + "\n");

  const p = plan(proj, { harnesses: [SRC.id], home, root, env });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.deepEqual([item(p, "plugin").state, item(p, "plugin").action], ["current", "skip"]);
  assert.deepEqual([item(p, "statusline").state, item(p, "statusline").action], ["ours-stale", "replace-entry"], "the payload's script is ours, recognised by its directory's provenance field — no longer `theirs`");
  assert.deepEqual([item(p, "statusline_launcher").state, item(p, "statusline_launcher").action], ["current", "skip"]);
  assert.equal(item(p, "statusline").after.statusLine.command, `node "${launcher}"`);
  assert.match(p.reports[0], new RegExp(`install path ${escapeRe(item(p, "plugin").root)}; the host loads them in place from ${escapeRe(paths.payload)}\\.`), "the host-managed report names the install path and the plugin root it loads in place");
  assert.ok(!("payload" in item(p, "plugin")), "the plan item keeps its shape");

  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(local().statusLine.command, `node "${launcher}"`);
  const settled = readFileSync(settingsPath, "utf8");
  // A SessionStart as the host runs it: the payload's own hook, its plugin root the payload.
  const hook = spawnSync(process.execPath, [join(paths.payload, "hooks", "session-start.mjs")], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "recovery-1", source: "startup", cwd: proj }), env: installEnv(home, paths.payload, proj), cwd: proj, timeout: 30000 });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(readFileSync(settingsPath, "utf8"), settled, "the entry still names the launcher, byte for byte");
  assert.equal(readFileSync(launcher, "utf8"), launcherBytes, "and the launcher is as install wrote it");
});

test("registration: doctor --install run from the marketplace payload the host loads in place, and from a package root, reads the launcher against the registration's install path — never 'not produced for this installation'", () => {
  const sb = sandbox({ npx: true, vault: true });
  const { home, proj, root, env, paths, registry, host } = sb;
  const done = apply(plan(proj, { home, root, env }), { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  const installPath = registry().plugins[ID][0].installPath;
  for (const [where, from] of [["the marketplace payload", paths.payload], ["the package root", root]]) {
    // The states doctor derives, in-process against this sandbox's home.
    const launcher = surfaceStates(proj, { home, root: from, env }).states.find((x) => x.surface === "statusline_launcher");
    assert.deepEqual([launcher.produced, launcher.state], [true, "current"], where);
    // The verb itself, from that root's own bin, as a terminal runs it.
    const r = spawnSync(process.execPath, [join(from, "bin", "projectstore.mjs"), "doctor", "--install", "--json", "--project", proj], { encoding: "utf8", cwd: proj, env: host.env({ HOME: home }), timeout: 60000, maxBuffer: 1 << 24 });
    const findings = JSON.parse(r.stdout).result;
    assert.ok(!findings.some((f) => /not produced for this installation/.test(f.message)), `${where}: ${JSON.stringify(findings, null, 2)}`);
    const info = findings.find((f) => f.check === "plugin-registration" && f.level === "info");
    assert.ok(info && info.message.includes(`(install path ${installPath}; loaded in place from ${paths.payload})`), `${where}: ${JSON.stringify(findings, null, 2)}`);
  }
});

// Contract 2, amended 2026-10-10: one reader of the provenance field. The
// apply-time re-check reads it through that reader too, so a field that is not
// ours in shape (no pkg) is foreign there exactly as it is to the plan.
test("registration contract 2/5: a directory that appears at our path between plan and apply, its manifest's provenance field not ours in shape, is refused at apply and left byte-identical", () => {
  const sb = sandbox();
  const { home, proj, root, env, paths, host } = sb;
  const p = plan(proj, { home, root, env });
  assert.equal(sb.item(p, "plugin").action, "create");
  mkdirSync(dirname(paths.manifest), { recursive: true });
  const theirs = JSON.stringify({ name: "theirs", plugins: [], [S.provenance_key]: true }) + "\n";
  writeFileSync(paths.manifest, theirs);
  const done = apply(p, { env, home });
  assert.ok(done.failed, "the run stops");
  assert.match(JSON.stringify(done.failed), /changed under the plan: its manifest is no longer ours/);
  assert.equal(readFileSync(paths.manifest, "utf8"), theirs, "nothing is written over it");
  assert.ok(!existsSync(paths.payload), "no payload copied in");
  assert.equal(host.log().length, 0, "no host command ran");
});

// ─── Never downgrade, never another project's (the converge story) ───────
//
// PS-HARNESS: "Setup and upgrade converge this project onto the running
// version: the channel switch, no downgrade, and the update notice", rules 6
// and 7. Every registry read is an injected fetch against a temporary cache;
// the registry resolver is the in-process npm; the host is the logging fake.

// One upgrade through runVerb from `root`, its registry read injected. Text
// mode answers "n" at the terminal double and records whether it was asked;
// `json` is the named run without a terminal.
async function convergeRun(sb, root, { latest = "0.31.0", mode = null, json = false, extra = {}, timers, harnesses = [SRC.id], channel = null } = {}) {
  const env = sb.host.env({ PROJECTSTORE_NO_UPDATE_CHECK: "", CI: "", XDG_CACHE_HOME: join(tmp("ps-reg-xdg-"), "cache"), ...extra });
  for (const k of ["FORCE_COLOR", "TERM", "NO_COLOR", "PROJECTSTORE_ASCII"]) delete env[k];
  const reg = registryFetch(mode ?? { latest });
  const npm = fakeNpmSpawn();
  const chunks = [];
  let asked = false;
  const out = { isTTY: false, write: (s) => { chunks.push(String(s)); return true; } };
  const r = await runVerb("upgrade", sb.proj, { harnesses, home: sb.home, root, env, fetch: reg.fetch, timers, fetchSpawn: npm.spawn, channel, ...(json ? { json: true } : { out, ask: async () => { asked = true; return "n"; } }) });
  return { r, text: chunks.join(""), asked, reg, npm, env };
}

// What a run may not touch, byte for byte: the project's files and the host's registry.
function snapshot(sb) {
  const files = [sb.paths.projectSettings, join(sb.proj, "CLAUDE.md"), layoutPaths(sb.proj).binding, statusLineLauncherPath(sb.proj), sb.paths.installed, sb.paths.manifest, sb.paths.marketplaces];
  return Object.fromEntries(files.map((f) => [f, existsSync(f) ? readFileSync(f, "utf8") : null]));
}

test("converge criterion 'The stop (Claude Code)': this checkout's npm row at 0.31.0, the package at 0.30.0 and latest 0.31.0 — upgrade refuses before the question, fetches, writes and runs nothing, and names both versions and two commands alone on their lines", async () => {
  const sb = sandbox({ version: "0.31.0", npx: true });
  const { home, proj, host, env } = sb;
  assert.equal(apply(plan(proj, { home, root: sb.root, env }), { env, home }).failed, undefined);
  host.reset();
  const older = fakePackageRoot(join(tmp("ps-reg-old-"), "_npx", "0a1b", "node_modules", "projectstore"), "0.30.0");
  const before = snapshot(sb);
  const s = await convergeRun(sb, older);
  assert.equal(s.r.plan.ok, false);
  assert.ok(s.r.plan.refusals[0].startsWith("this project runs projectstore 0.31.0 (projectstore@projectstore-npm), newer than this package (0.30.0), and 0.31.0 is published. Nothing is written."), s.r.plan.refusals[0]);
  assert.deepEqual(s.r.gate, { confirmed: false, why: "refused" });
  assert.equal(s.asked, false, "refused before the question");
  assert.deepEqual(s.r.plan.items, [], "nothing is planned");
  assert.deepEqual(s.r.fetched, [], "no shell is fetched");
  assert.deepEqual(s.npm.installs(), []);
  assert.deepEqual(host.log(), [], "no host command runs");
  assert.deepEqual(snapshot(sb), before, "nothing is written");
  assert.equal(s.reg.calls.length, 1, "the registry is read once");
  // Each command alone on its line, after a blank one; nothing after it.
  const lines = s.text.split("\n");
  const at = lines.indexOf(`    npx projectstore@latest upgrade --harness ${SRC.id}`);
  assert.ok(at > 0 && lines[at - 1] === "", s.text);
  assert.deepEqual(lines.slice(at + 1, at + 5), ["", "  or install it for the whole machine:", "", "    npm install -g projectstore@latest"], s.text);
  assert.match(lines.find((l) => l.includes("▲ refused")), /▲ refused {2}this project runs projectstore 0\.31\.0 \(projectstore@projectstore-npm\), newer than this package \(0\.30\.0\)/);
  assert.ok(!s.text.includes("newer published"), "no notice beside the stop: the refusal names the update");
  assert.ok(!s.r.plan.refusals[0].includes("--project"));
  assert.ok(!Object.keys(s.r.plan).includes("stop"), "the commands stay off the envelope");
  // --json, and CI=1: the read still happens (it decides what is written), and it writes the cache.
  const j = await convergeRun(sb, older, { json: true, extra: { CI: "1" } });
  assert.equal(j.r.plan.ok, false);
  assert.ok(j.r.plan.refusals[0].includes(`npx projectstore@latest upgrade --harness ${SRC.id}`) && j.r.plan.refusals[0].includes("npm install -g projectstore@latest"), j.r.plan.refusals[0]);
  assert.equal(j.reg.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(j.env.XDG_CACHE_HOME, "projectstore", "registry.json"), "utf8"))[FAKE_REGISTRY].latest, "0.31.0");
  assert.deepEqual(host.log(), []);
  // latest 0.30.0: the run proceeds, and the row names both versions and the case.
  const below = await convergeRun(sb, older, { latest: "0.30.0" });
  assert.equal(below.r.plan.ok, true);
  const row = sb.item(below.r.plan, "plugin");
  assert.equal(row.action, "skip");
  assert.match(row.reason, /^the directory is at 0\.31\.0, newer than this package \(0\.30\.0\) — not downgraded; the registry's latest \(0\.30\.0\) does not reach 0\.31\.0$/);
  assert.ok(below.text.includes(row.reason), "the default view shows it");
  // One request serves both: rule 6's case and, from this _npx root, the notice.
  const shared = await convergeRun(sb, older, { latest: "0.30.5" });
  assert.equal(shared.reg.calls.length, 1, "one request per run, whether or not rule 6 needed it too");
  assert.ok(shared.text.includes("\n  ▲ newer published: 0.30.5 (this is 0.30.0). To update:\n\n    npx projectstore@latest upgrade\n\n"), shared.text);
  assert.match(sb.item(shared.r.plan, "plugin").reason, /the registry's latest \(0\.30\.5\) does not reach 0\.31\.0$/);
  // A fetch that never settles, cut at the injected 2 s bound; the switch off.
  const timers = instantTimers();
  const hung = await convergeRun(sb, older, { mode: "hang", timers });
  assert.deepEqual(timers.asked, [2000]);
  assert.match(sb.item(hung.r.plan, "plugin").reason, /not downgraded; the registry could not be read \(no answer within 2 s\)$/);
  const off = await convergeRun(sb, older, { extra: { PROJECTSTORE_NO_UPDATE_CHECK: "1" } });
  assert.equal(off.reg.calls.length, 0);
  assert.match(sb.item(off.r.plan, "plugin").reason, /not downgraded; the registry was not read \(PROJECTSTORE_NO_UPDATE_CHECK\)$/);
  // A run from a host cache copy — the copy this checkout's session runs — never stops and reads nothing.
  const cached = await convergeRun(sb, sb.registry().plugins[ID][0].installPath);
  assert.equal(cached.r.plan.ok, true, JSON.stringify(cached.r.plan.refusals));
  assert.equal(cached.reg.calls.length, 0);
  // plan reads nothing; its newer row says what install and upgrade do first.
  const dry = plan(proj, { harnesses: [SRC.id], home, root: older, env });
  assert.match(sb.item(dry, "plugin").reason, /not downgraded; install and upgrade read the registry first, and stop when 0\.31\.0 is published$/);
  assert.deepEqual(host.log(), [], "nothing ran through any of it");
});

test("converge criterion 'The stop (Claude Code)': a git copy at 0.31.0 enabled at user scope stops channel null; with Codex in the same bare run, nothing is fetched", async () => {
  const sb = sandbox({ version: "0.30.0", npx: true });
  const { home, proj, host } = sb;
  const git = fakeInstall(home, "0.31.0");
  writeRegistry(home, [{ scope: "user", installPath: git, version: "0.31.0", lastUpdated: "2026-10-01T00:00:00Z" }]);
  const s = await convergeRun(sb, sb.root);
  assert.equal(s.r.plan.ok, false);
  assert.match(s.r.plan.refusals[0], /^this project runs projectstore 0\.31\.0 \(projectstore@SmartAndPoint\), newer than this package \(0\.30\.0\), and 0\.31\.0 is published/);
  assert.equal(s.asked, false);
  // The channel "npm" alike: the answer to the channel question does not
  // make the older package's run over a published newer copy a choice.
  const npm = await convergeRun(sb, sb.root, { channel: "npm" });
  assert.equal(npm.r.plan.ok, false);
  assert.equal(npm.r.plan.refusals[0], s.r.plan.refusals[0], "the same stop, word for word");
  assert.equal(npm.asked, false);
  assert.deepEqual(npm.r.plan.items, []);
  // …and never the channel "git": its run renders nothing for Claude Code, so
  // no host plugin copy counts and rule 6 reads nothing (--json: no notice).
  const kept = await convergeRun(sb, sb.root, { channel: "git", json: true });
  assert.ok(!kept.r.plan.stop, "not the stop");
  assert.ok(!/is published/.test(kept.r.plan.refusals.join("\n")), kept.r.plan.refusals.join("\n"));
  assert.equal(kept.reg.calls.length, 0, "no registry read");
  // A bare upgrade at a terminal that would fetch Codex's shell: the stop comes first.
  mkdirSync(join(proj, CODEX.runtime.harness_dir), { recursive: true });
  writeFileSync(join(host.dir, CODEX.surfaces.plugin.cli.bin), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const codexHome = { [CODEX.runtime.home_env]: tmp("ps-reg-codex-home-") };
  const both = await convergeRun(sb, sb.root, { harnesses: [], extra: codexHome });
  assert.equal(both.r.plan.ok, false);
  assert.deepEqual(both.r.plan.harnesses, [SRC.id, CODEX.id]);
  assert.equal(both.r.plan.stop.commands[0], "npx projectstore@latest upgrade", "a bare run's command names no harness");
  assert.deepEqual(both.npm.installs(), [], "no shell is fetched");
  // …where the same run with the registry below the copy fetches Codex's shell.
  const fetching = await convergeRun(sb, sb.root, { latest: "0.30.0", harnesses: [], extra: codexHome });
  assert.equal(fetching.npm.installs().length, 1);
  assert.deepEqual(host.log(), []);
});

test("converge criterion 'A newer git copy is not switched off for an older package': channel null defers the registration and the switch, names both versions, the case and the ways this release offers — each command alone on its line — runs no host command and is incomplete", async () => {
  const sb = sandbox({ version: "0.30.0", npx: true });
  const { home, proj, host, local } = sb;
  const git = fakeInstall(home, "0.31.0", { full: true });
  writeRegistry(home, [{ scope: "user", installPath: git, version: "0.31.0", lastUpdated: "2026-10-01T00:00:00Z" }]);
  const s = await convergeRun(sb, sb.root, { latest: "0.30.0", json: true });
  const reg = sb.item(s.r.plan, "plugin");
  const others = sb.item(s.r.plan, "plugin_others");
  for (const i of [reg, others]) {
    assert.equal(i.action, "skip", i.surface);
    assert.equal(i.deferred, true, i.surface);
  }
  const ownBin = `node "${join(git, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register`;
  const disable = `${S.cli.bin} plugin disable projectstore@SmartAndPoint --scope local`;
  assert.equal(reg.reason, [
    "this project runs a newer copy (projectstore@SmartAndPoint 0.31.0) than this package (0.30.0), so it is not switched off — the registry's latest (0.30.0) does not reach 0.31.0.",
    "Run the newer copy instead, from a terminal in this project:",
    ownBin,
    "Or move this project to this package's registration, the older 0.30.0: turn that copy off for this project, then repeat this run:",
    disable,
  ].join("\n"), "the envelope's reason, every part on its own line");
  assert.equal(others.reason, `not switched off — see ${ID} above`, "the long reason prints once; the switch row points to it");
  assert.ok(!("advice" in publicItem(reg)), "the drawn form stays off the envelope");
  assert.ok(!/`|\bsetup\b/.test(reg.reason), "no backticks, and no verb this release lacks");
  assert.ok(!(reg.steps || []).length && !(others.steps || []).length, "no host step is planned");
  assert.equal(s.r.plan.incomplete, true, "so the exit is 1");
  assert.equal(s.r.gate.why, "named");
  assert.deepEqual(host.log(), [], "no host command runs");
  assert.notEqual(local()?.enabledPlugins?.["projectstore@SmartAndPoint"], false, "the copy stays on for this checkout");
  // In PLAN: the prose once, then each command alone on its line after a blank one.
  const t = await convergeRun(sb, sb.root, { latest: "0.30.0" });
  const lines = t.text.split("\n");
  for (const cmd of [ownBin, disable]) {
    const at = lines.indexOf(`          ${cmd}`);
    assert.ok(at > 0 && lines[at - 1] === "" && lines[at + 1] === "", `${cmd}:\n${t.text}`);
  }
  assert.equal(t.text.split("so it is not switched off").length, 2, "printed once");
  assert.ok(t.text.includes(`not switched off — see ${ID} above`));
  assert.ok(!/\bsetup\b/.test(t.text), t.text);
  // plan reads nothing; the deferral says what install and upgrade do first.
  assert.match(sb.item(plan(proj, { harnesses: [SRC.id], home, root: sb.root, env: sb.env }), "plugin").reason, /install and upgrade read the registry first, and stop when 0\.31\.0 is published/);
  // The channel "npm" is the answer to the channel question: the switch
  // proceeds, and its row names both versions, the case, and that the project
  // will run the older one — in the default view, beneath the consequence.
  const n = await convergeRun(sb, sb.root, { latest: "0.30.0", channel: "npm" });
  assert.equal(sb.item(n.r.plan, "plugin").action, "create");
  const sw = sb.item(n.r.plan, "plugin_others");
  assert.equal(sw.action, "disable");
  assert.equal(sw.reason, "projectstore@SmartAndPoint 0.31.0 is newer than this package (0.30.0) — the registry's latest (0.30.0) does not reach 0.31.0; turning it off runs this project on the older 0.30.0");
  assert.equal(n.r.plan.incomplete, false);
  assert.equal(n.asked, true, "asked at the terminal double, as any change");
  const at = n.text.indexOf("⇄ switch");
  assert.ok(at > 0 && n.text.indexOf("from now on it is updated by") > at && n.text.indexOf(sw.reason) > n.text.indexOf("from now on it is updated by"), n.text);
  assert.deepEqual(host.log(), [], "declined: nothing ran");
});

// F3 of the PR1 review: the Claude Code counterpart of Codex's damaged newer
// registration (tests/codex-registration.test.mjs).
test("converge rule 6 (Claude Code): our directory newer than the package and off its digest is planned skip with the repair from its own version — never rewritten from the older package", async () => {
  const sb = sandbox({ version: "0.31.0", npx: true });
  const { home, proj, host, env, paths } = sb;
  assert.equal(apply(plan(proj, { home, root: sb.root, env }), { env, home }).failed, undefined);
  host.reset();
  writeFileSync(join(paths.payload, "README.md"), "edited by hand\n");
  const manifest = readFileSync(paths.manifest, "utf8");
  const older = fakePackageRoot(join(tmp("ps-reg-old-"), "_npx", "0c", "node_modules", "projectstore"), "0.30.0");
  const s = await convergeRun(sb, older, { latest: "0.30.0", json: true });
  const row = sb.item(s.r.plan, "plugin");
  assert.equal(row.action, "skip");
  assert.equal(row.deferred, true);
  assert.equal(row.reason, [
    "the directory holds 0.31.0, newer than this package (0.30.0), and its payload does not match its digest (edited by hand or half-written); the registry's latest (0.30.0) does not reach 0.31.0",
    "not downgraded — repair it from its own version:",
    `npx projectstore@0.31.0 upgrade --harness ${SRC.id}`,
  ].join("\n"));
  assert.ok(!(row.steps || []).some((st) => st.kind === "write"), "never a write");
  assert.equal(s.r.plan.incomplete, true);
  assert.equal(readFileSync(paths.manifest, "utf8"), manifest, "the directory is left as it is");
  assert.deepEqual(host.log(), []);
  // plan's dry run: the same skip, with its note.
  const dry = sb.item(plan(proj, { harnesses: [SRC.id], home, root: older, env }), "plugin");
  assert.equal(dry.action, "skip");
  assert.match(dry.reason, /install and upgrade read the registry first, and stop when 0\.31\.0 is published\nnot downgraded — repair it from its own version:\nnpx projectstore@0\.31\.0 upgrade --harness \S+$/);
});

// F2 of the PR1 review: the root an npm-registered Claude Code session runs —
// the plugin in our marketplace directory, loaded in place — is a host's copy.
test("converge criterion 'The stop (Claude Code)': a run from the npm registration's marketplace directory — its sessions' root — never stops and reads nothing, where the package root stops", async () => {
  const sb = sandbox({ version: "0.30.0", npx: true });
  const { home, proj, host, env, paths } = sb;
  assert.equal(apply(plan(proj, { home, root: sb.root, env }), { env, home }).failed, undefined);
  host.reset();
  // A git copy at 0.31.0, re-enabled at user scope beside the registration.
  const git = fakeInstall(home, "0.31.0");
  const reg = sb.registry();
  reg.plugins["projectstore@SmartAndPoint"] = [{ scope: "user", installPath: git, version: "0.31.0", lastUpdated: "2026-10-01T00:00:00Z" }];
  writeFileSync(paths.installed, JSON.stringify(reg, null, 2));
  const fromPackage = await convergeRun(sb, sb.root);
  assert.equal(fromPackage.r.plan.ok, false, "the package root stops");
  const fromPayload = await convergeRun(sb, paths.payload);
  assert.ok(existsSync(join(paths.payload, "package.json")), "a full package tree: only the root decides");
  assert.ok(fromPayload.r.plan.ok, JSON.stringify(fromPayload.r.plan.refusals));
  assert.equal(fromPayload.reg.calls.length, 0, "no request");
  assert.deepEqual(fromPayload.npm.calls, [], "no registry resolved");
  assert.deepEqual(host.log(), []);
});

// Rule 7: the install half of "never another project's registration". The
// shared directory is one per user; rewriting it leaves another checkout's
// row at its version (contract 4′ rung 10), reported by its own doctor.
test("converge rule 7: an upgrade from checkout A that rewrites the shared directory leaves checkout B's registry row and settings byte-identical, and B then reads stale", () => {
  const sb = sandbox({ version: "0.28.0" });
  const { home, proj, root, env, paths, registry } = sb;
  assert.equal(apply(plan(proj, { home, root, env }), { env, home }).failed, undefined);
  const b = tmp("ps-reg-proj-b-");
  mkdirSync(join(b, CFG_DIR), { recursive: true });
  assert.equal(apply(plan(b, { home, root, env, harnesses: [SRC.id] }), { env, home }).failed, undefined);
  const rowOf = (dir) => JSON.stringify(registry().plugins[ID].find((r) => r.projectPath === dir));
  const bRow = rowOf(b);
  const bSettings = readFileSync(join(b, CFG_DIR, "settings.local.json"), "utf8");
  const newer = fakePackageRoot(join(tmp("ps-reg-npx-a-"), "node_modules", "projectstore"), "0.29.0");
  const up = plan(proj, { home, root: newer, env, harnesses: [SRC.id] });
  assert.ok(sb.item(up, "plugin").steps.some((st) => st.kind === "write"), "A rewrites the shared directory");
  assert.equal(apply(up, { env, home }).failed, undefined);
  assert.equal(JSON.parse(readFileSync(paths.manifest, "utf8"))[S.provenance_key].pkg, "0.29.0");
  assert.equal(JSON.parse(rowOf(proj)).version, "0.29.0");
  assert.equal(rowOf(b), bRow, "B's registry row is byte-identical");
  assert.equal(readFileSync(join(b, CFG_DIR, "settings.local.json"), "utf8"), bSettings, "and so are B's settings");
  const bPlan = sb.item(plan(b, { home, root: newer, env, harnesses: [SRC.id] }), "plugin");
  assert.equal(bPlan.state, "stale");
  assert.match(bPlan.reason, /plugin updated \(installed 0\.28\.0, directory 0\.29\.0\)/);
});

// ─── The channel switch (the converge story) ────────────────────────────
//
// PS-HARNESS: "Setup and upgrade converge this project onto the running
// version: the channel switch, no downgrade, and the update notice", rules 1
// to 4. No verb passes a channel yet — the setup story does — so these drive
// plan() and apply() with one, against the logging fake host.

const GIT = "projectstore@SmartAndPoint";
// The git marketplace's copy, enabled at user scope (the registry's only row).
function withGitCopy(sb, version = "0.27.1") {
  const git = fakeInstall(sb.home, version);
  writeRegistry(sb.home, [{ scope: "user", installPath: git, version, lastUpdated: "2026-09-01T00:00:00Z" }]);
  return git;
}
const bindingOf = (proj) => JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8"));
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const writesOf = (p) => p.items.filter((i) => !["skip", "refuse"].includes(i.action));
// Contract 13's info for a copy the registration turned off, read as doctor
// reads it, given the binding.
const ignoreThis = (sb, cfg) => checkPluginRegistration(sb.proj, surfaceStates(sb.proj, { home: sb.home, root: sb.root }).states, { home: sb.home, cfg }).filter((f) => /If moving to npm was meant, ignore this\.$/.test(f.message));
const CONSEQUENCE = `this project stops loading the git-marketplace copy, and /plugin update no longer reaches it — from now on it is updated by ${packageCommand(SRC, "upgrade")}`;

test("converge criterion 'The switch': channel npm plans the registration, the switch with its consequence line and the mark last; apply turns the copy off and records the switch, doctor drops its info, a second plan is zero-change; channel null plans no mark", () => {
  const sb = sandbox({ vault: true });
  const { home, proj, root, env, item, local } = sb;
  withGitCopy(sb);
  const p = plan(proj, { home, root, env, channel: "npm" });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.equal(item(p, "plugin").action, "create");
  const sw = item(p, "plugin_others");
  assert.equal(sw.action, "disable");
  // The consequence is a note step after the host step: a plain note in the envelope.
  assert.deepEqual(sw.steps.map((s) => s.kind === "host" ? s.name : s.kind), ["disable", "note"]);
  assert.deepEqual(publicItem(sw).steps[1], { kind: "note", why: CONSEQUENCE });
  assert.ok(!("reason" in sw), "a bound project's switch over an older copy adds no words");
  // The mark: one item of kind binding, Claude Code's last.
  const mark = p.items.filter((i) => i.harness === SRC.id).at(-1);
  assert.deepEqual([mark.kind, mark.surface, mark.entry, mark.action, mark.path], ["binding", "channel_switch", "channel_switch", "add", layoutPaths(proj).binding]);
  assert.equal(p.items.filter((i) => i.kind === "binding").length, 1);
  // PLAN: the consequence is the first line beneath the switch row, before
  // its $ line; the summary counts the switch; the mark names its edit.
  const text = renderPreview(p);
  const lines = text.split("\n");
  const row = lines.findIndex((l) => new RegExp(`^ {2}⇄ switch +${GIT}`).test(l));
  assert.ok(row > 0, text);
  assert.equal(lines[row + 1], `      ${CONSEQUENCE}`);
  assert.equal(lines[row + 2], `      $ ${S.cli.bin} plugin disable ${GIT} --scope local`);
  assert.match(text, /\nPlan — [^\n]*1 to switch/);
  assert.ok(text.includes(`edit .projectstore/projectstore.json  [channel_switch] → by "setup", at the time of apply`), text);
  assert.ok(!text.includes("note: this project stops"), "drawn as the consequence, never as a note step");
  // Apply: the copy off for this checkout, the switch recorded, every other key kept.
  const before = bindingOf(proj);
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(local().enabledPlugins[GIT], false);
  assert.equal(local().enabledPlugins[ID], true);
  const after = bindingOf(proj);
  assert.equal(after.channel_switch.by, "setup");
  assert.match(after.channel_switch.at, ISO_TIME);
  assert.deepEqual(Object.keys(after), [...Object.keys(before), "channel_switch"]);
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(done.find((d) => d.surface === "channel_switch").steps, [{ kind: "mark", path: layoutPaths(proj).binding, ok: true }]);
  // Doctor, given the binding: the "ignore this" info is gone for the marked checkout only.
  assert.deepEqual(ignoreThis(sb, after), []);
  assert.equal(ignoreThis(sb, before).length, 1, "without the mark it stays");
  // …and doctor --install itself reads the binding it was run for.
  const doctor = (s) => JSON.parse(spawnSync(process.execPath, [join(s.root, "bin", "projectstore.mjs"), "doctor", "--install", "--json", "--project", s.proj], { encoding: "utf8", cwd: s.proj, env: s.host.env({ HOME: s.home }), timeout: 60000, maxBuffer: 1 << 24 }).stdout).result;
  const found = doctor(sb);
  assert.ok(found.some((f) => f.check === "plugin-registration"), JSON.stringify(found, null, 2));
  assert.ok(!found.some((f) => /If moving to npm was meant, ignore this\./.test(f.message)), JSON.stringify(found, null, 2));
  // A re-run is zero-change: the copy is off and the mark is there.
  assert.deepEqual(writesOf(plan(proj, { home, root, env, channel: "npm" })).map(publicItem), []);
  // channel null, the same fixture: the registration and the switch with its note, no mark.
  const sb2 = sandbox({ vault: true });
  withGitCopy(sb2);
  const q = plan(sb2.proj, { home: sb2.home, root: sb2.root, env: sb2.env });
  assert.equal(sb2.item(q, "plugin").action, "create");
  assert.deepEqual(publicItem(sb2.item(q, "plugin_others")).steps.map((s) => s.kind), ["host", "note"]);
  assert.ok(renderPreview(q).includes(`\n      ${CONSEQUENCE}\n`), "in the default view");
  assert.ok(!q.items.some((i) => i.kind === "binding"), "no mark under null");
  assert.equal(apply(q, { env: sb2.env, home: sb2.home }).failed, undefined);
  assert.equal(bindingOf(sb2.proj).channel_switch, undefined);
  assert.equal(ignoreThis(sb2, bindingOf(sb2.proj)).length, 1, "doctor names the info, as today");
  assert.equal(doctor(sb2).filter((f) => /If moving to npm was meant, ignore this\./.test(f.message)).length, 1, "and so does doctor --install");
});

test("converge criterion 'The order': after a failed registration the switch is skipped and APPLY says why, the copy stays on, no mark is written, and DONE is STOPPED — under channel npm and channel null", () => {
  for (const channel of ["npm", null]) {
    const sb = sandbox();
    const { home, proj, root, host, local } = sb;
    withGitCopy(sb);
    const failing = host.env({ FAKE_CLAUDE_FAIL: "install" });
    const p = plan(proj, { home, root, env: failing, channel });
    const chunks = [];
    const rep = applyReporter({ isTTY: false, write: (s) => { chunks.push(String(s)); return true; } }, PLAIN, p, { home });
    const done = apply(p, { env: failing, home, spawn: rep.spawn(spawnSync), onItem: rep.onItem, onStep: rep.onStep });
    assert.equal(done.failed.step, "install", String(channel));
    const sw = done.find((d) => d.surface === "plugin_others");
    assert.equal(sw.action, "skipped");
    assert.equal(sw.reason, `the npm registration did not complete; ${GIT} stays on for this checkout`);
    assert.ok(!host.log().some((c) => c.argv[1] === "disable"), "the disable never ran");
    assert.notEqual(local()?.enabledPlugins?.[GIT], false, "the copy stays on: the checkout still loads a copy");
    const text = chunks.join("");
    assert.ok(text.includes(`⇄ switching ${GIT}\n      · skipped: ${sw.reason}\n`), text);
    if (channel === "npm") {
      const mark = done.find((d) => d.surface === "channel_switch");
      assert.deepEqual([mark.action, mark.reason], ["skipped", "the switch did not complete; nothing is recorded"]);
    }
    assert.equal(bindingOf(proj).channel_switch, undefined, "no mark");
    assert.match(renderDone({ verb: "upgrade", plan: p, applied: done, failed: done.failed, elapsed: 0 }), /^Stopped — \d+ changes? applied, then a host command failed$/m);
  }
});

test("converge criterion 'The adoption, and an unbound project': an earlier switch is recorded by the mark alone; no other copy plans neither; an unbound project plans both, skips the mark at apply and creates no binding; a binding written before apply takes the mark", () => {
  // Switched by a plain upgrade (channel null): the copy off, no mark — this checkout's own history.
  const sb = sandbox();
  const { home, proj, root, env } = sb;
  withGitCopy(sb);
  assert.equal(apply(plan(proj, { home, root, env }), { env, home }).failed, undefined);
  assert.equal(bindingOf(proj).channel_switch, undefined);
  assert.ok(!plan(proj, { home, root, env }).items.some((i) => i.kind === "binding"), "channel null never adopts");
  const p = plan(proj, { home, root, env, channel: "npm" });
  assert.deepEqual(writesOf(p).map((i) => [i.kind, i.surface]), [["binding", "channel_switch"]], "the mark alone");
  assert.equal(sb.item(p, "channel_switch").reason, `this checkout already holds ${GIT} off for the npm registration; the switch is recorded`);
  sb.host.reset();
  assert.equal(apply(p, { env, home }).failed, undefined);
  assert.equal(sb.host.log().length, 0, "recording it runs nothing of the host's");
  assert.match(bindingOf(proj).channel_switch.at, ISO_TIME);
  assert.deepEqual(writesOf(plan(proj, { home, root, env, channel: "npm" })), [], "then zero-change");

  // No copy from another marketplace: neither a switch nor a mark.
  const plain = sandbox();
  assert.equal(apply(plan(plain.proj, { home: plain.home, root: plain.root, env: plain.env }), { env: plain.env, home: plain.home }).failed, undefined);
  const none = plan(plain.proj, { home: plain.home, root: plain.root, env: plain.env, channel: "npm" });
  assert.ok(!none.items.some((i) => i.kind === "binding" || i.surface === "plugin_others"), JSON.stringify(none.items.map(publicItem)));

  // Unbound: the switch and the mark are both planned; the switch row says
  // when it is recorded; at apply the mark is skipped and no binding appears.
  const ub = sandbox();
  withGitCopy(ub);
  rmSync(layoutPaths(ub.proj).binding);
  const u = plan(ub.proj, { home: ub.home, root: ub.root, env: ub.env, channel: "npm" });
  const sw = ub.item(u, "plugin_others");
  assert.equal(sw.action, "disable");
  assert.equal(sw.reason, "the project is not bound yet: the switch is recorded in its binding once it is");
  const mark = ub.item(u, "channel_switch");
  assert.deepEqual([mark.action, mark.state, mark.path], ["add", "unbound", layoutPaths(ub.proj).binding]);
  assert.ok(renderPreview(u).includes(`\n      ${sw.reason}\n`), "in the default view");
  const done = apply(u, { env: ub.env, home: ub.home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.deepEqual([done.at(-1).surface, done.at(-1).action, done.at(-1).reason], ["channel_switch", "skipped", "the project is not bound; the switch is recorded once it is"]);
  assert.ok(!existsSync(layoutPaths(ub.proj).binding), "no binding is created");
  assert.equal(ub.local().enabledPlugins[GIT], false, "the switch itself applied");
  assert.deepEqual(writesOf(plan(ub.proj, { home: ub.home, root: ub.root, env: ub.env, channel: "npm" })), [], "a second plan is zero-change");

  // A binding written between plan and apply (the bind row's place): the mark merges into it.
  const late = sandbox();
  withGitCopy(late);
  rmSync(layoutPaths(late.proj).binding);
  const l = plan(late.proj, { home: late.home, root: late.root, env: late.env, channel: "npm" });
  writeBinding(late.proj, { vault_path: "/tmp/nowhere", layout: "engineering", language: "en" });
  assert.equal(apply(l, { env: late.env, home: late.home }).failed, undefined);
  const merged = bindingOf(late.proj);
  assert.deepEqual(Object.keys(merged), ["vault_path", "layout", "language", "channel_switch"]);
  assert.equal(merged.channel_switch.by, "setup");
});

test("converge criterion 'The mark on a legacy layout': the preview names the moved binding, and after apply the legacy binding is gone and the moved one carries the mark", () => {
  const home = tmp("ps-reg-legacy-home-");
  const { proj, lp } = legacyProject(home);
  withGitCopy({ home }, "0.29.0");
  const root = fakePackageRoot(join(tmp("ps-reg-legacy-npx-"), "node_modules", "projectstore"), "0.30.0");
  const host = fakeClaude(tmp("ps-reg-legacy-bin-"));
  const env = host.env();
  const legacyBefore = JSON.parse(readFileSync(lp.legacy.binding, "utf8"));
  const p = plan(proj, { home, root, env, channel: "npm" });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.equal(p.items[0].surface, "layout", "the move first");
  assert.ok(p.items.some((i) => i.surface === "plugin_others" && i.action === "disable"));
  const mark = p.items.find((i) => i.kind === "binding");
  assert.equal(mark.path, lp.binding, "the binding where the move puts it");
  assert.ok(renderPreview(p).includes(`edit .projectstore/projectstore.json  [channel_switch] → by "setup", at the time of apply`));
  const done = apply(p, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.ok(!existsSync(lp.legacy.binding), "the legacy binding is not re-created");
  const moved = JSON.parse(readFileSync(lp.binding, "utf8"));
  assert.equal(moved.channel_switch.by, "setup");
  assert.match(moved.channel_switch.at, ISO_TIME);
  const { agents, ...rest } = legacyBefore;
  assert.ok(agents, "the fixture's legacy binding carried an agents block");
  assert.deepEqual(Object.keys(moved), [...Object.keys(rest), "channel_switch"], "every key the move kept, then the mark");
});

test("converge criterion 'No git copy': channel git with the git copy held off by this checkout and no npm row refuses before the question, plans nothing, and names /plugin enable and the way back, each command alone on its line", async () => {
  const sb = sandbox({ version: "0.30.0", npx: true });
  const { home, proj, host, paths } = sb;
  withGitCopy(sb, "0.29.0");
  writeFileSync(paths.projectSettings, JSON.stringify({ enabledPlugins: { [GIT]: false } }, null, 2) + "\n");
  const back = `npx projectstore uninstall --harness ${SRC.id} --surface plugin`;
  const p = plan(proj, { home, root: sb.root, env: sb.env, channel: "git" });
  assert.equal(p.ok, false);
  assert.deepEqual(p.items, [], "nothing is planned");
  assert.equal(p.refusals[0], [
    "no git-marketplace copy of projectstore is enabled for this project, so there is none to keep. Nothing is written.",
    `This checkout's local settings hold ${GIT} off. To load it again, run this in ${SRC.display_name}:`,
    `/plugin enable ${GIT}`,
    "The way back from an earlier switch to the npm install is its uninstall, from a terminal in this project:",
    back,
  ].join("\n"));
  assert.ok(!Object.keys(p).includes("refusalAdvice"), "the drawn form stays off the envelope");
  // Through the verb: refused before the question; each command alone on its line.
  const s = await convergeRun(sb, sb.root, { channel: "git" });
  assert.deepEqual(s.r.gate, { confirmed: false, why: "refused" });
  assert.equal(s.asked, false);
  const lines = s.text.split("\n");
  for (const cmd of [`/plugin enable ${GIT}`, back]) {
    const at = lines.indexOf(`    ${cmd}`);
    assert.ok(at > 0 && lines[at - 1] === "" && (lines[at + 1] ?? "") === "", `${cmd}:\n${s.text}`);
  }
  assert.ok(!/\bsetup\b/.test(s.text), "no verb this release lacks");
  assert.deepEqual(host.log(), []);
  // No copy of ours held off, and none installed: only the way back.
  writeFileSync(paths.projectSettings, "{}\n");
  writeRegistry(home, []);
  assert.deepEqual(plan(proj, { home, root: sb.root, env: sb.env, channel: "git" }).refusals[0].split("\n").slice(1), ["The way back from an earlier switch to the npm install is its uninstall, from a terminal in this project:", back]);
  // An unknown channel is a refusal too.
  assert.match(plan(proj, { home, root: sb.root, env: sb.env, channel: "svn" }).refusals[0], /^unknown channel: svn/);
});

test("converge criterion 'The way back': uninstall --surface plugin on the switched fixture turns the copy back on and removes the mark, both in its preview, and keeps every other key of the binding", () => {
  const sb = sandbox();
  const { home, proj, root, env, local } = sb;
  withGitCopy(sb);
  assert.equal(apply(plan(proj, { home, root, env, channel: "npm" }), { env, home }).failed, undefined);
  const before = bindingOf(proj);
  assert.ok(before.channel_switch);
  const un = plan(proj, { home, root, env, mode: "uninstall", surfaces: ["plugin"] });
  const u = sb.item(un, "plugin");
  assert.deepEqual(u.steps.map((s) => s.kind === "host" ? s.name : s.kind), ["uninstall", "marketplace_remove", "enable", "unmark", "remove"]);
  assert.deepEqual(publicItem(u).steps[3], { kind: "unmark", path: layoutPaths(proj).binding, key: "channel_switch", why: u.steps[3].why });
  const text = renderPreview(un);
  assert.ok(text.includes(`$ ${S.cli.bin} plugin enable ${GIT} --scope local`), text);
  assert.ok(text.includes("edit .projectstore/projectstore.json  [channel_switch] → removed"), text);
  const done = apply(un, { env, home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(local().enabledPlugins[GIT], true, "the copy is back on");
  const after = bindingOf(proj);
  assert.equal(after.channel_switch, undefined, "the mark goes with the registration");
  const { channel_switch, ...rest } = before;
  assert.ok(channel_switch);
  assert.deepEqual(after, rest);
  // A binding with no mark: no unmark step.
  const plainSb = sandbox();
  withGitCopy(plainSb);
  assert.equal(apply(plan(plainSb.proj, { home: plainSb.home, root: plainSb.root, env: plainSb.env }), { env: plainSb.env, home: plainSb.home }).failed, undefined);
  const plainUn = plan(plainSb.proj, { home: plainSb.home, root: plainSb.root, env: plainSb.env, mode: "uninstall", surfaces: ["plugin"] });
  assert.ok(!plainSb.item(plainUn, "plugin").steps.some((s) => s.kind === "unmark"));
});

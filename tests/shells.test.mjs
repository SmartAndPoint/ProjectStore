// projectstore — the distribution shells (PS-HARNESS: "Distribution shells as
// the one install entry point: projectstore-claude first, the guard on every
// package"; the shells ADR; layout spec contracts 10–12).
//
// A shell is a bin and a pin, never logic. These tests hold the bin to that:
// a fake core records the argv it receives, so the harness insertion, the
// pass-through, the refusal of another harness and the exit-code relay are
// pinned without the real core's behaviour in the loop. The real core enters
// once, in the build round-trip — the shell's tarball equals its fixture,
// its bundled half equals the core's own pack, and the built bin previews an
// install exactly as the core does with --harness named (AC 1's offline
// stand-in; the live half is A9).
//
//   node --test tests/shells.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, copyFileSync, cpSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { seedCliVault } from "./fixtures/vault.mjs";
import { noHostEnv } from "./fixtures/install.mjs";
import { sourceHarness, packageCommand, loadHarness, loadHarnesses, harnessIds } from "../scripts/harness.mjs";
import { VERBS } from "../scripts/cli.mjs";
import { checkVersions, collectShells, PACKLIST } from "../scripts/version-guard.mjs";
import { checkPluginRegistration, checkLayout } from "../scripts/doctor.mjs";
import { truncFront, PATH_CELL, claudeHome } from "../scripts/lib.mjs";
import { SHELLS, SHELLS_DIR, CORE, shellDir, shellPacklistPath, publishable, shellFor, harnessVerbs, checkShells, packCore, buildShell, buildShells, compareWithFixture, corePackage } from "../packaging/shells.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const TMP = mkdtempSync(join(tmpdir(), "ps-shells-"));
const CLAUDE = SHELLS.find((s) => s.harness === SRC.id);
const read = (p) => readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));
const manifests = () => [...loadHarnesses().values()];
const walk = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };

// A shell root with the COMMITTED bin and a fake core that records its argv.
const FAKE_CORE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PS_FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), via: process.env.PS_FAKE_TAG || "bundled" }));
process.stdout.write("fake-core\\n");
process.exitCode = process.env.PS_FAKE_EXIT ? Number(process.env.PS_FAKE_EXIT) : 0;
`;
function fakeShell({ bundled = true, vendored = false } = {}) {
  const dir = mkdtempSync(join(TMP, "fake-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(shellDir(CLAUDE.name), "bin", `${CLAUDE.name}.mjs`), join(dir, "bin", `${CLAUDE.name}.mjs`));
  if (bundled) { mkdirSync(join(dir, "node_modules", CORE, "bin"), { recursive: true }); writeFileSync(join(dir, "node_modules", CORE, "bin", "projectstore.mjs"), FAKE_CORE); }
  if (vendored) { mkdirSync(join(dir, "core", "bin"), { recursive: true }); writeFileSync(join(dir, "core", "bin", "projectstore.mjs"), FAKE_CORE.replace('"bundled"', '"vendored"')); }
  return dir;
}
let n = 0;
function runShell(dir, args, env = {}) {
  const log = join(dir, `argv-${n++}.json`);
  const r = spawnSync(process.execPath, [join(dir, "bin", `${CLAUDE.name}.mjs`), ...args], { encoding: "utf8", env: { ...process.env, PS_FAKE_LOG: log, ...env }, timeout: 30000 });
  return { ...r, core: existsSync(log) ? readJson(log) : null };
}

test("shells contract 10: the roster is rendered and committed — package.json pins and bundles the core, and an emitted harness carries its plugin root", async () => {
  assert.deepEqual(SHELLS.map((s) => s.name), ["projectstore-claude", "projectstore-codex", "projectstore-opencode"]);
  assert.equal(CLAUDE.private, false, "the Claude Code shell publishes at 0.28.0");
  assert.deepEqual(publishable(), ["projectstore-claude", "projectstore-codex"], "the Codex shell publishes from 0.28.1 (maintainer decision 2026-10-04); opencode stays private until C4");
  const core = corePackage();
  const check = await checkShells();
  assert.equal(check.ok, true, `the committed files equal their render: ${JSON.stringify(check.shells)}`);
  for (const s of SHELLS) {
    const dir = shellDir(s.name);
    const pkg = readJson(join(dir, "package.json"));
    assert.equal(pkg.name, s.name);
    assert.equal(pkg.version, core.version, `${s.name} is at the core's version`);
    assert.equal(pkg.dependencies[CORE], `=${core.version}`, `${s.name} pins the core exactly`);
    assert.deepEqual(pkg.bundleDependencies, [CORE], `${s.name} bundles the core`);
    assert.deepEqual(pkg.bin, { [s.name]: `bin/${s.name}.mjs` });
    const expectedFiles = s.harness === "codex"
      ? ["bin/", "README.md", ".codex-plugin/", "skills/", "hooks/"]
      : ["bin/", "README.md"];
    assert.deepEqual(pkg.files, expectedFiles);
    assert.equal(pkg.private, s.private ? true : undefined);
    assert.equal(pkg.publishConfig?.provenance, undefined);
    assert.equal(pkg.engines.node, core.engines.node);
    assert.ok(read(join(dir, `bin/${s.name}.mjs`)).startsWith("#!/usr/bin/env node\n"), `${s.name}: the bin has its shebang`);
    assert.ok(existsSync(join(dir, "README.md")) && read(join(dir, "README.md")).includes(`npx ${s.name} install --project`), `${s.name}: the README names the one command`);
    assert.ok(existsSync(resolve(ROOT, shellPacklistPath(s.name))), `${s.name}: the packlist fixture exists`);
    if (s.harness === "codex") {
      // No root plugin.json: Codex picks a root Agent Plugins manifest first
      // and loads no hooks from it (openai/codex#37027; loader.rs). The
      // maintainer's live run on 0.28.1 had every hook missing until it went.
      assert.ok(!existsSync(join(dir, "plugin.json")), "the Codex shell carries no root Agent Plugins manifest");
      const manifest = readJson(join(dir, ".codex-plugin", "plugin.json"));
      assert.equal(manifest.version, core.version);
      assert.equal(manifest.$schema, undefined, "a legacy manifest: no Agent Plugins schema");
      assert.equal(manifest.hooks, undefined, "no hooks key, so Codex falls back to hooks/hooks.json");
      assert.ok(existsSync(join(dir, "hooks", "hooks.json")), "the default hooks file Codex falls back to");
      assert.equal(manifest.skills, "./skills/");
      assert.equal(manifest.interface.defaultPrompt.length, 3);
      assert.ok(existsSync(join(dir, "skills", "projectstore-status", "SKILL.md")));
      assert.ok(!existsSync(join(dir, "commands")) && !existsSync(join(dir, "agents")) && !existsSync(join(dir, ".claude-plugin")));
    } else {
      for (const f of walk(dir)) assert.ok(!f.includes(".claude-plugin") && !f.includes(".codex-plugin"), `${f}: a non-plugin shell carries no plugin manifest`);
    }
  }
  // The bin's verb set is the core's table, computed — not copied.
  const expected = VERBS.filter((v) => (v.options || []).some((o) => o.name === "harness")).map((v) => v.verb);
  assert.deepEqual(await harnessVerbs(), expected);
  assert.ok(expected.includes("install") && expected.includes("upgrade") && expected.includes("agents") && !expected.includes("doctor"));
  assert.ok(read(join(shellDir(CLAUDE.name), "bin", `${CLAUDE.name}.mjs`)).includes(`new Set(${JSON.stringify(expected)})`), "the committed bin carries the table's verbs");
  // The manifest names its shell, and the roster agrees (F2: the mapping is data).
  const m = readJson(join(ROOT, "harnesses", `${SRC.id}.json`));
  assert.equal(m.install.shell, CLAUDE.name);
  assert.equal(shellFor(SRC.id), CLAUDE);
  assert.ok(m.install.steps[0].startsWith(`npx ${CLAUDE.name} install --project`), "the first install step is the shell");
  // DONE's next steps are manifest data (install spec, contract 18): every
  // manifest with a shell says what its user does after an install.
  for (const id of harnessIds()) {
    const h = readJson(join(ROOT, "harnesses", `${id}.json`));
    if (!h.install?.shell) continue;
    assert.ok(Array.isArray(h.install.next) && h.install.next.length > 0 && h.install.next.every((s) => typeof s === "string" && s.trim()), `${id}: install.next is a non-empty list of steps`);
  }
  // The bin tells the core which shell ran it — for --help only.
  assert.ok(read(join(shellDir(CLAUDE.name), "bin", `${CLAUDE.name}.mjs`)).includes("PROJECTSTORE_SHELL: SHELL"), "the committed bin names itself to the core");
});

test("shells contract 10: the bin execs the bundled core with --harness fixed after a verb that takes it; everything else passes through; the exit code is the core's", () => {
  const dir = fakeShell();
  const H = ["--harness", SRC.id];
  const cases = [
    [["install", "--project", "/p"], ["install", ...H, "--project", "/p"]],
    [["upgrade", "--surface", "plugin", "--project", "/p"], ["upgrade", ...H, "--surface", "plugin", "--project", "/p"]],
    [["uninstall", "--project", "/p"], ["uninstall", ...H, "--project", "/p"]],
    [["plan", "--json"], ["plan", ...H, "--json"]],
    [["agents", "configure", "--default", "opus"], ["agents", ...H, "configure", "--default", "opus"]],
    [["doctor", "--json"], ["doctor", "--json"]],
    [["status", "--json", "--project", "/p"], ["status", "--json", "--project", "/p"]],
    [["search", "install"], ["search", "install"]],
    [["--version"], ["--version"]],
    [[], []],
    [["install", ...H, "--project", "/p"], ["install", ...H, "--project", "/p"]],
    [["install", `--harness=${SRC.id}`], ["install", `--harness=${SRC.id}`]],
    [["--project", "/p", "install"], ["--project", "/p", "install"]], // the verb is not the first positional: left alone, the core asks for --harness
    [["install", "--", "--harness", "codex"], ["install", ...H, "--", "--harness", "codex"]],
  ];
  for (const [given, expected] of cases) {
    const r = runShell(dir, given);
    assert.equal(r.status, 0, `${JSON.stringify(given)}: ${r.stderr}`);
    assert.deepEqual(r.core?.argv, expected, JSON.stringify(given));
    assert.equal(r.stdout, "fake-core\n", "the core's stdout is the shell's");
  }
  assert.equal(runShell(dir, ["install"], { PS_FAKE_EXIT: "3" }).status, 3, "the exit code is relayed");
  assert.equal(runShell(dir, ["install"], { PS_FAKE_EXIT: "2" }).status, 2);
  // A core that dies of a signal exits the shell way: 128 + the signal's number (Ctrl-C at the preview is 130).
  writeFileSync(join(dir, "node_modules", CORE, "bin", "projectstore.mjs"), FAKE_CORE + "if (process.env.PS_FAKE_SIGNAL) process.kill(process.pid, process.env.PS_FAKE_SIGNAL);\n");
  assert.equal(runShell(dir, ["install"], { PS_FAKE_SIGNAL: "SIGTERM" }).status, 143);
});

test("shells AC 2: another --harness is refused with one line and exit 2, and the core is never spawned", () => {
  const dir = fakeShell();
  for (const args of [["install", "--harness", "codex", "--project", "/p"], ["install", "--harness=codex"], ["agents", "configure", "--harness", "codex", "--default", "x"]]) {
    const r = runShell(dir, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.core, null, "the core did not run");
    assert.match(r.stderr, new RegExp(`${CLAUDE.name}: installs for ${SRC.id} only`));
    assert.match(r.stderr, /codex/);
    assert.equal(r.stderr.trim().split("\n").length, 1, "one line");
    assert.equal(r.stdout, "");
  }
  // A --harness with no value is refused by the shell itself, in its own words — never inserted twice, never named as "another harness".
  for (const args of [["install", "--harness"], ["install", "--harness="], ["install", "--harness", "--project", "/p"]]) {
    const r = runShell(dir, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.core, null);
    assert.match(r.stderr, /--harness. is given without a value/);
    assert.ok(!r.stderr.includes("another harness"), JSON.stringify(args));
  }
});

test("shells contract 10: the core is found by path — bundled first, the vendored fallback second — and its absence is exit 2 naming both", () => {
  const vendored = fakeShell({ bundled: false, vendored: true });
  const r = runShell(vendored, ["install"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.core.via, "vendored");
  const both = fakeShell({ bundled: true, vendored: true });
  assert.equal(runShell(both, ["install"]).core.via, "bundled", "the bundled copy wins");
  const none = fakeShell({ bundled: false });
  const miss = runShell(none, ["install"]);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr, /bundled core is missing/);
  assert.ok(miss.stderr.includes(join("node_modules", CORE, "bin", "projectstore.mjs")) && miss.stderr.includes(join("core", "bin", "projectstore.mjs")));
});

test("shells contract 11: every shell builds from the core's own pack tarball, bundles it, equals its fixture both ways, and its bundled half is the core's pack", { timeout: 180000 }, () => {
  const core = packCore({ dest: mkdtempSync(join(TMP, "core-")) });
  assert.equal(core.error, undefined, core.error);
  assert.equal(core.version, corePackage().version);
  assert.deepEqual(core.files, readJson(join(ROOT, PACKLIST)), "the core's pack is its fixture (packaging contract 1)");
  const out = mkdtempSync(join(TMP, "dist-"));
  for (const s of SHELLS) {
    const b = buildShell(s.name, { coreTgz: core.tgz, out: s === CLAUDE ? out : null, scratch: mkdtempSync(join(TMP, "build-")) });
    assert.equal(b.error, undefined, b.error);
    assert.deepEqual(b.bundled, [CORE], `${s.name} bundles the core`);
    const cmp = compareWithFixture(s.name, b.files);
    assert.equal(cmp.present, true);
    assert.deepEqual(cmp.unexpected, [], `${s.name}: shipped but not in ${cmp.fixture} — run \`npm run packlist\` if intended`);
    assert.deepEqual(cmp.missing, [], `${s.name}: in ${cmp.fixture} but no longer shipped`);
    const prefix = `node_modules/${CORE}/`;
    const bundledHalf = b.files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    assert.deepEqual(bundledHalf, core.files, `${s.name}: the bundled core is exactly the core's pack`);
    const own = b.files.filter((f) => !f.startsWith(prefix));
    if (s.harness === "codex") {
      assert.ok(own.includes(".codex-plugin/plugin.json") && own.includes("hooks/hooks.json"), `${s.name}: the manifest and the default hooks file ship`);
      assert.ok(!own.includes("plugin.json"), `${s.name}: no root Agent Plugins manifest ships — Codex would load no hooks from it`);
      assert.ok(own.some((f) => f.startsWith("skills/projectstore-")), `${s.name}: rendered skills ship`);
      assert.ok(!own.some((f) => f.startsWith("commands/") || f.startsWith("agents/") || f.startsWith(".claude-plugin/")));
    } else {
      assert.deepEqual(own, ["README.md", `bin/${s.name}.mjs`, "package.json"], `${s.name}: installer-only shells carry no plugin root`);
    }
    assert.ok(!b.files.some((f) => f.includes("packlist.json")), "the fixture does not ship");
    if (!s.private) {
      // AC 2: a published shell's built bin answers --version with the core's.
      const v = spawnSync(process.execPath, [join(b.dir, "bin", `${s.name}.mjs`), "--version"], { encoding: "utf8", timeout: 60000 });
      assert.equal(v.status, 0, v.stderr);
      assert.equal(v.stdout.trim(), core.version, `${s.name} --version`);
    }
    if (s === CLAUDE) {
      assert.ok(b.tgz && existsSync(b.tgz) && b.tgz.endsWith(`${s.name}-${core.version}.tgz`), "the tarball lands under --out with npm's name");
      assert.equal(spawnSync(process.execPath, [join(b.dir, "bin", `${s.name}.mjs`), "install", "--harness", "codex", "--project", "/x"], { encoding: "utf8", timeout: 60000 }).status, 2);
      // AC 1 (offline half): the shell's preview is the core's with --harness named — same envelope, same items.
      const { proj } = seedCliVault();
      const env = noHostEnv(); delete env[SRC.runtime.project_dir_env]; delete env.PROJECTSTORE_PROJECT_DIR;
      const viaShell = spawnSync(process.execPath, [join(b.dir, "bin", `${s.name}.mjs`), "plan", "--json", "--project", proj], { encoding: "utf8", env, timeout: 60000, maxBuffer: 1 << 24 });
      const viaCore = spawnSync(process.execPath, [join(b.dir, "node_modules", CORE, "bin", "projectstore.mjs"), "plan", "--harness", SRC.id, "--json", "--project", proj], { encoding: "utf8", env, timeout: 60000, maxBuffer: 1 << 24 });
      assert.equal(viaShell.status, viaCore.status, viaShell.stderr + viaCore.stderr);
      const a = JSON.parse(viaShell.stdout), c = JSON.parse(viaCore.stdout);
      assert.deepEqual(a.result, c.result, "the preview is byte-for-byte the core's");
      assert.equal(a.ok, c.ok);
      assert.ok(Array.isArray(a.result.items) && a.result.items.length > 0, "the preview has items");
    }
  }
});

test("shells contract 11: buildShells — the one builder the CLI and the guard call — packs the core into its own scratch, keeps the built tree beside the tarball under --out, and leaves nothing behind without it", { timeout: 180000 }, () => {
  // With --out: the tarball and the built directory (the publish-from-directory fallback) land under it.
  const out = mkdtempSync(join(TMP, "out-"));
  const kept = buildShells({ only: CLAUDE.name, out });
  assert.equal(kept.ok, true, JSON.stringify({ ...kept, shells: kept.shells?.map((s) => ({ ...s, files: undefined })) }));
  assert.equal(kept.shells.length, 1);
  assert.equal(kept.shells[0].tgz, join(out, `${CLAUDE.name}-${kept.core.version}.tgz`));
  assert.ok(existsSync(kept.shells[0].tgz));
  assert.equal(kept.shells[0].dir, join(out, "build", CLAUDE.name), "the built tree is beside the tarball");
  assert.ok(existsSync(join(kept.shells[0].dir, "node_modules", CORE, "package.json")), "with the core installed");
  assert.ok(existsSync(kept.core.tgz) && kept.core.tgz.startsWith(join(out, "build", "core")), "the core's tarball is under the same build directory");
  assert.deepEqual(kept.shells[0].fixture.unexpected, []); assert.deepEqual(kept.shells[0].fixture.missing, []);
  // Without --out (the guard's --write-packlist): the listing is returned, no tarball and no directory survive.
  const gone = buildShells({ only: CLAUDE.name });
  assert.equal(gone.ok, true, gone.error);
  assert.equal(gone.shells[0].tgz, null); assert.equal(gone.shells[0].dir, null); assert.equal(gone.core.tgz, null);
  assert.deepEqual(gone.shells[0].files, kept.shells[0].files, "the same listing either way");
  assert.match(JSON.stringify(buildShells({ only: "projectstore-ghost" })), /no shell named projectstore-ghost/);
});

test("shells contract 11 / AC 3: the guard counts every shell — a version, a pin, a missing bundle or a misnamed bin fails it, and the release commit passes", () => {
  const live = checkVersions({ root: ROOT });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.deepEqual(live.shells, SHELLS.map((s) => ({ name: s.name, private: s.private })));
  assert.ok(live.checked.some((c) => c.file === `${SHELLS_DIR}/${CLAUDE.name}/package.json`), "the shell is a checked site");
  assert.deepEqual(collectShells(mkdtempSync(join(TMP, "noshells-"))), { shells: [] }, "a tree without packaging/ has no shells and no error");
  // A scratch tree with the version sites and the shells.
  const scratch = mkdtempSync(join(TMP, "guard-"));
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) { mkdirSync(dirname(join(scratch, rel)), { recursive: true }); copyFileSync(join(ROOT, rel), join(scratch, rel)); }
  cpSync(join(ROOT, SHELLS_DIR), join(scratch, SHELLS_DIR), { recursive: true });
  writeFileSync(join(scratch, SHELLS_DIR, ".DS_Store"), "finder"); // a file beside the shells is not a shell
  assert.equal(checkVersions({ root: scratch }).ok, true);
  const pkgPath = join(scratch, SHELLS_DIR, CLAUDE.name, "package.json");
  const good = read(pkgPath);
  const mutate = (fn) => { const j = JSON.parse(good); fn(j); writeFileSync(pkgPath, JSON.stringify(j, null, 2) + "\n"); const r = checkVersions({ root: scratch }); writeFileSync(pkgPath, good); return r; };
  const v = mutate((j) => { j.version = "0.0.0-drift"; });
  assert.equal(v.ok, false); assert.equal(v.error, "version mismatch"); assert.ok(v.versions.includes("0.0.0-drift"));
  const p = mutate((j) => { j.dependencies[CORE] = `^${j.version}`; });
  assert.equal(p.ok, false); assert.equal(p.error, "shell pin mismatch"); assert.equal(p.shell, CLAUDE.name); assert.equal(p.expected, `=${JSON.parse(good).version}`);
  const b = mutate((j) => { delete j.bundleDependencies; });
  assert.equal(b.ok, false); assert.match(b.error, /bundle/);
  const bin = mutate((j) => { j.bin = { [CLAUDE.name]: "bin/other.mjs" }; });
  assert.equal(bin.ok, false); assert.match(bin.error, /bin/);
  const tagged = checkVersions({ root: scratch, tag: `v${JSON.parse(good).version}` });
  assert.equal(tagged.ok, true);
  // A root Agent Plugins manifest in the Codex shell is refused, with the
  // reason: Codex picks it first and loads no hooks from it (openai/codex#37027).
  const codexRoot = join(scratch, SHELLS_DIR, "projectstore-codex", "plugin.json");
  writeFileSync(codexRoot, JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "projectstore", version: JSON.parse(good).version }) + "\n");
  const refused = checkVersions({ root: scratch });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /projectstore-codex\/plugin\.json: refused/);
  assert.match(refused.error, /#37027/);
  rmSync(codexRoot);
  assert.equal(checkVersions({ root: scratch }).ok, true);
  // A directory under packaging/shells/ without a package.json is an error, not a silently skipped shell.
  mkdirSync(join(scratch, SHELLS_DIR, "projectstore-ghost"));
  assert.match(checkVersions({ root: scratch }).error, /projectstore-ghost\/package\.json: missing/);
});

test("Codex development build: cache-buster is deterministic, lives at the manifest site, and never edits release files", { timeout: 180000 }, () => {
  const shell = SHELLS.find((s) => s.harness === "codex");
  const source = shellDir(shell.name);
  const before = [".codex-plugin/plugin.json"].map((rel) => read(join(source, rel)));
  const core = packCore({ dest: mkdtempSync(join(TMP, "dev-core-")) });
  assert.equal(core.error, undefined, core.error);
  const a = buildShell(shell.name, { coreTgz: core.tgz, scratch: mkdtempSync(join(TMP, "dev-a-")), dev: true });
  const b = buildShell(shell.name, { coreTgz: core.tgz, scratch: mkdtempSync(join(TMP, "dev-b-")), dev: true });
  assert.equal(a.error, undefined, a.error);
  assert.equal(b.error, undefined, b.error);
  assert.match(a.devVersion, new RegExp(`^${core.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+codex\\.dev\\.[a-f0-9]{12}$`));
  assert.equal(a.devVersion, b.devVersion);
  for (const rel of [".codex-plugin/plugin.json"]) {
    assert.equal(readJson(join(a.dir, rel)).version, a.devVersion);
    assert.equal(readJson(join(b.dir, rel)).version, b.devVersion);
  }
  assert.ok(!existsSync(join(a.dir, "plugin.json")), "a dev build carries no root Agent Plugins manifest either");
  assert.deepEqual([".codex-plugin/plugin.json"].map((rel) => read(join(source, rel))), before);
});

// A shell is a plugin root with the core beneath it, and the host hands the
// hooks the SHELL's root. The rendered commands reach the core through it; the
// core must not mistake it for its own. The first Codex install shipped exactly
// that defect, and nothing caught it, because no test had run a rendered hook
// from a built tree. Measured on the real install's cache, 2026-10-03: every
// session said "vault load failed — Layout not found", the first one beneath
// the welcome, which was all the user saw. So the hooks run here from the
// release shape (the core installed from its own pack), the way a host runs
// them: a shell expands the placeholder, and every manifest's plugin-root
// variable names the shell, because Codex sets Claude Code's too. `sh -c` has
// the form Codex 0.153.4 uses (`<session shell> -c`, read from its source; `-lc`
// is only its fallback), and a login shell would read the developer's profile
// into the suite. SessionStart is not the only reader of the core's
// assets: PreCompact names the work in flight, and on the defect it dropped that
// line with exit 0 and no error, so a write to a vault story and a compaction
// are fired too.
test("shells: every hook a shell renders runs from the built tree, and a bound project's vault loads in every session, the first one included", { timeout: 180000 }, () => {
  const hooksOf = (s) => loadHarness(s.harness)?.hooks?.config_file;
  const emitting = SHELLS.filter((s) => hooksOf(s) && existsSync(join(shellDir(s.name), hooksOf(s))));
  assert.ok(emitting.length > 0, "no shell renders hooks, so this test would pass by proving nothing");
  const core = packCore({ dest: mkdtempSync(join(TMP, "hooks-core-")) });
  assert.equal(core.error, undefined, core.error);
  for (const s of emitting) {
    const h = loadHarness(s.harness);
    const b = buildShell(s.name, { coreTgz: core.tgz, scratch: mkdtempSync(join(TMP, "hooks-build-")) });
    assert.equal(b.error, undefined, b.error);
    const hooks = readJson(join(b.dir, hooksOf(s))).hooks;
    const { proj, vault } = seedCliVault();
    const roots = Object.fromEntries(manifests().map((m) => m.runtime?.plugin_root_env).filter(Boolean).map((k) => [k, b.dir]));
    const env = noHostEnv({ ...roots, PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: mkdtempSync(join(TMP, "hooks-home-")) });
    // Ours and node's: a forced harness, a sessions dir or a preloaded module
    // from the developer's shell would steer the hooks from inside the suite.
    for (const k of Object.keys(env)) if (k.startsWith("PROJECTSTORE_") || k === "NODE_OPTIONS") delete env[k];
    const skeleton = `# Projectstore vault: ${truncFront(vault, PATH_CELL)}`;
    const fire = (event, extra = {}) => {
      const commands = (hooks[h.hooks.events[event]] || []).flatMap((g) => g.hooks.map((x) => x.command));
      assert.ok(commands.length > 0, `${s.name}: renders no ${event} hook`);
      const input = JSON.stringify({ session_id: "built-shell", cwd: proj, hook_event_name: h.hooks.events[event], ...extra });
      // The process starts in HOME, not the project: on a harness with no
      // project-dir variable only the payload's cwd names the project, and a
      // hook that resolved from its own cwd would pass here by accident.
      return commands.map((command) => {
        const r = spawnSync("/bin/sh", ["-c", command], { input, cwd: env.HOME, env, encoding: "utf8", timeout: 60000 });
        assert.equal(r.status, 0, `${s.name} ${event}: ${command}\n${r.stderr}`);
        assert.doesNotMatch(r.stdout + r.stderr, /vault load failed|Layout not found|Cannot find module|ENOENT/, `${s.name} ${event}: ${command}`);
        return r.stdout;
      }).join("\n");
    };
    for (const n of [1, 2, 3]) {
      const out = fire("SessionStart", { source: "startup" });
      if (n === 1) assert.match(out, /loaded for the first time/, `${s.name}: the first session carries the welcome`);
      assert.ok(out.includes(skeleton), `${s.name}: session ${n} orients on the bound vault\n${out.slice(0, 400)}`);
    }
    // A write to a vault story through the harness's own write tool, in the
    // shape its manifest says the tool carries a path.
    const story = join(vault, "epics", "PS-X", "stories", "story-in-flight.md");
    const t = h.tools;
    const write = {
      tool_name: t.write_tools[0],
      tool_input: t.patch_envelope_field
        ? { [t.patch_envelope_field]: `*** Begin Patch\n*** Update File: ${story}\n@@\n-one\n+two\n*** End Patch` }
        : { [t.path_fields[0]]: story },
    };
    fire("PreToolUse", write);
    fire("PostToolUse", write);
    assert.match(fire("PreCompact", { trigger: "manual" }), /in flight: `epics\/PS-X\/stories\/story-in-flight\.md`/, `${s.name}: the compaction names the story just written`);
    for (const event of Object.keys(h.hooks.events).filter((e) => !["SessionStart", "PreToolUse", "PostToolUse", "PreCompact"].includes(e))) fire(event);
  }
});

// The rule that makes several projectstore-* packages safe to install over one
// project, and the one nothing was enforcing until 2026-09-08.
//
// Every shell bundles the SAME core — measured: the three packlists differ only
// in a bin, a README and a package.json, and the bundled half is byte-identical,
// carrying 20 commands, 6 agents, 4 skills, the hooks and .mcp.json. That is
// correct for exactly one harness: the one whose tree the core IS. For any
// other, the core has to be RENDERED first (`emit`), because a host loads what
// it finds in the plugin root whether or not our manifest calls that surface
// supported — Codex proved it by converting our commands into six entry points
// that exit 1, and by failing the handshake on a .mcp.json written in Claude
// Code's dialect.
//
// So publishability is not a packaging preference. A shell may be published
// only when its harness can actually read what the package carries.
test("shells: a shell is publishable only if its harness owns the source tree or emits a rendered one", () => {
  assert.ok(SHELLS.length > 0);
  for (const s of SHELLS) {
    const m = loadHarness(s.harness);
    // A shell may name a harness that has no manifest yet — the roster is
    // allowed to run ahead of the measurements, and `projectstore-opencode`
    // does exactly that. What it may not be is publishable: with no manifest
    // there is nothing that describes what the package would carry, which
    // surfaces the host would load, or what would have to be rendered first.
    // The strongest form of "cannot ship the core" is "nobody has said what
    // this harness is".
    if (!m) {
      assert.equal(s.private, true, `${s.name}: names harness ${s.harness}, which has no manifest — a shell for a harness nothing describes cannot be published`);
      assert.ok(typeof s.plugin_root === "string" && s.plugin_root.length > 0, `${s.name}: says nothing about the plugin root it still needs`);
      continue;
    }
    // NECESSARY, not sufficient — and the first version of this assertion got
    // that wrong, as an equivalence. `emit` says a rendered tree exists in THIS
    // repository. Publishable says the shell's package root IS that tree, which
    // is a second step and another story's (B5: the plugin root, its manifest,
    // its registration). Written as an equivalence, flipping `emit` on a
    // harness would have *demanded* its shell be published while that shell's
    // root was still the source harness's layout — the exact defect the rule
    // exists to prevent, made mandatory by its own test.
    const canShipTheCore = m.source_layout === true || m.emit === true;
    if (!s.private) {
      assert.ok(
        canShipTheCore,
        `${s.name} is publishable, but ${m.id} has source_layout=${m.source_layout} and emit=${m.emit}. `
        + "A published shell hands its harness the bundled core verbatim: that is right only for the harness whose "
        + "tree the core is, or one the generator renders for. Publishing otherwise ships another harness's commands, "
        + "agents and MCP dialect into a plugin root this host will load anyway.",
      );
    }
    // Where the tree comes from, which is the fact `private` alone cannot
    // carry: null when the core IS the harness's tree, otherwise a description
    // of what still has to be rendered. This is what keeps a harness that emits
    // from being read as ready to publish.
    if (m.source_layout === true) {
      assert.equal(s.plugin_root, null, `${s.name}: its harness owns the core, so there is no separate plugin root to render`);
      assert.equal(s.private, false, `${s.name}: the shell of the harness that owns the core has nothing left to render and should publish`);
    } else {
      assert.ok(typeof s.plugin_root === "string" && s.plugin_root.length > 0, `${s.name}: says nothing about the plugin root it still needs`);
    }
  }
  // Exactly one harness owns the core, so at most one shell can ship it
  // unrendered. If a second ever reads as publishable without emitting, the
  // assertion above fires — this pins the premise it rests on.
  assert.equal(SHELLS.filter((s) => loadHarness(s.harness)?.source_layout).length, 1, "exactly one shell targets the source-layout harness");

  // The mirror direction, and the half that faces a USER rather than a
  // release: `packageCommand` turns `install.shell` into the command doctor
  // and the install prose tell people to run. A manifest that names an
  // unpublished shell sends them to `npx <name>`, which 404s — so a manifest
  // may name a shell only when that shell is actually publishable. Without the
  // key the command falls back to the core with `--harness <id>`, which works.
  for (const m of manifests()) {
    const named = m.install?.shell;
    if (!named) continue;
    const row = SHELLS.find((s) => s.name === named);
    assert.ok(row, `${m.id}: install.shell names ${named}, which is not in the roster`);
    assert.equal(row.private, false, `${m.id}: install.shell names ${named}, which is private — the prose would send a user to a package npm does not have. Drop the key and the command falls back to the core with --harness ${m.id}`);
    assert.equal(row.harness, m.id, `${m.id}: install.shell names ${named}, which targets ${row.harness}`);
  }
  // The converse: a published shell must be named by its harness's manifest.
  // Without the key every remedy for that harness names the core with
  // --harness, and for Codex that form defers the registration to the shell, so
  // npm would serve a shell that no finding points to. A Codex shell published
  // over 0.28.0's core would have shipped exactly that gap.
  for (const s of SHELLS.filter((x) => !x.private)) {
    const m = loadHarness(s.harness);
    assert.ok(m, `${s.name} is published, so its harness ${s.harness} has a manifest`);
    assert.equal(m.install?.shell, s.name, `${s.name} is published, so ${m.id}'s manifest names it in install.shell`);
  }
});

test("shells AC 4: the release matrix is the publishable list, computed — never a hand-written name", () => {
  const listed = spawnSync(process.execPath, [join(ROOT, "packaging", "shells.mjs"), "--list", "--json"], { encoding: "utf8", timeout: 30000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), publishable());
  const yml = read(join(ROOT, ".github", "workflows", "release.yml"));
  assert.ok(yml.includes("shell: ${{ fromJSON(needs.core.outputs.shells) }}"), "the matrix is the core job's output");
  assert.ok(yml.includes('run: echo "shells=$(node packaging/shells.mjs --list --json)"'), "the output is the list verb");
  assert.ok(yml.includes("fail-fast: false"), "one shell's failure does not cancel another's publish (the shells ADR decision 7)");
  assert.ok(yml.includes("if: needs.core.outputs.shells != '[]'"), "an empty list skips the job instead of failing the matrix");
  assert.ok(yml.includes('node packaging/shells.mjs --build --only "${SHELL_NAME}" --out dist'), "a shell is built from the core's pack tarball, in CI too");
  assert.equal((yml.match(/npm view "/g) || []).length, 2, "both publishes skip an already-published name@version");
  // A prerelease must never land on \`latest\`: npm defaults there when --tag is
  // omitted, so a release candidate would answer a bare \`npx projectstore-claude\`.
  assert.match(yml, /disttag=next/, "a version with a prerelease marker goes to its own dist-tag");
  // Comment lines are prose (the documented publish-from-directory fallback);
  // only executable lines are held to the rule.
  const publishes = yml.split("\n").filter((l) => /npm publish/.test(l) && !/^\s*#/.test(l));
  // The leading "./" is what makes npm read a path as a file rather than a git
  // spec: without it the publish dies in `git ls-remote`, which is how the
  // shell half of v0.28.0-rc.1 failed. Measured 2026-09-07.
  const tarball = publishes.find((l) => /\.tgz/.test(l));
  assert.ok(tarball && /npm publish "\.\/dist\//.test(tarball), `the tarball path is file-shaped, not git-shaped: ${(tarball || "").trim()}`);
  assert.equal(publishes.length, 2, "two publishes, the core and the shell");
  for (const l of publishes) assert.match(l, /--provenance --tag /, `every publish names the dist-tag it computed, and none is left to npm's default: ${l.trim()}`);
  assert.ok(yml.includes("node packaging/shells.mjs --check"), "the render check runs before the publish");
  for (const s of SHELLS) assert.ok(!yml.includes(s.name), `${s.name} is not hard-coded in the workflow`);
  const check = spawnSync(process.execPath, [join(ROOT, "packaging", "shells.mjs"), "--check"], { encoding: "utf8", timeout: 60000 });
  assert.equal(check.status, 0, check.stdout);
  assert.equal(JSON.parse(check.stdout).ok, true);
});

test("shells contract 12: the documented install is the shell — README, the manifest, the findings' data — and the command prose names it without an npx literal", () => {
  const readme = read(join(ROOT, "README.md"));
  assert.ok(readme.includes(`npx ${CLAUDE.name} install --project "$PWD"`), "the one-message install is the shell");
  assert.ok(readme.includes(`npx ${CLAUDE.name}@<version> upgrade --project "$PWD"`), "so is the upgrade");
  assert.ok(readme.includes("npx projectstore install --harness claude-code"), "the core's low-level form stays documented once");
  assert.equal((readme.match(/npx projectstore install --harness claude-code/g) || []).length, 1);
  assert.ok(!readme.includes("there is only one package"), "the shells ADR's invalidation of that sentence");
  // Data strings are built by one helper from the manifest's install.shell.
  const h = loadHarness(SRC.id);
  assert.equal(packageCommand(h, "install", { args: '--project "/p"' }), `npx ${CLAUDE.name} install --project "/p"`);
  assert.equal(packageCommand(h, "upgrade", { version: "0.28.0", args: "--surface plugin" }), `npx ${CLAUDE.name}@0.28.0 upgrade --surface plugin`);
  assert.equal(packageCommand({ id: "opencode" }, "install", { args: '--project "/p"' }), 'npx projectstore install --harness opencode --project "/p"', "a manifest without a shell names the core with --harness");
  const stale = checkPluginRegistration("/p", [{ kind: "registration", state: "stale", harness: SRC.id, surface: "plugin", pkg: "0.28.0", entry: "e", reason: "r", path: "x" }]);
  assert.match(stale[0].message, new RegExp(`npx ${CLAUDE.name}@0\\.28\\.0 upgrade --surface plugin --project "/p"`));
  assert.ok(!stale[0].message.includes("--harness"), "the shell fixes the harness");
  // Every published shell, read from the real manifests: Codex's remedies name
  // projectstore-codex from 0.28.1, which is what that release exists for. The
  // README documents each one's install.
  for (const s of SHELLS.filter((x) => !x.private)) {
    assert.ok(readme.includes(`npx ${s.name} install --project "$PWD"`), `the README documents ${s.name}'s install`);
    const m = loadHarness(s.harness);
    assert.equal(packageCommand(m, "upgrade", { version: "0.28.1", args: "--surface plugin" }), `npx ${s.name}@0.28.1 upgrade --surface plugin`, `${s.harness}: a remedy names ${s.name}`);
    const row = checkPluginRegistration("/p", [{ kind: "registration", state: "stale", harness: s.harness, surface: "plugin", pkg: "0.28.1", entry: "e", reason: "r", path: "x" }]);
    assert.match(row[0].message, new RegExp(`npx ${s.name}@0\\.28\\.1 upgrade --surface plugin --project "/p"`), `${s.harness}: the stale-registration finding names its shell`);
    assert.ok(!row[0].message.includes("--harness"), `${s.harness}: the shell fixes the harness`);
  }
  const legacy = mkdtempSync(join(TMP, "legacy-"));
  mkdirSync(join(legacy, SRC.runtime.harness_dir));
  writeFileSync(join(legacy, SRC.runtime.harness_dir, "projectstore.json"), "{}");
  // The shell form is the remedy where the session runs the package's own
  // registration; a git-marketplace copy names its own bin instead (the layout
  // spec, contract 12 as amended 2026-10-03 — tests/layout.test.mjs pins both).
  const regHome = mkdtempSync(join(TMP, "reg-home-"));
  const regRoot = join(claudeHome(regHome), "plugins", "cache", SRC.surfaces.plugin.marketplace_name, "projectstore", corePackage().version);
  const lay = checkLayout(legacy, undefined, { root: regRoot, home: regHome });
  assert.ok(lay.some((f) => f.check === "layout-legacy" && new RegExp(`npx ${CLAUDE.name}@[^ ]+ upgrade --no-register --project`).test(f.message)), JSON.stringify(lay));
  // The prompt surface: the shell by name, never `npx` (the A8 lint keeps the literal out; contract 12).
  const doctorMd = read(join(ROOT, "commands", "doctor.md"));
  assert.ok(doctorMd.includes(`\`${CLAUDE.name}\` shell's \`upgrade\``), "doctor.md routes the refresh to the shell");
  assert.ok(!/npx /.test(doctorMd));
  // The reserved stubs no longer hold the shell names; the old opencode name points at the new one.
  const reserved = readdirSync(join(ROOT, "packaging", "reserved"));
  for (const s of SHELLS) assert.ok(!reserved.includes(s.name), `${s.name} is a shell, not a stub`);
  assert.ok(read(join(ROOT, "packaging", "reserved", "opencode-projectstore", "README.md")).includes("projectstore-opencode"));
  // A built tarball's file name carries the version, so a document that spells
  // one out is wrong from the next bump on, and no version site would notice:
  // the Codex instructions named rc.2's until 2026-10-03. Documents read the
  // version at the moment they are run instead.
  // Every shipped document, read from where it lives: a renamed one fails here
  // rather than dropping out of the check.
  const docs = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((n) => n.endsWith(".md")).map((n) => `docs/${n}`), ...SHELLS.map((s) => `${SHELLS_DIR}/${s.name}/README.md`)];
  assert.ok(docs.includes("docs/harnesses.md"), "the harness page is among the documents read");
  for (const rel of docs) {
    assert.doesNotMatch(read(join(ROOT, rel)), /projectstore(?:-[a-z]+)*-\d+\.\d+\.\d+[^\s"')]*\.tgz/, `${rel}: names a versioned tarball`);
  }
});

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

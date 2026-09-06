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
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { seedCliVault } from "./fixtures/vault.mjs";
import { noHostEnv } from "./fixtures/install.mjs";
import { sourceHarness, packageCommand, loadHarness } from "../scripts/harness.mjs";
import { VERBS } from "../scripts/cli.mjs";
import { checkVersions, collectShells, PACKLIST } from "../scripts/version-guard.mjs";
import { checkPluginRegistration, checkLayout } from "../scripts/doctor.mjs";
import { SHELLS, SHELLS_DIR, CORE, shellDir, shellPacklistPath, publishable, shellFor, harnessVerbs, checkShells, packCore, buildShell, buildShells, compareWithFixture, corePackage } from "../packaging/shells.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const TMP = mkdtempSync(join(tmpdir(), "ps-shells-"));
const CLAUDE = SHELLS.find((s) => s.harness === SRC.id);
const read = (p) => readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));
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

test("shells contract 10: the roster is rendered and committed — package.json pins and bundles the core, the bin is the only code, private shells say so, and no shell carries a plugin manifest", async () => {
  assert.deepEqual(SHELLS.map((s) => s.name), ["projectstore-claude", "projectstore-codex", "projectstore-opencode"]);
  assert.equal(CLAUDE.private, false, "the Claude Code shell publishes at 0.28.0");
  assert.deepEqual(publishable(), ["projectstore-claude"], "codex and opencode stay private until B5/C4");
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
    assert.deepEqual(pkg.files, ["bin/", "README.md"], "a bin and a README ship; the fixture does not");
    assert.equal(pkg.private, s.private ? true : undefined);
    assert.equal(pkg.publishConfig?.provenance, undefined);
    assert.equal(pkg.engines.node, core.engines.node);
    assert.ok(read(join(dir, `bin/${s.name}.mjs`)).startsWith("#!/usr/bin/env node\n"), `${s.name}: the bin has its shebang`);
    assert.ok(existsSync(join(dir, "README.md")) && read(join(dir, "README.md")).includes(`npx ${s.name} install --project`), `${s.name}: the README names the one command`);
    assert.ok(existsSync(resolve(ROOT, shellPacklistPath(s.name))), `${s.name}: the packlist fixture exists`);
    for (const f of walk(dir)) assert.ok(!f.includes(".claude-plugin") && !f.includes(".codex-plugin"), `${f}: a shell carries no plugin manifest of its own until its story renders one`);
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
    assert.deepEqual(own, ["README.md", `bin/${s.name}.mjs`, "package.json"], `${s.name}: a bin, a README and the manifest — nothing else of its own`);
    assert.ok(!b.files.some((f) => f.includes("packlist.json")), "the fixture does not ship");
    if (s === CLAUDE) {
      assert.ok(b.tgz && existsSync(b.tgz) && b.tgz.endsWith(`${s.name}-${core.version}.tgz`), "the tarball lands under --out with npm's name");
      // AC 2: the built bin's --version is the core's.
      const v = spawnSync(process.execPath, [join(b.dir, "bin", `${s.name}.mjs`), "--version"], { encoding: "utf8", timeout: 60000 });
      assert.equal(v.status, 0, v.stderr);
      assert.equal(v.stdout.trim(), core.version);
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
  // A directory under packaging/shells/ without a package.json is an error, not a silently skipped shell.
  mkdirSync(join(scratch, SHELLS_DIR, "projectstore-ghost"));
  assert.match(checkVersions({ root: scratch }).error, /projectstore-ghost\/package\.json: missing/);
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
  assert.ok(yml.includes('npm publish "dist/${SHELL_NAME}-${VERSION}.tgz" --provenance'));
  assert.equal((yml.match(/npm view "/g) || []).length, 2, "both publishes skip an already-published name@version");
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
  assert.equal(packageCommand({ id: "codex" }, "install", { args: '--project "/p"' }), 'npx projectstore install --harness codex --project "/p"', "a manifest without a shell names the core with --harness");
  const stale = checkPluginRegistration("/p", [{ kind: "registration", state: "stale", harness: SRC.id, surface: "plugin", pkg: "0.28.0", entry: "e", reason: "r", path: "x" }]);
  assert.match(stale[0].message, new RegExp(`npx ${CLAUDE.name}@0\\.28\\.0 upgrade --surface plugin --project "/p"`));
  assert.ok(!stale[0].message.includes("--harness"), "the shell fixes the harness");
  const legacy = mkdtempSync(join(TMP, "legacy-"));
  mkdirSync(join(legacy, SRC.runtime.harness_dir));
  writeFileSync(join(legacy, SRC.runtime.harness_dir, "projectstore.json"), "{}");
  const lay = checkLayout(legacy);
  assert.ok(lay.some((f) => f.check === "layout-legacy" && new RegExp(`npx ${CLAUDE.name}@[^ ]+ upgrade --project`).test(f.message)), JSON.stringify(lay));
  // The prompt surface: the shell by name, never `npx` (the A8 lint keeps the literal out; contract 12).
  const doctorMd = read(join(ROOT, "commands", "doctor.md"));
  assert.ok(doctorMd.includes(`\`${CLAUDE.name}\` shell's \`upgrade\``), "doctor.md routes the refresh to the shell");
  assert.ok(!/npx /.test(doctorMd));
  // The reserved stubs no longer hold the shell names; the old opencode name points at the new one.
  const reserved = readdirSync(join(ROOT, "packaging", "reserved"));
  for (const s of SHELLS) assert.ok(!reserved.includes(s.name), `${s.name} is a shell, not a stub`);
  assert.ok(read(join(ROOT, "packaging", "reserved", "opencode-projectstore", "README.md")).includes("projectstore-opencode"));
});

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

// projectstore — packaging tests (PS-HARNESS: "Claim the npm name and ship
// the first release").
//
// Three release-time invariants. All three exist because the alternative is a
// one-off manual check that stops being true the moment someone adds a
// directory:
//
//   1. the tarball matches the checked-in packlist, in BOTH directions — a
//      file shipped that is not in the fixture, and a fixture entry that
//      stopped shipping. `.codex-plugin/`, `.mcp.json` and `bin/` all arrive
//      in later stories, and each one has to be added to `files[]` by hand;
//      this is what fails when someone forgets.
//   2. `package.json` carries no `publishConfig.provenance`. Measured
//      2026-08-23 on npm 11.11.0: with the key set, `npm publish --dry-run`
//      outside CI still exits 0, so a dry-run cannot stand in for this. Only
//      a real publish fails — and the only real publish done by hand is the
//      first one, which is exactly the one that must not fail.
//   3. the version guard actually fails on a mismatch. A guard nobody has
//      seen fail is a guard nobody knows works. Since "A release tag shows on
//      every surface…" (PS-HARNESS) it also fails a version without its
//      release notes (contract 3d): the release workflow makes the GitHub
//      Release from them.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkVersions,
  checkReleaseNotes,
  runGuard,
  releaseNotesPath,
  currentPacklist,
  packEntry,
  unshippedTopLevel,
  PACKLIST,
} from "../scripts/version-guard.mjs";
import { treeFiles } from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readRootJson = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));

test("packaging contract 1: the tarball matches the checked-in packlist", () => {
  const { files, error } = currentPacklist(ROOT);
  assert.equal(error, undefined, `npm pack failed: ${error}`);

  const expected = readRootJson(PACKLIST);
  const shipped = new Set(files);
  const listed = new Set(expected);

  const unexpected = files.filter((f) => !listed.has(f));
  const missing = expected.filter((f) => !shipped.has(f));

  assert.deepEqual(unexpected, [], `shipped but not in ${PACKLIST} — run \`npm run packlist\` if this is intended`);
  assert.deepEqual(missing, [], `in ${PACKLIST} but no longer shipped — a files[] entry was dropped, or the file was`);
});

// npm 12 answers `npm pack --json` with an object keyed by the package's
// name where npm 11 and older answer with an array; both are read alike.
test("packaging: npm pack's --json answer is read as an array (npm ≤ 11) and as an object keyed by name (npm 12)", () => {
  const entry = {
    name: "projectstore",
    version: "0.30.6",
    filename: "projectstore-0.30.6.tgz",
    files: [{ path: "a" }],
  };
  assert.equal(packEntry([entry]), entry);
  assert.equal(packEntry({ projectstore: entry }), entry);
  for (const bad of [[], {}, null, [{ name: "projectstore" }]])
    assert.throws(() => packEntry(bad), /no package entry/, JSON.stringify(bad));
});

test("packaging contract 1b: nothing at the root is silently unshipped", () => {
  // Contract 1 cannot see this case. `npm pack` reports only what `files[]`
  // already allows, so a directory missing from `files[]` is missing from both
  // sides of that comparison and they agree. The working tree is the only
  // place a forgotten directory is visible — read it, not the fixture.
  const stray = unshippedTopLevel(readdirSync(ROOT), readRootJson(PACKLIST));
  assert.deepEqual(
    stray,
    [],
    `at the repository root but neither shipped nor deliberately excluded: ${stray.join(", ")}. ` +
      `Add each to package.json files[] (then \`npm run packlist\`) or to NOT_SHIPPED in scripts/version-guard.mjs.`,
  );
});

test("packaging contract 1c: an unshipped directory is actually detected", () => {
  // The demonstration, not the assertion. `adapters/` is now a deliberately
  // unshipped build input, while a new `harnesses/` directory must not slip out
  // of the tarball quietly; this is that scenario, run rather than described.
  // A synthetic tree, deliberately not the real one: this must keep proving
  // the mechanism even on a checkout where `adapters/` already exists.
  const tree = [".claude-plugin", "scripts", "tests", "packaging", "adapters", "harnesses"];
  const shipped = [".claude-plugin/plugin.json", "scripts/lib.mjs"];

  assert.deepEqual(
    unshippedTopLevel(tree, shipped),
    ["harnesses"],
    "a new top-level directory absent from files[] must be reported",
  );

  // And the converse: once shipped, it stops being reported.
  assert.deepEqual(
    unshippedTopLevel(tree, [...shipped, "adapters/codex/hooks.json", "harnesses/codex.json"]),
    [],
    "a directory present in the packlist must not be reported as stray",
  );
});

test("packaging contract 1d: the directories the plugin cannot work without do ship", () => {
  const tops = new Set(readRootJson(PACKLIST).map((p) => (p.includes("/") ? p.split("/")[0] : p)));

  // npm force-includes README, LICENSE and package.json, so listing those
  // proves nothing. These are the ones a wrong files[] can actually drop.
  for (const entry of [
    ".claude-plugin",
    "bin",
    "agents",
    "commands",
    "hooks",
    "scripts",
    "skills",
    "scaffold",
    "templates",
    "docs",
    "AGENTS.md",
    ".mcp.json",
  ]) {
    assert.ok(tops.has(entry), `${entry} is missing from the tarball`);
  }
  assert.ok(!tops.has("tests"), "tests/ must not ship");
  const pkg = readRootJson("package.json");
  assert.equal(
    pkg.bin && pkg.bin.projectstore,
    "bin/projectstore.mjs",
    "the bin is declared (distribution ADR decision 5)",
  );
  assert.ok(
    readFileSync(resolve(ROOT, pkg.bin.projectstore), "utf8").startsWith("#!/usr/bin/env node\n"),
    "the bin has its shebang",
  );
  assert.ok(!tops.has(".claude"), ".claude/ must not ship — it holds local worktrees");
  assert.ok(!tops.has("packaging"), "packaging/ holds reserved-name stubs and must not ship");
});

test("packaging contract 2: no package.json — the core's or a shell's — declares publishConfig.provenance", () => {
  const files = [
    "package.json",
    ...readdirSync(resolve(ROOT, "packaging", "shells")).map((n) => `packaging/shells/${n}/package.json`),
  ];
  assert.ok(files.length >= 4, "the core and three shells");
  for (const f of files) {
    assert.equal(
      readRootJson(f).publishConfig?.provenance,
      undefined,
      `${f}: publishConfig.provenance breaks a manual publish outside CI; ask for provenance in the workflow instead`,
    );
  }
});

// The story "The CLI's output is designed: grouped plans, a question rail, one
// glyph set, doctor grouped by cause" (PS-HARNESS), its last criterion: the
// presentation is raw SGR and hand-built layout, so the package still runs on
// every Node it promises and installs nothing beside itself.
// The lint ADR ("Lint and format: ESLint and Prettier as pinned dev
// dependencies; the published package stays dependency-free", decision 2)
// keeps it so: the tools are pinned exactly, so an upgrade is a reviewed
// change. Since the PS-DIRECTORY story "Dev dependencies stay out of every
// user's plugin copy: the plugin root carries no lockfile for Claude Code to
// install from" they live in tools/lint/, a private package with its own
// lockfile, and the root manifest declares no dependency at all: Claude Code
// copies the repository for a git-channel install, and a root devDependency
// beside a root lockfile was installed into every user's copy.
test("packaging: package.json declares no dependency of any kind, the lint tools are pinned in tools/lint/, and engines stays >=20.0.0", () => {
  const pkg = readRootJson("package.json");
  for (const k of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    assert.equal(pkg[k], undefined, `package.json declares ${k}`);
  }
  assert.equal(pkg.engines.node, ">=20.0.0");

  const tools = readRootJson("tools/lint/package.json");
  assert.equal(tools.private, true, "tools/lint/ is private: nothing publishes it");
  assert.equal(tools.version, undefined, "tools/lint/ carries no version for the guard to miss");
  assert.deepEqual(Object.keys(tools.devDependencies).sort(), ["@eslint/js", "eslint", "eslint-plugin-n", "prettier"]);
  for (const [name, v] of Object.entries(tools.devDependencies))
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  // Its lockfile is the one `npm run lint:setup` installs from, and it agrees
  // with the pins: the run is reproducible.
  const lock = readRootJson("tools/lint/package-lock.json");
  assert.deepEqual(lock.packages[""].devDependencies, tools.devDependencies);
  for (const [name, v] of Object.entries(tools.devDependencies))
    assert.equal(lock.packages[`node_modules/${name}`]?.version, v, `the lockfile resolves ${name} to its pin`);
  assert.equal(pkg.scripts["lint:setup"], "npm ci --prefix tools/lint");
});

// The same story, its first criterion. Claude Code installs a plugin's
// packages whenever the plugin's root holds a package.json and a supported
// lockfile, at install, at every update and at session start, and it cannot be
// turned off. The git channel's plugin root is this repository's root, so it
// holds no lockfile of any kind Claude Code reads, and the directory's
// pre-submission checklist holds the same pair.
test("packaging: the plugin root holds package.json and no lockfile for Claude Code to install from", () => {
  const top = new Set(readdirSync(ROOT));
  assert.ok(top.has("package.json"));
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"])
    assert.ok(
      !top.has(lockfile),
      `${lockfile} at the repository root: Claude Code installs what it names into every git-channel user's plugin copy. ` +
        `The lint tools' lockfile is tools/lint/package-lock.json (npm run lint:setup); delete the root one.`,
    );
});

// Before `npm run lint:setup`, the lint and format scripts would die on Node's
// raw "Cannot find module" (the A review, 2026-10-15). Their pre-scripts run
// tools/lint/setup-check.mjs, which names the one command that fixes it.
test("packaging: lint and format first check that the lint tools are installed, and name lint:setup when not", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  for (const s of ["lint", "format", "format:check"])
    assert.equal(scripts[`pre${s}`], "node tools/lint/setup-check.mjs", `pre${s} runs the check`);
  const dir = mkdtempSync(join(tmpdir(), "ps-lint-setup-"));
  try {
    copyFileSync(join(ROOT, "tools", "lint", "setup-check.mjs"), join(dir, "setup-check.mjs"));
    const bare = spawnSync(process.execPath, [join(dir, "setup-check.mjs")], { encoding: "utf8" });
    assert.equal(bare.status, 1, "no tools installed: the check fails");
    assert.match(bare.stderr, /npm run lint:setup/);
    for (const bin of ["eslint/bin/eslint.js", "prettier/bin/prettier.cjs"]) {
      mkdirSync(dirname(join(dir, "node_modules", bin)), { recursive: true });
      writeFileSync(join(dir, "node_modules", bin), "");
    }
    const ready = spawnSync(process.execPath, [join(dir, "setup-check.mjs")], { encoding: "utf8" });
    assert.equal(ready.status, 0, ready.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lint ADR, decision 4: a Node-floor finding kept rather than replaced
// carries a disable that says why the API is safe at the floor. Both forms
// count, the line form and the block form. The planted directives are built
// by concatenation, so this file holds none of its own.
const FLOOR_RULE = "n/no-unsupported-features/";
function floorDisablesWithoutReason(src) {
  const bare = [];
  for (const m of src.matchAll(/\/[/*]\s*eslint-disable(?:-next-line|-line)?\s([^\n]*)/g)) {
    const body = m[1].replace(/\*\/.*$/, "");
    if (body.includes(FLOOR_RULE) && !/\s-{2,}\s+\S/.test(body)) bare.push(m[0].trim());
  }
  return bare;
}

test("lint: every disable of a Node-floor rule gives its reason", () => {
  const mjs = (dir) =>
    treeFiles(join(ROOT, dir))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `${dir}/${f}`);
  const files = [
    ...mjs("bin"),
    ...mjs("scripts"),
    ...mjs("packaging"),
    ...mjs("tests"),
    "eslint.config.mjs",
    "tools/lint/eslint.config.mjs",
  ];
  files.push(
    ...readdirSync(join(ROOT, "hooks"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `hooks/${f}`),
  );
  const texts = files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]);
  // Not vacuous: the scan must reach the real directives, not just this file's
  // own mentions of the rule.
  const carrying = texts
    .filter(([f, t]) => f !== "tests/packaging.test.mjs" && t.includes("eslint-disable") && t.includes(FLOOR_RULE))
    .map(([f]) => f);
  for (const f of ["scripts/convergence.mjs", "packaging/shells.mjs", "tests/fixtures/hermetic.mjs"])
    assert.ok(carrying.includes(f), `the scan reads ${f}'s Node-floor disable`);
  assert.deepEqual(
    texts.flatMap(([f, t]) => floorDisablesWithoutReason(t).map((d) => `${f}: ${d}`)),
    [],
  );

  const line = "// eslint-" + "disable-next-line n/no-unsupported-features/node-builtins";
  const block = "/* eslint-" + "disable n/no-unsupported-features/node-builtins */";
  assert.equal(
    floorDisablesWithoutReason(`${line}\nimport { cpSync } from "node:fs";\n`).length,
    1,
    "a line disable without a reason",
  );
  assert.equal(floorDisablesWithoutReason(`${line} -- stable from 22.3; CI runs Node 20\n`).length, 0);
  assert.equal(floorDisablesWithoutReason(block).length, 1, "a block disable without a reason");
  assert.equal(floorDisablesWithoutReason(block.replace(" */", " -- stable from 21 */")).length, 0);
});

test("packaging contract 3: the version guard agrees with itself and fails on a mismatch", () => {
  const agreed = checkVersions({ root: ROOT });
  assert.equal(agreed.ok, true, `manifests disagree: ${JSON.stringify(agreed)}`);

  const tagged = checkVersions({ root: ROOT, tag: `v${agreed.version}` });
  assert.equal(tagged.ok, true, "a tag equal to the manifests must pass");

  const mismatched = checkVersions({ root: ROOT, tag: "v0.0.0-not-a-release" });
  assert.equal(mismatched.ok, false, "a tag that disagrees must fail");
  assert.equal(mismatched.error, "version mismatch");
});

test("packaging contract 3b: a checkout missing a required manifest fails, not passes", () => {
  // Every site used to be optional, which made "no site disagrees" trivially
  // true on a tree with no manifests at all — the guard reported agreement
  // with a tag it had nothing to compare against.
  const empty = mkdtempSync(join(tmpdir(), "ps-guard-"));
  const result = checkVersions({ root: empty, tag: "v9.9.9" });

  assert.equal(result.ok, false, "a missing package.json must fail the guard");
  assert.match(result.error, /package\.json: missing/);
});

test("packaging contract 3c: the guard reads no lockfile, and a root without one passes it", () => {
  // From the lint ADR until the PS-DIRECTORY story "Dev dependencies stay out
  // of every user's plugin copy…", the root's package-lock.json recorded the
  // root package's version twice and the guard read both. The root holds no
  // lockfile now (the test above refuses one), and tools/lint/'s carries no
  // version, so the guard has no lockfile site: one it required would fail
  // every checkout, and one it read would keep a lockfile at the root alive.
  const scratch = mkdtempSync(join(tmpdir(), "ps-guard-lock-"));
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(scratch, rel));
  }
  const agreed = checkVersions({ root: scratch });
  assert.equal(agreed.ok, true, JSON.stringify(agreed));
  assert.deepEqual(
    agreed.checked.filter((c) => /(^|\/)package-lock\.json$/.test(c.file)),
    [],
    "no lockfile is a version site",
  );
  assert.deepEqual(
    checkVersions({ root: ROOT }).checked.filter((c) => /(^|\/)package-lock\.json$/.test(c.file)),
    [],
    "nor in the repository itself",
  );
  rmSync(scratch, { recursive: true, force: true });
});

test("packaging contract 3d: a version without its release notes fails the guard, with and without a tag", () => {
  // The release workflow makes the GitHub Release from
  // packaging/release-notes/v<version>.md; a version without one, or with a
  // heading and nothing under it (0.28.0's "tagged without release notes"),
  // is refused before the tag rather than on it.
  const scratch = mkdtempSync(join(tmpdir(), "ps-guard-notes-"));
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(scratch, rel));
  }
  const version = readRootJson("package.json").version;
  const rel = releaseNotesPath(version);
  assert.equal(rel, `packaging/release-notes/v${version}.md`);
  const notes = join(scratch, rel);

  for (const tag of [null, `v${version}`]) {
    const missing = runGuard({ root: scratch, tag });
    assert.equal(missing.ok, false, "no notes file fails the guard");
    assert.equal(missing.notes, rel, "the refusal names the expected path");
    assert.match(missing.error, new RegExp(`^${rel.replace(/\./g, "\\.")}: missing`));
  }

  mkdirSync(dirname(notes), { recursive: true });
  const refused = (text) => {
    writeFileSync(notes, text);
    return runGuard({ root: scratch, tag: `v${version}` });
  };
  for (const [why, text, message] of [
    ["another version's heading", `# v0.0.1 — Another release\n\nBody.\n`, /the heading names v0\.0\.1/],
    ["an empty title", `# v${version} — \n\nBody.\n`, /the first line must be/],
    ["no dash", `# v${version}\n\nBody.\n`, /the first line must be/],
    ["no heading", `Body only.\n`, /the first line must be/],
    ["a heading alone", `# v${version} — A title\n`, /no body under the heading/],
    ["a heading and blank lines", `# v${version} — A title\n\n  \n\n`, /no body under the heading/],
  ]) {
    const r = refused(text);
    assert.equal(r.ok, false, why);
    assert.match(r.error, message, why);
    assert.equal(r.notes, rel, why);
  }

  const good = `# v${version} — A title\r\n\r\nWhat the release says.\n`;
  writeFileSync(notes, good);
  for (const tag of [null, `v${version}`]) {
    const r = runGuard({ root: scratch, tag });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.notes, rel);
    assert.equal(r.version, version);
  }
  // The versions are still judged first: a mismatched tag is the versions'
  // refusal, not the notes'.
  assert.equal(runGuard({ root: scratch, tag: "v0.0.1" }).error, "version mismatch");
  // checkVersions itself never asks for notes: contracts 3, 3b and 3c keep
  // their scratch roots.
  rmSync(notes);
  assert.equal(checkVersions({ root: scratch }).ok, true);
  rmSync(scratch, { recursive: true, force: true });

  // The repository's own version has its notes, and the CLI says so, in both
  // forms CI runs it.
  assert.equal(checkReleaseNotes({ root: ROOT, version }).ok, true);
  for (const args of [[], ["--tag", `v${version}`]]) {
    const run = spawnSync(process.execPath, [join(ROOT, "scripts", "version-guard.mjs"), ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.notes, rel);
  }
});

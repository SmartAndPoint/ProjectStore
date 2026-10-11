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
//      seen fail is a guard nobody knows works.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  checkVersions,
  currentPacklist,
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

  assert.deepEqual(
    unexpected,
    [],
    `shipped but not in ${PACKLIST} — run \`npm run packlist\` if this is intended`,
  );
  assert.deepEqual(
    missing,
    [],
    `in ${PACKLIST} but no longer shipped — a files[] entry was dropped, or the file was`,
  );
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
  assert.equal(pkg.bin && pkg.bin.projectstore, "bin/projectstore.mjs", "the bin is declared (distribution ADR decision 5)");
  assert.ok(readFileSync(resolve(ROOT, pkg.bin.projectstore), "utf8").startsWith("#!/usr/bin/env node\n"), "the bin has its shebang");
  assert.ok(!tops.has(".claude"), ".claude/ must not ship — it holds local worktrees");
  assert.ok(!tops.has("packaging"), "packaging/ holds reserved-name stubs and must not ship");
});

test("packaging contract 2: no package.json — the core's or a shell's — declares publishConfig.provenance", () => {
  const files = ["package.json", ...readdirSync(resolve(ROOT, "packaging", "shells")).map((n) => `packaging/shells/${n}/package.json`)];
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
// keeps it so: the tools are devDependencies, which no consumer installs,
// pinned exactly so an upgrade is a reviewed change.
test("packaging: package.json declares no dependency of any kind, its tools are pinned devDependencies, and engines stays >=20.0.0", () => {
  const pkg = readRootJson("package.json");
  for (const k of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
    assert.equal(pkg[k], undefined, `package.json declares ${k}`);
  }
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@eslint/js", "eslint", "eslint-plugin-n", "prettier"]);
  for (const [name, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  assert.equal(pkg.engines.node, ">=20.0.0");
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
  const mjs = (dir) => treeFiles(join(ROOT, dir)).filter((f) => f.endsWith(".mjs")).map((f) => `${dir}/${f}`);
  const files = [...mjs("bin"), ...mjs("scripts"), ...mjs("packaging"), ...mjs("tests"), "eslint.config.mjs"];
  files.push(...readdirSync(join(ROOT, "hooks")).filter((f) => f.endsWith(".mjs")).map((f) => `hooks/${f}`));
  const texts = files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]);
  // Not vacuous: the scan must reach the real directives, not just this file's
  // own mentions of the rule.
  const carrying = texts.filter(([f, t]) => f !== "tests/packaging.test.mjs" && t.includes("eslint-disable") && t.includes(FLOOR_RULE)).map(([f]) => f);
  for (const f of ["scripts/convergence.mjs", "packaging/shells.mjs", "tests/fixtures/hermetic.mjs"]) assert.ok(carrying.includes(f), `the scan reads ${f}'s Node-floor disable`);
  assert.deepEqual(texts.flatMap(([f, t]) => floorDisablesWithoutReason(t).map((d) => `${f}: ${d}`)), []);

  const line = "// eslint-" + "disable-next-line n/no-unsupported-features/node-builtins";
  const block = "/* eslint-" + "disable n/no-unsupported-features/node-builtins */";
  assert.equal(floorDisablesWithoutReason(`${line}\nimport { cpSync } from "node:fs";\n`).length, 1, "a line disable without a reason");
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

test("packaging contract 3c: a lockfile left behind by a bump fails the guard, at either of its two versions", () => {
  // package-lock.json is committed since the lint ADR and records the root
  // package's version twice: `version` and `packages[""].version`.
  const scratch = mkdtempSync(join(tmpdir(), "ps-guard-lock-"));
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package-lock.json"]) {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(scratch, rel));
  }
  const agreed = checkVersions({ root: scratch });
  assert.equal(agreed.ok, true, JSON.stringify(agreed));
  assert.equal(agreed.checked.filter((c) => c.file === "package-lock.json").length, 2, "both lockfile versions are checked");

  const lock = join(scratch, "package-lock.json");
  const good = readFileSync(lock, "utf8");
  const mutate = (fn) => {
    const j = JSON.parse(good);
    fn(j);
    writeFileSync(lock, JSON.stringify(j, null, 2) + "\n");
    const r = checkVersions({ root: scratch });
    writeFileSync(lock, good);
    return r;
  };
  for (const [where, fn] of [
    ["version", (j) => { j.version = "0.0.0-stale"; }],
    ['packages[""].version', (j) => { j.packages[""].version = "0.0.0-stale"; }],
  ]) {
    const r = mutate(fn);
    assert.equal(r.ok, false, `a stale lockfile ${where} must fail the guard`);
    assert.equal(r.error, "version mismatch");
    assert.ok(r.versions.includes("0.0.0-stale"), where);
  }
  assert.match(mutate((j) => { delete j.packages; }).error, /package-lock\.json: no version found/);

  rmSync(lock);
  assert.match(checkVersions({ root: scratch }).error, /package-lock\.json: missing/);
  rmSync(scratch, { recursive: true, force: true });
});

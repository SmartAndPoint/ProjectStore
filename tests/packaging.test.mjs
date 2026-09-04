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
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  checkVersions,
  currentPacklist,
  unshippedTopLevel,
  PACKLIST,
} from "../scripts/version-guard.mjs";

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
  // The demonstration, not the assertion. `adapters/` and `harnesses/` are
  // landing from another branch and must not slip out of the tarball quietly;
  // this is that scenario, run rather than described.
  // A synthetic tree, deliberately not the real one: this must keep proving
  // the mechanism even on a checkout where `adapters/` already exists.
  const tree = [".claude-plugin", "scripts", "tests", "packaging", "adapters", "harnesses"];
  const shipped = [".claude-plugin/plugin.json", "scripts/lib.mjs"];

  assert.deepEqual(
    unshippedTopLevel(tree, shipped),
    ["adapters", "harnesses"],
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
    "agents",
    "commands",
    "hooks",
    "scripts",
    "skills",
    "scaffold",
    "templates",
    "docs",
    "AGENTS.md",
  ]) {
    assert.ok(tops.has(entry), `${entry} is missing from the tarball`);
  }
  assert.ok(!tops.has("tests"), "tests/ must not ship");
  assert.ok(!tops.has(".claude"), ".claude/ must not ship — it holds local worktrees");
  assert.ok(!tops.has("packaging"), "packaging/ holds reserved-name stubs and must not ship");
});

test("packaging contract 2: package.json declares no publishConfig.provenance", () => {
  const pkg = readRootJson("package.json");
  assert.equal(
    pkg.publishConfig?.provenance,
    undefined,
    "publishConfig.provenance breaks a manual publish outside CI; ask for provenance in the workflow instead",
  );
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

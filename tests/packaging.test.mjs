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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, currentPacklist, PACKLIST } from "../scripts/version-guard.mjs";

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

test("packaging contract 1b: every shipped directory is one the plugin needs", () => {
  const expected = readRootJson(PACKLIST);
  const tops = new Set(expected.map((p) => (p.includes("/") ? p.split("/")[0] : p)));

  // The tarball is a plugin payload. Anything here that a harness cannot use
  // is dead weight a reader will have to justify later.
  for (const dir of [".claude-plugin", "agents", "commands", "hooks", "scripts", "skills", "scaffold", "templates"]) {
    assert.ok(tops.has(dir), `${dir}/ is missing from the tarball`);
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

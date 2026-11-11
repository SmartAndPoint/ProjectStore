// projectstore — tests/code-refs.test.mjs: whether a path is covered by a
// code_refs entry, the one rule spec-drift.mjs and doctor's flow group share
// (PS-FLOW, "Doctor checks the flow against the vault's policy…"; the spec
// "Doctor's flow findings…", alias `flow-findings`, contract 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { refCovers, globCovers, globRe } from "../scripts/code-refs.mjs";
import { globRe as driftGlobRe } from "../scripts/spec-drift.mjs";

// [flow-findings#2]
test("paths: scripts/flow-* covers scripts/flow-x/a.mjs, and src/*/ does not cover src/a.mjs (edge)", () => {
  assert.equal(refCovers("scripts/flow-*", "scripts/flow-x/a.mjs"), true);
  assert.equal(refCovers("src/*/", "src/a.mjs"), false);
  assert.equal(refCovers("src/*/", "src/x/a.mjs"), true);
  assert.equal(refCovers("./scripts", "scripts/a.mjs"), true);
  assert.equal(refCovers("scripts", "scripts-old/a.mjs"), false);
  assert.equal(refCovers("README.md", "README.md"), true);
  assert.equal(refCovers("README.md/", "README.md"), false);
  assert.equal(refCovers("**/*.test.mjs", "tests/a.test.mjs"), true);
});

// [flow-findings#2]
test("paths: a non-ASCII path is compared as written, and a ref with no glob covers paths under it as a folder (edge)", () => {
  assert.equal(refCovers("docs/", "docs/руководство.md"), true);
  assert.equal(refCovers("docs/руководство.md", "docs/руководство.md"), true);
  assert.equal(refCovers("docs", "docs"), true);
  assert.equal(refCovers("", "a.mjs"), false);
  assert.equal(globCovers("src/**", "src/a/b.mjs"), true);
  assert.equal(globCovers("src/?.mjs", "src/qq.mjs"), false);
});

// [flow-findings#2]
test("paths: spec-drift reads the same globRe, so its expansion and doctor's test cannot drift", () => {
  assert.equal(driftGlobRe, globRe);
});

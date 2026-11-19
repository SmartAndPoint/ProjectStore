// projectstore — lib.mjs's modules (PS-SPECTREE: "The marker parser and the
// skeleton leave lib.mjs"). The text grammar (headings, keywords, citation
// tokens, the amendment marker) lives in grammar.mjs and the skeleton's
// renderer in skeleton.mjs, two leaves; lib.mjs re-exports every name it
// exported before, so no importer changed.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/lib-modules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importSpecifiers, closure } from "./fixtures/imports.mjs";
import { CASES } from "./fixtures/skeleton-cases.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (n) => import(pathToFileURL(join(ROOT, "scripts", n)).href);
const json = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
// What the leaves export for lib.mjs's own use, and lib.mjs does not re-export.
// The `checked` marker's parser (PS-SPECTREE "Code newer than its
// spec") are read from grammar.mjs directly, so lib.mjs's names stay pinned.
const INTERNAL = ["escapeRe", "INLINE_CODE_SPAN_RE", "parseSpecMarkers"];

test("lib modules: lib.mjs exports exactly the names it exported before the move", async () => {
  const lib = await load("lib.mjs");
  assert.deepEqual(Object.keys(lib).sort(), json("tests/fixtures/lib-exports.json").sort());
});

test("lib modules: what moved is re-exported, not copied", async () => {
  const lib = await load("lib.mjs");
  for (const leaf of ["grammar.mjs", "skeleton.mjs"]) {
    const mod = await load(leaf);
    const names = Object.keys(mod).filter((n) => !INTERNAL.includes(n));
    assert.ok(names.length >= 10, `${leaf} exports ${names.length} names`);
    for (const n of names) assert.equal(lib[n], mod[n], `lib.mjs re-exports ${leaf}'s ${n}`);
  }
  assert.equal(typeof lib.gatherVaultFacts, "function");
});

test("lib modules: grammar.mjs and skeleton.mjs are leaves", () => {
  for (const [leaf, allowed] of [
    ["grammar.mjs", ["node:fs", "node:path", "./harness.mjs"]],
    ["skeleton.mjs", ["./harness.mjs"]],
  ]) {
    const src = readFileSync(join(ROOT, "scripts", leaf), "utf8");
    assert.deepEqual(importSpecifiers(src).sort(), allowed.sort(), leaf);
    assert.ok(!/\bimport\s*\(/.test(src), `${leaf} has a dynamic import`);
    assert.deepEqual(closure(`scripts/${leaf}`, { root: ROOT }), [`scripts/${leaf}`, "scripts/harness.mjs"].sort());
  }
});

test("lib modules: the skeleton for fixed facts is the bytes it was before the move", async () => {
  const { renderVaultSkeleton } = await load("lib.mjs");
  const golden = json("tests/fixtures/skeleton-golden.json");
  assert.deepEqual(Object.keys(golden), Object.keys(CASES));
  for (const [name, facts] of Object.entries(CASES)) assert.equal(renderVaultSkeleton(facts), golden[name], name);
});

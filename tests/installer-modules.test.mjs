// projectstore — the installer's modules (PS-DIRECTORY: "The installer is
// split into modules under 200 KiB each, with every export and every test
// unchanged"). install-harness.mjs keeps every name it exported on 0.30.5;
// the code that never reads the registry, fetches a shell or runs a host
// command lives in three leaf modules beside it, and every one of the four
// stays under the directory guard's headroom rule.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/installer-modules.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importSpecifiers } from "./fixtures/imports.mjs";
import { loadHarnesses, MANIFEST_DIR } from "../scripts/harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const load = (n) => import(pathToFileURL(join(SCRIPTS, n)).href);

// Our own headroom under the directory's 256 KiB file limit: no shipped .mjs
// above 200 KiB.
const HEADROOM = 204800;
const LEAVES = ["install-handlers.mjs", "install-layout.mjs", "install-preview.mjs"];
// What a leaf never imports: the installer itself, and every module that reads
// the registry, fetches a shell or runs a host command.
const FORBIDDEN = ["./install-harness.mjs", "./convergence.mjs", "./fetch-shell.mjs", "./run-host.mjs"];

// install-harness.mjs's exports on 0.30.5 (6a0e375), every one of which an
// importer or a test names.
const EXPORTS = [
  "GENERATOR",
  "apply",
  "applyReporter",
  "asksAtTerminal",
  "badgeLine",
  "channelText",
  "confirm",
  "gateText",
  "isEphemeralRoot",
  "isInteractive",
  "noticeText",
  "plan",
  "planOptions",
  "publicItem",
  "registrationManifest",
  "renderDone",
  "renderPreview",
  "runVerb",
  "switchUnanswered",
];

// The rule tests/portability.test.mjs holds the installer to: a comment may
// name a harness, code may not. Line comments first, then block comments.
const stripComments = (src) => src.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

test("installer modules: install-harness.mjs exports the same names as on 0.30.5, and its generator line is unchanged", async () => {
  const ih = await load("install-harness.mjs");
  assert.deepEqual(Object.keys(ih).sort(), [...EXPORTS].sort());
  // Every launcher carries this path; a new one would re-stamp them all.
  assert.equal(ih.GENERATOR, "scripts/install-harness.mjs");
});

test("installer modules: what moved is re-exported, not copied — the installer's names are the leaf modules' own functions", async () => {
  const ih = await load("install-harness.mjs");
  const preview = await load("install-preview.mjs");
  for (const n of ["renderPreview", "badgeLine", "noticeText", "applyReporter"]) {
    assert.equal(typeof preview[n], "function", `install-preview.mjs exports ${n}`);
    assert.equal(ih[n], preview[n], `install-harness.mjs re-exports install-preview.mjs's ${n}`);
  }
});

test("installer modules: every scripts/install*.mjs is at most 204,800 bytes, the headroom rule", () => {
  const files = readdirSync(SCRIPTS)
    .filter((n) => /^install.*\.mjs$/.test(n))
    .sort();
  for (const n of files) {
    const size = statSync(join(SCRIPTS, n)).size;
    assert.ok(size <= HEADROOM, `scripts/${n} is ${size} bytes, above ${HEADROOM}`);
  }
  assert.deepEqual(files, ["install-handlers.mjs", "install-harness.mjs", "install-layout.mjs", "install-preview.mjs"]);
});

test("installer modules: the leaf modules name no harness id in code", () => {
  const ids = [...loadHarnesses(MANIFEST_DIR).values()].map((m) => m.id);
  assert.ok(ids.length >= 2, "the manifests load");
  for (const n of LEAVES) {
    const code = stripComments(readFileSync(join(SCRIPTS, n), "utf8"));
    for (const id of ids)
      assert.ok(!new RegExp(`["'\`]${id}["'\`]`).test(code), `scripts/${n} names the harness "${id}" in code`);
  }
});

test("installer modules: a leaf imports neither the installer nor what reads the registry, fetches a shell or runs a host command", () => {
  for (const n of LEAVES) {
    const src = readFileSync(join(SCRIPTS, n), "utf8");
    const specs = importSpecifiers(src);
    assert.ok(specs.length > 0, `scripts/${n} imports something`);
    for (const s of specs) {
      assert.ok(!FORBIDDEN.includes(s), `scripts/${n} imports ${s}`);
      assert.notEqual(s, "node:child_process", `scripts/${n} imports node:child_process`);
    }
    assert.ok(!/\bimport\s*\(/.test(src), `scripts/${n} has a dynamic import`);
    assert.ok(!src.includes("child_process"), `scripts/${n} names child_process`);
  }
});

test("installer modules: no leaf module is in the SessionStart hook's static import graph", () => {
  const graph = new Set();
  const walk = (file) => {
    if (graph.has(file)) return;
    graph.add(file);
    for (const s of importSpecifiers(readFileSync(file, "utf8")))
      if (s.startsWith(".")) walk(resolve(dirname(file), s));
  };
  walk(join(ROOT, "hooks", "session-start.mjs"));
  assert.ok(graph.has(join(SCRIPTS, "doctor.mjs")), "the walk reaches doctor.mjs");
  for (const n of LEAVES) assert.ok(existsSync(join(SCRIPTS, n)), `scripts/${n} exists`);
  for (const n of [...LEAVES, "install-harness.mjs", "provenance.mjs"])
    assert.ok(!graph.has(join(SCRIPTS, n)), `the SessionStart graph loads scripts/${n}`);
});

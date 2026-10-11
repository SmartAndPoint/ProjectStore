// projectstore — the band module's own tests, run by the host that runs it.
//
// tests/band/*.test.tsx run under `claude plugin test`, the Claude Code test
// kit, which loads hooks/band.tsx as a session would. CI has Node only, and a
// machine whose Claude Code has hooks modules switched off refuses the run:
// in both cases every test is reported SKIPPED by its own name, never passed
// (the band spec, Testing). Where the CLI runs, each test is reported as the
// kit reported it, and `claude plugin validate` must accept the plugin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "tests", "band");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".test.tsx")).sort();

// Each test's name as its file writes it: test('…', …) with a plain string.
const titles = (file) => [...readFileSync(join(DIR, file), "utf8").matchAll(/^test\((["'`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2].replace(/\\(.)/g, "$1"));

function claude(args) {
  // A CLI that hangs is a refusal too: its tests are skipped by name, and
  // npm test is not held for longer than this.
  const r = spawnSync("claude", args, { cwd: ROOT, encoding: "utf8", timeout: 180_000, env: process.env });
  if (r.error) return { missing: true, why: r.error.code === "ENOENT" ? "no Claude Code CLI on PATH" : String(r.error.message) };
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

const version = claude(["--version"]);
const run = version.missing ? null : claude(["plugin", "test", ROOT]);

// `(pass) name [12.3ms]` / `(fail) name [12.3ms]`, under each file's header.
const results = new Map();
let refusal = version.missing ? version.why : null;
if (run) {
  let file = null;
  for (const line of run.out.split("\n")) {
    const header = line.match(/^(\S+\.test\.tsx):\s*$/);
    if (header) { file = header[1].replace(/\\/g, "/"); continue; }
    const m = line.match(/^\((pass|fail)\) (.*) \[[\d.]+m?s\]\s*$/);
    if (m && file && file.startsWith("tests/band/")) results.set(`${file.split("/").pop()}\0${m[2]}`, { ok: m[1] === "pass", file });
  }
  if (!results.size) refusal = `claude plugin test did not run the tests: ${run.out.trim().split("\n")[0] || `exit ${run.status}`}`;
}

for (const file of FILES) {
  for (const name of titles(file)) {
    test(`band module (${file}): ${name}`, refusal ? { skip: refusal } : {}, () => {
      const r = results.get(`${file}\0${name}`);
      assert.ok(r, `${name}: the kit reported no result for it`);
      assert.ok(r.ok, `${name}: failed under claude plugin test\n${run.out}`);
    });
  }
}

test("band module: claude plugin validate accepts the plugin", version.missing ? { skip: version.why } : {}, () => {
  const v = claude(["plugin", "validate", ROOT]);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /\.\/band\.tsx hooks: .*ui\.render\{component=AbovePrompt\}/);
});

test("band module: every test file has at least one test the wrapper can name", () => {
  assert.ok(FILES.length > 0);
  for (const f of FILES) assert.ok(titles(f).length > 0, `${f}: no test('…') found`);
});

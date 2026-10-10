// projectstore — tests for run-host.mjs: the one asynchronous runner for a
// host command (the story "Install and upgrade fetch a shell-rooted harness at
// the bin's own version, once per run; plan and uninstall never fetch", as
// amended 2026-10-09). It is spawnSync's result shape, delivered without
// blocking: stdin ignored, both outputs piped and decoded, settled on the
// child's exit with a short drain, and stopped by its budget.
//
//   node --test tests/run-host.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runHost, startFailure, HOST_BUDGET_MS } from "../scripts/run-host.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = (code) => [process.execPath, ["-e", code]];

test("run-host: a child's status and both outputs come back in spawnSync's shape, with stdin ignored", async () => {
  const [bin, argv] = node("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3; process.stdin.on('data', () => process.stdout.write('stdin!'));");
  const r = await runHost(bin, argv, { cwd: tmpdir() });
  assert.deepEqual(r, { status: 3, signal: null, stdout: "out", stderr: "err", error: undefined });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps-run-host-")));
  const ok = await runHost(...node("console.log(process.cwd())"), { cwd: dir });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), dir, "the working directory is the caller's");
});

test("run-host: a character split across two writes stays whole", async () => {
  // "↓" is three bytes; the child writes them in two chunks with a pause between.
  const code = "const b = Buffer.from('a↓b'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30);";
  const r = await runHost(...node(code), { cwd: tmpdir() });
  assert.equal(r.stdout, "a↓b");
});

test("run-host: it settles on the child's exit; a grandchild holding the pipe gets 200 ms, not the run", async () => {
  // The child starts a grandchild that inherits its stdout and lives 3 s, then exits.
  const code = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.stderr.write(String(g.pid)); g.unref();";
  const t0 = Date.now();
  const r = await runHost(...node(code), { cwd: tmpdir() });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(ms < 2000, `settled in ${ms} ms, not when the grandchild let go of the pipe`);
  try { process.kill(Number(r.stderr), "SIGTERM"); } catch {}
});

test("run-host: past its budget the child gets SIGTERM and the result carries ETIMEDOUT with no status", async () => {
  const killed = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { killed.push(signal); return true; };
    child.unref = () => {};
    return child;
  };
  const t0 = Date.now();
  const r = await runHost("npm", ["install"], { cwd: tmpdir(), budget: 50, spawn });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.equal(r.status, null);
  assert.equal(r.error.code, "ETIMEDOUT");
  // A real child, too: a sleeping node is stopped.
  const real = await runHost(...node("setTimeout(() => {}, 10000)"), { cwd: tmpdir(), budget: 100 });
  assert.equal(real.error.code, "ETIMEDOUT");
  assert.equal(HOST_BUDGET_MS, 120000, "the bound every host command gets");
});

test("run-host: a child that cannot start is an error with no status, and startFailure names the cause Node does not", async () => {
  const r = await runHost("projectstore-no-such-binary", [], { cwd: tmpdir(), env: { PATH: "" } });
  assert.equal(r.status, null);
  assert.equal(r.error.code, "ENOENT");
  assert.equal(startFailure(r.error, { bin: "npm", resolved: null, cwd: tmpdir() }), "npm could not start: it was not found on PATH");
  const gone = join(tmpdir(), "ps-run-host-no-such-dir");
  const r2 = await runHost(process.execPath, ["-e", ""], { cwd: gone });
  assert.equal(r2.status, null);
  assert.equal(startFailure(r2.error, { bin: "npm", resolved: process.execPath, cwd: gone }), `npm could not start: the working directory ${JSON.stringify(gone)} is not an existing directory`);
});

test("run-host: the installer's host commands take their bound from HOST_BUDGET_MS, never a literal", () => {
  const src = readFileSync(join(ROOT, "scripts", "install-harness.mjs"), "utf8");
  assert.ok(!/timeout:\s*120000/.test(src), "no literal 120000 timeout is left");
  assert.equal((src.match(/timeout: HOST_BUDGET_MS/g) || []).length, 3, "the list read, the compensation and the planned step");
  assert.ok(!/^function startFailure/m.test(src), "startFailure lives in run-host.mjs");
});

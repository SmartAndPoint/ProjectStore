// projectstore — run-host.mjs: one asynchronous runner for a host command.
//
// The install verbs ran every child through spawnSync, which blocks the event
// loop: nothing can animate while it waits. The shell fetch of install and
// upgrade (the story "Install and upgrade fetch a shell-rooted harness at the
// bin's own version, once per run; plan and uninstall never fetch") is the
// first child a person watches for seconds, so it gets a runner that yields:
// a spawn with stdin ignored and both outputs piped, resolved with spawnSync's
// own result shape so a caller written for one reads the other. APPLY's host
// commands move onto it in a later story (the APPLY story adds `signal`).
//
//   runHost(bin, argv, { env, cwd, budget, spawn, shell })
//     → Promise<{ status, signal, stdout, stderr, error }>
//   startFailure(err, { bin, resolved, cwd }) → what Node could not say
//   HOST_BUDGET_MS                            → the outer bound, 120 s
//
// Leaf module: node built-ins only. Only install-harness.mjs and
// fetch-shell.mjs import it; hooks, doctor, surfaces and lib never do (the
// portability suite asserts it), so the SessionStart graph never loads it.

import { spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";

// The bound every host command gets, ours, outside whatever the child sets
// for itself (npm's per-request timeouts, retried, can outlast it).
export const HOST_BUDGET_MS = 120000;

// How long the pipes may drain after the child exits. A grandchild that keeps
// a pipe open must not hold the run: `close` waited 3 s for one where `exit`
// came at 99 ms (measured 2026-10-09).
const DRAIN_MS = 200;

// spawnSync's shape, asynchronously: `status` is the exit code, or null when
// the child never started or was stopped; `error` carries the start failure
// (never close's -2), or ETIMEDOUT when the budget ran out. Output is decoded
// as UTF-8 by the streams themselves, so a character split across two writes
// stays whole (measured). The budget's SIGTERM settles at once: a child that
// ignores it, or a grandchild still writing, is left to the OS — its pipes are
// destroyed and its handle unref'd, so nothing of it keeps this process open.
// `shell` exists for win32, where npm is npm.cmd and runs only through a
// shell; that path is unverified, as the install spec says of Windows.
export function runHost(bin, argv, { env = process.env, cwd = process.cwd(), budget = HOST_BUDGET_MS, spawn = nodeSpawn, shell = false } = {}) {
  return new Promise((settle) => {
    const out = [], err = [];
    let child = null, done = false, timer = null, drain = null, exited = null;
    const release = () => {
      for (const s of [child?.stdout, child?.stderr]) { try { s?.destroy(); } catch {} }
      try { child?.unref?.(); } catch {}
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      settle({ status: null, signal: null, stdout: out.join(""), stderr: err.join(""), error: undefined, ...r });
    };
    try { child = spawn(bin, argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"], shell }); }
    catch (e) { finish({ error: e }); return; }
    for (const [s, sink] of [[child.stdout, out], [child.stderr, err]]) {
      if (!s) continue;
      s.setEncoding("utf8");
      s.on("data", (d) => sink.push(d));
      // A stream that ends after the exit may be the last one the drain waits on.
      s.on("end", () => { if (exited && drained()) finish(exited); });
      s.on("error", () => {});
    }
    const drained = () => [child.stdout, child.stderr].every((s) => !s || s.readableEnded || s.destroyed);
    child.on("error", (e) => { finish({ error: e, status: null }); release(); });
    child.on("exit", (code, signal) => {
      exited = { status: code, signal };
      if (drained()) { finish(exited); return; }
      drain = setTimeout(() => { finish(exited); release(); }, DRAIN_MS);
    });
    timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ status: null, signal: "SIGTERM", error: Object.assign(new Error(`${bin} ran past its ${budget} ms budget and was stopped`), { code: "ETIMEDOUT" }) });
      release();
    }, budget);
  });
}

// What Node cannot say: spawnSync reports a working directory that does not
// exist and a binary not on PATH with the same `spawnSync <bin> ENOENT`
// (measured 2026-10-05), and spawn the same `spawn <bin> ENOENT`. The
// filesystem tells them apart, in this order (the install spec, contract 19);
// any other error passes through as Node wrote it.
export function startFailure(err, { bin, resolved, cwd }) {
  let dir = false;
  try { dir = statSync(cwd).isDirectory(); } catch {}
  if (!dir) return `${bin} could not start: the working directory ${JSON.stringify(String(cwd))} is not an existing directory`;
  if (!resolved) return `${bin} could not start: it was not found on PATH`;
  if (["ENOENT", "EACCES", "ENOEXEC"].includes(err?.code)) return `${bin} could not start: ${resolved} exists but could not be run (${err.code})`;
  return String(err?.message || err);
}

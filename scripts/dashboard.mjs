// projectstore — dashboard.mjs: the launcher of the page over one vault.
//
// The ADR "The dashboard ships as a package of its own beside the core,
// started by projectstore dashboard, and reads the vault through the core",
// decisions 3 to 5; the spec "The dashboard package and its launcher: the
// folder, the dashboard verb, and a page that only reads" (alias dashboard),
// contracts 3 to 8, and 4 as amended on 2026-11-14.
//
// The page lives in <core root>/dashboard/, which a checkout and a
// git-channel copy have and an npm-channel copy does not. An npm copy takes
// it from ProjectStore's cache, fetched there once per version
// (scripts/dashboard-fetch.mjs, imported only then). This module finds the
// page, starts its server as a child through process.execPath, waits for the
// one line the server prints once it listens, and stops it on an interrupt.
// It opens the default browser at the page's address when the caller says the
// run is a person's. It reads and writes nothing of the vault itself: the
// page's server does the reading, and writes nothing either.
//
//   pageAt(root, env)          → the page's folder, or null
//   parsePort(value)           → a port number, or null
//   openBrowser(url, platform) → true when a program was started for it
//   startDashboard(ctx)        → { usage } | { ok: false, code, result, text }
//                                | { ok: true, code: 0, result, text, wait }
//
// Pure node, no external deps.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// The ports a page takes when none is named: the first free one, in order.
export const PORT_RANGE = Object.freeze([4800, 4809]);
// How long the server may take to print its first line.
const START_MS = 15000;

// The page's folder: the test-only variable's, else <core root>/dashboard.
// It counts when its server file is there.
export function pageAt(root, env = process.env) {
  const dir = env.PROJECTSTORE_DASHBOARD_ROOT ? resolve(env.PROJECTSTORE_DASHBOARD_ROOT) : join(root, "dashboard");
  return existsSync(join(dir, "server.mjs")) ? dir : null;
}

export function parsePort(value) {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

// The program that opens an address in the default browser, by platform. No
// shell: the arguments go as they are.
const OPENERS = Object.freeze({
  darwin: ["open", []],
  win32: ["rundll32", ["url.dll,FileProtocolHandler"]],
  other: ["xdg-open", []],
});

export function openBrowser(url, platform = process.platform) {
  const [program, args] = OPENERS[platform] || OPENERS.other;
  try {
    const child = spawn(program, [...args, url], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// A refusal before anything starts: exit 1, its text in the envelope's error.
const refused = (error) => ({ ok: false, code: 1, result: { error, exit: 1 }, text: `${error}\n` });

// Start the page for `project`. `interactive` is the caller's word that a
// person runs this at a terminal; only then is a browser opened. `signals`
// is where SIGINT and SIGTERM arrive (the process, or a test's emitter).
// `onFetch(label)` draws the fetch's live line (the caller's, at a terminal
// only); `home`, `fetchSpawn` and `fetchBudget` are the tests'.
export async function startDashboard({
  root,
  project,
  values = {},
  env = process.env,
  ownEnv = () => env,
  interactive = false,
  open = openBrowser,
  signals = process,
  stderr = process.stderr,
  startMs = START_MS,
  onFetch = null,
  home,
  fetchSpawn,
  fetchBudget,
}) {
  const named = values.port === undefined ? null : parsePort(values.port);
  if (values.port !== undefined && named === null) return { usage: "`--port` takes a number from 1 to 65535" };
  let dir = pageAt(root, env);
  if (!dir) {
    // A named page folder is the page, or nothing, and is never fetched (the
    // dashboard spec, contract 4).
    if (env.PROJECTSTORE_DASHBOARD_ROOT)
      return refused(
        `PROJECTSTORE_DASHBOARD_ROOT names ${JSON.stringify(resolve(env.PROJECTSTORE_DASHBOARD_ROOT))}, which has no server.mjs: nothing was started or fetched.`,
      );
    const { pageFor } = await import("./dashboard-fetch.mjs");
    const got = await pageFor({ root, project, env, home, spawn: fetchSpawn, budget: fetchBudget, onFetch });
    if (!got.ok) return refused(got.error);
    dir = got.dir;
  }
  const args = [
    join(dir, "server.mjs"),
    "--core",
    root,
    "--project",
    project,
    ...(named === null ? ["--ports", `${PORT_RANGE[0]}-${PORT_RANGE[1]}`] : ["--port", String(named)]),
    "--watch-stdin",
  ];
  const child = spawn(process.execPath, args, { env: ownEnv(project), stdio: ["pipe", "pipe", "pipe"] });
  const ready = await readyLine(child, startMs);
  if (!ready.ok) {
    const why = ready.stderr.trim() || ready.why;
    return { ok: false, code: ready.code || 1, result: { error: why }, text: `${why}\n` };
  }
  const { url, port, vault } = ready.line;
  // After the first line, the server's own lines are its log: stderr.
  child.stdout.on("data", (d) => stderr.write(d));
  child.stderr.on("data", (d) => stderr.write(d));
  const wait = new Promise((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
    child.on("exit", (code) => {
      signals.removeListener("SIGINT", stop);
      signals.removeListener("SIGTERM", stop);
      // An interrupt is how a person ends the page: 0. A server that ends on
      // its own ends the run with its code.
      done(stopping ? 0 : code === null ? 1 : code);
    });
  });
  // Only the page's own address goes to the opener: nothing that could read as an option.
  if (interactive && !values["no-open"] && /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) open(url);
  const name = basename(vault);
  return {
    ok: true,
    code: 0,
    result: { url, port, vault },
    text: `The dashboard of ${name} is at\n${url}\nIt only reads the vault. Stop it with Ctrl+C.\n`,
    wait,
  };
}

// The server's first stdout line, or why there is none: its exit before the
// line (with what it said on stderr), or the time running out.
function readyLine(child, startMs) {
  return new Promise((done) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onOut);
      child.stderr.removeListener("data", onErr);
      done(r);
    };
    const onOut = (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl === -1) return;
      try {
        const line = JSON.parse(out.slice(0, nl));
        if (line && line.ready && typeof line.url === "string") return finish({ ok: true, line });
      } catch {}
      child.kill("SIGTERM");
      finish({ ok: false, code: 1, why: "the dashboard's server said something it should not have", stderr: err });
    };
    const onErr = (d) => {
      err += d;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        code: 1,
        why: `the dashboard's server did not start within ${startMs / 1000} s`,
        stderr: err,
      });
    }, startMs);
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.on("error", (e) => finish({ ok: false, code: 1, why: e.message, stderr: err }));
    // `close` comes after the child's streams have ended, so what it said is all read.
    child.on("close", (code) =>
      finish({ ok: false, code: code || 1, why: "the dashboard's server stopped", stderr: err }),
    );
  });
}

#!/usr/bin/env node
// ProjectStore dashboard: a local page over a project's vault.
//
//   node dashboard/server.mjs --core <root> --project <dir> [--port <n> | --ports <a>-<b>] [--watch-stdin]
//
// stdout carries exactly one line, once the server listens and its start's
// refresh has ended (the spec "The dashboard's write path…", alias
// `dashboard-writes`, contract 4: inside 10 s from the server's own start, a
// running clone or fetch is ended then, and no network call starts after):
//   {"ready":true,"url":"http://127.0.0.1:<port>/","port":<n>,"vault":"<abs>"}
// Everything else goes to stderr. Exit 1 before listening (a version
// mismatch, no binding or no vault, the port taken), exit 2 on bad arguments,
// exit 0 on SIGINT, SIGTERM, or (with --watch-stdin) the end of stdin; each
// first ends the write module's running calls with their process groups.
//
// The server keeps nothing of the vault: every request reads it through the
// core (lib/core.mjs), from the page's own clone while the page can write
// (lib/write.mjs, readCtx()). It answers on 127.0.0.1 only, to a page that
// names this server in its Host header: GET and HEAD read, and the five write
// routes take POST only from the page's own requests, those that carry the
// run's token (the meta tag of `/`) and the page's own Origin (contract 8).
// Only lib/write.mjs starts a process or writes a file.

import { createServer } from "node:http";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openCore } from "./lib/core.mjs";
import { readState, readItem, readArtifacts, readableRel, MEDIA_TYPES } from "./lib/state.mjs";
import { related } from "./lib/related.mjs";
import { openWriter } from "./lib/write.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const HOST = "127.0.0.1";
export const DEFAULT_PORTS = Object.freeze([4800, 4809]);
// The start's budget (contract 4), from the server's own start; a test passes
// a smaller one as `budgets.start`.
export const START_BUDGET_MS = 10000;
// After a stop, how long the process waits for the module's calls to end
// (SIGTERM, 2 s, SIGKILL, 1 s: lib/write.mjs) before it exits anyway.
const STOP_GRACE_MS = 4000;
// The write routes (contract 8). Only the preview and the action read a body.
export const WRITE_ROUTES = Object.freeze(["/api/refresh", "/api/preview", "/api/action", "/api/send", "/api/discard"]);
const BODY_ROUTES = new Set(["/api/preview", "/api/action"]);
const BODY_LIMIT = 64 * 1024;
const TOKEN_META = /<meta name="projectstore-token" content="[^"]*"/;

// The page shows text people typed: scripts, styles, pictures and media come
// from this server only (and pictures from data: URLs); nothing from another site.
const CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
const PAGE_FILE = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|css|html|svg)$/;

class NotFound extends Error {}

// One answer. HEAD gets the same headers and no body.
function send(req, res, code, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-length": bytes.length,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

// True when a segment of the raw path is `.` or `..`, plain or percent-encoded, or does not decode.
function dotSegment(rawPath) {
  return rawPath.split("/").some((seg) => {
    try {
      const s = decodeURIComponent(seg);
      return s === "." || s === "..";
    } catch {
      return true;
    }
  });
}

// A media file of the vault, streamed, with byte ranges so a video can seek (and Safari
// plays it at all). It runs nothing in the page's origin: a sandbox and no sniffing.
function sendMedia(req, res, file) {
  const size = statSync(file).size;
  const headers = {
    "content-type": MEDIA_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "accept-ranges": "bytes",
  };
  let start = 0;
  let end = size - 1;
  let code = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
      return res.end();
    }
    code = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(code, { ...headers, "content-length": size === 0 ? 0 : end - start + 1 });
  if (req.method === "HEAD" || size === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// A file of the page itself: index.html for `/`, else a flat file under public/.
function pageFile(pathname) {
  const name = pathname === "/" ? "/index.html" : pathname;
  if (!PAGE_FILE.test(name)) return null;
  try {
    const base = realpathSync(PUBLIC);
    const real = realpathSync(join(PUBLIC, name.slice(1)));
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// The vault-relative path of `/vault/<path>`, each segment decoded once.
function vaultRel(pathname) {
  try {
    return pathname
      .slice("/vault/".length)
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch {
    return null; // a segment that does not decode names no file
  }
}

// The body of a POST, at most BODY_LIMIT bytes: { ok, value } or { ok: false, error }.
function readBody(req) {
  return new Promise((done) => {
    const parts = [];
    let size = 0;
    let over = false;
    req.on("data", (d) => {
      size += d.length;
      if (size > BODY_LIMIT) over = true;
      else parts.push(d);
    });
    req.on("error", (e) => done({ ok: false, error: `the request's body could not be read: ${e.message}` }));
    req.on("end", () => {
      if (over) return done({ ok: false, error: `the request's body is over ${BODY_LIMIT} bytes` });
      let value;
      try {
        value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        return done({ ok: false, error: "the request's body is no JSON object" });
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return done({ ok: false, error: "the request's body is no JSON object" });
      done({ ok: true, value });
    });
  });
}

// `port()` is the port the server listens on, known once it does. `writer`
// is the write module (lib/write.mjs); the readers take its readCtx(), which
// is openCore's context while the page cannot write. `token` is the run's;
// `started` settles when the start's refresh has ended, and nothing past the
// Host check is answered before it.
export function handler({ writer, token, port, started = Promise.resolve() }) {
  const ownHost = (host) => host === `127.0.0.1:${port()}` || host === `localhost:${port()}`;
  const ownOrigin = (origin) => origin === `http://127.0.0.1:${port()}` || origin === `http://localhost:${port()}`;
  const ownToken = (given) => {
    const a = Buffer.from(typeof given === "string" ? given : "");
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const pathOf = (raw) => {
    if (dotSegment(raw.split("?")[0])) return null;
    try {
      return new URL(raw, `http://${HOST}`).pathname;
    } catch {
      return null;
    }
  };

  // A write route (contract 8): the guard, then whether the page can write
  // (409), then the body of the preview and the action (400: no JSON object,
  // over 64 KiB, or a verb or field outside write.verbs), then the step.
  // Every answer past the guard is { ok, result?, error?, write }.
  async function writeRoute(req, res, p) {
    const shape = (status, fields) => send(req, res, status, { ...fields, write: writer.view() });
    try {
      if (!ownToken(req.headers["x-projectstore-token"]) || !ownOrigin(req.headers.origin)) {
        req.resume();
        return shape(403, { ok: false, error: "this route runs only for the page's own requests: the run's token and the page's own Origin" });
      }
      // The body is read whole first, and judged only once write.can is known.
      const got = BODY_ROUTES.has(p) ? await readBody(req) : (req.resume(), null);
      if (p === "/api/refresh") {
        const r = await writer.refresh();
        return send(req, res, r.status, r.body);
      }
      const w = writer.view();
      if (!w.can) return shape(409, { ok: false, error: w.reason });
      if (got) {
        if (!got.ok) return shape(400, { ok: false, error: got.error });
        const r = p === "/api/preview" ? await writer.preview(got.value) : await writer.action(got.value);
        return send(req, res, r.status, r.body);
      }
      if (!w.batch) return shape(409, { ok: false, error: `no batch is open, so there is nothing to ${p === "/api/send" ? "send" : "discard"}` });
      // Send and Discard come with the steps that build them.
      return shape(501, { ok: false, error: `${p} is not built in this version of the page` });
    } catch (e) {
      // An error the step did not expect: 500 in the same shape (a step's own lock is released by the step).
      return shape(500, { ok: false, error: String(e?.message || e) });
    }
  }

  return async (req, res) => {
    try {
      // The Host first: a page served from another name (DNS rebinding) gets nothing.
      if (!ownHost(String(req.headers.host || "").toLowerCase())) return send(req, res, 403, { error: "this server answers only at 127.0.0.1 or localhost on its own port" });
      await started;
      const raw = String(req.url || "");
      const p = pathOf(raw);
      const writing = WRITE_ROUTES.includes(p);
      if (req.method === "POST" && writing) return await writeRoute(req, res, p);
      // OPTIONS too: no preflight is answered, so no Access-Control-Allow-* header is sent.
      if (req.method !== "GET" && req.method !== "HEAD") {
        req.resume();
        return send(req, res, 405, { error: writing ? "this route takes POST from the page itself" : "this path answers GET and HEAD" }, { allow: writing ? "POST" : "GET, HEAD" });
      }
      // A `.` or `..` segment names no route, written plain or encoded (`%2e%2e`): refused
      // before the URL parser folds it away. A segment that does not decode names nothing.
      // No GET or HEAD reaches a write route, and none starts a process.
      if (p === null || writing) throw new NotFound();
      const url = new URL(raw, `http://${HOST}`);
      // While the page can write, the readers read its clone; the state still
      // names the real project and the bound vault (lib/state.mjs).
      const ctx = writer.readCtx();
      if (p === "/api/state") return send(req, res, 200, { ...readState(ctx), write: writer.view() });
      if (p === "/api/artifacts") return send(req, res, 200, readArtifacts(ctx));
      if (p === "/api/item") {
        const item = readItem(ctx, url.searchParams.get("rel") || "");
        return item ? send(req, res, 200, item) : send(req, res, 404, { error: "no such artifact" });
      }
      if (p === "/api/related") {
        const r = related(ctx, url.searchParams.get("rel") || "");
        return r ? send(req, res, 200, r) : send(req, res, 404, { error: "no such artifact" });
      }
      // A file of the vault that a document shows: a picture, a video, a sound or a PDF.
      if (p.startsWith("/vault/")) {
        const rel = vaultRel(p);
        const file = rel && readableRel(ctx, rel, { media: true });
        if (!file) return send(req, res, 404, { error: "no such file" });
        return sendMedia(req, res, file);
      }
      const file = pageFile(p);
      if (!file) throw new NotFound();
      let bytes = readFileSync(file);
      // The run's token reaches the page in the meta tag of `/` (contract 8).
      if (file.endsWith(`${sep}index.html`)) bytes = Buffer.from(bytes.toString("utf8").replace(TOKEN_META, `<meta name="projectstore-token" content="${token}"`));
      return send(req, res, 200, bytes, { "content-type": TYPES[extname(file)] || "text/plain; charset=utf-8", "content-security-policy": CSP });
    } catch (e) {
      if (e instanceof NotFound) return send(req, res, 404, { error: "not found" });
      return send(req, res, 500, { error: String(e?.message || e) });
    }
  };
}

// Listen on one port; resolves with the port, rejects with the listen error.
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

// Start the page for one project. `port` tries that port alone (0: the OS
// picks); `ports` ([a, b]) tries each in order, the listen itself being the
// probe. With neither, DEFAULT_PORTS. Throws before listening when the core
// does not match, the project is not bound, or no port is free.
//
// Then the start's refresh (contract 4), and only then does the promise
// resolve: that moment stands for the ready line. Its network part ends at
// `since + budgets.start` (START_BUDGET_MS from `since`, the server's own
// start; the call's moment when left out). The other options are the write
// module's (lib/write.mjs, openWriter): `budgets` (git, verb, gh, clone, in
// ms), `record` (the spawn record: an array or a function), `env`, `now` and
// `platform`. The command line passes none of them. `signal` (an AbortSignal)
// stops the start: the module's running calls end with their process groups,
// the server closes, and the promise rejects with code ABORT_ERR.
//
// → { server, url, port, vault (the bound vault), token, writer, startError
// (the start's refresh failure, or null), close() }; close() ends the
// module's running calls first.
export async function startServer({ core, project, port = null, ports = null, budgets = {}, record = null, env = process.env, now, platform, since = Date.now(), signal = null } = {}) {
  const aborted = () => Object.assign(new Error("the server was stopped before it was ready"), { code: "ABORT_ERR" });
  if (signal?.aborted) throw aborted();
  const ctx = await openCore({ core, project });
  const { start: startBudget = START_BUDGET_MS, ...callBudgets } = budgets || {};
  const writer = await openWriter({ ctx, budgets: callBudgets, record, env, now, platform });
  const onAbort = () => {
    writer.stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const token = randomBytes(32).toString("hex");
  let startEnded;
  const started = new Promise((r) => (startEnded = r));
  let bound = 0;
  const server = createServer(handler({ writer, token, port: () => bound, started }));
  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      signal?.removeEventListener("abort", onAbort);
      startEnded();
      await writer.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    })());
  const single = port !== null && port !== undefined;
  const tries = single ? [port] : range(ports || DEFAULT_PORTS);
  for (const p of tries) {
    try {
      bound = await listenOn(server, p);
      break;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") {
        await close();
        throw e;
      }
    }
  }
  if (!bound) {
    await close();
    if (single) throw new Error(`port ${port} is in use`);
    throw new Error(`ports ${tries[0]}–${tries[tries.length - 1]} are all in use; pass --port`);
  }
  // The start's refresh: when another live process holds the lock it runs
  // nothing and reads the clone as it is (the module decides). One that
  // failed (a 5xx answer, or an error it did not expect) is kept as
  // `startError`, for main() to print; the page still reads.
  let startError = null;
  if (!signal?.aborted) {
    try {
      const r = await writer.refresh({ start: true, deadline: Number(since) + startBudget });
      if (r.status >= 500) startError = String(r.body?.error || `the refresh answered ${r.status}`);
    } catch (e) {
      startError = String(e?.message || e);
    }
  }
  startEnded();
  if (signal?.aborted) {
    await close();
    throw aborted();
  }
  return { server, url: `http://${HOST}:${bound}/`, port: bound, vault: ctx.vault, token, writer, startError, close };
}

function range([a, b]) {
  const out = [];
  for (let p = a; p <= b; p++) out.push(p);
  return out;
}

// ── the command line ──
const USAGE = "usage: node dashboard/server.mjs --core <root> --project <dir> [--port <n> | --ports <a>-<b>] [--watch-stdin]";

function parseArgs(argv) {
  const out = { core: null, project: null, port: null, ports: null, watchStdin: false };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const portNumber = (s, name, min) => {
    if (!/^\d+$/.test(s)) throw new Error(`${name}: not a port number: ${s}`);
    const n = Number(s);
    if (n < min || n > 65535) throw new Error(`${name}: ${s} is out of range (${min}–65535)`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--core") out.core = value(i++, a);
    else if (a === "--project") out.project = value(i++, a);
    else if (a === "--port") out.port = portNumber(value(i++, a), a, 0);
    else if (a === "--ports") {
      const v = value(i++, a);
      const m = v.match(/^(\d+)-(\d+)$/);
      if (!m) throw new Error(`--ports takes <a>-<b>, as 4800-4809: ${v}`);
      const lo = portNumber(m[1], a, 1);
      const hi = portNumber(m[2], a, 1);
      if (lo > hi) throw new Error(`--ports: ${lo} is above ${hi}`);
      out.ports = [lo, hi];
    } else if (a === "--watch-stdin") out.watchStdin = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.core) throw new Error("--core <root> is required");
  if (!out.project) throw new Error("--project <dir> is required");
  if (out.port !== null && out.ports !== null) throw new Error("--port and --ports cannot be given together");
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`dashboard: ${e.message}\n${USAGE}\n`);
    process.exit(2);
  }
  // The signals are heard from the start: one that comes during the start's
  // refresh ends the module's running calls, so no process group is left.
  const abort = new AbortController();
  let page = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
    if (page) page.close().then(() => process.exit(0));
    else abort.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (args.watchStdin) {
    process.stdin.on("end", stop);
    process.stdin.on("error", stop);
    process.stdin.resume();
  }
  try {
    // The start budget counts from this process's own start.
    page = await startServer({ ...args, since: performance.timeOrigin, signal: abort.signal });
  } catch (e) {
    if (abort.signal.aborted) process.exit(0);
    process.stderr.write(`dashboard: ${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ready: true, url: page.url, port: page.port, vault: page.vault })}\n`);
  if (page.startError) process.stderr.write(`dashboard: the start's refresh failed: ${page.startError}\n`);
  const write = page.writer.view();
  process.stderr.write(`dashboard: ${page.url} reads ${page.vault}; ${write.can ? `the page writes through its own clone, ${page.writer.paths.clone}` : `no writes: ${write.reason}`}\n`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

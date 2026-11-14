#!/usr/bin/env node
// ProjectStore dashboard: a local page over a project's vault, that only reads.
//
//   node dashboard/server.mjs --core <root> --project <dir> [--port <n> | --ports <a>-<b>] [--watch-stdin]
//
// stdout carries exactly one line, once the server listens:
//   {"ready":true,"url":"http://127.0.0.1:<port>/","port":<n>,"vault":"<abs>"}
// Everything else goes to stderr. Exit 1 before listening (a version
// mismatch, no binding or no vault, the port taken), exit 2 on bad arguments,
// exit 0 on SIGINT, SIGTERM, or (with --watch-stdin) the end of stdin.
//
// The server keeps nothing: every request reads the vault through the core
// (lib/core.mjs). It answers GET and HEAD only, on 127.0.0.1 only, to a page
// that names this server in its Host header.

import { createServer } from "node:http";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openCore } from "./lib/core.mjs";
import { readState, readItem, readArtifacts, readableRel, MEDIA_TYPES } from "./lib/state.mjs";
import { related } from "./lib/related.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const HOST = "127.0.0.1";
export const DEFAULT_PORTS = Object.freeze([4800, 4809]);

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

// `port()` is the port the server listens on, known once it does.
export function handler(ctx, port) {
  const ownHost = (host) => host === `127.0.0.1:${port()}` || host === `localhost:${port()}`;
  return (req, res) => {
    try {
      // The Host first: a page served from another name (DNS rebinding) gets nothing.
      if (!ownHost(String(req.headers.host || "").toLowerCase())) return send(req, res, 403, { error: "this server answers only at 127.0.0.1 or localhost on its own port" });
      if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { error: "the dashboard only reads: GET and HEAD" }, { allow: "GET, HEAD" });
      // A `.` or `..` segment names no route, written plain or encoded (`%2e%2e`): refused
      // before the URL parser folds it away. A segment that does not decode names nothing.
      if (dotSegment(String(req.url || "").split("?")[0])) throw new NotFound();
      const url = new URL(req.url, `http://${HOST}`);
      const p = url.pathname;
      if (p === "/api/state") return send(req, res, 200, readState(ctx));
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
      return send(req, res, 200, readFileSync(file), { "content-type": TYPES[extname(file)] || "text/plain; charset=utf-8", "content-security-policy": CSP });
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
export async function startServer({ core, project, port = null, ports = null } = {}) {
  const ctx = await openCore({ core, project });
  let bound = 0;
  const server = createServer(handler(ctx, () => bound));
  const single = port !== null && port !== undefined;
  const tries = single ? [port] : range(ports || DEFAULT_PORTS);
  for (const p of tries) {
    try {
      bound = await listenOn(server, p);
      break;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") throw e;
    }
  }
  if (!bound) {
    if (single) throw new Error(`port ${port} is in use`);
    throw new Error(`ports ${tries[0]}–${tries[tries.length - 1]} are all in use; pass --port`);
  }
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  return { server, url: `http://${HOST}:${bound}/`, port: bound, vault: ctx.vault, close };
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
  let page;
  try {
    page = await startServer(args);
  } catch (e) {
    process.stderr.write(`dashboard: ${e.message}\n`);
    process.exit(1);
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref();
    page.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (args.watchStdin) {
    process.stdin.on("end", stop);
    process.stdin.on("error", stop);
    process.stdin.resume();
  }
  process.stdout.write(`${JSON.stringify({ ready: true, url: page.url, port: page.port, vault: page.vault })}\n`);
  process.stderr.write(`dashboard: ${page.url} reads ${page.vault} (read only)\n`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

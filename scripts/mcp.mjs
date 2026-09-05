// projectstore — mcp.mjs
//
// The MCP read surface: a hand-rolled JSON-RPC server over stdio, one tool
// per CLI verb (MCP ADR decisions 2, 3, 4, 6). A front-end over the
// front-end: every tool call runs the CLI's own `run()` in-process with
// captured streams and returns the envelope it wrote, so a tool result equals
// `projectstore <verb> --json` by construction, `doctor` stays spawned, and
// the exit code maps onto `isError`. Nothing here reads an artifact's
// frontmatter, walks the vault or names a branded environment variable —
// cli.mjs, query.mjs and harness.mjs do, once each; the resources read the
// three derived views and one artifact file whole, which is what a resource is.
//
// stdout is the protocol channel. This module writes to it only through
// serve()'s frame writer; importing it prints nothing (a test asserts it),
// and every module it reaches guards its main() with lib.isMain.
//
// Protocol era: the LEGACY `initialize` handshake — revisions 2025-11-25
// and 2025-06-18 accepted — which is what Claude Code 2.1.261
// speaks (measured 2026-09-05: `initialize` with protocolVersion 2025-11-25
// and request id 0; `tools/list` and `resources/list` at connect;
// `resources/templates/list` on demand; shutdown by SIGINT). The 2026-07-28
// revision's `server/discover` is answered with -32601 ON PURPOSE: that is
// the documented signal that makes a dual-era client fall back to
// `initialize`. Moving eras is an ADR amendment, not a refactor.
//
// Binding (ADR decision 6): the project comes from --project,
// PROJECTSTORE_PROJECT_DIR or the harness-declared project directory —
// never the ambient cwd. Started with none of them, or with a placeholder the
// host did not expand (`${…}` arrives literally when unset), the server
// exits non-zero naming what it needed. An UNBOUND project is different: the
// server starts, `status` says bound:false, and every other tool answers
// isError naming /projectstore:bind — refusing to start would put a red
// entry in the host's plugin errors for every new user.
//
// Normative: the MCP ADR (accepted 2026-09-04, amended 2026-09-05); the
// PS-CORE story "MCP read surface: hand-rolled stdio, one tool per CLI verb".

import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { run, envelope, packageVersion } from "./cli.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "projectstore.mjs");

// Exit codes → isError. 0 is ok; 1 is "findings or a refusal" — a doctor that
// found issues has SUCCEEDED, and the envelope carries ok:false already; 2
// (usage) and 3 (not bound) are the tool failing to answer at all.
export const isErrorExit = (code) => code !== 0 && code !== 1;

// doctor is the one verb the CLI spawns synchronously, which would hold this
// server's loop for up to a minute — no ping answered, no other call served.
// It runs as an asynchronous spawn of this same bin instead; stdout is still
// the CLI's envelope, so parity holds.
function spawnBin(argv, { env, cwd, timeoutMs = DOCTOR_TIMEOUT_MS }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...argv], { env, cwd: existsSync(cwd) ? cwd : undefined, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); err += `timed out after ${timeoutMs} ms`; }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); done({ code: 2, out, err: err + e.message }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code: code === null ? 2 : code, out, err }); });
  });
}
import { readConfigAt, isInsideVault } from "./lib.mjs";

// Two revisions, not four: 2025-03-26 has JSON-RPC batching (removed again in
// 2025-06-18), which this server answers with -32600 — advertising that
// revision would be a lie the conformance test could not see.
export const PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18"]);
export const DOCTOR_TIMEOUT_MS = 60000;
export const SERVER_NAME = "projectstore";
export const TOOL_CEILING = 8;
export const TOOL_LIST_TOKEN_CEILING = 3000; // ADR decision 7, chars/4
export const RESOURCE_SCHEME = "projectstore://";

// JSON-RPC error codes.
export const E_PARSE = -32700;
export const E_INVALID_REQUEST = -32600;
export const E_METHOD_NOT_FOUND = -32601;
export const E_INVALID_PARAMS = -32602;
export const E_INTERNAL = -32603;

// ─── The tool table ────────────────────────────────────────────────────
//
// One row per MCP tool: the verb it is the JSON form of, how its arguments
// become argv, and the input schema a client sees. cli.mjs's VERBS rows name
// these tools in their `mcp` field; a drift test pins the two tables to each
// other in both directions.

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const int = (description, minimum = 0) => ({ type: "integer", minimum, description });
const strs = (description) => ({ type: "array", items: { type: "string" }, description });
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const flag = (name, v) => (v ? [`--${name}`] : []);
const opt = (name, v) => (v === undefined || v === null ? [] : [`--${name}`, String(v)]);
const many = (name, vs) => (Array.isArray(vs) ? vs.flatMap((v) => [`--${name}`, String(v)]) : []);
// argv() returns {opts, positionals}: the CLI receives
// [verb, ...opts, --json, --project, <dir>, --, ...positionals], so a value
// beginning with "-" (a search for "--kind", a path named "-x") is a
// positional, never an option the parser would act on.
const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export const TOOLS = Object.freeze({
  status: {
    verb: "status",
    description: "The project's binding, the stories in progress, and whether the derived views are fresh.",
    inputSchema: schema({}),
    argv: () => ({ opts: [], positionals: [] }),
  },
  orientation: {
    verb: "orientation",
    description: "The vault's navigation skeleton (the SessionStart orientation) and the facts behind it.",
    inputSchema: schema({}),
    argv: () => ({ opts: [], positionals: [] }),
  },
  search: {
    verb: "search",
    description: "Find a phrase in the vault's artifacts: literal, case-insensitive by default, bounded; matches carry path, line, snippet, type, title, status.",
    inputSchema: schema({
      query: str("the phrase to find (literal substring)"),
      kind: strs("only artifacts of these kinds (adr, spec, epic, story, research, …)"),
      status: str("only artifacts in this status"),
      limit: int("at most this many matches (default 20, hard cap 100)", 1),
      include_derived: bool("search the derived views (kanban, code-map, graph) too"),
      case_sensitive: bool("match case"),
    }, ["query"]),
    argv: (a) => ({ opts: [...many("kind", a.kind), ...opt("status", a.status), ...opt("limit", a.limit), ...flag("include-derived", a.include_derived), ...flag("case-sensitive", a.case_sensitive)], positionals: [a.query] }),
  },
  get_artifact: {
    verb: "show",
    description: "One artifact by vault-relative path: its frontmatter, and its body or one section on request.",
    inputSchema: schema({
      path: str("vault-relative path of the artifact"),
      body: bool("include the body"),
      section: str("one section by its registry id (description, acceptance, …)"),
    }, ["path"]),
    argv: (a) => ({ opts: [...flag("body", a.body), ...opt("section", a.section)], positionals: [a.path] }),
  },
  neighbors: {
    verb: "graph",
    description: "The typed links of one artifact in both directions, from the live link graph (the same edges graph.md holds).",
    inputSchema: schema({
      path: str("vault-relative path of the artifact"),
      kind: strs("only edges of these kinds (wikilink, dead, supersedes, spec-covers, spec-implements-adr, epic-contains, …)"),
      direction: { type: "string", enum: ["in", "out", "both"], description: "which edges (default both)" },
      limit: int("cap per direction (default and maximum 100)", 1),
    }, ["path"]),
    argv: (a) => ({ opts: [...many("kind", a.kind), ...opt("direction", a.direction), ...opt("limit", a.limit)], positionals: ["neighbors", a.path] }),
  },
  lineage: {
    verb: "graph",
    description: "The typed ancestry and descent of one artifact: supersedes, spec-covers, spec-implements-adr, epic-contains, breadth-first to a depth (default 3).",
    inputSchema: schema({
      path: str("vault-relative path of the artifact"),
      kind: strs("only these lineage kinds (a subset of the four)"),
      depth: int("how far to walk (default 3, maximum 10)"),
    }, ["path"]),
    argv: (a) => ({ opts: [...many("kind", a.kind), ...opt("depth", a.depth)], positionals: ["lineage", a.path] }),
  },
  code_refs: {
    verb: "codemap",
    description: "Which code an epic or artifact maps to (its code_refs), or which artifacts map to a repository path; the result says which reading was taken.",
    inputSchema: schema({
      selector: str("an epic id, an artifact identity or vault path, or a repository-relative path"),
      reverse: bool("read the selector as a path even if it names an artifact"),
    }, ["selector"]),
    argv: (a) => ({ opts: [...opt("for", a.selector), ...flag("reverse", a.reverse)], positionals: [] }),
  },
  doctor: {
    verb: "doctor",
    description: "Check the install wiring and the vault's consistency: findings with severity, id and remedy. The slow tool (it spawns the doctor script).",
    inputSchema: schema({
      install: bool("only the install section"),
      vault: bool("only the vault section"),
    }),
    argv: (a) => ({ opts: [...flag("install", a.install), ...flag("vault", a.vault)], positionals: [] }),
  },
});

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: { ...READ_ONLY } }));
}

// ─── Resources ─────────────────────────────────────────────────────────

export const RESOURCES = Object.freeze([
  { uri: `${RESOURCE_SCHEME}orientation`, name: "orientation", description: "The vault's navigation skeleton, as SessionStart renders it.", mimeType: "text/markdown" },
  { uri: `${RESOURCE_SCHEME}kanban`, name: "kanban", description: "The derived board (kanban.md).", mimeType: "text/markdown", file: "kanban.md" },
  { uri: `${RESOURCE_SCHEME}graph`, name: "graph", description: "The derived link graph (graph.md) — large; grep it by vault-relative path.", mimeType: "text/markdown", file: "graph.md" },
]);

export const RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: `${RESOURCE_SCHEME}artifact/{path}`, name: "artifact", description: "One artifact's markdown by vault-relative path (percent-encoded).", mimeType: "text/markdown" },
]);

// ─── The server ────────────────────────────────────────────────────────

class Sink {
  constructor() { this.text = ""; }
  write(s) { this.text += String(s); return true; }
  get isTTY() { return false; }
}

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const hasId = (m) => m && typeof m === "object" && "id" in m && m.id !== null; // 0 is a valid id — never `if (!msg.id)`

// A project directory the host handed over verbatim rather than expanded.
export const UNEXPANDED = /\$\{[A-Za-z_]/;

// Why the server may not start, or null.
export function startRefusal(project) {
  if (!project) return "projectstore mcp: no project directory — pass --project <dir> or set PROJECTSTORE_PROJECT_DIR (the host's own project variable is honoured when present).";
  if (UNEXPANDED.test(project)) return `projectstore mcp: the project directory "${project}" still contains a placeholder the host did not expand — pass --project <dir> or set PROJECTSTORE_PROJECT_DIR.`;
  return null;
}

export function createServer({ project, env = process.env, cwd = project, version = packageVersion(), runVerb = run } = {}) {
  let initialized = false;
  const cfgOf = () => readConfigAt(project);
  const vaultOf = () => { const c = cfgOf(); return c && c.vault_path ? String(c.vault_path).replace(/\/+$/, "") : null; };

  async function callTool(name, args) {
    const t = TOOLS[name];
    if (!t) return { error: rpcError(null, E_INVALID_PARAMS, `unknown tool: ${name}`).error };
    const a = args && typeof args === "object" ? args : {};
    for (const r of t.inputSchema.required) if (a[r] === undefined || a[r] === null || a[r] === "") return { error: rpcError(null, E_INVALID_PARAMS, `${name}: "${r}" is required`).error };
    for (const [k, v] of Object.entries(a)) {
      if (!Object.hasOwn(t.inputSchema.properties, k)) return { error: rpcError(null, E_INVALID_PARAMS, `${name}: unknown argument "${k}"`).error };
      const want = t.inputSchema.properties[k].type;
      const okType = want === "array" ? Array.isArray(v) && v.every((x) => typeof x === "string") : want === "integer" ? Number.isInteger(v) : typeof v === want;
      if (!okType) return { error: rpcError(null, E_INVALID_PARAMS, `${name}: "${k}" must be ${want === "array" ? "an array of strings" : want === "integer" ? "an integer" : "a " + want}`).error };
      // An option value that starts with "-" would read as a flag to the CLI's parser; a positional is safe behind "--".
      if (typeof v === "string" && v.startsWith("-") && ["section", "status", "direction", "selector"].includes(k)) return { error: rpcError(null, E_INVALID_PARAMS, `${name}: "${k}" may not start with "-"`).error };
    }
    if (name !== "status" && !cfgOf()) {
      return { content: [{ type: "text", text: JSON.stringify(envelope(t.verb, project, false, { error: `${project} is not bound to a vault — run /projectstore:bind <vault> in a session, or projectstore bind <vault> --project ${project}` })) }], isError: true };
    }
    const { opts, positionals } = t.argv(a);
    const argv = [t.verb, ...opts, "--json", "--project", project, ...(positionals.length ? ["--", ...positionals] : [])];
    let code, outText, errText;
    if (t.verb === "doctor") {
      ({ code, out: outText, err: errText } = await spawnBin(argv, { env, cwd }));
    } else {
      const out = new Sink(), err = new Sink();
      try {
        code = await runVerb(argv, { env, cwd: existsSync(cwd) ? cwd : undefined, stdin: null, stdout: out, stderr: err, ask: async () => "no" });
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(envelope(t.verb, project, false, { error: e.message })) }], isError: true };
      }
      outText = out.text; errText = err.text;
    }
    const text = outText.trim() || JSON.stringify(envelope(t.verb, project, false, { error: errText.trim() || `exit ${code}`, exit: code }));
    return { content: [{ type: "text", text }], isError: isErrorExit(code) };
  }

  function resourceList() {
    const vault = vaultOf();
    return RESOURCES.map((r) => {
      const row = { uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType };
      if (r.file && vault) { try { row.size = statSync(join(vault, r.file)).size; } catch {} }
      return row;
    });
  }

  async function readResource(uri) {
    if (typeof uri !== "string" || !uri.startsWith(RESOURCE_SCHEME)) return { error: { code: E_INVALID_PARAMS, message: `unknown resource: ${uri}` } };
    const vault = vaultOf();
    const rest = uri.slice(RESOURCE_SCHEME.length);
    if (rest === "orientation") {
      const out = new Sink(), err = new Sink();
      const code = await runVerb(["orientation", "--project", project], { env, cwd: existsSync(cwd) ? cwd : undefined, stdin: null, stdout: out, stderr: err, ask: async () => "no" });
      if (code !== 0) return { error: { code: code === 3 ? E_INVALID_PARAMS : E_INTERNAL, message: err.text.trim() || `orientation exited ${code}` } };
      return { contents: [{ uri, mimeType: "text/markdown", text: out.text }] };
    }
    const fixed = RESOURCES.find((r) => r.file && r.name === rest);
    if (fixed) {
      if (!vault) return { error: { code: E_INVALID_PARAMS, message: `${project} is not bound to a vault` } };
      const p = join(vault, fixed.file);
      if (!existsSync(p)) return { error: { code: E_INVALID_PARAMS, message: `${fixed.file} does not exist yet — run reconcile` } };
      // A read can fail on an existing file (an iCloud-evicted, dataless one): an error, not a crash.
      try { return { contents: [{ uri, mimeType: "text/markdown", text: readFileSync(p, "utf8") }] }; } catch (e) { return { error: { code: E_INTERNAL, message: `${fixed.file}: ${e.message}` } }; }
    }
    if (rest.startsWith("artifact/")) {
      if (!vault) return { error: { code: E_INVALID_PARAMS, message: `${project} is not bound to a vault` } };
      let rel;
      try { rel = decodeURIComponent(rest.slice("artifact/".length)); } catch { return { error: { code: E_INVALID_PARAMS, message: "artifact path is not valid percent-encoding" } }; }
      // Containment: resolved (collapses `..`), then the vault prefix test,
      // then the realpath so a symlink out of the vault is refused too.
      const abs = resolve(vault, rel);
      if (!isInsideVault(abs, vault)) return { error: { code: E_INVALID_PARAMS, message: `${rel} is outside the vault` } };
      let real;
      try { real = statSync(abs).isFile() ? realpathSync(abs) : null; } catch { real = null; }
      if (!real || !isInsideVault(real, realpathSync(vault))) return { error: { code: E_INVALID_PARAMS, message: `${rel} is not an artifact of the vault` } };
      try { return { contents: [{ uri: `${RESOURCE_SCHEME}artifact/${encodeURIComponent(rel).replace(/%2F/g, "/")}`, mimeType: "text/markdown", text: readFileSync(real, "utf8") }] }; } catch (e) { return { error: { code: E_INTERNAL, message: `${rel}: ${e.message}` } }; }
    }
    return { error: { code: E_INVALID_PARAMS, message: `unknown resource: ${uri}` } };
  }

  // One message in, one response (or null for a notification) out. Pure of
  // I/O: the loop owns the streams.
  async function handle(msg) {
    if (Array.isArray(msg)) return rpcError(null, E_INVALID_REQUEST, "batches are not supported (removed in protocol revision 2025-06-18)");
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(hasId(msg) ? msg.id : null, E_INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    const id = hasId(msg) ? msg.id : null;
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    const isNotification = !hasId(msg);
    switch (msg.method) {
      case "initialize": {
        const asked = String(params.protocolVersion || "");
        const negotiated = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {}, resources: {} }, serverInfo: { name: SERVER_NAME, version }, instructions: `Read-only tools over the projectstore vault bound to ${project}. Every result is the CLI's --json envelope; grep-sized answers, never the vault.` });
      }
      case "notifications/initialized": initialized = true; return null;
      case "ping": return isNotification ? null : rpcResult(id, {});
      case "server/discover":
        // The 2026-07-28 era's probe. -32601 here is the documented answer a
        // legacy server gives so a dual-era client falls back to initialize.
        return rpcError(id, E_METHOD_NOT_FOUND, "server/discover is not implemented — this server speaks the initialize era");
    }
    if (msg.method.startsWith("notifications/")) return null;
    // JSON-RPC: a request without an id is a notification and is never
    // answered, whatever its method.
    if (isNotification) return null;
    if (!initialized) return rpcError(id, E_INVALID_REQUEST, "server not initialized — send initialize, then notifications/initialized");
    switch (msg.method) {
      case "tools/list": return rpcResult(id, { tools: toolList() });
      case "tools/call": {
        const r = await callTool(params.name, params.arguments);
        return r.error ? rpcError(id, r.error.code, r.error.message) : rpcResult(id, r);
      }
      case "resources/list": return rpcResult(id, { resources: resourceList() });
      case "resources/templates/list": return rpcResult(id, { resourceTemplates: RESOURCE_TEMPLATES.map((t) => ({ ...t })) });
      case "resources/read": {
        const r = await readResource(params.uri);
        return r.error ? rpcError(id, r.error.code, r.error.message) : rpcResult(id, r);
      }
      default: return rpcError(id, E_METHOD_NOT_FOUND, `method not found: ${msg.method}`);
    }
  }

  return { handle, callTool, readResource, resourceList, get initialized() { return initialized; } };
}

// The loop: newline-delimited JSON frames on stdin, one response per line on
// stdout, nothing else ever on stdout. Resolves with the exit code when
// stdin closes or a signal arrives; never calls process.exit (the bin sets
// process.exitCode and lets the streams drain).
export function serve({ project, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signals = process } = {}) {
  const refusal = startRefusal(project);
  if (refusal) { stderr.write(refusal + "\n"); return Promise.resolve(2); }
  const server = createServer({ project, env });
  const send = (obj) => { if (obj) stdout.write(JSON.stringify(obj) + "\n"); };
  return new Promise((done) => {
    let pending = 0, closing = false;
    const finish = () => { if (closing && pending === 0) done(0); };
    const rl = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { send(rpcError(null, E_PARSE, "parse error")); return; }
      pending++;
      try { send(await server.handle(msg)); }
      catch (e) { send(rpcError(hasId(msg) ? msg.id : null, E_INTERNAL, e && e.message ? e.message : String(e))); }
      finally { pending--; finish(); }
    });
    const close = () => { if (closing) return; closing = true; rl.close(); finish(); };
    rl.on("close", close);
    stdin.on("end", close);
    for (const sig of ["SIGINT", "SIGTERM"]) { try { signals.once(sig, close); } catch {} }
  });
}

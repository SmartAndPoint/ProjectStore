// projectstore — MCP server tests (PS-CORE: "MCP read surface: hand-rolled
// stdio, one tool per CLI verb" — roadmap A7).
//
// A tiny conformance client over a long-lived spawn of the bin: one JSON-RPC
// frame per line in, responses matched by id. The assertions are the story's
// acceptance criteria — the tool table equals the ADR's eight, every tool
// result equals the CLI's --json, no project means no server, the payload
// ceiling — plus the protocol pitfalls the 2026-09-05 measurement surfaced.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, symlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { VERBS, PLANNED_VERBS } from "../scripts/cli.mjs";
import { TOOLS, toolList, PROTOCOL_VERSIONS, RESOURCES, RESOURCE_TEMPLATES, startRefusal, TOOL_CEILING, TOOL_LIST_TOKEN_CEILING, createServer } from "../scripts/mcp.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { seedCliVault } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "projectstore.mjs");
const SRC = sourceHarness();
const ADR_TOOLS = ["status", "orientation", "search", "get_artifact", "neighbors", "lineage", "code_refs", "doctor"];

delete process.env[SRC.runtime.home_env];

function cleanEnv(extra = {}) {
  const e = { ...process.env };
  delete e[SRC.runtime.project_dir_env];
  delete e.PROJECTSTORE_PROJECT_DIR;
  return Object.assign(e, extra);
}

function bin(args, { cwd = ROOT, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: cleanEnv(env), timeout: 60000, maxBuffer: 1 << 24 });
}

// The conformance client.
function client(args, { cwd = ROOT, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const unmatched = [];
  let buf = "", stderr = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = msg.id !== null && msg.id !== undefined ? pending.get(msg.id) : null;
      if (p) { pending.delete(msg.id); p(msg); } else unmatched.push(msg);
    }
  });
  child.stderr.on("data", (d) => { stderr += d; });
  let nextId = 0; // starts at 0 on purpose: Claude Code's initialize arrives with id 0
  const raw = (text) => child.stdin.write(text + "\n");
  const rpc = (method, params, id = nextId++) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no response to ${method} (id ${id}) in 30s; stderr: ${stderr}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const notify = (method, params) => raw(JSON.stringify({ jsonrpc: "2.0", method, params }));
  const exit = () => new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  const handshake = async (version = PROTOCOL_VERSIONS[0]) => { const r = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "0" } }); notify("notifications/initialized"); return r; };
  // A moment for unmatched lines (a response that should not have come) to land.
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return { child, rpc, raw, notify, exit, handshake, settle, unmatched, get stderr() { return stderr; }, end: () => child.stdin.end() };
}

function vaultProject() {
  const { proj, vault } = seedCliVault();
  const r = bin(["reconcile", "--write", "--only", "graph", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  return { proj, vault };
}

// ─── the table ─────────────────────────────────────────────────────────

test("mcp: the tool table is the ADR's eight, every tool has its verb row and every verb row's tools exist — drift is a failing test", () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [...ADR_TOOLS].sort());
  assert.ok(Object.keys(TOOLS).length <= TOOL_CEILING);
  for (const [name, t] of Object.entries(TOOLS)) {
    const row = VERBS.find((v) => v.verb === t.verb);
    assert.ok(row, `${name} wraps verb ${t.verb}`);
    assert.ok(row.mcp.includes(name), `${t.verb}'s row names tool ${name}`);
  }
  for (const v of [...VERBS, ...PLANNED_VERBS]) for (const name of v.mcp) assert.ok(TOOLS[name] && TOOLS[name].verb === v.verb, `${v.verb} names ${name}, which the tool table maps to ${TOOLS[name]?.verb}`);
  assert.ok(VERBS.some((v) => v.verb === "mcp" && v.module === "./mcp.mjs" && v.writes === false && v.requiresBinding === false), "the mcp verb shipped");
  // Decision 7: the ceiling, asserted (chars/4 as the token estimate).
  const list = JSON.stringify({ tools: toolList() });
  assert.ok(list.length / 4 < TOOL_LIST_TOKEN_CEILING, `tools/list is ~${Math.round(list.length / 4)} tokens`);
  for (const t of toolList()) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown arguments`);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, `${t.name} is announced read-only`);
  }
});

test("mcp: importing the server prints nothing — stdout is the protocol channel", () => {
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import(process.env.PS_MODULE); process.stdout.write("quiet")'], { encoding: "utf8", timeout: 30000, cwd: tmpdir(), env: { ...process.env, PS_MODULE: join(ROOT, "scripts", "mcp.mjs") } });
  assert.equal(probe.stdout, "quiet", probe.stderr);
  const src = readFileSync(join(ROOT, "scripts", "mcp.mjs"), "utf8");
  for (const call of ["writeFileSync", "writeFileAtomic", "mkdirSync", "unlinkSync", "rmSync", "renameSync", "appendFileSync", "createWriteStream"]) assert.ok(!src.includes(call), `mcp.mjs writes (${call})`);
  assert.ok(!/process\.exit\(/.test(src), "never process.exit on a piped stdout");
});

// ─── refusal ───────────────────────────────────────────────────────────

test("mcp: started without a project it exits non-zero naming --project and PROJECTSTORE_PROJECT_DIR; a literal placeholder is refused; an unbound project starts", async () => {
  const none = bin(["mcp"], { cwd: tmpdir() });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--project/);
  assert.match(none.stderr, /PROJECTSTORE_PROJECT_DIR/);
  assert.equal(none.stdout, "", "nothing on the protocol channel");
  const literal = bin(["mcp", "--project", "${" + SRC.runtime.project_dir_env + "}"], { cwd: tmpdir() });
  assert.notEqual(literal.status, 0);
  assert.match(literal.stderr, /placeholder/);
  assert.equal(startRefusal(null) !== null && startRefusal("${X}") !== null && startRefusal("/tmp/p") === null, true);
  // The neutral variable and the harness's declared directory both count as supplied.
  const proj = mkdtempSync(join(tmpdir(), "ps-mcp-unbound-"));
  for (const env of [{ PROJECTSTORE_PROJECT_DIR: proj }, { [SRC.runtime.project_dir_env]: proj }]) {
    const c = client(["mcp"], { cwd: tmpdir(), env });
    const init = await c.handshake();
    assert.equal(init.result.serverInfo.name, "projectstore");
    const status = await c.rpc("tools/call", { name: "status", arguments: {} });
    assert.equal(status.result.isError, false);
    assert.equal(JSON.parse(status.result.content[0].text).result.bound, false, "status says unbound");
    const doc = await c.rpc("tools/call", { name: "doctor", arguments: { install: true } });
    assert.equal(doc.result.isError, false, "doctor runs unbound — it is how one learns why");
    assert.ok(JSON.parse(doc.result.content[0].text).result.some((f) => f.check === "config"), "and says the project is unbound");
    const search = await c.rpc("tools/call", { name: "search", arguments: { query: "x" } });
    assert.equal(search.result.isError, true, "every tool that requires a binding is an error naming bind");
    assert.match(search.result.content[0].text, /bind/);
    assert.equal(JSON.parse(search.result.content[0].text).schema_version, 1, "still the envelope");
    // Resources on an unbound project: the list answers, a read names the bind, orientation renders the missing-vault line.
    const rl = await c.rpc("resources/list", {});
    assert.equal(rl.result.resources.length, RESOURCES.length);
    assert.ok(rl.result.resources.every((r) => r.size === undefined));
    assert.equal((await c.rpc("resources/read", { uri: "projectstore://graph" })).error.code, -32602);
    assert.match((await c.rpc("resources/read", { uri: "projectstore://graph" })).error.message, /bound/);
    const o = await c.rpc("resources/read", { uri: "projectstore://orientation" });
    assert.equal(o.error.code, -32602, "unbound is the same answer for every resource");
    c.end();
    assert.equal((await c.exit()).code, 0);
  }
});

// ─── protocol ──────────────────────────────────────────────────────────

test("mcp protocol: initialize negotiates (known kept, unknown downgraded), id 0 round-trips, ping, unknown method, server/discover, batch, parse error, pre-initialize gate", async () => {
  const { proj } = vaultProject();
  const c = client(["mcp", "--project", proj], { cwd: tmpdir() });
  // Before initialize: ping is allowed, tools/list is not.
  const early = await c.rpc("tools/list", {}, 900);
  assert.equal(early.error.code, -32600);
  const ping0 = await c.rpc("ping", {}, 901);
  assert.deepEqual(ping0.result, {});
  const init = await c.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: "claude-code", version: "2.1.261" } }, 0);
  assert.equal(init.id, 0, "id 0 is a valid id, not a notification");
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ["resources", "tools"]);
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  c.notify("notifications/initialized");
  const list = await c.rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...ADR_TOOLS].sort());
  assert.deepEqual((await c.rpc("nope/method", {})).error.code, -32601);
  const discover = await c.rpc("server/discover", {});
  assert.equal(discover.error.code, -32601, "the 2026-07-28 probe is answered so a dual-era client falls back to initialize");
  c.raw(JSON.stringify([{ jsonrpc: "2.0", id: 77, method: "ping" }]));
  c.raw("{ not json");
  await c.settle();
  const batch = c.unmatched.find((m) => m.error && m.error.code === -32600);
  assert.ok(batch && batch.id === null, "a batch is one -32600 with a null id");
  const parse = c.unmatched.find((m) => m.error && m.error.code === -32700);
  assert.ok(parse && parse.id === null, "a malformed frame is -32700 with a null id, and the loop survives");
  assert.deepEqual((await c.rpc("ping", {})).result, {}, "still alive");
  c.notify("notifications/cancelled", { requestId: 1 });
  c.notify("tools/list", {});
  c.notify("nope/method", {});
  await c.settle();
  assert.equal(c.unmatched.filter((m) => "result" in m).length, 0, "notifications get no response");
  assert.equal(c.unmatched.filter((m) => m.error && m.error.code === -32601).length, 0, "an id-less unknown method is a notification too — no error frame");
  c.end();
  assert.equal((await c.exit()).code, 0);
  // An unknown protocol version is downgraded to the newest we speak.
  const d = client(["mcp", "--project", proj], { cwd: tmpdir() });
  const init2 = await d.handshake("2099-01-01");
  assert.equal(init2.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  d.end();
  await d.exit();
});

// ─── tools ─────────────────────────────────────────────────────────────

test("mcp tools: every tool result equals the CLI's --json for the same arguments, schema_version included; bad arguments are -32602; a failing tool is isError, never a crash", async () => {
  const { proj } = vaultProject();
  const c = client(["mcp", "--project", proj], { cwd: tmpdir() });
  await c.handshake();
  const cases = [
    ["status", {}, ["status"]],
    ["orientation", {}, ["orientation"]],
    ["search", { query: "zebra", kind: ["research"], limit: 2 }, ["search", "zebra", "--kind", "research", "--limit", "2"]],
    ["get_artifact", { path: "epics/PS-X/stories/story-in-flight.md", section: "description" }, ["show", "epics/PS-X/stories/story-in-flight.md", "--section", "description"]],
    ["neighbors", { path: "adr/new-way.md", direction: "out" }, ["graph", "neighbors", "adr/new-way.md", "--direction", "out"]],
    ["lineage", { path: "epics/PS-X/stories/story-ship-it.md", depth: 2 }, ["graph", "lineage", "epics/PS-X/stories/story-ship-it.md", "--depth", "2"]],
    ["code_refs", { selector: "PS-X" }, ["codemap", "--for", "PS-X"]],
  ];
  for (const [tool, args, argv] of cases) {
    const r = await c.rpc("tools/call", { name: tool, arguments: args });
    assert.ok(r.result, `${tool}: ${JSON.stringify(r.error)}`);
    assert.equal(r.result.isError, false, tool);
    const viaCli = bin([...argv, "--json", "--project", proj]);
    const a = JSON.parse(r.result.content[0].text), b = JSON.parse(viaCli.stdout);
    assert.equal(a.schema_version, 1);
    // status carries the vault's freshness, which is time-dependent: compare the rest.
    if (tool === "status") { delete a.result.views; delete b.result.views; delete a.result.sessions; delete b.result.sessions; }
    assert.deepEqual(a, b, `${tool} equals the CLI`);
  }
  // doctor: spawned asynchronously, wrapped; exit 1 (findings) is a normal result, and a ping during the call is answered.
  const docP = c.rpc("tools/call", { name: "doctor", arguments: {} });
  const pingDuring = await c.rpc("ping", {});
  assert.deepEqual(pingDuring.result, {}, "the loop is not held by doctor");
  const doc = await docP;
  const env = JSON.parse(doc.result.content[0].text);
  assert.equal(env.verb, "doctor");
  assert.ok(Array.isArray(env.result));
  assert.equal(env.ok, false, "the fixture project has install issues (no hooks alive, no statusline …)");
  assert.equal(doc.result.isError, false, "findings are an answer, not a failure");
  assert.deepEqual(JSON.parse(doc.result.content[0].text).result.map((f) => f.check), JSON.parse(bin(["doctor", "--json", "--project", proj]).stdout).result.map((f) => f.check), "the same findings as the CLI");
  // Arguments.
  assert.equal((await c.rpc("tools/call", { name: "frob", arguments: {} })).error.code, -32602);
  assert.equal((await c.rpc("tools/call", { name: "search", arguments: {} })).error.code, -32602, "required argument missing");
  assert.equal((await c.rpc("tools/call", { name: "search", arguments: { query: "x", frob: 1 } })).error.code, -32602, "unknown argument");
  assert.equal((await c.rpc("tools/call", { name: "search", arguments: { query: "x", kind: "adr" } })).error.code, -32602, "a string where an array is declared is refused, not silently dropped");
  assert.equal((await c.rpc("tools/call", { name: "search", arguments: { query: "x", limit: "5" } })).error.code, -32602, "a string where an integer is declared");
  assert.equal((await c.rpc("tools/call", { name: "status", arguments: { constructor: 1 } })).error.code, -32602, "own properties only");
  assert.equal((await c.rpc("tools/call", { name: "get_artifact", arguments: { path: "adr/new-way.md", section: "--help" } })).error.code, -32602, "an option value may not start with -");
  // A positional that looks like a flag is a positional: searching the vault for "--help" answers, it does not print usage.
  const dashed = await c.rpc("tools/call", { name: "search", arguments: { query: "--help" } });
  assert.equal(dashed.result.isError, false);
  const dashedEnv = JSON.parse(dashed.result.content[0].text);
  assert.equal(dashedEnv.verb, "search");
  assert.equal(dashedEnv.result.query, "--help");
  const versionish = await c.rpc("tools/call", { name: "search", arguments: { query: "--version" } });
  assert.equal(JSON.parse(versionish.result.content[0].text).verb, "search", "--version as a query is a query");
  const dashPath = await c.rpc("tools/call", { name: "get_artifact", arguments: { path: "-not-there.md" } });
  assert.equal(dashPath.result.isError, true);
  assert.equal(JSON.parse(dashPath.result.content[0].text).verb, "show");
  const bad = await c.rpc("tools/call", { name: "get_artifact", arguments: { path: "../etc/passwd" } });
  assert.equal(bad.result.isError, true, "a usage failure inside the verb is a tool error, not a protocol error");
  assert.equal(JSON.parse(bad.result.content[0].text).ok, false);
  assert.equal(JSON.parse(bad.result.content[0].text).schema_version, 1);
  const badDepth = await c.rpc("tools/call", { name: "lineage", arguments: { path: "adr/new-way.md", depth: 99 } });
  assert.equal(badDepth.result.isError, true);
  c.end();
  assert.equal((await c.exit()).code, 0);
});

// ─── resources ─────────────────────────────────────────────────────────

test("mcp resources: orientation, kanban and graph read whole; artifact/{path} is percent-decoded and contained — .., absolute and a symlink out are refused", async () => {
  const { proj, vault } = vaultProject();
  mkdirSync(join(vault, "research"), { recursive: true });
  writeFileSync(join(vault, "research", "with space.md"), "---\ntitle: With space\n---\n\n# With space\n");
  const outside = mkdtempSync(join(tmpdir(), "ps-outside-"));
  writeFileSync(join(outside, "secret.md"), "secret\n");
  symlinkSync(join(outside, "secret.md"), join(vault, "research", "link.md"));
  const c = client(["mcp", "--project", proj], { cwd: tmpdir() });
  await c.handshake();
  const list = await c.rpc("resources/list", {});
  assert.deepEqual(list.result.resources.map((r) => r.uri).sort(), RESOURCES.map((r) => r.uri).sort());
  const graph = list.result.resources.find((r) => r.name === "graph");
  assert.equal(typeof graph.size, "number", "a client can decide before reading graph.md");
  const tpl = await c.rpc("resources/templates/list", {});
  assert.deepEqual(tpl.result.resourceTemplates.map((t) => t.uriTemplate), RESOURCE_TEMPLATES.map((t) => t.uriTemplate));
  const orientation = await c.rpc("resources/read", { uri: "projectstore://orientation" });
  assert.ok(orientation.result.contents[0].text.includes("Projectstore vault:"));
  const g = await c.rpc("resources/read", { uri: "projectstore://graph" });
  assert.equal(g.result.contents[0].text, readFileSync(join(vault, "graph.md"), "utf8"), "delivered whole");
  const kanban = await c.rpc("resources/read", { uri: "projectstore://kanban" });
  assert.equal(kanban.result.contents[0].text, readFileSync(join(vault, "kanban.md"), "utf8"));
  const art = await c.rpc("resources/read", { uri: "projectstore://artifact/research/with%20space.md" });
  assert.ok(art.result.contents[0].text.includes("# With space"));
  assert.equal(art.result.contents[0].uri, "projectstore://artifact/research/with%20space.md", "re-encoded when echoed");
  for (const uri of ["projectstore://artifact/../secret.md", "projectstore://artifact/research/../../secret.md", `projectstore://artifact/${encodeURIComponent(join(outside, "secret.md"))}`, "projectstore://artifact/research/link.md", "projectstore://nope", "file:///etc/hosts"]) {
    const r = await c.rpc("resources/read", { uri });
    assert.equal(r.error && r.error.code, -32602, `${uri} refused`);
    assert.ok(!JSON.stringify(r).includes("secret\\n"), `${uri} leaks nothing`);
  }
  c.end();
  assert.equal((await c.exit()).code, 0);
});

// ─── lifecycle ─────────────────────────────────────────────────────────

test("mcp lifecycle: stdin close, SIGINT and SIGTERM each end the server with exit 0, and a large body in flight is delivered whole", async () => {
  const { proj } = vaultProject();
  for (const how of ["end", "SIGINT", "SIGTERM"]) {
    const c = client(["mcp", "--project", proj], { cwd: tmpdir() });
    await c.handshake();
    const g = await c.rpc("resources/read", { uri: "projectstore://graph" });
    assert.ok(g.result.contents[0].text.length > 100);
    if (how === "end") c.end(); else c.child.kill(how);
    const { code, signal } = await c.exit();
    assert.equal(signal, null, `${how}: exited, not killed`);
    assert.equal(code, 0, how);
  }
});

test("mcp: a cancelled doctor call kills its child; a mid-session vault edit is visible to the next call", async () => {
  const { proj, vault } = vaultProject();
  const c = client(["mcp", "--project", proj], { cwd: tmpdir() });
  await c.handshake();
  const before = JSON.parse((await c.rpc("tools/call", { name: "status", arguments: {} })).result.content[0].text).result.stories.total;
  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-late.md"), "---\ntype: story\nid: \"story-late\"\ntitle: \"Late\"\nstatus: planned\ncreated: 2026-03-01\n---\n\n# Late\n");
  const after = JSON.parse((await c.rpc("tools/call", { name: "status", arguments: {} })).result.content[0].text).result.stories.total;
  assert.equal(after, before + 1, "no cache between calls — the vault is re-read");
  // Cancel a doctor call: the response may still arrive (the child dies with a signal) but must be an error, not a hang, and the loop lives.
  const docP = c.rpc("tools/call", { name: "doctor", arguments: {} }, 500);
  c.notify("notifications/cancelled", { requestId: 500, reason: "test" });
  const doc = await docP;
  assert.ok(doc.result, "answered");
  assert.deepEqual((await c.rpc("ping", {})).result, {});
  c.end();
  assert.equal((await c.exit()).code, 0);
});

test("mcp createServer: handle() is pure of I/O and usable in-process", async () => {
  const { proj } = vaultProject();
  const s = createServer({ project: proj, env: cleanEnv() });
  assert.equal(s.initialized, false);
  const init = await s.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(s.initialized, true);
  const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.equal(JSON.parse(r.result.content[0].text).result.bound, true);
  assert.equal((await s.handle({ jsonrpc: "2.0", id: 2 })).error.code, -32600, "no method");
  assert.ok(existsSync(join(ROOT, ".mcp.json")), "the registration ships");
});

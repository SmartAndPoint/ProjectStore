// projectstore — CLI tests (PS-CORE: "Token-free CLI: the projectstore bin
// over the core operations", slice 1 — roadmap A4).
//
// The bin is a thin shell over the same core operations the command files
// call, so the assertions are about parity and shape: the envelope, the exit
// codes, the verb table as the contract the MCP surface will mirror, and the
// gate reaching the bin unchanged. Spawned as a child process, like every
// other CLI test here; one case goes through a real `npm pack` tarball.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { VERBS, PLANNED_VERBS, SCHEMA_VERSION, envelope, resolveProject } from "../scripts/cli.mjs";
import { sourceHarness } from "../scripts/harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "projectstore.mjs");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.project_config_dir;
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

delete process.env[SRC.runtime.home_env];

function bin(args, { cwd = ROOT, env = {} } = {}) {
  const e = { ...process.env };
  delete e[SRC.runtime.project_dir_env];
  delete e.PROJECTSTORE_PROJECT_DIR;
  Object.assign(e, env);
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: e, timeout: 60000, maxBuffer: 1 << 24 });
}

function project({ bound = true } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "ps-cli-"));
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  if (bound) {
    const vault = mkdtempSync(join(tmpdir(), "ps-vault-"));
    writeFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), JSON.stringify({ vault_path: vault, layout: "engineering" }));
  }
  return proj;
}

test("cli: the verb table is the contract — every shipped verb wraps a module that exists, and the union covers the MCP ADR's eight tools", () => {
  for (const v of VERBS) {
    if (v.module) assert.ok(existsSync(join(ROOT, "scripts", v.module.replace(/^\.\//, ""))), `${v.verb} wraps ${v.module}`);
    else assert.equal(v.wraps, "new", `${v.verb} without a module is new code`);
    assert.ok(typeof v.run === "function" && typeof v.summary === "string" && v.summary.length > 0);
    assert.ok(["script", "module", "new"].includes(v.wraps) && ["spawn", "import"].includes(v.how));
  }
  // MCP ADR decision 2's table: eight tools, each with a CLI verb.
  const tools = new Set([...VERBS, ...PLANNED_VERBS].flatMap((v) => v.mcp));
  for (const v of [...VERBS, ...PLANNED_VERBS]) assert.ok(Array.isArray(v.mcp), `${v.verb}.mcp is a list`);
  // Both directions: every tool the table names is one the ADR names.
  const ADR_TOOLS = ["status", "orientation", "search", "get_artifact", "neighbors", "lineage", "code_refs", "doctor"];
  for (const t of tools) assert.ok(ADR_TOOLS.includes(t), `tool ${t} is not in the MCP ADR's table`);
  for (const v of PLANNED_VERBS.filter((v) => ["init", "bind", "status", "search"].includes(v.verb))) assert.equal(v.wraps, "new", `${v.verb} is marked new`);
  for (const t of ["status", "orientation", "search", "get_artifact", "neighbors", "lineage", "code_refs", "doctor"]) assert.ok(tools.has(t), `tool ${t} has a verb`);
  const names = [...VERBS, ...PLANNED_VERBS].map((v) => v.verb);
  assert.equal(new Set(names).size, names.length, "no verb twice");
  assert.deepEqual(Object.keys(envelope("x", "/p", true, null)), ["schema_version", "verb", "project", "ok", "result"]);
  assert.equal(SCHEMA_VERSION, 1);
});

test("cli: --version equals package.json, help lists every verb, an unknown verb is usage, a planned verb says where it lands", () => {
  assert.equal(bin(["--version"]).stdout.trim(), PKG.version);
  const vj = JSON.parse(bin(["--version", "--json"]).stdout);
  assert.deepEqual(vj, { schema_version: 1, verb: "version", project: null, ok: true, result: { version: PKG.version } });
  const help = bin(["--help"]);
  assert.equal(help.status, 0, "bare --help is not an error");
  assert.equal(bin(["-h"]).status, 0);
  for (const v of VERBS) assert.ok(help.stdout.includes(` ${v.verb} `) || help.stdout.includes(`${v.verb.padEnd(11)}`), `help names ${v.verb}`);
  assert.ok(help.stdout.includes("there is no --yes"));
  const none = bin([]);
  assert.equal(none.status, 2);
  const bad = bin(["frobnicate"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown verb: frobnicate/);
  const planned = bin(["status"]);
  assert.equal(planned.status, 2);
  assert.match(planned.stderr, /lands with roadmap C1/);
  const badOpt = bin(["doctor", "--frob"]);
  assert.equal(badOpt.status, 2);
});

test("cli: doctor through the bin equals the bare script's findings, inside the envelope; exit 1 on issues", () => {
  const proj = project({ bound: false });
  const viaBin = bin(["doctor", "--json", "--project", proj]);
  const bare = spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs"), "--json"], { encoding: "utf8", cwd: proj, env: { ...process.env, [SRC.runtime.project_dir_env]: proj }, timeout: 60000 });
  const env = JSON.parse(viaBin.stdout);
  assert.equal(env.schema_version, 1);
  assert.equal(env.verb, "doctor");
  assert.equal(env.project, proj);
  assert.deepEqual(env.result, JSON.parse(bare.stdout));
  assert.equal(env.ok, !env.result.some((f) => f.level === "issue"));
  assert.equal(viaBin.status, env.ok ? 0 : 1);
  assert.ok(env.result.some((f) => f.level === "issue"), "an unbound project is an issue, so this exercises exit 1");
  const text = bin(["doctor", "--project", proj]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /projectstore doctor/);
});

test("cli: --project wins over cwd, and PROJECTSTORE_PROJECT_DIR wins over cwd", () => {
  const a = project({ bound: false }), b = project({ bound: false });
  const viaFlag = JSON.parse(bin(["doctor", "--json", "--project", a], { cwd: b }).stdout);
  assert.equal(viaFlag.project, a);
  const viaEnv = JSON.parse(bin(["doctor", "--json"], { cwd: b, env: { PROJECTSTORE_PROJECT_DIR: a } }).stdout);
  assert.equal(viaEnv.project, a);
  const viaCwd = JSON.parse(bin(["doctor", "--json"], { cwd: b }).stdout);
  assert.equal(viaCwd.project, realpathSync(b), "cwd as the child sees it — realpath on macOS");
  assert.equal(resolveProject({ project: "x", cwd: "/tmp" }), "/tmp/x");
});

test("cli: reconcile in an unbound project exits 3 naming init; in a bound one it reports, and --json wraps", () => {
  const unbound = project({ bound: false });
  const r = bin(["reconcile", "--project", unbound]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not bound/);
  assert.match(r.stderr, /projectstore init/);
  const bound = project();
  const j = bin(["reconcile", "--json", "--project", bound]);
  assert.equal(j.status, 0, j.stderr);
  const env = JSON.parse(j.stdout);
  assert.equal(env.verb, "reconcile");
  assert.equal(env.project, bound);
  assert.ok(env.result && env.result.summary, "the core's report is the result");
  const bare = bin(["reconcile", "--project", bound]);
  assert.ok(!("schema_version" in JSON.parse(bare.stdout)), "without --json the core's own JSON is printed");
  // The gate: a bare --write in a non-TTY refuses; --only names what is written.
  const vault = JSON.parse(readFileSync(join(bound, CFG_DIR, SRC.runtime.config_basename), "utf8")).vault_path;
  const refused = bin(["reconcile", "--write", "--json", "--project", bound]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /non-TTY refuses/);
  assert.deepEqual(JSON.parse(refused.stdout).result, { refused: "non-tty" });
  assert.ok(!existsSync(join(vault, "kanban.md")), "nothing written");
  const named = bin(["reconcile", "--write", "--only", "kanban", "--json", "--project", bound]);
  assert.equal(named.status, 0, named.stderr);
  assert.ok(existsSync(join(vault, "kanban.md")), "--only named the write and it happened");
  assert.equal(bin(["reconcile", "--only"]).status, 2, "--only without a value is usage");
  const sections = JSON.parse(bin(["doctor", "--json", "--install", "--project", bound]).stdout);
  assert.ok(sections.result.every((f) => f.group === "install"), "--install narrows to the install section");
});

test("cli: the gate reaches the bin unchanged — a bare non-TTY install refuses, a named one applies, and there is no --yes", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const proj = project();
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const env = { HOME: home, [SRC.runtime.plugin_root_env]: ROOT };
  const bare = bin(["install", "--project", proj], { env });
  assert.equal(bare.status, 1, bare.stderr);
  assert.match(bare.stdout, /non-TTY refuses/);
  assert.ok(bare.stdout.includes("CLAUDE.md"), "the preview precedes the refusal");
  assert.equal(readFileSync(join(proj, "CLAUDE.md"), "utf8"), "# Mine\n");
  const nowhere = bin(["doctor", "--json", "--project", "/nonexistent/project"]);
  assert.equal(nowhere.status, 1, "an unbound, nonexistent project is findings, not a crash");
  assert.ok("schema_version" in JSON.parse(nowhere.stdout));
  const yes = bin(["install", "--project", proj, "--harness", SRC.id, "--yes"], { env });
  assert.equal(yes.status, 2, "there is no --yes");
  const named = bin(["install", "--project", proj, "--harness", SRC.id, "--json"], { env });
  assert.equal(named.status, 0, named.stderr + named.stdout);
  const out = JSON.parse(named.stdout);
  assert.equal(out.verb, "install");
  assert.equal(out.result.gate.why, "named");
  assert.ok(out.result.items.every((i) => !("before" in i) && !("after" in i)), "no file bodies in the envelope");
  assert.ok(readFileSync(join(proj, "CLAUDE.md"), "utf8").includes("projectstore:agents"));
  const planned = JSON.parse(bin(["plan", "--project", proj, "--json"], { env }).stdout);
  assert.equal(planned.verb, "plan");
  assert.ok(planned.result.items.every((i) => i.action === "skip"));
  const again = JSON.parse(bin(["upgrade", "--project", proj, "--harness", SRC.id, "--json"], { env }).stdout);
  assert.equal(again.result.gate.why, "nothing-to-do");
  const un = JSON.parse(bin(["uninstall", "--project", proj, "--harness", SRC.id, "--json"], { env }).stdout);
  assert.equal(un.ok, true);
  assert.ok(!existsSync(join(proj, "CLAUDE.md")) || !readFileSync(join(proj, "CLAUDE.md"), "utf8").includes("projectstore:agents"));
});

test("cli: the command files still call the scripts directly — a git-marketplace install has no bin on PATH", () => {
  for (const [f, needle] of [["doctor.md", 'node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs'], ["reconcile.md", 'node "$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mjs']]) {
    assert.ok(readFileSync(join(ROOT, "commands", f), "utf8").includes(needle), `commands/${f} still invokes the script`);
  }
  assert.ok(readdirSync(join(ROOT, "bin")).every((f) => f.endsWith(".mjs")));
  assert.ok(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n"));
  assert.equal(PKG.bin.projectstore, "bin/projectstore.mjs");
});

test("cli: the packed tarball's bin runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-pack-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(pack.status, 0, pack.stderr);
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  assert.ok(tgz, "a tarball was written");
  const untar = spawnSync("tar", ["-xzf", join(dir, tgz), "-C", dir], { encoding: "utf8", timeout: 60000 });
  assert.equal(untar.status, 0, untar.stderr);
  const packed = join(dir, "package", "bin", "projectstore.mjs");
  const r = spawnSync(process.execPath, [packed, "--version"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG.version);
  // AC 1: from the packed tree, doctor equals the script's findings, inside the envelope.
  const proj = project();
  const e = { ...process.env }; delete e[SRC.runtime.project_dir_env]; delete e.PROJECTSTORE_PROJECT_DIR;
  const viaPack = spawnSync(process.execPath, [packed, "doctor", "--json", "--project", proj], { encoding: "utf8", env: e, timeout: 60000, maxBuffer: 1 << 24 });
  const bare = spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs"), "--json"], { encoding: "utf8", cwd: proj, env: { ...e, [SRC.runtime.project_dir_env]: proj, [SRC.runtime.plugin_root_env]: join(dir, "package") }, timeout: 60000, maxBuffer: 1 << 24 });
  const envd = JSON.parse(viaPack.stdout);
  assert.equal(envd.schema_version, 1);
  assert.deepEqual(envd.result, JSON.parse(bare.stdout), "the packed bin's doctor equals the script's");
});

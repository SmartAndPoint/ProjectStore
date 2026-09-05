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
import { seedCliVault } from "./fixtures/vault.mjs";
import { neighbors as neighborsOp, LINEAGE_KINDS } from "../scripts/query.mjs";

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
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
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
  for (const v of VERBS.filter((v) => ["init", "bind", "status", "search"].includes(v.verb))) assert.equal(v.wraps, "new", `${v.verb} is marked new`);
  for (const t of ["status", "orientation", "search", "get_artifact", "neighbors", "lineage", "code_refs", "doctor"]) assert.ok(tools.has(t), `tool ${t} has a verb`);
  const names = [...VERBS, ...PLANNED_VERBS].map((v) => v.verb);
  assert.equal(new Set(names).size, names.length, "no verb twice");
  assert.deepEqual(Object.keys(envelope("x", "/p", true, null)), ["schema_version", "verb", "project", "ok", "result"]);
  assert.equal(SCHEMA_VERSION, 1);
});

test("cli: --version equals package.json, help lists every verb, an unknown verb is usage, nothing is planned and every failure answers in the envelope under --json", () => {
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
  assert.deepEqual(PLANNED_VERBS, [], "every verb the story names has landed");
  // The envelope on every exit under --json: usage, unknown verb, stray option, not bound.
  for (const [args, code] of [[["frobnicate", "--json"], 2], [["doctor", "--frob", "--json"], 2], [["doctor", "--json", "--frob"], 2]]) {
    const r = bin(args);
    assert.equal(r.status, code, args.join(" "));
    const e = JSON.parse(r.stdout);
    assert.equal(e.schema_version, 1);
    assert.equal(e.ok, false);
    assert.ok(e.result.error, "the error is in the envelope");
  }
  const unbound = bin(["search", "x", "--json", "--project", project({ bound: false })]);
  assert.equal(unbound.status, 3);
  assert.equal(JSON.parse(unbound.stdout).result.exit, 3);
  assert.ok(!help.stdout.includes("planned:"), "help lists no planned line once nothing is planned");
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
  assert.match(r.stderr, /projectstore (bind|init) <vault>/);
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
  // PATH is emptied and the session marker dropped so the developer's real host CLI never enters this plan.
  const env = { HOME: home, [SRC.runtime.plugin_root_env]: ROOT, PATH: "", ...Object.fromEntries((SRC.runtime.detect_env || []).map((k) => [k, undefined])) };
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
  // No host CLI on this PATH: the registration surface is unavailable, the rest is applied, and the exit says the plan was incomplete (contract 4′).
  const named = bin(["install", "--project", proj, "--harness", SRC.id, "--json"], { env });
  assert.equal(named.status, 1, named.stderr + named.stdout);
  const out = JSON.parse(named.stdout);
  assert.equal(out.verb, "install");
  assert.equal(out.result.gate.why, "named");
  assert.equal(out.result.incomplete, true);
  assert.equal(out.result.items.find((i) => i.surface === "plugin").state, "unavailable");
  assert.equal(out.result.applied.length, 1, "the block is applied even though the registration could not be");
  const narrowed = bin(["install", "--project", proj, "--harness", SRC.id, "--surface", "agents_block", "--json"], { env });
  assert.equal(narrowed.status, 0, "a plan that never asked for the registration is complete");
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

// Roadmap A8: the prompt surface (commands, agents, skills) invokes ONE path,
// the bin, with a verb the table knows — except the scripts that have no verb,
// each named with the reason it stays a script. The list is {script, why} so
// it cannot quietly become a dumping ground (generation spec contract 8's
// shape). A git-marketplace install has no bin on PATH, hence the explicit
// node "$CLAUDE_PLUGIN_ROOT/bin/projectstore.mjs" form, never npx.
const SCRIPT_ONLY = [
  { script: "draft.mjs", why: "a pure renderer whose consumer is the creation prose, which reads path/content/index/collision at the top level — an envelope would be eight command files of field renames for no gain" },
  { script: "story-section.mjs", why: "PS-SPEC's lifecycle-gate machinery (story-007); wrapping it is a design decision, not a re-pointing" },
  { script: "diff-refs.mjs", why: "PS-SPEC's story 'code-refs from diff' owns turning it into a verb" },
  { script: "worktree.mjs", why: "PS-WT's inherit probe; its consumer copies the parent config verbatim, which bind deliberately does not do" },
];

test("cli: every invocation in the prompt surface is the bin with a known verb, or a named script-only exception (roadmap A8)", () => {
  const files = [
    ...readdirSync(join(ROOT, "commands")).filter((f) => f.endsWith(".md")).map((f) => join("commands", f)),
    ...readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).map((f) => join("agents", f)),
    ...readdirSync(join(ROOT, "skills")).map((d) => join("skills", d, "SKILL.md")).filter((p) => existsSync(join(ROOT, p))),
  ];
  const verbs = new Set(VERBS.map((v) => v.verb));
  const exceptions = new Set(SCRIPT_ONLY.map((s) => s.script));
  let binCalls = 0;
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/node "\$CLAUDE_PLUGIN_ROOT\/([^"]+)"(?:\s+([A-Za-z-]+))?/g)) {
      const [, path, first] = m;
      if (path === "bin/projectstore.mjs") {
        binCalls++;
        const row = VERBS.find((v) => v.verb === first);
        assert.ok(row, `${rel}: bin verb "${first}" is not in the verb table`);
        // The parser is strict: every flag the prose passes must be one the row (or the CLI) declares.
        const rest = src.slice(m.index + m[0].length).split(/[`\n]/)[0];
        const declared = new Set([...row.options.map((o) => o.name), "project", "json"]);
        for (const flag of rest.matchAll(/--([a-z][a-z-]*)/g)) assert.ok(declared.has(flag[1]), `${rel}: ${first} does not take --${flag[1]}`);
        continue;
      }
      const base = path.split("/").pop();
      assert.ok(path.startsWith("scripts/") && exceptions.has(base), `${rel} invokes ${path} — either the bin or a named exception`);
    }
    for (const gone of ["scripts/reconcile.mjs", "scripts/doctor.mjs", "scripts/install-harness.mjs"]) assert.ok(!src.includes(gone), `${rel} still names ${gone}`);
  }
  assert.ok(binCalls >= 20, `the prompt surface invokes the bin (${binCalls} calls)`);
  // Every exception is still invoked somewhere (the list stays minimal), and no prose reaches the bin by another spelling.
  const all = files.map((rel) => readFileSync(join(ROOT, rel), "utf8")).join("\n");
  for (const s of SCRIPT_ONLY) assert.ok(all.includes(`scripts/${s.script}"`), `exception ${s.script} is still invoked — drop it from SCRIPT_ONLY otherwise`);
  assert.ok(!/npx projectstore/.test(all), "a git-marketplace install has no bin on PATH — never npx in the prompt surface");
  assert.ok(!/node \$CLAUDE_PLUGIN_ROOT\//.test(all), "the plugin root is always quoted (paths with spaces)");
  assert.ok(!/\$\{CLAUDE_PLUGIN_ROOT\}/.test(all), "one spelling of the root in prose");
  for (const s of SCRIPT_ONLY) { assert.ok(existsSync(join(ROOT, "scripts", s.script)), `exception ${s.script} exists`); assert.ok(s.why.length > 20); }
  assert.ok(existsSync(BIN), "the path every command names exists");
  assert.ok(readdirSync(join(ROOT, "bin")).every((f) => f.endsWith(".mjs")));
  assert.ok(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n"));
  assert.equal(PKG.bin.projectstore, "bin/projectstore.mjs");
});

// The npm-registration story: the same bin under bun answers byte-identically
// for --version and status --json, and doctor --json carries the same check ids.
const BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
test("cli: bun runs the bin with the same --json as node", { skip: !BUN && "bun is not on PATH" }, () => {
  const proj = project();
  const e = { ...process.env }; delete e[SRC.runtime.project_dir_env]; delete e.PROJECTSTORE_PROJECT_DIR;
  const run = (exe, args) => spawnSync(exe, [BIN, ...args], { encoding: "utf8", env: e, timeout: 60000, maxBuffer: 1 << 24 });
  assert.equal(run("bun", ["--version"]).stdout, run(process.execPath, ["--version"]).stdout);
  const status = ["status", "--json", "--project", proj];
  assert.equal(run("bun", status).stdout, run(process.execPath, status).stdout, "status --json is byte-identical");
  const doctor = ["doctor", "--json", "--project", proj];
  const ids = (r) => JSON.parse(r.stdout).result.map((f) => f.check).sort();
  assert.deepEqual(ids(run("bun", doctor)), ids(run(process.execPath, doctor)), "doctor --json carries the same check ids");
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

// ─── Slice A6a: the read verbs ──────────────────────────────────────────


function cliVault() {
  const { proj, vault } = seedCliVault();
  // The derived views, so status can report freshness and search can exclude them.
  const r = bin(["reconcile", "--write", "--only", "graph", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  return { proj, vault };
}
const envOf = (r) => { const e = JSON.parse(r.stdout); assert.equal(e.schema_version, 1); return e; };

test("cli read verbs: the table names them, each wraps query.mjs, and importing the generators prints nothing", () => {
  for (const v of ["status", "orientation", "search", "show", "graph", "codemap"]) {
    const row = VERBS.find((x) => x.verb === v);
    assert.ok(row, `${v} shipped`);
    assert.equal(row.module, "./query.mjs");
    assert.ok(!PLANNED_VERBS.some((x) => x.verb === v), `${v} left the planned list`);
  }
  for (const v of ["status", "search"]) assert.equal(VERBS.find((x) => x.verb === v).wraps, "new");
  // kanban.mjs and codemap.mjs used to run main() at import time.
  // The modules travel in env, not argv: the main guard compares argv[1].
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'for (const m of process.env.PS_MODULES.split(":")) await import(m); process.stdout.write("quiet")'], { encoding: "utf8", timeout: 30000, cwd: tmpdir(), env: { ...process.env, PS_MODULES: [join(ROOT, "scripts", "kanban.mjs"), join(ROOT, "scripts", "codemap.mjs")].join(":") } });
  assert.equal(probe.stdout, "quiet", probe.stderr);
});

test("cli status: unbound is bound:false at exit 0; bound reports the board from frontmatter and the views' freshness", () => {
  const unbound = project({ bound: false });
  const u = bin(["status", "--json", "--project", unbound]);
  assert.equal(u.status, 0);
  assert.deepEqual(envOf(u).result.bound, false);
  const { proj } = cliVault();
  const s = envOf(bin(["status", "--json", "--project", proj])).result;
  assert.equal(s.bound, true);
  assert.equal(s.layout, "engineering");
  assert.equal(s.stories.total, 4, "on the board");
  assert.deepEqual(s.stories.by_status, { "in-progress": 1, planned: 3 });
  assert.deepEqual(s.stories.off_board, { not_actionable: 1 }, "the parked story is counted, not dropped");
  assert.equal(s.stories.off_board_total, 1);
  assert.deepEqual(s.stories.in_progress.map((x) => x.path), ["epics/PS-X/stories/story-in-flight.md"]);
  assert.equal(s.stories.in_progress[0].started_at, "2026-02-02");
  assert.equal(s.views.graph.exists, true);
  assert.equal(s.views.graph.stale, false);
  assert.equal(s.views.code_map.exists, false);
  assert.deepEqual(Object.keys(s).sort(), ["approval_mode", "auto_inject", "bound", "language", "layout", "lifecycle_gates", "project", "sessions", "spec_policy", "stories", "vault_exists", "vault_path", "views"]);
  assert.equal(s.auto_inject, true);
  assert.equal(s.approval_mode, "always");
  const text = bin(["status", "--project", proj]);
  assert.match(text.stdout, /In progress \(1\)/);
});

test("cli orientation: the skeleton equals the SessionStart renderer's, and README bodies never enter the envelope", async () => {
  const { proj } = cliVault();
  const o = envOf(bin(["orientation", "--json", "--project", proj])).result;
  assert.ok(o.skeleton.includes("Projectstore vault:"), o.skeleton.slice(0, 200));
  assert.ok(o.facts.folders.every((f) => !("readme" in f) && "purpose" in f), "purpose, not readme");
  const adr = o.facts.folders.find((f) => f.path === "adr");
  assert.equal(adr.purpose, "Decisions that stick.");
  const text = bin(["orientation", "--project", proj]).stdout;
  assert.equal(text.trimEnd(), o.skeleton.trimEnd());
  const { gatherVaultFacts, renderVaultSkeleton } = await import("../scripts/lib.mjs");
  const cfg = JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8"));
  assert.equal(o.skeleton, renderVaultSkeleton(await gatherVaultFacts(cfg)));
});

test("cli search: deterministic, bounded, case-insensitive by default, derived views excluded, empty is exit 0", () => {
  const { proj } = cliVault();
  const r = envOf(bin(["search", "zebra", "--json", "--project", proj])).result;
  assert.equal(r.status, "ok");
  assert.ok(r.matches.every((m) => !["kanban.md", "graph.md"].includes(m.path)), "derived views excluded");
  const note = r.matches.filter((m) => m.path === "research/zebra-note.md");
  assert.equal(note.length, 3, "per-file cap");
  assert.equal(note[0].type, "research");
  assert.equal(note[0].title, "Zebra note");
  assert.ok(note.every((m) => m.of === 6), "the cap is reported: 6 hits in the file (title + 5 body lines)");
  assert.equal(r.files_truncated, 1);
  assert.equal(r.per_file_cap, 3);
  assert.ok(note.some((m) => m.snippet.includes("zebra crossing, again")), "body lines come back, not only frontmatter");
  assert.ok(!r.matches.some((m) => m.snippet.startsWith("slug:") || m.snippet.startsWith("id:")), "frontmatter other than title: is not searched");
  assert.ok(note.some((m) => m.snippet.startsWith("title:")), "the title line is");
  assert.ok(r.matches.some((m) => m.path === "epics/PS-X/stories/story-in-flight.md" && m.status === "in-progress"));
  const order = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);
  assert.deepEqual(r.matches.map((m) => m.path + ":" + m.line), [...r.matches].sort(order).map((m) => m.path + ":" + m.line), "sorted by path then line");
  const cs = envOf(bin(["search", "Zebra Crossing", "--case-sensitive", "--json", "--project", proj])).result;
  assert.equal(cs.total, 1);
  const kind = envOf(bin(["search", "zebra", "--kind", "story", "--json", "--project", proj])).result;
  assert.ok(kind.matches.every((m) => m.type === "story"));
  const lim = envOf(bin(["search", "zebra", "--limit", "1", "--json", "--project", proj])).result;
  assert.equal(lim.returned, 1);
  assert.equal(lim.truncated, true);
  const none = bin(["search", "no-such-phrase-anywhere", "--json", "--project", proj]);
  assert.equal(none.status, 0, "empty is not an error");
  assert.deepEqual(envOf(none).result.matches, []);
  assert.equal(bin(["search", "--json", "--project", proj]).status, 2, "a query is required");
  assert.match(bin(["search", "zebra", "--project", proj]).stdout, /research\/ \(3\)/);
});

test("cli show: frontmatter by default, body and a registry section on request, paths vault-relative or absolute inside the vault", () => {
  const { proj, vault } = cliVault();
  const s = envOf(bin(["show", "epics/PS-X/stories/story-in-flight.md", "--json", "--project", proj])).result;
  assert.equal(s.type, "story");
  assert.equal(s.status, "in-progress");
  assert.ok(!("body" in s));
  assert.deepEqual(Object.keys(s).sort(), ["bytes", "frontmatter", "lines", "path", "status", "title", "type"]);
  const sec = envOf(bin(["show", join(vault, "epics/PS-X/stories/story-in-flight.md"), "--section", "description", "--json", "--project", proj])).result;
  assert.equal(sec.path, "epics/PS-X/stories/story-in-flight.md", "absolute inside the vault is normalised");
  assert.equal(sec.section.text, "The zebra crossing phrase lives here.");
  const body = envOf(bin(["show", "adr/new-way.md", "--body", "--json", "--project", proj])).result;
  assert.ok(body.body.includes("[[kanban]]"));
  assert.equal(bin(["show", "../outside.md", "--project", proj]).status, 2);
  assert.equal(bin(["show", "/etc/hosts", "--project", proj]).status, 2);
  assert.equal(bin(["show", "adr/nope.md", "--project", proj]).status, 2);
  // An absolute path that starts inside the vault and climbs out of it.
  writeFileSync(join(vault, "..", "secret.md"), "---\ntitle: secret\n---\n");
  const climb = bin(["show", join(vault, "adr", "..", "..", "secret.md"), "--json", "--project", proj]);
  assert.equal(climb.status, 2, "resolved before the containment test");
  assert.equal(envOf(climb).result.frontmatter, undefined, "nothing outside the vault is read");
  assert.match(envOf(climb).result.error, /outside the vault/);
  assert.equal(bin(["show", "adr/new-way.md", "--section", "nope", "--project", proj]).status, 2, "unknown section is usage");
  assert.match(bin(["show", "adr/new-way.md", "--section", "nope", "--project", proj]).stderr, /one of: .*description/);
  // In-process reads resolve the registry from this package, not from the host session's plugin root.
  const foreign = bin(["show", "epics/PS-X/stories/story-in-flight.md", "--section", "description", "--json", "--project", proj], { env: { [SRC.runtime.plugin_root_env]: mkdtempSync(join(tmpdir(), "ps-bogus-root-")) } });
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(envOf(foreign).result.section.text, "The zebra crossing phrase lives here.");
});

test("cli graph neighbors: the same edges graph.md holds, by path, typed, both directions", () => {
  const { proj, vault } = cliVault();
  const n = envOf(bin(["graph", "neighbors", "adr/new-way.md", "--json", "--project", proj])).result;
  assert.equal(n.type, "adr");
  assert.ok(n.out.some((e) => e.kind === "supersedes" && e.to === "adr/old-way.md" && e.to_title === "Old way"));
  assert.ok(n.out.some((e) => e.kind === "dead" && e.to === "missing-target"));
  assert.ok(n.in.some((e) => e.kind === "spec-implements-adr" && e.from === "specs/covering.md"));
  assert.ok(n.in.some((e) => e.kind === "wikilink" && e.from === "epics/PS-X/stories/story-ship-it.md"));
  // Parity with the view: every row grep finds for the path is an edge here.
  const rows = readFileSync(join(vault, "graph.md"), "utf8").split("\n").filter((l) => l.startsWith("| ") && l.includes(" adr/new-way.md ") && l.split("|").length === 5);
  const asEdges = rows.map((l) => l.split("|").map((c) => c.trim()).filter(Boolean)).filter((c) => c.length === 3 && (c[0] === "adr/new-way.md" || c[2] === "adr/new-way.md"));
  for (const [from, kind, to] of asEdges) {
    assert.ok(from === "adr/new-way.md" ? n.out.some((e) => e.kind === kind && e.to === to) : n.in.some((e) => e.kind === kind && e.from === from), `${from} ${kind} ${to}`);
  }
  const onlyOut = envOf(bin(["graph", "neighbors", "adr/new-way.md", "--direction", "out", "--kind", "supersedes", "--json", "--project", proj])).result;
  assert.deepEqual(onlyOut.in, []);
  assert.deepEqual(onlyOut.out.map((e) => e.kind), ["supersedes"]);
  assert.equal(bin(["graph", "frob", "x", "--project", proj]).status, 2);
  assert.equal(bin(["graph", "neighbors", "kanban.md", "--project", proj]).status, 2, "not a node");
  assert.equal(bin(["graph", "neighbors", "adr/new-way.md", "--body", "--project", proj]).status, 2, "an option the verb does not take");
  assert.equal(bin(["graph", "neighbors", "adr/new-way.md", "--direction", "sideways", "--project", proj]).status, 2, "a value the option does not take");
  assert.equal(bin(["graph", "neighbors", "adr/new-way.md", "--depth", "2", "--project", proj]).status, 2, "an option of the other mode");
  assert.equal(bin(["graph", "neighbors", "adr/new-way.md", "--limit", "0", "--project", proj]).status, 2);
});

test("cli graph lineage: typed edges only, both directions, depth- and cycle-safe", () => {
  const { proj } = cliVault();
  const l = envOf(bin(["graph", "lineage", "epics/PS-X/stories/story-ship-it.md", "--json", "--project", proj])).result;
  assert.deepEqual(l.kinds, [...LINEAGE_KINDS]);
  const paths = l.nodes.map((n) => n.path);
  assert.ok(paths.includes("specs/covering.md"), "spec-covers pulls the covering spec in");
  assert.ok(paths.includes("adr/new-way.md"), "spec-implements-adr reaches the ADR at depth 2");
  assert.ok(paths.includes("adr/old-way.md"), "supersedes reaches the old ADR at depth 3");
  assert.equal(l.nodes.find((n) => n.path === "adr/old-way.md").distance, 3);
  assert.ok(!paths.includes("specs/dup.md"), "body wikilinks are not lineage");
  assert.ok(paths.includes("epics/PS-X/epic.md"), "the epic is lineage");
  assert.ok(!paths.includes("epics/PS-X/stories/story-nested/README.md"), "siblings through the epic are not");
  const fromEpic = envOf(bin(["graph", "lineage", "epics/PS-X/epic.md", "--depth", "1", "--json", "--project", proj])).result;
  assert.ok(fromEpic.nodes.some((n) => n.path === "epics/PS-X/stories/story-nested/README.md"), "from the epic itself, its stories are");
  const shallow = envOf(bin(["graph", "lineage", "epics/PS-X/stories/story-ship-it.md", "--depth", "1", "--json", "--project", proj])).result;
  assert.ok(!shallow.nodes.some((n) => n.path === "adr/new-way.md"));
  assert.equal(l.nodes[0].distance, 0);
  const nodeSet = new Set(l.nodes.map((n) => n.path));
  assert.ok(l.edges.every((e) => nodeSet.has(e.from) && nodeSet.has(e.to)), "every edge joins two nodes of the result");
  assert.equal(bin(["graph", "lineage", "adr/new-way.md", "--depth", "abc", "--project", proj]).status, 2, "depth is validated, not coerced");
  assert.equal(bin(["graph", "lineage", "adr/new-way.md", "--kind", "wikilink", "--project", proj]).status, 2, "wikilinks are not lineage");
  assert.equal(bin(["graph", "lineage", "adr/new-way.md", "--limit", "5", "--project", proj]).status, 2, "an option of the other mode");
});

test("cli codemap --for: an epic lists its refs and its stories'; a path lists who covers it; the reading is named", () => {
  const { proj } = cliVault();
  const epic = envOf(bin(["codemap", "--for", "PS-X", "--json", "--project", proj])).result;
  assert.equal(epic.resolved_as, "epic");
  assert.deepEqual(epic.artifacts[0], { path: "epics/PS-X/epic.md", type: "epic", title: "X", status: "in-progress", code_refs: ["scripts/"] });
  assert.ok(epic.artifacts.some((a) => a.path === "epics/PS-X/stories/story-in-flight.md" && a.code_refs.includes("scripts/cli.mjs")));
  const path = envOf(bin(["codemap", "--for", "scripts/cli.mjs", "--json", "--project", proj])).result;
  assert.equal(path.resolved_as, "path");
  assert.deepEqual(path.artifacts.map((a) => [a.path, a.matched]), [["epics/PS-X/epic.md", ["scripts/"]], ["epics/PS-X/stories/story-in-flight.md", ["scripts/cli.mjs"]]]);
  const art = envOf(bin(["codemap", "--for", "story-in-flight", "--json", "--project", proj])).result;
  assert.equal(art.resolved_as, "artifact");
  assert.equal(art.truncated, false);
  const dup = bin(["codemap", "--for", "dup", "--json", "--project", proj]);
  assert.equal(dup.status, 2, "a tie is ambiguity, never a first match");
  assert.match(dup.stderr, /adr\/dup\.md.*specs\/dup\.md/);
  const stem = bin(["codemap", "--for", "epic", "--json", "--project", proj]);
  assert.equal(stem.status, 2, "the stem every epic.md shares is ambiguous, never an arbitrary epic");
  assert.match(stem.stderr, /epics\/PS-X\/epic\.md.*epics\/PS-Y\/epic\.md/);
  assert.equal(bin(["codemap", "--project", proj]).status, 2, "--for is required");
  assert.match(bin(["codemap", "--for", "bin/", "--project", proj]).stdout, /epics\/PS-Y\/epic\.md/);
});

test("cli read verbs: unbound is exit 3 for every read but status; the results are small", () => {
  const unbound = project({ bound: false });
  for (const args of [["orientation"], ["search", "x"], ["show", "a.md"], ["graph", "neighbors", "a.md"], ["codemap", "--for", "x"]]) {
    assert.equal(bin([...args, "--project", unbound]).status, 3, args.join(" "));
  }
  const { proj } = cliVault();
  for (const args of [["status"], ["orientation"], ["search", "zebra"], ["show", "adr/new-way.md"], ["graph", "neighbors", "adr/new-way.md"], ["graph", "lineage", "adr/new-way.md"], ["codemap", "--for", "PS-X"]]) {
    const r = bin([...args, "--json", "--project", proj]);
    assert.equal(r.status, 0, args.join(" ") + r.stderr);
    assert.ok(r.stdout.length < 20000, `${args.join(" ")} stays small (${r.stdout.length} bytes)`);
  }
  void neighborsOp;
});

// ─── Slice A6b: bind and init ────────────────────────────────────────────

test("cli bind: naming the vault is the confirmation — a headless bind writes the config; the same vault twice is a no-op; another vault needs --rebind and keeps every other key", () => {
  const proj = project({ bound: false });
  const vault = mkdtempSync(join(tmpdir(), "ps-vault-"));
  const r = bin(["bind", vault, "--json", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  const e = envOf(r);
  assert.equal(e.result.state, "unbound");
  assert.equal(e.result.wrote, true);
  assert.equal(e.result.config, undefined, "no file body in the envelope");
  assert.deepEqual(Object.keys(e.result).sort(), ["config_path", "created_vault", "ignored", "kept_keys", "language", "layout", "refusals", "state", "vault_exists", "vault_path", "wrote"]);
  const cfg = JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8"));
  // The fresh config's keys are commands/bind.md step 3's — the interview and the verb write the same file.
  const bindMd = readFileSync(join(ROOT, "commands", "bind.md"), "utf8");
  for (const k of Object.keys(cfg)) assert.ok(bindMd.includes(`"${k}":`), `commands/bind.md step 3 names ${k}`);
  assert.equal(cfg.vault_path, vault);
  assert.equal(cfg.layout, "engineering");
  assert.equal(cfg.language, "en");
  assert.deepEqual(Object.keys(cfg).sort(), ["active_skills", "approval_mode", "auto_inject", "default_author", "language", "layout", "tags", "vault_path"]);
  // Same vault again: nothing written, exit 0.
  const again = bin(["bind", vault + "/", "--json", "--project", proj]);
  assert.equal(again.status, 0);
  assert.equal(envOf(again).result.state, "same");
  assert.equal(envOf(again).result.wrote, false);
  // A flag on a same-vault bind is reported as ignored, and the result says what is on disk.
  const flagged = envOf(bin(["bind", vault, "--language", "ru", "--json", "--project", proj])).result;
  assert.equal(flagged.state, "same");
  assert.equal(flagged.language, "en", "what is on disk, not what was asked");
  assert.deepEqual(flagged.ignored, ["language"]);
  assert.match(bin(["bind", vault, "--language", "ru", "--project", proj]).stdout, /--language ignored/);
  // Nothing on the project side but the config is touched.
  writeFileSync(join(proj, "CLAUDE.md"), "# mine\n");
  // A hand-added key survives a rebind; the vault changes only with --rebind.
  writeFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), JSON.stringify({ ...cfg, statusline: { enabled: true } }));
  const other = mkdtempSync(join(tmpdir(), "ps-vault-"));
  const refused = bin(["bind", other, "--json", "--project", proj]);
  assert.equal(refused.status, 1);
  assert.match(envOf(refused).result.refusals[0].message, /--rebind/);
  assert.equal(JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8")).vault_path, vault, "not rewritten");
  const rebound = bin(["bind", other, "--rebind", "--language", "ru", "--json", "--project", proj]);
  assert.equal(rebound.status, 0, rebound.stderr);
  const after = JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8"));
  assert.equal(after.vault_path, other);
  assert.equal(after.language, "ru");
  assert.deepEqual(after.statusline, { enabled: true }, "other keys kept");
  assert.deepEqual(envOf(rebound).result.kept_keys, ["active_skills", "approval_mode", "auto_inject", "default_author", "statusline", "tags"]);
  assert.equal(readFileSync(join(proj, "CLAUDE.md"), "utf8"), "# mine\n", "bind never touches the agents block");
  assert.ok(!existsSync(join(proj, ".gitignore")), "nor .gitignore");
  // A corrupt config is refused, never overwritten.
  writeFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "{ not json");
  const corrupt = bin(["bind", other, "--rebind", "--json", "--project", proj]);
  assert.equal(corrupt.status, 1);
  assert.equal(envOf(corrupt).result.refusals[0].code, "UNREADABLE");
  assert.equal(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8"), "{ not json");
  // The stored side is normalised too: a config written with a tilde is the same vault.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  mkdirSync(join(home, "v"));
  const p3 = project({ bound: false });
  writeFileSync(join(p3, CFG_DIR, SRC.runtime.config_basename), JSON.stringify({ vault_path: "~/v", layout: "engineering" }));
  const tilde = envOf(bin(["bind", join(home, "v"), "--json", "--project", p3], { env: { HOME: home } })).result;
  assert.equal(tilde.state, "same");
  const tildeIn = envOf(bin(["bind", "~/v", "--json", "--project", project({ bound: false })], { env: { HOME: home } })).result;
  assert.equal(tildeIn.vault_path, join(home, "v"), "a tilde expands");
  assert.equal(bin(["bind", "~someone/v", "--project", project({ bound: false })]).status, 2, "~user is not expanded");
  assert.equal(bin(["bind", "/", "--project", project({ bound: false })]).status, 2, "the root is not a vault");
  assert.equal(bin(["bind", vault, "--project", join(tmpdir(), "ps-none-" + Date.now())]).status, 1, "a project directory that does not exist is not created");
  // Usage: no vault, unknown layout, unknown language, a missing vault.
  assert.equal(bin(["bind", "--project", project({ bound: false })]).status, 2);
  assert.equal(bin(["bind", vault, "--layout", "nope", "--project", project({ bound: false })]).status, 2);
  assert.equal(bin(["bind", vault, "--language", "xx", "--project", project({ bound: false })]).status, 2);
  const missing = bin(["bind", join(tmpdir(), "ps-none-" + Date.now()), "--json", "--project", project({ bound: false })]);
  assert.equal(missing.status, 1);
  assert.match(envOf(missing).result.refusals[0].message, /projectstore init/);
});

test("cli init: creates the vault directory and binds; refuses when already bound; points at scaffold, never scaffolds", () => {
  const proj = project({ bound: false });
  const vault = join(mkdtempSync(join(tmpdir(), "ps-init-")), "vault");
  const r = bin(["init", vault, "--layout", "engineering", "--json", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(r).result.created_vault, true);
  assert.ok(existsSync(vault));
  assert.deepEqual(readdirSync(vault), [], "init makes the directory only — the layout is scaffold's");
  assert.equal(JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8")).vault_path, vault);
  const text = bin(["init", join(mkdtempSync(join(tmpdir(), "ps-init-")), "v2"), "--project", project({ bound: false })]);
  assert.match(text.stdout, /scaffold/);
  const twice = bin(["init", vault, "--json", "--project", proj]);
  assert.equal(twice.status, 1);
  assert.match(envOf(twice).result.refusals[0].message, /already bound/);
  // init into a project bound elsewhere: refused without --rebind, and the message names a flag init takes.
  const elsewhere = join(mkdtempSync(join(tmpdir(), "ps-init-")), "v3");
  const moved = bin(["init", elsewhere, "--json", "--project", proj]);
  assert.equal(moved.status, 1);
  assert.equal(envOf(moved).result.refusals[0].code, "REBIND");
  assert.ok(!existsSync(elsewhere), "nothing created on a refusal");
  const movedOk = bin(["init", elsewhere, "--rebind", "--json", "--project", proj]);
  assert.equal(movedOk.status, 0, movedOk.stderr);
  assert.ok(existsSync(elsewhere));
  assert.equal(JSON.parse(readFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), "utf8")).vault_path, elsewhere);
  assert.equal(bin(["init", "--project", project({ bound: false })]).status, 2);
  // A relative path resolves against the project.
  const p2 = project({ bound: false });
  const rel = bin(["bind", "./my-vault", "--json", "--project", p2]);
  assert.equal(rel.status, 1, "relative to the project, and missing");
  assert.equal(envOf(rel).result.vault_path, join(p2, "my-vault"));
});

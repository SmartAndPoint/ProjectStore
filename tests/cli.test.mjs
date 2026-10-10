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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { VERBS, PLANNED_VERBS, SCHEMA_VERSION, envelope, resolveProject, run, opt } from "../scripts/cli.mjs";
import { loadHarness, sourceHarness, harnessIds } from "../scripts/harness.mjs";
import { layoutPaths } from "../scripts/lib.mjs";
import { seedCliVault, writeBinding } from "./fixtures/vault.mjs";
import { fakeNpm, fakeCodexBin } from "./fixtures/fetch.mjs";
import { neighbors as neighborsOp, LINEAGE_KINDS } from "../scripts/query.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "projectstore.mjs");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

delete process.env[SRC.runtime.home_env];

function bin(args, { cwd = ROOT, env = {} } = {}) {
  const e = { ...process.env };
  delete e[SRC.runtime.project_dir_env];
  delete e.PROJECTSTORE_PROJECT_DIR;
  // The test runner forces colour into its children when it reports to a
  // terminal; text assertions read the plain layout unless a test asks.
  delete e.FORCE_COLOR;
  delete e.PROJECTSTORE_SHELL;
  Object.assign(e, env);
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: e, timeout: 60000, maxBuffer: 1 << 24 });
}

function project({ bound = true } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "ps-cli-"));
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  if (bound) {
    const vault = mkdtempSync(join(tmpdir(), "ps-vault-"));
    writeBinding(proj, JSON.stringify({ vault_path: vault, layout: "engineering" }));
  }
  return proj;
}

function projectForHarness(harness) {
  const proj = mkdtempSync(join(tmpdir(), "ps-cli-harness-"));
  mkdirSync(join(proj, harness.runtime.harness_dir), { recursive: true });
  const vault = mkdtempSync(join(tmpdir(), "ps-vault-"));
  writeBinding(proj, JSON.stringify({ vault_path: vault, layout: "engineering" }));
  return proj;
}

function semanticInstallItems(items, projectDir, home = null) {
  return items.map((item) => ({
    harness: item.harness,
    surface: item.surface,
    kind: item.kind,
    path: item.path === null ? null : (home ? item.path.replace(home, "<home>") : item.path).replace(projectDir, "<project>"),
    entry: item.entry ?? null,
    state: item.state,
    action: item.action,
    reason: item.reason ?? null,
  }));
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

test("cli: <verb> --help prints the verb's options and examples, a shell's name replaces the core's, and a near miss is named", () => {
  for (const v of VERBS) {
    const h = bin([v.verb, "--help"]);
    assert.equal(h.status, 0, v.verb);
    assert.ok(h.stdout.startsWith(`npx projectstore ${v.verb} — `), h.stdout.split("\n")[0]);
    for (const o of v.options) assert.ok(h.stdout.includes(`--${o.name}`), `${v.verb} --help names --${o.name}`);
  }
  const install = bin(["install", "--help"]).stdout;
  assert.match(install, /\nExamples\n {2}npx projectstore install --harness <id>\n/);
  // A bare uninstall is the core's, for every harness the project uses (the
  // story "One run plans the agents block once…", rule 5); a shell names its
  // own harness, so its help has no such line.
  const uninstall = bin(["uninstall", "--help"]).stdout;
  assert.match(uninstall, /\nExamples\n {2}npx projectstore uninstall +# every harness this project uses\n {2}npx projectstore uninstall --harness <id>\n/, uninstall);
  const shellUninstall = bin(["uninstall", "--help"], { env: { PROJECTSTORE_SHELL: "projectstore-codex" } }).stdout;
  assert.ok(!shellUninstall.includes("every harness this project uses"), shellUninstall);
  assert.match(shellUninstall, /\nExamples\n {2}npx projectstore-codex uninstall\n/);
  // The ids come from the manifests, never from the help's own text (a Codex user reads it too).
  assert.ok(install.includes(`\nHarnesses   ${harnessIds().join(", ")}\n`), install);
  const core = bin(["--help"]).stdout;
  assert.match(core, /Unattended in a terminal .*--json.*CI=1.*<\/dev\/null/);
  // Through a shell, agents --help offers no --harness either: the shell inserts it.
  const agents = bin(["agents", "--help"], { env: { PROJECTSTORE_SHELL: "projectstore-codex" } }).stdout;
  assert.ok(!agents.includes("--harness"), agents);
  assert.match(agents, /npx projectstore-codex agents show/, "the read examples use the shell's name too");
  // Through a shell the harness is fixed: the examples drop it, and so does the option list.
  const shell = bin(["upgrade", "--help"], { env: { PROJECTSTORE_SHELL: "projectstore-codex" } }).stdout;
  assert.ok(shell.startsWith("npx projectstore-codex upgrade — "), shell);
  assert.ok(!shell.includes("--harness"), "a shell's harness is not an option");
  assert.match(shell, /npx projectstore-codex@<version> upgrade +# the version you name is the version that runs/);
  const top = bin(["--help"], { env: { PROJECTSTORE_SHELL: "projectstore-claude" } }).stdout;
  assert.match(top, /Usage\n {2}npx projectstore-claude <verb> \[options\]/);
  for (const g of ["Set up", "Read", "Check and repair", "Serve", "Every verb", "Tips"]) assert.ok(top.includes(`\n${g}\n`), g);
  // Near misses: a verb, an option of the verb, an option before any verb.
  const verb = bin(["instal"]);
  assert.equal(verb.status, 2);
  assert.match(verb.stderr, /^unknown verb: instal — did you mean install\?/);
  const opt = bin(["install", "--verbos"]);
  assert.equal(opt.status, 2);
  assert.match(opt.stderr, /^install does not take --verbos — did you mean --verbose\?/);
  const stray = bin(["status", "--surfac", "x"]);
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /status does not take --surfac/);
  assert.ok(!bin(["frobnicate"]).stderr.includes("did you mean"), "nothing near is suggested when nothing is near");
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
  const vault = JSON.parse(readFileSync(layoutPaths(bound).binding, "utf8")).vault_path;
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
  assert.match(bare.stdout, /Nothing written: without a terminal, a bare install refuses/);
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

test("cli: Codex plan/install preserve pathless rows and semantics in text and JSON", () => {
  const codex = loadHarness("codex");
  assert.ok(codex, "the Codex identity manifest is present");

  // The detected names are dropped FIRST: the home variable is one of them,
  // and dropping it after setting it sent the child to the developer's real
  // Codex home (found 2026-10-10, when the shell fetch began reading it).
  const codexEnv = () => ({
    ...Object.fromEntries((codex.runtime.detect_env || []).map((key) => [key, undefined])),
    [codex.runtime.home_env]: mkdtempSync(join(tmpdir(), "ps-codex-home-")),
    PATH: "",
  });
  const run = (verb, json) => {
    const proj = projectForHarness(codex);
    const env = codexEnv();
    const args = [verb, "--project", proj, "--harness", codex.id];
    if (json) args.push("--json");
    const result = bin(args, { env });
    return { proj, home: env[codex.runtime.home_env], result, output: json ? JSON.parse(result.stdout) : null };
  };

  const planText = run("plan", false);
  const planJson = run("plan", true);
  const installText = run("install", false);
  const installJson = run("install", true);

  // No `codex` on PATH and nothing of ours: the registration is unavailable
  // from the host's own facts — decided version-only, with nothing fetched —
  // so plan and install are incomplete, exit 1, and still agree (until
  // 0.29.2 the core deferred the row without reading them, and exited 0).
  for (const sample of [planText, planJson, installText, installJson]) {
    assert.equal(sample.result.status, 1, sample.result.stderr || sample.result.stdout);
  }
  for (const sample of [planJson, installJson]) {
    const row = sample.output.result.items.find((i) => i.surface === "plugin");
    assert.equal(row.state, "unavailable");
    assert.equal(row.action, "skip");
    assert.match(row.reason, /^`codex` is not on PATH/);
    assert.equal(sample.output.result.incomplete, true);
  }
  assert.deepEqual(installJson.output.result.fetched, [], "nothing was fetched");
  assert.ok(!existsSync(join(planText.proj, "AGENTS.md")), "text plan writes nothing");
  assert.ok(!existsSync(join(planJson.proj, "AGENTS.md")), "JSON plan writes nothing");

  const planItems = semanticInstallItems(planJson.output.result.items, planJson.proj, planJson.home);
  const installItems = semanticInstallItems(installJson.output.result.items, installJson.proj, installJson.home);
  assert.deepEqual(installItems, planItems, "output selection and verb preserve the fresh-state plan");
  const pathless = planItems.filter((item) => item.path === null);
  assert.ok(pathless.length > 0, "the public Codex plan exercises pathless host rows");
  // The default folds them into one line naming the harness, each surface,
  // the state and the action; --verbose lists each, marked as pathless.
  const verbose = bin(["plan", "--project", planText.proj, "--harness", codex.id, "--verbose"], { env: codexEnv() });
  assert.equal(verbose.status, 1, verbose.stderr);
  for (const item of pathless) {
    for (const text of [planText.result.stdout, installText.result.stdout]) {
      const folded = text.split("\n").find((l) => l.includes(`not on ${codex.display_name}:`));
      assert.ok(folded, `text names ${codex.display_name}'s unsupported rows`);
      assert.ok(folded.includes(item.surface), `text names ${item.surface}`);
      assert.match(folded, /unsupported → skip/);
    }
    assert.ok(verbose.stdout.includes(`${item.surface} [${item.harness}, no filesystem path]`), `--verbose marks ${item.surface} as having no filesystem path`);
  }

  assert.equal(installJson.output.result.gate.why, "named");
  assert.equal(installJson.output.result.applied.length, 1);
  assert.match(installText.result.stdout, /\nAPPLY\n {2}✓ shared +AGENTS\.md \[projectstore:agents v\d+\] +\d/);
  assert.match(installText.result.stdout, /\nDONE — 1 change in \d/);
  for (const s of codex.install.next) assert.ok(installText.result.stdout.includes(`next  ${s}`), `DONE names the manifest's next step: ${s}`);
  assert.equal(
    readFileSync(join(installText.proj, "AGENTS.md"), "utf8"),
    readFileSync(join(installJson.proj, "AGENTS.md"), "utf8"),
    "text and JSON installs produce the same managed file",
  );
});

// ─── The shell fetch through the bin (the shell-fetch story) ─────────────
//
// PATH holds a fake npm (its `config get registry` is the real npm's), a fake
// codex running the measured host shapes, and node. HOME, the Codex home and
// the cache are temporary; an inherited npm_config_registry is dropped.
function fetchBins() {
  const codex = loadHarness("codex");
  const base = mkdtempSync(join(tmpdir(), "ps-cli-fetch-"));
  const npm = fakeNpm(join(base, "npm-bin"));
  const host = fakeCodexBin(join(base, "codex-bin"));
  const home = join(base, "home"), codexHome = join(base, "codex-home"), cache = join(base, "cache");
  for (const d of [home, codexHome]) mkdirSync(d, { recursive: true });
  const env = {
    ...Object.fromEntries((codex.runtime.detect_env || []).map((key) => [key, undefined])),
    HOME: home,
    [codex.runtime.home_env]: codexHome,
    XDG_CACHE_HOME: cache,
    PATH: [npm.dir, host.dir, dirname(process.execPath)].join(delimiter),
    npm_config_registry: undefined,
  };
  return { codex, base, npm, host, home, codexHome, cache, env, fetchDir: join(cache, "projectstore", "fetch") };
}

test("cli shell fetch: a project .npmrc's registry reaches the fetch's --registry, with and without npx's npm_config_registry", () => {
  for (const viaNpx of [false, true]) {
    const f = fetchBins();
    const proj = projectForHarness(f.codex);
    writeFileSync(join(proj, ".npmrc"), "registry=https://npmrc.example.test/\n");
    // npm exec hands its child the registry it resolved in the project.
    const env = viaNpx ? { ...f.env, npm_config_registry: "https://npmrc.example.test/" } : f.env;
    const r = bin(["upgrade", "--harness", f.codex.id, "--json", "--project", proj], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const reads = f.npm.log().filter((c) => c.argv[0] === "config");
    assert.equal(reads.length, 1, "the registry is read once");
    assert.equal(reads[0].cwd, realpathSync(proj), "in the project");
    const [install] = f.npm.installs();
    assert.equal(install.argv[install.argv.indexOf("--registry") + 1], "https://npmrc.example.test/", viaNpx ? "through npx" : "without npx");
    assert.deepEqual(readdirSync(f.fetchDir), []);
  }
});

test("cli shell fetch: text puts the badge first, the fetch line under it, then the project and PLAN; --json is one JSON document carrying fetched", () => {
  const f = fetchBins();
  const shell = f.codex.install.shell;
  const proj = projectForHarness(f.codex);
  const r = bin(["install", "--harness", f.codex.id, "--project", proj], { env: f.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], `projectstore · install · ${f.codex.display_name}`);
  assert.match(lines[1], new RegExp(`^ {2}✓ fetched ${shell}@${PKG.version.replace(/\./g, "\\.")} for ${f.codex.display_name} +\\d+\\.\\ds$`), lines[1]);
  assert.equal(lines[2], `  ${proj}`);
  assert.equal(lines[3], "");
  assert.match(lines[4], /^PLAN — \d+ changes?$/);
  assert.equal(r.stdout.split("projectstore · install").length, 2, "the preview does not print the badge again");
  assert.match(r.stdout, /\nDONE — /);
  assert.ok(f.host.log().some((c) => c.argv.join(" ") === "plugin add projectstore@projectstore-npx"), "registered through the host");
  const g = fetchBins();
  const j = bin(["upgrade", "--harness", g.codex.id, "--json", "--project", projectForHarness(g.codex)], { env: g.env });
  assert.equal(j.status, 0, j.stdout + j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.result.fetched.map(({ ms, ...x }) => x), [{ harness: g.codex.id, package: shell, version: PKG.version }]);
  assert.ok(!j.stdout.includes("✓ fetched"), "nothing but the envelope");
  assert.deepEqual(readdirSync(g.fetchDir), []);
});

test("cli shell fetch: a refused fetch exits 1 before the plan, in text and under --json, and leaves no fetch directory", () => {
  const f = fetchBins();
  const shell = f.codex.install.shell;
  const env = { ...f.env, FAKE_NPM_MODE: "ETARGET" };
  const j = bin(["upgrade", "--harness", f.codex.id, "--json", "--project", projectForHarness(f.codex)], { env });
  assert.equal(j.status, 1, j.stdout + j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.result.items, []);
  assert.deepEqual(doc.result.fetched, []);
  assert.ok(doc.result.refusals[0].startsWith(`${shell}@${PKG.version} is not on `), doc.result.refusals[0]);
  const t = bin(["upgrade", "--harness", f.codex.id, "--project", projectForHarness(f.codex)], { env });
  assert.equal(t.status, 1);
  assert.match(t.stdout.split("\n")[1], new RegExp(`^ {2}✗ fetch failed ${shell}@\\S+ +ETARGET {2}\\d+\\.\\ds$`));
  assert.match(t.stdout, /PLAN — refused/);
  assert.deepEqual(f.host.log(), [], "nothing spawned after npm");
  assert.deepEqual(readdirSync(f.fetchDir), []);
});

// The release's behaviour change (b): a state directory alone selects Codex
// for a bare upgrade, so without a terminal it refuses where 0.29.2 printed
// "Nothing to change." and exited 0 — and it fetches nothing.
test("cli shell fetch: a headless bare upgrade on .claude/ plus state/codex/ exits 1 at the non-TTY refusal, naming both harnesses", () => {
  const f = fetchBins();
  const proj = project({ bound: false });
  mkdirSync(layoutPaths(proj).harnessState(f.codex.id), { recursive: true });
  const r = bin(["upgrade", "--project", proj], { env: f.env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`Nothing written: without a terminal, a bare upgrade refuses. Name the harness to confirm: --harness ${SRC.id} | ${f.codex.id}\n`), r.stdout);
  assert.ok(r.stdout.startsWith(`projectstore · upgrade · ${SRC.display_name}, ${f.codex.display_name}\n`), "both are planned");
  assert.deepEqual(f.npm.log(), [], "nothing fetched for a run that cannot be asked");
});

test("cli shell fetch: plan --harness codex calls no npm and makes no cache; its row leads with the fetch it would run, and plan --json keeps its key set", () => {
  const f = fetchBins();
  const proj = projectForHarness(f.codex);
  const r = bin(["plan", "--harness", f.codex.id, "--project", proj], { env: f.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`↓ npm install --prefix ${join(f.fetchDir, "<run-id>")} --no-save`), r.stdout);
  assert.ok(r.stdout.includes("--registry <registry>"));
  const j = bin(["plan", "--harness", f.codex.id, "--json", "--project", proj], { env: f.env });
  const doc = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(doc.result).sort(), ["detected", "harnesses", "incomplete", "items", "mode", "named", "ok", "plannedAgainst", "projectDir", "refusals", "reports", "root"]);
  const row = doc.result.items.find((i) => i.surface === "plugin");
  assert.deepEqual([row.state, row.action, row.steps[0].kind], ["absent", "create", "fetch"]);
  assert.ok(!("analysed" in row), "the recheck's inputs stay private");
  assert.deepEqual(f.npm.log(), [], "plan never calls npm");
  assert.equal(existsSync(f.cache), false, "and creates nothing under the cache");
});

// Roadmap A8: the prompt surface (commands, agents, skills) invokes ONE path,
// the bin, with a verb the table knows — except the scripts that have no verb,
// each named with the reason it stays a script. The list is {script, why} so
// it cannot quietly become a dumping ground (generation spec contract 8's
// shape). A git-marketplace install has no bin on PATH, hence the explicit
// node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" form, never npx.
// (Spelling superseded 2026-09-06 — the braced placeholder is the one the host
// substitutes; see the amendment below.)
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
    for (const m of src.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"(?:\s+([A-Za-z-]+))?/g)) {
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
  assert.ok(!/node \$\{CLAUDE_PLUGIN_ROOT\}\//.test(all), "the plugin root is always quoted (paths with spaces)");
  // Measured 2026-09-06 with a probe plugin: the host substitutes the BRACED
  // placeholder inline in command, skill and agent content before the model
  // reads it, and passes the unbraced one through as text — which the shell
  // then expands to nothing. This assertion used to require the unbraced form;
  // it required the one spelling that cannot work, and every release since at
  // least 0.21 shipped it. See the story "The prompt surface asks the shell for
  // a variable the host would have substituted".
  assert.ok(!/\$CLAUDE_PLUGIN_ROOT/.test(all), "the prompt surface names the root braced — the unbraced form is not substituted and the Bash tool has no such variable");
  for (const s of SCRIPT_ONLY) { assert.ok(existsSync(join(ROOT, "scripts", s.script)), `exception ${s.script} exists`); assert.ok(s.why.length > 20); }
  // A15: the project argument is the host's placeholder, never a model-filled
  // blank — ${CLAUDE_PROJECT_DIR} is substituted in command, skill and agent
  // content (measured 2026-09-06), and the bin's resolveProject otherwise falls
  // through to the session's cwd, which a `cd` earlier in the turn has moved.
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/--project "([^"]*)"/g)) {
      assert.equal(m[1], "${CLAUDE_PROJECT_DIR}", `${rel}: --project takes the host placeholder, not ${JSON.stringify(m[1])}`);
    }
  }
  // One spelling of the plugin root across every surface that names it — the
  // prompt surface, the hooks payload and the MCP entry. They drifted apart
  // once (A8 pinned the unbraced form in prose while hooks used the braced
  // one); this is what keeps them together.
  {
    const token = SRC.hooks.root_placeholder;
    for (const rel of ["hooks/hooks.json", ".mcp.json", "docs/extending.md"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (!src.includes("CLAUDE_PLUGIN_ROOT")) continue;
      assert.ok(src.includes(token), `${rel} names the plugin root, and must use ${token}`);
      assert.ok(!/\$CLAUDE_PLUGIN_ROOT/.test(src), `${rel}: the unbraced form is not substituted anywhere`);
    }
  }
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
  const cfg = JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8"));
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
  // 0.29.2's eleven keys, kept, plus init's two steps (null on a bind).
  assert.deepEqual(Object.keys(e.result).sort(), ["config_path", "created_vault", "git", "ignored", "kept_keys", "language", "layout", "refusals", "scaffold", "state", "vault_exists", "vault_path", "wrote"]);
  assert.equal(e.result.git, null, "bind never runs git");
  assert.equal(e.result.scaffold, null, "nor the scaffold");
  const cfg = JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8"));
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
  writeBinding(proj, JSON.stringify({ ...cfg, statusline: { enabled: true } }));
  const other = mkdtempSync(join(tmpdir(), "ps-vault-"));
  const refused = bin(["bind", other, "--json", "--project", proj]);
  assert.equal(refused.status, 1);
  assert.match(envOf(refused).result.refusals[0].message, /--rebind/);
  assert.equal(JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8")).vault_path, vault, "not rewritten");
  const rebound = bin(["bind", other, "--rebind", "--language", "ru", "--json", "--project", proj]);
  assert.equal(rebound.status, 0, rebound.stderr);
  const after = JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8"));
  assert.equal(after.vault_path, other);
  assert.equal(after.language, "ru");
  assert.deepEqual(after.statusline, { enabled: true }, "other keys kept");
  assert.deepEqual(envOf(rebound).result.kept_keys, ["active_skills", "approval_mode", "auto_inject", "default_author", "statusline", "tags"]);
  assert.equal(readFileSync(join(proj, "CLAUDE.md"), "utf8"), "# mine\n", "bind never touches the agents block");
  assert.ok(!existsSync(join(proj, ".gitignore")), "nor .gitignore");
  // A corrupt config is refused, never overwritten.
  writeBinding(proj, "{ not json");
  const corrupt = bin(["bind", other, "--rebind", "--json", "--project", proj]);
  assert.equal(corrupt.status, 1);
  assert.equal(envOf(corrupt).result.refusals[0].code, "UNREADABLE");
  assert.equal(readFileSync(layoutPaths(proj).binding, "utf8"), "{ not json");
  // The stored side is normalised too: a config written with a tilde is the same vault.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  mkdirSync(join(home, "v"));
  const p3 = project({ bound: false });
  writeBinding(p3, JSON.stringify({ vault_path: "~/v", layout: "engineering" }));
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

test("cli init: refuses when already bound to a vault that is there, and rebuilds one that went missing; a project bound elsewhere needs --rebind; nothing is created on a refusal", () => {
  const proj = project({ bound: false });
  const vault = join(mkdtempSync(join(tmpdir(), "ps-init-")), "vault");
  const r = bin(["init", vault, "--layout", "engineering", "--json", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(r).result.created_vault, true);
  assert.ok(existsSync(vault));
  assert.equal(JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8")).vault_path, vault);
  const text = bin(["init", join(mkdtempSync(join(tmpdir(), "ps-init-")), "v2"), "--project", project({ bound: false })]);
  assert.match(text.stdout, /Scaffolded the engineering layout/);
  assert.match(text.stdout, /Next: `projectstore reconcile --write` \(optional\)/, "the derived views are offered, not run");
  assert.ok(!/in a session/.test(text.stdout), "a whole vault needs no session command after it");
  const twice = bin(["init", vault, "--json", "--project", proj]);
  assert.equal(twice.status, 1);
  assert.match(envOf(twice).result.refusals[0].message, /already bound/);
  // The vault directory deleted under its binding: init makes the whole vault
  // again — no BOUND refusal, and no config write (the binding is the same).
  const bindingBefore = readFileSync(layoutPaths(proj).binding, "utf8");
  rmSync(vault, { recursive: true, force: true });
  const rebuilt = bin(["init", vault, "--json", "--project", proj]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr + rebuilt.stdout);
  const rb = envOf(rebuilt).result;
  assert.equal(rb.state, "same");
  assert.equal(rb.wrote, false, "the binding is not rewritten");
  assert.equal(rb.created_vault, true);
  assert.ok(rb.git && (rb.git.done || rb.git.skipped), JSON.stringify(rb.git));
  assert.ok(rb.scaffold.created.includes("README.md"));
  assert.ok(existsSync(join(vault, "adr", "README.md")));
  assert.equal(readFileSync(layoutPaths(proj).binding, "utf8"), bindingBefore);
  // init into a project bound elsewhere: refused without --rebind, and the message names a flag init takes.
  const elsewhere = join(mkdtempSync(join(tmpdir(), "ps-init-")), "v3");
  const moved = bin(["init", elsewhere, "--json", "--project", proj]);
  assert.equal(moved.status, 1);
  assert.equal(envOf(moved).result.refusals[0].code, "REBIND");
  assert.ok(!existsSync(elsewhere), "nothing created on a refusal");
  const movedOk = bin(["init", elsewhere, "--rebind", "--json", "--project", proj]);
  assert.equal(movedOk.status, 0, movedOk.stderr);
  assert.ok(existsSync(elsewhere));
  assert.equal(JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8")).vault_path, elsewhere);
  assert.equal(bin(["init", "--project", project({ bound: false })]).status, 2);
  // A relative path resolves against the project.
  const p2 = project({ bound: false });
  const rel = bin(["bind", "./my-vault", "--json", "--project", p2]);
  assert.equal(rel.status, 1, "relative to the project, and missing");
  assert.equal(envOf(rel).result.vault_path, join(p2, "my-vault"));
});

// ─── Scaffold is a core verb, and init creates a whole vault ─────────────
//
// The story "Scaffold is a core verb, and init creates a whole vault: the
// directory, its git repository, the layout's folders and indexes"
// (PS-CORE). One test per acceptance criterion.

const LAYOUT_FOLDERS = JSON.parse(readFileSync(join(ROOT, "scaffold", "layouts", "engineering.json"), "utf8")).folders;
// Every folder, its README, and the vault README — the engineering layout's whole skeleton.
const SKELETON = [...LAYOUT_FOLDERS.flatMap((f) => [`${f.path}/`, ...(f.readme ? [`${f.path}/README.md`] : [])]), "README.md"];
const vaultOf = (proj) => JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8")).vault_path;
// A whole tree as {path: bytes}, .git left out.
function treeOf(dir, at = "") {
  const out = {};
  for (const n of readdirSync(join(dir, at)).sort()) {
    if (!at && n === ".git") continue;
    const rel = at ? `${at}/${n}` : n;
    if (statSync(join(dir, rel)).isDirectory()) { out[`${rel}/`] = null; Object.assign(out, treeOf(dir, rel)); }
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}
// git with an identity and no signing, whatever the developer's config says.
const git = (cwd, args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
// A project that is a git repository with one commit and nothing else uncommitted.
function gitProject() {
  const proj = project({ bound: false });
  git(proj, ["init", "-q"]);
  writeFileSync(join(proj, "README.md"), "# p\n");
  git(proj, ["add", "-A"]);
  assert.equal(git(proj, ["commit", "-q", "-m", "one"]).status, 0, "the fixture commit");
  return proj;
}
const notInfo = (r) => envOf(r).result.filter((f) => f.level !== "info").map((f) => `[${f.check}] ${f.message}`);

test("cli scaffold: on a bound vault with no layout folders the bare verb lists every folder, folder README and the vault README as create, writes nothing, exit 0", () => {
  const proj = project();
  const vault = vaultOf(proj);
  const r = bin(["scaffold", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  for (const p of SKELETON) assert.ok(r.stdout.includes(`\n  create  ${p}\n`), `${p} is planned as create:\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`${SKELETON.length} to create\\.\\n`));
  // The bare plan's text ends with the command that writes it, in both forms.
  assert.match(r.stdout, /\nTo write them: \S+scaffold in a session, or `projectstore scaffold --write`\.\n$/);
  assert.deepEqual(readdirSync(vault), [], "nothing written");
  const j = bin(["scaffold", "--json", "--project", proj]);
  assert.equal(j.status, 0, j.stderr);
  const e = envOf(j);
  assert.equal(e.verb, "scaffold");
  assert.equal(e.ok, true);
  assert.deepEqual(e.result.rows.map((x) => (x.type === "folder" ? `${x.path}/` : x.path)), SKELETON);
  assert.ok(e.result.rows.every((x) => x.action === "create"));
  assert.equal(e.result.creates, SKELETON.length);
  assert.equal(e.result.wrote, false);
  assert.ok(!j.stdout.includes("{{") && !j.stdout.includes("## Index"), "no file body in the envelope");
  assert.deepEqual(readdirSync(vault), [], "nothing written under --json either");
});

test("cli scaffold: without a terminal --write creates them; a second run plans zero changes; a hand-edited README stays byte-for-byte and reads exists", () => {
  const proj = project();
  const vault = vaultOf(proj);
  mkdirSync(join(vault, "adr"));
  writeFileSync(join(vault, "adr", "README.md"), "# My decisions\n\nHand-written.\n");
  const w = bin(["scaffold", "--write", "--json", "--project", proj]);
  assert.equal(w.status, 0, w.stderr);
  const e = envOf(w).result;
  assert.equal(e.rows.find((x) => x.path === "adr").action, "exists");
  assert.equal(e.rows.find((x) => x.path === "adr/README.md").action, "exists");
  assert.equal(e.wrote, true);
  assert.equal(e.created.length, SKELETON.length - 2);
  assert.deepEqual(e.exists, ["adr", "adr/README.md"]);
  assert.equal(readFileSync(join(vault, "adr", "README.md"), "utf8"), "# My decisions\n\nHand-written.\n", "never rewritten");
  for (const f of LAYOUT_FOLDERS) assert.ok(existsSync(join(vault, f.path, "README.md")), f.path);
  assert.ok(existsSync(join(vault, "README.md")));
  const before = treeOf(vault);
  const again = bin(["scaffold", "--write", "--json", "--project", proj]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(envOf(again).result.creates, 0, "zero changes planned");
  assert.deepEqual(envOf(again).result.created, []);
  assert.deepEqual(treeOf(vault), before, "and nothing written");
  assert.match(bin(["scaffold", "--write", "--project", proj]).stdout, /Nothing to create: every folder and README the layout declares is there\.\n$/);
  // Text mode, spawned: stdin is no terminal, so --write is the confirmation.
  const p2 = project();
  const t = bin(["scaffold", "--write", "--project", p2]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, new RegExp(`\\nCreated ${SKELETON.length}\\.\\n$`));
  assert.ok(!t.stdout.includes("Apply "), "no question without a terminal");
  assert.ok(existsSync(join(vaultOf(p2), "README.md")));
});

test("cli scaffold: at a terminal (injected ask, run() in process) the plan prints before \"Apply N changes? [Y/n]\"; Enter applies, n prints Nothing written. and exits 1, end of input is a no", async () => {
  const call = async (proj, answer) => {
    const stdout = new Sink(), stderr = new Sink();
    const asked = [];
    // The terminal writes the question where the plan went; `ask` stands in for it.
    const ask = async (q) => { asked.push(q); stdout.write(q); return answer; };
    const code = await run(["scaffold", "--write", "--project", proj], { env: {}, cwd: proj, stdout, stderr, ask });
    return { code, out: stdout.text, err: stderr.text, asked };
  };
  const question = `Apply ${SKELETON.length} changes? [Y/n] `;
  const yes = project();
  const y = await call(yes, "");
  assert.equal(y.code, 0, y.err);
  assert.deepEqual(y.asked, [question]);
  const q = y.out.indexOf(question);
  assert.ok(q > 0 && y.out.indexOf("  create  adr/\n") < q && y.out.indexOf("  create  README.md\n") < q, `the plan, then the question:\n${y.out}`);
  assert.ok(!y.out.slice(0, q).includes("To write them"), "the plan asked about does not also say how to write it");
  assert.match(y.out.slice(q), new RegExp(`Created ${SKELETON.length}\\.\\n$`));
  assert.ok(existsSync(join(vaultOf(yes), "adr", "README.md")));
  // A plan with nothing to create asks nothing.
  const none = await call(yes, "n");
  assert.equal(none.code, 0);
  assert.deepEqual(none.asked, []);
  for (const [answer, why] of [["n", "n"], [null, "end of input"], ["nope", "anything else"]]) {
    const proj = project();
    const r = await call(proj, answer);
    assert.equal(r.code, 1, why);
    assert.deepEqual(r.asked, [question], why);
    assert.ok(r.out.endsWith(`${question}Nothing written.\n`), `${why}: ${r.out}`);
    assert.deepEqual(readdirSync(vaultOf(proj)), [], `${why}: nothing written`);
  }
  for (const answer of ["y", "YES"]) {
    const proj = project();
    assert.equal((await call(proj, answer)).code, 0, answer);
    assert.ok(existsSync(join(vaultOf(proj), "README.md")), answer);
  }
  // --json never asks, at a terminal too: it is how a session confirms.
  const j = project();
  const stdout = new Sink();
  const code = await run(["scaffold", "--write", "--json", "--project", j], { env: {}, cwd: j, stdout, stderr: new Sink(), ask: async () => assert.fail("--json asked") });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.text).result.created.length, SKELETON.length);
});

test("scaffold plan: a kind with no string in the language, or a missing vault-readme template, refuses before any write, naming the kind or template and the language", async () => {
  const { planScaffold, applyScaffold } = await import("../scripts/scaffold.mjs");
  const { planBind, applyBind } = await import("../scripts/binding.mjs");
  // A plugin root of its own: the engineering layout plus a folder of a kind no language names.
  const root = mkdtempSync(join(tmpdir(), "ps-scaffold-root-"));
  mkdirSync(join(root, "scaffold", "layouts"), { recursive: true });
  const eng = JSON.parse(readFileSync(join(ROOT, "scaffold", "layouts", "engineering.json"), "utf8"));
  writeFileSync(join(root, "scaffold", "layouts", "engineering.json"), JSON.stringify(eng));
  writeFileSync(join(root, "scaffold", "layouts", "widgets.json"), JSON.stringify({ ...eng, name: "widgets", folders: [...eng.folders, { path: "widgets", kind: "widget", readme: true }] }));
  for (const lang of ["en", "ru"]) {
    mkdirSync(join(root, "templates", lang), { recursive: true });
    for (const f of ["folder-readme.md.tmpl", "vault-readme.md.tmpl", "strings.json"]) writeFileSync(join(root, "templates", lang, f), readFileSync(join(ROOT, "templates", lang, f)));
  }
  const vault = mkdtempSync(join(tmpdir(), "ps-scaffold-v-"));
  assert.equal(planScaffold(vault, { layout: "engineering", language: "ru", root }).ok, true, "the copy is complete");
  const kind = planScaffold(vault, { layout: "widgets", language: "ru", root });
  assert.equal(kind.ok, false);
  assert.deepEqual(kind.refusals.map((r) => r.code), ["STRINGS"]);
  assert.match(kind.refusals[0].message, /"widget"/);
  assert.match(kind.refusals[0].message, /"ru"/);
  assert.throws(() => applyScaffold(kind), /widget/);
  rmSync(join(root, "templates", "en", "vault-readme.md.tmpl"));
  const tmpl = planScaffold(vault, { layout: "engineering", language: "en", root });
  assert.equal(tmpl.ok, false);
  assert.deepEqual(tmpl.refusals.map((r) => r.code), ["TEMPLATE"]);
  assert.match(tmpl.refusals[0].message, /vault-readme/);
  assert.match(tmpl.refusals[0].message, /"en"/);
  // doctor warns on the same list, through the same check (the folder README stays its issue).
  const { checkLayoutTemplates } = await import("../scripts/doctor.mjs");
  const { pinPluginRoot } = await import("../scripts/harness.mjs");
  pinPluginRoot(root);
  let warns;
  try {
    warns = [...checkLayoutTemplates({ layout: "widgets", language: "ru" }), ...checkLayoutTemplates({ layout: "engineering", language: "en" })]
      .filter((f) => f.level === "warn").map((f) => `${f.check}: ${f.message}`);
  } finally { pinPluginRoot(ROOT); }
  assert.equal(warns.length, 2, warns.join("\n"));
  assert.match(warns[0], /^templates: language "ru" has no name and description for the folder kind "widget"/);
  assert.match(warns[1], /^templates: language "en" has no vault-readme template/);
  assert.deepEqual(readdirSync(vault), [], "nothing written by a refused plan");
  // A vault path that is a file, and a folder path that is a file.
  const file = join(vault, "a-file");
  writeFileSync(file, "x");
  assert.deepEqual(planScaffold(file, { layout: "engineering", language: "ru", root }).refusals.map((r) => r.code), ["NOT_A_DIRECTORY"]);
  writeFileSync(join(vault, "adr"), "x");
  const folder = planScaffold(vault, { layout: "engineering", language: "ru", root });
  assert.deepEqual(folder.refusals.map((r) => r.code), ["FOLDER_IS_FILE"]);
  assert.match(folder.refusals[0].message, /^adr exists in .* as a file/);
  // init's whole-vault path is one plan: the scaffold's refusal stops the mkdir too.
  const proj = project({ bound: false });
  const missing = join(mkdtempSync(join(tmpdir(), "ps-scaffold-init-")), "vault");
  const p = planBind(proj, { vault: missing, layout: "widgets", language: "ru", init: true, root, env: {} });
  assert.equal(p.ok, false);
  assert.equal(p.buildsVault, false);
  assert.equal(p.createsVault, false);
  assert.ok(p.refusals.some((r) => r.code === "STRINGS" && /"widget"/.test(r.message)), JSON.stringify(p.refusals));
  assert.throws(() => applyBind(p));
  assert.ok(!existsSync(missing), "nothing created");
  assert.ok(!existsSync(layoutPaths(proj).binding), "no binding written");
  // A bind does not take the scaffold's refusals: it binds, and its Next line names status.
  const b = planBind(proj, { vault, layout: "widgets", language: "ru", root, env: {} });
  assert.equal(b.ok, true, JSON.stringify(b.refusals));
  // Through the bin: an unloadable layout and a vault that is gone are exit 1, unbound is 3, a layout argument is 2.
  const bad = project({ bound: false });
  writeBinding(bad, JSON.stringify({ vault_path: mkdtempSync(join(tmpdir(), "ps-vault-")), layout: "nope" }));
  const nope = bin(["scaffold", "--project", bad]);
  assert.equal(nope.status, 1);
  assert.match(nope.stderr, /the layout "nope" does not load/);
  const gone = project({ bound: false });
  const goneVault = join(tmpdir(), `ps-gone-${process.pid}-${Date.now()}`);
  writeBinding(gone, JSON.stringify({ vault_path: goneVault, layout: "engineering" }));
  const g = bin(["scaffold", "--write", "--project", gone]);
  assert.equal(g.status, 1);
  assert.match(g.stderr, /does not exist .*`projectstore init /);
  assert.ok(!existsSync(goneVault), "scaffold never creates the vault itself");
  assert.equal(envOf(bin(["scaffold", "--json", "--project", gone])).ok, false);
  assert.equal(bin(["scaffold", "--project", project({ bound: false })]).status, 3);
  const layoutArg = bin(["scaffold", "engineering", "--project", project()]);
  assert.equal(layoutArg.status, 2);
  assert.match(layoutArg.stderr, /^scaffold takes no argument `engineering`/);
});

test("cli init: a missing directory becomes a whole vault — binding, a git repository with no commit, folders and READMEs; doctor --install has no vault-git and doctor --vault --json has no issue or warn; an existing empty directory does the same without the mkdir", () => {
  for (const shape of ["missing", "empty"]) {
    const proj = gitProject();
    const vault = shape === "missing" ? join(mkdtempSync(join(tmpdir(), "ps-init-whole-")), "vault") : mkdtempSync(join(tmpdir(), "ps-init-empty-"));
    const r = bin(["init", vault, "--json", "--project", proj]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const e = envOf(r);
    assert.equal(e.ok, true);
    assert.equal(e.result.created_vault, shape === "missing", `${shape}: created_vault is the mkdir alone`);
    assert.equal(e.result.wrote, true);
    assert.deepEqual(e.result.git, { done: true }, shape);
    assert.deepEqual(e.result.scaffold, { created: SKELETON.map((p) => p.replace(/\/$/, "")), exists: [] }, shape);
    assert.equal(vaultOf(proj), vault);
    assert.ok(existsSync(join(vault, ".git")), `${shape}: a git repository`);
    assert.notEqual(git(vault, ["rev-parse", "--verify", "-q", "HEAD"]).status, 0, `${shape}: with no commit`);
    for (const p of SKELETON) assert.ok(existsSync(join(vault, p)), `${shape}: ${p}`);
    const install = envOf(bin(["doctor", "--install", "--json", "--project", proj])).result;
    assert.ok(!install.some((f) => f.check === "vault-git"), `${shape}: no vault-git finding`);
    assert.deepEqual(notInfo(bin(["doctor", "--vault", "--json", "--project", proj])), [], `${shape}: doctor --vault`);
    assert.match(bin(["doctor", "--vault", "--project", proj]).stdout, /Summary: 0 issue\(s\), 0 warning\(s\)\./);
  }
});

test("cli init/bind: work-without-story ignores .projectstore/.gitignore and still counts any other uncommitted source file", () => {
  for (const verb of ["init", "bind"]) {
    const proj = gitProject();
    const vault = verb === "init" ? join(mkdtempSync(join(tmpdir(), "ps-wws-")), "vault") : mkdtempSync(join(tmpdir(), "ps-wws-"));
    assert.equal(bin([verb, vault, "--project", proj]).status, 0);
    const untracked = git(proj, ["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean);
    assert.deepEqual(untracked, [".projectstore/.gitignore"], `${verb}: the binding's ignore file is the one untracked file`);
    const wws = (r) => envOf(r).result.filter((f) => f.check === "work-without-story");
    assert.deepEqual(wws(bin(["doctor", "--vault", "--json", "--project", proj])), [], `${verb}: the plugin's own setup is not work`);
    writeFileSync(join(proj, "app.mjs"), "export {};\n");
    const after = wws(bin(["doctor", "--vault", "--json", "--project", proj]));
    assert.equal(after.length, 1, `${verb}: another uncommitted file still counts`);
    assert.match(after[0].message, /^1 uncommitted source file\(s\)/);
  }
});

test("cli init: git absent (PATH \"\") skips with git.skipped and exits 0; inside a work tree it prints the embedded-repository line; a failing git init is git.failed with the remedy, scaffold still runs, ok:false, exit 1", () => {
  // Absent: the one skip the ADR allows; every other step completes.
  const absent = join(mkdtempSync(join(tmpdir(), "ps-nogit-")), "vault");
  const a = bin(["init", absent, "--json", "--project", project({ bound: false })], { env: { PATH: "" } });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(envOf(a).ok, true);
  assert.deepEqual(envOf(a).result.git, { skipped: "git is not on PATH" });
  assert.equal(envOf(a).result.scaffold.created.length, SKELETON.length);
  assert.ok(!existsSync(join(absent, ".git")));
  const at = bin(["init", join(mkdtempSync(join(tmpdir(), "ps-nogit-")), "vault"), "--project", project({ bound: false })], { env: { PATH: "" } });
  assert.equal(at.status, 0);
  assert.match(at.stdout, /\nSkipped git init: git is not on PATH\. .*vault-git/);
  // Inside another work tree: git init still runs, and one line says so.
  const outer = gitProject();
  const inner = join(outer, "notes", "vault");
  const t = bin(["init", inner, "--project", project({ bound: false })]);
  assert.equal(t.status, 0, t.stderr);
  assert.ok(existsSync(join(inner, ".git")), "the vault gets its own repository");
  const top = realpathSync(outer);
  assert.ok(t.stdout.includes(`\`${inner}\` is inside the git work tree at \`${top}\`; the vault gets its own repository, which that repository will see as an embedded one.`), t.stdout);
  const inner2 = join(outer, "notes", "vault2");
  assert.deepEqual(envOf(bin(["init", inner2, "--json", "--project", project({ bound: false })])).result.git, { done: true, inside: top });
  // Failing: a git whose init fails (a read-only parent, simulated), on PATH ahead of nothing else.
  const fake = mkdtempSync(join(tmpdir(), "ps-fakegit-"));
  writeFileSync(join(fake, "git"), "#!/bin/sh\nif [ \"$1\" = init ]; then echo \"fatal: cannot mkdir .git: Read-only file system\" >&2; exit 128; fi\necho \"fatal: not a git repository\" >&2\nexit 128\n", { mode: 0o755 });
  const failing = join(mkdtempSync(join(tmpdir(), "ps-failgit-")), "vault");
  const fp = project({ bound: false });
  const f = bin(["init", failing, "--json", "--project", fp], { env: { PATH: fake } });
  assert.equal(f.status, 1, f.stderr + f.stdout);
  const fe = envOf(f);
  assert.equal(fe.ok, false);
  assert.equal(fe.result.git.failed, "fatal: cannot mkdir .git: Read-only file system");
  assert.match(fe.result.git.remedy, /^Run `git init` in \S+, or \S+doctor --fix, which offers it\.$/, "the --json result carries the remedy the text prints");
  assert.equal(fe.result.wrote, true, "the binding is written");
  assert.equal(fe.result.scaffold.created.length, SKELETON.length, "scaffold still runs");
  assert.ok(existsSync(join(failing, "README.md")));
  const ft = bin(["init", join(mkdtempSync(join(tmpdir(), "ps-failgit-")), "vault"), "--project", project({ bound: false })], { env: { PATH: fake } });
  assert.equal(ft.status, 1);
  assert.match(ft.stdout, /\ngit init failed: fatal: cannot mkdir \.git: Read-only file system\n {2}Run `git init` in \S+, or \S+doctor --fix, which offers it\.\n/);
  assert.match(ft.stdout, /\nScaffolded the engineering layout/);
  assert.ok(!/Next:/.test(ft.stdout), "the remedy is the next step");
  // Inherited repository-locating variables (a hook, a script) point nowhere
  // near the vault: git init still makes the vault's own .git, and the decoy
  // they name is left alone.
  const decoy = mkdtempSync(join(tmpdir(), "ps-decoy-"));
  const located = join(mkdtempSync(join(tmpdir(), "ps-located-")), "vault");
  const d = bin(["init", located, "--json", "--project", project({ bound: false })], { env: { GIT_DIR: join(decoy, "elsewhere.git"), GIT_OBJECT_DIRECTORY: join(decoy, "objects"), GIT_WORK_TREE: decoy } });
  assert.equal(d.status, 0, d.stderr + d.stdout);
  assert.deepEqual(envOf(d).result.git, { done: true });
  assert.ok(existsSync(join(located, ".git", "HEAD")), "the vault gets its own repository");
  assert.deepEqual(readdirSync(decoy), [], "nothing was created where GIT_DIR pointed");
});

test("cli bind/init on an existing non-empty vault: binds, no git init, no scaffold; Next names scaffold in both forms only when the plan has a create row, status otherwise", () => {
  const both = /\nNext: \S+scaffold in a session, or `projectstore scaffold --write`, creates the layout's missing folders and READMEs\.\n$/;
  const status = /\nNext: `projectstore status`\.\n$/;
  const vault = mkdtempSync(join(tmpdir(), "ps-nonempty-"));
  writeFileSync(join(vault, "notes.md"), "# mine\n");
  const proj = project({ bound: false });
  const i = bin(["init", vault, "--project", proj]);
  assert.equal(i.status, 0, i.stderr);
  assert.deepEqual(readdirSync(vault), ["notes.md"], "no git init and no scaffold inside someone's files");
  assert.match(i.stdout, both);
  // init again on that binding: BOUND, and its hint gives both forms too.
  const bound = bin(["init", vault, "--project", proj]);
  assert.equal(bound.status, 1);
  assert.match(bound.stderr, /already bound to .* — \S+scaffold in a session, or `projectstore scaffold --write`, creates the layout's missing folders and READMEs\n$/);
  const ij = envOf(bin(["init", vault, "--json", "--project", project({ bound: false })])).result;
  assert.equal(ij.git, null);
  assert.equal(ij.scaffold, null);
  // Already bound: the same decision.
  const same = bin(["bind", vault, "--project", proj]);
  assert.equal(same.status, 0);
  assert.match(same.stdout, /^Already bound to /);
  assert.match(same.stdout, both);
  // The layout's folders there: status, fresh and already bound alike.
  assert.equal(bin(["scaffold", "--write", "--project", proj]).status, 0);
  assert.match(bin(["bind", vault, "--project", proj]).stdout, status);
  const fresh = bin(["bind", vault, "--project", project({ bound: false })]);
  assert.match(fresh.stdout, status);
  assert.ok(!/scaffold/.test(fresh.stdout), fresh.stdout);
  // A folder present without its README is a create row too.
  rmSync(join(vault, "ops", "README.md"));
  assert.match(bin(["bind", vault, "--project", project({ bound: false })]).stdout, both);
  // A fresh bind to an empty vault names scaffold.
  assert.match(bin(["bind", mkdtempSync(join(tmpdir(), "ps-empty-")), "--project", project({ bound: false })]).stdout, both);
});

test("cli scaffold: bind + scaffold --write and init give byte-identical trees outside .git", () => {
  for (const language of ["en", "ru"]) {
    const a = join(mkdtempSync(join(tmpdir(), "ps-ident-a-")), "team-vault");
    const b = join(mkdtempSync(join(tmpdir(), "ps-ident-b-")), "team-vault");
    mkdirSync(a);
    const pa = project({ bound: false });
    assert.equal(bin(["bind", a, "--language", language, "--project", pa]).status, 0);
    assert.equal(bin(["scaffold", "--write", "--project", pa]).status, 0);
    assert.equal(bin(["init", b, "--language", language, "--project", project({ bound: false })]).status, 0);
    const ta = treeOf(a), tb = treeOf(b);
    assert.ok(Object.keys(ta).length === SKELETON.length, language);
    assert.deepEqual(ta, tb, `${language}: the two vaults differ`);
    assert.match(ta["README.md"], /^# team-vault\n/, "titled by the directory's name alone");
  }
});

test("cli: commands/scaffold.md and the rendered $projectstore-scaffold skill run the bin and compose no README", async () => {
  const codex = loadHarness("codex");
  const skill = join(codex.output_dir, "skills", codex.surfaces.commands.rendered_name.split("<name>").join("scaffold"), "SKILL.md");
  for (const rel of [join("commands", "scaffold.md"), skill]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(src, /bin\/projectstore\.mjs" scaffold --project "[^"]+"/, `${rel}: the plan is the bin's`);
    assert.match(src, /bin\/projectstore\.mjs" scaffold --write --json --project "[^"]+"/, `${rel}: so is the confirmed write, under --json`);
    for (const gone of ["folder-readme.md.tmpl", "mkdir", "Skip READMEs", "{{folder_name}}", "{{folder_description}}", "layout-name", "scaffold/layouts/", "file-writing tool", "Write tool"]) {
      assert.ok(!src.includes(gone), `${rel} still composes the vault itself: ${gone}`);
    }
  }
  assert.match(readFileSync(join(ROOT, "commands", "scaffold.md"), "utf8"), /^---\n[\s\S]*?\nargument-hint: ""\n[\s\S]*?---\n/, "no layout argument");
  const { checkCodexAdapter } = await import("../scripts/build-adapters.mjs");
  assert.equal(checkCodexAdapter().ok, true, "the Codex render is current");
});

// Contract 19 from the bin: the install family and agents configure refuse a
// project that does not exist (a path ending in a comma or a space, or a file),
// quoted, exit 1, from --project or the neutral variable; nothing appears in
// the parent or in any harness home; read verbs still run on that path.
test("cli contract 19: the install family and agents configure refuse a project that does not exist; read verbs still run", () => {
  const parent = mkdtempSync(join(tmpdir(), "ps-cli-missing-"));
  const file = join(parent, "a-file");
  writeFileSync(file, "x");
  const homes = { HOME: mkdtempSync(join(tmpdir(), "ps-cli-home-")), CODEX_HOME: mkdtempSync(join(tmpdir(), "ps-cli-codex-")), [SRC.runtime.home_env]: mkdtempSync(join(tmpdir(), "ps-cli-claude-")) };
  const verbs = [["plan"], ["install"], ["upgrade"], ["uninstall"], ["uninstall", "--global"]];
  for (const missing of [join(parent, "project,"), join(parent, "project "), file]) {
    const quoted = JSON.stringify(missing);
    for (const args of verbs) {
      for (const json of [false, true]) {
        for (const via of ["flag", "env"]) {
          const r = via === "flag"
            ? bin([...args, "--harness", "codex", ...(json ? ["--json"] : []), "--project", missing], { env: homes })
            : bin([...args, "--harness", "codex", ...(json ? ["--json"] : [])], { env: { ...homes, PROJECTSTORE_PROJECT_DIR: missing } });
          const what = `${args.join(" ")} ${json ? "--json" : "text"} ${via} ${quoted}`;
          assert.equal(r.status, 1, `${what}: ${r.stdout}${r.stderr}`);
          const want = `no such project directory: ${json ? JSON.stringify(quoted).slice(1, -1) : quoted}`;
          assert.ok((r.stdout + r.stderr).includes(want), `${what}: ${r.stdout}${r.stderr}`);
        }
      }
    }
    for (const json of [false, true]) {
      const conf = bin(["agents", "configure", "--harness", "codex", "--default", "gpt-5", ...(json ? ["--json"] : []), "--project", missing], { env: homes });
      assert.equal(conf.status, 1, conf.stdout + conf.stderr);
      if (json) assert.ok(envOf(conf).result.error.startsWith(`no such project directory: ${quoted}`), conf.stdout);
      else assert.ok(conf.stderr.startsWith(`no such project directory: ${quoted}`), conf.stderr);
    }
  }
  assert.deepEqual(readdirSync(parent), ["a-file"], "nothing was created beside the file");
  for (const dir of Object.values(homes)) assert.deepEqual(readdirSync(dir), [], `${dir} stays empty`);
  for (const args of [["doctor"], ["agents", "show", "--harness", "codex"]]) {
    const r = bin([...args, "--project", join(parent, "project,")], { env: homes });
    assert.ok(!/no such project directory/.test(r.stdout + r.stderr), `${args.join(" ")} still runs: ${r.stdout}${r.stderr}`);
  }
});

// ─── Per-verb parse: a verb's own table types its flags ──────────────────
//
// The story "The CLI parses options per verb: a verb's own table types its
// flags, and a verb refuses an argument it does not take" (PS-CORE). The scan
// finds the verb knowing only the globals; one strict parse then runs on that
// row plus the globals; the row's usage forms are both its help's Usage lines
// and the bound on its arguments. One test per acceptance group.

// The MCP server's sink, for the in-process seam.
class Sink {
  constructor() { this.text = ""; }
  write(s) { this.text += String(s); return true; }
  get isTTY() { return false; }
}

test("cli per-verb parse: one name, two types — boolean --x on a, --x <value> on b, through run(argv, { verbs })", async () => {
  const seen = [];
  const row = (verb, x) => ({ verb, summary: `The ${verb} verb.`, usage: [], options: [x], requiresBinding: false, run: async ({ values, positionals }) => { seen.push({ verb, values, positionals }); return 0; } });
  const verbs = [row("a", opt("x", false, "a flag")), row("b", opt("x", "<value>", "a value"))];
  const cwd = mkdtempSync(join(tmpdir(), "ps-cli-seam-"));
  const call = async (argv) => {
    const stdout = new Sink(), stderr = new Sink();
    const code = await run(argv, { verbs, env: {}, cwd, stdout, stderr });
    return { code, out: stdout.text, err: stderr.text };
  };
  const a = await call(["a", "--x"]);
  assert.equal(a.code, 0, a.err);
  assert.equal(seen.at(-1).verb, "a");
  assert.equal(seen.at(-1).values.x, true, "a flag on a");
  const b = await call(["b", "--x", "v"]);
  assert.equal(b.code, 0, b.err);
  assert.equal(seen.at(-1).verb, "b");
  assert.equal(seen.at(-1).values.x, "v", "a value on b");
  assert.deepEqual(seen.at(-1).positionals, [], "the value is the option's, not an argument");
  const ran = seen.length;
  const inline = await call(["a", "--x=v"]);
  assert.equal(inline.code, 2);
  assert.match(inline.err, /^`--x` takes no value\nRun `a --help` for the options\.\n$/);
  for (const argv of [["b", "--x"], ["b", "--x", "--json"]]) {
    const r = await call(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /^`--x` needs a value: `--x <value>`\n/, argv.join(" "));
  }
  // The flag's value is an argument a does not take, and the hint says why.
  const stray = await call(["a", "--x", "v"]);
  assert.equal(stray.code, 2);
  assert.match(stray.err, /^a takes no argument `v` — `--x` takes no value\n/);
  // The unknown-option hint reads the scanned row, never VERBS.
  assert.match((await call(["a", "--y"])).err, /^a does not take --y — did you mean --x\?/);
  assert.equal(seen.length, ran, "no refused line reached a verb");
  // The table is the whole world: a real verb is unknown here, and the help lists the test's rows.
  const real = await call(["doctor"]);
  assert.equal(real.code, 2);
  assert.match(real.err, /^unknown verb: doctor\n/);
  assert.ok(!real.err.includes("did you mean"), real.err);
  assert.match(real.err, /\nOther\n {2}a {12}The a verb\.\n {2}b {12}The b verb\.\n/);
  assert.ok(!/\n {2}doctor /.test(real.err), "VERBS does not leak into the usage");
  const help = await call(["b", "--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.out.startsWith("npx projectstore b — The b verb.\n\nUsage\n  npx projectstore b [options]\n"), help.out);
});

test("cli per-verb parse: doctor --vault /tmp/x and status extra exit 2 naming the argument; the --json envelope's verb is doctor", () => {
  const proj = project({ bound: false });
  const text = bin(["doctor", "--vault", "/tmp/x"], { cwd: proj });
  assert.equal(text.status, 2);
  assert.equal(text.stdout, "", "doctor never ran");
  assert.equal(text.stderr, "doctor takes no argument `/tmp/x` — `--vault` takes no value\nRun `doctor --help` for the options.\n");
  const json = bin(["doctor", "--vault", "/tmp/x", "--json"], { cwd: proj });
  assert.equal(json.status, 2);
  const e = envOf(json);
  assert.equal(e.verb, "doctor");
  assert.equal(e.project, null);
  assert.equal(e.ok, false);
  assert.equal(e.result.exit, 2);
  assert.match(e.result.error, /^doctor takes no argument `\/tmp\/x`/);
  const status = bin(["status", "extra", "--json"], { cwd: proj });
  assert.equal(status.status, 2);
  assert.equal(envOf(status).verb, "status");
  assert.match(status.stderr, /^status takes no argument `extra`\nRun `status --help` for the options\.\n$/);
});

test("cli per-verb parse: globals before or after the verb give one envelope, -- ends them, help and version answer first", () => {
  const proj = project({ bound: false });
  const lines = [["--project", proj, "status", "--json"], ["status", "--project", proj, "--json"], ["--json", "status", "--project", proj], ["--json", "--project", proj, "--", "status"]];
  const outs = lines.map((argv) => bin(argv));
  outs.forEach((r, i) => assert.equal(r.status, 0, `${lines[i].join(" ")}: ${r.stderr}`));
  const first = envOf(outs[0]);
  assert.equal(first.verb, "status");
  assert.equal(first.project, proj);
  outs.slice(1).forEach((r, i) => assert.equal(r.stdout, outs[0].stdout, lines[i + 1].join(" ")));
  // After "--" every token is an argument: the --project there is one status does not take.
  const ended = bin(["--", "status", "--project", proj], { cwd: proj });
  assert.equal(ended.status, 2);
  assert.match(ended.stderr, /^status takes no argument `--project` — everything after `--` is an argument\n/);
  for (const argv of [["--help"], ["-h"]]) {
    const r = bin(argv);
    assert.equal(r.status, 0, argv.join(" "));
    assert.ok(r.stdout.startsWith("projectstore — "), argv.join(" "));
  }
  for (const [argv, verb] of [[["status", "--help"], "status"], [["status", "-h"], "status"], [["--help", "status"], "status"], [["-h", "status"], "status"], [["status", "extra", "--help"], "status"], [["--harness", "codex", "plan", "--help"], "plan"], [["doctor", "--bogus", "-h"], "doctor"]]) {
    const r = bin(argv);
    assert.equal(r.status, 0, argv.join(" "));
    assert.ok(r.stdout.startsWith(`npx projectstore ${verb} — `), `${argv.join(" ")}: ${r.stdout.split("\n")[0]}`);
  }
  for (const argv of [["--version"], ["-v"], ["-hv"], ["-vh"], ["status", "--version"], ["status", "-hv"], ["--version", "status"], ["-hv", "status", "extra"]]) {
    const r = bin(argv);
    assert.equal(r.status, 0, argv.join(" "));
    assert.equal(r.stdout, PKG.version + "\n", argv.join(" "));
  }
  assert.deepEqual(envOf(bin(["status", "-hv", "--json"])).result, { version: PKG.version }, "version wins over help, in the envelope too");
});

test("cli per-verb parse: a verb's option before the verb shows the corrected order; an undeclared one gets the verb's hint", () => {
  const proj = project({ bound: false });
  const plan = bin(["--harness", "codex", "plan"], { cwd: proj });
  assert.equal(plan.status, 2);
  assert.equal(plan.stderr, "`--harness` belongs after the verb: `npx projectstore plan --harness codex`\nRun `plan --help` for the options.\n");
  assert.match(bin(["--harness=codex", "plan"], { cwd: proj }).stderr, /^`--harness` belongs after the verb: `npx projectstore plan --harness=codex`\n/);
  assert.match(bin(["--verbose", "upgrade"], { cwd: proj }).stderr, /^`--verbose` belongs after the verb: `npx projectstore upgrade --verbose`\n/);
  const json = bin(["--harness", "codex", "plan", "--json"], { cwd: proj });
  assert.equal(json.status, 2);
  assert.equal(envOf(json).verb, "plan");
  assert.match(envOf(json).result.error, /plan --harness codex/);
  const verbos = bin(["--verbos", "install"], { cwd: proj });
  assert.equal(verbos.status, 2);
  assert.match(verbos.stderr, /^install does not take --verbos — did you mean --verbose\?\nRun `install --help` for the options\.\n$/);
  // With no verb to scope it, an option no verb declares keeps 0.29.2's hint over the whole table.
  const instal = bin(["--verbos", "instal"], { cwd: proj });
  assert.equal(instal.status, 2);
  assert.match(instal.stderr, /^unknown option --verbos — did you mean --verbose\?\nRun --help for the options\.\n$/);
  // Through a shell the harness is the shell's: the order shown is the bare verb.
  const shell = bin(["--harness", "codex", "install"], { cwd: proj, env: { PROJECTSTORE_SHELL: "projectstore-codex" } });
  assert.equal(shell.status, 2);
  assert.match(shell.stderr, /^`--harness` belongs after the verb: `npx projectstore-codex install`\n/);
  // The rest of the line follows the moved option, so the command shown is the one to run.
  const tail = ["--harness", "codex", "agents", "configure", "--default", "opus"];
  assert.match(bin(tail, { cwd: proj }).stderr, /^`--harness` belongs after the verb: `npx projectstore agents --harness codex configure --default opus`\n/);
  assert.match(bin(tail, { cwd: proj, env: { PROJECTSTORE_SHELL: "projectstore-codex" } }).stderr, /^`--harness` belongs after the verb: `npx projectstore-codex agents configure --default opus`\n/);
  // A bare word after a verb's option, and no verb: the usage, as before — not "unknown verb: codex".
  const none = bin(["--harness", "codex"], { cwd: proj });
  assert.equal(none.status, 2);
  assert.ok(!none.stderr.includes("unknown verb"), none.stderr);
  assert.match(none.stderr, /\nUsage\n/);
});

test("cli per-verb parse: an error before the verb names the scanned verb, in the envelope and on stderr", () => {
  const proj = project({ bound: false });
  const r = bin(["--project", "/tmp", "--bogus", "doctor", "--json"], { cwd: proj });
  assert.equal(r.status, 2);
  const e = envOf(r);
  assert.equal(e.verb, "doctor", "the verb, not --project's value");
  assert.equal(e.project, null);
  assert.deepEqual(e.result, { error: "doctor does not take --bogus\nRun `doctor --help` for the options.", exit: 2 });
  assert.equal(r.stderr, "doctor does not take --bogus\nRun `doctor --help` for the options.\n");
  // During the parse (a bad value) and after it (an argument past the form), and with no verb at all.
  for (const [argv, verb, error] of [
    [["--json", "--project", "/tmp", "reconcile", "--only"], "reconcile", /^`--only` needs a value: `--only <target>`\nRun `reconcile --help`/],
    [["--project", "/tmp", "show", "a.md", "b.md", "--json"], "show", /^`show <path>` takes no further argument `b\.md`\nRun `show --help`/],
    [["--project", "/tmp", "frobnicate", "--json"], "frobnicate", /^unknown verb: frobnicate/],
    [["--project", "/tmp", "--bogus", "--json"], null, /^unknown option --bogus\nRun --help for the options\.$/],
    // A word after an option no verb declares is not its value: the option is named, as in 0.29.2.
    [["--bogus", "frobnicate", "--json"], "frobnicate", /^unknown option --bogus\nRun --help for the options\.$/],
  ]) {
    const x = bin(argv, { cwd: proj });
    assert.equal(x.status, 2, argv.join(" "));
    assert.equal(envOf(x).verb, verb, argv.join(" "));
    assert.match(envOf(x).result.error, error, argv.join(" "));
    assert.ok(x.stderr.startsWith(envOf(x).result.error), `${argv.join(" ")}: stderr carries the same message`);
  }
});

test("cli per-verb parse: show, graph, agents, bind and init refuse an argument past their form; unknown first words keep today's message; -- still delivers dash-led input", () => {
  const { proj } = cliVault();
  const vault = join(mkdtempSync(join(tmpdir(), "ps-cli-bound-")), "v");
  for (const [argv, message] of [
    [["show", "adr/new-way.md", "extra"], "`show <path>` takes no further argument `extra`"],
    [["graph", "neighbors", "adr/new-way.md", "extra"], "`graph neighbors <path>` takes no further argument `extra`"],
    [["graph", "lineage", "adr/new-way.md", "extra"], "`graph lineage <path>` takes no further argument `extra`"],
    [["agents", "show", "extra"], "`agents show` takes no further argument `extra`"],
    [["agents", "model", "critic", "extra"], "`agents model <name>` takes no further argument `extra`"],
    [["agents", "configure", "extra"], "`agents configure` takes no further argument `extra`"],
    [["bind", vault, "extra"], "`bind <vault>` takes no further argument `extra`"],
    [["init", vault, "extra"], "`init <vault>` takes no further argument `extra`"],
  ]) {
    const r = bin([...argv, "--project", proj]);
    assert.equal(r.status, 2, argv.join(" "));
    assert.ok(r.stderr.startsWith(`${message}\nRun \`${argv[0]} --help\` for the options.\n`), `${argv.join(" ")}: ${r.stderr}`);
  }
  assert.ok(!existsSync(vault), "init refused before it created anything");
  // The bound reads past "--" too, and says so.
  assert.match(bin(["show", "--project", proj, "--", "adr/new-way.md", "-x"]).stderr, /^`show <path>` takes no further argument `-x` — everything after `--` is an argument\n/);
  // A first word no form names: the verb's own message, as in 0.29.2.
  const graph = bin(["graph", "frob", "x", "--project", proj]);
  assert.equal(graph.status, 2);
  assert.equal(graph.stderr, "graph: graph takes neighbors <path> or lineage <path>\n");
  const agents = bin(["agents", "frob", "--project", proj]);
  assert.equal(agents.status, 2);
  assert.equal(agents.stderr, "agents: agents takes model <name>, show, or configure\n");
  assert.equal(bin(["agents", "--project", proj]).stderr, "agents: agents takes model <name>, show, or configure\n");
  // search's phrase is variadic; a dash-led phrase or path after "--" reaches the verb.
  const phrase = bin(["search", "zebra", "crossing", "--json", "--project", proj]);
  assert.equal(phrase.status, 0, phrase.stderr);
  assert.equal(envOf(phrase).result.query, "zebra crossing");
  const dashed = bin(["search", "--json", "--project", proj, "--", "--help", "-v"]);
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.equal(envOf(dashed).verb, "search");
  assert.equal(envOf(dashed).result.query, "--help -v");
  const dashPath = bin(["show", "--json", "--project", proj, "--", "-not-there.md"]);
  assert.equal(dashPath.status, 2);
  assert.equal(envOf(dashPath).verb, "show");
  assert.ok(!/takes no|does not take/.test(envOf(dashPath).result.error), `the verb answered: ${envOf(dashPath).result.error}`);
});

test("cli per-verb help: Usage comes from each row's usage — 0.29.2's forms, search's <phrase…>, no summary opens with its verb", () => {
  // 0.29.2's Usage lines, verb by verb; search's placeholder gains its variadic mark.
  const GOLDEN = {
    doctor: ["doctor [options]"], reconcile: ["reconcile [options]"], plan: ["plan [options]"], install: ["install [options]"], uninstall: ["uninstall [options]"], upgrade: ["upgrade [options]"],
    status: ["status [options]"], orientation: ["orientation [options]"], version: ["version [options]"], mcp: ["mcp"],
    search: ["search <phrase…> [options]"], show: ["show <path> [options]"],
    graph: ["graph neighbors <path> [options]", "graph lineage <path> [options]"],
    codemap: ["codemap --for <selector> [options]"],
    agents: ["agents model <name> [options]", "agents show [options]", "agents configure [options]"],
    bind: ["bind <vault> [options]"], init: ["init <vault> [options]"],
    scaffold: ["scaffold [options]"],
  };
  assert.deepEqual(VERBS.map((v) => v.verb).sort(), Object.keys(GOLDEN).sort(), "every verb has its 0.29.2 forms here");
  for (const v of VERBS) {
    const h = bin([v.verb, "--help"]).stdout;
    // The header is the summary as written: nothing is parsed out of it.
    assert.ok(h.startsWith(`npx projectstore ${v.verb} — ${v.summary}\n\nUsage\n`), h.split("\n")[0]);
    const block = h.split("\n\n").find((b) => b.startsWith("Usage\n")).split("\n").slice(1);
    assert.deepEqual(block, GOLDEN[v.verb].map((l) => `  npx projectstore ${l}`), v.verb);
    assert.ok(!v.summary.startsWith(v.verb), `${v.verb}'s summary is prose, not a form`);
    assert.ok(Array.isArray(v.usage) && Object.isFrozen(v.usage), `${v.verb}.usage is a frozen list`);
    // A form's --option is one the row declares, and the word after it is that option's own placeholder.
    for (const form of v.usage) {
      const words = form.split(" ");
      words.forEach((w, i) => {
        if (!w.startsWith("--")) return;
        const o = v.options.find((x) => x.name === w.slice(2));
        assert.ok(o, `${v.verb}: "${form}" requires ${w}, which the row declares`);
        if (o.arg) assert.equal(words[i + 1], o.arg, `${v.verb}: "${form}" spells ${w}'s value as the row does`);
      });
    }
  }
  // No row retypes a global: --project takes a value, the rest are flags, on every verb.
  const GLOBALS = { project: true, json: false, help: false, version: false };
  const retyped = VERBS.flatMap((v) => v.options.filter((o) => o.name in GLOBALS && Boolean(o.arg) !== GLOBALS[o.name]).map((o) => `${v.verb} --${o.name}`));
  assert.deepEqual(retyped, []);
  assert.deepEqual(Object.keys(PKG.dependencies || {}), [], "zero dependencies");
  assert.equal(PKG.engines.node, ">=20.0.0");
});

test("cli per-verb parse: a verb's option that takes a value takes the next token, dash-led or not — never read as help, version or --json", () => {
  const proj = project({ bound: false });
  for (const [argv, name, arg] of [
    [["search", "--kind", "-h", "x"], "--kind", "<type>"],
    [["show", "--section", "-v", "adr/a.md"], "--section", "<id>"],
    [["reconcile", "--only", "--help"], "--only", "<target>"],
    [["reconcile", "--only", "--version"], "--only", "<target>"],
    [["reconcile", "--only", "--"], "--only", "<target>"],
    [["codemap", "--for", "--help"], "--for", "<selector>"],
  ]) {
    const r = bin(argv, { cwd: proj });
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(r.stdout, "", `${argv.join(" ")}: neither help nor version`);
    assert.ok(r.stderr.startsWith("`" + name + "` needs a value: `" + name + " " + arg + "`\n"), `${argv.join(" ")}: ${r.stderr}`);
  }
  // There --json is the value, not the global: the refusal is on stderr only.
  const json = bin(["reconcile", "--only", "--json"], { cwd: proj });
  assert.equal(json.status, 2);
  assert.equal(json.stdout, "");
  assert.match(json.stderr, /^`--only` needs a value: `--only <target>`\n/);
});

test("cli per-verb parse: codemap without --for keeps its hint; codemap --for X extra names extra", () => {
  const { proj } = cliVault();
  const bare = bin(["codemap", "PS-CORE", "--project", proj]);
  assert.equal(bare.status, 2);
  assert.equal(bare.stderr, "codemap: codemap takes --for <selector>; regeneration is reconcile --only codemap\n");
  const extra = bin(["codemap", "--for", "PS-X", "extra", "--project", proj]);
  assert.equal(extra.status, 2);
  assert.equal(extra.stderr, "codemap takes no argument `extra`\nRun `codemap --help` for the options.\n");
  const json = bin(["codemap", "--for", "PS-X", "extra", "--json", "--project", proj]);
  assert.equal(envOf(json).verb, "codemap");
  assert.equal(envOf(json).result.exit, 2);
  assert.equal(bin(["codemap", "--for", "PS-X", "--json", "--project", proj]).status, 0, "the form itself still runs");
});

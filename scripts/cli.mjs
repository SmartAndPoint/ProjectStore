// projectstore — cli.mjs
//
// The token-free front-end: `projectstore <verb>` as a thin argv/output
// shell over the same core operations the hooks and the command files call
// (distribution ADR decisions 3 and 5). No logic lives here — each verb row
// names the module it wraps and how (spawned, imported, or new), and the
// table is exported because it is a CONTRACT: the MCP read surface maps one
// tool per CLI verb (MCP ADR decision 2), and its drift test reads this file.
//
// Every --json result travels in one envelope, {schema_version, verb,
// project, ok, result}, built here and nowhere else — failures included, so
// a consumer always has something to parse. The bare scripts keep their own
// output (`node scripts/doctor.mjs --json` is still a bare array — the
// command files and the tests depend on it). Exit codes: 0 ok, 1 findings or
// a refusal, 2 usage or an internal failure, 3 not bound.
//
// The gate (distribution ADR decision 6) binds every write verb this bin
// exposes: the install family through install-harness.mjs's own preview and
// confirmation, and `reconcile --write` through the same rule — naming what
// is written (`--only <target>`) is the non-interactive confirmation, a bare
// `--write` asks on a terminal and refuses without one. There is no --yes.
//
// The project is resolved once, here — --project, then the neutral
// PROJECTSTORE_PROJECT_DIR, then a project-dir variable a harness declared,
// then cwd — and handed to every child through childEnv(), the one place a
// branded name is written. bin/ reads no branded variable; the portability
// suite greps it too.
//
// The bin runs ITS OWN copy of the core: sibling scripts resolve from this
// file's URL, and the plugin root handed to children and to the installer
// is this package's root — so `npx projectstore doctor` inside a Claude Code
// session runs the npm copy's doctor over the npm copy's templates, and
// reports the npm copy's version, rather than the marketplace copy's.
//
// The install verbs are imported lazily: hooks never import this module
// (the suite asserts it), but the MCP server will, and it needs no installer.
// Pure node, no external deps.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { projectRootDeclared, childEnv, harnessIds, pinPluginRoot } from "./harness.mjs";
import { readConfigAt } from "./lib.mjs";
import { READ_OPERATIONS, LINEAGE_KINDS, LINEAGE_DEFAULT_DEPTH, SEARCH_DEFAULT_LIMIT, GRAPH_EDGE_CAP, DIRECTIONS } from "./query.mjs";
// binding.mjs is a write module imported statically where the install family
// is lazy: it is a dependency-free leaf with no side effects, so the MCP
// server's module graph gains nothing it could trip on.
import { planBind, applyBind, renderBindPlan, bindResult, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";

export const SCHEMA_VERSION = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(HERE);
const script = (name) => resolve(HERE, name);

export function packageVersion() {
  try { return String(JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")).version || ""); } catch { return ""; }
}

export function envelope(verb, project, ok, result) {
  return { schema_version: SCHEMA_VERSION, verb, project, ok, result };
}

// --project, then the neutral variable (MCP ADR decision 6), then a
// project-dir variable a harness declared (null when none is set — never
// cwd-by-inference from harness.mjs, which is what an in-process caller with
// its own cwd would otherwise inherit), then the caller's cwd.
export function resolveProject({ project = null, env = process.env, cwd = process.cwd() } = {}) {
  if (project) return resolve(cwd, project);
  if (env.PROJECTSTORE_PROJECT_DIR) return resolve(cwd, env.PROJECTSTORE_PROJECT_DIR);
  const declared = projectRootDeclared(env);
  return declared ? resolve(cwd, declared) : resolve(cwd);
}

// ─── The verb table ────────────────────────────────────────────────────
//
// wraps: "script" (spawned), "module" (imported), "new" (code that exists
// only for the CLI). output: "envelope" (--json wraps), "text". mcp: the MCP
// tools that mirror the verb (MCP ADR decision 2), empty when none.

const opt = (name, arg, summary, multiple = false) => Object.freeze({ name, arg, summary, multiple });
const JSON_OPT = opt("json", false, "the envelope");
const READ_JSON = [JSON_OPT];
const INSTALL_OPTS = [opt("harness", "<id>", "the harness — and, non-interactively, the confirmation; there is no --yes", true), opt("surface", "<key>", "one surface and those beneath it", true), JSON_OPT];

export const VERBS = Object.freeze([
  Object.freeze({
    verb: "doctor", summary: "Check the install wiring and the vault's consistency.",
    module: "./doctor.mjs", wraps: "script", how: "spawn", output: "envelope", writes: false, requiresBinding: false, mcp: Object.freeze(["doctor"]),
    options: [opt("install", false, "only the install section"), opt("vault", false, "only the vault section"), JSON_OPT],
    run: runDoctor,
  }),
  Object.freeze({
    verb: "reconcile", summary: "Regenerate the derived views (kanban, code map, graph, indexes).",
    module: "./reconcile.mjs", wraps: "module", how: "import", output: "envelope", writes: true, requiresBinding: true, mcp: Object.freeze([]),
    options: [opt("write", false, "apply the regeneration (asks on a terminal; --only names what is written and confirms headless)"), opt("only", "<target>", "one derived view"), JSON_OPT],
    run: runReconcile,
  }),
  Object.freeze({
    verb: "plan", summary: "Show what install would write for a harness, without writing.",
    module: "./install-harness.mjs", wraps: "module", how: "import", output: "envelope", writes: false, requiresBinding: false, mcp: Object.freeze([]),
    options: INSTALL_OPTS, run: runInstallVerb,
  }),
  Object.freeze({
    verb: "install", summary: "Install projectstore's surfaces for a harness, behind a preview.",
    module: "./install-harness.mjs", wraps: "module", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: INSTALL_OPTS, run: runInstallVerb,
  }),
  Object.freeze({
    verb: "uninstall", summary: "Remove what install wrote, and only that.",
    module: "./install-harness.mjs", wraps: "module", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: INSTALL_OPTS, run: runInstallVerb,
  }),
  Object.freeze({
    verb: "upgrade", summary: "Re-run install after a plugin update; prunes what is no longer produced.",
    module: "./install-harness.mjs", wraps: "module", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: INSTALL_OPTS, run: runInstallVerb,
  }),
  Object.freeze({
    verb: "status", summary: "The binding, what is in progress, and whether the derived views are fresh.",
    module: "./query.mjs", wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: false, mcp: Object.freeze(["status"]),
    options: READ_JSON, run: runRead("status"),
  }),
  Object.freeze({
    verb: "orientation", summary: "The SessionStart skeleton and the facts behind it.",
    module: "./query.mjs", wraps: "module", how: "import", output: "envelope", writes: false, requiresBinding: true, mcp: Object.freeze(["orientation"]),
    options: READ_JSON, run: runRead("orientation"),
  }),
  Object.freeze({
    verb: "search", summary: "Find a phrase in the vault's artifacts — deterministic, bounded, no shell.",
    module: "./query.mjs", wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: true, mcp: Object.freeze(["search"]),
    options: [opt("kind", "<type>", "only artifacts of this kind", true), opt("status", "<status>", "only artifacts in this status"), opt("limit", "<n>", `at most n matches (default ${SEARCH_DEFAULT_LIMIT}, hard cap 100)`), opt("include-derived", false, "search the derived views too"), opt("case-sensitive", false, "match case"), JSON_OPT],
    run: runRead("search"),
  }),
  Object.freeze({
    verb: "show", summary: "One artifact: its frontmatter, and its body or one section on request.",
    module: "./query.mjs", wraps: "module", how: "import", output: "envelope", writes: false, requiresBinding: true, mcp: Object.freeze(["get_artifact"]),
    options: [opt("body", false, "include the body"), opt("section", "<id>", "one section by its registry id (description, acceptance, …)"), JSON_OPT],
    run: runRead("show"),
  }),
  Object.freeze({
    verb: "graph", summary: "graph neighbors <path> | graph lineage <path> — the live link graph by vault path.",
    module: "./query.mjs", wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: true, mcp: Object.freeze(["neighbors", "lineage"]),
    options: [opt("kind", "<edge-kind>", "only edges of this kind (lineage: one of its four)", true), opt("direction", DIRECTIONS.join("|"), "neighbors: which edges"), opt("depth", "<n>", `lineage: how far (default ${LINEAGE_DEFAULT_DEPTH})`), opt("limit", "<n>", `neighbors: cap per direction (≤ ${GRAPH_EDGE_CAP})`), JSON_OPT],
    run: runGraph,
  }),
  Object.freeze({
    verb: "codemap", summary: "codemap --for <selector> — which code an epic or artifact maps to, or which artifacts map to a path.",
    module: "./query.mjs", wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: true, mcp: Object.freeze(["code_refs"]),
    options: [opt("for", "<selector>", "an epic id, an artifact, or a repo path"), opt("reverse", false, "read the selector as a path even if it names an artifact"), JSON_OPT],
    run: runCodemap,
  }),
  Object.freeze({
    verb: "bind", summary: "bind <vault> — bind this project to an existing vault (naming the vault is the confirmation).",
    module: "./binding.mjs", wraps: "new", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: [opt("layout", "<name>", `the layout (default ${DEFAULT_LAYOUT})`), opt("language", "<code>", `the template language (default ${DEFAULT_LANGUAGE})`), opt("rebind", false, "point an already bound project at another vault; every other setting is kept"), JSON_OPT],
    run: runBind(false),
  }),
  Object.freeze({
    verb: "init", summary: "init <vault> — create the vault directory and bind to it; the layout's folders come from /projectstore:scaffold.",
    module: "./binding.mjs", wraps: "new", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: [opt("layout", "<name>", `the layout (default ${DEFAULT_LAYOUT})`), opt("language", "<code>", `the template language (default ${DEFAULT_LANGUAGE})`), opt("rebind", false, "an already bound project: create the new vault and point the project at it; every other setting is kept"), JSON_OPT],
    run: runBind(true),
  }),
  Object.freeze({
    verb: "version", summary: "Print the package version (also --version).",
    module: null, wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: false, mcp: Object.freeze([]),
    options: [JSON_OPT], run: runVersion,
  }),
]);

// Verbs the story names that land with a later slice — listed so
// `projectstore <verb>` says where instead of "unknown verb". Only `mcp`
// remains (roadmap A7).
export const PLANNED_VERBS = Object.freeze([
  Object.freeze({ verb: "mcp", wraps: "new", mcp: Object.freeze([]), lands: "A7" }),
]);

export function usage() {
  const lines = ["usage: projectstore <verb> [options] [--project <dir>] [--json]", "", "verbs:"];
  for (const v of VERBS) {
    lines.push(`  ${v.verb.padEnd(11)} ${v.summary}`);
    for (const o of v.options) lines.push(`    --${o.name}${o.arg ? " " + o.arg : ""}${o.multiple ? " (repeatable)" : ""}  ${o.summary}`);
  }
  lines.push("", `  planned: ${PLANNED_VERBS.map((v) => `${v.verb} (${v.lands})`).join(", ")}`, "", `  harnesses: ${harnessIds().join(", ")}`, "  --version  print the package version", "  exit codes: 0 ok, 1 findings or refusal, 2 usage, 3 not bound");
  return lines.join("\n");
}

// ─── run ───────────────────────────────────────────────────────────────

export async function run(argv, { env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, ask = null } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
        harness: { type: "string", multiple: true }, surface: { type: "string", multiple: true },
        write: { type: "boolean" }, only: { type: "string" }, install: { type: "boolean" }, vault: { type: "boolean" },
        kind: { type: "string", multiple: true }, status: { type: "string" }, limit: { type: "string" }, "include-derived": { type: "boolean" }, "case-sensitive": { type: "boolean" },
        body: { type: "boolean" }, section: { type: "string" }, direction: { type: "string" }, depth: { type: "string" }, for: { type: "string" }, reverse: { type: "boolean" },
        layout: { type: "string" }, language: { type: "string" }, rebind: { type: "boolean" },
      },
    });
  } catch (e) {
    stderr.write(`${e.message}\n${usage()}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  // In-process reads resolve layouts and registries from THIS package, as the
  // children already do through ownEnv — not from whichever copy the host
  // session's variable points at.
  pinPluginRoot(PACKAGE_ROOT);
  if (values.version) return runVersion({ values, stdout });
  if (values.help || !positionals.length) { (values.help ? stdout : stderr).write(usage() + "\n"); return values.help ? 0 : 2; }
  const verb = positionals[0];
  const row = VERBS.find((v) => v.verb === verb);
  if (!row) {
    const planned = PLANNED_VERBS.find((v) => v.verb === verb);
    stderr.write((planned ? `${verb} lands with roadmap ${planned.lands}; not in this release.\n` : `unknown verb: ${verb}\n`) + usage() + "\n");
    return 2;
  }
  // The options map is global (parseArgs), the rows are not: an option a row
  // does not declare is a usage error, so help cannot lie about what a verb
  // takes.
  const GLOBAL = new Set(["project", "json", "help", "version"]);
  const declared = new Set(row.options.map((o) => o.name));
  const stray = Object.keys(values).filter((k) => !GLOBAL.has(k) && !declared.has(k));
  if (stray.length) { stderr.write(`${verb} does not take --${stray[0]}\n${usage()}\n`); return 2; }
  const project = resolveProject({ project: values.project, env, cwd });
  const cfg = readConfigAt(project);
  if (row.requiresBinding && !cfg) {
    stderr.write(`${project} is not bound to a vault — run /projectstore:bind <vault> in a session , or \`projectstore bind <vault>\` (\`projectstore init <vault>\` also creates the vault).\n`);
    return 3;
  }
  try {
    return await row.run({ row, values, positionals: positionals.slice(1), cfg, project, env, cwd, stdin, stdout, stderr, ask });
  } catch (e) {
    // An internal failure is not "findings" (1) — it is 2, with an envelope
    // when one was asked for.
    const msg = e && e.message ? e.message : String(e);
    if (values.json) stdout.write(JSON.stringify(envelope(verb, project, false, { error: msg }), null, 2) + "\n");
    stderr.write(`${verb} failed: ${msg}\n`);
    return 2;
  }
}

// The environment a child or the installer runs in: the resolved project and
// THIS package as the plugin root, so the bin never answers for a sibling
// copy of the core.
function ownEnv(env, project) {
  return childEnv(env, { projectRoot: project, pluginRoot: PACKAGE_ROOT });
}

// The one interactive question every write verb asks when nothing named the
// write. Streams and `ask` are parameters so it is testable without a tty.
async function confirmWrite(question, { stdin, stdout, ask }) {
  if (ask) return /^y(es)?$/i.test(String(await ask(question)).trim());
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) return null; // no terminal: refuse
  const rl = createInterface({ input: stdin, output: stdout });
  try { return /^y(es)?$/i.test(String(await rl.question(question)).trim()); } finally { rl.close(); }
}

// ─── verbs ─────────────────────────────────────────────────────────────

// The read verbs: one call into query.mjs, the result in the envelope or
// rendered. A usage error from the operation (a bad path, a missing query)
// is exit 2 with the message, never a stack trace.
function emitRead({ verb, values, project, stdout }, op, result, ok = true) {
  if (values.json) stdout.write(JSON.stringify(envelope(verb, project, ok, result), null, 2) + "\n");
  else stdout.write(op.render(result));
  return ok ? 0 : 1;
}

function usageFail(e, { verb, values, project, stdout, stderr }) {
  if (values.json) stdout.write(JSON.stringify(envelope(verb, project, false, { error: e.message }), null, 2) + "\n");
  stderr.write(`${verb}: ${e.message}\n`);
  return 2;
}

function runRead(name) {
  return async (ctx) => {
    const { row, values, positionals, cfg, project } = ctx;
    const op = READ_OPERATIONS[name];
    try {
      let result;
      if (name === "status") result = op.fn(cfg, { project });
      else if (name === "orientation") result = await op.fn(cfg);
      else if (name === "search") result = op.fn(cfg, positionals.join(" "), { kinds: values.kind || null, status: values.status ?? null, limit: values.limit, includeDerived: Boolean(values["include-derived"]), caseSensitive: Boolean(values["case-sensitive"]) });
      else if (name === "show") result = op.fn(cfg, positionals[0], { body: Boolean(values.body), section: values.section ?? null });
      return emitRead({ verb: row.verb, ...ctx }, op, result);
    } catch (e) {
      if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
      throw e;
    }
  };
}

// bind / init: the vault named on the command line is the confirmation (the
// distribution ADR's decision 6 read for a binding — there is no --yes and
// nothing to ask); a change of vault needs --rebind. Exit 1 on a refusal with
// the reason, 2 on usage, 0 when already bound to the same vault.
// git's user.name for a fresh config's default_author, from the project's
// own repository — never from the process cwd; the login name otherwise.
function gitAuthor(project, env) {
  if (existsSync(project)) {
    try {
      const r = spawnSync("git", ["config", "--get", "user.name"], { cwd: project, encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {}
  }
  return env.USER || env.USERNAME || "";
}

function runBind(init) {
  return async (ctx) => {
    const { row, values, positionals, project, env, stdout, stderr } = ctx;
    const vault = positionals[0];
    if (!vault) return usageFail(Object.assign(new Error(`${row.verb} takes the vault path`), { code: "USAGE" }), { verb: row.verb, ...ctx });
    // The author is the caller's to find: the plan reads nothing ambient.
    const plan = planBind(project, { vault, layout: values.layout ?? null, language: values.language ?? null, rebind: Boolean(values.rebind), init, author: gitAuthor(project, env), env });
    const usage = plan.refusals.find((r) => r.code === "USAGE");
    if (usage) return usageFail(Object.assign(new Error(usage.message), { code: "USAGE" }), { verb: row.verb, ...ctx });
    let done = null;
    if (plan.ok && plan.writes) done = applyBind(plan);
    const result = bindResult(plan, done);
    if (values.json) stdout.write(JSON.stringify(envelope(row.verb, project, plan.ok, result), null, 2) + "\n");
    else (plan.ok ? stdout : stderr).write(renderBindPlan(plan, done));
    return plan.ok ? 0 : 1;
  };
}

async function runGraph(ctx) {
  const { row, values, positionals, cfg } = ctx;
  const sub = positionals[0];
  const path = positionals[1];
  if (!["neighbors", "lineage"].includes(sub)) return usageFail(Object.assign(new Error("graph takes neighbors <path> or lineage <path>"), { code: "USAGE" }), { verb: row.verb, ...ctx });
  const op = READ_OPERATIONS[sub];
  try {
    // The row declares the union; each mode takes its own — an option the
    // mode would ignore is a usage error, not a silent no-op.
    const notFor = sub === "neighbors" ? ["depth"] : ["direction", "limit"];
    for (const o of notFor) if (values[o] !== undefined) throw Object.assign(new Error(`--${o} is not an option of graph ${sub}`), { code: "USAGE" });
    const result = sub === "neighbors"
      ? op.fn(cfg, path, { kinds: values.kind || null, direction: values.direction, limit: values.limit })
      : op.fn(cfg, path, { depth: values.depth, kinds: values.kind && values.kind.length ? values.kind : LINEAGE_KINDS });
    return emitRead({ verb: `graph ${sub}`, ...ctx }, op, result);
  } catch (e) {
    if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
    throw e;
  }
}

async function runCodemap(ctx) {
  const { row, values, cfg } = ctx;
  const op = READ_OPERATIONS.codeRefs;
  try {
    if (!values.for) throw Object.assign(new Error("codemap takes --for <selector>; regeneration is reconcile --only codemap"), { code: "USAGE" });
    return emitRead({ verb: row.verb, ...ctx }, op, op.fn(cfg, values.for, { reverse: Boolean(values.reverse) }));
  } catch (e) {
    if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
    throw e;
  }
}

function runVersion({ values, stdout }) {
  const version = packageVersion();
  stdout.write(values.json ? JSON.stringify(envelope("version", null, true, { version }), null, 2) + "\n" : version + "\n");
  return 0;
}

function spawnDoctor(project, env, flags) {
  // A project that does not exist is still a project doctor can report on
  // ("not bound") — so the cwd is only set when it can be.
  return spawnSync(process.execPath, [script("doctor.mjs"), ...flags], { encoding: "utf8", cwd: existsSync(project) ? project : undefined, env: ownEnv(env, project), timeout: 60000, maxBuffer: 1 << 24 });
}

// Spawned, never imported (MCP ADR decision 2): doctor's report and main are
// not exported, and importing them would be a second doctor. doctor.mjs sets
// no exit code of its own and prints either JSON or text, so text mode is
// two spawns — one for the findings that decide the exit code, one for the
// report the user reads. Deliberate; do not "optimise" the second away
// without giving doctor an exit code first.
async function runDoctor({ values, project, env, stdout, stderr }) {
  const sections = [values.install && "--install", values.vault && "--vault"].filter(Boolean);
  const r = spawnDoctor(project, env, ["--json", ...sections]);
  const fail = (why) => {
    if (values.json) stdout.write(JSON.stringify(envelope("doctor", project, false, { error: why }), null, 2) + "\n");
    stderr.write(`doctor failed: ${why}\n`);
    return 2;
  };
  if (r.error) return fail(r.error.message);
  if (r.status !== 0 && !r.stdout) return fail((r.stderr || "").trim() || `exit ${r.status}`);
  let findings;
  try { findings = JSON.parse(r.stdout); } catch { return fail("unparseable output"); }
  const ok = !findings.some((f) => f.level === "issue");
  if (values.json) stdout.write(JSON.stringify(envelope("doctor", project, ok, findings), null, 2) + "\n");
  else {
    const t = spawnDoctor(project, env, sections);
    stdout.write(typeof t.stdout === "string" && t.stdout ? t.stdout : `${(t.stderr || "").trim() || "doctor printed nothing"}\n`);
  }
  return ok ? 0 : 1;
}

async function runReconcile({ values, project, env, stdin, stdout, stderr, ask }) {
  const write = Boolean(values.write);
  const only = values.only ?? null;
  // The gate: --only names what is written and confirms headless; a bare
  // --write asks on a terminal and refuses without one.
  if (write && !only) {
    const yes = await confirmWrite(`Regenerate every derived view of ${project}'s vault? [y/N] `, { stdin, stdout, ask });
    if (yes === null) {
      stderr.write("a bare reconcile --write in a non-TTY refuses; name what is written to confirm: --only <target>\n");
      if (values.json) stdout.write(JSON.stringify(envelope("reconcile", project, false, { refused: "non-tty" }), null, 2) + "\n");
      return 1;
    }
    if (!yes) { stdout.write("nothing written.\n"); return 0; }
  }
  const { runReconcile: core } = await import("./reconcile.mjs");
  let out;
  try {
    out = core({ write, only, projectDir: project, env: ownEnv(env, project) });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    stderr.write(msg + "\n");
    if (values.json) stdout.write(JSON.stringify(envelope("reconcile", project, false, { error: msg }), null, 2) + "\n");
    return e && e.code === "UNBOUND" ? 3 : 2;
  }
  const failed = write && out.summary && out.summary.failed > 0;
  stdout.write(JSON.stringify(values.json ? envelope("reconcile", project, !failed, out) : out, null, 2) + "\n");
  return failed ? 1 : 0;
}

async function runInstallVerb({ row, values, project, env, stdin, stdout, ask }) {
  const ih = await import("./install-harness.mjs");
  const opts = { harnesses: values.harness || [], surfaces: values.surface && values.surface.length ? values.surface : null, root: PACKAGE_ROOT, env: ownEnv(env, project), stdin, stdout, ask };
  if (row.verb === "plan") {
    const p = ih.plan(project, opts);
    stdout.write(values.json ? JSON.stringify(envelope("plan", project, p.ok, { ...p, items: p.items.map(ih.publicItem) }), null, 2) + "\n" : ih.renderPreview(p));
    return p.ok ? 0 : 1;
  }
  const r = await ih.runVerb(row.verb, project, opts);
  const ok = r.plan.ok && (r.gate.confirmed || r.gate.why === "nothing-to-do");
  if (values.json) {
    stdout.write(JSON.stringify(envelope(row.verb, project, ok, { gate: r.gate, applied: r.applied, items: r.plan.items.map(ih.publicItem), refusals: r.plan.refusals, reports: r.plan.reports }), null, 2) + "\n");
  } else {
    stdout.write(r.preview);
    if (r.gate.confirmed) stdout.write(`applied ${r.applied.length} change(s).\n`);
    else if (r.gate.why === "non-tty") stdout.write(`a bare ${row.verb} in a non-TTY refuses; name a harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`);
    else if (r.gate.why === "declined") stdout.write("nothing written.\n");
  }
  return ok ? 0 : 1;
}

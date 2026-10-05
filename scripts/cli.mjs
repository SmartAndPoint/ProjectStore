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
import * as term from "./term.mjs";
import { projectRootDeclared, childEnv, harnessIds, harnessForOverlay, pinPluginRoot } from "./harness.mjs";
import { readConfigAt, readOverlayAt, resolveAgentModel, writeOverlayAt, overlayId, layoutRoster } from "./lib.mjs";
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
const HARNESS_OPT = opt("harness", "<id>", "the harness — and, without a terminal, the confirmation (a terminal is asked); there is no --yes", true);
const SURFACE_OPT = opt("surface", "<key>", "one surface and those beneath it", true);
// The layout move's remedy names this for any copy but the package's own
// registration (the layout spec, contract 12 as amended 2026-10-03): it makes
// "no host command" true by construction instead of by recognising the root.
const NO_REGISTER_OPT = opt("no-register", false, "leave the plugin registration alone: change only this project's files");
const VERBOSE_OPT = opt("verbose", false, "every row's reasoning, each step's why and the host's own notes");
const INSTALL_OPTS = [HARNESS_OPT, SURFACE_OPT, NO_REGISTER_OPT, VERBOSE_OPT, JSON_OPT];
const UNINSTALL_OPTS = [HARNESS_OPT, SURFACE_OPT, opt("global", false, "also remove the harness-global plugin registration"), VERBOSE_OPT, JSON_OPT];

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
    options: UNINSTALL_OPTS, run: runInstallVerb,
  }),
  Object.freeze({
    verb: "upgrade", summary: "Re-run install after a plugin update; re-stamps what this installation wrote and leaves the rest.",
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
    verb: "agents", summary: "agents model <name> | agents show | agents configure — the harness overlay's agents block (ADR-008, read per invocation).",
    module: "./lib.mjs", wraps: "new", how: "import", output: "envelope", writes: true, requiresBinding: false, mcp: Object.freeze([]),
    options: [opt("harness", "<id>", "configure: the overlay to write — and, non-interactively, the confirmation; there is no --yes", true), opt("default", "<model>", "configure: agents.default.model (pins the clerk to sonnet unless --agent clerk=… says otherwise; an empty model clears it)"), opt("agent", "<name>=<model>", "configure: agents.per_agent.<name>.model (an empty model removes the key)", true), opt("reset", false, "configure: empty the agents block first; --default and --agent given with it apply on top"), JSON_OPT],
    run: runAgents,
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
    verb: "mcp", summary: "Serve the read tools over MCP (stdio) for the project named by --project or PROJECTSTORE_PROJECT_DIR; never the ambient cwd.",
    module: "./mcp.mjs", wraps: "new", how: "import", output: "text", writes: false, requiresBinding: false, mcp: Object.freeze([]),
    options: [], run: runMcp,
  }),
  Object.freeze({
    verb: "version", summary: "Print the package version (also --version).",
    module: null, wraps: "new", how: "import", output: "envelope", writes: false, requiresBinding: false, mcp: Object.freeze([]),
    options: [JSON_OPT], run: runVersion,
  }),
]);

// Verbs the story names that land with a later slice — listed so
// `projectstore <verb>` says where instead of "unknown verb". Empty since
// A7: every verb the CLI story names has landed. The seam stays for the next
// story that adds a verb in slices.
export const PLANNED_VERBS = Object.freeze([]);

// The verbs as a person meets them: setting a project up, reading the vault,
// keeping it consistent, serving it. A verb not listed lands in "Other", so a
// new row is never hidden by this table.
const HELP_GROUPS = [
  ["Set up", ["install", "upgrade", "uninstall", "plan", "bind", "init", "agents"]],
  ["Read", ["status", "search", "show", "graph", "codemap", "orientation"]],
  ["Check and repair", ["doctor", "reconcile"]],
  ["Serve", ["mcp", "version"]],
];

// Examples per verb. `{cmd}` is how this run was invoked (a shell's own name
// when PROJECTSTORE_SHELL says so, else the core — a shell passes the read
// verbs through, so its name serves them too), `{h}` the harness argument the
// core needs and a shell fixes.
const EXAMPLES = {
  install: ["{cmd} install{h}", "{cmd} plan{h}  # the same plan; nothing is written"],
  upgrade: ["{cmd}@<version> upgrade{h}  # the version you name is the version that runs", "{cmd} upgrade{h} --verbose"],
  uninstall: ["{cmd} uninstall{h}", "{cmd} uninstall{h} --surface statusline"],
  plan: ["{cmd} plan{h}", "{cmd} plan{h} --json  # one envelope, for scripts and agents"],
  status: ["{cmd} status", "{cmd} status --json"],
  orientation: ["{cmd} orientation --json"],
  search: ['{cmd} search "entry rule" --kind spec', "{cmd} search queue --status accepted --limit 5"],
  show: ["{cmd} show adr/README.md", "{cmd} show epics/PS-CORE/epic.md --section acceptance"],
  graph: ["{cmd} graph neighbors adr/README.md --direction out", "{cmd} graph lineage epics/PS-CORE/epic.md --depth 2"],
  codemap: ["{cmd} codemap --for PS-CORE", "{cmd} codemap --for scripts/lib.mjs --reverse"],
  doctor: ["{cmd} doctor", "{cmd} doctor --install --json"],
  reconcile: ["{cmd} reconcile  # what would change; nothing is written", "{cmd} reconcile --write"],
  bind: ["{cmd} bind ~/vaults/my-project", "{cmd} bind ~/vaults/other --rebind"],
  init: ["{cmd} init ~/vaults/new-project --language ru"],
  agents: ["{cmd} agents show", "{cmd} agents configure{h} --default opus --agent clerk=sonnet"],
  mcp: ['{cmd} mcp --project "$PWD"'],
};

// Positional arguments a summary does not already name.
const ARGS = { search: "<phrase>", show: "<path>" };

// "bind <vault> — bind this project…" names its own form; "graph neighbors
// <path> | graph lineage <path> — …" names two.
function forms(row) {
  const m = /^(.+?) — (.+)$/.exec(row.summary);
  if (m && m[1].startsWith(row.verb + " ")) {
    const list = m[1].split(" | ").map((f) => f.replace(new RegExp(`^${row.verb} `), ""));
    return { forms: list, about: m[2][0].toUpperCase() + m[2].slice(1) };
  }
  return { forms: [ARGS[row.verb] || ""], about: row.summary };
}

function invocation(env = process.env) {
  const shell = env.PROJECTSTORE_SHELL || null;
  return { shell, cmd: shell ? `npx ${shell}` : "npx projectstore" };
}

function optionLines(options) {
  const rows = options.map((o) => [`--${o.name}${o.arg ? " " + o.arg : ""}`, `${o.summary}${o.multiple ? " (repeatable)" : ""}`]);
  const w = Math.min(28, Math.max(0, ...rows.map(([l]) => l.length)));
  return rows.map(([l, r]) => (l.length > w ? `  ${l}\n  ${" ".repeat(w)}  ${r}` : `  ${l.padEnd(w)}  ${r}`));
}

const EXIT_CODES = "Exit codes  0 ok · 1 findings or a refusal · 2 usage · 3 not bound";

export function usage(env = process.env) {
  const { cmd } = invocation(env);
  const lines = [
    "projectstore — project memory for coding agents: decisions, specs, epics and stories as plain markdown.",
    "",
    "Usage",
    `  ${cmd} <verb> [options]`,
    `  ${cmd} <verb> --help       one verb's options and examples`,
  ];
  const seen = new Set();
  const groups = HELP_GROUPS.map(([title, names]) => [title, names.map((n) => VERBS.find((v) => v.verb === n)).filter(Boolean)]);
  for (const [, rows] of groups) for (const r of rows) seen.add(r.verb);
  const other = VERBS.filter((v) => !seen.has(v.verb));
  if (other.length) groups.push(["Other", other]);
  for (const [title, rows] of groups) {
    if (!rows.length) continue;
    lines.push("", title);
    for (const v of rows) lines.push(`  ${v.verb.padEnd(12)} ${v.summary}`);
  }
  if (PLANNED_VERBS.length) lines.push("", `Planned: ${PLANNED_VERBS.map((v) => `${v.verb} (${v.lands})`).join(", ")}`);
  lines.push(
    "",
    "Every verb",
    "  --project <dir>  the project (default: the host session's project, else the current directory)",
    "  --json           one envelope { schema_version, verb, project, ok, result } — for scripts and agents",
    "  --version        the package version",
    "",
    "Tips",
    "  install, upgrade and uninstall show their plan first; `plan` prints the same plan and writes nothing.",
    "  At a terminal they ask before writing. Without one, --harness is the confirmation — there is no --yes.",
    "  Unattended in a terminal (a script, a Makefile): pass --json, set CI=1, or give stdin no terminal (`</dev/null`).",
    "  --verbose on those verbs adds every row's reasoning and the host's own notes.",
    "",
    `Harnesses   ${harnessIds().join(", ")}`,
    EXIT_CODES,
  );
  return lines.join("\n");
}

// One verb: what it does, how to call it, every option, examples.
export function verbHelp(row, env = process.env) {
  const { shell, cmd } = invocation(env);
  const fixed = Boolean(shell) && row.options.some((o) => o.name === "harness");
  const opts = row.options.filter((o) => !(fixed && o.name === "harness"));
  const { forms: list, about } = forms(row);
  const lines = [`${cmd} ${row.verb} — ${about}`, "", "Usage"];
  for (const f of list) lines.push(`  ${cmd} ${row.verb}${f ? " " + f : ""}${opts.length ? " [options]" : ""}`);
  if (opts.length) lines.push("", "Options", ...optionLines(opts));
  if (fixed) lines.push("", `${shell} names the harness itself: without a terminal, the verb is its own confirmation.`);
  else if (row.options.some((o) => o.name === "harness")) lines.push("", `Harnesses   ${harnessIds().join(", ")}`);
  const ex = EXAMPLES[row.verb] || [];
  const h = fixed ? "" : " --harness <id>";
  const rendered = ex.map((e) => e.split("{cmd}").join(cmd).split("{h}").join(h).split("  # "));
  const col = Math.max(0, ...rendered.filter((r) => r.length > 1).map(([c]) => c.length));
  if (ex.length) lines.push("", "Examples", ...rendered.map(([c, note]) => `  ${note ? `${c.padEnd(col)}   # ${note}` : c}`));
  lines.push("", EXIT_CODES);
  return lines.join("\n");
}

// The nearest name within two edits — for a mistyped verb or option.
export function nearest(word, names) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  let best = null, score = 3;
  for (const n of names) {
    const k = n.startsWith(word) && word.length >= 3 ? 0 : d(word, n);
    if (k < score) { best = n; score = k; }
  }
  return best;
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
        harness: { type: "string", multiple: true }, surface: { type: "string", multiple: true }, global: { type: "boolean" }, "no-register": { type: "boolean" }, verbose: { type: "boolean" },
        write: { type: "boolean" }, only: { type: "string" }, install: { type: "boolean" }, vault: { type: "boolean" },
        kind: { type: "string", multiple: true }, status: { type: "string" }, limit: { type: "string" }, "include-derived": { type: "boolean" }, "case-sensitive": { type: "boolean" },
        body: { type: "boolean" }, section: { type: "string" }, direction: { type: "string" }, depth: { type: "string" }, for: { type: "string" }, reverse: { type: "boolean" },
        layout: { type: "string" }, language: { type: "string" }, rebind: { type: "boolean" },
        default: { type: "string" }, agent: { type: "string", multiple: true }, reset: { type: "boolean" },
      },
    });
  } catch (e) {
    // --json cannot be known before parsing; a raw scan is enough here.
    if (argv.includes("--json")) stdout.write(JSON.stringify(envelope(argv.find((a) => !a.startsWith("-")) || null, null, false, { error: e.message }), null, 2) + "\n");
    // Node's own wording for an unknown option explains "--" positionals; a
    // person who typed --verbos wants the option they meant.
    const unknown = e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'(-{1,2}[^']+)'/.exec(e.message)?.[1] : null;
    const row = VERBS.find((v) => v.verb === argv.find((a) => !a.startsWith("-")));
    const names = [...(row ? row.options.map((o) => o.name) : VERBS.flatMap((v) => v.options.map((o) => o.name))), "project", "json", "help", "version"];
    const hint = unknown ? nearest(unknown.replace(/^-+/, ""), [...new Set(names)]) : null;
    const message = unknown ? `${row ? row.verb + " does not take" : "unknown option"} ${unknown}${hint ? ` — did you mean --${hint}?` : ""}` : e.message;
    stderr.write(`${message}\nRun ${row ? `\`${row.verb} --help\`` : "--help"} for the options.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  // A failure before a verb runs still answers in the envelope under --json:
  // a consumer (the MCP server, a script) always has something to parse.
  const fail = (verb, project, message, code, { help = false } = {}) => {
    if (values.json) stdout.write(JSON.stringify(envelope(verb, project, false, { error: message, exit: code }), null, 2) + "\n");
    stderr.write(message + "\n" + (help ? usage(env) + "\n" : ""));
    return code;
  };
  // In-process reads resolve layouts and registries from THIS package, as the
  // children already do through ownEnv — not from whichever copy the host
  // session's variable points at.
  pinPluginRoot(PACKAGE_ROOT);
  if (values.version) return runVersion({ values, stdout });
  if (values.help && positionals.length) {
    const row = VERBS.find((v) => v.verb === positionals[0]);
    if (row) { stdout.write(verbHelp(row, env) + "\n"); return 0; }
  }
  if (values.help || !positionals.length) { (values.help ? stdout : stderr).write(usage(env) + "\n"); return values.help ? 0 : 2; }
  const verb = positionals[0];
  const row = VERBS.find((v) => v.verb === verb);
  if (!row) {
    const planned = PLANNED_VERBS.find((v) => v.verb === verb);
    const guess = planned ? null : nearest(verb, VERBS.map((v) => v.verb));
    if (guess) return fail(verb, null, `unknown verb: ${verb} — did you mean ${guess}?\nRun --help for every verb.`, 2);
    return fail(verb, null, (planned ? `${verb} lands with roadmap ${planned.lands}; not in this release.` : `unknown verb: ${verb}`), 2, { help: true });
  }
  // The options map is global (parseArgs), the rows are not: an option a row
  // does not declare is a usage error, so help cannot lie about what a verb
  // takes.
  const GLOBAL = new Set(["project", "json", "help", "version"]);
  const declared = new Set(row.options.map((o) => o.name));
  const stray = Object.keys(values).filter((k) => !GLOBAL.has(k) && !declared.has(k));
  if (stray.length) {
    const guess = nearest(stray[0], row.options.map((o) => o.name));
    return fail(verb, null, `${verb} does not take --${stray[0]}${guess ? ` — did you mean --${guess}?` : ""}\nRun \`${verb} --help\` for the options.`, 2);
  }
  const project = resolveProject({ project: values.project, env, cwd });
  const cfg = readConfigAt(project);
  if (row.requiresBinding && !cfg) return fail(verb, project, `${project} is not bound to a vault — run /projectstore:bind <vault> in a session, or \`projectstore bind <vault>\` (\`projectstore init <vault>\` also creates the vault).`, 3);
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
  // End of input is a no (term.mjs askLine), never a question left pending.
  const answer = await term.askLine(question, stdin, stdout);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
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

// The MCP server, imported lazily like the install family: no other verb
// carries the protocol code. A project must have been SUPPLIED — the flag,
// the neutral variable or the harness's declared directory; resolveProject's
// cwd fallback is exactly what the MCP ADR's decision 6 forbids here.
async function runMcp({ values, project, env, stdin, stdout, stderr }) {
  const supplied = Boolean(values.project || env.PROJECTSTORE_PROJECT_DIR || projectRootDeclared(env));
  const { serve } = await import("./mcp.mjs");
  return serve({ project: supplied ? project : null, env, stdin, stdout, stderr });
}

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

// bind / init: the vault named on the command line is the confirmation (the
// distribution ADR's decision 6 read for a binding — there is no --yes and
// nothing to ask); a change of vault needs --rebind. Exit 1 on a refusal with
// the reason, 2 on usage, 0 when already bound to the same vault.
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

// agents model <name> — the model a plugin surface passes for that agent, from
// the active harness's overlay (ADR-008's two terms); agents show — the overlay
// as read, with the keys the allowlist rejected; agents configure — the one
// writer, behind the same gate as install: naming --harness is the
// confirmation, a bare non-TTY call refuses (layout spec, contracts 2–4).
async function runAgents(ctx) {
  const { row, values, positionals, project, env, stdout, stderr, stdin, ask } = ctx;
  const sub = positionals[0];
  const usage = (m) => usageFail(Object.assign(new Error(m), { code: "USAGE" }), { verb: row.verb, ...ctx });
  if (!["model", "show", "configure"].includes(sub)) return usage("agents takes model <name>, show, or configure");
  // The flag IS the confirmation, so it names exactly one overlay: two are a
  // question, not an answer.
  if (values.harness && values.harness.length > 1) return usage("--harness names exactly one overlay (it is the confirmation); given twice");
  const named = values.harness && values.harness[0];
  if (named && !harnessIds().includes(named)) return usage(`unknown harness: ${named} — known: ${harnessIds().join(", ")}`);
  const harness = named || overlayId(env);
  const forConfigure = ["default", "agent", "reset"].filter((o) => values[o] !== undefined);
  if (sub !== "configure" && forConfigure.length) return usage(`--${forConfigure[0]} is an option of agents configure`);
  // A refusal goes to stderr, as bind's does; --json keeps its envelope on stdout.
  const emit = (verb, ok, result, text) => { if (values.json) stdout.write(JSON.stringify(envelope(verb, project, ok, result), null, 2) + "\n"); else (ok ? stdout : stderr).write(text); return ok ? 0 : 1; };
  const cfg = readConfigAt(project);
  const roster = layoutRoster(cfg);
  if (sub === "model") {
    const name = positionals[1];
    if (!name) return usage("agents model takes the agent's bare name (critic, planner, …)");
    const r = resolveAgentModel(project, name, { harness });
    return emit("agents model", true, r, `${name}: ${r.model ? `${r.model} (${r.source}, ${r.overlay})` : "no model configured — the agent's frontmatter decides"}\n`);
  }
  const before = readOverlayAt(project, harness);
  const inBinding = Boolean(cfg && cfg.agents && typeof cfg.agents === "object");
  if (sub === "show") {
    // Resolved per roster agent (per configured name when no layout loads), so
    // a reader reports what would run without restating the two-term rule.
    const names = [...new Set([...(roster || []), ...Object.keys(before.agents.per_agent)])].sort();
    const resolved = Object.fromEntries(names.map((n) => { const r = resolveAgentModel(project, n, { harness }); return [n, { model: r.model, source: r.source }]; }));
    const unknown = roster ? Object.keys(before.agents.per_agent).filter((n) => !roster.includes(n)) : [];
    const lines = [`overlay: ${before.path || "(none: no harness detected and none named)"}${before.path && !before.present ? " (absent)" : ""}`];
    if (before.unparseable) lines.push("  not valid JSON");
    if (before.agents.default) lines.push(`  default: ${before.agents.default}`);
    for (const n of names) lines.push(`  ${n}: ${resolved[n].model ? `${resolved[n].model} (${resolved[n].source})` : "— (the agent's frontmatter)"}${unknown.includes(n) ? " — not in the roster: nothing runs under this name" : ""}`);
    if (before.rejected.length) lines.push(`  ignored (not an overlay key): ${before.rejected.join(", ")}`);
    if (inBinding) lines.push("  the binding still carries an agents block — a pre-0.28 leftover; run upgrade");
    return emit("agents show", true, { harness, path: before.path, present: before.present, unparseable: before.unparseable, agents: before.agents, resolved, roster, unknown, rejected: before.rejected, agents_in_binding: inBinding }, lines.join("\n") + "\n");
  }
  // configure
  if (!harness) return usage("no harness detected and none named: agents configure names --harness <id>");
  if (before.unparseable) return emit("agents configure", false, { error: `${before.path} is not valid JSON; fix or remove it first`, harness, path: before.path }, `${before.path} is not valid JSON; fix or remove it first\n`);
  if (!values.reset && values.default === undefined && !(values.agent || []).length) return usage("agents configure takes --default <model>, --agent <name>=<model> (repeatable) or --reset");
  // --reset empties the block first; --default and --agent then apply on top of
  // the emptied block — "reset, then set" is one call, and nothing given is
  // silently dropped.
  const base = values.reset ? { default: null, per_agent: {} } : before.agents;
  const next = { default: values.default !== undefined ? (values.default || null) : base.default, per_agent: { ...base.per_agent } };
  for (const spec of values.agent || []) {
    const m = /^([a-z][a-z0-9-]*)=(.*)$/.exec(spec);
    if (!m) return usage(`--agent takes <name>=<model>, got ${spec}`);
    // A name outside the roster would be written, listed, and never run.
    if (roster && !roster.includes(m[1])) return usage(`no agent named ${m[1]} in the ${cfg.layout} roster — known: ${roster.join(", ")}`);
    if (m[2]) next.per_agent[m[1]] = m[2]; else delete next.per_agent[m[1]];
  }
  // The clerk transcribes; a strong default must not lift it (commands/agents.md,
  // ADR-008). WHICH model it is pinned to is the harness's vocabulary, so the
  // manifest names it and this file does not: pinning every harness to
  // "sonnet" wrote an Anthropic model name into a Codex overlay, which is a
  // model that does not exist there. A manifest with no cheap model declared
  // does not pin, and the preview says so rather than inventing one.
  // No fallback model here, deliberately, and it is not the same call as
  // SOURCE_WRITE_TOOLS_FALLBACK: a missing manifest cannot reach this line.
  // harnessIds() derives from the manifests, so with none loadable `--harness`
  // is refused as unknown and `overlayId(env)` is null, and configure has
  // already returned "no harness detected and none named". A literal here would
  // be the deleted `"sonnet"` restored for a case that cannot happen.
  let pinnedClerk = false;
  let clerkPinUnavailable = false;
  const clerkAsked = (values.agent || []).some((s) => s.startsWith("clerk="));
  if (next.default && !next.per_agent.clerk && !clerkAsked) {
    const cheap = harnessForOverlay(harness)?.agent_translation?.cheap_model || null;
    if (cheap) { next.per_agent.clerk = cheap; pinnedClerk = true; }
    else clerkPinUnavailable = true;
  }
  // Keys inside the agents block that the allowlist rejected (an `effort`, a
  // stray shape) are rewritten out by the write and announced here; keys
  // outside the block are kept, and stay doctor's to name.
  const dropped = before.rejected.filter((k) => k.startsWith("agents."));
  const same = !dropped.length && JSON.stringify({ d: before.agents.default, p: before.agents.per_agent }) === JSON.stringify({ d: next.default, p: next.per_agent });
  const preview = [`agents configure — ${harness} — ${before.path}`, `  default: ${before.agents.default || "—"} → ${next.default || "—"}`];
  const names = new Set([...Object.keys(before.agents.per_agent), ...Object.keys(next.per_agent)]);
  for (const n of [...names].sort()) preview.push(`  ${n}: ${before.agents.per_agent[n] || "—"} → ${next.per_agent[n] || "—"}${pinnedClerk && n === "clerk" ? " (pinned: the clerk stays cheap under a strong default)" : ""}`);
  // Silence here would read as "the clerk is fine", and it is not: it takes the
  // strong default, which is the one thing ADR-008 says must not happen to it.
  if (clerkPinUnavailable) preview.push(`  clerk: takes the default — ${harness} declares no cheap model to pin it to, so name one with --agent clerk=<model>`);
  if (dropped.length) preview.push(`  drops from the agents block (an overlay carries only models): ${dropped.join(", ")}`);
  if (same) return emit("agents configure", true, { harness, path: before.path, wrote: false, agents: next, pinnedClerk, clerkPinUnavailable, dropped }, preview.join("\n") + "\n  Nothing to change.\n");
  // The gate: a named harness confirms; otherwise ask, and refuse without a terminal.
  let confirmed = Boolean(named);
  if (!confirmed) { const a = await confirmWrite(preview.join("\n") + `\nWrite ${before.path}? [y/N] `, { stdin, stdout, ask }); if (a === null) return usage("a non-interactive agents configure names --harness <id> to confirm; there is no --yes"); confirmed = a; }
  if (!confirmed) return emit("agents configure", false, { harness, path: before.path, wrote: false, declined: true, agents: next, dropped }, preview.join("\n") + "\n  nothing written.\n");
  const path = writeOverlayAt(project, harness, next);
  const after = readOverlayAt(project, harness);
  return emit("agents configure", true, { harness, path, wrote: true, agents: after.agents, pinnedClerk, clerkPinUnavailable, dropped, rejected: after.rejected, agents_in_binding: inBinding }, preview.join("\n") + `\n  wrote ${path}.${inBinding ? " The binding still carries an agents block (pre-0.28); run upgrade to move it." : ""}\n`);
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
  const opts = { harnesses: values.harness || [], surfaces: values.surface && values.surface.length ? values.surface : null, globalRemoval: Boolean(values.global), register: !values["no-register"], root: PACKAGE_ROOT, env: ownEnv(env, project), stdin, stdout, ask, json: Boolean(values.json), verbose: Boolean(values.verbose) };
  if (row.verb === "plan") {
    const p = ih.plan(project, opts);
    if (values.json) stdout.write(JSON.stringify(envelope("plan", project, p.ok && !p.incomplete, { ...p, items: p.items.map(ih.publicItem) }), null, 2) + "\n");
    else {
      const c = term.caps(stdout, env);
      stdout.write(ih.renderPreview(p, { verbose: opts.verbose, verb: "plan", paint: term.painter(c), icon: (n) => term.icon(c, n), width: c.live ? c.width : 0 }));
    }
    return p.ok && !p.incomplete ? 0 : 1;
  }
  // Text mode hands runVerb the stream: the plan is printed before any
  // question, then each step, then DONE (install spec contracts 9 and 18).
  const r = await ih.runVerb(row.verb, project, values.json ? opts : { ...opts, out: stdout });
  // A registration the plan could not make (no host CLI) or a host command
  // that failed is exit 1 with the rest applied (install spec contract 4′).
  const ok = r.plan.ok && !r.plan.incomplete && !r.failed && (r.gate.confirmed || r.gate.why === "nothing-to-do");
  if (values.json) {
    stdout.write(JSON.stringify(envelope(row.verb, project, ok, { gate: r.gate, applied: r.applied, failed: r.failed, incomplete: r.plan.incomplete, plannedAgainst: r.plan.plannedAgainst, items: r.plan.items.map(ih.publicItem), refusals: r.plan.refusals, reports: r.plan.reports }), null, 2) + "\n");
  } else if (r.gate.why === "non-tty") {
    stdout.write(`Nothing written: without a terminal, a bare ${row.verb} refuses. Name the harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`);
  } else if (r.gate.why === "declined") {
    stdout.write("Nothing written.\n");
  }
  return ok ? 0 : 1;
}

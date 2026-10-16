// projectstore — verbs.mjs
//
// The verb table and the parse that dispatches through it: the one table the
// CLI (scripts/cli.mjs) and the read-verb runner (scripts/read-verbs.mjs)
// both read, so the MCP read surface maps one tool per CLI verb by
// construction (MCP ADR decisions 1 and 2, as amended by the PS-DIRECTORY
// story "The MCP server's entry reaches no install verb through a read-verb
// runner that shares the CLI's verb table…"). The table is data: each row
// names the module it wraps and how (spawned, imported, or new), never the
// code that runs it. A runner hands dispatch() its own handlers, keyed by
// verb, and a verb outside them is refused. This module loads no module at
// run time — no dynamic import at all, so whatever imports it reaches only
// what it imports statically, which the MCP fence asserts
// (tests/portability.test.mjs).
//
// Every --json result travels in one envelope, {schema_version, verb,
// project, ok, result}, built here and nowhere else — failures included, so
// a consumer always has something to parse. The bare scripts keep their own
// output (`node scripts/doctor.mjs --json` is still a bare array — the
// command files and the tests depend on it). Exit codes: 0 ok, 1 findings or
// a refusal, 2 usage or an internal failure, 3 not bound.
//
// The parse is per verb. A scan finds the verb first, knowing only the
// globals (--project <dir>, --json, --help/-h, --version/-v — the only options
// that may come before it); then one strict parseArgs runs on that verb's row
// plus the globals, so one name can be a flag on one verb and take a value on
// another (`doctor --vault` beside the front-door ADR's `setup --vault
// <path>`). A row's `usage` forms are both its help's Usage lines and the
// bound on its arguments: an argument past the form is a usage error that
// names it, never dropped. Every error raised before a verb runs names the
// verb the scan found, in the envelope and on stderr.
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
// Pure node, no external deps.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as term from "./term.mjs";
import {
  projectRootDeclared,
  childEnv,
  harnessIds,
  pinPluginRoot,
  invokedAs,
  shellHarnessId,
  CORE_NPX,
  packageCommand,
  loadHarnesses,
  invocation,
} from "./harness.mjs";
import { readConfigAt, commandForm, fromTerminalIn } from "./lib.mjs";
import { LINEAGE_DEFAULT_DEPTH, SEARCH_DEFAULT_LIMIT, GRAPH_EDGE_CAP, DIRECTIONS } from "./query.mjs";
// The binding defaults name a new vault's layout and language in setup's,
// bind's and init's option summaries. binding.mjs is dependency-free with no
// side effects at import, so a reader of the table gains nothing it could
// trip on.
import { DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";

export const SCHEMA_VERSION = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(HERE);

export function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
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
// options: the row's parser — opt()'s arg is the type (false a flag, a
// placeholder a value), multiple the repetition. usage: the forms the help
// prints after the verb, verbatim, which also bound its arguments: a literal
// sub-word (`neighbors`), a <placeholder> (`<phrase…>` takes the rest), or a
// --name the form requires (its placeholder is the option's value, not an
// argument). NO_FORMS: the verb takes no argument. A row carries no code: the
// handler that runs a verb is its runner's (cli.mjs's HANDLERS, read-verbs.mjs's
// READ_HANDLERS), handed to dispatch(). So `module` names what a runner that
// serves the row reaches, and a reader of the table reaches none of them.

export const opt = (name, arg, summary, multiple = false) => Object.freeze({ name, arg, summary, multiple });
const JSON_OPT = opt("json", false, "the envelope");
// The options every verb takes, and the only ones that may come before the
// verb: the scan knows their arity before it knows the verb (--project takes
// a value, the rest do not). Last in every parser map, so a row cannot
// retype one. SHORT is their one-letter forms (`-hv`: version wins).
const GLOBAL_OPTS = Object.freeze([
  opt("project", "<dir>", "the project"),
  JSON_OPT,
  opt("help", false, "the help"),
  opt("version", false, "the package version"),
]);
const SHORT = Object.freeze({ help: "h", version: "v" });
const NO_FORMS = Object.freeze([]);
const READ_JSON = [JSON_OPT];
const HARNESS_OPT = opt(
  "harness",
  "<id>",
  "the harness — and, without a terminal, the confirmation (a terminal is asked); there is no --yes",
  true,
);
const SURFACE_OPT = opt("surface", "<key>", "one surface and those beneath it", true);
// The layout move's remedy names this for any copy but the package's own
// registration (the layout spec, contract 12 as amended 2026-10-03): it makes
// "no host command" true by construction instead of by recognising the root.
const NO_REGISTER_OPT = opt(
  "no-register",
  false,
  "leave the plugin registration alone: change only this project's files",
);
const VERBOSE_OPT = opt("verbose", false, "every row's reasoning, each step's why and the host's own notes");
// doctor's --verbose is the same flag in its own words: on a terminal, the
// report the pipe gets — every note, every instance, each message whole.
const DOCTOR_VERBOSE_OPT = opt(
  VERBOSE_OPT.name,
  VERBOSE_OPT.arg,
  "on a terminal too: every note, every instance, whole messages",
);
const INSTALL_OPTS = [HARNESS_OPT, SURFACE_OPT, NO_REGISTER_OPT, VERBOSE_OPT, JSON_OPT];
const UNINSTALL_OPTS = [
  HARNESS_OPT,
  SURFACE_OPT,
  opt("global", false, "also remove the harness-global plugin registration"),
  VERBOSE_OPT,
  JSON_OPT,
];

// configure's own --harness: it names the overlay agents.* keys write, and
// is no confirmation — naming a change is (its spec, contracts 1 and 8).
const CONFIGURE_OPTS = [
  opt("set", "<key>=<value>", "change one setting; without a terminal, naming it is the confirmation", true),
  opt("harness", "<id>", "the overlay agents.* keys write; other keys ignore it", true),
  opt("dry-run", false, "the plan; nothing is written"),
];

// setup's own options (the setup story, rule 1): seven, beside the globals.
// `--vault <path>` takes a value here where doctor's `--vault` is a flag —
// the per-verb parse's own case.
const SETUP_OPTS = [
  HARNESS_OPT,
  opt(
    "vault",
    "<path>",
    "the vault: an existing folder is bound, a missing or empty one is created (naming it confirms)",
  ),
  opt("layout", "<name>", `a new vault's layout (default ${DEFAULT_LAYOUT})`),
  opt("language", "<code>", `a new vault's template language (default ${DEFAULT_LANGUAGE})`),
  opt(
    "channel",
    "<npm|git>",
    "with a copy from another channel enabled (the git marketplace, Anthropic's directory), without a terminal: npm moves to the npm install, git keeps that copy",
  ),
  opt("dry-run", false, "the questions and the plan; nothing is written or fetched"),
  VERBOSE_OPT,
];

export const VERBS = Object.freeze([
  Object.freeze({
    verb: "setup",
    summary: "Set up this project: every harness it uses, and a vault.",
    usage: NO_FORMS,
    module: "./setup.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [...SETUP_OPTS, JSON_OPT],
  }),
  Object.freeze({
    verb: "configure",
    summary: "Change this project's settings after setup, behind one plan.",
    usage: NO_FORMS,
    module: "./configure.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [...CONFIGURE_OPTS, JSON_OPT],
  }),
  Object.freeze({
    verb: "doctor",
    summary: "Check the install wiring and the vault's consistency.",
    usage: NO_FORMS,
    module: "./doctor.mjs",
    wraps: "script",
    how: "spawn",
    output: "envelope",
    writes: false,
    requiresBinding: false,
    mcp: Object.freeze(["doctor"]),
    options: [
      opt("install", false, "only the install section"),
      opt("vault", false, "only the vault section"),
      DOCTOR_VERBOSE_OPT,
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "reconcile",
    summary: "Regenerate the derived views (kanban, code map, graph, indexes).",
    usage: NO_FORMS,
    module: "./reconcile.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: true,
    mcp: Object.freeze([]),
    options: [
      opt(
        "write",
        false,
        "apply the regeneration (asks on a terminal; --only names what is written and confirms headless)",
      ),
      opt("only", "<target>", "one derived view"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "plan",
    summary: "Show what install would write for a harness, without writing.",
    usage: NO_FORMS,
    module: "./install-harness.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: INSTALL_OPTS,
  }),
  Object.freeze({
    verb: "install",
    summary: "Install projectstore's surfaces for a harness, behind a preview.",
    usage: NO_FORMS,
    module: "./install-harness.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: INSTALL_OPTS,
  }),
  Object.freeze({
    verb: "uninstall",
    summary: "Remove what install wrote, and only that.",
    usage: NO_FORMS,
    module: "./install-harness.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: UNINSTALL_OPTS,
  }),
  Object.freeze({
    verb: "upgrade",
    summary: "After an update, refresh what install wrote and leave the rest.",
    usage: NO_FORMS,
    module: "./install-harness.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: INSTALL_OPTS,
  }),
  Object.freeze({
    verb: "status",
    summary: "What is bound, what is in progress, and whether views are fresh.",
    usage: NO_FORMS,
    module: "./query.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: false,
    mcp: Object.freeze(["status"]),
    options: READ_JSON,
  }),
  Object.freeze({
    verb: "orientation",
    summary: "The SessionStart skeleton and the facts behind it.",
    usage: NO_FORMS,
    module: "./query.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: true,
    mcp: Object.freeze(["orientation"]),
    options: READ_JSON,
  }),
  Object.freeze({
    verb: "search",
    summary: "Find a phrase in the vault's artifacts, literal and bounded.",
    usage: Object.freeze(["<phrase…>"]),
    module: "./query.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: true,
    mcp: Object.freeze(["search"]),
    options: [
      opt("kind", "<type>", "only artifacts of this kind", true),
      opt("status", "<status>", "only artifacts in this status"),
      opt("limit", "<n>", `at most n matches (default ${SEARCH_DEFAULT_LIMIT}, hard cap 100)`),
      opt("include-derived", false, "search the derived views too"),
      opt("case-sensitive", false, "match case"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "show",
    summary: "One artifact's frontmatter; its body or a section on request.",
    usage: Object.freeze(["<path>"]),
    module: "./query.mjs",
    wraps: "module",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: true,
    mcp: Object.freeze(["get_artifact"]),
    options: [
      opt("body", false, "include the body"),
      opt("section", "<id>", "one section by its registry id (description, acceptance, …)"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "graph",
    summary: "The live link graph by vault path.",
    usage: Object.freeze(["neighbors <path>", "lineage <path>"]),
    module: "./query.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: true,
    mcp: Object.freeze(["neighbors", "lineage"]),
    options: [
      opt("kind", "<edge-kind>", "only edges of this kind (lineage: one of its four)", true),
      opt("direction", DIRECTIONS.join("|"), "neighbors: which edges"),
      opt("depth", "<n>", `lineage: how far (default ${LINEAGE_DEFAULT_DEPTH})`),
      opt("limit", "<n>", `neighbors: cap per direction (at most ${GRAPH_EDGE_CAP})`),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "codemap",
    summary: "The code an epic or artifact maps to, or a path's artifacts.",
    usage: Object.freeze(["--for <selector>"]),
    module: "./query.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: true,
    mcp: Object.freeze(["code_refs"]),
    options: [
      opt("for", "<selector>", "an epic id, an artifact, or a repo path"),
      opt("reverse", false, "read the selector as a path even if it names an artifact"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "agents",
    summary: "The harness overlay's agents block: the model each agent runs.",
    usage: Object.freeze(["model <name>", "show", "configure"]),
    module: "./lib.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [
      opt(
        "harness",
        "<id>",
        "configure: the overlay to write — and, non-interactively, the confirmation; there is no --yes",
        true,
      ),
      opt(
        "default",
        "<model>",
        "configure: agents.default.model (pins the clerk to sonnet unless --agent clerk=… says otherwise; an empty model clears it)",
      ),
      opt("agent", "<name>=<model>", "configure: agents.per_agent.<name>.model (an empty model removes the key)", true),
      opt("reset", false, "configure: empty the agents block first; --default and --agent given with it apply on top"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "band",
    summary: "The band above the prompt: switch it, pin an epic, ask why.",
    usage: Object.freeze(["on", "off", "status", "epic <ID>"]),
    module: "./band.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: true,
    mcp: Object.freeze([]),
    options: [JSON_OPT],
  }),
  Object.freeze({
    verb: "session",
    summary: "Refresh this session's current story from its file.",
    usage: Object.freeze(["refresh <path>"]),
    module: "./lib.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: true,
    mcp: Object.freeze([]),
    options: [JSON_OPT],
  }),
  Object.freeze({
    verb: "bind",
    summary: "Bind this project to an existing vault; naming it confirms.",
    usage: Object.freeze(["<vault>"]),
    module: "./binding.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [
      opt("layout", "<name>", `the layout (default ${DEFAULT_LAYOUT})`),
      opt("language", "<code>", `the template language (default ${DEFAULT_LANGUAGE})`),
      opt("rebind", false, "point an already bound project at another vault; every other setting is kept"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "init",
    summary: "Create a vault (folder, git repository, READMEs) and bind to it.",
    usage: Object.freeze(["<vault>"]),
    module: "./binding.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [
      opt("layout", "<name>", `the layout (default ${DEFAULT_LAYOUT})`),
      opt("language", "<code>", `the template language (default ${DEFAULT_LANGUAGE})`),
      opt(
        "rebind",
        false,
        "an already bound project: create the new vault and point the project at it; every other setting is kept",
      ),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "scaffold",
    summary: "Create the vault's missing folders and READMEs; rewrite nothing.",
    usage: NO_FORMS,
    module: "./scaffold.mjs",
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: true,
    requiresBinding: true,
    mcp: Object.freeze([]),
    options: [
      opt("write", false, "create them (asks at a terminal; without one, --write is the confirmation)"),
      JSON_OPT,
    ],
  }),
  Object.freeze({
    verb: "mcp",
    summary: "Serve the read tools over MCP (stdio) for the project you name.",
    usage: NO_FORMS,
    module: "./mcp.mjs",
    wraps: "new",
    how: "import",
    output: "text",
    writes: false,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [],
  }),
  Object.freeze({
    verb: "version",
    summary: "Print the package version (also --version).",
    usage: NO_FORMS,
    module: null,
    wraps: "new",
    how: "import",
    output: "envelope",
    writes: false,
    requiresBinding: false,
    mcp: Object.freeze([]),
    options: [JSON_OPT],
  }),
]);

// Verbs the story names that land with a later slice — listed so
// `projectstore <verb>` says where instead of "unknown verb". Empty since
// A7: every verb the CLI story names has landed. The seam stays for the next
// story that adds a verb in slices.
export const PLANNED_VERBS = Object.freeze([]);

// The verbs as a person meets them (presentation spec contract 10): starting,
// reading the vault, keeping it consistent. Every verb not listed here is
// ADVANCED, one line of names in table order — so a new row is never hidden
// by this table, and init and scaffold, which the contract names in no group,
// are there too. A group lists only the verbs this run's table has. With
// setup, START is setup and uninstall, and install and bind are ADVANCED's
// (contract 10; the setup story, rule 1).
const HELP_GROUPS = [
  ["START", ["setup", "configure", "uninstall"]],
  ["VAULT", ["status", "search", "show", "graph", "codemap"]],
  ["CHECK AND REPAIR", ["doctor", "reconcile", "upgrade"]],
];
// The column a group's summaries start at: two spaces, the verb in twelve,
// one space. A summary fits 80 columns from there, so each is at most 65
// characters, in ASCII (tests/presentation.test.mjs, criterion 5, holds every
// row to it).
const VERB_COLUMN = 12;
export const SUMMARY_MAX = 80 - (2 + VERB_COLUMN + 1);

// Examples per verb. They are what to run next, so they are the core's form
// through a shell too (the story "User-facing text says where to run and
// names no project path and no shell", rule 6): `{cmd}` is the core through
// npx, and `{h}` the harness argument — ` --harness <id>` from the core, and
// through a shell ` --harness <the shell's own harness>` (shellHarnessId),
// never a session's identity. `{fixed}` is that argument through a shell
// only: the shell inserts --harness for every verb that declares it
// (packaging/shells.mjs, HARNESS_VERBS), so an example the core runs bare —
// setup, which asks; agents show, which reads the session's overlay — names
// the shell's harness through it and stays bare from the core. A `{core}`
// example is the core's alone: a shell's help leaves it out, since it says
// what the shell's own harness does not (every harness, the way back from a
// switch). `{switch.surface}`,
// `{switch.host}` and `{switch.doctor}` name the harness whose project can
// switch channels — the one with a host plugin registration — from its
// manifest: its surface key, its display name and its doctor form
// (switchHarness, below); an example naming them is left out when no
// manifest has one.
const EXAMPLES = {
  setup: [
    "{cmd} setup{fixed}",
    "{cmd} setup{fixed} --dry-run  # the questions and the plan; nothing is written or fetched",
    "{cmd} setup{h} --vault ~/vaults/my-project  # without a terminal: --harness confirms, --vault names the vault",
  ],
  configure: [
    "{cmd} configure  # at a terminal: the settings, then what to change",
    "{cmd} configure --set statusline=on",
    "{cmd} configure --set agents.critic=fable{h}  # an agent's model, in that harness's overlay",
    "{cmd} configure --json  # the settings, for scripts and agents",
  ],
  install: ["{cmd} install{h}", "{cmd} plan{h}  # the same plan; nothing is written"],
  upgrade: [
    "{cmd}@<version> upgrade{h}  # the version you name is the version that runs",
    "{cmd} upgrade{h} --verbose",
  ],
  uninstall: [
    "{core}{cmd} uninstall  # every harness this project uses",
    "{cmd} uninstall{h}",
    "{cmd} uninstall{h} --surface statusline",
    "{core}{cmd} uninstall{h} --surface {switch.surface}  # back to the git marketplace after a switch, then restart {switch.host} and run {switch.doctor} in it",
  ],
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
  scaffold: ["{cmd} scaffold  # what would be created; nothing is written", "{cmd} scaffold --write"],
  agents: ["{cmd} agents show{fixed}", "{cmd} agents configure{h} --default opus --agent clerk=sonnet"],
  band: [
    "{cmd} band status",
    "{cmd} band off",
    "{cmd} band epic PS-CORE  # a session with no epic of its own shows this one",
  ],
  session: ["{cmd} session refresh epics/PS-CORE/stories/story-x.md --json  # after a write no hook saw"],
  mcp: ['{cmd} mcp --project "$PWD"'],
};

// How this run was invoked is invokedAs (harness.mjs), the one spelling of
// the binary that ran: the help's first line, its Usage lines, the
// fixed-harness line and the usage errors. What a person runs next is the
// core's (CORE_NPX, packageCommand), as status's and bind's Next lines are.

// The harness whose project can switch channels (the converge story's rule
// 4): the one whose manifest declares a host plugin registration. Its surface
// key, display name and doctor form, from the manifest — `invocation()` in
// harness.mjs, never a literal; null when no manifest has one.
function switchHarness() {
  for (const m of loadHarnesses().values()) {
    const row = Object.entries(m.surfaces || {}).find(
      ([k, s]) => !k.startsWith("_") && s?.format === "host-plugin-registration",
    );
    if (row)
      return {
        "switch.surface": row[0],
        "switch.host": m.display_name,
        "switch.doctor": invocation(m, "doctor", { args: "--fix" }),
      };
  }
  return null;
}

// An aligned options block: each option's form in a column at most 28 wide,
// its description beside it — or, past that column, on the next line under
// it. On a live terminal a description wraps with its column as the hanging
// indent; anywhere else it stays one line, whole, for a reader that greps.
function optionLines(options, c = term.PLAIN) {
  const rows = options.map((o) => [
    term.glyphText(c, `--${o.name}${o.arg ? " " + o.arg : ""}`),
    term.glyphText(c, `${o.summary}${o.multiple ? " (repeatable)" : ""}`),
  ]);
  const w = Math.min(28, Math.max(0, ...rows.map(([l]) => l.length)));
  const pad = " ".repeat(2 + w + 2);
  const text = (r) => term.wrap(r, c.live ? c.width : 0, pad);
  return rows.map(([l, r]) => (l.length > w ? `  ${l}\n${pad}${text(r)}` : `  ${l.padEnd(w)}  ${text(r)}`));
}

const EXIT_CODES = "0 ok, 1 findings or a refusal, 2 usage, 3 not bound, 130 cancelled";
// The facts that close a help screen (`Harnesses`, `Exit codes`): the key in
// the explanation role, its value at one column for both.
const FACT_KEY = "Exit codes".length;
const fact = (c, key, value) =>
  `${term.painter(c)("explanation", key)}${" ".repeat(FACT_KEY - key.length + 2)}${value}`;

// What the bin is, in the help's badge: one line with the name and version,
// short enough that a prerelease version (0.30.0-rc.12) still fits 80 columns.
const PURPOSE = "project memory for coding agents, in markdown";

// What a verb's help says beneath its Usage when the summary has no room for
// it: here, how mcp is told its project.
const NOTES = {
  mcp: "It serves the project --project names, else PROJECTSTORE_PROJECT_DIR or the host session's project; never the directory it was started in.",
};

// The global options, as every verb takes them.
const EVERY_VERB = Object.freeze([
  opt("project", "<dir>", "the project (default: the session's, else this directory)"),
  opt("json", false, "the result as one JSON envelope, for scripts and agents"),
  opt("version", false, "the package version"),
]);

// Top-level help (presentation spec contract 10): the badge — name, version,
// purpose; Usage; the named groups, each verb in the action role and its
// summary on one line; ADVANCED, one line of the remaining verbs; the options
// every verb takes; examples, each command alone on its line (contract 6);
// the tips, whose plan command stands alone too; the harnesses and the exit
// codes. `verbs` is the table this run answers for — VERBS, or a test's own.
// `caps` is the writing stream's (term.mjs): painted at a terminal, plain on a
// pipe, and every line of it fits 80 columns either way.
export function usage(env = process.env, verbs = VERBS, { caps: c = term.PLAIN, version = packageVersion() } = {}) {
  const { shell, cmd } = invokedAs(env);
  const paint = term.painter(c);
  const width = c.live ? c.width : 0;
  const prose = (text) => "  " + term.wrap(term.glyphText(c, text), width, "    ");
  const lines = [
    term.badge(c, "projectstore", [version, PURPOSE]),
    "",
    term.heading(c, "Usage"),
    ...term.rows(c, [
      { target: `${cmd} <verb> [options]`, note: "run it inside your code project" },
      { target: `${cmd} <verb> --help`, note: "one verb's options and examples" },
    ]),
  ];
  const listed = new Set(HELP_GROUPS.flatMap(([, names]) => names));
  for (const [title, names] of HELP_GROUPS) {
    const rows = names.map((n) => verbs.find((v) => v.verb === n)).filter(Boolean);
    if (!rows.length) continue;
    lines.push("", term.heading(c, title));
    for (const v of rows) {
      const lead = `  ${paint("action", v.verb)}${" ".repeat(Math.max(0, VERB_COLUMN - v.verb.length))} `;
      lines.push(lead + term.wrap(term.glyphText(c, v.summary), width, " ".repeat(term.plain(lead).length)));
    }
  }
  // ADVANCED is one line of verbs, broken at 80 columns in every mode: with
  // install and bind among them (contract 10, once setup exists) it no longer
  // fits one row, and a pipe gets the same lines a terminal does.
  const advanced = verbs.filter((v) => !listed.has(v.verb));
  if (advanced.length)
    lines.push(
      "",
      term.heading(c, "ADVANCED"),
      "  " + term.wrap(advanced.map((v) => paint("action", v.verb)).join(` ${term.icon(c, "dot")} `), 80, "  "),
    );
  if (PLANNED_VERBS.length) lines.push("", `Planned: ${PLANNED_VERBS.map((v) => `${v.verb} (${v.lands})`).join(", ")}`);
  // A command is offered only for a verb this table has. The examples and the
  // tips' plan are what to run next: the core's form, through a shell with
  // the shell's own harness (rule 6 of the story "User-facing text says
  // where to run…"); setup names it only through a shell, as EXAMPLES'
  // `{fixed}` does.
  const h = ` --harness ${(shell && shellHarnessId(env)) || "<id>"}`;
  const has = (verb) => verbs.some((v) => v.verb === verb);
  const examples = [
    ["setup", `${CORE_NPX} setup${shell ? h : ""}`],
    ["status", `${CORE_NPX} status`],
    ["doctor", `${CORE_NPX} doctor`],
  ]
    .filter(([v]) => has(v))
    .map(([, x]) => x);
  lines.push("", term.heading(c, "Options"), ...optionLines(EVERY_VERB, c));
  if (examples.length) lines.push("", term.heading(c, "Examples"), ...term.commandBlock(c, examples));
  lines.push(
    "",
    term.heading(c, "Tips"),
    prose("setup, configure, install, upgrade and uninstall show a plan, then ask."),
    prose(
      `Without a terminal, ${shell ? "the verb is its own" : "--harness is the"} confirmation ${term.icon(c, "dash")} there is no --yes.`,
    ),
    prose("Unattended in a terminal: pass --json, set CI=1, or give stdin </dev/null."),
    prose("--verbose on those verbs adds every row's reasoning and the host's notes."),
  );
  if (has("plan"))
    lines.push(
      prose("plan prints the same plan and writes nothing:"),
      ...term.commandBlock(c, [`${CORE_NPX} plan${h}`]),
    );
  lines.push("", fact(c, "Harnesses", harnessIds().join(", ")), fact(c, "Exit codes", EXIT_CODES));
  return lines.join("\n");
}

// One verb: what it does, how to call it, every option, examples. The Usage
// lines are the row's own forms, the same declaration that bounds its
// arguments — never parsed out of the summary, so help and the parser cannot
// disagree about what a verb takes. Its first line is the summary the
// top-level help lists, after the command; `caps` as usage()'s.
export function verbHelp(row, env = process.env, { caps: c = term.PLAIN } = {}) {
  const { shell, cmd } = invokedAs(env);
  const paint = term.painter(c);
  const fixed = Boolean(shell) && row.options.some((o) => o.name === "harness");
  const opts = row.options.filter((o) => !(fixed && o.name === "harness"));
  const prose = (text) => "  " + term.wrap(term.glyphText(c, text), c.live ? c.width : 0, "    ");
  const head = `${paint("emphasis", `${cmd} ${row.verb}`)} ${term.icon(c, "dash")} ${term.glyphText(c, row.summary)}`;
  const lines = [term.wrap(head, c.live ? c.width : 0, "  "), "", term.heading(c, "Usage")];
  for (const f of row.usage.length ? row.usage : [""])
    lines.push(`  ${cmd} ${row.verb}${f ? " " + term.glyphText(c, f) : ""}${opts.length ? " [options]" : ""}`);
  if (NOTES[row.verb]) lines.push("", prose(NOTES[row.verb]));
  if (opts.length) lines.push("", term.heading(c, "Options"), ...optionLines(opts, c));
  if (fixed)
    lines.push(
      "",
      term.wrap(
        row.verb === "configure"
          ? `${shell} names the harness itself: its overlay is the one agents.* keys write.`
          : `${shell} names the harness itself: without a terminal, the verb is its own confirmation.`,
        c.live ? c.width : 0,
        "  ",
      ),
    );
  else if (row.options.some((o) => o.name === "harness")) lines.push("", fact(c, "Harnesses", harnessIds().join(", ")));
  const sw = switchHarness();
  const ex = (EXAMPLES[row.verb] || [])
    .filter((e) => !(fixed && e.startsWith("{core}")) && (sw || !e.includes("{switch.")))
    .map((e) => e.replace(/^\{core\}/, "").replace(/\{(switch\.\w+)\}/g, (_, k) => sw[k]));
  // What to run next is the core's form: through a shell, its own harness.
  const h = ` --harness ${(fixed && shellHarnessId(env)) || "<id>"}`;
  // Each example command stands alone on its line, after a blank one
  // (contract 6): nothing after it, so a paste takes exactly the command — a
  // trailing `# note` broke a paste into a shell that reads no comments. A
  // note leads its command, a blank line between them, as every other
  // introduced command does (DONE's tip, doctor's fix, bind's Next);
  // commands with no note share one block.
  const blocks = [];
  const render = (e) =>
    e
      .split("{cmd}")
      .join(CORE_NPX)
      .split("{h}")
      .join(h)
      .split("{fixed}")
      .join(fixed ? h : "");
  for (const [x, note] of ex.map((e) => render(e).split("  # "))) {
    const last = blocks.at(-1);
    if (!note && last && !last.note) last.cmds.push(x);
    else blocks.push({ note: note ? `${note[0].toUpperCase()}${note.slice(1)}:` : null, cmds: [x] });
  }
  if (blocks.length) lines.push("", term.heading(c, "Examples"));
  for (const b of blocks)
    lines.push(
      "",
      ...(b.note ? [prose(paint("explanation", b.note)), ""] : []),
      ...b.cmds.map((x) => `  ${paint("action", x)}`),
    );
  lines.push("", fact(c, "Exit codes", EXIT_CODES));
  return lines.join("\n");
}

// The nearest name within two edits — for a mistyped verb or option.
export function nearest(word, names) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  let best = null,
    score = 3;
  for (const n of names) {
    const k = n.startsWith(word) && word.length >= 3 ? 0 : d(word, n);
    if (k < score) {
      best = n;
      score = k;
    }
  }
  return best;
}

// ─── dispatch ──────────────────────────────────────────────────────────

// Rule 1 of the per-verb parse: the verb is found before anything is parsed.
// Before it only the globals' arity is known; after it, its row's too. Left
// to right, to the first "--": a "--" before the verb makes the next token
// the verb (`projectstore -- doctor`), and one after it leaves the rest to
// the verb, so the MCP server's `-- <query>` is never read as a global. Only
// the exact tokens set a flag: `--json=v` is a global with a bad value, which
// the parse words (rule 6), not a verb's option. A bare --project takes the
// next token whatever it is, as parseArgs does, and so does a bare option of
// the verb's that takes a value: `reconcile --only --help` and the MCP
// server's `--kind -h` hand the parse a value it refuses, never the help.
// Any other option before the verb is misplaced (rule 3). A bare word right
// after one is presumed to be its value when it is not a verb and some verb
// gives that option a value — for the message only (`--harness codex plan`
// reads back as `plan --harness codex`); nothing is parsed on that guess.
function scanArgv(argv, verbs) {
  const scan = { verb: null, at: -1, json: false, help: false, version: false, misplaced: [] };
  const takesValue = (row, name) => row.options.some((o) => o.name === name && o.arg);
  let row = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      if (scan.at === -1 && i + 1 < argv.length) {
        scan.verb = argv[i + 1];
        scan.at = i + 1;
      }
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      if (/^-[hv]+$/.test(a)) {
        if (a.includes("h")) scan.help = true;
        if (a.includes("v")) scan.version = true;
        continue;
      }
      if (a === "--json") scan.json = true;
      if (a === "--help") scan.help = true;
      if (a === "--version") scan.version = true;
      const name = a.startsWith("--") ? a.slice(2).split("=")[0] : null;
      const inline = a.includes("=");
      if (!inline && (name === "project" || (row && takesValue(row, name)))) i++;
      else if (scan.at === -1 && !GLOBAL_OPTS.some((o) => o.name === name))
        scan.misplaced.push({ name, raw: a, at: i, inline, value: undefined });
      continue;
    }
    if (scan.at !== -1) continue;
    const prev = scan.misplaced[scan.misplaced.length - 1];
    if (
      !verbs.some((v) => v.verb === a) &&
      prev &&
      prev.at === i - 1 &&
      !prev.inline &&
      verbs.some((v) => takesValue(v, prev.name))
    ) {
      prev.value = a;
      continue;
    }
    scan.verb = a;
    scan.at = i;
    row = verbs.find((v) => v.verb === a) || null;
  }
  return scan;
}

// A row's options and the globals, in parser order: the later declaration
// wins, so a row cannot retype a global. No row (no verb) is the globals alone.
const optionsOf = (row) => [...(row ? row.options : []), ...GLOBAL_OPTS];

// Rule 2: the row is the parser — arg is the type, multiple the repetition.
function parserOptions(row) {
  const options = {};
  for (const o of optionsOf(row))
    options[o.name] = {
      type: o.arg ? "string" : "boolean",
      ...(o.multiple ? { multiple: true } : {}),
      ...(SHORT[o.name] ? { short: SHORT[o.name] } : {}),
    };
  return options;
}

// "install does not take --verbos — did you mean --verbose?" With a row the
// candidates are its options and the globals; without one (no verb, or a
// word that is none), every option the table declares, as 0.29.2 offered.
function unknownOption(row, raw, verbs) {
  const names = (row ? optionsOf(row) : [...verbs.flatMap((v) => v.options), ...GLOBAL_OPTS]).map((o) => o.name);
  const hint = nearest(raw.replace(/^-+/, ""), [...new Set(names)]);
  return `${row ? `${row.verb} does not take` : "unknown option"} ${raw}${hint ? ` — did you mean --${hint}?` : ""}`;
}

// Rule 6: Node's own wording explains "--" positionals; a person who typed
// --verbos wants the option they meant, and one who left --only bare wants
// its form. A bad value comes in three shapes — an inline value on a flag
// (`--json=v`), none at all (`--only` last), one that looks like an option
// (`--only --json`) — and each quotes the long name, with ` <value>` or a
// `-h, ` short form around it: the declaration words the answer. Node's text
// is the fallback when no name can be read.
function parseFailure(e, row, verbs) {
  const raw = e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'(-{1,2}[^']+)'/.exec(e.message)?.[1] : null;
  if (raw) return unknownOption(row, raw, verbs);
  const name =
    e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
      ? /'(?:-[^-], )?(--[^' ]+)(?: <value>)?'/.exec(e.message)?.[1]
      : null;
  const o = name ? optionsOf(row).findLast((x) => `--${x.name}` === name) : null;
  if (!o) return e.message;
  return o.arg ? `\`--${o.name}\` needs a value: \`--${o.name} ${o.arg}\`` : `\`--${o.name}\` takes no value`;
}

// Rule 4: a usage form, word by word — a --name the form requires (the word
// after it is the option's value when it takes one, not an argument), a
// <placeholder> (`<phrase…>` takes the rest), or a literal sub-word. The
// bound is how many arguments the form holds.
function formOf(row, form) {
  const f = { form, literals: [], required: [], placeholders: 0, variadic: false };
  const words = form.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("--")) {
      f.required.push(w.slice(2));
      if (row.options.find((o) => o.name === w.slice(2))?.arg) i++;
    } else if (w.startsWith("<")) {
      f.placeholders++;
      if (w.endsWith("…>")) f.variadic = true;
    } else f.literals.push(w);
  }
  f.bound = f.variadic ? Infinity : f.literals.length + f.placeholders;
  return f;
}

// The form the arguments take: the first whose literal words lead them and
// whose required options were given. null when none does, and the verb's own
// message then says what it takes ("agents takes model <name>, show, or
// configure") — which is how `codemap PS-CORE` keeps its --for hint while
// `codemap --for X extra` names `extra`. A row with no forms binds nothing.
function matchForm(row, args, values) {
  if (!row.usage.length) return { form: "", bound: 0 };
  for (const form of row.usage) {
    const f = formOf(row, form);
    if (f.literals.every((w, i) => args[i] === w) && f.required.every((n) => values[n] !== undefined)) return f;
  }
  return null;
}

// dispatch(argv, handlers, opts) — one run of a verb, through `handlers`:
// the runner's own code, keyed by verb (cli.mjs hands every verb's, the read
// runner only the read verbs'). A row's own `run` (a test's table) stands in
// for its handler. A verb the table has and `handlers` lacks is refused, exit
// 2, after help and version have answered: the runner does not serve it.
// `verbs` is the table this run answers for: VERBS, or a test's own — the
// scan, the help, the verb lookup and every hint read it, never VERBS behind it.
export async function dispatch(
  argv,
  handlers,
  {
    verbs = VERBS,
    env = process.env,
    cwd = process.cwd(),
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    ask = null,
  } = {},
) {
  const scan = scanArgv(argv, verbs);
  const row = verbs.find((v) => v.verb === scan.verb) || null;
  // A failure before a verb runs still answers in the envelope under --json:
  // a consumer (the MCP server, a script) always has something to parse. The
  // verb is the scan's, whichever step failed (rule 7) — never the first
  // bare word, which may be --project's value.
  const fail = (message, code, { project = null, help = false } = {}) => {
    if (scan.json)
      stdout.write(JSON.stringify(envelope(scan.verb, project, false, { error: message, exit: code }), null, 2) + "\n");
    stderr.write(message + "\n" + (help ? usage(env, verbs, { caps: term.caps(stderr, env) }) + "\n" : ""));
    return code;
  };
  // A usage error says where the options are: the verb's help, else the top
  // (a word that is not a verb has no help to point at).
  const refuse = (message) => fail(`${message}\nRun ${row ? `\`${row.verb} --help\`` : "--help"} for the options.`, 2);
  // In-process reads resolve layouts and registries from THIS package, as the
  // children already do through ownEnv — not from whichever copy the host
  // session's variable points at.
  pinPluginRoot(PACKAGE_ROOT);
  // Rule 8: help and version answer first, whatever else the line holds, so
  // `doctor extra --help` and `--harness codex plan --help` print the help.
  if (scan.version) return runVersion({ values: { json: scan.json }, stdout });
  // Help is painted at a terminal and plain on a pipe: the caps are stdout's.
  if (scan.help) {
    const caps = term.caps(stdout, env);
    stdout.write((row ? verbHelp(row, env, { caps }) : usage(env, verbs, { caps })) + "\n");
    return 0;
  }
  // With no verb to scope it, an option no verb declares is unknown before
  // anything else is said, as in 0.29.2: `--bogus frobnicate` names --bogus,
  // and `--verbos instal` offers --verbose.
  const stray = row ? null : scan.misplaced.find((m) => !verbs.some((v) => v.options.some((o) => o.name === m.name)));
  if (stray) return refuse(unknownOption(null, stray.raw.split("=")[0], verbs));
  if (scan.verb === null) {
    // No verb. A verb's option (`--harness codex`, `--verbose`) is the usage,
    // as before — not "unknown verb: codex"; otherwise the globals alone are
    // parsed, so a bad value of one (`--project` last) is named.
    if (!scan.misplaced.length) {
      try {
        parseArgs({ args: argv, options: parserOptions(null), strict: true, allowPositionals: true });
      } catch (e) {
        return refuse(parseFailure(e, null, verbs));
      }
    }
    stderr.write(usage(env, verbs, { caps: term.caps(stderr, env) }) + "\n");
    return 2;
  }
  const verb = scan.verb;
  if (!row) {
    const planned = PLANNED_VERBS.find((v) => v.verb === verb);
    const guess = planned
      ? null
      : nearest(
          verb,
          verbs.map((v) => v.verb),
        );
    if (guess) return fail(`unknown verb: ${verb} — did you mean ${guess}?\nRun --help for every verb.`, 2);
    return fail(
      planned ? `${verb} lands with roadmap ${planned.lands}; not in this release.` : `unknown verb: ${verb}`,
      2,
      { help: true },
    );
  }
  const handler = row.run ?? handlers[row.verb];
  if (typeof handler !== "function")
    return fail(`${verb} is not served here: this runner answers ${Object.keys(handlers).join(", ")}`, 2);
  // Rule 3: only the globals come before the verb (git's model). A verb's
  // own option there is shown in its place; one the verb does not declare is
  // unknown, scoped to the verb. Accepting it would need its arity before the
  // verb is known, which is what per-verb types make ambiguous.
  if (scan.misplaced.length) {
    const m = scan.misplaced[0];
    const o = m.name === null ? null : row.options.find((x) => x.name === m.name);
    if (!o) return refuse(unknownOption(row, m.raw.split("=")[0], verbs));
    // Through a shell the harness is fixed (verbHelp's test: the row declares
    // it): the order shown drops it, since the shell inserts it after the verb.
    // The rest of the line follows, so the command shown is the one to run.
    const { shell, cmd } = invokedAs(env);
    const moved = shell && o.name === "harness" ? [] : [m.raw, ...(o.arg && m.value !== undefined ? [m.value] : [])];
    return refuse(
      `\`--${o.name}\` belongs after the verb: \`${[cmd, verb, ...moved, ...argv.slice(scan.at + 1)].join(" ")}\``,
    );
  }
  // Rule 2: one strict parse with this row's options plus the globals, on the
  // full argv so a token's index is the user's (rule 4's hints read them).
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: parserOptions(row), strict: true, allowPositionals: true, tokens: true });
  } catch (e) {
    return refuse(parseFailure(e, row, verbs));
  }
  const { values, positionals, tokens } = parsed;
  // Rule 4: an argument past the matched form is named, never dropped. The
  // hint says how it became one: the flag before it takes no value, or a
  // "--" made everything after it an argument.
  const args = tokens.filter((t) => t.kind === "positional" && t.index !== scan.at);
  const form = matchForm(
    row,
    args.map((t) => t.value),
    values,
  );
  if (form && args.length > form.bound) {
    const extra = args[form.bound];
    const prev = tokens.find((t) => t.index === extra.index - 1);
    const end = tokens.find((t) => t.kind === "option-terminator");
    const why =
      prev && prev.kind === "option" && prev.value === undefined
        ? ` — \`--${prev.name}\` takes no value`
        : end && extra.index > end.index
          ? " — everything after `--` is an argument"
          : "";
    return refuse(
      `${form.bound ? `\`${verb} ${form.form}\` takes no further argument` : `${verb} takes no argument`} \`${extra.value}\`${why}`,
    );
  }
  const project = resolveProject({ project: values.project, env, cwd });
  const cfg = readConfigAt(project);
  if (row.requiresBinding && !cfg) return fail(notBoundText(project, env), 3, { project });
  try {
    return await handler({
      row,
      values,
      positionals: positionals.slice(1),
      cfg,
      project,
      env,
      cwd,
      stdin,
      stdout,
      stderr,
      ask,
    });
  } catch (e) {
    // An internal failure is not "findings" (1) — it is 2, with an envelope
    // when one was asked for.
    const msg = e && e.message ? e.message : String(e);
    if (values.json) stdout.write(JSON.stringify(envelope(verb, project, false, { error: msg }), null, 2) + "\n");
    stderr.write(`${verb} failed: ${msg}\n`);
    return 2;
  }
}

// ─── What every runner's handlers share ──────────────────────────────────

// The environment a child or the installer runs in: the resolved project and
// THIS package as the plugin root, so the bin never answers for a sibling
// copy of the core.
export function ownEnv(env, project) {
  return childEnv(env, { projectRoot: project, pluginRoot: PACKAGE_ROOT });
}

// A usage error from inside a verb (a bad path, a missing query): exit 2 with
// the message, in the envelope under --json, never a stack trace.
export function usageFail(e, { verb, values, project, stdout, stderr }) {
  if (values.json) stdout.write(JSON.stringify(envelope(verb, project, false, { error: e.message }), null, 2) + "\n");
  stderr.write(`${verb}: ${e.message}\n`);
  return 2;
}

export function runVersion({ values, stdout }) {
  const version = packageVersion();
  stdout.write(
    values.json ? JSON.stringify(envelope("version", null, true, { version }), null, 2) + "\n" : version + "\n",
  );
  return 0;
}

// The not-bound refusal, for every verb that needs a binding and for configure.
// Each form alone on its line after the lead, the terminal's in the core's
// form, the directory in the lead (the story "User-facing text says where to
// run and names no project path and no shell", rules 1, 4 and 6).
export function notBoundText(project, env = process.env) {
  return [
    `${project} is not bound to a vault. Bind it in a session, or ${fromTerminalIn(project)}, where init creates the vault too:`,
    commandForm("bind", { args: "<vault>", env }),
    packageCommand([], "bind", { args: "<vault>" }),
    packageCommand([], "init", { args: "<vault>" }),
  ].join("\n");
}

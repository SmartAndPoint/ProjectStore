// projectstore — test fixture: the golden screens of the install family, bind,
// doctor, --help and status (PS-HARNESS: "The CLI's output is designed:
// grouped plans, a question rail, one glyph set, doctor grouped by cause"; the
// covering spec *Terminal presentation of the projectstore CLI: layout,
// glyphs, colour roles, questions and live lines*, Testing → Golden output
// and Equivalence).
//
// Every screen is rendered from fixed data — plans modelled on a real
// two-harness install, uninstall and upgrade, with a fixed home, project,
// version and clock — under the four modes at 80 columns. The caps objects
// are injected: no environment, terminal or clock is read. The data the
// plans carry (reasons, paths, commands) is ASCII, so in the ascii mode the
// whole screen must be: any other character would be one a renderer
// composed. Text from the manifests (display names, next steps) is ASCII too.
//
// doctor's screen is drawn from tests/fixtures/doctor-findings.json: the
// findings of a real `doctor --json` run on this repository (2026-10-11, its
// six code_refs to renamed skills still live), trimmed to one of each shape
// the screen shows and with every vault artifact path replaced by a fixture
// path. Its messages are doctor's own and carry its em dashes, which a
// finding prints as it is; the glyph scan draws the same screen from those
// findings with every other character replaced (SCREENS' `scan`). A
// terminal compacts that report and plain output does not (contract 11:
// the cap, the folds, the short instance lines), so plain is held equal to
// the terminal's --verbose rendering (SCREENS' `full`).
//
// --help is the bin's own words: its summaries are ASCII, and the glyphs in
// its options and forms are drawn through the table (term.mjs glyphText), so
// the ascii screens hold none. status is drawn from a fixed status() result.
//
// The committed goldens, tests/fixtures/presentation/<screen>.<mode>.txt, are
// written with
//   node tests/fixtures/presentation.mjs --write
// Regenerating them is a decision, not a refresh: it re-baselines what each
// screen is.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPreview, renderDone, applyReporter } from "../../scripts/install-harness.mjs";
import { renderBindPlan } from "../../scripts/binding.mjs";
import { askApply } from "../../scripts/term.mjs";
import { report } from "../../scripts/doctor-report.mjs";
import { usage, verbHelp, VERBS } from "../../scripts/cli.mjs";
import { renderStatus } from "../../scripts/query.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIR = join(HERE, "presentation");

const COLUMNS = 80;
// The four modes of the spec's Testing: rich, rich without colour, plain (a
// pipe), and ascii (rich without colour, with PROJECTSTORE_ASCII=1).
export const MODES = Object.freeze({
  rich: Object.freeze({ color: true, live: true, width: COLUMNS, columns: COLUMNS, ascii: false }),
  "rich-no-colour": Object.freeze({ color: false, live: true, width: COLUMNS, columns: COLUMNS, ascii: false }),
  plain: Object.freeze({ color: false, live: false, width: COLUMNS, columns: COLUMNS, ascii: false }),
  ascii: Object.freeze({ color: false, live: true, width: COLUMNS, columns: COLUMNS, ascii: true }),
});

export const HOME = "/home/ada";
export const PROJECT = "/home/ada/src/shop";
export const VERSION = "0.30.0";
const CC = "claude-code", CX = "codex";
const H = (p) => `${HOME}/${p}`, P = (p) => `${PROJECT}/${p}`;
const CC_MARKET = H(".claude/projectstore/marketplace"), CX_MARKET = H(".codex/projectstore/marketplace");
const UNSUPPORTED = {
  agents: "Codex spawns its own subagents; no route from a plugin's agents/ entry reaches them yet (roadmap B4)",
  commands: "Codex rewrites commands/ into skills itself; the generator renders them as skills instead (roadmap B5)",
  mcp: "the plugin's .mcp.json is in Claude Code's dialect; it ships once the Codex dialect is rendered",
  statusline: "no status-line mechanism was found in the harness",
};

// A plan's own fields, with the run-only ones plan() sets as it does: not
// enumerable, so a plan here has the 12 keys plan --json has.
function planOf(fields, { sharedBlock = null, hostManaged = [], version = VERSION } = {}) {
  const p = { projectDir: PROJECT, mode: "install", named: true, detected: [], harnesses: [], reports: [], items: [], refusals: [], ok: true, incomplete: false, root: H(".npm/_npx/4f1c2a9e/node_modules/projectstore"), plannedAgainst: {}, ...fields };
  Object.defineProperty(p, "version", { value: version, enumerable: false });
  Object.defineProperty(p, "sharedBlock", { value: sharedBlock, enumerable: false });
  if (hostManaged.length) Object.defineProperty(p, "hostManaged", { value: hostManaged, enumerable: false });
  return p;
}

// install --harness claude-code --harness codex on a fresh project: both
// registrations, the one agents block with its import, the status line and
// its launcher; Codex's unsupported surfaces; the same block named in
// Codex's group.
export function installPlan() {
  const items = [
    { harness: CC, surface: "plugin", kind: "registration", path: CC_MARKET, entry: "projectstore@projectstore-npm", state: "absent", reason: null, root: H(".claude/plugins/cache/projectstore-npm/projectstore/0.30.0"), home: H(".claude"), scope: "local", writtenBy: null, action: "create",
      steps: [
        { kind: "write", path: CC_MARKET, files: 159, why: "the marketplace directory is written from this package's 159 shipped files, staged and renamed into place" },
        { kind: "host", name: "validate", bin: "claude", argv: ["plugin", "validate", CC_MARKET], touches: [], why: "the host checks the marketplace before it is registered" },
        { kind: "host", name: "marketplace_add", bin: "claude", argv: ["plugin", "marketplace", "add", CC_MARKET, "--scope", "local"], touches: [H(".claude/plugins/known_marketplaces.json"), P(".claude/settings.local.json")], why: "the host learns our marketplace, declared in this checkout's local settings" },
        { kind: "host", name: "install", bin: "claude", argv: ["plugin", "install", "projectstore@projectstore-npm", "--scope", "local", "-y"], touches: [H(".claude/plugins/installed_plugins.json"), P(".claude/settings.local.json"), H(".claude/plugins/cache")], why: "the host copies the plugin into its cache and enables it for this checkout" },
      ] },
    { harness: CC, surface: "agents_block", kind: "shared", path: P("AGENTS.md"), entry: "projectstore:agents v4", state: "ours-absent", action: "create", reason: null },
    { harness: CC, surface: "agents_block_import", kind: "shared", path: P("CLAUDE.md"), entry: "@AGENTS.md", state: "ours-absent", action: "add", reason: "CLAUDE.md is what Claude Code reads by itself; the import of AGENTS.md is added at its top" },
    { harness: CC, surface: "statusline", kind: "shared", path: P(".claude/settings.local.json"), entry: "statusLine", state: "ours-absent", action: "create", reason: null },
    { harness: CC, surface: "mcp_project_entry", kind: "shared", path: P(".mcp.json"), entry: "mcpServers.projectstore", state: "unsupported", action: "skip", reason: "the plugin-bundled registration already binds per project in Claude Code (roadmap B3/C3)" },
    { harness: CC, surface: "statusline_launcher", kind: "exclusive", path: P(".projectstore/state/claude-code/statusline.mjs"), entry: null, state: "absent", action: "create", reason: null },
    { harness: CX, surface: "plugin", kind: "registration", path: CX_MARKET, entry: "projectstore@projectstore-npx", state: "absent", reason: null, root: null, home: H(".codex"), scope: "user", ownership: "global", action: "create",
      steps: [
        { kind: "host", name: "preflight", bin: "codex", argv: ["plugin", "list", "--json"], touches: [], why: "the host is asked what it holds before anything is staged" },
        { kind: "portable-write", path: CX_MARKET, files: Array.from({ length: 48 }, (_, k) => `skills/s${k}/SKILL.md`), why: "the fetched payload is staged with its catalogue and ownership record" },
        { kind: "host", name: "marketplace_add", bin: "codex", argv: ["plugin", "marketplace", "add", CX_MARKET], touches: [H(".codex/config.toml")], why: "Codex learns the staged marketplace" },
        { kind: "host", name: "install", bin: "codex", argv: ["plugin", "add", "projectstore@projectstore-npx"], touches: [H(".codex/config.toml"), H(".codex/plugins/cache")], why: "Codex copies the plugin into its cache and enables it" },
        { kind: "host", name: "list", bin: "codex", argv: ["plugin", "list", "--json"], touches: [], why: "the read-back verifies the installed version and payload digest" },
      ] },
    ...Object.entries(UNSUPPORTED).map(([surface, reason]) => ({ harness: CX, surface, kind: "host", path: null, entry: null, state: "unsupported", action: "skip", reason })),
  ];
  return planOf({ harnesses: [CC, CX], detected: [{ id: CC, why: "directory", evidence: ".claude" }, { id: CX, why: "directory", evidence: ".codex" }], items }, {
    sharedBlock: { harness: CC, display: "Claude Code", file: "AGENTS.md", others: [{ harness: CX, display: "Codex", at: 7 }] },
    hostManaged: [
      { harness: CC, display: "Claude Code", rows: ["commands", "agents", "skills", "hooks", "mcp"], entry: "projectstore@projectstore-npm", action: "create" },
      { harness: CX, display: "Codex", rows: ["hooks", "skills"], entry: "projectstore@projectstore-npx", action: "create" },
    ],
  });
}

// upgrade --harness claude-code on an installed project: most rows already
// right (they collapse into one unchanged line), the status-line entry
// re-pointed, and a launcher another checkout wrote last (never collapsed).
export function upgradePlan() {
  const items = [
    { harness: CC, surface: "plugin", kind: "registration", path: CC_MARKET, entry: "projectstore@projectstore-npm", state: "current", reason: null, root: H(".claude/plugins/cache/projectstore-npm/projectstore/0.30.0"), home: H(".claude"), scope: "local", writtenBy: null, action: "skip" },
    { harness: CC, surface: "agents_block", kind: "shared", path: P("CLAUDE.md"), entry: "projectstore:agents v4", state: "ours-current", action: "skip", reason: null },
    { harness: CC, surface: "statusline", kind: "shared", path: P(".claude/settings.local.json"), entry: "statusLine", state: "ours-stale", action: "replace-entry", reason: "the command no longer matches this installation" },
    { harness: CC, surface: "mcp_project_entry", kind: "shared", path: P(".mcp.json"), entry: "mcpServers.projectstore", state: "unsupported", action: "skip", reason: "the plugin-bundled registration already binds per project in Claude Code (roadmap B3/C3)" },
    { harness: CC, surface: "statusline_launcher", kind: "exclusive", path: P(".projectstore/state/claude-code/statusline.mjs"), entry: null, state: "current", action: "skip", reason: null, writtenBy: "/home/ada/src/shop-worktrees/checkout-with-a-long-name", sameProject: false },
  ];
  return planOf({ harnesses: [CC], items }, { hostManaged: [{ harness: CC, display: "Claude Code", rows: ["commands", "agents", "skills", "hooks", "mcp"], entry: "projectstore@projectstore-npm", action: "skip" }] });
}

// uninstall --harness codex: the global registration kept, the block's file
// removed whole, and the harness's state directory emptied of its marker and
// kept for the file another tool left there.
export function uninstallPlan() {
  const items = [
    { harness: CX, surface: "plugin", kind: "registration", path: CX_MARKET, entry: "projectstore@projectstore-npx", state: "current", reason: "user-global; an ordinary uninstall keeps it, and uninstall --global removes it", root: null, home: H(".codex"), scope: "user", ownership: "global", action: "skip" },
    { harness: CX, surface: "agents_block", kind: "shared", path: P("AGENTS.md"), entry: "projectstore:agents v4", state: "ours-current", action: "remove", reason: null, deleteIfEmpty: true, before: "<block>\n", after: "" },
    ...Object.entries(UNSUPPORTED).map(([surface, reason]) => ({ harness: CX, surface, kind: "host", path: null, entry: null, state: "unsupported", action: "skip", reason })),
    { harness: CX, surface: "harness_state", kind: "layout", path: P(".projectstore/state/codex"), entry: null, state: "ours", action: "remove", reason: null,
      steps: [
        { kind: "delete", path: P(".projectstore/state/codex/welcomed"), why: "the welcome marker of this harness" },
        { kind: "rmdir-state", path: P(".projectstore/state/codex"), left: ["notes.txt"], why: "the harness's state directory goes once nothing else is in it" },
      ] },
  ];
  return planOf({ mode: "uninstall", harnesses: [CX], items }, { sharedBlock: null, hostManaged: [{ harness: CX, display: "Codex", rows: ["hooks", "skills"], entry: "projectstore@projectstore-npx", action: "skip" }] });
}

// A refused plan: a launcher that is not ours, and two bindings.
export function refusedPlan() {
  const items = [
    { harness: CC, surface: "agents_block", kind: "shared", path: P("CLAUDE.md"), entry: "projectstore:agents v4", state: "ours-absent", action: "add", reason: null },
    { harness: CC, surface: "statusline_launcher", kind: "exclusive", path: P(".projectstore/state/claude-code/statusline.mjs"), entry: null, state: "foreign", action: "refuse", reason: "the file is not ours (no provenance stamp); move it aside or delete it, then run install again" },
  ];
  return planOf({ harnesses: [CC], items, ok: false, refusals: ["two bindings: .claude/projectstore.json and .projectstore/projectstore.json both exist; keep one, then run install again"] });
}

// APPLY of the install plan, driven as apply() drives the reporter: each item
// starts, its steps run — host commands through the reporter's spawn, the
// filesystem steps through onStep — and it ends. The clock moves a fixed
// amount per step.
export function applyText(c) {
  const p = installPlan();
  let t = 0, text = "";
  const out = { write: (s) => { text += s; return true; } };
  const rep = applyReporter(out, c, p, { now: () => t, home: HOME });
  const spawn = rep.spawn(() => { t += 412; return { status: 0, stdout: "", stderr: "" }; });
  for (const i of p.items.filter((x) => !["skip", "refuse"].includes(x.action))) {
    rep.onItem(i, "start");
    for (const st of i.steps || []) {
      if (st.kind === "host") { spawn(st.bin, st.argv, {}); continue; }
      rep.onStep(st, "start");
      t += 150;
      rep.onStep(st, "end", { ok: true });
    }
    if (!(i.steps || []).length) t += 20;
    rep.onItem(i, "end", { path: i.path, action: i.action, surface: i.surface });
  }
  return text;
}

const applied = (p) => p.items.filter((x) => !["skip", "refuse"].includes(x.action)).map((i) => ({ path: i.path, action: i.action, surface: i.surface }));

export const doneText = (c) => renderDone({ verb: "install", plan: installPlan(), applied: applied(installPlan()), failed: null, elapsed: 3400 }, { caps: c, cwd: PROJECT });

// STOPPED: the Claude Code registration's install fails first, so nothing
// was applied before it, and its host said why on two lines.
export function stoppedText(c) {
  const p = installPlan();
  const failed = { step: "install", argv: ["claude", "plugin", "install", "projectstore@projectstore-npm", "--scope", "local", "-y"], status: 1, stderr: "Plugin \"projectstore\" not found in marketplace \"projectstore-npm\"\nRun: claude plugin marketplace update projectstore-npm" };
  return renderDone({ verb: "install", plan: p, applied: [{ path: CC_MARKET, action: "create", surface: "plugin", failed }], failed, elapsed: 0 }, { caps: c, cwd: PROJECT });
}

// bind on an unbound project, a fresh vault whose layout has folders to
// create: the binding written, then both forms of the scaffold command.
export function bindPlan() {
  return { ok: true, refusals: [], state: "new", vault: H("vaults/shop"), configPath: P(".projectstore/projectstore.json"), layout: "engineering", language: "en", ignored: [], keptKeys: [], before: null, buildsVault: false, writes: true, scaffold: { ok: true, creates: 12 } };
}
export const bindText = (c) => renderBindPlan(bindPlan(), {}, { env: {}, caps: c });

// The confirm (install spec contract 9's question; its look is the
// presentation spec's contract 8).
export async function confirmText(c) {
  let question = "";
  await askApply(applied(installPlan()).length, { ask: async (q) => { question = q; return "n"; }, caps: c });
  return question;
}

const preview = (plan, verb) => (c) => renderPreview(plan(), { verb, caps: c, home: HOME });

// doctor: both sections, as a bare run draws them. `env` is empty, so every
// command form is the source harness's, whatever the test's environment.
export const DOCTOR_FINDINGS = Object.freeze(JSON.parse(readFileSync(join(HERE, "doctor-findings.json"), "utf8")));
export const DOCTOR_GROUPS = Object.freeze(["install", "vault"]);
export const doctorText = (c, { findings = DOCTOR_FINDINGS, verbose = false } = {}) => report(findings, DOCTOR_GROUPS, { caps: c, verbose, version: VERSION, project: PROJECT, env: {} });
// The findings with every character a finding's own text carries past 0x7E
// replaced: what is left that is not ASCII, the renderer composed.
export const asciiOnly = (s) => String(s).replace(/[^\x00-\x7e]/g, "?");
export const DOCTOR_ASCII_FINDINGS = Object.freeze(DOCTOR_FINDINGS.map((f) => ({ ...f, message: asciiOnly(f.message), ...(f.file ? { file: asciiOnly(f.file) } : {}) })));

// --help, at the top level and for install, as the core answers it: `env` is
// empty, so no shell's name stands in for the core's. The harness ids are the
// manifests'.
export const helpText = (c) => usage({}, VERBS, { caps: c, version: VERSION });
export const installHelpText = (c) => verbHelp(VERBS.find((v) => v.verb === "install"), {}, { caps: c });

// status on a bound vault with seven stories in progress across two epics, of
// which status() lists five (its cap): two epics' rows, a title longer than
// the terminal (it wraps under itself), the "+2 more" line that points at the
// kanban view, one story with no start, a parked story off the board, a
// counts line that wraps between its counts, and each freshness a view can
// have. Every start is a date, so the screen reads the same in every time
// zone.
export function statusResult() {
  const story = (epic, slug, title, started_at) => ({ path: `epics/${epic}/stories/${slug}.md`, epic, title, started_at });
  return {
    bound: true, project: PROJECT, vault_path: H("vaults/shop"), vault_exists: true, layout: "engineering", language: "en", auto_inject: true, approval_mode: "always", spec_policy: "optional", lifecycle_gates: "on",
    stories: {
      status: "ok", total: 23, by_status: { done: 12, "in-progress": 7, planned: 3, review: 1 },
      in_progress: [
        story("SHOP-PAY", "story-refunds-reach-the-ledger", "Refunds reach the ledger", "2026-10-09"),
        story("SHOP-CART", "story-a-cart-survives-a-sign-in", "A cart survives a sign-in on another device, with its saved items, its coupons and the address the shopper chose", "2026-10-08"),
        story("SHOP-PAY", "story-a-declined-card-says-why", "A declined card says why, in the shopper's words", "2026-10-07"),
        story("SHOP-CART", "story-saved-for-later", "Saved for later", "2026-10-02"),
        story("SHOP-PAY", "story-receipts-by-email", "Receipts by email", null),
      ],
      in_progress_total: 7, off_board: { not_actionable: 1 }, off_board_total: 1,
    },
    views: {
      kanban: { path: "kanban.md", exists: true, generated_at: "2026-10-09T12:00:00.000Z", stale: true },
      code_map: { path: "code-map.md", exists: false, generated_at: null, stale: null },
      graph: { path: "graph.md", exists: true, generated_at: "2026-10-09T12:00:00.000Z", stale: false },
    },
    sessions: { active: 2, entries: [] },
  };
}
export const statusText = (c) => renderStatus(statusResult(), { caps: c, env: {} });

// The screens, in order: name → (caps) → text (or a promise of it), and for
// a screen a terminal compacts, `full` — the terminal's rendering plain
// output equals — and `scan` — the screen drawn from ASCII data.
export const SCREENS = Object.freeze([
  ["plan-install", preview(installPlan, "install")],
  ["plan-upgrade", preview(upgradePlan, "upgrade")],
  ["plan-uninstall", preview(uninstallPlan, "uninstall")],
  ["plan-refused", preview(refusedPlan, "install")],
  ["confirm", confirmText],
  ["apply", applyText],
  ["done", doneText],
  ["stopped", stoppedText],
  ["bind", bindText],
  ["doctor", doctorText, { full: (c) => doctorText(c, { verbose: true }), scan: (c) => doctorText(c, { findings: DOCTOR_ASCII_FINDINGS }) }],
  ["help", helpText],
  ["help-install", installHelpText],
  ["status", statusText],
]);

export const goldenPath = (screen, mode) => join(DIR, `${screen}.${mode}.txt`);

// Every screen in every mode: [screen, mode, text].
export async function renderAll() {
  const out = [];
  for (const [screen, render] of SCREENS) for (const [mode, c] of Object.entries(MODES)) out.push([screen, mode, await render(c)]);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  mkdirSync(DIR, { recursive: true });
  const all = await renderAll();
  for (const [screen, mode, text] of all) writeFileSync(goldenPath(screen, mode), text);
  process.stdout.write(`wrote ${all.length} goldens under ${DIR}\n`);
}

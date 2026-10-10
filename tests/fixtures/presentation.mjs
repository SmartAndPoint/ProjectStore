// projectstore — test fixture: the golden screens of the install family and
// bind (PS-HARNESS: "The CLI's output is designed: grouped plans, a question
// rail, one glyph set, doctor grouped by cause"; the covering spec *Terminal
// presentation of the projectstore CLI: layout, glyphs, colour roles,
// questions and live lines*, Testing → Golden output and Equivalence).
//
// Every screen is rendered from fixed data — plans modelled on a real
// two-harness install, uninstall and upgrade, with a fixed home, project,
// version and clock — under the four modes at 80 columns. The caps objects
// are injected: no environment, terminal or clock is read. The data the
// plans carry (reasons, paths, commands) is ASCII, so in the ascii mode the
// whole screen must be: any other character would be one a renderer
// composed. Text from the manifests (display names, next steps) is ASCII too.
//
// The committed goldens, tests/fixtures/presentation/<screen>.<mode>.txt, are
// written with
//   node tests/fixtures/presentation.mjs --write
// Regenerating them is a decision, not a refresh: it re-baselines what each
// screen is.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPreview, renderDone, applyReporter } from "../../scripts/install-harness.mjs";
import { renderBindPlan } from "../../scripts/binding.mjs";
import { askApply } from "../../scripts/term.mjs";

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

// The screens, in order: name → (caps) → text (or a promise of it).
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

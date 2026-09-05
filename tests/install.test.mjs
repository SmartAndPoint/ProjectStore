// projectstore — install tests (PS-HARNESS: "Install, refresh and disown a
// harness surface: provenance, four states, the gate", slice 2 — the Claude
// Code adapter).
//
// Every case runs in a temporary project and a temporary home — never in the
// repository, whose own AGENTS.md carries the block. plan() is pure, so most
// cases assert its items directly; the gate's non-TTY branches run the script
// as a child process, and its TTY branch is exercised through the injected
// `ask` — spawnSync cannot fake a terminal, and a pseudo-terminal harness is
// not worth building for one prompt.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fakeInstall, writeRegistry, noHostEnv } from "./fixtures/install.mjs";
import { plan, renderPreview, confirm, apply, runVerb } from "../scripts/install-harness.mjs";
import { detectHarnesses, harnessRefusal, sourceHarness } from "../scripts/harness.mjs";
import { stamp, sourceHash, parseProvenance } from "../scripts/provenance.mjs";
import {
  AGENTS_BLOCK_OPEN_SRC,
  AGENTS_BLOCK_OPEN_LOOSE_SRC,
  statusLineLauncherPath,
  renderStatusLineLauncher,
  findAgentsBlock,
  renderAgentsBlock,
  agentsBlockVersion,
  syncStatusLine,
} from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.project_config_dir;
const TEMPLATE = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
const VERSION = agentsBlockVersion(TEMPLATE);
const BLOCK = renderAgentsBlock(TEMPLATE, null);

// A real one in the developer's environment would redirect the fake home.
delete process.env[SRC.runtime.home_env];

// A marketplace-cache install: enough of the plugin for the installer to
// render from — the launcher template, the block template, the layout, and a
// plugin.json carrying the version the stamp records.

function project({ bound = true, claude = null, agents = null, settings = null, statusline = true } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "ps-inst-"));
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  if (bound) writeFileSync(join(proj, CFG_DIR, SRC.runtime.config_basename), JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering", ...(statusline ? { statusline: { enabled: true } } : {}) }));
  if (claude !== null) writeFileSync(join(proj, "CLAUDE.md"), claude);
  if (agents !== null) writeFileSync(join(proj, "AGENTS.md"), agents);
  if (settings !== null) writeFileSync(join(proj, CFG_DIR, "settings.local.json"), settings);
  return proj;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.28.0");
  return { home, root };
}

const item = (p, surface) => p.items.find((i) => i.surface === surface);
const read = (f) => readFileSync(f, "utf8");

// ─── Detection and refusal (contract 8) ─────────────────────────────────

test("install contract 8: a project is detected by its harness directory, and an empty one is refused with the names it accepts", () => {
  const { home, root } = fixture();
  const proj = project();
  assert.deepEqual(detectHarnesses(proj).map((d) => d.id), [SRC.id]);
  const empty = mkdtempSync(join(tmpdir(), "ps-empty-"));
  assert.deepEqual(detectHarnesses(empty), []);
  const p = plan(empty, { home, root });
  assert.equal(p.ok, false);
  assert.equal(p.items.length, 0);
  assert.match(p.refusals[0], new RegExp(`--harness ${SRC.id}`));
  assert.match(harnessRefusal(empty), /detected by its project directory/);
  // Named, it proceeds even though nothing is detected.
  const named = plan(empty, { home, root, harnesses: [SRC.id] });
  assert.equal(named.ok, true);
  assert.equal(named.named, true);
  const unknown = plan(empty, { home, root, harnesses: ["no-such"] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.refusals[0], /unknown harness/);
});

// ─── The plan on a fresh project ────────────────────────────────────────

test("install: a fresh cache-installed project plans three creates and writes nothing until apply", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# My project\n" });
  const p = plan(proj, { home, root });
  assert.equal(p.ok, true);
  assert.equal(p.harnesses[0], SRC.id);
  assert.match(p.reports[0], /are installed by .*plugin marketplace/, "host-managed surfaces are reported (contract 14)");
  assert.equal(item(p, "agents_block").action, "add");
  assert.equal(item(p, "agents_block").state, "ours-absent");
  assert.equal(item(p, "statusline").action, "create");
  assert.equal(item(p, "statusline_launcher").action, "create");
  assert.equal(item(p, "statusline_launcher").state, "absent");
  assert.equal(item(p, "mcp_project_entry").action, "skip", "the project-root entry stays unsupported; the plugin-bundled registration is a host surface");
  assert.equal(item(p, "mcp_project_entry").state, "unsupported");
  assert.ok(p.reports[0].includes("mcp"), "the bundled registration is reported as host-managed");
  assert.equal(read(join(proj, "CLAUDE.md")), "# My project\n", "plan writes nothing");
  assert.ok(!existsSync(join(proj, CFG_DIR, "settings.local.json")));

  const preview = renderPreview(p);
  for (const i of p.items) assert.ok(preview.includes(i.action), `preview names ${i.action}`);
  assert.ok(preview.includes("CLAUDE.md") && preview.includes("settings.local.json") && preview.includes("statusline.mjs"));
  assert.ok(preview.includes("Nothing outside a marked entry"));

  const done = apply(p);
  assert.equal(done.length, 3);
  const claude = read(join(proj, "CLAUDE.md"));
  assert.ok(claude.startsWith("# My project\n\n<!-- projectstore:agents v"), "the block is appended after the user's content");
  assert.equal(findAgentsBlock(claude).v, VERSION);
  const settings = JSON.parse(read(join(proj, CFG_DIR, "settings.local.json")));
  assert.equal(settings.statusLine.command, `node "${statusLineLauncherPath(proj)}"`);
  const launcher = read(statusLineLauncherPath(proj));
  assert.ok(launcher.startsWith("#!/usr/bin/env node\n// GENERATED by scripts/install-harness.mjs"), "stamped after the shebang");
  assert.equal(parseProvenance(launcher).pkg, "0.28.0");
  assert.equal(parseProvenance(launcher).project, proj);
  assert.ok(launcher.includes(JSON.stringify(root)), "the fallback root is substituted");
  assert.ok(existsSync(join(proj, CFG_DIR, ".projectstore", ".gitignore")), "the runtime dir carries its .gitignore");

  // Second plan: everything current, nothing to apply.
  const again = plan(proj, { home, root });
  assert.ok(again.items.filter((i) => i.action !== "skip").length === 0, JSON.stringify(again.items.map((i) => [i.surface, i.state, i.action])));
  assert.equal(item(again, "statusline_launcher").state, "current");
  assert.equal(item(again, "agents_block").state, "ours-current");
  // And SessionStart's refresh now finds its entry and leaves it alone.
  const prevRoot = process.env[SRC.runtime.plugin_root_env];
  process.env[SRC.runtime.plugin_root_env] = root;
  try { assert.equal(syncStatusLine({ statusline: { enabled: true } }, proj, home), "unchanged"); }
  finally { if (prevRoot === undefined) delete process.env[SRC.runtime.plugin_root_env]; else process.env[SRC.runtime.plugin_root_env] = prevRoot; }
});

test("install: a dev checkout wires the plugin script directly and plans no launcher", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const dev = mkdtempSync(join(tmpdir(), "ps-dev-"));
  mkdirSync(join(dev, "scripts"), { recursive: true });
  mkdirSync(join(dev, "templates"), { recursive: true });
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  copyFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), join(dev, "templates", "claude-md-block.md.tmpl"));
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.0.0-dev" }));
  const proj = project();
  // Without the host's CLI the registration is unavailable and the plan is incomplete; the rest is planned against the dev root (contract 4′).
  const p = plan(proj, { home, root: dev, env: noHostEnv() });
  assert.equal(item(p, "plugin").state, "unavailable");
  assert.equal(item(p, "plugin").action, "skip");
  assert.equal(p.incomplete, true);
  assert.equal(item(p, "statusline_launcher"), undefined);
  assert.equal(item(p, "statusline").after.statusLine.command, `node "${join(dev, "scripts", "statusline.mjs")}"`);
});

// ─── The block (contract 6, ADR-002) ────────────────────────────────────

test("install contract 6: a current block is skipped, a stale one is replaced in place with the user's prose byte-identical", () => {
  const { home, root } = fixture();
  const prose = "# Mine\n\nSome rules of my own.\n\n";
  const tail = "\n\n## Below\n\nMore of mine.\n";
  const current = project({ claude: prose + BLOCK + tail });
  assert.equal(item(plan(current, { home, root }), "agents_block").state, "ours-current");

  const old = BLOCK.replace(`projectstore:agents v${VERSION}`, "projectstore:agents v2").replace("- **Report instruction conflicts", "- **Old line\n- **Report instruction conflicts");
  const stale = project({ claude: prose + old + tail });
  const p = plan(stale, { home, root, surfaces: ["agents_block"] });
  const i = item(p, "agents_block");
  assert.equal(i.state, "ours-stale");
  assert.equal(i.action, "replace-entry");
  assert.match(i.reason, /v2 → v/);
  apply(p);
  const after = read(join(stale, "CLAUDE.md"));
  assert.equal(after, prose + BLOCK + tail, "only the block changed");
});

test("install contract 6 / ADR-002 decision 3: AGENTS.md is preferred, CLAUDE.md gets the import, and a block in the other file migrates", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n", agents: "# Agents\n" });
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.equal(item(p, "agents_block").path, join(proj, "AGENTS.md"));
  assert.equal(item(p, "agents_block_import").entry, "@AGENTS.md");
  apply(p);
  assert.ok(read(join(proj, "AGENTS.md")).includes(BLOCK));
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n");

  // The block sits in CLAUDE.md; the user then adds AGENTS.md → migrate.
  const mig = project({ claude: "# Mine\n\n" + BLOCK + "\n", agents: "# Agents\n" });
  const mp = plan(mig, { home, root, surfaces: ["agents_block"] });
  const actions = mp.items.map((i) => [i.surface, i.action]);
  // The import rides on the removal item, since both rewrite CLAUDE.md.
  assert.deepEqual(actions, [["agents_block", "remove"], ["agents_block", "add"]]);
  assert.match(mp.items[0].reason, /@AGENTS\.md import added/);
  apply(mp);
  assert.equal(read(join(mig, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n", "removed from CLAUDE.md, import added");
  assert.ok(read(join(mig, "AGENTS.md")).includes(BLOCK), "added to AGENTS.md");
  assert.equal(findAgentsBlock(read(join(mig, "AGENTS.md"))).count, 1);
});

test("install contract 6: a duplicated or unclosed block is refused and nothing is written", () => {
  const { home, root } = fixture();
  // Twice in ONE file cannot be resolved (one per file can — see the
  // duplicate-resolution case below).
  const twice = project({ claude: BLOCK + "\n\n" + BLOCK + "\n" });
  const p = plan(twice, { home, root });
  assert.equal(p.ok, false);
  assert.equal(item(p, "agents_block").action, "refuse");
  assert.match(item(p, "agents_block").reason, /more than once/);
  assert.throws(() => apply(p), /refusals/);
  assert.equal(read(join(twice, "CLAUDE.md")), BLOCK + "\n\n" + BLOCK + "\n");

  const unclosed = project({ claude: "<!-- projectstore:agents v3 -->\n## half\n" });
  const u = plan(unclosed, { home, root });
  assert.equal(u.ok, false);
  assert.match(item(u, "agents_block").reason, /never closes/);
  assert.equal(read(join(unclosed, "CLAUDE.md")), "<!-- projectstore:agents v3 -->\n## half\n");

  // A marker a model re-wrapped so `-->` fell to the next line (a 0.27.1 install
  // could leave one): the block is there and unreadable. Neither install
  // (which would append a second block) nor uninstall (which would report
  // "nothing to remove") may proceed; the file is byte-identical after both.
  const WRAPPED = "# Mine\n\n<!-- projectstore:agents v3 (managed by projectstore — edit outside\n     markers) -->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n";
  const wrapped = project({ agents: WRAPPED });
  const f = findAgentsBlock(WRAPPED);
  assert.equal(f.wrapped, true); assert.equal(f.unclosed, true); assert.equal(f.line, 3); assert.equal(f.count, 1); assert.equal(f.v, 3);
  const w = plan(wrapped, { home, root });
  assert.equal(w.ok, false);
  assert.equal(item(w, "agents_block").action, "refuse");
  assert.match(item(w, "agents_block").reason, /AGENTS\.md:3: .*does not close on its own line/);
  assert.throws(() => apply(w), /refusals/);
  assert.equal(read(join(wrapped, "AGENTS.md")), WRAPPED);
  const wu = plan(wrapped, { home, root, mode: "uninstall" });
  assert.equal(wu.ok, false, "uninstall refuses too — never 'nothing to remove' over a block that is there");
  assert.equal(item(wu, "agents_block").action, "refuse");
  assert.equal(read(join(wrapped, "AGENTS.md")), WRAPPED);
  // One good block plus one wrapped marker in a file is "more than once", not "one block".
  const mixed = findAgentsBlock(BLOCK + "\n\n<!-- projectstore:agents v3\n-->\n");
  assert.equal(mixed.count, 2);
  assert.ok(!findAgentsBlock("<!-- /projectstore:agents -->\n"), "the close marker alone is not an open marker");
});

test("install: the block is rendered from the layout's roster, and a roster without an agent drops its bullets", () => {
  const full = renderAgentsBlock(TEMPLATE, ["critic", "planner", "reviewer", "librarian", "archaeologist", "clerk"]);
  assert.equal(full, BLOCK, "the engineering roster keeps every bullet");
  const noReviewer = renderAgentsBlock(TEMPLATE, ["critic", "planner"]);
  assert.ok(!noReviewer.includes("After writing code, before commit / story-done"), "the reviewer's agent line is dropped");
  assert.ok(noReviewer.includes("consult `projectstore:planner`"), "the planner's agent line stays");
  assert.ok(noReviewer.includes("opens a vault artifact before it opens an editor"), "the entry rule always stays — it mentions the reviewer in passing");
  assert.ok(noReviewer.includes("Report instruction conflicts"), "the instruction-conflict clause always stays");
  assert.ok(noReviewer.includes(`projectstore:agents v${VERSION}`) && noReviewer.endsWith("<!-- /projectstore:agents -->"));
});

// ─── settings.local.json (contract 6, the new row) ──────────────────────

test("install contract 6: a foreign statusLine is left byte-identical by install, uninstall and upgrade; an unparseable file refuses", () => {
  const { home, root } = fixture();
  const foreign = JSON.stringify({ statusLine: { type: "command", command: "node /Users/x/.claude/hud/omc-hud.mjs" }, permissions: { allow: ["Bash(npm:*)"] } }, null, 2) + "\n";
  const proj = project({ settings: foreign });
  for (const mode of ["install", "uninstall", "install"]) {
    const p = plan(proj, { home, root, mode, surfaces: ["statusline"] });
    assert.equal(item(p, "statusline").state, "theirs");
    assert.equal(item(p, "statusline").action, "skip");
    assert.equal(p.ok, true);
    apply(p);
    assert.equal(read(join(proj, CFG_DIR, "settings.local.json")), foreign);
  }
  const bad = project({ settings: "{ not json" });
  const p = plan(bad, { home, root });
  assert.equal(p.ok, false);
  assert.equal(item(p, "statusline").state, "unparseable");
  assert.equal(read(join(bad, CFG_DIR, "settings.local.json")), "{ not json");
});

test("install contract 6: our entry keeps its sibling keys and every other top-level key", () => {
  const { home, root } = fixture();
  const proj = project({ settings: JSON.stringify({ permissions: { allow: ["Bash(npm:*)"] }, statusLine: { type: "command", command: `node "${join(root, "scripts", "statusline.mjs")}"`, refreshInterval: 5000 } }) });
  const p = plan(proj, { home, root, surfaces: ["statusline"] });
  assert.equal(item(p, "statusline").state, "ours-stale");
  apply(p);
  const s = JSON.parse(read(join(proj, CFG_DIR, "settings.local.json")));
  assert.equal(s.statusLine.command, `node "${statusLineLauncherPath(proj)}"`);
  assert.equal(s.statusLine.refreshInterval, 5000);
  assert.deepEqual(s.permissions, { allow: ["Bash(npm:*)"] });
});

// ─── The launcher: the four states on a real exclusive file ─────────────

function installed() {
  const { home, root } = fixture();
  const proj = project();
  apply(plan(proj, { home, root }));
  return { home, root, proj };
}

test("install contract 4: the four stale reasons each fire on the launcher, and none reports current", () => {
  // edited by hand
  { const { home, root, proj } = installed();
    writeFileSync(statusLineLauncherPath(proj), read(statusLineLauncherPath(proj)) + "\n// hand edit\n");
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale"); assert.equal(i.reason, "edited by hand"); assert.equal(i.action, "update"); }
  // source changed
  { const { home, root, proj } = installed();
    writeFileSync(join(root, "scripts", "statusline-launcher.mjs"), read(join(root, "scripts", "statusline-launcher.mjs")) + "\n// new template line\n");
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale"); assert.equal(i.reason, "source changed"); }
  // plugin updated
  { const { home, root, proj } = installed();
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }));
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale"); assert.equal(i.reason, "plugin updated"); }
  // configuration changed: the same template and version, rendered from another root
  { const { home, root, proj } = installed();
    const other = fakeInstall(home, "0.28.0-b");
    writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.28.0" }));
    const i = item(plan(proj, { home, root: other }), "statusline_launcher");
    assert.equal(i.state, "stale"); assert.equal(i.reason, "configuration changed"); }
});

test("install contract 5: a foreign launcher is refused by install, uninstall and upgrade, byte-identical", () => {
  const { home, root } = fixture();
  const proj = project();
  mkdirSync(join(proj, CFG_DIR, ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(proj), "#!/usr/bin/env node\nconsole.log('mine');\n");
  for (const mode of ["install", "uninstall", "install"]) {
    const p = plan(proj, { home, root, mode });
    assert.equal(item(p, "statusline_launcher").state, "foreign");
    assert.equal(item(p, "statusline_launcher").action, "refuse");
    assert.equal(p.ok, false);
    assert.throws(() => apply(p));
    assert.equal(read(statusLineLauncherPath(proj)), "#!/usr/bin/env node\nconsole.log('mine');\n");
  }
});

test("install contract 4 rung 1″: a pre-provenance launcher is ours, stale and replaceable — not foreign", () => {
  const { home, root } = fixture();
  const proj = project();
  mkdirSync(join(proj, CFG_DIR, ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(proj), renderStatusLineLauncher(read(join(root, "scripts", "statusline-launcher.mjs")), root));
  const p = plan(proj, { home, root, surfaces: ["statusline_launcher"] });
  const i = item(p, "statusline_launcher");
  assert.equal(i.state, "stale");
  assert.match(i.reason, /plugin updated \(pre-provenance file\)/);
  assert.equal(i.action, "update");
  apply(p);
  assert.ok(parseProvenance(read(statusLineLauncherPath(proj))), "stamped now");
});

test("install contract 12: a launcher another project wrote reports current, last written by it", () => {
  const { home, root, proj } = installed();
  const other = project();
  mkdirSync(join(other, CFG_DIR, ".projectstore"), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  const i = item(plan(other, { home, root }), "statusline_launcher");
  assert.equal(i.state, "current");
  assert.equal(i.writtenBy, proj);
  assert.equal(i.sameProject, false);
});

// ─── uninstall and upgrade (contracts 13, 14) ───────────────────────────

test("install contract 13: uninstall removes only what it recognises and prunes the runtime dir only when empty", () => {
  const { home, root, proj } = installed();
  writeFileSync(join(proj, CFG_DIR, "projectstore.json"), JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering", statusline: { enabled: true } }));
  // Something else lives in the runtime dir: it must survive.
  mkdirSync(join(proj, CFG_DIR, ".projectstore", "state"), { recursive: true });
  writeFileSync(join(proj, CFG_DIR, ".projectstore", "state", "s1.json"), "{}");
  const p = plan(proj, { home, root, mode: "uninstall" });
  assert.deepEqual(p.items.filter((i) => i.action === "remove").map((i) => i.surface).sort(), ["agents_block", "statusline", "statusline_launcher"]);
  apply(p);
  assert.ok(!existsSync(join(proj, "CLAUDE.md")), "a CLAUDE.md that held only our block is removed");
  assert.deepEqual(JSON.parse(read(join(proj, CFG_DIR, "settings.local.json"))), {});
  assert.ok(!existsSync(statusLineLauncherPath(proj)));
  assert.ok(existsSync(join(proj, CFG_DIR, ".projectstore", "state", "s1.json")), "the runtime dir was not empty, so it stays");

  const clean = installed();
  apply(plan(clean.proj, { home: clean.home, root: clean.root, mode: "uninstall" }));
  assert.ok(!existsSync(join(clean.proj, CFG_DIR, ".projectstore")), "an emptied runtime dir is pruned");
});

test("install contract 14: upgrade after a version bump re-stamps the launcher and leaves the rest alone", () => {
  const { home, root, proj } = installed();
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }));
  const p = plan(proj, { home, root });
  assert.deepEqual(p.items.filter((i) => i.action !== "skip").map((i) => i.surface), ["statusline_launcher"]);
  apply(p);
  assert.equal(parseProvenance(read(statusLineLauncherPath(proj))).pkg, "0.29.0");
  assert.equal(item(plan(proj, { home, root }), "statusline_launcher").state, "current");
});

// ─── The gate (contract 9) ──────────────────────────────────────────────

test("install contract 9: a bare non-TTY install refuses, a named one proceeds, and the preview precedes every write", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n" });
  const env = { ...process.env, HOME: home, [SRC.runtime.plugin_root_env]: root };
  delete env[SRC.runtime.home_env];
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), ...args, "--project", proj], { encoding: "utf8", env, timeout: 15000 });

  const bare = run(["install"]);
  assert.equal(bare.status, 1, bare.stderr);
  assert.match(bare.stdout, /non-TTY refuses/);
  assert.ok(bare.stdout.includes("CLAUDE.md"), "the preview is printed before the refusal");
  assert.equal(read(join(proj, "CLAUDE.md")), "# Mine\n");

  const named = run(["install", "--harness", SRC.id, "--json"]);
  assert.equal(named.status, 0, named.stderr + named.stdout);
  const out = JSON.parse(named.stdout);
  assert.equal(out.gate.why, "named");
  assert.equal(out.applied.length, 3);
  assert.ok(read(join(proj, "CLAUDE.md")).includes("projectstore:agents"));

  const again = run(["install", "--harness", SRC.id, "--json"]);
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).gate.why, "nothing-to-do");

  const planOnly = run(["plan", "--json"]);
  assert.equal(planOnly.status, 0);
  assert.ok(JSON.parse(planOnly.stdout).items.every((i) => i.action === "skip"));

  const usage = run(["frobnicate"]);
  assert.equal(usage.status, 2);
});

test("install contract 9: the interactive branch applies on yes and writes nothing on anything else", async () => {
  const { home, root } = fixture();
  const proj = project();
  const p = plan(proj, { home, root });
  const no = await confirm(p, { ask: async () => "n" });
  assert.equal(no.confirmed, false);
  assert.ok(!existsSync(statusLineLauncherPath(proj)));
  const yes = await runVerb("install", proj, { home, root, ask: async (q) => { assert.match(q, /Apply these 3 change/); return "yes"; } });
  assert.equal(yes.gate.confirmed, true);
  assert.equal(yes.applied.length, 3);
  assert.ok(existsSync(statusLineLauncherPath(proj)));
  const refused = plan(project({ settings: "{ nope" }), { home, root });
  assert.deepEqual(await confirm(refused, { ask: async () => "y" }), { confirmed: false, why: "refused" });
});

// ─── The review's cases ─────────────────────────────────────────────────

test("install: the status line is opt-in — no flag means skip, naming the surface means wire", () => {
  const { home, root } = fixture();
  const proj = project({ statusline: false });
  const p = plan(proj, { home, root });
  assert.equal(item(p, "statusline").state, "opt-out");
  assert.equal(item(p, "statusline").action, "skip");
  assert.equal(item(p, "statusline_launcher").action, "skip");
  assert.equal(item(p, "agents_block").action, "create", "the block does not depend on the flag");
  const named = plan(proj, { home, root, surfaces: ["statusline"] });
  assert.equal(item(named, "statusline").action, "create");
  assert.equal(item(named, "statusline_launcher").action, "create");
  assert.equal(item(named, "agents_block"), undefined, "--surface narrows");
});

test("install: a foreign status line slot means no launcher is written either", () => {
  const { home, root } = fixture();
  const proj = project({ settings: JSON.stringify({ statusLine: { type: "command", command: "node /x/hud.mjs" } }) });
  const p = plan(proj, { home, root });
  assert.equal(item(p, "statusline").state, "theirs");
  assert.equal(item(p, "statusline_launcher").action, "skip");
  apply(p);
  assert.ok(!existsSync(statusLineLauncherPath(proj)));
});

test("install: the roster filter drops an agent line whose verb wraps onto the second line, and the plan renders from the plugin root's layout", () => {
  const onlyPlanner = renderAgentsBlock(TEMPLATE, ["planner"]);
  assert.ok(!onlyPlanner.includes("design proposal: run the `projectstore:critic`"), "the critic's agent line is dropped");
  assert.ok(!onlyPlanner.includes("After writing code, before commit"), "the reviewer's too");
  assert.ok(onlyPlanner.includes("consult `projectstore:planner`"));
  assert.ok(onlyPlanner.includes("opens a vault artifact before it opens an editor"), "the entry rule stays though it names the critic in passing");
  assert.ok(onlyPlanner.includes("resolve its model from"), "the model-resolution line stays");

  const { home, root } = fixture();
  writeFileSync(join(root, "scaffold", "layouts", "engineering.json"), JSON.stringify({ ...JSON.parse(read(join(ROOT, "scaffold", "layouts", "engineering.json"))), agents: ["critic", "planner"] }));
  const proj = project();
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.ok(!item(p, "agents_block").after.includes("After writing code, before commit"), "the block is rendered from the root the plan was given, not the ambient install");
});

test("install contract 6 / ADR-002 decision 3: two files with one block each resolve to the preferred one, never a refusal", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n\n" + BLOCK + "\n", agents: "# Agents\n\n" + BLOCK + "\n" });
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.items.map((i) => [relative(proj, i.path), i.action]), [["CLAUDE.md", "remove"], ["AGENTS.md", "skip"]]);
  assert.match(p.items[0].reason, /duplicate of the block in AGENTS\.md; @AGENTS\.md import added/);
  apply(p);
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n");
  assert.equal(findAgentsBlock(read(join(proj, "AGENTS.md"))).count, 1);
});

test("install contract 13 / ADR-002 decision 4: uninstall removes the import registration added when CLAUDE.md holds nothing else, and keeps a user's AGENTS.md", () => {
  const { home, root } = fixture();
  const proj = project({ agents: "# Agents\n", claude: "" });
  apply(plan(proj, { home, root, surfaces: ["agents_block"] }));
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n");
  apply(plan(proj, { home, root, mode: "uninstall", surfaces: ["agents_block"] }));
  assert.ok(!existsSync(join(proj, "CLAUDE.md")), "a CLAUDE.md that held only our import goes");
  assert.equal(read(join(proj, "AGENTS.md")), "# Agents\n", "the user's AGENTS.md keeps its prose, byte-identical");

  const kept = project({ agents: "# Agents\n", claude: "# Mine\n" });
  apply(plan(kept, { home, root, surfaces: ["agents_block"] }));
  apply(plan(kept, { home, root, mode: "uninstall", surfaces: ["agents_block"] }));
  assert.equal(read(join(kept, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n", "an import in a CLAUDE.md with the user's prose stays — AGENTS.md still exists");
});

test("install contract 7 (amended 2026-09-05) / 13: a dev-checkout root reports a launcher it did not write and never deletes it; uninstall removes it; a foreign one is left", () => {
  const { home, root, proj } = installed();
  const dev = mkdtempSync(join(tmpdir(), "ps-dev-"));
  mkdirSync(join(dev, "templates"), { recursive: true });
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  copyFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), join(dev, "templates", "claude-md-block.md.tmpl"));
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.0.0-dev" }));
  const before = read(statusLineLauncherPath(proj));
  const p = plan(proj, { home, root: dev, surfaces: ["statusline"] });
  assert.equal(item(p, "statusline_launcher").action, "skip", "install from a root that does not produce the file leaves it");
  assert.equal(item(p, "statusline_launcher").state, "stale");
  assert.match(item(p, "statusline_launcher").reason, /left in place/);
  apply(p);
  assert.equal(read(statusLineLauncherPath(proj)), before, "byte-identical after apply");
  const up = plan(proj, { home, root: dev, mode: "install", surfaces: ["statusline"] });
  assert.ok(!up.items.some((i) => i.action === "prune"), "upgrade is install re-run: no prune either");
  // Uninstall is the one verb that removes it from a dev root: the user asked to disown, and it is recognisably ours.
  const un = plan(proj, { home, root: dev, mode: "uninstall", surfaces: ["statusline"] });
  assert.equal(item(un, "statusline_launcher").action, "remove");
  apply(un);
  assert.ok(!existsSync(statusLineLauncherPath(proj)));
  void root;
  const foreign = project();
  mkdirSync(join(foreign, CFG_DIR, ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(foreign), "console.log('theirs')\n");
  const f = plan(foreign, { home, root: dev, surfaces: ["statusline"] });
  assert.equal(item(f, "statusline_launcher").action, "skip");
  assert.equal(item(f, "statusline_launcher").state, "foreign");
});

test("install contract 12: the preview says who last wrote a shared-path file", () => {
  const { home, root, proj } = installed();
  const other = project();
  mkdirSync(join(other, CFG_DIR, ".projectstore"), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  assert.ok(renderPreview(plan(other, { home, root })).includes(`current, last written by ${proj}`));
});

test("install: upgrade runs as install, a missing flag value is a usage error, and the JSON envelope carries no file bodies", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n" });
  const env = { ...process.env, HOME: home, [SRC.runtime.plugin_root_env]: root };
  delete env[SRC.runtime.home_env];
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), ...args, "--project", proj], { encoding: "utf8", env, timeout: 15000 });
  const up = run(["upgrade", "--harness", SRC.id, "--json"]);
  assert.equal(up.status, 0, up.stderr);
  const out = JSON.parse(up.stdout);
  assert.equal(out.verb, "upgrade");
  assert.equal(out.applied.length, 3);
  assert.ok(out.items.every((i) => !("before" in i) && !("after" in i)));
  assert.ok(!up.stdout.includes("opens a vault artifact"), "no block body in the envelope");
  const bad = spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), "install", "--harness"], { encoding: "utf8", env, timeout: 15000 });
  assert.equal(bad.status, 2);
});

test("install: the command prose invokes the verb and never writes the block or the settings itself", () => {
  for (const f of ["commands/agents.md", "commands/bind.md", "commands/statusline.md", "commands/doctor.md"]) {
    const src = read(join(ROOT, f));
    assert.match(src, /bin\/projectstore\.mjs" (install|uninstall|plan) /, `${f} invokes the verb through the bin (roadmap A8)`);
  }
  const doctor = read(join(ROOT, "commands", "doctor.md"));
  assert.ok(!/agents-block[^\n]*\n[^\n]*Edit after approval/.test(doctor), "doctor.md no longer repairs the block with Edit");
  const agents = read(join(ROOT, "commands", "agents.md")).replace(/\s+/g, " ");
  assert.ok(agents.includes("Never write the block with the Write or Edit tool"));
});

// ─── The stamp itself ───────────────────────────────────────────────────

test("install: the launcher stamp names the installer as generator and doctor as the remedy", () => {
  const { root, proj } = installed();
  void root;
  const text = read(statusLineLauncherPath(proj));
  assert.ok(text.includes("GENERATED by scripts/install-harness.mjs from scripts/statusline-launcher.mjs"));
  assert.ok(text.includes("projectstore doctor reports this file"), "an installed file is caught by doctor, not by the portability suite");
  assert.ok(!text.includes("tests/portability.test.mjs"));
  const s = stamp("x\n", { format: "mjs", src: "a", srcHash: sourceHash("a"), pkg: "1", project: "/p", harness: "h" });
  assert.ok(s.text.includes("tests/portability.test.mjs"), "the default remedy still names the suite for a committed tree");
});

// ─── Slice A3: doctor reads the states ──────────────────────────────────

import { surfaceStates, analyseStampedFile } from "../scripts/surfaces.mjs";
import { checkHarnessSurfaces, checkVersionDrift, checkAgentsBlock, runInstallChecks } from "../scripts/doctor.mjs";
import { installedPluginEntries } from "../scripts/lib.mjs";

const byCheck = (fs, id) => fs.filter((f) => f.check === id);

test("install contract 4 (doctor half): each of the four stale reasons on the launcher is one doctor issue, and current is silent", async () => {
  const one = async (mutate) => {
    const { home, root, proj } = installed();
    assert.deepEqual(byCheck(await checkHarnessSurfaces({}, proj, { home, root }), "surface"), [], "a current install says nothing");
    const opts = mutate({ home, root, proj });
    const f = byCheck(await checkHarnessSurfaces({}, proj, opts || { home, root }), "surface");
    assert.equal(f.length, 1);
    assert.equal(f[0].level, "issue");
    assert.match(f[0].message, /bin\/projectstore\.mjs" install --harness [a-z-]+ --surface statusline_launcher/, "the remedy is the bin form the command prose runs");
    assert.ok(f[0].message.includes(`node "$${SRC.runtime.plugin_root_env}/bin/projectstore.mjs"`), "a shell reference to the harness's own variable, not its bare name");
    assert.ok(!f[0].message.includes("install-harness.mjs"));
    return f[0].message;
  };
  assert.match(await one(({ proj }) => writeFileSync(statusLineLauncherPath(proj), read(statusLineLauncherPath(proj)) + "\n// hand edit\n")), /stale: edited by hand/);
  assert.match(await one(({ root }) => writeFileSync(join(root, "scripts", "statusline-launcher.mjs"), read(join(root, "scripts", "statusline-launcher.mjs")) + "\n// new line\n")), /stale: source changed/);
  assert.match(await one(({ root }) => writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }))), /stale: plugin updated/);
  assert.match(await one(({ home, root }) => { void root; const other = fakeInstall(home, "0.28.0-b"); writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.28.0" })); return { home, root: other }; }), /stale: configuration changed/);
});

test("install contract 5 (doctor half): a foreign file is reported under its own id with the resolution wording, and never repaired", async () => {
  const { home, root } = fixture();
  const proj = project();
  mkdirSync(join(proj, CFG_DIR, ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(proj), "#!/usr/bin/env node\nconsole.log('mine');\n");
  const f = await checkHarnessSurfaces({}, proj, { home, root });
  assert.equal(byCheck(f, "surface-foreign").length, 1);
  assert.match(byCheck(f, "surface-foreign")[0].message, /rename it if it is yours, or delete it/i);
  assert.equal(byCheck(f, "surface").length, 0);
  // The repair table never names the id, and every repair it can emit invokes a verb.
  const doctorMd = read(join(ROOT, "commands", "doctor.md"));
  const step3 = doctorMd.slice(doctorMd.indexOf("3. **`--fix` requested**"));
  const repairIds = [...step3.matchAll(/^\s+- `([a-z-]+)`/gm)].map((m) => m[1]);
  assert.ok(repairIds.includes("surface") && repairIds.includes("surface-foreign"), "both ids are addressed in step 3");
  // Every foreign id — the file's and the registration's (2026-09-05) — has the negative clause and invokes nothing.
  for (const id of ["surface-foreign", "plugin-registration-foreign"]) {
    assert.ok(repairIds.includes(id), `${id} is addressed in step 3`);
    assert.ok(new RegExp(`${id}\` → \\*\\*never repairable`).test(step3), `${id}: the negative clause exists`);
    const bullet = step3.slice(step3.indexOf(`- \`${id}\``), step3.indexOf("\n   - `", step3.indexOf(`- \`${id}\``) + 5));
    assert.ok(!bullet.includes('node "') && !bullet.includes("/projectstore:") && !bullet.includes("claude plugin"), `the ${id} bullet invokes nothing`);
  }
  assert.ok(/never Edit, Write or delete the file yourself/.test(step3));
  // Executable repairs: every verb invocation step 3 can emit leaves a foreign
  // launcher and a foreign slot byte-identical.
  // Since roadmap A8 the prose invokes the bin; the verb travels to install-harness.mjs unchanged (cli.mjs runInstallVerb).
  const cmds = [...step3.matchAll(/node "\$CLAUDE_PLUGIN_ROOT\/(bin\/projectstore\.mjs)" ([a-z]+)/g)].map((m) => [m[1], m[2]]);
  assert.ok(cmds.length > 0 && cmds.every(([s, v]) => s === "bin/projectstore.mjs" && ["install", "uninstall", "upgrade", "plan"].includes(v)), "repairs invoke core verbs only, through the bin");
  const foreignSlot = JSON.stringify({ statusLine: { type: "command", command: "node /x/hud.mjs" } }, null, 2) + "\n";
  const victim = project({ settings: foreignSlot, agents: "# theirs\n" });
  mkdirSync(join(victim, CFG_DIR, ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(victim), "console.log('theirs')\n");
  const env = { ...process.env, HOME: home, [SRC.runtime.plugin_root_env]: root };
  delete env[SRC.runtime.home_env];
  for (const [script, verb] of cmds) {
    for (const key of ["statusline", "agents_block"]) {
      spawnSync(process.execPath, [join(ROOT, script), verb, "--harness", SRC.id, "--surface", key, "--project", victim], { encoding: "utf8", env, timeout: 15000 });
    }
  }
  assert.equal(read(statusLineLauncherPath(victim)), "console.log('theirs')\n");
  assert.equal(read(join(victim, CFG_DIR, "settings.local.json")), foreignSlot);
  assert.ok(read(join(victim, "AGENTS.md")).startsWith("# theirs\n"), "the user's prose is untouched; the block was appended after it");
});

test("install contract 12 (doctor half): a launcher another project wrote is one info naming it", async () => {
  const { home, root, proj } = installed();
  const other = project();
  mkdirSync(join(other, CFG_DIR, ".projectstore"), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  const f = byCheck(await checkHarnessSurfaces({}, other, { home, root }), "surface");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
  assert.ok(f[0].message.includes(`current, last written by ${proj}`));
});

test("install contract 6 (doctor half): block states — content drift at the same version, one per file, unclosed", async () => {
  const { home, root } = fixture();
  const drift = project({ claude: BLOCK.replace("- **Report instruction conflicts", "- **Changed line\n- **Report instruction conflicts") + "\n" });
  const f = byCheck(await checkHarnessSurfaces({}, drift, { home, root }), "surface");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /content differs from the current source/);
  assert.deepEqual(checkAgentsBlock(drift), [], "the version matches, so the version check is quiet — the state check carries it");

  const both = project({ claude: "# Mine\n\n" + BLOCK + "\n", agents: "# A\n\n" + BLOCK + "\n" });
  const ab = checkAgentsBlock(both);
  assert.equal(ab.length, 1);
  assert.equal(ab[0].level, "warn", "one per file is what install resolves");
  assert.match(ab[0].message, /keeps the one in AGENTS\.md/);
  const twice = project({ claude: BLOCK + "\n\n" + BLOCK + "\n" });
  assert.equal(checkAgentsBlock(twice)[0].level, "issue");

  const unclosed = project({ claude: "<!-- projectstore:agents v3 -->\n## half\n" });
  const u = byCheck(await checkHarnessSurfaces({}, unclosed, { home, root }), "surface");
  assert.equal(u.length, 1);
  assert.equal(u[0].level, "issue");
  assert.match(u[0].message, /never closes/);
  // A wrapped marker: the surface issue names the line, and the startup check
  // says "unreadable", never "not registered" (the reading that appends a second block).
  const wrapped = project({ agents: "# A\n<!-- projectstore:agents v3 (managed)\n-->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n" });
  const ws = byCheck(await checkHarnessSurfaces({}, wrapped, { home, root }), "surface");
  assert.equal(ws.length, 1);
  assert.match(ws[0].message, /AGENTS\.md:2: .*does not close on its own line/);
  const wa = checkAgentsBlock(wrapped);
  assert.equal(wa.length, 1);
  assert.equal(wa[0].level, "issue");
  assert.match(wa[0].message, /AGENTS\.md:2/);
  assert.ok(!wa.some((x) => /not registered/.test(x.message)));
  // A good block in one file and a wrapped marker in the other: the wrapped issue, and NOT the "both files — install keeps one" advice (install refuses).
  const split = project({ claude: "# Mine\n\n" + BLOCK + "\n", agents: "# A\n<!-- projectstore:agents v3 (managed)\n-->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n" });
  const sa = checkAgentsBlock(split);
  assert.ok(sa.some((x) => /AGENTS\.md:2/.test(x.message)));
  assert.ok(!sa.some((x) => /in both CLAUDE\.md and AGENTS\.md/.test(x.message)), "no contradictory advice");
  // A good block plus a wrapped marker in the SAME file: startup names it (both verbs refuse), never a quiet session.
  const same = project({ agents: BLOCK + "\n\n<!-- projectstore:agents v3\n-->\n" });
  const ma = checkAgentsBlock(same);
  assert.ok(ma.some((x) => x.level === "issue" && /2 times/.test(x.message)), JSON.stringify(ma));
  const mp = plan(same, { home, root });
  assert.equal(mp.ok, false);
  // The three encodings of the open marker agree: the strict regex, the loose one and the manifest's marker.open.
  const open = SRC.surfaces.agents_block.marker.open;
  assert.ok(new RegExp(AGENTS_BLOCK_OPEN_SRC).test(open + "3 -->") && new RegExp(AGENTS_BLOCK_OPEN_LOOSE_SRC).test(open + "3"), "manifest marker.open is what both regexes match");
});

test("install: no doctor remedy names a raw script — every one is the bin form the command prose runs", () => {
  const src = read(join(ROOT, "scripts", "doctor.mjs"));
  assert.ok(!/install-harness\.mjs (install|uninstall|upgrade|plan)/.test(src));
  assert.ok(!/scripts\/(reconcile|doctor|install-harness)\.mjs"/.test(src.replace(/^\s*\/\/.*$/gm, "")), "no code path names a script the prose no longer runs");
  assert.match(src, /node "\$\$\{pluginRootVar\(s\.harness\)\}\/bin\/projectstore\.mjs" install --harness/, "the remedy is a shell reference to the surface's harness variable, in the bin form");
});

test("install contract 16: a harness is reported only when the project uses it", async () => {
  const { home, root } = fixture();
  // A second manifest whose project directory is .codex, in a temp manifest dir.
  const mdir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  copyFileSync(join(ROOT, "harnesses", "claude-code.json"), join(mdir, "claude-code.json"));
  const fake = JSON.parse(read(join(ROOT, "harnesses", "claude-code.json")));
  fake.id = "other-harness"; fake.display_name = "Other"; fake.source_layout = false; fake.emit = true;
  fake.runtime = { ...fake.runtime, project_config_dir: ".other", project_dir_env: "OTHER_PROJECT_DIR", plugin_root_env: "OTHER_PLUGIN_ROOT", home_env: "OTHER_HOME", detect_env: ["OTHER_HOME"] };
  fake.surfaces = { commands: { ...fake.surfaces.commands } };
  writeFileSync(join(mdir, "other-harness.json"), JSON.stringify(fake));
  const proj = project();
  const r = surfaceStates(proj, { home, root, manifestDir: mdir });
  assert.deepEqual(r.used, [SRC.id], "only the harness whose directory exists");
  assert.ok(r.states.every((s) => s.harness === SRC.id));
  // The other half of contract 16: no directory, but a file of ours.
  const oursOnly = mkdtempSync(join(tmpdir(), "ps-ours-"));
  writeFileSync(join(oursOnly, "AGENTS.md"), BLOCK + "\n");
  assert.deepEqual(surfaceStates(oursOnly, { home, root, manifestDir: mdir }).used, [SRC.id], "a project carrying our block uses the harness");
  const none = mkdtempSync(join(tmpdir(), "ps-none-"));
  const f = await checkHarnessSurfaces({}, none, { home, root, manifestDir: mdir });
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "harness");
  assert.match(f[0].message, /claude-code, other-harness/);
});

test("install contract 17: registrations at different versions are one warning naming both and their sources", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  writeRegistry(home, [{ scope: "user", installPath: "/x/0.27.0", version: "0.27.0" }]);
  assert.deepEqual(checkVersionDrift(home, []), [], "one registration, nothing to say");
  assert.equal(installedPluginEntries(home).length, 1);
  assert.equal(installedPluginEntries(home)[0].present, false);
  // The common shape: two installs under ONE key and ONE scope, both on disk.
  const a = fakeInstall(home, "0.27.0"), b = fakeInstall(home, "0.28.0");
  writeRegistry(home, [{ scope: "user", installPath: a, version: "0.27.0" }, { scope: "user", installPath: b, version: "0.28.0" }]);
  const f = checkVersionDrift(home, []);
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "version-drift");
  assert.match(f[0].message, /0\.27\.0 \(registry projectstore@SmartAndPoint \(user\) at /);
  assert.match(f[0].message, /0\.28\.0/);
  // A wiped install is not a copy anyone runs.
  writeRegistry(home, [{ scope: "user", installPath: a, version: "0.27.0" }, { scope: "user", installPath: "/gone/0.26.0", version: "0.26.0" }]);
  assert.deepEqual(checkVersionDrift(home, []), []);
  // A stamped file at a version the registry does not carry counts too.
  writeRegistry(home, [{ scope: "user", installPath: a, version: "0.27.0" }]);
  const g = checkVersionDrift(home, [{ surface: "statusline_launcher", installedPkg: "0.28.0" }]);
  assert.equal(g.length, 1);
  assert.match(g[0].message, /0\.28\.0 \(pkg= of statusline_launcher\)/);
});

test("install: runInstallChecks carries the state findings, and the startup path never loads the leaf", async () => {
  const { home, root, proj } = installed();
  writeFileSync(join(proj, CFG_DIR, "settings.local.json"), "{ not json");
  const cfg = { vault_path: proj, layout: "engineering", statusline: { enabled: true } };
  const f = await runInstallChecks(cfg, proj, { home, root });
  assert.ok(Array.isArray(f));
  assert.ok(f.some((x) => x.check === "statusline"), "checkStatusline still owns the entry's wiring facts");
  const startup = read(join(ROOT, "scripts", "doctor.mjs"));
  const body = startup.slice(startup.indexOf("export function runStartupChecks"), startup.indexOf("export function runStartupChecks") + 1200);
  assert.ok(!body.includes("checkHarnessSurfaces") && !body.includes("surfaces.mjs"), "the startup checks never reach the leaf");
});

test("install: the installer's item shape did not move when the states moved into surfaces.mjs", () => {
  const { home, root, proj } = installed();
  const a = analyseStampedFile(proj, sourceHarness().surfaces.statusline_launcher, { root, home, harness: sourceHarness() });
  assert.equal(a.state, "current");
  assert.equal(a.installedPkg, "0.28.0");
  const i = item(plan(proj, { home, root }), "statusline_launcher");
  assert.deepEqual([i.state, i.action, i.writtenBy], ["current", "skip", proj]);
});

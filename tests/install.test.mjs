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
import { plan, renderPreview, confirm, apply, runVerb } from "../scripts/install-harness.mjs";
import { detectHarnesses, harnessRefusal, sourceHarness } from "../scripts/harness.mjs";
import { stamp, sourceHash, parseProvenance } from "../scripts/provenance.mjs";
import {
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
function fakeInstall(home, version) {
  const root = join(home, SRC.runtime.home_default, "plugins", "cache", "SmartAndPoint", "projectstore", version);
  for (const d of ["scripts", ".claude-plugin", "templates", join("scaffold", "layouts")]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "statusline-launcher.mjs"), join(root, "scripts", "statusline-launcher.mjs"));
  writeFileSync(join(root, "scripts", "statusline.mjs"), `process.stdout.write("rendered-by-${version}\\n");\n`);
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version }));
  copyFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), join(root, "templates", "claude-md-block.md.tmpl"));
  copyFileSync(join(ROOT, "scaffold", "layouts", "engineering.json"), join(root, "scaffold", "layouts", "engineering.json"));
  return root;
}

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
  assert.ok(p.reports[0].includes("installed by the built-in plugin marketplace"), "host-managed surfaces are reported (contract 14)");
  assert.equal(item(p, "agents_block").action, "add");
  assert.equal(item(p, "agents_block").state, "ours-absent");
  assert.equal(item(p, "statusline").action, "create");
  assert.equal(item(p, "statusline_launcher").action, "create");
  assert.equal(item(p, "statusline_launcher").state, "absent");
  assert.equal(item(p, "mcp").action, "skip");
  assert.equal(item(p, "mcp").state, "unsupported");
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
  const p = plan(proj, { home, root: dev });
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

test("install contract 7: a launcher left behind by a cache install is pruned by a dev checkout's install, and a foreign one is left", () => {
  const { home, root, proj } = installed();
  const dev = mkdtempSync(join(tmpdir(), "ps-dev-"));
  mkdirSync(join(dev, "templates"), { recursive: true });
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  copyFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), join(dev, "templates", "claude-md-block.md.tmpl"));
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.0.0-dev" }));
  const p = plan(proj, { home, root: dev, surfaces: ["statusline"] });
  assert.equal(item(p, "statusline_launcher").action, "prune");
  apply(p);
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
    assert.ok(src.includes("install-harness.mjs"), `${f} invokes the verb`);
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

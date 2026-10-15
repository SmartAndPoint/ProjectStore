// projectstore — tests/user-text.test.mjs: the lint of user-facing text (the
// story "User-facing text says where to run and names no project path and no
// shell", PS-HARNESS; its Technical Notes, "The lint").
//
// It has two halves. The output half reads what a run prints for a person to
// type next, built with the code's own helpers on the suites' fixtures, and
// holds both Codex trees to rule (b). The file half reads what a person reads
// before any run: README, docs/, the shells' READMEs, the site's sources and
// dictionaries, the shells' npm descriptions and the manifests' install text.
//
// A command is a line, or a span, whose first token — after its indentation
// and any leading NAME=value assignments — is npx, npm, node, projectstore, a
// shell name (optionally @<v>), /projectstore:<name> or $projectstore-<name>.
// A bare package name is a name, not a command. The rules, each with one
// planted case below:
//   (a) no --project, except on a `projectstore mcp` line;
//   (b) no shell name as a command: `npx <shell>`, `<shell>@<v> <verb>`,
//       `<shell> <verb>`, `npm install -g <shell>`, `npm i <shell>`;
//   (c) in Markdown and site text, no command span followed directly by
//       `,` `.` `;` `:` or `)` (or their full-width forms on the Chinese page):
//       a copied comma broke the 0.29.1 upgrade;
//   (d) nothing after the command on its line. A finding's, an offer's and
//       the welcome's command stands alone on its line, after indentation; a
//       plan reason's, a DONE tip's, a manifest step's and an npm
//       description's ends its line. Every line after a rule-5 finding's
//       first is a command the test builds with the code's own helpers, or a
//       lead ending with `:`, and carries no indentation.
// Each failure names the output (or file) and its line.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  packageCommand,
  loadHarnesses,
  loadHarness,
  sourceHarness,
  invocation,
  resetDetection,
} from "../scripts/harness.mjs";
import { updateHint, inheritForm, commandForm, renderAgentsBlock, fromTerminalIn } from "../scripts/lib.mjs";
import {
  checkPluginRegistration,
  checkLayout,
  layoutRemedy,
  checkOverlays,
  checkAgentsBlock,
  checkHarnessSurfaces,
  checkPendingUpgrade,
  checkConfig,
} from "../scripts/doctor.mjs";
import { report } from "../scripts/doctor-report.mjs";
import { plan, apply, renderPreview, renderDone } from "../scripts/install-harness.mjs";
import { VERBS } from "../scripts/cli.mjs";
import { SHELLS } from "../packaging/shells.mjs";
import { planScaffold, renderScaffoldPlan } from "../scripts/scaffold.mjs";
import { planBind, applyBind, renderBindPlan, shellQuote } from "../scripts/binding.mjs";
import {
  fakeInstall,
  writeRegistry,
  legacyProject,
  preFlagInstall,
  fakePackageRoot,
  fakeClaude,
  installEnv,
} from "./fixtures/install.mjs";
import { installPlan, PROJECT, MODES } from "./fixtures/presentation.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { markdownLines } from "./fixtures/markdown.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const MANIFESTS = [...loadHarnesses().values()];
const CODEX = loadHarness("codex");
const VERSION = "0.30.0";
const TMP = mkdtempSync(join(tmpdir(), "ps-user-text-"));
const tmp = (p) => mkdtempSync(join(TMP, p));

// ─── The lint ───────────────────────────────────────────────────────────

const SHELL_NAMES = [
  ...new Set([...MANIFESTS.map((m) => m.install?.shell).filter(Boolean), ...SHELLS.map((s) => s.name)]),
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VERB_WORDS = VERBS.map((v) => esc(v.verb)).join("|");
// Rule (b)'s shapes, per shell: never a word inside a path (`/projectstore-codex/`).
const SHELL_AS_COMMAND = SHELL_NAMES.flatMap((s) => {
  const n = esc(s);
  return [
    new RegExp(`\\bnpx\\s+(?:-\\S+\\s+)*${n}(?![\\w-])`),
    new RegExp(`(?<![\\w/-])${n}@\\S+\\s+[a-z]`),
    new RegExp(`(?<![\\w/-])${n}\\s+(?:${VERB_WORDS})\\b`),
    new RegExp(`\\bnpm\\s+(?:install|i)\\s+(?:-g\\s+)?${n}(?![\\w-])`),
  ];
});
const MCP_LINE = /\bprojectstore(?:@\S+)? mcp\b/;

// Rules (a) and (b) over every line of a text.
function lintLines(name, text) {
  const out = [];
  String(text)
    .split("\n")
    .forEach((l, k) => {
      if (/--project\b/.test(l) && !MCP_LINE.test(l)) out.push(`${name}:${k + 1}: (a) --project: ${l}`);
      if (SHELL_AS_COMMAND.some((re) => re.test(l))) out.push(`${name}:${k + 1}: (b) a shell as a command: ${l}`);
    });
  return out;
}
// Rule (b) alone: what the Codex trees are held to.
const rulesB = (name, text) => lintLines(name, text).filter((x) => x.includes(": (b) "));

// Rule (d) over an output: `alone` commands stand alone on their line after
// indentation, `ends` commands end theirs. `rule5`: every line after the
// first is one of `alone` or a lead ending with `:`, unindented.
function lintOutput(name, text, { alone = [], ends = [], rule5 = false } = {}) {
  const out = lintLines(name, text);
  const lines = String(text).split("\n");
  const near = (c) => {
    const k = lines.findIndex((l) => l.includes(c));
    return k < 0 ? `${name}: (d) missing: ${c}` : `${name}:${k + 1}: (d) text beside the command: ${lines[k]}`;
  };
  for (const c of alone) if (!lines.some((l) => l.trim() === c)) out.push(near(c));
  for (const c of ends) if (!lines.some((l) => l.trimEnd().endsWith(c))) out.push(near(c));
  if (rule5)
    lines.forEach((l, k) => {
      if (!k) return;
      if (l !== l.trimStart()) out.push(`${name}:${k + 1}: (d) an indented line: ${l}`);
      else if (!alone.includes(l) && !l.endsWith(":"))
        out.push(`${name}:${k + 1}: (d) neither a lead nor a command: ${l}`);
    });
  return out;
}

// A command a person runs at a terminal, after any NAME="value" prefix.
const TERMINAL = /^(?:[A-Za-z_][A-Za-z0-9_]*="[^"]*" )*(?:npx|node) /;

// A rule-5 finding: its message (the rule-5 invariant), and doctor's text
// report of it, where no path follows a command and each command stands alone.
// A finding that carries a terminal command names its project's directory on
// its first line, quoted as fromTerminalIn quotes it (rule 1): `dir`.
function lintFinding(name, f, commands, dir = null) {
  const drawn = report([{ group: "install", ...f }], ["install"], { caps: MODES.plain, env: {} });
  const body = drawn.slice(drawn.indexOf(`[${f.check}]`), drawn.lastIndexOf("\nSummary:"));
  const out = [
    ...lintOutput(`${name} (message)`, f.message, { alone: commands, rule5: true }),
    ...lintOutput(`${name} (report)`, body, { alone: commands }),
  ];
  if (commands.some((c) => TERMINAL.test(c))) {
    const first = String(f.message).split("\n")[0];
    if (!dir) out.push(`${name}: a terminal command, and no directory given to check`);
    else if (!first.includes(fromTerminalIn(dir)))
      out.push(`${name}:1: (1) the first line names no directory: ${first}`);
  }
  return out;
}

// ─── Planted cases: each rule fails on its own, naming the place ────────

test("user text: each rule fails on one planted case and names its line; the near misses pass", () => {
  // (a): --project in output fails; mcp's own line keeps it.
  const a = lintLines("planted", 'Upgrade:\nnpx projectstore upgrade --project "$PWD"');
  assert.deepEqual(a, ['planted:2: (a) --project: npx projectstore upgrade --project "$PWD"']);
  assert.deepEqual(lintLines("mcp", 'npx projectstore mcp --project "$PWD"'), []);
  // (b): a copy of a Codex skill that names the shell as a command fails, and
  // so does an npm install of a shell; the package's name alone in prose
  // passes. A Codex tree is read for rule (b) only: its skills' command lines
  // keep --project "$PWD" (the story's rule 3).
  const skill = readFileSync(join(ROOT, "adapters", "codex", "skills", "projectstore-bind", "SKILL.md"), "utf8");
  assert.deepEqual(rulesB("SKILL.md", skill), [], "the generated skill passes");
  const planted = skill.replace(
    "Codex plugin updates are",
    "Codex plugin updates: run `projectstore-codex upgrade`. They are",
  );
  assert.notEqual(planted, skill, "the plant applies");
  const b = rulesB("SKILL.md", planted);
  assert.equal(b.length, 1, b.join("\n"));
  assert.match(b[0], /^SKILL\.md:\d+: \(b\) a shell as a command: .*projectstore-codex upgrade/);
  assert.equal(lintLines("docs", "Install it: npm install -g projectstore-claude").length, 1);
  assert.deepEqual(
    lintLines("docs", "projectstore-claude is the Claude Code shell; npx projectstore setup runs it."),
    [],
  );
  // (d): today's doctor text — the path after the command — fails.
  const cmd = packageCommand(SRC, "upgrade", { version: VERSION, args: "--surface plugin" });
  const d = lintOutput("doctor", `  ▲ [plugin-registration] e — stale: r. Refresh it: ${cmd} — reg/x.json`, {
    alone: [cmd],
  });
  assert.deepEqual(d, [
    `doctor:1: (d) text beside the command:   ▲ [plugin-registration] e — stale: r. Refresh it: ${cmd} — reg/x.json`,
  ]);
  // (d), rule 4's invariant: a two-paragraph finding whose second lead ends in "." fails.
  const two = [`Go back, ${fromTerminalIn("/p")}:`, cmd, "Restart, then in the session.", "/projectstore:doctor --fix"];
  const inv = lintOutput("finding", two.join("\n"), { alone: [cmd, "/projectstore:doctor --fix"], rule5: true });
  assert.deepEqual(inv, ["finding:3: (d) neither a lead nor a command: Restart, then in the session."]);
  assert.deepEqual(
    lintOutput("finding", two.join("\n").replace("session.", "session:"), {
      alone: [cmd, "/projectstore:doctor --fix"],
      rule5: true,
    }),
    [],
  );
});

// ─── packageCommand, updateHint ─────────────────────────────────────────

test("user text: packageCommand is the core's form for every manifest and every install-family verb, one --harness per manifest", () => {
  const verbs = ["setup", "install", "upgrade", "uninstall", "plan"];
  const bad = [];
  for (const m of MANIFESTS)
    for (const verb of verbs)
      for (const version of [null, "latest", VERSION]) {
        const c = packageCommand(m, verb, { version });
        assert.equal(c, `npx projectstore${version ? `@${version}` : ""} ${verb} --harness ${m.id}`);
        bad.push(...lintLines(`packageCommand(${m.id}, ${verb})`, c));
      }
  assert.deepEqual(bad, []);
  // Two harnesses give two --harness, in the order given.
  assert.equal(
    packageCommand([SRC, CODEX], "plan", { args: "--verbose" }),
    `npx projectstore plan --harness ${SRC.id} --harness ${CODEX.id} --verbose`,
  );
  // A verb that takes no --harness names none.
  assert.equal(packageCommand([], "status"), "npx projectstore status");
});

test("user text: updateHint under every identity fills {upgrade} with the core's form, alone on its line in the line and the welcome", () => {
  const identities = [
    {},
    ...MANIFESTS.map((m) => ({ PROJECTSTORE_HARNESS: m.id })),
    ...SHELL_NAMES.map((s) => ({ PROJECTSTORE_SHELL: s })),
  ];
  const bad = [];
  let filled = 0;
  for (const env of identities) {
    const h = updateHint({ env });
    const id = env.PROJECTSTORE_HARNESS || MANIFESTS.find((m) => m.install?.shell === env.PROJECTSTORE_SHELL)?.id;
    const m = loadHarness(id) || SRC;
    const holds = JSON.stringify(m.update_hint || {}).includes("{upgrade}");
    const alone = holds ? [packageCommand(m, "upgrade", { version: "latest" })] : [];
    filled += alone.length;
    const name = `updateHint(${JSON.stringify(env)})`;
    bad.push(
      ...lintOutput(`${name}.line`, h.line, { alone }),
      ...lintOutput(`${name}.welcome`, h.welcome.join("\n"), { alone }),
    );
  }
  assert.deepEqual(bad, []);
  assert.ok(filled >= 2, "a hint that holds {upgrade} is checked");
  // The criterion's literal, under Codex's identity.
  const codex = updateHint({ env: { PROJECTSTORE_HARNESS: CODEX.id } });
  assert.equal(codex.line, "Update from a terminal in this project:\nnpx projectstore@latest upgrade --harness codex");
  assert.ok(codex.welcome.includes("npx projectstore@latest upgrade --harness codex"), codex.welcome.join("\n"));
  // Claude Code's hint follows the copy's channel (the docs story's rule for
  // the welcome): a checkout, the npm registration's cache and its in-place
  // directory get the npm form; a git-marketplace copy keeps the host's toggle.
  const home = mkdtempSync(join(tmpdir(), "ps-ut-hint-"));
  const cc = (root) => updateHint({ env: { PROJECTSTORE_HARNESS: SRC.id }, root, home }).line;
  const npmForm = `Update from a terminal in this project:\n${packageCommand(SRC, "upgrade", { version: "latest" })}`;
  const cache = (mp) => join(home, ".claude", "plugins", "cache", mp, "projectstore", "0.30.0");
  assert.equal(cc(ROOT), npmForm, "a checkout");
  assert.equal(cc(cache(SRC.surfaces.plugin.marketplace_name)), npmForm, "the npm registration's cache copy");
  assert.equal(
    cc(join(home, ".claude", "projectstore", "marketplace", "projectstore")),
    npmForm,
    "the npm directory, in place",
  );
  // …named, with its default, from the copy's own path (PS-DIRECTORY, "A copy
  // installed from Anthropic's directory…", decision 4).
  const sap = (t) => t.split("{marketplace}").join("SmartAndPoint").split("{auto_update}").join("off");
  assert.equal(
    cc(cache("SmartAndPoint")),
    sap(SRC.update_hint.by_channel.marketplace.line),
    "the git marketplace keeps the toggle",
  );
  const welcome = (root) => updateHint({ env: { PROJECTSTORE_HARNESS: SRC.id }, root, home }).welcome;
  assert.deepEqual(welcome(cache("SmartAndPoint")), SRC.update_hint.by_channel.marketplace.welcome.map(sap));
  assert.ok(!welcome(ROOT).join("\n").includes("auto-update"), "the npm welcome names no host toggle");
  assert.ok(
    welcome(ROOT).includes(packageCommand(SRC, "upgrade", { version: "latest" })),
    "its command alone on its line",
  );
  rmSync(home, { recursive: true, force: true });
});

// ─── DONE's tips, the deferred reasons ─────────────────────────────────

test("user text: DONE's tip is one core plan command over every planned harness, a kept harness's tip its copy's own plan; neither names --project, and a project elsewhere is named in the lead", () => {
  const p = installPlan();
  const done = (opts, plan_ = p) =>
    renderDone({ verb: "upgrade", plan: plan_, applied: [], failed: null, elapsed: 0 }, { caps: MODES.plain, ...opts });
  const core = packageCommand([SRC, CODEX], "plan", { args: "--verbose" });
  assert.equal(core, "npx projectstore plan --harness claude-code --harness codex --verbose");
  const bad = [
    ...lintOutput("done (here)", done({ cwd: PROJECT }), { alone: [core] }),
    ...lintOutput("done (elsewhere)", done({ cwd: "/elsewhere" }), { alone: [core] }),
    ...lintOutput("done (--verbose)", done({ cwd: PROJECT, verbose: true }), {
      alone: [packageCommand([SRC, CODEX], "plan")],
    }),
  ];
  assert.ok(done({ cwd: "/elsewhere" }).includes(`\n  To preview without writing, ${fromTerminalIn(PROJECT)}:\n\n`));
  assert.ok(done({ cwd: PROJECT }).includes("\n  To preview without writing, with every row's reasoning:\n\n"));
  // A kept harness: the core tip leaves it out, and its own copy's plan follows.
  const bin = "/home/ada/.claude/plugins/cache/SmartAndPoint/projectstore/0.29.0/bin/projectstore.mjs";
  const kept = {
    ...p,
    items: [
      ...p.items,
      {
        kind: "channel",
        harness: SRC.id,
        kept: { key: "projectstore@SmartAndPoint", version: "0.29.0", bin, verbose: true },
      },
    ],
  };
  const keep = done({ cwd: PROJECT }, kept);
  const ownTip = `node "${bin}" plan --harness ${SRC.id} --no-register --verbose`;
  bad.push(
    ...lintOutput("done (kept)", keep, { alone: [packageCommand([CODEX], "plan", { args: "--verbose" }), ownTip] }),
  );
  assert.ok(!keep.includes(`--harness ${SRC.id} --harness`), keep);
  assert.deepEqual(bad, []);
});

test("user text: the deferred registration reasons end with the core's form, alone after a lead naming the directory, in the envelope and in PLAN", () => {
  const home = tmp("home-");
  const proj = tmp("proj-");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: "/tmp/nowhere", layout: "engineering" });
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const host = fakeClaude(tmp("bin-"));
  const env = host.env();
  const item = (p) => p.items.find((i) => i.surface === "plugin");
  const bad = [];
  // A host cache root asked for the surface, with nothing registered.
  const absent = item(
    plan(proj, { home, root: fakeInstall(home, "0.28.0", { full: true }), env, surfaces: ["plugin"] }),
  );
  assert.match(absent.reason, /does not register a second copy of itself/);
  const install = packageCommand(SRC, "install");
  bad.push(...lintOutput("reason (absent)", absent.reason, { alone: [install], ends: [install] }));
  // A registration made from the package, then read from a newer host cache root: stale.
  const pkg = fakePackageRoot(join(tmp("npx-"), "node_modules", "projectstore"), "0.28.0");
  apply(plan(proj, { home, root: pkg, env }), { env, home });
  const fromCache = plan(proj, { home, root: fakeInstall(home, "0.28.1", { full: true }), env });
  const stale = item(fromCache);
  assert.equal(stale.deferred, true);
  const upgrade = packageCommand(SRC, "upgrade", { version: "<version>", args: "--surface plugin" });
  bad.push(...lintOutput("reason (stale)", stale.reason, { alone: [upgrade], ends: [upgrade] }));
  assert.ok(stale.reason.includes(`${fromTerminalIn(proj)}, outside a session:\n${upgrade}`), stale.reason);
  bad.push(...lintOutput("PLAN (stale)", renderPreview(fromCache, { caps: MODES.plain }), { alone: [upgrade] }));
  // Inside the host's own session the registration defers and names the run's
  // own command (the install spec, contract 6, as amended 2026-10-14).
  const other = tmp("proj-");
  mkdirSync(join(other, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(other, { vault_path: "/tmp/nowhere", layout: "engineering" });
  const inside = plan(other, { home, root: pkg, env: { ...env, [SRC.runtime.session_env[0]]: "1" } });
  const deferred = item(inside);
  assert.equal(deferred.deferred, true);
  const run = `npx projectstore install --harness ${SRC.id}`;
  bad.push(...lintOutput("reason (in session)", deferred.reason, { alone: [run], ends: [run] }));
  assert.ok(deferred.reason.includes(`\nFrom a terminal in ${JSON.stringify(other)}:\n${run}`), deferred.reason);
  bad.push(...lintOutput("PLAN (in session)", renderPreview(inside, { caps: MODES.plain }), { alone: [run] }));
  assert.deepEqual(bad, []);
});

// ─── The rule-5 findings, on fixtures ──────────────────────────────────

test("user text: the plugin-registration findings — stale, registered, two copies, silenced — end with the core's form alone on its line, the directory in prose", () => {
  const proj = tmp("reg-proj-");
  const bad = [];
  for (const m of MANIFESTS.filter((x) => x.surfaces?.plugin?.kind === "registration")) {
    const base = { kind: "registration", harness: m.id, surface: "plugin", pkg: VERSION, entry: "e", path: "x" };
    const refresh = packageCommand(m, "upgrade", { version: VERSION, args: "--surface plugin" });
    const [stale] = checkPluginRegistration(proj, [{ ...base, state: "stale", reason: "r" }], { speaker: m });
    bad.push(...lintFinding(`${m.id} stale`, stale, [refresh], proj));
    assert.ok(stale.message.endsWith(`Refresh it ${fromTerminalIn(proj)}:\n${refresh}`), stale.message);
    const current = { ...base, state: "current", installedVersion: VERSION, installPath: "/i", payload: "/i/p" };
    const [registered] = checkPluginRegistration(proj, [current], { speaker: m });
    bad.push(...lintFinding(`${m.id} registered`, registered, [refresh], proj));
    const [two] = checkPluginRegistration(proj, [{ ...current, others: [{ key: "o@m", version: "0.1.0" }] }], {
      speaker: m,
    });
    bad.push(
      ...lintFinding(`${m.id} two copies`, two, [packageCommand(m, "install", { args: "--surface plugin" })], proj),
    );
  }
  // The silenced copy: three paragraphs, each ending with its command.
  const home = tmp("reg-home-");
  const other = fakeInstall(home, "0.27.1");
  writeRegistry(home, [
    { scope: "local", projectPath: proj, installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" },
  ]);
  const silenced = checkPluginRegistration(
    proj,
    [
      {
        kind: "registration",
        harness: SRC.id,
        surface: "plugin",
        state: "current",
        silenced: ["projectstore@SmartAndPoint"],
        pkg: VERSION,
        path: join(home, "reg"),
        entry: "projectstore@projectstore-npm",
        installedVersion: VERSION,
        installPath: join(home, "cache"),
      },
    ],
    { home, speaker: SRC },
  ).find((f) => /is off for this checkout/.test(f.message));
  const way = [
    packageCommand(SRC, "uninstall", { version: VERSION, args: "--surface plugin" }),
    invocation(SRC, "doctor", { args: "--fix" }),
    "npx projectstore setup --channel npm",
  ];
  bad.push(...lintFinding("silenced", silenced, way, proj));
  assert.deepEqual(silenced.message.split("\n").slice(1), [
    way[0],
    "Restart, then in the session:",
    way[1],
    "If moving to npm was meant, record it from a terminal in this project:",
    way[2],
  ]);
  assert.ok(
    silenced.message.split("\n")[0].endsWith(`To go back to it, ${fromTerminalIn(proj)}, outside the session:`),
  );
  assert.deepEqual(bad, []);
});

test("user text: layout-legacy in both forms, agents-in-binding, agents-block and surface end with their command alone on its line, no --project; the npm form is decision 5's", () => {
  const bad = [];
  // A git-marketplace copy: its own bin.
  const home = tmp("lay-home-");
  const git = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: git, version: VERSION, lastUpdated: new Date().toISOString() }]);
  const { proj } = legacyProject(home);
  const own = layoutRemedy(proj, { root: git, home }).command;
  assert.equal(own, `node "${join(git, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register`);
  bad.push(...lintFinding("layout-legacy (own)", checkLayout(proj, undefined, { root: git, home })[0], [own], proj));
  // The package's own registration: the core's npm form.
  const npm = fakeInstall(home, VERSION, { marketplace: SRC.surfaces.plugin.marketplace_name });
  const npmForm = layoutRemedy(proj, { root: npm, home }).command;
  assert.equal(npmForm, `npx projectstore@${VERSION} upgrade --harness claude-code --no-register`);
  bad.push(
    ...lintFinding("layout-legacy (npm)", checkLayout(proj, undefined, { root: npm, home })[0], [npmForm], proj),
  );
  // The startup offer: the re-stamp sentence before the command.
  const offer = checkLayout(proj, undefined, { root: git, home, level: "info", restamp: true })[0];
  bad.push(...lintFinding("layout-legacy (offer)", offer, [own], proj));
  assert.match(offer.message.split("\n")[0], /The same run re-stamps the status line launcher\. Migrate it /);
  // The npm registration's copy that predates --no-register: its refresh, in the core's form.
  const flagHome = tmp("lay-flag-");
  const { proj: proj2 } = legacyProject(flagHome);
  const npx = join(flagHome, ".npm", "_npx", "x", "node_modules", "projectstore");
  mkdirSync(join(npx, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(npx, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "projectstore", version: "0.28.1" }),
  );
  const rc2 = preFlagInstall(flagHome, "0.28.0-rc.2", { marketplace: SRC.surfaces.plugin.marketplace_name });
  writeRegistry(flagHome, [
    {
      scope: "local",
      projectPath: proj2,
      installPath: rc2,
      version: "0.28.0-rc.2",
      lastUpdated: "2026-09-09T00:00:00Z",
    },
  ]);
  const refresh = layoutRemedy(proj2, { root: npx, home: flagHome }).refresh;
  assert.equal(refresh, `npx projectstore@0.28.1 upgrade --harness ${SRC.id}`);
  bad.push(
    ...lintFinding(
      "layout-legacy (refresh)",
      checkLayout(proj2, undefined, { root: npx, home: flagHome })[0],
      [refresh],
      proj2,
    ),
  );
  // agents-in-binding: the move's command, from a checkout's own bin.
  const cfg = JSON.parse(readFileSync(join(proj, SRC.runtime.harness_dir, "projectstore.json"), "utf8"));
  const emptyHome = tmp("ov-home-");
  const binding = checkOverlays(cfg, proj, { root: ROOT, home: emptyHome }).find(
    (f) => f.check === "agents-in-binding",
  );
  const move = layoutRemedy(proj, { root: ROOT, home: emptyHome }).command;
  bad.push(...lintFinding("agents-in-binding", binding, [move], proj));
  // agents-block: a block Claude Code cannot see.
  const only = tmp("ab-proj-");
  mkdirSync(join(only, SRC.runtime.harness_dir), { recursive: true });
  const tmpl = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
  writeFileSync(join(only, "AGENTS.md"), renderAgentsBlock(tmpl, null) + "\n");
  const unseen = checkAgentsBlock(only, { env: { [SRC.runtime.session_env[0]]: "1" }, root: ROOT }).find((f) =>
    /does not see/.test(f.message),
  );
  const install = `node "${join(ROOT, "bin", "projectstore.mjs")}" install --harness ${SRC.id} --surface agents_block`;
  bad.push(...lintFinding("agents-block", unseen, [install], only));
  assert.deepEqual(bad, []);
});

test("user text: the agents-block states and the shared surface's row end with their in-session command alone on its line", async () => {
  const bad = [];
  const register = commandForm("agents", { args: "register" });
  const tmpl = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
  const block = renderAgentsBlock(tmpl, null);
  const states = (files) => {
    const p = tmp("abs-");
    for (const [n, t] of Object.entries(files)) writeFileSync(join(p, n), t);
    return checkAgentsBlock(p, { env: {}, root: ROOT }).filter((f) => f.check === "agents-block");
  };
  const [open] = block.split("\n");
  // Wrapped: the open marker's `-->` on the next line.
  const wrapped = states({ "AGENTS.md": block.replace(open, open.replace(/ ?-->$/, "\n-->")) });
  // Unclosed: the block's last line, the close marker, gone.
  const unclosed = states({ "AGENTS.md": block.split("\n").slice(0, -1).join("\n") + "\n" });
  // Both files, and a stale version.
  const both = states({ "AGENTS.md": block + "\n", "CLAUDE.md": block + "\n" });
  const stale = states({ "AGENTS.md": block.replace(/projectstore:agents v(\d+) /, "projectstore:agents v1 ") + "\n" });
  const none = states({ "AGENTS.md": "# Mine\n" });
  const cases = {
    wrapped: wrapped.find((f) => /does not close on its own line/.test(f.message)),
    unclosed: unclosed.find((f) => /opens and never closes/.test(f.message)),
    "both files": both.find((f) => /in both CLAUDE\.md and AGENTS\.md/.test(f.message)),
    "stale version": stale.find((f) => /is v1, expected v/.test(f.message)),
  };
  for (const [name, f] of Object.entries(cases)) {
    assert.ok(f, `${name}: the finding is there`);
    bad.push(...lintFinding(`agents-block ${name}`, f, [register]));
  }
  const routing = none.find((f) => /not registered/.test(f.message));
  bad.push(...lintFinding("agents-block not registered", routing, [commandForm("agents")]));
  // The shared surface's [projectstore:agents] row, in the listener's form.
  const proj = tmp("shared-");
  const read = {
    result: {
      used: MANIFESTS.map((h) => h.id),
      states: [
        {
          harness: SRC.id,
          surface: "agents_block",
          kind: "shared",
          path: join(proj, "AGENTS.md"),
          state: "ours-stale",
          produced: true,
          reason: "content differs at the same version",
        },
      ],
    },
    FOREIGN_TEXT: "foreign",
  };
  for (const speaker of MANIFESTS) {
    const [row] = await checkHarnessSurfaces(null, proj, { read, speaker });
    bad.push(
      ...lintFinding(`[projectstore:agents] (${speaker.id})`, row, [
        invocation(speaker, "agents", { args: "register" }),
      ]),
    );
  }
  assert.deepEqual(bad, []);
});

test("user text: a stale surface ends with its reinstall, and the status line's step is a paragraph of its own", async () => {
  const proj = tmp("surf-");
  const states = MANIFESTS.map((h) => ({
    harness: h.id,
    surface: "hooks",
    kind: "exclusive",
    path: join(proj, `${h.id}-x.json`),
    state: "stale",
    produced: true,
    reason: "stamped by another version",
  }));
  const read = { result: { used: MANIFESTS.map((h) => h.id), states }, FOREIGN_TEXT: "foreign" };
  const bad = [];
  for (const speaker of MANIFESTS) {
    const out = await checkHarnessSurfaces(null, proj, { read, speaker });
    for (const h of MANIFESTS) {
      const f = out.find((x) => x.file === `${h.id}-x.json`);
      const commands = [`node "${join(ROOT, "bin", "projectstore.mjs")}" install --harness ${h.id} --surface hooks`];
      if (h.surfaces?.statusline?.supported !== false) commands.push(invocation(h, "statusline", { args: "on" }));
      bad.push(...lintFinding(`surface ${h.id} (${speaker.id} listening)`, f, commands, proj));
    }
  }
  assert.deepEqual(bad, []);
});

// ─── The offers and the welcome ────────────────────────────────────────

test("user text: the pending-upgrade offer ends with the doctor --fix form alone on its line", () => {
  const home = tmp("pend-");
  const root = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: root, version: VERSION, lastUpdated: new Date().toISOString() }]);
  const { proj } = legacyProject(home);
  const [offer] = checkPendingUpgrade(proj, home, root, SRC);
  assert.ok(offer, "the launcher predates the stamps");
  assert.deepEqual(lintFinding("upgrade offer", offer, [commandForm("doctor", { args: "--fix" })]), []);
  assert.ok(offer.message.endsWith(`Re-stamp it once, in the session:\n${commandForm("doctor", { args: "--fix" })}`));
});

// A line that holds one of our commands is that command, alone after any
// NAME="value" prefix (rule (d) for the startup line).
const HOLDS_COMMAND = /\bnpx |\bnode "|\/projectstore:[a-z]|\$projectstore-[a-z]/;
const STARTS_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*="[^"]*" )*(?:npx |node "|\/projectstore:[a-z]|\$projectstore-[a-z])/;
const commandsAlone = (name, text) =>
  String(text)
    .split("\n")
    .flatMap((l, k) =>
      HOLDS_COMMAND.test(l) && !STARTS_COMMAND.test(l) ? [`${name}:${k + 1}: (d) a command beside text: ${l}`] : [],
    );

test("user text: a startup with the welcome and an offer puts each part on lines of its own, every command alone on its line", () => {
  const home = realpathSync(tmp("start-home-"));
  const root = fakeInstall(home, VERSION, { full: true });
  writeRegistry(home, [{ scope: "user", installPath: root, version: VERSION, lastUpdated: new Date().toISOString() }]);
  const { proj, lp } = legacyProject(home);
  rmSync(lp.legacy.welcomed, { force: true });
  const r = spawnSync(process.execPath, [join(root, "hooks", "session-start.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ut-start", source: "startup", cwd: proj }),
    // A cache of its own: a machine marker another test's unbound run left in
    // the shared one would silence this welcome.
    env: installEnv(home, root, proj, { XDG_CACHE_HOME: tmp("start-cache-") }),
    cwd: proj,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const sys = JSON.parse(r.stdout || "{}").systemMessage || "";
  assert.ok(sys.startsWith("👋 projectstore: first-run welcome shown. Bound to "), sys);
  assert.match(sys, /\nprojectstore: The project layout moved to \.projectstore\//, sys);
  // The move's own-bin command, alone on its line (a relocated home's prefix may lead it).
  const own = `node "${join(root, "bin", "projectstore.mjs")}" upgrade --harness ${SRC.id} --no-register`;
  assert.ok(
    sys.split("\n").some((l) => l === own || (TERMINAL.test(l) && l.endsWith(` ${own}`))),
    sys,
  );
  assert.deepEqual(commandsAlone("startup", sys), []);
  assert.deepEqual(lintLines("startup", sys), []);
  // Not vacuous: the 0.29.3 join puts text after a command.
  assert.ok(commandsAlone("joined", sys.split("\n").join(" · ")).length > 0);
});

// Each startup on a machine of its own (a fresh user-level cache): an unbound
// project remembers its welcome on the machine (the story "Opening a project
// that is not bound writes nothing into it…"), so through a shared cache the
// first unbound run would silence every later welcome of that harness, and the
// lints below would pass with nothing to check.
function fireStartup(proj, env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|PROJECTSTORE_(HARNESS|IDENTIFIED|SHELL))/.test(k)),
  );
  const r = spawnSync(process.execPath, [join(ROOT, "hooks", "session-start.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ut-1", source: "startup", cwd: proj }),
    env: { ...clean, [SRC.runtime.project_dir_env]: proj, XDG_CACHE_HOME: tmp("ut-cache-"), ...env },
    cwd: proj,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout || "{}").systemMessage || "";
}

test("user text: both welcome variants, the worktree offer and doctor's worktree-unbound finding hold each command alone on its line, under every harness", () => {
  const bad = [];
  for (const m of MANIFESTS) {
    const env = { PROJECTSTORE_HARNESS: m.id };
    const hint = updateHint({ env });
    const upgrade = JSON.stringify(m.update_hint || {}).includes("{upgrade}")
      ? [packageCommand(m, "upgrade", { version: "latest" })]
      : [];
    // Unbound: "Start with:", the bind form alone, the hint on lines of its own.
    const unbound = tmp("wel-");
    mkdirSync(join(unbound, m.runtime.harness_dir), { recursive: true });
    const a = fireStartup(unbound, env);
    const bind = invocation(m, "bind", { args: "<vault-path>" });
    bad.push(...lintOutput(`welcome unbound (${m.id})`, a, { alone: [bind, ...upgrade] }));
    assert.equal(
      a,
      [`👋 projectstore: first-run welcome shown. Start with:`, bind, hint.line].filter(Boolean).join("\n"),
    );
    // Bound: "Bound to <vault>." and the hint, multi-line where the hint is.
    const bound = tmp("welb-");
    mkdirSync(join(bound, m.runtime.harness_dir), { recursive: true });
    const vault = tmp("welv-");
    writeBinding(bound, { vault_path: vault, layout: "engineering", language: "en" });
    const b = fireStartup(bound, env);
    bad.push(...lintOutput(`welcome bound (${m.id})`, b, { alone: upgrade }));
    assert.ok(b.startsWith(`👋 projectstore: first-run welcome shown. Bound to ${vault}. ${hint.line}`), b);
  }
  // The worktree offer: what binding does, then the inherit form alone on its line.
  const root = tmp("wt-");
  const main = join(root, "main"),
    child = join(root, "child"),
    vault = join(root, "vault");
  mkdirSync(main, { recursive: true });
  mkdirSync(join(vault, "epics"), { recursive: true });
  const g = (args, cwd = main) => spawnSync("git", args, { cwd, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(main, ".gitignore"), ".claude/\n.projectstore/\n");
  writeFileSync(join(main, "f.md"), "hi\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  mkdirSync(join(main, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(main, { vault_path: vault, layout: "engineering", language: "en" });
  g(["worktree", "add", "-q", child, "-b", "feat"]);
  for (const m of MANIFESTS) {
    const env = { PROJECTSTORE_HARNESS: m.id };
    const offer = fireStartup(child, env);
    const form = inheritForm(vault, { layout: "engineering", language: "en", env });
    bad.push(...lintOutput(`worktree offer (${m.id})`, offer, { alone: [form] }));
    assert.ok(offer.startsWith("projectstore: this worktree is unbound. "), offer);
    assert.equal(offer.split("\n")[1], form, offer);
    // Doctor's worktree-unbound finding: the same form alone on its last
    // line, after what binding does in this harness. Its identity is read
    // from this process, so it is set here for the call.
    const saved = process.env.PROJECTSTORE_HARNESS;
    process.env.PROJECTSTORE_HARNESS = m.id;
    resetDetection();
    try {
      const [wt] = checkConfig(null, child);
      assert.equal(wt.check, "worktree-unbound");
      bad.push(...lintFinding(`worktree-unbound (${m.id})`, wt, [form]));
      const does = m.capabilities?.bind_inherit
        ? "Adopt that binding"
        : "Bind it to the same vault, layout and language";
      assert.ok(wt.message.split("\n")[0].endsWith(`${does}, in the session:`), wt.message);
    } finally {
      if (saved === undefined) delete process.env.PROJECTSTORE_HARNESS;
      else process.env.PROJECTSTORE_HARNESS = saved;
      resetDetection();
    }
  }
  assert.deepEqual(bad, []);
});

// ─── bind's and scaffold's texts ───────────────────────────────────────

// The bin, spawned with no identity of the caller's: a refusal on stderr.
function cli(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|PROJECTSTORE_(HARNESS|IDENTIFIED|SHELL))/.test(k)),
  );
  return spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), ...args], {
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

test("user text: scaffold's plan and refusals, the not-bound refusal and the vault's finishing remedy end with each form alone on its line, the directory in the lead", () => {
  const bad = [];
  const scaffold = commandForm("scaffold", { env: {} });
  const write = packageCommand([], "scaffold", { args: "--write" });
  const bind = commandForm("bind", { args: "<vault>", env: {} });
  // The bare plan's closing lines.
  const proj = tmp("sc-proj-");
  const vault = tmp("sc-vault-");
  const plan_ = planScaffold(vault, { layout: "engineering", language: "en", root: ROOT });
  const text = renderScaffoldPlan(plan_, null, { env: {}, project: proj });
  bad.push(...lintOutput("scaffold plan", text, { alone: [scaffold, write] }));
  assert.ok(text.includes(`\nTo write them, in a session or ${fromTerminalIn(proj)}:\n\n`), text);
  // Not bound (exit 3): bind in a session, or bind or init at a terminal.
  const unbound = tmp("nb-");
  const u = cli(["scaffold", "--project", unbound]);
  assert.equal(u.status, 3, u.stderr);
  const nb = [bind, packageCommand([], "bind", { args: "<vault>" }), packageCommand([], "init", { args: "<vault>" })];
  bad.push(...lintOutput("not bound", u.stderr.trimEnd(), { alone: nb, rule5: true }));
  assert.ok(u.stderr.split("\n")[0].includes(fromTerminalIn(unbound)), u.stderr);
  // The binding names no usable vault: rebind.
  const blank = tmp("nv-");
  writeBinding(blank, { vault_path: "", layout: "engineering" });
  const n = cli(["scaffold", "--project", blank]);
  assert.equal(n.status, 1, n.stderr);
  const rebind = [bind, packageCommand([], "bind", { args: "<vault> --rebind" })];
  bad.push(...lintOutput("no usable vault", n.stderr.trimEnd(), { alone: rebind, rule5: true }));
  assert.ok(n.stderr.split("\n")[0].includes(fromTerminalIn(blank)), n.stderr);
  // The vault named by the binding is gone: init recreates it.
  const gone = tmp("gv-");
  const goneVault = join(TMP, `gone-${process.pid}`);
  writeBinding(gone, { vault_path: goneVault, layout: "engineering" });
  const g = cli(["scaffold", "--project", gone]);
  assert.equal(g.status, 1, g.stderr);
  const init = packageCommand([], "init", { args: goneVault });
  bad.push(...lintOutput("vault gone", g.stderr.trimEnd(), { alone: [init], rule5: true }));
  assert.ok(g.stderr.split("\n")[0].includes(fromTerminalIn(gone)), g.stderr);
  // init's scaffold fails after the binding is written: the remedy, in bind's text and in --json.
  if (process.getuid?.() !== 0) {
    const ip = tmp("if-");
    const iv = tmp("if-vault-");
    chmodSync(iv, 0o555);
    try {
      const bp = planBind(ip, { vault: iv, init: true, env: {}, root: ROOT });
      assert.equal(bp.ok, true, JSON.stringify(bp.refusals));
      const done = applyBind(bp, { env: {} });
      assert.ok(done.scaffold?.failed, JSON.stringify(done.scaffold));
      const finish = [scaffold, write];
      bad.push(...lintOutput("finish remedy", done.scaffold.remedy, { alone: finish, rule5: true }));
      assert.ok(done.scaffold.remedy.split("\n")[0].includes(fromTerminalIn(bp.projectDir)), done.scaffold.remedy);
      bad.push(
        ...lintOutput("bind's text", renderBindPlan(bp, done, { env: {}, caps: MODES.plain }), { alone: finish }),
      );
    } finally {
      chmodSync(iv, 0o755);
    }
  }
  // init's git init fails (a stand-in git): the remedy names the vault, then
  // git's command and doctor's fix, each alone on its line — the commands
  // setup's ▲ row names for the same failure.
  const gp = tmp("gi-");
  const gv = tmp("gi-vault-");
  const gb = planBind(gp, { vault: gv, init: true, env: {}, root: ROOT });
  assert.equal(gb.ok, true, JSON.stringify(gb.refusals));
  const failingGit = (cmd, args) =>
    args[0] === "init"
      ? { status: 128, stdout: "", stderr: "fatal: cannot mkdir .git: Read-only file system" }
      : { status: 128, stdout: "", stderr: "fatal: not a git repository" };
  const gd = applyBind(gb, { env: {}, spawn: failingGit });
  assert.ok(gd.git?.failed, JSON.stringify(gd.git));
  const gitCommands = [
    `git -C ${shellQuote(String(gb.vault))} init`,
    commandForm("doctor", { args: "--fix", env: {} }),
  ];
  bad.push(...lintOutput("git init remedy", gd.git.remedy, { alone: gitCommands, rule5: true }));
  assert.ok(
    gd.git.remedy.startsWith(`Run git init in ${JSON.stringify(String(gb.vault))} from a terminal`),
    gd.git.remedy,
  );
  bad.push(
    ...lintOutput("bind's text (git)", renderBindPlan(gb, gd, { env: {}, caps: MODES.plain }), { alone: gitCommands }),
  );
  assert.deepEqual(bad, []);
});

// ─── Rule (b) over both Codex trees ────────────────────────────────────

test("user text: configure's view and its rebind refusal put each command alone on its line, the directory in the lead, no --project", async () => {
  const { runConfigure } = await import("../scripts/configure.mjs");
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "ps-ut-cfg-")));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "ps-ut-cfg-v-")));
  writeBinding(proj, { vault_path: vault, layout: "engineering" });
  const chunks = [];
  const stdout = { isTTY: false, write: (x) => (chunks.push(String(x)), true) };
  const run = (values) => runConfigure({ values, project: proj, env: {}, stdin: null, stdout, root: ROOT });
  await run({});
  const view = chunks.join("");
  const commands = [
    packageCommand([], "configure"),
    packageCommand([], "configure", { args: "--set <key>=<value>" }),
    packageCommand([], "bind", { args: "<vault> --rebind" }),
    packageCommand([], "init", { args: "<vault> --rebind" }),
  ];
  assert.deepEqual(lintOutput("configure view", view, { alone: commands }), []);
  assert.ok(view.includes(fromTerminalIn(proj)), "the view's lead names the directory");
  const r = await run({ set: ["vault=/x"] });
  assert.equal(r.code, 2);
  assert.deepEqual(lintOutput("configure rebind refusal", r.usage, { alone: [commands[2]] }), []);
  assert.ok(r.usage.split("\n")[0].includes(fromTerminalIn(proj)));
});

test("user text, rule (b): neither Codex tree names a shell as a command", () => {
  const trees = [
    join(ROOT, "adapters", "codex"),
    join(ROOT, "packaging", "shells", "projectstore-codex", "skills"),
    join(ROOT, "packaging", "shells", "projectstore-codex", "hooks"),
  ];
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|mjs|js|json|toml|txt)$/.test(n)) files.push(p);
    }
  };
  for (const t of trees) walk(t);
  assert.ok(files.length > 20, `both trees are read: ${files.length} files`);
  const bad = files.flatMap((f) => rulesB(relative(ROOT, f), readFileSync(f, "utf8")));
  assert.deepEqual(bad, []);
});

// ─── The file half: what a person reads before any run ──────────────────
//
// README, every docs/*.md and every shell's README, read from where they live
// (a renamed one fails rather than drops out); the site's three sources and
// its translated dictionaries; the shells' npm descriptions; and the
// manifests' person-facing install text. `*_reason` keys have no reader and
// stay out. The runbook (packaging/README.md), packaging/reserved/,
// commands/, agents/ and skills/ are other lints' (the story's Technical
// Notes, "Out of it, by class").

// The lint's command, by its first token after any NAME=value assignments. A
// single-token span is a name (a package's, a tool's) unless it is an
// in-session form, which runs as typed.
const IN_SESSION = /^(?:\/projectstore:[a-z][\w-]*|\$projectstore-[a-z][\w-]*)$/;
function isCommand(text) {
  const toks = String(text).trim().split(/\s+/).filter(Boolean);
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
  if (!toks.length) return false;
  if (IN_SESSION.test(toks[0])) return true;
  if (toks.length < 2) return false;
  const first = toks[0].replace(/@\S*$/, "");
  // The other package runners the install runbook observed (bunx, pnpm dlx, deno's npm: specifier).
  return ["npx", "npm", "node", "bunx", "pnpm", "deno", "projectstore", ...SHELL_NAMES].includes(first);
}

// Rule (c)'s punctuation: ASCII, and the full-width forms the Chinese page writes.
const AFTER_SPAN = /^[,.;:)，。；：）]/;
const spanFinding = (name, n, code, ch) => `${name}:${n}: (c) a command span followed by "${ch}": ${code}`;

// Rule (c) over Markdown: inline code spans outside fences (a run of N
// backticks closes on the next run of N).
function lintSpans(name, md) {
  const out = [];
  for (const { line, n, fenced } of markdownLines(String(md))) {
    if (fenced) continue;
    for (const m of line.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
      const after = line.slice(m.index + m[0].length);
      if (AFTER_SPAN.test(after) && isCommand(m[2])) out.push(spanFinding(name, n, m[0], after[0]));
    }
  }
  return out;
}

// Rule (c) over HTML: a <code> element's text, entities decoded, followed by
// punctuation after its closing tag. `lineOf` maps an offset to a file line.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const htmlText = (s) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) =>
      e[0] === "#"
        ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : (HTML_ENTITIES[e.toLowerCase()] ?? m),
    );
function lintCodeElements(name, html, lineOf = () => 1) {
  const out = [];
  for (const m of String(html).matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)) {
    const after = html.slice(m.index + m[0].length);
    const text = htmlText(m[1]);
    if (AFTER_SPAN.test(after) && isCommand(text)) out.push(spanFinding(name, lineOf(m.index), m[0], after[0]));
  }
  return out;
}
const lineAt = (text) => (offset) => text.slice(0, offset).split("\n").length;

// A line of data whose command does not end it: the text from the command's
// first token on holds prose, a span, a comment or closing punctuation (rule
// (d) for a manifest step and an npm description).
const COMMAND_START =
  /(?:^|[\s:(])((?:[A-Za-z_][A-Za-z0-9_]*=\S+ )*(?:npx |node "|\/projectstore:[a-z]|\$projectstore-[a-z]))/;
function commandEnds(text) {
  return String(text)
    .split("\n")
    .every((l) => {
      const m = COMMAND_START.exec(l);
      if (!m) return true;
      const rest = l.slice(m.index + m[0].length - m[1].length);
      return !/`|\s\(|\s—\s|;\s|[.,;:)]$/.test(rest);
    });
}

// The documents, from the filesystem.
const DOCUMENTS = () => [
  "README.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => `docs/${n}`),
  ...SHELLS.map((s) => `packaging/shells/${s.name}/README.md`),
];
const SITE_MARKDOWN = ["site/llms.txt", "site/llms-full.txt"];
// The site's templates and the partials they include (site/tools/i18n.py
// PAGES and <!--i18n:include-->): every one holds English the pages show.
const SITE_TEMPLATES = () =>
  readdirSync(join(ROOT, "site", "src"))
    .filter((n) => n.endsWith(".html"))
    .sort()
    .map((n) => `site/src/${n}`);
// The translated dictionaries: the English one is the template's extract.
const DICTIONARIES = () =>
  readdirSync(join(ROOT, "site", "locales"))
    .filter((n) => n.endsWith(".json") && n !== "en.json")
    .sort()
    .map((n) => `site/locales/${n}`);

// A manifest's person-facing install text, each string with its key path and
// the file line that holds it, read from the manifest's text `raw`.
const manifestFile = (m) => [`harnesses/${m.id}.json`, readFileSync(join(ROOT, "harnesses", `${m.id}.json`), "utf8")];
function manifestTexts([rel, raw]) {
  const m = JSON.parse(raw);
  const lines = raw.split("\n");
  const out = [];
  const add = (path, value) => {
    if (typeof value !== "string") return;
    const k = lines.findIndex((l) => l.includes(JSON.stringify(value)));
    out.push({ where: `${rel}:${k + 1} (${path})`, path, value });
  };
  const list = (path, v) => (Array.isArray(v) ? v.forEach((s, i) => add(`${path}[${i}]`, s)) : add(path, v));
  const inst = m.install || {};
  for (const key of ["steps", "next", "notes"]) list(`install.${key}`, inst[key]);
  add("install.why_not_scripted", inst.why_not_scripted);
  add("install.docs", inst.docs);
  add("update_hint.line", m.update_hint?.line);
  list("update_hint.welcome", m.update_hint?.welcome);
  for (const [ch, h] of Object.entries(m.update_hint?.by_channel || {})) {
    add(`update_hint.by_channel.${ch}.line`, h.line);
    list(`update_hint.by_channel.${ch}.welcome`, h.welcome);
  }
  list("update_instructions", m.update_instructions);
  return out;
}

// The commands a manifest step may end with, built with the code's own helpers.
const stepCommands = (m) => [
  ...["setup", "install", "upgrade", "uninstall", "plan"].map((v) => packageCommand(m, v)),
  packageCommand([], "setup"),
  invocation(m, "bind", { args: "<vault-path>" }),
];

const readRel = (rel) => [rel, readFileSync(join(ROOT, rel), "utf8")];

// Every finding of the file half, over the given files and data.
function lintFiles({
  documents = DOCUMENTS().map(readRel),
  siteMarkdown = SITE_MARKDOWN.map(readRel),
  templates = SITE_TEMPLATES().map(readRel),
  dictionaries = DICTIONARIES().map(readRel),
  shells = SHELLS,
  manifests = MANIFESTS.map(manifestFile),
} = {}) {
  const out = [];
  for (const [rel, md] of [...documents, ...siteMarkdown]) out.push(...lintLines(rel, md), ...lintSpans(rel, md));
  for (const [tpl, html] of templates) out.push(...lintLines(tpl, html), ...lintCodeElements(tpl, html, lineAt(html)));
  for (const [rel, raw] of dictionaries) {
    out.push(...lintLines(rel, raw));
    const lines = raw.split("\n");
    for (const [key, value] of Object.entries(JSON.parse(raw))) {
      const k = lines.findIndex((l) => l.startsWith(`  ${JSON.stringify(key)}:`));
      out.push(...lintCodeElements(`${rel} (${key})`, String(value), () => k + 1));
    }
  }
  const setup = packageCommand([], "setup");
  for (const s of shells) {
    const name = `packaging/shells.mjs SHELLS ${s.name}.description`;
    out.push(...lintLines(name, s.description), ...lintSpans(name, s.description));
    if (!commandEnds(s.description) || !s.description.endsWith(setup))
      out.push(`${name}: (d) does not end with ${setup}: ${s.description}`);
  }
  for (const file of manifests) {
    const m = JSON.parse(file[1]);
    for (const { where, path, value } of manifestTexts(file)) {
      out.push(...lintLines(where, value), ...lintSpans(where, value));
      if (!path.startsWith("install.steps") || !COMMAND_START.test(value)) continue;
      if (!commandEnds(value) || !stepCommands(m).some((c) => value.endsWith(c)))
        out.push(`${where}: (d) the step's command does not end it: ${value}`);
    }
  }
  return out;
}

test("user text, the file half: README, docs/, the shells' READMEs, the site, the npm descriptions and the manifests' install text pass every rule", () => {
  const docs = DOCUMENTS();
  assert.ok(docs.includes("docs/harnesses.md") && docs.length >= 8, `the documents are read: ${docs.join(", ")}`);
  assert.ok(DICTIONARIES().length >= 7, "every translated dictionary is read");
  const templates = SITE_TEMPLATES();
  assert.ok(
    ["site/src/index.html", "site/src/_header.html", "site/src/_footer.html"].every((t) => templates.includes(t)) &&
      templates.length >= 4,
    `every template and partial is read: ${templates.join(", ")}`,
  );
  const bad = lintFiles();
  assert.deepEqual(bad, [], bad.join("\n"));
  // Not vacuous: each manifest's first step is the core's install, last on its
  // line, and each npm description ends with the way in.
  for (const m of MANIFESTS) assert.ok(m.install.steps[0].endsWith(packageCommand(m, "install")), m.install.steps[0]);
  for (const s of SHELLS) assert.ok(s.description.endsWith(` ${packageCommand([], "setup")}`), s.description);
});

test("user text, the file half: each rule fails on one planted case, naming the file and line; the near misses pass", () => {
  const only = (o) =>
    lintFiles({
      documents: [],
      siteMarkdown: [],
      templates: [],
      dictionaries: [],
      shells: [],
      manifests: [],
      ...o,
    });
  // (a): --project in a README copy fails, on its line; mcp's own line keeps it.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const a = readme.replace("\n```\n", '\n```\nnpx projectstore upgrade --project "$PWD"\n');
  assert.notEqual(a, readme, "the plant applies");
  const aLine = a.split("\n").indexOf('npx projectstore upgrade --project "$PWD"') + 1;
  assert.deepEqual(only({ documents: [["README.md", a]] }), [
    `README.md:${aLine}: (a) --project: npx projectstore upgrade --project "$PWD"`,
  ]);
  assert.deepEqual(only({ documents: [["README.md", 'x\n```\nnpx projectstore mcp --project "$PWD"\n```\n']] }), []);
  // (b): an npm install of a shell in a docs copy fails; the shell's name alone in prose passes.
  const harnesses = readFileSync(join(ROOT, "docs", "harnesses.md"), "utf8");
  const b = harnesses.replace("## Codex\n", "## Codex\n\nInstall it: npm install -g projectstore-claude\n");
  assert.notEqual(b, harnesses, "the plant applies");
  const bLine = b.split("\n").indexOf("Install it: npm install -g projectstore-claude") + 1;
  assert.deepEqual(only({ documents: [["docs/harnesses.md", b]] }), [
    `docs/harnesses.md:${bLine}: (b) a shell as a command: Install it: npm install -g projectstore-claude`,
  ]);
  assert.deepEqual(
    only({ documents: [["docs/x.md", "`projectstore-claude` is a release artifact; setup runs it.\n"]] }),
    [],
  );
  // (c): a command span directly before a period fails, in Markdown and in a
  // dictionary's HTML; a span before a space, and a name before a period, pass.
  assert.deepEqual(only({ documents: [["docs/x.md", "Then\nrun `/projectstore:doctor --fix`.\n"]] }), [
    'docs/x.md:2: (c) a command span followed by ".": `/projectstore:doctor --fix`',
  ]);
  assert.deepEqual(
    only({ documents: [["docs/x.md", "Run `/projectstore:doctor --fix` in the session. See `projectstore`.\n"]] }),
    [],
  );
  for (const cmd of [
    "bunx projectstore@latest setup",
    "pnpm dlx projectstore@latest setup",
    "deno run -A npm:projectstore@latest setup",
  ])
    assert.deepEqual(only({ documents: [["docs/x.md", `Or \`${cmd}\`.\n`]] }), [
      `docs/x.md:1: (c) a command span followed by ".": \`${cmd}\``,
    ]);
  const dict =
    '{\n  "a.p.1": "x",\n  "a.p.2": "Skills such as <code>$projectstore-critic</code>, which start a role."\n}\n';
  assert.deepEqual(only({ dictionaries: [["site/locales/xx.json", dict]] }), [
    'site/locales/xx.json (a.p.2):3: (c) a command span followed by ",": <code>$projectstore-critic</code>',
  ]);
  // …and in a partial a template includes, on its line.
  assert.deepEqual(
    only({ templates: [["site/src/_footer.html", "<footer>\n<p>Run <code>/projectstore:doctor</code>.</p>\n"]] }),
    ['site/src/_footer.html:2: (c) a command span followed by ".": <code>/projectstore:doctor</code>'],
  );
  // (d): a manifest step whose comment follows its command fails, on the
  // manifest's line; the comment before it passes.
  const [rel, raw] = manifestFile(SRC);
  const first = JSON.stringify(SRC.install.steps[0]);
  const step = (s) => [[rel, raw.replace(first, JSON.stringify(s))]];
  const lateStep = `${packageCommand(SRC, "install")}   (npm; registers the plugin here)`;
  const dLine = raw.split("\n").findIndex((l) => l.includes(first)) + 1;
  assert.ok(dLine > 0, "the plant's anchor is the manifest's first step");
  assert.deepEqual(only({ manifests: step(lateStep) }), [
    `${rel}:${dLine} (install.steps[0]): (d) the step's command does not end it: ${lateStep}`,
  ]);
  assert.deepEqual(only({ manifests: step(`npm, for this checkout: ${packageCommand(SRC, "install")}`) }), []);
  // An npm description that does not end with the way in fails.
  const desc = only({ shells: [{ name: "projectstore-x", description: "Run npx projectstore setup, then restart." }] });
  assert.equal(desc.length, 1, desc.join("\n"));
  assert.match(desc[0], /^packaging\/shells\.mjs SHELLS projectstore-x\.description: \(d\) /);
});

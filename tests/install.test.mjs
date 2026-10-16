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
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  copyFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  statSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fakeInstall, writeRegistry, noHostEnv, fakeClaude, stubCopy, stubCalls } from "./fixtures/install.mjs";
import { codexHost, fakeNpmSpawn } from "./fixtures/fetch.mjs";
import {
  plan,
  renderPreview,
  confirm,
  apply,
  runVerb,
  isInteractive,
  renderDone,
  applyReporter,
  publicItem,
  gateText,
} from "../scripts/install-harness.mjs";
import { planBind, planInherit, applyBind, gitTop, INHERIT_DROPS } from "../scripts/binding.mjs";
import {
  detectHarnesses,
  harnessRefusal,
  sourceHarness,
  loadHarnesses,
  loadHarness,
  identifiedHarnessId,
  packageCommand,
  hostPresence,
  whichOnPath,
  registrationDeferred,
  insideHostSession,
} from "../scripts/harness.mjs";
import { writeBinding, seedCliVault } from "./fixtures/vault.mjs";
import { PLAIN } from "../scripts/term.mjs";
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
  stateDir,
  sessionStatePath,
  layoutPaths,
  ensureStateRoot,
  RUNTIME_GITIGNORE_HEADER,
  whichOnPath as libWhichOnPath,
  commandForm,
} from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CFG_DIR = SRC.runtime.harness_dir; // the harness's own directory (settings.local.json); our binding is layoutPaths(proj).binding
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
  if (bound)
    writeBinding(
      proj,
      JSON.stringify({
        vault_path: "/tmp/nowhere",
        layout: "engineering",
        ...(statusline ? { statusline: { enabled: true } } : {}),
      }),
    );
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
const manifests = () => [...loadHarnesses().values()];
const read = (f) => readFileSync(f, "utf8");

// ─── Detection and refusal (contract 8) ─────────────────────────────────

test("install contract 8: a project is detected by its harness directory, and an empty one is refused with the names it accepts", () => {
  const { home, root } = fixture();
  const proj = project();
  assert.deepEqual(
    detectHarnesses(proj).map((d) => d.id),
    [SRC.id],
  );
  const empty = mkdtempSync(join(tmpdir(), "ps-empty-"));
  assert.deepEqual(detectHarnesses(empty), []);
  const p = plan(empty, { home, root });
  assert.equal(p.ok, false);
  assert.equal(p.items.length, 0);
  assert.match(p.refusals[0], new RegExp(`--harness ${SRC.id}`));
  assert.match(harnessRefusal(empty), /detected by its project directory/);
  // One row per harness, the ids padded to one width so the reasons line up
  // (harnessNameLines, which setup's refusal shares).
  const rows = harnessRefusal(empty).split("\n").slice(1);
  assert.equal(rows.length, loadHarnesses().size);
  assert.equal(new Set(rows.map((l) => l.indexOf("("))).size, 1, rows.join("\n"));
  // PLAN prints every row whole, on a pipe and at a terminal: wrap indents only
  // the lines it breaks, and the refusal's own lines once lost the indent's
  // width ("laude-code", "odex").
  // A terminal also wraps a long row's reason, at a space, under the same pad.
  for (const caps of [PLAIN, { ...PLAIN, live: true, width: 80 }]) {
    const out = renderPreview(p, { caps, home });
    for (const row of rows) {
      const want = caps.live ? row.trim().split("(")[0].trim() : row.trim();
      assert.ok(out.includes(want), `${caps.live ? "terminal" : "pipe"}: ${want}\n${out}`);
    }
    assert.ok(!/^\s*(laude-code|odex)\b/m.test(out), out);
  }
  // Named, it proceeds even though nothing is detected.
  const named = plan(empty, { home, root, harnesses: [SRC.id] });
  assert.equal(named.ok, true);
  assert.equal(named.named, true);
  const unknown = plan(empty, { home, root, harnesses: ["no-such"] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.refusals[0], /unknown harness/);
});

// ─── Host presence and the registration deferral (the story "projectstore
// setup asks, shows one plan and installs every harness it finds, with the
// vault", rules 5 and 15) ────────────────────────────────────────────────

test("setup rule 5: hostPresence answers whether the registration's CLI is on PATH and the home directory exists, from the manifest's names, for every host", () => {
  for (const m of manifests()) {
    const s = Object.entries(m.surfaces || {}).find(
      ([k, x]) => !k.startsWith("_") && x?.kind === "registration" && x.cli?.bin,
    )?.[1];
    assert.ok(s, `${m.id}: its registration surface names its CLI`);
    const name = s.cli.bin;
    const home = mkdtempSync(join(tmpdir(), "ps-presence-home-"));
    const bin = mkdtempSync(join(tmpdir(), "ps-presence-bin-"));
    const homeDir = join(home, m.runtime.home_default);
    const at = (env) => hostPresence(m, { env, home });
    assert.deepEqual(at({ PATH: bin }), { cli: null, home: null, bin: name, homeDir }, `${m.id}: neither`);
    // A file that is not executable is not the CLI.
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") {
      chmodSync(join(bin, name), 0o644);
      assert.equal(at({ PATH: bin }).cli, null, `${m.id}: not executable`);
    }
    chmodSync(join(bin, name), 0o755);
    assert.deepEqual(
      at({ PATH: bin }),
      { cli: join(bin, name), home: null, bin: name, homeDir },
      `${m.id}: the CLI alone`,
    );
    // A file where the home should be is not a home.
    writeFileSync(homeDir, "");
    assert.equal(at({ PATH: "" }).home, null, `${m.id}: a file is not a home directory`);
    rmSync(homeDir);
    mkdirSync(homeDir);
    assert.deepEqual(at({ PATH: "" }), { cli: null, home: homeDir, bin: name, homeDir }, `${m.id}: the home alone`);
    assert.deepEqual(at({ PATH: bin }), { cli: join(bin, name), home: homeDir, bin: name, homeDir }, `${m.id}: both`);
    // The manifest's home variable relocates the home, and an empty one is unset.
    const moved = join(home, "relocated");
    assert.deepEqual(
      at({ PATH: "", [m.runtime.home_env]: moved }),
      { cli: null, home: null, bin: name, homeDir: moved },
      `${m.id}: the variable names a missing directory`,
    );
    mkdirSync(moved);
    assert.equal(
      at({ PATH: "", [m.runtime.home_env]: moved }).home,
      moved,
      `${m.id}: the variable wins over the default`,
    );
    assert.equal(at({ PATH: "", [m.runtime.home_env]: "" }).home, homeDir, `${m.id}: an empty variable is unset`);
  }
  // A manifest that names no registration CLI looks for none.
  const bare = {
    id: "bare",
    runtime: { home_default: ".bare" },
    surfaces: { plugin: { kind: "registration", supported: false, cli: { bin: "bare" } } },
  };
  assert.deepEqual(
    hostPresence(bare, { env: { PATH: "" }, home: mkdtempSync(join(tmpdir(), "ps-presence-bare-")) }).bin,
    null,
    "an unsupported surface is not looked for",
  );
  assert.deepEqual(hostPresence(null, { env: {}, home: null }), { cli: null, home: null, bin: null, homeDir: null });
  // whichOnPath moved into harness.mjs; lib.mjs re-exports the same function.
  assert.equal(libWhichOnPath, whichOnPath);
});

test("setup rule 15: registrationDeferred keys on the planned harness's own session marker or its registration_defer_env; isInteractive and identity read neither variable of the second list", () => {
  const all = manifests();
  const deferMarkers = all.flatMap((m) => m.runtime.registration_defer_env);
  assert.ok(
    deferMarkers.length >= 1,
    "a harness names the variable its session's commands carry (Codex: measured 2026-10-05)",
  );
  for (const m of all) {
    assert.equal(registrationDeferred({}, m), false, `${m.id}: outside any session`);
    assert.equal(registrationDeferred(null, m), false, `${m.id}: no environment`);
    for (const k of m.runtime.session_env || [])
      assert.equal(registrationDeferred({ [k]: "1" }, m), true, `${m.id}: its session marker ${k}`);
    for (const k of m.runtime.registration_defer_env) {
      assert.equal(registrationDeferred({ [k]: "1" }, m), true, `${m.id}: its deferral marker ${k}`);
      assert.equal(registrationDeferred({ [k]: "" }, m), false, `${m.id}: ${k} empty is unset`);
      assert.equal(
        insideHostSession({ [k]: "1" }, m),
        false,
        `${m.id}: ${k} is no session marker, so the layout move does not defer on it`,
      );
    }
    // Another harness's markers never defer this one's registration.
    for (const o of all.filter((o) => o.id !== m.id)) {
      for (const k of [...(o.runtime.session_env || []), ...o.runtime.registration_defer_env]) {
        if ([...(m.runtime.session_env || []), ...m.runtime.registration_defer_env].includes(k)) continue;
        assert.equal(registrationDeferred({ [k]: "1" }, m), false, `${m.id}: ${o.id}'s ${k} does not defer it`);
      }
    }
  }
  // isInteractive and identifiedHarnessId give the same answers with a
  // deferral marker set as without it.
  const tty = { isTTY: true };
  for (const k of deferMarkers) {
    assert.equal(
      isInteractive({ stdin: tty, stdout: tty, env: { [k]: "1" } }),
      isInteractive({ stdin: tty, stdout: tty, env: {} }),
      `isInteractive with ${k}`,
    );
    for (const base of [
      {},
      ...all.map((m) => ({ [m.runtime.plugin_root_env]: "/x" })),
      ...all.flatMap((m) => (m.runtime.session_env || []).map((s) => ({ [s]: "1" }))),
    ]) {
      assert.equal(
        identifiedHarnessId({ ...base, [k]: "1" }),
        identifiedHarnessId(base),
        `identity with ${k} over ${JSON.stringify(base)}`,
      );
    }
  }
});

// ─── The plan on a fresh project ────────────────────────────────────────

test("install: a fresh cache-installed project plans three creates and writes nothing until apply", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# My project\n" });
  const p = plan(proj, { home, root });
  assert.equal(p.ok, true);
  assert.equal(p.harnesses[0], SRC.id);
  assert.match(
    p.reports[0],
    /are installed by .*plugin marketplace/,
    "host-managed surfaces are reported (contract 14)",
  );
  assert.equal(item(p, "agents_block").action, "add");
  assert.equal(item(p, "agents_block").state, "ours-absent");
  assert.equal(item(p, "statusline").action, "create");
  assert.equal(item(p, "statusline_launcher").action, "create");
  assert.equal(item(p, "statusline_launcher").state, "absent");
  assert.equal(
    item(p, "mcp_project_entry").action,
    "skip",
    "the project-root entry stays unsupported; the plugin-bundled registration is a host surface",
  );
  assert.equal(item(p, "mcp_project_entry").state, "unsupported");
  assert.ok(p.reports[0].includes("mcp"), "the bundled registration is reported as host-managed");
  assert.equal(read(join(proj, "CLAUDE.md")), "# My project\n", "plan writes nothing");
  assert.ok(!existsSync(join(proj, CFG_DIR, "settings.local.json")));

  const preview = renderPreview(p);
  // Each row in a person's words (presentation spec contract 7): every write
  // reads "add" on its path's row; the unsupported row folds into "skipped",
  // named in words.
  const shown = preview.split("\n");
  for (const i of p.items.filter((x) => x.action !== "skip"))
    assert.ok(
      shown.some((l) => /^ {2}\+ add +/.test(l) && l.includes(relative(proj, i.path))),
      `${i.surface} reads add:\n${preview}`,
    );
  assert.ok(
    shown.some((l) => /^ {2}· skipped +not on Claude Code: mcp project entry {2}/.test(l)),
    preview,
  );
  assert.ok(
    preview.includes("CLAUDE.md") && preview.includes("settings.local.json") && preview.includes("statusline.mjs"),
  );
  assert.ok(
    preview.includes(
      "Only the entries listed above are written — nothing else in those files is read, rewritten or removed.",
    ),
  );

  const done = apply(p);
  assert.equal(done.length, 3);
  const claude = read(join(proj, "CLAUDE.md"));
  assert.ok(
    claude.startsWith("# My project\n\n<!-- projectstore:agents v"),
    "the block is appended after the user's content",
  );
  assert.equal(findAgentsBlock(claude).v, VERSION);
  const settings = JSON.parse(read(join(proj, CFG_DIR, "settings.local.json")));
  assert.equal(settings.statusLine.command, `node "${statusLineLauncherPath(proj)}"`);
  const launcher = read(statusLineLauncherPath(proj));
  assert.ok(
    launcher.startsWith("#!/usr/bin/env node\n// GENERATED by scripts/install-harness.mjs"),
    "stamped after the shebang",
  );
  assert.equal(parseProvenance(launcher).pkg, "0.28.0");
  assert.equal(parseProvenance(launcher).project, proj);
  assert.ok(launcher.includes(JSON.stringify(root)), "the fallback root is substituted");
  assert.ok(existsSync(layoutPaths(proj).stateGitignore), "the state dir carries its .gitignore");
  assert.ok(existsSync(layoutPaths(proj).gitignore), "and .projectstore/ carries its line-merged one (layout ADR)");

  // Second plan: everything current, nothing to apply.
  const again = plan(proj, { home, root });
  assert.ok(
    again.items.filter((i) => i.action !== "skip").length === 0,
    JSON.stringify(again.items.map((i) => [i.surface, i.state, i.action])),
  );
  assert.equal(item(again, "statusline_launcher").state, "current");
  assert.equal(item(again, "agents_block").state, "ours-current");
  // And SessionStart's refresh now finds its entry and leaves it alone.
  const prevRoot = process.env[SRC.runtime.plugin_root_env];
  process.env[SRC.runtime.plugin_root_env] = root;
  try {
    assert.equal(syncStatusLine({ statusline: { enabled: true } }, proj, home), "unchanged");
  } finally {
    if (prevRoot === undefined) delete process.env[SRC.runtime.plugin_root_env];
    else process.env[SRC.runtime.plugin_root_env] = prevRoot;
  }
});

test("install preview: a pathless public harness row keeps its identity without inventing a filesystem target", () => {
  const p = {
    mode: "install",
    harnesses: ["codex"],
    projectDir: "/tmp/project",
    plannedAgainst: {},
    root: "/tmp/plugin",
    reports: [],
    items: [
      {
        harness: "codex",
        surface: "commands",
        kind: "host",
        path: null,
        entry: null,
        state: "unsupported",
        action: "skip",
        reason: "Codex has no registrable root slash command",
      },
    ],
    refusals: [],
    ok: true,
    incomplete: false,
  };

  // By default the harness's unsupported rows fold into one skipped row that
  // still names the harness and the surface (contract 18), with no state word
  // (presentation spec contract 7).
  const preview = renderPreview(p);
  assert.match(preview, /^ {2}· skipped {2}not on Codex: commands {2}--verbose says why$/m);
  assert.ok(!preview.includes("unsupported"), preview);
  assert.ok(!preview.includes("/tmp/project/"), "no project-relative path is invented");
  // --verbose lists the row itself, marked as having no filesystem path, with the manifest's reason.
  const verbose = renderPreview(p, { verbose: true });
  assert.match(verbose, /commands \[codex, no filesystem path\]/);
  assert.match(verbose, /unsupported \(Codex has no registrable root slash command\) → skip/);
  assert.ok(!verbose.includes("/tmp/project/"));
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

  const old = BLOCK.replace(`projectstore:agents v${VERSION}`, "projectstore:agents v2").replace(
    "- **Report instruction conflicts",
    "- **Old line\n- **Report instruction conflicts",
  );
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

// ─── A newer block (the install spec, contracts 4, 6 and 9, as amended 2026-10-14) ───

// A block a newer copy wrote: its marker above this copy's template, and a
// rule this copy's render does not have — so a re-render would lose it.
const NEWER = BLOCK.replace(`projectstore:agents v${VERSION}`, `projectstore:agents v${VERSION + 1}`).replace(
  "- **Report instruction conflicts",
  "- **A rule this copy does not have\n- **Report instruction conflicts",
);
const NEWER_WORDS = `marked v${VERSION + 1}, newer than this copy's v${VERSION}`;

test("newer block: one in place is left as it is — ours-newer, a skip naming the way out, its bytes kept — and doctor reports an info, never an issue", () => {
  const { home, root } = fixture();
  const prose = "# Mine\n\n";
  const proj = project({ claude: prose + NEWER });
  const p = plan(proj, { home, root });
  const i = item(p, "agents_block");
  assert.deepEqual([i.state, i.action], ["ours-newer", "skip"]);
  assert.equal(
    i.reason,
    `${NEWER_WORDS}: left as it is — name --surface agents_block to write this copy's v${VERSION} over it`,
  );
  apply(p);
  assert.equal(read(join(proj, "CLAUDE.md")), prose + NEWER, "untouched, roster included");
  // Setup takes no --surface: its way out is the core's install command.
  const s = item(plan(proj, { home, root, takesSurface: false }), "agents_block");
  assert.ok(
    s.reason.endsWith(
      `to write this copy's v${VERSION} over it: npx projectstore install --harness ${SRC.id} --surface agents_block`,
    ),
    s.reason,
  );
  const found = checkAgentsBlock(proj, { root });
  assert.deepEqual(
    found.filter((f) => f.level !== "info").map((f) => f.message),
    [],
  );
  const info = found.find((f) => f.message.includes(NEWER_WORDS));
  assert.ok(info && info.level === "info", JSON.stringify(found));
  assert.ok(info.message.endsWith(`install --harness ${SRC.id} --surface agents_block`), info.message);
  assert.ok(!info.message.includes("written by a newer"), info.message);
  // The startup line counts issues alone and offers none of this.
  const st = runStartupChecks({ vault_path: "/tmp/nowhere", layout: "engineering" }, proj);
  assert.ok(
    st.findings.filter((f) => f.check === "agents-block").every((f) => f.level === "info"),
    JSON.stringify(st.findings),
  );
  assert.ok(!(st.offers || []).some((o) => /agents/.test(JSON.stringify(o))), JSON.stringify(st.offers));
});

test("newer block: the named surface writes this copy's render over one in place, and over a bogus v99; uninstall removes a newer block as any of ours", () => {
  const { home, root } = fixture();
  const prose = "# Mine\n\n";
  for (const marked of [NEWER, BLOCK.replace(`projectstore:agents v${VERSION}`, "projectstore:agents v99")]) {
    const proj = project({ claude: prose + marked });
    const n = plan(proj, { home, root, surfaces: ["agents_block"] });
    const i = item(n, "agents_block");
    assert.deepEqual([i.state, i.action], ["ours-newer", "replace-entry"]);
    assert.match(i.reason, /--surface agents_block names it$/);
    apply(n);
    assert.equal(read(join(proj, "CLAUDE.md")), prose + BLOCK);
  }
  const gone = project({ claude: prose + NEWER });
  apply(plan(gone, { home, root, mode: "uninstall", surfaces: ["agents_block"] }));
  assert.ok(!(existsSync(join(gone, "CLAUDE.md")) && read(join(gone, "CLAUDE.md")).includes("projectstore:agents")));
});

test("newer block: a Claude-only project gaining Codex moves it to AGENTS.md byte for byte, CLAUDE.md importing it; a re-run is a zero-write skip", () => {
  const { home, root } = fixture();
  const proj = project({ claude: NEWER });
  const run = { home, root, harnesses: [SRC.id, "codex"], surfaces: ["agents_block"], env: noHostEnv() };
  const p = plan(proj, run);
  const moved = p.items.find((x) => x.surface === "agents_block" && x.path === join(proj, "AGENTS.md"));
  assert.equal(moved.entry, `projectstore:agents v${VERSION + 1}`, "stamped with the carried marker");
  assert.ok(moved.reason.endsWith(`with its own text (${NEWER_WORDS})`), moved.reason);
  apply(p);
  assert.ok(read(join(proj, "AGENTS.md")).includes(NEWER), "the newer text, byte for byte");
  assert.ok(read(join(proj, "CLAUDE.md")).startsWith("@AGENTS.md"), "CLAUDE.md imports it");
  const again = plan(proj, { ...run, surfaces: null });
  assert.equal(again.items.find((x) => x.surface === "agents_block" && x.harness === SRC.id).state, "ours-newer");
  assert.deepEqual(
    again.items.filter((x) => x.surface.startsWith("agents_block") && x.action !== "skip").map((x) => x.action),
    [],
  );
});

test("newer block: of two blocks the preferred file's stays, and the newer text from CLAUDE.md replaces AGENTS.md's, both rows saying so", () => {
  const { home, root } = fixture();
  const proj = project({ claude: NEWER, agents: BLOCK });
  const p = plan(proj, { home, root });
  const stay = p.items.find((x) => x.surface === "agents_block" && x.path === join(proj, "AGENTS.md"));
  const gone = p.items.find((x) => x.surface === "agents_block" && x.path === join(proj, "CLAUDE.md"));
  assert.equal(stay.action, "replace-entry");
  assert.match(stay.reason, /replaced by CLAUDE\.md's/);
  assert.equal(gone.action, "remove");
  assert.match(gone.reason, /its text replaces the block in AGENTS\.md/);
  apply(p);
  assert.ok(read(join(proj, "AGENTS.md")).includes(NEWER));
  assert.ok(!read(join(proj, "CLAUDE.md")).includes("projectstore:agents v"));
});

test("newer block: of two blocks both marked above the template, the preferred file's stays as it is (ours-newer) and the other is removed", () => {
  const { home, root } = fixture();
  const other = NEWER.replace("- **A rule this copy does not have", "- **Another rule this copy does not have");
  const proj = project({ claude: other, agents: NEWER });
  const p = plan(proj, { home, root });
  const stay = p.items.find((x) => x.surface === "agents_block" && x.path === join(proj, "AGENTS.md"));
  const gone = p.items.find((x) => x.surface === "agents_block" && x.path === join(proj, "CLAUDE.md"));
  assert.deepEqual([stay.state, stay.action], ["ours-newer", "skip"]);
  assert.equal(gone.action, "remove");
  apply(p);
  assert.ok(read(join(proj, "AGENTS.md")).includes(NEWER), "the stayer's own text");
});

test("newer block: a named run that must add an import adds it and leaves the newer block's bytes; the next named run, with nothing left to place, writes the render", () => {
  const { home, root } = fixture();
  const proj = project({ agents: NEWER, claude: "# Mine\n" });
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.deepEqual(
    [item(p, "agents_block").state, item(p, "agents_block").action],
    ["ours-newer", "skip"],
    "doctor's import remedy names the surface; it must not downgrade",
  );
  assert.equal(item(p, "agents_block_import").action, "add");
  apply(p);
  assert.ok(read(join(proj, "AGENTS.md")).includes(NEWER));
  const next = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.equal(item(next, "agents_block").action, "replace-entry");
  apply(next);
  assert.ok(read(join(proj, "AGENTS.md")).includes(BLOCK));
});

// The defect this pins, measured on the smoke stand 2026-09-07: a fresh install
// on a project with neither file wrote CLAUDE.md — because the block's file list
// was the source harness's, and analyseBlock takes the LAST entry when none of
// them exists. Codex never reads CLAUDE.md; the rules had to be pasted into
// AGENTS.md by hand before it saw them at all. The list is per-harness data now,
// and this asserts it from the plan rather than from the manifest.
test("install contract 6: on a project with neither file, the harness's own list decides — Codex gets AGENTS.md and no CLAUDE.md", () => {
  const { home, root } = fixture();
  const bare = project({ claude: null, agents: null });
  const p = plan(bare, { home, root, harnesses: ["codex"], surfaces: ["agents_block"], env: noHostEnv() });
  assert.equal(p.ok, true);
  assert.deepEqual(p.harnesses, ["codex"]);
  assert.equal(item(p, "agents_block").path, join(bare, "AGENTS.md"));
  assert.equal(item(p, "agents_block").action, "create", "neither file exists, so the block's file is created");
  assert.equal(item(p, "agents_block_import"), undefined, "a one-file list has nothing to import from");
  apply(p);
  assert.ok(read(join(bare, "AGENTS.md")).includes(BLOCK));
  assert.ok(!existsSync(join(bare, "CLAUDE.md")), "Codex never reads CLAUDE.md — a fresh install must not create one");

  // The contrast, on the same shape of project: the source harness's list has
  // two entries and none of them exists, so analyseBlock takes the LAST — it
  // writes CLAUDE.md, which Claude Code does read. Recorded, not celebrated:
  // ADR-002 decision 3 prefers AGENTS.md as the cross-tool convention, and a
  // bare project installed for Claude Code alone therefore leaves a Codex
  // session in the same checkout with nothing to read until codex is installed
  // too. Changing the tie-break is a behaviour change and belongs to the
  // rendering slice, not here; what this slice fixes is that the CHOICE is now
  // per-harness data instead of one list applied to everyone.
  const src = project({ claude: null, agents: null });
  const q = plan(src, { home, root, harnesses: [SRC.id], surfaces: ["agents_block"], env: noHostEnv() });
  assert.equal(
    item(q, "agents_block").path,
    join(src, "CLAUDE.md"),
    "KNOWN: with neither file present the two-entry list falls to its last entry",
  );
  apply(q);
  assert.ok(read(join(src, "CLAUDE.md")).includes(BLOCK));
  assert.ok(!existsSync(join(src, "AGENTS.md")));
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
  assert.deepEqual(actions, [
    ["agents_block", "remove"],
    ["agents_block", "add"],
  ]);
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
  const WRAPPED =
    "# Mine\n\n<!-- projectstore:agents v3 (managed by projectstore — edit outside\n     markers) -->\n" +
    BLOCK.split("\n").slice(1).join("\n") +
    "\n";
  const wrapped = project({ agents: WRAPPED });
  const f = findAgentsBlock(WRAPPED);
  assert.equal(f.wrapped, true);
  assert.equal(f.unclosed, true);
  assert.equal(f.line, 3);
  assert.equal(f.count, 1);
  assert.equal(f.v, 3);
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
  assert.ok(
    !noReviewer.includes("After writing code, before commit / story-done"),
    "the reviewer's agent line is dropped",
  );
  assert.ok(noReviewer.includes("consult `projectstore:planner`"), "the planner's agent line stays");
  assert.ok(
    noReviewer.includes("opens a vault artifact before it opens an editor"),
    "the entry rule always stays — it mentions the reviewer in passing",
  );
  assert.ok(noReviewer.includes("Report instruction conflicts"), "the instruction-conflict clause always stays");
  assert.ok(
    noReviewer.includes(`projectstore:agents v${VERSION}`) && noReviewer.endsWith("<!-- /projectstore:agents -->"),
  );
});

// ─── settings.local.json (contract 6, the new row) ──────────────────────

test("install contract 6: a foreign statusLine is left byte-identical by install, uninstall and upgrade; an unparseable file refuses", () => {
  const { home, root } = fixture();
  const foreign =
    JSON.stringify(
      {
        statusLine: { type: "command", command: "node /Users/x/.claude/hud/omc-hud.mjs" },
        permissions: { allow: ["Bash(npm:*)"] },
      },
      null,
      2,
    ) + "\n";
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
  const proj = project({
    settings: JSON.stringify({
      permissions: { allow: ["Bash(npm:*)"] },
      statusLine: {
        type: "command",
        command: `node "${join(root, "scripts", "statusline.mjs")}"`,
        refreshInterval: 5000,
      },
    }),
  });
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
  {
    const { home, root, proj } = installed();
    writeFileSync(statusLineLauncherPath(proj), read(statusLineLauncherPath(proj)) + "\n// hand edit\n");
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale");
    assert.equal(i.reason, "edited by hand");
    assert.equal(i.action, "update");
  }
  // source changed
  {
    const { home, root, proj } = installed();
    writeFileSync(
      join(root, "scripts", "statusline-launcher.mjs"),
      read(join(root, "scripts", "statusline-launcher.mjs")) + "\n// new template line\n",
    );
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale");
    assert.equal(i.reason, "source changed");
  }
  // plugin updated
  {
    const { home, root, proj } = installed();
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }));
    const i = item(plan(proj, { home, root }), "statusline_launcher");
    assert.equal(i.state, "stale");
    assert.equal(i.reason, "plugin updated");
  }
  // configuration changed: the same template and version, rendered from another root
  {
    const { home, proj } = installed();
    const other = fakeInstall(home, "0.28.0-b");
    writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.28.0" }));
    const i = item(plan(proj, { home, root: other }), "statusline_launcher");
    assert.equal(i.state, "stale");
    assert.equal(i.reason, "configuration changed");
  }
});

test("install contract 5: a foreign launcher is refused by install, uninstall and upgrade, byte-identical", () => {
  const { home, root } = fixture();
  const proj = project();
  mkdirSync(dirname(statusLineLauncherPath(proj)), { recursive: true });
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
  mkdirSync(dirname(statusLineLauncherPath(proj)), { recursive: true });
  writeFileSync(
    statusLineLauncherPath(proj),
    renderStatusLineLauncher(read(join(root, "scripts", "statusline-launcher.mjs")), root),
  );
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
  mkdirSync(dirname(statusLineLauncherPath(other)), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  const i = item(plan(other, { home, root }), "statusline_launcher");
  assert.equal(i.state, "current");
  assert.equal(i.writtenBy, proj);
  assert.equal(i.sameProject, false);
});

// ─── uninstall and upgrade (contracts 13, 14) ───────────────────────────

test("install contract 13: uninstall removes only what it recognises and prunes the runtime dir only when empty", () => {
  const { home, root, proj } = installed();
  writeBinding(proj, { vault_path: "/tmp/nowhere", layout: "engineering", statusline: { enabled: true } });
  // Something else lives in the runtime dir: it must survive.
  mkdirSync(stateDir(proj), { recursive: true });
  writeFileSync(sessionStatePath(proj, "s1"), "{}");
  const p = plan(proj, { home, root, mode: "uninstall" });
  assert.deepEqual(
    p.items
      .filter((i) => i.action === "remove")
      .map((i) => i.surface)
      .sort(),
    ["agents_block", "statusline", "statusline_launcher"],
  );
  apply(p);
  assert.ok(!existsSync(join(proj, "CLAUDE.md")), "a CLAUDE.md that held only our block is removed");
  assert.deepEqual(JSON.parse(read(join(proj, CFG_DIR, "settings.local.json"))), {});
  assert.ok(!existsSync(statusLineLauncherPath(proj)));
  assert.ok(existsSync(sessionStatePath(proj, "s1")), "the state dir was not empty, so it stays");

  const clean = installed();
  apply(plan(clean.proj, { home: clean.home, root: clean.root, mode: "uninstall" }));
  assert.ok(!existsSync(dirname(statusLineLauncherPath(clean.proj))), "an emptied harness state dir is pruned");
  assert.ok(
    existsSync(layoutPaths(clean.proj).stateGitignore),
    "state/ itself stays with its .gitignore — other harnesses share it (layout ADR decision 4)",
  );
});

test("install contract 14: upgrade after a version bump re-stamps the launcher and leaves the rest alone", () => {
  const { home, root, proj } = installed();
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }));
  const p = plan(proj, { home, root });
  assert.deepEqual(
    p.items.filter((i) => i.action !== "skip").map((i) => i.surface),
    ["statusline_launcher"],
  );
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
  delete env.FORCE_COLOR; // the test runner forces colour into its children on a terminal
  const run = (args) =>
    spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), ...args, "--project", proj], {
      encoding: "utf8",
      env,
      timeout: 15000,
    });

  const bare = run(["install"]);
  assert.equal(bare.status, 1, bare.stderr);
  assert.match(
    bare.stdout,
    /Nothing written: without a terminal, a bare install refuses\. Name the harness to confirm: --harness /,
  );
  assert.ok(bare.stdout.includes("CLAUDE.md"), "the preview is printed before the refusal");
  const planned = bare.stdout.indexOf("\nPlan — 3 to add\n");
  assert.ok(
    planned >= 0 && planned < bare.stdout.indexOf("Nothing written"),
    `the plan precedes the refusal:\n${bare.stdout}`,
  );
  assert.ok(!bare.stdout.includes("\x1b["), "a pipe gets no escapes");
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
  const yes = await runVerb("install", proj, {
    home,
    root,
    ask: async (q) => {
      assert.equal(q, "◆ Apply 3 changes? [Y/n] ");
      return "yes";
    },
  });
  assert.equal(yes.gate.confirmed, true);
  assert.equal(yes.applied.length, 3);
  assert.ok(existsSync(statusLineLauncherPath(proj)));
  const refused = plan(project({ settings: "{ nope" }), { home, root });
  assert.deepEqual(await confirm(refused, { ask: async () => "y" }), { confirmed: false, why: "refused" });
});

// Contracts 9 and 18 as amended 2026-10-04: the plan is on the screen when the
// question is asked, Enter means yes, anything else — Ctrl+C and end of input
// included — writes nothing, and the run reads PLAN, APPLY, DONE in that order.
test("install contract 9/18: the plan precedes the question, Enter is yes, anything else writes nothing", async () => {
  const { home, root } = fixture();
  const sink = () => {
    const chunks = [];
    return {
      chunks,
      out: {
        isTTY: false,
        write: (s) => {
          chunks.push(String(s));
          return true;
        },
      },
    };
  };
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.TERM; // TERM=dumb would turn the glyphs to ASCII
  const proj = project();
  const { chunks, out } = sink();
  let onScreen = null;
  const r = await runVerb("install", proj, {
    home,
    root,
    env,
    out,
    ask: async () => {
      onScreen = chunks.join("");
      return "";
    },
  });
  assert.equal(r.gate.why, "answered", "an empty answer is the default, yes");
  assert.match(onScreen, /\nPlan — 3 to add\n/, "the plan is printed before the question");
  assert.ok(!onScreen.includes("✓ added"), "and nothing is applied before the answer");
  const text = chunks.join("");
  const at = (s) => text.indexOf(s);
  // APPLY has no heading: its first finished line follows the plan.
  assert.ok(
    at("Plan — 3 to add") >= 0 && at("Plan — 3 to add") < at("✓ added") && at("✓ added") < at("Done — 3 changes in "),
    text,
  );
  assert.ok(!text.includes("\x1b["), "no escapes into a stream that is not a terminal");
  assert.equal(r.applied.length, 3);
  for (const answer of ["n", "no", "nope", "y please", null]) {
    const fresh = project();
    const d = await runVerb("install", fresh, { home, root, env, ask: async () => answer });
    assert.deepEqual(d.gate, { confirmed: false, why: "declined" }, String(answer));
    assert.deepEqual(d.applied, []);
    assert.ok(!existsSync(statusLineLauncherPath(fresh)), `${answer}: nothing written`);
  }
  for (const answer of ["y", "Y", "yes", "YES", "  yes  "])
    assert.equal((await confirm(plan(project(), { home, root }), { ask: async () => answer })).why, "answered", answer);
});

// The terminal branch end to end, without `ask`: streams that say they are a
// terminal, the question on the same stream as the plan, the answer read from
// stdin. --json in a terminal never asks (it used to, into the envelope).
test("install contract 9: at a terminal the question follows the plan on the same stream; Enter applies, end of input does not, --json never asks", async () => {
  const { home, root } = fixture();
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.CI;
  delete env.TERM; // TERM=dumb: no live terminal, ASCII glyphs
  for (const m of manifests()) for (const k of m.runtime?.session_env || []) delete env[k];
  const terminal = () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    const stdout = new PassThrough();
    stdout.isTTY = true;
    stdout.columns = 100;
    let text = "";
    stdout.on("data", (d) => {
      text += d;
    });
    return { stdin, stdout, text: () => text };
  };
  const t = terminal();
  const proj = project();
  const pending = runVerb("install", proj, {
    home,
    root,
    env,
    harnesses: [SRC.id],
    stdin: t.stdin,
    stdout: t.stdout,
    out: t.stdout,
  });
  await new Promise((r) => setImmediate(r));
  assert.match(
    t.text().replace(/\x1b\[[0-9;]*m/g, ""),
    /\nPlan — 3 to add\n[\s\S]*◆ Apply 3 changes\? \[Y\/n\] $/,
    "the plan, then the question, on one stream",
  );
  t.stdin.write("\n");
  const yes = await pending;
  assert.deepEqual(
    yes.gate,
    { confirmed: true, why: "answered" },
    "a named harness at a terminal is asked, and Enter is yes",
  );
  assert.equal(yes.applied.length, 3);
  const e = terminal();
  const proj2 = project();
  const eof = runVerb("install", proj2, {
    home,
    root,
    env,
    harnesses: [SRC.id],
    stdin: e.stdin,
    stdout: e.stdout,
    out: e.stdout,
  });
  await new Promise((r) => setImmediate(r));
  e.stdin.end();
  assert.deepEqual((await eof).gate, { confirmed: false, why: "declined" }, "end of input is a no");
  assert.ok(!existsSync(statusLineLauncherPath(proj2)));
  const j = terminal();
  const bare = await runVerb("install", project(), { home, root, env, stdin: j.stdin, stdout: j.stdout, json: true });
  assert.deepEqual(
    bare.gate,
    { confirmed: false, why: "non-tty" },
    "--json in a terminal is not asked: a bare one refuses",
  );
  assert.equal(j.text(), "", "and nothing is written to the terminal");
  // A caller with terminal streams and no `out`: the question still takes its
  // stream's glyphs and colour — confirm() reads them, nothing passes a null over them.
  const a = terminal();
  const asciiRun = runVerb("install", project(), {
    home,
    root,
    env: { ...env, PROJECTSTORE_ASCII: "1", NO_COLOR: "1" },
    harnesses: [SRC.id],
    stdin: a.stdin,
    stdout: a.stdout,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.text(), "* Apply 3 changes? [Y/n] ", "ASCII glyphs from the asking stream's caps");
  a.stdin.write("n\n");
  assert.deepEqual((await asciiRun).gate, { confirmed: false, why: "declined" });
});

// The reviewer's pass (2026-10-05): a row's reason is never folded — an
// uninstall that could not be planned says why in the default view — a write
// never wears the skip glyph, a failure that is not a host command is named
// as what it was, and an injected `ask` never overrides --json.
// Presentation spec contract 3: a refusal is attention (yellow) — its ▲ on a
// refused row and on each of the plan's refusals; red is for what failed.
test("install contract 18: a refusal's ▲ is painted in the attention role, never red", () => {
  const p = {
    mode: "install",
    harnesses: [SRC.id],
    projectDir: "/tmp/project",
    plannedAgainst: {},
    root: "/tmp/plugin",
    reports: [],
    ok: false,
    incomplete: false,
    refusals: ["two config files — merge them by hand"],
    items: [
      {
        harness: SRC.id,
        surface: "statusline_launcher",
        kind: "exclusive",
        path: "/tmp/project/.projectstore/state/x.mjs",
        entry: null,
        state: "foreign",
        action: "refuse",
        reason: "not ours",
      },
    ],
  };
  const text = renderPreview(p, { caps: { ...PLAIN, color: true } });
  const marked = text.split("\n").filter((l) => l.includes("▲"));
  assert.equal(marked.length, 2, text);
  for (const l of marked) assert.ok(l.startsWith("  \x1b[33m▲\x1b[39m "), JSON.stringify(l));
  assert.ok(!text.includes("\x1b[31m▲"), "never red");
});

test("install contract 18: every reason is in the default view, writes wear write glyphs, STOPPED names what failed", async () => {
  const row = (extra) => ({
    harness: SRC.id,
    surface: "plugin",
    kind: "registration",
    path: "/tmp/project/x",
    entry: null,
    state: "current",
    action: "skip",
    ...extra,
  });
  const p = {
    mode: "uninstall",
    harnesses: [SRC.id],
    projectDir: "/tmp/project",
    plannedAgainst: {},
    root: "/tmp/plugin",
    reports: [],
    refusals: [],
    ok: true,
    incomplete: true,
    items: [
      row({ reason: "`claude` is not on PATH; global registration is left untouched" }),
      row({
        surface: "agents_block",
        kind: "shared",
        entry: "projectstore:agents v5",
        state: "ours-current",
        reason: "AGENTS.md is read by another harness too",
      }),
    ],
  };
  const text = renderPreview(p);
  // Beneath its row (presentation spec contract 7), without the state words;
  // --verbose adds the state and the plan's own action.
  assert.match(
    text,
    /\n {6}`claude` is not on PATH; global registration is left untouched\n/,
    "the reason an uninstall could not be planned is in the default view",
  );
  assert.match(text, /\n {6}AGENTS\.md is read by another harness too\n/);
  assert.ok(!text.includes("ours-current") && !text.includes("→ skip"), text);
  // Both rows are current and left in place for a reason: each reads
  // "skipped", never "unchanged", and the summary counts them so (contract 7).
  assert.equal(text.split("\n").filter((l) => /^ {2}· skipped {2}x {2}(plugin|agents block)$/.test(l)).length, 2, text);
  assert.match(text, /\nPlan — 2 skipped\n/);
  assert.ok(!text.includes("unchanged"), text);
  const loud = renderPreview(p, { verbose: true });
  assert.match(loud, /current \(`claude` is not on PATH; global registration is left untouched\) → skip/);
  assert.match(loud, /ours-current \(AGENTS\.md is read by another harness too\) → skip/);
  const writes = renderPreview({
    ...p,
    mode: "install",
    incomplete: false,
    items: ["add", "replace-entry", "disable", "prune"].map((action, k) =>
      row({ surface: `s${k}`, kind: "shared", action, state: "ours-absent" }),
    ),
  });
  // Each write wears a write glyph and reads in contract 7's words. `disable`
  // is a channel switch, the `switch` word (re-pinned deliberately by the
  // converge story, which maps it; it read `update` until then).
  for (const [k, [action, word]] of [
    ["add", "add"],
    ["replace-entry", "update"],
    ["disable", "switch"],
    ["prune", "remove"],
  ].entries()) {
    const line = writes.split("\n").find((l) => l.endsWith(`  s${k}`));
    assert.ok(line && !line.trimStart().startsWith("·"), `${action} wears a write glyph: ${line}`);
    assert.match(line, new RegExp(`^ {2}\\S ${word} +x {2}s${k}$`), `${action} reads ${word}`);
  }
  // A failed layout step is not a host command, and nothing was planned against an install path.
  const layout = {
    ...p,
    mode: "install",
    items: [
      {
        harness: SRC.id,
        surface: "layout",
        kind: "layout",
        path: "/tmp/project/.projectstore",
        entry: null,
        state: "legacy",
        action: "migrate",
      },
    ],
  };
  const stopped = renderDone({
    verb: "upgrade",
    plan: layout,
    applied: [
      {
        surface: "layout",
        path: "/tmp/project/.projectstore",
        action: "migrate",
        failed: { step: "move-state", status: null, stderr: "EACCES" },
      },
    ],
    failed: { step: "move-state", status: null, stderr: "EACCES" },
    elapsed: 0,
  });
  assert.match(stopped, /Stopped — 0 changes applied, then move-state failed/);
  assert.match(stopped, /✕ move-state \(layout \.projectstore\)\n {6}EACCES/);
  assert.ok(!stopped.includes("host command") && !stopped.includes("install path"), stopped);
  // An injected ask is a terminal, unless --json says otherwise.
  const { home, root } = fixture();
  let asked = false;
  const j = await confirm(plan(project(), { home, root, harnesses: [SRC.id] }), {
    ask: async () => {
      asked = true;
      return "y";
    },
    json: true,
  });
  assert.deepEqual(j, { confirmed: true, why: "named" });
  assert.equal(asked, false, "--json never asks");
});

test("install contract 9: a terminal is a TTY on both ends, outside CI, without --json and outside a host session", () => {
  const tty = { isTTY: true };
  const base = { stdin: tty, stdout: tty, env: {} };
  assert.equal(isInteractive(base), true);
  assert.equal(isInteractive({ ...base, stdin: {} }), false, "a piped stdin");
  assert.equal(isInteractive({ ...base, stdout: {} }), false, "a piped stdout");
  assert.equal(isInteractive({ ...base, json: true }), false, "--json");
  assert.equal(isInteractive({ ...base, env: { CI: "true" } }), false, "CI");
  assert.equal(isInteractive({ ...base, env: { CI: "0" } }), true, "CI=0 is not CI");
  assert.equal(isInteractive({ ...base, env: { CI: "false" } }), true, "CI=false is not CI");
  const markers = manifests().flatMap((m) => m.runtime?.session_env || []);
  assert.ok(markers.length >= 1, "a harness names its session markers (Codex: unmeasured, so none)");
  for (const k of markers)
    assert.equal(isInteractive({ ...base, env: { [k]: "1" } }), false, `inside a host session (${k})`);
});

test("install contract 18: --verbose restores the prose the default folds, and DONE names the manifest's next steps", async () => {
  const { home, root } = fixture();
  const proj = project();
  const p = plan(proj, { home, root });
  const quiet = renderPreview(p, { verb: "install" });
  const loud = renderPreview(p, { verb: "install", verbose: true });
  assert.match(quiet, /^projectstore install · Claude Code\n/);
  assert.ok(loud.length > quiet.length);
  for (const report of p.reports)
    for (const line of report.split("\n").filter(Boolean)) {
      assert.ok(loud.includes(line), `--verbose prints the report line: ${line}`);
      assert.ok(!quiet.includes(line), `the default folds it: ${line}`);
    }
  // Every write the plan makes is named in both.
  for (const i of p.items.filter((i) => i.action !== "skip" && i.path)) {
    const shown = relative(proj, i.path);
    assert.ok(quiet.includes(shown) && loud.includes(shown), shown);
  }
  const done = renderDone({ verb: "install", plan: p, applied: [{}, {}, {}], failed: null, elapsed: 1234 });
  assert.match(done, /\nDone — 3 changes in 1\.2s\n/);
  // Next: one line for the harness — its display name, then its manifest's steps (presentation spec contract 8).
  assert.ok(done.includes(`\nNext\n  Claude Code  ${loadHarness(SRC.id).install.next.join("; ")}\n`), done);
  // The --verbose tip is the preview tip: the core's plan command carries the
  // flag, last on its line, and no --project; a project that is not the
  // current directory is named in the lead (the story "User-facing text says
  // where to run…", rule 5).
  assert.match(
    done,
    new RegExp(
      `\\n {2}To preview without writing, from a terminal in "[^"]+":\\n\\n {2}npx projectstore plan --harness ${SRC.id} --verbose\\n$`,
    ),
  );
  assert.match(
    renderDone({ verb: "install", plan: p, applied: [], failed: null, elapsed: 0 }, { cwd: p.projectDir }),
    new RegExp(
      `\\n {2}To preview without writing, with every row's reasoning:\\n\\n {2}npx projectstore plan --harness ${SRC.id} --verbose\\n$`,
    ),
  );
  assert.ok(
    !renderDone({ verb: "install", plan: p, applied: [], failed: null, elapsed: 0 }, { verbose: true }).includes(
      "--verbose",
    ),
    "no --verbose tip once it was given",
  );
  const gone = renderDone({ verb: "uninstall", plan: p, applied: [{}], failed: null, elapsed: 0 });
  assert.match(gone, /\nNext\n {2}Claude Code {2}restart Claude Code\n/);
  const failed = renderDone({
    verb: "install",
    plan: p,
    applied: [{}],
    failed: { argv: ["claude", "plugin", "install", "x"], status: 1, stderr: "boom" },
    elapsed: 0,
  });
  assert.match(failed, /Stopped — 1 change applied, then a host command failed/);
  assert.match(failed, /\$ claude plugin install x exited 1\n {6}boom/);
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

test("install: naming the status line records its flag, so later plans keep it; uninstall naming it records off (configure spec, contract 6)", () => {
  const { home, root } = fixture();
  const proj = project({ statusline: false });
  const flag = () => JSON.parse(read(layoutPaths(proj).binding)).statusline?.enabled;
  assert.equal(flag(), undefined, "the fixture's binding has no flag");
  const named = plan(proj, { home, root, surfaces: ["statusline"] });
  assert.equal(item(named, "statusline_flag").set["statusline.enabled"], true);
  apply(named);
  assert.equal(flag(), true, "wiring the surface by name recorded the flag");
  const later = plan(proj, { home, root });
  assert.notEqual(item(later, "statusline").state, "opt-out", "a later bare plan keeps the line, not an opt-out skip");
  assert.notEqual(item(later, "statusline_launcher").state, "opt-out");
  assert.equal(item(later, "statusline_flag"), undefined, "nothing to record twice");
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" }));
  const up = plan(proj, { home, root });
  assert.equal(
    item(up, "statusline_launcher").action,
    "update",
    "an upgrade re-stamps the launcher the named run wired",
  );
  apply(up);
  const un = plan(proj, { home, root, mode: "uninstall", surfaces: ["statusline"] });
  assert.equal(item(un, "statusline").action, "remove");
  assert.equal(item(un, "statusline_flag").set["statusline.enabled"], false);
  apply(un);
  assert.equal(flag(), false, "removing the surface by name recorded off");
  assert.equal(item(plan(proj, { home, root }), "statusline").state, "opt-out", "off stays off for a bare run");
  const bare = plan(proj, { home, root, mode: "uninstall" });
  assert.equal(item(bare, "statusline_flag"), undefined, "a bare uninstall leaves the flag alone");
});

test("install: the flag is never recorded on for a line the run does not wire (configure spec, contract 6)", () => {
  const { home, root } = fixture();
  const foreign = project({
    statusline: false,
    settings: JSON.stringify({ statusLine: { type: "command", command: "node /x/hud.mjs" } }),
  });
  const p = plan(foreign, { home, root, surfaces: ["statusline"] });
  assert.equal(item(p, "statusline").state, "theirs");
  assert.equal(item(p, "statusline_flag"), undefined, "a foreign slot: the flag would claim a line nobody wired");
  const answered = plan(project({ statusline: false }), { home, root, statusline: false, surfaces: ["statusline"] });
  assert.equal(
    item(answered, "statusline_flag").set["statusline.enabled"],
    false,
    "setup's own answer still decides when it gives one",
  );
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
  assert.ok(
    !onlyPlanner.includes("design proposal: run the `projectstore:critic`"),
    "the critic's agent line is dropped",
  );
  assert.ok(!onlyPlanner.includes("After writing code, before commit"), "the reviewer's too");
  assert.ok(onlyPlanner.includes("consult `projectstore:planner`"));
  assert.ok(
    onlyPlanner.includes("opens a vault artifact before it opens an editor"),
    "the entry rule stays though it names the critic in passing",
  );
  assert.ok(onlyPlanner.includes("resolve its model and its effort from"), "the model-resolution line stays");

  const { home, root } = fixture();
  writeFileSync(
    join(root, "scaffold", "layouts", "engineering.json"),
    JSON.stringify({
      ...JSON.parse(read(join(ROOT, "scaffold", "layouts", "engineering.json"))),
      agents: ["critic", "planner"],
    }),
  );
  const proj = project();
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.ok(
    !item(p, "agents_block").after.includes("After writing code, before commit"),
    "the block is rendered from the root the plan was given, not the ambient install",
  );
});

test("install contract 6 / ADR-002 decision 3: two files with one block each resolve to the preferred one, never a refusal", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n\n" + BLOCK + "\n", agents: "# Agents\n\n" + BLOCK + "\n" });
  const p = plan(proj, { home, root, surfaces: ["agents_block"] });
  assert.equal(p.ok, true);
  assert.deepEqual(
    p.items.map((i) => [relative(proj, i.path), i.action]),
    [
      ["CLAUDE.md", "remove"],
      ["AGENTS.md", "skip"],
    ],
  );
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
  assert.equal(
    read(join(kept, "CLAUDE.md")),
    "@AGENTS.md\n\n# Mine\n",
    "an import in a CLAUDE.md with the user's prose stays — AGENTS.md still exists",
  );
});

// Where the block LANDS, once a project is used from more than one harness.
// The rule, and it is manifest data rather than a branch: look for an existing
// block across the union of every manifest's list; write to a file this harness
// can read; point every other existing file at it. Measured against the code as
// it was on 2026-09-08, each of these produced a different and wrong answer.
test("install contract 6: the block lands in the file every installed harness can read, and the others import it", () => {
  const { home, root } = fixture();
  const others = manifests().filter((m) => m.id !== SRC.id);
  assert.ok(others.length, "this case needs a second manifest; it is vacuous with one");
  const other = others[0];
  const shared = other.surfaces.agents_block.files[0]; // the file both lists name
  const own = SRC.surfaces.agents_block.files.find((f) => !other.surfaces.agents_block.files.includes(f));
  assert.ok(shared && own, "the manifests must differ for this case to mean anything");

  // 1. The source harness alone, with its own file present: nothing new is
  //    created. A single-harness user does not acquire a file they never asked
  //    for — the maintainer's rule, 2026-09-09.
  const solo = project({ claude: "# Mine\n" });
  apply(plan(solo, { harnesses: [SRC.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));
  assert.ok(read(join(solo, own)).includes(BLOCK), `the block is in ${own}`);
  assert.ok(!existsSync(join(solo, shared)), `${shared} is not created for a single harness`);

  // 2. A second harness arrives. The block MOVES to the file both can read and
  //    the first harness's file is left importing it — one block, not two.
  //    Before this, each harness created its own copy and the project carried
  //    the block twice until some later run repaired it.
  apply(plan(solo, { harnesses: [other.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));
  assert.ok(read(join(solo, shared)).includes(BLOCK), `the block moved to ${shared}`);
  assert.ok(!read(join(solo, own)).includes(BLOCK), `${own} no longer carries a second copy`);
  assert.ok(read(join(solo, own)).includes(`@${shared}`), `${own} imports ${shared}`);
  assert.equal(read(join(solo, own)).trim().split("\n").pop(), "# Mine", "the user's prose survives the move");
  // And both harnesses now agree there is nothing left to do.
  for (const m of manifests()) {
    assert.equal(
      item(plan(solo, { harnesses: [m.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }), "agents_block")
        .action,
      "skip",
      `${m.id}: settled`,
    );
  }

  // 3. The other harness alone, into a project that has the source harness's
  //    file: the block goes where that harness can read it AND the existing
  //    file is pointed at it. It used to be left untouched, so a Claude Code
  //    session went on reading a file the substance had left.
  const fresh = project({ claude: "# Mine\n" });
  apply(plan(fresh, { harnesses: [other.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));
  assert.ok(read(join(fresh, shared)).includes(BLOCK));
  assert.ok(read(join(fresh, own)).includes(`@${shared}`), `${own} must import ${shared}, whichever harness installed`);

  // 4. And no file is conjured for a harness that does not read it: installing
  //    the other harness alone into a bare project creates the file IT reads
  //    and nothing else.
  const bare = project({});
  apply(plan(bare, { harnesses: [other.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));
  assert.ok(read(join(bare, shared)).includes(BLOCK));
  assert.ok(!existsSync(join(bare, own)), `${own} is not created for a harness that does not read it`);
});

// Installing FOR a harness means the file that harness reads BY ITSELF ends up
// present — holding the block when it lands there, holding the import when it
// lands elsewhere. Measured 2026-09-09 against the code as it then was: a
// project with an AGENTS.md and no CLAUDE.md took the block into AGENTS.md and
// built no bridge, so Claude Code — the harness that ran the install — could
// not see what it had just installed, while every placement assertion passed.
test("install contract 6: installing for a harness leaves the file that harness reads natively present, block or bridge", () => {
  const { home, root } = fixture();
  for (const m of manifests()) {
    const native = m.surfaces.agents_block.reads_natively;
    assert.ok(native, `${m.id}: the manifest must say which file this harness reads by itself`);
    const foreign = manifests()
      .filter((o) => o.id !== m.id)
      .flatMap((o) => o.surfaces.agents_block.files)
      .filter((f) => f !== native);

    // The block already sits in a file this harness prefers but cannot read
    // unaided — the cell that used to leave it blind.
    const proj = project({});
    writeFileSync(join(proj, m.surfaces.agents_block.files[0]), "# Theirs\n");
    apply(plan(proj, { harnesses: [m.id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));

    assert.ok(existsSync(join(proj, native)), `${m.id}: ${native} must exist after installing for this harness`);
    const text = read(join(proj, native));
    const here = text.includes(BLOCK);
    const elsewhere = foreign.some(
      (f) => existsSync(join(proj, f)) && read(join(proj, f)).includes(BLOCK) && text.includes(`@${f}`),
    );
    assert.ok(here || elsewhere, `${m.id}: ${native} carries neither the block nor an import to the file that does`);
    assert.equal(
      here && elsewhere,
      false,
      `${m.id}: ${native} carries both the block and an import — one or the other`,
    );
  }
});

// The agents block is the one surface the PROJECT owns rather than a harness:
// several harnesses read the same file. Measured 2026-09-09 against the code as
// it then was — `uninstall --harness <other>` DELETED AGENTS.md while the source
// harness was still reading it through an @AGENTS.md import, and the reverse
// stripped the block Codex reads. Either way, disowning one harness silently
// disabled the other. Both directions are asserted here because the defect was
// symmetric and only one of them is obvious.
test("install contract 13: disowning one harness leaves the project's agents block alone while another harness reads it", () => {
  const { home, root } = fixture();
  const others = manifests().filter((m) => m.id !== SRC.id);
  assert.ok(others.length, "this case needs a second manifest; it is vacuous with one");

  for (const victim of [others[0], SRC]) {
    const proj = project({ claude: "# Mine\n" });
    for (const m of manifests()) mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
    // Installed in the order that reaches the shared end state: the block in
    // the file every harness can read, and CLAUDE.md importing it.
    for (const id of [others[0].id, SRC.id])
      apply(plan(proj, { harnesses: [id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));
    assert.ok(read(join(proj, "AGENTS.md")).includes(BLOCK), "precondition: the block is in the shared file");
    assert.ok(read(join(proj, "CLAUDE.md")).includes("@AGENTS.md"), "precondition: CLAUDE.md imports it");

    const u = plan(proj, { harnesses: [victim.id], mode: "uninstall", home, root, env: noHostEnv() });
    const item = u.items.find((i) => i.surface === "agents_block");
    assert.equal(item.action, "skip", `${victim.id}: a bare uninstall must not touch a block another harness reads`);
    assert.match(
      item.reason,
      /read by another harness|--surface agents_block/,
      `${victim.id}: the skip says why and how to force it`,
    );
    apply(u, { env: noHostEnv(), home });
    assert.ok(read(join(proj, "AGENTS.md")).includes(BLOCK), `${victim.id}: the block survived`);
    assert.ok(read(join(proj, "CLAUDE.md")).includes("@AGENTS.md"), `${victim.id}: the import survived`);
  }
});

test("install contract 13: the last harness still clears the block, and naming the surface forces it — with no import left pointing at nothing", () => {
  const { home, root } = fixture();
  // One harness only: nothing else reads its file, so a bare uninstall clears
  // it exactly as it always has. This is the common case and must not change.
  const alone = project({ claude: "# Mine\n" });
  apply(plan(alone, { home, root, surfaces: ["agents_block"] }));
  assert.ok(read(join(alone, "CLAUDE.md")).includes(BLOCK));
  apply(plan(alone, { home, root, mode: "uninstall" }));
  assert.equal(read(join(alone, "CLAUDE.md")), "# Mine\n", "the user's prose is returned byte-for-byte");

  // Naming the surface is the confirmation, as it is for every other write this
  // bin makes — and when the file the import names goes with it, the import
  // goes too. Before 2026-09-09 that cleanup could not fire for a harness whose
  // block list has ONE entry: its PREFERRED and FALLBACK are the same file, and
  // the old condition asked for a block in one and not the other.
  const others = manifests().filter((m) => m.id !== SRC.id);
  if (!others.length) return;
  const shared = project({ claude: "# Mine\n" });
  for (const m of manifests()) mkdirSync(join(shared, m.runtime.harness_dir), { recursive: true });
  for (const id of [others[0].id, SRC.id])
    apply(plan(shared, { harnesses: [id], home, root, env: noHostEnv(), surfaces: ["agents_block"] }));

  const forced = plan(shared, {
    harnesses: [others[0].id],
    mode: "uninstall",
    home,
    root,
    env: noHostEnv(),
    surfaces: ["agents_block"],
  });
  assert.equal(
    forced.items.find((i) => i.surface === "agents_block").action,
    "remove",
    "naming the surface removes it",
  );
  apply(forced, { env: noHostEnv(), home });
  assert.ok(!existsSync(join(shared, "AGENTS.md")), "the file it created and nothing else held is gone");
  assert.equal(
    read(join(shared, "CLAUDE.md")),
    "# Mine\n",
    "and no @AGENTS.md is left pointing at a file that no longer exists",
  );
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
  assert.equal(
    item(p, "statusline_launcher").action,
    "skip",
    "install from a root that does not produce the file leaves it",
  );
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
  mkdirSync(dirname(statusLineLauncherPath(foreign)), { recursive: true });
  writeFileSync(statusLineLauncherPath(foreign), "console.log('theirs')\n");
  const f = plan(foreign, { home, root: dev, surfaces: ["statusline"] });
  assert.equal(item(f, "statusline_launcher").action, "skip");
  assert.equal(item(f, "statusline_launcher").state, "foreign");
});

test("install contract 12: the preview says who last wrote a shared-path file", () => {
  const { home, root, proj } = installed();
  const other = project();
  mkdirSync(dirname(statusLineLauncherPath(other)), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  // The row's note names the writer, and the row is never collapsed into the
  // unchanged line (presentation spec contract 7); --verbose keeps the state.
  const p = plan(other, { home, root });
  assert.ok(
    renderPreview(p)
      .split("\n")
      .some(
        (l) => /^ {2}\S \S+ +\S+statusline\.mjs +last written by /.test(l) && l.endsWith(`last written by ${proj}`),
      ),
    renderPreview(p),
  );
  assert.ok(renderPreview(p, { verbose: true }).includes(`current, last written by ${proj}`));
});

test("install: upgrade runs as install, a missing flag value is a usage error, and the JSON envelope carries no file bodies", () => {
  const { home, root } = fixture();
  const proj = project({ claude: "# Mine\n" });
  const env = { ...process.env, HOME: home, [SRC.runtime.plugin_root_env]: root };
  delete env[SRC.runtime.home_env];
  const run = (args) =>
    spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), ...args, "--project", proj], {
      encoding: "utf8",
      env,
      timeout: 15000,
    });
  const up = run(["upgrade", "--harness", SRC.id, "--json"]);
  assert.equal(up.status, 0, up.stderr);
  const out = JSON.parse(up.stdout);
  assert.equal(out.verb, "upgrade");
  assert.equal(out.applied.length, 3);
  assert.ok(out.items.every((i) => !("before" in i) && !("after" in i)));
  assert.ok(!up.stdout.includes("opens a vault artifact"), "no block body in the envelope");
  const bad = spawnSync(process.execPath, [join(ROOT, "scripts", "install-harness.mjs"), "install", "--harness"], {
    encoding: "utf8",
    env,
    timeout: 15000,
  });
  assert.equal(bad.status, 2);
});

// The converge story's rule 2 (PS-HARNESS: "Setup and upgrade converge this
// project onto the running version: the channel switch, no downgrade, and the
// update notice"): naming the harness no longer confirms a channel switch.
test("converge criterion 'The channel gate': a switch planned under no channel answer writes nothing without a terminal — through the bin and main(), in --json and in piped text — and a terminal is asked", async () => {
  const home = mkdtempSync(join(tmpdir(), "ps-gate-home-"));
  const proj = project({ claude: "# Mine\n" });
  // The git marketplace's copy, older than this checkout, enabled at user scope.
  const git = fakeInstall(home, "0.27.1");
  writeRegistry(home, [{ scope: "user", installPath: git, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }]);
  const host = fakeClaude(mkdtempSync(join(tmpdir(), "ps-gate-bin-")));
  const env = host.env({ HOME: home, [SRC.runtime.plugin_root_env]: ROOT });
  const run = (script, args) =>
    spawnSync(process.execPath, [script, ...args, "--project", proj], {
      encoding: "utf8",
      env,
      cwd: proj,
      timeout: 60000,
    });
  const files = [join(proj, "CLAUDE.md"), join(proj, CFG_DIR, "settings.local.json"), join(proj, "AGENTS.md")];
  const snap = () => files.map((f) => (existsSync(f) ? read(f) : null));
  const before = snap();
  const captures = JSON.parse(read(join(ROOT, "tests", "fixtures", "json-captures.json")));
  // Setup's commands, now that it exists (the setup story, rule 17): the
  // terminal run, then the two --channel runs, each alone on its line; from a
  // checkout, no version is pinned.
  const gate = [
    "Nothing written: this project loads projectstore from the git marketplace (projectstore@SmartAndPoint), and moving it to the npm install is a choice made at a terminal in this project:",
    "",
    `    npx projectstore setup --harness ${SRC.id}`,
    "",
    "Without a terminal, name the channel:",
    "",
    `    npx projectstore setup --harness ${SRC.id} --channel npm`,
    "",
    `    npx projectstore setup --harness ${SRC.id} --channel git`,
  ].join("\n");
  for (const [entry, script] of [
    ["the bin", join(ROOT, "bin", "projectstore.mjs")],
    ["main()", join(ROOT, "scripts", "install-harness.mjs")],
  ]) {
    const j = run(script, ["upgrade", "--harness", SRC.id, "--json"]);
    assert.equal(j.status, 1, `${entry}: ${j.stderr}`);
    const out = JSON.parse(j.stdout);
    const r = entry === "the bin" ? out.result : out;
    assert.equal(out.ok, false, entry);
    assert.deepEqual(r.gate, { confirmed: false, why: "channel" }, entry);
    assert.deepEqual(r.applied, [], entry);
    assert.ok(
      r.items.some((i) => i.surface === "plugin_others" && i.action === "disable"),
      "the switch is in the envelope's plan",
    );
    // The envelope gains no key.
    if (entry === "the bin") {
      assert.deepEqual(Object.keys(out), Object.keys(captures.upgrade.stdout));
      assert.deepEqual(Object.keys(r), Object.keys(captures.upgrade.stdout.result));
    } else
      assert.deepEqual(Object.keys(out), [
        "verb",
        "ok",
        "gate",
        "applied",
        "failed",
        "incomplete",
        "items",
        "refusals",
        "reports",
        "fetched",
      ]);
    // Piped text: the plan, then the gate's words and the terminal run, alone on its line; exit 1.
    const t = run(script, ["upgrade", "--harness", SRC.id]);
    assert.equal(t.status, 1, `${entry}: ${t.stdout}${t.stderr}`);
    assert.ok(t.stdout.endsWith(`\n${gate}\n`), `${entry}:\n${t.stdout}`);
    assert.ok(t.stdout.includes("⇄ switch"), "the plan was shown first");
    // setup takes no --surface, so a narrowed run's is not repeated; --project never is.
    const s = run(script, ["upgrade", "--harness", SRC.id, "--surface", "plugin"]);
    assert.ok(s.stdout.endsWith(`\n${gate}\n`), `${entry}:\n${s.stdout}`);
    assert.ok(!/--project|--surface plugin\n/.test(s.stdout.slice(s.stdout.indexOf("Nothing written"))), s.stdout);
  }
  assert.deepEqual(host.log(), [], "the logging fake host recorded no call");
  assert.deepEqual(snap(), before, "nothing written");
  // plan --json keeps its key set.
  const pj = JSON.parse(run(join(ROOT, "bin", "projectstore.mjs"), ["plan", "--harness", SRC.id, "--json"]).stdout);
  assert.deepEqual(Object.keys(pj.result), Object.keys(captures.plan.stdout.result));
  // A bare run without a terminal gets the same answer, ahead of the bare refusal.
  const bare = plan(proj, { home, root: ROOT, env });
  assert.equal(bare.named, false);
  assert.deepEqual(await confirm(bare, {}), { confirmed: false, why: "channel" });
  // The channel answered ("npm", which only setup passes) is confirmed by naming the harness, as before.
  assert.deepEqual(await confirm(plan(proj, { home, root: ROOT, env, harnesses: [SRC.id], channel: "npm" }), {}), {
    confirmed: true,
    why: "named",
  });
  // At a terminal (the TTY double): the switch with its consequence line, and the one question.
  const chunks = [];
  let question = null;
  const r = await runVerb("upgrade", proj, {
    harnesses: [SRC.id],
    home,
    root: ROOT,
    env,
    out: {
      isTTY: false,
      write: (x) => {
        chunks.push(String(x));
        return true;
      },
    },
    ask: async (q) => {
      question = q;
      return "n";
    },
  });
  const writes = r.plan.items.filter((i) => !["skip", "refuse"].includes(i.action)).length;
  assert.equal(question, `◆ Apply ${writes} changes? [Y/n] `);
  assert.deepEqual(r.gate, { confirmed: false, why: "declined" });
  assert.ok(
    chunks
      .join("")
      .includes(
        "\n      this project stops loading the git-marketplace copy, and that copy's updates no longer reach it — from now on it is updated by npx projectstore setup\n",
      ),
    chunks.join(""),
  );
  assert.deepEqual(host.log(), []);
});

test("install: the command prose invokes the verb and never writes the block or the settings itself", () => {
  for (const f of ["commands/agents.md", "commands/bind.md", "commands/statusline.md", "commands/doctor.md"]) {
    const src = read(join(ROOT, f));
    assert.match(
      src,
      /bin\/projectstore\.mjs" (install|uninstall|plan|configure) /,
      `${f} invokes the verb through the bin (roadmap A8; the status line through configure, its spec's contract 9)`,
    );
  }
  const doctor = read(join(ROOT, "commands", "doctor.md"));
  assert.ok(
    !/agents-block[^\n]*\n[^\n]*Edit after approval/.test(doctor),
    "doctor.md no longer repairs the block with Edit",
  );
  const agents = read(join(ROOT, "commands", "agents.md")).replace(/\s+/g, " ");
  assert.ok(agents.includes("Never write the block with the Write or Edit tool"));
  // The doctor story of 2026-10-14: the texts say what is true of an npm
  // registration. The mcp remedy is gated by channel, as version-drift's is.
  const mcp = doctor.slice(doctor.indexOf("- `mcp` →"), doctor.indexOf("- `override-copies`")).replace(/\s+/g, " ");
  assert.ok(
    mcp.includes("(for a git-marketplace copy, open `/plugin manage` and choose **Update now** on projectstore;"),
    mcp,
  );
  assert.ok(
    mcp.includes(
      "for the npm registration, the package's `upgrade` from a terminal in the project, outside this session",
    ),
    mcp,
  );
  assert.ok(!/the host's update path \(`\/plugin update`\), never/.test(mcp), "no ungated /plugin update");
  // A bare uninstall from a terminal removes the block; /plugin uninstall does not.
  assert.ok(agents.includes("`/plugin uninstall` removes these commands but NOT the block"), agents);
  assert.ok(agents.includes("the package's bare `uninstall` removes the block too"), agents);
  assert.ok(agents.includes("`uninstall --surface agents_block` removes it outright"), agents);
  // The converge story's rule 3 and the setup story's rule 17: a channel
  // choice is per checkout, so the binding a worktree inherits (step 0a,
  // written by the model) drops the mark and the keep, as planInherit does.
  const bind = read(join(ROOT, "commands", "bind.md"));
  const step0a = bind.slice(bind.indexOf("\n0a. "), bind.indexOf("\n1. "));
  assert.ok(step0a.length > 100, "step 0a found");
  assert.match(step0a, /Write that JSON verbatim, without `channel_switch` and `channel_keep`, to/);
  assert.match(step0a, /\*\*Never copy `channel_switch` or `channel_keep`\.\*\*/);
});

// ─── The stamp itself ───────────────────────────────────────────────────

test("install: the launcher stamp names the installer as generator and doctor as the remedy", () => {
  const { root, proj } = installed();
  void root;
  const text = read(statusLineLauncherPath(proj));
  assert.ok(text.includes("GENERATED by scripts/install-harness.mjs from scripts/statusline-launcher.mjs"));
  assert.ok(
    text.includes("projectstore doctor reports this file"),
    "an installed file is caught by doctor, not by the portability suite",
  );
  assert.ok(!text.includes("tests/portability.test.mjs"));
  const s = stamp("x\n", { format: "mjs", src: "a", srcHash: sourceHash("a"), pkg: "1", project: "/p", harness: "h" });
  assert.ok(
    s.text.includes("tests/portability.test.mjs"),
    "the default remedy still names the suite for a committed tree",
  );
});

// ─── Slice A3: doctor reads the states ──────────────────────────────────

import { surfaceStates, analyseStampedFile } from "../scripts/surfaces.mjs";
import {
  checkHarnessSurfaces,
  checkVersionDrift,
  checkAgentsBlock,
  runInstallChecks,
  runStartupChecks,
} from "../scripts/doctor.mjs";
import { installedPluginEntries } from "../scripts/lib.mjs";

const byCheck = (fs, id) => fs.filter((f) => f.check === id);

test("install contract 4 (doctor half): each of the four stale reasons on the launcher is one doctor issue, and current is silent", async () => {
  const one = async (mutate) => {
    const { home, root, proj } = installed();
    assert.deepEqual(
      byCheck(await checkHarnessSurfaces({}, proj, { home, root }), "surface"),
      [],
      "a current install says nothing",
    );
    const opts = mutate({ home, root, proj });
    const f = byCheck(await checkHarnessSurfaces({}, proj, opts || { home, root }), "surface");
    assert.equal(f.length, 1);
    assert.equal(f[0].level, "issue");
    assert.match(
      f[0].message,
      /bin\/projectstore\.mjs" install --harness [a-z-]+ --surface statusline_launcher/,
      "the remedy is the bin form the command prose runs",
    );
    // The effective root: one variant points the check at a second installation,
    // and the remedy must name the root that produced the finding.
    const effRoot = (opts && opts.root) || root;
    assert.ok(
      f[0].message.includes(`node "${join(effRoot, "bin", "projectstore.mjs")}"`),
      "the remedy names a path the reader can run — doctor output is never placeholder-substituted (A15)",
    );
    assert.ok(!f[0].message.includes("install-harness.mjs"));
    return f[0].message;
  };
  assert.match(
    await one(({ proj }) =>
      writeFileSync(statusLineLauncherPath(proj), read(statusLineLauncherPath(proj)) + "\n// hand edit\n"),
    ),
    /stale: edited by hand/,
  );
  assert.match(
    await one(({ root }) =>
      writeFileSync(
        join(root, "scripts", "statusline-launcher.mjs"),
        read(join(root, "scripts", "statusline-launcher.mjs")) + "\n// new line\n",
      ),
    ),
    /stale: source changed/,
  );
  assert.match(
    await one(({ root }) =>
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.29.0" })),
    ),
    /stale: plugin updated/,
  );
  assert.match(
    await one(({ home, root }) => {
      void root;
      const other = fakeInstall(home, "0.28.0-b");
      writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.28.0" }));
      return { home, root: other };
    }),
    /stale: configuration changed/,
  );
});

test("install contract 5 (doctor half): a foreign file is reported under its own id with the resolution wording, and never repaired", async () => {
  const { home, root } = fixture();
  const proj = project();
  mkdirSync(dirname(statusLineLauncherPath(proj)), { recursive: true });
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
    const bullet = step3.slice(
      step3.indexOf(`- \`${id}\``),
      step3.indexOf("\n   - `", step3.indexOf(`- \`${id}\``) + 5),
    );
    assert.ok(
      !bullet.includes('node "') && !bullet.includes("/projectstore:") && !bullet.includes("claude plugin"),
      `the ${id} bullet invokes nothing`,
    );
  }
  assert.ok(/never Edit, Write or delete the file yourself/.test(step3));
  // Executable repairs: every verb invocation step 3 can emit leaves a foreign
  // launcher and a foreign slot byte-identical.
  // Since roadmap A8 the prose invokes the bin; the verb travels to install-harness.mjs unchanged (cli.mjs runInstallVerb).
  // Braced since A15: the host substitutes ${CLAUDE_PLUGIN_ROOT} in command
  // prose and passes the unbraced form through as text.
  const cmds = [...step3.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/(bin\/projectstore\.mjs)" ([a-z]+)/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.ok(
    cmds.length > 0 &&
      cmds.every(([s, v]) => s === "bin/projectstore.mjs" && ["install", "uninstall", "upgrade", "plan"].includes(v)),
    "repairs invoke core verbs only, through the bin",
  );
  const foreignSlot = JSON.stringify({ statusLine: { type: "command", command: "node /x/hud.mjs" } }, null, 2) + "\n";
  const victim = project({ settings: foreignSlot, agents: "# theirs\n" });
  mkdirSync(dirname(statusLineLauncherPath(victim)), { recursive: true });
  writeFileSync(statusLineLauncherPath(victim), "console.log('theirs')\n");
  const env = { ...process.env, HOME: home, [SRC.runtime.plugin_root_env]: root };
  delete env[SRC.runtime.home_env];
  for (const [script, verb] of cmds) {
    for (const key of ["statusline", "agents_block"]) {
      spawnSync(
        process.execPath,
        [join(ROOT, script), verb, "--harness", SRC.id, "--surface", key, "--project", victim],
        { encoding: "utf8", env, timeout: 15000 },
      );
    }
  }
  assert.equal(read(statusLineLauncherPath(victim)), "console.log('theirs')\n");
  assert.equal(read(join(victim, CFG_DIR, "settings.local.json")), foreignSlot);
  assert.ok(
    read(join(victim, "AGENTS.md")).startsWith("# theirs\n"),
    "the user's prose is untouched; the block was appended after it",
  );
});

test("install contract 12 (doctor half): a launcher another project wrote is one info naming it", async () => {
  const { home, root, proj } = installed();
  const other = project();
  mkdirSync(dirname(statusLineLauncherPath(other)), { recursive: true });
  copyFileSync(statusLineLauncherPath(proj), statusLineLauncherPath(other));
  const f = byCheck(await checkHarnessSurfaces({}, other, { home, root }), "surface");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
  assert.ok(f[0].message.includes(`current, last written by ${proj}`));
});

test("install contract 6 (doctor half): block states — content drift at the same version, one per file, unclosed", async () => {
  const { home, root } = fixture();
  const drift = project({
    claude:
      BLOCK.replace("- **Report instruction conflicts", "- **Changed line\n- **Report instruction conflicts") + "\n",
  });
  const f = byCheck(await checkHarnessSurfaces({}, drift, { home, root }), "surface");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /content differs from the current source/);
  assert.deepEqual(
    checkAgentsBlock(drift),
    [],
    "the version matches, so the version check is quiet — the state check carries it",
  );

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
  const wrapped = project({
    agents: "# A\n<!-- projectstore:agents v3 (managed)\n-->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n",
  });
  const ws = byCheck(await checkHarnessSurfaces({}, wrapped, { home, root }), "surface");
  assert.equal(ws.length, 1);
  assert.match(ws[0].message, /AGENTS\.md:2: .*does not close on its own line/);
  const wa = checkAgentsBlock(wrapped);
  assert.equal(wa.length, 1);
  assert.equal(wa[0].level, "issue");
  assert.match(wa[0].message, /AGENTS\.md:2/);
  assert.ok(!wa.some((x) => /not registered/.test(x.message)));
  // A good block in one file and a wrapped marker in the other: the wrapped issue, and NOT the "both files — install keeps one" advice (install refuses).
  const split = project({
    claude: "# Mine\n\n" + BLOCK + "\n",
    agents: "# A\n<!-- projectstore:agents v3 (managed)\n-->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n",
  });
  const sa = checkAgentsBlock(split);
  assert.ok(sa.some((x) => /AGENTS\.md:2/.test(x.message)));
  assert.ok(!sa.some((x) => /in both CLAUDE\.md and AGENTS\.md/.test(x.message)), "no contradictory advice");
  // A good block plus a wrapped marker in the SAME file: startup names it (both verbs refuse), never a quiet session.
  const same = project({ agents: BLOCK + "\n\n<!-- projectstore:agents v3\n-->\n" });
  const ma = checkAgentsBlock(same);
  assert.ok(
    ma.some((x) => x.level === "issue" && /2 times/.test(x.message)),
    JSON.stringify(ma),
  );
  const mp = plan(same, { home, root });
  assert.equal(mp.ok, false);
  // The three encodings of the open marker agree: the strict regex, the loose one and the manifest's marker.open.
  const open = SRC.surfaces.agents_block.marker.open;
  assert.ok(
    new RegExp(AGENTS_BLOCK_OPEN_SRC).test(open + "3 -->") && new RegExp(AGENTS_BLOCK_OPEN_LOOSE_SRC).test(open + "3"),
    "manifest marker.open is what both regexes match",
  );
});

// Placement held to install's own predicate (the install spec, contract 6 as
// amended after the rc.3 tag). rc.1 and rc.2 left a block in an AGENTS.md-only
// project, which Claude Code never saw, and nothing said so. The env is
// explicit: a Bash tool in a Claude Code session carries CLAUDECODE; CI does not.
test("install contract 6 (doctor half): a block a used harness cannot see is named — an issue for the harness that identified itself, a warning for one only detected, nothing for one the project does not use; install plans exactly the import doctor asks for", () => {
  const { home, root } = fixture();
  const codex = loadHarness("codex");
  const session = { [SRC.runtime.session_env[0]]: "1" };
  const unseen = (fs) => fs.filter((f) => /does not see/.test(f.message));
  const only = project({ agents: BLOCK + "\n" });
  const inSession = unseen(checkAgentsBlock(only, { env: session, root }));
  assert.equal(inSession.length, 1, JSON.stringify(inSession));
  assert.equal(inSession[0].level, "issue");
  assert.match(inSession[0].message, /in AGENTS\.md, which Claude Code does not see: CLAUDE\.md does not import it/);
  // The directory in prose, the command alone on the last line, no --project
  // (the story "User-facing text says where to run…", rules 1, 4 and 5).
  assert.ok(
    inSession[0].message.endsWith(
      ` from a terminal in ${JSON.stringify(only)}:\nnode "${join(root, "bin", "projectstore.mjs")}" install --harness ${SRC.id} --surface agents_block`,
    ),
    inSession[0].message,
  );
  const terminal = unseen(checkAgentsBlock(only, { env: {}, root }));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].level, "warn", "detected by its directory, not identified");
  // Install agrees: planning the block for this harness creates exactly that import.
  const p = plan(only, { home, root, harnesses: [SRC.id], surfaces: ["agents_block"] });
  const bridge = p.items.find((i) => i.surface === "agents_block_import");
  assert.ok(
    bridge && bridge.action === "create" && bridge.after.startsWith("@AGENTS.md"),
    JSON.stringify(p.items.map((i) => [i.surface, i.action])),
  );
  writeFileSync(join(only, "CLAUDE.md"), "@AGENTS.md\n");
  assert.deepEqual(unseen(checkAgentsBlock(only, { env: session, root })), [], "the import is there: nothing to say");
  // The installer's exact line: `@./AGENTS.md` reads as absent to both.
  writeFileSync(join(only, "CLAUDE.md"), "@./AGENTS.md\n");
  assert.equal(unseen(checkAgentsBlock(only, { env: session, root })).length, 1);
  // A block in CLAUDE.md is invisible to a detected Codex, which reads AGENTS.md only.
  const claudeOnly = project({ claude: BLOCK + "\n" });
  mkdirSync(join(claudeOnly, codex.runtime.harness_dir), { recursive: true });
  const cx = unseen(checkAgentsBlock(claudeOnly, { env: {}, root }));
  assert.equal(cx.length, 1);
  assert.match(cx[0].message, /Codex does not see: it reads AGENTS\.md only/);
  assert.equal(cx[0].level, "warn");
  assert.equal(
    unseen(checkAgentsBlock(claudeOnly, { env: { [codex.runtime.plugin_root_env]: "/x" }, root }))[0].level,
    "issue",
    "identified: an issue",
  );
  // A Codex-only project, from a terminal: nothing about Claude Code, which it does not use.
  const codexOnly = mkdtempSync(join(tmpdir(), "ps-inst-codex-"));
  mkdirSync(join(codexOnly, codex.runtime.harness_dir), { recursive: true });
  writeFileSync(join(codexOnly, "AGENTS.md"), BLOCK + "\n");
  assert.deepEqual(unseen(checkAgentsBlock(codexOnly, { env: {}, root })), []);
  // A wrapped marker stays one finding, and so does a block that never closes —
  // named even at the current version, since the plan refuses both.
  const wrapped = project({
    agents: "# A\n<!-- projectstore:agents v3 (managed)\n-->\n" + BLOCK.split("\n").slice(1).join("\n") + "\n",
  });
  assert.equal(checkAgentsBlock(wrapped, { env: session, root }).length, 1);
  const half = checkAgentsBlock(project({ agents: BLOCK.replace("<!-- /projectstore:agents -->", "") + "\n" }), {
    env: session,
    root,
  });
  assert.equal(half.length, 1, JSON.stringify(half));
  assert.equal(half[0].level, "issue");
  assert.match(half[0].message, /AGENTS\.md: the projectstore:agents block opens and never closes/);
  // Beside a good block in CLAUDE.md: no "both files — run register" advice the plan would refuse.
  const split = checkAgentsBlock(
    project({ claude: BLOCK + "\n", agents: BLOCK.replace("<!-- /projectstore:agents -->", "") + "\n" }),
    { env: session, root },
  );
  assert.ok(!split.some((f) => /in both CLAUDE\.md and AGENTS\.md/.test(f.message)), JSON.stringify(split));
});

// Through the bin, from a terminal: the bin names the project to its doctor
// child in the harness's own vocabulary, and that must not read there as the
// harness identifying itself — it made a terminal doctor raise a Claude Code
// issue in a Codex-only project (the review of the post-rc.3 fixes, 2026-10-04).
test("install contract 6 (doctor half), through the bin from a terminal: a Claude Code project gets a warning, and a Codex-only one hears nothing about Claude Code", () => {
  const codex = loadHarness("codex");
  const home = mkdtempSync(join(tmpdir(), "ps-inst-term-home-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ps-inst-term-cwd-"));
  const unseen = (proj) => {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "bin", "projectstore.mjs"), "doctor", "--install", "--json", "--project", proj],
      { encoding: "utf8", cwd: elsewhere, env: noHostEnv({ HOME: home }), timeout: 60000 },
    );
    return JSON.parse(r.stdout).result.filter((f) => /does not see/.test(f.message));
  };
  const { proj: claudeProj } = seedCliVault();
  mkdirSync(join(claudeProj, SRC.runtime.harness_dir), { recursive: true });
  rmSync(join(claudeProj, "CLAUDE.md"), { force: true });
  writeFileSync(join(claudeProj, "AGENTS.md"), BLOCK + "\n");
  const c = unseen(claudeProj);
  assert.equal(c.length, 1, JSON.stringify(c));
  assert.equal(c[0].level, "warn", "detected by its directory; a terminal identifies no harness");
  const { proj: codexProj } = seedCliVault();
  rmSync(join(codexProj, SRC.runtime.harness_dir), { recursive: true, force: true });
  rmSync(join(codexProj, "CLAUDE.md"), { force: true });
  mkdirSync(join(codexProj, codex.runtime.harness_dir), { recursive: true });
  writeFileSync(join(codexProj, "AGENTS.md"), BLOCK + "\n");
  assert.deepEqual(unseen(codexProj), [], "Codex reads AGENTS.md itself, and Claude Code is not used here");
});

test("harness: identified from the environment means a strong signal or the session marker — never the weak ranking or the source fallback", () => {
  const codex = loadHarness("codex");
  assert.equal(identifiedHarnessId({ [SRC.runtime.session_env[0]]: "1" }), SRC.id, "a Bash tool inside a session");
  assert.equal(identifiedHarnessId({ [SRC.runtime.project_dir_env]: "/p" }), SRC.id, "a hook");
  assert.equal(identifiedHarnessId({ [codex.runtime.plugin_root_env]: "/x" }), codex.id);
  assert.equal(
    identifiedHarnessId({ [SRC.runtime.plugin_root_env]: "/x" }),
    null,
    "a variable two harnesses set identifies neither",
  );
  assert.equal(
    identifiedHarnessId({ [codex.runtime.home_env]: "/h" }),
    null,
    "a home variable is a shell profile, not a launch",
  );
  assert.equal(identifiedHarnessId({}), null, "no fallback");
  // What a parent of ours decided crosses the spawn and stands, empty included.
  assert.equal(
    identifiedHarnessId({ PROJECTSTORE_IDENTIFIED: "", [SRC.runtime.project_dir_env]: "/p" }),
    null,
    "the project-dir variable the bin wrote is not an identity",
  );
  assert.equal(identifiedHarnessId({ PROJECTSTORE_IDENTIFIED: codex.id }), codex.id);
});

test("install: no doctor remedy names a raw script — every one is the bin form the command prose runs", () => {
  const src = read(join(ROOT, "scripts", "doctor.mjs"));
  assert.ok(!/install-harness\.mjs (install|uninstall|upgrade|plan)/.test(src));
  assert.ok(
    !/scripts\/(reconcile|doctor|install-harness)\.mjs"/.test(src.replace(/^\s*\/\/.*$/gm, "")),
    "no code path names a script the prose no longer runs",
  );
  assert.match(
    src,
    /node "\$\{join\(root, "bin", "projectstore\.mjs"\)\}" install --harness/,
    "the remedy is the resolved bin path, in the bin form the command prose runs (A15) — old: a shell reference to the surface's harness variable, in the bin form",
  );
});

test("install contract 16: a harness is reported only when the project uses it", async () => {
  const { home, root } = fixture();
  // A second manifest whose project directory is .codex, in a temp manifest dir.
  const mdir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  copyFileSync(join(ROOT, "harnesses", "claude-code.json"), join(mdir, "claude-code.json"));
  const fake = JSON.parse(read(join(ROOT, "harnesses", "claude-code.json")));
  fake.id = "other-harness";
  fake.display_name = "Other";
  fake.source_layout = false;
  fake.emit = true;
  fake.runtime = {
    ...fake.runtime,
    harness_dir: ".other",
    project_dir_env: "OTHER_PROJECT_DIR",
    plugin_root_env: "OTHER_PLUGIN_ROOT",
    home_env: "OTHER_HOME",
    detect_env: ["OTHER_HOME"],
  };
  fake.surfaces = { commands: { ...fake.surfaces.commands } };
  writeFileSync(join(mdir, "other-harness.json"), JSON.stringify(fake));
  const proj = project();
  const r = surfaceStates(proj, { home, root, manifestDir: mdir });
  assert.deepEqual(r.used, [SRC.id], "only the harness whose directory exists");
  assert.ok(r.states.every((s) => s.harness === SRC.id));
  // The other half of contract 16: no directory, but a file of ours.
  const oursOnly = mkdtempSync(join(tmpdir(), "ps-ours-"));
  writeFileSync(join(oursOnly, "AGENTS.md"), BLOCK + "\n");
  assert.deepEqual(
    surfaceStates(oursOnly, { home, root, manifestDir: mdir }).used,
    [SRC.id],
    "a project carrying our block uses the harness",
  );
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
  const a = fakeInstall(home, "0.27.0"),
    b = fakeInstall(home, "0.28.0");
  writeRegistry(home, [
    { scope: "user", installPath: a, version: "0.27.0" },
    { scope: "user", installPath: b, version: "0.28.0" },
  ]);
  const f = checkVersionDrift(home, []);
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "version-drift");
  assert.match(f[0].message, /0\.27\.0 \(registry projectstore@SmartAndPoint \(user\) at /);
  assert.match(f[0].message, /0\.28\.0/);
  // A wiped install is not a copy anyone runs.
  writeRegistry(home, [
    { scope: "user", installPath: a, version: "0.27.0" },
    { scope: "user", installPath: "/gone/0.26.0", version: "0.26.0" },
  ]);
  assert.deepEqual(checkVersionDrift(home, []), []);
  // A stamped file at a version the registry does not carry counts too.
  writeRegistry(home, [{ scope: "user", installPath: a, version: "0.27.0" }]);
  const g = checkVersionDrift(home, [{ surface: "statusline_launcher", installedPkg: "0.28.0" }]);
  assert.equal(g.length, 1);
  assert.match(g[0].message, /0\.28\.0 \(pkg= of statusline_launcher\)/);
});

test("install contract 17 (amended 2026-10-14): drift counts this project's copies, never another project's rows", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const proj = mkdtempSync(join(tmpdir(), "ps-drift-"));
  const other = mkdtempSync(join(tmpdir(), "ps-other-"));
  const mine = fakeInstall(home, "0.30.2"),
    old = fakeInstall(home, "0.28.0"),
    user = fakeInstall(home, "0.29.3");
  // Another project's local row at another version: not this project's copy.
  writeRegistry(home, [
    { scope: "local", projectPath: proj, installPath: mine, version: "0.30.2" },
    { scope: "local", projectPath: other, installPath: old, version: "0.28.0" },
  ]);
  assert.deepEqual(checkVersionDrift(home, [], proj), [], "another project's row is no drift here");
  // This project's own row against a user-scope row: the drift contract 17 names.
  writeRegistry(home, [
    { scope: "local", projectPath: proj, installPath: mine, version: "0.30.2" },
    { scope: "user", installPath: user, version: "0.29.3" },
    { scope: "local", projectPath: other, installPath: old, version: "0.28.0" },
  ]);
  const f = checkVersionDrift(home, [], proj);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /0\.30\.2 \(registry projectstore@SmartAndPoint \(local\) at /);
  assert.match(f[0].message, /0\.29\.3 \(registry projectstore@SmartAndPoint \(user\) at /);
  assert.doesNotMatch(f[0].message, /0\.28\.0/, "never another project's row");
  // A user-scope row alone, beside another project's local row: nothing to say.
  writeRegistry(home, [
    { scope: "user", installPath: user, version: "0.29.3" },
    { scope: "local", projectPath: other, installPath: old, version: "0.28.0" },
  ]);
  assert.deepEqual(checkVersionDrift(home, [], proj), []);
  // The host records the project's cwd as a real path: /private/var against the
  // /var the project is named by is still this project.
  writeRegistry(home, [
    { scope: "local", projectPath: realpathSync(proj), installPath: mine, version: "0.30.2" },
    { scope: "user", installPath: user, version: "0.29.3" },
  ]);
  assert.equal(checkVersionDrift(home, [], proj).length, 1, "this project's own row, under either spelling");
});

test("install: runInstallChecks carries the state findings, and the startup path never loads the leaf", async () => {
  const { home, root, proj } = installed();
  writeFileSync(join(proj, CFG_DIR, "settings.local.json"), "{ not json");
  const cfg = { vault_path: proj, layout: "engineering", statusline: { enabled: true } };
  const f = await runInstallChecks(cfg, proj, { home, root });
  assert.ok(Array.isArray(f));
  assert.ok(
    f.some((x) => x.check === "statusline"),
    "checkStatusline still owns the entry's wiring facts",
  );
  const startup = read(join(ROOT, "scripts", "doctor.mjs"));
  const body = startup.slice(
    startup.indexOf("export function runStartupChecks"),
    startup.indexOf("export function runStartupChecks") + 1200,
  );
  assert.ok(
    !body.includes("checkHarnessSurfaces") && !body.includes("surfaces.mjs"),
    "the startup checks never reach the leaf",
  );
});

test("install: the installer's item shape did not move when the states moved into surfaces.mjs", () => {
  const { home, root, proj } = installed();
  const a = analyseStampedFile(proj, sourceHarness().surfaces.statusline_launcher, {
    root,
    home,
    harness: sourceHarness(),
  });
  assert.equal(a.state, "current");
  assert.equal(a.installedPkg, "0.28.0");
  const i = item(plan(proj, { home, root }), "statusline_launcher");
  assert.deepEqual([i.state, i.action, i.writtenBy], ["current", "skip", proj]);
});

// Contract 19: the install family works in a project that exists. A path
// ending in a comma or a space, as pasted from a chat, or a path to a file, is
// refused before detection, writing, staging, locking or spawning, and quoted.
test("install contract 19: a project directory that does not exist is refused, quoted, before anything else", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ps-missing-"));
  const file = join(parent, "a-file");
  writeFileSync(file, "x");
  const home = mkdtempSync(join(tmpdir(), "ps-missing-home-"));
  const before = readdirSync(parent).sort();
  const id = sourceHarness().id;
  for (const proj of [join(parent, "project,"), join(parent, "project "), file]) {
    for (const [mode, extra] of [
      ["install", {}],
      ["uninstall", {}],
      ["uninstall", { globalRemoval: true }],
    ]) {
      for (const harnesses of [[id], []]) {
        const p = plan(proj, { harnesses, mode, home, ...extra });
        assert.equal(p.ok, false);
        assert.deepEqual(p.items, []);
        assert.deepEqual(
          p.refusals,
          [`no such project directory: ${JSON.stringify(proj)} — nothing is written`],
          `${mode} ${harnesses.join() || "bare"}`,
        );
      }
    }
    let spawned = 0;
    const r = await runVerb("upgrade", proj, {
      harnesses: [id],
      home,
      spawn: () => {
        spawned++;
        return { status: 0, stdout: "", stderr: "" };
      },
      out: { isTTY: false, write: () => true },
    });
    assert.equal(r.gate.why, "refused");
    assert.equal(spawned, 0, "nothing is spawned");
  }
  assert.deepEqual(readdirSync(parent).sort(), before, "nothing appeared in the parent");
  assert.deepEqual(readdirSync(home), [], "nothing appeared in the harness home");
});

// ─── upgrade's set and the state directory (the shell-fetch story, rule 5) ─

const CODEX = loadHarness("codex");

// What a first SessionStart of 0.30.5 or earlier left in `proj` as harness
// `id`, bound or not: the welcome marker, and the state directory's header
// beside it, as ensureStateRoot writes them. Planted, not run: since the story
// "Opening a project that is not bound writes nothing into it…" an unbound
// session writes its marker on the machine, so the hook no longer makes this
// state in an unbound project. The projects that hold it keep it (there is no
// self-migration), and uninstall still recognises it (install spec contract 13).
function welcomedBy0305(proj, id) {
  ensureStateRoot(proj);
  const marker = layoutPaths(proj).welcomed(id);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, new Date().toISOString() + "\n", "utf8");
}

// An unbound Claude Code project a Codex session of 0.30.5 ran in: .claude/, no
// .codex/, and .projectstore/state/codex/welcomed as that hook wrote it. The
// variants break one recogniser each, after the plant.
function stateProject({ marker = undefined, headed = true } = {}) {
  const proj = project({ bound: false });
  const lp = layoutPaths(proj);
  welcomedBy0305(proj, CODEX.id);
  if (!headed) writeFileSync(lp.stateGitignore, "*\n");
  if (marker === null) rmSync(lp.welcomed(CODEX.id));
  else if (marker !== undefined) writeFileSync(lp.welcomed(CODEX.id), marker);
  return { proj, lp };
}

test("install rule 5: the welcome 0.30.5's hook left in an unbound project is recognised — a project uninstall plans the marker's removal and the empty directory's", () => {
  const proj = project({ bound: false });
  welcomedBy0305(proj, CODEX.id);
  const lp = layoutPaths(proj);
  assert.ok(read(lp.stateGitignore).includes(RUNTIME_GITIGNORE_HEADER), "the header comes with the marker");
  assert.equal(existsSync(lp.sessions), false, "and no session state in a project that is not bound");
  const p = plan(proj, { harnesses: [CODEX.id], mode: "uninstall", root: ROOT, env: noHostEnv() });
  const row = p.items.find((i) => i.surface === "harness_state");
  assert.deepEqual(
    row.steps.map((s) => [s.kind, s.path, s.left]),
    [
      ["delete", lp.welcomed(CODEX.id), undefined],
      ["rmdir-state", lp.harnessState(CODEX.id), []],
    ],
  );
  apply(p, { env: noHostEnv() });
  assert.equal(existsSync(lp.harnessState(CODEX.id)), false);
});

function hostSandbox() {
  const base = mkdtempSync(join(tmpdir(), "ps-inst-hosts-"));
  const home = join(base, "home"),
    bin = join(base, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, CODEX.surfaces.plugin.cli.bin);
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    base,
    home,
    env: noHostEnv({ PATH: bin, [CODEX.runtime.home_env]: home, XDG_CACHE_HOME: join(base, "cache") }),
  };
}

test("install rule 5: a bare upgrade at a terminal selects Codex by its state directory, fetches it and DONE's tip names it; a machine registration alone does not; bare install and plan keep contract 8", async () => {
  const { proj } = stateProject();
  const h = hostSandbox();
  const chunks = [];
  const out = {
    isTTY: false,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
  };
  const npm = fakeNpmSpawn();
  const r = await runVerb("upgrade", proj, {
    root: ROOT,
    home: h.home,
    env: h.env,
    out,
    ask: async () => "y",
    fetchSpawn: npm.spawn,
    spawn: codexHost(h.home),
  });
  assert.deepEqual(r.plan.harnesses, [SRC.id, CODEX.id]);
  assert.deepEqual(
    r.plan.detected.map((d) => [d.id, d.why, d.evidence]),
    [
      [SRC.id, "directory", CFG_DIR],
      [CODEX.id, "state", relative(proj, layoutPaths(proj).harnessState(CODEX.id))],
    ],
  );
  assert.equal(npm.installs().length, 1, "Codex's shell is fetched");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const text = chunks.join("");
  assert.match(text, /\nDone — /);
  // The tip names every harness the upgrade planned, Codex included, in one
  // core command alone on its line, --verbose last (presentation spec
  // contract 6); the run is not in the project, so the lead names it (the
  // story "User-facing text says where to run…", rules 1 and 5).
  assert.ok(
    text.includes(`\n  To preview without writing, from a terminal in ${JSON.stringify(resolve(proj))}:\n\n`),
    text.slice(text.indexOf("Done")),
  );
  assert.ok(
    text.includes(`\n  ${packageCommand([SRC, CODEX], "plan", { args: "--verbose" })}\n`),
    text.slice(text.indexOf("Done")),
  );
  assert.ok(
    text.endsWith(`\n  npx projectstore plan --harness ${SRC.id} --harness ${CODEX.id} --verbose\n`),
    text.slice(text.indexOf("Done")),
  );
  // A registration of ours for the whole machine, and no state directory: not a signal.
  const machine = project({ statusline: false });
  writeFileSync(
    join(h.home, "config.toml"),
    '[marketplaces.projectstore-npx]\nsource = "x"\n\n[plugins."projectstore@projectstore-npx"]\nenabled = true\n',
  );
  const npm2 = fakeNpmSpawn();
  const m = await runVerb("upgrade", machine, {
    root: ROOT,
    home: h.home,
    env: h.env,
    ask: async () => "n",
    fetchSpawn: npm2.spawn,
  });
  assert.deepEqual(m.plan.harnesses, [SRC.id], "a machine registration selects nothing");
  // Bare install and bare plan read contract 8 alone, on both projects.
  for (const p of [proj, machine]) {
    assert.deepEqual(plan(p, { root: ROOT, home: h.home, env: h.env }).harnesses, [SRC.id]);
    const i = await runVerb("install", p, {
      root: ROOT,
      home: h.home,
      env: h.env,
      ask: async () => "n",
      fetchSpawn: npm2.spawn,
    });
    assert.deepEqual(i.plan.harnesses, [SRC.id]);
  }
  assert.deepEqual(npm2.calls, [], "none of them fetched");
  // upgrade's no-harness refusal names both signals.
  const empty = mkdtempSync(join(tmpdir(), "ps-empty-"));
  const refused = plan(empty, { root: ROOT, env: h.env, state: true }).refusals[0];
  assert.ok(
    refused.includes(
      `detected by its project directory: ${CODEX.runtime.harness_dir}, or by its state directory: ${relative(empty, layoutPaths(empty).harnessState(CODEX.id))}`,
    ),
    refused,
  );
  assert.ok(!plan(empty, { root: ROOT, env: h.env }).refusals[0].includes("state directory"), "install's names one");
});

test("install rule 5: a project uninstall removes the welcome marker and an empty state/<id>/; foreign content, a state/ without the header, other files and a foreign launcher stay and are named; --surface plans none", () => {
  const env = noHostEnv();
  const stateItem = (p) => p.items.find((i) => i.surface === "harness_state");
  const uninstall = (proj, extra = {}) =>
    plan(proj, { harnesses: [CODEX.id], mode: "uninstall", root: ROOT, env, ...extra });
  // The marker, then the emptied directory; the next bare upgrade plans Claude Code alone.
  const a = stateProject();
  const p = uninstall(a.proj);
  const row = stateItem(p);
  assert.equal(p.items.filter((i) => i.harness === CODEX.id).at(-1), row, "planned last for its harness");
  assert.deepEqual(
    row.steps.map((s) => [s.kind, s.path]),
    [
      ["delete", a.lp.welcomed(CODEX.id)],
      ["rmdir-state", a.lp.harnessState(CODEX.id)],
    ],
  );
  assert.match(renderPreview(p), /delete \S+welcomed\n\s+remove \S+codex\/ once empty\n/);
  apply(p, { env });
  assert.equal(existsSync(a.lp.harnessState(CODEX.id)), false, "the marker and the empty directory are gone");
  assert.ok(read(a.lp.stateGitignore).includes(RUNTIME_GITIGNORE_HEADER), "the rest of state/ stays");
  assert.deepEqual(
    plan(a.proj, { root: ROOT, env, state: true }).harnesses,
    [SRC.id],
    "the next bare upgrade plans Claude Code alone",
  );
  // An empty state directory: the rmdir alone.
  const e = stateProject({ marker: null });
  assert.deepEqual(
    stateItem(uninstall(e.proj)).steps.map((s) => s.kind),
    ["rmdir-state"],
  );
  apply(uninstall(e.proj), { env });
  assert.equal(existsSync(e.lp.harnessState(CODEX.id)), false);
  // A marker that is not one ISO line, and one under a state/ without the header: left in place.
  for (const [what, fx] of [
    ["foreign content", stateProject({ marker: "written by hand\n" })],
    ["no header", stateProject({ headed: false })],
  ]) {
    const q = uninstall(fx.proj);
    assert.equal(stateItem(q), undefined, what);
    apply(q, { env });
    assert.ok(existsSync(fx.lp.welcomed(CODEX.id)), `${what}: left in place`);
  }
  // Another file keeps the directory, and is named.
  const o = stateProject();
  writeFileSync(join(o.lp.harnessState(CODEX.id), "notes.txt"), "mine\n");
  const po = uninstall(o.proj);
  assert.deepEqual(stateItem(po).steps.find((s) => s.kind === "rmdir-state").left, ["notes.txt"]);
  assert.match(renderPreview(po), /once empty — notes\.txt stays and keeps it/);
  const done = apply(po, { env });
  assert.ok(!existsSync(o.lp.welcomed(CODEX.id)) && existsSync(join(o.lp.harnessState(CODEX.id), "notes.txt")));
  assert.deepEqual(done.find((d) => d.surface === "harness_state").steps.at(-1), {
    kind: "rmdir-state",
    ok: true,
    removed: false,
    reason: "notes.txt remain",
  });
  // Claude Code: a launcher that is not ours is its surface item's, never this step's.
  const c = project({ bound: false });
  const lc = layoutPaths(c);
  welcomedBy0305(c, SRC.id);
  writeFileSync(lc.launcher(SRC.id), "console.log('mine');\n");
  const pc = plan(c, { harnesses: [SRC.id], mode: "uninstall", root: ROOT, env });
  assert.equal(item(pc, "statusline_launcher").action, "skip", "not ours: left by its own item");
  assert.deepEqual(stateItem(pc).steps.find((s) => s.kind === "rmdir-state").left, ["statusline.mjs"]);
  assert.match(renderPreview(pc), /statusline\.mjs stays and keeps it/);
  apply(pc, { env });
  assert.ok(existsSync(lc.launcher(SRC.id)) && !existsSync(lc.welcomed(SRC.id)));
  // A narrowed uninstall plans no such step.
  const s = stateProject();
  const ps = uninstall(s.proj, { surfaces: ["agents_block"] });
  assert.equal(stateItem(ps), undefined);
  apply(ps, { env });
  assert.ok(existsSync(s.lp.welcomed(CODEX.id)), "--surface leaves state/codex/ as it is");
});

// ─── One block item per run (the story "One run plans the agents block once,
// and a bare uninstall selects every harness the project uses") ──────────

import { SNAPSHOT, blockPlanTable } from "./fixtures/block-plans.mjs";

// The differences a single-harness plan may show against the branch-point
// snapshot, and no others (rule 4):
//   (a) a block removal that leaves a file which held only the block has
//       deleteIfEmpty true where it was false, so that file is deleted; an
//       import pointing at the deleted file then dangles and is removed;
//   (b) an uninstall that keeps the block for a harness outside the run keeps
//       that harness's bridge — the file it reads natively, holding only the
//       import — where it removed it.
// Both sides come back with the allowed differences undone, and which applied.
const fileOf = (p) => p.slice(p.lastIndexOf("/") + 1);
function tolerated(want, got) {
  const allowed = new Set();
  const twin = (x, side) => side.find((y) => y.surface === x.surface && y.action === x.action && y.path === x.path);
  const vanished = new Set();
  const undone = got
    .map((g) => {
      const w = twin(g, want);
      if (
        w &&
        g.surface === "agents_block" &&
        g.action === "remove" &&
        w.deleteIfEmpty === false &&
        g.deleteIfEmpty === true &&
        typeof g.after === "string" &&
        !g.after.trim()
      ) {
        vanished.add(fileOf(g.path));
        allowed.add("a");
        return { ...g, deleteIfEmpty: false };
      }
      return g;
    })
    .filter(
      (g) =>
        !(
          !twin(g, want) &&
          g.surface === "agents_block_import" &&
          g.action === "remove" &&
          vanished.has(String(g.entry).slice(1)) &&
          /points at a file this uninstall removes/.test(g.reason)
        ),
    );
  const kept = new Set(
    got
      .filter(
        (g) => g.surface === "agents_block" && g.action === "skip" && /read by another harness too/.test(g.reason),
      )
      .map((g) => fileOf(g.path)),
  );
  const bridge = (w) =>
    w.surface === "agents_block_import" &&
    w.action === "remove" &&
    !twin(w, got) &&
    kept.has(String(w.entry).slice(1)) &&
    /holds only the import registration added/.test(w.reason) &&
    manifests().some((m) => m.id !== w.harness && m.surfaces.agents_block.reads_natively === fileOf(w.path));
  const expected = want.filter((w) => {
    if (!bridge(w)) return true;
    allowed.add("b");
    return false;
  });
  return { want: expected, got: undone, allowed: [...allowed].sort() };
}

test("one block per run, one harness: single-harness block plans equal the branch-point snapshot but for rule 4's two differences", () => {
  const want = JSON.parse(read(SNAPSHOT));
  const got = blockPlanTable();
  assert.deepEqual(
    Object.keys(got),
    Object.keys(want),
    "the same table: every manifest × mode × --surface × file state",
  );
  const differs = {};
  for (const [k, items] of Object.entries(want)) {
    const t = tolerated(items, got[k]);
    assert.deepEqual(t.got, t.want, k);
    if (t.allowed.length) differs[k] = t.allowed;
  }
  // Where each applies, and nowhere else.
  assert.deepEqual(differs, {
    [`${SRC.id} | uninstall | agents_block | block in AGENTS.md + import`]: ["a"],
    [`${SRC.id} | uninstall | agents_block | stale block`]: ["a"],
    [`${SRC.id} | uninstall | agents_block | block in AGENTS.md + CLAUDE.md holding only the import`]: ["a"],
    [`${CODEX.id} | uninstall | - | block in AGENTS.md + CLAUDE.md holding only the import`]: ["b"],
  });
});

const BOTH = [SRC, CODEX];
const writesOf = (p) => p.items.filter((i) => !["skip", "refuse"].includes(i.action));
const blockRows = (p) => p.items.filter((i) => i.surface === "agents_block" || i.surface === "agents_block_import");
const rowsOf = (proj, items) => items.map((i) => [i.harness, i.surface, i.action, relative(proj, i.path)]);
const tmp = (name) => mkdtempSync(join(tmpdir(), `ps-inst-once-${name}-`));

test("one block per run: install of both harnesses on an empty project plans one block and one import, in either order, with .claude/ and with both directories; the second plan is zero-change", async () => {
  for (const order of [BOTH, [...BOTH].reverse()]) {
    for (const dirs of [[], [SRC], BOTH]) {
      const ids = order.map((m) => m.id);
      const what = `${ids.join(" then ")}, ${dirs.map((m) => m.runtime.harness_dir).join(" and ") || "no directory"}`;
      const proj = tmp("empty");
      for (const m of dirs) mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
      const h = hostSandbox();
      const r = await runVerb("install", proj, {
        harnesses: ids,
        root: ROOT,
        home: h.home,
        env: h.env,
        ask: async () => "y",
        fetchSpawn: fakeNpmSpawn().spawn,
        spawn: codexHost(h.home),
      });
      assert.deepEqual(
        rowsOf(proj, blockRows(r.plan)),
        [
          [ids[0], "agents_block", "create", "AGENTS.md"],
          [ids[0], "agents_block_import", "create", "CLAUDE.md"],
        ],
        what,
      );
      assert.equal(item(r.plan, "agents_block_import").after, "@AGENTS.md\n", what);
      // The item sits under the run's first harness; its reason names the reader.
      const reader = BOTH.find((m) => m.surfaces.agents_block.reads_natively === "CLAUDE.md");
      assert.equal(
        item(r.plan, "agents_block_import").reason,
        `CLAUDE.md is what ${reader.display_name} reads by itself; it is created to import AGENTS.md`,
        what,
      );
      assert.equal(r.failed, null, `${what}: ${JSON.stringify(r.failed)}`);
      assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n", `${what}: AGENTS.md holds exactly one block`);
      assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n", `${what}: CLAUDE.md holds exactly the import line`);
      const again = plan(proj, { harnesses: ids, root: ROOT, home: h.home, env: h.env });
      assert.deepEqual(
        writesOf(again).map((i) => [i.harness, i.surface, i.action]),
        [],
        `${what}: the second plan is zero-change`,
      );
    }
  }
});

test("one block per run, existing files: a user's CLAUDE.md, a block in CLAUDE.md (the exact reason, either order), AGENTS.md only; each second run is zero-change", () => {
  const home = tmp("home");
  const env = noHostEnv();
  for (const order of [BOTH, [...BOTH].reverse()]) {
    const ids = order.map((m) => m.id);
    const run = (proj) => plan(proj, { harnesses: ids, home, root: ROOT, env });
    const settle = (proj, what) => {
      apply(run(proj), { env, home });
      assert.deepEqual(
        writesOf(run(proj)).map((i) => [i.harness, i.surface, i.action]),
        [],
        `${ids.join(" then ")}, ${what}: the second run is zero-change`,
      );
    };

    // A user's CLAUDE.md with prose: the block goes to AGENTS.md, and CLAUDE.md keeps its prose and gains the import.
    const prose = project({ bound: false, claude: "# Mine\n" });
    assert.deepEqual(rowsOf(prose, blockRows(run(prose))), [
      [ids[0], "agents_block", "create", "AGENTS.md"],
      [ids[0], "agents_block_import", "add", "CLAUDE.md"],
    ]);
    settle(prose, "prose in CLAUDE.md");
    assert.equal(read(join(prose, "AGENTS.md")), BLOCK + "\n");
    assert.equal(read(join(prose, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n");

    // A Claude-only project with the block in CLAUDE.md: planned once, it
    // moves to AGENTS.md, and CLAUDE.md keeps its prose and imports it.
    const moved = project({ bound: false, claude: "# Mine\n\n" + BLOCK + "\n" });
    const m = run(moved);
    assert.deepEqual(rowsOf(moved, blockRows(m)), [
      [ids[0], "agents_block", "remove", "CLAUDE.md"],
      [ids[0], "agents_block", "create", "AGENTS.md"],
    ]);
    assert.equal(
      m.items.find((i) => i.surface === "agents_block" && i.action === "create").reason,
      "in CLAUDE.md, which Codex does not read; install moves it to AGENTS.md",
    );
    assert.equal(
      m.items.find((i) => i.surface === "agents_block" && i.action === "remove").after,
      "@AGENTS.md\n\n# Mine\n",
    );
    settle(moved, "block in CLAUDE.md");
    assert.equal(read(join(moved, "AGENTS.md")), BLOCK + "\n");
    assert.equal(read(join(moved, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n");

    // An AGENTS.md-only project: the block stays, and CLAUDE.md is created holding the import.
    const agentsOnly = project({ bound: false, agents: BLOCK + "\n" });
    assert.deepEqual(rowsOf(agentsOnly, blockRows(run(agentsOnly))), [
      [ids[0], "agents_block", "skip", "AGENTS.md"],
      [ids[0], "agents_block_import", "create", "CLAUDE.md"],
    ]);
    settle(agentsOnly, "AGENTS.md only");
    assert.equal(read(join(agentsOnly, "AGENTS.md")), BLOCK + "\n");
    assert.equal(read(join(agentsOnly, "CLAUDE.md")), "@AGENTS.md\n");
  }
});

// The first criterion's result, through plan() and apply(): the block in
// AGENTS.md and CLAUDE.md holding the import, and nothing else of ours.
function bothInstalled() {
  const proj = tmp("both"),
    home = tmp("home");
  const env = noHostEnv();
  apply(plan(proj, { harnesses: BOTH.map((m) => m.id), home, root: ROOT, env, surfaces: ["agents_block"] }), {
    env,
    home,
  });
  assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n");
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n");
  return { proj, home, env };
}

test("one block per run, upgrade: a stale block on the two-harness result is one replace-entry on AGENTS.md and no import item", async () => {
  const { proj } = bothInstalled();
  writeFileSync(
    join(proj, "AGENTS.md"),
    read(join(proj, "AGENTS.md")).replace(`projectstore:agents v${VERSION} `, `projectstore:agents v${VERSION - 1} `),
  );
  const h = hostSandbox();
  const r = await runVerb("upgrade", proj, {
    harnesses: BOTH.map((m) => m.id),
    root: ROOT,
    home: h.home,
    env: h.env,
    ask: async () => "n",
    fetchSpawn: fakeNpmSpawn().spawn,
  });
  assert.deepEqual(rowsOf(proj, blockRows(r.plan)), [[SRC.id, "agents_block", "replace-entry", "AGENTS.md"]]);
  assert.equal(item(r.plan, "agents_block").reason, `v${VERSION - 1} → v${VERSION}`);
});

test("one block per run, --surface agents_block: install plans the same two items and nothing else, uninstall removes the block and the import once each; --surface statusline plans no block", () => {
  const proj = tmp("narrow"),
    home = tmp("home");
  const env = noHostEnv();
  const ids = BOTH.map((m) => m.id);
  const p = plan(proj, { harnesses: ids, home, root: ROOT, env, surfaces: ["agents_block"] });
  assert.deepEqual(rowsOf(proj, p.items), [
    [SRC.id, "agents_block", "create", "AGENTS.md"],
    [SRC.id, "agents_block_import", "create", "CLAUDE.md"],
  ]);
  apply(p, { env, home });
  const u = plan(proj, { harnesses: ids, mode: "uninstall", home, root: ROOT, env, surfaces: ["agents_block"] });
  assert.deepEqual(rowsOf(proj, u.items), [
    [SRC.id, "agents_block", "remove", "AGENTS.md"],
    [SRC.id, "agents_block_import", "remove", "CLAUDE.md"],
  ]);
  apply(u, { env, home });
  assert.ok(
    !existsSync(join(proj, "AGENTS.md")) && !existsSync(join(proj, "CLAUDE.md")),
    "both files held only ours, and both are gone",
  );
  const other = plan(proj, { harnesses: ids, home, root: ROOT, env, surfaces: ["statusline"] });
  assert.deepEqual(
    other.items.filter((i) => i.surface.startsWith("agents_block")),
    [],
    "no agents_block in --surface: no block item",
  );
});

test("one block per run, the preview: the other harness's rows name the block as the same one, above; plan --json keeps its top-level keys and has one agents_block item", () => {
  const home = tmp("home");
  const env = noHostEnv();
  for (const order of [BOTH, [...BOTH].reverse()]) {
    const [first, second] = order;
    const proj = project({ bound: false });
    const p = plan(proj, { harnesses: order.map((m) => m.id), home, root: ROOT, env });
    const line = `· AGENTS.md — the same block as ${first.display_name}, above`;
    const text = renderPreview(p);
    assert.equal(text.split("\n").filter((l) => l.includes(line)).length, 1, text);
    // In the second harness's rows: every item after it is that harness's,
    // and the block's own item, the first harness's, is above it.
    assert.deepEqual(
      p.sharedBlock.others.map((o) => [o.harness, o.display]),
      [[second.id, second.display_name]],
    );
    const at = p.sharedBlock.others[0].at;
    assert.ok(
      p.items.slice(at).every((i) => i.harness === second.id),
      JSON.stringify(p.items.map((i) => [i.harness, i.surface])),
    );
    assert.ok(p.items.slice(0, at).some((i) => i.surface === "agents_block" && i.harness === first.id));
  }
  // Contract 7's line, as the story's acceptance writes it.
  const manifestOrder = renderPreview(
    plan(project({ bound: false }), { harnesses: BOTH.map((m) => m.id), home, root: ROOT, env }),
  );
  assert.ok(manifestOrder.includes("  · AGENTS.md — the same block as Claude Code, above\n"), manifestOrder);
  // plan --json through the bin: the key set it had, and one block item.
  const proj = project({ bound: false });
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "bin", "projectstore.mjs"),
      "plan",
      "--harness",
      SRC.id,
      "--harness",
      CODEX.id,
      "--json",
      "--project",
      proj,
    ],
    { encoding: "utf8", env: noHostEnv({ HOME: home }), timeout: 60000 },
  );
  const result = JSON.parse(r.stdout).result;
  assert.deepEqual(Object.keys(result), [
    "projectDir",
    "mode",
    "named",
    "detected",
    "harnesses",
    "reports",
    "items",
    "refusals",
    "ok",
    "incomplete",
    "root",
    "plannedAgainst",
  ]);
  assert.equal(result.items.filter((i) => i.surface === "agents_block").length, 1);
  assert.equal(result.items.filter((i) => i.surface === "agents_block_import").length, 1);
});

test("one block per run, the keep seam: the block's items are contiguous and precede every item of a later harness", () => {
  const home = tmp("home");
  const env = noHostEnv();
  for (const order of [BOTH, [...BOTH].reverse()]) {
    const p = plan(project({ bound: false }), { harnesses: order.map((m) => m.id), home, root: ROOT, env });
    const at = p.items.map((i, k) => (i.surface.startsWith("agents_block") ? k : -1)).filter((k) => k >= 0);
    assert.ok(at.length > 0);
    assert.deepEqual(
      at,
      at.map((_, k) => at[0] + k),
      "contiguous",
    );
    const later = p.items.map((i, k) => (i.harness !== order[0].id ? k : -1)).filter((k) => k >= 0);
    assert.ok(
      later.length && later.every((k) => k > at.at(-1)),
      JSON.stringify(p.items.map((i) => [i.harness, i.surface])),
    );
  }
});

// The converge story's keep (rule 5) beside Codex: a git copy enabled for the
// project, kept (the channel "git"), its bin a stub (stubCopy) that lists its
// writes only while their files are missing; Codex through the shell fetch's
// fake npm (layShellTree) and its in-process host (codexHost). The keep step
// spawns the stub through the real spawnSync; every other host command goes to
// codexHost.
const KEEP_GIT = "projectstore@SmartAndPoint";
function keepBeside(proj, writes, spec = {}, { copy: withCopy = true, extraEnv = {} } = {}) {
  const h = hostSandbox();
  const copy = withCopy ? stubCopy(h.home, "0.29.0", { writes, ...spec }) : null;
  if (copy)
    writeRegistry(h.home, [
      { scope: "user", installPath: copy, version: "0.29.0", lastUpdated: "2026-10-01T00:00:00Z" },
    ]);
  const env = { ...h.env, HOME: h.home, ...extraEnv };
  const codex = codexHost(h.home);
  const spawn = (bin, argv, o) => (bin === process.execPath ? spawnSync(bin, argv, o) : codex(bin, argv, o));
  // Each run's fake npm rides on its result, so a test can read what it fetched.
  const run = async (answer) => {
    const npm = fakeNpmSpawn();
    const r = await runVerb("upgrade", proj, {
      harnesses: BOTH.map((m) => m.id),
      root: ROOT,
      home: h.home,
      env,
      channel: "git",
      ask: async () => answer,
      fetchSpawn: npm.spawn,
      spawn,
    });
    return Object.assign(r, { npm });
  };
  return { h, copy, env, run };
}
const STUB_LAUNCHER = {
  surface: "statusline_launcher",
  kind: "exclusive",
  action: "create",
  file: join(".projectstore", "stub-launcher.mjs"),
  body: "// the stub copy's\n",
};

test("converge criterion 'The keep', two harnesses: on a fixture whose block sits only in CLAUDE.md, the run's one block item comes before the keep step and moves it to AGENTS.md with CLAUDE.md importing it; Codex is planned as under no channel; a second run is zero-change", async () => {
  const proj = project({ bound: false, claude: "# Mine\n\n" + BLOCK + "\n" });
  // The caller's environment points at Codex: its home is set, and so is its plugin root.
  const elsewhere = join(tmp("codex-plugin-root"), "projectstore");
  const k = keepBeside(
    proj,
    [STUB_LAUNCHER],
    {},
    { extraEnv: { [CODEX.runtime.plugin_root_env]: elsewhere, PROJECTSTORE_HARNESS: CODEX.id } },
  );
  const r = await k.run("y");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.equal(r.npm.installs().length, 1, "Codex's shell is fetched, as under no channel");
  const at = (pred) => r.plan.items.findIndex(pred);
  const keep = at((i) => i.kind === "channel");
  assert.ok(keep > 0, JSON.stringify(r.plan.items.map((i) => [i.harness, i.surface, i.action])));
  assert.equal(r.plan.items[keep].entry, KEEP_GIT);
  const blocks = r.plan.items.map((i, n) => (i.surface.startsWith("agents_block") ? n : -1)).filter((n) => n >= 0);
  assert.deepEqual(
    rowsOf(proj, blockRows(r.plan)),
    [
      [SRC.id, "agents_block", "remove", "CLAUDE.md"],
      [SRC.id, "agents_block", "create", "AGENTS.md"],
    ],
    "one block, the whole run's, Claude Code included",
  );
  assert.ok(
    blocks.every((n) => n < keep),
    "the block comes before the keep step",
  );
  assert.ok(
    !r.plan.items.some((i) => i.harness === SRC.id && ["registration", "exclusive"].includes(i.kind)),
    "no Claude Code row of its own",
  );
  assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n");
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n\n# Mine\n");
  assert.equal(read(join(proj, STUB_LAUNCHER.file)), STUB_LAUNCHER.body, "the kept copy wrote its own");
  // Codex's rows are what they are under no channel.
  const codexRows = (channel) =>
    plan(proj, { harnesses: BOTH.map((m) => m.id), root: ROOT, home: k.h.home, env: k.env, channel })
      .items.filter((i) => i.harness === CODEX.id)
      .map((i) => [i.surface, i.kind, i.action, i.state, i.reason]);
  assert.deepEqual(codexRows("git"), codexRows(null));
  // The child's environment names the KEPT harness's runtime variables, from
  // its manifest, whatever harness the caller's environment points at: the
  // copy's root as its plugin root, the project, its home pinned — and no
  // other manifest's plugin root.
  const calls = stubCalls(k.copy);
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["plan", "upgrade"],
  );
  for (const c of calls) {
    assert.equal(c.pluginRoot, k.copy, c.argv[0]);
    assert.equal(c.env[SRC.runtime.project_dir_env], proj, c.argv[0]);
    assert.equal(c.home, join(k.h.home, SRC.runtime.home_default), c.argv[0]);
    assert.equal(c.env[CODEX.runtime.plugin_root_env], null, `${c.argv[0]}: Codex's plugin root is dropped`);
    assert.equal(c.env.PROJECTSTORE_HARNESS, null, `${c.argv[0]}: the caller's forced harness is dropped`);
  }
  const again = await k.run("n");
  assert.deepEqual(
    writesOf(again.plan).map((i) => [i.harness, i.surface, i.action]),
    [],
    "the second run is zero-change",
  );
  assert.equal(stubCalls(k.copy).filter((c) => c.argv[0] === "upgrade").length, 1);
});

test("one block per run, under keep: on an empty project with a git copy kept beside Codex, the run's one agents_block item comes before the keep step, the keep's touches drop the copy's block row, AGENTS.md holds one block and CLAUDE.md the import, and a second run plans zero changes", async () => {
  const proj = tmp("keep");
  // The copy's own plan, on its own, lists `create CLAUDE.md` for the block —
  // what claude-code alone plans on an empty project — so the drop is proven.
  const blockRow = { surface: "agents_block", kind: "shared", action: "create", file: "CLAUDE.md", body: BLOCK + "\n" };
  const k = keepBeside(proj, [blockRow, STUB_LAUNCHER]);
  const own = spawnSync(
    process.execPath,
    [
      join(k.copy, "bin", "projectstore.mjs"),
      "plan",
      "--harness",
      SRC.id,
      "--no-register",
      "--json",
      "--project",
      proj,
    ],
    { encoding: "utf8", cwd: proj, env: k.env },
  );
  assert.deepEqual(
    JSON.parse(own.stdout).result.items.map((i) => [i.surface, i.action, relative(proj, i.path)]),
    [
      ["agents_block", "create", "CLAUDE.md"],
      ["statusline_launcher", "create", STUB_LAUNCHER.file],
    ],
  );
  const r = await k.run("y");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const keep = r.plan.items.findIndex((i) => i.kind === "channel");
  const block = r.plan.items.findIndex((i) => i.surface === "agents_block");
  assert.ok(block >= 0 && keep > block, "the run's agents_block item comes before the keep step");
  assert.deepEqual(rowsOf(proj, blockRows(r.plan)), [
    [SRC.id, "agents_block", "create", "AGENTS.md"],
    [SRC.id, "agents_block_import", "create", "CLAUDE.md"],
  ]);
  const touches = r.plan.items[keep].steps[0].touches;
  assert.deepEqual(
    touches.map((t) => [t.surface, t.action, relative(proj, t.path)]),
    [["statusline_launcher", "create", STUB_LAUNCHER.file]],
    "no agents_block or agents_block_import row",
  );
  assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n", "AGENTS.md holds one block");
  assert.equal(
    read(join(proj, "CLAUDE.md")),
    "@AGENTS.md\n",
    "CLAUDE.md holds the import: the copy's own apply found it there and wrote nothing",
  );
  assert.equal(stubCalls(k.copy).filter((c) => c.argv[0] === "upgrade").length, 1);
  const again = await k.run("n");
  assert.deepEqual(
    writesOf(again.plan).map((i) => [i.harness, i.surface, i.action]),
    [],
    "a second run plans zero changes",
  );
  assert.equal(
    again.plan.items.find((i) => i.kind === "channel")?.action,
    "skip",
    "the copy lists nothing: no keep step — only the line saying the copy is behind",
  );
});

test("converge rules 1 and 5: under the channel git, a run plan() will refuse fetches no shell first — no copy to keep, or the kept copy's own plan refused — and writes nothing", async () => {
  const none = keepBeside(tmp("keep-none"), [], {}, { copy: false });
  const r = await none.run("y");
  assert.equal(r.plan.ok, false);
  assert.match(r.plan.refusals[0], /^no git-marketplace copy of projectstore is enabled for this project/);
  assert.deepEqual(r.npm.calls, [], "no shell fetched, no registry resolved");
  const proj = tmp("keep-refused");
  const refused = keepBeside(proj, [STUB_LAUNCHER], { plan: { refusals: ["two bindings: keep one"] } });
  const s = await refused.run("y");
  assert.equal(s.plan.ok, false);
  assert.ok(s.plan.refusals.includes(`${KEEP_GIT} 0.29.0: two bindings: keep one`), JSON.stringify(s.plan.refusals));
  assert.deepEqual(s.gate, { confirmed: false, why: "refused" });
  assert.deepEqual(s.npm.calls, [], "the copy's plan refused before the fetch");
  assert.deepEqual(readdirSync(proj), [], "nothing written");
});

test("one block per run, the roster: plan(…, { layout }) renders that layout's roster, and a bound install with no layout renders the binding's", () => {
  const { home, root } = fixture();
  const engineering = JSON.parse(read(join(root, "scaffold", "layouts", "engineering.json")));
  const roster = engineering.agents.slice(0, 1);
  assert.notDeepEqual(roster, engineering.agents, "the test layout's agents differ from engineering's");
  writeFileSync(
    join(root, "scaffold", "layouts", "roster-test.json"),
    JSON.stringify({ ...engineering, agents: roster }),
  );
  const proj = project();
  const named = item(
    plan(proj, { harnesses: [SRC.id], home, root, surfaces: ["agents_block"], layout: "roster-test" }),
    "agents_block",
  );
  assert.equal(named.after, renderAgentsBlock(TEMPLATE, roster) + "\n", "the layout the run names");
  const bound = item(plan(proj, { harnesses: [SRC.id], home, root, surfaces: ["agents_block"] }), "agents_block");
  assert.equal(bound.after, renderAgentsBlock(TEMPLATE, engineering.agents) + "\n", "no layout: the binding's");
  assert.notEqual(named.after, bound.after);
});

test("one block per run, uninstall of both: one block removal and one import removal, the emptied files deleted, DONE counts two; one harness alone keeps the block, and Codex's alone keeps Claude Code's bridge; prose in AGENTS.md stays", async () => {
  const ids = BOTH.map((m) => m.id);
  const removed = [
    [SRC.id, "agents_block", "remove", "AGENTS.md"],
    [SRC.id, "agents_block_import", "remove", "CLAUDE.md"],
  ];
  // Only the block and the import: DONE counts exactly those two.
  const a = bothInstalled();
  const chunks = [];
  const out = {
    isTTY: false,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
  };
  const r = await runVerb("uninstall", a.proj, {
    harnesses: ids,
    root: ROOT,
    home: a.home,
    env: a.env,
    out,
    ask: async () => "y",
  });
  assert.deepEqual(rowsOf(a.proj, blockRows(r.plan)), removed);
  assert.ok(!existsSync(join(a.proj, "AGENTS.md")), "AGENTS.md, left empty, is deleted");
  assert.ok(!existsSync(join(a.proj, "CLAUDE.md")), "CLAUDE.md held only the import");
  assert.match(chunks.join(""), /\nDone — 2 changes in /);

  // One harness of the two: the block stays, with today's reason. The import
  // stays too when it is the bridge of the harness left out — the file that
  // harness reads by itself (rule 4: "leaves the block and the import in
  // place"); the source harness's own uninstall still takes its own file's.
  for (const [m, claude] of [
    [CODEX, "@AGENTS.md\n"],
    [SRC, null],
  ]) {
    const b = bothInstalled();
    const narrowed = plan(b.proj, { harnesses: [m.id], mode: "uninstall", home: b.home, root: ROOT, env: b.env });
    assert.equal(item(narrowed, "agents_block").action, "skip", m.id);
    assert.equal(
      item(narrowed, "agents_block").reason,
      "AGENTS.md is read by another harness too — a per-harness uninstall leaves the project's block alone. Remove it with --surface agents_block",
    );
    assert.equal(
      narrowed.items.filter((i) => i.surface === "agents_block_import").length,
      claude === null ? 1 : 0,
      `${m.id}: ${JSON.stringify(blockRows(narrowed).map((i) => [i.surface, i.action, i.reason]))}`,
    );
    apply(narrowed, { env: b.env, home: b.home });
    assert.equal(read(join(b.proj, "AGENTS.md")), BLOCK + "\n", `${m.id}: the block stays`);
    if (claude === null)
      assert.ok(!existsSync(join(b.proj, "CLAUDE.md")), `${m.id}: its own CLAUDE.md, holding only the import, goes`);
    else
      assert.equal(
        read(join(b.proj, "CLAUDE.md")),
        claude,
        `${m.id}: the other harness's bridge to the kept block stays`,
      );
  }

  // The user's prose in AGENTS.md: the file stays, holding it.
  const c = bothInstalled();
  writeFileSync(join(c.proj, "AGENTS.md"), "# Agents\n\n" + read(join(c.proj, "AGENTS.md")));
  const u = plan(c.proj, { harnesses: ids, mode: "uninstall", home: c.home, root: ROOT, env: c.env });
  assert.deepEqual(rowsOf(c.proj, blockRows(u)), removed);
  apply(u, { env: c.env, home: c.home });
  assert.equal(read(join(c.proj, "AGENTS.md")), "# Agents\n");
  assert.ok(!existsSync(join(c.proj, "CLAUDE.md")), "CLAUDE.md held only the import");
});

test("one block per run, the preview: no 'same block' line where there is no block — under 'no block to remove', or beside an unclosed-block refusal", () => {
  const home = tmp("home");
  const env = noHostEnv();
  const ids = BOTH.map((m) => m.id);
  const none = plan(project({ bound: false }), { harnesses: ids, mode: "uninstall", home, root: ROOT, env });
  assert.equal(item(none, "agents_block").reason, "no block to remove");
  assert.equal(none.sharedBlock, null);
  assert.ok(!renderPreview(none).includes("the same block as"), renderPreview(none));
  for (const mode of ["install", "uninstall"]) {
    const unclosed = plan(project({ bound: false, claude: "<!-- projectstore:agents v3 -->\n## half\n" }), {
      harnesses: ids,
      mode,
      home,
      root: ROOT,
      env,
    });
    assert.equal(item(unclosed, "agents_block").action, "refuse", mode);
    assert.equal(unclosed.sharedBlock, null, mode);
    assert.ok(!renderPreview(unclosed).includes("the same block as"), `${mode}: ${renderPreview(unclosed)}`);
  }
  // A block that is there and removed is still named.
  const b = bothInstalled();
  assert.ok(
    renderPreview(plan(b.proj, { harnesses: ids, mode: "uninstall", home: b.home, root: ROOT, env })).includes(
      `  · AGENTS.md — the same block as ${SRC.display_name}, above\n`,
    ),
  );
});

test("one block per run, release safety: the block in both CLAUDE.md and AGENTS.md, as 0.29.2's two-harness install left it — a bare upgrade removes the duplicate in one run, and a second plan is zero-change", async () => {
  const proj = tmp("0292");
  for (const m of BOTH) mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
  writeFileSync(join(proj, "CLAUDE.md"), BLOCK + "\n");
  writeFileSync(join(proj, "AGENTS.md"), BLOCK + "\n");
  const h = hostSandbox();
  const r = await runVerb("upgrade", proj, {
    root: ROOT,
    home: h.home,
    env: h.env,
    ask: async () => "y",
    fetchSpawn: fakeNpmSpawn().spawn,
    spawn: codexHost(h.home),
  });
  assert.deepEqual(r.plan.harnesses, [SRC.id, CODEX.id]);
  assert.deepEqual(rowsOf(proj, blockRows(r.plan)), [
    [SRC.id, "agents_block", "remove", "CLAUDE.md"],
    [SRC.id, "agents_block", "skip", "AGENTS.md"],
  ]);
  assert.equal(item(r.plan, "agents_block").reason, "duplicate of the block in AGENTS.md; @AGENTS.md import added");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.equal(read(join(proj, "AGENTS.md")), BLOCK + "\n", "one block, in AGENTS.md");
  assert.equal(read(join(proj, "CLAUDE.md")), "@AGENTS.md\n", "CLAUDE.md imports it");
  const again = plan(proj, { root: ROOT, home: h.home, env: h.env, state: true });
  assert.deepEqual(again.harnesses, [SRC.id, CODEX.id]);
  assert.deepEqual(
    writesOf(again).map((i) => [i.harness, i.surface, i.action]),
    [],
    "the second plan is zero-change",
  );
});

test("one block per run, rule 5: without a terminal, a bare uninstall's refusal names a harness selected only by its state directory", () => {
  const { proj, lp } = stateProject();
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), "uninstall", "--project", proj], {
    encoding: "utf8",
    cwd: tmp("cwd"),
    env: noHostEnv({ HOME: tmp("home") }),
    timeout: 60000,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^projectstore uninstall · /);
  assert.ok(
    r.stdout.includes(
      `Nothing written: without a terminal, a bare uninstall refuses. Name the harness to confirm: --harness ${SRC.id} | ${CODEX.id}\n`,
    ),
    r.stdout,
  );
  assert.ok(existsSync(lp.welcomed(CODEX.id)), "nothing was written");
});

test("one block per run, no 0-byte file: after a two-harness install, uninstall of either harness with --surface agents_block deletes the emptied AGENTS.md", () => {
  for (const m of BOTH) {
    const { proj, home, env } = bothInstalled();
    const u = plan(proj, { harnesses: [m.id], mode: "uninstall", home, root: ROOT, env, surfaces: ["agents_block"] });
    assert.equal(item(u, "agents_block").deleteIfEmpty, true, m.id);
    apply(u, { env, home });
    assert.ok(!existsSync(join(proj, "AGENTS.md")), `${m.id}: no 0-byte AGENTS.md is left`);
  }
});

test("one block per run, rule 5: a bare uninstall selects by directory or state directory and asks once; bare plan, bare install and uninstall --global keep contract 8; with neither, the refusal names both signals", async () => {
  const home = tmp("home");
  const env = noHostEnv();
  const bare = async (proj, extra = {}) => {
    let asked = 0;
    const r = await runVerb("uninstall", proj, {
      root: ROOT,
      home,
      env,
      ask: async () => {
        asked++;
        return "n";
      },
      ...extra,
    });
    return { r, asked };
  };
  // .claude/ and .projectstore/state/codex/
  const { proj } = stateProject();
  const both = await bare(proj);
  assert.deepEqual(both.r.plan.harnesses, [SRC.id, CODEX.id]);
  assert.deepEqual(
    both.r.plan.detected.map((d) => [d.id, d.why]),
    [
      [SRC.id, "directory"],
      [CODEX.id, "state"],
    ],
  );
  assert.equal(both.asked, 1, "asked once");
  assert.deepEqual(plan(proj, { root: ROOT, home, env }).harnesses, [SRC.id], "a bare plan keeps contract 8");
  const npm = fakeNpmSpawn();
  assert.deepEqual(
    (await runVerb("install", proj, { root: ROOT, home, env, ask: async () => "n", fetchSpawn: npm.spawn })).plan
      .harnesses,
    [SRC.id],
    "a bare install keeps contract 8",
  );
  assert.deepEqual(
    (await bare(proj, { globalRemoval: true })).r.plan.harnesses,
    [SRC.id],
    "uninstall --global keeps contract 8: a state directory is a project fact",
  );
  // .claude/ alone; state/codex/ alone.
  assert.deepEqual((await bare(project({ bound: false }))).r.plan.harnesses, [SRC.id]);
  const stateOnly = tmp("state");
  mkdirSync(layoutPaths(stateOnly).harnessState(CODEX.id), { recursive: true });
  assert.deepEqual((await bare(stateOnly)).r.plan.harnesses, [CODEX.id]);
  // Neither: the refusal, naming both signals as upgrade's does.
  const none = tmp("none");
  const refused = (await bare(none)).r;
  assert.equal(refused.gate.why, "refused");
  assert.deepEqual(refused.plan.refusals, [harnessRefusal(none, { state: true })]);
  assert.ok(
    refused.plan.refusals[0].includes(
      `or by its state directory: ${relative(none, layoutPaths(none).harnessState(CODEX.id))}`,
    ),
    refused.plan.refusals[0],
  );
});

test("one block per run, the critic's case: a bare uninstall of a Claude-only project a Codex session ran in removes the block, the import and Codex's welcome; prose stays; without state/codex/ the block stays", async () => {
  const env = noHostEnv();
  const cases = [
    ["prose in CLAUDE.md", BLOCK + "\n", "@AGENTS.md\n\n# Mine\n", { "AGENTS.md": null, "CLAUDE.md": "# Mine\n" }],
    [
      "prose in AGENTS.md",
      "# Agents\n\n" + BLOCK + "\n",
      "@AGENTS.md\n",
      { "AGENTS.md": "# Agents\n", "CLAUDE.md": null },
    ],
  ];
  for (const [what, agents, claude, after] of cases) {
    const { proj, lp } = stateProject();
    writeFileSync(join(proj, "AGENTS.md"), agents);
    writeFileSync(join(proj, "CLAUDE.md"), claude);
    const r = await runVerb("uninstall", proj, { root: ROOT, home: tmp("home"), env, ask: async () => "y" });
    assert.deepEqual(r.plan.harnesses, [SRC.id, CODEX.id], what);
    assert.deepEqual(
      rowsOf(proj, blockRows(r.plan)),
      [
        [SRC.id, "agents_block", "remove", "AGENTS.md"],
        [SRC.id, "agents_block_import", "remove", "CLAUDE.md"],
      ],
      what,
    );
    assert.equal(r.failed, null, what);
    for (const [f, text] of Object.entries(after)) {
      if (text === null) assert.ok(!existsSync(join(proj, f)), `${what}: ${f} held only ours and is gone`);
      else assert.equal(read(join(proj, f)), text, `${what}: ${f} keeps the user's prose`);
    }
    assert.equal(
      existsSync(lp.harnessState(CODEX.id)),
      false,
      `${what}: the welcome marker and the empty state/codex/ are gone`,
    );
  }
  // The same project without state/codex/: Claude Code alone, and the block stays, as today.
  const today = project({ bound: false, agents: BLOCK + "\n", claude: "@AGENTS.md\n\n# Mine\n" });
  const t = await runVerb("uninstall", today, { root: ROOT, home: tmp("home"), env, ask: async () => "y" });
  assert.deepEqual(t.plan.harnesses, [SRC.id]);
  assert.equal(item(t.plan, "agents_block").action, "skip");
  assert.match(item(t.plan, "agents_block").reason, /read by another harness too/);
  assert.equal(read(join(today, "AGENTS.md")), BLOCK + "\n");
});

test("one block per run, rule 5: a state directory makes Codex used — doctor --install warns about a block in CLAUDE.md, and the bare upgrade's plan migrates it", async () => {
  const { proj } = seedCliVault();
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  for (const f of ["AGENTS.md", "CLAUDE.md"]) rmSync(join(proj, f), { force: true });
  writeFileSync(join(proj, "CLAUDE.md"), BLOCK + "\n");
  const doctor = () => {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "bin", "projectstore.mjs"), "doctor", "--install", "--json", "--project", proj],
      { encoding: "utf8", cwd: tmp("cwd"), env: noHostEnv({ HOME: tmp("home") }), timeout: 60000 },
    );
    return JSON.parse(r.stdout).result.filter((f) => /does not see/.test(f.message));
  };
  assert.deepEqual(doctor(), [], "by directory alone, Codex is not used here");
  mkdirSync(layoutPaths(proj).harnessState(CODEX.id), { recursive: true });
  const unseen = doctor();
  assert.equal(unseen.length, 1, JSON.stringify(unseen));
  assert.equal(unseen[0].level, "warn", "used by its state directory, not identified");
  assert.match(unseen[0].message, /in CLAUDE\.md, which Codex does not see: it reads AGENTS\.md only/);
  // The bare upgrade's plan moves exactly that block.
  const h = hostSandbox();
  const up = await runVerb("upgrade", proj, {
    root: ROOT,
    home: h.home,
    env: h.env,
    ask: async () => "n",
    fetchSpawn: fakeNpmSpawn().spawn,
  });
  assert.deepEqual(up.plan.harnesses, [SRC.id, CODEX.id]);
  assert.deepEqual(rowsOf(proj, blockRows(up.plan)), [
    [SRC.id, "agents_block", "remove", "CLAUDE.md"],
    [SRC.id, "agents_block", "create", "AGENTS.md"],
  ]);
  assert.equal(
    up.plan.items.find((i) => i.surface === "agents_block" && i.action === "create").reason,
    "in CLAUDE.md, which Codex does not read; install moves it to AGENTS.md",
  );
});

// ─── Setup's engine (PR C of the setup story) ───────────────────────────
//
// PS-HARNESS: "projectstore setup asks, shows one plan and installs every
// harness it finds, with the vault", rules 7, 9, 10 and 12. No verb drives
// these yet — the setup verb does, in its own change — so they run through
// plan() and apply() with setup's inputs, and through runVerb("setup", …).
// Git is the real one, alone on PATH through a symlink, with no user or
// system configuration; a failing git is a stub.

const REAL_GIT = whichOnPath("git", process.env);
// A project <home>/src/acme with its harness directory, the folder beside it
// <home>/src/acme-vault named but not made, and an environment whose PATH is
// git alone — no host CLI.
function setupSandbox({ git = REAL_GIT } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ps-setup-home-")));
  const proj = join(home, "src", "acme");
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  if (git) symlinkSync(git, join(bin, "git"));
  const env = noHostEnv({ HOME: home, PATH: bin, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  return { home, proj, bin, env, vault: join(home, "src", "acme-vault") };
}
// A git whose init fails as a read-only parent makes it fail (tests/cli.test.mjs's stub).
function failingGit() {
  const dir = mkdtempSync(join(tmpdir(), "ps-setup-fakegit-"));
  writeFileSync(
    join(dir, "git"),
    '#!/bin/sh\nif [ "$1" = init ]; then echo "fatal: cannot mkdir .git: Read-only file system" >&2; exit 128; fi\necho "fatal: not a git repository" >&2\nexit 128\n',
    { mode: 0o755 },
  );
  return join(dir, "git");
}
// Every file and folder under `dir`, `.git` left out, with each file's bytes.
function treeOf(dir) {
  const out = {};
  const walk = (at) => {
    for (const n of readdirSync(join(dir, at)).sort()) {
      if (!at && n === ".git") continue;
      const rel = at ? join(at, n) : n;
      if (statSync(join(dir, rel)).isDirectory()) {
        out[`${rel}/`] = null;
        walk(rel);
      } else out[rel] = readFileSync(join(dir, rel), "utf8");
    }
  };
  walk("");
  return out;
}
// The scaffold lines a vault's default view lists, from its scaffold plan: one
// per folder with its README, then the vault's README.
const scaffoldLines = (sp) =>
  sp.rows
    .filter((r) => r.type === "folder")
    .map((r) => {
      const readme = sp.rows.find((x) => x.rel === `${r.rel}/README.md`);
      return `      create ${r.rel}/${readme ? ` and ${readme.rel}` : ""}`;
    })
    .concat(["      create README.md"]);
const textSink = () => {
  const chunks = [];
  return {
    out: {
      isTTY: false,
      write: (s) => {
        chunks.push(String(s));
        return true;
      },
    },
    text: () => chunks.join(""),
  };
};

test("setup engine 'The vault: create': the vault item is first, under no harness, in the Vault group before every harness's; its default view lists the mkdir, the binding, $ git init --quiet and every scaffold path; apply makes a vault whose tree outside .git is byte-identical to init's; an empty folder is created into with no mkdir", () => {
  const s = setupSandbox();
  const vp = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  assert.equal(vp.ok, true, JSON.stringify(vp.refusals));
  const p = plan(s.proj, { harnesses: [SRC.id], vault: vp, env: s.env, home: s.home, root: ROOT });
  const v = p.items[0];
  assert.deepEqual(
    [v.harness, v.kind, v.surface, v.action, v.state, v.path, v.reason],
    [null, "vault", "vault", "create", "absent", s.vault, null],
  );
  assert.deepEqual(
    v.steps.map((st) => st.kind),
    ["mkdir", "bind", "git-init", ...scaffoldLines(vp.scaffold).map(() => "scaffold")],
  );
  assert.equal(p.items.filter((i) => i.kind === "vault").length, 1);
  // Off the envelope: the binding plan rides along for apply, and the plan gains no key.
  assert.ok(!("bind" in publicItem(v)) && v.bind === vp);
  assert.deepEqual(Object.keys(p), [
    "projectDir",
    "mode",
    "named",
    "detected",
    "harnesses",
    "reports",
    "items",
    "refusals",
    "ok",
    "incomplete",
    "root",
    "plannedAgainst",
  ]);
  // PLAN: the Vault group first, its row by the path from home, and every path written beneath it.
  const lines = renderPreview(p, { home: s.home }).split("\n");
  const at = lines.indexOf("Vault");
  assert.ok(at > 0 && at < lines.indexOf(SRC.display_name), lines.join("\n"));
  assert.equal(lines[at - 1], "");
  assert.deepEqual(lines.slice(at + 1, at + 6), [
    "  + add  ~/src/acme-vault/  vault",
    "      create ~/src/acme-vault/",
    "      write .projectstore/projectstore.json  (vault_path, layout engineering, language en)",
    "      $ git init --quiet",
    "          in ~/src/acme-vault, with no commit",
  ]);
  assert.deepEqual(lines.slice(at + 6, at + 6 + scaffoldLines(vp.scaffold).length), scaffoldLines(vp.scaffold));
  assert.match(lines.join("\n"), /\nPlan — \d+ to add/);
  // APPLY: the vault's steps beneath its line; git through the caller's own
  // spawn, never the reporter's $ wrapper (no rev-parse line).
  const sink = textSink();
  const rep = applyReporter(sink.out, PLAIN, p, { home: s.home });
  const done = apply(p, {
    env: s.env,
    home: s.home,
    spawn: rep.spawn(spawnSync),
    onItem: rep.onItem,
    onStep: rep.onStep,
  });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(done.warnings, undefined);
  const text = sink.text();
  for (const l of [
    "  + adding ~/src/acme-vault/",
    "      ✓ created ~/src/acme-vault/",
    "      ✓ wrote .projectstore/projectstore.json",
    "      ✓ $ git init --quiet",
    "      ✓ created README.md",
    "  ✓ added ~/src/acme-vault/",
  ])
    assert.ok(text.includes(l), `${l}\n${text}`);
  assert.ok(!text.includes("rev-parse"), text);
  const rec = done[0];
  assert.deepEqual(
    [rec.surface, rec.bind.git, rec.bind.created_vault, rec.bind.wrote],
    ["vault", { done: true }, true, true],
  );
  assert.equal(rec.bind.scaffold.created.length, vp.scaffold.creates);
  assert.ok(
    rec.steps.every((st) => st.ok),
    JSON.stringify(rec.steps),
  );
  assert.ok(existsSync(join(s.vault, ".git", "HEAD")), "its own repository");
  assert.equal(JSON.parse(read(layoutPaths(s.proj).binding)).vault_path, s.vault);
  assert.ok(
    read(layoutPaths(s.proj).gitignore).split("\n").includes("projectstore.json"),
    "the binding stays machine-local",
  );
  // Byte-identical to init's, for the same name, layout and language.
  const other = setupSandbox();
  const ip = planBind(other.proj, { vault: other.vault, init: true, env: other.env, home: other.home, root: ROOT });
  assert.equal(applyBind(ip, { env: other.env }).git.done, true);
  assert.deepEqual(treeOf(s.vault), treeOf(other.vault));
  assert.ok(Object.keys(treeOf(s.vault)).length > 2);

  // An empty folder: created into, with no mkdir step.
  const e = setupSandbox();
  mkdirSync(e.vault);
  const ep = planBind(e.proj, { vault: e.vault, init: true, env: e.env, home: e.home, root: ROOT });
  const ev = plan(e.proj, { harnesses: [SRC.id], vault: ep, env: e.env, home: e.home, root: ROOT }).items[0];
  assert.deepEqual([ev.action, ev.state, ev.steps[0].kind], ["create", "empty", "bind"]);
  assert.ok(!ev.steps.some((st) => st.kind === "mkdir"));
});

test("setup engine 'The vault: a failing git init': the APPLY line is ▲ git init failed with git's first line, the run goes on — the scaffold and every later item apply — and the warning rides on apply's result and on runVerb's, never as a failure", async () => {
  const s = setupSandbox({ git: failingGit() });
  const vp = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  const sink = textSink();
  const r = await runVerb("setup", s.proj, {
    harnesses: [SRC.id],
    vault: vp,
    env: s.env,
    home: s.home,
    root: ROOT,
    out: sink.out,
    ask: async () => "y",
  });
  assert.equal(r.gate.confirmed, true, JSON.stringify(r.gate));
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const message = "fatal: cannot mkdir .git: Read-only file system";
  assert.equal(r.warnings.length, 1);
  assert.deepEqual([r.warnings[0].step, r.warnings[0].path, r.warnings[0].message], ["git-init", s.vault, message]);
  assert.match(
    r.warnings[0].remedy,
    /^Run git init in "[^"]+" from a terminal, or doctor's fix in a session, which offers it:\ngit -C \S+ init\n\S+doctor --fix$/,
  );
  const text = sink.text();
  assert.ok(text.includes(`      ▲ git init failed: ${message}`), text);
  assert.ok(!text.includes("✕"), "nothing failed");
  assert.equal(r.applied[0].bind.git.failed, message);
  assert.ok(existsSync(join(s.vault, "README.md")), "the scaffold still runs");
  assert.ok(!existsSync(join(s.vault, ".git")));
  assert.ok(r.applied.length > 1 && existsSync(join(s.proj, "CLAUDE.md")), "every later item applies");
  assert.ok(
    !Array.isArray(JSON.parse(JSON.stringify(r.applied)).warnings),
    "the envelope's applied list keeps its shape",
  );
});

test("setup engine 'The vault: the binding changed after the preview': a binding written between plan and apply fails the vault item with nothing written, and the run stops there — STOPPED names it; a vault folder filled meanwhile does the same", () => {
  const s = setupSandbox();
  const vp = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  const p = plan(s.proj, { harnesses: [SRC.id], vault: vp, env: s.env, home: s.home, root: ROOT });
  writeBinding(s.proj, { vault_path: "/tmp/elsewhere", layout: "engineering" });
  const done = apply(p, { env: s.env, home: s.home });
  assert.equal(done.length, 1, "the run stops at the vault");
  assert.equal(done.failed.step, "vault");
  assert.match(done.failed.stderr, /^the binding changed after the preview; nothing is written/);
  assert.ok(!existsSync(s.vault) && !existsSync(join(s.proj, "CLAUDE.md")), "nothing is written");
  assert.equal(JSON.parse(read(layoutPaths(s.proj).binding)).vault_path, "/tmp/elsewhere");
  const stopped = renderDone({ verb: "setup", plan: p, applied: done, failed: done.failed, elapsed: 0 });
  assert.match(stopped, /^Stopped — 0 changes applied, then vault failed$/m);
  assert.ok(stopped.includes("the binding changed after the preview"), stopped);

  const f = setupSandbox();
  const fp = plan(f.proj, {
    harnesses: [SRC.id],
    vault: planBind(f.proj, { vault: f.vault, init: true, env: f.env, home: f.home, root: ROOT }),
    env: f.env,
    home: f.home,
    root: ROOT,
  });
  mkdirSync(f.vault);
  writeFileSync(join(f.vault, "notes.md"), "mine\n");
  const fd = apply(fp, { env: f.env, home: f.home });
  assert.match(fd.failed.stderr, /changed after the preview: it is no longer missing or empty/);
  assert.deepEqual(readdirSync(f.vault), ["notes.md"]);
  assert.ok(!existsSync(layoutPaths(f.proj).binding));
});

test("setup engine 'The vault: bind existing + scaffold': an existing non-empty vault is bound only by default, not one byte written inside it; with scaffoldExisting it is bound and gets the layout's missing folders and indexes — no mkdir, no git init — and a folder already there plans only its README", () => {
  const s = setupSandbox();
  mkdirSync(join(s.vault, "adr"), { recursive: true });
  writeFileSync(join(s.vault, "notes.md"), "mine\n");
  // Bound only.
  const plain = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  assert.deepEqual([plain.ok, plain.buildsVault, plain.scaffoldsExisting], [true, false, false]);
  const pp = plan(s.proj, { harnesses: [SRC.id], vault: plain, env: s.env, home: s.home, root: ROOT });
  const pv = pp.items[0];
  assert.deepEqual(
    [pv.action, pv.state, pv.reason, pv.steps.map((st) => st.kind)],
    ["add", "present", "it already exists; it is bound as it is", ["bind"]],
  );
  // Bound and scaffolded.
  const sp = planBind(s.proj, { vault: s.vault, scaffoldExisting: true, env: s.env, home: s.home, root: ROOT });
  assert.deepEqual([sp.ok, sp.buildsVault, sp.createsVault, sp.scaffoldsExisting], [true, false, false, true]);
  const p = plan(s.proj, { harnesses: [SRC.id], vault: sp, env: s.env, home: s.home, root: ROOT });
  const v = p.items[0];
  assert.deepEqual(
    [v.action, v.reason],
    ["add", "it already exists; it is bound as it is, and the layout's missing folders and indexes are added"],
  );
  assert.deepEqual(
    v.steps.map((st) => st.kind),
    ["bind", ...scaffoldLines(sp.scaffold).map(() => "scaffold")],
  );
  assert.deepEqual(v.steps[1].rels, ["adr/README.md"], "adr/ is there: only its README is created");
  const text = renderPreview(p, { home: s.home });
  assert.ok(text.includes("\n      create adr/README.md\n"), text);
  assert.ok(!text.includes("$ git init"), text);
  const done = apply(p, { env: s.env, home: s.home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(read(join(s.vault, "notes.md")), "mine\n");
  assert.ok(!existsSync(join(s.vault, ".git")), "no git init inside someone's files");
  for (const r of sp.scaffold.rows) assert.ok(existsSync(r.abs), r.rel);
  assert.equal(done[0].bind.scaffold.created.length, sp.scaffold.creates);
  // A vault with nothing to add is bound only, whatever the flag says.
  const next = setupSandbox();
  const full = planBind(next.proj, {
    vault: s.vault,
    scaffoldExisting: true,
    env: next.env,
    home: next.home,
    root: ROOT,
  });
  assert.deepEqual([full.ok, full.state, full.scaffold.creates, full.scaffoldsExisting], [true, "unbound", 0, false]);
  assert.deepEqual(
    plan(next.proj, {
      harnesses: [SRC.id],
      vault: full,
      env: next.env,
      home: next.home,
      root: ROOT,
    }).items[0].steps.map((st) => st.kind),
    ["bind"],
  );
  // Without the flag, nothing is written inside the vault.
  const o = setupSandbox();
  mkdirSync(o.vault);
  writeFileSync(join(o.vault, "notes.md"), "mine\n");
  apply(
    plan(o.proj, {
      harnesses: [SRC.id],
      vault: planBind(o.proj, { vault: o.vault, init: true, env: o.env, home: o.home, root: ROOT }),
      env: o.env,
      home: o.home,
      root: ROOT,
    }),
    { env: o.env, home: o.home },
  );
  assert.deepEqual(readdirSync(o.vault), ["notes.md"]);
  assert.equal(JSON.parse(read(layoutPaths(o.proj).binding)).vault_path, o.vault);
});

test("setup engine 'The vault: inherit': planInherit copies the main checkout's binding but channel_switch and channel_keep, as one bind step naming the checkout and the two keys; the inherited status-line flag opts the status line in; apply writes it with its .gitignore and touches the shared vault not at all; refusals refuse the plan", () => {
  const s = setupSandbox();
  mkdirSync(s.vault, { recursive: true });
  writeFileSync(join(s.vault, "notes.md"), "shared\n");
  const parent = {
    vault_path: s.vault,
    layout: "engineering",
    language: "en",
    auto_inject: true,
    tags: ["x"],
    default_author: "Ada",
    active_skills: true,
    approval_mode: "always",
    statusline: { enabled: true },
    channel_switch: { by: "setup", at: "2026-10-01T00:00:00.000Z" },
    autoupdate_asked: true,
    channel_keep: { by: "setup", at: "2026-10-02T00:00:00.000Z" },
  };
  writeBinding(s.proj, parent);
  const wt = join(s.home, "src", "acme-wt");
  mkdirSync(join(wt, CFG_DIR), { recursive: true });
  const ip = planInherit(wt, { from: s.proj, env: s.env, home: s.home, root: ROOT });
  assert.equal(ip.ok, true, JSON.stringify(ip.refusals));
  assert.deepEqual(INHERIT_DROPS, ["channel_switch", "channel_keep"]);
  assert.deepEqual(ip.inherit, {
    from: s.proj,
    drop: ["channel_switch", "channel_keep"],
    dropped: ["channel_switch", "channel_keep"],
  });
  const { channel_switch: _switch, channel_keep: _keep, ...kept } = parent;
  assert.deepEqual(ip.after, kept);
  assert.deepEqual(Object.keys(ip.after), Object.keys(kept), "in the parent's order");
  const p = plan(wt, { harnesses: [SRC.id], vault: ip, env: s.env, home: s.home, root: ROOT });
  const v = p.items[0];
  assert.deepEqual(
    [v.kind, v.action, v.state, v.reason, v.steps.map((st) => st.kind)],
    ["vault", "add", "present", `the vault of ${s.proj}, with its settings`, ["bind"]],
  );
  const text = renderPreview(p, { home: s.home });
  assert.ok(
    text.includes(
      `\n      write .projectstore/projectstore.json  (the binding of ${s.proj}, without channel_switch and channel_keep)\n`,
    ),
    text,
  );
  assert.notEqual(item(p, "statusline").state, "opt-out", "the binding the run leaves opts the status line in");
  const done = apply(p, { env: s.env, home: s.home });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.equal(read(layoutPaths(wt).binding), JSON.stringify(kept, null, 2) + "\n");
  assert.ok(read(layoutPaths(wt).gitignore).split("\n").includes("projectstore.json"));
  assert.deepEqual(readdirSync(s.vault), ["notes.md"], "the shared vault is not touched");
  assert.equal(done[0].bind.state, "unbound");
  // A relative vault_path is the parent's: it travels resolved there.
  writeBinding(s.proj, { ...parent, vault_path: "../acme-vault" });
  const rel2 = join(s.home, "src", "acme-wt2");
  mkdirSync(rel2);
  assert.equal(planInherit(rel2, { from: s.proj, env: s.env, home: s.home, root: ROOT }).after.vault_path, s.vault);
  // Refusals: an unbound checkout, a vault gone, a project bound elsewhere; and plan() refuses with them.
  const nobody = join(s.home, "src", "nobody");
  mkdirSync(nobody);
  const none = planInherit(rel2, { from: nobody, env: s.env, home: s.home, root: ROOT });
  assert.deepEqual(
    none.refusals.map((r) => r.code),
    ["NOT_BOUND"],
  );
  writeBinding(nobody, { vault_path: join(s.home, "gone"), layout: "engineering" });
  assert.deepEqual(
    planInherit(rel2, { from: nobody, env: s.env, home: s.home, root: ROOT }).refusals.map((r) => r.code),
    ["MISSING"],
  );
  writeBinding(rel2, { vault_path: join(s.home, "other"), layout: "engineering" });
  assert.deepEqual(
    planInherit(rel2, { from: s.proj, env: s.env, home: s.home, root: ROOT }).refusals.map((r) => r.code),
    ["REBIND"],
  );
  const refused = plan(rel2, { harnesses: [SRC.id], vault: none, env: s.env, home: s.home, root: ROOT });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.items, [], "nothing is planned");
  assert.deepEqual(refused.refusals, [none.refusals[0].message]);
});

test("setup engine 'State directories': ensureState plans an empty state/<id>/ per harness whose registration is not unavailable, the first naming state/; apply makes them with state/.gitignore and no welcome marker, and detection then reads both; none for a missing host CLI, none where the launcher makes it, none on a re-run; install plans none, setup does", async () => {
  const h = hostSandbox();
  const fc = fakeClaude(mkdtempSync(join(tmpdir(), "ps-setup-claude-")));
  const env = { ...h.env, PATH: [dirname(fc.bin), dirname(process.execPath), h.env.PATH].join(":") };
  const proj = mkdtempSync(join(tmpdir(), "ps-setup-state-"));
  mkdirSync(join(proj, CFG_DIR), { recursive: true });
  const lp = layoutPaths(proj);
  const ids = [SRC.id, CODEX.id];
  const run = (extra = {}) =>
    plan(proj, { harnesses: ids, env, home: h.home, root: ROOT, version: "0.30.0", ensureState: true, ...extra });
  const p = run();
  const states = p.items.filter((i) => i.kind === "state");
  assert.deepEqual(
    states.map((i) => [i.harness, i.surface, i.action, i.path]),
    ids.map((id) => [id, "harness_state", "create", lp.harnessState(id)]),
  );
  assert.deepEqual(states[0].steps, [{ kind: "ensure", path: lp.state, why: states[0].steps[0].why }]);
  assert.equal(states[1].steps, undefined);
  // Each is its harness's own row, after the harness's other rows.
  for (const st of states)
    assert.equal(p.items.filter((i) => i.harness === st.harness && i.kind !== "binding").at(-1), st);
  const text = renderPreview(p, { home: h.home });
  for (const id of ids) assert.match(text, new RegExp(`\\n  \\+ add +\\.projectstore/state/${id}/ +harness state\\n`));
  assert.ok(text.includes("\n      ensure .projectstore/state/\n"), text);
  assert.ok(!existsSync(lp.state), "nothing is written by plan");
  // Applied: empty directories, the state .gitignore with its header, no marker.
  const done = apply({ ...p, items: states }, { env, home: h.home });
  assert.equal(done.failed, undefined);
  for (const id of ids) assert.deepEqual(readdirSync(lp.harnessState(id)), [], id);
  assert.deepEqual(read(lp.stateGitignore).split("\n").filter(Boolean).slice(-1), ["*"]);
  assert.ok(read(lp.stateGitignore).includes(RUNTIME_GITIGNORE_HEADER));
  assert.equal(existsSync(lp.sessions), false, "no session state");
  assert.deepEqual(
    detectHarnesses(proj, { state: true }).map((d) => [d.id, d.why]),
    [
      [SRC.id, "directory"],
      [CODEX.id, "state"],
    ],
  );
  assert.deepEqual(
    run().items.filter((i) => i.kind === "state"),
    [],
    "a re-run plans none",
  );
  // A host CLI that is missing: its registration is unavailable, and it gets no directory.
  const bare = mkdtempSync(join(tmpdir(), "ps-setup-state-"));
  mkdirSync(join(bare, CFG_DIR), { recursive: true });
  const noCodex = plan(bare, {
    harnesses: ids,
    env: { ...env, PATH: [dirname(fc.bin), dirname(process.execPath)].join(":") },
    home: h.home,
    root: ROOT,
    version: "0.30.0",
    ensureState: true,
  });
  assert.equal(noCodex.items.find((i) => i.harness === CODEX.id && i.kind === "registration").state, "unavailable");
  assert.deepEqual(
    noCodex.items.filter((i) => i.kind === "state").map((i) => i.harness),
    [SRC.id],
  );
  // install plans none; setup does, without being asked to.
  assert.deepEqual(
    plan(bare, { harnesses: ids, env, home: h.home, root: ROOT, version: "0.30.0" }).items.filter(
      (i) => i.kind === "state",
    ),
    [],
  );
  const viaInstall = await runVerb("install", bare, { harnesses: ids, env, home: h.home, root: ROOT, dryRun: true });
  assert.deepEqual(
    viaInstall.plan.items.filter((i) => i.kind === "state"),
    [],
  );
  const viaSetup = await runVerb("setup", bare, { harnesses: ids, env, home: h.home, root: ROOT, dryRun: true });
  assert.deepEqual(
    viaSetup.plan.items.filter((i) => i.kind === "state").map((i) => i.harness),
    ids,
  );
  // The status-line launcher makes Claude Code's directory: no item for it.
  const { home, root } = fixture();
  const lit = project();
  const hostEnv = { ...noHostEnv(), PATH: [dirname(fc.bin), dirname(process.execPath)].join(":") };
  const withLauncher = plan(lit, { harnesses: [SRC.id], env: hostEnv, home, root, ensureState: true });
  assert.equal(item(withLauncher, "statusline_launcher").action, "create");
  assert.equal(dirname(item(withLauncher, "statusline_launcher").path), layoutPaths(lit).harnessState(SRC.id));
  assert.deepEqual(
    withLauncher.items.filter((i) => i.kind === "state"),
    [],
  );
  // …where the same fixture with the status line off gets it: only the launcher decided.
  const unlit = project({ statusline: false });
  assert.deepEqual(
    plan(unlit, { harnesses: [SRC.id], env: hostEnv, home, root, ensureState: true })
      .items.filter((i) => i.kind === "state")
      .map((i) => i.path),
    [layoutPaths(unlit).harnessState(SRC.id)],
  );
});

test("setup engine 'The status-line flag': true plans a binding item, last in Claude Code's group, storing statusline.enabled and opting the status line in — its entry and launcher in the same plan; apply merges it keeping every other key, a statusline object's included; false stores false and wires nothing; no item when the binding already says it or there is none", () => {
  const { home, root } = fixture();
  const env = noHostEnv();
  const proj = project({ bound: false });
  const bp = layoutPaths(proj).binding;
  writeBinding(proj, {
    vault_path: "/tmp/nowhere",
    layout: "engineering",
    statusline: { refresh: 5 },
    tags: ["a"],
    approval_mode: "always",
  });
  const before = JSON.parse(read(bp));
  const p = plan(proj, { harnesses: [SRC.id], home, root, env, statusline: true });
  const flag = p.items.find((i) => i.surface === "statusline_flag");
  assert.deepEqual(
    [flag.harness, flag.kind, flag.action, flag.state, flag.entry, flag.path],
    [SRC.id, "binding", "add", "absent", "statusline.enabled", bp],
  );
  assert.deepEqual(
    publicItem(flag).steps.map(({ why: _why, ...st }) => st),
    [{ kind: "set", path: bp, key: "statusline.enabled", value: true }],
  );
  assert.ok(!("set" in publicItem(flag)) && !("unset" in publicItem(flag)), "apply's data stays off the envelope");
  assert.equal(p.items.filter((i) => i.harness === SRC.id).at(-1), flag, "last in its group");
  assert.notEqual(item(p, "statusline").state, "opt-out");
  assert.equal(item(p, "statusline_launcher").action, "create");
  assert.ok(renderPreview(p).includes("\n      edit .projectstore/projectstore.json  [statusline.enabled] → true\n"));
  const sink = textSink();
  const rep = applyReporter(sink.out, PLAIN, p, { home });
  const done = apply(p, { env, home, onItem: rep.onItem, onStep: rep.onStep });
  assert.equal(done.failed, undefined, JSON.stringify(done));
  assert.ok(sink.text().includes("      ✓ edited .projectstore/projectstore.json [statusline.enabled]"), sink.text());
  const after = JSON.parse(read(bp));
  assert.deepEqual(Object.keys(after), Object.keys(before), "every key, in its place");
  assert.deepEqual(after.statusline, { refresh: 5, enabled: true });
  for (const k of ["vault_path", "layout", "tags", "approval_mode"]) assert.deepEqual(after[k], before[k], k);
  assert.ok(JSON.parse(read(join(proj, CFG_DIR, "settings.local.json"))).statusLine, "our entry is wired");
  assert.deepEqual(done.find((d) => d.surface === "statusline_flag").steps, [{ kind: "set", path: bp, ok: true }]);
  assert.equal(
    plan(proj, { harnesses: [SRC.id], home, root, env, statusline: true }).items.find(
      (i) => i.surface === "statusline_flag",
    ),
    undefined,
    "the binding says it now",
  );

  // No: false stored, nothing wired.
  const no = project({ bound: true, statusline: false });
  const q = plan(no, { harnesses: [SRC.id], home, root, env, statusline: false });
  assert.equal(q.items.find((i) => i.surface === "statusline_flag").steps[0].value, false);
  assert.equal(item(q, "statusline").state, "opt-out");
  apply(q, { env, home });
  assert.equal(JSON.parse(read(layoutPaths(no).binding)).statusline.enabled, false);

  // At apply: a binding that says it meanwhile is a skip; one that went is skipped with the item's words.
  const twice = project({ bound: true, statusline: false });
  const t1 = plan(twice, { harnesses: [SRC.id], home, root, env, statusline: true });
  writeBinding(twice, { ...JSON.parse(read(layoutPaths(twice).binding)), statusline: { enabled: true } });
  assert.deepEqual(
    ((r) => [r.action, r.reason])(apply(t1, { env, home }).find((d) => d.surface === "statusline_flag")),
    ["skip", "the status line's flag is already recorded"],
  );
  const gone = project({ bound: true, statusline: false });
  const g1 = plan(gone, { harnesses: [SRC.id], home, root, env, statusline: true });
  rmSync(layoutPaths(gone).binding);
  assert.deepEqual(
    ((r) => [r.action, r.reason])(apply(g1, { env, home }).find((d) => d.surface === "statusline_flag")),
    ["skipped", "the project is not bound; the status line's flag is recorded once it is"],
  );
  assert.ok(!existsSync(layoutPaths(gone).binding), "no binding is created");

  // No binding and no vault item: nothing to record it in. A vault item: recorded in the binding it writes.
  const unbound = project({ bound: false });
  assert.equal(
    plan(unbound, { harnesses: [SRC.id], home, root, env, statusline: true }).items.find(
      (i) => i.surface === "statusline_flag",
    ),
    undefined,
  );
  const s = setupSandbox();
  const vp = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  const vflag = plan(s.proj, {
    harnesses: [SRC.id],
    vault: vp,
    env: s.env,
    home: s.home,
    root: ROOT,
    statusline: true,
  });
  assert.equal(vflag.items[0].kind, "vault");
  assert.equal(vflag.items.at(-1).surface, "statusline_flag", "applied after the vault item wrote the binding");
  assert.equal(vflag.items.at(-1).state, "absent", "the vault item's binding counts as there");
  assert.equal(apply(vflag, { env: s.env, home: s.home }).failed, undefined);
  assert.deepEqual(JSON.parse(read(layoutPaths(s.proj).binding)).statusline, { enabled: true });
});

test("setup engine 'named': named: false keeps a plan of given harnesses unconfirmed without a terminal — the gate refuses non-tty and runVerb('setup') fetches no shell; named, setup fetches the shell-rooted harness as install does; a dry run's gate text", async () => {
  const proj = project({ bound: false });
  const home = mkdtempSync(join(tmpdir(), "ps-setup-named-home-"));
  const p = plan(proj, { harnesses: [SRC.id], named: false, env: noHostEnv(), home, root: ROOT });
  assert.equal(p.named, false);
  assert.deepEqual(await confirm(p, { env: noHostEnv() }), { confirmed: false, why: "non-tty" });
  assert.deepEqual(
    await confirm(plan(proj, { harnesses: [SRC.id], env: noHostEnv(), home, root: ROOT }), { env: noHostEnv() }),
    { confirmed: true, why: "named" },
  );
  // A Codex harness given but not named fetches nothing; named, it is fetched.
  const h = hostSandbox();
  const cx = mkdtempSync(join(tmpdir(), "ps-setup-named-"));
  const quiet = fakeNpmSpawn();
  const r = await runVerb("setup", cx, {
    harnesses: [CODEX.id],
    named: false,
    json: true,
    env: h.env,
    home: h.home,
    root: ROOT,
    fetchSpawn: quiet.spawn,
    spawn: codexHost(h.home),
  });
  assert.deepEqual(r.gate, { confirmed: false, why: "non-tty" });
  assert.deepEqual(quiet.calls, [], "nothing fetched for a run that will refuse");
  assert.equal(
    gateText({ gate: { why: "dry-run" }, plan: r.plan }, { verb: "setup" }),
    "Nothing written: this was a dry run.\n",
  );
  const npm = fakeNpmSpawn();
  const n = await runVerb("setup", cx, {
    harnesses: [CODEX.id],
    json: true,
    env: h.env,
    home: h.home,
    root: ROOT,
    fetchSpawn: npm.spawn,
    spawn: codexHost(h.home),
  });
  assert.equal(n.gate.why, "named");
  assert.equal(npm.installs().length, 1, "setup fetches the shell-rooted harness it is named for");
  assert.deepEqual(
    n.fetched.map((f) => f.harness),
    [CODEX.id],
  );
});

test("setup engine: gitTop answers the realpath'd top of the work tree from a subfolder, null outside one or without git, and is not misled by an inherited GIT_DIR", () => {
  const env = noHostEnv({ PATH: dirname(REAL_GIT), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const top = mkdtempSync(join(tmpdir(), "ps-setup-top-"));
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: top, env, encoding: "utf8" }).status, 0);
  const sub = join(top, "packages", "app");
  mkdirSync(sub, { recursive: true });
  assert.equal(gitTop(sub, { env }), realpathSync(top));
  assert.equal(gitTop(top, { env }), realpathSync(top));
  const outside = mkdtempSync(join(tmpdir(), "ps-setup-outside-"));
  assert.equal(gitTop(outside, { env }), null);
  assert.equal(gitTop(sub, { env: { ...env, PATH: "" } }), null, "git not on PATH");
  const decoy = mkdtempSync(join(tmpdir(), "ps-setup-decoy-"));
  spawnSync("git", ["init", "--quiet"], { cwd: decoy, env, encoding: "utf8" });
  assert.equal(gitTop(sub, { env: { ...env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy } }), realpathSync(top));
});

test(
  "setup engine 'The vault: a failed scaffold; git not on PATH': git missing is the git init step skipped in its own words — never ▲, never ✕ — and the vault is made without .git; a scaffold that cannot write fails the vault item, the run stops there, and STOPPED names `npx projectstore scaffold --write`, alone on its line, beside the binding already written",
  { skip: process.getuid?.() === 0 ? "root writes into a read-only folder" : false },
  async () => {
    // Git not on PATH: skipped, said so on the step's own line.
    const s = setupSandbox({ git: null });
    const vp = planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
    const p = plan(s.proj, { harnesses: [SRC.id], vault: vp, env: s.env, home: s.home, root: ROOT });
    const sink = textSink();
    const rep = applyReporter(sink.out, PLAIN, p, { home: s.home });
    const done = apply(p, { env: s.env, home: s.home, onItem: rep.onItem, onStep: rep.onStep });
    assert.equal(done.failed, undefined, JSON.stringify(done.failed));
    assert.equal(done.warnings, undefined, "a skip is not a warning");
    const text = sink.text();
    assert.match(text, /\n {6}· skipped git init: git is not on PATH(?: +\S+)?\n/);
    assert.ok(!text.includes("▲") && !text.includes("✕") && !text.includes("$ git init"), text);
    assert.deepEqual(done[0].bind.git, { skipped: "git is not on PATH" });
    assert.deepEqual(
      done[0].steps.find((st) => st.kind === "git-init"),
      { kind: "git-init", path: s.vault, ok: true, kept: true },
    );
    assert.ok(
      existsSync(join(s.vault, "README.md")) && !existsSync(join(s.vault, ".git")),
      "made, scaffolded, no repository",
    );

    // A vault folder that cannot be written: the scaffold fails and the run stops.
    const f = setupSandbox();
    mkdirSync(f.vault);
    chmodSync(f.vault, 0o555);
    try {
      const fp = planBind(f.proj, { vault: f.vault, init: true, env: f.env, home: f.home, root: ROOT });
      assert.deepEqual([fp.ok, fp.buildsVault, fp.createsVault], [true, true, false], JSON.stringify(fp.refusals));
      const fsink = textSink();
      const r = await runVerb("setup", f.proj, {
        harnesses: [SRC.id],
        vault: fp,
        env: f.env,
        home: f.home,
        root: ROOT,
        out: fsink.out,
        ask: async () => "y",
      });
      assert.equal(r.gate.confirmed, true, JSON.stringify(r.gate));
      assert.equal(r.failed.step, "scaffold");
      // What finishes the vault: its lead naming the project, then each form
      // alone on its line (the story "User-facing text says where to run…").
      const finish = [
        `The binding is written. Finish the vault in a session, or from a terminal in ${JSON.stringify(f.proj)}:`,
        commandForm("scaffold", { env: f.env }),
        "npx projectstore scaffold --write",
      ];
      assert.ok(r.failed.stderr.endsWith(`\n${finish.join("\n")}`), r.failed.stderr);
      assert.equal(r.applied.length, 1, "the run stops at the vault");
      assert.equal(r.applied[0].bind.wrote, true);
      assert.equal(JSON.parse(read(layoutPaths(f.proj).binding)).vault_path, f.vault, "the binding is written");
      assert.ok(!existsSync(join(f.proj, "CLAUDE.md")), "no later item applies");
      assert.deepEqual(readdirSync(f.vault), [], "nothing inside the vault");
      assert.match(
        fsink.text(),
        /\n {6}✓ wrote \.projectstore\/projectstore\.json[^\n]*\n {6}▲ git init failed: [^\n]+\n {6}✕ creating [^\n]+\n/,
      );
      const stopped = renderDone(r);
      assert.match(stopped, /^Stopped — 0 changes applied, then scaffold failed$/m);
      assert.ok(stopped.includes(`\n${finish.map((l) => `      ${l}`).join("\n")}\n`), stopped);
    } finally {
      chmodSync(f.vault, 0o755);
    }
  },
);

test("setup engine 'The vault: the guards': plan() reads a vault plan made for another spelling of the project — a symlink, or /var for /private/var — as the same project, and still refuses one for another; planInherit refuses a vault that is not a directory, as planBind does; a dry run of a refused plan ends on the refusal, never on 'this was a dry run'", async () => {
  // Two spellings of one project.
  const s = setupSandbox();
  const link = join(s.home, "acme-link");
  symlinkSync(s.proj, link);
  const viaLink = planBind(link, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT });
  assert.equal(viaLink.ok, true, JSON.stringify(viaLink.refusals));
  const p = plan(s.proj, { harnesses: [SRC.id], vault: viaLink, env: s.env, home: s.home, root: ROOT });
  assert.equal(p.ok, true, JSON.stringify(p.refusals));
  assert.equal(p.items[0].kind, "vault");
  const back = plan(link, {
    harnesses: [SRC.id],
    vault: planBind(s.proj, { vault: s.vault, init: true, env: s.env, home: s.home, root: ROOT }),
    env: s.env,
    home: s.home,
    root: ROOT,
  });
  assert.equal(back.ok, true, JSON.stringify(back.refusals));
  const raw = mkdtempSync(join(tmpdir(), "ps-setup-spelling-"));
  if (raw !== realpathSync(raw)) {
    const spelt = plan(raw, {
      harnesses: [SRC.id],
      vault: planBind(realpathSync(raw), { vault: join(raw, "v"), init: true, env: s.env, home: s.home, root: ROOT }),
      env: s.env,
      home: s.home,
      root: ROOT,
    });
    assert.equal(spelt.ok, true, JSON.stringify(spelt.refusals));
  }
  const other = setupSandbox();
  const elsewhere = plan(other.proj, {
    harnesses: [SRC.id],
    vault: viaLink,
    env: other.env,
    home: other.home,
    root: ROOT,
  });
  assert.equal(elsewhere.ok, false);
  assert.deepEqual(elsewhere.refusals, [`the vault plan is for ${link}, not ${other.proj}`]);

  // An inherited vault that is a file.
  const parent = setupSandbox();
  mkdirSync(dirname(parent.vault), { recursive: true });
  writeFileSync(parent.vault, "not a vault\n");
  writeBinding(parent.proj, { vault_path: parent.vault, layout: "engineering", language: "en" });
  const wt = join(parent.home, "src", "acme-wt");
  mkdirSync(wt);
  const ip = planInherit(wt, { from: parent.proj, env: parent.env, home: parent.home, root: ROOT });
  assert.equal(ip.ok, false);
  assert.deepEqual(
    ip.refusals.map((r) => [r.code, r.message]),
    [["USAGE", `${parent.vault}, the vault ${parent.proj} is bound to, is not a directory`]],
  );
  assert.equal(ip.scaffold, null);
  assert.deepEqual(
    planBind(wt, { vault: parent.vault, env: parent.env, home: parent.home, root: ROOT }).refusals.map((r) => r.code),
    ["USAGE"],
    "planBind's own refusal of it",
  );

  // A dry run of that refused plan: the refusal stands.
  const sink = textSink();
  const r = await runVerb("setup", wt, {
    harnesses: [SRC.id],
    vault: ip,
    env: parent.env,
    home: parent.home,
    root: ROOT,
    out: sink.out,
    dryRun: true,
    ask: async () => {
      throw new Error("a dry run asks nothing");
    },
  });
  assert.equal(r.plan.ok, false);
  assert.deepEqual(r.gate, { confirmed: false, why: "refused" });
  assert.equal(gateText(r, { verb: "setup" }), "");
  assert.ok(sink.text().includes("is not a directory"), sink.text());
  assert.ok(!sink.text().includes("dry run"), sink.text());
  assert.ok(!existsSync(layoutPaths(wt).binding), "nothing written");
});

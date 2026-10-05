// projectstore — tests for contract 18 of the generation spec: what the core
// prints names a command the way the harness it is printed for invokes it.
//
// Layers 1 and 2 of the lint are static (tests/portability.test.mjs). This file
// is layer 3 — the hooks, doctor and the CLI run under every harness's identity
// and must carry no other harness's form — plus the resolver that decides which
// harness is listening, and the checks gated by manifest data.
//
// It names no harness id: every harness here comes from the manifests, so a
// third one is covered the day its JSON lands.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadHarnesses, sourceHarness, invocation, speakingHarnessId, bundlingShellHarnessId, identifiedHarnessId, resetDetection, uiWordPatterns } from "../scripts/harness.mjs";
import { sessionNameOfferText, inheritForm, sharedRoleForm } from "../scripts/lib.mjs";
import { checkStatusline, checkAutoUpdate, checkMcpRegistration, checkPluginRegistration, checkOverrideCopies, checkHarnessSurfaces, checkVersionDrift, layoutRemedy } from "../scripts/doctor.mjs";
import { foreignPatterns, foreignHits, helperCalls, runtimeFiles, hermeticEnv, withoutAboutFindings, aboutMessages, scanLiterals } from "./fixtures/vocabulary.mjs";
import { fakeInstall, writeRegistry, fakeClaude, fakePackageRoot, legacyProject } from "./fixtures/install.mjs";
import { plan as installPlan, apply as installApply } from "../scripts/install-harness.mjs";
import { seedCliVault, writeBinding } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Every temporary tree this file makes, removed when it ends (two packed-core
// copies per run among them).
const TEMP = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); TEMP.push(d); return d; };
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }); });
const MANIFESTS = [...loadHarnesses().values()];
const SRC = sourceHarness();

// The developer's own harness must not answer for the fixture: every variable
// a manifest declares is dropped (a test run inside a live session carries its
// session marker).
const cleanEnv = (extra = {}) => hermeticEnv(extra);

// A bound project in a harness's shape, its shared binding asking for the
// status line, and an agents block one version stale — an issue on every
// harness, so the SessionStart doctor line always appears.
const STALE_BLOCK = "# Agents\n\n<!-- projectstore:agents v1 -->\nold\n<!-- /projectstore:agents -->\n";
function fixture(m) {
  const { proj, vault } = seedCliVault();
  TEMP.push(proj); // the vault is inside it
  mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", statusline: { enabled: true } });
  writeFileSync(join(proj, "AGENTS.md"), STALE_BLOCK);
  // A copy of a bundled role in the source harness's agents directory: a fact
  // for a harness that loads agents from there, and for no other.
  mkdirSync(join(proj, SRC.runtime.harness_dir, "agents"), { recursive: true });
  writeFileSync(join(proj, SRC.runtime.harness_dir, "agents", "critic.md"), "---\nname: critic\n---\n# source: projectstore v0.1.0\n");
  const home = tmp("ps-vocab-home-");
  const sessions = tmp("ps-vocab-sessions-");
  const bare = tmp("ps-vocab-bare-");
  mkdirSync(join(bare, m.runtime.harness_dir), { recursive: true });
  return { proj, vault, home, sessions, bare };
}

// How the harness itself identifies a hook process: its plugin-root variable,
// the variables it shares with another harness, its project variable if it has
// one. Built from the manifest — the "measured" path, not PROJECTSTORE_HARNESS.
function hostEnv(m, proj) {
  const env = { [m.runtime.plugin_root_env]: ROOT };
  for (const k of m.runtime.shared_env || []) env[k] = ROOT;
  if (m.runtime.project_dir_env) env[m.runtime.project_dir_env] = proj;
  return env;
}

function runNode(file, args, { cwd, env, input = null }) {
  const r = spawnSync(process.execPath, [join(ROOT, file), ...args], { cwd, env, input: input === null ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// The source harness registered from its npm package in the fixture's
// project, with its git-marketplace copy silenced for the checkout — the
// maintainer's own shape. Doctor then reports registrations ABOUT the source
// harness, whatever harness listens. The agents block is put back one version
// stale, so the remedy the layer reads is still printed. Returns false where
// the source harness has no registration surface.
function registerSource(f) {
  if (SRC.surfaces?.plugin?.kind !== "registration") return false;
  const saved = process.env[SRC.runtime.home_env];
  delete process.env[SRC.runtime.home_env];
  try {
    const other = fakeInstall(f.home, "0.27.1");
    writeRegistry(f.home, [{ scope: "user", installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }]);
    const root = fakePackageRoot(join(tmp("ps-vocab-npx-"), "node_modules", "projectstore"), "0.28.0");
    const host = fakeClaude(tmp("ps-vocab-bin-"));
    const done = installApply(installPlan(f.proj, { harnesses: [SRC.id], home: f.home, root, env: host.env() }), { env: host.env(), home: f.home });
    assert.equal(done.failed, undefined, JSON.stringify(done));
  } finally {
    if (saved !== undefined) process.env[SRC.runtime.home_env] = saved;
  }
  writeFileSync(join(f.proj, "AGENTS.md"), STALE_BLOCK);
  return true;
}

// A copy of the packed core inside a fake shell tree named after a manifest's
// install.shell — how the Codex plugin cache and an npx run lay it out.
function packedShell(m) {
  const tree = tmp("ps-vocab-packed-");
  const core = join(tree, "node_modules", "projectstore");
  for (const rel of JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "packlist.json"), "utf8"))) {
    mkdirSync(dirname(join(core, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(core, rel));
  }
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: m.install.shell }) + "\n");
  return core;
}

// ─── The resolver ───────────────────────────────────────────────────────

test("contract 18: the speaking harness — forced, self-identified, the bundling shell, the named shell, else the source", () => {
  assert.equal(speakingHarnessId(cleanEnv()), SRC.id, "nothing set: the source harness");
  for (const m of MANIFESTS) {
    assert.equal(speakingHarnessId(cleanEnv({ PROJECTSTORE_HARNESS: m.id })), m.id, `forced: ${m.id}`);
    assert.equal(speakingHarnessId(cleanEnv(hostEnv(m, "/p"))), m.id, `${m.id} identifies itself by its own variables`);
    if (m.install?.shell) {
      assert.equal(speakingHarnessId(cleanEnv({ PROJECTSTORE_SHELL: m.install.shell })), m.id, `the shell ${m.install.shell} names ${m.id}`);
      // A parent that decided "no harness identified itself" still leaves the shell step.
      assert.equal(speakingHarnessId(cleanEnv({ PROJECTSTORE_IDENTIFIED: "", PROJECTSTORE_SHELL: m.install.shell })), m.id);
    }
  }
  assert.equal(speakingHarnessId(cleanEnv({ PROJECTSTORE_HARNESS: "no-such-harness" })), SRC.id, "an unknown forced id is ignored");
  // --harness is an install target, never the listener: no environment carries it.
  assert.equal(identifiedHarnessId(cleanEnv()), null);
});

test("contract 18: a core inside <shell>/node_modules/projectstore belongs to that shell's harness, with no environment at all", () => {
  for (const m of MANIFESTS.filter((x) => x.install?.shell)) {
    const tree = tmp("ps-vocab-shell-");
    const core = join(tree, "node_modules", "projectstore");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: m.install.shell }) + "\n");
    assert.equal(bundlingShellHarnessId({ core }), m.id, m.install.shell);
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "someone-elses-package" }) + "\n");
    assert.equal(bundlingShellHarnessId({ core }), null, "another package's tree is no shell of ours");
  }
  assert.equal(bundlingShellHarnessId({ core: ROOT }), null, "a source checkout is no shell");

  // End to end: a copy of the packed core inside a shell's tree prints the
  // shell's forms with no identity variable set — how a rendered skill's
  // command, a hook and an npx run all reach it.
  const shell = MANIFESTS.find((x) => x.install?.shell && x.id !== SRC.id);
  if (!shell) return;
  const core = packedShell(shell);
  const bare = tmp("ps-vocab-bare-");
  const r = spawnSync(process.execPath, [join(core, "bin", "projectstore.mjs"), "status", "--project", bare], { cwd: bare, env: cleanEnv(), encoding: "utf8", timeout: 60000 });
  assert.ok((r.stdout + r.stderr).includes(invocation(shell, "bind", { args: "<vault>" })), r.stdout + r.stderr);
  assert.deepEqual(foreignHits(r.stdout + r.stderr, foreignPatterns(ROOT, shell.id)), []);
});

// ─── The forms ──────────────────────────────────────────────────────────

test("contract 18: the source harness's forms are the bytes it always printed", () => {
  const calls = helperCalls(ROOT, runtimeFiles(ROOT)).filter((c) => c.name && c.name !== "*");
  assert.ok(calls.length >= 40);
  for (const c of calls) {
    const own = SRC.surfaces[c.kind].invocation;
    assert.equal(invocation(SRC, c.name, { kind: c.kind }), own.split("<name>").join(c.name), `${c.file}:${c.line}`);
  }
  assert.equal(invocation(SRC, "*"), SRC.surfaces.commands.invocation.split("<name>").join("*"));
  assert.equal(invocation(SRC, "bind", { args: "<vault>" }), `${SRC.surfaces.commands.invocation.split("<name>").join("bind")} <vault>`);
});

test("contract 18: a harness that renders commands and roles as skills names them through its skill form", () => {
  for (const m of MANIFESTS) {
    for (const kind of ["commands", "agents"]) {
      const s = m.surfaces?.[kind];
      if (!s || s.invocation || s.rendered_as !== "skill") continue;
      const skill = s.rendered_name.split("<name>").join("doctor");
      assert.equal(invocation(m, "doctor", { kind }), m.surfaces.skills.invocation.split("<name>").join(skill), `${m.id} ${kind}`);
    }
  }
});

// ─── Checks gated by data ───────────────────────────────────────────────

test("contract 18: a harness without a status line, a host marketplace or MCP hears nothing about them", () => {
  const cfg = { vault_path: "/tmp/nowhere", statusline: { enabled: true } };
  for (const m of MANIFESTS) {
    const proj = tmp("ps-vocab-gate-");
    const home = tmp("ps-vocab-gate-home-");
    const status = checkStatusline(cfg, proj, home, m);
    if (m.surfaces?.statusline?.supported === false) assert.deepEqual(status, [], `${m.id}: no status line, no finding`);
    if (m.surfaces?.plugin?.format !== "host-plugin-registration") assert.deepEqual(checkAutoUpdate(home, m), [], `${m.id}: no host marketplace, no auto-update finding`);
    if (m.surfaces?.mcp?.supported === false) assert.deepEqual(checkMcpRegistration(ROOT, m), [], `${m.id}: no MCP surface, no MCP finding`);
    const offer = sessionNameOfferText({ name: "ps-a" }, { env: cleanEnv({ PROJECTSTORE_HARNESS: m.id }) });
    if (m.capabilities?.session_rename) assert.equal(offer, `projectstore: this session looks like "ps-a" — ${m.capabilities.session_rename.split("<name>").join("ps-a")}`);
    else assert.equal(offer, null, `${m.id}: no rename command, no offer`);
    // An unbound worktree is told `bind --inherit` only where bind can inherit.
    const inherit = inheritForm("/v/x", { env: cleanEnv({ PROJECTSTORE_HARNESS: m.id }) });
    assert.equal(inherit, invocation(m, "bind", { args: m.capabilities?.bind_inherit ? "--inherit" : '"/v/x"' }), m.id);
  }
  // And the source harness, which has them, still hears about its status line.
  const proj = tmp("ps-vocab-gate-src-");
  if (SRC.surfaces?.statusline?.supported !== false) assert.ok(checkStatusline(cfg, proj, tmp("ps-h-"), SRC).some((f) => f.check === "statusline"));
});

// ─── Layer 3: every harness's run is clean ──────────────────────────────

test("contract 18, layer 3: SessionStart, the rules, pre-compact, doctor and the not-bound message carry no other harness's form", () => {
  for (const m of MANIFESTS) {
    for (const how of ["forced", "host"]) {
      const f = fixture(m);
      const env = cleanEnv({ HOME: f.home, PROJECTSTORE_SESSIONS_DIR: f.sessions, ...(how === "forced" ? { PROJECTSTORE_HARNESS: m.id, ...(m.runtime.project_dir_env ? { [m.runtime.project_dir_env]: f.proj } : {}) } : hostEnv(m, f.proj)) });
      const hook = (file, payload) => runNode(file, [], { cwd: f.proj, env, input: { session_id: `v-${how}`, cwd: f.proj, ...payload } });
      const runs = {
        "session-start": hook("hooks/session-start.mjs", { hook_event_name: "SessionStart", source: "startup" }),
        "session-rules": hook("hooks/session-rules.mjs", { hook_event_name: "SessionStart" }),
        "pre-compact": hook("hooks/pre-compact.mjs", { hook_event_name: "PreCompact", trigger: "manual" }),
        "doctor": runNode("bin/projectstore.mjs", ["doctor", "--json", "--project", f.proj], { cwd: f.proj, env }),
        "doctor text": runNode("bin/projectstore.mjs", ["doctor", "--project", f.proj], { cwd: f.proj, env }),
        "not-bound": runNode("bin/projectstore.mjs", ["status", "--project", f.bare], { cwd: f.bare, env }),
      };
      const pats = foreignPatterns(ROOT, m.id);
      const about = aboutMessages(runs["doctor"].out, m.id);
      for (const [label, r] of Object.entries(runs)) {
        assert.deepEqual(foreignHits(withoutAboutFindings(r.out, m.id, about), pats).map((h) => `${h.text} (${h.what})`), [], `${m.id} ${how} ${label}:\n${r.out}`);
      }
      // The agent copy in the source harness's directory: reported where that
      // harness listens, and nowhere a harness has no agents surface.
      const checks = new Set(JSON.parse(runs["doctor"].out).result.map((x) => x.check));
      if (m.surfaces?.agents?.supported === false) assert.ok(!checks.has("override-copies"), `${m.id} ${how}: no agent-copy finding`);
      if (m.id === SRC.id) assert.ok(checks.has("override-copies"), `${m.id} ${how}: its own agent copy is reported`);
      const all = Object.values(runs).map((r) => r.out).join("\n");
      assert.ok(all.includes(invocation(m, "doctor")), `${m.id} ${how}: its own doctor form is named`);
      assert.ok(all.includes(invocation(m, "bind", { args: "<vault>" })), `${m.id} ${how}: its own bind form is named`);
    }
  }
});

test("contract 18, layer 3, planted: today's text under another harness's identity fails, naming the form", () => {
  const other = MANIFESTS.find((m) => m.id !== SRC.id);
  if (!other) return;
  const text = `projectstore doctor: 1 install issue(s) — run ${invocation(SRC, "doctor")} · See /plugin → Marketplaces to enable auto-update.`;
  const hits = foreignHits(text, foreignPatterns(ROOT, other.id)).map((h) => h.what);
  assert.ok(hits.includes(`${SRC.id} commands form`), hits.join(", "));
  if ((SRC.ui_vocabulary || []).includes("/plugin")) assert.ok(hits.includes(`${SRC.id} UI word`), hits.join(", "));
});

// The path the hook test cannot see: a rendered skill's command runs the core
// from the shell's tree with no identity variable at all, on a project that
// has every harness's directory (the maintainer's own shape). Doctor — text
// and JSON — and SessionStart must speak that shell's harness, and run none of
// the checks its manifest says it has no surface for.
test("contract 18, layer 3: a core run from a shell's tree, with no identity variable, on a project of every harness, speaks that shell's harness", () => {
  for (const m of MANIFESTS.filter((x) => x.install?.shell && x.id !== SRC.id)) {
    const core = packedShell(m);
    const f = fixture(m);
    for (const h of MANIFESTS) mkdirSync(join(f.proj, h.runtime.harness_dir), { recursive: true });
    const registered = registerSource(f);
    const env = cleanEnv({ HOME: f.home, PROJECTSTORE_SESSIONS_DIR: f.sessions });
    const run = (file, args, input = null) => {
      const r = spawnSync(process.execPath, [join(core, file), ...args], { cwd: f.proj, env, input: input === null ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000 });
      return (r.stdout || "") + (r.stderr || "");
    };
    const outs = {
      "doctor text": run("bin/projectstore.mjs", ["doctor", "--project", f.proj]),
      "doctor json": run("bin/projectstore.mjs", ["doctor", "--json", "--project", f.proj]),
      "session-start": run("hooks/session-start.mjs", [], { hook_event_name: "SessionStart", session_id: "v-shell", source: "startup", cwd: f.proj }),
      "session-rules": run("hooks/session-rules.mjs", [], { hook_event_name: "SessionStart", session_id: "v-shell", cwd: f.proj }),
      "pre-compact": run("hooks/pre-compact.mjs", [], { hook_event_name: "PreCompact", session_id: "v-shell", trigger: "manual", cwd: f.proj }),
    };
    const pats = foreignPatterns(ROOT, m.id);
    const aboutMsgs = aboutMessages(outs["doctor json"], m.id);
    for (const [label, out] of Object.entries(outs)) assert.deepEqual(foreignHits(withoutAboutFindings(out, m.id, aboutMsgs), pats).map((h) => `${h.text} (${h.what})`), [], `${m.id} ${label}:\n${out}`);
    const json = JSON.parse(outs["doctor json"]);
    const checks = new Set(json.result.map((x) => x.check));
    if (m.surfaces?.statusline?.supported === false) assert.ok(!checks.has("statusline"), `${m.id}: no status-line finding`);
    if (m.surfaces?.plugin?.format !== "host-plugin-registration") assert.ok(!checks.has("auto-update"), `${m.id}: no auto-update finding`);
    if (m.surfaces?.mcp?.supported === false) assert.ok(!checks.has("mcp"), `${m.id}: no MCP finding`);
    if (m.surfaces?.agents?.supported === false) assert.ok(!checks.has("override-copies"), `${m.id}: no agent-copy finding`);
    assert.ok(outs["doctor text"].includes(invocation(m, "agents", { args: "register" })), `${m.id}: the remedy names its own form`);
    // The findings the filter took out are there, and are the source harness's:
    // its name, its mark, its forms — the steps they name happen there.
    if (registered) {
      const about = json.result.filter((x) => x.about === SRC.id);
      assert.ok(about.length >= 1, `${m.id}: the source harness's registration is reported:\n${outs["doctor json"]}`);
      assert.ok(about.every((x) => x.message.startsWith(`${SRC.display_name}: `)), "each opens with the harness it is about");
      assert.ok(about.some((x) => x.message.includes(invocation(SRC, "doctor", { args: "--fix" }))), "and names that harness's own form");
      assert.ok(outs["doctor text"].includes(`${SRC.display_name}: `), "the text report names it too");
    }
  }
});

// The rules name roles in the session's form; where that differs from the form
// the shared AGENTS.md block is written in, one sentence says both are one
// role. Where they agree there is no such sentence, so the source harness's
// rules keep their bytes.
test("contract 18: the session rules' bridge to the shared block appears only where the forms differ, and the block is written in the form it names", () => {
  const f = fixture(SRC);
  for (const m of MANIFESTS) {
    const env = cleanEnv({ HOME: f.home, PROJECTSTORE_HARNESS: m.id, ...(m.runtime.project_dir_env ? { [m.runtime.project_dir_env]: f.proj } : {}) });
    const r = runNode("hooks/session-rules.mjs", [], { cwd: f.proj, env, input: { hook_event_name: "SessionStart", session_id: "v-rules", cwd: f.proj } });
    const differs = invocation(m, "critic", { kind: "agents" }) !== sharedRoleForm("critic");
    assert.equal(/The `AGENTS\.md` block may name roles as/.test(r.out), differs, `${m.id}:\n${r.out}`);
    assert.ok(r.out.includes(invocation(m, "critic", { kind: "agents" })), `${m.id} names its own critic form`);
  }
  // The bridge says the block uses the shared form: pin that the template does.
  const tmpl = readFileSync(join(ROOT, "templates", "claude-md-block.md.tmpl"), "utf8");
  assert.ok(tmpl.includes(sharedRoleForm("critic")), "the agents-block template names roles in the form the bridge reports");
});

// The reviewer's pass (2026-10-05). A registration of ANOTHER harness in the
// project is that harness's fact: said in its forms, opened with its name,
// marked `about`. Under its own harness the finding is the bytes it was.
test("contract 18: another harness's registration speaks that harness's forms, named and marked; its own harness reads it unchanged", () => {
  const home = tmp("ps-vocab-reg-home-");
  const proj = tmp("ps-vocab-reg-proj-");
  const other = fakeInstall(home, "0.27.1");
  writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: other, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }]);
  const state = { kind: "registration", harness: SRC.id, surface: "plugin", state: "current", silenced: ["projectstore@SmartAndPoint"], pkg: "0.29.0", path: join(home, "reg"), entry: "projectstore@projectstore-npm", installedVersion: "0.29.0", installPath: join(home, "cache") };
  const own = checkPluginRegistration(proj, [state], { home, speaker: SRC }).find((f) => /is off for this checkout/.test(f.message));
  assert.ok(own, "the silenced copy is named");
  assert.equal(own.about, undefined, "its own harness: no mark");
  assert.ok(!own.message.startsWith(`${SRC.display_name}: `), "and no prefix");
  assert.ok(own.message.includes(`then ${invocation(SRC, "doctor", { args: "--fix" })}.`), own.message);
  for (const m of MANIFESTS.filter((x) => x.id !== SRC.id)) {
    const f = checkPluginRegistration(proj, [state], { home, speaker: m }).find((x) => /is off for this checkout/.test(x.message));
    assert.equal(f.about, SRC.id, `${m.id}: marked about ${SRC.id}`);
    assert.ok(f.message.startsWith(`${SRC.display_name}: `), f.message);
    assert.ok(f.message.includes(invocation(SRC, "doctor", { args: "--fix" })), "the step happens there, in its form");
    assert.ok(!f.message.includes(invocation(m, "doctor")), "never the listener's form for a step in another harness");
  }
});

test("contract 18: agent copies, the layout move and bind's inherit form follow the data, not the listener's wish", () => {
  for (const m of MANIFESTS) {
    const proj = tmp("ps-vocab-copies-");
    const home = tmp("ps-vocab-copies-home-");
    mkdirSync(join(proj, ".claude", "agents"), { recursive: true });
    writeFileSync(join(proj, ".claude", "agents", "critic.md"), "---\nname: critic\n---\n# source: projectstore v0.1.0\n");
    if (m.surfaces?.agents?.supported === false) assert.deepEqual(checkOverrideCopies(proj, home, m), [], `${m.id}: no agents surface, no override-copies finding`);
    // A worktree's parent binding travels whole where bind cannot inherit.
    const env = cleanEnv({ PROJECTSTORE_HARNESS: m.id });
    const form = inheritForm("/v/x", { layout: "research", language: "ru", env });
    assert.equal(form, m.capabilities?.bind_inherit ? invocation(m, "bind", { args: "--inherit" }) : invocation(m, "bind", { args: '"/v/x" --layout research --language ru' }), m.id);
    // A value that is not a plain name never reaches the form.
    if (!m.capabilities?.bind_inherit) assert.equal(inheritForm("/v/x", { layout: "a; rm -rf ~", language: "ru", env }), invocation(m, "bind", { args: '"/v/x" --language ru' }), m.id);
  }
  // The layout move's remedy is the source harness's whoever listens: its
  // legacy directory holds the files (the reviewer's pass, B2). This checkout
  // is the root, so the remedy runs its own copy and names the harness by id.
  const saved = process.env.PROJECTSTORE_HARNESS;
  try {
    for (const m of MANIFESTS) {
      process.env.PROJECTSTORE_HARNESS = m.id;
      resetDetection();
      const r = layoutRemedy(tmp("ps-vocab-layout-"), { root: ROOT, home: tmp("ps-vocab-layout-home-") });
      const text = r.command || r.advice;
      assert.ok(text.includes(`--harness ${SRC.id} `), `${m.id} listening: ${text}`);
      for (const o of MANIFESTS.filter((x) => x.id !== SRC.id)) assert.ok(!text.includes(`--harness ${o.id} `), `${m.id} listening: never ${o.id}'s move`);
    }
  } finally {
    if (saved === undefined) delete process.env.PROJECTSTORE_HARNESS; else process.env.PROJECTSTORE_HARNESS = saved;
    resetDetection();
  }
});

test("contract 18: without a manifest the helper degrades to the bare name; the lint sees past a `/*` inside a line comment", () => {
  assert.equal(invocation(null, "doctor"), "doctor");
  assert.equal(invocation(undefined, "doctor", { args: "--fix" }), "doctor --fix");
  // A `/*` inside a line comment, its first `*/` two lines on: read block
  // comments first and line 2 vanished.
  const planted = { "scripts/planted.mjs": "// see stories/*.md\nconst msg = \"run /projectstore:doctor\";\nconst x = 1; /* a real block */\n" };
  const hits = scanLiterals(ROOT, Object.keys(planted), { read: (f) => planted[f] });
  assert.deepEqual(hits.map((h) => `${h.line}:${h.text}`), ["2:/projectstore:doctor"]);
  // And the other order: a `//` inside a one-line block comment cannot cut its close.
  const planted2 = { "scripts/planted2.mjs": "const a = 1; /* a // b */\nconst msg = \"run /projectstore:doctor\";\n/* c */\n" };
  assert.deepEqual(scanLiterals(ROOT, Object.keys(planted2), { read: (f) => planted2[f] }).map((h) => `${h.line}:${h.text}`), ["2:/projectstore:doctor"]);
});

// A pre-0.28 project, run from another shell's tree with no identity variable:
// the legacy files sit in the source harness's directory and only its command
// moves them, so the layout finding and the agents block in the old binding
// are the source harness's facts — named, marked, in its forms. An enabled old
// copy of the source harness takes the remedy's advice branch, the one that
// names the source harness's own UI.
test("contract 18, layer 3: a pre-0.28 project, run from another shell's tree, hears the layout move as the source harness's", () => {
  for (const m of MANIFESTS.filter((x) => x.install?.shell && x.id !== SRC.id)) {
    const core = packedShell(m);
    const home = tmp("ps-vocab-legacy-home-");
    const { proj, old } = legacyProject(home);
    TEMP.push(proj);
    mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
    writeRegistry(home, [{ scope: "local", projectPath: proj, installPath: old, version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" }]);
    const env = cleanEnv({ HOME: home, PROJECTSTORE_SESSIONS_DIR: tmp("ps-vocab-legacy-sessions-") });
    const run = (file, args, input = null) => {
      const r = spawnSync(process.execPath, [join(core, file), ...args], { cwd: proj, env, input: input === null ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000 });
      return (r.stdout || "") + (r.stderr || "");
    };
    const outs = {
      "doctor json": run("bin/projectstore.mjs", ["doctor", "--json", "--project", proj]),
      "doctor text": run("bin/projectstore.mjs", ["doctor", "--project", proj]),
      "session-start": run("hooks/session-start.mjs", [], { hook_event_name: "SessionStart", session_id: "v-legacy", source: "startup", cwd: proj }),
      "session-rules": run("hooks/session-rules.mjs", [], { hook_event_name: "SessionStart", session_id: "v-legacy", cwd: proj }),
      "pre-compact": run("hooks/pre-compact.mjs", [], { hook_event_name: "PreCompact", session_id: "v-legacy", trigger: "manual", cwd: proj }),
    };
    const json = JSON.parse(outs["doctor json"]);
    const layout = json.result.find((f) => f.check === "layout-legacy");
    assert.ok(layout, `${m.id}: the move is reported:\n${outs["doctor json"]}`);
    assert.equal(layout.about, SRC.id, layout.message);
    assert.ok(layout.message.startsWith(`${SRC.display_name}: `), layout.message);
    // The fixture reaches the advice that names the source harness's own UI —
    // the branch the filter must take out, not a quieter one.
    assert.ok(uiWordPatterns(SRC).some((p) => new RegExp(p.re.source).test(layout.message)), `the advice branch ran: ${layout.message}`);
    const agents = json.result.find((f) => f.check === "agents-in-binding");
    if (agents) assert.equal(agents.about, SRC.id, agents.message);
    const pats = foreignPatterns(ROOT, m.id);
    const about = aboutMessages(outs["doctor json"], m.id);
    for (const [label, out] of Object.entries(outs)) assert.deepEqual(foreignHits(withoutAboutFindings(out, m.id, about), pats).map((h) => `${h.text} (${h.what})`), [], `${m.id} ${label}:\n${out}`);
  }
});

// The filter itself: it takes out the marked messages and nothing else — an
// unmarked foreign word in the same hook line, or a line that merely names
// the harness, is still found.
test("contract 18, layer 3: the filter removes exactly the marked findings, never a hook's whole output", () => {
  const other = MANIFESTS.find((x) => x.id !== SRC.id);
  const words = SRC.ui_vocabulary || [];
  if (!other || words.length < 2) return;
  const marked = `${SRC.display_name}: a copy is off — then ${words[0]} it`;
  const hook = JSON.stringify({ systemMessage: `${marked}\nunmarked: ${words[0]} again`, hookSpecificOutput: { additionalContext: `${SRC.display_name}: not marked, ${words[1]}` } });
  const pats = foreignPatterns(ROOT, other.id);
  const hits = foreignHits(withoutAboutFindings(hook, other.id, [marked]), pats).map((h) => h.text).sort();
  assert.deepEqual(hits, [words[0], words[1]].sort());
  const text = `  ⚠ [x] ${marked}\n  ⚠ [y] ${SRC.display_name}: unmarked ${words[1]}`;
  assert.deepEqual(foreignHits(withoutAboutFindings(text, other.id, [marked]), pats).map((h) => h.text), [words[1]]);
});

// The same rule for a harness's installed surfaces and for the registry's
// versions: a fact about another harness is named, marked, and its step said
// in that harness's form — the status-line hint only where it has one.
test("contract 18: another harness's surface is its fact — named, marked, its step in its form", async () => {
  const proj = tmp("ps-vocab-surf-");
  const states = MANIFESTS.map((h) => ({ harness: h.id, surface: "hooks", kind: "exclusive", path: join(proj, `${h.id}-x.json`), state: "stale", produced: true, reason: "stamped by another version" }));
  const read = { result: { used: MANIFESTS.map((h) => h.id), states }, FOREIGN_TEXT: "foreign" };
  for (const speaker of MANIFESTS) {
    const out = await checkHarnessSurfaces(null, proj, { read, speaker });
    for (const h of MANIFESTS) {
      const f = out.find((x) => x.file === `${h.id}-x.json`);
      assert.ok(f, `${speaker.id} listening: ${h.id}'s surface is reported`);
      if (h.id === speaker.id) assert.ok(f.about === undefined && !f.message.startsWith(`${h.display_name}: `), `${h.id}'s own: unmarked`);
      else assert.ok(f.about === h.id && f.message.startsWith(`${h.display_name}: `), `${speaker.id} listening: ${f.message}`);
      if (h.surfaces?.statusline?.supported === false) assert.ok(!/for the status line/.test(f.message), `${h.id} has no status line: ${f.message}`);
      else assert.ok(f.message.includes(`(for the status line, ${invocation(h, "statusline", { args: "on" })})`), f.message);
    }
  }
});

test("contract 18: version drift in one harness's registry is that harness's fact; across harnesses it is the machine's", () => {
  const home = tmp("ps-vocab-drift-home-");
  const proj = tmp("ps-vocab-drift-proj-");
  writeRegistry(home, [
    { scope: "user", installPath: fakeInstall(home, "0.27.1"), version: "0.27.1", lastUpdated: "2026-09-01T00:00:00Z" },
    { scope: "local", projectPath: proj, installPath: fakeInstall(home, "0.28.0"), version: "0.28.0", lastUpdated: "2026-09-02T00:00:00Z" },
  ]);
  const saved = process.env[SRC.runtime.home_env];
  delete process.env[SRC.runtime.home_env];
  try {
    const own = checkVersionDrift(home, [], proj, { speaker: SRC });
    assert.equal(own.length, 1);
    assert.equal(own[0].about, undefined);
    assert.match(own[0].message, /^projectstore is registered or installed at more than one version on this machine: .*\. Update the older one; the launcher renders whichever is registered\.$/, "its own harness: the bytes it always printed");
    for (const m of MANIFESTS.filter((x) => x.id !== SRC.id)) {
      const [f] = checkVersionDrift(home, [], proj, { speaker: m });
      assert.equal(f.about, SRC.id, "every copy is the source harness's");
      assert.equal(f.message, `${SRC.display_name}: ${own[0].message}`);
      // A copy of the listener's own beside them: the machine's fact, unmarked,
      // and the launcher named only where the listener has a status line.
      const [mixed] = checkVersionDrift(home, [{ surface: "hooks", harness: m.id, installedPkg: "0.29.0" }], proj, { speaker: m });
      assert.equal(mixed.about, undefined, mixed.message);
      assert.equal(/the launcher renders/.test(mixed.message), m.surfaces?.statusline?.supported !== false, mixed.message);
    }
  } finally {
    if (saved !== undefined) process.env[SRC.runtime.home_env] = saved;
  }
});

// The shared agents block is every harness's: one file, so a finding about it
// is never marked as another harness's, and its step is the listener's form.
test("contract 18: a shared surface is every harness's — never marked, its step the listener's", async () => {
  const proj = tmp("ps-vocab-shared-");
  const states = MANIFESTS.map((h) => ({ harness: h.id, surface: "agents_block", kind: "shared", path: join(proj, "AGENTS.md"), state: "ours-stale", produced: true, reason: "content differs at the same version" }));
  const read = { result: { used: MANIFESTS.map((h) => h.id), states }, FOREIGN_TEXT: "foreign" };
  for (const speaker of MANIFESTS) {
    const out = (await checkHarnessSurfaces(null, proj, { read, speaker })).filter((f) => f.file === "AGENTS.md");
    assert.equal(out.length, MANIFESTS.length, "one line per harness's state, as before");
    for (const f of out) {
      assert.equal(f.about, undefined, `${speaker.id} listening: ${f.message}`);
      assert.ok(f.message.endsWith(`Run ${invocation(speaker, "agents", { args: "register" })}.`), f.message);
    }
  }
});

// Where bind cannot inherit, the offer says what the command does — the same
// vault, layout and language — and never promises to adopt or copy the binding.
test("contract 18: the worktree offer promises only what the listener's bind does", async () => {
  const { bindingOfferText } = await import("../scripts/worktree.mjs");
  const b = { state: "inheritable", worktree: true, mainCheckout: "/m", vaultPath: "/v/x", layout: "research", language: "ru" };
  const saved = process.env.PROJECTSTORE_HARNESS;
  try {
    for (const m of MANIFESTS) {
      process.env.PROJECTSTORE_HARNESS = m.id;
      resetDetection();
      const text = bindingOfferText(b);
      const inherits = Boolean(m.capabilities?.bind_inherit);
      assert.ok(text.includes(invocation(m, "bind", { args: inherits ? "--inherit" : '"/v/x" --layout research --language ru' })), text);
      assert.equal(/adopt that binding|copies the binding/.test(text), inherits, `${m.id}: ${text}`);
    }
  } finally {
    if (saved === undefined) delete process.env.PROJECTSTORE_HARNESS; else process.env.PROJECTSTORE_HARNESS = saved;
    resetDetection();
  }
});

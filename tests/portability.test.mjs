// projectstore — portability tests (PS-HARNESS: "Capability manifests, the
// generator and the three invariants, re-derived from the spec").
//
// Slice A1 of the roadmap: the manifests exist, harness.mjs is the only reader
// of a branded environment variable, and the source layout is exactly one
// manifest that neither lints nor rewrites. The three generation invariants
// (staleness, lint, coverage) arrive with the first emitted tree; the seams
// they need — lintPatterns(), emittingHarnesses() — are asserted here to be
// empty rather than absent, so the generator story extends this file instead
// of starting one.
//
// Everything runs over the real tree. No fixtures.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_DIR,
  SOURCE_WRITE_TOOLS_FALLBACK,
  loadHarnesses,
  sourceHarness,
  emittingHarnesses,
  detectHarnessId,
  resetDetection,
  resetManifests,
  adoptHookInput,
  resetHookInput,
  projectRoot,
  pluginRoot,
  agentHome,
  configPath,
  childEnv,
  agentOverrides,
  runtimeEnvNames,
  sourceWriteTools,
  writeTools,
  lintPatterns,
  harnessForOverlay,
} from "../scripts/harness.mjs";
import { WRITE_TOOLS, isWriteTool, layoutPaths } from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = () => [...loadHarnesses(MANIFEST_DIR).values()];
// scripts/ and bin/, as repo-relative paths: the bin is outside scripts/ but
// under the same rule.
const scriptFiles = () => [
  ...readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")).sort().map((f) => `scripts/${f}`),
  ...readdirSync(join(ROOT, "bin")).filter((f) => f.endsWith(".mjs")).sort().map((f) => `bin/${f}`),
];

// Comments may name a harness (a rationale that says "CLAUDE_PLUGIN_ROOT is not
// expanded on Codex" is exactly the kind of sentence a good comment carries);
// code may not. Strips `//` to end of line — trailing ones too — and block
// comments. Over-strips a `//` inside a string literal, which is the safe
// direction for a lint over our own tree.
function stripComments(src) {
  // LINE comments first, block comments second, and the order is the whole
  // point: a `//` comment may contain a `/*` — this repository's own test
  // headers carry `node --test tests/*.test.mjs` — and a later line may
  // contain a `*/`, as `[^\n]*/g` does inside any regex that scans to end of
  // line. Stripping blocks first pairs those two accidents and deletes
  // everything between them. Measured 2026-09-08: it was swallowing 11KB of
  // scripts/lib.mjs, the largest file this lint is supposed to read, and the
  // lint passed because it never saw it.
  return src.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

// ─── Contract 1 / 2: the manifests ─────────────────────────────────────

test("generation contract 1: every manifest parses strictly and declares what the core relies on", () => {
  const names = readdirSync(MANIFEST_DIR).filter((n) => n.endsWith(".json")).sort();
  assert.ok(names.length >= 1, "at least the source manifest exists");
  for (const n of names) {
    const m = JSON.parse(readFileSync(join(MANIFEST_DIR, n), "utf8")); // throws on malformed — loud, here
    assert.equal(`${m.id}.json`, n, `${n}: file name equals id (detection is id-keyed)`);
    assert.equal(typeof m.display_name, "string");
    assert.equal(typeof m.emit, "boolean");
    assert.equal(typeof m.source_layout, "boolean");
    for (const k of ["plugin_root_env", "home_env", "home_default", "harness_dir", "overlay"]) {
      assert.equal(typeof m.runtime?.[k], "string", `${n}: runtime.${k}`);
    }
    // project_dir_env is `string | null`: a harness may export no project
    // directory at all, which is measured of Codex (2026-09-07 — its hook
    // payload carries `cwd` and its environment carries no such variable). The
    // key must still be present, so the omission is a decision on the record
    // rather than a field someone forgot. Both consumers are already null-safe:
    // harness.mjs's projectRoot and childEnv guard on it.
    assert.ok("project_dir_env" in (m.runtime || {}), `${n}: runtime.project_dir_env must be present, even as null`);
    assert.ok(
      m.runtime.project_dir_env === null || typeof m.runtime.project_dir_env === "string",
      `${n}: runtime.project_dir_env must be a string or null`,
    );
    assert.ok(Array.isArray(m.runtime.detect_env), `${n}: runtime.detect_env`);
    assert.ok(Array.isArray(m.tools?.write_tools) && m.tools.write_tools.length > 0, `${n}: tools.write_tools`);
    assert.ok(Array.isArray(m.tools.path_fields), `${n}: tools.path_fields`);
    assert.ok(Array.isArray(m.tools.known_non_write_tools), `${n}: tools.known_non_write_tools`);
    // approval_tool follows project_dir_env's rule: `string | null`, key
    // required. Contract 10's approval-gate lint has a case for "this harness
    // has no such tool", and it can only take it from a declared null — an
    // absent key is indistinguishable from a forgotten one, and the safe
    // reading (no structured-choice tool) is the one nobody would guess.
    assert.ok("approval_tool" in m.tools, `${n}: tools.approval_tool must be present, even as null`);
    assert.ok(
      m.tools.approval_tool === null || typeof m.tools.approval_tool === "string",
      `${n}: tools.approval_tool must be a string or null`,
    );
    assert.ok(m.hooks && typeof m.hooks.events === "object", `${n}: hooks.events`);
    assert.equal(typeof m.hooks.root_placeholder, "string", `${n}: hooks.root_placeholder`);
    assert.equal(typeof m.hooks.root_placeholder_literal, "boolean", `${n}: hooks.root_placeholder_literal`);
    assert.ok("verified" in m, `${n}: verified (contract 16) — null or {session, date}`);
    if (m.verified !== null) {
      assert.equal(typeof m.verified.session, "string");
      assert.match(m.verified.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.ok(m.output_channels && typeof m.output_channels === "object", `${n}: output_channels (contract 17)`);
    for (const ev of Object.keys(m.hooks.events)) {
      assert.ok(ev in m.output_channels, `${n}: output_channels carries a slot for ${ev}`);
    }
    for (const p of m.lint?.forbidden_unmapped || []) {
      assert.ok(["name", "token"].includes(p.class), `${n}: lint pattern ${p.pattern} declares its case class (contract 7)`);
    }
    for (const [ev, ch] of Object.entries(m.output_channels)) {
      if (ev.startsWith("_")) continue;
      if (ch === null) continue; // unmeasured: the slot exists, the value does not
      assert.ok(Array.isArray(ch.fields), `${n}: output_channels.${ev}.fields`);
      assert.ok(["measured", "documented"].includes(ch.evidence), `${n}: output_channels.${ev}.evidence`);
    }
    for (const [kind, s] of Object.entries(m.surfaces || {})) {
      if (kind.startsWith("_")) continue;
      assert.equal(typeof s.supported, "boolean", `${n}: surfaces.${kind}.supported`);
      assert.ok(typeof s.scope === "string" && typeof s.scope_reason === "string" && s.scope_reason.length > 0,
        `${n}: surfaces.${kind}.scope and scope_reason`);
      assert.ok(["exclusive", "shared", "host", "registration"].includes(s.kind), `${n}: surfaces.${kind}.kind (install spec contract 0, amended 2026-09-05)`);
      if (s.kind === "registration") {
        for (const f of ["marketplace_name", "plugin_name", "plugin_subdir", "manifest", "provenance_key", "condition"]) assert.equal(typeof s[f], "string", `${n}: surfaces.${kind}.${f}`);
        assert.ok(Array.isArray(s.dir) && s.dir.length, `${n}: surfaces.${kind}.dir`);
        assert.ok(s.registry && typeof s.registry.enabled_pointer === "string", `${n}: surfaces.${kind}.registry`);
        assert.ok(s.cli && typeof s.cli.bin === "string" && s.cli.commands && typeof s.cli.verified?.date === "string", `${n}: surfaces.${kind}.cli with a measured date`);
        for (const c of ["validate", "marketplace_add", "marketplace_update", "marketplace_remove", "install", "update", "uninstall", "disable", "enable"]) assert.ok(Array.isArray(s.cli.commands[c]), `${n}: cli.commands.${c}`);
      }
      if (s.kind === "shared") assert.ok(s.marker && typeof s.marker === "object", `${n}: surfaces.${kind}.marker (install spec contract 6)`);
      if (s.kind !== "host") assert.equal(typeof s.format, "string", `${n}: surfaces.${kind}.format keys the installer's handler`);
    }
    assert.ok(Array.isArray(m.rewrites), `${n}: rewrites`);
  }
});

test("generation contract 2: exactly one manifest is the source layout, and it neither emits, lints nor rewrites", () => {
  const src = manifests().filter((m) => m.source_layout);
  assert.equal(src.length, 1);
  const m = src[0];
  assert.equal(m.emit, false);
  assert.equal(m.output_dir, null);
  assert.ok(!("lint" in m), "the source manifest carries no lint block — linting runs over emitted trees only");
  assert.deepEqual(m.rewrites, []);
  assert.equal(sourceHarness().id, m.id);
  assert.deepEqual(emittingHarnesses(), [], "no emitting harness yet — the generator story fills this seam");
});

test("generation contract 16: the source harness is verified, so it is not experimental", () => {
  const m = sourceHarness();
  assert.notEqual(m.verified, null);
  assert.equal(m.output_channels.PreCompact.fields.length, 0, "PreCompact has no model-facing hookSpecificOutput channel — measured negatively");
  assert.equal(m.output_channels.Stop.evidence, "measured");
});

// The other half of contract 16: the label a reader sees is DERIVED from
// `verified`, not written next to it. Both directions, because either drift is
// a lie — an experimental harness described as supported promises something no
// run backs, and a verified one still called experimental wastes the run.
test("generation contract 16: docs/harnesses.md labels a harness experimental exactly when verified is null", () => {
  const doc = readFileSync(join(ROOT, "docs/harnesses.md"), "utf8");
  const rows = new Map();
  for (const line of doc.split("\n")) {
    const m = /^\|[^|]+\|\s*`([a-z0-9-]+)`\s*\|\s*\*\*(supported|experimental)\*\*\s*\|/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  assert.ok(rows.size > 0, "docs/harnesses.md carries a status table keyed by harness id");
  for (const h of manifests()) {
    const label = rows.get(h.id);
    assert.ok(label, `docs/harnesses.md has no status row for ${h.id} — a harness a user can install and cannot read about`);
    assert.equal(
      label, h.verified === null ? "experimental" : "supported",
      `${h.id}: verified is ${h.verified === null ? "null" : "set"}, so the docs must say `
      + `${h.verified === null ? "experimental" : "supported"}`,
    );
  }
  const ids = new Set(manifests().map((m) => m.id));
  for (const id of rows.keys()) assert.ok(ids.has(id), `docs/harnesses.md lists ${id}, which has no manifest`);
});

// ─── Acceptance 1 / 2: the branded-env discipline ──────────────────────

test("generation acceptance: no file under scripts/ reads a branded environment variable except harness.mjs", () => {
  // Derived, not typed: every name every manifest declares, plus a prefix
  // guard so a variable nobody has put in a manifest yet is still caught.
  const declared = new Set();
  for (const m of manifests()) {
    const r = m.runtime || {};
    for (const k of [r.project_dir_env, r.plugin_root_env, r.home_env, ...(r.detect_env || []), ...(r.agent_overrides || []).map((o) => o.env)]) {
      if (k) declared.add(k);
    }
  }
  assert.ok(declared.size > 0);
  const prefix = /\b(CLAUDE|CODEX|OPENCODE|ANTIGRAVITY)_[A-Z0-9_]+\b/;
  // The allow-list, in the shape of the lint's own {phrase, why} entries —
  // one entry per (file, token), and an entry without a `why` fails here
  // (contract 8). It is empty on purpose: harness.mjs indexes
  // env[manifest.runtime.<key>] and must contain no branded literal either,
  // so even the permitted file has no entry.
  const ALLOW = [];
  for (const a of ALLOW) assert.ok(typeof a.why === "string" && a.why.length > 0, `allow-list entry ${a.file}/${a.phrase} has no why`);
  for (const n of scriptFiles()) {
    const code = stripComments(readFileSync(join(ROOT, n), "utf8"));
    const hit = [...declared].find((k) => new RegExp(`\\b${k}\\b`).test(code)) || (prefix.exec(code) || [])[0];
    if (!hit) continue;
    const allowed = ALLOW.find((a) => a.file === n && a.phrase === hit);
    assert.ok(allowed, `${n} names the branded variable ${hit} in code — route it through harness.mjs`);
  }
});

test("generation acceptance: no script branches on a harness id", () => {
  // Vacuous while the source harness is the only one — filtering out its own
  // id leaves nothing to match — and load-bearing the day codex.json lands.
  const ids = manifests().map((m) => m.id).filter((id) => id !== sourceHarness().id);
  for (const n of scriptFiles()) {
    const code = stripComments(readFileSync(join(ROOT, n), "utf8"));
    for (const id of ids) {
      assert.ok(!new RegExp(`["'\`]${id}["'\`]`).test(code), `${n} names the harness "${id}" in code — a manifest value, not a branch`);
    }
  }
});

test("install spec modules: doctor never imports the installer, and the installer names no harness id", () => {
  // Direction: installer → provenance ← doctor. And the installer is keyed by
  // surface format, never by harness id — the source id included, which the
  // branch test above deliberately filters out.
  const doctor = readFileSync(join(ROOT, "scripts", "doctor.mjs"), "utf8");
  // Imports, not mentions: doctor names the verb in its remedies.
  assert.ok(!/from "\.\/install-harness\.mjs"|import\("\.\/install-harness\.mjs"\)/.test(doctor), "doctor.mjs imports install-harness");
  // provenance.mjs stays out of the SessionStart graph, which imports doctor
  // statically: doctor reaches surfaces.mjs (and through it provenance) only
  // by a dynamic import inside the one check that needs it.
  assert.ok(!doctor.includes("provenance.mjs"), "doctor.mjs imports provenance.mjs");
  assert.ok(!/from "\.\/surfaces\.mjs"/.test(doctor), "doctor.mjs imports surfaces.mjs statically");
  assert.ok(/await import\("\.\/surfaces\.mjs"\)/.test(doctor), "doctor.mjs reaches surfaces.mjs dynamically");
  for (const n of readdirSync(join(ROOT, "hooks")).filter((f) => f.endsWith(".mjs"))) {
    const hook = readFileSync(join(ROOT, "hooks", n), "utf8");
    assert.ok(!hook.includes("surfaces.mjs"), `hooks/${n} pulls surfaces.mjs into the SessionStart graph`);
    assert.ok(!hook.includes("cli.mjs"), `hooks/${n} pulls the CLI (and through it the installer) into the SessionStart graph`);
    assert.ok(!hook.includes("mcp.mjs"), `hooks/${n} pulls the MCP server into the SessionStart graph`);
  }
  const surfaces = readFileSync(join(ROOT, "scripts", "surfaces.mjs"), "utf8");
  // The banner names the installer as its generator — a string, not an import.
  assert.ok(!/from "\.\/install-harness\.mjs"/.test(surfaces), "surfaces.mjs imports the installer");
  for (const call of ["writeFileSync", "writeFileAtomic", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync", "appendFileSync", "copyFileSync", "renameSync", "cpSync", "writeFile(", "createWriteStream"]) assert.ok(!surfaces.includes(call), `surfaces.mjs writes (${call})`);
  const code = stripComments(readFileSync(join(ROOT, "scripts", "install-harness.mjs"), "utf8"));
  for (const id of manifests().map((m) => m.id)) {
    assert.ok(!new RegExp(`["'\`]${id}["'\`]`).test(code), `install-harness.mjs names the harness "${id}"`);
  }
});

test("generation modules: harness.mjs imports node builtins only — nothing from this repository", () => {
  const src = readFileSync(join(ROOT, "scripts", "harness.mjs"), "utf8");
  const specs = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:"), `harness.mjs imports ${s}`);
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!src.includes("GENERATED by"), "the banner is provenance.mjs's, not this file's");
});

// ─── The resolvers lib.mjs re-exports ──────────────────────────────────

test("generation contract 2: WRITE_TOOLS comes from the source manifest, and the fallback matches it", () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), [...sourceHarness().tools.write_tools].sort());
  assert.deepEqual([...SOURCE_WRITE_TOOLS_FALLBACK].sort(), [...sourceHarness().tools.write_tools].sort(),
    "a missing manifest must not silently empty the write family — the fallback is pinned to the manifest");
  assert.deepEqual([...sourceWriteTools()], [...sourceHarness().tools.write_tools]);
  assert.deepEqual([...writeTools()].sort(), [...WRITE_TOOLS].sort());
  assert.ok(Object.isFrozen(WRITE_TOOLS));
  assert.notEqual(WRITE_TOOLS, sourceHarness().tools.write_tools, "copied, not aliased into the cached manifest");
  assert.ok(isWriteTool("Write") && !isWriteTool("Read"));
});

test("harness resolvers: the branded names are read from the manifest, fresh on every call", () => {
  const src = sourceHarness();
  const r = src.runtime;
  const env = { [r.project_dir_env]: "/tmp/p roj", [r.plugin_root_env]: "/tmp/plug in", [r.home_env]: "/tmp/ho me" };
  assert.equal(detectHarnessId(env), src.id);
  assert.equal(projectRoot(env), "/tmp/p roj");
  assert.equal(pluginRoot(env), "/tmp/plug in");
  assert.equal(agentHome(env), "/tmp/ho me");
  assert.equal(agentHome({}, "/home/x"), join("/home/x", r.home_default));
  assert.equal(configPath("/tmp/p roj", env), layoutPaths("/tmp/p roj").binding, "the binding is harness-neutral (layout ADR, 2026-09-06); the legacy file is read only when it exists");
  assert.equal(pluginRoot({}), ROOT, "no variable set: the repository root, resolved through fileURLToPath");
  assert.deepEqual(runtimeEnvNames(env), { projectDir: r.project_dir_env, pluginRoot: r.plugin_root_env, home: r.home_env });
  const child = childEnv({ A: "1" }, { projectRoot: "/tmp/x" });
  assert.equal(child[r.project_dir_env], "/tmp/x");
  assert.equal(child.A, "1");
  assert.equal(detectHarnessId({}), src.id, "nothing set: the source harness, never null");
  assert.equal(detectHarnessId({ PROJECTSTORE_HARNESS: src.id }), src.id);
  assert.equal(detectHarnessId({ PROJECTSTORE_HARNESS: "no-such-harness" }), src.id, "an unknown forced id falls through");
  resetDetection();
});

// The payload's cwd is the answer on a harness that exports no project-dir
// variable — every harness but the source one, today. It must sit BELOW the
// declared variable (which is the harness stating the answer) and ABOVE
// process.cwd() (which is us inferring it).
test("harness resolvers: an adopted hook payload beats cwd and loses to a declared project dir", () => {
  const r = sourceHarness().runtime;
  resetHookInput();
  assert.equal(projectRoot({}), process.cwd(), "nothing adopted: the process's own directory");

  adoptHookInput({ cwd: "/tmp/from-pay load" });
  assert.equal(projectRoot({}), "/tmp/from-pay load", "adopted: the payload, not cwd");
  assert.equal(
    projectRoot({ [r.project_dir_env]: "/tmp/decl ared" }),
    "/tmp/decl ared",
    "a declared project dir still wins — adopting a payload must never invert this",
  );
  assert.equal(
    projectRoot({}, { cwd: "/tmp/explic it" }),
    "/tmp/explic it",
    "an explicitly passed payload beats the adopted one",
  );

  // Nothing usable leaves the adopted root alone, rather than clearing it: a
  // hook that gets no payload must not lose an answer an earlier call gave.
  adoptHookInput(null);
  adoptHookInput({});
  adoptHookInput({ cwd: "" });
  adoptHookInput({ cwd: 42 });
  assert.equal(projectRoot({}), "/tmp/from-pay load");

  resetHookInput();
  assert.equal(projectRoot({}), process.cwd(), "reset returns the resolver to cwd");
  // projectRoot() memoises the detected harness on the way through; its
  // neighbour above resets for the same reason. Inert while one manifest
  // exists, load-bearing the moment a second one lands.
  resetDetection();
});

// Presence, not text order. Execution order is asserted behaviourally in
// tests/scripts.test.mjs, where a payload naming another project must win over
// the process's cwd; a source-order regex would have to special-case import
// lines and helpers defined above main(), and would still be checking text.
// What this catches is what those drives cannot see: a SIXTH hook, registered
// later, that never adopts its payload at all. The list comes from hooks.json —
// globbing hooks/*.mjs would miss scripts/touch-session.mjs, which is
// registered but not co-located.
test("every registered hook adopts its payload before it can resolve a project", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  // The placeholder comes from the manifest, never typed here — this is the
  // file whose whole thesis is that branded names live in harnesses/*.json.
  const placeholder = sourceHarness().hooks.root_placeholder;
  const files = [...new Set(
    Object.values(reg.hooks).flatMap((entries) =>
      entries.flatMap((e) => (e.hooks || []).map((h) =>
        (h.command || "").split(`${placeholder}/`).pop().trim()))))]
    .filter((f) => f.endsWith(".mjs"));
  assert.equal(files.length, 5, `expected every registered hook script, got ${JSON.stringify(files)}`);

  const offenders = files.filter(
    (rel) => !/\badoptHookInput\s*\(/.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(
    offenders, [],
    "a hook that never calls adoptHookInput resolves its project from whatever directory "
    + "the process started in — silently, on any harness that exports no project-dir variable",
  );
});

// The environment a Codex plugin hook actually receives, captured verbatim on
// 2026-09-07 (ps-smoke/codex-run2/hook-payloads-full.jsonl). It carries BOTH
// harnesses' plugin-root names, because Codex sets CLAUDE_PLUGIN_ROOT for
// compatibility — which is why detection needs more than a second manifest.
const MEASURED_CODEX_HOOK_ENV = Object.freeze({
  PLUGIN_ROOT: "/Users/x/.codex/plugins/cache/projectstore/projectstore/0.28.0-rc.2",
  PLUGIN_DATA: "/Users/x/.codex/plugins/data/projectstore-projectstore",
  CLAUDE_PLUGIN_ROOT: "/Users/x/.codex/plugins/cache/projectstore/projectstore/0.28.0-rc.2",
  CLAUDE_PLUGIN_DATA: "/Users/x/.codex/plugins/data/projectstore-projectstore",
});

test("generation contract 1: a variable two harnesses set identifies neither (shared_env)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  const src = JSON.parse(readFileSync(join(MANIFEST_DIR, "claude-code.json"), "utf8"));
  writeFileSync(join(dir, "claude-code.json"), JSON.stringify(src), "utf8");

  // A minimal second manifest, only the fields detection reads. It sorts AFTER
  // claude-code.json, which is what makes the tie-break decide the answer.
  const codex = {
    id: "codex", display_name: "Codex", emit: false, source_layout: false,
    runtime: {
      detect_env: ["PLUGIN_ROOT", "CODEX_HOME"],
      project_dir_env: null,
      plugin_root_env: "PLUGIN_ROOT",
      home_env: "CODEX_HOME",
      home_default: ".codex",
      harness_dir: ".codex",
      overlay: "codex",
      shared_env: ["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"],
    },
  };
  writeFileSync(join(dir, "codex.json"), JSON.stringify(codex), "utf8");

  try {
    resetManifests(); resetDetection();
    assert.equal(
      detectHarnessId(MEASURED_CODEX_HOOK_ENV, dir), "codex",
      "a Codex hook environment must detect as codex, not as the harness whose "
      + "plugin-root name Codex also sets for compatibility",
    );

    // The demotion is symmetric, and that is the point: the shared name stops
    // identifying EITHER harness. Claude Code is still detected from its own
    // project-dir variable, which Codex does not set.
    const claudeEnv = { CLAUDE_PLUGIN_ROOT: "/x", CLAUDE_PROJECT_DIR: "/p" };
    assert.equal(detectHarnessId(claudeEnv, dir), "claude-code");

    // Nothing but the shared name. The demotion leaves it a WEAK signal for
    // claude-code — the owner keeps it, it just stops deciding — so detection
    // does not fall to the source harness by default. What it must not do is
    // answer from filename order. Driven from an empty directory, because
    // detect()'s middle step probes `process.cwd()` for a harness directory and
    // the repository root has `.claude/`: an earlier version of this assertion
    // passed for that reason rather than the one it claimed.
    const cwd = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "ps-cwd-"));
    try {
      process.chdir(empty);
      resetDetection();
      assert.equal(
        detectHarnessId({ CLAUDE_PLUGIN_ROOT: "/x" }, dir), "claude-code",
        "the owner still recognises its own name weakly when no project evidence exists",
      );

      // Both harness directories present is the case the probe cannot break:
      // it iterates manifests in filename order, so it would answer
      // claude-code for a project that is plainly both. Recorded as the
      // known limit rather than asserted as correct — the fix belongs with
      // the `--project` decision item on the generator story.
      mkdirSync(join(empty, ".claude"), { recursive: true });
      mkdirSync(join(empty, ".codex"), { recursive: true });
      resetDetection();
      assert.equal(
        detectHarnessId({}, dir), "claude-code",
        "KNOWN LIMIT: with no environment evidence and both harness directories "
        + "present, the project probe answers in manifest filename order",
      );
    } finally {
      process.chdir(cwd);
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetManifests(); resetDetection();
  }
});

// The test above drives a fixture it writes itself, so it exercises the RULE
// and never the shipped data. That distinction cost this slice a false pass:
// against the full measured Codex environment, deleting `shared_env` from the
// real harnesses/codex.json changes nothing, because PLUGIN_DATA in detect_env
// happens to break the tie by one weak hit — which is counting rather than
// reasoning, and is the mechanism contract 1's amendment explicitly rejects (it
// inverts the moment a Codex user exports one more Claude Code variable). So
// the assertion that keeps `shared_env` load-bearing has to be made on the real
// manifests, with an environment carrying nothing BUT the two plugin roots.
test("generation contract 1: the shipped manifests identify a Codex session by the demotion, not by a hit count", () => {
  const cwd = process.cwd();
  // From an empty directory: detect()'s middle step probes process.cwd() for a
  // harness directory, and this repository has .claude/.
  const empty = mkdtempSync(join(tmpdir(), "ps-cwd-"));
  try {
    process.chdir(empty);
    resetManifests(); resetDetection();
    assert.equal(
      detectHarnessId({ PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p" }, MANIFEST_DIR), "codex",
      "the two plugin-root names alone, which is all the demotion has to work with: "
      + "without runtime.shared_env this answers claude-code, on the shipped files",
    );
    resetDetection();
    assert.equal(
      detectHarnessId(MEASURED_CODEX_HOOK_ENV, MANIFEST_DIR), "codex",
      "and the full captured environment agrees",
    );
  } finally {
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
    resetManifests(); resetDetection();
  }
});

// The global demotion has one shape it cannot survive: a harness whose ONLY
// strong variable is one another manifest declares as shared. Codex is exactly
// that shape — its project_dir_env is null, so PLUGIN_ROOT is all it has. This
// keeps the tripwire on the data rather than on someone remembering.
//
// What it does NOT protect: a harness that declares a strong variable it does
// not always set. claude-code passes here on CLAUDE_PROJECT_DIR, while a Claude
// Code process that ships CLAUDE_PLUGIN_ROOT without it has no strong signal at
// all after the demotion and falls to detect()'s cwd probe. Whether such a
// process exists is unmeasured, and is recorded as an open question on the
// generator story rather than assumed away here.
test("generation contract 1: every manifest keeps a strong variable no other manifest shares", () => {
  const all = manifests();
  const shared = new Set(all.flatMap((m) => m.runtime?.shared_env || []));
  for (const m of all) {
    const strong = [m.runtime?.plugin_root_env, m.runtime?.project_dir_env].filter(Boolean);
    assert.ok(
      strong.some((k) => !shared.has(k)),
      `${m.id}: every strong variable it declares is listed in some manifest's shared_env, `
      + "so nothing can identify it strongly — detection would fall back to weak signals "
      + "and then to filename order",
    );
  }
});

test("harness resolvers: agent overrides are named by the manifest and reported only when set", () => {
  const list = sourceHarness().runtime.agent_overrides;
  assert.ok(Array.isArray(list) && list.length >= 2);
  assert.deepEqual(agentOverrides({}), []);
  const one = list[0];
  const got = agentOverrides({ [one.env]: "low" });
  assert.deepEqual(got, [{ env: one.env, kind: one.kind, beats: one.beats, value: "low" }]);
});

// The events map is what a generator would REGISTER for a harness, so an entry
// with no handler on our side renders a hook that fires into nothing. codex.json
// listed six and named them "the six projectstore registers"; hooks/hooks.json
// registers five. Measured against the file rather than against the sentence.
test("generation contract 1: no manifest maps an event projectstore does not register", () => {
  const registered = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks));
  assert.ok(registered.size > 0);
  for (const m of manifests()) {
    for (const ev of Object.keys(m.hooks?.events || {})) {
      assert.ok(registered.has(ev), `${m.id}: hooks.events maps ${ev}, which hooks/hooks.json does not register`);
    }
  }
  // The other direction is deliberately NOT asserted: a harness that lacks one
  // of our events omits it here, and that omission is data the generator needs
  // (contract 9 makes it state the gap in the emitted file). Both manifests
  // happen to carry all five today.
});

// `agents` addresses OVERLAYS. Every overlay key must lead back to the manifest
// that owns it, or the clerk's pin — the one thing ADR-008 says must not be
// left to the default — silently stops happening.
test("generation contract 1: every manifest's overlay key resolves back to that manifest", () => {
  for (const m of manifests()) {
    assert.equal(harnessForOverlay(m.runtime.overlay)?.id, m.id, `${m.id}: overlay ${m.runtime.overlay}`);
    assert.equal(harnessForOverlay(m.id)?.id, m.id, `${m.id}: id`);
    // What the resolution is FOR: a harness that declares a cheap model gets
    // its clerk pinned to that model and no other harness's.
    const cheap = harnessForOverlay(m.runtime.overlay)?.agent_translation?.cheap_model;
    if (cheap) {
      const foreign = manifests().filter((o) => o.id !== m.id).map((o) => o.agent_translation?.cheap_model);
      assert.ok(!foreign.includes(cheap), `${m.id}: its cheap model is another harness's — a model name is harness-specific (ADR-008)`);
    }
  }
  assert.equal(harnessForOverlay(null), null);
  assert.equal(harnessForOverlay("nothing-declares-this"), null);
});

test("generation contract 6: lint patterns are derived from the OTHER manifests, and empty for the source layout", () => {
  assert.deepEqual(lintPatterns(sourceHarness()), []);
  // A fictitious emitting harness sees the source harness's tools and variables as forbidden tokens.
  const fake = { id: "fake", emit: true, lint: { forbidden_unmapped: [{ pattern: "\\bClaude Code\\b", class: "name" }] } };
  const pats = lintPatterns(fake);
  assert.ok(pats.some((p) => p.pattern === "\\bClaude Code\\b" && p.class === "name" && !p.derived));
  for (const t of sourceHarness().tools.write_tools) assert.ok(pats.some((p) => p.pattern === `\\b${t}\\b` && p.class === "token" && p.derived));
  assert.ok(pats.some((p) => p.pattern === `\\b${sourceHarness().runtime.plugin_root_env}\\b`));
});

test("tools.path_fields is the extractor's list — pinned until harness.mjs owns extraction", () => {
  // scripts/touch-session.mjs still extracts the path itself
  // (`ti.file_path || ti.notebook_path || ti.path`); routing it through the
  // manifest is the generator story's path-extraction item (Codex's
  // apply_patch needs it). Until then the two lists may not drift.
  const src = readFileSync(join(ROOT, "scripts", "touch-session.mjs"), "utf8");
  const m = /ti\.(\w+)\s*\|\|\s*ti\.(\w+)\s*\|\|\s*ti\.(\w+)/.exec(src);
  assert.ok(m, "touch-session.mjs's three-field extractor is where this test expects it");
  assert.deepEqual(sourceHarness().tools.path_fields, [m[1], m[2], m[3]]);
});

test("hooks.json's placeholder and write matcher are the manifest's", () => {
  const src = sourceHarness();
  const hooks = readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8");
  assert.ok(hooks.includes(src.hooks.root_placeholder), "hooks/hooks.json IS the source harness's tree and uses its placeholder (contract 2)");
  assert.equal(src.hooks.matchers.write.split("|").sort().join("|"), [...src.tools.write_tools].sort().join("|"));
});

test(".mcp.json's placeholders are the manifest's, and it launches this package's bin (MCP ADR decision 6, measured)", () => {
  const src = sourceHarness();
  const reg = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
  const server = reg.mcpServers.projectstore;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.ok(Array.isArray(server.args), "args is an array — the plugin path can contain spaces");
  assert.equal(server.args[0], `${"$"}{${src.runtime.plugin_root_env}}/bin/projectstore.mjs`, "the bin, under the harness's plugin-root variable (runtime, not the hooks surface's placeholder)");
  assert.deepEqual(server.args.slice(1), ["mcp", "--project", `${"$"}{${src.runtime.project_dir_env}}`], "the project comes from the host's variable, expanded per session — never ambient cwd");
  assert.equal(server.env, undefined, "one binding channel: --project, not an env block");
  const mcp = src.surfaces.mcp;
  assert.equal(mcp.kind, "host");
  assert.equal(mcp.launch.evidence, "measured");
  assert.equal(mcp.launch.protocol_era, "initialize");
  assert.deepEqual(mcp.launch.expands_measured, ["args", "env"]);
  assert.ok(mcp.scope_reason.includes("amended 2026-09-05"));
  assert.ok(!mcp.scope_reason.includes("contract 14"), "the install spec's contract 0 classifies surfaces; 14 is upgrade");
});

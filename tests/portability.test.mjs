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
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSpecifiers,
  dynamicSpecifiers,
  opaqueDynamicImports,
  callsFetch,
  closure,
  hookEntries,
  installFamily,
  hiddenByComments,
  networkImports,
  verbModuleSpecifiers,
} from "./fixtures/imports.mjs";
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
  toolPaths,
  lintPatterns,
  harnessForOverlay,
  stopCarrier,
  stopCarrierProblem,
  STOP_CARRIERS,
  preCompactCarrier,
  preCompactCarrierProblem,
  PRECOMPACT_CARRIERS,
  commonBlockFiles,
  blockTargetProblem,
  pinPluginRoot,
} from "../scripts/harness.mjs";
import { WRITE_TOOLS, isWriteTool, layoutPaths } from "../scripts/lib.mjs";
import { modelsProblem } from "../scripts/models.mjs";
import { checkCodexAdapter, renderCodexAdapter } from "../scripts/build-adapters.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = () => [...loadHarnesses(MANIFEST_DIR).values()];
// scripts/ and bin/, as repo-relative paths: the bin is outside scripts/ but
// under the same rule.
const scriptFiles = () => [
  ...readdirSync(join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .map((f) => `scripts/${f}`),
  ...readdirSync(join(ROOT, "bin"))
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .map((f) => `bin/${f}`),
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
  const names = readdirSync(MANIFEST_DIR)
    .filter((n) => n.endsWith(".json"))
    .sort();
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
    // registration_defer_env (the setup story, rule 15): the variables that
    // defer this harness's registration and the shell fetch, and nothing
    // else. Present on every manifest, an array of names, with its reason —
    // an empty list is a decision on the record, as project_dir_env's null is.
    assert.ok(
      Array.isArray(m.runtime.registration_defer_env),
      `${n}: runtime.registration_defer_env must be present, an array`,
    );
    for (const k of m.runtime.registration_defer_env)
      assert.ok(
        typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k),
        `${n}: runtime.registration_defer_env names an environment variable: ${JSON.stringify(k)}`,
      );
    assert.ok(
      typeof m.runtime.registration_defer_env_reason === "string" && m.runtime.registration_defer_env_reason.length > 0,
      `${n}: runtime.registration_defer_env_reason`,
    );
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
      assert.ok(
        ["name", "token"].includes(p.class),
        `${n}: lint pattern ${p.pattern} declares its case class (contract 7)`,
      );
    }
    for (const [ev, ch] of Object.entries(m.output_channels)) {
      if (ev.startsWith("_")) continue;
      if (ch === null) continue; // unmeasured: the slot exists, the value does not
      assert.ok(Array.isArray(ch.fields), `${n}: output_channels.${ev}.fields`);
      assert.ok(["measured", "documented"].includes(ch.evidence), `${n}: output_channels.${ev}.evidence`);
      if ("input_fields" in ch)
        assert.ok(
          Array.isArray(ch.input_fields) && ch.input_fields.every((k) => typeof k === "string"),
          `${n}: output_channels.${ev}.input_fields is a list of stdin keys`,
        );
    }
    assert.equal(stopCarrierProblem(m), null, `${n}: its Stop carrier is one its row supports (contract 17)`);
    assert.equal(
      preCompactCarrierProblem(m),
      null,
      `${n}: its PreCompact carrier sits on a measured row (contract 17)`,
    );
    for (const [kind, s] of Object.entries(m.surfaces || {})) {
      if (kind.startsWith("_")) continue;
      assert.equal(typeof s.supported, "boolean", `${n}: surfaces.${kind}.supported`);
      assert.ok(
        typeof s.scope === "string" && typeof s.scope_reason === "string" && s.scope_reason.length > 0,
        `${n}: surfaces.${kind}.scope and scope_reason`,
      );
      assert.ok(
        ["exclusive", "shared", "host", "registration"].includes(s.kind),
        `${n}: surfaces.${kind}.kind (install spec contract 0, amended 2026-09-05)`,
      );
      if (s.kind === "registration") {
        for (const f of ["marketplace_name", "plugin_name", "plugin_subdir", "manifest", "provenance_key", "condition"])
          assert.equal(typeof s[f], "string", `${n}: surfaces.${kind}.${f}`);
        assert.ok(Array.isArray(s.dir) && s.dir.length, `${n}: surfaces.${kind}.dir`);
        assert.ok(
          s.cli && typeof s.cli.bin === "string" && s.cli.commands && typeof s.cli.verified?.date === "string",
          `${n}: surfaces.${kind}.cli with a measured date`,
        );
        if (s.format === "host-plugin-registration") {
          assert.ok(s.registry && typeof s.registry.enabled_pointer === "string", `${n}: surfaces.${kind}.registry`);
          for (const c of [
            "validate",
            "marketplace_add",
            "marketplace_update",
            "marketplace_remove",
            "install",
            "update",
            "uninstall",
            "disable",
            "enable",
          ])
            assert.ok(Array.isArray(s.cli.commands[c]), `${n}: cli.commands.${c}`);
        } else {
          assert.equal(s.format, "portable-plugin-registration");
          assert.equal(s.ownership, "global");
          assert.equal(s.registry?.format, "toml");
          assert.equal(typeof s.ownership_manifest, "string");
          for (const c of s.cli.required || [])
            assert.ok(
              Array.isArray(s.cli.commands[c]) && s.cli.commands[c].length > 0,
              `${n}: required cli.commands.${c}`,
            );
          for (const c of s.cli.optional || []) {
            const command = s.cli.commands[c];
            assert.ok(
              (Array.isArray(command) && command.length > 0) || typeof s.cli.fallbacks?.[c] === "string",
              `${n}: optional ${c} has a command or declared fallback`,
            );
          }
          for (const [c, argv] of Object.entries(s.cli.commands))
            assert.ok(Array.isArray(argv) && argv.length > 0, `${n}: ${c} never uses empty argv`);
        }
      }
      if (s.kind === "shared")
        assert.ok(s.marker && typeof s.marker === "object", `${n}: surfaces.${kind}.marker (install spec contract 6)`);
      // The agents block is the one surface a project shares between harnesses,
      // so its list has to say which file this harness reads BY ITSELF as well
      // as where the block prefers to live. Conflating the two made a harness
      // install a block into a file it can only reach through a bridge, and
      // then not build the bridge.
      if (kind === "agents_block") {
        assert.ok(Array.isArray(s.files) && s.files.length > 0, `${n}: surfaces.agents_block.files`);
        assert.ok(
          typeof s.reads_natively === "string" && s.reads_natively.length > 0,
          `${n}: surfaces.agents_block.reads_natively — which file this harness reads unaided`,
        );
        assert.ok(
          s.files.includes(s.reads_natively),
          `${n}: reads_natively ${s.reads_natively} is not in this surface's own files`,
        );
      }
      if (s.kind !== "host")
        assert.equal(typeof s.format, "string", `${n}: surfaces.${kind}.format keys the installer's handler`);
    }
    assert.ok(Array.isArray(m.rewrites), `${n}: rewrites`);
  }
});

// One run writes the agents block once, to the first file every harness of
// the run names (the story "One run plans the agents block once, and a bare
// uninstall selects every harness the project uses", rule 2). Lists that
// share no file leave a run of every harness with nowhere to write it.
// The model list's block (the ADR "Agent model lists are read from each
// harness's own catalog, declared in its manifest and cached for a day",
// decision 2): checked with the rest of the manifest's shape.
test("generation contract 1: every manifest's agent_translation.models has its shape — kinds, field paths, reasons, https", () => {
  for (const m of manifests()) assert.equal(modelsProblem(m), null, `${m.id}: ${modelsProblem(m)}`);
});

test("one block per run, rule 2: every manifest's agents_block.files share a file; disjoint lists fail, naming them", () => {
  assert.equal(blockTargetProblem(manifests()), null, "the shipped manifests share a block file");
  assert.ok(commonBlockFiles(manifests()).length > 0);
  const dir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  for (const m of manifests()) {
    const own = `${m.id.toUpperCase()}.md`;
    writeFileSync(
      join(dir, `${m.id}.json`),
      JSON.stringify({
        ...m,
        surfaces: { ...m.surfaces, agents_block: { ...m.surfaces.agents_block, files: [own], reads_natively: own } },
      }),
      "utf8",
    );
  }
  try {
    resetManifests();
    const disjoint = [...loadHarnesses(dir).values()];
    assert.equal(disjoint.length, manifests().length);
    const problem = blockTargetProblem(disjoint);
    assert.ok(problem, "disjoint lists are a problem");
    for (const m of disjoint)
      assert.ok(problem.includes(`${m.id} ${JSON.stringify(m.surfaces.agents_block.files)}`), problem);
  } finally {
    resetManifests();
  }
});

test("generation contract 2: exactly one manifest is the source layout, while the measured target emits a committed adapter", () => {
  const src = manifests().filter((m) => m.source_layout);
  assert.equal(src.length, 1);
  const m = src[0];
  assert.equal(m.emit, false);
  assert.equal(m.output_dir, null);
  assert.ok(!("lint" in m), "the source manifest carries no lint block — linting runs over emitted trees only");
  assert.deepEqual(m.rewrites, []);
  assert.equal(sourceHarness().id, m.id);
  const emitting = emittingHarnesses();
  assert.equal(emitting.length, 1);
  assert.equal(emitting[0].source_layout, false);
  assert.equal(emitting[0].output_dir, `adapters/${emitting[0].id}`);
  assert.ok(
    readdirSync(join(ROOT, emitting[0].output_dir)).length > 0,
    "the emitted tree is committed, not only declared",
  );
});

test("generation contract 16: the source harness is verified, so it is not experimental", () => {
  const m = sourceHarness();
  assert.notEqual(m.verified, null);
  assert.equal(
    m.output_channels.PreCompact.fields.length,
    0,
    "PreCompact has no model-facing hookSpecificOutput channel — measured negatively",
  );
  assert.equal(m.output_channels.Stop.evidence, "measured");
});

// The Stop carrier is our choice from what a row honours (contract 17, as
// amended 2026-10-15): context needs additionalContext among the fields, a
// block needs the block decision, and only a measured row may carry one.
test("generation contract 17: Stop's carrier is one its row supports, and each refusal names why", () => {
  const src = sourceHarness();
  assert.equal(src.output_channels.Stop.carrier, "additionalContext", "the source harness's reminder stays context");
  const block = manifests().find((m) => m.output_channels?.Stop?.carrier === "block");
  assert.ok(block, "a harness whose Stop honours only a block decision carries the block");
  assert.deepEqual(block.output_channels.Stop.fields, [], "a block carrier's row honours no Stop context");
  assert.equal(block.output_channels.Stop.decision, "block");
  assert.ok(Array.isArray(block.output_channels.Stop.input_fields), "its measured stdin keys live in input_fields");

  const withStop = (row) => ({ output_channels: { Stop: row } });
  const measured = { fields: ["additionalContext"], decision: "block", evidence: "measured" };
  assert.equal(stopCarrierProblem(withStop(null)), null, "an unmeasured slot is no problem");
  assert.equal(stopCarrierProblem({}), null);
  const refusals = [
    [{ ...measured }, /no carrier/],
    [{ ...measured, carrier: "continue" }, /is not one of/],
    [{ ...measured, fields: [], carrier: "additionalContext" }, /do not honour it/],
    [{ ...measured, decision: null, carrier: "block" }, /decision is not "block"/],
    [{ ...measured, decision: "permissionDecision", carrier: null }, /is not null or "block"/],
    [{ ...measured, evidence: "documented", carrier: "block" }, /not measured/],
  ];
  for (const [row, why] of refusals) assert.match(stopCarrierProblem(withStop(row)) || "", why, JSON.stringify(row));
  for (const carrier of [...STOP_CARRIERS, null])
    assert.equal(stopCarrierProblem(withStop({ ...measured, carrier })), null, `${carrier} on a row that supports it`);
});

// The PreCompact carrier is how hooks/pre-compact.mjs prints its line (contract
// 17, as amended 2026-10-28): plain stdout where that is measured, the
// {"systemMessage"} object everywhere else.
test("generation contract 17 (amended 2026-10-28): PreCompact's carrier sits only on a measured row", () => {
  const stdout = manifests().find((m) => m.output_channels?.PreCompact?.carrier === "stdout");
  assert.ok(stdout, "a harness whose host echoes PreCompact's stdout carries it");
  assert.equal(stdout.output_channels.PreCompact.evidence, "measured");
  assert.equal(stdout.output_channels.PreCompact.system_message, false, "the field it does not use is discarded");
  for (const m of manifests())
    if (m.output_channels?.PreCompact)
      assert.ok("carrier" in m.output_channels.PreCompact, `${m.id}: the key is present, null when unmeasured`);

  const withRow = (row) => ({ output_channels: { PreCompact: row } });
  const measured = { fields: [], decision: null, evidence: "measured" };
  assert.equal(preCompactCarrierProblem(withRow(null)), null, "an unmeasured slot is no problem");
  assert.equal(preCompactCarrierProblem({}), null);
  const refusals = [
    [{ ...measured }, /no carrier/],
    [{ ...measured, carrier: "systemMessage" }, /is not one of/],
    [{ ...measured, carrier: "stderr" }, /is not one of/],
    [{ ...measured, evidence: "documented", carrier: "stdout" }, /not measured/],
  ];
  for (const [row, why] of refusals)
    assert.match(preCompactCarrierProblem(withRow(row)) || "", why, JSON.stringify(row));
  assert.match(preCompactCarrierProblem(withRow("stdout")) || "", /not an object/);
  for (const carrier of [...PRECOMPACT_CARRIERS, null])
    assert.equal(preCompactCarrierProblem(withRow({ ...measured, carrier })), null, `${carrier} on a measured row`);
  assert.equal(preCompactCarrierProblem(withRow({ ...measured, evidence: "documented", carrier: null })), null);
});

test("Codex adapter: every command, role and passive skill is rendered deterministically under the projectstore namespace", () => {
  const rendered = renderCodexAdapter();
  const skillPaths = [...rendered.keys()].filter((p) => p.endsWith("/SKILL.md"));
  const commandCount = readdirSync(join(ROOT, "commands")).filter((n) => n.endsWith(".md")).length;
  const roleCount = readdirSync(join(ROOT, "agents")).filter((n) => n.endsWith(".md")).length;
  const passiveCount = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.startsWith("projectstore-"),
  ).length;
  assert.equal(skillPaths.length, commandCount + roleCount + passiveCount);
  assert.ok(skillPaths.every((p) => /^skills\/projectstore-[^/]+\/SKILL\.md$/.test(p)));
  for (const path of skillPaths) {
    assert.doesNotMatch(
      rendered.get(path),
      /\$ARGUMENTS|\/projectstore:/,
      `${path}: host-substituted source command vocabulary must not survive rendering`,
    );
    assert.match(
      rendered.get(path),
      /export `PROJECTSTORE_CORE_ROOT`.*own shell statement/s,
      `${path}: runtime setup must forbid the shell-scoping trap seen in a fresh Codex session`,
    );
  }
  for (const path of skillPaths.filter((p) =>
    /projectstore-(?:critic|planner|reviewer|clerk|librarian|archaeologist)/.test(p),
  )) {
    assert.doesNotMatch(
      rendered.get(path).split("---")[1],
      /\b(?:Opus|Sonnet)\b|[a-z]+-effort/,
      `${path}: source-harness model branding must not leak into Codex discovery text`,
    );
  }
  const hooks = JSON.parse(rendered.get("hooks/hooks.json"));
  assert.ok(
    hooks.hooks.SessionStart[0].hooks.every((h) =>
      h.command.startsWith('node "${PLUGIN_ROOT}/node_modules/projectstore/'),
    ),
  );
  assert.deepEqual(checkCodexAdapter(), { ok: true, count: rendered.size, missing: [], unexpected: [], drift: [] });
  assert.deepEqual([...renderCodexAdapter()], [...rendered], "the same source renders byte-identically twice");
});

test("Codex command overrides are capability-aware, not token-rewritten Claude workflows", () => {
  const rendered = renderCodexAdapter();
  const get = (name) => rendered.get(`skills/projectstore-${name}/SKILL.md`);
  const joined = [...rendered.values()].join("\n");
  assert.doesNotMatch(
    joined,
    /CLAUDE_CODE_|\/reload-plugins\b|\/plugin(?:\s|\b)|harness\/codex-code\.json|\b(?:opus|sonnet|fable)\b/i,
  );
  // The effort ADR, decision 8: the Codex agents skill writes models and
  // efforts through configure --set, and its roles pass the effort Codex takes.
  assert.match(get("agents"), /configure --set agents\.default=<model> --set agents\.default\.effort=<level>/);
  assert.match(get("agents"), /--harness\s+codex --project "\$PWD"/);
  assert.doesNotMatch(get("agents"), /effort is outside this integration/);
  assert.match(get("critic"), /pass it as `reasoning_effort`/);
  assert.match(get("bind"), /Codex has no ProjectStore status-line surface/);
  assert.doesNotMatch(get("bind"), /--surface statusline|statusline\.enabled/);
  assert.match(get("doctor"), /upgrade --harness codex/);
  assert.match(get("statusline"), /not supported by the Codex\s+harness/);
  assert.doesNotMatch(get("statusline"), /projectstore\.mjs[^\n]*--surface statusline|statusline\.enabled\s*=/);
  // The band spec, contract 1: a harness without a band gets a skill that
  // says so and runs nothing.
  assert.match(get("bar"), /not supported by the Codex\s+harness/);
  assert.doesNotMatch(get("bar"), /projectstore\.mjs[^\n]*band (on|off|epic)/);
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
    assert.ok(
      label,
      `docs/harnesses.md has no status row for ${h.id} — a harness a user can install and cannot read about`,
    );
    assert.equal(
      label,
      h.verified === null ? "experimental" : "supported",
      `${h.id}: verified is ${h.verified === null ? "null" : "set"}, so the docs must say ` +
        `${h.verified === null ? "experimental" : "supported"}`,
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
    for (const k of [
      r.project_dir_env,
      r.plugin_root_env,
      r.home_env,
      ...(r.detect_env || []),
      ...(r.agent_overrides || []).map((o) => o.env),
    ]) {
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
  for (const a of ALLOW)
    assert.ok(typeof a.why === "string" && a.why.length > 0, `allow-list entry ${a.file}/${a.phrase} has no why`);
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
  const ids = manifests()
    .map((m) => m.id)
    .filter((id) => id !== sourceHarness().id);
  for (const n of scriptFiles()) {
    const code = stripComments(readFileSync(join(ROOT, n), "utf8"));
    for (const id of ids) {
      assert.ok(
        !new RegExp(`["'\`]${id}["'\`]`).test(code),
        `${n} names the harness "${id}" in code — a manifest value, not a branch`,
      );
    }
  }
});

test("install spec modules: doctor never imports the installer, and the installer names no harness id", () => {
  // Direction: installer → provenance ← doctor. And the installer is keyed by
  // surface format, never by harness id — the source id included, which the
  // branch test above deliberately filters out.
  const doctor = readFileSync(join(ROOT, "scripts", "doctor.mjs"), "utf8");
  // Imports, not mentions: doctor names the verb in its remedies.
  assert.ok(
    !/from "\.\/install-harness\.mjs"|import\("\.\/install-harness\.mjs"\)/.test(doctor),
    "doctor.mjs imports install-harness",
  );
  // provenance.mjs stays out of the SessionStart graph, which imports doctor
  // statically: doctor reaches surfaces.mjs (and through it provenance) only
  // by a dynamic import inside the one check that needs it.
  assert.ok(!doctor.includes("provenance.mjs"), "doctor.mjs imports provenance.mjs");
  assert.ok(!/from "\.\/surfaces\.mjs"/.test(doctor), "doctor.mjs imports surfaces.mjs statically");
  assert.ok(/await import\("\.\/surfaces\.mjs"\)/.test(doctor), "doctor.mjs reaches surfaces.mjs dynamically");
  // The same for its text renderer (the presentation spec, contract 11): the
  // renderer imports term.mjs, which loads readline — never on the hook's path.
  assert.ok(
    !/from "\.\/(doctor-report|term)\.mjs"/.test(doctor),
    "doctor.mjs imports its renderer or term.mjs statically",
  );
  assert.ok(/(?<![\w.])import\("\.\/doctor-report\.mjs"\)/.test(doctor), "doctor.mjs reaches its renderer dynamically");
  const renderer = readFileSync(join(ROOT, "scripts", "doctor-report.mjs"), "utf8");
  assert.deepEqual(
    importSpecifiers(renderer).sort(),
    ["./lib.mjs", "./term.mjs"],
    "the renderer imports term.mjs and lib.mjs only",
  );
  assert.ok(!/\bimport\s*\(/.test(renderer), "and nothing at run time");
  // Walked, not grepped: no module the SessionStart hook loads statically is the renderer or term.mjs.
  const graph = new Set();
  const walk = (file) => {
    if (graph.has(file)) return;
    graph.add(file);
    const src = readFileSync(file, "utf8");
    for (const s of importSpecifiers(src)) if (s.startsWith(".")) walk(resolve(dirname(file), s));
  };
  walk(join(ROOT, "hooks", "session-start.mjs"));
  assert.ok(graph.has(join(ROOT, "scripts", "doctor.mjs")), "the walk reaches doctor.mjs");
  for (const n of ["doctor-report.mjs", "term.mjs"])
    assert.ok(!graph.has(join(ROOT, "scripts", n)), `the SessionStart graph loads ${n}`);
  for (const n of readdirSync(join(ROOT, "hooks")).filter((f) => f.endsWith(".mjs"))) {
    const hook = readFileSync(join(ROOT, "hooks", n), "utf8");
    assert.ok(!hook.includes("surfaces.mjs"), `hooks/${n} pulls surfaces.mjs into the SessionStart graph`);
    assert.ok(
      !hook.includes("cli.mjs"),
      `hooks/${n} pulls the CLI (and through it the installer) into the SessionStart graph`,
    );
    assert.ok(!hook.includes("mcp.mjs"), `hooks/${n} pulls the MCP server into the SessionStart graph`);
    // The shell fetch and its async runner spawn npm: never on a hook's path.
    for (const m of ["fetch-shell.mjs", "run-host.mjs"])
      assert.ok(!hook.includes(m), `hooks/${n} pulls ${m} into the SessionStart graph`);
  }
  // …nor through what the hooks import: only the installer reaches them.
  for (const n of [
    "lib.mjs",
    "harness.mjs",
    "doctor.mjs",
    "surfaces.mjs",
    "provenance.mjs",
    "portable-registration.mjs",
    "touch-session.mjs",
    "statusline.mjs",
  ]) {
    const src = readFileSync(join(ROOT, "scripts", n), "utf8");
    for (const m of ["fetch-shell.mjs", "run-host.mjs"])
      assert.ok(!src.includes(`"./${m}"`), `scripts/${n} imports ${m}`);
  }
  const importers = readdirSync(join(ROOT, "scripts")).filter(
    (n) =>
      n.endsWith(".mjs") &&
      /from "\.\/(fetch-shell|run-host)\.mjs"/.test(readFileSync(join(ROOT, "scripts", n), "utf8")),
  );
  assert.deepEqual(
    importers.sort(),
    ["fetch-shell.mjs", "install-harness.mjs"],
    "the installer imports both; the fetch imports the runner",
  );
  const surfaces = readFileSync(join(ROOT, "scripts", "surfaces.mjs"), "utf8");
  // The banner names the installer as its generator — a string, not an import.
  assert.ok(!/from "\.\/install-harness\.mjs"/.test(surfaces), "surfaces.mjs imports the installer");
  for (const call of [
    "writeFileSync",
    "writeFileAtomic",
    "mkdirSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "appendFileSync",
    "copyFileSync",
    "renameSync",
    "cpSync",
    "writeFile(",
    "createWriteStream",
  ])
    assert.ok(!surfaces.includes(call), `surfaces.mjs writes (${call})`);
  const code = stripComments(readFileSync(join(ROOT, "scripts", "install-harness.mjs"), "utf8"));
  for (const id of manifests().map((m) => m.id)) {
    assert.ok(!new RegExp(`["'\`]${id}["'\`]`).test(code), `install-harness.mjs names the harness "${id}"`);
  }
});

test("generation modules: harness.mjs imports node builtins only — nothing from this repository", () => {
  const src = readFileSync(join(ROOT, "scripts", "harness.mjs"), "utf8");
  const specs = importSpecifiers(src);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:"), `harness.mjs imports ${s}`);
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!src.includes("GENERATED by"), "the banner is provenance.mjs's, not this file's");
});

// The import readers above share one pattern (tests/fixtures/imports.mjs).
// Prettier wraps an import past 120 columns; the pattern still reads it, and
// reads nothing in a string.
test("generation modules: the import reader finds a wrapped import and a re-export, and nothing inside a string", () => {
  const src = [
    'import { a } from "./a.mjs";',
    "import {",
    "  b,",
    "  c,",
    '} from "./b.mjs";',
    'export { d } from "./d.mjs";',
    "const s = 'import { e } from \"./e.mjs\";';",
    'import "./side-effect.mjs";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["./a.mjs", "./b.mjs", "./d.mjs"]);
});

// ─── The hook fence (the story "The MCP server's entry reaches no install
// verb through a read-verb runner that shares the CLI's verb table, and no
// hook reaches a network call", PS-DIRECTORY, decisions 1 and 4) ────────────

// A one-file tree under `parent` whose x.mjs imports `spec`.
function mkNet(parent, spec) {
  const dir = mkdtempSync(join(parent, "net-"));
  writeFileSync(join(dir, "x.mjs"), `import x from "${spec}";\n`);
  return dir;
}

// The closure reader the fences share, on a tree built here: each import class
// is an edge, a comment is not, and an edge it cannot follow fails loud.
test("hook fence: the closure follows static imports, literal import() and verb-table module strings, never a comment", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-closure-"));
  try {
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put(
      "hooks/hooks.json",
      JSON.stringify({
        modules: ["./mod.tsx"],
        hooks: {
          A: [{ hooks: [{ type: "command", command: 'node "${ROOT}/hooks/quoted.mjs"' }] }],
          B: [{ hooks: [{ type: "command", command: "node ${ROOT}/scripts/bare.mjs" }] }],
        },
      }),
    );
    put("hooks/quoted.mjs", 'import { a } from "../scripts/a.mjs";\nimport "../scripts/side.mjs";\n');
    put("scripts/side.mjs", "");
    put("scripts/bare.mjs", "");
    put(
      "hooks/mod.tsx",
      [
        "import { s } from '../scripts/s.mjs'",
        "import type { T } from './types'",
        "import { host } from 'host'",
        'import { d } from "../scripts/d.mjs"',
        "import { request } from 'node:https'",
        "",
      ].join("\n"),
    );
    put("scripts/s.mjs", "");
    put("scripts/d.mjs", "");
    put(
      "scripts/a.mjs",
      [
        '// await import("./commented.mjs");',
        "/* import('./blocked.mjs') */",
        'const run = async () => (await import("./lazy.mjs")).go();',
        'export const TABLE = [{ verb: "x", module: "./row.mjs" }, { verb: "y", module: null }];',
        "export const MORE = [{ verb: 'z', module: './quoted-row.mjs' }];",
      ].join("\n"),
    );
    put("scripts/lazy.mjs", "export const go = () => fetch(url);\n");
    put("scripts/row.mjs", "");
    put("scripts/quoted-row.mjs", 'const net = await import("node:net");\nexport { net };\n');
    assert.deepEqual(hookEntries(root, { placeholder: "${ROOT}" }), [
      "hooks/quoted.mjs",
      "scripts/bare.mjs",
      "hooks/mod.tsx",
    ]);
    assert.deepEqual(dynamicSpecifiers(readFileSync(join(root, "scripts/a.mjs"), "utf8")), ["./lazy.mjs"]);
    assert.deepEqual(closure("hooks/quoted.mjs", { root }), [
      "hooks/quoted.mjs",
      "scripts/a.mjs",
      "scripts/lazy.mjs",
      "scripts/quoted-row.mjs",
      "scripts/row.mjs",
      "scripts/side.mjs",
    ]);
    // Either quote, with or without the `;`.
    assert.deepEqual(closure("hooks/mod.tsx", { root }), ["hooks/mod.tsx", "scripts/d.mjs", "scripts/s.mjs"]);
    // A runner that dispatches another module's table names its own rows.
    assert.deepEqual(closure("hooks/quoted.mjs", { root, dispatch: () => [] }), [
      "hooks/quoted.mjs",
      "scripts/a.mjs",
      "scripts/lazy.mjs",
      "scripts/side.mjs",
    ]);
    assert.deepEqual(verbModuleSpecifiers(readFileSync(join(root, "scripts/a.mjs"), "utf8")), [
      "./row.mjs",
      "./quoted-row.mjs",
    ]);
    // A network module is skipped by the walk and named by networkImports, statically or by import().
    assert.deepEqual(networkImports(closure("hooks/mod.tsx", { root }), { root }), [
      "hooks/mod.tsx imports node:https",
    ]);
    assert.deepEqual(networkImports(closure("hooks/quoted.mjs", { root }), { root }), [
      "scripts/quoted-row.mjs imports node:net",
    ]);
    for (const spec of ["http", "node:http2", "tls", "node:dgram", "undici", "https"])
      assert.deepEqual(networkImports(["x.mjs"], { root: mkNet(root, spec) }), [`x.mjs imports ${spec}`], spec);
    assert.deepEqual(networkImports(["x.mjs"], { root: mkNet(root, "node:path") }), [], "a builtin with no socket");
    assert.ok(callsFetch(readFileSync(join(root, "scripts/lazy.mjs"), "utf8")));
    assert.ok(!callsFetch("// the shell fetch (contract 19)\nconst prefetch = () => 1;"), "a comment is no call");
    for (const code of [
      "const f = globalThis.fetch;",
      "fetch.call(null, u);",
      'globalThis["fetch"](u);',
      "g.fetch(u);",
    ])
      assert.ok(callsFetch(code), code);
    // The blanking is checked: a `//` inside a string hides the rest of its line from every reader.
    const hiding = 'const sep = "a // b"; await import("./hidden.mjs");\n';
    assert.equal(hiddenByComments(hiding), 1);
    assert.equal(
      hiddenByComments('// import("./x.mjs")\n * fetch(u)\nconst a = 1;\n'),
      0,
      "comment lines are not code",
    );
    put("scripts/hides.mjs", hiding);
    assert.throws(() => closure("scripts/hides.mjs", { root }), /comment stripping hid code in scripts\/hides\.mjs/);
    put("scripts/bare.mjs", 'export * from "./gone.mjs";\nimport { g } from "./gone.mjs";\n');
    assert.throws(() => closure("scripts/bare.mjs", { root }), /scripts\/gone\.mjs is imported but does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Which rows of the verb table each module dispatches through (decision 1's
// third class), now that the table is data in verbs.mjs: verbs.mjs holds it
// and runs none of it, the read runner serves its READ_HANDLERS' rows, and
// cli.mjs serves every row. Any other module counts the module strings in its
// own code, the default. On 0.30.5 cli.mjs held the table and its runner in
// one file, which this reads the same way.
const READ_RUNNER = await import("../scripts/read-verbs.mjs").catch(() => null);
const { VERBS: TABLE } = await import("../scripts/cli.mjs");
const rowModules = (rows) => rows.map((v) => v.module).filter(Boolean);
function tableDispatch(rel, src) {
  if (rel === "scripts/verbs.mjs") return [];
  if (rel === "scripts/read-verbs.mjs")
    return rowModules(TABLE.filter((v) => Object.hasOwn(READ_RUNNER?.READ_HANDLERS ?? {}, v.verb)));
  if (rel === "scripts/cli.mjs") return rowModules(TABLE);
  return verbModuleSpecifiers(src);
}

// What a fence refuses in a closure: a module that calls fetch, models.mjs
// (which starts a harness's catalog command; it held the keyed fetch until the
// 0.30.7 story, PS-DIRECTORY, so the fetch class alone no longer catches it),
// one of the install family, an import() the walk cannot read (a hole in the
// fence), and a network module among the specifiers the walk skips.
function fenceBreaches(entry, { dispatch = tableDispatch } = {}) {
  const files = closure(entry, { root: ROOT, dispatch });
  const family = installFamily(ROOT);
  const src = (f) => readFileSync(join(ROOT, f), "utf8");
  return {
    files,
    fetch: files.filter((f) => callsFetch(src(f))),
    models: files.filter((f) => f === "scripts/models.mjs"),
    family: files.filter((f) => family.includes(f)),
    opaque: files.filter((f) => opaqueDynamicImports(src(f)) > 0),
    network: networkImports(files, { root: ROOT }),
  };
}
const assertFenced = (entry, why) => {
  const b = fenceBreaches(entry);
  assert.deepEqual(b.family, [], `${entry} reaches the install family`);
  assert.deepEqual(b.fetch, [], `${entry} reaches a module that calls fetch — ${why} would load network code`);
  assert.deepEqual(b.models, [], `${entry} reaches models.mjs — ${why} could start a catalog command`);
  assert.deepEqual(b.opaque, [], `${entry} reaches an import() whose target is not a literal`);
  assert.deepEqual(b.network, [], `${entry} reaches a network module`);
  return b.files;
};

// The disclosure story's "nothing is sent anywhere by a hook", true by
// construction: no module a hook can load holds a fetch call, and none is the
// installer or what it spawns (npm install, the host CLI, the release fetch).
// The classes are decision 1's, because a fence over static imports alone
// passed on 0.30.5, where SessionStart reached models.mjs's keyed fetch through
// doctor.mjs. A spawn is not an import: doctor launches kanban, codemap and
// graph through the bin's node, each a reader whose own closure is fenced too.
test("hook fence: no hook's closure holds a module that calls fetch, or the install family", () => {
  const entries = hookEntries(ROOT, { placeholder: sourceHarness().hooks.root_placeholder });
  for (const f of ["hooks/session-start.mjs", "scripts/touch-session.mjs", "hooks/band.tsx"])
    assert.ok(entries.includes(f), `the entries read from hooks/hooks.json include ${f}`);
  const family = installFamily(ROOT);
  assert.ok(family.includes("scripts/install-harness.mjs") && family.includes("scripts/fetch-shell.mjs"));
  for (const entry of entries) assertFenced(entry, "a hook");
  // Not vacuous: SessionStart's walk goes through doctor and its import()s,
  // and the band module's through its shared reader.
  const start = closure("hooks/session-start.mjs", { root: ROOT });
  for (const f of ["scripts/doctor.mjs", "scripts/surfaces.mjs", "scripts/model-spec.mjs"])
    assert.ok(start.includes(f), `the SessionStart closure reaches ${f}`);
  assert.ok(!start.includes("scripts/models.mjs"), "the SessionStart closure reaches models.mjs");
  assert.ok(closure("hooks/band.tsx", { root: ROOT }).includes("scripts/band-shared.mjs"), "band.tsx's walk");
  assert.deepEqual(closure("scripts/model-spec.mjs", { root: ROOT }), ["scripts/model-spec.mjs"]);
  // doctor's own spawns, through process.execPath: each target's closure is fenced as a hook's.
  const doctor = readFileSync(join(ROOT, "scripts", "doctor.mjs"), "utf8");
  const spawned = [
    ...doctor.matchAll(/spawnSync\(process\.execPath, \[join\(pluginRoot\(\), "scripts", "([\w-]+\.mjs)"\)/g),
  ].map((m) => `scripts/${m[1]}`);
  assert.deepEqual(spawned.sort(), ["scripts/codemap.mjs", "scripts/graph.mjs", "scripts/kanban.mjs"]);
  for (const target of spawned) assertFenced(target, "a script doctor spawns");
  // A positive control for the models class: configure's closure, which the
  // fence never covers, does reach it.
  assert.deepEqual(
    fenceBreaches("scripts/configure.mjs").models,
    ["scripts/models.mjs"],
    "configure reaches models.mjs",
  );
});

// ─── The MCP fence (the same story, decisions 1 to 3) ──────────────────

// The entry .mcp.json launches, as a root-relative path.
function mcpEntry() {
  const server = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers.projectstore;
  const lead = `${"$"}{${sourceHarness().runtime.plugin_root_env}}/`;
  assert.ok(server.args[0].startsWith(lead), `.mcp.json runs a file under ${lead}`);
  return server.args[0].slice(lead.length);
}

// The server's code reaches no install verb: its entry's closure, with
// decision 1's classes, holds none of the install family, no fetch, no
// unreadable import() and no network module. On 0.30.5 .mcp.json ran the bin,
// whose closure of 32 modules held all five install modules through cli.mjs's
// import() calls and its VERBS rows.
test("MCP fence: the entry .mcp.json launches reaches no install module, no fetch and no unreadable import()", () => {
  const entry = mcpEntry();
  const files = assertFenced(entry, "the MCP server");
  assert.equal(entry, sourceHarness().surfaces.mcp.entry, "the manifest names the entry .mcp.json runs");
  assert.ok(!entry.startsWith("bin/"), "the entry is not in bin/, which is on the host's Bash PATH");
  // Not vacuous: the walk goes through the server, the runner, the table and
  // the query and doctor-report modules the read verbs call.
  for (const f of [
    "scripts/mcp.mjs",
    "scripts/read-verbs.mjs",
    "scripts/verbs.mjs",
    "scripts/query.mjs",
    "scripts/doctor-report.mjs",
  ])
    assert.ok(files.includes(f), `the MCP entry's closure reaches ${f}`);
  assert.ok(!files.includes("scripts/cli.mjs"), "the MCP entry's closure reaches cli.mjs");
  // The doctor tool spawns doctor.mjs, a spawn and not an import: its closure is fenced on its own.
  assertFenced("scripts/doctor.mjs", "the doctor the MCP server spawns");
  // A positive control (the E2b review): the exemption of verbs.mjs is what
  // keeps the install modules out. The table does name them, and read under
  // the default dispatch the same entry reaches the whole family.
  assert.ok(READ_RUNNER, "the read runner loads");
  assert.ok(
    verbModuleSpecifiers(readFileSync(join(ROOT, "scripts/verbs.mjs"), "utf8")).includes("./install-harness.mjs"),
    "the one table names the installer's module",
  );
  const naive = closure(entry, { root: ROOT });
  for (const f of installFamily(ROOT)) assert.ok(naive.includes(f), `read naively, the entry reaches ${f}`);
});

// One verb table: verbs.mjs holds it, as data, with the envelope and the
// version, and loads nothing at run time; cli.mjs re-exports the same
// objects; the read runner dispatches through that table with its handlers
// alone; neither the runner nor mcp.mjs imports cli.mjs.
test("MCP fence: one verb table — the CLI and the read runner dispatch the same export, and neither the runner nor mcp.mjs imports cli.mjs", async () => {
  assert.ok(READ_RUNNER, "scripts/read-verbs.mjs, the read-verb runner, loads");
  const verbs = await import("../scripts/verbs.mjs");
  const cli = await import("../scripts/cli.mjs");
  const mcp = await import("../scripts/mcp.mjs");
  for (const n of ["VERBS", "envelope", "packageVersion", "PLANNED_VERBS", "usage", "verbHelp", "nearest"])
    assert.equal(cli[n], verbs[n], `cli.mjs's ${n} is verbs.mjs's`);
  const src = (f) => readFileSync(join(ROOT, "scripts", f), "utf8");
  assert.ok(!/\bimport\s*\(/.test(src("verbs.mjs")), "verbs.mjs loads no module at run time, nor names one");
  for (const f of ["cli.mjs", "read-verbs.mjs", "mcp.mjs"])
    assert.deepEqual(verbModuleSpecifiers(src(f)), [], `${f} declares no verb table of its own`);
  for (const f of ["read-verbs.mjs", "mcp.mjs", "mcp-server.mjs"]) {
    assert.ok(!importSpecifiers(src(f)).includes("./cli.mjs"), `${f} imports cli.mjs`);
    assert.deepEqual(
      dynamicSpecifiers(src(f)).filter((s) => s.endsWith("/cli.mjs") || s === "./cli.mjs"),
      [],
      f,
    );
  }
  for (const f of ["read-verbs.mjs", "mcp.mjs", "cli.mjs"])
    assert.ok(importSpecifiers(src(f)).includes("./verbs.mjs"), `${f} imports the table from verbs.mjs`);
  assert.ok(importSpecifiers(src("mcp.mjs")).includes("./read-verbs.mjs"), "mcp.mjs runs the read runner");
  // Every row is served by the CLI; the read runner's are rows of the same table, none of them a write.
  assert.deepEqual(Object.keys(cli.HANDLERS).sort(), verbs.VERBS.map((v) => v.verb).sort());
  const reads = Object.keys(READ_RUNNER.READ_HANDLERS);
  for (const v of reads) {
    const row = verbs.VERBS.find((r) => r.verb === v);
    assert.ok(row && row.writes === false, `${v} is a row of the table that writes nothing`);
    assert.equal(cli.HANDLERS[v], READ_RUNNER.READ_HANDLERS[v], `the CLI runs the read runner's ${v}`);
  }
  // Every MCP tool's verb is a read row, whose module is outside the install family.
  const family = installFamily(ROOT);
  for (const [name, t] of Object.entries(mcp.TOOLS)) {
    assert.ok(reads.includes(t.verb), `tool ${name}'s verb ${t.verb} is served by the read runner`);
    const row = verbs.VERBS.find((r) => r.verb === t.verb);
    assert.ok(!family.includes(`scripts/${String(row.module).replace(/^\.\//, "")}`), `${t.verb} wraps ${row.module}`);
  }
  // The runner reads the whole table: its help is the CLI's, and a write verb
  // is a verb it knows and does not serve — never an unknown one.
  const sink = () => ({
    text: "",
    isTTY: false,
    write(s) {
      this.text += s;
      return true;
    },
  });
  const io = () => ({ env: {}, cwd: tmpdir(), stdin: null, stdout: sink(), stderr: sink() });
  const a = io(),
    b = io(),
    w = io();
  try {
    assert.equal(await READ_RUNNER.runRead(["--help"], a), 0);
    assert.equal(await cli.run(["--help"], b), 0);
    assert.equal(await READ_RUNNER.runRead(["install", "--json"], w), 2);
  } finally {
    // dispatch pins the plugin root to this package; the resolver tests here read it unpinned.
    pinPluginRoot(null);
  }
  assert.equal(a.stdout.text, b.stdout.text, "one table, one help");
  const env = JSON.parse(w.stdout.text);
  assert.equal(env.verb, "install");
  assert.equal(env.ok, false);
  assert.match(env.result.error, /^install is not served here/);
  assert.doesNotMatch(w.stderr.text, /unknown verb/);
});

// ─── The resolvers lib.mjs re-exports ──────────────────────────────────

test("generation contract 2: WRITE_TOOLS comes from the source manifest, and the fallback matches it", () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), [...sourceHarness().tools.write_tools].sort());
  assert.deepEqual(
    [...SOURCE_WRITE_TOOLS_FALLBACK].sort(),
    [...sourceHarness().tools.write_tools].sort(),
    "a missing manifest must not silently empty the write family — the fallback is pinned to the manifest",
  );
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
  assert.equal(
    configPath("/tmp/p roj", env),
    layoutPaths("/tmp/p roj").binding,
    "the binding is harness-neutral (layout ADR, 2026-09-06); the legacy file is read only when it exists",
  );
  assert.equal(pluginRoot({}), ROOT, "no variable set: the repository root, resolved through fileURLToPath");
  assert.deepEqual(runtimeEnvNames(env), {
    projectDir: r.project_dir_env,
    pluginRoot: r.plugin_root_env,
    home: r.home_env,
  });
  const child = childEnv({ A: "1" }, { projectRoot: "/tmp/x" });
  assert.equal(child[r.project_dir_env], "/tmp/x");
  assert.equal(child.A, "1");
  assert.equal(detectHarnessId({}), src.id, "nothing set: the source harness, never null");
  assert.equal(detectHarnessId({ PROJECTSTORE_HARNESS: src.id }), src.id);
  assert.equal(
    detectHarnessId({ PROJECTSTORE_HARNESS: "no-such-harness" }),
    src.id,
    "an unknown forced id falls through",
  );
  resetDetection();
});

// A host's plugin-root variable names the PLUGIN root. In a shell that is a
// directory containing the core, not the core, and taking it as the core is how
// the first Codex install lost its layouts (review 2026-10-03, F2). So a root
// that contains this core resolves to the core; a root equal to it or unrelated
// to it is returned as named, which keeps the source layout byte-for-byte as
// it was. The comparison is on real paths: the module's own location is
// already real, so a shell reached through a symlink must still count.
test("harness resolvers: a plugin root that contains this core is a shell, and the core answers from its own location", () => {
  for (const m of loadHarnesses().values()) {
    const k = m.runtime?.plugin_root_env;
    if (!k) continue;
    assert.equal(
      pluginRoot({ [k]: dirname(ROOT) }),
      ROOT,
      `${m.id}: a root containing the core is a shell — the core resolves from itself`,
    );
    assert.equal(pluginRoot({ [k]: dirname(ROOT) + "/" }), ROOT, `${m.id}: with a trailing separator too`);
    assert.equal(pluginRoot({ [k]: ROOT }), ROOT, `${m.id}: the core named exactly is the source layout`);
    assert.equal(
      pluginRoot({ [k]: "/tmp/plug in" }),
      "/tmp/plug in",
      `${m.id}: an unrelated root is honoured as named`,
    );
    assert.equal(
      pluginRoot({ [k]: ROOT + "-sibling" }),
      ROOT + "-sibling",
      `${m.id}: a sibling sharing the core's prefix is not its parent`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "ps-shell-link-"));
  symlinkSync(dirname(ROOT), join(dir, "shell"));
  assert.equal(
    pluginRoot({ [sourceHarness().runtime.plugin_root_env]: join(dir, "shell") }),
    ROOT,
    "a shell reached through a symlink still contains the core",
  );
  rmSync(dir, { recursive: true, force: true });
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
  const files = [
    ...new Set(
      Object.values(reg.hooks).flatMap((entries) =>
        entries.flatMap((e) =>
          // Unquoted first: every command quotes its plugin root, and the
          // closing quote would otherwise end the path.
          (e.hooks || []).map((h) => (h.command || "").replaceAll('"', "").split(`${placeholder}/`).pop().trim()),
        ),
      ),
    ),
  ].filter((f) => f.endsWith(".mjs"));
  assert.equal(files.length, 5, `expected every registered hook script, got ${JSON.stringify(files)}`);

  const offenders = files.filter((rel) => !/\badoptHookInput\s*\(/.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(
    offenders,
    [],
    "a hook that never calls adoptHookInput resolves its project from whatever directory " +
      "the process started in — silently, on any harness that exports no project-dir variable",
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
    id: "codex",
    display_name: "Codex",
    emit: false,
    source_layout: false,
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
    resetManifests();
    resetDetection();
    assert.equal(
      detectHarnessId(MEASURED_CODEX_HOOK_ENV, dir),
      "codex",
      "a Codex hook environment must detect as codex, not as the harness whose " +
        "plugin-root name Codex also sets for compatibility",
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
        detectHarnessId({ CLAUDE_PLUGIN_ROOT: "/x" }, dir),
        "claude-code",
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
        detectHarnessId({}, dir),
        "claude-code",
        "KNOWN LIMIT: with no environment evidence and both harness directories " +
          "present, the project probe answers in manifest filename order",
      );
    } finally {
      process.chdir(cwd);
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetManifests();
    resetDetection();
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
    resetManifests();
    resetDetection();
    assert.equal(
      detectHarnessId({ PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p" }, MANIFEST_DIR),
      "codex",
      "the two plugin-root names alone, which is all the demotion has to work with: " +
        "without runtime.shared_env this answers claude-code, on the shipped files",
    );
    resetDetection();
    assert.equal(
      detectHarnessId(MEASURED_CODEX_HOOK_ENV, MANIFEST_DIR),
      "codex",
      "and the full captured environment agrees",
    );
  } finally {
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
    resetManifests();
    resetDetection();
  }
});

// The Stop hook prints by the carrier of the harness that IDENTIFIES itself,
// never by detection's fallbacks (entry spec, contract 14, as amended
// 2026-10-15): a wrong shape is a refused hook that still spends the reminder.
test("entry contract 14 (amended 2026-10-15): the Stop carrier is the identified harness's, else none", () => {
  resetManifests();
  resetDetection();
  const src = sourceHarness();
  const block = manifests().find((m) => m.output_channels?.Stop?.carrier === "block");
  assert.ok(block);
  assert.equal(stopCarrier(MEASURED_CODEX_HOOK_ENV, MANIFEST_DIR), "block", "the measured Codex hook environment");
  assert.equal(stopCarrier({ [block.runtime.plugin_root_env]: "/p" }, MANIFEST_DIR), "block", "its plugin root alone");
  assert.equal(
    stopCarrier({ [src.runtime.project_dir_env]: "/p", [src.runtime.plugin_root_env]: "/p" }, MANIFEST_DIR),
    "additionalContext",
    "a source-harness hook",
  );
  assert.equal(stopCarrier({}, MANIFEST_DIR), null, "nothing identifies: silent");
  for (const k of block.runtime.shared_env || [])
    assert.equal(stopCarrier({ [k]: "/p" }, MANIFEST_DIR), null, `${k} alone is shared, so weak: silent`);
  assert.equal(stopCarrier({ [block.runtime.home_env]: "/h" }, MANIFEST_DIR), null, "a home variable is weak: silent");
  for (const m of manifests())
    assert.equal(stopCarrier({ PROJECTSTORE_HARNESS: m.id }, MANIFEST_DIR), m.output_channels?.Stop?.carrier ?? null);
  assert.equal(stopCarrier({ PROJECTSTORE_IDENTIFIED: "" }, MANIFEST_DIR), null, "a parent that decided nothing");

  // A harness with no measured carrier, or one the hook does not know, is silence.
  const dir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  for (const m of manifests()) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m), "utf8");
  const third = (id, Stop) => ({
    ...src,
    id,
    display_name: id,
    emit: false,
    source_layout: false,
    output_channels: { Stop },
  });
  writeFileSync(join(dir, "zz-none.json"), JSON.stringify(third("zz-none", null)), "utf8");
  writeFileSync(
    join(dir, "zz-null.json"),
    JSON.stringify(third("zz-null", { fields: [], decision: null, carrier: null, evidence: "measured" })),
    "utf8",
  );
  writeFileSync(
    join(dir, "zz-odd.json"),
    JSON.stringify(third("zz-odd", { fields: [], decision: "block", carrier: "systemMessage", evidence: "measured" })),
    "utf8",
  );
  try {
    resetManifests();
    for (const id of ["zz-none", "zz-null", "zz-odd"])
      assert.equal(stopCarrier({ PROJECTSTORE_HARNESS: id }, dir), null, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetManifests();
    resetDetection();
  }
});

// The same identified-only rule for PreCompact (skeleton spec, contract 22, as
// amended 2026-10-28): a plain line on a host that refuses one is a failed hook,
// so anything short of a harness identifying itself keeps today's object.
test("skeleton contract 22 (amended 2026-10-28): the PreCompact carrier is the identified harness's, else none", () => {
  resetManifests();
  resetDetection();
  const stdout = manifests().find((m) => m.output_channels?.PreCompact?.carrier === "stdout");
  const unmeasured = manifests().find(
    (m) => m.output_channels?.PreCompact && m.output_channels.PreCompact.carrier === null && m.runtime?.plugin_root_env,
  );
  assert.ok(stdout && unmeasured);
  assert.equal(
    preCompactCarrier({ [stdout.runtime.project_dir_env]: "/p", [stdout.runtime.plugin_root_env]: "/p" }, MANIFEST_DIR),
    "stdout",
    "its hook environment",
  );
  assert.equal(
    preCompactCarrier({ [stdout.runtime.project_dir_env]: "/p" }, MANIFEST_DIR),
    "stdout",
    "its project dir",
  );
  for (const k of stdout.runtime.session_env || [])
    assert.equal(preCompactCarrier({ [k]: "x" }, MANIFEST_DIR), "stdout", `its session marker ${k}`);
  assert.equal(preCompactCarrier(MEASURED_CODEX_HOOK_ENV, MANIFEST_DIR), null, "the measured Codex hook environment");
  assert.equal(preCompactCarrier({ [unmeasured.runtime.plugin_root_env]: "/p" }, MANIFEST_DIR), null);
  assert.equal(preCompactCarrier({}, MANIFEST_DIR), null, "nothing identifies: the object");
  for (const k of unmeasured.runtime.shared_env || [])
    assert.equal(preCompactCarrier({ [k]: "/p" }, MANIFEST_DIR), null, `${k} alone is shared, so weak`);
  for (const m of manifests())
    assert.equal(
      preCompactCarrier({ PROJECTSTORE_HARNESS: m.id }, MANIFEST_DIR),
      m.output_channels?.PreCompact?.carrier ?? null,
    );
  assert.equal(preCompactCarrier({ PROJECTSTORE_IDENTIFIED: "" }, MANIFEST_DIR), null, "a parent that decided nothing");

  const dir = mkdtempSync(join(tmpdir(), "ps-manifests-"));
  for (const m of manifests()) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m), "utf8");
  const third = (id, PreCompact) => ({
    ...sourceHarness(),
    id,
    display_name: id,
    emit: false,
    source_layout: false,
    output_channels: { PreCompact },
  });
  const row = { fields: [], decision: null, evidence: "measured" };
  writeFileSync(join(dir, "zz-none.json"), JSON.stringify(third("zz-none", null)), "utf8");
  writeFileSync(join(dir, "zz-null.json"), JSON.stringify(third("zz-null", { ...row, carrier: null })), "utf8");
  writeFileSync(
    join(dir, "zz-odd.json"),
    JSON.stringify(third("zz-odd", { ...row, carrier: "systemMessage" })),
    "utf8",
  );
  try {
    resetManifests();
    for (const id of ["zz-none", "zz-null", "zz-odd"])
      assert.equal(preCompactCarrier({ PROJECTSTORE_HARNESS: id }, dir), null, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetManifests();
    resetDetection();
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
      `${m.id}: every strong variable it declares is listed in some manifest's shared_env, ` +
        "so nothing can identify it strongly — detection would fall back to weak signals " +
        "and then to filename order",
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
      const foreign = manifests()
        .filter((o) => o.id !== m.id)
        .map((o) => o.agent_translation?.cheap_model);
      assert.ok(
        !foreign.includes(cheap),
        `${m.id}: its cheap model is another harness's — a model name is harness-specific (ADR-008)`,
      );
    }
  }
  assert.equal(harnessForOverlay(null), null);
  assert.equal(harnessForOverlay("nothing-declares-this"), null);
});

// ─── Skills: the surface two harnesses load from ONE tree ──────────────
//
// `skills/` is the only source surface both manifests host-load today, and it
// is loaded UNRENDERED — emit is false, there is no generator yet. So the one
// tree has to satisfy both loaders at once, and where it cannot, the manifest
// has to say so rather than let a user discover it.

const skillDirs = () =>
  readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const frontmatterOf = (dir) => {
  const src = readFileSync(join(ROOT, "skills", dir, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  assert.ok(m, `skills/${dir}/SKILL.md has no frontmatter block`);
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return { fields: out, body: src };
};

test("skills: every shipped skill carries the frontmatter EVERY loading harness requires", () => {
  // Union, not the source harness's own list: one tree, two loaders, and the
  // strictest wins. Codex's documentation requires `name` (read 2026-09-08);
  // ours carried only `description` and loaded anyway, which is a laxer loader
  // rather than a licence — a skill that does not satisfy the documented
  // contract is one release away from not loading.
  const required = new Set(manifests().flatMap((m) => m.surfaces?.skills?.frontmatter_required || []));
  assert.ok(required.size > 0, "no manifest declares what a skill's frontmatter must carry");
  const dirs = skillDirs();
  assert.ok(dirs.length > 0);
  for (const d of dirs) {
    const { fields } = frontmatterOf(d);
    for (const key of required) {
      assert.ok(
        fields[key] && fields[key].length > 0,
        `skills/${d}/SKILL.md is missing frontmatter \`${key}\`, which a loading harness requires`,
      );
    }
    // The name is the handle a user types (`$<name>` on Codex), so it has to be
    // the directory's — a name that disagrees with its folder is a skill nobody
    // can call by the name they can see.
    if (required.has("name"))
      assert.equal(fields.name, d, `skills/${d}/SKILL.md: name must equal its directory — it is what a user types`);
  }
});

// The namespace every surface of ours is published under, taken from the
// package rather than typed: a literal here would be one more place to forget.
const NAMESPACE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;

test("skills: every skill is published under our namespace — a generic name in a flat registry belongs to whoever got there first", () => {
  // Commands are already namespaced by the harness that loads them:
  // `/projectstore:adr` cannot collide, because the plugin owns the prefix.
  // Skills have no such protection on Codex — they resolve in ONE registry per
  // machine, fed by $CWD/.agents/skills, $REPO_ROOT/.agents/skills,
  // $HOME/.agents/skills, /etc/codex/skills and every installed plugin, and a
  // user calls one by typing `$<name>`. So a skill called `peer-reviewer` is a
  // claim on a word, on that user's machine, against every other tool that
  // wanted it. Ours are prefixed for the same reason our commands are: the
  // surfaces must be identical in what they promise, and an unprefixed name
  // promises something we cannot keep.
  const dirs = skillDirs();
  assert.ok(dirs.length > 0);
  for (const d of dirs) {
    assert.ok(
      d.startsWith(`${NAMESPACE}-`),
      `skills/${d}: a skill directory is published as ${NAMESPACE}-<name> — a bare name collides in the flat registry Codex resolves $<name> against`,
    );
    assert.notEqual(d, NAMESPACE, `skills/${d}: the prefix names a family, not a member`);
    assert.equal(
      frontmatterOf(d).fields.name,
      d,
      `skills/${d}: the frontmatter name is what a user types, so it carries the prefix too`,
    );
  }
  // And the same rule stated for what the generator will produce: a command
  // rendered as a skill keeps the namespace it had as a command, so
  // `/projectstore:adr` becomes `$projectstore-adr` rather than `$adr`.
  const commands = readdirSync(join(ROOT, "commands"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  assert.ok(commands.length > 0);
  for (const c of commands) {
    assert.ok(
      !dirs.includes(c),
      `skills/${c}: a rendered command must be published as ${NAMESPACE}-${c}, not under its bare verb`,
    );
  }
});

test("skills: a harness that loads the source tree unrendered declares it, and the declaration matches what actually leaks", () => {
  // Contract 11 is right: source files stay in the SOURCE harness's vocabulary,
  // so `/projectstore:adr` in a skill body is correct authoring. What is not
  // correct is shipping that tree, unrendered, to a harness whose commands
  // surface is unsupported — the skill loads and then tells the reader to run
  // something that cannot exist there. Contract 10's lint is the real fix and
  // it arrives with the generator; until then the manifest declares the gap and
  // this test holds the declaration to the facts IN BOTH DIRECTIONS.
  const src = sourceHarness();
  const namespace = /\/projectstore:[a-z-]+/;
  const leaks = skillDirs().filter((d) => namespace.test(frontmatterOf(d).body));

  for (const m of manifests()) {
    const skills = m.surfaces?.skills;
    if (!skills || skills.supported === false) continue;
    assert.ok(
      "unrendered_source" in skills,
      `${m.id}: surfaces.skills must say whether it loads the source tree unrendered`,
    );
    if (m.id === src.id) {
      assert.equal(
        skills.unrendered_source,
        false,
        "the source harness cannot leak a foreign vocabulary into its own tree",
      );
      continue;
    }
    // A foreign harness loading the source tree: it either renders (emit) or
    // declares that it does not.
    assert.equal(
      skills.unrendered_source,
      !m.emit,
      `${m.id}: emit is ${m.emit}, so unrendered_source must be ${!m.emit}`,
    );
    const lacksCommands = m.surfaces?.commands?.supported === false;
    if (skills.unrendered_source && lacksCommands) {
      // The declaration is only honest while there is something to declare.
      // When the generator lands and the leak is gone, this assertion fails and
      // the flag must come out — which is the point: the gap cannot be quietly
      // kept after it is fixed, nor quietly dropped while it is still real.
      assert.ok(
        leaks.length > 0,
        `${m.id}: declares unrendered_source, but no shipped skill names the source harness's command namespace any more — remove the flag`,
      );
      assert.ok(
        (skills.unrendered_source_reason || "").length > 80,
        `${m.id}: a declared gap carries the reason a reader can evaluate it by`,
      );
    }
  }

  // And the leak itself is recorded, so its size is visible rather than a
  // sentence. THREE of the four, not all four, and the exception is the
  // instructive part: `vault-communication` says how to REFER to an artifact
  // (by its frontmatter title, with its epic) and never how to run anything, so
  // it carries no command namespace and needs no rendering to be correct on any
  // harness. The other three each end in "run /projectstore:<x>", which is the
  // sentence a Codex reader cannot act on. A skill written the first way is
  // portable by construction; that is worth knowing before the generator is
  // built, because it is cheaper than rendering.
  assert.deepEqual(
    leaks,
    ["projectstore-decision-detector", "projectstore-peer-reviewer", "projectstore-story-completion"],
    "the set of skills naming the source harness's commands changed — if the generator now renders them, drop unrendered_source; if a skill gained or lost the namespace, say which and why here",
  );
  assert.ok(
    !leaks.includes(`${NAMESPACE}-vault-communication`),
    "the vault-communication skill names no command surface, and that is why it needs no rendering",
  );
});

// The layout ADR's decision 2, as accepted: no manifest names the binding, the
// overlay or the state key — those are computed — while a SURFACE may name its
// own file, and that name is held to what the layout produces.
//
// The first version of this test asserted only the second half, and said it
// asserted both. Mutation showed the gap: its check was "is this path one the
// layout produces", and the layout produces the binding, the overlay and the
// state key too — so declaring the launcher AT the binding passed. It also
// swept two field names and disengaged entirely once a path left
// `.projectstore/`, which is the original violation shape. Both halves are
// asserted here, over every string the surfaces carry.
const OURS = /(^|\/)\.projectstore\//;

test("layout ADR decision 2: a surface may name its own file; no manifest names the binding, the overlay or the state key", () => {
  const proj = "/p";
  const rel = (x) => x.slice(proj.length + 1);
  // Every string value under `surfaces`, whatever the field is called: a new
  // surface reintroducing the drift through `dir`, `files[]` or `source` is the
  // same defect through a different key.
  const strings = (o, path = []) =>
    Object.entries(o || {}).flatMap(([k, v]) => {
      if (/_reason$|_comment$/.test(k) || k.startsWith("_")) return [];
      if (Array.isArray(v))
        return v.flatMap((x, i) =>
          typeof x === "string"
            ? [[[...path, `${k}[${i}]`].join("."), x]]
            : x && typeof x === "object"
              ? strings(x, [...path, `${k}[${i}]`])
              : [],
        );
      if (v && typeof v === "object") return strings(v, [...path, k]);
      return typeof v === "string" ? [[[...path, k].join("."), v]] : [];
    });

  let checked = 0;
  for (const m of manifests()) {
    const p = layoutPaths(proj, { harnessDir: m.runtime.harness_dir });
    // What is OURS to compute and no manifest may name, however it spells it.
    const reserved = new Map([
      [rel(p.binding), "the binding"],
      [rel(p.overlayDir), "the overlay directory"],
      [rel(p.overlay(m.runtime.overlay)), "this harness's overlay"],
      [rel(p.state), "the state root"],
      [rel(p.sessions), "the shared session store"],
      [rel(p.entryLog), "the entry log"],
      [rel(p.gitignore), "the layout's ignore file"],
      [rel(p.stateGitignore), "the state ignore file"],
      [rel(p.legacy.binding), "the legacy binding"],
    ]);
    // What a surface of THIS harness may name, split by WHICH path it is. A
    // legacy field may name where an earlier release wrote — under the
    // harness's own directory, which is exactly what the layout move ended.
    // A current field may not: declaring `file` as the legacy path is the
    // pre-layout shape restored, and it passed while the two shared one set.
    const allowedCurrent = new Set(
      [p.launcher(m.runtime.overlay), p.welcomed(m.runtime.overlay), p.harnessState(m.runtime.overlay)]
        .filter(Boolean)
        .map(rel),
    );
    const allowedLegacy = new Set([p.legacy.launcher, p.legacy.runtime, p.legacy.state].filter(Boolean).map(rel));

    for (const [field, value] of strings(m.surfaces)) {
      if (!OURS.test(value)) continue;
      checked++;
      const why = reserved.get(value);
      assert.ok(
        !why,
        `${m.id}: surfaces.${field} names ${value} — that is ${why}, which the layout computes and no manifest may declare (layout ADR decision 2)`,
      );
      const legacy = /legacy/i.test(field);
      const allowed = legacy ? allowedLegacy : allowedCurrent;
      assert.ok(
        allowed.has(value),
        `${m.id}: surfaces.${field} declares ${value}, which layoutPaths() does not produce as ` +
          `${legacy ? "a legacy" : "a current"} path for this harness — either the manifest and the layout have ` +
          "drifted, or a current path has been declared where an earlier release wrote (the shape the layout move ended)",
      );
    }
  }
  assert.ok(checked >= 2, "no surface declares a path under our directory — this test would be asserting nothing");
});

test("generation contract 6: lint patterns are derived from the OTHER manifests, and empty for the source layout", () => {
  assert.deepEqual(lintPatterns(sourceHarness()), []);
  // A fictitious emitting harness sees the source harness's tools and variables as forbidden tokens.
  const fake = {
    id: "fake",
    emit: true,
    lint: { forbidden_unmapped: [{ pattern: "\\bClaude Code\\b", class: "name" }] },
  };
  const pats = lintPatterns(fake);
  assert.ok(pats.some((p) => p.pattern === "\\bClaude Code\\b" && p.class === "name" && !p.derived));
  for (const t of sourceHarness().tools.write_tools)
    assert.ok(pats.some((p) => p.pattern === `\\b${t}\\b` && p.class === "token" && p.derived));
  assert.ok(pats.some((p) => p.pattern === `\\b${sourceHarness().runtime.plugin_root_env}\\b`));
});

test("tool paths are manifest-driven, including every path in Codex's patch envelope", () => {
  resetDetection();
  const source = toolPaths(
    { tool_input: { file_path: "/a", notebook_path: "/b", path: "/c" } },
    { CLAUDE_PLUGIN_ROOT: ROOT },
  );
  assert.deepEqual(source, ["/a", "/b", "/c"]);
  resetDetection();
  const codex = toolPaths(
    {
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: /a.js\n*** Move to: /b.js\n*** Add File: /c.js\n*** Delete File: /d.js\n*** End Patch",
      },
    },
    { PLUGIN_ROOT: ROOT },
  );
  assert.deepEqual(codex, ["/a.js", "/b.js", "/c.js", "/d.js"]);
  assert.deepEqual(writeTools({ PLUGIN_ROOT: ROOT }), ["apply_patch"]);
  resetDetection();
});

test("hooks.json's placeholder and write matcher are the manifest's", () => {
  const src = sourceHarness();
  const hooks = readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8");
  assert.ok(
    hooks.includes(src.hooks.root_placeholder),
    "hooks/hooks.json IS the source harness's tree and uses its placeholder (contract 2)",
  );
  assert.equal(src.hooks.matchers.write.split("|").sort().join("|"), [...src.tools.write_tools].sort().join("|"));
});

// A hook command with no `args` runs through a shell, so a plugin root with a
// space in it (any Windows home such as C:\Users\First Last) splits into two
// words unless the expanded path is quoted; the host's validator warns once per
// unquoted command (the story "Every hook command quotes its plugin root…",
// PS-DIRECTORY, decision 1: the whole-path form).
test('every hook command quotes its plugin root as one shell word: node "<placeholder>/<path>"', () => {
  const placeholder = sourceHarness().hooks.root_placeholder;
  const reg = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(reg.hooks).flatMap((entries) =>
    entries.flatMap((e) => (e.hooks || []).map((h) => h.command)),
  );
  assert.ok(commands.length > 0, "hooks.json registers no command, so this test would prove nothing");
  const lead = `node "${placeholder}/`;
  const offenders = commands.filter(
    (c) => !(c.startsWith(lead) && c.endsWith('"') && /^[^"\s]+$/.test(c.slice(lead.length, -1))),
  );
  assert.deepEqual(offenders, [], `every command reads ${lead}<path>"`);
});

// The launch form since the PS-DIRECTORY story "The MCP server's entry reaches
// no install verb…" (decision 3; the MCP ADR's decision 1 as amended): the
// manifest's entry under scripts/, not the bin, whose `mcp` verb argument
// stays with the bin for hosts without a plugin channel.
test(".mcp.json's placeholders are the manifest's, and it launches the manifest's MCP entry (MCP ADR decision 6, measured)", () => {
  const src = sourceHarness();
  const reg = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
  const server = reg.mcpServers.projectstore;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.ok(Array.isArray(server.args), "args is an array — the plugin path can contain spaces");
  assert.equal(src.surfaces.mcp.entry, "scripts/mcp-server.mjs");
  assert.equal(
    server.args[0],
    `${"$"}{${src.runtime.plugin_root_env}}/${src.surfaces.mcp.entry}`,
    "the entry, under the harness's plugin-root variable (runtime, not the hooks surface's placeholder)",
  );
  assert.deepEqual(
    server.args.slice(1),
    ["--project", `${"$"}{${src.runtime.project_dir_env}}`],
    "the project comes from the host's variable, expanded per session — never ambient cwd",
  );
  assert.equal(server.env, undefined, "one binding channel: --project, not an env block");
  const mcp = src.surfaces.mcp;
  assert.equal(mcp.kind, "host");
  assert.equal(mcp.launch.evidence, "measured");
  assert.equal(mcp.launch.protocol_era, "initialize");
  assert.deepEqual(mcp.launch.expands_measured, ["args", "env"]);
  assert.ok(mcp.scope_reason.includes("amended 2026-09-05"));
  assert.ok(
    !mcp.scope_reason.includes("contract 14"),
    "the install spec's contract 0 classifies surfaces; 14 is upgrade",
  );
});

// ─── Generation spec, contract 18: what the core prints, on every harness ──
//
// Invariant two keeps a foreign vocabulary out of the generated tree; these
// keep it out of what the core prints. Layer 1 refuses any literal in any
// manifest's invocation form in the runtime code — so a message cannot name
// `/projectstore:doctor` to a Codex user. Layer 2 resolves every name the
// messages use on every harness — so renaming or removing a command on one
// harness fails here, naming the message and the harness it would break.
// Layer 3 (tests/vocabulary.test.mjs) runs the hooks and doctor under each.

test("contract 18, layer 1: no runtime file carries a literal in any manifest's invocation form", async () => {
  const v = await import("./fixtures/vocabulary.mjs");
  const files = v.runtimeFiles(ROOT);
  assert.ok(
    files.includes("hooks/session-start.mjs") &&
      files.includes("scripts/doctor.mjs") &&
      !files.includes("scripts/build-adapters.mjs"),
  );
  const pats = v.invocationPatterns(ROOT);
  assert.ok(pats.length >= 4, "a pattern per harness per kind with a template");
  assert.ok(
    pats.every((p) => /projectstore/.test(p.prefix)),
    "never a bare `$` or `/` prefix",
  );
  for (const e of v.exemptions()) assert.ok(e.why && e.why.length > 10, `exemption ${e.phrase} carries its why`);
  const hits = v.scanLiterals(ROOT, files);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.text} (${h.harness} ${h.kind} form)`),
    [],
    "route these through commandForm/roleForm (scripts/lib.mjs)",
  );

  // Planted: each must fail, naming the file and the line.
  const planted = {
    "scripts/planted-a.mjs": 'const a = 1;\nconst msg = "run /projectstore:doctor";\n',
    "scripts/planted-b.mjs": "const msg = `run $projectstore-doctor`;\n",
    "scripts/planted-c.mjs": 'const msg = "spawn projectstore:critic";\n',
    "scripts/planted-d.mjs": "const msg = `close <!-- /projectstore:agents --> then /projectstore:agents register`;\n",
    "scripts/planted-e.mjs": "const msg = `/projectstore:${name}`;\n",
  };
  const found = v.scanLiterals(ROOT, Object.keys(planted), { read: (f) => planted[f] });
  const at = (f) => found.filter((h) => h.file === f).map((h) => `${h.line}:${h.text}`);
  assert.deepEqual(at("scripts/planted-a.mjs"), ["2:/projectstore:doctor"]);
  assert.deepEqual(at("scripts/planted-b.mjs"), ["1:$projectstore-doctor"]);
  assert.deepEqual(at("scripts/planted-c.mjs"), ["1:projectstore:critic"]);
  assert.deepEqual(
    at("scripts/planted-d.mjs"),
    ["1:/projectstore:agents"],
    "the marker is exempt, the command beside it is not",
  );
  assert.deepEqual(at("scripts/planted-e.mjs"), ["1:/projectstore:${"], "an interpolated name is still a literal form");
});

test("contract 18, layer 2: every name a message uses exists in the source and on every emitting harness", async () => {
  const v = await import("./fixtures/vocabulary.mjs");
  const calls = v.helperCalls(ROOT, v.runtimeFiles(ROOT));
  assert.ok(calls.length >= 40, `the messages go through the helpers (${calls.length} calls)`);
  assert.deepEqual(
    v.unresolved(ROOT, calls).map((u) => `${u.file}:${u.line} ${u.name} — ${u.why}`),
    [],
  );

  // Planted: a name with no source command; a source command whose rendered
  // skill is missing from an emitting harness's tree; a name the lint cannot read.
  const planted = {
    "scripts/planted.mjs":
      'const a = commandForm("frobnicate");\nconst b = commandForm("doctor");\nconst c = commandForm(verb);\n',
  };
  const pcalls = v.helperCalls(ROOT, Object.keys(planted), { read: (f) => planted[f] });
  const missingSkill = (p) =>
    !p.includes("skills/projectstore-doctor/") &&
    (() => {
      try {
        readFileSync(join(ROOT, p));
        return true;
      } catch {
        return false;
      }
    })();
  const out = v
    .unresolved(ROOT, pcalls, { exists: missingSkill })
    .map((u) => `${u.line} ${u.name} ${u.harness}: ${u.why}`);
  assert.ok(
    out.some((l) => /^1 frobnicate claude-code: no commands\/frobnicate\.md/.test(l)),
    out.join("\n"),
  );
  assert.ok(
    out.some((l) =>
      /^2 doctor codex: \$projectstore-doctor has no adapters\/codex\/skills\/projectstore-doctor\/SKILL\.md/.test(l),
    ),
    out.join("\n"),
  );
  assert.ok(
    out.some((l) => /^3 null null: the name is not a string literal/.test(l)),
    out.join("\n"),
  );

  // A direct invocation(harness, "<name>") in a file that imports the helper
  // is held to the same rule; a file's own function of that name is not.
  const direct = {
    "scripts/planted-direct.mjs":
      'import { invocation } from "./harness.mjs";\nconst d = invocation(h, "frobnicate", { args: "x" });\nconst e = invocation(h, name);\n',
    "scripts/planted-own.mjs": "function invocation(env) { return env; }\nconst f = invocation(env);\n",
  };
  const dcalls = v.helperCalls(ROOT, Object.keys(direct), { read: (f) => direct[f] });
  assert.deepEqual(
    dcalls.map((c) => `${c.file}:${c.line} ${c.name}`),
    ["scripts/planted-direct.mjs:2 frobnicate", "scripts/planted-direct.mjs:3 null"],
  );
});

test("contract 18, layer 2 for the rendered tree: every skill a rendered surface names exists in that tree", async () => {
  const { invocationPatterns } = await import("./fixtures/vocabulary.mjs");
  for (const m of [...manifests()].filter((x) => x.emit && !x.source_layout)) {
    const base = join(ROOT, m.output_dir);
    const skills = new Set(
      readdirSync(join(base, "skills"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|json|ya?ml)$/.test(e.name)) files.push(p);
      }
    };
    walk(base);
    // The target's own command form, any name: `$projectstore-<anything>`.
    const own = invocationPatterns(ROOT).find((p) => p.harness === m.id && p.kind === "commands");
    assert.ok(own, `${m.id} has a command form`);
    const any = new RegExp(own.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([a-z0-9][a-z0-9-]*)", "g");
    const rendered = m.surfaces.commands.rendered_name;
    const dead = [];
    for (const file of files) {
      for (const hit of readFileSync(file, "utf8").matchAll(any)) {
        const skill = rendered.split("<name>").join(hit[1]);
        if (!skills.has(skill)) dead.push(`${file.slice(ROOT.length + 1)}: ${hit[0]} names no skills/${skill}/`);
      }
    }
    assert.deepEqual(dead, [], `${m.id}: a rendered surface names a skill its tree does not have`);
  }
});

test("contract 18: the manifests' message fields have their shape and their reasons", () => {
  const src = sourceHarness();
  assert.ok(
    Array.isArray(src.ui_vocabulary) &&
      src.ui_vocabulary.every((w) => typeof w === "string" && w) &&
      src.ui_vocabulary_reason,
    "the source harness's UI words, with a reason",
  );
  for (const m of manifests()) {
    if (m.install?.shell) {
      assert.ok(
        m.update_hint &&
          typeof m.update_hint.line === "string" &&
          Array.isArray(m.update_hint.welcome) &&
          m.update_hint.reason,
        `${m.id}: update_hint { line, welcome, reason }`,
      );
    }
    // A channel's own text has the same shape, keyed by an installChannel answer.
    for (const [ch, h] of Object.entries(m.update_hint?.by_channel || {}))
      assert.ok(
        ["registration", "marketplace", "synced", "package", "checkout"].includes(ch) &&
          typeof h.line === "string" &&
          Array.isArray(h.welcome),
        `${m.id}: update_hint.by_channel.${ch} { line, welcome }`,
      );
    // A synced copy is the host plugin system's channel (PS-DIRECTORY, "A copy
    // installed from Anthropic's directory…"): only a manifest whose
    // registration is that system names its folder or speaks for it, and the
    // folder comes with its reason.
    const hostReg = Object.values(m.surfaces || {}).find((s) => s?.format === "host-plugin-registration");
    if (!hostReg) {
      assert.ok(!JSON.stringify(m.surfaces || {}).includes('"synced_dir"'), `${m.id}: no synced_dir`);
      assert.equal(m.update_hint?.by_channel?.synced, undefined, `${m.id}: no by_channel.synced`);
    } else if (hostReg.registry?.synced_dir) {
      assert.ok(hostReg.registry.synced_reason && hostReg.registry.synced_origin, `${m.id}: synced_dir's reason`);
      assert.ok(hostReg.registry.auto_update?.reason, `${m.id}: registry.auto_update's reason`);
    }
    for (const key of ["session_rename", "bind_inherit"]) {
      assert.ok(key in (m.capabilities || {}), `${m.id}: capabilities.${key} is stated, even as null or false`);
      assert.ok(m.capabilities[`${key}_reason`], `${m.id}: capabilities.${key}_reason`);
    }
    if (m.capabilities.session_rename)
      assert.ok(m.capabilities.session_rename.includes("<name>"), `${m.id}: session_rename fills <name>`);
    for (const kind of ["commands", "agents"]) {
      const s = m.surfaces?.[kind] || {};
      if (s.rendered_as === "skill") {
        assert.ok(
          s.rendered_name && s.rendered_name.includes("<name>") && s.rendered_reason,
          `${m.id}: surfaces.${kind}.rendered_name fills <name>, with a reason`,
        );
        assert.ok(
          m.surfaces?.skills?.invocation?.includes("<name>"),
          `${m.id}: a rendered surface needs the skills' invocation`,
        );
      }
    }
  }
});

test("contract 18, layer 1: the source harness's UI words appear in runtime code only with their reason", async () => {
  const v = await import("./fixtures/vocabulary.mjs");
  for (const e of v.uiExemptions()) assert.ok(e.why && e.why.length > 10, `exemption ${e.phrase} carries its why`);
  const hits = v.scanUiWords(ROOT, v.runtimeFiles(ROOT));
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.text}`),
    [],
    "gate the check on the harness's surface, or mark the finding `about` that harness, and state why in uiExemptions()",
  );
  // Planted: a UI word fails, naming the line; a path that contains one does not.
  const words = sourceHarness().ui_vocabulary || [];
  if (!words.length) return;
  const planted = {
    "scripts/planted-ui.mjs": `const a = ".claude-plugin/plugin.json";\nconst msg = "then ${words[0]} it.";\n`,
  };
  const found = v.scanUiWords(ROOT, Object.keys(planted), { read: (f) => planted[f] });
  assert.deepEqual(
    found.map((h) => `${h.line}:${h.text}`),
    [`2:${words[0]}`],
  );
});

test("contract 18, layer 2 for the rendered tree: no role or command in the source harness's form survives rendering", async () => {
  const v = await import("./fixtures/vocabulary.mjs");
  const src = sourceHarness();
  const pats = v.invocationPatterns(ROOT).filter((p) => p.harness === src.id);
  assert.ok(
    pats.some((p) => p.kind === "agents"),
    "the source's role form is a pattern",
  );
  for (const m of [...manifests()].filter((x) => x.emit && !x.source_layout)) {
    const base = join(ROOT, m.output_dir);
    const hits = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|json|ya?ml)$/.test(e.name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, k) => {
              for (const pat of pats) {
                pat.re.lastIndex = 0;
                for (const hit of line.matchAll(pat.re)) hits.push(`${p.slice(ROOT.length + 1)}:${k + 1} ${hit[0]}`);
              }
            });
        }
      }
    };
    walk(base);
    assert.deepEqual(hits, [], `${m.id}: a rendered surface names a command or role the way only ${src.id} calls it`);
    // Any name at all after the source's role prefix — a role renamed or
    // retired, a historical name — is still the source's form.
    const prefix = src.surfaces.agents.invocation.split("<name>")[0];
    const any = new RegExp(`(?<![\\w/$:-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z][a-z0-9-]*`, "g");
    const loose = [];
    const walk2 = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk2(p);
        else if (/\.(md|json|ya?ml)$/.test(e.name)) {
          for (const hit of readFileSync(p, "utf8").matchAll(any)) loose.push(`${p.slice(ROOT.length + 1)}: ${hit[0]}`);
        }
      }
    };
    walk2(base);
    assert.deepEqual(loose, [], `${m.id}: a source role-form name survives rendering`);
  }
});

test("contract 18, layer 2: where bind cannot inherit, the bind the offer names declares every flag the offer passes", async () => {
  const { inheritForm } = await import("../scripts/lib.mjs");
  const { hermeticEnv } = await import("./fixtures/vocabulary.mjs");
  const src = sourceHarness();
  for (const m of manifests().filter((x) => x.capabilities?.bind_inherit === false)) {
    const form = inheritForm("/v", {
      layout: "engineering",
      language: "en",
      env: hermeticEnv({ PROJECTSTORE_HARNESS: m.id }),
    });
    const flags = form.match(/--[a-z][a-z-]*/g) || [];
    assert.deepEqual(flags, ["--layout", "--language"], form);
    const t = m.surfaces?.commands || {};
    const rel =
      t.rendered_as === "skill" && t.rendered_name
        ? join(m.output_dir, "skills", t.rendered_name.split("<name>").join("bind"), "SKILL.md")
        : join(src.surfaces.commands.dir, src.surfaces.commands.file.replace("<name>", "bind"));
    const text = readFileSync(join(ROOT, rel), "utf8");
    const head = text.split("\n").find((l) => l.startsWith("description:") || l.startsWith("argument-hint:")) || "";
    for (const f of flags) assert.ok(head.includes(f), `${m.id}: ${rel} declares ${f} in its arguments (${head})`);
  }
});

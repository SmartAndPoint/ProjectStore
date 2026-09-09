// projectstore — harness conformance (PS-HARNESS: "Harness conformance: one
// fixture that installs, binds and configures every harness into a temp tree").
//
// Install into an empty tree, look at what appeared, bind, configure — for
// EVERY harness in `harnesses/`, from one body of code. The two defects that
// produced this story were both of one class: a value correct for one harness,
// silently applied to another. A unit test finds neither, because both are
// right in shape and wrong in content. Only installing and looking does.
//
// This is the logic half and it names no harness. The data half is
// `tests/fixtures/conformance.mjs`; the last test in this file greps this one
// for an id and fails if one appears. That pairing is the story's actual
// requirement — adding opencode must be a manifest and a row, never an `if`.
//
// The `npx` arm is deliberately NOT duplicated here: tests/shells.test.mjs
// already packs the core, builds the shell, and compares a preview taken
// through the shipped bin against the core's own. It covers the publishable
// shell; the Codex shell is private until B5 publishes it.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, apply } from "../scripts/install-harness.mjs";
import { detectHarnesses } from "../scripts/harness.mjs";
import { readOverlayAt, readConfigAt, layoutPaths, resolveAgentModel } from "../scripts/lib.mjs";
import { run } from "../scripts/cli.mjs";
import { ROWS, row, rowCoverage, manifests, treeOf, boundProject, unboundProject, sharedProject, stand } from "./fixtures/conformance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(p, "utf8");

// ─── Coverage: a manifest without a row is a harness nobody looked at ───

test("conformance: every manifest has a row and every row has a manifest", () => {
  const c = rowCoverage();
  // Not >= 1: with a single manifest every cross-harness assertion in this
  // file — the foreign directory, the foreign block file, the foreign clerk
  // pin — iterates an empty list and passes saying nothing. Dropping a harness
  // is a legitimate change; doing it silently is not.
  assert.ok(c.ids.length >= 2, "conformance needs at least two harnesses to compare; with one, this file asserts nothing");
  assert.deepEqual(c.missingRow, [], "a harness with no conformance row — install it into an empty tree and record what appeared");
  assert.deepEqual(c.orphanRow, [], "a conformance row for a harness with no manifest");
});

// ─── Install into an empty tree: exactly this, and nothing else ─────────

test("conformance: an install writes exactly the row's files, and never into another harness's directory", () => {
  for (const h of manifests()) {
    const { home, root, env } = stand();
    const proj = boundProject(h);
    const before = treeOf(proj);
    const p = plan(proj, { harnesses: [h.id], home, root, env });
    assert.equal(p.ok, true, `${h.id}: ${p.refusals.join("; ")}`);
    assert.deepEqual(p.harnesses, [h.id]);
    assert.deepEqual(treeOf(proj), before, `${h.id}: plan writes nothing`);

    // The same sandbox `plan` got. Without it `apply` defaults to
    // process.env and the real homedir(), and the day a plan carries a
    // registration item this test writes into the developer's own harness home.
    apply(p, { env, home });
    const written = treeOf(proj).filter((f) => !before.includes(f));
    assert.deepEqual(written, [...row(h.id).writes].sort(), `${h.id}: ${row(h.id).why}`);

    // Derived, not listed: a harness installs into its own directory and the
    // project's neutral one. Writing into a directory another manifest claims
    // is the collision the whole per-harness layout exists to prevent, and it
    // is the assertion that keeps two harnesses safe in one checkout.
    const foreign = manifests().filter((o) => o.id !== h.id).map((o) => o.runtime.harness_dir);
    for (const f of written) {
      for (const d of foreign) {
        assert.ok(!f.startsWith(d + "/"), `${h.id}: wrote ${f}, inside ${d}, which belongs to another harness`);
      }
    }

    // Also derived: the agents block may only land in a file this manifest's
    // own list names. This is the defect, stated as a rule rather than as two
    // file names — a harness that cannot read a file must not be given one.
    const blockFiles = h.surfaces.agents_block.files;
    const otherBlockFiles = manifests().flatMap((o) => o.surfaces?.agents_block?.files || []).filter((f) => !blockFiles.includes(f));
    for (const f of otherBlockFiles) {
      assert.ok(!existsSync(join(proj, f)), `${h.id}: created ${f}, which its own surfaces.agents_block.files does not name`);
    }
    assert.ok(written.some((f) => blockFiles.includes(f)), `${h.id}: no agents block was written at all`);
  }
});

test("conformance: an unsupported surface says so in the plan — a state, not an absence — and the host report names only surfaces the harness has", () => {
  for (const h of manifests()) {
    const { home, root, env } = stand();
    const proj = boundProject(h);
    const p = plan(proj, { harnesses: [h.id], home, root, env });
    const rows = Object.entries(h.surfaces || {}).filter(([k]) => !k.startsWith("_"));
    const unsupported = rows.filter(([, s]) => s.supported === false).map(([k]) => k);
    apply(p, { env, home });

    for (const key of unsupported) {
      // POSITIVELY, and this is the whole point of the rewrite: the first
      // version asserted that no ACTION was planned, which a host row
      // satisfied by producing no item at all — so removing the
      // `supported === false` guard from the installer left this green.
      // `state: "unsupported"` is written in exactly the two branches that
      // read the flag, so asserting it is asserting the guard.
      assert.deepEqual(
        p.items.filter((i) => i.surface === key).map((i) => i.state), ["unsupported"],
        `${h.id}: ${key} is unsupported in the manifest and the plan does not say so`,
      );
      assert.deepEqual(p.items.filter((i) => i.surface === key).map((i) => i.action), ["skip"]);
      const item = p.items.find((i) => i.surface === key);
      assert.ok(item.reason && item.reason.length > 0, `${h.id}: ${key} is skipped with no reason a reader can evaluate`);
      const file = h.surfaces[key].file;
      if (file) assert.ok(!existsSync(join(proj, file)), `${h.id}: wrote ${file} for the unsupported surface ${key}`);
    }

    // The report is for surfaces the HOST installs — which is a different fact
    // from a surface the harness does not have. Merging them told a Codex user
    // that its commands, agents, MCP and status line were waiting for it
    // somewhere; four rows the manifest declares absent.
    const hostHas = rows.filter(([, s]) => s.kind === "host" && s.supported !== false).map(([k]) => k);
    const hostLacks = rows.filter(([, s]) => s.kind === "host" && s.supported === false).map(([k]) => k);
    const report = p.reports.join("\n");
    if (hostHas.length) {
      assert.ok(p.reports.length > 0, `${h.id}: has host-managed surfaces and reports none`);
      for (const k of hostHas) assert.ok(report.includes(k), `${h.id}: the host report omits ${k}`);
    }
    for (const k of hostLacks) {
      assert.ok(
        !new RegExp(`\\b${k}\\b`).test(report.split("\n")[0] || ""),
        `${h.id}: the host report claims ${k} is installed by the host, and the manifest says this harness has no such surface`,
      );
    }
  }
});

// ─── Bind: one file, the same shape whichever harness ──────────────────

test("conformance: the bind VERB writes one harness-neutral file, and its shape does not differ by harness", async () => {
  const seen = [];
  for (const h of manifests()) {
    // An unbound project: the fixture's writeBinding would answer this test
    // with its own literal, which is what the first version of it did — every
    // assertion below restated a constant and could not differ by harness.
    const proj = unboundProject(h);
    const vault = mkdtempSync(join(tmpdir(), "ps-conf-vault-"));
    const code = await run(["bind", vault, "--json", "--project", proj], { env: {}, stdout: sink(), stderr: sink() });
    assert.equal(code, 0, `${h.id}: bind failed`);

    const paths = layoutPaths(proj);
    assert.equal(paths.binding, join(proj, ".projectstore", "projectstore.json"));
    assert.ok(existsSync(paths.binding), `${h.id}: bind wrote no file at the neutral path`);
    // Never inside the harness's own directory: that is what made the binding
    // unshareable before the layout ADR, and it is the one thing that would
    // make two harnesses in one checkout collide on their first verb.
    assert.ok(!existsSync(join(proj, h.runtime.harness_dir, "projectstore.json")), `${h.id}: bind wrote inside its own directory`);
    const cfg = readConfigAt(proj);
    assert.equal(cfg.vault_path, vault, `${h.id}: the binding does not name the vault it was given`);
    assert.ok(!("agents" in cfg), `${h.id}: a model leaked into the harness-neutral binding`);
    // No harness's own vocabulary anywhere in the file. Derived from the
    // manifests, so a name added to one is checked here without an edit.
    const raw = read(paths.binding);
    for (const o of manifests()) {
      for (const v of [o.id, o.display_name, o.runtime.harness_dir, o.runtime.overlay]) {
        assert.ok(!raw.includes(v), `${h.id}: the binding names ${v} — it is supposed to be harness-neutral`);
      }
    }
    seen.push(Object.keys(cfg).sort().join(","));
  }
  assert.equal(new Set(seen).size, 1, "the binding's key set differs by harness — it is supposed to be the neutral one");
});

// ─── Configure: one overlay each, and neither disturbs the other ────────

test("conformance: configuring one harness writes its overlay alone, and the clerk takes that harness's own cheap model", async () => {
  const all = manifests();
  const proj = sharedProject();
  assert.deepEqual(detectHarnesses(proj).map((d) => d.id).sort(), all.map((h) => h.id).sort(),
    "the shared project is detected as every harness at once — that is the arrangement under test");

  const written = [];
  for (const h of all) {
    const before = all.map((o) => snapshotOverlay(proj, o));
    const code = await run(["agents", "configure", "--harness", h.id, "--default", "a-strong-model", "--json", "--project", proj], { env: {}, stdout: sink(), stderr: sink() });
    assert.equal(code, 0, `${h.id}: configure failed`);

    const mine = readOverlayAt(proj, h.runtime.overlay);
    assert.ok(mine.present, `${h.id}: no overlay written`);
    assert.equal(mine.path, join(proj, ".projectstore", "harness", `${h.runtime.overlay}.json`));
    assert.equal(mine.agents.default, "a-strong-model");
    written.push(mine.path);

    // The clerk's pin is this manifest's, or absent — never another's.
    const cheap = h.agent_translation?.cheap_model || null;
    assert.equal(mine.agents.per_agent.clerk || null, cheap, `${h.id}: the clerk's pin is not this harness's cheap model`);
    for (const o of all) {
      if (o.id === h.id) continue;
      const foreign = o.agent_translation?.cheap_model;
      if (foreign && foreign !== cheap) {
        assert.notEqual(mine.agents.per_agent.clerk, foreign, `${h.id}: pinned ${foreign}, which belongs to ${o.id}`);
      }
    }

    // Every other overlay is byte-unchanged.
    for (const b of before) {
      if (b.id === h.runtime.overlay) continue;
      assert.equal(snapshotOverlay(proj, byOverlay(all, b.id)).raw, b.raw, `${h.id}: configuring it changed ${b.id}'s overlay`);
    }
    // And the binding never moves.
    assert.ok(!("agents" in readConfigAt(proj)), "configure wrote a model into the binding");
  }
  assert.equal(new Set(written).size, all.length, "two harnesses shared one overlay file");

  // What it is all for: the same agent resolves to a different model per
  // harness, from one project.
  const resolved = all.map((h) => {
    const r = resolveAgentModel(proj, "clerk", { harness: h.runtime.overlay });
    const cheap = h.agent_translation?.cheap_model || null;
    assert.equal(r.model, cheap ?? "a-strong-model", `${h.id}: the clerk resolves to the wrong model`);
    return r.model;
  });
  // The loop above compares each harness with its own manifest, which two
  // manifests declaring the same cheap model would satisfy while demonstrating
  // nothing. This says the goal outright: as many distinct answers as there are
  // distinct declarations, from one project.
  const declared = all.map((h) => h.agent_translation?.cheap_model || "a-strong-model");
  assert.equal(new Set(resolved).size, new Set(declared).size,
    "one role, one project, and the harnesses do not resolve it as distinctly as their manifests declare it");
});

// ─── The modularity guard ──────────────────────────────────────────────

test("conformance: neither half of the pair branches on a harness — the vocabulary is greped, not just the id", () => {
  // An id in quotes was the first version of this, and it was too narrow twice
  // over: `h.display_name === "Codex"` and `h.runtime.harness_dir === ".codex"`
  // both passed it while being exactly the branch it exists to forbid, and it
  // read only the test file, leaving the fixture's helpers — the natural home
  // for a per-harness `if` — unguarded. A harness's VOCABULARY is what must not
  // appear: every name the manifest gives it.
  const vocabulary = manifests().flatMap((h) => [
    h.id, h.display_name, h.runtime.harness_dir, h.runtime.overlay, h.runtime.home_default,
    h.runtime.project_dir_env, h.runtime.plugin_root_env, h.runtime.home_env,
    ...(h.runtime.detect_env || []), ...(h.runtime.shared_env || []),
  ].filter(Boolean));
  assert.ok(vocabulary.length > 0);

  // Line comments FIRST. This file's own header carries `tests/*.test.mjs`,
  // whose `/*` pairs with the `*/` inside `[^\n]*/g` below — stripping blocks
  // first deleted the entire body between them and left this grep reading
  // 1KB of a 15KB file. It passed, of course. See tests/portability.test.mjs.
  const strip = (t) => t.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  // The test file entire; the fixture with its ROWS literal cut out, since the
  // rows are the one place a name belongs.
  const halves = [
    ["tests/conformance.test.mjs", strip(read(join(ROOT, "tests", "conformance.test.mjs")))],
    ["tests/fixtures/conformance.mjs", strip(read(join(ROOT, "tests", "fixtures", "conformance.mjs"))).replace(/export const ROWS[\s\S]*?\n\}\);\n/, "")],
  ];
  for (const [file, code] of halves) {
    for (const v of vocabulary) {
      assert.ok(
        !new RegExp(`["'\`]${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(code),
        `${file} names ${v} in code — a harness's own vocabulary belongs in a row, not in a branch`,
      );
    }
  }
  // The rows file is the one place a name is allowed, and every row must say
  // what its shape proves: a `writes` list with no reason is a change-detector.
  for (const [id, r] of Object.entries(ROWS)) {
    assert.ok(Array.isArray(r.writes) && r.writes.length > 0, `${id}: writes`);
    assert.ok(typeof r.why === "string" && r.why.length > 40, `${id}: a row states what its shape proves`);
  }
});

// ─── helpers (no harness names) ────────────────────────────────────────

function snapshotOverlay(proj, harness) {
  const p = layoutPaths(proj).overlay(harness.runtime.overlay);
  return { id: harness.runtime.overlay, raw: existsSync(p) ? read(p) : null };
}

const byOverlay = (all, overlay) => all.find((h) => h.runtime.overlay === overlay);
const sink = () => ({ write() {} });

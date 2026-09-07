// projectstore — harness overlays (PS-HARNESS: "Harness overlays:
// harness/<id>.json, the agents precedence, configure per harness"; the layout
// ADR decision 3; layout spec contracts 2–4).
//
//   node --test tests/overlay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { seedCliVault, writeBinding } from "./fixtures/vault.mjs";
import { noHostEnv } from "./fixtures/install.mjs";
import { sourceHarness, overlayId } from "../scripts/harness.mjs";
import { readOverlayAt, resolveAgentModel, writeOverlayAt, readConfigAt, layoutPaths } from "../scripts/lib.mjs";
import { checkOverlays } from "../scripts/doctor.mjs";
import { run } from "../scripts/cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const BIN = join(ROOT, "bin", "projectstore.mjs");
const TMP = realpathSync(tmpdir());
const read = (p) => readFileSync(p, "utf8");
delete process.env[SRC.runtime.home_env];

function project() {
  const proj = mkdtempSync(join(TMP, "ps-overlay-"));
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: "/tmp/nowhere", layout: "engineering", language: "en" });
  return proj;
}
const bin = (args, { env = {}, cwd = ROOT } = {}) => {
  const e = { ...noHostEnv(), ...env }; delete e[SRC.runtime.project_dir_env]; delete e.PROJECTSTORE_PROJECT_DIR; Object.assign(e, env);
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: e, cwd, timeout: 60000 });
};

test("overlay contract 3: ADR-008's two terms, from the overlay — per-agent, else default, else null; the clerk pin is never outranked", () => {
  const proj = project();
  assert.equal(overlayId({}), SRC.id, "the overlay id is the manifest's runtime.overlay (the harness id)");
  const cases = [
    [{ default: "sonnet", per_agent: { critic: "opus", clerk: "sonnet" } }, { critic: ["opus", "per_agent"], planner: ["sonnet", "default"], clerk: ["sonnet", "per_agent"] }],
    [{ default: "opus", per_agent: { clerk: "sonnet" } }, { critic: ["opus", "default"], clerk: ["sonnet", "per_agent"] }],
    [{ default: null, per_agent: { reviewer: "haiku" } }, { reviewer: ["haiku", "per_agent"], critic: [null, null] }],
    [{ default: null, per_agent: {} }, { critic: [null, null] }],
  ];
  for (const [agents, expect] of cases) {
    writeOverlayAt(proj, SRC.id, agents);
    for (const [name, [model, source]] of Object.entries(expect)) {
      const r = resolveAgentModel(proj, name, { harness: SRC.id });
      assert.equal(r.model, model, `${name} under ${JSON.stringify(agents)}`); assert.equal(r.source, source);
      assert.equal(r.overlay, layoutPaths(proj).overlay(SRC.id));
    }
  }
  assert.equal(resolveAgentModel(proj, "critic", { harness: "codex" }).model, null, "another harness's overlay is absent → frontmatter");
  assert.ok(!("agents" in readConfigAt(proj)), "the binding never carries agents");
});

test("overlay contract 2: the allowlist is two keys — everything else is ignored on read and named for doctor; the binding's agents block is a leftover doctor names", () => {
  const proj = project();
  const p = layoutPaths(proj).overlay(SRC.id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ vault_path: "/elsewhere", agents: { default: { model: "opus", effort: "max" }, per_agent: { critic: { model: "sonnet", effort: "low" }, planner: "opus" }, prompts: {} }, layout: "x" }));
  const o = readOverlayAt(proj, SRC.id);
  assert.deepEqual(o.agents, { default: "opus", per_agent: { critic: "sonnet" } });
  assert.deepEqual(o.rejected.sort(), ["agents.default.effort", "agents.per_agent.critic.effort", "agents.per_agent.planner", "agents.prompts", "layout", "vault_path"].sort());
  assert.equal(readConfigAt(proj).vault_path, "/tmp/nowhere", "an overlay never rebinds");
  const f = checkOverlays(readConfigAt(proj), proj);
  assert.equal(f.filter((x) => x.check === "overlay-forbidden-key").length, 6);
  assert.ok(f.every((x) => x.level === "issue"));
  assert.match(f[0].message, /vault_path|agents/);
  // The writer keeps a key it does not own (doctor keeps naming it) and rewrites only agents.
  writeOverlayAt(proj, SRC.id, { default: "haiku", per_agent: {} });
  assert.equal(JSON.parse(read(p)).vault_path, "/elsewhere");
  assert.deepEqual(JSON.parse(read(p)).agents, { default: { model: "haiku" } });
  // A binding that still carries agents (pre-0.28) is a warn naming the upgrade.
  writeBinding(proj, { ...readConfigAt(proj), agents: { default: { model: "opus" } } });
  const g = checkOverlays(readConfigAt(proj), proj);
  assert.ok(g.some((x) => x.check === "agents-in-binding" && x.level === "warn" && /upgrade --harness/.test(x.message)));
  // A configured name outside the roster is a warn naming the roster: nothing runs under it.
  writeOverlayAt(proj, SRC.id, { default: null, per_agent: { critc: "opus" } });
  assert.ok(checkOverlays(readConfigAt(proj), proj).some((x) => x.check === "overlay-unknown-agent" && x.level === "warn" && /critc.*critic/.test(x.message)));
  // Pre-migration the block sits in the LEGACY binding, and the finding names that file — not a path that does not exist yet.
  const legacy = mkdtempSync(join(TMP, "ps-overlay-legacy-"));
  mkdirSync(join(legacy, SRC.runtime.harness_dir), { recursive: true });
  const legacyBinding = layoutPaths(legacy, { harnessDir: SRC.runtime.harness_dir }).legacy.binding;
  writeFileSync(legacyBinding, JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering", agents: { default: { model: "opus" } } }));
  const l = checkOverlays(readConfigAt(legacy), legacy).find((x) => x.check === "agents-in-binding");
  assert.ok(l, "the legacy binding's block is found");
  assert.equal(l.file, join(SRC.runtime.harness_dir, "projectstore.json"));
  assert.ok(!existsSync(layoutPaths(legacy).binding));
  writeFileSync(p, "{ not json");
  assert.ok(checkOverlays(readConfigAt(proj), proj).some((x) => x.check === "overlay-unparseable"));
  assert.equal(resolveAgentModel(proj, "critic", { harness: SRC.id }).model, null, "unparseable → frontmatter, never a guess");
});

test("overlay contract 4: `agents configure` writes the active harness's overlay and nothing else; naming --harness is the confirmation; the binding is byte-unchanged; the clerk pin rides a default", async () => {
  const proj = project();
  const bindingBefore = read(layoutPaths(proj).binding);
  // In a session: the harness variable names the project; --harness confirms.
  const env = { [SRC.runtime.project_dir_env]: proj };
  const r = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--agent", "critic=fable", "--json"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verb, "agents configure"); assert.equal(out.ok, true);
  assert.equal(out.result.path, layoutPaths(proj).overlay(SRC.id));
  assert.deepEqual(out.result.agents, { default: "opus", per_agent: { clerk: "sonnet", critic: "fable" } }, "the clerk is pinned under a strong default");
  assert.equal(out.result.pinnedClerk, true);
  assert.equal(read(layoutPaths(proj).binding), bindingBefore, "the binding is untouched");
  assert.ok(!existsSync(layoutPaths(proj).overlay("codex")));
  // An explicit clerk choice wins over the pin; an empty model removes a key; nothing to change is a no-op.
  const r2 = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--agent", "clerk=haiku", "--agent", "critic=", "--json", "--project", proj]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).result.agents, { default: "opus", per_agent: { clerk: "haiku" } });
  const r3 = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--json", "--project", proj]);
  assert.equal(JSON.parse(r3.stdout).result.wrote, false, "same values: nothing written");
  // model / show through the bin.
  const m = JSON.parse(bin(["agents", "model", "planner", "--json", "--project", proj]).stdout);
  assert.equal(m.result.model, "opus"); assert.equal(m.result.source, "default");
  const s = JSON.parse(bin(["agents", "show", "--json", "--project", proj]).stdout);
  assert.deepEqual(s.result.agents.per_agent, { clerk: "haiku" }); assert.equal(s.result.agents_in_binding, false);
  // The gate: a bare non-TTY configure refuses (exit 2), an unknown harness is usage, a read never takes a configure option.
  const bare = bin(["agents", "configure", "--default", "sonnet", "--project", proj]);
  assert.equal(bare.status, 2); assert.match(bare.stderr, /names --harness/);
  assert.equal(bin(["agents", "configure", "--harness", "no-such", "--default", "x", "--project", proj]).status, 2);
  assert.equal(bin(["agents", "model", "critic", "--default", "x", "--project", proj]).status, 2);
  assert.equal(bin(["agents", "wat", "--project", proj]).status, 2);
  // --reset drops the block; the file keeps nothing else of ours.
  const r4 = bin(["agents", "configure", "--harness", SRC.id, "--reset", "--json", "--project", proj]);
  assert.equal(JSON.parse(r4.stdout).result.wrote, true);
  assert.deepEqual(JSON.parse(read(layoutPaths(proj).overlay(SRC.id))), {});
  assert.equal(resolveAgentModel(proj, "critic", { harness: SRC.id }).model, null);
  // In-process, the interactive branch: ask() drives it.
  const yes = await run(["agents", "configure", "--default", "sonnet", "--project", proj], { stdout: { write() {} }, stderr: { write() {} }, env: noHostEnv(), ask: async () => "y" });
  assert.equal(yes, 0);
  assert.equal(resolveAgentModel(proj, "planner", { harness: SRC.id }).model, "sonnet");
  const no = await run(["agents", "configure", "--default", "opus", "--project", proj], { stdout: { write() {} }, stderr: { write() {} }, env: noHostEnv(), ask: async () => "n" });
  assert.equal(no, 1);
  assert.equal(resolveAgentModel(proj, "planner", { harness: SRC.id }).model, "sonnet", "declined: unchanged");
  // --reset with --default / --agent: the block is emptied first, then set — nothing given is dropped.
  const r5 = bin(["agents", "configure", "--harness", SRC.id, "--reset", "--default", "sonnet", "--agent", "critic=opus", "--json", "--project", proj]);
  assert.equal(r5.status, 0, r5.stderr);
  assert.deepEqual(JSON.parse(r5.stdout).result.agents, { default: "sonnet", per_agent: { clerk: "sonnet", critic: "opus" } });
  // A name outside the roster is usage naming the roster; a second --harness is usage.
  const bad = bin(["agents", "configure", "--harness", SRC.id, "--agent", "critc=opus", "--project", proj]);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /critc[^\n]*critic/);
  assert.equal(bin(["agents", "configure", "--harness", SRC.id, "--harness", SRC.id, "--default", "x", "--project", proj]).status, 2);
  // show resolves per roster agent, so a reader never restates the two-term rule.
  const s2 = JSON.parse(bin(["agents", "show", "--json", "--project", proj]).stdout).result;
  assert.deepEqual(Object.keys(s2.resolved).sort(), ["archaeologist", "clerk", "critic", "librarian", "planner", "reviewer"]);
  assert.deepEqual(s2.resolved.planner, { model: "sonnet", source: "default" });
  assert.deepEqual(s2.resolved.critic, { model: "opus", source: "per_agent" });
  assert.deepEqual(s2.unknown, []);
  // A forbidden key INSIDE the agents block is a change the write drops and the preview names; a key outside it is kept.
  writeFileSync(layoutPaths(proj).overlay(SRC.id), JSON.stringify({ agents: { default: { model: "opus", effort: "max" }, per_agent: { clerk: { model: "sonnet" } } }, note: "kept" }));
  const r6 = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--json", "--project", proj]);
  const o6 = JSON.parse(r6.stdout).result;
  assert.equal(o6.wrote, true, "a forbidden key inside the block is a change");
  assert.deepEqual(o6.dropped, ["agents.default.effort"]);
  assert.deepEqual(o6.rejected, ["note"]);
  assert.equal(JSON.parse(read(layoutPaths(proj).overlay(SRC.id))).note, "kept");
  const r7 = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--project", proj]);
  assert.match(r7.stdout, /Nothing to change/);
  // A refusal is on stderr, never stdout.
  writeFileSync(layoutPaths(proj).overlay(SRC.id), "{ not json");
  const broken = bin(["agents", "configure", "--harness", SRC.id, "--default", "opus", "--project", proj]);
  assert.equal(broken.status, 1); assert.match(broken.stderr, /not valid JSON/); assert.equal(broken.stdout, "");
});

test("overlay contract 4: a rebind over an existing overlay leaves the overlay alone and the binding carries no agents key", () => {
  const { proj } = seedCliVault();
  writeOverlayAt(proj, SRC.id, { default: "opus", per_agent: { clerk: "sonnet" } });
  const overlayBefore = read(layoutPaths(proj).overlay(SRC.id));
  const cfgBefore = readConfigAt(proj);
  const other = mkdtempSync(join(TMP, "ps-overlay-vault-"));
  const r = bin(["bind", other, "--rebind", "--json", "--project", proj]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfg = readConfigAt(proj);
  assert.equal(cfg.vault_path, other);
  assert.ok(!("agents" in cfg), "no overlay key leaks into the binding");
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(cfgBefore).sort(), "byte-equal but for the rebound keys: the key set is the same");
  for (const k of Object.keys(cfgBefore)) if (k !== "vault_path") assert.deepEqual(cfg[k], cfgBefore[k], `${k} is not a rebound key`);
  assert.equal(read(layoutPaths(proj).overlay(SRC.id)), overlayBefore, "the overlay is not the binding writer's");
});

test("overlay: the prose resolves models through the verb, never by restating the rule; the manifest names its overlay", () => {
  for (const f of ["commands/review.md", "commands/story.md", "commands/reconcile.md", "commands/agents.md"]) {
    const t = read(join(ROOT, f));
    assert.ok(t.includes("agents model") || t.includes("agents show"), `${f} calls the verb`);
    assert.ok(!/from `\.projectstore\/harness\/<harness>\.json` \(the active harness's overlay[^)]*\) and pass it/.test(t), `${f} does not restate the two-term rule as a file read`);
  }
  assert.equal(JSON.parse(read(join(ROOT, "harnesses", "claude-code.json"))).runtime.overlay, SRC.id);
});

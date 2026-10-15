// projectstore — tests/effort.test.mjs: per-agent effort (the ADR "Agent
// effort is passed at spawn beside the model, from the overlay, in each
// harness's own levels"; the story "Per-agent effort returns, and it decides
// how roles are delivered", PS-AGENTS). One test per acceptance criterion
// where the criterion is code: the manifests, the overlay and its verbs,
// configure's keys and notes, the menu's row, doctor, and the texts that
// spawn an agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadHarness, loadHarnesses, sourceHarness } from "../scripts/harness.mjs";
import {
  effortSpec,
  effortProblem,
  effortLevels,
  offLevelNote,
  standingLevelNote,
  entriesOf,
  knownModels,
  readLive,
  modelCachePath,
} from "../scripts/models.mjs";
import { readOverlayAt, writeOverlayAt, resolveAgentEffort, layoutPaths, readConfigAt } from "../scripts/lib.mjs";
import { runConfigure, settingsOf, readFacts } from "../scripts/configure.mjs";
import { menuGroups } from "../scripts/configure-menu.mjs";
import { createMenu, renderMenu } from "../scripts/menu.mjs";
import { checkOverlays, checkEnvEffort } from "../scripts/doctor.mjs";
import { ALT_OFF, PLAIN } from "../scripts/term.mjs";
import { run } from "../scripts/cli.mjs";
import { renderCodexAdapter } from "../scripts/build-adapters.mjs";
import { SHELLS, SHELLS_DIR } from "../packaging/shells.mjs";
import { writeBinding } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CC = loadHarness("claude-code");
const CODEX = loadHarness("codex");
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const KEYS = { DOWN: "\x1b[B", RIGHT: "\x1b[C", ENTER: "\r", SPACE: " " };

// Codex's own catalog, as models_cache.json holds it (measured 2026-10-14):
// each model names the levels it takes and its default.
const levels = (...ids) => ids.map((effort) => ({ effort, description: `${effort} words` }));
const CATALOG = {
  // Noon UTC: the same calendar day in every time zone a note's date is read in.
  fetched_at: "2026-10-14T12:00:00Z",
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Frontier.",
      visibility: "list",
      priority: 1,
      supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max", "ultra"),
      default_reasoning_level: "low",
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Workhorse.",
      visibility: "list",
      priority: 2,
      supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max", "ultra"),
      default_reasoning_level: "low",
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      description: "Cheap.",
      visibility: "list",
      priority: 3,
      supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max"),
      default_reasoning_level: "medium",
    },
  ],
};
function codexHome() {
  const h = tmp("ps-eff-codex-");
  writeFileSync(join(h, "models_cache.json"), JSON.stringify(CATALOG));
  return h;
}

// A bound project using the named harnesses, with its own home.
function project(harnesses = [SRC]) {
  const proj = tmp("ps-eff-");
  for (const h of harnesses)
    if (h === SRC) mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
    else mkdirSync(layoutPaths(proj).harnessState(h.id), { recursive: true });
  writeBinding(proj, { vault_path: tmp("ps-eff-vault-"), layout: "engineering" });
  return { proj, home: tmp("ps-eff-home-") };
}
const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (s) => (chunks.push(String(s)), true), text: () => chunks.join("") };
};
async function configure(p, values, env = {}) {
  const out = sink();
  const err = sink();
  const r = await runConfigure({
    values,
    project: p.proj,
    env,
    stdin: null,
    stdout: out,
    stderr: err,
    ask: null,
    root: ROOT,
    home: p.home,
    proc: new EventEmitter(),
    nearest: () => null,
  });
  return { r, text: out.text(), err: err.text() };
}
async function bin(args) {
  const out = sink();
  const err = sink();
  const code = await run(args, { stdout: out, stderr: err, env: {}, stdin: null });
  return { code, out: out.text(), err: err.text() };
}

// ─── The manifests (decision 3) ────────────────────────────────────────

test("effort AC: each manifest declares its effort vocabulary, and the schema check refuses a malformed block", () => {
  for (const m of loadHarnesses().values()) assert.equal(effortProblem(m), null, m.id);
  assert.equal(effortSpec(CC).spawn_param, "effort");
  assert.deepEqual(
    effortSpec(CC).levels.map((l) => l.id),
    ["low", "medium", "high", "xhigh", "max"],
    "Claude Code's levels are the Agent tool's enum",
  );
  assert.equal(effortSpec(CC).strict, true);
  assert.equal(effortSpec(CC).unset.model_default, false);
  assert.equal(effortSpec(CC).cheap, "low", "the clerk's level on Claude Code, the maintainer's choice of 2026-10-14");
  assert.equal(effortSpec(CODEX).spawn_param, "reasoning_effort");
  assert.equal(effortSpec(CODEX).catalog.default, "default_reasoning_level");
  assert.equal(effortSpec(CODEX).unset.model_default, true);
  assert.equal(effortSpec(CODEX).cheap, "low");
  for (const k of ["effort_key", "effort_levels", "effort_precedence"])
    assert.equal(CODEX.agent_translation[k], undefined, `${k} folded into the effort block`);
  const bad = (effort) => ({ id: "x", agent_translation: { effort } });
  const base = structuredClone(effortSpec(CC));
  assert.match(effortProblem(bad({ ...base, spawn_param: "" })), /spawn_param/);
  assert.match(effortProblem(bad({ ...base, levels: [] })), /levels/);
  assert.match(effortProblem(bad({ ...base, levels: [{ id: "Max", description: "x" }] })), /a level/);
  assert.match(effortProblem(bad({ ...base, unset: { value: "x" } })), /unset/);
  assert.match(effortProblem(bad({ ...base, cheap: "turbo", cheap_reason: "x" })), /cheap/);
  assert.match(effortProblem(bad({ ...base, spawn_param_evidence: "guessed" })), /spawn_param_evidence/);
  assert.match(
    effortProblem(bad({ ...base, cheap: "low", cheap_reason: "x", cheap_evidence: undefined })),
    /cheap_evidence/,
  );
  assert.match(effortProblem(bad({ ...base, catalog: { list: "l", id: "effort", reason: "r" } })), /models block/);
  assert.equal(effortProblem({ id: "y", agent_translation: {} }), null, "a harness without the block passes none");
});

// ─── models.mjs: a model's own levels (decisions 3 and 5) ──────────────

test("effort AC: a Codex model's levels come from its catalog entry and survive the cache; an older cache falls through to the file", async () => {
  const home = codexHome();
  const env = { CODEX_HOME: home };
  const userHome = tmp("ps-eff-uh-");
  // The clock is the test's: a list dated after "now" is set aside, so a
  // real clock would make the cache case below depend on the hour it runs.
  const now = () => Date.parse("2026-10-14T13:00:00Z");
  const k = knownModels(CODEX, { env, home: userHome, now });
  assert.deepEqual(
    effortLevels(CODEX, "gpt-5.6-luna", k).levels.map((l) => l.id),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(effortLevels(CODEX, "gpt-5.6-luna", k).default, "medium");
  assert.equal(effortLevels(CODEX, "gpt-5.6-luna", k).from, "catalog");
  assert.equal(effortLevels(CODEX, "unknown-model", k).from, "floor");
  assert.equal(effortLevels(CODEX, null, k).levels.at(-1).id, "ultra", "the floor ends at ultra");
  assert.equal(effortLevels(CC, "opus", knownModels(CC, { env: {}, home: userHome })).from, "floor");
  // Entries without levels read exactly as before: no levels key at all.
  const rows = entriesOf({ m: [{ id: "a" }] }, { list: "m", id: "id" }, effortSpec(CODEX).catalog);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["description", "family", "hidden", "id", "label"]);
  // A cache written before levels were kept is newer than the file: the
  // levels still come from the file.
  const cache = modelCachePath(CODEX, { env: { XDG_CACHE_HOME: join(userHome, "c") }, home: userHome });
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(
    cache,
    JSON.stringify({ at: "2026-10-14T12:30:00Z", source: "Codex", models: [{ id: "gpt-5.6-luna", label: "L" }] }),
  );
  const k2 = knownModels(CODEX, { env: { ...env, XDG_CACHE_HOME: join(userHome, "c") }, home: userHome, now });
  assert.equal(effortLevels(CODEX, "gpt-5.6-luna", k2).from, "catalog");
  // A live read caches the levels it read.
  // The command catalog runs only when its bin is on PATH: a stub stands in,
  // and the injected spawn answers for it.
  const stubBin = tmp("ps-eff-bin-");
  writeFileSync(join(stubBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const live = await readLive(CODEX, {
    env: { ...env, XDG_CACHE_HOME: join(userHome, "d"), PATH: stubBin },
    home: userHome,
    now: () => Date.parse("2026-10-14T10:00:00Z"),
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ models: CATALOG.models })));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(live.error, undefined, JSON.stringify(live));
  {
    const written = json(modelCachePath(CODEX, { env: { XDG_CACHE_HOME: join(userHome, "d") }, home: userHome }));
    const luna = written.models.find((m) => m.id === "gpt-5.6-luna");
    assert.equal(luna.default_level, "medium");
    assert.equal(luna.levels.length, 5);
  }
});

test("effort AC: the notes — off Claude Code's levels (and refused at spawn), off a Codex model's own list, off the floor, and a level an agent keeps", () => {
  const k = knownModels(CODEX, { env: { CODEX_HOME: codexHome() }, home: tmp("ps-eff-uh-") });
  assert.equal(
    offLevelNote(CC, "ultra", "opus", null),
    "ultra is not one of Claude Code's effort levels (low, medium, high, xhigh, max); written as typed, and Claude Code refuses it at spawn",
  );
  assert.equal(offLevelNote(CC, "xhigh", "fable", null), null);
  assert.equal(
    offLevelNote(CODEX, "ultra", "gpt-5.6-luna", k),
    "gpt-5.6-luna does not list ultra in Codex's list as of 2026-10-14; written as typed",
  );
  assert.equal(
    offLevelNote(CODEX, "turbo", "unknown-model", k),
    "turbo is not one of Codex's effort levels (low, medium, high, xhigh, max, ultra); written as typed",
  );
  assert.equal(offLevelNote(CODEX, "ultra", "gpt-6-astra", k), null);
  assert.equal(
    standingLevelNote(CODEX, "critic", "ultra", "gpt-5.6-luna", k),
    "critic runs at ultra, which gpt-5.6-luna does not list in Codex's list as of 2026-10-14",
  );
});

// ─── The overlay and its verbs (decisions 1, 2 and 8) ──────────────────

test("effort AC: effort resolves per field — own, else the default's — independent of the model; agents model and agents show answer it", async () => {
  const p = project();
  writeOverlayAt(
    p.proj,
    SRC.id,
    { default: "opus", per_agent: { critic: "fable" } },
    { default: "medium", per_agent: { critic: "xhigh", reviewer: "high" } },
  );
  const r = (n) => resolveAgentEffort(p.proj, n, { harness: SRC.id });
  assert.deepEqual([r("critic").effort, r("critic").source], ["xhigh", "per_agent"]);
  assert.deepEqual([r("planner").effort, r("planner").source], ["medium", "default"]);
  assert.deepEqual(
    [r("reviewer").effort, r("reviewer").source],
    ["high", "per_agent"],
    "an agent with no model of its own still has its effort",
  );
  writeOverlayAt(p.proj, SRC.id, { default: null, per_agent: {} }, { default: null, per_agent: {} });
  assert.deepEqual([r("critic").effort, r("critic").source], [null, null], "nothing configured passes nothing");
  writeOverlayAt(
    p.proj,
    SRC.id,
    { default: "opus", per_agent: { critic: "fable" } },
    { default: "medium", per_agent: { critic: "xhigh" } },
  );
  const m = await bin(["agents", "model", "critic", "--json", "--harness", SRC.id, "--project", p.proj]);
  const res = JSON.parse(m.out).result;
  assert.deepEqual([res.model, res.effort, res.effort_source], ["fable", "xhigh", "per_agent"]);
  const text = await bin(["agents", "model", "planner", "--harness", SRC.id, "--project", p.proj]);
  assert.match(text.out, /^planner: opus \(default, [^)]+\); effort medium \(default\)\n$/);
  const show = await bin(["agents", "show", "--harness", SRC.id, "--project", p.proj]);
  assert.match(show.out, /\n {2}default effort: medium\n/);
  assert.match(show.out, /\n {2}critic: fable \(per_agent\), effort xhigh \(per_agent\)\n/);
  const sj = JSON.parse((await bin(["agents", "show", "--json", "--harness", SRC.id, "--project", p.proj])).out).result;
  assert.deepEqual(sj.efforts, { default: "medium", per_agent: { critic: "xhigh" } });
  assert.equal(sj.resolved.planner.effort, "medium");
});

test("effort AC: agents configure keeps every effort it is not asked about; --reset drops them and says so", async () => {
  const p = project();
  writeOverlayAt(
    p.proj,
    SRC.id,
    { default: "opus", per_agent: { clerk: "sonnet" } },
    { default: "medium", per_agent: { critic: "xhigh" } },
  );
  const a = await bin(["agents", "configure", "--harness", SRC.id, "--agent", "critic=sonnet", "--project", p.proj]);
  assert.equal(a.code, 0, a.err);
  const o = readOverlayAt(p.proj, SRC.id);
  // The standing default effort pins the clerk on the way, as a standing
  // default model pins its model; nothing else moves.
  assert.deepEqual(o.efforts, { default: "medium", per_agent: { critic: "xhigh", clerk: "low" } });
  assert.match(a.out, /\n {2}clerk effort: — → low \(pinned: the clerk stays cheap under a strong default\)\n/);
  assert.equal(o.agents.per_agent.critic, "sonnet");
  const b = await bin(["agents", "configure", "--harness", SRC.id, "--reset", "--project", p.proj]);
  assert.match(b.out, /\n {2}default effort: medium → —\n/);
  assert.match(b.out, /\n {2}critic effort: xhigh → —\n/);
  assert.deepEqual(readOverlayAt(p.proj, SRC.id).efforts, { default: null, per_agent: {} });
});

// ─── configure: the keys, the plan, the notes (decisions 4–6) ──────────

test("effort AC: the maintainer's Claude Code pins — four keys and the clerk's pins; read back as fable/xhigh, opus/medium, sonnet/low", async () => {
  const p = project();
  const { r, text } = await configure(p, {
    set: ["agents.critic=fable", "agents.critic.effort=xhigh", "agents.default=opus", "agents.default.effort=medium"],
    harness: [SRC.id],
  });
  assert.equal(r.code, 0, text);
  assert.match(text, /agents\.default\.effort +— → medium/);
  assert.match(text, /agents\.critic\.effort +— → xhigh/);
  assert.match(
    text,
    /agents\.clerk\.effort +— → low[^\n]*\n +pinned: the clerk stays cheap under a strong default/,
    "a default effort pins the clerk to Claude Code's cheap level, as on Codex",
  );
  assert.deepEqual(json(layoutPaths(p.proj).overlay(SRC.id)).agents, {
    default: { model: "opus", effort: "medium" },
    per_agent: { clerk: { model: "sonnet", effort: "low" }, critic: { model: "fable", effort: "xhigh" } },
  });
  for (const [n, model, effort] of [
    ["critic", "fable", "xhigh"],
    ["planner", "opus", "medium"],
    ["clerk", "sonnet", "low"],
  ]) {
    const res = JSON.parse(
      (await bin(["agents", "model", n, "--json", "--harness", SRC.id, "--project", p.proj])).out,
    ).result;
    assert.deepEqual([res.model, res.effort], [model, effort], n);
  }
});

test("effort AC: the Codex pins — sol/xhigh by default, astra/xhigh for the critic, the librarian at medium, the clerk pinned to luna/low", async () => {
  const p = project([CODEX]);
  const env = { CODEX_HOME: codexHome() };
  const { r, text } = await configure(
    p,
    {
      set: [
        "agents.default=gpt-5.6-sol",
        "agents.default.effort=xhigh",
        "agents.critic=gpt-6-astra",
        "agents.critic.effort=xhigh",
        "agents.librarian.effort=medium",
      ],
      harness: ["codex"],
    },
    env,
  );
  assert.equal(r.code, 0, text);
  assert.match(text, /agents\.clerk\.effort +— → low[^\n]*\n +pinned: the clerk stays cheap under a strong default/);
  const a = json(layoutPaths(p.proj).overlay("codex")).agents;
  assert.deepEqual(a.default, { model: "gpt-5.6-sol", effort: "xhigh" });
  assert.deepEqual(a.per_agent.critic, { model: "gpt-6-astra", effort: "xhigh" });
  assert.deepEqual(a.per_agent.librarian, { effort: "medium" });
  assert.deepEqual(a.per_agent.clerk, { model: "gpt-5.6-luna", effort: "low" });
  // A clerk effort named by the run wins over the pin.
  const q = project([CODEX]);
  await configure(q, { set: ["agents.default.effort=high", "agents.clerk.effort=medium"], harness: ["codex"] }, env);
  assert.equal(json(layoutPaths(q.proj).overlay("codex")).agents.per_agent.clerk.effort, "medium");
});

test("effort AC: off-list levels are written with their notes — on the effort's row, on a model change's row, on the default's row for agents that inherit it — and --json carries them", async () => {
  const cc = project();
  const a = await configure(cc, { set: ["agents.critic.effort=ultra"], json: true });
  assert.equal(a.r.code, 0);
  assert.match(a.r.result.plan[0].note, /ultra is not one of Claude Code's effort levels .*refuses it at spawn/);
  assert.equal(readOverlayAt(cc.proj, SRC.id).efforts.per_agent.critic, "ultra", "written as typed");
  const env = { CODEX_HOME: codexHome() };
  const p = project([CODEX]);
  await configure(
    p,
    {
      set: [
        "agents.default=gpt-5.6-sol",
        "agents.critic=gpt-6-astra",
        "agents.critic.effort=ultra",
        "agents.reviewer=gpt-5.6-luna",
      ],
      harness: ["codex"],
    },
    env,
  );
  // The model change: the critic keeps ultra and moves to luna.
  const b = await configure(p, { set: ["agents.critic=gpt-5.6-luna"], harness: ["codex"], json: true }, env);
  assert.equal(
    b.r.result.plan.find((i) => i.key === "agents.critic").note,
    "critic runs at ultra, which gpt-5.6-luna does not list in Codex's list as of 2026-10-14",
  );
  // A level the run names for a model that lacks it.
  const c = await configure(p, { set: ["agents.reviewer.effort=ultra"], harness: ["codex"], json: true }, env);
  assert.equal(
    c.r.result.plan[0].note,
    "gpt-5.6-luna does not list ultra in Codex's list as of 2026-10-14; written as typed",
  );
  // A default level, for an agent that inherits it on a model of its own.
  const q = project([CODEX]);
  await configure(q, { set: ["agents.default=gpt-5.6-sol", "agents.reviewer=gpt-5.6-luna"], harness: ["codex"] }, env);
  const d = await configure(q, { set: ["agents.default.effort=ultra"], harness: ["codex"], json: true }, env);
  assert.equal(
    d.r.result.plan.find((i) => i.key === "agents.default.effort").note,
    "reviewer runs at ultra, which gpt-5.6-luna does not list in Codex's list as of 2026-10-14",
  );
  // Clearing an agent's own model moves it onto the default's: the level it
  // keeps is checked against that model too.
  const r = project([CODEX]);
  await configure(
    r,
    {
      set: ["agents.default=gpt-5.6-luna", "agents.critic=gpt-6-astra", "agents.critic.effort=ultra"],
      harness: ["codex"],
    },
    env,
  );
  const cleared = await configure(r, { set: ["agents.critic=-"], harness: ["codex"], json: true }, env);
  assert.equal(
    cleared.r.result.plan.find((i) => i.key === "agents.critic").note,
    "critic runs at ultra, which gpt-5.6-luna does not list in Codex's list as of 2026-10-14",
  );
  // A level the list holds carries no note.
  const e = await configure(q, { set: ["agents.critic.effort=high"], harness: ["codex"], json: true }, env);
  assert.equal(e.r.result.plan[0].note, undefined);
});

test("effort AC: the view and --json name each agent's effort with its source — frontmatter on Claude Code, the model's default or the harness on Codex", async () => {
  const p = project([SRC, CODEX]);
  const env = { CODEX_HOME: codexHome() };
  await configure(p, { set: ["agents.critic=gpt-6-astra"], harness: ["codex"] }, env);
  const { r } = await configure(p, { json: true }, env);
  const s = Object.fromEntries(r.result.settings.map((x) => [`${x.harness}:${x.key}`, x]));
  assert.equal(s["claude-code:agents.critic.effort"].source, "frontmatter");
  assert.equal(s["claude-code:agents.critic.effort"].set, "--set agents.critic.effort=<level> --harness claude-code");
  assert.deepEqual(
    [s["codex:agents.critic.effort"].source, s["codex:agents.critic.effort"].model_default],
    ["model_default", "low"],
  );
  assert.equal(s["codex:agents.planner.effort"].source, "harness", "no model passed: Codex's own precedence");
  const { text } = await configure(p, {}, env);
  assert.match(text, /agents\.critic\.effort +— +its model's own default, low/);
});

// ─── The menu (decision 4; presentation spec contract 14) ──────────────

test("effort AC: the menu draws an effort row under each model row; its levels follow the model the agent will run on, a pending change counted", () => {
  const p = project([SRC, CODEX]);
  const env = { CODEX_HOME: codexHome() };
  writeOverlayAt(p.proj, "codex", { default: "gpt-5.6-sol", per_agent: {} }, { default: null, per_agent: {} });
  const f = readFacts(p.proj, { root: ROOT, home: p.home, env });
  const catalogs = Object.fromEntries(f.used.map((h) => [h.id, { known: knownModels(h, { env, home: p.home }) }]));
  let menu = null;
  const groups = menuGroups(f, settingsOf(f), catalogs, { menu: () => menu });
  menu = createMenu({ groups });
  const cx = groups.find((g) => g.title === "Agents · Codex");
  const labels = cx.items.map((i) => `${i.indent ? " ".repeat(i.indent) : ""}${i.label}`);
  assert.deepEqual(labels.slice(0, 4), ["default", "  effort", "critic", "  effort"]);
  const critic = cx.items.find((i) => i.key === "agents.critic");
  const effort = cx.items.find((i) => i.key === "agents.critic.effort");
  assert.equal(effort.title, "Codex · critic · effort");
  assert.equal(effort.display(null), "low (gpt-5.6-sol's default)");
  const values = () =>
    effort
      .options()
      .filter((o) => o.kind === "value" && o.value)
      .map((o) => o.value);
  assert.deepEqual(values(), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  menu.set(critic, "gpt-5.6-luna");
  assert.deepEqual(values(), ["low", "medium", "high", "xhigh", "max"], "a pending model change limits the levels");
  assert.equal(effort.options().find((o) => o.value === "medium").note, "default");
  assert.match(effort.caption().text, /^levels of gpt-5\.6-luna · Codex · checked /);
  assert.equal(effort.options().at(-1).label, "use the default");
  const def = cx.items.find((i) => i.key === "agents.default.effort");
  assert.equal(def.options().at(-1).label, "let Codex decide");
  const ccDef = groups
    .find((g) => g.title === "Agents · Claude Code")
    .items.find((i) => i.key === "agents.default.effort");
  assert.equal(ccDef.options().at(-1).label, "use frontmatter");
  assert.equal(ccDef.display(null), "frontmatter");
  for (const o of [...effort.options(), ...def.options()]) assert.ok(o.description, `${o.label} has a description`);
  // Drawn at 100, 80 and 40 columns, every line within the width; the effort
  // row is indented under its model row and the frame names its agent.
  for (const columns of [100, 80, 40]) {
    const m = createMenu({ groups });
    for (let i = 0; i < groups.indexOf(cx); i++) m.press("down");
    m.press("right");
    m.press("down");
    m.press("down");
    m.press("down");
    m.press("right");
    const lines = renderMenu(m, { caps: PLAIN, columns, rows: 30, path: "/p" }).map((l) =>
      typeof l === "string" ? l : l.map((s) => s.text ?? s).join(""),
    );
    for (const l of lines) assert.ok([...l].length <= columns - 1, `${columns}: ${l}`);
    assert.ok(
      lines.some((l) => /critic · effort/.test(l)),
      `${columns}: the frame or path names critic · effort`,
    );
  }
});

test("effort AC: in a real menu, choosing a level for the critic writes it after the review's second Enter", async () => {
  const p = project();
  const items = settingsOf(readFacts(p.proj, { root: ROOT, home: p.home })).filter((s) =>
    s.group.startsWith("agents:"),
  );
  const at = items.findIndex((s) => s.key === "agents.critic.effort");
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => ((stdin.isRaw = on), stdin);
  const chunks = [];
  let since = "";
  let stage = 0;
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 30,
    write: (x) => {
      chunks.push(String(x));
      since += String(x);
      if (stage === 1 && /Plan — 1 change/.test(since.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) {
        stage = 2;
        setTimeout(() => stdin.write(KEYS.ENTER), 30);
      }
      return true;
    },
  });
  // Into the agents group, down to the critic's effort row, open it, take
  // xhigh (the fourth level), and review.
  setImmediate(() => {
    stage = 1;
    // The cursor opens on the value in effect, so the level is reached by
    // its letter.
    stdin.write([KEYS.RIGHT, ...Array(at).fill(KEYS.DOWN), KEYS.RIGHT, "x", KEYS.SPACE, KEYS.ENTER].join(""));
  });
  const r = await runConfigure({
    values: {},
    project: p.proj,
    env: {},
    stdin,
    stdout,
    stderr: sink(),
    ask: async () => "y",
    root: ROOT,
    home: p.home,
    proc: Object.assign(new EventEmitter(), { pid: 4242, kill: () => true }),
    escapeMs: 20,
    nearest: () => null,
  });
  const after = chunks
    .join("")
    .split(ALT_OFF)
    .at(-1)
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(r.code, 0, after);
  assert.match(after, /agents\.critic\.effort +— → xhigh/);
  assert.equal(readOverlayAt(p.proj, SRC.id).efforts.per_agent.critic, "xhigh");
});

// ─── Doctor (decision 7) ───────────────────────────────────────────────

test("effort AC: doctor reads the effort keys, warns on a level off the harness's list, and env-effort names the overlay it outranks", () => {
  const p = project();
  writeOverlayAt(
    p.proj,
    SRC.id,
    { default: "opus", per_agent: {} },
    { default: "medium", per_agent: { critic: "Max" } },
  );
  const f = checkOverlays(readConfigAt(p.proj), p.proj);
  assert.equal(f.filter((x) => x.check === "overlay-forbidden-key").length, 0, "effort keys are read");
  const off = f.filter((x) => x.check === "overlay-unknown-effort");
  assert.equal(off.length, 1);
  assert.equal(off[0].level, "warn");
  assert.match(
    off[0].message,
    /agents\.per_agent\.critic\.effort` to Max, which is not one of Claude Code's effort levels/,
  );
  const had = Object.hasOwn(process.env, "CLAUDE_CODE_EFFORT_LEVEL");
  const prev = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  try {
    const [e] = checkEnvEffort(p.proj);
    assert.equal(e.check, "env-effort");
    assert.match(
      e.message,
      /outranks every effort projectstore passes at spawn \(\.projectstore\/harness\/claude-code\.json sets agents\.default\.effort, agents\.per_agent\.critic\.effort\)/,
    );
    assert.doesNotMatch(e.message, /not configurable/);
    const [bare] = checkEnvEffort();
    assert.doesNotMatch(bare.message, /sets agents/);
  } finally {
    if (had) process.env.CLAUDE_CODE_EFFORT_LEVEL = prev;
    else delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  }
});

// ─── The texts that spawn an agent (decision 2) ────────────────────────

test("effort AC: every text that spawns an agent passes the resolved effort; no bundled text says effort cannot be configured", () => {
  const tmpl = read(join(ROOT, "templates", "claude-md-block.md.tmpl"));
  assert.match(tmpl, /projectstore:agents v5 /);
  assert.match(tmpl, /agents\.per_agent\.<name>\.effort \?\? agents\.default\.effort/);
  assert.match(tmpl, /the effort only when the spawn offers\s+one/);
  assert.equal(read(join(ROOT, "AGENTS.md")), tmpl, "this repository's block is the template's");
  for (const c of ["review", "story", "reconcile", "agents"])
    assert.match(read(join(ROOT, "commands", `${c}.md`)), /`result\.effort`/, `commands/${c}.md`);
  // A session picks the command by its description: "set the critic's effort"
  // must find the agents command on both harnesses.
  const description = (text) => /^description: (.*)$/m.exec(text)?.[1] || "";
  assert.match(description(read(join(ROOT, "commands", "agents.md"))), /effort/, "the agents command names effort");
  const rendered = renderCodexAdapter();
  assert.match(
    description(rendered.get("skills/projectstore-agents/SKILL.md")),
    /efforts/,
    "the Codex agents skill names effort",
  );
  for (const role of ["critic", "planner", "reviewer", "librarian", "archaeologist", "clerk"])
    assert.match(rendered.get(`skills/projectstore-${role}/SKILL.md`), /pass it as `reasoning_effort`/, role);
  const stale = [
    /not configurable per project/i,
    /Do not ask about effort/,
    /Do not offer effort/,
    /reasoning-effort override/,
    /per-role effort belongs/,
    /effort is outside this integration/,
  ];
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const rel = join(d, n.name);
      if (n.isDirectory()) walk(rel);
      else if (/\.(md|mjs|json|tmpl)$/.test(n.name))
        for (const re of stale) if (re.test(read(join(ROOT, rel)))) hits.push(`${rel}: ${re}`);
    }
  };
  for (const d of ["commands", "agents", "skills", "templates", "docs", "adapters", "harnesses", "packaging/shells"])
    walk(d);
  for (const f of ["README.md", "AGENTS.md", "scripts/build-adapters.mjs", "scripts/doctor.mjs"])
    for (const re of stale) if (re.test(read(join(ROOT, f)))) hits.push(`${f}: ${re}`);
  assert.deepEqual(hits, []);
});

// "If the result names a model, pass that model" let a parent read "that model"
// as its own: on gpt-5.6-sol at low it passed its own slug in 2 of 3 runs from
// npm 0.30.5 (the story "Codex role skills pass the model the core names,
// verbatim", PS-HARNESS). So every role skill, the committed one and the Codex
// shell's copy, names the two fields, says what null means for each, and says
// not to substitute the running model. It names no example model either: an
// example is one more name a parent could pass instead of `result.model`.
test("Codex role skills pass `result.model` and `result.effort` verbatim, never the running model", () => {
  const flat = (t) => t.replace(/\s+/g, " ");
  const roles = readdirSync(join(ROOT, "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length));
  assert.ok(roles.length > 0, "no role, so this test would prove nothing");
  const trees = [
    CODEX.output_dir,
    ...SHELLS.filter((s) => s.harness === CODEX.id && s.plugin_root).map((s) => join(SHELLS_DIR, s.name)),
  ];
  assert.equal(trees.length, 2, "the adapter and the Codex shell");
  const effort = CODEX.agent_translation.effort.spawn_param;
  // Every slug the Codex manifest names (its cheap model and its static list)
  // and every slug of the measured catalog above.
  const slugs = [
    CODEX.agent_translation.cheap_model,
    ...(CODEX.agent_translation.models.static || []).map((m) => m.id),
    ...CATALOG.models.map((m) => m.slug),
  ].filter(Boolean);
  assert.ok(slugs.length > 0, "no slug to look for, so the no-example half would prove nothing");
  for (const tree of trees)
    for (const role of roles) {
      const rel = join(tree, "skills", CODEX.surfaces.agents.rendered_name.replace("<name>", role), "SKILL.md");
      const text = flat(read(join(ROOT, rel)));
      const spawn = text.slice(text.indexOf("## Codex orchestration"), text.indexOf("## Role contract"));
      assert.ok(spawn.length > 0, `${rel}: carries the orchestration section`);
      assert.ok(text.includes("pass `result.model` exactly as `model`"), `${rel}: names result.model`);
      assert.ok(text.includes("Never substitute your own model for it"), `${rel}: not the running model`);
      assert.ok(text.includes("If `result.model` is `null`, pass no model at all"), `${rel}: null model`);
      assert.ok(text.includes(`If \`result.effort\` is a string, pass it as \`${effort}\`, verbatim`), rel);
      assert.ok(text.includes("If `result.effort` is `null`, pass none"), `${rel}: null effort`);
      assert.doesNotMatch(spawn, /for example|e\.g\./i, `${rel}: no example in the spawn sentences`);
      assert.deepEqual(
        slugs.filter((slug) => spawn.includes(slug)),
        [],
        `${rel}: the spawn sentences name no model`,
      );
      assert.ok(!text.includes("If the result names a model, pass that model"), `${rel}: the old wording is gone`);
    }
});

// projectstore — tests/models.test.mjs: the models a harness's agents can be
// started with (the ADR "Agent model lists are read from each harness's own
// catalog, declared in its manifest and cached for a day"; the story
// "configure at a terminal is one settings menu…", PS-HARNESS). Every read is
// given its env, home, clock and spawn: no test reads the machine. Claude
// Code's list is its aliases and nothing is read for it (the 0.30.7 story,
// PS-DIRECTORY); the generic alias reading is held on a stub harness below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadHarness, loadHarnesses } from "../scripts/harness.mjs";
import {
  modelSpec,
  knownModels,
  readLive,
  offListNote,
  modelCachePath,
  modelsProblem,
  entriesOf,
  FRESH_MS,
} from "../scripts/models.mjs";

const CC = loadHarness("claude-code");
const CODEX = loadHarness("codex");
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const NOW = Date.parse("2026-10-13T12:00:00Z");

// Codex's own catalog file, as codex-cli 0.162.1 wrote it (trimmed).
const CODEX_CATALOG = {
  fetched_at: "2026-10-13T06:32:57Z",
  client_version: "0.162.1",
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier.", visibility: "list", priority: 2 },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", description: "Workhorse.", visibility: "list", priority: 1 },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", description: "Hidden.", visibility: "hide", priority: 4 },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", description: "Fast.", visibility: "list", priority: 4 },
  ],
};

// An alias catalog's answer: each entry names the line its alias follows (the
// shape of Anthropic's model list, measured 2026-10-13, trimmed).
const ALIAS_ANSWER = {
  data: [
    {
      id: "claude-haiku-5-5",
      display_name: "Claude Haiku 5.5",
      created_at: "2026-10-07T18:00:00Z",
      line: "haiku",
      lifecycle: "active",
    },
    {
      id: "claude-opus-5-5",
      display_name: "Claude Opus 5.5",
      created_at: "2026-09-21T16:24:00Z",
      line: "opus",
      lifecycle: "active",
    },
    {
      id: "claude-fable-5-1",
      display_name: "Claude Fable 5.1",
      created_at: "2026-08-28T00:00:00Z",
      line: "fable",
      lifecycle: "active",
    },
    {
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      created_at: "2026-07-24T00:00:00Z",
      line: "opus",
      lifecycle: "active",
    },
    {
      id: "claude-sonnet-4-0",
      display_name: "Claude Sonnet 4",
      created_at: "2025-05-22T00:00:00Z",
      line: "sonnet",
      lifecycle: "retired",
    },
  ],
  has_more: false,
};

// An alias harness that declares a catalog: what `follows`, `keep_when`,
// `order_desc` and a cache's caption are read from. No shipped manifest is
// one since Claude Code's catalog went (the 0.30.7 story, PS-DIRECTORY).
const ALIASED = {
  id: "aliased",
  display_name: "Aliased",
  agent_translation: {
    models: {
      spawn_takes: "alias",
      spawn_takes_reason: "a stub",
      static: ["fable", "opus", "sonnet", "haiku"].map((id) => ({ id, family: id })),
      catalogs: [
        {
          kind: "command",
          source: "the stub catalog",
          caption: "Stub",
          argv: ["aliased-models"],
          fields: {
            list: "data",
            id: "id",
            label: "display_name",
            family: "line",
            order: "created_at",
            order_desc: true,
            keep_when: { lifecycle: "active" },
          },
          reason: "a stub",
        },
      ],
    },
  },
};

// The cache 0.30.6 wrote for Claude Code from Anthropic's model list.
const CACHE_0_30_6 = readFileSync(new URL("./fixtures/models-cache-claude-code-0.30.6.json", import.meta.url), "utf8");

function codexHome(catalog = CODEX_CATALOG) {
  const dir = tmp("ps-models-codex-");
  if (catalog) writeFileSync(join(dir, "models_cache.json"), JSON.stringify(catalog));
  return dir;
}

// A directory for PATH with an executable of that name: a command catalog
// runs only when its bin is there, and the injected spawn answers for it.
function stubBin(name) {
  const dir = tmp("ps-models-bin-");
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

// A catalog command's child: it prints `out` and exits with `code`, or never
// answers.
function fakeChild(out, { code = 0, hang = false } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.kill = (sig) => {
    c.killed = sig;
    return true;
  };
  setImmediate(() => {
    if (hang) return;
    c.stdout.end(out);
    c.stdout.on("end", () => c.emit("close", code, null));
    c.stdout.resume();
  });
  return c;
}

test("models ADR decision 2: both manifests declare their list; every catalog is a file or a command with its fields", () => {
  for (const m of loadHarnesses().values()) {
    const spec = modelSpec(m);
    if (!spec) continue;
    assert.ok(["alias", "id"].includes(spec.spawn_takes), `${m.id}: spawn_takes`);
    assert.ok(Array.isArray(spec.static), `${m.id}: static`);
    for (const c of spec.catalogs || []) {
      assert.ok(["file", "command"].includes(c.kind), `${m.id}: ${c.kind}`);
      const fields = { ...(spec.fields || {}), ...(c.fields || {}) };
      assert.ok(fields.list && fields.id, `${m.id}: a ${c.kind} catalog names its list and id`);
      if (c.kind === "command") assert.ok(Array.isArray(c.argv) && c.argv.length, "a command catalog has an argv");
    }
  }
  assert.equal(modelSpec(CC).spawn_takes, "alias");
  assert.deepEqual(
    modelSpec(CC).static.map((s) => s.id),
    ["fable", "opus", "sonnet", "haiku"],
    "Claude Code's Agent tool enum, measured 2026-10-13",
  );
  assert.deepEqual(modelSpec(CC).catalogs, [], "Claude Code declares no catalog: its list is its aliases");
  assert.equal(modelSpec(CODEX).spawn_takes, "id");
});

test("models ADR decision 1: Claude Code offers its aliases and no exact id, and asks nothing; an alias catalog says the newest of each line", () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache") };
  const bare = knownModels(CC, { env, home, now: () => NOW });
  assert.deepEqual(
    bare.offered.map((o) => o.id),
    ["fable", "opus", "sonnet", "haiku"],
  );
  assert.deepEqual(
    bare.offered.map((o) => o.description),
    modelSpec(CC).static.map((s) => s.description),
    "each alias with the manifest's own description",
  );
  assert.ok(
    bare.offered.every((o) => o.follows === null),
    "no catalog: nothing says what an alias follows",
  );
  assert.equal(bare.stale, true, "nothing known is stale");
  assert.equal(bare.live, null, "nothing to ask");
  assert.equal(bare.why, null, "and nothing to explain: no catalog is declared");
  assert.equal(bare.known.has("opus"), true);
  // An alias harness with a catalog: a cached answer from it says what each
  // alias follows, the newest active entry of its line.
  mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
  const entries = entriesOf(ALIAS_ANSWER, { ...modelSpec(ALIASED).catalogs[0].fields });
  writeFileSync(
    modelCachePath(ALIASED, { env, home }),
    JSON.stringify({ at: new Date(NOW - 1000).toISOString(), source: "the stub catalog", models: entries }),
  );
  const k = knownModels(ALIASED, { env: { ...env, PATH: stubBin("aliased-models") }, home, now: () => NOW });
  assert.equal(k.stale, false);
  assert.deepEqual(k.live, { source: "the stub catalog", caption: "Stub", kind: "command" });
  const follows = Object.fromEntries(k.offered.map((o) => [o.id, o.follows?.id || null]));
  assert.deepEqual(follows, {
    fable: "claude-fable-5-1",
    opus: "claude-opus-5-5",
    sonnet: null,
    haiku: "claude-haiku-5-5",
  });
  assert.ok(!entries.some((e) => e.id === "claude-sonnet-4-0"), "a retired entry is dropped");
  assert.equal(k.known.has("claude-opus-5-5"), false, "an exact id is not a value the spawn takes");
  assert.equal(k.known.has("opus"), true);
});

test("models ADR decisions 1 and 5: a line the aliases lack is never offered nor known; a name off the list gets the PLAN's note", () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache") };
  const withNew = {
    data: [
      ...ALIAS_ANSWER.data,
      {
        id: "claude-mythos-1",
        display_name: "Claude Mythos 1",
        created_at: "2026-10-12T00:00:00Z",
        line: "mythos",
        lifecycle: "active",
      },
    ],
  };
  mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
  writeFileSync(
    modelCachePath(ALIASED, { env, home }),
    JSON.stringify({
      at: new Date(NOW).toISOString(),
      source: "the stub catalog",
      models: entriesOf(withNew, modelSpec(ALIASED).catalogs[0].fields),
    }),
  );
  const k = knownModels(ALIASED, { env, home, now: () => NOW });
  assert.deepEqual(
    k.offered.map((o) => o.id),
    ["fable", "opus", "sonnet", "haiku"],
    "the spawn's enum, and nothing the catalog adds",
  );
  assert.equal(k.caption, "Stub", "the cache's source finds its catalog's caption");
  for (const name of ["mythos", "claude-mythos-1"])
    assert.equal(
      offListNote(ALIASED, name, k),
      `${name} is not one of Aliased's aliases (fable, opus, sonnet, haiku); written as typed, and Aliased refuses it at spawn`,
    );
  // Claude Code's note comes from its aliases alone.
  const cc = knownModels(CC, { env, home, now: () => NOW });
  for (const name of ["mythos", "claude-opus-5-5"])
    assert.equal(
      offListNote(CC, name, cc),
      `${name} is not one of Claude Code's aliases (fable, opus, sonnet, haiku); written as typed, and Claude Code refuses it at spawn`,
    );
  assert.equal(offListNote(CC, "opus", cc), null);
  const dir = codexHome();
  const ck = knownModels(CODEX, { env: { CODEX_HOME: dir }, home, now: () => NOW });
  assert.equal(offListNote(CODEX, "gpt-x", ck), "not in Codex's list as of 2026-10-13; written as typed");
  assert.equal(offListNote(CODEX, "gpt-reserve", ck), null, "a hidden entry is known");
  const bare = knownModels(CODEX, { env: {}, home: tmp("ps-models-home-"), now: () => NOW });
  assert.equal(offListNote(CODEX, "gpt-x", bare), "no list of Codex's models is known; written as typed");
  // A harness with no models block: knownModels has nothing, and the note says so.
  const stub = { id: "stub", display_name: "Stub", agent_translation: {} };
  assert.equal(knownModels(stub), null);
  assert.equal(offListNote(stub, "m-1", null), "no list of Stub's models is known; written as typed");
});

// The 0.30.7 story (PS-DIRECTORY): Claude Code reads no credential, so a key
// or a base URL in the environment changes nothing, and the cache 0.30.6
// wrote from Anthropic's model list is not shown. It is kept as it is:
// opening a list writes nothing.
test("models (0.30.7): Claude Code's 0.30.6 cache is ignored and kept, and nothing is read, whatever the environment", async () => {
  const at = Date.parse(JSON.parse(CACHE_0_30_6).at);
  for (const vars of [
    {},
    { ANTHROPIC_API_KEY: "test-anthropic-key" },
    { ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: "https://gateway.example" },
  ]) {
    const home = tmp("ps-models-home-");
    const env = { XDG_CACHE_HOME: join(home, "cache"), ...vars };
    const p = modelCachePath(CC, { env, home });
    mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
    writeFileSync(p, CACHE_0_30_6);
    // Within the day 0.30.6 kept it for: read, it would be fresh.
    const k = knownModels(CC, { env, home, now: () => at + 1000 });
    const what = JSON.stringify(Object.keys(vars));
    assert.equal(k.at, null, `${what}: no list's age`);
    assert.equal(k.source, "", `${what}: no source`);
    assert.equal(k.caption, "", `${what}: no caption`);
    assert.ok(
      k.offered.every((o) => o.follows === null),
      `${what}: no alias follows a model of the old cache`,
    );
    assert.deepEqual(
      k.offered.map((o) => o.id),
      ["fable", "opus", "sonnet", "haiku"],
    );
    assert.equal(k.stale, true);
    assert.deepEqual([k.live, k.why], [null, null], `${what}: nothing to ask, and no variable named`);
    const spawned = [];
    const r = await readLive(CC, { env, home, now: () => at + 1000, spawn: (...a) => (spawned.push(a), null) });
    assert.equal(r.error, "no catalog to ask");
    assert.deepEqual(spawned, [], `${what}: no subprocess`);
    assert.equal(readFileSync(p, "utf8"), CACHE_0_30_6, `${what}: the old cache is kept as it was`);
  }
});

test("models: a cache whose source no declared catalog names is not read, for any harness", () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache") };
  const dir = codexHome();
  mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
  const p = modelCachePath(CODEX, { env, home });
  const cached = (source) =>
    JSON.stringify({ at: new Date(NOW - 1000).toISOString(), source, models: [{ id: "gpt-cached" }] });
  for (const source of ["the Anthropic API", "", undefined]) {
    writeFileSync(p, cached(source));
    const k = knownModels(CODEX, { env: { ...env, CODEX_HOME: dir }, home, now: () => NOW });
    assert.deepEqual(
      k.offered.map((o) => o.id),
      ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
      `${JSON.stringify(source)}: Codex's own file, not the cache`,
    );
    assert.equal(k.known.has("gpt-cached"), false);
    assert.equal(k.at, Date.parse(CODEX_CATALOG.fetched_at));
  }
  // The source both of Codex's catalogs declare is read, as before.
  writeFileSync(p, cached("Codex"));
  assert.deepEqual(
    knownModels(CODEX, { env: { ...env, CODEX_HOME: dir }, home, now: () => NOW }).offered.map((o) => o.id),
    ["gpt-cached"],
  );
});

test("models: a list dated in the future is used only when nothing else is known, and is stale", () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache") };
  const dir = codexHome({ ...CODEX_CATALOG, fetched_at: "2027-01-01T00:00:00Z" });
  const alone = knownModels(CODEX, { env: { ...env, CODEX_HOME: dir }, home, now: () => NOW });
  assert.equal(alone.offered.length, 3);
  assert.equal(alone.stale, true);
  mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
  writeFileSync(
    modelCachePath(CODEX, { env, home }),
    JSON.stringify({ at: new Date(NOW - 1000).toISOString(), source: "Codex", models: [{ id: "gpt-cached" }] }),
  );
  const both = knownModels(CODEX, { env: { ...env, CODEX_HOME: dir }, home, now: () => NOW });
  assert.deepEqual(
    both.offered.map((o) => o.id),
    ["gpt-cached"],
    "the cache, dated in the past, wins over a file dated in the future",
  );
  assert.equal(both.stale, false);
});

test("models: catalog text is cleaned of control characters and escapes when it is read", () => {
  const rows = entriesOf(
    {
      models: [
        {
          slug: "gpt-\x1b[2Jx",
          display_name: "A\x07B",
          description: "one\ntwo \x1b[31mred\x1b[0m",
          visibility: "list",
        },
      ],
    },
    { ...modelSpec(CODEX).fields },
  );
  assert.deepEqual(rows[0], { id: "gpt-x", label: "AB", description: "one two red", family: "", hidden: false });
});

test("models: the manifest check refuses a malformed block, and passes both shipped manifests", () => {
  for (const m of loadHarnesses().values()) assert.equal(modelsProblem(m), null, m.id);
  assert.equal(modelsProblem(ALIASED), null, "the stub alias harness");
  const withModels = (models) => ({ id: "x", agent_translation: { models } });
  const good = modelSpec(CODEX);
  const bad = [
    [{ ...good, spawn_takes: "any" }, /spawn_takes is any/],
    [{ ...good, spawn_takes_reason: "" }, /no spawn_takes_reason/],
    [{ ...good, catalogs: [{ ...good.catalogs[0], kind: "ftp" }] }, /kind is ftp/],
    [{ ...good, catalogs: [{ ...good.catalogs[0], path: "../x.json" }] }, /not under the harness home/],
    [{ ...good, catalogs: [{ ...good.catalogs[1], argv: [] }] }, /has no argv/],
    [{ ...modelSpec(CC), static: [] }, /lists no alias/],
  ];
  for (const [models, re] of bad) assert.match(String(modelsProblem(withModels(models))), re);
  assert.equal(modelsProblem({ id: "x", agent_translation: {} }), null, "no block is fine");
});

// The 0.30.7 story (PS-DIRECTORY): the kind that read a key from the
// environment and sent it is gone, not only its one use. The directory's scan
// reads the source, so the module names no fetch at all.
test("models (0.30.7): an http catalog fails the manifest check by name, and scripts/models.mjs holds no fetch", () => {
  const http = { kind: "http", source: "s", reason: "r", url: "https://x", fields: { list: "a", id: "b" } };
  for (const models of [
    { ...modelSpec(CODEX), catalogs: [http] },
    { ...modelSpec(CODEX), catalogs: [...modelSpec(CODEX).catalogs, http] },
    { ...modelSpec(CC), catalogs: [http] },
  ])
    assert.equal(
      modelsProblem({ id: "x", agent_translation: { models } }),
      "an http catalog is not read: a catalog is a file or a command",
    );
  const src = readFileSync(new URL("../scripts/models.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bfetch\b/, "scripts/models.mjs names no fetch");
});

test("models ADR decisions 1 and 4: Codex's list is its own catalog file under CODEX_HOME, shown entries in its order", () => {
  const dir = codexHome();
  const home = tmp("ps-models-home-");
  const k = knownModels(CODEX, { env: { CODEX_HOME: dir }, home, now: () => NOW });
  assert.deepEqual(
    k.offered.map((o) => o.id),
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
    "priority order; a hidden entry is not offered",
  );
  assert.equal(k.offered[0].description, "Workhorse.");
  assert.equal(k.known.has("gpt-reserve"), true, "a hidden entry is still a name Codex knows");
  assert.equal(k.hidden.has("gpt-reserve"), true);
  assert.equal(k.at, Date.parse(CODEX_CATALOG.fetched_at), "the file's own timestamp is its age");
  assert.equal(k.stale, false);
  assert.equal(k.source, "Codex");
  assert.equal(k.caption, "Codex");
  // Without CODEX_HOME, the default under the home directory.
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify(CODEX_CATALOG));
  assert.equal(knownModels(CODEX, { env: {}, home, now: () => NOW }).offered.length, 3);
  // A day later the list is stale.
  assert.equal(knownModels(CODEX, { env: { CODEX_HOME: dir }, home, now: () => NOW + FRESH_MS }).stale, true);
});

test("models ADR decisions 3 and 4: a command read caches the catalog's names, labels, descriptions and families, and nothing else", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), PATH: stubBin("codex") };
  const r = await readLive(CODEX, {
    env,
    home,
    now: () => NOW,
    spawn: () => fakeChild(JSON.stringify(CODEX_CATALOG)),
  });
  assert.equal(r.error, undefined, r.error);
  const parsed = JSON.parse(readFileSync(modelCachePath(CODEX, { env, home }), "utf8"));
  assert.equal(parsed.at, new Date(NOW).toISOString());
  assert.equal(parsed.source, "Codex");
  assert.deepEqual(Object.keys(parsed).sort(), ["at", "models", "source"], "the cache holds these and nothing else");
  assert.deepEqual(Object.keys(parsed.models[0]).sort(), ["description", "family", "hidden", "id", "label"]);
  // The next open reads it: its source is the one Codex's catalogs declare.
  const k = knownModels(CODEX, { env, home, now: () => NOW });
  assert.deepEqual(
    k.offered.map((o) => o.id),
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  );
  assert.equal(k.at, NOW);
});

test("models ADR decision 3: a failed read answers why, is bounded, and is never cached", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), PATH: stubBin("codex") };
  const p = modelCachePath(CODEX, { env, home });
  const failed = await readLive(CODEX, { env, home, spawn: () => fakeChild("", { code: 2 }) });
  assert.equal(failed.error, "Codex could not refresh its list (exited 2)");
  // A command that never answers: the timer settles the read.
  const timers = { setTimeout: (f) => (setImmediate(f), 1), clearTimeout: () => {} };
  const hung = await readLive(CODEX, {
    env,
    home,
    timers,
    timeoutMs: 3000,
    spawn: () => fakeChild("", { hang: true }),
  });
  assert.equal(hung.error, "no answer within 3 s");
  const notJson = await readLive(CODEX, { env, home, spawn: () => fakeChild("{") });
  assert.equal(notJson.error, "the answer is not JSON");
  const noList = await readLive(CODEX, { env, home, spawn: () => fakeChild(JSON.stringify({ data: [] })) });
  assert.equal(noList.error, "the answer holds no list");
  assert.equal(existsSync(p), false, "nothing cached after a failure");
  const absent = await readLive(CODEX, { env: { ...env, PATH: tmp("ps-models-empty-") }, home });
  assert.equal(absent.error, "codex not on PATH");
});

test("models ADR decision 3: a command read runs the catalog's argv, asynchronously, and is killed at the bound", async () => {
  const home = tmp("ps-models-home-");
  const bin = tmp("ps-models-bin-");
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { XDG_CACHE_HOME: join(home, "cache"), PATH: bin };
  const ran = [];
  const child = (out, { code = 0, hang = false } = {}) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.kill = (sig) => {
      c.killed = sig;
      return true;
    };
    setImmediate(() => {
      if (hang) return;
      c.stdout.end(out);
      c.stdout.on("end", () => c.emit("close", code, null));
      c.stdout.resume();
    });
    return c;
  };
  const r = await readLive(CODEX, {
    env,
    home,
    now: () => NOW,
    spawn: (b, args) => (ran.push([b, ...args]), child(JSON.stringify(CODEX_CATALOG))),
  });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(ran, [["codex", "debug", "models"]]);
  assert.deepEqual(
    r.entries.filter((e) => !e.hidden).map((e) => e.id),
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  );
  let killed = null;
  const timers = { setTimeout: (f) => (setImmediate(f), 1), clearTimeout: () => {} };
  const hung = await readLive(CODEX, {
    env,
    home,
    timers,
    spawn: () => {
      const c = child("", { hang: true });
      const k = c.kill;
      c.kill = (s) => ((killed = s), k(s));
      return c;
    },
  });
  assert.equal(hung.error, "no answer within 3 s");
  assert.equal(killed, "SIGTERM");
  const failed = await readLive(CODEX, { env, home, spawn: () => child("", { code: 2 }) });
  assert.equal(failed.error, "Codex could not refresh its list (exited 2)");
  const absent = await readLive(CODEX, { env: { ...env, PATH: tmp("ps-models-empty-") }, home });
  assert.equal(absent.error, "codex not on PATH");
});

test("models: a read stopped by its signal answers stopped, ends the command and caches nothing", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), PATH: stubBin("codex") };
  const ac = new AbortController();
  let killed = null;
  const pending = readLive(CODEX, {
    env,
    home,
    signal: ac.signal,
    spawn: () => {
      const c = fakeChild("", { hang: true });
      c.kill = (s) => ((killed = s), true);
      return c;
    },
  });
  ac.abort();
  assert.equal((await pending).error, "stopped");
  assert.equal(killed, "SIGTERM");
  assert.equal(existsSync(modelCachePath(CODEX, { env, home })), false);
});

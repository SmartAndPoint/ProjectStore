// projectstore — tests/models.test.mjs: the models a harness's agents can be
// started with (the ADR "Agent model lists are read from each harness's own
// catalog, declared in its manifest and cached for a day"; the story
// "configure at a terminal is one settings menu…", PS-HARNESS). Every read is
// given its env, home, clock, fetch and spawn: no test reads the machine.
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

// The Anthropic answer's shape, measured 2026-10-13 (trimmed).
const ANTHROPIC = {
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

function codexHome(catalog = CODEX_CATALOG) {
  const dir = tmp("ps-models-codex-");
  if (catalog) writeFileSync(join(dir, "models_cache.json"), JSON.stringify(catalog));
  return dir;
}

const fakeFetch = (answer, calls = []) =>
  async function fetch(url, init) {
    calls.push({ url, headers: init?.headers || {} });
    return { ok: true, status: 200, json: async () => answer };
  };

test("models ADR decision 2: both manifests declare their list; every catalog is of a known kind with its fields", () => {
  for (const m of loadHarnesses().values()) {
    const spec = modelSpec(m);
    if (!spec) continue;
    assert.ok(["alias", "id"].includes(spec.spawn_takes), `${m.id}: spawn_takes`);
    assert.ok(Array.isArray(spec.static), `${m.id}: static`);
    for (const c of spec.catalogs || []) {
      assert.ok(["file", "command", "http"].includes(c.kind), `${m.id}: ${c.kind}`);
      const fields = { ...(spec.fields || {}), ...(c.fields || {}) };
      assert.ok(fields.list && fields.id, `${m.id}: a ${c.kind} catalog names its list and id`);
      if (c.kind === "http") assert.match(c.url, /^https:\/\//, "an http catalog is https");
      if (c.kind === "command") assert.ok(Array.isArray(c.argv) && c.argv.length, "a command catalog has an argv");
    }
  }
  assert.equal(modelSpec(CC).spawn_takes, "alias");
  assert.deepEqual(
    modelSpec(CC).static.map((s) => s.id),
    ["fable", "opus", "sonnet", "haiku"],
    "Claude Code's Agent tool enum, measured 2026-10-13",
  );
  assert.equal(modelSpec(CODEX).spawn_takes, "id");
});

test("models ADR decision 1: Claude Code offers its aliases and no exact id; a catalog says the newest of each line", () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache") };
  const bare = knownModels(CC, { env, home, now: () => NOW });
  assert.deepEqual(
    bare.offered.map((o) => o.id),
    ["fable", "opus", "sonnet", "haiku"],
  );
  assert.ok(
    bare.offered.every((o) => o.follows === null),
    "no catalog yet: nothing says what an alias follows",
  );
  assert.equal(bare.stale, true, "nothing known is stale");
  assert.equal(bare.live, null, "no ANTHROPIC_API_KEY: nothing to ask");
  assert.equal(bare.why, "no ANTHROPIC_API_KEY");
  // A cached answer: each alias follows the newest active entry of its line.
  const p = modelCachePath(CC, { env, home });
  mkdirSync(join(home, "cache", "projectstore", "models"), { recursive: true });
  const entries = entriesOf(ANTHROPIC, { ...modelSpec(CC).catalogs[0].fields });
  writeFileSync(
    p,
    JSON.stringify({ at: new Date(NOW - 1000).toISOString(), source: "the Anthropic API", models: entries }),
  );
  const k = knownModels(CC, { env: { ...env, ANTHROPIC_API_KEY: "test-anthropic-key" }, home, now: () => NOW });
  assert.equal(k.stale, false);
  assert.deepEqual(k.live, {
    source: "the Anthropic API",
    caption: "Anthropic API",
    kind: "http",
    host: "api.anthropic.com",
  });
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
      ...ANTHROPIC.data,
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
    modelCachePath(CC, { env, home }),
    JSON.stringify({
      at: new Date(NOW).toISOString(),
      source: "the Anthropic API",
      models: entriesOf(withNew, modelSpec(CC).catalogs[0].fields),
    }),
  );
  const k = knownModels(CC, { env, home, now: () => NOW });
  assert.deepEqual(
    k.offered.map((o) => o.id),
    ["fable", "opus", "sonnet", "haiku"],
    "the spawn's enum, and nothing the catalog adds",
  );
  assert.equal(k.caption, "Anthropic API", "the cache's source finds its catalog's caption");
  for (const name of ["mythos", "claude-opus-5-5"])
    assert.equal(
      offListNote(CC, name, k),
      `${name} is not one of Claude Code's aliases (fable, opus, sonnet, haiku); written as typed, and Claude Code refuses it at spawn`,
    );
  assert.equal(offListNote(CC, "opus", k), null);
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
  const withModels = (models) => ({ id: "x", agent_translation: { models } });
  const good = modelSpec(CODEX);
  const bad = [
    [{ ...good, spawn_takes: "any" }, /spawn_takes is any/],
    [{ ...good, spawn_takes_reason: "" }, /no spawn_takes_reason/],
    [{ ...good, catalogs: [{ ...good.catalogs[0], kind: "ftp" }] }, /kind is ftp/],
    [{ ...good, catalogs: [{ ...good.catalogs[0], path: "../x.json" }] }, /not under the harness home/],
    [{ ...good, catalogs: [{ ...good.catalogs[1], argv: [] }] }, /has no argv/],
    [
      {
        ...good,
        catalogs: [
          {
            kind: "http",
            source: "s",
            reason: "r",
            url: "http://x",
            key_env: "K",
            key_header: "h",
            fields: { list: "a", id: "b" },
          },
        ],
      },
      /not https/,
    ],
    [
      {
        ...good,
        catalogs: [{ kind: "http", source: "s", reason: "r", url: "https://x", fields: { list: "a", id: "b" } }],
      },
      /names no key variable/,
    ],
    [{ ...modelSpec(CC), static: [] }, /lists no alias/],
  ];
  for (const [models, re] of bad) assert.match(String(modelsProblem(withModels(models))), re);
  assert.equal(modelsProblem({ id: "x", agent_translation: {} }), null, "no block is fine");
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

test("models ADR decisions 3 and 4: an http read sends the key in its header only, and caches names without it", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), ANTHROPIC_API_KEY: "test-anthropic-key" };
  const calls = [];
  const r = await readLive(CC, { env, home, now: () => NOW, fetch: fakeFetch(ANTHROPIC, calls) });
  assert.equal(r.error, undefined, r.error);
  assert.equal(calls.length, 1, "one request");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(calls[0].headers["x-api-key"], "test-anthropic-key");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  const cache = readFileSync(modelCachePath(CC, { env, home }), "utf8");
  assert.doesNotMatch(cache, /test-anthropic-key|x-api-key/, "the cache holds no key and no header");
  const parsed = JSON.parse(cache);
  assert.equal(parsed.at, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(parsed).sort(), ["at", "models", "source"], "the cache holds these and nothing else");
  assert.deepEqual(Object.keys(parsed.models[0]).sort(), ["description", "family", "hidden", "id", "label"]);
  // ANTHROPIC_BASE_URL is the base the key belongs to.
  const calls2 = [];
  await readLive(CC, {
    env: { ...env, ANTHROPIC_BASE_URL: "https://gateway.example/" },
    home,
    now: () => NOW,
    fetch: fakeFetch(ANTHROPIC, calls2),
  });
  assert.equal(calls2[0].url, "https://gateway.example/v1/models?limit=1000");
});

test("models ADR decision 3: a failed read answers why, is bounded, and is never cached", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), ANTHROPIC_API_KEY: "k" };
  const p = modelCachePath(CC, { env, home });
  const r401 = await readLive(CC, {
    env,
    home,
    fetch: async () => ({ ok: false, status: 401, body: { cancel: async () => {} } }),
  });
  assert.equal(r401.error, "the key was refused (HTTP 401)");
  // A request that never answers: the timer settles the read.
  const timers = { setTimeout: (f) => (setImmediate(f), 1), clearTimeout: () => {} };
  const hung = await readLive(CC, { env, home, fetch: () => new Promise(() => {}), timers, timeoutMs: 3000 });
  assert.equal(hung.error, "no answer within 3 s");
  const notJson = await readLive(CC, {
    env,
    home,
    fetch: async () => ({ ok: true, json: async () => JSON.parse("{") }),
  });
  assert.equal(notJson.error, "the answer is not JSON");
  assert.equal(existsSync(p), false, "nothing cached after a failure");
  const noKey = await readLive(CC, { env: { XDG_CACHE_HOME: env.XDG_CACHE_HOME }, home, fetch: fakeFetch(ANTHROPIC) });
  assert.equal(noKey.error, "no ANTHROPIC_API_KEY");
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

test("models: a read stopped by its signal answers stopped and caches nothing", async () => {
  const home = tmp("ps-models-home-");
  const env = { XDG_CACHE_HOME: join(home, "cache"), ANTHROPIC_API_KEY: "k" };
  const ac = new AbortController();
  const pending = readLive(CC, { env, home, signal: ac.signal, fetch: () => new Promise(() => {}) });
  ac.abort();
  assert.equal((await pending).error, "stopped");
  assert.equal(existsSync(modelCachePath(CC, { env, home })), false);
});

// projectstore — models.mjs: the models a harness's agents can be started
// with (the ADR "Agent model lists are read from each harness's own catalog,
// declared in its manifest and cached for a day"). Every harness difference
// is the manifest's agent_translation.models block: what its spawn takes,
// the floor list, and the catalogs to read, each by field paths. Nothing
// here names a harness.
//
//   modelSpec(manifest)                  → the block, or null
//   knownModels(manifest, opts)          → what local reads know: offered rows,
//                                          every known name, the source and its
//                                          age, and the live catalog a refresh
//                                          would ask (decisions 1, 3 and 4)
//   readLive(manifest, opts)             → Promise of { at, source, entries } or
//                                          { error }: one bounded read, cached on
//                                          success, never throwing (decision 3)
//   offListNote(manifest, name, known)   → the PLAN's note for a name no list
//                                          holds, or null (decision 5)
//   modelsProblem(manifest)              → what is wrong with the block, or null:
//                                          the manifest schema test's check
//
// Local reads are synchronous and cheap: the manifest, a `file` catalog, and
// projectstore's own cache. A `command` or `http` catalog is read only by
// readLive, which a menu starts in the background. env, home, now, fetch,
// spawn and timers are parameters, so no test reads the machine.

import { spawn as spawnChild } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cachePaths, harnessHome, whichOnPath } from "./harness.mjs";
import { writeFileAtomic } from "./lib.mjs";

// A known list is fresh for a day (decision 3); a live read is bounded by 3 s.
export const FRESH_MS = 24 * 60 * 60 * 1000;
export const LIVE_TIMEOUT_MS = 3000;
// A catalog's output beyond this is not a catalog: the read stops there.
const MAX_BYTES = 16 * 1024 * 1024;

export function modelSpec(manifest) {
  const m = manifest?.agent_translation?.models;
  return m && typeof m === "object" ? m : null;
}

// One field path, dotted: "data", "models", "fetched_at".
const at = (obj, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

// A condition { field: value }: every named field that the entry carries
// equals its value. A field the entry lacks does not count against it, so an
// older answer without the field still reads.
const matches = (entry, cond) =>
  !cond || Object.entries(cond).every(([k, v]) => at(entry, k) === undefined || at(entry, k) === v);

// A catalog's fields: the block's shared ones, then the catalog's own.
const fieldsOf = (spec, catalog) => ({ ...(spec.fields || {}), ...(catalog.fields || {}) });

// A catalog's text as a terminal may draw it: control characters and
// escapes removed (the ADR, decision 4), so an answer cannot move the cursor.
// A line break or a tab reads as a space, so words never merge.
const clean = (s) =>
  String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\t\n\r\v\f]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// A catalog's answer as rows: { id, label, description, family, hidden },
// in the catalog's order. Entries without an id, and entries `keep_when`
// rejects, are dropped; `shown_when` only hides.
export function entriesOf(body, fields) {
  const list = at(body, fields.list);
  if (!Array.isArray(list)) return null;
  const rows = [];
  list.forEach((e, k) => {
    if (!e || typeof e !== "object") return;
    const raw = at(e, fields.id);
    const id = typeof raw === "string" ? clean(raw) : "";
    if (!id) return;
    if (!matches(e, fields.keep_when)) return;
    const text = (p) => {
      const v = p ? at(e, p) : undefined;
      return typeof v === "string" ? clean(v) : "";
    };
    rows.push({
      id,
      label: text(fields.label),
      description: text(fields.description),
      family: text(fields.family),
      hidden: fields.shown_when ? !matches(e, fields.shown_when) : false,
      order: fields.order ? at(e, fields.order) : k,
      k,
    });
  });
  const desc = Boolean(fields.order_desc);
  rows.sort((a, b) => {
    const x = a.order,
      y = b.order;
    if (x === y || x === undefined || y === undefined) return a.k - b.k;
    return (x < y ? -1 : 1) * (desc ? -1 : 1);
  });
  return rows.map(({ id, label, description, family, hidden }) => ({ id, label, description, family, hidden }));
}

const timeOf = (v) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

// The cache file of one harness: <cache root>/models/<id>.json (decision 4).
export function modelCachePath(manifest, { env = process.env, home = homedir() } = {}) {
  return cachePaths({ env, home }).models(manifest?.id);
}

function readCache(manifest, opts) {
  const p = modelCachePath(manifest, opts);
  if (!p) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    const t = timeOf(c?.at);
    if (t === null || !Array.isArray(c.models)) return null;
    // Cleaned again: the cache is a file anyone can edit.
    const entries = c.models
      .filter((x) => x && typeof x.id === "string" && clean(x.id))
      .map((x) => ({
        id: clean(x.id),
        label: clean(x.label ?? ""),
        description: clean(x.description ?? ""),
        family: clean(x.family ?? ""),
        hidden: Boolean(x.hidden),
      }));
    const source = typeof c.source === "string" ? c.source : "";
    const from = (modelSpec(manifest)?.catalogs || []).find((x) => x.source === source);
    return { at: t, source, caption: from?.caption || source, entries };
  } catch {
    return null;
  }
}

function readFileCatalog(manifest, spec, catalog, opts) {
  // Under the harness's home, as the harness itself resolves it.
  const base = harnessHome(manifest, opts);
  if (!base || !catalog.path) return null;
  const p = join(base, catalog.path);
  try {
    const raw = readFileSync(p, "utf8");
    const fields = fieldsOf(spec, catalog);
    const body = JSON.parse(raw);
    const entries = entriesOf(body, fields);
    if (!entries) return null;
    const t = timeOf(fields.at ? at(body, fields.at) : undefined) ?? statSync(p).mtimeMs;
    return { at: t, source: catalog.source || "", caption: catalog.caption || catalog.source || "", entries };
  } catch {
    return null;
  }
}

// Where an http catalog's key goes: the key's own base when the manifest
// names a base variable and it is set, else the manifest's URL (the ADR,
// decision 2). Never any other host.
function urlOf(catalog, env) {
  const base = catalog.base_env && env?.[catalog.base_env] ? String(env[catalog.base_env]).replace(/\/+$/, "") : null;
  return base && catalog.path ? `${base}${catalog.path}` : catalog.url;
}
function hostOf(catalog, env) {
  try {
    return new URL(urlOf(catalog, env)).host;
  } catch {
    return null;
  }
}

// The catalog a refresh asks: the first `command` or `http` one that can run
// here — its key variable set, or its bin on PATH — or null, with why not.
function liveCatalog(spec, env) {
  let why = null;
  for (const c of spec.catalogs || []) {
    if (c.kind === "http") {
      if (c.key_env && !(env && env[c.key_env])) {
        why = why || `no ${c.key_env}`;
        continue;
      }
      return { catalog: c, why: null, host: hostOf(c, env) };
    }
    if (c.kind === "command") {
      const bin = Array.isArray(c.argv) ? c.argv[0] : null;
      if (!bin || !whichOnPath(bin, env || {})) {
        why = why || `${bin || "the command"} not on PATH`;
        continue;
      }
      return { catalog: c, why: null };
    }
  }
  return { catalog: null, why };
}

// What the local reads know about one harness's models. `offered` is what a
// menu lists, in order; `known` every name any list holds, hidden ones too.
//   spawn_takes "id":    the newest catalog's shown entries, then static ones
//                        it lacks.
//   spawn_takes "alias": the static aliases, each with the newest entry of its
//                        family in the catalog (`follows`), and nothing else.
export function knownModels(manifest, { env = process.env, home = homedir(), now = Date.now } = {}) {
  const spec = modelSpec(manifest);
  if (!spec) return null;
  const opts = { env, home };
  const candidates = [
    readCache(manifest, opts),
    ...(spec.catalogs || []).filter((c) => c.kind === "file").map((c) => readFileCatalog(manifest, spec, c, opts)),
  ].filter(Boolean);
  // A list dated in the future (a clock that moved back) is used only when
  // nothing else is known, and it is stale.
  const t0 = now();
  const past = candidates.filter((x) => x.at <= t0);
  const newest = (past.length ? past : candidates).reduce((a, b) => (!a || b.at > a.at ? b : a), null);
  const entries = newest ? newest.entries : [];
  const statics = (spec.static || []).filter((s) => s && typeof s.id === "string" && s.id);
  // What the spawn can be given: an alias harness's aliases only — an exact
  // id a catalog lists is not one of them — and every catalog id otherwise.
  const known = new Set(statics.map((s) => s.id));
  let offered;
  if (spec.spawn_takes === "alias") {
    const followed = new Map();
    for (const e of entries) if (e.family && !followed.has(e.family)) followed.set(e.family, e);
    offered = statics.map((s) => ({
      id: s.id,
      label: s.label || "",
      description: s.description || "",
      family: s.family || s.id,
      follows: followed.get(s.family || s.id) || null,
    }));
    // A line the catalog reports that `static` lacks is never offered and
    // never known: the spawn takes the static aliases only (decision 1).
  } else {
    for (const e of entries) known.add(e.id);
    offered = entries.filter((e) => !e.hidden).map((e) => ({ ...e }));
    for (const s of statics)
      if (!offered.some((o) => o.id === s.id))
        offered.push({ id: s.id, label: s.label || "", description: s.description || "" });
  }
  const t = t0;
  const live = liveCatalog(spec, env);
  return {
    spawnTakes: spec.spawn_takes === "alias" ? "alias" : "id",
    aliases: spec.spawn_takes === "alias" ? statics.map((s) => s.id) : [],
    offered,
    known,
    hidden: new Set(entries.filter((e) => e.hidden).map((e) => e.id)),
    source: newest ? newest.source : "",
    caption: newest ? newest.caption || newest.source : "",
    at: newest ? newest.at : null,
    stale: !newest || newest.at > t || t - newest.at >= FRESH_MS,
    live: live.catalog
      ? {
          source: live.catalog.source || "",
          caption: live.catalog.caption || live.catalog.source || "",
          kind: live.catalog.kind,
          ...(live.host ? { host: live.host } : {}),
        }
      : null,
    why: live.why,
  };
}

// The PLAN's note for a model no list holds (decision 5), or null when one
// does. `known` is knownModels' answer.
//   alias harness: the name is not one of its aliases, and its spawn refuses it;
//   id harness:    the name is not in its newest list, as of that list's date;
//   no list:       nothing is known to compare with.
export function offListNote(manifest, name, known) {
  const display = manifest?.display_name || manifest?.id || "this harness";
  if (!name) return null;
  if (!known) return `no list of ${display}'s models is known; written as typed`;
  if (known.known.has(name)) return null;
  if (known.spawnTakes === "alias" && known.aliases.length) {
    const list = known.aliases.join(", ");
    return `${name} is not one of ${display}'s aliases (${list}); written as typed, and ${display} refuses it at spawn`;
  }
  if (known.source && known.at) return `not in ${known.source}'s list as of ${localDate(known.at)}; written as typed`;
  if (known.known.size) return `not in ${display}'s list; written as typed`;
  return `no list of ${display}'s models is known; written as typed`;
}

// A date as the person's clock reads it: 2026-10-13.
const localDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// What is wrong with a manifest's models block, or null (the manifest schema
// test, generation contract 1). A manifest without the block is fine: its
// agents' models are typed by name.
export function modelsProblem(manifest) {
  const spec = modelSpec(manifest);
  if (!spec) return manifest?.agent_translation?.models === undefined ? null : "models is not an object";
  if (!["alias", "id"].includes(spec.spawn_takes)) return `spawn_takes is ${spec.spawn_takes}, not alias or id`;
  if (typeof spec.spawn_takes_reason !== "string" || !spec.spawn_takes_reason)
    return "spawn_takes carries no spawn_takes_reason";
  if (!Array.isArray(spec.static)) return "static is not a list";
  for (const x of spec.static) if (!x || typeof x.id !== "string" || !x.id) return "a static entry has no id";
  if (spec.spawn_takes === "alias" && !spec.static.length) return "an alias harness lists no alias";
  if (!Array.isArray(spec.catalogs)) return "catalogs is not a list";
  for (const c of spec.catalogs) {
    const fields = fieldsOf(spec, c);
    if (!["file", "command", "http"].includes(c?.kind)) return `a catalog's kind is ${c?.kind}`;
    if (typeof c.source !== "string" || !c.source) return `a ${c.kind} catalog names no source`;
    if (!fields.list || !fields.id) return `the ${c.source} catalog names no list or id field`;
    if (typeof c.reason !== "string" || !c.reason) return `the ${c.source} catalog carries no reason`;
    if (c.kind === "file" && (typeof c.path !== "string" || !c.path || c.path.split("/").includes("..")))
      return `the ${c.source} file catalog's path is not under the harness home`;
    if (c.kind === "command" && (!Array.isArray(c.argv) || !c.argv.length || c.argv.some((a) => typeof a !== "string")))
      return `the ${c.source} command catalog has no argv`;
    if (c.kind === "http") {
      if (!/^https:\/\//.test(String(c.url))) return `the ${c.source} http catalog's url is not https`;
      if (!c.key_env || !c.key_header) return `the ${c.source} http catalog names no key variable and header`;
      if (c.base_env && !String(c.path || "").startsWith("/"))
        return `the ${c.source} http catalog's path is not absolute`;
    }
  }
  return null;
}

// One bounded fetch, settled by a timer whatever the request does after: the
// pattern of convergence.mjs's request(). The key goes in its header and
// nowhere else; nothing of the request is kept.
function readHttp(catalog, { env, fetch, timers, timeoutMs, signal }) {
  return new Promise((settle) => {
    if (typeof fetch !== "function") return settle({ error: "no fetch in this Node" });
    let done = false,
      timer = null;
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer !== null)
        try {
          timers.clearTimeout(timer);
        } catch {}
      settle(r);
    };
    timer = timers.setTimeout(() => {
      timer = null;
      try {
        ac?.abort();
      } catch {}
      finish({ error: `no answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    try {
      timer?.unref?.();
    } catch {}
    signal?.addEventListener?.("abort", () => {
      try {
        ac?.abort();
      } catch {}
      finish({ error: "stopped" });
    });
    const url = urlOf(catalog, env);
    const headers = { accept: "application/json", ...(catalog.headers || {}) };
    if (catalog.key_env && catalog.key_header) headers[catalog.key_header] = String(env?.[catalog.key_env] || "");
    Promise.resolve()
      .then(() => fetch(url, { headers, ...(ac ? { signal: ac.signal } : {}) }))
      .then(async (res) => {
        if (!res || !res.ok) {
          try {
            Promise.resolve(res?.body?.cancel?.()).catch(() => {});
          } catch {}
          const status = res?.status ?? "error";
          return finish({
            error: status === 401 || status === 403 ? `the key was refused (HTTP ${status})` : `HTTP ${status}`,
          });
        }
        const size = Number(res.headers?.get?.("content-length"));
        if (Number.isFinite(size) && size > MAX_BYTES) {
          try {
            Promise.resolve(res?.body?.cancel?.()).catch(() => {});
          } catch {}
          return finish({ error: "the answer is too large" });
        }
        try {
          finish({ body: await res.json() });
        } catch {
          finish({ error: "the answer is not JSON" });
        }
      })
      .catch((e) => finish({ error: String(e?.cause?.code || e?.code || e?.message || "the request failed") }));
  });
}

// One bounded run of a catalog command: its stdout as JSON. Asynchronous, so
// a menu keeps drawing while it runs; killed at the bound.
function readCommand(catalog, { env, spawn, timers, timeoutMs, signal }) {
  return new Promise((settle) => {
    let done = false,
      timer = null,
      child = null;
    const chunks = [];
    let bytes = 0;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer !== null)
        try {
          timers.clearTimeout(timer);
        } catch {}
      settle(r);
    };
    const [bin, ...args] = catalog.argv;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      return finish({ error: String(e?.code || e?.message || "could not start") });
    }
    timer = timers.setTimeout(() => {
      timer = null;
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({ error: `no answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    try {
      timer?.unref?.();
    } catch {}
    signal?.addEventListener?.("abort", () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({ error: "stopped" });
    });
    child.on("error", (e) =>
      finish({ error: e?.code === "ENOENT" ? `${bin} not on PATH` : String(e?.code || e?.message) }),
    );
    child.stdout?.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) {
        try {
          child.kill("SIGTERM");
        } catch {}
        return finish({ error: "the answer is too large" });
      }
      chunks.push(c);
    });
    child.on("close", (code, signal) => {
      if (code !== 0)
        return finish({
          error: `${catalog.source || bin} could not refresh its list (${signal ? `killed by ${signal}` : `exited ${code}`})`,
        });
      try {
        finish({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ error: "the answer is not JSON" });
      }
    });
  });
}

// The live read (decision 3): the first catalog that can run, once, within
// the bound. On success the rows are written to projectstore's cache — names,
// labels, descriptions and families only, never a key or a header (decision
// 4) — and returned; a failure is returned as { error } and never cached.
export async function readLive(
  manifest,
  {
    env = process.env,
    home = homedir(),
    now = Date.now,
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- the global fetch is experimental at Node 20 and stable from 21; without it the read answers "no fetch in this Node"
    fetch = globalThis.fetch,
    spawn = spawnChild,
    timers = globalThis,
    timeoutMs = LIVE_TIMEOUT_MS,
    signal = null,
  } = {},
) {
  const spec = modelSpec(manifest);
  if (!spec) return { error: "no model list for this harness" };
  const { catalog, why } = liveCatalog(spec, env);
  if (!catalog) return { error: why || "no catalog to ask" };
  let r;
  try {
    r =
      catalog.kind === "http"
        ? await readHttp(catalog, { env, fetch, timers, timeoutMs, signal })
        : await readCommand(catalog, { env, spawn, timers, timeoutMs, signal });
  } catch (e) {
    r = { error: String(e?.message || e) };
  }
  if (r.error) return { error: r.error, source: catalog.source || "" };
  if (signal?.aborted) return { error: "stopped", source: catalog.source || "" };
  const entries = entriesOf(r.body, fieldsOf(spec, catalog));
  if (!entries) return { error: "the answer holds no list", source: catalog.source || "" };
  const t = now();
  const p = modelCachePath(manifest, { env, home });
  if (p)
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileAtomic(
        p,
        JSON.stringify({ at: new Date(t).toISOString(), source: catalog.source || "", models: entries }, null, 2) +
          "\n",
        { sweep: false },
      );
    } catch {}
  return { at: t, source: catalog.source || "", entries };
}

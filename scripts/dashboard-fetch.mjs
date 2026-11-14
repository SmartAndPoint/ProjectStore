// projectstore — dashboard-fetch.mjs: the page of a copy installed from npm.
//
// The spec "The dashboard package and its launcher: the folder, the dashboard
// verb, and a page that only reads" (alias dashboard), contracts 4 and 14 to
// 17, as amended on 2026-11-14 by the story "The release builds, checks and
// publishes the dashboard package at the core's version" (PS-DASHBOARD).
//
// A copy from npm ships no dashboard/ folder. Its page is the package
// projectstore-dashboard at the core's own version, fetched once into
// ProjectStore's user cache, <cache>/dashboard/<version>/, from the user's
// own npm registry and configuration, and started from there by every later
// run with no npm call and no network. Any other copy (a checkout, the git
// marketplace's copy, an unpacked tarball) fetches nothing: the git channel
// never runs a page built from a tag on a core taken from main.
//
//   PAGE_PACKAGE                         → "projectstore-dashboard"
//   FETCHING_CHANNELS                    → the install channels that fetch
//   npmCopy(root, { home })              → true for a copy installed from npm (contract 4)
//   pageVersion(root)                    → the core's version, strict semver, or null
//   checkPage(dir, version)              → null when dir is the page of version, else
//                                          what is wrong: the file and both values
//   installEnv(env)                      → the install's environment: no lower-case npm_config_*
//   pageFor({ root, project, env, … })   → { ok: true, dir, fetched } | { ok: false, error }
//
// npm runs with fetch-shell.mjs's argv and run-host.mjs's runner, so this
// fetch is the shell fetch in all but the tree it checks, the registry it
// asks and where it keeps the tree. A run killed during its fetch leaves its
// scratch folder, <cache>/fetch/<pid>-<ms>; the next fetching run's
// sweepFetchRuns removes it once that process has ended, as it does a shell
// fetch's (contract 15). Only scripts/dashboard.mjs imports this file, and
// only when no page folder is there (the portability suite pins both). Pure
// node, no external deps.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cachePaths, packageCommand } from "./harness.mjs";
import { installChannel, movePath, removeTreeUnder, fromTerminalIn } from "./lib.mjs";
import { registrationPayloadRoot } from "./surfaces.mjs";
import {
  fetchArgv,
  npmCall,
  npmError,
  npmUserRegistry,
  PUBLIC_REGISTRY,
  REGISTRY_BUDGET_MS,
  sweepFetchRuns,
  fetchRunId,
  rootVersion,
} from "./fetch-shell.mjs";
import { runHost, startFailure, HOST_BUDGET_MS } from "./run-host.mjs";

export const PAGE_PACKAGE = "projectstore-dashboard";

// installChannel's answers for a copy installed from npm: a package manager's
// root (npx, node_modules), the npm registration's cache copy, and a copy
// synced from Anthropic's directory, whose tree is the npm packlist.
export const FETCHING_CHANNELS = Object.freeze(["package", "registration", "synced"]);

// A copy installed from npm (the dashboard spec, contract 4): one of those
// channels, or the npm registration's own marketplace directory, which a host
// session runs in place and installChannel reads as a checkout
// (convergence.mjs's hostCopyRoot asks the same question of surfaces.mjs).
export function npmCopy(root, { home = homedir() } = {}) {
  return FETCHING_CHANNELS.includes(installChannel(root, { home })) || registrationPayloadRoot(root, { home });
}

// Strict semver 2.0, the specification's own grammar: the version asked for
// is exactly the core's, and a version that is not one is never sent to npm.
const NUM = "(?:0|[1-9]\\d*)";
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const seconds = (ms) => `${Number((ms / 1000).toFixed(ms % 1000 ? 1 : 0))} s`;

export function pageVersion(root) {
  const v = rootVersion(root);
  return v && SEMVER.test(v) ? v : null;
}

// A folder is the page of `version` (the dashboard spec, contract 14) when
// its package.json names this package at exactly that version and its server
// is in it.
export function checkPage(dir, version) {
  const file = join(dir, "package.json");
  const pkg = readJson(file);
  if (pkg?.name !== PAGE_PACKAGE)
    return `${file} has name ${JSON.stringify(pkg?.name ?? null)}, expected ${JSON.stringify(PAGE_PACKAGE)}`;
  if (pkg.version !== version)
    return `${file} has version ${JSON.stringify(pkg.version ?? null)}, expected ${JSON.stringify(version)}`;
  const server = join(dir, "server.mjs");
  if (!existsSync(server)) return `${server} is not there, and the page's server is that file`;
  return null;
}

// The registry a text names: the one asked, or, when the user's could not be
// read and npm was left to its own configuration, that configuration's.
const asked = (registry) => registry || "the registry in your npm configuration";

// The way out of a missing page when the registry asked may be a mirror that
// has not synced it: any registry but npm's own, and an unknown one too (the
// user's could not be read, and npm's configuration may name a mirror), as
// the shell fetch's mirrorBlock treats a null registry. The command is the
// core's, at this version, alone on its line after its lead, in the
// upper-case form: every lower-case npm_config_* variable is dropped before
// npm runs.
function publicRegistryBlock({ registry, version, project }) {
  if (registry && String(registry).replace(/\/+$/, "") === PUBLIC_REGISTRY) return [];
  const where = project ? fromTerminalIn(project) : "from a terminal in the project";
  return [
    `A mirror that has not synced it? Run this again from npm's public registry, ${where}:`,
    `NPM_CONFIG_REGISTRY=${PUBLIC_REGISTRY} ${packageCommand([], "dashboard", { version })}`,
  ];
}

// The way out of a registry that cannot be reached: this fetch asks the
// user's own registry, and neither a project's .npmrc nor a lower-case
// npm_config_* variable reaches it, so a company registry named only there is
// named for one run, in the upper-case form that survives the cleaning.
function ownRegistryBlock({ registry, version, project }) {
  const where = project ? fromTerminalIn(project) : "from a terminal in the project";
  return [
    `This fetch asked ${asked(registry)}; a project's .npmrc and lower-case npm_config_* variables are not passed to it. A registry only the project's .npmrc names? Name it for this run, ${where}:`,
    `NPM_CONFIG_REGISTRY=<your registry> ${packageCommand([], "dashboard", { version })}`,
  ];
}

const NETWORK_ONCE = "The page needs the network once per version; later runs start it from the cache.";

// What a fetch that cannot finish says (the dashboard spec, contract 16), by
// npm's code or ours. Every text is the envelope's `error` as it is, each
// part on its own line.
function refusalText(code, ctx) {
  const { pkg, version, registry, project, summary = "", url = null, cause = "", budget } = ctx;
  const where = asked(registry);
  switch (code) {
    case "ETARGET":
    case "E404":
      return [
        `The dashboard's page for ${version}, ${pkg}, is not published on ${where} (npm ${code}), and no other version is tried: the page runs only at its core's own version. If ${version} was just released, try again in a few minutes.`,
        ...publicRegistryBlock({ registry, version, project }),
      ].join("\n");
    case "EBUDGET":
      return [
        `Fetching ${pkg} from ${where} took longer than ${seconds(budget)} and was stopped. ${NETWORK_ONCE} Run this again once the registry answers.`,
        ...ownRegistryBlock(ctx),
      ].join("\n");
    case "FETCH_TIMEOUT":
      return [
        `npm gave up on ${url || where} (network timeout) while fetching ${pkg}. ${NETWORK_ONCE} Run this again once the registry answers.`,
        ...ownRegistryBlock(ctx),
      ].join("\n");
    // npm itself is missing: no registry was asked, so none is named.
    case "ESTART":
      return `${cause}. The dashboard's page of a copy installed from npm needs npm and the network once per version, to fetch ${pkg}: put npm on PATH, then run this again.`;
    default:
      return [
        `npm could not fetch ${pkg} from ${where}: ${code || "an unknown error"}${summary ? ` — ${summary.split(/\r?\n/)[0]}` : ""}. ${NETWORK_ONCE} Run this again once the registry is reachable.`,
        ...ownRegistryBlock(ctx),
      ].join("\n");
  }
}

// The cache's own refusals: the variable to set comes from cachePaths, which
// alone spells it.
const noCacheText = (cache) =>
  `The dashboard's page has no cache folder: ${cache.variable} is not an absolute path and the home directory is unknown. Set ${cache.variable} to a writable directory, then run this again.`;
const cacheText = (cache, e) =>
  `The dashboard's page cannot be kept: the cache folder ${cache.root} cannot be written (${e?.code || "error"}); it comes from ${cache.from}. Set ${cache.variable} to a writable directory, then run this again.`;

// The install's environment: every lower-case npm_config_* removed, as
// npmUserRegistry removes them for its read. An outer `npm exec` hands its
// child the project's .npmrc as those variables (a proxy, a CA file, a
// registry), and --registry in the argv outranks the registry alone. The
// upper-case NPM_CONFIG_* are the user's own, and stay.
export function installEnv(env = process.env) {
  const clean = {};
  for (const [k, v] of Object.entries(env || {})) if (!k.startsWith("npm_config_")) clean[k] = v;
  return clean;
}

// npm, once, into the scratch folder (the dashboard spec, contract 15): an
// install of exactly PAGE_PACKAGE@version with --ignore-scripts, from the
// user's registry when it was read; when it was not, no --registry, so npm,
// run in the scratch with a clean environment, takes the user's own
// configuration (~/.npmrc, the upper-case NPM_CONFIG_*). The tree is
// computed, never read from npm's output.
async function install(scratch, { version, registry, env, spawn, budget, ctx }) {
  const own = installEnv(env);
  const call = npmCall(fetchArgv({ prefix: scratch, registry, shell: PAGE_PACKAGE, version }), own);
  const r = await runHost(call.bin, call.argv, { env: own, cwd: scratch, budget, spawn, shell: call.shell });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") return { ok: false, code: "EBUDGET", error: refusalText("EBUDGET", ctx) };
    const cause = startFailure(r.error, { bin: "npm", resolved: call.resolved, cwd: scratch });
    return { ok: false, code: "ESTART", error: refusalText("ESTART", { ...ctx, cause }) };
  }
  if (r.status !== 0) {
    const e = npmError(r.stdout, r.stderr);
    // npm reports a request it gave up on as FETCH_ERROR, "network timeout at: <url>".
    const timeout = e.code === "FETCH_ERROR" && /network timeout at:\s*(\S+)/.exec(e.summary);
    if (timeout) return { ok: false, code: e.code, error: refusalText("FETCH_TIMEOUT", { ...ctx, url: timeout[1] }) };
    return {
      ok: false,
      code: e.code || `exit ${r.status}`,
      error: refusalText(e.code, { ...ctx, summary: e.summary }),
    };
  }
  const dir = join(scratch, "node_modules", PAGE_PACKAGE);
  const wrong = checkPage(dir, version);
  if (wrong)
    return {
      ok: false,
      code: "EVERIFY",
      error: `The fetched ${ctx.pkg} is not this copy's page: ${wrong}. Nothing is kept, and the page is not started.`,
    };
  return { ok: true, dir };
}

// The fetched folder, moved whole to the version's place (the dashboard spec,
// contract 17). A place another run filled first is adopted when it holds the
// page. A bad folder there (another package or version, or no server) is
// checked again, then set aside into this run's scratch, which goes with it,
// and the move is tried once more. What was set aside is checked a third
// time: a good page another run placed between the check and the move goes
// back, so a run never removes a good folder.
function place(from, target, { cache, scratch, version, movePathFn = movePath }) {
  const good = (dir) => checkPage(dir, version) === null;
  // Two launches can pass movePath's look at the target together, and the
  // loser's rename then fails: ENOTEMPTY or EEXIST here, EPERM on Windows.
  // Any failed move into the target looks at it again: a good page there is
  // used; a bad one after ENOTEMPTY or EEXIST is set aside below; any other
  // failure is the cache's refusal.
  const move = (a, b) => {
    try {
      return movePathFn(a, b, cache.root);
    } catch (e) {
      if (b === target && (good(target) || e?.code === "ENOTEMPTY" || e?.code === "EEXIST")) return "target-exists";
      throw e;
    }
  };
  let r = move(from, target);
  if (r === "target-exists" && !good(target)) {
    const aside = join(scratch, "aside");
    if (move(target, aside) === "moved" && good(aside)) r = move(aside, target);
    else r = move(from, target);
  }
  if ((r === "moved" || r === "target-exists") && good(target)) return null;
  return checkPage(target, version) || `${from} could not be moved to ${target}`;
}

// The page folder of an npm copy at `root`: the cache's, or one fetched now.
// `onFetch(label)` → a live line ({ end, abort }) or null: the caller draws it
// at a terminal only. `spawn`, `budget` and `movePathFn` (lib's movePath, or a
// stand-in that loses a race) are the tests'.
export async function pageFor({
  root,
  project = null,
  env = process.env,
  home = homedir(),
  spawn,
  budget = HOST_BUDGET_MS,
  onFetch = null,
  movePathFn = movePath,
} = {}) {
  const refuse = (error, code = null) => ({ ok: false, error, code });
  // Any other copy fetches no page (the dashboard spec, contract 4).
  if (!npmCopy(root, { home })) {
    const v = rootVersion(root);
    return refuse(
      [
        `This copy of projectstore${v ? ` ${v}` : ""}, at ${JSON.stringify(String(root))}, has no dashboard/ folder and is not a copy installed from npm, so it fetches no page: only a copy from npm fetches its page, at its own version. The copy from npm opens it, ${project ? fromTerminalIn(project) : "from a terminal in the project"}:`,
        packageCommand([], "dashboard"),
      ].join("\n"),
      "ECHANNEL",
    );
  }
  const version = pageVersion(root);
  if (!version)
    return refuse(
      `This copy of projectstore names no release version in ${join(root, "package.json")} (${JSON.stringify(rootVersion(root))}), so no page is fetched for it.`,
      "EVERSION",
    );
  const pkg = `${PAGE_PACKAGE}@${version}`;
  const cache = cachePaths({ env, home });
  if (!cache.root) return refuse(noCacheText(cache), "ENOCACHE");
  const target = cache.dashboard(version);
  // The page of this version, kept (the dashboard spec, contract 14): no npm,
  // no network.
  if (checkPage(target, version) === null) return { ok: true, dir: target, fetched: false };
  sweepFetchRuns(cache.fetch);
  const scratch = cache.fetchRun(fetchRunId());
  try {
    mkdirSync(scratch, { recursive: true });
  } catch (e) {
    return refuse(cacheText(cache, e), "ECACHE");
  }
  const line = onFetch ? onFetch(`fetching ${pkg}`) : null;
  try {
    // The user's own registry, never a project's .npmrc: code this verb runs
    // without a question is chosen the way setup chooses it, and the cache
    // keys a page by its version alone. A read that fails is null: npm then
    // takes the user's configuration itself, never a registry forced here.
    const registry = await npmUserRegistry({ home, env, spawn, budget: Math.min(budget, REGISTRY_BUDGET_MS) });
    const ctx = { pkg, version, registry, project, budget };
    const got = await install(scratch, { version, registry, env, spawn, budget, ctx });
    if (!got.ok) {
      if (line) line.end(false, `fetch failed ${pkg}`, got.code);
      return refuse(got.error, got.code);
    }
    let wrong;
    try {
      wrong = place(got.dir, target, { cache, scratch, version, movePathFn });
    } catch (e) {
      if (line) line.end(false, `fetch failed ${pkg}`, e?.code || "ECACHE");
      return refuse(cacheText(cache, e), "ECACHE");
    }
    if (wrong) {
      if (line) line.end(false, `fetch failed ${pkg}`, "EVERIFY");
      return refuse(`The page of ${version} in the cache is not ${pkg}: ${wrong}. Nothing is started.`, "EVERIFY");
    }
    if (line) line.end(true, `fetched ${pkg}`);
    return { ok: true, dir: target, fetched: true };
  } catch (e) {
    if (line) line.abort();
    throw e;
  } finally {
    // The scratch goes whatever happened: npm's tree, a stale page set aside.
    try {
      removeTreeUnder(scratch, cache.root, { maxRetries: 3 });
    } catch {}
  }
}

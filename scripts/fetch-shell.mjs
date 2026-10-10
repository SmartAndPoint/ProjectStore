// projectstore — fetch-shell.mjs: the shell fetch of install and upgrade.
//
// A harness whose plugin root ships only in its distribution shell (Codex:
// its registration surface carries `condition: "distribution_root"`) cannot
// be registered from the core alone. So a core run that stages fetches that
// shell, at the core's own version, into a scratch directory under the
// user-level cache, verifies it, and plans the harness from it in the same
// plan() as every other harness — one PLAN, one question, one APPLY (the
// ADR "One front door: projectstore setup installs every harness it finds;
// shells are release artifacts, not user commands", decision 3; the story
// "Install and upgrade fetch a shell-rooted harness at the bin's own version,
// once per run; plan and uninstall never fetch", rules 1–4 and 9).
//
//   rootVersion(root)                 → <root>/package.json's version, or null
//   fetchDecision({…})                → { fetch, why } — rule 1, pure
//   fetchArgv({ prefix, registry, … }) → rule 2's npm argv, plan's and the run's
//   npmRegistry(projectDir, { env })  → the registry npx would see there, or null
//   fetchShell(job, { dir, registry }) → { ok, root, ms } or { ok: false, code, refusal }
//   verifyFetched(root, { … })        → null, or the refusal naming file and values
//   fetchRefusal(code, ctx)           → rule 4's texts
//   sweepFetchRuns(fetchDir)          → the leftovers of dead runs, removed
//   fetchRunId()                      → <pid>-<epoch ms>
//
// Nothing here decides a registration's rows: the analyser and the installer
// do, from the fetched root this module hands them. Only install-harness.mjs
// imports this file; hooks, doctor, surfaces and lib never do (the
// portability suite asserts it). Pure node, no external deps.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { insideHostSession } from "./harness.mjs";
import { removeTreeUnder, pidAlive, whichOnPath } from "./lib.mjs";
import { isPortablePluginRoot, payloadManifest, payloadManifestPath, payloadManifestPaths } from "./portable-registration.mjs";
import { runHost, startFailure, HOST_BUDGET_MS } from "./run-host.mjs";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// The version a shell-rooted harness is fetched at has one source: the
// package.json of the root the plan runs from — never `latest`, never a range.
export function rootVersion(root) {
  const v = readJson(join(String(root || ""), "package.json"))?.version;
  return typeof v === "string" && v ? v : null;
}

// The core's own package name, which the fetched shell bundles under its
// node_modules (the shells ADR: the shell pins the core exactly).
export function rootName(root) {
  const n = readJson(join(String(root || ""), "package.json"))?.name;
  return typeof n === "string" && n ? n : null;
}

const STAGING_VERBS = ["install", "upgrade", "setup"];

// Rule 1, as one pure decision per harness. A run fetches a harness's shell
// only when every condition holds; the first that fails is `why`, which the
// tests read and nothing prints (the row a skipped fetch shows is the
// installer's, rule 1's table).
//   verb         — the run stages: install or upgrade (and setup, when it lands)
//   harness, s   — the manifest and its registration surface
//   excluded     — --no-register, or a --surface that does not name it
//   named        — a harness was named: the confirmation without a terminal
//   interactive  — a person at a terminal will be asked (isInteractive, or `ask`)
//   analysis     — a version-only analysis of the registration
//   ownShell     — the run is this harness's own shell's core (rule 8)
//   env          — the run's: a named distribution root, a session marker
export function fetchDecision({ verb, harness, s, excluded = false, named = false, interactive = false, analysis = null, ownShell = false, env = process.env } = {}) {
  if (!STAGING_VERBS.includes(verb)) return { fetch: false, why: "verb" };
  if (s?.condition !== "distribution_root" || !harness?.install?.shell) return { fetch: false, why: "not-shell-rooted" };
  if (excluded) return { fetch: false, why: "excluded" };
  // A set root is used as is — a root or not — and nothing is fetched.
  if (env && env.PROJECTSTORE_DISTRIBUTION_ROOT) return { fetch: false, why: "root-named" };
  // A bare run that cannot be asked refuses at the gate; its preview is the dry run.
  if (!named && !interactive) return { fetch: false, why: "not-interactive" };
  // The registration defers in the harness's own session (decision 2), and
  // the fetch is skipped for a registration that will defer.
  if (insideHostSession(env, harness)) return { fetch: false, why: "in-session" };
  // The host's facts alone decide these rows; a payload would change none.
  if (["unavailable", "foreign", "conflict"].includes(analysis?.state)) return { fetch: false, why: analysis.state };
  // No host CLI: the row defers whatever of ours exists, so a fetch — which
  // may fail offline — must not turn a deferral into a refusal (the ADR: the
  // fetch is skipped for a harness whose registration will defer).
  if (!analysis?.bin) return { fetch: false, why: "no-host-cli" };
  if (ownShell) return { fetch: false, why: "own-shell" };
  return { fetch: true, why: null };
}

// Rule 2's argv, after `npm`. One builder for plan's dry-run step (literal
// <run-id> and <registry>) and the run's own fetch. --prefix hides a
// project's .npmrc, so only the registry is forwarded; with none resolved,
// npm resolves it from user config. The four --fetch-… flags bound one
// request to about 96 s and a refused connection to about 6 s (npm 11.19's
// defaults wait 10 s, then 60 s: 70.3 s measured); the run's own budget is the
// outer bound. --ignore-scripts: no install-time code from a registry runs.
export function fetchArgv({ prefix, registry = null, shell, version }) {
  return [
    "install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--json",
    ...(registry ? ["--registry", registry] : []),
    "--fetch-timeout=30000", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=5000",
    `${shell}@${version}`,
  ];
}

// Node runs a .cmd only through a shell, and a shell splits on spaces, so on
// win32 the bin and every argument are quoted. Unverified, as the install
// spec already says of Windows.
const WIN = process.platform === "win32";
const winQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;
function npmCall(argv, env) {
  const resolved = whichOnPath("npm", env);
  const bin = resolved || (WIN ? "npm.cmd" : "npm");
  return { resolved, bin: WIN ? winQuote(bin) : bin, argv: WIN ? argv.map(winQuote) : argv, shell: WIN };
}

// The registry `npx` run in this project would see: one `npm config get
// registry` with the project as its working directory, so a registry its
// .npmrc names counts (npm walks up to the nearest package.json or
// node_modules), and an outer npx's npm_config_registry outranks it as npm
// ranks the environment above a file (measured). Null when the read fails or
// runs past its own short budget — a local read that hangs must not add a
// second 120 s to the fetch's — and the fetch then passes no --registry.
// --no-update-notifier: npm otherwise asks the registry about itself here too.
// Exported for the update notice.
export const REGISTRY_BUDGET_MS = 10000;
export async function npmRegistry(projectDir, { env = process.env, spawn, budget = REGISTRY_BUDGET_MS } = {}) {
  const call = npmCall(["config", "get", "registry", "--no-update-notifier"], env);
  const r = await runHost(call.bin, call.argv, { env, cwd: projectDir, budget, spawn, shell: call.shell });
  if (r.error || r.status !== 0) return null;
  const value = String(r.stdout || "").trim().split(/\r?\n/).pop()?.trim() || "";
  return value && !/\s/.test(value) && value !== "undefined" ? value : null;
}

// npm's --json error, which it prints on stdout: { error: { code, summary,
// detail } }. stderr is the fallback, read for its `npm error code X` line
// only — npm's raw stderr, log path included, is never shown.
export function npmError(stdout, stderr) {
  try {
    const e = JSON.parse(String(stdout || ""))?.error;
    if (e && typeof e === "object") return { code: String(e.code || "") || null, summary: String(e.summary || "").trim(), detail: String(e.detail || "").trim() };
  } catch {}
  const code = String(stderr || "").match(/npm (?:error|ERR!) code (\S+)/)?.[1] || null;
  const summary = String(stderr || "").split(/\r?\n/).map((l) => l.replace(/^npm (?:error|ERR!) ?/, "").trim()).find((l) => l && !/^code \S+$/.test(l) && !/complete log of this run/i.test(l)) || "";
  return { code, summary, detail: "" };
}

const seconds = (ms) => `${Number((ms / 1000).toFixed(ms % 1000 ? 1 : 0))} s`;

// Rule 4's refusals, by npm's code or ours. `ctx`: pkg ("<shell>@<v>"),
// shell, registry (null: npm's own), display (the harness's display name),
// budget, summary (npm's), cause (a start failure's), path/from/variable (the
// cache). Every way out is a terminal command or a variable; none names a
// version but the one this run is at.
export function fetchRefusal(code, ctx = {}) {
  const { pkg = "the shell", shell = "the shell", registry = null, display = "this harness", budget = HOST_BUDGET_MS, summary = "", cause = "", path = null, from = null, variable = null } = ctx;
  const where = registry || "the registry npm resolves";
  const without = `name --harness without ${display}`;
  switch (code) {
    case "ETARGET":
    case "E404":
      return `${pkg} is not on ${where} (npm ${code}); ${display} is registered from that shell at this exact version, and no other version is tried. Just released? The shell is published after the core, so retry in a few minutes. From a checkout at an unpublished version, point PROJECTSTORE_DISTRIBUTION_ROOT at the output of \`npm run shells:build -- --dev\` (dist/build/${shell}). Or ${without}.`;
    // Our budget, not npm's: npm's own ETIMEDOUT (a socket) is any other code.
    case "EBUDGET":
      return `fetching ${pkg} from ${where} took longer than ${seconds(budget)} and was stopped. Retry, or ${without}.`;
    case "FETCH_TIMEOUT":
      return `npm gave up on ${ctx.url || where} (network timeout) while fetching ${pkg}. Retry, or ${without}.`;
    case "E401":
    case "E403":
      return `${where} refused the credentials for ${pkg} (npm ${code}). A project .npmrc's token does not reach this fetch — only its registry does — so the registry's token must be in user config: ~/.npmrc, or an NPM_CONFIG_… variable. Or point PROJECTSTORE_DISTRIBUTION_ROOT at a ${shell} root obtained another way.`;
    case "ESTART":
      return `${cause}; ${display} is registered from its shell, which npm fetches. Put npm on PATH, or ${without}.`;
    case "ENOCACHE":
      return `the shell fetch has no cache directory: ${variable} is not an absolute path and the home directory is unknown. Set ${variable} to a writable directory, then run this again.`;
    case "ECACHE":
      return `the cache directory ${path} cannot be written (${ctx.errno || "error"}); it comes from ${from}. Set ${variable} to a writable directory, then run this again.`;
    default:
      return `npm could not fetch ${pkg} from ${where}: ${code || "an unknown error"}${summary ? ` — ${summary.split(/\r?\n/)[0]}` : ""}. ${display} is registered from its shell, which needs the network: retry once the registry is reachable, or ${without}.`;
  }
}

// Rule 3: the fetched tree is what this run plans, before it is planned —
// the shell's name and version, a plugin root by the analyser's own predicate,
// its plugin manifest's name and version, and the bundled core at the same
// version (the pairing the shells ADR promises: the core Codex runs is the
// core this release rendered). Null when it holds; otherwise the refusal,
// naming the file and both values. Nothing is staged either way.
export function verifyFetched(root, { shell, version, pluginName, coreName }) {
  const pkg = `${shell}@${version}`;
  const mismatch = (file, what, got, want) => `the fetched ${pkg} is not what this run plans: ${file} has ${what} ${JSON.stringify(got ?? null)}, expected ${JSON.stringify(want)} — nothing is staged`;
  const pkgFile = join(root, "package.json");
  const shellPkg = readJson(pkgFile);
  if (shellPkg?.name !== shell) return mismatch(pkgFile, "name", shellPkg?.name, shell);
  if (shellPkg?.version !== version) return mismatch(pkgFile, "version", shellPkg?.version, version);
  if (!isPortablePluginRoot(root)) return `the fetched ${pkg} is not a plugin root: neither ${payloadManifestPaths(root).join(" nor ")} exists — nothing is staged`;
  // Exactly the shell's one manifest, the one the host validates: a root
  // manifest would be read first and load no hooks, so it never passes.
  const manifestFile = payloadManifestPath(root, "legacy");
  const rootFile = payloadManifestPath(root, "root");
  if (existsSync(rootFile)) return `the fetched ${pkg} carries ${rootFile}, which the host reads before ${manifestFile} and loads no hooks from — nothing is staged`;
  const manifest = payloadManifest(root, { kind: "legacy" });
  if (!manifest) return `the fetched ${pkg} has no readable plugin manifest at ${manifestFile} — nothing is staged`;
  if (manifest.name !== pluginName) return mismatch(manifestFile, "name", manifest.name, pluginName);
  if (manifest.version !== version) return mismatch(manifestFile, "version", manifest.version, version);
  const coreFile = join(root, "node_modules", coreName, "package.json");
  const core = readJson(coreFile);
  if (core?.version !== version) return mismatch(coreFile, "version", core?.version, version);
  return null;
}

// The fetch itself: npm, asynchronously, in `dir` (made by the caller), with
// the run's environment. The payload root is computed, never read from npm's
// output: npm's --json result printed it with one UUID-like segment redacted
// as *** (measured). A failure is a refusal before the plan, never a fallback.
export async function fetchShell({ harness, s, version, coreName }, { dir, registry = null, env = process.env, spawn, budget = HOST_BUDGET_MS } = {}) {
  const shell = harness.install.shell;
  const pkg = `${shell}@${version}`;
  const ctx = { pkg, shell, registry, display: harness.display_name, budget };
  const call = npmCall(fetchArgv({ prefix: dir, registry, shell, version }), env);
  const t0 = Date.now();
  const r = await runHost(call.bin, call.argv, { env, cwd: dir, budget, spawn, shell: call.shell });
  const ms = Date.now() - t0;
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") return { ok: false, ms, code: "ETIMEDOUT", refusal: fetchRefusal("EBUDGET", ctx) };
    return { ok: false, ms, code: r.error.code || "ESTART", refusal: fetchRefusal("ESTART", { ...ctx, cause: startFailure(r.error, { bin: "npm", resolved: call.resolved, cwd: dir }) }) };
  }
  if (r.status !== 0) {
    const e = npmError(r.stdout, r.stderr);
    // npm reports a request it gave up on as FETCH_ERROR, "network timeout
    // at: <url>" (measured in review, 2026-10-08), not as ETIMEDOUT.
    const timeout = e.code === "FETCH_ERROR" && /network timeout at:\s*(\S+)/.exec(e.summary);
    if (timeout) return { ok: false, ms, code: e.code, refusal: fetchRefusal("FETCH_TIMEOUT", { ...ctx, url: timeout[1] }) };
    return { ok: false, ms, code: e.code || `exit ${r.status}`, refusal: fetchRefusal(e.code, { ...ctx, summary: e.summary }) };
  }
  const root = join(dir, "node_modules", shell);
  const wrong = verifyFetched(root, { shell, version, pluginName: s.plugin_name, coreName });
  if (wrong) return { ok: false, ms, code: "EVERIFY", refusal: wrong };
  return { ok: true, ms, root };
}

// <pid>-<epoch ms>: the run that owns a scratch directory, by its name.
export function fetchRunId() {
  return `${process.pid}-${Date.now()}`;
}

// Rule 9's sweep, run by the next fetching run: every <fetch>/<pid>-<ms>
// whose pid is dead goes. A live pid — ours or not (EPERM) — keeps its
// directory, which may be a run waiting at its question for days, and any
// other name stays. No age rule: a reused pid keeps a leftover until a later
// sweep, which costs about 1.4 MB, never data. An npm still writing into a
// dead run's directory is caught by a later sweep: it converges.
export function sweepFetchRuns(fetchDir) {
  let names;
  try { names = readdirSync(fetchDir); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const m = /^(\d+)-\d+$/.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!pid || pid === process.pid || pidAlive(pid)) continue;
    try { removeTreeUnder(join(fetchDir, n), fetchDir, { maxRetries: 3 }); removed.push(n); } catch {}
  }
  return removed;
}

// projectstore — convergence.mjs: what install and upgrade decide, before
// the plan, about the copies of ours this project already runs (the story
// "Setup and upgrade converge this project onto the running version: the
// channel switch, no downgrade, and the update notice", rules 1, 2, 5, 6 and 8; the
// ADR "One front door: projectstore setup installs every harness it finds;
// shells are release artifacts, not user commands", decision 4).
//
//   runningCopies(projectDir, { harnesses, root, home, env, channel, … })
//                                     → rule 6's copies, read-only
//   readLatest({ registry, cachePath, fetch, now, timers, timeoutMs, atLeast })
//                                     → { latest, from, error }: one read, cached a day
//   decide({ copies, version, read, skipped, verb, args })
//                                     → stop or proceed, with the stop's texts
//   proceedCase(decision, v)          → the words a newer row adds when not stopped
//   channelChoices({ harness, copy, running, gate, pin }) → the ways to settle a
//                                       project's channel (rule 2's helper: the
//                                       gate's text, and a newer copy's): setup's
//   pinFor(root, version)             → the version a command names: the running
//                                       one, on a package root
//   newerCopyDeferral({ copy, running, decision, harness, pin })
//                                     → a newer copy not switched off: { reason, advice }
//   switchConsequence()               → a switch row's consequence line (rule 2)
//   directoryConsequence(display), directoryKeepConsequence(display, key)
//                                     → an npm registration over a directory copy,
//                                       and the keep of that copy (PS-DIRECTORY)
//   copyOrigin(copy), DIRECTORY        → where a kept or competing copy comes from
//   switchReason({ copy, running, runs, decision, unbound })
//                                     → what a switch row adds under the channel "npm"
//   noCopyToKeep({ harness, surface, off }) → the channel "git" with nothing to keep
//   keepArgv(copy, { verb, harness, projectDir }) → the kept copy's bin, remedy form + --json
//   readKeepPlan(copy, { harness, projectDir, env, run, budget })
//                                     → the kept copy's own plan: writes, ok, incomplete, refusals
//   keepResult(stdout)                → a bin --json envelope's `result`, or null
//   ownUpgrade(copy, harness), npmRowBeside({ harness, id, surface }) → the keep's next lines
//   repairAdvice(harness, v)          → a damaged newer registration's way out
//   advised(text, blocks)             → { reason, advice }: prose, then commands alone
//   updateNotice({ latest, version, root, verb }) → the notice's text and command
//   hostCopyRoot, checksRoot, noticeRoot (root, { home, env }), updateCheckOff(env)
//
// The one owner of the stop: the prepare step calls decide() and, on a stop,
// short-circuits before the keep read and the fetch; plan() only renders what
// it is handed and reads no registry. Every clock, timer, fetch and cache
// path is a parameter, so each rule is a unit test with plain values. The
// one file it touches is the registry cache, written after a successful read.
//
// Imports lib, harness, portable-registration and surfaces, never the fetch
// or the host runner: every spawn and resolver is the caller's. Only the
// installer and setup's front-end (setup.mjs, which reads the running copies
// before its questions) import this file; doctor, lib and the hooks never do,
// so the SessionStart graph never loads it (tests/convergence.test.mjs
// asserts both). Pure node, no external deps — the read is Node's own fetch.

import { readFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  cmpPrecedence,
  installChannel,
  projectCopiesByKey,
  writeFileAtomic,
  envFlag,
  isEphemeralRoot,
  COPY_UPDATE_STEPS,
  SYNCED_UPDATE_STEPS,
  isSyncedCopy,
} from "./lib.mjs";
import { loadHarness, loadHarnesses } from "./harness.mjs";
import { analysePortableRegistration, portableRegistrationPaths } from "./portable-registration.mjs";
import { registrationPaths } from "./surfaces.mjs";

// The package every literal command here names: the core, in the core form
// (rule 9's command-form rule). The shells bundle it; the notice and the stop
// name the package that runs, never a shell.
export const PACKAGE = "projectstore";
// What the read uses when the user's registry cannot be resolved.
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
// The abbreviated packument: what `npm install` itself reads (8 728 bytes
// against 50 896 for the full document, measured 2026-10-09).
export const ACCEPT = "application/vnd.npm.install-v1+json";
// The request's bound. On the notice-only path it is the whole bound — the
// user's registry resolver and the request share it; rule 6's read keeps the
// resolver's own 10 s (REGISTRY_BUDGET_MS, fetch-shell.mjs) before it.
export const READ_TIMEOUT_MS = 2000;
export const NOTICE_BUDGET_MS = 2000;
// What the resolver leaves of a shared bound is no time for a request below
// this: no registry answers in less, and the resolver's timer and Date.now()
// round differently, so a resolver that took the whole bound can read as one
// that left 1 ms of it.
export const MIN_READ_MS = 50;
export const FRESH_MS = 24 * 60 * 60 * 1000;
export const NO_CHECK_ENV = "PROJECTSTORE_NO_UPDATE_CHECK";

// Strict semver 2.0 (semver.org's own grammar): a `dist-tags.latest` that is
// anything else counts as missing — never printed, never compared.
const NUM = "(?:0|[1-9]\\d*)";
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
export const isSemver = (v) => typeof v === "string" && SEMVER.test(v);

// ─── Which roots check (rule 6) and show the notice (rule 8) ────────────

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (root, dir) => {
  const r = real(root),
    d = real(dir);
  return r === d || r.startsWith(d + sep);
};

// A copy a host runs, updated through its own channel (layout spec contract
// 12): never stopped, never told to update. installChannel names the host's
// cache copies; two more roots a session runs are recognised here, from the
// manifests' own paths (the review of PR1, F2):
// - our registration's marketplace directory: a host that loads it in place
//   runs the plugin from <dir>/<plugin_subdir> (the npm registration's root);
// - anything under a portable registration's stable source or its host's
//   plugin cache: the core a harness's shell bundles there (the Codex skills'
//   root, <harness home>/plugins/cache/…/node_modules/projectstore).
// Doctor keeps installChannel's answers; only these two checks read this.
export function hostCopyRoot(root, { home = homedir(), env = process.env } = {}) {
  if (!root) return false;
  // A copy synced from claude.ai (Anthropic's directory) is one too: claude.ai
  // updates it (the install spec, contract 21, rule 2).
  if (["registration", "marketplace", "synced"].includes(installChannel(root, { home }))) return true;
  for (const m of loadHarnesses().values()) {
    for (const s of Object.values(m.surfaces || {})) {
      if (s?.kind !== "registration") continue;
      if (s.format === "host-plugin-registration") {
        const p = registrationPaths(s, { home, harness: m });
        if (within(root, p.payload) || within(root, p.cacheDir)) return true;
      } else if (s.format === "portable-plugin-registration") {
        const p = portableRegistrationPaths(s, { home, projectDir: home, harness: m, env });
        if (within(root, p.dir) || within(root, p.cacheDir)) return true;
      }
    }
  }
  return false;
}

// Who checks (rule 6): a package root or a checkout that is not a host's
// copy. Who shows the notice (rule 8): a package root that is not one. A
// checkout is updated by git and shows no notice.
export function checksRoot(root, { home = homedir(), env = process.env } = {}) {
  return ["package", "checkout"].includes(installChannel(root, { home })) && !hostCopyRoot(root, { home, env });
}
export function noticeRoot(root, { home = homedir(), env = process.env } = {}) {
  return installChannel(root, { home }) === "package" && !hostCopyRoot(root, { home, env });
}
export const updateCheckOff = (env) => envFlag(env, NO_CHECK_ENV);

// ─── The copies this project runs (rule 6) ──────────────────────────────

// For each harness of the run:
// - a host plugin registration: contract 12's rows, one per key — the row the
//   host loads here (lib's projectCopiesByKey, the same rows the registration's
//   competing copies are read from) — of any marketplace: the npm
//   registration's row and a git-marketplace copy alike, and a copy synced
//   from claude.ai (Anthropic's directory) while no copy of another origin is
//   enabled here — Claude Code loads any of them over it. Under channel "git"
//   none: that run renders nothing for it;
// - a portable registration: the global registration's recorded version,
//   when it is effectively enabled for this project.
// `analyse(harness, s)` lets the caller share one analysis with the fetch.
export function runningCopies(
  projectDir,
  { harnesses = [], root, home = homedir(), env = process.env, channel = null, version = null, analyse = null } = {},
) {
  const out = [];
  for (const id of harnesses) {
    const harness = loadHarness(id);
    if (!harness) continue;
    for (const [key, s] of Object.entries(harness.surfaces || {})) {
      if (key.startsWith("_") || s?.kind !== "registration") continue;
      if (s.format === "host-plugin-registration") {
        if (channel === "git") continue;
        const rows = projectCopiesByKey(home, projectDir);
        const shadowed = rows.some((e) => !e.synced);
        for (const e of rows) {
          if (e.synced && shadowed) continue;
          if (typeof e.version === "string" && e.version)
            out.push({ harness: id, key: e.key, version: e.version, path: e.path, scope: e.scope, own: e.own });
        }
      } else if (s.format === "portable-plugin-registration") {
        const a = analyse
          ? analyse(harness, s)
          : analysePortableRegistration(projectDir, s, { root, home, harness, env, version });
        const v = a?.ownership?.version;
        if (typeof v === "string" && v && a.enabled) out.push({ harness: id, key: a.id, version: v });
      }
    }
  }
  return out;
}

export const newerCopies = (copies, version) =>
  version ? copies.filter((c) => cmpPrecedence(c.version, version) > 0) : [];
// The lowest of them: a fresh cache entry below it is read again (rule 8).
export const lowestVersion = (copies) => copies.map((c) => c.version).sort(cmpPrecedence)[0] || null;

// ─── The registry read (rule 8) ──────────────────────────────────────────

function readCache(cachePath) {
  if (!cachePath) return {};
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

// Fresh for a day; an `at` in the future is stale (a clock that moved back).
function fresh(entry, t) {
  const at = Date.parse(entry?.at || "");
  return Number.isFinite(at) && at <= t && t - at < FRESH_MS;
}

// One request, bounded: the timer aborts the request and settles the read,
// whatever the fetch does after — a fetch that never settles costs the bound.
// An answer that is not read (an error status) has its body cancelled, so
// its connection is released.
function request(url, { fetch, timers, timeoutMs }) {
  return new Promise((settle) => {
    let done = false,
      timer = null;
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer !== null) {
        try {
          timers.clearTimeout(timer);
        } catch {}
      }
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
    Promise.resolve()
      .then(() => fetch(url, { headers: { accept: ACCEPT }, ...(ac ? { signal: ac.signal } : {}) }))
      .then(async (res) => {
        if (!res || !res.ok) {
          try {
            Promise.resolve(res?.body?.cancel?.()).catch(() => {});
          } catch {}
          return finish({ error: `HTTP ${res?.status ?? "error"}` });
        }
        let body;
        try {
          body = await res.json();
        } catch {
          return finish({ error: "the answer is not JSON" });
        }
        const latest = body && typeof body === "object" ? body["dist-tags"]?.latest : undefined;
        if (!isSemver(latest)) return finish({ error: "the answer names no dist-tags.latest" });
        finish({ latest });
      })
      .catch((e) => finish({ error: String(e?.cause?.code || e?.code || e?.message || "the request failed") }));
  });
}

// The cache's one write per answer (a failed read is never cached): the entry
// keyed by the registry this run resolved, and `user_latest`, which the
// self-update ADR's session line reads without a registry of its own. This
// read never learns a publish time: `published_at` stays as it was for the
// same latest, else null. A write that fails is ignored.
function writeCache(cachePath, cache, registry, latest, at) {
  if (!cachePath) return;
  const prev = cache.user_latest && typeof cache.user_latest === "object" ? cache.user_latest : null;
  const next = {
    ...cache,
    [registry]: { latest, at },
    user_latest: {
      latest,
      at,
      published_at: prev && prev.latest === latest && typeof prev.published_at === "string" ? prev.published_at : null,
    },
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileAtomic(cachePath, JSON.stringify(next, null, 2) + "\n", { sweep: false });
  } catch {}
}

// `GET <registry>/projectstore` with the abbreviated Accept header, no
// credentials, bounded by `timeoutMs`; the answer is `dist-tags.latest`. A
// fresh entry for this registry answers instead — unless it is below
// `atLeast`, the lowest newer copy rule 6 asks about: a release may have come
// out since it was written. The cache never supplies a URL: an entry is only
// looked up with the registry this run resolved. Never throws.
/* eslint-disable n/no-unsupported-features/node-builtins -- the global fetch is experimental but present at Node 20 and stable from 21; without it readLatest answers "no fetch in this Node", and the suite runs it on Node 20 in CI */
export async function readLatest({
  registry,
  cachePath = null,
  fetch = globalThis.fetch,
  now = Date.now,
  timers = globalThis,
  timeoutMs = READ_TIMEOUT_MS,
  atLeast = null,
} = {}) {
  /* eslint-enable n/no-unsupported-features/node-builtins */
  try {
    const cache = readCache(cachePath);
    const entry = cache[registry];
    const t = now();
    if (entry && isSemver(entry.latest) && fresh(entry, t) && !(atLeast && cmpPrecedence(entry.latest, atLeast) < 0)) {
      return { latest: entry.latest, from: "cache", error: null };
    }
    if (typeof fetch !== "function") return { latest: null, from: null, error: "no fetch in this Node" };
    const url = `${String(registry).replace(/\/+$/, "")}/${PACKAGE}`;
    const r = await request(url, { fetch, timers, timeoutMs });
    if (!r.latest) return { latest: null, from: "network", error: r.error };
    writeCache(cachePath, cache, registry, r.latest, new Date(now()).toISOString());
    return { latest: r.latest, from: "network", error: null };
  } catch (e) {
    return { latest: null, from: null, error: String(e?.message || e) };
  }
}

// ─── Stop or proceed (rule 6) ───────────────────────────────────────────

// A command in the core form: `npx projectstore[@<v>] <verb> <args>`.
export function coreCommand(verb, { version = null, args = "" } = {}) {
  return `npx ${PACKAGE}${version ? `@${version}` : ""} ${verb}${args ? ` ${args}` : ""}`;
}

// Prose, then each command on a line of its own after its lead, nothing after
// it (presentation spec contract 6). `reason` is the whole of it with every
// part on its own line — the envelope's form, which an agent relays as it
// is; `advice` is what PLAN draws, the commands in their own blocks.
export function advised(text, blocks = []) {
  return {
    reason: [text, ...blocks.flatMap((b) => [b.lead, b.command])]
      .filter((x) => x !== null && x !== undefined)
      .join("\n"),
    advice: { text, blocks },
  };
}

// The run's own selection, repeated: --harness and --surface as given, and
// --no-register; never --project (the ADR's decision 5).
function runArgs({ harnesses = [], surfaces = null, register = true } = {}) {
  return [
    ...harnesses.map((h) => `--harness ${h}`),
    ...(surfaces || []).map((s) => `--surface ${s}`),
    ...(register === false ? ["--no-register"] : []),
  ].join(" ");
}

// The run a deferral sends to a terminal (the install spec, contract 6, as
// amended 2026-10-14): the run's own verb for one harness, its --surface
// selection, --global for a global removal, and setup's --channel npm when
// that was the answer for the harness whose channel it is (setup's rule 13 —
// a keep is never repeated). `plan` writes nothing, so it names install. One
// builder for a deferred row's reason and setup's DONE, so the two agree.
export function terminalRun({
  verb = "install",
  harness = null,
  version = null,
  surfaces = null,
  globalRemoval = false,
  channel = null,
} = {}) {
  const run = verb === "plan" ? "install" : verb;
  const hostRegistration = Object.values(harness?.surfaces || {}).some(
    (s) => s && typeof s === "object" && s.format === "host-plugin-registration",
  );
  const args = [
    runArgs({ harnesses: harness ? [harness.id] : [], surfaces }),
    globalRemoval ? "--global" : "",
    run === "setup" && channel === "npm" && hostRegistration ? "--channel npm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return coreCommand(run, { version, args });
}

// Stop when the registry's latest is at least a newer copy this project runs
// — the newest such copy is named. A copy the latest does not reach, or no
// answer, proceeds: the rows say which case it was (proceedCase). `read` is
// readLatest's answer, null when nothing was read; `skipped` says the read
// was switched off by PROJECTSTORE_NO_UPDATE_CHECK. The refusal's text puts
// each command on a line of its own, never followed by punctuation.
export function decide({
  copies = [],
  version = null,
  read = null,
  skipped = false,
  verb = "upgrade",
  args = {},
} = {}) {
  const newer = newerCopies(copies, version);
  const decision = { checks: true, version, newer, read: skipped ? { skipped: true } : read, stop: null };
  const latest = read && isSemver(read.latest) ? read.latest : null;
  if (skipped || !latest) return decision;
  const top = newer
    .filter((c) => cmpPrecedence(latest, c.version) >= 0)
    .sort((a, b) => cmpPrecedence(b.version, a.version))[0];
  if (!top) return decision;
  const lead = `this project runs ${PACKAGE} ${top.version} (${top.key}), newer than this package (${version}), and ${top.version} is published. Nothing is written. Run the newer one from a terminal in this project:`;
  const commands = [coreCommand(verb, { version: "latest", args: runArgs(args) }), `npm install -g ${PACKAGE}@latest`];
  const between = "or install it for the whole machine:";
  decision.stop = { copy: top, lead, commands, between, text: [lead, commands[0], between, commands[1]].join("\n") };
  return decision;
}

// The case a newer row names when the run proceeds (rule 6), for the copy at
// `v`: the dry run's note when no decision was made (plan reads nothing), none
// for a root that never checks, else what the read found.
export function proceedCase(decision, v) {
  if (decision === null || decision === undefined)
    return `install and upgrade read the registry first, and stop when ${v} is published`;
  if (!decision.checks) return null;
  const r = decision.read;
  if (!r) return null;
  if (r.skipped) return `the registry was not read (${NO_CHECK_ENV})`;
  if (!isSemver(r.latest)) return `the registry could not be read (${r.error || "no answer"})`;
  if (cmpPrecedence(r.latest, v) < 0) return `the registry's latest (${r.latest}) does not reach ${v}`;
  return `${v} is published (the registry's latest is ${r.latest})`;
}

// The version a command a person runs next names (the setup story, rule 17;
// the converge story's review follow-up): the running version on a package
// root — npx's cache, a node_modules — so a run of `npx projectstore@0.30.0`
// is answered by commands that run 0.30.0 again, never whatever is latest. A
// checkout or a host's own copy names none.
export function pinFor(root, version) {
  return version && root && isEphemeralRoot(root) ? version : null;
}

// Rule 2's helper: the ways to settle which copy a project runs, when a copy
// from another marketplace is enabled for it — setup's own commands (the
// setup story, rule 17): the terminal run, `npx projectstore setup`, which
// asks, then the two runs that name the answer without a terminal, `--channel
// npm` and `--channel git`, each alone on its line (a `|` copied into a shell
// is a pipe). Each names `@<version>` when the pin says so (pinFor), and
// never --project (the ADR's decision 5).
// - `gate` ({ args: { harnesses }, keys, directory, version }): the channel
//   gate's text (rule 2), for a switch planned under no channel answer
//   without a terminal, the run's own --harness repeated in each command.
//   `keys` are the git-marketplace copies a switch turns off, `directory` the
//   synced copies an npm registration loads over (PS-DIRECTORY): each named
//   by where it comes from. setup takes no --surface, so a narrowed run's
//   --surface is not repeated. A block with no lead follows the one before it.
// - otherwise, a newer copy that is not switched off (rule 6), for `harness`:
//   keeping it lets that copy write this project's surfaces (the keep), and
//   switching runs this older package — both named, after the terminal run.
export function channelChoices({ harness = null, copy = null, running = null, gate = null, pin = null } = {}) {
  if (gate) {
    const named = (where, keys) => (keys?.length ? `${where} (${keys.join(", ")})` : null);
    const from =
      [named("the git marketplace", gate.keys), named(DIRECTORY, gate.directory)].filter(Boolean).join(" and ") ||
      "the git marketplace";
    const run = (extra = "") =>
      coreCommand("setup", {
        version: gate.version || null,
        args: [runArgs({ harnesses: gate.args?.harnesses || [] }), extra].filter(Boolean).join(" "),
      });
    return [
      {
        lead: `Nothing written: this project loads ${PACKAGE} from ${from}, and moving it to the npm install is a choice made at a terminal in this project:`,
        command: run(),
      },
      { lead: "Without a terminal, name the channel:", command: run("--channel npm") },
      { lead: null, command: run("--channel git") },
    ];
  }
  const run = (extra = "") =>
    coreCommand("setup", { version: pin, args: [`--harness ${harness.id}`, extra].filter(Boolean).join(" ") });
  return [
    { lead: "Choose at a terminal in this project; setup asks whether to keep that copy or switch:", command: run() },
    {
      lead: `Without a terminal, keep ${copy?.key || "that copy"}, which then writes this project's surfaces itself:`,
      command: run("--channel git"),
    },
    {
      lead: `Or move this project to this package's npm install, the older ${running}:`,
      command: run("--channel npm"),
    },
  ];
}

// A newer copy from another marketplace under channel null: not switched
// off, because switching it off would run the project on an older package.
// The rows name both versions and the case, then the ways out.
export function newerCopyDeferral({ copy, running, decision, harness, pin = null }) {
  const c = proceedCase(decision, copy.version);
  const not = isSyncedCopy(copy) ? "the npm install is not registered over it" : "it is not switched off";
  const text = `this project runs a newer copy (${copy.key} ${copy.version}) than this package (${running}), so ${not}${c ? ` — ${c}` : ""}.`;
  return advised(text, channelChoices({ harness, copy, running, pin }));
}

// The consequence line of a switch (rule 2; presentation spec contract 7):
// the ADR's three facts — the git-marketplace copy is off for this project,
// the host's update no longer reaches it, and what updates it from now on —
// with no backticks, and no command followed by punctuation. The command is
// setup's, in the core form and unpinned (the setup story, rule 17): what
// updates the project from now on is whichever version runs it next.
export function switchConsequence() {
  return `this project stops loading the git-marketplace copy, and that copy's updates no longer reach it — from now on it is updated by ${coreCommand("setup")}`;
}

// Where a copy of ours from another channel comes from, in a person's words.
export const DIRECTORY = "Anthropic's directory";
export const copyOrigin = (copy) => (isSyncedCopy(copy) ? DIRECTORY : "the git marketplace");

// The consequence line of an npm registration over a copy synced from
// claude.ai (PS-DIRECTORY, "Setup and install keep a directory copy…",
// decision 4): never a switch — Claude Code loads the installed copy over the
// synced one by its own precedence, so nothing is turned off — and of the keep
// of that copy, setup's other answer (decision 6). `display`: the host's name.
export function directoryConsequence(display) {
  return `${display} then loads the npm copy here, and reports the directory copy as not loaded`;
}
export function directoryKeepConsequence(display, key) {
  return `${display} keeps loading ${key}, updated from claude.ai; setup refreshes this project's files through that copy`;
}

// The words a switch row adds under the channel "npm" (rules 2 and 6): over a
// copy newer than this package, both versions, the case the registry read
// found, and that the project will run the older one; for a project not bound
// yet, that the switch is recorded once it is.
export function switchReason({ copy, running, runs = running, decision, unbound = false }) {
  const off = isSyncedCopy(copy) ? "loading the npm copy over it" : "turning it off";
  const parts = [];
  // Against what the project runs once the copy is off (`runs`: the shared
  // directory's version when another checkout wrote a newer one), not against
  // this package: a copy older than that is no downgrade, and saying so
  // would be false.
  if (copy && typeof copy.version === "string" && runs && cmpPrecedence(copy.version, runs) > 0) {
    const c = proceedCase(decision, copy.version);
    parts.push(
      `${copy.key} ${copy.version} is newer than this package (${running})${c ? ` — ${c}` : ""}; ${off} runs this project on the older ${runs}`,
    );
  }
  if (unbound) parts.push("the project is not bound yet: the switch is recorded in its binding once it is");
  return parts.length ? parts.join("; ") : null;
}

// The channel "git" with no copy from another marketplace enabled for this
// project (rule 1): there is nothing to keep, and nothing is planned. The way
// back from an earlier switch is the registration's uninstall (rule 4); a copy
// of ours this checkout's local settings hold off — what a hand removal of the
// npm row leaves — is turned back on in the host. Each command alone on its
// line (presentation spec contract 6).
export function noCopyToKeep({ harness, surface, off = [] }) {
  const blocks = off.map((key) => ({
    lead: `This checkout's local settings hold ${key} off. To load it again, run this in ${harness.display_name}:`,
    command: `/plugin enable ${key}`,
  }));
  blocks.push({
    lead: "The way back from an earlier switch to the npm install is its uninstall, from a terminal in this project:",
    command: coreCommand("uninstall", { args: runArgs({ harnesses: [harness.id], surfaces: [surface] }) }),
  });
  return advised(
    `no git-marketplace copy of ${PACKAGE} is enabled for this project, so there is none to keep. Nothing is written.`,
    blocks,
  );
}

// ─── The keep (rule 5) ──────────────────────────────────────────────────

// The keep runs the kept copy's own bin in the layout remedy's form (layout
// spec contract 12): `--harness <id> --no-register --project <dir>`, plus
// `--json`, which lets the run read the child's result and keeps the child
// from asking — the run asks one question, its own. Never `--surface`: naming
// the status line would opt it in (rule 5). `process.execPath`, not `node`:
// the Node that runs us is sure to exist, and the PLAN shows the argv verbatim.
export function keepArgv(copy, { verb, harness, projectDir }) {
  return [
    process.execPath,
    join(copy.path, "bin", "projectstore.mjs"),
    verb,
    "--harness",
    harness.id,
    "--no-register",
    "--json",
    "--project",
    projectDir,
  ];
}

// The bin's `--json` envelope, `{ schema_version, verb, project, ok, result }`:
// its `result`, or null when stdout holds none. The top-level `ok` is never
// read — for plan it is `ok && !incomplete`, for a write verb the gate too.
export function keepResult(stdout) {
  let env;
  try {
    env = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  const r = env && typeof env === "object" && !Array.isArray(env) ? env.result : null;
  return r && typeof r === "object" && !Array.isArray(r) ? r : null;
}

// Rule 5's read of the kept copy's own plan, before plan(), in the prepare
// step: `plan --json` through its bin, with the project as the working
// directory and the caller's environment (the copy's root as the plugin root,
// the harness home pinned), stdin ignored, bounded at `budget`. `run` is the
// caller's asynchronous runner, runHost's shape: this module spawns nothing
// itself. `plan` is a dry run in every version the capability read passes, so
// the read writes nothing. Never throws. Returns:
//   { argv, envelope: false, status, stderr, error }   no result to read
//   { argv, envelope: true, ok, incomplete, refusals, writes, deferred, status }
// `writes` are the plan's rows that change something, as { surface, action,
// path }; `refusals` its plan-level refusals, then each refused row's reason;
// `deferred` the rows it left for later, as { surface, reason }.
export async function readKeepPlan(copy, { harness, projectDir, env, run, budget = 120000 } = {}) {
  const argv = keepArgv(copy, { verb: "plan", harness, projectDir });
  let r;
  try {
    r = await run(argv[0], argv.slice(1), { env, cwd: projectDir, budget });
  } catch (e) {
    r = { status: null, stdout: "", stderr: "", error: e };
  }
  const status = r?.status ?? null;
  const stderr = String(r?.stderr || "").trim();
  const result = keepResult(r?.stdout);
  if (!result)
    return { argv, envelope: false, status, stderr, error: r?.error ? String(r.error.message || r.error) : null };
  const items = Array.isArray(result.items) ? result.items.filter((i) => i && typeof i === "object") : [];
  const writes = items
    .filter((i) => !["skip", "refuse"].includes(i.action))
    .map((i) => ({ surface: String(i.surface ?? ""), action: String(i.action ?? ""), path: i.path ?? null }));
  const refusals = [
    ...(Array.isArray(result.refusals) ? result.refusals : []),
    ...items.filter((i) => i.action === "refuse").map((i) => i.reason),
  ].filter((x) => typeof x === "string" && x);
  // A deferred row's reason may carry its run on the lines after its prose
  // (the install spec, contract 6, as amended 2026-10-14): only the prose is
  // quoted inside our own sentence, never another copy's command.
  const deferred = items
    .filter((i) => i.deferred === true)
    .map((i) => ({
      surface: String(i.surface ?? ""),
      reason: typeof i.reason === "string" ? i.reason.split("\n")[0] : null,
    }));
  return {
    argv,
    envelope: true,
    ok: result.ok !== false,
    incomplete: result.incomplete === true,
    refusals,
    writes,
    deferred,
    status,
  };
}

// The kept copy's own upgrade, in the form channelChoices names a copy's bin:
// for a copy whose plan printed no result — run by the person, with its own
// preview and its own question (we never run what we could not preview,
// install spec contract 9).
export function ownUpgrade(copy, harness) {
  return {
    lead: "Run that copy's own upgrade from a terminal in this project; it shows its own plan and asks:",
    command: `node "${join(copy.path, "bin", "projectstore.mjs")}" upgrade --harness ${harness.id} --no-register`,
  };
}

// Whether a kept copy is behind the running package (the install spec,
// contract 21, rule 9, as amended 2026-10-14): semver precedence, rc
// included. Never for a copy or a run with no semver version recorded — a
// recorded "unknown" or a sha must not rank.
export function copyBehind(copy, version) {
  return isSemver(copy?.version) && isSemver(version) && cmpPrecedence(copy.version, version) < 0;
}

// What the keep says when its copy is behind: the project's surfaces are at
// the running version until the copy updates, and the update in the copy's
// channel. With a step, the copy's own upgrade runs after this run's agents
// block, and a copy shipped before this rule plans the block back.
export function behindAdvice(copy, version, { step = false } = {}) {
  const head = `${copy.key} ${copy.version} is older than this package (${version})`;
  const middle = step
    ? `its own upgrade runs after this run's agents block and may plan the block back to its own version; until it updates, its doctor may call the block stale, and the next run may plan the block again`
    : `until it updates, the agents block and anything else this run writes for the project are at ${version}, and its own doctor may call the block stale`;
  const update = isSyncedCopy(copy)
    ? `${SYNCED_UPDATE_STEPS[0].toUpperCase()}${SYNCED_UPDATE_STEPS.slice(1)}.`
    : `Update it (${COPY_UPDATE_STEPS}).`;
  return `${head}: ${middle}. ${update}`;
}

// This checkout's npm registration enabled beside the kept copy: the keep
// changes no registration, so it stays; its uninstall (rule 4) drops it.
// A kept directory copy does not load while it stays: the installed copy wins.
export function npmRowBeside({ harness, id, surface, copy = null }) {
  const stays = isSyncedCopy(copy)
    ? `stays enabled, and ${harness.display_name} loads it over the kept directory copy until it goes`
    : "stays enabled beside the kept copy";
  return {
    lead: `This checkout's npm registration (${id}) ${stays}. To drop it, from a terminal in this project:`,
    command: coreCommand("uninstall", { args: runArgs({ harnesses: [harness.id], surfaces: [surface] }) }),
  };
}

// A newer registration that is damaged: never rewritten or staged over from
// the older package; repaired from its own version.
export function repairAdvice(harness, v) {
  return {
    lead: "not downgraded — repair it from its own version:",
    command: coreCommand("upgrade", { version: v, args: `--harness ${harness.id}` }),
  };
}

// ─── The update notice (rule 8) ─────────────────────────────────────────

// The notice, when the registry's latest ranks above the running version: its
// text, and the command on a line of its own (presentation spec contract 6).
// A root under npx's cache is told npx; anything else the global install,
// the ADR's form — npm install -g would add a global copy an npx user never had.
export function updateNotice({ latest, version, root, verb = "upgrade" } = {}) {
  if (!isSemver(latest) || !version || cmpPrecedence(latest, version) <= 0) return null;
  const npx = /[\\/]_npx[\\/]/.test(String(root || ""));
  return {
    latest,
    text: `newer published: ${latest} (this is ${version}). To update:`,
    command: npx ? coreCommand(verb, { version: "latest" }) : `npm install -g ${PACKAGE}@latest`,
  };
}

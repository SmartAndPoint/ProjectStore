// projectstore — harness.mjs
//
// The one place that knows which agentic harness this process is running under,
// and the ONLY module under scripts/ allowed to read a harness-branded
// environment variable. Everything else is pure compute over a vault and must
// stay that way: a function that reads `process.env.CLAUDE_PROJECT_DIR`
// directly is a function that silently resolves to `process.cwd()` on every
// other harness — not an error anyone sees, but a vault that quietly binds to
// the wrong directory. So the branded names live in harnesses/<id>.json, this
// file resolves them, and lib.mjs re-exports the results under the names it
// already published.
//
// Deliberately a near-leaf: node builtins only, nothing from this repository,
// so lib.mjs → harness.mjs can never become a cycle and the SessionStart
// module graph pays one manifest read per process (cached below).
//
// Normative: the spec "Generated harness surfaces: manifests, the generator
// and the three invariants" — contract 1 (what a manifest carries), contract
// 2 (exactly one manifest is the source layout and does not emit), and the
// Modules table row for this file. The manifest shape, the cached loader and
// the strong/weak detection ranking are contributed by Maxim Podreshetnikov
// (PR #13, scripts/harness.mjs); the comments recording the two detection
// defects are kept verbatim because they are the reason the ranking exists.
//
// Pure node, no external deps — same constraint as lib.mjs. Read-only.

import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve, sep, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const MANIFEST_DIR = join(REPO_ROOT, "harnesses");

// The write family of the source harness, as a fallback for the one failure
// this module must not turn silent: a missing or malformed
// harnesses/claude-code.json (a partial tarball, a botched install) would
// otherwise make WRITE_TOOLS empty and every write-dependent path — the
// activity log, the in-flight resolver, the entry-rule score — fail without
// a word. tests/portability.test.mjs pins this list to the manifest's.
export const SOURCE_WRITE_TOOLS_FALLBACK = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// ─── Manifests ─────────────────────────────────────────────────────────

let _cache = null;

// Every manifest in harnesses/, id-keyed. Read once per process: the hooks,
// the lint and the build all call this, and re-reading per call would put
// filesystem latency inside the PreToolUse budget.
export function loadHarnesses(dir = MANIFEST_DIR) {
  if (_cache && _cache.dir === dir) return _cache.map;
  const map = new Map();
  let names;
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    names = [];
  }
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (m && typeof m.id === "string") map.set(m.id, m);
    } catch {
      // A malformed manifest must not take down a session. The portability
      // suite parses every file strictly and fails there instead, which is
      // where a human is actually looking.
    }
  }
  _cache = { dir, map };
  return map;
}

export function loadHarness(id, dir = MANIFEST_DIR) {
  return loadHarnesses(dir).get(id) || null;
}

export function harnessIds(dir = MANIFEST_DIR) {
  return [...loadHarnesses(dir).keys()];
}

// The single source-layout harness (contract 2). Null only when the
// manifests directory is missing or unreadable.
export function sourceHarness(dir = MANIFEST_DIR) {
  return [...loadHarnesses(dir).values()].find((m) => m.source_layout) || null;
}

// The harnesses that receive a generated tree. Empty until the first emitting
// manifest lands; the generator story fills this seam.
export function emittingHarnesses(dir = MANIFEST_DIR) {
  return [...loadHarnesses(dir).values()].filter((m) => m.emit);
}

// Test seam: manifests are read once per process, and a test that writes a
// fixture manifest needs the next read to see it.
export function resetManifests() {
  _cache = null;
}

// ─── Detection ─────────────────────────────────────────────────────────

let _detected = null;

// Which harness launched us. Decided by the branded environment variables each
// manifest declares, never by a hardcoded name — so a new harness becomes
// detectable by adding its JSON, with no edit here.
//
// PROJECTSTORE_HARNESS overrides everything: it is how an installer wrapper or
// a test pins the answer. When nothing matches we return the source harness
// rather than null, because every caller wants a manifest and the source
// layout is the one that is always present.
export function detectHarnessId(env = process.env, dir = MANIFEST_DIR) {
  const memo = env === process.env && dir === MANIFEST_DIR;
  if (memo && _detected) return _detected;
  const id = detect(env, dir);
  if (memo) _detected = id;
  return id;
}

function detect(env, dir) {
  const forced = env.PROJECTSTORE_HARNESS;
  if (forced && loadHarnesses(dir).has(forced)) return forced;
  const best = ranked(env, dir);
  // A strong signal is the harness identifying itself, and it decides.
  if (best && best.strong) return best.id;

  // Only weak signals. That is not enough to switch harness: the project
  // itself carries better evidence — whichever harness directory is present
  // in it is the harness this project is used from. (Until 2026-09-06 the
  // evidence was "which harness directory holds our config"; the binding is
  // harness-neutral now and carries no such signal.)
  const cwd = process.cwd();
  for (const m of loadHarnesses(dir).values()) {
    const d = m.runtime?.harness_dir;
    if (d && existsSync(join(cwd, d))) return m.id;
  }
  if (best) return best.id;
  const src = sourceHarness(dir);
  return src ? src.id : null;
}

// The harness that identifies ITSELF from the environment, or null: a strong
// signal (its own plugin-root or project-dir variable, not one another
// harness shares), or its session marker — runtime.session_env, which a Bash
// tool inside a session carries while the variables a hook receives are
// absent (measured 2026-09-05). Never the weak ranking, never the cwd's
// directory, never the source harness detectHarnessId falls back to. A
// finding that must not fire for a harness the project only might use asks
// this (the install spec, contract 6 as amended after the rc.3 tag).
export const IDENTIFIED_ENV = "PROJECTSTORE_IDENTIFIED";
export function identifiedHarnessId(env = process.env, dir = MANIFEST_DIR) {
  const forced = env.PROJECTSTORE_HARNESS;
  if (forced && loadHarnesses(dir).has(forced)) return forced;
  // A parent of ours decided before it named the project in the harness's own
  // vocabulary (childEnv), so its answer stands — an empty one included.
  if (env[IDENTIFIED_ENV] !== undefined)
    return loadHarnesses(dir).has(env[IDENTIFIED_ENV]) ? env[IDENTIFIED_ENV] : null;
  const best = ranked(env, dir);
  if (best && best.strong) return best.id;
  for (const m of loadHarnesses(dir).values()) {
    if ((m.runtime?.session_env || []).some((k) => env[k])) return m.id;
  }
  return null;
}

function ranked(env, dir) {
  // Explicit plugin-root/home variables beat merely-present ones: a shell that
  // exports CODEX_HOME globally should not make a Claude Code session read as
  // Codex when Claude Code also handed us CLAUDE_PLUGIN_ROOT.
  // A variable two harnesses both set identifies neither. Codex hands a plugin
  // hook `CLAUDE_PLUGIN_ROOT` for compatibility alongside its own `PLUGIN_ROOT`
  // (measured 2026-09-07 from a live hook payload), and that is Claude Code's
  // plugin-root variable — so without this, a Codex session scores a strong hit
  // for claude-code, ties with codex, and loses the tie to `readdirSync().sort()`
  // putting claude-code.json first. The manifest that also sets a foreign name
  // declares it in `runtime.shared_env`, and the name is demoted to weak for
  // EVERY manifest: the harness that owns it no longer gets to be identified by
  // it, which is the whole point. Data, not an id branch (generation spec,
  // contract 1).
  const shared = new Set();
  for (const m of loadHarnesses(dir).values()) {
    for (const k of m.runtime?.shared_env || []) shared.add(k);
  }

  let best = null;
  for (const m of loadHarnesses(dir).values()) {
    // detect_env UNION the three runtime variables, not detect_env alone: a
    // manifest that names its plugin-root variable under runtime but forgets to
    // repeat it in detect_env would otherwise fail to identify its own harness,
    // and misdetection is silent — the wrong write-tool vocabulary, an activity
    // log that simply stays empty. Deriving the obvious keys removes the footgun.
    // Ranked, not counted. A plugin-root or project-dir variable is the harness
    // telling us it launched this process; a home variable is just something in
    // the user's shell profile. Counting them equally meant a developer who
    // exports CODEX_HOME globally — the exact person this feature is for — had
    // Claude Code Bash-tool invocations detected as Codex — the wrong write-tool
    // vocabulary for the whole session.
    const claimed = [m.runtime?.plugin_root_env, m.runtime?.project_dir_env].filter(Boolean);
    const strong = claimed.filter((k) => !shared.has(k));
    const weak = [
      ...(m.runtime?.detect_env || []).filter((k) => !strong.includes(k)),
      ...claimed.filter((k) => shared.has(k)),
      m.runtime?.home_env,
    ].filter(Boolean);
    const strongHits = strong.filter((k) => env[k]).length;
    const weakHits = [...new Set(weak)].filter((k) => env[k]).length;
    if (strongHits === 0 && weakHits === 0) continue;
    // Any strong signal outranks every weak one; ties fall back to hit counts.
    // A numeric score, not an array: `>` on arrays compares their string forms,
    // which happens to work for single digits and stops working silently at ten.
    const rank = (strongHits > 0 ? 1e6 : 0) + strongHits * 1e3 + weakHits;
    if (!best || rank > best.rank) best = { id: m.id, rank, strong: strongHits > 0 };
  }
  return best;
}

// Test seam: the detected id is memoised for the process; a test that changes
// process.env to impersonate a harness needs the next call to look again.
export function resetDetection() {
  _detected = null;
  _speaking = null;
  _bundling = undefined;
}

// Which harnesses this PROJECT uses — by directory (install spec, contract
// 8). Not detectHarnessId: that answers "which harness launched this
// process" from branded environment variables, and using it here would
// conjure .claude/ for a Codex user. Not memoised: it is per directory, and a
// test builds a project per case.
//
// `state` adds the second signal `upgrade` reads: a harness whose state
// directory of ours exists (layoutPaths(p).harnessState(id), layout spec
// contract 5). A Codex session wrote its welcome marker there, so Codex is
// used here even with no .codex/ (measured in this repository, 2026-10-08).
// Never a machine-global registration: one exists for every project on the
// machine and would select its harness everywhere. One entry per manifest,
// the directory first, in manifest order as before.
export function detectHarnesses(projectDir, { dir = MANIFEST_DIR, state = false } = {}) {
  const out = [];
  const p = state ? layoutPaths(projectDir, { dir }) : null;
  for (const m of loadHarnesses(dir).values()) {
    const d = m.runtime?.harness_dir;
    if (d && existsSync(join(projectDir, d))) {
      out.push({ id: m.id, why: "directory", evidence: d });
      continue;
    }
    if (!p) continue;
    const at = p.harnessState(m.id);
    let isDir = false;
    try {
      isDir = statSync(at).isDirectory();
    } catch {}
    if (isDir) out.push({ id: m.id, why: "state", evidence: relative(projectDir, at) });
  }
  return out;
}

// A pure PATH walk for a host binary — a read, not a subprocess: the analysers
// run on every doctor call. Returns the absolute path or null. It lives here,
// beside hostPresence, which needs it; lib.mjs re-exports it under the name
// it already published.
export function whichOnPath(name, env = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of String(env.PATH || "")
    .split(sep)
    .filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        const st = statSync(p);
        if (st.isFile() && (process.platform === "win32" || st.mode & 0o111)) return p;
      } catch {}
    }
  }
  return null;
}

// Whether a harness's host is on this MACHINE (the story "projectstore setup
// asks, shows one plan and installs every harness it finds, with the vault",
// rule 5): its registration surface's CLI found on PATH, and its home
// directory present — the manifest's home variable when set, else
// <home>/<home_default>. Not detectHarnesses, which answers for a PROJECT, and
// not detectHarnessId, which names the harness running this process. Setup's
// pre-tick is the one place machine presence counts; install keeps contract 8.
// Every name comes from the manifest. Read-only: a stat per PATH entry and one
// for the home.
//   → { cli, home, bin, homeDir }: `cli` is the absolute path found, or null;
//     `home` the directory when it exists, or null. `bin` and `homeDir` are
//     what was looked for (null when the manifest names none), so a reason can
//     name them when either is missing.
export function hostPresence(manifest, { env = process.env, home = homedir() } = {}) {
  const s =
    Object.entries(manifest?.surfaces || {}).find(
      ([k, x]) =>
        !k.startsWith("_") &&
        x?.kind === "registration" &&
        x.supported !== false &&
        typeof x.cli?.bin === "string" &&
        x.cli.bin,
    )?.[1] || null;
  const bin = s ? s.cli.bin : null;
  const homeDir = harnessHome(manifest, { env, home });
  let present = false;
  if (homeDir) {
    try {
      present = statSync(homeDir).isDirectory();
    } catch {}
  }
  return { cli: bin ? whichOnPath(bin, env || {}) : null, home: present ? homeDir : null, bin, homeDir };
}

// A harness's own home directory, as the harness resolves it: its home
// variable (runtime.home_env) when set, else home_default under the home
// directory, else null. Whether it exists is the caller's question.
export function harnessHome(manifest, { env = process.env, home = homedir() } = {}) {
  const r = manifest?.runtime || {};
  const fromEnv = r.home_env && env ? env[r.home_env] : null;
  return fromEnv || (home && r.home_default ? join(home, r.home_default) : null);
}

// The agents block of a RUN (the story "One run plans the agents block once,
// and a bare uninstall selects every harness the project uses", rules 1–2):
// the files every manifest of the run names for it, in the FIRST manifest's
// order. The block is written to the first of them, so it lands where every
// harness of the run can read it, natively or through the import the run
// creates. One manifest gives its own list unchanged, which is what keeps a
// single-harness plan as it was.
export function commonBlockFiles(manifests) {
  const lists = manifests.map((m) => agentsBlockRow(m)?.[1].files || []);
  if (!lists.length) return [];
  return lists[0].filter((f) => lists.every((l) => l.includes(f)));
}

// A manifest's agents-block row as [key, surface], or null: found by its
// format, as the installer's handlers are keyed, never by the key's name.
export function agentsBlockRow(manifest) {
  return (
    Object.entries(manifest?.surfaces || {}).find(([k, s]) => !k.startsWith("_") && s?.format === "markdown-block") ||
    null
  );
}

// Rule 2, for the schema test: the manifests' lists share a file, or a run of
// all of them has nowhere to write the block. Null when they do; otherwise
// the problem, naming each manifest's list.
export function blockTargetProblem(manifests) {
  const withBlock = manifests.filter((m) => agentsBlockRow(m));
  if (commonBlockFiles(withBlock).length) return null;
  return `the agents-block files lists share no file, so a run of every harness has no file to write the block to: ${withBlock.map((m) => `${m.id} ${JSON.stringify(agentsBlockRow(m)[1].files || [])}`).join(", ")}`;
}

// The refusal when nothing is detected and nothing is named — built from the
// manifests, so a new harness appears in it without an edit here. With
// `state` (upgrade's set) it names both signals the selection read.
export function harnessRefusal(projectDir, { dir = MANIFEST_DIR, state = false } = {}) {
  const p = state ? layoutPaths(projectDir, { dir }) : null;
  const rows = [...loadHarnesses(dir).values()].map((m) => {
    const by = `detected by its project directory: ${m.runtime?.harness_dir || "?"}`;
    return {
      id: m.id,
      display: m.display_name,
      why: p ? `${by}, or by its state directory: ${relative(projectDir, p.harnessState(m.id))}` : by,
    };
  });
  return [`No harness detected in ${projectDir}, and none named. Name one:`, ...harnessNameLines(rows)].join("\n");
}

// That refusal's rows, one per harness — `--harness <id>`, then its display
// name and why — shared with setup's (its rule 12), so the two cannot drift.
// The ids are padded to one width, so every reason starts in one column.
export function harnessNameLines(rows) {
  const width = Math.max(0, ...rows.map((r) => r.id.length));
  return rows.map((r) => `  --harness ${r.id.padEnd(width)}    (${r.display}; ${r.why})`);
}

// Inside a live session of the host, its CLI and the session both rewrite the
// same settings files on their own schedules; the registration is planned
// only from a terminal outside one. The host marks its sessions in the
// environment (manifest runtime.session_env). It lives here, beside
// detection, so the installer and the shell fetch read one predicate without
// an import cycle.
export function insideHostSession(env, harness) {
  // runtime.session_env, not detect_env: a Bash tool inside a session carries
  // the session marker, not the plugin-root variables a hook receives
  // (measured 2026-09-05; the critic's third pass caught the first draft
  // keying on detect_env, which never fired in a session).
  return (harness?.runtime?.session_env || []).some((k) => env && env[k]);
}

// Whether a harness's registration — and the shell fetch that would feed it —
// defers in this environment (the setup story, rule 15: the front-door ADR's
// first open question, answered by the maintainer on 2026-10-08). It defers
// inside the harness's own session (insideHostSession, runtime.session_env),
// or while one of its runtime.registration_defer_env variables is set. That
// second list defers the registration and the fetch and nothing else:
// isInteractive, the layout move and session identity read session_env alone.
// Codex's exec tool sets CODEX_THREAD_ID in every command (measured
// 2026-10-05), while its session_env stays empty so the doctor skill's
// `upgrade --json` still moves the layout there. Keyed on the PLANNED
// harness's manifest: inside one host's session another host's registration
// does not defer.
export function registrationDeferred(env, harness) {
  if (insideHostSession(env, harness)) return true;
  return (harness?.runtime?.registration_defer_env || []).some((k) => env && env[k]);
}

export function activeHarness(env = process.env, dir = MANIFEST_DIR) {
  return loadHarness(detectHarnessId(env, dir), dir) || sourceHarness(dir);
}

// ─── The Stop carrier (generation spec, contract 17; entry spec, contract 14,
// as amended 2026-10-15) ────────────────────────────────────────────────
//
// The shape the entry reminder's Stop carrier prints, from the manifest of the
// harness that IDENTIFIES itself — a forced harness, a parent's decision, a
// strong signal or a session marker. Never detection's cwd folder, weak ranking or source
// fallback: a wrong answer here is a hook the host refuses (Codex's Stop schema
// denies hookSpecificOutput, measured 2026-10-15), and a refused print would
// still spend the session's reminder. Nothing identified, or no carrier
// measured, is null: the hook stays silent.
export const STOP_CARRIERS = Object.freeze(["additionalContext", "block"]);
export function stopCarrier(env = process.env, dir = MANIFEST_DIR) {
  const id = identifiedHarnessId(env, dir);
  const carrier = id ? loadHarness(id, dir)?.output_channels?.Stop?.carrier : null;
  return STOP_CARRIERS.includes(carrier) ? carrier : null;
}

// What is wrong with a manifest's Stop row, or null. The carrier is our choice
// and must be one its row supports: context needs `additionalContext` among the
// honoured fields, a block needs the block decision, and a carrier is only
// ever chosen from a measured row. Shared by the manifest check and its
// planted fixtures.
export function stopCarrierProblem(manifest) {
  const row = manifest?.output_channels?.Stop;
  if (row === null || row === undefined) return null;
  if (typeof row !== "object") return "output_channels.Stop is not an object";
  if (!("carrier" in row)) return "output_channels.Stop has no carrier (null when none is measured)";
  if (![...STOP_CARRIERS, null].includes(row.carrier))
    return `output_channels.Stop.carrier ${JSON.stringify(row.carrier)} is not one of ${STOP_CARRIERS.join(", ")} or null`;
  if (![null, "block"].includes(row.decision))
    return `output_channels.Stop.decision ${JSON.stringify(row.decision)} is not null or "block"`;
  if (row.carrier === null) return null;
  if (row.evidence !== "measured") return "output_channels.Stop.carrier is set on a row that is not measured";
  if (row.carrier === "additionalContext" && !(row.fields || []).includes("additionalContext"))
    return "output_channels.Stop.carrier is additionalContext, but its fields do not honour it";
  if (row.carrier === "block" && row.decision !== "block")
    return 'output_channels.Stop.carrier is block, but its decision is not "block"';
  return null;
}

// ─── Who a message is for (generation spec, contract 18) ───────────────
//
// The core prints for ONE harness at a time, and a command it names must be
// one that harness can run: `/projectstore:doctor` in Claude Code,
// `$projectstore-doctor` in Codex, where commands arrive as rendered skills.
// The form is manifest data; these functions only fill it in.

// How a harness calls one of our commands (kind "commands") or roles (kind
// "agents"): the surface's own `invocation` template, or — for a surface the
// generator renders as skills — its `rendered_name` filled into the skills'
// template. `*` names the family ("/projectstore:*"). Filled by split/join, so
// a `$` in a template is never read as a replacement pattern.
export function invocation(manifest, name, { kind = "commands", args = "" } = {}) {
  // No manifest (a partial tarball): the bare name, never a throw in a hook.
  const surfaces = manifest?.surfaces || {};
  const s = surfaces[kind] || {};
  let template = s.invocation || null;
  if (!template && s.rendered_as === "skill" && s.rendered_name && surfaces.skills?.invocation) {
    template = surfaces.skills.invocation.split("<name>").join(s.rendered_name);
  }
  const form = template ? template.split("<name>").join(name) : name;
  return args ? `${form} ${args}` : form;
}

// The UI words a manifest declares (ui_vocabulary), as patterns. A word glued
// to a longer name or to a path is not the word: `/plugin-x` is not `/plugin`,
// and neither is the one in `.claude-plugin/plugin.json`; a full stop after it
// still ends a sentence. The generator's leak check and the vocabulary lint
// read these same patterns.
export function uiWordPatterns(manifest) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (manifest?.ui_vocabulary || []).map((word) => ({
    word,
    re: new RegExp(`(?<![\\w.-])${esc(word)}(?![\\w-]|\\.\\w)`, "g"),
  }));
}

// The harness whose distribution shell bundles this core, by the shell's
// package name: a shell installs the core at <shell>/node_modules/projectstore,
// and its package.json names it as a manifest's install.shell. A hook, a
// rendered skill's command and an npx run inside that tree all belong to that
// harness by construction — nothing to export, nothing a model can forget.
// A source checkout or a host's own cache of the core answers null.
let _bundling;
export function bundlingShellHarnessId({ core = REPO_ROOT, dir = MANIFEST_DIR } = {}) {
  const memo = core === REPO_ROOT && dir === MANIFEST_DIR;
  if (memo && _bundling !== undefined) return _bundling;
  let id = null;
  try {
    const real = realOr(core);
    const parent = dirname(real);
    if (parent.split(sep).pop() === "node_modules") {
      const name = JSON.parse(readFileSync(join(dirname(parent), "package.json"), "utf8")).name;
      id = [...loadHarnesses(dir).values()].find((m) => m.install?.shell && m.install.shell === name)?.id ?? null;
    }
  } catch {
    id = null;
  }
  if (memo) _bundling = id;
  return id;
}

// The harness a message is FOR: forced (PROJECTSTORE_HARNESS); else the one
// that identifies itself — a strong signal or its session marker; else the
// shell that bundles this core; else the shell the environment names
// (PROJECTSTORE_SHELL, which only the shells set); else the source harness.
// `--harness <id>` names an install target and plays no part in this.
let _speaking = null;
export function speakingHarnessId(env = process.env, dir = MANIFEST_DIR) {
  const memo = env === process.env && dir === MANIFEST_DIR;
  if (memo && _speaking) return _speaking;
  const id = speaker(env, dir);
  if (memo) _speaking = id;
  return id;
}

function speaker(env, dir) {
  const identified = identifiedHarnessId(env, dir);
  if (identified) return identified;
  const bundled = bundlingShellHarnessId({ dir });
  if (bundled) return bundled;
  const named = shellHarnessId(env, dir);
  if (named) return named;
  return sourceHarness(dir)?.id ?? null;
}

export function speakingHarness(env = process.env, dir = MANIFEST_DIR) {
  return loadHarness(speakingHarnessId(env, dir), dir) || sourceHarness(dir);
}

// ─── Runtime names and paths ───────────────────────────────────────────

// The three branded names a harness uses — the active one unless the caller
// names it — so a caller can say which variable it is talking about without
// spelling it. A surface rendered FOR a harness (the status-line launcher is
// Claude Code's) names that harness, whichever process renders it.
export function runtimeEnvNames(env = process.env, harness = activeHarness(env)) {
  const r = harness?.runtime || {};
  return { projectDir: r.project_dir_env || null, pluginRoot: r.plugin_root_env || null, home: r.home_env || null };
}

// A hook's own stdin payload carries `cwd`; on a harness that exports no
// project-dir variable it is the only trustworthy answer, and it is only
// available after stdin has been read. Hooks may call adoptHookInput() before
// readConfig() so config lookup resolves against the right root.
let _hookProjectRoot = null;

export function adoptHookInput(input) {
  if (input && typeof input.cwd === "string" && input.cwd) _hookProjectRoot = input.cwd;
  return input;
}

export function resetHookInput() {
  _hookProjectRoot = null;
}

// The project the user is working in. Read fresh from env on every call —
// only the harness id is memoised — so a test that sets the variable
// mid-process sees it.
export function projectRoot(env = process.env, hookInput = null) {
  const key = activeHarness(env)?.runtime?.project_dir_env;
  // An explicitly exported project directory wins: it is the harness stating
  // the answer, where cwd is us inferring it.
  if (key && env[key]) return env[key];
  // Every manifest's variable, not just the active one: a wrapper may set the
  // source harness's name while running under another, and honouring it is
  // strictly better than falling through to cwd.
  for (const h of loadHarnesses().values()) {
    const k = h.runtime?.project_dir_env;
    if (k && env[k]) return env[k];
  }
  if (hookInput && typeof hookInput.cwd === "string" && hookInput.cwd) return hookInput.cwd;
  if (_hookProjectRoot) return _hookProjectRoot;
  return process.cwd();
}

// The project a harness DECLARED through a project-dir variable, or null —
// never cwd by inference. For a caller that has its own notion of cwd (the
// CLI, an in-process server) and must not inherit this process's.
export function projectRootDeclared(env = process.env) {
  const key = activeHarness(env)?.runtime?.project_dir_env;
  if (key && env[key]) return env[key];
  for (const h of loadHarnesses().values()) {
    const k = h.runtime?.project_dir_env;
    if (k && env[k]) return env[k];
  }
  return null;
}

// Where this projectstore's core lives on disk: its layouts, templates and
// scripts. The bin runs ITS OWN copy of the core: a child gets that through childEnv's
// pluginRoot, an in-process read (the query verbs' loadLayout, the headings
// registry) through this pin. Set once by cli.mjs; nothing else may call it.
let _pinnedPluginRoot = null;
export function pinPluginRoot(root) {
  _pinnedPluginRoot = root || null;
}

export function pluginRoot(env = process.env) {
  if (_pinnedPluginRoot) return _pinnedPluginRoot;
  const named = hostPluginRoot(env);
  // fileURLToPath, not URL.pathname: the latter stays percent-encoded, so an
  // install path containing a space resolves to a directory that does not exist.
  if (!named) return REPO_ROOT;
  return containsThisCore(named) ? REPO_ROOT : named;
}

function hostPluginRoot(env) {
  const key = activeHarness(env)?.runtime?.plugin_root_env;
  if (key && env[key]) return env[key];
  for (const h of loadHarnesses().values()) {
    const k = h.runtime?.plugin_root_env;
    if (k && env[k]) return env[k];
  }
  return null;
}

// The host's variable names its PLUGIN root, and the core is that root only in
// the source layout. In a shell the core sits beneath it (node_modules/
// projectstore/), so the variable names a directory with none of our layouts,
// templates or scripts in it — measured on the first Codex install's cached
// hooks, 2026-10-03: every session said "vault load failed — Layout not
// found", the first one beneath its welcome. A root that CONTAINS the core this
// code runs from is that case, whatever the shell's layout, and the core
// answers from its own location. Any other ancestor counts too ($HOME, a main
// checkout above a worktree); none of them holds our assets, so the answer is
// the same. A root equal to the core, or unrelated to it (a test's fixture, the
// bin's child), is honoured as named. Real paths on both sides: the module's
// own is already real, so a root under a symlink (macOS's /var and /tmp)
// would never compare.
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
let _realCore = null;
function containsThisCore(root) {
  const core = (_realCore ??= realOr(REPO_ROOT));
  const r = realOr(root);
  return core !== r && core.startsWith(r.endsWith(sep) ? r : r + sep);
}

// The harness's own config directory (~/.claude, ~/.codex, …). Almost always
// the default under $HOME, but the harness's home variable relocates it — and
// a consumer that hardcodes the default silently resolves nothing for those
// users instead of failing loudly.
export function agentHome(env = process.env, home = homedir()) {
  const r = activeHarness(env)?.runtime || {};
  if (r.home_env && env[r.home_env]) return env[r.home_env];
  return join(home, r.home_default || ".claude");
}

// ─── The project-level layout (the layout ADR, 2026-09-06) ─────────────
//
// Everything of ours in a project lives under ONE harness-neutral directory,
// <project>/.projectstore/: the binding (machine-local, never committed), the
// harness overlays (harness/<id>.json, committed) and the machine-local state
// (state/, keyed by harness inside). This is the only place a project-side
// path is spelled — every reader and writer goes through layoutPaths(), and a
// test greps the rest of scripts/, hooks/ and bin/ for the literals. The
// legacy shape (.claude/projectstore.json, .claude/.projectstore/…) is named
// here too, for the readers' fallback through 0.30 (layout spec, contracts
// 0, 1 and 7); its harness directory is the source harness's own.
export const LAYOUT = Object.freeze({
  root: ".projectstore",
  binding: "projectstore.json",
  overlayDir: "harness",
  state: "state",
  sessions: "sessions",
  entryLog: "entry-log.jsonl",
  worktrees: "worktrees", // reserved for the worktree ADR's records (planned); no reader yet
  launcher: "statusline.mjs",
  welcomed: "welcomed",
  // The lines .projectstore/.gitignore must carry; merged by line, never rewritten.
  gitignore: Object.freeze(["projectstore.json", "state/"]),
  // The vault's own, unrelated files under the same name (ADR-007 decision 4; sessions).
  vaultConfig: ".projectstore.json",
  vaultSessions: "sessions",
});
// The header both the legacy and the new state .gitignore carry — how
// uninstall recognises a state directory as ours (layout spec, contract 6).
export const RUNTIME_GITIGNORE_HEADER = "projectstore — per-session runtime state";

export function layoutPaths(projectDir, { harnessDir = null, dir = MANIFEST_DIR } = {}) {
  const legacyDir = harnessDir || sourceHarness(dir)?.runtime?.harness_dir || ".claude";
  const root = join(projectDir, LAYOUT.root);
  const state = join(root, LAYOUT.state);
  const legacyRuntime = join(projectDir, legacyDir, LAYOUT.root);
  return {
    root,
    binding: join(root, LAYOUT.binding),
    overlayDir: join(root, LAYOUT.overlayDir),
    overlay: (id) => join(root, LAYOUT.overlayDir, `${id}.json`),
    gitignore: join(root, ".gitignore"),
    state,
    stateGitignore: join(state, ".gitignore"),
    sessions: join(state, LAYOUT.sessions),
    harnessState: (id) => join(state, id),
    launcher: (id) => join(state, id, LAYOUT.launcher),
    welcomed: (id) => join(state, id, LAYOUT.welcomed),
    entryLog: join(state, LAYOUT.entryLog),
    worktrees: join(state, LAYOUT.worktrees),
    legacy: {
      dir: legacyDir,
      binding: join(projectDir, legacyDir, LAYOUT.binding),
      runtime: legacyRuntime,
      gitignore: join(legacyRuntime, ".gitignore"),
      state: join(legacyRuntime, "state"),
      launcher: join(legacyRuntime, LAYOUT.launcher),
      entryLog: join(legacyRuntime, LAYOUT.entryLog),
      welcomed: join(projectDir, legacyDir, ".projectstore-welcomed"),
      sessionId: join(projectDir, legacyDir, ".projectstore-session-id"),
    },
  };
}

// ─── The user-level cache (layout spec contract 0, the user-level class) ─
//
// What is ours on the machine but belongs to no project and no harness home:
// the shell fetch's scratch (<root>/fetch/<pid>-<ms>/, removed when its run
// ends), the registry answer the update notice caches for a day
// (<root>/registry.json, named now and read by no one yet), the model lists
// (<root>/models/<id>.json) and the welcome an unbound project has shown
// (<root>/welcomed/<id>). The XDG Base
// Directory spec puts a cache at $XDG_CACHE_HOME when that is an absolute
// path and ignores a relative one; an empty one is ignored too. Otherwise it
// is <home>/.cache. With neither, `root` is null and the fetch refuses. This
// is the one place either name is spelled (contract 0's grep): `from` and
// `variable` carry them into a refusal's text. env and home are always
// parameters.
export function cachePaths({ env = process.env, home = homedir() } = {}) {
  const variable = "XDG_CACHE_HOME";
  const xdg = env ? env[variable] : null;
  const fromEnv = typeof xdg === "string" && xdg !== "" && isAbsolute(xdg);
  const base = fromEnv ? xdg : home ? join(home, ".cache") : null;
  const root = base ? join(base, "projectstore") : null;
  return {
    root,
    fetch: root ? join(root, "fetch") : null,
    fetchRun: (id) => (root ? join(root, "fetch", id) : null),
    registry: root ? join(root, "registry.json") : null,
    // A harness's model list, as its last live read answered (the ADR "Agent
    // model lists are read from each harness's own catalog…", decision 4).
    models: (id) => (root && id ? join(root, "models", `${id}.json`) : null),
    // A harness's first-run welcome, seen on this machine: the SessionStart
    // hook writes it in place of the project's marker when the project is not
    // bound, so an unbound project gets no writes (layout spec contract 5, as
    // amended by the story "Opening a project that is not bound writes nothing
    // into it…"). A lost marker costs one more welcome.
    welcomed: (id) => (root && id ? join(root, "welcomed", id) : null),
    from: fromEnv ? variable : "the home directory",
    variable,
  };
}

// The core through npx: how every command a person is told to type next
// begins (the story "User-facing text says where to run and names no project
// path and no shell", rules 2 and 6). `npx` runs it with no bin on PATH.
export const CORE_NPX = "npx projectstore";

// The command a person types from a terminal (the front-door ADR, decision 5;
// the story above, rule 2): always the core, with one --harness per manifest
// in the order given — `npx projectstore[@<v>] <verb> --harness a [--harness
// b] [args]`. It names no shell, whatever the manifest's install.shell says,
// and its callers pass no --project: where to run it is their prose, `from a
// terminal in "<dir>"` (lib.mjs fromTerminalIn). The id stays because a bare
// upgrade or uninstall plans every harness the project uses. An empty array
// names none, for a verb that takes no --harness (bind, status, scaffold,
// reconcile). Finding messages, deferred reasons and DONE's tip are built
// here, so the installer spells no command of its own. The string is built
// here, not by the converge story's coreCommand, whose module imports this one.
export function packageCommand(harnesses, verb, { version = null, args = "" } = {}) {
  const list = Array.isArray(harnesses) ? harnesses : [harnesses];
  const ids = list.map((h) => ` --harness ${h?.id || "<id>"}`).join("");
  return `${CORE_NPX}${version ? `@${version}` : ""} ${verb}${ids}${args ? ` ${args}` : ""}`;
}

// The package this run was invoked as: the shell it came through (the shell's
// bin sets PROJECTSTORE_SHELL, and fixes the harness), else the core. Only
// what describes the binary that ran uses it — the help's first line, its
// Usage lines, the fixed-harness line and the usage errors (the story above,
// rule 6). A command printed for a person to type next is the core's
// (packageCommand, CORE_NPX), through a shell too.
export function invokedAs(env = process.env) {
  const shell = env.PROJECTSTORE_SHELL || null;
  return { shell, cmd: shell ? `npx ${shell}` : CORE_NPX };
}

// The harness a shell fixes: the manifest whose install.shell is the name the
// shell's bin exports (PROJECTSTORE_SHELL), or null. Never speakingHarnessId,
// which a session's identity overrides: the Codex shell run inside a Claude
// Code session still installs Codex, so its help's examples name codex.
export function shellHarnessId(env = process.env, dir = MANIFEST_DIR) {
  const shell = env.PROJECTSTORE_SHELL;
  if (!shell) return null;
  return [...loadHarnesses(dir).values()].find((m) => m.install?.shell === shell)?.id ?? null;
}

// The overlay a harness reads: <project>/.projectstore/harness/<overlay>.json —
// the manifest's runtime.overlay, the harness id by convention (the layout ADR,
// decision 3). Whose (layout spec, contract 2, as amended 2026-10-15): the
// harness that identifies itself; else the shell that bundles this core; else
// the shell the environment names; else detectHarnessId's answer (the cwd's
// harness folder, the weak ranking, the source harness). Contract 18's middle
// rungs with detection's tail: a rendered skill's exec tool carries no variable
// of its harness, and the cwd's folder would answer for it. --harness stays the
// caller's (cli.mjs runAgents). Null only when no manifest at all can be found.
export function overlayId(env = process.env, dir = MANIFEST_DIR, { core } = {}) {
  const id =
    identifiedHarnessId(env, dir) ||
    bundlingShellHarnessId({ core, dir }) ||
    shellHarnessId(env, dir) ||
    detectHarnessId(env, dir);
  const h = loadHarness(id, dir) || sourceHarness(dir);
  return h?.runtime?.overlay || h?.id || null;
}

// The manifest an OVERLAY key belongs to. `agents` addresses overlays, not
// manifests: --harness names an id, but a detected harness contributes its
// runtime.overlay, and the two are free to differ. Looking such a key up with
// loadHarness() alone returns null the day a manifest sets overlay !== id, and
// a null there is not an error anyone sees — it is the clerk quietly not being
// pinned. Overlay first, then id, so a key that is one manifest's overlay and
// another's id resolves to the overlay's owner rather than to filename order.
export function harnessForOverlay(key, dir = MANIFEST_DIR) {
  if (!key) return null;
  const all = [...loadHarnesses(dir).values()];
  return all.find((m) => m.runtime?.overlay === key) || all.find((m) => m.id === key) || null;
}

// Whether a harness draws the band above the prompt (the band spec, contract
// 1): the one predicate for "a harness without a band", read by the generator
// (which keeps the module out of such a harness's tree) and by `band status`.
export function hasBand(manifest) {
  return manifest?.surfaces?.band?.supported === true;
}

// Whether a harness has the status-line surface: the one predicate for "a
// harness without a status line", read by configure (its spec, contract 2).
// Install's own test is the same: a surface declared and not unsupported.
export function hasStatusLine(manifest) {
  const s = manifest?.surfaces?.statusline;
  return Boolean(s) && s.supported !== false;
}

// The session id the host hands a tool process, by the manifest's name for
// it (runtime.session_id_env), or null where the harness names none or the
// process got none.
export function hostSessionId(env = process.env, harness = activeHarness(env)) {
  const k = harness?.runtime?.session_id_env;
  const v = k && env ? env[k] : null;
  return typeof v === "string" && v ? v : null;
}

// A reader's fallback: the new path when it exists, else the legacy one when
// THAT exists, else the new path (a writer's target) — at most two existsSync
// calls, never a directory scan (contract 1; the SessionStart budget).
export function pickExisting(current, legacy) {
  if (existsSync(current)) return current;
  return existsSync(legacy) ? legacy : current;
}

// The per-project directory the HARNESS discovers (".claude" for the source
// layout) — how a harness is detected in a project and where its own settings
// live. Not where our config is: that is layoutPaths() (2026-09-06). A
// caller reading ONE harness's settings names it: which harness launched the
// process is not whose directory that is (the install spec, contract 6, as
// amended 2026-10-14).
export function projectConfigDir(env = process.env, harness = activeHarness(env)) {
  return harness?.runtime?.harness_dir || ".claude";
}

// The host's own machine-local settings file in a project (the statusline
// surface's file in the manifest — `.claude/settings.local.json` for Claude
// Code). A harness surface, not ours: the one `.claude` path the core may
// build, and it builds it from the manifest (2026-09-06).
export function hostSettingsPath(projectDir, env = process.env, harness = activeHarness(env)) {
  const h = harness;
  const file = h?.surfaces?.statusline?.file || join(h?.runtime?.harness_dir || ".claude", "settings.local.json");
  return join(projectDir, file);
}

// Our binding for a project: the new layout, falling back to the legacy file
// while the window is open. A rebind edits the binding where it stands.
export function configPath(projectDir, env = process.env) {
  const p = layoutPaths(projectDir, { harnessDir: activeHarness(env)?.runtime?.harness_dir || null });
  return pickExisting(p.binding, p.legacy.binding);
}

// The ONE place a branded name is WRITTEN: a child process spawned by a core
// script needs the project handed to it in the harness's own vocabulary, and
// on a harness with no project-dir variable it needs nothing at all.
export function childEnv(base = process.env, { projectRoot: root, pluginRoot: plugin } = {}) {
  const out = { ...base };
  const r = activeHarness(base)?.runtime || {};
  // Who called is decided here, before the project is named below: a
  // project-dir variable we write would otherwise read, in the child, as the
  // harness identifying itself — a terminal `doctor` took Claude Code for the
  // session's own harness (the review of the post-rc.3 fixes, 2026-10-04).
  if (base[IDENTIFIED_ENV] === undefined) out[IDENTIFIED_ENV] = identifiedHarnessId(base) || "";
  if (r.project_dir_env && root) out[r.project_dir_env] = root;
  // A caller that runs its own copy of the core (the npm bin) names it, so a
  // child never resolves templates or its version from a sibling install.
  if (r.plugin_root_env && plugin) out[r.plugin_root_env] = plugin;
  return out;
}

// Harness-level overrides of agent configuration that are set in this
// environment — the manifest names them and says what each one beats; the
// caller (doctor) phrases the finding. Only the ones actually present.
export function agentOverrides(env = process.env) {
  const list = activeHarness(env)?.runtime?.agent_overrides || [];
  return list
    .filter((o) => o && typeof o.env === "string" && env[o.env])
    .map((o) => ({ env: o.env, kind: o.kind || null, beats: o.beats || null, value: env[o.env] }));
}

// ─── Tool vocabulary ───────────────────────────────────────────────────

// The source harness's write family — the manifest value, never empty.
export function sourceWriteTools(dir = MANIFEST_DIR) {
  const tools = sourceHarness(dir)?.tools?.write_tools;
  return Array.isArray(tools) && tools.length ? tools : SOURCE_WRITE_TOOLS_FALLBACK;
}

// The ACTIVE harness's write family. With one manifest this is the source's;
// widening it to a union across harnesses is a decision the generator story
// makes explicitly, with its own test — not a side effect of adding a file.
export function writeTools(env = process.env) {
  const tools = activeHarness(env)?.tools?.write_tools;
  return Array.isArray(tools) && tools.length ? tools : sourceWriteTools();
}

export function knownNonWriteTools(env = process.env) {
  return activeHarness(env)?.tools?.known_non_write_tools || [];
}

export function isWriteTool(tool, env = process.env) {
  return writeTools(env).includes(tool);
}

// Paths carried by a harness tool payload. Ordinary tools expose one of the
// manifest's path_fields directly. Codex's apply_patch carries a complete patch
// envelope in a string field instead, so every Add/Update/Delete path is
// extracted without teaching the hook a harness name or a patch field name.
export function toolPaths(input, env = process.env) {
  const ti = input?.tool_input;
  if (!ti || typeof ti !== "object") return [];
  const tools = activeHarness(env)?.tools || {};
  const out = [];
  for (const field of tools.path_fields || []) {
    const value = ti[field];
    if (typeof value === "string" && value) out.push(value);
  }
  const envelope = tools.patch_envelope_field && ti[tools.patch_envelope_field];
  if (typeof envelope === "string") {
    for (const line of envelope.split(/\r?\n/)) {
      const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/);
      if (m) out.push(m[1]);
      const moved = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
      if (moved) out.push(moved[1]);
    }
  }
  return [...new Set(out)];
}

// ─── Lint patterns (contract 6) ────────────────────────────────────────

// The forbidden-unmapped list for one EMITTING harness: its own declared
// patterns plus patterns derived from every other manifest (their write-tool
// names, their branded environment variables). Empty while the source
// harness is the only one — the generator story gives it teeth.
export function lintPatterns(harness, dir = MANIFEST_DIR) {
  if (!harness || harness.source_layout) return [];
  const out = [];
  for (const p of harness.lint?.forbidden_unmapped || []) {
    // No default for `class`: the schema test requires every declared pattern
    // to say whether it matches by name (case-insensitive) or token.
    if (p && typeof p.pattern === "string") out.push({ pattern: p.pattern, class: p.class, derived: false });
  }
  // A name the linted harness declares ITSELF is never foreign, however many
  // other manifests also name it. Codex declares CLAUDE_PLUGIN_ROOT under
  // shared_env because it really does set it; without this exclusion, adding
  // shared_env to the derivation below would forbid Claude Code's own variable
  // inside Claude Code's own tree.
  const o = harness.runtime || {};
  const own = new Set(
    [o.project_dir_env, o.plugin_root_env, o.home_env, ...(o.detect_env || []), ...(o.shared_env || [])].filter(
      Boolean,
    ),
  );
  for (const m of loadHarnesses(dir).values()) {
    if (m.id === harness.id) continue;
    for (const t of m.tools?.write_tools || []) out.push({ pattern: `\\b${t}\\b`, class: "token", derived: true });
    const r = m.runtime || {};
    // shared_env included: a name is no less branded for being set by two
    // harnesses, and it exists in no other field of the manifest that declares
    // it — CLAUDE_PLUGIN_DATA appears nowhere but codex.json's shared_env.
    for (const k of [
      r.project_dir_env,
      r.plugin_root_env,
      r.home_env,
      ...(r.detect_env || []),
      ...(r.shared_env || []),
    ]) {
      if (k && !own.has(k)) out.push({ pattern: `\\b${k}\\b`, class: "token", derived: true });
    }
  }
  return out;
}

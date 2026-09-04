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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
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

  // Explicit plugin-root/home variables beat merely-present ones: a shell that
  // exports CODEX_HOME globally should not make a Claude Code session read as
  // Codex when Claude Code also handed us CLAUDE_PLUGIN_ROOT.
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
    // Claude Code Bash-tool invocations detected as Codex, writing runtime state
    // to .codex/.projectstore while the hooks used .claude/.projectstore.
    const strong = [m.runtime?.plugin_root_env, m.runtime?.project_dir_env].filter(Boolean);
    const weak = [
      ...(m.runtime?.detect_env || []).filter((k) => !strong.includes(k)),
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
  // A strong signal is the harness identifying itself, and it decides.
  if (best && best.strong) return best.id;

  // Only weak signals. That is not enough to switch harness: the project
  // itself carries better evidence — whichever harness directory actually
  // holds a projectstore config is the harness this project was bound under,
  // and that is where its state belongs.
  const cwd = process.cwd();
  for (const m of loadHarnesses(dir).values()) {
    const d = m.runtime?.project_config_dir, b = m.runtime?.config_basename;
    if (d && b && existsSync(join(cwd, d, b))) return m.id;
  }
  if (best) return best.id;
  const src = sourceHarness(dir);
  return src ? src.id : null;
}

// Test seam: the detected id is memoised for the process; a test that changes
// process.env to impersonate a harness needs the next call to look again.
export function resetDetection() {
  _detected = null;
}

// Which harnesses this PROJECT uses — by directory (install spec, contract
// 8). Not detectHarnessId: that answers "which harness launched this
// process" from branded environment variables, and using it here would
// conjure .claude/ for a Codex user. Not memoised: it is per directory, and a
// test builds a project per case.
export function detectHarnesses(projectDir, { dir = MANIFEST_DIR } = {}) {
  const out = [];
  for (const m of loadHarnesses(dir).values()) {
    const d = m.runtime?.project_config_dir;
    if (d && existsSync(join(projectDir, d))) out.push({ id: m.id, why: "directory", evidence: d });
  }
  return out;
}

// The refusal when nothing is detected and nothing is named — built from the
// manifests, so a new harness appears in it without an edit here.
export function harnessRefusal(projectDir, dir = MANIFEST_DIR) {
  const lines = [`No harness detected in ${projectDir}, and none named. Name one:`];
  for (const m of loadHarnesses(dir).values()) {
    lines.push(`  --harness ${m.id}    (${m.display_name}; detected by its project directory: ${m.runtime?.project_config_dir || "?"})`);
  }
  return lines.join("\n");
}

export function activeHarness(env = process.env, dir = MANIFEST_DIR) {
  return loadHarness(detectHarnessId(env, dir), dir) || sourceHarness(dir);
}

// ─── Runtime names and paths ───────────────────────────────────────────

// The three branded names the active harness uses, so a caller can say which
// variable it is talking about without spelling it.
export function runtimeEnvNames(env = process.env) {
  const r = activeHarness(env)?.runtime || {};
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

// Where this projectstore installation lives on disk.
export function pluginRoot(env = process.env) {
  const key = activeHarness(env)?.runtime?.plugin_root_env;
  if (key && env[key]) return env[key];
  for (const h of loadHarnesses().values()) {
    const k = h.runtime?.plugin_root_env;
    if (k && env[k]) return env[k];
  }
  // fileURLToPath, not URL.pathname: the latter stays percent-encoded, so an
  // install path containing a space resolves to a directory that does not exist.
  return REPO_ROOT;
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

// The per-project directory the harness discovers (".claude" for the source
// layout) and the projectstore config inside it. One resolver, so the config
// reader for this project and the one for an arbitrary project cannot drift.
export function projectConfigDir(env = process.env) {
  return activeHarness(env)?.runtime?.project_config_dir || ".claude";
}

export function configPath(projectDir, env = process.env) {
  const r = activeHarness(env)?.runtime || {};
  return join(projectDir, r.project_config_dir || ".claude", r.config_basename || "projectstore.json");
}

// The ONE place a branded name is WRITTEN: a child process spawned by a core
// script needs the project handed to it in the harness's own vocabulary, and
// on a harness with no project-dir variable it needs nothing at all.
export function childEnv(base = process.env, { projectRoot: root } = {}) {
  const out = { ...base };
  const key = activeHarness(base)?.runtime?.project_dir_env;
  if (key && root) out[key] = root;
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
  for (const m of loadHarnesses(dir).values()) {
    if (m.id === harness.id) continue;
    for (const t of m.tools?.write_tools || []) out.push({ pattern: `\\b${t}\\b`, class: "token", derived: true });
    const r = m.runtime || {};
    for (const k of [r.project_dir_env, r.plugin_root_env, r.home_env, ...(r.detect_env || [])]) {
      if (k) out.push({ pattern: `\\b${k}\\b`, class: "token", derived: true });
    }
  }
  return out;
}

// projectstore — harness.mjs
//
// The one place that knows which agentic harness this process is running under,
// and the only place allowed to read a harness-branded environment variable.
//
// Everything else in scripts/ is pure compute over a vault and must stay that
// way: a function that reads `process.env.CLAUDE_PROJECT_DIR` directly is a
// function that silently resolves to `process.cwd()` on every other harness,
// which is not an error anyone sees — it is a vault that quietly binds to the
// wrong directory. So the branded names live in harnesses/<id>.json, this file
// resolves them, and lib.mjs re-exports the results under the names it already
// published.
//
// Pure node, no external deps — same constraint as lib.mjs.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const MANIFEST_DIR = join(REPO_ROOT, "harnesses");

// ─── Manifests ─────────────────────────────────────────────────────────

let _cache = null;

// Every manifest in harnesses/, id-keyed. Read once per process: the build,
// the lint and the hooks all call this, and re-reading eight files per call
// would put filesystem latency inside the PreToolUse budget.
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

// The harnesses that receive a generated tree. Claude Code is `emit: false`
// because the repository's own commands/, agents/, skills/ and hooks/ ARE its
// tree — generating it would mean generating the source over itself.
export function emittingHarnesses(dir = MANIFEST_DIR) {
  return [...loadHarnesses(dir).values()].filter((m) => m.emit);
}

export function sourceHarness(dir = MANIFEST_DIR) {
  return [...loadHarnesses(dir).values()].find((m) => m.source_layout) || null;
}

// ─── Detection ─────────────────────────────────────────────────────────

// Which harness launched us. Decided by the branded environment variables each
// manifest declares, never by a hardcoded name — so a new harness becomes
// detectable by adding its JSON, with no edit here.
//
// PROJECTSTORE_HARNESS overrides everything: the installer sets it in the
// wrappers it generates, and it is how a test pins the answer. When nothing
// matches we return the source harness rather than null, because every caller
// wants a manifest and the source layout is the one that is always present.
export function detectHarnessId(env = process.env, dir = MANIFEST_DIR) {
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
    const keys = new Set([
      ...(m.runtime?.detect_env || []),
      m.runtime?.plugin_root_env,
      m.runtime?.project_dir_env,
      m.runtime?.home_env,
    ].filter(Boolean));
    const hits = [...keys].filter((k) => env[k]).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { id: m.id, hits };
  }
  if (best) return best.id;
  const src = sourceHarness(dir);
  return src ? src.id : null;
}

export function activeHarness(env = process.env, dir = MANIFEST_DIR) {
  return loadHarness(detectHarnessId(env, dir), dir);
}

// ─── Path resolution ───────────────────────────────────────────────────

// The project the user is working in. Codex hooks carry `cwd` on stdin rather
// than exporting a project variable, so callers that have hook input should
// pass it — process.cwd() is a hook's own working directory, which is not
// reliably the project root.
// Set from a hook's own stdin payload. Codex does not export a project-dir
// variable, and a hook process's cwd is not reliably the project — the payload's
// `cwd` is the only trustworthy answer, and it is only available after stdin has
// been read. Hooks therefore call adoptHookInput() before readConfig(), because
// config lookup resolves against the project root and a wrong root means the
// project reads as unbound and the hook silently does nothing.
let _hookProjectRoot = null;

export function adoptHookInput(input) {
  if (input && typeof input.cwd === "string" && input.cwd) _hookProjectRoot = input.cwd;
  return input;
}

// Test seam: process-global state that outlives a single call needs a way back.
export function resetHookInput() {
  _hookProjectRoot = null;
}

export function projectRoot(env = process.env, hookInput = null) {
  const m = activeHarness(env);
  const key = m?.runtime?.project_dir_env;
  // An explicitly exported project directory still wins: it is the harness
  // stating the answer, where cwd is us inferring it.
  if (key && env[key]) return env[key];
  // Every manifest's variable, not just the active one: a wrapper may set the
  // Claude Code name while running under another harness, and honouring it is
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
  const m = activeHarness(env);
  const key = m?.runtime?.plugin_root_env;
  if (key && env[key]) return env[key];
  for (const h of loadHarnesses().values()) {
    const k = h.runtime?.plugin_root_env;
    if (k && env[k]) return env[k];
  }
  if (env.PROJECTSTORE_ROOT) return env.PROJECTSTORE_ROOT;
  // fileURLToPath, not URL.pathname: the latter stays percent-encoded, so an
  // install path containing a space resolves to a directory that does not exist.
  return REPO_ROOT;
}

// The harness's own config directory (~/.claude, ~/.codex, …).
export function agentHome(env = process.env, home = homedir()) {
  const m = activeHarness(env);
  const key = m?.runtime?.home_env;
  if (key && env[key]) return env[key];
  return join(home, m?.runtime?.home_default || ".claude");
}

// ─── Config location ───────────────────────────────────────────────────

// Deliberately NOT one path. A project bound under Claude Code writes
// `.claude/projectstore.json`; the same checkout opened in Codex must find that
// bind rather than report an unbound project and invite the user to bind a
// second time into a second file. So reads search every harness's directory
// plus a neutral one, and the first hit wins.
//
// Order: neutral first (an explicit cross-harness choice outranks either
// harness's default), then the active harness, then the rest — alphabetical by
// id so the answer never depends on directory-listing order.
export const NEUTRAL_CONFIG_DIR = ".projectstore";
export const NEUTRAL_CONFIG_BASENAME = "config.json";

export function configCandidates(projectDir, env = process.env) {
  const out = [join(projectDir, NEUTRAL_CONFIG_DIR, NEUTRAL_CONFIG_BASENAME)];
  const activeId = detectHarnessId(env);
  const all = [...loadHarnesses().values()];
  const ordered = [
    ...all.filter((m) => m.id === activeId),
    ...all.filter((m) => m.id !== activeId).sort((a, b) => a.id.localeCompare(b.id)),
  ];
  for (const m of ordered) {
    const d = m.runtime?.project_config_dir;
    const b = m.runtime?.config_basename;
    if (d && b) out.push(join(projectDir, d, b));
  }
  return out;
}

// The config that exists, else where a fresh bind should write it.
export function configPath(projectDir, env = process.env) {
  const cands = configCandidates(projectDir, env);
  for (const p of cands) if (existsSync(p)) return p;
  return cands[1] || cands[0]; // active harness's dir; neutral only if it is all we have
}

// ─── Tool vocabulary ───────────────────────────────────────────────────

export function writeTools(env = process.env) {
  return activeHarness(env)?.tools?.write_tools || [];
}

export function isWriteTool(tool, env = process.env) {
  return writeTools(env).includes(tool);
}

// Paths a single tool call touched — a LIST, because Codex's apply_patch
// reports one call per patch and a patch may span many files. Claude Code's
// write tools carry exactly one path each and yield a one-element list, so
// callers have a single shape to handle rather than two.
export function extractPaths(input, env = process.env) {
  if (!input || !input.tool_input) return [];
  const m = activeHarness(env);
  const ti = input.tool_input;
  const out = [];

  for (const f of m?.tools?.path_fields || []) {
    if (typeof ti[f] === "string" && ti[f]) out.push(ti[f]);
  }

  const env_field = m?.tools?.patch_envelope_field;
  if (env_field) {
    const raw = ti[env_field];
    const text = Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : null;
    if (text) out.push(...parsePatchEnvelopePaths(text));
  }

  // Absolute, always. An apply_patch envelope names paths RELATIVE to the
  // session's working directory ("src/app.ts"), while every consumer —
  // isSourcePath, isInsideVault, the activity log, the statusline pointer —
  // compares against an absolute project or vault root and returns false for
  // anything else. Returning them unresolved meant Codex edits scored nothing
  // and logged nothing, with no error anywhere: the exact silent-failure shape
  // the harness boundary exists to prevent.
  const base = (input.cwd && typeof input.cwd === "string" && input.cwd) || projectRoot(env, input);
  return [...new Set(out)].map((p) => (isAbsolute(p) ? p : resolve(base, p)));
}

// Pull the file paths out of an apply_patch envelope. The format is a plain
// text block whose operation lines name their target:
//
//   *** Begin Patch
//   *** Update File: src/app.ts
//   *** Add File: docs/new.md
//   *** Delete File: old.txt
//   *** Move to: src/renamed.ts
//   *** End Patch
//
// Tolerant on purpose: an envelope shape we do not recognise yields nothing,
// which costs an unlogged activity entry — never a crashed tool call.
export function parsePatchEnvelopePaths(text) {
  const out = [];
  const re = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  const mv = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gm;
  while ((m = mv.exec(text)) !== null) out.push(m[1]);
  return out;
}

// ─── Rewrites ──────────────────────────────────────────────────────────

// Apply a harness's rewrite table to a string. Rules run in DECLARED ORDER and
// each is a plain substring replacement — the order is load-bearing, and each
// manifest says so where it matters (".claude/projectstore.json" must be
// rewritten before the ".claude/" catch-all, or the specific rule never fires).
export function applyRewrites(text, harness) {
  let out = String(text);
  for (const r of harness?.rewrites || []) {
    if (!r || typeof r.from !== "string" || typeof r.to !== "string") continue;
    out = out.split(r.from).join(r.to);
  }
  return out;
}

// Does this harness have a rule that would rewrite `token`? Used by the lint:
// a harness-branded fragment nobody maps is a feature that silently only works
// on one harness.
export function coversToken(harness, token) {
  return (harness?.rewrites || []).some(
    (r) => typeof r?.from === "string" && (token.includes(r.from) || r.from.includes(token)),
  );
}

export function resolvePath(...parts) {
  return resolve(...parts);
}

// ─── Surface references in runtime prose ───────────────────────────────
//
// Hooks inject text the model reads, and that text names commands and agents.
// The names differ per harness — `/projectstore:adr` on Claude Code is
// `/projectstore-adr` on Codex — so hardcoding either spelling means half the
// harnesses get told to run something that does not exist. These render the
// active harness's form from its manifest.

function renderRef(surfaceKey, name, env) {
  const m = activeHarness(env);
  const tpl = m?.surfaces?.[surfaceKey]?.invocation;
  if (!tpl) return name;
  return tpl.replace(/<name>/g, name);
}

export function commandRef(name, env = process.env) {
  return renderRef("commands", name, env);
}

export function agentRef(name, env = process.env) {
  return renderRef("agents", name, env);
}

// How this harness receives updates. Marketplace toggles, checkout pulls and
// installer re-runs are not the same instruction wearing different words, so
// the manifest carries the lines rather than a name to be substituted.
export function updateInstructions(env = process.env) {
  return activeHarness(env)?.update_instructions || [];
}

// Whether this harness supports a named capability (statusline, an interactive
// approval tool, …). Prose that promises one should ask first.
export function hasCapability(key, env = process.env) {
  return Boolean(activeHarness(env)?.capabilities?.[key]);
}

// The active harness's per-project config directory (<project>/.claude,
// <project>/.codex, …). projectstore keeps its machine-local runtime state
// under it — session pointers, the entry-reminder log, the first-run marker.
//
// Harness-scoped rather than neutral on purpose: the directory is already
// gitignored in every project that uses that harness, and a neutral
// `.projectstore/` would need a fresh .gitignore entry in every existing
// checkout to stop machine-local state from being committed.
export function projectConfigDir(projectDir, env = process.env) {
  const m = activeHarness(env);
  return join(projectDir, m?.runtime?.project_config_dir || ".claude");
}

// Rewrite every `/projectstore:<name>` in a user-facing string into the active
// harness's spelling.
//
// Applied at the few points where projectstore emits text to a human or to the
// model, rather than at each of the ~30 sites that compose such a string. Doing
// it per site would mean every future message is one forgotten `commandRef()`
// away from telling a Codex user to run a command that does not exist — a
// failure that reads as a working message and only breaks when someone follows
// it.
export function localizeCommands(text, env = process.env) {
  const m = activeHarness(env);
  const tpl = m?.surfaces?.commands?.invocation;
  if (!tpl || tpl === "/projectstore:<name>") return text;
  // `*` is included so the wildcard form ("any /projectstore:* command") is
  // localized too, rather than being left as the one Claude Code spelling in an
  // otherwise translated sentence.
  return String(text).replace(/\/projectstore:([a-z][a-z0-9-]*|\*)/g, (_all, name) =>
    tpl.replace(/<name>/g, name),
  );
}

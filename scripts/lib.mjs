// projectstore — shared helpers used by commands and hooks.
// Pure node, no external deps. Keep this single-file & dependency-free
// so plugin install does not require npm install.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { hostname } from "node:os";

// ─── Paths ─────────────────────────────────────────────────────────────

export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(new URL(import.meta.url).pathname));
}

export function configPath() {
  return join(projectRoot(), ".claude", "projectstore.json");
}

// ─── Config ────────────────────────────────────────────────────────────

export function readConfig() {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

export function writeConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ─── Status line wiring (SessionStart-managed) ─────────────────────────
//
// The Claude Code statusLine slot is single and NOT plugin-declarable, so
// when a bound project opts in (projectstore.json → statusline.enabled=true)
// the SessionStart hook keeps <project>/.claude/settings.local.json pointing
// at THIS plugin version's scripts/statusline.mjs. The path is re-derived from
// pluginRoot() every session start, so it self-heals across plugin updates.
// Idempotent (writes only when the value changes); never clobbers a foreign
// statusLine; bails on an unparseable settings file. Returns a status string,
// never throws — the caller wraps it, and this must not break session start.
export function syncStatusLine(cfg, projectDir) {
  const st = cfg && cfg.statusline;
  if (!st || typeof st.enabled !== "boolean") return "no-flag"; // absent → leave manual installs alone

  const p = join(projectDir, ".claude", "settings.local.json");
  const desired = `node "${join(pluginRoot(), "scripts", "statusline.mjs")}"`;

  let settings = {};
  if (existsSync(p)) {
    try {
      settings = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return "skipped-unparseable"; // never clobber a file we cannot read
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return "skipped-nonobject";
    }
  }

  const cur = settings.statusLine;
  const curCmd = cur && typeof cur.command === "string" ? cur.command : null;
  const isOurs = curCmd ? curCmd.includes("scripts/statusline.mjs") : false;

  let changed = false;
  if (st.enabled) {
    if (cur && !isOurs) return "foreign-present"; // any existing non-ours entry: leave the slot to its owner
    if (!cur || curCmd !== desired) {
      settings.statusLine = { type: "command", command: desired };
      changed = true;
    }
  } else if (isOurs) {
    delete settings.statusLine; // disabled: remove only our entry, keep the rest
    changed = true;
  }

  if (!changed) return "unchanged";
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    return "write-failed";
  }
  return st.enabled ? "enabled" : "disabled";
}

// ─── Layouts ───────────────────────────────────────────────────────────

export function loadLayout(name) {
  const p = join(pluginRoot(), "scaffold", "layouts", `${name}.json`);
  if (!existsSync(p)) {
    throw new Error(`Layout not found: ${name} (expected at ${p})`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function folderByKind(layout, kind) {
  return layout.folders.find((f) => f.kind === kind) || null;
}

// ─── Templates ─────────────────────────────────────────────────────────

export function loadTemplate(lang, name) {
  const p = join(pluginRoot(), "templates", lang, `${name}.md.tmpl`);
  if (!existsSync(p)) {
    throw new Error(`Template not found: templates/${lang}/${name}.md.tmpl`);
  }
  return readFileSync(p, "utf8");
}

// {{x}} substitutes raw; {{x_json}} substitutes JSON.stringify(String(x)) — a
// valid YAML double-quoted scalar. Frontmatter lines in templates use the
// _json form so titles containing `"` or `:` cannot corrupt the YAML.
export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key.endsWith("_json")) {
      const base = key.slice(0, -5);
      return base in vars ? JSON.stringify(String(vars[base])) : '""';
    }
    if (key in vars) {
      const v = vars[key];
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    }
    return "";
  });
}

// ─── Heading / keyword registry (PS-SPEC story-002) ────────────────────
//
// scaffold/headings.json is the language-independent registry of the section
// headings, inline keywords and index-table column names the deterministic
// scripts (doctor / reconcile / story-section) must recognize. Per id, per
// language, an ARRAY of accepted forms; the FIRST form of the configured
// language is the canonical form used when WRITING. Matching always accepts
// every registered form of every language — a ru-headed file in an en-bound
// vault must still lint. This is deliberately separate from
// templates/<lang>/strings.json, which is a render-only map for the statusline.

let _headingsCache = null;

export function loadHeadingsRegistry() {
  if (_headingsCache) return _headingsCache;
  const p = join(pluginRoot(), "scaffold", "headings.json");
  try {
    _headingsCache = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`heading registry missing or unreadable (${p}): ${e.message}`);
  }
  return _headingsCache;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allForms(section, id) {
  const entry = loadHeadingsRegistry()[section]?.[id];
  if (!entry) throw new Error(`headings.json has no ${section} entry "${id}"`);
  return Object.values(entry).flat();
}

// Canonical write form for the configured language (en fallback).
export function heading(id, lang = "en") {
  const entry = loadHeadingsRegistry().headings?.[id];
  if (!entry) throw new Error(`headings.json has no headings entry "${id}"`);
  return (entry[lang] || entry.en)[0];
}

// Matches a `## <heading>` line in any registered language, case-insensitively
// (hand-typed `## критерии приёмки` still matches). Anchored to the full line
// so "Acceptance" never matches "Acceptance Criteria".
export function headingLineRe(id) {
  const forms = allForms("headings", id).map(escapeRe);
  return new RegExp(`^##\\s+(?:${forms.join("|")})\\s*$`, "mi");
}

// Extract the body of section `id`: text between its heading line and the
// next `## ` heading (or end of file). Returns null when the section is absent.
export function sectionOf(body, id) {
  const m = body.match(headingLineRe(id));
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function keywordRe(id) {
  const forms = allForms("keywords", id).map(escapeRe);
  return new RegExp(`(?:${forms.join("|")})`, "i");
}

// Matches a folder-README index header row in any registered language,
// in the standard 4-column form: | File | Title | Status | Date |
export function indexHeaderRe() {
  const cols = ["file", "title", "status", "date"].map((c) =>
    allForms("index_columns", c).map(escapeRe).join("|"));
  return new RegExp(
    `^\\|\\s*(?:${cols[0]})\\s*\\|\\s*(?:${cols[1]})\\s*\\|\\s*(?:${cols[2]})\\s*\\|\\s*(?:${cols[3]})\\s*\\|`);
}

// ─── Frontmatter list fields (code_refs / specs / stories / adr) ───────
//
// Frontmatter lists must use inline flow form (`specs: ["SPEC-001"]`) —
// parseFrontmatter is line-based and cannot see block sequences. Single
// shared parser; doctor emits a dedicated finding for the block-form trap.
export function listOf(fm, key) {
  const raw = fm[key];
  if (!raw || raw === "[]") return [];
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ─── Vault-side policy config (ADR-007 Decision 4) ─────────────────────
//
// <vault>/.projectstore.json — vault ROOT, dot-prefixed: git commits it (so
// the policy survives clones and second machines), Obsidian hides it, and it
// is intentionally NOT inside <vault>/.projectstore/, whose .gitignore ("*")
// would defeat the whole point. Keys: spec_policy ("required"|"optional"),
// lifecycle_gates ("on"|"off"), spec_policy_since (ISO-8601, stamped when
// spec_policy first becomes "required").
export function vaultConfigPath(vault) {
  return join(vault, ".projectstore.json");
}

export function readVaultConfig(vault) {
  const p = vaultConfigPath(vault);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeVaultConfig(vault, cfg) {
  writeFileSync(vaultConfigPath(vault), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// Legacy exemption (ADR-007 Decision 6): a story is exempt from spec-first
// and lifecycle gates iff it was already done before the policy existed —
// status done AND (no closed_at at all, or closed_at earlier than
// spec_policy_since). Stories in progress/review at enable time are IN scope.
export function isLegacyStory(fm, since) {
  const status = String(fm.status || "").toLowerCase();
  if (status !== "done") return false;
  const closed = fm.closed_at && fm.closed_at !== "null" ? String(fm.closed_at) : null;
  if (!closed) return true;
  if (!since) return true;
  return closed < String(since);
}

// ─── Slug / numbering ──────────────────────────────────────────────────

// Cyrillic → Latin so ru titles produce portable ASCII filenames; every other
// Unicode letter/digit survives via \p{L}\p{N}. Never returns an empty slug.
const CYRILLIC = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugify(s) {
  const slug = s
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => CYRILLIC[c] ?? c)
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled";
}

// Prefix is matched case-insensitively and with regex metacharacters escaped:
// GrammarHelper ships `spec-002-*.md` while the layout prefix is `SPEC-` — a
// case-sensitive match would hand out SPEC-001 next to an existing spec-001.
export function nextNumber(dir, prefix, pad = 3) {
  if (!existsSync(dir)) return String(1).padStart(pad, "0");
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped}(\\d+)`, "i");
  const nums = readdirSync(dir)
    .map((n) => n.match(rx))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return String(next).padStart(pad, "0");
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Full ISO-8601 UTC timestamp — for story lifecycle fields (started_at /
// closed_at / plan_updated_at) and spec_policy_since, which must be strictly
// comparable and need sub-day resolution (diff-refs anchors git --since on
// them). Deliberately finer-grained than the date-only created:/updated:.
export function nowIso() {
  return new Date().toISOString();
}

// ─── Vault map (for SessionStart hook) ─────────────────────────────────

export function buildVaultMap(cfg) {
  const lines = [];
  const vault = cfg.vault_path;
  if (!existsSync(vault)) {
    return `# projectstore: vault not found at ${vault}\n`;
  }
  lines.push(`# Projectstore vault: ${vault}`);
  lines.push(`# Layout: ${cfg.layout}`);
  lines.push("");
  const rootReadme = join(vault, "README.md");
  if (existsSync(rootReadme)) {
    lines.push(readFileSync(rootReadme, "utf8"));
  }
  if ((cfg.inject_depth ?? 1) >= 1) {
    const layout = loadLayout(cfg.layout);
    for (const folder of layout.folders) {
      const readme = join(vault, folder.path, "README.md");
      if (existsSync(readme)) {
        lines.push(`\n---\n\n## ${folder.path}/\n\n${readFileSync(readme, "utf8")}`);
      }
    }
  }
  if ((cfg.inject_depth ?? 1) >= 2) {
    const layout = loadLayout(cfg.layout);
    lines.push(`\n---\n\n## File index (depth 2)\n`);
    for (const folder of layout.folders) {
      const dir = join(vault, folder.path);
      if (!existsSync(dir)) continue;
      lines.push(`\n### ${folder.path}/\n`);
      const files = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md");
      for (const f of files) {
        lines.push(`- \`${folder.path}/${f}\``);
      }
    }
  }
  return lines.join("\n");
}

// ─── Session awareness (layer 2 — multi-Claude coordination) ──────────
//
// Each Claude Code session registers itself in
// <vault>/.projectstore/sessions/<id>.json, where <id> is Claude's own
// session_id (from hook stdin input). Two Claude instances in the same
// project therefore get distinct files. Other sessions reading the vault
// can detect each other and warn the agent to avoid topic / numbering
// collisions. mtime is used as a liveness proxy: a session whose file
// has not been touched in 30 minutes is considered idle; >24h => stale,
// removed on next SessionStart.

export function sessionsDir(vault) {
  return join(vault, ".projectstore", "sessions");
}

export function sessionFilePath(vault, sessionId) {
  return join(sessionsDir(vault), `${sessionId}.json`);
}

// Read Claude's own session_id from hook stdin JSON. Returns null on any
// parse error — callers must no-op silently in that case.
export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function ensureSessionsDir(vault) {
  const dir = sessionsDir(vault);
  mkdirSync(dir, { recursive: true });
  // Make sure no session metadata leaks into git, regardless of where the
  // vault lives. A nested .gitignore inside .projectstore/ is the simplest
  // way to handle this idempotently.
  const gi = join(vault, ".projectstore", ".gitignore");
  if (!existsSync(gi)) {
    writeFileSync(gi, "# projectstore — runtime data, do not commit\n*\n", "utf8");
  }
  return dir;
}

// Idempotent: preserves started_at and recent_activity if the session file
// already exists (e.g. when SessionStart fires after touch-session has
// already bootstrapped the record).
export function writeSession(vault, sessionId, projectRoot) {
  ensureSessionsDir(vault);
  const path = sessionFilePath(vault, sessionId);
  let existing = null;
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch {}
  }
  const data = {
    id: sessionId,
    started_at: existing?.started_at || new Date().toISOString(),
    project_root: projectRoot,
    host: hostname(),
    pid: process.pid,
    recent_activity: Array.isArray(existing?.recent_activity) ? existing.recent_activity : [],
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

export function touchSession(vault, sessionId) {
  const p = sessionFilePath(vault, sessionId);
  if (!existsSync(p)) return false;
  const now = new Date();
  try {
    utimesSync(p, now, now);
    return true;
  } catch {
    return false;
  }
}

export function readActiveSessions(vault, currentSessionId, maxAgeMinutes = 30) {
  const dir = sessionsDir(vault);
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let data;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (data.id === currentSessionId) continue;
    out.push({ ...data, last_active: stat.mtime });
  }
  return out;
}

export function cleanupStaleSessions(vault, maxAgeHours = 24) {
  const dir = sessionsDir(vault);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// One-shot migration helper: delete .claude/.projectstore-session-id left
// behind by v0.3 – v0.5 (file-based per-project session id). Safe to call
// on every session start; no-op if the file is absent. Kept until v0.7.
export function removeLegacySessionIdFile(projectDir) {
  const p = join(projectDir || projectRoot(), ".claude", ".projectstore-session-id");
  if (existsSync(p)) {
    try { unlinkSync(p); } catch {}
  }
}

// ─── Session activity log (for PreCompact survival packet) ─────────────
//
// Each session file may carry a `recent_activity` array, populated by
// touch-session.mjs from PreToolUse events. Capped at 50 entries, deduped
// by path (latest tool/timestamp wins). Used by hooks/pre-compact.mjs.

const ACTIVITY_CAP = 50;

export function appendActivity(vault, sessionId, filePath, toolName) {
  const sp = sessionFilePath(vault, sessionId);
  if (!existsSync(sp)) return false;
  let data;
  try {
    data = JSON.parse(readFileSync(sp, "utf8"));
  } catch {
    return false;
  }
  const recent = Array.isArray(data.recent_activity) ? data.recent_activity : [];
  const filtered = recent.filter((e) => e && e.path !== filePath);
  filtered.unshift({ path: filePath, tool: toolName, at: new Date().toISOString() });
  data.recent_activity = filtered.slice(0, ACTIVITY_CAP);
  try {
    writeFileSync(sp, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function readSessionActivity(vault, sessionId) {
  const sp = sessionFilePath(vault, sessionId);
  if (!existsSync(sp)) return [];
  try {
    const data = JSON.parse(readFileSync(sp, "utf8"));
    return Array.isArray(data.recent_activity) ? data.recent_activity : [];
  } catch {
    return [];
  }
}

export function isInsideVault(filePath, vaultPath) {
  if (!filePath || !vaultPath) return false;
  const norm = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
  return norm === vaultPath || norm.startsWith(vaultPath + "/");
}

// ─── Per-session project-side state (statusline pointer — ADR-006) ─────
//
// <project>/.claude/.projectstore/state/<session_id>.json holds this
// session's active epic/story with denormalized titles, so the statusline
// renders with zero vault reads and zero cross-session reads. A nested
// .gitignore with "*" is ensured unconditionally (mirrors ensureSessionsDir)
// so per-session ids/titles never reach the user's git history.

export function stateDir(projectDir) {
  return join(projectDir, ".claude", ".projectstore", "state");
}

export function sessionStatePath(projectDir, sessionId) {
  return join(stateDir(projectDir), `${sessionId}.json`);
}

export function ensureStateDir(projectDir) {
  const dir = stateDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const gi = join(projectDir, ".claude", ".projectstore", ".gitignore");
  if (!existsSync(gi)) {
    writeFileSync(gi, "# projectstore — per-session runtime state, do not commit\n*\n", "utf8");
  }
  return dir;
}

export function readSessionState(projectDir, sessionId) {
  try {
    return JSON.parse(readFileSync(sessionStatePath(projectDir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function writeSessionState(projectDir, sessionId, patch) {
  ensureStateDir(projectDir);
  const cur = readSessionState(projectDir, sessionId) || {};
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(sessionStatePath(projectDir, sessionId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function cleanupStaleSessionState(projectDir, maxAgeHours = 24) {
  const dir = stateDir(projectDir);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// ─── Frontmatter parsing (minimal) ─────────────────────────────────────

export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { data: {}, body: md };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "null") v = null;
    else if (v.startsWith('"') && v.endsWith('"')) {
      // JSON.parse round-trips escaped scalars from renderTemplate's _json
      // form (titles containing quotes); fall back to the bare strip.
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    data[kv[1]] = v;
  }
  return { data, body: md.slice(m[0].length) };
}

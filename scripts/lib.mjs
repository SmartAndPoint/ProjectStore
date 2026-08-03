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

export function nextNumber(dir, prefix, pad = 3) {
  if (!existsSync(dir)) return String(1).padStart(pad, "0");
  const rx = new RegExp(`^${prefix}(\\d+)`);
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

// ─── Story discovery ──────────────────────────────────────────────────
//
// A story is written in one of two shapes, and both are load-bearing in real
// vaults:
//
//   stories/story-001-foo.md            — flat file
//   stories/story-001-foo/README.md     — folder, when the story owns artifacts
//
// The folder shape exists because a story that carries attachments (reviews,
// diagrams, drafts) needs somewhere to put them; the README is then the story
// itself. Scanners that only glob `stories/*.md` silently drop those stories —
// on a board that means the card disappears, which reads as "no such work"
// rather than "scanner is blind".
//
// Only `stories/<name>/README.md` counts, not deeper nesting: an
// `artifacts/` subfolder under a story holds attachments, not more stories.

export function listStoryFiles(storiesDir) {
  if (!existsSync(storiesDir)) return [];
  const out = [];
  for (const entry of readdirSync(storiesDir).sort()) {
    const full = join(storiesDir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isFile() && entry.endsWith(".md")) {
      out.push({ abs: full, rel: entry, slug: entry.replace(/\.md$/, "") });
      continue;
    }
    if (st.isDirectory()) {
      const readme = join(full, "README.md");
      if (existsSync(readme)) {
        out.push({ abs: readme, rel: `${entry}/README.md`, slug: entry });
      }
    }
  }
  return out;
}

// Every story belonging to one epic folder, `rel` given relative to that folder.
//
// Besides the two shapes above there is a third: a standalone story — one that
// has its own tracker key and no epic around it, filed as
// epics/<key>/story-<slug>.md with no stories/ subfolder. Callers address it by
// that path (ADRs link straight to it), so it is a real location, not a mistake
// to normalise away.

export function listEpicStories(epicDir) {
  const out = [];
  // epics/ holds loose files too (README, notes) — only folders are epics.
  try { if (!statSync(epicDir).isDirectory()) return out; } catch { return out; }
  for (const s of listStoryFiles(join(epicDir, "stories"))) {
    out.push({ abs: s.abs, rel: `stories/${s.rel}`, slug: s.slug });
  }
  for (const entry of readdirSync(epicDir).sort()) {
    if (!entry.startsWith("story-") || !entry.endsWith(".md")) continue;
    const full = join(epicDir, entry);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    out.push({ abs: full, rel: entry, slug: entry.replace(/\.md$/, "") });
  }
  return out;
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

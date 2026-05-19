// projectstore — shared helpers used by commands and hooks.
// Pure node, no external deps. Keep this single-file & dependency-free
// so plugin install does not require npm install.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
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

export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key in vars) {
      const v = vars[key];
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    }
    return "";
  });
}

// ─── Slug / numbering ──────────────────────────────────────────────────

export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
// Each Claude Code session that loads this plugin registers itself in
// <vault>/.projectstore/sessions/<id>.json. Other sessions reading the
// vault can detect them and warn the agent to avoid topic / numbering
// collisions. mtime is used as a liveness proxy: a session whose file
// has not been touched in 30 minutes is considered idle; >24h => stale,
// removed on next SessionStart.

export function sessionsDir(vault) {
  return join(vault, ".projectstore", "sessions");
}

export function ownSessionIdPath(projectDir) {
  return join(projectDir || projectRoot(), ".claude", ".projectstore-session-id");
}

export function generateSessionId() {
  return `${hostname()}-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
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

export function writeSession(vault, sessionId, projectRoot) {
  ensureSessionsDir(vault);
  const path = join(sessionsDir(vault), `${sessionId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        id: sessionId,
        started_at: new Date().toISOString(),
        project_root: projectRoot,
        host: hostname(),
        pid: process.pid,
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

export function touchSession(vault, sessionId) {
  const p = join(sessionsDir(vault), `${sessionId}.json`);
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

export function writeOwnSessionId(projectDir, sessionId) {
  const p = ownSessionIdPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, sessionId, "utf8");
}

export function readOwnSessionId(projectDir) {
  const p = ownSessionIdPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

// ─── Session activity log (for PreCompact survival packet) ─────────────
//
// Each session file may carry a `recent_activity` array, populated by
// touch-session.mjs from PreToolUse events. Capped at 50 entries, deduped
// by path (latest tool/timestamp wins). Used by hooks/pre-compact.mjs.

const ACTIVITY_CAP = 50;

export function appendActivity(vault, sessionId, filePath, toolName) {
  const sp = join(sessionsDir(vault), `${sessionId}.json`);
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
  const sp = join(sessionsDir(vault), `${sessionId}.json`);
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
    else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: md.slice(m[0].length) };
}

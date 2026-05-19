// projectstore — shared helpers used by commands and hooks.
// Pure node, no external deps. Keep this single-file & dependency-free
// so plugin install does not require npm install.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

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

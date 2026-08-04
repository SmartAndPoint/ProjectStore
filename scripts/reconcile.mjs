#!/usr/bin/env node
// projectstore — reconcile.mjs
// Re-derives every derived view from frontmatter (the source of truth):
// kanban.md, folder-index README tables, code-map.md. Hand-edits therefore
// can never *permanently* desync the board/indexes (PS-IMPROVE story-002,
// ADR-004/005: vault-side repairs belong to reconcile, not doctor --fix).
//
// Computes only — output JSON lists each target with {path, changed, content}
// (content present only when changed). The /projectstore:reconcile command
// writes approved targets. Idempotent: a clean vault yields zero changes.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConfig, loadLayout, projectRoot, pluginRoot, indexHeaderRe } from "./lib.mjs";
import { scanArtifacts } from "./doctor.mjs";

function die(msg) {
  process.stderr.write(`projectstore/reconcile: ${msg}\n`);
  process.exit(1);
}

function runGenerator(script) {
  const r = spawnSync(process.execPath, [join(pluginRoot(), "scripts", script)], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot() },
  });
  if (r.status !== 0) return { error: (r.stderr || "generator failed").trim() };
  try { return JSON.parse(r.stdout); } catch { return { error: "unparseable generator output" }; }
}

const normalize = (s) =>
  s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();

function derivedTarget(script, requireExistingOrRefs) {
  const g = runGenerator(script);
  if (g.error) return { error: g.error };
  const onDisk = existsSync(g.path) ? readFileSync(g.path, "utf8") : null;
  if (requireExistingOrRefs && onDisk === null && g.stats && g.stats.epics_with_refs === 0 && g.stats.story_rows === 0) {
    return { path: g.path, changed: false, skipped: "no code_refs anywhere and no existing file" };
  }
  const changed = onDisk === null || normalize(onDisk) !== normalize(g.content);
  return changed ? { path: g.path, changed, content: g.content } : { path: g.path, changed };
}

// Rebuild a folder README's Index table rows from artifact frontmatter,
// preserving every byte outside the managed table.
function rebuildIndex(cfg, folder, artifacts) {
  const readmePath = join(cfg.vault_path, folder.path, "README.md");
  if (!existsSync(readmePath)) return null;
  const original = readFileSync(readmePath, "utf8");
  const lines = original.split("\n");
  // Header matched via the heading registry (PS-SPEC story-002) — ru vaults'
  // localized index headers were unreconcilable while this was an English
  // literal. Unrecognized headers surface as a doctor index-header finding
  // instead of a silent null here.
  const headerRe = indexHeaderRe();
  const headIdx = lines.findIndex((l) => headerRe.test(l));
  if (headIdx === -1 || !/^\|[-\s|]+\|$/.test(lines[headIdx + 1] || "")) return null;

  let end = headIdx + 2;
  while (end < lines.length && /^\|/.test(lines[end])) end++;

  const rows = [];
  const inFolder = artifacts.filter((a) =>
    folder.kind === "epic"
      ? a.kind === "epic" && a.rel.startsWith(`${folder.path}/`)
      : a.kind === folder.kind && a.rel === `${folder.path}/${basename(a.rel)}`);
  for (const a of inFolder.sort((x, y) => x.rel.localeCompare(y.rel))) {
    const file = basename(a.rel);
    const date = a.fm.date || a.fm.created || "";
    if (folder.kind === "epic") {
      const id = a.rel.split("/")[1];
      rows.push(`| [${id}](./${id}/epic.md) | ${a.fm.title || id} | ${a.fm.status || "planned"} | ${date} |`);
    } else if (folder.numbered && folder.prefix) {
      const m = file.match(new RegExp(`^(${folder.prefix}\\d+)`));
      const label = m ? m[1] : file.replace(/\.md$/, "");
      rows.push(`| [${label}](./${file}) | ${a.fm.title || label} | ${a.fm.status || "proposed"} | ${date} |`);
    } else {
      const label = file.replace(/\.md$/, "");
      rows.push(`| [${label}](./${file}) | ${a.fm.title || label} | ${a.fm.status || "draft"} | ${date} |`);
    }
  }

  const next = [...lines.slice(0, headIdx + 2), ...rows, ...lines.slice(end)].join("\n");
  return next === original
    ? { path: readmePath, folder: folder.path, changed: false }
    : { path: readmePath, folder: folder.path, changed: true, content: next };
}

function main() {
  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind first.");
  const layout = loadLayout(cfg.layout);
  const artifacts = scanArtifacts(cfg, layout);

  const out = {
    kanban: layout.kanban ? derivedTarget("kanban.mjs", false) : { skipped: "layout has no kanban" },
    codemap: derivedTarget("codemap.mjs", true),
    indexes: layout.folders.map((f) => rebuildIndex(cfg, f, artifacts)).filter(Boolean),
  };
  out.summary = {
    changed:
      (out.kanban.changed ? 1 : 0) +
      (out.codemap.changed ? 1 : 0) +
      out.indexes.filter((i) => i.changed).length,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
// projectstore — codemap.mjs
// Derives code-map.md — the epic↔code overview — from epic/story frontmatter
// `code_refs` (ADR-004). Same one-way pattern as kanban.mjs: frontmatter is
// the source of truth, this file is a regenerated view.
//
// Output: JSON { path, content, stats } — compute only. The applier is
// reconcile.mjs --write (atomic replace, recompute-at-write), not the
// harness: no Write-tool step remains in the derived-view flows.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readConfig, loadLayout, folderByKind, parseFrontmatter, nowIso } from "./lib.mjs";
import { localizeCommands } from "./harness.mjs";

function die(msg) {
  process.stderr.write(`projectstore/codemap: ${msg}\n`);
  process.exit(1);
}

function parseRefs(raw) {
  if (!raw || raw === "[]") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function main() {
  const cfg = readConfig();
  if (!cfg) die(localizeCommands("No projectstore config. Run /projectstore:bind first."));
  const layout = loadLayout(cfg.layout);
  const folder = folderByKind(layout, "epic");
  if (!folder) die("Layout has no epic folder — nothing to map.");

  const root = join(cfg.vault_path, folder.path);
  const epics = [];
  const storyRows = [];
  if (existsSync(root)) {
    for (const id of readdirSync(root).sort()) {
      const epicMd = join(root, id, "epic.md");
      if (!existsSync(epicMd)) continue;
      const fm = parseFrontmatter(readFileSync(epicMd, "utf8")).data;
      epics.push({ id, title: fm.title || id, status: fm.status || "planned", refs: parseRefs(fm.code_refs) });
      const storiesDir = join(root, id, "stories");
      if (!existsSync(storiesDir)) continue;
      for (const f of readdirSync(storiesDir).sort()) {
        if (!f.endsWith(".md")) continue;
        const sfm = parseFrontmatter(readFileSync(join(storiesDir, f), "utf8")).data;
        const refs = parseRefs(sfm.code_refs);
        if (refs.length) {
          storyRows.push({ epic: id, story: f.replace(/\.md$/, ""), title: sfm.title || f, refs });
        }
      }
    }
  }

  const lines = [
    "---",
    "",
    "projectstore: derived",
    // Full ISO, not date-only: freshness comparison on an active day is
    // ill-defined otherwise (spec contract 6). Normalizers strip the line.
    `generated_at: ${nowIso()}`,
    "",
    "---",
    "",
    "# Code map",
    "",
    "Epic ↔ code mapping, derived from frontmatter `code_refs` (source of truth).",
    localizeCommands("Regenerate via `/projectstore:codemap`; edit refs via `/projectstore:codemap set`."),
    "",
    "| Epic | Title | Status | code_refs |",
    "|------|-------|--------|-----------|",
  ];
  for (const e of epics) {
    const refs = e.refs.length ? e.refs.map((r) => `\`${r}\``).join(", ") : "—";
    lines.push(`| [[${folder.path}/${e.id}/epic\\|${e.id}]] | ${e.title} | ${e.status} | ${refs} |`);
  }
  if (storyRows.length) {
    lines.push("", "## Story-level refs (files each story touched)", "",
      "| Epic | Story | code_refs |", "|------|-------|-----------|");
    for (const s of storyRows) {
      lines.push(`| ${s.epic} | ${s.title} | ${s.refs.map((r) => `\`${r}\``).join(", ")} |`);
    }
  }
  lines.push("");

  process.stdout.write(JSON.stringify({
    path: join(cfg.vault_path, "code-map.md"),
    content: lines.join("\n"),
    stats: { epics: epics.length, epics_with_refs: epics.filter((e) => e.refs.length).length, story_rows: storyRows.length },
  }, null, 2) + "\n");
}

main();

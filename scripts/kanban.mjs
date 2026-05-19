#!/usr/bin/env node
// projectstore — kanban.mjs
// Regenerates kanban.md by scanning all story files in epics/<id>/stories/*.md,
// reading their frontmatter (status, priority, title, epic) and rendering into the
// kanban template. Source of truth = story frontmatter.
//
// Output: JSON { path, content } — caller writes after approval.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig, loadLayout, loadTemplate, renderTemplate, parseFrontmatter, today } from "./lib.mjs";

function die(msg) {
  process.stderr.write(`projectstore/kanban: ${msg}\n`);
  process.exit(1);
}

function findStories(vault, epicsPath) {
  const root = join(vault, epicsPath);
  if (!existsSync(root)) return [];
  const stories = [];
  for (const epicId of readdirSync(root)) {
    const storiesDir = join(root, epicId, "stories");
    if (!existsSync(storiesDir)) continue;
    for (const file of readdirSync(storiesDir)) {
      if (!file.endsWith(".md")) continue;
      const full = join(storiesDir, file);
      const md = readFileSync(full, "utf8");
      const { data } = parseFrontmatter(md);
      stories.push({
        path: full,
        relPath: `${epicsPath}/${epicId}/stories/${file}`,
        epicId,
        status: (data.status || "planned").toLowerCase(),
        priority: data.priority || "p2",
        title: data.title || file.replace(/\.md$/, ""),
        id: data.id || file.replace(/\.md$/, ""),
      });
    }
  }
  return stories;
}

function statusToColumn(status) {
  const m = {
    planned: "Backlog",
    todo: "ToDo",
    "to-do": "ToDo",
    "in-progress": "In Progress",
    in_progress: "In Progress",
    "in progress": "In Progress",
    review: "Review",
    done: "Done",
    closed: "Done",
  };
  return m[status] || "Backlog";
}

function renderItem(story) {
  const tags = [`#${story.priority}`];
  if (story.status === "done") tags.push("#done");
  if (story.status === "review") tags.push("#review");
  const wikilink = `[[${story.relPath.replace(/\.md$/, "")}|${story.epicId}: ${story.title}]]`;
  const check = story.status === "done" ? "[x]" : "[ ]";
  return `- ${check} ${wikilink} ${tags.join(" ")}`;
}

function main() {
  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind first.");
  const layout = loadLayout(cfg.layout);
  if (!layout.kanban) die(`Layout ${cfg.layout} does not declare a kanban config.`);

  const epicsFolder = layout.folders.find((f) => f.kind === "epic");
  if (!epicsFolder) die("No epic folder in layout — kanban needs epics.");

  const stories = findStories(cfg.vault_path, epicsFolder.path);

  const columns = {};
  for (const col of layout.kanban.columns) columns[col] = [];
  for (const s of stories) {
    const col = statusToColumn(s.status);
    if (!columns[col]) columns[col] = [];
    columns[col].push(renderItem(s));
  }

  const tpl = loadTemplate(cfg.language || "en", "kanban");
  const vars = {
    date: today(),
    backlog_items: (columns["Backlog"] || []).join("\n") || "",
    todo_items: (columns["ToDo"] || []).join("\n") || "",
    in_progress_items: (columns["In Progress"] || []).join("\n") || "",
    review_items: (columns["Review"] || []).join("\n") || "",
    done_items: (columns["Done"] || []).join("\n") || "",
  };

  const out = {
    path: join(cfg.vault_path, layout.kanban.file || "kanban.md"),
    content: renderTemplate(tpl, vars),
    stats: {
      total: stories.length,
      by_column: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])),
    },
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();

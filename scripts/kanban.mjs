#!/usr/bin/env node
// projectstore — kanban.mjs
// Regenerates kanban.md by scanning every story under epics/<id>/stories/ —
// both flat files and story folders (see listStoryFiles) — reading their
// frontmatter (status, priority, title, epic) and rendering into the kanban
// template. Source of truth = story frontmatter.
//
// Output: JSON { path, content } — caller writes after approval.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig, loadLayout, loadTemplate, renderTemplate, parseFrontmatter, today, listEpicStories } from "./lib.mjs";

function die(msg) {
  process.stderr.write(`projectstore/kanban: ${msg}\n`);
  process.exit(1);
}

// Statuses that describe work which is not on the board by definition: it was
// replaced, postponed, or set aside. Putting them in a column would claim the
// work is queued, which is the opposite of what the status says.
const NOT_ACTIONABLE = new Set(["superseded", "deferred", "parked"]);

function findStories(vault, epicsPath) {
  const root = join(vault, epicsPath);
  const stories = [];
  const skipped = { no_status: [], not_actionable: [] };
  if (!existsSync(root)) return { stories, skipped };
  for (const epicId of readdirSync(root)) {
    // `_templates` and friends hold blanks, not work.
    if (epicId.startsWith("_") || epicId.startsWith(".")) continue;
    for (const story of listEpicStories(join(root, epicId))) {
      const md = readFileSync(story.abs, "utf8");
      const { data } = parseFrontmatter(md);
      const relPath = `${epicsPath}/${epicId}/${story.rel}`;

      // A story with no status has no column. Defaulting it to "planned" would
      // invent a claim about work nobody made — legacy stories written before
      // frontmatter existed would show up as queued. They return to the board
      // the moment they get a status.
      if (!data.status) {
        skipped.no_status.push(relPath);
        continue;
      }
      const status = String(data.status).toLowerCase();
      if (NOT_ACTIONABLE.has(status)) {
        skipped.not_actionable.push(relPath);
        continue;
      }

      // The card is labelled by the epic the story claims in its frontmatter,
      // falling back to the folder. Stories get re-filed under a new tracker key
      // without moving on disk, and a standalone story writes `epic: null` —
      // in both cases the folder name is the better answer only when frontmatter
      // has nothing to say.
      const claimed = data.epic == null ? "" : String(data.epic).trim();
      const epicLabel = claimed && claimed !== "null" ? claimed : epicId;

      stories.push({
        path: story.abs,
        relPath,
        epicId: epicLabel,
        status,
        priority: data.priority || "p2",
        title: data.title || story.slug,
        id: data.id || story.slug,
      });
    }
  }
  return { stories, skipped };
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

  const { stories, skipped } = findStories(cfg.vault_path, epicsFolder.path);

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
      // Reported, not hidden: a story missing from the board must be explainable
      // without reading the generator.
      skipped: {
        no_status: skipped.no_status.length,
        not_actionable: skipped.not_actionable.length,
        files: { no_status: skipped.no_status, not_actionable: skipped.not_actionable },
      },
    },
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();

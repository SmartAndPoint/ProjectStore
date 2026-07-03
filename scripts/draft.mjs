#!/usr/bin/env node
// projectstore — draft.mjs
// Pure renderer. Given a kind (adr/epic/story/research/concept/meeting/runbook)
// and arguments, produces a JSON draft on stdout describing the target file
// and its rendered content. Does NOT touch the disk — no writes AND no
// mkdir: declining the approval gate must leave the vault byte-for-byte
// unchanged (ADR-001 review / PS-IMPROVE story-006). Directory creation is
// the caller's job after approval (the Write tool creates parents).
//
// Output schema:
// {
//   "kind": "adr",
//   "path": "/abs/path/to/vault/adr/ADR-015-foo.md",
//   "content": "...rendered markdown...",
//   "index": {                          // optional, when folder has a README index
//     "path": "/abs/path/to/vault/adr/README.md",
//     "line": "| [ADR-015](./ADR-015-foo.md) | Foo | proposed | 2026-05-19 |"
//   },
//   "vars": { ... }                     // template vars used (for debugging)
// }
//
// Errors are written to stderr as plain text and exit code 1.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  loadLayout,
  folderByKind,
  loadTemplate,
  renderTemplate,
  slugify,
  nextNumber,
  today,
} from "./lib.mjs";

function die(msg, code = 1) {
  process.stderr.write(`projectstore/draft: ${msg}\n`);
  process.exit(code);
}

function commonVars(cfg) {
  return {
    date: today(),
    author: cfg.default_author || process.env.USER || "anonymous",
    tags: JSON.stringify(cfg.tags || []),
  };
}

function makeIndexLine(kind, fileName, vars) {
  switch (kind) {
    case "adr":
      return `| [${vars.id}](./${fileName}) | ${vars.title} | proposed | ${vars.date} |`;
    case "epic":
      return `| [${vars.id}](./${vars.id}/epic.md) | ${vars.title} | planned | ${vars.date} |`;
    default:
      return `| [${vars.slug || vars.id}](./${fileName}) | ${vars.title || vars.slug} | draft | ${vars.date} |`;
  }
}

function indexPath(vault, folderPath) {
  return join(vault, folderPath, "README.md");
}

// ─── Per-kind builders ─────────────────────────────────────────────────

function buildAdr(cfg, layout, args) {
  const title = args.join(" ").trim();
  if (!title) die("ADR title is required");
  const folder = folderByKind(layout, "adr");
  if (!folder) die("Layout has no folder of kind=adr");
  const vault = cfg.vault_path;
  const dir = join(vault, folder.path);
  const number = nextNumber(dir, folder.prefix || "ADR-", folder.pad || 3);
  const slug = slugify(title);
  const id = `${(folder.prefix || "ADR-").replace(/-$/, "")}-${number}`;
  const fileName = `${id}-${slug}.md`;
  const vars = {
    ...commonVars(cfg),
    number,
    slug,
    title,
    id,
  };
  const tpl = loadTemplate(cfg.language || "en", "adr");
  return {
    kind: "adr",
    path: join(dir, fileName),
    content: renderTemplate(tpl, vars),
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine("adr", fileName, vars) }
      : null,
    vars,
  };
}

function buildEpic(cfg, layout, args) {
  const id = args[0];
  const title = args.slice(1).join(" ").trim();
  if (!id || !title) die("Epic requires <id> and <title>");
  const folder = folderByKind(layout, "epic");
  if (!folder) die("Layout has no folder of kind=epic");
  const vault = cfg.vault_path;
  const epicDir = join(vault, folder.path, id);
  const vars = { ...commonVars(cfg), id, title };
  const tpl = loadTemplate(cfg.language || "en", "epic");
  return {
    kind: "epic",
    path: join(epicDir, "epic.md"),
    content: renderTemplate(tpl, vars),
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine("epic", "epic.md", vars) }
      : null,
    vars,
  };
}

function buildStory(cfg, layout, args) {
  const epicId = args[0];
  const title = args.slice(1).join(" ").trim();
  if (!epicId || !title) die("Story requires <epic_id> and <title>");
  const folder = folderByKind(layout, "epic");
  if (!folder) die("Layout has no folder of kind=epic");
  const vault = cfg.vault_path;
  const storiesDir = join(vault, folder.path, epicId, "stories");
  if (!existsSync(join(vault, folder.path, epicId))) {
    die(`Epic folder not found: ${folder.path}/${epicId}. Create the epic first via /projectstore:epic.`);
  }
  const number = nextNumber(storiesDir, "story-", 3);
  const slug = slugify(title);
  const id = `story-${number}`;
  const fileName = `${id}-${slug}.md`;
  const vars = {
    ...commonVars(cfg),
    id,
    epic_id: epicId,
    title,
    slug,
  };
  const tpl = loadTemplate(cfg.language || "en", "story");
  return {
    kind: "story",
    path: join(storiesDir, fileName),
    content: renderTemplate(tpl, vars),
    index: null,
    vars,
  };
}

function buildSimple(kind, cfg, layout, args) {
  const title = args.join(" ").trim();
  if (!title) die(`${kind} requires a title`);
  const folder = folderByKind(layout, kind);
  if (!folder) die(`Layout has no folder of kind=${kind}`);
  const vault = cfg.vault_path;
  const dir = join(vault, folder.path);
  const slug = slugify(title);
  const date = today();
  const fileName = folder.date_prefix ? `${date}-${slug}.md` : `${slug}.md`;
  const vars = {
    ...commonVars(cfg),
    slug,
    title,
  };
  const tpl = loadTemplate(cfg.language || "en", kind);
  return {
    kind,
    path: join(dir, fileName),
    content: renderTemplate(tpl, vars),
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine(kind, fileName, vars) }
      : null,
    vars,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) die("usage: draft.mjs <kind> <args...>");
  const kind = argv[0];
  const rest = argv.slice(1);

  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind <vault-path> first.");
  const layout = loadLayout(cfg.layout);

  let result;
  switch (kind) {
    case "adr":
      result = buildAdr(cfg, layout, rest);
      break;
    case "epic":
      result = buildEpic(cfg, layout, rest);
      break;
    case "story":
      result = buildStory(cfg, layout, rest);
      break;
    case "research":
    case "concept":
    case "meeting":
    case "runbook":
      result = buildSimple(kind, cfg, layout, rest);
      break;
    default:
      die(`Unknown kind: ${kind}. Supported: adr, epic, story, research, concept, meeting, runbook.`);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main();

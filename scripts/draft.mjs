#!/usr/bin/env node
// projectstore — draft.mjs
// Pure renderer. Given a kind declared in the bound layout (epic/story are
// structural special cases; every other kind comes from the layout's folders)
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfig,
  loadLayout,
  folderByKind,
  loadTemplate,
  renderTemplate,
  parseFrontmatter,
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

// Index row status is derived from the RENDERED template's own frontmatter —
// never hardcoded per kind — so a new kind's template is the single source of
// its initial status and the index can never disagree with it at birth.
function makeIndexLine(kind, fileName, vars, content) {
  const status = parseFrontmatter(content).data.status || "draft";
  if (kind === "epic") {
    return `| [${vars.id}](./${vars.id}/epic.md) | ${vars.title} | ${status} | ${vars.date} |`;
  }
  const label = vars.id || vars.slug;
  return `| [${label}](./${fileName}) | ${vars.title || label} | ${status} | ${vars.date} |`;
}

function indexPath(vault, folderPath) {
  return join(vault, folderPath, "README.md");
}

// ─── Builders (layout-driven — PS-SPEC story-001) ──────────────────────
//
// Any kind declared in the layout with a folder builds here: `numbered`
// folders get prefix numbering (the recipe formerly hardcoded for ADR),
// plain folders get slug filenames. epic/story remain structural special
// cases (subfolder-per-id, stories/ subdirectory).

function buildNumbered(kind, cfg, layout, args) {
  const title = args.join(" ").trim();
  if (!title) die(`${kind} requires a title`);
  const folder = folderByKind(layout, kind);
  const vault = cfg.vault_path;
  const dir = join(vault, folder.path);
  const prefix = folder.prefix || `${kind.toUpperCase()}-`;
  const number = nextNumber(dir, prefix, folder.pad || 3);
  const slug = slugify(title);
  const id = `${prefix.replace(/-$/, "")}-${number}`;
  const fileName = `${id}-${slug}.md`;
  const vars = {
    ...commonVars(cfg),
    number,
    slug,
    title,
    id,
  };
  const tpl = loadTemplate(cfg.language || "en", kind);
  const content = renderTemplate(tpl, vars);
  return {
    kind,
    path: join(dir, fileName),
    content,
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine(kind, fileName, vars, content) }
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
  const content = renderTemplate(tpl, vars);
  return {
    kind: "epic",
    path: join(epicDir, "epic.md"),
    content,
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine("epic", "epic.md", vars, content) }
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
  const storyPrefix = folder.story_prefix || "story-";
  const number = nextNumber(storiesDir, storyPrefix, folder.story_pad || 3);
  const slug = slugify(title);
  const id = `${storyPrefix}${number}`;
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
  const content = renderTemplate(tpl, vars);
  return {
    kind,
    path: join(dir, fileName),
    content,
    index: existsSync(indexPath(vault, folder.path))
      ? { path: indexPath(vault, folder.path), line: makeIndexLine(kind, fileName, vars, content) }
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
  if (kind === "epic") {
    result = buildEpic(cfg, layout, rest);
  } else if (kind === "story") {
    result = buildStory(cfg, layout, rest);
  } else {
    const folder = folderByKind(layout, kind);
    if (!folder) {
      const known = layout.folders.map((f) => f.kind).filter((k) => k !== "epic");
      die(`Unknown kind: ${kind}. This layout (${cfg.layout}) declares: epic, story, ${known.join(", ")}.`);
    }
    result = folder.numbered
      ? buildNumbered(kind, cfg, layout, rest)
      : buildSimple(kind, cfg, layout, rest);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

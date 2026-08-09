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
//   "path": "/abs/path/to/vault/adr/foo.md",
//   "content": "...rendered markdown...",
//   "index": {                          // optional, when folder has a README index
//     "path": "/abs/path/to/vault/adr/README.md",
//     "line": "| [foo](./foo.md) | Foo | proposed | 2026-05-19 |"
//   },
//   "collision": {                      // null, or the normalized-identity clash
//     "with": "ADR-003-foo.md",        //   (SPEC-002 contract 4 — computed in
//     "identity": "foo",               //   lib.mjs; command prose only renders
//     "selfMatch": false,              //   it, an exact `test -e` cannot see
//     "digitLeading": false            //   cross-era collisions)
//   },
//   "warnings": ["..."],               // e.g. digit-leading slug advisory
//   "vars": { ... }                     // template vars used (for debugging)
// }
//
// Errors are written to stderr as plain text and exit code 1.

import { existsSync, readdirSync } from "node:fs";
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
  findSlugCollision,
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
// Any kind declared in the layout with a folder builds here with a slug-only
// filename (ADR-010: identity lives in the slug; sequential numbering is
// removed from creation — collision-free by construction, no read-then-write
// race between concurrent writers). Layout keys `numbered`/`prefix`/`pad`
// remain declared for grandfathered labels and legacy-strip matching, but
// creation no longer reads a next number. epic/story remain structural
// special cases (subfolder-per-id, stories/ subdirectory).

// Read-only normalized-identity scan of the target directory (SPEC-002
// contract 4). Directory entries include folder-shape stories (dirs).
function scanCollision(dir, fileName, opts) {
  if (!existsSync(dir)) return null;
  return findSlugCollision(fileName, readdirSync(dir).sort(), opts);
}

function digitLeadingWarnings(slug) {
  return /^\d/.test(slug)
    ? [`Slug "${slug}" is digit-leading — the filename visually resembles a numbered-era artifact. Machine resolution keys on id:, so this is safe, but a word-leading title avoids the ambiguity.`]
    : [];
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
    collision: null, // epic ids are user-chosen; the command's own folder check gates them
    warnings: [],
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
  const slug = slugify(title);
  const id = `${storyPrefix}${slug}`;
  const fileName = `${id}.md`;
  const vars = {
    ...commonVars(cfg),
    id,
    epic_id: epicId,
    title,
    slug,
  };
  const tpl = loadTemplate(cfg.language || "en", "story");
  // The identity scope is the EPIC, not just stories/: standalone
  // epics/<id>/story-<slug>.md files share it (doctor scopes them together).
  const epicDir = join(vault, folder.path, epicId);
  const scopeNames = [
    ...(existsSync(storiesDir) ? readdirSync(storiesDir) : []),
    ...readdirSync(epicDir).filter((n) => n.startsWith("story-") && n.endsWith(".md")),
  ].sort();
  return {
    kind: "story",
    path: join(storiesDir, fileName),
    content: renderTemplate(tpl, vars),
    index: null,
    collision: findSlugCollision(fileName, scopeNames, { story: true }),
    warnings: digitLeadingWarnings(slug),
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
    id: slug, // exact machine id (ADR-010): the slug itself, no allocated number
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
    collision: scanCollision(dir, fileName, { prefix: folder.prefix || null }),
    // A date-prefixed filename (meetings) is digit-leading by design — the
    // slug itself is what must not resemble the numbered era.
    warnings: folder.date_prefix ? [] : digitLeadingWarnings(slug),
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
    // `numbered` folders route through buildSimple too (ADR-010): the key
    // stays declared in layouts for grandfathered labels, creation ignores it.
    result = buildSimple(kind, cfg, layout, rest);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

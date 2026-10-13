// projectstore — the public site (PS-HARNESS: "The public site ships from
// site/ to projectstore.dev, and a test fails when it drifts from the repo";
// the site ADR, "The public site is static files in the repo, served by
// GitHub Pages at projectstore.dev").
//
// The site states the repository's facts in eight languages and two llms
// files — its version, its counts, the commands and roles it names, the
// install commands it shows, each harness's status, its links into the
// repository, the shapes of its example artifacts — and, kept outside the
// repository, it drifted within a month. Here a change to any of those
// sources fails until the site agrees, in the same pull request:
//
//   1. the facts are marked in the markup (`data-fact`, `data-source`,
//      `data-title`, `data-slug`, `data-template`), so a check reads
//      attributes, never prose in eight languages, and a page without a
//      marker fails rather than goes unread. The llms files carry the same
//      facts in a fixed shape instead;
//   2. every fact is read from its source — the command and agent files, the
//      manifests' invocation templates, the CLI's verb table, the published
//      shells, the template languages and their headings, the MCP tools,
//      README's fenced lines, the core's own slugify — and never typed here;
//   3. every check is a pure function over strings that returns findings,
//      each naming the file and the fact: [{ page, fact, message }]. The real
//      files return none, and one planted mutation per check, made in memory
//      on a copy of a real file, returns exactly one. A check nobody has seen
//      fail is a check nobody knows works.
//
// The site is one main page and three method pages (PS-HARNESS: "The site
// leads with one install line and the prompts you type, and the method moves
// to pages of its own"), each in every language. A page's kind decides what
// it must carry (KIND_RULES); every other rule holds on every page.
//
// Python-free: the pages are site/tools/i18n.py's output, and CI proves that
// with Python 3.12 (.github/workflows/test.yml). What a stale build would get
// wrong without changing a word is checked here instead: asset hashes,
// alternates and canonicals, the link-preview tags, the redirect, a page per
// dictionary and kind with no orphan folder beside them, the en/ stub.
//
// The helpers live in this file and in tests/fixtures/markdown.mjs, not in
// scripts/: a file there ships, and the runtime vocabulary lint would read
// their command literals.
//
//   node --test tests/site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sourceNames, invocationPatterns, stripComments } from "./fixtures/vocabulary.mjs";
import { markdownLines, cut, unprompt, npxCommand } from "./fixtures/markdown.mjs";
import { VERBS } from "../scripts/cli.mjs";
import { languageNames } from "../scripts/binding.mjs";
import { TOOLS } from "../scripts/mcp.mjs";
import { loadHarness, loadHarnesses, sourceHarness, uiWordPatterns } from "../scripts/harness.mjs";
import {
  slugify,
  anchorKeyOf,
  foldAnchor,
  emptyAnchorState,
  composeAnchorName,
  ANCHOR_SETTLE,
} from "../scripts/lib.mjs";
import { NOT_SHIPPED } from "../scripts/version-guard.mjs";
import { SHELLS, publishable } from "../packaging/shells.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "site";
const ORIGIN = "https://projectstore.dev/";
// The git channel installs every byte of main, site/ included (the site ADR,
// decision 4), so the site has a budget: 2.5 MiB.
const BUDGET = 2621440;
const REPO_URL = "https://github.com/SmartAndPoint/ProjectStore";
const LLMS = ["site/llms.txt", "site/llms-full.txt"];
// The link preview every page names: absolute under every --base-url, because
// the services that read og:image and twitter:image fetch it from outside and
// never resolve a relative URL (tools/i18n.py PREVIEW_IMAGE).
const PREVIEW_IMAGE = `${ORIGIN}assets/og.png`;
const PREVIEW_SIZE = { width: 1280, height: 640 };
const STUB_FILE = "site/en/index.html";
// What tools/i18n.py writes at en/: the old address, redirected to the root.
const STUB =
  '<!doctype html><meta charset="utf-8"><title>ProjectStore</title><link rel="canonical" href="../"><meta http-equiv="refresh" content="0; url=../"><a href="../">ProjectStore</a>\n';
// A copy of LANGS in tools/i18n.py — code to the BCP 47 tag of <html lang> and
// hreflang. A test below holds the copy to the original.
const LANG_TAGS = { en: "en", de: "de", es: "es", fr: "fr", pt: "pt-BR", ru: "ru", uk: "uk", zh: "zh-CN" };
const DEFAULT_LANG = "en";
// A copy of PAGES in tools/i18n.py — each kind of page, its template in src/
// and the folder its pages live in ("" is the language root). A test below
// holds the copy to the original, so a page the build renders cannot go
// unchecked: a new kind fails here until KIND_RULES says what it carries.
const KINDS = [
  { kind: "main", src: "index.html", slug: "" },
  { kind: "how-it-works", src: "how-it-works.html", slug: "how-it-works" },
  { kind: "why-it-works", src: "why-it-works.html", slug: "why-it-works" },
  { kind: "one-vault", src: "one-vault.html", slug: "one-vault" },
];
const slugOf = (kind) => KINDS.find((k) => k.kind === kind)?.slug ?? null;
// A page's folder under the site root, its file and its address: English at
// the root, every other language under <lang>/, a method page in <slug>/.
const pagePath = (lang, slug) => `${lang === DEFAULT_LANG ? "" : `${lang}/`}${slug ? `${slug}/` : ""}`;
const pageFile = (lang, slug) => `${SITE}/${pagePath(lang, slug)}index.html`;
const pageUrl = (lang, slug = "") => `${ORIGIN}${pagePath(lang, slug)}`;
// "A Claude Code plugin" as each page said it before the refresh, from its
// hero and description keys (AC: the phrase and its seven translations).
const RETIRED = [
  "a Claude Code plugin",
  "ein Claude-Code-Plugin",
  "un plugin de Claude Code",
  "un plugin Claude Code",
  "um plugin do Claude Code",
  "плагин для Claude Code",
  "плагін для Claude Code",
  "一个 Claude Code 插件",
];
// The example epic's id: an id, so English and the same on every page.
const EXAMPLE_EPIC = "CHECKOUT";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha8 = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 8);

// ─── HTML, without a parser ────────────────────────────────────────────
//
// The pages are rendered from a few templates and well-formed, and the checks
// need little: start tags, their attributes, an element's text. Comments and
// the bodies of <script> and <style> are not markup — they are dropped before
// tags are read, and read on their own where a check needs them.

const OPEN = /<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ANY_TAG = /<\/?[a-z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const RAW_BODY = /(<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi;
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const rawBodies = (html, name) =>
  [...withoutComments(html).matchAll(RAW_BODY)].filter((m) => m[2].toLowerCase() === name).map((m) => m[3]);

function attributes(source) {
  const out = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

// An element's inner markup: up to its matching end tag, counting nested
// elements of the same name — for a leaf, simply the next closing tag.
function innerOf(markup, el) {
  if (el.selfClosed || VOID.has(el.name)) return "";
  const re = new RegExp(`<(/?)${escape(el.name)}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
  re.lastIndex = el.end;
  let depth = 1;
  for (let m; (m = re.exec(markup));) {
    if (m[1]) {
      if (--depth === 0) return markup.slice(el.end, m.index);
    } else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  return markup.slice(el.end);
}

const textOf = (markup) => decode(markup.replace(ANY_TAG, ""));

// A page as the checks read it: every element in document order, with its
// attributes, its inner markup, its text and whether it is a leaf; and the
// page's language, kind and slug where it is one of the site's pages.
function parse(file, html, lang = null, kind = null) {
  const markup = withoutComments(html).replace(RAW_BODY, "$1$4");
  const els = [...markup.matchAll(OPEN)].map((m) => {
    const el = {
      name: m[1].toLowerCase(),
      attrs: attributes(m[2]),
      start: m.index,
      end: m.index + m[0].length,
      selfClosed: /\/\s*$/.test(m[2]),
    };
    el.inner = innerOf(markup, el);
    el.text = textOf(el.inner);
    el.leaf = !/<[a-z/!]/i.test(el.inner);
    return el;
  });
  return { file, lang, kind, slug: slugOf(kind), html, markup, els };
}

// The text of a page's <body> as a reader sees it: every tag a space, so two
// elements never run together, and no comment, script or style.
const bodyText = (page) => {
  const body = page.els.find((el) => el.name === "body");
  return decode((body ? body.inner : page.markup).replace(ANY_TAG, " "));
};

// What a reader sees or copies: the text — every tag a space, so two elements
// never run together — and every attribute value.
const readable = (page) => [
  decode(page.markup.replace(ANY_TAG, " ")),
  ...page.els.flatMap((el) => Object.values(el.attrs)),
];
const marked = (page, pred = () => true) =>
  page.els.filter((el) => "data-fact" in el.attrs && pred(el.attrs["data-fact"]));
const withAttr = (page, name) => page.els.filter((el) => name in el.attrs);
const hasClass = (el, c) => (el.attrs.class || "").split(/\s+/).includes(c);
const within = (outer, el) => el.start >= outer.start && el.start < outer.end + outer.inner.length;

// What a copy button copies (assets/site.js): its target's data-copy, else
// the target's text. Targets are named by data-copy-from; an element that
// carries data-copy is one too.
function copyBlocks(page) {
  const ids = new Set(page.els.filter((el) => el.attrs["data-copy-from"]).map((el) => el.attrs["data-copy-from"]));
  return page.els
    .filter((el) => ids.has(el.attrs.id) || "data-copy" in el.attrs)
    .map((el) => ({ el, value: el.attrs["data-copy"] ?? el.text }));
}

// ─── Markdown: headings, fences, anchors ───────────────────────────────
//
// markdownLines, cut, unprompt and npxCommand are tests/fixtures/markdown.mjs's,
// shared with the lint of user-facing text (tests/user-text.test.mjs).

// GitHub's anchor for a heading, hand-rolled rather than a dependency:
// inline markup dropped (a link keeps its text), lower-cased, every character
// that is not a letter, a mark, a digit, a connector, "-" or a space removed,
// each space a hyphen — github-slugger's rule. A repeated anchor gets -1, -2.
function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu, "")
    .replace(/ /g, "-");
}

function anchors(md) {
  const seen = new Map();
  const out = [];
  for (const { heading } of markdownLines(md)) {
    if (!heading) continue;
    const base = slug(heading.text);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.push(n ? `${base}-${n}` : base);
  }
  return out;
}

// README's fenced lines, per heading. A line belongs to every heading open
// above it, so a subsection's fence is also its parent's.
function fencedLines(md) {
  const sections = new Map();
  const open = [];
  for (const { line, fenced, heading } of markdownLines(md)) {
    if (heading) {
      while (open.length && open.at(-1).level >= heading.level) open.pop();
      open.push(heading);
      if (!sections.has(heading.text)) sections.set(heading.text, []);
    } else if (fenced && cut(line)) {
      for (const h of open) sections.get(h.text).push(cut(line));
    }
  }
  return sections;
}

// The prompt README gives for installing from inside a session: the first
// blockquote line under its heading, without the "> ".
const PROMPT_HEADING = "In a Claude Code session";
function readmePrompt(md) {
  let inside = false;
  for (const { line, fenced, heading } of markdownLines(md)) {
    if (heading) {
      if (inside) return null;
      inside = heading.text === PROMPT_HEADING;
    } else if (inside && !fenced && /^>\s/.test(line)) return line.replace(/^>\s+/, "").trim();
  }
  return null;
}

// The code a markdown file shows: its fenced lines and its inline code spans.
function markdownCode(md) {
  const out = [];
  for (const { line, fenced } of markdownLines(md)) {
    if (fenced) out.push(line);
    else for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  }
  return out;
}

// ─── Command lines ─────────────────────────────────────────────────────

// The package an npx command names, without its @<version>.
const packageName = (spec) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

// ─── The repository's side ─────────────────────────────────────────────

// The headings under which README may fence an install, upgrade or uninstall
// command (AC 4). `## Install` leads with `npx projectstore setup` (the story
// "User-facing text says where to run and names no project path and no
// shell", rule 7), and each of the three fences its commands.
const INSTALL_HEADINGS = ["Install", "Configure", "Upgrading", "Uninstalling"];

// The frontmatter keys and "## " headings of a template, as the product writes it.
function templateShape(md) {
  const lines = md.split("\n");
  const close = lines.indexOf("---", 1);
  const keys = new Set(
    lines
      .slice(1, close)
      .map((l) => /^([a-z_]+):/.exec(l)?.[1])
      .filter(Boolean),
  );
  const headings = new Set(
    lines
      .slice(close + 1)
      .map((l) => /^## (.+?)\s*$/.exec(l)?.[1])
      .filter(Boolean),
  );
  return { keys, headings };
}

// Every fact a check compares the site with, read from its source.
function repository(root = ROOT) {
  const names = sourceNames(root);
  const published = publishable();
  const layout = JSON.parse(read("scaffold/layouts/engineering.json"));
  const folder = (kind) => layout.folders.find((f) => f.kind === kind);
  const languages = languageNames(root);
  return {
    version: JSON.parse(read("package.json")).version,
    counts: {
      commands: names.commands.length,
      agents: names.agents.length,
      languages: languages.length,
      "mcp-tools": Object.keys(TOOLS).length,
    },
    tools: Object.keys(TOOLS),
    languages,
    names,
    forms: invocationPatterns(root),
    verbs: VERBS.map((v) => v.verb),
    packages: ["projectstore", ...published],
    privateShells: SHELLS.filter((s) => s.private).map((s) => s.name),
    harnesses: SHELLS.filter((s) => published.includes(s.name)).map((s) => ({
      id: s.harness,
      display: loadHarness(s.harness)?.display_name ?? s.display,
    })),
    // Contract 16 of the generation spec: experimental exactly while the
    // manifest's `verified` is null — the derivation docs/harnesses.md is
    // held to in tests/portability.test.mjs.
    status: (id) => {
      const m = loadHarness(id);
      return m ? (m.verified === null ? "experimental" : "supported") : null;
    },
    readme: fencedLines(read("README.md")),
    prompt: readmePrompt(read("README.md")),
    uiWords: uiWordPatterns(sourceHarness()).filter((p) => p.word.startsWith("/")),
    exists: (rel) => existsSync(join(root, rel)),
    anchorsOf: (rel) => anchors(read(rel)),
    // A language without templates (pt, uk today) shows the English ones.
    template: (lang, kind) => {
      const dir = languages.includes(lang) ? lang : "en";
      const rel = `templates/${dir}/${kind}.md.tmpl`;
      return existsSync(join(root, rel)) ? { rel, ...templateShape(read(rel)) } : null;
    },
    // What the product names a thing made from a title (scripts/draft.mjs):
    // adr/<slug>.md, specs/<slug>.md, epics/<id>/stories/story-<slug>.md, and
    // the session name composeAnchorName offers once the story's writes settle.
    derive: (kind, form, title) => {
      const s = slugify(title);
      const dir = (k) => folder(k)?.path;
      const epics = folder("epic");
      const story = `${epics?.story_prefix || "story-"}${s}`;
      const storyPath = `${epics?.path}/${EXAMPLE_EPIC}/stories/${story}.md`;
      const forms = {
        adr: { slug: s, file: `${s}.md`, path: `${dir("adr")}/${s}.md` },
        spec: { slug: s, file: `${s}.md`, path: `${dir("spec")}/${s}.md` },
        story: {
          id: story,
          file: `${story}.md`,
          path: storyPath,
          link: storyPath.replace(/\.md$/, ""),
          ref: `${EXAMPLE_EPIC}/${story}`,
          session: (() => {
            const hit = anchorKeyOf(storyPath, layout);
            let state = emptyAnchorState();
            for (let i = 0; i < ANCHOR_SETTLE; i++) state = foldAnchor(state, hit).state;
            return composeAnchorName(state);
          })(),
        },
      };
      return forms[kind]?.[form] ?? null;
    },
  };
}

// Every page: one per dictionary and kind, the English ones at the root.
function sitePages(root = ROOT) {
  const langs = readdirSync(join(root, SITE, "locales"))
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .sort();
  return langs.flatMap((lang) =>
    KINDS.map(({ kind, slug }) => {
      const file = pageFile(lang, slug);
      return { lang, kind, slug, file, html: existsSync(join(root, file)) ? read(file) : null };
    }),
  );
}

// Every file Pages would serve, with its size. A Finder's .DS_Store is
// gitignored, so no deploy and no install ever carries one.
function siteFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, size: statSync(join(root, p)).size });
    }
  };
  walk(SITE);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── The checks ────────────────────────────────────────────────────────

const finding = (page, fact, message) => ({ page, fact, message });
const unique = (list) => [...new Map(list.map((f) => [JSON.stringify(f), f])).values()];

// AC 3: every harness whose shell is published is named in the hero, the
// install section and <meta name="description">. On the main page the hero is
// the install section (section 01, id="start"): one element, read once.
function checkHarnessesNamed(page, repo) {
  const out = [];
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "description");
  const hero = page.els.find((el) => el.name === "section" && hasClass(el, "hero"));
  const start = page.els.find((el) => el.name === "section" && el.attrs.id === "start");
  const places = [
    ['<meta name="description">', meta ? (meta.attrs.content ?? "") : null],
    ...(hero && hero === start
      ? [["the hero, which is the install section", hero.text]]
      : [
          ["the hero", hero ? hero.text : null],
          ["the install section", start ? start.text : null],
        ]),
  ];
  for (const [where, text] of places) {
    if (text === null) {
      out.push(finding(page.file, "harnesses", `${where} is missing`));
      continue;
    }
    for (const h of repo.harnesses) {
      if (!text.includes(h.display))
        out.push(
          finding(page.file, `harness:${h.id}`, `${where} does not name ${h.display}, whose shell is published`),
        );
    }
  }
  return out;
}

// AC 3: no page and no llms file calls ProjectStore a Claude Code plugin.
function checkWording(file, texts) {
  const all = texts.join("\n").replace(/\s+/g, " ").toLowerCase();
  return RETIRED.filter((p) => all.includes(p.toLowerCase())).map((p) =>
    finding(file, "wording", `"${p}": the plugin is no longer one harness's`),
  );
}

// AC 4: a command or role in any harness's invocation form names a file in
// commands/ or agents/. Forms that share a prefix (Codex calls commands and
// roles through one skill form) accept either kind's names.
function checkInvocations(file, texts, repo) {
  const groups = new Map();
  for (const p of repo.forms) {
    const key = `${p.guard}\u0000${p.prefix}`;
    if (!groups.has(key)) groups.set(key, { prefix: p.prefix, guard: p.guard, harnesses: new Set(), names: new Set() });
    const g = groups.get(key);
    g.harnesses.add(p.harness);
    for (const n of repo.names[p.kind]) g.names.add(n);
  }
  const out = [];
  for (const g of groups.values()) {
    const re = new RegExp(`${g.guard}${escape(g.prefix)}([a-z0-9][a-z0-9-]*)`, "g");
    for (const text of texts) {
      for (const m of text.matchAll(re)) {
        if (!g.names.has(m[1]))
          out.push(
            finding(
              file,
              "invocation",
              `${m[0]} (the ${[...g.harnesses].join("/")} form) names no file in commands/ or agents/`,
            ),
          );
      }
    }
  }
  return unique(out);
}

// AC 4: an `npx projectstore…` names a published package and a verb its bin
// accepts — the core's VERBS; a shell passes every verb through to its core.
// A shell that is not published (private in packaging/shells.mjs) is not
// named at all: nothing a reader runs can reach it.
function checkNpx(file, texts, repo) {
  const out = [];
  const ours = (name) => /^projectstore(-[a-z0-9]+)*$/.test(name);
  for (const text of texts) {
    for (const m of text.matchAll(/(?<![\w-])(?:npx|bunx|pnpm[ \t]+dlx|deno[ \t]+run)[ \t][^\n]*/g)) {
      const cmd = npxCommand(m[0]);
      if (!cmd) continue;
      const name = packageName(cmd.command);
      for (const p of cmd.packages.map(packageName).filter(ours)) {
        if (!repo.packages.includes(p) && !repo.privateShells.includes(p))
          out.push(finding(file, "npx", `${cut(m[0])}: ${p} is not a published package (${repo.packages.join(", ")})`));
      }
      if (!ours(name) || repo.privateShells.includes(name)) continue;
      if (!repo.packages.includes(name))
        out.push(
          finding(file, "npx", `${cut(m[0])}: ${name} is not a published package (${repo.packages.join(", ")})`),
        );
      else if (cmd.verb && /^[a-z]/.test(cmd.verb) && !repo.verbs.includes(cmd.verb))
        out.push(finding(file, "npx", `${cut(m[0])}: the ${name} bin has no verb "${cmd.verb}"`));
    }
    for (const name of repo.privateShells) {
      if (new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(text))
        out.push(finding(file, "npx", `${name} is not published (private in packaging/shells.mjs)`));
    }
  }
  return unique(out);
}

// AC 4: an install, upgrade or uninstall command is a line README fences
// under one of INSTALL_HEADINGS. A line is one when it starts — after a shell
// prompt and npx's own options — with `npx projectstore[-<shell>][@<v>]
// install|upgrade|uninstall|plan|setup`, `npm install -g projectstore`, or the
// source harness's plugin UI. The UI words are its slash words
// (ui_vocabulary, through uiWordPatterns); "/plugin" alone opens Claude
// Code's plugin manager and installs nothing, so it counts only with a
// subcommand that installs, updates or removes.
const MENU_WORDS = new Map([["/plugin", ["install", "uninstall", "update", "marketplace"]]]);
function installForm(line, repo) {
  const l = unprompt(line);
  const cmd = npxCommand(l);
  if (
    cmd &&
    /^projectstore(-[a-z0-9]+)?(@\S+)?$/.test(cmd.command) &&
    ["install", "upgrade", "uninstall", "plan", "setup", "configure"].includes(cmd.verb)
  )
    return true;
  if (/^npm[ \t]+(?:install|i)[ \t]+(?:-g|--global)[ \t]+projectstore\b/.test(l)) return true;
  for (const { word, re } of repo.uiWords) {
    re.lastIndex = 0;
    const m = re.exec(l);
    if (!m || m.index !== 0) continue;
    const subcommands = MENU_WORDS.get(word);
    if (!subcommands || subcommands.includes(l.slice(word.length).trim().split(/\s+/)[0])) return true;
  }
  return false;
}

// The one exception to "README's lines": on a page whose language
// ProjectStore ships templates for, the bind line may end with
// ` --lang <that language>` (the page's start.bind-lang).
const BIND_LINE = /^\/projectstore:bind\b/;
function withoutLangSuffix(line, lang, repo) {
  const suffix = ` --lang ${lang}`;
  return lang && repo.languages.includes(lang) && BIND_LINE.test(line) && line.endsWith(suffix)
    ? line.slice(0, -suffix.length)
    : line;
}

function readmeInstallLines(repo) {
  return new Set(INSTALL_HEADINGS.flatMap((h) => repo.readme.get(h) || []));
}

function checkInstall(page, repo) {
  const out = [];
  const readme = readmeInstallLines(repo);
  const blocks = marked(page, (f) => f === "install");
  for (const el of blocks) {
    if ("data-copy" in el.attrs && el.attrs["data-copy"] !== el.text)
      out.push(
        finding(
          page.file,
          "install",
          `a marked block shows ${JSON.stringify(el.text)} but copies ${JSON.stringify(el.attrs["data-copy"])}`,
        ),
      );
    for (const line of el.text.split("\n").map(cut).filter(Boolean)) {
      const bare = withoutLangSuffix(unprompt(line), page.lang, repo);
      if (!readme.has(bare))
        out.push(
          finding(
            page.file,
            "install",
            `"${line}" is no line README fences under ${INSTALL_HEADINGS.map((h) => `"${h}"`).join(", ")}`,
          ),
        );
    }
  }
  for (const el of page.els) {
    if (blocks.some((b) => within(b, el))) continue;
    const texts = [];
    if ("data-copy" in el.attrs) texts.push(el.attrs["data-copy"]);
    if (el.name === "pre" || el.name === "code") texts.push(el.text);
    for (const line of texts.flatMap((t) => t.split("\n"))) {
      if (installForm(line, repo))
        out.push(
          finding(
            page.file,
            "install",
            `"${cut(line)}" is an install, upgrade or uninstall command outside a block marked data-fact="install"`,
          ),
        );
    }
  }
  return unique(out);
}

// AC 4: a block's data-copy is the lines it shows, each cut at its comment —
// so what lands on the clipboard is what the markers above it were checked on.
function checkCopies(page) {
  const lines = (t) => t.split("\n").map(cut).filter(Boolean);
  return page.els
    .filter((el) => "data-copy" in el.attrs)
    .flatMap((el) => {
      const copied = lines(el.attrs["data-copy"]);
      const shown = lines(el.text);
      const i = copied.findIndex((l, k) => l !== shown[k]);
      if (i === -1 && copied.length === shown.length) return [];
      const at = i === -1 ? Math.min(copied.length, shown.length) : i;
      return [
        finding(
          page.file,
          "copy",
          `#${el.attrs.id || el.name} copies ${JSON.stringify(copied[at] ?? null)} where it shows ${JSON.stringify(shown[at] ?? null)}`,
        ),
      ];
    });
}

// The llms files have no markers: every install command they show is README's.
function checkInstallLines(file, lines, repo) {
  const readme = readmeInstallLines(repo);
  return unique(
    lines
      .filter((l) => installForm(l, repo) && !readme.has(cut(unprompt(l))))
      .map((l) =>
        finding(
          file,
          "install",
          `"${cut(l)}" is no line README fences under ${INSTALL_HEADINGS.map((h) => `"${h}"`).join(", ")}`,
        ),
      ),
  );
}

// AC 4: a --lang or --language value is a language ProjectStore ships
// templates for.
function checkLangFlags(file, texts, repo) {
  const out = [];
  for (const text of texts) {
    for (const m of text.matchAll(/--lang(?:uage)?(?:[ \t]+|=)([^\s"'`<>)\]]+)/g)) {
      for (const code of m[1].replace(/[.,;:]+$/, "").split("|")) {
        if (!repo.languages.includes(code))
          out.push(
            finding(file, "lang", `--lang ${code}: ProjectStore ships templates for ${repo.languages.join(", ")}`),
          );
      }
    }
  }
  return unique(out);
}

// AC 4: the version is package.json's — in its markers, and in no prose and no
// attribute value (a meta description, a title="…"): only a marker is checked
// against package.json, so a version anywhere else would go stale unseen.
const VERSION_WORDS = /\bv(\d+\.\d+\.\d+(?:-[\w.]+)?)\b|\b[Vv]ersion (\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g;
function checkVersion(page, repo) {
  const out = marked(page, (f) => f === "version")
    .filter((el) => el.text.trim().replace(/^v/, "") !== repo.version)
    .map((el) =>
      finding(page.file, "version", `says ${JSON.stringify(el.text.trim())}; package.json is ${repo.version}`),
    );
  let rest = page.markup;
  for (const el of marked(page, (f) => f === "version").sort((a, b) => b.start - a.start))
    rest = rest.slice(0, el.end) + rest.slice(el.end + el.inner.length);
  for (const m of decode(rest.replace(ANY_TAG, " ")).matchAll(VERSION_WORDS)) {
    out.push(finding(page.file, "version", `"${m[0]}" outside a data-fact="version"`));
  }
  for (const el of page.els) {
    for (const [name, value] of Object.entries(el.attrs)) {
      for (const m of value.matchAll(VERSION_WORDS))
        out.push(
          finding(
            page.file,
            "version",
            `"${m[0]}" in the ${name} attribute of <${el.name}>, outside a data-fact="version"`,
          ),
        );
    }
  }
  return unique(out);
}

function checkVersionText(file, text, repo) {
  return unique(
    [...text.matchAll(VERSION_WORDS)]
      .filter((m) => (m[1] ?? m[2]) !== repo.version)
      .map((m) => finding(file, "version", `"${m[0]}"; package.json is ${repo.version}`)),
  );
}

// AC 4: a link into the repository names a path that exists on main, and an
// anchor names a heading of its markdown file (README.md for the root).
const REPO_LINK = new RegExp(`^${escape(REPO_URL)}(?:/(blob|tree)/main/([^?#]+))?/?(?:#(.*))?$`);
function checkRepoLink(file, url, repo) {
  const m = REPO_LINK.exec(url);
  if (!m) return [];
  const rel = m[2] ? decodeURIComponent(m[2]).replace(/\/$/, "") : "README.md";
  if (rel.split("/").includes("..") || !repo.exists(rel)) return [finding(file, "link", `${url}: no ${rel} on main`)];
  if (m[3] && rel.endsWith(".md") && !repo.anchorsOf(rel).includes(m[3]))
    return [finding(file, "link", `${url}: ${rel} has no heading #${m[3]}`)];
  return [];
}
const checkLinks = (page, repo) =>
  unique(page.els.filter((el) => el.attrs.href).flatMap((el) => checkRepoLink(page.file, el.attrs.href, repo)));
const markdownUrls = (md) =>
  [...md.matchAll(/\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![(<])\b(https?:\/\/[^\s)>`'"]+)/g)].map((m) =>
    (m[1] ?? m[2] ?? m[3]).replace(/[.,;:]+$/, ""),
  );
const checkTextLinks = (file, md, repo) => unique(markdownUrls(md).flatMap((u) => checkRepoLink(file, u, repo)));

// AC 4: the counts are the repository's, as digits; the MCP tools listed are
// its tools, each once.
const COUNTS = ["commands", "agents", "languages", "mcp-tools"];
function checkCounts(page, repo) {
  const out = marked(page, (f) => COUNTS.includes(f)).flatMap((el) => {
    const fact = el.attrs["data-fact"];
    const said = el.text.trim();
    return said === String(repo.counts[fact])
      ? []
      : [finding(page.file, fact, `says ${JSON.stringify(said)}; the repository has ${repo.counts[fact]}`)];
  });
  const lists = new Map();
  for (const el of marked(page, (f) => f === "mcp-tool")) {
    const parent = page.els.filter((p) => p !== el && within(p, el) && (p.name === "ul" || p.name === "ol")).at(-1);
    const key = parent ? parent.start : -1;
    if (!lists.has(key)) lists.set(key, []);
    lists.get(key).push(el.text.trim());
  }
  for (const tools of lists.values()) {
    const missing = repo.tools.filter((t) => !tools.includes(t));
    const extra = tools.filter((t, i) => !repo.tools.includes(t) || tools.indexOf(t) !== i);
    if (missing.length || extra.length)
      out.push(
        finding(
          page.file,
          "mcp-tool",
          `the listed tools differ from scripts/mcp.mjs TOOLS: ${[...missing.map((t) => `missing ${t}`), ...extra.map((t) => `not a tool, or twice: ${t}`)].join("; ")}`,
        ),
      );
  }
  return out;
}

// AC 4: a harness's status is the one its manifest gives it.
function checkHarnessStatus(page, repo) {
  return marked(page, (f) => f.startsWith("harness-status:")).flatMap((el) => {
    const fact = el.attrs["data-fact"];
    const id = fact.slice("harness-status:".length);
    const want = repo.status(id);
    const said = el.text.trim();
    if (want === null) return [finding(page.file, fact, `no manifest in harnesses/ has the id ${id}`)];
    return said === want
      ? []
      : [
          finding(
            page.file,
            fact,
            `says ${JSON.stringify(said)}; ${id}'s manifest has verified ${want === "experimental" ? "null" : "set"}, so it is ${want}`,
          ),
        ];
  });
}

// AC 4: a language page is the English page in another language — the same
// element ids, the same markers and marker values, the same fact values, and
// the same copy values once quoted arguments and the page's own slugs and
// session names are masked; install blocks once the permitted suffix goes.
const VALUE_FACTS = (f) => f !== "install";
function pageSlugs(page, repo) {
  const titles = new Map(withAttr(page, "data-title").map((el) => [el.attrs["data-title"], el.text]));
  const slugs = new Set(withAttr(page, "data-slug").map((el) => el.text));
  for (const t of titles.values()) {
    slugs.add(slugify(t));
    slugs.add(repo.derive("story", "session", t));
  }
  return [...slugs].filter((s) => s && s.length > 2).sort((a, b) => b.length - a.length);
}
function maskCopy(value, page, repo) {
  let v = value
    .split("\n")
    .map((l) => withoutLangSuffix(l.trimEnd(), page.lang, repo))
    .join("\n");
  for (const s of pageSlugs(page, repo)) v = v.split(s).join("‹slug›");
  return v.replace(/"[^"]*"/g, '"…"');
}
function checkParity(en, page, repo) {
  const lists = (p) => ({
    ids: p.els.filter((el) => "id" in el.attrs).map((el) => el.attrs.id),
    "data-fact": marked(p).map((el) => el.attrs["data-fact"]),
    "fact values": marked(p, VALUE_FACTS).map((el) => `${el.attrs["data-fact"]}=${el.text.trim()}`),
    install: marked(p, (f) => f === "install").map((el) =>
      el.text
        .split("\n")
        .map((l) => withoutLangSuffix(l, p.lang, repo))
        .join("\n"),
    ),
    "data-source": withAttr(p, "data-source").map((el) => el.attrs["data-source"]),
    "data-title": withAttr(p, "data-title").map((el) => el.attrs["data-title"]),
    "data-slug": withAttr(p, "data-slug").map((el) => el.attrs["data-slug"]),
    "data-template": withAttr(p, "data-template").map((el) => el.attrs["data-template"]),
    "copy values": copyBlocks(p).map((b) => maskCopy(b.value, p, repo)),
  });
  const a = lists(en);
  const b = lists(page);
  const out = [];
  for (const key of Object.keys(a)) {
    const aligned = a[key].length === b[key].length;
    for (let i = 0; i < Math.max(a[key].length, b[key].length); i++) {
      if (a[key][i] === b[key][i]) continue;
      const counts = aligned ? "" : ` (${b[key].length} here, ${a[key].length} there)`;
      out.push(
        finding(
          page.file,
          key,
          `#${i + 1} is ${JSON.stringify(b[key][i] ?? null)}; ${en.file} has ${JSON.stringify(a[key][i] ?? null)}${counts}`,
        ),
      );
      if (!aligned) break;
    }
  }
  return out;
}

// AC 4: the main page's sections are numbered in their labels ("01 /
// Install", …). A changed English label leaves its translations stale with no
// tool to notice — i18n.py check compares the template with en.json only — so
// the numbers are held here: on every page the numbered labels run 01, 02, …
// in page order, as many as on the English page of its kind. An unnumbered
// label (a method page's) is not one.
const sectionNumbers = (page) =>
  page.els
    .filter((el) => hasClass(el, "section-label") && /^\s*\d/.test(el.text))
    .map((el) => (el.text.trim().match(/^(\d{2}) \//) || [])[1] ?? el.text.trim());
function checkSectionNumbers(page, en) {
  const nums = sectionNumbers(page);
  const out = [];
  const bad = nums.findIndex((n, i) => n !== String(i + 1).padStart(2, "0"));
  if (bad >= 0)
    out.push(
      finding(
        page.file,
        "section-number",
        `numbered section #${bad + 1} is labelled ${JSON.stringify(nums[bad])}; the labels run 01, 02, … in page order`,
      ),
    );
  const want = sectionNumbers(en).length;
  if (nums.length !== want)
    out.push(finding(page.file, "section-number", `${nums.length} numbered sections here, ${want} on ${en.file}`));
  return out;
}

// The loop diagram's cartoon (assets/site.js) presses its blocks, svg
// .node[data-step], one by one in document order, and the loop partial writes
// them in the order of the arrows (1 to 8: task, artifact, critic, you,
// planner, implement, reviewer, done). So on every page that carries the loop
// their steps never go down: a block moved or renumbered out of that order
// would be pressed out of turn. A page with no blocks is a finding, not a pass.
function checkPressOrder(page) {
  const svgs = page.els.filter((el) => el.name === "svg");
  const steps = page.els
    .filter((el) => hasClass(el, "node") && "data-step" in el.attrs && svgs.some((svg) => within(svg, el)))
    .map((el) => el.attrs["data-step"]);
  if (!steps.length)
    return [finding(page.file, "press-order", "no svg .node[data-step]: the loop diagram has no blocks to press")];
  // One block per step, 1 to LOOP_STEPS, in the order of the arrows: a block moved, renumbered,
  // repeated or dropped is pressed out of turn or never.
  const i = steps.findIndex((s, k) => s !== String(k + 1));
  if (i !== -1)
    return [
      finding(
        page.file,
        "press-order",
        `block #${i + 1} is step ${steps[i]}, not ${i + 1}: the cartoon presses the blocks in document order, one per step (${steps.join(", ")})`,
      ),
    ];
  return steps.length === LOOP_STEPS
    ? []
    : [finding(page.file, "press-order", `${steps.length} blocks; the loop has ${LOOP_STEPS} steps`)];
}
const LOOP_STEPS = 8;

// A link between pages stays in the page's language. Templates write page links from the
// language root and the build prefixes them by the page's depth below it; files every language
// shares (assets/, llms) take the depth below the site root. A page link that lands on another
// language's page, or on no page at all, is a finding. The language switcher is the one place
// that links other languages, and is skipped.
function checkPageLinks(page, pageDirs) {
  const dir = `/${page.file.slice(`${SITE}/`.length).replace(/index\.html$/, "")}`;
  const own = (pageDirs[page.lang] || []).map((d) => `/${d}`);
  const menus = page.els.filter((el) => hasClass(el, "lang-menu"));
  const out = [];
  for (const el of page.els) {
    if (el.name !== "a" || !("href" in el.attrs) || menus.some((m) => within(m, el))) continue;
    const href = el.attrs.href;
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) continue;
    const path = new URL(href, `https://site.invalid${dir}`).pathname;
    if (path.startsWith("/assets/") || /^\/llms(-full)?\.txt$/.test(path)) {
      if (!existsSync(join(ROOT, SITE, path)))
        out.push(finding(page.file, "page-link", `${href} names no file under site/`));
      continue;
    }
    if (!own.includes(path))
      out.push(finding(page.file, "page-link", `${href} lands on ${path}, which is not a ${page.lang} page`));
  }
  return unique(out);
}
// Every page folder per language, as the build writes them: "" or "de/" plus each kind's slug.
const pageDirsByLang = (langs) =>
  Object.fromEntries(
    langs.map((l) => [l, KINDS.map(({ slug }) => (l === DEFAULT_LANG ? "" : `${l}/`) + (slug ? `${slug}/` : ""))]),
  );

// What each kind of page carries (the story's Technical Notes, "Facts per
// page kind"), so that removing a marker cannot switch a check off:
//   facts      the data-fact markers it holds ("harness-status:*" is every
//              published harness's);
//   templates  the example artifacts it shows (data-template);
//   source     whether a measured figure on it is marked data-source;
//   loop       whether it carries the loop diagram, whose arrow order is held;
//   sections   the main page's section ids in page order, each numbered in its
//              label, 01 to 07; a page without the list numbers none;
//   named      whether its hero, #start and description name every published
//              harness;
//   prose      "no commands": its prose names no ProjectStore command (the
//              main page shows what the user says, not what the agent runs);
//   words      the English page's word budget.
const KIND_RULES = {
  main: {
    facts: ["version", "install", "prompt", "harness-status:*", "commands", "agents", "languages", "mcp-tools"],
    templates: ["adr"],
    source: true,
    loop: true,
    sections: ["start", "talk", "rails", "fits", "disk", "teams", "method"],
    named: true,
    prose: "no commands",
    words: 2300,
  },
  "how-it-works": {
    facts: ["version", "agents", "mcp-tools", "mcp-tool", "harness-status:codex"],
    templates: ["story"],
    loop: true,
    words: 1100,
  },
  "why-it-works": { facts: ["version"], words: 1100 },
  "one-vault": { facts: ["version", "install", "harness-status:codex"], source: true, words: 1100 },
};
const rulesOf = (page) => KIND_RULES[page.kind] ?? {};

// AC 4: a page carries every fact its kind's rules name, the example
// artifacts' data-template among them; and a value fact is a leaf, its text
// the fact.
function checkRequired(page, repo, rules = rulesOf(page)) {
  const have = new Set(marked(page).map((el) => el.attrs["data-fact"]));
  const facts = (rules.facts ?? []).flatMap((f) =>
    f === "harness-status:*" ? repo.harnesses.map((h) => `harness-status:${h.id}`) : [f],
  );
  const out = facts
    .filter((f) => !have.has(f))
    .map((f) => finding(page.file, f, `no element is marked data-fact="${f}", which a ${page.kind} page carries`));
  const templates = new Set(withAttr(page, "data-template").map((el) => el.attrs["data-template"]));
  for (const kind of rules.templates ?? []) {
    if (!templates.has(kind))
      out.push(finding(page.file, `template:${kind}`, `no example is marked data-template="${kind}"`));
  }
  for (const el of marked(page, VALUE_FACTS)) {
    if (!el.leaf)
      out.push(finding(page.file, el.attrs["data-fact"], `a value fact is a leaf; this <${el.name}> holds markup`));
  }
  if (rules.source && !withAttr(page, "data-source").length)
    out.push(finding(page.file, "data-source", "no measured figure is marked data-source"));
  return out;
}

// AC "Seven sections, in order": the main page's sections run in the order
// of the story's table, one numbered label each; a method page numbers none.
function checkSections(page, rules = rulesOf(page)) {
  const out = [];
  const want = rules.sections ?? [];
  const nums = sectionNumbers(page).length;
  if (nums !== want.length)
    out.push(
      finding(page.file, "section-number", `${nums} numbered section labels; a ${page.kind} page has ${want.length}`),
    );
  if (rules.sections) {
    const ids = page.els.filter((el) => el.name === "section").map((el) => el.attrs.id ?? "");
    if (ids.join() !== want.join())
      out.push(finding(page.file, "sections", `the sections run ${ids.join(", ")}; want ${want.join(", ")}`));
  }
  return out;
}

// AC 4: nothing loads from another origin, and everything the site loads is
// a file under site/. A load is a <link>, <script src>, <img src> or srcset,
// <source>, <iframe> or <use href> value, a CSS url() or @import, or a fetch(
// or import( in a script, whose target has a scheme or starts with "//". A
// data: URI is the page's own; an <a href> is navigation. A <link> whose
// every rel fetches nothing (canonical, alternate) is not a load either, but
// it points at the site: relative, or under https://projectstore.dev/.
const LOADS = {
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  iframe: ["src"],
  use: ["href", "xlink:href"],
};
const NON_FETCHING_RELS = new Set(["canonical", "alternate", "author", "help", "license", "next", "prev"]);
const foreign = (url) => {
  const u = url.trim();
  return u.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^data:/i.test(u));
};
const srcset = (value) =>
  value
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);

function cssLoads(css) {
  const out = [];
  const rest = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)[^;]*;?/gi, (m, q1, u1, q2, u2) => {
      out.push(["@import", u1 ?? u2]);
      return "";
    });
  for (const m of rest.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) out.push(["url()", m[2]]);
  return out;
}

function scriptLoads(js) {
  return [...stripComments(js).matchAll(/(?<![\w$.])(fetch|import)\s*\(\s*(?:(["'`])((?:(?!\2)[^\\]|\\.)*)\2)?/g)].map(
    (m) => [`${m[1]}(`, m[3] ?? null],
  );
}

// A target on the site's own origin, as a path under site/ — or null for an
// in-document reference (#id) or a data: URI.
function ownTarget(file, url) {
  const u = url.trim();
  if (!u || u.startsWith("#") || /^data:/i.test(u)) return null;
  const path = u.replace(/[?#].*$/, "");
  if (u.startsWith(ORIGIN)) return posix.join(SITE, path.slice(ORIGIN.length));
  if (path.startsWith("/")) return posix.join(SITE, path);
  return posix.normalize(posix.join(posix.dirname(file), path));
}

// What Pages serves for a path under site/: the file itself, or — for a directory, or a path
// ending in "/" — the directory's index.html. Returns the file it would need when that file is
// not there, else null. A directory with no index.html is not a target.
const SITE_FS = {
  isFile: (rel) => {
    try {
      return statSync(join(ROOT, rel)).isFile();
    } catch {
      return false;
    }
  },
  isDir: (rel) => {
    try {
      return statSync(join(ROOT, rel)).isDirectory();
    } catch {
      return false;
    }
  },
};
function missingTarget(own, fsys) {
  const target = own.endsWith("/") || fsys.isDir(own) ? posix.join(own, "index.html") : own;
  return fsys.isFile(target) ? null : target;
}

function checkLoads(file, text, fsys = SITE_FS) {
  const out = [];
  const add = (what, url) => {
    if (url === null) return out.push(finding(file, "load", `${what} with a target that is not a literal`));
    if (foreign(url)) return out.push(finding(file, "load", `${what} loads ${url}`));
    const own = ownTarget(file, url);
    if (own !== null && !own.startsWith(`${SITE}/`) && own !== SITE)
      out.push(finding(file, "load", `${what} ${url} leaves site/`));
    else if (own !== null && missingTarget(own, fsys))
      out.push(finding(file, "load", `${what} ${url}: no ${missingTarget(own, fsys)}`));
  };
  if (file.endsWith(".css")) {
    for (const [what, url] of cssLoads(text)) add(what, url);
    return unique(out);
  }
  if (file.endsWith(".js")) {
    for (const [what, url] of scriptLoads(text)) add(what, url);
    return unique(out);
  }
  const page = parse(file, text);
  for (const el of page.els) {
    const rels = (el.attrs.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (el.name === "link" && rels.length && rels.every((r) => NON_FETCHING_RELS.has(r))) {
      const href = el.attrs.href || "";
      if (foreign(href) && !href.startsWith(ORIGIN))
        out.push(finding(file, "load", `<link rel="${el.attrs.rel}"> points at ${href}, not under ${ORIGIN}`));
      continue;
    }
    for (const a of LOADS[el.name] || []) {
      if (a in el.attrs)
        for (const url of a === "srcset" ? srcset(el.attrs[a]) : [el.attrs[a]]) add(`<${el.name} ${a}>`, url);
    }
    for (const [a, v] of Object.entries(el.attrs)) {
      if (/url\(|@import/i.test(v)) for (const [what, url] of cssLoads(v)) add(`${what} in <${el.name} ${a}>`, url);
    }
  }
  for (const css of rawBodies(text, "style")) for (const [what, url] of cssLoads(css)) add(`${what} in <style>`, url);
  for (const js of rawBodies(text, "script"))
    for (const [what, url] of scriptLoads(js)) add(`${what} in <script>`, url);
  return unique(out);
}

// AC 4: site/ stays within its budget.
function checkBudget(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  return total > BUDGET
    ? [finding(`${SITE}/`, "budget", `${total} bytes in ${files.length} files; the budget is ${BUDGET}`)]
    : [];
}

// AC 6: a measured figure carries data-source — README.md or a docs/ page and
// the anchor of the passage it comes from — and that heading exists.
function checkSources(page, repo) {
  return withAttr(page, "data-source").flatMap((el) => {
    const v = el.attrs["data-source"];
    const m = /^(README\.md|docs\/[\w./-]+\.md)#(.+)$/.exec(v);
    if (!m || m[1].split("/").includes(".."))
      return [finding(page.file, "data-source", `"${v}" is not README.md or a docs/ page with an anchor`)];
    if (!repo.exists(m[1])) return [finding(page.file, "data-source", `"${v}": no ${m[1]} in the repository`)];
    return repo.anchorsOf(m[1]).includes(m[2])
      ? []
      : [finding(page.file, "data-source", `"${v}": ${m[1]} has no heading #${m[2]}`)];
  });
}

// AC 5: an example artifact (data-template="<kind>") shows the frontmatter
// keys and headings of templates/<lang>/<kind>.md.tmpl — the English ones on
// a page whose language has no templates — and a review_status the product
// writes: pending (the templates) or reviewed (/projectstore:review).
const REVIEW_STATUS = ["pending", "reviewed"];
function checkShapes(page, repo) {
  const out = [];
  for (const el of withAttr(page, "data-template")) {
    const kind = el.attrs["data-template"];
    const tpl = repo.template(page.lang, kind);
    if (!tpl) {
      out.push(finding(page.file, `template:${kind}`, `no template for the kind ${kind}`));
      continue;
    }
    const lines = textOf(el.inner.replace(/<span class="line-number">[^<]*<\/span>/g, ""))
      .split("\n")
      .map((l) => l.trimEnd());
    // The block opens with its frontmatter, as a file the product writes does:
    // a "---" first, a "---" to close it, and between them "key: value" lines
    // (or a YAML list item under one). A block that is not that is reported,
    // not skipped: a check that cannot read the example has not checked it.
    const open = lines.findIndex((l) => l.trim() !== "");
    const close = lines[open]?.trim() === "---" ? lines.findIndex((l, i) => i > open && l.trim() === "---") : -1;
    if (close === -1) {
      out.push(
        finding(
          page.file,
          `template:${kind}`,
          `the example has no frontmatter between "---" lines to check against ${tpl.rel}`,
        ),
      );
      continue;
    }
    const unreadable = lines
      .slice(open + 1, close)
      .find((l) => l.trim() && !/^\s*[a-z_]+:(\s|$)/.test(l) && !/^\s+-\s/.test(l) && !/^\s*-\s/.test(l));
    if (unreadable !== undefined) {
      out.push(
        finding(
          page.file,
          `template:${kind}`,
          `frontmatter line ${JSON.stringify(unreadable.trim())} is not "key: value"`,
        ),
      );
      continue;
    }
    for (const line of lines.slice(open + 1, close)) {
      const m = /^\s*([a-z_]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (!tpl.keys.has(m[1]))
        out.push(finding(page.file, `template:${kind}`, `frontmatter key "${m[1]}" is not in ${tpl.rel}`));
      if (m[1] === "review_status" && !REVIEW_STATUS.includes(m[2].trim()))
        out.push(
          finding(
            page.file,
            `template:${kind}`,
            `review_status: ${m[2].trim()} — the product writes ${REVIEW_STATUS.join(" or ")}`,
          ),
        );
    }
    for (const line of lines.slice(close + 1)) {
      const h = /^\s*## (.+?)\s*$/.exec(line);
      if (h && !tpl.headings.has(h[1]))
        out.push(finding(page.file, `template:${kind}`, `heading "## ${h[1]}" is not one of ${tpl.rel}'s`));
    }
  }
  return unique(out);
}

// AC 5: the product stopped making numbered names on 2026-08-09.
const NUMBERED = /\b(?:ADR-\d+|SPEC-\d+|story-\d+)\b/g;
const checkNumbered = (file, texts) =>
  unique(
    texts.flatMap((t) =>
      [...t.matchAll(NUMBERED)].map((m) =>
        finding(file, "numbered", `"${m[0]}": artifacts are named by slug since 2026-08-09`),
      ),
    ),
  );

// AC 5: every path or session name made from an example title is what the
// core makes of that page's title (data-title → data-slug="<kind>:<form>"),
// a slug never keeps a Cyrillic letter, and no example path goes unmarked.
const EXAMPLE_PATH = /(?<![\w/.-])(?:adr|specs)\/(?!README\.md)[^\s"'<>|\]()`]+\.md|stories\/story-[^\s"'<>|\]()`]+/g;
function checkSlugs(page, repo) {
  const out = [];
  const titles = new Map();
  for (const el of withAttr(page, "data-title")) {
    const kind = el.attrs["data-title"];
    if (titles.has(kind) && titles.get(kind) !== el.text)
      out.push(
        finding(
          page.file,
          `title:${kind}`,
          `the ${kind} title is ${JSON.stringify(el.text)} here and ${JSON.stringify(titles.get(kind))} elsewhere on the page`,
        ),
      );
    else titles.set(kind, el.text);
  }
  for (const el of withAttr(page, "data-slug")) {
    const [kind, form] = el.attrs["data-slug"].split(":");
    const title = titles.get(kind);
    const want = title === undefined ? null : repo.derive(kind, form, title);
    if (title === undefined)
      out.push(
        finding(page.file, `slug:${kind}`, `data-slug="${kind}:${form}" with no data-title="${kind}" on the page`),
      );
    else if (want === null)
      out.push(finding(page.file, `slug:${kind}`, `data-slug="${kind}:${form}" is no form the test knows`));
    else if (el.text !== want)
      out.push(
        finding(
          page.file,
          `slug:${kind}`,
          `shows ${JSON.stringify(el.text)}; slugify makes ${JSON.stringify(want)} of ${JSON.stringify(title)}`,
        ),
      );
  }
  // A title whose slug keeps a Cyrillic letter (і ї є ґ today) makes a mixed-script file
  // name: such a page keeps its example titles in English. Reported once, at the title.
  for (const [kind, title] of titles) {
    if (/[\u0400-\u04ff]/.test(slugify(title)))
      out.push(
        finding(
          page.file,
          `slug:${kind}`,
          `slugify keeps a Cyrillic letter of ${JSON.stringify(title)}; a title it cannot transliterate stays English`,
        ),
      );
  }
  let rest = page.markup;
  for (const el of withAttr(page, "data-slug").sort((a, b) => b.start - a.start))
    rest = rest.slice(0, el.end) + rest.slice(el.end + el.inner.length);
  for (const m of decode(rest.replace(ANY_TAG, "")).matchAll(EXAMPLE_PATH))
    out.push(finding(page.file, "slug", `example path "${m[0]}" is not marked data-slug`));
  return unique(out);
}

// AC 2, the freshness the build would show: each page's ?v= is its asset's
// hash, as tools/i18n.py computes it (asset_versions: SHA-1, eight hex digits),
// behind one "../" per level of the page's depth.
function checkAssetVersions(page, hashes) {
  const out = [];
  for (const [asset, hash] of Object.entries(hashes)) {
    const refs = [...page.html.matchAll(new RegExp(`(?:\\.\\./)*${escape(asset)}(?:\\?v=([0-9a-f]*))?(?=["'])`, "g"))];
    if (!refs.length) out.push(finding(page.file, "asset", `no reference to ${asset}`));
    for (const r of refs)
      if (r[1] !== hash) out.push(finding(page.file, "asset", `${r[0]}: ${asset} hashes to ${hash}`));
  }
  return unique(out);
}

// A page exists exactly when its dictionary and its kind do: every dictionary
// has a page of every kind, and every index.html under site/ is one of those
// pages, the en/ stub aside. A slug renamed, a kind or a language dropped,
// leaves no orphan folder behind for Pages to keep serving.
function checkPageSet(langs, files, isFile) {
  const out = [];
  const want = new Set();
  for (const lang of langs) {
    if (!(lang in LANG_TAGS))
      out.push(finding(`${SITE}/locales/${lang}.json`, "page", `${lang} is not in tools/i18n.py LANGS`));
    for (const { kind, slug } of KINDS) {
      const file = pageFile(lang, slug);
      want.add(file);
      if (!isFile(file)) out.push(finding(file, "page", `site/locales/${lang}.json has no ${kind} page`));
    }
  }
  for (const file of files) {
    if (file === STUB_FILE || want.has(file)) continue;
    const dir = file.slice(SITE.length + 1, -"index.html".length);
    out.push(
      finding(
        file,
        "page",
        `${dir} is no page: not a language with a site/locales/ dictionary, nor a page kind's folder in tools/i18n.py PAGES`,
      ),
    );
  }
  return out;
}

// Every page lists the page of its kind in every language as an alternate,
// x-default the English one, and itself as canonical, all under
// https://projectstore.dev/, with its own tag as <html lang>.
function checkAlternates(page, langs) {
  const out = [];
  const html = page.els.find((el) => el.name === "html");
  if (html?.attrs.lang !== LANG_TAGS[page.lang])
    out.push(finding(page.file, "lang", `<html lang="${html?.attrs.lang}">; ${page.lang} is ${LANG_TAGS[page.lang]}`));
  const links = page.els.filter((el) => el.name === "link");
  const alternates = new Map(
    links
      .filter((el) => el.attrs.rel === "alternate" && el.attrs.hreflang)
      .map((el) => [el.attrs.hreflang, el.attrs.href]),
  );
  const want = new Map([
    ...langs.map((l) => [LANG_TAGS[l], pageUrl(l, page.slug)]),
    ["x-default", pageUrl(DEFAULT_LANG, page.slug)],
  ]);
  for (const [tag, href] of want)
    if (alternates.get(tag) !== href)
      out.push(
        finding(
          page.file,
          "alternate",
          `hreflang="${tag}" is ${JSON.stringify(alternates.get(tag) ?? null)}; want ${href}`,
        ),
      );
  for (const tag of alternates.keys())
    if (!want.has(tag)) out.push(finding(page.file, "alternate", `hreflang="${tag}" names no page`));
  const canon = links.filter((el) => el.attrs.rel === "canonical").map((el) => el.attrs.href);
  const self = pageUrl(page.lang, page.slug);
  if (canon.length !== 1 || canon[0] !== self)
    out.push(finding(page.file, "canonical", `canonical ${JSON.stringify(canon)}; want ${self}`));
  return out;
}

// AC "Install first": the prompt the hero offers is README's, word for word —
// every data-fact="prompt" says the blockquote line under "### In a Claude Code
// session" — so what a reader copies is what README tells them to say.
function checkPrompt(page, repo) {
  return marked(page, (f) => f === "prompt")
    .filter((el) => el.text.trim() !== repo.prompt)
    .map((el) =>
      finding(
        page.file,
        "prompt",
        `says ${JSON.stringify(el.text.trim())}; README's prompt is ${JSON.stringify(repo.prompt)}`,
      ),
    );
}

// AC "Smaller, and it stays smaller": the words a reader sees on a page are
// the whitespace-split tokens of its <body> text — tags, attributes, comments,
// scripts and styles left out, entities decoded, tab panels counted — that
// hold a letter or a digit, so "·", "→" and "—" are not words.
const visibleWords = (page) =>
  bodyText(page)
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
function checkWords(page, budget) {
  const n = visibleWords(page);
  return n > budget
    ? [finding(page.file, "words", `${n} visible words; a ${page.kind} page has a budget of ${budget}`)]
    : [];
}

// AC "Prompts, not commands": the main page shows what the user says, not
// what the agent runs. Outside the blocks marked data-fact="install" (README's
// install and configure lines) and the example files (data-template), its text
// and attribute values hold no invocation in any harness's form and no
// package-runner line of ours.
function checkNoCommands(page, repo) {
  const exempt = page.els.filter((el) => el.attrs["data-fact"] === "install" || "data-template" in el.attrs);
  const outer = exempt.filter((el) => !exempt.some((o) => o !== el && within(o, el)));
  let rest = page.markup;
  for (const el of [...outer].sort((a, b) => b.start - a.start))
    rest = rest.slice(0, el.start) + rest.slice(el.end + el.inner.length);
  const texts = [
    decode(rest.replace(ANY_TAG, " ")),
    ...page.els.filter((el) => !exempt.some((b) => b === el || within(b, el))).flatMap((el) => Object.values(el.attrs)),
  ];
  const out = [];
  const say = (what) =>
    finding(
      page.file,
      "command",
      `${JSON.stringify(cut(what))} outside a block marked data-fact="install" or data-template: the page shows the prompt, not the command`,
    );
  for (const text of texts) {
    for (const p of repo.forms)
      for (const m of text.matchAll(new RegExp(`${p.guard}${escape(p.prefix)}[a-z0-9*<{]`, "g")))
        out.push(say(text.slice(m.index).split(/\s/)[0]));
    for (const m of text.matchAll(/(?<![\w-])(?:npx|bunx|pnpm[ \t]+dlx|deno[ \t]+run)[ \t][^\n]*/g)) {
      const cmd = npxCommand(m[0]);
      if (cmd && /^projectstore(-[a-z0-9]+)*$/.test(packageName(cmd.command))) out.push(say(m[0]));
    }
  }
  return unique(out);
}

// AC "The brand": every page names the link preview in og:image and
// twitter:image, absolute; og:url is its canonical; og:title and
// og:description are its own <title> and description.
function checkPreview(page) {
  const metas = (key, value) =>
    page.els.filter((el) => el.name === "meta" && el.attrs[key] === value).map((el) => el.attrs.content ?? "");
  const one = (list) => (list.length === 1 ? list[0] : null);
  const out = [];
  for (const [key, name] of [
    ["property", "og:image"],
    ["name", "twitter:image"],
  ]) {
    const v = metas(key, name);
    if (one(v) !== PREVIEW_IMAGE)
      out.push(finding(page.file, "preview", `${name} is ${JSON.stringify(v)}; every page names ${PREVIEW_IMAGE}`));
  }
  const canon = page.els.filter((el) => el.name === "link" && el.attrs.rel === "canonical").map((el) => el.attrs.href);
  const url = metas("property", "og:url");
  if (one(url) === null || one(url) !== one(canon))
    out.push(
      finding(page.file, "preview", `og:url is ${JSON.stringify(url)}; the canonical is ${JSON.stringify(canon)}`),
    );
  const own = {
    "og:title": page.els.find((el) => el.name === "title")?.text.trim() ?? "",
    "og:description": one(metas("name", "description")) ?? "",
  };
  for (const [name, want] of Object.entries(own)) {
    const v = metas("property", name);
    if (!want || one(v) !== want)
      out.push(
        finding(page.file, "preview", `${name} is ${JSON.stringify(v)}; the page's own is ${JSON.stringify(want)}`),
      );
  }
  return out;
}

// The size a PNG declares: its 8-byte signature, then the IHDR chunk —
// length, "IHDR", width and height, big-endian. Null for anything else.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR")
    return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
// …and the image they name is a file under site/, a 1280×640 PNG.
function checkPreviewImage(file, buf) {
  if (buf === null) return [finding(file, "preview", `no such file: every page names ${PREVIEW_IMAGE}`)];
  const size = pngSize(buf);
  if (!size) return [finding(file, "preview", "is not a PNG")];
  return size.width === PREVIEW_SIZE.width && size.height === PREVIEW_SIZE.height
    ? []
    : [
        finding(
          file,
          "preview",
          `is ${size.width}×${size.height}; a link preview is ${PREVIEW_SIZE.width}×${PREVIEW_SIZE.height}`,
        ),
      ];
}

// AC "Dark on tokens": a colour is a token. A hex, rgb(), hsl() (or another
// colour function) or a named CSS colour is a literal; transparent and
// currentColor name no colour of the palette.
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
  darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
  ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
  lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
  mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
  orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
  pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
  teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .split(/\s+/)
    .filter(Boolean),
);
function colourLiteral(value) {
  const fn = /#[0-9a-f]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.exec(value);
  if (fn) return fn[0];
  return (
    [...value.matchAll(/(?<![\w#.-])[a-z]+(?![\w(-])/gi)]
      .map((m) => m[0])
      .find((w) => NAMED_COLOURS.has(w.toLowerCase())) ?? null
  );
}

// In a stylesheet, a colour literal appears only inside a :root block (the
// palette) and inside @media print (dark text on white); every other rule
// says var(--…). Strings and comments are blanked first, keeping offsets, so
// a finding names its line.
function checkColourCss(file, css) {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"[^"\n]*"|'[^'\n]*'/g, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  const lineAt = (i) => css.slice(0, i).split("\n").length;
  const walk = (from, to) => {
    let i = from;
    let prelude = from;
    while (i < to) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= to) {
        declarations(prelude, to, "");
        return;
      }
      const head = text.slice(prelude, open).trim();
      let depth = 1;
      let close = open + 1;
      for (; close < to && depth; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
      }
      const inner = [open + 1, close - 1];
      const allowed = head === ":root" || /^@media\s+print\b/i.test(head);
      if (!allowed) {
        if (text.slice(...inner).includes("{")) walk(...inner);
        else declarations(inner[0], inner[1], head);
      }
      i = prelude = close;
    }
  };
  const declarations = (from, to, head) => {
    for (const m of text.slice(from, to).matchAll(/([\w-]+)\s*:([^;]*)/g)) {
      const literal = colourLiteral(m[2]);
      if (literal)
        out.push(
          finding(
            file,
            "colour",
            `line ${lineAt(from + m.index)}: ${head} { ${m[1]}: ${m[2].trim()} } holds ${literal}; a colour outside :root and the print rules is a token`,
          ),
        );
    }
  };
  walk(0, text.length);
  return out;
}

// In a template or a partial, fill=, stroke= and stop-color= say none,
// currentColor, var(--…) or url(#…), and a style= or <style> holds no colour
// literal: a colour is a class or a token. <meta name="theme-color"> is the one
// literal, because a browser reads no custom property there.
const PAINT = /^(?:none|currentcolor|var\(--[\w-]+\)|url\(#[\w-]+\))$/i;
function checkColourAttrs(file, html) {
  const out = [];
  for (const el of parse(file, html).els) {
    if (el.name === "meta" && el.attrs.name === "theme-color") continue;
    for (const a of ["fill", "stroke", "stop-color"])
      if (a in el.attrs && !PAINT.test(el.attrs[a].trim()))
        out.push(finding(file, "colour", `<${el.name} ${a}="${el.attrs[a]}">: a colour is a class or var(--…)`));
    const literal = "style" in el.attrs ? colourLiteral(el.attrs.style) : null;
    if (literal) out.push(finding(file, "colour", `<${el.name} style="${el.attrs.style}"> holds ${literal}`));
  }
  for (const css of rawBodies(html, "style")) out.push(...checkColourCss(file, css));
  return out;
}

// The tones. Midnight is the palette on :root; every other tone is a rule
// :root[data-tone="…"] that points surface tokens at palette tokens :root
// declares. The stylesheet's blocks, nested as written, with comments and
// strings blanked for the brace count; a head keeps its quotes.
function cssBlocks(css) {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"[^"\n]*"|'[^'\n]*'/g, (m) => m.replace(/[^\n]/g, " "));
  const walk = (from, to) => {
    const out = [];
    let i = from;
    while (i < to) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= to) break;
      let depth = 1;
      let close = open + 1;
      for (; close < to && depth; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
      }
      const head = css
        .slice(i, open)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      const body = text.slice(open + 1, close - 1);
      out.push({ head, body, blocks: body.includes("{") ? walk(open + 1, close - 1) : [] });
      i = close;
    }
    return out;
  };
  return walk(0, text.length);
}
const declarations = (body) =>
  Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:([^;]*)/g)].map((m) => [m[1], m[2].trim()]));
// The palette: every top-level block whose selector is exactly :root.
const rootTokens = (blocks) =>
  Object.assign({}, ...blocks.filter((b) => b.head === ":root").map((b) => declarations(b.body)));
// Any at-rule is walked (a tone rule in @supports or @layer is still a tone
// rule); only an @media sets the media the rule sits under.
function toneRules(blocks, media = null) {
  return blocks.flatMap((b) => {
    if (b.head.startsWith("@")) return toneRules(b.blocks, b.head.startsWith("@media") ? b.head : media);
    const tone = /\[data-tone="([a-z]+)"\]/.exec(b.head)?.[1];
    return tone ? [{ tone, head: b.head, media, tokens: declarations(b.body) }] : [];
  });
}
const DEFAULT_TONE = "midnight";
const TONE_KEY = "ps_tone";
// What a tone may change: the surfaces (a role's tint on a panel among them),
// the lines, the header tint and the glow.
const TONE_TOKENS = /^--(?:bg(?:-[0-4]|-pop)?|dot|line-[1-5]|glow-[1-3]|head-bg|(?:accent|check|plan|done)-bg)$/;
const WASHES = ["--accent-bg", "--check-bg", "--plan-bg", "--done-bg"];
// Each tone's tokens, resolved: the palette, with the tone's rule over it.
const toneSets = (css) => {
  const blocks = cssBlocks(css);
  const root = rootTokens(blocks);
  return [[DEFAULT_TONE, root], ...toneRules(blocks).map((r) => [r.tone, { ...root, ...r.tokens }])];
};
function resolveToken(tokens, name) {
  let value = tokens[name];
  for (let i = 0; i < 8 && value; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = tokens[ref[1]];
  }
  return value ?? null;
}
function rgba(value) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value ?? "");
  if (!m) return null;
  const at = (i) => parseInt(m[1].slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

// AC "Still on tokens" and "A translucent terminal window": a tone rule sits
// inside @media screen (in print, :root[data-tone] would out-rank the white
// palette), sets only surface tokens, and points each at a token :root
// declares. In every tone the surfaces that cover the page — the base, the
// menus — are opaque, and the header's tint is at least as dense as d1. The
// switch is hidden until the early script has set data-tone, so a page
// without the script shows none.
function checkTones(file, css) {
  const blocks = cssBlocks(css);
  const root = rootTokens(blocks);
  const out = [];
  for (const r of toneRules(blocks)) {
    if (!/^@media\s+screen\b/i.test(r.media ?? ""))
      out.push(finding(file, "tone", `${r.head} sits outside @media screen; in print it would beat the white palette`));
    for (const [name, value] of Object.entries(r.tokens)) {
      const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      if (!TONE_TOKENS.test(name))
        out.push(
          finding(file, "tone", `${r.head} sets ${name}; a tone changes surfaces, lines, the header tint and the glow`),
        );
      else if (!(name in root) || !ref || !(ref in root))
        out.push(finding(file, "tone", `${r.head} sets ${name}: ${value}; a tone points a declared token at another`));
    }
  }
  for (const [tone, tokens] of toneSets(css)) {
    for (const name of ["--bg", "--bg-pop"]) {
      const c = rgba(resolveToken(tokens, name));
      if (!c || c.a < 1)
        out.push(finding(file, "tone", `${tone} ${name} is ${resolveToken(tokens, name)}; it covers the page: opaque`));
    }
    const head = rgba(resolveToken(tokens, "--head-bg"));
    if (!head || head.a < 0xd1 / 255)
      out.push(finding(file, "tone", `${tone} --head-bg is ${resolveToken(tokens, "--head-bg")}; at least d1 dense`));
  }
  const hides = blocks.some((b) => b.head === ".tone-switch" && /display:\s*none/.test(b.body));
  const shows = blocks.some((b) => /^:root\[data-tone\] \.tone-switch$/.test(b.head) && /display:/.test(b.body));
  if (!hides || !shows)
    out.push(
      finding(
        file,
        "tone",
        ".tone-switch is not hidden until :root[data-tone] shows it; without the script it would show",
      ),
    );
  return out;
}

// AC "Still readable": WCAG contrast against each tone's worst case — every
// glow colour at full strength over the base, the lightest panel over that
// (a chip on the terminal, and a node, plain or in a role's tint, inside a
// diagram, included). --ink to --ink-4 keep 4.5:1; --ink-5, the fine print,
// keeps the ratio it had on black's --bg-4 (#171a15) when black was the
// site's palette. One finding per tone: its worst ink.
const INK5_FLOOR = 3.69;
const luminance = ({ r, g, b }) =>
  [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top, under) => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});
function checkToneContrast(file, css) {
  const out = [];
  for (const [tone, tokens] of toneSets(css)) {
    const colour = (name) => rgba(resolveToken(tokens, name));
    const glows = Object.keys(tokens).filter((n) => /^--glow-\d$/.test(n));
    const lit = glows.map(colour).reduce((under, g) => (g ? over(g, under) : under), colour("--bg"));
    const surfaces = ["--bg-1", "--bg-2", "--bg-3", "--bg-4", "--bg-pop", ...WASHES].map((n) => over(colour(n), lit));
    // a chip on the terminal; a node, plain or in a role's tint, in a diagram or on the rail
    const inPanel = over(colour("--bg-1"), lit);
    surfaces.push(over(colour("--bg-4"), over(colour("--bg-3"), lit)));
    surfaces.push(...["--bg-3", ...WASHES].map((n) => over(colour(n), inPanel)));
    const worst = surfaces.reduce((a, s) => (luminance(s) > luminance(a) ? s : a));
    const short = [
      ...["--ink", "--ink-2", "--ink-3", "--ink-4"].map((n) => [n, contrast(colour(n), worst), 4.5]),
      ["--ink-5", contrast(colour("--ink-5"), worst), INK5_FLOOR],
    ]
      .filter(([, r, floor]) => r < floor)
      .sort((a, b) => a[1] / a[2] - b[1] / b[2]);
    if (short.length) {
      const [name, r, floor] = short[0];
      out.push(
        finding(file, "contrast", `${tone}: ${name} is ${r.toFixed(2)}:1 on its lightest surface; at least ${floor}`),
      );
    }
  }
  return out;
}

// AC "Midnight by default", "One two-way switch" and "Remembered, without a
// flash": a page ships in the default tone — no data-tone on <html>, its
// theme-color the --bg :root declares — and carries the switch, a named
// position per tone with aria-pressed, and in <head>, after the stylesheet,
// the one early script that reads the tone's key and sets data-tone.
function checkTonePage(page, tones, bg) {
  const out = [];
  const html = page.els.find((el) => el.name === "html");
  if (html && "data-tone" in html.attrs)
    out.push(
      finding(page.file, "tone", `<html data-tone="${html.attrs["data-tone"]}">: a page ships in ${DEFAULT_TONE}`),
    );
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "theme-color");
  if ((meta?.attrs.content ?? "").toLowerCase() !== bg.toLowerCase())
    out.push(
      finding(page.file, "theme-color", `theme-color is ${meta?.attrs.content ?? "missing"}; :root --bg is ${bg}`),
    );
  const switches = page.els.filter((el) => hasClass(el, "tone-switch"));
  if (switches.length !== 1)
    out.push(finding(page.file, "tone-switch", `${switches.length} tone switches; the header carries one`));
  else {
    const named = (el) => (el.attrs["aria-label"] ?? "").trim() !== "";
    const positions = page.els.filter((el) => within(switches[0], el) && "data-tone-set" in el.attrs);
    if (!named(switches[0])) out.push(finding(page.file, "tone-switch", "the tone switch has no aria-label"));
    for (const tone of tones) {
      const p = positions.find((el) => el.attrs["data-tone-set"] === tone);
      if (!p) out.push(finding(page.file, "tone-switch", `the tone switch has no position for ${tone}`));
      else if (!named(p) || !("aria-pressed" in p.attrs))
        out.push(finding(page.file, "tone-switch", `the ${tone} position has no aria-label or no aria-pressed`));
    }
  }
  const headEnd = page.html.indexOf("</head>");
  const sheet = page.html.search(/<link rel="stylesheet"/);
  const early = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => m[1].includes(TONE_KEY));
  if (early.length !== 1 || early[0].index > headEnd || early[0].index < sheet)
    out.push(
      finding(
        page.file,
        "tone-script",
        `${early.length} scripts read ${TONE_KEY} in <head> after the stylesheet; one does`,
      ),
    );
  else if (/location\.replace\(/.test(early[0][1]) || !/setAttribute\("data-tone"/.test(early[0][1]))
    out.push(finding(page.file, "tone-script", "the early script redirects, or sets no data-tone"));
  return out;
}

// The key site.js reads and writes is the key the early script reads.
function checkToneKey(file, js, early) {
  const keys = (src, op) => [...src.matchAll(new RegExp(`localStorage\\.${op}\\("([^"]+)"`, "g"))].map((m) => m[1]);
  const read = keys(early, "getItem");
  const used = [...keys(js, "setItem"), ...keys(js, "getItem")];
  if (!used.length) return [finding(file, "tone-key", "site.js keeps no tone in localStorage")];
  return unique(
    used
      .filter((k) => !read.includes(k))
      .map((k) => finding(file, "tone-key", `site.js keeps the tone under "${k}"; the early script reads ${read}`)),
  );
}

// AC "Codex is never overclaimed": a page whose text names an experimental
// harness carries that harness's status marker, so "experimental" stands
// wherever the name does and the status check reads it.
function checkStatusNamed(page, repo) {
  const text = bodyText(page);
  const have = new Set(marked(page).map((el) => el.attrs["data-fact"]));
  return repo.harnesses
    .filter((h) => repo.status(h.id) === "experimental" && text.includes(h.display))
    .filter((h) => !have.has(`harness-status:${h.id}`))
    .map((h) =>
      finding(
        page.file,
        `harness-status:${h.id}`,
        `the page names ${h.display} with no data-fact="harness-status:${h.id}": it is experimental`,
      ),
    );
}

// AC "Method pages": an English page follows a stored language choice to the
// same page in that language. Its redirect script's target, the language code
// t joined to literals, resolves from the page's own address to the page of
// its kind in that language, for every language the script follows — which
// are the other dictionaries. A page in another language redirects nowhere.
function checkRedirect(page, langs) {
  const scripts = rawBodies(page.html, "script").filter((js) => /location\.replace\(/.test(js));
  if (page.lang !== DEFAULT_LANG)
    return scripts.length
      ? [finding(page.file, "redirect", "a page in another language carries the redirect; only English pages follow")]
      : [];
  if (scripts.length !== 1)
    return [finding(page.file, "redirect", `${scripts.length} redirect scripts; an English page has one`)];
  const target = /location\.replace\(((?:'[^']*'|t)(?:\+(?:'[^']*'|t))*)\+\(location\.protocol/.exec(scripts[0]);
  if (!target) return [finding(page.file, "redirect", "the redirect's target is not literals joined to the language")];
  const follows = [...(/var L=\{([^}]*)\}/.exec(scripts[0])?.[1] ?? "").matchAll(/"([a-z]+)":1/g)].map((m) => m[1]);
  const others = langs.filter((l) => l !== DEFAULT_LANG);
  if ([...follows].sort().join() !== [...others].sort().join())
    return [finding(page.file, "redirect", `follows ${follows.join(", ")}; the dictionaries are ${others.join(", ")}`)];
  for (const lang of others) {
    const path = [...target[1].matchAll(/'([^']*)'|t/g)].map((m) => m[1] ?? lang).join("");
    const lands = new URL(path, pageUrl(DEFAULT_LANG, page.slug)).href;
    if (lands !== pageUrl(lang, page.slug))
      return [finding(page.file, "redirect", `a stored "${lang}" lands on ${lands}; want ${pageUrl(lang, page.slug)}`)];
  }
  return [];
}

const checkStub = (text) =>
  text === STUB
    ? []
    : [finding(STUB_FILE, "stub", `is not the redirect tools/i18n.py writes: ${JSON.stringify(text)}`)];

// The llms files carry the facts in a fixed shape: a "Facts about version
// <version>" heading, and under it "- <n> commands", "- <n> bundled agents",
// "- <n> read-only MCP tools: `a`, `b`, …", "- Harnesses: <name> (<status>), …"
// and "Templates ship in <n> languages: <codes>".
function checkLlmsFacts(file, text, repo) {
  const out = [];
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /Facts about version /.test(l));
  if (at === -1) return [finding(file, "version", `no "Facts about version ${repo.version}" heading`)];
  const v = /Facts about version (\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(lines[at])?.[1];
  if (v !== repo.version) out.push(finding(file, "version", `"${lines[at].trim()}"; package.json is ${repo.version}`));
  const end = lines.findIndex((l, i) => i > at && (/^#{1,6} /.test(l) || /^\*\*[^*]+\*\*\s*$/.test(l.trim())));
  const block = lines.slice(at + 1, end === -1 ? undefined : end);
  const one = (re, fact) => {
    const hit = block.map((l) => re.exec(l)).find(Boolean);
    if (!hit) out.push(finding(file, fact, `no line under the facts heading matches ${re}`));
    return hit;
  };
  const cmds = one(/^- (\d+) commands\b/, "commands");
  if (cmds && Number(cmds[1]) !== repo.counts.commands)
    out.push(finding(file, "commands", `${cmds[1]} commands; the repository has ${repo.counts.commands}`));
  const agents = one(/^- (\d+) bundled agents\b/, "agents");
  if (agents && Number(agents[1]) !== repo.counts.agents)
    out.push(finding(file, "agents", `${agents[1]} bundled agents; the repository has ${repo.counts.agents}`));
  const tools = one(/^- (\d+) read-only MCP tools: ((?:`[a-z_]+`(?:, )?)+)/, "mcp-tools");
  if (tools) {
    const listed = [...tools[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    if (Number(tools[1]) !== repo.counts["mcp-tools"])
      out.push(finding(file, "mcp-tools", `${tools[1]} MCP tools; the repository has ${repo.counts["mcp-tools"]}`));
    if ([...listed].sort().join() !== [...repo.tools].sort().join())
      out.push(finding(file, "mcp-tool", `lists ${listed.join(", ")}; scripts/mcp.mjs has ${repo.tools.join(", ")}`));
  }
  const langs = one(/Templates ship in (\d+) languages: ([a-z, ]+)/, "languages");
  if (langs) {
    const codes = langs[2]
      .split(/,\s*/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (Number(langs[1]) !== repo.counts.languages || codes.join() !== repo.languages.join())
      out.push(
        finding(
          file,
          "languages",
          `${langs[1]} languages: ${codes.join(", ")}; templates/ has ${repo.languages.join(", ")}`,
        ),
      );
  }
  const harn = one(/^- Harnesses: (.+)$/, "harnesses");
  if (harn) {
    const said = new Map(
      [...harn[1].matchAll(/([A-Z][\w ]*?) \((supported|experimental)\)/g)].map((m) => [m[1].trim(), m[2]]),
    );
    for (const h of repo.harnesses) {
      if (!said.has(h.display))
        out.push(
          finding(file, `harness:${h.id}`, `the harness line does not name ${h.display}, whose shell is published`),
        );
      else if (said.get(h.display) !== repo.status(h.id))
        out.push(
          finding(
            file,
            `harness-status:${h.id}`,
            `${h.display} (${said.get(h.display)}); its manifest makes it ${repo.status(h.id)}`,
          ),
        );
    }
  }
  return out;
}

// llms.txt links every language's main page and the English method pages
// (agents read English); a link under https://projectstore.dev/ in either file
// resolves to a file under site/ (a directory to its index.html), and no link
// is site-relative.
function checkLlmsLinks(file, text, langs, fsys = SITE_FS) {
  const out = [];
  const urls = markdownUrls(text);
  if (file.endsWith("/llms.txt")) {
    const want = [
      ...langs.map((l) => pageUrl(l)),
      ...KINDS.filter((k) => k.slug).map((k) => pageUrl(DEFAULT_LANG, k.slug)),
    ];
    for (const u of want) if (!urls.includes(u)) out.push(finding(file, "pages", `does not link ${u}`));
  }
  for (const u of urls) {
    if (!u.startsWith(ORIGIN)) continue;
    const missing = missingTarget(ownTarget(file, u), fsys);
    if (missing) out.push(finding(file, "link", `${u}: no ${missing}`));
  }
  for (const m of text.matchAll(/\]\((\/[^)\s]*)\)/g))
    out.push(finding(file, "link", `${m[1]} is site-relative; write ${ORIGIN.slice(0, -1)}${m[1]}`));
  return unique(out);
}

// ─── The real site ─────────────────────────────────────────────────────

const REPO = repository();
const PAGES = sitePages().map((p) => ({
  ...p,
  page: p.html === null ? null : parse(p.file, p.html, p.lang, p.kind),
}));
const LANGS = [...new Set(PAGES.map((p) => p.lang))];
const pageOf = (lang, kind = "main") => PAGES.find((p) => p.lang === lang && p.kind === kind);
// The English page of each kind, the one its translations are held to.
const EN = Object.fromEntries(KINDS.map(({ kind }) => [kind, pageOf(DEFAULT_LANG, kind)]));
const HASHES = Object.fromEntries(
  ["assets/style.css", "assets/site.js"].map((a) => [a, sha8(readFileSync(join(ROOT, SITE, a)))]),
);
// Every index.html Pages would serve, the en/ stub among them.
const PAGE_FILES = siteFiles()
  .map((f) => f.path)
  .filter((p) => p.endsWith("/index.html") && !p.startsWith(`${SITE}/src/`));
// The templates and the partials they include, as the build reads them.
const TEMPLATES = readdirSync(join(ROOT, SITE, "src"))
  .filter((n) => n.endsWith(".html"))
  .sort()
  .map((n) => `${SITE}/src/${n}`);
const PREVIEW_FILE = posix.join(SITE, PREVIEW_IMAGE.slice(ORIGIN.length));
const show = (findings) => findings.map((f) => `${f.page} [${f.fact}] ${f.message}`).join("\n");
const eachPage = (check) => PAGES.filter((p) => p.page).flatMap((p) => check(p.page));
const englishPages = () => PAGES.filter((p) => p.page && p.lang === DEFAULT_LANG);

test("site: the sources the checks read are there — README's three headings, its install lines and its prompt, the published harnesses' manifests, LANGS and PAGES as i18n.py has them", () => {
  for (const h of INSTALL_HEADINGS)
    assert.ok(REPO.readme.has(h), `README has no "${h}" heading, and the install check reads the lines under it`);
  for (const h of INSTALL_HEADINGS) assert.ok(REPO.readme.get(h).length > 0, `README fences lines under "${h}"`);
  assert.ok(REPO.readme.get(INSTALL_HEADINGS[0]).includes("npx projectstore setup"), "the install leads with setup");
  assert.ok(REPO.harnesses.length > 0, "at least one shell is published");
  for (const h of REPO.harnesses) assert.ok(REPO.status(h.id), `${h.id}: a published shell's harness has a manifest`);
  assert.ok(
    REPO.forms.length > 0 && REPO.forms.every((p) => typeof p.guard === "string"),
    "every invocation pattern carries its guard",
  );
  for (const k of ["adr", "spec", "story"]) assert.ok(REPO.template("en", k), `templates/en/${k}.md.tmpl`);
  const py = [...read("site/tools/i18n.py").matchAll(/^\s+\("([a-z]+)", "[^"]+", "([A-Za-z-]+)"\),$/gm)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(Object.fromEntries(py), LANG_TAGS, "the test's copy of LANGS is tools/i18n.py's");
  const pages = [
    ...read("site/tools/i18n.py").matchAll(/^\s+\{"kind": "([a-z-]+)", "src": "([\w.-]+)", "slug": "([a-z-]*)"\},$/gm),
  ].map((m) => ({ kind: m[1], src: m[2], slug: m[3] }));
  assert.deepEqual(pages, KINDS, "the test's copy of PAGES is tools/i18n.py's");
  assert.deepEqual(Object.keys(KIND_RULES).sort(), KINDS.map((k) => k.kind).sort(), "every page kind has its rules");
  for (const { src } of KINDS) assert.ok(TEMPLATES.includes(`${SITE}/src/${src}`), `${SITE}/src/${src}`);
  assert.ok(REPO.prompt, `README has a "> " prompt under "### ${PROMPT_HEADING}"`);
  for (const m of MENU_WORDS.keys())
    assert.ok(
      REPO.uiWords.some((p) => p.word === m),
      `${m} is a ui_vocabulary word`,
    );
  assert.ok(LANGS.length >= 2, "English and at least one other language");
  assert.equal(PAGES.length, LANGS.length * KINDS.length, "a page per dictionary and kind");
});

test("site: the slugger gives GitHub's anchors — the ones README's own links use, the manifest's install link, repeats and fences", () => {
  const links = [...read("README.md").matchAll(/\]\(\.\/(docs\/[\w./-]+\.md)#([^)]+)\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(links.length > 0, "README links into a docs/ heading");
  for (const [rel, a] of links) assert.ok(anchors(read(rel)).includes(a), `${rel}#${a}`);
  const install = new URL(sourceHarness().install.docs);
  assert.ok(anchors(read("README.md")).includes(install.hash.slice(1)), `the manifest's ${install.href}`);
  // Every README link in every manifest's update_hint lands on a heading too:
  // both welcomes linked a dead #updates until the story "User-facing text
  // says where to run and names no project path and no shell" (rule 7 as
  // amended) made it #upgrading.
  const repo = `${install.origin}${install.pathname}#`;
  const hintLinks = [...loadHarnesses().values()].flatMap((m) =>
    [
      m.update_hint?.line || "",
      ...(m.update_hint?.welcome || []),
      ...Object.values(m.update_hint?.by_channel || {}).flatMap((h) => [h.line || "", ...(h.welcome || [])]),
    ].flatMap((t) =>
      String(t)
        .split(/\s+/)
        .filter((w) => w.startsWith(repo))
        .map((w) => [m.id, w.slice(repo.length).replace(/[^\w-]+$/, "")]),
    ),
  );
  assert.ok(hintLinks.length >= 2, `the update hints link README: ${JSON.stringify(hintLinks)}`);
  for (const [id, a] of hintLinks) assert.ok(anchors(read("README.md")).includes(a), `${id}'s update_hint: #${a}`);
  for (const h of INSTALL_HEADINGS) assert.ok(anchors(read("README.md")).includes(slug(h)), h);
  assert.equal(slug("What it costs — measured, not promised"), "what-it-costs--measured-not-promised");
  assert.equal(slug("Surviving `/compact`"), "surviving-compact");
  assert.equal(slug("The epic ↔ code mapping"), "the-epic--code-mapping");
  assert.equal(slug("See [the docs](./docs/x.md) for *more*"), "see-the-docs-for-more");
  assert.deepEqual(anchors("# A\n## A\n```\n# A\n```\n~~~sh\n## A\n~~~\n## A b"), ["a", "a-1", "a-b"]);
});

test("site: a command line is read past a shell prompt, the shell's NAME=value assignments and npx's own options", () => {
  // README's registry-mirror line (the story "User-facing text says where to
  // run and names no project path and no shell", rule 7) is an install form.
  const mirror = "npm_config_registry=https://registry.npmjs.org npx projectstore@<version> setup";
  assert.deepEqual(npxCommand(mirror), { command: "projectstore@<version>", verb: "setup", packages: [] });
  assert.equal(installForm(mirror, REPO), true);
  assert.ok(readmeInstallLines(REPO).has(mirror), "README fences the mirror line under its install headings");
  assert.deepEqual(npxCommand('$ npx -y projectstore-codex@0.29.2 upgrade --project "$PWD"'), {
    command: "projectstore-codex@0.29.2",
    verb: "upgrade",
    packages: [],
  });
  assert.deepEqual(npxCommand("npx --yes -p projectstore-claude@0.28.0-rc.1 projectstore-claude install"), {
    command: "projectstore-claude",
    verb: "install",
    packages: ["projectstore-claude@0.28.0-rc.1"],
  });
  assert.deepEqual(npxCommand("npx --registry https://registry.npmjs.org projectstore-codex@1 install"), {
    command: "projectstore-codex@1",
    verb: "install",
    packages: [],
  });
  assert.equal(installForm("% npx -y projectstore uninstall --harness codex", REPO), true);
  // The other runners the install runbook observed are read as npx is.
  for (const [line, command] of [
    ["bunx projectstore@latest setup", "projectstore@latest"],
    ["pnpm dlx projectstore@latest setup", "projectstore@latest"],
    ["deno run -A npm:projectstore@latest setup", "projectstore@latest"],
  ]) {
    assert.deepEqual(npxCommand(line), { command, verb: "setup", packages: [] }, line);
    assert.equal(installForm(line, REPO), true, line);
  }
  assert.equal(
    installForm("npx projectstore configure --set statusline=on", REPO),
    true,
    "configure is an install form",
  );
  assert.equal(npxCommand("deno run main.ts"), null, "a deno script is no package");
  assert.equal(npxCommand("pnpm install"), null, "pnpm install runs no package");
  assert.equal(npxCommand("bun run build"), null, "bun run is a script");
  assert.equal(npxCommand("deno run -A jsr:@std/x"), null, "a jsr: module is no npm package");
  assert.equal(installForm("deno run -A npm:cowsay hi", REPO), false, "another package's command is no install form");
  assert.equal(installForm("pnpm dlx create-vite", REPO), false);
  assert.equal(installForm("/plugin", REPO), false, "the plugin manager installs nothing");
  assert.equal(installForm("/reload-plugins", REPO), true);
});

test("site AC 1: site/ holds the source as it is served and built, none of its local state, and npm never ships it", () => {
  assert.ok(NOT_SHIPPED.has(SITE), "site is in NOT_SHIPPED (scripts/version-guard.mjs)");
  const files = JSON.parse(read("package.json")).files.map((f) => f.replace(/\/$/, ""));
  assert.ok(!files.includes(SITE), "site/ is not in package.json files: npm would ship it");
  for (const rel of [
    "index.html",
    "en/index.html",
    ...KINDS.map((k) => `src/${k.src}`),
    "tools/i18n.py",
    "llms.txt",
    "llms-full.txt",
    "assets/style.css",
    "assets/site.js",
    "README.md",
  ]) {
    assert.ok(existsSync(join(ROOT, SITE, rel)), `${SITE}/${rel}`);
  }
  for (const l of Object.keys(LANG_TAGS))
    assert.ok(existsSync(join(ROOT, SITE, "locales", `${l}.json`)), `${SITE}/locales/${l}.json`);
  assert.ok(
    siteFiles().some((f) => /^site\/assets\/fonts\/.+\.woff2$/.test(f.path)),
    "the fonts are served from site/assets/fonts/",
  );
  assert.ok(
    siteFiles().some((f) => /^site\/assets\/fonts\/.*(OFL|LICENSE).*\.txt$/i.test(f.path)),
    "with their licence texts",
  );
  assert.deepEqual(
    siteFiles()
      .map((f) => f.path)
      .filter((p) => /\/\.(claude|projectstore)\//.test(p)),
    [],
    "the source folder's local state stays behind",
  );
});

test("site AC 2: the committed pages are the build's — a page per dictionary and kind and no orphan, asset hashes, alternates and canonicals, the en/ stub", () => {
  const found = [
    ...checkPageSet(LANGS, PAGE_FILES, SITE_FS.isFile),
    ...eachPage((p) => [...checkAssetVersions(p, HASHES), ...checkAlternates(p, LANGS)]),
    ...checkStub(read(STUB_FILE)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: every English page follows a stored language choice to the same page in that language; no other page redirects", () => {
  const found = eachPage((p) => checkRedirect(p, LANGS));
  assert.deepEqual(found, [], show(found));
});

test("site: every page names the 1280×640 link preview, absolute, with its canonical as og:url and its own title and description", () => {
  const image = existsSync(join(ROOT, PREVIEW_FILE)) ? readFileSync(join(ROOT, PREVIEW_FILE)) : null;
  const found = [...checkPreviewImage(PREVIEW_FILE, image), ...eachPage(checkPreview)];
  assert.deepEqual(found, [], show(found));
});

test("site AC 3: the main pages name each published harness; no page or llms file calls it a Claude Code plugin", () => {
  const found = [
    ...eachPage((p) => [
      ...(rulesOf(p).named ? checkHarnessesNamed(p, REPO) : []),
      ...checkWording(p.file, readable(p)),
    ]),
    ...LLMS.flatMap((f) => checkWording(f, [read(f)])),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: every page that names an experimental harness marks its status", () => {
  const found = eachPage((p) => checkStatusNamed(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every command and role named, in any harness's form, is a file in commands/ or agents/", () => {
  const found = [
    ...eachPage((p) => checkInvocations(p.file, readable(p), REPO)),
    ...LLMS.flatMap((f) => checkInvocations(f, [read(f)], REPO)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every npx projectstore… names a published package and a verb its bin accepts", () => {
  const found = [
    ...eachPage((p) => checkNpx(p.file, readable(p), REPO)),
    ...LLMS.flatMap((f) => checkNpx(f, [read(f)], REPO)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every install command is README's line, a permitted --lang aside, and none sits outside a marked block", () => {
  const found = [
    ...eachPage((p) => checkInstall(p, REPO)),
    ...LLMS.flatMap((f) => checkInstallLines(f, markdownCode(read(f)), REPO)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: the main page's prose names no ProjectStore command outside the install blocks and the example files", () => {
  const found = eachPage((p) => (rulesOf(p).prose === "no commands" ? checkNoCommands(p, REPO) : []));
  assert.ok(
    PAGES.some((p) => p.page && rulesOf(p.page).prose === "no commands"),
    "the rule holds on some page",
  );
  assert.deepEqual(found, [], show(found));
});

test("site: every prompt the site offers is README's, word for word", () => {
  const found = eachPage((p) => checkPrompt(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every copy button copies the lines its block shows", () => {
  const found = eachPage(checkCopies);
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every --lang value is a language ProjectStore ships templates for", () => {
  const found = [
    ...eachPage((p) => checkLangFlags(p.file, readable(p), REPO)),
    ...LLMS.flatMap((f) => checkLangFlags(f, [read(f)], REPO)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: the version is package.json's", () => {
  const found = [...eachPage((p) => checkVersion(p, REPO)), ...LLMS.flatMap((f) => checkVersionText(f, read(f), REPO))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every link into the repository names a path on main, and its anchor a heading", () => {
  const found = [...eachPage((p) => checkLinks(p, REPO)), ...LLMS.flatMap((f) => checkTextLinks(f, read(f), REPO))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: the counts of commands, agents, languages and MCP tools, and the tools listed, are the repository's", () => {
  const found = eachPage((p) => checkCounts(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: each harness's status is the one its manifest gives it", () => {
  const found = eachPage((p) => checkHarnessStatus(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every language page has its English page's ids, markers, facts, masked copy values and install blocks", () => {
  const found = PAGES.filter((p) => p.lang !== DEFAULT_LANG && p.page).flatMap((p) =>
    checkParity(EN[p.kind].page, p.page, REPO),
  );
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: the main page's sections run start, talk, rails, fits, disk, teams, method, labelled 01 to 07 in every language; a method page numbers none", () => {
  const ids = EN.main.page.els.filter((el) => el.name === "section").map((el) => el.attrs.id);
  assert.deepEqual(ids, ["start", "talk", "rails", "fits", "disk", "teams", "method"]);
  const found = eachPage((p) => [...checkSections(p), ...checkSectionNumbers(p, EN[p.kind].page)]);
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: on every page with the loop diagram its blocks are in arrow order, the order the cartoon presses them in", () => {
  const found = eachPage((p) => (rulesOf(p).loop ? checkPressOrder(p) : []));
  assert.deepEqual(found, [], show(found));
});

test("site: every link between pages stays in the page's language, and every shared file it names exists", () => {
  const dirs = pageDirsByLang(LANGS);
  const found = eachPage((p) => checkPageLinks(p, dirs));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every page carries every fact its kind's checks read, each value fact a leaf", () => {
  const found = eachPage((p) => checkRequired(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site: every English page stays within its word budget", () => {
  const counts = englishPages().map((p) => [p.kind, visibleWords(p.page)]);
  assert.ok(
    counts.every(([, n]) => n > 100),
    `the words are counted: ${JSON.stringify(counts)}`,
  );
  const found = englishPages().flatMap((p) => checkWords(p.page, KIND_RULES[p.kind].words));
  assert.deepEqual(found, [], show(found));
});

test("site: every colour is a token — none outside :root and the print rules in the stylesheet, none in a template's paint or style", () => {
  const found = [
    ...checkColourCss(`${SITE}/assets/style.css`, read(`${SITE}/assets/style.css`)),
    ...TEMPLATES.flatMap((f) => checkColourAttrs(f, read(f))),
  ];
  assert.ok(
    /:root\s*\{[^}]*#[0-9a-f]{3,8}/i.test(read(`${SITE}/assets/style.css`)),
    "the palette is literals on :root",
  );
  assert.deepEqual(found, [], show(found));
});

test("site: the tones — midnight on :root, graphite a screen-only rule over surface tokens, the covering surfaces opaque, and the text readable over each tone's brightest panel and glow", () => {
  const css = read(`${SITE}/assets/style.css`);
  assert.deepEqual(
    toneSets(css).map(([tone]) => tone),
    [DEFAULT_TONE, "graphite"],
    "midnight is the palette, graphite the one tone rule",
  );
  const found = [...checkTones(`${SITE}/assets/style.css`, css), ...checkToneContrast(`${SITE}/assets/style.css`, css)];
  assert.deepEqual(found, [], show(found));
});

test("site: every page ships in midnight — no data-tone, theme-color the :root --bg — with the tone switch in its header and the early script in its head, and site.js keeps the tone under the key that script reads", () => {
  const css = read(`${SITE}/assets/style.css`);
  const tones = toneSets(css).map(([tone]) => tone);
  const bg = rootTokens(cssBlocks(css))["--bg"];
  const found = [
    ...eachPage((page) => checkTonePage(page, tones, bg)),
    ...checkToneKey(`${SITE}/assets/site.js`, read(`${SITE}/assets/site.js`), read(`${SITE}/src/_tone.html`)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: no page, stylesheet or script loads from another origin, and every load is a file under site/", () => {
  const files = siteFiles().filter((f) => /\.(html|css|js)$/.test(f.path) && !f.path.startsWith(`${SITE}/src/`));
  assert.ok(
    files.some((f) => f.path.endsWith(".css")) && files.some((f) => f.path.endsWith(".js")),
    "the stylesheet and the script are read",
  );
  const found = files.flatMap((f) => checkLoads(f.path, read(f.path)));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: site/ stays within its budget", () => {
  const found = checkBudget(siteFiles());
  assert.deepEqual(found, [], show(found));
});

// The prose keys the story "Install, first run, configure, daily work and
// removal read the same in the README, docs, the site in eight languages and
// the in-session texts" (PS-HARNESS) added and the redesigned site keeps: each
// in every dictionary, and translated, not the English copied. Per change, not
// a blanket rule: brand names and code legitimately equal the English in many
// other keys. (start.span.17 and start.span.18 went with the old install
// section's terminals.)
const TRANSLATED = ["start.p.5", "questions.summary.10", "questions.p.11"];
function checkTranslated(keys, en, dicts) {
  const out = [];
  for (const [lang, dict] of Object.entries(dicts))
    for (const k of keys) {
      const file = `site/locales/${lang}.json`;
      if (!(k in dict)) out.push(finding(file, `translation:${k}`, `${k} is missing`));
      else if (dict[k] === en[k]) out.push(finding(file, `translation:${k}`, `${k} is the English text`));
    }
  return out;
}
const dictionaries = () =>
  Object.fromEntries(
    readdirSync(join(SITE, "locales"))
      .filter((n) => n.endsWith(".json") && n !== "en.json")
      .map((n) => [n.replace(/\.json$/, ""), JSON.parse(read(join(SITE, "locales", n)))]),
  );

test("site: the instructions story's keys are translated in all seven other dictionaries; a key set back to English is one finding", () => {
  const en = JSON.parse(read(join(SITE, "locales", "en.json")));
  const dicts = dictionaries();
  assert.equal(Object.keys(dicts).length, 7);
  for (const k of TRANSLATED) assert.ok(k in en, `${k} is still a key of the site`);
  assert.deepEqual(checkTranslated(TRANSLATED, en, dicts), []);
  const planted = { ...dicts, ru: { ...dicts.ru, "start.p.5": en["start.p.5"] } };
  const found = checkTranslated(TRANSLATED, en, planted);
  assert.equal(found.length, 1);
  assert.match(JSON.stringify(found[0]), /site\/locales\/ru\.json.*translation:start\.p\.5/);
});

test("site AC 4: the llms files state the facts in their fixed shape, link every main page and the English method pages, and resolve every link on the site", () => {
  const found = LLMS.flatMap((f) => [...checkLlmsFacts(f, read(f), REPO), ...checkLlmsLinks(f, read(f), LANGS)]);
  assert.deepEqual(found, [], show(found));
});

test("site AC 5: every example artifact has its template's keys and headings, and a review_status the product writes", () => {
  const found = eachPage((p) => checkShapes(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 5: no page or llms file has a numbered name, and every example slug is slugify's", () => {
  const found = [
    ...eachPage((p) => [...checkNumbered(p.file, readable(p)), ...checkSlugs(p, REPO)]),
    ...LLMS.flatMap((f) => checkNumbered(f, [read(f)])),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 6: each measured figure cites a README or docs/ heading that exists", () => {
  const found = eachPage((p) => checkSources(p, REPO));
  assert.deepEqual(found, [], show(found));
});

// ─── Planted: every check, seen to fail ────────────────────────────────
//
// One mutation per check (more where a check fails more than one way), made
// in memory on a copy of a real file, spread across the languages, the page
// kinds, both llms files, the stylesheet, the templates and the stub. Each
// edit must apply — a plant whose anchor has gone fails here rather than
// passing vacuously — and the check must then return exactly one finding,
// naming the expected file and fact. An edit is [from, to] (the first
// occurrence), [from, to, "all"], or [regex, to]. Anchors are markup — ids,
// markers, keys, structure — or a fact read from its source, rather than
// prose: the English is still being written and the translations follow it.

function plant(text, edits) {
  let out = text;
  for (const [from, to, all] of edits) {
    if (from instanceof RegExp) {
      assert.match(out, from, `the plant's anchor ${from} is in the file`);
      from.lastIndex = 0;
      out = out.replace(from, to);
      continue;
    }
    assert.ok(out.includes(from), `the plant's anchor ${JSON.stringify(from)} is in the file`);
    out = all ? out.split(from).join(to) : out.replace(from, () => to);
  }
  assert.notEqual(out, text, "the plant changed the file");
  return out;
}

const STYLE = `${SITE}/assets/style.css`;
const SCRIPT = `${SITE}/assets/site.js`;
const LOOP = `${SITE}/src/_loop.html`;
const SPRITE = `${SITE}/src/_sprite.html`;
const TONE_PARTIAL = `${SITE}/src/_tone.html`;
const [LLMS_TXT, LLMS_FULL] = LLMS;
const onPage = (lang, check, kind = "main") => {
  const p = pageOf(lang, kind);
  assert.ok(p?.html, `site/locales/${lang}.json has a ${kind} page`);
  return { file: p.file, source: p.html, run: (html) => check(parse(p.file, html, p.lang, p.kind)) };
};
const onFile = (file) => ({ file, source: read(file), run: (text) => checkLoads(file, text) });
const onText = (file, check) => ({ file, source: read(file), run: (text) => check(file, text) });
const parity = (lang, kind = "main") => onPage(lang, (p) => checkParity(EN[kind].page, p, REPO), kind);
const section = (open, fn) => [new RegExp(`${escape(open)}[\\s\\S]*?</section>`), fn];
// The first line of the hero's install box, whatever it says.
const INSTALL_LINE = /(<pre id="install-cmd" data-fact="install"[^>]*>)[^<]*</;
// Before </main>: a paragraph a check reads like any other.
const beforeMain = (html) => ["</main>", `${html}</main>`];

// The Ukrainian pages keep the English example titles because slugify cannot
// transliterate і, ї, є, ґ. A Ukrainian story title on How it works, carried
// consistently into every name the core makes from it, is the one finding.
const UK_TITLE = "Транзакційний запис замовлень";
const ukStory = (() => {
  const en = pageOf("uk", "how-it-works")?.page?.els.find((el) => el.attrs["data-title"] === "story")?.text;
  if (!en) return [];
  return [
    [new RegExp(`(data-title="story">)${escape(en)}`, "g"), `$1${UK_TITLE}`],
    [REPO.derive("story", "id", en), REPO.derive("story", "id", UK_TITLE), "all"],
  ];
})();

// The German ADR's slug, as the core makes it of the page's own title: the
// plant below types it without its umlaut.
const DE_ADR_SLUG = (() => {
  const title = pageOf("de")?.page?.els.find((el) => el.attrs["data-title"] === "adr")?.text;
  return title ? REPO.derive("adr", "slug", title) : "";
})();

// The English main page's redirect, which a German page must not carry.
const EN_REDIRECT = /<script>\(function\(\)\{var L=[\s\S]*?<\/script>/.exec(EN.main.html)?.[0] ?? "<script></script>";

// Exactly one word more than the English page's budget.
const overBudget = (kind) => {
  const n = Math.max(KIND_RULES[kind].words - visibleWords(EN[kind].page) + 1, 1);
  return [beforeMain(`<p>${"word ".repeat(n)}</p>`)];
};

const PLANTED = [
  // AC 2: what a stale build would get wrong without changing a word.
  {
    ac: "2",
    what: "a page links its stylesheet under an old hash",
    ...onPage("de", (p) => checkAssetVersions(p, HASHES)),
    fact: "asset",
    message: /assets\/style\.css hashes to/,
    edits: [[/(\.\.\/assets\/style\.css\?v=)[0-9a-f]{8}/, "$100000000"]],
  },
  {
    ac: "2",
    what: "a method page two levels deep links its script under an old hash",
    ...onPage("ru", (p) => checkAssetVersions(p, HASHES), "why-it-works"),
    fact: "asset",
    message: /\.\.\/\.\.\/assets\/site\.js\?v=00000000: assets\/site\.js hashes to/,
    edits: [[/(\.\.\/\.\.\/assets\/site\.js\?v=)[0-9a-f]{8}/, "$100000000"]],
  },
  {
    ac: "2",
    what: "an alternate names a page that is not there",
    ...onPage("zh", (p) => checkAlternates(p, LANGS)),
    fact: "alternate",
    message: /hreflang="uk"/,
    edits: [['hreflang="uk" href="https://projectstore.dev/uk/"', 'hreflang="uk" href="https://projectstore.dev/ua/"']],
  },
  {
    ac: "2",
    what: "a method page's alternate names the language's main page, not the same page",
    ...onPage("zh", (p) => checkAlternates(p, LANGS), "how-it-works"),
    fact: "alternate",
    message:
      /hreflang="fr" is "https:\/\/projectstore\.dev\/fr\/"; want https:\/\/projectstore\.dev\/fr\/how-it-works\//,
    edits: [
      [
        'hreflang="fr" href="https://projectstore.dev/fr/how-it-works/"',
        'hreflang="fr" href="https://projectstore.dev/fr/"',
      ],
    ],
  },
  {
    ac: "2",
    what: "a page loses its language tag",
    ...onPage("pt", (p) => checkAlternates(p, LANGS), "one-vault"),
    fact: "lang",
    message: /pt is pt-BR/,
    edits: [['<html lang="pt-BR">', '<html lang="pt">']],
  },
  {
    ac: "2",
    what: "a canonical built relative, not under the site's origin",
    ...onPage("fr", (p) => checkAlternates(p, LANGS), "why-it-works"),
    fact: "canonical",
    edits: [
      ['<link rel="canonical" href="https://projectstore.dev/fr/why-it-works/">', '<link rel="canonical" href="./">'],
    ],
  },
  {
    ac: "2",
    what: "the en/ stub redirects to the server root",
    file: STUB_FILE,
    source: read(STUB_FILE),
    run: checkStub,
    fact: "stub",
    edits: [['<link rel="canonical" href="../">', '<link rel="canonical" href="/">']],
  },

  // The redirect: an English method page sends a stored choice to the main
  // page; a German page carries the English redirect.
  {
    ac: "Method pages",
    what: "an English method page redirects a stored choice to that language's main page",
    ...onPage("en", (p) => checkRedirect(p, LANGS), "one-vault"),
    fact: "redirect",
    message:
      /a stored "de" lands on https:\/\/projectstore\.dev\/de\/; want https:\/\/projectstore\.dev\/de\/one-vault\//,
    edits: [["'../'+t+'/one-vault/'", "'../'+t+'/'"]],
  },
  {
    ac: "Method pages",
    what: "a German page carries the English redirect",
    ...onPage("de", (p) => checkRedirect(p, LANGS)),
    fact: "redirect",
    message: /only English pages follow/,
    edits: [["</title>", `</title>\n${EN_REDIRECT}`]],
  },

  // The link preview: an image named relative; an og:url left on another page.
  {
    ac: "The brand",
    what: "og:image built relative, which no link-preview service resolves",
    ...onPage("de", checkPreview, "how-it-works"),
    fact: "preview",
    message: /og:image is \["\.\.\/\.\.\/assets\/og\.png"\]/,
    edits: [
      [
        '<meta property="og:image" content="https://projectstore.dev/assets/og.png">',
        '<meta property="og:image" content="../../assets/og.png">',
      ],
    ],
  },
  {
    ac: "The brand",
    what: "og:url names the main page on a method page",
    ...onPage("en", checkPreview, "why-it-works"),
    fact: "preview",
    message: /og:url is \["https:\/\/projectstore\.dev\/"\]; the canonical is/,
    edits: [
      [
        '<meta property="og:url" content="https://projectstore.dev/why-it-works/">',
        '<meta property="og:url" content="https://projectstore.dev/">',
      ],
    ],
  },
  {
    ac: "The brand",
    what: "og:title is not the page's own title",
    ...onPage("es", checkPreview, "one-vault"),
    fact: "preview",
    message: /og:title is \["ProjectStore"\]; the page's own is/,
    edits: [[/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="ProjectStore">']],
  },

  // AC 3: every published harness named; the retired wording stays retired.
  {
    ac: "3",
    what: "the description stops naming Codex",
    ...onPage("de", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harness:codex",
    message: /meta name="description"/,
    edits: [[/<meta name="description" content="[^"]*"/, (m) => m.split("Codex").join("Kodex")]],
  },
  {
    ac: "3",
    what: "the hero, which is the install section, stops naming Codex",
    ...onPage("pt", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harness:codex",
    message: /the hero, which is the install section/,
    edits: [section('<section class="hero" id="start"', (s) => s.split("Codex").join("Kodex"))],
  },
  {
    ac: "3",
    what: 'the hero loses id="start", and the install section with it',
    ...onPage("en", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harnesses",
    message: /the install section is missing/,
    edits: [['<section class="hero" id="start"', '<section class="hero"']],
  },
  {
    ac: "3",
    what: "the Russian description says «плагин для Claude Code» again",
    ...onPage("ru", (p) => checkWording(p.file, readable(p))),
    fact: "wording",
    edits: [[/(<meta name="description" content=")/, "$1ProjectStore — плагин для Claude Code. "]],
  },
  {
    ac: "3",
    what: "llms-full.txt calls it a Claude Code plugin again",
    ...onText(LLMS_FULL, (f, t) => checkWording(f, [t])),
    fact: "wording",
    edits: [[/^/, "ProjectStore is a Claude Code plugin.\n\n"]],
  },
  {
    ac: "Codex is never overclaimed",
    what: "a method page names Codex with no status marker",
    ...onPage("en", (p) => checkStatusNamed(p, REPO), "why-it-works"),
    fact: "harness-status:codex",
    message: /names Codex/,
    edits: [beforeMain("<p>It works the same in Codex.</p>")],
  },

  // AC 4: invocations — every harness's form, a name with no file.
  {
    ac: "4",
    what: "a projectstore: role with no file in agents/",
    ...onPage("en", (p) => checkInvocations(p.file, readable(p), REPO), "how-it-works"),
    fact: "invocation",
    message: /projectstore:auditor/,
    edits: [[/(<span class="role[^"]*">)critic</, "$1projectstore:auditor<"]],
  },
  {
    ac: "4",
    what: "a /projectstore: command with no file in commands/",
    ...onPage("uk", (p) => checkInvocations(p.file, readable(p), REPO), "one-vault"),
    fact: "invocation",
    message: /\/projectstore:find/,
    edits: [["/projectstore:search", "/projectstore:find"]],
  },
  {
    ac: "4",
    what: "a $projectstore- skill with no command or role behind it",
    ...onText(LLMS_FULL, (f, t) => checkInvocations(f, [t], REPO)),
    fact: "invocation",
    message: /\$projectstore-auditor/,
    edits: [[/\$projectstore-critic\b/, "$$projectstore-auditor"]],
  },

  // AC "Prompts, not commands": the main page's prose names no command.
  {
    ac: "Prompts, not commands",
    what: "a slash command in the main page's prose",
    ...onPage("en", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /"\/projectstore:status" outside a block marked/,
    edits: [beforeMain("<p>Then run <code>/projectstore:status</code> to see the board.</p>")],
  },
  {
    ac: "Prompts, not commands",
    what: "an npx projectstore line in the main page's prose",
    ...onPage("fr", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /"npx projectstore doctor --json" outside a block marked/,
    edits: [beforeMain("<p>In CI: <code>npx projectstore doctor --json</code></p>")],
  },
  {
    ac: "Install first",
    what: "the prompt reworded",
    ...onPage("de", (p) => checkPrompt(p, REPO)),
    fact: "prompt",
    message: /README's prompt is/,
    edits: [[/(data-fact="prompt">)[^<]*/, "$1Install ProjectStore for this project."]],
  },

  // AC 4: npx — the verb past npx's own options, the package, a private shell.
  {
    ac: "4",
    what: "npx -y projectstore frobnicate",
    ...onPage("en", (p) => checkNpx(p.file, readable(p), REPO), "one-vault"),
    fact: "npx",
    message: /no verb "frobnicate"/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>npx -y projectstore frobnicate</code>"]],
  },
  {
    ac: "4",
    what: "an npx package that is not published",
    ...onPage("zh", (p) => checkNpx(p.file, readable(p), REPO), "one-vault"),
    fact: "npx",
    message: /projectstore-cursor is not a published package/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>npx projectstore-cursor doctor --json</code>"]],
  },
  {
    ac: "4",
    what: "the private projectstore-opencode named in prose",
    ...onPage("ru", (p) => checkNpx(p.file, readable(p), REPO)),
    fact: "npx",
    message: /projectstore-opencode is not published/,
    edits: [[/(<meta name="description" content=")/, "$1projectstore-opencode — "]],
  },

  // AC 4: install — README's lines, the --lang rule, nothing outside a marked block.
  {
    ac: "4",
    what: "$ npx projectstore@latest upgrade --harness codex in the FAQ, outside a marked block",
    ...onPage("en", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /projectstore@latest upgrade --harness codex" is an install.* outside a block marked/,
    edits: [
      [
        /(<div class="faq" id="questions">)/,
        "$1<p>To upgrade Codex: <code>$ npx projectstore@latest upgrade --harness codex</code> in your project.</p>",
      ],
    ],
  },
  {
    ac: "4",
    what: "a bunx upgrade after a code block, outside a marked block",
    ...onPage("de", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /"bunx projectstore@latest upgrade" is an install.* outside a block marked/,
    edits: [["</pre>", "</pre><p><code>bunx projectstore@latest upgrade</code></p>"]],
  },
  {
    ac: "4",
    what: "npx projectstore configure outside a marked block",
    ...onPage("fr", (p) => checkInstall(p, REPO), "one-vault"),
    fact: "install",
    message: /"npx projectstore configure --set x=y" is an install.* outside a block marked/,
    edits: [["</pre>", "</pre><p><code>npx projectstore configure --set x=y</code></p>"]],
  },
  {
    ac: "4",
    what: "a deno upgrade after a code block, outside a marked block",
    ...onPage("zh", (p) => checkInstall(p, REPO), "how-it-works"),
    fact: "install",
    message: /"deno run -A npm:projectstore@latest upgrade" is an install.* outside a block marked/,
    edits: [["</pre>", "</pre><p><code>deno run -A npm:projectstore@latest upgrade</code></p>"]],
  },
  {
    ac: "4",
    what: "deno run -A npm:projectstore frobnicate",
    ...onPage("en", (p) => checkNpx(p.file, readable(p), REPO), "one-vault"),
    fact: "npx",
    message: /no verb "frobnicate"/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>deno run -A npm:projectstore frobnicate</code>"]],
  },
  {
    ac: "4",
    what: "pnpm dlx projectstore frobnicate",
    ...onPage("en", (p) => checkNpx(p.file, readable(p), REPO), "one-vault"),
    fact: "npx",
    message: /no verb "frobnicate"/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>pnpm dlx projectstore frobnicate</code>"]],
  },
  {
    ac: "4",
    what: "bunx projectstore frobnicate",
    ...onPage("en", (p) => checkNpx(p.file, readable(p), REPO), "one-vault"),
    fact: "npx",
    message: /no verb "frobnicate"/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>bunx projectstore frobnicate</code>"]],
  },
  {
    ac: "4",
    what: "a pnpm dlx uninstall in llms.txt that README does not fence",
    ...onText(LLMS_TXT, (f, t) => checkInstallLines(f, markdownCode(t), REPO)),
    fact: "install",
    message: /pnpm dlx projectstore@latest uninstall --global/,
    edits: [[/^\/plugin install \S+$/m, "$&\npnpm dlx projectstore@latest uninstall --global"]],
  },
  {
    ac: "4",
    what: "a marked install line README does not fence",
    ...onPage("pt", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /"npx projectstore setup --channel npm" is no line README fences/,
    edits: [[INSTALL_LINE, "$1npx projectstore setup --channel npm<"]],
  },
  {
    ac: "4",
    what: "an install block that loses its marker",
    ...onPage("ru", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /"npx projectstore setup" is an install.* outside a block marked/,
    edits: [['<pre id="install-cmd" data-fact="install">', '<pre id="install-cmd">']],
  },
  {
    ac: "4",
    what: "a bind line with another page's --lang",
    ...onPage("es", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /--lang fr" is no line README fences/,
    edits: [[INSTALL_LINE, "$1/projectstore:bind ~/Documents/my-project-vault --lang fr<"]],
  },
  {
    ac: "4",
    what: "a --lang on a page whose language ships no templates",
    ...onPage("uk", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /--lang uk" is no line README fences/,
    edits: [[INSTALL_LINE, "$1/projectstore:bind ~/Documents/my-project-vault --lang uk<"]],
  },
  {
    ac: "4",
    what: "a fenced install line in llms.txt that README does not fence",
    ...onText(LLMS_TXT, (f, t) => checkInstallLines(f, markdownCode(t), REPO)),
    fact: "install",
    message: /--scope user/,
    edits: [[/^(\/plugin install \S+)$/m, "$1 --scope user"]],
  },
  {
    ac: "4",
    what: "a copy button that copies another line than it shows",
    ...onPage("zh", checkCopies),
    fact: "copy",
    message: /#install-cmd copies "npx projectstore@latest setup" where it shows "npx projectstore setup"/,
    edits: [
      [
        '<pre id="install-cmd" data-fact="install">',
        '<pre id="install-cmd" data-fact="install" data-copy="npx projectstore@latest setup">',
      ],
    ],
  },
  {
    ac: "4",
    what: "a --lang ProjectStore ships no templates for",
    ...onPage("de", (p) => checkLangFlags(p.file, readable(p), REPO)),
    fact: "lang",
    message: /--lang it/,
    edits: [[INSTALL_LINE, "$1npx projectstore setup --lang it<"]],
  },
  {
    ac: "4",
    what: "llms-full.txt's bind usage offers a language with no templates",
    ...onText(LLMS_FULL, (f, t) => checkLangFlags(f, [t], REPO)),
    fact: "lang",
    message: /--lang uk/,
    edits: [[/(--lang [a-z]{2}(?:\|[a-z]{2})*)/, "$1|uk"]],
  },

  // AC 4: the version, the links, the counts, the statuses.
  {
    ac: "4",
    what: "the footer says an older version",
    ...onPage("pt", (p) => checkVersion(p, REPO), "why-it-works"),
    fact: "version",
    message: /package\.json is/,
    edits: [[`data-fact="version">v${REPO.version}<`, 'data-fact="version">v0.28.0<']],
  },
  {
    ac: "4",
    what: "a version in the title, outside a marker",
    ...onPage("ru", (p) => checkVersion(p, REPO), "how-it-works"),
    fact: "version",
    message: /outside a data-fact="version"/,
    edits: [[/(<title data-i18n="[^"]+">)/, `$1ProjectStore v${REPO.version} — `]],
  },
  {
    ac: "4",
    what: "a stale version in an attribute value",
    ...onPage("pt", (p) => checkVersion(p, REPO), "one-vault"),
    fact: "version",
    message: /"v0\.28\.0" in the content attribute of <meta>/,
    edits: [[/(<meta name="description" content=")/, "$1ProjectStore v0.28.0: "]],
  },
  {
    ac: "4",
    what: "llms-full.txt names another release",
    ...onText(LLMS_FULL, (f, t) => checkVersionText(f, t, REPO)),
    fact: "version",
    message: /Version 0\.1\.0/,
    edits: [[/$/, "\nVersion 0.1.0.\n"]],
  },
  {
    ac: "4",
    what: "a link to a docs/ heading that does not exist",
    ...onPage("uk", (p) => checkLinks(p, REPO)),
    fact: "link",
    message: /has no heading #kodeks$/,
    edits: [['blob/main/docs/alongside.md"', 'blob/main/docs/alongside.md#kodeks"']],
  },
  {
    ac: "4",
    what: "an llms.txt link to a docs/ page that does not exist",
    ...onText(LLMS_TXT, (f, t) => checkTextLinks(f, t, REPO)),
    fact: "link",
    message: /no docs\/extend\.md/,
    edits: [[/blob\/main\/docs\/[\w-]+\.md/, "blob/main/docs/extend.md"]],
  },
  {
    ac: "4",
    what: "a command count the repository disagrees with",
    ...onPage("zh", (p) => checkCounts(p, REPO)),
    fact: "commands",
    edits: [[/(data-fact="commands">)\d+/, `$1${REPO.counts.commands + 1}`]],
  },
  {
    ac: "4",
    what: "a language count the repository disagrees with",
    ...onPage("uk", (p) => checkCounts(p, REPO)),
    fact: "languages",
    edits: [[/(data-fact="languages">)\d+/, `$1${REPO.counts.languages + 1}`]],
  },
  {
    ac: "4",
    what: "a listed MCP tool that scripts/mcp.mjs does not have",
    ...onPage("ru", (p) => checkCounts(p, REPO), "how-it-works"),
    fact: "mcp-tool",
    message: /missing lineage; not a tool, or twice: history/,
    edits: [['<li data-fact="mcp-tool">lineage</li>', '<li data-fact="mcp-tool">history</li>']],
  },
  {
    ac: "4",
    what: "Codex called supported while its manifest's verified is null",
    ...onPage("de", (p) => checkHarnessStatus(p, REPO), "one-vault"),
    fact: "harness-status:codex",
    edits: [['data-fact="harness-status:codex">experimental<', 'data-fact="harness-status:codex">supported<']],
  },
  {
    ac: "4",
    what: "a status for a harness with no manifest",
    ...onPage("en", (p) => checkHarnessStatus(p, REPO)),
    fact: "harness-status:cursor",
    edits: [['data-fact="harness-status:claude-code"', 'data-fact="harness-status:cursor"']],
  },

  // AC 4: a language page against the English page of its kind.
  {
    ac: "4",
    what: "a language page renames a section id",
    ...parity("ru", "how-it-works"),
    fact: "ids",
    edits: [['id="mechanisms"', 'id="mekhanizmy"']],
  },
  {
    ac: "4",
    what: "a language page translates a status",
    ...parity("ru"),
    fact: "fact values",
    message: /harness-status:codex=экспериментально/,
    edits: [['data-fact="harness-status:codex">experimental<', 'data-fact="harness-status:codex">экспериментально<']],
  },
  {
    ac: "4",
    what: "a language page drops a data-title",
    ...parity("ru", "one-vault"),
    fact: "data-title",
    edits: [[' data-title="story"', ""]],
  },
  {
    ac: "4",
    what: "a language page copies another line",
    ...parity("ru"),
    fact: "copy values",
    message: /npx projectstore setup --json/,
    edits: [
      [
        '<pre id="install-cmd" data-fact="install">',
        '<pre id="install-cmd" data-fact="install" data-copy="npx projectstore setup --json">',
      ],
    ],
  },
  {
    ac: "4",
    what: "a language page cites another passage",
    ...parity("ru", "one-vault"),
    fact: "data-source",
    edits: [
      [
        'data-source="docs/how-it-works.md#sessions-how-parallel-claude-instances-coexist"',
        'data-source="README.md#what-it-costs--measured-not-promised"',
      ],
    ],
  },

  // AC 4: a fact its kind's checks read, unmarked; a value fact that is not a leaf.
  {
    ac: "4",
    what: "the MCP tool count loses its marker on How it works",
    ...onPage("uk", (p) => checkRequired(p, REPO), "how-it-works"),
    fact: "mcp-tools",
    edits: [[' data-fact="mcp-tools"', "", "all"]],
  },
  {
    ac: "4",
    what: "Codex's status loses every marker on the main page",
    ...onPage("de", (p) => checkRequired(p, REPO)),
    fact: "harness-status:codex",
    edits: [[' data-fact="harness-status:codex"', "", "all"]],
  },
  {
    ac: "4",
    what: "every prompt on the page loses its marker",
    ...onPage("en", (p) => checkRequired(p, REPO)),
    fact: "prompt",
    edits: [[' data-fact="prompt"', "", "all"]],
  },
  {
    ac: "4",
    what: "One vault's setup line loses its marker",
    ...onPage("en", (p) => checkRequired(p, REPO), "one-vault"),
    fact: "install",
    edits: [[' data-fact="install"', "", "all"]],
  },
  {
    ac: "4",
    what: "no figure is marked data-source",
    ...onPage("zh", (p) => checkRequired(p, REPO)),
    fact: "data-source",
    edits: [[/ data-source="[^"]*"/g, ""]],
  },
  {
    ac: "4",
    what: "a value fact that holds markup",
    ...onPage("en", (p) => checkRequired(p, REPO), "why-it-works"),
    fact: "version",
    message: /a value fact is a leaf/,
    edits: [[/(data-fact="version">)([^<]*)</, "$1<b>$2</b><"]],
  },
  {
    ac: "4",
    what: "the example story loses its data-template",
    ...onPage("uk", (p) => checkRequired(p, REPO), "how-it-works"),
    fact: "template:story",
    message: /no example is marked data-template="story"/,
    edits: [[' data-template="story"', ""]],
  },

  // AC "Seven sections, in order", and a word budget held.
  {
    ac: "Seven sections, in order",
    what: "a main-page section renamed out of the table's order",
    ...onPage("en", checkSections),
    fact: "sections",
    edits: [['<section class="sec" id="disk"', '<section class="sec" id="files"']],
  },
  {
    ac: "Seven sections, in order",
    what: "a method page gets a numbered label",
    ...onPage("en", checkSections, "how-it-works"),
    fact: "section-number",
    message: /1 numbered section labels; a how-it-works page has 0/,
    edits: [[/(data-i18n="how\.loop\.label">)/, "$101 / "]],
  },
  {
    ac: "Smaller, and it stays smaller",
    what: "the main page one word over its budget",
    ...onPage("en", (p) => checkWords(p, KIND_RULES.main.words)),
    fact: "words",
    message: new RegExp(`^${KIND_RULES.main.words + 1} visible words`),
    edits: overBudget("main"),
  },
  {
    ac: "Smaller, and it stays smaller",
    what: "How it works one word over its budget",
    ...onPage("en", (p) => checkWords(p, KIND_RULES["how-it-works"].words), "how-it-works"),
    fact: "words",
    message: new RegExp(`^${KIND_RULES["how-it-works"].words + 1} visible words`),
    edits: overBudget("how-it-works"),
  },

  // AC "Dark on tokens": a literal in a rule, a named colour, a fill, a style.
  {
    ac: "Dark on tokens",
    what: "a hex colour in a rule outside :root",
    ...onText(STYLE, checkColourCss),
    fact: "colour",
    message: /\.planted \{ color: #ff0000 \} holds #ff0000/,
    edits: [[/$/, "\n.planted { color: #ff0000; }\n"]],
  },
  {
    ac: "Dark on tokens",
    what: "a named colour in a rule inside a media query that is not print",
    ...onText(STYLE, checkColourCss),
    fact: "colour",
    message: /\.planted \{ border: 1px solid white \} holds white/,
    edits: [[/$/, "\n@media (max-width: 760px) {\n  .planted { border: 1px solid white; }\n}\n"]],
  },
  {
    ac: "Dark on tokens",
    what: "a hex fill in the loop partial",
    ...onText(LOOP, checkColourAttrs),
    fact: "colour",
    message: /<rect fill="#ffb347">/,
    edits: [[/<rect class="nb"/, '<rect class="nb" fill="#ffb347"']],
  },
  {
    ac: "Dark on tokens",
    what: "a colour in a style attribute of the sprite",
    ...onText(SPRITE, checkColourAttrs),
    fact: "colour",
    message: /holds red/,
    edits: [[/<svg class="sprite"/, '<svg class="sprite" style="fill: red"']],
  },

  // The tones: midnight on :root, graphite a screen-only rule; opaque covers;
  // readable text; every page in midnight with the switch and the early script.
  {
    ac: "Still on tokens",
    what: "a tone rule outside @media screen",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /:root\[data-tone="graphite"\] sits outside @media screen/,
    edits: [[/$/, '\n:root[data-tone="graphite"] { --bg: var(--graphite-bg); }\n']],
  },
  {
    ac: "Still on tokens",
    what: "a tone rule pointing at a token :root does not declare",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /sets --line-3: var\(--graphite-line-9\)/,
    edits: [["--line-3: var(--graphite-line-3);", "--line-3: var(--graphite-line-9);"]],
  },
  {
    ac: "Still on tokens",
    what: "a tone rule changing the accent",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /sets --accent; a tone changes surfaces/,
    edits: [["--head-bg: var(--graphite-head-bg);", "--head-bg: var(--graphite-head-bg); --accent: var(--plan);"]],
  },
  {
    ac: "A translucent terminal window",
    what: "a menu surface made translucent in midnight",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /midnight --bg-pop is #141f3580; it covers the page/,
    edits: [["--bg-pop: #141f35;", "--bg-pop: #141f3580;"]],
  },
  {
    ac: "One two-way switch",
    what: "the tone switch shown without the early script",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /\.tone-switch is not hidden until :root\[data-tone\] shows it/,
    edits: [[".tone-switch { display: none;", ".tone-switch { display: inline-flex;"]],
  },
  {
    ac: "Still readable",
    what: "a midnight panel light enough to sink --ink-4",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^midnight: --ink-4 is \d\.\d\d:1/,
    edits: [["--bg-4: #17233ad9;", "--bg-4: #33415ad9;"]],
  },
  {
    ac: "Still readable",
    what: "a graphite role tint light enough to sink the text on a node in a diagram",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^graphite: --ink-\d is \d\.\d\d:1/,
    edits: [["--graphite-accent-bg: #252320db;", "--graphite-accent-bg: #4a4235db;"]],
  },
  {
    ac: "Still on tokens",
    what: "a tone rule inside @supports, outside @media screen",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /sits outside @media screen/,
    edits: [[/$/, '\n@supports (color: red) {\n  :root[data-tone="graphite"] { --bg: var(--graphite-bg); }\n}\n']],
  },
  {
    ac: "Midnight by default",
    what: "a page whose theme-color is not the :root --bg",
    ...onPage("pt", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite"], "#080d19"), "one-vault"),
    fact: "theme-color",
    message: /theme-color is #0b0c0a; :root --bg is #080d19/,
    edits: [[/(<meta name="theme-color" content=")[^"]*/, "$1#0b0c0a"]],
  },
  {
    ac: "One two-way switch",
    what: "a switch without its graphite position",
    ...onPage("zh", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite"], "#080d19"), "why-it-works"),
    fact: "tone-switch",
    message: /no position for graphite/,
    edits: [[/<button class="tone-opt" type="button" data-tone-set="graphite"[^>]*>.*?<\/button>/, ""]],
  },
  {
    ac: "Remembered, without a flash",
    what: "a page without the early script",
    ...onPage("de", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite"], "#080d19"), "one-vault"),
    fact: "tone-script",
    message: /0 scripts read ps_tone in <head>/,
    edits: [[/<script>\(function\(\)\{var d=document\.documentElement[\s\S]*?<\/script>\n?/, ""]],
  },
  {
    ac: "Remembered, without a flash",
    what: "site.js keeping the tone under another key",
    ...onText(SCRIPT, (file, js) => checkToneKey(file, js, read(TONE_PARTIAL))),
    fact: "tone-key",
    message: /site\.js keeps the tone under "ps_tones"/,
    edits: [['"ps_tone"', '"ps_tones"', true]],
  },

  // AC 4: loads — another origin, a link off the site, a file that is not there.
  {
    ac: "4",
    what: "a <link> to Google Fonts",
    ...onFile(EN.main.file),
    fact: "load",
    message: /<link href> loads https:\/\/fonts\.googleapis\.com/,
    edits: [
      [
        /<link rel="stylesheet" href="assets\/style\.css\?v=[0-9a-f]{8}">/,
        (m) =>
          `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400..700&amp;display=swap">\n${m}`,
      ],
    ],
  },
  {
    ac: "4",
    what: "a canonical that points off the site",
    ...onFile(pageOf("de").file),
    fact: "load",
    message:
      /<link rel="canonical"> points at https:\/\/projectstore\.example\/de\/, not under https:\/\/projectstore\.dev\//,
    edits: [
      [
        '<link rel="canonical" href="https://projectstore.dev/de/">',
        '<link rel="canonical" href="https://projectstore.example/de/">',
      ],
    ],
  },
  {
    ac: "4",
    what: "a <script src> from a CDN",
    ...onFile(pageOf("zh").file),
    fact: "load",
    message: /<script src> loads https:\/\/cdn/,
    edits: [
      [
        '<script src="../assets/site.js',
        '<script src="https://cdn.example.com/a.js"></script>\n<script src="../assets/site.js',
      ],
    ],
  },
  {
    ac: "4",
    what: "a protocol-relative <img src>",
    ...onFile(pageOf("uk").file),
    fact: "load",
    message: /<img src> loads \/\/cdn/,
    edits: [['src="../assets/mark.svg"', 'src="//cdn.example.com/mark.svg"']],
  },
  {
    ac: "4",
    what: "a stylesheet that is not under site/",
    ...onFile(pageOf("pt").file),
    fact: "load",
    message: /no site\/assets\/styles\.css/,
    edits: [["../assets/style.css?v=", "../assets/styles.css?v="]],
  },
  {
    ac: "4",
    what: "a method page's stylesheet one level short, as if the page sat at its language's root",
    ...onFile(pageOf("pt", "how-it-works").file),
    fact: "load",
    message: /no site\/pt\/assets\/style\.css/,
    edits: [["../../assets/style.css?v=", "../assets/style.css?v="]],
  },
  {
    ac: "4",
    what: "a font the stylesheet names that is not there",
    ...onFile(STYLE),
    fact: "load",
    message: /no site\/assets\/fonts\/onest-latin2\.woff2/,
    edits: [['url("fonts/onest-latin.woff2")', 'url("fonts/onest-latin2.woff2")']],
  },
  {
    ac: "4",
    what: "an @import of Google Fonts in the stylesheet",
    ...onFile(STYLE),
    fact: "load",
    message: /@import loads https:\/\/fonts\.googleapis\.com/,
    edits: [[/^/, '@import url("https://fonts.googleapis.com/css2?family=Onest");\n']],
  },
  {
    ac: "4",
    what: "a fetch( in the script",
    ...onFile(SCRIPT),
    fact: "load",
    message: /fetch\( loads https/,
    edits: [['"use strict";', '"use strict";\n  fetch("https://api.github.com/repos/SmartAndPoint/ProjectStore");']],
  },
  {
    ac: "4",
    what: "an <img src> naming a directory, which serves nothing without its index.html",
    ...onFile(EN.main.file),
    fact: "load",
    message: /no site\/assets\/fonts\/index\.html/,
    edits: [['src="assets/mark.svg"', 'src="assets/fonts"']],
  },

  // AC 4: the llms files' fixed shape and their links.
  {
    ac: "4",
    what: "llms.txt's facts heading names another release",
    ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)),
    fact: "version",
    edits: [[`Facts about version ${REPO.version}`, "Facts about version 0.1.0"]],
  },
  {
    ac: "4",
    what: "llms.txt counts a command too many",
    ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)),
    fact: "commands",
    edits: [[`- ${REPO.counts.commands} commands`, `- ${REPO.counts.commands + 1} commands`]],
  },
  {
    ac: "4",
    what: "llms.txt lists a tool scripts/mcp.mjs does not have",
    ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)),
    fact: "mcp-tool",
    edits: [["`lineage`", "`history`"]],
  },
  {
    ac: "4",
    what: "llms-full.txt calls Codex supported",
    ...onText(LLMS_FULL, (f, t) => checkLlmsFacts(f, t, REPO)),
    fact: "harness-status:codex",
    edits: [[/(^- Harnesses: .*?)Codex \(experimental\)/m, "$1Codex (supported)"]],
  },
  {
    ac: "4",
    what: "llms-full.txt lists a template language that does not ship",
    ...onText(LLMS_FULL, (f, t) => checkLlmsFacts(f, t, REPO)),
    fact: "languages",
    edits: [[/(Templates ship in \d+ languages: [a-z, ]*?)zh/, "$1uk, zh"]],
  },
  {
    ac: "4",
    what: "llms.txt stops linking a language's main page",
    ...onText(LLMS_TXT, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "pages",
    message: /https:\/\/projectstore\.dev\/zh\//,
    edits: [[/^.*\(https:\/\/projectstore\.dev\/zh\/\).*\n/m, ""]],
  },
  {
    // The method links are appended first, so the plant holds whether or not
    // the file links them yet; then every link to How it works goes.
    ac: "4",
    what: "llms.txt stops linking an English method page",
    ...onText(LLMS_TXT, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "pages",
    message: /does not link https:\/\/projectstore\.dev\/how-it-works\/$/,
    edits: [
      [
        /$/,
        KINDS.filter((k) => k.slug)
          .map((k) => `\n- [${k.kind}](${pageUrl(DEFAULT_LANG, k.slug)})`)
          .join(""),
      ],
      [pageUrl(DEFAULT_LANG, "how-it-works"), ORIGIN, "all"],
    ],
  },
  {
    ac: "4",
    what: "llms-full.txt links a file the site does not serve",
    ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "link",
    message: /no site\/llms-short\.txt/,
    edits: [[/$/, "\nThe short version: https://projectstore.dev/llms-short.txt\n"]],
  },
  {
    ac: "4",
    what: "llms-full.txt links a page site-relative",
    ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "link",
    message: /\/ru\/ is site-relative/,
    edits: [[/$/, "\nAlso [in Russian](/ru/).\n"]],
  },
  {
    ac: "4",
    what: "llms-full.txt links a directory with no index.html",
    ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "link",
    message: /https:\/\/projectstore\.dev\/assets: no site\/assets\/index\.html/,
    edits: [[/$/, "\nThe assets: https://projectstore.dev/assets\n"]],
  },

  // AC 5: an example's shape, a numbered name, a slug slugify would not make.
  {
    ac: "5",
    what: "a review_status the product never writes",
    ...onPage("pt", (p) => checkShapes(p, REPO)),
    fact: "template:adr",
    message: /review_status: approved/,
    edits: [["<span>review_status: reviewed</span>", "<span>review_status: approved</span>"]],
  },
  {
    ac: "5",
    what: "a heading the Chinese ADR template does not have",
    ...onPage("zh", (p) => checkShapes(p, REPO)),
    fact: "template:adr",
    message: /## 上下文/,
    edits: [["<span>## 背景</span>", "<span>## 上下文</span>"]],
  },
  {
    ac: "5",
    what: "a frontmatter key the English story template does not have, on a page with no templates of its own",
    ...onPage("uk", (p) => checkShapes(p, REPO), "how-it-works"),
    fact: "template:story",
    message: /"state" is not in templates\/en\/story\.md\.tmpl/,
    edits: [['<span class="k">status:</span>', '<span class="k">state:</span>']],
  },
  {
    ac: "5",
    what: "an example whose frontmatter never closes",
    ...onPage("es", (p) => checkShapes(p, REPO)),
    fact: "template:adr",
    message: /no frontmatter between "---" lines/,
    edits: [[/(data-template="adr"[\s\S]*?<span>---<\/span>[\s\S]*?)<span>---<\/span>/, "$1<span>- - -</span>"]],
  },
  {
    ac: "5",
    what: "a frontmatter line that is not key: value",
    ...onPage("fr", (p) => checkShapes(p, REPO)),
    fact: "template:adr",
    message: /frontmatter line "status accepted" is not "key: value"/,
    edits: [["<span>status: accepted</span>", "<span>status accepted</span>"]],
  },
  {
    ac: "5",
    what: "a numbered ADR in the title",
    ...onPage("zh", (p) => checkNumbered(p.file, readable(p)), "why-it-works"),
    fact: "numbered",
    message: /ADR-007/,
    edits: [[/(<title data-i18n="[^"]+">)/, "$1ProjectStore ADR-007 — "]],
  },
  {
    ac: "5",
    what: "a numbered story in llms-full.txt",
    ...onText(LLMS_FULL, (f, t) => checkNumbered(f, [t])),
    fact: "numbered",
    message: /story-003/,
    edits: [[/(\/projectstore:story plan [\w-]+\/)story-[a-z0-9-]+/, "$1story-003"]],
  },
  {
    ac: "5",
    what: "a German slug typed without its umlaut",
    ...onPage("de", (p) => checkSlugs(p, REPO)),
    fact: "slug:adr",
    message: new RegExp(`slugify makes "${escape(DE_ADR_SLUG)}"`),
    edits: [[`data-slug="adr:slug">${DE_ADR_SLUG}<`, `data-slug="adr:slug">${DE_ADR_SLUG.replace(/ä/g, "a")}<`]],
  },
  {
    ac: "5",
    what: "a title that differs within the page",
    ...onPage("ru", (p) => checkSlugs(p, REPO), "one-vault"),
    fact: "title:story",
    edits: [[/(<span data-title="story">[^<]*<\/span>)/, '$1 <span data-title="story">Запись заказов</span>']],
  },
  {
    ac: "5",
    what: "a Ukrainian story title, which slugify leaves Cyrillic",
    ...onPage("uk", (p) => checkSlugs(p, REPO), "how-it-works"),
    fact: "slug:story",
    message: /keeps a Cyrillic letter/,
    edits: ukStory,
  },
  {
    ac: "5",
    what: "an example path with no data-slug",
    ...onPage("en", (p) => checkSlugs(p, REPO)),
    fact: "slug",
    message: /example path "adr\/[^"]+\.md" is not marked/,
    edits: [['<span data-slug="adr:path">', "<span>"]],
  },

  // AC 4: a translation keeps a section's old number after the English one moved.
  {
    ac: "4",
    what: "a translated section label keeps its old number",
    ...onPage("de", (p) => checkSectionNumbers(p, EN.main.page)),
    fact: "section-number",
    message: /#3 is labelled "02"/,
    edits: [[/(data-i18n="rails\.label">)\d\d/, "$102"]],
  },

  // AC 4: a loop block out of arrow order, which the cartoon would press out of turn; no blocks at all.
  {
    ac: "4",
    what: "the artifact block numbered step 4, ahead of the critic",
    ...onPage("fr", checkPressOrder, "how-it-works"),
    fact: "press-order",
    message: /block #2 is step 4, not 2/,
    edits: [['<g class="node" data-step="2">', '<g class="node" data-step="4">']],
  },
  {
    ac: "4",
    what: "the done block dropped from the loop",
    ...onPage("de", checkPressOrder),
    fact: "press-order",
    message: /7 blocks; the loop has 8 steps/,
    edits: [[/<g class="node" data-step="8">[\s\S]*?<\/g>/, ""]],
  },
  {
    ac: "4",
    what: "a Russian page links the English How it works",
    ...onPage("ru", (p) => checkPageLinks(p, pageDirsByLang(LANGS))),
    fact: "page-link",
    message: /lands on \/how-it-works\/, which is not a ru page/,
    edits: [['href="how-it-works/"', 'href="../how-it-works/"']],
  },
  {
    ac: "4",
    what: "the loop diagram's blocks lose their class",
    ...onPage("es", checkPressOrder),
    fact: "press-order",
    message: /no svg \.node\[data-step\]/,
    edits: [['<g class="node" data-step=', '<g class="step" data-step=', "all"]],
  },

  // AC 6: a citation that resolves to nothing, or to the wrong kind of file.
  {
    ac: "6",
    what: "a figure cites a docs/ heading that does not exist",
    ...onPage("pt", (p) => checkSources(p, REPO), "one-vault"),
    fact: "data-source",
    message: /has no heading #sessions$/,
    edits: [
      [
        'data-source="docs/how-it-works.md#sessions-how-parallel-claude-instances-coexist"',
        'data-source="docs/how-it-works.md#sessions"',
      ],
    ],
  },
  {
    ac: "6",
    what: "a figure cites a file outside README and docs/",
    ...onPage("en", (p) => checkSources(p, REPO), "one-vault"),
    fact: "data-source",
    message: /is not README\.md or a docs\/ page/,
    edits: [
      [
        'data-source="docs/how-it-works.md#naming-a-session-after-the-work-it-settled-on"',
        'data-source="scripts/touch-session.mjs#naming"',
      ],
    ],
  },
];

for (const c of PLANTED) {
  test(`site AC ${c.ac}, planted: ${c.what} (${c.file})`, () => {
    assert.ok(c.edits.length > 0, "the plant has edits");
    const found = c.run(plant(c.source, c.edits));
    assert.equal(found.length, 1, `exactly one finding, got:\n${show(found) || "none"}`);
    assert.equal(found[0].page, c.file, show(found));
    assert.equal(found[0].fact, c.fact, show(found));
    if (c.message) assert.match(found[0].message, c.message);
  });
}

test("site AC 2, planted: a dictionary with no page, a missing method page, a page with no dictionary, an orphan folder", () => {
  const cases = [
    [
      checkPageSet(LANGS, PAGE_FILES, (rel) => rel !== `${SITE}/pt/index.html` && SITE_FS.isFile(rel)),
      `${SITE}/pt/index.html`,
    ],
    [
      checkPageSet(LANGS, PAGE_FILES, (rel) => rel !== `${SITE}/pt/how-it-works/index.html` && SITE_FS.isFile(rel)),
      `${SITE}/pt/how-it-works/index.html`,
    ],
    [checkPageSet(LANGS, [...PAGE_FILES, `${SITE}/it/index.html`], SITE_FS.isFile), `${SITE}/it/index.html`],
    [
      checkPageSet(LANGS, [...PAGE_FILES, `${SITE}/de/pricing/index.html`], SITE_FS.isFile),
      `${SITE}/de/pricing/index.html`,
    ],
    [
      checkPageSet(LANGS, [...PAGE_FILES, `${SITE}/en/how-it-works/index.html`], SITE_FS.isFile),
      `${SITE}/en/how-it-works/index.html`,
    ],
  ];
  for (const [found, file] of cases)
    assert.deepEqual(
      found.map((f) => [f.page, f.fact]),
      [[file, "page"]],
      show(found),
    );
});

test("site, planted: a link preview that is not 1280×640, or not a PNG, or not there, fails", () => {
  const real = readFileSync(join(ROOT, PREVIEW_FILE));
  assert.deepEqual(pngSize(real), PREVIEW_SIZE, "the real image is 1280×640");
  const wide = Buffer.from(real);
  wide.writeUInt32BE(1200, 16);
  for (const [buf, message] of [
    [wide, /is 1200×640; a link preview is 1280×640/],
    [Buffer.from("GIF89a, not a PNG at all"), /is not a PNG/],
    [null, /no such file/],
  ]) {
    const found = checkPreviewImage(PREVIEW_FILE, buf);
    assert.equal(found.length, 1, show(found));
    assert.equal(found[0].fact, "preview");
    assert.match(found[0].message, message);
  }
});

test("site: the near misses pass — a bind line with the page's own --lang, a colour inside the print rules, a token in a fill", () => {
  const es = pageOf("es");
  const bind = plant(es.html, [[INSTALL_LINE, "$1/projectstore:bind ~/Documents/my-project-vault --lang es<"]]);
  assert.deepEqual(checkInstall(parse(es.file, bind, "es", "main"), REPO), [], "es ships templates");
  const css = read(STYLE);
  assert.deepEqual(checkColourCss(STYLE, `${css}\n@media print { .x { color: #000000; } }\n`), []);
  assert.deepEqual(checkColourCss(STYLE, `${css}\n.x { color: var(--ink); background: transparent; }\n`), []);
  assert.deepEqual(
    checkColourAttrs(LOOP, '<svg><rect fill="var(--accent)"/><path stroke="currentColor"/><use fill="url(#m)"/></svg>'),
    [],
  );
  assert.deepEqual(
    checkColourAttrs(LOOP, '<meta name="theme-color" content="#0b0c0a">'),
    [],
    "theme-color is a literal",
  );
});

test("site AC 4: a canonical or alternate under https://projectstore.dev/, or a relative one, is no load", () => {
  const de = pageOf("de");
  assert.ok(
    de.html.includes('<link rel="canonical" href="https://projectstore.dev/de/">'),
    "the built page's canonical is absolute",
  );
  assert.ok(
    de.html.includes('<link rel="alternate" hreflang="x-default" href="https://projectstore.dev/">'),
    "and so are its alternates",
  );
  assert.deepEqual(checkLoads(de.file, de.html), [], "an absolute canonical under the site's origin is not a finding");
  const relative = plant(de.html, [
    ['<link rel="canonical" href="https://projectstore.dev/de/">', '<link rel="canonical" href="./">'],
  ]);
  assert.deepEqual(checkLoads(de.file, relative), [], "nor is a relative one");
});

test("site AC 4, planted: one byte over the budget fails; the budget itself does not", () => {
  const files = siteFiles();
  const total = files.reduce((n, f) => n + f.size, 0);
  assert.deepEqual(
    checkBudget([...files, { path: `${SITE}/planted.bin`, size: BUDGET - total }]),
    [],
    "exactly the budget passes",
  );
  const found = checkBudget([...files, { path: `${SITE}/planted.bin`, size: BUDGET - total + 1 }]);
  assert.equal(found.length, 1, show(found));
  assert.equal(found[0].page, `${SITE}/`);
  assert.equal(found[0].fact, "budget");
});

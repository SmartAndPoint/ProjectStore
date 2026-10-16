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
import { runInNewContext } from "node:vm";
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
// `langs`: a kind built in those languages only (the privacy page, English
// for now, linked from every page at the site root).
const KINDS = [
  { kind: "main", src: "index.html", slug: "" },
  { kind: "how-it-works", src: "how-it-works.html", slug: "how-it-works" },
  { kind: "why-it-works", src: "why-it-works.html", slug: "why-it-works" },
  { kind: "one-vault", src: "one-vault.html", slug: "one-vault" },
  { kind: "privacy", src: "privacy.html", slug: "privacy", langs: ["en"] },
];
const slugOf = (kind) => KINDS.find((k) => k.kind === kind)?.slug ?? null;
// The languages a kind is built in, of the dictionaries `langs`; and whether
// a kind is built in one language only, which lists itself as its only
// alternate, shows no switcher and never redirects.
const kindLangs = (k, langs) => (k.langs ? langs.filter((l) => k.langs.includes(l)) : langs);
const kindOf = (kind) => KINDS.find((k) => k.kind === kind);
const singleLanguage = (kind) => Boolean(kindOf(kind)?.langs && kindOf(kind).langs.length === 1);
// The folders of the single-language kinds: shared by every language, at the
// site root (tools/i18n.py SHARED_PAGES).
const SHARED_PAGE_DIRS = KINDS.filter((k) => k.langs && k.slug).map((k) => `/${k.slug}/`);
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
    KINDS.filter((k) => kindLangs(k, langs).includes(lang)).map(({ kind, slug }) => {
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

// The four-agents story: the site names four agents, in this order, as plain
// names, and carries no harness status. The names live here alone, so a
// rename is one edit (and one in the markup, and one re-render of the card).
const AGENTS = ["Claude Code", "Codex", "Gemini CLI", "Cursor"];
// Each language's stem for "experimental", as the dictionaries spell it.
const EXPERIMENTAL = {
  en: "experimental",
  de: "experimentell",
  es: "experimental",
  fr: "expérimental",
  pt: "experimental",
  ru: "экспериментальн",
  uk: "експериментальн",
  zh: "实验性",
};
// AC "Four agents named": the hero's agent line is the four names alone, each
// in a b with no data-i18n, between middle dots; the terminal box has the same
// four chips, each with the class chip alone.
function checkAgents(page) {
  const out = [];
  const line = page.els.find((el) => hasClass(el, "cta-sub") && page.els.some((b) => b.name === "b" && within(el, b)));
  const names = line ? page.els.filter((el) => el.name === "b" && within(line, el)) : [];
  const said = names.map((b) => b.text.trim());
  if (said.join("|") !== AGENTS.join("|") || names.some((b) => "data-i18n" in b.attrs))
    out.push(
      finding(
        page.file,
        "agents-named",
        `the hero names ${said.join(", ") || "no agent"}; it names ${AGENTS.join(", ")}`,
      ),
    );
  const read = line ? line.text.replace(/\s+/g, " ").trim() : "";
  if (line && said.join("|") === AGENTS.join("|") && read !== AGENTS.join(" · "))
    out.push(finding(page.file, "agents-named", `the hero's agent line reads "${read}"; it is the four names alone`));
  const box = page.els.find((el) => hasClass(el, "chips"));
  const chips = box ? page.els.filter((el) => within(box, el) && hasClass(el, "chip")) : [];
  const chipped = chips.map((c) => c.text.trim());
  if (chipped.join("|") !== AGENTS.join("|") || chips.some((c) => c.attrs.class.trim() !== "chip"))
    out.push(
      finding(
        page.file,
        "agents-named",
        `the chips are ${chips.map((c) => `${c.text.trim()} (class "${c.attrs.class}")`).join(", ") || "missing"}; they are the four names, class "chip"`,
      ),
    );
  return out;
}
// AC "The link": the header's top row links to the source with GitHub's mark
// and its name, a name no dictionary translates (the mark is decoration, the
// name is the link's), and the Star button it replaced is gone from every page.
const SOURCE_NAME = "GitHub";
function checkSourceLink(page) {
  const out = [];
  const say = (message) => out.push(finding(page.file, "source-link", message));
  const row = page.els.find((el) => hasClass(el, "head-row"));
  const links = row ? page.els.filter((el) => el.name === "a" && within(row, el) && hasClass(el, "gh")) : [];
  if (links.length !== 1) say(`the header's top row holds ${links.length} a.gh; it holds one`);
  for (const a of links) {
    if (a.attrs.href !== REPO_URL) say(`the GitHub link goes to ${a.attrs.href}; it goes to ${REPO_URL}`);
    const inside = page.els.filter((el) => within(a, el));
    const marks = inside.filter((el) => el.name === "svg");
    if (marks.length !== 1 || marks[0].attrs["aria-hidden"] !== "true" || marks[0].attrs.focusable !== "false")
      say('the GitHub link\'s mark is not one svg with aria-hidden="true" and focusable="false"');
    const read = a.text.trim();
    if (read !== SOURCE_NAME || a.attrs["aria-label"] !== SOURCE_NAME)
      say(`the GitHub link reads "${read}" (aria-label "${a.attrs["aria-label"] ?? ""}"); it reads ${SOURCE_NAME}`);
    if (inside.some((el) => "data-i18n" in el.attrs || "data-i18n-attr" in el.attrs))
      say(`the GitHub link carries data-i18n or data-i18n-attr; ${SOURCE_NAME} is a name no dictionary translates`);
  }
  if (page.els.some((el) => hasClass(el, "star"))) say("a page still has the Star button (class star)");
  return out;
}
// AC "Out of the way": at 760 px and narrower the name hides and the mark
// stays, as the header's row is tight there; print hides the header, and the
// link with it, so the print list names neither the link nor the old button.
const SOURCE_NARROW = "@media (max-width: 760px)";
function checkSourceLinkCss(file, css) {
  const rules = cssRules(css);
  const heads = (r) => r.head.split(",").map((h) => h.trim());
  const out = [];
  if (!rules.some((r) => r.media === SOURCE_NARROW && heads(r).includes(".gh span") && /display:\s*none/.test(r.body)))
    out.push(
      finding(
        file,
        "source-link",
        `the GitHub link's word shows on a phone: no .gh span hidden under ${SOURCE_NARROW}`,
      ),
    );
  const gone = rules.filter(
    (r) =>
      r.media !== "@media print" &&
      heads(r).some((h) => /(?:^|[\s>])(?:a)?\.gh(?:\s*>?\s*svg)?$/.test(h)) &&
      /display:\s*none/.test(r.body),
  );
  if (gone.length)
    out.push(
      finding(
        file,
        "source-link",
        `the GitHub link's mark hides under ${gone.map((r) => r.media ?? "no media query").join(", ")}`,
      ),
    );
  const print = rules.filter((r) => r.media === "@media print" && /display:\s*none/.test(r.body));
  if (!print.some((r) => heads(r).includes(".site-header")))
    out.push(
      finding(file, "source-link", "print does not hide the header (.site-header), and the GitHub link with it"),
    );
  const named = print.flatMap(heads).filter((h) => h === ".gh" || h === ".star");
  if (named.length)
    out.push(finding(file, "source-link", `the print list names ${named.join(", ")}; the header hides the link`));
  return out;
}
// AC "No harness status on the site": no page carries a harness-status marker,
// and no translation unit (an element with data-i18n), chip or description
// says Codex is experimental in the page's language.
function checkNoStatus(page) {
  const out = marked(page, (f) => f.startsWith("harness-status:")).map((el) =>
    finding(page.file, "no-status", `data-fact="${el.attrs["data-fact"]}": the site carries no harness status`),
  );
  const stem = EXPERIMENTAL[page.lang ?? DEFAULT_LANG];
  if (!stem) return [finding(page.file, "no-status", `the test has no stem for "experimental" in ${page.lang}`)];
  const units = [
    ...page.els.filter((el) => "data-i18n" in el.attrs || hasClass(el, "chip")).map((el) => el.text),
    ...page.els
      .filter((el) => el.name === "meta" && el.attrs.name === "description")
      .map((el) => el.attrs.content ?? ""),
  ];
  for (const text of units)
    if (text.includes("Codex") && text.toLowerCase().includes(stem))
      out.push(finding(page.file, "no-status", `"${text.trim().slice(0, 90)}" calls Codex ${stem}`));
  return out;
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
    // A page built in one language only is every language's, at the site root.
    if (SHARED_PAGE_DIRS.includes(path)) continue;
    if (!own.includes(path))
      out.push(finding(page.file, "page-link", `${href} lands on ${path}, which is not a ${page.lang} page`));
  }
  return unique(out);
}
// Every page folder per language, as the build writes them: "" or "de/" plus each kind's slug,
// for each kind built in that language.
const pageDirsByLang = (langs) =>
  Object.fromEntries(
    langs.map((l) => [
      l,
      KINDS.filter((k) => kindLangs(k, langs).includes(l)).map(
        ({ slug }) => (l === DEFAULT_LANG ? "" : `${l}/`) + (slug ? `${slug}/` : ""),
      ),
    ]),
  );

// What each kind of page carries (the story's Technical Notes, "Facts per
// page kind"), so that removing a marker cannot switch a check off:
//   facts      the data-fact markers it holds;
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
    facts: ["version", "install", "prompt", "commands", "agents", "languages", "mcp-tools"],
    templates: ["adr"],
    source: true,
    loop: true,
    sections: ["start", "talk", "rails", "fits", "disk", "teams", "method"],
    named: true,
    prose: "no commands",
    words: 2300,
  },
  "how-it-works": {
    facts: ["version", "agents", "mcp-tools", "mcp-tool"],
    templates: ["story"],
    loop: true,
    words: 1100,
  },
  "why-it-works": { facts: ["version"], words: 1100 },
  "one-vault": { facts: ["version", "install"], source: true, words: 1100 },
  privacy: { facts: ["version"], words: 900 },
};
const rulesOf = (page) => KIND_RULES[page.kind] ?? {};

// AC 4: a page carries every fact its kind's rules name, the example
// artifacts' data-template among them; and a value fact is a leaf, its text
// the fact.
function checkRequired(page, repo, rules = rulesOf(page)) {
  const have = new Set(marked(page).map((el) => el.attrs["data-fact"]));
  const facts = rules.facts ?? [];
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
    for (const k of KINDS) {
      const { kind, slug } = k;
      if (!kindLangs(k, langs).includes(lang)) continue;
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
  const own = kindOf(page.kind) ? kindLangs(kindOf(page.kind), langs) : langs;
  const want = new Map([
    ...own.map((l) => [LANG_TAGS[l], pageUrl(l, page.slug)]),
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

// AC "On tokens": a colour is a token. A hex, rgb(), hsl() (or another
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
    const scheme = /(?:^|;)\s*color-scheme\s*:\s*([^;]+)/.exec(b.body)?.[1].trim() ?? null;
    return tone ? [{ tone, head: b.head, media, scheme, tokens: declarations(b.body) }] : [];
  });
}
const DEFAULT_TONE = "midnight";
const TONE_KEY = "ps_tone";
// What a tone may change: the surfaces (a role's tint on a panel among them),
// the lines, the header tint and the glow. A light tone may also recolour what
// midnight's values would leave unreadable on its ground: the inks, the accent
// family and the text on the accent, the roles with their lines and glows, the
// experimental and epic marks, the menu shadow and the wordmark's dot.
const TONE_TOKENS = /^--(?:bg(?:-[0-4]|-pop)?|dot|line-[1-5]|graph|glow-[1-3]|head-bg|(?:accent|check|plan|done)-bg)$/;
const LIGHT_TOKENS =
  /^--(?:ink(?:-hi|-[2-5])?|on-accent|accent(?:-soft|-glow|-row)?|check(?:-glow)?|(?:plan|done)(?:-line|-glow)?|exp(?:-line)?|epic|shade|brand)$/;
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
// A tone is light when its resolved base is: a luminance above 0.5.
const isLight = (tokens) => {
  const bg = rgba(resolveToken(tokens, "--bg"));
  return !!bg && luminance(bg) > 0.5;
};

// AC "Still on tokens", "A translucent terminal window" and "A light tone may
// recolour text; a dark one may not": a tone rule sits inside @media screen
// (in print, :root[data-tone] would out-rank the white palette) and points
// each token it sets at a token :root declares. A dark tone sets surface
// tokens only and does not declare color-scheme: light; a light tone declares
// it and may set the light tokens too. One finding per rule, naming all it
// breaks. In every tone the surfaces that cover the page — the base, the
// menus — are opaque, and the header's tint is at least as dense as d1. The
// switch is hidden until the early script has set data-tone, so a page
// without the script shows none.
function checkTones(file, css) {
  const blocks = cssBlocks(css);
  const root = rootTokens(blocks);
  const out = [];
  for (const r of toneRules(blocks)) {
    const light = isLight({ ...root, ...r.tokens });
    const broken = [];
    if (!/^@media\s+screen\b/i.test(r.media ?? ""))
      broken.push("sits outside @media screen; in print it would beat the white palette");
    if (light && r.scheme !== "light") broken.push("is a light tone and declares no color-scheme: light");
    if (!light && r.scheme === "light") broken.push("is a dark tone and declares color-scheme: light");
    for (const [name, value] of Object.entries(r.tokens)) {
      const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      if (!TONE_TOKENS.test(name) && !(light && LIGHT_TOKENS.test(name)))
        broken.push(
          light
            ? `sets ${name}; a light tone changes surfaces, lines, the header tint, the glow, the text and the roles`
            : `sets ${name}; a dark tone changes surfaces, lines, the header tint and the glow`,
        );
      else if (!(name in root) || !ref || !(ref in root))
        broken.push(`sets ${name}: ${value}; a tone points a declared token at another`);
    }
    if (broken.length) out.push(finding(file, "tone", `${r.head} ${broken.join("; and it ")}`));
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

// AC "Still readable" and "Readable in every tone": WCAG contrast of each text
// colour at its lowest over the surfaces text sits on, composed from each
// tone's tokens — the base, plain and under each glow on its own (the glows
// sit in different corners and never overlap at full strength); every panel,
// menu and role tint over all the glows stacked; a well on the page and inside
// a card; a chip on the terminal; a node, plain or in a role's tint, inside a
// diagram. --ink to --ink-4 and the colours of small text keep 4.5:1; --ink-5,
// the fine print, keeps the ratio it had on black's --bg-4 (#171a15) when
// black was the site's palette; the wordmark's dot, a 19 px bold glyph,
// keeps 3:1; the text on the accent keeps 4.5:1 on it.
// One finding per tone: its worst colour against its floor.
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
const TEXT_FLOORS = [
  ...["--ink", "--ink-2", "--ink-3", "--ink-4"].map((n) => [n, 4.5]),
  ["--ink-5", INK5_FLOOR],
  ...["--accent", "--check", "--plan", "--done", "--exp", "--epic"].map((n) => [n, 4.5]),
  ["--brand", 3],
];
function checkToneContrast(file, css) {
  const out = [];
  for (const [tone, tokens] of toneSets(css)) {
    const colour = (name) => rgba(resolveToken(tokens, name));
    const base = colour("--bg");
    const glows = Object.keys(tokens)
      .filter((n) => /^--glow-\d$/.test(n))
      .map(colour)
      .filter(Boolean);
    const lit = glows.reduce((under, g) => over(g, under), base);
    const inPanel = over(colour("--bg-1"), lit);
    const inCard = over(colour("--bg-2"), lit);
    const surfaces = [
      base,
      ...glows.map((g) => over(g, base)),
      ...["--bg-1", "--bg-2", "--bg-3", "--bg-4", "--bg-pop", ...WASHES].map((n) => over(colour(n), lit)),
      over(colour("--bg-0"), lit),
      over(colour("--bg-0"), inCard),
      over(colour("--bg-4"), over(colour("--bg-3"), lit)),
      ...["--bg-3", ...WASHES].map((n) => over(colour(n), inPanel)),
    ];
    // the graph behind the page: its colour over the base, and under each glow
    const paint = graphPaint(css);
    if (paint) {
      const line = { ...colour(paint.token), a: paint.alpha };
      surfaces.push(over(line, base), ...glows.map((g) => over(line, over(g, base))));
    }
    const lowest = (c) => Math.min(...surfaces.map((s) => contrast(c, s)));
    const short = [
      ...TEXT_FLOORS.map(([n, floor]) => [n, lowest(colour(n)), floor, "at its lowest"]),
      ["--on-accent", contrast(colour("--on-accent"), colour("--accent")), 4.5, "on --accent"],
    ]
      .filter(([, r, floor]) => r < floor)
      .sort((a, b) => a[1] / a[2] - b[1] / b[2]);
    if (short.length) {
      const [name, r, floor, where] = short[0];
      out.push(finding(file, "contrast", `${tone}: ${name} is ${r.toFixed(2)}:1 ${where}; at least ${floor}`));
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
    for (const p of positions.filter((el) => !tones.includes(el.attrs["data-tone-set"])))
      out.push(
        finding(
          page.file,
          "tone-switch",
          `the switch offers ${p.attrs["data-tone-set"]}, which the stylesheet does not declare`,
        ),
      );
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

// AC "Three positions": the early script, run as a browser runs it, sets
// data-tone to a stored tone the switch offers, and the default for nothing
// stored, an unknown id, or storage that throws.
function checkToneScript(file, partial, tones) {
  const code = /<script>([\s\S]*?)<\/script>/.exec(partial)?.[1];
  if (!code) return [finding(file, "tone-script", "the partial holds no script")];
  const run = (stored) => {
    const attrs = {};
    const storage = {
      getItem: (key) => {
        if (stored instanceof Error) throw stored;
        return key === TONE_KEY ? stored : null;
      },
    };
    const sandbox = {
      document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) }, querySelector: () => null },
      localStorage: storage,
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    };
    try {
      runInNewContext(code, sandbox);
    } catch (e) {
      return `an error (${e.message})`;
    }
    return attrs["data-tone"] ?? "none";
  };
  const cases = [
    ...tones.map((t) => [`"${t}" stored`, t, t]),
    ["nothing stored", null, DEFAULT_TONE],
    ['"sepia" stored', "sepia", DEFAULT_TONE],
    ["storage that throws", new Error("storage is off"), DEFAULT_TONE],
  ];
  return cases.flatMap(([label, stored, want]) => {
    const got = run(stored);
    return got === want ? [] : [finding(file, "tone-script", `${label}: data-tone is ${got}; ${want} is expected`)];
  });
}

// AC "Three positions": the page links leave the header row exactly where the
// second row appears, one below .wrap's 1200 px, where the de and fr links
// need the page's full width. One media query, (max-width: 1199px), hides the
// links, shows the row and gives anchors the taller header's clearance; the
// row is hidden outside it; no other rule hides the links; and a link never
// wraps the row.
const HEADER_ROWS = "@media (max-width: 1199px)";
function checkHeaderRows(file, css) {
  const blocks = cssBlocks(css);
  const under = (selector, test) =>
    blocks.flatMap((b) =>
      b.head.startsWith("@media")
        ? b.blocks.filter((r) => r.head === selector && test.test(r.body)).map(() => b.head)
        : [],
    );
  const hide = under(".head-nav > a.page-link", /display:\s*none/);
  const show = under(".mobile-nav", /display:\s*flex/);
  const clear = under("html", /scroll-padding-top:/);
  const broken = [];
  if (hide.join() !== HEADER_ROWS || show.join() !== HEADER_ROWS)
    broken.push(
      `the page links hide under ${hide.join(", ") || "no media query"} and the second row shows under ${show.join(", ") || "no media query"}; ${HEADER_ROWS} does both`,
    );
  if (!clear.includes(HEADER_ROWS)) broken.push(`${HEADER_ROWS} sets no scroll-padding-top for the taller header`);
  if (!blocks.some((b) => b.head === ".mobile-nav" && /display:\s*none/.test(b.body)))
    broken.push(".mobile-nav is not hidden outside the media query");
  if (!blocks.some((b) => b.head === ".head-nav > a" && /white-space:\s*nowrap/.test(b.body)))
    broken.push("a header link may wrap the row");
  return broken.length ? [finding(file, "header", broken.join("; "))] : [];
}

// AC "Install first": the hero opens with the problem — one list of exactly
// three posters before the headline, in the tints' order, each with a large
// line on its key; the second and third with a small line, the first with its
// second sentence in <em>. The # is drawn by the stylesheet, never written.
// The list is a named list that takes focus, so a keyboard can scroll it
// where it swipes. What this cannot see: the posters spanning both columns,
// the swipe itself, and a translation long enough to push the prompt below
// the fold; those are the browser check's.
const POSTER_KEYS = ["hero.post.1", "hero.post.2", "hero.post.3"];
function checkPosters(page) {
  const hero = page.els.find((el) => el.name === "section" && hasClass(el, "hero"));
  const lists = hero ? page.els.filter((el) => within(hero, el) && hasClass(el, "problem")) : [];
  if (lists.length !== 1) return [finding(page.file, "posters", `${lists.length} problem lists in the hero; one`)];
  const [list] = lists;
  const h1 = page.els.find((el) => el.name === "h1" && within(hero, el));
  const posters = page.els.filter((el) => within(list, el) && hasClass(el, "poster"));
  const first = (p, name) => page.els.find((el) => el.name === name && within(p, el));
  const lines = posters.map((p) => first(p, "b"));
  const broken = [];
  if (!h1 || list.start > h1.start) broken.push("the problem comes after the headline");
  if (list.name !== "ul" || posters.some((el) => el.name !== "li")) broken.push("the posters are not a ul of li");
  if (list.attrs.role !== "list" || list.attrs.tabindex !== "0" || !(list.attrs["aria-label"] ?? "").trim())
    broken.push('the list is not role="list", tabindex="0" and named');
  if (posters.length !== POSTER_KEYS.length) broken.push(`${posters.length} posters; ${POSTER_KEYS.length}`);
  else if (lines.some((b) => !b?.text.trim())) broken.push("a poster has no large line");
  else {
    const keys = lines.map((b) => b.attrs["data-i18n"] ?? "none");
    if (keys.join() !== POSTER_KEYS.join()) broken.push(`the posters' keys are ${keys.join(", ")}`);
    if (posters.some((el, i) => !hasClass(el, `p-${i + 1}`))) broken.push("the posters' tints are out of order");
    if (lines.some((b) => b.text.trim().startsWith("#"))) broken.push("a large line writes the # the stylesheet draws");
    if (!first(posters[0], "em")?.text.trim()) broken.push("the first poster has no second sentence in <em>");
    if (posters.slice(1).some((el) => !first(el, "span")?.text.trim()))
      broken.push("the second or third poster has no small line");
  }
  return broken.length ? [finding(page.file, "posters", broken.join("; "))] : [];
}

// The dot and graph story. The stylesheet's rules, flattened: every block
// under any at-rule, with the at-rule it sits in.
const cssRules = (css) => {
  const walk = (blocks, media = null) =>
    blocks.flatMap((b) => (b.head.startsWith("@") ? walk(b.blocks, b.head) : [{ ...b, media }]));
  return walk(cssBlocks(css));
};

// AC "The dot": the wordmark's dot is a round dot in --brand whose animation
// has its @keyframes, and reduced motion stops every animation with
// !important (the dot's own rule outranks the universal selector).
function checkWordmarkDot(file, css) {
  const rules = cssRules(css);
  const out = [];
  const dot = rules.find((r) => r.head === ".wordmark .dot");
  if (!dot || !/background:\s*var\(--brand\)/.test(dot.body) || !/border-radius:\s*50%/.test(dot.body))
    out.push(finding(file, "dot", "the wordmark's dot is not a round dot in --brand"));
  const anim = /animation:\s*([\w-]+)/.exec(dot?.body ?? "")?.[1];
  if (!anim || !cssBlocks(css).some((b) => b.head === `@keyframes ${anim}`))
    out.push(finding(file, "dot", `the dot's animation ${anim ?? "is missing"}: no @keyframes ${anim ?? ""}`.trim()));
  const stops = rules.some(
    (r) =>
      /prefers-reduced-motion:\s*reduce/.test(r.media ?? "") &&
      r.head === "*, *::before, *::after" &&
      /animation:\s*none\s*!important/.test(r.body),
  );
  if (!stops)
    out.push(
      finding(file, "dot", "reduced motion does not stop every animation with !important; the dot would still pulse"),
    );
  return out;
}

// AC "The graph's shape": site.js holds the graph as one JSON literal — nodes
// as [x, y] in a 1000 x 1000 box, lines as [from, to] node indexes in growth
// order, the seeds, and "open", the lines drawn at the top.
const graphOf = (js) => {
  const m = /\bvar GRAPH = (\{[^\n]*\});/.exec(js);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};
// Each node is an artifact of the vault, labelled as the vault names it: its
// kind or number, then its slug, short enough to sit in the background.
const GRAPH_KINDS = ["adr", "spec", "epic", "story", "research"];
const GRAPH_LABEL = 26;
const GRAPH_LABEL_HEAD = {
  adr: /^(ADR-\d+|adr) \S/,
  spec: /^(SPEC-\d+|spec) \S/,
  epic: /^epic PS-[A-Z]+$/,
  story: /^story(-\d+)? \S/,
  research: /^research \S/,
};
function checkGraphData(file, js) {
  const g = graphOf(js);
  if (!g) return [finding(file, "graph", "site.js holds no GRAPH literal the test can read")];
  const out = [];
  g.nodes.forEach(([, , kind, label], i) => {
    if (!GRAPH_KINDS.includes(kind))
      out.push(finding(file, "graph", `node ${i} is a ${kind}; a node is one of ${GRAPH_KINDS.join(", ")}`));
    else if (typeof label !== "string" || label.length > GRAPH_LABEL || !GRAPH_LABEL_HEAD[kind].test(label))
      out.push(
        finding(
          file,
          "graph",
          `node ${i}'s label is ${JSON.stringify(label)}; a ${kind}'s number or kind, then its slug, in ${GRAPH_LABEL} characters`,
        ),
      );
  });
  g.nodes.forEach(([x, y], i) => {
    if (!(x >= 0 && x <= 1000 && y >= 0 && y <= 1000))
      out.push(finding(file, "graph", `node ${i} at ${x},${y} lies outside the 1000 x 1000 drawing`));
  });
  const reached = new Set(g.seeds);
  const seen = new Set();
  g.lines.forEach(([a, b], i) => {
    if (!(a in g.nodes) || !(b in g.nodes) || a === b) {
      out.push(finding(file, "graph", `line ${i} [${a},${b}] does not join two nodes`));
      return;
    }
    const key = [a, b].sort((m, n) => m - n).join();
    if (seen.has(key)) out.push(finding(file, "graph", `line ${i} [${a},${b}] repeats a line`));
    seen.add(key);
    if (!reached.has(a))
      out.push(finding(file, "graph", `line ${i} starts at node ${a}, which no seed or earlier line reached`));
    reached.add(b);
  });
  const lost = g.nodes.map((_, i) => i).filter((i) => !reached.has(i));
  if (lost.length) out.push(finding(file, "graph", `node ${lost.join(", ")} is never reached`));
  if (!(g.open >= 1 && g.open < g.lines.length))
    out.push(finding(file, "graph", `open is ${g.open}; between 1 and the number of lines`));
  return out;
}

// AC "Out of the way": the layer is fixed with the glow, under the content,
// takes no pointer; its lines stroke its colour, --graph, which every tone
// sets; its nodes fill --node; print and forced colours hide it; reduced
// motion draws it whole and still; a narrow screen shows no labels.
function checkGraphCss(file, css) {
  const rules = cssRules(css);
  const out = [];
  const top = (head) => rules.find((r) => r.head === head && r.media === null);
  const layer = top(".graph");
  if (
    !layer ||
    !/position:\s*fixed/.test(layer.body) ||
    !/z-index:\s*-1\b/.test(layer.body) ||
    !/pointer-events:\s*none/.test(layer.body) ||
    !/(?:^|[;\s])color:\s*var\(--graph\)/.test(layer.body)
  )
    out.push(
      finding(file, "graph-layer", ".graph is not fixed at z-index -1 with no pointer events and color: var(--graph)"),
    );
  const unset = toneRules(cssBlocks(css))
    .filter((r) => !("--graph" in r.tokens))
    .map((r) => r.tone);
  if (unset.length) out.push(finding(file, "graph-layer", `the ${unset.join(", ")} tone sets no --graph`));
  if (
    !/stroke:\s*currentColor/.test(top(".graph line")?.body ?? "") ||
    !/fill:\s*var\(--node\)/.test(top(".graph .node")?.body ?? "")
  )
    out.push(
      finding(file, "graph-layer", "the graph's lines do not stroke its colour, or its nodes do not fill --node"),
    );
  const hidden = (media) =>
    [".graph", ".graph-rings"].every((head) =>
      rules.some((r) => media.test(r.media ?? "") && r.head === head && /display:\s*none/.test(r.body)),
    );
  if (!hidden(/^@media\s+print/)) out.push(finding(file, "graph-layer", "print does not hide .graph"));
  if (!hidden(/forced-colors:\s*active/)) out.push(finding(file, "graph-layer", "forced colours do not hide .graph"));
  const frames = new Set(
    cssBlocks(css)
      .filter((b) => b.head.startsWith("@keyframes "))
      .map((b) => b.head.slice(11)),
  );
  for (const head of [".graph-rings .ring.on", ".graph .node.ping", ".graph line.fresh"]) {
    const names = [...(top(head)?.body ?? "").matchAll(/(?:animation:|,)\s*([\w-]+)\s+[\d.]+s/g)].map((m) => m[1]);
    if (!names.length || names.some((n) => !frames.has(n)))
      out.push(finding(file, "graph-layer", `${head} has no animation with its @keyframes`));
  }
  const reduced = rules.filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.media ?? ""));
  if (
    !reduced.some((r) => r.head === ".graph line" && /stroke-dashoffset:\s*0\s*!important/.test(r.body)) ||
    !reduced.some((r) => r.head === ".graph .node" && /opacity:\s*1\s*!important/.test(r.body)) ||
    !reduced.some((r) => r.head === ".graph .beacon" && /opacity:\s*0\s*!important/.test(r.body)) ||
    !reduced.some((r) => r.head === ".graph-rings" && /display:\s*none\s*!important/.test(r.body))
  )
    out.push(finding(file, "graph-layer", "under reduced motion the graph is not drawn whole"));
  if (
    !rules.some(
      (r) => /max-width:\s*900px/.test(r.media ?? "") && r.head === ".graph .label" && /display:\s*none/.test(r.body),
    )
  )
    out.push(finding(file, "graph-layer", "the graph's labels show on a narrow screen, where they lie under the text"));
  if (!rules.some((r) => r.media === null && r.head === ".graph .label.off" && /display:\s*none/.test(r.body)))
    out.push(finding(file, "graph-layer", "a label site.js drops (.graph .label.off) is still drawn"));
  return out;
}
// The nodes' exemption from the readability floors, held to the bounds the
// story states: a node shows at up to 2.2x its size, its beacon at up to 4.5x
// and 0.55; its breathing ring grows to 4x by transform and opacity alone (no
// layout per frame); its ping to a 34 px stroke; and the graph paints only
// its colour, --node and --line-5.
const GRAPH_BOUNDS = { node: 1.2, beacon: 3.5, beaconAlpha: 0.55, ring: 4, ping: 34 };
function checkGraphBounds(file, css) {
  const rules = cssRules(css);
  const top = (head) => rules.find((r) => r.head === head && r.media === null)?.body ?? "";
  const grow = (body) =>
    Number(/scale\(calc\(1 \+ \(1 - var\(--p, [01]\)\) \* ([\d.]+)\)\)/.exec(body)?.[1] ?? Infinity);
  const frame = (name) => cssBlocks(css).find((b) => b.head === `@keyframes ${name}`)?.body ?? "";
  const nums = (body, prop) => [...body.matchAll(new RegExp(`${prop}:\\s*([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const out = [];
  const say = (msg) => out.push(finding(file, "graph-bounds", msg));
  if (grow(top(".graph .node")) > GRAPH_BOUNDS.node) say(`a node grows past ${1 + GRAPH_BOUNDS.node}x`);
  const beacon = top(".graph .beacon");
  const alpha = Number(/\* ([\d.]+)\);\s*transform/.exec(beacon)?.[1] ?? Infinity);
  if (grow(beacon) > GRAPH_BOUNDS.beacon || alpha > GRAPH_BOUNDS.beaconAlpha)
    say(`a beacon grows past ${1 + GRAPH_BOUNDS.beacon}x or ${GRAPH_BOUNDS.beaconAlpha} strong`);
  const ring = frame("graph-ring");
  const rings = [...ring.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
  if (/stroke-width|fill|\br:/.test(ring) || !rings.length || Math.max(...rings) > GRAPH_BOUNDS.ring)
    say(`the breathing ring animates more than transform and opacity, or grows past ${GRAPH_BOUNDS.ring}x`);
  if (Math.max(0, ...nums(frame("graph-ping"), "stroke-width")) > GRAPH_BOUNDS.ping)
    say(`the ping grows past a ${GRAPH_BOUNDS.ping} px stroke`);
  const graphCss = [
    ...rules
      .filter((r) => r.head.startsWith(".graph") && r.media === null)
      .map((r) => r.body.replace(/border:\s*[\d.]+px solid/g, "stroke:")),
    ...["graph-ring", "graph-ping", "graph-pulse"].map(frame),
  ].join(";");
  const paints = [...graphCss.matchAll(/(?:fill|stroke):\s*([^;]+)/g)].map((m) => m[1].trim());
  const odd = paints.filter((v) => !["currentColor", "none", "var(--node)", "var(--line-5)"].includes(v));
  if (odd.length) say(`the graph paints ${[...new Set(odd)].join(", ")}; only its colour, --node and --line-5`);
  return out;
}
// The graph's paint for the readability test: the token .graph names, and
// its opacity (1 when it names none). The lines carry it; the nodes are held
// by checkGraphBounds instead.
function graphPaint(css) {
  const layer = cssRules(css).find((r) => r.head === ".graph" && r.media === null);
  const token = /(?:^|[;\s])color:\s*var\((--[\w-]+)\)/.exec(layer?.body ?? "")?.[1];
  const opacity = Number(/(?:^|[;\s])opacity:\s*([\d.]+)/.exec(layer?.body ?? "")?.[1] ?? 1);
  return token ? { token, alpha: opacity } : null;
}

// AC "Drawn as you scroll", "Alive" and "Out of the way": site.js, run in
// node:vm with a small stand-in for the page (which then fires load), builds
// the layer as body's first child, hidden from assistive technology, with a
// beacon, a node and a ring per node; listens to scroll passively and draws at
// most once per frame; shows the open lines at the top, everything at the end,
// no line less further down; marks what the scroll draws; shows the graph
// whole under reduced motion and on a page with nothing to scroll; writes no
// paint; and keeps every node's core a point.
function runSite(js, { scrollHeight = 4800, innerWidth = 1280, innerHeight = 800, reduce = false } = {}) {
  const made = [];
  const createElementNS = (ns, name) => {
    const el = {
      ns,
      name,
      attrs: {},
      props: {},
      children: [],
      setAttribute: (k, v) => (el.attrs[k] = String(v)),
      appendChild: (c) => el.children.push(c),
      getBoundingClientRect: () => ({ width: innerWidth, height: innerHeight }),
    };
    el.style = { setProperty: (k, v) => (el.props[k] = String(v)) };
    made.push(el);
    return el;
  };
  const body = {
    children: [],
    get firstChild() {
      return this.children[0] ?? null;
    },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(node);
      else this.children.splice(i, 0, node);
    },
  };
  const listeners = {};
  let frames = [];
  const window = {
    scrollY: 0,
    innerWidth,
    innerHeight,
    matchMedia: (q) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q), addEventListener() {} }),
    addEventListener: (type, fn, options) => (listeners[type] ??= []).push({ fn, options }),
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  const document = {
    body,
    documentElement: { scrollHeight },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElementNS,
    createElement: (name) => createElementNS(null, name),
    addEventListener() {},
  };
  runInNewContext(js, { window, document });
  (listeners.load ?? []).forEach((l) => l.fn());
  const svg = body.children.find((c) => c.name === "svg");
  const kids = () => (svg ? svg.children : []);
  const of = (cls) => kids().filter((c) => c.name === "circle" && (c.attrs.class ?? "").split(" ")[0] === cls);
  const ringBox = body.children.find((c) => c.attrs?.class === "graph-rings");
  const rings = () => (ringBox ? ringBox.children : []);
  return {
    window,
    listeners,
    made,
    body,
    svg,
    of,
    ringBox,
    rings,
    frames: () => frames.length,
    scroll(y) {
      window.scrollY = y;
      (listeners.scroll ?? []).forEach((l) => l.fn());
      const run = frames;
      frames = [];
      run.forEach((fn) => fn());
    },
    state() {
      const p = (els) => els.map((c) => Number(c.props["--p"]));
      return {
        lines: p(kids().filter((c) => c.name === "line")),
        dots: p(of("node")),
        beacons: p(of("beacon")),
        rings: rings().map((r) => (r.attrs.class === "ring on" ? 1 : 0)),
      };
    },
  };
}
function checkGraphScript(file, js) {
  const g = graphOf(js);
  if (!g) return [finding(file, "graph-script", "site.js holds no GRAPH literal")];
  const out = [];
  const say = (msg) => out.push(finding(file, "graph-script", msg));
  let page;
  try {
    page = runSite(js);
  } catch (e) {
    return [finding(file, "graph-script", `site.js throws in a page: ${e.message}`)];
  }
  const svg = page.svg;
  const kids = svg ? svg.children : [];
  if (
    !svg ||
    page.body.children[0] !== svg ||
    svg.ns !== "http://www.w3.org/2000/svg" ||
    svg.attrs["aria-hidden"] !== "true" ||
    svg.attrs.focusable !== "false" ||
    "tabindex" in svg.attrs ||
    kids.filter((c) => c.name === "line").length !== g.lines.length ||
    ["beacon", "node"].some((cls) => page.of(cls).length !== g.nodes.length) ||
    page.body.children[1] !== page.ringBox ||
    page.ringBox?.attrs["aria-hidden"] !== "true" ||
    page.rings().length !== g.nodes.length ||
    kids
      .filter((c) => c.name === "text" && (c.attrs.class ?? "").split(" ")[0] === "label")
      .map((c) => c.textContent)
      .join() !== g.nodes.map((n) => n[3]).join()
  )
    say(
      "the layer is not an aria-hidden, unfocusable svg, body's first child, with a line per line and a beacon, node and ring per node",
    );
  const scroll = page.listeners.scroll ?? [];
  if (scroll.length !== 1 || scroll[0].options?.passive !== true)
    say("the scroll listener is not one passive listener");
  page.window.scrollY = 1000;
  for (let i = 0; i < 5; i++) scroll.forEach((l) => l.fn());
  if (page.frames() !== 1) say(`five scroll events asked for ${page.frames()} frames; one`);
  const drawn = (st) => st.lines.filter((q) => q >= 0.999).length;
  page.scroll(0);
  const top = page.state();
  const openTo = new Set([...g.seeds, ...g.lines.slice(0, g.open).map((l) => l[1])]);
  if (
    drawn(top) !== g.open ||
    top.lines.slice(g.open).some((q) => q > 0) ||
    top.dots.some((q, i) => q >= 0.999 !== openTo.has(i))
  )
    say(`at the top ${drawn(top)} lines are drawn; the ${g.open} open lines and their nodes`);
  let prev = top.lines;
  let fell = false;
  let strayed = false;
  const range = 4800 - 800;
  for (let k = 0; k <= 20; k++) {
    page.scroll((range * k) / 20);
    const now = page.state();
    if (now.lines.some((q, i) => q + 1e-9 < prev[i])) fell = true;
    if (now.beacons.join() !== now.dots.join() || now.rings.join() !== now.dots.map((q) => (q >= 0.999 ? 1 : 0)).join())
      strayed = true;
    prev = now.lines;
  }
  const end = page.state();
  if (end.lines.some((q) => q < 0.999) || end.dots.some((q) => q < 0.999))
    say("at the end of the page the graph is not whole");
  if (strayed) say("a beacon or a ring does not follow its node's progress");
  // a label shows only where it covers no label shown before it and no other
  // node: a short laptop window drops a few, the layout's own 1440 x 900 none
  // (1280 x 600 is short enough that a label's leftward flip matters)
  const covered = [];
  for (const [w, h] of [
    [1024, 640],
    [1280, 600],
    [1440, 900],
  ]) {
    const at = runSite(js, { innerWidth: w, innerHeight: h });
    const texts = at.svg.children.filter((c) => c.name === "text");
    const dots = at.of("node").map((c) => [Number(c.attrs.cx), Number(c.attrs.cy)]);
    const boxes = texts.map((t) => {
      const x = Number(t.attrs.x),
        y = Number(t.attrs.y) - 3.5,
        len = t.textContent.length * 6.6;
      return t.attrs["text-anchor"] === "end" ? [x - len, y - 6, x, y + 6] : [x, y - 6, x + len, y + 6];
    });
    const on = texts.map((t) => t.attrs.class === "label");
    const clash = [];
    boxes.forEach((b, i) => {
      if (!on[i]) return;
      boxes.forEach((o, j) => {
        if (j > i && on[j] && b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3]) clash.push(`${i}/${j}`);
      });
      dots.forEach(([x, y], j) => {
        if (j !== i && x >= b[0] - 4 && x <= b[2] + 4 && y >= b[1] - 4 && y <= b[3] + 4) clash.push(`${i} on ${j}`);
      });
    });
    if (clash.length) covered.push(`at ${w}x${h} ${clash.join(", ")}`);
    if (w === 1440 && on.some((o) => !o)) say(`at 1440x900 a label is dropped; the layout leaves every one room there`);
  }
  if (covered.length) say(`labels cover labels or nodes: ${covered.join("; ")}`);
  const later = new Set(g.nodes.map((_, i) => i).filter((i) => !openTo.has(i)));
  const lineMarks = kids.filter((c) => c.name === "line").map((c) => c.attrs.class ?? "");
  const nodeMarks = page.of("node").map((c) => c.attrs.class);
  if (
    lineMarks.some((m, i) => m !== (i < g.open ? "" : "fresh")) ||
    nodeMarks.some((m, i) => m !== (later.has(i) ? "node ping" : "node"))
  )
    say("lines the scroll drew do not pulse, or their nodes do not ping (and the open ones must not)");
  page.scroll(0);
  if (fell || JSON.stringify(page.state()) !== JSON.stringify(top))
    say("a line undraws as the page scrolls down, or scrolling back up does not return to the top");
  for (const [what, options] of [
    ["under reduced motion", { reduce: true }],
    ["on a page with nothing to scroll", { scrollHeight: 800 }],
  ]) {
    const other = runSite(js, options);
    other.scroll(0);
    const st = other.state();
    if (st.lines.some((q) => q < 0.999) || st.dots.some((q) => q < 0.999)) say(`${what} the graph is not whole`);
  }
  const paint = page.made.filter(
    (el) =>
      ["fill", "stroke", "color", "stop-color", "style", "font-size", "font-family"].some((a) => a in el.attrs) ||
      Object.keys(el.props).some((k) => !["--len", "--p", "--x", "--y"].includes(k)),
  );
  if (paint.length) say(`site.js writes paint into the graph (${paint.length} elements); the stylesheet colours it`);
  const big = kids.filter((c) => c.name === "circle" && !(Number(c.attrs.r) <= 4));
  if (big.length) say(`${big.length} circles have a radius over 4 px; a node's core is a point`);
  return out;
}

// AC "Out of the way": site.js writes no colour — no string literal in it
// holds a hex, a colour function or a named colour.
function checkScriptColours(file, js) {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)]
    .map((m) => m[1] ?? m[2])
    .filter((text) => colourLiteral(text))
    .map((text) =>
      finding(file, "script-colour", `site.js writes the colour "${text}"; colours are tokens in the stylesheet`),
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
  // A page in English only has no other page to send a visitor to.
  if (singleLanguage(page.kind))
    return scripts.length
      ? [finding(page.file, "redirect", "a page built in one language carries the redirect; it has nowhere to go")]
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
    ...read("site/tools/i18n.py").matchAll(
      /^\s+\{"kind": "([a-z-]+)", "src": "([\w.-]+)", "slug": "([a-z-]*)"(?:, "langs": \[((?:"[a-z]+"(?:, )?)+)\])?\},$/gm,
    ),
  ].map((m) => ({
    kind: m[1],
    src: m[2],
    slug: m[3],
    ...(m[4] ? { langs: [...m[4].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) } : {}),
  }));
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
  assert.equal(
    PAGES.length,
    KINDS.reduce((n, k) => n + kindLangs(k, LANGS).length, 0),
    "a page per dictionary and kind, a single-language kind in its languages",
  );
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

test("site: every main page names the four agents in the hero and the terminal box's chips, as plain names", () => {
  const mains = PAGES.filter((p) => p.page && p.kind === "main");
  assert.equal(mains.length, 8, "eight main pages");
  const found = mains.flatMap((p) => checkAgents(p.page));
  assert.deepEqual(found, [], show(found));
});

test("site: every page's header links to the source on GitHub with its mark and its untranslated name, and no page keeps the Star button", () => {
  const found = [...eachPage(checkSourceLink), ...checkSourceLinkCss(STYLE, read(STYLE))];
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

test("site: no page carries a harness status, and none calls Codex experimental in its language", () => {
  const found = eachPage(checkNoStatus);
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

test("site: the tones — midnight on :root, graphite and light screen-only rules (graphite over surface tokens, light over the text too, with color-scheme: light), the covering surfaces opaque, and every text colour readable at its lowest", () => {
  const css = read(`${SITE}/assets/style.css`);
  assert.deepEqual(
    toneSets(css).map(([tone]) => tone),
    [DEFAULT_TONE, "graphite", "light"],
    "midnight is the palette, graphite and light the tone rules",
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
    ...checkToneScript(`${SITE}/src/_tone.html`, read(`${SITE}/src/_tone.html`), tones),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: the wordmark's dot is a round dot in --brand that pulses, and reduced motion stops it", () => {
  const found = checkWordmarkDot(STYLE, read(STYLE));
  assert.deepEqual(found, [], show(found));
});

test("site: the graph behind the page is well formed, laid out of the way, drawn as the page scrolls, and painted by the stylesheet alone", () => {
  const js = read(SCRIPT);
  const found = [
    ...checkGraphData(SCRIPT, js),
    ...checkGraphCss(STYLE, read(STYLE)),
    ...checkGraphBounds(STYLE, read(STYLE)),
    ...checkGraphScript(SCRIPT, js),
    ...checkScriptColours(SCRIPT, js),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: the header's page links move to the second row under the same media query that shows it", () => {
  const found = checkHeaderRows(`${SITE}/assets/style.css`, read(`${SITE}/assets/style.css`));
  assert.deepEqual(found, [], show(found));
});

test("site: every main page opens its hero with the problem — three posters before the headline, each with a large line, on the same keys", () => {
  const mains = PAGES.filter((p) => p.page && p.kind === "main");
  assert.equal(mains.length, 8, "eight main pages");
  const found = mains.flatMap((p) => checkPosters(p.page));
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

// The privacy page (PS-DIRECTORY: "The README and the manifest say everything
// the plugin runs, writes, sends and fetches, and the listing has its icon,
// its links and a privacy page"): plugin.json's privacyPolicyUrl. It is in
// English only for now, every page's footer links it at the site root, it
// loads nothing from another origin, and the hosts its "sent" section names
// are the ones README's "What it sends and fetches" names, no more and no
// fewer — the two say the same thing to the person deciding.
const README_SENT = "### What it sends and fetches";
function readmeSentHosts(md) {
  const at = md.indexOf(`\n${README_SENT}\n`);
  if (at < 0) return null;
  const rest = md.slice(at + README_SENT.length + 2);
  const end = rest.search(/^#{1,3} /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  return [...new Set([...body.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]))].sort();
}
function privacySentHosts(html) {
  const sec = /<section\b[^>]*\bid="sent"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
  if (!sec) return null;
  return [...new Set([...sec.matchAll(/<code>([a-z0-9.-]+\.[a-z]{2,})<\/code>/g)].map((m) => m[1]))].sort();
}

test("site: /privacy/ is English, in every footer, loads nothing from another origin, and names the README's network destinations", () => {
  const privacy = PAGES.filter((p) => p.kind === "privacy");
  assert.deepEqual(
    privacy.map((p) => [p.lang, p.file]),
    [[DEFAULT_LANG, `${SITE}/privacy/index.html`]],
    "one privacy page, in English, at /privacy/",
  );
  const page = privacy[0].page;
  assert.ok(page, `${SITE}/privacy/index.html is built`);
  assert.equal(page.els.find((el) => el.name === "html")?.attrs.lang, "en");
  for (const lang of LANGS.filter((l) => l !== DEFAULT_LANG))
    assert.ok(!existsSync(join(ROOT, SITE, lang, "privacy")), `no ${lang}/privacy/: the page is English only`);
  // The manifest's link is this page.
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.privacyPolicyUrl, pageUrl(DEFAULT_LANG, "privacy"));
  // Every page's footer links it, and the link lands on the root /privacy/.
  for (const p of PAGES.filter((x) => x.page)) {
    const footer = p.page.els.find((el) => el.name === "footer");
    const links = p.page.els.filter((el) => el.name === "a" && footer && within(footer, el));
    const lands = links.map((el) => new URL(el.attrs.href || "", pageUrl(p.lang, p.slug)).href);
    assert.ok(lands.includes(pageUrl(DEFAULT_LANG, "privacy")), `${p.file}: the footer links ${ORIGIN}privacy/`);
  }
  // Nothing from another origin, and the walk is not vacuous: it loads the stylesheet.
  assert.ok(/href="\.\.\/assets\/style\.css\?v=/.test(privacy[0].html), "the page loads the site's stylesheet");
  assert.deepEqual(checkLoads(privacy[0].file, privacy[0].html), []);
  // The same destinations as README's section.
  const readme = readmeSentHosts(read("README.md"));
  assert.ok(readme && readme.length >= 2, `README has "${README_SENT}" naming its hosts: ${JSON.stringify(readme)}`);
  assert.deepEqual(privacySentHosts(privacy[0].html), readme, "the privacy page names README's network destinations");
  // The helpers see a difference: a host dropped from either side is one.
  assert.notDeepEqual(privacySentHosts(privacy[0].html.replace("<code>api.anthropic.com</code>", "Anthropic")), readme);
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
const TRANSLATED = [
  "start.p.5",
  "questions.summary.10",
  "questions.p.11",
  // the four-agents story's keys
  "meta.description",
  "talk.lede",
  "set.models.h",
  "set.skill.h",
  "how.fine.2",
  "how.meta.description",
];
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

test("site: the instructions and four-agents stories' keys are translated in all seven other dictionaries; a key set back to English is one finding", () => {
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
    what: "a language page translates a count",
    ...parity("ru"),
    fact: "fact values",
    message: /agents=шесть/,
    edits: [['data-fact="agents">6<', 'data-fact="agents">шесть<']],
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

  // AC "On tokens": a literal in a rule, a named colour, a fill, a style.
  {
    ac: "On tokens",
    what: "a hex colour in a rule outside :root",
    ...onText(STYLE, checkColourCss),
    fact: "colour",
    message: /\.planted \{ color: #ff0000 \} holds #ff0000/,
    edits: [[/$/, "\n.planted { color: #ff0000; }\n"]],
  },
  {
    ac: "On tokens",
    what: "a named colour in a rule inside a media query that is not print",
    ...onText(STYLE, checkColourCss),
    fact: "colour",
    message: /\.planted \{ border: 1px solid white \} holds white/,
    edits: [[/$/, "\n@media (max-width: 760px) {\n  .planted { border: 1px solid white; }\n}\n"]],
  },
  {
    ac: "On tokens",
    what: "a hex fill in the loop partial",
    ...onText(LOOP, checkColourAttrs),
    fact: "colour",
    message: /<rect fill="#ffb347">/,
    edits: [[/<rect class="nb"/, '<rect class="nb" fill="#ffb347"']],
  },
  {
    ac: "On tokens",
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
    message: /sets --accent; a dark tone changes surfaces/,
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
    ...onPage("pt", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite", "light"], "#080d19"), "one-vault"),
    fact: "theme-color",
    message: /theme-color is #0b0c0a; :root --bg is #080d19/,
    edits: [[/(<meta name="theme-color" content=")[^"]*/, "$1#0b0c0a"]],
  },
  {
    ac: "One two-way switch",
    what: "a switch without its graphite position",
    ...onPage("zh", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite", "light"], "#080d19"), "why-it-works"),
    fact: "tone-switch",
    message: /no position for graphite/,
    edits: [[/<button class="tone-opt" type="button" data-tone-set="graphite"[^>]*>.*?<\/button>/, ""]],
  },
  {
    ac: "Remembered, without a flash",
    what: "a page without the early script",
    ...onPage("de", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite", "light"], "#080d19"), "one-vault"),
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

  // The light tone: color-scheme, the tokens it may set, its text colours; the
  // switch's third position; the early script; the header's second row; the
  // posters.
  {
    ac: "A light tone may recolour text; a dark one may not",
    what: "the light rule without color-scheme: light",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /:root\[data-tone="light"\] is a light tone and declares no color-scheme: light/,
    edits: [["    color-scheme: light;\n    --bg: var(--light-bg);", "    --bg: var(--light-bg);"]],
  },
  {
    ac: "A light tone may recolour text; a dark one may not",
    what: "graphite declaring color-scheme: light",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /:root\[data-tone="graphite"\] is a dark tone and declares color-scheme: light/,
    edits: [["--head-bg: var(--graphite-head-bg);", "--head-bg: var(--graphite-head-bg); color-scheme: light;"]],
  },
  {
    ac: "A light tone may recolour text; a dark one may not",
    what: "the light rule setting a token outside surfaces, text and roles",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /:root\[data-tone="light"\] sets --gutter; a light tone changes/,
    edits: [
      ["    --shade: var(--light-shade);\n  }", "    --shade: var(--light-shade); --gutter: var(--light-bg);\n  }"],
    ],
  },
  {
    ac: "Readable in every tone",
    what: "the light accent in the bright copper of the preview card",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^light: --(?:on-)?accent is \d\.\d\d:1/,
    edits: [["--light-accent: #a1491f;", "--light-accent: #c4643c;"]],
  },
  {
    ac: "Readable in every tone",
    what: "a light --ink-4 too pale for cream",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^light: --ink-4 is \d\.\d\d:1 at its lowest; at least 4\.5/,
    edits: [["--light-ink-4: #5c584e;", "--light-ink-4: #8a857a;"]],
  },
  {
    ac: "Readable in every tone",
    what: "a light done green too pale for small text",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^light: --done is \d\.\d\d:1 at its lowest; at least 4\.5/,
    edits: [["--light-done: #05683f;", "--light-done: #3a9a6a;"]],
  },
  {
    ac: "Three positions",
    what: "a page without its light position",
    ...onPage("uk", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite", "light"], "#080d19"), "how-it-works"),
    fact: "tone-switch",
    message: /no position for light/,
    edits: [[/<button class="tone-opt" type="button" data-tone-set="light"[^>]*>.*?<\/button>/, ""]],
  },
  {
    ac: "Three positions",
    what: "a switch offering a tone the stylesheet does not declare",
    ...onPage("fr", (p) => checkTonePage(p, [DEFAULT_TONE, "graphite", "light"], "#080d19"), "one-vault"),
    fact: "tone-switch",
    message: /^the switch offers sepia, which the stylesheet does not declare$/,
    edits: [
      [
        /(<button class="tone-opt" type="button" data-tone-set="light"[^>]*>.*?<\/button>)/,
        '$1<button class="tone-opt" type="button" data-tone-set="sepia" aria-pressed="false" aria-label="Sepia"></button>',
      ],
    ],
  },
  {
    ac: "Three positions",
    what: "an early script that takes any stored id",
    ...onText(TONE_PARTIAL, (file, partial) => checkToneScript(file, partial, [DEFAULT_TONE, "graphite", "light"])),
    fact: "tone-script",
    message: /^"sepia" stored: data-tone is sepia; midnight is expected/,
    edits: [['if(s==="graphite"||s==="light")t=s;', "t=s||t;"]],
  },
  {
    ac: "Three positions",
    what: "an early script that forgets light",
    ...onText(TONE_PARTIAL, (file, partial) => checkToneScript(file, partial, [DEFAULT_TONE, "graphite", "light"])),
    fact: "tone-script",
    message: /^"light" stored: data-tone is midnight; light is expected/,
    edits: [['||s==="light"', ""]],
  },
  {
    ac: "Three positions",
    what: "the page links hidden at a width where the second row is not shown",
    ...onText(STYLE, checkHeaderRows),
    fact: "header",
    message:
      /^the page links hide under @media \(max-width: 760px\) and the second row shows under @media \(max-width: 1199px\)/,
    edits: [
      [
        "  .head-nav > a.page-link { display: none; }\n  .mobile-nav { display: flex;",
        "  .mobile-nav { display: flex;",
      ],
      [
        "@media (max-width: 760px) {\n  .head-nav { gap: 8px; }",
        "@media (max-width: 760px) {\n  .head-nav > a.page-link { display: none; }\n  .head-nav { gap: 8px; }",
      ],
    ],
  },
  {
    ac: "Three positions",
    what: "the second row moved back to narrow screens only",
    ...onText(STYLE, checkHeaderRows),
    fact: "header",
    message:
      /under @media \(max-width: 900px\); @media \(max-width: 1199px\) does both; @media \(max-width: 1199px\) sets no scroll-padding-top/,
    edits: [["@media (max-width: 1199px) {", "@media (max-width: 900px) {"]],
  },
  {
    ac: "Three positions",
    what: "a header link that may wrap",
    ...onText(STYLE, checkHeaderRows),
    fact: "header",
    message: /^a header link may wrap the row$/,
    edits: [["text-decoration: none; white-space: nowrap; }", "text-decoration: none; }"]],
  },
  {
    ac: "Install first",
    what: "a main page with two posters",
    ...onPage("es", checkPosters),
    fact: "posters",
    message: /^2 posters; 3$/,
    edits: [[/<li class="poster p-3">[\s\S]*?<\/li>\n?/, ""]],
  },
  {
    ac: "Install first",
    what: "a poster with no large line",
    ...onPage("fr", checkPosters),
    fact: "posters",
    message: /^a poster has no large line$/,
    edits: [[/(<b data-i18n="hero\.post\.2">)[^<]*/, "$1"]],
  },
  {
    ac: "Install first",
    what: "a large line that writes the #",
    ...onPage("de", checkPosters),
    fact: "posters",
    message: /^a large line writes the # the stylesheet draws$/,
    edits: [[/(<b data-i18n="hero\.post\.3">)/, "$1# "]],
  },
  {
    ac: "Install first",
    what: "the blue and red posters swapped",
    ...onPage("pt", checkPosters),
    fact: "posters",
    message: /^the posters' tints are out of order$/,
    edits: [
      ['<li class="poster p-2">', '<li class="poster p-x">'],
      ['<li class="poster p-3">', '<li class="poster p-2">'],
      ['<li class="poster p-x">', '<li class="poster p-3">'],
    ],
  },
  {
    ac: "Install first",
    what: "a poster list that takes no focus",
    ...onPage("zh", checkPosters),
    fact: "posters",
    message: /^the list is not role="list", tabindex="0" and named$/,
    edits: [[' tabindex="0"', ""]],
  },
  {
    ac: "Install first",
    what: "the problem after the headline",
    ...onPage("ru", checkPosters),
    fact: "posters",
    message: /^the problem comes after the headline$/,
    edits: [[/(<ul class="problem"[^>]*>[\s\S]*?<\/ul>\n)([\s\S]*?<\/h1>\n)/, "$2$1"]],
  },

  // The dot and the graph.
  {
    ac: "The dot",
    what: "the dot's keyframes renamed",
    ...onText(STYLE, checkWordmarkDot),
    fact: "dot",
    message: /no @keyframes dot-ping/,
    edits: [["@keyframes dot-ping {", "@keyframes dot-pong {"]],
  },
  {
    ac: "The dot",
    what: "reduced motion's animation rule without !important",
    ...onText(STYLE, checkWordmarkDot),
    fact: "dot",
    message: /reduced motion does not stop every animation/,
    edits: [["*, *::before, *::after { animation: none !important;", "*, *::before, *::after { animation: none;"]],
  },
  {
    ac: "The dot",
    what: "the dot in the accent, not the brand",
    ...onText(STYLE, checkWordmarkDot),
    fact: "dot",
    message: /not a round dot in --brand/,
    edits: [["background: var(--brand); color: transparent;", "background: var(--accent); color: transparent;"]],
  },
  {
    ac: "The graph's shape",
    what: "a line to a node that does not exist",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /\[0,99\] does not join two nodes/,
    edits: [[/\]\]\};$/m, "],[0,99]]};"]],
  },
  {
    ac: "The graph's shape",
    what: "a node outside the drawing",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /node 0 at 1012,165 lies outside/,
    edits: [['"nodes":[[905,165,', '"nodes":[[1012,165,']],
  },
  {
    ac: "The graph's shape",
    what: "a line that starts where no line has reached",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /line 0 starts at node 27/,
    edits: [['"lines":[[0,1]', '"lines":[[27,0],[0,1]']],
  },
  {
    ac: "The graph's shape",
    what: "a node of a kind the vault has not",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /node 0 is a ticket/,
    edits: [['"nodes":[[905,165,"adr"', '"nodes":[[905,165,"ticket"']],
  },
  {
    ac: "The graph's shape",
    what: "a label that names another kind",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /node 1's label is "story PS-CORE"; a epic's/,
    edits: [['"epic PS-CORE"', '"story PS-CORE"']],
  },
  {
    ac: "The graph's shape",
    what: "a label too long for the background",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /node 0's label is "ADR-010 slug-first-artifact-identity"/,
    edits: [["ADR-010 slug-first-artifa…", "ADR-010 slug-first-artifact-identity"]],
  },
  {
    ac: "The graph's shape",
    what: "a node no line reaches",
    ...onText(SCRIPT, checkGraphData),
    fact: "graph",
    message: /node 28 is never reached/,
    edits: [[/\]\],"lines"/, '],[500,500,"story","story x"]],"lines"']],
  },
  {
    ac: "Out of the way",
    what: "the graph taking pointer events",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /^\.graph is not fixed/,
    edits: [["pointer-events: none; color: var(--graph);", "pointer-events: auto; color: var(--graph);"]],
  },
  {
    ac: "Out of the way",
    what: "the graph over the content",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /^\.graph is not fixed/,
    edits: [
      [
        "height: 100lvh; z-index: -1; pointer-events: none; color",
        "height: 100lvh; z-index: 1; pointer-events: none; color",
      ],
    ],
  },
  {
    ac: "Out of the way",
    what: "labels the script never drops",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /^labels cover labels or nodes: at 1024x640/,
    edits: [
      ['labels[i].setAttribute("class", clear ? "label" : "label off");', 'labels[i].setAttribute("class", "label");'],
    ],
  },
  {
    ac: "Out of the way",
    what: "a script that drops every label",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /^at 1440x900 a label is dropped/,
    edits: [
      [
        'labels[i].setAttribute("class", clear ? "label" : "label off");',
        'labels[i].setAttribute("class", "label off");',
      ],
    ],
  },
  {
    ac: "Out of the way",
    what: "a dropped label still drawn",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /\.graph \.label\.off\) is still drawn/,
    edits: [[".graph .label.off { display: none; }", ".graph .label.off { opacity: 0.5; }"]],
  },
  {
    ac: "Out of the way",
    what: "the graph's labels left on a phone",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /labels show on a narrow screen/,
    edits: [
      [
        "@media (max-width: 900px) { .graph .label { display: none; } }",
        "@media (max-width: 900px) { .graph .label { display: inline; } }",
      ],
    ],
  },
  {
    ac: "Out of the way",
    what: "the graph printed",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /print does not hide \.graph/,
    edits: [
      [
        "  .poster { box-shadow: none; transform: none; }\n  .graph { display: none; }",
        "  .poster { box-shadow: none; transform: none; }",
      ],
    ],
  },
  {
    ac: "Out of the way",
    what: "the graph left to the scroll under reduced motion",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /reduced motion the graph is not drawn whole/,
    edits: [["  .graph line { stroke-dashoffset: 0 !important; }\n", ""]],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "graphite's graph colour bright enough to sink the text",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^graphite: --ink-\d is \d\.\d\d:1 at its lowest/,
    edits: [["--graphite-graph: #252930;", "--graphite-graph: #3d434c;"]],
  },
  {
    ac: "Drawn as you scroll",
    what: "a layer a screen reader would announce",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /not an aria-hidden/,
    edits: [['    svg.setAttribute("aria-hidden", "true");\n', ""]],
  },
  {
    ac: "Drawn as you scroll",
    what: "a scroll listener that is not passive",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /not one passive listener/,
    edits: [
      [
        "frame = window.requestAnimationFrame(draw); }, { passive: true });",
        "frame = window.requestAnimationFrame(draw); }, { passive: false });",
      ],
    ],
  },
  {
    ac: "Drawn as you scroll",
    what: "a draw on every scroll event, not once per frame",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /asked for 0 frames; one/,
    edits: [["function () { if (!frame) frame = window.requestAnimationFrame(draw); }", "function () { draw(); }"]],
  },
  {
    ac: "Out of the way",
    what: "the graph's reduced-motion query turned around",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /under reduced motion the graph is not whole/,
    edits: [
      [
        'var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;',
        'var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: no-preference)") : null;',
      ],
    ],
  },
  {
    ac: "Alive",
    what: "the ping's keyframes renamed",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /^\.graph \.node\.ping has no animation with its @keyframes$/,
    edits: [["@keyframes graph-ping {", "@keyframes graph-pong {"]],
  },
  {
    ac: "Alive",
    what: "the script no longer marking what the scroll draws",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /do not pulse, or their nodes do not ping/,
    edits: [
      ['el.setAttribute("class", now && live ? (base + " " + name).trim() : base);', 'el.setAttribute("class", base);'],
    ],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "nodes grown past points",
    ...onText(SCRIPT, checkGraphScript),
    fact: "graph-script",
    message: /28 circles have a radius over 4 px/,
    edits: [
      [
        /c\.setAttribute\("r", "4"\);(\s*c\.setAttribute\("class", name\);)/,
        'c.setAttribute("r", name === "node" ? "9" : "4");$1',
      ],
    ],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "a beacon stronger than its bound",
    ...onText(STYLE, checkGraphBounds),
    fact: "graph-bounds",
    message: /a beacon grows past 4\.5x or 0\.55 strong/,
    edits: [["(1 - var(--p, 0)) * 0.55);", "(1 - var(--p, 0)) * 0.9);"]],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "a breathing ring that animates its stroke, which costs a layout per frame",
    ...onText(STYLE, checkGraphBounds),
    fact: "graph-bounds",
    message: /the breathing ring animates more than transform and opacity/,
    edits: [
      ["0% { transform: scale(1); opacity: 0.9; }", "0% { transform: scale(1); opacity: 0.9; stroke-width: 6; }"],
    ],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "a node painted in the accent",
    ...onText(STYLE, checkGraphBounds),
    fact: "graph-bounds",
    message: /the graph paints var\(--accent\)/,
    edits: [[".graph .beacon { fill: var(--line-5);", ".graph .beacon { fill: var(--accent);"]],
  },
  {
    ac: "Out of the way",
    what: "forced colours showing the graph",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /forced colours do not hide \.graph/,
    edits: [["@media (forced-colors: active) {\n  .graph { display: none; }\n", "@media (forced-colors: active) {\n"]],
  },
  {
    ac: "The lines keep the text readable; the nodes are exempt, within bounds",
    what: "a tone that sets no --graph",
    ...onText(STYLE, checkGraphCss),
    fact: "graph-layer",
    message: /the light tone sets no --graph/,
    edits: [["    --graph: var(--light-graph);\n", ""]],
  },
  {
    ac: "Out of the way",
    what: "a colour written into the graph by the script",
    ...onText(SCRIPT, checkScriptColours),
    fact: "script-colour",
    message: /writes the colour "#19233a"/,
    edits: [
      [
        '    svg.setAttribute("focusable", "false");\n',
        '    svg.setAttribute("focusable", "false");\n    svg.setAttribute("stroke", "#19233a");\n',
      ],
    ],
  },

  // The GitHub link story: one link to the source, its mark hidden from a
  // screen reader, its name untranslated; the word hides on a phone.
  {
    ac: "The link",
    what: "the Star button put back beside the link",
    ...onPage("en", checkSourceLink),
    fact: "source-link",
    message: /^a page still has the Star button/,
    edits: [['<a class="gh" ', `<a class="star" href="${REPO_URL}">★ Star</a><a class="gh" `]],
  },
  {
    ac: "The link",
    what: "the mark without aria-hidden",
    ...onPage("en", checkSourceLink),
    fact: "source-link",
    message: /mark is not one svg with aria-hidden/,
    edits: [['viewBox="0 0 16 16" aria-hidden="true" focusable="false"', 'viewBox="0 0 16 16" focusable="false"']],
  },
  {
    ac: "The link",
    what: "the link to another repository",
    ...onPage("en", checkSourceLink),
    fact: "source-link",
    message: /^the GitHub link goes to https:\/\/github\.com\/someone\/ProjectStore;/,
    edits: [[`<a class="gh" href="${REPO_URL}"`, '<a class="gh" href="https://github.com/someone/ProjectStore"']],
  },
  {
    ac: "The link",
    what: "a ru page whose link reads ГитХаб",
    ...onPage("ru", checkSourceLink),
    fact: "source-link",
    message: /reads "ГитХаб"/,
    edits: [["<span>GitHub</span></a>", "<span>ГитХаб</span></a>"]],
  },
  {
    ac: "Out of the way",
    what: "the GitHub link's word left on a phone",
    ...onText(STYLE, checkSourceLinkCss),
    fact: "source-link",
    message: /word shows on a phone/,
    edits: [["  .gh span { display: none; }\n", ""]],
  },
  {
    ac: "Out of the way",
    what: "the GitHub link's mark hidden on a phone too",
    ...onText(STYLE, checkSourceLinkCss),
    fact: "source-link",
    message: /mark hides under @media \(max-width: 760px\)/,
    edits: [["  .gh span { display: none; }", "  .gh svg, .gh span { display: none; }"]],
  },
  {
    ac: "Out of the way",
    what: "print no longer hiding the header",
    ...onText(STYLE, checkSourceLinkCss),
    fact: "source-link",
    message: /^print does not hide the header/,
    edits: [["  .site-header, .mobile-nav,", "  .mobile-nav,"]],
  },

  // The four-agents story: the names, the chips, no status in any language.
  {
    ac: "Four agents named",
    what: "Cursor before Gemini CLI in the hero",
    ...onPage("en", checkAgents),
    fact: "agents-named",
    message: /^the hero names Claude Code, Codex, Cursor, Gemini CLI;/,
    edits: [["<b>Gemini CLI</b> · <b>Cursor</b>", "<b>Cursor</b> · <b>Gemini CLI</b>"]],
  },
  {
    ac: "Four agents named",
    what: "a word added to the hero's agent line",
    ...onPage("en", checkAgents),
    fact: "agents-named",
    message: /^the hero's agent line reads "Claude Code · Codex \(beta\) · Gemini CLI · Cursor"/,
    edits: [["<b>Codex</b> · <b>Gemini CLI</b>", "<b>Codex</b> (beta) · <b>Gemini CLI</b>"]],
  },
  {
    ac: "Four agents named",
    what: "a chip marked experimental by its class",
    ...onPage("es", checkAgents),
    fact: "agents-named",
    message: /Codex \(class "chip exp"\)/,
    edits: [['<span class="chip">Codex</span>', '<span class="chip exp">Codex</span>']],
  },
  {
    ac: "Four agents named",
    what: "a language page that translates a name",
    ...onPage("ru", checkAgents),
    fact: "agents-named",
    message: /^the hero names Claude Code, Codex, Gemini CLI, Курсор;/,
    edits: [["<b>Cursor</b>", "<b>Курсор</b>"]],
  },
  {
    ac: "No harness status on the site",
    what: "a status marker put back on the main page",
    ...onPage("en", checkNoStatus),
    fact: "no-status",
    message: /data-fact="harness-status:codex"/,
    edits: [
      [
        '<span class="chip">Codex</span>',
        '<span class="chip">Codex · <span data-fact="harness-status:codex">ready</span></span>',
      ],
    ],
  },
  {
    ac: "No harness status on the site",
    what: "the English lede calling the Codex flow experimental",
    ...onPage("en", checkNoStatus),
    fact: "no-status",
    message: /calls Codex experimental$/,
    edits: [
      [
        "The scenes below are Claude Code.",
        "The scenes below are Claude Code; in Codex the same flow is experimental.",
      ],
    ],
  },
  {
    ac: "No harness status on the site",
    what: "the German models card calling Codex experimental",
    ...onPage("de", checkNoStatus),
    fact: "no-status",
    message: /calls Codex experimentell$/,
    edits: [[/(data-i18n="set\.models\.h">)[^<]*/, "$1Codex experimentell, nur Modelle"]],
  },
  {
    ac: "No harness status on the site",
    what: "the Russian lede calling the Codex flow experimental",
    ...onPage("ru", checkNoStatus),
    fact: "no-status",
    message: /calls Codex экспериментальн$/,
    edits: [
      [/(data-i18n="talk\.lede">[^<]*<b[^>]*>[^<]*<\/b>[^<]*)/, "$1 В Codex этот же сценарий экспериментальный."],
    ],
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

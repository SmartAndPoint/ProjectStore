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
// Python-free: the pages are site/tools/i18n.py's output, and CI proves that
// with Python 3.12 (.github/workflows/test.yml). What a stale build would get
// wrong without changing a word is checked here instead: asset hashes,
// alternates and canonicals, a page per dictionary, the en/ stub.
//
// The helpers live in this file, not in scripts/: a file there ships, and the
// runtime vocabulary lint would read their command literals.
//
//   node --test tests/site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sourceNames, invocationPatterns, stripComments } from "./fixtures/vocabulary.mjs";
import { VERBS } from "../scripts/cli.mjs";
import { languageNames } from "../scripts/binding.mjs";
import { TOOLS } from "../scripts/mcp.mjs";
import { loadHarness, sourceHarness, uiWordPatterns } from "../scripts/harness.mjs";
import { slugify, anchorKeyOf, foldAnchor, emptyAnchorState, composeAnchorName, ANCHOR_SETTLE } from "../scripts/lib.mjs";
import { NOT_SHIPPED } from "../scripts/version-guard.mjs";
import { SHELLS, publishable } from "../packaging/shells.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "site";
const ORIGIN = "https://projectstore.dev/";
// The git channel installs every byte of main, site/ included (the site ADR,
// decision 4), so the site has a budget: 2.5 MiB.
const BUDGET = 2621440;
const REPO_URL = "https://github.com/SmartAndPoint/ProjectStore";
const SCREENSHOT = ["site/assets/statusline-hud.png", "docs/images/statusline-hud.png"];
const LLMS = ["site/llms.txt", "site/llms-full.txt"];
const STUB_FILE = "site/en/index.html";
// What tools/i18n.py writes at en/: the old address, redirected to the root.
const STUB = '<!doctype html><meta charset="utf-8"><title>ProjectStore</title><link rel="canonical" href="../"><meta http-equiv="refresh" content="0; url=../"><a href="../">ProjectStore</a>\n';
// A copy of LANGS in tools/i18n.py — code to the BCP 47 tag of <html lang> and
// hreflang. A test below holds the copy to the original.
const LANG_TAGS = { en: "en", de: "de", es: "es", fr: "fr", pt: "pt-BR", ru: "ru", uk: "uk", zh: "zh-CN" };
const DEFAULT_LANG = "en";
// "A Claude Code plugin" as each page said it before the refresh, from its
// hero and description keys (AC: the phrase and its seven translations).
const RETIRED = ["a Claude Code plugin", "ein Claude-Code-Plugin", "un plugin de Claude Code", "un plugin Claude Code", "um plugin do Claude Code", "плагин для Claude Code", "плагін для Claude Code", "一个 Claude Code 插件"];
// The example epic's id: an id, so English and the same on every page.
const EXAMPLE_EPIC = "PAY-001";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha8 = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 8);

// ─── HTML, without a parser ────────────────────────────────────────────
//
// The pages are rendered from one template and well-formed, and the checks
// need little: start tags, their attributes, an element's text. Comments and
// the bodies of <script> and <style> are not markup — they are dropped before
// tags are read, and read on their own where a check needs them.

const OPEN = /<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ANY_TAG = /<\/?[a-z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const RAW_BODY = /(<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const rawBodies = (html, name) => [...withoutComments(html).matchAll(RAW_BODY)].filter((m) => m[2].toLowerCase() === name).map((m) => m[3]);

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
  for (let m; (m = re.exec(markup)); ) {
    if (m[1]) {
      if (--depth === 0) return markup.slice(el.end, m.index);
    } else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  return markup.slice(el.end);
}

const textOf = (markup) => decode(markup.replace(ANY_TAG, ""));

// A page as the checks read it: every element in document order, with its
// attributes, its inner markup, its text and whether it is a leaf.
function parse(file, html, lang = null) {
  const markup = withoutComments(html).replace(RAW_BODY, "$1$4");
  const els = [...markup.matchAll(OPEN)].map((m) => {
    const el = { name: m[1].toLowerCase(), attrs: attributes(m[2]), start: m.index, end: m.index + m[0].length, selfClosed: /\/\s*$/.test(m[2]) };
    el.inner = innerOf(markup, el);
    el.text = textOf(el.inner);
    el.leaf = !/<[a-z/!]/i.test(el.inner);
    return el;
  });
  return { file, lang, html, markup, els };
}

// What a reader sees or copies: the text — every tag a space, so two elements
// never run together — and every attribute value.
const readable = (page) => [decode(page.markup.replace(ANY_TAG, " ")), ...page.els.flatMap((el) => Object.values(el.attrs))];
const marked = (page, pred = () => true) => page.els.filter((el) => "data-fact" in el.attrs && pred(el.attrs["data-fact"]));
const withAttr = (page, name) => page.els.filter((el) => name in el.attrs);
const hasClass = (el, c) => (el.attrs.class || "").split(/\s+/).includes(c);
const within = (outer, el) => el.start >= outer.start && el.start < outer.end + outer.inner.length;

// What a copy button copies (assets/site.js): its target's data-copy, else
// the target's text. Targets are named by data-copy-from; an element that
// carries data-copy is one too.
function copyBlocks(page) {
  const ids = new Set(page.els.filter((el) => el.attrs["data-copy-from"]).map((el) => el.attrs["data-copy-from"]));
  return page.els.filter((el) => ids.has(el.attrs.id) || "data-copy" in el.attrs).map((el) => ({ el, value: el.attrs["data-copy"] ?? el.text }));
}

// ─── Markdown: headings, fences, anchors ───────────────────────────────

// Each line with the heading it is, or whether a fence holds it. A fence
// opens with three backticks or tildes and closes with a bare run of the same
// character at least as long; a line inside one is never a heading.
function* markdownLines(md) {
  let fence = null;
  for (const line of md.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      else yield { line, fenced: true, heading: null };
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    yield { line, fenced: false, heading: h ? { level: h[1].length, text: h[2] } : null };
  }
}

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

// A command line as README and the site are compared: trimmed, and cut at
// the first " #" (README's comments on a fenced line).
const cut = (line) => {
  const t = line.trim();
  const i = t.indexOf(" #");
  return (i === -1 ? t : t.slice(0, i)).trim();
};

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

// A shell prompt in front of a command is not part of it.
const unprompt = (line) => line.trim().replace(/^[$%>]\s+/, "");

// npx's own options come before the command: `npx -y …`, `npx --yes -p
// <pkg>@<v> <bin> …`. Returns the command (a package or bin name, an
// @<version> allowed), its first argument, and the packages -p names.
const NPX_VALUE_OPTIONS = new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "-c", "--call", "-w", "--workspace", "--node-options", "--script-shell"]);
function npxCommand(line) {
  const toks = unprompt(line).split(/\s+/);
  if (toks[0] !== "npx") return null;
  const packages = [];
  let i = 1;
  for (; i < toks.length && toks[i].startsWith("-"); i++) {
    const eq = toks[i].indexOf("=");
    const name = eq === -1 ? toks[i] : toks[i].slice(0, eq);
    if (!NPX_VALUE_OPTIONS.has(name)) continue;
    const value = eq === -1 ? toks[++i] : toks[i].slice(eq + 1);
    if (name === "-p" || name === "--package") packages.push((value || "").replace(/^["']|["']$/g, ""));
  }
  if (i >= toks.length) return null;
  return { command: toks[i], verb: toks[i + 1] ?? null, packages };
}
const packageName = (spec) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

// ─── The repository's side ─────────────────────────────────────────────

// The headings under which README may fence an install, upgrade or uninstall
// command (AC 4). README fences commands only under the first today.
const INSTALL_HEADINGS = ["Install — one message", "Upgrading", "Uninstalling"];

// The frontmatter keys and "## " headings of a template, as the product writes it.
function templateShape(md) {
  const lines = md.split("\n");
  const close = lines.indexOf("---", 1);
  const keys = new Set(lines.slice(1, close).map((l) => /^([a-z_]+):/.exec(l)?.[1]).filter(Boolean));
  const headings = new Set(lines.slice(close + 1).map((l) => /^## (.+?)\s*$/.exec(l)?.[1]).filter(Boolean));
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
    harnesses: SHELLS.filter((s) => published.includes(s.name)).map((s) => ({ id: s.harness, display: loadHarness(s.harness)?.display_name ?? s.display })),
    // Contract 16 of the generation spec: experimental exactly while the
    // manifest's `verified` is null — the derivation docs/harnesses.md is
    // held to in tests/portability.test.mjs.
    status: (id) => {
      const m = loadHarness(id);
      return m ? (m.verified === null ? "experimental" : "supported") : null;
    },
    readme: fencedLines(read("README.md")),
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

// Every page: one per dictionary, the English one at the root.
function sitePages(root = ROOT) {
  const langs = readdirSync(join(root, SITE, "locales")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  return langs.map((lang) => {
    const file = lang === DEFAULT_LANG ? `${SITE}/index.html` : `${SITE}/${lang}/index.html`;
    return { lang, file, html: existsSync(join(root, file)) ? read(file) : null };
  });
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
// install section and <meta name="description">.
function checkHarnessesNamed(page, repo) {
  const out = [];
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "description");
  const hero = page.els.find((el) => el.name === "section" && hasClass(el, "hero"));
  const start = page.els.find((el) => el.name === "section" && el.attrs.id === "start");
  const places = [
    ['<meta name="description">', meta ? meta.attrs.content ?? "" : null],
    ["the hero", hero ? hero.text : null],
    ["the install section", start ? start.text : null],
  ];
  for (const [where, text] of places) {
    if (text === null) {
      out.push(finding(page.file, "harnesses", `${where} is missing`));
      continue;
    }
    for (const h of repo.harnesses) {
      if (!text.includes(h.display)) out.push(finding(page.file, `harness:${h.id}`, `${where} does not name ${h.display}, whose shell is published`));
    }
  }
  return out;
}

// AC 3: no page and no llms file calls ProjectStore a Claude Code plugin.
function checkWording(file, texts) {
  const all = texts.join("\n").replace(/\s+/g, " ").toLowerCase();
  return RETIRED.filter((p) => all.includes(p.toLowerCase())).map((p) => finding(file, "wording", `"${p}": the plugin is no longer one harness's`));
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
        if (!g.names.has(m[1])) out.push(finding(file, "invocation", `${m[0]} (the ${[...g.harnesses].join("/")} form) names no file in commands/ or agents/`));
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
    for (const m of text.matchAll(/(?<![\w-])npx[ \t][^\n]*/g)) {
      const cmd = npxCommand(m[0]);
      if (!cmd) continue;
      const name = packageName(cmd.command);
      for (const p of cmd.packages.map(packageName).filter(ours)) {
        if (!repo.packages.includes(p) && !repo.privateShells.includes(p)) out.push(finding(file, "npx", `${cut(m[0])}: ${p} is not a published package (${repo.packages.join(", ")})`));
      }
      if (!ours(name) || repo.privateShells.includes(name)) continue;
      if (!repo.packages.includes(name)) out.push(finding(file, "npx", `${cut(m[0])}: ${name} is not a published package (${repo.packages.join(", ")})`));
      else if (cmd.verb && /^[a-z]/.test(cmd.verb) && !repo.verbs.includes(cmd.verb)) out.push(finding(file, "npx", `${cut(m[0])}: the ${name} bin has no verb "${cmd.verb}"`));
    }
    for (const name of repo.privateShells) {
      if (new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(text)) out.push(finding(file, "npx", `${name} is not published (private in packaging/shells.mjs)`));
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
  if (cmd && /^projectstore(-[a-z0-9]+)?(@\S+)?$/.test(cmd.command) && ["install", "upgrade", "uninstall", "plan", "setup"].includes(cmd.verb)) return true;
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
  return lang && repo.languages.includes(lang) && BIND_LINE.test(line) && line.endsWith(suffix) ? line.slice(0, -suffix.length) : line;
}

function readmeInstallLines(repo) {
  return new Set(INSTALL_HEADINGS.flatMap((h) => repo.readme.get(h) || []));
}

function checkInstall(page, repo) {
  const out = [];
  const readme = readmeInstallLines(repo);
  const blocks = marked(page, (f) => f === "install");
  for (const el of blocks) {
    if ("data-copy" in el.attrs && el.attrs["data-copy"] !== el.text) out.push(finding(page.file, "install", `a marked block shows ${JSON.stringify(el.text)} but copies ${JSON.stringify(el.attrs["data-copy"])}`));
    for (const line of el.text.split("\n").map(cut).filter(Boolean)) {
      const bare = withoutLangSuffix(unprompt(line), page.lang, repo);
      if (!readme.has(bare)) out.push(finding(page.file, "install", `"${line}" is no line README fences under ${INSTALL_HEADINGS.map((h) => `"${h}"`).join(", ")}`));
    }
  }
  for (const el of page.els) {
    if (blocks.some((b) => within(b, el))) continue;
    const texts = [];
    if ("data-copy" in el.attrs) texts.push(el.attrs["data-copy"]);
    if (el.name === "pre" || el.name === "code") texts.push(el.text);
    for (const line of texts.flatMap((t) => t.split("\n"))) {
      if (installForm(line, repo)) out.push(finding(page.file, "install", `"${cut(line)}" is an install, upgrade or uninstall command outside a block marked data-fact="install"`));
    }
  }
  return unique(out);
}

// AC 4: a block's data-copy is the lines it shows, each cut at its comment —
// so what lands on the clipboard is what the markers above it were checked on.
function checkCopies(page) {
  const lines = (t) => t.split("\n").map(cut).filter(Boolean);
  return page.els.filter((el) => "data-copy" in el.attrs).flatMap((el) => {
    const copied = lines(el.attrs["data-copy"]);
    const shown = lines(el.text);
    const i = copied.findIndex((l, k) => l !== shown[k]);
    if (i === -1 && copied.length === shown.length) return [];
    const at = i === -1 ? Math.min(copied.length, shown.length) : i;
    return [finding(page.file, "copy", `#${el.attrs.id || el.name} copies ${JSON.stringify(copied[at] ?? null)} where it shows ${JSON.stringify(shown[at] ?? null)}`)];
  });
}

// The llms files have no markers: every install command they show is README's.
function checkInstallLines(file, lines, repo) {
  const readme = readmeInstallLines(repo);
  return unique(lines.filter((l) => installForm(l, repo) && !readme.has(cut(unprompt(l))))
    .map((l) => finding(file, "install", `"${cut(l)}" is no line README fences under ${INSTALL_HEADINGS.map((h) => `"${h}"`).join(", ")}`)));
}

// AC 4: a --lang or --language value is a language ProjectStore ships
// templates for.
function checkLangFlags(file, texts, repo) {
  const out = [];
  for (const text of texts) {
    for (const m of text.matchAll(/--lang(?:uage)?(?:[ \t]+|=)([^\s"'`<>)\]]+)/g)) {
      for (const code of m[1].replace(/[.,;:]+$/, "").split("|")) {
        if (!repo.languages.includes(code)) out.push(finding(file, "lang", `--lang ${code}: ProjectStore ships templates for ${repo.languages.join(", ")}`));
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
    .map((el) => finding(page.file, "version", `says ${JSON.stringify(el.text.trim())}; package.json is ${repo.version}`));
  let rest = page.markup;
  for (const el of marked(page, (f) => f === "version").sort((a, b) => b.start - a.start)) rest = rest.slice(0, el.end) + rest.slice(el.end + el.inner.length);
  for (const m of decode(rest.replace(ANY_TAG, " ")).matchAll(VERSION_WORDS)) {
    out.push(finding(page.file, "version", `"${m[0]}" outside a data-fact="version"`));
  }
  for (const el of page.els) {
    for (const [name, value] of Object.entries(el.attrs)) {
      for (const m of value.matchAll(VERSION_WORDS)) out.push(finding(page.file, "version", `"${m[0]}" in the ${name} attribute of <${el.name}>, outside a data-fact="version"`));
    }
  }
  return unique(out);
}

function checkVersionText(file, text, repo) {
  return unique([...text.matchAll(VERSION_WORDS)].filter((m) => (m[1] ?? m[2]) !== repo.version).map((m) => finding(file, "version", `"${m[0]}"; package.json is ${repo.version}`)));
}

// AC 4: a link into the repository names a path that exists on main, and an
// anchor names a heading of its markdown file (README.md for the root).
const REPO_LINK = new RegExp(`^${escape(REPO_URL)}(?:/(blob|tree)/main/([^?#]+))?/?(?:#(.*))?$`);
function checkRepoLink(file, url, repo) {
  const m = REPO_LINK.exec(url);
  if (!m) return [];
  const rel = m[2] ? decodeURIComponent(m[2]).replace(/\/$/, "") : "README.md";
  if (rel.split("/").includes("..") || !repo.exists(rel)) return [finding(file, "link", `${url}: no ${rel} on main`)];
  if (m[3] && rel.endsWith(".md") && !repo.anchorsOf(rel).includes(m[3])) return [finding(file, "link", `${url}: ${rel} has no heading #${m[3]}`)];
  return [];
}
const checkLinks = (page, repo) => unique(page.els.filter((el) => el.attrs.href).flatMap((el) => checkRepoLink(page.file, el.attrs.href, repo)));
const markdownUrls = (md) => [...md.matchAll(/\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![(<])\b(https?:\/\/[^\s)>`'"]+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).replace(/[.,;:]+$/, ""));
const checkTextLinks = (file, md, repo) => unique(markdownUrls(md).flatMap((u) => checkRepoLink(file, u, repo)));

// AC 4: the counts are the repository's, as digits; the MCP tools listed are
// its tools, each once.
const COUNTS = ["commands", "agents", "languages", "mcp-tools"];
function checkCounts(page, repo) {
  const out = marked(page, (f) => COUNTS.includes(f)).flatMap((el) => {
    const fact = el.attrs["data-fact"];
    const said = el.text.trim();
    return said === String(repo.counts[fact]) ? [] : [finding(page.file, fact, `says ${JSON.stringify(said)}; the repository has ${repo.counts[fact]}`)];
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
    if (missing.length || extra.length) out.push(finding(page.file, "mcp-tool", `the listed tools differ from scripts/mcp.mjs TOOLS: ${[...missing.map((t) => `missing ${t}`), ...extra.map((t) => `not a tool, or twice: ${t}`)].join("; ")}`));
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
    return said === want ? [] : [finding(page.file, fact, `says ${JSON.stringify(said)}; ${id}'s manifest has verified ${want === "experimental" ? "null" : "set"}, so it is ${want}`)];
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
  let v = value.split("\n").map((l) => withoutLangSuffix(l.trimEnd(), page.lang, repo)).join("\n");
  for (const s of pageSlugs(page, repo)) v = v.split(s).join("‹slug›");
  return v.replace(/"[^"]*"/g, '"…"');
}
function checkParity(en, page, repo) {
  const lists = (p) => ({
    ids: p.els.filter((el) => "id" in el.attrs).map((el) => el.attrs.id),
    "data-fact": marked(p).map((el) => el.attrs["data-fact"]),
    "fact values": marked(p, VALUE_FACTS).map((el) => `${el.attrs["data-fact"]}=${el.text.trim()}`),
    install: marked(p, (f) => f === "install").map((el) => el.text.split("\n").map((l) => withoutLangSuffix(l, p.lang, repo)).join("\n")),
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
      out.push(finding(page.file, key, `#${i + 1} is ${JSON.stringify(b[key][i] ?? null)}; ${en.file} has ${JSON.stringify(a[key][i] ?? null)}${counts}`));
      if (!aligned) break;
    }
  }
  return out;
}

// AC 4: every page carries every fact a check reads, so removing a marker
// cannot switch a check off — the example artifacts' data-template among them;
// and a value fact is a leaf, its text the fact.
const REQUIRED = ["version", "commands", "agents", "languages", "mcp-tools", "mcp-tool", "install"];
const REQUIRED_TEMPLATES = ["adr", "spec", "story"];
function checkRequired(page, repo) {
  const have = new Set(marked(page).map((el) => el.attrs["data-fact"]));
  const out = [...REQUIRED, ...repo.harnesses.map((h) => `harness-status:${h.id}`)]
    .filter((f) => !have.has(f))
    .map((f) => finding(page.file, f, `no element is marked data-fact="${f}"`));
  const templates = new Set(withAttr(page, "data-template").map((el) => el.attrs["data-template"]));
  for (const kind of REQUIRED_TEMPLATES) {
    if (!templates.has(kind)) out.push(finding(page.file, `template:${kind}`, `no example is marked data-template="${kind}"`));
  }
  for (const el of marked(page, VALUE_FACTS)) {
    if (!el.leaf) out.push(finding(page.file, el.attrs["data-fact"], `a value fact is a leaf; this <${el.name}> holds markup`));
  }
  if (!withAttr(page, "data-source").length) out.push(finding(page.file, "data-source", "no measured figure is marked data-source"));
  return out;
}

// AC 4: nothing loads from another origin, and everything the site loads is
// a file under site/. A load is a <link>, <script src>, <img src> or srcset,
// <source>, <iframe> or <use href> value, a CSS url() or @import, or a fetch(
// or import( in a script, whose target has a scheme or starts with "//". A
// data: URI is the page's own; an <a href> is navigation. A <link> whose
// every rel fetches nothing (canonical, alternate) is not a load either, but
// it points at the site: relative, or under https://projectstore.dev/.
const LOADS = { link: ["href"], script: ["src"], img: ["src", "srcset"], source: ["src", "srcset"], iframe: ["src"], use: ["href", "xlink:href"] };
const NON_FETCHING_RELS = new Set(["canonical", "alternate", "author", "help", "license", "next", "prev"]);
const foreign = (url) => {
  const u = url.trim();
  return u.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^data:/i.test(u));
};
const srcset = (value) => value.split(/,\s+/).map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);

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
  return [...stripComments(js).matchAll(/(?<![\w$.])(fetch|import)\s*\(\s*(?:(["'`])((?:(?!\2)[^\\]|\\.)*)\2)?/g)].map((m) => [`${m[1]}(`, m[3] ?? null]);
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
  isFile: (rel) => { try { return statSync(join(ROOT, rel)).isFile(); } catch { return false; } },
  isDir: (rel) => { try { return statSync(join(ROOT, rel)).isDirectory(); } catch { return false; } },
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
    if (own !== null && !own.startsWith(`${SITE}/`) && own !== SITE) out.push(finding(file, "load", `${what} ${url} leaves site/`));
    else if (own !== null && missingTarget(own, fsys)) out.push(finding(file, "load", `${what} ${url}: no ${missingTarget(own, fsys)}`));
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
      if (foreign(href) && !href.startsWith(ORIGIN)) out.push(finding(file, "load", `<link rel="${el.attrs.rel}"> points at ${href}, not under ${ORIGIN}`));
      continue;
    }
    for (const a of LOADS[el.name] || []) {
      if (a in el.attrs) for (const url of a === "srcset" ? srcset(el.attrs[a]) : [el.attrs[a]]) add(`<${el.name} ${a}>`, url);
    }
    for (const [a, v] of Object.entries(el.attrs)) {
      if (/url\(|@import/i.test(v)) for (const [what, url] of cssLoads(v)) add(`${what} in <${el.name} ${a}>`, url);
    }
  }
  for (const css of rawBodies(text, "style")) for (const [what, url] of cssLoads(css)) add(`${what} in <style>`, url);
  for (const js of rawBodies(text, "script")) for (const [what, url] of scriptLoads(js)) add(`${what} in <script>`, url);
  return unique(out);
}

// AC 4: site/ stays within its budget.
function checkBudget(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  return total > BUDGET ? [finding(`${SITE}/`, "budget", `${total} bytes in ${files.length} files; the budget is ${BUDGET}`)] : [];
}

// AC 4: the screenshot is the repository's own.
function checkScreenshot(site, docs) {
  return Buffer.compare(site, docs) === 0 ? [] : [finding(SCREENSHOT[0], "screenshot", `differs from ${SCREENSHOT[1]} (${site.length} vs ${docs.length} bytes)`)];
}

// AC 6: a measured figure carries data-source — README.md or a docs/ page and
// the anchor of the passage it comes from — and that heading exists.
function checkSources(page, repo) {
  return withAttr(page, "data-source").flatMap((el) => {
    const v = el.attrs["data-source"];
    const m = /^(README\.md|docs\/[\w./-]+\.md)#(.+)$/.exec(v);
    if (!m || m[1].split("/").includes("..")) return [finding(page.file, "data-source", `"${v}" is not README.md or a docs/ page with an anchor`)];
    if (!repo.exists(m[1])) return [finding(page.file, "data-source", `"${v}": no ${m[1]} in the repository`)];
    return repo.anchorsOf(m[1]).includes(m[2]) ? [] : [finding(page.file, "data-source", `"${v}": ${m[1]} has no heading #${m[2]}`)];
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
    const lines = textOf(el.inner.replace(/<span class="line-number">[^<]*<\/span>/g, "")).split("\n").map((l) => l.trimEnd());
    // The block opens with its frontmatter, as a file the product writes does:
    // a "---" first, a "---" to close it, and between them "key: value" lines
    // (or a YAML list item under one). A block that is not that is reported,
    // not skipped: a check that cannot read the example has not checked it.
    const open = lines.findIndex((l) => l.trim() !== "");
    const close = lines[open]?.trim() === "---" ? lines.findIndex((l, i) => i > open && l.trim() === "---") : -1;
    if (close === -1) {
      out.push(finding(page.file, `template:${kind}`, `the example has no frontmatter between "---" lines to check against ${tpl.rel}`));
      continue;
    }
    const unreadable = lines.slice(open + 1, close).find((l) => l.trim() && !/^\s*[a-z_]+:(\s|$)/.test(l) && !/^\s+-\s/.test(l) && !/^\s*-\s/.test(l));
    if (unreadable !== undefined) {
      out.push(finding(page.file, `template:${kind}`, `frontmatter line ${JSON.stringify(unreadable.trim())} is not "key: value"`));
      continue;
    }
    for (const line of lines.slice(open + 1, close)) {
      const m = /^\s*([a-z_]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (!tpl.keys.has(m[1])) out.push(finding(page.file, `template:${kind}`, `frontmatter key "${m[1]}" is not in ${tpl.rel}`));
      if (m[1] === "review_status" && !REVIEW_STATUS.includes(m[2].trim())) out.push(finding(page.file, `template:${kind}`, `review_status: ${m[2].trim()} — the product writes ${REVIEW_STATUS.join(" or ")}`));
    }
    for (const line of lines.slice(close + 1)) {
      const h = /^\s*## (.+?)\s*$/.exec(line);
      if (h && !tpl.headings.has(h[1])) out.push(finding(page.file, `template:${kind}`, `heading "## ${h[1]}" is not one of ${tpl.rel}'s`));
    }
  }
  return unique(out);
}

// AC 5: the product stopped making numbered names on 2026-08-09.
const NUMBERED = /\b(?:ADR-\d+|SPEC-\d+|story-\d+)\b/g;
const checkNumbered = (file, texts) => unique(texts.flatMap((t) => [...t.matchAll(NUMBERED)].map((m) => finding(file, "numbered", `"${m[0]}": artifacts are named by slug since 2026-08-09`))));

// AC 5: every path or session name made from an example title is what the
// core makes of that page's title (data-title → data-slug="<kind>:<form>"),
// a slug never keeps a Cyrillic letter, and no example path goes unmarked.
const EXAMPLE_PATH = /(?<![\w/.-])(?:adr|specs)\/(?!README\.md)[^\s"'<>|\]()`]+\.md|stories\/story-[^\s"'<>|\]()`]+/g;
function checkSlugs(page, repo) {
  const out = [];
  const titles = new Map();
  for (const el of withAttr(page, "data-title")) {
    const kind = el.attrs["data-title"];
    if (titles.has(kind) && titles.get(kind) !== el.text) out.push(finding(page.file, `title:${kind}`, `the ${kind} title is ${JSON.stringify(el.text)} here and ${JSON.stringify(titles.get(kind))} elsewhere on the page`));
    else titles.set(kind, el.text);
  }
  for (const el of withAttr(page, "data-slug")) {
    const [kind, form] = el.attrs["data-slug"].split(":");
    const title = titles.get(kind);
    const want = title === undefined ? null : repo.derive(kind, form, title);
    if (title === undefined) out.push(finding(page.file, `slug:${kind}`, `data-slug="${kind}:${form}" with no data-title="${kind}" on the page`));
    else if (want === null) out.push(finding(page.file, `slug:${kind}`, `data-slug="${kind}:${form}" is no form the test knows`));
    else if (el.text !== want) out.push(finding(page.file, `slug:${kind}`, `shows ${JSON.stringify(el.text)}; slugify makes ${JSON.stringify(want)} of ${JSON.stringify(title)}`));
  }
  // A title whose slug keeps a Cyrillic letter (і ї є ґ today) makes a mixed-script file
  // name: such a page keeps its example titles in English. Reported once, at the title.
  for (const [kind, title] of titles) {
    if (/[\u0400-\u04ff]/.test(slugify(title))) out.push(finding(page.file, `slug:${kind}`, `slugify keeps a Cyrillic letter of ${JSON.stringify(title)}; a title it cannot transliterate stays English`));
  }
  let rest = page.markup;
  for (const el of withAttr(page, "data-slug").sort((a, b) => b.start - a.start)) rest = rest.slice(0, el.end) + rest.slice(el.end + el.inner.length);
  for (const m of decode(rest.replace(ANY_TAG, "")).matchAll(EXAMPLE_PATH)) out.push(finding(page.file, "slug", `example path "${m[0]}" is not marked data-slug`));
  return unique(out);
}

// AC 2, the freshness the build would show: each page's ?v= is its asset's
// hash, as tools/i18n.py computes it (asset_versions: SHA-1, eight hex digits).
function checkAssetVersions(page, hashes) {
  const out = [];
  for (const [asset, hash] of Object.entries(hashes)) {
    const refs = [...page.html.matchAll(new RegExp(`(?:\\.\\./)?${escape(asset)}(?:\\?v=([0-9a-f]*))?(?=["'])`, "g"))];
    if (!refs.length) out.push(finding(page.file, "asset", `no reference to ${asset}`));
    for (const r of refs) if (r[1] !== hash) out.push(finding(page.file, "asset", `${r[0]}: ${asset} hashes to ${hash}`));
  }
  return unique(out);
}

// A page exists exactly when its dictionary does.
function checkPageSet(langs, pageDirs, isFile) {
  const out = [];
  for (const lang of langs) {
    const file = lang === DEFAULT_LANG ? `${SITE}/index.html` : `${SITE}/${lang}/index.html`;
    if (!isFile(file)) out.push(finding(file, "page", `site/locales/${lang}.json has no page`));
    if (!(lang in LANG_TAGS)) out.push(finding(`${SITE}/locales/${lang}.json`, "page", `${lang} is not in tools/i18n.py LANGS`));
  }
  for (const dir of pageDirs) if (!langs.includes(dir)) out.push(finding(`${SITE}/${dir}/index.html`, "page", `a page with no site/locales/${dir}.json`));
  return out;
}

// Every page lists every page as an alternate, x-default the English one, and
// itself as canonical, all under https://projectstore.dev/, with its own tag
// as <html lang>.
const pageUrl = (lang) => (lang === DEFAULT_LANG ? ORIGIN : `${ORIGIN}${lang}/`);
function checkAlternates(page, langs) {
  const out = [];
  const html = page.els.find((el) => el.name === "html");
  if (html?.attrs.lang !== LANG_TAGS[page.lang]) out.push(finding(page.file, "lang", `<html lang="${html?.attrs.lang}">; ${page.lang} is ${LANG_TAGS[page.lang]}`));
  const links = page.els.filter((el) => el.name === "link");
  const alternates = new Map(links.filter((el) => el.attrs.rel === "alternate" && el.attrs.hreflang).map((el) => [el.attrs.hreflang, el.attrs.href]));
  const want = new Map([...langs.map((l) => [LANG_TAGS[l], pageUrl(l)]), ["x-default", pageUrl(DEFAULT_LANG)]]);
  for (const [tag, href] of want) if (alternates.get(tag) !== href) out.push(finding(page.file, "alternate", `hreflang="${tag}" is ${JSON.stringify(alternates.get(tag) ?? null)}; want ${href}`));
  for (const tag of alternates.keys()) if (!want.has(tag)) out.push(finding(page.file, "alternate", `hreflang="${tag}" names no page`));
  const canon = links.filter((el) => el.attrs.rel === "canonical").map((el) => el.attrs.href);
  if (canon.length !== 1 || canon[0] !== pageUrl(page.lang)) out.push(finding(page.file, "canonical", `canonical ${JSON.stringify(canon)}; want ${pageUrl(page.lang)}`));
  return out;
}

const checkStub = (text) => (text === STUB ? [] : [finding(STUB_FILE, "stub", `is not the redirect tools/i18n.py writes: ${JSON.stringify(text)}`)]);

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
  if (cmds && Number(cmds[1]) !== repo.counts.commands) out.push(finding(file, "commands", `${cmds[1]} commands; the repository has ${repo.counts.commands}`));
  const agents = one(/^- (\d+) bundled agents\b/, "agents");
  if (agents && Number(agents[1]) !== repo.counts.agents) out.push(finding(file, "agents", `${agents[1]} bundled agents; the repository has ${repo.counts.agents}`));
  const tools = one(/^- (\d+) read-only MCP tools: ((?:`[a-z_]+`(?:, )?)+)/, "mcp-tools");
  if (tools) {
    const listed = [...tools[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    if (Number(tools[1]) !== repo.counts["mcp-tools"]) out.push(finding(file, "mcp-tools", `${tools[1]} MCP tools; the repository has ${repo.counts["mcp-tools"]}`));
    if ([...listed].sort().join() !== [...repo.tools].sort().join()) out.push(finding(file, "mcp-tool", `lists ${listed.join(", ")}; scripts/mcp.mjs has ${repo.tools.join(", ")}`));
  }
  const langs = one(/Templates ship in (\d+) languages: ([a-z, ]+)/, "languages");
  if (langs) {
    const codes = langs[2].split(/,\s*/).map((c) => c.trim()).filter(Boolean);
    if (Number(langs[1]) !== repo.counts.languages || codes.join() !== repo.languages.join()) out.push(finding(file, "languages", `${langs[1]} languages: ${codes.join(", ")}; templates/ has ${repo.languages.join(", ")}`));
  }
  const harn = one(/^- Harnesses: (.+)$/, "harnesses");
  if (harn) {
    const said = new Map([...harn[1].matchAll(/([A-Z][\w ]*?) \((supported|experimental)\)/g)].map((m) => [m[1].trim(), m[2]]));
    for (const h of repo.harnesses) {
      if (!said.has(h.display)) out.push(finding(file, `harness:${h.id}`, `the harness line does not name ${h.display}, whose shell is published`));
      else if (said.get(h.display) !== repo.status(h.id)) out.push(finding(file, `harness-status:${h.id}`, `${h.display} (${said.get(h.display)}); its manifest makes it ${repo.status(h.id)}`));
    }
  }
  return out;
}

// llms.txt links every page; a link under https://projectstore.dev/ in either
// file resolves to a file under site/ (a directory to its index.html), and no
// link is site-relative.
function checkLlmsLinks(file, text, langs, fsys = SITE_FS) {
  const out = [];
  const urls = markdownUrls(text);
  if (file.endsWith("/llms.txt")) {
    for (const l of langs) if (!urls.includes(pageUrl(l))) out.push(finding(file, "pages", `does not link ${pageUrl(l)}`));
  }
  for (const u of urls) {
    if (!u.startsWith(ORIGIN)) continue;
    const missing = missingTarget(ownTarget(file, u), fsys);
    if (missing) out.push(finding(file, "link", `${u}: no ${missing}`));
  }
  for (const m of text.matchAll(/\]\((\/[^)\s]*)\)/g)) out.push(finding(file, "link", `${m[1]} is site-relative; write ${ORIGIN.slice(0, -1)}${m[1]}`));
  return unique(out);
}

// ─── The real site ─────────────────────────────────────────────────────

const REPO = repository();
const PAGES = sitePages().map((p) => ({ ...p, page: p.html === null ? null : parse(p.file, p.html, p.lang) }));
const LANGS = PAGES.map((p) => p.lang);
const EN = PAGES.find((p) => p.lang === DEFAULT_LANG);
const HASHES = Object.fromEntries(["assets/style.css", "assets/site.js"].map((a) => [a, sha8(readFileSync(join(ROOT, SITE, a)))]));
const PAGE_DIRS = readdirSync(join(ROOT, SITE), { withFileTypes: true }).filter((e) => e.isDirectory() && !["en", "src"].includes(e.name) && existsSync(join(ROOT, SITE, e.name, "index.html"))).map((e) => e.name);
const show = (findings) => findings.map((f) => `${f.page} [${f.fact}] ${f.message}`).join("\n");
const eachPage = (check) => PAGES.filter((p) => p.page).flatMap((p) => check(p.page));

test("site: the sources the checks read are there — README's three headings and its install lines, the published harnesses' manifests, LANGS as i18n.py has it", () => {
  for (const h of INSTALL_HEADINGS) assert.ok(REPO.readme.has(h), `README has no "${h}" heading, and the install check reads the lines under it`);
  assert.ok(REPO.readme.get(INSTALL_HEADINGS[0]).length > 0, "README fences its install lines");
  assert.ok(REPO.harnesses.length > 0, "at least one shell is published");
  for (const h of REPO.harnesses) assert.ok(REPO.status(h.id), `${h.id}: a published shell's harness has a manifest`);
  assert.ok(REPO.forms.length > 0 && REPO.forms.every((p) => typeof p.guard === "string"), "every invocation pattern carries its guard");
  for (const k of ["adr", "spec", "story"]) assert.ok(REPO.template("en", k), `templates/en/${k}.md.tmpl`);
  const py = [...read("site/tools/i18n.py").matchAll(/^\s+\("([a-z]+)", "[^"]+", "([A-Za-z-]+)"\),$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(py), LANG_TAGS, "the test's copy of LANGS is tools/i18n.py's");
  for (const m of MENU_WORDS.keys()) assert.ok(REPO.uiWords.some((p) => p.word === m), `${m} is a ui_vocabulary word`);
  assert.ok(PAGES.length >= 2, "an English page and at least one language page");
});

test("site: the slugger gives GitHub's anchors — the ones README's own links use, the manifest's install link, repeats and fences", () => {
  const links = [...read("README.md").matchAll(/\]\(\.\/(docs\/[\w./-]+\.md)#([^)]+)\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(links.length > 0, "README links into a docs/ heading");
  for (const [rel, a] of links) assert.ok(anchors(read(rel)).includes(a), `${rel}#${a}`);
  const install = new URL(sourceHarness().install.docs);
  assert.ok(anchors(read("README.md")).includes(install.hash.slice(1)), `the manifest's ${install.href}`);
  for (const h of INSTALL_HEADINGS) assert.ok(anchors(read("README.md")).includes(slug(h)), h);
  assert.equal(slug("What it costs — measured, not promised"), "what-it-costs--measured-not-promised");
  assert.equal(slug("Surviving `/compact`"), "surviving-compact");
  assert.equal(slug("The epic ↔ code mapping"), "the-epic--code-mapping");
  assert.equal(slug("See [the docs](./docs/x.md) for *more*"), "see-the-docs-for-more");
  assert.deepEqual(anchors("# A\n## A\n```\n# A\n```\n~~~sh\n## A\n~~~\n## A b"), ["a", "a-1", "a-b"]);
});

test("site: a command line is read past a shell prompt and npx's own options", () => {
  assert.deepEqual(npxCommand('$ npx -y projectstore-codex@0.29.2 upgrade --project "$PWD"'), { command: "projectstore-codex@0.29.2", verb: "upgrade", packages: [] });
  assert.deepEqual(npxCommand("npx --yes -p projectstore-claude@0.28.0-rc.1 projectstore-claude install"), { command: "projectstore-claude", verb: "install", packages: ["projectstore-claude@0.28.0-rc.1"] });
  assert.deepEqual(npxCommand("npx --registry https://registry.npmjs.org projectstore-codex@1 install"), { command: "projectstore-codex@1", verb: "install", packages: [] });
  assert.equal(installForm('% npx -y projectstore uninstall --harness codex', REPO), true);
  assert.equal(installForm("/plugin", REPO), false, "the plugin manager installs nothing");
  assert.equal(installForm("/reload-plugins", REPO), true);
});

test("site AC 1: site/ holds the source as it is served and built, none of its local state, and npm never ships it", () => {
  assert.ok(NOT_SHIPPED.has(SITE), "site is in NOT_SHIPPED (scripts/version-guard.mjs)");
  const files = JSON.parse(read("package.json")).files.map((f) => f.replace(/\/$/, ""));
  assert.ok(!files.includes(SITE), "site/ is not in package.json files: npm would ship it");
  for (const rel of ["index.html", "en/index.html", "src/index.html", "tools/i18n.py", "llms.txt", "llms-full.txt", "assets/style.css", "assets/site.js", "assets/statusline-hud.png", "README.md"]) {
    assert.ok(existsSync(join(ROOT, SITE, rel)), `${SITE}/${rel}`);
  }
  for (const l of Object.keys(LANG_TAGS)) assert.ok(existsSync(join(ROOT, SITE, "locales", `${l}.json`)), `${SITE}/locales/${l}.json`);
  assert.ok(siteFiles().some((f) => /^site\/assets\/fonts\/.+\.woff2$/.test(f.path)), "the fonts are served from site/assets/fonts/");
  assert.ok(siteFiles().some((f) => /^site\/assets\/fonts\/.*(OFL|LICENSE).*\.txt$/i.test(f.path)), "with their licence texts");
  assert.deepEqual(siteFiles().map((f) => f.path).filter((p) => /\/\.(claude|projectstore)\//.test(p)), [], "the source folder's local state stays behind");
});

test("site AC 2: the committed pages are the build's — a page per dictionary, asset hashes, alternates and canonicals, the en/ stub", () => {
  const found = [
    ...checkPageSet(LANGS, PAGE_DIRS, SITE_FS.isFile),
    ...eachPage((p) => [...checkAssetVersions(p, HASHES), ...checkAlternates(p, LANGS)]),
    ...checkStub(read(STUB_FILE)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site AC 3: every page and llms.txt name each published harness; nothing calls it a Claude Code plugin", () => {
  const found = [...eachPage((p) => [...checkHarnessesNamed(p, REPO), ...checkWording(p.file, readable(p))]), ...LLMS.flatMap((f) => checkWording(f, [read(f)]))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every command and role named, in any harness's form, is a file in commands/ or agents/", () => {
  const found = [...eachPage((p) => checkInvocations(p.file, readable(p), REPO)), ...LLMS.flatMap((f) => checkInvocations(f, [read(f)], REPO))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every npx projectstore… names a published package and a verb its bin accepts", () => {
  const found = [...eachPage((p) => checkNpx(p.file, readable(p), REPO)), ...LLMS.flatMap((f) => checkNpx(f, [read(f)], REPO))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every install command is README's line, a permitted --lang aside, and none sits outside a marked block", () => {
  const found = [...eachPage((p) => checkInstall(p, REPO)), ...LLMS.flatMap((f) => checkInstallLines(f, markdownCode(read(f)), REPO))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every copy button copies the lines its block shows", () => {
  const found = eachPage(checkCopies);
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every --lang value is a language ProjectStore ships templates for", () => {
  const found = [...eachPage((p) => checkLangFlags(p.file, readable(p), REPO)), ...LLMS.flatMap((f) => checkLangFlags(f, [read(f)], REPO))];
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

test("site AC 4: every language page has the English page's ids, markers, facts, masked copy values and install blocks", () => {
  const found = PAGES.filter((p) => p !== EN && p.page).flatMap((p) => checkParity(EN.page, p.page, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: every page carries every fact a check reads, each value fact a leaf", () => {
  const found = eachPage((p) => checkRequired(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: no page, stylesheet or script loads from another origin, and every load is a file under site/", () => {
  const files = siteFiles().filter((f) => /\.(html|css|js)$/.test(f.path) && !f.path.startsWith(`${SITE}/src/`));
  assert.ok(files.some((f) => f.path.endsWith(".css")) && files.some((f) => f.path.endsWith(".js")), "the stylesheet and the script are read");
  const found = files.flatMap((f) => checkLoads(f.path, read(f.path)));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: site/ stays within its budget", () => {
  const found = checkBudget(siteFiles());
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: the status-line screenshot is the repository's own", () => {
  const found = checkScreenshot(readFileSync(join(ROOT, SCREENSHOT[0])), readFileSync(join(ROOT, SCREENSHOT[1])));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: the llms files state the facts in their fixed shape, link every page, and resolve every link on the site", () => {
  const found = LLMS.flatMap((f) => [...checkLlmsFacts(f, read(f), REPO), ...checkLlmsLinks(f, read(f), LANGS)]);
  assert.deepEqual(found, [], show(found));
});

test("site AC 5: every example artifact has its template's keys and headings, and a review_status the product writes", () => {
  const found = eachPage((p) => checkShapes(p, REPO));
  assert.deepEqual(found, [], show(found));
});

test("site AC 5: no page or llms file has a numbered name, and every example slug is slugify's", () => {
  const found = [...eachPage((p) => [...checkNumbered(p.file, readable(p)), ...checkSlugs(p, REPO)]), ...LLMS.flatMap((f) => checkNumbered(f, [read(f)]))];
  assert.deepEqual(found, [], show(found));
});

test("site AC 6: each measured figure cites a README or docs/ heading that exists", () => {
  const found = eachPage((p) => checkSources(p, REPO));
  assert.deepEqual(found, [], show(found));
});

// ─── Planted: every check, seen to fail ────────────────────────────────
//
// One mutation per check (more where a check fails more than one way), made
// in memory on a copy of a real file, spread across the pages, both llms
// files and the stub. Each edit must apply — a plant whose anchor has gone
// fails here rather than passing vacuously — and the check must then return
// exactly one finding, naming the expected file and fact. An edit is
// [from, to] (the first occurrence), [from, to, "all"], or [regex, to].

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

const PAGE = Object.fromEntries(PAGES.map((p) => [p.lang, p]));
const STYLE = `${SITE}/assets/style.css`;
const SCRIPT = `${SITE}/assets/site.js`;
const [LLMS_TXT, LLMS_FULL] = LLMS;
const onPage = (lang, check) => {
  const p = PAGE[lang];
  assert.ok(p?.html, `site/locales/${lang}.json has a page`);
  return { file: p.file, source: p.html, run: (html) => check(parse(p.file, html, p.lang)) };
};
const onFile = (file) => ({ file, source: read(file), run: (text) => checkLoads(file, text) });
const onText = (file, check) => ({ file, source: read(file), run: (text) => check(file, text) });
const parity = (lang) => onPage(lang, (p) => checkParity(EN.page, p, REPO));
const section = (open, fn) => [new RegExp(`${escape(open)}[\\s\\S]*?</section>`), fn];

// The Ukrainian page keeps the English example titles because slugify cannot
// transliterate і, ї, є, ґ. A Ukrainian story title, carried consistently into
// every name the core makes from it, is the one finding.
const UK_TITLE = "Транзакційний запис замовлень";
const ukStory = (() => {
  const en = PAGE.uk ? parse(PAGE.uk.file, PAGE.uk.html, "uk").els.find((el) => el.attrs["data-title"] === "story")?.text : null;
  if (!en) return [];
  return [
    [new RegExp(`(data-title="story">)${escape(en)}`, "g"), `$1${UK_TITLE}`],
    [REPO.derive("story", "id", en), REPO.derive("story", "id", UK_TITLE), "all"],
    [REPO.derive("story", "session", en), REPO.derive("story", "session", UK_TITLE), "all"],
  ];
})();

// The German ADR's file name, as the core makes it of the page's own title: the plant below
// types it without its umlaut.
const DE_ADR_FILE = (() => {
  const title = PAGE.de ? parse(PAGE.de.file, PAGE.de.html, "de").els.find((el) => el.attrs["data-title"] === "adr")?.text : null;
  return title ? REPO.derive("adr", "file", title) : "";
})();

const PLANTED = [
  // AC 2: what a stale build would get wrong without changing a word.
  { ac: "2", what: "a page links its stylesheet under an old hash", ...onPage("de", (p) => checkAssetVersions(p, HASHES)), fact: "asset", message: /assets\/style\.css hashes to/,
    edits: [[/(\.\.\/assets\/style\.css\?v=)[0-9a-f]{8}/, "$100000000"]] },
  { ac: "2", what: "an alternate names a page that is not there", ...onPage("zh", (p) => checkAlternates(p, LANGS)), fact: "alternate", message: /hreflang="uk"/,
    edits: [['hreflang="uk" href="https://projectstore.dev/uk/"', 'hreflang="uk" href="https://projectstore.dev/ua/"']] },
  { ac: "2", what: "a page loses its language tag", ...onPage("pt", (p) => checkAlternates(p, LANGS)), fact: "lang", message: /pt is pt-BR/,
    edits: [['<html lang="pt-BR">', '<html lang="pt">']] },
  { ac: "2", what: "a canonical built relative, not under the site's origin", ...onPage("fr", (p) => checkAlternates(p, LANGS)), fact: "canonical",
    edits: [['<link rel="canonical" href="https://projectstore.dev/fr/">', '<link rel="canonical" href="./">']] },
  { ac: "2", what: "the en/ stub redirects to the server root", file: STUB_FILE, source: read(STUB_FILE), run: checkStub, fact: "stub",
    edits: [['<link rel="canonical" href="../">', '<link rel="canonical" href="/">']] },

  // AC 3: every published harness named; the retired wording stays retired.
  { ac: "3", what: "the description stops naming Codex", ...onPage("de", (p) => checkHarnessesNamed(p, REPO)), fact: "harness:codex", message: /meta name="description"/,
    edits: [[/(<meta name="description" content="[^"]*)für Claude Code und Codex/, "$1für Claude Code"]] },
  { ac: "3", what: "the hero stops naming Codex", ...onPage("pt", (p) => checkHarnessesNamed(p, REPO)), fact: "harness:codex", message: /the hero/,
    edits: [section('<section class="hero wrap"', (s) => s.split("Codex").join("Kodex"))] },
  { ac: "3", what: "the install section stops naming Codex", ...onPage("en", (p) => checkHarnessesNamed(p, REPO)), fact: "harness:codex", message: /the install section/,
    edits: [section('<section id="start"', (s) => s.split("Codex").join("Kodex"))] },
  { ac: "3", what: "the Russian description says «плагин для Claude Code» again", ...onPage("ru", (p) => checkWording(p.file, readable(p))), fact: "wording",
    edits: [["плагин рабочего процесса для Claude Code", "плагин для Claude Code"]] },
  { ac: "3", what: "llms-full.txt calls it a Claude Code plugin again", ...onText(LLMS_FULL, (f, t) => checkWording(f, [t])), fact: "wording",
    edits: [["A project workflow plugin for Claude Code and Codex, and a working method", "A Claude Code plugin, and a working method"]] },

  // AC 4: invocations — every harness's form, a name with no file.
  { ac: "4", what: "a projectstore: role with no file in agents/", ...onPage("en", (p) => checkInvocations(p.file, readable(p), REPO)), fact: "invocation", message: /projectstore:auditor/,
    edits: [["projectstore:critic · read-only", "projectstore:auditor · read-only"]] },
  { ac: "4", what: "a /projectstore: command with no file in commands/", ...onPage("uk", (p) => checkInvocations(p.file, readable(p), REPO)), fact: "invocation", message: /\/projectstore:models/,
    edits: [["<code>/projectstore:agents configure</code>", "<code>/projectstore:models configure</code>"]] },
  { ac: "4", what: "a $projectstore- skill with no command or role behind it", ...onText(LLMS_FULL, (f, t) => checkInvocations(f, [t], REPO)), fact: "invocation", message: /\$projectstore-auditor/,
    edits: [["such as `$projectstore-critic`", "such as `$projectstore-auditor`"]] },

  // AC 4: npx — the verb past npx's own options, the package, a private shell.
  { ac: "4", what: "npx -y projectstore frobnicate", ...onPage("en", (p) => checkNpx(p.file, readable(p), REPO)), fact: "npx", message: /no verb "frobnicate"/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>npx -y projectstore frobnicate</code>"]] },
  { ac: "4", what: "an npx package that is not published", ...onPage("zh", (p) => checkNpx(p.file, readable(p), REPO)), fact: "npx", message: /projectstore-cursor is not a published package/,
    edits: [["<code>npx projectstore doctor --json</code>", "<code>npx projectstore-cursor doctor --json</code>"]] },
  { ac: "4", what: "the private projectstore-opencode named in prose", ...onPage("ru", (p) => checkNpx(p.file, readable(p), REPO)), fact: "npx", message: /projectstore-opencode is not published/,
    edits: [["в Claude Code и в Codex", "в Claude Code, в Codex и в projectstore-opencode"]] },

  // AC 4: install — README's lines, the --lang rule, nothing outside a marked block.
  { ac: "4", what: '$ npx projectstore-codex upgrade --project "$PWD" in the FAQ, outside a marked block', ...onPage("en", (p) => checkInstall(p, REPO)), fact: "install", message: /projectstore-codex upgrade .* outside a block marked/,
    edits: [["or the MCP server.</p>", 'or the MCP server. To upgrade Codex: <code>$ npx projectstore-codex upgrade --project "$PWD"</code>.</p>']] },
  { ac: "4", what: "a marked install line README does not fence", ...onPage("pt", (p) => checkInstall(p, REPO)), fact: "install", message: /is no line README fences/,
    edits: [['npx projectstore-claude install --project "$PWD"</code></pre>', "npx projectstore-claude install --project .</code></pre>"]] },
  { ac: "4", what: "an install block that loses its marker", ...onPage("ru", (p) => checkInstall(p, REPO)), fact: "install", message: /npx projectstore-codex install .* outside a block marked/,
    edits: [['<pre id="install-codex" data-fact="install">', '<pre id="install-codex">']] },
  { ac: "4", what: "a bind line with another page's --lang", ...onPage("es", (p) => checkInstall(p, REPO)), fact: "install", message: /--lang fr" is no line README fences/,
    edits: [['<span data-i18n="start.bind-lang"> --lang es</span>', '<span data-i18n="start.bind-lang"> --lang fr</span>']] },
  { ac: "4", what: "a --lang on a page whose language ships no templates", ...onPage("uk", (p) => checkInstall(p, REPO)), fact: "install", message: /--lang uk" is no line README fences/,
    edits: [['<span data-i18n="start.bind-lang"></span>', '<span data-i18n="start.bind-lang"> --lang uk</span>']] },
  { ac: "4", what: "a fenced install line in llms.txt that README does not fence", ...onText(LLMS_TXT, (f, t) => checkInstallLines(f, markdownCode(t), REPO)), fact: "install", message: /--scope user/,
    edits: [["/plugin install projectstore@SmartAndPoint\n", "/plugin install projectstore@SmartAndPoint --scope user\n"]] },
  { ac: "4", what: "a copy button that copies another line than it shows", ...onPage("zh", checkCopies), fact: "copy", message: /#install-day copies "\/projectstore:doctor" where it shows "\/projectstore:status"/,
    edits: [['id="install-day" data-copy="/projectstore:status', 'id="install-day" data-copy="/projectstore:doctor']] },
  { ac: "4", what: "a --lang ProjectStore ships no templates for", ...onPage("de", (p) => checkLangFlags(p.file, readable(p), REPO)), fact: "lang", message: /--lang it/,
    edits: [["> --lang de</span>", "> --lang it</span>"]] },
  { ac: "4", what: "llms-full.txt's bind usage offers a language with no templates", ...onText(LLMS_FULL, (f, t) => checkLangFlags(f, [t], REPO)), fact: "lang", message: /--lang uk/,
    edits: [["--lang de|en|es|fr|ru|zh]", "--lang de|en|es|fr|ru|uk|zh]"]] },

  // AC 4: the version, the links, the counts, the statuses.
  { ac: "4", what: "the support grid says the previous version", ...onPage("pt", (p) => checkVersion(p, REPO)), fact: "version", message: /package\.json is/,
    edits: [['data-fact="version">v0.29.2</span></div>', 'data-fact="version">v0.28.0</span></div>']] },
  { ac: "4", what: "a version in the title, outside a marker", ...onPage("ru", (p) => checkVersion(p, REPO)), fact: "version", message: /outside a data-fact="version"/,
    edits: [['<title data-i18n="meta.title">ProjectStore —', '<title data-i18n="meta.title">ProjectStore v0.29.2 —']] },
  { ac: "4", what: "a stale version in an attribute value", ...onPage("pt", (p) => checkVersion(p, REPO)), fact: "version", message: /"v0\.28\.0" in the content attribute of <meta>/,
    edits: [[/(<meta name="description" content=")/, "$1ProjectStore v0.28.0: "]] },
  { ac: "4", what: "llms-full.txt's closing line names another release", ...onText(LLMS_FULL, (f, t) => checkVersionText(f, t, REPO)), fact: "version", message: /Version 0\.29\.1/,
    edits: [["Version 0.29.2. Facts and figures", "Version 0.29.1. Facts and figures"]] },
  { ac: "4", what: "a link to a docs/ heading that does not exist", ...onPage("uk", (p) => checkLinks(p, REPO)), fact: "link", message: /has no heading #kodeks$/,
    edits: [["docs/harnesses.md#codex", "docs/harnesses.md#kodeks"]] },
  { ac: "4", what: "an llms.txt link to a docs/ page that does not exist", ...onText(LLMS_TXT, (f, t) => checkTextLinks(f, t, REPO)), fact: "link", message: /no docs\/extend\.md/,
    edits: [["blob/main/docs/extending.md", "blob/main/docs/extend.md"]] },
  { ac: "4", what: "a command count the repository disagrees with", ...onPage("zh", (p) => checkCounts(p, REPO)), fact: "commands",
    edits: [['<strong data-fact="commands">20</strong>', '<strong data-fact="commands">21</strong>']] },
  { ac: "4", what: "a language count the repository disagrees with", ...onPage("uk", (p) => checkCounts(p, REPO)), fact: "languages",
    edits: [['<strong data-fact="languages">6</strong>', '<strong data-fact="languages">7</strong>']] },
  { ac: "4", what: "a listed MCP tool that scripts/mcp.mjs does not have", ...onPage("ru", (p) => checkCounts(p, REPO)), fact: "mcp-tool", message: /missing lineage; not a tool, or twice: history/,
    edits: [['<li data-fact="mcp-tool">lineage</li>', '<li data-fact="mcp-tool">history</li>']] },
  { ac: "4", what: "Codex called supported while its manifest's verified is null", ...onPage("de", (p) => checkHarnessStatus(p, REPO)), fact: "harness-status:codex",
    edits: [['data-fact="harness-status:codex">experimental<', 'data-fact="harness-status:codex">supported<']] },
  { ac: "4", what: "a status for a harness with no manifest", ...onPage("en", (p) => checkHarnessStatus(p, REPO)), fact: "harness-status:cursor",
    edits: [['data-fact="harness-status:claude-code"', 'data-fact="harness-status:cursor"']] },

  // AC 4: a language page against the English one.
  { ac: "4", what: "a language page renames a section id", ...parity("ru"), fact: "ids",
    edits: [['<section id="questions"', '<section id="voprosy"']] },
  { ac: "4", what: "a language page translates a status", ...parity("ru"), fact: "fact values", message: /harness-status:codex=экспериментально/,
    edits: [['data-fact="harness-status:codex">experimental<', 'data-fact="harness-status:codex">экспериментально<']] },
  { ac: "4", what: "a language page drops a data-title", ...parity("ru"), fact: "data-title",
    edits: [[' data-title="spec"', ""]] },
  { ac: "4", what: "a language page copies another option", ...parity("ru"), fact: "copy values", message: /\/projectstore:doctor --json/,
    edits: [['/projectstore:doctor" data-i18n="start.pre.3"', '/projectstore:doctor --json" data-i18n="start.pre.3"']] },
  { ac: "4", what: "a language page cites another passage", ...parity("ru"), fact: "data-source",
    edits: [['data-source="docs/how-it-works.md#sessions-how-parallel-claude-instances-coexist"', 'data-source="README.md#what-it-costs--measured-not-promised"']] },

  // AC 4: a fact a check reads, unmarked; a value fact that is not a leaf.
  { ac: "4", what: "the MCP tool count loses its marker", ...onPage("uk", (p) => checkRequired(p, REPO)), fact: "mcp-tools",
    edits: [[' data-fact="mcp-tools"', ""]] },
  { ac: "4", what: "Codex's status loses every marker", ...onPage("de", (p) => checkRequired(p, REPO)), fact: "harness-status:codex",
    edits: [[' data-fact="harness-status:codex"', "", "all"]] },
  { ac: "4", what: "no figure is marked data-source", ...onPage("zh", (p) => checkRequired(p, REPO)), fact: "data-source",
    edits: [[/ data-source="[^"]*"/g, ""]] },
  { ac: "4", what: "a value fact that holds markup", ...onPage("en", (p) => checkRequired(p, REPO)), fact: "version", message: /a value fact is a leaf/,
    edits: [['<span class="version-badge" data-fact="version">v0.29.2</span>', '<span class="version-badge" data-fact="version"><b>v0.29.2</b></span>']] },
  { ac: "4", what: "the example story loses its data-template", ...onPage("uk", (p) => checkRequired(p, REPO)), fact: "template:story", message: /no example is marked data-template="story"/,
    edits: [[' data-template="story"', ""]] },

  // AC 4: loads — another origin, a link off the site, a file that is not there.
  { ac: "4", what: "a <link> to Google Fonts", ...onFile(EN.file), fact: "load", message: /<link href> loads https:\/\/fonts\.googleapis\.com/,
    edits: [[/<link rel="stylesheet" href="assets\/style\.css\?v=[0-9a-f]{8}">/, (m) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400..700&amp;display=swap">\n${m}`]] },
  { ac: "4", what: "a canonical that points off the site", ...onFile(PAGE.de.file), fact: "load", message: /<link rel="canonical"> points at https:\/\/projectstore\.example\/de\/, not under https:\/\/projectstore\.dev\//,
    edits: [['<link rel="canonical" href="https://projectstore.dev/de/">', '<link rel="canonical" href="https://projectstore.example/de/">']] },
  { ac: "4", what: "a <script src> from a CDN", ...onFile(PAGE.zh.file), fact: "load", message: /<script src> loads https:\/\/cdn/,
    edits: [['<script src="../assets/site.js', '<script src="https://cdn.example.com/a.js"></script>\n<script src="../assets/site.js']] },
  { ac: "4", what: "a protocol-relative <img src>", ...onFile(PAGE.uk.file), fact: "load", message: /<img src> loads \/\/cdn/,
    edits: [['src="../assets/statusline-hud.png"', 'src="//cdn.example.com/hud.png"']] },
  { ac: "4", what: "a stylesheet that is not under site/", ...onFile(PAGE.pt.file), fact: "load", message: /no site\/assets\/styles\.css/,
    edits: [["../assets/style.css?v=", "../assets/styles.css?v="]] },
  { ac: "4", what: "a font the stylesheet names that is not there", ...onFile(STYLE), fact: "load", message: /no site\/assets\/fonts\/onest-latin2\.woff2/,
    edits: [['url("fonts/onest-latin.woff2")', 'url("fonts/onest-latin2.woff2")']] },
  { ac: "4", what: "an @import of Google Fonts in the stylesheet", ...onFile(STYLE), fact: "load", message: /@import loads https:\/\/fonts\.googleapis\.com/,
    edits: [[/^/, '@import url("https://fonts.googleapis.com/css2?family=Onest");\n']] },
  { ac: "4", what: "a fetch( in the script", ...onFile(SCRIPT), fact: "load", message: /fetch\( loads https/,
    edits: [['"use strict";', '"use strict";\n  fetch("https://api.github.com/repos/SmartAndPoint/ProjectStore");']] },
  { ac: "4", what: "an <img src> naming a directory, which serves nothing without its index.html", ...onFile(EN.file), fact: "load", message: /no site\/assets\/fonts\/index\.html/,
    edits: [['src="assets/statusline-hud.png"', 'src="assets/fonts"']] },

  // AC 4: the llms files' fixed shape and their links.
  { ac: "4", what: "llms.txt's facts heading names another release", ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)), fact: "version",
    edits: [["**Facts about version 0.29.2.**", "**Facts about version 0.29.1.**"]] },
  { ac: "4", what: "llms.txt counts a command too many", ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)), fact: "commands",
    edits: [["- 20 commands", "- 21 commands"]] },
  { ac: "4", what: "llms.txt lists a tool scripts/mcp.mjs does not have", ...onText(LLMS_TXT, (f, t) => checkLlmsFacts(f, t, REPO)), fact: "mcp-tool",
    edits: [["`lineage`", "`history`"]] },
  { ac: "4", what: "llms-full.txt calls Codex supported", ...onText(LLMS_FULL, (f, t) => checkLlmsFacts(f, t, REPO)), fact: "harness-status:codex",
    edits: [["Codex (experimental). The plugin installs into both.", "Codex (supported). The plugin installs into both."]] },
  { ac: "4", what: "llms-full.txt lists a template language that does not ship", ...onText(LLMS_FULL, (f, t) => checkLlmsFacts(f, t, REPO)), fact: "languages",
    edits: [["Templates ship in 6 languages: de, en, es, fr, ru, zh.", "Templates ship in 6 languages: de, en, es, fr, ru, uk, zh."]] },
  { ac: "4", what: "llms.txt stops linking a page", ...onText(LLMS_TXT, (f, t) => checkLlmsLinks(f, t, LANGS)), fact: "pages", message: /https:\/\/projectstore\.dev\/zh\//,
    edits: [["- [中文](https://projectstore.dev/zh/): the same page in Simplified Chinese.\n", ""]] },
  { ac: "4", what: "llms-full.txt links a file the site does not serve", ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)), fact: "link", message: /no site\/llms-short\.txt/,
    edits: [["(and https://projectstore.dev/llms.txt)", "(and https://projectstore.dev/llms-short.txt)"]] },
  { ac: "4", what: "llms-full.txt links a page site-relative", ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)), fact: "link", message: /\/ru\/ is site-relative/,
    edits: [["(and https://projectstore.dev/llms.txt)", "(and https://projectstore.dev/llms.txt, [in Russian](/ru/))"]] },
  { ac: "4", what: "llms-full.txt links a directory with no index.html", ...onText(LLMS_FULL, (f, t) => checkLlmsLinks(f, t, LANGS)), fact: "link", message: /https:\/\/projectstore\.dev\/assets: no site\/assets\/index\.html/,
    edits: [["(and https://projectstore.dev/llms.txt)", "(and https://projectstore.dev/assets)"]] },

  // AC 5: an example's shape, a numbered name, a slug slugify would not make.
  { ac: "5", what: "a review_status the product never writes", ...onPage("pt", (p) => checkShapes(p, REPO)), fact: "template:adr", message: /review_status: approved/,
    edits: [["<span>review_status: reviewed</span>", "<span>review_status: approved</span>"]] },
  { ac: "5", what: "a heading the Chinese ADR template does not have", ...onPage("zh", (p) => checkShapes(p, REPO)), fact: "template:adr", message: /## 上下文/,
    edits: [["<span>## 背景</span>", "<span>## 上下文</span>"]] },
  { ac: "5", what: "a frontmatter key the English spec template does not have, on a page with no templates of its own", ...onPage("uk", (p) => checkShapes(p, REPO)), fact: "template:spec", message: /"state" is not in templates\/en\/spec\.md\.tmpl/,
    edits: [["<span>status: active</span>", "<span>state: active</span>"]] },
  { ac: "5", what: "an example whose frontmatter never closes", ...onPage("es", (p) => checkShapes(p, REPO)), fact: "template:spec", message: /no frontmatter between "---" lines/,
    edits: [[/(data-template="spec"[\s\S]*?<span>---<\/span>[\s\S]*?)<span>---<\/span>/, "$1<span>- - -</span>"]] },
  { ac: "5", what: "a frontmatter line that is not key: value", ...onPage("fr", (p) => checkShapes(p, REPO)), fact: "template:adr", message: /frontmatter line "status accepted" is not "key: value"/,
    edits: [["<span>status: accepted</span>", "<span>status accepted</span>"]] },
  { ac: "5", what: "a numbered ADR in the title", ...onPage("zh", (p) => checkNumbered(p.file, readable(p))), fact: "numbered", message: /ADR-007/,
    edits: [['<title data-i18n="meta.title">ProjectStore —', '<title data-i18n="meta.title">ProjectStore ADR-007 —']] },
  { ac: "5", what: "a numbered story in llms-full.txt", ...onText(LLMS_FULL, (f, t) => checkNumbered(f, [t])), fact: "numbered", message: /story-003/,
    edits: [["/projectstore:story plan PAY-001/story-transactional-order-writes", "/projectstore:story plan PAY-001/story-003"]] },
  { ac: "5", what: "a German file name typed without its umlaut", ...onPage("de", (p) => checkSlugs(p, REPO)), fact: "slug:adr", message: new RegExp(`slugify makes "${escape(DE_ADR_FILE)}"`),
    edits: [[`data-slug="adr:file">${DE_ADR_FILE}<`, `data-slug="adr:file">${DE_ADR_FILE.replace(/ä/g, "a")}<`]] },
  { ac: "5", what: "a title that differs within the page", ...onPage("ru", (p) => checkSlugs(p, REPO)), fact: "title:spec",
    edits: [['/projectstore:spec "<span data-title="spec">Транзакционная запись заказов</span>', '/projectstore:spec "<span data-title="spec">Запись заказов</span>']] },
  { ac: "5", what: "a Ukrainian story title, which slugify leaves Cyrillic", ...onPage("uk", (p) => checkSlugs(p, REPO)), fact: "slug:story", message: /keeps a Cyrillic letter/,
    edits: ukStory },
  { ac: "5", what: "an example path with no data-slug", ...onPage("en", (p) => checkSlugs(p, REPO)), fact: "slug", message: /example path "adr\/use-postgres-for-primary-storage\.md" is not marked/,
    edits: [['<span data-i18n="artifacts.span.9" data-slug="adr:path">', '<span data-i18n="artifacts.span.9">']] },

  // AC 6: a citation that resolves to nothing, or to the wrong kind of file.
  { ac: "6", what: "a figure cites a docs/ heading that does not exist", ...onPage("pt", (p) => checkSources(p, REPO)), fact: "data-source", message: /has no heading #sessions$/,
    edits: [['data-source="docs/how-it-works.md#sessions-how-parallel-claude-instances-coexist"', 'data-source="docs/how-it-works.md#sessions"']] },
  { ac: "6", what: "a figure cites a file outside README and docs/", ...onPage("en", (p) => checkSources(p, REPO)), fact: "data-source", message: /is not README\.md or a docs\/ page/,
    edits: [['data-source="docs/how-it-works.md#naming-a-session-after-the-work-it-settled-on"', 'data-source="scripts/touch-session.mjs#naming"']] },
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

test("site AC 2, planted: a dictionary with no page, and a page with no dictionary", () => {
  const missing = checkPageSet(LANGS, PAGE_DIRS, (rel) => rel !== `${SITE}/pt/index.html` && SITE_FS.isFile(rel));
  assert.deepEqual(missing.map((f) => [f.page, f.fact]), [[`${SITE}/pt/index.html`, "page"]], show(missing));
  const extra = checkPageSet(LANGS, [...PAGE_DIRS, "it"], SITE_FS.isFile);
  assert.deepEqual(extra.map((f) => [f.page, f.fact]), [[`${SITE}/it/index.html`, "page"]], show(extra));
});

test("site AC 4: a canonical or alternate under https://projectstore.dev/, or a relative one, is no load", () => {
  const de = PAGE.de;
  assert.ok(de.html.includes('<link rel="canonical" href="https://projectstore.dev/de/">'), "the built page's canonical is absolute");
  assert.ok(de.html.includes('<link rel="alternate" hreflang="x-default" href="https://projectstore.dev/">'), "and so are its alternates");
  assert.deepEqual(checkLoads(de.file, de.html), [], "an absolute canonical under the site's origin is not a finding");
  const relative = plant(de.html, [['<link rel="canonical" href="https://projectstore.dev/de/">', '<link rel="canonical" href="./">']]);
  assert.deepEqual(checkLoads(de.file, relative), [], "nor is a relative one");
});

test("site AC 4, planted: one byte over the budget fails; the budget itself does not", () => {
  const files = siteFiles();
  const total = files.reduce((n, f) => n + f.size, 0);
  assert.deepEqual(checkBudget([...files, { path: `${SITE}/planted.bin`, size: BUDGET - total }]), [], "exactly the budget passes");
  const found = checkBudget([...files, { path: `${SITE}/planted.bin`, size: BUDGET - total + 1 }]);
  assert.equal(found.length, 1, show(found));
  assert.equal(found[0].page, `${SITE}/`);
  assert.equal(found[0].fact, "budget");
});

test("site AC 4, planted: a screenshot one byte off fails", () => {
  const docs = readFileSync(join(ROOT, SCREENSHOT[1]));
  const site = Buffer.from(readFileSync(join(ROOT, SCREENSHOT[0])));
  site[site.length >> 1] ^= 0xff;
  const found = checkScreenshot(site, docs);
  assert.equal(found.length, 1, show(found));
  assert.equal(found[0].page, SCREENSHOT[0]);
  assert.equal(found[0].fact, "screenshot");
});

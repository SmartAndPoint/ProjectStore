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
// to pages of its own"). The method pages are in every language; the main
// page in English and Russian, and the other languages' addresses redirect to
// it (PS-HARNESS: "The front page speaks to a beginner …"). The main page says
// what ProjectStore is, walks a beginner through setup and then carries the
// method pages' own blocks (PS-HARNESS: "The front page says what ProjectStore
// is, walks a beginner through setup, and carries the method pages' own blocks
// …"). A page's kind decides what it must carry and in which languages it is
// built (KINDS, KIND_RULES); every other rule holds on every page.
//
// Python-free: the pages are site/tools/i18n.py's output, and CI proves that
// with Python 3.12 (.github/workflows/test.yml). What a stale build would get
// wrong without changing a word is checked here instead: asset hashes,
// alternates and canonicals, the link-preview tags, the redirect, a page per
// dictionary and kind with no orphan folder beside them, the stubs.
//
// The checks and their helpers live here and in tests/fixtures/markdown.mjs,
// not in scripts/: a file there ships, and the runtime vocabulary lint would
// read their command literals. The tests that run them on the real files and
// on planted copies are tests/site.test.mjs; the two are one file split in
// two, since the plugin directory holds a file of 256 KiB or more for a
// reviewer.
//
//   node --test tests/site.test.mjs

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { sourceNames, invocationPatterns, stripComments } from "./vocabulary.mjs";
import { markdownLines, cut, unprompt, npxCommand } from "./markdown.mjs";
import { VERBS } from "../../scripts/cli.mjs";
import { languageNames } from "../../scripts/binding.mjs";
import { TOOLS } from "../../scripts/mcp.mjs";
import { loadHarness, sourceHarness, uiWordPatterns } from "../../scripts/harness.mjs";
import {
  slugify,
  anchorKeyOf,
  foldAnchor,
  emptyAnchorState,
  composeAnchorName,
  ANCHOR_SETTLE,
} from "../../scripts/lib.mjs";
import { SHELLS, publishable } from "../../packaging/shells.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SITE = "site";
export const ORIGIN = "https://projectstore.dev/";
// The git channel installs every byte of main, site/ included (the site ADR,
// decision 4), so the site has a budget: 2.5 MiB.
export const BUDGET = 2621440;
export const REPO_URL = "https://github.com/SmartAndPoint/ProjectStore";
export const LLMS = ["site/llms.txt", "site/llms-full.txt"];
// The link preview every page names: absolute under every --base-url, because
// the services that read og:image and twitter:image fetch it from outside and
// never resolve a relative URL (tools/i18n.py PREVIEW_IMAGE).
export const PREVIEW_IMAGE = `${ORIGIN}assets/og.png`;
export const PREVIEW_SIZE = { width: 1280, height: 640 };
// What tools/i18n.py writes at en/, the old address: a redirect to the root,
// where English lives. The main page is built in every language since
// PS-HARNESS "The front page in all eight languages …", so en/ is the one stub.
export const STUB_LANGS = ["en"];
export const STUB_FILES = STUB_LANGS.map((l) => `site/${l}/index.html`);
export const STUB_FILE = STUB_FILES[0];
export const STUB =
  '<!doctype html><meta charset="utf-8"><title>ProjectStore</title><link rel="canonical" href="../"><meta http-equiv="refresh" content="0; url=../"><a href="../">ProjectStore</a>\n';
// A copy of LANGS in tools/i18n.py — code to the BCP 47 tag of <html lang> and
// hreflang. A test below holds the copy to the original.
export const LANG_TAGS = { en: "en", de: "de", es: "es", fr: "fr", pt: "pt-BR", ru: "ru", uk: "uk", zh: "zh-CN" };
export const DEFAULT_LANG = "en";
// A copy of PAGES in tools/i18n.py — each kind of page, its template in src/
// and the folder its pages live in ("" is the language root). A test below
// holds the copy to the original, so a page the build renders cannot go
// unchecked: a new kind fails here until KIND_RULES says what it carries.
// `langs`: a kind built in those languages only — the privacy page, English
// for now — linked from a page in any other language at its English address.
export const KINDS = [
  { kind: "main", src: "index.html", slug: "" },
  { kind: "how-it-works", src: "how-it-works.html", slug: "how-it-works" },
  { kind: "why-it-works", src: "why-it-works.html", slug: "why-it-works" },
  { kind: "one-vault", src: "one-vault.html", slug: "one-vault" },
  { kind: "privacy", src: "privacy.html", slug: "privacy", langs: ["en"] },
];
export const slugOf = (kind) => KINDS.find((k) => k.kind === kind)?.slug ?? null;
// The languages a kind is built in, of the dictionaries `langs`; and whether
// a kind is built in one language only, which lists itself as its only
// alternate, shows no switcher and never redirects.
export const kindLangs = (k, langs) => (k.langs ? langs.filter((l) => k.langs.includes(l)) : langs);
export const kindOf = (kind) => KINDS.find((k) => k.kind === kind);
export const singleLanguage = (kind) => Boolean(kindOf(kind)?.langs && kindOf(kind).langs.length === 1);
// Whether a page in `lang` may link the kind whose folder is `path` at its
// English address: the kind is not built in that language (the privacy page,
// at the site root for every language, as tools/i18n.py SHARED_PAGES has it;
// the main page, at / for the six languages without one).
export const linkedInEnglish = (path, lang) =>
  KINDS.some((k) => k.langs && !k.langs.includes(lang) && path === (k.slug ? `/${k.slug}/` : "/"));
// A page's folder under the site root, its file and its address: English at
// the root, every other language under <lang>/, a method page in <slug>/.
export const pagePath = (lang, slug) => `${lang === DEFAULT_LANG ? "" : `${lang}/`}${slug ? `${slug}/` : ""}`;
export const pageFile = (lang, slug) => `${SITE}/${pagePath(lang, slug)}index.html`;
export const pageUrl = (lang, slug = "") => `${ORIGIN}${pagePath(lang, slug)}`;
// "A Claude Code plugin" as each page said it before the refresh, from its
// hero and description keys (AC: the phrase and its seven translations). The
// Russian and Ukrainian main pages' taglines say «плагин для Claude Code и
// Codex», «плагін для Claude Code і Codex», which name both, so those phrases
// are retired only on their own.
export const RETIRED = [
  "a Claude Code plugin",
  "ein Claude-Code-Plugin",
  "un plugin de Claude Code",
  "un plugin Claude Code",
  "um plugin do Claude Code",
  /плагин для claude code(?! и codex)/,
  /плагін для claude code(?! [ій] codex)/,
  "一个 Claude Code 插件",
];
// The example epic's id: an id, so English and the same on every page.
export const EXAMPLE_EPIC = "CHECKOUT";
export const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
export const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const sha8 = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 8);

// ─── HTML, without a parser ────────────────────────────────────────────
//
// The pages are rendered from a few templates and well-formed, and the checks
// need little: start tags, their attributes, an element's text. Comments and
// the bodies of <script> and <style> are not markup — they are dropped before
// tags are read, and read on their own where a check needs them.

export const OPEN = /<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
export const ANY_TAG = /<\/?[a-z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
export const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
export const RAW_BODY = /(<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi;
export const VOID = new Set([
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
export const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
export const rawBodies = (html, name) =>
  [...withoutComments(html).matchAll(RAW_BODY)].filter((m) => m[2].toLowerCase() === name).map((m) => m[3]);

export function attributes(source) {
  const out = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

// An element's inner markup: up to its matching end tag, counting nested
// elements of the same name — for a leaf, simply the next closing tag.
export function innerOf(markup, el) {
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

export const textOf = (markup) => decode(markup.replace(ANY_TAG, ""));

// A page as the checks read it: every element in document order, with its
// attributes, its inner markup, its text and whether it is a leaf; and the
// page's language, kind and slug where it is one of the site's pages.
export function parse(file, html, lang = null, kind = null) {
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
export const bodyText = (page) => {
  const body = page.els.find((el) => el.name === "body");
  return decode((body ? body.inner : page.markup).replace(ANY_TAG, " "));
};

// What a reader sees or copies: the text — every tag a space, so two elements
// never run together — and every attribute value.
export const readable = (page) => [
  decode(page.markup.replace(ANY_TAG, " ")),
  ...page.els.flatMap((el) => Object.values(el.attrs)),
];
export const marked = (page, pred = () => true) =>
  page.els.filter((el) => "data-fact" in el.attrs && pred(el.attrs["data-fact"]));
export const withAttr = (page, name) => page.els.filter((el) => name in el.attrs);
export const hasClass = (el, c) => (el.attrs.class || "").split(/\s+/).includes(c);
export const within = (outer, el) => el.start >= outer.start && el.start < outer.end + outer.inner.length;

// What a copy button copies (assets/site.js): its target's data-copy, else
// the target's text. Targets are named by data-copy-from; an element that
// carries data-copy is one too.
export function copyBlocks(page) {
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
export function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu, "")
    .replace(/ /g, "-");
}

export function anchors(md) {
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
export function fencedLines(md) {
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
export const PROMPT_HEADING = "In a Claude Code session";
export function readmePrompt(md) {
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
export function markdownCode(md) {
  const out = [];
  for (const { line, fenced } of markdownLines(md)) {
    if (fenced) out.push(line);
    else for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  }
  return out;
}

// ─── Command lines ─────────────────────────────────────────────────────

// The package an npx command names, without its @<version>.
export const packageName = (spec) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

// ─── The repository's side ─────────────────────────────────────────────

// The headings under which README may fence an install, upgrade or uninstall
// command (AC 4). `## Install` leads with `npx projectstore setup` (the story
// "User-facing text says where to run and names no project path and no
// shell", rule 7), and each of the three fences its commands.
export const INSTALL_HEADINGS = ["Install", "Configure", "Upgrading", "Uninstalling"];

// The frontmatter keys and "## " headings of a template, as the product writes it.
export function templateShape(md) {
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
export function repository(root = ROOT) {
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
export function sitePages(root = ROOT) {
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
export function siteFiles(root = ROOT) {
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

export const finding = (page, fact, message) => ({ page, fact, message });
export const unique = (list) => [...new Map(list.map((f) => [JSON.stringify(f), f])).values()];

// AC 3: every harness whose shell is published is named in <meta
// name="description"> and in each place its kind's rules name (KIND_RULES
// `named`). On the main page those are the hero, #what, and the install
// chapter: its head, #start, with the quick start that holds the install box,
// #quick, read together as a reader meets them.
export function checkHarnessesNamed(page, repo, rules = rulesOf(page)) {
  const out = [];
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "description");
  const section = (id) => page.els.find((el) => el.name === "section" && el.attrs.id === id);
  const places = [
    ['<meta name="description">', meta ? (meta.attrs.content ?? "") : null, []],
    ...Object.entries(typeof rules.named === "object" ? rules.named : {}).map(([where, ids]) => {
      const els = ids.map(section);
      const gone = ids.filter((id, i) => !els[i]);
      return [where, gone.length ? null : els.map((el) => el.text).join("\n"), gone];
    }),
  ];
  for (const [where, text, gone] of places) {
    if (text === null) {
      const which = gone.length ? `: no ${gone.map((id) => `section#${id}`).join(", ")}` : "";
      out.push(finding(page.file, "harnesses", `${where} is missing${which}`));
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
export function checkWording(file, texts) {
  const all = texts.join("\n").replace(/\s+/g, " ").toLowerCase();
  return RETIRED.filter((p) => (p instanceof RegExp ? p.test(all) : all.includes(p.toLowerCase()))).map((p) =>
    finding(file, "wording", `"${p instanceof RegExp ? p.source : p}": the plugin is no longer one harness's`),
  );
}

// AC 4: a command or role in any harness's invocation form names a file in
// commands/ or agents/. Forms that share a prefix (Codex calls commands and
// roles through one skill form) accept either kind's names.
export function checkInvocations(file, texts, repo) {
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
export function checkNpx(file, texts, repo) {
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
export const MENU_WORDS = new Map([["/plugin", ["install", "uninstall", "update", "marketplace"]]]);
export function installForm(line, repo) {
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
export const BIND_LINE = /^\/projectstore:bind\b/;
export function withoutLangSuffix(line, lang, repo) {
  const suffix = ` --lang ${lang}`;
  return lang && repo.languages.includes(lang) && BIND_LINE.test(line) && line.endsWith(suffix)
    ? line.slice(0, -suffix.length)
    : line;
}

export function readmeInstallLines(repo) {
  return new Set(INSTALL_HEADINGS.flatMap((h) => repo.readme.get(h) || []));
}

export function checkInstall(page, repo) {
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
export function checkCopies(page) {
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
export function checkInstallLines(file, lines, repo) {
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
export function checkLangFlags(file, texts, repo) {
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
export const VERSION_WORDS = /\bv(\d+\.\d+\.\d+(?:-[\w.]+)?)\b|\b[Vv]ersion (\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g;
export function checkVersion(page, repo) {
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

export function checkVersionText(file, text, repo) {
  return unique(
    [...text.matchAll(VERSION_WORDS)]
      .filter((m) => (m[1] ?? m[2]) !== repo.version)
      .map((m) => finding(file, "version", `"${m[0]}"; package.json is ${repo.version}`)),
  );
}

// AC 4: a link into the repository names a path that exists on main, and an
// anchor names a heading of its markdown file (README.md for the root).
export const REPO_LINK = new RegExp(`^${escape(REPO_URL)}(?:/(blob|tree)/main/([^?#]+))?/?(?:#(.*))?$`);
export function checkRepoLink(file, url, repo) {
  const m = REPO_LINK.exec(url);
  if (!m) return [];
  const rel = m[2] ? decodeURIComponent(m[2]).replace(/\/$/, "") : "README.md";
  if (rel.split("/").includes("..") || !repo.exists(rel)) return [finding(file, "link", `${url}: no ${rel} on main`)];
  if (m[3] && rel.endsWith(".md") && !repo.anchorsOf(rel).includes(m[3]))
    return [finding(file, "link", `${url}: ${rel} has no heading #${m[3]}`)];
  return [];
}
export const checkLinks = (page, repo) =>
  unique(page.els.filter((el) => el.attrs.href).flatMap((el) => checkRepoLink(page.file, el.attrs.href, repo)));
export const markdownUrls = (md) =>
  [...md.matchAll(/\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![(<])\b(https?:\/\/[^\s)>`'"]+)/g)].map((m) =>
    (m[1] ?? m[2] ?? m[3]).replace(/[.,;:]+$/, ""),
  );
export const checkTextLinks = (file, md, repo) => unique(markdownUrls(md).flatMap((u) => checkRepoLink(file, u, repo)));

// AC 4: the counts are the repository's, as digits; the MCP tools listed are
// its tools, each once.
export const COUNTS = ["commands", "agents", "languages", "mcp-tools"];
export function checkCounts(page, repo) {
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

// The front page story: the main page's agents line names these agents, in
// this order, as plain names, and carries no harness status. The names live
// here alone, so a rename is one edit (and one in each dictionary). The
// names the main page dropped stay off it.
export const AGENTS = ["Claude Code", "Codex", "OpenCode", "Gemini", "Z.ai", "DeepSeek"];
export const DROPPED_AGENTS = ["Cursor", "Gemini CLI"];
// Each language's stem for "experimental", as the dictionaries spell it.
export const EXPERIMENTAL = {
  en: "experimental",
  de: "experimentell",
  es: "experimental",
  fr: "expérimental",
  pt: "experimental",
  ru: "экспериментальн",
  uk: "експериментальн",
  zh: "实验性",
};
// AC "The agents line": the hero, #what, and the trust ticks each hold one
// agents line, whose names are the b elements in it — AGENTS in order, none
// with a data-i18n of its own, so no dictionary translates a name. Nothing
// else on the page, text or attribute value, names an agent the main page
// dropped.
export function checkAgents(page) {
  const out = [];
  const lines = page.els.filter((el) => hasClass(el, "agents-line"));
  const what = page.els.find((el) => el.name === "section" && el.attrs.id === "what");
  const trust = page.els.find((el) => hasClass(el, "trust"));
  for (const [where, box] of [
    ["#what", what],
    ["the trust list", trust],
  ]) {
    const held = box ? lines.filter((el) => within(box, el)) : [];
    if (held.length !== 1) {
      out.push(finding(page.file, "agents-named", `${where} holds ${held.length} agents lines; it holds one`));
      continue;
    }
    const names = page.els.filter((el) => el.name === "b" && within(held[0], el));
    const said = names.map((b) => b.text.trim());
    if (said.join("|") !== AGENTS.join("|") || names.some((b) => "data-i18n" in b.attrs))
      out.push(
        finding(
          page.file,
          "agents-named",
          `${where} names ${said.join(", ") || "no agent"}; it names ${AGENTS.join(", ")}`,
        ),
      );
  }
  if (lines.length !== 2)
    out.push(finding(page.file, "agents-named", `${lines.length} agents lines; the page has two`));
  const rest = lines.reduceRight((m, el) => m.slice(0, el.start) + m.slice(el.end + el.inner.length), page.markup);
  const seen = [decode(rest.replace(ANY_TAG, " ")), ...page.els.flatMap((el) => Object.values(el.attrs))].join("\n");
  for (const name of DROPPED_AGENTS)
    if (seen.includes(name)) out.push(finding(page.file, "agents-named", `the page names ${name}, which it dropped`));
  return out;
}
// AC "The link": the header's top row links to the source with GitHub's mark
// and its name, a name no dictionary translates (the mark is decoration, the
// name is the link's), and the Star button it replaced is gone from every page.
export const SOURCE_NAME = "GitHub";
export function checkSourceLink(page) {
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
export const SOURCE_NARROW = "@media (max-width: 760px)";
export function checkSourceLinkCss(file, css) {
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
export function checkNoStatus(page) {
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
export const VALUE_FACTS = (f) => f !== "install";
export function pageSlugs(page, repo) {
  const titles = new Map(withAttr(page, "data-title").map((el) => [el.attrs["data-title"], el.text]));
  const slugs = new Set(withAttr(page, "data-slug").map((el) => el.text));
  for (const t of titles.values()) {
    slugs.add(slugify(t));
    slugs.add(repo.derive("story", "session", t));
  }
  return [...slugs].filter((s) => s && s.length > 2).sort((a, b) => b.length - a.length);
}
export function maskCopy(value, page, repo) {
  let v = value
    .split("\n")
    .map((l) => withoutLangSuffix(l.trimEnd(), page.lang, repo))
    .join("\n");
  for (const s of pageSlugs(page, repo)) v = v.split(s).join("‹slug›");
  return v.replace(/"[^"]*"/g, '"…"');
}
export function checkParity(en, page, repo) {
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

// A section label that starts with a number ("01 / Install"): the main page
// numbered its sections until the front page story, and no page does now.
export const sectionNumbers = (page) =>
  page.els.filter((el) => hasClass(el, "section-label") && /^\s*\d/.test(el.text)).map((el) => el.text.trim());

// The loop diagram's cartoon (assets/site.js) presses its blocks, svg
// .node[data-step], one by one in document order, and the loop partial writes
// them in the order of the arrows (1 to 8: task, artifact, critic, you,
// planner, implement, reviewer, done). So on every page that carries the loop
// their steps never go down: a block moved or renumbered out of that order
// would be pressed out of turn. A page with no blocks is a finding, not a pass.
export function checkPressOrder(page) {
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
export const LOOP_STEPS = 8;

// A link between pages stays in the page's language. Templates write page links from the
// language root and the build prefixes them by the page's depth below it; files every language
// shares (assets/, llms) take the depth below the site root, and so does a page of a kind not
// built in the page's language, which is linked at its English address. A page link that lands
// on another language's page, or on no page at all, is a finding. The language switcher is the
// one place that links other languages, and is skipped.
export function checkPageLinks(page, pageDirs) {
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
    if (linkedInEnglish(path, page.lang)) continue;
    if (!own.includes(path))
      out.push(finding(page.file, "page-link", `${href} lands on ${path}, which is not a ${page.lang} page`));
  }
  return unique(out);
}
// AC "Two languages": no link on a page reaches a stub — the en/ address or a
// language's main-page address that redirects to / — which the link check
// above, skipping links from the site root and the language switcher, cannot
// see. A visitor who follows one lands on / a moment later, and a crawler
// reads a redirect.
export const STUB_DIRS = STUB_LANGS.map((l) => `/${l}/`);
export function checkNoStubLinks(page) {
  const dir = `/${page.file.slice(`${SITE}/`.length).replace(/index\.html$/, "")}`;
  const out = [];
  for (const el of page.els) {
    if (el.name !== "a" || !el.attrs.href || /^[a-z][a-z0-9+.-]*:/i.test(el.attrs.href)) continue;
    const path = new URL(el.attrs.href, `https://site.invalid${dir}`).pathname.replace(/index\.html$/, "");
    if (STUB_DIRS.includes(path))
      out.push(finding(page.file, "stub-link", `${el.attrs.href} lands on ${path}, which redirects to /`));
  }
  return unique(out);
}

// AC "The order": every page has exactly one h1. The main page's is what.h1 (checkWhat); its
// chapter heads are h2 at the h1's size, so the page keeps one (the front page story).
export function checkOneH1(page) {
  const h1s = page.els.filter((el) => el.name === "h1");
  return h1s.length === 1
    ? []
    : [
        finding(
          page.file,
          "h1",
          `${h1s.length} h1 elements (${h1s.map((h) => JSON.stringify(h.text.trim().slice(0, 40))).join(", ") || "none"}); a page has one`,
        ),
      ];
}

// AC "Unique ids": no page repeats an id. The main page now carries blocks of three other
// pages, and a repeated id would send a label, a tab or a #link to the first of the two.
export function checkUniqueIds(page) {
  const seen = new Map();
  for (const el of page.els) if ("id" in el.attrs) seen.set(el.attrs.id, (seen.get(el.attrs.id) ?? 0) + 1);
  return [...seen]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => finding(page.file, "id", `id="${id}" is on ${n} elements; an id names one`));
}

// A link to one of the site's own pages that names a #fragment lands on an id of that page: the
// method pages' "Install →" (./#start, built ../#start), the mobile nav's Install, the main
// page's buttons. Same-page links read the page itself; a link to another page reads that
// page's ids (`idsAt`, by its path under the site root). A path the site builds no page at is
// the page-link and stub checks' to report, not this one's.
export const pageDir = (page) => `/${page.file.slice(`${SITE}/`.length).replace(/index\.html$/, "")}`;
export function checkFragments(page, idsAt) {
  const dir = pageDir(page);
  const own = new Set(page.els.filter((el) => "id" in el.attrs).map((el) => el.attrs.id));
  const out = [];
  for (const el of page.els) {
    const href = el.attrs.href;
    if (el.name !== "a" || !href || !href.includes("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(ORIGIN)) continue;
    const url = href.startsWith(ORIGIN) ? new URL(href) : new URL(href, `https://site.invalid${dir}`);
    const id = decodeURIComponent(url.hash.slice(1));
    if (!id) continue;
    const path = url.pathname.replace(/index\.html$/, "");
    const ids = path === dir ? own : idsAt[path];
    if (ids && !ids.has(id))
      out.push(finding(page.file, "fragment", `${href} lands on ${path}, which has no id="${id}"`));
  }
  return unique(out);
}
// Every page's ids by its path under the site root ("/", "/ru/", "/de/how-it-works/").
export const idsByPath = (pages) =>
  Object.fromEntries(
    pages
      .filter((p) => p.page)
      .map((p) => [
        `/${pagePath(p.lang, p.slug)}`,
        new Set(p.page.els.filter((el) => "id" in el.attrs).map((el) => el.attrs.id)),
      ]),
  );

// Every page folder per language, as the build writes them: "" or "de/" plus each kind's slug,
// for each kind built in that language.
export const pageDirsByLang = (langs) =>
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
//   sections   the main page's section ids in page order; no page numbers its
//              section labels;
//   named      the places that, with its description, name every published
//              harness: each a name and the section ids read together;
//   prose      "no commands": its prose names no ProjectStore command (the
//              main page shows what the user says, not what the agent runs);
//   proseSections  the sections that rule reads, where it does not read the
//              whole page;
//   words      the English page's word budget.
// The main page (PS-HARNESS: "The front page says what ProjectStore is …"):
// its six chapters in the story's order; How it works' blocks with their
// facts, its example story and the loop diagram, and One vault's measured
// figures with their sources; "no commands" over its first two chapters, what
// through talk, since the method blocks carry their pages' wording, commands
// and all; and 3,300 words, the story's budget.
export const KIND_RULES = {
  main: {
    facts: ["version", "install", "prompt", "agents", "mcp-tools", "mcp-tool"],
    templates: ["story"],
    source: true,
    loop: true,
    sections: [
      "what",
      "start",
      "quick",
      "talk",
      "how",
      "loop",
      "agents",
      "mechanisms",
      "evidence",
      "fine-print",
      "team",
      "modes",
      "git",
      "why",
      "timeline",
      "cost",
      "chain",
      "free",
    ],
    named: { "the hero (#what)": ["what"], "the install chapter (#start with #quick)": ["start", "quick"] },
    prose: "no commands",
    proseSections: ["what", "start", "quick", "talk"],
    words: 3400,
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
export const rulesOf = (page) => KIND_RULES[page.kind] ?? {};

// AC 4: a page carries every fact its kind's rules name, the example
// artifacts' data-template among them; and a value fact is a leaf, its text
// the fact.
export function checkRequired(page, repo, rules = rulesOf(page)) {
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

// AC "The order": the main page's sections run in the order of the story's
// table, "The page, top to bottom"; no page numbers a section label.
export function checkSections(page, rules = rulesOf(page)) {
  const out = [];
  const want = rules.sections ?? [];
  const nums = sectionNumbers(page).length;
  if (nums)
    out.push(finding(page.file, "section-number", `${nums} numbered section labels; a ${page.kind} page has 0`));
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
export const LOADS = {
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  iframe: ["src"],
  use: ["href", "xlink:href"],
};
export const NON_FETCHING_RELS = new Set(["canonical", "alternate", "author", "help", "license", "next", "prev"]);
export const foreign = (url) => {
  const u = url.trim();
  return u.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^data:/i.test(u));
};
export const srcset = (value) =>
  value
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);

export function cssLoads(css) {
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

export function scriptLoads(js) {
  return [...stripComments(js).matchAll(/(?<![\w$.])(fetch|import)\s*\(\s*(?:(["'`])((?:(?!\2)[^\\]|\\.)*)\2)?/g)].map(
    (m) => [`${m[1]}(`, m[3] ?? null],
  );
}

// A target on the site's own origin, as a path under site/ — or null for an
// in-document reference (#id) or a data: URI.
export function ownTarget(file, url) {
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
export const SITE_FS = {
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
export function missingTarget(own, fsys) {
  const target = own.endsWith("/") || fsys.isDir(own) ? posix.join(own, "index.html") : own;
  return fsys.isFile(target) ? null : target;
}

export function checkLoads(file, text, fsys = SITE_FS) {
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
export function checkBudget(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  return total > BUDGET
    ? [finding(`${SITE}/`, "budget", `${total} bytes in ${files.length} files; the budget is ${BUDGET}`)]
    : [];
}

// AC 6: a measured figure carries data-source — README.md or a docs/ page and
// the anchor of the passage it comes from — and that heading exists.
export function checkSources(page, repo) {
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
export const REVIEW_STATUS = ["pending", "reviewed"];
export function checkShapes(page, repo) {
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
export const NUMBERED = /\b(?:ADR-\d+|SPEC-\d+|story-\d+)\b/g;
export const checkNumbered = (file, texts) =>
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
export const EXAMPLE_PATH =
  /(?<![\w/.-])(?:adr|specs)\/(?!README\.md)[^\s"'<>|\]()`]+\.md|stories\/story-[^\s"'<>|\]()`]+/g;
export function checkSlugs(page, repo) {
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
export function checkAssetVersions(page, hashes) {
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
// has a page of every kind built in its language, and every index.html under
// site/ is one of those pages, the stubs aside. A slug renamed, a kind or a
// language dropped, leaves no orphan folder behind for Pages to keep serving.
export function checkPageSet(langs, files, isFile) {
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
    if (want.has(file)) continue;
    if (STUB_FILES.includes(file)) continue;
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
export function checkAlternates(page, langs) {
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

// AC "Install first": the prompt the site offers is README's, word for word —
// every data-fact="prompt" says the blockquote line under "### In a Claude Code
// session" — so what a reader copies is what README tells them to say.
export function checkPrompt(page, repo) {
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
export const visibleWords = (page) =>
  bodyText(page)
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
export function checkWords(page, budget) {
  const n = visibleWords(page);
  return n > budget
    ? [finding(page.file, "words", `${n} visible words; a ${page.kind} page has a budget of ${budget}`)]
    : [];
}

// AC "Prompts, not commands": the main page shows what the user says, not
// what the agent runs. Outside the blocks marked data-fact="install" (README's
// install and configure lines) and the example files (data-template), its text
// and attribute values hold no invocation in any harness's form and no
// package-runner line of ours. Where its kind's rules name sections
// (proseSections), the rule reads those and nothing else: on the main page,
// what through talk (AC "No commands up top"); the method blocks below carry
// their pages' wording, which names commands as the method pages do. A named
// section that is not there is a finding, not a pass.
export function checkNoCommands(page, repo, rules = rulesOf(page)) {
  const exempt = page.els.filter((el) => el.attrs["data-fact"] === "install" || "data-template" in el.attrs);
  const outer = exempt.filter((el) => !exempt.some((o) => o !== el && within(o, el)));
  const out = [];
  const scoped = (rules.proseSections ?? []).map((id) => [
    id,
    page.els.find((el) => el.name === "section" && el.attrs.id === id),
  ]);
  for (const [id, sec] of scoped)
    if (!sec)
      out.push(finding(page.file, "command", `no section#${id}; the rule reads ${rules.proseSections.join(", ")}`));
  const spans = rules.proseSections
    ? scoped.filter(([, sec]) => sec).map(([, sec]) => [sec.start, sec.end + sec.inner.length])
    : [[0, page.markup.length]];
  const inSpan = (el) => spans.some(([from, to]) => el.start >= from && el.start < to);
  const texts = [];
  for (const [from, to] of spans) {
    let rest = page.markup.slice(from, to);
    for (const el of outer.filter((o) => o.start >= from && o.start < to).sort((a, b) => b.start - a.start))
      rest = rest.slice(0, el.start - from) + rest.slice(el.end + el.inner.length - from);
    texts.push(decode(rest.replace(ANY_TAG, " ")));
  }
  texts.push(
    ...page.els
      .filter((el) => inSpan(el) && !exempt.some((b) => b === el || within(b, el)))
      .flatMap((el) => Object.values(el.attrs)),
  );
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
export function checkPreview(page) {
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
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR")
    return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
// …and the image they name is a file under site/, a 1280×640 PNG.
export function checkPreviewImage(file, buf) {
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
export const NAMED_COLOURS = new Set(
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
export function colourLiteral(value) {
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
export function checkColourCss(file, css) {
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
export const PAINT = /^(?:none|currentcolor|var\(--[\w-]+\)|url\(#[\w-]+\))$/i;
export function checkColourAttrs(file, html) {
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
export function cssBlocks(css) {
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
export const declarations = (body) =>
  Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:([^;]*)/g)].map((m) => [m[1], m[2].trim()]));
// The palette: every top-level block whose selector is exactly :root.
export const rootTokens = (blocks) =>
  Object.assign({}, ...blocks.filter((b) => b.head === ":root").map((b) => declarations(b.body)));
// Any at-rule is walked (a tone rule in @supports or @layer is still a tone
// rule); only an @media sets the media the rule sits under. A tone rule is a
// block whose selector is exactly :root[data-tone="…"]; a rule that names a
// tone and goes on to an element (the dark tones' classic shapes) is a shape
// rule, held by checkColourCss and checkGlow, not a tone; it sets no token.
export function toneRules(blocks, media = null) {
  return blocks.flatMap((b) => {
    if (b.head.startsWith("@")) return toneRules(b.blocks, b.head.startsWith("@media") ? b.head : media);
    const tone = /^:root\[data-tone="([a-z]+)"\]$/.exec(b.head)?.[1];
    const scheme = /(?:^|;)\s*color-scheme\s*:\s*([^;]+)/.exec(b.body)?.[1].trim() ?? null;
    return tone ? [{ tone, head: b.head, media, scheme, tokens: declarations(b.body) }] : [];
  });
}
export const DEFAULT_TONE = "midnight";
// The tone every page ships in, named in its markup: light (<html
// data-tone="light">) from the look story of 2026-10-22, midnight since the
// maintainer's word of 2026-10-27; the palette on :root is midnight's, the
// source the tones draw from. With nothing stored, a system that asks for a
// light page (prefers-color-scheme: light) gets LIGHT_TONE instead.
export const SHIP_TONE = "midnight";
export const LIGHT_TONE = "paper";
export const TONE_KEY = "ps_tone";
// What a tone may change: the surfaces (a role's tint on a panel among them),
// the lines, the header tint and the glow. A light tone may also recolour what
// midnight's values would leave unreadable on its ground: the inks, the accent
// family and the text on the accent, the roles with their lines and glows, the
// experimental and epic marks, the menu shadow and the wordmark's dot.
export const TONE_TOKENS =
  /^--(?:bg(?:-[0-4]|-pop)?|dot|line-[1-5]|graph|glow-[1-3]|head-bg|(?:accent|check|plan|done)-bg)$/;
export const LIGHT_TOKENS =
  /^--(?:ink(?:-hi|-[2-5])?|on-accent|accent(?:-soft|-glow|-row)?|check(?:-glow)?|(?:plan|done)(?:-line|-glow)?|exp(?:-line)?|epic|shade|brand)$/;
export const WASHES = ["--accent-bg", "--check-bg", "--plan-bg", "--done-bg"];
// Each tone's tokens, resolved: the palette, with the tone's rule over it.
export const toneSets = (css) => {
  const blocks = cssBlocks(css);
  const root = rootTokens(blocks);
  return [[DEFAULT_TONE, root], ...toneRules(blocks).map((r) => [r.tone, { ...root, ...r.tokens }])];
};
export function resolveToken(tokens, name) {
  let value = tokens[name];
  for (let i = 0; i < 8 && value; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = tokens[ref[1]];
  }
  return value ?? null;
}
export function rgba(value) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value ?? "");
  if (!m) return null;
  const at = (i) => parseInt(m[1].slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
// A tone is light when its resolved base is: a luminance above 0.5.
export const isLight = (tokens) => {
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
export function checkTones(file, css) {
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
  const shows = blocks.some((b) => /^:root\[data-tones\] \.tone-switch$/.test(b.head) && /display:/.test(b.body));
  if (!hides || !shows)
    out.push(
      finding(
        file,
        "tone",
        ".tone-switch is not hidden until :root[data-tones] shows it; without the script it would show",
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
export const INK5_FLOOR = 3.69;
export const luminance = ({ r, g, b }) =>
  [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
export const over = (top, under) => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});
export const TEXT_FLOORS = [
  ...["--ink", "--ink-2", "--ink-3", "--ink-4"].map((n) => [n, 4.5]),
  ["--ink-5", INK5_FLOOR],
  ...["--accent", "--check", "--plan", "--done", "--exp", "--epic"].map((n) => [n, 4.5]),
  ["--brand", 3],
];
export function checkToneContrast(file, css) {
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

// AC "White by default" (the look story; before it, "Midnight by default"),
// "One two-way switch" and "Remembered, without a flash": a page ships in
// SHIP_TONE — <html data-tone="midnight">, its theme-color that tone's --bg — and
// carries the switch, a named
// position per tone with aria-pressed, and in <head>, after the stylesheet,
// the one early script that reads the tone's key and sets data-tone.
export function checkTonePage(page, tones, bg) {
  const out = [];
  const html = page.els.find((el) => el.name === "html");
  if (html?.attrs["data-tone"] !== SHIP_TONE)
    out.push(
      finding(page.file, "tone", `<html data-tone="${html?.attrs["data-tone"] ?? ""}">: a page ships in ${SHIP_TONE}`),
    );
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "theme-color");
  if ((meta?.attrs.content ?? "").toLowerCase() !== bg.toLowerCase())
    out.push(
      finding(
        page.file,
        "theme-color",
        `theme-color is ${meta?.attrs.content ?? "missing"}; ${SHIP_TONE} --bg is ${bg}`,
      ),
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
  else if (
    /location\.replace\(/.test(early[0][1]) ||
    !/setAttribute\("data-tone"/.test(early[0][1]) ||
    !/setAttribute\("data-tones"/.test(early[0][1])
  )
    out.push(finding(page.file, "tone-script", "the early script redirects, or sets no data-tone or no data-tones"));
  return out;
}

// The key site.js reads and writes is the key the early script reads.
export function checkToneKey(file, js, early) {
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
export function checkToneScript(file, partial, tones) {
  const code = /<script>([\s\S]*?)<\/script>/.exec(partial)?.[1];
  if (!code) return [finding(file, "tone-script", "the partial holds no script")];
  const run = (stored, light = false) => {
    const attrs = {};
    const storage = {
      getItem: (key) => {
        if (stored instanceof Error) throw stored;
        return key === TONE_KEY ? stored : null;
      },
    };
    const sandbox = {
      document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) }, querySelector: () => null },
      matchMedia: (q) => ({ matches: light && /prefers-color-scheme:\s*light/.test(q) }),
      localStorage: storage,
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    };
    try {
      runInNewContext(code, sandbox);
    } catch (e) {
      return `an error (${e.message})`;
    }
    return "data-tones" in attrs ? (attrs["data-tone"] ?? "none") : "set without data-tones";
  };
  const cases = [
    ...tones.map((t) => [`"${t}" stored`, t, t]),
    ["nothing stored", null, SHIP_TONE],
    ['"sepia" stored', "sepia", SHIP_TONE],
    ["storage that throws", new Error("storage is off"), SHIP_TONE],
    ["nothing stored, a light system", null, LIGHT_TONE, true],
    ['"midnight" stored, a light system', "midnight", "midnight", true],
  ];
  return cases.flatMap(([label, stored, want, light]) => {
    const got = run(stored, light);
    return got === want ? [] : [finding(file, "tone-script", `${label}: data-tone is ${got}; ${want} is expected`)];
  });
}

// AC "Three positions": the page links leave the header row exactly where the
// second row appears, one below .wrap's 1200 px, where the de and fr links
// need the page's full width. One media query, (max-width: 1199px), hides the
// links, shows the row and gives anchors the taller header's clearance; the
// row is hidden outside it; no other rule hides the links; and a link never
// wraps the row.
export const HEADER_ROWS = "@media (max-width: 1199px)";
export function checkHeaderRows(file, css) {
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

// AC "What it is" (PS-HARNESS "The front page in all eight languages …"): the
// hero, section.hero.what#what, holds what.label over the page's one h1 on
// what.h1; the three paragraphs what.p.1 to 3; the Install button to #start
// and the How it works button to #how; the agents line on hero.agents
// (checkAgents holds its names); the label what.why over ul.why-list, five
// lines, each a dot and pains.now.n; and the comparison under cmp.title, in
// four blocks in this order. The table, table.cmp: five header cells
// (cmp.col.1 to 5) and five body rows — the approaches ProjectStore draws on,
// tr.from, a prompt in a chat, agent memory, SDD and PDD, then ProjectStore
// itself, tr.us — and cmp.sum under it. A row's first cell holds its name and
// its scope (cmp.<row>.2), agent memory its examples (cmp.mem.ex) between, the
// four after it cmp.<row>.3 to 6; only the chat and memory rows' names are
// keys (cmp.chat.1, cmp.mem.1), as "SDD", "PDD" and "ProjectStore" read the
// same in every language. The rating, rate.title over table.rate and rate.note
// under it: the same five approaches by six needs (rate.col.1 to 6), each
// cell three marks with RATING's number lit and that number of three for a
// screen reader. The choice tree, tree.title over ol.tree: four questions,
// tree.q.1 to 4, each answering yes with the next approach of the table and
// no with the next question, ending in ProjectStore. The ladder, ladder.title
// over ol.ladder: five steps, each one brick more than the one before
// (ladder.b.n down to ladder.b.1), the last ProjectStore's, li.us, with
// ladder.b.5 on top. What this cannot see: the drawing, which is the browser
// check's.
export const WHAT_PARAGRAPHS = ["what.p.1", "what.p.2", "what.p.3"];
export const WHAT_BUTTONS = [
  ["what.cta.install", "#start"],
  ["what.cta.how", "#how"],
];
export const WHY_LINES = 5;
export const CMP_COLUMNS = 5;
export const CMP_ROWS = [
  ["chat", "from", null],
  ["mem", "from", null],
  ["sdd", "from", "SDD"],
  ["pdd", "from", "PDD"],
  ["ps", "us", "ProjectStore"],
];
// The rating, as the maintainer chose it on the canvas of 2026-10-24: sessions,
// people, backlog, decisions, proof, easy to start.
export const RATE_COLUMNS = 6;
export const RATING = {
  chat: [0, 0, 0, 0, 0, 3],
  mem: [2, 0, 0, 1, 0, 3],
  sdd: [1, 2, 1, 1, 2, 2],
  pdd: [1, 1, 0, 0, 3, 2],
  ps: [3, 3, 3, 3, 3, 2],
};
export const COMPARISON_BLOCKS = [
  "cmp.title",
  "table.cmp",
  "cmp.sum",
  "rate.title",
  "table.rate",
  "rate.note",
  "tree.title",
  "ol.tree",
  "ladder.title",
  "ol.ladder",
];
export const keyOf = (el) => el?.attrs["data-i18n"] ?? null;
export function checkWhat(page) {
  const what = page.els.find((el) => el.name === "section" && el.attrs.id === "what");
  if (!what || !hasClass(what, "hero") || !hasClass(what, "what"))
    return [finding(page.file, "what", 'no section.hero.what with id="what"')];
  const inside = page.els.filter((el) => within(what, el));
  const keyed = (k) => inside.filter((el) => keyOf(el) === k);
  const broken = [];
  const h1s = inside.filter((el) => el.name === "h1");
  if (h1s.length !== 1 || keyOf(h1s[0]) !== "what.h1")
    broken.push(`#what holds ${h1s.length} h1 (${h1s.map(keyOf).join(", ") || "none"}); one, on what.h1`);
  const label = keyed("what.label");
  if (label.length !== 1 || !hasClass(label[0], "section-label") || (h1s[0] && label[0].start > h1s[0].start))
    broken.push("what.label is not one section label above the h1");
  const paragraphs = inside.filter((el) => el.name === "p" && /^what\.p\.\d+$/.test(keyOf(el) ?? "")).map(keyOf);
  if (paragraphs.join() !== WHAT_PARAGRAPHS.join())
    broken.push(`the paragraphs run ${paragraphs.join(", ") || "none"}; ${WHAT_PARAGRAPHS.join(", ")}`);
  for (const [k, href] of WHAT_BUTTONS) {
    const links = inside.filter((el) => el.name === "a" && keyOf(el) === k);
    if (links.length !== 1 || links[0].attrs.href !== href)
      broken.push(
        `${k} links ${links.map((a) => a.attrs.href ?? "nowhere").join(", ") || "nothing"}; one link to ${href}`,
      );
  }
  const lines = inside.filter((el) => hasClass(el, "agents-line"));
  if (lines.length !== 1 || keyOf(lines[0]) !== "hero.agents")
    broken.push(
      `#what holds ${lines.length} agents lines (${lines.map(keyOf).join(", ") || "none"}); one, on hero.agents`,
    );
  const why = keyed("what.why");
  const lists = inside.filter((el) => el.name === "ul" && hasClass(el, "why-list"));
  const rows = lists.length === 1 ? inside.filter((el) => el.name === "li" && within(lists[0], el)) : [];
  const whyLines = rows.map((li) => {
    const keys = inside.filter((el) => within(li, el) && keyOf(el)).map(keyOf);
    const dot = inside.some((el) => within(li, el) && hasClass(el, "dot"));
    return (dot ? "" : "no dot+") + keys.join("+");
  });
  const wantLines = Array.from({ length: WHY_LINES }, (_, i) => `pains.now.${i + 1}`);
  if (why.length !== 1 || !hasClass(why[0], "section-label") || lists.length !== 1 || why[0].start > lists[0].start)
    broken.push(`${why.length} what.why labels over ${lists.length} ul.why-list; one section label over one`);
  else if (whyLines.join() !== wantLines.join())
    broken.push(`the why lines run ${whyLines.join(", ") || "none"}; ${WHY_LINES}, a dot and pains.now.n`);
  const tables = inside.filter((el) => el.name === "table" && hasClass(el, "cmp"));
  if (tables.length !== 1) broken.push(`#what holds ${tables.length} table.cmp; one`);
  else {
    const [table] = tables;
    const cells = inside.filter((el) => within(table, el));
    const heads = cells.filter((el) => el.name === "th").map((el) => keyOf(el) ?? "none");
    const wantHeads = Array.from({ length: CMP_COLUMNS }, (_, i) => `cmp.col.${i + 1}`);
    if (heads.join() !== wantHeads.join())
      broken.push(`the comparison's header cells are ${heads.join(", ") || "none"}; ${wantHeads.join(", ")}`);
    const body = cells.find((el) => el.name === "tbody");
    const trs = body ? cells.filter((el) => el.name === "tr" && within(body, el)) : [];
    const rowKeys = trs.map((tr) => cells.filter((el) => within(tr, el) && keyOf(el)).map(keyOf));
    const names = rowKeys.map((keys) => /^cmp\.([a-z]+)\.\w+$/.exec(keys[0] ?? "")?.[1] ?? "?");
    const wantNames = CMP_ROWS.map(([row]) => row);
    if (trs.length !== CMP_ROWS.length) broken.push(`the comparison has ${trs.length} body rows; ${CMP_ROWS.length}`);
    else if (names.join() !== wantNames.join())
      broken.push(`the comparison's rows run ${names.join(", ")}; ${wantNames.join(", ")}`);
    else
      CMP_ROWS.forEach(([row, cls, name], i) => {
        const tr = trs[i];
        const keys = [
          ...(name ? [] : [`cmp.${row}.1`]),
          ...(row === "mem" ? ["cmp.mem.ex"] : []),
          ...[2, 3, 4, 5, 6].map((n) => `cmp.${row}.${n}`),
        ];
        const tds = cells.filter((el) => el.name === "td" && within(tr, el));
        const b = cells.find((el) => el.name === "b" && within(tr, el));
        const named = name ? b && !keyOf(b) && b.text.trim() === name : keyOf(b) === `cmp.${row}.1`;
        if (!hasClass(tr, cls) || tds.length !== CMP_COLUMNS || !named || rowKeys[i].join() !== keys.join())
          broken.push(
            `the ${row} row is not a tr.${cls} of ${CMP_COLUMNS} cells, named ${name ?? `on cmp.${row}.1`}, on ${keys.join(", ")}`,
          );
      });
    for (const [k, under] of [
      ["cmp.title", false],
      ["cmp.sum", true],
    ]) {
      const els = keyed(k);
      const end = table.end + table.inner.length;
      if (els.length !== 1 || (under ? els[0].start < end : els[0].start > table.start))
        broken.push(`${k} is not once ${under ? "under" : "above"} the table`);
    }
  }
  broken.push(...checkComparisonBlocks(inside, keyed));
  return broken.length ? [finding(page.file, "what", broken.join("; "))] : [];
}

// The rating, the tree and the ladder, and the order of the comparison's four
// blocks. A row's name: its key (cmp.chat.1, cmp.mem.1) or its plain text.
const rowName = (inside, box) => {
  const named = inside.find((el) => within(box, el) && /^cmp\.(?:chat|mem)\.1$/.test(keyOf(el) ?? ""));
  if (named) return /^cmp\.([a-z]+)\./.exec(keyOf(named))[1];
  const plain = inside.find((el) => within(box, el) && (el.name === "b" || el.name === "th") && !keyOf(el));
  return CMP_ROWS.find(([, , name]) => name && plain?.text.trim() === name)?.[0] ?? "?";
};
function checkComparisonBlocks(inside, keyed) {
  const broken = [];
  const one = (sel) => {
    const [name, cls] = sel.split(".");
    const found = inside.filter((el) => el.name === name && hasClass(el, cls));
    return found.length === 1 ? found[0] : null;
  };
  // "table.cmp" is an element and its class; "cmp.title" a key
  const at = COMPARISON_BLOCKS.map((b) =>
    /^(?:table|ol)\./.test(b) ? one(b) : keyed(b).length === 1 ? keyed(b)[0] : null,
  );
  const missing = COMPARISON_BLOCKS.filter((b, i) => !at[i]);
  if (missing.length) return [`the comparison has no single ${missing.join(", ")}`];
  if (at.some((el, i) => i && el.start < at[i - 1].start))
    broken.push(`the comparison's blocks do not run ${COMPARISON_BLOCKS.join(", ")}`);
  const [rate, tree, ladder] = [at[4], at[7], at[9]];
  // the rating
  const cells = inside.filter((el) => within(rate, el));
  const head = cells.find((el) => el.name === "thead");
  const heads = head ? cells.filter((el) => within(head, el) && keyOf(el)).map(keyOf) : [];
  const wantHeads = ["cmp.col.1", ...Array.from({ length: RATE_COLUMNS }, (_, i) => `rate.col.${i + 1}`)];
  if (heads.join() !== wantHeads.join())
    broken.push(`the rating's header holds ${heads.join(", ") || "nothing"}; ${wantHeads.join(", ")}`);
  const body = cells.find((el) => el.name === "tbody");
  const trs = body ? cells.filter((el) => el.name === "tr" && within(body, el)) : [];
  const names = trs.map((tr) => rowName(cells, tr));
  const wantNames = CMP_ROWS.map(([row]) => row);
  if (names.join() !== wantNames.join())
    broken.push(`the rating's rows run ${names.join(", ")}; ${wantNames.join(", ")}`);
  else
    trs.forEach((tr, i) => {
      const row = names[i];
      const tds = cells.filter((el) => el.name === "td" && within(tr, el));
      const marks = tds.map((td) => {
        const box = cells.find((el) => within(td, el) && hasClass(el, "marks") && el.attrs["aria-hidden"] === "true");
        const dots = box ? cells.filter((el) => el.name === "i" && within(box, el)) : [];
        const lit = dots.filter((el) => hasClass(el, "on")).length;
        const said = cells.find((el) => within(td, el) && hasClass(el, "visually-hidden"))?.text.trim();
        return dots.length === 3 && said === `${lit}/3` ? lit : `${lit} of ${dots.length} said ${said ?? "nothing"}`;
      });
      if (hasClass(tr, "us") !== (row === "ps"))
        broken.push(`the rating's ${row} row is ${row === "ps" ? "not " : ""}tr.us`);
      if (marks.join() !== RATING[row].join())
        broken.push(`the rating's ${row} row is ${marks.join(", ")}; ${RATING[row].join(", ")}`);
    });
  // the tree
  const items = inside.filter((el) => el.name === "li" && within(tree, el));
  const steps = items.filter((el) => hasClass(el, "tree-step"));
  const runs = steps.map((li) => {
    const q = inside.find((el) => within(li, el) && hasClass(el, "tree-q"));
    const a = inside.find((el) => within(li, el) && hasClass(el, "tree-a"));
    const yes = inside.some((el) => within(li, el) && keyOf(el) === "tree.yes");
    const no = inside.some((el) => within(li, el) && keyOf(el) === "tree.no");
    return `${keyOf(q) ?? "?"}>${yes && a ? rowName(inside, a) : "?"}${no ? "" : " without no"}`;
  });
  const wantRuns = CMP_ROWS.slice(0, 4).map(([row], i) => `tree.q.${i + 1}>${row}`);
  if (runs.join() !== wantRuns.join())
    broken.push(`the tree runs ${runs.join(", ") || "nothing"}; ${wantRuns.join(", ")}`);
  const end = items.filter((el) => hasClass(el, "tree-end"));
  const last = items.at(-1);
  if (
    end.length !== 1 ||
    last !== end[0] ||
    rowName(inside, end[0]) !== "ps" ||
    !inside.some((el) => within(end[0], el) && keyOf(el) === "tree.end")
  )
    broken.push("the tree does not end in ProjectStore, one li.tree-end with tree.end, after its four questions");
  // the ladder
  const rungs = inside.filter((el) => el.name === "li" && within(ladder, el));
  if (rungs.length !== CMP_ROWS.length) broken.push(`the ladder has ${rungs.length} steps; ${CMP_ROWS.length}`);
  else
    rungs.forEach((li, i) => {
      const bricks = inside.filter((el) => within(li, el) && hasClass(el, "brick")).map(keyOf);
      const want = Array.from({ length: i + 1 }, (_, j) => `ladder.b.${i + 1 - j}`);
      const row = rowName(inside, li);
      if (bricks.join() !== want.join() || row !== CMP_ROWS[i][0] || hasClass(li, "us") !== (i === CMP_ROWS.length - 1))
        broken.push(
          `the ladder's step ${i + 1} is ${row} on ${bricks.join(", ")}; ${CMP_ROWS[i][0]} on ${want.join(", ")}`,
        );
    });
  return broken;
}

// AC "Install": quick start, section#quick's ol.qs, runs six steps — two for a
// beginner (an agent; Node.js and a project folder), then the four it had —
// each with an h3 on its key, and the third holds the install box with its
// install line and its prompt, which no other step does. A step is an li of
// the list itself: the options in step 5 are a list of their own inside it.
export const QUICK_STEPS = ["quick.s.a.h", "quick.s.b.h", "quick.s.1.h", "quick.s.2.h", "quick.s.3.h", "quick.s.4.h"];
export const INSTALL_STEP = 3;
export function quickSteps(page) {
  const quick = page.els.find((el) => el.name === "section" && el.attrs.id === "quick");
  const list = quick && page.els.find((el) => el.name === "ol" && hasClass(el, "qs") && within(quick, el));
  if (!list) return null;
  const nested = page.els.filter((el) => (el.name === "ol" || el.name === "ul") && el !== list && within(list, el));
  const steps = page.els.filter((el) => el.name === "li" && within(list, el) && !nested.some((l) => within(l, el)));
  return { quick, steps };
}
export function checkQuickStart(page) {
  const q = quickSteps(page);
  if (!q) return [finding(page.file, "quick-start", "no ol.qs in section#quick")];
  const broken = [];
  const heads = q.steps.map((li) => keyOf(page.els.find((el) => el.name === "h3" && within(li, el))) ?? "none");
  if (heads.join() !== QUICK_STEPS.join())
    broken.push(
      `${q.steps.length} steps on ${heads.join(", ") || "no keys"}; ${QUICK_STEPS.length}, on ${QUICK_STEPS.join(", ")}`,
    );
  const boxes = page.els.filter((el) => "data-tabs" in el.attrs && within(q.quick, el));
  const at = boxes.map((box) => q.steps.findIndex((li) => within(li, box)) + 1 || "none");
  if (at.join() !== String(INSTALL_STEP))
    broken.push(`the install box is in step ${at.join(", ") || "none"}; in step ${INSTALL_STEP} alone`);
  else if (
    !["install", "prompt"].every((f) => page.els.some((el) => el.attrs["data-fact"] === f && within(boxes[0], el)))
  )
    broken.push('the install box does not hold the data-fact="install" line and the data-fact="prompt"');
  return broken.length ? [finding(page.file, "quick-start", broken.join("; "))] : [];
}

// AC "The order" and "The method's blocks": the main page's four chapter
// heads, section.sec.chapter, each a label, an h2 and a lead on the story's
// keys — How it works', One vault's and Why it works' own heading and lead, set
// as h2 so the page keeps one h1. The loop, under How it works' head, belongs
// to it: no label and no heading of its own, named by the player's caption.
// One vault's and Why it works' digests each end on a link to the whole page.
export const CHAPTERS = [
  ["start", "start.label", "start.h2", "start.lead"],
  ["how", "how.label", "how.h1", "how.lead"],
  ["team", "team.label", "vault.h1", "teams.p.1"],
  ["why", "why.label", "why.h2.1", "why.p.1"],
];
export const MORE_LINKS = [
  ["git", "team.more", "one-vault"],
  ["chain", "why.more", "why-it-works"],
];
export function checkChapters(page) {
  const sections = page.els.filter((el) => el.name === "section");
  const byId = (id) => sections.find((el) => el.attrs.id === id);
  const inside = (box) => page.els.filter((el) => within(box, el));
  const role = (el) =>
    hasClass(el, "section-label") ? "label" : el.name === "p" && hasClass(el, "lead") ? "lead" : el.name;
  const broken = [];
  const heads = sections.filter((el) => hasClass(el, "chapter")).map((el) => el.attrs.id ?? "");
  if (heads.join() !== CHAPTERS.map(([id]) => id).join())
    broken.push(`the chapter heads are ${heads.join(", ") || "none"}; ${CHAPTERS.map(([id]) => id).join(", ")}`);
  for (const [id, label, h2, lead] of CHAPTERS) {
    const sec = byId(id);
    if (!sec) {
      broken.push(`no section#${id}`);
      continue;
    }
    const said = inside(sec)
      .filter(keyOf)
      .map((el) => `${role(el)} ${keyOf(el)}`);
    const want = [`label ${label}`, `h2 ${h2}`, `lead ${lead}`];
    if (said.join() !== want.join()) broken.push(`#${id} holds ${said.join(", ") || "nothing"}; ${want.join(", ")}`);
  }
  const loop = byId("loop");
  if (!loop) broken.push("no section#loop");
  else {
    const held = inside(loop);
    const own = held.filter((el) => hasClass(el, "section-label") || /^h[1-6]$/.test(el.name));
    if (own.length)
      broken.push(
        `#loop holds ${own.map((el) => (hasClass(el, "section-label") ? "a section label" : el.name)).join(", ")}; the how chapter's head is its heading`,
      );
    const by = loop.attrs["aria-labelledby"];
    const cap = held.find((el) => el.attrs.id === by);
    const player = held.find((el) => "data-player" in el.attrs);
    if (!cap || cap.name !== "figcaption" || !player || !within(player, cap))
      broken.push(`#loop is labelled by ${by ? `#${by}` : "nothing"}; by the player's caption`);
  }
  for (const [id, k, kind] of MORE_LINKS) {
    const sec = byId(id);
    const links = page.els.filter((el) => el.name === "a" && keyOf(el) === k);
    const lands = links.map((a) => new URL(a.attrs.href ?? "", `https://site.invalid${pageDir(page)}`).pathname);
    const want = `/${pagePath(page.lang, slugOf(kind))}`;
    if (links.length !== 1 || !sec || !within(sec, links[0]) || lands[0] !== want)
      broken.push(`${k} links ${lands.join(", ") || "nothing"}; once, from #${id}, to ${want}`);
  }
  return broken.length ? [finding(page.file, "chapters", broken.join("; "))] : [];
}

// AC "The method's blocks": each block the main page copies from a method page
// carries that block's keys in that block's order — no key new, renamed or
// lost — less what the story cuts: a method page's next-page row (.next-pages)
// and its closing prompt box (.ask), which the main page replaces by a link to
// the whole page (its own .next-pages, held by checkChapters) or leaves out,
// and the cost section's first paragraphs (the story keeps its label, heading,
// equation and the paragraph after it). A prompt box kept on the main page is
// read, and is a finding. For the loop, the diagram (figure.loop): the partial
// both pages include.
export const COPIED = [
  { id: "loop", kind: "how-it-works", part: "loop" },
  { id: "agents", kind: "how-it-works" },
  { id: "mechanisms", kind: "how-it-works" },
  { id: "evidence", kind: "how-it-works" },
  { id: "fine-print", kind: "how-it-works" },
  { id: "modes", kind: "one-vault" },
  { id: "git", kind: "one-vault" },
  { id: "timeline", kind: "why-it-works" },
  { id: "cost", kind: "why-it-works", cut: ["why.p.3", "why.miss", "why.p.5"] },
  { id: "chain", kind: "why-it-works" },
];
export const CUT_THEIRS = ["next-pages", "ask"];
export const CUT_OURS = ["next-pages"];
export function blockKeys(page, id, part, parts) {
  const sec = page.els.find((el) => el.name === "section" && el.attrs.id === id);
  const box = sec && part ? page.els.find((el) => hasClass(el, part) && within(sec, el)) : sec;
  if (!box) return null;
  const inside = page.els.filter((el) => within(box, el));
  const cut = inside.filter((el) => parts.some((c) => hasClass(el, c)));
  return inside
    .filter((el) => !cut.some((c) => c === el || within(c, el)))
    .flatMap((el) => [
      ...(el.attrs["data-i18n"] ? [el.attrs["data-i18n"]] : []),
      ...(el.attrs["data-i18n-attr"] ?? "")
        .split(";")
        .filter(Boolean)
        .map((pair) => pair.split(":")[1]),
    ]);
}
export function checkCopied(main, methods) {
  const out = [];
  for (const { id, kind, part, cut = [] } of COPIED) {
    const where = `#${id}${part ? ` .${part}` : ""}`;
    const theirs = methods[kind] ? blockKeys(methods[kind], id, part, CUT_THEIRS) : null;
    const ours = blockKeys(main, id, part, CUT_OURS);
    if (!theirs || !ours) {
      out.push(finding(main.file, "copied", `${where}: ${ours ? `${kind} has` : "the main page has"} no such block`));
      continue;
    }
    for (const k of cut.filter((c) => !theirs.includes(c)))
      out.push(finding(main.file, "copied", `${where}: the story cuts ${k}, which ${kind}'s block does not have`));
    const want = theirs.filter((k) => !cut.includes(k));
    const i = want.findIndex((k, n) => k !== ours[n]);
    if (i !== -1 || ours.length !== want.length) {
      const at = i === -1 ? want.length : i;
      out.push(
        finding(
          main.file,
          "copied",
          `${where} has ${ours[at] ?? "no key"} as key #${at + 1}, where ${methods[kind].file} has ${want[at] ?? "none"} (${ours.length} keys here, ${want.length} there)`,
        ),
      );
    }
  }
  return out;
}

// AC "No carousel": the carousel left the main page, and with it its region
// (data-carousel), its class names (carousel…, .slide, .slides) and its keys
// (the story's "Keys that leave"). None is in a template, a dictionary, the
// script or the stylesheet, so no half of it lingers in one of them.
export const CAROUSEL =
  /\b(?:data-)?carousel(?:-[a-z]+)?\b|\.slides?\b|\b(?:hero\.(?:h|t|dot|slide)\.\d+|hero\.(?:carousel|pause)|hero\.cta\.(?:start|gh)|pains\.h2)\b/gi;
export const checkNoCarousel = (file, text) =>
  unique(
    [...text.matchAll(CAROUSEL)].map((m) =>
      finding(file, "carousel", `"${m[0]}": the carousel and its keys left the site`),
    ),
  );

// AC "The title and description": each main page carries the story's title
// and description, word for word. They are the page's first words in a search
// result and a link preview, so they are held here as the story writes them;
// the six languages the main page reached on 2026-10-26 ("The front page in all
// eight languages …") as their translations of the English were reviewed.
export const MAIN_HEAD = {
  en: {
    title: "ProjectStore — a plan, two checks and a record for your coding agent",
    description:
      "A plugin for Claude Code and Codex. Your agent plans first, a second agent checks the plan, and a third checks the result against your checklist. Decisions and plans stay as Markdown in your git, so any agent can carry on.",
  },
  ru: {
    title: "ProjectStore — план, две проверки и записи для вашего агента",
    description:
      "Плагин для Claude Code и Codex. Агент сначала пишет план, второй агент проверяет план, третий сверяет результат с вашим чек-листом. Решения и планы лежат Markdown-файлами в вашем git, и работу продолжит любой агент.",
  },
  de: {
    title: "ProjectStore — ein Plan, zwei Prüfungen und ein Protokoll für deinen Coding-Agenten",
    description:
      "Ein Plugin für Claude Code und Codex. Dein Agent plant zuerst, ein zweiter Agent prüft den Plan, und ein dritter prüft das Ergebnis gegen deine Checkliste. Entscheidungen und Pläne bleiben als Markdown in deinem Git, damit jeder Agent weitermachen kann.",
  },
  es: {
    title: "ProjectStore — un plan, dos revisiones y un registro para tu agente de programación",
    description:
      "Un plugin para Claude Code y Codex. Tu agente planifica primero, un segundo agente revisa el plan y un tercero comprueba el resultado contra tu lista. Decisiones y planes quedan como Markdown en tu git, así cualquier agente puede continuar.",
  },
  fr: {
    title: "ProjectStore — un plan, deux vérifications et une trace pour votre agent de code",
    description:
      "Un plugin pour Claude Code et Codex. Votre agent planifie d'abord, un deuxième agent vérifie le plan, et un troisième vérifie le résultat à partir de votre liste de contrôle. Décisions et plans restent en Markdown dans votre git, donc n'importe quel agent peut reprendre.",
  },
  pt: {
    title: "ProjectStore — um plano, duas checagens e um registro para o seu agente de programação",
    description:
      "Um plugin para Claude Code e Codex. O seu agente planeja primeiro, um segundo agente confere o plano e um terceiro confere o resultado com a sua lista de verificação. Decisões e planos ficam como Markdown no seu git, e qualquer agente pode continuar.",
  },
  uk: {
    title: "ProjectStore — план, дві перевірки та запис для вашого агента",
    description:
      "Плагін для Claude Code і Codex. Ваш агент спершу планує, другий агент перевіряє план, а третій звіряє результат із вашим чек-листом. Рішення й плани лишаються як Markdown у вашому git, тож будь-який агент може продовжити.",
  },
  zh: {
    title: "ProjectStore — 给编程智能体的计划、两道检查和一份记录",
    description:
      "面向 Claude Code 和 Codex 的插件。你的智能体先做计划，第二个智能体检查计划，第三个对照你的清单检查结果。决策和计划以 Markdown 保存在你的 git 中，任何智能体都能接着做。",
  },
};
export function checkMainHead(page) {
  const want = MAIN_HEAD[page.lang];
  if (!want) return [finding(page.file, "head", `the test holds no title for a ${page.lang} main page`)];
  const title = page.els.find((el) => el.name === "title")?.text.trim() ?? null;
  const meta = page.els.find((el) => el.name === "meta" && el.attrs.name === "description");
  const description = meta ? (meta.attrs.content ?? "") : null;
  const out = [];
  if (title !== want.title) out.push(finding(page.file, "head", `the title is ${JSON.stringify(title)}`));
  if (description !== want.description)
    out.push(finding(page.file, "head", `the description is ${JSON.stringify(description)}`));
  return out;
}

// AC "Install" and "Step 3": the install box, in quick start's step 3, is two
// tabs over two panels — "Write to your agent" holding README's prompt and its
// copy button and nothing else (the note under it went with the canvas of
// 2026-10-24); "In a terminal in the project" holding README's install line.
// checkPrompt, checkInstall and checkCopies hold what each says and copies;
// this holds where each sits.
// AC "Step 3": the step's own words are on their keys — the heading, the one
// line before the box, and the two tab labels, ask then term.
export const STEP_3 = { heading: "quick.s.1.h", line: "quick.s.1.p", tabs: ["start.tab.ask", "start.tab.term"] };
export function checkStep3(page) {
  const step = quickSteps(page)?.steps[INSTALL_STEP - 1];
  if (!step) return [finding(page.file, "step-3", "no quick-start step 3")];
  const inside = page.els.filter((el) => within(step, el));
  const box = inside.find((el) => "data-tabs" in el.attrs);
  const broken = [];
  if (
    inside
      .filter((el) => el.name === "h3")
      .map(keyOf)
      .join() !== STEP_3.heading
  )
    broken.push(`the step's heading is not one h3 on ${STEP_3.heading}`);
  const lines = inside.filter(
    (el) => el.name === "p" && (!box || el.start < box.start) && !within(box ?? { start: -1, end: -1, inner: "" }, el),
  );
  if (lines.map(keyOf).join() !== STEP_3.line)
    broken.push(
      `the step's text before the box is ${lines.map((el) => keyOf(el) ?? "unkeyed").join(", ") || "nothing"}; one line on ${STEP_3.line}`,
    );
  const tabs = inside.filter((el) => el.attrs.role === "tab").map(keyOf);
  if (tabs.join() !== STEP_3.tabs.join())
    broken.push(`the tabs are on ${tabs.join(", ") || "nothing"}; ${STEP_3.tabs.join(", ")}`);
  return broken.length ? [finding(page.file, "step-3", broken.join("; "))] : [];
}

// AC "Four tones", the glow: the classic tones (midnight, graphite, paper)
// light --glow-1 to 3, light points them at a transparent token, and one rule
// for the three classic tones, inside @media screen, paints them behind the
// page. A block that names a tone without being a tone rule sets no token.
export const CLASSIC_TONES = ["midnight", "graphite", "paper"];
export const GLOW_RULE = ':root:is([data-tone="midnight"], [data-tone="graphite"], [data-tone="paper"]) body::before';
export function checkGlow(file, css) {
  const out = [];
  for (const [tone, tokens] of toneSets(css)) {
    const dark = CLASSIC_TONES.includes(tone);
    for (const n of ["--glow-1", "--glow-2", "--glow-3"]) {
      const c = rgba(resolveToken(tokens, n));
      if (!c || (dark ? c.a === 0 : c.a !== 0))
        out.push(
          finding(
            file,
            "glow",
            `${tone} ${n} is ${resolveToken(tokens, n)}; ${dark ? "lit in a classic tone" : "transparent in light"}`,
          ),
        );
    }
  }
  const walk = (blocks, media = null) =>
    blocks.flatMap((b) => (b.head.startsWith("@") ? walk(b.blocks, b.head) : [{ ...b, media }]));
  const rules = walk(cssBlocks(css));
  const glows = rules.filter(
    (r) => r.head === GLOW_RULE && /^@media\s+screen\b/i.test(r.media ?? "") && /radial-gradient\(/.test(r.body),
  );
  if (glows.length !== 1)
    out.push(finding(file, "glow", `${glows.length} glow rules for the classic tones inside @media screen; one`));
  for (const r of rules.filter((r) => /data-tone=/.test(r.head) && !/^:root\[data-tone="[a-z]+"\]$/.test(r.head)))
    if (/--[\w-]+\s*:/.test(r.body))
      out.push(finding(file, "glow", `${r.head} sets a token; only a :root[data-tone="…"] rule does`));
  return out;
}

export function checkInstallBox(page) {
  const step = quickSteps(page)?.steps[INSTALL_STEP - 1];
  const boxes = step ? page.els.filter((el) => within(step, el) && "data-tabs" in el.attrs) : [];
  if (boxes.length !== 1)
    return [
      finding(page.file, "install-box", `${boxes.length} tabbed boxes in quick start's step ${INSTALL_STEP}; one`),
    ];
  const inside = page.els.filter((el) => within(boxes[0], el));
  const tabs = inside.filter((el) => el.attrs.role === "tab").map((el) => el.attrs["data-tab"]);
  const panel = (name) => inside.find((el) => el.attrs.role === "tabpanel" && el.attrs["data-panel"] === name);
  const holds = (box, pred) => Boolean(box) && inside.some((el) => within(box, el) && pred(el));
  const [ask, term] = [panel("ask"), panel("term")];
  const broken = [];
  if (tabs.join() !== "ask,term") broken.push(`the tabs are ${tabs.join(", ") || "none"}; ask, then term`);
  if (!holds(ask, (el) => el.attrs["data-fact"] === "prompt")) broken.push("the ask panel holds no prompt");
  const notes = ask ? inside.filter((el) => within(ask, el) && (keyOf(el) || hasClass(el, "note"))) : [];
  if (notes.length)
    broken.push(
      `the ask panel carries ${notes.map((el) => keyOf(el) ?? "a note").join(", ")}; the prompt stands alone`,
    );
  if (!holds(term, (el) => el.attrs["data-fact"] === "install"))
    broken.push("the terminal panel holds no install line");
  return broken.length ? [finding(page.file, "install-box", broken.join("; "))] : [];
}

// AC "The loop media": the loop section's figure is the marketing loop in a
// player, one English picture for both main pages (the maintainer's decisions
// of 2026-10-22): the still as an <img> with an alt (the poster, and the whole
// picture without script); the loop's own page as the src of an aria-hidden,
// unfocusable frame that site.js clones from a <template>; a play and pause
// button, a seek range and a full-screen button, each with a name; a caption;
// and no link, so nothing opens in a new window. The load check sees each file
// through <img> and <iframe>; this sees which file is where. The figure sits in
// section#loop, after the loop diagram (AC "The player" of the front page
// story that put the diagram on the main page).
export const LOOP_PAGE = "loop.html";
export const LOOP_STILL = "loop-still.webp";
export const LOOP_FILES = [LOOP_PAGE, LOOP_STILL];
export const LOOP_CONTROLS = [
  ["button", "player-play"],
  ["input", "player-seek"],
  ["button", "player-full"],
];
export function checkLoopFigure(page) {
  const figs = page.els.filter((el) => "data-player" in el.attrs);
  if (figs.length !== 1) return [finding(page.file, "loop-figure", `${figs.length} loop figures; one`)];
  const [fig] = figs;
  const inside = page.els.filter((el) => within(fig, el));
  const base = (v) => posix.basename(v ?? "");
  const classes = (el) => (el.attrs.class ?? "").split(/\s+/);
  const img = inside.find((el) => el.name === "img");
  const tpl = inside.find((el) => el.name === "template");
  const frame = inside.find((el) => el.name === "iframe");
  const broken = [];
  if (base(img?.attrs.src) !== LOOP_STILL) broken.push(`the image is ${img?.attrs.src ?? "missing"}; ${LOOP_STILL}`);
  if (!(img?.attrs.alt ?? "").trim()) broken.push("the picture has no alt");
  if (!frame || !tpl || !within(tpl, frame) || base(frame.attrs.src) !== LOOP_PAGE)
    broken.push(`the player's frame is ${frame?.attrs.src ?? "missing"}; ${LOOP_PAGE}, inside a <template>`);
  else if (frame.attrs["aria-hidden"] !== "true" || frame.attrs.tabindex !== "-1")
    broken.push("the player's frame is not aria-hidden and out of the tab order");
  for (const [name, cls] of LOOP_CONTROLS)
    if (!inside.some((el) => el.name === name && classes(el).includes(cls) && (el.attrs["aria-label"] ?? "").trim()))
      broken.push(`no <${name} class="${cls}"> with a name`);
  for (const a of inside.filter((el) => el.name === "a"))
    broken.push(`the figure links to ${a.attrs.href ?? "nothing"}; it links to no file`);
  if (!inside.find((el) => el.name === "figcaption")?.text.trim()) broken.push("the figure has no caption");
  const loop = page.els.find((el) => el.name === "section" && el.attrs.id === "loop");
  const diagram = loop && page.els.find((el) => el.name === "figure" && hasClass(el, "loop") && within(loop, el));
  if (!loop || !within(loop, fig) || !diagram || diagram.start > fig.start)
    broken.push("the player is not in section#loop after the loop diagram (figure.loop)");
  return broken.length ? [finding(page.file, "loop-figure", broken.join("; "))] : [];
}
// The two files themselves: the still a complete WebP (its RIFF size is the
// file's), the page defining the four globals the player reads, together
// within the story's cap. That the page loads nothing from another origin is
// the load check's, which reads every page Pages serves, this one among them.
export const LOOP_BYTES = 300000;
export const LOOP_GLOBALS = ["frame", "duration", "still", "ready"];
export function checkLoopFiles(files) {
  const out = [];
  let total = 0;
  for (const [name, buf] of files) {
    if (!buf) {
      out.push(finding(`${SITE}/assets/${name}`, "loop-files", "the file is not under site/assets/"));
      continue;
    }
    total += buf.length;
    if (name.endsWith(".html")) {
      const text = buf.toString("utf8");
      for (const g of LOOP_GLOBALS)
        if (!new RegExp(`window\\.${g}\\s*=`).test(text))
          out.push(finding(`${SITE}/assets/${name}`, "loop-files", `the page defines no window.${g}`));
      continue;
    }
    const riff =
      buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
    if (!riff || buf.readUInt32LE(4) + 8 !== buf.length)
      out.push(finding(`${SITE}/assets/${name}`, "loop-files", "the file is not a complete WebP"));
  }
  if (total > LOOP_BYTES)
    out.push(finding(`${SITE}/assets/`, "loop-files", `the loop's files are ${total} B; the cap is ${LOOP_BYTES} B`));
  return out;
}

// The dot and graph story. The stylesheet's rules, flattened: every block
// under any at-rule, with the at-rule it sits in.
export const cssRules = (css) => {
  const walk = (blocks, media = null) =>
    blocks.flatMap((b) => (b.head.startsWith("@") ? walk(b.blocks, b.head) : [{ ...b, media }]));
  return walk(cssBlocks(css));
};

// AC "The dot": the wordmark's dot is a round dot in --brand whose animation
// has its @keyframes, and reduced motion stops every animation with
// !important (the dot's own rule outranks the universal selector).
export function checkWordmarkDot(file, css) {
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
export const graphOf = (js) => {
  const m = /\bvar GRAPH = (\{[^\n]*\});/.exec(js);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};
// Each node is an artifact of the vault, labelled as the vault names it: its
// kind or number, then its slug, short enough to sit in the background.
export const GRAPH_KINDS = ["adr", "spec", "epic", "story", "research"];
export const GRAPH_LABEL = 26;
export const GRAPH_LABEL_HEAD = {
  adr: /^(ADR-\d+|adr) \S/,
  spec: /^(SPEC-\d+|spec) \S/,
  epic: /^epic PS-[A-Z]+$/,
  story: /^story(-\d+)? \S/,
  research: /^research \S/,
};
export function checkGraphData(file, js) {
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

// AC "Out of the way": the layer is fixed, under the content,
// takes no pointer; its lines stroke its colour, --graph, which every tone
// sets; its nodes fill --node; print and forced colours hide it; reduced
// motion draws it whole and still; a narrow screen shows no labels.
export function checkGraphCss(file, css) {
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
export const GRAPH_BOUNDS = { node: 1.2, beacon: 3.5, beaconAlpha: 0.55, ring: 4, ping: 34 };
export function checkGraphBounds(file, css) {
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
export function graphPaint(css) {
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
export function runSite(js, { scrollHeight = 4800, innerWidth = 1280, innerHeight = 800, reduce = false } = {}) {
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
export function checkGraphScript(file, js) {
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
export function checkScriptColours(file, js) {
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
// are the other languages its kind is built in. Its table L names every other
// dictionary, 1 where the kind is built and 0 where not, so a browser language
// the site has elsewhere stops the walk (the front page story: "uk, ru" stays
// on the English main page). A page in another language redirects nowhere.
export function checkRedirect(page, langs) {
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
  const table = [...(/var L=\{([^}]*)\}/.exec(scripts[0])?.[1] ?? "").matchAll(/"([a-z]+)":([01])/g)];
  const listed = table.map((m) => m[1]);
  const follows = table.filter((m) => m[2] === "1").map((m) => m[1]);
  const others = kindLangs(kindOf(page.kind), langs).filter((l) => l !== DEFAULT_LANG);
  const every = langs.filter((l) => l !== DEFAULT_LANG);
  if ([...listed].sort().join() !== [...every].sort().join())
    return [finding(page.file, "redirect", `lists ${listed.join(", ")}; the dictionaries are ${every.join(", ")}`)];
  if ([...follows].sort().join() !== [...others].sort().join())
    return [
      finding(
        page.file,
        "redirect",
        `follows ${follows.join(", ")}; a ${page.kind} page is built in ${others.join(", ")}`,
      ),
    ];
  for (const lang of others) {
    const path = [...target[1].matchAll(/'([^']*)'|t/g)].map((m) => m[1] ?? lang).join("");
    const lands = new URL(path, pageUrl(DEFAULT_LANG, page.slug)).href;
    if (lands !== pageUrl(lang, page.slug))
      return [finding(page.file, "redirect", `a stored "${lang}" lands on ${lands}; want ${pageUrl(lang, page.slug)}`)];
  }
  return [];
}

// Where an English page's redirect sends a visitor, run as a browser would:
// with their stored choice, if any, and their browser's languages. Null when
// they stay.
export function runRedirect(page, { cookie = null, languages = [] } = {}) {
  const [script] = rawBodies(page.html, "script").filter((js) => /location\.replace\(/.test(js));
  let went = null;
  const location = { protocol: "https:", search: "", hash: "", replace: (to) => (went = to) };
  runInNewContext(script ?? "", {
    document: { cookie: cookie ? `ps_lang=${cookie}` : "" },
    navigator: { languages, language: languages[0] ?? "" },
    location,
  });
  return went;
}

export const checkStub = (file, text) =>
  text === STUB ? [] : [finding(file, "stub", `is not the redirect tools/i18n.py writes: ${JSON.stringify(text)}`)];

// A link off the site opens in a new tab and keeps the page (the maintainer,
// 2026-10-27): every <a> whose href is http(s) on another host carries
// target="_blank" and a rel with noopener; a link on the site carries neither.
export function checkExternalLinks(page) {
  const out = [];
  for (const a of page.els.filter((el) => el.name === "a" && el.attrs.href)) {
    const href = a.attrs.href;
    const external = /^https?:\/\//.test(href) && !href.startsWith(ORIGIN);
    const rel = (a.attrs.rel ?? "").split(/\s+/);
    if (external && (a.attrs.target !== "_blank" || !rel.includes("noopener")))
      out.push(finding(page.file, "external-link", `${href} opens in the same tab; target="_blank" rel="noopener"`));
    if (!external && a.attrs.target === "_blank")
      out.push(finding(page.file, "external-link", `${href} is on the site and opens a new tab`));
  }
  return out;
}

// The llms files carry the facts in a fixed shape: a "Facts about version
// <version>" heading, and under it "- <n> commands", "- <n> bundled agents",
// "- <n> read-only MCP tools: `a`, `b`, …", "- Harnesses: <name> (<status>), …"
// and "Templates ship in <n> languages: <codes>".
export function checkLlmsFacts(file, text, repo) {
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

// llms.txt links the main page in every language it is built in and the
// English method pages (agents read English), and no stub; a link under
// https://projectstore.dev/ in either file resolves to a file under site/ (a
// directory to its index.html), and no link is site-relative.
export function checkLlmsLinks(file, text, langs, fsys = SITE_FS) {
  const out = [];
  const urls = markdownUrls(text);
  if (file.endsWith("/llms.txt")) {
    const want = [
      ...kindLangs(kindOf("main"), langs).map((l) => pageUrl(l)),
      ...KINDS.filter((k) => k.slug).map((k) => pageUrl(DEFAULT_LANG, k.slug)),
    ];
    for (const u of want) if (!urls.includes(u)) out.push(finding(file, "pages", `does not link ${u}`));
  }
  for (const u of urls)
    if (STUB_LANGS.some((l) => u === pageUrl(DEFAULT_LANG, l)))
      out.push(finding(file, "stub-link", `${u} redirects to ${ORIGIN}`));
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

export const REPO = repository();
export const PAGES = sitePages().map((p) => ({
  ...p,
  page: p.html === null ? null : parse(p.file, p.html, p.lang, p.kind),
}));
export const LANGS = [...new Set(PAGES.map((p) => p.lang))];
export const pageOf = (lang, kind = "main") => PAGES.find((p) => p.lang === lang && p.kind === kind);
// The English page of each kind, the one its translations are held to.
export const EN = Object.fromEntries(KINDS.map(({ kind }) => [kind, pageOf(DEFAULT_LANG, kind)]));
export const HASHES = Object.fromEntries(
  ["assets/style.css", "assets/site.js"].map((a) => [a, sha8(readFileSync(join(ROOT, SITE, a)))]),
);
// Every index.html Pages would serve, the en/ stub among them.
export const PAGE_FILES = siteFiles()
  .map((f) => f.path)
  .filter((p) => p.endsWith("/index.html") && !p.startsWith(`${SITE}/src/`));
// The templates and the partials they include, as the build reads them.
export const TEMPLATES = readdirSync(join(ROOT, SITE, "src"))
  .filter((n) => n.endsWith(".html"))
  .sort()
  .map((n) => `${SITE}/src/${n}`);
export const PREVIEW_FILE = posix.join(SITE, PREVIEW_IMAGE.slice(ORIGIN.length));
export const show = (findings) => findings.map((f) => `${f.page} [${f.fact}] ${f.message}`).join("\n");
export const eachPage = (check) => PAGES.filter((p) => p.page).flatMap((p) => check(p.page));
export const englishPages = () => PAGES.filter((p) => p.page && p.lang === DEFAULT_LANG);

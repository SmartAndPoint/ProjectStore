// projectstore — the public site's tests (PS-HARNESS: "The public site ships
// from site/ to projectstore.dev, and a test fails when it drifts from the
// repo"). The checks, their helpers and the rules per page kind are in
// tests/fixtures/site-checks.mjs, which says what they hold and why; here
// each check runs on the real files and returns no finding, and on planted
// copies, made in memory, where it returns exactly one.
//
//   node --test tests/site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { npxCommand } from "./fixtures/markdown.mjs";
import { loadHarnesses, sourceHarness } from "../scripts/harness.mjs";
import { NOT_SHIPPED } from "../scripts/version-guard.mjs";
import {
  ROOT,
  SITE,
  ORIGIN,
  BUDGET,
  REPO_URL,
  LLMS,
  PREVIEW_SIZE,
  STUB_LANGS,
  STUB_FILES,
  STUB_FILE,
  STUB,
  LANG_TAGS,
  DEFAULT_LANG,
  KINDS,
  kindLangs,
  checkExternalLinks,
  checkStep3,
  checkGlow,
  kindOf,
  pageUrl,
  read,
  escape,
  parse,
  readable,
  within,
  slug,
  anchors,
  PROMPT_HEADING,
  markdownCode,
  INSTALL_HEADINGS,
  siteFiles,
  finding,
  checkHarnessesNamed,
  checkWording,
  checkInvocations,
  checkNpx,
  MENU_WORDS,
  installForm,
  readmeInstallLines,
  checkInstall,
  checkCopies,
  checkInstallLines,
  checkLangFlags,
  checkVersion,
  checkVersionText,
  checkLinks,
  checkTextLinks,
  checkCounts,
  checkAgents,
  checkSourceLink,
  checkSourceLinkCss,
  checkNoStatus,
  checkParity,
  checkPressOrder,
  checkPageLinks,
  checkNoStubLinks,
  checkOneH1,
  checkUniqueIds,
  checkFragments,
  idsByPath,
  pageDirsByLang,
  KIND_RULES,
  rulesOf,
  checkRequired,
  checkSections,
  SITE_FS,
  checkLoads,
  checkBudget,
  checkSources,
  checkShapes,
  checkNumbered,
  checkSlugs,
  checkAssetVersions,
  checkPageSet,
  checkAlternates,
  checkPrompt,
  visibleWords,
  checkWords,
  checkNoCommands,
  checkPreview,
  pngSize,
  checkPreviewImage,
  checkColourCss,
  checkColourAttrs,
  DEFAULT_TONE,
  SHIP_TONE,
  LIGHT_TONE,
  toneSets,
  resolveToken,
  rgba,
  checkTones,
  contrast,
  checkToneContrast,
  checkTonePage,
  checkToneKey,
  checkToneScript,
  checkHeaderRows,
  checkWhat,
  checkQuickStart,
  checkChapters,
  COPIED,
  checkCopied,
  checkNoCarousel,
  checkMainHead,
  checkInstallBox,
  LOOP_FILES,
  checkLoopFigure,
  LOOP_BYTES,
  checkLoopFiles,
  cssRules,
  checkWordmarkDot,
  checkGraphData,
  checkGraphCss,
  checkGraphBounds,
  checkGraphScript,
  checkScriptColours,
  checkRedirect,
  runRedirect,
  checkStub,
  checkLlmsFacts,
  checkLlmsLinks,
  REPO,
  PAGES,
  LANGS,
  pageOf,
  EN,
  HASHES,
  PAGE_FILES,
  TEMPLATES,
  PREVIEW_FILE,
  show,
  eachPage,
  englishPages,
} from "./fixtures/site-checks.mjs";

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
  assert.deepEqual(
    STUB_LANGS,
    [DEFAULT_LANG, ...LANGS.filter((l) => !kindLangs(kindOf("main"), LANGS).includes(l))],
    "a stub at en/ and at each language's main-page address where the main page is not built",
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

test("site AC 2: the committed pages are the build's — a page per dictionary and kind and no orphan, asset hashes, alternates and canonicals, the stubs", () => {
  const found = [
    ...checkPageSet(LANGS, PAGE_FILES, SITE_FS.isFile),
    ...eachPage((p) => [...checkAssetVersions(p, HASHES), ...checkAlternates(p, LANGS)]),
    ...STUB_FILES.flatMap((f) => checkStub(f, read(f))),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: every English page follows a stored language choice to the same page in that language; no other page redirects", () => {
  const found = eachPage((p) => checkRedirect(p, LANGS));
  assert.deepEqual(found, [], show(found));
});

test("site: the English main page follows a reader to the language they name first among the eight, as a method page does; a stored choice wins", () => {
  const main = EN.main.page;
  const goes = (opts) => runRedirect(main, opts);
  for (const cookie of ["ru", "de", "uk", "zh"])
    assert.equal(goes({ cookie }), `${cookie}/`, `a stored ${cookie} is followed`);
  assert.equal(goes({ cookie: "en", languages: ["ru"] }), null, "a stored en stays, whatever the browser says");
  for (const [languages, to] of [
    [["ru"], "ru/"],
    [["ru-RU", "en"], "ru/"],
    [["uk", "ru"], "uk/"],
    [["de", "ru"], "de/"],
    [["pt-BR"], "pt/"],
    [["zh-CN"], "zh/"],
  ])
    assert.equal(goes({ languages }), to, `a browser saying ${languages.join(", ")} goes to ${to}`);
  for (const languages of [["en"], ["en", "ru"], ["ja"], []])
    assert.equal(goes({ languages }), null, `a browser saying ${languages.join(", ") || "nothing"} stays`);
  const how = EN["how-it-works"].page;
  assert.equal(runRedirect(how, { cookie: "de" }), "../de/how-it-works/", "a method page follows a stored de");
  assert.equal(runRedirect(how, { languages: ["uk", "ru"] }), "../uk/how-it-works/", "and a browser's first language");
});

test("site: every link off the site opens in a new tab with noopener, and no link on it does", () => {
  const found = eachPage(checkExternalLinks);
  assert.deepEqual(found, [], show(found));
  assert.ok(
    EN.main.page.els.some(
      (el) => el.name === "a" && el.attrs.href === "https://nodejs.org" && el.attrs.target === "_blank",
    ),
    "the quick start's nodejs.org link is one of them",
  );
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

test("site: every main page carries the agents line in #what and the trust ticks, its names plain and in order, and name no dropped agent", () => {
  const mains = PAGES.filter((p) => p.page && p.kind === "main");
  assert.deepEqual(
    mains.map((p) => p.lang),
    kindLangs(kindOf("main"), LANGS),
    "a main page per language it is built in",
  );
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

test("site: the main page's prose, what through talk, names no ProjectStore command outside the install blocks and the example files", () => {
  const found = eachPage((p) => (rulesOf(p).prose === "no commands" ? checkNoCommands(p, REPO) : []));
  assert.ok(
    PAGES.some((p) => p.page && rulesOf(p.page).prose === "no commands"),
    "the rule holds on some page",
  );
  assert.deepEqual(found, [], show(found));
  // The scope is doing the work: the method blocks below talk carry their pages' commands.
  assert.ok(
    checkNoCommands(EN.main.page, REPO, { prose: "no commands" }).length > 0,
    "read whole, the main page names the method blocks' commands",
  );
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

test("site AC 4: the main page's sections run what, start, quick, talk, how … chain, free in both its languages; no page numbers a section label", () => {
  const ids = EN.main.page.els.filter((el) => el.name === "section").map((el) => el.attrs.id);
  // The story's AC "The order", as it lists them; KIND_RULES holds the same list for checkSections.
  assert.deepEqual(
    ids,
    "what start quick talk how loop agents mechanisms evidence fine-print team modes git why timeline cost chain free".split(
      " ",
    ),
  );
  assert.deepEqual(KIND_RULES.main.sections, ids);
  const found = eachPage((p) => checkSections(p));
  assert.deepEqual(found, [], show(found));
});

test("site AC 4: on every page with the loop diagram its blocks are in arrow order, the order the cartoon presses them in", () => {
  const found = eachPage((p) => (rulesOf(p).loop ? checkPressOrder(p) : []));
  assert.deepEqual(found, [], show(found));
});

test("site: every link between pages stays in the page's language or reaches a page not built in it at its English address, no link reaches a stub, and every shared file it names exists", () => {
  const dirs = pageDirsByLang(LANGS);
  const found = eachPage((p) => [...checkPageLinks(p, dirs), ...checkNoStubLinks(p)]);
  assert.deepEqual(found, [], show(found));
});

test("site: every page has one h1 and no repeated id, and every link to the site's own page with a #fragment lands on an id of that page", () => {
  const ids = idsByPath(PAGES);
  assert.ok(ids["/"]?.has("start") && ids["/ru/"]?.has("start"), "both main pages hold #start");
  assert.ok(
    PAGES.some(
      (p) =>
        p.page &&
        p.kind !== "main" &&
        p.page.els.some((el) => el.name === "a" && /\/#start$/.test(el.attrs.href ?? "")),
    ),
    "the method pages' Install → links reach the main page's #start, so the fragment check reads links across pages",
  );
  const found = eachPage((p) => [...checkOneH1(p), ...checkUniqueIds(p), ...checkFragments(p, ids)]);
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

// The four tones the switch offers and the stylesheet declares, in its order.
const FOUR_TONES = [DEFAULT_TONE, "graphite", "light", "paper"];

// The look story of 2026-10-22 (PS-HARNESS, "The site takes smartandpoint.com's
// look …"), as the four-tones story of 2026-10-26 ("The front page in all eight
// languages …") revised it. AC "Four tones": the accent and the brand colour
// resolve to the tone's family, an HSL hue in its range: light's indigo,
// paper's copper, and the dark tones' amber accent with its orange brand.
const hueOf = (hex) => {
  const c = rgba(hex);
  if (!c) return null;
  const [r, g, b] = [c.r / 255, c.g / 255, c.b / 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const INDIGO = ["an indigo", 230, 250];
const COPPER = ["a copper", 10, 30];
const ACCENTS = {
  midnight: { "--accent": ["an amber", 30, 45], "--brand": COPPER },
  graphite: { "--accent": ["an amber", 30, 45], "--brand": COPPER },
  paper: { "--accent": COPPER, "--brand": COPPER },
  light: { "--accent": INDIGO, "--brand": INDIGO },
};
function checkAccent(file, css) {
  return toneSets(css).flatMap(([tone, tokens]) =>
    ["--accent", "--brand"].flatMap((name) => {
      const value = resolveToken(tokens, name);
      const hue = hueOf(value);
      const [family, lo, hi] = ACCENTS[tone]?.[name] ?? ["a declared family", 0, -1];
      return hue !== null && hue >= lo && hue <= hi
        ? []
        : [finding(file, "accent", `${tone}: ${name} is ${value}; ${family}, hue ${lo}°–${hi}°`)];
    }),
  );
}
// AC "Four tones", the gradients: none but the dot grid of .diagram and
// .mode-box, a pattern rather than a colour fade, and the dark tones' glow
// behind the page, one rule for the two of them, painted from --glow-1 to
// --glow-3 (a light tone points them at --no-glow and draws no rule).
const DOT_GRID = "radial-gradient(var(--dot) 1px, transparent 1px)";
const GLOW_HEAD = ':root:is([data-tone="midnight"], [data-tone="graphite"], [data-tone="paper"]) body::before';
function checkNoGradients(file, css) {
  return cssRules(css).flatMap((r) => {
    const found = r.body.match(/[a-z-]*gradient\([^;]*/g) ?? [];
    if (!found.length) return [];
    const grid = [".diagram", ".mode-box"].includes(r.head) && found.every((g) => g.trim() === DOT_GRID);
    const glow =
      r.head === GLOW_HEAD &&
      /^@media\s+screen\b/i.test(r.media ?? "") &&
      [...r.body.matchAll(/radial-gradient\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].every((m) =>
        /, var\(--glow-[1-3]\), transparent \d+%$/.test(m[1]),
      );
    return grid || glow
      ? []
      : [
          finding(
            file,
            "gradient",
            `${r.head} paints ${found[0].trim()}; only the dot grid and the dark tones' glow may`,
          ),
        ];
  });
}
// AC "The graph barely shows": the whole layer at 0.3 or less at rest, and at
// 0.1 or less under :root.scrolling, which site.js sets while the page scrolls;
// and a tone's own rule holds it there or lower, scrolling or not (2026-10-27:
// the classic tones keep it barely there, since at full strength it pulled the eye).
const GRAPH_REST = [".graph, .graph-rings", 0.3];
const GRAPH_MOVING = [":root.scrolling .graph, :root.scrolling .graph-rings", 0.1];
function checkGraphQuiet(file, css) {
  const rules = cssRules(css).filter((r) => !r.media);
  return [GRAPH_REST, GRAPH_MOVING]
    .flatMap(([head, most]) => {
      const rule = rules.find((r) => r.head === head);
      const value = Number(/(?:^|;)\s*opacity:\s*([\d.]+)/.exec(rule?.body ?? "")?.[1] ?? NaN);
      return value <= most ? [] : [finding(file, "graph-quiet", `${head} is at opacity ${value}; at most ${most}`)];
    })
    .concat(
      cssRules(css)
        .filter((r) => /\.graph/.test(r.head) && /(?:^|;)\s*opacity:/.test(r.body) && /data-tone/.test(r.head))
        .flatMap((r) => {
          const most = /\.scrolling/.test(r.head) ? GRAPH_MOVING[1] : GRAPH_REST[1];
          const value = Number(/(?:^|;)\s*opacity:\s*([\d.]+)/.exec(r.body)[1]);
          return value <= most
            ? []
            : [finding(file, "graph-quiet", `${r.head} is at opacity ${value}; at most ${most}`)];
        }),
    );
}

// AC "White by default", site.js's half: with no stored tone, or no storage,
// the switch's script falls back to SHIP_TONE, as the early script does.
function checkToneFallback(file, js) {
  const line = /var savedTone = function \(\) \{\s*([^\n]*)/.exec(js)?.[1] ?? "";
  const falls = [...line.matchAll(/(?:\? s :|\|\|) (preferred\(\)|"[a-z]+")/g)].map((m) => m[1]);
  const pref = /var preferred = function \(\) \{([^\n]*)\};/.exec(js)?.[1] ?? "";
  const picks = /prefers-color-scheme: light\)"\)\.matches \? "([a-z]+)" : "([a-z]+)"/.exec(pref);
  const out = [];
  if (falls.length !== 2 || !falls.every((f) => f === "preferred()"))
    out.push(
      finding(file, "tone", `site.js falls back to ${falls.join(" and ") || "nothing"}; preferred() both times`),
    );
  if (!picks || picks[1] !== LIGHT_TONE || picks[2] !== SHIP_TONE)
    out.push(
      finding(
        file,
        "tone",
        `site.js prefers ${picks ? `${picks[1]} and ${picks[2]}` : "nothing"}; ${LIGHT_TONE} for a light system, else ${SHIP_TONE}`,
      ),
    );
  return out;
}
// The main button's label, --bg on --ink-hi, readable in every tone (it is
// outside the floors above, which hold text on surfaces).
function checkMainButton(file, css) {
  return toneSets(css).flatMap(([tone, tokens]) => {
    const [label, fill] = ["--bg", "--ink-hi"].map((n) => rgba(resolveToken(tokens, n)));
    const ratio = label && fill ? contrast(label, fill) : 0;
    return ratio >= 4.5
      ? []
      : [finding(file, "contrast", `${tone}: the main button is ${ratio.toFixed(2)}:1; at least 4.5`)];
  });
}

test("site: the look of the four tones — each tone's accent and brand in its family, no gradient but the diagrams' dot grid and the dark tones' glow, the graph at 0.3 at rest and 0.1 while the page scrolls on the light tones, the main button readable, and site.js falling back to the system's preference", () => {
  const css = read(STYLE);
  const found = [
    ...checkAccent(STYLE, css),
    ...checkNoGradients(STYLE, css),
    ...checkGraphQuiet(STYLE, css),
    ...checkGlow(STYLE, css),
    ...checkMainButton(STYLE, css),
    ...checkToneFallback(`${SITE}/assets/site.js`, read(`${SITE}/assets/site.js`)),
  ];
  assert.deepEqual(found, [], show(found));
});

test("site: the tones — midnight on :root, graphite, light and paper screen-only rules (graphite over surface tokens and the glow, the light tones over the text too, with color-scheme: light), the covering surfaces opaque, and every text colour readable at its lowest", () => {
  const css = read(`${SITE}/assets/style.css`);
  assert.deepEqual(
    toneSets(css).map(([tone]) => tone),
    [DEFAULT_TONE, "graphite", "light", "paper"],
    "midnight is the palette, graphite, light and paper the tone rules",
  );
  const found = [...checkTones(`${SITE}/assets/style.css`, css), ...checkToneContrast(`${SITE}/assets/style.css`, css)];
  assert.deepEqual(found, [], show(found));
});

test('site: every page ships in midnight — <html data-tone="midnight">, theme-color midnight\'s --bg — with the tone switch in its header and the early script in its head, and site.js keeps the tone under the key that script reads', () => {
  const css = read(`${SITE}/assets/style.css`);
  const sets = toneSets(css);
  const tones = sets.map(([tone]) => tone);
  const bg = resolveToken(Object.fromEntries(sets)[SHIP_TONE], "--bg");
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

test("site: every main page carries the story's title and description, open with what it is — the h1, three paragraphs, two buttons, the why lines and the comparison's four blocks — then quick start's six steps with the install box's two tabs in step 3, and the four chapter heads", () => {
  const mains = PAGES.filter((p) => p.page && p.kind === "main");
  assert.equal(mains.length, kindLangs(kindOf("main"), LANGS).length, "a main page per language it is built in");
  const found = mains.flatMap((p) => [
    ...checkWhat(p.page),
    ...checkQuickStart(p.page),
    ...checkInstallBox(p.page),
    ...checkStep3(p.page),
    ...checkChapters(p.page),
    ...checkMainHead(p.page),
  ]);
  assert.deepEqual(found, [], show(found));
});

test("site: every main page carries the method pages' blocks with those blocks' keys, less the next-page rows, the prompt box and the cost section's first paragraphs", () => {
  const found = kindLangs(kindOf("main"), LANGS).flatMap((lang) => checkCopied(pageOf(lang).page, methodPages(lang)));
  assert.deepEqual(found, [], show(found));
});

test("site: the carousel, its class names and the keys that left with it are in no template, dictionary, script or stylesheet", () => {
  const locales = readdirSync(join(ROOT, SITE, "locales"))
    .filter((n) => n.endsWith(".json"))
    .map((n) => `${SITE}/locales/${n}`);
  const files = [...TEMPLATES, ...locales, SCRIPT, STYLE];
  assert.ok(files.length > TEMPLATES.length + 7, `the files read: ${files.join(", ")}`);
  const found = files.flatMap((f) => checkNoCarousel(f, read(f)));
  assert.deepEqual(found, [], show(found));
});

test("site: every main page shows the marketing loop in a player — the still with an alt as its poster, the loop's page in a template's frame, three named controls, a caption, no link; the still a complete WebP and the page with its four globals, within 300,000 bytes", () => {
  const mains = PAGES.filter((p) => p.page && p.kind === "main");
  const files = LOOP_FILES.map((n) => {
    const f = join(ROOT, SITE, "assets", n);
    return [n, existsSync(f) ? readFileSync(f) : null];
  });
  assert.deepEqual(
    siteFiles()
      .map((f) => posix.basename(f.path))
      .filter((n) => /^loop/.test(n))
      .sort(),
    [...LOOP_FILES].sort(),
    "no other loop file is left in site/assets/",
  );
  const found = [...mains.flatMap((p) => checkLoopFigure(p.page)), ...checkLoopFiles(files)];
  assert.deepEqual(found, [], show(found));
  // Planted: the still cut short, the still gone, the page without its frame
  // function, the page without its ready promise, and the two over the cap.
  const [page, still] = files;
  const total = files.reduce((n, [, buf]) => n + buf.length, 0);
  const pageWith = (buf) => [page[0], buf];
  for (const [planted, message] of [
    [[page, [still[0], still[1].subarray(0, still[1].length - 1)]], /not a complete WebP/],
    [[page, [still[0], null]], /not under site\/assets\//],
    [
      [pageWith(Buffer.from(page[1].toString("utf8").replace("window.frame =", "window.draw ="))), still],
      /defines no window\.frame$/,
    ],
    [
      [pageWith(Buffer.from(page[1].toString("utf8").replace("window.ready =", "window.fontsReady ="))), still],
      /defines no window\.ready$/,
    ],
    [[pageWith(Buffer.concat([page[1], Buffer.alloc(LOOP_BYTES - total + 1, 32)])), still], /the cap is 300000 B/],
  ]) {
    const got = checkLoopFiles(planted);
    assert.equal(got.length, 1, show(got));
    assert.equal(got[0].fact, "loop-files");
    assert.match(got[0].message, message);
  }
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
  // The short form names what README's writes name that a reader asks about
  // first: the author git gives every artifact, the settings file and the
  // marketplace folder in the agent's home, and what a session file records.
  for (const m of [
    "<code>user.name</code>",
    "each new artifact names it as its author",
    "<code>.claude/settings.local.json</code>",
    "<code>projectstore/</code>",
    "<code>~/.claude</code>",
    "<code>~/.codex</code>",
    "read or edited last, with the tool and the time",
    "inactive for 24 hours",
  ])
    assert.ok(privacy[0].html.includes(m), `the privacy page names ${m}`);
  // The same destinations as README's section: the registry alone since the
  // model menu stopped asking Anthropic (the 0.30.7 story, PS-DIRECTORY).
  const readme = readmeSentHosts(read("README.md"));
  assert.deepEqual(readme, ["registry.npmjs.org"], `README's "${README_SENT}" names its hosts`);
  assert.deepEqual(privacySentHosts(privacy[0].html), readme, "the privacy page names README's network destinations");
  // The helpers see a difference: a host dropped from either side is one.
  assert.notDeepEqual(
    privacySentHosts(privacy[0].html.replace("<code>registry.npmjs.org</code>", "the npm registry")),
    readme,
  );
  // Both say no credential is read from the environment.
  assert.ok(privacy[0].html.includes("it reads no credential from your environment"), "the privacy page says so");
  // The built page's "sent" section is its source's, byte for byte.
  const sent = (html) => /<section\b[^>]*\bid="sent"[^>]*>[\s\S]*?<\/section>/.exec(html)?.[0];
  assert.ok(sent(read(`${SITE}/src/privacy.html`)), "the source has its sent section");
  assert.equal(sent(privacy[0].html), sent(read(`${SITE}/src/privacy.html`)), "built from the source as it is");
});

test("site AC 4: site/ stays within its budget", () => {
  const found = checkBudget(siteFiles());
  assert.deepEqual(found, [], show(found));
});

// The prose keys the story "Install, first run, configure, daily work and
// removal read the same in the README, docs, the site in eight languages and
// the in-session texts" (PS-HARNESS) and the four-agents story added and the
// method pages keep: each in every dictionary, and translated, not the English
// copied. Per change, not a blanket rule: brand names and code legitimately
// equal the English in many other keys. (Their main-page keys went with the
// old main page, in the front page story.)
const TRANSLATED = ["how.fine.2", "how.meta.description"];
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

test("site: the instructions and four-agents stories' method-page keys are translated in all seven other dictionaries; a key set back to English is one finding", () => {
  const en = JSON.parse(read(join(SITE, "locales", "en.json")));
  const dicts = dictionaries();
  assert.equal(Object.keys(dicts).length, 7);
  for (const k of TRANSLATED) assert.ok(k in en, `${k} is still a key of the site`);
  assert.deepEqual(checkTranslated(TRANSLATED, en, dicts), []);
  const planted = { ...dicts, ru: { ...dicts.ru, "how.fine.2": en["how.fine.2"] } };
  const found = checkTranslated(TRANSLATED, en, planted);
  assert.equal(found.length, 1);
  assert.match(JSON.stringify(found[0]), /site\/locales\/ru\.json.*translation:how\.fine\.2/);
});

// The main page's own keys: those its template names (data-i18n, or a
// data-i18n-attr pair) that no other template does. The partials every page
// includes are other templates, so the header's and footer's keys are not.
const templateKeys = (file) =>
  new Set(
    [...read(file).matchAll(/data-i18n(?:-attr)?="([^"]+)"/g)].flatMap((m) =>
      m[0].startsWith("data-i18n-attr") ? m[1].split(";").map((pair) => pair.split(":")[1]) : [m[1]],
    ),
  );
function mainKeys() {
  const others = TEMPLATES.filter((f) => !f.endsWith("/index.html")).map(templateKeys);
  return [...templateKeys(`${SITE}/src/index.html`)].filter((k) => !others.some((set) => set.has(k)));
}
// AC "Languages": a dictionary holds the main page's keys exactly when the
// main page is built in its language, and each is translated — a key the
// English page and another share word for word is one the translation missed,
// but for the word a language shares with English (Spanish "no").
const SAME_AS_ENGLISH = { es: ["tree.no"] };
function checkMainKeys(keys, en, dicts) {
  const out = [];
  for (const [lang, dict] of Object.entries(dicts)) {
    const file = `site/locales/${lang}.json`;
    const built = kindLangs(kindOf("main"), LANGS).includes(lang);
    for (const k of keys) {
      if (built && !(k in dict)) out.push(finding(file, `main-key:${k}`, `${k} is missing`));
      else if (built && dict[k] === en[k] && !SAME_AS_ENGLISH[lang]?.includes(k))
        out.push(finding(file, `main-key:${k}`, `${k} is the English text`));
      else if (!built && k in dict)
        out.push(finding(file, `main-key:${k}`, `${k} is a main-page key, and the main page is not built in ${lang}`));
    }
  }
  return out;
}

test("site: the main page's keys are in every dictionary, translated; a key copied back or left out is one finding", () => {
  const en = JSON.parse(read(join(SITE, "locales", "en.json")));
  const dicts = dictionaries();
  const keys = mainKeys();
  assert.ok(
    keys.length > 50 && ["what.h1", "cmp.chat.1", "quick.s.a.h", "fig.alt"].every((k) => keys.includes(k)),
    `the keys: ${keys.join(", ")}`,
  );
  for (const k of keys) assert.ok(k in en, `${k} is in en.json`);
  assert.deepEqual(checkMainKeys(keys, en, dicts), []);
  // The English copied into the Russian and the Chinese dictionaries, a key left out of the German one.
  const without = (dict, key) => Object.fromEntries(Object.entries(dict).filter(([k]) => k !== key));
  for (const [lang, key, dict] of [
    ["ru", "what.p.1", { ...dicts.ru, "what.p.1": en["what.p.1"] }],
    ["zh", "rate.note", { ...dicts.zh, "rate.note": en["rate.note"] }],
    ["de", "tree.q.3", without(dicts.de, "tree.q.3")],
  ]) {
    const found = checkMainKeys(keys, en, { ...dicts, [lang]: dict });
    assert.equal(found.length, 1, show(found));
    assert.equal(`${found[0].page} ${found[0].fact}`, `site/locales/${lang}.json main-key:${key}`);
  }
});

test("site AC 4: the llms files state the facts in their fixed shape, link every main page and the English method pages and no stub, and resolve every link on the site", () => {
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
// The first line of a page's install block, whatever it says: quick start's
// install box on the main page, One vault's setup line.
const INSTALL_LINE = /(<(?:pre id="install-cmd"|code) data-fact="install"[^>]*>)[^<]*</;
// Before </main>: a paragraph a check reads like any other.
const beforeMain = (html) => ["</main>", `${html}</main>`];
// The main page's install box, lifted out of quick start's step 3 and set under step 4's
// heading ("$2$1").
const BOX_TO_STEP_4 =
  /(<div class="install" data-tabs[\s\S]*?<\/div>)(\s*<p class="note" data-i18n="quick\.s\.1\.after">[\s\S]*?<\/li>\s*<li><h3 data-i18n="quick\.s\.2\.h">[^<]*<\/h3>)/;
// The method pages in a language, by kind, as checkCopied reads them.
const methodPages = (lang) =>
  Object.fromEntries([...new Set(COPIED.map((c) => c.kind))].map((kind) => [kind, pageOf(lang, kind).page]));

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

// A German story title with an umlaut, which slugify keeps: the plant below
// gives How it works this title and types its path without the umlaut.
const DE_TITLE = "Gespeicherte Karten zählen im Checkout zuerst";

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
    ...onPage("ru", (p) => checkAssetVersions(p, HASHES)),
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
    ...onPage("zh", (p) => checkAlternates(p, LANGS), "why-it-works"),
    fact: "alternate",
    message: /hreflang="uk"/,
    edits: [
      [
        'hreflang="uk" href="https://projectstore.dev/uk/why-it-works/"',
        'hreflang="uk" href="https://projectstore.dev/ua/why-it-works/"',
      ],
    ],
  },
  {
    ac: "Languages",
    what: "the Russian main page drops its German alternate",
    ...onPage("ru", (p) => checkAlternates(p, LANGS)),
    fact: "alternate",
    message: /hreflang="de"/,
    edits: [[/<link rel="alternate" hreflang="de" href="https:\/\/projectstore\.dev\/de\/">\n?/, ""]],
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
    edits: [['<html lang="pt-BR"', '<html lang="pt"']],
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
    run: (text) => checkStub(STUB_FILE, text),
    fact: "stub",
    edits: [['<link rel="canonical" href="../">', '<link rel="canonical" href="/">']],
  },
  {
    ac: "Languages",
    what: "a main page built at /en/, the old address",
    file: STUB_FILE,
    source: read(STUB_FILE),
    run: (text) => checkStub(STUB_FILE, text),
    fact: "stub",
    edits: [[STUB, EN.main.html]],
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
    ...onPage("de", (p) => checkRedirect(p, LANGS), "why-it-works"),
    fact: "redirect",
    message: /only English pages follow/,
    edits: [["</title>", `</title>\n${EN_REDIRECT}`]],
  },
  {
    ac: "Language follow",
    what: "the English main page no longer following Ukrainian",
    ...onPage("en", (p) => checkRedirect(p, LANGS)),
    fact: "redirect",
    message: /^follows de, es, fr, pt, ru, zh; a main page is built in de, es, fr, pt, ru, uk, zh$/,
    edits: [['"uk":1', '"uk":0']],
  },

  // A link off the site: in the same tab, or a link on the site in a new one.
  {
    ac: "External links",
    what: "the GitHub link in the header opening in the same tab",
    ...onPage("fr", checkExternalLinks, "why-it-works"),
    fact: "external-link",
    message: /^https:\/\/github\.com\/SmartAndPoint\/ProjectStore opens in the same tab/,
    edits: [
      [
        /(<a class="gh" href="https:\/\/github\.com\/SmartAndPoint\/ProjectStore"[^>]*?) target="_blank" rel="noopener noreferrer"/,
        "$1",
      ],
    ],
  },
  {
    ac: "External links",
    what: "a link on the site opening a new tab",
    ...onPage("en", checkExternalLinks),
    fact: "external-link",
    message: /^#start is on the site and opens a new tab$/,
    edits: [
      ['href="#start" data-i18n="what.cta.install"', 'href="#start" target="_blank" data-i18n="what.cta.install"'],
    ],
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
    ...onPage("ru", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harness:codex",
    message: /meta name="description"/,
    edits: [[/<meta name="description" content="[^"]*"/, (m) => m.split("Codex").join("Kodex")]],
  },
  {
    ac: "3",
    what: "the hero, #what, stops naming Codex",
    ...onPage("ru", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harness:codex",
    message: /^the hero \(#what\) does not name Codex/,
    edits: [section('<section class="hero what" id="what"', (s) => s.split("Codex").join("Kodex"))],
  },
  {
    ac: "Install",
    what: "the install chapter, #start with the quick start, stops naming Codex",
    ...onPage("en", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harness:codex",
    message: /^the install chapter \(#start with #quick\) does not name Codex/,
    edits: [
      section('<section class="sec chapter" id="start"', (s) => s.split("Codex").join("Kodex")),
      section('<section class="sec" id="quick"', (s) => s.split("Codex").join("Kodex")),
    ],
  },
  {
    ac: "Install",
    what: 'the install chapter\'s head loses id="start"',
    ...onPage("en", (p) => checkHarnessesNamed(p, REPO)),
    fact: "harnesses",
    message: /^the install chapter \(#start with #quick\) is missing: no section#start$/,
    edits: [['<section class="sec chapter" id="start"', '<section class="sec chapter"']],
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

  // AC "No commands up top": the main page's prose, what through talk, names no command.
  {
    ac: "No commands up top",
    what: "a slash command in the main page's talk section",
    ...onPage("en", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /"\/projectstore:status" outside a block marked/,
    edits: [
      ['<div class="tasks">', '<p>Then run <code>/projectstore:status</code> to see the board.</p><div class="tasks">'],
    ],
  },
  {
    ac: "No commands up top",
    what: "an npx projectstore line in the main page's what section",
    ...onPage("ru", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /"npx projectstore doctor --json" outside a block marked/,
    edits: [
      ['<div class="actions">', '<p>In CI: <code>npx projectstore doctor --json</code></p><div class="actions">'],
    ],
  },
  {
    ac: "No commands up top",
    what: "a $projectstore- skill in a quick-start step",
    ...onPage("en", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /"\$projectstore-critic" outside a block marked/,
    edits: [
      [
        /(<li><h3 data-i18n="quick\.s\.4\.h">[^<]*<\/h3>)/,
        "$1<p>Or ask for <code>$$projectstore-critic</code> yourself.</p>",
      ],
    ],
  },
  {
    ac: "No commands up top",
    what: "the talk section loses its id, and the rule a section to read",
    ...onPage("ru", (p) => checkNoCommands(p, REPO)),
    fact: "command",
    message: /^no section#talk; the rule reads what, start, quick, talk$/,
    edits: [['<section class="sec" id="talk"', '<section class="sec"']],
  },
  {
    ac: "Install first",
    what: "the prompt reworded",
    ...onPage("ru", (p) => checkPrompt(p, REPO)),
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
    what: "$ npx projectstore@latest upgrade --harness codex in the quick start, outside a marked block",
    ...onPage("en", (p) => checkInstall(p, REPO)),
    fact: "install",
    message: /projectstore@latest upgrade --harness codex" is an install.* outside a block marked/,
    edits: [
      [
        /(<ol class="qs">)/,
        "$1<li><p>To upgrade Codex: <code>$ npx projectstore@latest upgrade --harness codex</code> in your project.</p></li>",
      ],
    ],
  },
  {
    ac: "4",
    what: "a bunx upgrade after a code block, outside a marked block",
    ...onPage("ru", (p) => checkInstall(p, REPO)),
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
    ...onPage("pt", (p) => checkInstall(p, REPO), "one-vault"),
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
    ...onPage("es", (p) => checkInstall(p, REPO), "one-vault"),
    fact: "install",
    message: /--lang fr" is no line README fences/,
    edits: [[INSTALL_LINE, "$1/projectstore:bind ~/Documents/my-project-vault --lang fr<"]],
  },
  {
    ac: "4",
    what: "a --lang on a page whose language ships no templates",
    ...onPage("uk", (p) => checkInstall(p, REPO), "one-vault"),
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
    ...onPage("ru", checkCopies),
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
    ...onPage("de", (p) => checkLangFlags(p.file, readable(p), REPO), "one-vault"),
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
    ...onPage("uk", (p) => checkLinks(p, REPO), "how-it-works"),
    fact: "link",
    message: /has no heading #kodeks$/,
    edits: [['blob/main/README.md"', 'blob/main/docs/alongside.md#kodeks"']],
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
    what: "an agent count the repository disagrees with",
    ...onPage("zh", (p) => checkCounts(p, REPO), "how-it-works"),
    fact: "agents",
    edits: [[/(data-fact="agents">)\d+/, `$1${REPO.counts.agents + 1}`]],
  },
  {
    ac: "4",
    what: "a language count the repository disagrees with, on a page that had none",
    ...onPage("uk", (p) => checkCounts(p, REPO), "how-it-works"),
    fact: "languages",
    edits: [beforeMain(`<p><span data-fact="languages">${REPO.counts.languages + 1}</span></p>`)],
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
    ...parity("ru", "how-it-works"),
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
    ac: "The method's blocks",
    what: "the main page's MCP tool count loses its marker",
    ...onPage("ru", (p) => checkRequired(p, REPO)),
    fact: "mcp-tools",
    edits: [[' data-fact="mcp-tools"', "", "all"]],
  },
  {
    ac: "The method's blocks",
    what: "the main page's measured figures lose their sources",
    ...onPage("en", (p) => checkRequired(p, REPO)),
    fact: "data-source",
    edits: [[/ data-source="[^"]*"/g, ""]],
  },
  {
    ac: "The method's blocks",
    what: "the main page's example story loses its data-template",
    ...onPage("ru", (p) => checkRequired(p, REPO)),
    fact: "template:story",
    edits: [[' data-template="story"', ""]],
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
    ...onPage("zh", (p) => checkRequired(p, REPO), "one-vault"),
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

  // AC "The order", and a word budget held.
  {
    ac: "The order",
    what: "the talk section moved above quick start",
    ...onPage("en", checkSections),
    fact: "sections",
    message: /^the sections run what, start, talk, quick, how,/,
    edits: [
      [
        /(<section class="sec" id="quick"[\s\S]*?<\/section>\s*)(<section class="sec" id="talk"[\s\S]*?<\/section>\s*)/,
        "$2$1",
      ],
    ],
  },
  {
    ac: "The order",
    what: "the Russian main page drops the cost section",
    ...onPage("ru", checkSections),
    fact: "sections",
    message: /timeline, chain, free; want /,
    edits: [[/<section class="sec" id="cost"[\s\S]*?<\/section>\s*/, ""]],
  },
  {
    ac: "The order",
    what: "a method page gets a numbered label",
    ...onPage("en", checkSections, "how-it-works"),
    fact: "section-number",
    message: /1 numbered section labels; a how-it-works page has 0/,
    edits: [[/(data-i18n="how\.loop\.label">)/, "$101 / "]],
  },
  {
    ac: "Budgets",
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
    message: /\.tone-switch is not hidden until :root\[data-tones\] shows it/,
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
    ac: "White by default",
    what: "a page whose theme-color is not the light tone's --bg",
    ...onPage("pt", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "one-vault"),
    fact: "theme-color",
    message: /theme-color is #0b0c0a; midnight --bg is #080d19/,
    edits: [[/(<meta name="theme-color" content=")[^"]*/, "$1#0b0c0a"]],
  },
  {
    ac: "White by default",
    what: "a page in midnight",
    ...onPage("pt", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "why-it-works"),
    fact: "tone",
    message: /^<html data-tone="">: a page ships in midnight$/,
    edits: [['<html lang="pt-BR" data-tone="midnight">', '<html lang="pt-BR">']],
  },
  {
    ac: "One accent, readable",
    what: "the light accent put back to copper",
    ...onText(STYLE, checkAccent),
    fact: "accent",
    message: /^light: --accent is #a1491f; an indigo/,
    edits: [["--light-accent: #4f46e5;", "--light-accent: #a1491f;"]],
  },
  {
    ac: "No gradients",
    what: "the glow put back behind the page",
    ...onText(STYLE, checkNoGradients),
    fact: "gradient",
    message: /^body::before paints radial-gradient/,
    edits: [
      [
        /$/,
        "\n@media screen { body::before { background: radial-gradient(70vw 60vh at 8% 0%, var(--accent-soft), transparent 70%); } }\n",
      ],
    ],
  },
  {
    ac: "The graph barely shows",
    what: "the classic tones' graph back at full strength while scrolling",
    ...onText(STYLE, checkGraphQuiet),
    fact: "graph-quiet",
    message: /\.scrolling \.graph is at opacity 1; at most 0\.1$/,
    edits: [[/$/, '\n@media screen { :root:is([data-tone="midnight"]).scrolling .graph { opacity: 1; } }\n']],
  },
  {
    ac: "The graph barely shows",
    what: "the graph back at 0.6",
    ...onText(STYLE, checkGraphQuiet),
    fact: "graph-quiet",
    message: /^\.graph, \.graph-rings is at opacity 0\.6; at most 0\.3$/,
    edits: [[".graph, .graph-rings { opacity: 0.3;", ".graph, .graph-rings { opacity: 0.6;"]],
  },
  {
    ac: "White by default",
    what: "site.js falling back to midnight",
    ...onText(`${SITE}/assets/site.js`, checkToneFallback),
    fact: "tone",
    message: /^site\.js falls back to "midnight" and preferred\(\); preferred\(\) both times$/,
    edits: [["return offered(s) ? s : preferred();", 'return offered(s) ? s : "midnight";']],
  },
  {
    ac: "White by default",
    what: "the switch shown by [data-tone] again",
    ...onText(STYLE, checkTones),
    fact: "tone",
    message: /\.tone-switch is not hidden until :root\[data-tones\] shows it/,
    edits: [[":root[data-tones] .tone-switch {", ":root[data-tone] .tone-switch {"]],
  },
  {
    ac: "The look",
    what: "the main button lettered in its own fill",
    ...onText(STYLE, checkMainButton),
    fact: "contrast",
    message: /^light: the main button is 1\.00:1/,
    edits: [["--light-bg: #ffffff;", "--light-bg: #171717;"]],
  },
  {
    ac: "One two-way switch",
    what: "a switch without its graphite position",
    ...onPage("zh", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "why-it-works"),
    fact: "tone-switch",
    message: /no position for graphite/,
    edits: [[/<button class="tone-opt" type="button" data-tone-set="graphite"[^>]*>.*?<\/button>/, ""]],
  },
  {
    ac: "Remembered, without a flash",
    what: "a page without the early script",
    ...onPage("de", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "one-vault"),
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
    edits: [["--light-accent: #4f46e5;", "--light-accent: #c4643c;"]],
  },
  {
    ac: "Readable in every tone",
    what: "a light --ink-4 too pale for white",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^light: --ink-4 is \d\.\d\d:1 at its lowest; at least 4\.5/,
    edits: [["--light-ink-4: #5c5c5c;", "--light-ink-4: #8f8f8f;"]],
  },
  {
    ac: "Readable in every tone",
    what: "a light done green too pale for small text",
    ...onText(STYLE, checkToneContrast),
    fact: "contrast",
    message: /^light: --done is \d\.\d\d:1 at its lowest; at least 4\.5/,
    edits: [["--light-done: #065f46;", "--light-done: #3a9a6a;"]],
  },
  {
    ac: "Four tones",
    what: "a page without its light position",
    ...onPage("uk", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "how-it-works"),
    fact: "tone-switch",
    message: /no position for light/,
    edits: [[/<button class="tone-opt" type="button" data-tone-set="light"[^>]*>.*?<\/button>/, ""]],
  },
  {
    ac: "Four tones",
    what: "a switch offering a tone the stylesheet does not declare",
    ...onPage("fr", (p) => checkTonePage(p, FOUR_TONES, "#080d19"), "one-vault"),
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
    ac: "Four tones",
    what: "an early script that takes any stored id",
    ...onText(TONE_PARTIAL, (file, partial) => checkToneScript(file, partial, FOUR_TONES)),
    fact: "tone-script",
    message: /^"sepia" stored: data-tone is sepia; midnight is expected/,
    edits: [['if(s==="graphite"||s==="midnight"||s==="paper"||s==="light")t=s;else ', "t=s||t;if(!s)"]],
  },
  {
    ac: "Four tones",
    what: "an early script that forgets graphite",
    ...onText(TONE_PARTIAL, (file, partial) => checkToneScript(file, partial, FOUR_TONES)),
    fact: "tone-script",
    message: /^"graphite" stored: data-tone is midnight; graphite is expected/,
    edits: [['s==="graphite"||', ""]],
  },
  {
    ac: "Four tones",
    what: "an early script that ignores a light system",
    ...onText(TONE_PARTIAL, (file, partial) => checkToneScript(file, partial, FOUR_TONES)),
    fact: "tone-script",
    message: /^nothing stored, a light system: data-tone is midnight; paper is expected/,
    edits: [
      ['else if(typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: light)").matches)t="paper";', ""],
    ],
  },
  {
    ac: "Four tones",
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
    ac: "Four tones",
    what: "the second row moved back to narrow screens only",
    ...onText(STYLE, checkHeaderRows),
    fact: "header",
    message:
      /under @media \(max-width: 900px\); @media \(max-width: 1199px\) does both; @media \(max-width: 1199px\) sets no scroll-padding-top/,
    edits: [["@media (max-width: 1199px) {", "@media (max-width: 900px) {"]],
  },
  {
    ac: "Four tones",
    what: "a header link that may wrap",
    ...onText(STYLE, checkHeaderRows),
    fact: "header",
    message: /^a header link may wrap the row$/,
    edits: [["text-decoration: none; white-space: nowrap; }", "text-decoration: none; }"]],
  },
  // AC "What it is": the h1, the paragraphs, the buttons, the why lines, the comparison's four blocks.
  {
    ac: "What it is",
    what: "a sixth row in the comparison",
    ...onPage("en", checkWhat),
    fact: "what",
    message: /^the comparison has 6 body rows; 5$/,
    edits: [[/(<tr class="us">[\s\S]*?<\/tr>)/, "$1$1"]],
  },
  {
    ac: "What it is",
    what: "SDD and PDD swapped in the Russian comparison",
    ...onPage("ru", checkWhat),
    fact: "what",
    message: /^the comparison's rows run chat, mem, pdd, sdd, ps; chat, mem, sdd, pdd, ps$/,
    edits: [
      [
        /(<tr class="from"><td><b>SDD<\/b>[\s\S]*?<\/tr>)(\s*)(<tr class="from"><td><b>PDD<\/b>[\s\S]*?<\/tr>)/,
        "$3$2$1",
      ],
    ],
  },
  {
    ac: "What it is",
    what: "ProjectStore's name put on a key, which Russian could only copy from English",
    ...onPage("ru", checkWhat),
    fact: "what",
    message: /^the ps row is not a tr\.us of 5 cells, named ProjectStore, on cmp\.ps\.2,/,
    edits: [['<tr class="us"><td><b>ProjectStore</b>', '<tr class="us"><td><b data-i18n="cmp.ps.1">ProjectStore</b>']],
  },
  {
    ac: "What it is",
    what: "the How it works button aimed at the loop",
    ...onPage("en", checkWhat),
    fact: "what",
    message: /^what\.cta\.how links #loop; one link to #how$/,
    edits: [['href="#how" data-i18n="what.cta.how"', 'href="#loop" data-i18n="what.cta.how"']],
  },
  {
    ac: "What it is",
    what: "a sixth line under Why it works",
    ...onPage("ru", checkWhat),
    fact: "what",
    message: /^the why lines run .*pains\.now\.5, pains\.now\.5; 5, a dot and pains\.now\.n/,
    edits: [
      [/(<li><span class="dot" aria-hidden="true"><\/span><span data-i18n="pains\.now\.5">[\s\S]*?<\/li>)/, "$1$1"],
    ],
  },
  {
    ac: "What it is",
    what: "a why line without its dot",
    ...onPage("de", checkWhat),
    fact: "what",
    message: /^the why lines run pains\.now\.1, no dot\+pains\.now\.2,/,
    edits: [[/<span class="dot" aria-hidden="true"><\/span>(<span data-i18n="pains\.now\.2">)/, "$1"]],
  },
  {
    ac: "What it is",
    what: "agent memory's sessions mark raised to three",
    ...onPage("fr", checkWhat),
    fact: "what",
    message: /the rating's mem row is 3, 0, 0, 1, 0, 3; 2, 0, 0, 1, 0, 3/,
    edits: [
      [
        '<i class="on"></i><i class="on"></i><i></i></span><span class="visually-hidden">2/3</span>',
        '<i class="on"></i><i class="on"></i><i class="on"></i></span><span class="visually-hidden">3/3</span>',
      ],
    ],
  },
  {
    ac: "What it is",
    what: "a rating cell whose dots and words disagree",
    ...onPage("zh", checkWhat),
    fact: "what",
    message: /the rating's mem row is 2 of 3 said 1\/3, 0,/,
    edits: [
      [
        '<i class="on"></i><i class="on"></i><i></i></span><span class="visually-hidden">2/3</span>',
        '<i class="on"></i><i class="on"></i><i></i></span><span class="visually-hidden">1/3</span>',
      ],
    ],
  },
  {
    ac: "What it is",
    what: "the choice tree ending in PDD",
    ...onPage("uk", checkWhat),
    fact: "what",
    message: /the tree does not end in ProjectStore/,
    edits: [['<li class="tree-end"><p><b>ProjectStore</b>', '<li class="tree-end"><p><b>PDD</b>']],
  },
  {
    ac: "What it is",
    what: "the tree's questions in another order",
    ...onPage("es", checkWhat),
    fact: "what",
    message: /^the tree runs tree\.q\.2>mem, tree\.q\.1>chat,/,
    edits: [
      [
        /(<li class="tree-step"><p class="tree-q" data-i18n="tree\.q\.1">[\s\S]*?<\/li>)(\s*)(<li class="tree-step"><p class="tree-q" data-i18n="tree\.q\.2">[\s\S]*?<\/li>)/,
        "$3$2$1",
      ],
    ],
  },
  {
    ac: "What it is",
    what: "the ladder losing SDD's step",
    ...onPage("pt", checkWhat),
    fact: "what",
    message: /the ladder has 4 steps; 5/,
    edits: [[/\s*<li><span class="brick" data-i18n="ladder\.b\.3">[^\n]*?<b>SDD<\/b><\/li>/, ""]],
  },
  {
    ac: "What it is",
    what: "the ladder put above the rating",
    ...onPage("en", checkWhat),
    fact: "what",
    message: /the comparison's blocks do not run/,
    edits: [
      [
        /(<h3 class="cmp-sub" id="rate-title"[\s\S]*?)(<h3 class="cmp-sub" id="ladder-title"[\s\S]*?<\/ol>\s*<\/div>)/,
        "$2$1",
      ],
    ],
  },
  {
    ac: "What it is",
    what: "the comparison's summary moved above the table",
    ...onPage("en", checkWhat),
    fact: "what",
    message: /^cmp\.sum is not once under the table;/,
    edits: [
      [/(<div class="table-wrap">[\s\S]*?<\/table>\s*<\/div>)(\s*)(<p class="cmp-sum"[^>]*>[\s\S]*?<\/p>)/, "$3$2$1"],
    ],
  },
  {
    ac: "What it is",
    what: "the main page's How it works button aimed at an id the page does not have",
    ...onPage("en", (p) => checkFragments(p, idsByPath(PAGES))),
    fact: "fragment",
    message: /^#hwo lands on \/, which has no id="hwo"$/,
    edits: [['href="#how"', 'href="#hwo"']],
  },

  // AC "Install": six quick-start steps, the install box in the third, Install → landing on #start.
  {
    ac: "Install",
    what: "a seventh quick-start step",
    ...onPage("en", checkQuickStart),
    fact: "quick-start",
    message: /^7 steps on quick\.s\.a\.h, .*quick\.s\.4\.h, quick\.s\.4\.h; 6, on /,
    edits: [[/(<li><h3 data-i18n="quick\.s\.4\.h">[\s\S]*?<\/li>)/, "$1$1"]],
  },
  {
    ac: "Install",
    what: "the install box moved to step 4",
    ...onPage("ru", checkQuickStart),
    fact: "quick-start",
    message: /^the install box is in step 4; in step 3 alone$/,
    edits: [[BOX_TO_STEP_4, "$2$1"]],
  },
  {
    ac: "Install",
    what: "the install box moved to step 4, where the install box check does not look",
    ...onPage("en", checkInstallBox),
    fact: "install-box",
    message: /^0 tabbed boxes in quick start's step 3; one$/,
    edits: [[BOX_TO_STEP_4, "$2$1"]],
  },
  {
    ac: "Step 3",
    what: "the old tab label's key back on the ask tab",
    ...onPage("ru", checkStep3),
    fact: "step-3",
    message: /^the tabs are on start\.tab\.old, start\.tab\.term; start\.tab\.ask, start\.tab\.term$/,
    edits: [['data-i18n="start.tab.ask"', 'data-i18n="start.tab.old"']],
  },
  {
    ac: "Step 3",
    what: "a second line before the install box",
    ...onPage("en", checkStep3),
    fact: "step-3",
    message: /^the step's text before the box is quick\.s\.1\.p, unkeyed; one line on quick\.s\.1\.p$/,
    edits: [[/(<p data-i18n="quick\.s\.1\.p">[\s\S]*?<\/p>)/, "$1<p>In Codex, only the terminal.</p>"]],
  },
  {
    ac: "Four tones",
    what: "the classic tones' glow rule removed",
    ...onText(STYLE, checkGlow),
    fact: "glow",
    message: /^0 glow rules for the classic tones/,
    edits: [
      [
        /\n {2}:root:is\(\[data-tone="midnight"\], \[data-tone="graphite"\], \[data-tone="paper"\]\) body::before \{[^\n]*\}/,
        "",
      ],
    ],
  },
  {
    ac: "Four tones",
    what: "midnight's glow made transparent",
    ...onText(STYLE, checkGlow),
    fact: "glow",
    message: /^midnight --glow-1 is #3d63dd00; lit in a classic tone$/,
    edits: [["--glow-1: #3d63dd30;", "--glow-1: #3d63dd00;"]],
  },
  {
    ac: "Four tones",
    what: "light keeping midnight's glow",
    ...onText(STYLE, checkGlow),
    fact: "glow",
    message: /^light --glow-1 is #3d63dd30; transparent in light$/,
    edits: [[/(--head-bg: var\(--light-head-bg\);\n)\s*--glow-1: var\(--no-glow\);/, "$1   "]],
  },
  {
    ac: "Four tones",
    what: "a token set in a shape rule",
    ...onText(STYLE, checkGlow),
    fact: "glow",
    message: /\.lang sets a token/,
    edits: [
      [
        '[data-tone="paper"]) .lang { border-radius: 4px; }',
        '[data-tone="paper"]) .lang { border-radius: 4px; --accent: var(--brand); }',
      ],
    ],
  },
  {
    ac: "Step 3",
    what: "a note put back under the prompt",
    ...onPage("en", checkInstallBox),
    fact: "install-box",
    message: /^the ask panel carries start\.ask\.note; the prompt stands alone$/,
    edits: [
      ["</blockquote>", '</blockquote><p class="note" data-i18n="start.ask.note">In Codex, use the terminal.</p>'],
    ],
  },
  {
    ac: "Install",
    what: "the tabs in the other order",
    ...onPage("ru", checkInstallBox),
    fact: "install-box",
    message: /^the tabs are term, ask; ask, then term$/,
    edits: [
      ['data-tab="ask" id="tab-ask"', 'data-tab="x" id="tab-ask"'],
      ['data-tab="term" id="tab-term"', 'data-tab="ask" id="tab-term"'],
      ['data-tab="x" id="tab-ask"', 'data-tab="term" id="tab-ask"'],
    ],
  },
  {
    ac: "Install",
    what: "a method page's Install → aimed at #instal",
    ...onPage("de", (p) => checkFragments(p, idsByPath(PAGES)), "one-vault"),
    fact: "fragment",
    message: /^\.\.\/#instal lands on \/de\/, which has no id="instal"$/,
    edits: [['href="../#start"', 'href="../#instal"']],
  },

  // AC "The order", "Unique ids": the chapter heads as h2, one h1 a page, no id twice.
  {
    ac: "The order",
    what: "One vault's chapter head set as an h1",
    ...onPage("en", checkChapters),
    fact: "chapters",
    message:
      /^#team holds label team\.label, h1 vault\.h1, lead teams\.p\.1; label team\.label, h2 vault\.h1, lead teams\.p\.1$/,
    edits: [[/<h2 (id="team-title"[^>]*)>([\s\S]*?)<\/h2>/, "<h1 $1>$2</h1>"]],
  },
  {
    ac: "The order",
    what: "the same head as an h1, one h1 too many",
    ...onPage("en", checkOneH1),
    fact: "h1",
    message: /^2 h1 elements \("A method for working with AI agents/,
    edits: [[/<h2 (id="team-title"[^>]*)>([\s\S]*?)<\/h2>/, "<h1 $1>$2</h1>"]],
  },
  {
    ac: "The order",
    what: "a method page without its h1",
    ...onPage("de", checkOneH1, "why-it-works"),
    fact: "h1",
    message: /^0 h1 elements \(none\); a page has one$/,
    edits: [[/<h1 (id="why-title"[^>]*)>([\s\S]*?)<\/h1>/, "<h2 $1>$2</h2>"]],
  },
  {
    ac: "Unique ids",
    what: 'id="loop" twice on the Russian main page',
    ...onPage("ru", checkUniqueIds),
    fact: "id",
    message: /^id="loop" is on 2 elements; an id names one$/,
    edits: [['<section class="sec" id="agents"', '<section class="sec" id="loop"']],
  },

  // AC "The method's blocks": the loop belongs to How it works' head, the digests link their
  // pages, every copied block keeps its keys, and the main page's loop keeps its press order.
  {
    ac: "The method's blocks",
    what: "the loop given How it works' label back",
    ...onPage("ru", checkChapters),
    fact: "chapters",
    message: /^#loop holds a section label; the how chapter's head is its heading$/,
    edits: [
      [
        '<section class="sec joined" id="loop" aria-labelledby="loop-title">',
        '<section class="sec joined" id="loop" aria-labelledby="loop-title"><div class="section-label" data-i18n="how.loop.label">Цикл</div>',
      ],
    ],
  },
  {
    ac: "The method's blocks",
    what: "One vault's whole-page link aimed at How it works",
    ...onPage("ru", checkChapters),
    fact: "chapters",
    message: /^team\.more links \/ru\/how-it-works\/; once, from #git, to \/ru\/one-vault\/$/,
    edits: [['<a href="one-vault/" data-i18n="team.more">', '<a href="how-it-works/" data-i18n="team.more">']],
  },
  {
    ac: "The method's blocks",
    what: "a guard renamed on the main page alone",
    ...onPage("en", (p) => checkCopied(p, methodPages("en"))),
    fact: "copied",
    message: /^#mechanisms has how\.m\.7\.h as key #\d+, where site\/how-it-works\/index\.html has how\.m\.6\.h/,
    edits: [['data-i18n="how.m.6.h"', 'data-i18n="how.m.7.h"']],
  },
  {
    ac: "The method's blocks",
    what: "the Russian chain keeps Why it works' prompt box",
    ...onPage("ru", (p) => checkCopied(p, methodPages("ru"))),
    fact: "copied",
    message: /^#chain has method\.ask as key #\d+, where site\/ru\/why-it-works\/index\.html has none/,
    edits: [
      [
        '<p class="next-pages"><a href="why-it-works/" data-i18n="why.more">',
        '<div class="ask ask-end"><div class="ask-head"><span data-i18n="method.ask">Просто попросите Claude Code:</span></div></div><p class="next-pages"><a href="why-it-works/" data-i18n="why.more">',
      ],
    ],
  },
  {
    ac: "The method's blocks",
    what: "the main page's loop diagram numbering the artifact block step 4",
    ...onPage("ru", checkPressOrder),
    fact: "press-order",
    message: /block #2 is step 4, not 2/,
    edits: [['<g class="node" data-step="2">', '<g class="node" data-step="4">']],
  },

  // AC "No carousel": nothing of it in a dictionary, the stylesheet or a template.
  {
    ac: "No carousel",
    what: "a headline key back in the Russian dictionary",
    ...onText(`${SITE}/locales/ru.json`, checkNoCarousel),
    fact: "carousel",
    message: /^"hero\.h\.1": the carousel/,
    edits: [[/^\{\n/, '{\n  "hero.h.1": "Агент сказал «готово».",\n']],
  },
  {
    ac: "No carousel",
    what: "the carousel's dots styled again",
    ...onText(STYLE, checkNoCarousel),
    fact: "carousel",
    message: /^"carousel-dots": the carousel/,
    edits: [[/$/, "\n.carousel-dots { display: inline-flex; }\n"]],
  },
  {
    ac: "No carousel",
    what: "a carousel region back in the main template",
    ...onText(`${SITE}/src/index.html`, checkNoCarousel),
    fact: "carousel",
    message: /^"data-carousel": the carousel/,
    edits: [['<section class="hero what" id="what"', '<section class="hero what" id="what" data-carousel']],
  },

  {
    ac: "The title and description",
    what: "the Russian title reworded",
    ...onPage("ru", checkMainHead),
    fact: "head",
    message: /^the title is "ProjectStore — план и проверки для вашего агента"$/,
    edits: [[/(<title data-i18n="meta\.title">)[^<]*/, "$1ProjectStore — план и проверки для вашего агента"]],
  },

  // AC "The loop media": the player's still, its alt, its controls' names, no link.
  {
    ac: "The loop media",
    what: "the still swapped for another picture",
    ...onPage("ru", checkLoopFigure),
    fact: "loop-figure",
    message: /^the image is \.\.\/assets\/og\.png; loop-still\.webp$/,
    edits: [
      [
        '<img class="player-poster" src="../assets/loop-still.webp"',
        '<img class="player-poster" src="../assets/og.png"',
      ],
    ],
  },
  {
    ac: "The loop media",
    what: "a link around the picture",
    ...onPage("en", checkLoopFigure),
    fact: "loop-figure",
    message: /^the figure links to assets\/loop-still\.webp; it links to no file$/,
    edits: [
      ['<img class="player-poster"', '<a href="assets/loop-still.webp"><img class="player-poster"'],
      [/(<img class="player-poster"[^>]*>)/, "$1</a>"],
    ],
  },
  {
    ac: "The loop media",
    what: "the picture without an alt",
    ...onPage("en", checkLoopFigure),
    fact: "loop-figure",
    message: /^the picture has no alt$/,
    edits: [[/(<img class="player-poster"[^>]*) alt="[^"]*"/, '$1 alt=""']],
  },
  {
    ac: "The loop media",
    what: "a control without a name",
    ...onPage("ru", checkLoopFigure),
    fact: "loop-figure",
    message: /^no <button class="player-full"> with a name$/,
    edits: [[/(<button class="player-full"[^>]*) aria-label="[^"]*"/, "$1"]],
  },
  {
    ac: "The loop media",
    what: "the player's frame out of its template",
    ...onPage("en", checkLoopFigure),
    fact: "loop-figure",
    message: /^the player's frame is assets\/loop\.html; loop\.html, inside a <template>$/,
    edits: [
      ['<template class="player-src">', ""],
      ["</iframe></template>", "</iframe>"],
    ],
  },
  {
    ac: "The player",
    what: "the player moved above the loop diagram",
    ...onPage("ru", checkLoopFigure),
    fact: "loop-figure",
    message: /^the player is not in section#loop after the loop diagram \(figure\.loop\)$/,
    edits: [
      [
        /(<figure class="loop"[\s\S]*?<\/figure>)(\s*)(<figure class="loopfig" data-player>[\s\S]*?<\/figure>)/,
        "$3$2$1",
      ],
    ],
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
    edits: [["  .term { box-shadow: none; }\n  .graph { display: none; }", "  .term { box-shadow: none; }"]],
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

  // The front page story: the agents line, its names in order, no status in any language.
  {
    ac: "The agents line",
    what: "Cursor added to the agents line in #what",
    ...onPage("en", checkAgents),
    fact: "agents-named",
    message: /^#what names Claude Code, Codex, Cursor, OpenCode, Gemini, Z\.ai, DeepSeek;/,
    edits: [["<b>Codex</b>. <b>OpenCode</b>", "<b>Codex</b>, <b>Cursor</b>. <b>OpenCode</b>"]],
  },
  {
    ac: "The agents line",
    what: "Cursor named again in the page's description",
    ...onPage("ru", checkAgents),
    fact: "agents-named",
    message: /^the page names Cursor, which it dropped$/,
    edits: [[/(<meta name="description" content="[^"]*)Codex/, "$1Codex и Cursor"]],
  },
  {
    ac: "The agents line",
    what: "OpenCode and Gemini swapped in the trust ticks",
    ...onPage("en", checkAgents),
    fact: "agents-named",
    message: /^the trust list names Claude Code, Codex, Gemini, OpenCode, Z\.ai, DeepSeek;/,
    edits: [
      section('<section class="sec" id="talk"', (sec) =>
        sec
          .replace("<b>OpenCode</b>", "<b>x</b>")
          .replace("<b>Gemini</b>", "<b>OpenCode</b>")
          .replace("<b>x</b>", "<b>Gemini</b>"),
      ),
    ],
  },
  {
    ac: "The agents line",
    what: "a name translated on the Russian page",
    ...onPage("ru", checkAgents),
    fact: "agents-named",
    message: /^#what names Claude Code, Кодекс, OpenCode,/,
    edits: [["<b>Codex</b>", "<b>Кодекс</b>"]],
  },
  {
    ac: "No harness status on the site",
    what: "a status marker put back on the main page",
    ...onPage("en", checkNoStatus),
    fact: "no-status",
    message: /data-fact="harness-status:codex"/,
    edits: [["<b>Codex</b>", '<b>Codex</b> <span data-fact="harness-status:codex">ready</span>']],
  },
  {
    ac: "No harness status on the site",
    what: "the English after-install line calling Codex experimental",
    ...onPage("en", checkNoStatus),
    fact: "no-status",
    message: /calls Codex experimental$/,
    edits: [
      [/(data-i18n="quick\.s\.1\.after">)[^<]*/, "$1After installing, restart the agent. Codex is experimental."],
    ],
  },
  {
    ac: "No harness status on the site",
    what: "the German How it works calling Codex experimentell",
    ...onPage("de", checkNoStatus, "how-it-works"),
    fact: "no-status",
    message: /calls Codex experimentell$/,
    edits: [[/(data-i18n="how\.fine\.2">)[^<]*/, "$1In Codex sind die Rollen experimentell."]],
  },
  {
    ac: "No harness status on the site",
    what: "the Russian after-install line calling Codex experimental",
    ...onPage("ru", checkNoStatus),
    fact: "no-status",
    message: /calls Codex экспериментальн$/,
    edits: [
      [
        /(data-i18n="quick\.s\.1\.after">)[^<]*/,
        "$1После установки перезапустите агента. Codex пока экспериментальный.",
      ],
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
    ...onFile(pageOf("ru").file),
    fact: "load",
    message:
      /<link rel="canonical"> points at https:\/\/projectstore\.example\/ru\/, not under https:\/\/projectstore\.dev\//,
    edits: [
      [
        '<link rel="canonical" href="https://projectstore.dev/ru/">',
        '<link rel="canonical" href="https://projectstore.example/ru/">',
      ],
    ],
  },
  {
    ac: "4",
    what: "a <script src> from a CDN",
    ...onFile(pageOf("zh", "why-it-works").file),
    fact: "load",
    message: /<script src> loads https:\/\/cdn/,
    edits: [
      [
        '<script src="../../assets/site.js',
        '<script src="https://cdn.example.com/a.js"></script>\n<script src="../../assets/site.js',
      ],
    ],
  },
  {
    ac: "4",
    what: "a protocol-relative <img src>",
    ...onFile(pageOf("uk", "how-it-works").file),
    fact: "load",
    message: /<img src> loads \/\/cdn/,
    edits: [['src="../../assets/mark.svg"', 'src="//cdn.example.com/mark.svg"']],
  },
  {
    ac: "4",
    what: "a stylesheet that is not under site/",
    ...onFile(pageOf("ru").file),
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
  {
    ac: "The loop media",
    what: "a loop still on another origin",
    ...onFile(EN.main.file),
    fact: "load",
    message: /<img src> loads https:\/\/cdn\.example\.com\/loop-still\.webp/,
    edits: [
      [
        '<img class="player-poster" src="assets/loop-still.webp"',
        '<img class="player-poster" src="https://cdn.example.com/loop-still.webp"',
      ],
    ],
  },
  {
    ac: "The loop media",
    what: "the loop's page loading its font from another origin",
    ...onFile(`${SITE}/assets/loop.html`),
    fact: "load",
    message: /loads https:\/\/fonts\.example\.com\/plex\.woff2/,
    edits: [['url("fonts/IBMPlexMono-Regular-Latin1.woff2")', 'url("https://fonts.example.com/plex.woff2")']],
  },
  {
    ac: "The loop media",
    what: "the loop's page missing from site/assets/",
    ...onFile(pageOf("ru").file),
    fact: "load",
    message: /no site\/assets\/loop\.htm(?!l)/,
    edits: [["../assets/loop.html", "../assets/loop.htm"]],
  },
  {
    ac: "The loop media",
    what: "a still missing from site/assets/",
    ...onFile(pageOf("ru").file),
    fact: "load",
    message: /no site\/assets\/loop-stil\.webp/,
    edits: [["../assets/loop-still.webp", "../assets/loop-stil.webp"]],
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
    what: "llms.txt stops linking the Russian main page",
    ...onText(LLMS_TXT, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "pages",
    message: /https:\/\/projectstore\.dev\/ru\//,
    edits: [[/^.*\(https:\/\/projectstore\.dev\/ru\/\).*\n/m, ""]],
  },
  {
    ac: "Languages",
    what: "llms.txt links /en/, which redirects",
    ...onText(LLMS_TXT, (f, t) => checkLlmsLinks(f, t, LANGS)),
    fact: "stub-link",
    message: /https:\/\/projectstore\.dev\/en\/ redirects/,
    edits: [[/$/, "\n- [English](https://projectstore.dev/en/)\n"]],
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
    what: "an ADR example with a review_status the product never writes, on a page that had none",
    ...onPage("pt", (p) => checkShapes(p, REPO), "how-it-works"),
    fact: "template:adr",
    message: /review_status: approved/,
    edits: [
      beforeMain('<pre data-template="adr">---\ntype: adr\nstatus: accepted\nreview_status: approved\n---</pre>'),
    ],
  },
  {
    ac: "5",
    what: "a heading the Chinese story template does not have",
    ...onPage("zh", (p) => checkShapes(p, REPO), "how-it-works"),
    fact: "template:story",
    message: /## 上下文/,
    edits: [['<span class="h">## 验收标准</span>', '<span class="h">## 上下文</span>']],
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
    ...onPage("es", (p) => checkShapes(p, REPO), "how-it-works"),
    fact: "template:story",
    message: /no frontmatter between "---" lines/,
    edits: [
      [
        /(data-template="story"[\s\S]*?<span class="fm">---<\/span>[\s\S]*?)<span class="fm">---<\/span>/,
        '$1<span class="fm">- - -</span>',
      ],
    ],
  },
  {
    ac: "5",
    what: "a frontmatter line that is not key: value",
    ...onPage("fr", (p) => checkShapes(p, REPO), "how-it-works"),
    fact: "template:story",
    message: /frontmatter line "status done" is not "key: value"/,
    edits: [
      [
        '<span class="k">status:</span> <span class="c-ok">done</span>',
        '<span class="k">status</span> <span class="c-ok">done</span>',
      ],
    ],
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
    ...onPage("de", (p) => checkSlugs(p, REPO), "how-it-works"),
    fact: "slug:story",
    message: new RegExp(`slugify makes "${escape(REPO.derive("story", "path", DE_TITLE))}"`),
    edits: [
      [/(data-title="story">)[^<]*/, `$1${DE_TITLE}`],
      [/(data-slug="story:path">)[^<]*/, `$1${REPO.derive("story", "path", DE_TITLE).replace(/ä/g, "a")}`],
    ],
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
    ...onPage("en", (p) => checkSlugs(p, REPO), "how-it-works"),
    fact: "slug",
    message: /example path "stories\/story-[^"]+\.md" is not marked/,
    edits: [[/<span data-slug="story:path"[^>]*>/, "<span>"]],
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
    ...onPage("de", checkPressOrder, "how-it-works"),
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
    ac: "Languages",
    what: "a German method page linking its brand to /en/, which redirects",
    ...onPage("de", checkNoStubLinks, "how-it-works"),
    fact: "stub-link",
    message: /lands on \/en\/, which redirects to \//,
    edits: [['<a class="brand" href="../"', '<a class="brand" href="../../en/"']],
  },
  {
    ac: "Languages",
    what: "a German method page's brand linking the English main page",
    ...onPage("de", (p) => checkPageLinks(p, pageDirsByLang(LANGS)), "how-it-works"),
    fact: "page-link",
    message: /lands on \/, which is not a de page/,
    edits: [['<a class="brand" href="../"', '<a class="brand" href="../../"']],
  },
  {
    ac: "4",
    what: "the loop diagram's blocks lose their class",
    ...onPage("es", checkPressOrder, "how-it-works"),
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
      checkPageSet(LANGS, PAGE_FILES, (rel) => rel !== `${SITE}/ru/index.html` && SITE_FS.isFile(rel)),
      `${SITE}/ru/index.html`,
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
  const es = pageOf("es", "one-vault");
  const bind = plant(es.html, [[INSTALL_LINE, "$1/projectstore:bind ~/Documents/my-project-vault --lang es<"]]);
  assert.deepEqual(checkInstall(parse(es.file, bind, "es", "one-vault"), REPO), [], "es ships templates");
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
  const de = pageOf("de", "why-it-works");
  assert.ok(
    de.html.includes('<link rel="canonical" href="https://projectstore.dev/de/why-it-works/">'),
    "the built page's canonical is absolute",
  );
  assert.ok(
    de.html.includes('<link rel="alternate" hreflang="x-default" href="https://projectstore.dev/why-it-works/">'),
    "and so are its alternates",
  );
  assert.deepEqual(checkLoads(de.file, de.html), [], "an absolute canonical under the site's origin is not a finding");
  const relative = plant(de.html, [
    ['<link rel="canonical" href="https://projectstore.dev/de/why-it-works/">', '<link rel="canonical" href="./">'],
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

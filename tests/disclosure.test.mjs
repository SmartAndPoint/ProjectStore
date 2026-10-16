// projectstore — PS-DIRECTORY: "The README and the manifest say everything the
// plugin runs, writes, sends and fetches, and the listing has its icon, its
// links and a privacy page". Anthropic's directory scans every version for
// behaviour the README does not disclose (the pre-submission checklist,
// "Prepare for the security scan": "Describe in the README everything the
// plugin runs, sends, or fetches"), shows the README as the listing, and
// reads the listing fields from .claude-plugin/plugin.json.
//
// The guard pins modules, not call strings: a program or a URL is often
// manifest data or an argv built elsewhere (`spawn(bin || s.cli.bin, …)`,
// run-host's `spawn(bin, argv, …)`, setup handing `spawnSync` to gitTop,
// models.mjs's URL and header from the catalog). So every shipped module that
// imports node:child_process or calls fetch is in MODULES below, with the
// README rows that disclose what it starts or asks; a new one fails until it
// is placed there, and the README says what it does. A launch of our own file
// through process.execPath is exempt by rule, and checked to be only that.
//
// Every module is read through its namespace, so a name a release lacks fails
// the one test that calls it, not the whole file.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/disclosure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./fixtures/vocabulary.mjs";
import { markdownLines } from "./fixtures/markdown.mjs";
import * as imports from "./fixtures/imports.mjs";
import * as harness from "../scripts/harness.mjs";
import * as conv from "../scripts/convergence.mjs";
import * as fetchShell from "../scripts/fetch-shell.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
// What npm packs, which is also the tree Anthropic's directory scans (the
// packed `directory` branch is the core's packlist).
const PACKLIST = readJson("tests/fixtures/packlist.json");
const CODE = /\.(?:mjs|cjs|js|ts|tsx)$/;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const FONT = /\.(?:woff2?|ttf|otf)$/i;
const SHIPPED_CODE = PACKLIST.filter((f) => CODE.test(f) && !f.endsWith(".d.ts"));

// ─── README's section, read as rows ─────────────────────────────────────

const SECTION = "## What ProjectStore runs, writes, sends and fetches";
const RUNS = "### What it runs";
const WRITES = "### What it writes";
const SENDS = "### What it sends and fetches";
const REPORTS = "### What Anthropic's directory reports";
const DIRECTORY = "## Installed from Anthropic's directory";

// The text under a heading, up to the next heading of the same or a higher
// level; null when README has no such heading.
function under(md, heading) {
  const level = heading.indexOf(" ");
  const lines = md.split("\n");
  const at = lines.indexOf(heading);
  if (at < 0) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#{1,6}) /.exec(l);
    return m && m[1].length <= level;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

// A subsection's rows: each "- **Lead** text" bullet, by its lead with the
// lead's closing punctuation dropped.
function rowsOf(text) {
  const rows = new Map();
  for (const m of String(text || "").matchAll(/^- \*\*(.+?)\*\*(.*)$/gm))
    rows.set(m[1].replace(/[.:,]+$/, ""), `**${m[1]}**${m[2]}`);
  return rows;
}

const README = read("README.md");
const section = () => under(README, SECTION);
const sub = (heading) => (section() === null ? null : under(section(), heading));

// ─── The rows, and what the code says for each ──────────────────────────

// Each row names its strings as [what README says, what the code holds, the
// code or the manifest data that holds it], so a row cannot outlive what it
// describes.
const code = (rel) => stripComments(read(rel));
const manifest = (id) => harness.loadHarness(id);
const catalogs = (id) => manifest(id)?.agent_translation?.models?.catalogs || [];
const httpCatalogs = () => ["claude-code", "codex"].flatMap((id) => catalogs(id).filter((c) => c.kind === "http"));
const hostCli = () =>
  ["claude-code", "codex"].map((id) => manifest(id)?.surfaces?.plugin?.cli?.bin).filter((b) => typeof b === "string");
const npmArgv = () => JSON.stringify(fetchShell.fetchArgv({ prefix: "p", shell: "s", version: "1.0.0" }));
const codexShell = () => manifest("codex")?.install?.shell;

const ROWS = {
  node: {
    sub: RUNS,
    lead: "Node.js",
    says: () => [
      ["`bin/projectstore.mjs`", '"bin", "projectstore.mjs"', code("scripts/convergence.mjs")],
      ["the same Node", "process.execPath", code("scripts/convergence.mjs")],
    ],
  },
  git: {
    sub: RUNS,
    lead: "git",
    says: () => [
      ["`git rev-parse`", '"rev-parse"', code("scripts/worktree.mjs")],
      ["`git rev-parse --show-toplevel`", '"rev-parse", "--show-toplevel"', code("scripts/binding.mjs")],
      ["`git init`", '"init"', code("scripts/binding.mjs")],
      ["`git config --get user.name`", '"config", "--get", "user.name"', code("scripts/cli.mjs")],
      ["`git check-ignore`", '"check-ignore"', code("scripts/doctor.mjs")],
      ["`git ls-files`", '"ls-files"', code("scripts/doctor.mjs")],
      ["`git diff --name-only`", '"diff", "--name-only"', code("scripts/diff-refs.mjs")],
      ["`git log`", '"log"', code("scripts/diff-refs.mjs")],
      ["SessionStart hook", "resolveBinding(", code("hooks/session-start.mjs")],
    ],
  },
  hosts: {
    sub: RUNS,
    lead: "The agent CLIs, `claude` and `codex`",
    says: () => [
      ...hostCli().map((b) => [`\`${b}\``, b, JSON.stringify(hostCli())]),
      [
        "`plugin marketplace add`",
        '"marketplace","add"',
        JSON.stringify(manifest("claude-code")?.surfaces?.plugin?.cli),
      ],
      ["`plugin install`", '"install"', JSON.stringify(manifest("claude-code")?.surfaces?.plugin?.cli)],
      ...catalogs("codex")
        .filter((c) => c.kind === "command")
        .map((c) => [`\`${c.argv.join(" ")}\``, JSON.stringify(c.argv), JSON.stringify(c)]),
    ],
  },
  npm: {
    sub: RUNS,
    lead: "npm",
    says: () => [
      ["`npm config get registry`", '"config", "get", "registry"', code("scripts/fetch-shell.mjs")],
      ["`npm install`", '"install"', npmArgv()],
      ["`--ignore-scripts`", '"--ignore-scripts"', npmArgv()],
      [`\`${codexShell()}\``, String(codexShell()), JSON.stringify(manifest("codex")?.install)],
    ],
  },
  statusline: {
    sub: RUNS,
    lead: "Your own status line",
    says: () => [
      ["`.claude/settings.json`", '".claude", "settings.json"', code("scripts/statusline.mjs")],
      ["through your shell", "shell: true", code("scripts/statusline.mjs") + code("scripts/statusline-launcher.mjs")],
      ["standard input", "input:", code("scripts/statusline.mjs") + code("scripts/statusline-launcher.mjs")],
    ],
  },
  registry: {
    sub: SENDS,
    lead: "The npm registry",
    says: () => [
      [`\`${conv.DEFAULT_REGISTRY}\``, JSON.stringify(conv.DEFAULT_REGISTRY), code("scripts/convergence.mjs")],
      [`\`GET <registry>/${conv.PACKAGE}\``, "/${PACKAGE}`", code("scripts/convergence.mjs")],
      ["no credentials", "headers: { accept: ACCEPT }", code("scripts/convergence.mjs")],
      [
        `${conv.READ_TIMEOUT_MS / 1000}-second`,
        `READ_TIMEOUT_MS = ${conv.READ_TIMEOUT_MS}`,
        code("scripts/convergence.mjs"),
      ],
      [`${conv.FRESH_MS / 3600000} hours`, "FRESH_MS = 24 * 60 * 60 * 1000", code("scripts/convergence.mjs")],
      [`\`${conv.NO_CHECK_ENV}=1\``, JSON.stringify(conv.NO_CHECK_ENV), code("scripts/convergence.mjs")],
    ],
  },
  codex: {
    sub: SENDS,
    lead: "The Codex package",
    says: () => [[`\`${codexShell()}\``, String(codexShell()), JSON.stringify(manifest("codex")?.install)]],
  },
  models: {
    sub: SENDS,
    lead: "Anthropic's model list",
    says: () => [
      ...httpCatalogs().flatMap((c) => {
        const u = new URL(c.url);
        return [
          [`\`https://${u.host}${u.pathname}\``, `https://${u.host}${u.pathname}`, c.url],
          [`\`$${c.base_env}\``, c.base_env, JSON.stringify(c)],
          [`\`${c.key_env}\``, c.key_env, JSON.stringify(c)],
          [`\`${c.key_header}\``, c.key_header, JSON.stringify(c)],
        ];
      }),
      // The module reads those fields of the catalog, and nothing else of the environment.
      ["your key", "catalog.key_env", code("scripts/models.mjs")],
      ["`x-api-key` header", "catalog.key_header", code("scripts/models.mjs")],
      ["`$ANTHROPIC_BASE_URL`", "catalog.base_env", code("scripts/models.mjs")],
    ],
  },
};

// The one named exemption: shipped, never run by the plugin. It names itself
// and what it runs, so the README sentence stays true of it.
const EXEMPT = {
  "scripts/version-guard.mjs": {
    why: "release tooling, shipped, never run by the plugin",
    says: ["`scripts/version-guard.mjs`", "`npm pack --dry-run`"],
    argv: ['"pack"', '"--dry-run"'],
  },
};

// Every shipped module that imports node:child_process or calls fetch, with
// the rows that disclose it. `execPath`: every spawn it makes launches our own
// file through process.execPath (exempt by rule); a module with no row must
// be that, which the test checks. Later stories add rows here (a module that
// moves code out of one of these, a new read verb that spawns doctor).
const MODULES = {
  "scripts/binding.mjs": { rows: ["git"] },
  "scripts/cli.mjs": { rows: ["git"], execPath: true },
  "scripts/convergence.mjs": { rows: ["registry"] },
  "scripts/diff-refs.mjs": { rows: ["git"] },
  "scripts/doctor.mjs": { rows: ["git"], execPath: true },
  "scripts/install-harness.mjs": { rows: ["hosts", "node"] },
  "scripts/mcp.mjs": { rows: [], execPath: true },
  "scripts/models.mjs": { rows: ["hosts", "models"] },
  "scripts/reconcile.mjs": { rows: [], execPath: true },
  "scripts/run-host.mjs": { rows: ["npm", "codex", "node"] },
  "scripts/setup.mjs": { rows: ["git"] },
  "scripts/statusline-launcher.mjs": { rows: ["statusline"] },
  "scripts/statusline.mjs": { rows: ["statusline"] },
  "scripts/version-guard.mjs": { exempt: true },
};

// ─── What a module's code can reach ─────────────────────────────────────

const CHILD_PROCESS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?child_process["']/;
const callsFetch = (src) =>
  (imports.callsFetch ? imports.callsFetch(src) : /\bfetch\s*\(/.test(stripComments(src))) ||
  /\bfetch\s*\.\s*(?:call|apply)\s*\(/.test(stripComments(src));
// A connection opened another way than fetch: none ships today, and one fails.
const NETWORK =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)["']|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(/;

// The local names a module binds from node:child_process.
function childProcessNames(src) {
  const names = [];
  for (const m of stripComments(src).matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g))
    for (const part of m[1].split(","))
      if (part.trim())
        names.push(
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            .trim(),
        );
  return names;
}

// The uses of those names that are not a launch of process.execPath: a call
// with another first argument, or a name handed on by reference.
function nonExecPathUses(src) {
  const body = stripComments(src).replace(/import\s*\{[^}]*\}\s*from\s*["'](?:node:)?child_process["'];?/g, "");
  const out = [];
  for (const name of childProcessNames(src))
    for (const m of body.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g"))) {
      const after = body.slice(m.index + name.length);
      if (!/^\s*\(\s*process\.execPath\s*,/.test(after)) out.push(`${name}${after.slice(0, 40).split("\n")[0]}`);
    }
  return out;
}

const pinned = () =>
  SHIPPED_CODE.filter((f) => {
    const src = read(f);
    return CHILD_PROCESS.test(stripComments(src)) || callsFetch(src);
  }).sort();

// ─── The tests ──────────────────────────────────────────────────────────

test("disclosure: the shipped modules that spawn or fetch are the pinned map", () => {
  assert.ok(
    SHIPPED_CODE.includes("hooks/band.tsx") && SHIPPED_CODE.includes("bin/projectstore.mjs"),
    "every code file",
  );
  assert.deepEqual(
    pinned(),
    Object.keys(MODULES).sort(),
    "a shipped module that imports node:child_process or calls fetch is placed in MODULES, with its README rows",
  );
  assert.deepEqual(
    SHIPPED_CODE.filter((f) => NETWORK.test(stripComments(read(f)))),
    [],
    "no shipped module opens a connection other than through fetch",
  );
  assert.ok(section() !== null, `README has "${SECTION}"`);
  for (const [heading, rows] of [
    [RUNS, ["node", "git", "hosts", "npm", "statusline"]],
    [SENDS, ["registry", "codex", "models"]],
  ]) {
    const have = rowsOf(sub(heading));
    for (const id of rows) assert.ok(have.has(ROWS[id].lead), `README's "${heading}" has the row **${ROWS[id].lead}**`);
  }
  for (const [file, m] of Object.entries(MODULES)) {
    if (m.exempt) {
      const e = EXEMPT[file];
      assert.ok(e, `${file}: a named exemption`);
      for (const s of e.says) assert.ok(section().includes(s), `README's section names ${s} (${e.why})`);
      for (const a of e.argv) assert.ok(code(file).includes(a), `${file} runs ${a}`);
      continue;
    }
    for (const id of m.rows) assert.ok(ROWS[id], `${file}: row ${id} is a README row`);
    if (!m.rows.length)
      assert.equal(m.execPath, true, `${file} has no README row, so its every spawn is our own file through Node`);
    if (m.execPath && !m.rows.length)
      assert.deepEqual(nonExecPathUses(read(file)), [], `${file}: every spawn launches process.execPath`);
  }
  // Every row discloses some module's work: a row no module needs is stale.
  assert.deepEqual(
    [...new Set(Object.values(MODULES).flatMap((m) => m.rows || []))].sort(),
    Object.keys(ROWS).sort(),
    "every README row is a module's",
  );
  // Not vacuous: the execPath rule sees a launch of another program.
  assert.deepEqual(nonExecPathUses('import { spawn } from "node:child_process";\nspawn(process.execPath, [x]);\n'), []);
  assert.equal(nonExecPathUses('import { spawnSync as s } from "node:child_process";\ns("git", ["x"]);\n').length, 1);
  assert.equal(
    nonExecPathUses('import { spawnSync } from "node:child_process";\nrun({ spawn: spawnSync });\n').length,
    1,
  );
  // The fetch callers, by name: the two README's "What it sends and fetches" covers.
  assert.deepEqual(SHIPPED_CODE.filter((f) => callsFetch(read(f))).sort(), [
    "scripts/convergence.mjs",
    "scripts/models.mjs",
  ]);
});

test("disclosure: each row's strings are in its module or the manifest data it reads, and every git subcommand and host CLI is named", () => {
  assert.ok(section() !== null, `README has "${SECTION}"`);
  for (const [id, row] of Object.entries(ROWS)) {
    const text = rowsOf(sub(row.sub)).get(row.lead);
    assert.ok(text, `README's "${row.sub}" has the row **${row.lead}**`);
    const says = row.says();
    assert.ok(says.length > 0, `row ${id} names something`);
    for (const [said, needle, source] of says) {
      assert.ok(text.includes(said), `README's row **${row.lead}** says ${said}`);
      assert.ok(String(source).includes(needle), `${said}: ${needle} is in the code or manifest data it comes from`);
    }
  }
  // Completeness: every git subcommand the shipped code runs is named in the git row.
  const gitRow = rowsOf(sub(RUNS)).get(ROWS.git.lead);
  const subcommands = new Set();
  for (const f of Object.keys(MODULES).concat(["scripts/worktree.mjs"]))
    for (const m of code(f).matchAll(
      /(?:spawn(?:Sync)?\(\s*"git",\s*|gitIn\([^,]+,\s*|\bgit\((?:[a-zA-Z]+,\s*)?)\[\s*"([a-z-]+)"/g,
    ))
      subcommands.add(m[1]);
  assert.ok(subcommands.size >= 6, `the git calls are read: ${[...subcommands].join(", ")}`);
  for (const s of subcommands) assert.ok(gitRow.includes(`\`git ${s}`), `the git row names git ${s}`);
  assert.ok(/never commits, pushes, pulls or fetches/.test(gitRow), "the git row says what git never does");
  for (const s of ["push", "pull", "fetch", "clone", "commit", "remote"])
    assert.ok(!subcommands.has(s), `no shipped code runs git ${s}`);
  // Every harness's host CLI and every http catalog's host is named.
  const hostsRow = rowsOf(sub(RUNS)).get(ROWS.hosts.lead);
  for (const b of hostCli()) assert.ok(hostsRow.includes(`\`${b}\``), `the agent CLIs row names ${b}`);
  assert.equal(hostCli().length, 2, "both harnesses register through their own CLI");
  const sends = sub(SENDS);
  for (const c of httpCatalogs()) assert.ok(sends.includes(new URL(c.url).host), `the sends section names ${c.url}`);
  assert.ok(sends.includes(new URL(conv.DEFAULT_REGISTRY).host), "the sends section names the default registry");
});

test("disclosure: the hooks start only git, from SessionStart, and fetch nothing", () => {
  const placeholder = harness.sourceHarness().hooks.root_placeholder;
  const entries = imports.hookEntries(ROOT, { placeholder });
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.length >= 5, `hooks read: ${entries.join(", ")}`);
  const reach = Object.fromEntries(
    entries.map((e) => [e, imports.closure(e, { root: ROOT }).filter((f) => f in MODULES)]),
  );
  // What a hook's imports can reach of the pinned modules: SessionStart's git
  // probe (worktree.mjs through diff-refs.mjs) and doctor's startup checks,
  // which start nothing within the SessionStart budget.
  const want = Object.fromEntries(entries.map((e) => [e, []]));
  want["hooks/session-start.mjs"] = ["scripts/diff-refs.mjs", "scripts/doctor.mjs"];
  assert.deepEqual(reach, want);
  for (const rows of Object.values(reach))
    for (const f of rows) assert.deepEqual(MODULES[f].rows, ["git"], `${f}, on a hook's path, runs git only`);
  const runs = sub(RUNS);
  assert.ok(runs && runs.includes("The SessionStart hook runs `git rev-parse`"), "README says what SessionStart runs");
  assert.ok(runs.includes("no other hook starts a program"), "README says the other hooks start nothing");
  assert.ok(section().includes("never by a hook"), "README says no request comes from a hook");
});

test("disclosure: the directory section and update_hint.by_channel.synced name the same ways to turn it off", () => {
  const dir = under(README, DIRECTORY);
  assert.ok(dir !== null, `README has "${DIRECTORY}"`);
  const synced = harness.sourceHarness().update_hint?.by_channel?.synced;
  assert.ok(synced?.welcome?.length, "the source manifest has update_hint.by_channel.synced");
  const bullets = (lines) => lines.filter((l) => /^- \*\*/.test(l));
  const welcome = bullets(synced.welcome);
  assert.ok(welcome.length >= 3, `the welcome lists its ways: ${JSON.stringify(welcome)}`);
  assert.deepEqual(bullets(dir.split("\n")), welcome, "README's ways to turn it off are the welcome's, line for line");
  // The markers each way rests on, in both, and in the one-line notice.
  for (const m of [
    "`/plugin` → **Installed**",
    "projectstore@synced",
    "enabledPlugins",
    ".claude/settings.local.json",
    ".claude/settings.json",
    "claude.ai",
  ]) {
    assert.ok(dir.includes(m), `README's directory section names ${m}`);
    assert.ok(synced.welcome.join("\n").includes(m), `the synced welcome names ${m}`);
  }
  for (const m of ["/plugin → Installed", '"projectstore@synced": false', "settings.local.json"])
    assert.ok(synced.line.includes(m), `the synced notice names ${m}`);
  // What the section says besides: no npx step, the bind command, updates from claude.ai.
  assert.ok(/no `npx` step is needed/.test(dir), "no npx step");
  assert.ok(
    dir.split("\n").some((l) => l.startsWith("/projectstore:bind ")),
    "the bind command, alone on its line",
  );
  assert.ok(dir.includes("Updates come from claude.ai"), "updates come from claude.ai");
  assert.ok(dir.includes("(#what-anthropics-directory-reports)") && sub(REPORTS) !== null, "it links the report");
});

test("disclosure: every bundled image the README shows uses Markdown syntax, and every relative link resolves in the packed tree", () => {
  const html = [...README.matchAll(/<(?:img|picture|source)\b[^>]*>/gi)].map((m) => m[0]);
  assert.deepEqual(html, [], "README shows no image through HTML");
  const shown = [...README.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const bundled = shown.filter((u) => !/^[a-z]+:/i.test(u));
  assert.ok(bundled.length >= 3, `README shows its bundled images: ${bundled.join(", ")}`);
  for (const u of bundled) assert.ok(PACKLIST.includes(posix.normalize(u)), `${u} is a packed file`);
  // A directory reader follows README's and docs/' links in the packed tree,
  // which has no packaging/, tests/ or site/: each relative link is a packed
  // file, or a GitHub URL.
  const docs = PACKLIST.filter((f) => f === "README.md" || /^docs\/[^/]+\.md$/.test(f));
  assert.ok(docs.length >= 5, `README and docs/ are read: ${docs.join(", ")}`);
  const dangling = [];
  for (const f of docs)
    for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      const u = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("#")) continue;
      const target = posix.normalize(posix.join(posix.dirname(f), u.replace(/#.*$/, "")));
      if (!PACKLIST.includes(target)) dangling.push(`${f}: ${u}`);
    }
  assert.deepEqual(dangling, [], "a relative link names a file the packed tree has");
});

test("disclosure: the listing fields and the icon", () => {
  const m = readJson(".claude-plugin/plugin.json");
  assert.equal(m.icon, "./docs/images/icon.png");
  assert.equal(m.documentationUrl, "https://github.com/SmartAndPoint/ProjectStore#readme");
  assert.equal(m.supportUrl, "https://github.com/SmartAndPoint/ProjectStore/issues");
  assert.equal(m.privacyPolicyUrl, "https://projectstore.dev/privacy/");
  assert.ok(!("termsOfServiceUrl" in m), "no terms of service: MIT, and no service");
  for (const k of ["documentationUrl", "supportUrl", "privacyPolicyUrl"])
    assert.match(m[k], /^https:\/\//, `${k} is an https:// URL`);
  // The fields belong in plugin.json only: a marketplace entry that sets one
  // draws an unknown-field warning from the validator.
  for (const p of readJson(".claude-plugin/marketplace.json").plugins)
    for (const k of ["icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"])
      assert.ok(!(k in p), `marketplace.json's ${p.name} carries no ${k}`);
  // The icon: a square PNG inside a shipped path, on the packlist.
  const rel = posix.normalize(m.icon);
  assert.ok(PACKLIST.includes(rel), `${rel} is on the packlist`);
  const png = readFileSync(join(ROOT, rel));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${rel} is a PNG`);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.ok(w === h && w >= 256, `${rel} is square and at least 256 px: ${w}×${h}`);
  // No command, hook or script names a bundled image or font, and no code
  // span or block does (the checklist holds both for a reviewer); README
  // shows them in Markdown image syntax only, and plugin.json names the icon.
  const bundled = PACKLIST.filter((f) => IMAGE.test(f) || FONT.test(f));
  assert.ok(bundled.includes(rel) && bundled.length >= 2, `bundled images: ${bundled.join(", ")}`);
  const names = (text) => bundled.filter((b) => text.includes(b) || text.includes(posix.basename(b)));
  const texts = PACKLIST.filter(
    (f) =>
      !IMAGE.test(f) &&
      !FONT.test(f) &&
      f !== ".claude-plugin/plugin.json" &&
      f !== "README.md" &&
      !f.startsWith("docs/"),
  );
  const named = texts.flatMap((f) => names(read(f)).map((b) => `${f}: ${b}`));
  assert.deepEqual(named, [], "no command, hook, script or other shipped file names a bundled image");
  const inCode = [];
  for (const f of PACKLIST.filter((x) => x === "README.md" || /^docs\/[^/]+\.md$/.test(x)))
    for (const { line, n, fenced } of markdownLines(read(f))) {
      const spans = fenced ? [line] : [...line.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)].map((x) => x[2]);
      for (const s of spans) for (const b of names(s)) inCode.push(`${f}:${n}: ${b}`);
    }
  assert.deepEqual(inCode, [], "no code span or block names a bundled image");
  assert.ok(existsSync(join(ROOT, rel)));
});

test("disclosure: one homepage — plugin.json, marketplace.json and package.json agree", () => {
  const want = "https://projectstore.dev";
  assert.equal(readJson(".claude-plugin/plugin.json").homepage, want, "plugin.json");
  assert.equal(readJson(".claude-plugin/marketplace.json").plugins[0].homepage, want, "marketplace.json");
  assert.equal(readJson("package.json").homepage, want, "package.json");
});

test("disclosure: the section's writes and the directory report, and no key-shaped value in what a reader sees", () => {
  const writes = sub(WRITES);
  assert.ok(writes !== null, `README has "${WRITES}"`);
  const cache = harness.cachePaths({ env: {}, home: "/h" });
  assert.equal(cache.root, "/h/.cache/projectstore");
  assert.ok(writes.includes("`~/.cache/projectstore/`") && writes.includes("`$XDG_CACHE_HOME/projectstore/`"));
  for (const [k, word] of [
    ["registry", "`registry.json`"],
    ["models", "`models/`"],
    ["welcomed", "`welcomed/`"],
    ["fetch", "`fetch/`"],
  ]) {
    const p = typeof cache[k] === "function" ? cache[k]("x") : cache[k];
    assert.ok(p && p.startsWith(cache.root), `cachePaths().${k} is under the cache root`);
    assert.ok(writes.includes(word), `the writes name ${word}`);
  }
  for (const w of [
    "`.projectstore/`",
    "`AGENTS.md`",
    "`CLAUDE.md`",
    "`.claude/settings.local.json`",
    "`.projectstore/sessions/`",
  ])
    assert.ok(writes.includes(w), `the writes name ${w}`);
  assert.ok(writes.includes("permission settings"), "it says it never changes permission settings");
  const reports = sub(REPORTS);
  assert.ok(reports !== null, `README has "${REPORTS}"`);
  assert.ok(
    reports.includes("not counted") && reports.includes("Claude collects"),
    "who collects, and what is not counted",
  );
  assert.ok(section().includes("no telemetry"), "no telemetry");
  // A key-shaped example value is a finding for the scan and a reviewer
  // alike, even in documentation.
  const KEY = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-|ghp_[A-Za-z0-9]{6,}|github_pat_|xox[bp]-|AKIA[0-9A-Z]{12,})/;
  const visible = ["README.md", "site/src/privacy.html", ...PACKLIST.filter((f) => /^docs\/[^/]+\.md$/.test(f))];
  assert.deepEqual(
    visible.filter((f) => existsSync(join(ROOT, f)) && KEY.test(read(f))),
    [],
    "no key-shaped value in README, docs/ or the privacy page",
  );
});

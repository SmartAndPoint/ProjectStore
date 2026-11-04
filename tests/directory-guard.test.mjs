// projectstore — PS-DIRECTORY: "A guard holds the tracked plugin tree to the
// directory's file rules, so CI fails before the portal would hold a version".
// packaging/directory-guard.mjs holds the set Anthropic's directory scans to
// the pre-submission checklist's file rules, and to our headroom rule.
//
// One temporary tree per row, each failing with that row's message and no
// other row's; a clean tree that passes; the real tree under both sets; the
// wiring into release:check and CI. The module is loaded per test, so a
// release without it fails each test that needs it, not the file. Every
// key-shaped string a test plants is built by concatenation, so this file
// holds none of its own (the credential row reads it under the repository
// set). Git runs in temporary repositories only, with the global and system
// config shut out.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/directory-guard.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = "packaging/directory-guard.mjs";
const load = () => import("../packaging/directory-guard.mjs");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "ps-directory-guard-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  HOME: TMP,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(dir, args, input) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, input });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A complete 1×1 PNG, a WOFF2 header, an SVG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(44, 1)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n';
// A complete PNG of `size` bytes: the signature and IHDR (33 bytes), one
// chunk that fills the rest, then IEND (12).
function pngOf(size) {
  const chunk = Buffer.alloc(size - 45);
  chunk.writeUInt32BE(size - 45 - 12, 0);
  chunk.write("IDAT", 4, "latin1");
  return Buffer.concat([PNG.subarray(0, 33), chunk, PNG.subarray(PNG.length - 12)]);
}
const words = (k) => Array.from({ length: k }, (_, i) => `word${i}`).join(" ");

// The clean plugin: every row passes.
const CLEAN = {
  "README.md": `# Fixture\n\n${words(45)}\n\n![The loop](docs/images/loop.svg)\n![A shot](docs/images/shot.png)\n`,
  LICENSE: "MIT License\n",
  ".claude-plugin/plugin.json": JSON.stringify({ name: "fixture", version: "1.0.0", license: "MIT" }) + "\n",
  "commands/hello.md": "---\ndescription: Say hello\n---\n\nSay hello to the user.\n",
  "hooks/hooks.json": JSON.stringify({ hooks: {} }) + "\n",
  "scripts/run.mjs": "export const run = () => 1;\n",
  "docs/guide.md": "# Guide\n\nRun `node scripts/run.mjs`.\n",
  "docs/images/shot.png": PNG,
  "docs/images/loop.svg": SVG,
  "docs/fonts/mono.woff2": WOFF2,
};

let trees = 0;
// A temporary tree from CLEAN, changed: a null value removes a file.
function tree(changes = {}) {
  const dir = join(TMP, `t${++trees}`);
  const files = { ...CLEAN, ...changes };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, list: Object.keys(files).filter((k) => files[k] !== null) };
}

// `kept` stands in for the guard's KEPT list.
async function packed(changes, { symlinks = {}, kept } = {}) {
  const g = await load();
  const { dir, list } = tree(changes);
  for (const [rel, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    symlinkSync(target, join(dir, rel));
    list.push(rel);
  }
  return g.check(g.trackedSet(dir, { set: "packed", packlist: list }), kept ? { kept } : undefined);
}

// The real packed tree, read once.
let real = null;
async function realPacked(options) {
  const g = await load();
  real ??= g.trackedSet(ROOT, { set: "packed" });
  return g.check(real, options);
}

// The row failed, alone (or with the rows named in `also`), and one of its
// findings matches: each names the file, the rule, the limit and the result.
function fails(report, id, pattern, also = []) {
  assert.deepEqual(report.failed, [id, ...also].sort(byRow(report)), `the rows that fail: ${report.failed.join(", ")}`);
  const row = report.rows.find((r) => r.id === id);
  const hit = row.findings.filter((f) => pattern.test(f));
  assert.ok(hit.length > 0, `${id}: no finding matches ${pattern}: ${JSON.stringify(row.findings)}`);
  for (const f of row.findings) {
    assert.ok(f.includes(row.rule), `${id}: the finding names the rule: ${f}`);
    assert.ok(f.includes(`limit: ${row.limit}`), `${id}: the finding names the limit: ${f}`);
    assert.ok(f.includes(row.result), `${id}: the finding names the result: ${f}`);
  }
  return row.findings;
}
const byRow = (report) => (a, b) => report.rows.findIndex((r) => r.id === a) - report.rows.findIndex((r) => r.id === b);

test("directory guard: the clean tree passes every row", async () => {
  const r = await packed({});
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(r.failed, []);
  assert.equal(r.files, Object.keys(CLEAN).length);
  for (const row of r.rows) assert.deepEqual(row.findings, [], row.id);
});

test("directory guard: the rows quote the checklist's results", async () => {
  const g = await load();
  const result = Object.fromEntries(g.ROWS.map((r) => [r.id, r.result]));
  for (const id of ["file-count", "file-size", "file-types"])
    assert.match(result[id], /^Held for a reviewer \(Files or downloads the validator couldn’t inspect\)$/, id);
  for (const id of ["readme-images", "bundled-references"]) assert.equal(result[id], "Held for a reviewer", id);
  for (const id of ["system-files", "readme", "license", "credentials", "front-matter"])
    assert.match(result[id], /^Blocks\b/, id);
  for (const id of ["names", "gitattributes", "repository-size"]) assert.match(result[id], /^Validation stops\b/, id);
  assert.match(result["regular-files"], /^Blocks where the plugin loads the entry, Warning elsewhere$/);
  assert.match(result["package-source"], /^Blocks with a launcher, Held for a reviewer with a package install/);
  assert.match(result.headroom, /^ours\b/);
  for (const id of [
    "credential-variables",
    "mod-policy-hooks",
    "mod-write-paths",
    "credential-beside-url",
    "credential-read-phrase",
  ])
    assert.match(result[id], /^ours\b/, id);
  assert.equal(g.CHECKLIST, "https://claude.com/docs/plugins/pre-submission-checklist");
});

test("directory guard: 513 files fail the 512-file row", async () => {
  const extra = {};
  for (let i = 0; Object.keys(CLEAN).length + Object.keys(extra).length < 513; i++)
    extra[`templates/t${i}.md`] = `${i}\n`;
  const r = await packed(extra);
  fails(r, "file-count", /^the tree: 513 files — /);
  // 512 is allowed.
  delete extra["templates/t0.md"];
  assert.equal((await packed(extra)).ok, true);
});

test("directory guard: a 262,144-byte .mjs fails the 256 KiB row, and one byte less does not", async () => {
  const big = "// " + "x".repeat(262144 - 4) + "\n";
  assert.equal(Buffer.byteLength(big), 262144);
  const r = await packed({ "scripts/big.mjs": big });
  // A shipped .mjs that size is over our headroom rule too.
  fails(r, "file-size", /^scripts\/big\.mjs: 262,144 bytes — /, ["headroom"]);
  assert.equal((await packed({ "docs/under.md": big.slice(1) })).ok, true, "262,143 bytes is under");
  // An image or a font is not held to it.
  const image = pngOf(262144 + 45);
  assert.deepEqual((await load()).sniff("docs/images/wide.png", image), {
    kind: "image",
    format: "PNG",
    complete: true,
  });
  assert.equal((await packed({ "docs/images/wide.png": image })).ok, true, "a 256 KiB image passes");
});

test("directory guard: a 5 MiB file, an image too, fails the repository-size row", async () => {
  const image = pngOf(5 * 1024 * 1024);
  assert.equal(image.length, 5242880);
  fails(
    await packed({ "docs/images/huge.png": image }),
    "repository-size",
    /^docs\/images\/huge\.png: 5,242,880 bytes — /,
  );
  assert.equal((await packed({ "docs/images/huge.png": pngOf(5242879) })).ok, true, "one byte under passes");
});

test("directory guard: an .ico, and an incomplete PNG, fail the file-type row", async () => {
  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0]);
  fails(await packed({ "docs/images/favicon.ico": ico }), "file-types", /^docs\/images\/favicon\.ico: a binary file /);
  fails(
    await packed({ "docs/images/cut.png": PNG.subarray(0, PNG.length - 12) }),
    "file-types",
    /^docs\/images\/cut\.png: an incomplete PNG image — /,
  );
});

test("directory guard: a .DS_Store, and a __MACOSX folder, fail the system-file row", async () => {
  const ds = Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0, 0, 0x10, 0]);
  // A .DS_Store is binary, so the file-type row holds it too.
  fails(await packed({ "docs/.DS_Store": ds }), "system-files", /^docs\/\.DS_Store: a macOS or Windows system file/, [
    "file-types",
  ]);
  fails(await packed({ "__MACOSX/notes.txt": "x\n" }), "system-files", /^__MACOSX: /);
});

test("directory guard: a .gitattributes with export-ignore, or a filter, fails its row", async () => {
  const findings = fails(
    await packed({ ".gitattributes": "# archive\ntests/ export-ignore\n*.bin filter=lfs diff=lfs merge=lfs -text\n" }),
    "gitattributes",
    /^\.gitattributes:2: sets export-ignore — /,
  );
  assert.ok(findings.some((f) => /^\.gitattributes:3: sets filter, which rewrites file contents/.test(f)));
  assert.equal((await packed({ ".gitattributes": "*.png -text\n" })).ok, true, "an unset attribute rewrites nothing");
});

test("directory guard: the four name rules — a colon, a trailing dot or space, a device name, case-only twins", async (t) => {
  await t.test("a colon", async () => fails(await packed({ "docs/a:b.md": "x\n" }), "names", /^docs\/a:b\.md: .*":"/));
  await t.test("a trailing dot", async () =>
    fails(await packed({ "docs/notes.": "x\n" }), "names", /^docs\/notes\.: .*ends in a dot/),
  );
  await t.test("a trailing space", async () =>
    fails(await packed({ "docs/draft /a.md": "x\n" }), "names", /^docs\/draft : .*ends in a space/),
  );
  await t.test("a device name", async () =>
    fails(await packed({ "docs/con.md": "x\n" }), "names", /^docs\/con\.md: .*a Windows device name/),
  );
  // A case-insensitive disk cannot hold both names, so the pair is two index
  // entries in a repository, read as the repository set.
  await t.test("case-only twins", async () => {
    const g = await load();
    const { dir } = tree();
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
    const sha = git(dir, ["hash-object", "-w", "--stdin"], "x\n");
    for (const p of ["docs/Notes.md", "docs/notes.md"])
      git(dir, ["update-index", "--add", "--cacheinfo", `100644,${sha},${p}`]);
    fails(
      g.check(g.trackedSet(dir, { set: "repository" })),
      "names",
      /^docs\/Notes\.md, docs\/notes\.md: names that differ only by capitalization/,
    );
  });
});

test("directory guard: a symlink under hooks/, a submodule and an LFS pointer fail the regular-file row", async () => {
  fails(
    await packed({}, { symlinks: { "hooks/run.mjs": "../scripts/run.mjs" } }),
    "regular-files",
    /^hooks\/run\.mjs: a symbolic link — /,
  );
  const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 12345\n";
  fails(await packed({ "assets/model.bin": lfs }), "regular-files", /^assets\/model\.bin: a Git LFS pointer file — /);
  // The repository set reads git's modes: 160000 a submodule, 120000 a link.
  const g = await load();
  const { dir } = tree();
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  const commit = git(dir, ["commit-tree", git(dir, ["write-tree"]), "-m", "x"]);
  git(dir, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/lib`]);
  const link = git(dir, ["hash-object", "-w", "--stdin"], "../scripts/run.mjs");
  git(dir, ["update-index", "--add", "--cacheinfo", `120000,${link},hooks/link.mjs`]);
  const findings = fails(
    g.check(g.trackedSet(dir, { set: "repository" })),
    "regular-files",
    /^vendor\/lib: a Git submodule — /,
  );
  assert.ok(
    findings.some((f) => f.startsWith("hooks/link.mjs: a symbolic link")),
    JSON.stringify(findings),
  );
});

test("directory guard: a README of 39 words outside code blocks fails, and no README fails", async () => {
  const fenced = "```sh\n" + words(200) + "\n```\n";
  const r = await packed({ "README.md": `${words(39)}\n\n${fenced}` });
  fails(r, "readme", /^README\.md: 39 words outside code blocks — /);
  assert.equal((await packed({ "README.md": `${words(40)}\n\n${fenced}` })).ok, true, "40 words is enough");
  fails(await packed({ "README.md": null }), "readme", /^the plugin folder: no README — /);
});

test("directory guard: no LICENSE and no license in plugin.json fails the license row", async () => {
  const unlicensed = JSON.stringify({ name: "fixture", version: "1.0.0" });
  fails(
    await packed({ LICENSE: null, ".claude-plugin/plugin.json": unlicensed }),
    "license",
    /^the plugin folder: no LICENSE file, and no license in \.claude-plugin\/plugin\.json — /,
  );
  assert.equal((await packed({ LICENSE: null })).ok, true, "plugin.json's license is enough");
  assert.equal((await packed({ ".claude-plugin/plugin.json": unlicensed })).ok, true, "a LICENSE file is enough");
});

test("directory guard: an .npmrc that sets registry=, or a uv.toml index, fails the package-source row", async () => {
  fails(
    await packed({ ".npmrc": "; mirror\nregistry=https://registry.example.com/\n" }),
    "package-source",
    /^\.npmrc:2: sets registry — /,
  );
  fails(
    await packed({ "tools/uv.toml": 'index-url = "https://pypi.example.com/simple"\n' }),
    "package-source",
    /^tools\/uv\.toml:1: sets index-url — /,
  );
  assert.equal((await packed({ ".npmrc": "fund=false\n" })).ok, true, "an .npmrc that sets no source passes");
});

test("directory guard: a command that names a bundled .png, or a path in backticks, fails the bundled-reference row", async () => {
  fails(
    await packed({
      "commands/hello.md": "---\ndescription: Say hello\n---\n\nShow docs/images/shot.png to the user.\n",
    }),
    "bundled-references",
    /^commands\/hello\.md:5: names docs\/images\/shot\.png from commands\/ — /,
  );
  fails(
    await packed({ "docs/guide.md": "# Guide\n\nThe font is `mono.woff2`.\n" }),
    "bundled-references",
    /^docs\/guide\.md:3: writes docs\/fonts\/mono\.woff2 in backticks — /,
  );
  fails(
    await packed({ "docs/guide.md": "# Guide\n\n```\ncat docs/images/loop.svg\n```\n" }),
    "bundled-references",
    /^docs\/guide\.md:4: writes docs\/images\/loop\.svg in a code block — /,
  );
});

test("directory guard: a README that shows a bundled image through HTML <img> or srcset fails the README-image row", async () => {
  const readme = (html) => `# Fixture\n\n${words(45)}\n\n${html}\n`;
  fails(
    await packed({ "README.md": readme('<img src="docs/images/shot.png" alt="A shot" width="400">') }),
    "readme-images",
    /^README\.md:5: HTML <img> shows docs\/images\/shot\.png — /,
  );
  fails(
    await packed({
      "README.md": readme(
        '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/images/loop.svg 2x">\n</picture>',
      ),
    }),
    "readme-images",
    /^README\.md:6: HTML <source> shows docs\/images\/loop\.svg — /,
  );
  assert.equal(
    (await packed({ "README.md": readme('<img src="https://example.com/badge.svg">') })).ok,
    true,
    "a remote image is not bundled",
  );
  // A fence shows no image, but writes the bundled path in a code block.
  fails(
    await packed({ "README.md": readme('```html\n<img src="docs/images/shot.png">\n```') }),
    "bundled-references",
    /^README\.md:6: writes docs\/images\/shot\.png in a code block — /,
  );
});

test("directory guard: an sk- string, a GitHub token or a private key block fails the credential row, by file and line, never by value", async () => {
  const sk = "sk" + "-" + "ant-api03-abc123def456ghi789";
  const ghp = "gh" + "p_" + "A1b2C3d4E5f6";
  const ghs = "gh" + "s_" + "A1b2C3d4E5f6";
  const pat = "github" + "_pat_" + "11ABCDEFG0";
  const pem = "-".repeat(5) + "BEGIN OPENSSH " + "PRIVATE KEY" + "-".repeat(5);
  const body = `# Setup\n\nexport SERVICE_API_KEY=${sk}\n\nGITHUB_TOKEN=${ghp}\nGH=${pat}\nCI=${ghs}\n${pem}\n`;
  const findings = fails(
    await packed({ "docs/setup.md": body }),
    "credentials",
    /^docs\/setup\.md:3: an sk- key \(Anthropic's prefix\) — /,
  );
  assert.deepEqual(
    findings.map((f) => f.slice(0, f.indexOf(" — "))),
    [
      "docs/setup.md:3: an sk- key (Anthropic's prefix)",
      "docs/setup.md:5: a GitHub token (ghp_, gho_, ghu_, ghs_ or ghr_)",
      "docs/setup.md:6: a github_pat_ token (GitHub's prefix)",
      "docs/setup.md:7: a GitHub token (ghp_, gho_, ghu_, ghs_ or ghr_)",
      "docs/setup.md:8: a private key block",
    ],
  );
  for (const v of [sk, ghp, ghs, pat, pem])
    assert.ok(!JSON.stringify(findings).includes(v), "no finding carries the value");
  // The renamed fixtures' values are no key's shape.
  for (const v of ["test-anthropic-key", "test-github-token", "task-list", "disk-0", 'hreflang="sk-SK"', "sk-spinner"])
    assert.equal((await packed({ "docs/setup.md": `KEY=${v}\n` })).ok, true, v);
});

// Ours: no shipped file names the variables 0.30.6's model menu read a key
// and its base from, or the catalog fields that named them, comments and
// prose included (the 0.30.7 story, PS-DIRECTORY). Each name fails that row
// alone, by file and line; a file that does not ship may name them.
test("directory guard: a shipped file naming a credential variable or a catalog's key field fails the credential-variable row alone, by file and line", async () => {
  const g = await load();
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "key_env", "base_env", "key_header"]) {
    const findings = fails(
      await packed({
        "scripts/run.mjs": `// reads ${name}\nexport const run = () => 1;\n`,
        "docs/guide.md": `# Guide\n\nSet \`${name}\` first.\n`,
      }),
      "credential-variables",
      new RegExp(`^docs/guide\\.md:3: names ${name} — .*our rule, stricter than the checklist`),
    );
    assert.deepEqual(
      findings.map((f) => f.slice(0, f.indexOf(" — "))),
      [`docs/guide.md:3: names ${name}`, `scripts/run.mjs:1: names ${name}`],
    );
  }
  // A longer name, another variable and a value that is no key pass.
  for (const v of ["monkey_env", "key_envelope", "ANTHROPIC_API_KEYS", "SERVICE_API_KEY", "test-anthropic-key"])
    assert.equal((await packed({ "docs/setup.md": `${v}\n` })).ok, true, v);
  // Under the repository set only what ships is held to it: a test that sets
  // the variable passes off the packlist and fails on it.
  const { dir, list } = tree({ "tests/models.test.mjs": 'const env = { ANTHROPIC_API_KEY: "test-anthropic-key" };\n' });
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  const shipped = list.filter((f) => !f.startsWith("tests/"));
  assert.equal(g.check(g.trackedSet(dir, { set: "repository", packlist: shipped })).ok, true);
  fails(
    g.check(g.trackedSet(dir, { set: "repository", packlist: list })),
    "credential-variables",
    /^tests\/models\.test\.mjs:1: names ANTHROPIC_API_KEY — /,
  );
});

// Ours: the patterns behind the portal's policy holds on the 0.30.7
// `directory` tree (PS-DIRECTORY: "The portal's policy holds on the directory
// branch are fixed in 0.30.8 or kept with a reason, and CI fails on their
// patterns"). A hooks module as hooks/hooks.json loads it: a hook of another
// kind and a policy hook, both taking ($, e, next); a helper that takes `$`;
// e and next in a comment. A plant goes in after the hooks.
const MODULE_HOOKS = JSON.stringify({ modules: ["./mod.tsx"], hooks: {} }) + "\n";
const hooksModule = ({ plant = "", head = "async ($, e, next) =>", body = "" } = {}) =>
  [
    "import { atom } from 'claude-code'",
    "",
    "// The hooks below pass e on through next.",
    "async function note($, b) {",
    "  return b",
    "}",
    "",
    "export const register = on => {",
    "  on('turn.start', async ($, e, next) => {",
    "    return next(e)",
    "  })",
    "",
    `  on('agent.spawn', ${head} {`,
    ...(body ? [body] : []),
    "    const ran = await next(e)",
    "    return ran",
    "  })",
    "}",
    "",
    plant,
    "",
  ].join("\n");
const inModule = (src) => ({ "hooks/hooks.json": MODULE_HOOKS, "hooks/mod.tsx": src });
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("directory guard: a hooks module whose policy hook's event or next name is bound elsewhere fails the mod-policy-hooks row, by file and line", async () => {
  // These pass: another hook's own ($, e, next), `$` as a helper's
  // parameter, and e and next inside a comment.
  assert.deepEqual((await packed(inModule(hooksModule()))).failed, []);
  // Nor are these bindings: a call in a ternary before an object or an arrow,
  // a JSX attribute and a class field.
  for (const plant of [
    "const shown = ok ? render(e) : { a: 1 }",
    "const pick = c ? f(e) : x => 1",
    'const el = <Text next="x" />',
    "class Box {\n  next = 1\n}",
  ])
    assert.deepEqual((await packed(inModule(hooksModule({ plant })))).failed, [], plant);
  // Each fails the row alone: [the module's shape, text on the line the
  // finding names, what the finding says].
  const cases = [
    [
      { plant: "const next = 1" },
      "const next",
      /declares next, the name the agent\.spawn hook \(line 13\) gives its next/,
    ],
    [{ plant: "for (const e of []) note(null, e)" }, "for (const e", /declares e, .* gives its event/],
    [
      { plant: "function f($, b, next) {\n  return b\n}" },
      "function f",
      /takes next as a parameter, .* gives its next/,
    ],
    [{ plant: "Promise.resolve(1).then(next => next)" }, ".then(next", /takes next as a parameter/],
    [{ plant: "const { e } = { e: 1 }" }, "const { e }", /destructures into e, .* gives its event/],
    [{ plant: "try {\n  note(null, 1)\n} catch (e) {\n  note(null, e)\n}" }, "catch (e)", /takes e as a parameter/],
    [{ head: "async function ($, e, next)", body: "    note($, arguments.length)" }, "arguments", /uses arguments/],
    [
      { head: "async ({ ...x }, e, next) =>" },
      "on('agent.spawn'",
      /the agent\.spawn hook's parameter "\{ \.\.\.x \}" is not a plain name/,
    ],
  ];
  for (const [shape, needle, pattern] of cases) {
    const src = hooksModule(shape);
    const at = lineOf(src, needle);
    assert.ok(at > 0, `${needle} is in the module`);
    fails(
      await packed(inModule(src)),
      "mod-policy-hooks",
      new RegExp(`^hooks/mod\\.tsx:${at}: ${pattern.source}.* — `),
    );
  }
  // A module hooks/hooks.json does not list is not read.
  const unlisted = { "hooks/mod.tsx": hooksModule({ plant: "const next = 1" }) };
  assert.equal((await packed(unlisted)).ok, true, "hooks.json lists no module");
  // The real tree passes the row.
  assert.equal((await realPacked()).rows.find((r) => r.id === "mod-policy-hooks").ok, true);
});

// The row passes only by reading a hook: the band's own agent.spawn hook is
// found with its three plain parameters, and a policy event registered in a
// shape the guard cannot read fails the row instead of passing it unseen.
test("directory guard: the mod-policy-hooks row reads the band's agent.spawn hook, and a policy hook it cannot read fails the row", async () => {
  const g = await load();
  const band = read("hooks/band.tsx");
  const spawn = g.hooksOf(band, g.codeOnly(band)).filter((h) => h.event === "agent.spawn");
  assert.equal(spawn.length, 1, "one agent.spawn hook");
  assert.deepEqual(spawn[0].params, ["$", "e", "next"]);
  const src = hooksModule({ plant: "export const later = on => on('agent.spawn', noted)" });
  fails(
    await packed(inModule(src)),
    "mod-policy-hooks",
    new RegExp(`^hooks/mod\\.tsx:${lineOf(src, "noted")}: names agent\\.spawn where the guard reads no hook`),
  );
});

test("directory guard: a hooks module's fs.write whose path is not fixed text fails the mod-write-paths row, by file and line; the heartbeat's fixed path passes", async () => {
  const writing = (path) =>
    hooksModule({
      plant: `async function beat($, root, sid, name, dir, path) {\n  await $.fs.write(${path}, '{}')\n}`,
    });
  for (const [path, why] of [
    ["`${root}/${SESSIONS}/${name}`", /the folder "\$\{SESSIONS\}" is not literal text/],
    ["`${root}/.projectstore/${dir}/.band-${sid}.json`", /the folder "\$\{dir\}" is not literal text/],
    [
      "`${root}/.projectstore/state/sessions/${name}`",
      /the file name "\$\{name\}" holds a hole that is not the session id/,
    ],
    ["`.projectstore/state/sessions/.band-${sid}.json`", /it does not start with one \$\{…\}\/ for the project root/],
    ["path", /fs\.write's path path is not a template of fixed text/],
  ]) {
    const src = writing(path);
    fails(
      await packed(inModule(src)),
      "mod-write-paths",
      new RegExp(`^hooks/mod\\.tsx:${lineOf(src, "$.fs.write(")}: .*${why.source} — `),
    );
  }
  const fixed = writing("`${root}/.projectstore/state/sessions/.band-${sid}.json`");
  assert.deepEqual((await packed(inModule(fixed))).failed, [], "the heartbeat's own path");
  assert.equal((await realPacked()).rows.find((r) => r.id === "mod-write-paths").ok, true, "the real tree");
});

test("directory guard: credential-beside-url — a credential-shaped name beside a URL in a shipped .mjs or .tsx, or a $PWD beside one in Markdown, fails by file and line; KEPT has the band and fetch-shell, each with its reason, and a kept file the row no longer matches fails", async () => {
  const g = await load();
  const withUrl = "// See https://example.com for more.\nconst key = 1;\nexport const run = () => key;\n";
  fails(
    await packed({ "scripts/run.mjs": withUrl }),
    "credential-beside-url",
    /^scripts\/run\.mjs:2: names key, and line 1 holds https:\/\/example\.com — /,
  );
  fails(
    await packed({ "hooks/view.tsx": "const pin = 1\n// <svg xmlns='http://www.w3.org/2000/svg'/>\n" }),
    "credential-beside-url",
    /^hooks\/view\.tsx:1: names pin, and line 2 holds http:\/\/www\.w3\.org\/2000\/svg — /,
  );
  const md = (v) => `# Guide\n\nSee https://example.com for more.\n\n\`\`\`\nnpx tool --project "${v}"\n\`\`\`\n`;
  fails(
    await packed({ "docs/guide.md": md("$PWD") }),
    "credential-beside-url",
    /^docs\/guide\.md:6: holds \$PWD, and line 3 holds https:\/\/example\.com — /,
  );
  fails(
    await packed({ "docs/guide.md": md("${GITHUB_TOKEN}") }),
    "credential-beside-url",
    /^docs\/guide\.md:6: holds \$\{GITHUB_TOKEN\}, and line 3 /,
  );
  // The same words with no URL pass, and so does $XDG_CACHE_HOME beside one;
  // a .json is not read.
  for (const [what, changes] of [
    ["a key with no URL", { "scripts/run.mjs": "const key = 1;\nexport const run = () => key;\n" }],
    ["$PWD with no URL", { "docs/guide.md": '# Guide\n\nnpx tool --project "$PWD"\n' }],
    ["$XDG_CACHE_HOME beside a URL", { "docs/guide.md": md("$XDG_CACHE_HOME") }],
    ["a .json", { "harnesses/x.json": '{ "key": "https://example.com", "token": 1 }\n' }],
  ])
    assert.equal((await packed(changes)).ok, true, what);
  // KEPT: exactly the two files a reviewer confirms, each with its reason.
  assert.deepEqual(Object.keys(g.KEPT).sort(), ["hooks/band.tsx", "scripts/fetch-shell.mjs"]);
  for (const [f, why] of Object.entries(g.KEPT)) assert.ok(typeof why === "string" && why.length > 40, f);
  // A kept file passes while the row matches it, and fails once it does not.
  const kept = { "scripts/run.mjs": "a reason a reviewer confirms" };
  const held = await packed({ "scripts/run.mjs": withUrl }, { kept });
  assert.equal(held.ok, true);
  assert.deepEqual(held.rows.find((r) => r.id === "credential-beside-url").kept, [
    "scripts/run.mjs: a reason a reviewer confirms",
  ]);
  fails(
    await packed({}, { kept }),
    "credential-beside-url",
    /^scripts\/run\.mjs: is kept \(a reason a reviewer confirms\), but the row no longer matches it/,
  );
  // On the real tree the row passes, and of its .mjs and .tsx files it
  // matches only the kept ones.
  const r = await realPacked();
  assert.equal(r.rows.find((x) => x.id === "credential-beside-url").ok, true);
  const bare = (await realPacked({ kept: {} })).rows.find((x) => x.id === "credential-beside-url");
  assert.deepEqual([...new Set(bare.findings.map((f) => f.slice(0, f.indexOf(":"))))].sort(), Object.keys(g.KEPT));
});

test('directory guard: credential-read-phrase — "vault" then "read" in a command, or in a hook file hooks/hooks.json names, fails by file and line; "the vault\'s README excerpt" passes', async () => {
  const command = (s) => `---\ndescription: Review\n---\n\n${s}\n`;
  fails(
    await packed({ "commands/hello.md": command("<vault README excerpt>") }),
    "credential-read-phrase",
    /^commands\/hello\.md:5: holds "vault READ" — /,
  );
  assert.equal((await packed({ "commands/hello.md": command("<the vault's README excerpt>") })).ok, true);
  // A hook file is one hooks/hooks.json runs: the same words in a script it
  // does not name pass.
  const script = "// renders with zero vault reads\nexport const run = () => 1;\n";
  const hooks =
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs"' }] }],
      },
    }) + "\n";
  fails(
    await packed({ "hooks/hooks.json": hooks, "scripts/run.mjs": script }),
    "credential-read-phrase",
    /^scripts\/run\.mjs:1: holds "vault read" — /,
  );
  assert.equal((await packed({ "scripts/run.mjs": script })).ok, true, "a script no hook runs");
  assert.equal((await realPacked()).rows.find((r) => r.id === "credential-read-phrase").ok, true, "the real tree");
});

// Three agents shipped in 0.30.5 with a plain description holding ": "
// ("Suggest-only: every…"): Claude Code loads them, a YAML parser does not,
// and the checklist blocks front matter that doesn't parse.
test("directory guard: front matter a parser refuses, or a description that is not text, fails the front-matter row, by file and line", async () => {
  fails(
    await packed({ "agents/planner.md": "---\nname: planner\ndescription: Read-only: it plans\n---\n\nPlan.\n" }),
    "front-matter",
    /^agents\/planner\.md:3: description's plain value holds ": ", which YAML reads as a second key/,
  );
  const cases = [
    [
      "commands/hello.md",
      "---\ndescription:\n  - Say\n  - hello\n---\n\nHi.\n",
      /^commands\/hello\.md:3: description is a list or a mapping/,
    ],
    [
      "commands/hello.md",
      "---\ndescription: [Say, hello]\n---\n",
      /^commands\/hello\.md:2: description is a list or a mapping/,
    ],
    [
      "skills/hi/SKILL.md",
      '---\nname: hi\ndescription: "Say hello\n---\n',
      /^skills\/hi\/SKILL\.md:3: description's double-quoted value does not close/,
    ],
    [
      "commands/hello.md",
      "---\ndescription: Say hello\ndescription: Again\n---\n",
      /^commands\/hello\.md:3: description is set twice/,
    ],
    ["commands/hello.md", "---\ndescription: 42\n---\n", /:2: description is a number, a boolean or null/],
    ["commands/hello.md", "---\ndescription:\n---\n", /:2: description has no value/],
    ["commands/hello.md", "---\ndescription: @here\n---\n", /:2: description's value starts with "@"/],
    [
      "commands/hello.md",
      "---\ndescription: Say hello\n  to the user\n---\n",
      /:3: an indented line under a key whose value is already on its line/,
    ],
    [
      "agents/planner.md",
      '---\nname: planner\ndescription: "Matches \\d+"\n---\n',
      /:3: description's double-quoted value does not close on its line, or holds an escape YAML does not know/,
    ],
    ["commands/hello.md", "---\ndescription:\nname: x\ntools:\n  - Read\n---\n", /:2: description has no value/],
    ["commands/hello.md", '---\ndescription: a\n"description": b\n---\n', /:3: description is set twice/],
    [
      "commands/hello.md",
      "---\ndescription: Hi\ntools: [Read, Grep\n---\n",
      /:3: tools's flow list does not close on its line/,
    ],
    [
      "commands/hello.md",
      "---\ndescription: Hi\nmetadata:\n  foo: bar: baz\n---\n",
      /:4: foo's plain value holds ": "/,
    ],
    [
      "commands/hello.md",
      "---\ndescription: >\n\tSay hello\n---\n",
      /:3: a tab in the indentation, which YAML refuses/,
    ],
    ["commands/hello.md", "---\ndescription:\n  say: hello\n---\n", /:3: description is a list or a mapping, not text/],
    ["commands/hello.md", "---\ndescription: true\n---\n", /:2: description is a number, a boolean or null/],
    ["commands/hello.md", "---\ndescription: 0x1F\n---\n", /:2: description is a number, a boolean or null/],
    [
      "commands/nested/hello.md",
      "---\ndescription: Read-only: it says hello\n---\n",
      /^commands\/nested\/hello\.md:2: /,
    ],
  ];
  for (const [file, body, pattern] of cases) fails(await packed({ [file]: body }), "front-matter", pattern);
});

test("directory guard: a quoted or folded description, a known escape, a nested mapping, an apostrophe, no front matter, and a file outside agents/, commands/ and skills/ pass the front-matter row", async () => {
  const r = await packed({
    "agents/planner.md": '---\nname: planner\ndescription: "Read-only: it plans"\ntools: Read, Grep\n---\n\nPlan.\n',
    "agents/critic.md": "---\nname: critic\ndescription: 'It''s read-only: it reports'\n---\n",
    "commands/hello.md": "---\ndescription: >-\n  Say hello: once.\n  Then stop.\n---\n",
    "commands/plain.md": "No front matter at all.\n",
    "skills/hi/SKILL.md": "---\nname: hi\ndescription: It's a greeting, nothing more # a comment\n---\n",
    "docs/notes.md": "---\ndescription: free: form\n---\n",
    "commands/escape.md": '---\ndescription: "Line one\\nline two: \\"quoted\\""\n---\n',
    "commands/block.md":
      "---\ndescription: > # a comment\n  Say hello: once.\nmetadata:\n  foo: bar\n  list:\n    - a\n---\n",
    "commands/next.md": '---\ndescription:\n  "Say hello: once"\n---\n',
  });
  assert.deepEqual(r.failed, []);
});

test("directory guard: the headroom rule fails a shipped .mjs over 204,800 bytes, the 0.30.5 installer's size included, with no exemption", async () => {
  const g = await load();
  assert.equal(g.LIMITS.headroom, 204800);
  assert.ok(!("HEADROOM_EXEMPT" in g), "no exemption: the installer was split first");
  const of = (size) => "// " + "x".repeat(size - 4) + "\n";
  // 0.30.5's scripts/install-harness.mjs was 260,835 bytes: under the
  // directory's 256 KiB, over ours.
  const r = await packed({ "scripts/install-harness.mjs": of(260835) });
  fails(
    r,
    "headroom",
    /^scripts\/install-harness\.mjs: 260,835 bytes, 56,035 over — .*our rule, stricter than the checklist/,
  );
  assert.equal(r.headroom.headroom.next.file, "scripts/run.mjs", "the report names the next file in line");
  const at = await packed({ "scripts/install-harness.mjs": of(204800) });
  assert.equal(at.ok, true, "204,800 bytes is at the limit, not over it");
  assert.deepEqual(at.headroom.headroom.next, { file: "scripts/install-harness.mjs", bytes: 204800, left: 0 });
  // Only what ships: in the repository set a test's own .mjs is held to the
  // directory's 256 KiB alone.
  const { dir } = tree({ "tests/big.test.mjs": of(230000) });
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  assert.equal(g.check(g.trackedSet(dir, { set: "repository" })).ok, true);
});

// The directory tracks the packed tree (the `directory` branch, the plan gate
// of the submission story, 2026-10-15), so the packed set must pass every row.
// The repository set must pass every row but the file count: the repository
// (tests, site, packaging) is near 512 files and may pass it, which matters
// only if the maintainer ever has the directory track `main` — then
// `npm run directory:check -- --set repository` is the check to run.
test("directory guard: the real tree passes under the packed set, and under the repository set but for its file count, with each limit's headroom", async () => {
  const g = await load();
  const packlist = JSON.parse(read("tests/fixtures/packlist.json"));
  for (const set of g.SETS) {
    const entries = g.trackedSet(ROOT, { set });
    const r = g.check(entries);
    const waived = set === "repository" ? ["file-count"] : [];
    assert.deepEqual(
      r.failed.filter((id) => !waived.includes(id)),
      [],
      `${set}: ${JSON.stringify(r.rows.filter((x) => !x.ok))}`,
    );
    if (set === "packed")
      assert.deepEqual(
        entries.map((e) => e.path),
        [...packlist].sort(),
      );
    else assert.ok(entries.length > packlist.length, "the repository set is the larger");
    // The next .mjs in line is the largest shipped one, under the limit.
    const largest = packlist
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => [f, statSync(join(ROOT, f)).size])
      .sort((a, b) => b[1] - a[1])[0];
    assert.deepEqual(r.headroom.headroom.next, { file: largest[0], bytes: largest[1], left: 204800 - largest[1] });
    for (const k of ["file-count", "file-size", "readme", "repository-size"])
      assert.ok(r.headroom[k], `${set}: ${k}'s headroom`);
    assert.ok(r.headroom["file-size"].left > 0, `${set}: file-size headroom`);
    if (set === "packed") assert.ok(r.headroom["file-count"].left >= 0, "packed: file-count headroom");
  }
});

test("directory guard: its own source and this test's match none of its credential shapes", async () => {
  const g = await load();
  for (const f of [GUARD, "tests/directory-guard.test.mjs"]) assert.deepEqual(g.credentialLines(read(f)), [], f);
});

test("directory guard: the CLI prints JSON and exits 1 on a failure, 0 on the real tree", async () => {
  const g = await load();
  const out = [];
  const { dir } = tree({ "docs/.DS_Store": "x\n" });
  mkdirSync(join(dir, "tests", "fixtures"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "fixtures", "packlist.json"),
    JSON.stringify([...Object.keys(CLEAN), "docs/.DS_Store"]),
  );
  assert.equal(g.main([], { root: dir, stdout: { write: (s) => out.push(s) } }), 1);
  const r = JSON.parse(out.join(""));
  assert.equal(r.ok, false);
  assert.equal(r.set, "packed");
  assert.deepEqual(r.failed, ["system-files"]);
  out.length = 0;
  assert.equal(g.main(["--set", "bogus"], { root: dir, stdout: { write: (s) => out.push(s) } }), 1);
  assert.match(JSON.parse(out.join("")).error, /--set bogus/);
  const real = spawnSync(process.execPath, [join(ROOT, GUARD)], { encoding: "utf8", cwd: ROOT });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.equal(JSON.parse(real.stdout).ok, true);
});

test("directory guard: release:check runs it after the version guard, and CI's test job runs it", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["directory:check"], `node ${GUARD}`);
  assert.ok(scripts["release:check"].includes("npm run guard && npm run directory:check &&"), scripts["release:check"]);
  const yml = read(".github/workflows/test.yml");
  const job = yml.slice(yml.indexOf("\n  test:"), yml.indexOf("\n  lint:"));
  assert.ok(job.includes(`run: node ${GUARD}\n`), "the test job runs the guard");
  assert.ok(job.indexOf(`node ${GUARD}`) > job.indexOf("node scripts/version-guard.mjs"), "after the version guard");
  assert.ok(
    read("packaging/README.md").includes(`| \`node ${GUARD} [--set packed\\|repository]\` |`),
    "packaging/README.md's guard table",
  );
});

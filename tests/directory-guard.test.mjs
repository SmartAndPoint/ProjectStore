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

async function packed(changes, { symlinks = {} } = {}) {
  const g = await load();
  const { dir, list } = tree(changes);
  for (const [rel, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    symlinkSync(target, join(dir, rel));
    list.push(rel);
  }
  return g.check(g.trackedSet(dir, { set: "packed", packlist: list }));
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
  for (const id of ["system-files", "readme", "license", "credentials"]) assert.match(result[id], /^Blocks\b/, id);
  for (const id of ["names", "gitattributes", "repository-size"]) assert.match(result[id], /^Validation stops\b/, id);
  assert.match(result["regular-files"], /^Blocks where the plugin loads the entry, Warning elsewhere$/);
  assert.match(result["package-source"], /^Blocks with a launcher, Held for a reviewer with a package install/);
  assert.match(result.headroom, /^ours\b/);
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
  const body = `# Setup\n\nexport ANTHROPIC_API_KEY=${sk}\n\nGITHUB_TOKEN=${ghp}\nGH=${pat}\nCI=${ghs}\n${pem}\n`;
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

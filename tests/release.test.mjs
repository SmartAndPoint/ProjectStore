// projectstore — release tests (PS-HARNESS: "A release tag shows on every
// surface: the workflow makes the GitHub Release from committed notes, and a
// check reads every surface after the publish").
//
// Three parts. The workflows, read as text — the test job runs no `npm ci`, so
// there is no YAML parser, and tests/shells.test.mjs ("shells AC 4") already
// reads release.yml this way: the GitHub Release job, the directory job, the
// site's deploy after a release, and the surfaces workflow. Then
// packaging/release-surfaces.mjs, every judgement through an injected fetch:
// tests/fixtures/hermetic.mjs pins the global fetch to loopback, and nothing
// here may read the network. Then packaging/directory-branch.mjs (PS-DIRECTORY:
// "The maintainer submits ProjectStore through the developer portal…"),
// against bare repositories in a temporary directory, with git's global and
// system config shut out.
//
//   node --test tests/release.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  main,
  checkSurfaces,
  readSurfaces,
  urls,
  packagesFor,
  repoSlug,
  PAGES_FIX,
} from "../packaging/release-surfaces.mjs";
import { SHELLS, corePackage } from "../packaging/shells.mjs";
import {
  moveDirectoryBranch,
  main as directoryMain,
  pushArgs,
  remoteFor,
  redact,
  BRANCH,
} from "../packaging/directory-branch.mjs";
import { PACKLIST } from "../scripts/version-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

// The jobs of a workflow, by name: everything after `jobs:`, cut at each
// two-space-indented key. The workflow-level keys above it never count.
function jobs(yml) {
  const body = yml.slice(yml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out = {};
  const parts = body.split(/^ {2}([\w-]+):$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}
const code = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

// ─── The workflows ──────────────────────────────────────────────────────

test("release AC: release.yml makes the GitHub Release after every publish, from the notes, with one of the two write scopes", () => {
  const yml = workflow("release.yml");
  const j = jobs(yml);
  assert.deepEqual(Object.keys(j), ["core", "shells", "github-release", "directory"]);
  const gr = j["github-release"];
  assert.ok(gr.includes("    needs: [core, shells]\n"), "after both publish jobs");
  assert.ok(
    gr.includes(
      "    if: ${{ !cancelled() && needs.core.result == 'success' && (needs.shells.result == 'success' || needs.shells.result == 'skipped') }}\n",
    ),
    "runs when the shells' matrix passed or was skipped, never after a failed publish",
  );
  assert.match(gr, /permissions:\n\s+contents: write #/, "contents: write, on this job");
  assert.ok(gr.includes('NOTES="packaging/release-notes/${TAG}.md"'), "the committed notes are the source");
  assert.ok(gr.includes('gh api -i "repos/${GITHUB_REPOSITORY}/releases/tags/${TAG}"'), "the release is read first");
  assert.match(gr, /200\) echo "[^"]*skipping"; exit 0 ;;/, "an existing release is a step-level skip");
  assert.ok(gr.includes("404) ;;"), "a missing release is created");
  assert.match(gr, /\*\) echo "::error::[^"]*"; exit 1 ;;/, "any other answer fails");
  assert.ok(gr.includes("DIST_TAG: ${{ needs.core.outputs.disttag }}"), "the dist-tag is the core job's");
  assert.ok(
    gr.includes('gh release create "$TAG" --verify-tag --latest --title "$TITLE" --notes-file'),
    "a release is Latest, explicitly",
  );
  assert.ok(
    gr.includes('gh release create "$TAG" --verify-tag --prerelease --latest=false --title "$TITLE" --notes-file'),
    "a prerelease is never Latest",
  );
  assert.match(
    gr,
    /\*\) echo "::error::no dist-tag from the core job.*"; exit 1 ;;/,
    "no dist-tag is no release, never a guess",
  );
  assert.ok(gr.includes("tr -d '\\r'"), "a CRLF notes file makes a release without carriage returns");
  for (const [name, block] of Object.entries(j))
    if (!["github-release", "directory"].includes(name))
      assert.ok(!/: write\b/.test(code(block)), `${name} gains no write scope`);
  const top = yml.slice(0, yml.indexOf("\njobs:\n"));
  assert.match(top, /permissions:\n {2}contents: read\n {2}id-token: write/, "the workflow-level scopes are unchanged");
});

test("release AC: release.yml moves the directory branch after the core publish, for a stable release only, with the second write scope", () => {
  const yml = workflow("release.yml");
  const j = jobs(yml);
  const d = j.directory;
  assert.ok(d, "a directory job");
  assert.ok(d.includes("    needs: core\n"), "after the core publish, and after nothing else");
  assert.ok(
    d.includes("    if: ${{ needs.core.result == 'success' && needs.core.outputs.disttag == 'latest' }}\n"),
    "only when the core published, and only a stable release: a candidate never reaches the directory's users",
  );
  assert.match(
    d,
    /\n {4}permissions:\n {6}contents: write #[^\n]*\n {4}steps:/,
    "contents: write, and no other scope (a job's block replaces the workflow's)",
  );
  assert.deepEqual(
    Object.entries(j)
      .filter(([, b]) => /: write\b/.test(code(b)))
      .map(([n]) => n),
    ["github-release", "directory"],
    "two jobs hold a write scope, these two",
  );
  assert.match(
    j["github-release"],
    /contents: write # gh release create: one of the two contents: write in this workflow/,
  );
  for (const [name, block] of Object.entries(j))
    if (block.includes("actions/checkout"))
      assert.ok(block.includes("persist-credentials: false"), `${name}'s checkout keeps no credentials`);
  for (const pin of ['node-version: "24"', "run: npm install -g npm@11.11.0"]) {
    assert.ok(j.core.includes(pin), `the core job pins ${pin}`);
    assert.ok(d.includes(pin), `the directory job packs with the core job's pin: ${pin}`);
  }
  assert.ok(d.includes("GH_TOKEN: ${{ github.token }}"), "the push's token is the run's own");
  assert.ok(d.includes("VERSION: ${{ needs.core.outputs.version }}"), "the version is the core job's");
  assert.ok(
    d.includes('run: node packaging/directory-branch.mjs --version "${VERSION}"\n'),
    "the script, keeping every packed file (no --strip) until the first Validate answers",
  );
  for (const l of d.split("\n").filter((x) => /^\s+run: /.test(x)))
    assert.ok(!l.includes("${{"), `no expression inside run: ${l.trim()}`);
  assert.ok(!/id-token|npm publish|--force/.test(code(d)), "no OIDC, no publish, no force push");
});

test("release AC: pages.yml deploys main's HEAD after a release run succeeds, and never on a tag", () => {
  const yml = workflow("pages.yml");
  const on = yml.slice(yml.indexOf("\non:\n"), yml.indexOf("\npermissions:"));
  assert.ok(
    on.includes(
      '  push:\n    branches: ["main"]\n    paths: ["site/**", ".github/workflows/pages.yml"]\n  workflow_run:\n    workflows: [release]\n    types: [completed]\n  workflow_dispatch:\n',
    ),
    "the push and dispatch triggers stand, with workflow_run on release between them",
  );
  assert.ok(!/^\s*tags:/m.test(code(on)), "no tag trigger: the github-pages environment admits main only");
  assert.ok(
    yml.includes("concurrency:\n  group: pages\n  cancel-in-progress: false\n"),
    "one deploy at a time, as before",
  );
  const j = jobs(yml);
  assert.ok(
    j.build.includes(
      "    if: ${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}\n",
    ),
    "a failed release deploys nothing",
  );
  assert.ok(j.deploy.includes("    needs: build\n"), "deploy follows build, and skips with it");
  assert.ok(!/ref: /.test(code(j.build)), "the checkout is the run's own ref: main's HEAD on workflow_run");
});

test("release AC: surfaces.yml checks every surface after a stable release, read-only, for a bounded window", () => {
  const yml = workflow("surfaces.yml");
  assert.ok(yml.includes("  workflow_run:\n    workflows: [release]\n    types: [completed]\n"));
  assert.ok(yml.includes("  workflow_dispatch:\n    inputs:\n      version:\n"), "a by-hand run names the version");
  assert.ok(yml.includes("\npermissions:\n  contents: read\n"));
  assert.ok(!/: write\b/.test(code(yml)), "read-only throughout");
  assert.ok(
    yml.includes(
      "github.event.workflow_run.conclusion == 'success' && startsWith(github.event.workflow_run.head_branch, 'v') && !contains(github.event.workflow_run.head_branch, '-')",
    ),
    "a succeeded run of a stable tag; a prerelease is checked by hand",
  );
  assert.ok(
    yml.includes("RELEASE_TAG: ${{ github.event.workflow_run.head_branch }}"),
    "the tag reaches run through env",
  );
  const run = yml.slice(yml.lastIndexOf("run: |"));
  assert.ok(!run.includes("${{"), "no expression inside run");
  assert.ok(run.includes('node packaging/release-surfaces.mjs --version "$VERSION" --wait 900'));
  assert.match(yml, /The window is 15 minutes \(--wait 900\)/, "the window is stated beside it");
});

// ─── packaging/release-surfaces.mjs ─────────────────────────────────────

const REPO = "SmartAndPoint/ProjectStore";
const V = "0.30.4";
const README = "# ProjectStore\n\nThe core's readme.\n";
const SHELL_README = (n) => `# ${n}\n\nA shell's readme.\n`;

// Every surface as it reads when the release is done everywhere.
function live(version = V, { pre = false } = {}) {
  const u = urls({ repo: REPO, version });
  const routes = {
    [u.compare]: { status: 200, json: { status: "identical" } },
    [u.release]: { status: 200, json: { tag_name: `v${version}`, prerelease: pre, draft: false } },
    [u.latest]: { status: 200, json: { tag_name: pre ? "v0.30.4" : `v${version}` } },
    [u.badge]: { status: 200, json: { label: "release", message: `v${version}`, value: `v${version}` } },
    [u.site]: { status: 200, text: `<span data-fact="version">v${version}</span>` },
    [u.llms]: { status: 200, text: `**Facts about version ${version}.**` },
    [u.llmsFull]: { status: 200, text: `## Facts about version ${version}\n` },
    [u.directory]: { status: 200, json: { name: "projectstore", version } },
  };
  for (const p of packagesFor()) {
    const readme = p.name === "projectstore" ? README : SHELL_README(p.name);
    routes[u.distTags[p.name]] = {
      status: 200,
      json: pre ? { latest: "0.30.4", next: version } : { latest: version },
    };
    routes[u.packument[p.name]] = { status: 200, json: { name: p.name, readme } };
    routes[u.file[p.name]] = { status: 200, text: readme };
  }
  return routes;
}

// A fetch that answers from the table, by URL without its query, and fails
// loudly on any URL the table lacks — a wrong URL is a test failure, not a
// silent "lagging".
function routed(routes, seen = []) {
  return async (url, init) => {
    const key = url.split("?")[0];
    seen.push({ url, headers: init?.headers || {} });
    if (!(key in routes)) throw new Error(`unrouted ${url}`);
    const r = routes[key];
    if (r.throws) throw new Error(r.throws);
    const text = r.text ?? JSON.stringify(r.json);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text };
  };
}

const read = (routes, version = V) => readSurfaces({ version, fetch: routed(routes), repo: REPO, now: () => 1 });
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.surface, r]));

// The rows, in order, for the publishable packages of this checkout: derived,
// so a shell that starts publishing gains its rows here without an edit.
const NAMES = packagesFor().map((p) => p.name);
const STABLE_ROWS = [
  "tag on main",
  "GitHub Release",
  "README badge",
  ...NAMES.map((n) => `npm ${n}@latest`),
  ...NAMES.map((n) => `npm ${n} readme`),
  "site footer",
  "site llms.txt",
  "site llms-full.txt",
  "directory branch",
];

test("release surfaces: every row is ok when the release shows everywhere, and the URLs are the live ones", async () => {
  const seen = [];
  const rows = await readSurfaces({ version: V, fetch: routed(live(), seen), repo: REPO, now: () => 7 });
  assert.deepEqual(
    rows.map((r) => r.surface),
    STABLE_ROWS,
  );
  for (const r of rows) assert.equal(r.status, "ok", `${r.surface}: ${r.detail}`);
  for (const r of rows) assert.equal(r.fix, null, "an ok row has no fix");
  const u = seen.map((s) => s.url);
  assert.ok(u.includes(`https://api.github.com/repos/${REPO}/compare/v${V}...main`));
  assert.ok(u.includes(`https://registry.npmjs.org/-/package/projectstore/dist-tags`));
  for (const p of packagesFor().filter((x) => x.name !== "projectstore"))
    assert.ok(u.includes(`https://raw.githubusercontent.com/${REPO}/v${V}/${p.readme}`), p.name);
  assert.ok(u.includes("https://projectstore.dev/?release-surfaces=7"), "the site is read past its CDN");
  assert.ok(
    u.includes(`https://raw.githubusercontent.com/${REPO}/directory/.claude-plugin/plugin.json`),
    "the directory branch's version is its plugin.json's",
  );
  for (const s of SHELLS.filter((x) => x.private))
    assert.ok(!u.some((x) => x.includes(s.name)), `${s.name} is private: it has no surface`);
});

test("release surfaces: GITHUB_TOKEN goes to api.github.com only, and is never printed", async () => {
  const seen = [];
  const out = [];
  const code = await main(["--version", V], {
    fetch: routed(live(), seen),
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => out.push(s) },
    env: { GITHUB_TOKEN: "test-github-token", GITHUB_REPOSITORY: REPO },
  });
  assert.equal(code, 0);
  for (const s of seen) {
    const auth = s.headers.authorization;
    if (s.url.startsWith("https://api.github.com/")) assert.equal(auth, "Bearer test-github-token");
    else assert.equal(auth, undefined, `${s.url} gets no token`);
  }
  assert.ok(!out.join("").includes("test-github-token"));
});

// A lagging and a wrong case for every row: the mutation, the row it lands
// on, and what its fix must name.
const RERUN = /Re-run all jobs/;
const SITE_ROWS = [
  ["site footer", "site", (v) => `<span data-fact="version">v${v}</span>`],
  ["site llms.txt", "llms", (v) => `**Facts about version ${v}.**`],
  ["site llms-full.txt", "llmsFull", (v) => `## Facts about version ${v}\n`],
];
const CASES = [
  ["tag on main", "lagging", (r, u) => (r[u.compare] = { status: 404, json: {} }), /git push origin v0\.30\.4/],
  ["tag on main", "wrong", (r, u) => (r[u.compare] = { status: 200, json: { status: "diverged" } }), /merge commit/],
  ["GitHub Release", "lagging", (r, u) => (r[u.release] = { status: 404, json: {} }), RERUN],
  [
    "GitHub Release",
    "wrong",
    (r, u) => (r[u.latest] = { status: 200, json: { tag_name: "v0.30.3" } }),
    /gh release edit v0\.30\.4 --latest/,
  ],
  ["GitHub Release", "wrong", (r, u) => (r[u.release].json.prerelease = true), /--prerelease=false --latest/],
  [
    "README badge",
    "lagging",
    (r, u) => (r[u.badge] = { status: 200, json: { value: "v0.29.2" } }),
    /shields\.io caches/,
  ],
  ["README badge", "wrong", (r, u) => (r[u.badge] = { status: 200, json: { value: "v0.31.0" } }), /check v0\.31\.0/],
  ...NAMES.flatMap((n) => [
    [`npm ${n}@latest`, "lagging", (r, u) => (r[u.distTags[n]] = { status: 200, json: { latest: "0.30.3" } }), RERUN],
    [
      `npm ${n}@latest`,
      "wrong",
      (r, u) => (r[u.distTags[n]] = { status: 200, json: { latest: "0.31.0-rc.1" } }),
      new RegExp(`npm dist-tag add ${n}@0\\.30\\.4 latest`),
    ],
    [
      `npm ${n}@latest`,
      "wrong",
      (r, u) => (r[u.distTags[n]] = { status: 200, json: { latest: "0.31.0" } }),
      /check 0\.31\.0/,
    ],
    [`npm ${n} readme`, "lagging", (r, u) => (r[u.distTags[n]] = { status: 200, json: { latest: "0.30.3" } }), RERUN],
    [`npm ${n} readme`, "wrong", (r, u) => (r[u.packument[n]].json.readme = "an older readme"), /only a new version/],
  ]),
  ...SITE_ROWS.flatMap(([surface, key, page]) => [
    [surface, "lagging", (r, u) => (r[u[key]].text = page("0.30.3")), PAGES_FIX],
    [surface, "lagging", (r, u) => (r[u[key]] = { status: 503, text: "" }), PAGES_FIX],
    [surface, "wrong", (r, u) => (r[u[key]].text = "<p>no marker</p>"), /site build/],
    [surface, "wrong", (r, u) => (r[u[key]].text = page("0.31.0")), /check 0\.31\.0/],
  ]),
  [
    "directory branch",
    "lagging",
    (r, u) => (r[u.directory] = { status: 404, text: "404: Not Found" }),
    /directory-branch\.mjs --version 0\.30\.4/,
  ],
  ["directory branch", "lagging", (r, u) => (r[u.directory].json.version = "0.30.3"), RERUN],
  ["directory branch", "wrong", (r, u) => (r[u.directory].json.version = "0.31.0"), /check 0\.31\.0/],
  ["directory branch", "wrong", (r, u) => (r[u.directory] = { status: 200, text: "{}" }), /directory job/],
];

test("release surfaces: each row reads lagging or wrong on its own fault, names its fix, and fails the run", async () => {
  for (const surface of STABLE_ROWS)
    for (const status of ["lagging", "wrong"])
      assert.ok(
        CASES.some(([s, st]) => s === surface && st === status),
        `${surface} has a ${status} case`,
      );
  const u = urls({ repo: REPO, version: V });
  for (const [surface, status, mutate, fix] of CASES) {
    const routes = structuredClone(live());
    mutate(routes, u);
    const row = byName(await read(routes))[surface];
    assert.equal(row.status, status, `${surface} ${status}: ${row.detail}`);
    if (fix instanceof RegExp) assert.match(row.fix, fix, surface);
    else assert.ok(row.fix.includes(fix), `${surface}: ${row.fix}`);
    const out = [];
    const exit = await main(["--version", V], {
      fetch: routed(routes),
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => out.push(s) },
      env: { GITHUB_REPOSITORY: REPO, GITHUB_ACTIONS: "true" },
    });
    assert.equal(exit, 1, `${surface} ${status} fails the run`);
    assert.ok(out.join("").includes(`::error title=${surface}::${status}`), `${surface} is named in the run's summary`);
  }
});

test("release surfaces: no answer at all is lagging, never a crash", async () => {
  const routes = live();
  const u = urls({ repo: REPO, version: V });
  routes[u.badge] = { throws: "getaddrinfo ENOTFOUND img.shields.io" };
  const row = byName(await read(routes))["README badge"];
  assert.equal(row.status, "lagging");
  assert.match(row.detail, /ENOTFOUND/);
});

test("release surfaces: a prerelease is read on next, as a prerelease, without the rows that follow latest", async () => {
  const version = "0.31.0-rc.1";
  const u = urls({ repo: REPO, version });
  const rows = await read(live(version, { pre: true }), version);
  assert.deepEqual(
    rows.map((r) => [r.surface, r.status]),
    [["tag on main", "ok"], ["GitHub Release", "ok"], ...NAMES.map((n) => [`npm ${n}@next`, "ok"])],
  );
  const cases = [
    [
      (r) => (r[u.release].json.prerelease = false),
      "GitHub Release",
      "wrong",
      /gh release edit v0\.31\.0-rc\.1 --prerelease/,
    ],
    [(r) => (r[u.latest].json.tag_name = `v${version}`), "GitHub Release", "wrong", /--latest=false/],
    [
      (r) => (r[u.distTags.projectstore] = { status: 200, json: { latest: "0.30.4", next: "0.30.4" } }),
      "npm projectstore@next",
      "lagging",
      RERUN,
    ],
  ];
  for (const [mutate, surface, status, fix] of cases) {
    const routes = structuredClone(live(version, { pre: true }));
    mutate(routes);
    const row = byName(await read(routes, version))[surface];
    assert.equal(row.status, status, `${surface}: ${row.detail}`);
    assert.match(row.fix, fix);
  }
});

test("release surfaces: --wait re-reads until every row is ok, and stops at the window or when nothing is lagging", async () => {
  let t = 0;
  const now = () => t;
  const slept = [];
  const sleep = async (s) => {
    slept.push(s);
    t += s * 1000;
  };
  const u = urls({ repo: REPO, version: V });

  // Lagging, then healed after two rounds: ok, three rounds, two sleeps.
  let calls = 0;
  const healing = async (url, init) => {
    const routes = live();
    if (url.split("?")[0] === u.site && ++calls <= 2) routes[u.site].text = '<span data-fact="version">v0.30.3</span>';
    return routed(routes)(url, init);
  };
  const healed = await checkSurfaces({ version: V, wait: 900, fetch: healing, repo: REPO, sleep, now });
  assert.equal(healed.ok, true);
  assert.equal(healed.rounds, 3);
  assert.deepEqual(slept, [60, 60]);

  // Lagging past the window: not ok, the last round starts at the window's
  // end (t = 180 s), and none starts past it.
  slept.length = 0;
  t = 0;
  const stuck = live();
  stuck[u.site].text = '<span data-fact="version">v0.30.3</span>';
  const late = await checkSurfaces({ version: V, wait: 180, fetch: routed(stuck), repo: REPO, sleep, now });
  assert.equal(late.ok, false);
  assert.equal(late.rounds, 4);
  assert.deepEqual(slept, [60, 60, 60]);

  // Only wrong rows: waiting cannot heal them, so one round.
  slept.length = 0;
  const wrong = live();
  wrong[u.compare] = { status: 200, json: { status: "behind" } };
  const once = await checkSurfaces({ version: V, wait: 900, fetch: routed(wrong), repo: REPO, sleep, now });
  assert.equal(once.ok, false);
  assert.equal(once.rounds, 1);
  assert.deepEqual(slept, []);
});

test("release surfaces: --json is the result, and a usage error is exit 2", async () => {
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const env = { GITHUB_REPOSITORY: REPO };
  assert.equal(await main(["--version", `v${V}`, "--json"], { fetch: routed(live()), env, ...io }), 0);
  const json = JSON.parse(out.join(""));
  assert.equal(json.ok, true);
  assert.equal(json.version, V, "a leading v is the same release");
  assert.equal(json.rows.length, STABLE_ROWS.length);
  assert.equal(json.rows.length, 13, "twelve surfaces and the directory branch");

  for (const argv of [
    [],
    ["--version"],
    ["--version", "latest"],
    ["--version", V, "--wait", "soon"],
    ["--version", V, "--force"],
  ]) {
    out.length = 0;
    assert.equal(await main(argv, { fetch: routed(live()), env, ...io }), 2, JSON.stringify(argv));
    assert.match(out.join(""), /usage: node packaging\/release-surfaces\.mjs --version X\.Y\.Z/);
  }
});

test("release surfaces: the repository is GITHUB_REPOSITORY in a workflow, package.json's otherwise", () => {
  assert.equal(repoSlug({ env: { GITHUB_REPOSITORY: "a/b" } }), "a/b");
  assert.equal(repoSlug({ env: {} }), REPO);
  assert.equal(repoSlug({ core: { repository: { url: "git+https://github.com/o/n.git" } }, env: {} }), "o/n");
});

// ─── packaging/directory-branch.mjs ─────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "ps-release-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
// git with no global or system config (no signing, no hooks, no helpers) and
// an identity of its own; GIT_TERMINAL_PROMPT=0 is the script's.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: TMP,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (dir, ...args) => {
  const r = spawnSync("git", [...(dir ? [`--git-dir=${dir}`] : []), ...args], { encoding: "utf8", env: GIT_ENV });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
// A bare repository standing in for GitHub's.
function bareRemote() {
  const r = join(mkdtempSync(join(TMP, "remote-")), "r.git");
  assert.equal(git(null, "init", "-q", "--bare", r).status, 0);
  return r;
}
const headOf = (r) => {
  const x = git(r, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`);
  return x.status === 0 ? x.out.trim() : null;
};
// [path, mode] for every file of a commit's tree.
const treeOf = (r, ref) =>
  git(r, "ls-tree", "-r", "--full-tree", ref)
    .out.trim()
    .split("\n")
    .map((l) => [l.slice(l.indexOf("\t") + 1), l.split(" ")[0]]);
const parentsOf = (r, c) => git(r, "rev-list", "--parents", "-n", "1", c).out.trim().split(" ").slice(1);

// A packed core the test names: path → text, or { text, mode }.
const packed = (version, more = {}) => ({
  ".claude-plugin/plugin.json": JSON.stringify({ name: "projectstore", version }) + "\n",
  ".claude-plugin/marketplace.json": '{ "name": "SmartAndPoint" }\n',
  "bin/projectstore.mjs": { text: "#!/usr/bin/env node\n", mode: 0o755 },
  "package.json": JSON.stringify({ name: "projectstore", version }) + "\n",
  "scripts/lib.mjs": "export {};\n",
  ...more,
});
// npm's shape: a gzipped tar of package/<path>, with the modes given. The
// listed files are `set`'s; `stray` lands in the tarball unlisted.
function fakePack(version, set, { stray = {}, listed = version } = {}) {
  const dir = mkdtempSync(join(TMP, "pkg-"));
  for (const [rel, f] of Object.entries({ ...set, ...stray })) {
    const p = join(dir, "package", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof f === "string" ? f : f.text);
    chmodSync(p, typeof f === "string" ? 0o644 : f.mode);
  }
  const tgz = join(dir, `projectstore-${version}.tgz`);
  assert.equal(spawnSync("tar", ["-czf", tgz, "-C", dir, "package"]).status, 0);
  return () => ({ tgz, version: listed, files: Object.keys(set).sort() });
}
const moveTo = (remote, version, set, { fixture = Object.keys(set).sort(), ...opts } = {}) =>
  moveDirectoryBranch({
    version,
    remote,
    pack: fakePack(version, set, opts),
    fixture,
    strip: opts.strip ?? [],
    dryRun: opts.dryRun ?? false,
    env: GIT_ENV,
  });

test("directory branch: the packed tree is the next commit — an orphan when the branch is missing, its parent kept, nothing for the same tree, never backwards", () => {
  const r = bareRemote();
  assert.equal(headOf(r), null);

  const v1 = packed("1.0.0");
  const first = moveTo(r, "1.0.0", v1);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.action, "created");
  assert.equal(headOf(r), first.commit, "pushed");
  assert.deepEqual(parentsOf(r, first.commit), [], "an orphan commit: the branch was missing");
  const t1 = Object.fromEntries(treeOf(r, BRANCH));
  assert.deepEqual(Object.keys(t1), Object.keys(v1).sort(), "the tree is the list");
  assert.equal(t1["bin/projectstore.mjs"], "100755", "the tarball's executable bit");
  assert.equal(t1["scripts/lib.mjs"], "100644");
  assert.equal(git(r, "show", `${BRANCH}:.claude-plugin/plugin.json`).out, v1[".claude-plugin/plugin.json"]);
  assert.equal(first.files, 5);

  const again = moveTo(r, "1.0.0", v1);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.action, "unchanged", "a re-run of the tag");
  assert.equal(headOf(r), first.commit, "no commit");

  const v2 = packed("1.1.0", { "scripts/new.mjs": "export const x = 1;\n" });
  const second = moveTo(r, "1.1.0", v2);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.action, "committed");
  assert.equal(headOf(r), second.commit);
  assert.deepEqual(parentsOf(r, second.commit), [first.commit], "the parent is kept: history, never a force push");
  assert.equal(second.parentVersion, "1.0.0");
  assert.deepEqual(
    treeOf(r, BRANCH).map(([p]) => p),
    Object.keys(v2).sort(),
  );
  assert.match(git(r, "log", "-1", "--format=%s", BRANCH).out, /^v1\.1\.0: the packed tree of projectstore@1\.1\.0$/m);

  const older = moveTo(r, "1.0.0", v1);
  assert.equal(older.ok, true, older.error);
  assert.equal(older.action, "newer", "an older tag's re-run leaves the branch as it is");
  assert.equal(headOf(r), second.commit);

  const other = moveTo(r, "1.1.0", packed("1.1.0", { "scripts/new.mjs": "export const x = 2;\n" }));
  assert.equal(other.ok, false);
  assert.match(other.error, /carries 1\.1\.0 already, with another tree/);
  assert.equal(headOf(r), second.commit, "a version is committed once");

  // What a checkout of the branch holds: the executable bit survives.
  const clone = join(mkdtempSync(join(TMP, "clone-")), "c");
  assert.equal(git(null, "clone", "-q", "-b", BRANCH, r, clone).status, 0);
  assert.ok(statSync(join(clone, "bin", "projectstore.mjs")).mode & 0o100, "bin is executable in a checkout");
  assert.equal(statSync(join(clone, "scripts", "lib.mjs")).mode & 0o111, 0);
});

test("directory branch: a pack that is not the packlist, a tarball that is not its list, or another version commits nothing", () => {
  const r = bareRemote();
  const v1 = packed("1.0.0");
  const cases = [
    [
      { fixture: Object.keys(v1).filter((f) => f !== "scripts/lib.mjs") },
      /npm pack's file list is not tests\/fixtures\/packlist\.json: not listed: scripts\/lib\.mjs/,
    ],
    [
      { fixture: [...Object.keys(v1), "scripts/gone.mjs"] },
      /npm pack's file list is not tests\/fixtures\/packlist\.json: missing: scripts\/gone\.mjs/,
    ],
    [{ stray: { "stray.txt": "x\n" } }, /the unpacked tarball is not npm pack's file list: not listed: stray\.txt/],
    [{ listed: "0.9.0" }, /the pack is projectstore@0\.9\.0, not the release 1\.0\.0/],
  ];
  for (const [opts, error] of cases) {
    const res = moveTo(r, "1.0.0", v1, opts);
    assert.equal(res.ok, false, JSON.stringify(opts));
    assert.match(res.error, error);
  }
  const named = moveTo(r, "1.0.0", {
    ...v1,
    ".claude-plugin/plugin.json": JSON.stringify({ version: "0.9.0" }) + "\n",
  });
  assert.equal(named.ok, false);
  assert.match(named.error, /\.claude-plugin\/plugin\.json names 0\.9\.0, not 1\.0\.0/);
  assert.equal(headOf(r), null, "nothing reached the remote");
});

test("directory branch: --strip drops a packed file, a path not packed is refused, and a dry run pushes nothing", () => {
  const r = bareRemote();
  const v1 = packed("1.0.0");
  const plan = moveTo(r, "1.0.0", v1, { dryRun: true });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.action, "would-create");
  assert.equal(plan.commit, null);
  assert.equal(headOf(r), null, "a dry run pushes nothing");

  const nope = moveTo(r, "1.0.0", v1, { strip: ["nope.json"] });
  assert.equal(nope.ok, false);
  assert.match(nope.error, /--strip nope\.json: not a packed file/);

  const stripped = moveTo(r, "1.0.0", v1, { strip: [".claude-plugin/marketplace.json"] });
  assert.equal(stripped.ok, true, stripped.error);
  assert.deepEqual(stripped.stripped, [".claude-plugin/marketplace.json"]);
  assert.deepEqual(
    treeOf(r, BRANCH).map(([p]) => p),
    Object.keys(v1)
      .filter((f) => f !== ".claude-plugin/marketplace.json")
      .sort(),
  );

  const head = headOf(r);
  const next = moveTo(r, "1.1.0", packed("1.1.0"), { dryRun: true, strip: [".claude-plugin/marketplace.json"] });
  assert.equal(next.action, "would-commit");
  assert.equal(next.parent, head);
  assert.equal(headOf(r), head);
});

test("directory branch: the CLI's usage, its output, and the token, which it never prints", () => {
  const r = bareRemote();
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const v1 = packed("1.0.0");
  const deps = { pack: fakePack("1.0.0", v1), fixture: Object.keys(v1).sort() };
  for (const [argv, why] of [
    [[], /--version is required/],
    [["--version"], /--version takes a value/],
    [["--version", "latest"], /"latest" is not a version/],
    [["--version", "1.0.0", "--force"], /unknown argument --force/],
    [["--version", "1.0.0", "--strip"], /--strip takes a value/],
    [
      ["--version", "1.1.0-rc.1", "--remote", r],
      /1\.1\.0-rc\.1 is a prerelease: the directory branch carries stable releases only/,
    ],
    [["--version", "1.0.0"], /pushing needs GH_TOKEN/],
  ]) {
    out.length = 0;
    assert.equal(directoryMain(argv, { env: GIT_ENV, ...io, ...deps }), 2, JSON.stringify(argv));
    assert.match(out.join(""), why);
    assert.match(out.join(""), /usage: node packaging\/directory-branch\.mjs --version X\.Y\.Z/);
  }
  assert.equal(headOf(r), null);

  out.length = 0;
  assert.equal(directoryMain(["--version", "v1.0.0", "--remote", r], { env: GIT_ENV, ...io, ...deps }), 0);
  assert.match(out.join(""), /^directory: created with v1\.0\.0 as [0-9a-f]{12}, an orphan commit \(5 files, tree /);
  out.length = 0;
  assert.equal(directoryMain(["--version", "1.0.0", "--remote", r, "--json"], { env: GIT_ENV, ...io, ...deps }), 0);
  const json = JSON.parse(out.join(""));
  assert.equal(json.action, "unchanged");
  assert.equal(json.commit, headOf(r));

  assert.equal(
    remoteFor({ env: { GH_TOKEN: "t0ken", GITHUB_REPOSITORY: "o/n" } }),
    "https://x-access-token:t0ken@github.com/o/n.git",
  );
  assert.equal(remoteFor({ env: { GITHUB_REPOSITORY: "o/n" } }), "https://github.com/o/n.git");
  assert.equal(remoteFor({ env: {} }), `https://github.com/${REPO}.git`, "package.json's repository by hand");
  assert.equal(
    redact("fatal: https://x-access-token:t0ken@github.com/o/n.git and t0ken", { GH_TOKEN: "t0ken" }),
    "fatal: https://***@github.com/o/n.git and ***",
  );

  // A remote that refuses the connection (loopback, port 1): git's message
  // comes back, the token in it does not.
  out.length = 0;
  const env = { ...GIT_ENV, GH_TOKEN: "s3cret-t0ken", GITHUB_ACTIONS: "true" };
  const remote = "https://x-access-token:s3cret-t0ken@127.0.0.1:1/o/n.git";
  assert.equal(directoryMain(["--version", "1.0.0", "--remote", remote], { env, ...io, ...deps }), 1);
  const said = out.join("");
  assert.match(
    said,
    /directory-branch: reading the directory branch at https:\/\/\*\*\*@127\.0\.0\.1:1\/o\/n\.git failed/,
  );
  assert.match(said, /::error title=directory branch::/);
  assert.ok(!said.includes("s3cret-t0ken"), said);
});

test(
  "directory branch: the checkout's own pack commits tests/fixtures/packlist.json, the bin executable and plugin.json at the release",
  { timeout: 180000 },
  () => {
    const r = bareRemote();
    const version = corePackage().version;
    const res = moveDirectoryBranch({ version, remote: r, env: GIT_ENV });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.action, "created");
    const tree = Object.fromEntries(treeOf(r, BRANCH));
    assert.deepEqual(
      Object.keys(tree),
      JSON.parse(readFileSync(join(ROOT, PACKLIST), "utf8")),
      "the tree is the packlist",
    );
    assert.equal(tree["bin/projectstore.mjs"], "100755");
    assert.equal(JSON.parse(git(r, "show", `${BRANCH}:.claude-plugin/plugin.json`).out).version, version);
    for (const f of Object.keys(tree))
      assert.ok(!/^(tests|site|packaging|\.github)\//.test(f) && f !== "package-lock.json", `${f} is not shipped`);
  },
);

// The G review, 2026-10-15: no other test fails when the push is forced, so
// this one pins the one push the script makes, and that it is never forced.
test("directory branch: the one push is a plain fast-forward, never forced", () => {
  const args = pushArgs("origin", "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(args, ["push", "-q", "origin", `0123456789abcdef0123456789abcdef01234567:refs/heads/${BRANCH}`]);
  for (const a of args) {
    assert.ok(!/^(?:--force|--force-with-lease|--force-if-includes|-f|--mirror|--delete|-d)(?:=|$)/.test(a), `no ${a}`);
    assert.ok(!a.startsWith("+") && !a.includes(":+"), `no forcing refspec in ${a}`);
  }
  const src = readFileSync(resolve(ROOT, "packaging", "directory-branch.mjs"), "utf8");
  assert.equal((src.match(/["']push["']/g) || []).length, 1, "pushArgs is the only push");
  assert.ok(!/--force|"-f"|'-f'/.test(src), "the script names no force flag");
});

// projectstore — release tests (PS-HARNESS: "A release tag shows on every
// surface: the workflow makes the GitHub Release from committed notes, and a
// check reads every surface after the publish").
//
// Two halves. The workflows, read as text — the test job runs no `npm ci`, so
// there is no YAML parser, and tests/shells.test.mjs ("shells AC 4") already
// reads release.yml this way: the GitHub Release job, the site's deploy after
// a release, and the surfaces workflow. Then packaging/release-surfaces.mjs,
// every judgement through an injected fetch: tests/fixtures/hermetic.mjs pins
// the global fetch to loopback, and nothing here may read the network.
//
//   node --test tests/release.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
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
import { SHELLS } from "../packaging/shells.mjs";

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

test("release AC: release.yml makes the GitHub Release after every publish, from the notes, with the one write scope", () => {
  const yml = workflow("release.yml");
  const j = jobs(yml);
  assert.deepEqual(Object.keys(j), ["core", "shells", "github-release"]);
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
    if (name !== "github-release") assert.ok(!/: write\b/.test(code(block)), `${name} gains no write scope`);
  const top = yml.slice(0, yml.indexOf("\njobs:\n"));
  assert.match(top, /permissions:\n {2}contents: read\n {2}id-token: write/, "the workflow-level scopes are unchanged");
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
    env: { GITHUB_TOKEN: "secret-token", GITHUB_REPOSITORY: REPO },
  });
  assert.equal(code, 0);
  for (const s of seen) {
    const auth = s.headers.authorization;
    if (s.url.startsWith("https://api.github.com/")) assert.equal(auth, "Bearer secret-token");
    else assert.equal(auth, undefined, `${s.url} gets no token`);
  }
  assert.ok(!out.join("").includes("secret-token"));
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
  assert.equal(json.rows.length, 12);

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

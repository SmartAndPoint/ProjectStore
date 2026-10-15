#!/usr/bin/env node
// projectstore — release-surfaces.mjs (PS-HARNESS: "A release tag shows on
// every surface: the workflow makes the GitHub Release from committed notes,
// and a check reads every surface after the publish")
//
//   node packaging/release-surfaces.mjs --version X.Y.Z [--wait <seconds>] [--json]
//
// The maintainer's rule (2026-10-15): a release is not done until its version
// shows on every surface a user reads — the GitHub README, GitHub Releases
// (this tag Latest), npm (each package's dist-tag and readme) and the site.
// The guards in the repository (scripts/version-guard.mjs, tests/site.test.mjs)
// hold what is committed; this reads what is LIVE, after the publish, over the
// network: the tag's own files come from raw.githubusercontent.com, so no
// checkout at the tag is needed. "Release surfaces", not scripts/surfaces.mjs's
// installed harness surfaces — the two share a word and nothing else.
//
// One row per surface: `ok`, `lagging` (not there yet, or no answer — waiting
// or the row's fix clears it) or `wrong` (it contradicts the release, and
// waiting will not change it), with the command that clears it. A prerelease
// is read for its own rows only: the badge, the readmes and the site follow
// `latest`, which a prerelease never is, and the directory branch carries
// stable releases only. The last row is that branch (PS-DIRECTORY: "The
// maintainer submits ProjectStore through the developer portal…"): the tree
// Anthropic's directory scans, whose plugin.json names the release once
// release.yml's `directory` job has run. The listing's own published version
// needs a claude.ai sign-in to read, so it is no row: packaging/README.md
// reads it by hand. --wait re-reads every round until every row is ok, no
// row is lagging any more, or the window is spent; the surfaces workflow
// (.github/workflows/surfaces.yml) runs it with 900.
//
// Exit 0 when every row is ok, 1 when one is not, 2 on a usage error. With
// GITHUB_TOKEN set, api.github.com is read with it (an unauthenticated runner
// shares a 60-an-hour limit); it is never printed. Not a test: it reads the
// network, so `npm test` never runs it — tests/release.test.mjs runs every
// judgement through an injected fetch.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmpPrecedence } from "../scripts/lib.mjs";
import { isSemver } from "../scripts/convergence.mjs";
import { CORE, SHELLS_DIR, publishable, corePackage } from "./shells.mjs";

export const SITE = "https://projectstore.dev";
// The branch Anthropic's directory tracks, and the file it reads the version
// from (packaging/directory-branch.mjs moves it).
export const DIRECTORY_BRANCH = "directory";
export const DIRECTORY_VERSION_FILE = ".claude-plugin/plugin.json";
export const PAGES_FIX = "gh workflow run pages.yml --ref main";
// After a release run that succeeded (the only kind surfaces.yml follows)
// GitHub offers "Re-run all jobs": every publish skips a version the registry
// has, and the release job skips a release that exists.
export const RERUN_FIX = 'the release run\'s "Re-run all jobs" (or "Re-run failed jobs" after a failure)';
// A stalled host must not hold a round past the workflow's timeout, which
// would end the run cancelled, without the rows that say why.
export const READ_TIMEOUT_MS = 30000;
export const WAIT_INTERVAL = 60;

const stripV = (t) => String(t).replace(/^v/, "");
export const isPrerelease = (version) => version.split("+")[0].includes("-");

// owner/name: GITHUB_REPOSITORY in a workflow, package.json's repository here.
export function repoSlug({ core = corePackage(), env = process.env } = {}) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const url = core.repository?.url ?? core.repository ?? "";
  return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? null;
}

// The core and every publishable shell, each with the file npm shows as its
// readme. A private shell is never published, so it has no surface.
export const packagesFor = () => [
  { name: CORE, readme: "README.md" },
  ...publishable().map((name) => ({ name, readme: `${SHELLS_DIR}/${name}/README.md` })),
];

export function urls({ repo, version, packages = packagesFor() }) {
  const v = `v${version}`;
  return {
    compare: `https://api.github.com/repos/${repo}/compare/${v}...main`,
    release: `https://api.github.com/repos/${repo}/releases/tags/${v}`,
    latest: `https://api.github.com/repos/${repo}/releases/latest`,
    badge: `https://img.shields.io/github/v/release/${repo}.json`,
    distTags: Object.fromEntries(
      packages.map((p) => [p.name, `https://registry.npmjs.org/-/package/${p.name}/dist-tags`]),
    ),
    packument: Object.fromEntries(packages.map((p) => [p.name, `https://registry.npmjs.org/${p.name}`])),
    file: Object.fromEntries(
      packages.map((p) => [p.name, `https://raw.githubusercontent.com/${repo}/${v}/${p.readme}`]),
    ),
    site: `${SITE}/`,
    llms: `${SITE}/llms.txt`,
    llmsFull: `${SITE}/llms-full.txt`,
    directory: `https://raw.githubusercontent.com/${repo}/${DIRECTORY_BRANCH}/${DIRECTORY_VERSION_FILE}`,
  };
}

const row = (surface, status, detail, fix = null) => ({ surface, status, detail, fix: status === "ok" ? null : fix });

// "older", "same" or "newer" than the release, or null for no version at all.
function relation(seen, version) {
  const s = seen == null ? null : stripV(String(seen).trim());
  if (!s || !isSemver(s)) return null;
  const c = cmpPrecedence(s, version);
  return c < 0 ? "older" : c > 0 ? "newer" : "same";
}

const noAnswer = (surface, read, what, fix) =>
  row(surface, "lagging", `${what} answered ${read.status || read.error || "nothing"}`, fix);

// ─── The judges: a read in, a row out. Pure. ────────────────────────────

// compare/v<V>...main: main identical to the tag or ahead of it means the tag
// is on main. A tag off main is the one release whose README and site lag by
// construction — they deploy from main.
export function judgeTagOnMain(read, version) {
  const s = "tag on main";
  if (read.status === 404) return row(s, "lagging", `v${version} is not on GitHub`, `git push origin v${version}`);
  if (read.status !== 200) return noAnswer(s, read, "GitHub's compare", "re-run when GitHub answers");
  const st = read.json?.status;
  if (st === "identical" || st === "ahead") return row(s, "ok", `v${version} is on main (${st})`);
  return row(
    s,
    "wrong",
    `v${version} is not on main (compare: ${st ?? "unknown"})`,
    "tag the release on its merge commit on main",
  );
}

export function judgeRelease(release, latest, version) {
  const s = "GitHub Release";
  const v = `v${version}`;
  if (release.status === 404)
    return row(
      s,
      "lagging",
      `no GitHub Release for ${v}`,
      `${RERUN_FIX}; by hand, the gh release create in packaging/README.md, "CI publish"`,
    );
  if (release.status !== 200) return noAnswer(s, release, "GitHub's release read", "re-run when GitHub answers");
  const r = release.json || {};
  if (isPrerelease(version)) {
    if (!r.prerelease) return row(s, "wrong", `${v} is not marked prerelease`, `gh release edit ${v} --prerelease`);
    if (latest.status === 200 && latest.json?.tag_name === v)
      return row(s, "wrong", `${v} is a prerelease and Latest`, `gh release edit ${v} --latest=false`);
    return row(s, "ok", `${v} is a prerelease, not Latest`);
  }
  if (r.prerelease)
    return row(s, "wrong", `${v} is marked prerelease`, `gh release edit ${v} --prerelease=false --latest`);
  if (latest.status !== 200) return noAnswer(s, latest, "GitHub's Latest read", "re-run when GitHub answers");
  const tag = latest.json?.tag_name;
  if (tag === v) return row(s, "ok", `${v} is Latest`);
  const rel = relation(tag, version);
  if (rel === "newer") return row(s, "wrong", `Latest is ${tag}, newer than ${v}`, `check ${tag} instead`);
  return row(s, "wrong", `Latest is ${tag ?? "nothing"}, not ${v}`, `gh release edit ${v} --latest`);
}

// The README's `release` badge reads GitHub's Latest through shields.io, which
// caches it for minutes: older here is a cache, not a fault.
export function judgeBadge(read, version) {
  const s = "README badge";
  if (read.status !== 200) return noAnswer(s, read, "shields.io", "re-run in a few minutes");
  const seen = read.json?.value ?? read.json?.message;
  const rel = relation(seen, version);
  if (rel === "same") return row(s, "ok", `the badge reads ${seen}`);
  if (rel === "newer")
    return row(s, "wrong", `the badge reads ${seen}, newer than v${version}`, `check ${seen} instead`);
  return row(
    s,
    "lagging",
    `the badge reads ${seen ?? "nothing"}`,
    "wait: shields.io caches GitHub's Latest for minutes; the GitHub Release row must be ok first",
  );
}

export function judgeDistTag(read, name, version) {
  const tag = isPrerelease(version) ? "next" : "latest";
  const s = `npm ${name}@${tag}`;
  if (read.status !== 200) return noAnswer(s, read, "the registry", RERUN_FIX);
  const seen = read.json?.[tag];
  const rel = relation(seen, version);
  if (rel === "same") return row(s, "ok", `${tag} is ${seen}`);
  if (tag === "latest" && seen && isPrerelease(stripV(seen)))
    return row(s, "wrong", `latest is the prerelease ${seen}`, `npm dist-tag add ${name}@${version} latest`);
  if (rel === "newer") return row(s, "wrong", `${tag} is ${seen}, newer than ${version}`, `check ${seen} instead`);
  return row(s, "lagging", `${tag} is ${seen ?? "not set"}`, RERUN_FIX);
}

// The packument's `readme` is the `latest` version's, so it is judged only
// once latest is this version; then a difference is permanent: a published
// version's readme never changes.
export function judgeReadme(distTags, packument, file, pkg, version) {
  const s = `npm ${pkg.name} readme`;
  if (distTags.status !== 200 || distTags.json?.latest !== version)
    return row(s, "lagging", `latest is not ${version} yet, and the readme follows latest`, RERUN_FIX);
  if (packument.status !== 200) return noAnswer(s, packument, "the registry", "re-run when the registry answers");
  if (file.status !== 200)
    return noAnswer(s, file, `${pkg.readme} at v${version}`, "re-run when raw.githubusercontent.com answers");
  if (packument.json?.readme === file.text) return row(s, "ok", `equals ${pkg.readme} at v${version}`);
  return row(
    s,
    "wrong",
    `the readme on npm is not ${pkg.readme} at v${version}`,
    "only a new version changes a published readme",
  );
}

export const FOOTER_RE = /data-fact="version">v?([^<]+)</;
// tests/site.test.mjs's own reading of the llms files' fact line.
export const LLMS_RE = /Facts about version (\d+\.\d+\.\d+(?:-[\w.]+)?)/;

export function judgeSite(read, surface, re, version) {
  if (read.status !== 200) return noAnswer(surface, read, SITE, PAGES_FIX);
  const seen = re.exec(read.text ?? "")?.[1];
  if (seen === undefined) return row(surface, "wrong", "no version marker on the page", "check the site build");
  const rel = relation(seen, version);
  if (rel === "same") return row(surface, "ok", `names ${seen}`);
  if (rel === "newer") return row(surface, "wrong", `names ${seen}, newer than ${version}`, `check ${seen} instead`);
  return row(surface, "lagging", `names ${seen}`, PAGES_FIX);
}

// The directory branch's plugin.json. raw.githubusercontent.com keeps a
// branch's file for minutes, so older is lagging; a branch that names no
// version, or a newer one, is wrong.
export function judgeDirectoryBranch(read, version) {
  const s = "directory branch";
  const fix = `${RERUN_FIX} — its ${DIRECTORY_BRANCH} job moves the branch; by hand, GH_TOKEN="$(gh auth token)" node packaging/directory-branch.mjs --version ${version}`;
  if (read.status === 404)
    return row(s, "lagging", `no ${DIRECTORY_VERSION_FILE} on the ${DIRECTORY_BRANCH} branch`, fix);
  if (read.status !== 200) return noAnswer(s, read, "raw.githubusercontent.com", "re-run when it answers");
  let seen = null;
  try {
    seen = JSON.parse(read.text ?? "")?.version ?? null;
  } catch {}
  const rel = relation(seen, version);
  if (rel === null)
    return row(
      s,
      "wrong",
      `the ${DIRECTORY_BRANCH} branch's plugin.json names no version`,
      "check the release run's directory job",
    );
  if (rel === "same") return row(s, "ok", `${DIRECTORY_BRANCH}'s plugin.json is ${seen}`);
  if (rel === "newer")
    return row(
      s,
      "wrong",
      `${DIRECTORY_BRANCH}'s plugin.json is ${seen}, newer than ${version}`,
      `check ${seen} instead`,
    );
  return row(s, "lagging", `${DIRECTORY_BRANCH}'s plugin.json is ${seen}`, fix);
}

// ─── Reading ────────────────────────────────────────────────────────────

// One GET, never throwing: { status, text, json } or { status: 0, error }.
async function get(fetch, url, { token = null, json = false } = {}) {
  const headers = { "user-agent": "projectstore-release-surfaces" };
  if (token && url.startsWith("https://api.github.com/")) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const text = await res.text();
    if (!json) return { status: res.status, text };
    try {
      return { status: res.status, text, json: JSON.parse(text) };
    } catch {
      return { status: res.status, text, json: null };
    }
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

/* eslint-disable n/no-unsupported-features/node-builtins -- the global fetch is experimental but present at Node 20 and stable from 21; a maintainer tool, never shipped, and the suite injects its own */
export async function readSurfaces({
  version,
  fetch = globalThis.fetch,
  token = null,
  repo = repoSlug(),
  packages = packagesFor(),
  now = Date.now,
} = {}) {
  /* eslint-enable n/no-unsupported-features/node-builtins */
  const u = urls({ repo, version, packages });
  const api = (url) => get(fetch, url, { token, json: true });
  // The site sits behind a CDN that keeps a page for minutes; a query of the
  // moment asks the origin.
  const fresh = (url) => get(fetch, `${url}?release-surfaces=${now()}`);
  const pre = isPrerelease(version);
  const rows = [judgeTagOnMain(await api(u.compare), version)];
  // For a prerelease, Latest is read only to catch a hand-made mistake:
  // GitHub never makes a prerelease Latest by itself.
  rows.push(judgeRelease(await api(u.release), await api(u.latest), version));
  if (!pre) rows.push(judgeBadge(await api(u.badge), version));
  const distTags = {};
  for (const p of packages) {
    distTags[p.name] = await api(u.distTags[p.name]);
    rows.push(judgeDistTag(distTags[p.name], p.name, version));
  }
  if (!pre) {
    for (const p of packages) {
      const ready = distTags[p.name].status === 200 && distTags[p.name].json?.latest === version;
      const packument = ready ? await api(u.packument[p.name]) : { status: 0 };
      const file = ready ? await get(fetch, u.file[p.name]) : { status: 0 };
      rows.push(judgeReadme(distTags[p.name], packument, file, p, version));
    }
    rows.push(judgeSite(await fresh(u.site), "site footer", FOOTER_RE, version));
    rows.push(judgeSite(await fresh(u.llms), "site llms.txt", LLMS_RE, version));
    rows.push(judgeSite(await fresh(u.llmsFull), "site llms-full.txt", LLMS_RE, version));
    rows.push(judgeDirectoryBranch(await get(fetch, u.directory), version));
  }
  return rows;
}

const defaultSleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

// Every round re-reads every surface: a row can depend on another (a readme
// on its dist-tag), and fifteen rows a minute is far inside every limit. The
// loop ends when every row is ok, when no row is lagging (wrong ones do not
// heal by waiting), or when another round would pass the window.
export async function checkSurfaces({
  version,
  wait = 0,
  interval = WAIT_INTERVAL,
  sleep = defaultSleep,
  now = Date.now,
  ...read
} = {}) {
  const start = now();
  let rounds = 0;
  for (;;) {
    rounds++;
    const rows = await readSurfaces({ version, now, ...read });
    const ok = rows.every((r) => r.status === "ok");
    const lagging = rows.some((r) => r.status === "lagging");
    if (ok || !lagging || (now() - start) / 1000 + interval > wait) return { ok, version, rounds, rows };
    await sleep(interval);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────

const USAGE = "usage: node packaging/release-surfaces.mjs --version X.Y.Z [--wait <seconds>] [--json]";

export async function main(
  argv,
  { fetch, stdout = process.stdout, stderr = process.stderr, sleep, now, env = process.env } = {},
) {
  const value = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : (argv[i + 1] ?? null);
  };
  const known = new Set(["--version", "--wait", "--json"]);
  const unknown = argv.filter((a, i) => a.startsWith("--") && !known.has(a) && argv[i - 1] !== "--version");
  const usage = (why) => {
    stderr.write(`release-surfaces: ${why}\n${USAGE}\n`);
    return 2;
  };
  if (unknown.length) return usage(`unknown option ${unknown[0]}`);
  const raw = value("--version");
  if (raw == null) return usage("--version is required");
  const version = stripV(raw);
  if (!isSemver(version)) return usage(`"${raw}" is not a version`);
  const w = value("--wait");
  if (w === null || (w !== undefined && !/^\d+$/.test(w))) return usage("--wait takes whole seconds");
  const repo = repoSlug({ env });
  if (!repo) return usage("no GitHub repository: set GITHUB_REPOSITORY=owner/name");

  const result = await checkSurfaces({
    version,
    wait: w === undefined ? 0 : Number(w),
    ...(sleep && { sleep }),
    ...(now && { now }),
    ...(fetch && { fetch }),
    token: env.GITHUB_TOKEN || null,
    repo,
  });
  if (argv.includes("--json")) stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    const width = Math.max(...result.rows.map((r) => r.surface.length));
    for (const r of result.rows) {
      stdout.write(`${r.status.padEnd(8)} ${r.surface.padEnd(width)}  ${r.detail}\n`);
      if (r.fix) stdout.write(`${" ".repeat(9 + width)}  fix: ${r.fix}\n`);
    }
    const bad = result.rows.filter((r) => r.status !== "ok").length;
    stdout.write(
      bad
        ? `v${version}: ${bad} of ${result.rows.length} surfaces not ok after ${result.rounds} round(s)\n`
        : `v${version}: every surface names it\n`,
    );
  }
  // A workflow run's summary shows these, one per surface that is not ok —
  // never under --json, whose stdout stays one JSON document.
  if (env.GITHUB_ACTIONS && !argv.includes("--json"))
    for (const r of result.rows.filter((x) => x.status !== "ok"))
      stdout.write(`::error title=${r.surface}::${r.status}: ${r.detail}${r.fix ? ` — fix: ${r.fix}` : ""}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

#!/usr/bin/env node
// projectstore — directory-branch.mjs (PS-DIRECTORY: "The maintainer submits
// ProjectStore through the developer portal, and the listing installs and runs
// from /plugin directory and from Desktop's Discover", decision 2)
//
//   node packaging/directory-branch.mjs --version X.Y.Z [--strip <path>]… [--remote <url|path>] [--dry-run] [--json]
//
// Anthropic's directory tracks one branch of this repository, `directory`, and
// scans each new commit on it. Its tree is the core's npm packlist: no
// lockfile, no tests/, site/ or packaging/, the plugin at the root (so
// .mcp.json's ${CLAUDE_PROJECT_DIR} stays legal). release.yml's `directory`
// job runs this after the core publish, for a stable release only, so the
// directory scans release commits, each with its raised version, and a merge
// that changes only the site is no directory version.
//
// The tree is the core's own pack tarball, never the registry's copy (the
// same rule as the shells' build): packCore(), unpacked with tar -p so the
// modes are the tarball's. Three lists must agree before anything is
// committed — npm pack's file list, tests/fixtures/packlist.json and the
// unpacked tree — and the tree's .claude-plugin/plugin.json, where the
// directory reads the version, must name the release. The commit is built
// from that list alone (hash-object --no-filters, update-index), so no
// .gitignore, attribute or autocrlf setting can change a byte or drop a file,
// and the committed tree is read back and compared with the list once more.
//
// The branch keeps its history: the tree becomes the next commit on it, or an
// orphan commit when the branch is missing. A tree equal to the branch's head
// commits nothing, so re-running a tag is safe. The branch never moves
// backwards: a release older than the one it carries leaves it as it is (a
// re-run of an old tag recovers that tag's publishes, not the directory). A
// version it carries already, with another tree, is refused — on the branch,
// as on npm, a version is committed once.
//
// Git runs in a scratch bare repository, never in the checkout: the branch is
// fetched at depth 1, the commit pushed without force, so a branch moved by
// someone else in between fails the push instead of being overwritten. The
// remote is https://github.com/<GITHUB_REPOSITORY>.git with GH_TOKEN in its
// URL — the workflow's checkout keeps persist-credentials: false, so the
// token reaches git here and nowhere else — or --remote (a URL or a path; the
// tests use a bare repository). The token is never printed: everything git
// says passes through redact().
//
// The CLI moves stable releases only, as the workflow's gate does.
// --strip <path> drops a packed file from the tree; the default keeps every
// one. It exists for the story's open question — whether the branch carries
// .claude-plugin/marketplace.json — which the first Validate answers.
// --dry-run reads the branch and prints the plan; it commits and pushes
// nothing. Exit 0 when the branch carries the release (committed, unchanged,
// newer, or the plan printed), 1 when it could not, 2 on a usage error.
// Not a test: tests/release.test.mjs runs it against temporary repositories.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cmpPrecedence } from "../scripts/lib.mjs";
import { isSemver } from "../scripts/convergence.mjs";
import { PACKLIST } from "../scripts/version-guard.mjs";
import { ROOT, CORE, packCore } from "./shells.mjs";
import { DIRECTORY_BRANCH, DIRECTORY_VERSION_FILE, isPrerelease, repoSlug } from "./release-surfaces.mjs";

export const BRANCH = DIRECTORY_BRANCH;
export const VERSION_FILE = DIRECTORY_VERSION_FILE;

// The remote the branch is read from and pushed to: the repository over
// https, with the token in the URL when there is one. Null without a
// repository to name.
export function remoteFor({ env = process.env, repo = repoSlug({ env }) } = {}) {
  if (!repo) return null;
  return env.GH_TOKEN
    ? `https://x-access-token:${env.GH_TOKEN}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

// Every text this prints: the token's value, and any credentials in a URL,
// become ***, whatever git put in its message.
export function redact(text, env = process.env) {
  let s = String(text ?? "");
  if (env.GH_TOKEN) s = s.split(env.GH_TOKEN).join("***");
  return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

// Files under dir, as sorted relative paths with "/" — the packlist's form.
function treeFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(prefix ? join(dir, prefix) : dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...treeFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

function compare(have, want) {
  const h = new Set(have),
    w = new Set(want);
  return { unexpected: have.filter((f) => !w.has(f)), missing: want.filter((f) => !h.has(f)) };
}
const differs = (d) => d.unexpected.length > 0 || d.missing.length > 0;
const describe = (d) =>
  [
    d.unexpected.length && `not listed: ${d.unexpected.join(", ")}`,
    d.missing.length && `missing: ${d.missing.join(", ")}`,
  ]
    .filter(Boolean)
    .join("; ");

// `credential.helper=` empties the helper list for this run, so a by-hand push
// (GH_TOKEN="$(gh auth token)") never leaves the token in a keychain helper.
function git(gitDir, args, { env, index = null, input } = {}) {
  const r = spawnSync("git", ["-c", "credential.helper=", ...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args], {
    encoding: "utf8",
    input,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", ...(index && { GIT_INDEX_FILE: index }) },
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: r.stdout || "", err: (r.stderr || r.error?.message || "").trim() };
}

function readFixture(root) {
  try {
    return JSON.parse(readFileSync(resolve(root, PACKLIST), "utf8"));
  } catch (e) {
    return { error: `${PACKLIST}: ${e.message}` };
  }
}

function versionIn(text) {
  try {
    const v = JSON.parse(text)?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// One release onto the branch. `pack(dest)` returns { tgz, version, files }
// or { error } — packCore by default; the tests inject a tarball of their
// own. `fixture` is the packlist the pack must equal. Never throws for a
// failure it can name: { ok: false, error } instead.
// The one push this script makes: a fast-forward of the branch to the new
// commit, never forced (no flag, no `+` refspec). A concurrent move makes the
// push fail, and a re-run reads `unchanged` or `newer`.
export function pushArgs(remote, commit) {
  return ["push", "-q", remote, `${commit}:refs/heads/${BRANCH}`];
}

export function moveDirectoryBranch({
  version,
  remote,
  root = ROOT,
  strip = [],
  dryRun = false,
  pack = (dest) => packCore({ root, dest }),
  fixture = readFixture(root),
  env = process.env,
} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "ps-directory-"));
  try {
    return move({ version, remote, strip, dryRun, pack, fixture, env, scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function move({ version, remote, strip, dryRun, pack, fixture, env, scratch }) {
  const shown = redact(remote, env);
  let facts = { version, branch: BRANCH, remote: shown, stripped: [...strip] };
  const fail = (error) => ({ ok: false, ...facts, error: redact(error, env) });
  if (!isSemver(version)) return fail(`"${version}" is not a version`);
  if (fixture?.error) return fail(fixture.error);

  // The pack, held to npm's own list and to the committed fixture.
  const dest = join(scratch, "pack");
  mkdirSync(dest);
  const p = pack(dest);
  if (p.error) return fail(p.error);
  if (p.version !== version)
    return fail(`the pack is ${CORE}@${p.version}, not the release ${version} — run it from the release's checkout`);
  const files = [...p.files].sort();
  const notPacked = strip.filter((s) => !files.includes(s));
  if (notPacked.length) return fail(`--strip ${notPacked[0]}: not a packed file, so nothing would be stripped`);
  const toFixture = compare(files, [...fixture].sort());
  if (differs(toFixture)) return fail(`npm pack's file list is not ${PACKLIST}: ${describe(toFixture)}`);
  const list = files.filter((f) => !strip.includes(f));

  // The tarball, unpacked with its modes, equal to the list once stripped.
  const unpack = join(scratch, "unpack");
  mkdirSync(unpack);
  const tar = spawnSync("tar", ["-xzpf", p.tgz, "-C", unpack], { encoding: "utf8", timeout: 120000 });
  if (tar.status !== 0) return fail(`tar could not unpack ${basename(p.tgz)}: ${(tar.stderr || "").trim()}`);
  const tree = join(unpack, "package");
  for (const s of strip) rmSync(join(tree, s), { force: true });
  const onDisk = compare(treeFiles(tree), list);
  if (differs(onDisk)) return fail(`the unpacked tarball is not npm pack's file list: ${describe(onDisk)}`);
  let named = null;
  try {
    named = versionIn(readFileSync(join(tree, VERSION_FILE), "utf8"));
  } catch {}
  if (named !== version)
    return fail(
      `${VERSION_FILE} names ${named ?? "no version"}, not ${version} — the directory reads its version there`,
    );

  // The branch as it is.
  const g = join(scratch, "git");
  const run = (args, opts = {}) => git(g, args, { env, ...opts });
  const init = git(null, ["init", "-q", "--bare", g], { env });
  if (init.status !== 0) return fail(`git init failed: ${init.err}`);
  const head = run(["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${BRANCH}`]);
  if (head.status !== 0 && head.status !== 2)
    return fail(`reading the ${BRANCH} branch at ${shown} failed: ${head.err}`);
  let parent = null,
    parentTree = null,
    parentVersion = null;
  if (head.status === 0) {
    const f = run(["fetch", "-q", "--no-tags", "--depth=1", remote, `refs/heads/${BRANCH}`]);
    if (f.status !== 0) return fail(`fetching the ${BRANCH} branch failed: ${f.err}`);
    parent = run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).out.trim();
    parentTree = run(["rev-parse", "--verify", `${parent}^{tree}`]).out.trim();
    const shownFile = run(["show", `${parent}:${VERSION_FILE}`]);
    parentVersion = shownFile.status === 0 ? versionIn(shownFile.out) : null;
  }

  // The tree, from the list alone: each file's bytes as they are, its mode
  // executable or not, as git records it.
  const index = join(scratch, "index");
  const hashed = run(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: list.map((f) => join(tree, f)).join("\n") + "\n",
  });
  if (hashed.status !== 0) return fail(`git hash-object failed: ${hashed.err}`);
  const shas = hashed.out.trim().split("\n");
  const entries = list.map((f, i) => {
    const mode = statSync(join(tree, f)).mode & 0o100 ? "100755" : "100644";
    return `${mode} ${shas[i]}\t${f}\0`;
  });
  const indexed = run(["update-index", "--add", "-z", "--index-info"], { index, input: entries.join("") });
  if (indexed.status !== 0) return fail(`git update-index failed: ${indexed.err}`);
  const written = run(["write-tree"], { index });
  if (written.status !== 0) return fail(`git write-tree failed: ${written.err}`);
  const treeSha = written.out.trim();
  const listed = run(["ls-tree", "-r", "-z", "--full-tree", treeSha]);
  const committed = listed.out
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf("\t") + 1))
    .sort();
  const inTree = compare(committed, list);
  if (differs(inTree)) return fail(`the tree to commit is not the list: ${describe(inTree)}`);
  facts = { ...facts, files: committed.length, tree: treeSha, parent, parentVersion };

  if (parent && parentTree === treeSha) return { ok: true, action: "unchanged", ...facts, commit: parent };
  if (parent && isSemver(parentVersion)) {
    const c = cmpPrecedence(parentVersion, version);
    if (c > 0) return { ok: true, action: "newer", ...facts, commit: parent };
    if (c === 0)
      return fail(
        `the ${BRANCH} branch carries ${version} already, with another tree: a version is committed once — release a new version`,
      );
  }
  if (dryRun) return { ok: true, action: parent ? "would-commit" : "would-create", ...facts, commit: null };

  const message = [
    `v${version}: the packed tree of ${CORE}@${version}`,
    "",
    `npm pack's ${committed.length} files at the release${env.GITHUB_SHA ? ` (${env.GITHUB_SHA})` : ""}, committed by`,
    "packaging/directory-branch.mjs. Anthropic's directory tracks this branch.",
  ].join("\n");
  const made = run(["commit-tree", "--no-gpg-sign", treeSha, ...(parent ? ["-p", parent] : []), "-F", "-"], {
    input: message + "\n",
  });
  if (made.status !== 0) return fail(`git commit-tree failed: ${made.err}`);
  const commit = made.out.trim();
  facts = { ...facts, commit };
  const pushed = run(pushArgs(remote, commit));
  if (pushed.status !== 0) return fail(`pushing the ${BRANCH} branch failed: ${pushed.err}`);
  return { ok: true, action: parent ? "committed" : "created", ...facts };
}

// ─── CLI ────────────────────────────────────────────────────────────────

const USAGE =
  "usage: node packaging/directory-branch.mjs --version X.Y.Z [--strip <path>]… [--remote <url|path>] [--dry-run] [--json]";

const short = (sha) => (sha ? sha.slice(0, 12) : "none");

function say(r) {
  const n = `${r.files} files, tree ${short(r.tree)}`;
  const lines = {
    created: `${BRANCH}: created with v${r.version} as ${short(r.commit)}, an orphan commit (${n}); pushed to ${r.remote}`,
    committed: `${BRANCH}: v${r.version} committed as ${short(r.commit)} on ${short(r.parent)}, which carried ${r.parentVersion ?? "no version"} (${n}); pushed to ${r.remote}`,
    unchanged: `${BRANCH}: carries v${r.version} at ${short(r.commit)} already, the same tree — nothing to commit`,
    newer: `${BRANCH}: carries ${r.parentVersion} at ${short(r.commit)}, newer than ${r.version} — left as it is`,
    "would-commit": `${BRANCH} (dry run): v${r.version} would be the next commit on ${short(r.parent)}, which carries ${r.parentVersion ?? "no version"} (${n}); nothing pushed`,
    "would-create": `${BRANCH} (dry run): the branch is missing at ${r.remote}; v${r.version} would be its first commit, an orphan (${n}); nothing pushed`,
  };
  const out = [lines[r.action]];
  if (r.stripped.length) out.push(`stripped: ${r.stripped.join(", ")}`);
  return out.join("\n") + "\n";
}

export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, ...deps } = {}) {
  const usage = (why) => {
    stderr.write(`directory-branch: ${why}\n${USAGE}\n`);
    return 2;
  };
  let raw = null,
    remote = null,
    dryRun = false,
    json = false;
  const strip = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "--strip" || a === "--remote") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return usage(`${a} takes a value`);
      if (a === "--version") raw = v;
      else if (a === "--remote") remote = v;
      else strip.push(v.replace(/^\.\//, ""));
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else return usage(`unknown argument ${a}`);
  }
  if (raw == null) return usage("--version is required");
  const version = raw.replace(/^v/, "");
  if (!isSemver(version)) return usage(`"${raw}" is not a version`);
  // release.yml's gate says the same: a candidate never reaches the
  // directory's users. The function itself takes any version, so the suite
  // can move a branch with the checkout's own pack in a candidate window too.
  if (isPrerelease(version))
    return usage(`${version} is a prerelease: the ${BRANCH} branch carries stable releases only`);
  const target = remote ?? remoteFor({ env });
  if (!target) return usage("no GitHub repository: set GITHUB_REPOSITORY=owner/name, or pass --remote");
  if (!remote && !env.GH_TOKEN && !dryRun)
    return usage('pushing needs GH_TOKEN (by hand: GH_TOKEN="$(gh auth token)"), or --remote');

  const r = moveDirectoryBranch({ version, remote: target, strip, dryRun, env, ...deps });
  if (json) stdout.write(JSON.stringify(r, null, 2) + "\n");
  else if (r.ok) stdout.write(say(r));
  if (!r.ok) {
    if (!json) stderr.write(`directory-branch: ${r.error}\n`);
    if (env.GITHUB_ACTIONS && !json) {
      // A workflow command's data escapes %, CR and LF, or a multi-line git
      // error shows only its first line in the annotation.
      const data = String(r.error).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      stdout.write(`::error title=${BRANCH} branch::${data}\n`);
    }
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

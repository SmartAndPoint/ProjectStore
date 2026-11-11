#!/usr/bin/env node
// projectstore — diff-refs.mjs (PS-SPEC story-009)
// Computes the files a story touched, for the reviewer's proposed code_refs.
// Our own extension: neither Backlog.md nor projectstore derived code mapping
// from git before this. Pure compute — the write path stays
// /projectstore:codemap set, approval-gated.
//
//   node diff-refs.mjs --since <iso-timestamp> [--range <git-range>]
//
// Range derivation is STORY-SCOPED: `--since` is the story's started_at (set
// by /projectstore:story plan). Branch-wide ranges (merge-base..HEAD) are
// deliberately not the default — shared feature branches over-attribute and
// direct-to-main work yields an empty diff (research note, adoption item 3).
// Output: { since, range, files, uncommitted, fallback } — fallback=true
// means the caller must ask the user for an explicit range instead of
// guessing.
//
// Git runs in the PROJECT (the directory the harness hands us) for these
// helpers. The one caller that reads the vault's repository is the pre-commit
// check (precommit.mjs), through gitRun below, with read-only subcommands
// (rev-parse, status, cat-file) and nothing that commits, pushes or fetches.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, SOURCE_IGNORE } from "./lib.mjs";

// One definition, in lib.mjs, shared with the entry-rule hook and doctor —
// three consumers of "is this a source file" that must not drift apart.
const IGNORE = SOURCE_IGNORE;

// The default 15 s is a batch budget — diff-refs runs off the hot path. A caller
// on a user-facing path must pass its own: SessionStart's gather budget is 200 ms,
// so a stalled git there would hold session start for fifteen seconds.
export function gitIn(cwd, args, { timeout = 15000 } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
  });
  return r.status === 0 ? r.stdout : null;
}

const git = (args) => gitIn(projectRoot(), args);

// A git run that tells an answer from no repository and from a failure,
// unlike gitIn's null for all three: {kind: "answer", status, stdout (bytes),
// stderr} whatever the exit code (`rev-parse --verify` exits 1 as an answer),
// {kind: "no-git"} outside a repository, {kind: "failure", reason} for no git
// binary, a timeout, a signal or an output past maxBuffer. `env` is the
// caller's, already stripped of what locates another repository; optional
// locks are off, so `git status` never refreshes the index.
export function gitRun(cwd, args, { env = process.env, timeout = 10000, maxBuffer = 128 * 1024 * 1024 } = {}) {
  let r;
  try {
    r = spawnSync("git", args, {
      cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      timeout,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { kind: "failure", reason: String((e && e.message) || e) };
  }
  if (r.error?.code === "ENOENT") return { kind: "failure", reason: "git is not installed" };
  if (r.error?.code === "ETIMEDOUT" || r.signal) return { kind: "failure", reason: `git ${args[0]} timed out` };
  if (r.error) return { kind: "failure", reason: String(r.error.message || r.error) };
  const stderr = String(r.stderr || "");
  if (r.status !== 0 && /not a git repository/i.test(stderr)) return { kind: "no-git" };
  return { kind: "answer", status: r.status, stdout: r.stdout || Buffer.alloc(0), stderr };
}

// Doctor's only route to git. Kept here rather than in lib.mjs, whose header
// pins it as dependency-free with no subprocess anywhere.
export function uncommittedProjectFiles(cwd = projectRoot(), ignore = IGNORE) {
  // A non-repository, a shallow clone with no HEAD, or a detached worktree with
  // no commits all make these fail — null means "cannot tell", which is not the
  // same as "nothing uncommitted" and must not be reported as a finding.
  const tracked = gitIn(cwd, ["diff", "--name-only", "HEAD"]);
  const untracked = gitIn(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null && untracked === null) return null;
  return [...new Set([...(tracked || "").split("\n"), ...(untracked || "").split("\n")])]
    .map((f) => f.trim())
    .filter((f) => f && !ignore.some((rx) => rx.test(f)))
    .sort();
}

// Newest commit timestamp, ms, or null when git cannot answer.
export function lastCommitMs(cwd = projectRoot()) {
  const out = gitIn(cwd, ["log", "-1", "--format=%cI"]);
  if (!out) return null;
  const t = Date.parse(out.trim());
  return Number.isFinite(t) ? t : null;
}

// The citation scan (the spec policy ADR, Decision 7): every line in the
// project, untracked files included, that looks like a contract citation.
// `.gitignore` is honoured, `exclude` paths (the vault, when it sits inside
// the project) are skipped, and SOURCE_IGNORE paths are dropped. Unlike gitIn
// this tells "no match" (status ok, no lines) from "not a repository"
// (no-git) and from every other failure — no git binary, a timeout, an exit
// git explains on stderr (unknown, with that reason): only the first is an
// answer.
export function grepProjectLines(cwd, pattern, { exclude = [], timeout = 10000, ignore = IGNORE } = {}) {
  const args = [
    "grep",
    "--untracked",
    "-n",
    "-I",
    "-E",
    "-e",
    pattern,
    "--",
    ".",
    ...exclude.map((p) => `:(exclude)${p}`),
  ];
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") return { status: "unknown", reason: "git is not installed", lines: [] };
  if (r.error || r.signal) return { status: "unknown", reason: "the scan timed out", lines: [] };
  if (r.status === 1) return { status: "ok", lines: [] };
  if (/not a git repository/i.test(r.stderr || "")) return { status: "no-git", lines: [] };
  if (r.status !== 0) {
    const why = (r.stderr || "").trim().split("\n")[0] || `git exited ${r.status}`;
    return { status: "unknown", reason: why, lines: [] };
  }
  const lines = [];
  for (const raw of r.stdout.split("\n")) {
    const m = raw.match(/^(.*?):(\d+):(.*)$/);
    if (!m || ignore.some((rx) => rx.test(m[1]))) continue;
    lines.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return { status: "ok", lines };
}

// Doctor's flow activity (the flow-findings spec, contracts 1 to 3): the
// local commits since `since`, one `git log` for the run. Reachable from a
// local branch, a remote-tracking branch the machine already has, or HEAD
// (a detached HEAD counts); no merge commit, and a stash entry is not on any
// of those refs. Names and times only, through .mailmap (`%aN`, `%cN`): no
// email address is ever asked for. Paths are relative to `cwd` (the project
// root), and a path outside it is not listed; a commit that changed nothing
// under it still comes back, with no paths. `-z` keeps a non-ASCII path as
// written. Git runs with LC_ALL=C, so its output does not follow the locale.
// When git cannot answer, the reason is one of a fixed set, never git's
// stderr: `no-git`, `not-a-repository`, `shallow`, `timeout`, `failed`.
// Returns {status: "ok", commits: [{authorName, authorMs, committerName,
// committerMs, paths}]} or {status: "unknown", reason}.
export const ACTIVITY_REASONS = Object.freeze(["no-git", "not-a-repository", "shallow", "timeout", "failed"]);
const LOG_FORMAT = "--format=%x1e%at%x1f%aN%x1f%ct%x1f%cN";
export function commitsSince(cwd, since, { timeout = 10000, env = process.env } = {}) {
  const opts = { cwd, encoding: "utf8", timeout, env: { ...env, LC_ALL: "C" }, maxBuffer: 256 * 1024 * 1024 };
  const why = (r) => {
    if (r.error?.code === "ENOENT") return "no-git";
    if (r.error || r.signal) return r.error?.code === "ETIMEDOUT" || r.signal ? "timeout" : "failed";
    if (r.status !== 0) return /not a git repository/i.test(r.stderr || "") ? "not-a-repository" : "failed";
    return null;
  };
  const probe = spawnSync("git", ["rev-parse", "--is-shallow-repository"], opts);
  const probeWhy = why(probe);
  if (probeWhy) return { status: "unknown", reason: probeWhy };
  if (String(probe.stdout).trim() === "true") return { status: "unknown", reason: "shallow" };
  const run = (head) =>
    spawnSync(
      "git",
      [
        "log",
        "--branches",
        "--remotes",
        ...head,
        "--no-merges",
        "--no-show-signature",
        "-z",
        "--name-only",
        "--relative",
        `--since=${since}`,
        LOG_FORMAT,
        "--",
      ],
      opts,
    );
  let r = run(["HEAD"]);
  // A repository with no commit on HEAD (a fresh one, an unborn branch):
  // HEAD names nothing, and the branches are read without it.
  if (r.status !== 0 && !r.error && /bad revision 'HEAD'|unknown revision[^\n]*HEAD/.test(r.stderr || "")) r = run([]);
  const runWhy = why(r);
  if (runWhy) return { status: "unknown", reason: runWhy };
  const commits = [];
  for (const chunk of String(r.stdout).split("\x1e")) {
    if (!chunk) continue;
    const cut = chunk.indexOf("\0");
    const head = (cut === -1 ? chunk : chunk.slice(0, cut)).split("\x1f");
    if (head.length !== 4) continue;
    const [at, authorName, ct, committerName] = head;
    const paths = (cut === -1 ? "" : chunk.slice(cut + 1))
      .split("\0")
      .map((p) => p.replace(/^\n/, ""))
      .filter(Boolean);
    commits.push({ authorName, authorMs: Number(at) * 1000, committerName, committerMs: Number(ct) * 1000, paths });
  }
  return { status: "ok", commits };
}

// The `--since` window git is given, shared with spec-drift.mjs.
//
// A bare YYYY-MM-DD gets midnight appended, and it is not cosmetic. Git's
// approxidate reads a date with no time as THAT DATE AT THE CURRENT TIME OF
// DAY, so `--since=2026-09-08` run at 17:46 silently excludes everything
// committed earlier the same day. `started_at` is written as a bare date,
// so a story started and finished in one day proposed `files: []` and the
// caller had no way to tell that from "nothing was committed" (measured
// 2026-09-08: --since=2026-09-08 returned nothing while
// --since="2026-09-08 00:00" returned the day's commit).
export function sinceWindow(since) {
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since} 00:00:00` : since;
}

function filterFiles(list) {
  return [...new Set(list)]
    .map((f) => f.trim())
    .filter((f) => f && !IGNORE.some((rx) => rx.test(f)))
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
  const range = args.includes("--range") ? args[args.indexOf("--range") + 1] : null;

  let committed = [];
  let usedRange = null;
  if (range) {
    const out = git(["diff", "--name-only", range]);
    if (out === null) {
      process.stdout.write(JSON.stringify({ error: `git diff ${range} failed`, fallback: true }) + "\n");
      return;
    }
    committed = out.split("\n");
    usedRange = range;
  } else if (since) {
    // committer-date window; work committed before the story went in-progress
    // is invisible by design (story-scoped attribution).
    const window = sinceWindow(since);
    const out = git(["log", `--since=${window}`, "--name-only", "--pretty=format:"]);
    committed = out ? out.split("\n") : [];
    usedRange = `--since=${window}`;
  }

  // ls-files --others expands untracked DIRECTORIES to individual files
  // (porcelain would collapse them to "tests/") and needs no column slicing.
  const uncommitted = filterFiles([
    ...(git(["diff", "--name-only", "HEAD"]) || "").split("\n"),
    ...(git(["ls-files", "--others", "--exclude-standard"]) || "").split("\n"),
  ]);
  const files = filterFiles(committed);

  const fallback = (!range && !since) || (files.length === 0 && uncommitted.length === 0);
  process.stdout.write(
    JSON.stringify(
      {
        since: since || null,
        range: usedRange,
        files,
        uncommitted,
        fallback,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

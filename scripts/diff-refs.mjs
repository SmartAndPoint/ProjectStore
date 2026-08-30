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
// Git runs in the PROJECT (CLAUDE_PROJECT_DIR), never the vault — the vault
// is typically not a git repository.

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
    const out = git(["log", `--since=${since}`, "--name-only", "--pretty=format:"]);
    committed = out ? out.split("\n") : [];
    usedRange = `--since=${since}`;
  }

  // ls-files --others expands untracked DIRECTORIES to individual files
  // (porcelain would collapse them to "tests/") and needs no column slicing.
  const uncommitted = filterFiles([
    ...(git(["diff", "--name-only", "HEAD"]) || "").split("\n"),
    ...(git(["ls-files", "--others", "--exclude-standard"]) || "").split("\n"),
  ]);
  const files = filterFiles(committed);

  const fallback = !range && !since || (files.length === 0 && uncommitted.length === 0);
  process.stdout.write(JSON.stringify({
    since: since || null,
    range: usedRange,
    files,
    uncommitted,
    fallback,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

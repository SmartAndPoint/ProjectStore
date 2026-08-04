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
import { projectRoot } from "./lib.mjs";

const IGNORE = [
  /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//,
  /(^|\/)\.claude\//, /\.min\.(js|css)$/,
];

function git(args) {
  const r = spawnSync("git", args, {
    cwd: projectRoot(),
    encoding: "utf8",
    timeout: 15000,
  });
  return r.status === 0 ? r.stdout : null;
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

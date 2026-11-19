// projectstore — test fixture: a `git` first on PATH that records its own
// calls and runs the real git (the spec with alias `dashboard-code`,
// "Testing": the read's calls as git itself saw them, beside the spawn record).
//
//   gitRecorder(dir) → { bin, dir, log(), env(base) }
//
// The recorder is a node script named `git` whose interpreter is this Node's
// own path. It appends { argv, cwd, lazy } to calls.jsonl beside itself, where
// `lazy` is GIT_NO_LAZY_FETCH as it saw it, then runs the real git (found on
// the PATH the recorder was made with) with the same argv, stdin, stdout and
// stderr, and exits with its status. `env(base)` puts the recorder's folder
// first on base's PATH.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

// The real git, by its absolute path, so the recorder never runs itself.
export function realGit() {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  const path = String(r.stdout || "")
    .split("\n")[0]
    .trim();
  if (!path) throw new Error("no git on PATH");
  return path;
}

export function gitRecorder(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "git");
  const script = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), lazy: process.env.GIT_NO_LAZY_FETCH ?? null }) + "\\n");
const r = cp.spawnSync(${JSON.stringify(realGit())}, argv, { stdio: "inherit" });
process.exitCode = r.status === null ? 1 : r.status;
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return {
    bin,
    dir,
    log() {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    env(base) {
      return { ...base, PATH: [dir, base.PATH || ""].join(delimiter) };
    },
  };
}

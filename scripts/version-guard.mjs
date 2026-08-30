#!/usr/bin/env node
// projectstore — version-guard.mjs (PS-HARNESS: "Claim the npm name and ship
// the first release")
//
// The release-time guard. It did not exist before this story: ADR-009 and the
// harness-landscape research note both describe "the version-check guard" as
// something already in place, and neither was true — there was no script, no
// test and no CI step. Doctor's version checks are a different guard entirely
// (runtime: an installed plugin against the marketplace), and they stay.
//
//   node scripts/version-guard.mjs [--tag vX.Y.Z] [--json]
//   node scripts/version-guard.mjs --write-packlist
//
// Checks that every version-bearing manifest agrees, and — when --tag is
// given — that the release tag agrees with them. CI passes the tag; a human
// running it before a manual publish does not, because publish #1 is not
// tag-triggered and nothing else covers it.
//
// Exit 0 when everything agrees, 1 on disagreement or a malformed manifest.
// Output is JSON on stdout, always, so a workflow step can quote it.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Contract 2 of the atomic-regeneration work: nothing under scripts/ writes
// directly, and tests/scripts.test.mjs enforces it by globbing this directory.
import { writeFileAtomic } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKLIST = "tests/fixtures/packlist.json";

// Every file that carries the release version, and how to read it out. A
// manifest that does not exist yet is skipped, not failed: `.codex-plugin/`
// arrives with the Codex story, and the guard must not block the releases
// before it.
const VERSION_SITES = [
  ["package.json", (j) => j.version],
  [".claude-plugin/plugin.json", (j) => j.version],
  [".claude-plugin/marketplace.json", (j) => j.plugins?.[0]?.version],
  [".codex-plugin/plugin.json", (j) => j.version],
];

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
  } catch (e) {
    die(`${rel}: ${e.message}`);
  }
}

export function collectVersions(root = ROOT) {
  const found = [];
  for (const [rel, pick] of VERSION_SITES) {
    if (!existsSync(resolve(root, rel))) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(resolve(root, rel), "utf8"));
    } catch (e) {
      return { error: `${rel}: ${e.message}` };
    }
    const version = pick(json);
    if (typeof version !== "string" || !version) {
      return { error: `${rel}: no version found where one is required` };
    }
    found.push({ file: rel, version });
  }
  return { found };
}

// `v0.25.0` and `0.25.0` are the same release; the tag carries the prefix by
// this repository's convention and the manifests never do.
const stripV = (t) => (t.startsWith("v") ? t.slice(1) : t);

export function checkVersions({ root = ROOT, tag = null } = {}) {
  const { found, error } = collectVersions(root);
  if (error) return { ok: false, error };

  const sites = tag ? [...found, { file: "<tag>", version: stripV(tag) }] : found;
  const distinct = [...new Set(sites.map((s) => s.version))];

  return distinct.length === 1
    ? { ok: true, version: distinct[0], checked: sites }
    : {
        ok: false,
        error: "version mismatch",
        versions: distinct,
        checked: sites,
      };
}

// The packlist is the second release-time invariant: what npm would actually
// ship. Stored as sorted paths only — sizes churn on every content edit and
// would make the fixture unreviewable.
export function currentPacklist(root = ROOT) {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0) return { error: `npm pack failed: ${r.stderr?.trim()}` };
  try {
    const [pkg] = JSON.parse(r.stdout);
    return { files: pkg.files.map((f) => f.path).sort() };
  } catch (e) {
    return { error: `npm pack output unparseable: ${e.message}` };
  }
}

function main(argv) {
  const tagIdx = argv.indexOf("--tag");
  const tag = tagIdx !== -1 ? argv[tagIdx + 1] : null;
  if (tagIdx !== -1 && !tag) die("--tag requires a value");

  if (argv.includes("--write-packlist")) {
    const { files, error } = currentPacklist();
    if (error) die(error);
    writeFileAtomic(resolve(ROOT, PACKLIST), JSON.stringify(files, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({ ok: true, wrote: PACKLIST, count: files.length }) + "\n",
    );
    return;
  }

  const result = checkVersions({ tag });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

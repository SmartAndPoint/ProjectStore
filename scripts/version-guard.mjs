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
//   node scripts/version-guard.mjs [--tag vX.Y.Z]
//   node scripts/version-guard.mjs --write-packlist
//
// Checks that every version-bearing manifest agrees, and — when --tag is
// given — that the release tag agrees with them. CI passes the tag; a human
// running it before a manual publish does not, because publish #1 is not
// tag-triggered and nothing else covers it.
//
// Exit 0 when everything agrees, 1 on disagreement or a malformed manifest.
// Output is JSON on stdout, always, so a workflow step can quote it.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Contract 2 of the atomic-regeneration work: nothing under scripts/ writes
// directly, and tests/scripts.test.mjs enforces it by globbing this directory.
import { writeFileAtomic } from "./lib.mjs";
import { LAYOUT } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKLIST = "tests/fixtures/packlist.json";

// [path, how to read the version, required]. Required sites must exist: with
// everything optional, a checkout missing package.json reported agreement,
// because "no site disagrees" is trivially true when there are no sites.
// `.codex-plugin/` is the deliberate exception — it arrives with the Codex
// story, and releases before then must not be blocked by its absence.
const VERSION_SITES = [
  ["package.json", (j) => j.version, true],
  [".claude-plugin/plugin.json", (j) => j.version, true],
  // Found by name, not by position: `plugins[0]` reads a sibling plugin's
  // version the moment the marketplace lists more than one, and reports the
  // disagreement against the wrong file.
  [
    ".claude-plugin/marketplace.json",
    (j) => j.plugins?.find((p) => p.name === "projectstore")?.version,
    true,
  ],
  [".codex-plugin/plugin.json", (j) => j.version, false],
];

// The distribution shells (the shells ADR; layout spec contract 11): one
// package.json per shell under packaging/shells/, each at the core's version
// with an exact pin on it. Read directly — the directory is in the repository
// but not in the tarball, and the guard runs from the repository.
export const SHELLS_DIR = "packaging/shells";

export function collectShells(root = ROOT) {
  const dir = resolve(root, SHELLS_DIR);
  if (!existsSync(dir)) return { shells: [] };
  const shells = [];
  // Directories only: a .DS_Store Finder drops on a browse is not a shell.
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const rel = `${SHELLS_DIR}/${name}/package.json`;
    const abs = resolve(root, rel);
    if (!existsSync(abs)) return { error: `${rel}: missing — every directory under ${SHELLS_DIR}/ is a shell` };
    let json;
    try { json = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { return { error: `${rel}: ${e.message}` }; }
    if (json.name !== name) return { error: `${rel}: name "${json.name}" is not its directory's` };
    if (typeof json.version !== "string" || !json.version) return { error: `${rel}: no version found where one is required` };
    shells.push({
      name, file: rel, version: json.version,
      pin: json.dependencies?.projectstore ?? null,
      private: json.private === true,
      bin: json.bin?.[name] ?? null,
      binExists: typeof json.bin?.[name] === "string" && existsSync(resolve(root, SHELLS_DIR, name, json.bin[name])),
      bundled: Array.isArray(json.bundleDependencies) && json.bundleDependencies.includes("projectstore"),
    });
  }
  return { shells };
}

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

export function collectVersions(root = ROOT) {
  const found = [];
  for (const [rel, pick, required] of VERSION_SITES) {
    if (!existsSync(resolve(root, rel))) {
      if (required) return { error: `${rel}: missing, and it carries the release version` };
      continue;
    }
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
  const sh = collectShells(root);
  if (sh.error) return { ok: false, error: sh.error };

  // A shell's version is one more site under the same rule.
  const sites = [...found, ...sh.shells.map((s) => ({ file: s.file, version: s.version }))];
  if (tag) sites.push({ file: "<tag>", version: stripV(tag) });
  const distinct = [...new Set(sites.map((s) => s.version))];
  if (distinct.length !== 1) return { ok: false, error: "version mismatch", versions: distinct, checked: sites };

  // Its pin is exact and equal to that version; its core is bundled; its bin
  // is the one file it ships. A range here is the unverified pairing the
  // shells ADR rejects; a missing bundle ships an installer with no core.
  for (const s of sh.shells) {
    if (s.pin !== `=${s.version}`) return { ok: false, error: "shell pin mismatch", shell: s.name, pin: s.pin, expected: `=${s.version}`, checked: sites };
    if (!s.bundled) return { ok: false, error: "shell does not bundle the core", shell: s.name, checked: sites };
    if (s.bin !== `bin/${s.name}.mjs` || !s.binExists) return { ok: false, error: "shell bin missing or misnamed", shell: s.name, bin: s.bin, expected: `bin/${s.name}.mjs`, checked: sites };
  }
  return { ok: true, version: distinct[0], checked: sites, shells: sh.shells.map((s) => ({ name: s.name, private: s.private })) };
}

// Everything at the repository root that is deliberately NOT in the tarball.
// This list is the whole point of the tree check below: `npm pack` can only
// report what `files[]` already allows, so comparing pack output against the
// fixture is blind to a directory missing from `files[]` — it is absent from
// both sides and they agree. The tree, not the pack output, is the only place
// a forgotten directory is visible.
//
// Adding a name here is a decision that it must never ship. Anything else new
// at the root fails the check until it is added to `files[]`.
export const NOT_SHIPPED = new Set([
  ".git",
  ".github", // release/test workflows — not part of the plugin payload
  ".claude", // local worktrees and the harness's own files
  LAYOUT.root, // this project's own binding, overlays and state (the layout ADR)
  ".omc",
  ".gitignore",
  ".DS_Store",
  "node_modules",
  "CLAUDE.md", // a pointer to AGENTS.md, which does ship
  "tests", // 240 kB of fixtures nobody installing the plugin needs
  "packaging", // reserved-name stubs; see packaging/README.md
  "package-lock.json",
]);

// Top-level entries that are neither shipped nor deliberately excluded. Kept
// pure — it takes the tree listing rather than reading it — so a test can hand
// it a directory that does not exist and watch it fail.
export function unshippedTopLevel(entries, packlist) {
  const shipped = new Set(
    packlist.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : p)),
  );
  return entries
    .filter((e) => e !== "." && e !== ".." && !shipped.has(e) && !NOT_SHIPPED.has(e))
    .sort();
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

async function main(argv) {
  const tagIdx = argv.indexOf("--tag");
  const tag = tagIdx !== -1 ? argv[tagIdx + 1] : null;
  if (tagIdx !== -1 && !tag) die("--tag requires a value");

  if (argv.includes("--write-packlist")) {
    const { files, error } = currentPacklist();
    if (error) die(error);
    try {
      writeFileAtomic(resolve(ROOT, PACKLIST), JSON.stringify(files, null, 2) + "\n");
    } catch (e) {
      // The header promises JSON on stdout always; an escaping stack trace
      // would break the one caller that parses this.
      die(`${PACKLIST}: ${e.message}`);
    }
    // The shells' fixtures, from the core's CURRENT pack — after the core's
    // fixture, since each lists the core's files under node_modules/. A lazy
    // import: scripts/ ships and packaging/ does not, so a static specifier
    // here would ship a module that cannot load.
    const shellsModule = resolve(ROOT, "packaging", "shells.mjs");
    const shells = [];
    if (existsSync(shellsModule)) {
      const m = await import(pathToFileURL(shellsModule).href);
      const built = m.buildShells({ root: ROOT });
      if (built.error) die(built.error);
      for (const b of built.shells) {
        if (b.error) die(b.error);
        const rel = m.shellPacklistPath(b.name);
        try { writeFileAtomic(resolve(ROOT, rel), JSON.stringify(b.files, null, 2) + "\n"); } catch (e) { die(`${rel}: ${e.message}`); }
        shells.push({ wrote: rel, count: b.files.length });
      }
    }
    process.stdout.write(
      JSON.stringify({ ok: true, wrote: PACKLIST, count: files.length, shells }) + "\n",
    );
    return;
  }

  const result = checkVersions({ tag });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

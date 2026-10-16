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
// Then, with or without --tag, that the version has its release notes
// (PS-HARNESS: "A release tag shows on every surface…"): the file
// packaging/release-notes/v<version>.md, headed `# v<version> — <title>`, with
// a body. The release workflow makes the GitHub Release from that file, so a
// version without one is refused here — in the release PR, by test.yml and
// `npm run release:check` — rather than on the tag.
//
// Exit 0 when everything agrees, 1 on disagreement, a malformed manifest or
// missing notes.
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
const VERSION_SITES = [
  ["package.json", (j) => j.version, true],
  [".claude-plugin/plugin.json", (j) => j.version, true],
  // Found by name, not by position: `plugins[0]` reads a sibling plugin's
  // version the moment the marketplace lists more than one, and reports the
  // disagreement against the wrong file.
  [".claude-plugin/marketplace.json", (j) => j.plugins?.find((p) => p.name === "projectstore")?.version, true],
  // No package-lock.json: the root holds none since the lint toolchain moved to
  // tools/lint/ (the PS-DIRECTORY story "Dev dependencies stay out of every
  // user's plugin copy"), and tools/lint/'s own lockfile carries no version.
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
  for (const name of readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const rel = `${SHELLS_DIR}/${name}/package.json`;
    const abs = resolve(root, rel);
    if (!existsSync(abs)) return { error: `${rel}: missing — every directory under ${SHELLS_DIR}/ is a shell` };
    let json;
    try {
      json = JSON.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      return { error: `${rel}: ${e.message}` };
    }
    if (json.name !== name) return { error: `${rel}: name "${json.name}" is not its directory's` };
    if (typeof json.version !== "string" || !json.version)
      return { error: `${rel}: no version found where one is required` };
    const pluginVersions = [];
    if (name === "projectstore-codex") {
      // A root plugin.json is an Agent Plugins manifest Codex picks first, and
      // Codex loads no hooks from that format (openai/codex#37027, merged
      // 2026-08-05): every hook goes missing.
      if (existsSync(resolve(root, SHELLS_DIR, name, "plugin.json"))) {
        return {
          error: `${SHELLS_DIR}/${name}/plugin.json: refused — Codex picks a root Agent Plugins manifest first and loads no hooks from it (openai/codex#37027; codex-rs/core-plugins/src/loader.rs); the shell's manifest is .codex-plugin/plugin.json alone`,
        };
      }
      for (const manifest of [".codex-plugin/plugin.json"]) {
        const manifestRel = `${SHELLS_DIR}/${name}/${manifest}`;
        const manifestAbs = resolve(root, manifestRel);
        if (!existsSync(manifestAbs)) return { error: `${manifestRel}: missing — the Codex shell's one manifest` };
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(manifestAbs, "utf8"));
        } catch (e) {
          return { error: `${manifestRel}: ${e.message}` };
        }
        if (typeof parsed.version !== "string" || !parsed.version)
          return { error: `${manifestRel}: no version found where one is required` };
        pluginVersions.push({ file: manifestRel, version: parsed.version });
      }
    }
    shells.push({
      name,
      file: rel,
      version: json.version,
      pin: json.dependencies?.projectstore ?? null,
      private: json.private === true,
      bin: json.bin?.[name] ?? null,
      binExists: typeof json.bin?.[name] === "string" && existsSync(resolve(root, SHELLS_DIR, name, json.bin[name])),
      bundled: Array.isArray(json.bundleDependencies) && json.bundleDependencies.includes("projectstore"),
      pluginVersions,
    });
  }
  return { shells };
}

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

export function collectVersions(root = ROOT) {
  if (existsSync(resolve(root, ".codex-plugin", "plugin.json"))) {
    return {
      error: ".codex-plugin/plugin.json must live in the projectstore-codex shell, not at the core package root",
    };
  }
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
  const sites = [
    ...found,
    ...sh.shells.flatMap((s) => [{ file: s.file, version: s.version }, ...(s.pluginVersions || [])]),
  ];
  if (tag) sites.push({ file: "<tag>", version: stripV(tag) });
  const distinct = [...new Set(sites.map((s) => s.version))];
  if (distinct.length !== 1) return { ok: false, error: "version mismatch", versions: distinct, checked: sites };

  // Its pin is exact and equal to that version; its core is bundled; its bin
  // is the one file it ships. A range here is the unverified pairing the
  // shells ADR rejects; a missing bundle ships an installer with no core.
  for (const s of sh.shells) {
    if (s.pin !== `=${s.version}`)
      return {
        ok: false,
        error: "shell pin mismatch",
        shell: s.name,
        pin: s.pin,
        expected: `=${s.version}`,
        checked: sites,
      };
    if (!s.bundled) return { ok: false, error: "shell does not bundle the core", shell: s.name, checked: sites };
    if (s.bin !== `bin/${s.name}.mjs` || !s.binExists)
      return {
        ok: false,
        error: "shell bin missing or misnamed",
        shell: s.name,
        bin: s.bin,
        expected: `bin/${s.name}.mjs`,
        checked: sites,
      };
  }
  return {
    ok: true,
    version: distinct[0],
    checked: sites,
    shells: sh.shells.map((s) => ({ name: s.name, private: s.private })),
  };
}

// The release notes (PS-HARNESS: "A release tag shows on every surface…").
// Under packaging/, which never ships: the notes are the GitHub Release's
// source, read from the repository by the release workflow.
export const RELEASE_NOTES_DIR = "packaging/release-notes";
export const releaseNotesPath = (version) => `${RELEASE_NOTES_DIR}/v${version}.md`;

// The heading is the release's title as GitHub shows it, `v0.30.4 — <title>`
// (an em dash, as every release title since v0.6.0 carries), and the body is
// what the release says. Both must be there: a heading alone is the "tagged
// without release notes" of 0.28.0 again.
export function checkReleaseNotes({ root = ROOT, version }) {
  const rel = releaseNotesPath(version);
  const refuse = (what) => ({ ok: false, error: `${rel}: ${what}`, notes: rel });
  if (!existsSync(resolve(root, rel))) return refuse("missing — the release workflow makes the GitHub Release from it");
  const [first = "", ...rest] = readFileSync(resolve(root, rel), "utf8").split("\n");
  const heading = first.replace(/\r$/, "");
  // The version the heading names, up to a space or the dash: `# v0.30.4—x`
  // names 0.30.4 and fails the shape, not the version.
  const named = /^# v([^\s\u2014]+)/.exec(heading)?.[1];
  if (named !== undefined && named !== version) return refuse(`the heading names v${named}, not v${version}`);
  const prefix = `# v${version} — `;
  if (!heading.startsWith(prefix) || !heading.slice(prefix.length).trim())
    return refuse(`the first line must be "# v${version} — <title>"`);
  if (!rest.join("\n").trim()) return refuse("no body under the heading — the notes are the release's text");
  return { ok: true, notes: rel };
}

// The whole guard: the versions, then the notes for the version they agree
// on. `checkVersions` stays as it was, so its callers (the packaging and
// shells contracts) keep their scratch roots without notes.
export function runGuard({ root = ROOT, tag = null } = {}) {
  const v = checkVersions({ root, tag });
  if (!v.ok) return v;
  const n = checkReleaseNotes({ root, version: v.version });
  if (!n.ok) return { ...n, version: v.version, checked: v.checked };
  return { ...v, notes: n.notes };
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
  // `packaging/shells.mjs --build --out dist` writes here, and the release
  // workflow does exactly that. Gitignored, so it is invisible to git status —
  // and the tree check is the only place an unlisted root directory shows up.
  "dist",
  "CLAUDE.md", // a pointer to AGENTS.md, which does ship
  "tests", // 240 kB of fixtures nobody installing the plugin needs
  "packaging", // reserved-name stubs; see packaging/README.md
  "adapters", // generated harness inputs copied into their distribution shells at build time
  "site", // the public site: Pages serves it, npm never does
  // A root lockfile is refused by tests/packaging.test.mjs; listed so a stray
  // one fails that test rather than this tree check.
  "package-lock.json",
  // The lint and format tooling (the lint ADR): dev-only, never in the package.
  // tools/lint/ holds the tools' package.json, lockfile and config; the root's
  // eslint.config.mjs re-exports that config. Dev-only: nothing under tools/
  // ships, so a future tools/<x> meant to ship needs its own entry in `files`.
  "tools",
  "eslint.config.mjs",
  ".prettierrc.json",
  ".prettierignore",
  ".git-blame-ignore-revs",
  // Claude Code lays this beside a plugin folder it loads with --plugin-dir
  // (extending .claude-plugin/types/, which is gitignored and kept out of the
  // package too): the band module's type-check reads it, nobody installs it.
  "tsconfig.json",
]);

// Top-level entries that are neither shipped nor deliberately excluded. Kept
// pure — it takes the tree listing rather than reading it — so a test can hand
// it a directory that does not exist and watch it fail.
export function unshippedTopLevel(entries, packlist) {
  const shipped = new Set(packlist.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : p)));
  return entries.filter((e) => e !== "." && e !== ".." && !shipped.has(e) && !NOT_SHIPPED.has(e)).sort();
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
        try {
          writeFileAtomic(resolve(ROOT, rel), JSON.stringify(b.files, null, 2) + "\n");
        } catch (e) {
          die(`${rel}: ${e.message}`);
        }
        shells.push({ wrote: rel, count: b.files.length });
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, wrote: PACKLIST, count: files.length, shells }) + "\n");
    return;
  }

  const result = runGuard({ tag });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

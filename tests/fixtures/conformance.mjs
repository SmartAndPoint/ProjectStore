// projectstore — the harness conformance rows (PS-HARNESS: "Harness
// conformance: one fixture that installs, binds and configures every harness
// into a temp tree").
//
// This file is the DATA half, and it is the only file in the conformance pair
// allowed to name a harness. `tests/conformance.test.mjs` is the logic half and
// carries no id at all — the same split as `harnesses/*.json` against
// `scripts/*.mjs`, and the suite greps for it. Adding opencode is adding a
// manifest and a row here; anything that needs an `if` in the test is the test
// being wrong.
//
// What this pair does NOT cover, so nobody mistakes green for complete:
// nothing written OUTSIDE the project (a harness home, a registry stanza) is
// diffed; the CONTENT of what is written is not read, only its path — the
// agents block is one shared template today, and whether its prose suits a
// given harness is the generator's lint to answer (contract 10), not this
// fixture's; and the append/migrate path into an existing AGENTS.md or
// CLAUDE.md is `tests/install.test.mjs`'s, not a conformance row.
//
// A row says only what a manifest cannot: what an install ACTUALLY wrote,
// observed once and then held. Every other expectation in the test is derived —
// which file the agents block may land in, which directory belongs to someone
// else, which surface must produce nothing — because a derived expectation
// states a contract while a listed one only detects change.

import { mkdtempSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadHarnesses, harnessIds } from "../../scripts/harness.mjs";
import { fakeInstall, noHostEnv } from "./install.mjs";
import { writeBinding } from "./vault.mjs";

// One row per harness id. `writes` is the exact set of paths an install adds to
// a bound project, relative and sorted — the whole diff, so an unexpected file
// is a failure rather than a thing nobody looked at.
export const ROWS = Object.freeze({
  "claude-code": Object.freeze({
    writes: Object.freeze([
      ".claude/settings.local.json",
      ".projectstore/.gitignore",
      ".projectstore/state/.gitignore",
      ".projectstore/state/claude-code/statusline.mjs",
      "CLAUDE.md",
    ]),
    why: "The source harness with every surface it has: the agents block, the "
      + "status line (its entry in the harness's own settings file, its launcher "
      + "under the project's state directory) and the layout's two ignore files. "
      + "CLAUDE.md rather than AGENTS.md because its block list has two entries "
      + "and neither file existed — the known tie-break, asserted so a change to "
      + "it is a decision rather than a surprise.",
  }),
  codex: Object.freeze({
    writes: Object.freeze(["AGENTS.md"]),
    why: "One file, and that is the whole point of the row. Codex has no status "
      + "line, no registrable command, no plugin-loadable agents and no MCP "
      + "dialect of ours, so an install writes the agents block and stops. "
      + "AGENTS.md rather than CLAUDE.md is the defect measured on the smoke "
      + "stand 2026-09-07, where the rules had to be pasted in by hand.",
  }),
});

// The row, or a failure that says what to do about it. A manifest without a row
// is not a test that quietly skips: it is the suite refusing to pretend it
// covers a harness nobody has looked at.
export function row(id) {
  const r = ROWS[id];
  if (!r) {
    throw new Error(
      `no conformance row for the harness "${id}". Install it into an empty tree, `
      + `look at what appeared, and add a row to tests/fixtures/conformance.mjs — `
      + `the test itself needs no change.`,
    );
  }
  return r;
}

// Rows and manifests must be the same set, in both directions.
export function rowCoverage() {
  const ids = harnessIds();
  return {
    ids,
    rows: Object.keys(ROWS),
    missingRow: ids.filter((id) => !(id in ROWS)),
    orphanRow: Object.keys(ROWS).filter((id) => !ids.includes(id)),
  };
}

export const manifests = () => [...loadHarnesses().values()];

// Every file under `dir`, relative and sorted. Directories are not listed:
// an empty one is not something an install promised.
export function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

// A bound project in the shape the harness would be used from: its own
// directory present (that is how a project is detected), a binding written, and
// the status line asked for — so a harness that has one plans it and a harness
// that has none is seen to plan nothing rather than to have been asked nothing.
export function boundProject(harness, { vault = "/tmp/nowhere" } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "ps-conf-"));
  mkdirSync(join(proj, harness.runtime.harness_dir), { recursive: true });
  writeBinding(proj, JSON.stringify({ vault_path: vault, layout: "engineering", statusline: { enabled: true } }));
  return proj;
}

// The same project WITHOUT a binding: what the bind verb is given, so the
// assertions about the binding are about what bind wrote rather than about
// what a fixture constant said.
export function unboundProject(harness) {
  const proj = mkdtempSync(join(tmpdir(), "ps-conf-unbound-"));
  mkdirSync(join(proj, harness.runtime.harness_dir), { recursive: true });
  return proj;
}

// ONE project used from every harness at once — the arrangement the epic is
// for. Every manifest's directory is present, so detection answers all of
// them, and there is exactly one binding for the lot.
export function sharedProject({ vault = "/tmp/nowhere" } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "ps-conf-shared-"));
  for (const h of loadHarnesses().values()) mkdirSync(join(proj, h.runtime.harness_dir), { recursive: true });
  writeBinding(proj, JSON.stringify({ vault_path: vault, layout: "engineering", statusline: { enabled: true } }));
  return proj;
}

// A plugin cache to install from, one per case: the version is what the stamp
// records, and sharing one between cases would let a stamp from another test
// decide this one's state.
//
// KNOWN LIMIT, recorded rather than hidden: `fakeInstall` builds a cache root
// in the SOURCE harness's shape for every harness, because that is the only
// cache layout that has been measured. It costs nothing today — the only
// non-source harness has a single markdown-block surface, which does not read
// the root's shape — but the first harness with an `mjs` or `json-entry`
// surface will have its row measured against Claude Code's cache layout and
// `isPluginCacheRoot` will be answering Claude Code's question. Measure that
// harness's real cache root before trusting its row.
export function stand(version = "0.28.0") {
  const home = mkdtempSync(join(tmpdir(), "ps-conf-home-"));
  return { home, root: fakeInstall(home, version), env: noHostEnv() };
}

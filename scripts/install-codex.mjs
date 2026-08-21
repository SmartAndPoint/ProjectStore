#!/usr/bin/env node
// projectstore — install-codex.mjs
//
// Copies the generated Codex adapter into a Codex config directory, so Codex
// discovers projectstore's skills, prompts, agents and hooks the way it
// discovers its own.
//
// Why an installer exists at all: Codex finds these surfaces by walking real
// directories under $CODEX_HOME (or <project>/.codex). It cannot be pointed at
// a plugin checkout, so the files have to be placed. Two things are resolved at
// placement time and deliberately NOT baked into the committed adapter:
//
//   * {{PROJECTSTORE_ROOT}} in hooks.json, and $PROJECTSTORE_ROOT in prompt
//     bodies, become this checkout's absolute path. Committing an absolute path
//     would make the generated tree machine-specific and the staleness test
//     unrunnable anywhere but the machine that last built it.
//   * hooks.json is MERGED into whatever is already there. It is a shared file:
//     clobbering it would silently remove the user's own hooks, which is the
//     kind of damage nobody attributes to a plugin installer.
//
// Usage:
//   node scripts/install-codex.mjs                 # into $CODEX_HOME (~/.codex)
//   node scripts/install-codex.mjs --project       # into <cwd>/.codex
//   node scripts/install-codex.mjs --dry-run
//   node scripts/install-codex.mjs --uninstall
//
// Pure node, no external deps.

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, rmSync, rmdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { loadHarness, REPO_ROOT } from "./harness.mjs";

const HARNESS_ID = "codex";

// The marker that makes uninstall and merge safe. Every projectstore hook runs
// through the generated wrapper, so a hook entry is ours exactly when its
// command names that wrapper — the same "did WE write this?" test lib.mjs uses
// before it will touch a status line, and for the same reason: a loose match
// would let us delete something a user wrote.
const WRAPPER_MARK = "/bin/ps-hook.mjs";

function harness() {
  const m = loadHarness(HARNESS_ID);
  if (!m) {
    console.error(`No harnesses/${HARNESS_ID}.json — cannot install.`);
    process.exit(2);
  }
  return m;
}

export function codexHome(m, { project = false, cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  if (project) return join(cwd, m.runtime.project_config_dir);
  return env[m.runtime.home_env] || join(home, m.runtime.home_default);
}

// ─── File collection ───────────────────────────────────────────────────

function walk(dir, base = dir, out = []) {
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

// Placement is derived from the manifest's surface directories, not hardcoded:
// `prompts/x.md` in the adapter lands at `<home>/prompts/x.md`. hooks.json is
// the one file with special handling (it merges), and bin/ stays in the
// checkout — the hooks point at it by absolute path, so copying it would
// create a second copy that updates would not reach.
function plan(m, root, dest) {
  const src = join(root, m.output_dir);
  const files = walk(src);
  const copies = [];
  let hooksFile = null;
  for (const rel of files) {
    if (rel === m.hooks.config_file) { hooksFile = rel; continue; }
    if (rel.startsWith("bin/")) continue;
    copies.push({ from: join(src, rel), to: join(dest, rel), rel });
  }
  return { copies, hooksFile: hooksFile ? join(src, hooksFile) : null, hooksDest: join(dest, m.hooks.config_file) };
}

// ─── Root substitution ─────────────────────────────────────────────────

function substituteRoot(text, m, root) {
  let out = String(text);
  const tok = m.hooks.root_placeholder;
  if (tok) out = out.split(tok).join(root);
  // The prose form. Both exist because one is a path inside a JSON command
  // string and the other is a shell variable the model is told to expand.
  out = out.split("$PROJECTSTORE_ROOT").join(root);
  return out;
}

// ─── hooks.json merge ──────────────────────────────────────────────────

// Ours are replaced wholesale; everything else is preserved verbatim, per
// event. Returns null when the destination exists but cannot be parsed —
// refusing to write beats guessing at a file we cannot read.
export function mergeHooks(existingText, ours) {
  let existing = { hooks: {} };
  if (existingText !== null) {
    try { existing = JSON.parse(existingText); } catch { return null; }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return null;
  }
  const out = { ...existing, hooks: { ...(existing.hooks || {}) } };
  for (const [event, entries] of Object.entries(ours.hooks || {})) {
    const keep = (out.hooks[event] || []).filter((entry) => !entryIsOurs(entry));
    out.hooks[event] = [...keep, ...entries];
  }
  // An event we no longer register but previously did: drop our stale entries
  // without touching the user's. Without this, renaming a hook file leaves the
  // old one wired and failing on every turn.
  for (const event of Object.keys(out.hooks)) {
    if (ours.hooks && event in ours.hooks) continue;
    const keep = out.hooks[event].filter((entry) => !entryIsOurs(entry));
    if (keep.length) out.hooks[event] = keep;
    else delete out.hooks[event];
  }
  return out;
}

function entryIsOurs(entry) {
  return (entry?.hooks || []).some((h) => typeof h?.command === "string" && h.command.includes(WRAPPER_MARK));
}

// ─── Actions ───────────────────────────────────────────────────────────

function install({ project, dryRun }) {
  const m = harness();
  const dest = codexHome(m, { project });
  const { copies, hooksFile, hooksDest } = plan(m, REPO_ROOT, dest);

  const acts = [];
  for (const c of copies) {
    const content = substituteRoot(readFileSync(c.from, "utf8"), m, REPO_ROOT);
    const cur = existsSync(c.to) ? readFileSync(c.to, "utf8") : null;
    if (cur === content) { acts.push(["same", c.to]); continue; }
    acts.push([cur === null ? "create" : "update", c.to]);
    if (!dryRun) { mkdirSync(dirname(c.to), { recursive: true }); writeFileSync(c.to, content, "utf8"); }
  }

  if (hooksFile) {
    const ours = JSON.parse(substituteRoot(readFileSync(hooksFile, "utf8"), m, REPO_ROOT));
    const existingText = existsSync(hooksDest) ? readFileSync(hooksDest, "utf8") : null;
    const merged = mergeHooks(existingText, ours);
    if (merged === null) {
      console.error(`\n✖ ${hooksDest} is not parseable JSON — refusing to overwrite it.`);
      console.error(`  Fix or move it, then re-run. Nothing about hooks was changed.`);
      process.exitCode = 1;
    } else {
      const text = JSON.stringify(merged, null, 2) + "\n";
      if (existingText === text) acts.push(["same", hooksDest]);
      else {
        acts.push([existingText === null ? "create" : "merge", hooksDest]);
        if (!dryRun) { mkdirSync(dirname(hooksDest), { recursive: true }); writeFileSync(hooksDest, text, "utf8"); }
      }
    }
  }

  report(acts, dryRun, dest);
  if (!dryRun) {
    console.log(`\nHooks run from this checkout (${REPO_ROOT}) — keep it in place, or re-run after moving it.`);
    console.log(`Restart Codex so it re-reads skills, prompts and agents.`);
  }
}

function uninstall({ project, dryRun }) {
  const m = harness();
  const dest = codexHome(m, { project });
  const { copies, hooksDest } = plan(m, REPO_ROOT, dest);
  const acts = [];

  for (const c of copies) {
    if (!existsSync(c.to)) continue;
    acts.push(["remove", c.to]);
    if (!dryRun) { try { rmSync(c.to); } catch {} }
  }
  // Only directories we created, and only while empty — a user file dropped
  // into our skill folder keeps the folder.
  if (!dryRun) {
    for (const c of [...copies].reverse()) { try { rmdirSync(dirname(c.to)); } catch {} }
  }

  if (existsSync(hooksDest)) {
    const merged = mergeHooks(readFileSync(hooksDest, "utf8"), { hooks: {} });
    if (merged === null) {
      console.error(`✖ ${hooksDest} is not parseable JSON — left untouched.`);
      process.exitCode = 1;
    } else {
      acts.push(["clean", hooksDest]);
      if (!dryRun) writeFileSync(hooksDest, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
  }
  report(acts, dryRun, dest);
}

function report(acts, dryRun, dest) {
  const tally = {};
  for (const [kind] of acts) tally[kind] = (tally[kind] || 0) + 1;
  console.log(`${dryRun ? "[dry run] " : ""}target: ${dest}`);
  for (const [kind, p] of acts) if (kind !== "same") console.log(`  ${kind.padEnd(7)} ${p}`);
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`\n${summary || "nothing to do"}`);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { project: argv.includes("--project"), dryRun: argv.includes("--dry-run") };
  if (argv.includes("--uninstall")) uninstall(opts);
  else install(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

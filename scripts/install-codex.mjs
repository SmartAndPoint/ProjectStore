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
import { join, dirname, relative, resolve } from "node:path";
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

// The two places a surface can land, and which one each surface uses.
//
// PROJECT is the default, because user-level hooks fire in every Codex project
// — a node process per tool call in repositories that have no vault bound.
// Scoping them is the point.
//
// But it cannot be project-only: Codex discovers custom prompts ONLY under
// $CODEX_HOME/prompts, with no project-level equivalent, so a purely scoped
// install would ship no slash commands at all and say nothing about it. Each
// surface therefore declares its own scope in the manifest, and this resolves
// them. `--user` overrides everything to the home directory.
export function userHome(m, { env = process.env, home = homedir() } = {}) {
  return env[m.runtime.home_env] || join(home, m.runtime.home_default);
}

export function projectDir(m, { cwd = process.cwd() } = {}) {
  return join(cwd, m.runtime.project_config_dir);
}

export function surfaceDest(m, key, opts = {}) {
  if (opts.userOnly) return userHome(m, opts);
  const scope = m.surfaces?.[key]?.scope || "user";
  return scope === "project" ? projectDir(m, opts) : userHome(m, opts);
}

// Every distinct destination this install touches, for reporting and for the
// hook-config path.
export function destinations(m, opts = {}) {
  const out = new Map();
  for (const key of Object.keys(m.surfaces || {})) {
    if (!m.surfaces[key]?.supported) continue;
    out.set(key, surfaceDest(m, key, opts));
  }
  return out;
}

// Back-compat for callers that predate scoping.
export function codexHome(m, { project = false, ...rest } = {}) {
  return project ? projectDir(m, rest) : userHome(m, rest);
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
// Files under our surface directories that carry the projectstore name prefix.
// The prefix IS the ownership marker — it is why generated agents and skills are
// named projectstore-<x> rather than <x> — so this can never reach a file the
// user put there themselves.
function ownedInstalledPaths(m, opts) {
  const owned = new Set();
  for (const key of ["commands", "agents", "skills"]) {
    const s = m.surfaces?.[key];
    if (!s?.supported) continue;
    const dir = join(surfaceDest(m, key, opts), s.dir && s.dir !== "." ? s.dir : "");
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("projectstore-")) continue;
      const p = join(dir, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        // A skill is a directory; take the files inside it.
        for (const inner of (() => { try { return readdirSync(p); } catch { return []; } })()) {
          owned.add(join(p, inner));
        }
      } else {
        owned.add(p);
      }
    }
  }
  return owned;
}

// Which adapter-relative path belongs to which surface, so each lands in the
// destination its scope names.
function surfaceOf(m, rel) {
  for (const [key, s] of Object.entries(m.surfaces || {})) {
    if (!s?.supported) continue;
    const dir = s.dir && s.dir !== "." ? s.dir + "/" : "";
    if (dir && rel.startsWith(dir)) return key;
  }
  return null;
}

function plan(m, root, opts) {
  const src = join(root, m.output_dir);
  const files = walk(src);
  const copies = [];
  let hooksFile = null;
  for (const rel of files) {
    if (rel === m.hooks.config_file) { hooksFile = rel; continue; }
    if (rel.startsWith("bin/")) continue;
    const key = surfaceOf(m, rel);
    // A file under no declared surface directory would land nowhere sensible;
    // the adapter emits none today, and inventing a destination for one would
    // be a guess.
    if (!key) continue;
    copies.push({ from: join(src, rel), to: join(surfaceDest(m, key, opts), rel), rel, surface: key });
  }
  return {
    copies,
    hooksFile: hooksFile ? join(src, hooksFile) : null,
    hooksDest: join(surfaceDest(m, "hooks", opts), m.hooks.config_file),
  };
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

// The same substitution, but applied to a PARSED structure rather than to JSON
// source text.
//
// Doing it textually works everywhere the checkout path has no backslashes and
// fails on Windows, where `C:\workspace` lands inside a JSON string literal as
// invalid escape sequences and JSON.parse throws before anything is installed.
// Parsing first and walking the values means the path is never interpreted as
// JSON syntax — the serializer escapes it correctly on the way back out.
export function substituteRootDeep(value, m, root) {
  if (typeof value === "string") return substituteRoot(value, m, root);
  if (Array.isArray(value)) return value.map((v) => substituteRootDeep(v, m, root));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteRootDeep(v, m, root);
    return out;
  }
  return value;
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

function install(opts) {
  const m = harness();
  const { dryRun } = opts;
  const { copies, hooksFile, hooksDest } = plan(m, REPO_ROOT, opts);

  const acts = [];
  for (const c of copies) {
    const content = substituteRoot(readFileSync(c.from, "utf8"), m, REPO_ROOT);
    const cur = existsSync(c.to) ? readFileSync(c.to, "utf8") : null;
    if (cur === content) { acts.push(["same", c.to]); continue; }
    acts.push([cur === null ? "create" : "update", c.to]);
    if (!dryRun) { mkdirSync(dirname(c.to), { recursive: true }); writeFileSync(c.to, content, "utf8"); }
  }

  if (hooksFile) {
    const ours = substituteRootDeep(JSON.parse(readFileSync(hooksFile, "utf8")), m, REPO_ROOT);
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

  // An upgrade that renamed or deleted a surface leaves the previous file
  // installed, and a stale prompt stays discoverable and executable forever —
  // silently, since nothing reports a file that merely still exists. Uninstall
  // could not reach it either: it plans from the CURRENT adapter, which no
  // longer names it.
  const wanted = new Set(copies.map((c) => c.to));
  for (const p of ownedInstalledPaths(m, opts)) {
    if (wanted.has(p)) continue;
    acts.push(["prune", p]);
    if (!dryRun) { try { rmSync(p); } catch {} }
  }
  if (!dryRun) pruneEmptyOwnedDirs(m, opts);

  report(acts, dryRun, m, opts);
  if (!dryRun) {
    console.log(`\nHooks run from this checkout (${REPO_ROOT}) — keep it in place, or re-run after moving it.`);
    console.log(`Restart Codex so it re-reads skills, prompts and agents.`);
  }
}

function uninstall(opts) {
  const m = harness();
  const { dryRun } = opts;
  const { copies, hooksDest } = plan(m, REPO_ROOT, opts);
  const acts = [];

  // Everything we own, not just what the current adapter would install — so a
  // surface left behind by an older version is removed rather than orphaned.
  const targets = new Set([...copies.map((c) => c.to), ...ownedInstalledPaths(m, opts)]);
  for (const t of targets) {
    if (!existsSync(t)) continue;
    acts.push(["remove", t]);
    if (!dryRun) { try { rmSync(t); } catch {} }
  }
  // Only directories we created, and only while empty — a user file dropped
  // into our skill folder keeps the folder. rmdirSync refuses a non-empty
  // directory, which is the guarantee rather than a check we could get wrong.
  if (!dryRun) pruneEmptyOwnedDirs(m, opts);

  if (existsSync(hooksDest)) {
    const merged = mergeHooks(readFileSync(hooksDest, "utf8"), { hooks: {} });
    if (merged === null) {
      console.error(`✖ ${hooksDest} is not parseable JSON — left untouched.`);
      process.exitCode = 1;
    } else {
      // A file reduced to `{"hooks":{}}` with nothing else in it is one we
      // created and just emptied — leaving it behind is litter in the user's
      // project. Anything else (other top-level keys, surviving hooks) is
      // theirs and stays, rewritten rather than removed.
      const emptied =
        Object.keys(merged).length === 1 &&
        merged.hooks &&
        Object.keys(merged.hooks).length === 0;
      acts.push([emptied ? "remove" : "clean", hooksDest]);
      if (!dryRun) {
        if (emptied) { try { rmSync(hooksDest); } catch {} }
        else writeFileSync(hooksDest, JSON.stringify(merged, null, 2) + "\n", "utf8");
      }
    }
  }
  report(acts, dryRun, m, opts);
}

// Removes our own now-empty surface directories (a skill folder whose SKILL.md
// is gone). Never touches a directory that still holds anything.
function pruneEmptyOwnedDirs(m, opts) {
  for (const key of ["skills", "agents", "commands"]) {
    const s = m.surfaces?.[key];
    if (!s?.supported) continue;
    const dir = join(surfaceDest(m, key, opts), s.dir && s.dir !== "." ? s.dir : "");
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("projectstore-")) continue;
      try { rmdirSync(join(dir, n)); } catch {}
    }
  }
}

function report(acts, dryRun, m, opts) {
  const tally = {};
  for (const [kind] of acts) tally[kind] = (tally[kind] || 0) + 1;

  // Both destinations, always, and which surfaces went where. A split install
  // is surprising if you are not told: the prompts land outside the project
  // even when everything else is scoped to it.
  console.log(`${dryRun ? "[dry run] " : ""}targets:`);
  const byDest = new Map();
  for (const [key, dest] of destinations(m, opts)) {
    if (!byDest.has(dest)) byDest.set(dest, []);
    byDest.get(dest).push(key);
  }
  for (const [dest, keys] of byDest) {
    console.log(`  ${dest}`);
    console.log(`    ${keys.join(", ")}`);
  }
  if (!opts.userOnly && byDest.size > 1) {
    console.log(`  ${"—".repeat(3)} prompts stay in the Codex home directory: Codex discovers`);
    console.log(`      slash commands only there, with no project-level equivalent.`);
  }

  if (acts.some(([k]) => k !== "same")) console.log("");
  for (const [kind, p] of acts) if (kind !== "same") console.log(`  ${kind.padEnd(7)} ${p}`);
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`\n${summary || "nothing to do"}`);
}

function main() {
  const argv = process.argv.slice(2);
  const positional = argv.find((a) => !a.startsWith("-"));
  const opts = {
    // Project-scoped by default. `--project` is kept as an accepted no-op so
    // instructions written against the previous default still work.
    userOnly: argv.includes("--user"),
    cwd: positional ? resolve(positional) : process.cwd(),
    dryRun: argv.includes("--dry-run"),
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`projectstore — install for Codex

  node scripts/install-codex.mjs [project-path]   scope to a project (default: cwd)
  node scripts/install-codex.mjs --user           install everything into $CODEX_HOME
  node scripts/install-codex.mjs --dry-run        show what would change
  node scripts/install-codex.mjs --uninstall      remove it again

Skills, agents and hooks are scoped to the project, so hooks do not fire in
repositories that have no vault bound. Slash commands are not scopeable —
Codex discovers them only under $CODEX_HOME/prompts — so they are installed
there whichever mode you use.`);
    return;
  }
  if (argv.includes("--uninstall")) uninstall(opts);
  else install(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

#!/usr/bin/env node
// projectstore — install-harness.mjs
//
// Copies a generated adapter into its harness's config directories, so that
// harness discovers projectstore's skills, prompts, agents and hooks the way it
// discovers its own.
//
// Harness-agnostic by construction: which harness, which directories, which
// surfaces are project-scoped and which cannot be, all come from
// harnesses/<id>.json. Adding a harness means adding that file — this script
// does not learn a new name.
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
// Usage: node scripts/install-harness.mjs --help
//
// Pure node, no external deps.

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, rmSync, rmdirSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { loadHarness, emittingHarnesses, REPO_ROOT } from "./harness.mjs";

// The harness to install for. With exactly one emitting harness the flag is
// optional — naming it would be ceremony. With more than one it is required,
// because guessing which of several the user meant is the kind of convenience
// that installs the wrong thing silently.
export function resolveHarnessId(argv = []) {
  const at = argv.indexOf("--harness");
  if (at >= 0 && argv[at + 1]) return { id: argv[at + 1], explicit: true };
  const emitting = emittingHarnesses();
  if (emitting.length === 1) return { id: emitting[0].id, explicit: false };
  return { id: null, explicit: false, choices: emitting.map((h) => h.id) };
}

// The marker that makes uninstall and merge safe. Every projectstore hook runs
// through the generated wrapper, so a hook entry is ours exactly when its
// command names that wrapper — the same "did WE write this?" test lib.mjs uses
// before it will touch a status line, and for the same reason: a loose match
// would let us delete something a user wrote.
const WRAPPER_MARK = "/bin/ps-hook.mjs";

// How to invoke this script for a given harness — with the --harness flag only
// when more than one harness could be meant. Every message that tells the user
// to re-run goes through here, so none of them can name a stale script.
export function installCommand(m, ...args) {
  const need = emittingHarnesses().length > 1;
  const parts = ["node scripts/install-harness.mjs"];
  if (need && m?.id) parts.push(`--harness ${m.id}`);
  parts.push(...args.filter(Boolean));
  return parts.join(" ");
}

function harness(opts = {}) {
  const id = opts.harnessId;
  if (!id) {
    const known = emittingHarnesses().map((h) => h.id);
    console.error(
      `Which harness? Pass --harness <id>.\n` +
      `  Known: ${known.join(", ") || "(none declare emit: true)"}`,
    );
    process.exit(2);
  }
  const m = loadHarness(id);
  if (!m) {
    console.error(
      `No harnesses/${id}.json — cannot install.\n` +
      `  Known: ${emittingHarnesses().map((h) => h.id).join(", ")}`,
    );
    process.exit(2);
  }
  if (!m.emit) {
    console.error(`Harness "${id}" declares emit: false — it has no generated adapter to install.`);
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
  const m = harness(opts);
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

  // Trust is checked LAST and reported loudest, because everything above can
  // succeed while the hooks it wrote never run.
  if (!opts.userOnly) {
    const root = opts.cwd || process.cwd();
    if (isProjectTrusted(m, root, opts)) {
      console.log(`\n✓ project is trusted — its .codex/ hooks will load.`);
    } else if (opts.trust && !dryRun) {
      const r = grantTrust(m, root, opts);
      console.log(`\n✓ marked the project trusted in ${r.path}`);
    } else {
      console.log(`\n⚠ THIS PROJECT IS NOT TRUSTED, so Codex will ignore the hooks just installed.`);
      console.log(`  Codex loads a project's .codex/ layer only for trusted projects, and skips`);
      console.log(`  it silently otherwise — the hooks would never fire and nothing would say so.`);
      console.log(`\n  Fix it with either:`);
      console.log(`    ${installCommand(m, root, "--trust")}`);
      console.log(`  or add to ${join(userHome(m, opts), "config.toml")}:\n`);
      for (const l of trustStanza(root).trimEnd().split("\n")) console.log(`    ${l}`);
      process.exitCode = 1;
    }
  }

  if (!dryRun) {
    const rev = m.runtime?.hook_review;
    if (rev) {
      // The second gate, and the one that actually decides whether hooks run.
      // Project trust gets them DISCOVERED; this gets them EXECUTED. They show
      // up in the settings list either way, which is why its absence looks like
      // a broken install rather than a pending approval.
      console.log(`\n▸ If the hooks are listed but never fire, check they are TRUSTED:`);
      console.log(`  ${m.display_name} can list a hook while skipping it until its definition`);
      console.log(`  is approved — trust is recorded against the hook's ${rev.keyed_by}.`);
      console.log(`  You may not be prompted; check only if hooks appear idle.`);
      console.log(`    CLI:     ${rev.cli_command}`);
      console.log(`    Desktop: ${rev.ui_path}`);
      console.log(`  Re-running this installer can change those definitions, which revokes`);
      console.log(`  the approval — expect to review again after an update.`);
    }
    console.log(`\nHooks run from this checkout (${REPO_ROOT}) — keep it in place, or re-run after moving it.`);
    console.log(`Restart Codex so it re-reads skills, prompts and agents.`);
  }
}

function uninstall(opts) {
  const m = harness(opts);
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
  const { id: harnessId } = resolveHarnessId(argv);
  // The harness id is a flag VALUE, so it must not be mistaken for the
  // project path — the one positional this script takes.
  // `i !== at + 1` skips the harness id so it is not read as the project path.
  // Guarded on at >= 0: with the flag absent, indexOf returns -1 and the
  // expression excludes index 0 — swallowing the one positional this script
  // takes, so a path argument was silently ignored and the install went to cwd.
  const at = argv.indexOf("--harness");
  const positional = argv.find((a, i) => !a.startsWith("-") && (at < 0 || i !== at + 1));
  const opts = {
    harnessId,
    // Project-scoped by default. `--project` is kept as an accepted no-op so
    // instructions written against the previous default still work.
    userOnly: argv.includes("--user"),
    cwd: positional ? resolve(positional) : process.cwd(),
    dryRun: argv.includes("--dry-run"),
    trust: argv.includes("--trust"),
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    const emitting = emittingHarnesses();
    const one = emitting.length === 1 ? emitting[0] : null;
    const flag = one ? "" : " --harness <id>";
    const m = harnessId ? loadHarness(harnessId) : one;
    const L = [
      `projectstore — install for ${m ? m.display_name : "a harness"}`,
      ``,
      `  node scripts/install-harness.mjs${flag} [project-path]   scope to a project (default: cwd)`,
      `  node scripts/install-harness.mjs${flag} --user           install everything into the harness home`,
      `  node scripts/install-harness.mjs${flag} --dry-run        show what would change`,
      `  node scripts/install-harness.mjs${flag} --trust          also mark the project trusted`,
      `  node scripts/install-harness.mjs${flag} --uninstall      remove it again`,
      ``,
      `Harnesses with a generated adapter: ${emitting.map((h) => h.id).join(", ") || "(none)"}`,
    ];
    // Everything below is read from the harness's manifest rather than
    // described here, so a second harness explains itself without editing this.
    if (m) {
      const scoped = Object.entries(m.surfaces || {})
        .filter(([, v]) => v?.supported && v.scope === "project").map(([k]) => k);
      const userLevel = Object.entries(m.surfaces || {})
        .filter(([, v]) => v?.supported && v.scope !== "project").map(([k]) => k);
      if (scoped.length) {
        L.push(``, `Scoped to the project: ${scoped.join(", ")}.`);
      }
      for (const [k, v] of Object.entries(m.surfaces || {})) {
        if (userLevel.includes(k) && v.scope_reason) L.push(``, `${k}: ${v.scope_reason}`);
      }
      if (m.runtime?.project_trust?._comment) L.push(``, m.runtime.project_trust._comment);
    }
    console.log(L.join("\n"));
    return;
  }
  if (argv.includes("--uninstall")) uninstall(opts);
  else install(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

// ─── Project trust ─────────────────────────────────────────────────────
//
// Codex loads a project's `.codex/` layer — its config and its hooks — only
// when the project is marked trusted in the user's own config. An untrusted
// project silently gets none of it: no error, no warning, hooks simply never
// run. Since projectstore now installs hooks project-scoped by default, that
// makes trust part of the install rather than a detail, and an installer that
// reports success while the hooks it just wrote can never fire is lying.
//
// The check is deliberately a plain scan rather than a TOML parse: node ships
// no TOML reader, and this only needs to answer one question about one key.
// It fails toward "not trusted", which is the safe direction — the cost is a
// message the user did not need, against silence they cannot debug.

export function trustStanza(projectRoot) {
  return `[projects."${projectRoot}"]\ntrust_level = "trusted"\n`;
}

export function isProjectTrusted(m, projectRoot, opts = {}) {
  const cfg = join(userHome(m, opts), m.runtime.project_trust?.config_file || "config.toml");
  let text;
  try { text = readFileSync(cfg, "utf8"); } catch { return false; }

  // Line-based, not a multiline regex. The obvious `^\s*\[` for "next section
  // header" is wrong in a way that reads fine: `\s` matches newlines, so it
  // finds the header starting from the blank line BEFORE it, and the section
  // slice comes back as "\n" — every project reads as untrusted. Splitting
  // into lines removes the class of bug rather than fixing this instance.
  const want = [`[projects."${projectRoot}"]`, `[projects.'${projectRoot}']`];
  const trusted = m.runtime.project_trust?.trusted_value || "trusted";
  const key = m.runtime.project_trust?.key || "trust_level";
  let inSection = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = want.includes(line);
      continue;
    }
    if (!inSection || !line || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/);
    if (!kv || kv[1] !== key) continue;
    return kv[2].replace(/^["']|["']$/g, "") === trusted;
  }
  return false;
}

export function grantTrust(m, projectRoot, opts = {}) {
  const cfg = join(userHome(m, opts), m.runtime.project_trust?.config_file || "config.toml");
  let text = "";
  try { text = readFileSync(cfg, "utf8"); } catch {}
  if (isProjectTrusted(m, projectRoot, opts)) return { changed: false, path: cfg };
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, text + sep + (text ? "\n" : "") + trustStanza(projectRoot), "utf8");
  return { changed: true, path: cfg };
}

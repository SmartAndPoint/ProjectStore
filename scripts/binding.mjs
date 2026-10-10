// projectstore — binding.mjs
//
// The binding of a project to a vault, as a plan and an apply: the one place
// that writes `<project>/<config dir>/projectstore.json`, for the CLI's `bind`
// and `init` verbs and, later, for the command files that today write the
// config by hand (the bind interview in commands/bind.md stays the in-session
// front-end; it will call these verbs instead of composing the JSON).
//
// The shape follows install-harness.mjs: planBind() is pure over the
// filesystem and returns what would be written and why, or why not;
// applyBind() writes only what the plan says, through writeFileAtomic. The
// gate is the distribution ADR's decision 6 read for a binding: naming the
// vault on the command line is the confirmation, so a headless `bind <vault>`
// proceeds; changing an existing binding is the one step that needs a second
// word — `--rebind` — because it silently redirects every later write to
// another vault. Neither asks on a terminal, unlike install: there is no
// preview to show — the whole write is the three values the caller just
// typed, and the refusal texts name the second word. A rebind keeps every
// other key of the config (statusline, agents, autoupdate_asked …): those are
// the project's decisions, not the vault's.
//
// Never reads ambient cwd or ambient env: the caller resolves the project
// (cli.mjs's resolveProject) and supplies the author. Normative: the CLI
// story's slice-2 plan (PS-CORE); the fresh config's keys mirror
// commands/bind.md step 3 (a test pins the two together).
//
// `init` creates a whole vault (the story "Scaffold is a core verb, and init
// creates a whole vault…", PS-CORE; the front-door ADR's decision 7): for a
// directory that is missing, or there and empty, the plan is the binding's
// AND the scaffold's, refused as one before anything is made; the apply is
// mkdir, the binding, `git init`, then the scaffold. Naming the vault stays
// the confirmation, as for `bind` — `init`'s command line names what it
// writes, which `scaffold --write`'s does not, so `init` asks nothing even at
// a terminal. A directory that is not empty is bound as before and never
// touched: no `git init` inside someone's files, no scaffold. For `bind`, and
// for that `init`, the scaffold plan only decides the "Next" line.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic, pluginRoot, ensureRuntimeDir, layoutPaths, commandForm } from "./lib.mjs";
import { configPath as harnessConfigPath } from "./harness.mjs";
import { planScaffold, applyScaffold } from "./scaffold.mjs";

export const DEFAULT_LAYOUT = "engineering";
export const DEFAULT_LANGUAGE = "en";
// commands/bind.md step 3, in its order.
export const FRESH_CONFIG_KEYS = Object.freeze(["vault_path", "layout", "auto_inject", "language", "tags", "default_author", "active_skills", "approval_mode"]);

export function layoutNames(root = pluginRoot()) {
  const dir = join(root, "scaffold", "layouts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, "")).sort();
}

export function languageNames(root = pluginRoot()) {
  const dir = join(root, "templates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } }).sort();
}

// `~` expanded, made absolute against the project, trailing slash dropped.
// `~user` is not expanded (refused by the plan), and the filesystem root is
// never a vault.
export function normaliseVaultPath(p, projectDir, home = homedir()) {
  let s = String(p || "").trim();
  if (!s) return null;
  if (s === "~" || s.startsWith("~/")) s = join(home, s.slice(1));
  else if (s.startsWith("~")) return { error: `${p}: "~user" paths are not expanded — pass the absolute path` };
  if (!isAbsolute(s)) s = resolve(projectDir, s);
  s = s.replace(/\/+$/, "");
  if (!s) return { error: "the filesystem root is not a vault" };
  return s;
}

const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

// The existing config as {cfg, corrupt}: a file that exists but does not parse
// is not "unbound" here — treating it so would overwrite the keys a rebind
// promises to keep.
function readExisting(configPath) {
  if (!existsSync(configPath)) return { cfg: null, corrupt: false };
  try { return { cfg: JSON.parse(readFileSync(configPath, "utf8")), corrupt: false }; } catch { return { cfg: null, corrupt: true }; }
}

export const shellQuote = (s) => (/^[A-Za-z0-9_\/.~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// A directory with no entries at all. A `.DS_Store` makes it not empty: that
// edge stays visible rather than guessed at. Unreadable is not empty either.
function isEmptyDir(p) {
  try { return statSync(p).isDirectory() && readdirSync(p).length === 0; } catch { return false; }
}

// What `bind` would write. `state`: "unbound" (fresh bind), "same" (already
// bound to this vault — nothing to write), "different" (bound elsewhere —
// needs --rebind). Refusals are the reasons apply() must not run; each has a
// code: USAGE (exit 2 upstream), MISSING, REBIND, BOUND, UNREADABLE,
// NO_PROJECT, and on `init`'s whole-vault path the scaffold plan's own
// (exit 1). `buildsVault`: `init` on a missing or empty directory — mkdir
// (createsVault, missing only), git and the scaffold follow the binding.
// `scaffold` is the scaffold plan for the vault, on every path that has one.
export function planBind(projectDir, { vault, layout = null, language = null, rebind = false, init = false, author = "", env = process.env, root = pluginRoot(), home = homedir() } = {}) {
  const refusals = [];
  const configPath = harnessConfigPath(projectDir, env);
  if (!existsSync(projectDir)) refusals.push({ code: "NO_PROJECT", message: `${projectDir} does not exist — a binding belongs to an existing project directory` });
  const norm = normaliseVaultPath(vault, projectDir, home);
  const vaultPath = typeof norm === "string" ? norm : null;
  if (!norm) refusals.push({ code: "USAGE", message: "a vault path is required" });
  else if (norm.error) refusals.push({ code: "USAGE", message: norm.error });
  const layouts = layoutNames(root);
  const languages = languageNames(root);
  const { cfg: before, corrupt } = readExisting(configPath);
  if (corrupt) refusals.push({ code: "UNREADABLE", message: `${configPath} exists but is not valid JSON — fix or remove it before binding; nothing is overwritten` });
  const storedVault = before ? normaliseVaultPath(before.vault_path, projectDir, home) : null;
  const sameVault = Boolean(vaultPath && typeof storedVault === "string" && (storedVault === vaultPath || (existsSync(storedVault) && existsSync(vaultPath) && realOr(storedVault) === realOr(vaultPath))));
  const state = !before ? "unbound" : sameVault ? "same" : "different";
  const chosenLayout = state === "same" ? (before.layout || DEFAULT_LAYOUT) : layout ?? (before ? before.layout : null) ?? DEFAULT_LAYOUT;
  const chosenLanguage = state === "same" ? (before.language || DEFAULT_LANGUAGE) : language ?? (before ? before.language : null) ?? DEFAULT_LANGUAGE;
  const ignored = state === "same" ? [layout !== null && layout !== chosenLayout ? "layout" : null, language !== null && language !== chosenLanguage ? "language" : null].filter(Boolean) : [];
  if (state !== "same") {
    if (layouts.length && !layouts.includes(chosenLayout)) refusals.push({ code: "USAGE", message: `unknown layout "${chosenLayout}" — one of: ${layouts.join(", ")}` });
    if (languages.length && !languages.includes(chosenLanguage)) refusals.push({ code: "USAGE", message: `unknown language "${chosenLanguage}" — one of: ${languages.join(", ")}` });
  }
  const vaultExists = vaultPath ? existsSync(vaultPath) : false;
  if (vaultPath && vaultExists && !statSync(vaultPath).isDirectory()) refusals.push({ code: "USAGE", message: `${vaultPath} is not a directory` });
  if (vaultPath && !vaultExists && !init) refusals.push({ code: "MISSING", message: `${vaultPath} does not exist — create it first, or run \`projectstore init ${shellQuote(String(vault))}${rebind ? " --rebind" : ""}\` to create and bind in one step` });
  if (state === "different" && !rebind) refusals.push({ code: "REBIND", message: `${projectDir} is bound to ${before.vault_path}; pass --rebind to point it at ${vaultPath} instead (every other setting is kept)` });
  const scaffold = vaultPath ? planScaffold(vaultPath, { layout: chosenLayout, language: chosenLanguage, root }) : null;
  const missingFolders = Boolean(scaffold && scaffold.ok && scaffold.creates > 0);
  // Only while the vault is there. A binding whose vault directory was deleted
  // made `init` refuse as BOUND, so "run init" — the scaffold verb's own
  // advice for a missing vault — led nowhere; such an `init` rebuilds it
  // under the binding it already has, writing no config.
  if (state === "same" && init && vaultExists) refusals.push({ code: "BOUND", message: `${projectDir} is already bound to ${vaultPath}${missingFolders ? ` — ${commandForm("scaffold", { env })} in a session, or \`projectstore scaffold --write\`, creates the layout's missing folders and READMEs` : ""}` });
  const buildable = Boolean(init && vaultPath && refusals.length === 0 && (!vaultExists || isEmptyDir(vaultPath)));
  // The whole-vault path is refused as one plan: a missing template or folder
  // string stops the mkdir too. Elsewhere the scaffold plan's refusals are not
  // the binding's — a bind into a vault this language cannot scaffold still
  // binds, and its Next line names `status`.
  if (buildable && scaffold) refusals.push(...scaffold.refusals);
  const after = state === "same" ? before : state === "different"
    ? { ...before, vault_path: vaultPath, layout: chosenLayout, language: chosenLanguage }
    : { vault_path: vaultPath, layout: chosenLayout, auto_inject: true, language: chosenLanguage, tags: [], default_author: author || "", active_skills: true, approval_mode: "always" };
  const keptKeys = state === "different" ? Object.keys(before).filter((k) => !["vault_path", "layout", "language"].includes(k)).sort() : [];
  const ok = refusals.length === 0;
  return {
    projectDir, configPath, vault: vaultPath, vaultExists, layout: chosenLayout, language: chosenLanguage, ignored,
    state, before, after, keptKeys, writes: ok && state !== "same", createsVault: Boolean(init && vaultPath && !vaultExists && ok),
    buildsVault: buildable && ok, scaffold, refusals, ok,
  };
}

// `git init` in a vault `init` just made: no commit, on the person's own
// init.defaultBranch (no `-b`), quiet, with its stderr captured so git's
// default-branch hint never reaches the person — its exit status alone
// decides done or failed. The vault is the cwd, so a spawn ENOENT can only
// mean git is not on PATH: the one skip the front-door ADR allows, and
// doctor's vault-git finding then stays. Every variable that locates a
// repository is dropped (GIT_LOCAL_ENV, git's own `rev-parse
// --local-env-vars`): inherited from a hook or a script, GIT_DIR alone would
// make this init create — or reinitialise — a repository somewhere else.
// `rev-parse --show-toplevel` from the new directory says whether it lies
// inside a work tree (realpath'd: macOS answers /private/var for /var); git
// init still runs, and the result carries that top. A failure carries its
// remedy, so a caller reading --json can relay it as the text does.
const GIT_LOCAL_ENV = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
  "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
]);
function runGit(vault, { spawn = spawnSync, env = process.env } = {}) {
  const childEnv = { ...env };
  for (const k of GIT_LOCAL_ENV) delete childEnv[k];
  const opts = { cwd: vault, env: childEnv, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] };
  const absent = (r) => r.error && r.error.code === "ENOENT";
  const failed = (message) => ({ failed: message, remedy: `Run \`git init\` in ${vault}, or ${commandForm("doctor", { args: "--fix", env })}, which offers it.` });
  const top = spawn("git", ["rev-parse", "--show-toplevel"], opts);
  if (absent(top)) return { skipped: "git is not on PATH" };
  const inside = top.status === 0 && top.stdout && top.stdout.trim() ? top.stdout.trim() : null;
  const r = spawn("git", ["init", "--quiet"], opts);
  if (absent(r)) return { skipped: "git is not on PATH" };
  if (r.error) return failed(r.error.message);
  if (r.status !== 0) return failed(String(r.stderr || "").trim() || `git init exited with ${r.status}`);
  return inside && realOr(inside) !== realOr(vault) ? { done: true, inside } : { done: true };
}

const SCAFFOLD_REMEDY = "The binding is written; `projectstore scaffold --write` finishes the vault.";

// Writes what the plan says, in the story's order: the vault directory when
// init asked for it (not when it is there and empty), the config through
// writeFileAtomic (its directory made first — the helper never mkdirs), then,
// on init's whole-vault path, `git init` and the scaffold. Refuses to run a
// plan with refusals; a "same" plan writes nothing unless it rebuilds a vault
// that went missing. A git or scaffold step that fails is reported in `done`
// and the next step still runs — the binding is already written, so a re-run
// of `init` would only be refused, and the output names the one command that
// finishes the vault instead. `spawn` is a parameter so tests can stand in
// for git.
export function applyBind(plan, { spawn = spawnSync, env = process.env } = {}) {
  if (!plan.ok) throw Object.assign(new Error(plan.refusals.map((r) => r.message).join("; ")), { code: plan.refusals[0].code });
  const done = { created_vault: false, wrote_config: false, git: null, scaffold: null };
  if (plan.createsVault) { mkdirSync(plan.vault, { recursive: true }); done.created_vault = true; }
  if (plan.writes) {
    // Contract 5 names bind among the writers of the line-merged
    // .projectstore/.gitignore, and it was the one writer that never did:
    // measured 2026-09-06 on a fresh project, `init` left .projectstore/
    // holding the binding alone, so `git add -A` committed a machine-local
    // absolute vault path. Only when we are writing the NEW path — a rebind of
    // a not-yet-migrated project still writes the legacy file (contract 8),
    // and creating .projectstore/ beside a legacy layout is the migration
    // item's write, not ours.
    if (plan.configPath === layoutPaths(plan.projectDir).binding) {
      try { ensureRuntimeDir(plan.projectDir); } catch {}
    }
    mkdirSync(dirname(plan.configPath), { recursive: true });
    writeFileAtomic(plan.configPath, JSON.stringify(plan.after, null, 2) + "\n");
    done.wrote_config = true;
  }
  if (plan.buildsVault) {
    done.git = runGit(plan.vault, { spawn, env });
    try { done.scaffold = applyScaffold(plan.scaffold); } catch (e) { done.scaffold = { failed: e && e.message ? e.message : String(e), remedy: SCAFFOLD_REMEDY }; }
  }
  return done;
}

// The result a front-end reports: the decided values, never the file body.
// `git` and `scaffold` are null unless `init` built the vault: git is
// {done: true[, inside]}, {skipped: reason} or {failed: message, remedy};
// scaffold is {created, exists} or {failed: message, remedy}.
export function bindResult(plan, done) {
  return {
    state: plan.state, vault_path: plan.vault, vault_exists: Boolean(done && done.created_vault) || plan.vaultExists, layout: plan.layout, language: plan.language,
    config_path: plan.configPath, wrote: Boolean(done && done.wrote_config), created_vault: Boolean(done && done.created_vault),
    kept_keys: plan.keptKeys, ignored: plan.ignored, refusals: plan.refusals,
    git: (done && done.git) || null, scaffold: (done && done.scaffold) || null,
  };
}

// Whether a run left the vault unfinished: a failed git init or scaffold is
// exit 1 with `ok: false`, though everything before it was written.
export function bindFailed(done) {
  return Boolean(done && ((done.git && done.git.failed) || (done.scaffold && done.scaffold.failed)));
}

// The bind Next line, one decision: the scaffold plan has a `create` row.
// Both forms — the session's and the bin's — because the bind interview
// relays this to a person who runs slash commands, and a git-marketplace
// install has no bin on PATH. `--write`: at a terminal that form shows the
// plan and asks anyway.
function nextLine(p, env) {
  return p.scaffold && p.scaffold.ok && p.scaffold.creates > 0
    ? `Next: ${commandForm("scaffold", { env })} in a session, or \`projectstore scaffold --write\`, creates the layout's missing folders and READMEs.`
    : "Next: `projectstore status`.";
}

// One line per step that ran. The whole-vault path's own Next line: the
// derived views are reconcile's, offered rather than run.
function vaultSteps(p, done) {
  const lines = [];
  const g = done.git;
  if (g && g.done) lines.push(`Initialised a git repository in ${p.vault} (no commit).`);
  if (g && g.inside) lines.push(`\`${p.vault}\` is inside the git work tree at \`${g.inside}\`; the vault gets its own repository, which that repository will see as an embedded one.`);
  if (g && g.skipped) lines.push(`Skipped git init: ${g.skipped}. The vault works without one; doctor's vault-git finding stays until it is a repository.`);
  if (g && g.failed) lines.push(`git init failed: ${g.failed}`, `  ${g.remedy}`);
  const s = done.scaffold;
  if (s && s.failed) lines.push(`Scaffold failed: ${s.failed}`, `  ${s.remedy}`);
  else if (s) lines.push(`Scaffolded the ${p.layout} layout (${p.language}): ${s.created.length} folders and READMEs created${s.exists.length ? `, ${s.exists.length} already there` : ""}.`);
  if (!bindFailed(done)) lines.push("", "Next: `projectstore reconcile --write` (optional) generates the derived views — kanban.md, graph.md and code-map.md.");
  return lines;
}

export function renderBindPlan(p, done = null, { env = process.env } = {}) {
  const lines = [];
  if (!p.ok) { for (const r of p.refusals) lines.push(r.message); return lines.join("\n") + "\n"; }
  const ignoredNote = p.ignored.length ? ` — --${p.ignored.join(" and --")} ignored: a change of ${p.ignored.join("/")} is not a rebind (edit the config, or rebind to another vault)` : "";
  if (p.state === "same" && !(done && p.buildsVault)) {
    lines.push(`Already bound to ${p.vault}${ignoredNote}.`, nextLine(p, env));
    return lines.join("\n") + "\n";
  }
  if (done && done.created_vault) lines.push(`Created ${p.vault}`);
  if (p.state === "same") lines.push(`Already bound to ${p.vault}${ignoredNote}; its directory was missing, so init made the vault again.`);
  else {
    lines.push(`Wrote ${p.configPath}${p.state === "different" ? ` (rebind from ${p.before.vault_path}; kept: ${p.keptKeys.join(", ") || "nothing else"})` : ""}`);
    lines.push(`  vault_path: ${p.vault}`, `  layout:     ${p.layout}`, `  language:   ${p.language}`);
  }
  if (done && p.buildsVault) lines.push(...vaultSteps(p, done));
  else if (done) lines.push("", nextLine(p, env));
  return lines.join("\n") + "\n";
}

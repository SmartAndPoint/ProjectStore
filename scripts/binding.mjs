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
// other key of the config (statusline, agents, channel_keep …): those are the
// project's decisions, not the vault's.
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

//
// Setup composes these too (the story "projectstore setup asks, shows one
// plan and installs every harness it finds, with the vault", rules 7 and
// 10): planInherit() is a worktree's binding copied from its main checkout;
// `scaffoldExisting` adds the scaffold to a bind of an existing vault whose
// layout folders are missing; bindPlanSteps() is the one list of steps the
// installer's PLAN shows for a vault and applyBind() reports through
// `onStep`; recheckBind() is the apply-time check that the preview still
// holds; gitTop() is the git top setup's first question reads.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic, pluginRoot, ensureRuntimeDir, layoutPaths, commandForm, readConfigAt, CHANNEL_SWITCH_KEY, CHANNEL_KEEP_KEY } from "./lib.mjs";
import { configPath as harnessConfigPath, invokedAs } from "./harness.mjs";
import { planScaffold, applyScaffold } from "./scaffold.mjs";
import { icon, kv, commandBlock, wrap, PLAIN } from "./term.mjs";

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
// `scaffoldExisting` (setup's "bind existing + scaffold", its rule 7): an
// existing, non-empty vault whose scaffold plan has a `create` row is bound
// AND scaffolded — never `git init`ed, never mkdir'd — `scaffoldsExisting`;
// the scaffold's refusals are then the plan's, refused as one.
export function planBind(projectDir, { vault, layout = null, language = null, rebind = false, init = false, scaffoldExisting = false, author = "", env = process.env, root = pluginRoot(), home = homedir() } = {}) {
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
  const existing = Boolean(scaffoldExisting && vaultPath && vaultExists && state !== "same" && !buildable && scaffold && scaffold.creates > 0);
  if (existing) refusals.push(...scaffold.refusals);
  const after = state === "same" ? before : state === "different"
    ? { ...before, vault_path: vaultPath, layout: chosenLayout, language: chosenLanguage }
    : { vault_path: vaultPath, layout: chosenLayout, auto_inject: true, language: chosenLanguage, tags: [], default_author: author || "", active_skills: true, approval_mode: "always" };
  const keptKeys = state === "different" ? Object.keys(before).filter((k) => !["vault_path", "layout", "language"].includes(k)).sort() : [];
  const ok = refusals.length === 0;
  return {
    projectDir, configPath, vault: vaultPath, vaultExists, layout: chosenLayout, language: chosenLanguage, ignored,
    state, before, after, keptKeys, writes: ok && state !== "same", createsVault: Boolean(init && vaultPath && !vaultExists && ok),
    buildsVault: buildable && ok, scaffoldsExisting: existing && ok, scaffold, refusals, ok, inherit: null,
  };
}

// The keys a worktree's binding never takes from its main checkout: each
// records a choice about THIS checkout's own rows in the host's registry
// (local scope, one row per checkout), so another checkout's answer does not
// apply here (the setup story, rule 7; commands/bind.md step 0a).
export const INHERIT_DROPS = Object.freeze([CHANNEL_SWITCH_KEY, CHANNEL_KEEP_KEY]);

// The worktree row (the setup story, rule 7): `projectDir`'s binding copied
// from the checkout `from` — read through readConfigAt, the new path then the
// legacy one — every key verbatim but those in `drop`, as bind's inherit
// path (step 0a) copies it. The vault is the parent's and is shared: it is
// never created, git-initialised or scaffolded here. A relative vault_path
// is relative to the parent, so the copy carries it resolved there. The plan
// has planBind's shape, so applyBind writes it (with the .projectstore/
// .gitignore) and bindResult reports it; `inherit` names the checkout, the
// keys never copied (`drop`) and those its binding carried (`dropped`).
// Refusals: NO_PROJECT, USAGE (no checkout named,
// a `~user` vault path, a vault that is not a directory — as planBind
// refuses it), NOT_BOUND (the checkout has no binding, or one that
// names no vault), MISSING (its vault is gone), UNREADABLE, and REBIND for a
// project bound elsewhere — inheriting never rebinds.
export function planInherit(projectDir, { from, drop = INHERIT_DROPS, env = process.env, root = pluginRoot(), home = homedir() } = {}) {
  const refusals = [];
  const configPath = harnessConfigPath(projectDir, env);
  if (!existsSync(projectDir)) refusals.push({ code: "NO_PROJECT", message: `${projectDir} does not exist — a binding belongs to an existing project directory` });
  const parent = from ? readConfigAt(from) : null;
  const usable = parent && typeof parent === "object" && !Array.isArray(parent) && typeof parent.vault_path === "string" && parent.vault_path.trim() !== "";
  if (!from) refusals.push({ code: "USAGE", message: "a checkout to inherit the binding from is required" });
  else if (!usable) refusals.push({ code: "NOT_BOUND", message: `${from} has no binding naming a vault, so there is nothing to inherit` });
  const norm = usable ? normaliseVaultPath(parent.vault_path, from, home) : null;
  const vaultPath = typeof norm === "string" ? norm : null;
  if (norm && norm.error) refusals.push({ code: "USAGE", message: norm.error });
  const vaultExists = vaultPath ? existsSync(vaultPath) : false;
  if (vaultPath && !vaultExists) refusals.push({ code: "MISSING", message: `${vaultPath}, the vault ${from} is bound to, does not exist` });
  // As planBind refuses it: a vault is a directory.
  const vaultIsDir = vaultExists && statSync(vaultPath).isDirectory();
  if (vaultExists && !vaultIsDir) refusals.push({ code: "USAGE", message: `${vaultPath}, the vault ${from} is bound to, is not a directory` });
  const { cfg: before, corrupt } = readExisting(configPath);
  if (corrupt) refusals.push({ code: "UNREADABLE", message: `${configPath} exists but is not valid JSON — fix or remove it before binding; nothing is overwritten` });
  const storedVault = before ? normaliseVaultPath(before.vault_path, projectDir, home) : null;
  const sameVault = Boolean(vaultPath && typeof storedVault === "string" && (storedVault === vaultPath || (existsSync(storedVault) && existsSync(vaultPath) && realOr(storedVault) === realOr(vaultPath))));
  const state = !before ? "unbound" : sameVault ? "same" : "different";
  if (state === "different") refusals.push({ code: "REBIND", message: `${projectDir} is bound to ${before.vault_path}; inheriting never rebinds` });
  const dropped = usable ? drop.filter((k) => Object.hasOwn(parent, k)) : [];
  const copied = usable ? Object.fromEntries(Object.entries(parent).filter(([k]) => !drop.includes(k))) : null;
  // `~` means the same home in both checkouts; a relative path does not.
  if (copied && vaultPath && !isAbsolute(parent.vault_path) && !parent.vault_path.trim().startsWith("~")) copied.vault_path = vaultPath;
  const layout = (copied && copied.layout) || DEFAULT_LAYOUT;
  const language = (copied && copied.language) || DEFAULT_LANGUAGE;
  const scaffold = vaultPath && vaultIsDir ? planScaffold(vaultPath, { layout, language, root }) : null;
  const ok = refusals.length === 0;
  return {
    projectDir, configPath, vault: vaultPath, vaultExists, layout, language, ignored: [],
    state, before, after: state === "same" ? before : copied, keptKeys: [], writes: ok && state === "unbound", createsVault: false,
    buildsVault: false, scaffoldsExisting: false, scaffold, refusals, ok, inherit: from ? { from, drop: [...drop], dropped } : null,
  };
}

// The steps a binding plan writes, in apply's order — one list for the
// installer's PLAN (setup's `vault` item, the story's rule 10) and for the
// APPLY lines applyBind reports through `onStep`, so the two never disagree:
//   mkdir      the vault's directory (createsVault)
//   bind       the binding at configPath — for an inherit, the checkout it
//              copies and the keys it drops
//   git-init   `git init --quiet` in the vault (buildsVault)
//   scaffold   one per layout folder with something to create — the folder
//              and its README.md — then the vault's README.md: `rels` are
//              vault-relative, a folder with its trailing slash
export function bindPlanSteps(p) {
  if (!p || !p.ok) return [];
  const steps = [];
  if (p.createsVault) steps.push({ kind: "mkdir", path: p.vault, why: "the vault's directory" });
  if (p.writes) {
    steps.push({ kind: "bind", path: p.configPath, vault: p.vault, layout: p.layout, language: p.language,
      ...(p.inherit ? { from: p.inherit.from, drop: [...p.inherit.drop], dropped: [...p.inherit.dropped] } : {}),
      why: p.inherit ? `the binding of ${p.inherit.from}, copied but for the keys that record that checkout's own registry rows; with .projectstore/.gitignore, which keeps it machine-local` : "the binding, with .projectstore/.gitignore, which keeps it machine-local" });
  }
  if (p.buildsVault) steps.push({ kind: "git-init", path: p.vault, argv: ["git", "init", "--quiet"], why: "the vault's own repository, with no commit, on your own init.defaultBranch" });
  if ((p.buildsVault || p.scaffoldsExisting) && p.scaffold && p.scaffold.ok) steps.push(...scaffoldSteps(p.scaffold));
  return steps;
}

function scaffoldSteps(s) {
  const out = [];
  const shown = (r) => (r.type === "folder" ? `${r.rel}/` : r.rel);
  const byRel = new Map(s.rows.map((r) => [r.rel, r]));
  for (const r of s.rows.filter((x) => x.type === "folder")) {
    const own = [r, byRel.get(`${r.rel}/README.md`)].filter((x) => x && x.action === "create");
    if (own.length) out.push({ kind: "scaffold", path: own[0].abs, vault: s.vault, rels: own.map(shown), why: "the layout's folder and its index" });
  }
  const top = s.rows.find((r) => r.type === "vault-readme");
  if (top && top.action === "create") out.push({ kind: "scaffold", path: top.abs, vault: s.vault, rels: [shown(top)], why: "the vault's own README, its folder table" });
  return out;
}

// The apply-time check of a binding plan (the setup story, rule 10): the
// binding is still what the preview read — absent, or the same JSON, at the
// same path — and a vault the plan builds is still missing or empty. Returns
// the reason it does not hold, or null.
export function recheckBind(p, { env = process.env } = {}) {
  const at = harnessConfigPath(p.projectDir, env);
  const { cfg, corrupt } = readExisting(at);
  if (corrupt || resolve(at) !== resolve(p.configPath) || JSON.stringify(cfg ?? null) !== JSON.stringify(p.before ?? null)) return "the binding changed after the preview";
  if (p.buildsVault && existsSync(p.vault) && !isEmptyDir(p.vault)) return `${p.vault} changed after the preview: it is no longer missing or empty`;
  return null;
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
const gitEnv = (env) => {
  const out = { ...(env || {}) };
  for (const k of GIT_LOCAL_ENV) delete out[k];
  return out;
};

// The top of the git work tree `cwd` lies in, realpath'd (macOS answers
// /private/var for /var), or null: outside a work tree (exit 128), git not on
// PATH, or no answer within `timeout` — each means "not in one" (the setup
// story, rule 4: 2 s). The environment is cleaned of every variable that
// locates a repository, as for git init: an inherited GIT_DIR would answer
// for another repository than the folder's.
export function gitTop(cwd, { env = process.env, spawn = spawnSync, timeout = 2000 } = {}) {
  let r;
  try { r = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, env: gitEnv(env), encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  const top = String(r.stdout || "").trim();
  return top ? realOr(top) : null;
}

function runGit(vault, { spawn = spawnSync, env = process.env } = {}) {
  const opts = { cwd: vault, env: gitEnv(env), encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] };
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
// for git. A plan with `scaffoldsExisting` (an existing vault, bound) runs
// the scaffold after the binding, with no mkdir and no git init.
//
// `onStep(step, phase, result)` watches, as the installer's apply() steps
// do: each step of bindPlanSteps(plan) is reported "start", then "end" with
// { ok } — { ok, kept, label } for a git init skipped (git not on PATH) or a
// scaffold step whose files were all there already, { ok, warn } for a
// failed git init, which never stops the run. The scaffold's steps are
// reported once it has run: it writes every folder before any README.
export function applyBind(plan, { spawn = spawnSync, env = process.env, onStep = null } = {}) {
  if (!plan.ok) throw Object.assign(new Error(plan.refusals.map((r) => r.message).join("; ")), { code: plan.refusals[0].code });
  const done = { created_vault: false, wrote_config: false, git: null, scaffold: null };
  const steps = onStep ? bindPlanSteps(plan) : [];
  const stepOf = (kind) => steps.find((s) => s.kind === kind) || null;
  const tell = (st, phase, r) => { if (onStep && st) onStep(st, phase, r); };
  // A write that throws ends its step as failed before the error leaves.
  const watched = (st, fn) => {
    tell(st, "start");
    try { fn(); } catch (e) { tell(st, "end", { ok: false }); throw e; }
    tell(st, "end", { ok: true });
  };
  if (plan.createsVault) { watched(stepOf("mkdir"), () => mkdirSync(plan.vault, { recursive: true })); done.created_vault = true; }
  if (plan.writes) watched(stepOf("bind"), () => {
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
  });
  if (plan.buildsVault) {
    const st = stepOf("git-init");
    tell(st, "start");
    done.git = runGit(plan.vault, { spawn, env });
    const g = done.git;
    tell(st, "end", g.failed ? { ok: true, warn: `git init failed: ${String(g.failed).split("\n")[0]}` } : g.skipped ? { ok: true, kept: true, label: `skipped git init: ${g.skipped}` } : { ok: true });
  }
  if (plan.buildsVault || plan.scaffoldsExisting) {
    try { done.scaffold = applyScaffold(plan.scaffold); } catch (e) { done.scaffold = { failed: e && e.message ? e.message : String(e), remedy: SCAFFOLD_REMEDY }; }
    const made = new Set(done.scaffold.failed ? [] : done.scaffold.created.map((r) => r.replace(/\/$/, "")));
    for (const st of steps.filter((s) => s.kind === "scaffold")) {
      tell(st, "start");
      if (done.scaffold.failed) { tell(st, "end", { ok: false }); break; }
      tell(st, "end", { ok: true, kept: !st.rels.some((r) => made.has(r.replace(/\/$/, ""))) });
    }
  }
  return done;
}

// The result a front-end reports: the decided values, never the file body.
// `git` and `scaffold` are null unless `init` built the vault (`scaffold`
// also when setup scaffolded an existing one): git is
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

// A line of prose, wrapped on a live terminal with a hanging indent of two
// (presentation spec contract 5); `lead` is what the first line starts
// with. A path or a command inside it is one word and never broken.
const prose = (c, text, lead = "") => lead + wrap(text, c.live ? c.width : 0, lead + "  ");

// The bind Next lines, one decision: the scaffold plan has a `create` row.
// Both forms — the session's and the bin's — because the bind interview
// relays this to a person who runs slash commands, and a git-marketplace
// install has no bin on PATH: the terminal's form is the package this run was
// invoked as, through npx (harness.mjs invokedAs — a shell's own name when it
// came through one). `--write`: at a terminal that form shows the plan and
// asks anyway. Each command stands on its own line, after a blank one
// (presentation spec contract 6), so a copy takes exactly the command.
function nextLines(p, env, c) {
  const { cmd } = invokedAs(env);
  return p.scaffold && p.scaffold.ok && p.scaffold.creates > 0
    ? ["", prose(c, "Next: create the layout's missing folders and READMEs, in a session or from a terminal:"), ...commandBlock(c, [commandForm("scaffold", { env }), `${cmd} scaffold --write`])]
    : ["", prose(c, "Next: see where the project stands:"), ...commandBlock(c, [`${cmd} status`])];
}

// One line per step that ran. The whole-vault path's own Next lines: the
// derived views are reconcile's, offered rather than run.
function vaultSteps(p, done, c, env) {
  const lines = [];
  const g = done.git;
  if (g && g.done) lines.push(prose(c, `Initialised a git repository in ${p.vault} (no commit).`));
  if (g && g.inside) lines.push(prose(c, `\`${p.vault}\` is inside the git work tree at \`${g.inside}\`; the vault gets its own repository, which that repository will see as an embedded one.`));
  if (g && g.skipped) lines.push(prose(c, `Skipped git init: ${g.skipped}. The vault works without one; doctor's vault-git finding stays until it is a repository.`));
  if (g && g.failed) lines.push(prose(c, `git init failed: ${g.failed}`), prose(c, g.remedy, "  "));
  const s = done.scaffold;
  if (s && s.failed) lines.push(prose(c, `Scaffold failed: ${s.failed}`), prose(c, s.remedy, "  "));
  else if (s) lines.push(prose(c, `Scaffolded the ${p.layout} layout (${p.language}): ${s.created.length} folders and READMEs created${s.exists.length ? `, ${s.exists.length} already there` : ""}.`));
  if (!bindFailed(done)) lines.push("", prose(c, `Next, optional: generate the derived views ${icon(c, "dash")} kanban.md, graph.md and code-map.md:`), ...commandBlock(c, [`${invokedAs(env).cmd} reconcile --write`]));
  return lines;
}

// bind's and init's screen: what was written, the binding as key–value lines,
// then what to run next (presentation spec contracts 5 and 6). Its prose
// wraps on a live terminal. A refusal prints its message as it is. `caps` is
// the stream's (term.mjs); the default is plain text.
export function renderBindPlan(p, done = null, { env = process.env, caps: c = PLAIN } = {}) {
  const lines = [];
  if (!p.ok) { for (const r of p.refusals) lines.push(r.message); return lines.join("\n") + "\n"; }
  const ignoredNote = p.ignored.length ? ` ${icon(c, "dash")} --${p.ignored.join(" and --")} ignored: a change of ${p.ignored.join("/")} is not a rebind (edit the config, or rebind to another vault)` : "";
  if (p.state === "same" && !(done && p.buildsVault)) {
    lines.push(prose(c, `Already bound to ${p.vault}${ignoredNote}.`), ...nextLines(p, env, c));
    return lines.join("\n") + "\n";
  }
  if (done && done.created_vault) lines.push(prose(c, `Created ${p.vault}`));
  if (p.state === "same") lines.push(prose(c, `Already bound to ${p.vault}${ignoredNote}; its directory was missing, so init made the vault again.`));
  else {
    lines.push(prose(c, `Wrote ${p.configPath}${p.state === "different" ? ` (rebind from ${p.before.vault_path}; kept: ${p.keptKeys.join(", ") || "nothing else"})` : ""}`));
    lines.push(...kv(c, [["vault_path", p.vault], ["layout", p.layout], ["language", p.language]]));
  }
  if (done && p.buildsVault) lines.push(...vaultSteps(p, done, c, env));
  else if (done) lines.push(...nextLines(p, env, c));
  return lines.join("\n") + "\n";
}

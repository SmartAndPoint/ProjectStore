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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic, pluginRoot } from "./lib.mjs";
import { configPath as harnessConfigPath } from "./harness.mjs";

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

const shellQuote = (s) => (/^[A-Za-z0-9_\/.~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// What `bind` would write. `state`: "unbound" (fresh bind), "same" (already
// bound to this vault — nothing to write), "different" (bound elsewhere —
// needs --rebind). Refusals are the reasons apply() must not run; each has a
// code: USAGE (exit 2 upstream), MISSING, REBIND, BOUND, UNREADABLE,
// NO_PROJECT (exit 1).
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
  if (state === "same" && init) refusals.push({ code: "BOUND", message: `${projectDir} is already bound to ${vaultPath}` });
  const after = state === "same" ? before : state === "different"
    ? { ...before, vault_path: vaultPath, layout: chosenLayout, language: chosenLanguage }
    : { vault_path: vaultPath, layout: chosenLayout, auto_inject: true, language: chosenLanguage, tags: [], default_author: author || "", active_skills: true, approval_mode: "always" };
  const keptKeys = state === "different" ? Object.keys(before).filter((k) => !["vault_path", "layout", "language"].includes(k)).sort() : [];
  return {
    projectDir, configPath, vault: vaultPath, vaultExists, layout: chosenLayout, language: chosenLanguage, ignored,
    state, before, after, keptKeys, writes: refusals.length === 0 && state !== "same", createsVault: Boolean(init && vaultPath && !vaultExists && refusals.length === 0), refusals, ok: refusals.length === 0,
  };
}

// Writes what the plan says: the vault directory when init asked for it, the
// config through writeFileAtomic (its directory made first — the helper never
// mkdirs). Refuses to run a plan with refusals; a "same" plan writes nothing.
export function applyBind(plan) {
  if (!plan.ok) throw Object.assign(new Error(plan.refusals.map((r) => r.message).join("; ")), { code: plan.refusals[0].code });
  const done = { created_vault: false, wrote_config: false };
  if (plan.createsVault) { mkdirSync(plan.vault, { recursive: true }); done.created_vault = true; }
  if (plan.writes) {
    mkdirSync(dirname(plan.configPath), { recursive: true });
    writeFileAtomic(plan.configPath, JSON.stringify(plan.after, null, 2) + "\n");
    done.wrote_config = true;
  }
  return done;
}

// The result a front-end reports: the decided values, never the file body.
export function bindResult(plan, done) {
  return {
    state: plan.state, vault_path: plan.vault, vault_exists: Boolean(done && done.created_vault) || plan.vaultExists, layout: plan.layout, language: plan.language,
    config_path: plan.configPath, wrote: Boolean(done && done.wrote_config), created_vault: Boolean(done && done.created_vault),
    kept_keys: plan.keptKeys, ignored: plan.ignored, refusals: plan.refusals,
  };
}

export function renderBindPlan(p, done = null) {
  const lines = [];
  if (!p.ok) { for (const r of p.refusals) lines.push(r.message); return lines.join("\n") + "\n"; }
  if (p.state === "same") {
    lines.push(`Already bound to ${p.vault}${p.ignored.length ? ` — --${p.ignored.join(" and --")} ignored: a change of ${p.ignored.join("/")} is not a rebind (edit the config, or rebind to another vault)` : ""}. Run /projectstore:scaffold to (re)create the layout, or \`projectstore status\` to inspect it.`);
    return lines.join("\n") + "\n";
  }
  if (done && done.created_vault) lines.push(`Created ${p.vault}`);
  lines.push(`Wrote ${p.configPath}${p.state === "different" ? ` (rebind from ${p.before.vault_path}; kept: ${p.keptKeys.join(", ") || "nothing else"})` : ""}`);
  lines.push(`  vault_path: ${p.vault}`, `  layout:     ${p.layout}`, `  language:   ${p.language}`);
  if (done) lines.push("", p.vaultExists && !done.created_vault ? "Next: `projectstore status`, or /projectstore:scaffold if the vault has no layout folders yet." : "Next: /projectstore:scaffold in a session creates the layout's folders and READMEs.");
  return lines.join("\n") + "\n";
}

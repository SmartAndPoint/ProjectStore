#!/usr/bin/env node
// projectstore — doctor.mjs
// Deterministic, no-LLM diagnostics engine (ADR-005). Exports individual check
// functions plus group runners; consumed by the /projectstore:doctor command,
// the SessionStart hook (cheap --startup subset) and, later, reconcile.
//
// Read-only by contract: detection never mutates anything. Repairs live behind
// the command's --fix flow (install side) and reconcile (vault side).
//
// Finding: { group: "install"|"vault", level: "issue"|"warn"|"info",
//            check: "<id>", message: "...", file?: "<path>" }
// The SessionStart line counts level==="issue" only.
//
// CLI: node doctor.mjs [--install] [--vault] [--startup] [--json]
//      default = --install --vault. Exit code is always 0 (reporting tool).

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  accessSync,
  constants,
} from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diffAgainstDisk } from "./build-adapters.mjs";
import {
  emittingHarnesses, activeHarness, commandRef, localizeCommands,
  hasCapability, projectConfigDir, REPO_ROOT,
} from "./harness.mjs";
import {
  readConfig,
  configPath,
  loadLayout,
  folderByKind,
  parseFrontmatter,
  pluginRoot,
  projectRoot,
  listOf,
  readVaultConfig,
  claudeHome,
  installedPluginRoot,
  isPluginCacheRoot,
  statusLineIsOurs,
  statusLineIsOurWiring,
  isLegacyStory,
  sectionOf,
  headingLineRe,
  indexHeaderRe,
  evidenceSuffixRe,
  storiesAttributionRe,
  slugIdentity,
  isLegacyNumberedId,
  storyMatchesEntry,
  legalArtifactName,
  stripCodeSpans,
  extractLinks,
  buildNodeIndex,
  resolveLinkTarget,
  listVaultStoryFiles,
  openStoryFrom,
  readEntryLog,
  lastVaultActivityMs,
  ENTRY_IGNORE,
} from "./lib.mjs";
import { uncommittedProjectFiles, lastCommitMs } from "./diff-refs.mjs";

const AGENT_BLOCK_MARKER = /<!--\s*projectstore:agents v(\d+)/g;
// v3 adds the entry rule and the instruction-conflict clause. checkAgentsBlock
// compares the marker version alone, so the bump IS the propagation mechanism:
// without it no bound project ever learns the block changed. The cost is that
// every already-bound project reports an install issue until it re-runs
// /projectstore:agents register — intended, and disclosed in the release note.
const AGENT_BLOCK_VERSION = 3;
// The live roster. A copy carrying one of these names does NOT override the
// bundled agent (ADR-008, verified 2026-08-05): plugin agents register under a
// scoped id, project/user copies register bare, so the names never collide and
// the documented scope-priority rule never fires. Such a copy is a sibling, and
// /projectstore:agents configure no longer writes one.
const CURRENT_AGENT_NAMES = ["critic", "planner", "reviewer", "librarian", "archaeologist"];
// Names bundled BEFORE v0.13 (ADR-001/004). Provenance checks need them to
// recognise a copy as ours.
//
// `renamed` and `replaced` still carry different advice, but NOT the advice this
// table originally held. It used to say a pure rename (projectstore-critic →
// critic) "restores the override" — under ADR-008 nothing restores an override,
// because a bare-named copy never overrode the scoped plugin agent to begin
// with. What survives is the role question: critic was the same role under a new
// name, whereas planner/reviewer were *transformed* into narrow vault-aware
// roles that explicitly are not general-purpose, so renaming a general-purpose
// copy onto them would silently swap its job.
const LEGACY_AGENTS = {
  "projectstore-critic": { now: "critic", renamed: true },
  "code-planner": { now: "planner", renamed: false },
  "code-reviewer": { now: "reviewer", renamed: false },
};
const BUNDLED_AGENT_NAMES = [...CURRENT_AGENT_NAMES, ...Object.keys(LEGACY_AGENTS)];

function finding(group, level, check, message, file) {
  // Single choke point for command spelling: every doctor message names
  // commands, and this is the one place all of them pass through.
  const f = { group, level, check, message: localizeCommands(message) };
  if (file) f.file = file;
  return f;
}

function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

function listMd(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

// ─── Install checks ────────────────────────────────────────────────────

export function checkConfig(cfg) {
  if (!cfg) {
    return [finding("install", "issue", "config",
      `No projectstore config (${configPath()}). Run ${commandRef("bind")} <vault-path>.`)];
  }
  const out = [];
  if (!cfg.vault_path) out.push(finding("install", "issue", "config", "Config has no vault_path."));
  return out;
}

export function checkVaultPath(cfg) {
  const out = [];
  const vault = cfg.vault_path;
  if (!existsSync(vault)) {
    out.push(finding("install", "issue", "vault-path", `Vault path does not exist: ${vault}`));
    return out;
  }
  try {
    readdirSync(vault);
  } catch {
    out.push(finding("install", "issue", "vault-path", `Vault path is not readable/listable: ${vault}`));
    return out;
  }
  try {
    accessSync(vault, constants.W_OK);
  } catch {
    out.push(finding("install", "issue", "vault-path", `Vault path is not writable: ${vault}`));
  }
  return out;
}

export function checkLayoutTemplates(cfg) {
  const out = [];
  let layout;
  try {
    layout = loadLayout(cfg.layout);
  } catch (e) {
    out.push(finding("install", "issue", "layout", `Layout not loadable: ${e.message}`));
    return out;
  }
  const lang = cfg.language || "en";
  // Layout-driven (PS-SPEC story-001): a command needs a template iff it maps
  // to a declared folder kind ("story" maps through the epic folder; "kanban"
  // through the layout's kanban block). Folders WITHOUT a command (e.g.
  // diagrams) require no template — no false findings for them.
  const kinds = (layout.commands || []).filter((k) => {
    if (k === "kanban") return Boolean(layout.kanban);
    if (k === "story") return Boolean(folderByKind(layout, "epic"));
    return Boolean(folderByKind(layout, k));
  });
  kinds.push("folder-readme");
  for (const k of kinds) {
    const p = join(pluginRoot(), "templates", lang, `${k}.md.tmpl`);
    if (!existsSync(p)) {
      out.push(finding("install", "issue", "templates", `Missing template for language "${lang}": ${k}.md.tmpl`));
    }
  }
  if (!existsSync(join(pluginRoot(), "scaffold", "headings.json"))) {
    out.push(finding("install", "issue", "templates",
      "scaffold/headings.json is missing — heading-registry checks (index headers, acceptance, spec gates) cannot run. Stale/corrupt plugin install?"));
  }
  return out;
}

export function checkHooksAlive(cfg, maxAgeMinutes = 30) {
  const dir = join(cfg.vault_path, ".projectstore", "sessions");
  if (!existsSync(dir)) {
    return [finding("install", "warn", "hooks",
      "No session registry in the vault — SessionStart hook may not be firing (or no session started yet).")];
  }
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const fresh = readdirSync(dir).some((n) => {
    if (!n.endsWith(".json")) return false;
    try { return statSync(join(dir, n)).mtimeMs >= cutoff; } catch { return false; }
  });
  return fresh ? [] : [finding("install", "warn", "hooks",
    `No session registration fresher than ${maxAgeMinutes} min — hooks may not be firing.`)];
}

// Which plugin version a wired statusLine script belongs to. Null for our
// launcher (<project>/.claude/.projectstore/statusline.mjs), which has no
// version of its own — it resolves the installed one at render time.
export function statusLineScriptVersion(scriptPath) {
  try {
    const root = dirname(dirname(scriptPath)); // <root>/scripts/statusline.mjs
    return (
      JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version || null
    );
  } catch {
    return null;
  }
}

// Read-only probe of the statusline wiring (never calls syncStatusLine, which
// is a mutating self-heal that SessionStart already ran — ADR-005).
export function checkStatusline(cfg, proj, home = homedir()) {
  // syncStatusLine and checkGitignore both learned this gate; this check did
  // not, and it is the one inside the startup budget. On a harness with no
  // status line slot, a project whose config carries statusline.enabled — a
  // Claude Code bind, opened in Codex, which is this feature's own headline use
  // case — found no wiring, reported an ISSUE, and advised a restart that can
  // never wire it, on every single session start. A permanent, unfixable,
  // once-per-session error is worse than no check.
  if (!hasCapability("statusline")) return [];
  const out = [];
  const local = join(proj, ".claude", "settings.local.json");
  let cur = null;
  if (existsSync(local)) {
    try {
      cur = JSON.parse(readFileSync(local, "utf8"))?.statusLine ?? null;
    } catch {
      out.push(finding("install", "warn", "statusline", `.claude/settings.local.json is not parseable JSON.`));
      return out;
    }
  }
  const curCmd = cur && typeof cur.command === "string" ? cur.command : null;
  // Strict: only a wiring we could have written is ours to rewire or delete.
  const isOurs = statusLineIsOurWiring(curCmd, proj, home);
  const st = cfg.statusline;

  if (st && st.enabled === true) {
    if (!curCmd) {
      out.push(finding("install", "issue", "statusline",
        "statusline.enabled=true but no statusLine wired in settings.local.json — restart the session (the hook wires it) or check hook health."));
    } else if (!isOurs) {
      out.push(finding("install", "issue", "statusline",
        "statusline.enabled=true but a foreign statusLine occupies settings.local.json — the hook will not clobber it. Clear it or disable the flag."));
    } else {
      const m = curCmd.match(/"([^"]+statusline\.mjs)"/) || curCmd.match(/(\S+statusline\.mjs)/);
      const wiredRoot = m ? dirname(dirname(m[1])) : null;
      const isLauncher = m ? m[1].replace(/\\/g, "/").includes("/.projectstore/statusline.mjs") : false;
      if (m && !existsSync(m[1])) {
        out.push(finding("install", "issue", "statusline",
          isLauncher
            ? `statusLine points at a generated launcher that no longer exists: ${m[1]} — the next session start regenerates it.`
            : `statusLine points at a missing script (stale plugin path?): ${m[1]}`));
      } else if (m && isPluginCacheRoot(wiredRoot, home)) {
        // Only a versioned cache path can go stale this way. The launcher
        // carries no version, and a dev checkout is wired deliberately and
        // never rewired — warning about either would be a permanent lie.
        const wired = statusLineScriptVersion(m[1]);
        const inst = installedPluginRoot(home, dirname(wiredRoot));
        if (wired && inst && inst.version && wired !== inst.version) {
          out.push(finding("install", "warn", "statusline",
            `statusLine is wired to projectstore ${wired} while ${inst.version} is installed — a version-pinned path lags one session behind each update. The next session start rewires it to the version-agnostic launcher.`));
        }
      }
    }
  } else if (st && st.enabled === false && isOurs) {
    out.push(finding("install", "warn", "statusline",
      "statusline.enabled=false but our statusLine entry is still wired — the hook removes it on next session start."));
  } else if ((!st || typeof st.enabled !== "boolean") && isOurs) {
    out.push(finding("install", "info", "statusline",
      "statusLine wired manually (no statusline flag in projectstore.json) — the hook will leave it alone."));
  }

  try {
    const base = JSON.parse(readFileSync(join(claudeHome(home), "settings.json"), "utf8"))?.statusLine?.command;
    if (base && !statusLineIsOurs(base)) {
      out.push(finding("install", "info", "statusline", "Base HUD present in your user settings.json — projectstore composes above it."));
    }
  } catch {}
  // session_id divergence (ADR-006): the renderer's breadcrumb names the id
  // the statusLine process received; hook-side pointer files name the ids the
  // hooks observed. A breadcrumb id with no pointer file while others exist
  // means the two processes disagree — the issue note's second suspect.
  try {
    // lib.mjs's sessionStateDir follows the active harness; this read of the
    // same directory was still pinned to .claude, so under any other harness
    // doctor inspected a directory nothing writes.
    const sdir = join(projectConfigDir(proj), ".projectstore", "state");
    const bc = JSON.parse(readFileSync(join(sdir, ".last-render.json"), "utf8"));
    if (bc && bc.session_id) {
      const hookIds = readdirSync(sdir)
        .filter((n) => n.endsWith(".json") && !n.startsWith("."))
        .map((n) => n.replace(/\.json$/, ""));
      if (hookIds.length && !hookIds.includes(bc.session_id)) {
        out.push(finding("install", "warn", "statusline",
          `statusLine renderer last saw session_id ${String(bc.session_id).slice(0, 8)}… with no hook-side state file — possible session_id divergence (renderer shows the cold-start line while hooks log activity).`));
      }
    }
    // What the user is actually looking at: the renderer stamps the version
    // that drew the line. Breadcrumbs without a root (pre-0.16.0) and dev
    // checkouts are skipped — only a cache install can go stale this way.
    if (bc && bc.version && isPluginCacheRoot(bc.root, home)) {
      const inst = installedPluginRoot(home, dirname(bc.root));
      if (inst && inst.version && inst.version !== bc.version) {
        out.push(finding("install", "warn", "statusline",
          `The last status line rendered in this project came from projectstore ${bc.version} while ${inst.version} is installed — a session that resolved its statusLine command before the update (the breadcrumb is per project, so it may belong to a sibling session). Restart that session; after that the launcher picks up the installed version at every render.`));
      }
    }
  } catch {}
  return out;
}

export function checkAgentsBlock(proj) {
  const out = [];
  let blocks = 0;
  let staleVersions = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(proj, name);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const m of text.matchAll(AGENT_BLOCK_MARKER)) {
      blocks++;
      const v = parseInt(m[1], 10);
      if (v !== AGENT_BLOCK_VERSION) staleVersions.push({ file: name, v });
    }
  }
  if (blocks === 0) {
    out.push(finding("install", "info", "agents-block",
      "Agent routing block not registered — optional; ships with /projectstore:agents (v0.13)."));
  }
  if (blocks > 1) {
    out.push(finding("install", "issue", "agents-block",
      `Duplicated projectstore:agents block (${blocks} markers across CLAUDE.md/AGENTS.md) — keep exactly one; register migrates, never duplicates.`));
  }
  for (const s of staleVersions) {
    out.push(finding("install", "issue", "agents-block",
      `Agents block in ${s.file} is v${s.v}, expected v${AGENT_BLOCK_VERSION} — re-run /projectstore:agents register.`, s.file));
  }
  return out;
}

// Both scopes are walked. The original reason ("project > user > plugin, so a
// copy in either scope shadows the bundle") turned out to be wrong — a copy
// shadows NOTHING, because plugin agents register under a scoped id and copies
// under a bare one (ADR-008). The conclusion survives its premise: a user-scope
// copy still stands beside the bundled agent in every project, so reporting only
// the project scope would leave that permanently invisible.
//
// Provenance is established by the `# source: projectstore vX` marker OR by a
// bundled name: copies taken before the marker existed have no other tell, and
// those are precisely the ones old enough to have gone stale. Where the marker
// is absent the finding drops to `info`, since a same-named agent the user
// wrote themselves is indistinguishable from ours.
export function checkOverrideCopies(proj, home = homedir()) {
  const out = [];
  const ver = pluginVersion();
  // Both scopes follow the active harness: a leftover copy under ~/.codex/agents
  // shadows nothing on Claude Code and vice versa, so reporting the other
  // harness's directory would be a finding the user cannot act on.
  const d = activeHarness()?.runtime?.project_config_dir || ".claude";
  // basename, not the raw path: with CLAUDE_CONFIG_DIR=/opt/cc-config the label
  // read "~/cc-config/agents", which names a directory that does not exist.
  const agentHomeDir = claudeHome(home);
  const hd = agentHomeDir.startsWith(home + "/") ? "~/" + agentHomeDir.slice(home.length + 1) : agentHomeDir;
  const scopes = [
    { dir: join(proj, d, "agents"), label: `${d}/agents`, scope: "project" },
    { dir: join(agentHomeDir, "agents"), label: `${hd}/agents`, scope: "user" },
  ];
  for (const { dir, label, scope } of scopes) {
    for (const f of listMd(dir)) {
      let text;
      try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
      const m = text.match(/#\s*source:\s*projectstore\s+v(\S+)/);
      const { data } = parseFrontmatter(text);
      // A provenance-marked copy with no `name:` still deserves a usable
      // message: falling back to the filename beats reporting `name ""`.
      const name = data.name || (m ? basename(f, ".md") : "");
      if (!m && !BUNDLED_AGENT_NAMES.includes(name)) continue; // user-authored agent — never ours to judge

      const where = join(label, f);
      const everywhere = scope === "user" ? " User-scoped, so it applies in every project." : "";

      if (Object.hasOwn(LEGACY_AGENTS, name)) {
        const { now, renamed } = LEGACY_AGENTS[name];
        const advice = renamed
          ? `v0.13 renamed the role to "${now}". Renaming this file would NOT make it override the bundled agent — nothing does (ADR-008) — so delete it, or keep it as an agent of your own under a name you invoke deliberately.`
          : `v0.13 replaced it with a narrower vault-aware "${now}", so renaming would swap its role — keep this copy if you use it outside projectstore, but re-check its pinned model.`;
        // without a provenance marker we cannot prove lineage — hedge FIRST,
        // not 40 words in, or the false premise leads for user-authored agents
        const lead = m ? `${f}` : `If ${f} began as a projectstore copy (no provenance marker — ignore otherwise): it`;
        out.push(finding("install", m ? "warn" : "info", "override-copies",
          `${lead} carries the pre-v0.13 name "${name}", which no longer matches a bundled agent, so it overrides nothing and stands alongside "${now}" in the roster.${everywhere} ${advice}`,
          where));
        continue; // a stale-version note on top would just be noise
      }
      if (!CURRENT_AGENT_NAMES.includes(name)) {
        out.push(finding("install", "warn", "override-copies",
          `Override copy ${f} has name "${name}" which matches no bundled agent — it duplicates instead of overriding.${everywhere}`, where));
        continue;
      }
      // ADR-008. A current-name copy overrides nothing either: the bundled agent
      // registers as "projectstore:<name>" and this one as "<name>", so both are
      // live and the registration block keeps invoking the bundled one — the
      // model pinned here never runs. This fires at ANY version, because
      // refreshing such a copy fixes nothing; that is why it replaces the old
      // "frozen at vX — re-run configure" advice instead of sitting beside it.
      // Staleness is demoted to a parenthetical: still true, no longer the point.
      const stale = m && ver && m[1] !== ver
        ? ` (It is also frozen at projectstore v${m[1]}, installed v${ver}.)`
        : "";
      // Without a marker we cannot prove lineage — hedge FIRST, and never issue
      // a delete imperative against a file the user may well have written.
      const lead = m
        ? `Override copy ${f} overrides nothing.`
        : `If ${f} began as a projectstore copy (no provenance marker — ignore otherwise): it overrides nothing.`;
      // `configure` only ever touched PROJECT scope, so pointing a user-scope
      // copy at it would name a command that will not act — the scope split
      // fca8def introduced for staleness applies here for the same reason.
      const remove = scope === "user"
        ? `Delete ${where} by hand (or via /projectstore:doctor --fix) — /projectstore:agents configure only cleans up project-scope copies.`
        : "Delete it via /projectstore:agents configure, which now records the model in .claude/projectstore.json and passes it per invocation.";
      const advice = m
        ? remove
        : "If you wrote it yourself, nothing is broken; if you meant to change the bundled agent's model, that is /projectstore:agents configure, not a copy.";
      out.push(finding("install", m ? "warn" : "info", "override-copies",
        `${lead} It registers as "${name}" while the bundled agent registers as "projectstore:${name}", so both exist side by side.${everywhere}${stale} ${advice}`,
        where));
    }
  }
  return out;
}

// ADR-008 made `effort` unconfigurable per project, which promotes this env var
// from a curiosity to the ONLY thing that can move our agents off `effort: max`.
// It beats frontmatter, so a value set for cost or latency silently drops all
// five agents below the quality floor the plugin advertises — exactly the class
// of silent downgrade doctor exists to name.
export function checkEnvEffort() {
  const v = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  if (!v) return [];
  return [finding("install", "warn", "env-effort",
    `CLAUDE_CODE_EFFORT_LEVEL=${v} is set — it overrides the bundled agents' "effort: max" frontmatter, so every projectstore agent runs at "${v}". Effort is not configurable per project (ADR-008); unset the variable to restore the quality floor.`)];
}

export function checkEnvModel() {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return [finding("install", "warn", "env-model",
      `CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL} is set — it overrides ALL projectstore agent model configuration, per-invocation parameter included.`)];
  }
  return [];
}

export function checkGitignore(proj) {
  if (!existsSync(join(proj, ".git"))) return [];
  let lines = [];
  try {
    lines = readFileSync(join(proj, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  } catch {}
  // The directory to check is the ACTIVE harness's, not always ".claude/":
  // machine-local state follows the harness, so a Codex user with only
  // ".claude/" ignored would be committing their own session pointers.
  const m = activeHarness();
  const d = m?.runtime?.project_config_dir || ".claude";
  const coveredAll = lines.includes(`${d}/`) || lines.includes(d);
  if (coveredAll) return [];
  const wanted = [`${d}/projectstore.json`, `${d}/.projectstore/`];
  if (m?.capabilities?.statusline) wanted.splice(1, 0, `${d}/settings.local.json`);
  const missing = wanted.filter((w) => !lines.includes(w));
  if (!missing.length) return [];
  return [finding("install", "warn", "gitignore",
    `Machine-specific files not gitignored: ${missing.join(", ")} (or ignore "${d}/" wholesale).`)];
}

export function checkVaultGit(cfg) {
  if (existsSync(join(cfg.vault_path, ".git"))) return [];
  return [finding("install", "warn", "vault-git",
    "Vault is not a git repository — the knowledge has no history/blame/review. Consider `git init` (doctor --fix offers it).")];
}

function versionNewer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Marketplace auto-update (maintainer request 2026-07-03): third-party
// marketplaces do NOT auto-update by default, so a stale plugin looks like
// "the feature is broken". Read the real registries and, when the flag is
// off, tell the user the exact correct values.
export function checkAutoUpdate(home = homedir()) {
  const out = [];
  // Two corrections over the first version of this check, both found by running
  // doctor straight out of a checkout (2026-08-05):
  //
  // 1. The path pattern required a segment AFTER the marketplace name, so a
  //    marketplace clone root (.../plugins/marketplaces/<name>) never matched
  //    even though the name is right there. Hence the trailing (?:/|$).
  // 2. pluginRoot() is the SCRIPT's own location. That equals the session's
  //    plugin only when Claude Code launched us via $CLAUDE_PLUGIN_ROOT; run
  //    from a checkout it reported "local dev install" about what was in fact
  //    an ordinary marketplace install — the check described itself, not the
  //    session. So fall back to the registered install when our own path says
  //    nothing, and never claim --plugin-dir as a conclusion.
  const marketplaceOf = (p) =>
    (String(p || "").replace(/\\/g, "/").match(/\/plugins\/(?:cache|marketplaces)\/([^/]+)(?:\/|$)/) || [])[1] || null;
  const inst = installedPluginRoot(home);
  const marketplace = marketplaceOf(pluginRoot()) || marketplaceOf(inst && inst.path);
  if (!marketplace) {
    out.push(finding("install", "info", "auto-update",
      "No marketplace install of projectstore found (--plugin-dir, or a checkout with none registered) — marketplace auto-update not applicable."));
    return out;
  }

  let registry = null;
  try {
    registry = JSON.parse(readFileSync(join(claudeHome(home), "plugins", "known_marketplaces.json"), "utf8"));
  } catch {}
  const entry = registry ? registry[marketplace] : null;
  if (!entry) {
    out.push(finding("install", "warn", "auto-update",
      `Marketplace "${marketplace}" is missing from ~/.claude/plugins/known_marketplaces.json — updates cannot be tracked. Re-add it: /plugin marketplace add <owner/repo>.`));
    return out;
  }

  let enabled = entry.autoUpdate === true;
  if (!enabled) {
    try {
      const s = JSON.parse(readFileSync(join(claudeHome(home), "settings.json"), "utf8"));
      if (s?.extraKnownMarketplaces?.[marketplace]?.autoUpdate === true) enabled = true;
    } catch {}
  }
  if (!enabled) {
    out.push(finding("install", "warn", "auto-update",
      `Auto-update is OFF for marketplace "${marketplace}" — new projectstore releases will not be noticed. ` +
      `Correct values: "autoUpdate": true on the "${marketplace}" entry in ~/.claude/plugins/known_marketplaces.json ` +
      `(set via /plugin → Marketplaces → ${marketplace} → toggle auto-update), or in ~/.claude/settings.json → ` +
      `extraKnownMarketplaces.${marketplace}.autoUpdate: true. Manual path: /plugin marketplace update ${marketplace}, then /reload-plugins.`));
  }

  // Bonus: the marketplace checkout's catalog knows the latest released
  // version — flag when it is newer than the one actually running.
  //
  // "Running" must be read from the SAME root that named the marketplace above.
  // On the fallback path our own script is a checkout, so pluginRoot() and
  // pluginVersion() describe the checkout, not the install — reporting that as
  // the running version is the very confusion this check was just fixed for.
  const named = marketplaceOf(pluginRoot()) ? { path: pluginRoot(), version: null } : inst;
  try {
    const root = (named && named.path) || pluginRoot();
    const name = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name;
    const catalog = JSON.parse(readFileSync(join(entry.installLocation, ".claude-plugin", "marketplace.json"), "utf8"));
    const latest = (catalog.plugins || []).find((p) => p.name === name)?.version;
    const running = (named && named.version)
      || JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
    if (latest && running && versionNewer(latest, running)) {
      out.push(finding("install", "warn", "auto-update",
        `A newer ${name} is available: v${latest} (running v${running}) — run /plugin marketplace update ${marketplace}, then /reload-plugins.`));
    }
  } catch {}
  return out;
}

// ─── Vault checks ──────────────────────────────────────────────────────

// Collect every structured artifact with parsed frontmatter.
export function scanArtifacts(cfg, layout) {
  const vault = cfg.vault_path;
  const artifacts = [];
  const push = (abs, rel, kind) => {
    let md;
    try { md = readFileSync(abs, "utf8"); } catch { return; }
    artifacts.push({ abs, rel, kind, fm: parseFrontmatter(md).data, body: md });
  };
  for (const folder of layout.folders) {
    const dir = join(vault, folder.path);
    if (!existsSync(dir)) continue;
    if (folder.kind === "epic") {
      for (const id of readdirSync(dir)) {
        const epicMd = join(dir, id, "epic.md");
        if (existsSync(epicMd)) push(epicMd, `${folder.path}/${id}/epic.md`, "epic");
        const storiesDir = join(dir, id, "stories");
        for (const f of listMd(storiesDir)) {
          push(join(storiesDir, f), `${folder.path}/${id}/stories/${f}`, "story");
        }
      }
    } else {
      for (const f of listMd(dir)) {
        if (f === "README.md") continue;
        push(join(dir, f), `${folder.path}/${f}`, folder.kind);
      }
    }
  }
  return artifacts;
}

// status ↔ kanban: generate the expected board with the real generator and
// text-diff it against disk, ignoring the generated_at stamp (ADR-005).
export function checkKanbanSync(cfg) {
  const vault = cfg.vault_path;
  const onDisk = join(vault, "kanban.md");
  if (!existsSync(onDisk)) {
    return [finding("vault", "info", "kanban", "No kanban.md yet — run /projectstore:kanban to create the board.")];
  }
  const r = spawnSync(process.execPath, [join(pluginRoot(), "scripts", "kanban.mjs")], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot() },
  });
  if (r.status !== 0) {
    return [finding("vault", "warn", "kanban", `kanban generator failed: ${(r.stderr || "").trim()}`)];
  }
  let expected;
  try { expected = JSON.parse(r.stdout).content; } catch {
    return [finding("vault", "warn", "kanban", "kanban generator returned unparseable output.")];
  }
  const norm = (s) => s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();
  if (norm(expected) !== norm(readFileSync(onDisk, "utf8"))) {
    return [finding("vault", "issue", "kanban",
      "kanban.md is out of sync with story frontmatter — run /projectstore:kanban (or reconcile).", "kanban.md")];
  }
  return [];
}

// Folder README index rows ↔ artifact frontmatter.
export function checkIndexes(cfg, layout, artifacts) {
  const out = [];
  const vault = cfg.vault_path;
  const rowRx = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|([^|]+)\|([^|]+)\|([^|]+)\|/;
  for (const folder of layout.folders) {
    const readme = join(vault, folder.path, "README.md");
    if (!existsSync(readme)) continue;
    let rows = [];
    for (const line of readFileSync(readme, "utf8").split("\n")) {
      const m = line.match(rowRx);
      if (m) rows.push({ label: m[1], target: m[2].replace(/^\.\//, ""), title: m[3].trim(), status: m[4].trim() });
    }
    const indexed = new Set();
    for (const row of rows) {
      const rel = `${folder.path}/${row.target}`;
      indexed.add(rel);
      const art = artifacts.find((a) => a.rel === rel);
      if (!art) {
        out.push(finding("vault", "issue", "index",
          `${folder.path}/README.md row "${row.label}" points at a missing file: ${row.target}`, `${folder.path}/README.md`));
        continue;
      }
      const fmStatus = (art.fm.status || "").trim();
      if (fmStatus && row.status && fmStatus !== row.status) {
        out.push(finding("vault", "issue", "index",
          `${folder.path}/README.md lists "${row.label}" as "${row.status}" but its frontmatter says "${fmStatus}".`, art.rel));
      }
      const fmTitle = (art.fm.title || "").trim();
      if (fmTitle && row.title && fmTitle !== row.title) {
        out.push(finding("vault", "warn", "index",
          `${folder.path}/README.md title for "${row.label}" differs from frontmatter title.`, art.rel));
      }
    }
    for (const a of artifacts) {
      const inFolder = folder.kind === "epic"
        ? a.kind === "epic" && a.rel.startsWith(`${folder.path}/`)
        : a.kind === folder.kind && a.rel === `${folder.path}/${basename(a.rel)}`;
      if (inFolder && !indexed.has(a.rel)) {
        out.push(finding("vault", "warn", "index",
          `${a.rel} is not listed in ${folder.path}/README.md's index.`, a.rel));
      }
    }
  }
  return out;
}

// Fence/inline-code stripping lives in lib.mjs (stripCodeSpans) — one
// definition shared with the link-graph extractor, so "not a link/checkbox
// when inside code" means the same thing everywhere.

// RAW lines outside fenced blocks — for checks that must both MATCH (fence-
// immune) and REPORT the line verbatim (backticks intact in the message).
function linesOutsideFences(s) {
  const out = [];
  let fenced = false;
  for (const line of s.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) out.push(line);
  }
  return out;
}

// Epic id of a story artifact, derived from the layout's epic folder path —
// never from a hardcoded segment index (custom layouts may nest the folder).
function epicIdOf(storyRel, epicFolderPath) {
  if (!storyRel.startsWith(epicFolderPath + "/")) return null;
  return storyRel.slice(epicFolderPath.length + 1).split("/")[0];
}

export function checkStoriesAndEpics(artifacts) {
  const out = [];
  for (const a of artifacts) {
    if (a.kind === "story" && (a.fm.status || "").toLowerCase() === "done") {
      const sec = sectionOf(a.body, "acceptance") || "";
      const unchecked = (stripCodeSpans(sec).match(/- \[ \]/g) || []).length;
      if (unchecked > 0) {
        out.push(finding("vault", "warn", "acceptance",
          `Story is "done" with ${unchecked} unchecked acceptance criteria.`, a.rel));
      }
    }
    if ((a.fm.review_status || "") === "reviewed" && (!a.fm.reviewed_at || a.fm.reviewed_at === "null")) {
      out.push(finding("vault", "issue", "review-status",
        `review_status is "reviewed" but reviewed_at is empty.`, a.rel));
    }
  }
  for (const epic of artifacts.filter((a) => a.kind === "epic")) {
    if ((epic.fm.status || "").toLowerCase() !== "done") continue;
    const dir = epic.rel.replace(/\/epic\.md$/, "");
    const open = artifacts.filter((s) =>
      s.kind === "story" && s.rel.startsWith(dir + "/") && (s.fm.status || "").toLowerCase() !== "done");
    if (open.length) {
      out.push(finding("vault", "issue", "epic-status",
        `Epic is "done" while ${open.length} child stor${open.length === 1 ? "y is" : "ies are"} not.`, epic.rel));
    }
  }
  return out;
}

// Folder README whose index table header matches no registered form — the
// silent-rebuildIndex-null class of failure (ru indexes never reconciled for
// the whole life of the feature). Standard form is 4 columns; extra hand-kept
// columns (e.g. a 5-column specs index) are flagged for migration, since
// reconcile would drop them.
export function checkIndexHeaders(cfg, layout) {
  const out = [];
  const headerRe = indexHeaderRe();
  for (const folder of layout.folders) {
    const readme = join(cfg.vault_path, folder.path, "README.md");
    if (!existsSync(readme)) continue;
    const lines = readFileSync(readme, "utf8").split("\n");
    const headIdx = lines.findIndex((l, i) =>
      /^\|.*\|\s*$/.test(l) && /^\|[-\s|]+\|\s*$/.test(lines[i + 1] || ""));
    if (headIdx === -1) continue; // no table at all — nothing to lint
    if (!headerRe.test(lines[headIdx])) {
      out.push(finding("vault", "warn", "index-header",
        `${folder.path}/README.md index header "${lines[headIdx].trim()}" matches no registered form — reconcile cannot rebuild this index (standard form: | File | Title | Status | Date |, localized forms in scaffold/headings.json).`,
        `${folder.path}/README.md`));
    }
  }
  return out;
}

// ─── Spec checks (PS-SPEC story-006, ADR-007 Decisions 2/3/5/6) ────────
//
// All spec gates are no-ops unless the VAULT policy says spec_policy=required.
// Link integrity (checkSpecLinks) runs whenever specs exist — dead links are
// defects regardless of policy.

function specStatusOf(spec) {
  return String(spec.fm.status || "draft").toLowerCase();
}

// Filename stem used for story identity matching; a folder-shape story
// (stories/<name>/README.md) is identified by its folder name.
function storyStemOf(storyRel) {
  const b = basename(storyRel);
  return b === "README.md" ? basename(dirname(storyRel)) : b.replace(/\.md$/, "");
}

// Resolve a spec's `stories:` entry "<epic-id>/<story-id>" to a story
// artifact. Tiered via the shared matcher (SPEC-002 contract 5): exact fm.id,
// exact filename stem, legacy story-NNN prefix fallback — the strongest tier
// wins across the epic's stories, and a tie within it is a reported
// ambiguity, never a silent first match.
function resolveSpecStory(entry, artifacts, epicFolderPath) {
  const m = String(entry).match(/^([^/]+)\/(.+)$/);
  if (!m) return { error: `not in <epic-id>/<story-id> form: "${entry}"` };
  const [, epicId, storyId] = m;
  let best = 0;
  let hits = [];
  for (const a of artifacts) {
    if (a.kind !== "story" || epicIdOf(a.rel, epicFolderPath) !== epicId) continue;
    const tier = storyMatchesEntry(storyId, { id: a.fm.id, stem: storyStemOf(a.rel) });
    if (!tier) continue;
    if (best === 0 || tier < best) { best = tier; hits = [a]; }
    else if (tier === best) hits.push(a);
  }
  if (hits.length === 1) return { story: hits[0] };
  if (hits.length > 1) {
    return { error: `ambiguous — "${storyId}" matches ${hits.map((a) => storyStemOf(a.rel)).join(", ")}; qualify the reference` };
  }
  return { error: `no story in ${epicFolderPath}/${epicId} matches "${storyId}" (by exact id:, exact filename stem, or legacy story-NNN prefix)` };
}

// The ONE spec resolver (SPEC-002 contract 5) — shared by checkSpecLinks,
// checkSpecCoverage and checkSpecAcceptance: dual-keying only some of them
// would let the others silently skip a resolvable spec (their "dead link
// already reported" premise breaks). Exact fm.id wins (grandfathered
// SPEC-NNN entries hit here); normalized filename-stem candidates (legacy
// prefix stripped, case-insensitive) resolve slug-form references to
// grandfathered SPEC-NNN-<slug>.md files. Cross-spec identity clashes are
// the identity check's finding, so first-wins here stays deterministic.
function buildSpecResolver(artifacts, layout = null) {
  const prefix = layout ? folderByKind(layout, "spec")?.prefix ?? null : null;
  const byId = new Map();
  const byStem = new Map();
  for (const s of artifacts.filter((a) => a.kind === "spec")) {
    const id = String(s.fm.id || "");
    if (id && !byId.has(id)) byId.set(id, s);
    for (const c of slugIdentity(basename(s.rel), { prefix }).candidates) {
      if (!byStem.has(c.id)) byStem.set(c.id, s);
    }
  }
  return (ref) => byId.get(String(ref)) ?? byStem.get(String(ref).toLowerCase()) ?? null;
}

// Parse a spec's Acceptance section into items:
// { checked, text, stories: [bare story ids] | null (unattributed) }
export function parseSpecAcceptance(spec) {
  const sec = sectionOf(spec.body, "spec_acceptance");
  if (sec === null) return null;
  const attrRe = storiesAttributionRe();
  const items = [];
  for (const line of linesOutsideFences(sec)) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const text = m[2];
    // Full-width colon accepted for the same reason as the evidence suffix: a zh
    // spec writing `— stories：PS-X/story-foo` must attribute the item to that
    // story, not silently fall through to "applies to every covered story".
    const attr = text.match(attrRe);
    const stories = attr
      ? attr[1].split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    items.push({ checked, text, stories });
  }
  return items;
}

export function checkSpecLinks(cfg, layout, artifacts) {
  const out = [];
  const epicFolder = folderByKind(layout, "epic");
  if (!epicFolder) return out;
  const specs = artifacts.filter((a) => a.kind === "spec");
  const resolveSpec = buildSpecResolver(artifacts, layout);

  for (const spec of specs) {
    for (const entry of listOf(spec.fm, "stories")) {
      const r = resolveSpecStory(entry, artifacts, epicFolder.path);
      if (r.error) {
        out.push(finding("vault", "issue", "spec-links",
          `Spec "${spec.fm.id}" stories entry "${entry}" does not resolve: ${r.error}.`, spec.rel));
      } else if (spec.fm.id &&
                 !listOf(r.story.fm, "specs").some((ref) => resolveSpec(ref) === spec)) {
        // Membership through the SAME resolver — a slug-form back-reference
        // to a grandfathered SPEC-NNN file is a valid link, not a gap.
        out.push(finding("vault", "warn", "spec-links",
          `Spec "${spec.fm.id}" covers ${entry} but the story's \`specs:\` list lacks "${spec.fm.id}" (bidirectional link).`, r.story.rel));
      }
    }
  }
  for (const story of artifacts.filter((a) => a.kind === "story")) {
    for (const id of listOf(story.fm, "specs")) {
      const spec = resolveSpec(id);
      if (!spec) {
        out.push(finding("vault", "issue", "spec-links",
          `Story lists spec "${id}" which does not exist in specs/.`, story.rel));
      } else {
        const epicId = epicIdOf(story.rel, epicFolder.path);
        const stem = storyStemOf(story.rel);
        const covered = listOf(spec.fm, "stories").some((e) => {
          const m = String(e).match(/^([^/]+)\/(.+)$/);
          return m && m[1] === epicId &&
            storyMatchesEntry(m[2], { id: story.fm.id, stem }) > 0;
        });
        if (!covered) {
          out.push(finding("vault", "warn", "spec-links",
            `Story lists spec "${id}" but that spec's \`stories:\` does not list it back.`, story.rel));
        }
      }
    }
    // Block-sequence YAML trap: parseFrontmatter is line-based; `specs:` with
    // an empty parsed value while the raw FRONTMATTER shows a block list means
    // the list is invisible to every deterministic check.
    const fmBlock = story.body.match(/^---\n[\s\S]*?\n---/);
    if (story.fm.specs === "" && fmBlock && /\nspecs:\s*\n\s+-\s/.test(fmBlock[0])) {
      out.push(finding("vault", "issue", "spec-links",
        "`specs:` uses block-sequence YAML which projectstore cannot parse — use inline flow: specs: [\"SPEC-001\"].", story.rel));
    }
  }
  return out;
}

// In-scope story = status beyond planned, not legacy-exempt.
function specScopeStatus(fm) {
  const s = String(fm.status || "").toLowerCase();
  return ["in-progress", "in_progress", "review", "done"].includes(s) ? s : null;
}

export function checkSpecCoverage(artifacts, vaultCfg, layout = null) {
  if ((vaultCfg.spec_policy || "optional") !== "required") return [];
  const out = [];
  const since = vaultCfg.spec_policy_since || null;
  const resolveSpec = buildSpecResolver(artifacts, layout);

  for (const story of artifacts.filter((a) => a.kind === "story")) {
    const status = specScopeStatus(story.fm);
    if (!status) continue;
    if (isLegacyStory(story.fm, since)) continue;
    const ids = listOf(story.fm, "specs");
    if (!ids.length) {
      out.push(finding("vault", "issue", "spec-coverage",
        `Story is ${status} with no covering spec (spec_policy: required — every story needs a spec; ADR-007).`, story.rel));
      continue;
    }
    for (const id of ids) {
      const spec = resolveSpec(id);
      if (!spec) continue; // dead link already reported by spec-links (same resolver)
      const st = specStatusOf(spec);
      if (status === "done") {
        if (!["active", "superseded"].includes(st)) {
          out.push(finding("vault", "issue", "spec-status",
            `Story is done while covering spec "${id}" is ${st} — a story may close only against an active spec.`, story.rel));
        }
      } else if (st === "draft") {
        out.push(finding("vault", "warn", "spec-status",
          `Story is ${status} while covering spec "${id}" is still draft — the spec must go active before implementation.`, story.rel));
      }
    }
  }
  return out;
}

// Additive acceptance oracle (ADR-007 Decision 3): a done story requires every
// spec acceptance item ATTRIBUTED to it (bare ids resolved against that spec's
// own stories list) — plus every UNATTRIBUTED item — checked, in every
// covering spec.
export function checkSpecAcceptance(layout, artifacts, vaultCfg) {
  if ((vaultCfg.spec_policy || "optional") !== "required") return [];
  const out = [];
  const since = vaultCfg.spec_policy_since || null;
  const epicFolder = folderByKind(layout, "epic");
  if (!epicFolder) return out;
  const resolveSpec = buildSpecResolver(artifacts, layout);
  const ambiguousReported = new Set(); // spec-scoped: one finding per spec+item

  for (const story of artifacts.filter((a) => a.kind === "story")) {
    if (String(story.fm.status || "").toLowerCase() !== "done") continue;
    if (isLegacyStory(story.fm, since)) continue;
    const epicId = epicIdOf(story.rel, epicFolder.path);
    const stem = storyStemOf(story.rel);

    for (const id of listOf(story.fm, "specs")) {
      const spec = resolveSpec(id);
      if (!spec) continue;
      const items = parseSpecAcceptance(spec);
      if (items === null) {
        out.push(finding("vault", "warn", "spec-acceptance",
          `Covering spec "${id}" has no Acceptance section — its criteria cannot gate this story.`, spec.rel));
        continue;
      }
      const coveredEntries = listOf(spec.fm, "stories");
      for (const item of items) {
        let applies;
        if (item.stories === null) {
          applies = true; // unattributed → applies to all covered stories
        } else {
          // Bare ids resolve against THIS spec's own stories list.
          applies = item.stories.some((bare) =>
            coveredEntries.some((e) => {
              const m = String(e).match(/^([^/]+)\/(.+)$/);
              return m && m[1] === epicId && bare === m[2] &&
                storyMatchesEntry(bare, { id: story.fm.id, stem }) > 0;
            }));
          const ambiguous = item.stories.some((bare) =>
            coveredEntries.filter((e) => {
              const m = String(e).match(/^([^/]+)\/(.+)$/);
              return m && bare === m[2];
            }).length > 1);
          const ambKey = `${spec.rel}|${item.text}`;
          if (ambiguous && !ambiguousReported.has(ambKey)) {
            ambiguousReported.add(ambKey);
            out.push(finding("vault", "warn", "ambiguous-attribution",
              `Spec "${id}" acceptance item attributes bare id(s) "${item.stories.join(", ")}" that match more than one covered epic — qualify as <epic-id>/<story-id>.`, spec.rel));
          }
        }
        if (applies && !item.checked) {
          out.push(finding("vault", "issue", "spec-acceptance",
            `Story is done but spec "${id}" acceptance item is unchecked: "${item.text.slice(0, 80)}".`, story.rel));
        }
      }
    }
  }
  return out;
}

// ─── Lifecycle gates (PS-SPEC story-008) — behind lifecycle_gates=on ───

export function checkLifecycleGates(artifacts, vaultCfg) {
  const gates = String(vaultCfg.lifecycle_gates || "off").toLowerCase();
  if (!["on", "true"].includes(gates)) return [];
  const out = [];
  const since = vaultCfg.spec_policy_since || null;
  const evidenceRe = evidenceSuffixRe();

  for (const story of artifacts.filter((a) => a.kind === "story")) {
    if (String(story.fm.status || "").toLowerCase() !== "done") continue;
    if (isLegacyStory(story.fm, since)) continue;

    const acc = sectionOf(story.body, "acceptance");
    if (acc !== null) {
      // Raw lines (fence-immune matching, verbatim reporting — backticks kept).
      for (const line of linesOutsideFences(acc)) {
        const m = line.match(/^\s*-\s*\[(x|X)\]\s*(.*)$/);
        if (m && !evidenceRe.test(m[2])) {
          out.push(finding("vault", "warn", "evidence",
            `Checked acceptance criterion carries no evidence suffix ("— evidence: <test | command | file:line>"): "${m[2].slice(0, 70)}".`, story.rel));
        }
      }
    }

    const plan = sectionOf(story.body, "implementation_plan");
    if (plan !== null && (!story.fm.plan_updated_at || story.fm.plan_updated_at === "null")) {
      out.push(finding("vault", "warn", "plan-gate",
        "Story has an Implementation Plan section but no plan_updated_at — the plan bypassed the /projectstore:story plan gate.", story.rel));
    }
    const summary = sectionOf(story.body, "final_summary");
    if (summary === null) {
      out.push(finding("vault", "warn", "final-summary",
        "Done story has no Final Summary section (lifecycle_gates: on requires a close-out record).", story.rel));
    }
    if (plan === null) {
      out.push(finding("vault", "warn", "plan-gate",
        "Done story has no Implementation Plan section (lifecycle_gates: on requires the plan to live in the story).", story.rel));
    }
  }
  return out;
}

// Suggestion for existing binds: specs exist but no vault policy declared.
export function checkVaultPolicy(cfg, layout, artifacts, vaultCfg) {
  const out = [];
  const hasSpecs = artifacts.some((a) => a.kind === "spec");
  if (hasSpecs && !vaultCfg.spec_policy) {
    out.push(finding("vault", "info", "spec-policy",
      "Vault contains specs but declares no spec_policy — consider enabling spec-first: add { \"spec_policy\": \"required\" } to <vault>/.projectstore.json (doctor gates activate; ADR-007)."));
  }
  if (vaultCfg.spec_policy === "required" && !vaultCfg.spec_policy_since) {
    out.push(finding("vault", "warn", "spec-policy",
      "spec_policy is required but spec_policy_since is missing — the legacy exemption cannot be evaluated; stamp it with the enable date (ISO-8601)."));
  }
  return out;
}

// One shared recursive walk of the vault's markdown files (dotfiles
// skipped). scanArtifacts only sees layout-declared folders — vault-wide
// claims (wikilink targets, identity uniqueness, filename shapes) must use
// this walk instead, or folder-shape story READMEs and loose notes go blind.
export function walkVaultFiles(vault) {
  const files = []; // { rel, name } — rel is /-joined relative to the vault root
  const walk = (dir, relDir) => {
    for (const n of readdirSync(dir)) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, relDir ? `${relDir}/${n}` : n);
      else if (n.endsWith(".md")) files.push({ rel: relDir ? `${relDir}/${n}` : n, name: n });
    }
  };
  walk(vault, "");
  return files;
}

// Body links resolved through the ONE shared resolver (spec:
// vault-link-graph-derived-view-and-shared-link-resolver): dead stays an
// issue, ambiguous (multiple node candidates — invisible to the old
// basename-set check) is a NEW warn, out-of-scope (the target exists but
// is not an artifact: kanban, code-map, READMEs, attachments) is silent at
// every level. A deliberate, documented behavior change in both
// directions: tiered matching also accepts links the exact-basename check
// rejected (number-stripped slug readings), and path-qualified links now
// resolve as paths — a wrong relative depth is dead here even though
// Obsidian's basename fallback happens to heal it. The graph generator
// consumes the same resolver, so a dead edge in graph.md and a dead-link
// finding here are the same fact reported twice.
export function checkWikilinks(cfg, artifacts, vaultFiles = null, nodeIndex = null) {
  const out = [];
  const files = vaultFiles ?? walkVaultFiles(cfg.vault_path);
  let index = nodeIndex;
  if (!index) {
    try { index = buildNodeIndex(cfg, loadLayout(cfg.layout)); } catch (e) {
      // A silent no-op check would read as "links are fine" — say why not.
      return [finding("vault", "warn", "wikilink", `Link check skipped — node index failed: ${e.message}`)];
    }
  }
  for (const a of artifacts) {
    const ctx = {
      sourceRel: a.rel,
      index,
      files,
      exists: (rel) => existsSync(join(cfg.vault_path, rel)),
    };
    for (const link of extractLinks(a.body)) {
      const r = resolveLinkTarget(link.target, link.type, ctx);
      if (r.outcome === "dead") {
        out.push(link.type === "wikilink"
          ? finding("vault", "issue", "wikilink", `Dead wiki-link [[${link.target}]].`, a.rel)
          : finding("vault", "issue", "rel-link", `Dead relative link (${link.target}).`, a.rel));
      } else if (r.outcome === "ambiguous") {
        out.push(finding("vault", "warn", "wikilink",
          `Ambiguous wiki-link [[${link.target}]] — matches ${r.candidates.join(", ")}; qualify with a path.`, a.rel));
      }
    }
  }
  return out;
}

// ─── Artifact identity & filename shapes (ADR-010 / SPEC-002 4, 7) ─────

// Infrastructure names carry no topic identity: README.md is every folder's
// index, epic.md every epic's root, kanban.md the board.
const INFRA_NAMES = new Set(["README.md", "epic.md", "kanban.md"]);

// Normalized slug-identity uniqueness per identity scope (a kind folder; an
// epic for stories), on candidate sets — so `ADR-003-foo.md` vs `foo.md`
// and `story-006-foo.md` vs `story-foo.md` collide with no rename ever
// having happened. Severity keys on each member's ERA, decided by
// frontmatter where the filename alone is ambiguous (a digit-leading
// story stem reads as either era; the exact machine id settles it):
//   - two as-written twins (flat story + folder-shape namesake) → issue;
//   - a new-era name overlapping a certain legacy one → issue (the exact
//     case the pre-write guard exists to prevent);
//   - any member of undecidable era (digit-leading, no fm evidence) → warn;
//   - all members certainly legacy (same slug, different numbers) → info —
//     in the numbered era the number WAS the identity, so this was legal
//     and grandfathering must not turn it into a defect (contract 6).
// Duplicate display numbers are info: numbers are reference metadata
// (ADR-010), duplicates confuse humans but identify nothing.
export function checkArtifactIdentity(layout, vaultFiles, artifacts = []) {
  const out = [];
  const fmByRel = new Map(artifacts.map((a) => [a.rel, a.fm]));
  // Era of one directory entry: "new" | "legacy" | "uncertain".
  const eraOf = (entry, opts) => {
    const idn = slugIdentity(entry.name, opts);
    if (!idn.legacyNumber) return "new";
    const fm = fmByRel.get(entry.rel);
    const fmId = fm && fm.id != null ? String(fm.id) : "";
    if (fmId) {
      const machineId = opts.story ? `story-${idn.primary}` : idn.primary;
      if (fmId.toLowerCase() === machineId) return "new"; // exact machine id = slug era
      if (isLegacyNumberedId(fmId, opts)) return "legacy";
    }
    const num = fm && fm.number != null ? String(fm.number).trim() : "";
    if (num && num !== "null") return "legacy";
    return idn.digitLeading ? "uncertain" : "legacy"; // prefix-anchored names are confident
  };
  const scopes = [];
  const epicFolder = folderByKind(layout, "epic");
  for (const f of layout.folders) {
    if (f.kind === "epic") continue;
    const entries = vaultFiles
      .filter((x) => dirname(x.rel) === f.path && !INFRA_NAMES.has(x.name))
      .map((x) => ({ name: x.name, rel: x.rel }));
    scopes.push({ label: f.path, entries, opts: { prefix: f.prefix || null } });
  }
  if (epicFolder) {
    const byEpic = new Map();
    for (const x of vaultFiles) {
      if (!x.rel.startsWith(epicFolder.path + "/")) continue;
      const parts = x.rel.split("/");
      let entry = null; // stories/<f>.md | stories/<dir>/README.md | standalone story-*.md
      if (parts.length === 4 && parts[2] === "stories") entry = { name: parts[3], rel: x.rel };
      else if (parts.length === 5 && parts[2] === "stories" && parts[4] === "README.md") entry = { name: parts[3], rel: x.rel };
      else if (parts.length === 3 && parts[2].startsWith("story-")) entry = { name: parts[2], rel: x.rel };
      if (!entry || INFRA_NAMES.has(entry.name)) continue;
      if (!byEpic.has(parts[1])) byEpic.set(parts[1], []);
      byEpic.get(parts[1]).push(entry);
    }
    for (const [epicId, entries] of byEpic) {
      scopes.push({ label: `${epicFolder.path}/${epicId}`, entries, opts: { story: true } });
    }
  }

  for (const { label, entries, opts } of scopes) {
    const groups = new Map(); // candidate identity -> hits
    const numbers = new Map(); // normalized display number -> entries
    for (const entry of entries) {
      const idn = slugIdentity(entry.name, opts);
      for (const c of idn.candidates) {
        if (!groups.has(c.id)) groups.set(c.id, []);
        groups.get(c.id).push({ entry, via: c.via, digitLeading: idn.digitLeading });
      }
      if (idn.legacyNumber) {
        const k = String(parseInt(idn.legacyNumber, 10));
        if (!numbers.has(k)) numbers.set(k, []);
        numbers.get(k).push(entry);
      }
    }
    const reported = new Set(); // one finding per file group, not per shared candidate
    for (const [ident, hits] of groups) {
      const uniq = [...new Map(hits.map((h) => [h.entry.rel, h])).values()];
      if (uniq.length < 2) continue;
      const key = uniq.map((h) => h.entry.rel).sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      const selfOnly = uniq.every((h) => h.via === "self");
      const classed = uniq.map((h) => ({ h, era: eraOf(h.entry, opts) }));
      const level = selfOnly ? "issue"
        // Overlap reached via the legacy reading of a PROVEN slug-era file
        // (its machine id is the full stem) is spurious — the file's real
        // identity is the unstripped slug.
        : classed.some(({ h, era }) => h.via !== "self" && era === "new") ? "warn"
        : classed.some(({ era }) => era === "uncertain") ? "warn"
        : classed.every(({ era }) => era === "legacy") ? "info"
        : "issue"; // a new-era name colliding with a certain legacy one
      const note = level === "warn" ? "; the overlap depends on a legacy reading that frontmatter does not confirm"
        : level === "info" ? "; all carry legacy numbers — legal in the numbered era, duplicate topic is hygiene"
        : "";
      out.push(finding("vault", level, "identity",
        `Same normalized identity "${ident}" in ${label}: ${uniq.map((h) => h.entry.name).join(", ")} — two artifacts claim one topic (ADR-010${note}).`,
        uniq[0].entry.rel));
    }
    for (const [num, ents] of numbers) {
      if (new Set(ents.map((e) => e.rel)).size < 2) continue;
      out.push(finding("vault", "info", "identity",
        `Display number ${num} is carried by ${ents.length} artifacts in ${label}: ${ents.map((e) => e.name).join(", ")} — numbers are reference metadata (ADR-010), duplicates confuse humans.`,
        ents[0].rel));
    }
  }
  return out;
}

// Block-form YAML trap for `external_refs` (SPEC-002 contract 3): the
// line-based parseFrontmatter reads a block map as an empty scalar, so every
// deterministic consumer goes blind — the same guard class protects `specs:`
// in checkSpecLinks. Applies to every artifact kind that carries the field.
export function checkExternalRefsForm(artifacts) {
  const out = [];
  for (const a of artifacts) {
    if (a.fm.external_refs !== "") continue;
    const fmBlock = a.body.match(/^---\n[\s\S]*?\n---/);
    if (fmBlock && /\nexternal_refs:\s*\n\s+\S/.test(fmBlock[0])) {
      out.push(finding("vault", "issue", "external-refs",
        "`external_refs:` uses block-form YAML which projectstore cannot parse — use inline flow: external_refs: {jira: \"ABC-123\"}.", a.rel));
    }
  }
  return out;
}

// Filename-shape checks over the WHOLE vault walk (SPEC-002 contract 7):
// sync-conflict shapes by blacklist at warn (a legal-form whitelist would
// flag hand-created legacy notes), cross-folder basename collisions at info
// (short wiki-links to that basename become ambiguous).
export function checkArtifactNames(vaultFiles) {
  const out = [];
  const byName = new Map();
  for (const x of vaultFiles) {
    const bad = legalArtifactName(x.name);
    if (bad) {
      out.push(finding("vault", "warn", "artifact-name",
        `Sync-conflict filename shape — ${bad}. Merge or remove; sync engines leave these beside the original.`, x.rel));
    }
    if (INFRA_NAMES.has(x.name)) continue;
    if (!byName.has(x.name)) byName.set(x.name, []);
    byName.get(x.name).push(x.rel);
  }
  for (const [name, rels] of byName) {
    if (rels.length < 2) continue;
    out.push(finding("vault", "info", "artifact-name",
      `Basename "${name}" appears in ${rels.length} folders (${rels.map((r) => dirname(r)).join(", ")}) — short wiki-links [[${name.replace(/\.md$/, "")}]] are ambiguous.`,
      rels[0]));
  }
  return out;
}

// code_refs: status-aware (ADR-004) — required to resolve only for
// in-progress / done artifacts; globs are skipped in v1 (documented).
// Story refs must fall under the parent epic's refs (subset) — that is how
// drift between the two levels is caught.
function refsOf(fm) {
  return listOf(fm, "code_refs");
}

// Untracked work, after the fact (spec contract 18). The reminder fires at the
// moment of the act and cannot see Bash-mediated writes at all; this is the
// backstop, and it is where the reported incident was actually caught — at
// "done". Warn, never issue: spikes and hotfixes legitimately produce this
// state, and an issue would poison the SessionStart line.
export function checkWorkWithoutStory(cfg, proj) {
  const out = [];
  if (!cfg || !cfg.vault_path) return out;

  // The same predicate the hook uses, fed by a plain read: doctor is not on a
  // hot path and needs no budget, but it must not answer a different question.
  const files = listVaultStoryFiles(cfg.vault_path);
  const fms = [];
  let unreadable = 0;
  for (const f of files) {
    try { fms.push(parseFrontmatter(readFileSync(f, "utf8")).data); } catch { unreadable++; }
  }
  if (unreadable > 0 && !openStoryFrom(fms)) {
    // A diagnostic that goes quiet because it could not read is a false clean.
    out.push(finding("vault", "warn", "work-without-story",
      `Could not read ${unreadable} story file(s), so "is any story in progress" is unproven — this check is inconclusive rather than clean.`));
    return out;
  }
  if (openStoryFrom(fms)) return out;

  // ENTRY_IGNORE, not the shared set: /projectstore:bind writes AGENTS.md,
  // CLAUDE.md and .gitignore in a session that by construction has no story, so
  // the shared set would make this fire on every project's first run.
  const dirty = uncommittedProjectFiles(proj, ENTRY_IGNORE);
  if (dirty === null) return out; // not a git repo, shallow, no commits, detached

  // The other half: work that WAS committed, with no story to attribute it to.
  // In a repo of small frequent commits that is the common shape, and a
  // dirty-tree-only check would never see it.
  const vaultMs = lastVaultActivityMs(cfg.vault_path);
  const commitMs = lastCommitMs(proj);
  const committedSince = vaultMs !== null && commitMs !== null && commitMs > vaultMs;

  if (dirty.length === 0 && !committedSince) return out;

  const fired = readEntryLog(proj, { withinDays: 30 }).length;
  const firedNote = fired > 0
    ? ` An entry reminder fired ${fired} time(s) in the last 30 days on this machine, so the prompt was delivered and the work still went untracked.`
    : " No entry reminder fired in the last 30 days on this machine (the log is machine-local — .claude/ is gitignored).";
  const what = [];
  if (dirty.length) what.push(`${dirty.length} uncommitted source file(s)`);
  if (committedSince) what.push("commits newer than the vault's last activity");
  out.push(finding("vault", "warn", "work-without-story",
    `${what.join(" and ")} in the project, and no story is in progress. If this is feature-sized work, open it in the vault: /projectstore:story <EPIC> "<title>".${firedNote}`));
  return out;
}

export function checkCodeRefs(artifacts, proj) {
  const out = [];
  const epicRefs = new Map();
  for (const e of artifacts.filter((a) => a.kind === "epic")) {
    epicRefs.set(e.rel.replace(/\/epic\.md$/, ""), refsOf(e.fm));
  }
  for (const a of artifacts) {
    const refs = refsOf(a.fm);
    if (!refs.length) continue;
    const status = (a.fm.status || "").toLowerCase();
    if (["in-progress", "in_progress", "done"].includes(status)) {
      for (const ref of refs) {
        if (ref.includes("*")) continue;
        if (!existsSync(join(proj, ref))) {
          out.push(finding("vault", "issue", "code-refs",
            `code_refs path "${ref}" does not resolve inside the project (status: ${status}).`, a.rel));
        }
      }
    }
    if (a.kind === "story") {
      const dir = a.rel.replace(/\/stories\/[^/]+$/, "");
      const parent = epicRefs.get(dir) || [];
      if (!parent.length) {
        out.push(finding("vault", "warn", "code-refs",
          "Story has code_refs but its epic has none — set the epic's footprint first.", a.rel));
      } else {
        const norm = (r) => r.replace(/\/+$/, "");
        for (const ref of refs) {
          if (!parent.some((p) => norm(ref).startsWith(norm(p)))) {
            out.push(finding("vault", "warn", "code-refs",
              `Story code_ref "${ref}" falls outside the parent epic's code_refs.`, a.rel));
          }
        }
      }
    }
  }
  return out;
}

// code-map.md staleness: regenerate with the real generator and compare
// (same pattern as the kanban check).
export function checkCodeMap(cfg) {
  const p = join(cfg.vault_path, "code-map.md");
  if (!existsSync(p)) return [];
  const r = spawnSync(process.execPath, [join(pluginRoot(), "scripts", "codemap.mjs")], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot() },
  });
  if (r.status !== 0) return [finding("vault", "warn", "code-map", "codemap generator failed.")];
  let expected;
  try { expected = JSON.parse(r.stdout).content; } catch {
    return [finding("vault", "warn", "code-map", "codemap generator returned unparseable output.")];
  }
  const norm = (s) => s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();
  if (norm(expected) !== norm(readFileSync(p, "utf8"))) {
    return [finding("vault", "issue", "code-map",
      "code-map.md is stale against frontmatter code_refs — run /projectstore:codemap (or reconcile).", "code-map.md")];
  }
  return [];
}

// graph.md staleness: regenerate with the real generator and compare —
// kanban's variant of the pattern, INCLUDING its missing-file info
// (checkCodeMap stays silent on a missing file; the graph deliberately
// picks the louder branch, because bare reconcile never re-mints a deleted
// graph.md — this info is the standing signal; spec contract 6).
export function checkGraph(cfg) {
  const p = join(cfg.vault_path, "graph.md");
  if (!existsSync(p)) {
    return [finding("vault", "info", "graph", "No graph.md yet — run /projectstore:graph to create the link graph.")];
  }
  const r = spawnSync(process.execPath, [join(pluginRoot(), "scripts", "graph.mjs")], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot() },
  });
  if (r.status !== 0) return [finding("vault", "warn", "graph", `graph generator failed: ${(r.stderr || "").trim()}`)];
  let expected;
  try { expected = JSON.parse(r.stdout).content; } catch {
    return [finding("vault", "warn", "graph", "graph generator returned unparseable output.")];
  }
  const norm = (s) => s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();
  if (norm(expected) !== norm(readFileSync(p, "utf8"))) {
    return [finding("vault", "issue", "graph",
      "graph.md is out of sync with vault links — run /projectstore:graph (or reconcile).", "graph.md")];
  }
  return [];
}

// ─── Runners ───────────────────────────────────────────────────────────

// Are the generated harness adapters in step with the source surfaces?
//
// tests/portability.test.mjs is the real gate, but it runs in a checkout by
// someone who chose to run it. A user who installed from a checkout and then
// pulled a commit that edited a command has an adapter tree that no longer
// matches — and nothing in a session would say so. Codex would go on serving
// the previous prompt, which is the failure mode with no symptom at all.
//
// Silent when there is nothing to compare: a marketplace install ships no
// harnesses/ directory, and reporting "cannot check" every session is how a
// report earns being ignored.
export function checkAdapters() {
  let harnesses;
  try {
    harnesses = emittingHarnesses();
  } catch {
    return [];
  }
  if (!harnesses.length) return [];

  let d;
  try {
    // Inside the guard: a manifest declaring emit without output_dir makes
    // join() throw a TypeError, and runInstallChecks has no guard of its own —
    // so a malformed manifest would crash the whole doctor run rather than
    // producing a finding.
    if (!existsSync(join(REPO_ROOT, harnesses[0].output_dir))) return [];
    d = diffAgainstDisk(REPO_ROOT);
  } catch (e) {
    return [finding("install", "warn", "adapters",
      `Could not verify the generated harness adapters: ${e.message}`)];
  }
  if (d.ok) return [];

  const n = d.missing.length + d.changed.length + d.stale.length;
  const sample = [...d.missing, ...d.changed, ...d.stale].slice(0, 3).join(", ");
  const active = activeHarness();
  const mine = active && !active.source_layout
    ? " This is the harness you are running on, so the surfaces in this session may be the stale ones."
    : "";
  return [finding("install", "warn", "adapters",
    `${n} generated harness adapter file(s) are out of date (${sample}${n > 3 ? ", …" : ""}). ` +
    `Other harnesses are being served surfaces that no longer match the source.${mine} ` +
    `Repair: node scripts/build-adapters.mjs`)];
}

// A hook that throws on every turn is invisible: the wrapper exits zero so the
// session never breaks, and nothing else executes a hook to find out. The
// wrapper leaves a breadcrumb precisely so this check can exist — without it,
// the "loud finding in doctor" that justified swallowing the error was a
// promise nothing kept.
export function checkHookErrors() {
  const log = join(REPO_ROOT, ".projectstore", "hook-errors.log");
  let text;
  try {
    if (!existsSync(log)) return [];
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  if (!lines.length) return [];
  const last = lines[lines.length - 1].split("\t");
  return [finding("install", "warn", "hook-errors",
    `${lines.length} hook launch failure(s) recorded in .projectstore/hook-errors.log — ` +
    `hooks are exiting silently instead of running. Most recent: ${last[1] || "?"} — ` +
    `${(last[2] || "").slice(0, 160)}. Delete the log after fixing to clear this.`)];
}

export function runInstallChecks(cfg, proj) {
  // Before the bound-project gate: adapter staleness is a property of the
  // checkout, not of any vault, and it is exactly as wrong in an unbound
  // project. Behind the gate it would only ever be reported to people who
  // already have everything else working.
  const out = [...checkConfig(cfg), ...checkAdapters(), ...checkHookErrors()];
  if (!cfg || !cfg.vault_path) return out;
  out.push(...checkVaultPath(cfg));
  if (out.some((f) => f.check === "vault-path" && f.level === "issue")) return out;
  out.push(
    ...checkLayoutTemplates(cfg),
    ...checkHooksAlive(cfg),
    ...checkStatusline(cfg, proj),
    ...checkAgentsBlock(proj),
    ...checkOverrideCopies(proj),
    ...checkEnvModel(),
    ...checkEnvEffort(),
    ...checkGitignore(proj),
    ...checkVaultGit(cfg),
    ...checkAutoUpdate(),
  );
  return out;
}

export function runVaultChecks(cfg) {
  let layout;
  try { layout = loadLayout(cfg.layout); } catch (e) {
    return [finding("vault", "issue", "layout", `Layout not loadable: ${e.message}`)];
  }
  const artifacts = scanArtifacts(cfg, layout);
  // Vault-side policy read ONCE (ADR-007 Decision 4): spec gates and lifecycle
  // gates key off <vault>/.projectstore.json, never the machine-local config.
  const vaultCfg = readVaultConfig(cfg.vault_path);
  const findings = [...checkKanbanSync(cfg), ...checkIndexes(cfg, layout, artifacts)];
  // Registry-dependent checks: a missing/corrupt scaffold/headings.json must
  // become a finding, never a crash that swallows the whole report.
  const guarded = [
    () => checkIndexHeaders(cfg, layout),
    () => checkStoriesAndEpics(artifacts),
    () => checkSpecLinks(cfg, layout, artifacts),
    () => checkSpecCoverage(artifacts, vaultCfg, layout),
    () => checkSpecAcceptance(layout, artifacts, vaultCfg),
    () => checkLifecycleGates(artifacts, vaultCfg),
  ];
  for (const step of guarded) {
    try { findings.push(...step()); } catch (e) {
      findings.push(finding("vault", "issue", "registry", e.message));
      break;
    }
  }
  const vaultFiles = walkVaultFiles(cfg.vault_path); // one walk, three consumers
  findings.push(
    ...checkVaultPolicy(cfg, layout, artifacts, vaultCfg),
    ...checkWikilinks(cfg, artifacts, vaultFiles, buildNodeIndex(cfg, layout)),
    ...checkArtifactIdentity(layout, vaultFiles, artifacts),
    ...checkArtifactNames(vaultFiles),
    ...checkExternalRefsForm(artifacts),
    ...checkCodeRefs(artifacts, projectRoot()),
    ...checkWorkWithoutStory(cfg, projectRoot()),
    ...checkCodeMap(cfg),
    ...checkGraph(cfg),
  );
  return findings;
}

// SessionStart subset: install/fs checks only (never the vault group — ADR-005
// Decision 4). Aborts past the budget rather than reporting a false "clean".
export function runStartupChecks(cfg, proj, budgetMs = 150) {
  const started = Date.now();
  const steps = [
    () => checkConfig(cfg),
    () => (cfg && cfg.vault_path ? checkVaultPath(cfg) : []),
    () => (cfg && cfg.vault_path ? checkStatusline(cfg, proj) : []),
    () => checkAgentsBlock(proj),
    () => checkGitignore(proj),
    () => checkEnvModel(),
    () => checkEnvEffort(),
  ];
  const findings = [];
  for (const step of steps) {
    if (Date.now() - started > budgetMs) return { skipped: true, count: 0, findings };
    try { findings.push(...step()); } catch {}
  }
  return { skipped: false, count: findings.filter((f) => f.level === "issue").length, findings };
}

// ─── CLI ───────────────────────────────────────────────────────────────

function icon(level) {
  return level === "issue" ? "✖" : level === "warn" ? "⚠" : "ℹ";
}

function report(findings, groups) {
  const ver = pluginVersion();
  const lines = [`projectstore doctor — plugin v${ver || "?"}, ${new Date().toISOString().slice(0, 10)}`];
  for (const g of groups) {
    const fs = findings.filter((f) => f.group === g);
    lines.push("", `## ${g} (${fs.filter((f) => f.level === "issue").length} issue(s), ${fs.filter((f) => f.level === "warn").length} warning(s))`);
    if (!fs.length) lines.push("  ✓ clean");
    for (const f of fs) {
      lines.push(`  ${icon(f.level)} [${f.check}] ${f.message}${f.file ? `  — ${f.file}` : ""}`);
    }
  }
  const issues = findings.filter((f) => f.level === "issue").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  lines.push("", `Summary: ${issues} issue(s), ${warns} warning(s). ${issues ? "Repairs: /projectstore:doctor --fix (install), /projectstore:kanban / reconcile (vault)." : "Vault and wiring look healthy."}`);
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const startup = args.includes("--startup");
  let install = args.includes("--install");
  let vault = args.includes("--vault");
  if (!install && !vault && !startup) { install = true; vault = true; }

  const cfg = readConfig();
  const proj = projectRoot();

  if (startup) {
    const r = runStartupChecks(cfg, proj);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }

  const findings = [];
  const groups = [];
  if (install) { groups.push("install"); findings.push(...runInstallChecks(cfg, proj)); }
  if (vault && cfg && cfg.vault_path && existsSync(cfg.vault_path)) {
    groups.push("vault");
    findings.push(...runVaultChecks(cfg));
  } else if (vault) {
    groups.push("vault");
    findings.push(finding("vault", "info", "vault", "Vault checks skipped — no usable vault (see install issues)."));
  }

  process.stdout.write((wantJson ? JSON.stringify(findings, null, 2) : report(findings, groups)) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

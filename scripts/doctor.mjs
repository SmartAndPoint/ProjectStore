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
import {
  readConfig,
  loadLayout,
  folderByKind,
  parseFrontmatter,
  pluginRoot,
  projectRoot,
  listOf,
  readVaultConfig,
  isLegacyStory,
  sectionOf,
  headingLineRe,
  indexHeaderRe,
  keywordRe,
} from "./lib.mjs";

const AGENT_BLOCK_MARKER = /<!--\s*projectstore:agents v(\d+)/g;
const AGENT_BLOCK_VERSION = 1;
const BUNDLED_AGENT_NAMES = [
  // current + post-ADR-001/004 names, so provenance checks survive the rename
  "critic", "planner", "reviewer", "librarian", "archaeologist",
  "projectstore-critic", "code-planner", "code-reviewer",
];

function finding(group, level, check, message, file) {
  const f = { group, level, check, message };
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
      "No projectstore config (.claude/projectstore.json). Run /projectstore:bind <vault-path>.")];
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

// Read-only probe of the statusline wiring (never calls syncStatusLine, which
// is a mutating self-heal that SessionStart already ran — ADR-005).
export function checkStatusline(cfg, proj) {
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
  const isOurs = curCmd ? curCmd.includes("scripts/statusline.mjs") : false;
  const st = cfg.statusline;

  if (st && st.enabled === true) {
    if (!curCmd) {
      out.push(finding("install", "issue", "statusline",
        "statusline.enabled=true but no statusLine wired in settings.local.json — restart the session (the hook wires it) or check hook health."));
    } else if (!isOurs) {
      out.push(finding("install", "issue", "statusline",
        "statusline.enabled=true but a foreign statusLine occupies settings.local.json — the hook will not clobber it. Clear it or disable the flag."));
    } else {
      const m = curCmd.match(/"([^"]+scripts\/statusline\.mjs)"/) || curCmd.match(/(\S+scripts\/statusline\.mjs)/);
      if (m && !existsSync(m[1])) {
        out.push(finding("install", "issue", "statusline",
          `statusLine points at a missing script (stale plugin path?): ${m[1]}`));
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
    const base = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))?.statusLine?.command;
    if (base && !base.includes("scripts/statusline.mjs")) {
      out.push(finding("install", "info", "statusline", "Base HUD present in ~/.claude/settings.json — projectstore composes above it."));
    }
  } catch {}
  // session_id divergence (ADR-006): the renderer's breadcrumb names the id
  // the statusLine process received; hook-side pointer files name the ids the
  // hooks observed. A breadcrumb id with no pointer file while others exist
  // means the two processes disagree — the issue note's second suspect.
  try {
    const sdir = join(proj, ".claude", ".projectstore", "state");
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

export function checkOverrideCopies(proj) {
  const out = [];
  const dir = join(proj, ".claude", "agents");
  const ver = pluginVersion();
  for (const f of listMd(dir)) {
    let text;
    try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    const m = text.match(/#\s*source:\s*projectstore\s+v(\S+)/);
    if (!m) continue; // user-authored agent — never ours to judge
    if (ver && m[1] !== ver) {
      out.push(finding("install", "warn", "override-copies",
        `Override copy ${f} frozen at projectstore v${m[1]} (installed v${ver}) — re-run /projectstore:agents configure to refresh the prompt.`, join(".claude/agents", f)));
    }
    const { data } = parseFrontmatter(text);
    if (data.name && !BUNDLED_AGENT_NAMES.includes(data.name)) {
      out.push(finding("install", "warn", "override-copies",
        `Override copy ${f} has name "${data.name}" which matches no bundled agent — it duplicates instead of overriding.`, join(".claude/agents", f)));
    }
  }
  return out;
}

export function checkEnvModel() {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return [finding("install", "warn", "env-model",
      `CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL} is set — it overrides ALL projectstore agent model configuration.`)];
  }
  return [];
}

export function checkGitignore(proj) {
  if (!existsSync(join(proj, ".git"))) return [];
  let lines = [];
  try {
    lines = readFileSync(join(proj, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  } catch {}
  const coveredAll = lines.includes(".claude/") || lines.includes(".claude");
  if (coveredAll) return [];
  const wanted = [".claude/projectstore.json", ".claude/settings.local.json", ".claude/.projectstore/"];
  const missing = wanted.filter((w) => !lines.includes(w));
  if (!missing.length) return [];
  return [finding("install", "warn", "gitignore",
    `Machine-specific files not gitignored: ${missing.join(", ")} (or ignore ".claude/" wholesale).`)];
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
export function checkAutoUpdate() {
  const out = [];
  const root = pluginRoot();
  const m = root.match(/\/plugins\/(?:cache|marketplaces)\/([^/]+)\//);
  if (!m) {
    out.push(finding("install", "info", "auto-update",
      "Local dev install (--plugin-dir) — marketplace auto-update not applicable."));
    return out;
  }
  const marketplace = m[1];

  let registry = null;
  try {
    registry = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "known_marketplaces.json"), "utf8"));
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
      const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
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
  try {
    const name = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name;
    const catalog = JSON.parse(readFileSync(join(entry.installLocation, ".claude-plugin", "marketplace.json"), "utf8"));
    const latest = (catalog.plugins || []).find((p) => p.name === name)?.version;
    const running = pluginVersion();
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

// Strip fenced blocks and inline code before counting checkboxes / matching
// links — a fenced example containing `- [ ]` must not inflate the count.
function stripCode(s) {
  return s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

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
      const unchecked = (stripCode(sec).match(/- \[ \]/g) || []).length;
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

// Resolve a spec's `stories:` entry "<epic-id>/<story-id>" to a story artifact.
function resolveSpecStory(entry, artifacts, epicFolderPath) {
  const m = String(entry).match(/^([^/]+)\/(.+)$/);
  if (!m) return { error: `not in <epic-id>/<story-id> form: "${entry}"` };
  const [, epicId, storyId] = m;
  const prefix = `${epicFolderPath}/${epicId}/stories/${storyId}`;
  const story = artifacts.find((a) =>
    a.kind === "story" && (a.rel.startsWith(prefix + "-") || a.rel === `${prefix}.md`));
  return story ? { story } : { error: `no story matches ${prefix}-*` };
}

// Parse a spec's Acceptance section into items:
// { checked, text, stories: [bare story ids] | null (unattributed) }
export function parseSpecAcceptance(spec) {
  const sec = sectionOf(spec.body, "spec_acceptance");
  if (sec === null) return null;
  const storiesKw = keywordRe("stories");
  const items = [];
  for (const line of linesOutsideFences(sec)) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const text = m[2];
    const attr = text.match(new RegExp(`[—–-]\\s*${storiesKw.source}\\s*:\\s*(.+)$`, "i"));
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
  const specById = new Map(specs.map((s) => [String(s.fm.id || ""), s]));

  for (const spec of specs) {
    for (const entry of listOf(spec.fm, "stories")) {
      const r = resolveSpecStory(entry, artifacts, epicFolder.path);
      if (r.error) {
        out.push(finding("vault", "issue", "spec-links",
          `Spec "${spec.fm.id}" stories entry "${entry}" does not resolve: ${r.error}.`, spec.rel));
      } else if (spec.fm.id && !listOf(r.story.fm, "specs").includes(String(spec.fm.id))) {
        out.push(finding("vault", "warn", "spec-links",
          `Spec "${spec.fm.id}" covers ${entry} but the story's \`specs:\` list lacks "${spec.fm.id}" (bidirectional link).`, r.story.rel));
      }
    }
  }
  for (const story of artifacts.filter((a) => a.kind === "story")) {
    for (const id of listOf(story.fm, "specs")) {
      const spec = specById.get(id);
      if (!spec) {
        out.push(finding("vault", "issue", "spec-links",
          `Story lists spec "${id}" which does not exist in specs/.`, story.rel));
      } else {
        const epicId = epicIdOf(story.rel, epicFolder.path);
        const sid = basename(story.rel).replace(/\.md$/, "");
        const covered = listOf(spec.fm, "stories").some((e) => {
          const m = String(e).match(/^([^/]+)\/(.+)$/);
          return m && m[1] === epicId && (sid === m[2] || sid.startsWith(m[2] + "-"));
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

export function checkSpecCoverage(artifacts, vaultCfg) {
  if ((vaultCfg.spec_policy || "optional") !== "required") return [];
  const out = [];
  const since = vaultCfg.spec_policy_since || null;
  const specs = new Map(artifacts.filter((a) => a.kind === "spec").map((s) => [String(s.fm.id || ""), s]));

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
      const spec = specs.get(id);
      if (!spec) continue; // dead link already reported by spec-links
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
  const specs = new Map(artifacts.filter((a) => a.kind === "spec").map((s) => [String(s.fm.id || ""), s]));
  const ambiguousReported = new Set(); // spec-scoped: one finding per spec+item

  for (const story of artifacts.filter((a) => a.kind === "story")) {
    if (String(story.fm.status || "").toLowerCase() !== "done") continue;
    if (isLegacyStory(story.fm, since)) continue;
    const epicId = epicIdOf(story.rel, epicFolder.path);
    const sid = basename(story.rel).replace(/\.md$/, "");

    for (const id of listOf(story.fm, "specs")) {
      const spec = specs.get(id);
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
              return m && m[1] === epicId && bare === m[2] && (sid === bare || sid.startsWith(bare + "-"));
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
  const evidenceKw = keywordRe("evidence");
  const evidenceRe = new RegExp(`[—–-]\\s*${evidenceKw.source}\\s*:`, "i");

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

export function checkWikilinks(cfg, artifacts) {
  const out = [];
  const vault = cfg.vault_path;
  const names = new Set();
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (n.endsWith(".md")) names.add(n.replace(/\.md$/, "").toLowerCase());
    }
  };
  walk(vault);
  for (const a of artifacts) {
    // Notation like `[[...]]` inside code spans/fences is not a link.
    const prose = a.body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of prose.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].split("|")[0].split("#")[0].trim();
      if (!target) continue;
      const base = basename(target).toLowerCase();
      if (!names.has(base)) {
        out.push(finding("vault", "issue", "wikilink", `Dead wiki-link [[${target}]].`, a.rel));
      }
    }
    // Relative markdown links: [text](./x) / (../x) must resolve on disk.
    for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (!t.startsWith("./") && !t.startsWith("../")) continue;
      const target = t.split("#")[0];
      if (target && !existsSync(resolve(dirname(a.abs), target))) {
        out.push(finding("vault", "issue", "rel-link", `Dead relative link (${t}).`, a.rel));
      }
    }
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

// ─── Runners ───────────────────────────────────────────────────────────

export function runInstallChecks(cfg, proj) {
  const out = [...checkConfig(cfg)];
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
    () => checkSpecCoverage(artifacts, vaultCfg),
    () => checkSpecAcceptance(layout, artifacts, vaultCfg),
    () => checkLifecycleGates(artifacts, vaultCfg),
  ];
  for (const step of guarded) {
    try { findings.push(...step()); } catch (e) {
      findings.push(finding("vault", "issue", "registry", e.message));
      break;
    }
  }
  findings.push(
    ...checkVaultPolicy(cfg, layout, artifacts, vaultCfg),
    ...checkWikilinks(cfg, artifacts),
    ...checkCodeRefs(artifacts, projectRoot()),
    ...checkCodeMap(cfg),
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

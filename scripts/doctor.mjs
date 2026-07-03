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
  const kinds = (layout.commands || []).filter((k) =>
    ["adr", "epic", "story", "research", "concept", "meeting", "runbook", "kanban"].includes(k));
  kinds.push("folder-readme");
  for (const k of kinds) {
    const p = join(pluginRoot(), "templates", lang, `${k}.md.tmpl`);
    if (!existsSync(p)) {
      out.push(finding("install", "issue", "templates", `Missing template for language "${lang}": ${k}.md.tmpl`));
    }
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

export function checkStoriesAndEpics(artifacts) {
  const out = [];
  for (const a of artifacts) {
    if (a.kind === "story" && (a.fm.status || "").toLowerCase() === "done") {
      const sec = a.body.split(/\n## Acceptance Criteria/)[1]?.split(/\n## /)[0] || "";
      const unchecked = (sec.match(/- \[ \]/g) || []).length;
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
  const raw = fm.code_refs;
  if (!raw || raw === "[]") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
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
  return [
    ...checkKanbanSync(cfg),
    ...checkIndexes(cfg, layout, artifacts),
    ...checkStoriesAndEpics(artifacts),
    ...checkWikilinks(cfg, artifacts),
    ...checkCodeRefs(artifacts, projectRoot()),
    ...checkCodeMap(cfg),
  ];
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

#!/usr/bin/env node
// projectstore — statusline.mjs
//
// Renders the Claude Code status line for a projectstore-bound project.
// Wired manually (or via /projectstore:statusline) into a project's
// .claude/settings.local.json — statusLine is NOT a plugin-declarable
// capability, so it lives in settings.json with an absolute command path.
//
// COMPOSING, not clobbering: the statusLine slot is single. Rather than
// replace an existing status line (e.g. oh-my-claudecode's HUD), this script
// DELEGATES to the base statusLine command already configured in
// ~/.claude/settings.json (or the project's .claude/settings.json), prints
// its output verbatim, and adds ONE projectstore line — "📚 epic › story
// (status)" — above it (position configurable via projectstore.json:
// statusline.position = "above" | "below", default "above"). When no base
// command exists (e.g. a user without a custom HUD), it renders a standalone
// base line instead: <model> · <dir> · ⎇ <branch> · 📚 epic › story.
//
// Consumes hook-style JSON on stdin (fields used):
//   session_id            — Claude's session id (matches the session file)
//   workspace.project_dir — the project root (statusLine gets NO
//                           CLAUDE_PROJECT_DIR, so we must feed it ourselves)
//   cwd                   — fallback project dir
//   model.display_name    — e.g. "Opus" (standalone mode only)
//
// Everything is best-effort. On any missing piece we drop that segment; on
// any error we emit whatever we have and exit 0. A status line script must
// never crash or block the UI. The base command is re-run with the same
// stdin; if it fails or is absent we fall back to the standalone line.

import { readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readConfig, readSessionActivity, parseFrontmatter } from "./lib.mjs";

const SELF = fileURLToPath(import.meta.url);
const SEP = " · ";
const BRANCH = "⎇ ";
const BOOK = "📚 ";
const ARROW = " › ";

// Claude Code cancels an in-flight statusLine by closing our stdout pipe when
// a newer update arrives. A write to a closed pipe emits an async 'error'
// event that the outer try/catch (sync-only) cannot catch → Node would exit 1
// with a stack trace. Guard the pipe so we honour the never-crash contract.
process.stdout.on("error", () => process.exit(0));

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readRawStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Current git branch by reading .git/HEAD directly — no process spawn.
// Handles worktree/submodule .git-file pointers and detached HEAD.
function gitBranch(projectDir) {
  try {
    const dotgit = join(projectDir, ".git");
    let gitDir;
    if (statSync(dotgit).isDirectory()) {
      gitDir = dotgit;
    } else {
      const m = readFileSync(dotgit, "utf8").trim().match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      gitDir = resolve(projectDir, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7); // detached
    return null;
  } catch {
    return null;
  }
}

function relToVault(abs, vault) {
  if (typeof abs !== "string") return null;
  if (abs.startsWith(vault + "/")) return abs.slice(vault.length + 1);
  return null;
}

// The "📚 epic › story (status)" segment from this session's recent activity.
// Newest-first: first entry under epics/<id>/ is the current epic; the most
// recent story file under that epic is the current story. At most one file
// read (the story, for its status). Returns null on any miss.
function bookSegment(cfg, input) {
  if (!cfg || !cfg.vault_path) return null;
  const sid = input.session_id;
  if (!sid) return null;

  const vault = cfg.vault_path;
  const activity = readSessionActivity(vault, sid);
  if (!activity.length) return null;

  let epicId = null;
  for (const e of activity) {
    const rel = relToVault(e && e.path, vault);
    if (rel) {
      const m = rel.match(/^epics\/([^/]+)\//);
      if (m) {
        epicId = m[1];
        break;
      }
    }
  }
  if (!epicId) return null;

  let storyFile = null;
  let storyPath = null;
  const storyRe = new RegExp(`^epics/${escRe(epicId)}/stories/([^/]+\\.md)$`);
  for (const e of activity) {
    const rel = relToVault(e && e.path, vault);
    if (rel) {
      const m = rel.match(storyRe);
      if (m) {
        storyFile = m[1];
        storyPath = e.path;
        break;
      }
    }
  }

  // Prefer the human `title:` from each artifact's frontmatter over the raw
  // id / filename slug (fall back to those when a title is missing/unreadable).
  let epicTitle = null;
  try {
    const { data } = parseFrontmatter(
      readFileSync(join(vault, "epics", epicId, "epic.md"), "utf8"),
    );
    if (data.title) epicTitle = String(data.title);
  } catch {}
  let seg = BOOK + (epicTitle || epicId);

  if (storyFile) {
    let status = null;
    let storyTitle = null;
    try {
      const { data } = parseFrontmatter(readFileSync(storyPath, "utf8"));
      if (data.status) status = String(data.status).toLowerCase();
      if (data.title) storyTitle = String(data.title);
    } catch {}
    const storyLabel = storyTitle || storyFile.replace(/\.md$/, "");
    seg += ARROW + storyLabel + (status ? ` (${status})` : "");
  }
  return seg;
}

function safeBook(cfg, input) {
  try {
    return bookSegment(cfg, input);
  } catch {
    return null;
  }
}

// The base statusLine command we compose with — the highest-precedence one
// BELOW our own local entry: project .claude/settings.json, else user
// ~/.claude/settings.json. Skips a command that points back at us (recursion).
function discoverBaseCommand(projectDir) {
  const candidates = [
    join(projectDir, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const p of candidates) {
    try {
      const cmd = JSON.parse(readFileSync(p, "utf8"))?.statusLine?.command;
      if (
        typeof cmd === "string" &&
        cmd.trim() &&
        !cmd.includes(SELF) &&
        !cmd.includes("scripts/statusline.mjs")
      ) {
        return cmd;
      }
    } catch {}
  }
  return null;
}

function runBase(cmd, rawStdin, env) {
  try {
    const r = spawnSync(cmd, {
      shell: true,
      input: rawStdin,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1 << 20,
      env,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout || "").replace(/\s+$/, "");
    return out || null;
  } catch {
    return null;
  }
}

function standaloneLine(input, projectDir, book) {
  const parts = [];
  const model = input.model && input.model.display_name;
  if (model) parts.push(model);
  if (projectDir) parts.push(basename(projectDir));
  const branch = gitBranch(projectDir);
  if (branch) parts.push(BRANCH + branch);
  if (book) parts.push(book);
  return parts.join(SEP);
}

function main() {
  const raw = readRawStdin();
  let input = {};
  try {
    input = JSON.parse(raw) || {};
  } catch {
    input = {};
  }

  // statusLine is spawned with no CLAUDE_PROJECT_DIR and an unspecified cwd,
  // so feed the project dir from stdin BEFORE readConfig() (which resolves
  // via CLAUDE_PROJECT_DIR || cwd). Mutates only this short-lived process.
  const projectDir =
    (input.workspace && input.workspace.project_dir) || input.cwd || process.cwd();
  // Snapshot CLAUDE_PROJECT_DIR before we inject it, so the composed base
  // command can be given the env it would have as the top-level statusLine
  // (which is NOT handed this var).
  const hadCPD = "CLAUDE_PROJECT_DIR" in process.env;
  const prevCPD = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) process.env.CLAUDE_PROJECT_DIR = projectDir;

  let cfg = null;
  try {
    cfg = readConfig();
  } catch {
    cfg = null;
  }

  const book = safeBook(cfg, input);
  const baseCmd = discoverBaseCommand(projectDir);
  // The base HUD is re-executed on EVERY render (300ms debounce); a heavy base
  // may want its own caching / refreshInterval. Hand it the same env a real
  // top-level statusLine would have (no injected CLAUDE_PROJECT_DIR).
  const baseEnv = { ...process.env };
  if (hadCPD) baseEnv.CLAUDE_PROJECT_DIR = prevCPD;
  else delete baseEnv.CLAUDE_PROJECT_DIR;
  const baseOut = baseCmd ? runBase(baseCmd, raw, baseEnv) : null;

  const lines = [];
  if (baseOut) {
    // Compose: keep the base HUD intact, add only our 📚 line.
    const position =
      (cfg && cfg.statusline && cfg.statusline.position) || "above";
    if (book && position === "above") lines.push(book);
    lines.push(baseOut);
    if (book && position !== "above") lines.push(book);
  } else {
    // No base HUD — render our own standalone line.
    lines.push(standaloneLine(input, projectDir, book));
  }

  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch {
  // A status line must never crash. Emit nothing rather than an error.
  process.stdout.write("\n");
}

#!/usr/bin/env node
// projectstore — statusline.mjs (v2, ADR-006)
//
// Renders the Claude Code status line for a projectstore-bound project.
// statusLine is NOT a plugin-declarable capability, so it lives in settings
// with an absolute path: the SessionStart hook points .claude/settings.local.json
// at the generated .claude/.projectstore/statusline.mjs launcher (when
// projectstore.json → statusline.enabled=true), and the launcher imports THIS
// file from whichever plugin version is installed at render time.
//
// COMPOSING, not clobbering: the statusLine slot is single. This script
// DELEGATES to the base statusLine command from the project's
// .claude/settings.json, else the user's settings.json, prints it verbatim, and adds
// ONE projectstore line above it (position configurable). With no base
// command it renders a standalone line: [PS#v] <model> · <dir> · ⎇ <branch> · 📚 …
//
// The 📚 segment is resolved PER SESSION with zero cross-session and zero
// vault reads (ADR-006):
//   1. this session's pointer file
//      (<project>/.claude/.projectstore/state/<session_id>.json — written by
//      the PreToolUse hook with denormalized titles), else
//   2. an explicit localized cold-start line ("no epic or story in this
//      session yet"). Never blank while enabled; a pointer that exists but
//      fails to parse renders an error-marked string, never the cheerful
//      cold-start line. The renderer drops a .last-render.json breadcrumb so
//      doctor can detect session_id divergence between hook and statusLine.
//
// Everything is best-effort; on any error emit what we have and exit 0.

import { readFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readConfigAt,
  pluginRoot,
  sessionStatePath,
  stateDir,
  ensureStateDir,
  statusLineIsOurs,
  claudeHome,
  writeFileAtomic,
} from "./lib.mjs";

const SELF = fileURLToPath(import.meta.url);
const SEP = " · ";
const BRANCH = "⎇ ";
const BOOK = "📚 ";
const ARROW = " › ";

// Claude Code cancels an in-flight statusLine by closing our stdout pipe when
// a newer update arrives; guard the pipe so we honour the never-crash contract.
process.stdout.on("error", () => process.exit(0));

function readRawStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

const FALLBACK_STRINGS = {
  statusline_no_work: "No epic or story in this session yet",
  statusline_state_error: "⚠ session state unreadable",
};

function loadStrings(lang) {
  const read = (l) => {
    try {
      return JSON.parse(readFileSync(join(pluginRoot(), "templates", l, "strings.json"), "utf8"));
    } catch {
      return null;
    }
  };
  return {
    ...FALLBACK_STRINGS,
    ...(read("en") || {}),
    ...(lang && lang !== "en" ? read(lang) || {} : {}),
  };
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// Current git branch by reading .git/HEAD directly — no process spawn.
function gitBranch(projectDir) {
  try {
    const dotgit = join(projectDir, ".git");
    let gitDir;
    const st = readFileSync(dotgit, "utf8");
    const m = st.trim().match(/^gitdir:\s*(.+)$/);
    gitDir = m ? resolve(projectDir, m[1].trim()) : dotgit;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    try {
      const head = readFileSync(join(projectDir, ".git", "HEAD"), "utf8").trim();
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return ref ? ref[1] : null;
    } catch {
      return null;
    }
  }
}

// The 📚 segment — strictly this-session (ADR-006). Returns a non-empty string
// whenever the feature is enabled; distinguishes "no work yet" from "state
// unreadable" so failures are visible, never masked.
function bookSegment(cfg, proj, input, strings) {
  const sid = input.session_id;
  // Breadcrumb for doctor's divergence check — best-effort, never fatal.
  try {
    ensureStateDir(proj);
    // sweep=false: this is the hottest path in the plugin (every HUD frame),
    // and the state dir holds one file per session — no readdir here.
    writeFileAtomic(
      join(stateDir(proj), ".last-render.json"),
      JSON.stringify({
        session_id: sid || null,
        at: new Date().toISOString(),
        // Which plugin actually rendered this line — doctor compares it with
        // the installed version to explain a stale badge instead of leaving
        // the user to wonder why an update did not show up.
        version: pluginVersion(),
        root: pluginRoot(),
      }) + "\n",
      { sweep: false },
    );
  } catch {}

  if (!sid) return BOOK + strings.statusline_no_work;
  const p = sessionStatePath(proj, sid);
  if (!existsSync(p)) return BOOK + strings.statusline_no_work;

  let state;
  try {
    state = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return BOOK + strings.statusline_state_error;
  }
  if (!state || !state.active_epic) return BOOK + strings.statusline_no_work;

  let seg = BOOK + (state.epic_title || state.active_epic);
  if (state.active_story) {
    seg += ARROW + (state.story_title || state.active_story);
    if (state.story_status) seg += ` (${state.story_status})`;
  }
  return seg;
}

// The base statusLine command we compose with — highest-precedence entry BELOW
// our own local one: project settings.json, else user settings.json.
function discoverBaseCommand(projectDir) {
  const candidates = [
    join(projectDir, ".claude", "settings.json"),
    join(claudeHome(), "settings.json"), // config-dir-aware: else their HUD vanishes
  ];
  for (const p of candidates) {
    try {
      const cmd = JSON.parse(readFileSync(p, "utf8"))?.statusLine?.command;
      // Never compose over ourselves: any of our own wirings (plugin script or
      // generated launcher) would recurse.
      if (typeof cmd === "string" && cmd.trim() && !cmd.includes(SELF) && !statusLineIsOurs(cmd)) {
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

function main() {
  const raw = readRawStdin();
  let input = {};
  try { input = JSON.parse(raw) || {}; } catch { input = {}; }

  // The status line gets no project variable from the harness; the project is
  // on stdin, and it deliberately beats any exported variable. Read the config
  // for that directory directly — never by mutating process.env, which the
  // composed base command would then inherit.
  const projectDir =
    (input.workspace && input.workspace.project_dir) || input.cwd || process.cwd();

  let cfg = null;
  try { cfg = readConfigAt(projectDir); } catch { cfg = null; }

  const strings = loadStrings(cfg && cfg.language);
  let book = null;
  try { book = cfg && cfg.vault_path ? bookSegment(cfg, projectDir, input, strings) : null; } catch { book = null; }

  const showVersion = !(cfg && cfg.statusline && cfg.statusline.show_version === false);
  const ver = showVersion ? pluginVersion() : null;
  const badge = ver ? `[PS#${ver}] ` : "";

  const baseCmd = discoverBaseCommand(projectDir);
  const baseOut = baseCmd ? runBase(baseCmd, raw, process.env) : null;

  // "Never blank" must be total: even if the resolver threw (book === null on a
  // bound project), fall back to the cold-start line rather than vanishing.
  const bookOut =
    cfg && cfg.vault_path ? book || BOOK + strings.statusline_no_work : null;

  const lines = [];
  if (baseOut) {
    // Compose: keep the base HUD intact; our line = badge + 📚 segment.
    const position = (cfg && cfg.statusline && cfg.statusline.position) || "above";
    const ours = bookOut ? badge + bookOut : null;
    if (ours && position === "above") lines.push(ours);
    lines.push(baseOut);
    if (ours && position !== "above") lines.push(ours);
  } else {
    // Standalone: badge leads the whole line; the book value is its 📚 segment.
    const parts = [];
    const model = input.model && input.model.display_name;
    if (model) parts.push(model);
    if (projectDir) parts.push(basename(projectDir));
    const branch = gitBranch(projectDir);
    if (branch) parts.push(BRANCH + branch);
    if (bookOut) parts.push(bookOut);
    lines.push(badge + parts.join(SEP));
  }

  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch {
  // A status line must never crash. Emit nothing rather than an error.
  process.stdout.write("\n");
}

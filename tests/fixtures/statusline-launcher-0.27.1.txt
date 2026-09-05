#!/usr/bin/env node
// projectstore — status line launcher. GENERATED FILE, edits are lost.
//
// Why this file exists: the Claude Code `statusLine` slot holds ONE absolute
// command, and the session reads it at startup. Plugin code lives under a
// VERSIONED cache path (…/plugins/cache/<marketplace>/projectstore/<version>/),
// so wiring that path directly meant the rendered line was always the version
// installed at the PREVIOUS session start — an update showed up one restart
// late, badge and behaviour both.
//
// This launcher is written once and stays valid: it resolves the CURRENTLY
// installed plugin from Claude Code's own registry on every render, so
// `/plugin update` + `/reload-plugins` (or any restart) is reflected
// immediately. The generating root is kept only as a fallback.
//
// Never crashes: a status line that throws blanks the user's HUD, so every
// failure path degrades to an empty line.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Substituted by writeStatusLineLauncher() in scripts/lib.mjs.
const FALLBACK_ROOT = "__PROJECTSTORE_ROOT__";

function versionKey(v) {
  const p = String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0]; // pad: a missing component must compare as 0, not NaN
}

// Newest installed projectstore that is actually on disk. Deliberately a
// standalone copy of installedPluginRoot() in scripts/lib.mjs: importing that
// helper would mean naming a versioned path, which is the exact bug this file
// exists to remove.
function installedRoot() {
  try {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const reg = JSON.parse(
      readFileSync(join(claudeHome, "plugins", "installed_plugins.json"), "utf8"),
    );
    const family = dirname(FALLBACK_ROOT); // …/<marketplace>/projectstore
    const found = [];
    for (const [key, list] of Object.entries((reg && reg.plugins) || {})) {
      if (key !== "projectstore" && !key.startsWith("projectstore@")) continue;
      for (const e of Array.isArray(list) ? list : [list]) {
        const p = e && e.installPath;
        if (typeof p !== "string") continue;
        if (!existsSync(join(p, "scripts", "statusline.mjs"))) continue;
        found.push({
          p,
          same: dirname(p) === family ? 1 : 0, // stay on the marketplace we came from
          at: Date.parse((e && e.lastUpdated) || "") || 0,
          v: versionKey(e && e.version),
        });
      }
    }
    // Family is a FILTER, not a tiebreak — an install from another marketplace
    // is someone else's fork of projectstore, not a newer copy of ours, and
    // this file imports whatever it picks. Same rule as installedPluginRoot().
    const pool = found.filter((f) => f.same);
    pool.sort((a, b) => b.at - a.at || b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
    return pool.length ? pool[0].p : null;
  } catch {
    return null;
  }
}

// Try the installed plugin, then the root that generated this file. The second
// attempt matters: existsSync only proves the script is there, and a truncated
// or mid-update file throws on import — without a retry a working fallback
// would sit unused while the user's whole HUD (ours AND the base one we
// compose over) goes blank. Safe to retry because statusline.mjs prints only
// at the end of its own main(), so a failed import has written nothing.
let rendered = false;
for (const root of [installedRoot(), FALLBACK_ROOT]) {
  if (rendered || !root) continue;
  const target = join(root, "scripts", "statusline.mjs");
  try {
    if (!existsSync(target)) continue;
    // The renderer resolves its own root from CLAUDE_PLUGIN_ROOT when set —
    // point it at the install we actually loaded, or the badge, the strings and
    // the breadcrumb would describe a different one.
    process.env.CLAUDE_PLUGIN_ROOT = root;
    // Renders on import (statusline.mjs runs main() at module load and reads
    // its own stdin) — one process, no extra spawn.
    await import(pathToFileURL(target).href);
    rendered = true;
  } catch {
    // fall through to the next candidate
  }
}

// Last resort: projectstore is gone (uninstalled, or its cache swept) but this
// launcher is still wired. Our entry outranks the user's own statusLine, so
// giving up here would blank the HUD they had before us — in every bound
// project, with no projectstore left to unwire it. Run their base command
// instead, exactly as the renderer would have composed over it.
if (!rendered) {
  let out = null;
  try {
    const stdin = (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();
    const projectDir = (() => {
      try {
        const i = JSON.parse(stdin) || {};
        return (i.workspace && i.workspace.project_dir) || i.cwd || null;
      } catch { return null; }
    })();
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const candidates = [
      projectDir ? join(projectDir, ".claude", "settings.json") : null,
      join(claudeHome, "settings.json"),
    ].filter(Boolean);
    for (const p of candidates) {
      let cmd = null;
      try { cmd = JSON.parse(readFileSync(p, "utf8"))?.statusLine?.command; } catch { continue; }
      if (typeof cmd !== "string" || !cmd.trim()) continue;
      if (cmd.includes("statusline.mjs")) continue; // ours — would recurse
      const r = spawnSync(cmd, { shell: true, input: stdin, encoding: "utf8", timeout: 2000, maxBuffer: 1 << 20 });
      if (r.status === 0 && r.stdout && r.stdout.trim()) { out = r.stdout.replace(/\s+$/, ""); break; }
    }
  } catch {}
  process.stdout.write((out || "") + "\n");
}

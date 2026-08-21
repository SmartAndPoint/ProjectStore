#!/usr/bin/env node
// projectstore — smoke-codex.mjs
//
// Answers "is projectstore actually working on Codex?" as far as it can be
// answered without a live Codex session, then tells you exactly what only a
// live session can prove.
//
// The distinction matters. Everything projectstore believes about Codex's hook
// contract was verified against payloads this repository wrote itself, which is
// an assumption checking an assumption. This script checks the half that is
// genuinely checkable — that the files landed where Codex looks, in the shape
// it expects, and that each hook runs and produces the right JSON — and then
// prints the short list of claims only real Codex can settle, with the command
// that settles them.
//
// Usage:
//   node scripts/smoke-codex.mjs                 # against $CODEX_HOME
//   node scripts/smoke-codex.mjs --project       # against <cwd>/.codex
//   node scripts/smoke-codex.mjs --trace <file>  # summarise a recorded session

import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadHarness, REPO_ROOT } from "./harness.mjs";
import { codexHome } from "./install-codex.mjs";

const M = loadHarness("codex");
let failed = 0, warned = 0;

const C = { ok: "\x1b[32m✓\x1b[0m", bad: "\x1b[31m✗\x1b[0m", warn: "\x1b[33m!\x1b[0m", dim: "\x1b[2m", off: "\x1b[0m" };
function ok(m, d) { console.log(`  ${C.ok} ${m}${d ? `  ${C.dim}${d}${C.off}` : ""}`); }
function bad(m, d) { failed++; console.log(`  ${C.bad} ${m}${d ? `\n      ${C.dim}${d}${C.off}` : ""}`); }
function warn(m, d) { warned++; console.log(`  ${C.warn} ${m}${d ? `\n      ${C.dim}${d}${C.off}` : ""}`); }
function head(t) { console.log(`\n${t}`); }

// ─── 1. The generated tree is current ──────────────────────────────────

function checkGenerated() {
  head("1. Generated adapter");
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "build-adapters.mjs"), "--check"],
    { encoding: "utf8" });
  if (r.status === 0) ok("adapters match the source surfaces");
  else bad("adapters are stale — Codex would be served the previous version",
    `${(r.stderr || "").trim().split("\n")[0]}\n      Run: node scripts/build-adapters.mjs`);
}

// ─── 2. The install landed where Codex looks ───────────────────────────

function checkInstalled(dest) {
  head(`2. Installed surfaces  ${C.dim}${dest}${C.off}`);
  if (!existsSync(dest)) {
    bad("nothing installed", `Run: node scripts/install-codex.mjs${dest.endsWith(".codex") && !dest.startsWith(process.env.HOME || "~") ? " --project" : ""}`);
    return false;
  }
  let allThere = true;
  for (const key of ["commands", "agents", "skills"]) {
    const s = M.surfaces[key];
    const dir = join(dest, s.dir);
    const want = countSource(key);
    const got = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("projectstore-")).length : 0;
    if (got === 0) { bad(`no ${key} installed`, dir); allThere = false; }
    else if (got < want) { warn(`${got} of ${want} ${key} installed`, dir); allThere = false; }
    else ok(`${got} ${key}`, dir);
  }

  const hooks = join(dest, M.hooks.config_file);
  if (!existsSync(hooks)) { bad("no hooks.json", hooks); return false; }
  let cfg;
  try { cfg = JSON.parse(readFileSync(hooks, "utf8")); }
  catch (e) { bad("hooks.json is not parseable JSON", e.message); return false; }

  const ours = [];
  for (const [event, entries] of Object.entries(cfg.hooks || {})) {
    for (const e of entries) for (const h of e.hooks || []) {
      if (String(h.command).includes("/bin/ps-hook.mjs")) ours.push([event, h.command]);
    }
  }
  const expected = Object.values(M.hooks.events).length;
  if (ours.length === 0) bad("hooks.json has no projectstore entries", hooks);
  else ok(`${ours.length} hook command(s) wired`, [...new Set(ours.map((o) => o[0]))].join(", "));

  // The placeholder must be gone, and the path it became must exist.
  for (const [event, cmd] of ours) {
    if (cmd.includes(M.hooks.root_placeholder)) {
      bad(`${event}: placeholder never substituted`, cmd);
      continue;
    }
    const m = cmd.match(/"([^"]+ps-hook\.mjs)"/);
    if (m && !existsSync(m[1])) {
      bad(`${event}: wrapper path does not exist — the checkout moved?`,
        `${m[1]}\n      Re-run: node scripts/install-codex.mjs`);
    }
  }
  return allThere;
}

// Counted from the GENERATED tree, not the source directory. A surface gated
// out of this harness — `commands/statusline.md` carries `harness-only:
// claude-code`, because Codex has no status line slot — is correctly absent,
// and counting the source would report that deliberate omission as a shortfall.
function countSource(key) {
  const s = M.surfaces[key];
  const dir = join(REPO_ROOT, M.output_dir, s.dir);
  try { return readdirSync(dir).filter((n) => n.startsWith("projectstore-")).length; }
  catch { return 0; }
}

// ─── 3. The hooks actually run ─────────────────────────────────────────

// A throwaway project and vault, so this never touches anything real.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ps-smoke-"));
  const proj = join(root, "project"), vault = join(root, "vault");
  mkdirSync(join(proj, ".codex"), { recursive: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(vault, "adr"), { recursive: true });
  mkdirSync(join(vault, ".projectstore", "sessions"), { recursive: true });
  writeFileSync(join(proj, ".codex", "projectstore.json"),
    JSON.stringify({ vault_path: vault, layout: "engineering", auto_inject: true, language: "en" }), "utf8");
  writeFileSync(join(vault, ".projectstore", "sessions", "smoke.json"),
    JSON.stringify({ id: "smoke", project_root: proj, started_at: new Date().toISOString(), recent_activity: [] }), "utf8");
  return { root, proj, vault };
}

function runHook(rel, payload, proj) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, M.output_dir, "bin", "ps-hook.mjs"), rel], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, PROJECTSTORE_HARNESS: "codex", CODEX_PROJECT_DIR: proj },
  });
  let json = null;
  try { json = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop() || "null"); } catch {}
  return { ...r, json };
}

function checkHooks() {
  head("3. Hooks execute");
  const { root, proj, vault } = fixture();
  try {
    const start = runHook("hooks/session-start.mjs",
      { session_id: "smoke", source: "startup", cwd: proj }, proj);
    if (start.status !== 0) bad("SessionStart exited nonzero", (start.stderr || "").trim().slice(0, 200));
    else if (!start.json?.hookSpecificOutput?.additionalContext) bad("SessionStart produced no context");
    else {
      const ctx = start.json.hookSpecificOutput.additionalContext;
      const wrong = ctx.match(/\/projectstore:[a-z]+/g);
      if (wrong) bad("SessionStart used Claude Code command spelling", [...new Set(wrong)].join(" "));
      else ok("SessionStart injects context", `${ctx.length} chars, Codex spelling`);
    }

    // The load-bearing one: a relative multi-file patch must score every path.
    const envelope = "*** Begin Patch\n*** Add File: src/a.ts\n*** Add File: src/b.ts\n*** Add File: src/c.ts\n*** End Patch";
    let fired = null;
    for (let i = 0; i < 1; i++) {
      const post = runHook("scripts/touch-session.mjs",
        { session_id: "smoke", hook_event_name: "PostToolUse", tool_name: "apply_patch", cwd: proj,
          tool_input: { command: envelope } }, proj);
      if (post.status !== 0) { bad("PostToolUse exited nonzero", (post.stderr || "").trim().slice(0, 200)); break; }
      fired = post.json?.hookSpecificOutput?.additionalContext || null;
    }
    if (fired === null) bad("PostToolUse produced no entry reminder for 3 relative source paths",
      "Relative apply_patch paths are not being resolved — the score stays 0 and nothing is logged.");
    else {
      const n = (fired.match(/written to (\d+) source files/) || [])[1];
      if (n === "3") ok("apply_patch: 3 relative paths in one call all scored");
      else bad(`apply_patch scored ${n || "?"} of 3 relative paths`);
    }

    // And a vault write must reach the activity log.
    runHook("scripts/touch-session.mjs",
      { session_id: "smoke", hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: proj,
        tool_input: { command: "*** Begin Patch\n*** Add File: " + join(vault, "adr", "x.md") + "\n*** End Patch" } }, proj);
    const sess = JSON.parse(readFileSync(join(vault, ".projectstore", "sessions", "smoke.json"), "utf8"));
    if ((sess.recent_activity || []).length > 0) ok("vault edits reach the activity log");
    else bad("vault edit was not logged", "PreCompact and SessionStart continuity will be empty.");

    const pc = runHook("hooks/pre-compact.mjs", { session_id: "smoke", trigger: "manual", cwd: proj }, proj);
    if (pc.json?.systemMessage) {
      if (/\/projectstore:[a-z]+/.test(pc.json.systemMessage)) bad("PreCompact used Claude Code command spelling");
      else ok("PreCompact emits its line");
    } else bad("PreCompact produced no systemMessage");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

// ─── 4. Recorded-session summary ───────────────────────────────────────

function summariseTrace(file) {
  head(`4. Recorded Codex session  ${C.dim}${file}${C.off}`);
  if (!existsSync(file)) {
    bad("no trace file", `Record one first — see the checklist below.`);
    return;
  }
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!rows.length) { bad("trace file has no parseable payloads"); return; }
  ok(`${rows.length} payload(s) recorded`);

  const events = new Set(rows.map((r) => r.hook_event_name).filter(Boolean));
  console.log(`      ${C.dim}events: ${[...events].join(", ") || "(none named)"}${C.off}`);

  const withCwd = rows.filter((r) => typeof r.cwd === "string" && r.cwd).length;
  if (withCwd === rows.length) ok("every payload carries `cwd`", "project-root resolution is sound");
  else if (withCwd === 0) bad("NO payload carries `cwd`",
    "harness.mjs relies on it when CODEX_PROJECT_DIR is unset. Hooks would resolve the project from their own cwd.");
  else warn(`${withCwd} of ${rows.length} payloads carry \`cwd\``, "check which events omit it");

  const patches = rows.filter((r) => r.tool_name === "apply_patch");
  if (!patches.length) warn("no apply_patch payload recorded", "edit a file during the session to capture one");
  else {
    const field = M.tools.patch_envelope_field;
    const withEnvelope = patches.filter((r) => typeof r.tool_input?.[field] === "string").length;
    if (withEnvelope === patches.length) ok(`apply_patch carries its envelope in tool_input.${field}`);
    else bad(`apply_patch envelope is NOT in tool_input.${field}`,
      `Found keys: ${[...new Set(patches.flatMap((p) => Object.keys(p.tool_input || {})))].join(", ")}\n` +
      `      Update tools.patch_envelope_field in harnesses/codex.json.`);

    const sample = patches.find((p) => typeof p.tool_input?.[field] === "string");
    if (sample) {
      const paths = [...String(sample.tool_input[field]).matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm)].map((m) => m[1]);
      if (!paths.length) bad("envelope parsed to zero paths", "the *** Add/Update/Delete File: grammar did not match");
      else ok(`envelope parses to ${paths.length} path(s)`, paths.slice(0, 3).join(", "));
    }
  }

  const tools = new Set(rows.map((r) => r.tool_name).filter(Boolean));
  const known = new Set([...M.tools.write_tools, ...(M.tools.known_non_write_tools || [])]);
  const unknown = [...tools].filter((t) => !known.has(t));
  if (tools.size) console.log(`      ${C.dim}tools seen: ${[...tools].join(", ")}${C.off}`);
  // Unconditional: an unrecognised tool name matters most when apply_patch was
  // ALSO seen, because that is the case where everything looks healthy and one
  // write path is silently unscored.
  if (unknown.length) {
    warn(`tool names not in the manifest: ${unknown.join(", ")}`,
      "harmless for read-only tools. If any of these WRITES files, add it to\n" +
      "      tools.write_tools in harnesses/codex.json — otherwise its edits are\n" +
      "      never scored and never logged, with no error.");
  }
}

// ─── What only a live session can prove ────────────────────────────────

function checklist(dest) {
  head("What this script CANNOT prove — do these in a real Codex session");
  const trace = join(dest, "hook-trace.jsonl");
  console.log(`
  ${C.dim}Everything above ran against payloads this repository wrote. The
  contract itself — that Codex sends these fields, discovers these files —
  can only be settled by Codex.${C.off}

  a. Discovery. Start Codex in a bound project and type "/". You should see
     ${C.dim}/projectstore-adr, /projectstore-epic, /projectstore-status …${C.off}
     Then ask it: "which projectstore skills and agents can you see?"
     ${C.dim}Missing → Codex was not restarted, or it reads a different CODEX_HOME.${C.off}

  b. Hooks firing, and what they really send:

       export PROJECTSTORE_HOOK_TRACE=${trace}
       ${C.dim}# start Codex, edit two files, run /compact, exit${C.off}
       node scripts/smoke-codex.mjs --trace ${trace}

     ${C.dim}This is the one that matters. It answers whether Codex sets \`cwd\`,
     whether apply_patch carries its envelope where the manifest says, and
     whether the paths are relative — the three assumptions everything else
     rests on. Unset the variable afterwards.${C.off}

  c. The approval gate. Run ${C.dim}/projectstore-adr "test decision"${C.off} and check that
     Codex STOPS and asks before writing. On Codex this is prose, not a tool —
     if it writes without asking, that is the known weakness, not a bug.

  d. Agents. Ask Codex to "use the projectstore-critic subagent on <file>".
     ${C.dim}Confirms the TOML translation loads and the model/effort keys are accepted.${C.off}

  e. ${C.dim}node scripts/doctor.mjs --install${C.off} inside a real Codex session —
     should report no statusline and no adapter findings.
`);
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const traceAt = argv.indexOf("--trace");
  const dest = codexHome(M, { project: argv.includes("--project") });

  console.log(`projectstore — Codex preflight  ${C.dim}${REPO_ROOT}${C.off}`);

  if (traceAt >= 0) {
    summariseTrace(argv[traceAt + 1] || join(dest, "hook-trace.jsonl"));
  } else {
    checkGenerated();
    checkInstalled(dest);
    checkHooks();
    checklist(dest);
  }

  const verdict = failed === 0
    ? `${C.ok} ${warned ? `${warned} warning(s), nothing broken` : "all offline checks passed"}`
    : `${C.bad} ${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ""}`;
  console.log(`\n${verdict}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

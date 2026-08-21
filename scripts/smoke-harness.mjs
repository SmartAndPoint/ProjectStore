#!/usr/bin/env node
// projectstore — smoke-harness.mjs
//
// Answers "is projectstore actually working on this harness?" as far as it can
// be answered without a live session of it, then says exactly what only a live
// session can prove.
//
// Harness-agnostic: which harness, which directories, which fields a hook
// payload should carry, all come from harnesses/<id>.json.
//
// The distinction matters. Everything projectstore believes about a harness's
// hook contract was verified against payloads this repository wrote itself,
// which is an assumption checking an assumption. This script checks the half
// that is genuinely checkable — that the files landed where the harness looks,
// in the shape it expects, and that each hook runs and produces the right JSON
// — and then prints the short list of claims only a live session can settle,
// with the command that settles them.
//
// Usage:
//   node scripts/smoke-harness.mjs                 # this project (default)
//   node scripts/smoke-harness.mjs <project-path>
//   node scripts/smoke-harness.mjs --user          # a home-scoped install
//   node scripts/smoke-harness.mjs --trace <file>  # summarise a recorded session
//   node scripts/smoke-harness.mjs --harness <id>  # when more than one emits

import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadHarness, emittingHarnesses, commandRef, agentRef, REPO_ROOT } from "./harness.mjs";
import {
  surfaceDest, destinations, isProjectTrusted, resolveHarnessId, installCommand,
} from "./install-harness.mjs";

// Resolved once, from argv or from the single emitting harness. Everything
// below reads the manifest through M, so nothing here knows a harness by name.
const { id: HARNESS_ID } = resolveHarnessId(process.argv.slice(2));
const M = HARNESS_ID ? loadHarness(HARNESS_ID) : null;
if (!M) {
  console.error(
    `Which harness? Pass --harness <id>.\n  Known: ${emittingHarnesses().map((h) => h.id).join(", ")}`,
  );
  process.exit(2);
}
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
  else bad(`adapters are stale — ${M.display_name} would be served the previous version`,
    `${(r.stderr || "").trim().split("\n")[0]}\n      Run: node scripts/build-adapters.mjs`);
}

// ─── 2. The install landed where the harness looks ────────────────────

// Surfaces do not share one destination: skills, agents and hooks are scoped to
// the project, while some surfaces can only live in the harness home directory.
// Checking a single directory would report the other half as missing.
function checkInstalled(opts) {
  head("2. Installed surfaces");
  for (const [key, dest] of destinations(M, opts)) {
    if (key === "hooks") continue;
    console.log(`  ${C.dim}${key}: ${dest}${C.off}`);
  }
  let allThere = true;
  for (const key of ["commands", "agents", "skills"]) {
    const s = M.surfaces[key];
    const dir = join(surfaceDest(M, key, opts), s.dir);
    const want = countSource(key);
    const got = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("projectstore-")).length : 0;
    if (got === 0) {
      bad(`no ${key} installed`, `${dir}\n      Run: node scripts/install-harness.mjs`);
      allThere = false;
    } else if (got < want) { warn(`${got} of ${want} ${key} installed`, dir); allThere = false; }
    else ok(`${got} ${key}`);
  }

  const hooks = join(surfaceDest(M, "hooks", opts), M.hooks.config_file);
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
        `${m[1]}\n      Re-run: node scripts/install-harness.mjs`);
    }
  }
  // The check that decides whether any of the above matters: a harness that
  // gates project config behind trust skips an untrusted project's layer in
  // silence, so hooks installed there never run and every other check passes.
  if (!opts.userOnly && M.runtime?.project_trust) {
    const root = opts.cwd || process.cwd();
    if (isProjectTrusted(M, root, opts)) ok(`project is trusted — its ${M.runtime.project_config_dir}/ hooks will load`);
    else bad(`PROJECT IS NOT TRUSTED — ${M.display_name} will ignore the hooks installed above`,
      `Everything else here passes and nothing fires.\n      Fix: ${installCommand(M, root, "--trust")}`);
  }
  return allThere;
}

// Counted from the GENERATED tree, not the source directory. A surface gated
// out of this harness — `commands/statusline.md` carries `harness-only:
// claude-code`, because no other harness has a status line slot — is absent,
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
    // Both from the manifest: the harness id it should run as, and the name of
    // the variable that harness uses to state a project root.
    env: { ...process.env, PROJECTSTORE_HARNESS: M.id, [M.runtime.project_dir_env]: proj },
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
      if (wrong) bad("SessionStart used the source harness" + "'s command spelling", [...new Set(wrong)].join(" "));
      else ok("SessionStart injects context", `${ctx.length} chars, ${M.display_name} spelling`);
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
      if (/\/projectstore:[a-z]+/.test(pc.json.systemMessage)) bad("PreCompact used the source harness" + "'s command spelling");
      else ok("PreCompact emits its line");
    } else bad("PreCompact produced no systemMessage");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

// ─── 4. Recorded-session summary ───────────────────────────────────────

function summariseTrace(file) {
  head(`4. Recorded ${M.display_name} session  ${C.dim}${file}${C.off}`);
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
  head(`What this script CANNOT prove — do these in a real ${M.display_name} session`);
  const trace = join(dest, "hook-trace.jsonl");
  console.log(`
  ${C.dim}Everything above ran against payloads this repository wrote. The
  contract itself — that ${M.display_name} sends these fields and discovers
  these files — can only be settled by ${M.display_name}.${C.off}

  a0. If hooks are listed but idle, check they are trusted. ${M.display_name} can LIST a
     project hook while SKIPPING it until its definition is reviewed. Granting
     project trust was enough in testing and no separate approval was asked
     for — so check this only when hooks appear listed and dead, rather than
     expecting to be prompted.
       ${C.dim}CLI:     /hooks
       Desktop: Settings → Hooks → From Projects → <your project>${C.off}
     ${C.dim}Approval is keyed to the hook's hash, so re-running the installer or
     moving the checkout revokes it and you review again.${C.off}

  a. Discovery. Start ${M.display_name} in a bound project and type "/". You should see
     ${C.dim}/projectstore-adr, /projectstore-epic, /projectstore-status …${C.off}
     Then ask it: "which projectstore skills and agents can you see?"
     ${C.dim}Missing → the harness was not restarted, or it reads a different ${M.runtime.home_env}.${C.off}

  b. Hooks firing, and what they really send:

       export PROJECTSTORE_HOOK_TRACE=${trace}
       ${C.dim}# start ${M.display_name} IN A TERMINAL, edit two files, run /compact, exit${C.off}
       node scripts/smoke-harness.mjs --trace ${trace}

     ${C.dim}This is the one that matters. It answers whether ${M.display_name} sets \`cwd\`,
     whether apply_patch carries its envelope where the manifest says, and
     whether the paths are relative — the three assumptions everything else
     rests on. Unset the variable afterwards.

     Terminal only: a desktop client does not inherit your shell environment, so
     the variable never reaches it and the trace stays empty whether or not its
     hooks run. For the desktop, use (e) instead — it reads the vault rather
     than the environment.${C.off}

  c. The approval gate. Run ${C.dim}/projectstore-adr "test decision"${C.off} and check that
     ${M.display_name} STOPS and asks before writing. Here this is prose, not a tool —
     if it writes without asking, that is the known weakness, not a bug.

  d. Agents. Ask ${M.display_name} to use the ${agentRef("critic", { PROJECTSTORE_HARNESS: M.id })} subagent on a file.
     ${C.dim}Confirms the TOML translation loads and the model/effort keys are accepted.${C.off}

  e. ${C.dim}node scripts/doctor.mjs --install${C.off} — no statusline and no adapter
     findings, and its \`hooks\` check is how you tell whether hooks fired at
     all: it reports a session registration fresher than 30 minutes. Run it
     right after a session (terminal OR desktop) and read that line.

     ${C.dim}One caveat that will mislead you: SessionStart deliberately does NOT
     register a session when the bound vault does not exist yet. So the very
     session in which you scaffold the vault registers nothing, and an empty
     sessions/ directory afterwards proves nothing. Re-test with a session that
     starts AFTER the vault exists.${C.off}
`);
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const traceAt = argv.indexOf("--trace");
  // Skip the --trace file and the --harness id; neither is the project path.
  const hAt = argv.indexOf("--harness");
  const skip = new Set([traceAt >= 0 ? traceAt + 1 : -1, hAt >= 0 ? hAt + 1 : -1]);
  const positional = argv.find((a, i) => !a.startsWith("-") && !skip.has(i));
  const opts = { userOnly: argv.includes("--user"), cwd: positional ? resolve(positional) : process.cwd() };
  const home = surfaceDest(M, "commands", opts);

  console.log(`projectstore — ${M.display_name} preflight  ${C.dim}${REPO_ROOT}${C.off}`);

  if (traceAt >= 0) {
    summariseTrace(argv[traceAt + 1] || join(home, "hook-trace.jsonl"));
  } else {
    checkGenerated();
    checkInstalled(opts);
    checkHooks();
    checklist(home);
  }

  const verdict = failed === 0
    ? `${C.ok} ${warned ? `${warned} warning(s), nothing broken` : "all offline checks passed"}`
    : `${C.bad} ${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ""}`;
  console.log(`\n${verdict}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

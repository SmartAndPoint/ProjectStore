#!/usr/bin/env node
// projectstore — session-stop.mjs
//
// The entry reminder's fallback carrier (spec contract 14).
//
// The PostToolUse carrier reaches the main agent on its next own tool call.
// Under a delegation-heavy configuration there may not be one: the main agent
// hands the writing to subagents — whose calls count toward the score but are
// never the audience — and then answers the user. Stop fires exactly there.
//
// What Stop may print is the harness's, read from its manifest
// (output_channels.Stop.carrier — generation spec, contract 17; entry spec,
// contract 14, as amended 2026-10-15):
//
//  * Claude Code (2.1.163+) honours `additionalContext` on Stop, and it
//    CONTINUES the turn: the reminder arrives as context.
//  * Codex refuses `hookSpecificOutput` on Stop — its Stop schema denies
//    unknown fields, and the hook reads `Failed` — and honours only a block
//    decision, whose reason enters the same turn as a user-role hook prompt
//    (measured 2026-10-15, codex-cli 0.162.1).
//  * The carrier comes from the harness that IDENTIFIES itself (forced, a
//    parent's decision, a strong signal or a session marker); nothing
//    identified, or no carrier measured, is silence. It is read before the
//    vault and before the election, so a harness that cannot carry the
//    reminder never spends it.
//
// Either channel continues the turn, so the model finishes again and Stop
// fires again. That is why this hook runs the same create-then-emit election
// as the PostToolUse branch, not merely a read of the markers: creating the
// marker before emitting is what makes the second firing impossible.
// `stop_hook_active` (true on the continued Stop — measured on Codex) is belt
// and braces; the election is the load-bearing guard.
//
// Not SubagentStop: it fires once per subagent and its continuation belongs to
// the subagent, which is the actor that cannot open a story.

import {
  readConfig,
  readStdinJson,
  adoptHookInput,
  projectRoot,
  entryScore,
  readOpenStoryCache,
  resolveOpenStory,
  writeOpenStoryCache,
  mayRemind,
  electEmitter,
  appendEntryLog,
  entryReminderText,
  ENTRY_THRESHOLD,
  stopCarrier,
} from "../scripts/lib.mjs";

async function main() {
  // The payload before the project: readConfig() resolves through
  // projectRoot(), and on a harness that exports no project-dir variable the
  // payload's cwd is the only answer better than this process's cwd. Read once
  // — fd 0 is empty on a second read.
  const input = adoptHookInput(readStdinJson());

  // Which shape this harness accepts, before anything is read or written.
  const carrier = stopCarrier();
  if (!carrier) return;

  const cfg = readConfig();
  if (!cfg || cfg.guard === "off") return;

  const sid = input?.session_id;
  if (!sid) return;
  if (input.stop_hook_active) return;
  // Same audience rule as the tool-call carrier.
  if (input.agent_id || input.agent_type) return;

  const proj = projectRoot();
  const score = entryScore(proj, sid);
  if (score < ENTRY_THRESHOLD) return;
  if (!mayRemind(proj, sid)) return;

  let verdict = readOpenStoryCache(proj, sid);
  if (verdict === null) {
    verdict = await resolveOpenStory(cfg.vault_path);
    writeOpenStoryCache(proj, sid, verdict);
  }
  // Nothing written to stdout yet, so exiting here cannot truncate anything.
  if (verdict === "unknown") process.exit(0);
  if (verdict !== false) return;

  if (!electEmitter(proj, sid)) return;
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: sid, score, via: "Stop", channel: carrier });
  const text = entryReminderText(score);
  // A block prints the bytes Codex honoured — one object, no newline (Run 4,
  // t4); context prints what it always printed.
  if (carrier === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: text }));
  else
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: text,
        },
      }) + "\n",
    );
}

main().catch(() => {
  // A hook must never break the user's turn.
});

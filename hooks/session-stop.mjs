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
// Two things about Stop that shape this file:
//
//  * `additionalContext` on Stop CONTINUES the turn. So this hook must run the
//    same create-then-emit election as the PostToolUse branch, not merely read
//    the markers: a guard that only checks would emit, the turn would continue,
//    the model would finish again, Stop would fire again — forever. Creating
//    the marker before emitting is what makes the second firing impossible.
//  * `stop_hook_active` is set while a Stop hook is already driving the turn.
//    Honouring it is belt and braces; the election is the load-bearing guard.
//
// Not SubagentStop: it fires once per subagent and its continuation belongs to
// the subagent, which is the actor that cannot open a story.
//
// Requires Claude Code 2.1.163+, where additionalContext on Stop is honoured.

import {
  readConfig,
  readStdinJson,
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
} from "../scripts/lib.mjs";
import { adoptHookInput } from "../scripts/harness.mjs";

async function main() {
  // stdin BEFORE readConfig: config lookup resolves against the project root,
  // and on a harness that exports no project-dir variable the payload's `cwd` is
  // the only reliable source for it. Reading config first would search the hook
  // process's own working directory and report an unbound project.
  const input = adoptHookInput(readStdinJson());
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
  appendEntryLog(proj, { at: new Date().toISOString(), session_id: sid, score, via: "Stop" });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: entryReminderText(score),
    },
  }) + "\n");
}

main().catch(() => {
  // A hook must never break the user's turn.
});

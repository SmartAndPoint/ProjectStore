#!/usr/bin/env node
// projectstore — session-rules.mjs
//
// The SECOND SessionStart hook. It carries the standing rules an agent needs
// before it starts working, and nothing else.
//
// Why a separate hook rather than more text in session-start.mjs: hook output
// strings are capped at 10,000 characters PER VALUE, and over the cap the
// harness replaces the text with a file path and a preview. session-start's
// vault map is already over that line on a real vault (11,596 characters when
// this was written), so anything appended to it would arrive as a reference
// rather than as context. Several hooks returning additionalContext for one
// event are all delivered, so a small second value is delivered inline no
// matter how large the map grows. Keep this payload small — permanently.
//
// Spec: "Entry-rule detection: the score, the open-story predicate, and the
// delivery seams", contract 17.

import { readConfig, readStdinJson } from "../scripts/lib.mjs";
import { agentRef, adoptHookInput } from "../scripts/harness.mjs";

// Kept well under the cap; asserted by a test rather than by intention.
const RULES = () => `# projectstore — standing rules for this session

**Artifact-first order.** A feature-sized request opens a vault artifact before
it opens an editor: analysis → placement (which epic, which story) → an ADR
and/or spec when the "how" is non-trivial → \`${agentRef("critic")}\` → only then
implementation → \`${agentRef("reviewer")}\`. "Feature-sized" is not a judgement
call about how the request was phrased — it is about what the work touches. If
you are about to write across several source files, open the story first.

**Report instruction conflicts; do not arbitrate them.** If a session-level or
harness-level instruction contradicts these rules or the \`AGENTS.md\`
registration block, say so and ask which wins. Resolving it silently is how the
contradiction becomes invisible to the person who could have settled it.`;

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }) + "\n");
}

function main() {
  // Same ordering rule as every other hook: the payload's `cwd` has to be
  // adopted before config lookup resolves a project root.
  adoptHookInput(readStdinJson());
  const cfg = readConfig();
  if (!cfg) return;
  // Honour auto_inject: a session that opted out of context injection is
  // exactly the case for which the AGENTS.md block remains the durable copy.
  if (cfg.auto_inject === false) return;
  emit(RULES());
}

try { main(); } catch {
  // A hook must never break session startup.
}

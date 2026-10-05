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

import { readConfig, readStdinJson, adoptHookInput, roleForm, sharedRoleForm } from "../scripts/lib.mjs";

// Kept well under the cap; asserted by a test rather than by intention. The
// roles are named the way the session's harness calls them (generation spec,
// contract 18). The shared AGENTS.md block names them in the source harness's
// form until that block is per-harness, so a session whose form differs is
// told once that both name one role — otherwise the second rule below would
// have it report the block as a contradiction every session.
function rules() {
  const critic = roleForm("critic"), reviewer = roleForm("reviewer");
  const shared = sharedRoleForm("critic");
  const bridge = shared === critic
    ? ""
    : `\n\nThe \`AGENTS.md\` block may name roles as \`${shared}\`; that is the same role, called \`${critic}\` here.`;
  return `# projectstore — standing rules for this session

**Artifact-first order.** A feature-sized request opens a vault artifact before
it opens an editor: analysis → placement (which epic, which story) → an ADR
and/or spec when the "how" is non-trivial → \`${critic}\` → only then
implementation → \`${reviewer}\`. "Feature-sized" is not a judgement
call about how the request was phrased — it is about what the work touches. If
you are about to write across several source files, open the story first.

**Report instruction conflicts; do not arbitrate them.** If a session-level or
harness-level instruction contradicts these rules or the \`AGENTS.md\`
registration block, say so and ask which wins. Resolving it silently is how the
contradiction becomes invisible to the person who could have settled it.${bridge}`;
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }) + "\n");
}

function main() {
  // The RULES text below is the same for every project, so it is tempting to
  // skip the payload here. The GATE is not: both `!cfg` and `auto_inject`
  // are facts about one specific project, and this hook shares its event with
  // session-start.mjs. If only one of the two adopted the payload, the pair
  // could answer for two different projects in the same session start — one
  // emitting a vault's skeleton while the other decided, from the process's
  // cwd, whether to speak at all. One readFileSync(0) is the whole cost of
  // keeping them symmetric.
  adoptHookInput(readStdinJson());

  const cfg = readConfig();
  if (!cfg) return;
  // Honour auto_inject: a session that opted out of context injection is
  // exactly the case for which the AGENTS.md block remains the durable copy.
  if (cfg.auto_inject === false) return;
  emit(rules());
}

try { main(); } catch {
  // A hook must never break session startup.
}

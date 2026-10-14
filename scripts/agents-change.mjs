// The change to a harness overlay's agents block (the configure spec,
// contract 8): planned once, here, and called by `agents configure` and by
// `configure`, so the clerk pin, the precedence and the overlay's other keys
// behave the same whichever verb asks. The gate stays the caller's.
import { readOverlayAt, writeOverlayAt } from "./lib.mjs";
import { harnessForOverlay } from "./harness.mjs";

// What a change would write. `before` is readOverlayAt's read; `roster` the
// layout's agent names (null when no layout loads); `agents` the
// `<name>=<model>` specs; `defaultEffort` and `efforts` (`<name>=<level>`)
// the same for effort (the effort ADR, decision 8). A malformed spec or a name
// outside the roster comes back as `usage`, with nothing planned.
export function planAgentsChange({
  before,
  harness,
  layout,
  roster,
  defaultModel,
  agents = [],
  defaultEffort,
  efforts = [],
  reset = false,
}) {
  // --reset empties the block first; --default and --agent then apply on top of
  // the emptied block — "reset, then set" is one call, and nothing given is
  // silently dropped.
  const base = reset ? { default: null, per_agent: {} } : before.agents;
  const next = {
    default: defaultModel !== undefined ? defaultModel || null : base.default,
    per_agent: { ...base.per_agent },
  };
  for (const spec of agents) {
    const m = /^([a-z][a-z0-9-]*)=(.*)$/.exec(spec);
    if (!m) return { usage: `--agent takes <name>=<model>, got ${spec}` };
    // A name outside the roster would be written, listed, and never run.
    if (roster && !roster.includes(m[1]))
      return { usage: `no agent named ${m[1]} in the ${layout} roster — known: ${roster.join(", ")}` };
    if (m[2]) next.per_agent[m[1]] = m[2];
    else delete next.per_agent[m[1]];
  }
  // Efforts, field by field beside the models: a run that names none keeps
  // every effort the overlay holds, and --reset empties them with the models.
  const beforeEfforts = before.efforts || { default: null, per_agent: {} };
  const baseEfforts = reset ? { default: null, per_agent: {} } : beforeEfforts;
  const nextEfforts = {
    default: defaultEffort !== undefined ? defaultEffort || null : baseEfforts.default,
    per_agent: { ...baseEfforts.per_agent },
  };
  for (const spec of efforts) {
    const m = /^([a-z][a-z0-9-]*)=(.*)$/.exec(spec);
    if (!m) return { usage: `an effort takes <name>=<level>, got ${spec}` };
    if (roster && !roster.includes(m[1]))
      return { usage: `no agent named ${m[1]} in the ${layout} roster — known: ${roster.join(", ")}` };
    if (m[2]) nextEfforts.per_agent[m[1]] = m[2];
    else delete nextEfforts.per_agent[m[1]];
  }
  // The clerk transcribes; a strong default must not lift it (commands/agents.md,
  // ADR-008). WHICH model it is pinned to is the harness's vocabulary, so the
  // manifest names it and this file does not: pinning every harness to
  // "sonnet" wrote an Anthropic model name into a Codex overlay, which is a
  // model that does not exist there. A manifest with no cheap model declared
  // does not pin, and the preview says so rather than inventing one.
  // No fallback model here, deliberately, and it is not the same call as
  // SOURCE_WRITE_TOOLS_FALLBACK: a missing manifest cannot reach this line.
  // harnessIds() derives from the manifests, so with none loadable a named
  // harness is refused as unknown before any caller plans a change (`agents
  // configure` and `configure` both check it first). A literal here would be
  // the deleted `"sonnet"` restored for a case that cannot happen.
  let pinnedClerk = false;
  let clerkPinUnavailable = false;
  const clerkAsked = agents.some((s) => s.startsWith("clerk="));
  if (next.default && !next.per_agent.clerk && !clerkAsked) {
    const cheap = harnessForOverlay(harness)?.agent_translation?.cheap_model || null;
    if (cheap) {
      next.per_agent.clerk = cheap;
      pinnedClerk = true;
    } else clerkPinUnavailable = true;
  }
  // The clerk's effort, pinned the same way while a default effort stands
  // (the effort ADR, decision 6), where the harness names a cheap level; a
  // harness that names none pins nothing and says nothing, because its clerk
  // already runs at its frontmatter's level.
  let pinnedClerkEffort = false;
  const clerkEffortAsked = efforts.some((s) => s.startsWith("clerk="));
  if (nextEfforts.default && !nextEfforts.per_agent.clerk && !clerkEffortAsked) {
    const cheap = harnessForOverlay(harness)?.agent_translation?.effort?.cheap || null;
    if (cheap) {
      nextEfforts.per_agent.clerk = cheap;
      pinnedClerkEffort = true;
    }
  }
  // Keys inside the agents block that the allowlist rejected (a stray shape)
  // are rewritten out by the write and announced here; keys outside the block
  // are kept, and stay doctor's to name.
  const dropped = before.rejected.filter((k) => k.startsWith("agents."));
  const sameEfforts =
    JSON.stringify({ d: beforeEfforts.default, p: beforeEfforts.per_agent }) ===
    JSON.stringify({ d: nextEfforts.default, p: nextEfforts.per_agent });
  const same =
    !dropped.length &&
    sameEfforts &&
    JSON.stringify({ d: before.agents.default, p: before.agents.per_agent }) ===
      JSON.stringify({ d: next.default, p: next.per_agent });
  const preview = [
    `agents configure — ${harness} — ${before.path}`,
    `  default: ${before.agents.default || "—"} → ${next.default || "—"}`,
  ];
  const names = new Set([...Object.keys(before.agents.per_agent), ...Object.keys(next.per_agent)]);
  for (const n of [...names].sort())
    preview.push(
      `  ${n}: ${before.agents.per_agent[n] || "—"} → ${next.per_agent[n] || "—"}${pinnedClerk && n === "clerk" ? " (pinned: the clerk stays cheap under a strong default)" : ""}`,
    );
  // Silence here would read as "the clerk is fine", and it is not: it takes the
  // strong default, which is the one thing ADR-008 says must not happen to it.
  if (clerkPinUnavailable)
    preview.push(
      `  clerk: takes the default — ${harness} declares no cheap model to pin it to, so name one with --agent clerk=<model>`,
    );
  // Effort lines only where an effort is held or asked for, so a run over an
  // overlay of models alone previews exactly as it did before efforts.
  if (beforeEfforts.default || nextEfforts.default)
    preview.push(`  default effort: ${beforeEfforts.default || "—"} → ${nextEfforts.default || "—"}`);
  const effortNames = new Set([...Object.keys(beforeEfforts.per_agent), ...Object.keys(nextEfforts.per_agent)]);
  for (const n of [...effortNames].sort())
    preview.push(
      `  ${n} effort: ${beforeEfforts.per_agent[n] || "—"} → ${nextEfforts.per_agent[n] || "—"}${pinnedClerkEffort && n === "clerk" ? " (pinned: the clerk stays cheap under a strong default)" : ""}`,
    );
  if (dropped.length)
    preview.push(`  drops from the agents block (an overlay carries only models and efforts): ${dropped.join(", ")}`);
  return { next, nextEfforts, pinnedClerk, pinnedClerkEffort, clerkPinUnavailable, dropped, same, preview };
}

// Writes a planned change through the overlay's one writer and reads it back.
// `nextEfforts` left out keeps the efforts the file holds.
export function applyAgentsChange(projectDir, harness, next, nextEfforts) {
  const path = writeOverlayAt(projectDir, harness, next, nextEfforts);
  return { path, after: readOverlayAt(projectDir, harness) };
}

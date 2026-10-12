// The change to a harness overlay's agents block (the configure spec,
// contract 8): planned once, here, and called by `agents configure` and by
// `configure`, so the clerk pin, the precedence and the overlay's other keys
// behave the same whichever verb asks. The gate stays the caller's.
import { readOverlayAt, writeOverlayAt } from "./lib.mjs";
import { harnessForOverlay } from "./harness.mjs";

// What a change would write. `before` is readOverlayAt's read; `roster` the
// layout's agent names (null when no layout loads); `agents` the
// `<name>=<model>` specs. A malformed spec or a name outside the roster comes
// back as `usage`, with nothing planned.
export function planAgentsChange({ before, harness, layout, roster, defaultModel, agents = [], reset = false }) {
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
  // Keys inside the agents block that the allowlist rejected (an `effort`, a
  // stray shape) are rewritten out by the write and announced here; keys
  // outside the block are kept, and stay doctor's to name.
  const dropped = before.rejected.filter((k) => k.startsWith("agents."));
  const same =
    !dropped.length &&
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
  if (dropped.length)
    preview.push(`  drops from the agents block (an overlay carries only models): ${dropped.join(", ")}`);
  return { next, pinnedClerk, clerkPinUnavailable, dropped, same, preview };
}

// Writes a planned change through the overlay's one writer and reads it back.
export function applyAgentsChange(projectDir, harness, next) {
  const path = writeOverlayAt(projectDir, harness, next);
  return { path, after: readOverlayAt(projectDir, harness) };
}

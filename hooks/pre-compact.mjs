#!/usr/bin/env node
// projectstore — PreCompact hook.
//
// Fires before context compaction (both manual /compact and automatic).
//
// ONE channel: `systemMessage`, the line the user sees in their /compact
// output. PreCompact has no `additionalContext` — the runtime rejects the whole
// object when one is present, taking `systemMessage` down with it, so for its
// entire history this hook assembled a packet, printed a red validation error,
// and reached nobody. Agent-facing continuity after a compaction is
// SessionStart's job, on `source: "compact"` (spec contract 19).
//
// What this hook may CLAIM is narrower than what it knows, and deliberately so:
//   - naming the in-flight artifact is always safe — it is a fact about the log
//     it just read, not a promise about the future;
//   - promising that context comes back requires `trigger === "manual"` AND
//     `auto_inject !== false`, the two falsifiers knowable at claim time;
//   - promising that RECENT FILES come back additionally requires the log to
//     have resolved nonempty, because an empty log renders nothing there.
//
// Session identity comes from Claude's own session_id in stdin input (so two
// Claude instances on the same project don't share activity).
// Silent no-op when no projectstore config is present.

import { basename } from "node:path";
import {
  readConfig,
  readStdinJson,
  loadLayout,
  readActivityAsync,
  resolveInFlightArtifact,
  pathCell,
} from "../scripts/lib.mjs";

// Exits after the flush, never before: process.exit does not drain a pending
// pipe write, and the budgeted read below can still be outstanding.
function emit(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }) + "\n", () => process.exit(0));
}

// Contract 13's budget applies here too. The session file lives inside the
// vault, so an evicted copy blocks uninterruptibly — and hanging a compaction
// is a worse outcome than a line with no artifact name. The READ itself comes
// from lib.mjs: SessionStart reads the same file for the same reason, and
// contract 24's argument against two implementations of one question does not
// stop at the resolver.
// No {readFile} seam here on purpose: this hook is only ever driven as a
// process, so a seam nothing can reach would read as testability it does not
// have. The race is unit-tested through the gather's copy of it.
//   null → the read did not resolve in time
//   []   → resolved: missing, unreadable and genuinely empty, indistinguishable
async function readActivityBudgeted(vault, sid, budgetMs) {
  if (!sid) return [];
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const out = await Promise.race([
    readActivityAsync(vault, sid).catch(() => []),
    deadline,
  ]);
  clearTimeout(timer);
  return out;
}

async function main() {
  const cfg = readConfig();
  if (!cfg) process.exit(0);

  const input = readStdinJson();
  const sid = input?.session_id || null;
  const activity = await readActivityBudgeted(cfg.vault_path, sid, 200);

  // Defensive: loadLayout throws on an unknown layout name, and in this hook the
  // outer catch produces a failure notice rather than a compaction line — so a
  // layout throw would take the whole message down for the sake of one clause.
  let layout = null;
  try {
    layout = loadLayout(cfg.layout);
  } catch {}
  const artifact = activity && layout
    ? resolveInFlightArtifact(activity, layout, cfg.vault_path)
    : null;

  const parts = [`vault ${basename(cfg.vault_path)}`];
  // Dropped rather than rendered empty when nothing resolves.
  // Contract 19's "one path form, three renderings": the same 200-character
  // front-truncated cell the skeleton uses, so a >200 path cannot render
  // truncated in one place and whole one line away.
  if (artifact) parts.push(`in flight: ${pathCell(artifact)}`);

  // The delivery claim, and only where it is true. On `auto` this plugin makes
  // no claim that SessionStart fires at all; under `auto_inject: false` the
  // skeleton is deterministically not emitted, and gating on config presence
  // alone would print the promise happily on exactly that configuration.
  const mayPromise = input?.trigger === "manual" && cfg.auto_inject !== false;
  if (mayPromise) {
    // Recent files are a separate referent with a separate condition: an empty
    // log renders no continuity section, so the stronger wording would be false
    // on a path the activity log's last-tool-wins dedupe makes ordinary.
    parts.push(activity && activity.length > 0
      ? "orientation and this session's recent files return at session start"
      : "orientation returns at session start");
  } else {
    // True on every path: plugin commands are installation-scoped and not
    // gated by auto_inject.
    parts.push("run /projectstore:status to reorient");
  }

  emit(`projectstore: compacting — ${parts.join(", ")}`);
}

main().catch((e) => {
  emit(`projectstore: PreCompact hook failed — ${e.message}`);
});

#!/usr/bin/env node
// projectstore — tokens.mjs
//
// Answers "how many tokens did we spend on keeping the vault, as opposed to
// writing code?" — read-only, from the Claude Code transcripts this project
// already produces. Nothing needs to be enabled ahead of time; it works on
// whatever history is still on disk.
//
// Two attribution sources, both written by Claude Code itself:
//   1. subagents — <session>/subagents/agent-*.meta.json carries `agentType`
//      ("projectstore:critic", "projectstore:reviewer", …). Exact, per agent.
//   2. slash commands — main-thread records carry `attributionSkill`
//      ("projectstore:research") and `attributionPlugin` ("projectstore").
// Anything else in the main thread is unattributed and reported as such.
//
// THREE COUNTING RULES, all load-bearing — get them wrong and the numbers lie:
//   • Dedup by requestId. One API message is written as ONE JSONL RECORD PER
//     CONTENT BLOCK (text + each tool_use). Summing records over-counts ~2.7×.
//   • input/cache_* are identical across a requestId's records, but
//     output_tokens is CUMULATIVE — the final value is in the last record.
//     So: take input/cache from any one record, take max() of output.
//   • Tool calls per turn = distinct tool_use block ids per requestId,
//     collected ACROSS the request's records — counting per record yields a
//     false "1 call/turn" for every turn (each record holds ≤1 tool_use).
//
// COST is computed at current API list prices (PRICING below) with the cache
// multipliers: read 0.1× input, 5m write 1.25×, 1h write 2× (the usage records
// carry the 5m/1h split). Under a subscription plan these dollars are a proxy
// for rate-limit consumption, not an invoice — the RATIOS hold either way.
// Historical price changes are not modeled; everything is priced at today's
// list. Unknown models are priced at 0 and reported.
//
// KNOWN BLIND SPOTS (deliberate, documented rather than silently skewed):
//   • Vault edits made in the main thread without a /projectstore:* command
//     land in the unattributed bucket — attribution only tags plugin commands.
//   • The SessionStart vault injection is re-read as cache_read on EVERY
//     request of a session, including pure-code ones. That is real vault cost
//     smeared across the main thread; this script does not try to carve it out.
//   • Transcripts are pruned on Claude Code's retention schedule
//     (cleanupPeriodDays, 30 by default), so this is "what's left on disk",
//     not all time. Persisting a per-session roll-up is a separate concern.
//
// Usage:
//   node scripts/tokens.mjs [--runs] [--sessions] [--since YYYY-MM-DD]
//                           [--json] [--project <dir>]

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { projectRoot } from "./lib.mjs";

function die(msg) {
  process.stderr.write(`projectstore/tokens: ${msg}\n`);
  process.exit(1);
}

// Where a unit of work sits in the artifact lifecycle. Keyed by the bare agent
// or command name so plugin-prefixed and legacy (pre-v0.13) names both land.
const STAGE_OF = {
  // writing the artifact
  adr: "authoring", research: "authoring", epic: "authoring", story: "authoring",
  spec: "authoring", concept: "authoring", meeting: "authoring", runbook: "authoring",
  // checking the artifact — independent adversarial pass
  critic: "critique", "projectstore-critic": "critique", review: "critique",
  // planning the implementation, then checking the diff against the story
  planner: "planning", "code-planner": "planning",
  reviewer: "code-review", "code-reviewer": "code-review",
  // keeping the vault itself coherent
  librarian: "curation", archaeologist: "curation",
  clerk: "upkeep",
  doctor: "upkeep", kanban: "upkeep", reconcile: "upkeep", codemap: "upkeep",
  status: "upkeep", statusline: "upkeep", search: "upkeep", bind: "upkeep",
  scaffold: "upkeep", agents: "upkeep", tokens: "upkeep",
};
const STAGE_ORDER = ["authoring", "critique", "planning", "code-review", "curation", "upkeep", "other"];

// USD per MTok [input, output], API list prices as of 2026-08-04
// (platform.claude.com pricing docs). Cache multipliers applied on top of
// the input rate.
export const PRICING = {
  "claude-fable-5": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-sonnet-5": [2, 10], // intro pricing through 2026-08-31; sticker is [3, 15]
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

// Transcripts carry variant ids ("claude-haiku-4-5-20251001", "opus",
// "claude-opus-5[1m]") — normalize before the PRICING lookup so they don't
// silently price at $0.
const MODEL_ALIASES = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };

export function normModel(model) {
  const m = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return MODEL_ALIASES[m] || m;
}

export function rowCost(row) {
  const p = PRICING[normModel(row.model)];
  if (!p) return 0;
  const [inP, outP] = p;
  return (
    (row.input * inP + row.cw5m * 1.25 * inP + row.cw1h * 2 * inP + row.cacheRead * 0.1 * inP + row.output * outP) / 1e6
  );
}

// Claude Code stores transcripts under ~/.claude/projects/<slug>, where the
// slug is the project path with every non-alphanumeric char replaced by "-".
function transcriptDir(dir) {
  return join(homedir(), ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
}

function parseArgs(argv) {
  const opts = { json: false, sessions: false, runs: false, since: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--runs") opts.runs = true;
    else if (a === "--sessions") opts.sessions = true;
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--project") { opts.project = argv[++i]; if (!opts.project) die("--project expects a directory"); }
    else if (a === "--help" || a === "-h") opts.help = true;
    else die(`unknown argument: ${a}`);
  }
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) die("--since expects YYYY-MM-DD");
  return opts;
}

// One row per API request. Called for every assistant record; the first record
// for a requestId establishes the bucket and the input/cache figures, later
// records only raise output. Keyed globally: a request can legitimately appear
// in two files (e.g. a resumed session), and collapsing it is what we want.
export function ingest(rows, rec, meta) {
  const u = rec.message && rec.message.usage;
  if (!u) return;
  const id = rec.requestId;
  let row = rows.get(id);
  if (!row) {
    const cw = u.cache_creation_input_tokens || 0;
    const split = u.cache_creation || null;
    row = {
      ...meta,
      model: (rec.message && rec.message.model) || "unknown",
      ts: rec.timestamp || "",
      input: u.input_tokens || 0,
      cacheWrite: cw,
      // no split present → price the aggregate at the cheaper 5m tier
      cw5m: split ? split.ephemeral_5m_input_tokens || 0 : cw,
      cw1h: split ? split.ephemeral_1h_input_tokens || 0 : 0,
      cacheRead: u.cache_read_input_tokens || 0,
      output: 0,
      toolIds: new Set(),
    };
    rows.set(id, row);
  }
  row.output = Math.max(row.output, u.output_tokens || 0);
  // one record per content block → union the ids across the request's records
  for (const b of (rec.message && rec.message.content) || []) {
    if (b && b.type === "tool_use" && b.id) row.toolIds.add(b.id);
  }
}

// Strip the plugin prefix: "projectstore:critic" → "critic". Attribution and
// agentType both carry it; the lifecycle stage is keyed on the bare name.
const bare = (s) => (s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s);

function stageOf(row) {
  return (row.kind !== "main" && STAGE_OF[row.short]) || "other";
}

function eachRecord(file, fn) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // a transcript can vanish mid-run; best-effort by design
  }
  for (const line of raw.split("\n")) {
    // Cheap pre-filter: only assistant records carry requestId + usage.
    if (!line || line.indexOf('"requestId"') === -1) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "assistant" && rec.requestId) fn(rec);
  }
}

// Runs, not requests. For agents this is exact — one subagents/*.meta.json per
// spawn. For commands there is no start marker, so a run is counted as a
// contiguous stretch of one skill's requests inside a session (see below).
export function countCommandRuns(rows, calls) {
  const bySession = new Map();
  for (const row of rows.values()) {
    if (row.kind !== "cmd") continue;
    if (!bySession.has(row.session)) bySession.set(row.session, []);
    bySession.get(row.session).push(row);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    let prev = null;
    for (const row of list) {
      if (row.bucket !== prev) {
        const k = `${row.session}|${row.bucket}`;
        calls.set(k, (calls.get(k) || 0) + 1);
      }
      prev = row.bucket;
    }
  }
}

function collect(dir, since) {
  const rows = new Map();
  // "<session>|<bucket>" → runs. Keyed per session so the session table sums
  // only its own spawns; keying by bucket alone credited every session with
  // the GLOBAL run count of each bucket it touched (~72% inflation).
  const calls = new Map();
  const runLabels = new Set();
  const keep = (rec) => !since || !rec.timestamp || rec.timestamp.slice(0, 10) >= since;

  // Subagents FIRST: their attribution is exact, so if the same request also
  // shows up inline in a main transcript, the precise bucket wins the dedup.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subs = join(dir, entry.name, "subagents");
    if (!existsSync(subs)) continue;
    for (const f of readdirSync(subs)) {
      if (!f.endsWith(".meta.json")) continue;
      const jsonl = join(subs, f.replace(/\.meta\.json$/, ".jsonl"));
      if (!existsSync(jsonl)) continue;
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(subs, f), "utf8"));
      } catch {
        /* broken meta file should not drop real usage */
      }
      const agentType = meta.agentType || "unknown";
      const desc = meta.description || "";
      const bucket = `agent: ${agentType}`;
      let run = `${bare(agentType)}: ${desc || f.replace(/\.meta\.json$/, "")}`;
      // two spawns can share a description — disambiguate instead of merging
      while (runLabels.has(run)) run += " ²";
      runLabels.add(run);
      const callKey = `${entry.name}|${bucket}`; // per-session: the session table sums these
      let counted = false;
      eachRecord(jsonl, (rec) => {
        if (!keep(rec)) return;
        if (!counted) {
          calls.set(callKey, (calls.get(callKey) || 0) + 1); // one meta file = one spawn
          counted = true;
        }
        ingest(rows, rec, { bucket, kind: "agent", short: bare(agentType), session: entry.name, run });
      });
    }
  }

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const session = basename(f, ".jsonl");
    eachRecord(join(dir, f), (rec) => {
      if (!keep(rec)) return;
      // Older Claude Code versions inlined subagent turns into the main
      // transcript instead of a subagents/ file; mark them rather than
      // letting them masquerade as main-thread work.
      const bucket = rec.attributionSkill
        ? `cmd: ${rec.attributionSkill}`
        : rec.attributionPlugin
          ? `cmd: ${rec.attributionPlugin}`
          : rec.isSidechain
            ? "agent: (inline, untyped)"
            : "(main thread, unattributed)";
      const kind = rec.attributionSkill || rec.attributionPlugin ? "cmd" : rec.isSidechain ? "agent" : "main";
      const short = rec.attributionSkill ? bare(rec.attributionSkill) : "";
      ingest(rows, rec, { bucket, kind, short, session, run: "" });
    });
  }
  countCommandRuns(rows, calls);
  return { rows, calls };
}

function isProjectstore(row) {
  return row.kind !== "main" && /(^|[: ])projectstore/.test(row.bucket);
}

export function aggregate(rows, keyFn, calls) {
  const out = new Map();
  for (const row of rows.values()) {
    const k = keyFn(row);
    let g = out.get(k);
    if (!g) {
      g = { key: k, reqs: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, toolCalls: 0, toolTurns: 0, cost: 0, ps: isProjectstore(row), models: new Set(), buckets: new Set(), unpriced: new Set() };
      out.set(k, g);
    }
    g.reqs++;
    g.input += row.input;
    g.cacheWrite += row.cacheWrite;
    g.cacheRead += row.cacheRead;
    g.output += row.output;
    g.toolCalls += row.toolIds.size;
    if (row.toolIds.size > 0) g.toolTurns++;
    g.cost += rowCost(row);
    if (!PRICING[normModel(row.model)]) g.unpriced.add(row.model);
    g.models.add(row.model);
    g.buckets.add(`${row.session}|${row.bucket}`);
  }
  for (const g of out.values()) {
    g.runs = calls ? [...g.buckets].reduce((n, b) => n + (calls.get(b) || 0), 0) : 0;
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost);
}

const n = (v) => v.toLocaleString("en-US");

// `t/turn` — avg distinct tool calls per tool-using turn (batching level; 1.0
// means fully sequential). `cost` — USD at current list prices; cache reads
// bill at 0.1× input, so token counts and dollars rank differently.
const usd = (v) => `$${v.toFixed(2)}`;

function table(groups, label, { runs = false } = {}) {
  const w = Math.max(label.length, ...groups.map((g) => g.key.length));
  const cols = (a, b, c, d, e, f, g2, h) =>
    `${a.padEnd(w)}  ${b.padStart(5)}  ${c.padStart(6)}  ${d.padStart(6)}  ${e.padStart(13)}  ${f.padStart(10)}  ${g2.padStart(8)}${runs ? `  ${h.padStart(9)}` : ""}`;
  const head = cols(label, "runs", "reqs", "t/turn", "cache_rd", "output", "cost", "cost/run");
  const lines = [head, "─".repeat(head.length)];
  for (const g of groups) {
    lines.push(cols(
      g.key, g.runs ? n(g.runs) : "—", n(g.reqs),
      g.toolTurns ? (g.toolCalls / g.toolTurns).toFixed(2) : "—",
      n(g.cacheRead), n(g.output), usd(g.cost),
      g.runs ? usd(g.cost / g.runs) : "—",
    ));
  }
  return lines.join("\n");
}

function totals(groups) {
  const t = { reqs: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
  for (const g of groups) {
    t.reqs += g.reqs;
    t.input += g.input;
    t.cacheWrite += g.cacheWrite;
    t.cacheRead += g.cacheRead;
    t.output += g.output;
    t.cost += g.cost;
  }
  return t;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/tokens.mjs [--runs] [--sessions] [--since YYYY-MM-DD] [--json] [--project <dir>]\n",
    );
    return;
  }

  const dir = transcriptDir(opts.project || projectRoot());
  if (!existsSync(dir)) die(`no transcripts for this project (looked in ${dir})`);

  const { rows, calls } = collect(dir, opts.since);
  if (rows.size === 0) die(opts.since ? `no requests since ${opts.since}` : "no assistant requests found");

  const byBucket = aggregate(rows, (r) => r.bucket, calls);
  const byStage = aggregate([...rows.values()].filter(isProjectstore), stageOf, calls)
    .sort((a, b) => STAGE_ORDER.indexOf(a.key) - STAGE_ORDER.indexOf(b.key));
  const ps = byBucket.filter((g) => g.ps);
  const rest = byBucket.filter((g) => !g.ps);
  const psT = totals(ps);
  const restT = totals(rest);
  const allT = totals(byBucket);

  if (opts.json) {
    const shape = (g) => ({
      bucket: g.key,
      runs: g.runs || null,
      requests: g.reqs,
      tool_calls: g.toolCalls,
      tool_turns: g.toolTurns,
      input: g.input,
      cache_write: g.cacheWrite,
      cache_read: g.cacheRead,
      output: g.output,
      cost_usd: +g.cost.toFixed(4),
      models: [...g.models],
      ...(g.unpriced.size ? { unpriced_models: [...g.unpriced] } : {}),
    });
    process.stdout.write(
      JSON.stringify(
        {
          transcript_dir: dir,
          since: opts.since,
          sessions: new Set([...rows.values()].map((r) => r.session)).size,
          pricing_usd_per_mtok: PRICING,
          buckets: byBucket.map(shape),
          stages: byStage.map(shape),
          totals: Object.fromEntries(
            Object.entries({ projectstore: psT, other: restT, all: allT }).map(([k, t]) => [k, {
              requests: t.reqs, input: t.input, cache_write: t.cacheWrite,
              cache_read: t.cacheRead, output: t.output, cost_usd: +t.cost.toFixed(4),
            }]),
          ),
          ...(opts.runs ? { agent_runs: aggregate([...rows.values()].filter((r) => r.run), (r) => r.run).map(shape) } : {}),
          ...(opts.sessions ? { by_session: aggregate(rows, (r) => r.session, calls).map(shape) } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const sessions = new Set([...rows.values()].map((r) => r.session)).size;
  const out = [
    `projectstore token usage — ${n(rows.size)} requests across ${sessions} session(s)${opts.since ? `, since ${opts.since}` : ""}`,
    `source: ${dir}`,
    "",
    table(byBucket, "bucket", { runs: true }),
    "",
    "vault work by lifecycle stage:",
    table(byStage, "stage", { runs: true }),
    "",
    `vault work    ${n(psT.reqs).padStart(6)} reqs   cache_rd ${n(psT.cacheRead)}   out ${n(psT.output)}   cost ${usd(psT.cost)}`,
    `everything else${n(restT.reqs).padStart(5)} reqs   cache_rd ${n(restT.cacheRead)}   out ${n(restT.output)}   cost ${usd(restT.cost)}`,
  ];
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  out.push(
    "",
    `vault share:  requests ${pct(psT.reqs, allT.reqs)}   output ${pct(psT.output, allT.output)}   cost ${pct(psT.cost, allT.cost)} of ${usd(allT.cost)}`,
  );
  const unpriced = new Set(byBucket.flatMap((g) => [...g.unpriced]));
  if (unpriced.size) out.push(`⚠ unpriced models (cost counted as $0): ${[...unpriced].join(", ")}`);

  if (opts.runs) {
    out.push("", "per agent run:", table(aggregate([...rows.values()].filter((r) => r.run), (r) => r.run), "run"));
  }
  if (opts.sessions) {
    out.push("", table(aggregate(rows, (r) => r.session, calls), "session", { runs: true }));
  }
  process.stdout.write(out.join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// projectstore — flow-export.mjs: the `export` verb, the vault's flow as JSON.
//
// `export [--as-of <date|instant>] [--json]` prints the vault's stories,
// epics, status transitions and flow counts as one JSON envelope, so an
// outside tool (a site, a BI tool) gets doctor's numbers and never counts
// again. It counts nothing itself: the stories are flow-stories.mjs's, every
// count is flow-counts.mjs's, the transitions are the `status:` lines of each
// story's Status log as status-log.mjs's parseStatusLog reads them, and the
// limit rule is flow-policy.mjs's. No transition is inferred from git, dates
// or a board path, and nothing here reads git.
//
// The as-of instant is the clock, read once in runExport, or the caller's
// `--as-of`; it dates only the window and the epics without movement.
// Statuses, WIP, rows and transitions are the files as they are.
//
// Spec: "The export verb: stories, epics, status transitions and flow counts
// as one versioned JSON shape at one as-of instant" (alias `export`),
// contracts 1 to 11. No hook and no MCP module reaches this file, and it
// imports no writer (tests/flow-export.test.mjs holds both, and its source
// guard holds the one clock read and the counts' forms).
//
// runExport(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints the envelope. Loaded lazily.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadLayout, folderByKind, readVaultConfigStrict, nowIso } from "./lib.mjs";
import { readFlowStories, readFlowEpics } from "./flow-stories.mjs";
import {
  storyFacts,
  wipByPerson,
  windowOf,
  windowCounts,
  isYoung,
  shownWeeks,
  weeklyCounts,
  cycleTime,
  idleEpics,
} from "./flow-counts.mjs";
import { flowValue, flowProblems, wipLimitOf, isEmailAddress } from "./flow-policy.mjs";
import { parseStatusLog, logBullets, stampMs } from "./status-log.mjs";

// The result's own version (contract 3): it goes up by one when a consumer
// of the old version would misread the new one.
export const EXPORT_VERSION = 1;

// The layout a binding with none names: binding.mjs's DEFAULT_LAYOUT, which
// this module does not import, since binding.mjs is a writer
// (tests/flow-export.test.mjs holds the two equal).
export const DEFAULT_LAYOUT = "engineering";

export const EMAIL_SHAPED = "an email-shaped name";

export const AS_OF_USAGE =
  "--as-of takes a date (2026-11-16) or a date and time (2026-11-16T09:30, with Z or +02:00; none means UTC), in the years 0000 to 9999";

// The instants a time is printed for: 0000-01-01T00:00:00.000Z to
// 9999-12-31T23:59:59.999Z.
const MIN_MS = -62167219200000;
const MAX_MS = 253402300799999;
const inYears = (ms) => typeof ms === "number" && Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS;

// A time as the export prints it: canonical UTC, or null (contract 3).
const iso = (ms) => (inYears(ms) ? new Date(ms).toISOString() : null);
// A frontmatter value as written, null when absent or blank.
const text = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v));
// A frontmatter word trimmed and lower-cased, null when absent or blank.
const word = (v) => {
  const s = text(v);
  return s === null ? null : s.trim().toLowerCase();
};
const refOf = (f) => `${f.epic}/${f.slug}`;
// A person as the export names them: never an email-shaped word (contract 10).
const shown = (name) => (isEmailAddress(name) ? EMAIL_SHAPED : name);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isDirectory(p) {
  try {
    return Boolean(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Contract 4: story and epic rows ───────────────────────────────────

function storyRow(f) {
  return {
    ref: refOf(f),
    path: f.rel,
    id: text(f.fm?.id),
    epic: f.epic,
    title: text(f.fm?.title),
    status: f.status || null,
    column: f.column,
    priority: word(f.fm?.priority),
    assignee: f.assignee ? shown(f.assignee) : null,
    awaiting_close: f.awaiting,
    created: iso(f.created),
    started_at: iso(f.startedAt),
    closed_at: iso(f.closedAt),
    updated: iso(f.updatedAt),
    status_since: { at: iso(f.age.at), source: f.age.at === null ? null : f.age.source, trusted: f.age.trusted },
  };
}

function epicRow(e) {
  const fm = e.fm || {};
  return {
    epic: e.epic,
    path: e.rel,
    id: text(fm.id),
    title: text(fm.title),
    status: word(fm.status),
    priority: text(fm.priority),
    initiative: text(fm.initiative),
    created: iso(stampMs(fm.created)),
    updated: iso(stampMs(fm.updated)),
  };
}

// ─── Contracts 6 to 8: the counts, all flow-counts.mjs's ───────────────

function wipRows(facts, vaultCfg) {
  return [...wipByPerson(facts)]
    .map(([name, w]) => ({ name, held: w.held.length, awaiting: w.awaiting.length, limit: wipLimitOf(vaultCfg, name) }))
    .sort(byName)
    .map((r) => ({ assignee: shown(r.name), held: r.held, awaiting: r.awaiting, limit: r.limit }));
}

function windowOut(facts, vaultCfg, asOfMs) {
  const weeks = flowValue(vaultCfg, "window_weeks");
  if (weeks === null) return null;
  const win = windowOf(asOfMs, weeks);
  const total = windowCounts(facts, win);
  const young = isYoung(facts, win);
  const listed = shownWeeks(facts, win);
  let cycle = null;
  if (!young) {
    const c = cycleTime(total.closed);
    cycle = { closed: c.closed, median: c.median, days: c.days, unplaced: c.unplaced.map((f) => f.rel) };
  }
  return {
    weeks,
    from: iso(win.from),
    to: iso(win.to),
    created: total.created.length,
    closed: total.closed.length,
    closed_unstamped: total.closedUnstamped.length,
    young,
    weekly: weeklyCounts(facts, listed).map((w) => ({
      from: iso(w.from),
      created: w.created.length,
      closed: w.closed.length,
    })),
    omitted_weeks: listed.hidden,
    cycle_time: cycle,
  };
}

function idleOut(epics, facts, vaultCfg, asOfMs) {
  const days = flowValue(vaultCfg, "age_days.epic_idle");
  if (days === null) return null;
  const idle = idleEpics(epics, facts, days, asOfMs);
  return {
    threshold_days: days,
    watched: idle.watched,
    epics: idle.epics.map((e) => ({
      epic: e.epic,
      path: e.rel,
      days: e.days,
      last_change: { at: iso(e.age.at), source: e.age.source, field: e.age.field ?? null },
    })),
  };
}

// ─── Contract 9: notes ─────────────────────────────────────────────────

const NOTE_TEXT = Object.freeze({
  "vault-config-unread": (n) =>
    `${plural(n, "vault config file is", "vault config files are")} there but not a JSON object, so no flow policy applies and the window and the epics without movement are not counted.`,
  "flow-policy-invalid": (n) =>
    `${plural(n, "value", "values")} of the flow policy ${n === 1 ? "is" : "are"} not valid, so the counts ignore ${n === 1 ? "it" : "them"}; doctor names each one.`,
  "no-status-log": (n) =>
    `${plural(n, "story has", "stories have")} no status line in a Status log, so ${n === 1 ? "it has" : "they have"} no transitions: history from before stories carried a Status log is absent, not empty, and nothing is inferred from git or dates.`,
  "log-lines-unread": (n) =>
    `${plural(n, "line", "lines")} in the Status logs ${n === 1 ? "does" : "do"} not read as a log entry, so ${n === 1 ? "it gives" : "they give"} no transition.`,
  "email-shaped-assignee": (n) =>
    `${plural(n, "story row names", "story rows name")} an email-shaped assignee, printed as "${EMAIL_SHAPED}".`,
});

function notesOf(counts) {
  return Object.keys(NOTE_TEXT)
    .filter((code) => counts[code] > 0)
    .map((code) => ({ code, count: counts[code], text: NOTE_TEXT[code](counts[code]) }));
}

// ─── The result (contracts 3 to 10), pure ──────────────────────────────

// The result from what runExport read: the stories and epics as
// readFlowStories and readFlowEpics return them, their `unread` counts, the
// vault config (an object; {} when it did not read), whether a config file
// was there and did not read, and the as-of instant in epoch ms. Pure: no
// clock, no file. A story whose facts throw is counted unread and left out.
export function buildExport({ stories = [], epics = [], unread = {}, vaultCfg = {}, configUnread = false, asOfMs }) {
  const facts = [];
  let unreadStories = unread.stories ?? 0;
  for (const s of stories) {
    try {
      facts.push(storyFacts(s));
    } catch {
      unreadStories++;
    }
  }
  const rows = facts.map(storyRow);
  const transitions = [];
  let noLog = 0;
  let linesUnread = 0;
  for (const f of facts) {
    const entries = parseStatusLog(String(f.text ?? "")) || [];
    const status = entries.filter((e) => e.field === "status");
    if (!status.length) noLog++;
    linesUnread += (logBullets(String(f.text ?? "")) || []).length - entries.length;
    for (const e of status)
      transitions.push({
        ref: refOf(f),
        path: f.rel,
        at: iso(stampMs(e.at)),
        from: e.from,
        to: e.to,
        reason: e.reason,
        actor: e.actor,
      });
  }
  return {
    export_version: EXPORT_VERSION,
    as_of: iso(asOfMs),
    stories: rows,
    epics: epics.map(epicRow),
    transitions,
    counts: {
      wip: wipRows(facts, vaultCfg),
      window: windowOut(facts, vaultCfg, asOfMs),
      idle_epics: idleOut(epics, facts, vaultCfg, asOfMs),
    },
    unread: { stories: unreadStories, epics: unread.epics ?? 0 },
    notes: notesOf({
      "vault-config-unread": configUnread ? 1 : 0,
      "flow-policy-invalid": flowProblems(vaultCfg).length,
      "no-status-log": noLog,
      "log-lines-unread": linesUnread,
      "email-shaped-assignee": rows.filter((r) => r.assignee === EMAIL_SHAPED).length,
    }),
  };
}

// ─── Contracts 1 and 2: the run ────────────────────────────────────────

export async function runExport(ctx) {
  // now, read, load and build are the tests' seams; the bin never passes them.
  const {
    values = {},
    cfg = {},
    project,
    now: nowSeam = null,
    read = null,
    load = loadLayout,
    build = buildExport,
  } = ctx;
  let asOfMs;
  if (values["as-of"] !== undefined) {
    asOfMs = stampMs(String(values["as-of"]).trim());
    if (!inYears(asOfMs)) return { usage: AS_OF_USAGE };
  } else asOfMs = stampMs(nowSeam ?? nowIso());
  const fail = (message) => ({ ok: false, code: 1, result: { error: message }, text: `export: ${message}\n` });
  const raw = String(cfg.vault_path ?? "").trim();
  const vault = raw ? resolve(project, raw) : null;
  if (!isDirectory(vault))
    return fail(`the binding names no vault directory that is there (${cfg.vault_path ?? "none"})`);
  const name = cfg.layout || DEFAULT_LAYOUT;
  let epicsPath;
  try {
    epicsPath = folderByKind(load(name), "epic")?.path;
  } catch (e) {
    return fail(`layout ${name} does not load: ${e && e.message ? e.message : String(e)}`);
  }
  if (!epicsPath) return fail(`layout ${name} has no epic folder`);
  const seam = read ? { read } : {};
  let result;
  try {
    const got = readFlowStories(vault, epicsPath, seam);
    const er = readFlowEpics(vault, epicsPath, seam);
    const strict = readVaultConfigStrict(vault);
    result = build({
      stories: got.stories,
      epics: er.epics,
      unread: { stories: got.unread, epics: er.unread },
      vaultCfg: strict.corrupt ? {} : strict.cfg,
      configUnread: strict.corrupt,
      asOfMs,
    });
  } catch (e) {
    return fail(`the export could not be built: ${e && e.message ? e.message : String(e)}`);
  }
  return { ok: true, code: 0, result, text: "" };
}

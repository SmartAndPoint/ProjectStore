// Reports (the spec "The dashboard's Reports…", alias `dashboard-reports`).
//
// Two reads over the vault the page reads: flow() counts it with the core's
// own functions (flow-counts, flow-policy) and starts no process (contracts 1
// to 4 and 8); code() joins the board with the project's pull requests
// through the Code block's read, `survey` of lib/code.mjs, and names no call
// of its own (contracts 5 to 8).
//
// A number of an answer (a count, a share, a number of days) leaves as
// { value, by, basis }: `by` "core" when a core function gave it under the
// policy's threshold or none, "page" when a threshold of this page's own went
// into it; `basis` says which. The policy decides every threshold it has a
// key for, with no default here (SPEC-001, contract 4): a key that is absent
// gives no verdict, and the answer names it.

import { readFacts, readEpics, epicsPathOf, insideVault } from "./state.mjs";

// The page's own thresholds, only where the flow policy has no key (contracts 3 and 6).
export const OWN = Object.freeze({
  weeks: 4, // the length drawn when neither the address nor flow.window_weeks gives one: it judges nothing
  in_progress: 7, // days in In Progress: no key holds that age
  oldest: 5, // stories listed, with no verdict, for a key that is absent
  merged_open: 7,
  closed_unlinked: [20, 50],
  merged_unlinked: [25, 50],
  merge_to_close: [1, 3],
});
export const KEYS = Object.freeze(["asof", "weeks", "epic", "initiative", "assignee", "priority"]);
const COLUMNS = ["Backlog", "ToDo", "In Progress", "Review", "Done"];
const EMAIL_SHAPED = "an email-shaped name";
const ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const core = (value, basis) => ({ value, by: "core", basis });
const page = (value, basis) => ({ value, by: "page", basis });
const level = (pct, [warn, bad]) => (pct === null ? null : pct >= bad ? "bad" : pct >= warn ? "warn" : "ok");

// The query (contract 4): { query } or { error }. Nothing is read before it holds.
export function parseQuery(raw, ctx, { body = false } = {}) {
  const q = {};
  const no = (error) => ({ error });
  const get = (k) => (raw && Object.hasOwn(raw, k) ? raw[k] : null);
  for (const k of Object.keys(raw || {})) {
    if (k === "fresh" && body) {
      if (raw.fresh !== true && raw.fresh !== false) return no("fresh is true or false");
      continue;
    }
    if (!KEYS.includes(k)) return no(`${k} is not a filter of Reports (${KEYS.join(", ")})`);
    if (typeof raw[k] !== "string") return no(`${k} is given as text`);
    if (raw[k] === "") return no(`${k} is empty: leave it out for none`);
  }
  const asof = get("asof");
  if (asof !== null) {
    if (!ctx.lib.isCalendarDate(asof)) return no(`asof is a day, YYYY-MM-DD; ${JSON.stringify(asof)} is not one`);
    q.asof = asof;
  }
  const weeks = get("weeks");
  if (weeks !== null) {
    if (!/^[1-9]\d*$/.test(weeks) || Number(weeks) > 26) return no(`weeks is a whole number from 1 to 26; ${JSON.stringify(weeks)} is not one`);
    q.weeks = Number(weeks);
  }
  for (const k of ["epic", "initiative"]) {
    const v = get(k);
    if (v === null) continue;
    if (!(k === "initiative" && v === "none") && !ID.test(v)) return no(`${k} names an ${k} by its id; ${JSON.stringify(v)} is not one`);
    q[k] = v;
  }
  const who = get("assignee");
  if (who !== null) {
    if (who.length > 100 || CONTROL.test(who)) return no("assignee is one name on one line");
    if (ctx.flowPolicy.isEmailAddress(who)) return no("assignee cannot be an email address: the page reads no addresses");
    q.assignee = who;
  }
  const pri = get("priority");
  if (pri !== null) {
    if (!/^p[0-3]$/.test(pri)) return no(`priority is p0, p1, p2 or p3; ${JSON.stringify(pri)} is not one`);
    q.priority = pri;
  }
  return { query: q };
}

// No address reaches the page (contract 8): a name, or a word of a title, shaped like one is replaced.
let isEmail = () => false;
const shown = (who) => (who && isEmail(who) ? EMAIL_SHAPED : who);
export const maskWords = (text) =>
  String(text ?? "")
    .split(/(\s+)/)
    .map((w) => (isEmail(w) ? EMAIL_SHAPED : w))
    .join("");
const storyOf = (f, extra = {}) => ({ rel: f.rel, epic: f.epic, title: maskWords(f.fm?.title || f.rel.split("/").pop()), ...extra });

// What both reads share: the facts, the filter, the as-of and the window, from one clock reading.
function prepare(ctx, raw, nowMs, { body = false } = {}) {
  isEmail = ctx.flowPolicy.isEmailAddress;
  const p = parseQuery(raw, ctx, { body });
  if (p.error) return { status: 400, error: p.error };
  const q = p.query;
  const fc = ctx.flowCounts;
  // A .projectstore.json that is there but does not read is said, not taken for a policy with no keys.
  const strict = ctx.lib.readVaultConfigStrict(ctx.vault);
  const policy = strict.corrupt ? {} : strict.cfg;
  const asked = q.asof ? Date.parse(`${q.asof}T00:00:00Z`) : null;
  const asOf = asked !== null && asked < nowMs ? asked : nowMs;
  // Of today: no as-of, or one in the current ISO week (contract 3).
  const today = asked === null || fc.weekStart(asOf) === fc.weekStart(nowMs);
  const fromPolicy = ctx.flowPolicy.flowValue(policy, "window_weeks");
  const weeks = q.weeks ? { value: q.weeks, from: "address" } : fromPolicy ? { value: fromPolicy, from: "policy" } : { value: OWN.weeks, from: "page" };
  const epics = readEpics(ctx);
  const initiativeOf = new Map(epics.map((e) => [e.id, e.initiative]));
  const inInitiative = (epic) => !q.initiative || (q.initiative === "none" ? !initiativeOf.get(epic) : initiativeOf.get(epic) === q.initiative);
  const { facts: all, unread } = readFacts(ctx);
  const priorityOf = (f) => (/^p[0-3]$/.test(f.fm?.priority || "") ? f.fm.priority : "p2");
  const facts = all.filter((f) => (!q.epic || f.epic === q.epic) && inInitiative(f.epic) && (!q.assignee || f.assignee === q.assignee) && (!q.priority || priorityOf(f) === q.priority));
  const win = fc.windowOf(asOf, weeks.value);
  const filtered = Object.keys(q).some((k) => k !== "asof" && k !== "weeks");
  return { q, fc, policy, policyUnread: strict.corrupt, nowMs, asOf, today, weeks, all, unread, facts, win, inInitiative, filtered };
}

// ── the flow read (contracts 1 to 4) ──

// What stands still, and who holds what, at the moment of the read (contract 3).
function ofToday(ctx, P) {
  const { fc, policy, nowMs, all, facts, q } = P;
  const key = (k) => ctx.flowPolicy.flowValue(policy, k);
  // A key that is absent, and the configure form that sets it (the core's flowForm).
  const form = (k) => ctx.flowPolicy.flowForm(k);
  const marks = (a, col) => ({
    untrusted: core(a.untrusted.length, `agedIn over ${col}: ages read from a date that is not a status stamp`),
    undated: core(a.undated.length, `agedIn over ${col}: stories with no date to read an age from`),
  });
  const aged = (f) => storyOf(f, { days: core(f.days, "agedIn, whole days in the column") });
  const out = { columns: [], epics: null, people: [], peopleWhole: false, verdicts: null };
  for (const [id, col] of [
    ["review", "Review"],
    ["todo", "ToDo"],
  ]) {
    const name = `flow.age_days.${id}`;
    const days = key(`age_days.${id}`);
    if (days === null) {
      const a = fc.agedIn(facts, col, 0, nowMs);
      out.columns.push({ id, column: col, unset: name, form: form(name), count: null, stories: a.aged.slice(0, OWN.oldest).map(aged), ...marks(a, col) });
    } else {
      const a = fc.agedIn(facts, col, days, nowMs);
      out.columns.push({ id, column: col, unset: null, threshold: core(days, name), count: core(a.aged.length, `agedIn over ${col}, ${name} = ${days}`), stories: a.aged.map(aged), ...marks(a, col) });
    }
  }
  const ip = fc.agedIn(facts, "In Progress", OWN.in_progress, nowMs);
  out.columns.push({ id: "in_progress", column: "In Progress", unset: null, threshold: page(OWN.in_progress, "this page's own: no key of the policy holds the days in In Progress"), count: page(ip.aged.length, `agedIn over In Progress, this page's own ${OWN.in_progress} days`), stories: ip.aged.map(aged), ...marks(ip, "In Progress") });
  // Epics without movement: each judged over all its stories; only epic and initiative narrow the list.
  const epicsPath = epicsPathOf(ctx);
  if (epicsPath) {
    const idleKey = key("age_days.epic_idle");
    const flowEpics = ctx.flowStories.readFlowEpics(ctx.vault, epicsPath).epics.filter((e) => insideVault(ctx, e.rel) && (!q.epic || e.epic === q.epic) && P.inInitiative(e.epic));
    const idle = fc.idleEpics(flowEpics, all, idleKey ?? 0, nowMs);
    const row = (e) => ({ rel: e.rel, epic: e.epic, title: maskWords(e.fm?.title || e.epic), days: core(e.days, "idleEpics, whole days since the last change") });
    out.epics =
      idleKey === null
        ? { unset: "flow.age_days.epic_idle", form: form("flow.age_days.epic_idle"), watched: core(idle.watched, "idleEpics, epics In Progress"), count: null, epics: idle.epics.slice(0, OWN.oldest).map(row) }
        : { unset: null, threshold: core(idleKey, "flow.age_days.epic_idle"), watched: core(idle.watched, "idleEpics, epics In Progress"), count: core(idle.epics.length, `idleEpics, flow.age_days.epic_idle = ${idleKey}`), epics: idle.epics.map(row), narrowed: Boolean(q.assignee || q.priority) };
  }
  // WIP: every story of the person, whatever the filter; with `assignee`, that person only (contract 4).
  for (const [who, held] of fc.wipByPerson(all)) {
    if (q.assignee && who !== q.assignee) continue;
    const limit = ctx.flowPolicy.wipLimitOf(policy, who);
    out.people.push({ name: shown(who), wip: core(held.held.length, "wipByPerson, every story of the person"), awaiting: core(held.awaiting.length, "wipByPerson, waiting to close"), limit: limit === null ? null : core(limit, "wipLimitOf, flow.people"), over: limit !== null && held.held.length > limit });
  }
  out.people.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.peopleWhole = Boolean(q.epic || q.initiative || q.priority);
  // Arrivals over closes and ToDo against capacity, as doctor judges them: the whole vault, the policy's window as of now.
  const W = key("window_weeks");
  if (P.filtered) out.verdicts = { left: "doctor's verdicts are for the whole vault: shown with no filter" };
  else if (W === null) out.verdicts = { unset: "flow.window_weeks", form: form("flow.window_weeks") };
  else {
    const pwin = fc.windowOf(nowMs, W);
    const counts = fc.windowCounts(all, pwin);
    const young = fc.isYoung(all, pwin);
    const basis = `windowCounts over flow.window_weeks = ${W}, as of now`;
    out.verdicts = { weeks: core(W, "flow.window_weeks"), from: iso(pwin.from), to: iso(pwin.to), young, created: core(counts.created.length, basis), closed: core(counts.closed.length, basis), intakeOverClose: young ? null : counts.created.length > counts.closed.length, capacity: null };
    const bounds = key("capacity_weeks");
    if (bounds === null) out.verdicts.capacity = { unset: "flow.capacity_weeks", form: form("flow.capacity_weeks") };
    else if (!young) {
      const v = fc.capacityVerdict({ todo: all.filter((f) => f.column === "ToDo").length, closed: counts.closed.length, weeks: W, bounds });
      out.verdicts.capacity = { verdict: v.verdict, bounds: bounds.map((b) => core(b, "flow.capacity_weeks")), throughput: core(Math.round(v.throughput * 100) / 100, "capacityVerdict, closed a week") };
    }
  }
  return out;
}

export function flow(ctx, raw, { now = Date.now() } = {}) {
  const P = prepare(ctx, raw, now);
  if (P.status) return P;
  const { fc, policy, asOf, today, weeks, facts, win } = P;
  const counts = fc.windowCounts(facts, win);
  const prevWin = fc.windowOf(win.from, weeks.value);
  const prev = fc.windowCounts(facts, prevWin);
  const young = fc.isYoung(P.all, win);
  const listed = fc.shownWeeks(facts, win);
  // No cycle time while the vault is young, as export gives none (contract 2).
  const cyc = young ? null : fc.cycleTime(counts.closed);
  // The weeks shownWeeks lists (at most MAX_WEEKS of them); the row of the columns now, of today only, at the read.
  const cf = fc.cumulativeFlow(facts, listed, today ? P.nowMs : asOf, COLUMNS);
  const rows = (today ? cf.rows : cf.rows.slice(0, -1)).map((r) => ({ at: iso(r.at), now: r.from === null, counts: Object.fromEntries([...r.counts].map(([c, n]) => [c, core(n, "cumulativeFlow")])) }));
  const result = {
    asOf: iso(asOf),
    today,
    weeks,
    query: Object.fromEntries(Object.entries(P.q).map(([k, v]) => [k, String(v)])), // as the address spells it
    young: core(young, "isYoung, over the whole vault"),
    policyUnread: P.policyUnread,
    unread: core(P.unread, "readFlowStories, story files that could not be read"),
    policyProblems: core(ctx.flowPolicy.flowProblems(policy).length, "flowProblems, keys of the flow policy set wrong"),
    window: {
      from: iso(win.from),
      to: iso(win.to),
      created: core(counts.created.length, "windowCounts"),
      closed: core(counts.closed.length, "windowCounts"),
      closedUnstamped: core(counts.closedUnstamped.length, "windowCounts, Done with no closed_at"),
      cycle: core(cyc ? cyc.median : null, cyc ? "cycleTime, median in whole days" : "cycleTime: none while the vault is young"),
      placed: core(cyc ? cyc.days.length : null, "cycleTime, closed stories with a start"),
      unplaced: cyc ? cyc.unplaced.map((f) => storyOf(f)) : [],
    },
    previous: { young: fc.isYoung(P.all, prevWin), created: core(prev.created.length, "windowCounts, the window before"), closed: core(prev.closed.length, "windowCounts, the window before") },
    weekly: fc.weeklyCounts(facts, listed).map((w) => ({
      from: iso(w.from),
      created: core(w.created.length, "weeklyCounts"),
      closed: core(w.closed.length, "weeklyCounts"),
      cycle: core(young ? null : fc.cycleTime(w.closed).median, "cycleTime of the week"),
    })),
    hiddenWeeks: core(listed.hidden, "shownWeeks, the earliest weeks its cap leaves out"),
    flow: { rows, approximate: core(cf.approximate.length, "cumulativeFlow, placed from their dates") },
    standing: today ? ofToday(ctx, P) : null, // contract 3
    ofToday: today ? null : "What stands still, who holds what, arrivals and capacity are of today, and not shown for a day in the past.",
  };
  return { status: 200, result };
}

// ── the code read (contracts 5 to 8) ──

export async function code(ctx, raw, { survey, now = Date.now(), fresh = false } = {}) {
  const P = prepare(ctx, raw, now, { body: true });
  if (P.status) return P;
  const { fc, facts, win, nowMs, today } = P;
  const s = await survey(ctx, { stories: facts.map((f) => ({ rel: f.rel, text: f.text, fm: f.fm || {} })), fresh });
  const result = { main: s.main, repo: s.repo, listFull: s.listFull, unknown: { ...s.unknown }, checks: [], openLeft: today ? null : "Open stories are checked as of today, and not for a day in the past." };
  if (s.unknown.prs) return { status: 200, result };
  const https = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
  const tie = (t) => ({ number: t.number, title: t.title === null ? null : maskWords(t.title), url: https(t.url), how: t.how, link: t.link, mergedAt: t.mergedAt });
  const ties = (f) => (s.ties.get(f.rel) || []).filter((t) => t.how.some((h) => h !== "derived")); // a tie from commits alone is neither (contract 6)
  const notListed = facts.flatMap((f) => ties(f).filter((t) => t.how.includes("recorded") && t.state === null).map((t) => storyOf(f, { number: t.number })));
  if (notListed.length) result.unknown.recorded = notListed;
  // What the read could not see makes every check it touches uncertain: none answers "none" (contract 7).
  const doubt = [
    result.unknown.git && `the default branch is not known (${result.unknown.git}), so every Closes-story line is a lead`,
    !result.unknown.git && s.main?.short === "HEAD" && "the default branch is not known (no origin/HEAD, origin/main or origin/master), so every Closes-story line is a lead",
    s.listFull && "the list holds the newest 1,000 pull requests by creation, so one created earlier and merged in the window is missed",
    notListed.length && `${notListed.length} recorded pull request${notListed.length === 1 ? " is" : "s are"} not in the list`,
  ].filter(Boolean);
  const push = (c) => result.checks.push({ ...c, unknown: doubt.length ? doubt.join("; ") : null });
  const merged = (t) => t.state === "merged" && t.mergedAt;
  const newest = (ts) => ts.reduce((m, t) => Math.max(m, Date.parse(t.mergedAt)), -Infinity);
  // Open with a merged pull request, of today: all its counted links merged, else all its leads (contract 6).
  if (today) {
    const due = (ts) => ts.length > 0 && ts.every(merged) && newest(ts) <= nowMs - OWN.merged_open * DAY_MS;
    const counted = [];
    const leads = [];
    for (const f of facts.filter((x) => x.column !== null && x.column !== "Done")) {
      const links = ties(f).filter((t) => t.link);
      const rest = ties(f).filter((t) => !t.link);
      if (links.length) {
        if (due(links)) counted.push(storyOf(f, { prs: links.map(tie) }));
      } else if (due(rest)) leads.push(storyOf(f, { prs: rest.map(tie) }));
    }
    push({ id: "merged_open", label: "Open, with its pull requests merged", value: page(counted.length + leads.length, `the newest merged at least ${OWN.merged_open} days ago, this page's own`), counted, leads });
  }
  // Closed in the window with no counted link.
  const closed = fc.windowCounts(facts, win).closed;
  const unlinked = closed.filter((f) => !ties(f).some((t) => t.link));
  const pct = (n, d) => (d ? Math.floor((n * 100) / d) : null);
  const share = pct(unlinked.length, closed.length);
  push({ id: "closed_unlinked", label: "Closed with no counted link", value: page(share, closed.length ? `${unlinked.length} of ${closed.length} closed; this page's own ${OWN.closed_unlinked.join("% and ")}%` : "no story closed in the window"), level: level(share, OWN.closed_unlinked), stories: unlinked.map((f) => storyOf(f, { leads: ties(f).map(tie) })) });
  // From the newest counted merge to the close: whole days, signed, cut toward zero; a close before it is marked.
  const gaps = closed
    .map((f) => {
      const links = ties(f).filter((t) => t.link && merged(t));
      if (!links.length || f.closedAt === null) return null;
      const last = newest(links);
      return storyOf(f, { days: page(Math.trunc((f.closedAt - last) / DAY_MS), "whole days from the newest counted merge to closed_at, signed"), early: f.closedAt < last });
    })
    .filter(Boolean);
  const late = gaps.filter((g) => g.days.value > OWN.merge_to_close[0]);
  push({ id: "merge_to_close", label: "From the last merge to the close", value: page(late.length, `stories closed more than ${OWN.merge_to_close[0]} day after their newest counted merge; this page's own ${OWN.merge_to_close.join(" and ")} days`), level: gaps.some((g) => g.days.value > OWN.merge_to_close[1]) ? "bad" : late.length ? "warn" : "ok", stories: gaps });
  // Pull requests merged in the window with no counted link to any story: only with no filter.
  if (!P.filtered) {
    const linked = new Set(facts.flatMap((f) => ties(f).filter((t) => t.link).map((t) => t.number)));
    const inWin = s.prs.filter((p) => merged(p) && Date.parse(p.mergedAt) >= win.from && Date.parse(p.mergedAt) < win.to);
    const lone = inWin.filter((p) => !linked.has(p.number));
    const lshare = pct(lone.length, inWin.length);
    push({ id: "merged_unlinked", label: "Merged with no counted link to a story", value: page(lshare, inWin.length ? `${lone.length} of ${inWin.length} merged; this page's own ${OWN.merged_unlinked.join("% and ")}%` : "no pull request merged in the window"), level: level(lshare, OWN.merged_unlinked), prs: lone.map((p) => ({ number: p.number, title: maskWords(p.title), url: https(p.url), mergedAt: p.mergedAt })) });
  }
  return { status: 200, result };
}

export function openReports({ code: codeRead, now = () => Date.now() } = {}) {
  return {
    flow: (ctx, query) => flow(ctx, query, { now: now() }),
    code: (ctx, query, { fresh = false } = {}) => code(ctx, query, { survey: codeRead.survey, now: now(), fresh }),
  };
}

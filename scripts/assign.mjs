// projectstore — assign.mjs: the `assign` verb, who holds one story in ToDo,
// or no one before work starts.
//
// `assign <EPIC>/<story> <name> --reason "<why>"` names the holder of a story
// in ToDo; `assign <EPIC>/<story> --clear --reason "<why>"` empties the
// assignee of a story in the Backlog or ToDo. Bare, it prints the plan and
// writes nothing; with --write (a terminal is asked once; without one, or
// under --json, --write is the confirmation) it writes the story through the
// shared assignee writer (status-change.mjs changeAssignee: re-read before the
// replace, at most three attempts) with the actor `assign`, leaving `updated`
// and the "Last updated" line as they were, then refreshes the derived views
// through the core, as `move` does. An agent (flow-policy.mjs isAgentName) at
// or over its WIP limit is refused; a person there is warned and assigned.
//
// Spec: "The assign verb: who holds a story in ToDo, an agent within its WIP
// limit, and an assignee cleared before work starts" (alias `assign`),
// contracts 1 to 5. No hook and no MCP module reaches this file
// (tests/assign.test.mjs holds it).
//
// runAssign(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { statSync } from "node:fs";
import { join } from "node:path";
import { packageCommand, shellQuote } from "./harness.mjs";
import { loadLayout, folderByKind, readVaultConfig, fromTerminalIn, nowIso } from "./lib.mjs";
import { normaliseVaultPath, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { STATUS_COLUMNS, storyState } from "./stages.mjs";
import { oneLine, logLine } from "./status-log.mjs";
import { changeAssignee, CHANGED_MEANWHILE } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { storyFacts } from "./flow-counts.mjs";
import { leftDateOf, refusedName, isAgentName, isEmailAddress } from "./flow-policy.mjs";
import { personWip } from "./next.mjs";
import { resolveStory } from "./move.mjs";

export const ACTOR = "assign";

const titleOf = (f) => (f.fm?.title === null || f.fm?.title === undefined ? null : String(f.fm.title));
const errMsg = (e) => (e && e.message ? e.message : String(e));
const assigneeOf = (fm) => (fm?.assignee === null || fm?.assignee === undefined ? "" : String(fm.assignee).trim());
// An assignee as a message names them: `none` for no one, and never an email address.
const holder = (name) => (!name ? "none" : isEmailAddress(name) ? "an email-shaped name" : name);

function isDirectory(p) {
  try {
    return typeof p === "string" && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Where a story stands for this verb (contract 2): "done" or "set-aside" by
// storyState first, then its board column by the status table's own keys,
// else "unknown" (an empty status, a typo), which no column names.
export function placeOf(status) {
  const state = storyState(status);
  if (state !== "open") return state;
  const s = String(status ?? "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(STATUS_COLUMNS, s) ? STATUS_COLUMNS[s] : "unknown";
}

// Contract 2: the refusal for a story in `place`, or null. `ref` names it.
export function placeRefusal({ ref, place, status, clear }) {
  const shown = status ? String(status) : "no status";
  if (place === "done" || place === "set-aside")
    return `${ref} is ${shown}, ${place === "done" ? "closed" : "set aside"}: assign writes only a story in the Backlog or ToDo`;
  if (place === "In Progress" || place === "Review")
    return `${ref} is ${shown}, work that has started: give it to another person with handover`;
  if (place === "unknown")
    return `${ref} has ${status ? `the status ${shown}` : "no status"}, which no board column names: assign writes only a story in the Backlog or ToDo`;
  if (!clear && place === "Backlog")
    return `${ref} is ${shown}, in the Backlog: assign names a holder only in ToDo; put it there first with move ${ref} todo`;
  return null;
}

// Contract 4: the load a name carries against its limit, its stories in In
// Progress and Review as `next` counts them (awaiting close not counted) and
// its stories in ToDo. Returns null with no limit, or {assignee, held,
// queued, load, limit, over, agent}; an agent over is refused, a person warned.
export function wipOf(facts, vaultCfg, name) {
  const w = personWip(facts, vaultCfg, name);
  if (w.limit === null) return null;
  const held = w.held.length;
  const queued = facts.filter((f) => f.column === "ToDo" && f.assignee === name).length;
  const load = held + queued;
  return { assignee: name, held, queued, load, limit: w.limit, over: load >= w.limit, agent: isAgentName(name) };
}

const loadText = (wip) =>
  `${wip.assignee} holds ${wip.load} (${wip.held} in In Progress and Review, ${wip.queued} in ToDo)`;
const agentRefusal = (wip) =>
  `${loadText(wip)} and its WIP limit is ${wip.limit}: an agent is given no work past its limit`;

const unreadText = (unread) =>
  `${unread} story ${unread === 1 ? "file or folder" : "files or folders"} could not be read, so the count can be short`;

// The plan, as a pure function of the story's fact, all the facts, the vault
// config, the run and the number of story files that could not be read.
// Returns {refused, wip} or {same, from, to, wip, notes}; `wip` is the load
// whenever a limit was read, on a refusal too (contract 5).
export function planAssign({ fact, facts, vaultCfg, to, clear, unread = 0 }) {
  const ref = `${fact.epic}/${fact.slug}`;
  const refused = placeRefusal({ ref, place: placeOf(fact.fm?.status), status: fact.fm?.status, clear });
  if (refused) return { refused, wip: null };
  const from = assigneeOf(fact.fm);
  if (clear) return { same: !from, from, to: "", wip: null, notes: [] };
  const left = leftDateOf(vaultCfg, to);
  if (left !== null)
    return {
      refused: `${to} is marked left (flow.people[${to}].left is ${left}), so the story cannot go to them; name someone who has not left`,
      wip: null,
    };
  if (from === to) return { same: true, from, to, wip: null, notes: [] };
  const wip = wipOf(facts, vaultCfg, to);
  if (wip && wip.over && wip.agent) return { refused: agentRefusal(wip), wip };
  // A short count cannot hold a hard limit: an agent with a limit is refused (contract 4).
  if (wip && wip.agent && unread > 0)
    return { refused: `${unreadText(unread)}: an agent's limit is not checked on a short count`, wip };
  const notes = [];
  if (unread > 0) notes.push({ id: "unread", message: `${unreadText(unread)}.` });
  if (!wip && isAgentName(to))
    notes.push({
      id: "agent-no-limit",
      message: `${to} has no WIP limit in flow.people, so no load is checked; set one with configure.`,
    });
  const assigned = new Set(facts.map((f) => f.assignee));
  const people = vaultCfg && typeof vaultCfg === "object" ? vaultCfg.flow?.people : undefined;
  const listed = people !== null && typeof people === "object" && Object.hasOwn(people, to);
  if (!assigned.has(to) && !listed)
    notes.push({
      id: "person-unseen",
      message: `${to}: no story names them as assignee and flow.people does not list them; check the spelling.`,
    });
  return { same: false, from, to, wip, notes };
}

const wipWarning = (wip) =>
  wip && wip.over && !wip.agent
    ? `${loadText(wip)}, at or over their WIP limit of ${wip.limit}. The write still goes.`
    : null;

function rerunCommand(run) {
  const who = run.clear ? "--clear" : shellQuote(run.to);
  return packageCommand([], "assign", {
    args: `${shellQuote(run.story)} ${who} --reason ${shellQuote(run.reason)} --write`,
  });
}

export function renderPlan(run, plan, { project = null, asking = false } = {}) {
  const lines = [];
  if (plan.same)
    lines.push(
      run.clear
        ? `${run.story} has no assignee: nothing to write.`
        : `${run.story} is already assigned to ${run.to}: nothing to write.`,
    );
  else {
    lines.push(
      run.clear
        ? `Clear the assignee of ${run.story}${run.title ? ` — ${run.title}` : ""}:`
        : `Assign ${run.story}${run.title ? ` — ${run.title}` : ""} to ${run.to}:`,
    );
    lines.push(
      `  ${logLine({ at: run.at, field: "assignee", from: plan.from, to: plan.to, reason: run.reason, actor: ACTOR })}`,
    );
  }
  const warn = wipWarning(plan.wip);
  if (warn) lines.push("", warn);
  for (const n of plan.notes) lines.push("", `Note (${n.id}): ${n.message}`);
  if (!plan.same)
    lines.push(
      "",
      "Writes the story's assignee, its header's Assignee row and one Status log line, then the derived views. No status, date or review mark changes.",
    );
  else lines.push("", "No story is written. With --write, the derived views are refreshed.");
  if (!asking)
    lines.push(
      "",
      `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      "",
      `  ${rerunCommand(run)}`,
    );
  return lines.join("\n") + "\n";
}

export async function runAssign(ctx) {
  // afterCompute(attempt), now, read and beforeWrite are the tests' seams; the bin never passes them.
  const {
    values,
    positionals = [],
    cfg,
    project,
    env,
    confirm,
    ownEnv,
    afterCompute = null,
    now = null,
    read = null,
    beforeWrite = null,
  } = ctx;
  const [storyArg, nameArg, extra] = positionals;
  const clear = values.clear === true;
  if (!storyArg)
    return {
      usage:
        'assign takes a story and a name, such as `assign PS-CORE/story-x agent:claude --reason "next up"`, or a story and --clear',
    };
  if (extra !== undefined) return { usage: "assign takes one story and one name; quote a name that holds spaces" };
  if (clear && nameArg !== undefined)
    return { usage: "--clear takes no name: give a name to assign, or --clear to empty it" };
  if (!clear && nameArg === undefined) return { usage: "assign needs a name after the story, or --clear" };
  if (values.reason === undefined || values.reason === true)
    return { usage: 'assign needs --reason "<why>": one line on why the story is held by this name' };
  let reason;
  try {
    reason = oneLine(values.reason, "--reason");
  } catch (e) {
    return { usage: e.message };
  }
  let to = "";
  if (!clear) {
    to = String(nameArg).trim();
    const why = refusedName(to);
    if (why)
      return {
        usage: `the name ${why === "empty" ? "is empty" : why}: a name is the assignee as stories write it, not empty, with no @ and no control character`,
      };
  }
  const run = {
    story: String(storyArg),
    to,
    clear,
    reason,
    title: null,
    at: now || nowIso(),
    write: Boolean(values.write),
  };
  const result = (more = {}) => ({
    write: run.write,
    story: run.story,
    from: null,
    to: clear ? null : run.to,
    reason: run.reason,
    clear,
    line: null,
    wip: null,
    unread: 0,
    notes: [],
    reconcile: null,
    declined: false,
    error: null,
    ...more,
  });
  const fail = (message, more = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...more, error: message }),
    text: `assign: ${message}\n`,
  });

  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  let epics;
  try {
    epics = folderByKind(loadLayout(cfg.layout || DEFAULT_LAYOUT), "epic");
  } catch (e) {
    return fail(errMsg(e));
  }
  if (!epics) return fail(`layout ${cfg.layout} has no epic folder`);
  const found = resolveStory(run.story, { vault, epicsPath: epics.path });
  if (found.error) return fail(found.error);
  let unread = 0;
  const readFacts = () => {
    const stories = readFlowStories(vault, epics.path, read ? { read } : {});
    unread = stories.unread;
    return stories.stories.map(storyFacts);
  };
  let facts = readFacts();
  const vaultCfg = readVaultConfig(vault);
  const fact = facts.find((x) => join(vault, x.rel) === found.path);
  if (!fact) return fail(`${found.ref} could not be read`, { unread });
  run.story = `${fact.epic}/${fact.slug}`;
  run.title = titleOf(fact);
  const plan = planAssign({ fact, facts, vaultCfg, to: run.to, clear, unread });
  if (plan.refused) return fail(plan.refused, { from: assigneeOf(fact.fm), wip: plan.wip, unread });
  const base = { from: plan.from, wip: plan.wip, unread, notes: plan.notes };
  const planLine = plan.same
    ? null
    : logLine({ at: run.at, field: "assignee", from: plan.from, to: plan.to, reason: run.reason, actor: ACTOR });
  if (!run.write)
    return { ok: true, code: 0, result: result({ ...base, line: planLine }), text: renderPlan(run, plan, { project }) };

  if (!plan.same && confirm && !(await confirm(renderPlan(run, plan, { asking: true }))))
    return {
      ok: false,
      code: 1,
      result: result({ ...base, declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };

  let written = { line: null };
  if (!plan.same) {
    // Contract 4: the count again, after the question and before the write.
    if (beforeWrite) await beforeWrite();
    if (!clear) {
      facts = readFacts();
      const wip = wipOf(facts, readVaultConfig(vault), run.to);
      if (wip && wip.over && wip.agent) return fail(agentRefusal(wip), { ...base, wip, unread });
      if (wip && wip.agent && unread > 0)
        return fail(`${unreadText(unread)}: an agent's limit is not checked on a short count`, {
          ...base,
          wip,
          unread,
        });
      base.wip = wip;
      base.unread = unread;
    }
    // Contract 3: each attempt judges contract 2 on the fresh bytes.
    const allow = (fm) =>
      placeRefusal({ ref: run.story, place: placeOf(fm.status), status: fm.status, clear }) ||
      (assigneeOf(fm) !== plan.from && assigneeOf(fm) !== run.to
        ? `${run.story} is now assigned to ${holder(assigneeOf(fm))}, not to ${holder(plan.from)}; it is left as it is`
        : null);
    const r = changeAssignee(found.path, {
      to: run.to,
      reason: run.reason,
      actor: ACTOR,
      at: run.at,
      lang: cfg.language || DEFAULT_LANGUAGE,
      allow,
      touch: false,
      afterCompute,
      onWrite: nodeWriteRecorder({ env, project, tool: ACTOR }),
    });
    if (r.refused) return fail(r.refused, base);
    if (r.error)
      return fail(
        r.error === CHANGED_MEANWHILE
          ? `${CHANGED_MEANWHILE}: ${run.story} changed before each of ${r.attempts} attempts; the file is left as the last edit made it`
          : r.error,
        base,
      );
    written = r;
  }

  // The derived views, also when nothing was written: a second run finishes what a failed first one left.
  const { refreshViews } = await import("./reconcile.mjs");
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  const done = result({ ...base, line: written.line, reconcile: rec.summary });
  const lines = [];
  // Nothing to write, by the plan or because another writer made the same change meanwhile.
  if (plan.same || !written.line)
    lines.push(
      clear
        ? `${run.story} has no assignee: no line written.`
        : `${run.story} is already assigned to ${run.to}: no line written.`,
    );
  else
    lines.push(
      clear ? `Cleared the assignee of ${run.story}` : `Assigned ${run.story} to ${run.to}`,
      `  ${written.line}`,
    );
  const warn = wipWarning(base.wip);
  if (warn) lines.push(`  ${warn}`);
  for (const n of plan.notes) lines.push(`  note (${n.id}): ${n.message}`);
  lines.push(`  derived views: ${rec.summary?.written ?? 0} regenerated`);
  const text = lines.join("\n") + "\n";
  if (rec.failed) {
    const what = `the derived views${rec.error ? ` (${rec.error})` : ""}`;
    return {
      ok: false,
      code: 1,
      result: { ...done, error: `left: ${what}` },
      text: `${text}assign: ${plan.same ? "" : "the story was written, but "}${what} are left. Run the same assign again ${fromTerminalIn(project)}:\n${rerunCommand(run)}\n`,
    };
  }
  return { ok: true, code: 0, result: done, text };
}

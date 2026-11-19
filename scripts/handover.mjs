// projectstore — handover.mjs: the `handover` verb, a leaving assignee's open
// stories to another person, with a logged reason.
//
// `handover --from <name> --to <name> --reason "<why>" [--story <EPIC>/<id>]`
// gives one person's open work (Flow counts, contract 8) to another. Bare, it
// prints the plan and writes nothing; with --write (a terminal is asked once
// for the whole run; without one, or under --json, --write is the
// confirmation) it writes each story through the shared assignee writer
// (status-change.mjs changeAssignee: re-read before the replace, at most three
// attempts) with the actor `handover`, then refreshes the derived views with a
// bare reconcile --write through the core, as `move` does. No status changes
// and no stamp moves. The plan warns when the receiver would go over their WIP
// limit, counted as `next` counts it (next.mjs personWip).
//
// Spec: "The handover verb: a leaving assignee's open stories move to another
// person with a logged reason" (alias `handover`), contracts 1 to 5. No hook
// and no MCP module reaches this file (tests/handover.test.mjs holds it).
//
// runHandover(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { statSync } from "node:fs";
import { join } from "node:path";
import { packageCommand, shellQuote } from "./harness.mjs";
import { loadLayout, folderByKind, readVaultConfig, fromTerminalIn, nowIso } from "./lib.mjs";
import { normaliseVaultPath, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { storyState } from "./stages.mjs";
import { oneLine, logLine } from "./status-log.mjs";
import { changeAssignee, CHANGED_MEANWHILE } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { storyFacts, wipByPerson, openStoriesOf } from "./flow-counts.mjs";
import { leftDateOf, refusedName, wipLimitOf, isEmailAddress } from "./flow-policy.mjs";
import { personWip } from "./next.mjs";
import { resolveStory } from "./move.mjs";

export const ACTOR = "handover";

const refOf = (f) => `${f.epic}/${f.slug}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titleOf = (f) => (f.fm?.title === null || f.fm?.title === undefined ? null : String(f.fm.title));
const errMsg = (e) => (e && e.message ? e.message : String(e));

// An assignee as a refusal names them: `none` for no one, and never an
// email address.
const holder = (name) => (!name ? "none" : isEmailAddress(name) ? "an email-shaped name" : name);

// The reason as the Status log holds it.
export const logReason = (reason) => `handover: ${reason}`;

function isDirectory(p) {
  try {
    return typeof p === "string" && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A name option, trimmed: {name} or {usage}. The message names the option,
// never its value (contract 1).
function nameOption(values, option, what) {
  const raw = values[option];
  if (raw === undefined || raw === true)
    return { usage: `handover needs --${option} <name>: ${what}, as stories write the assignee` };
  const name = String(raw).trim();
  const why = refusedName(name);
  if (why)
    return {
      usage: `--${option} ${why}: a name is the assignee as stories write it, not empty, with no @ and no control character`,
    };
  return { name };
}

// The plan, as a pure function of the stories' facts, the vault config, the
// two people and the one story --story resolved to (a fact, or null).
// Returns {refused} or {items, same, wip, notes}: `items` are facts, oldest
// first; `same` is a --story already assigned to --to.
export function planHandover({ facts, vaultCfg, from, to, only = null, unread = 0 }) {
  const left = leftDateOf(vaultCfg, to);
  if (left !== null)
    return {
      refused: `--to ${to} is marked left (flow.people[${to}].left is ${left}), so the work cannot go to them; name someone who has not left`,
    };
  let items;
  let same = false;
  if (only) {
    if (only.assignee === to) {
      same = true;
      items = [];
    } else if (only.assignee !== from)
      return { refused: `${refOf(only)} is assigned to ${holder(only.assignee)}, not to ${from}` };
    else if (storyState(only.fm?.status) !== "open")
      return {
        refused: `${refOf(only)} is ${only.status || "done"}, not open work: handover moves only stories that are neither done nor set aside`,
      };
    else items = [only];
  } else items = openStoriesOf(facts, from);

  // Contract 4: the receiver's WIP, as `next` counts it.
  let wip = null;
  const limit = wipLimitOf(vaultCfg, to);
  if (limit !== null) {
    const held = personWip(facts, vaultCfg, to).held.length;
    const fromHeld = new Set((wipByPerson(facts).get(from)?.held || []).map((f) => f.rel));
    const moving = items.filter((f) => fromHeld.has(f.rel)).length;
    const after = held + moving;
    wip = { assignee: to, held, moving, after, limit, over: after > limit };
  }

  const notes = [];
  if (unread > 0)
    notes.push({
      id: "unread",
      message: `${plural(unread, "story file or folder", "story files or folders")} could not be read, so the list can be short.`,
    });
  const assigned = new Set(facts.map((f) => f.assignee));
  const people = vaultCfg && typeof vaultCfg === "object" ? vaultCfg.flow?.people : undefined;
  const listed = (name) => people !== null && typeof people === "object" && Object.hasOwn(people, name);
  for (const [option, name] of [
    ["--from", from],
    ["--to", to],
  ])
    if (!assigned.has(name) && !listed(name))
      notes.push({
        id: "person-unseen",
        message: `${option} ${name}: no story names them as assignee and flow.people does not list them; check the spelling.`,
      });
  return { items, same, wip, notes };
}

const wipLine = (wip) => (wip && wip.over ? `${wip.assignee} would hold ${wip.after}/${wip.limit}` : null);

function rerunCommand(run) {
  const story = run.story ? ` --story ${shellQuote(run.story)}` : "";
  return packageCommand([], "handover", {
    args: `--from ${shellQuote(run.from)} --to ${shellQuote(run.to)} --reason ${shellQuote(run.reason)}${story} --write`,
  });
}

// The plan's text, or the question's preview (`asking`): each story with the
// line it would write, the WIP warning and the notes; bare, `Nothing written`
// and the --write form alone on its line.
export function renderPlan(run, plan, { project = null, asking = false } = {}) {
  const lines = [];
  if (plan.same) lines.push(`${run.story} is already assigned to ${run.to}: nothing to write.`);
  else if (!plan.items.length) lines.push(`${run.from} holds no open story: nothing to hand over.`);
  else {
    lines.push(`Hand over ${plural(plan.items.length, "story", "stories")} from ${run.from} to ${run.to}:`);
    for (const f of plan.items) {
      const title = titleOf(f);
      lines.push(`  ${refOf(f)}${title ? ` — ${title}` : ""} (${f.status || "no status"})`);
      lines.push(
        `    ${logLine({ at: run.at, field: "assignee", from: f.assignee, to: run.to, reason: logReason(run.reason), actor: ACTOR })}`,
      );
    }
  }
  const warn = wipLine(plan.wip);
  if (warn) lines.push("", `${warn}: over their WIP limit. The write still goes.`);
  for (const n of plan.notes) lines.push("", `Note (${n.id}): ${n.message}`);
  if (plan.items.length)
    lines.push(
      "",
      "Writes each story's assignee, its header's Assignee row and one Status log line, then the derived views. No status changes.",
    );
  else lines.push("", "No story is written. With --write, the derived views are refreshed.");
  // Also with nothing to write, as move's `same`: the --write run refreshes the views.
  if (!asking)
    lines.push(
      "",
      `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      "",
      `  ${rerunCommand(run)}`,
    );
  return lines.join("\n") + "\n";
}

function renderDone(run, plan, items, reconcile) {
  const lines = [];
  const written = items.filter((i) => i.written).length;
  if (plan.same) lines.push(`${run.story} is already assigned to ${run.to}: no line written.`);
  else if (!items.length) lines.push(`${run.from} holds no open story: nothing handed over.`);
  else {
    lines.push(
      `Handed over ${written} of ${plural(items.length, "story", "stories")} from ${run.from} to ${run.to} — ${logReason(run.reason)} (${ACTOR})`,
    );
    for (const i of items) lines.push(`  ${i.story}: ${i.written ? "written" : `not written (${i.error})`}`);
  }
  const warn = wipLine(plan.wip);
  if (warn) lines.push(`  ${warn}: over their WIP limit`);
  for (const n of plan.notes) lines.push(`  note (${n.id}): ${n.message}`);
  if (reconcile) lines.push(`  derived views: ${reconcile.written ?? 0} regenerated`);
  return lines.join("\n") + "\n";
}

export async function runHandover(ctx) {
  // afterCompute(attempt, story), now and read are the tests' seams; the bin
  // never passes them.
  const { values, cfg, project, env, confirm, ownEnv, afterCompute = null, now = null, read = null } = ctx;
  if (values.reason === undefined || values.reason === true)
    return { usage: 'handover needs --reason "<why>": one line on why the work changes hands' };
  let reason;
  try {
    reason = oneLine(values.reason, "--reason");
  } catch (e) {
    return { usage: e.message };
  }
  const f = nameOption(values, "from", "the person whose open stories move");
  if (f.usage) return { usage: f.usage };
  const t = nameOption(values, "to", "the person who takes them");
  if (t.usage) return { usage: t.usage };
  if (f.name === t.name) return { usage: "--from and --to name the same person: handover needs two people" };
  const run = {
    from: f.name,
    to: t.name,
    reason,
    story: values.story === undefined ? null : String(values.story),
    at: now || nowIso(),
    write: Boolean(values.write),
  };
  const result = (extra = {}) => ({
    write: run.write,
    from: run.from,
    to: run.to,
    reason: run.reason,
    story: run.story,
    items: [],
    wip: null,
    unread: 0,
    notes: [],
    reconcile: null,
    declined: false,
    error: null,
    ...extra,
  });
  const fail = (message, extra = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra, error: message }),
    text: `handover: ${message}\n`,
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
  const stories = readFlowStories(vault, epics.path, read ? { read } : {});
  const facts = stories.stories.map(storyFacts);
  const vaultCfg = readVaultConfig(vault);

  let only = null;
  if (run.story !== null && leftDateOf(vaultCfg, run.to) === null) {
    const found = resolveStory(run.story, { vault, epicsPath: epics.path });
    if (found.error) return fail(found.error, { unread: stories.unread });
    only = facts.find((x) => join(vault, x.rel) === found.path) || null;
    if (!only) return fail(`${found.ref} could not be read`, { unread: stories.unread });
  }
  const plan = planHandover({ facts, vaultCfg, from: run.from, to: run.to, only, unread: stories.unread });
  if (plan.refused) return fail(plan.refused, { unread: stories.unread });

  const itemOf = (x, extra = {}) => ({
    story: refOf(x),
    path: x.rel,
    title: titleOf(x),
    status: x.status || null,
    from: x.assignee,
    to: run.to,
    line: null,
    at: run.at,
    written: false,
    error: null,
    ...extra,
  });
  const base = { wip: plan.wip, unread: stories.unread, notes: plan.notes };
  if (!run.write)
    return {
      ok: true,
      code: 0,
      result: result({ ...base, items: plan.items.map((x) => itemOf(x)) }),
      text: renderPlan(run, plan, { project }),
    };

  if (plan.items.length && confirm && !(await confirm(renderPlan(run, plan, { asking: true }), plan.items.length)))
    return {
      ok: false,
      code: 1,
      result: result({ ...base, items: plan.items.map((x) => itemOf(x)), declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };

  // Each write lands in this session's record of its vault writes (the record
  // spec, contract 5), with the tool `handover`.
  const onWrite = nodeWriteRecorder({ env, project, tool: ACTOR });
  const lang = cfg.language || DEFAULT_LANGUAGE;
  const items = [];
  for (const x of plan.items) {
    const ref = refOf(x);
    // Every attempt judges the story again on the fresh bytes: one no longer
    // assigned to --from is left as it is; one already assigned to --to is
    // nothing to write, no error.
    const allow = (fm) => {
      const now = fm.assignee === null || fm.assignee === undefined ? "" : String(fm.assignee).trim();
      return now === run.from || now === run.to
        ? null
        : `${ref} is now assigned to ${holder(now)}, not to ${run.from}; it is left as it is`;
    };
    const r = changeAssignee(join(vault, x.rel), {
      to: run.to,
      reason: logReason(run.reason),
      actor: ACTOR,
      at: run.at,
      lang,
      allow,
      afterCompute: afterCompute ? (i) => afterCompute(i, ref) : null,
      onWrite,
    });
    const error = r.refused
      ? r.refused
      : r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${ref} changed before each of ${r.attempts} attempts; the file is left as the last edit made it`
        : r.error;
    items.push(itemOf(x, { line: r.line, written: r.written, error: error ?? null }));
  }

  // The derived views, once, also when no story was written: a second run
  // finishes what a failed first one left.
  const { refreshViews } = await import("./reconcile.mjs");
  // The generators find the binding through the project's own environment,
  // never through the caller's working directory.
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  const done = result({ ...base, items, reconcile: rec.summary });
  const text = renderDone(run, plan, items, rec.summary);
  const failed = items.filter((i) => i.error);
  if (rec.failed) {
    const what = `the derived views${rec.error ? ` (${rec.error})` : ""}`;
    return {
      ok: false,
      code: 1,
      result: { ...done, error: `left: ${what}` },
      text: `${text}handover: ${items.some((i) => i.written) ? "the stories were written, but " : ""}${what} are left. Run the same handover again ${fromTerminalIn(project)}:\n${rerunCommand(run)}\n`,
    };
  }
  if (failed.length)
    return {
      ok: false,
      code: 1,
      result: { ...done, error: `${plural(failed.length, "story", "stories")} not handed over` },
      text: `${text}handover: ${plural(failed.length, "story", "stories")} not handed over; the others were written.\n`,
    };
  return { ok: true, code: 0, result: done, text };
}

// projectstore — groom.mjs: the `groom` verb, the weekly grooming pass.
//
// `groom [--write]` sends every ToDo story whose age in status meets
// `flow.age_days.todo` back to `planned`, with a logged reason, lists the
// one-story epics and the active epics against `flow.active_epics_max`, and
// stamps the pass in `flow.groomed_at`. Bare, it prints the plan and writes
// nothing; with --write (a terminal is asked once for the whole run; without
// one, or under --json, --write is the confirmation) it writes each story
// through the shared status writer (status-change.mjs changeStatus: re-read
// before the replace, at most three attempts) with the actor `groom`, then
// the stamp through the vault-config writer, read again just before, then
// refreshes the derived views once with a bare reconcile --write through the
// core, as `move` does. It never merges, moves or edits an epic beyond the
// Stories row of a story it moves: the command (/projectstore:groom) hands the
// one-story epics to the librarian, which only proposes.
//
// Spec: "The groom verb: stale ToDo goes back to the backlog, the pass is
// stamped, and one-story epics go to the librarian" (alias `groom`),
// contracts 1 to 5 and 8; the stale set is Flow counts contract 3 (agedIn),
// the epics its contract 9 (epicCounts). No hook and no MCP module reaches
// this file (tests/groom.test.mjs holds it).
//
// runGroom(ctx) follows move's contract: it returns {ok, code, result, text},
// and the bin (cli.mjs) prints and asks. Loaded lazily.

import { statSync } from "node:fs";
import { join } from "node:path";
import { packageCommand, shellQuote } from "./harness.mjs";
import {
  loadLayout,
  folderByKind,
  readVaultConfigStrict,
  nextVaultConfig,
  writeVaultConfig,
  fromTerminalIn,
  commandForm,
  nowIso,
} from "./lib.mjs";
import { normaliseVaultPath, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { logLine, stampMs } from "./status-log.mjs";
import { changeStatus, CHANGED_MEANWHILE } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { readFlowStories, readFlowEpics } from "./flow-stories.mjs";
import { storyFacts, agedIn, epicCounts } from "./flow-counts.mjs";
import { flowValue, flowDeclared } from "./flow-policy.mjs";

export const ACTOR = "groom";
const TO = "planned";

const refOf = (f) => `${f.epic}/${f.slug}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titleOf = (fm) => (fm?.title === null || fm?.title === undefined ? null : String(fm.title));
const statusOf = (fm) => (fm?.status === null || fm?.status === undefined ? "" : String(fm.status).trim());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The policy is not set (contract 1): no `flow`, `null`, empty, or holding
// only the stamp. The message names the configure form, never a value.
const POLICY_UNSET =
  "the vault's flow policy is not set, so there is nothing to groom. Each key is set with configure, in the form configure --set flow.<key>=<value>";

// The reason as the Status log holds it: the age, and where it was read
// from when the status stamp is not trusted (the maintainer, 2026-11-15).
export function groomReason(days, source) {
  const from = source === "updated" || source === "created" ? ` (age read from ${source})` : "";
  return `groomed: in ToDo for ${days} days${from}`;
}

function isDirectory(p) {
  try {
    return typeof p === "string" && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// `flow` as a writer may read it: absent or null is fine, anything that is
// not an object is refused (contract 1).
const flowRefused = (cfg) => Object.hasOwn(cfg, "flow") && cfg.flow !== null && !isPlainObject(cfg.flow);

// The plan, as a pure function of the stories' facts, the epics, the vault
// config and the run's as-of instant (epoch ms). Returns {days, items, notes,
// epics}: `items` are facts with `days`, oldest first.
export function planGroom({ facts, epics, vaultCfg, asOf, unread = 0 }) {
  const notes = [];
  const days = flowValue(vaultCfg, "age_days.todo");
  let items = [];
  if (days === null)
    notes.push({
      id: "todo-age-unset",
      message:
        "flow.age_days.todo is not set, so no story moves back to the backlog. It is set with configure, in the form configure --set flow.age_days.todo=<days>.",
    });
  else {
    const t = agedIn(facts, "ToDo", days, asOf);
    items = t.aged;
    for (const f of t.undated)
      notes.push({
        id: "undated",
        message: `${refOf(f)} is in ToDo with no status stamp, no updated and no created, so its age is unknown and it is not moved.`,
      });
  }
  if (unread > 0)
    notes.push({
      id: "unread",
      message: `${plural(unread, "story or epic file or folder", "story or epic files or folders")} could not be read, so the list can be short.`,
    });
  const counts = epicCounts(epics, facts);
  const epicOf = (e) => ({ epic: e.epic, path: e.rel, title: titleOf(e.fm), status: statusOf(e.fm) || null });
  const cap = flowValue(vaultCfg, "active_epics_max");
  return {
    days,
    items,
    notes,
    epics: {
      single_story: counts.singleStory.map((e) => ({
        ...epicOf(e),
        story: { ref: refOf(e.story), status: e.story.status || null },
      })),
      active: {
        epics: counts.active.map(epicOf),
        count: counts.active.length,
        cap,
        over: cap !== null && counts.active.length > cap,
      },
    },
  };
}

const rerunCommand = () => packageCommand([], "groom", { args: "--write" });

function epicLines(epics) {
  const lines = [];
  if (epics.single_story.length) {
    lines.push(`One-story epics (${epics.single_story.length}):`);
    for (const e of epics.single_story)
      lines.push(`  ${e.epic}${e.title ? ` — ${e.title}` : ""}: ${e.story.ref} (${e.story.status || "no status"})`);
  } else lines.push("No one-story epic.");
  const a = epics.active;
  lines.push(
    a.cap === null
      ? `${a.count} active epics, no cap set.`
      : `${a.count} active epics, cap ${a.cap}${a.over ? `: over the cap by ${a.count - a.cap}` : ""}.`,
  );
  return lines;
}

// The plan's text, or the question's preview (`asking`): each story with the
// line it would write, the epics and the notes; bare, `Nothing written`, the
// --write form alone on its line, and what the command adds.
export function renderPlan(run, plan, { project = null, asking = false, env = process.env } = {}) {
  const lines = [];
  if (plan.days === null) lines.push("No story moves: flow.age_days.todo is not set.");
  else if (!plan.items.length) lines.push(`No ToDo story is at or past flow.age_days.todo of ${plan.days}.`);
  else {
    lines.push(
      `Back to the backlog: ${plural(plan.items.length, "story", "stories")} in ToDo at or past flow.age_days.todo of ${plan.days}:`,
    );
    for (const f of plan.items) {
      const title = titleOf(f.fm);
      lines.push(`  ${refOf(f)}${title ? ` — ${title}` : ""} (${f.status}, ${plural(f.days, "day")})`);
      lines.push(
        `    ${logLine({ at: run.at, field: "status", from: statusOf(f.fm), to: TO, reason: groomReason(f.days, f.age.source), actor: ACTOR })}`,
      );
    }
  }
  lines.push("", ...epicLines(plan.epics));
  for (const n of plan.notes) lines.push("", `Note (${n.id}): ${n.message}`);
  lines.push(
    "",
    `Writes each story's status, its stamp, its header's Status row, one Status log line and its epic's Stories row, then flow.groomed_at (${run.at.slice(0, 10)}), also with no story to move, then the derived views. No epic is merged or moved.`,
  );
  if (!asking)
    lines.push(
      "",
      `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      "",
      `  ${rerunCommand()}`,
      "",
      `In an agent session, ${commandForm("groom", { env })} also hands the one-story epics to the librarian, which proposes merges.`,
    );
  return lines.join("\n") + "\n";
}

function renderDone(run, plan, items, stamp, reconcile) {
  const lines = [];
  const written = items.filter((i) => i.written).length;
  if (!items.length) lines.push("No story moved back to the backlog.");
  else {
    lines.push(`Moved ${written} of ${plural(items.length, "story", "stories")} back to the backlog (${ACTOR}):`);
    for (const i of items) {
      if (i.written) lines.push(`  ${i.story}: ${i.line}`);
      if (i.error) lines.push(`  ${i.story}: ${i.written ? "" : "not written: "}${i.error}`);
      else if (!i.written) lines.push(`  ${i.story}: left as it is`);
    }
  }
  lines.push(...epicLines(plan.epics));
  for (const n of run.notes) lines.push(`  note (${n.id}): ${n.message}`);
  lines.push(stamp.written ? `flow.groomed_at: ${stamp.after}` : "flow.groomed_at: not written");
  if (reconcile) lines.push(`derived views: ${reconcile.written ?? 0} regenerated`);
  return lines.join("\n") + "\n";
}

export async function runGroom(ctx) {
  // afterCompute(attempt, story), beforeStamp(), now and read are the tests'
  // seams; the bin never passes them.
  const {
    values,
    cfg,
    project,
    env,
    confirm,
    ownEnv,
    afterCompute = null,
    beforeStamp = null,
    now = null,
    read = null,
  } = ctx;
  const run = { at: now || nowIso(), write: Boolean(values.write), notes: [] };
  const asOf = stampMs(run.at);
  const emptyEpics = { single_story: [], active: { epics: [], count: 0, cap: null, over: false } };
  const result = (extra = {}) => ({
    write: run.write,
    at: run.at,
    items: [],
    epics: emptyEpics,
    stamp: { before: null, after: null, written: false },
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
    text: `groom: ${message}\n`,
  });

  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  // Contract 1: the strict read; a corrupt config is never an empty one.
  const strict = readVaultConfigStrict(vault);
  if (strict.corrupt)
    return fail(`${strict.path} is not a JSON object, so no flow policy can be read from it; fix the file first`);
  const vaultCfg = strict.cfg;
  if (flowRefused(vaultCfg))
    return fail(
      `flow in ${strict.path} is not an object, so no flow policy can be read from it; fix or remove it first`,
    );
  if (!flowDeclared(vaultCfg)) return fail(POLICY_UNSET);

  let epicsFolder;
  try {
    epicsFolder = folderByKind(loadLayout(cfg.layout || DEFAULT_LAYOUT), "epic");
  } catch (e) {
    return fail(errMsg(e));
  }
  if (!epicsFolder) return fail(`layout ${cfg.layout} has no epic folder`);
  const seam = read ? { read } : {};
  const stories = readFlowStories(vault, epicsFolder.path, seam);
  const epicsRead = readFlowEpics(vault, epicsFolder.path, seam);
  const facts = stories.stories.map(storyFacts);
  const unread = stories.unread + epicsRead.unread;
  const plan = planGroom({ facts, epics: epicsRead.epics, vaultCfg, asOf, unread });
  run.notes = [...plan.notes];
  const raw = vaultCfg.flow?.groomed_at;
  const before = raw === undefined || raw === null ? null : raw;

  const itemOf = (f, extra = {}) => {
    const reason = groomReason(f.days, f.age.source);
    return {
      story: refOf(f),
      path: f.rel,
      title: titleOf(f.fm),
      status: f.status || null,
      age_days: f.days,
      age_from: f.age.source,
      from: statusOf(f.fm),
      to: TO,
      reason,
      line: null,
      at: run.at,
      written: false,
      error: null,
      epic: null,
      ...extra,
    };
  };
  const base = { epics: plan.epics, unread, stamp: { before, after: null, written: false } };
  if (!run.write)
    return {
      ok: true,
      code: 0,
      result: result({ ...base, items: plan.items.map((f) => itemOf(f)), notes: run.notes }),
      text: renderPlan(run, plan, { project, env }),
    };

  // One question for the whole run: the stories plus the stamp.
  if (confirm && !(await confirm(renderPlan(run, plan, { asking: true }), plan.items.length + 1)))
    return {
      ok: false,
      code: 1,
      result: result({
        ...base,
        items: plan.items.map((f) => itemOf(f)),
        notes: run.notes,
        declined: true,
        error: "declined",
      }),
      text: "Nothing written.\n",
    };

  // Each write lands in this session's record of its vault writes (the record
  // spec, contract 5), with the tool `groom`: the stories, their epics' rows
  // and the stamp.
  const onWrite = nodeWriteRecorder({ env, project, tool: ACTOR });
  const lang = cfg.language || DEFAULT_LANGUAGE;
  const items = [];
  for (const f of plan.items) {
    const ref = refOf(f);
    const item = itemOf(f);
    // Every attempt judges the story again on the fresh bytes, at the run's
    // instant: one no longer in the stale set (moved out of ToDo, already
    // planned, or in ToDo again with a fresh stamp or a young `updated`) is
    // left as it is, with a note and no error (contract 3).
    let nowStatus = null;
    const allow = (fm, text) => {
      const fresh = storyFacts({ rel: f.rel, epic: f.epic, slug: f.slug, text, fm });
      if (agedIn([fresh], "ToDo", plan.days, asOf).aged.length) return null;
      nowStatus = statusOf(fm) || "no status";
      return `${ref} left the stale ToDo set meanwhile`;
    };
    const r = changeStatus(join(vault, f.rel), {
      to: TO,
      reason: item.reason,
      actor: ACTOR,
      at: run.at,
      lang,
      allow,
      afterCompute: afterCompute ? (i) => afterCompute(i, ref) : null,
      onWrite,
    });
    if (r.refused) {
      run.notes.push({
        id: "left-todo",
        message: `${ref} is ${nowStatus} now, no longer a stale ToDo story, so it is left as it is.`,
      });
      items.push(item);
      continue;
    }
    let error =
      r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${ref} changed before each of ${r.attempts} attempts; the file is left as the last edit made it`
        : r.error;
    // A story written whose epic row is left: a second groom no longer sees
    // the story as stale, so the command that mends the row is given.
    if (!error && r.written && r.epic && r.epic.error) {
      const cmd = packageCommand([], "move", { args: `${ref} ${TO} --reason ${shellQuote(item.reason)} --write` });
      error = `${ref} is ${TO}, but its row in its epic's Stories table was not written (${r.epic.error}). The row is mended by a move, ${fromTerminalIn(project)}:\n${cmd}`;
    }
    items.push({ ...item, line: r.line, written: r.written, error: error ?? null, epic: r.epic });
  }

  // Contract 4: the stamp, after the moves, on a fresh strict read.
  const stamp = { before, after: null, written: false };
  let stampLeft = null;
  let unset = false;
  if (beforeStamp) await beforeStamp();
  const fresh = readVaultConfigStrict(vault);
  if (fresh.corrupt) stampLeft = `${fresh.path} stopped being a JSON object after the plan`;
  else if (flowRefused(fresh.cfg)) stampLeft = `flow in ${fresh.path} stopped being an object after the plan`;
  else if (!flowDeclared(fresh.cfg)) unset = true;
  else
    try {
      writeVaultConfig(vault, nextVaultConfig(fresh.cfg, { flow: { groomed_at: run.at } }, run.at), { onWrite });
      stamp.after = run.at;
      stamp.written = true;
    } catch (e) {
      stampLeft = errMsg(e);
    }

  // The derived views, once, also when no story was written and when the
  // stamp is left: a second run finishes what a failed first one left.
  const { refreshViews } = await import("./reconcile.mjs");
  // The generators find the binding through the project's own environment,
  // never through the caller's working directory.
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  const done = result({ ...base, items, notes: run.notes, stamp, reconcile: rec.summary });
  let text = renderDone(run, plan, items, stamp, rec.summary);
  const failed = items.filter((i) => i.error);
  const errors = [];
  const left = [];
  if (unset) {
    errors.push(POLICY_UNSET);
    text += `groom: flow.groomed_at is not written: ${POLICY_UNSET}.\n`;
  }
  if (stampLeft) left.push(`the stamp flow.groomed_at (${stampLeft})`);
  if (rec.failed) left.push(`the derived views${rec.error ? ` (${rec.error})` : ""}`);
  if (left.length) {
    errors.push(`left: ${left.join("; ")}`);
    text += `groom: ${items.some((i) => i.written) ? "the stories were written, but " : ""}${left.join(" and ")} ${left.length === 1 ? "is" : "are"} left. Run the same groom again ${fromTerminalIn(project)}:\n${rerunCommand()}\n`;
  }
  if (failed.length) {
    errors.push(`${plural(failed.length, "story", "stories")} not moved`);
    text += `groom: ${plural(failed.length, "story", "stories")} not moved; the others were written.\n`;
  }
  if (errors.length) return { ok: false, code: 1, result: { ...done, error: errors[0] }, text };
  return { ok: true, code: 0, result: done, text };
}

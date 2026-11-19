// projectstore — next.mjs: the `next` verb, what a person does next.
//
// `next [--assignee <name>] [--json]` lists the person's started work first
// (In Progress, then Review, then awaiting close, each oldest in status
// first), then new work from ToDo only while the person holds less than
// their WIP limit, and with an empty ToDo the top planned stories, each with
// the `move` that puts it in ToDo. It writes nothing: no vault file and no
// file under `.projectstore/`. The plan gate (story-section.mjs plan) counts
// the same WIP for the story's new assignee through wipOnStart, below.
//
// The rules are not restated here: the stories read, a status's column, age
// in status, awaiting close and WIP per person are Flow counts' (flow-
// stories.mjs, flow-counts.mjs), and the limit rule is SPEC-001 contract 4's
// (flow-policy.mjs wipLimitOf). This module adds the order and the rows.
//
// Spec: "The next verb: started work first, new work only under the WIP
// limit, and the plan gate's question before going over" (alias `next`),
// contracts 1 to 5. No hook and no MCP module reaches this file, and it
// imports no writer (tests/next.test.mjs holds both).
//
// runNext(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints. Loaded lazily.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { packageCommand } from "./harness.mjs";
import { loadLayout, folderByKind, readVaultConfig, fromTerminalIn, nowIso } from "./lib.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { storyFacts, wipByPerson, oldestFirst, ageDays } from "./flow-counts.mjs";
import { wipLimitOf, flowDeclared, flowPeople } from "./flow-policy.mjs";

// At most this many planned stories are offered when ToDo is empty (contract 4).
export const PLANNED_MAX = 5;
export const MOVE_REASON = "next up";

const refOf = (f) => `${f.epic}/${f.slug}`;

function isDirectory(p) {
  try {
    return Boolean(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A priority read trimmed and lower-cased: `p` and digits ranks by its
// number, lower first; any other value, a missing one included, is `p2`, as
// the board reads a missing priority (contract 3).
export function priorityOf(raw) {
  const p = String(raw ?? "")
    .trim()
    .toLowerCase();
  const m = /^p(\d+)$/.exec(p);
  return m ? { priority: p, rank: Number(m[1]) } : { priority: "p2", rank: 2 };
}

// By priority, then oldest in status first, ties by vault path.
export function byPriority(facts) {
  const rank = (f) => priorityOf(f.fm?.priority).rank;
  return oldestFirst(facts).sort((a, b) => rank(a) - rank(b));
}

// Why a person has no WIP limit, in the plan gate's wording; null with one.
export function noLimitWhy(vaultCfg, name) {
  if (wipLimitOf(vaultCfg, name) !== null) return null;
  if (!flowDeclared(vaultCfg)) return "the vault has no flow block, so the person has no WIP limit";
  if (!flowPeople(vaultCfg).has(name))
    return `${name} is not in the vault's flow.people, so the person has no WIP limit`;
  return `${name} has no wip and no flow.wip for their time, so the person has no WIP limit`;
}

// A person's WIP over the stories' facts: the held stories and those
// awaiting close (Flow counts, contract 5), and the limit (SPEC-001 contract
// 4). The name matches exactly, through a Map, so `constructor` and
// `__proto__` are names like any other.
export function personWip(facts, vaultCfg, name) {
  const mine = wipByPerson(facts).get(name) || { held: [], awaiting: [] };
  const limit = wipLimitOf(vaultCfg, name);
  return { held: mine.held, awaiting: mine.awaiting, limit, atLimit: limit !== null && mine.held.length >= limit };
}

// The order, as a pure function of the stories' facts, the vault config, the
// person and an as-of instant in epoch ms (contracts 1 to 4).
export function nextTasks({ facts, vaultCfg, person, asOfMs }) {
  const wip = personWip(facts, vaultCfg, person);
  const row = (f, extra) => ({
    ref: refOf(f),
    path: f.rel,
    title: f.fm?.title === null || f.fm?.title === undefined ? null : String(f.fm.title),
    ...extra,
    assignee: f.assignee || null,
    age_days: ageDays(f.age.at, asOfMs),
    age_from: f.age.at === null ? null : f.age.source,
    needs_move: null,
  });
  const started = [
    ...oldestFirst(wip.held.filter((f) => f.column === "In Progress")).map((f) => row(f, { group: "in-progress" })),
    ...oldestFirst(wip.held.filter((f) => f.column === "Review")).map((f) => row(f, { group: "review" })),
    ...oldestFirst(wip.awaiting).map((f) => row(f, { group: "awaiting-close" })),
  ];
  const offered = !wip.atLimit;
  const todo = facts.filter((f) => f.column === "ToDo");
  const withPriority = (f) => row(f, { priority: priorityOf(f.fm?.priority).priority });
  const newWork = offered
    ? [
        ...byPriority(todo.filter((f) => f.assignee === person)),
        ...byPriority(todo.filter((f) => f.assignee !== person)),
      ].map(withPriority)
    : [];
  const planned =
    offered && todo.length === 0
      ? byPriority(facts.filter((f) => f.status === "planned"))
          .slice(0, PLANNED_MAX)
          .map((f) => ({ ...withPriority(f), needs_move: moveCommand(refOf(f)) }))
      : [];
  const held = wip.held.length;
  return {
    assignee: person,
    wip: {
      held,
      awaiting: wip.awaiting.length,
      limit: wip.limit,
      at_limit: wip.atLimit,
      why: noLimitWhy(vaultCfg, person),
    },
    message: wip.atLimit ? `at WIP limit ${held}/${wip.limit}` : null,
    started,
    new_work: newWork,
    planned,
  };
}

// The command that puts a planned story in ToDo, as doctor's `todo-aged`
// builds its way back (Flow counts, contract 3). `next` never runs it.
export const moveCommand = (ref) =>
  packageCommand([], "move", { args: `${ref} todo --reason '${MOVE_REASON}' --write` });

// The layout a binding with none names: binding.mjs's DEFAULT_LAYOUT, which
// this module does not import, since binding.mjs is a writer
// (tests/next.test.mjs holds the two equal).
export const DEFAULT_LAYOUT = "engineering";

// The stories of a vault, read as Flow counts read them: {facts, unread}.
// The layout is the one the binding names; one with no epic folder, or one
// that does not load, throws. `load` is a test's seam.
function readFacts(vault, layoutName, read, load = loadLayout) {
  const name = layoutName || DEFAULT_LAYOUT;
  const epics = folderByKind(load(name), "epic");
  if (!epics) throw new Error(`layout ${name} has no epic folder`);
  const r = readFlowStories(vault, epics.path, read ? { read } : {});
  return { facts: r.stories.map(storyFacts), unread: r.unread };
}

// The plan gate's WIP check (contract 5): on a start, the new assignee's WIP
// as `next` counts it, before this run, and whether one more goes over the
// limit. Null when the person has no limit. It throws when the stories
// cannot be found (readFacts); the gate then goes on with `wip` null and a
// note. `read` and `load` are tests' seams.
export function wipOnStart({ vault, layout, vaultCfg, name, read = null, load = loadLayout }) {
  if (!name || wipLimitOf(vaultCfg, name) === null) return null;
  const { facts, unread } = readFacts(vault, layout, read, load);
  const w = personWip(facts, vaultCfg, name);
  const held = w.held.length;
  return { assignee: name, held, after: held + 1, limit: w.limit, over: held >= w.limit, unread };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function age(r) {
  if (r.age_days === null) return "no date to age it from";
  const from = r.age_from && r.age_from !== "stamp" ? `, the age read from ${r.age_from}` : "";
  return `${plural(r.age_days, "day")} in status${from}`;
}

const GROUP_LABEL = Object.freeze({
  "in-progress": "in progress",
  review: "review",
  "awaiting-close": "awaiting close",
});

const line = (lead, r, extra = "") => `  ${lead}  ${r.ref}${r.title ? ` — ${r.title}` : ""} (${extra}${age(r)})`;

// The text: the same rows in the same order, started work first, with
// `message` and `why` when set; each planned story's move on its own line.
export function renderNext(result, { project }) {
  const w = result.wip;
  const out = [
    `${result.assignee}: ${plural(w.held, "story", "stories")} held${w.limit === null ? "" : ` of a WIP limit of ${w.limit}`}${w.awaiting ? `, ${w.awaiting} awaiting close` : ""}`,
  ];
  if (result.message) out.push(result.message);
  if (w.why) out.push(w.why);
  if (result.unread) out.push(`${plural(result.unread, "story file")} could not be read, so a list can miss a story.`);
  out.push("");
  if (!result.started.length) out.push("Started work: none.");
  else {
    out.push("Started work:");
    for (const r of result.started) out.push(line(GROUP_LABEL[r.group], r));
  }
  if (result.message) return out.join("\n") + "\n";
  out.push("");
  if (result.new_work.length) {
    out.push("New work in ToDo:");
    for (const r of result.new_work) out.push(line(r.priority, r, `${r.assignee ?? "unassigned"}, `));
  } else if (result.planned.length) {
    out.push(`ToDo is empty. Planned stories (put one in ToDo first; run ${fromTerminalIn(project)}):`);
    for (const r of result.planned)
      out.push(line(r.priority, r, `${r.assignee ?? "unassigned"}, `), `    ${r.needs_move}`);
  } else out.push("New work: nothing in ToDo and nothing planned.");
  return out.join("\n") + "\n";
}

export async function runNext(ctx) {
  // now and read are the tests' seams; the bin never passes them.
  const { values, cfg, project, now: nowSeam = null, read = null } = ctx;
  let person;
  if (values.assignee !== undefined) {
    person = String(values.assignee).trim();
    if (!person) return { usage: '--assignee takes a name, such as --assignee "First Last"; it was blank' };
  } else {
    person = String(cfg.default_author ?? "").trim();
    if (!person)
      return { usage: 'next needs a person: pass --assignee "<name>", or set default_author in the binding' };
  }
  const fail = (message) => ({
    ok: false,
    code: 1,
    result: { assignee: person, error: message },
    text: `next: ${message}\n`,
  });
  const raw = String(cfg.vault_path ?? "").trim();
  const vault = raw ? resolve(project, raw) : null;
  if (!isDirectory(vault))
    return fail(`the binding names no vault directory that is there (${cfg.vault_path ?? "none"})`);
  const asOf = nowSeam || nowIso();
  let read0;
  try {
    read0 = readFacts(vault, cfg.layout, read);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
  const order = nextTasks({ facts: read0.facts, vaultCfg: readVaultConfig(vault), person, asOfMs: Date.parse(asOf) });
  const result = {
    assignee: order.assignee,
    as_of: asOf,
    wip: order.wip,
    message: order.message,
    started: order.started,
    new_work: order.new_work,
    planned: order.planned,
    unread: read0.unread,
  };
  return { ok: true, code: 0, result, text: renderNext(result, { project }) };
}

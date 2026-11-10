// projectstore — move.mjs: the `move` verb, a story between the backlog and ToDo.
//
// `planned` ↔ `todo` is the one change of status no gate makes (the plan gate
// starts work, the close gate finishes it). `move <story> <status> --reason
// "<why>"` makes it, for `todo` and `planned` only: bare, it prints the plan
// and writes nothing; with --write (a terminal is asked first; without one,
// --write is the confirmation) it writes the story through the shared status
// writer (status-change.mjs changeStatus: re-read before the replace, at most
// three attempts) with the actor `move`, updates the story's row in its
// epic's Stories table, and refreshes the derived views with a bare
// reconcile --write through the core. A move from or to any other status is
// refused (exit 1), naming the gate that makes that change; a missing reason,
// or one with a line break, is a usage error (exit 2).
//
// Spec: SPEC-001 contract 7 as amended 2026-11-10 by PS-FLOW/story-every-
// status-change-is-stamped-and-logged-in-the-story-and-a-command-moves-a-
// story-between-the-backlog-and-todo ("The ready step").
//
// runMove(ctx) follows configure's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageCommand } from "./harness.mjs";
import {
  loadLayout,
  folderByKind,
  listEpicStories,
  storyMatchesEntry,
  parseFrontmatter,
  commandForm,
  fromTerminalIn,
  nowIso,
} from "./lib.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { statusToColumn, NOT_ACTIONABLE, STATUS_COLUMNS } from "./stages.mjs";
import { oneLine, sameStatus } from "./status-log.mjs";
import { changeStatus, syncEpicRow, CHANGED_MEANWHILE } from "./status-change.mjs";

// The two targets, and the status each may come from (sameStatus).
const TARGETS = Object.freeze({ todo: ["planned"], planned: ["todo"] });
const CANONICAL = Object.freeze({ todo: "todo", "to-do": "todo", planned: "planned" });

const lower = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

// A status word: one statusToColumn's table names, or a NOT_ACTIONABLE one.
// Own keys only, so `constructor` and `__proto__` are no status words.
const isStatusWord = (s) => Object.hasOwn(STATUS_COLUMNS, s) || NOT_ACTIONABLE.has(s);
const targetsOf = (to) => (Object.hasOwn(TARGETS, to) ? TARGETS[to] : null);

// Why a change move does not make is refused: the gate that makes it — the
// plan gate for in-progress, the close gate for done — else no gate does.
function refusal(from, target, ref, env) {
  const column = statusToColumn(target);
  if (column === "In Progress")
    return `move does not start work: the plan gate moves a story to in-progress.\n${commandForm("story", { args: `plan ${ref}`, env })}`;
  if (column === "Done")
    return `move does not finish work: the close gate moves a story to done.\n${commandForm("story", { args: `close ${ref}`, env })}`;
  return `no gate moves a story from ${from || "no status"} to ${target}: move changes only planned to todo and todo to planned.`;
}

const allowed = (from, to) => (targetsOf(to) || []).some((s) => sameStatus(from, s));

// `<EPIC-ID>/<story-id>`, resolved as a spec's `stories:` entry is: the best
// tier of storyMatchesEntry among the epic's stories. Returns {path, ref} or
// {error} (none, or several).
export function resolveStory(arg, { vault, epicsPath }) {
  const m = String(arg).match(/^([^/]+)\/(.+)$/);
  if (!m) return { error: `name the story as <EPIC-ID>/<story-id>, such as PS-CORE/story-x; "${arg}" names none` };
  const [, epic, id] = m;
  const epicDir = join(vault, epicsPath, epic);
  let best = 0;
  let hits = [];
  for (const s of listEpicStories(epicDir)) {
    let fm;
    try {
      fm = parseFrontmatter(readFileSync(s.abs, "utf8")).data;
    } catch {
      continue;
    }
    const tier = storyMatchesEntry(id, { id: fm.id ?? null, stem: s.slug });
    if (!tier) continue;
    if (!best || tier < best) {
      best = tier;
      hits = [s];
    } else if (tier === best) hits.push(s);
  }
  if (!hits.length) return { error: `no story in ${epicsPath}/${epic} matches "${id}"` };
  if (hits.length > 1)
    return { error: `"${arg}" names ${hits.length} stories: ${hits.map((h) => h.rel).join(", ")}; qualify it` };
  return { path: hits[0].abs, ref: `${epic}/${id}` };
}

export function renderMove(plan, done = null, { env = process.env, project = null, asking = false } = {}) {
  const head = plan.same
    ? `${plan.ref} is already ${plan.from}`
    : `${plan.ref}: ${plan.from} → ${plan.to} — ${plan.reason} (move)`;
  if (done) {
    const lines = [plan.same ? `${head}: no line written` : `Moved ${head}`, `  ${plan.path}`];
    const e = done.epic;
    if (e)
      lines.push(
        e.error
          ? `  epic row: not updated (${e.error})`
          : e.found
            ? `  epic row: ${e.written ? "updated" : `already ${done.status}`}`
            : `  epic row: ${e.note}`,
      );
    if (done.reconcile) lines.push(`  derived views: ${done.reconcile.written ?? 0} regenerated`);
    return lines.join("\n") + "\n";
  }
  const lines = [
    plan.same ? head : `Move ${head}`,
    `  ${plan.path}`,
    "",
    plan.same
      ? "No line is written: the status does not change. With --write, its row in the epic's Stories table and the derived views are refreshed."
      : "Writes the story's status, status_changed_at, its header's Status row and one Status log line, then its row in the epic's Stories table, then the derived views.",
  ];
  if (!asking) {
    const args = `${plan.ref} ${plan.to} --reason ${shellQuote(plan.reason)} --write`;
    const session = plan.to === "todo" && !plan.same;
    lines.push(
      "",
      `Nothing written. To apply it, ${session ? "in a session or " : ""}${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      "",
      ...(session ? [`  ${commandForm("story", { args: `ready ${plan.ref}`, env })}`] : []),
      `  ${packageCommand([], "move", { args })}`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function runMove(ctx) {
  // afterCompute: the writer's test seam (an edit made meanwhile); the bin never passes it.
  const { values, positionals, cfg, project, env, confirm, ownEnv, afterCompute = null } = ctx;
  const [storyArg, targetArg] = positionals;
  if (!storyArg || !targetArg)
    return { usage: 'move takes a story and a status, such as `move PS-CORE/story-x todo --reason "next up"`' };
  if (values.reason === undefined) return { usage: 'move needs --reason "<why>": one line on why the story moves' };
  let reason;
  try {
    reason = oneLine(values.reason, "--reason");
  } catch (e) {
    return { usage: e.message };
  }
  const target = lower(targetArg);
  if (!isStatusWord(target)) return { usage: `"${targetArg}" is not a status; move makes todo or planned` };
  const to = Object.hasOwn(CANONICAL, target) ? CANONICAL[target] : target;
  const fail = (message, extra = {}) => ({
    ok: false,
    code: 1,
    result: { story: storyArg, to, reason, written: false, error: message, ...extra },
    text: `move: ${message}\n`,
  });

  const norm = normaliseVaultPath(cfg.vault_path, project);
  if (typeof norm !== "string" || !existsSync(norm))
    return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  let epics;
  try {
    epics = folderByKind(loadLayout(cfg.layout || DEFAULT_LAYOUT), "epic");
  } catch (e) {
    return fail(e.message);
  }
  if (!epics) return fail(`layout ${cfg.layout} has no epic folder`);
  const found = resolveStory(storyArg, { vault: norm, epicsPath: epics.path });
  if (found.error) return fail(found.error);

  const fm = parseFrontmatter(readFileSync(found.path, "utf8")).data;
  const from = String(fm.status ?? "").trim();
  // The equal-target rule is todo's and planned's only: `done → done` is a refusal.
  const same = Boolean(targetsOf(to)) && sameStatus(from, to);
  const plan = { ref: found.ref, path: found.path, from: from || "none", to, reason, same };
  const base = { story: found.ref, path: found.path, from: plan.from, to, reason, actor: "move" };
  if (!same && !allowed(from, to)) return fail(refusal(from, to, found.ref, env), base);
  if (!values.write)
    return {
      ok: true,
      code: 0,
      result: { ...base, written: false, ...(same ? { already: true } : {}) },
      text: renderMove(plan, null, { env, project }),
    };

  if (confirm && !(await confirm(renderMove(plan, null, { env, project, asking: true }))))
    return { ok: false, code: 1, result: { ...base, written: false, declined: true }, text: "Nothing written.\n" };

  // Every attempt judges the change again on the fresh bytes: a status that
  // became the target meanwhile is no change, any other is refused.
  const allow = (now) => {
    const s = String(now.status ?? "").trim();
    return sameStatus(s, to) || allowed(s, to) ? null : refusal(s, to, found.ref, env);
  };
  const r = changeStatus(found.path, {
    to,
    reason,
    actor: "move",
    at: nowIso(),
    lang: cfg.language || DEFAULT_LANGUAGE,
    allow,
    epic: false,
    afterCompute,
  });
  const done = { ...base, from: r.from || plan.from, written: r.written, line: r.line };
  if (r.refused) return fail(r.refused, done);
  if (r.error)
    return fail(
      r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${found.ref} changed before each of ${r.attempts} attempts; the file is left as the last edit made it. Run the move again.`
        : r.error,
      done,
    );
  // The epic row and the derived views, also when the status did not change:
  // a second run finishes what a failed first one left.
  done.status = String(parseFrontmatter(readFileSync(found.path, "utf8")).data.status ?? "").trim();
  done.epic = syncEpicRow(found.path);
  const { runReconcile } = await import("./reconcile.mjs");
  let rec;
  try {
    rec = runReconcile({ write: true, only: null, projectDir: project, env: ownEnv ? ownEnv(project) : env });
  } catch (e) {
    rec = { error: e && e.message ? e.message : String(e) };
  }
  done.reconcile = rec.summary ?? null;
  const recFailed = Boolean(rec.error || (rec.summary && rec.summary.failed > 0));
  const epicFailed = Boolean(done.epic.error);
  if (recFailed || epicFailed) {
    const left = [
      epicFailed ? `its row in the epic's Stories table (${done.epic.error})` : null,
      recFailed ? `the derived views${rec.error ? ` (${rec.error})` : ""}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const text = `${renderMove(plan, done, { env })}move: ${r.written ? "the story was written, but " : ""}${left} ${epicFailed && recFailed ? "are" : "is"} left. Run the same move again ${fromTerminalIn(project)}:\n${packageCommand([], "move", { args: `${found.ref} ${to} --reason ${shellQuote(reason)} --write` })}\n`;
    return { ok: false, code: 1, result: { ...done, error: `left: ${left}` }, text };
  }
  return { ok: true, code: 0, result: done, text: renderMove(plan, done, { env }) };
}

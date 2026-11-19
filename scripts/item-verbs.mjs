// projectstore — item-verbs.mjs: the verbs that write an item's text outside
// an agent session, and the one writer of the not-reviewed mark.
//
// `create initiative|epic|story …` writes a new initiative, epic or story:
// the file draft.mjs renders for the harness command of the same kind, with
// the fields its options name, an epic's placeholder Stories row dropped, and
// the mark `written_by_verb: "create <instant>"` beside `review_status:
// pending`. A story's row then goes into its epic's Stories table through the
// same add `epic-row --add` runs, and the derived views are refreshed with a
// bare reconcile --write, as `move` does. `reviewed <path>` clears the mark
// once a review has read the file.
//
// Bare, each verb prints its plan and writes nothing; with --write it asks
// once at a terminal, and without one, or under --json, --write is the
// confirmation (the ADR "Create and edit verbs write an artifact outside the
// harness commands, for any caller, and mark what they write not reviewed",
// decision 3). Each write lands in this session's record of its vault writes
// with the verb's name as the tool. The module runs no git.
//
// Spec: "Create verbs and the not-reviewed mark…" (alias `create`),
// contracts 1 to 6. Only this module writes the mark's key, and only
// runReviewed removes it (tests/verb-mark.test.mjs). runCreate(ctx) and
// runReviewed(ctx) follow move's contract: each returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCommand } from "./harness.mjs";
import {
  loadLayout,
  folderByKind,
  parseFrontmatter,
  createFileExclusive,
  fromTerminalIn,
  nowIso,
  today,
} from "./lib.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { renderDraft, DraftError } from "./draft.mjs";
import { oneLine, setFm, setHeaderField, epicRowAdd } from "./status-log.mjs";
import { replaceWithRetry, syncEpicRow, CHANGED_MEANWHILE, EPIC_ROW_MISSING } from "./status-change.mjs";
import { applyFields, applyEpicInitiative, initiativeTarget } from "./initiative-verbs.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { MARK_KEY, isMarked } from "./verb-mark.mjs";

const KINDS = Object.freeze(["initiative", "epic", "story"]);
// The options each kind takes, beside --write and --json.
const OPTIONS = Object.freeze({
  initiative: ["owner", "priority"],
  epic: ["priority", "initiative"],
  story: ["priority", "assignee"],
});
const ALL_OPTIONS = ["owner", "priority", "initiative", "assignee"];
// The limit for one name on the file systems the tests run on, and the most
// createFileExclusive's temporary name `.<name>.<pid>.tmp` adds to it.
export const NAME_LIMIT = 255;
export const TEMP_ROOM = 16;
// A new epic's id: a letter or digit, then letters, digits, `.`, `_` or `-`.
const EPIC_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
// The epic templates' placeholder row in the Stories table.
const PLACEHOLDER_ROW = /^\|[^\n]*\]\(\.\/stories\/story-001\.md\)[^\n]*\|\r?\n/m;

const errMsg = (e) => (e && e.message ? e.message : String(e));
const given = (v) => v !== undefined;
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

// ─── The mark ──────────────────────────────────────────────────────────

// The write's instant, UTC to the second: 2026-11-19T06:00:00Z.
export function markInstant(now = null) {
  return `${String(now || nowIso()).slice(0, 19)}Z`;
}

// The frontmatter block's lines and the index of its closing `---`, or null.
function fmLines(text) {
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((l, k) => k > 0 && l.replace(/\r$/, "") === "---");
  return end === -1 ? null : { lines, end };
}
const keyAt = (lines, end, key) => lines.findIndex((l, k) => k > 0 && k < end && l.startsWith(`${key}:`));

// The text with the mark: the key just before `review_status`, whose value
// and `reviewed_at`'s are set in place; with no review keys (a story), the
// three lines after `plan_updated_at`, else last (contract 4).
export function withMark(text, value) {
  const f = fmLines(text);
  if (!f) throw new Error("the file has no frontmatter block");
  const { lines, end } = f;
  const mark = `${MARK_KEY}: ${JSON.stringify(value)}`;
  const rs = keyAt(lines, end, "review_status");
  if (rs !== -1) {
    lines[rs] = "review_status: pending";
    const ra = keyAt(lines, end, "reviewed_at");
    if (ra !== -1) lines[ra] = "reviewed_at: null";
    else lines.splice(rs + 1, 0, "reviewed_at: null");
    lines.splice(rs, 0, mark);
    return lines.join("\n");
  }
  const pu = keyAt(lines, end, "plan_updated_at");
  const at = pu !== -1 ? pu + 1 : end;
  lines.splice(at, 0, mark, "review_status: pending", "reviewed_at: null");
  return lines.join("\n");
}

// The text with the mark cleared: the key's line removed, `review_status:
// reviewed` and `reviewed_at: <day>` each in place, or, absent, where the
// mark was (contract 6). null when the text holds no mark.
export function clearMark(text, day) {
  const f = fmLines(text);
  if (!f || !isMarked(parseFrontmatter(text).data)) return null;
  const { lines, end } = f;
  const at = keyAt(lines, end, MARK_KEY);
  lines.splice(at, 1);
  const e = end - 1;
  const added = [];
  const rs = keyAt(lines, e, "review_status");
  if (rs !== -1) lines[rs] = "review_status: reviewed";
  else added.push("review_status: reviewed");
  const ra = keyAt(lines, e, "reviewed_at");
  if (ra !== -1) lines[ra] = `reviewed_at: ${day}`;
  else added.push(`reviewed_at: ${day}`);
  if (added.length) lines.splice(at, 0, ...added);
  return lines.join("\n");
}

// ─── Paths ─────────────────────────────────────────────────────────────

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function present(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// The path with symbolic links resolved: its nearest existing ancestor's real
// path, then the rest as written.
function realOf(p) {
  let base = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(base), ...rest.reverse());
    } catch {
      const up = dirname(base);
      if (up === base) return resolve(p);
      rest.push(basename(base));
      base = up;
    }
  }
}
const inside = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// ─── create ────────────────────────────────────────────────────────────

// The usage checks of contract 1: {kind, id, title, fields} or {usage}. A
// message names the option, never its value.
export function createUsage(values, positionals) {
  const [kind, ...rest] = positionals;
  if (!kind)
    return {
      usage:
        'create takes a kind and a title: `create initiative "<title>"`, `create epic <EPIC-ID> "<title>"` or `create story <EPIC-ID> "<title>"`',
    };
  if (!KINDS.includes(kind))
    return {
      usage: `create makes an initiative, an epic or a story, not "${kind}"; other kinds are created by the agent command of the same name`,
    };
  const withId = kind !== "initiative";
  const id = withId ? String(rest[0] ?? "").trim() : null;
  if (withId && !id) return { usage: `create ${kind} needs an epic id, then the title` };
  const words = withId ? rest.slice(1) : rest;
  const other = ALL_OPTIONS.find((o) => given(values[o]) && !OPTIONS[kind].includes(o));
  if (other)
    return { usage: `create ${kind} takes no --${other}; it takes ${OPTIONS[kind].map((o) => `--${o}`).join(", ")}` };
  const fields = {};
  let title;
  try {
    title = oneLine(words.join(" "), "the title");
    for (const o of ["owner", "assignee", "initiative"])
      if (given(values[o])) {
        if (values[o] === true) return { usage: `--${o} needs a value` };
        fields[o] = oneLine(values[o], `--${o}`);
      }
  } catch (e) {
    return { usage: e.message };
  }
  for (const o of ["owner", "assignee"])
    if (fields[o] && fields[o].includes("@")) return { usage: `--${o} is a name, not an email address` };
  if (given(values.priority)) {
    const p = String(values.priority).trim().toLowerCase();
    if (!/^p\d+$/.test(p)) return { usage: "--priority is p and digits, such as p1" };
    fields.priority = p;
  }
  return { kind, id, title, fields };
}

// The file's content for the draft and the fields, before the mark: the
// option fields set as the field verbs write them, an epic's placeholder row
// dropped (contract 2).
export function createContent(draft, { kind, fields, target, lang }) {
  const day = draft.vars.date;
  let t = draft.content;
  if (fields.priority || fields.owner)
    t = applyFields(t, { priority: fields.priority, owner: fields.owner, day }).content;
  if (fields.assignee)
    t = setHeaderField(setFm(t, "assignee", JSON.stringify(fields.assignee)), "assignee", fields.assignee).text;
  if (kind === "epic") {
    if (target) t = applyEpicInitiative(t, { target, lang, day }).content;
    t = t.replace(PLACEHOLDER_ROW, "");
  }
  return t;
}

// The vault, its layout and the kind's folder, or {error}.
function vaultFor(cfg, project, kind) {
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return { error: `the binding names no vault directory that is there (${cfg.vault_path})` };
  let layout;
  try {
    layout = loadLayout(cfg.layout || DEFAULT_LAYOUT);
  } catch (e) {
    return { error: errMsg(e) };
  }
  const folder = folderByKind(layout, kind === "story" ? "epic" : kind);
  if (!folder)
    return { error: `layout ${cfg.layout || DEFAULT_LAYOUT} has no ${kind === "story" ? "epic" : kind} folder` };
  const initiatives = folderByKind(layout, "initiative");
  return { vault, layout, folder: folder.path, initiatives: initiatives ? initiatives.path : null };
}

// The refusals of contract 3 that read the vault, before any write: a reason,
// or null.
function refusal(u, v, draft) {
  const { kind, id } = u;
  if (id !== null) {
    if (kind === "epic") {
      if (!EPIC_ID.test(id))
        return `"${id}" is no epic id: it starts with a letter or digit and holds only letters, digits, ".", "_" or "-"`;
      if (bytes(id) > NAME_LIMIT) return `the epic id is ${bytes(id)} bytes; one name holds at most ${NAME_LIMIT}`;
    }
    if (kind === "story" && !existsSync(join(v.vault, v.folder, id, "epic.md")))
      return `"${id}" names no epic in ${v.folder}: there is no ${v.folder}/${id}/epic.md`;
  }
  const abs = draft.path;
  const rel = relative(v.vault, abs).split(sep).join("/");
  if (present(abs)) return `${rel} exists; a create never overwrites, and the agent command asks there`;
  if (draft.collision) return `${rel} is the same artifact as ${draft.collision.with}, which exists in that folder`;
  const name = basename(abs);
  if (bytes(name) > NAME_LIMIT - TEMP_ROOM)
    return `the file name is ${bytes(name)} bytes; it may be ${NAME_LIMIT - TEMP_ROOM} (${NAME_LIMIT} less ${TEMP_ROOM} for the temporary name): shorten the title`;
  const kindDir = realOf(join(v.vault, v.folder));
  if (!inside(realOf(abs), kindDir) || !inside(kindDir, realOf(v.vault)))
    return `${rel} is not inside the vault's ${v.folder} folder once its links are resolved`;
  return null;
}

function createPlan(p, { project, args, asking = false, done = false }) {
  const lines = [`create ${p.kind}: ${p.rel}${done ? " written" : ""}`];
  for (const [k, val] of Object.entries(p.fields)) lines.push(`  ${k}: ${val}`);
  lines.push(`  mark: ${MARK_KEY} "create <the write's instant>", review_status pending`);
  if (p.index) lines.push(`  index row: ${p.index}`);
  if (p.kind === "story") lines.push(p.row ? `  Stories row: ${p.row}` : `  Stories row: none (${p.note})`);
  if (done && p.reconcile) lines.push(`  derived views: ${p.reconcile.written ?? 0} regenerated`);
  for (const n of p.notes) lines.push(`  note: ${n}`);
  if (!done && !asking) {
    lines.push(
      `Nothing written. To write it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
    );
    lines.push(`  ${packageCommand([], "create", { args: `${args} --write` })}`);
  }
  return lines.join("\n") + "\n";
}

export async function runCreate(ctx) {
  const { values, positionals, cfg, project, env, confirm, ownEnv, now = null, afterCompute = null } = ctx;
  const u = createUsage(values, positionals);
  if (u.usage) return { usage: u.usage };
  const result = (extra = {}) => ({
    write: Boolean(values.write),
    kind: u.kind,
    path: null,
    rel: null,
    fields: u.fields,
    mark: null,
    index: null,
    row: null,
    notes: [],
    reconcile: null,
    left: [],
    declined: false,
    error: null,
    ...extra,
  });
  const fail = (message, extra = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra, error: message }),
    text: `create: ${message}\n`,
  });
  const v = vaultFor(cfg, project, u.kind);
  if (v.error) return fail(v.error);
  const lang = cfg.language || DEFAULT_LANGUAGE;
  if (u.id !== null && (u.id === "." || u.id === ".." || /[\\/]/.test(u.id)))
    return fail(`"${u.id}" is no epic id: it may not be . or .. or hold / or \\`);
  let draft;
  try {
    draft = renderDraft({ ...cfg, vault_path: v.vault }, v.layout, u.kind, u.id === null ? [u.title] : [u.id, u.title]);
  } catch (e) {
    if (e instanceof DraftError) return fail(e.message);
    throw e;
  }
  const why = refusal(u, v, draft);
  if (why) return fail(why);
  const abs = draft.path;
  const rel = relative(v.vault, abs).split(sep).join("/");

  let target = null;
  if (u.fields.initiative) {
    if (!v.initiatives) return fail(`layout ${cfg.layout || DEFAULT_LAYOUT} has no initiative folder`);
    const t = initiativeTarget(v.vault, v.initiatives, abs, u.fields.initiative);
    if (t.error) return fail(t.error);
    target = t.target;
  }
  const base = createContent(draft, { kind: u.kind, fields: u.fields, target, lang });

  // The Stories row the add would write now: shown in the plan, computed
  // again from the epic's fresh bytes at the write.
  let row = null;
  let note = null;
  const epicPath = u.kind === "story" ? join(dirname(dirname(abs)), "epic.md") : null;
  if (epicPath) {
    const status = String(parseFrontmatter(base).data.status ?? "").trim();
    const r = epicRowAdd(readFileSync(epicPath, "utf8"), { epicPath, storyPath: abs, status, title: u.title });
    row = r.row;
    note = r.found ? null : r.unlinkable ? "epic-row-unlinkable" : EPIC_ROW_MISSING;
  }
  const args = [
    u.kind,
    ...(u.id === null ? [] : [shellQuote(u.id)]),
    shellQuote(u.title),
    ...OPTIONS[u.kind].filter((o) => u.fields[o] !== undefined).map((o) => `--${o} ${shellQuote(u.fields[o])}`),
  ].join(" ");
  const plan = {
    kind: u.kind,
    rel,
    fields: u.fields,
    index: draft.index ? draft.index.line : null,
    row,
    note,
    notes: [],
  };
  const planned = result({ path: abs, rel, index: plan.index, row, notes: note ? [note] : [] });
  if (!values.write) return { ok: true, code: 0, result: planned, text: createPlan(plan, { project, args }) };
  if (confirm && !(await confirm(createPlan(plan, { project, args, asking: true }))))
    return {
      ok: false,
      code: 1,
      result: { ...planned, declined: true, error: "declined" },
      text: "Nothing written.\n",
    };

  // The mark's instant is the write's, taken after the question.
  const mark = `create ${markInstant(now)}`;
  const content = withMark(base, mark);
  try {
    mkdirSync(u.kind === "epic" ? join(dirname(abs), "stories") : dirname(abs), { recursive: true });
    if (!createFileExclusive(abs, content))
      return fail(`${rel} was made by another writer after the plan; it is kept, and nothing was written`, {
        path: abs,
        rel,
      });
  } catch (e) {
    return fail(`${rel} could not be written: ${errMsg(e)}`, { path: abs, rel });
  }
  // Each write lands in this session's record (the record spec, contract 5).
  const onWrite = nodeWriteRecorder({ env, project, tool: "create" });
  onWrite(abs, null, content);

  const left = [];
  const notes = [];
  const lines = [];
  const written = { row: null };
  if (epicPath) {
    const r = syncEpicRow(abs, { add: true, afterCompute, onWrite });
    if (r.error) {
      const cmd = `node ${shellQuote(join(dirname(fileURLToPath(import.meta.url)), "status-change.mjs"))} epic-row ${shellQuote(abs)} --add`;
      left.push({
        what: "the Stories row",
        error: r.error === CHANGED_MEANWHILE ? `${CHANGED_MEANWHILE}: the epic changed before each attempt` : r.error,
        finish: cmd,
      });
    } else {
      written.row = r.row;
      if (r.note) notes.push(r.note);
    }
  }
  const { refreshViews } = await import("./reconcile.mjs");
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  if (rec.failed)
    left.push({
      what: "the derived views",
      error: rec.error || "a view failed",
      finish: packageCommand([], "reconcile", { args: "--write" }),
    });
  const done = result({
    path: abs,
    rel,
    mark,
    index: plan.index,
    row: written.row,
    notes,
    reconcile: rec.summary,
    left,
  });
  let text = createPlan(
    { ...plan, row: written.row ?? row, notes, reconcile: rec.summary },
    { project, args, done: true },
  );
  if (!left.length) return { ok: true, code: 0, result: done, text };
  for (const l of left)
    lines.push(`left: ${l.what} (${l.error}). Finish it ${fromTerminalIn(project)}:`, `  ${l.finish}`);
  text += `create: ${rel} was written, but not all that follows it.\n${lines.join("\n")}\n`;
  return { ok: false, code: 1, result: { ...done, error: `left: ${left.map((l) => l.what).join(", ")}` }, text };
}

// ─── reviewed ──────────────────────────────────────────────────────────

export async function runReviewed(ctx) {
  const { values, positionals, cfg, project, env, confirm, now = null, afterCompute = null } = ctx;
  const [arg, ...extra] = positionals;
  if (!arg || extra.length) return { usage: "reviewed takes one path: the file whose review cleared its mark" };
  const day = now ? String(now).slice(0, 10) : today();
  const result = (extra2 = {}) => ({
    write: Boolean(values.write),
    path: null,
    rel: null,
    marked: false,
    written: false,
    declined: false,
    error: null,
    ...extra2,
  });
  const fail = (message, extra2 = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra2, error: message }),
    text: `reviewed: ${message}\n`,
  });
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  const abs = isAbsolute(arg) ? resolve(arg) : resolve(vault, arg);
  const realVault = realOf(vault);
  if (!inside(realOf(abs), realVault) || !inside(abs, vault) || !/\.md$/i.test(abs))
    return fail(`${arg} is not a markdown file inside the bound vault`);
  const rel = relative(vault, abs).split(sep).join("/");
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return fail(`${rel} is not there`);
  }
  if (clearMark(text, day) === null)
    return {
      ok: true,
      code: 0,
      result: result({ path: abs, rel }),
      text: `reviewed: ${rel} has no ${MARK_KEY} mark; nothing to clear.\n`,
    };
  const planText = (asking) =>
    `reviewed: ${rel}\n  ${MARK_KEY}: removed\n  review_status: reviewed, reviewed_at: ${day}\n` +
    (asking
      ? ""
      : `Nothing written. To clear it, ${fromTerminalIn(project)}:\n  ${packageCommand([], "reviewed", { args: `${shellQuote(rel)} --write` })}\n`);
  if (!values.write)
    return { ok: true, code: 0, result: result({ path: abs, rel, marked: true }), text: planText(false) };
  if (confirm && !(await confirm(planText(true))))
    return {
      ok: false,
      code: 1,
      result: result({ path: abs, rel, marked: true, declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };
  const onWrite = nodeWriteRecorder({ env, project, tool: "reviewed" });
  const r = replaceWithRetry(
    abs,
    (b) => {
      const c = clearMark(b, day);
      return { content: c === null ? b : c };
    },
    { afterCompute, onWrite },
  );
  if (r.error)
    return fail(
      r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${rel} changed before each of ${r.attempts} attempts; the file is left as the last edit made it`
        : r.error,
      { path: abs, rel, marked: true },
    );
  return {
    ok: true,
    code: 0,
    result: result({ path: abs, rel, marked: true, written: Boolean(r.written) }),
    text: `reviewed: ${rel} written\n  ${MARK_KEY}: removed\n  review_status: reviewed, reviewed_at: ${day}\n`,
  };
}

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
// once a review has read the file. `edit <path> --from <file> --base <hash>`
// replaces the `## ` sections of an initiative, epic or story when its body
// still has that hash, through the guards of edit-cut.mjs, and marks it
// `edit <instant>` (spec "The edit verb…", alias `edit`).
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

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCommand } from "./harness.mjs";
import {
  loadLayout,
  folderByKind,
  parseFrontmatter,
  createFileExclusive,
  ensureGitignoreLines,
  extractLinks,
  keptLinkTarget,
  fromTerminalIn,
  nowIso,
  today,
  writeFileAtomic,
} from "./lib.mjs";
import { MAX_BYTES, typeOf, nameOf, isKeptShape, refusal as attachmentRefusal } from "./attachment.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { renderDraft, DraftError } from "./draft.mjs";
import { oneLine, setFm, setHeaderField, epicRowAdd } from "./status-log.mjs";
import { replaceWithRetry, syncEpicRow, CHANGED_MEANWHILE, EPIC_ROW_MISSING } from "./status-change.mjs";
import { applyFields, applyEpicInitiative, initiativeTarget } from "./initiative-verbs.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";
import { MARK_KEY, isMarked } from "./verb-mark.mjs";
import { EDIT_KINDS, splitForEdit, bodyHash, guardEdit, changedSections, normalise } from "./edit-cut.mjs";

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
  // A file that holds the key already (a create, then an edit; two edits) has
  // its value replaced in place: a file never holds the key twice (the edit
  // spec, contract 6).
  const held = keyAt(lines, end, MARK_KEY);
  if (held !== -1) {
    lines[held] = mark;
    const added = [];
    const rs0 = keyAt(lines, end, "review_status");
    if (rs0 !== -1) lines[rs0] = "review_status: pending";
    else added.push("review_status: pending");
    const ra0 = keyAt(lines, end, "reviewed_at");
    if (ra0 !== -1) lines[ra0] = "reviewed_at: null";
    else added.push("reviewed_at: null");
    if (added.length) lines.splice(held + 1, 0, ...added);
    return lines.join("\n");
  }
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
  if (p.kind === "story")
    lines.push(
      p.row ? `  Stories row: ${p.row}` : p.note ? `  Stories row: none (${p.note})` : "  Stories row: already there",
    );
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
  if (!inside(realOf(abs), realVault) || !/\.md$/i.test(abs))
    return fail(`${arg} is not a markdown file inside the bound vault`);
  const rel = relative(realVault, realOf(abs)).split(sep).join("/");
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

// ─── edit ──────────────────────────────────────────────────────────────

// The most UTF-16 code units a text may hold, counted before its line endings
// are made LF (the edit spec, contract 1).
export const EDIT_TEXT_LIMIT = 500000;
const HASH = /^[0-9a-f]{16}$/;

// The text as a body: a leading byte-order mark and leading blank lines
// dropped, its trailing white space replaced by the file body's own.
function bodyFrom(text, was) {
  const kept = was.trimEnd();
  const tail = was.slice(kept.length) || "\n";
  let t = normalise(text).replace(/^\uFEFF/, "");
  let k = 0;
  // Leading blank lines: whole lines of spaces and tabs only.
  for (let nl = t.indexOf("\n"); nl !== -1 && !t.slice(k, nl).trim(); nl = t.indexOf("\n", k)) k = nl + 1;
  t = t.slice(k);
  return `${t.trimEnd()}${tail}`;
}

// ─── attachments (the attachments spec, contracts 3 to 8) ──────────────

const GITATTRIBUTES_LINE = (dir) => `${dir}/** -text`;

// The first bytes of a file, enough for typeOf, without reading the rest.
function headOf(file, n = 16) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

// The checks of contract 4 for a text and its attached files, before anything
// is written: each file's type, size and name; `<A>` not a link and inside the
// vault; a same-named file of another size; every attached file linked; every
// kept link to a file that is attached or kept; no wikilink to a kept name.
// Returns { error } or { files: [{path, type, size, state, bytes}], dirAbs }.
async function attachmentPlan({ vault, realVault, rel, body, dir, attach }) {
  const dirAbs = join(vault, dir);
  const byName = new Map();
  for (const file of attach) {
    const type = typeOf(headOf(file));
    if (!type) return { error: attachmentRefusal("type", { file }) };
    const size = statSync(file).size;
    if (size > MAX_BYTES) return { error: attachmentRefusal("size", { file, size }) };
    const bytes = readFileSync(file);
    const name = await nameOf(bytes);
    if (!byName.has(name)) byName.set(name, { file, name, type, size, bytes });
  }
  if (attach.length && existsSync(dirAbs)) {
    if (lstatSync(dirAbs).isSymbolicLink())
      return { error: `${dir}/ is a symbolic link; the attachments folder must be a folder of the vault` };
    if (!inside(realOf(dirAbs), realVault)) return { error: `${dir}/ resolves outside the vault` };
  }
  const files = [];
  for (const f of byName.values()) {
    const path = `${dir}/${f.name}`;
    const there = join(dirAbs, f.name);
    let state = "to-create";
    if (existsSync(there)) {
      if (statSync(there).size !== f.size)
        return { error: `${path} is there with another size than ${f.file}; nothing is written over it` };
      state = "found";
    }
    files.push({ path, type: f.type, size: f.size, state, bytes: f.bytes });
  }
  // The links of the text (contract 4): kept links, and wikilinks to a kept name.
  const linked = new Set();
  for (const link of extractLinks(body)) {
    if (link.type === "mdlink") {
      const t = keptLinkTarget(rel, link.target, dir);
      if (t) linked.add(t);
    } else if (link.type === "wikilink") {
      const last = String(link.target).split(/[|#]/)[0].trim().split("/").pop();
      if (isKeptShape(last))
        return {
          error: `the text links ${last} as a wikilink; link a kept file by a relative Markdown link, as ![name](${posix.relative(posix.dirname(rel), `${dir}/${last}`)})`,
        };
    }
  }
  for (const f of files)
    if (!linked.has(f.path)) {
      const file = byName.get(f.path.slice(dir.length + 1)).file;
      return {
        error: attachmentRefusal("unlinked", { file, path: f.path, rel: posix.relative(posix.dirname(rel), f.path) }),
      };
    }
  const attached = new Set(files.map((f) => f.path));
  for (const path of [...linked].sort())
    if (!attached.has(path) && !existsSync(join(vault, path)))
      return {
        error: `the text links ${path}, which is not in ${dir}/ and not attached; attach the file or remove the link`,
      };
  return { files, dirAbs };
}

// Whether the vault's .gitattributes lacks the attachments line.
function gitattributesLacks(vault, dir) {
  try {
    return !readFileSync(join(vault, ".gitattributes"), "utf8")
      .split(/\r?\n/)
      .some((l) => l.trim() === GITATTRIBUTES_LINE(dir));
  } catch {
    return true;
  }
}

// Write the files to create and the .gitattributes line (contract 5), and
// return what an undo needs; record nothing yet (a run that is taken back
// records nothing).
function writeAttachments({ vault, dir, dirAbs, files, addLine }) {
  const made = { dir: false, files: [], ga: null };
  if (files.some((f) => f.state === "to-create") && !existsSync(dirAbs)) {
    mkdirSync(dirAbs, { recursive: true });
    made.dir = true;
  }
  for (const f of files)
    if (f.state === "to-create") {
      const abs = join(vault, f.path);
      if (createFileExclusive(abs, f.bytes)) {
        made.files.push({ abs, bytes: f.bytes });
        f.state = "created";
      } else if (statSync(abs).size === f.size) f.state = "found";
      else throw new Error(`${f.path} appeared with another size while this edit ran; nothing is written over it`);
    }
  if (addLine) {
    const file = join(vault, ".gitattributes");
    const before = existsSync(file) ? readFileSync(file) : null;
    ensureGitignoreLines(file, [GITATTRIBUTES_LINE(dir)]);
    made.ga = { file, before, after: readFileSync(file) };
  }
  return made;
}

// Take back what writeAttachments made (contract 6): the files it created,
// the folder only when it made it and it is empty, and .gitattributes only
// while it still holds the bytes this run wrote.
function undoAttachments(made) {
  for (const f of made.files)
    try {
      unlinkSync(f.abs);
    } catch {}
  if (made.dir && made.files.length)
    try {
      rmdirSync(dirname(made.files[0].abs));
    } catch {}
  if (made.ga)
    try {
      if (readFileSync(made.ga.file).equals(made.ga.after)) {
        if (made.ga.before === null) unlinkSync(made.ga.file);
        else writeFileAtomic(made.ga.file, made.ga.before, { sweep: false });
      }
    } catch {}
}

const filesOut = (files) => files.map(({ path, type, size, state }) => ({ path, type, size, state }));

export async function runEdit(ctx) {
  const { values, positionals, cfg, project, env, confirm, afterCompute = null } = ctx;
  const now = ctx.now ?? null;
  const [arg, ...extra] = positionals;
  if (!arg || extra.length) return { usage: "edit takes one path: a story, an epic or an initiative in the vault" };
  const from = values.from;
  const base = values.base;
  if (given(from) !== given(base))
    return {
      usage: "edit takes --from and --base together: the new text and the hash of the body it was written over",
    };
  if (!given(from) && values.write) return { usage: "edit --write needs --from <file> and --base <hash>" };
  if (given(base) && !HASH.test(String(base)))
    return { usage: `--base is the body's hash, 16 lowercase hex digits; ${JSON.stringify(base)} is not that` };
  // The attached files (the attachments spec, contract 3): repeatable, with a text.
  const attach = [].concat(values.attach ?? []).filter((a) => a !== undefined && a !== null && a !== "");
  if (attach.length && !given(from)) return { usage: "edit --attach needs --from <file> and --base <hash>" };
  for (const a of attach) {
    try {
      if (!statSync(String(a)).isFile()) return { usage: `--attach ${a} is not a file` };
      closeSync(openSync(String(a), "r"));
    } catch (e) {
      return { usage: `--attach ${a} cannot be read: ${errMsg(e)}` };
    }
  }
  const result = (extra2 = {}) => ({
    write: Boolean(values.write),
    path: null,
    rel: null,
    kind: null,
    hash: null,
    body: null,
    sections: [],
    part: null,
    same: false,
    written: false,
    mark: null,
    reconcile: null,
    left: [],
    declined: false,
    error: null,
    ...extra2,
  });
  const fail = (message, extra2 = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra2, error: message }),
    text: `edit: ${message}\n`,
  });

  // The text (contract 1), read before the vault is: a usage error writes nothing.
  let text = null;
  if (given(from)) {
    let buf;
    try {
      if (!statSync(String(from)).isFile()) return { usage: `--from ${from} is not a file` };
      buf = readFileSync(String(from));
    } catch (e) {
      return { usage: `--from ${from} cannot be read: ${errMsg(e)}` };
    }
    text = buf.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buf)) return { usage: `--from ${from} is not UTF-8 text` };
    if (text.length > EDIT_TEXT_LIMIT)
      return { usage: `the text is ${text.length} characters; edit takes at most ${EDIT_TEXT_LIMIT}` };
    if (text.includes("\u0000")) return { usage: "the text holds a NUL character" };
    if (!text.replace(/^\uFEFF/, "").trim()) return { usage: "the text is empty: an edit never removes every section" };
  }

  // The path and the kind (contract 3): inside the bound vault once links are
  // resolved, a markdown file, and one of the three kinds.
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  const realVault = realOf(vault);
  const abs = isAbsolute(arg) ? resolve(arg) : resolve(vault, arg);
  if (!inside(realOf(abs), realVault)) return fail(`${arg} is outside the bound vault`);
  const rel = relative(realVault, realOf(abs)).split(sep).join("/");
  let raw;
  try {
    if (!statSync(abs).isFile() || !/\.md$/i.test(abs)) return fail(`${rel} is not a markdown file`);
    raw = readFileSync(abs, "utf8");
  } catch {
    return fail(`${rel} is not there`);
  }
  const kindOf = (t) => {
    const n = normalise(t);
    const fm = /^---\n[\s\S]*?\n---\n/.exec(n);
    const type = fm ? String(parseFrontmatter(n).data.type ?? "").trim() : "";
    return { fm: fm ? fm[0] : null, type, rest: fm ? n.slice(fm[0].length) : n };
  };
  const k = kindOf(raw);
  if (!k.fm || !EDIT_KINDS.includes(k.type))
    return fail(
      `${rel} is ${k.type ? `of the kind ${k.type}` : "no artifact with a type"}; edit writes only a story, an epic or an initiative`,
      { path: abs, rel, kind: k.type || null },
    );
  const parts = splitForEdit(k.rest);
  const hash = bodyHash(parts.body);
  const found = { path: abs, rel, kind: k.type, hash };

  // The read form (contract 1).
  if (text === null)
    return {
      ok: true,
      code: 0,
      result: result({ ...found, body: parts.body }),
      text: `edit: ${rel} (${k.type}), hash ${hash}\n${parts.body}`,
    };

  // The checks, in order (contract 1): the base (contract 4), the guards
  // (contract 5), then whether anything changes. The plan refuses as the write does.
  const changed = `The file changed after it was read. Read it again (edit ${rel}) and put your change into it.`;
  if (base !== hash) return fail(changed, found);
  const body = bodyFrom(text, parts.body);
  const refused = guardEdit(k.type, parts.body, body);
  if (refused) return fail(refused.error, { ...found, part: refused.part });
  // The file as it would be written, read back: the body must be the text (contract 6).
  const writeOf = (fm, p, b, mark) => withMark(`${fm}${p.head}${b}${p.foot}`, mark);
  const readsBack = (content, b) => splitForEdit(kindOf(content).rest).body === b;
  if (!readsBack(writeOf(k.fm, parts, body, "edit check"), body))
    return fail(
      'The text would not read back as written: it ends with a `---` line and a "Last updated" line, which the file\'s own foot holds. Remove them from the text.',
      found,
    );
  // The attachments (the attachments spec, contract 4): after the guards and
  // the foot, before the same-text answer; on every edit of a vault whose
  // layout names the folder, `--attach` or not.
  let layoutDir = null;
  try {
    const lay = loadLayout(cfg.layout || DEFAULT_LAYOUT);
    layoutDir = typeof lay.attachments?.path === "string" ? lay.attachments.path : null;
  } catch {}
  if (attach.length && !layoutDir) return fail("this layout keeps no attachments", found);
  let att = { files: [], dirAbs: null };
  if (layoutDir) {
    att = await attachmentPlan({ vault, realVault, rel, body, dir: layoutDir, attach });
    if (att.error) return fail(att.error, found);
  }
  const same = body === parts.body;
  const toCreate = att.files.filter((f) => f.state === "to-create");
  const addLine = Boolean(attach.length) && (!same || toCreate.length > 0) && gitattributesLacks(vault, layoutDir);
  const attached = (gitattributesState) =>
    attach.length ? { files: filesOut(att.files), gitattributes: gitattributesState } : {};

  const sections = changedSections(parts.body, body);
  if (!sections.length) sections.push("(blank lines only)");
  if (same && !toCreate.length)
    return {
      ok: true,
      code: 0,
      result: result({ ...found, same: true, ...attached(null) }),
      text: `edit: ${rel} holds this text already; nothing to write.\n`,
    };

  const fileLines = att.files.map((f) => `  file: ${f.path} (${f.type}, ${f.size} bytes) — ${f.state}`);
  const planText = (asking) =>
    [
      `edit ${k.type}: ${rel}`,
      ...(same ? ["  text: unchanged; only the files below are written"] : [`  sections: ${sections.join(", ")}`]),
      ...fileLines,
      ...(addLine ? [`  .gitattributes: + ${GITATTRIBUTES_LINE(layoutDir)}`] : []),
      ...(same ? [] : [`  mark: ${MARK_KEY} "edit <the write's instant>", review_status pending`]),
      ...(asking
        ? []
        : [
            `Nothing written. To write it, ${fromTerminalIn(project)}:`,
            `  ${packageCommand([], "edit", { args: `${shellQuote(rel)} --from <file> --base ${hash}${attach.length ? " --attach <file>" : ""} --write` })}`,
          ]),
    ].join("\n") + "\n";
  if (!values.write)
    return {
      ok: true,
      code: 0,
      result: result({ ...found, sections, same, ...attached(addLine ? "to-change" : null) }),
      text: planText(false),
    };
  if (confirm && !(await confirm(planText(true))))
    return {
      ok: false,
      code: 1,
      result: result({ ...found, sections, declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };

  // The files first (contract 5), each once; what this run made is taken back
  // when the text is not written (contract 6).
  const onWrite = nodeWriteRecorder({ env, project, tool: "edit" });
  let made = { dir: false, files: [], ga: null };
  try {
    made = writeAttachments({ vault, dir: layoutDir, dirAbs: att.dirAbs, files: att.files, addLine });
  } catch (e) {
    undoAttachments(made);
    return fail(errMsg(e), found);
  }
  const recordAttachments = () => {
    for (const f of made.files) onWrite(f.abs, null, f.bytes);
    if (made.ga) onWrite(made.ga.file, made.ga.before, made.ga.after);
  };
  const { refreshViews } = await import("./reconcile.mjs");
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const refresh = () => {
    const rec = refreshViews({ project, env: ctx.ownEnv ? ctx.ownEnv(project) : projectEnv(env, project) });
    const left = rec.failed
      ? [
          {
            what: "the derived views",
            error: rec.error || "a view failed",
            finish: packageCommand([], "reconcile", { args: "--write" }),
          },
        ]
      : [];
    return { rec, left };
  };

  // The same text with files to write (contract 7): the files alone, the text
  // and its mark left as they are, the views refreshed.
  if (same) {
    recordAttachments();
    const { rec, left } = refresh();
    const done = result({
      ...found,
      same: true,
      written: true,
      reconcile: rec.summary,
      left,
      ...attached(made.ga ? "changed" : null),
    });
    const head = `edit ${k.type}: ${rel} holds this text already; ${made.files.length} file${made.files.length === 1 ? "" : "s"} written\n${fileLines.join("\n")}\n`;
    if (!left.length) return { ok: true, code: 0, result: done, text: head };
    return {
      ok: false,
      code: 1,
      result: { ...done, error: `left: the derived views (${left[0].error})` },
      text: `${head}edit: the files were written, but not the derived views (${left[0].error}). Finish it ${fromTerminalIn(project)}:\n  ${left[0].finish}\n`,
    };
  }

  // The write (contract 4): computed from the file as it stands at the write,
  // so another writer's change to the frontmatter or the head is kept; a body
  // whose hash moved is refused. The mark's instant is the write's.
  const mark = `edit ${markInstant(now)}`;
  let newBody = body;
  let r;
  try {
    r = replaceWithRetry(
      abs,
      (b) => {
        const kk = kindOf(b);
        if (!kk.fm || kk.type !== k.type) return { refused: changed };
        const p = splitForEdit(kk.rest);
        if (bodyHash(p.body) !== base) return { refused: changed };
        newBody = bodyFrom(text, p.body);
        return { content: writeOf(kk.fm, p, newBody, mark) };
      },
      { afterCompute, onWrite },
    );
  } catch (e) {
    undoAttachments(made);
    throw e;
  }
  if (r.refused || r.error) undoAttachments(made);
  if (r.refused) return fail(changed, found);
  if (r.error)
    return fail(
      r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${rel} changed before each of ${r.attempts} attempts; nothing was written`
        : r.error,
      found,
    );
  recordAttachments();

  // The derived views (contract 7), as move refreshes them.
  const { rec, left } = refresh();
  const done = result({
    ...found,
    hash: bodyHash(newBody),
    sections,
    written: true,
    mark,
    reconcile: rec.summary,
    left,
    ...attached(made.ga ? "changed" : null),
  });
  const head = `edit ${k.type}: ${rel} written\n  sections: ${sections.join(", ")}\n${fileLines.length ? `${fileLines.join("\n")}\n` : ""}  ${MARK_KEY}: ${mark}, review_status pending\n`;
  if (!left.length) return { ok: true, code: 0, result: done, text: head };
  return {
    ok: false,
    code: 1,
    result: { ...done, error: `left: the derived views (${left[0].error})` },
    text: `${head}edit: ${rel} was written, but not the derived views (${left[0].error}). Finish it ${fromTerminalIn(project)}:\n  ${left[0].finish}\n`,
  };
}

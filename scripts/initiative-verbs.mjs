// projectstore — initiative-verbs.mjs: the verbs that write an initiative's
// decision and fields, and an epic's initiative.
//
// `initiative <id> <accepted|rejected|deferred> --reason "<why>"` records a
// decision: the status, the header's Status row and a dated line at the end of
// the Outcome section. `initiative <id> --title|--owner|--priority` edits
// those fields; the file name stays (ADR-010, decision 6). `epic <EPIC-ID>
// --initiative <id>` sets or, with "", clears an epic's `initiative:` and its
// header's Initiative row. Bare, each prints the plan and writes nothing; with
// --write (a terminal is asked once; without one, or under --json, --write is
// the confirmation) it writes through replaceWithRetry, records the write in
// this session's record, and refreshes the derived views with a bare
// reconcile --write through the core, as `move` does.
//
// Spec: "The initiative kind and its verbs" (alias `initiative`), contracts 9
// to 12; the record spec's contract 5 for the session record. A module of its
// own: initiative.mjs, which doctor, the MCP server and the SessionStart hook
// reach, imports no writer, and no hook or MCP module reaches this file
// (tests/initiative-verbs.test.mjs holds both).
//
// runInitiative(ctx) and runEpic(ctx) follow move's contract: each returns
// {usage} or {ok, code, result, text}, and the bin (cli.mjs) prints and asks.
// Loaded lazily.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { packageCommand } from "./harness.mjs";
import { loadLayout, folderByKind, parseFrontmatter, sectionOf, headingLineRe, fromTerminalIn, today } from "./lib.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import {
  DECIDED,
  statusOf,
  referenceOf,
  initiativeIndex,
  resolveInitiative,
  initiativeIdOf,
  stemOf,
} from "./initiative.mjs";
import {
  oneLine,
  setFm,
  unsetFm,
  setHeaderField,
  upsertHeaderField,
  removeHeaderField,
  touchStory,
  sectionEndBeforeRule,
} from "./status-log.mjs";
import { replaceWithRetry, CHANGED_MEANWHILE } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";

const FIELDS = Object.freeze(["title", "owner", "priority"]);
const errMsg = (e) => (e && e.message ? e.message : String(e));
const given = (v) => v !== undefined;
const fmText = (v) => (v === null || v === undefined ? "" : String(v).trim());

function isDirectory(p) {
  try {
    return typeof p === "string" && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Reading the vault ─────────────────────────────────────────────────

// The initiatives folder's files: {abs, rel, fm, text}. Folder indexes are no
// initiative.
export function readInitiatives(vault, folder) {
  const dir = join(vault, folder);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md");
  } catch {}
  const out = [];
  for (const n of names.sort()) {
    const abs = join(dir, n);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push({ abs, rel: `${folder}/${n}`, fm: parseFrontmatter(text).data, text });
  }
  return out;
}

// Each epic folder's epic.md: {id, abs, rel, fm}.
export function readEpics(vault, folder) {
  const dir = join(vault, folder);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const out = [];
  for (const id of names.sort()) {
    const abs = join(dir, id, "epic.md");
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push({ id, abs, rel: `${folder}/${id}/epic.md`, fm: parseFrontmatter(text).data });
  }
  return out;
}

// The vault, its layout folders and the bound language, or {error}.
function vaultOf(cfg, project) {
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return { error: `the binding names no vault directory that is there (${cfg.vault_path})` };
  let layout;
  try {
    layout = loadLayout(cfg.layout || DEFAULT_LAYOUT);
  } catch (e) {
    return { error: errMsg(e) };
  }
  const initiatives = folderByKind(layout, "initiative");
  if (!initiatives) return { error: `layout ${cfg.layout || DEFAULT_LAYOUT} has no initiative folder` };
  const epics = folderByKind(layout, "epic");
  if (!epics) return { error: `layout ${cfg.layout || DEFAULT_LAYOUT} has no epic folder` };
  return { vault, initiatives: initiatives.path, epics: epics.path, lang: cfg.language || DEFAULT_LANGUAGE };
}

// The initiative a value names, by the one id rule: {hit} or {error}.
function findInitiative(items, arg, folder) {
  const ref = referenceOf(arg);
  const index = initiativeIndex(items);
  const hit = resolveInitiative(index, ref);
  if (hit) return { hit };
  const n = ref.kind === "id" ? (index.get(ref.value) || []).length : 0;
  return {
    error:
      n > 1
        ? `"${ref.value}" is the id of ${n} files in ${folder}; an initiative id names one`
        : `"${ref.kind === "id" ? ref.value : String(arg)}" names no initiative in ${folder}`,
  };
}

// The epics whose `initiative:` names the initiative `hit`, by the id rule.
function epicsNaming(epics, items, hit) {
  const index = initiativeIndex(items);
  return epics.filter((e) => resolveInitiative(index, referenceOf(e.fm.initiative)) === hit);
}

// ─── The pure changes ──────────────────────────────────────────────────

// The text with `line` as the Outcome section's last line: after a list item
// (or its continuation) on the next line, after prose or a comment past a
// blank line. null when the file has no Outcome section.
export function appendOutcomeLine(text, line) {
  const m = text.match(headingLineRe("initiative_outcome"));
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = sectionEndBeforeRule(text, "initiative_outcome");
  const lines = text.slice(start, end).split("\n");
  let last = -1;
  let pos = 0;
  let lastEnd = 0;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim()) {
      last = k;
      lastEnd = pos + lines[k].length;
    }
    pos += lines[k].length + 1;
  }
  if (last === -1) {
    // An empty section: the line, a blank line each side, then what followed.
    // The heading's match may hold its own line break, so it is trimmed too.
    const after = text.slice(end).replace(/^\n+/, "");
    return `${text.slice(0, start).replace(/\n+$/, "")}\n\n${line}\n${after ? `\n${after}` : ""}`;
  }
  const at = start + lastEnd;
  const listy = /^(?:\s+\S|\s*[-*]\s)/.test(lines[last]);
  return `${text.slice(0, at)}${listy ? "\n" : "\n\n"}${line}${text.slice(at)}`;
}

// The H1 after the frontmatter, set to `title`; unchanged when there is none.
function setH1(text, title) {
  const fm = text.match(/^---\n[\s\S]*?\n---/);
  const start = fm ? fm[0].length : 0;
  const rest = text.slice(start);
  const h1 = rest.match(/^# .*$/m);
  if (!h1) return text;
  return text.slice(0, start + h1.index) + `# ${title}` + text.slice(start + h1.index + h1[0].length);
}

// A decision: {content, changes} or {refused}. The line is appended also when
// the status is already the decision (contract 9).
export function applyDecision(text, { decision, reason, day }) {
  const from = statusOf(parseFrontmatter(text).data);
  const line = `- ${day} ${decision}: ${reason}`;
  let t = setFm(text, "status", decision);
  t = setHeaderField(t, "status", decision).text;
  t = appendOutcomeLine(t, line);
  if (t === null) return { refused: "the file has no Outcome section" };
  return {
    content: touchStory(t, day),
    changes: [
      ...(from === decision ? [] : [{ field: "status", from: from || null, to: decision }]),
      { field: "outcome", from: null, to: line },
    ],
  };
}

// The fields: {content, changes}; content is the text itself when nothing
// changes.
export function applyFields(text, { title, owner, priority, day }) {
  const fm = parseFrontmatter(text).data;
  let t = text;
  const changes = [];
  const step = (field, value, apply) => {
    if (value === undefined) return;
    const next = apply(t);
    if (next !== t) changes.push({ field, from: fmText(fm[field]) || null, to: value });
    t = next;
  };
  step("title", title, (x) => setH1(setFm(x, "title", JSON.stringify(title)), title));
  step("owner", owner, (x) => setHeaderField(setFm(x, "owner", JSON.stringify(owner)), "owner", owner).text);
  step("priority", priority, (x) => setHeaderField(setFm(x, "priority", priority), "priority", priority).text);
  return { content: changes.length ? touchStory(t, day) : text, changes };
}

// An epic's initiative: set to {id, link} or cleared (null). {content, changes}.
export function applyEpicInitiative(text, { target, lang, day }) {
  const before = fmText(parseFrontmatter(text).data.initiative) || null;
  let t;
  if (target) {
    t = setFm(text, "initiative", JSON.stringify(target.id));
    t = upsertHeaderField(t, "initiative", target.link, { lang, after: ["priority", "status"] }).text;
  } else {
    t = removeHeaderField(unsetFm(text, "initiative"), "initiative").text;
  }
  if (t === text) return { content: text, changes: [] };
  return {
    content: touchStory(t, day),
    changes: [{ field: "initiative", from: before, to: target ? target.id : null }],
  };
}

// ─── Shared run ────────────────────────────────────────────────────────

function renderPlan(verb, rel, changes, { project, args, asking = false, done = false, reconcile = null }) {
  const lines = [];
  if (!changes.length) lines.push(`${verb}: ${rel} already reads so; nothing to write.`);
  else {
    lines.push(`${verb}: ${rel}${done ? " written" : ""}`);
    for (const c of changes) lines.push(`  ${c.field}: ${c.from ?? "none"} → ${c.to ?? "none"}`);
  }
  if (done && reconcile) lines.push(`  derived views: ${reconcile.written ?? 0} regenerated`);
  if (!done && !asking && changes.length) {
    lines.push(
      `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
    );
    lines.push(`  ${packageCommand([], verb, { args: `${args} --write` })}`);
  }
  return lines.join("\n") + "\n";
}

async function writeRun(ctx, { verb, abs, rel, compute, args }) {
  const { values, project, env, confirm, ownEnv, afterCompute = null } = ctx;
  const result = (extra = {}) => ({
    write: Boolean(values.write),
    path: abs,
    changes: [],
    reconcile: null,
    declined: false,
    error: null,
    ...extra,
  });
  const fail = (message, extra = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra, error: message }),
    text: `${verb}: ${message}\n`,
  });
  // A file the writers cannot read (no frontmatter block, CRLF line ends) is a
  // refusal, exit 1, as move's is, never the dispatcher's usage exit.
  let first;
  try {
    first = compute(readFileSync(abs, "utf8"));
  } catch (e) {
    return fail(`${rel}: ${errMsg(e)}`);
  }
  if (first.refused) return fail(`${rel}: ${first.refused}`);
  const planned = first.changes;
  if (!values.write || !planned.length)
    return {
      ok: true,
      code: 0,
      result: result({ changes: planned }),
      text: renderPlan(verb, rel, planned, { project, args }),
    };
  if (confirm && !(await confirm(renderPlan(verb, rel, planned, { project, args, asking: true }))))
    return {
      ok: false,
      code: 1,
      result: result({ changes: planned, declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };

  // Each write lands in this session's record of its vault writes (the record
  // spec, contract 5), with the verb's name as the tool.
  const onWrite = nodeWriteRecorder({ env, project, tool: verb });
  let changes = planned;
  const r = replaceWithRetry(
    abs,
    (base) => {
      const c = compute(base);
      if (c.refused) return { refused: c.refused };
      changes = c.changes;
      return { content: c.content };
    },
    { afterCompute, onWrite },
  );
  if (r.refused) return fail(`${rel}: ${r.refused}`);
  if (r.error)
    return fail(
      r.error === CHANGED_MEANWHILE
        ? `${CHANGED_MEANWHILE}: ${rel} changed before each of ${r.attempts} attempts; the file is left as the last edit made it`
        : r.error,
    );
  if (!r.written)
    return { ok: true, code: 0, result: result({ changes: [] }), text: renderPlan(verb, rel, [], { project, args }) };

  const { refreshViews } = await import("./reconcile.mjs");
  // The generators find the binding through the project's own environment,
  // never through the caller's working directory.
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  const done = result({ changes, reconcile: rec.summary });
  const text = renderPlan(verb, rel, changes, { project, args, done: true, reconcile: rec.summary });
  if (rec.failed) {
    // Never "run the same command again": a decision appends a line each run.
    const what = `the derived views${rec.error ? ` (${rec.error})` : ""}`;
    return {
      ok: false,
      code: 1,
      result: { ...done, error: `left: ${what}` },
      text: `${text}${verb}: the file was written, but ${what} are left. Run reconcile ${fromTerminalIn(project)}:\n${packageCommand([], "reconcile", { args: "--write" })}\n`,
    };
  }
  return { ok: true, code: 0, result: done, text };
}

// ─── initiative ────────────────────────────────────────────────────────

// The usage checks of contracts 9 and 10: {decision, reason} or {fields}, or
// {usage}. A message names the option, never its value.
export function initiativeUsage(values, positionals) {
  const [id, word, ...extra] = positionals;
  if (!id)
    return {
      usage:
        'initiative takes an initiative id, then a decision with --reason, or --title, --owner or --priority, such as `initiative faster-onboarding accepted --reason "<why>"`',
    };
  if (extra.length) return { usage: "initiative takes one initiative id and at most one decision" };
  const fieldsGiven = FIELDS.filter((f) => given(values[f]));
  if (word !== undefined) {
    const decision = String(word).trim().toLowerCase();
    if (!DECIDED.has(decision))
      return { usage: `"${word}" is not a decision: initiative records accepted, rejected or deferred` };
    if (fieldsGiven.length)
      return { usage: `a decision takes no --${fieldsGiven[0]}: record the decision and edit the fields in two runs` };
    if (values.reason === undefined || values.reason === true)
      return { usage: 'a decision needs --reason "<why>": one line on why it was decided' };
    try {
      return { id, decision, reason: oneLine(values.reason, "--reason") };
    } catch (e) {
      return { usage: e.message };
    }
  }
  if (given(values.reason)) return { usage: "--reason goes with a decision: accepted, rejected or deferred" };
  if (!fieldsGiven.length)
    return {
      usage: "initiative needs a decision (accepted, rejected or deferred) or one of --title, --owner, --priority",
    };
  const fields = {};
  try {
    if (given(values.title)) fields.title = oneLine(values.title, "--title");
    if (given(values.owner)) {
      fields.owner = oneLine(values.owner, "--owner");
      if (fields.owner.includes("@")) return { usage: "--owner is a name, not an email address" };
    }
  } catch (e) {
    return { usage: e.message };
  }
  if (given(values.priority)) {
    const p = String(values.priority).trim().toLowerCase();
    if (!/^p\d+$/.test(p)) return { usage: "--priority is p and digits, such as p1" };
    fields.priority = p;
  }
  return { id, fields };
}

export async function runInitiative(ctx) {
  const { values, positionals, cfg, project, now = null } = ctx;
  const u = initiativeUsage(values, positionals);
  if (u.usage) return { usage: u.usage };
  const day = now ? String(now).slice(0, 10) : today();
  const fail = (message) => ({
    ok: false,
    code: 1,
    result: { write: Boolean(values.write), path: null, changes: [], reconcile: null, declined: false, error: message },
    text: `initiative: ${message}\n`,
  });
  const v = vaultOf(cfg, project);
  if (v.error) return fail(v.error);
  const items = readInitiatives(v.vault, v.initiatives);
  const found = findInitiative(items, u.id, v.initiatives);
  if (found.error) return fail(found.error);
  const hit = found.hit;
  const id = initiativeIdOf(hit);

  if (u.decision) {
    if (sectionOf(parseFrontmatter(hit.text).body, "initiative_outcome") === null)
      return fail(`${hit.rel} has no Outcome section, so a decision has nowhere to go; add the section first`);
    if (u.decision === "accepted" && !epicsNaming(readEpics(v.vault, v.epics), items, hit).length)
      return fail(
        `no epic names ${id} in initiative:, so it cannot be accepted yet. Name it from an epic first:\n${packageCommand([], "epic", { args: `<EPIC-ID> --initiative ${shellQuote(id)} --write` })}`,
      );
    return writeRun(ctx, {
      verb: "initiative",
      abs: hit.abs,
      rel: hit.rel,
      args: `${shellQuote(id)} ${u.decision} --reason ${shellQuote(u.reason)}`,
      compute: (text) => applyDecision(text, { decision: u.decision, reason: u.reason, day }),
    });
  }
  const args = [
    shellQuote(id),
    ...FIELDS.filter((f) => u.fields[f] !== undefined).map((f) => `--${f} ${shellQuote(u.fields[f])}`),
  ];
  return writeRun(ctx, {
    verb: "initiative",
    abs: hit.abs,
    rel: hit.rel,
    args: args.join(" "),
    compute: (text) => applyFields(text, { ...u.fields, day }),
  });
}

// ─── epic ──────────────────────────────────────────────────────────────

export async function runEpic(ctx) {
  const { values, positionals, cfg, project, now = null } = ctx;
  const [epicArg, ...extra] = positionals;
  if (!epicArg || extra.length)
    return { usage: "epic takes one epic id and --initiative, such as `epic PS-CORE --initiative faster-onboarding`" };
  if (values.initiative === undefined || values.initiative === true)
    return { usage: 'epic needs --initiative <id>, or --initiative "" to clear it' };
  const day = now ? String(now).slice(0, 10) : today();
  const fail = (message) => ({
    ok: false,
    code: 1,
    result: { write: Boolean(values.write), path: null, changes: [], reconcile: null, declined: false, error: message },
    text: `epic: ${message}\n`,
  });
  const v = vaultOf(cfg, project);
  if (v.error) return fail(v.error);
  const epicId = String(epicArg).trim();
  const abs = join(v.vault, v.epics, epicId, "epic.md");
  if (!epicId || /[\\/]/.test(epicId) || epicId === "." || epicId === ".." || !existsSync(abs))
    return fail(`"${epicArg}" names no epic in ${v.epics}`);
  const rel = `${v.epics}/${epicId}/epic.md`;

  const value = String(values.initiative).trim();
  let target = null;
  if (value) {
    const items = readInitiatives(v.vault, v.initiatives);
    const found = findInitiative(items, value, v.initiatives);
    if (found.error) return fail(found.error);
    const hit = found.hit;
    const to = relative(dirname(abs), join(v.vault, v.initiatives, stemOf(hit.rel)))
      .split(sep)
      .join("/");
    const title = fmText(hit.fm.title) || initiativeIdOf(hit);
    target = { id: initiativeIdOf(hit), link: `[[${to}|${title}]]` };
  }
  return writeRun(ctx, {
    verb: "epic",
    abs,
    rel,
    args: `${shellQuote(epicId)} --initiative ${shellQuote(target ? target.id : "")}`,
    compute: (text) => applyEpicInitiative(text, { target, lang: v.lang, day }),
  });
}

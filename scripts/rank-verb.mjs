// projectstore — rank-verb.mjs: the `rank` verb, a story's or an epic's place
// among its siblings.
//
// `rank story <EPIC>/<story-id>` or `rank epic <EPIC-ID>`, with exactly one of
// --before <sibling>, --after <sibling>, --first, --last. The verb takes the
// group's order G (rank.mjs siblingOrder), the order G' with the item moved,
// and gives the values decision 3's table names; bare it prints the plan, each
// file with its old and new value, and writes nothing; with --write (a
// terminal is asked once; without one, or under --json, --write is the
// confirmation) it writes only the `rank:` line of each file whose value
// changes, through replaceWithRetry, and records each write in this session's
// record. No date, footer, Status log or mark moves, and no derived view is
// refreshed: none shows `rank`. A failed write restores the files already
// written whose bytes are still the ones it wrote, and lists the others.
//
// Spec: "The rank verb and the sibling order…" (alias `rank`), contracts 3 to
// 9; the record spec's contract 5. A module of its own: no hook and no MCP
// module reaches it (tests/rank.test.mjs holds the fence).
//
// runRank(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageCommand } from "./harness.mjs";
import { loadLayout, folderByKind, fromTerminalIn, parseFrontmatter } from "./lib.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT } from "./binding.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { columnOf } from "./flow-counts.mjs";
import { resolveStory } from "./move.mjs";
import { readEpics, readInitiatives } from "./initiative-verbs.mjs";
import {
  RANK_STEP,
  OPEN_COLUMNS,
  rankOf,
  MAX_RANK_DIGITS,
  digitsOf,
  siblingOrder,
  storyMember,
  epicMember,
  epicGroupKey,
  NO_INITIATIVE,
  isEpicId,
} from "./rank.mjs";
import { initiativeIndex } from "./initiative.mjs";
import { replaceWithRetry, CHANGED_MEANWHILE } from "./status-change.mjs";
import { nodeWriteRecorder } from "./write-record.mjs";

const PLACES = Object.freeze(["before", "after", "first", "last"]);
const KINDS = Object.freeze(["story", "epic"]);
const errMsg = (e) => (e && e.message ? e.message : String(e));
const FM_RE = /^---\n([\s\S]*?)\n---/;
const OPEN = new Set(OPEN_COLUMNS);

function isDirectory(p) {
  try {
    return typeof p === "string" && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── The value table (contract 4) ──────────────────────────────────────

// G' as a list of members: G with the item taken out and put back at the
// place. `place` is {first}, {last}, {before: id} or {after: id}; the sibling
// is a member of G other than the item.
export function moved(G, item, place) {
  const rest = G.filter((m) => m.id !== item.id);
  let at;
  if (place.first) at = 0;
  else if (place.last) at = rest.length;
  else {
    const sib = rest.findIndex((m) => m.id === (place.before ?? place.after));
    at = place.before !== undefined ? sib : sib + 1;
  }
  return { order: [...rest.slice(0, at), item, ...rest.slice(at)], at };
}

// The values decision 3 gives: {same, order, values: Map id → value}, where
// `values` holds only the members whose value changes. `G` is the group in
// siblingOrder, `item` one of its members.
export function planValues(G, item, place, S = RANK_STEP) {
  const { order, at } = moved(G, item, place);
  if (order.every((m, k) => m.id === G[k].id)) return { same: true, order, values: new Map() };
  const L = at > 0 ? order[at - 1] : null;
  const U = at < order.length - 1 ? order[at + 1] : null;
  const others = order.filter((m) => m.id !== item.id);
  const rankedOthers = others.filter((m) => m.rank !== null);
  const M = rankedOthers.length ? Math.max(...rankedOthers.map((m) => m.rank)) : 0;
  // The last ranked member of G' other than the item, by index (-1: none).
  let lastRanked = -1;
  order.forEach((m, k) => {
    if (m.id !== item.id && m.rank !== null) lastRanked = k;
  });
  const want = new Map();
  const renumber = (end) => {
    want.clear();
    for (let k = 0; k <= end; k++) want.set(order[k].id, (k + 1) * S);
  };
  if (U && U.rank !== null) {
    const lo = L ? L.rank : U.rank - 2 * S;
    if (U.rank - lo >= 2) want.set(item.id, Math.floor((lo + U.rank) / 2));
    else renumber(Math.max(lastRanked, at));
  } else if (!L) want.set(item.id, S);
  else if (L.rank !== null) want.set(item.id, L.rank + S);
  else {
    let first = at;
    while (first > 0 && order[first - 1].rank === null) first--;
    let n = 1;
    for (let k = first; k < at; k++) want.set(order[k].id, M + n++ * S);
    want.set(item.id, M + n * S);
  }
  if ([...want.values()].some((v) => digitsOf(v) > MAX_RANK_DIGITS)) renumber(Math.max(lastRanked, at));
  const values = new Map();
  for (const m of order) if (want.has(m.id) && want.get(m.id) !== m.rank) values.set(m.id, want.get(m.id));
  return { same: false, order, values };
}

// ─── The write (contract 5) ────────────────────────────────────────────

// Why a file cannot take a `rank:` line, or null: no frontmatter block for the
// core's parser (CRLF line ends give none), or a `rank:` value that runs over
// more than one line.
export function unparsable(text) {
  const m = String(text).match(FM_RE);
  if (!m) return "it has no frontmatter block the core can read (a file with CRLF line ends has none)";
  const lines = m[1].split("\n");
  const at = lines.flatMap((l, k) => (/^rank:/.test(l) ? [k] : []));
  if (at.length > 1) return "it has more than one rank: line";
  const k = at[0] ?? -1;
  if (k >= 0 && k + 1 < lines.length && /^[ \t-]/.test(lines[k + 1]))
    return "its rank value runs over more than one line";
  return null;
}

// The file's `rank:` line as it is, or null when it has none.
export function rankLineOf(text) {
  const m = String(text).match(FM_RE);
  if (!m) return null;
  return m[1].split("\n").find((l) => /^rank:/.test(l)) ?? null;
}

// The text with its `rank:` line set to `value`: the line replaced in place,
// or inserted right after `type:`, or, with no `type:` line, as the
// frontmatter's first line. Every other byte stays.
export function setRank(text, value) {
  const m = text.match(FM_RE);
  if (!m) throw new Error("the file has no frontmatter block");
  const lines = m[1].split("\n");
  const line = `rank: ${value}`;
  const k = lines.findIndex((l) => /^rank:/.test(l));
  if (k >= 0) lines[k] = line;
  else {
    const t = lines.findIndex((l) => /^type:/.test(l));
    lines.splice(t >= 0 ? t + 1 : 0, 0, line);
  }
  return text.slice(0, m.index) + `---\n${lines.join("\n")}\n---` + text.slice(m.index + m[0].length);
}

// ─── Reading the vault ─────────────────────────────────────────────────

function vaultOf(cfg, project) {
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (!isDirectory(vault)) return { error: `the binding names no vault directory that is there (${cfg.vault_path})` };
  let layout;
  try {
    layout = loadLayout(cfg.layout || DEFAULT_LAYOUT);
  } catch (e) {
    return { error: errMsg(e) };
  }
  const epics = folderByKind(layout, "epic");
  if (!epics) return { error: `layout ${cfg.layout || DEFAULT_LAYOUT} has no epic folder` };
  const initiatives = folderByKind(layout, "initiative");
  return { vault, epics: epics.path, initiatives: initiatives ? initiatives.path : null };
}

const NOT_OPEN = (ref) =>
  `${ref} is not open (done, set aside, or with no status the parser reads): only open stories have a place`;

// The item and its group for a story: {item, group, epic} or {error}.
function storySide(v, itemArg, sibArg) {
  const it = resolveStory(itemArg, { vault: v.vault, epicsPath: v.epics });
  if (it.error) return { error: it.error };
  const epic = String(itemArg).split("/")[0];
  const read = readFlowStories(v.vault, v.epics, { only: epic });
  const members = read.stories.map((s) => ({ ...storyMember(s), abs: join(v.vault, s.rel) }));
  const item = members.find((m) => m.abs === it.path);
  if (!item || !item.open) return { error: NOT_OPEN(itemArg) };
  let sibling = null;
  if (sibArg !== null) {
    const sp = resolveStory(sibArg, { vault: v.vault, epicsPath: v.epics });
    if (sp.error) return { error: sp.error };
    const sEpic = String(sibArg).split("/")[0];
    if (sEpic !== epic) {
      // Read the sibling's own epic only to say whether it is open.
      const other = readFlowStories(v.vault, v.epics, { only: sEpic }).stories.map((s) => ({
        ...storyMember(s),
        abs: join(v.vault, s.rel),
      }));
      const sm = other.find((m) => m.abs === sp.path);
      if (!sm || !sm.open) return { error: NOT_OPEN(sibArg) };
      return { error: `${sibArg} is in epic ${sEpic}, not ${epic}: a story's epic is not changed by rank` };
    }
    sibling = members.find((m) => m.abs === sp.path);
    if (!sibling || !sibling.open) return { error: NOT_OPEN(sibArg) };
    if (sibling.id === item.id) return { error: `${sibArg} is the story being ranked; name another sibling` };
  }
  return { item, sibling, group: members.filter((m) => m.open), label: `epic ${epic}` };
}

// The item and its group for an epic: {item, group} or {error}.
function epicSide(v, itemArg, sibArg) {
  const epics = readEpics(v.vault, v.epics).filter((e) => isEpicId(e.id));
  const initiatives = v.initiatives ? readInitiatives(v.vault, v.initiatives) : [];
  const index = initiativeIndex(initiatives);
  const find = (arg) => epics.find((e) => e.id === String(arg).trim());
  const e = find(itemArg);
  if (!e) return { error: `"${itemArg}" names no epic in ${v.epics}` };
  const key = epicGroupKey(e, index);
  let sibling = null;
  if (sibArg !== null) {
    const s = find(sibArg);
    if (!s) return { error: `"${sibArg}" names no epic in ${v.epics}` };
    if (s.id === e.id) return { error: `${sibArg} is the epic being ranked; name another sibling` };
    const sKey = epicGroupKey(s, index);
    if (sKey !== key) {
      const where = (k) => (k === NO_INITIATIVE ? "no initiative" : `initiative ${k}`);
      return {
        error: `${s.id} is under ${where(sKey)}, ${e.id} under ${where(key)}: rank does not move an epic between initiatives; use \`epic <EPIC-ID> --initiative <id>\``,
      };
    }
    sibling = epicMember({ ...s, abs: s.abs });
  }
  const group = epics.filter((x) => epicGroupKey(x, index) === key).map((x) => epicMember({ ...x, abs: x.abs }));
  return {
    item: group.find((m) => m.id === e.id),
    sibling,
    group,
    label: key === NO_INITIATIVE ? "no initiative" : `initiative ${key}`,
  };
}

// ─── The verb ──────────────────────────────────────────────────────────

export function rankUsage(values, positionals) {
  const [kind, item, ...extra] = positionals;
  if (!kind || !KINDS.includes(kind) || !item || extra.length)
    return "rank takes `story <EPIC-ID>/<story-id>` or `epic <EPIC-ID>`, and one of --before, --after, --first, --last";
  const given = PLACES.filter((p) => values[p] !== undefined && values[p] !== false);
  if (given.length !== 1) return "rank takes exactly one of --before <sibling>, --after <sibling>, --first, --last";
  const p = given[0];
  if ((p === "before" || p === "after") && (typeof values[p] !== "string" || !values[p].trim()))
    return `rank needs a sibling after --${p}`;
  return null;
}

const placeText = (place) =>
  place.first
    ? "first"
    : place.last
      ? "last"
      : place.before !== undefined
        ? `before ${place.before}`
        : `after ${place.after}`;
const placeArgs = (place) =>
  place.first
    ? "--first"
    : place.last
      ? "--last"
      : place.before !== undefined
        ? `--before ${shellQuote(place.before)}`
        : `--after ${shellQuote(place.after)}`;

export async function runRank(ctx) {
  const { values, positionals, cfg, project, env, confirm, afterCompute = null, afterWrite = null } = ctx;
  const usage = rankUsage(values, positionals);
  if (usage) return { usage };
  const [kind, itemArg] = positionals;
  const place = values.first
    ? { first: true }
    : values.last
      ? { last: true }
      : values.before !== undefined
        ? { before: String(values.before).trim() }
        : { after: String(values.after).trim() };
  const sibArg = place.before ?? place.after ?? null;
  const result = (extra = {}) => ({
    write: Boolean(values.write),
    kind,
    item: itemArg,
    place: placeText(place),
    group: null,
    changes: [],
    written: [],
    restored: [],
    unrestored: [],
    declined: false,
    error: null,
    ...extra,
  });
  const fail = (message, extra = {}) => ({
    ok: false,
    code: 1,
    result: result({ ...extra, error: message }),
    text: `rank: ${message}\n`,
  });

  const v = vaultOf(cfg, project);
  if (v.error) return fail(v.error);
  const side = kind === "story" ? storySide(v, itemArg, sibArg) : epicSide(v, itemArg, sibArg);
  if (side.error) return fail(side.error);
  const G = siblingOrder(side.group);
  const sibId = side.sibling ? side.sibling.id : null;
  const p = place.first || place.last ? place : place.before !== undefined ? { before: sibId } : { after: sibId };
  const plan = planValues(G, side.item, p);
  const byId = new Map(G.map((m) => [m.id, m]));
  // Each file of the plan; `changes` is what the plan shows and --json returns.
  const planned = [...plan.values].map(([id, to]) => {
    const m = byId.get(id);
    return { abs: m.abs, path: m.rel, from: m.rank === null ? null : String(m.rank), to: String(to) };
  });
  const changes = planned.map(({ path, from, to }) => ({ path, from, to }));
  const base = { group: side.label, changes };
  const head = `rank: ${side.item.id} ${placeText(place)} (${side.label})`;
  if (plan.same || !changes.length)
    return {
      ok: true,
      code: 0,
      result: result({ group: side.label }),
      text: `${head}\n  ${side.item.id} is already in that place; nothing to write.\n`,
    };

  // Every file to write is read and parsed before the first write (contract 5).
  for (const c of planned) {
    const abs = c.abs;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (e) {
      return fail(`${c.path} cannot be read: ${errMsg(e)}`, base);
    }
    const why = unparsable(text);
    if (why) return fail(`${c.path} cannot take a rank: ${why}`, base);
  }

  const planText = (asking) => {
    const lines = [head];
    for (const c of changes) lines.push(`  ${c.path}: rank ${c.from ?? "none"} → ${c.to}`);
    lines.push(`  ${changes.length} file${changes.length === 1 ? "" : "s"} to write`);
    if (!asking) {
      lines.push(
        `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      );
      lines.push(
        `  ${packageCommand([], "rank", { args: `${kind} ${shellQuote(itemArg)} ${placeArgs(place)} --write` })}`,
      );
    }
    return lines.join("\n") + "\n";
  };
  if (!values.write) return { ok: true, code: 0, result: result(base), text: planText(false) };
  if (confirm && !(await confirm(planText(true), changes.length)))
    return {
      ok: false,
      code: 1,
      result: result({ ...base, declined: true, error: "declined" }),
      text: "Nothing written.\n",
    };

  // Each write, and each restore, lands in this session's record (contract 9).
  const onWrite = nodeWriteRecorder({ env, project, tool: "rank" });
  const done = []; // {c, abs, before, after}
  let failure = null;
  for (const c of planned) {
    const abs = c.abs;
    let wrote = null;
    const r = replaceWithRetry(
      abs,
      (b) => {
        // Judged again on the bytes there now (contract 5): a file that cannot
        // be parsed, a rank another writer set, or a story no longer open
        // stops the move.
        const why = unparsable(b);
        if (why) return { refused: `cannot take a rank: ${why}` };
        const fm = parseFrontmatter(b).data;
        const now = rankOf(fm);
        const was = c.from === null ? null : Number(c.from);
        if (now !== was)
          return { refused: `its rank is now ${now ?? "none"}, not ${was ?? "none"} as the plan read it` };
        if (kind === "story" && !OPEN.has(columnOf(fm.status))) return { refused: "the story is no longer open" };
        return { content: setRank(b, c.to) };
      },
      {
        afterCompute: afterCompute ? (i) => afterCompute(abs, i) : null,
        onWrite: (path, before, after) => {
          wrote = { before, after };
          onWrite(path, before, after);
        },
      },
    );
    if (r.written && wrote) {
      done.push({ c, abs, ...wrote });
      if (afterWrite) afterWrite(abs);
      continue;
    }
    if (r.refused || r.error) {
      failure = {
        c,
        message: r.refused
          ? `${c.path}: ${r.refused}`
          : r.error === CHANGED_MEANWHILE
            ? `${CHANGED_MEANWHILE}: ${c.path} changed before each of ${r.attempts} attempts`
            : `${c.path}: ${r.error}`,
      };
      break;
    }
    // Not reachable while the plan holds only changed values (the judgement
    // compares the old one): a file left as it was is still not a move done.
    failure = { c, message: `${c.path}: not written` };
    break;
  }

  if (failure) {
    const restored = [];
    const unrestored = [];
    for (const d of done.reverse()) {
      // Back to the bytes that write replaced, only while the file still holds
      // the bytes the verb wrote (contract 6); recorded as a write (9).
      const back = replaceWithRetry(d.abs, (b) => (b === d.after ? { content: d.before } : { refused: "changed" }), {
        onWrite,
      });
      if (back.written) restored.push(d.c.path);
      else unrestored.push({ path: d.c.path, line: rankLineOf(d.before) });
    }
    const lines = [`rank: ${failure.message}; nothing more was written.`];
    for (const p2 of restored) lines.push(`  restored: ${p2}`);
    for (const u of unrestored)
      lines.push(
        `  not restored (changed since the write, or the restore failed): ${u.path}; ${u.line === null ? "remove its rank: line" : `put back \`${u.line}\``} by hand`,
      );
    return {
      ok: false,
      code: 1,
      result: result({
        ...base,
        written: [],
        restored: restored.reverse(),
        unrestored: unrestored.reverse(),
        error: failure.message,
      }),
      text: lines.join("\n") + "\n",
    };
  }

  const written = done.map((d) => d.c.path);
  const lines = [`${head}: written`];
  for (const c of changes) lines.push(`  ${c.path}: rank ${c.from ?? "none"} → ${c.to}`);
  return { ok: true, code: 0, result: result({ ...base, written }), text: lines.join("\n") + "\n" };
}

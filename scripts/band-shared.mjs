// projectstore — band-shared.mjs: what the band above the prompt and the
// status line agree on, in one place both can load.
//
// The band is a Claude Code hooks module (hooks/band.tsx). A module runs with
// no Node: it may import this file only because this file imports nothing
// but other Node-free files of the plugin. Keep it that way — a `node:`
// import here, or in anything it imports, stops the module from loading.
// Everything here is pure, so the node tests reach every rule the band draws
// by without a host.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield (the contract numbers below are that spec's).

// ─── The heartbeat (contracts 10, 11) ──────────────────────────────────
// While a session's band draws, the module keeps a small file fresh in the
// session-state directory; the status line yields its own line only while
// that file says it is drawing and is younger than the window. Anything else
// — missing, unreadable, stale, from the future, or `drawn: false` — is no
// band, so a band that cannot draw always gives the line back.

export const HEARTBEAT_WINDOW_MS = 30_000;

// The heartbeat's file name for a session: dot-prefixed, like the renderer's
// own breadcrumb, so doctor's listing of hook-side session ids never reads it
// as one. Null for an id that cannot name a file.
export function heartbeatFile(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (/[\/\\\0]/.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  return `.band-${sessionId}.json`;
}

export function heartbeatBody(drawn, now) {
  return { drawn: drawn === true, drawn_at: now };
}

// `drawing` | `stopped` | `stale` | `none`, for a parsed heartbeat (or
// whatever JSON.parse returned) at `now`.
export function heartbeatState(value, now) {
  if (!value || typeof value !== "object" || typeof value.drawn !== "boolean") return "none";
  if (value.drawn === false) return "stopped";
  const at = value.drawn_at;
  if (typeof at !== "number" || !Number.isFinite(at)) return "none";
  const age = now - at;
  return age >= 0 && age < HEARTBEAT_WINDOW_MS ? "drawing" : "stale";
}

export function heartbeatYields(value, now) {
  return heartbeatState(value, now) === "drawing";
}

// What a tick writes, from what the band's last render did: `drew` and
// `survey` (held back only by a question) keep the heartbeat fresh; anything
// else writes `drawn: false` once — `wasDrawing` says whether the last write
// was a drawing one — and then nothing.
export function heartbeatNext(lastRender, wasDrawing, now) {
  if (lastRender === "drew" || lastRender === "survey") return heartbeatBody(true, now);
  return wasDrawing ? heartbeatBody(false, now) : null;
}

// ─── Words (contract 14) ───────────────────────────────────────────────
// Every word the band draws that is not a title, an id, a path, a model id
// or a command token: one `band_` key per word, in every bundled
// templates/<lang>/strings.json, the English file the fallback per key.

export const BAND_STRING_KEYS = Object.freeze([
  "band_this_session", "band_pinned", "band_goal", "band_story", "band_agent",
  "band_done", "band_in_work", "band_backlog", "band_stories", "band_no_stories",
  "band_more", "band_hint", "band_ended_done", "band_ended_stopped",
  "band_verb_critic", "band_verb_reviewer", "band_verb_planner", "band_verb_clerk",
  "band_verb_librarian", "band_verb_archaeologist", "band_verb_other",
  "band_step_reads", "band_step_writes", "band_step_edits", "band_step_searches",
  "band_step_runs", "band_step_web", "band_step_vault",
]);

// The band's words for a language: the English file's, each overlaid by the
// language's own where it has one. Null when the English file lacks one of
// them — the band then draws nothing rather than invent words.
export function mergeWords(en, local) {
  const out = {};
  for (const k of BAND_STRING_KEYS) {
    const v = (local && typeof local[k] === "string" && local[k]) || (en && typeof en[k] === "string" && en[k]) || null;
    if (!v) return null;
    out[k] = v;
  }
  return out;
}

// ─── The goal (contract 7) ─────────────────────────────────────────────

// The goal heading's spellings for the bound language, from the heading
// registry (scaffold/headings.json); English when the language has none.
export function goalForms(registry, lang) {
  const g = registry && registry.headings && registry.headings.goal;
  if (!g) return [];
  return (lang && Array.isArray(g[lang]) && g[lang].length ? g[lang] : g.en) || [];
}

// Wiki links and markdown links to their text, emphasis and code marks off,
// whitespace collapsed.
export function inlineText(md) {
  return String(md)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The first paragraph under the epic's goal heading, on one line; "" when
// there is no such heading or the paragraph is empty. A template comment
// standing alone is not a paragraph.
export function goalOf(epicText, forms) {
  if (!forms || !forms.length) return "";
  const lines = String(epicText).replace(/\r\n/g, "\n").split("\n");
  const want = new Set(forms.map((f) => f.trim()));
  const at = lines.findIndex((l) => /^##\s/.test(l) && want.has(l.replace(/^##\s+/, "").trim()));
  if (at < 0) return "";
  const para = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    if (/^<!--.*-->$/.test(line.trim())) continue;
    para.push(line);
  }
  return inlineText(para.join(" "));
}

// ─── Story files (contract 9) ──────────────────────────────────────────
// The files the board lists for one epic folder (lib.mjs listEpicStories):
// stories/*.md, stories/<slug>/README.md, and a story-*.md beside epic.md.
// `fs` is `{ list(dir) → [{ name, kind }], exists(path) → boolean }`, each
// possibly async, so the module passes its own and a test passes node's.

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function storyFiles(fs, epicDir) {
  const out = [];
  const stories = `${epicDir}/stories`;
  let entries = [];
  try { entries = await fs.list(stories); } catch { entries = []; }
  for (const e of [...entries].sort(byName)) {
    if (e.kind === "file" && e.name.endsWith(".md")) out.push(`${stories}/${e.name}`);
    else if (e.kind === "dir" && (await fs.exists(`${stories}/${e.name}/README.md`))) out.push(`${stories}/${e.name}/README.md`);
  }
  let beside = [];
  try { beside = await fs.list(epicDir); } catch { beside = []; }
  for (const e of [...beside].sort(byName)) {
    if (e.kind === "file" && e.name.startsWith("story-") && e.name.endsWith(".md")) out.push(`${epicDir}/${e.name}`);
  }
  return out;
}

// An epic id the band may put in a path: one segment the board would list
// (not hidden, not a `_templates`-style folder).
export function isEpicName(id) {
  return typeof id === "string" && /^[^/\\\0]+$/.test(id) && id !== ".." && !id.startsWith(".") && !id.startsWith("_");
}

// ─── Display width ─────────────────────────────────────────────────────
// Terminal cells: wide (East Asian, emoji) characters take two, combining
// marks and variation selectors none.

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f]];
const within = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

export function cellWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (within(cp, ZERO)) continue;
    w += within(cp, WIDE) ? 2 : 1;
  }
  return w;
}

// ─── Rows (contracts 3, 5) ─────────────────────────────────────────────

export const ROW_PRIORITY = Object.freeze(["head", "progress", "goal", "story", "agent"]);
const DRAW_ORDER = Object.freeze(["head", "goal", "progress", "story", "agent"]);

// Which rows to draw for `maxRows`: the rows that have content, taken in
// priority order until maxRows are taken (a row without content frees its
// slot), returned in drawing order.
export function planRows(has, maxRows) {
  const taken = new Set();
  for (const row of ROW_PRIORITY) {
    if (taken.size >= maxRows) break;
    if (has[row]) taken.add(row);
  }
  return DRAW_ORDER.filter((r) => taken.has(r));
}

export const totalOf = (c) => c.done + c.active + c.backlog;
export const pctOf = (c) => (totalOf(c) ? Math.round((100 * c.done) / totalOf(c)) : 0);

export function countsText(c, w) {
  return `${pctOf(c)}%  ${c.done} ${w.band_done} · ${c.active} ${w.band_in_work} · ${c.backlog} ${w.band_backlog} · ${totalOf(c)} ${w.band_stories}`;
}

export function segments(c, width) {
  const t = totalOf(c) || 1;
  const d = Math.round((c.done / t) * width);
  const a = Math.round(((c.done + c.active) / t) * width) - d;
  return { d, a, b: Math.max(0, width - d - a) };
}

export const BAR_MIN = 6;
export const BAR_MAX = 40;

// The terminal's progress row: `   <bar>  <counts>[  <hint>]`, inside a box
// padded by one column each side. The counts are never cut: when the row
// cannot hold the minimum bar, the counts and the hint, the hint goes first,
// then the bar (width 0).
export function progressLayout(counts, hint, bodyColumns) {
  const room = bodyColumns - 2 - 3 - 2 - cellWidth(counts) - 1;
  const hintCells = hint ? cellWidth(`  ${hint}`) : 0;
  if (hint && room - hintCells >= BAR_MIN) return { bar: Math.min(BAR_MAX, room - hintCells), hint: true };
  return { bar: room >= BAR_MIN ? Math.min(BAR_MAX, room) : 0, hint: false };
}

// ─── The agent row (contract 12) ───────────────────────────────────────

export const AGENT_PREFIX = "projectstore:";
export const LINGER_MS = 90_000;

// `claude-opus-5-5[1m]` reads `opus 5.5`; any other id as given.
export function modelLabel(id) {
  if (typeof id !== "string" || !id) return null;
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id;
}

const DERIVED = /(^|\/)(README|kanban|graph|code-map)\.md$/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The first vault document the prompt names: a path under the vault, or one
// that starts with one of the layout's kind folders; vault-relative, or null.
export function subjectPath(prompt, vault, kindFolders) {
  const text = String(prompt || "");
  const found = [];
  if (vault) {
    for (const m of text.matchAll(new RegExp(`${escRe(vault)}/([^\\s\`'")\\]]+?\\.md)`, "g"))) found.push({ at: m.index, rel: m[1] });
  }
  const kinds = (kindFolders || []).filter(Boolean).map(escRe);
  if (kinds.length) {
    const re = new RegExp(`(?:^|[\\s\`'"(\\[])((?:${kinds.join("|")})\\/[^\\s\`'")\\]]+?\\.md)`, "g");
    for (const m of text.matchAll(re)) found.push({ at: m.index + m[0].length - m[1].length, rel: m[1] });
  }
  found.sort((a, b) => a.at - b.at);
  const hit = found.find((f) => !DERIVED.test(f.rel));
  return hit ? hit.rel : null;
}

const stem = (rel) => rel.split("/").pop().replace(/\.md$/, "");

// The subject as shown: its title in «», else the file's stem.
export function subjectLabel(rel, title) {
  return title ? `«${title}»` : stem(rel);
}

const ROLE_VERBS = ["critic", "reviewer", "planner", "clerk", "librarian", "archaeologist"];

// `<verb> <subject>`, the verb by role; the task's description as given when
// the prompt named no document.
export function phraseOf(role, subject, description, w) {
  if (!subject) return description || "";
  const verb = ROLE_VERBS.includes(role) ? w[`band_verb_${role}`] : w.band_verb_other;
  return `${verb} ${subject}`;
}

const lastSegment = (p) => String(p).replace(/\/+$/, "").split("/").pop();
const vaultRel = (vault, p) => (vault && p.startsWith(`${vault}/`) ? p.slice(vault.length + 1) : lastSegment(p));

// `node /x/reconcile.mjs --a` reads `reconcile`, `git diff --stat` reads `git diff`.
export function commandWord(command) {
  const words = String(command).replace(/^(\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "").trim().split(/\s+/).filter((x) => !/^\w+=/.test(x));
  const [cmd = "", arg = ""] = words.map((x) => x.replace(/^["']|["']$/g, ""));
  if (/^(node|python3?|bash|sh|npx|bun|deno|tsx)$/.test(lastSegment(cmd)) && arg && !arg.startsWith("-")) return lastSegment(arg).replace(/\.(m?js|cjs|py|sh|ts)$/, "");
  return /^[a-z][\w:-]*$/.test(arg) ? `${lastSegment(cmd)} ${arg}` : lastSegment(cmd);
}

const QUIET = /^(echo|printf|true|sleep|:)(\s|$)/;

// An agent's last step from its latest tool call, or null when the call says
// nothing worth a row (an echo, a tool the band does not name).
export function stepOf(call, vault, w) {
  const tool = typeof call.tool === "string" ? call.tool : "";
  const path = typeof call.file_path === "string" ? call.file_path : typeof call.notebook_path === "string" ? call.notebook_path : null;
  if (tool === "Read" && path) return `${w.band_step_reads} ${vaultRel(vault, path)}`;
  if (tool === "Write" && path) return `${w.band_step_writes} ${vaultRel(vault, path)}`;
  if ((tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") && path) return `${w.band_step_edits} ${vaultRel(vault, path)}`;
  if (tool === "Grep" || tool === "Glob") {
    if (typeof call.pattern !== "string") return w.band_step_searches;
    return `${w.band_step_searches} ${call.pattern.length > 32 ? call.pattern.slice(0, 31) + "…" : call.pattern}`;
  }
  if (tool === "Bash" && typeof call.command === "string") {
    const said = typeof call.description === "string" ? call.description.trim() : "";
    if (said) return said.replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());
    const cmd = commandWord(call.command);
    return QUIET.test(cmd) ? null : `${w.band_step_runs} ${cmd}`;
  }
  if (tool === "WebFetch" || tool === "WebSearch") return w.band_step_web;
  const mcp = tool.match(/^mcp__.*projectstore__(\w+)$/);
  if (mcp) return `${w.band_step_vault} ${mcp[1].replace(/_/g, " ")}`;
  return null;
}

// The agent the row shows: the most recently started running one, else the
// most recently ended one within the linger; and how many others linger.
// `agents` is in spawn order, so on a tie the later one leads.
export function leadAgent(agents, now) {
  const live = agents.filter((a) => a.status === "running" || now - (a.endedAt ?? now) < LINGER_MS);
  const order = new Map(live.map((a, i) => [a, i]));
  const later = (a, b) => order.get(b) - order.get(a);
  const running = live.filter((a) => a.status === "running").sort((a, b) => b.startedAt - a.startedAt || later(a, b));
  const ended = live.filter((a) => a.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || later(a, b));
  const lead = running[0] || ended[0] || null;
  return { lead, others: lead ? live.length - 1 : 0, live };
}

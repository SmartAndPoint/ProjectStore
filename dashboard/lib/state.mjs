// What the page shows, read from the vault on every request. Nothing is kept
// between requests: the vault's files are the only state, and every reader
// takes the context openCore() returned (`ctx`) as its first argument.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

// The board's columns, as the core's status table (scripts/stages.mjs) names them.
export const CORE_COLUMNS = Object.freeze(["Backlog", "ToDo", "In Progress", "Review", "Done"]);
// What an initiative records: a decision. Where it stands beyond that is read
// from the work under it (initiativeStage).
export const INITIATIVE_STATUSES = Object.freeze(["proposed", "accepted", "rejected", "deferred"]);
// The folder of initiatives: not a layout folder yet.
export const INITIATIVES = "initiatives";

// The files of the vault a document may show: pictures, video, sound, PDF.
export const MEDIA_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
});

// ── the one path rule ──
// A path a route takes is vault-relative: not empty, not absolute, no `\`, no
// NUL, no `.`, `..` or hidden segment, and, after every symlink is followed,
// still a file inside the vault under no hidden segment. A document
// (`/api/item`, `/api/related`) is a Markdown file under one of the layout's
// folders or initiatives/; a file a document shows (`/vault/`, `media`) is a
// picture, a video, a sound or a PDF anywhere in the vault. The answer is the
// file's real path, or null.
export const readableRoots = (ctx) => [...ctx.layout.folders.map((f) => f.path), INITIATIVES];
const hidden = (segs) => segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."));
export function readableRel(ctx, rel, { media = false } = {}) {
  if (typeof rel !== "string" || !rel) return null;
  if (rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  if (hidden(rel.split("/"))) return null;
  if (media) {
    if (!Object.hasOwn(MEDIA_TYPES, extname(rel).toLowerCase())) return null;
  } else if (!rel.endsWith(".md") || !readableRoots(ctx).some((root) => rel.startsWith(`${root}/`))) return null;
  try {
    const base = realpathSync(ctx.vault);
    const real = realpathSync(join(ctx.vault, rel));
    if (!real.startsWith(base + sep) || hidden(relative(base, real).split(sep)) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// True when `rel`, with its links resolved, is still a file inside the vault. The lists
// (/api/state, /api/artifacts) skip what is not, as the path rule refuses it for one file.
export function insideVault(ctx, rel) {
  try {
    const base = realpathSync(ctx.vault);
    return realpathSync(join(ctx.vault, rel)).startsWith(base + sep);
  } catch {
    return false;
  }
}

// ── small readers ──
const stem = (rel) => rel.split("/").pop().replace(/\.md$/, "");
const num = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};
export const epicsPathOf = (ctx) => ctx.lib.folderByKind(ctx.layout, "epic")?.path ?? null;
const fmOf = (ctx, text) => ctx.lib.parseFrontmatter(text).data;

// The text of one section, by the core's headings registry (any language the
// registry knows), cut at a `---` rule and without its HTML comments.
function sectionText(ctx, text, id) {
  const s = ctx.lib.sectionOf(text, id);
  if (s === null || s === undefined) return "";
  const rule = s.search(/^---\s*$/m);
  return (rule === -1 ? s : s.slice(0, rule)).replace(/<!--[\s\S]*?-->/g, "").trim();
}
// The checkbox items of a section, by the core's checklist reader.
const checklist = (ctx, body) =>
  ctx.lib
    .checklistItems(body.split("\n"))
    .filter((i) => i.text.trim())
    .map((i) => ({ done: i.checked, text: i.text.trim() }));

// Whether a story may enter ToDo, as the design note words it: its
// Description and at least one acceptance criterion are filled. The core has
// no reader for this yet.
function readiness(ctx, text) {
  const missing = [];
  if (!sectionText(ctx, text, "description").replace(/\*\*Independent test:\*\*/g, "").trim()) missing.push("a Description");
  if (!checklist(ctx, sectionText(ctx, text, "acceptance")).length) missing.push("an acceptance criterion");
  return { ok: missing.length === 0, missing };
}

const readFile = (abs) => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};
const listDir = (abs) => {
  try {
    return readdirSync(abs).sort();
  } catch {
    return [];
  }
};

// ── stories, epics, initiatives, people ──
function readStories(ctx, now) {
  const epicsPath = epicsPathOf(ctx);
  const read = epicsPath ? ctx.flowStories.readFlowStories(ctx.vault, epicsPath) : { stories: [], unread: 0 };
  const { unread } = read;
  const stories = read.stories.filter((s) => insideVault(ctx, s.rel));
  const facts = stories.map(ctx.flowCounts.storyFacts);
  const list = facts.map((f) => {
    const id = f.fm.id || (stem(f.rel) === "README" ? f.rel.split("/").slice(-2)[0] : stem(f.rel));
    return {
      ref: `${f.epic}/${id}`,
      epic: f.epic,
      rel: f.rel,
      title: f.fm.title || id,
      status: f.status || "planned",
      column: f.column, // the board's column, as kanban.md shows it; null: set aside, on no column
      priority: /^p[0-3]$/.test(f.fm.priority || "") ? f.fm.priority : "p2",
      rank: num(f.fm.rank),
      assignee: f.assignee,
      variant: f.fm.variant || null,
      initiative: f.fm.initiative || null,
      awaiting: f.awaiting,
      ageDays: f.age.at ? ctx.flowCounts.ageDays(f.age.at, now) : null,
      updated: f.fm.updated || f.fm.created || null,
      closedAt: f.fm.closed_at || null,
      subtasks: checklist(ctx, sectionText(ctx, f.text, "decomposition")),
      ready: readiness(ctx, f.text),
    };
  });
  return { list, facts, unread };
}

function readEpics(ctx) {
  const epicsPath = epicsPathOf(ctx);
  const out = [];
  if (!epicsPath) return out;
  for (const id of listDir(join(ctx.vault, epicsPath))) {
    if (id.startsWith("_") || id.startsWith(".") || !insideVault(ctx, `${epicsPath}/${id}/epic.md`)) continue;
    const text = readFile(join(ctx.vault, epicsPath, id, "epic.md"));
    if (text === null) continue;
    const fm = fmOf(ctx, text);
    out.push({
      id,
      rel: `${epicsPath}/${id}/epic.md`,
      title: fm.title || id,
      status: String(fm.status || "planned").toLowerCase(),
      priority: fm.priority || "p2",
      initiative: fm.initiative || null,
      standing: String(fm.standing) === "true",
    });
  }
  return out;
}

// initiatives/*.md, README.md aside, by the core's frontmatter parser. None
// when the folder is absent.
function readInitiatives(ctx) {
  const out = [];
  for (const name of listDir(join(ctx.vault, INITIATIVES))) {
    if (!name.endsWith(".md") || name === "README.md" || !insideVault(ctx, `${INITIATIVES}/${name}`)) continue;
    const text = readFile(join(ctx.vault, INITIATIVES, name));
    if (text === null) continue;
    const fm = fmOf(ctx, text);
    out.push({
      id: fm.id || name.replace(/\.md$/, ""),
      rel: `${INITIATIVES}/${name}`,
      title: fm.title || name,
      status: String(fm.status || "proposed").toLowerCase(),
      priority: fm.priority || "p2",
      owner: fm.owner || "",
      elaboration: fm.elaboration || null,
    });
  }
  return out;
}

// An agent is a policy entry named `agent:<name>`: the vault's own habit,
// not a rule of the core.
const kindOf = (name) => (name.startsWith("agent:") ? "agent" : "person");

// People from the vault's flow policy, by the core's own reader and its own
// limit rule, with what each holds now.
function readPeople(ctx, policy, facts, stories) {
  const held = ctx.flowCounts.wipByPerson(facts);
  const queued = new Map();
  for (const s of stories) if (s.column === "ToDo" && s.assignee) queued.set(s.assignee, (queued.get(s.assignee) || 0) + 1);
  const out = [];
  for (const [name, p] of ctx.flowPolicy.flowPeople(policy)) {
    out.push({
      name,
      kind: kindOf(name),
      time: p.time || null,
      left: p.left || null,
      limit: ctx.flowPolicy.wipLimitOf(policy, name),
      held: held.get(name)?.held.length || 0,
      awaiting: held.get(name)?.awaiting.length || 0,
      queued: queued.get(name) || 0,
    });
  }
  return out;
}

// Where an initiative stands. Only the decision is recorded in its file
// (proposed, accepted, rejected, deferred); the rest follows the work under
// it, the way an epic's state follows its stories.
function initiativeStage(i, counts, epics, work) {
  if (i.status === "rejected" || i.status === "deferred") return i.status;
  if (i.status !== "accepted") return work && (work.column === "In Progress" || work.column === "Review") ? "elaborating" : "proposed";
  const total = counts.done + counts.active + counts.backlog;
  if (epics && total && counts.done === total) return "done";
  if (epics && counts.active > 0) return "in-progress";
  return "accepted";
}

export function readState(ctx) {
  const now = Date.now();
  const policy = ctx.lib.readVaultConfig(ctx.vault);
  const { list: stories, facts, unread } = readStories(ctx, now);
  const epics = readEpics(ctx).map((e) => {
    const mine = stories.filter((s) => s.epic === e.id);
    return { ...e, counts: ctx.stages.foldStages(mine.map((s) => s.status)), stories: mine.length };
  });
  const initiatives = readInitiatives(ctx).map((i) => {
    const mine = epics.filter((e) => e.initiative === i.id);
    const counts = { done: 0, active: 0, backlog: 0 };
    for (const e of mine) for (const k of Object.keys(counts)) counts[k] += e.counts[k];
    const work = i.elaboration ? stories.find((x) => x.ref === i.elaboration) : null;
    return { ...i, epics: mine.map((e) => e.id), counts, stage: initiativeStage(i, counts, mine.length, work) };
  });
  return {
    vault: ctx.vault,
    project: { dir: ctx.project, name: basename(ctx.project) },
    coreVersion: ctx.version,
    asOf: new Date(now).toISOString(),
    unread,
    initiatives,
    epics,
    stories,
    people: readPeople(ctx, policy, facts, stories),
    // Every name that stands as a story's assignee, once each: a vault with no
    // flow policy still has its people.
    assignees: [...new Set(stories.map((s) => s.assignee).filter(Boolean))].sort(),
    board: { columns: CORE_COLUMNS.map((name) => ({ name, shows: [name], limit: null })), lanes: "none" },
    coreColumns: [...CORE_COLUMNS],
    initiativeStatuses: [...INITIATIVE_STATUSES],
  };
}

// ── one document, every document ──
export function readItem(ctx, rel) {
  const file = readableRel(ctx, rel);
  if (!file) return null;
  const text = readFile(file);
  if (text === null) return null;
  const { data: fm, body } = ctx.lib.parseFrontmatter(text);
  return {
    rel,
    type: String(fm.type || "").toLowerCase(),
    title: fm.title || stem(rel),
    status: fm.status || null,
    body,
  };
}

// Every artifact by path, title and kind: for links between documents and
// for the search.
export function readArtifacts(ctx) {
  const out = [];
  const add = (rel, kind) => {
    if (!insideVault(ctx, rel)) return; // a link out of the vault is not listed
    const text = readFile(join(ctx.vault, rel));
    if (text === null) return; // a file that cannot be read is not linked to
    const fm = fmOf(ctx, text);
    out.push({ rel, type: String(fm.type || kind || "").toLowerCase(), title: fm.title || stem(rel), status: fm.status || null, id: fm.id || null });
  };
  const flat = (folder, kind) => {
    for (const name of listDir(join(ctx.vault, folder))) if (name.endsWith(".md") && name !== "README.md") add(`${folder}/${name}`, kind);
  };
  flat(INITIATIVES, "initiative");
  for (const f of ctx.layout.folders) if (f.kind !== "epic") flat(f.path, f.kind);
  const epicsPath = epicsPathOf(ctx);
  if (epicsPath) {
    for (const id of listDir(join(ctx.vault, epicsPath))) if (!/^[._]/.test(id) && existsSync(join(ctx.vault, epicsPath, id, "epic.md"))) add(`${epicsPath}/${id}/epic.md`, "epic");
    for (const s of ctx.flowStories.readFlowStories(ctx.vault, epicsPath).stories)
      if (insideVault(ctx, s.rel))
        out.push({ rel: s.rel, type: "story", title: s.fm.title || s.slug, status: s.fm.status || null, id: s.fm.id || null, epic: s.epic });
  }
  return out;
}

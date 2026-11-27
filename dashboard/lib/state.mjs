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
// The core's facts of every story inside the vault, read once for /api/state and Reports
// (dashboard-reports). A fact holds the story's whole text: never send one.
export function readFacts(ctx) {
  const epicsPath = epicsPathOf(ctx);
  const read = epicsPath ? ctx.flowStories.readFlowStories(ctx.vault, epicsPath) : { stories: [], unread: 0 };
  return { facts: read.stories.filter((s) => insideVault(ctx, s.rel)).map(ctx.flowCounts.storyFacts), unread: read.unread };
}
function readStories(ctx, now) {
  const { facts, unread } = readFacts(ctx);
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
      // The order of its epic's open stories (the spec dashboard-rank, contract 1):
      // filled by readState through the core's siblingOrder.
      ranked: ctx.rank.rankOf(f.fm) !== null,
      place: null,
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

export function readEpics(ctx) {
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
      fm, // for the order only; readState drops it
    });
  }
  return out;
}

// initiatives/*.md, README.md aside, by the core's frontmatter parser. None
// when the folder is absent.
export function readInitiatives(ctx) {
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
      fm, // for the order only; readState drops it
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

// Each group's order, by the core (the spec dashboard-rank, contract 1): a
// story's place among its epic's open stories, by its path; an epic's group
// (the initiative id the core resolves, or null) and its place in it, by id.
function groupOrder(ctx, facts, epics, initiatives) {
  const stories = new Map();
  for (const members of ctx.rank.storyGroups(facts).values()) ctx.rank.siblingOrder(members).forEach((m, k) => stories.set(m.rel, k));
  const byEpic = new Map();
  const groups = ctx.rank.epicGroups(
    epics.map((e) => ({ id: e.id, rel: e.rel, fm: e.fm })),
    initiatives.map((i) => ({ rel: i.rel, fm: i.fm })),
  );
  for (const [group, members] of groups) ctx.rank.siblingOrder(members).forEach((m, k) => byEpic.set(m.id, { group, place: k, ranked: m.rank !== null }));
  return { stories, epics: byEpic };
}

export function readState(ctx) {
  const now = Date.now();
  const policy = ctx.lib.readVaultConfig(ctx.vault);
  const { list: stories, facts, unread } = readStories(ctx, now);
  const readEpicList = readEpics(ctx);
  const readInitiativeList = readInitiatives(ctx);
  const order = groupOrder(ctx, facts, readEpicList, readInitiativeList);
  for (const s of stories) s.place = order.stories.get(s.rel) ?? null;
  const epics = readEpicList.map(({ fm, ...e }) => {
    const mine = stories.filter((s) => s.epic === e.id);
    const at = order.epics.get(e.id) || { group: null, place: null, ranked: false };
    return { ...e, ...at, counts: ctx.stages.foldStages(mine.map((s) => s.status)), stories: mine.length };
  });
  const initiatives = readInitiativeList.map(({ fm, ...i }) => {
    const mine = epics.filter((e) => e.initiative === i.id);
    const counts = { done: 0, active: 0, backlog: 0 };
    for (const e of mine) for (const k of Object.keys(counts)) counts[k] += e.counts[k];
    const work = i.elaboration ? stories.find((x) => x.ref === i.elaboration) : null;
    return { ...i, epics: mine.map((e) => e.id), counts, stage: initiativeStage(i, counts, mine.length, work) };
  });
  // A context over the page's own clone (lib/write.mjs, readCtx()) reads the
  // clone and still names the bound vault and the real project (`shown`).
  const shown = ctx.shown || { project: ctx.project, vault: ctx.vault };
  return {
    vault: shown.vault,
    project: { dir: shown.project, name: basename(shown.project) },
    coreVersion: ctx.version,
    // Who is looking until the person picks another name: the binding's
    // default_author, the name the page's batch is kept under (package spec, contract 12).
    me: typeof ctx.cfg?.default_author === "string" && ctx.cfg.default_author.trim() ? ctx.cfg.default_author.trim() : null,
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
    // The layout's attachments folder, where a pasted picture is kept, or null when the layout
    // keeps none (the spec dashboard-attachments, contract 1).
    attachments: typeof ctx.layout.attachments?.path === "string" ? ctx.layout.attachments.path : null,
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

// ── a new item's template (the spec dashboard-new, contract 3) ──
// The kinds New makes, and the frontmatter fields the panel shows of each.
const NEW_KINDS = ["initiative", "epic", "story"];
const TEMPLATE_FIELDS = ["status", "priority", "assignee", "owner"];
// The body after the head, by the edit verb's cut, of the file the core's
// renderDraft gives the kind in the bound language, for the title "Untitled"
// (an epic's ID NEW, a story's epic the first epic folder in id order); its
// fields; and the draft's vault-relative path, used only for its depth.
// → { status: 200, result: { kind, body, fields, rel } } or { status: 404, error }.
// It runs no process and writes nothing.
export function readTemplate(ctx, kind) {
  if (!NEW_KINDS.includes(kind)) return { status: 404, error: `New makes ${NEW_KINDS.join(", ")}; ${JSON.stringify(kind ?? null)} is none of them` };
  let args = ["Untitled"];
  if (kind === "epic") args = ["NEW", "Untitled"];
  if (kind === "story") {
    const epicsPath = epicsPathOf(ctx);
    const first = epicsPath ? listDir(join(ctx.vault, epicsPath)).find((id) => !/^[._]/.test(id) && existsSync(join(ctx.vault, epicsPath, id, "epic.md"))) : null;
    if (!first) return { status: 404, error: "no epic yet: make an epic first" };
    args = [first, "Untitled"];
  }
  let d;
  try {
    d = ctx.draft.renderDraft(ctx.cfg, ctx.layout, kind, args);
  } catch (e) {
    if (e instanceof ctx.draft.DraftError) return { status: 404, error: `the ${kind} template could not be read: ${e.message}` };
    throw e;
  }
  const { data, body } = ctx.lib.parseFrontmatter(d.content);
  const fields = {};
  for (const k of TEMPLATE_FIELDS) if (data[k] !== undefined && data[k] !== null && String(data[k]).trim()) fields[k] = String(data[k]);
  const rel = relative(ctx.vault, d.path).split(sep).join("/");
  return { status: 200, result: { kind, body: ctx.editCut.splitForEdit(body).body, fields, rel } };
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

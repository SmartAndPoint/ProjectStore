// What belongs to a work item: its specs, ADRs and other documents, and
// which part of a spec or an ADR it touches.
//
// Two sources, both the vault's own:
//  - the core's link graph (scripts/graph.mjs buildGraph, the same graph the
//    verb `graph lineage` reads): typed edges between artifacts;
//  - the amendment marks inside a spec, by the core's parseAmendmentMarkers.
//    An edge joins two artifacts and never a part of one; a mark under a
//    contract names the story that changed it.
// What a story only says in prose ("contract 11", "decision 4") is read too,
// by this page, and reported apart, as the weaker evidence it is.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readableRel, epicsPathOf, INITIATIVES } from "./state.mjs";

const stem = (rel) => rel.split("/").pop().replace(/\.md$/, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The lines of one `## ` section found by a heading pattern, up to the next `## `.
function sectionLines(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

// The numbered items of a section: a spec's contracts, an ADR's decisions,
// each with the title its bold run (or its first clause) gives it.
function itemsOf(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].match(/^(\d+)\.\s+(.*)$/);
    if (!item) continue;
    let t = item[2];
    if (t.startsWith("**")) {
      // A bold title may run over two or three lines before it closes.
      t = t.slice(2);
      for (let k = 1; k <= 3 && !t.includes("**") && i + k < lines.length; k++) t += ` ${lines[i + k].trim()}`;
      t = t.split("**")[0];
    } else {
      // Some specs number their contracts with no bold title: the first clause names the contract.
      const clause = t.match(/^(.*?)(?::|\.)(?:\s|$)/);
      t = clause ? clause[1] : t;
      if (t.length > 90) t = `${t.slice(0, 88).trim()}…`;
    }
    out.push({ n: Number(item[1]), title: t.trim().replace(/[.:,]$/, "").replace(/`/g, "") });
  }
  return out;
}

// A spec's contracts with the marks under each. The section is the core's
// (the headings registry's "spec_contracts"); an older spec whose heading the
// registry does not know is read by a looser pattern. The marks are the core's.
function contractsOf(ctx, text) {
  const sec = ctx.lib.sectionOf(text, "spec_contracts");
  const items = itemsOf(sec !== null && sec !== undefined ? sec.split("\n") : sectionLines(text, /^## .*contracts?\b/i));
  const marks = ctx.lib.parseAmendmentMarkers(text).filter((m) => m.valid);
  return items.map((c) => ({ ...c, marks: marks.filter((m) => m.contract === String(c.n)).map((m) => ({ date: m.date, ref: m.ref, op: m.kind, what: m.why })) }));
}
const decisionsOf = (text) => itemsOf(sectionLines(text, /^## Decisions?\b/i)).map((d) => ({ ...d, marks: [] }));

// "contracts 2, 3 and 7" or "decisions 1–4" → the numbers.
function numbers(run) {
  const out = new Set();
  let prev = null;
  let range = false;
  for (const t of run.match(/\d+|to|–|-/g) || []) {
    if (!/\d/.test(t)) {
      range = true;
      continue;
    }
    const n = Number(t);
    if (range && prev !== null && n > prev && n - prev < 40) for (let k = prev + 1; k <= n; k++) out.add(k);
    else out.add(n);
    prev = n;
    range = false;
  }
  return out;
}
const RUN = "((?:\\d+)(?:\\s*(?:,|and|to|–|-)\\s*\\d+)*)";

// Contracts of one spec that a story's own text names.
function citedContracts(storyText, spec, alone) {
  const names = [];
  if (spec.alias) names.push(`\\b${esc(spec.alias)}\\b`);
  const num = stem(spec.rel).match(/^SPEC-\d+/);
  if (num) names.push(esc(num[0]));
  const out = new Set();
  if (names.length) for (const m of storyText.matchAll(new RegExp(`(?:${names.join("|")})[^.\\n;]{0,40}?contracts?\\s+${RUN}`, "gi"))) for (const n of numbers(m[1])) out.add(n);
  // A story under one spec only: a bare "contract 4" can mean no other.
  if (alone) for (const m of storyText.matchAll(new RegExp(`\\bcontracts?\\s+${RUN}`, "gi"))) for (const n of numbers(m[1])) out.add(n);
  return out;
}
// Decisions of one ADR named in a paragraph that also links to that ADR.
function citedDecisions(text, adrRel) {
  const out = new Set();
  const key = stem(adrRel);
  for (const para of text.split(/\n\s*\n/)) {
    if (!para.includes(key)) continue;
    for (const m of para.matchAll(new RegExp(`\\bdecisions?\\s+${RUN}`, "gi"))) for (const n of numbers(m[1])) out.add(n);
  }
  return out;
}

const HOW = {
  "spec-covers": ["covers it", "covered by it"], // [the neighbour → the item, the item → the neighbour]
  amends: ["amends it", "amended by it"],
  "spec-implements-adr": ["implements it", "implemented by it"],
  supersedes: ["supersedes it", "superseded by it"],
  "out-of-scope": ["names it out of scope", "named out of scope by it"],
  wikilink: ["links to it", "linked from it"],
  mdlink: ["links to it", "linked from it"],
};
const GROUPS = [
  ["spec", "Specs"],
  ["adr", "ADRs"],
  ["research", "Research"],
  ["concept", "Concepts"],
  ["runbook", "Runbooks"],
  ["meeting", "Meetings"],
  ["initiative", "Initiatives"],
  ["epic", "Epics"],
  ["story", "Stories"],
];

// What is related to the artifact at `rel`, or null when the path is not one
// the page reads (the one path rule, state.mjs readableRel) or not a file.
export function related(ctx, rel) {
  if (!readableRel(ctx, rel)) return null;
  const t0 = Date.now();
  const read = (r) => {
    const file = readableRel(ctx, r);
    if (!file) return "";
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const fmOf = (text) => ctx.lib.parseFrontmatter(text).data;
  const text = read(rel);
  if (!text) return null;
  const g = ctx.graph.buildGraph(ctx.cfg, ctx.layout);
  const node = new Map(g.nodes.map((n) => [n.path, n]));
  const fm = fmOf(text);
  const type = String(fm.type || node.get(rel)?.type || "").toLowerCase();
  const title = fm.title || node.get(rel)?.title || stem(rel);
  const epicsPath = epicsPathOf(ctx);
  // A story's epic: the folder under the layout's epics folder.
  const epicOf = (storyRel) => (epicsPath && storyRel.startsWith(`${epicsPath}/`) ? storyRel.slice(epicsPath.length + 1).split("/")[0] : storyRel.split("/")[1]);

  // The stories the item stands for: itself, an epic's, an initiative's.
  const storiesOf = (epicRel) => g.edges.filter((e) => e.kind === "epic-contains" && e.from === epicRel).map((e) => e.to);
  const epics = [];
  let stories = [];
  if (type === "story") stories = [rel];
  else if (type === "epic") stories = storiesOf(rel);
  else if (type === "initiative" || rel.startsWith(`${INITIATIVES}/`)) {
    const id = fm.id || stem(rel);
    const dir = epicsPath && join(ctx.vault, epicsPath);
    if (dir && existsSync(dir))
      for (const e of readdirSync(dir).sort()) {
        if (/^[._]/.test(e)) continue;
        const epicRel = `${epicsPath}/${e}/epic.md`;
        const et = read(epicRel);
        if (et && fmOf(et).initiative === id) epics.push(epicRel);
      }
    stories = epics.flatMap(storiesOf);
  } else if (type === "spec") stories = g.edges.filter((e) => (e.kind === "spec-covers" && e.from === rel) || (e.kind === "amends" && e.to === rel)).map((e) => (e.kind === "amends" ? e.from : e.to));
  else if (type === "adr") stories = g.edges.filter((e) => e.to === rel && node.get(e.from)?.type === "story").map((e) => e.from);
  stories = [...new Set(stories)];
  const anchors = new Set(type === "spec" || type === "adr" ? [rel] : [rel, ...epics, ...stories]);

  // Each story by the two forms a mark may name it: <EPIC>/<id> and <EPIC>/<file name>.
  const storyText = new Map();
  const byRef = new Map();
  for (const s of stories) {
    const st = read(s);
    storyText.set(s, st);
    const epic = epicOf(s);
    const info = { rel: s, title: node.get(s)?.title || stem(s), status: node.get(s)?.status || null };
    byRef.set(`${epic}/${fmOf(st).id || stem(s)}`, info);
    byRef.set(`${epic}/${stem(s)}`, info);
  }

  // Neighbours: every artifact an edge joins to an anchor.
  const found = new Map();
  const note = (path, how, via) => {
    if (anchors.has(path) || !node.has(path)) return;
    if (!found.has(path)) found.set(path, { how: new Set(), via: new Set(), through: null });
    if (how) found.get(path).how.add(how);
    if (via && via !== rel) found.get(path).via.add(via);
  };
  for (const e of g.edges) {
    if (e.kind === "epic-contains") continue;
    const h = HOW[e.kind] || [e.kind, e.kind];
    if (anchors.has(e.from)) note(e.to, h[1], e.from);
    if (anchors.has(e.to)) note(e.from, h[0], e.to);
  }
  // One step further along the lineage: the ADRs a found spec implements.
  for (const [path] of [...found]) {
    if (node.get(path).type !== "spec") continue;
    for (const e of g.edges)
      if (e.kind === "spec-implements-adr" && e.from === path && !anchors.has(e.to) && node.has(e.to)) {
        if (!found.has(e.to)) found.set(e.to, { how: new Set(), via: new Set(), through: null });
        const f = found.get(e.to);
        if (!f.how.size) f.through = node.get(path).title;
      }
  }

  const specPartsFor = (specRel, limitToStories) => {
    const st = read(specRel);
    const spec = { rel: specRel, alias: fmOf(st).alias || null };
    const contracts = contractsOf(ctx, st);
    const items = contracts.map((c) => ({ n: c.n, title: c.title, marks: [], cites: [] }));
    const at = new Map(items.map((c) => [c.n, c]));
    for (const c of contracts)
      for (const m of c.marks) {
        const who = byRef.get(m.ref);
        if (limitToStories && !who) continue;
        at.get(c.n).marks.push({ ...m, story: who || { rel: null, title: m.ref, status: null } });
      }
    for (const s of stories) {
      const mySpecs = g.edges.filter((e) => (e.kind === "spec-covers" && e.to === s) || (e.kind === "amends" && e.from === s)).map((e) => (e.kind === "amends" ? e.to : e.from));
      const alone = new Set(mySpecs).size === 1 && mySpecs[0] === specRel;
      for (const n of citedContracts(storyText.get(s), spec, alone)) at.get(n)?.cites.push(byRef.get(`${epicOf(s)}/${stem(s)}`));
    }
    return { word: "contract", total: items.length, items };
  };
  const adrPartsFor = (adrRel) => {
    const items = decisionsOf(read(adrRel)).map((d) => ({ n: d.n, title: d.title, marks: [], cites: [] }));
    const at = new Map(items.map((d) => [d.n, d]));
    const texts = type === "adr" ? [...storyText] : [[rel, text], ...storyText];
    for (const [who, tx] of texts) for (const n of citedDecisions(tx, adrRel)) at.get(n)?.cites.push({ rel: who, title: node.get(who)?.title || stem(who), status: node.get(who)?.status || null });
    return { word: "decision", total: items.length, items };
  };

  const groups = [];
  for (const [kind, label] of GROUPS) {
    const items = [...found]
      .filter(([path]) => node.get(path).type === kind)
      .map(([path, f]) => {
        const n = node.get(path);
        const it = { rel: path, type: n.type, title: n.title, status: n.status || null, how: [...f.how], through: f.through, from: [...f.via].slice(0, 6).map((v) => node.get(v)?.title || stem(v)), fromCount: f.via.size };
        if (kind === "spec") {
          it.parts = specPartsFor(path, true);
          it.covers = g.edges.filter((e) => e.kind === "spec-covers" && e.from === path && stories.includes(e.to)).length;
        } else if (kind === "adr") it.parts = adrPartsFor(path);
        return it;
      })
      .sort(
        (a, b) =>
          (b.parts ? b.parts.items.filter((p) => p.marks.length).length : 0) - (a.parts ? a.parts.items.filter((p) => p.marks.length).length : 0) ||
          b.how.length - a.how.length ||
          a.title.localeCompare(b.title),
      );
    if (items.length) groups.push({ kind, label, items });
  }

  return {
    rel,
    type,
    title,
    scope: { stories: stories.length, epics: epics.length },
    self: type === "spec" ? specPartsFor(rel, false) : type === "adr" ? adrPartsFor(rel) : null,
    groups,
    // Said as it is: the edges and the marks are the core's; the titles of the
    // contracts and the prose citations are read by this page.
    read: {
      graph: "the core's buildGraph (scripts/graph.mjs), the graph behind `projectstore graph`",
      marks: "the core's parseAmendmentMarkers (scripts/lib.mjs); contract titles and prose citations read by the page",
      nodes: g.nodes.length,
      edges: g.edges.length,
      ms: Date.now() - t0,
    },
  };
}

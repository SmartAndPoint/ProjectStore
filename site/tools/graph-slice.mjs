// The background graph's data: a slice of this project's own vault, read from
// the vault's graph.md, laid out, and written into site/assets/site.js as the
// one-line GRAPH literal the site test reads. Rebuild the pages afterwards
// (site/tools/i18n.py build), since site.js's hash changes.
//
// usage: node site/tools/graph-slice.mjs <vault>/graph.md [seed path]
//
// The slice is a breadth-first walk from the seed over the vault's links, up to
// 28 artifacts of the kinds the site names (adr, spec, epic, story, research),
// shown only when settled or under way (accepted, done, active, final,
// in-progress, as spelled; the vault's in_progress and review stay out): no
// draft and no proposal reaches the public page. The walk
// prefers a mix of kinds, three new artifacts a step; its lines are the walk's
// own, plus up to seven links between artifacts it has already reached. The
// other links among the shown artifacts are left out, to keep the picture
// sparse; the tool prints how many.
//
// The layout is searched, not drawn by hand: 60 runs of annealing from a fixed
// seed (so the same graph.md gives the same literal), scored on a 1440 x 900
// window for few crossings, short lines, room between artifacts no drawn line
// joins (150 px; 90 px for joined ones), lines that fan out of a node rather
// than run together, labels that cover no dot or other label and as few lines
// as can be, and a graph that spreads out from its seed.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , file, seed = "adr/ADR-010-slug-first-artifact-identity-numbers-become-external-reference-metadata.md"] =
  process.argv;
if (!file) {
  console.error("usage: node site/tools/graph-slice.mjs <vault>/graph.md [seed path]");
  process.exit(2);
}
const MAX = 28;
const KINDS = new Set(["adr", "spec", "epic", "story", "research"]);
const SHOWN = new Set(["accepted", "done", "active", "final", "in-progress"]);

// graph.md: a Nodes table (Path | Title | Type | Status) and an Edges table (From | Kind | To)
const nodes = new Map();
const edges = [];
let part = "";
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (line.startsWith("## ")) part = line.startsWith("## Nodes") ? "nodes" : line.startsWith("## Edges") ? "edges" : "";
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 5 || !/^[a-z]/.test(cells[1] ?? "")) continue;
  if (part === "nodes") nodes.set(cells[1], { kind: cells[3], status: cells[4] });
  if (part === "edges") edges.push([cells[1], cells[3]]);
}
const keep = (p) => nodes.has(p) && KINDS.has(nodes.get(p).kind) && SHOWN.has(nodes.get(p).status);
if (!keep(seed)) {
  console.error(`the seed ${seed} is not a settled adr, spec, epic, story or research in ${file}`);
  process.exit(1);
}
const adj = new Map();
for (const [a, b] of edges) {
  if (!keep(a) || !keep(b) || a === b) continue;
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    if (!adj.has(x)) adj.set(x, new Set());
    adj.get(x).add(y);
  }
}

// the walk: the least-shown kind first, against a target mix
const TARGET = { adr: 6, spec: 6, epic: 3, story: 11, research: 2 };
const count = { adr: 0, spec: 0, epic: 0, story: 0, research: 0 };
const order = [seed];
const tree = [];
count[nodes.get(seed).kind]++;
const rank = (p) => count[nodes.get(p).kind] / TARGET[nodes.get(p).kind];
for (let i = 0; i < order.length && order.length < MAX; i++) {
  const next = [...(adj.get(order[i]) ?? [])]
    .filter((p) => !order.includes(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en")); // one locale, whatever the machine's
  for (const p of next.slice(0, 3)) {
    if (order.length >= MAX) break;
    order.push(p);
    tree.push([order[i], p]);
    count[nodes.get(p).kind]++;
  }
}
// lines in growth order: each walk line, then any link back to an artifact already reached
const idx = new Map(order.map((p, i) => [p, i]));
const reached = new Set([seed]);
const used = new Set();
const key = (a, b) => [a, b].sort().join("|");
const lines = [];
let closers = 0;
for (const [a, b] of tree) {
  lines.push([idx.get(a), idx.get(b)]);
  used.add(key(a, b));
  reached.add(b);
  for (const x of [...reached]) {
    if (x !== b && adj.get(b)?.has(x) && !used.has(key(b, x)) && closers < 7) {
      closers++;
      lines.push([idx.get(x), idx.get(b)]);
      used.add(key(b, x));
    }
  }
}

// labels: the number where the file name has one (ADR-010, SPEC-002, story-001), else the kind; then the slug
const LABEL = 26;
const label = (p) => {
  const { kind } = nodes.get(p);
  const base = p.split("/").pop().replace(/\.md$/, "");
  const num = /^((?:ADR|SPEC)-\d+|story-\d+)-(.*)$/.exec(base);
  const text =
    kind === "epic" ? `epic ${p.split("/")[1]}` : num ? `${num[1]} ${num[2]}` : `${kind} ${base.replace(/^story-/, "")}`;
  return text.length > LABEL ? text.slice(0, LABEL - 1) + "…" : text;
};

// the layout, in the site's 1000 x 1000 box, scored at 1440 x 900 px
const N = order.length;
const Y0 = 165, Y1 = 905; // below the header on a phone, above the footer
const W = 1440, H = 900, sx = W / 1000, sy = H / 1000;
const labels = order.map(label);
const lw = labels.map((l) => l.length * 6.6); // 10 px IBM Plex Mono with 0.06em spacing, as site.js estimates
const rows = order.map((_, i) => Y0 + (i * (Y1 - Y0)) / (N - 1)); // where each run starts a node: its growth row
const ys = rows.slice();
let rnd = 11;
const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
const ccw = (A, B, C) => (C[1] - A[1]) * (B[0] - A[0]) - (B[1] - A[1]) * (C[0] - A[0]);
const crosses = (A, B, C, D) => ccw(A, C, D) * ccw(B, C, D) < 0 && ccw(A, B, C) * ccw(A, B, D) < 0;
const hitsBox = (A, B, r) => {
  const inside = (P) => P[0] >= r[0] && P[0] <= r[2] && P[1] >= r[1] && P[1] <= r[3];
  if (inside(A) || inside(B)) return true;
  const c = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ];
  return c.some((P, k) => crosses(A, B, P, c[(k + 1) % 4]));
};
// a label reads rightward, or leftward where it would leave the window, as site.js places it
const boxOf = (xs, i) => {
  const px = xs[i] * sx, py = ys[i] * sy;
  return px + 10 + lw[i] > W - 8 ? [px - 10 - lw[i], py - 6, px - 10, py + 6] : [px + 10, py - 6, px + 10 + lw[i], py + 6];
};
const linked = new Set(lines.flatMap(([a, b]) => [a + "," + b, b + "," + a]));
const walk = tree.map(([u, v]) => [idx.get(u), idx.get(v)]);
const FAN = Math.cos(Math.PI / 12);
const cost = (xs) => {
  const P = xs.map((x, i) => [x * sx, ys[i] * sy]);
  let c = 0, crossings = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = lines[i], [d, e] = lines[j];
      if (a !== d && a !== e && b !== d && b !== e && crosses(P[a], P[b], P[d], P[e])) crossings++;
    }
  c += crossings * 1000;
  const boxes = xs.map((_, i) => boxOf(xs, i));
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const r = boxes[i];
    if (r[0] < 8) c += 5000;
    for (let j = i + 1; j < N; j++) {
      const o = boxes[j];
      if (r[0] < o[2] + 8 && o[0] < r[2] + 8 && r[1] < o[3] + 2 && o[1] < r[3] + 2) c += 3000;
    }
    for (const [a, b] of lines) if (a !== i && b !== i && hitsBox(P[a], P[b], r)) hits++;
    for (let j = 0; j < N; j++)
      if (j !== i && P[j][0] >= r[0] - 6 && P[j][0] <= r[2] + 6 && P[j][1] >= r[1] - 6 && P[j][1] <= r[3] + 6)
        c += 3000;
  }
  c += hits * 700;
  for (const [a, b] of lines) c += Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]) * 0.6;
  let near = 0;
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++) {
      const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]), room = linked.has(i + "," + j) ? 90 : 150;
      if (d < room) {
        c += (room - d) * 60;
        near++;
      }
    }
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j], k = A.find((v) => B.includes(v));
      if (k === undefined) continue;
      const a = A[0] === k ? A[1] : A[0], b = B[0] === k ? B[1] : B[0];
      const u = [P[a][0] - P[k][0], P[a][1] - P[k][1]], v = [P[b][0] - P[k][0], P[b][1] - P[k][1]];
      const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
      if (cos > FAN) c += 80000 * (cos - FAN);
    }
  for (const [a, b] of walk) {
    const da = Math.hypot(P[a][0] - P[0][0], P[a][1] - P[0][1]), db = Math.hypot(P[b][0] - P[0][0], P[b][1] - P[0][1]);
    if (db < da) c += (da - db) * 8;
  }
  return { c, crossings, hits, near };
};
let best = null;
for (let run = 0; run < 60; run++) {
  const xs = order.map((_, i) => (i === 0 ? 905 : 60 + rand() * 890)); // the seed stays top right
  rows.forEach((y, i) => (ys[i] = i === 0 ? y : Math.min(Y1, Math.max(Y0, y + (rand() - 0.5) * 1000))));
  let cur = cost(xs).c;
  for (let it = 0, t = 300; it < 6000; it++, t *= 0.999) {
    const i = 1 + Math.floor(rand() * (N - 1));
    const oldX = xs[i], oldY = ys[i];
    xs[i] = Math.min(950, Math.max(50, oldX + (rand() - 0.5) * t * 2));
    ys[i] = Math.min(Y1, Math.max(Y0, oldY + (rand() - 0.5) * t * 2));
    const next = cost(xs).c;
    if (next <= cur || rand() < Math.exp((cur - next) / Math.max(t, 1))) cur = next;
    else {
      xs[i] = oldX;
      ys[i] = oldY;
    }
  }
  const r = cost(xs);
  if (!best || r.c < best.c) best = { ...r, xs: xs.map(Math.round), ys: ys.map(Math.round) };
}

const graph = {
  seeds: [0],
  open: Math.min(5, lines.length - 1),
  nodes: order.map((p, i) => [best.xs[i], best.ys[i], nodes.get(p).kind, labels[i]]),
  lines,
};
const site = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "site.js");
const js = readFileSync(site, "utf8");
const at = /^ {2}var GRAPH = .*;$/m;
if (!at.test(js)) {
  console.error(`${site} has no one-line GRAPH literal to replace`);
  process.exit(1);
}
writeFileSync(site, js.replace(at, () => `  var GRAPH = ${JSON.stringify(graph)};`));
// the score of what was written: the rounded places, scored at 1440 x 900
best.ys.forEach((y, i) => (ys[i] = y));
const kept = cost(best.xs);
const pairs = new Set(lines.map(([a, b]) => [a, b].sort((m, n) => m - n).join()));
let links = 0;
for (const [i, p] of order.entries())
  for (const [j, q] of order.entries()) if (i < j && adj.get(p)?.has(q)) links++;
console.log(
  `${N} artifacts, ${pairs.size} of the ${links} links among them drawn, ${kept.crossings} crossings, ` +
    `${kept.hits} label-line touches, ${kept.near} close pairs (at 1440 x 900)`,
);
for (const [i, p] of order.entries()) console.log(String(i).padStart(2), labels[i].padEnd(LABEL), p);

// projectstore — spec-tree.mjs: the spec tree read from the vault alone.
//
// A spec may name one parent spec with `parent:` in its frontmatter, and the
// specs joined this way form trees, from an app's overview down to its
// details (the spec "The spec tree: a parent link on a spec, the spec-part-of
// edge, the tree checks, the spec-tree view and the orientation line",
// contracts 1, 4, 5 and 6). This module resolves each link, finds the trees,
// their roots and depth, the cycles and the specs outside any tree, and gives
// doctor's three tree checks. graph.mjs draws the links as `spec-part-of`
// edges from the same resolution.
//
// Pure: it reads only the node index and the file list its caller passes in.
// It imports lib.mjs and initiative.mjs, never doctor.mjs or graph.mjs, so
// both of those can import it.

import { resolveLinkTarget } from "./lib.mjs";
import { referenceOf } from "./initiative.mjs";

// The value of one frontmatter key as written, for a message or a dead edge.
function rawFrontmatterValue(body, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(body || ""));
  if (!fm) return null;
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm[1]);
  return line ? line[1].trim() : null;
}

// One spec's `parent:` (contract 1), resolved against specs only, the way
// graph.md resolves a frontmatter ref. The result's `kind` is one of:
//   none       — absent, null or empty
//   list       — a value that starts with `[` (a flow list, an Obsidian link)
//   node       — one other spec, `path`
//   self       — the spec itself
//   dead       — nothing, or a file of another kind
//   ambiguous  — two or more specs, `candidates`
// `raw` is the value as written.
export function parentLinkOf(node, ctx) {
  const ref = referenceOf(node.fm?.parent);
  if (ref.kind === "none") return { kind: "none" };
  if (ref.kind === "list") return { kind: "list", raw: rawFrontmatterValue(node.body, "parent") ?? ref.raw };
  ctx.sourceRel = node.path;
  const r = resolveLinkTarget(ref.value, "ref", ctx);
  if (r.outcome === "node")
    return r.node.path === node.path
      ? { kind: "self", raw: ref.value }
      : { kind: "node", path: r.node.path, raw: ref.value };
  if (r.outcome === "ambiguous") return { kind: "ambiguous", raw: ref.value, candidates: r.candidates };
  return { kind: "dead", raw: ref.value };
}

// Every spec's parent link, by vault path. `index` is buildNodeIndex's
// result, `files` the vault's .md walk; one resolver context for the pass.
export function resolveSpecParents(index, files) {
  const ctx = { index, files, kinds: ["spec"] };
  const links = new Map();
  for (const n of index.nodes) if (n.type === "spec") links.set(n.path, parentLinkOf(n, ctx));
  return links;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The trees (contract 4). A tree holds at least two specs joined by resolved
// links and its upward chains all end at one spec with no parent, its root.
// A spec in a cycle, or whose chain reaches one, is in no tree. `hasTree`
// is true once any spec's parent resolves to another spec.
export function analyseSpecTree(index, links) {
  const specs = index.nodes.filter((n) => n.type === "spec");
  const nodeOf = new Map(specs.map((n) => [n.path, n]));
  const parent = new Map();
  const children = new Map();
  for (const [path, link] of links) {
    if (link.kind !== "node") continue;
    parent.set(path, link.path);
    if (!children.has(link.path)) children.set(link.path, []);
    children.get(link.path).push(path);
  }
  for (const list of children.values()) list.sort(byPath);

  // Walk up from each spec; a spec met again on the same walk closes a cycle.
  const state = new Map(); // path → "good" | "bad"
  const inCycle = new Set();
  const cycles = [];
  for (const s of specs.map((n) => n.path).sort(byPath)) {
    if (state.has(s)) continue;
    const walk = [];
    const onWalk = new Set();
    let cur = s;
    while (cur && !state.has(cur) && !onWalk.has(cur)) {
      walk.push(cur);
      onWalk.add(cur);
      cur = parent.get(cur);
    }
    let verdict = "good";
    if (cur && onWalk.has(cur)) {
      const members = walk.slice(walk.indexOf(cur)).sort(byPath);
      cycles.push(members);
      for (const m of members) inCycle.add(m);
      verdict = "bad";
    } else if (cur && state.get(cur) === "bad") verdict = "bad";
    for (const w of walk) state.set(w, verdict);
  }

  const good = (p) => state.get(p) === "good";
  const roots = specs
    .map((n) => n.path)
    .filter((p) => good(p) && !parent.has(p) && (children.get(p) || []).length)
    .sort(byPath);
  const trees = roots.map((root) => {
    const paths = [];
    let depth = 0;
    const visit = (p, d) => {
      paths.push(p);
      depth = Math.max(depth, d);
      for (const c of children.get(p) || []) visit(c, d + 1);
    };
    visit(root, 1);
    return { root, title: nodeOf.get(root)?.title ?? root, paths, depth };
  });
  const belowCycles = specs
    .map((n) => n.path)
    .filter((p) => state.get(p) === "bad" && !inCycle.has(p))
    .sort(byPath);
  const outside = specs
    .filter((n) => !parent.has(n.path) && !(children.get(n.path) || []).length)
    .map((n) => n.path)
    .sort(byPath);
  return {
    hasTree: parent.size > 0,
    parent,
    children,
    trees,
    cycles: cycles.sort((a, b) => byPath(a[0], b[0])),
    belowCycles,
    outside,
  };
}

// Doctor's tree checks (contracts 5 and 6), under every spec policy.
// `finding(level, check, message, file)` builds one finding.
export function checkSpecTree(index, links, tree, { finding }) {
  const out = [];
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const status = (p) => String(nodeOf.get(p)?.status ?? "");
  const fix = "Name an existing spec's id or filename in parent:, or clear it.";
  for (const [path, link] of [...links].sort((a, b) => byPath(a[0], b[0]))) {
    if (link.kind === "list") {
      out.push(
        finding(
          "issue",
          "spec-parent",
          `Spec ${path} has parent: ${link.raw}, which is not one spec's id. A spec names one parent, as a plain string: parent: "<spec id>".`,
          path,
        ),
      );
    } else if (link.kind === "self") {
      out.push(
        finding(
          "issue",
          "spec-parent",
          `Spec ${path} names itself in parent: "${link.raw}". A spec cannot be its own parent; name the spec it is part of, or clear parent:.`,
          path,
        ),
      );
    } else if (link.kind === "dead") {
      out.push(
        finding(
          "issue",
          "spec-parent",
          `Spec ${path} has parent: "${link.raw}", and no spec has that id or filename. ${fix}`,
          path,
        ),
      );
    } else if (link.kind === "ambiguous") {
      out.push(
        finding(
          "issue",
          "spec-parent",
          `Spec ${path} has parent: "${link.raw}", which matches more than one spec (${link.candidates.join(", ")}). Write the parent's vault path instead, as in parent: "specs/<file>.md".`,
          path,
        ),
      );
    } else if (link.kind === "node" && status(path) === "active" && status(link.path) === "superseded") {
      out.push(
        finding(
          "warn",
          "spec-parent",
          `Active spec ${path} has a superseded parent, ${link.path}. Move it under the parent's successor, or clear parent:.`,
          path,
        ),
      );
    }
  }
  for (const members of tree.cycles) {
    out.push(
      finding(
        "issue",
        "spec-cycle",
        `Specs ${members.join(", ")} name each other as parents in a cycle, so none of them is in a tree. Clear parent: in one of them.`,
        members[0],
      ),
    );
  }
  if (tree.hasTree) {
    const lone = tree.outside.filter((p) => status(p) === "active");
    if (lone.length) {
      const shown = lone.slice(0, 10).join(", ");
      const more = lone.length > 10 ? `, and ${lone.length - 10} more` : "";
      out.push(
        finding(
          "info",
          "spec-outside-tree",
          `${lone.length} active spec${lone.length === 1 ? " is" : "s are"} in no spec tree: ${shown}${more}. A spec that describes part of an app with a tree gets parent: naming the spec it belongs under.`,
        ),
      );
    }
  }
  return out;
}

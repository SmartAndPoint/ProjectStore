// projectstore — the spec tree (spec "The spec tree: a parent link on a spec,
// the spec-part-of edge, the tree checks, the spec-tree view and the
// orientation line", alias `spec-tree`; PS-SPECTREE: "A spec names its
// parent"). Each test names the contract it covers.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/spec-tree.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLayout, loadTemplate, renderTemplate, parseFrontmatter, buildNodeIndex, listOf } from "../scripts/lib.mjs";
import { runVaultChecks, walkVaultFiles } from "../scripts/doctor.mjs";
import { buildGraph } from "../scripts/graph.mjs";
import { lineage, neighbors, LINEAGE_KINDS } from "../scripts/query.mjs";
import { resolveGuide } from "../scripts/guides.mjs";
import { resolveSpecParents, analyseSpecTree } from "../scripts/spec-tree.mjs";
import { seedSpecTreeFixture, specText, goldenFacts, readGolden, SPECS } from "./fixtures/spec-tree.mjs";

const LAYOUT = loadLayout("engineering");
const TREE_CHECKS = ["spec-parent", "spec-cycle", "spec-outside-tree"];
const quiet = { commits: () => ({ status: "ok", commits: [] }), grep: () => ({ status: "ok", lines: [] }) };
const doctorOf = (fx) => runVaultChecks(fx.cfg, { proj: fx.proj, ...quiet });
const treeFindings = (fx) => doctorOf(fx).filter((f) => TREE_CHECKS.includes(f.check));
const put = (fx, id, fields) =>
  writeFileSync(join(fx.vault, "specs", `${id}.md`), specText({ id, title: id, ...fields }));
const edgesOf = (fx) => buildGraph(fx.cfg, LAYOUT).edges.filter((e) => e.from.startsWith("specs/"));
const treeOf = (fx) => {
  const index = buildNodeIndex(fx.cfg, LAYOUT);
  const links = resolveSpecParents(index, walkVaultFiles(fx.vault));
  return { links, tree: analyseSpecTree(index, links) };
};
const names = (r) => r.nodes.map((n) => `${n.path.replace(/^specs\/|\.md$/g, "")}@${n.distance}`);

// [spec-tree#1]
test("parent link: an id, a filename stem, and a list or an Obsidian link that gives no parent", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "app-overview", {});
  put(fx, "by-id", { parent: "app-overview" });
  writeFileSync(join(fx.vault, "specs", "stemmed.md"), specText({ id: "another-id", title: "Stemmed" }));
  put(fx, "by-stem", { parent: "stemmed" });
  put(fx, "listed", { parent: '["app-overview"]' });
  put(fx, "wikilinked", { parent: "[[app-overview]]" });
  const { links } = treeOf(fx);
  assert.deepEqual(links.get("specs/by-id.md"), { kind: "node", path: "specs/app-overview.md", raw: "app-overview" });
  assert.equal(links.get("specs/by-stem.md").path, "specs/stemmed.md");
  assert.equal(links.get("specs/listed.md").kind, "list");
  assert.equal(links.get("specs/wikilinked.md").kind, "list");
  const issues = treeFindings(fx).filter((f) => f.check === "spec-parent");
  assert.deepEqual(issues.map((f) => f.file).sort(), ["specs/listed.md", "specs/wikilinked.md"]);
  for (const f of issues) assert.match(f.message, /plain string/);
  const dead = edgesOf(fx).filter((e) => e.kind === "dead");
  assert.ok(dead.some((e) => e.from === "specs/listed.md" && e.to === '["app-overview"]'));
  assert.ok(dead.some((e) => e.from === "specs/wikilinked.md" && e.to === "[[app-overview]]"));
});

// [spec-tree#1]
test("parent link: a draft spec has a parent, and parent: on a story is not read", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "root", {});
  put(fx, "drafted", { parent: "root", status: "draft" });
  writeFileSync(
    join(fx.vault, "epics", "PS-X", "stories", "story-t.md"),
    '---\ntype: story\nid: "story-t"\nepic: "PS-X"\ntitle: "T"\nstatus: in-progress\nparent: "nowhere"\nspecs: []\n---\n\n# T\n',
  );
  const { links } = treeOf(fx);
  assert.equal(links.get("specs/drafted.md").path, "specs/root.md");
  assert.equal(links.has("epics/PS-X/stories/story-t.md"), false);
  assert.equal(
    edgesOf(fx).some((e) => e.to === "nowhere"),
    false,
  );
});

// [spec-tree#2] [vault-link-graph-derived-view-and-shared-link-resolver#3]
test("edge: a resolved parent draws spec-part-of child → parent, and neighbors lists it both ways", () => {
  const fx = seedSpecTreeFixture();
  const graph = buildGraph(fx.cfg, LAYOUT).content;
  assert.match(graph, /\| specs\/api\.md \| spec-part-of \| specs\/app\.md \|/);
  const n = neighbors(fx.cfg, "specs/app.md");
  assert.deepEqual(
    n.in.filter((e) => e.kind === "spec-part-of").map((e) => e.from),
    ["specs/api.md", "specs/web.md"],
  );
  assert.deepEqual(
    neighbors(fx.cfg, "specs/api.md")
      .out.filter((e) => e.kind === "spec-part-of")
      .map((e) => e.to),
    ["specs/app.md"],
  );
});

// [spec-tree#2] [vault-link-graph-derived-view-and-shared-link-resolver#3]
test("edge: an unresolved parent is a dead edge, two matches an ambiguous one, and the spec itself none", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "orphan", { parent: "no-such-spec" });
  put(fx, "selfish", { parent: "selfish" });
  put(fx, "twin-a", { extra: 'alias: "x"' });
  writeFileSync(join(fx.vault, "specs", "dup.md"), specText({ id: "dup", title: "Dup" }));
  writeFileSync(join(fx.vault, "specs", "dup-two.md"), specText({ id: "dup", title: "Dup two" }));
  put(fx, "torn", { parent: "dup" });
  const edges = edgesOf(fx);
  assert.ok(edges.some((e) => e.from === "specs/orphan.md" && e.kind === "dead" && e.to === "no-such-spec"));
  assert.ok(!edges.some((e) => e.from === "specs/orphan.md" && e.kind === "spec-part-of"));
  assert.ok(!edges.some((e) => e.from === "specs/selfish.md"));
  assert.ok(
    edges.some((e) => e.from === "specs/torn.md" && e.kind === "ambiguous" && e.to.startsWith("dup (matches:")),
  );
});

// [spec-tree#2] [spec-tree#4]
test("no parent: the fixture without parent: gives the golden graph.md, doctor findings and skeleton", async () => {
  const facts = await goldenFacts(seedSpecTreeFixture({ parents: false }));
  const golden = readGolden();
  assert.equal(facts.graph, golden.graph);
  assert.deepEqual(facts.doctor, golden.doctor);
  assert.equal(facts.skeleton, golden.skeleton);
});

// [spec-tree#3] [vault-link-graph-derived-view-and-shared-link-resolver#4]
test("walk: from the root, every descendant at its depth", () => {
  const fx = seedSpecTreeFixture();
  assert.ok(LINEAGE_KINDS.includes("spec-part-of"));
  const r = lineage(fx.cfg, "specs/app.md", { depth: 3, kinds: ["spec-part-of"] });
  assert.deepEqual(names(r), ["app@0", "api@1", "web@1", "api-auth@2", "api-queue@2", "web-cart@2"]);
  assert.equal(r.truncated, false);
});

// [spec-tree#3] [vault-link-graph-derived-view-and-shared-link-resolver#4]
test("walk: from a leaf, its ancestors and no sibling", () => {
  const fx = seedSpecTreeFixture();
  const r = lineage(fx.cfg, "specs/api-queue.md", { depth: 3, kinds: ["spec-part-of"] });
  assert.deepEqual(names(r), ["api-queue@0", "api@1", "app@2"]);
});

// [spec-tree#3]
test("walk: from a story, its spec and the spec's ancestors, and no child of them", () => {
  const fx = seedSpecTreeFixture();
  const r = lineage(fx.cfg, "epics/PS-X/stories/story-t.md", { depth: 3 });
  const paths = r.nodes.map((n) => n.path);
  for (const p of ["specs/api-queue.md", "specs/api.md", "specs/app.md"]) assert.ok(paths.includes(p), p);
  for (const p of ["specs/api-auth.md", "specs/web.md", "specs/web-cart.md"]) assert.ok(!paths.includes(p), p);
});

// [spec-tree#3]
test("walk: a descendant first reached through a story still walks down to its own children", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "r", {});
  put(fx, "b", { parent: "r" });
  put(fx, "c", { parent: "b" });
  put(fx, "d", { parent: "c" });
  put(fx, "e", { parent: "d" });
  writeFileSync(
    join(fx.vault, "epics", "PS-X", "stories", "story-t.md"),
    '---\ntype: story\nid: "story-t"\nepic: "PS-X"\ntitle: "T"\nstatus: in-progress\nspecs: ["r", "d"]\n---\n\n# T\n',
  );
  const r = lineage(fx.cfg, "specs/r.md", { depth: 3 });
  const at = Object.fromEntries(r.nodes.map((n) => [n.path, n.distance]));
  assert.equal(at["specs/d.md"], 2, "d is reached through the story first");
  assert.equal(at["specs/e.md"], 3, "and still walks down to its child");
});

// [spec-tree#3]
test("walk: a cycle ends, and the caps hold", () => {
  const fx = seedSpecTreeFixture();
  const r = lineage(fx.cfg, "specs/loop-a.md", { depth: 10, kinds: ["spec-part-of"] });
  assert.deepEqual(names(r), ["loop-a@0", "below-loop@1", "loop-b@1"]);
  assert.equal(lineage(fx.cfg, "specs/app.md", { depth: 3, kinds: ["spec-part-of"], cap: 3 }).truncated, true);
});

// [spec-tree#4]
test("trees: two roots with one child each are two trees of depth 2, and a lone spec is in neither", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "r1", {});
  put(fx, "c1", { parent: "r1" });
  put(fx, "r2", {});
  put(fx, "c2", { parent: "r2" });
  put(fx, "alone", {});
  const { tree } = treeOf(fx);
  assert.equal(tree.hasTree, true);
  assert.deepEqual(
    tree.trees.map((t) => [t.root, t.depth, t.paths.length]),
    [
      ["specs/r1.md", 2, 2],
      ["specs/r2.md", 2, 2],
    ],
  );
  assert.deepEqual(tree.outside, ["specs/alone.md"]);
});

// [spec-tree#4]
test("trees: the fixture's tree is depth 3, and the cycle and the spec below it are in no tree", () => {
  const { tree } = treeOf(seedSpecTreeFixture());
  assert.deepEqual(
    tree.trees.map((t) => [t.root, t.depth, t.paths.length]),
    [["specs/app.md", 3, 6]],
  );
  assert.deepEqual(tree.cycles, [["specs/loop-a.md", "specs/loop-b.md"]]);
  assert.deepEqual(tree.belowCycles, ["specs/below-loop.md"]);
});

// [spec-tree#4]
test("trees: only an unresolved parent makes no tree, and only spec-parent fires", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "a", { parent: "missing" });
  put(fx, "b", {});
  assert.equal(treeOf(fx).tree.hasTree, false);
  assert.deepEqual(
    treeFindings(fx).map((f) => f.check),
    ["spec-parent"],
  );
});

// [spec-tree#5]
test("parent checks: an unknown id, the spec itself and two matches are issues that say what to change", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "orphan", { parent: "no-such-spec" });
  put(fx, "selfish", { parent: "selfish" });
  writeFileSync(join(fx.vault, "specs", "dup.md"), specText({ id: "dup", title: "Dup" }));
  writeFileSync(join(fx.vault, "specs", "dup-two.md"), specText({ id: "dup", title: "Dup two" }));
  put(fx, "torn", { parent: "dup" });
  const found = treeFindings(fx).filter((f) => f.check === "spec-parent");
  assert.deepEqual(found.map((f) => f.file).sort(), ["specs/orphan.md", "specs/selfish.md", "specs/torn.md"]);
  const byFile = Object.fromEntries(found.map((f) => [f.file, f]));
  for (const f of found) assert.equal(f.level, "issue");
  assert.match(
    byFile["specs/orphan.md"].message,
    /no-such-spec.*no spec has that id.*Name an existing spec's id or filename/,
  );
  assert.match(byFile["specs/selfish.md"].message, /cannot be its own parent; name the spec it is part of/);
  assert.match(byFile["specs/torn.md"].message, /more than one spec.*vault path instead/);
  assert.ok(edgesOf(fx).some((e) => e.from === "specs/torn.md" && e.kind === "ambiguous"));
});

// [spec-tree#5]
test("parent checks: a superseded parent of an active spec is a warn naming both, and a draft parent is fine", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "old-root", { status: "superseded" });
  put(fx, "kid", { parent: "old-root" });
  put(fx, "draft-root", { status: "draft" });
  put(fx, "kid2", { parent: "draft-root" });
  const found = treeFindings(fx).filter((f) => f.check === "spec-parent");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.match(found[0].message, /specs\/kid\.md.*specs\/old-root\.md.*successor/);
});

// [spec-tree#6]
test("cycles: one issue per cycle naming its members once, and the spec below is not a member", () => {
  const found = treeFindings(seedSpecTreeFixture()).filter((f) => f.check === "spec-cycle");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /specs\/loop-a\.md, specs\/loop-b\.md.*Clear parent: in one of them/);
  assert.doesNotMatch(found[0].message, /below-loop/);
});

// [spec-tree#6]
test("outside: twelve unlinked active specs beside a tree are one info naming ten; with no tree, none", () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "root", {});
  put(fx, "kid", { parent: "root" });
  put(fx, "kid2", { parent: "kid" });
  for (let i = 1; i <= 12; i++) put(fx, `free-${String(i).padStart(2, "0")}`, {});
  const info = treeFindings(fx).filter((f) => f.check === "spec-outside-tree");
  assert.equal(info.length, 1);
  assert.equal(info[0].level, "info");
  assert.match(info[0].message, /^12 active specs are in no spec tree/);
  assert.equal((info[0].message.match(/specs\/free-/g) || []).length, 10);
  assert.match(info[0].message, /and 2 more\. A spec that describes part of an app with a tree gets parent:/);
  for (const id of ["kid", "kid2"]) put(fx, id, {});
  assert.deepEqual(
    treeFindings(fx).filter((f) => f.check === "spec-outside-tree"),
    [],
  );
});

// [spec-tree#11]
test("template: every bundled locale's spec carries parent: null and code_refs: [] before review_status:", () => {
  for (const lang of ["en", "ru", "es", "de", "fr", "zh"]) {
    const text = renderTemplate(loadTemplate(lang, "spec"), {
      id: "x",
      title: "X",
      date: "2026-01-01",
      author: "A",
      tags: "[]",
      slug: "x",
    });
    const { data } = parseFrontmatter(text);
    assert.equal(data.parent, null, lang);
    assert.ok(text.includes("\ncode_refs: []\n"), lang);
    assert.deepEqual(listOf(data, "code_refs"), [], lang);
    assert.ok(text.indexOf("parent: null") < text.indexOf("review_status:"), lang);
  }
});

// [spec-tree#11]
test("guide: the spec guide's Must list has the citing rule, at version 3", () => {
  const g = resolveGuide("spec");
  assert.equal(g.guide_version, 3);
  assert.ok(g.text.includes("citing the child's contract token"));
});

// [spec-tree#11]
test("template keys: a spec with parent: null and code_refs: [] gives the findings it gives without them", () => {
  const strip = (fx) => doctorOf(fx).map((f) => `${f.level} ${f.check} ${f.file ?? ""} ${f.message}`);
  const fx = seedSpecTreeFixture({ parents: false, specs: SPECS.slice(0, 3) });
  const before = strip(fx);
  for (const s of SPECS.slice(0, 3)) {
    const p = join(fx.vault, "specs", `${s.id}.md`);
    writeFileSync(p, readFileSync(p, "utf8").replace("adr: []\n", "adr: []\nparent: null\ncode_refs: []\n"));
  }
  assert.deepEqual(strip(fx), before);
});

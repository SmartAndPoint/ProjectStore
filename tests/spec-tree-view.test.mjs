// projectstore — the spec tree view and orientation (spec "The spec tree: a
// parent link on a spec, the spec-part-of edge, the tree checks, the
// spec-tree view and the orientation line", alias `spec-tree`, contracts 7 to
// 10; PS-SPECTREE: "The spec tree view and orientation"). Each test names the
// contract it covers.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/spec-tree-view.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLayout,
  parseFrontmatter,
  gatherVaultFacts,
  renderVaultSkeleton,
  derivedViewPaths,
  readConfigAt,
} from "../scripts/lib.mjs";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { runReconcile, resolveSelection } from "../scripts/reconcile.mjs";
import { orientation, search, derivedViews } from "../scripts/query.mjs";
import { SPEC_TREE_FILE } from "../scripts/spec-tree.mjs";
import { specTreeViewOf, SPEC_TREE_COMMAND } from "../scripts/spec-tree-view.mjs";
import { seedSpecTreeFixture, specText, readGolden } from "./fixtures/spec-tree.mjs";
import { seedSpecCodeFixture } from "./fixtures/spec-code.mjs";
import { gitCommit } from "./fixtures/flow.mjs";
import { CASES } from "./fixtures/skeleton-cases.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LAYOUT = loadLayout("engineering");
const quiet = { commits: () => ({ status: "ok", commits: [] }), grep: () => ({ status: "ok", lines: [] }) };
const doctorOf = (fx, opts = {}) => runVaultChecks(fx.cfg, { proj: fx.proj, ...quiet, ...opts });
const treeFindings = (fx, opts) => doctorOf(fx, opts).filter((f) => f.check === "spec-tree");
const put = (fx, id, fields = {}) =>
  writeFileSync(join(fx.vault, "specs", `${id}.md`), specText({ id, title: id, ...fields }));
const viewOf = async (fx) => (await specTreeViewOf(fx.cfg, LAYOUT)).content;
const fmOf = (content) => parseFrontmatter(content).data;
const reconcile = (fx, opts) => runReconcile({ projectDir: fx.proj, ...opts });
const viewPath = (fx) => join(fx.vault, SPEC_TREE_FILE);
const normalize = (s) =>
  s
    .split("\n")
    .filter((l) => !l.startsWith("generated_at:"))
    .join("\n");
// Paths of the fixture's vault and project, masked.
const mask = (fx, s) => String(s).split(fx.vault).join("<vault>").split(fx.proj).join("<proj>");

// Two trees, of three and five specs; the component b1 has a child dated after
// it that it neither links nor cites.
function twoTrees() {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "a-root", { title: "Small app" });
  put(fx, "a1", { parent: "a-root" });
  put(fx, "a2", { parent: "a-root" });
  put(fx, "b-root", { title: "Large app", prose: "See [[b1]] and [[b2]]." });
  put(fx, "b1", { parent: "b-root", prose: "See [[b1y]]." });
  put(fx, "b1x", { parent: "b1", date: "2026-11-08" });
  put(fx, "b1y", { parent: "b1" });
  put(fx, "b2", { parent: "b-root" });
  return fx;
}

// [spec-tree#7]
test('view: a root titled Shop "v2" with two children has three nodes, two arrows and the #quot; label', async () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  writeFileSync(
    join(fx.vault, "specs", "shop.md"),
    specText({ id: "shop", title: "x" }).replace('title: "x"', `title: ${JSON.stringify('Shop "v2"')}`),
  );
  put(fx, "cart", { parent: "shop" });
  put(fx, "pay", { parent: "shop" });
  const content = await viewOf(fx);
  const mermaid = content
    .match(/```mermaid\n([\s\S]*?)```/)[1]
    .split("\n")
    .filter(Boolean);
  assert.equal(mermaid[0], "flowchart TD");
  assert.equal(mermaid.filter((l) => /^ {2}n\d+\[".*"\]$/.test(l)).length, 3);
  assert.equal(mermaid.filter((l) => /^ {2}n\d+ --> n\d+$/.test(l)).length, 2);
  assert.ok(mermaid.includes('  n1["Shop #quot;v2#quot;"]'), mermaid.join("\n"));
  assert.match(content, /^## Shop "v2"$/m);
  assert.equal(fmOf(content).largest_root, 'Shop "v2"');
  assert.equal(fmOf(content).projectstore, "derived");
  assert.match(content, /^generated_at: \d{4}-\d\d-\d\dT/m);
});

// [spec-tree#7]
test("view: two trees of three and five specs, the larger root's title, and the component's flag nested under its root", async () => {
  const fx = twoTrees();
  const content = await viewOf(fx);
  const fm = fmOf(content);
  assert.deepEqual([fm.trees, fm.specs, fm.depth, fm.largest_root], ["2", "8", "3", "Large app"]);
  // Root path order: a-root's tree first.
  assert.ok(content.indexOf("## Small app") < content.indexOf("## Large app"));
  const lines = content.split("\n");
  const b1 = lines.find((l) => l.startsWith("  - [b1](specs/b1.md)"));
  assert.ok(b1, "b1 is nested one level under its root");
  assert.match(b1, /spec-child-unlinked: specs\/b1x\.md, dated 2026-11-08/);
  assert.ok(lines.includes("    - [b1x](specs/b1x.md) · status: active · ADRs: none · stories: 0 · code_refs: none"));
  assert.equal(lines.filter((l) => l.trimStart().startsWith("- ") && l.includes("spec-child-unlinked")).length, 1);
  // Children in path order under their parent.
  assert.ok(lines.indexOf(b1) < lines.findIndex((l) => l.includes("[b1x]")));
  assert.ok(lines.findIndex((l) => l.includes("[b1x]")) < lines.findIndex((l) => l.includes("[b1y]")));
  assert.ok(lines.findIndex((l) => l.includes("[b1y]")) < lines.findIndex((l) => l.includes("[b2]")));
});

// [spec-tree#7]
test("view: each item carries its status, its ADRs, the count of its stories and its code_refs", async () => {
  const fx = seedSpecTreeFixture();
  writeFileSync(
    join(fx.vault, "adr", "ADR-001-queues.md"),
    '---\ntype: adr\nid: "ADR-001"\ntitle: "Queues"\nstatus: accepted\ndate: 2026-11-01\n---\n\n# Queues\n',
  );
  writeFileSync(
    join(fx.vault, "specs", "api-queue.md"),
    specText({
      id: "api-queue",
      title: "API job [queue]",
      parent: "api",
      stories: ["PS-X/story-t"],
      adr: ["ADR-001", "no-such-adr"],
      refs: ["src/api/queue.mjs"],
    }),
  );
  const line = (await viewOf(fx)).split("\n").find((l) => l.includes("(specs/api-queue.md)"));
  assert.equal(
    line,
    "    - [API job \\[queue\\]](specs/api-queue.md) · status: active · ADRs: [ADR-001: Queues](adr/ADR-001-queues.md), `no-such-adr` · stories: 1 · code_refs: `src/api/queue.mjs`",
  );
});

// [spec-tree#7]
test("view: a spec below a cycle and the cycle's members are under Cycles and in no tree", async () => {
  const fx = seedSpecTreeFixture({ specs: [] });
  put(fx, "a", { parent: "b", title: "A" });
  put(fx, "b", { parent: "a", title: "B" });
  put(fx, "d", { parent: "a", title: "D" });
  const content = await viewOf(fx);
  const fm = fmOf(content);
  assert.deepEqual([fm.trees, fm.specs, fm.depth, fm.largest_root], ["0", "0", "0", null]);
  const cycles = content.slice(content.indexOf("## Cycles"));
  assert.match(
    cycles,
    /^- \[A\]\(specs\/a\.md\), \[B\]\(specs\/b\.md\): a cycle of parent: links, so in no tree; clear `parent:` in one of them to break it\. Below it: \[D\]\(specs\/d\.md\)\.$/m,
  );
  assert.equal(content.slice(0, content.indexOf("## Cycles")).includes("](specs/"), false, "no tree lists them");
  const fx2 = seedSpecTreeFixture();
  assert.match(await viewOf(fx2), /\[Below the loop\]\(specs\/below-loop\.md\)/);
  const none = twoTrees();
  assert.match(await viewOf(none), /## Cycles\n\nNone: no spec's parent chain comes back to itself\.\n$/);
});

// [spec-tree#7]
test("view: the opening says what a root, a component and a leaf are, and the command that walks down", async () => {
  const content = await viewOf(seedSpecTreeFixture());
  const body = content.split("# Spec tree\n\n")[1].split("\n\n")[0];
  assert.match(body, /root is the spec with no parent/);
  assert.match(body, /a component has a parent and children/);
  assert.match(body, /a leaf has a parent and no child/);
  assert.match(
    body,
    /`npx projectstore graph lineage <root path> --kind spec-part-of --depth <n>`; this page is rebuilt by `reconcile`, so change the specs, not this file\./,
  );
  assert.equal(body.split(/(?<=\.)\s/).length, 2, "two sentences");
});

// [spec-tree#7]
test("view: no git fact and no clock: the bytes hold after a clock change and after a code commit", async () => {
  const fx = seedSpecCodeFixture();
  // A marker dated far ahead of today counts the same on any day.
  put(fx, "api", { parent: "app", refs: ["src/api/"], prose: "See [api-queue#1]." });
  put(fx, "api-queue", {
    parent: "api",
    refs: ["src/api/queue.mjs"],
    marker: "amended 2099-01-01 by PS-X/story-t: MODIFIED — far ahead",
  });
  const before = normalize(await viewOf(fx));
  assert.match(before, /spec-stale-parent: cites \[api-queue#1\], amended in specs\/api-queue\.md on 2099-01-01/);
  // The clock moved to the day before the marker: Date, swapped for the build.
  const RealDate = Date;
  const at = RealDate.parse("2098-12-30T00:00:00Z");
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [at]));
    }
    static now() {
      return at;
    }
  };
  let later;
  try {
    later = normalize(await viewOf(fx));
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(later, before, "the clock");
  gitCommit(fx.proj, { files: { "src/api/queue.mjs": "export const queue = 2;\n" }, message: "code only" });
  assert.equal(normalize(await viewOf(fx)), before, "a code commit");
});

// [spec-tree#7]
test("view: its flags are the parent checks doctor gives for the same vault", async () => {
  const fx = twoTrees();
  put(fx, "a-root", { title: "Small app", prose: "Cites [a1#1]." });
  put(fx, "a1", { parent: "a-root", marker: "amended 2026-11-05 by PS-X/story-t: MODIFIED — a change" });
  const content = await viewOf(fx);
  const fromDoctor = doctorOf(fx)
    .filter((f) => f.check === "spec-stale-parent" || f.check === "spec-child-unlinked")
    .map((f) => `${f.file} ${f.check} ${f.token ?? f.child}`)
    .sort();
  const fromView = [];
  for (const l of content.split("\n")) {
    const path = l.match(/\]\((specs\/[^)]+)\)/)?.[1];
    for (const m of l.matchAll(/(spec-stale-parent): cites (\S+),|(spec-child-unlinked): (\S+),/g))
      fromView.push(`${path} ${m[1] ?? m[3]} ${m[2] ?? m[4]}`);
  }
  assert.deepEqual(fromView.sort(), fromDoctor);
  assert.equal(fromDoctor.length, 2);
});

// [spec-tree#8]
test("reconcile: --only kanban writes no spec-tree.md, --only spectree writes it, and a bare --write never creates it", () => {
  const fx = seedSpecTreeFixture();
  const k = reconcile(fx, { write: true, only: "kanban" });
  assert.deepEqual(k.spectree, { skipped: "not selected" });
  assert.equal(existsSync(viewPath(fx)), false);
  const bare = reconcile(fx, { write: true });
  assert.match(bare.spectree.skipped, /does not exist yet.*--only spectree/);
  assert.equal(existsSync(viewPath(fx)), false);
  const s = reconcile(fx, { write: true, only: "spectree" });
  assert.equal(s.spectree.written, true);
  assert.equal(s.spectree.stats.trees, 1);
  assert.equal(readFileSync(viewPath(fx), "utf8").split("\n")[2], "projectstore: derived");
});

// [spec-tree#8] [spec-tree#4]
test("reconcile: the fixture without parent: gets no spec-tree.md from a bare --write", () => {
  const fx = seedSpecTreeFixture({ parents: false });
  const r = reconcile(fx, { write: true });
  assert.equal(r.spectree.written, undefined);
  assert.equal(existsSync(viewPath(fx)), false);
});

// [spec-tree#8]
test("reconcile: once the file exists, a spec gaining a parent is stale under --only kanban, then rewritten, then left", () => {
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  put(fx, "lone", { parent: "app", title: "A lone spec" });
  const compute = reconcile(fx, { only: "kanban" });
  assert.equal(compute.spectree.changed, true);
  assert.match(compute.spectree.content, /A lone spec/);
  const w = reconcile(fx, { write: true, only: "kanban" });
  assert.equal(w.spectree.written, true);
  assert.match(readFileSync(viewPath(fx), "utf8"), /\[A lone spec\]\(specs\/lone\.md\)/);
  for (const only of ["kanban", null, "graph"]) {
    const again = reconcile(fx, { write: true, only });
    assert.equal(again.spectree.written, false, String(only));
    assert.equal(again.spectree.changed, false, String(only));
  }
});

// [spec-tree#8]
test("reconcile: the writing verbs' refresh keeps spec-tree.md fresh, and an error in it is reported", async () => {
  const { refreshViews } = await import("../scripts/reconcile.mjs");
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  put(fx, "lone", { parent: "web", title: "A lone spec" });
  const r = refreshViews({ project: fx.proj, env: null });
  assert.equal(r.failed, false, r.error);
  assert.match(readFileSync(viewPath(fx), "utf8"), /\[A lone spec\]/);
});

// [spec-tree#8] [atomic-regeneration-of-derived-views#6]
test("reconcile: --only spectree is refused in a layout with no spec folder, as --only kanban is with no board", () => {
  assert.equal(resolveSelection(LAYOUT, "spectree").spectree, true);
  assert.equal(resolveSelection(LAYOUT, null).spectree, false, "bare never names it");
  const specless = { ...LAYOUT, folders: LAYOUT.folders.filter((f) => f.kind !== "spec") };
  const r = resolveSelection(specless, "spectree");
  assert.match(r.error, /no spec folder/);
  assert.ok(!r.error.includes("spectree,"), "not offered as valid");
  assert.match(resolveSelection(LAYOUT, "nope").error, /graph, spectree, indexes/);
});

// [spec-tree#8]
test("derived: search, the precommit check's list and derivedViewPaths treat spec-tree.md as derived", () => {
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  assert.equal(SPEC_TREE_FILE, "spec-tree.md");
  assert.equal(derivedViewPaths(LAYOUT).specTree, SPEC_TREE_FILE);
  assert.ok(derivedViews(LAYOUT).includes(SPEC_TREE_FILE));
  const cfg = readConfigAt(fx.proj);
  assert.equal(
    search(cfg, "Shop app").matches.some((m) => m.path === SPEC_TREE_FILE),
    false,
  );
  assert.equal(
    search(cfg, "Shop app", { includeDerived: true }).matches.some((m) => m.path === SPEC_TREE_FILE),
    true,
  );
});

// [spec-tree#9]
test("doctor: silent with no file and no tree; one info naming the command when a tree has no file", () => {
  assert.deepEqual(treeFindings(seedSpecTreeFixture({ parents: false })), []);
  const found = treeFindings(seedSpecTreeFixture());
  assert.deepEqual(
    found.map((f) => [f.level, f.check]),
    [["info", "spec-tree"]],
  );
  assert.ok(found[0].message.includes("reconcile --write --only spectree"), found[0].message);
  assert.ok(found[0].message.endsWith(`:\n${SPEC_TREE_COMMAND}`), found[0].message);
});

// [spec-tree#9]
test("doctor: a fresh file is silent; a child added after it is one issue that says it is stale and names the command", () => {
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  assert.deepEqual(treeFindings(fx), []);
  put(fx, "web-pay", { parent: "web" });
  const found = treeFindings(fx);
  assert.deepEqual(
    found.map((f) => [f.level, f.check, f.file]),
    [["issue", "spec-tree", SPEC_TREE_FILE]],
  );
  assert.match(found[0].message, /^spec-tree\.md is stale/);
  assert.ok(found[0].message.endsWith(`:\n${SPEC_TREE_COMMAND}`));
});

// [spec-tree#9]
test("doctor: a commit to the project's code only gives no spec-tree finding", () => {
  const fx = seedSpecCodeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  gitCommit(fx.proj, { files: { "src/api/queue.mjs": "export const queue = 3;\n" }, message: "code only" });
  assert.deepEqual(treeFindings(fx), []);
});

// [spec-tree#9] [spec-tree#4]
test("doctor: a file left after the last parent: is cleared is still checked, and shows zero trees", () => {
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  const without = seedSpecTreeFixture({ parents: false });
  for (const s of ["app", "api", "web", "api-queue", "api-auth", "web-cart", "loop-a", "loop-b", "below-loop"])
    writeFileSync(join(fx.vault, "specs", `${s}.md`), readFileSync(join(without.vault, "specs", `${s}.md`)));
  assert.deepEqual(
    treeFindings(fx).map((f) => f.level),
    ["issue"],
  );
  const r = reconcile(fx, { write: true, only: "kanban" });
  assert.equal(r.spectree.written, true);
  assert.equal(fmOf(readFileSync(viewPath(fx), "utf8")).trees, "0");
  assert.deepEqual(treeFindings(fx), []);
});

// The facts of the skeleton case "nothing in progress", with a spec tree.
const tree = (rest = {}) => ({ trees: "2", specs: "14", depth: "3", largestRoot: "Shop app", ...rest });
const goldenCase = () => JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "skeleton-golden.json"), "utf8"));

// [spec-tree#10] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#1] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#7]
test("orientation line: one line after the derived views, every other line as the golden case has it", () => {
  const facts = CASES["nothing in progress"];
  const golden = goldenCase()["nothing in progress"];
  const line = "**Spec trees**: 2 trees · 14 specs · depth 3 · largest root: Shop app — see `spec-tree.md`.";
  assert.equal(renderVaultSkeleton({ ...facts, specTree: tree() }), `${golden}\n${line}\n`);
  assert.equal(
    renderVaultSkeleton({ ...facts, specTree: tree({ trees: "1" }) })
      .trimEnd()
      .split("\n")
      .at(-1),
    line.replace("2 trees", "1 tree"),
  );
});

// [spec-tree#10] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#1] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#3]
test("orientation line: a 90-character title is cut to 60 with …, and the longest line is at most 160", () => {
  const facts = CASES["nothing in progress"];
  const last = (t) =>
    renderVaultSkeleton({ ...facts, specTree: t })
      .trimEnd()
      .split("\n")
      .at(-1);
  const line = last(tree({ largestRoot: "T".repeat(90) }));
  const root = line.match(/largest root: (.*) — see/)[1];
  assert.equal(root.length, 60);
  assert.ok(root.endsWith("…"));
  const worst = last({ trees: "99999", specs: "99999", depth: "99999", largestRoot: "W".repeat(500) });
  assert.ok(worst.length <= 160, `${worst.length}`);
  assert.equal(worst.length, 154);
  assert.equal(last(tree({ largestRoot: "a\nb c" })).includes("a b c"), true, "no line break gets in");
});

// [spec-tree#10] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#13]
test("orientation line: none for trees: 0, no trees, a count that is not a number, or no root title", () => {
  const facts = CASES["nothing in progress"];
  const golden = goldenCase()["nothing in progress"];
  for (const t of [
    tree({ trees: "0" }),
    tree({ trees: undefined }),
    tree({ specs: "many" }),
    tree({ depth: "123456" }),
    tree({ largestRoot: null }),
    null,
  ])
    assert.equal(renderVaultSkeleton({ ...facts, specTree: t }), golden, JSON.stringify(t));
});

// [spec-tree#10] [the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized#13]
test("orientation line: no file, trees: 0, junk and a read past the budget give the no-tree golden skeleton", async () => {
  const fx = seedSpecTreeFixture({ parents: false });
  const golden = readGolden().skeleton;
  const skeleton = async (opts) => {
    const base = fx.proj.split("/").pop();
    return mask(fx, renderVaultSkeleton(await gatherVaultFacts(fx.cfg, opts)))
      .split(base)
      .join("<proj>");
  };
  assert.equal(await skeleton(), golden, "no file");
  for (const text of [
    "---\n\nprojectstore: derived\ntrees: 0\nspecs: 0\ndepth: 0\nlargest_root: null\n\n---\n",
    "not a frontmatter at all\n",
    "---\ntrees: [1, 2]\nspecs: x\n---\n",
  ]) {
    writeFileSync(viewPath(fx), text);
    assert.equal(await skeleton(), golden, text);
  }
  writeFileSync(viewPath(fx), '---\ntrees: 1\nspecs: 2\ndepth: 2\nlargest_root: "R"\n---\n');
  const hang = (p) => (p.endsWith(SPEC_TREE_FILE) ? new Promise(() => {}) : readFileSync(p, "utf8"));
  assert.equal(await skeleton({ budgetMs: 300, readFile: hang }), golden, "past the budget");
  assert.notEqual(await skeleton(), golden, "the same file read in time gives the line");
  rmSync(viewPath(fx));
});

// [spec-tree#10]
test("orientation line: the fixture's own view gives the line in the skeleton and in the orientation verb", async () => {
  const fx = seedSpecTreeFixture();
  reconcile(fx, { write: true, only: "spectree" });
  const line = "**Spec trees**: 1 tree · 6 specs · depth 3 · largest root: Shop app — see `spec-tree.md`.";
  const facts = await gatherVaultFacts(fx.cfg);
  assert.deepEqual(facts.specTree, { trees: "1", specs: "6", depth: "3", largestRoot: "Shop app" });
  assert.equal(renderVaultSkeleton(facts).trimEnd().split("\n").at(-1), line);
  const o = await orientation(fx.cfg);
  assert.equal(o.skeleton.trimEnd().split("\n").at(-1), line);
  const plain = seedSpecTreeFixture({ parents: false });
  assert.equal("specTree" in (await gatherVaultFacts(plain.cfg)), false, "no file, no key");
});

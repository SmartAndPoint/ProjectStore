// projectstore — the code a spec owns (spec "Spec-owned code: a spec's
// code_refs, ownership by file, and a story's specs following its files",
// alias `spec-code`; PS-SPECTREE: "A spec owns code files"). Each test names
// the contract it covers.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/spec-code.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { buildGraph } from "../scripts/graph.mjs";
import { loadLayout } from "../scripts/lib.mjs";
import { trackedFiles } from "../scripts/diff-refs.mjs";
import { specTreeOf, specOwnership, coveringStories } from "../scripts/spec-code.mjs";
import { specText, SPECS } from "./fixtures/spec-tree.mjs";
import { seedSpecCodeFixture, REFS } from "./fixtures/spec-code.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECKS = ["spec-tree-git", "spec-code-outside-parent", "spec-code-empty", "spec-undescribed"];
const quiet = { commits: () => ({ status: "ok", commits: [] }), grep: () => ({ status: "ok", lines: [] }) };
const codeFindings = (fx, opts = {}) =>
  runVaultChecks(fx.cfg, { proj: fx.proj, ...quiet, ...opts }).filter((f) => CHECKS.includes(f.check));
const put = (fx, id, fields) =>
  writeFileSync(join(fx.vault, "specs", `${id}.md`), specText({ id, title: id, ...fields }));
const ownershipOf = (fx, opts = {}) => {
  const { index, tree } = specTreeOf(fx.cfg);
  return specOwnership(index, tree, { proj: fx.proj, vault: fx.vault, ...opts });
};
const ids = (paths) => paths.map((p) => p.replace(/^specs\/|\.md$/g, ""));
const failingSeam = () => {
  throw new Error("git must not run");
};

// [spec-code#1]
test("code_refs: a participating spec owns every file its ref covers", () => {
  const own = ownershipOf(seedSpecCodeFixture());
  assert.deepEqual(ids(own.ownersOf("src/web/cart.mjs")), ["app", "web"]);
  assert.deepEqual(ids(own.ownersOf("src/api/http.mjs")), ["api", "app"]);
});

// [spec-code#1]
test("code_refs: a draft spec in a tree owns nothing, and a vault with no tree starts no git", () => {
  const fx = seedSpecCodeFixture();
  put(fx, "web", { parent: "app", status: "draft", extra: 'code_refs: ["src/web/"]' });
  assert.deepEqual(ids(ownershipOf(fx).ownersOf("src/web/cart.mjs")), ["app"]);
  const flat = seedSpecCodeFixture({ specs: SPECS.map((s) => ({ ...s, parent: null })), commit: false });
  assert.deepEqual(codeFindings(flat, { lsFiles: failingSeam }), []);
});

// [spec-code#1] [spec-code#2]
test("code_refs: a tree whose specs name no code starts no git and gives nothing", () => {
  const fx = seedSpecCodeFixture({ refs: {}, commit: false });
  assert.deepEqual(codeFindings(fx, { lsFiles: failingSeam }), []);
});

// [spec-code#2]
test("ownership: owners and deepest owners down the tree", () => {
  const own = ownershipOf(seedSpecCodeFixture());
  const queue = own.ownersOf("src/api/queue.mjs");
  assert.deepEqual(ids(queue), ["api-queue", "api", "app"]);
  assert.deepEqual(ids(own.deepestOf(queue)), ["api-queue"]);
  assert.deepEqual(ids(own.deepestOf(own.ownersOf("src/api/http.mjs"))), ["api"]);
});

// [spec-code#2]
test("ownership: a file shared by two trees has two deepest owners, and no finding for the sharing", () => {
  const fx = seedSpecCodeFixture();
  put(fx, "ops", { extra: 'code_refs: ["ops/"]' });
  put(fx, "ops-queue", { parent: "ops", extra: 'code_refs: ["src/api/queue.mjs"]' });
  const own = ownershipOf(fx);
  assert.deepEqual(ids(own.deepestOf(own.ownersOf("src/api/queue.mjs"))).sort(), ["api-queue", "ops-queue"]);
  const found = codeFindings(fx).filter((f) => f.check !== "spec-code-empty" && f.check !== "spec-undescribed");
  assert.deepEqual(
    found.filter((f) => f.check === "spec-code-outside-parent").map((f) => f.file),
    ["specs/ops-queue.md"],
    "ops-queue reaches outside ops; the sharing itself is no finding",
  );
});

// [spec-code#2]
test("ownership: the vault inside the project is never owned code", () => {
  const fx = seedSpecCodeFixture({ refs: { ...REFS, app: ["src/", "vault/"] } });
  const listed = ownershipOf(fx).files();
  assert.ok(listed.files.includes("src/cli.mjs"));
  assert.ok(!listed.files.some((f) => f.startsWith("vault/")));
  assert.ok(
    trackedFiles(fx.proj).files.some((f) => f.startsWith("vault/")),
    "git itself lists the vault",
  );
});

// [spec-code#2]
test("ownership: a project that is not a git repository gives one spec-tree-git info, and nothing else", () => {
  const fx = seedSpecCodeFixture({ commit: false });
  const found = codeFindings(fx);
  assert.deepEqual(
    found.map((f) => [f.level, f.check, f.reason]),
    [["info", "spec-tree-git", "not-a-repository"]],
  );
  assert.match(found[0].message, /\(specs\/api-queue\.md, specs\/api\.md, specs\/app\.md, and 1 more\)/);
  assert.match(found[0].message, /not a git repository.*run once the project is a git checkout/);
  const tree = runVaultChecks(fx.cfg, { proj: fx.proj, ...quiet }).filter((f) => f.check === "spec-cycle");
  assert.equal(tree.length, 1, "the vault-only checks still run");
});

// [spec-code#2]
test("ownership: every reason of the reader names itself", () => {
  const fx = seedSpecCodeFixture({ commit: false });
  for (const reason of ["no-git", "timeout", "failed"]) {
    const found = codeFindings(fx, { lsFiles: () => ({ status: "unknown", reason }) });
    assert.deepEqual(
      found.map((f) => f.reason),
      [reason],
    );
  }
});

// [spec-code#3]
test("outside parent: a child's ref beyond its parent's files is one warn naming the file and the remedy", () => {
  const fx = seedSpecCodeFixture({ refs: { ...REFS, "api-queue": ["src/api/queue.mjs", "src/web/cart.mjs"] } });
  const found = codeFindings(fx).filter((f) => f.check === "spec-code-outside-parent");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.equal(found[0].file, "specs/api-queue.md");
  assert.match(
    found[0].message,
    /"src\/web\/cart\.mjs".*1 file its parent specs\/api\.md does not.*Narrow the ref, or widen/,
  );
});

// [spec-code#3]
test("outside parent: an overview with no code_refs, or a draft one, does not judge its children", () => {
  const none = seedSpecCodeFixture({ refs: { ...REFS, app: [] } });
  assert.deepEqual(
    codeFindings(none).filter((f) => f.check === "spec-code-outside-parent"),
    [],
  );
  const draft = seedSpecCodeFixture({ refs: { ...REFS, app: ["lib/"] } });
  put(draft, "app", { status: "draft", extra: 'code_refs: ["lib/"]' });
  assert.deepEqual(
    codeFindings(draft).filter((f) => f.check === "spec-code-outside-parent"),
    [],
  );
});

// [spec-code#3]
test("empty ref: a ref that covers no tracked file is a warn, but not while the spec covers work in progress", () => {
  const fx = seedSpecCodeFixture({ refs: { ...REFS, web: ["src/web/", "src/old/"] } });
  const found = codeFindings(fx).filter((f) => f.check === "spec-code-empty");
  assert.deepEqual(
    found.map((f) => [f.level, f.file]),
    [["warn", "specs/web.md"]],
  );
  assert.match(found[0].message, /"src\/old\/", which covers no file.*Fix the ref, or drop it/);
  const busy = seedSpecCodeFixture({ refs: { ...REFS, "api-queue": ["src/api/queue.mjs", "src/api/new.mjs"] } });
  assert.deepEqual(
    codeFindings(busy).filter((f) => f.check === "spec-code-empty"),
    [],
    "api-queue covers the in-progress story PS-X/story-t",
  );
});

// [spec-code#4]
test("undescribed: one info counts the source files only a root owns, with the full list in files", () => {
  const found = codeFindings(seedSpecCodeFixture()).filter((f) => f.check === "spec-undescribed");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "info");
  assert.deepEqual(found[0].files, ["src/cli.mjs"]);
  assert.match(found[0].message, /^1 source file is described only by the root spec specs\/app\.md: src\/cli\.mjs\./);
});

// [spec-code#4]
test("undescribed: a file no spec owns is not counted, and with every file owned there is no info", () => {
  const fx = seedSpecCodeFixture({ refs: { ...REFS, web: ["src/web/", "src/cli.mjs"] } });
  assert.deepEqual(
    codeFindings(fx).filter((f) => f.check === "spec-undescribed"),
    [],
    "README.md is owned by no spec and src/cli.mjs now by web",
  );
});

// [spec-code#4]
test("undescribed: past ten files the message names ten and the count of the rest, and --json carries them all", () => {
  const sources = {};
  for (let i = 0; i < 12; i++) sources[`src/tool-${String(i).padStart(2, "0")}.mjs`] = "export {};\n";
  const fx = seedSpecCodeFixture({ sources });
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "doctor.mjs"), "--vault", "--json"], {
    cwd: fx.proj,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: fx.proj },
  });
  const all = JSON.parse(r.stdout);
  const info = (Array.isArray(all) ? all : all.findings || []).find((f) => f.check === "spec-undescribed");
  assert.ok(info, r.stderr);
  assert.equal(info.files.length, 12);
  assert.match(info.message, /and 2 more\./);
});

// [spec-code#7]
test("owners: the command prints each path's owners and deepest owners, from the vault alone", () => {
  const fx = seedSpecCodeFixture({ commit: false });
  const r = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "spec-code.mjs"), "owners", "src/api/queue.mjs", "src/cli.mjs", "--project", fx.proj],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tree, true);
  assert.deepEqual(
    out.paths.map((p) => [p.path, p.deepest.map((d) => d.id)]),
    [
      ["src/api/queue.mjs", ["api-queue"]],
      ["src/cli.mjs", ["app"]],
    ],
  );
});

// [spec-code#7]
test("owners: with no tree it says so, and a missing path is a usage error", () => {
  const fx = seedSpecCodeFixture({ specs: SPECS.map((s) => ({ ...s, parent: null })), commit: false });
  const run = (...a) =>
    spawnSync(process.execPath, [join(REPO, "scripts", "spec-code.mjs"), ...a, "--project", fx.proj], {
      encoding: "utf8",
    });
  assert.equal(JSON.parse(run("owners", "src/cli.mjs").stdout).tree, false);
  const bad = run("owners");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: spec-code\.mjs owners/);
});

// [spec-code#7]
test("planner: every shipped copy tells it to ask for the owners and list the deepest for the story's specs", () => {
  for (const rel of [
    "agents/planner.md",
    "adapters/codex/skills/projectstore-planner/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-planner/SKILL.md",
  ]) {
    const text = readFileSync(join(REPO, rel), "utf8").replace(/\s+/g, " ");
    assert.match(text, /scripts\/spec-code\.mjs" owners <path>…/, rel);
    assert.match(text, /List those deepest owners as the specs the story must carry in its `specs:`/, rel);
  }
});

// The specs that cover a story, as contracts 3 and 5 read them.
test("covering stories: the specs that cover a story are the graph's spec-covers edges, from either side", () => {
  const fx = seedSpecCodeFixture({ commit: false });
  const { index, layout } = specTreeOf(fx.cfg);
  const covers = coveringStories(index, layout);
  const edges = buildGraph(fx.cfg, loadLayout("engineering"))
    .edges.filter((e) => e.kind === "spec-covers")
    .map((e) => `${e.from} ${e.to}`)
    .sort();
  const ours = [...covers].flatMap(([spec, stories]) => stories.map((s) => `${spec} ${s.path}`)).sort();
  assert.deepEqual(ours, edges);
});

// [spec-code#2]
test("ownership: a draft spec in the middle of a chain is skipped, and the leaf under it is still the deepest owner", () => {
  const fx = seedSpecCodeFixture();
  put(fx, "api", { parent: "app", status: "draft", extra: 'code_refs: ["src/api/"]' });
  const own = ownershipOf(fx);
  const owners = own.ownersOf("src/api/queue.mjs");
  assert.deepEqual(ids(owners), ["api-queue", "app"]);
  assert.deepEqual(ids(own.deepestOf(owners)), ["api-queue"]);
});

// [spec-code#3]
test("empty ref: work in progress linked from only one side still exempts the spec", () => {
  const refs = { ...REFS, "api-queue": ["src/api/queue.mjs", "src/api/new.mjs"] };
  const storyOnly = seedSpecCodeFixture({
    refs,
    specs: SPECS.map((s) => (s.id === "api-queue" ? { ...s, stories: [] } : s)),
  });
  assert.deepEqual(
    codeFindings(storyOnly).filter((f) => f.check === "spec-code-empty"),
    [],
    "the story's specs: names api-queue",
  );
  const specOnly = seedSpecCodeFixture({ refs, commit: false });
  writeFileSync(
    join(specOnly.vault, "epics", "PS-X", "stories", "story-t.md"),
    '---\ntype: story\nid: "story-t"\nepic: "PS-X"\ntitle: "T"\nstatus: review\npriority: p2\nspecs: []\ncode_refs: []\n---\n\n# T\n',
  );
  const { index, layout } = specTreeOf(specOnly.cfg);
  assert.deepEqual(
    (coveringStories(index, layout).get("specs/api-queue.md") || []).map((s) => s.path),
    ["epics/PS-X/stories/story-t.md"],
    "api-queue's stories: names the story in review",
  );
});

// [spec-code#4]
test("undescribed: a file only a root owns that is not source, such as a build output, is not counted", () => {
  const fx = seedSpecCodeFixture({
    sources: { "src/api/queue.mjs": "x\n", "src/dist/bundle.js": "x\n", "src/cli.mjs": "x\n" },
  });
  const info = codeFindings(fx).find((f) => f.check === "spec-undescribed");
  assert.deepEqual(info.files, ["src/cli.mjs"]);
});

// [spec-code#7]
test("owners: an absolute path under the project and a ./ path read as the same file", () => {
  const fx = seedSpecCodeFixture({ commit: false });
  const run = (p) =>
    JSON.parse(
      spawnSync(process.execPath, [join(REPO, "scripts", "spec-code.mjs"), "owners", p, "--project", fx.proj], {
        encoding: "utf8",
      }).stdout,
    ).paths[0];
  for (const p of [join(fx.proj, "src", "api", "queue.mjs"), "./src/api/queue.mjs"]) {
    const r = run(p);
    assert.equal(r.path, "src/api/queue.mjs", p);
    assert.deepEqual(
      r.deepest.map((d) => d.id),
      ["api-queue"],
      p,
    );
  }
});

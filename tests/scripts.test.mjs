// projectstore — CLI-script tests (PS-SPEC story-007/009 follow-up from the
// reviewer pass). The two new scripts are pure compute; drive them via
// spawnSync with CLAUDE_PROJECT_DIR pointed at this repo (its config supplies
// language/vault for story-section).
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = { ...process.env, CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: REPO };

function run(script, args) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    encoding: "utf8", env: ENV, cwd: REPO, timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const STORY = `---
type: story
id: "story-050"
title: "T"
status: review
updated: 2026-01-01
started_at: null
closed_at: null
plan_updated_at: null
---

# T

## Decomposition

- [x] a

## Implementation Plan

HAND WRITTEN — must survive.

## Acceptance Criteria

- [ ] c

---

*Last updated: 2026-01-01*
`;

test("story-section plan: idempotent, preserves hand-written plan, no downgrade from review", () => {
  const p = join(mkdtempSync(join(tmpdir(), "ps-ss-")), "s.md");
  writeFileSync(p, STORY);
  const out = run("story-section.mjs", ["plan", p]);
  assert.equal((out.content.match(/## Implementation Plan/g) || []).length, 1);
  assert.ok(out.content.includes("HAND WRITTEN — must survive."));
  assert.match(out.content, /status: review/);           // never downgraded
  assert.match(out.content, /started_at: "20/);          // stamped
  assert.match(out.content, /plan_updated_at: "20/);     // stamped
  assert.match(out.content, /\*Last updated: 20\d\d-\d\d-\d\d\*/); // footer synced
});

test("story-section close: inserts Final Summary, stamps closed_at, status done", () => {
  const p = join(mkdtempSync(join(tmpdir(), "ps-ss-")), "s.md");
  writeFileSync(p, STORY);
  const out = run("story-section.mjs", ["close", p]);
  assert.match(out.content, /## Final Summary/);
  assert.match(out.content, /status: done/);
  assert.match(out.content, /closed_at: "20/);
  assert.ok(out.content.includes("HAND WRITTEN — must survive."));
  writeFileSync(p, out.content);
  const again = run("story-section.mjs", ["close", p]);
  assert.equal(again.notes.filter((n) => n.includes("closed_at")).length, 0, "closed_at stamped once");
});

// ─── draft.mjs golden tests (ADR-010 / SPEC-002 contracts 1–4) ─────────
//
// draft reads the project config for vault/language, so these run against a
// throwaway project dir + vault; CLAUDE_PLUGIN_ROOT stays this repo (layouts,
// templates).

function runIn(projectDir, script, args) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    encoding: "utf8", env: { ...ENV, CLAUDE_PROJECT_DIR: projectDir }, cwd: REPO, timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function makeVaultProject() {
  const proj = mkdtempSync(join(tmpdir(), "ps-draft-"));
  const vault = join(proj, "vault");
  for (const d of ["adr", "specs", join("epics", "PS-X", "stories")]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"), JSON.stringify({
    vault_path: vault, layout: "engineering", language: "en", default_author: "Test",
  }));
  return { proj, vault };
}

test("draft adr/spec: slug-only filename, machine id, external_refs, no number (contracts 1, 3)", () => {
  const { proj } = makeVaultProject();
  for (const kind of ["adr", "spec"]) {
    const out = runIn(proj, "draft.mjs", [kind, "Foo Bar Baz"]);
    assert.ok(out.path.endsWith("foo-bar-baz.md"), out.path);
    assert.match(out.content, /^id: "foo-bar-baz"$/m);
    assert.match(out.content, /^external_refs: \{\}$/m);
    assert.doesNotMatch(out.content, /^number:/m);
    assert.match(out.content, /^# Foo Bar Baz$/m); // H1 without a number
    assert.equal(out.collision, null);
    assert.deepEqual(out.warnings, []);
  }
});

test("draft story: story-<slug>.md under the epic, external_refs replaces external_tracker (contracts 2, 3)", () => {
  const { proj } = makeVaultProject();
  const out = runIn(proj, "draft.mjs", ["story", "PS-X", "Do", "the", "thing"]);
  assert.ok(out.path.endsWith(join("epics", "PS-X", "stories", "story-do-the-thing.md")), out.path);
  assert.match(out.content, /^id: "story-do-the-thing"$/m);
  assert.match(out.content, /^external_refs: \{\}$/m);
  assert.doesNotMatch(out.content, /external_tracker/);
  assert.equal(out.collision, null);
});

test("draft: cross-era collisions surface in the collision field (contract 4)", () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(join(vault, "adr", "ADR-003-foo.md"), "");
  const adr = runIn(proj, "draft.mjs", ["adr", "Foo"]);
  assert.equal(adr.collision.with, "ADR-003-foo.md");
  assert.equal(adr.collision.identity, "foo");

  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-006-payments.md"), "");
  const story = runIn(proj, "draft.mjs", ["story", "PS-X", "Payments"]);
  assert.equal(story.collision.with, "story-006-payments.md");
  assert.equal(story.collision.identity, "payments");

  // Standalone epics/<id>/story-*.md shares the epic's identity scope.
  writeFileSync(join(vault, "epics", "PS-X", "story-refunds.md"), "");
  const standalone = runIn(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);
  assert.equal(standalone.collision.with, "story-refunds.md");

  const clean = runIn(proj, "draft.mjs", ["adr", "Unrelated topic"]);
  assert.equal(clean.collision, null);
});

test("mixed-era vault: index orders by date with number badge, doctor identity checks stay clean (contracts 6, 8)", () => {
  const { proj, vault } = makeVaultProject();
  const fm = (extra) => `---\n${extra}\n---\n\n# T\n`;
  writeFileSync(join(vault, "adr", "README.md"),
    "# ADRs\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n");
  writeFileSync(join(vault, "adr", "ADR-001-caching.md"),
    fm('type: adr\nnumber: "001"\ntitle: "Caching"\nstatus: accepted\ndate: 2026-01-01'));
  writeFileSync(join(vault, "adr", "zebra.md"),
    fm('type: adr\nid: "zebra"\ntitle: "Zebra"\nstatus: proposed\ndate: 2026-01-02\nexternal_refs: {}'));
  writeFileSync(join(vault, "adr", "apple.md"),
    fm('type: adr\nid: "apple"\ntitle: "Apple"\nstatus: proposed\ndate: 2026-01-02\nexternal_refs: {}'));
  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-001-legacy-work.md"),
    fm('type: story\nid: "story-001"\ntitle: "Legacy work"\nstatus: planned\ncreated: 2026-01-01'));
  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-do-thing.md"),
    fm('type: story\nid: "story-do-thing"\ntitle: "Do thing"\nstatus: planned\ncreated: 2026-01-02\nexternal_refs: {}'));

  const rec = runIn(proj, "reconcile.mjs", []);
  const adrIndex = rec.indexes.find((i) => i.folder === "adr");
  assert.ok(adrIndex.changed);
  const labels = adrIndex.content.split("\n").filter((l) => /^\| \[/.test(l))
    .map((l) => l.match(/^\| \[([^\]]+)\]/)[1]);
  // Date asc; numbered before unnumbered is moot across dates; badge only
  // where a number exists, slug labels elsewhere; same-date slugs sort by slug.
  assert.deepEqual(labels, ["ADR-001", "apple", "zebra"]);

  const r = spawnSync(process.execPath, [join(REPO, "scripts", "doctor.mjs"), "--vault", "--json"], {
    encoding: "utf8", env: { ...ENV, CLAUDE_PROJECT_DIR: proj }, cwd: REPO, timeout: 15000,
  });
  const findings = JSON.parse(r.stdout);
  const identityChecks = findings.filter((f) =>
    ["identity", "artifact-name", "external-refs", "spec-links"].includes(f.check));
  assert.deepEqual(identityChecks, [], JSON.stringify(identityChecks));
});

test("draft: digit-leading slug warns via the warnings array (contract 4)", () => {
  const { proj } = makeVaultProject();
  const out = runIn(proj, "draft.mjs", ["adr", "2026 Roadmap"]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /digit-leading/);
  assert.equal(out.collision, null);
});

test("draft: nextNumber is gone from the creation path (contract 1)", () => {
  assert.ok(!readFileSync(join(REPO, "scripts", "draft.mjs"), "utf8").includes("nextNumber"));
});

// ─── reconcile --write (spec: atomic-regeneration-of-derived-views) ────

// Raw sibling of runIn for tests that EXPECT a nonzero exit. runIn's
// status-0 assert is load-bearing as a failure message for six call sites —
// do not loosen it.
function runInRaw(projectDir, script, args) {
  return spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    encoding: "utf8", env: { ...ENV, CLAUDE_PROJECT_DIR: projectDir }, cwd: REPO, timeout: 15000,
  });
}

// A vault with one target of each kind dirty: kanban absent, code-map absent
// (epic carries code_refs), adr index empty with prose below the table.
function seedDerivedFixture() {
  const { proj, vault } = makeVaultProject();
  const fm = (extra) => `---\n${extra}\n---\n\n# T\n`;
  writeFileSync(join(vault, "adr", "README.md"),
    "# ADRs\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n\nPROSE BELOW THE TABLE.\n");
  writeFileSync(join(vault, "adr", "caching.md"),
    fm('type: adr\nid: "caching"\ntitle: "Caching"\nstatus: accepted\ndate: 2026-01-01\nexternal_refs: {}'));
  writeFileSync(join(vault, "epics", "PS-X", "epic.md"),
    fm('type: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-01-01\ncode_refs: ["scripts/"]'));
  writeFileSync(join(vault, "epics", "PS-X", "stories", "story-ship-it.md"),
    fm('type: story\nid: "story-ship-it"\ntitle: "Ship it"\nstatus: planned\ncreated: 2026-01-01\nexternal_refs: {}'));
  return { proj, vault };
}

const normEq = (s) => s.split("\n").filter((l) => !l.startsWith("generated_at:")).join("\n").trimEnd();

test("reconcile --write: applies compute output atomically, idempotent second pass (contracts 1, 4, 8)", () => {
  const { proj, vault } = seedDerivedFixture();
  const preview = runIn(proj, "reconcile.mjs", []);
  const w = runIn(proj, "reconcile.mjs", ["--write"]);
  assert.equal(w.summary.failed, 0, JSON.stringify(w));
  assert.ok(w.summary.written >= 3, JSON.stringify(w.summary)); // kanban + codemap + adr index
  assert.ok(!JSON.stringify(w).includes('"content"'), "--write emits no content on stdout");
  // On-disk bytes are normalize-equal to what compute previewed (contract 8).
  assert.equal(normEq(readFileSync(join(vault, "kanban.md"), "utf8")), normEq(preview.kanban.content));
  const adrIdx = preview.indexes.find((i) => i.folder === "adr");
  assert.equal(readFileSync(adrIdx.path, "utf8"), adrIdx.content);
  assert.ok(readFileSync(adrIdx.path, "utf8").includes("PROSE BELOW THE TABLE."), "prose preserved");
  const again = runIn(proj, "reconcile.mjs", ["--write"]);
  assert.equal(again.summary.written, 0, "immediately repeated --write is a fixed point");
  assert.equal(again.summary.changed, 0);
});

test("reconcile --write: recomputes at write time — status flip and prose edit in the approval gap both land (contract 3)", () => {
  const { proj, vault } = seedDerivedFixture();
  runIn(proj, "reconcile.mjs", ["--write"]); // settle
  assert.equal(runIn(proj, "reconcile.mjs", []).summary.changed, 0);
  // The approval gap: a second session flips a status and edits README prose.
  const storyPath = join(vault, "epics", "PS-X", "stories", "story-ship-it.md");
  writeFileSync(storyPath, readFileSync(storyPath, "utf8").replace("status: planned", "status: in-progress"));
  const readmePath = join(vault, "adr", "README.md");
  writeFileSync(readmePath, readFileSync(readmePath, "utf8").replace("PROSE BELOW THE TABLE.", "PROSE EDITED DURING APPROVAL."));
  const w = runIn(proj, "reconcile.mjs", ["--write"]);
  assert.equal(w.summary.failed, 0);
  const board = readFileSync(join(vault, "kanban.md"), "utf8");
  const inProgress = board.split(/^## In Progress$/m)[1].split(/^## /m)[0];
  assert.ok(inProgress.includes("Ship it"), "written board reflects the post-preview status");
  assert.ok(readFileSync(readmePath, "utf8").includes("PROSE EDITED DURING APPROVAL."), "prose edit survives");
});

test("reconcile --only: limits both modes; unknown/absent selectors die loudly (contract 6)", () => {
  const { proj, vault } = seedDerivedFixture();
  const w = runIn(proj, "reconcile.mjs", ["--write", "--only", "kanban"]);
  assert.ok(w.kanban.written);
  assert.equal(w.codemap.skipped, "not selected");
  assert.deepEqual(w.indexes, []);
  assert.ok(!existsSync(join(vault, "code-map.md")), "codemap untouched");
  assert.ok(!readFileSync(join(vault, "adr", "README.md"), "utf8").includes("caching"), "adr index untouched");

  const named = runIn(proj, "reconcile.mjs", ["--write", "--only", "indexes=adr"]);
  assert.equal(named.indexes.length, 1);
  assert.ok(named.indexes[0].written);
  assert.ok(readFileSync(join(vault, "adr", "README.md"), "utf8").includes("caching"));

  const unknown = runInRaw(proj, "reconcile.mjs", ["--only", "kanbn"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown selector/);

  const notInLayout = runInRaw(proj, "reconcile.mjs", ["--write", "--only", "indexes=nonexistent"]);
  assert.notEqual(notInLayout.status, 0);
  assert.match(notInLayout.stderr, /no folder/);

  // In the layout, named explicitly, but the vault has no README for it.
  const noReadme = runInRaw(proj, "reconcile.mjs", ["--write", "--only", "indexes=specs"]);
  assert.notEqual(noReadme.status, 0);
  assert.match(noReadme.stderr, /README/);
});

test("reconcile --write: partial failure — per-target error, remaining targets written, nonzero exit (contract 1)", () => {
  const { proj, vault } = seedDerivedFixture();
  mkdirSync(join(vault, "kanban.md")); // reading/replacing a directory fails
  const r = runInRaw(proj, "reconcile.mjs", ["--write"]);
  assert.notEqual(r.status, 0, "cron caller must notice");
  const j = JSON.parse(r.stdout);
  assert.ok(j.kanban.error, "failed target carries its error");
  assert.ok(j.kanban.path, "failed target still names its path");
  assert.notEqual(j.kanban.written, true);
  assert.ok(j.codemap.written, "remaining targets still attempted");
  assert.ok(j.indexes.find((i) => i.folder === "adr").written);
  assert.equal(j.summary.failed, 1);
});

test("reconcile compute: per-target error surfaces in summary.failed, exit stays 0 (reporting tool)", () => {
  const { proj, vault } = seedDerivedFixture();
  mkdirSync(join(vault, "kanban.md"));
  const r = runInRaw(proj, "reconcile.mjs", []);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.kanban.error);
  assert.equal(j.summary.failed, 1, "compute mode counts failures too");
});

test("reconcile --write: a named-absent index aborts BEFORE any side effect (contract 1)", () => {
  const { proj, vault } = seedDerivedFixture();
  // specs/ is in the layout but this vault has no specs/README.md.
  const r = runInRaw(proj, "reconcile.mjs", ["--write", "--only", "kanban,indexes=specs"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /specs\/README\.md/);
  assert.ok(!existsSync(join(vault, "kanban.md")),
    "config errors abort with nothing written — no unreported mutation");
});

// ─── link graph (spec: vault-link-graph-derived-view-and-shared-link-resolver) ──

// Its own fixture — seedDerivedFixture's exact board/write counts are pinned
// by six tests above; do not extend it. One artifact of every edge kind:
// two-sided supersedes and spec↔story declarations (must collapse to one
// edge each), a dead link, an ambiguous stem, an out-of-scope link repeated
// twice (dedup), and all three story shapes.
function seedGraphFixture() {
  const { proj, vault } = makeVaultProject();
  const put = (rel, content) => {
    mkdirSync(join(vault, dirname(rel)), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  const fm = (extra, body = "") => `---\n${extra}\n---\n\n# T\n${body}`;
  put(join("adr", "old-way.md"),
    fm('type: adr\nid: "old-way"\ntitle: "Old way"\nstatus: superseded\ndate: 2026-01-01\nsuperseded_by: "new-way"'));
  put(join("adr", "new-way.md"),
    fm('type: adr\nid: "new-way"\ntitle: "New way"\nstatus: accepted\ndate: 2026-01-02\nsupersedes: "old-way"',
      "\n[[kanban]] twice: [[kanban]]\n[[missing-target]]\n[[dup]]\n"));
  put(join("adr", "dup.md"), fm('type: adr\nid: "dup-adr"\ntitle: "Dup A"\nstatus: proposed\ndate: 2026-01-03'));
  put(join("specs", "dup.md"), fm('type: spec\nid: "dup-spec"\ntitle: "Dup S"\nstatus: draft\ndate: 2026-01-03'));
  put(join("specs", "covering.md"),
    fm('type: spec\nid: "covering"\ntitle: "Covering"\nstatus: active\ndate: 2026-01-01\nstories: ["PS-X/story-ship-it"]\nadr: ["new-way"]'));
  put(join("specs", "one-sided.md"),
    fm('type: spec\nid: "one-sided"\ntitle: "One sided"\nstatus: draft\ndate: 2026-01-04\nstories: ["PS-X/story-loose"]'));
  put(join("epics", "PS-X", "epic.md"),
    fm('type: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-01-01\ncode_refs: ["scripts/"]'));
  put(join("epics", "PS-X", "stories", "story-ship-it.md"),
    fm('type: story\nid: "story-ship-it"\ntitle: "Ship it"\nstatus: planned\ncreated: 2026-01-01\nspecs: ["covering"]',
      "\n[[new-way]]\n"));
  put(join("epics", "PS-X", "stories", "story-nested", "README.md"),
    fm('type: story\nid: "story-nested"\ntitle: "Nested"\nstatus: planned\ncreated: 2026-01-02'));
  put(join("epics", "PS-X", "story-loose.md"),
    fm('type: story\nid: "story-loose"\ntitle: "Loose | Pipe"\nstatus: planned\ncreated: 2026-01-02'));
  writeFileSync(join(vault, "kanban.md"), "stub board\n");
  return { proj, vault };
}

test("graph.mjs golden: three story shapes are nodes; typed edges normalized, deduplicated, plain-text, deterministic (contracts 2, 4)", () => {
  const { proj } = seedGraphFixture();
  const g1 = runIn(proj, "graph.mjs", []);
  const g2 = runIn(proj, "graph.mjs", []);
  assert.equal(normEq(g1.content), normEq(g2.content), "byte-identical modulo generated_at");
  for (const p of ["epics/PS-X/stories/story-ship-it.md",
                   "epics/PS-X/stories/story-nested/README.md",
                   "epics/PS-X/story-loose.md"]) {
    assert.ok(g1.content.includes(`| ${p} |`), `${p} is a node`);
  }
  const edges = g1.content.split("\n").filter((l) => l.startsWith("|")).map((l) => l.trim());
  assert.deepEqual(edges.filter((l) => l.includes("| spec-covers |")),
    ["| specs/covering.md | spec-covers | epics/PS-X/stories/story-ship-it.md |",
     "| specs/one-sided.md | spec-covers | epics/PS-X/story-loose.md |"],
    "two-sided declaration collapses to ONE edge; a one-sided declaration is still an edge");
  assert.ok(g1.content.includes("| epics/PS-X/story-loose.md | Loose \\| Pipe | story |"),
    "titles escape | inside tables");
  assert.deepEqual(edges.filter((l) => l.includes("| supersedes |")),
    ["| adr/new-way.md | supersedes | adr/old-way.md |"],
    "two-sided supersedes declaration collapses to one edge");
  assert.ok(edges.includes("| specs/covering.md | spec-implements-adr | adr/new-way.md |"));
  assert.ok(edges.includes("| epics/PS-X/epic.md | epic-contains | epics/PS-X/story-loose.md |"),
    "standalone story is contained by its epic");
  assert.ok(edges.includes("| adr/new-way.md | dead | missing-target |"), "dead To = raw target text");
  assert.ok(edges.includes("| adr/new-way.md | ambiguous | dup (matches: adr/dup.md, specs/dup.md) |"),
    "ambiguous lists candidate paths in the row");
  assert.equal(edges.filter((l) => l === "| adr/new-way.md | out-of-scope | kanban.md |").length, 1,
    "duplicate (from, to, kind) triple deduplicated");
  assert.ok(!g1.content.includes("[["), "plain text — never wikilinks (Obsidian backlink pollution)");
  assert.equal(g1.stats.by_kind["spec-covers"], 2);
  assert.ok(g1.stats.nodes >= 8 && g1.stats.edges >= 7);
});

test("reconcile graph: bare skips while absent, explicit creates, repairs edits, idempotent; grep contract holds (contract 1 + ACs)", () => {
  const { proj, vault } = seedGraphFixture();
  const bare = runIn(proj, "reconcile.mjs", ["--write"]);
  assert.match(bare.graph.skipped, /does not exist/);
  assert.ok(!existsSync(join(vault, "graph.md")), "bare --write never mints graph.md");
  // The standing signal for a missing/deleted graph (contracts 1 + 6).
  const missing = runIn(proj, "doctor.mjs", ["--vault", "--json"]);
  assert.ok(missing.some((f) => f.check === "graph" && f.level === "info"),
    "missing graph.md is a standing doctor info");

  const w = runIn(proj, "reconcile.mjs", ["--write", "--only", "graph"]);
  assert.ok(w.graph.written, "explicit selection creates it");
  const again = runIn(proj, "reconcile.mjs", ["--write", "--only", "graph"]);
  assert.equal(again.graph.written, false, "idempotent");
  const bare2 = runIn(proj, "reconcile.mjs", ["--write"]);
  assert.ok(!bare2.graph.skipped, "once the file exists, bare invocation includes it");

  // Grep contract: one path returns both directions.
  const story = "epics/PS-X/stories/story-ship-it.md";
  const rows = readFileSync(join(vault, "graph.md"), "utf8").split("\n").filter((l) => l.includes(story));
  assert.ok(rows.some((l) => l.startsWith(`| ${story} | wikilink |`)), "outgoing edge in the neighborhood");
  assert.ok(rows.some((l) => l.trimEnd().endsWith(`| spec-covers | ${story} |`)), "incoming edge in the neighborhood");

  // Hand-edit → doctor staleness issue → reconcile repairs → doctor clean.
  const p = join(vault, "graph.md");
  writeFileSync(p, readFileSync(p, "utf8") + "\nHAND EDIT\n");
  const stale = runIn(proj, "doctor.mjs", ["--vault", "--json"]);
  assert.ok(stale.some((f) => f.check === "graph" && f.level === "issue"), "doctor flags a hand-edited graph");
  const repair = runIn(proj, "reconcile.mjs", ["--write", "--only", "graph"]);
  assert.ok(repair.graph.written, "reconcile repairs an existing graph.md");
  const clean = runIn(proj, "doctor.mjs", ["--vault", "--json"]);
  assert.ok(!clean.some((f) => f.check === "graph"), "no graph findings after repair");
});

test("doctor↔graph parity: dead and ambiguous body links are the same facts in both reports (contract 5)", () => {
  const { proj } = seedGraphFixture();
  const wikilink = runIn(proj, "doctor.mjs", ["--vault", "--json"]).filter((f) => f.check === "wikilink");
  const dead = wikilink.filter((f) => f.level === "issue");
  const ambiguous = wikilink.filter((f) => f.level === "warn");
  assert.equal(dead.length, 1, JSON.stringify(wikilink));
  assert.match(dead[0].message, /missing-target/);
  assert.equal(ambiguous.length, 1, "ambiguous is a NEW warn the basename set could not see");
  assert.match(ambiguous[0].message, /dup.*adr\/dup\.md, specs\/dup\.md/);
  const g = runIn(proj, "graph.mjs", []);
  assert.deepEqual(g.content.split("\n").filter((l) => l.includes("| dead |")).map((l) => l.trim()),
    ["| adr/new-way.md | dead | missing-target |"]);
  assert.equal(g.content.split("\n").filter((l) => l.includes("| ambiguous |")).length, 1);
  // out-of-scope is silent in doctor: the [[kanban]] link produced no finding.
  assert.ok(!wikilink.some((f) => f.message.includes("kanban")), "out-of-scope is not a doctor finding");
});

test("generated_at is a full ISO timestamp on all three derived views (contract 6)", () => {
  const { proj } = seedGraphFixture();
  for (const script of ["kanban.mjs", "codemap.mjs", "graph.mjs"]) {
    const out = runIn(proj, script, []);
    assert.match(out.content, /^generated_at: \d{4}-\d\d-\d\dT\d\d:\d\d/m, script);
  }
});

test("agent prose carries the derived-views orientation contract (spec contract 7 guard)", () => {
  const SHARED = "Derived views (kanban.md, code-map.md, graph.md) are precomputed vault indexes";
  const FALLBACK = "missing or its `generated_at` predates recent artifact changes";
  for (const f of ["librarian.md", "reviewer.md", "critic.md", "archaeologist.md"]) {
    const src = readFileSync(join(REPO, "agents", f), "utf8");
    assert.ok(src.includes(SHARED), `${f} carries the shared derived-views sentence`);
    assert.ok(src.includes(FALLBACK), `${f} carries the freshness fallback`);
  }
  assert.match(readFileSync(join(REPO, "agents", "librarian.md"), "utf8"), /Edges table/,
    "librarian reads existing edges from the graph");
});

test("core writes only via lib.mjs writeFileAtomic (atomic-regeneration contract 2 guard)", () => {
  // Globbed so a future script is covered automatically. hooks/ is
  // deliberately out of scope: session-start's marker write is host-side
  // plumbing, not a vault write path — do not "complete" this refactor there.
  const dir = join(REPO, "scripts");
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "lib.mjs")) {
    const src = readFileSync(join(dir, n), "utf8");
    for (const call of ["writeFileSync", "renameSync", "appendFileSync", "createWriteStream",
                        "writeFile(", "copyFileSync", "truncateSync", "node:fs/promises"]) {
      assert.ok(!src.includes(call), `${n} contains ${call} — route writes through lib.mjs`);
    }
  }
});

test("command prose routes derived-view applies through reconcile --write (contract 7 guard)", () => {
  for (const [file, marker] of [
    ["reconcile.md", "--write --only"],
    ["kanban.md", "--write --only kanban"],
    ["codemap.md", "--write --only codemap"],
    ["graph.md", "--write --only graph"],
  ]) {
    const src = readFileSync(join(REPO, "commands", file), "utf8");
    assert.ok(src.includes(marker), `${file} applies via ${marker}`);
    assert.ok(!/Write (the generated content|each approved target|`content`)/.test(src),
      `${file} must carry no Write-tool apply step for a derived view`);
  }
  // `codemap set` edits SOURCE frontmatter — contract 7 exempts it explicitly.
  assert.match(readFileSync(join(REPO, "commands", "codemap.md"), "utf8"), /Edit the frontmatter/);
});

test("diff-refs: no args => fallback true; --since returns file lists", () => {
  const none = run("diff-refs.mjs", []);
  assert.equal(none.fallback, true);
  const since = run("diff-refs.mjs", ["--since", "2020-01-01T00:00:00Z"]);
  assert.ok(Array.isArray(since.files) && Array.isArray(since.uncommitted));
  assert.ok(!since.uncommitted.some((f) => f.endsWith("/")), "directories expanded to files");
  assert.ok(!since.files.some((f) => f.includes("package-lock")), "ignore globs applied");
});

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

// ─── creation-time index regeneration ────────────────────────────────────
// spec: creation-time-index-updates-are-regenerations-not-appends
//
// Its own fixture — seedDerivedFixture's exact board/write counts are pinned
// by six tests above; do not extend it. Every layout folder that carries a
// README gets an empty managed table plus prose below it, so a creation into
// any kind can be driven end to end.

const IDX_HEAD = "| File | Title | Status | Date |\n|------|-------|--------|------|\n";

function seedCreationFixture() {
  const { proj, vault } = makeVaultProject();
  for (const path of ["adr", "specs", "epics", "research", "concepts", "meetings", "ops"]) {
    mkdirSync(join(vault, path), { recursive: true });
    writeFileSync(join(vault, path, "README.md"),
      `# ${path}\n\n## Index\n\n${IDX_HEAD}\nPROSE BELOW THE TABLE.\n`);
  }
  return { proj, vault };
}

// The creation flow as the command prose performs it: draft (pure), Write the
// artifact, then regenerate that one folder's index through the core.
function createThrough(proj, draftArgs, extraDirs = []) {
  const out = runIn(proj, "draft.mjs", draftArgs);
  mkdirSync(dirname(out.path), { recursive: true });
  writeFileSync(out.path, out.content);
  for (const d of extraDirs) mkdirSync(join(dirname(out.path), d), { recursive: true });
  const rep = runIn(proj, "reconcile.mjs", ["--write", "--only", `indexes=${out.index.folder}`]);
  return { out, rep, entry: rep.indexes.find((i) => i.folder === out.index.folder) };
}

test("creation e2e: the index row lands via the core write path, prose survives, second pass is a no-op (contracts 1, 4)", () => {
  const { proj, vault } = seedCreationFixture();
  const { out, entry } = createThrough(proj, ["adr", "Cache invalidation"]);
  assert.equal(out.index.folder, "adr");
  assert.equal(entry.written, true, JSON.stringify(entry));

  const idx = readFileSync(join(vault, "adr", "README.md"), "utf8");
  assert.ok(idx.includes("[cache-invalidation](./cache-invalidation.md)"), idx);
  assert.ok(idx.includes("PROSE BELOW THE TABLE."), "manual prose outside the table survives");

  const again = runIn(proj, "reconcile.mjs", ["--write", "--only", "indexes=adr"]);
  assert.equal(again.indexes.find((i) => i.folder === "adr").written, false, "idempotent");
});

test("creation e2e: epic — subfolder shape, row written after the epic exists on disk (contract 1)", () => {
  const { proj, vault } = seedCreationFixture();
  const { out, entry } = createThrough(proj, ["epic", "PS-NEW", "Brand new epic"], ["stories"]);
  assert.equal(out.index.folder, "epics");
  assert.equal(entry.written, true, JSON.stringify(entry));
  const idx = readFileSync(join(vault, "epics", "README.md"), "utf8");
  assert.ok(idx.includes("[PS-NEW](./PS-NEW/epic.md)"), idx);
  assert.ok(idx.includes("PROSE BELOW THE TABLE."));
});

test("draft: index.folder is the layout folder, not the kind; stories carry no index (contract 1)", () => {
  const { proj } = seedCreationFixture();
  for (const [kind, folder] of [["runbook", "ops"], ["concept", "concepts"], ["meeting", "meetings"], ["adr", "adr"]]) {
    assert.equal(runIn(proj, "draft.mjs", [kind, "Some title"]).index.folder, folder,
      `${kind} must select its layout folder — a kind-derived selector would miss ${folder}`);
  }
  assert.equal(runIn(proj, "draft.mjs", ["story", "PS-X", "Some title"]).index, null);
});

test("draft: the previewed index row is byte-identical to the row the regeneration writes (contract 4)", () => {
  const { proj, vault } = seedCreationFixture();
  // meeting is the case that used to disagree: draft labelled by bare slug
  // while the regeneration labels by the date-prefixed filename stem.
  for (const args of [["adr", "Some decision"], ["meeting", "Some sync"], ["runbook", "Some drill"], ["epic", "PS-Z", "Some epic"]]) {
    const { out } = createThrough(proj, args, args[0] === "epic" ? ["stories"] : []);
    const rows = readFileSync(join(vault, out.index.folder, "README.md"), "utf8")
      .split("\n").filter((l) => l.startsWith("| ["));
    assert.ok(rows.includes(out.index.line),
      `${args[0]}: preview\n  ${out.index.line}\nis not among written rows\n  ${rows.join("\n  ")}`);
  }
});

test("creation e2e: rows land in SPEC-002 contract 8 order across eras (contract 4)", () => {
  const { proj, vault } = seedCreationFixture();
  const fm = (extra) => `---\n${extra}\n---\n\n# T\n`;
  writeFileSync(join(vault, "adr", "ADR-001-grandfathered.md"),
    fm('type: adr\nid: "ADR-001"\nnumber: "001"\ntitle: "Grandfathered"\nstatus: accepted\ndate: 2026-01-01'));
  writeFileSync(join(vault, "adr", "alpha.md"),
    fm('type: adr\nid: "alpha"\ntitle: "Alpha"\nstatus: accepted\ndate: 2026-01-01'));
  runIn(proj, "reconcile.mjs", ["--write", "--only", "indexes=adr"]);
  createThrough(proj, ["adr", "Zulu"]); // today's date — sorts last
  const labels = readFileSync(join(vault, "adr", "README.md"), "utf8")
    .split("\n").filter((l) => l.startsWith("| [")).map((l) => l.slice(3, l.indexOf("]")));
  assert.deepEqual(labels, ["ADR-001", "alpha", "zulu"]);
});

test("creation e2e: an unrecognized index header is rejected before any write; the artifact survives (contract 3)", () => {
  const { proj, vault } = seedCreationFixture();
  writeFileSync(join(vault, "adr", "README.md"), "# ADRs\n\n| Nope | Nah |\n|------|-----|\n\nPROSE.\n");
  const out = runIn(proj, "draft.mjs", ["adr", "Still created"]);
  writeFileSync(out.path, out.content);
  const r = runInRaw(proj, "reconcile.mjs", ["--write", "--only", `indexes=${out.index.folder}`]);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), "", "a named pre-flight rejection emits no stdout JSON");
  assert.match(r.stderr, /adr\/README\.md/);
  assert.ok(existsSync(out.path), "the creation is not rolled back by a failed index step");
  assert.ok(readFileSync(join(vault, "adr", "README.md"), "utf8").includes("PROSE."));
});

test("index header: extra hand-added columns are not the managed table — no silent column loss (contract 6)", () => {
  const { proj, vault } = seedCreationFixture();
  const five = "# ADRs\n\n| File | Title | Status | Date | Notes |\n|------|-------|--------|------|-------|\n" +
    "| [caching](./caching.md) | Caching | accepted | 2026-01-01 | hand-kept context |\n";
  writeFileSync(join(vault, "adr", "README.md"), five);
  writeFileSync(join(vault, "adr", "caching.md"),
    '---\ntype: adr\nid: "caching"\ntitle: "Caching"\nstatus: accepted\ndate: 2026-01-01\n---\n\n# T\n');
  const r = runInRaw(proj, "reconcile.mjs", ["--write", "--only", "indexes=adr"]);
  assert.notEqual(r.status, 0, "a five-column header is not a recognised index table");
  assert.equal(readFileSync(join(vault, "adr", "README.md"), "utf8"), five,
    "the hand-kept fifth column is never rewritten away");
  // doctor sees the same fact, per its own documented intent.
  const findings = runIn(proj, "doctor.mjs", ["--vault", "--json"]);
  assert.ok(findings.some((f) => f.check === "index-header" && f.file === "adr/README.md"),
    JSON.stringify(findings));
});

test("creation e2e: a localized index header reconciles (registry-driven, not an English literal)", () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(join(proj, ".claude", "projectstore.json"), JSON.stringify({
    vault_path: vault, layout: "engineering", language: "de", default_author: "Test",
  }));
  mkdirSync(join(vault, "adr"), { recursive: true });
  writeFileSync(join(vault, "adr", "README.md"),
    "# ADRs\n\n| Datei | Titel | Status | Datum |\n|-------|-------|--------|-------|\n\nPROSA.\n");
  const { out, entry } = createThrough(proj, ["adr", "Zwischenspeicher leeren"]);
  assert.equal(entry.written, true, JSON.stringify(entry));
  const idx = readFileSync(out.index.path, "utf8");
  assert.ok(idx.includes("[zwischenspeicher-leeren]"), idx);
  assert.ok(idx.includes("PROSA."), "prose survives in a localized vault too");
});

test("creation command prose applies index rows through the core, under one disclosed gate (contracts 1, 2)", () => {
  for (const file of ["adr.md", "spec.md", "epic.md", "research.md", "concept.md", "meeting.md", "runbook.md"]) {
    // Prose wraps at ~80 columns, so match against a whitespace-flattened
    // copy — a guard that a reflow can silence guards nothing.
    const src = readFileSync(join(REPO, "commands", file), "utf8").replace(/\s+/g, " ");
    assert.ok(src.includes("--write --only indexes="),
      `${file} must apply its index row via reconcile --write --only indexes=<folder>`);
    // Contract 2: collapsing two gates into one is only legitimate if the
    // surviving prompt says what it now covers. Without this assert the
    // disclosure can quietly regress while the call itself stays correct.
    assert.ok(/only gate/.test(src) && /whole managed index table is regenerated/.test(src),
      `${file}'s approval step must disclose the single gate and the whole-table regeneration`);
    assert.ok(/never (the )?Write\/Edit/i.test(src),
      `${file} must forbid the Write/Edit tools for the index row`);
    // No residual append path, including as a fallback beside the core call.
    assert.doesNotMatch(src, /append(s|ing)? .{0,40}index|index .{0,20}(row )?Edit|Edit .{0,20}index/i,
      `${file} must carry no Edit-append path for the index row`);
    // Positional, because the lexical assertions above are satisfiable by prose
    // that says the right words in the wrong place. These pin the ORDER the
    // contract actually depends on.
    const apply = src.indexOf("--write --only indexes=");
    // Scoped to the index step itself: a LATER step may legitimately gate a
    // source-artifact edit (spec.md's reciprocal `specs:` writes into stories),
    // which contract 7 of the atomic-regeneration spec exempts by the same
    // reasoning as `codemap set`. What must not exist is a prompt about the
    // index row — that is the second gate contract 2 removes.
    const rest = src.slice(apply);
    const nextStep = rest.search(/\s\d+\.\s/);
    const indexStep = nextStep === -1 ? rest : rest.slice(0, nextStep);
    assert.equal(indexStep.indexOf("AskUserQuestion"), -1,
      `${file} must ask nothing inside its index step — the approval at the creation gate already covers the row`);
    assert.ok(src.indexOf("only gate") < apply,
      `${file} must disclose the single gate in the approval step, before the index is written`);
    assert.ok(src.indexOf("index.line") !== -1 && src.indexOf("index.line") < apply,
      `${file} must print index.line in the preview — contract 4's byte-identity has no other user-visible surface`);
  }
  // doctor points at reconcile instead of offering hand-written index Edits.
  const doc = readFileSync(join(REPO, "commands", "doctor.md"), "utf8");
  assert.ok(!/Edits? for index rows/.test(doc), "doctor.md offers no index-row Edit");
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

// ─── Entry-rule hook behaviour (PS-AGENTS: artifact-first order) ───────
//
// Drives scripts/touch-session.mjs with synthetic hook payloads on stdin and
// asserts the parsed stdout. Everything here is contract-level: the event gate,
// the emitted channel, agent suppression, the once-per-armed-session marker,
// and guard scope.

function seedHookProject() {
  const root = mkdtempSync(join(tmpdir(), "ps-hook-"));
  const proj = join(root, "proj");
  const vault = join(root, "vault");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(join(vault, "epics", "PS-A", "stories"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: vault, layout: "engineering", language: "en" }), "utf8");
  return { root, proj, vault };
}

function seedStory(vault, name, status) {
  writeFileSync(join(vault, "epics", "PS-A", "stories", name),
    `---\ntype: story\nstatus: ${status}\n---\n\n# s\n`, "utf8");
}

function fireHook(proj, payload) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "touch-session.mjs")], {
    encoding: "utf8", input: JSON.stringify(payload), timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, cwd: proj,
  });
  assert.equal(r.status, 0, `hook must exit 0; stderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

function post(proj, file, extra = {}) {
  return fireHook(proj, {
    hook_event_name: "PostToolUse", session_id: extra.sid || "s1",
    tool_name: "Write", tool_input: { file_path: file },
    tool_response: { success: true }, ...extra,
  });
}

test("entry hook: fires once at the threshold, on PostToolUse additionalContext (contracts 10, 12, 15)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");

  assert.equal(post(proj, join(proj, "a.mjs")), null, "1 path — silent");
  assert.equal(post(proj, join(proj, "b.mjs")), null, "2 paths — silent");
  const out = post(proj, join(proj, "c.mjs"));
  assert.ok(out, "3 paths with no story in progress — fires");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("3 source files"), "shows the evidence");
  assert.ok(ctx.includes("/projectstore:story"), "names the action");
  assert.ok(/one-off fix/.test(ctx), "grants the exit");
  assert.equal(out.systemMessage, undefined,
    "systemMessage is user-only and would reach nobody who can act");

  assert.equal(post(proj, join(proj, "d.mjs")), null, "fires once per armed session");
});

test("entry hook: an in-progress story anywhere suppresses it (contracts 5, 8)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  seedStory(vault, "story-b.md", "in-progress");
  for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs"]) {
    assert.equal(post(proj, join(proj, f)), null, "work is tracked — nothing to say");
  }
});

test("entry hook: a planned story does not count as open (contract 5)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  post(proj, join(proj, "a.mjs")); post(proj, join(proj, "b.mjs"));
  assert.ok(post(proj, join(proj, "c.mjs")),
    "a story that never went through /projectstore:story plan is not open work");
});

test("entry hook: subagent writes count but never receive the reminder (contract 13)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  const asAgent = { agent_id: "a1", agent_type: "general-purpose" };
  assert.equal(post(proj, join(proj, "a.mjs"), asAgent), null);
  assert.equal(post(proj, join(proj, "b.mjs"), asAgent), null);
  assert.equal(post(proj, join(proj, "c.mjs"), asAgent), null,
    "the threshold is crossed inside a subagent, which cannot open a story");
  const out = post(proj, join(proj, "d.mjs"));
  assert.ok(out, "the main agent's next own call carries it, with the subagents' work counted");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("4 source files"));
});

test("entry hook: ignored paths never count (contract 1)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  for (const f of ["AGENTS.md", "CLAUDE.md", ".gitignore", "node_modules/x.js", ".claude/settings.json"]) {
    assert.equal(post(proj, join(proj, f)), null);
  }
  assert.equal(post(proj, join(proj, "a.mjs")), null, "still only 1 real source path");
});

test("entry hook: vault writes are not source, and the event gate holds (contracts 1, 11)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  const inVault = join(vault, "adr", "x.md");
  mkdirSync(dirname(inVault), { recursive: true });
  writeFileSync(inVault, "# x", "utf8");
  for (let i = 0; i < 4; i++) assert.equal(post(proj, inVault), null, "vault work is not source work");

  // The same script on PreToolUse must not run the source branch at all.
  const pre = fireHook(proj, {
    hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Write",
    tool_input: { file_path: join(proj, "a.mjs") },
  });
  assert.equal(pre, null, "PreToolUse never emits the entry reminder");
});

test("entry hook: a failed tool result registers nothing (contract 10)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  const failed = { tool_response: { success: false } };
  for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs"]) {
    assert.equal(post(proj, join(proj, f), failed), null, "work that did not happen is not work");
  }
});

test("entry hook: guard off silences it (contract 20)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, guard: "off" }), "utf8");
  for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs"]) {
    assert.equal(post(proj, join(proj, f)), null);
  }
});

// ─── Hook output shape guard ───────────────────────────────────────────
//
// The class of bug this exists for is invisible at runtime: a hook that emits a
// field its event does not carry RUNS, PRINTS, EXITS ZERO — and reaches nobody.
// hooks/pre-compact.mjs has been doing exactly that since it shipped, and no
// test in this suite could have caught it.
//
// Sources of truth, cited because the hooks reference does not tabulate this in
// one place: the per-event sections of the Claude Code hooks reference for the
// tool-call and SessionStart events, and the 2.1.163 changelog entry for
// `Stop` / `SubagentStop` ("can now return hookSpecificOutput.additionalContext
// ... and keep the turn going").
const HOOK_FIELDS = {
  PreToolUse: ["permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext"],
  PostToolUse: ["additionalContext"],
  PostToolUseFailure: ["additionalContext"],
  PostToolBatch: ["additionalContext"],
  UserPromptSubmit: ["additionalContext"],
  SessionStart: ["additionalContext"],
  Stop: ["additionalContext"],
  SubagentStop: ["additionalContext"],
  PreCompact: [], // top-level decision/reason only — no model-facing channel
};

// Known violations, each owned by a story. Listed so the suite stays green while
// the defect stays visible — never so it stays forgotten.
const KNOWN_SHAPE_VIOLATIONS = {
  "hooks/pre-compact.mjs":
    "story-precompact-survival-packet-targets-a-channel-precompact-does-not-have",
};

test("no hook emits a field its event does not carry (spec contract 22)", () => {
  // Derived from the registration, not hard-coded: a hook hosted under
  // scripts/ (touch-session.mjs already is) would otherwise escape the guard
  // entirely, which is the evasion most likely to happen by accident.
  const reg = JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf8"));
  const files = [...new Set(
    Object.values(reg.hooks).flatMap((entries) =>
      entries.flatMap((e) => (e.hooks || []).map((h) =>
        (h.command || "").replace(/^.*\$\{CLAUDE_PLUGIN_ROOT\}\//, "").trim()))))]
    .filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 4, `expected every registered hook script, got ${JSON.stringify(files)}`);
  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(join(REPO, rel), "utf8");
    const re = /hookEventName:\s*['"]([A-Za-z]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const event = m[1];
      assert.ok(event in HOOK_FIELDS, `${rel}: unknown hook event "${event}"`);
      // The emitted object is small in every hook here; a window is enough and
      // avoids pretending to parse JS.
      const window = src.slice(Math.max(0, m.index - 200), m.index + 300);
      for (const field of ["additionalContext", "permissionDecision", "updatedInput"]) {
        const emitted = new RegExp(`\\b${field}\\b\\s*[,:]`).test(window);
        if (emitted && !HOOK_FIELDS[event].includes(field)) {
          offenders.push({ rel, event, field });
        }
      }
    }
  }
  const unexpected = offenders.filter((o) => !(o.rel in KNOWN_SHAPE_VIOLATIONS));
  assert.deepEqual(unexpected, [], `hooks emitting an unsupported field: ${JSON.stringify(unexpected)}`);

  // And the known violation must still BE one: if it gets fixed, this fails and
  // the entry is removed, so the list cannot rot into a permanent excuse.
  for (const [rel, story] of Object.entries(KNOWN_SHAPE_VIOLATIONS)) {
    assert.ok(offenders.some((o) => o.rel === rel),
      `${rel} is listed as a known violation owned by ${story}, but no longer violates — remove the entry`);
  }
});

test("the block bump and the block content ship together (spec contract 24)", () => {
  const tmpl = readFileSync(join(REPO, "templates", "claude-md-block.md.tmpl"), "utf8");
  const doctor = readFileSync(join(REPO, "scripts", "doctor.mjs"), "utf8");
  const version = Number(doctor.match(/const AGENT_BLOCK_VERSION = (\d+);/)[1]);
  const marker = Number(tmpl.match(/projectstore:agents v(\d+)/)[1]);
  assert.equal(marker, version, "the template's marker and doctor's constant must agree");

  const hasEntryRule = /opens a vault artifact before it opens an editor/.test(tmpl);
  assert.equal(hasEntryRule, version >= 3,
    "v3 is what carries the entry rule — content and version cannot land apart, " +
    "because checkAgentsBlock compares the marker version alone");
  assert.ok(/Report instruction conflicts; do not arbitrate them/.test(tmpl),
    "the conflict clause is the other half of v3");

  // This repo dogfoods the block, so its own copy must be re-registered too.
  const own = readFileSync(join(REPO, "AGENTS.md"), "utf8");
  assert.equal(own, tmpl, "the repo's own AGENTS.md block is the template, re-registered");
});

test("registration must not strip the new block lines (spec contract 23)", () => {
  const src = readFileSync(join(REPO, "commands", "agents.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(/entry-rule line/.test(src) && /instruction-conflict line/.test(src),
    "the roster filter keeps only agent lines; these two are not agent lines and " +
    "must be named in the carve-out, or registration silently deletes the durable " +
    "copy of the rule from every bound project");
});

test("entry hook: read-only tool calls never count (spec contracts 2, 10)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  // The defect this pins, found in review: extractToolPath yields a path for
  // Read (file_path), Grep/Glob/LS (path) and NotebookRead (notebook_path), so
  // without a write-tool gate three read-only calls tripped the threshold and
  // the reminder announced work that never happened. Every earlier drive here
  // hardcoded tool_name: "Write", which is how the tests missed it.
  for (const t of ["Read", "Read", "Grep", "Glob", "LS", "NotebookRead"]) {
    assert.equal(
      fireHook(proj, {
        hook_event_name: "PostToolUse", session_id: "s1", tool_name: t,
        tool_input: { file_path: join(proj, `${t}.mjs`), path: join(proj, "docs") },
        tool_response: { success: true },
      }), null, `${t} reads; it does not write`);
  }
  // And a genuine write after all that noise is still only the first path.
  assert.equal(post(proj, join(proj, "a.mjs")), null, "score is 1, not 7");
});

// ── The Stop carrier (spec contract 14) ──

function fireStop(proj, payload) {
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "session-stop.mjs")], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "Stop", ...payload }),
    timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, cwd: proj,
  });
  assert.equal(r.status, 0, `Stop hook must exit 0; stderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

test("Stop carrier: covers the session that delegated all its writing (contract 14)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  const asAgent = { agent_id: "a1", agent_type: "general-purpose" };
  for (const f of ["a.mjs", "b.mjs", "c.mjs"]) post(proj, join(proj, f), asAgent);

  const out = fireStop(proj, { session_id: "s1" });
  assert.ok(out, "the main agent made no write of its own — Stop carries it");
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("3 source files"));

  assert.equal(fireStop(proj, { session_id: "s1" }), null,
    "create-then-emit: the second Stop finds the marker, so additionalContext " +
    "continuing the turn cannot loop");
});

test("Stop carrier: silent on stop_hook_active, agent identity, guard off, below threshold (contracts 13, 14, 20)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "planned");
  assert.equal(fireStop(proj, { session_id: "s1" }), null, "below the threshold");

  for (const f of ["a.mjs", "b.mjs", "c.mjs"]) post(proj, join(proj, f), { sid: "s2" });
  assert.equal(fireStop(proj, { session_id: "s2", stop_hook_active: true }), null,
    "never speaks while another Stop hook is already driving the turn");
  assert.equal(fireStop(proj, { session_id: "s2", agent_id: "a1", agent_type: "x" }), null,
    "same audience rule as the tool-call carrier");

  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, guard: "off" }), "utf8");
  assert.equal(fireStop(proj, { session_id: "s2" }), null, "guard off silences BOTH carriers");
});

test("Stop carrier: an open story suppresses it (contracts 5, 14)", () => {
  const { proj, vault } = seedHookProject();
  seedStory(vault, "story-a.md", "in-progress");
  for (const f of ["a.mjs", "b.mjs", "c.mjs"]) post(proj, join(proj, f), { sid: "s1" });
  assert.equal(fireStop(proj, { session_id: "s1" }), null);
});

// ── The rule payload (spec contract 17) ──

function fireRules(proj, payload = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "session-rules.mjs")], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", ...payload }),
    timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, cwd: proj,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

test("rule payload: inline, bounded, and silent under auto_inject false (contract 17)", () => {
  const { proj } = seedHookProject();
  const out = fireRules(proj, { session_id: "c1", source: "startup" });
  assert.ok(out, "delivered");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 2000,
    `payload is ${ctx.length} chars; over 10,000 the harness replaces it with a ` +
    "file path, and this hook exists precisely because the vault map already is");
  // Flattened before matching: the payload wraps, and a guard a reflow can
  // silence guards nothing — the same lesson the index-row prose guards learned.
  const flat = ctx.replace(/\s+/g, " ");
  assert.ok(/opens a vault artifact before it opens an editor/.test(flat), "carries the entry rule");
  assert.ok(/do not arbitrate them/.test(flat), "carries the conflict clause");

  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, auto_inject: false }), "utf8");
  assert.equal(fireRules(proj, { session_id: "c1" }), null,
    "a session that opted out of injection is exactly where the AGENTS.md block " +
    "remains the durable copy");
});

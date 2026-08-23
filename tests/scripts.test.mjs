// projectstore — CLI-script tests (PS-SPEC story-007/009 follow-up from the
// reviewer pass). The two new scripts are pure compute; drive them via
// spawnSync with CLAUDE_PROJECT_DIR pointed at this repo (its config supplies
// language/vault for story-section).
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { readAnchorState } from "../scripts/lib.mjs";
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

function fireHook(proj, payload, sessionsDir = null) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "touch-session.mjs")], {
    encoding: "utf8", input: JSON.stringify(payload), timeout: 15000,
    env: {
      ...process.env, CLAUDE_PROJECT_DIR: proj,
      // Without this the wired drives read the developer's real session
      // registry — live machine state inside a test, and two criteria that
      // cannot be driven at all.
      ...(sessionsDir ? { PROJECTSTORE_SESSIONS_DIR: sessionsDir } : {}),
    }, cwd: proj,
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
// the defect stays visible — never so it stays forgotten. Emptied when
// `hooks/pre-compact.mjs` stopped emitting into a channel PreCompact does not
// have; the rot-loop below forced the deletion into the same change.
const KNOWN_SHAPE_VIOLATIONS = {};

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

// ── SessionStart, driven for the first time (skeleton spec, step 1) ──
//
// Until today `grep -rn session-start tests/` returned exactly one comment,
// about an adjacent concern. So this hook had NO drive: every green suite in
// this repo's history said nothing whatever about the file the skeleton change
// rewrites. That is the shape v0.23.0 shipped a defect through — 209 passing
// tests pointed away from it — so the drive lands BEFORE any behaviour moves,
// and asserts only invariants that must survive the change.

function fireSessionStart(proj, payload = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "session-start.mjs")], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", ...payload }),
    timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, cwd: proj,
  });
  assert.equal(r.status, 0, `SessionStart hook must exit 0; stderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

test("SessionStart: delivers on additionalContext, and the welcome renders once per project", () => {
  const { proj, vault } = seedHookProject();
  writeFileSync(join(vault, "README.md"), "# Vault\n", "utf8");

  const first = fireSessionStart(proj, { session_id: "same", source: "startup" });
  assert.ok(first, "a bound project with auto_inject on always delivers");
  assert.equal(first.hookSpecificOutput.hookEventName, "SessionStart");
  const withWelcome = first.hookSpecificOutput.additionalContext;
  assert.ok(/projectstore is loaded for the first time/.test(withWelcome), "first run carries the welcome");

  // The SAME session id both times, deliberately: a second id would register as
  // an active sibling and add the multi-session warning, so the delta would no
  // longer be the welcome alone.
  const second = fireSessionStart(proj, { session_id: "same", source: "startup" });
  const without = second.hookSpecificOutput.additionalContext;
  assert.ok(!/loaded for the first time/.test(without),
    "the welcome is once per project, not once per session");
  assert.equal(withWelcome.length - without.length, 1077,
    "the welcome is a fixed 1,077-character term of the composed value, and the " +
    "skeleton spec's contract 3 does its arithmetic against exactly this number — " +
    "if you edited the welcome copy, update that contract in the same change");
});

test("SessionStart: auto_inject false emits no vault content, and still arms the entry reminder", () => {
  const { proj } = seedHookProject();
  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, auto_inject: false }), "utf8");

  const first = fireSessionStart(proj, { session_id: "a1", source: "startup" });
  const ctx = first.hookSpecificOutput.additionalContext;
  assert.ok(/loaded for the first time/.test(ctx),
    "the welcome sits BELOW the gate on purpose — a literal 'silent' reading of " +
    "this configuration would invite deleting a working feature");
  assert.ok(!/Projectstore vault:/.test(ctx), "but no vault content crosses the gate");

  // The marker now exists, so an opted-out session emits nothing at all.
  assert.equal(fireSessionStart(proj, { session_id: "a2", source: "startup" }), null);

  // And the entry reminder is still re-armed after a compaction. That read sits
  // ABOVE the auto_inject gate (entry-rule spec contract 16); the skeleton work
  // needs `source` and `session_id` too, and the natural tidy-up is to move the
  // whole session block together — which would break this silently, because the
  // entry-rule tests drive touch-session.mjs, not this hook.
  assert.equal(fireSessionStart(proj, { session_id: "a3", source: "compact" }), null);
  assert.ok(
    existsSync(join(proj, ".claude", ".projectstore", "state", "a3.fired", "armed")),
    "armReminder must stay above the auto_inject gate",
  );
});

// ── The skeleton reaches the model inline (contracts 3, 7, 16) ────────
//
// The story's baseline: on this project the old payload was 12.4 KB, so the
// harness wrote it to a file and handed the agent a path. Every assertion here
// is about the payload the agent actually receives, not about what was built.

function seedSkeletonVault() {
  const { root, proj, vault } = seedHookProject();
  const folders = ["adr", "specs", "epics", "research", "concepts", "meetings", "ops", "diagrams"];
  for (const f of folders) {
    mkdirSync(join(vault, f), { recursive: true });
    // A README shaped like the real ones: prose, then an index table. The
    // prose is the purpose; the table is artifact content and must not travel.
    writeFileSync(join(vault, f, "README.md"),
      `# ${f}\n\nThe ${f} folder holds ${f} artifacts.\n\n## Index\n\n| File | Title | Status |\n|---|---|---|\n` +
      Array.from({ length: 40 }, (_, i) =>
        `| [${f}-${i}](./${f}-${i}.md) | Zealously-Named-Artifact-${f}-${i} | accepted |`).join("\n") + "\n",
      "utf8");
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(vault, f, `${f}-${i}.md`), `---\ntype: ${f}\n---\n\n# ${f} ${i}\n`, "utf8");
    }
  }
  for (let e = 0; e < 6; e++) {
    const dir = join(vault, "epics", `PS-E${e}`, "stories");
    mkdirSync(dir, { recursive: true });
    for (let s = 0; s < 12; s++) {
      writeFileSync(join(dir, `story-${s}.md`),
        `---\ntype: story\nstatus: ${s < 2 ? "in-progress" : "done"}\ntitle: "Story ${e}.${s}"\n` +
        `started_at: "2026-08-0${(s % 9) + 1}T00:00:00Z"\n---\n\n# s\n`, "utf8");
    }
  }
  return { root, proj, vault };
}

test("SessionStart: the payload is a skeleton, delivered inline, with no artifact content", () => {
  const { proj } = seedSkeletonVault();
  fireSessionStart(proj, { session_id: "sk1", source: "startup" }); // burns the welcome
  const out = fireSessionStart(proj, { session_id: "sk1", source: "startup" });
  const ctx = out.hookSpecificOutput.additionalContext;

  assert.ok(ctx.length < 10000,
    `payload is ${ctx.length} chars — over 10,000 the harness writes it to a file ` +
    "and hands the agent a path, which is the defect this story exists to close");

  // Contract 9's five steps, contract 4's rows, contract 11's clause.
  const flat = ctx.replace(/\s+/g, " ");
  assert.ok(/How to work with this vault/.test(flat));
  assert.ok(/Before authoring an ADR or spec/.test(flat), "the deciding step, not just the searching ones");
  for (const f of ["adr", "specs", "epics", "research", "concepts", "meetings", "ops", "diagrams"]) {
    assert.ok(ctx.includes(`\`${f}/\``), `layout folder ${f} has a row`);
  }
  assert.ok(/regenerated/.test(flat), "the staleness clause");

  // Contract 7 — the vault has 320 artifacts and 72 stories, and not one of
  // their names may appear. A renderer that quoted a README whole would fail
  // here rather than merely be large.
  assert.ok(!/Zealously-Named-Artifact/.test(ctx), "no index-table content travels");
  assert.ok(!/\| \[adr-0\]/.test(ctx), "no index rows travel");
  // The prose above the first `## ` IS the purpose, and does travel.
  assert.ok(/The adr folder holds adr artifacts\./.test(ctx));

  // Contract 1 — the in-flight list is capped, and says so when it caps.
  const inflight = ctx.split("## In flight now")[1].split("##")[0].trim().split("\n");
  assert.ok(inflight.length <= 6, `in-flight rendered ${inflight.length} lines`);
  assert.ok(/…and \d+ more/.test(inflight[inflight.length - 1]),
    "12 stories are in progress; five rendered silently is a truncation wearing the face of a complete answer");
});

test("SessionStart: the payload does not grow with the vault (contract 2, driven)", () => {
  const big = seedSkeletonVault();
  fireSessionStart(big.proj, { session_id: "sk2", source: "startup" });
  const grown = fireSessionStart(big.proj, { session_id: "sk2", source: "startup" })
    .hookSpecificOutput.additionalContext;

  const small = seedHookProject();
  for (const f of ["adr", "specs", "epics", "research", "concepts", "meetings", "ops", "diagrams"]) {
    mkdirSync(join(small.vault, f), { recursive: true });
    writeFileSync(join(small.vault, f, "README.md"), `# ${f}\n\nThe ${f} folder holds ${f} artifacts.\n`, "utf8");
  }
  fireSessionStart(small.proj, { session_id: "sk3", source: "startup" });
  const bare = fireSessionStart(small.proj, { session_id: "sk3", source: "startup" })
    .hookSpecificOutput.additionalContext;

  // Mask the digits (counts legitimately differ) and the in-flight list, then
  // the two payloads must be the same string. Comparing lengths would pass on a
  // renderer that leaked one artifact per folder and lost a word elsewhere.
  const mask = (s) => s
    .replace(/^# Projectstore vault: .*$/m, "# Projectstore vault: <path>")
    .replace(/\d+/g, "N")
    .split("## In flight now")[0];
  assert.equal(mask(grown), mask(bare),
    "320 artifacts against 0 — the payload must be byte-identical outside counts");
});

// ── Contract 3: the composed cap is structural, term by term ──────────
//
// Three kinds of unbounded input reach this payload — free-text errors,
// filesystem paths, and the sibling list. Two earlier revisions of the spec
// each declared their enumeration complete and were wrong, so these drive the
// KINDS rather than the sites.

function seedSiblings(vault, n, rootLen = 40) {
  const dir = join(vault, ".projectstore", "sessions");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `sib-${i}.json`), JSON.stringify({
      id: `sib-${i}`,
      started_at: "2026-08-17T00:00:00.000Z",
      project_root: "/" + "deeply-nested-worktree-".repeat(Math.ceil(rootLen / 23)).slice(0, rootLen) + `/p${i}`,
    }), "utf8");
  }
}

test("SessionStart contract 3: the sibling list is capped at 5 and says how many it dropped", () => {
  const { proj, vault } = seedHookProject();
  seedSiblings(vault, 40);
  fireSessionStart(proj, { session_id: "cap1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "cap1", source: "startup" })
    .hookSpecificOutput.additionalContext;

  const listed = (ctx.match(/^- project: /gm) || []).length;
  assert.equal(listed, 5, `rendered ${listed} siblings; uncapped this breaches the composed cap at ~32`);
  assert.ok(/…and 35 more/.test(ctx), "a silent truncation reads as a complete answer");
  assert.ok(ctx.length < 10000, `composed payload is ${ctx.length} chars`);
});

test("SessionStart contract 3: a sibling path and the vault path truncate at 200, keeping their tails", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-long-"));
  // A vault path over 200 characters, built out of real directories.
  const deep = join(root, ...Array.from({ length: 8 }, (_, i) => `segment-${i}-${"x".repeat(20)}`));
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(join(deep, "epics"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: deep, layout: "engineering", language: "en" }), "utf8");
  assert.ok(deep.length > 200, `fixture vault path is ${deep.length} chars`);
  seedSiblings(deep, 1, 400);

  fireSessionStart(proj, { session_id: "long1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "long1", source: "startup" })
    .hookSpecificOutput.additionalContext;

  const header = ctx.split("\n")[0];
  assert.ok(header.length <= "# Projectstore vault: ".length + 200,
    `header is ${header.length} chars`);
  assert.ok(header.includes("…"), "a truncation marks itself");
  assert.ok(header.endsWith(deep.slice(-40)), "the tail is kept — it is the discriminating half");

  const sib = ctx.split("\n").find((l) => l.startsWith("- project: "));
  const cell = sib.match(/`([^`]*)`/)[1];
  assert.ok(cell.length <= 200, `sibling path cell is ${cell.length} chars`);
  assert.ok(cell.startsWith("…"));
});

test("SessionStart contract 3: a registration failure's free-text message truncates at 500", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-err-"));
  // A vault path long enough that node's own ENOTDIR message — which quotes the
  // full path — exceeds 500 characters on its own.
  const deep = join(root, ...Array.from({ length: 14 }, (_, i) => `seg-${i}-${"y".repeat(30)}`));
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(join(deep, "epics"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: deep, layout: "engineering", language: "en" }), "utf8");
  // The sessions path exists as a FILE, so mkdir throws where registration runs.
  mkdirSync(join(deep, ".projectstore"), { recursive: true });
  writeFileSync(join(deep, ".projectstore", "sessions"), "not a directory", "utf8");

  fireSessionStart(proj, { session_id: "err1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "err1", source: "startup" })
    .hookSpecificOutput.additionalContext;

  assert.ok(/session registration failed/.test(ctx), "the failure is reported, not swallowed");
  const body = ctx.split("session registration failed")[1].split("\n").filter(Boolean)[0];
  assert.ok(body.length <= 500, `error body is ${body.length} chars — e.message is free text`);
  assert.ok(body.endsWith("…"), "truncated, and it marks itself");
  // Registration failure REPLACES the sibling warning; they must not compound.
  assert.ok(!/Multi-session warning/.test(ctx));
  assert.ok(ctx.length < 10000);
});

// ── Contract 23: the current session is exempt from its own reaper ────
//
// `cleanupStaleSessions` had ZERO coverage before this test, and the three
// assertions are not interchangeable. The on-disk one catches an
// implementation that merely reorders; the sibling one catches an
// implementation that deletes the cleanup call outright, which passes
// everything else while leaking session files forever.

test("SessionStart contract 23: an overnight session keeps its own history, and stale siblings still go", () => {
  const { proj, vault } = seedHookProject();
  const dir = join(vault, ".projectstore", "sessions");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 40 * 60 * 60 * 1000); // 40h — well past the 24h reap

  const mine = join(dir, "overnight.json");
  writeFileSync(mine, JSON.stringify({
    id: "overnight",
    started_at: "2026-08-15T00:00:00.000Z",
    project_root: proj,
    recent_activity: [{ path: join(vault, "adr", "kept.md"), tool: "Edit", at: "2026-08-15T01:00:00.000Z" }],
  }), "utf8");
  utimesSync(mine, old, old);

  const sibling = join(dir, "abandoned.json");
  writeFileSync(sibling, JSON.stringify({ id: "abandoned", project_root: "/gone" }), "utf8");
  utimesSync(sibling, old, old);

  fireSessionStart(proj, { session_id: "overnight", source: "compact" });

  // 1. Our own file is still there…
  assert.ok(existsSync(mine), "a live session's file is not stale; reaping it is pure data destruction");
  // 2. …with its history intact. A reap followed by writeSession would leave a
  //    valid file holding nothing, which the existence check alone would pass.
  const after = JSON.parse(readFileSync(mine, "utf8"));
  assert.equal(after.recent_activity.length, 1, "recent_activity survived");
  assert.equal(after.started_at, "2026-08-15T00:00:00.000Z", "so did the original start time");
  // 3. The exemption is a NARROWING, not a removal.
  assert.ok(!existsSync(sibling),
    "cleanup still runs — an implementation that simply deleted the call passes both assertions above");
});

// ── Contracts 19, 21: the continuity section, driven across every source ──
//
// Six drives, asserting presence for exactly one. A suite driving only
// `compact` passes on a renderer with no condition at all; `fork` and the
// missing-source drive are the only two that kill the deny-list form, which is
// the form that reads as correct.

function seedCompactSession(vault, sid, paths) {
  const dir = join(vault, ".projectstore", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify({
    id: sid,
    started_at: "2026-08-17T00:00:00.000Z",
    project_root: "/p",
    // Newest FIRST, as appendActivity leaves it — so the array order and the
    // timestamps agree. Stamped backwards, an implementation that sorted on
    // `at` would invert the rendered list and keep every assertion green.
    recent_activity: paths.map(([p, tool], i) => ({
      path: join(vault, p), tool,
      at: `2026-08-17T${String(20 - i).padStart(2, "0")}:00:00.000Z`,
    })),
  }), "utf8");
}

const HEADING = "Where this session left off";

test("SessionStart contract 19: the continuity section renders on compact and on nothing else", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn", source: "startup" }); // burn the welcome

  for (const source of ["startup", "resume", "clear", "fork", "compact", undefined]) {
    const sid = `src-${String(source)}`;
    // Every drive seeds a nonempty log, so absence can only come from the gate.
    // Contract 21 states the sufficient condition; an unseeded compact drive
    // would fail for a reason that looks like an implementation bug.
    seedCompactSession(vault, sid, [["epics/PS-A/stories/story-a.md", "Edit"]]);
    const payload = { session_id: sid };
    if (source !== undefined) payload.source = source;
    const ctx = fireSessionStart(proj, payload).hookSpecificOutput.additionalContext;
    if (source === "compact") {
      assert.ok(ctx.includes(HEADING), "compact carries it");
      assert.ok(ctx.includes("`epics/PS-A/stories/story-a.md`"), "with the path the log held");
    } else {
      assert.ok(!ctx.includes(HEADING),
        `source ${String(source)} must render nothing — not an empty header, absent`);
    }
  }
});

test("SessionStart contract 21: an empty log renders absence, not an empty header", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn2", source: "startup" });
  seedCompactSession(vault, "empty1", []);
  const ctx = fireSessionStart(proj, { session_id: "empty1", source: "compact" })
    .hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes(HEADING),
    "a missing continuity section asserts nothing; an empty one asserts we looked and found nothing");
  // And a missing session_id on compact reaches the same absence by another route.
  const noId = fireSessionStart(proj, { source: "compact" }).hookSpecificOutput.additionalContext;
  assert.ok(!noId.includes(HEADING), "stdin can parse carrying a source and no id");
});

test("SessionStart contracts 19, 20: the list caps at five, marks it, and names the newest write", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn3", source: "startup" });
  seedCompactSession(vault, "many", [
    ["adr/a-read.md", "Read"],                       // newest, but not a write
    ["epics/PS-A/stories/story-live.md", "Edit"],    // the in-flight artifact
    ["adr/a1.md", "Write"], ["adr/a2.md", "Write"], ["adr/a3.md", "Write"],
    ["adr/a4.md", "Write"], ["adr/a5.md", "Write"], ["adr/a6.md", "Write"],
  ]);
  const ctx = fireSessionStart(proj, { session_id: "many", source: "compact" })
    .hookSpecificOutput.additionalContext;
  const section = ctx.split(HEADING)[1].split("## Derived views")[0];
  assert.equal((section.match(/^- `/gm) || []).length, 5, "capped at five");
  assert.ok(/…and 3 more/.test(section), "and it says how many it dropped");
  assert.ok(/\*\*In flight\*\*: `epics\/PS-A\/stories\/story-live\.md`/.test(section),
    "the newest WRITE, not the newest entry");
});

test("SessionStart contract 19: a path over 200 truncates with the mark outside the backticks", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn4", source: "startup" });
  const long = "adr/" + "z".repeat(120) + "/" + "w".repeat(120) + ".md";
  seedCompactSession(vault, "longpath", [[long, "Write"]]);
  const ctx = fireSessionStart(proj, { session_id: "longpath", source: "compact" })
    .hookSpecificOutput.additionalContext;
  const line = ctx.split("\n").find((l) => l.startsWith("- …`"));
  assert.ok(line, "front-truncated, and the mark leads the line");
  const token = line.match(/`([^`]*)`/)[1];
  assert.ok(token.length <= 200 && !token.includes("…"),
    "what a reader copies must be a clean substring — graph.md holds zero `…` characters");
  assert.ok(long.endsWith(token), "the tail is kept: it carries the filename and the discriminating half");
});

test("SessionStart contract 3: the vault-load failure path truncates its free text too", () => {
  const { proj } = seedHookProject();
  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  // loadLayout throws, quoting the name and the resolved path — made long here
  // so the raw message is over 500 characters on its own.
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, layout: "q".repeat(600) }), "utf8");
  fireSessionStart(proj, { session_id: "vl1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "vl1", source: "startup" })
    .hookSpecificOutput.additionalContext;
  assert.ok(/vault load failed/.test(ctx), "the hook reports rather than crashes (contract 17)");
  const body = ctx.split("vault load failed")[1].split("\n").filter(Boolean)[0];
  assert.ok(body.length <= 500, `error body is ${body.length} chars`);
  assert.ok(body.endsWith("…"));
});

// ── Contracts 22, 24: PreCompact says one true thing on one real channel ──
//
// Driven, not inspected. The shape guard above stops seeing this file the
// moment its literal `hookEventName` goes, so after the fix it asserts nothing
// whatever about it — the static greps below are belt, and the drives are the
// actual check.

function firePreCompact(proj, payload = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "hooks", "pre-compact.mjs")], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreCompact", ...payload }),
    timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, cwd: proj,
  });
  assert.equal(r.status, 0, `PreCompact hook must exit 0; stderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

const DELIVERY_CLAIM = /return at session start|survival packet|injected/i;

test("PreCompact contract 22: nothing but systemMessage, on every path", () => {
  const { proj, vault } = seedHookProject();
  seedCompactSession(vault, "pc1", [["epics/PS-A/stories/story-x.md", "Edit"]]);
  for (const payload of [
    { session_id: "pc1", trigger: "manual" },
    { session_id: "pc1", trigger: "auto" },
    { session_id: "no-such-session", trigger: "manual" },
    { trigger: "manual" },
    {},
  ]) {
    const out = firePreCompact(proj, payload);
    assert.deepEqual(Object.keys(out), ["systemMessage"],
      `${JSON.stringify(payload)} emitted ${JSON.stringify(Object.keys(out))} — an invalid ` +
      "hookSpecificOutput sinks the whole object, systemMessage included");
    assert.ok(!/survival packet injected/.test(out.systemMessage));
  }
});

test("PreCompact contract 22: the delivery claim needs manual AND auto_inject on", () => {
  const { proj, vault } = seedHookProject();
  seedCompactSession(vault, "pc2", [["epics/PS-A/stories/story-x.md", "Edit"]]);

  const manual = firePreCompact(proj, { session_id: "pc2", trigger: "manual" }).systemMessage;
  assert.ok(/return at session start/.test(manual), "manual + auto_inject on: the claim is evidenced");
  assert.ok(/recent files/.test(manual), "and the log is nonempty, so the stronger referent holds");

  // On `auto` this plugin makes no claim that SessionStart fires at all.
  const auto = firePreCompact(proj, { session_id: "pc2", trigger: "auto" }).systemMessage;
  assert.ok(!DELIVERY_CLAIM.test(auto), `auto claimed delivery: ${auto}`);
  assert.ok(/projectstore:status/.test(auto), "and still offers something true");

  // The axis a source-based walk never reaches: config.
  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, auto_inject: false }), "utf8");
  const off = firePreCompact(proj, { session_id: "pc2", trigger: "manual" }).systemMessage;
  assert.ok(!DELIVERY_CLAIM.test(off),
    `manual under auto_inject:false claimed delivery — deterministically false, not merely unevidenced: ${off}`);
  assert.ok(/in flight: `epics\/PS-A\/stories\/story-x\.md`/.test(off),
    "naming the artifact is a fact about the log, not a promise, and survives the gate");
});

test("PreCompact contract 22: an empty log weakens the claim rather than falsifying it", () => {
  const { proj, vault } = seedHookProject();
  seedCompactSession(vault, "pc3", []);
  const msg = firePreCompact(proj, { session_id: "pc3", trigger: "manual" }).systemMessage;
  assert.ok(/orientation returns at session start/.test(msg), "the skeleton still comes back");
  assert.ok(!/recent files/.test(msg),
    "an empty log renders no continuity section — the stronger wording would be false here");
  assert.ok(!/in flight/.test(msg), "and nothing resolves, so the clause is dropped, not rendered empty");
});

test("PreCompact contract 24: it calls the shared resolver and re-implements nothing", () => {
  const src = readFileSync(join(REPO, "hooks", "pre-compact.mjs"), "utf8");
  assert.ok(!/hookSpecificOutput/.test(src), "the identifier is gone from the file, not merely unused");
  // An unused import satisfies nothing — the CALL must be there.
  const calls = src.split("resolveInFlightArtifact(").length - 1;
  assert.ok(calls >= 1, "no call site: the resolver is imported and ignored");
  // After the fix these have no legitimate occurrence here in any form. This
  // closes the array-literal clone that "no tool-name alternation" left open.
  for (const literal of ["MultiEdit", "NotebookEdit", "STRUCTURED_ARTIFACT_RX"]) {
    assert.ok(!src.includes(literal),
      `${literal} reappeared in pre-compact.mjs — the resolver is shared, or it is two resolvers`);
  }
  // The header comment is what the next reader believes over the code.
  assert.ok(!/Two channels are used/.test(src));
});

test("the shape-violation registry is empty (spec contract 22)", () => {
  assert.deepEqual(KNOWN_SHAPE_VIOLATIONS, {},
    "an entry deleted rather than merely unused is what stops a returning field passing");
});

// ── Review follow-ups: the bounds and shapes the first pass missed ────

test("SessionStart contract 17: a missing vault keeps its one-line shape", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-novault-"));
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: join(root, "NO_SUCH_VAULT"), layout: "engineering" }), "utf8");

  // Driven WITH a session_id, twice — the path every real session takes. A
  // first revision of this fix skipped the id, which documented the hole
  // instead of covering it: registration's recursive mkdir manufactures the
  // vault, and from run 2 the skeleton asserts zeros about it.
  fireSessionStart(proj, { session_id: "nv1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "nv1", source: "startup" })
    .hookSpecificOutput.additionalContext;

  assert.ok(/^# projectstore: vault not found at /.test(ctx), `got: ${ctx.slice(0, 120)}`);
  assert.ok(!/Where things live/.test(ctx),
    "eight rows of authoritative zeros about a vault that does not exist is the " +
    "silently-false claim contracts 13 and 21 refuse");
  assert.ok(!/nothing in progress/.test(ctx));
  assert.ok(!existsSync(join(root, "NO_SUCH_VAULT")),
    "and the hook did not quietly create the vault it failed to find");
});

test("SessionStart contract 3: free-text config cannot breach the composed cap", () => {
  const { proj, vault } = seedHookProject();
  const cfgPath = join(proj, ".claude", "projectstore.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, language: "L".repeat(3000) }), "utf8");
  writeFileSync(join(vault, ".projectstore.json"),
    JSON.stringify({ spec_policy: "S".repeat(3000), lifecycle_gates: "G".repeat(3000) }), "utf8");
  // A directory name is bounded only by NAME_MAX, and five of them render.
  const epic = join(vault, "epics", "E".repeat(200));
  mkdirSync(join(epic, "stories"), { recursive: true });
  writeFileSync(join(epic, "epic.md"), "---\ntype: epic\n---\n", "utf8");
  writeFileSync(join(epic, "stories", "story-a.md"),
    `---\ntype: story\nstatus: in-progress\ntitle: "${"T".repeat(500)}"\nstarted_at: "2026-08-01"\n---\n`, "utf8");

  // And the term the first fix left raw: `started_at` is free text from a
  // session file this process never wrote, rendered once per sibling. Five of
  // them at 3,000 characters composed a 17,934-character payload.
  const sdir = join(vault, ".projectstore", "sessions");
  mkdirSync(sdir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(sdir, `sib-${i}.json`), JSON.stringify({
      id: `sib-${i}`, project_root: `/p${i}`, started_at: "S".repeat(3000),
    }), "utf8");
  }

  fireSessionStart(proj, { session_id: "cap3", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "cap3", source: "startup" })
    .hookSpecificOutput.additionalContext;
  assert.ok(/Multi-session warning/.test(ctx), "the sibling term is actually in this payload");
  assert.ok(ctx.length < 10000,
    `payload is ${ctx.length} chars — config is free text, and a bound is only as good as its enumeration`);
  const header = ctx.split("\n")[1];
  assert.ok(header.length < 400, `header line is ${header.length} chars`);
});

test("SessionStart contract 3: welcome + continuity + capped siblings, the stated worst case", () => {
  const { proj, vault } = seedHookProject();
  // Driven on the FIRST fire of a fresh project, which is when the welcome
  // renders — and it renders whatever the source is. (The marker write is also
  // best-effort inside a catch, so on a project where it cannot land the
  // welcome recurs at every start; either way the composition is reachable,
  // which is the point contract 3 makes.)
  seedSiblings(vault, 40);
  seedCompactSession(vault, "worst", [
    ["epics/PS-A/stories/story-a.md", "Edit"], ["adr/b.md", "Write"], ["adr/c.md", "Write"],
    ["adr/d.md", "Write"], ["adr/e.md", "Write"], ["adr/f.md", "Write"], ["adr/g.md", "Write"],
  ]);
  const out = fireSessionStart(proj, { session_id: "worst", source: "compact" });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(/projectstore is loaded for the first time/.test(ctx), "the welcome is present");
  assert.ok(ctx.includes(HEADING), "and the continuity section");
  assert.ok(/…and 35 more/.test(ctx), "and the capped sibling list");
  assert.ok(ctx.length < 10000, `the stated worst case composes to ${ctx.length} chars`);
});

test("SessionStart contract 4: every folder of the LAYOUT appears, iterated not listed", () => {
  const { proj } = seedSkeletonVault();
  fireSessionStart(proj, { session_id: "lay1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "lay1", source: "startup" })
    .hookSpecificOutput.additionalContext;
  // Read from the layout the hook actually resolves. Naming the eight folders
  // literally leaves a ninth one, silently dropped by the gather, green.
  const layout = JSON.parse(readFileSync(join(REPO, "scaffold", "layouts", "engineering.json"), "utf8"));
  for (const f of layout.folders) {
    assert.ok(ctx.includes(`\`${f.path}/\``), `layout folder ${f.path} has no row`);
  }
  assert.equal((ctx.match(/^\| `[^`]+\/` \|/gm) || []).length, layout.folders.length,
    "one row per layout folder, no more");
});

test("SessionStart contract 12: folder-shaped and standalone stories both reach the list", () => {
  const { proj, vault } = seedHookProject();
  const epic = join(vault, "epics", "PS-A");
  mkdirSync(join(epic, "stories"), { recursive: true });
  writeFileSync(join(epic, "epic.md"), "---\ntype: epic\n---\n", "utf8");
  const fm = (t, at) => `---\ntype: story\nstatus: in-progress\ntitle: "${t}"\nstarted_at: "${at}"\n---\n`;
  writeFileSync(join(epic, "stories", "story-nested.md"), fm("Nested", "2026-08-02T00:00:00Z"), "utf8");
  writeFileSync(join(epic, "story-standalone.md"), fm("Standalone", "2026-08-01T00:00:00Z"), "utf8");

  fireSessionStart(proj, { session_id: "sh1", source: "startup" });
  const ctx = fireSessionStart(proj, { session_id: "sh1", source: "startup" })
    .hookSpecificOutput.additionalContext;
  assert.ok(/- PS-A · Nested/.test(ctx), "the folder-shaped story");
  assert.ok(/- PS-A · Standalone/.test(ctx),
    "the standalone one — a per-epic loop that skipped it would look correct");
});

test("SessionStart contracts 19, 21: the two continuity degradations never share their text", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn5", source: "startup" });
  // In-flight resolves fine; only the activity read is made to hang, so the
  // near-identical in-flight expiry line cannot stand in for this assertion.
  seedCompactSession(vault, "slow", [["adr/a.md", "Write"]]);
  const spath = join(vault, ".projectstore", "sessions", "slow.json");
  writeFileSync(spath, readFileSync(spath, "utf8"));
  // A directory where the session JSON should be: the read rejects rather than
  // hangs, which exercises the [] path; the timeout branch is unit-tested at
  // tests/predicates.test.mjs with an unresolvable reader.
  const ctx = fireSessionStart(proj, { session_id: "slow", source: "compact" })
    .hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(HEADING) && /- `adr\/a\.md`/.test(ctx), "resolved: the section renders");
  assert.ok(!/recent activity not resolved within budget/.test(ctx));
});

test("SessionStart contract 19: the rendered path list is newest-first", () => {
  const { proj, vault } = seedHookProject();
  fireSessionStart(proj, { session_id: "burn6", source: "startup" });
  seedCompactSession(vault, "order", [
    ["adr/newest.md", "Write"], ["adr/middle.md", "Write"], ["adr/oldest.md", "Write"],
  ]);
  const ctx = fireSessionStart(proj, { session_id: "order", source: "compact" })
    .hookSpecificOutput.additionalContext;
  const listed = (ctx.split(HEADING)[1].match(/^- `adr\/([a-z]+)\.md`$/gm) || [])
    .map((l) => l.match(/adr\/([a-z]+)\.md/)[1]);
  assert.deepEqual(listed, ["newest", "middle", "oldest"], "log order IS newest-first");
});

test("PreCompact contract 19: a >200 path renders in the same cell the skeleton uses", () => {
  const { proj, vault } = seedHookProject();
  const long = "adr/" + "z".repeat(120) + "/" + "w".repeat(120) + ".md";
  seedCompactSession(vault, "pcl", [[long, "Write"]]);
  const msg = firePreCompact(proj, { session_id: "pcl", trigger: "manual" }).systemMessage;
  const token = msg.match(/in flight: …`([^`]*)`/)[1];
  assert.ok(token.length <= 200 && long.endsWith(token),
    "one path form: truncated here exactly as it is in the continuity section");
});

// ─── Session-name offer, wired (ADR: the settled-anchor offer) ─────────
//
// The pure rule is driven in predicates.test.mjs against recorded fixtures.
// These drive the HOOK, and they exist because the fixtures cannot: every
// recorded session is an authoring session, so nothing in them can show that a
// read or a subagent write is excluded. Those two gates are the difference
// between the measured rule and the wired one.

function vaultWrite(proj, vault, rel, extra = {}) {
  const { sessionsDir, ...rest } = extra;
  return fireHook(proj, {
    hook_event_name: "PreToolUse", session_id: extra.sid || "n1",
    tool_name: extra.tool || "Edit", tool_input: { file_path: join(vault, rel) },
    ...rest,
  }, sessionsDir);
}

// A registry of live sessions, as the harness maintains it. Every wired drive
// above runs against an EMPTY one, which is exactly why the blocker below went
// unseen: a real session is almost never nameless.
function seedRegistry(root, records) {
  const dir = join(root, "sessions");
  mkdirSync(dir, { recursive: true });
  records.forEach((r, i) => writeFileSync(join(dir, `${1000 + i}.json`), JSON.stringify(r), "utf8"));
  return dir;
}

function offerLine(out) {
  if (!out || !out.systemMessage) return null;
  return out.systemMessage.split("\n").find((l) => l.includes("looks like")) || null;
}

function seedAnchorVault() {
  const h = seedHookProject();
  mkdirSync(join(h.vault, "adr"), { recursive: true });
  writeFileSync(join(h.vault, "epics", "PS-A", "stories", "story-alpha-beta.md"),
    "---\ntype: story\nstatus: planned\n---\n", "utf8");
  writeFileSync(join(h.vault, "adr", "some-decision.md"),
    "---\ntype: adr\nstatus: proposed\n---\n", "utf8");
  return h;
}

test("name offer: settles at five writes, speaks once, then stays quiet", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const seen = [];
  for (let i = 0; i < 8; i++) seen.push(offerLine(vaultWrite(proj, vault, rel)));
  const fired = seen.map((l, i) => (l ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(fired, [5], `expected one offer on the fifth write, got ${JSON.stringify(fired)}`);
  assert.match(seen[4], /ps-a-alpha-beta/, seen[4]);
  assert.match(seen[4], /\/rename ps-a-alpha-beta/, "the offer must carry the command to accept it");
});

test("name offer: reads never name a session, however many there are", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 8; i++) {
    assert.equal(offerLine(vaultWrite(proj, vault, rel, { tool: "Read" })), null,
      "a review session that reads the vault has not done work worth naming");
  }
  // And the same paths written DO settle: the gate is the tool, not the path.
  const after = [];
  for (let i = 0; i < 5; i++) after.push(offerLine(vaultWrite(proj, vault, rel)));
  assert.ok(after[4], "writes after the reads still settle the anchor");
});

test("name offer: a subagent's writes never vote on the name", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 8; i++) {
    assert.equal(offerLine(vaultWrite(proj, vault, rel, { agent_id: "sub-7" })), null,
      "a subagent shares the session id and cannot accept a name");
  }
});

test("name offer: the anchor moves only on a decisive lead, and renames when it does", () => {
  const { proj, vault } = seedAnchorVault();
  const adr = join("adr", "some-decision.md");
  const story = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const first = [];
  for (let i = 0; i < 5; i++) first.push(offerLine(vaultWrite(proj, vault, adr)));
  assert.match(first[4], /some-decision/, "the document anchors the session first");

  const later = [];
  for (let i = 0; i < 16; i++) later.push(offerLine(vaultWrite(proj, vault, story)));
  const at = later.map((l, i) => (l ? i + 1 : null)).filter(Boolean);
  // Five ADR writes stand; the epic must reach 5 + 10 to take over.
  assert.deepEqual(at, [15], `takeover must need the full margin, fired at ${JSON.stringify(at)}`);
  assert.match(later[14], /ps-a-alpha-beta/, later[14]);
});

test("name offer: it composes with the raw-edit nudge instead of racing it", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  // The nudge fires on the first vault write of a ten-minute window; the offer
  // on the fifth. Force both onto one invocation by clearing the nudge stamp.
  let out = null;
  for (let i = 0; i < 4; i++) vaultWrite(proj, vault, rel);
  const statePath = join(proj, ".claude", ".projectstore", "state", "n1.json");
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  delete st.nudged_at;
  writeFileSync(statePath, JSON.stringify(st), "utf8");
  out = vaultWrite(proj, vault, rel);
  assert.ok(out && out.systemMessage, "both mechanisms had something to say");
  assert.match(out.systemMessage, /run \/projectstore:reconcile/, "the nudge survived");
  assert.match(out.systemMessage, /looks like/, "the offer survived");
  assert.equal(out.systemMessage.split("\n").length, 2, "one message, two lines — neither dropped");
});

test("name offer: state never touches the statusline pointer's file", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 6; i++) vaultWrite(proj, vault, rel);
  // ADR-006's pointer must still be intact and complete: the anchor tally is
  // the highest-frequency writer here, and lib.mjs forbids it the shared
  // read-modify-write for exactly this reason.
  const st = JSON.parse(readFileSync(
    join(proj, ".claude", ".projectstore", "state", "n1.json"), "utf8"));
  assert.equal(st.active_epic, "PS-A");
  assert.equal(st.active_story, "story-alpha-beta");
  assert.ok(!("counts" in st) && !("incumbent" in st), "anchor state must live in its own files");
});

test("name offer: guard off silences it, like every other advisory", () => {
  const { proj, vault } = seedAnchorVault();
  writeFileSync(join(proj, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: vault, layout: "engineering", language: "en", guard: "off" }), "utf8");
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 8; i++) {
    assert.equal(offerLine(vaultWrite(proj, vault, rel)), null, "guard off means silent");
  }
});

test("name offer: the breadcrumb is distinguishable from an entry reminder", () => {
  const { proj, vault } = seedAnchorVault();
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 5; i++) vaultWrite(proj, vault, rel);
  const log = readFileSync(join(proj, ".claude", ".projectstore", "entry-log.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const offers = log.filter((r) => r.kind === "name-offer");
  assert.equal(offers.length, 1, "the offer left a breadcrumb");
  assert.equal(offers[0].name, "ps-a-alpha-beta");
  // doctor renders `readEntryLog(...).length` as "an entry reminder fired N
  // time(s)"; an offer inflating that count would make the sentence false.
  assert.equal(log.filter((r) => !r.kind).length, 0, "no offer masquerades as a reminder");
});

test("name offer: the epic is named after its DOMINANT story, across invocations", () => {
  // The weakness this closes: `foldAnchor` tallies the leaf of the current
  // event in memory, so with one story per epic the name comes out right even
  // if the on-disk leaf tally is never written. Two stories are what make the
  // persisted tally load-bearing — and the last-touched one must NOT win.
  const { proj, vault } = seedAnchorVault();
  writeFileSync(join(vault, "epics", "PS-A", "stories", "story-minor-note.md"),
    "---\ntype: story\nstatus: planned\n---\n", "utf8");
  const major = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const minor = join("epics", "PS-A", "stories", "story-minor-note.md");
  for (let i = 0; i < 4; i++) vaultWrite(proj, vault, major);
  const out = offerLine(vaultWrite(proj, vault, minor));   // 5th write settles
  assert.ok(out, "the epic settled on the fifth write");
  assert.match(out, /ps-a-alpha-beta/,
    "the name follows where the work went, not where the cursor happens to be");
  assert.doesNotMatch(out, /minor-note/, out);
});

test("name offer: a session that arrives already named still gets its offer", () => {
  // The blocker this pins: a session is almost never nameless — the harness
  // assigns one — and an earlier reading treated ANY name that was not our last
  // offer as "the person chose this", which silenced the feature permanently
  // for every real session. Every other wired drive here runs against an empty
  // registry and cannot see it.
  const { root, proj, vault } = seedAnchorVault();
  const dir = seedRegistry(root, [{ pid: 999, sessionId: "n1", name: "warm-otter-42" }]);
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(offerLine(vaultWrite(proj, vault, rel, { sessionsDir: dir })));
  const fired = seen.map((l, i) => (l ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(fired, [5], `a pre-named session must still be offered: ${JSON.stringify(fired)}`);
  assert.match(seen[4], /ps-a-alpha-beta/, seen[4]);
});

test("name offer: once the person picks their own name, nothing talks over it", () => {
  const { root, proj, vault } = seedAnchorVault();
  const story = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const adr = join("adr", "some-decision.md");
  let dir = seedRegistry(root, [{ pid: 999, sessionId: "n1", name: "warm-otter-42" }]);
  for (let i = 0; i < 5; i++) vaultWrite(proj, vault, story, { sessionsDir: dir });   // we offer
  // The person ignores it and renames to something of their own.
  dir = seedRegistry(root, [{ pid: 999, sessionId: "n1", name: "my-own-choice" }]);
  for (let i = 0; i < 20; i++) {
    assert.equal(offerLine(vaultWrite(proj, vault, adr, { sessionsDir: dir })), null,
      "a name we did not compose is the person's, and no later anchor move overrides it");
  }
});

test("name offer: a name WE composed is still ours to replace when the work moves", () => {
  const { root, proj, vault } = seedAnchorVault();
  const story = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const adr = join("adr", "some-decision.md");
  let dir = seedRegistry(root, [{ pid: 999, sessionId: "n1", name: "warm-otter-42" }]);
  for (let i = 0; i < 5; i++) vaultWrite(proj, vault, story, { sessionsDir: dir });
  // The person ACCEPTS our offer — the registry now carries the name we composed.
  dir = seedRegistry(root, [{ pid: 999, sessionId: "n1", name: "ps-a-alpha-beta" }]);
  const later = [];
  for (let i = 0; i < 16; i++) later.push(offerLine(vaultWrite(proj, vault, adr, { sessionsDir: dir })));
  const at = later.map((l, i) => (l ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(at, [15], `the pivot must still be offered: ${JSON.stringify(at)}`);
  assert.match(later[14], /some-decision/, later[14]);
});

test("name offer: Bash-mediated vault writes are invisible — no name, and no tally", () => {
  // The documented blind spot, pinned rather than merely written down. A Bash
  // command carries no file_path, so path extraction yields nothing and the
  // vault branch is never entered.
  const { root, proj, vault } = seedAnchorVault();
  const dir = seedRegistry(root, []);
  const target = join(vault, "epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 8; i++) {
    const out = fireHook(proj, {
      hook_event_name: "PreToolUse", session_id: "n1",
      tool_name: "Bash", tool_input: { command: `printf x >> "${target}"` },
    }, dir);
    assert.equal(offerLine(out), null, "a scripted vault write cannot name the session");
  }
  // And it contributed nothing to the tally: five tool-calls still settle on
  // the fifth, not earlier. Absence of an offer alone would not prove that.
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(offerLine(vaultWrite(proj, vault, rel, { sessionsDir: dir })));
  assert.deepEqual(seen.map((l, i) => (l ? i + 1 : null)).filter(Boolean), [5],
    "eight Bash writes must leave the tally at zero");
});

test("name offer: a subagent's writes contribute nothing to the tally, not merely to delivery", () => {
  // The read gate's drive proves the tally took nothing by showing five later
  // writes still settle on the fifth. Asserting silence alone passes a mutant
  // that tallies subagent writes and only suppresses the message — under which
  // a session whose subagents write elsewhere gets named after their work.
  const { root, proj, vault } = seedAnchorVault();
  const dir = seedRegistry(root, []);
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  for (let i = 0; i < 8; i++) {
    assert.equal(offerLine(vaultWrite(proj, vault, rel, { agent_id: "sub-7", sessionsDir: dir })), null);
  }
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(offerLine(vaultWrite(proj, vault, rel, { sessionsDir: dir })));
  assert.deepEqual(seen.map((l, i) => (l ? i + 1 : null)).filter(Boolean), [5],
    "eight subagent writes must leave the tally at zero");
});

test("name offer: concurrent writers keep the tally exact and the ADR-006 pointer intact", async () => {
  // AC 5 asks for concurrency, and the sequential drive above cannot answer it.
  // Two distinct hazards live here: the tally (one byte appended per event, so
  // O_APPEND must not lose increments) and the sidecar naming each key, which
  // an O_TRUNC rewrite makes momentarily empty — a reader then drops the key
  // entirely and the takeover guard silently falls to zero.
  const { root, proj, vault } = seedAnchorVault();
  const dir = seedRegistry(root, []);
  const rel = join("epics", "PS-A", "stories", "story-alpha-beta.md");
  const N = 24;
  // Read WHILE the writers run. Reading afterwards proves nothing: the sidecar
  // is only observably empty during the instant it is being rewritten.
  let lost = 0, reads = 0, racing = true;
  const reader = (async () => {
    while (racing) {
      const seen = readAnchorState(proj, "c1");
      if (Object.keys(seen.counts).length) reads += 1;
      else if (reads > 0) lost += 1;
      if (reads > 0 && !seen.counts["epic:PS-A"]) lost += 1;
      await new Promise((r) => setImmediate(r));
    }
  })();
  await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, [join(REPO, "scripts", "touch-session.mjs")], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, PROJECTSTORE_SESSIONS_DIR: dir }, cwd: proj,
    });
    c.stdin.end(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "c1",
      tool_name: "Edit", tool_input: { file_path: join(vault, rel) },
    }));
    c.on("close", resolve);
  })));
  racing = false;
  await reader;

  const st = readAnchorState(proj, "c1");
  assert.equal(st.counts["epic:PS-A"], N, "no increment lost under concurrency");
  assert.equal(st.leaves["epic:PS-A"]["alpha-beta"], N, "the leaf tally too");
  assert.equal(lost, 0,
    `a key with a live tally vanished from ${lost}/${reads} concurrent reads — ` +
    "a truncated sidecar drops the key, and foldAnchor then measures a " +
    "challenger against a zero incumbent");
  // And the pointer this state was deliberately kept out of is whole.
  const ptr = JSON.parse(readFileSync(
    join(proj, ".claude", ".projectstore", "state", "c1.json"), "utf8"));
  assert.equal(ptr.active_epic, "PS-A");
  assert.equal(ptr.active_story, "story-alpha-beta");
});

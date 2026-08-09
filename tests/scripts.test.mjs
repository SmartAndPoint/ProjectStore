// projectstore — CLI-script tests (PS-SPEC story-007/009 follow-up from the
// reviewer pass). The two new scripts are pure compute; drive them via
// spawnSync with CLAUDE_PROJECT_DIR pointed at this repo (its config supplies
// language/vault for story-section).
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

test("diff-refs: no args => fallback true; --since returns file lists", () => {
  const none = run("diff-refs.mjs", []);
  assert.equal(none.fallback, true);
  const since = run("diff-refs.mjs", ["--since", "2020-01-01T00:00:00Z"]);
  assert.ok(Array.isArray(since.files) && Array.isArray(since.uncommitted));
  assert.ok(!since.uncommitted.some((f) => f.endsWith("/")), "directories expanded to files");
  assert.ok(!since.files.some((f) => f.includes("package-lock")), "ignore globs applied");
});

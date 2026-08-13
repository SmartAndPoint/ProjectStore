// projectstore — predicate tests (PS-SPEC). Zero-dependency: run with
//   node --test tests/*.test.mjs
// Covers the deterministic predicates the spec-first epic added: numbering,
// heading registry matching, legacy exemption, list parsing, layout-driven
// template checks, spec acceptance attribution, evidence/lifecycle gates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

import {
  nextNumber,
  writeFileAtomic,
  slugIdentity,
  isLegacyNumberedId,
  storyMatchesEntry,
  legalArtifactName,
  findSlugCollision,
  displayNumberOf,
  compareArtifactOrder,
  headingLineRe,
  sectionOf,
  indexHeaderRe,
  SOURCE_IGNORE,
  ENTRY_IGNORE,
  isSourcePath,
  scoreDir,
  registerSourcePath,
  entryScore,
  openStoryFrom,
  ENTRY_THRESHOLD,
  listVaultStoryFiles,
  resolveOpenStory,
  markerDir,
  readOpenStoryCache,
  writeOpenStoryCache,
  firedCount,
  isArmed,
  armReminder,
  mayRemind,
  electEmitter,
  cleanupStaleSessionState,
  isLegacyStory,
  listOf,
  loadLayout,
  installedPluginRoot,
  isPluginCacheRoot,
  statusLineIsOurs,
  statusLineLauncherPath,
  syncStatusLine,
  stripCodeSpans,
  extractLinks,
  buildNodeIndex,
  resolveLinkTarget,
} from "../scripts/lib.mjs";
import {
  checkLayoutTemplates,
  checkArtifactIdentity,
  checkArtifactNames,
  checkExternalRefsForm,
  checkSpecLinks,
  checkSpecCoverage,
  checkSpecAcceptance,
  checkLifecycleGates,
  checkOverrideCopies,
  checkAutoUpdate,
  checkEnvEffort,
  checkStatusline,
  statusLineScriptVersion,
  parseSpecAcceptance,
  walkVaultFiles,
} from "../scripts/doctor.mjs";
import {
  resolveSelection,
  writeIndexWithRetry,
} from "../scripts/reconcile.mjs";

// ─── numbering ─────────────────────────────────────────────────────────

test("nextNumber matches existing lowercase files against an uppercase prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-num-"));
  writeFileSync(join(dir, "spec-002-dvizhok-zameny.md"), "");
  writeFileSync(join(dir, "SPEC-001-foo.md"), "");
  assert.equal(nextNumber(dir, "SPEC-", 3), "003");
});

test("nextNumber escapes regex metacharacters in the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-num-"));
  writeFileSync(join(dir, "A+B-004-x.md"), "");
  assert.equal(nextNumber(dir, "A+B-", 3), "005");
});

// ─── atomic file writes (spec: atomic-regeneration-of-derived-views) ───

test("writeFileAtomic: lands byte-exact content, replaces existing, leaves no temp", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-atomic-"));
  const target = join(dir, "view.md");
  writeFileAtomic(target, "first\n");
  assert.equal(readFileSync(target, "utf8"), "first\n");
  writeFileAtomic(target, "second\n");
  assert.equal(readFileSync(target, "utf8"), "second\n");
  assert.deepEqual(readdirSync(dir), ["view.md"]);
});

test("writeFileAtomic: rename failure with the temp alive — temp removed, target untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-atomic-"));
  const target = join(dir, "taken");
  mkdirSync(target); // renaming a file over an existing directory fails
  assert.throws(() => writeFileAtomic(target, "x"));
  assert.ok(statSync(target).isDirectory(), "target untouched");
  assert.deepEqual(readdirSync(dir), ["taken"], "no temp litter after a handled failure");
});

test("writeFileAtomic: dead-pid orphan swept; own-pid temp and .gitignore survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-atomic-"));
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid; // exited ⇒ dead
  writeFileSync(join(dir, `.a.md.${deadPid}.tmp`), "orphan");
  writeFileSync(join(dir, `.b.md.${process.pid}.tmp`), "live writer");
  writeFileSync(join(dir, ".gitignore"), "*\n");
  writeFileAtomic(join(dir, "c.md"), "content\n"); // sweep on by default
  const names = readdirSync(dir);
  assert.ok(!names.includes(`.a.md.${deadPid}.tmp`), "dead orphan swept");
  assert.ok(names.includes(`.b.md.${process.pid}.tmp`), "live writer's temp kept");
  assert.ok(names.includes(".gitignore"), "strict shape never matches dotfiles");
  assert.equal(readFileSync(join(dir, "c.md"), "utf8"), "content\n");
});

test("writeFileAtomic: sweep=false leaves orphans alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-atomic-"));
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(join(dir, `.a.md.${deadPid}.tmp`), "orphan");
  writeFileAtomic(join(dir, "c.md"), "x", { sweep: false });
  assert.ok(readdirSync(dir).includes(`.a.md.${deadPid}.tmp`));
});

// ─── reconcile selection & retry (atomic-regeneration contracts 3, 6) ──

test("resolveSelection: bare selects all; selectors compose; unknown and layout-absent error", () => {
  const layout = loadLayout("engineering");
  const bare = resolveSelection(layout, null);
  assert.equal(bare.explicit, false);
  assert.ok(bare.kanban && bare.codemap);
  assert.equal(bare.indexes.length, layout.folders.length);
  assert.ok(bare.indexes.every((i) => !i.named));

  const one = resolveSelection(layout, "kanban");
  assert.ok(one.explicit && one.kanban && !one.codemap);
  assert.deepEqual(one.indexes, []);

  const combo = resolveSelection(layout, "indexes=adr,codemap");
  assert.ok(combo.codemap && combo.indexes.length === 1 && combo.indexes[0].named);
  assert.equal(combo.indexes[0].path, "adr");

  assert.match(resolveSelection(layout, "kanbn").error, /unknown selector/);
  assert.match(resolveSelection(layout, "indexes=nonexistent").error, /no folder/);
  assert.match(resolveSelection(layout, "").error, /empty --only/);

  // Composition keeps named loudness in both orders.
  for (const raw of ["indexes=adr,indexes", "indexes,indexes=adr"]) {
    const merged = resolveSelection(layout, raw);
    assert.equal(merged.indexes.length, layout.folders.length, raw);
    assert.equal(merged.indexes.find((i) => i.path === "adr").named, true, raw);
  }

  const kanbanless = { ...layout, kanban: null };
  assert.match(resolveSelection(kanbanless, "kanban").error, /no kanban/);
  const epicless = { ...layout, folders: layout.folders.filter((f) => f.kind !== "epic") };
  assert.match(resolveSelection(epicless, "codemap").error, /no epic folder/);
});

test("writeIndexWithRetry: drift during rebuild — recomputed from fresh bytes, never written stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-retry-"));
  const p = join(dir, "README.md");
  writeFileSync(p, "prose v1\n");
  let calls = 0;
  const rebuild = (bytes) => {
    calls++;
    // First attempt: a concurrent edit lands while we rebuild from `bytes`.
    if (calls === 1) writeFileSync(p, bytes.replace("prose v1", "CONCURRENT EDIT"));
    return { content: bytes + "ROWS\n" };
  };
  const r = writeIndexWithRetry(p, rebuild);
  assert.deepEqual(r, { changed: true, written: true });
  assert.equal(calls, 2, "drift forces a recompute from the fresh bytes");
  const landed = readFileSync(p, "utf8");
  assert.ok(landed.includes("CONCURRENT EDIT"), "the concurrent edit survives the write");
  assert.ok(landed.endsWith("ROWS\n"));
  assert.ok(!landed.includes("prose v1"), "stale bytes never land");
});

test("writeIndexWithRetry: exhaustion reports an error and leaves the target unwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-retry-"));
  const p = join(dir, "README.md");
  writeFileSync(p, "x\n");
  const rebuild = (bytes) => {
    writeFileSync(p, bytes + "more\n"); // an edit lands on EVERY attempt
    return { content: bytes + "ROWS\n" };
  };
  const r = writeIndexWithRetry(p, rebuild, { attempts: 3 });
  assert.match(r.error, /concurrent edits persisted/);
  assert.ok(!readFileSync(p, "utf8").includes("ROWS"), "no stale write landed");
});

test("writeIndexWithRetry: unusable table and absent file are reported, not written", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-retry-"));
  const p = join(dir, "README.md");
  writeFileSync(p, "no table here\n");
  const r = writeIndexWithRetry(p, () => ({ unusable: "no recognised index-table header" }));
  assert.match(r.unusable, /no recognised/);
  assert.match(writeIndexWithRetry(join(dir, "missing.md"), () => ({ content: "x" })).unusable, /does not exist/);
});

// ─── artifact identity (ADR-010 / SPEC-002) ────────────────────────────

test("slugIdentity: numbered-era names contribute both readings", () => {
  const adr = slugIdentity("ADR-003-foo.md", { prefix: "ADR-" });
  assert.equal(adr.primary, "adr-003-foo");
  assert.deepEqual(adr.candidates.map((c) => c.id), ["adr-003-foo", "foo"]);
  assert.equal(adr.legacyNumber, "003");
  assert.equal(adr.digitLeading, false);

  const story = slugIdentity("story-006-foo.md", { story: true });
  assert.deepEqual(story.candidates.map((c) => c.id), ["006-foo", "foo"]);
  assert.equal(story.legacyNumber, "006");
});

test("slugIdentity: lowercase spec-NNN files strip against the uppercase layout prefix", () => {
  const s = slugIdentity("spec-002-dvizhok-zameny.md", { prefix: "SPEC-" });
  assert.deepEqual(s.candidates.map((c) => c.id), ["spec-002-dvizhok-zameny", "dvizhok-zameny"]);
  assert.equal(s.legacyNumber, "002");
});

test("slugIdentity: slug-only names are single-reading; folder-shape dir names work", () => {
  assert.deepEqual(slugIdentity("foo.md", { prefix: "ADR-" }).candidates.map((c) => c.id), ["foo"]);
  const folder = slugIdentity("story-006-foo", { story: true }); // dir name, no .md
  assert.deepEqual(folder.candidates.map((c) => c.id), ["006-foo", "foo"]);
});

test("slugIdentity: digit-leading slug is flagged and keeps its full candidate set", () => {
  const s = slugIdentity("story-2024-review.md", { story: true });
  assert.equal(s.digitLeading, true);
  assert.deepEqual(s.candidates.map((c) => c.id), ["2024-review", "review"]);
});

test("slugIdentity: number-only legacy ids keep a single reading", () => {
  const s = slugIdentity("SPEC-002.md", { prefix: "SPEC-" });
  assert.deepEqual(s.candidates.map((c) => c.id), ["spec-002"]);
  assert.equal(s.legacyNumber, "002");
});

test("isLegacyNumberedId: both story shapes, prefixed kinds, and non-matches", () => {
  assert.deepEqual(isLegacyNumberedId("story-001", { story: true }), { number: "001", slug: null });
  assert.deepEqual(isLegacyNumberedId("story-001-foo", { story: true }), { number: "001", slug: "foo" });
  assert.deepEqual(isLegacyNumberedId("adr-010-bar.md", { prefix: "ADR-" }), { number: "010", slug: "bar" });
  assert.equal(isLegacyNumberedId("story-foo", { story: true }), null);
  assert.equal(isLegacyNumberedId("cache", { story: true }), null);
  assert.equal(isLegacyNumberedId("A+B-004-x", { prefix: "A+B-" })?.number, "004");
});

test("storyMatchesEntry: exact fm.id beats stem beats fallback", () => {
  const story = { id: "story-001", stem: "story-001-slug-first-artifact-identity" };
  assert.equal(storyMatchesEntry("story-001", story), 1);
  assert.equal(storyMatchesEntry("story-001-slug-first-artifact-identity", story), 2);
  assert.equal(storyMatchesEntry("story-001-slug", story), 3); // legacy-shaped partial stem
  const noId = { id: null, stem: "story-001-foo" };
  assert.equal(storyMatchesEntry("story-001", noId), 3); // hand-created story without id:
  assert.equal(storyMatchesEntry("story-001-foo", noId), 2);
});

test("storyMatchesEntry: slug entries never prefix-match (contract-5 mis-attribution)", () => {
  // The regression SPEC-002 pins: "PS-X/cache" must NOT match cache-invalidation.md.
  assert.equal(storyMatchesEntry("cache", { id: null, stem: "cache-invalidation" }), 0);
  assert.equal(storyMatchesEntry("story-auth", { id: null, stem: "story-auth-rollout" }), 0);
  assert.equal(storyMatchesEntry("story-auth", { id: "story-auth", stem: "story-auth-rollout" }), 1);
});

test("legalArtifactName: blacklists sync-conflict shapes, passes everything else", () => {
  assert.notEqual(legalArtifactName("foo 2.md"), null);
  assert.notEqual(legalArtifactName("foo (2).md"), null);
  assert.notEqual(legalArtifactName("foo(3).md"), null);
  assert.notEqual(legalArtifactName("foo copy.md"), null);
  assert.notEqual(legalArtifactName("foo copy 2.md"), null);
  assert.notEqual(legalArtifactName("foo (Evgenii's conflicted copy 2026-08-09).md"), null);
  assert.equal(legalArtifactName("foo.md"), null);
  assert.equal(legalArtifactName("story-001-foo.md"), null);
  assert.equal(legalArtifactName("retro 2026-08.md"), null); // trailing token is not pure digits
  assert.equal(legalArtifactName("Использование проджект стор в агентских фабриках и графах.md"), null);
  assert.equal(legalArtifactName("copycat.md"), null); // "copy" only as a whole trailing word
  assert.equal(legalArtifactName("notes.txt"), null); // non-md is out of scope
});

test("findSlugCollision: cross-era collisions an exact test -e cannot see", () => {
  const adr = findSlugCollision("foo.md", ["ADR-003-foo.md", "bar.md"], { prefix: "ADR-" });
  assert.equal(adr.with, "ADR-003-foo.md");
  assert.equal(adr.identity, "foo");
  assert.equal(adr.selfMatch, false);
  assert.equal(adr.digitLeading, false);

  const story = findSlugCollision("story-foo.md", ["story-006-foo.md"], { story: true });
  assert.equal(story.with, "story-006-foo.md");
  assert.equal(story.identity, "foo");
});

test("findSlugCollision: digit-leading overlap is classified, distinct slugs pass", () => {
  const amb = findSlugCollision("story-review.md", ["story-2024-review.md"], { story: true });
  assert.equal(amb.identity, "review");
  assert.equal(amb.digitLeading, true);

  const dup = findSlugCollision("story-foo.md", ["story-foo"], { story: true }); // folder twin
  assert.equal(dup.selfMatch, true);

  // Contract 9: foo-2 is a deliberately distinct identity from foo.
  assert.equal(findSlugCollision("foo-2.md", ["foo.md"], { prefix: "ADR-" }), null);
  assert.equal(findSlugCollision("baz.md", ["ADR-003-foo.md"], { prefix: "ADR-" }), null);
});

// ─── heading registry ──────────────────────────────────────────────────

test("headingLineRe matches en and ru forms, anchored to the full line", () => {
  const re = headingLineRe("acceptance");
  assert.ok(re.test("## Acceptance Criteria"));
  assert.ok(re.test("## Критерии приёмки"));
  assert.ok(!re.test("## Acceptance"));
  const spec = headingLineRe("spec_acceptance");
  assert.ok(spec.test("## Acceptance"));
  assert.ok(spec.test("## Приёмка / сдача"));
  assert.ok(!spec.test("## Acceptance Criteria"));
});

test("sectionOf extracts a ru section in an en-bound vault", () => {
  const body = "# t\n\n## Критерии приёмки\n\n- [ ] a\n- [x] b\n\n## Технические заметки\n\nx\n";
  const sec = sectionOf(body, "acceptance");
  assert.ok(sec.includes("- [ ] a"));
  assert.ok(!sec.includes("Технические"));
});

test("indexHeaderRe accepts en and ru 4-column headers, rejects a 5-column one", () => {
  const re = indexHeaderRe();
  assert.ok(re.test("| File | Title | Status | Date |"));
  assert.ok(re.test("| Файл | Заголовок | Статус | Дата |"));
  assert.ok(!re.test("| Файл | Заголовок | Статус | ADR | Дата |"));
});

// ─── legacy exemption (ADR-007 Decision 6) ─────────────────────────────

test("isLegacyStory truth table", () => {
  const since = "2026-08-03T12:00:00.000Z";
  assert.ok(isLegacyStory({ status: "done" }, since), "done, no closed_at → legacy");
  assert.ok(isLegacyStory({ status: "done", closed_at: "2026-08-01T00:00:00.000Z" }, since));
  assert.ok(!isLegacyStory({ status: "done", closed_at: "2026-08-04T00:00:00.000Z" }, since));
  assert.ok(!isLegacyStory({ status: "in-progress" }, since), "in-progress at enable → in scope");
  assert.ok(!isLegacyStory({ status: "review" }, since), "review at enable → in scope");
});

// ─── override copies (ADR-001/004 renames, project + user scope) ───────

function agentDirs() {
  const root = mkdtempSync(join(tmpdir(), "ps-agents-"));
  const proj = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(join(proj, ".claude", "agents"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  return { proj, home };
}

const agentFile = (name, { marker } = {}) =>
  `---\nname: ${name}\nmodel: opus\n---\n\n${marker ? `# source: projectstore v${marker}\n\n` : ""}body\n`;

test("checkOverrideCopies flags a pre-v0.13 name in the user scope", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(home, ".claude", "agents", "projectstore-critic.md"), agentFile("projectstore-critic"));
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].check, "override-copies");
  assert.match(out[0].message, /overrides nothing/);
  assert.match(out[0].message, /every project/);
  // ADR-008: this assertion used to require the message to SUGGEST renaming
  // ("restores the override"). Nothing restores an override — a bare-named copy
  // never overrode the scoped plugin agent — so the advice, and this test, were
  // pinning a false claim. The rename is still *mentioned*, but only to say it
  // would not help.
  assert.match(out[0].message, /renamed the role to "critic"/);
  assert.ok(!/to override again/.test(out[0].message), "must not claim a rename restores an override");
  // no provenance marker → cannot prove it is ours, so info rather than warn
  assert.equal(out[0].level, "info");
});

test("checkOverrideCopies warns at warn-level when provenance is proven", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(proj, ".claude", "agents", "code-planner.md"), agentFile("code-planner", { marker: "0.9.0" }));
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "warn");
  // planner was transformed, not renamed — suggesting a rename would swap its role
  assert.match(out[0].message, /narrower vault-aware "planner"/);
  assert.ok(!/rename it to/.test(out[0].message), "must not suggest renaming onto a transformed role");
});

test("checkOverrideCopies leaves foreign user-authored agents alone", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(home, ".claude", "agents", "my-helper.md"), agentFile("my-helper"));
  // a name we never bundled is none of our business, marker or not
  assert.deepEqual(checkOverrideCopies(proj, home), []);
});

test("checkOverrideCopies hedges on an unmarked copy carrying a bundled name", () => {
  const { proj, home } = agentDirs();
  // a same-named agent with no marker is indistinguishable from the user's own,
  // so we may state the sibling fact but must not order a deletion
  writeFileSync(join(home, ".claude", "agents", "critic.md"), agentFile("critic"));
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "info");
  assert.match(out[0].message, /^If critic\.md began as a projectstore copy/);
  assert.ok(!/Delete it/.test(out[0].message), "must not order deletion of a file we cannot prove is ours");
});

// ADR-008: the copy is a sibling, not an override, at EVERY version — the old
// behaviour only spoke when the marker was stale, so a freshly written copy (the
// exact output of `configure`) passed silently. That silence was the defect.
test("checkOverrideCopies reports a current-name copy as a sibling regardless of version", () => {
  const { proj, home } = agentDirs();
  const ver = JSON.parse(
    readFileSync(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)), "utf8"),
  ).version;
  writeFileSync(join(proj, ".claude", "agents", "critic.md"), agentFile("critic", { marker: ver }));
  const fresh = checkOverrideCopies(proj, home);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].level, "warn");
  assert.match(fresh[0].message, /overrides nothing/);
  assert.match(fresh[0].message, /registers as "projectstore:critic"/);
  assert.match(fresh[0].message, /Delete it/);
  // a copy at the installed version is not stale, so no parenthetical
  assert.ok(!/frozen at/.test(fresh[0].message), "current-version copy must not be called frozen");

  writeFileSync(join(proj, ".claude", "agents", "critic.md"), agentFile("critic", { marker: "0.0.1" }));
  const stale = checkOverrideCopies(proj, home);
  assert.equal(stale.length, 1);
  // staleness survives as a parenthetical: still true, no longer the headline
  assert.match(stale[0].message, /overrides nothing/);
  assert.match(stale[0].message, /also frozen at projectstore v0\.0\.1/);
});

// `configure` only cleans project scope, so a user-scope copy must not be told
// to run it — the same scope split fca8def introduced for the staleness message.
test("checkOverrideCopies gives scope-appropriate removal advice", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(proj, ".claude", "agents", "critic.md"), agentFile("critic", { marker: "0.0.1" }));
  writeFileSync(join(home, ".claude", "agents", "planner.md"), agentFile("planner", { marker: "0.0.1" }));
  const out = checkOverrideCopies(proj, home);
  const project = out.find((f) => f.file.startsWith(".claude"));
  const user = out.find((f) => f.file.startsWith("~"));
  assert.match(project.message, /configure/);
  assert.match(user.message, /by hand/);
  assert.ok(!/Delete it via \/projectstore:agents configure/.test(user.message),
    "user scope must not be pointed at a command that only touches project scope");
});

// A marked copy with no `name:` used to fall through to the staleness branch;
// after ADR-008 it must still get an actionable message, not `name ""`.
test("checkOverrideCopies falls back to the filename when a marked copy has no name", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(proj, ".claude", "agents", "critic.md"), `---\nmodel: opus\n---\n\n# source: projectstore v0.0.1\n\nbody\n`);
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 1);
  assert.ok(!/name ""/.test(out[0].message), "an empty name in the message helps nobody");
  assert.match(out[0].message, /overrides nothing/);
});

test("checkEnvEffort reports the variable that now owns effort", () => {
  const had = "CLAUDE_CODE_EFFORT_LEVEL" in process.env;
  const prev = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  try {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    assert.deepEqual(checkEnvEffort(), []);
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
    const out = checkEnvEffort();
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "warn");
    assert.equal(out[0].check, "env-effort");
    assert.match(out[0].message, /low/);
  } finally {
    if (had) process.env.CLAUDE_CODE_EFFORT_LEVEL = prev;
    else delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  }
});

test("checkOverrideCopies reports every configured roster agent, once each", () => {
  const { proj, home } = agentDirs();
  const ver = JSON.parse(
    readFileSync(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)), "utf8"),
  ).version;
  for (const n of ["critic", "planner", "reviewer", "librarian", "archaeologist"]) {
    writeFileSync(join(proj, ".claude", "agents", `${n}.md`), agentFile(n, { marker: ver }));
  }
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 5);
  // legacy advice must not leak into current names
  assert.ok(!out.some((f) => /pre-v0\.13/.test(f.message)), "current names are not legacy");
});

// ─── list parsing ──────────────────────────────────────────────────────

test("listOf parses inline flow and rejects block-sequence remnants", () => {
  assert.deepEqual(listOf({ specs: '["SPEC-001", "SPEC-002"]' }, "specs"), ["SPEC-001", "SPEC-002"]);
  assert.deepEqual(listOf({ specs: "[]" }, "specs"), []);
  assert.deepEqual(listOf({ specs: "" }, "specs"), []);
  assert.deepEqual(listOf({}, "specs"), []);
});

// ─── layout-driven template check (story-001) ──────────────────────────

test("checkLayoutTemplates: no finding for command-less folders (diagram), spec required", () => {
  const findings = checkLayoutTemplates({ layout: "engineering", language: "en" });
  assert.deepEqual(findings, [], `expected clean, got: ${JSON.stringify(findings)}`);
  const layout = loadLayout("engineering");
  assert.ok(layout.commands.includes("spec"));
  assert.ok(layout.folders.some((f) => f.kind === "spec" && f.prefix === "SPEC-"));
});

// ─── spec fixtures ─────────────────────────────────────────────────────

function spec(id, stories, status, acceptance) {
  return {
    kind: "spec",
    rel: `specs/${id}.md`,
    abs: `/x/specs/${id}.md`,
    fm: { id, type: "spec", status, stories: JSON.stringify(stories) },
    body: `---\nid: "${id}"\n---\n\n## Acceptance\n\n${acceptance}\n`,
  };
}

function story(epic, sid, status, extra = {}) {
  return {
    kind: "story",
    rel: `epics/${epic}/stories/${sid}-slug.md`,
    abs: `/x/epics/${epic}/stories/${sid}-slug.md`,
    fm: { type: "story", status, specs: "[]", ...extra },
    body: `---\ntype: story\n---\n\n## Acceptance Criteria\n\n- [x] crit one\n`,
  };
}

const REQUIRED = { spec_policy: "required", spec_policy_since: "2026-08-03T00:00:00.000Z" };

test("checkSpecCoverage: in-scope story without spec is an issue; planned and legacy are not", () => {
  const arts = [
    story("E1", "story-001", "in-progress"),
    story("E1", "story-002", "planned"),
    story("E1", "story-003", "done"), // no closed_at → legacy
  ];
  const f = checkSpecCoverage(arts, REQUIRED);
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "spec-coverage");
  assert.ok(f[0].file.includes("story-001"));
  assert.deepEqual(checkSpecCoverage(arts, { spec_policy: "optional" }), []);
});

test("checkSpecCoverage: done story against draft spec is an issue; in-progress a warn", () => {
  const s = spec("SPEC-001", ["E1/story-001", "E1/story-002"], "draft", "- [x] a\n");
  const arts = [
    s,
    story("E1", "story-001", "done", { specs: '["SPEC-001"]', closed_at: "2026-08-04T00:00:00.000Z" }),
    story("E1", "story-002", "in-progress", { specs: '["SPEC-001"]' }),
  ];
  const f = checkSpecCoverage(arts, REQUIRED);
  const done = f.find((x) => x.file.includes("story-001"));
  const prog = f.find((x) => x.file.includes("story-002"));
  assert.equal(done.level, "issue");
  assert.equal(prog.level, "warn");
});

test("parseSpecAcceptance: attribution and unattributed items", () => {
  const s = spec("SPEC-001", ["E1/story-001"], "active",
    "- [x] for all stories\n- [ ] only story-002 — stories: story-002\n- [x] ru attributed — подтверждение: test\n");
  const items = parseSpecAcceptance(s);
  assert.equal(items.length, 3);
  assert.equal(items[0].stories, null);
  assert.deepEqual(items[1].stories, ["story-002"]);
  assert.equal(items[1].checked, false);
});

test("checkSpecAcceptance: unchecked attributed item blocks its story only", () => {
  const s = spec("SPEC-001", ["E1/story-001", "E1/story-002"], "active",
    "- [x] shared\n- [ ] mine — stories: story-001\n");
  const arts = [
    s,
    story("E1", "story-001", "done", { specs: '["SPEC-001"]', closed_at: "2026-08-04T00:00:00.000Z" }),
    story("E1", "story-002", "done", { specs: '["SPEC-001"]', closed_at: "2026-08-04T00:00:00.000Z" }),
  ];
  const f = checkSpecAcceptance(loadLayout("engineering"), arts, REQUIRED);
  assert.equal(f.filter((x) => x.check === "spec-acceptance").length, 1);
  assert.ok(f[0].file.includes("story-001"));
});

// ─── derived-view ordering (SPEC-002 contract 8) ───────────────────────

test("compareArtifactOrder: date asc; in a date group number wins, numbered before unnumbered, slug last", () => {
  const rows = [
    { date: "2026-08-09", number: null, slug: "zeta" },
    { date: "2026-08-09", number: "010", slug: "slug-first" },
    { date: "2026-07-03", number: "004", slug: "planner" },
    { date: "2026-08-09", number: "009", slug: "runtime" },
    { date: "2026-08-09", number: null, slug: "alpha" },
  ];
  const sorted = [...rows].sort(compareArtifactOrder);
  assert.deepEqual(sorted.map((r) => r.number ?? r.slug), ["004", "009", "010", "alpha", "zeta"]);
});

test("displayNumberOf: frontmatter number wins, legacy filename number falls back, else null", () => {
  assert.equal(displayNumberOf({ number: "042" }, "foo.md", { prefix: "ADR-" }), "042");
  assert.equal(displayNumberOf({}, "ADR-010-bar.md", { prefix: "ADR-" }), "010");
  assert.equal(displayNumberOf({ number: null }, "spec-002-x.md", { prefix: "SPEC-" }), "002");
  assert.equal(displayNumberOf({}, "story-006-foo.md", { story: true }), "006");
  assert.equal(displayNumberOf({}, "foo.md", { prefix: "ADR-" }), null);
});

// ─── identity & filename-shape checks (SPEC-002 contracts 4, 7) ────────

const vf = (...rels) => rels.map((rel) => ({ rel, name: rel.split("/").pop() }));

test("checkArtifactIdentity: cross-era collision is an issue, digit-leading overlap a warn", () => {
  const layout = loadLayout("engineering");
  const issue = checkArtifactIdentity(layout, vf("adr/ADR-003-foo.md", "adr/foo.md"));
  assert.equal(issue.length, 1);
  assert.equal(issue[0].level, "issue");
  assert.ok(issue[0].message.includes('"foo"'), issue[0].message);

  const warn = checkArtifactIdentity(layout,
    vf("epics/E1/stories/story-2024-review.md", "epics/E1/stories/story-review.md"));
  assert.equal(warn.length, 1);
  assert.equal(warn[0].level, "warn");

  // Flat story + folder-shape namesake: both as-written readings coincide.
  const twin = checkArtifactIdentity(layout,
    vf("epics/E1/stories/story-foo.md", "epics/E1/stories/story-foo/README.md"));
  assert.equal(twin.length, 1);
  assert.equal(twin[0].level, "issue");
});

test("checkArtifactIdentity: frontmatter decides the era where the filename is ambiguous", () => {
  const layout = loadLayout("engineering");
  // Contract 4's own story example: a CERTAIN legacy story (id: story-006)
  // colliding with a new-era name is an issue, not a warn.
  const files = vf("epics/E1/stories/story-006-foo.md", "epics/E1/stories/story-foo.md");
  const arts = [{ rel: "epics/E1/stories/story-006-foo.md", fm: { id: "story-006" } }];
  const certain = checkArtifactIdentity(layout, files, arts);
  assert.equal(certain.length, 1);
  assert.equal(certain[0].level, "issue");
  // The same pair with a new-era machine id on the digit-leading file: the
  // overlap exists only under the legacy reading of a slug-era file → warn.
  const newEra = checkArtifactIdentity(layout, files,
    [{ rel: "epics/E1/stories/story-006-foo.md", fm: { id: "story-006-foo" } }]);
  assert.equal(newEra[0].level, "warn");
  // Two same-slug legacy-numbered ADRs were legal in the numbered era —
  // grandfathering must not turn them into a defect (contract 6) → info.
  const legacyPair = checkArtifactIdentity(layout,
    vf("adr/ADR-005-caching-strategy.md", "adr/ADR-012-caching-strategy.md"));
  assert.equal(legacyPair.length, 1);
  assert.equal(legacyPair[0].level, "info");
});

test("checkExternalRefsForm: block-form map is an issue, inline flow is clean (contract 3)", () => {
  const mk = (frontmatterLines) => ({
    kind: "story", rel: "epics/E1/stories/story-x.md",
    fm: { external_refs: "" },
    body: `---\n${frontmatterLines}\n---\n\n# X\n`,
  });
  const bad = mk("type: story\nexternal_refs:\n  jira: ABC-123");
  const f = checkExternalRefsForm([bad]);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "issue");
  assert.ok(f[0].message.includes("inline flow"), f[0].message);
  const inline = { ...mk("type: story\nexternal_refs: {}"), fm: { external_refs: "{}" } };
  assert.deepEqual(checkExternalRefsForm([inline]), []);
  const absent = { ...mk("type: story"), fm: {} };
  assert.deepEqual(checkExternalRefsForm([absent]), []);
});

test("checkArtifactIdentity: scopes are independent; duplicate display numbers are info", () => {
  const layout = loadLayout("engineering");
  // Same slug in different kind folders / different epics: no identity clash.
  assert.deepEqual(checkArtifactIdentity(layout, vf(
    "adr/foo.md", "research/foo.md",
    "epics/E1/stories/story-foo.md", "epics/E2/stories/story-foo.md")).filter((f) => f.check === "identity" && f.level !== "info"), []);
  // GrammarHelper's double allocation: SPEC-002 twice, distinct slugs → info only.
  const dup = checkArtifactIdentity(layout, vf("specs/SPEC-002-a.md", "specs/spec-002-b.md"));
  assert.equal(dup.length, 1);
  assert.equal(dup[0].level, "info");
  assert.ok(dup[0].message.includes("Display number 2"), dup[0].message);
  // This vault's real shape stays clean: sequential numbers, distinct slugs.
  assert.deepEqual(checkArtifactIdentity(layout, vf(
    "adr/ADR-009-runtime-neutral-core.md", "adr/ADR-010-slug-first-identity.md",
    "epics/PS-CORE/stories/story-001-slug-first-artifact-identity.md")), []);
});

test("checkArtifactNames: sync-conflict shapes warn; cross-folder basenames info; infrastructure exempt", () => {
  const f = checkArtifactNames(vf(
    "research/foo 2.md",                       // sync-conflict → warn
    "adr/topic.md", "research/topic.md",       // cross-folder basename → info
    "adr/README.md", "research/README.md",     // infrastructure → exempt
    "epics/E1/epic.md", "epics/E2/epic.md",    // infrastructure → exempt
    "concepts/clean.md"));
  const warns = f.filter((x) => x.level === "warn");
  const infos = f.filter((x) => x.level === "info");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].file.includes("foo 2.md"));
  assert.equal(infos.length, 1);
  assert.ok(infos[0].message.includes('"topic.md"'), infos[0].message);
});

// ─── spec↔story resolution (SPEC-002 contract 5) ───────────────────────

test("checkSpecLinks: slug entries never prefix-match a story (mis-attribution regression)", () => {
  const layout = loadLayout("engineering");
  const storyArt = {
    kind: "story",
    rel: "epics/E1/stories/cache-invalidation.md",
    abs: "/x/epics/E1/stories/cache-invalidation.md",
    fm: { type: "story", status: "planned", specs: "[]" },
    body: "---\ntype: story\n---\n",
  };
  // The case SPEC-002 pins: "E1/cache" must NOT resolve to cache-invalidation.md.
  const wrong = spec("SPEC-009", ["E1/cache"], "active", "- [x] a\n");
  const f = checkSpecLinks({}, layout, [wrong, storyArt]);
  assert.ok(f.some((x) => x.check === "spec-links" && x.message.includes("does not resolve")),
    JSON.stringify(f));
  // The exact filename stem resolves (hand-created story without id:).
  const exact = spec("SPEC-009", ["E1/cache-invalidation"], "active", "- [x] a\n");
  const f2 = checkSpecLinks({}, layout, [exact, storyArt]);
  assert.ok(!f2.some((x) => x.message.includes("does not resolve")), JSON.stringify(f2));
});

test("checkSpecLinks: legacy story-NNN fallback resolves, exact id wins, ambiguity is reported", () => {
  const layout = loadLayout("engineering");
  const mk = (rel, id) => ({
    kind: "story", rel, abs: `/x/${rel}`,
    fm: { ...(id ? { id } : {}), type: "story", status: "planned", specs: "[]" },
    body: "---\ntype: story\n---\n",
  });
  const s = spec("SPEC-010", ["E1/story-001"], "active", "- [x] a\n");
  // Legacy fallback: story-001 → story-001-a.md (no id:).
  const legacy = checkSpecLinks({}, layout, [s, mk("epics/E1/stories/story-001-a.md")]);
  assert.ok(!legacy.some((x) => x.message.includes("does not resolve")), JSON.stringify(legacy));
  // Two stories both claiming id story-001 → a finding, never a silent first match.
  const amb = checkSpecLinks({}, layout, [
    s,
    mk("epics/E1/stories/story-001-a.md", "story-001"),
    mk("epics/E1/stories/story-001-b.md", "story-001"),
  ]);
  assert.ok(amb.some((x) => x.message.includes("ambiguous")), JSON.stringify(amb));
});

test("shared spec resolver: slug-form references to grandfathered SPEC-NNN files hit in links AND coverage", () => {
  const layout = loadLayout("engineering");
  const grand = {
    kind: "spec",
    rel: "specs/SPEC-001-cache-rules.md",
    abs: "/x/specs/SPEC-001-cache-rules.md",
    fm: { id: "SPEC-001", type: "spec", status: "draft", stories: '["E1/story-001"]' },
    body: "---\n---\n\n## Acceptance\n\n- [x] a\n",
  };
  const st = story("E1", "story-001", "in-progress", { specs: '["cache-rules"]' });
  const links = checkSpecLinks({}, layout, [grand, st]);
  assert.ok(!links.some((x) => x.message.includes("does not exist")), JSON.stringify(links));
  // Coverage sees the same spec through the SAME resolver (draft while
  // in-progress → warn) instead of silently skipping the "dead" link.
  const cov = checkSpecCoverage([grand, st], REQUIRED, layout);
  assert.ok(cov.some((x) => x.check === "spec-status" && x.level === "warn"), JSON.stringify(cov));

  // GrammarHelper shape end-to-end: lowercase spec-NNN-* filename against the
  // uppercase layout prefix, story without fm.id — both eras resolve.
  const gh = {
    kind: "spec",
    rel: "specs/spec-003-parsing.md",
    abs: "/x/specs/spec-003-parsing.md",
    fm: { id: "SPEC-003", type: "spec", status: "active", stories: '["E1/story-001"]' },
    body: "---\n---\n\n## Acceptance\n\n- [x] a\n",
  };
  const st2 = story("E1", "story-001", "in-progress", { specs: '["parsing"]' });
  const links2 = checkSpecLinks({}, layout, [gh, st2]);
  assert.ok(!links2.some((x) => x.message.includes("does not exist")), JSON.stringify(links2));
  // The bidirectional back-link check runs through the SAME resolver: a
  // slug-form back-reference is a valid link, not a missing one.
  assert.ok(!links2.some((x) => x.message.includes("bidirectional")), JSON.stringify(links2));
});

test("checkLifecycleGates: evidence suffix accepted in en and ru, fenced boxes ignored", () => {
  const done = {
    kind: "story",
    rel: "epics/E1/stories/story-001-x.md",
    fm: { type: "story", status: "done", closed_at: "2026-08-04T00:00:00.000Z", plan_updated_at: "2026-08-04T00:00:00.000Z" },
    body: [
      "---", "type: story", "---", "",
      "## Implementation Plan", "", "route", "",
      "## Acceptance Criteria", "",
      "- [x] good — evidence: node --test",
      "- [x] good ru — подтверждение: команда",
      "- [x] bad no evidence",
      "```", "- [x] fenced ignored", "```", "",
      "## Final Summary", "", "done", "",
    ].join("\n"),
  };
  const f = checkLifecycleGates([done], { ...REQUIRED, lifecycle_gates: "on" });
  const ev = f.filter((x) => x.check === "evidence");
  assert.equal(ev.length, 1);
  assert.ok(ev[0].message.includes("bad no evidence"));
  assert.deepEqual(checkLifecycleGates([done], { ...REQUIRED, lifecycle_gates: "off" }), []);
});

test("checkLifecycleGates: missing plan/summary/plan_updated_at on a done story", () => {
  const done = {
    kind: "story",
    rel: "epics/E1/stories/story-002-x.md",
    fm: { type: "story", status: "done", closed_at: "2026-08-04T00:00:00.000Z" },
    body: "---\ntype: story\n---\n\n## Acceptance Criteria\n\n- [x] a — evidence: t\n",
  };
  const checks = checkLifecycleGates([done], { ...REQUIRED, lifecycle_gates: "on" }).map((x) => x.check);
  assert.ok(checks.includes("final-summary"));
  assert.ok(checks.includes("plan-gate"));
});

// ─── statusline wiring: installed-version resolution ───────────────────
//
// The statusLine slot holds one absolute path read at session start, so a
// version-pinned path rendered the PREVIOUS session's plugin. These pin the
// fix: resolve the installed root, and wire a launcher that carries no version.

const LAUNCHER_TEMPLATE = fileURLToPath(
  new URL("../scripts/statusline-launcher.mjs", import.meta.url),
);

// These resolve against tmp homes; a real CLAUDE_CONFIG_DIR in the developer's
// environment would take precedence (claudeHome() prefers it) and mask them.
delete process.env.CLAUDE_CONFIG_DIR;

function fakeInstall(home, version, { marketplace = "SmartAndPoint", broken = false } = {}) {
  const root = join(home, ".claude", "plugins", "cache", marketplace, "projectstore", version);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  // A renderer that names itself, so a spawned launcher proves WHICH install it
  // loaded; `broken` mimics a truncated file mid-update (throws on import).
  writeFileSync(
    join(root, "scripts", "statusline.mjs"),
    broken ? "const = ;\n" : `process.stdout.write("rendered-by-${version}\\n");\n`,
  );
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "projectstore", version }),
  );
  copyFileSync(LAUNCHER_TEMPLATE, join(root, "scripts", "statusline-launcher.mjs"));
  return root;
}

// Materialise the launcher exactly as writeStatusLineLauncher would, then run
// it as its own process against a fixture home — the launcher is what executes
// on every render, so its contract is worth testing directly.
function renderViaLauncher(fallbackRoot, home) {
  const proj = mkdtempSync(join(tmpdir(), "ps-render-"));
  const p = join(proj, ".claude", ".projectstore", "statusline.mjs");
  mkdirSync(join(proj, ".claude", ".projectstore"), { recursive: true });
  writeFileSync(
    p,
    readFileSync(LAUNCHER_TEMPLATE, "utf8").replace(
      '"__PROJECTSTORE_ROOT__"',
      JSON.stringify(fallbackRoot),
    ),
  );
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [p], { input: "{}", encoding: "utf8", env });
}

function writeRegistry(home, entries) {
  const dir = join(home, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "projectstore@SmartAndPoint": entries } }),
  );
}

function withPluginRoot(root, fn) {
  const had = "CLAUDE_PLUGIN_ROOT" in process.env;
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = root;
  try {
    return fn();
  } finally {
    if (had) process.env.CLAUDE_PLUGIN_ROOT = prev;
    else delete process.env.CLAUDE_PLUGIN_ROOT;
  }
}

// The original check matched /plugins/(cache|marketplaces)/<name>/ — with a
// trailing slash — so a marketplace CLONE root, whose path ends at the
// marketplace name, fell through to "local dev install". It also answered about
// the script's own location rather than the session's plugin. Both misreported a
// perfectly ordinary marketplace install whenever doctor was run from a checkout.
test("checkAutoUpdate: a marketplace clone root is not a dev install", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ SmartAndPoint: { autoUpdate: true } }),
  );
  const clone = join(home, ".claude", "plugins", "marketplaces", "SmartAndPoint");
  const out = withPluginRoot(clone, () => checkAutoUpdate(home));
  assert.ok(!out.some((f) => /dev install/.test(f.message)), "clone root names a marketplace");
  // autoUpdate is on for that marketplace, so nothing to report at all
  assert.deepEqual(out, []);
});

test("checkAutoUpdate: falls back to the registered install when run from a checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const installed = fakeInstall(home, "0.16.1");
  writeRegistry(home, [
    { scope: "user", installPath: installed, version: "0.16.1", lastUpdated: "2026-08-04T19:07:28Z" },
  ]);
  // no known_marketplaces.json at all → the marketplace name still resolves,
  // and the finding is about the missing registry rather than a phantom dev install
  const checkout = mkdtempSync(join(tmpdir(), "ps-checkout-"));
  const out = withPluginRoot(checkout, () => checkAutoUpdate(home));
  assert.equal(out.length, 1);
  assert.ok(!/dev install/.test(out[0].message), "a registered marketplace install is not --plugin-dir");
  assert.equal(out[0].level, "warn");
  assert.match(out[0].message, /missing from/);
  assert.match(out[0].message, /SmartAndPoint/);
});

// Regression guard. Rewriting checkAutoUpdate once left a dangling `root`
// reference in this branch; the ReferenceError was swallowed by the branch's own
// `catch {}`, so the newer-release warning silently died while the suite stayed
// green. Untested error-swallowing branches fail exactly like this.
test("checkAutoUpdate: reports a newer release from the marketplace catalog", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const installed = fakeInstall(home, "0.16.1");
  const clone = join(home, ".claude", "plugins", "marketplaces", "SmartAndPoint");
  mkdirSync(join(clone, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(clone, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "projectstore", version: "9.9.9" }] }),
  );
  writeFileSync(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ SmartAndPoint: { autoUpdate: true, installLocation: clone } }),
  );
  const out = withPluginRoot(installed, () => checkAutoUpdate(home));
  assert.equal(out.length, 1);
  assert.match(out[0].message, /A newer projectstore is available: v9\.9\.9/);
  assert.match(out[0].message, /running v0\.16\.1/);
});

test("checkAutoUpdate: says so honestly when nothing is registered", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const checkout = mkdtempSync(join(tmpdir(), "ps-checkout-"));
  const out = withPluginRoot(checkout, () => checkAutoUpdate(home));
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "info");
  assert.match(out[0].message, /No marketplace install/);
});

test("installedPluginRoot: newest install wins, wiped installPaths are ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const r14 = fakeInstall(home, "0.14.0");
  const r15 = fakeInstall(home, "0.15.0");
  writeRegistry(home, [
    // newest timestamp, but the directory is gone — must not be chosen
    { scope: "user", installPath: join(home, "gone", "0.16.0"), version: "0.16.0", lastUpdated: "2026-08-04T23:00:00Z" },
    { scope: "user", installPath: r14, version: "0.14.0", lastUpdated: "2026-08-01T10:00:00Z" },
    { scope: "user", installPath: r15, version: "0.15.0", lastUpdated: "2026-08-04T17:51:53Z" },
  ]);
  assert.deepEqual(installedPluginRoot(home), { path: r15, version: "0.15.0" });
});

test("installedPluginRoot: no registry → null (dev checkout, not an error)", () => {
  assert.equal(installedPluginRoot(mkdtempSync(join(tmpdir(), "ps-home-"))), null);
});

test("statusLineIsOurs recognises both the launcher and the pinned plugin path", () => {
  assert.ok(statusLineIsOurs('node "/x/projectstore/0.15.0/scripts/statusline.mjs"'));
  assert.ok(statusLineIsOurs('node "/p/.claude/.projectstore/statusline.mjs"'));
  assert.ok(!statusLineIsOurs("node /Users/x/.claude/hud/omc-hud.mjs"));
  assert.ok(!statusLineIsOurs(null));
});

test("syncStatusLine wires a version-free launcher for a cache install", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.16.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  assert.ok(isPluginCacheRoot(root, home));

  const res = withPluginRoot(root, () =>
    syncStatusLine({ statusline: { enabled: true } }, proj, home),
  );
  assert.equal(res, "enabled");

  const cmd = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"))
    .statusLine.command;
  assert.ok(cmd.includes(".projectstore/statusline.mjs"), cmd);
  assert.ok(!cmd.includes("0.16.0"), `wired path must carry no version: ${cmd}`);
  assert.ok(statusLineIsOurs(cmd));

  const src = readFileSync(statusLineLauncherPath(proj), "utf8");
  assert.ok(!src.includes("__PROJECTSTORE_ROOT__"), "placeholder must be substituted");
  assert.ok(src.includes(JSON.stringify(root)), "generating root is kept as fallback");

  // Second run changes nothing — the path is stable across plugin updates.
  const again = withPluginRoot(root, () =>
    syncStatusLine({ statusline: { enabled: true } }, proj, home),
  );
  assert.equal(again, "unchanged");
});

test("syncStatusLine migrates an existing pinned wiring and keeps other settings", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const old = fakeInstall(home, "0.15.0");
  const root = fakeInstall(home, "0.16.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "settings.local.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm:*)"] },
      statusLine: { type: "command", command: `node "${join(old, "scripts", "statusline.mjs")}"` },
    }),
  );

  assert.equal(
    withPluginRoot(root, () => syncStatusLine({ statusline: { enabled: true } }, proj, home)),
    "enabled",
  );
  const after = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"));
  assert.ok(after.statusLine.command.includes(".projectstore/statusline.mjs"));
  assert.deepEqual(after.permissions, { allow: ["Bash(npm:*)"] }, "unrelated settings survive");
});

test("syncStatusLine writes nothing into a project whose statusLine is foreign", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.16.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const foreign = JSON.stringify({
    statusLine: { type: "command", command: "node /Users/x/.claude/hud/omc-hud.mjs" },
  });
  writeFileSync(join(proj, ".claude", "settings.local.json"), foreign);

  assert.equal(
    withPluginRoot(root, () => syncStatusLine({ statusline: { enabled: true } }, proj, home)),
    "foreign-present",
  );
  assert.equal(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"), foreign);
  assert.ok(!existsSync(statusLineLauncherPath(proj)), "no launcher in a project we do not wire");
});

test("syncStatusLine refreshes the launcher's fallback on update, command unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  const fallback = () =>
    (readFileSync(statusLineLauncherPath(proj), "utf8").match(/const FALLBACK_ROOT = "(.+)"/) ||
      [])[1];

  const v16 = fakeInstall(home, "0.16.0");
  withPluginRoot(v16, () => syncStatusLine({ statusline: { enabled: true } }, proj, home));
  const cmd = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"))
    .statusLine.command;
  assert.equal(fallback(), v16);

  const v17 = fakeInstall(home, "0.17.0");
  assert.equal(
    withPluginRoot(v17, () => syncStatusLine({ statusline: { enabled: true } }, proj, home)),
    "unchanged",
    "the wired command is version-free, so it does not change across updates",
  );
  assert.equal(
    JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8")).statusLine
      .command,
    cmd,
  );
  assert.equal(fallback(), v17, "…but the launcher's fallback root follows the update");
});

test("syncStatusLine keeps the direct path for a dev checkout (no version to go stale)", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const dev = mkdtempSync(join(tmpdir(), "ps-dev-"));
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  assert.ok(!isPluginCacheRoot(dev, home));

  withPluginRoot(dev, () => syncStatusLine({ statusline: { enabled: true } }, proj, home));
  const cmd = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"))
    .statusLine.command;
  assert.equal(cmd, `node "${join(dev, "scripts", "statusline.mjs")}"`);
  assert.ok(!existsSync(statusLineLauncherPath(proj)), "no launcher for a dev checkout");
});

test("launcher renders the INSTALLED version, not the one it was generated from", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const old = fakeInstall(home, "0.14.0");
  const cur = fakeInstall(home, "0.16.0");
  writeRegistry(home, [
    { scope: "user", installPath: cur, version: "0.16.0", lastUpdated: "2026-08-04T18:00:00Z" },
  ]);
  const r = renderViaLauncher(old, home); // generated back when 0.14.0 was current
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "rendered-by-0.16.0\n");
});

test("launcher falls back to its generating root when the registry is unreadable", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const old = fakeInstall(home, "0.14.0"); // no registry written at all
  const r = renderViaLauncher(old, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "rendered-by-0.14.0\n");
});

test("launcher retries the fallback when the installed renderer is broken", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const good = fakeInstall(home, "0.14.0");
  const broken = fakeInstall(home, "0.16.0", { broken: true }); // truncated mid-update
  writeRegistry(home, [
    { scope: "user", installPath: broken, version: "0.16.0", lastUpdated: "2026-08-04T18:00:00Z" },
  ]);
  const r = renderViaLauncher(good, home);
  assert.equal(r.status, 0);
  // Without the retry the whole HUD — including the base one we compose over —
  // would blank out while a working fallback sat unused.
  assert.equal(r.stdout, "rendered-by-0.14.0\n");
});

test("launcher prints one blank line, exit 0, when nothing resolves", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const r = renderViaLauncher(join(home, "gone", "0.14.0"), home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "\n");
});

test("launcher never imports another marketplace's projectstore", () => {
  // The registry key is per marketplace, so a fork installed as
  // projectstore@Fork is a different codebase, not a newer copy of ours — and
  // whatever the launcher picks, it executes on every render.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const mine = fakeInstall(home, "0.16.0");
  const fork = fakeInstall(home, "9.9.9", { marketplace: "Fork" });
  const dir = join(home, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "projectstore@Fork": [
          { installPath: fork, version: "9.9.9", lastUpdated: "2026-08-04T23:00:00Z" },
        ],
      },
    }),
  );
  const r = renderViaLauncher(mine, home);
  assert.equal(r.stdout, "rendered-by-0.16.0\n", "falls back to its own family, never the fork");
});

test("launcher runs the user's base HUD rather than blanking it when projectstore is gone", () => {
  // Uninstall / cache sweep: no registry, fallback root gone, launcher still
  // wired. Our entry outranks the user's own statusLine, so a blank line here
  // would take away a HUD they had before us — in every bound project.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "printf 'BASE-HUD'" } }),
  );
  const r = renderViaLauncher(join(home, "wiped", "0.16.0"), home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "BASE-HUD\n");
});

test("both resolvers pick the same install (lib.installedPluginRoot vs the launcher)", () => {
  // The launcher duplicates the resolution logic on purpose — importing the
  // shared helper would mean naming a versioned path. The duplication is only
  // acceptable while the two orderings agree, so pin that with one input.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const mine016 = fakeInstall(home, "0.16.0");
  const mine0161 = fakeInstall(home, "0.16.1");
  const other = fakeInstall(home, "0.99.0", { marketplace: "OtherMarket" });
  writeRegistry(home, [
    { scope: "user", installPath: other, version: "0.99.0", lastUpdated: "2026-08-04T23:00:00Z" },
    { scope: "user", installPath: mine016, version: "0.16", lastUpdated: "2026-08-04T18:00:00Z" },
    { scope: "user", installPath: mine0161, version: "0.16.1", lastUpdated: "2026-08-04T18:00:00Z" },
  ]);
  const family = dirname(mine016); // …/SmartAndPoint/projectstore
  const lib = installedPluginRoot(home, family);
  const spawned = renderViaLauncher(mine016, home).stdout.trim();
  assert.equal(lib.path, mine0161, "family wins over a newer foreign marketplace; 0.16.1 > 0.16");
  assert.equal(spawned, "rendered-by-0.16.1", "the launcher must land on the same install");
});

test("installedPluginRoot honours CLAUDE_CONFIG_DIR over the home directory", () => {
  const base = mkdtempSync(join(tmpdir(), "ps-cfg-"));
  const cfg = join(base, "elsewhere");
  const root = join(cfg, "plugins", "cache", "SmartAndPoint", "projectstore", "0.16.0");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "statusline.mjs"), "// stub\n");
  mkdirSync(join(cfg, "plugins"), { recursive: true });
  writeFileSync(
    join(cfg, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "projectstore@SmartAndPoint": [{ installPath: root, version: "0.16.0" }] } }),
  );
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // The home argument points somewhere with no plugins at all: only the
    // env var can find this install.
    assert.deepEqual(installedPluginRoot(join(base, "unused-home")), { path: root, version: "0.16.0" });
    assert.ok(isPluginCacheRoot(root, join(base, "unused-home")));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("syncStatusLine will not clobber a user's own script that merely looks like ours", () => {
  // ~/.claude/scripts/statusline.mjs is a plausible name for a hand-written HUD
  // (the platform's own /statusline generates into ~/.claude). Matching on the
  // path shape alone would overwrite it on `on` and delete it on `off`.
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.16.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  const theirs = join(home, ".claude", "scripts", "statusline.mjs");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const before = JSON.stringify({ statusLine: { type: "command", command: `node "${theirs}"` } });
  writeFileSync(join(proj, ".claude", "settings.local.json"), before);

  assert.equal(
    withPluginRoot(root, () => syncStatusLine({ statusline: { enabled: true } }, proj, home)),
    "foreign-present",
  );
  assert.equal(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"), before);
  assert.ok(statusLineIsOurs(`node "${theirs}"`), "the loose shape test still matches — that is why it cannot decide writes");
});

test("syncStatusLine keeps sibling keys on the statusLine entry", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.16.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "settings.local.json"),
    JSON.stringify({
      statusLine: {
        type: "command",
        command: `node "${join(root, "scripts", "statusline.mjs")}"`,
        refreshInterval: 5000,
      },
    }),
  );
  withPluginRoot(root, () => syncStatusLine({ statusline: { enabled: true } }, proj, home));
  const entry = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8")).statusLine;
  assert.ok(entry.command.includes(".projectstore/statusline.mjs"));
  assert.equal(entry.refreshInterval, 5000, "we own the command, not the whole entry");
});

test("statusLineScriptVersion: version for a pinned path, null for the launcher", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.14.0");
  assert.equal(statusLineScriptVersion(join(root, "scripts", "statusline.mjs")), "0.14.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  assert.equal(statusLineScriptVersion(statusLineLauncherPath(proj)), null);
});

test("checkStatusline warns when the wired version is not the installed one", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const old = fakeInstall(home, "0.14.0");
  const cur = fakeInstall(home, "0.15.0");
  writeRegistry(home, [
    { scope: "user", installPath: cur, version: "0.15.0", lastUpdated: "2026-08-04T17:51:53Z" },
  ]);
  const proj = mkdtempSync(join(tmpdir(), "ps-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "settings.local.json"),
    JSON.stringify({
      statusLine: { type: "command", command: `node "${join(old, "scripts", "statusline.mjs")}"` },
    }),
  );

  const out = checkStatusline({ statusline: { enabled: true } }, proj, home);
  const drift = out.filter((f) => f.level === "warn" && /0\.14\.0.*0\.15\.0/.test(f.message));
  assert.equal(drift.length, 1, JSON.stringify(out));

  // A dev checkout carries a version too, but syncStatusLine wires it on
  // purpose and never rewires it — warning there would be a permanent lie.
  const dev = mkdtempSync(join(tmpdir(), "ps-dev-"));
  mkdirSync(join(dev, "scripts"), { recursive: true });
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dev, "scripts", "statusline.mjs"), "// dev checkout\n");
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.99.0" }));
  writeFileSync(
    join(proj, ".claude", "settings.local.json"),
    JSON.stringify({
      statusLine: { type: "command", command: `node "${join(dev, "scripts", "statusline.mjs")}"` },
    }),
  );
  assert.deepEqual(
    withPluginRoot(dev, () =>
      checkStatusline({ statusline: { enabled: true } }, proj, home).filter((f) => f.level !== "info"),
    ),
    [],
  );

  // …and stays silent once the launcher is wired: it has no pinned version.
  writeFileSync(
    join(proj, ".claude", "settings.local.json"),
    JSON.stringify({
      statusLine: { type: "command", command: `node "${statusLineLauncherPath(proj)}"` },
    }),
  );
  mkdirSync(join(proj, ".claude", ".projectstore"), { recursive: true });
  writeFileSync(statusLineLauncherPath(proj), "// launcher\n");
  assert.deepEqual(
    checkStatusline({ statusline: { enabled: true } }, proj, home).filter((f) => f.level !== "info"),
    [],
  );
});

// ─── link graph: extraction, node index, resolver ───────────────────────
// (spec: vault-link-graph-derived-view-and-shared-link-resolver, contracts 2-3)

test("extractLinks: code excluded; alias/#section/escaped-pipe forms; only relative md links", () => {
  const text = [
    "[[plain]] and [[target|alias]] and [[sect#part]]",
    "[[epics/PS-A/epic\\|PS-A]]",
    "`[[in-code]]` and [md](./sib.md) [up](../up.md#frag)",
    "```",
    "[[in-fence]] [f](./fenced.md)",
    "```",
    "[url](https://x.test/a.md) [abs](/abs.md)",
  ].join("\n");
  assert.equal(stripCodeSpans("a `b` c\n```\nd\n```\n").includes("b"), false);
  const links = extractLinks(text);
  assert.deepEqual(links.filter((l) => l.type === "wikilink").map((l) => l.target),
    ["plain", "target", "sect", "epics/PS-A/epic"]);
  assert.deepEqual(links.filter((l) => l.type === "mdlink").map((l) => l.target),
    ["./sib.md", "../up.md"]);
});

// A real temp vault for index + resolver tests — engineering layout shapes.
function graphVault() {
  const vault = mkdtempSync(join(tmpdir(), "ps-graphidx-"));
  const put = (rel, content) => {
    mkdirSync(join(vault, dirname(rel)), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  const fm = (lines) => `---\n${lines.join("\n")}\n---\n\n# T\n`;
  put("adr/ADR-010-slug-first.md", fm(['type: adr', 'id: "ADR-010"', 'title: "Slug first"', 'status: accepted', 'date: 2026-01-01']));
  put("adr/loose.md", fm(['type: adr', 'id: "loose-decision"', 'title: "Loose"', 'status: proposed', 'date: 2026-01-02']));
  put("adr/dup.md", fm(['type: adr', 'id: "dup-adr"', 'title: "D2"', 'status: proposed', 'date: 2026-01-01']));
  put("specs/SPEC-002-slug-first-artifact-identity.md", fm(['type: spec', 'id: "SPEC-002"', 'title: "Identity"', 'status: active', 'date: 2026-01-01']));
  put("research/some-note.md", fm(['type: research', 'slug: "research-alias"', 'title: "Note"', 'date: 2026-01-03']));
  put("concepts/MixedCase.md", fm(['type: concept', 'slug: "mixedcase"', 'title: "MC"', 'date: 2026-01-01']));
  put("concepts/dup.md", fm(['type: concept', 'slug: "dup-concept"', 'title: "D1"', 'date: 2026-01-01']));
  put("epics/PS-A/epic.md", fm(['type: epic', 'id: "PS-A"', 'title: "A"', 'status: in-progress', 'created: 2026-01-01']));
  put("epics/PS-B/epic.md", fm(['type: epic', 'id: "PS-B"', 'title: "B"', 'status: planned', 'created: 2026-01-01']));
  put("epics/PS-A/stories/story-cache.md", fm(['type: story', 'id: "story-cache"', 'title: "Cache"', 'status: planned', 'created: 2026-01-01']));
  put("epics/PS-A/stories/story-cache-invalidation.md", fm(['type: story', 'id: "story-cache-invalidation"', 'title: "CacheInv"', 'status: planned', 'created: 2026-01-02']));
  put("epics/PS-A/stories/story-004-old-era.md", fm(['type: story', 'id: "story-004-old-era"', 'title: "Old"', 'status: done', 'created: 2025-01-01']));
  // Real legacy stories carry a SHORT id (story-013), not the full stem —
  // the reviewer regression: the as-written stem must be a tier-2 reading.
  put("epics/PS-A/stories/story-013-short-id.md", fm(['type: story', 'id: "story-013"', 'title: "Short id era"', 'status: done', 'created: 2025-01-02']));
  put("epics/PS-A/stories/story-folder/README.md", fm(['type: story', 'id: "story-folder"', 'title: "Folder"', 'status: planned', 'created: 2026-01-01']));
  put("epics/PS-A/story-standalone.md", fm(['type: story', 'id: "story-standalone"', 'title: "Standalone"', 'status: planned', 'created: 2026-01-01']));
  put("epics/_templates/epic.md", fm(['type: epic', 'id: "T"', 'title: "Blank"']));
  put("meetings/Plain Note.md", "just text, no frontmatter\n");
  put("adr/README.md", "# adr index\n");
  put("specs/README.md", "# specs index\n");
  writeFileSync(join(vault, "kanban.md"), "board\n");
  writeFileSync(join(vault, "loose.md"), "root twin of adr/loose.md\n");
  const layout = loadLayout("engineering");
  const cfg = { vault_path: vault, layout: "engineering" };
  const index = buildNodeIndex(cfg, layout);
  const files = walkVaultFiles(vault);
  const ctx = (sourceRel, extra = {}) => ({ sourceRel, index, files, ...extra });
  return { vault, index, files, ctx };
}

test("buildNodeIndex: all three story shapes are nodes; READMEs, root files and _dirs are not (contract 2)", () => {
  const { index } = graphVault();
  const paths = index.nodes.map((n) => n.path);
  assert.ok(paths.includes("epics/PS-A/stories/story-folder/README.md"), "folder-shape story");
  assert.ok(paths.includes("epics/PS-A/story-standalone.md"), "standalone story");
  assert.ok(paths.includes("epics/PS-A/stories/story-cache.md"));
  assert.ok(!paths.includes("adr/README.md"), "folder README is not a node");
  assert.ok(!paths.some((p) => p.startsWith("epics/_templates/")), "_dirs hold blanks, not work");
  assert.ok(!paths.includes("kanban.md") && !paths.includes("loose.md"), "root files are not nodes");
  const meeting = index.nodes.find((n) => n.path === "meetings/Plain Note.md");
  assert.equal(meeting.title, "Plain Note", "title falls back to the filename stem");
  assert.equal(meeting.status, null, "no frontmatter status — renders as -");
});

test("resolveLinkTarget tiers: identity (id and slug:), stem readings, legacy prefix fallback; slug never prefix-matches (contract 3)", () => {
  const { ctx } = graphVault();
  const at = (t, extra) => resolveLinkTarget(t, "wikilink", ctx("adr/loose.md", extra));
  assert.equal(at("ADR-010").node.path, "adr/ADR-010-slug-first.md", "tier 1: fm.id");
  assert.equal(at("research-alias").node.path, "research/some-note.md", "tier 1: fm.slug for slug-carrying kinds");
  assert.equal(at("slug-first-artifact-identity").node.path,
    "specs/SPEC-002-slug-first-artifact-identity.md", "tier 2: number-stripped stem reading");
  assert.equal(at("story-004").node.path, "epics/PS-A/stories/story-004-old-era.md", "tier 3: legacy story-NNN prefix");
  assert.equal(at("story-013-short-id").node.path, "epics/PS-A/stories/story-013-short-id.md",
    "tier 2: the as-written story stem — the Obsidian-autocompleted form — must resolve (kanban cards never out-of-scope)");
  assert.equal(at("story-013").node.path, "epics/PS-A/stories/story-013-short-id.md", "tier 1: short legacy id");
  assert.equal(at("cache").node.path, "epics/PS-A/stories/story-cache.md",
    "slug form matches exactly — cache must not prefix-match cache-invalidation");
  assert.equal(at("mixedCASE").node.path, "concepts/MixedCase.md", "stems are case-insensitive");
});

test("resolveLinkTarget paths: / bypasses tiers; root-relative escape rejected; wrong depth dead (contract 3)", () => {
  const { ctx } = graphVault();
  const r1 = resolveLinkTarget("epics/PS-A/epic", "wikilink", ctx("adr/loose.md"));
  assert.equal(r1.node.path, "epics/PS-A/epic.md", "path bypasses the ambiguous epic stem");
  const r2 = resolveLinkTarget("epic", "wikilink", ctx("adr/loose.md"));
  assert.equal(r2.outcome, "ambiguous");
  assert.deepEqual(r2.candidates, ["epics/PS-A/epic.md", "epics/PS-B/epic.md"]);
  const r3 = resolveLinkTarget("../epics/PS-B/epic", "wikilink", ctx("adr/loose.md"));
  assert.equal(r3.node.path, "epics/PS-B/epic.md", "source-relative try fires after the root try is rejected");
  assert.equal(resolveLinkTarget("../../adr/ADR-010-slug-first", "wikilink", ctx("adr/loose.md")).outcome,
    "dead", "a wrong relative depth is dead — no basename fallback");
  assert.equal(resolveLinkTarget("epics/PS-A/epic.md", "wikilink", ctx("adr/loose.md")).node.path,
    "epics/PS-A/epic.md", ".md-suffixed form accepted");
});

test("resolveLinkTarget rings: node beats non-node; non-node-only is out-of-scope; kinds scoping skips ring 2 (contract 3)", () => {
  const { ctx } = graphVault();
  const at = (t, extra) => resolveLinkTarget(t, "wikilink", ctx("adr/ADR-010-slug-first.md", extra));
  assert.equal(at("loose").node.path, "adr/loose.md", "node wins over the root twin");
  const oos = at("kanban");
  assert.equal(oos.outcome, "out-of-scope");
  assert.equal(oos.path, "kanban.md", "unique non-node hit reports its path");
  const multi = at("readme");
  assert.equal(multi.outcome, "out-of-scope");
  assert.equal(multi.path, undefined, "several non-nodes share the stem — no single path");
  assert.equal(at("ghost").outcome, "dead");
  assert.equal(at("ADR-010", { kinds: ["spec"] }).outcome, "dead", "kind-scoped refs never fall into ring 2");
  assert.equal(at("SPEC-002", { kinds: ["spec"] }).node.path, "specs/SPEC-002-slug-first-artifact-identity.md");
  const cross = at("dup");
  assert.equal(cross.outcome, "ambiguous", "cross-kind stem multi-hit is ambiguous");
  assert.deepEqual(cross.candidates, ["adr/dup.md", "concepts/dup.md"]);
});

test("resolveLinkTarget mdlinks: source-relative only; attachments via injected exists; outside vault out-of-scope (contract 3)", () => {
  const { ctx } = graphVault();
  const from = "adr/ADR-010-slug-first.md";
  assert.equal(resolveLinkTarget("./loose.md", "mdlink", ctx(from)).node.path, "adr/loose.md");
  const readme = resolveLinkTarget("./README.md", "mdlink", ctx(from));
  assert.equal(readme.outcome, "out-of-scope");
  assert.equal(readme.path, "adr/README.md");
  assert.equal(resolveLinkTarget("../kanban.md", "mdlink", ctx(from)).outcome, "out-of-scope");
  assert.equal(resolveLinkTarget("./missing.md", "mdlink", ctx(from)).outcome, "dead");
  assert.equal(resolveLinkTarget("../../outside.md", "mdlink", ctx(from)).outcome, "out-of-scope",
    "escaping the vault root is out-of-scope, never probed");
  assert.equal(resolveLinkTarget("./art.png", "mdlink", ctx(from)).outcome, "dead", "non-md needs exists()");
  assert.equal(
    resolveLinkTarget("./art.png", "mdlink", ctx(from, { exists: (rel) => rel === "adr/art.png" })).outcome,
    "out-of-scope", "attachment classified via injected exists()");
});

test("resolveSelection: graph — in bare selection, composable, valid on kanban-less and epic-less layouts", () => {
  const layout = loadLayout("engineering");
  assert.ok(resolveSelection(layout, null).graph, "bare invocation includes graph");
  const g = resolveSelection(layout, "graph");
  assert.ok(g.explicit && g.graph && !g.kanban && !g.codemap);
  assert.deepEqual(g.indexes, []);
  const combo = resolveSelection(layout, "graph,kanban");
  assert.ok(combo.graph && combo.kanban);
  const noKanban = { ...layout, kanban: null };
  assert.ok(resolveSelection(noKanban, "graph").graph, "valid without a kanban");
  const noEpics = { ...layout, folders: layout.folders.filter((f) => f.kind !== "epic") };
  assert.ok(resolveSelection(noEpics, "graph").graph, "valid without an epic folder");
});

// ─── Entry-rule detection (PS-AGENTS: artifact-first order) ────────────
//
// Contracts 1, 2, 4 and 5 of the spec "Entry-rule detection: the score, the
// open-story predicate, and the delivery seams". The case table below was
// pinned in the story's Implementation Plan BEFORE any of this was written,
// so these assertions document a decision rather than the code that happened.

function seedEntryFixture() {
  const root = mkdtempSync(join(tmpdir(), "ps-entry-"));
  const proj = join(root, "proj");
  const vault = join(root, "vault");
  mkdirSync(proj, { recursive: true });
  mkdirSync(vault, { recursive: true });
  return { root, proj, vault };
}

test("isSourcePath: inside project, outside vault, not ignored (contract 1)", () => {
  const { proj, vault } = seedEntryFixture();
  const p = (rel) => join(proj, rel);

  assert.equal(isSourcePath(p("scripts/lib.mjs"), proj, vault), true);
  assert.equal(isSourcePath(p("README.md"), proj, vault), true);
  assert.equal(isSourcePath(p("docs/getting-started.md"), proj, vault), true);

  assert.equal(isSourcePath(join(vault, "adr/ADR-001.md"), proj, vault), false, "vault is not source");
  assert.equal(isSourcePath("/elsewhere/x.mjs", proj, vault), false, "outside the project");
  assert.equal(isSourcePath(proj, proj, vault), false, "the project root itself is not a path");

  assert.equal(isSourcePath(p("node_modules/x/index.js"), proj, vault), false);
  assert.equal(isSourcePath(p("dist/bundle.js"), proj, vault), false);
  assert.equal(isSourcePath(p("package-lock.json"), proj, vault), false);
  assert.equal(isSourcePath(p("app.min.js"), proj, vault), false);
  assert.equal(isSourcePath(p(".claude/projectstore.json"), proj, vault), false,
    "plugin state must never count as source work");
});

test("isSourcePath: bind's own writes are ignored for the counter, root-anchored (contract 1)", () => {
  const { proj, vault } = seedEntryFixture();
  const p = (rel) => join(proj, rel);

  // /projectstore:bind writes these three in a session that by construction has
  // no story open.
  assert.equal(isSourcePath(p("AGENTS.md"), proj, vault), false);
  assert.equal(isSourcePath(p("CLAUDE.md"), proj, vault), false);
  assert.equal(isSourcePath(p(".gitignore"), proj, vault), false);

  // Root-anchored: a monorepo's nested AGENTS.md is ordinary source.
  assert.equal(isSourcePath(p("packages/web/AGENTS.md"), proj, vault), true);
  assert.equal(isSourcePath(p("packages/web/CLAUDE.md"), proj, vault), true);
});

test("the two ignore sets differ on purpose — AGENTS.md stays a code ref (contract 1)", () => {
  // Folding the bind-managed files into SOURCE_IGNORE would silently drop
  // AGENTS.md from every proposed code_refs, and the PS-AGENTS epic already
  // lists it. ENTRY_IGNORE extends; it does not replace.
  const src = SOURCE_IGNORE.map(String);
  const entry = ENTRY_IGNORE.map(String);
  for (const re of src) assert.ok(entry.includes(re), `ENTRY_IGNORE must contain ${re}`);
  assert.equal(entry.length, src.length + 3);
  assert.ok(!src.some((re) => /AGENTS/.test(re)), "AGENTS.md must remain a code ref");
});

test("isSourcePath: matching is project-relative, not absolute (contract 1)", () => {
  // The base patterns are repo-relative-anchored, so matching an absolute path
  // would swallow every file in a project that merely lives under `build/`.
  const root = mkdtempSync(join(tmpdir(), "ps-entry-"));
  const proj = join(root, "build", "myproject");
  const vault = join(root, "vault");
  mkdirSync(proj, { recursive: true });
  assert.equal(isSourcePath(join(proj, "src/index.js"), proj, vault), true,
    "a project under a build/ ancestor still has source files");
});

test("entryScore: distinct paths, idempotent, exact and uncapped (contract 2)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-1";
  assert.equal(entryScore(proj, sid), 0, "no directory yet reads as zero");

  registerSourcePath(proj, sid, join(proj, "a.mjs"));
  registerSourcePath(proj, sid, join(proj, "b.mjs"));
  registerSourcePath(proj, sid, join(proj, "a.mjs"));
  assert.equal(entryScore(proj, sid), 2, "re-registering the same path does not double-count");

  for (let i = 0; i < 53; i++) registerSourcePath(proj, sid, join(proj, `f${i}.mjs`));
  assert.equal(entryScore(proj, sid), 55,
    "uncapped: the reminder quotes this number, so 55 files must not report 3");

  assert.equal(entryScore(proj, "other-session"), 0, "scores are per session");
});

test("entryScore: registration never rewrites, so parallel writers cannot lose an increment (contract 2)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-race";
  const paths = Array.from({ length: 40 }, (_, i) => join(proj, `p${i}.mjs`));
  // Interleaved registration of overlapping sets, the shape parallel subagents
  // produce. Each create is independent; there is no read-modify-write to lose.
  for (const p of paths) registerSourcePath(proj, sid, p);
  for (const p of paths) registerSourcePath(proj, sid, p);
  assert.equal(entryScore(proj, sid), 40);
  // And the ADR-006 pointer file is untouched by any of it.
  assert.equal(existsSync(join(scoreDir(proj, sid), "..", `${sid}.json`)), false,
    "scoring writes nothing into the session pointer's file");
});

test("openStoryFrom: only in-progress counts as open (contract 5)", () => {
  assert.equal(openStoryFrom([{ status: "in-progress" }]), true);
  assert.equal(openStoryFrom([{ status: "planned" }]), false,
    "a story that never went through /projectstore:story plan is not open work");
  assert.equal(openStoryFrom([{ status: "done" }]), false);
  assert.equal(openStoryFrom([{ status: "planned" }, { status: "done" }]), false);
  assert.equal(openStoryFrom([{ status: "planned" }, { status: "in-progress" }]), true);
  assert.equal(openStoryFrom([]), false, "an empty vault has no open story");
  assert.equal(openStoryFrom(null), false);
  assert.equal(openStoryFrom([null, undefined, {}]), false, "malformed entries do not throw");
});

test("the pinned case table: which sessions trip the threshold (contracts 2, 4)", () => {
  const { proj, vault } = seedEntryFixture();
  const THRESHOLD = ENTRY_THRESHOLD;
  let n = 0;
  const score = (rels) => {
    const sid = `case-${n++}`;
    for (const rel of rels) {
      const abs = join(proj, rel);
      if (isSourcePath(abs, proj, vault)) registerSourcePath(proj, sid, abs);
    }
    return entryScore(proj, sid);
  };

  // Negatives the covered story pre-committed to (its AC 3).
  assert.equal(score(["src/a.mjs"]), 1, "typo fix");
  assert.equal(score(["src/a.mjs"]), 1, "single-line change");
  assert.equal(score([]), 0, "a question writes nothing");
  assert.equal(score(["README.md"]), 1, "README typo");
  assert.equal(score(["src/a.mjs", "README.md"]), 2, "two-file fix touching README");
  assert.equal(score(["package.json"]), 1,
    "a lone manifest edit is a one-liner — the weighted design scored this 3 and fired");

  // Positives.
  assert.equal(score(["README.md", "docs/getting-started.md", "docs/how-it-works.md"]), THRESHOLD,
    "a three-page documentation pass is a content project — true positive");

  // The incident's own commit: 44 templates plus registry, doctor, manifests, README.
  const incident = [
    ...Array.from({ length: 44 }, (_, i) => `templates/x/${i}.md.tmpl`),
    "scaffold/headings.json", "scripts/doctor.mjs",
    ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "README.md",
  ];
  assert.ok(score(incident) >= THRESHOLD, "the reported incident trips the threshold");
  assert.equal(score(incident.slice(0, 3)), THRESHOLD,
    "and it trips at the third template file, not the fiftieth");
});

import { readFile as readFileAsyncTest } from "node:fs/promises";
import { utimesSync as utimesSyncTest } from "node:fs";
import { stateDir as stateDirOf, writeSessionState as writeSessionStateTest } from "../scripts/lib.mjs";

function seedVaultStories(vault, stories) {
  // stories: { "PS-A/stories/story-x.md": "planned", ... }
  for (const [rel, status] of Object.entries(stories)) {
    const abs = join(vault, "epics", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `---\ntype: story\nstatus: ${status}\n---\n\n# x\n`, "utf8");
  }
}

test("listVaultStoryFiles: sees flat, folder-shape and standalone stories (contract 5)", () => {
  const { vault } = seedEntryFixture();
  seedVaultStories(vault, {
    "PS-A/stories/story-flat.md": "planned",
    "PS-A/stories/story-folder/README.md": "planned",
    "PS-B/story-standalone.md": "planned",
  });
  const found = listVaultStoryFiles(vault).map((p) => p.replace(vault + "/", ""));
  assert.equal(found.length, 3, "all three shapes, none missed");
  assert.ok(found.some((f) => f.endsWith("story-flat.md")));
  assert.ok(found.some((f) => f.endsWith("story-folder/README.md")), "folder-shape story");
  assert.ok(found.some((f) => f.endsWith("story-standalone.md")), "standalone story");
  assert.deepEqual(listVaultStoryFiles(join(vault, "nope")), [], "missing vault yields nothing");
});

test("resolveOpenStory: true/false from real reads (contracts 5, 6)", async () => {
  const { vault } = seedEntryFixture();
  seedVaultStories(vault, {
    "PS-A/stories/story-a.md": "planned",
    "PS-A/stories/story-b.md": "done",
  });
  assert.equal(await resolveOpenStory(vault), false, "planned + done is not open");

  const { vault: v2 } = seedEntryFixture();
  seedVaultStories(v2, {
    "PS-A/stories/story-a.md": "planned",
    "PS-A/stories/story-b.md": "in-progress",
  });
  assert.equal(await resolveOpenStory(v2), true);

  const { vault: v3 } = seedEntryFixture();
  assert.equal(await resolveOpenStory(v3), false, "an empty vault has no open story");
});

test("resolveOpenStory: ONE blocking read yields unknown, not a hang (contract 6)", async () => {
  const { vault } = seedEntryFixture();
  seedVaultStories(vault, {
    "PS-A/stories/story-a.md": "planned",
    "PS-A/stories/story-b-stuck.md": "planned",
    "PS-A/stories/story-c.md": "in-progress",
  });
  // The failure this guards is an iCloud-evicted file blocking INSIDE one read
  // while macOS downloads it — not a slow gap between reads. A deadline checked
  // between files would sail past this and the hook would hang.
  let stalled = 0;
  const readFile = (p) => {
    if (p.endsWith("story-b-stuck.md")) {
      stalled++;
      return new Promise(() => {}); // never settles
    }
    return readFileAsyncTest(p, "utf8");
  };
  const t0 = Date.now();
  const verdict = await resolveOpenStory(vault, { budgetMs: 60, readFile });
  const elapsed = Date.now() - t0;
  assert.equal(verdict, "unknown", "the budget wins over a read that never returns");
  assert.equal(stalled, 1, "the stall was reached, so the test exercised the real path");
  assert.ok(elapsed < 2000, `returned in ${elapsed}ms rather than hanging`);
});

test("resolveOpenStory: the scan short-circuits, so a later stall cannot matter (contract 6)", async () => {
  const { vault } = seedEntryFixture();
  seedVaultStories(vault, {
    "PS-A/stories/story-a.md": "in-progress",
    "PS-A/stories/story-z-stuck.md": "planned",
  });
  // The budget is load-bearing only on the `false` path — which is exactly the
  // path that fires the reminder. Once an in-progress story is seen the verdict
  // is settled and nothing after it is read, stalled or not.
  let reached = 0;
  const readFile = (p) => {
    if (p.endsWith("story-z-stuck.md")) { reached++; return new Promise(() => {}); }
    return readFileAsyncTest(p, "utf8");
  };
  assert.equal(await resolveOpenStory(vault, { budgetMs: 60, readFile }), true);
  assert.equal(reached, 0, "a stall after the answer is never even reached");
});

test("resolveOpenStory: a fast vault beats the budget and returns a real verdict (contract 6)", async () => {
  const { vault } = seedEntryFixture();
  seedVaultStories(vault, { "PS-A/stories/story-a.md": "in-progress" });
  assert.equal(await resolveOpenStory(vault, { budgetMs: 5000 }), true);
});

test("open-story cache: written once, O_EXCL, distinguishes unknown from absent (contract 7)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-cache";
  assert.equal(readOpenStoryCache(proj, sid), null, "no verdict yet is null, not false");

  assert.equal(writeOpenStoryCache(proj, sid, false), true);
  assert.equal(readOpenStoryCache(proj, sid), false);

  assert.equal(writeOpenStoryCache(proj, sid, true), false,
    "a second writer loses the race and does not overwrite the verdict");
  assert.equal(readOpenStoryCache(proj, sid), false, "the first verdict stands");

  const sid2 = "sess-unknown";
  writeOpenStoryCache(proj, sid2, "unknown");
  assert.equal(readOpenStoryCache(proj, sid2), "unknown",
    "a cached unknown is distinct from no verdict at all");
});

test("cleanupStaleSessionState: reaps stale score/marker dirs, spares fresh ones (contract 3)", () => {
  const { proj } = seedEntryFixture();
  const stale = "sess-old", fresh = "sess-new";
  registerSourcePath(proj, stale, join(proj, "a.mjs"));
  writeOpenStoryCache(proj, stale, false);
  registerSourcePath(proj, fresh, join(proj, "b.mjs"));
  writeFileSync(join(stateDirOf(proj), `${stale}.json`), "{}", "utf8");

  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (const d of [scoreDir(proj, stale), markerDir(proj, stale), join(stateDirOf(proj), `${stale}.json`)]) {
    utimesSyncTest(d, old, old);
  }

  const removed = cleanupStaleSessionState(proj, 24);
  assert.ok(removed >= 3, `reaped the stale trio, got ${removed}`);
  assert.equal(existsSync(scoreDir(proj, stale)), false, "stale score dir gone — it used to leak forever");
  assert.equal(existsSync(markerDir(proj, stale)), false, "stale marker dir gone");
  assert.equal(existsSync(join(stateDirOf(proj), `${stale}.json`)), false, "stale pointer gone, as before");
  assert.equal(entryScore(proj, fresh), 1, "the fresh session is untouched");
});

test("electEmitter: exactly one winner per armed context (contract 12)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-elect";
  assert.equal(mayRemind(proj, sid), true, "a fresh session may remind");
  assert.equal(electEmitter(proj, sid), true, "first caller is elected");
  assert.equal(firedCount(proj, sid), 1);

  assert.equal(electEmitter(proj, sid), false, "a second caller in the same context loses");
  assert.equal(electEmitter(proj, sid), false);
  assert.equal(firedCount(proj, sid), 1, "and leaves no extra marker behind");
  assert.equal(mayRemind(proj, sid), false, "permission is gone until re-arming");
});

test("electEmitter: contenders cannot take one name each (contract 12)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-contend";
  // Sequential contention only. Note what this does NOT catch: under the
  // rejected "try fired-1, on EEXIST try fired-2" rule this test still passes,
  // because the second call sees a count of 1 and is refused permission before
  // it ever reaches the fall-through. The fall-through is reachable only when
  // two processes observe an empty directory at the same instant — which is why
  // the racing test below exists and why inspection was never going to be
  // enough. Verified by mutation: only the racing test goes red.
  const wins = [electEmitter(proj, sid), electEmitter(proj, sid), electEmitter(proj, sid)];
  assert.deepEqual(wins, [true, false, false]);
  assert.equal(firedCount(proj, sid), 1, "no fall-through to the second slot");
});

test("armReminder + electEmitter: exactly two firings per session id (contracts 12, 16)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-cap";

  assert.equal(electEmitter(proj, sid), true, "firing 1");
  assert.equal(electEmitter(proj, sid), false);

  // First compaction: the conversation was discarded, so the delivered reminder
  // is gone from context even though the marker on disk is not.
  assert.equal(armReminder(proj, sid), true);
  assert.equal(isArmed(proj, sid), true);
  assert.equal(mayRemind(proj, sid), true, "re-armed");
  assert.equal(electEmitter(proj, sid), true, "firing 2");
  assert.equal(isArmed(proj, sid), false, "the winner consumes the arming");
  assert.equal(firedCount(proj, sid), 2);

  // Second compaction: arming still succeeds, but the cap holds.
  assert.equal(armReminder(proj, sid), true);
  assert.equal(mayRemind(proj, sid), false, "cap reached — arming cannot lift it");
  assert.equal(electEmitter(proj, sid), false, "no third firing, ever");
  assert.equal(firedCount(proj, sid), 2);
});

test("the cap is reachable at all — the defect the earlier design had (contract 12)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-reach";
  // Under the rejected design, compaction CLEARED fired-*, so the directory
  // never held two and the cap state was unreachable: one firing per compaction
  // cycle, unbounded. Here two compactions are enough to exhaust it.
  electEmitter(proj, sid);
  armReminder(proj, sid); electEmitter(proj, sid);
  armReminder(proj, sid); electEmitter(proj, sid);
  armReminder(proj, sid); electEmitter(proj, sid);
  assert.equal(firedCount(proj, sid), 2, "four compactions still yield two firings");
});

test("armReminder is idempotent — arming twice is not two permissions (contract 16)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-arm";
  electEmitter(proj, sid);
  assert.equal(armReminder(proj, sid), true);
  assert.equal(armReminder(proj, sid), false, "already armed");
  assert.equal(electEmitter(proj, sid), true);
  assert.equal(electEmitter(proj, sid), false, "one arming buys one firing");
});

test("election state is disjoint from the score (contracts 2, 12)", () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-disjoint";
  registerSourcePath(proj, sid, join(proj, "a.mjs"));
  registerSourcePath(proj, sid, join(proj, "b.mjs"));
  electEmitter(proj, sid);
  armReminder(proj, sid);
  writeOpenStoryCache(proj, sid, false);
  assert.equal(entryScore(proj, sid), 2,
    "markers and the cached verdict live in a sibling directory and are never counted as paths");
  assert.notEqual(scoreDir(proj, sid), markerDir(proj, sid));
});

test("racing: real parallel processes — one emitter, exact count, pointer intact (contracts 2, 9, 12)", async () => {
  const { proj } = seedEntryFixture();
  const sid = "sess-parallel";
  const lib = fileURLToPath(new URL("../scripts/lib.mjs", import.meta.url));

  // Seed the ADR-006 pointer the way a real session would, then let N processes
  // hammer the score and the election at the same instant. The pointer must
  // survive: keeping this state out of writeSessionState is what stops its
  // read-modify-write from erasing active_epic/active_story under this load.
  writeSessionStateTest(proj, sid, { active_epic: "PS-A", active_story: "story-x" });

  const N = 12;
  const startAt = Date.now() + 500; // shared barrier — process startup jitter
                                    // alone would serialize them and prove nothing
  const src = `
    import { registerSourcePath, electEmitter } from ${JSON.stringify(lib)};
    const [proj, sid, i, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    const won = electEmitter(proj, sid);
    for (let k = 0; k < 8; k++) registerSourcePath(proj, sid, proj + "/f" + k + ".mjs");
    registerSourcePath(proj, sid, proj + "/uniq" + i + ".mjs");
    process.stdout.write(won ? "WON" : "lost");
  `;
  const runs = Array.from({ length: N }, (_, i) =>
    new Promise((resolve) => {
      const cp = spawn(
        process.execPath,
        ["--input-type=module", "-e", src, proj, sid, String(i), String(startAt)],
        { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      cp.stdout.on("data", (d) => { out += d; });
      cp.on("close", () => resolve(out));
    }));
  const results = await Promise.all(runs);

  assert.equal(results.filter((r) => r === "WON").length, 1,
    `exactly one process may emit, got ${JSON.stringify(results)}`);
  assert.equal(firedCount(proj, sid), 1, "and exactly one marker exists");
  assert.equal(entryScore(proj, sid), 8 + N,
    "every distinct path counted once — no increment lost to a concurrent writer");

  const st = JSON.parse(readFileSync(join(stateDirOf(proj), `${sid}.json`), "utf8"));
  assert.equal(st.active_epic, "PS-A", "ADR-006 pointer survived the storm");
  assert.equal(st.active_story, "story-x");
});

test("checkWorkWithoutStory: fires on dirty tree with no open story, silent otherwise (contract 18)", async () => {
  const { checkWorkWithoutStory } = await import("../scripts/doctor.mjs");
  const root = mkdtempSync(join(tmpdir(), "ps-wws-"));
  const proj = join(root, "proj");
  const vault = join(root, "vault");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(vault, "epics", "PS-A", "stories"), { recursive: true });
  const cfg = { vault_path: vault };
  const story = (name, status) =>
    writeFileSync(join(vault, "epics", "PS-A", "stories", name),
      `---\ntype: story\nstatus: ${status}\n---\n\n# s\n`, "utf8");

  const prevProj = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    // Not a git repository at all → cannot tell → no finding, not an error.
    story("story-a.md", "planned");
    assert.deepEqual(checkWorkWithoutStory(cfg, proj), [], "a non-repository yields nothing");

    spawnSync("git", ["init", "-q"], { cwd: proj });
    spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: proj });
    spawnSync("git", ["config", "user.name", "t"], { cwd: proj });
    assert.deepEqual(checkWorkWithoutStory(cfg, proj), [], "a clean tree yields nothing");

    writeFileSync(join(proj, "a.mjs"), "// work\n", "utf8");
    const fired = checkWorkWithoutStory(cfg, proj);
    assert.equal(fired.length, 1, "dirty tree + no story in progress");
    assert.equal(fired[0].level, "warn", "never issue — spikes legitimately look like this");
    assert.equal(fired[0].check, "work-without-story");
    assert.ok(/no reminder fired|No entry reminder/i.test(fired[0].message),
      "the finding says whether the prompt was ever delivered, and on which machine");

    story("story-b.md", "in-progress");
    assert.deepEqual(checkWorkWithoutStory(cfg, proj), [],
      "the same predicate as the hook: in-progress means the work is tracked");

    // An unreadable vault must not read as clean.
    const unreadable = join(vault, "epics", "PS-A", "stories", "story-c.md");
    writeFileSync(unreadable, "---\nstatus: planned\n---\n", "utf8");
    writeFileSync(join(vault, "epics", "PS-A", "stories", "story-b.md"),
      "---\ntype: story\nstatus: planned\n---\n", "utf8");
    spawnSync("chmod", ["000", unreadable]);
    const inconclusive = checkWorkWithoutStory(cfg, proj);
    spawnSync("chmod", ["644", unreadable]);
    if (inconclusive.length) {
      assert.match(inconclusive[0].message, /inconclusive rather than clean/,
        "a diagnostic that cannot read must say so, not go quiet");
    }
  } finally {
    if (prevProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProj;
  }
});

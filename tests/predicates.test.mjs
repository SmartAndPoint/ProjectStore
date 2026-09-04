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
  sessionNameOffer,
  appendEntryLog,
  readEntryLog,
  ANCHOR_SETTLE,
  ANCHOR_MARGIN,
  anchorKeyOf,
  emptyAnchorState,
  foldAnchor,
  composeAnchorName,
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
  renderStatusLineLauncher,
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
  // Derived from the layout, not hardcoded: the roster is the source of truth
  // and this test must grow with it instead of contradicting it.
  const roster = loadLayout("engineering").agents;
  for (const n of roster) {
    writeFileSync(join(proj, ".claude", "agents", `${n}.md`), agentFile(n, { marker: ver }));
  }
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, roster.length);
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
  const src = renderStatusLineLauncher(readFileSync(LAUNCHER_TEMPLATE, "utf8"), fallbackRoot);
  assert.ok(src, "the launcher template carries every placeholder the renderer fills");
  writeFileSync(p, src);
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

// ─── The SessionStart navigation skeleton: the pure render ─────────────
// (spec: the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized)
//
// renderVaultSkeleton is pure, so every bound, every fallback and the O(1)
// property are reachable here with no filesystem and no timing.

import {
  renderVaultSkeleton,
  folderPurpose,
  truncEnd,
  truncFront,
  PURPOSE_CELL,
  TITLE_CELL,
  PATH_CELL,
} from "../scripts/lib.mjs";

function factsFor({ folders, inFlight, ...rest } = {}) {
  return {
    vaultPath: "/v",
    layoutName: "engineering",
    language: "en",
    specPolicy: "optional",
    lifecycleGates: "on",
    kanbanFile: "kanban.md",
    adrIndex: "adr/README.md",
    epicFile: "epics/<EPIC>/epic.md",
    folders: folders || [
      { path: "adr", kind: "adr", counts: { artifacts: 3 }, readme: "# ADRs\n\nDecisions with context.\n\n## Index\n" },
      { path: "epics", kind: "epic", counts: { epics: 2, stories: 7 }, readme: "# Epics\n\nEpics and stories.\n" },
    ],
    inFlight: inFlight || { status: "ok", entries: [], total: 0 },
    ...rest,
  };
}

test("skeleton contract 2: the payload is O(1) in vault size, decided by a diff", () => {
  // Two vaults sharing one layout: one near-empty, one with >=200 artifacts
  // across every folder and more than five stories in progress.
  const mkFolders = (n) => [
    { path: "adr", kind: "adr", counts: { artifacts: n }, readme: "# ADRs\n\nDecisions with context.\n" },
    { path: "specs", kind: "spec", counts: { artifacts: n }, readme: "# Specs\n\nNormative how.\n" },
    { path: "epics", kind: "epic", counts: { epics: n, stories: n * 4 }, readme: "# Epics\n\nEpics and stories.\n" },
    { path: "research", kind: "research", counts: { artifacts: n }, readme: "# Research\n\nSpikes.\n" },
  ];
  const small = renderVaultSkeleton(factsFor({
    folders: mkFolders(0),
    inFlight: { status: "ok", entries: [], total: 0 },
  }));
  const large = renderVaultSkeleton(factsFor({
    folders: mkFolders(50),
    inFlight: {
      status: "ok",
      total: 40,
      entries: Array.from({ length: 9 }, (_, i) => ({ epic: `PS-${i}`, title: `story number ${i}` })),
    },
  }));

  // Mask exactly what the spec allows to differ: digit runs, the capped
  // in-flight lines, and the "and N more" marker.
  const mask = (s) => s
    .split("\n")
    .filter((l) => !/^- (PS-|nothing in progress|…and )/.test(l))
    .join("\n")
    .replace(/\d+/g, "#");
  assert.equal(mask(large), mask(small),
    "a renderer leaking even two characters per artifact fails here, while " +
    "'under the cap for a vault this size' would have passed it");
});

test("skeleton contract 4: every layout folder gets a row, none is a literal", () => {
  const folders = [
    { path: "adr", kind: "adr", counts: { artifacts: 1 }, readme: null },
    { path: "specs", kind: "spec", counts: { artifacts: 2 }, readme: null },
    { path: "runbooks", kind: "runbook", counts: { artifacts: 3 }, readme: null },
  ];
  const out = renderVaultSkeleton(factsFor({ folders }));
  for (const f of folders) {
    assert.ok(out.includes(`\`${f.path}/\``), `${f.path} must appear — rows come from the layout`);
  }
  // A layout that gains a kind gains a row, with no renderer change.
  const grown = renderVaultSkeleton(factsFor({
    folders: [...folders, { path: "decisions", kind: "decision", counts: { artifacts: 9 }, readme: null }],
  }));
  assert.ok(grown.includes("`decisions/`"), "a new layout kind appears without touching the renderer");
});

test("skeleton contract 5: counts are per folder, and epics report stories separately", () => {
  const out = renderVaultSkeleton(factsFor({
    folders: [
      { path: "epics", kind: "epic", counts: { epics: 5, stories: 48 }, readme: null },
      { path: "adr", kind: "adr", counts: { artifacts: 12 }, readme: null },
    ],
  }));
  assert.ok(/\| 5 epics · 48 stories \|/.test(out), "epics and stories are separate counts");
  assert.ok(/\| 12 \|/.test(out), "a plain folder reports one number");
});

test("skeleton contract 6: purpose is the README's own prose, with named fallbacks", () => {
  assert.equal(folderPurpose("# ADRs\n\nDecisions with context.\n\n## Index\n| a |\n", "adr"),
    "Decisions with context.", "prose above the first ## heading, headings dropped");
  assert.equal(folderPurpose("## Index\n\nrows\n", "adr"), "adr",
    "a README opening with ## at byte 0 has no preamble — the kind, never a blank");
  assert.equal(folderPurpose(null, "research"), "research", "missing README yields the kind");
  assert.equal(folderPurpose("", "ops"), "ops", "empty README yields the kind");
  assert.equal(folderPurpose("# T\n\nA | B\n", "adr"), "A \\| B", "pipes are escaped for the cell");

  const long = folderPurpose("# T\n\n" + "x".repeat(400) + "\n", "adr");
  assert.equal(long.length, PURPOSE_CELL, "truncated to the cell, ellipsis included");
  assert.ok(long.endsWith("…"));

  // A `\|` sliced in half would leave a stray backslash and un-escape the pipe.
  const escaped = folderPurpose("# T\n\n" + "y".repeat(PURPOSE_CELL - 2) + "|tail\n", "adr");
  assert.ok(!/\\…$/.test(escaped), "truncation never orphans a cell escape");
});

test("skeleton contract 7: the payload carries no artifact content", () => {
  const out = renderVaultSkeleton(factsFor());
  const re = indexHeaderRe();
  for (const line of out.split("\n")) {
    assert.ok(!re.test(line), `payload must not carry an index table: ${line}`);
  }
  assert.ok(!/code_refs/.test(out), "no code_refs");
});

test("skeleton contracts 8, 11: the graph is taught by path, with its prohibition and the staleness clause", () => {
  const flat = renderVaultSkeleton(factsFor()).replace(/\s+/g, " ");
  assert.ok(/grep '<vault-relative-path>' graph\.md/.test(flat), "the recipe greps a path");
  assert.ok(/never read whole/.test(flat), "the prohibition renders alongside it");
  assert.ok(/a bare slug is not a key/.test(flat), "and says why a slug is not a substitute");
  assert.ok(/regenerated/.test(flat) && /never hand-edited/.test(flat) && /source of truth/.test(flat),
    "derived views can lag, are not hand-edited, and lose to the artifact");
});

test("skeleton contract 9: all five descent steps render, including the one that fires on deciding", () => {
  const flat = renderVaultSkeleton(factsFor()).replace(/\s+/g, " ");
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(new RegExp(`${n}\\. \\*\\*`).test(flat), `step ${n} renders`);
  }
  assert.ok(/Before authoring an ADR or spec, or making an architectural choice — read `adr\/README\.md`/.test(flat),
    "step 4 fires on deciding, not on searching — it is the answer to dropping the dump");
  assert.ok(/fires on \*deciding\*, not on searching/.test(flat));
});

test("skeleton contract 10: the header carries policy, and absent config renders the documented defaults", () => {
  const withPolicy = renderVaultSkeleton(factsFor({ specPolicy: "required", lifecycleGates: "off" }));
  assert.ok(/spec_policy: required/.test(withPolicy) && /lifecycle_gates: off/.test(withPolicy));
  const bare = renderVaultSkeleton({ vaultPath: "/v", layoutName: "engineering", kanbanFile: "kanban.md" });
  assert.ok(/spec_policy: optional/.test(bare), "documented default, not a blank");
  assert.ok(/lifecycle_gates: on/.test(bare), "documented default, not a blank");
});

test("skeleton contracts 1, 15: in-flight is capped, ordered as given, and never renders an empty list as a claim", () => {
  const many = renderVaultSkeleton(factsFor({
    inFlight: {
      status: "ok", total: 12,
      entries: Array.from({ length: 12 }, (_, i) => ({ epic: "PS-A", title: `t${i}` })),
    },
  }));
  assert.equal((many.match(/^- PS-A · /gm) || []).length, 5, "capped at five");
  assert.ok(/…and 7 more; see `kanban\.md`/.test(many), "and the remainder is named, not dropped silently");

  const longTitle = renderVaultSkeleton(factsFor({
    inFlight: { status: "ok", total: 1, entries: [{ epic: "PS-A", title: "z".repeat(200) }] },
  }));
  const titleLine = longTitle.split("\n").find((l) => l.startsWith("- PS-A · "));
  assert.equal(titleLine.slice("- PS-A · ".length).length, TITLE_CELL, "title truncated to its cell");

  const empty = renderVaultSkeleton(factsFor());
  assert.ok(/- nothing in progress/.test(empty), "empty renders its own line");
  const expired = renderVaultSkeleton(factsFor({ inFlight: { status: "timeout" } }));
  assert.ok(/not resolved within budget/.test(expired), "expiry says so");
  assert.ok(!/nothing in progress/.test(expired),
    "an empty list claims the vault is idle; an expired budget claims only that we did not find out");
});

test("skeleton contract 1: the cell truncators mark themselves and count the mark", () => {
  assert.equal(truncEnd("abcdef", 4), "abc…");
  assert.equal(truncEnd("abc", 4), "abc", "under the cap is untouched");
  assert.equal(truncFront("abcdef", 4), "…def", "a path keeps its tail — the discriminating half");
  assert.equal(truncFront("x".repeat(PATH_CELL + 50), PATH_CELL).length, PATH_CELL);
});

// ─── The in-flight resolver: one question, one implementation ──────────
// (spec contracts 20, 24)
//
// Landed with no callers on purpose. Both hooks would pass their own drives on
// a depth-blind substring match, so the anchoring is pinned here, where a wrong
// answer is visible, rather than there, where it is merely plausible.

import {
  resolveInFlightArtifact,
  isWriteTool,
  WRITE_TOOLS,
  writeSession,
  ensureSessionsDir,
  sessionFilePath,
} from "../scripts/lib.mjs";

const VAULT = "/vault";
const LAYOUT = { folders: [{ path: "adr" }, { path: "specs" }, { path: "epics" }] };

// The log is newest-first, as appendActivity leaves it.
function log(...entries) {
  return entries.map(([path, tool]) => ({ path, tool, at: "2026-08-17T00:00:00.000Z" }));
}

test("resolver contract 20: the newest write-family entry wins, reads are not writes", () => {
  const activity = log(
    ["/vault/adr/newest.md", "Read"],
    ["/vault/specs/second.md", "Edit"],
    ["/vault/adr/third.md", "Write"],
  );
  assert.equal(resolveInFlightArtifact(activity, LAYOUT, VAULT), "specs/second.md",
    "a Read of a vault file is not evidence of authoring it");
});

test("resolver contract 20: every tool in the write family resolves, and only those", () => {
  // Named literally, because the loop below iterates WRITE_TOOLS and therefore
  // shrinks with it — a narrowed constant would pass its own test.
  assert.deepEqual([...WRITE_TOOLS].sort(), ["Edit", "MultiEdit", "NotebookEdit", "Write"]);
  for (const tool of WRITE_TOOLS) {
    assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", tool]), LAYOUT, VAULT),
      "adr/x.md", `${tool} writes and must resolve`);
    assert.ok(isWriteTool(tool));
  }
  for (const tool of ["Read", "Grep", "Glob", "Bash", "Task"]) {
    assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", tool]), LAYOUT, VAULT), null);
    assert.ok(!isWriteTool(tool));
  }
});

test("resolver contract 20: the match is vault-anchored, not a substring", () => {
  // A folder name occurring at depth is the case a substring match gets wrong,
  // and it is not exotic: `notes/adr/` is a plausible vault subfolder.
  assert.equal(resolveInFlightArtifact(log(["/vault/notes/adr/x.md", "Edit"]), LAYOUT, VAULT), null,
    "notes/adr/x.md is not an ADR — its anchor is `notes`, which is not a layout folder");
  // Same folder name, outside the vault entirely.
  assert.equal(resolveInFlightArtifact(log(["/elsewhere/adr/x.md", "Edit"]), LAYOUT, VAULT), null);
  // A file at the vault root belongs to no folder.
  assert.equal(resolveInFlightArtifact(log(["/vault/kanban.md", "Edit"]), LAYOUT, VAULT), null);
  // A sibling directory that merely starts with a folder name.
  assert.equal(resolveInFlightArtifact(log(["/vault/adrs/x.md", "Edit"]), LAYOUT, VAULT), null,
    "`adrs/` is not `adr/` — the separator is part of the anchor");
  // The folder itself, exactly, is a legitimate match.
  assert.equal(resolveInFlightArtifact(log(["/vault/adr", "Write"]), LAYOUT, VAULT), "adr");
});

test("resolver contract 24: the return is vault-relative, and a trailing slash on the root is tolerated", () => {
  const activity = log(["/vault/epics/PS-X/stories/story-y.md", "Edit"]);
  assert.equal(resolveInFlightArtifact(activity, LAYOUT, VAULT), "epics/PS-X/stories/story-y.md");
  assert.equal(resolveInFlightArtifact(activity, LAYOUT, "/vault/"), "epics/PS-X/stories/story-y.md",
    "relativizing twice is how the two callers would drift; there is one place that does it");
});

test("resolver contract 20: folders come from the layout, never from a hard-coded set", () => {
  // A layout with none of engineering's folder names. A resolver carrying the
  // engineering alternation — the defect being moved away from — answers null
  // here and resolves `adr/` below; this asserts the exact opposite pairing.
  const other = { folders: [{ path: "decisions" }, { path: "notebooks" }] };
  assert.equal(resolveInFlightArtifact(log(["/vault/decisions/d1.md", "Write"]), other, VAULT),
    "decisions/d1.md");
  assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", "Write"]), other, VAULT), null,
    "`adr` is not a folder of THIS layout");
  // And the real thing, loaded rather than transcribed.
  const eng = loadLayout("engineering");
  assert.equal(resolveInFlightArtifact(log(["/vault/ops/runbook.md", "Write"]), eng, VAULT),
    "ops/runbook.md");
});

test("resolver: degenerate input yields null, never a throw", () => {
  for (const bad of [null, undefined, "not an array", 42, {}]) {
    assert.equal(resolveInFlightArtifact(bad, LAYOUT, VAULT), null);
  }
  assert.equal(resolveInFlightArtifact([], LAYOUT, VAULT), null);
  assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", "Write"]), LAYOUT, null), null);
  assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", "Write"]), null, VAULT), null);
  assert.equal(resolveInFlightArtifact(log(["/vault/adr/x.md", "Write"]), { folders: [] }, VAULT), null);
  // Entries the log should never hold, but might after a hand-edit.
  assert.equal(resolveInFlightArtifact([null, { tool: "Write" }, { path: "/vault/adr/x.md" }], LAYOUT, VAULT), null);
});

test("resolver contract 20: hooks.json's PostToolUse matcher lists exactly the write family", () => {
  // The third copy, which cannot import. If it ever narrows, the log stops
  // recording a tool the resolver still expects — the NotebookEdit defect in
  // reverse, and silent in both directions.
  const hooks = JSON.parse(
    readFileSync(fileURLToPath(new URL("../hooks/hooks.json", import.meta.url)), "utf8"));
  const matchers = JSON.stringify(hooks).match(/"matcher":\s*"([^"]*Edit[^"]*)"/g) || [];
  assert.ok(matchers.length > 0, "expected at least one write-tool matcher");
  for (const m of matchers) {
    const alts = m.match(/"matcher":\s*"([^"]*)"/)[1].split("|").sort();
    assert.deepEqual(alts, [...WRITE_TOOLS].sort(),
      `matcher ${m} disagrees with WRITE_TOOLS — writer and reader must record the same set`);
  }
});

// ─── gatherVaultFacts: one deadline, three families, named degradations ─
// (spec contracts 5, 13, 14, 15, 19, 21)
//
// The `readFile` seam is what makes the budget testable without a slow disk: a
// reader that never resolves is exactly an iCloud-evicted file, and it is the
// only honest way to assert that the timer gets a turn.

import { gatherVaultFacts } from "../scripts/lib.mjs";

const NEVER = () => new Promise(() => {});

function mkVault({ stories = [], activity = null, sessionId = "s1", readmes = {} } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "ps-facts-"));
  for (const f of ["adr", "specs", "epics", "research", "concepts", "meetings", "ops", "diagrams"]) {
    mkdirSync(join(vault, f), { recursive: true });
    writeFileSync(join(vault, f, "README.md"), readmes[f] ?? `# ${f}\n\nThe ${f} folder.\n\n## Index\n`);
  }
  for (const s of stories) {
    const dir = join(vault, "epics", s.epic, "stories");
    mkdirSync(dir, { recursive: true });
    // Contract 5 defines an epic as a subdirectory containing `epic.md`. An
    // earlier fixture omitted it and asserted the count anyway, which locked in
    // the "every subdirectory is an epic" reading the contract forbids.
    writeFileSync(join(vault, "epics", s.epic, "epic.md"),
      `---\ntype: epic\nid: "${s.epic}"\nstatus: in-progress\n---\n\n# ${s.epic}\n`);
    writeFileSync(join(dir, `${s.slug}.md`),
      `---\ntype: story\nstatus: ${s.status}\ntitle: "${s.title}"\nstarted_at: "${s.startedAt || ""}"\n---\n\n# ${s.title}\n`);
  }
  if (activity) {
    mkdirSync(join(vault, ".projectstore", "sessions"), { recursive: true });
    writeFileSync(join(vault, ".projectstore", "sessions", `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, recent_activity: activity }, null, 2));
  }
  return vault;
}

const cfgFor = (vault) => ({ vault_path: vault, layout: "engineering", language: "en" });

test("gather contract 13: an unresolvable read expires the budget and every family says so by name", async () => {
  // A story must exist, or the in-flight scan finishes instantly with nothing
  // to read and reports "ok" — correctly, and while testing nothing.
  const vault = mkVault({
    activity: [],
    stories: [{ epic: "E1", slug: "story-a", title: "A", status: "in-progress", startedAt: "2026-08-01" }],
  });
  const t0 = Date.now();
  const facts = await gatherVaultFacts(cfgFor(vault), {
    sessionId: "s1", source: "compact", budgetMs: 30, readFile: NEVER,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `gather must return on the timer, took ${elapsed}ms`);
  assert.equal(facts.inFlight.status, "timeout");
  assert.equal(facts.continuity.status, "timeout");
  assert.ok(facts.folders.every((f) => f.readme === null), "unread READMEs fall back, they do not hang");
  // The named line, not an empty list — an empty list asserts the vault is idle.
  const out = renderVaultSkeleton(facts);
  assert.ok(/not resolved within budget/.test(out));
  assert.ok(!/nothing in progress/.test(out));
  // And the purposes degrade to the folder kind (contract 6), never to blanks.
  assert.ok(/\| `adr\/` \| adr \| \d+ \| adr \|/.test(out), out.split("\n").find((l) => l.startsWith("| `adr/`")));
});

test("gather contract 13: a family that finished before expiry keeps its result", async () => {
  const vault = mkVault({
    stories: [{ epic: "E1", slug: "story-a", title: "A", status: "in-progress", startedAt: "2026-08-01" }],
  });
  // READMEs resolve; anything under epics/ hangs. Partial is the normal outcome.
  const readFile = (p) => (p.includes("/epics/") ? NEVER() : readFileSync(p, "utf8"));
  const facts = await gatherVaultFacts(cfgFor(vault), { source: "startup", budgetMs: 30, readFile });
  assert.equal(facts.inFlight.status, "timeout", "the scan that hung degrades");
  assert.ok(facts.folders.find((f) => f.path === "adr").readme.includes("The adr folder"),
    "the family that landed keeps what it read");
});

test("gather contract 19: continuity facts exist on compact alone, and need a session id", async () => {
  const vault = mkVault({ activity: [] });
  const read = (p) => readFileSync(p, "utf8");
  for (const source of ["startup", "resume", "clear", "fork", "some-future-value", undefined, null]) {
    const facts = await gatherVaultFacts(cfgFor(vault), { sessionId: "s1", source, budgetMs: 500, readFile: read });
    assert.equal(facts.continuity, null, `source ${String(source)} must not gather continuity`);
  }
  const onCompact = await gatherVaultFacts(cfgFor(vault), { sessionId: "s1", source: "compact", budgetMs: 500, readFile: read });
  assert.ok(onCompact.continuity, "compact gathers it");
  // Contract 21: stdin can parse carrying a source and no id.
  const noId = await gatherVaultFacts(cfgFor(vault), { sessionId: null, source: "compact", budgetMs: 500, readFile: read });
  assert.equal(noId.continuity, null, "no session id, no log to read");
});

test("gather contracts 20, 21: continuity carries vault-relative paths and the shared resolver's answer", async () => {
  const vault = mkVault({
    activity: [
      { path: "/somewhere/else/src/app.ts", tool: "Edit" },
      { path: "", tool: "Edit" },
      { path: "@@VAULT@@/adr/decision.md", tool: "Read" },
      { path: "@@VAULT@@/epics/E1/stories/story-a.md", tool: "Edit" },
    ],
  });
  // Rewrite the placeholder now that the vault path exists.
  const sp = join(vault, ".projectstore", "sessions", "s1.json");
  writeFileSync(sp, readFileSync(sp, "utf8").replaceAll("@@VAULT@@", vault));
  const facts = await gatherVaultFacts(cfgFor(vault), {
    sessionId: "s1", source: "compact", budgetMs: 500, readFile: (p) => readFileSync(p, "utf8"),
  });
  assert.deepEqual(facts.continuity.paths, ["adr/decision.md", "epics/E1/stories/story-a.md"],
    "out-of-vault and empty entries are dropped; the rest are relative");
  assert.equal(facts.continuity.total, 2);
  assert.equal(facts.continuity.artifact, "epics/E1/stories/story-a.md",
    "the Read of the ADR is not evidence of authoring it");
});

test("gather contracts 5, 15: counts are per folder and in-flight is newest-started first", async () => {
  const vault = mkVault({
    stories: [
      { epic: "E1", slug: "story-old", title: "Old", status: "in-progress", startedAt: "2026-08-01T00:00:00Z" },
      { epic: "E1", slug: "story-done", title: "Done", status: "done", startedAt: "2026-08-09T00:00:00Z" },
      { epic: "E2", slug: "story-new", title: "New", status: "in-progress", startedAt: "2026-08-05T00:00:00Z" },
    ],
  });
  writeFileSync(join(vault, "adr", "ADR-001-x.md"), "---\ntype: adr\n---\n");
  writeFileSync(join(vault, "adr", "ADR-002-y.md"), "---\ntype: adr\n---\n");
  const facts = await gatherVaultFacts(cfgFor(vault), {
    source: "startup", budgetMs: 2000, readFile: (p) => readFileSync(p, "utf8"),
  });
  const adr = facts.folders.find((f) => f.path === "adr");
  assert.deepEqual(adr.counts, { artifacts: 2 }, "README.md is not an artifact");
  const epics = facts.folders.find((f) => f.path === "epics");
  assert.deepEqual(epics.counts, { epics: 2, stories: 3 }, "the epic folder reports both, and counts done stories too");
  // Contract 5 — a subdirectory without `epic.md` is not an epic. On a vault
  // where every subdirectory happens to be a real epic the two definitions
  // agree, which is exactly how the wrong one survives review.
  // The fixture must be DISCRIMINATING: an empty scratch folder passes whether
  // the epic.md gate sits in front of one counter or both. A scratch folder
  // holding an in-progress story tells those two apart — and contract 5's
  // second clause says stories come from the shared walker regardless.
  mkdirSync(join(vault, "epics", "scratch-notes", "stories"), { recursive: true });
  writeFileSync(join(vault, "epics", "scratch-notes", "stories", "story-orphan.md"),
    `---\ntype: story\nstatus: in-progress\ntitle: "Orphan"\nstarted_at: "2026-08-09T00:00:00Z"\n---\n`);
  const again = await gatherVaultFacts(cfgFor(vault), {
    source: "startup", budgetMs: 2000, readFile: (p) => readFileSync(p, "utf8"),
  });
  assert.deepEqual(again.folders.find((f) => f.path === "epics").counts, { epics: 2, stories: 4 },
    "a scratch folder is not an epic, but its story is still a story — the count " +
    "and the walker must not disagree about the same vault three lines apart");
  assert.ok(again.inFlight.entries.some((e) => e.title === "Orphan"),
    "and the walker did list it, which is what makes the count above checkable");
  assert.deepEqual(facts.inFlight.entries.map((e) => e.title), ["New", "Old"],
    "most recently started first — unstated, the cap favours whichever epic sorts first");
  assert.deepEqual(facts.inFlight.entries.map((e) => e.epic), ["E2", "E1"]);
  assert.equal(facts.inFlight.total, 2);
  assert.equal(facts.inFlight.status, "ok");
});

test("gather contract 6: a folder purpose falls back to its kind, never to a blank cell", async () => {
  const vault = mkVault({ readmes: { research: "## Index\n\n| File |\n" } });
  const facts = await gatherVaultFacts(cfgFor(vault), {
    source: "startup", budgetMs: 2000, readFile: (p) => readFileSync(p, "utf8"),
  });
  const out = renderVaultSkeleton(facts);
  assert.ok(/\| `research\/` \| research \| \d+ \| research \|/.test(out),
    "a README that opens with `## ` has no preamble to quote");
});

// ── Review follow-ups (second pass) ───────────────────────────────────

test("gather contract 21: a continuity timeout renders its OWN named line", async () => {
  const vault = mkVault({
    activity: [],
    stories: [{ epic: "E1", slug: "story-a", title: "A", status: "in-progress", startedAt: "2026-08-01" }],
  });
  // Only the session file hangs. With the in-flight family ALSO timing out, its
  // near-identical "in-flight work not resolved within budget" line stands in
  // for this assertion and the continuity branch can render nothing at all.
  const readFile = (p) =>
    p.includes("/.projectstore/sessions/") ? new Promise(() => {}) : readFileSync(p, "utf8");
  const facts = await gatherVaultFacts(cfgFor(vault), {
    sessionId: "s1", source: "compact", budgetMs: 40, readFile,
  });
  assert.equal(facts.inFlight.status, "ok", "the fixture must not let the sibling line cover for it");
  assert.equal(facts.continuity.status, "timeout");
  const out = renderVaultSkeleton(facts);
  assert.ok(out.includes("Where this session left off"), "the heading renders");
  assert.ok(out.includes("recent activity not resolved within budget"),
    "the literal contract 21 names — the timer knows it expired, so silence discards information");
  assert.ok(!/in-flight work not resolved/.test(out),
    "and the two degradations must never render the same text");
});

test("writeSession preserves recent_activity and started_at across a re-registration", () => {
  // Pinned because it is the SOLE reason contract 23's reordering is inert: with
  // the exemption in place, gather-before-registration is unobservable only
  // while this holds. If it stops holding, the ordering becomes load-bearing
  // and the limitation recorded in the story turns false, silently.
  const vault = mkVault({});
  ensureSessionsDir(vault);
  const path = sessionFilePath(vault, "keepme");
  writeFileSync(path, JSON.stringify({
    id: "keepme",
    started_at: "2026-08-01T00:00:00.000Z",
    project_root: "/old",
    recent_activity: [{ path: join(vault, "adr", "x.md"), tool: "Edit", at: "2026-08-01T01:00:00.000Z" }],
  }));
  writeSession(vault, "keepme", "/new");
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after.started_at, "2026-08-01T00:00:00.000Z", "the original start time survives");
  assert.equal(after.recent_activity.length, 1, "and so does the activity log");
  assert.equal(after.project_root, "/new", "while the mutable field is refreshed");
});

// ─── Session-name anchor (ADR: the settled-anchor offer) ───────────────
//
// The fixtures are ANONYMISED shapes of nine recorded sessions, produced by the
// committed extractor beside them: cluster and leaf identities renumbered per
// session, folder kind kept, write/subagent flags kept, no artifact names. The
// extractor ships so the ADR's claim that its constants "can be re-measured by
// anyone who doubts them" is true of anyone's own sessions, not just of this
// frozen file.
//
// Read the first two drives for what they are: REGRESSION PINS. The constants
// were chosen on these very sessions, so they cannot fail except by someone
// changing the rule — which is their job, not validation. Every drive after
// them asserts something the fixtures did not decide.

const ANCHOR_FIXTURES = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/session-anchor-shapes.json", import.meta.url)), "utf8"));

// The shipping rule, replayed. The two gates are the CALLER's contract, and are
// applied here exactly as touch-session.mjs must apply them.
function replayAnchor(events, { reoffer = true, gates = true } = {}) {
  let st = emptyAnchorState();
  const offers = [];
  for (const [cluster, leaf, write, sub] of events) {
    if (gates && (!write || sub)) continue;
    const r = foldAnchor(st, { key: cluster, leaf });
    st = r.state;
    if (r.offer && (offers.length === 0 || reoffer)) offers.push(r.offer.name);
  }
  return offers;
}

// The rejected alternatives, so the ADR's comparison table is pinned in full
// rather than in the two rows the decision happens to use. Each is a rule over
// the same fixture, not a re-derivation of the shipping one.
function countAlternative(events, kind) {
  const w = events.filter(([, , write, sub]) => write && !sub);
  const pairKey = ([c, l]) => `${c}/${l || ""}`;
  let n = 0, prev = null, run = 0, cur = null, fired = null;
  for (const e of w) {
    if (kind === "every-pair") { const k = pairKey(e); if (k !== prev) { n++; prev = k; } }
    else if (kind === "cluster-only") { if (e[0] !== prev) { n++; prev = e[0]; } }
    else if (kind === "dwell-3" || kind === "dwell-5") {
      const need = kind === "dwell-3" ? 3 : 5;
      const k = pairKey(e);
      if (k === cur) run++; else { cur = k; run = 1; }
      if (run === need && k !== fired) { n++; fired = k; }
    }
  }
  if (kind === "once-per-session") n = w.length ? 1 : 0;
  return n;
}

test("anchor: regression pin — the recorded sessions fire 12 times, at most 2 each", () => {
  const per = ANCHOR_FIXTURES.map((s) => replayAnchor(s.events).length);
  assert.equal(per.reduce((a, b) => a + b, 0), 12, `per-session: ${per.join(" ")}`);
  assert.equal(Math.max(...per), 2);
  assert.equal(per.filter((n) => n === 1).length, 6, `per-session: ${per.join(" ")}`);
});

test("anchor: regression pin — every row of the ADR's comparison table", () => {
  const sum = (kind) => ANCHOR_FIXTURES.reduce((a, s) => a + countAlternative(s.events, kind), 0);
  const max = (kind) => Math.max(...ANCHOR_FIXTURES.map((s) => countAlternative(s.events, kind)));
  // The table is the ADR's whole argument for rejecting the alternatives; a row
  // nothing can check is a rejection nobody can audit.
  // Every row over the IDENTICAL gated event set. An earlier draft measured the
  // first rows over epic events only and the anchor rows over epics AND
  // documents, so the table compared rules on different data — invisible until
  // the harness was committed and had to agree with itself.
  assert.deepEqual([sum("every-pair"), max("every-pair")], [137, 37], "every artifact change");
  assert.deepEqual([sum("cluster-only"), max("cluster-only")], [111, 26], "cluster change only");
  assert.deepEqual([sum("dwell-3"), max("dwell-3")], [42, 14], "settled at 3 writes");
  assert.deepEqual([sum("dwell-5"), max("dwell-5")], [24, 6], "settled at 5 writes");
  assert.deepEqual([sum("once-per-session"), max("once-per-session")], [9, 1], "once per session");
  const no = ANCHOR_FIXTURES.map((s) => replayAnchor(s.events, { reoffer: false }).length);
  assert.deepEqual([no.reduce((a, b) => a + b, 0), Math.max(...no)], [9, 1], "settled anchor, no re-offer");
});

test("anchor: the constants are pinned by literal, because nothing else pins them", () => {
  // Both constants survived mutation while every drive stayed green: the
  // fixtures are INSENSITIVE to them in this range (settle 4 and margin 9
  // reproduce 12/max-2 exactly), and the boundary drive below used to build its
  // input FROM the constant, so the input moved with it. Same trap `WRITE_TOOLS`
  // fell into — a loop over a constant cannot notice the constant changing.
  assert.equal(ANCHOR_SETTLE, 5, "ADR: an anchor settles at five writes");
  assert.equal(ANCHOR_MARGIN, 10, "ADR: a challenger takes over at a ten-write lead");
});

test("anchor: the margin is a real threshold, not a rounding artifact", () => {
  const SETTLE = 5, MARGIN = 10;   // literals, not the constants — see above
  const settle = (key, n) => Array.from({ length: n }, () => ({ key, leaf: null }));
  const feed = (hits) => {
    let st = emptyAnchorState(); const offers = [];
    for (const h of hits) { const r = foldAnchor(st, h); st = r.state; if (r.offer) offers.push(r.offer.key); }
    return offers;
  };
  assert.deepEqual(feed(settle("epic:A", SETTLE)), ["epic:A"], "settles at the threshold");
  assert.deepEqual(feed(settle("epic:A", SETTLE - 1)), [], "and not before it");
  const short = feed([...settle("epic:A", 5), ...settle("epic:B", 5 + MARGIN - 1)]);
  assert.deepEqual(short, ["epic:A"], "a challenger one below the margin does not take over");
  const exact = feed([...settle("epic:A", 5), ...settle("epic:B", 5 + MARGIN)]);
  assert.deepEqual(exact, ["epic:A", "epic:B"], "at exactly the margin it does");
});

test("anchor: the same name is never offered twice running", () => {
  const n = (key, c) => Array.from({ length: c }, () => ({ key, leaf: null }));
  const feed = (hits) => {
    let st = emptyAnchorState(); const out = [];
    for (const h of hits) { const r = foldAnchor(st, h); st = r.state; if (r.offer) out.push(r.offer.name); }
    return out;
  };
  // Two documents sharing a basename across folders are different ANCHORS that
  // compose the same NAME. Offering it twice reads as a bug in the mechanism.
  assert.deepEqual(
    feed([...n("doc:research/session-name.md", 5), ...n("doc:specs/session-name.md", 15)]),
    ["session-name"], "a moved anchor that composes the same name is not re-offered");
  // But returning to an earlier anchor IS a new offer: the work genuinely moved
  // back, and a name that follows the work has to follow it home. Deliberate,
  // and the reason the suppression is "twice running" rather than "ever again".
  assert.deepEqual(
    feed([...n("epic:FOO", 5), ...n("epic:BAR", 15), ...n("epic:FOO", 30)]),
    ["foo", "bar", "foo"], "an A->B->A pivot re-offers the first name on purpose");
});

test("anchor: keys come from the layout, and the match is neither depth-blind nor a regex", () => {
  const L = { folders: [
    { path: "epics", kind: "epic" }, { path: "adr", kind: "adr", readme: true },
    { path: "specs", kind: "spec", readme: true }, { path: "research", kind: "research", readme: true }] };
  assert.deepEqual(anchorKeyOf("epics/PS-X/stories/story-foo-bar.md", L),
    { key: "epic:PS-X", id: "PS-X", leaf: "foo-bar" });
  assert.equal(anchorKeyOf("epics/PS-X/epic.md", L).leaf, null);
  assert.equal(anchorKeyOf("adr/a-decision.md", L).key, "doc:adr/a-decision.md");
  assert.equal(anchorKeyOf("notes/adr/x.md", L), null, "a folder name at depth is not that folder");
  assert.equal(anchorKeyOf("specs/sub/deep.md", L), null, "only files directly in the folder");
  assert.equal(anchorKeyOf("kanban.md", L), null);
  // A folder's generated index is not a document — it would compose "readme".
  assert.equal(anchorKeyOf("adr/README.md", L), null);
  // Renaming a folder in the layout moves the key with it...
  const L2 = { folders: [{ path: "decisions", kind: "adr" }] };
  assert.equal(anchorKeyOf("decisions/a.md", L2).key, "doc:decisions/a.md");
  assert.equal(anchorKeyOf("adr/a.md", L2), null);
  // ...and a layout path is DATA, never a pattern: an interpolated RegExp would
  // let `epics.old` match `epicsXold/`, silently anchoring the wrong vault.
  const L3 = { folders: [{ path: "epics.old", kind: "epic" }] };
  assert.equal(anchorKeyOf("epicsXold/E1/epic.md", L3), null);
  assert.equal(anchorKeyOf("epics.old/E1/epic.md", L3).key, "epic:E1");
});

test("anchor: composed names are typeable — kebab, capped, transliterated", () => {
  const settle = (key, leaf) => {
    let st = emptyAnchorState();
    for (let i = 0; i < 6; i++) st = foldAnchor(st, { key, leaf }).state;
    return st;
  };
  const long = "statusline-v2-per-session-resolver-never-blank-badge";
  const n = composeAnchorName(settle("epic:PS-AGENTS", long));
  assert.ok(n.length <= 48, `got ${n.length}: ${n}`);
  assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/, `not kebab: ${n}`);
  assert.ok(n.startsWith("ps-agents-"), n);
  const words = new Set(("ps-agents-" + long).split("-"));
  for (const w of n.split("-")) assert.ok(words.has(w), `truncated mid-word: ${w} in ${n}`);
  assert.equal(composeAnchorName(settle("doc:research/critic-economics.md", null)), "critic-economics");
  // A non-ASCII title used to compose null and burn the incumbent slot, leaving
  // the session permanently nameless. Four bundled locales make this ordinary.
  assert.equal(composeAnchorName(settle("doc:research/\u041a\u044d\u0448\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435-\u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432.md", null)),
    "keshirovanie-zaprosov");
  assert.equal(composeAnchorName(emptyAnchorState()), null, "no anchor, no name");
});

test("entry log: `kind` keeps two mechanisms from being counted as one", () => {
  const proj = mkdtempSync(join(tmpdir(), "ps-log-"));
  mkdirSync(join(proj, ".claude", ".projectstore"), { recursive: true });
  const at = new Date().toISOString();
  appendEntryLog(proj, { at, session_id: "s", score: 3 });                     // a reminder
  appendEntryLog(proj, { at, session_id: "s", kind: "name-offer", name: "x" }); // not one
  assert.equal(readEntryLog(proj).length, 2, "unfiltered still returns everything");
  assert.equal(readEntryLog(proj, { kind: null }).length, 1,
    "doctor's count must see the reminder alone — it renders it as 'an entry reminder fired N time(s)'");
  assert.equal(readEntryLog(proj, { kind: "name-offer" }).length, 1);
});

test("checkWorkWithoutStory: name-offer breadcrumbs are not counted as reminders delivered", async () => {
  // The finding renders the count as "an entry reminder fired N time(s) … so
  // the prompt was delivered and the work still went untracked". Two mechanisms
  // share entry-log.jsonl, so an unfiltered count turns that sentence into a
  // false claim about a prompt the person never saw.
  const { checkWorkWithoutStory } = await import("../scripts/doctor.mjs");
  const root = mkdtempSync(join(tmpdir(), "ps-wws-kind-"));
  const proj = join(root, "proj");
  const vault = join(root, "vault");
  mkdirSync(join(proj, ".claude", ".projectstore"), { recursive: true });
  mkdirSync(join(vault, "epics", "PS-A", "stories"), { recursive: true });
  writeFileSync(join(vault, "epics", "PS-A", "stories", "story-a.md"),
    "---\ntype: story\nstatus: planned\n---\n", "utf8");
  spawnSync("git", ["init", "-q"], { cwd: proj });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: proj });
  spawnSync("git", ["config", "user.name", "t"], { cwd: proj });
  writeFileSync(join(proj, "a.mjs"), "// work\n", "utf8");

  const at = new Date().toISOString();
  appendEntryLog(proj, { at, session_id: "s", kind: "name-offer", name: "x" });
  appendEntryLog(proj, { at, session_id: "s", kind: "name-offer", name: "y" });

  const prevProj = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    const fired = checkWorkWithoutStory({ vault_path: vault }, proj);
    assert.equal(fired.length, 1);
    assert.match(fired[0].message, /No entry reminder fired/i,
      `two name offers are not two reminders: ${fired[0].message}`);
    appendEntryLog(proj, { at, session_id: "s", score: 3 });
    const again = checkWorkWithoutStory({ vault_path: vault }, proj);
    assert.match(again[0].message, /fired 1 time\(s\)/,
      `one real reminder must count as exactly one: ${again[0].message}`);
  } finally {
    if (prevProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProj;
  }
});

test("session name: an offer never talks over the name the session already wears", () => {
  // Two suppressions with different reasons. Wearing the composed name already
  // makes the offer a no-op; wearing a DIFFERENT name the person chose makes it
  // an intrusion, and that one must survive every later anchor move.
  assert.equal(sessionNameOffer("ps-a-alpha", { current: "ps-a-alpha" }), null,
    "already wearing exactly this name");
  assert.deepEqual(sessionNameOffer("ps-a-alpha", { current: "my-own-thing", declined: ["my-own-thing"] }), null,
    "a name we did not compose is the person's, not a slot to overwrite");
  assert.deepEqual(sessionNameOffer("ps-a-alpha", { current: "ps-a-old", declined: [] }),
    { name: "ps-a-alpha", qualified: false },
    "a name WE composed earlier is ours to replace when the work moves");
  assert.deepEqual(sessionNameOffer("ps-a-alpha", { peers: [{ name: "ps-a-alpha" }] }),
    { name: "ps-a-alpha-2", qualified: true }, "a peer holds it — qualify rather than go silent");
  assert.equal(sessionNameOffer("ps-a-alpha",
    { peers: [{ name: "ps-a-alpha" }, { name: "ps-a-alpha-2" }, { name: "ps-a-alpha-3" }] }), null,
    "three collisions means the name does not discriminate; silence beats -4");
  assert.equal(sessionNameOffer(null, {}), null);
});

// ─── README claims are checkable, or they drift ────────────────────────
//
// Every version stamp and inventory count in the README has drifted at least
// once: a heading said v0.23 two releases later, and a status-line example
// quoted a version three releases old. Prose cannot be reconciled, so it gets
// asserted instead.

test("README: every version it quotes is the version that ships", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const version = JSON.parse(readFileSync(
    fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)), "utf8")).version;
  const marketplace = readFileSync(
    fileURLToPath(new URL("../.claude-plugin/marketplace.json", import.meta.url)), "utf8");
  assert.ok(marketplace.includes(`"${version}"`),
    "both manifests must carry the same version — a release with two answers has none");
  // A concrete version in prose is only ever an example of the status-line
  // badge; whatever it shows must be what a reader would actually see.
  for (const m of readme.matchAll(/PS#(\d+\.\d+\.\d+)/g)) {
    assert.equal(m[1], version,
      `README quotes PS#${m[1]} but this build is ${version}`);
  }
  // A version-stamped section heading is a promise to edit it every release,
  // and that promise has never been kept.
  const stamped = [...readme.matchAll(/^#{2,3} .*\(v\d+\.\d+\)/gm)].map((m) => m[0]);
  assert.deepEqual(stamped, [],
    `headings must not be version-stamped: ${JSON.stringify(stamped)}`);
});

test("README: the inventory counts what is actually in the tree", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const count = (rel, filter) => readdirSync(join(repo, rel)).filter(filter).length;
  const md = (f) => f.endsWith(".md");
  const hooks = new Set(Object.values(
    JSON.parse(readFileSync(join(repo, "hooks", "hooks.json"), "utf8")).hooks)
    .flat().flatMap((e) => (e.hooks || []).map((h) => h.command)));

  // The selling rewrite reduced the fact sheet to three counts; skills and
  // hooks are implementation detail the README no longer advertises. `hooks`
  // stays computed above so restoring the claim is a one-line diff here.
  void hooks;
  const claims = [
    [/\*\*(\d+) commands\*\*/, count("commands", md), "commands"],
    [/\*\*(\d+) agents\*\*/, count("agents", md), "agents"],
    // Directories only: templates/ also holds claude-md-block.md.tmpl, which is
    // not a language and briefly made this drive report the README as wrong.
    [/\*\*(\d+) languages\*\*/,
      readdirSync(join(repo, "templates"), { withFileTypes: true })
        .filter((d) => d.isDirectory()).length, "template languages"],
  ];
  for (const [re, actual, what] of claims) {
    const m = readme.match(re);
    assert.ok(m, `README no longer states a count for ${what} — update this drive or restore the claim`);
    assert.equal(Number(m[1]), actual, `README says ${m[1]} ${what}, tree has ${actual}`);
  }
});

// ─── PS-WT: worktree binding inheritance ───────────────────────────────
//
// A worktree of a bound checkout starts unbound because `.gitignore` ignores
// `.claude/`. These pin the three states the repair depends on, and the two
// shapes where we must refuse to guess.

function seedWorktreePair({ bindParent = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ps-wt-"));
  const main = join(root, "main");
  const child = join(root, "child");
  mkdirSync(main, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: main });
  spawnSync("git", ["config", "user.name", "t"], { cwd: main });
  writeFileSync(join(main, ".gitignore"), ".claude/\n", "utf8");
  writeFileSync(join(main, "f.md"), "hi\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: main });
  // `git worktree add` fails with "not a valid object name: 'HEAD'" on a repo
  // with no commits — the fixture must commit before it forks.
  spawnSync("git", ["commit", "-qm", "base"], { cwd: main });
  if (bindParent) {
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(join(main, ".claude", "projectstore.json"),
      JSON.stringify({ vault_path: join(root, "vault"), layout: "engineering" }, null, 2) + "\n", "utf8");
  }
  spawnSync("git", ["worktree", "add", "-q", child, "-b", "feat"], { cwd: main });
  return { root, main, child };
}

test("resolveBinding: a worktree of a bound checkout is inheritable", async () => {
  const { resolveBinding } = await import("../scripts/worktree.mjs");
  const { main, child, root } = seedWorktreePair();

  assert.equal(resolveBinding(main).state, "bound", "the parent itself is bound");

  const b = resolveBinding(child);
  assert.equal(b.state, "inheritable");
  assert.equal(b.worktree, true);
  assert.equal(b.vaultPath, join(root, "vault"), "it names the vault it would adopt");
  assert.ok(b.mainCheckout && existsSync(join(b.mainCheckout, ".claude", "projectstore.json")),
    "mainCheckout points at a real checkout carrying the config");
});

test("resolveBinding: it refuses to guess, and every branch returns every field", async () => {
  const { resolveBinding } = await import("../scripts/worktree.mjs");
  const KEYS = ["state", "worktree", "mainCheckout", "vaultPath"];

  const unboundParent = seedWorktreePair({ bindParent: false });
  const orphan = resolveBinding(unboundParent.child);
  assert.equal(orphan.state, "unbound", "a worktree of an unbound checkout offers nothing");
  assert.equal(orphan.worktree, true, "it is still a worktree — the reason differs from 'never bound'");

  const plain = mkdtempSync(join(tmpdir(), "ps-wt-plain-"));
  const notARepo = resolveBinding(plain);
  assert.equal(notARepo.state, "unbound");
  assert.equal(notARepo.worktree, false, "no repository, so no worktree claim");

  // The main checkout of an ordinary repo reports --git-common-dir as the
  // RELATIVE `.git`; comparing it to --git-dir must still classify correctly.
  const bare = mkdtempSync(join(tmpdir(), "ps-wt-main-"));
  spawnSync("git", ["init", "-q"], { cwd: bare });
  const mainUnbound = resolveBinding(bare);
  assert.equal(mainUnbound.state, "unbound");
  assert.equal(mainUnbound.worktree, false, "a main checkout is not a linked worktree");

  const bound = seedWorktreePair();
  for (const r of [resolveBinding(bound.main), resolveBinding(bound.child), orphan, notARepo, mainUnbound]) {
    assert.deepEqual(Object.keys(r).sort(), [...KEYS].sort(),
      "a caller reading a happy-path-only field throws, and a hook swallows that into silence");
  }
});

test("resolveBinding: a parent whose config is corrupt or vault-less is not inheritable", async () => {
  const { resolveBinding } = await import("../scripts/worktree.mjs");

  const corrupt = seedWorktreePair();
  writeFileSync(join(corrupt.main, ".claude", "projectstore.json"), "{not json", "utf8");
  assert.equal(resolveBinding(corrupt.child).state, "unbound", "unparseable parent config offers nothing");

  const empty = seedWorktreePair();
  writeFileSync(join(empty.main, ".claude", "projectstore.json"), "{}\n", "utf8");
  const b = resolveBinding(empty.child);
  assert.equal(b.state, "unbound", "a config with no vault_path is not a binding");
  assert.equal(b.vaultPath, null);
});

test("bindingOfferText names the vault, the parent and the command", async () => {
  const { bindingOfferText, resolveBinding } = await import("../scripts/worktree.mjs");
  const { child, root } = seedWorktreePair();
  const text = bindingOfferText(resolveBinding(child));
  assert.ok(text.includes(join(root, "vault")), "names the vault it would adopt");
  assert.ok(text.includes("/projectstore:bind --inherit"), "names the command that adopts it");
  assert.ok(/shared and unchanged/.test(text), "says the vault is not forked");
});

test("checkConfig: an unbound worktree replaces the generic advice, never appends to it", async () => {
  const d = await import("../scripts/doctor.mjs");
  const { main, child } = seedWorktreePair();

  const wt = d.checkConfig(null, child);
  assert.equal(wt.length, 1, "one problem, one instruction");
  assert.equal(wt[0].check, "worktree-unbound");
  assert.equal(wt[0].level, "issue");
  assert.ok(wt[0].message.includes(main), "names the checkout it was forked from");
  assert.ok(wt[0].message.includes("--inherit"), "names the repair");

  const plain = mkdtempSync(join(tmpdir(), "ps-wt-nb-"));
  const never = d.checkConfig(null, plain);
  assert.equal(never.length, 1);
  assert.equal(never[0].check, "config", "a never-bound project keeps the existing finding verbatim");
  assert.ok(never[0].message.includes("/projectstore:bind <vault-path>"));
});

test("resolveBinding: a separate git dir nested in another repo must not offer that repo's vault", async () => {
  const { resolveBinding } = await import("../scripts/worktree.mjs");
  const root = mkdtempSync(join(tmpdir(), "ps-wt-sgd-"));
  const outer = join(root, "outer");
  const inner = join(root, "inner");

  // An ordinary bound repository...
  mkdirSync(join(outer, "gitdirs"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: outer });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: outer });
  spawnSync("git", ["config", "user.name", "t"], { cwd: outer });
  mkdirSync(join(outer, ".claude"), { recursive: true });
  writeFileSync(join(outer, ".claude", "projectstore.json"),
    JSON.stringify({ vault_path: join(root, "vaultOuter") }), "utf8");
  writeFileSync(join(outer, "o.md"), "o\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: outer });
  spawnSync("git", ["commit", "-qm", "outer"], { cwd: outer });

  // ...whose tree happens to contain the git directory of a SECOND repository.
  mkdirSync(inner, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", join(outer, "gitdirs", "inner.git")], { cwd: inner });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: inner });
  spawnSync("git", ["config", "user.name", "t"], { cwd: inner });
  writeFileSync(join(inner, "i.md"), "i\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: inner });
  spawnSync("git", ["commit", "-qm", "inner"], { cwd: inner });
  const wt = join(root, "wt");
  spawnSync("git", ["worktree", "add", "-q", wt, "-b", "feat"], { cwd: inner });

  // dirname(common-dir) lands in `outer`, which IS a working tree and IS bound.
  // Confirming only "is this inside a working tree" would offer outer's vault to
  // a worktree of inner — a stranger's vault, approved through the gate.
  const b = resolveBinding(wt);
  assert.notEqual(b.vaultPath, join(root, "vaultOuter"), "never offer an unrelated repository's vault");
  assert.equal(b.state, "unbound", "identity unconfirmed means no offer at all");
  assert.equal(b.mainCheckout, null);
});

// ─── PS-AGENTS: the clerk — roster parity across the three registries ──

test("clerk: the layout roster, the agents/ directory and doctor's name list agree", () => {
  const repo = dirname(fileURLToPath(new URL("./", import.meta.url)));
  const roster = [...loadLayout("engineering").agents].sort();
  const onDisk = readdirSync(join(repo, "agents"))
    .filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.deepEqual(onDisk, roster,
    "every roster agent has a definition file, and no stray definition exists");

  // doctor's CURRENT_AGENT_NAMES is a hardcoded mirror nothing links to the
  // layout — a mismatch is silent in production (a user's clerk copy would be
  // reported as 'duplicates instead of overriding'). This is the only detector.
  const doctorSrc = readFileSync(join(repo, "scripts", "doctor.mjs"), "utf8");
  const m = doctorSrc.match(/const CURRENT_AGENT_NAMES = \[([^\]]+)\]/);
  assert.ok(m, "CURRENT_AGENT_NAMES exists");
  const doctorNames = m[1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean).sort();
  assert.deepEqual(doctorNames, roster, "doctor's mirror matches the layout");

  // tokens.mjs must give the clerk a stage, or its runs land in "other" and the
  // ADR's 'visible cost line' consequence silently fails.
  const tokensSrc = readFileSync(join(repo, "scripts", "tokens.mjs"), "utf8");
  assert.ok(/\bclerk: "upkeep"/.test(tokensSrc), "the clerk has a tokens.mjs stage");
});

test("clerk: definition carries the contract the ADR pinned", () => {
  const repo = dirname(fileURLToPath(new URL("./", import.meta.url)));
  const src = readFileSync(join(repo, "agents", "clerk.md"), "utf8");
  const fm = src.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.ok(/^model: sonnet$/m.test(fm),
    "cheap by default, but not the cheapest — decision 5 as amended: a procedure-following floor");
  assert.ok(/^effort: max$/m.test(fm), "effort is orthogonal to price and mitigates the cheap-model risk");
  assert.ok(/^tools: .*Write/m.test(fm), "the sole write-capable agent");
  assert.ok(!/^tools: .*Edit/m.test(fm), "no Edit: whole approved files only");
  const flat = src.replace(/\s+/g, " ");
  assert.ok(/never composes artifact content/i.test(flat), "refusal 1");
  assert.ok(/never decides? whether or where to write/i.test(flat), "refusal 2");
  assert.ok(/never interacts? with the user/i.test(flat), "refusal 3");
  assert.ok(/cp <scratch> <target>/.test(src) && /Write tool is\s+NEVER used on the target/i.test(src),
    "the copy is cp — content never re-enters the model (alternative F is the disease)");
  assert.ok(/"verbatim"/.test(src), "the report proves byte fidelity");
});

// projectstore — predicate tests (PS-SPEC). Zero-dependency: run with
//   node --test tests/*.test.mjs
// Covers the deterministic predicates the spec-first epic added: numbering,
// heading registry matching, legacy exemption, list parsing, layout-driven
// template checks, spec acceptance attribution, evidence/lifecycle gates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  nextNumber,
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
  isLegacyStory,
  listOf,
  loadLayout,
  installedPluginRoot,
  isPluginCacheRoot,
  statusLineIsOurs,
  statusLineLauncherPath,
  syncStatusLine,
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
} from "../scripts/doctor.mjs";

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

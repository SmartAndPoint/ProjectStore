// projectstore — predicate tests (PS-SPEC). Zero-dependency: run with
//   node --test tests/*.test.mjs
// Covers the deterministic predicates the spec-first epic added: numbering,
// heading registry matching, legacy exemption, list parsing, layout-driven
// template checks, spec acceptance attribution, evidence/lifecycle gates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  nextNumber,
  headingLineRe,
  sectionOf,
  indexHeaderRe,
  isLegacyStory,
  listOf,
  loadLayout,
} from "../scripts/lib.mjs";
import {
  checkLayoutTemplates,
  checkSpecCoverage,
  checkSpecAcceptance,
  checkLifecycleGates,
  checkOverrideCopies,
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
  // pure rename → renaming the copy restores the override, so we may suggest it
  assert.match(out[0].message, /rename it to "critic"/);
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

test("checkOverrideCopies leaves user-authored agents alone", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(home, ".claude", "agents", "my-helper.md"), agentFile("my-helper"));
  // a same-named agent with no marker is indistinguishable from the user's own
  writeFileSync(join(home, ".claude", "agents", "critic.md"), agentFile("critic"));
  assert.deepEqual(checkOverrideCopies(proj, home), []);
});

test("checkOverrideCopies still reports a stale current-name override copy", () => {
  const { proj, home } = agentDirs();
  writeFileSync(join(proj, ".claude", "agents", "critic.md"), agentFile("critic", { marker: "0.0.1" }));
  const out = checkOverrideCopies(proj, home);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /frozen at projectstore v0\.0\.1/);
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

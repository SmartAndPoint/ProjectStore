// projectstore — amendment markers under a spec's contracts (the ADR "An
// active spec is amended by a marked block under the contract, naming the
// story, the date and the kind, which doctor checks and the graph draws";
// PS-SPEC: "An active spec is amended through a marked amendment block with
// lineage, not a free-text dated note").
//
// The marker grammar, tombstones and what a kind does cover [SPEC-001#5]; the
// four amendment findings cover [SPEC-001#6]; citation-removed, the coverage
// count and skipped evidence cover [SPEC-001#8]; the planner and reviewer
// sentences cover [SPEC-001#10]; the docs page covers [SPEC-001#11]; the spec
// guide's Must items cover [SPEC-001#12]; the happy-path and scenario checks
// on a tombstone cover [SPEC-001#13]. The third edge source covers
// [vault-link-graph-derived-view-and-shared-link-resolver#3], the `amends`
// kind and lineage [vault-link-graph-derived-view-and-shared-link-resolver#4].
//
// Every token for a fixture spec is built at run time (tok), never written
// as a literal: this repository's own doctor scans its tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadLayout, parseAmendmentMarkers, isCalendarDate, TOMBSTONE_BODY } from "../scripts/lib.mjs";
import {
  parseSpecContracts,
  checkAmendments,
  checkSpecLinks,
  checkContractCitations,
  checkEvidenceCitations,
  checkHappyPathOnly,
  checkScenarioShape,
  runVaultChecks,
} from "../scripts/doctor.mjs";
import { buildGraph } from "../scripts/graph.mjs";
import { lineage, LINEAGE_KINDS } from "../scripts/query.mjs";
import { resolveGuide } from "../scripts/guides.mjs";
import { seedAmendsFixture } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = loadLayout("engineering");
const NOW = "2026-03-01T12:00:00.000Z";
const tok = (key, n) => "[" + key + "#" + n + "]";

const REF = "PS-A/story-change-it";
const spec = (contracts, fm = {}, rel = "specs/s.md") => ({
  kind: "spec",
  rel,
  fm: { type: "spec", id: "s", status: "active", date: "2026-01-01", stories: `["${REF}"]`, ...fm },
  body: ["---", "type: spec", "---", "", "## Behavioral contracts", "", ...contracts, "", "## Acceptance", ""].join(
    "\n",
  ),
});
const story = (fm = {}, rel = "epics/PS-A/stories/story-change-it.md") => ({
  kind: "story",
  rel,
  fm: { type: "story", id: "story-change-it", status: "in-progress", specs: '["s"]', ...fm },
  body: "---\ntype: story\n---\n\n# story\n",
});
const marker = (rest, date = "2026-02-01", ref = REF) => `   > amended ${date} by ${ref}${rest}`;
const amend = (artifacts) => checkAmendments(LAYOUT, artifacts, NOW);
const checks = (fs) => fs.map((f) => f.check);

// ─── The parser ────────────────────────────────────────────────────────

test("marker grammar: a valid marker, a wrapped one, the full-width colon and the three dashes parse; contract and line are kept", () => {
  const ms = parseAmendmentMarkers(
    spec([
      "1. **One.**",
      "",
      marker(": MODIFIED — the why."),
      "",
      "2. **Two.**",
      "",
      "   > amended 2026-02-02",
      "   > by PS-A/story-change-it：ADDED – wrapped,",
      "   > over three lines.",
      "   >",
      "   > Replaced: nothing.",
      "",
      marker(": REMOVED - plain hyphen.", "2026-02-03"),
    ]).body,
  );
  assert.deepEqual(
    ms.map((m) => [m.contract, m.kind, m.valid, m.date, m.ref]),
    [
      ["1", "MODIFIED", true, "2026-02-01", REF],
      ["2", "ADDED", true, "2026-02-02", REF],
      ["2", "REMOVED", true, "2026-02-03", REF],
    ],
  );
  assert.equal(ms[0].why, "the why.");
  assert.equal(ms[1].why, "wrapped, over three lines.", "the first paragraph only, its lines joined");
  assert.equal(ms[0].line, 9, "1-based in the file");
});

test("marker grammar: fences, HTML comments, the example ref and older `> *Amended` blocks count for nothing and say nothing", () => {
  const s = spec([
    "1. **One.**",
    "",
    "   ```",
    marker(": MODIFIED — fenced."),
    "   ```",
    "",
    "   <!--",
    marker(": MODIFIED — in a comment."),
    "   -->",
    "",
    marker(": MODIFIED — documentation.", "2026-02-01", "example/story-x"),
    marker(": CHANGED — documentation, even malformed.", "2026-02-01", "example/story-x").replace("   >", "\n   >"),
    "",
    "   > *Amended 2026-10-13, from A story title (PS-A),* at [[adr|ADR]]: the old form.",
    "",
    // The four wrapped old blocks in the terminal, install and layout specs:
    // `amended <date>` on a continuation line of a block that starts otherwise.
    "   > *Amended 2026-10-14, from the setup story (PS-HARNESS):* the lead and",
    "   > the run's command (the install spec, contract 6 as",
    "   > amended 2026-10-14). The `--json` envelope keeps the parts.",
    "",
    "   >   terminal and refused without one (the install spec, contract 9 as",
    "   >   amended the same day).",
    "",
    // An old block folded inside a marker's block: after the first paragraph.
    marker(": MODIFIED — folds the old one."),
    "   >",
    "   > > amended 2026-01-20 by PS-A/story-missing: REMOVED — quoted history.",
    "   > > *Amended 2026-01-15, from An older story (PS-A),* as written.",
  ]);
  const ms = parseAmendmentMarkers(s.body);
  assert.deepEqual(
    ms.map((m) => m.why),
    ["folds the old one."],
  );
  assert.deepEqual(amend([s, story()]), []);
  assert.equal(parseSpecContracts(s)[0].removed, false);
});

test("marker form: a bad kind, a capitalised `Amended … by`, a marker before the first contract and one after REMOVED are amendment-form, and remove nothing", () => {
  const s = spec([
    "Intro paragraph of the section.",
    "",
    "   > amended 2026-02-01 by PS-A/story-change-it: MODIFIED — before any contract.",
    "",
    "1. **One.**",
    "",
    marker(": CHANGED — not a kind."),
    "",
    "2. **Two.** Removed, see below.",
    "",
    "   > Amended 2026-02-01 by PS-A/story-change-it: REMOVED — capitalised.",
    "",
    "3. **Three.** Removed, see below.",
    "",
    marker(": REMOVED — gone.", "2026-02-02"),
    "",
    marker(": ADDED — after the tombstone.", "2026-02-03"),
    "",
    "4. **Four.**",
    "",
    "   > amended 2026-02-01 by PS-A/story-change-it MODIFIED — no colon.",
    "   > amended 2026-02-01 by PS-A/story-change-it: modified — lowercase kind.",
  ]);
  const ms = parseAmendmentMarkers(s.body);
  assert.deepEqual(
    ms.map((m) => [m.contract, m.valid]),
    [
      [null, false],
      ["1", false],
      ["2", false],
      ["3", true],
      ["3", false],
      ["4", false],
    ],
  );
  const f = amend([s, story()]);
  assert.deepEqual(checks(f), Array(5).fill("amendment-form"), "only the form, nothing else about them");
  assert.ok(f.every((x) => x.level === "warn"));
  assert.match(f[0].message, /before the first contract/);
  assert.match(f[3].message, /follows a REMOVED marker under contract 3/);
  const cs = parseSpecContracts(s);
  assert.deepEqual(
    cs.map((c) => [c.n, c.removed]),
    [
      ["1", false],
      ["2", false],
      ["3", true],
      ["4", false],
    ],
    "an invalid REMOVED removes nothing; the valid one before an invalid marker still does",
  );
  assert.equal(cs[2].why, "gone.");
});

test("tombstones: a contract is removed by its last valid marker; a step whose body is exactly `Removed, see below.` is removed", () => {
  const cs = parseSpecContracts(
    spec([
      "1. **One.** Steps:",
      `   1. ${TOMBSTONE_BODY}`,
      "   2. kept, and it says Removed, see below. in passing",
      "   3. Removed, see",
      "      below.",
      "",
      marker(": MODIFIED — step 1 removed, step 4 added."),
      "",
      "2. **Two.** Removed, see below.",
      "",
      marker(": MODIFIED — first."),
      "",
      marker(": REMOVED — then removed.", "2026-02-02"),
    ]),
  );
  assert.deepEqual([...cs[0].steps], ["1", "2", "3"], "a tombstone keeps its number");
  assert.deepEqual([...cs[0].removedSteps], ["1", "3"], "a wrapped tombstone is read with its continuation");
  assert.equal(cs[0].removed, false);
  assert.equal(cs[0].why, "step 1 removed, step 4 added.");
  assert.equal(cs[1].removed, true);
  assert.equal(cs[1].why, "then removed.");
});

// ─── The four findings ─────────────────────────────────────────────────

test("amendment checks: a marker whose story and spec list each other gives no finding", () => {
  const s = spec(["1. **One.**", "", marker(": MODIFIED — fine.")]);
  assert.deepEqual(amend([s, story()]), []);
  assert.deepEqual(checks(checkSpecLinks({}, LAYOUT, [s, story()])), []);
});

test("amendment-story: a ref that names no story, or more than one, is an issue (once per ref)", () => {
  const s = spec([
    "1. **One.**",
    "",
    marker(": MODIFIED — missing.", "2026-02-01", "PS-A/story-missing"),
    marker(": MODIFIED — missing again.", "2026-02-02", "PS-A/story-missing").replace("   >", "\n   >"),
    "",
    marker(": MODIFIED — two match.", "2026-02-03", "PS-A/story-007"),
    "",
    marker(": MODIFIED — not a qualified ref.", "2026-02-04", "story-change-it"),
  ]);
  const a = story({ id: "story-007-alpha", specs: "[]" }, "epics/PS-A/stories/story-007-alpha.md");
  const b = story({ id: "story-007-beta", specs: "[]" }, "epics/PS-A/stories/story-007-beta.md");
  const f = amend([s, story(), a, b]);
  assert.deepEqual(checks(f), ["amendment-story", "amendment-story", "amendment-story"]);
  assert.ok(f.every((x) => x.level === "issue"));
  assert.match(f[0].message, /PS-A\/story-missing/);
  assert.match(f[1].message, /ambiguous/);
  assert.match(f[2].message, /not in <epic-id>\/<story-id> form/);
});

test("amendment-link: only when neither side lists the other; one side only is the spec-links warn", () => {
  const m = ["1. **One.**", "", marker(": MODIFIED — a change.")];
  // Neither side: amendment-link, and no spec-links.
  const neither = [spec(m, { stories: "[]" }), story({ specs: "[]" })];
  assert.deepEqual(checks(amend(neither)), ["amendment-link"]);
  assert.equal(amend(neither)[0].level, "warn");
  assert.deepEqual(checks(checkSpecLinks({}, LAYOUT, neither)), []);
  // The spec lists the story, the story does not list the spec.
  const half = [spec(m), story({ specs: "[]" })];
  assert.deepEqual(checks(amend(half)), []);
  assert.deepEqual(checks(checkSpecLinks({}, LAYOUT, half)), ["spec-links"]);
  // The story lists the spec, the spec does not list the story.
  const other = [spec(m, { stories: "[]" }), story()];
  assert.deepEqual(checks(amend(other)), []);
  assert.deepEqual(checks(checkSpecLinks({}, LAYOUT, other)), ["spec-links"]);
  // Two markers of one unlinked story warn once.
  const twice = [
    spec([...m, "", "2. **Two.**", "", marker(": MODIFIED — again.")], { stories: "[]" }),
    story({ specs: "[]" }),
  ];
  assert.deepEqual(checks(amend(twice)), ["amendment-link"]);
});

test("amendment-date: not a calendar date, before the spec's date, after tomorrow, or before the previous marker under the same contract", () => {
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2028-02-29"), true);
  const dated = (date) => spec(["1. **One.**", "", marker(": MODIFIED — dated.", date)]);
  const one = (date) => amend([dated(date), story()]);
  assert.deepEqual(checks(one("2026-02-30")), ["amendment-date"]);
  assert.match(one("2026-02-30")[0].message, /2026-02-30 is not a date/);
  assert.deepEqual(checks(one("2025-12-31")), ["amendment-date"], "before the spec's date");
  assert.match(one("2025-12-31")[0].message, /before the spec's date 2026-01-01/);
  assert.deepEqual(checks(one("2026-03-02")), [], "tomorrow is allowed");
  assert.deepEqual(checks(one("2026-03-03")), ["amendment-date"], "after tomorrow");
  // A spec without `date:` skips that comparison.
  assert.deepEqual(
    checks(amend([spec(["1. **One.**", "", marker(": MODIFIED — x.", "2020-01-01")], { date: "" }), story()])),
    [],
  );
  // Under one contract the dates do not decrease; across contracts they may.
  const order = spec([
    "1. **One.**",
    "",
    marker(": MODIFIED — later.", "2026-02-05"),
    "",
    marker(": MODIFIED — earlier.", "2026-02-04"),
    "",
    "2. **Two.**",
    "",
    marker(": MODIFIED — another contract.", "2026-02-01"),
  ]);
  const f = amend([order, story()]);
  assert.deepEqual(checks(f), ["amendment-date"]);
  assert.match(f[0].message, /before the previous marker under the same contract \(2026-02-05\)/);
  // A date warn does not make a marker invalid: the REMOVED still removes.
  const removed = spec(["1. **One.** Removed, see below.", "", marker(": REMOVED — gone.", "2026-02-30")]);
  assert.equal(parseSpecContracts(removed)[0].removed, true);
});

test("amendment checks run on draft and superseded specs too, and through runVaultChecks", () => {
  for (const status of ["draft", "superseded"]) {
    const s = spec(["1. **One.**", "", marker(": CHANGED — x.")], { status });
    assert.deepEqual(checks(amend([s, story()])), ["amendment-form"], status);
  }
  const { proj, vault } = seedAmendsFixture();
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  const f = runVaultChecks(cfg, { proj, now: NOW }).filter((x) => x.check.startsWith("amendment-"));
  assert.deepEqual(checks(f).sort(), ["amendment-form", "amendment-story", "amendment-story"]);
});

// ─── Citations and coverage ────────────────────────────────────────────

const removedSpec = spec([
  "1. **One.** In force.",
  "   1. kept",
  `   2. ${TOMBSTONE_BODY}`,
  "",
  marker(": MODIFIED — step 2 was dropped."),
  "",
  "2. **Two.** Removed, see below.",
  "   - GIVEN a vault",
  "   - WHEN doctor runs",
  "   - THEN it reports",
  "",
  marker(": REMOVED — the rule moved to contract 3."),
  "",
  "3. **Three.** The rule, restated.",
]);
const scanOf = (...tokens) => ({
  status: "ok",
  checkout: "proj",
  tokens: tokens.map(([key, n], i) => ({ key, n, file: "tests/x.test.mjs", line: i + 1 })),
});

test("citation-removed: a token naming a removed contract, or a removed step, is a warn quoting the why, instead of citation-unknown", () => {
  const f = checkContractCitations([removedSpec], scanOf(["s", "2"], ["s", "2/1"], ["s", "1/2"], ["s", "9"]));
  const byCheck = f.filter((x) => x.check !== "contract-coverage");
  assert.deepEqual(checks(byCheck), ["citation-removed", "citation-removed", "citation-removed", "citation-unknown"]);
  assert.ok(byCheck.slice(0, 3).every((x) => x.level === "warn"));
  assert.match(byCheck[0].message, /contract 2 of specs\/s\.md, which is removed: "the rule moved to contract 3\."/);
  assert.match(byCheck[2].message, /step 1\/2 of specs\/s\.md, which is removed: "step 2 was dropped\."/);
  assert.equal(byCheck[0].file, "tests/x.test.mjs:1");
});

test("contract coverage: a removed contract is out of the count, and a citation-removed token covers nothing", () => {
  const uncited = checkContractCitations([removedSpec], scanOf(["s", "1"]));
  assert.deepEqual(checks(uncited), ["contract-coverage"]);
  assert.match(uncited[0].message, /^1 of 2 contracts uncited \(checkout proj\): 3\.$/);
  const none = checkContractCitations([removedSpec], scanOf(["other", "1"]));
  assert.match(none.find((x) => x.check === "contract-coverage").message, /^2 contracts, 0 cited/);
  const onlyRemoved = checkContractCitations([removedSpec], scanOf(["s", "2"]));
  assert.match(onlyRemoved.find((x) => x.check === "contract-coverage").message, /^2 contracts, 0 cited/);
});

test("evidence citations: a done story's evidence naming a removed contract or step is skipped; a missing live one still warns", () => {
  const vaultCfg = { lifecycle_gates: "on", gates_since: "2026-01-01T00:00:00.000Z" };
  const done = {
    kind: "story",
    rel: "epics/PS-A/stories/story-done.md",
    fm: { type: "story", status: "done", closed_at: "2026-02-01T00:00:00.000Z" },
    body: [
      "## Acceptance Criteria",
      "",
      `- [x] the old rule — evidence: ${tok("s", "2")}`,
      `- [x] the old step — evidence: ${tok("s", "1/2")}`,
      `- [x] the live rule — evidence: ${tok("s", "3")}`,
      "",
    ].join("\n"),
  };
  const f = checkEvidenceCitations([removedSpec, done], vaultCfg, scanOf(["s", "1"]));
  assert.deepEqual(checks(f), ["evidence-citation"]);
  assert.match(f[0].message, /\[s#3\]/);
});

test("happy-path and scenario checks skip a removed contract whose body still holds scenario items", () => {
  assert.deepEqual(checkHappyPathOnly([removedSpec]), []);
  const shapeless = spec([
    "1. **One.** Removed, see below.",
    "   - WHEN no THEN follows",
    "",
    marker(": REMOVED — gone."),
  ]);
  assert.deepEqual(checkScenarioShape([shapeless]), []);
  // Without the marker the same contracts are reported.
  const live = spec(["2. **Two.**", "   - GIVEN a vault", "   - WHEN doctor runs", "   - THEN it reports"]);
  assert.equal(checkHappyPathOnly([live]).length, 1);
});

// ─── The graph and lineage ─────────────────────────────────────────────

test("graph golden: one amends edge per story–spec pair, superseded specs included; dead and ambiguous refs stay visible; invalid, fenced and example markers give nothing", () => {
  const { vault } = seedAmendsFixture();
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  const g = buildGraph(cfg, LAYOUT);
  assert.deepEqual(
    g.edges.map((e) => `${e.from} | ${e.kind} | ${e.to}`),
    [
      "epics/PS-A/epic.md | epic-contains | epics/PS-A/stories/story-007-alpha.md",
      "epics/PS-A/epic.md | epic-contains | epics/PS-A/stories/story-007-beta.md",
      "epics/PS-A/epic.md | epic-contains | epics/PS-A/stories/story-change-it.md",
      "epics/PS-A/stories/story-change-it.md | amends | specs/live.md",
      "epics/PS-A/stories/story-change-it.md | amends | specs/old.md",
      "specs/live.md | ambiguous | PS-A/story-007 (matches: epics/PS-A/stories/story-007-alpha.md, epics/PS-A/stories/story-007-beta.md)",
      "specs/live.md | dead | PS-A/story-missing",
      "specs/live.md | spec-covers | epics/PS-A/stories/story-change-it.md",
      "specs/old.md | spec-covers | epics/PS-A/stories/story-change-it.md",
    ],
  );
  assert.equal(g.stats.by_kind.amends, 2, "three markers by one story on one spec give one edge");
  assert.ok(g.content.includes("| epics/PS-A/stories/story-change-it.md | amends | specs/old.md |"));
});

test("lineage walks amends: from the story, --kind amends reaches the superseded spec; the kind is one of the five", () => {
  assert.deepEqual(LINEAGE_KINDS, ["supersedes", "spec-covers", "spec-implements-adr", "epic-contains", "amends"]);
  const { vault } = seedAmendsFixture();
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  const l = lineage(cfg, "epics/PS-A/stories/story-change-it.md", { kinds: ["amends"], depth: 1 });
  assert.deepEqual(l.kinds, ["amends"]);
  assert.deepEqual(
    l.edges.map((e) => `${e.from} ${e.kind} ${e.to}`),
    [
      "epics/PS-A/stories/story-change-it.md amends specs/live.md",
      "epics/PS-A/stories/story-change-it.md amends specs/old.md",
    ],
  );
  const back = lineage(cfg, "specs/old.md", { kinds: ["amends"], depth: 1 });
  assert.deepEqual(
    back.nodes.map((n) => n.path),
    ["specs/old.md", "epics/PS-A/stories/story-change-it.md"],
    "both directions",
  );
});

// ─── The texts ─────────────────────────────────────────────────────────

const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

test("spec guide: the eight Must items, then the amendment items doctor cannot check; blocks under contracts are out of its Length", () => {
  const g = resolveGuide("spec", { root: REPO });
  assert.equal(g.source, "package");
  assert.equal(g.guide_version, 2);
  const must = g.sections.Must;
  assert.equal(must.length, 12);
  assert.match(must[7], /^No TODOs/, "the eighth of the 0.30.9 checklist is still eighth");
  assert.match(must[8], /amended YYYY-MM-DD by .*no new block is written in the older `> \*Amended …` form/);
  assert.match(must[9], /No contract or step number is reused/);
  assert.match(must[10], /Under MODIFIED the body is rewritten to the text in force/);
  assert.match(must[11], /folds that contract's older blocks into the body without changing their meaning/);
  assert.match(g.sections.Length, /Blocks under contracts .* do not count toward this length/);
});

test("guide spec --json: the package Must list through the CLI", () => {
  const { proj } = seedAmendsFixture();
  const r = spawnSync(
    process.execPath,
    [join(REPO, "bin", "projectstore.mjs"), "guide", "spec", "--json", "--project", proj],
    {
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout).result;
  assert.equal(res.source, "package");
  assert.equal(res.sections.Must.length, 12);
});

test("agents and commands: the planner names the contracts a story amends with the kind; the reviewer checks the markers; story, graph and doctor say it", () => {
  const planner = flat(read("agents", "planner.md"));
  assert.match(planner, /name each contract it will amend and the marker's kind \(`ADDED`, `MODIFIED` or `REMOVED`/);
  const reviewer = flat(read("agents", "reviewer.md"));
  assert.match(reviewer, /check that each edit carries an amendment marker/);
  assert.match(reviewer, /from the vault's git history when the vault has one, else from the story's own account/);
  const storyCmd = flat(read("commands", "story.md"));
  assert.match(storyCmd, /that contract's body is rewritten to the text in force, with a marker under it/);
  assert.match(flat(read("commands", "graph.md")), /epic-contains, amends, dead, ambiguous, out-of-scope/);
  const doctor = flat(read("commands", "doctor.md"));
  for (const c of ["amendment-form", "amendment-story", "amendment-link", "amendment-date", "citation-removed"])
    assert.ok(doctor.includes(`\`${c}\``), c);
});

test("docs/contracts-and-tests.md: markers, tombstones and citation-removed, with examples on the reserved key only", () => {
  const d = read("docs", "contracts-and-tests.md");
  assert.match(d, /^## Amending a contract$/m);
  assert.match(d, /> amended 2026-11-10 by example\/story-keep-seven: MODIFIED — /);
  assert.ok(d.includes("`Removed, see below.`"));
  for (const c of ["citation-removed", "amendment-form", "amendment-story", "amendment-link", "amendment-date"])
    assert.ok(d.includes(`| \`${c}\` |`), c);
  // Every token and every marker ref on the page uses the reserved key.
  for (const m of d.matchAll(/(?<!\[)\[([A-Za-z0-9][A-Za-z0-9._-]*)#[0-9]/g)) assert.equal(m[1], "example");
  for (const m of d.matchAll(/amended \d{4}-\d{2}-\d{2} by (\S+?):/g)) assert.match(m[1], /^example\//);
});

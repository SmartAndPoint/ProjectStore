// projectstore — tests/follow.test.mjs: a merged pull request closes its story
// through the close computation, and a stale review goes back (PS-FLOW, "A
// merged pull request moves its story to done through the close gate…"; the
// spec "The follow verb…", alias `follow`, and SPEC-001 contracts 3, 7 and 8
// as amended 2026-11-12). This file holds the offline close machinery, pull
// request A: the close for a merge (contract 5) and its stamps and floor
// (contract 6), as pure functions — computeClose, follow-plan.mjs and
// doctor's storyCloseFindings — with a parity test of the refusal against
// doctor on the same vault. Pull request B adds the `gh` adapter and the
// verb (contracts 1 to 4, 7 to 11 and scenario 6.4), run in process through
// the bin's run() on fixture vaults, against a `gh` stub first on PATH
// (tests/fixtures/gh-stub.mjs): no test reaches the network or the real `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeClose } from "../scripts/story-section.mjs";
import {
  closeFloor,
  eventStamp,
  mergeReason,
  mergedLine,
  mergedAtIso,
  withMergedLine,
  closeForMerge as planClose,
} from "../scripts/follow-plan.mjs";
import { storyCloseFindings, scanArtifacts, runVaultChecks } from "../scripts/doctor.mjs";
import { parseStatusLog, appendLogLine, logLine, setFm } from "../scripts/status-log.mjs";
import { storyFacts, windowCounts, windowOf } from "../scripts/flow-counts.mjs";
import { loadLayout, loadTemplate, renderTemplate, parseFrontmatter, headingLineRe, today } from "../scripts/lib.mjs";
import { storyText, flowVault, commitsSeam, withLine, git as gitIn, gitCommit } from "./fixtures/flow.mjs";
import { ghStub } from "./fixtures/gh-stub.mjs";
import { run } from "../scripts/cli.mjs";
import { runFollow } from "../scripts/follow.mjs";
import { externalRefs, closesStoryRefs } from "../scripts/follow-plan.mjs";
import { isAwaitingClose, statusStamp } from "../scripts/status-log.mjs";
import { defaultGit } from "../scripts/precommit.mjs";
import { readEvents } from "../scripts/write-record.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";
import { sourceHarness } from "../scripts/harness.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const fm = (t) => parseFrontmatter(t).data;

const URL = "https://github.com/acme/app/pull/7";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR = { url: URL, mergedAt: "2026-11-02T10:00:00Z", mergeCommit: { oid: SHA } };
const MERGED = "2026-11-02T10:00:00.000Z";
// The run: Thursday 2026-11-12.
const RUN = "2026-11-12T09:00:00.000Z";
const RUN_DAY = "2026-11-12";
const STARTED = "2026-11-01T09:00:00.000Z";
const SINCE = "2026-10-01";
const POLICY = { lifecycle_gates: "on", gates_since: SINCE, spec_policy: "required", spec_policy_since: SINCE };
const REL = "epics/PS-X/stories/story-a.md";

// ─── Fixtures ──────────────────────────────────────────────────────────

// The text of section `id` replaced by `body`, the heading line kept.
function withSection(text, id, body) {
  const m = text.match(headingLineRe(id));
  assert.ok(m, `no section ${id}`);
  const start = m.index + m[0].trimEnd().length;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  return `${text.slice(0, start)}\n\n${body}\n\n${text.slice(end)}`;
}

// A story ready to close: in progress since STARTED through the plan gate, a
// plan with plan_updated_at, its criteria checked with evidence, a covering
// spec and text under Final Summary. Each key changes one of them.
function readyStory({
  id = "story-a",
  specs = ["covering"],
  criteria = ["- [x] it works — evidence: tests/a.test.mjs"],
  summary = "Shipped the close.",
  plan = "Route through contract 1.",
  planStamp = true,
} = {}) {
  let t = storyText({
    id,
    created: "2026-09-01",
    log: [{ to: "in-progress", at: STARTED, reason: "work started", actor: "plan gate" }],
    fm: {
      started_at: JSON.stringify(STARTED),
      ...(planStamp ? { plan_updated_at: JSON.stringify(STARTED) } : {}),
      specs: JSON.stringify(specs),
    },
  });
  t = withSection(t, "implementation_plan", plan);
  t = withSection(t, "acceptance", criteria.join("\n"));
  if (summary !== null) t = withSection(t, "final_summary", summary);
  return t;
}
const reviewOf = (t) =>
  appendLogLine(
    setFm(setFm(t, "status", "review"), "status_changed_at", JSON.stringify("2026-11-03T09:00:00.000Z")),
    logLine({
      at: "2026-11-03T09:00:00.000Z",
      field: "status",
      from: "in-progress",
      to: "review",
      reason: "r",
      actor: "move",
    }),
  );

// A spec in the vault: active unless `status`, covering `stories`, its
// Acceptance items as given.
function spec(
  vault,
  {
    id = "covering",
    status = "active",
    stories = ["PS-X/story-a"],
    items = ["- [x] it works — stories: story-a"],
  } = {},
) {
  writeFileSync(
    join(vault, "specs", `${id}.md`),
    `---\ntype: spec\nid: "${id}"\ntitle: "${id}"\nstatus: ${status}\ndate: 2026-10-01\nalias: ${id}\nstories: ${JSON.stringify(stories)}\n---\n\n# ${id}\n\n## Behavioral contracts\n\n1. **It works.** The thing works.\n\n   - GIVEN a thing\n   - WHEN it runs\n   - THEN it works\n\n## Acceptance\n\n${items.join("\n")}\n`,
  );
}

// The close of a merge through follow-plan.mjs, at the run RUN_DAY.
const closeForMerge = (text, pr = PR, opts = {}) => planClose(text, pr, { now: RUN, day: RUN_DAY, ...opts });

// The refusal: storyCloseFindings on the vault with the story's judged bytes,
// that story's kinds.
function refusal(fx, judged, rel = REL) {
  const layout = loadLayout(fx.cfg.layout);
  const artifacts = scanArtifacts(fx.cfg, layout).map((a) =>
    a.rel === rel ? { ...a, fm: parseFrontmatter(judged).data, body: judged } : a,
  );
  const vaultCfg = JSON.parse(read(join(fx.vault, ".projectstore.json")));
  return storyCloseFindings(artifacts, vaultCfg, layout)
    .filter((f) => f.file === rel)
    .map((f) => f.check);
}

const sectionText = (text, id) => {
  const m = text.match(headingLineRe(id));
  const start = m.index + m[0].trimEnd().length;
  const next = text.slice(start).search(/^## /m);
  return text.slice(start, next === -1 ? text.length : start + next);
};
const okGrep = () => ({ status: "ok", lines: [] });

// ─── Contract 5: the close and its refusal ─────────────────────────────

// [follow#5] [SPEC-001#7] [SPEC-001#8]
test("close: an in-progress story with gates on and a required spec, evidenced, planned and summarised, is done with the follow line, its text, then the Merged: line", () => {
  const story = readyStory();
  const fx = flowVault({ vaultCfg: POLICY, stories: { "PS-X/story-a": story } });
  spec(fx.vault);
  const { written, judged } = closeForMerge(story);
  assert.deepEqual(refusal(fx, judged), []);
  assert.equal(fm(written).status, "done");
  assert.deepEqual(
    parseStatusLog(written).map((e) => e.line),
    [
      `- ${STARTED} status: planned → in-progress — work started (plan gate)`,
      `- ${MERGED} status: in-progress → done — merged: ${URL} at ${SHA} (follow)`,
    ],
  );
  assert.equal(
    sectionText(written, "final_summary"),
    `\n\nShipped the close.\n\nMerged: ${URL} at ${SHA}, ${MERGED}.\n\n`,
  );
  // Every byte but the close's own is the story's.
  const rest = (t) =>
    t
      .replace(/^(status|status_changed_at|closed_at|updated): .*$/gm, "")
      .replace(/\| \*\*Status\*\* \| .* \|/, "")
      .replace(/^- \S+ status: in-progress → done .*\n/m, "")
      .replace(/^Merged: .*\n\n/m, "")
      .replace(/\*Last updated: .*\*/, "");
  assert.equal(rest(written), rest(story));
});

// [follow#5]
test("close: a ru story whose Итоговое резюме holds only the template's comment, merged with no merge commit, gets the Merged: line alone under the same heading (edge)", () => {
  const ru = renderTemplate(loadTemplate("ru", "story"), {
    id: "story-a",
    title: "A",
    date: "2026-09-01",
    author: "First Last",
    tags: "[]",
    epic_id: "PS-X",
  }).replace("status: planned", "status: review");
  const pr = { ...PR, mergeCommit: null };
  assert.equal(mergeReason(pr), `merged: ${URL}`);
  const { written } = closeForMerge(ru, pr, { lang: "ru" });
  assert.equal((written.match(/^## Итоговое резюме$/gm) || []).length, 1);
  assert.ok(!/^## Final Summary/m.test(written));
  assert.equal(sectionText(written, "final_summary"), `\n\nMerged: ${URL}, ${MERGED}.\n\n`);
  assert.match(written, new RegExp(`^- ${MERGED} status: review → done — merged: ${URL} \\(follow\\)$`, "m"));
  // A section the template did not leave: computeClose inserts it, and the line replaces its placeholder.
  const bare = readyStory({ summary: null }).replace(/## Final Summary\n\n<!--[\s\S]*?-->\n\n/, "");
  assert.ok(!/^## Final Summary/m.test(bare));
  assert.equal(
    sectionText(closeForMerge(bare).written, "final_summary"),
    `\n\nMerged: ${URL} at ${SHA}, ${MERGED}.\n\n`,
  );
  // Run again on its own output: one line.
  const once = closeForMerge(readyStory()).written;
  assert.equal(withMergedLine(once, mergedLine(PR)), once);
});

// [follow#5] [SPEC-001#8]
test("refusal: a review story with no specs and no no_spec under spec_policy: required, already reported as spec-coverage, is refused (edge)", () => {
  const story = reviewOf(readyStory({ specs: [] }));
  assert.equal(fm(story).status, "review");
  const fx = flowVault({ vaultCfg: POLICY, stories: { "PS-X/story-a": story } });
  const before = runVaultChecks(fx.cfg, { proj: fx.proj, now: RUN, commits: commitsSeam(), grep: okGrep });
  assert.ok(
    before.some((f) => f.check === "spec-coverage" && f.file === REL),
    "already carried",
  );
  const { judged } = closeForMerge(story);
  assert.ok(refusal(fx, judged).includes("spec-coverage"));
});

// [follow#5] [SPEC-001#8]
test("refusal: a merge before gates_since lacking evidence, and one before spec_policy_since with no covering spec, are refused, judged at the run time (edge)", () => {
  const late = "2026-11-05";
  const lacking = readyStory({ criteria: ["- [x] it works"] });
  const a = flowVault({
    vaultCfg: { lifecycle_gates: "on", gates_since: late },
    stories: { "PS-X/story-a": lacking },
  });
  const ca = closeForMerge(lacking);
  assert.ok(fm(ca.written).closed_at < late, "the written stamp is before gates_since");
  assert.deepEqual(refusal(a, ca.judged), ["evidence"]);
  // Judged at mergedAt instead, the story would be legacy and the check silent.
  assert.deepEqual(refusal(a, ca.written), []);

  const unspecced = readyStory({ specs: [] });
  const b = flowVault({
    vaultCfg: { ...POLICY, spec_policy_since: late },
    stories: { "PS-X/story-a": unspecced },
  });
  const cb = closeForMerge(unspecced);
  assert.deepEqual(refusal(b, cb.judged), ["spec-coverage"]);
  assert.deepEqual(refusal(b, cb.written), []);
});

// [follow#5] [SPEC-001#8]
test("refusal: lifecycle_gates off with a checked criterion lacking evidence, and a story whose only finding is evidence-citation, are both done (edge)", () => {
  const lacking = readyStory({ criteria: ["- [x] it works"], specs: [] });
  const off = flowVault({ vaultCfg: { lifecycle_gates: "off" }, stories: { "PS-X/story-a": lacking } });
  const c1 = closeForMerge(lacking);
  assert.deepEqual(refusal(off, c1.judged), []);
  assert.equal(fm(c1.written).status, "done");

  // Built at run time, so the repository's own doctor does not read this source as a citation.
  const citing = readyStory({ criteria: [`- [x] it works — evidence: tests/a.test.mjs [covering${"#"}9]`] });
  const on = flowVault({ vaultCfg: POLICY, stories: { "PS-X/story-a": citing } });
  spec(on.vault);
  const c2 = closeForMerge(citing);
  writeFileSync(join(on.vault, REL), c2.judged);
  const doctor = runVaultChecks(on.cfg, { proj: on.proj, now: RUN, commits: commitsSeam(), grep: okGrep });
  assert.ok(
    doctor.some((f) => f.check === "evidence-citation" && f.file === REL),
    doctor.map((f) => f.check).join(", "),
  );
  assert.deepEqual(refusal(on, c2.judged), []);
  // An unchecked criterion refuses under any setting.
  const open = readyStory({ criteria: ["- [x] it works — evidence: tests/a.test.mjs", "- [ ] the rest"], specs: [] });
  assert.deepEqual(refusal(off, closeForMerge(open).judged), ["acceptance"]);
});

// [follow#5] [SPEC-001#8]
test("parity: storyCloseFindings gives the findings of the seven kinds that doctor gives on the same post-close vault", () => {
  const cases = {
    "story-a": readyStory(),
    "story-b": readyStory({ id: "story-b", criteria: ["- [x] done — evidence: t", "- [ ] open"] }),
    "story-c": readyStory({ id: "story-c", criteria: ["- [x] no evidence here"] }),
    "story-d": readyStory({ id: "story-d", specs: [] }),
    "story-e": readyStory({ id: "story-e", planStamp: false }),
    "story-f": readyStory({ id: "story-f", specs: ["drafty"] }),
    "story-g": readyStory({ id: "story-g", specs: ["strict"] }),
  };
  const closed = Object.fromEntries(
    Object.entries(cases).map(([slug, t]) => [`PS-X/${slug}`, closeForMerge(t).judged]),
  );
  // A done story closed by hand with no plan and no Final Summary: plan-gate and final-summary.
  closed["PS-X/story-h"] = setFm(
    storyText({ id: "story-h", status: "done", fm: { closed_at: JSON.stringify(RUN) } }),
    "specs",
    '["covering"]',
  )
    .replace(/## Final Summary\n\n<!--[\s\S]*?-->\n\n/, "")
    .replace(/## Implementation Plan\n\n<!--[\s\S]*?-->\n\n/, "");
  const fx = flowVault({ vaultCfg: POLICY, stories: closed });
  spec(fx.vault, { stories: ["PS-X/story-a", "PS-X/story-b", "PS-X/story-c", "PS-X/story-e", "PS-X/story-h"] });
  spec(fx.vault, { id: "drafty", status: "draft", stories: ["PS-X/story-f"], items: ["- [x] x — stories: story-f"] });
  spec(fx.vault, { id: "strict", stories: ["PS-X/story-g"], items: ["- [ ] not yet — stories: story-g"] });
  const KINDS = [
    "acceptance",
    "evidence",
    "plan-gate",
    "final-summary",
    "spec-coverage",
    "spec-status",
    "spec-acceptance",
  ];
  const key = (f) => `${f.file} ${f.check} ${f.level} ${f.message}`;
  const doctor = runVaultChecks(fx.cfg, { proj: fx.proj, now: RUN, commits: commitsSeam(), grep: okGrep })
    .filter((f) => KINDS.includes(f.check))
    .map(key)
    .sort();
  const layout = loadLayout(fx.cfg.layout);
  const ours = storyCloseFindings(scanArtifacts(fx.cfg, layout), POLICY, layout).map(key).sort();
  assert.deepEqual(ours, doctor);
  // Not vacuous: every kind is there, and the ready story has none.
  assert.deepEqual([...new Set(ours.map((k) => k.split(" ")[1]))].sort(), [...KINDS].sort());
  assert.ok(!ours.some((k) => k.startsWith(`${REL} `)), ours.join("\n"));
});

// ─── Contract 6: the stamps and the floor ──────────────────────────────

// [follow#6] [SPEC-001#3]
test("stamps: a story merged at 2026-11-02T10:00:00Z and closed by a run on 2026-11-12 is stamped at the merge, updated on the run's day, and counted in the merge's window", () => {
  const { written, stamp } = closeForMerge(readyStory());
  assert.deepEqual(stamp, { at: MERGED, mergedAt: MERGED, floored: false });
  const f = fm(written);
  assert.deepEqual([f.closed_at, f.status_changed_at, String(f.updated)], [MERGED, MERGED, RUN_DAY]);
  assert.equal(parseStatusLog(written).at(-1).at, MERGED);
  assert.match(written, /\*Last updated: 2026-11-12\*/);
  const facts = storyFacts({ rel: REL, epic: "PS-X", slug: "story-a", text: written, fm: f });
  // The week of Monday 2026-11-02 holds mergedAt; the run's week does not count it.
  const merge = windowOf(Date.parse("2026-11-09T00:00:00Z"), 1);
  const run = windowOf(Date.parse("2026-11-16T00:00:00Z"), 1);
  assert.deepEqual(
    windowCounts([facts], merge).closed.map((x) => x.slug),
    ["story-a"],
  );
  assert.deepEqual(windowCounts([facts], run).closed, []);
});

// [follow#6] [SPEC-001#3]
test("floor: mergedAt earlier than the story's last readable Status log line puts every stamp at that line's time, and the Merged: line keeps mergedAt (edge)", () => {
  const story = reviewOf(readyStory());
  const line = "2026-11-03T09:00:00.000Z";
  assert.equal(closeFloor(story), Date.parse(line));
  const { written, stamp } = closeForMerge(story);
  assert.deepEqual(stamp, { at: line, mergedAt: MERGED, floored: true });
  const f = fm(written);
  assert.deepEqual([f.closed_at, f.status_changed_at], [line, line]);
  assert.equal(
    parseStatusLog(written).at(-1).line,
    `- ${line} status: review → done — merged: ${URL} at ${SHA} (follow)`,
  );
  assert.match(sectionText(written, "final_summary"), new RegExp(`Merged: ${URL} at ${SHA}, ${MERGED}\\.`));
  // The log stays in time order.
  const times = parseStatusLog(written).map((e) => Date.parse(e.at));
  assert.deepEqual(
    times,
    [...times].sort((x, y) => x - y),
  );
});

// [follow#6]
test("floor: a last Status log line timed 2026-02-30T10:00:00Z is skipped for the line before it, then started_at and created count (edge)", () => {
  const bad = (t) =>
    appendLogLine(
      t,
      logLine({
        at: "2026-02-30T10:00:00Z",
        field: "status",
        from: "review",
        to: "review",
        reason: "x",
        actor: "move",
      }),
    );
  const story = bad(reviewOf(readyStory()));
  assert.equal(parseStatusLog(story).at(-1).at, "2026-02-30T10:00:00Z", "the line parses; its time does not read");
  assert.equal(closeFloor(story), Date.parse("2026-11-03T09:00:00.000Z"));
  const early = { ...PR, mergedAt: "2026-10-01T00:00:00Z" };
  assert.equal(closeForMerge(story, early).stamp.at, "2026-11-03T09:00:00.000Z");
  // A later started_at wins over the line before; with no readable line, created and started_at.
  const startedLate = setFm(story, "started_at", JSON.stringify("2026-11-04T00:00:00.000Z"));
  assert.equal(closeFloor(startedLate), Date.parse("2026-11-04T00:00:00.000Z"));
  const noLog = storyText({ id: "s", created: "2026-10-15" });
  assert.equal(closeFloor(noLog), Date.parse("2026-10-15"));
  assert.equal(eventStamp(noLog, early).at, "2026-10-15T00:00:00.000Z");
  assert.equal(closeFloor(setFm(noLog, "created", "soon")), null);
  assert.deepEqual(eventStamp(setFm(noLog, "created", "soon"), early), {
    at: "2026-10-01T00:00:00.000Z",
    mergedAt: "2026-10-01T00:00:00.000Z",
    floored: false,
  });
  assert.throws(() => mergedAtIso({ url: URL, mergedAt: null }), /mergedAt is not an instant/);
});

// [follow#5] [SPEC-001#8]
test("refusal: a story carrying a stale closed_at of 2026-01-01 is judged closed at the run time, so a missing evidence still refuses (edge)", () => {
  const stale = setFm(
    readyStory({ criteria: ["- [x] it works"] }),
    "closed_at",
    JSON.stringify("2026-01-01T00:00:00.000Z"),
  );
  const fx = flowVault({ vaultCfg: POLICY, stories: { "PS-X/story-a": stale } });
  spec(fx.vault);
  const c = closeForMerge(stale, PR, { findings: (judged) => refusal(fx, judged) });
  assert.equal(fm(c.judged).closed_at, RUN);
  assert.equal(fm(c.written).closed_at, "2026-01-01T00:00:00.000Z", "the written close keeps the story's stamp");
  assert.deepEqual([c.refusal, c.refused], [["evidence"], true]);
  // Without the reset the judged bytes would be legacy, and the refusal silent.
  assert.deepEqual(refusal(fx, c.written), []);
  const ready = readyStory();
  const ok = closeForMerge(ready, PR, { findings: (judged) => refusal(fx, judged) });
  assert.deepEqual([ok.refusal, ok.refused, ok.reason, ok.line], [[], false, mergeReason(PR), mergedLine(PR)]);
  assert.throws(() => planClose(ready, PR, { now: "soon", day: RUN_DAY }), /run time is not an instant/);
});

// [follow#6]
test("floor: a later assignee: line, and a later pr: line of an earlier run, set the floor (edge)", () => {
  const story = readyStory();
  const handed = appendLogLine(
    story,
    logLine({
      at: "2026-11-05T08:00:00.000Z",
      field: "assignee",
      from: "",
      to: "Other Person",
      reason: "handed over",
      actor: "handover",
    }),
  );
  assert.equal(closeFloor(handed), Date.parse("2026-11-05T08:00:00.000Z"));
  const c = closeForMerge(handed);
  assert.deepEqual([c.stamp.at, c.stamp.floored], ["2026-11-05T08:00:00.000Z", true]);
  assert.equal(fm(c.written).closed_at, "2026-11-05T08:00:00.000Z");
  const linked = appendLogLine(
    handed,
    logLine({
      at: "2026-11-06T07:00:00.000Z",
      field: "pr",
      from: "",
      to: URL,
      reason: "linked from Closes-story",
      actor: "follow",
    }),
  );
  assert.equal(closeFloor(linked), Date.parse("2026-11-06T07:00:00.000Z"));
  const d = closeForMerge(linked);
  assert.equal(d.stamp.at, "2026-11-06T07:00:00.000Z");
  const times = parseStatusLog(d.written).map((e) => Date.parse(e.at));
  assert.deepEqual(
    times,
    [...times].sort((x, y) => x - y),
    "the log stays in time order",
  );
});

// [follow#6] [SPEC-001#7]
test("computeClose: an event time from any actor but follow is refused, and with none the close is at the run time", () => {
  const story = readyStory();
  for (const actor of ["close gate", undefined])
    assert.throws(() => computeClose(story, { actor, at: MERGED, day: RUN_DAY }), /only with --actor follow/);
  assert.throws(() => computeClose(story, { actor: "follow", at: "2026-02-30T10:00:00Z" }), /not an instant/);
  const given = fm(computeClose(story, { actor: "follow", at: "2026-11-02T10:00:00Z", day: RUN_DAY }).text);
  assert.deepEqual([given.closed_at, given.status_changed_at], [MERGED, MERGED], "in nowIso() form");
  const before = Date.now() - 1000;
  const own = fm(computeClose(story, { day: RUN_DAY }).text);
  assert.ok(Date.parse(own.closed_at) >= before);
  assert.equal(own.status_changed_at, own.closed_at);
});

// [follow#5] [follow#6] [SPEC-001#7]
test("story-section.mjs close without --at gives the output it gave before computeClose, stamps masked", () => {
  const golden = JSON.parse(read(join(REPO, "tests", "fixtures", "close-golden.json")));
  assert.ok(golden.cases.length >= 5);
  const ISO_MS = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
  for (const c of golden.cases) {
    const proj = mkdtempSync(join(tmpdir(), "ps-close-"));
    const vault = join(proj, "vault");
    mkdirSync(join(vault, "epics", "PS-X", "stories"), { recursive: true });
    mkdirSync(join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, ".projectstore"), { recursive: true });
    writeFileSync(
      join(proj, ".projectstore", "projectstore.json"),
      JSON.stringify({ vault_path: vault, layout: "engineering", language: c.lang, default_author: "Test" }),
    );
    const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
    writeFileSync(path, c.input);
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), "close", path, ...c.args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: REPO },
      cwd: REPO,
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const mask = (s) => s.replace(ISO_MS, "«instant»").split(today()).join("«day»");
    assert.deepEqual([j.changed, j.notes, mask(j.content)], [c.changed, c.notes, c.content], c.name);
  }
});

// ─── Purity and reach ──────────────────────────────────────────────────

// Source guard (no contract token: doctor would count it as coverage).
test("source guard: follow-plan.mjs reads no clock, no file and no process, and no hook or MCP module reaches it", async () => {
  const src = read(join(REPO, "scripts", "follow-plan.mjs"));
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const [what, re] of [
    ["a file", /node:fs|readFileSync|readdirSync|from "fs"/],
    ["a child process", /child_process|spawn/],
    ["the process", /\bprocess\./],
    ["the clock", /Date\.now|new Date\(\s*\)|performance\.now/],
  ])
    assert.doesNotMatch(code, re, `follow-plan.mjs reads ${what}`);
  const { VERBS } = await import("../scripts/cli.mjs");
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [
    ...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }),
    mcp,
    "scripts/doctor.mjs",
    "scripts/story-section.mjs",
  ];
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  for (const entry of entries) {
    const files = closure(entry, { root: REPO, dispatch });
    assert.ok(!files.includes("scripts/follow-plan.mjs"), `${entry} reaches scripts/follow-plan.mjs`);
  }
  assert.ok(closure("scripts/follow-plan.mjs", { root: REPO }).includes("scripts/status-log.mjs"), "not vacuous");
});

// ═══ Pull request B: the gh stub, the verb ═════════════════════════════

const GH = "https://github.com/acme/app";
const prUrl = (n) => `${GH}/pull/${n}`;
const T0 = "2026-11-01T08:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const openPr = (n, o = {}) => ({
  url: prUrl(n),
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  baseRefName: "main",
  createdAt: T0,
  mergedAt: null,
  mergeCommit: null,
  updatedAt: T0,
  closedAt: null,
  body: "",
  ...o,
});
const mergedPr = (n, o = {}) =>
  openPr(n, {
    state: "MERGED",
    mergedAt: PR.mergedAt,
    mergeCommit: { oid: SHA },
    closedAt: PR.mergedAt,
    updatedAt: PR.mergedAt,
    ...o,
  });
const closedPr = (n, o = {}) => openPr(n, { state: "CLOSED", closedAt: "2026-11-03T08:00:00Z", ...o });
const closes = (...refs) => refs.map((r) => `Closes-story: ${r}`).join("\n");
const linked = (t, n) => setFm(t, "external_refs", JSON.stringify({ pr: prUrl(n) }));
// A story moved to review at `at` by a writer, so its stamp is trusted.
const toReview = (t, at) =>
  appendLogLine(
    setFm(setFm(t, "status", "review"), "status_changed_at", JSON.stringify(at)),
    logLine({ at, field: "status", from: "in-progress", to: "review", reason: "r", actor: "move" }),
  );
// A story whose status was set by hand: no log line, so no trusted stamp.
const byHand = (id, status, extra = {}) => storyText({ id, status, ...extra });
const pathOf = (fx, slug, epic = "PS-X") => join(fx.vault, "epics", epic, "stories", `${slug}.md`);
const stubOf = (table) => ghStub(mkdtempSync(join(tmpdir(), "ps-gh-")), table);
const codes = (list) => list.map((f) => f.code);

// Every file under the vault, by its path: "nothing on disk changes".
function snapshot(fx) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(fx.vault, p)] = readFileSync(p, "utf8");
    }
  };
  walk(fx.vault);
  return out;
}

const textSink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true), isTTY: false };
  return s;
};

// follow through the bin's run(), with the stub first on PATH.
async function follow(fx, stub, args = [], { json = true, env = null, ask = null } = {}) {
  const stdout = textSink();
  const stderr = textSink();
  const code = await run(["follow", ...args, ...(json ? ["--json"] : []), "--project", fx.proj], {
    env: { ...(env || stub.env()), CI: "1" },
    cwd: fx.proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  const j = json ? JSON.parse(stdout.text) : null;
  return { code, out: stdout.text, err: stderr.text, json: j, r: j ? j.result : null };
}

// follow through runFollow, for the seams the bin never passes.
async function followDirect(fx, stub, values, seams = {}) {
  return runFollow({ values, cfg: fx.cfg, project: fx.proj, env: stub.env(), confirm: null, ...seams });
}

// ─── Contract 1: the verb, its consent and its exits ──────────────────

// [follow#1]
test("verb: bare, a review story whose pull request merged and whose criteria carry evidence is planned review → done, nothing on disk changes, exit 0", async () => {
  const fx = flowVault({ vaultCfg: POLICY, stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  spec(fx.vault);
  const stub = stubOf({ prs: [mergedPr(7)] });
  const before = snapshot(fx);
  const r = await follow(fx, stub);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.r.write, false);
  assert.equal(r.r.items.length, 1, JSON.stringify(r.r.items));
  const [item] = r.r.items;
  assert.equal(item.story, "PS-X/story-a");
  assert.equal(item.from, "review");
  assert.equal(item.to, "done");
  assert.equal(item.reason, `merged: ${URL} at ${SHA}`);
  assert.equal(item.written, false);
  assert.match(item.line, new RegExp(`status: review → done — merged: ${URL} at ${SHA} \\(follow\\)$`));
  for (const k of ["story", "path", "pr", "from", "to", "reason", "line", "at", "written", "error"])
    assert.ok(k in item, `an item holds ${k}`);
  for (const k of ["write", "checked", "items", "findings", "notes", "epics", "reconcile", "error"])
    assert.ok(k in r.r, `the result holds ${k}`);
  assert.deepEqual(snapshot(fx), before, "a bare run writes nothing");
  // The text: the plan, then the command alone on its line after a lead ending with a colon.
  const t = await follow(fx, stub, [], { json: false });
  assert.equal(t.code, 0);
  const lines = t.out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Nothing written. To apply it, from a terminal in "));
  assert.ok(at > 0 && lines[at].endsWith(":"), t.out);
  assert.equal(lines[at + 2], "  npx projectstore follow --write");
});

// [follow#1]
test("verb: a plan printed while the pull request was open, and the merge made after it: --write closes the story from the facts it read (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(toReview(readyStory(), "2026-11-01T12:00:00.000Z"), 7) } });
  const stub = stubOf({ prs: [openPr(7)] });
  const plan = await follow(fx, stub);
  assert.equal(plan.code, 0);
  assert.deepEqual(plan.r.items, [], "an open pull request with no age key changes nothing");
  stub.set({ prs: [mergedPr(7)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.equal(fm(read(pathOf(fx, "story-a"))).status, "done");
  assert.equal(r.r.items[0].written, true);
});

// [follow#1]
test("verb: a story with no external_refs.pr and no Closes-story line naming it is never asked about, and its file is byte-identical (edge)", async () => {
  const b = readyStory({ id: "story-b" });
  const fx = flowVault({ stories: { "PS-X/story-a": linked(readyStory(), 7), "PS-X/story-b": b } });
  const stub = stubOf({ prs: [mergedPr(7), openPr(8, { body: "no line here" })] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(
    stub.calls("pr view").map((a) => a[2]),
    [prUrl(7)],
    "the one view is the linked story's",
  );
  assert.equal(read(pathOf(fx, "story-b")), b);
  assert.ok(!r.r.items.some((i) => i.story === "PS-X/story-b"));
});

// [follow#1]
test("verb: a pr-conflict on one story and a merge to close on another: the second is done, the first unchanged, exit 1 (failure)", async () => {
  const a = linked(readyStory(), 8);
  const fx = flowVault({
    stories: { "PS-X/story-a": a, "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 7) },
  });
  const stub = stubOf({ prs: [openPr(8), openPr(9, { body: closes("PS-X/story-a") }), mergedPr(7)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 1);
  assert.equal(read(pathOf(fx, "story-a")), a);
  assert.equal(fm(read(pathOf(fx, "story-b"))).status, "done");
  const f = r.r.findings.find((x) => x.code === "pr-conflict");
  assert.equal(f.story, "PS-X/story-a");
  assert.match(f.message, /pull\/8.*pull\/9/);
});

// [follow#1]
test("verb: two open pull requests naming one story with an empty field, and --pr naming one: both are read, the story is unchanged with pr-conflict, exit 1 (edge)", async () => {
  const a = readyStory();
  const fx = flowVault({ stories: { "PS-X/story-a": a } });
  const stub = stubOf({
    prs: [openPr(8, { body: closes("PS-X/story-a") }), openPr(9, { body: closes("PS-X/story-a") })],
  });
  const r = await follow(fx, stub, ["--write", "--pr", "8"]);
  assert.equal(r.code, 1);
  assert.ok(stub.calls("pr list").length >= 1, "the list is read in full");
  assert.equal(read(pathOf(fx, "story-a")), a);
  const f = r.r.findings.find((x) => x.code === "pr-conflict");
  assert.ok(f && f.message.includes(prUrl(8)) && f.message.includes(prUrl(9)), JSON.stringify(r.r.findings));
});

// [follow#1]
test("verb: --story naming no story is exit 1, an unknown flag exit 2, and a No at the terminal exit 1 with declined: true; nothing is written (failure)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const stub = stubOf({ prs: [mergedPr(7)] });
  const before = snapshot(fx);
  const none = await follow(fx, stub, ["--story", "PS-X/story-nope", "--write"]);
  assert.equal(none.code, 1);
  assert.match(none.r.error, /no story in epics\/PS-X matches "story-nope"/);
  const flag = await follow(fx, stub, ["--bogus"]);
  assert.equal(flag.code, 2);
  const no = await follow(fx, stub, ["--write"], { json: false, ask: async () => "n" });
  assert.equal(no.code, 1);
  assert.match(no.out, /PS-X\/story-a: status: review → done/, "the plan is shown before the question");
  assert.match(no.err, /Nothing written\./);
  const d = await followDirect(fx, stub, { write: true }, { confirm: async () => false });
  assert.equal(d.code, 1);
  assert.equal(d.result.declined, true);
  assert.deepEqual(snapshot(fx), before);
});

// [follow#1]
test("verb: --story writes only its story, --pr takes a url, and a --pr that is neither a number nor a url is exit 2", async () => {
  const two = () =>
    flowVault({
      stories: {
        "PS-X/story-a": linked(reviewOf(readyStory()), 7),
        "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 8),
      },
    });
  const stub = stubOf({ prs: [mergedPr(7), mergedPr(8)] });
  const fx = two();
  const b = read(pathOf(fx, "story-b"));
  const one = await follow(fx, stub, ["--story", "PS-X/story-a", "--write"]);
  assert.equal(one.code, 0, JSON.stringify(one.r.findings));
  assert.equal(fm(read(pathOf(fx, "story-a"))).status, "done");
  assert.equal(read(pathOf(fx, "story-b")), b, "--story writes only its story");
  const fy = two();
  const a = read(pathOf(fy, "story-a"));
  const byUrl = await follow(fy, stub, ["--pr", `${prUrl(8)}/`, "--write"]);
  assert.equal(byUrl.code, 0, JSON.stringify(byUrl.r.findings));
  assert.equal(fm(read(pathOf(fy, "story-b"))).status, "done");
  assert.equal(read(pathOf(fy, "story-a")), a, "--pr <url> writes only the stories that pull request closes");
  const before = snapshot(fy);
  const bad = await follow(fy, stub, ["--pr", "zzz", "--write"]);
  assert.equal(bad.code, 2);
  assert.match(bad.json.result.error, /--pr takes a pull request's number or url/);
  assert.deepEqual(snapshot(fy), before);
});

// [follow#1] [follow#9]
test("verb: the question asked before --write writes shows the epics the run would move", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  withResults(fx, ["- [x] it works"]);
  const before = snapshot(fx);
  let shown = null;
  const r = await followDirect(
    fx,
    stubOf({ prs: [mergedPr(7)] }),
    { write: true },
    {
      confirm: async (preview) => ((shown = preview), false),
    },
  );
  assert.equal(r.code, 1);
  assert.equal(r.result.declined, true);
  assert.match(shown, /^Epics:$/m);
  assert.match(shown, /^ {2}PS-X: in-progress → done — /m);
  assert.match(shown, /PS-X\/story-a: status: review → done/);
  assert.deepEqual(snapshot(fx), before);
});

// ─── Contract 2: the facts, from gh ────────────────────────────────────

// [follow#2]
test("facts: no pr view asks for body, every pr list carries --limit of at most 1000 and body, and repo view runs once", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(readyStory(), 7),
      "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 8),
      "PS-X/story-c": readyStory({ id: "story-c" }),
    },
  });
  const stub = stubOf({ prs: [openPr(7), openPr(8), openPr(9, { body: closes("PS-X/story-c") })] });
  const r = await follow(fx, stub);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const fields = (a) => a[a.indexOf("--json") + 1].split(",");
  const views = stub.calls("pr view");
  assert.equal(views.length, 2);
  for (const a of views) assert.ok(!fields(a).includes("body"), a.join(" "));
  for (const a of views)
    for (const f of [
      "url",
      "state",
      "isDraft",
      "isCrossRepository",
      "baseRefName",
      "createdAt",
      "mergedAt",
      "mergeCommit",
      "updatedAt",
    ])
      assert.ok(fields(a).includes(f), `pr view asks for ${f}`);
  const lists = stub.calls("pr list");
  assert.ok(lists.length >= 1);
  for (const a of lists) {
    const limit = Number(a[a.indexOf("--limit") + 1]);
    assert.ok(limit > 30 && limit <= 1000, a.join(" "));
    assert.ok(fields(a).includes("body"), a.join(" "));
  }
  assert.equal(stub.calls("repo view").length, 1);
  assert.deepEqual(stub.calls("repo view")[0].slice(0, 5), ["repo", "view", GH, "--json", "defaultBranchRef"]);
});

// [follow#2]
test("facts: gh runs in the project, with the caller's environment", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(readyStory(), 7) } });
  const stub = stubOf({ prs: [openPr(7)] });
  const r = await follow(fx, stub);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const calls = stub.log();
  assert.ok(calls.length >= 2, "the list and the view ran");
  for (const c of calls) assert.equal(realpathSync(c.cwd), realpathSync(fx.proj), c.argv.join(" "));
});

// [follow#2]
test("facts: gh missing from PATH, and a gh that exits 4, each give gh-unavailable, exit 1, and nothing on disk changes (failure)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const stub = stubOf({ prs: [mergedPr(7)] });
  const before = snapshot(fx);
  const empty = mkdtempSync(join(tmpdir(), "ps-nopath-"));
  const missing = await follow(fx, stub, ["--write"], { env: { ...process.env, PATH: empty } });
  assert.equal(missing.code, 1);
  assert.deepEqual(codes(missing.r.findings), ["gh-unavailable"]);
  assert.deepEqual(snapshot(fx), before);
  stub.set({ auth: true, prs: [mergedPr(7)] });
  const out = await follow(fx, stub, ["--write"]);
  assert.equal(out.code, 1);
  assert.deepEqual(codes(out.r.findings), ["gh-unavailable"]);
  assert.match(out.r.findings[0].message, /gh auth login/);
  assert.deepEqual(snapshot(fx), before);
});

// [follow#2]
test("facts: of three linked stories, the one whose pr view exits 1 is unchanged with pr-unreadable, and the other two are judged (failure)", async () => {
  const b = linked(reviewOf(readyStory({ id: "story-b" })), 8);
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(reviewOf(readyStory()), 7),
      "PS-X/story-b": b,
      "PS-X/story-c": linked(byHand("story-c", "in-progress"), 9),
    },
  });
  const stub = stubOf({ prs: [mergedPr(7), openPr(8), openPr(9)], fail: { view: { [prUrl(8)]: 1 } } });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 1);
  assert.equal(read(pathOf(fx, "story-b")), b);
  const f = r.r.findings.find((x) => x.code === "pr-unreadable");
  assert.equal(f.story, "PS-X/story-b");
  assert.equal(fm(read(pathOf(fx, "story-a"))).status, "done");
  assert.equal(fm(read(pathOf(fx, "story-c"))).status, "review");
});

// [follow#2]
test("facts: a pr list that fails, a repo view that times out, and a list as long as its limit each give pr-unreadable: no link, no close, no awaiting line, exit 1 (failure)", async () => {
  const x = readyStory({ id: "story-x" });
  const y = linked(toReview(readyStory({ id: "story-y" }), "2026-11-01T12:00:00.000Z"), 7);
  const table = { prs: [mergedPr(7), openPr(9, { body: closes("PS-X/story-x"), updatedAt: "2026-11-05T00:00:00Z" })] };
  for (const [what, extra, seams] of [
    ["a failing list", { fail: { list: 1 } }, {}],
    ["a repo view that times out", { fail: { repo: "hang" } }, { ghTimeout: 1500 }],
    ["a full page", { full: true }, {}],
  ]) {
    const fx = flowVault({ stories: { "PS-X/story-x": x, "PS-X/story-y": y } });
    const stub = stubOf({ ...table, ...extra });
    const r = await followDirect(fx, stub, { write: true }, seams);
    assert.equal(r.code, 1, what);
    const f = r.result.findings.find((z) => z.code === "pr-unreadable" && z.story === null);
    assert.ok(f, `${what}: ${JSON.stringify(r.result.findings)}`);
    assert.equal(read(pathOf(fx, "story-x")), x, `${what}: no link is recorded`);
    assert.equal(read(pathOf(fx, "story-y")), y, `${what}: no story is closed or set awaiting`);
  }
});

// [follow#2]
test("facts: the list asks for pull requests merged or closed since the oldest started_at, else created, of a story in progress or in review, and --story narrows it (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-p": byHand("story-p", "in-progress", { fm: { started_at: '"2026-10-20T09:00:00.000Z"' } }),
      "PS-X/story-q": byHand("story-q", "in-progress", { fm: { started_at: '"2026-11-03T09:00:00.000Z"' } }),
      "PS-X/story-r": byHand("story-r", "review", { created: "2026-10-01" }),
      "PS-X/story-s": byHand("story-s", "planned", { created: "2026-01-01" }),
    },
  });
  const stub = stubOf({ prs: [] });
  const search = () =>
    stub
      .calls("pr list")
      .filter((a) => a.includes("--search"))
      .map((a) => a[a.indexOf("--search") + 1]);
  assert.equal((await follow(fx, stub)).code, 0);
  assert.deepEqual(search(), ["closed:>=2026-10-01"]);
  stub.reset();
  assert.equal((await follow(fx, stub, ["--story", "PS-X/story-q"])).code, 0);
  assert.deepEqual(search(), ["closed:>=2026-11-03"]);
});

// ─── Contract 3: which pull request closes a story ─────────────────────

// [follow#3]
test("links: a counted open pull request whose CRLF body names two in-progress stories links both, with the linked line, and both are judged by it", async () => {
  const body = `Two stories.\r\n${closes("PS-X/story-a")}\r\n\r\n${closes("PS-X/story-b")}\r\n\r\n\`\`\`\r\n${closes("PS-X/story-c")}\r\n\`\`\`\r\n`;
  assert.deepEqual(closesStoryRefs(body), ["PS-X/story-a", "PS-X/story-b"], "a fenced line does not count");
  const c = readyStory({ id: "story-c" });
  const fx = flowVault({
    stories: { "PS-X/story-a": readyStory(), "PS-X/story-b": readyStory({ id: "story-b" }), "PS-X/story-c": c },
  });
  const stub = stubOf({ prs: [openPr(9, { body, updatedAt: "2026-11-05T00:00:00Z" })] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  for (const slug of ["story-a", "story-b"]) {
    const t = read(pathOf(fx, slug));
    assert.equal(externalRefs(t).map.pr, prUrl(9));
    const log = parseStatusLog(t).slice(-2);
    assert.equal(log[0].line, `- ${log[0].at} status: in-progress → review — pull request ready: ${prUrl(9)} (follow)`);
    assert.equal(log[1].line, `- ${log[1].at} pr: none → ${prUrl(9)} — linked from Closes-story (follow)`);
  }
  assert.equal(read(pathOf(fx, "story-c")), c);
});

// [follow#3]
test("links: a fork's line, a fork's line naming no story, a line to another base and a branch named after a story record nothing and report nothing (edge)", async () => {
  const a = readyStory();
  const fx = flowVault({ stories: { "PS-X/story-a": a } });
  const stub = stubOf({
    prs: [
      openPr(10, { isCrossRepository: true, body: closes("PS-X/story-a") }),
      openPr(11, { isCrossRepository: true, body: closes("PS-X/story-nope") }),
      openPr(12, { baseRefName: "release", body: closes("PS-X/story-a") }),
      openPr(13, { headRefName: "story-a" }),
    ],
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(r.r.findings, []);
  assert.deepEqual(r.r.notes, []);
  assert.equal(read(pathOf(fx, "story-a")), a);
  assert.equal(r.r.checked, 0);
});

// [follow#3]
test('links: a flow map with unquoted keys, {issue: "x-1"}, keeps issue and gains pr when a body line\'s link is recorded (edge)', async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": setFm(readyStory(), "external_refs", '{issue: "x-1"}') } });
  const stub = stubOf({ prs: [openPr(9, { body: closes("PS-X/story-a") })] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(externalRefs(read(pathOf(fx, "story-a"))).map, { issue: "x-1", pr: prUrl(9) });
});

// [follow#3]
test("links: a field closed unmerged, and two newer counted pull requests naming the story: the url is replaced by the later createdAt, with the replaced line", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(toReview(readyStory(), "2026-11-01T12:00:00.000Z"), 5) } });
  const stub = stubOf({
    prs: [
      closedPr(5, { createdAt: "2026-10-25T08:00:00Z" }),
      openPr(6, { createdAt: "2026-11-01T08:00:00Z", body: closes("PS-X/story-a") }),
      openPr(7, { createdAt: "2026-11-02T08:00:00Z", body: closes("PS-X/story-a") }),
    ],
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const t = read(pathOf(fx, "story-a"));
  assert.equal(externalRefs(t).map.pr, prUrl(7));
  const last = parseStatusLog(t).at(-1);
  assert.equal(last.line, `- ${last.at} pr: ${prUrl(5)} → ${prUrl(7)} — replaced a closed pull request (follow)`);
  assert.equal(fm(t).status, "review", "judged by the open pull request that replaced it");
});

// [follow#3]
test("links: two open pull requests naming one story with an empty field give pr-conflict, and an open one's line naming no story gives pr-story-unknown, exit 1 (failure)", async () => {
  const a = readyStory();
  const fx = flowVault({ stories: { "PS-X/story-a": a } });
  const stub = stubOf({
    prs: [
      openPr(8, { body: closes("PS-X/story-a") }),
      openPr(9, { body: closes("PS-X/story-a") }),
      openPr(10, { body: closes("PS-X/story-nope") }),
    ],
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 1);
  assert.equal(read(pathOf(fx, "story-a")), a);
  assert.deepEqual(codes(r.r.findings).sort(), ["pr-conflict", "pr-story-unknown"]);
  const unknown = r.r.findings.find((f) => f.code === "pr-story-unknown");
  assert.equal(unknown.pr, prUrl(10));
  assert.match(unknown.message, /PS-X\/story-nope/);
});

// [follow#3] [follow#4]
test("links: a planned story named by a merged pull request gets the link and pr-before-plan only; a done story whose field names another merged one, also named, is untouched with a pr-conflict note (edge)", async () => {
  const d = linked(storyText({ id: "story-d", status: "done" }), 7);
  const p = byHand("story-p", "planned");
  const fx = flowVault({
    stories: { "PS-X/story-p": p, "PS-X/story-d": d, "PS-X/story-w": byHand("story-w", "in-progress") },
  });
  const stub = stubOf({
    prs: [mergedPr(7), mergedPr(8, { body: closes("PS-X/story-d") }), mergedPr(9, { body: closes("PS-X/story-p") })],
  });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const t = read(pathOf(fx, "story-p"));
  assert.equal(fm(t).status, "planned");
  assert.equal(externalRefs(t).map.pr, prUrl(9));
  assert.deepEqual(
    parseStatusLog(t).map((e) => e.field),
    ["pr"],
    "the link and nothing else",
  );
  assert.deepEqual(
    r.r.notes.filter((n) => n.story === "PS-X/story-p" && n.code !== "epic-row-missing").map((n) => n.code),
    ["pr-before-plan"],
  );
  assert.equal(read(pathOf(fx, "story-d")), d);
  assert.deepEqual(
    r.r.notes.filter((n) => n.story === "PS-X/story-d" && n.code !== "epic-row-missing").map((n) => n.code),
    ["pr-conflict"],
  );
});

// [follow#3] [follow#1]
test("links: a story moved from a closed pull request, whose body still holds its line, to an open one is no conflict, exit 0 (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(toReview(readyStory(), "2026-11-01T12:00:00.000Z"), 2) } });
  const stub = stubOf({ prs: [closedPr(1, { body: closes("PS-X/story-a") }), openPr(2)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(r.r.findings, []);
  assert.ok(!codes(r.r.notes).includes("pr-conflict"));
  assert.equal(externalRefs(read(pathOf(fx, "story-a"))).map.pr, prUrl(2));
  // Alone, the closed pull request's line links nothing either, and its line
  // naming no story is not read: no pr-story-unknown, while a merged one's is a note.
  const empty = readyStory({ id: "story-b" });
  const fx2 = flowVault({ stories: { "PS-X/story-b": empty } });
  const r2 = await follow(
    fx2,
    stubOf({
      prs: [
        closedPr(1, { body: closes("PS-X/story-b", "PS-X/story-nope") }),
        mergedPr(3, { body: closes("PS-X/story-gone") }),
      ],
    }),
    ["--write"],
  );
  assert.equal(r2.code, 0, JSON.stringify(r2.r.findings));
  assert.equal(read(pathOf(fx2, "story-b")), empty);
  assert.deepEqual(
    r2.r.notes.filter((n) => n.code === "pr-story-unknown").map((n) => n.pr),
    [prUrl(3)],
  );
});

// ─── Contract 4: the rows before the close ─────────────────────────────

// [follow#4]
test("rows: a review story closed unmerged and one back to draft go to in-progress, an in-progress one with no trusted stamp and a ready pull request to review, each at the run time", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(toReview(readyStory(), "2026-11-01T12:00:00.000Z"), 5),
      "PS-X/story-b": linked(toReview(readyStory({ id: "story-b" }), "2026-11-01T12:00:00.000Z"), 6),
      "PS-X/story-c": linked(byHand("story-c", "in-progress"), 7),
    },
  });
  const stub = stubOf({ prs: [closedPr(5), openPr(6, { isDraft: true }), openPr(7)] });
  const t0 = Date.now();
  const r = await follow(fx, stub, ["--write"]);
  const t1 = Date.now();
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  for (const [slug, to, reason] of [
    ["story-a", "in-progress", `pull request closed unmerged: ${prUrl(5)}`],
    ["story-b", "in-progress", `pull request back to draft: ${prUrl(6)}`],
    ["story-c", "review", `pull request ready: ${prUrl(7)}`],
  ]) {
    const t = read(pathOf(fx, slug));
    const last = parseStatusLog(t).at(-1);
    assert.equal(fm(t).status, to, slug);
    assert.equal(last.reason, reason);
    assert.equal(last.actor, "follow");
    const ms = Date.parse(last.at);
    assert.ok(ms >= t0 - 1000 && ms <= t1 + 1000, `${slug}: at the run time (${last.at})`);
    assert.equal(fm(t).status_changed_at, last.at);
  }
});

// [follow#4]
test("rows: with flow.age_days.review 10, a review whose trusted stamp is 10 whole days old goes to in-progress, and one 9 days old stays (edge)", async () => {
  const ago = (days) => new Date(Date.now() - days * DAY_MS - 3600e3).toISOString();
  const fx = flowVault({
    vaultCfg: { flow: { age_days: { review: 10 } } },
    stories: {
      "PS-X/story-9": linked(toReview(readyStory({ id: "story-9" }), ago(9)), 8),
      "PS-X/story-10": linked(toReview(readyStory({ id: "story-10" }), ago(10)), 9),
    },
  });
  const nine = read(pathOf(fx, "story-9"));
  const stub = stubOf({ prs: [openPr(8), openPr(9)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.equal(read(pathOf(fx, "story-9")), nine);
  const t = read(pathOf(fx, "story-10"));
  assert.equal(fm(t).status, "in-progress");
  assert.equal(parseStatusLog(t).at(-1).reason, "review older than 10 days");
});

// [follow#4]
test("rows: a review 40 days old whose stamp is not trusted is unchanged with and without flow.age_days.review (edge)", async () => {
  const old = new Date(Date.now() - 40 * DAY_MS).toISOString().slice(0, 10);
  const s = linked(byHand("story-a", "review", { created: old, updated: old }), 8);
  for (const vaultCfg of [null, { flow: { age_days: { review: 10 } } }]) {
    const fx = flowVault({ vaultCfg, stories: { "PS-X/story-a": s } });
    const r = await follow(fx, stubOf({ prs: [openPr(8)] }), ["--write"]);
    assert.equal(r.code, 0, JSON.stringify(r.r.findings));
    assert.equal(read(pathOf(fx, "story-a")), s, JSON.stringify(vaultCfg));
  }
});

// [follow#4]
test("rows: a story follow returned to in-progress for age stays while its pull request's updatedAt is earlier than that line, and goes to review once a push makes it later (edge)", async () => {
  const back = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const s = setFm(
    withLine(toReview(readyStory(), "2026-10-01T09:00:00.000Z"), {
      at: back,
      from: "review",
      to: "in-progress",
      reason: "review older than 10 days",
    }),
    "status",
    "in-progress",
  );
  const fx = flowVault({ vaultCfg: { flow: { age_days: { review: 10 } } }, stories: { "PS-X/story-a": linked(s, 8) } });
  const before = read(pathOf(fx, "story-a"));
  assert.equal(statusStamp(before).trusted, true);
  const stub = stubOf({ prs: [openPr(8, { updatedAt: new Date(Date.parse(back) - DAY_MS).toISOString() })] });
  assert.equal((await follow(fx, stub, ["--write"])).code, 0);
  assert.equal(read(pathOf(fx, "story-a")), before);
  stub.set({ prs: [openPr(8, { updatedAt: new Date(Date.parse(back) + 3600e3).toISOString() })] });
  assert.equal((await follow(fx, stub, ["--write"])).code, 0);
  const t = read(pathOf(fx, "story-a"));
  assert.equal(fm(t).status, "review");
  assert.equal(parseStatusLog(t).at(-1).reason, `pull request ready: ${prUrl(8)}`);
});

// [follow#4]
test("rows: a story follow closed and a person edited back to in-progress is unchanged with pr-merged-reopened; a merged story whose plan gate ran after mergedAt is judged for the close (edge)", async () => {
  const reopened = setFm(linked(closeForMerge(readyStory()).written, 7), "status", "in-progress");
  const LATE = "2026-11-05T09:00:00.000Z";
  const late = linked(readyStory({ id: "story-b" }).split(STARTED).join(LATE), 8);
  const fx = flowVault({ stories: { "PS-X/story-a": reopened, "PS-X/story-b": late } });
  const r = await follow(fx, stubOf({ prs: [mergedPr(7), mergedPr(8)] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.equal(read(pathOf(fx, "story-a")), reopened);
  assert.ok(r.r.notes.some((n) => n.code === "pr-merged-reopened" && n.story === "PS-X/story-a"));
  const t = read(pathOf(fx, "story-b"));
  assert.equal(fm(t).status, "done");
  assert.equal(fm(t).closed_at, LATE, "held to the floor: the plan gate's line");
});

// [follow#4]
test("rows: a planned story whose pull request merged, a done and a parked story with open pull requests, and a review story merged into another branch are unchanged, with pr-before-plan and pr-merged-elsewhere, exit 0 (edge)", async () => {
  const stories = {
    "PS-X/story-p": linked(byHand("story-p", "planned"), 5),
    "PS-X/story-d": linked(byHand("story-d", "done"), 6),
    "PS-X/story-k": linked(byHand("story-k", "parked"), 7),
    "PS-X/story-e": linked(toReview(readyStory({ id: "story-e" }), "2026-11-01T12:00:00.000Z"), 8),
  };
  const fx = flowVault({ stories });
  const before = snapshot(fx);
  const r = await follow(
    fx,
    stubOf({ prs: [mergedPr(5), openPr(6), openPr(7), mergedPr(8, { baseRefName: "release" })] }),
    ["--write"],
  );
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  for (const slug of ["story-p", "story-d", "story-k", "story-e"]) {
    const rel = `epics/PS-X/stories/${slug}.md`;
    assert.equal(read(join(fx.vault, rel)), before[rel], slug);
  }
  const mine = (slug) =>
    r.r.notes.filter((n) => n.story === `PS-X/${slug}` && n.code !== "epic-row-missing").map((n) => n.code);
  assert.deepEqual(mine("story-p"), ["pr-before-plan"]);
  assert.deepEqual(mine("story-e"), ["pr-merged-elsewhere"]);
  assert.deepEqual(mine("story-d"), []);
  assert.deepEqual(mine("story-k"), []);
});

// ─── Contract 6, scenario 4: the same run's pr: line ───────────────────

// [follow#6]
test("stamps: a story whose pr: none → <url> line the same run writes at the run time, with mergedAt earlier, is stamped at mergedAt, and its status: line comes before the pr: line (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": readyStory() } });
  const r = await follow(fx, stubOf({ prs: [mergedPr(9, { body: closes("PS-X/story-a") })] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  const t = read(pathOf(fx, "story-a"));
  assert.equal(fm(t).status, "done");
  assert.equal(fm(t).closed_at, MERGED);
  assert.equal(fm(t).status_changed_at, MERGED);
  const log = parseStatusLog(t);
  assert.deepEqual(
    log.slice(-2).map((e) => e.field),
    ["status", "pr"],
  );
  assert.equal(log.at(-2).at, MERGED);
  assert.ok(Date.parse(log.at(-1).at) > Date.parse(MERGED), "the pr: line is at the run time");
  assert.equal(log.at(-1).line, `- ${log.at(-1).at} pr: none → ${prUrl(9)} — linked from Closes-story (follow)`);
});

// ─── Contract 7: the awaiting line ─────────────────────────────────────

// [follow#7] [SPEC-001#8]
test("awaiting: a merged in-progress story with one unchecked criterion goes to review, awaiting evidence, at mergedAt with the same stamp; written once; closed at mergedAt once the criterion carries evidence", async () => {
  const criteria = ["- [x] it works — evidence: tests/a.test.mjs", "- [ ] the second part"];
  const inProgress = linked(readyStory({ criteria }), 7);
  const inReview = linked(toReview(readyStory({ id: "story-b", criteria }), "2026-11-01T12:00:00.000Z"), 8);
  const fx = flowVault({ stories: { "PS-X/story-a": inProgress, "PS-X/story-b": inReview } });
  const stub = stubOf({ prs: [mergedPr(7), mergedPr(8)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  for (const [slug, from, n] of [
    ["story-a", "in-progress", 7],
    ["story-b", "review", 8],
  ]) {
    const t = read(pathOf(fx, slug));
    assert.equal(fm(t).status, "review", slug);
    assert.equal(
      parseStatusLog(t).at(-1).line,
      `- ${MERGED} status: ${from} → review — merged, awaiting evidence: ${prUrl(n)} (follow)`,
    );
    assert.equal(fm(t).status_changed_at, MERGED);
    assert.equal(isAwaitingClose(t), true, slug);
    const note = r.r.notes.find((x) => x.code === "awaiting-close" && x.story === `PS-X/${slug}`);
    assert.ok(note && note.message.includes("the second part") && note.pr === prUrl(n), JSON.stringify(r.r.notes));
  }
  // Written once: a second run leaves both files byte-identical.
  const after = snapshot(fx);
  const again = await follow(fx, stub, ["--write"]);
  assert.equal(again.code, 0);
  assert.equal(read(pathOf(fx, "story-a")), after["epics/PS-X/stories/story-a.md"]);
  assert.equal(read(pathOf(fx, "story-b")), after["epics/PS-X/stories/story-b.md"]);
  assert.ok(
    again.r.notes.some((x) => x.code === "awaiting-close"),
    "the note stays while the refusal holds",
  );
  // The criterion checked with evidence by hand: the next run closes it, stamped at mergedAt.
  const p = pathOf(fx, "story-a");
  writeFileSync(p, read(p).replace("- [ ] the second part", "- [x] the second part — evidence: tests/b.test.mjs"));
  assert.equal((await follow(fx, stub, ["--write"])).code, 0);
  const done = read(p);
  assert.equal(fm(done).status, "done");
  assert.equal(fm(done).closed_at, MERGED);
  assert.equal(
    parseStatusLog(done).at(-1).line,
    `- ${MERGED} status: review → done — merged: ${prUrl(7)} at ${SHA} (follow)`,
  );
  // Closed instead by a person through the close gate: the gate's run time.
  const t0 = Date.now();
  const gate = computeClose(read(pathOf(fx, "story-b")), {}).text;
  assert.ok(Date.parse(fm(gate).closed_at) >= t0 - 1000, fm(gate).closed_at);
  assert.equal(fm(gate).status_changed_at, fm(gate).closed_at);
});

// ─── Contract 8: the writes ────────────────────────────────────────────

// [follow#8]
test("writes: a story edited once between the read and the replace keeps the edit under the change; one changed before each of three replaces gives story-changed-meanwhile and is left, exit 1 (failure)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(reviewOf(readyStory()), 7),
      "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 8),
    },
  });
  const a = pathOf(fx, "story-a");
  const b = pathOf(fx, "story-b");
  const stub = stubOf({ prs: [mergedPr(7), mergedPr(8)] });
  const afterCompute = (i, s) => {
    if (s.ref === "PS-X/story-a" && i === 0)
      writeFileSync(a, read(a).replace("## Dependencies", "A hand note.\n\n## Dependencies"));
    if (s.ref === "PS-X/story-b") writeFileSync(b, read(b).replace("## Dependencies", `edit ${i}\n\n## Dependencies`));
  };
  const r = await followDirect(fx, stub, { write: true }, { afterCompute });
  assert.equal(r.code, 1);
  const ta = read(a);
  assert.equal(fm(ta).status, "done");
  assert.ok(ta.includes("A hand note."), "the edit is kept under the change");
  const tb = read(b);
  assert.equal(fm(tb).status, "review");
  assert.ok(tb.includes("edit 2") && tb.includes("edit 0"), "left as its last editor left it");
  const f = r.result.findings.find((x) => x.code === "story-changed-meanwhile");
  assert.equal(f.story, "PS-X/story-b");
});

// [follow#8]
test("writes: a done story whose epic row still reads review gets its row set to done, and a story whose epic has no row gives epic-row-missing (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-d": linked(byHand("story-d", "done"), 6),
      "PS-X/story-a": linked(reviewOf(readyStory()), 7),
    },
  });
  const epic = join(fx.vault, "epics", "PS-X", "epic.md");
  writeFileSync(
    epic,
    read(epic) + "\n## Stories\n\n| Story | Status |\n|-------|--------|\n| [d](./stories/story-d.md) | review |\n",
  );
  const r = await follow(fx, stubOf({ prs: [mergedPr(6), mergedPr(7)] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.match(read(epic), /\| \[d\]\(\.\/stories\/story-d\.md\) \| done \|/);
  assert.deepEqual(
    r.r.notes.filter((n) => n.code === "epic-row-missing").map((n) => n.story),
    ["PS-X/story-a"],
  );
});

// A vault that is its own git repository, every file committed on main.
function gitVaultOf(fx) {
  gitIn(fx.vault, ["init", "-q"]);
  gitIn(fx.vault, ["add", "-A"]);
  return gitCommit(fx.vault, { message: "seed" });
}

// [follow#8]
test("writes: a story a linked worktree's branch edited, or added, is unchanged with story-on-branch; one whose copy only lags trunk is written, exit 1 (edge)", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(reviewOf(readyStory()), 7),
      "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 8),
    },
  });
  gitVaultOf(fx);
  const w1 = join(mkdtempSync(join(tmpdir(), "ps-wt-")), "w1");
  const w2 = join(mkdtempSync(join(tmpdir(), "ps-wt-")), "w2");
  gitIn(fx.vault, ["worktree", "add", "-q", "-b", "b1", w1]);
  gitIn(fx.vault, ["worktree", "add", "-q", "-b", "b2", w2]);
  const rel = (slug) => `epics/PS-X/stories/${slug}.md`;
  // The branch edits story-a; trunk then changes story-b and adds story-c, which the branch adds too.
  writeFileSync(join(w1, rel("story-a")), read(pathOf(fx, "story-a")) + "\nbranch note\n");
  const c = linked(reviewOf(readyStory({ id: "story-c" })), 9);
  gitCommit(fx.vault, {
    files: { [rel("story-b")]: read(pathOf(fx, "story-b")) + "\ntrunk note\n", [rel("story-c")]: c },
    message: "trunk",
  });
  writeFileSync(join(w1, rel("story-c")), c);
  const a = read(pathOf(fx, "story-a"));
  const r = await follow(fx, stubOf({ prs: [mergedPr(7), mergedPr(8), mergedPr(9)] }), ["--write"]);
  assert.equal(r.code, 1);
  assert.equal(read(pathOf(fx, "story-a")), a);
  assert.equal(read(pathOf(fx, "story-c")), c);
  assert.deepEqual(
    r.r.findings
      .filter((f) => f.code === "story-on-branch")
      .map((f) => f.story)
      .sort(),
    ["PS-X/story-a", "PS-X/story-c"],
  );
  assert.equal(fm(read(pathOf(fx, "story-b"))).status, "done", "a copy that only lags trunk does not block");
});

// [follow#8]
test("writes: a vault outside git runs no git and exits 0; a vault where git worktree list fails gives branches-unknown and exits 1; both are written (edge)", async () => {
  const seam = (fail) => {
    const real = defaultGit(process.env);
    const g = (root, args) => {
      g.calls.push(args);
      if (fail && args[0] === "worktree")
        return { kind: "answer", status: 128, stdout: Buffer.alloc(0), stderr: "fatal: cannot list\n" };
      return real(root, args);
    };
    g.calls = [];
    return g;
  };
  const outside = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const g1 = seam(false);
  const r1 = await followDirect(outside, stubOf({ prs: [mergedPr(7)] }), { write: true }, { git: g1 });
  assert.equal(r1.code, 0, JSON.stringify(r1.result.findings));
  assert.deepEqual(g1.calls, [], "no git runs in a vault outside git");
  assert.equal(fm(read(pathOf(outside, "story-a"))).status, "done");
  const inside = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  gitVaultOf(inside);
  const g2 = seam(true);
  const r2 = await followDirect(inside, stubOf({ prs: [mergedPr(7)] }), { write: true }, { git: g2 });
  assert.equal(r2.code, 1);
  assert.deepEqual(codes(r2.result.findings), ["branches-unknown"]);
  assert.deepEqual(g2.calls, [["worktree", "list", "--porcelain"]], "git worktree list is read once");
  assert.equal(fm(read(pathOf(inside, "story-a"))).status, "done");
});

// The vault's stale-view findings, as `doctor --vault` reports them.
function staleViews(proj) {
  const r = spawnSync(
    process.execPath,
    [join(REPO, "bin", "projectstore.mjs"), "doctor", "--vault", "--json", "--project", proj],
    { encoding: "utf8", timeout: 60000 },
  );
  return JSON.parse(r.stdout).result.filter(
    (f) => ["kanban", "graph", "code-map", "index"].includes(f.check) && f.level !== "info",
  );
}

// [follow#8]
test("writes: after a run that closed two stories and moved a third to in-progress, a second run on the same facts writes nothing, and doctor reports no stale view", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": linked(reviewOf(readyStory()), 7),
      "PS-X/story-b": linked(reviewOf(readyStory({ id: "story-b" })), 8),
      "PS-X/story-c": linked(reviewOf(readyStory({ id: "story-c" })), 9),
    },
  });
  writeFileSync(join(fx.vault, "kanban.md"), "stub board\n");
  writeFileSync(join(fx.vault, "graph.md"), "stub graph\n");
  const stub = stubOf({ prs: [mergedPr(7), mergedPr(8), closedPr(9)] });
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r));
  assert.deepEqual(
    ["story-a", "story-b", "story-c"].map((s) => fm(read(pathOf(fx, s))).status),
    ["done", "done", "in-progress"],
  );
  const after = snapshot(fx);
  const again = await follow(fx, stub, ["--write"]);
  assert.equal(again.code, 0);
  assert.deepEqual(again.r.items, []);
  assert.equal(again.r.reconcile.written, 0);
  assert.deepEqual(snapshot(fx), after, "nothing is written");
  assert.deepEqual(staleViews(fx.proj), []);
});

// [follow#8] [writerecord#5]
test("writes: in a session, follow --write records the story it closes and each write of its epic's epic.md, the row and the done, with the tool follow", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const epic = join(fx.vault, "epics", "PS-X", "epic.md");
  writeFileSync(
    epic,
    read(epic) + "\n## Stories\n\n| Story | Status |\n|-------|--------|\n| [a](./stories/story-a.md) | review |\n",
  );
  const sidEnv = sourceHarness().runtime.session_id_env;
  const stub = stubOf({ prs: [mergedPr(7)] });
  const r = await follow(fx, stub, ["--write"], { env: stub.env({ ...process.env, [sidEnv]: "s-follow" }) });
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(r.r.epics.moved, ["PS-X"]);
  const ev = readEvents(fx.proj, "s-follow");
  assert.deepEqual(
    ev.map((e) => [e.rel, e.tool]),
    [
      ["epics/PS-X/stories/story-a.md", "follow"],
      ["epics/PS-X/epic.md", "follow"],
      ["epics/PS-X/epic.md", "follow"],
    ],
  );
  assert.ok(!ev.some((e) => e.rel === "kanban.md"), "the views it refreshes are not recorded");
});

// ─── Contract 9: the epic ──────────────────────────────────────────────

const withResults = (fx, items, epicId = "PS-X") => {
  const epic = join(fx.vault, "epics", epicId, "epic.md");
  writeFileSync(epic, `${read(epic)}\n## Expected Results\n\n${items.join("\n")}\n`);
  return epic;
};

// [follow#9]
test("epic: an epic whose last open story follow will close, every Expected Result checked, is listed with to: done by the plan and written nothing, then made done by --write", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const epic = withResults(fx, ["- [x] it works"]);
  const stub = stubOf({ prs: [mergedPr(7)] });
  const before = snapshot(fx);
  const plan = await follow(fx, stub);
  assert.equal(plan.code, 0);
  assert.deepEqual(
    plan.r.epics.epics.map((e) => [e.epic, e.to]),
    [["PS-X", "done"]],
  );
  assert.deepEqual(snapshot(fx), before);
  const r = await follow(fx, stub, ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.deepEqual(r.r.epics.moved, ["PS-X"]);
  assert.equal(fm(read(epic)).status, "done");
});

// [follow#9]
test("epic: with one Expected Result unchecked the epic stays, epics.notes holds epic-results-open and notes does not, exit 0 (edge)", async () => {
  const fx = flowVault({ stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7) } });
  const epic = withResults(fx, ["- [x] it works", "- [ ] it scales"]);
  const before = read(epic);
  const r = await follow(fx, stubOf({ prs: [mergedPr(7)] }), ["--write"]);
  assert.equal(r.code, 0, JSON.stringify(r.r.findings));
  assert.equal(fm(read(epic)).status, fm(before).status);
  assert.deepEqual(codes(r.r.epics.notes), ["epic-results-open"]);
  assert.ok(!codes(r.r.notes).includes("epic-results-open"));
});

// [follow#9]
test("epic: a second epic whose epic.md cannot be read is listed with verdict error and exits 1, while the story elsewhere is done (failure)", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root reads a file of mode 000");
  const fx = flowVault({
    stories: { "PS-X/story-a": linked(reviewOf(readyStory()), 7), "PS-Y/story-y": byHand("story-y", "in-progress") },
  });
  const other = join(fx.vault, "epics", "PS-Y", "epic.md");
  chmodSync(other, 0o000);
  try {
    const r = await follow(fx, stubOf({ prs: [mergedPr(7)] }), ["--write"]);
    assert.equal(r.code, 1);
    assert.equal(fm(read(pathOf(fx, "story-a"))).status, "done");
    assert.deepEqual(
      r.r.epics.epics.filter((e) => e.verdict === "error").map((e) => e.epic),
      ["PS-Y"],
    );
  } finally {
    chmodSync(other, 0o644);
  }
});

// ─── Contract 11: /projectstore:follow (verified: manual), text pins ──

// [follow#11]
test("commands/follow.md and its generated copies call the bin's follow with declared flags only, show the plan, ask once, then run --write; no clerk, never npx", () => {
  const copies = [
    "commands/follow.md",
    "adapters/codex/skills/projectstore-follow/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-follow/SKILL.md",
  ];
  for (const rel of copies) {
    const src = read(join(REPO, rel));
    // The source names the host's root and project; the Codex copies their own (build-adapters.mjs).
    const calls = [
      ...src.matchAll(
        /node "\$\{(?:CLAUDE_PLUGIN_ROOT|PROJECTSTORE_CORE_ROOT)\}\/bin\/projectstore\.mjs" (\S+)([^\n`]*)/g,
      ),
    ];
    assert.equal(calls.length, 2, `${rel}: the plan and the write`);
    for (const [, verb, rest] of calls) {
      assert.equal(verb, "follow", rel);
      for (const f of rest.matchAll(/--([a-z-]+)/g))
        assert.ok(["write", "json", "project", "story", "pr"].includes(f[1]), `${rel}: --${f[1]}`);
      assert.match(
        rest,
        rel.startsWith("commands/") ? /--project "\$\{CLAUDE_PROJECT_DIR\}"/ : /--project "\$PWD"/,
        rel,
      );
    }
    assert.ok(!/--write/.test(calls[0][2]) && /--write/.test(calls[1][2]), `${rel}: the plan first, then --write`);
    assert.ok(!/npx /.test(src), `${rel}: never npx`);
    assert.ok(!/projectstore:clerk/.test(src), `${rel}: no clerk runs`);
    assert.match(src, /gh-unavailable/);
    assert.match(src, /Ask once/);
  }
});

// ─── Reach ─────────────────────────────────────────────────────────────

// Source guard (no contract token: doctor would count it as coverage).
test("source guard: no hook and no MCP module reaches follow.mjs, follow-gh.mjs or follow-plan.mjs, and only follow.mjs imports follow-gh.mjs", async () => {
  const { VERBS } = await import("../scripts/cli.mjs");
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp];
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  for (const entry of entries) {
    const files = closure(entry, { root: REPO, dispatch });
    for (const m of ["scripts/follow.mjs", "scripts/follow-gh.mjs", "scripts/follow-plan.mjs"])
      assert.ok(!files.includes(m), `${entry} reaches ${m}`);
  }
  // Not vacuous: the bin's table reaches follow.mjs, which reaches the adapter.
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/follow-gh.mjs"));
  const importers = readdirSync(join(REPO, "scripts")).filter(
    (f) => f.endsWith(".mjs") && /from "\.\/follow-gh\.mjs"/.test(read(join(REPO, "scripts", f))),
  );
  assert.deepEqual(importers, ["follow.mjs"]);
});

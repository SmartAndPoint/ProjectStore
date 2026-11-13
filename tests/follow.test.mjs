// projectstore — tests/follow.test.mjs: a merged pull request closes its story
// through the close computation, and a stale review goes back (PS-FLOW, "A
// merged pull request moves its story to done through the close gate…"; the
// spec "The follow verb…", alias `follow`, and SPEC-001 contracts 3, 7 and 8
// as amended 2026-11-12). This file holds the offline close machinery, pull
// request A: the close for a merge (contract 5) and its stamps and floor
// (contract 6), as pure functions — computeClose, follow-plan.mjs and
// doctor's storyCloseFindings — with a parity test of the refusal against
// doctor on the same vault. The `gh` adapter, the rows and the verb come
// with pull request B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
import { storyText, flowVault, commitsSeam } from "./fixtures/flow.mjs";
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

  const citing = readyStory({ criteria: ["- [x] it works — evidence: tests/a.test.mjs [covering#9]"] });
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

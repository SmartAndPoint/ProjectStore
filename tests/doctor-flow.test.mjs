// projectstore — tests/doctor-flow.test.mjs: doctor's flow group (PS-FLOW,
// "Doctor checks the flow against the vault's policy: WIP per person, age in
// status, idle assignees, intake against close, and ToDo against capacity").
//
// The group runs through runVaultChecks(cfg, { proj, now, commits }) on a
// fixture vault at a fixed instant (tests/fixtures/flow.mjs), with the
// `commits` seam stubbed and its calls counted; the git read itself runs on
// real fixture repositories. The scenarios are those of "Doctor's flow
// findings…" (alias `flow-findings`) and the "doctor runs" ones of "Flow
// counts…" (alias `flow-counts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runStartupChecks } from "../scripts/doctor.mjs";
import {
  checkFlow,
  FLOW_LEVELS,
  FLOW_CHECKS,
  namesOf,
  activityTime,
  handoverCommand,
} from "../scripts/doctor-flow.mjs";
import { packageCommand } from "../scripts/harness.mjs";
import { fromTerminalIn } from "../scripts/lib.mjs";
import { commitsSince, ACTIVITY_REASONS } from "../scripts/diff-refs.mjs";
import { refCovers } from "../scripts/code-refs.mjs";
import { isEmailAddress } from "../scripts/flow-policy.mjs";
import { loadLayout } from "../scripts/lib.mjs";
import { AWAITING_REASON } from "../scripts/status-log.mjs";
import { ageDays } from "../scripts/flow-counts.mjs";
import {
  NOW,
  NOW_MS,
  DAY,
  ADDRESS,
  daysAgo,
  storyText,
  withLine,
  handOver,
  flowVault,
  commitsSeam,
  commit,
  doctorRun,
  flowOnly,
  ids,
  byCheck,
  git,
  gitRepo,
  gitCommit,
} from "./fixtures/flow.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const P = (flow) => ({ flow });
const ME = "First Last";
const js = (v) => JSON.stringify(v);

// Stories as the writers leave them.
const inProgress = (id, { assignee = ME, at = daysAgo(30), fm = {}, ...rest } = {}) =>
  storyText({ id, assignee, log: [{ to: "in-progress", at }], fm: { started_at: js(at), ...fm }, ...rest });
const inReview = (id, { assignee = ME, at = daysAgo(5), ...rest } = {}) =>
  storyText({
    id,
    assignee,
    log: [
      { to: "in-progress", at: new Date(Date.parse(at) - DAY).toISOString() },
      { to: "review", at },
    ],
    ...rest,
  });
const inTodo = (id, { at = daysAgo(5), ...rest } = {}) => storyText({ id, log: [{ to: "todo", at }], ...rest });
const done = (id, { created = "2026-09-01", closedAt = "2026-10-28T10:00:00.000Z", ...rest } = {}) =>
  storyText({ id, created, status: "done", fm: closedAt ? { closed_at: js(closedAt) } : {}, ...rest });
const planned = (id, opts = {}) => storyText({ id, ...opts });
const awaiting = (id, { assignee = ME, at = daysAgo(4) } = {}) =>
  withLine(inProgress(id, { assignee, at: daysAgo(20) }), {
    at,
    from: "in-progress",
    to: "review",
    reason: `${AWAITING_REASON}: <url>`,
  }).replace("status: in-progress", "status: review");

const flowRun = (fx, opts) => flowOnly(doctorRun(fx, opts));
const one = (findings, check) => {
  const f = byCheck(findings, check);
  assert.equal(f.length, 1, `one ${check}: ${JSON.stringify(flowOnly(findings).map((x) => x.check))}`);
  return f[0];
};
const none = (findings, check) => assert.equal(byCheck(findings, check).length, 0, `no ${check}`);
const many = (n, make) => Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));
const emailShaped = (s) => String(s).split(/\s+/).some(isEmailAddress);

// ─── Flow counts: the "doctor runs" scenarios ──────────────────────────

// [flow-counts#2]
test("which stories count: a story file that cannot be read leaves the other findings unchanged, and flow-stories-unread says 1 (failure)", () => {
  const fx = flowVault({
    vaultCfg: P({ age_days: { review: 3 } }),
    stories: { "PS-X/story-a": inReview("story-a", { at: daysAgo(5) }), "PS-X/story-b": planned("story-b") },
  });
  const layout = loadLayout(fx.cfg.layout);
  const vaultCfg = JSON.parse(readFileSync(join(fx.vault, ".projectstore.json"), "utf8"));
  const run = (read) =>
    checkFlow({ cfg: fx.cfg, layout, vaultCfg, proj: fx.proj, now: NOW, commits: commitsSeam(), read });
  const before = run(undefined);
  const after = run((p) => {
    if (p.endsWith("story-b.md")) throw new Error("EACCES");
    return readFileSync(p, "utf8");
  });
  assert.match(one(after, "flow-stories-unread").message, /^1 story file or folder could not be read/);
  assert.deepEqual(
    after.filter((f) => f.check !== "flow-stories-unread"),
    before,
  );
});

// [flow-counts#3]
test("age in status: a Review story with a trusted stamp 10 days old meets flow.age_days.review of 10, and one at 9 days does not", () => {
  const fx = flowVault({
    vaultCfg: P({ age_days: { review: 10 } }),
    stories: {
      "PS-X/story-ten": inReview("story-ten", { at: daysAgo(10) }),
      "PS-X/story-nine": inReview("story-nine", { at: daysAgo(9) }),
    },
  });
  const f = one(flowRun(fx), "review-aged");
  assert.equal(f.file, "epics/PS-X/stories/story-ten.md");
  assert.match(
    f.message,
    /^PS-X\/story-ten has been in review for 10 days, at or past flow\.age_days\.review of 10\.$/,
  );
});

// [flow-counts#3]
test("age in status: a story moved to review by hand after the plan gate is aged from updated, and status-unstamped counts it (edge)", () => {
  const hand = storyText({
    id: "story-hand",
    assignee: ME,
    log: [{ to: "in-progress", at: daysAgo(30) }],
    status: "review",
    updated: daysAgo(3).slice(0, 10),
  });
  const fx = flowVault({ vaultCfg: P({ age_days: { review: 3 } }), stories: { "PS-X/story-hand": hand } });
  const found = flowRun(fx);
  const f = one(found, "review-aged");
  assert.match(f.message, /in review for 3 days/);
  assert.match(f.message, /the age is read from updated, since the status stamp is not trusted/);
  const u = one(found, "status-unstamped");
  assert.match(u.message, /^1 story has its age in status read from updated or created/);
  assert.deepEqual(u.stories, ["epics/PS-X/stories/story-hand.md"]);
});

// [flow-counts#3]
test("age in status: a ToDo story past flow.age_days.todo gets todo-aged, naming the grooming pass and the move command on its own line", () => {
  const fx = flowVault({
    vaultCfg: P({ age_days: { todo: 14 } }),
    stories: { "PS-X/story-t": inTodo("story-t", { at: daysAgo(15) }) },
  });
  const f = one(flowRun(fx), "todo-aged");
  assert.equal(f.level, "info");
  assert.match(f.message, /grooming pass/);
  const lines = f.message.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith(`from a terminal in ${js(fx.proj)}:`), lines[0]);
  assert.equal(lines[1], "npx projectstore move PS-X/story-t planned --reason 'in ToDo for 15 days' --write");
});

// [flow-counts#3]
test("age in status: a story with no stamp, no updated and no created is read by no age check, and status-unstamped counts it apart (edge)", () => {
  const bare = storyText({ id: "story-bare", status: "review" })
    .replace(/^updated: .*\n/m, "")
    .replace(/^created: .*\n/m, "");
  const fx = flowVault({ vaultCfg: P({ age_days: { review: 1 } }), stories: { "PS-X/story-bare": bare } });
  const found = flowRun(fx);
  none(found, "review-aged");
  assert.equal(one(found, "status-unstamped").message, "1 story has no date at all and is not aged.");
});

// [flow-counts#5]
test("WIP: a person with wip 3 and four held stories, aliases included, gets one wip-over-limit naming 4, 3 and the four; at three, none", () => {
  const stories = {
    "PS-X/story-1": inProgress("story-1", { at: daysAgo(9) }),
    "PS-X/story-2": inProgress("story-2", { at: daysAgo(8), status: "in_progress" }),
    "PS-X/story-3": inReview("story-3", { at: daysAgo(7) }),
    "PS-X/story-4": inReview("story-4", { at: daysAgo(6) }),
  };
  const vaultCfg = P({ people: { [ME]: { wip: 3 } } });
  const f = one(flowRun(flowVault({ vaultCfg, stories })), "wip-over-limit");
  assert.equal(f.level, "warn");
  assert.match(f.message, /^First Last holds 4 stories in progress or review, over their WIP limit of 3: /);
  assert.equal(f.stories.length, 4);
  for (const n of [1, 2, 3, 4]) assert.match(f.message, new RegExp(`PS-X/story-${n}\\b`));
  delete stories["PS-X/story-4"];
  none(flowRun(flowVault({ vaultCfg, stories })), "wip-over-limit");
});

// [flow-counts#5]
test("WIP: a limit of 3 and five held stories, one awaiting close, names 4 and 1 awaiting; with four held, none (edge)", () => {
  const stories = {
    ...many(4, (i) => [`PS-X/story-${i}`, inProgress(`story-${i}`, { at: daysAgo(10 + i) })]),
    "PS-X/story-w": awaiting("story-w"),
  };
  const vaultCfg = P({ people: { [ME]: { wip: 3 } } });
  const f = one(flowRun(flowVault({ vaultCfg, stories })), "wip-over-limit");
  assert.match(f.message, /holds 4 stories in progress or review, over their WIP limit of 3/);
  assert.match(f.message, /1 more awaiting close is counted apart\.$/);
  assert.ok(!f.stories.includes("epics/PS-X/stories/story-w.md"));
  delete stories["PS-X/story-3"];
  none(flowRun(flowVault({ vaultCfg, stories })), "wip-over-limit");
});

// [flow-counts#5]
test("WIP: an assignee not in flow.people, and a person with time full and no flow.wip.full, are never reported (edge)", () => {
  const stories = {
    ...many(3, (i) => [`PS-X/story-o${i}`, inProgress(`story-o${i}`, { assignee: "Other Person" })]),
    ...many(3, (i) => [`PS-X/story-f${i}`, inProgress(`story-f${i}`)]),
  };
  const vaultCfg = P({ wip: { part: 1 }, people: { [ME]: { time: "full" } } });
  none(flowRun(flowVault({ vaultCfg, stories })), "wip-over-limit");
});

// [flow-counts#5]
test("WIP: constructor with wip 1 and two stories is over its limit; __proto__ holds one and has no limit (edge)", () => {
  const stories = {
    "PS-X/story-c1": inProgress("story-c1", { assignee: "constructor" }),
    "PS-X/story-c2": inProgress("story-c2", { assignee: "constructor" }),
    "PS-X/story-p1": inProgress("story-p1", { assignee: "__proto__" }),
  };
  const f = one(
    flowRun(flowVault({ vaultCfg: P({ people: { constructor: { wip: 1 } } }), stories })),
    "wip-over-limit",
  );
  assert.match(f.message, /^constructor holds 2 stories in progress or review, over their WIP limit of 1/);
});

// A window fixture: W weeks to 2026-11-09; `created` stories made in the
// window, `closed` done in it, and one old story so the vault is not young.
const windowed = ({ created = 0, closed = 0, extra = {}, flow = { window_weeks: 2 } } = {}) =>
  flowVault({
    vaultCfg: P(flow),
    stories: {
      "PS-X/story-old": planned("story-old", { created: "2026-08-01" }),
      ...many(created, (i) => [`PS-X/story-new${i}`, planned(`story-new${i}`, { created: "2026-10-27" })]),
      ...many(closed, (i) => [`PS-X/story-done${i}`, done(`story-done${i}`, { created: "2026-08-01" })]),
      ...extra,
    },
  });

// [flow-counts#6]
test("intake: 5 created and 3 closed give one intake-over-close naming 5, 3 and their weekly averages; 3 and 3, or 2 and 3, give none", () => {
  const f = one(flowRun(windowed({ created: 5, closed: 3 })), "intake-over-close");
  assert.equal(f.level, "warn");
  assert.match(f.message, /5 stories were created and 3 closed \(2\.5 and 1\.5 a week\)/);
  none(flowRun(windowed({ created: 3, closed: 3 })), "intake-over-close");
  none(flowRun(windowed({ created: 2, closed: 3 })), "intake-over-close");
});

// [flow-counts#6]
test("intake: a superseded story is not created, done stories with no closed_at are not closed, and closed-unstamped says 1 (edge)", () => {
  const extra = {
    "PS-X/story-sup": planned("story-sup", { created: "2026-10-28", status: "superseded" }),
    "PS-X/story-du": done("story-du", { closedAt: null, updated: "2026-10-29" }),
    "PS-X/story-db": done("story-db", { closedAt: null, updated: "2026-10-01" }),
  };
  const found = flowRun(windowed({ created: 1, closed: 1, extra }));
  none(found, "intake-over-close");
  const c = one(found, "closed-unstamped");
  assert.match(c.message, /^1 done story updated in the window has no closed_at/);
  assert.deepEqual(c.stories, ["epics/PS-X/stories/story-du.md"]);
});

// [flow-counts#6]
test("young vault: the earliest story created on the window's first day is judged; created the day after, one flow-window-young (edge)", () => {
  const vault = (first) =>
    flowVault({
      vaultCfg: P({ window_weeks: 2 }),
      stories: {
        "PS-X/story-first": planned("story-first", { created: first }),
        ...many(3, (i) => [`PS-X/story-n${i}`, planned(`story-n${i}`, { created: "2026-11-02" })]),
      },
    });
  const judged = flowRun(vault("2026-10-26"));
  one(judged, "intake-over-close");
  none(judged, "flow-window-young");
  const young = flowRun(vault("2026-10-27"));
  assert.match(one(young, "flow-window-young").message, /no counted story was created on or before 2026-10-26/);
  none(young, "intake-over-close");
});

// ToDo against capacity: W weeks, `closed` closes in the window, `todo` ToDo.
const capacity = ({ weeks = 4, bounds = [2, 3], closed = 8, todo = 7, firstCreated = "2026-07-01" } = {}) =>
  flowVault({
    vaultCfg: P({ window_weeks: weeks, capacity_weeks: bounds }),
    stories: {
      "PS-X/story-old": planned("story-old", { created: firstCreated }),
      ...many(closed, (i) => [
        `PS-X/story-c${i}`,
        done(`story-c${i}`, { created: firstCreated, closedAt: "2026-11-02T10:00:00.000Z" }),
      ]),
      ...many(todo, (i) => [`PS-X/story-t${i}`, inTodo(`story-t${i}`, { created: firstCreated })]),
    },
  });

// [flow-counts#7]
test("capacity: 7 ToDo against 8 closes over 4 weeks and 2,3 is over, naming 7, 2 a week and 6; 6 ToDo is not", () => {
  const f = one(flowRun(capacity({ todo: 7 })), "todo-over-capacity");
  assert.equal(f.level, "warn");
  assert.match(f.message, /^ToDo holds 7 stories, above the 6 the team can do in 3 weeks at a throughput of 2 a week/);
  none(flowRun(capacity({ todo: 6 })), "todo-over-capacity");
});

// [flow-counts#7]
test("capacity: 3 ToDo against the same window and bounds is under, naming 3 and 4; 4 ToDo is not", () => {
  const f = one(flowRun(capacity({ todo: 3 })), "todo-under-capacity");
  assert.equal(f.level, "info");
  assert.match(f.message, /^ToDo holds 3 stories, below the 4 the team can do in 2 weeks/);
  const at4 = flowRun(capacity({ todo: 4 }));
  none(at4, "todo-under-capacity");
  none(at4, "todo-over-capacity");
});

// [flow-counts#7]
test("capacity: bounds 2.5,3, 6 closes over 4 weeks and 3 ToDo is under, since 1200 is below 1500 (edge)", () => {
  one(flowRun(capacity({ bounds: [2.5, 3], closed: 6, todo: 3 })), "todo-under-capacity");
});

// [flow-counts#7]
test("capacity: bounds 1.1,2, W 10, 100 closes and 11 ToDo is neither, since 11 × 10 × 100 equals 100 × 110 (edge)", () => {
  const found = flowRun(capacity({ weeks: 10, bounds: [1.1, 2], closed: 100, todo: 11, firstCreated: "2026-06-01" }));
  none(found, "todo-under-capacity");
  none(found, "todo-over-capacity");
});

// [flow-counts#7]
test("capacity: nothing closed in the window gives neither finding, and one todo-capacity-unknown says why (edge)", () => {
  const found = flowRun(capacity({ closed: 0, todo: 5 }));
  none(found, "todo-under-capacity");
  none(found, "todo-over-capacity");
  assert.match(one(found, "todo-capacity-unknown").message, /no throughput to measure ToDo against/);
});

// [flow-counts#7]
test("capacity: a vault younger than W 4 gets neither finding and no todo-capacity-unknown, and one flow-window-young (edge)", () => {
  const found = flowRun(capacity({ firstCreated: daysAgo(14).slice(0, 10), closed: 2, todo: 9 }));
  for (const c of ["todo-under-capacity", "todo-over-capacity", "todo-capacity-unknown", "intake-over-close"])
    none(found, c);
  one(found, "flow-window-young");
});

// ─── Contract 1: activity is a local commit ────────────────────────────

const SINCE = "2026-01-01T00:00:00Z";
const mine = (r, name = ME) => r.commits.filter((c) => c.authorName === name || c.committerName === name);

// [flow-findings#1]
test("activity: commits on a local branch not checked out, a remote-tracking branch only and a detached HEAD all count (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, author: "Other Person", at: "2026-10-01T10:00:00Z" });
  git(repo, ["checkout", "-q", "-b", "side"]);
  gitCommit(repo, { files: { "side.txt": "s" }, at: "2026-10-02T10:00:00Z" });
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "gone"]);
  const gone = gitCommit(repo, { files: { "gone.txt": "g" }, at: "2026-10-03T10:00:00Z" });
  git(repo, ["update-ref", "refs/remotes/origin/gone", gone]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["branch", "-q", "-D", "gone"]);
  git(repo, ["checkout", "-q", "--detach", "main"]);
  gitCommit(repo, { files: { "head.txt": "h" }, at: "2026-10-04T10:00:00Z" });
  const r = commitsSince(repo, SINCE);
  assert.equal(r.status, "ok");
  assert.deepEqual(
    mine(r)
      .map((c) => c.paths[0])
      .sort(),
    ["gone.txt", "head.txt", "side.txt"],
  );
});

// [flow-findings#1]
test("activity: a merge commit by the assignee and a stash entry they made do not count (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, author: "Other Person", at: "2026-10-01T10:00:00Z" });
  git(repo, ["checkout", "-q", "-b", "topic"]);
  gitCommit(repo, { files: { "t.txt": "t" }, author: "Other Person", at: "2026-10-02T10:00:00Z" });
  git(repo, ["checkout", "-q", "main"]);
  const who = {
    GIT_AUTHOR_NAME: ME,
    GIT_AUTHOR_EMAIL: "nobody",
    GIT_COMMITTER_NAME: ME,
    GIT_COMMITTER_EMAIL: "nobody",
    GIT_AUTHOR_DATE: "2026-10-03T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-03T10:00:00Z",
  };
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge topic", "topic"], who);
  writeFileSync(join(repo, "a.txt"), "changed");
  git(repo, ["stash", "push", "-q", "-m", "wip"], { ...who, GIT_AUTHOR_DATE: "2026-10-04T10:00:00Z" });
  assert.match(git(repo, ["stash", "list"]), /wip/);
  const r = commitsSince(repo, SINCE);
  assert.equal(r.status, "ok");
  assert.deepEqual(mine(r), []);
  assert.equal(r.commits.length, 2, "the two commits by the other person");
});

// [flow-findings#1]
test("activity: a .mailmap mapping F. Last to First Last, and a git_names entry flast, make both commits the person's (edge)", () => {
  const repo = gitRepo();
  writeFileSync(join(repo, ".mailmap"), `${ME} <fl>\n`);
  gitCommit(repo, { files: { "a.txt": "a" }, author: "F. Last", authorMail: "fl", at: "2026-10-01T10:00:00Z" });
  gitCommit(repo, { files: { "b.txt": "b" }, author: "flast", authorMail: "elsewhere", at: "2026-10-02T10:00:00Z" });
  const r = commitsSince(repo, SINCE);
  assert.deepEqual(
    r.commits.map((c) => c.authorName),
    ["flast", ME],
  );
  const names = new Set(namesOf(P({ people: { [ME]: { git_names: ["flast"] } } }), ME));
  assert.ok(r.commits.every((c) => activityTime(c, names) !== null));
});

// [flow-findings#1]
test("activity: a commit the assignee authored 20 days ago that another person committed 2 days ago is theirs, at age 20 (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, at: daysAgo(20), committer: "Other Person", committedAt: daysAgo(2) });
  const [c] = commitsSince(repo, daysAgo(30)).commits;
  assert.equal(ageDays(activityTime(c, new Set([ME])), NOW_MS), 20);
  assert.equal(ageDays(activityTime(c, new Set(["Other Person"])), NOW_MS), 2);
});

// [flow-findings#1]
test("activity: a commit the assignee authored 20 days ago and amended 2 days ago is at age 2 (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, at: daysAgo(20), committedAt: daysAgo(2) });
  const [c] = commitsSince(repo, daysAgo(30)).commits;
  assert.equal(ageDays(activityTime(c, new Set([ME])), NOW_MS), 2);
});

// ─── Contract 2: paths and code_refs ───────────────────────────────────

// [flow-findings#2]
test("paths: a commit touching docs/руководство.md touches a code_refs entry docs/, compared as written (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "docs/руководство.md": "x" }, at: "2026-10-01T10:00:00Z" });
  const [c] = commitsSince(repo, SINCE).commits;
  assert.deepEqual(c.paths, ["docs/руководство.md"]);
  assert.ok(c.paths.some((p) => refCovers("docs/", p)));
});

// [flow-findings#2]
test("paths: in a project in app/, a commit changing only infra/main.tf is the person's for assignee-idle and touches no code_refs (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "app/src/a.mjs": "a" }, at: daysAgo(40) });
  gitCommit(repo, { files: { "infra/main.tf": "t" }, at: daysAgo(1) });
  const app = join(repo, "app");
  const [latest] = commitsSince(app, daysAgo(30)).commits;
  assert.deepEqual(latest.paths, [], "the path outside the project is not listed");
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7, age_days: { in_progress_idle: 10 } }),
    stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(30), fm: { code_refs: js(["src/"]) } }) },
  });
  const found = flowRun(fx, { commits: (p, since) => commitsSince(app, since) });
  none(found, "assignee-idle");
  assert.equal(one(found, "in-progress-idle").file, "epics/PS-X/stories/story-a.md");
});

// [flow-findings#2]
test("paths: a story with empty code_refs, in an epic listing scripts/, counts its assignee's commit touching README.md (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ age_days: { in_progress_idle: 10 } }),
    stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(30) }) },
  });
  writeFileSync(
    join(fx.vault, "epics", "PS-X", "epic.md"),
    `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-01-01\ncode_refs: ["scripts/"]\n---\n\n# X\n`,
  );
  const seam = commitsSeam({ status: "ok", commits: [commit({ at: daysAgo(1), paths: ["README.md"] })] });
  none(flowRun(fx, { commits: seam }), "in-progress-idle");
  one(flowRun(fx), "in-progress-idle");
});

// ─── Contract 3: when git runs, and when it cannot answer ──────────────

// A directory holding a fake `git` that runs `body` (a shell script).
function fakeGit(body) {
  const dir = mkdtempSync(join(tmpdir(), "ps-fake-git-"));
  writeFileSync(join(dir, "git"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "git"), 0o755);
  return { ...process.env, PATH: dir };
}
const idleFx = () =>
  flowVault({
    vaultCfg: P({ idle_days: 7, age_days: { in_progress_idle: 10 } }),
    stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(30) }) },
  });
const activityUnknown = (found) => {
  none(found, "in-progress-idle");
  none(found, "assignee-idle");
  return one(found, "flow-activity-unknown");
};

// [flow-findings#3]
test("git cannot answer: a project that is not a repository, then a read that times out, give no idle finding and one flow-activity-unknown each (failure)", () => {
  const fx = idleFx();
  const notRepo = activityUnknown(flowRun(fx, { commits: commitsSince }));
  assert.match(notRepo.message, /\(not-a-repository\)/);
  const slow = fakeGit("/bin/sleep 5");
  const timedOut = activityUnknown(flowRun(fx, { commits: (p, s) => commitsSince(p, s, { env: slow, timeout: 300 }) }));
  assert.match(timedOut.message, /\(timeout\)/);
});

// [flow-findings#3]
test("git cannot answer: a shallow clone runs no activity check, and one flow-activity-unknown gives shallow (edge)", () => {
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, at: daysAgo(40) });
  gitCommit(repo, { files: { "b.txt": "b" }, at: daysAgo(39) });
  const clone = join(mkdtempSync(join(tmpdir(), "ps-flow-shallow-")), "c");
  git(tmpdir(), ["clone", "-q", "--depth", "1", `file://${repo}`, clone]);
  assert.deepEqual(commitsSince(clone, SINCE), { status: "unknown", reason: "shallow" });
  const f = activityUnknown(flowRun(idleFx(), { commits: (p, s) => commitsSince(clone, s) }));
  assert.match(f.message, /\(shallow\)/);
});

// [flow-findings#3]
test("git cannot answer: no git on the PATH gives one flow-activity-unknown with no-git (failure)", () => {
  const empty = { ...process.env, PATH: mkdtempSync(join(tmpdir(), "ps-no-git-")) };
  const f = activityUnknown(flowRun(idleFx(), { commits: (p, s) => commitsSince(p, s, { env: empty }) }));
  assert.match(f.message, /\(no-git\)/);
});

// [flow-findings#3]
test("git cannot answer: an email-shaped word in git's stderr gives failed, and the message holds none (failure)", () => {
  const env = fakeGit(`echo "fatal: refused for ${ADDRESS}" >&2\nexit 1`);
  const r = commitsSince(tmpdir(), SINCE, { env });
  assert.deepEqual(r, { status: "unknown", reason: "failed" });
  const f = activityUnknown(flowRun(idleFx(), { commits: (p, s) => commitsSince(p, s, { env }) }));
  assert.match(f.message, /\(failed\)/);
  assert.ok(!emailShaped(f.message), f.message);
  assert.doesNotMatch(f.message, /fatal|refused/);
});

// [flow-findings#3]
test("git cannot answer: with neither flow.age_days.in_progress_idle nor flow.idle_days set, git is not run (edge)", () => {
  const seam = commitsSeam();
  const fx = flowVault({
    vaultCfg: P({ age_days: { review: 1 }, people: { [ME]: { wip: 1 } } }),
    stories: { "PS-X/story-a": inProgress("story-a") },
  });
  flowRun(fx, { commits: seam });
  assert.equal(seam.calls.length, 0);
  const idle = commitsSeam();
  flowRun(idleFx(), { commits: idle });
  assert.equal(idle.calls.length, 1, "once per run");
  assert.equal(idle.calls[0].since, daysAgo(11), "back to the longer threshold, with a day of margin");
});

// ─── Contract 4: idle work ─────────────────────────────────────────────

const ipFx = (stories) => flowVault({ vaultCfg: P({ age_days: { in_progress_idle: 10 } }), stories });

// [flow-findings#4]
test("idle work: a story started 10 days ago with no commit is in-progress-idle at 10; started 9 days ago, none (edge)", () => {
  const f = one(flowRun(ipFx({ "PS-X/story-a": inProgress("story-a", { at: daysAgo(10) }) })), "in-progress-idle");
  assert.equal(f.level, "warn");
  assert.match(f.message, /has no local commit in the last 10 days\. A vault kept/);
  none(flowRun(ipFx({ "PS-X/story-a": inProgress("story-a", { at: daysAgo(9) }) })), "in-progress-idle");
});

// [flow-findings#4]
test("idle work: a commit by the assignee touching code_refs 3 days ago keeps a 30-day story busy; another person's does not (edge)", () => {
  const fx = ipFx({ "PS-X/story-a": inProgress("story-a", { at: daysAgo(30), fm: { code_refs: js(["scripts/"]) } }) });
  const by = (author) =>
    commitsSeam({ status: "ok", commits: [commit({ author, at: daysAgo(3), paths: ["scripts/a.mjs"] })] });
  none(flowRun(fx, { commits: by(ME) }), "in-progress-idle");
  const idle = one(flowRun(fx, { commits: by("Other Person") }), "in-progress-idle");
  assert.match(idle.message, /has no local commit in the last 10 days that touches its code_refs\. /);
  const elsewhere = commitsSeam({ status: "ok", commits: [commit({ at: daysAgo(3), paths: ["docs/a.md"] })] });
  one(flowRun(fx, { commits: elsewhere }), "in-progress-idle");
});

// [flow-findings#4]
test("idle work: a story with no started_at and a trusted stamp 12 days old is idle from the stamp (edge)", () => {
  const t = storyText({ id: "story-a", assignee: ME, log: [{ to: "in-progress", at: daysAgo(12) }] });
  assert.match(t, /^started_at: null$/m);
  one(flowRun(ipFx({ "PS-X/story-a": t })), "in-progress-idle");
});

// [flow-findings#4]
test("idle work: a story started 30 days ago and handed to its assignee 3 days ago is not idle (edge)", () => {
  const t = handOver(inProgress("story-a", { assignee: "Other Person", at: daysAgo(30) }), { to: ME, at: daysAgo(3) });
  none(flowRun(ipFx({ "PS-X/story-a": t })), "in-progress-idle");
});

// [flow-findings#4]
test("idle work: an assignee who committed only to the vault's own repository is idle, and the message says vault commits are not read (edge)", () => {
  const vaultRepo = gitRepo();
  gitCommit(vaultRepo, { files: { "epics/x.md": "x" }, at: daysAgo(1) });
  const projRepo = gitRepo();
  gitCommit(projRepo, { files: { "a.mjs": "a" }, author: "Other Person", at: daysAgo(1) });
  const fx = ipFx({ "PS-X/story-a": inProgress("story-a", { at: daysAgo(20) }) });
  const f = one(flowRun(fx, { commits: (p, s) => commitsSince(projRepo, s) }), "in-progress-idle");
  assert.match(f.message, /A vault kept in a repository of its own is not read/);
});

// ─── Contract 5: idle people ───────────────────────────────────────────

// [flow-findings#5]
test("idle people: First Last with two stories, git_names flast and an email-shaped entry, and no commit in 7 days gets one assignee-idle (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7, people: { [ME]: { git_names: ["flast", ADDRESS] } } }),
    stories: {
      "PS-X/story-a": inProgress("story-a", { at: daysAgo(30) }),
      "PS-X/story-b": inReview("story-b", { at: daysAgo(29) }),
    },
  });
  const found = flowRun(fx);
  const f = one(found, "assignee-idle");
  assert.equal(f.level, "warn");
  assert.match(
    f.message,
    /^First Last holds 2 stories in progress or review and has no local commit in the last 7 days under the names First Last, flast:/,
  );
  assert.match(f.message, /can be handed over/);
  // As amended 2026-11-14: the handover command, alone on its line after a colon.
  const cmd = packageCommand([], "handover", { args: "--from 'First Last' --to <name> --reason '<why>'" });
  assert.equal(handoverCommand(ME), cmd);
  const lines = f.message.split("\n");
  assert.equal(lines.length, 2, f.message);
  assert.ok(lines[0].endsWith(`can be handed over to someone else, ${fromTerminalIn(fx.proj)}:`), lines[0]);
  assert.equal(lines[1], cmd);
  assert.ok(!emailShaped(f.message));
  assert.deepEqual(f.stories, ["epics/PS-X/stories/story-a.md", "epics/PS-X/stories/story-b.md"]);
});

// [flow-findings#5]
test("idle people: an idle person whose assignee name is email-shaped is named so, can be handed over, and gets no handover command (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7 }),
    stories: { "PS-X/story-a": inProgress("story-a", { assignee: ADDRESS, at: daysAgo(30) }) },
  });
  const f = one(flowRun(fx), "assignee-idle");
  assert.match(f.message, /^an email-shaped name holds 1 story/);
  assert.match(f.message, /The work can be handed over to someone else\.$/);
  assert.ok(!f.message.includes("\n"), f.message);
  assert.doesNotMatch(f.message, /handover --from/);
  assert.ok(!emailShaped(f.message));
  // A name with @ that is not email-shaped, and one with a control character, get no command either.
  for (const name of ["lead@team", "Tab\tName"]) {
    const g = one(
      flowRun(
        flowVault({
          vaultCfg: P({ idle_days: 7 }),
          stories: { "PS-X/story-a": inProgress("story-a", { assignee: name, at: daysAgo(30) }) },
        }),
      ),
      "assignee-idle",
    );
    assert.doesNotMatch(g.message, /handover --from/, name);
  }
});

// [flow-findings#5]
test("idle people: a person whose only stories are awaiting close is not idle (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7 }),
    stories: { "PS-X/story-w": awaiting("story-w", { at: daysAgo(20) }) },
  });
  none(flowRun(fx), "assignee-idle");
});

// [flow-findings#5]
test("idle people: no assignee-idle before flow.idle_days have passed since the earliest start, and one a day later (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7 }),
    stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(6) }) },
  });
  none(flowRun(fx), "assignee-idle");
  one(flowRun(fx, { now: new Date(NOW_MS + DAY).toISOString() }), "assignee-idle");
});

// ─── Contract 6: the policy gates the checks ───────────────────────────

// A policy that triggers every check that can fire together.
const EVERY = {
  wip: { full: 1 },
  age_days: { review: 3, todo: 3, in_progress_idle: 10 },
  idle_days: 7,
  window_weeks: 2,
  capacity_weeks: [1, 2],
  people: { [ME]: { time: "full" }, "Nobody Here": { wip: 2 }, "Gone Person": { left: "2026-11-01" } },
};
const everyStories = () => ({
  "PS-X/story-old": planned("story-old", { created: "2026-08-01" }),
  "PS-X/story-gone": planned("story-gone", { created: "2026-08-01", assignee: "Gone Person" }),
  "PS-X/story-ip1": inProgress("story-ip1", { at: daysAgo(30) }),
  "PS-X/story-ip2": inProgress("story-ip2", { at: daysAgo(25) }),
  "PS-X/story-rev": inReview("story-rev", { at: daysAgo(5) }),
  "PS-X/story-revhand": storyText({
    id: "story-revhand",
    assignee: "Other Person",
    log: [{ to: "in-progress", at: daysAgo(30) }],
    status: "review",
    updated: daysAgo(4).slice(0, 10),
  }),
  "PS-X/story-todo": storyText({ id: "story-todo", status: "todo", updated: daysAgo(6).slice(0, 10) }),
  ...many(4, (i) => [`PS-X/story-t${i}`, inTodo(`story-t${i}`, { at: daysAgo(1) })]),
  ...many(3, (i) => [`PS-X/story-n${i}`, planned(`story-n${i}`, { created: "2026-10-27" })]),
  "PS-X/story-c0": done("story-c0", { created: "2026-08-01" }),
  "PS-X/story-du": done("story-du", { closedAt: null, updated: "2026-10-29" }),
});
const everyRun = (flow, opts) => flowRun(flowVault({ vaultCfg: P(flow), stories: everyStories() }), opts);
// One fixture under two policies, so only the policy differs.
const twoPolicies = (a, b) => {
  const fx = flowVault({ vaultCfg: P(a), stories: everyStories() });
  const first = flowRun(fx);
  writeFileSync(join(fx.vault, ".projectstore.json"), JSON.stringify(P(b)));
  return [first, flowRun(fx)];
};

test("the every-check fixture triggers each check that can fire together", () => {
  const found = everyRun(EVERY);
  for (const c of [
    "wip-over-limit",
    "review-aged",
    "todo-aged",
    "status-unstamped",
    "in-progress-idle",
    "assignee-idle",
    "intake-over-close",
    "closed-unstamped",
    "todo-over-capacity",
    "flow-person-unknown",
    "assignee-left",
  ])
    assert.ok(ids(found).includes(c), `${c} in ${ids(found)}`);
});

// [flow-findings#6]
test("policy gate: removing flow.age_days.review drops review-aged and the Review stories from status-unstamped, and nothing else (edge)", () => {
  const [all, less] = twoPolicies(EVERY, { ...EVERY, age_days: { todo: 3, in_progress_idle: 10 } });
  none(less, "review-aged");
  const before = one(all, "status-unstamped");
  const after = one(less, "status-unstamped");
  assert.ok(before.stories.includes("epics/PS-X/stories/story-revhand.md"));
  assert.deepEqual(after.stories, ["epics/PS-X/stories/story-todo.md"]);
  const rest = (fs) => fs.filter((f) => !["review-aged", "status-unstamped"].includes(f.check));
  assert.deepEqual(rest(less), rest(all));
});

// [flow-findings#6]
test("policy gate: removing flow.capacity_weeks drops the three capacity findings, and intake-over-close is as before (edge)", () => {
  const { capacity_weeks: _, ...rest } = EVERY;
  void _;
  const [all, less] = twoPolicies(EVERY, rest);
  for (const c of ["todo-over-capacity", "todo-under-capacity", "todo-capacity-unknown"]) none(less, c);
  assert.deepEqual(one(less, "intake-over-close"), one(all, "intake-over-close"));
  const others = (fs) => fs.filter((f) => !f.check.startsWith("todo-") || f.check === "todo-aged");
  assert.deepEqual(others(less), others(all));
});

// [flow-findings#6]
test("policy gate: with only flow.idle_days set, git is read and assignee-idle can run, and no in-progress-idle is reported (edge)", () => {
  const seam = commitsSeam();
  const found = everyRun({ idle_days: 7 }, { commits: seam });
  assert.equal(seam.calls.length, 1);
  one(found, "assignee-idle");
  none(found, "in-progress-idle");
});

// [flow-findings#6]
test("policy gate: a person marked left among a policy that triggers every check; removing their left drops assignee-left and nothing else (edge)", () => {
  const [all, less] = twoPolicies(EVERY, without(EVERY, ["people", "Gone Person", "left"]));
  const f = one(all, "assignee-left");
  assert.deepEqual(f.stories, ["epics/PS-X/stories/story-gone.md"]);
  none(less, "assignee-left");
  const rest = (fs) => fs.filter((x) => x.check !== "assignee-left");
  assert.deepEqual(rest(less), rest(all));
});

// ─── Contract 7: an unset or invalid policy ────────────────────────────

// [flow-findings#7]
test("unset policy: no flow block gives one flow-policy-unset naming the configure form, and no other flow finding", () => {
  for (const vaultCfg of [null, {}, { flow: null }, { flow: {} }]) {
    const fx = flowVault({ vaultCfg, stories: everyStories() });
    const seam = commitsSeam();
    const found = flowRun(fx, { commits: seam });
    assert.deepEqual(ids(found), ["flow-policy-unset"], JSON.stringify(vaultCfg));
    assert.equal(
      found[0].message,
      "The vault has no flow policy, so no flow check runs. Each check starts once configure sets its key, in the form --set flow.<key>=<value>.",
    );
    assert.equal(seam.calls.length, 0);
  }
});

// [flow-findings#7]
test("invalid policy: flow.wip.full as the string 3, and flow.wip as the number 3, are named with their set and not their value (edge)", () => {
  const a = flowRun(flowVault({ vaultCfg: P({ wip: { full: "3" } }) }));
  assert.deepEqual(ids(a), ["flow-policy-invalid"]);
  assert.equal(a[0].message, "flow.wip.full takes a positive whole number, so the flow checks ignore its value.");
  const b = flowRun(flowVault({ vaultCfg: P({ wip: 3 }) }));
  assert.deepEqual(ids(b), ["flow-policy-invalid"]);
  assert.equal(b[0].message, "flow.wip takes an object of flow settings, so the flow checks ignore its value.");
  for (const f of [...a, ...b]) assert.doesNotMatch(f.message, /3/);
});

// [flow-findings#7]
test("invalid policy: a typo flow.age_day.review is named without its value, review-aged does not run, and flow.groomed_at gets nothing (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ age_day: { review: 10 }, groomed_at: "2026-11-01" }),
    stories: { "PS-X/story-r": inReview("story-r", { at: daysAgo(20) }) },
  });
  const found = flowRun(fx);
  assert.deepEqual(ids(found), ["flow-policy-invalid"]);
  assert.equal(found[0].message, "flow.age_day is not a flow setting this version knows, so no check reads it.");
});

// [flow-findings#7]
test("invalid policy: capacity_weeks of [0.005, 3] is named, says a bound must be at least 0.01, and no capacity finding runs (edge)", () => {
  const found = flowRun(capacity({ bounds: [0.005, 3], todo: 30 }));
  const f = one(found, "flow-policy-invalid");
  assert.match(f.message, /^flow\.capacity_weeks takes .*: a bound must be at least 0\.01/);
  assert.doesNotMatch(f.message, /0\.005/);
  for (const c of ["todo-over-capacity", "todo-under-capacity", "todo-capacity-unknown"]) none(found, c);
});

// ─── Contract 8: people's names ────────────────────────────────────────

// [flow-findings#8]
test("people: a listed person no story names gets flow-person-unknown; a key holding @ gets one nameless flow-policy-invalid and nothing else (edge)", () => {
  const bad = "lead@team";
  const fx = flowVault({
    vaultCfg: P({ people: { "Nobody Here": { wip: 2 }, [bad]: { wip: 1 } } }),
    stories: {
      "PS-X/story-a": inProgress("story-a", { assignee: bad }),
      "PS-X/story-b": inProgress("story-b", { assignee: bad }),
    },
  });
  const found = flowRun(fx);
  assert.deepEqual(ids(found).sort(), ["flow-person-unknown", "flow-policy-invalid"]);
  assert.match(one(found, "flow-person-unknown").message, /^Nobody Here is listed in flow\.people/);
  const inv = one(found, "flow-policy-invalid");
  assert.match(inv.message, /^A person key in flow\.people is not a valid name/);
  assert.ok(!inv.message.includes(bad));
  assert.doesNotMatch(inv.message, /wip|\b1\b/);
});

// [flow-findings#8]
test("people: commits as flast are First Last's and those under an email-shaped git name are not; one flow-policy-invalid names the key (edge)", () => {
  const vaultCfg = P({ idle_days: 7, people: { [ME]: { git_names: ["flast", ADDRESS] } } });
  const names = new Set(namesOf(vaultCfg, ME));
  assert.equal(activityTime(commit({ author: "flast" }), names), NOW_MS);
  assert.equal(activityTime(commit({ author: ADDRESS }), names), null);
  const fx = flowVault({ vaultCfg, stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(30) }) } });
  const found = flowRun(fx, {
    commits: commitsSeam({ status: "ok", commits: [commit({ author: ADDRESS, at: daysAgo(1) })] }),
  });
  one(found, "assignee-idle");
  const inv = one(found, "flow-policy-invalid");
  assert.match(
    inv.message,
    /^flow\.people\[First Last\]\.git_names takes a comma list of git author names, with no email address/,
  );
  assert.ok(!emailShaped(inv.message));
  none(
    flowRun(fx, { commits: commitsSeam({ status: "ok", commits: [commit({ author: "flast", at: daysAgo(1) })] }) }),
    "assignee-idle",
  );
});

// [flow-findings#8]
test("people: Ada with a valid left date and Lin with left soon, neither named by a story: Ada gets no flow-person-unknown, Lin gets one (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { Ada: { left: "2026-11-01" }, Lin: { left: "soon" } } }),
    stories: { "PS-X/story-a": inProgress("story-a") },
  });
  const found = flowRun(fx);
  const unknown = byCheck(found, "flow-person-unknown");
  assert.equal(unknown.length, 1, JSON.stringify(ids(found)));
  assert.match(unknown[0].message, /^Lin is listed in flow\.people/);
  assert.match(one(found, "flow-policy-invalid").message, /^flow\.people\[Lin\]\.left takes /);
  none(found, "assignee-left");
});

// ─── The handover spec, contract 6: people who left ───────────────────

// [handover#6]
test("assignee-left: Ada left on 2026-11-01 with a todo and an in-progress story gets one warn naming her, the date, both stories and the handover command", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { Ada: { left: "2026-11-01" } } }),
    stories: {
      "PS-X/story-a": inTodo("story-a", { assignee: "Ada", at: daysAgo(3) }),
      "PS-X/story-b": inProgress("story-b", { assignee: "Ada", at: daysAgo(9) }),
    },
  });
  const seam = commitsSeam();
  const found = flowRun(fx, { commits: seam });
  const f = one(found, "assignee-left");
  assert.equal(f.level, "warn");
  assert.equal(seam.calls.length, 0, "no git is read for it");
  const [first, cmd, ...more] = f.message.split("\n");
  assert.deepEqual(more, []);
  assert.match(
    first,
    /^Ada is marked left as of 2026-11-01 and still holds 2 open stories: PS-X\/story-b, PS-X\/story-a\./,
  );
  assert.ok(first.endsWith(`can be handed over to someone else, ${fromTerminalIn(fx.proj)}:`), first);
  assert.equal(cmd, "npx projectstore handover --from Ada --to <name> --reason '<why>'");
  assert.equal(cmd, packageCommand([], "handover", { args: "--from Ada --to <name> --reason '<why>'" }));
  assert.deepEqual(f.stories, ["epics/PS-X/stories/story-b.md", "epics/PS-X/stories/story-a.md"]);
});

// [handover#6]
test("assignee-left: Ada left with only done and parked stories gets none (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { Ada: { left: "2026-11-01" } } }),
    stories: {
      "PS-X/story-a": done("story-a", { assignee: "Ada" }),
      "PS-X/story-b": storyText({ id: "story-b", assignee: "Ada", status: "parked" }),
    },
  });
  const found = flowRun(fx);
  none(found, "assignee-left");
  none(found, "flow-person-unknown");
});

// [handover#6]
test("assignee-left: Ada with open stories and no left, and Lin with open stories and left soon, get none; flow-policy-invalid names Lin's left (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { Ada: { wip: 5 }, Lin: { left: "soon" } } }),
    stories: {
      "PS-X/story-a": inProgress("story-a", { assignee: "Ada" }),
      "PS-X/story-b": inProgress("story-b", { assignee: "Lin" }),
    },
  });
  const found = flowRun(fx);
  none(found, "assignee-left");
  assert.match(one(found, "flow-policy-invalid").message, /^flow\.people\[Lin\]\.left /);
});

// [handover#6]
test("assignee-left: a left date after the as-of instant still gives one assignee-left (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { Ada: { left: "2026-12-31" } } }),
    stories: { "PS-X/story-a": inTodo("story-a", { assignee: "Ada" }) },
  });
  assert.match(one(flowRun(fx), "assignee-left").message, /^Ada is marked left as of 2026-12-31/);
});

// [handover#6]
test("assignee-left: Ada and First Last both left give two findings; the second quotes 'First Last', and a Cyrillic name comes quoted (edge)", () => {
  const RU = "Анна Иванова";
  const fx = flowVault({
    vaultCfg: P({
      people: { Ada: { left: "2026-11-01" }, [ME]: { left: "2026-11-02" }, [RU]: { left: "2026-11-03" } },
    }),
    stories: {
      "PS-X/story-a": inTodo("story-a", { assignee: "Ada" }),
      "PS-X/story-b": inTodo("story-b", { assignee: ME }),
      "PS-X/story-c": inTodo("story-c", { assignee: RU }),
    },
  });
  const found = byCheck(flowRun(fx), "assignee-left");
  assert.equal(found.length, 3);
  const cmds = found.map((f) => f.message.split("\n")[1]);
  assert.deepEqual(cmds, [
    "npx projectstore handover --from Ada --to <name> --reason '<why>'",
    "npx projectstore handover --from 'First Last' --to <name> --reason '<why>'",
    `npx projectstore handover --from '${RU}' --to <name> --reason '<why>'`,
  ]);
});

// [handover#6]
test("assignee-left: eleven open stories name the eight oldest and 3 more, stories holds all eleven, and doctor --startup reports none (edge)", () => {
  const stories = many(11, (i) => [
    `PS-X/story-${String(i).padStart(2, "0")}`,
    inTodo(`story-${String(i).padStart(2, "0")}`, { assignee: "Ada", at: daysAgo(10 + i) }),
  ]);
  const fx = flowVault({ vaultCfg: P({ people: { Ada: { left: "2026-11-01" } } }), stories });
  const f = one(flowRun(fx), "assignee-left");
  const oldest = Array.from({ length: 11 }, (_, i) => String(10 - i).padStart(2, "0"));
  assert.ok(
    f.message.includes(
      `: ${oldest
        .slice(0, 8)
        .map((n) => `PS-X/story-${n}`)
        .join(", ")} and 3 more.`,
    ),
    f.message,
  );
  assert.deepEqual(
    f.stories,
    oldest.map((n) => `epics/PS-X/stories/story-${n}.md`),
  );
  const r = runStartupChecks(fx.cfg, fx.proj, 60000);
  assert.deepEqual(byCheck(r.findings, "assignee-left"), []);
});

// ─── Contract 9: levels ────────────────────────────────────────────────

const BIN = join(REPO, "bin", "projectstore.mjs");

// [flow-findings#9]
test("levels: a vault whose only findings are flow warns: the doctor verb exits 0 (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ people: { [ME]: { wip: 1 } } }),
    stories: { "PS-X/story-a": inProgress("story-a"), "PS-X/story-b": inProgress("story-b") },
  });
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PROJECTSTORE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [BIN, "doctor", "--vault", "--json", "--project", fx.proj], {
    cwd: fx.proj,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const out = JSON.parse(r.stdout);
  assert.ok(
    out.result.some((f) => f.check === "wip-over-limit" && f.level === "warn"),
    r.stdout,
  );
  assert.deepEqual(
    out.result.filter((f) => f.level === "issue"),
    [],
  );
  assert.equal(r.status, 0, r.stderr);
});

// [flow-findings#9]
test("levels: across fixtures that trigger every flow check, each finding has the table's level and none is an issue (edge)", () => {
  const seen = new Map();
  const add = (fs) => {
    for (const f of flowOnly(fs)) {
      assert.equal(f.level, FLOW_LEVELS[f.check], f.check);
      assert.notEqual(f.level, "issue");
      assert.equal(f.group, "vault");
      seen.set(f.check, f.level);
    }
  };
  add(everyRun(EVERY));
  add(flowRun(flowVault()));
  add(flowRun(capacity({ todo: 3 })));
  add(flowRun(capacity({ closed: 0 })));
  add(flowRun(capacity({ firstCreated: daysAgo(14).slice(0, 10) })));
  add(flowRun(flowVault({ vaultCfg: P({ wip: 3 }) })));
  add(everyRun(EVERY, { commits: commitsSeam({ status: "unknown", reason: "shallow" }) }));
  add(
    everyRun(EVERY, {
      commits: () => {
        throw new Error("boom");
      },
    }),
  );
  const fx = flowVault({ vaultCfg: P({ age_days: { review: 1 } }), stories: { "PS-X/story-a": planned("story-a") } });
  add(
    checkFlow({
      cfg: fx.cfg,
      layout: loadLayout(fx.cfg.layout),
      vaultCfg: P({ age_days: { review: 1 } }),
      proj: fx.proj,
      now: NOW,
      commits: commitsSeam(),
      read: () => {
        throw new Error("EACCES");
      },
    }),
  );
  assert.deepEqual([...seen.keys()].sort(), [...FLOW_CHECKS].sort());
});

// ─── Contract 10: shape and privacy ────────────────────────────────────

// [flow-findings#10]
test("shape: eleven stories over a limit name the eight oldest and 3 more, and stories holds all eleven oldest first (edge)", () => {
  const stories = many(11, (i) => [
    `PS-X/story-${String(i).padStart(2, "0")}`,
    inProgress(`story-${String(i).padStart(2, "0")}`, { at: daysAgo(10 + i) }),
  ]);
  const f = one(flowRun(flowVault({ vaultCfg: P({ people: { [ME]: { wip: 2 } } }), stories })), "wip-over-limit");
  const oldest = Array.from({ length: 11 }, (_, i) => String(10 - i).padStart(2, "0"));
  assert.match(
    f.message,
    new RegExp(
      `: ${oldest
        .slice(0, 8)
        .map((n) => `PS-X/story-${n}`)
        .join(", ")} and 3 more\\.$`,
    ),
  );
  assert.deepEqual(
    f.stories,
    oldest.map((n) => `epics/PS-X/stories/story-${n}.md`),
  );
});

// [flow-findings#10]
test("shape: two aged stories of the same age are ordered by vault path (edge)", () => {
  const at = daysAgo(5);
  const fx = flowVault({
    vaultCfg: P({ age_days: { review: 3 }, people: { [ME]: { wip: 1 } } }),
    stories: { "PS-X/story-b": inReview("story-b", { at }), "PS-X/story-a": inReview("story-a", { at }) },
  });
  const found = flowRun(fx);
  assert.deepEqual(
    byCheck(found, "review-aged").map((f) => f.file),
    ["epics/PS-X/stories/story-a.md", "epics/PS-X/stories/story-b.md"],
  );
  assert.deepEqual(one(found, "wip-over-limit").stories, [
    "epics/PS-X/stories/story-a.md",
    "epics/PS-X/stories/story-b.md",
  ]);
});

// [flow-findings#10]
test("privacy: email-shaped assignees, person keys, git names, flow keys and commit names never reach a message, file or stories entry (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({
      idle_days: 7,
      age_days: { in_progress_idle: 10, review: 1 },
      [ADDRESS]: 1,
      people: { [ADDRESS]: { wip: 1 }, [ME]: { git_names: [ADDRESS], wip: 1 } },
    }),
    stories: {
      "PS-X/story-a": inProgress("story-a", { assignee: ADDRESS }),
      "PS-X/story-b": inProgress("story-b", { assignee: ADDRESS }),
      "PS-X/story-c": inReview("story-c", { assignee: ADDRESS, at: daysAgo(9) }),
      "PS-X/story-d": inProgress("story-d"),
      "PS-X/story-e": inProgress("story-e"),
    },
  });
  const seam = commitsSeam({
    status: "ok",
    commits: [commit({ author: ADDRESS, committer: ADDRESS, at: daysAgo(1), paths: ["a.mjs"] })],
  });
  const found = flowRun(fx, { commits: seam });
  for (const c of ["wip-over-limit", "assignee-idle", "in-progress-idle", "review-aged", "flow-policy-invalid"])
    assert.ok(ids(found).includes(c), `${c} in ${ids(found)}`);
  for (const f of found) {
    assert.ok(!emailShaped(f.message), f.message);
    if (f.file) assert.ok(!emailShaped(f.file));
    for (const s of f.stories || []) assert.ok(!emailShaped(s));
  }
  assert.ok(found.some((f) => /an email-shaped name/.test(f.message)));
});

// ─── Contract 11: where the group runs ─────────────────────────────────

// [flow-findings#11]
test("where: doctor --startup reports no flow check for a vault with an over-limit person, an aged review and an idle assignee (edge)", () => {
  const fx = flowVault({ vaultCfg: P(EVERY), stories: everyStories() });
  assert.ok(ids(doctorRun(fx)).includes("wip-over-limit"));
  const r = runStartupChecks(fx.cfg, fx.proj, 60000);
  assert.equal(r.skipped, false);
  assert.deepEqual(ids(r.findings), []);
  const src = readFileSync(join(REPO, "scripts", "doctor.mjs"), "utf8");
  const startup = src.slice(src.indexOf("export function runStartupChecks"), src.indexOf("// ─── CLI"));
  assert.doesNotMatch(startup, /checkFlow/);
});

// [flow-findings#11]
test("where: the flow group throwing is one flow-checks-failed, and every other vault finding is unchanged (failure)", () => {
  const fx = flowVault({ vaultCfg: P(EVERY), stories: everyStories() });
  const ok = doctorRun(fx);
  const thrown = doctorRun(fx, {
    commits: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(ids(thrown), ["flow-checks-failed"]);
  assert.equal(one(thrown, "flow-checks-failed").level, "warn");
  const rest = (fs) => fs.filter((f) => !FLOW_CHECKS.includes(f.check));
  assert.deepEqual(rest(thrown), rest(ok));
});

// ─── Review fixes: every key's checks, boundaries, names, unborn HEAD ──

const without = (flow, path) => {
  const copy = JSON.parse(JSON.stringify(flow));
  let node = copy;
  for (const step of path.slice(0, -1)) node = node[step];
  delete node[path[path.length - 1]];
  return copy;
};
// Each key of the contract 6 table, and the checks that read only it (in
// the every-check fixture, which ties wip-over-limit to flow.wip.full).
const KEY_CHECKS = [
  [["wip", "full"], ["wip-over-limit"]],
  [["age_days", "review"], ["review-aged"]],
  [["age_days", "todo"], ["todo-aged"]],
  [["age_days", "in_progress_idle"], ["in-progress-idle"]],
  [["idle_days"], ["assignee-idle"]],
  [["window_weeks"], ["intake-over-close", "closed-unstamped", "todo-over-capacity"]],
  [["capacity_weeks"], ["todo-over-capacity"]],
  [["people"], ["wip-over-limit", "flow-person-unknown", "assignee-left"]],
  [["people", "Gone Person", "left"], ["assignee-left"]],
];
const idSet = (fs) => [...new Set(ids(fs))].sort();

// [flow-findings#6]
test("policy gate: removing each key of the table drops exactly the checks that read it, and every other finding stays (edge)", () => {
  for (const [path, gone] of KEY_CHECKS) {
    const [all, less] = twoPolicies(EVERY, without(EVERY, path));
    const key = `flow.${path.join(".")}`;
    for (const c of gone) assert.ok(ids(all).includes(c), `${key}: the fixture has ${c}`);
    assert.deepEqual(
      idSet(all).filter((c) => !idSet(less).includes(c)),
      [...gone].sort(),
      key,
    );
    assert.deepEqual(
      idSet(less).filter((c) => !idSet(all).includes(c)),
      [],
      `${key}: nothing new`,
    );
    const ageKey = path[0] === "age_days" && path[1] !== "in_progress_idle";
    const rest = (fs) => fs.filter((f) => !gone.includes(f.check) && !(ageKey && f.check === "status-unstamped"));
    assert.deepEqual(rest(less), rest(all), key);
  }
  // The checks two keys switch on: status-unstamped and flow-activity-unknown.
  const [a, b] = twoPolicies(EVERY, without(without(EVERY, ["age_days", "review"]), ["age_days", "todo"]));
  assert.ok(ids(a).includes("status-unstamped"));
  assert.ok(!ids(b).includes("status-unstamped"));
  const unknown = commitsSeam({ status: "unknown", reason: "shallow" });
  const fx = flowVault({ vaultCfg: P(EVERY), stories: everyStories() });
  one(flowRun(fx, { commits: unknown }), "flow-activity-unknown");
  writeFileSync(
    join(fx.vault, ".projectstore.json"),
    JSON.stringify(P(without(without(EVERY, ["age_days", "in_progress_idle"]), ["idle_days"]))),
  );
  none(flowRun(fx, { commits: unknown }), "flow-activity-unknown");
});

// [flow-counts#3]
test("age in status: todo-aged at 14 days meets flow.age_days.todo of 14, and 13 days does not (edge)", () => {
  const vault = (n) =>
    flowVault({
      vaultCfg: P({ age_days: { todo: 14 } }),
      stories: { "PS-X/story-t": inTodo("story-t", { at: daysAgo(n) }) },
    });
  assert.match(one(flowRun(vault(14)), "todo-aged").message, /in ToDo for 14 days/);
  none(flowRun(vault(13)), "todo-aged");
});

// [flow-findings#5]
test("idle people: a last commit 7 days old meets flow.idle_days of 7, and one 6 days old does not (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7 }),
    stories: { "PS-X/story-a": inProgress("story-a", { at: daysAgo(30) }) },
  });
  const at = (n) => commitsSeam({ status: "ok", commits: [commit({ at: daysAgo(n) })] });
  one(flowRun(fx, { commits: at(7) }), "assignee-idle");
  none(flowRun(fx, { commits: at(6) }), "assignee-idle");
});

// [flow-findings#1] [flow-findings#10]
test("names: an email-shaped assignee name still matches its own commits, and is printed only as an email-shaped name (edge)", () => {
  const fx = flowVault({
    vaultCfg: P({ idle_days: 7 }),
    stories: { "PS-X/story-a": inProgress("story-a", { assignee: ADDRESS, at: daysAgo(30) }) },
  });
  assert.deepEqual(namesOf(P({}), ADDRESS), [ADDRESS]);
  const recent = commitsSeam({ status: "ok", commits: [commit({ author: ADDRESS, at: daysAgo(1) })] });
  none(flowRun(fx, { commits: recent }), "assignee-idle");
  const f = one(flowRun(fx), "assignee-idle");
  assert.match(f.message, /^an email-shaped name holds 1 story .* under the names an email-shaped name:/);
  assert.ok(!emailShaped(f.message), f.message);
});

// [flow-findings#1]
test("activity: an empty repository, and an unborn branch beside others, read without HEAD (edge)", () => {
  const empty = gitRepo();
  assert.deepEqual(commitsSince(empty, SINCE), { status: "ok", commits: [] });
  const repo = gitRepo();
  gitCommit(repo, { files: { "a.txt": "a" }, at: "2026-10-01T10:00:00Z" });
  git(repo, ["checkout", "-q", "--orphan", "fresh"]);
  const r = commitsSince(repo, SINCE);
  assert.equal(r.status, "ok");
  assert.deepEqual(
    r.commits.map((c) => c.paths),
    [["a.txt"]],
  );
});

// ─── The specs' source guards ──────────────────────────────────────────

const FLOW_MODULES = [
  "scripts/doctor-flow.mjs",
  "scripts/flow-counts.mjs",
  "scripts/flow-stories.mjs",
  "scripts/flow-policy.mjs",
  "scripts/code-refs.mjs",
  "scripts/diff-refs.mjs",
];

// [flow-findings#1]
test("source guard: no flow module asks git for an email address", () => {
  for (const f of FLOW_MODULES) {
    const src = readFileSync(join(REPO, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(src, /%a[eE]|%c[eE]|%G[eE]|user\.email|--format=[^"]*<%/, f);
  }
  const diff = readFileSync(join(REPO, "scripts", "diff-refs.mjs"), "utf8");
  const read = diff.slice(diff.indexOf("const LOG_FORMAT"), diff.indexOf("export function sinceWindow"));
  assert.match(read, /const LOG_FORMAT = "--format=(?:%x1[ef]|%at|%aN|%ct|%cN)+";/, "names and times only");
  assert.match(read, /"--no-merges"/);
  assert.match(read, /"--branches",\s*"--remotes"/);
  assert.match(read, /LC_ALL: "C"/);
});

// [flow-findings#3]
test("source guard: flow-activity-unknown builds its message from the fixed reason set alone", () => {
  const src = readFileSync(join(REPO, "scripts", "doctor-flow.mjs"), "utf8");
  const at = src.indexOf('"flow-activity-unknown",\n');
  const call = src.slice(at, src.indexOf(")", src.indexOf("`", at + 30) + 1) + 1);
  const interpolated = [...call.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
  assert.deepEqual(interpolated, ["ACTIVITY_TEXT[reason]", "reason"]);
  assert.equal(ACTIVITY_REASONS.length, 5);
  for (const reason of ["no-git", "not-a-repository", "shallow", "timeout", "failed", `stderr ${ADDRESS}`, undefined]) {
    const found = flowRun(idleFx(), { commits: commitsSeam({ status: "unknown", reason }) });
    const f = one(found, "flow-activity-unknown");
    const shown = ACTIVITY_REASONS.includes(reason) ? reason : "failed";
    assert.match(f.message, new RegExp(`\\(${shown}\\)`));
    assert.ok(!emailShaped(f.message));
  }
});

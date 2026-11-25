// projectstore — tests for the dashboard's Reports (PS-DASHBOARD, "The Reports
// page draws the core's flow counts and the checks of the board against the
// code"; the spec "The dashboard's Reports: the core's flow counts for a
// window, the board against the code, and filters in the address", alias
// `dashboard-reports`).
//
// The flow read is tested over the export spec's golden vault and small flow
// vaults (tests/fixtures/flow.mjs), against the core's own functions and the
// export verb. The routes, the guard and the calls run in a world
// (tests/fixtures/dashboard-world.mjs): a plain-folder vault, the server in
// process on port 0, a stub gh first on PATH, the spawn record holding every
// call. The page's drawing is tested in tests/dashboard-page.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { REPO, hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import {
  ADDRESS,
  NOW,
  NOW_MS,
  closedStory,
  daysAgo,
  doctorRun,
  exportGoldenVault,
  flowVault,
  storyText,
} from "./fixtures/flow.mjs";
import { openCore } from "../dashboard/lib/core.mjs";
import { readFacts } from "../dashboard/lib/state.mjs";
import { OWN, code, flow, parseQuery } from "../dashboard/lib/reports.mjs";
import { CODE_ROUTE, REPORTS_CODE_ROUTE, REPORTS_ROUTE } from "../dashboard/server.mjs";
import { runExport } from "../scripts/flow-export.mjs";

hermeticGit();

const ctxOf = (fx) => openCore({ core: REPO, project: fx.proj });
// A clock a week after the golden fixture's, so 2026-11-11 is a day in the past.
const LATER = Date.parse("2026-11-20T12:00:00Z");
const read = (ctx, query = {}, now = NOW_MS) => {
  const r = flow(ctx, query, { now });
  assert.equal(r.status, 200, r.error);
  return r.result;
};
// Every number of an answer is { value, by, basis } (contract 1); a pull request's `number` is its
// name, and the window's length is { value, from }.
function triplesOnly(v, path = "") {
  if (Array.isArray(v)) return v.forEach((x, i) => triplesOnly(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") {
    assert.notEqual(typeof v, "number", `${path} is a bare number`);
    return;
  }
  if (path === ".weeks") return assert.ok(["address", "policy", "page"].includes(v.from), `${path}.from is ${v.from}`);
  if ("by" in v && "basis" in v && "value" in v) {
    assert.ok(v.by === "core" || v.by === "page", `${path}.by is ${v.by}`);
    assert.equal(typeof v.basis, "string", `${path}.basis`);
    return;
  }
  for (const [k, x] of Object.entries(v)) if (k !== "number") triplesOnly(x, `${path}.${k}`);
}

// ── the HTTP side ──

function call(page, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: page.port,
        path,
        method,
        agent: false,
        headers: { host: `127.0.0.1:${page.port}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
const tokenOf = async (page) =>
  /<meta name="projectstore-token" content="([^"]*)"/.exec((await call(page, "/")).text)?.[1] ?? null;
const own = (page, token) => ({ "x-projectstore-token": token, origin: `http://127.0.0.1:${page.port}` });
const post = async (page, path, body, token) =>
  call(page, path, { method: "POST", headers: own(page, token), body: JSON.stringify(body) });
const ghLists = (record, from = 0) =>
  record.slice(from).filter((e) => e.cmd === "gh" && e.argv[0] === "pr" && e.argv[1] === "list");
const sub = (e) => {
  let i = 0;
  while (e.argv[i] === "-c" || e.argv[i] === "--literal-pathspecs") i += e.argv[i] === "-c" ? 2 : 1;
  return e.cmd === "gh" ? e.argv.slice(0, 2).join(" ") : e.argv.slice(i, i + 2).join(" ");
};

const REPO_URL = "https://github.com/acme/app";
const MERGED = "2026-01-10T10:00:00Z";
const pr = (number, fields = {}) => ({
  number,
  title: `pull request ${number}`,
  body: "",
  state: "MERGED",
  url: `${REPO_URL}/pull/${number}`,
  isCrossRepository: false,
  baseRefName: "main",
  mergedAt: MERGED,
  mergeCommit: null,
  ...fields,
});
const open = (id, fm = {}, extra = {}) =>
  storyText({
    id,
    epic: "PS-X",
    log: [{ to: "in-progress", at: "2026-01-02T09:00:00.000Z" }],
    fm: { title: JSON.stringify(fm.title || `The story ${id} of the world`), ...fm },
    ...extra,
  });

// A world whose code repository has origin/main, so a counted Closes-story line counts.
async function withWorld(files, prs, fn) {
  const w = await makeWorld({ plainVault: true, files });
  try {
    w.git(w.main, "update-ref", "refs/remotes/origin/main", "HEAD");
    w.gh.set({ prs });
    return await fn(w, await w.start());
  } finally {
    await w.cleanup();
  }
}

// ── contract 1: the flow read starts no process ──

// [dashboard-reports#1]
test("dashboard reports: GET /api/reports starts no process, every number carries by and basis, and a bad value is 400", async () => {
  await withWorld({}, [], async (w, page) => {
    const from = w.record.length;
    const r = await call(page, `${REPORTS_ROUTE}?weeks=3`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(w.record.slice(from), [], "the spawn record shows no call");
    assert.equal(r.json.copy, "vault");
    triplesOnly(r.json);
    for (const q of [
      "weeks=0",
      "weeks=x",
      "weeks=27",
      "weeks=007",
      "weeks=",
      "fresh=true",
      "asof=2026-02-30",
      "asof=soon",
      "epic=..",
      "colour=red",
      "weeks=3&weeks=4",
    ]) {
      const bad = await call(page, `${REPORTS_ROUTE}?${q}`);
      assert.equal(bad.status, 400, q);
      assert.match(bad.json.error, /weeks|asof|epic|colour/, q);
    }
    assert.deepEqual(w.record.slice(from), []);
  });
});

// [dashboard-reports#4]
test("dashboard reports: the query keeps the six filters, takes only text, and names the value it refuses", () => {
  const ctx = {
    lib: {
      isCalendarDate: (s) =>
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
        new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    },
    flowPolicy: { isEmailAddress: (s) => s.includes("@") },
  };
  assert.deepEqual(
    parseQuery(
      { asof: "2026-11-11", weeks: "8", epic: "PS-FLOW", initiative: "none", assignee: "Ada Byron", priority: "p1" },
      ctx,
    ).query,
    {
      asof: "2026-11-11",
      weeks: 8,
      epic: "PS-FLOW",
      initiative: "none",
      assignee: "Ada Byron",
      priority: "p1",
    },
  );
  assert.match(parseQuery({ weeks: 8 }, ctx).error, /weeks is given as text/);
  assert.match(parseQuery({ priority: "p9" }, ctx).error, /p9/);
  assert.match(parseQuery({ assignee: ADDRESS }, ctx).error, /email address/);
  assert.ok(!parseQuery({ assignee: ADDRESS }, ctx).error.includes(ADDRESS));
});

// ── contract 2: the window is the core's ──

// [dashboard-reports#2]
test("dashboard reports: on the export golden vault, as of 2026-11-11, the window, its weeks and its cycle time are export --as-of's counts.window", async () => {
  const fx = exportGoldenVault();
  const R = read(await ctxOf(fx), { asof: "2026-11-11" }, LATER);
  const e = await runExport({ values: { "as-of": "2026-11-11" }, cfg: fx.cfg, project: fx.proj, now: NOW });
  const w = e.result.counts.window;
  assert.equal(R.asOf, e.result.as_of);
  assert.equal(R.today, false);
  assert.equal(R.standing, null);
  assert.deepEqual(R.weeks, { value: w.weeks, from: "policy" });
  assert.deepEqual(
    {
      from: R.window.from,
      to: R.window.to,
      created: R.window.created.value,
      closed: R.window.closed.value,
      closed_unstamped: R.window.closedUnstamped.value,
      young: R.young.value,
    },
    {
      from: w.from,
      to: w.to,
      created: w.created,
      closed: w.closed,
      closed_unstamped: w.closed_unstamped,
      young: w.young,
    },
  );
  assert.deepEqual(
    R.weekly.map((x) => ({ from: x.from, created: x.created.value, closed: x.closed.value })),
    w.weekly,
  );
  assert.equal(R.hiddenWeeks.value, w.omitted_weeks);
  assert.deepEqual(
    {
      median: R.window.cycle.value,
      closed: R.window.placed.value + R.window.unplaced.length,
      unplaced: R.window.unplaced.length,
    },
    { median: w.cycle_time.median, closed: w.cycle_time.closed, unplaced: w.cycle_time.unplaced.length },
  );
  // The week of 2026-11-11 is not counted: the window ends on its Monday.
  assert.equal(R.window.to, "2026-11-09T00:00:00.000Z");
  // A past day: the cumulative flow ends with the window's last week, with no row of the columns now.
  assert.equal(R.flow.rows.length, R.weekly.length);
  assert.ok(R.flow.rows.every((r) => !r.now));
});

// [dashboard-reports#2]
test("dashboard reports: with no weeks and no policy the window is this page's own 4 weeks, a day after today reads as today, and a young vault has no cycle time", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": storyText({ id: "story-a", created: "2026-11-02" }),
      "PS-X/story-b": closedStory({
        id: "story-b",
        created: "2026-11-02",
        start: "2026-11-03T09:00:00.000Z",
        close: "2026-11-05T09:00:00.000Z",
      }),
    },
  });
  const ctx = await ctxOf(fx);
  const R = read(ctx);
  assert.deepEqual(R.weeks, { value: OWN.weeks, from: "page" });
  assert.equal(R.young.value, true);
  assert.equal(R.window.cycle.value, null, "none while young, as export gives none");
  assert.equal(R.flow.rows.at(-1).now, true, "today ends with the columns now");
  const later = read(ctx, { asof: "2027-01-01" });
  assert.equal(later.asOf, new Date(NOW_MS).toISOString());
  assert.equal(later.today, true);
  // An as-of in the current ISO week is of today too (contract 3).
  assert.equal(read(ctx, { asof: "2026-11-09" }).today, true);
  assert.equal(read(ctx, { asof: "2026-11-08" }).today, false);
});

// [dashboard-reports#2]
test("dashboard reports: a close at 2026-11-08T23:59:59.999Z and one at 2026-11-09T00:00:00.000Z fall in two weeks whatever the server's TZ (edge)", () => {
  const script = `
    import { openCore } from ${JSON.stringify(pathToFileURL(join(REPO, "dashboard", "lib", "core.mjs")).href)};
    import { flow } from ${JSON.stringify(pathToFileURL(join(REPO, "dashboard", "lib", "reports.mjs")).href)};
    import { flowVault, closedStory } from ${JSON.stringify(pathToFileURL(join(REPO, "tests", "fixtures", "flow.mjs")).href)};
    const fx = flowVault({ stories: {
      "PS-X/story-late": closedStory({ id: "story-late", start: "2026-11-02T08:00:00.000Z", close: "2026-11-08T23:59:59.999Z" }),
      "PS-X/story-early": closedStory({ id: "story-early", start: "2026-11-02T08:00:00.000Z", close: "2026-11-09T00:00:00.000Z" }),
    } });
    const ctx = await openCore({ core: ${JSON.stringify(REPO)}, project: fx.proj });
    const r = flow(ctx, { asof: "2026-11-18", weeks: "2" }, { now: Date.parse("2026-11-20T12:00:00Z") });
    process.stdout.write(JSON.stringify(r.result.weekly.map((w) => [w.from, w.closed.value])));
  `;
  const outs = ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"].map((TZ) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.deepEqual(JSON.parse(outs[0]), [
    ["2026-11-02T00:00:00.000Z", 1],
    ["2026-11-09T00:00:00.000Z", 1],
  ]);
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
});

// ── contract 3: what stands still, and who holds what, are of today ──

const reviewVault = (vaultCfg) =>
  flowVault({
    vaultCfg,
    stories: {
      "PS-X/story-r": storyText({
        id: "story-r",
        assignee: "Ada",
        log: [
          { to: "in-progress", at: daysAgo(10) },
          { to: "review", at: daysAgo(5) },
        ],
      }),
    },
  });

// [dashboard-reports#3]
test("dashboard reports: the Review count's basis names flow.age_days.review and 2; with no policy there is no count, and the answer names the key", async () => {
  const set = read(await ctxOf(reviewVault({ flow: { age_days: { review: 2 } } })));
  const s = set.standing.columns.find((x) => x.id === "review");
  assert.equal(s.count.value, 1);
  assert.equal(s.count.by, "core");
  assert.match(s.count.basis, /flow\.age_days\.review = 2/);
  assert.equal(s.stories[0].days.value, 5);
  const none = read(await ctxOf(reviewVault(null)));
  const t = none.standing.columns.find((x) => x.id === "review");
  assert.equal(t.count, null, "no default in code (SPEC-001, contract 4)");
  assert.equal(t.unset, "flow.age_days.review");
  assert.equal(t.stories.length, 1, "the oldest, with no verdict");
  assert.equal(none.standing.epics.unset, "flow.age_days.epic_idle");
  assert.equal(none.standing.verdicts.unset, "flow.window_weeks");
  // In Progress has no key: the page's own 7 days, said as its own.
  assert.equal(none.standing.columns.find((x) => x.id === "in_progress").count.by, "page");
  assert.equal(none.ofToday, null);
});

// [dashboard-reports#3]
test("dashboard reports: on the golden vault at the moment of export --as-of 2026-11-11T12:00Z, today's people and epics equal export's, and arrivals and capacity are doctor's verdicts", async () => {
  const fx = exportGoldenVault();
  const R = read(await ctxOf(fx), {}, NOW_MS);
  const e = await runExport({ values: { "as-of": NOW }, cfg: fx.cfg, project: fx.proj, now: NOW });
  assert.deepEqual(
    R.standing.people.map((p) => ({
      assignee: p.name,
      held: p.wip.value,
      awaiting: p.awaiting.value,
      limit: p.limit ? p.limit.value : null,
    })),
    e.result.counts.wip,
  );
  assert.deepEqual(
    R.standing.epics.epics.map((x) => ({ epic: x.epic, path: x.rel, days: x.days.value })),
    e.result.counts.idle_epics.epics.map((x) => ({ epic: x.epic, path: x.path, days: x.days })),
  );
  assert.equal(R.standing.epics.watched.value, e.result.counts.idle_epics.watched);
  const found = doctorRun(fx, { now: NOW });
  const findings = Array.isArray(found) ? found : await found;
  const ids = findings.map((f) => f.check);
  const v = R.standing.verdicts;
  assert.equal(v.intakeOverClose === true, ids.includes("intake-over-close"));
  assert.equal(v.young, ids.includes("flow-window-young"));
  assert.equal(v.capacity.unset, "flow.capacity_weeks", "the golden policy sets no capacity_weeks");
});

// [dashboard-reports#3]
test("dashboard reports: as of a month ago no age, WIP, capacity, arrival or epic count is in the answer, and the answer says why (edge)", async () => {
  const R = read(
    await ctxOf(
      reviewVault({
        flow: { window_weeks: 2, age_days: { review: 2 }, capacity_weeks: [1, 2], people: { Ada: { wip: 0 } } },
      }),
    ),
    { asof: "2026-10-11" },
  );
  assert.equal(R.standing, null);
  assert.match(R.ofToday, /of today/);
  assert.equal(typeof R.window.closedUnstamped.value, "number", "the window's own counts stay");
});

// ── contract 4: filters scope every count ──

// [dashboard-reports#4]
test("dashboard reports: epic=PS-A gives each count as the core's function over PS-A's stories, and a filter that matches nothing gives empty counts", async () => {
  const fx = exportGoldenVault();
  const ctx = await ctxOf(fx);
  const asOf = Date.parse("2026-11-11T00:00:00Z");
  const fc = ctx.flowCounts;
  const mine = readFacts(ctx).facts.filter((f) => f.epic === "PS-A");
  const win = fc.windowOf(asOf, 2);
  const c = fc.windowCounts(mine, win);
  const R = read(ctx, { asof: "2026-11-11", epic: "PS-A" }, LATER);
  assert.equal(R.window.created.value, c.created.length);
  assert.equal(R.window.closed.value, c.closed.length);
  assert.equal(R.window.cycle.value, fc.cycleTime(c.closed).median);
  assert.deepEqual(
    R.flow.rows.at(-1).counts.Backlog.value,
    fc
      .cumulativeFlow(mine, fc.shownWeeks(mine, win), asOf, ["Backlog", "ToDo", "In Progress", "Review", "Done"])
      .rows.at(-2)
      .counts.get("Backlog"),
  );
  const nothing = read(ctx, { asof: "2026-11-11", epic: "PS-NONE" });
  assert.equal(nothing.window.created.value, 0);
  assert.equal(nothing.window.closed.value, 0);
  // A person's WIP keeps every story of theirs: under epic=PS-B, Ada Byron still holds PS-A's story-doing.
  const b = read(ctx, { epic: "PS-B" });
  assert.equal(b.standing.people.find((p) => p.name === "Ada Byron").wip.value, 1);
  assert.equal(b.standing.peopleWhole, true);
  assert.deepEqual(
    b.standing.epics.epics.map((x) => x.epic),
    ["PS-B"],
    "only epic and initiative narrow the epics",
  );
  assert.match(b.standing.verdicts.left, /whole vault/);
  const one = read(ctx, { assignee: "Ada Byron" });
  assert.deepEqual(
    one.standing.people.map((p) => p.name),
    ["Ada Byron"],
  );
  const p1 = read(ctx, { asof: "2026-11-11", priority: "p1" }, LATER);
  const pf = readFacts(ctx).facts.filter((f) => f.fm.priority === "p1");
  assert.equal(p1.window.created.value, fc.windowCounts(pf, win).created.length);
  assert.equal(flow(ctx, { priority: "p9" }, { now: NOW_MS }).status, 400);
  const mail = flow(ctx, { assignee: ADDRESS }, { now: NOW_MS });
  assert.equal(mail.status, 400);
  assert.ok(!mail.error.includes(ADDRESS));
  // No initiative in this vault: `none` keeps every story.
  assert.deepEqual(read(ctx, { initiative: "none" }).window, read(ctx).window);
});

// ── contract 5: the code read is a POST of the page's own ──

// [dashboard-reports#5]
test("dashboard reports: a Code block read, then a Reports code read, hold one gh pr list; fresh asks again; no token is 403 with no call", async () => {
  await withWorld({}, [pr(1)], async (w, page) => {
    const token = await tokenOf(page);
    const from = w.record.length;
    for (const headers of [
      {},
      { "x-projectstore-token": token, origin: "http://evil.example" },
      { "x-projectstore-token": "0".repeat(64), origin: `http://127.0.0.1:${page.port}` },
    ]) {
      const r = await call(page, REPORTS_CODE_ROUTE, { method: "POST", headers, body: "{}" });
      assert.equal(r.status, 403);
    }
    assert.deepEqual(w.record.slice(from), [], "no call before the guard");
    assert.equal((await call(page, REPORTS_CODE_ROUTE)).status, 404);
    assert.equal((await call(page, REPORTS_CODE_ROUTE, { method: "HEAD" })).status, 404);
    assert.equal((await call(page, REPORTS_CODE_ROUTE, { method: "OPTIONS" })).status, 405);
    assert.equal((await post(page, REPORTS_CODE_ROUTE, { weeks: "0" }, token)).status, 400);
    assert.deepEqual(w.record.slice(from), []);
    const a = await post(page, CODE_ROUTE, { rel: "epics/PS-X/stories/story-a.md" }, token);
    assert.equal(a.status, 200, a.text);
    const mark = w.record.length;
    const b = await post(page, REPORTS_CODE_ROUTE, {}, token);
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.copy, "vault");
    assert.equal(ghLists(w.record, from).length, 1, "the list the Code block keeps");
    // The Reports read's own calls are only the Code block's facts of the repository.
    for (const e of w.record.slice(mark)) assert.match(sub(e), /^(rev-parse|log -1|rev-list --count)/, sub(e));
    for (const e of w.record.slice(mark)) assert.equal(e.env?.GIT_NO_LAZY_FETCH, "1");
    const c = await post(page, REPORTS_CODE_ROUTE, { fresh: true }, token);
    assert.equal(c.status, 200, c.text);
    assert.equal(ghLists(w.record, from).length, 2, "fresh asks again");
    assert.ok(!w.record.slice(from).some((e) => e.cmd === "git" && /fetch|pull/.test(sub(e))), "never a fetch");
  });
});

// ── contract 6: a counted link apart from a lead ──

// [dashboard-reports#6]
test("dashboard reports: four open stories tied by external_refs.pr, a counted Closes-story, a title and a Closes-story from a fork give 2 by a counted link and 2 by a lead; one with an open counted pull request is not listed", async () => {
  const files = {
    "epics/PS-X/stories/story-recorded.md": open("story-recorded", {
      external_refs: JSON.stringify({ pr: `${REPO_URL}/pull/11` }),
    }),
    "epics/PS-X/stories/story-closes.md": open("story-closes"),
    "epics/PS-X/stories/story-named.md": open("story-named", {
      title: JSON.stringify("The importer reads the whole sheet"),
    }),
    "epics/PS-X/stories/story-fork.md": open("story-fork"),
    "epics/PS-X/stories/story-half.md": open("story-half", {
      external_refs: JSON.stringify({ pr: `${REPO_URL}/pull/15` }),
    }),
  };
  const prs = [
    pr(11),
    pr(12, { body: "Closes-story: PS-X/story-closes" }),
    pr(13, { title: "The importer reads the whole sheet" }),
    pr(14, { body: "Closes-story: PS-X/story-fork", isCrossRepository: true }),
    pr(15, { state: "OPEN", mergedAt: null }),
    pr(16, { body: "Closes-story: PS-X/story-half" }),
  ];
  await withWorld(files, prs, async (w, page) => {
    const r = await post(page, REPORTS_CODE_ROUTE, {}, await tokenOf(page));
    assert.equal(r.status, 200, r.text);
    const m = r.json.result.checks.find((c) => c.id === "merged_open");
    assert.equal(m.unknown, null);
    assert.deepEqual(m.counted.map((s) => s.rel.split("/").pop()).sort(), ["story-closes.md", "story-recorded.md"]);
    assert.deepEqual(m.leads.map((s) => s.rel.split("/").pop()).sort(), ["story-fork.md", "story-named.md"]);
    assert.deepEqual(m.leads.find((s) => s.rel.endsWith("story-fork.md")).prs[0].how, ["closes-uncounted"]);
    assert.equal(m.value.by, "page");
    assert.match(m.value.basis, new RegExp(`${OWN.merged_open} days`));
    assert.ok(r.json.result.checks.every((c) => c.value && c.value.by === "page"));
  });
});

// ── contract 7: unknown is never none ──

// [dashboard-reports#7]
test("dashboard reports: a logged-out gh gives the reason and no check, and the flow numbers stay (failure)", async () => {
  await withWorld({}, [], async (w, page) => {
    w.gh.set({ prs: [], auth: true });
    const r = await post(page, REPORTS_CODE_ROUTE, {}, await tokenOf(page));
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.result.unknown.prs, /not logged in/);
    assert.deepEqual(r.json.result.checks, []);
    assert.equal((await call(page, REPORTS_ROUTE)).status, 200);
  });
});

// [dashboard-reports#7]
test("dashboard reports: a full list, or a recorded pull request not in it, or no default branch, puts its reason on every check", async () => {
  const fx = flowVault({
    stories: {
      "PS-X/story-a": storyText({
        id: "story-a",
        status: "in-progress",
        fm: { external_refs: JSON.stringify({ pr: `${REPO_URL}/pull/99` }) },
      }),
    },
  });
  const ctx = await ctxOf(fx);
  const rel = readFacts(ctx).facts[0].rel;
  const survey = async () => ({
    main: { short: "main" },
    repo: "acme/app",
    listFull: true,
    unknown: { git: null, prs: null },
    prs: [{ number: 1, title: "one", url: `${REPO_URL}/pull/1`, state: "merged", mergedAt: "2026-11-05T00:00:00Z" }],
    ties: new Map([
      [
        rel,
        [
          {
            number: 99,
            url: `${REPO_URL}/pull/99`,
            title: null,
            state: null,
            mergedAt: null,
            how: ["recorded"],
            link: true,
          },
        ],
      ],
    ]),
  });
  const r = await code(ctx, {}, { survey, now: NOW_MS });
  assert.equal(r.result.unknown.recorded.length, 1);
  assert.ok(r.result.checks.length === 4, "of today: all four checks");
  for (const c of r.result.checks) {
    assert.match(c.unknown, /newest 1,000 pull requests by creation/);
    assert.match(c.unknown, /1 recorded pull request is not in the list/);
  }
  const past = await code(ctx, { asof: "2026-10-11" }, { survey, now: NOW_MS });
  assert.ok(!past.result.checks.some((c) => c.id === "merged_open"), "open stories are of today");
  assert.match(past.result.openLeft, /of today/);
  const head = await code(
    ctx,
    {},
    {
      survey: async () => ({ ...(await survey()), listFull: false, main: { short: "HEAD" }, ties: new Map() }),
      now: NOW_MS,
    },
  );
  for (const c of head.result.checks) assert.match(c.unknown, /default branch is not known/);
});

// ── contract 8: no address and no text of a pull request ──

// [dashboard-reports#8]
test("dashboard reports: an email-shaped assignee and title, and a sentinel in a story's body and a pull request's, reach neither read (failure)", async () => {
  const SENTINEL = ["sentinel", "7d1f", "body"].join("-");
  const files = {
    "epics/PS-X/stories/story-mail.md": storyText({
      id: "story-mail",
      epic: "PS-X",
      assignee: ADDRESS,
      log: [{ to: "in-progress", at: "2026-01-02T09:00:00.000Z" }],
      fm: {
        title: JSON.stringify(`Mail to ${ADDRESS} is read`),
        external_refs: JSON.stringify({ pr: `${REPO_URL}/pull/21` }),
      },
    }).replace(/\n## /, `\n${SENTINEL}\n\n## `),
  };
  const prs = [
    pr(21, { title: `A fix for ${ADDRESS}`, body: `${SENTINEL}\nCloses-story: PS-X/story-mail` }),
    pr(22, { title: `Other ${ADDRESS}` }),
  ];
  await withWorld(files, prs, async (w, page) => {
    const token = await tokenOf(page);
    const a = await call(page, REPORTS_ROUTE);
    const b = await post(page, REPORTS_CODE_ROUTE, {}, token);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    for (const text of [a.text, b.text]) {
      assert.ok(!text.includes(ADDRESS), "no address");
      assert.ok(!text.includes(SENTINEL), "no body");
    }
    assert.ok(a.json.standing.people.some((p) => p.name === "an email-shaped name"));
    assert.match(b.text, /an email-shaped name/);
    for (const c of b.json.result.checks)
      for (const p of c.prs || []) assert.ok(p.url === null || p.url.startsWith("https://"));
  });
});

// ── contract 3, a key set: ToDo against capacity as doctor judges it ──

// [dashboard-reports#3]
test("dashboard reports: with flow.window_weeks and flow.capacity_weeks set, ToDo against capacity and arrivals are doctor's verdicts at the same moment", async () => {
  const stories = {};
  for (const n of [1, 2, 3])
    stories[`PS-X/story-c${n}`] = closedStory({
      id: `story-c${n}`,
      start: `2026-11-0${n + 2}T09:00:00.000Z`,
      close: `2026-11-1${n}T09:00:00.000Z`,
    });
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8])
    stories[`PS-X/story-t${n}`] = storyText({ id: `story-t${n}`, status: "todo", created: "2026-09-01" });
  const fx = flowVault({ vaultCfg: { flow: { window_weeks: 2, capacity_weeks: [1, 2] } }, stories });
  const R = read(await ctxOf(fx), {}, LATER);
  const ids = (await doctorRun(fx, { now: new Date(LATER).toISOString() })).map((f) => f.check);
  const v = R.standing.verdicts;
  assert.equal(v.young, false);
  assert.equal(v.capacity.verdict, "over");
  assert.ok(ids.includes("todo-over-capacity"), ids.join(", "));
  assert.equal(v.intakeOverClose, ids.includes("intake-over-close"));
  assert.equal(v.weeks.by, "core");
});

// ── contract 5: the body follows the query's forms ──

// [dashboard-reports#5]
test("dashboard reports: a code read's body with a value outside its forms, a value that is not text, or another key gets 400 and no call (failure)", async () => {
  await withWorld({}, [], async (w, page) => {
    const token = await tokenOf(page);
    const from = w.record.length;
    for (const body of [{ priority: "p9" }, { weeks: 8 }, { colour: "red" }]) {
      const r = await post(page, REPORTS_CODE_ROUTE, body, token);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
    assert.deepEqual(w.record.slice(from), []);
  });
});

// ── contract 11: the checks of the window ──

const tieOf = (number, mergedAt, link = true) => ({
  number,
  url: `${REPO_URL}/pull/${number}`,
  title: `pull request ${number}`,
  state: "merged",
  mergedAt,
  how: [link ? "recorded" : "named"],
  link,
});
async function windowChecks(stories, tiesBy, prs) {
  const fx = flowVault({ stories });
  const ctx = await ctxOf(fx);
  const relOf = new Map(readFacts(ctx).facts.map((f) => [f.fm.id, f.rel]));
  const survey = async () => ({
    main: { short: "main" },
    repo: "acme/app",
    listFull: false,
    unknown: { git: null, prs: null },
    prs,
    ties: new Map(Object.entries(tiesBy).map(([id, ts]) => [relOf.get(id), ts])),
  });
  const r = await code(ctx, { weeks: "2" }, { survey, now: LATER });
  return Object.fromEntries(r.result.checks.map((c) => [c.id, c]));
}

// [dashboard-reports#11]
test("dashboard reports: 1 of 5 closed with no counted link is 20% at watch, and 2 of 4 merged with none is 50% at stumbles, each at its level (edge)", async () => {
  const stories = {};
  const ties = {};
  for (const n of [1, 2, 3, 4, 5]) {
    stories[`PS-X/story-${n}`] = closedStory({
      id: `story-${n}`,
      start: "2026-11-03T09:00:00.000Z",
      close: `2026-11-0${n + 4}T09:00:00.000Z`,
    });
    if (n > 1) ties[`story-${n}`] = [tieOf(n, `2026-11-0${n + 3}T09:00:00.000Z`)];
  }
  const prs = [2, 3, 21, 22].map((n) => ({
    number: n,
    title: `pull request ${n}`,
    url: `${REPO_URL}/pull/${n}`,
    state: "merged",
    mergedAt: "2026-11-06T09:00:00.000Z",
  }));
  const c = await windowChecks(stories, ties, prs);
  assert.deepEqual([c.closed_unlinked.value.value, c.closed_unlinked.level], [20, "warn"]);
  assert.deepEqual([c.merged_unlinked.value.value, c.merged_unlinked.level], [50, "bad"]);
  assert.deepEqual(
    c.merged_unlinked.prs.map((p) => p.number),
    [21, 22],
  );
});

// [dashboard-reports#11]
test("dashboard reports: closes 2 and 4 days after the last merge and one 3 hours before it give 2, 4 and 0 marked, a count of 2 at stumbles, and no share with nothing merged in the window (edge)", async () => {
  const stories = {
    "PS-X/story-a": closedStory({
      id: "story-a",
      start: "2026-10-28T09:00:00.000Z",
      close: "2026-11-03T09:00:00.000Z",
    }),
    "PS-X/story-b": closedStory({
      id: "story-b",
      start: "2026-10-28T09:00:00.000Z",
      close: "2026-11-03T10:00:00.000Z",
    }),
    "PS-X/story-c": closedStory({
      id: "story-c",
      start: "2026-11-10T09:00:00.000Z",
      close: "2026-11-15T23:00:00.000Z",
    }),
  };
  const ties = {
    "story-a": [tieOf(1, "2026-11-01T09:00:00.000Z")],
    "story-b": [tieOf(2, "2026-10-30T10:00:00.000Z"), tieOf(9, "2026-10-29T10:00:00.000Z", false)],
    "story-c": [tieOf(3, "2026-11-16T02:00:00.000Z")],
  };
  const c = await windowChecks(stories, ties, []);
  const days = Object.fromEntries(
    c.merge_to_close.stories.map((s) => [s.rel.split("/").pop(), [s.days.value === 0 ? 0 : s.days.value, s.early]]),
  );
  assert.deepEqual(days, { "story-a.md": [2, false], "story-b.md": [4, false], "story-c.md": [0, true] });
  assert.deepEqual([c.merge_to_close.value.value, c.merge_to_close.level], [2, "bad"]);
  assert.equal(c.merged_unlinked.value.value, null);
  assert.equal(c.merged_unlinked.level, null);
  assert.equal(c.closed_unlinked.value.value, 0);
});

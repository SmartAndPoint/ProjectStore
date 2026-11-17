// projectstore — tests/dashboard-delivery.test.mjs: the dashboard's delivery
// (PS-DASHBOARD, "The page writes by running core verbs, with a preview, and
// the click is the approval"; the spec "The dashboard's delivery: Send,
// Discard, the pull request's state, the carry and kept branches", alias
// `dashboard-delivery`).
//
// This file holds the pull request's state (contract 1), Send (contract 2)
// and the pull request's title and body (contract 3). Each case builds its
// own world (tests/fixtures/dashboard-world.mjs): a bare `origin`, which
// takes the pushes, a vault repository cloned from it, a project bound to
// that vault, and a stub gh first on PATH (tests/fixtures/gh-stub.mjs) that
// answers from the table the test writes and records each call. A merge on
// the code host is the test pushing the batch branch to the bare
// repository's default branch. No test reaches the network or the real gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { HANG_MS, hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { PR_FIELDS, SENT_LINE, decide, prText } from "../dashboard/lib/write.mjs";

hermeticGit();

const STORY_REL = "epics/PS-X/stories/story-a.md";
// Every record of the file, for the rules read at its end.
const ALL = [];

async function withWorld(opts, fn) {
  const w = await makeWorld(opts);
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
    ALL.push(...w.record);
  }
}

const move = (fields = {}) => ({
  verb: "move",
  fields: { story: "PS-X/story-a", to: "todo", reason: "next up", ...fields },
});
const SUBJECT = "move PS-X/story-a to todo: next up";

async function writable(w, opts) {
  const writer = await w.open(opts);
  const r = await writer.refresh();
  assert.equal(r.body.write.can, true, r.body.write.reason);
  return writer;
}
// A writer with one commit in an open batch: → { writer, branch }.
async function withBatch(w, opts, fields) {
  const writer = await writable(w, opts);
  const a = await writer.action(move(fields));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.write.batch.commits, 1);
  return { writer, branch: a.body.write.batch.branch };
}

const ghCalls = (w, from = 0) => w.record.slice(from).filter((e) => e.cmd === "gh");
const subOf = (argv) => {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += argv[i] === "-c" || argv[i] === "-C" ? 2 : 1;
  return { name: argv[i], rest: argv.slice(i + 1) };
};
const pushes = (w, from = 0) => w.record.slice(from).filter((e) => e.cmd === "git" && subOf(e.argv).name === "push");
// origin's refs, name to sha.
const refsOf = (w) =>
  Object.fromEntries(
    w
      .git(w.origin, "for-each-ref", "--format=%(refname) %(objectname)")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")),
  );
const tryGit = (w, cwd, ...args) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", ...w.as, ...args], { cwd, env: w.env, encoding: "utf8" });
const porcelain = (w, dir) => w.git(dir, "status", "--porcelain", "--untracked-files=all");
const pull = (branch, number, state, extra = {}) => ({
  number,
  state,
  headRefName: branch,
  headRefOid: null,
  url: `https://github.com/acme/vault/pull/${number}`,
  ...extra,
});
// A world's environment whose PATH holds git and no gh.
function noGh(w) {
  const bin = join(w.root, "bin-no-gh");
  mkdirSync(bin, { recursive: true });
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!existsSync(join(bin, "git"))) symlinkSync(which, join(bin, "git"));
  return { ...w.env, PATH: bin };
}

// The page's server, in process: one request with the Host it answers to.
function call(page, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: page.port, path, method, headers: { host: `127.0.0.1:${page.port}`, ...headers } },
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
  /<meta name="projectstore-token" content="([^"]*)"/.exec((await call(page, "/")).text)?.[1];
const own = (page, token) => ({ "x-projectstore-token": token, origin: `http://127.0.0.1:${page.port}` });
const post = (page, path, headers = {}, body = undefined) => call(page, path, { method: "POST", headers, body });

// ─── Contract 1: the pull request's state ───────────────────────────────

// [dashboard-delivery#1]
test("dashboard delivery: a preview and an action ask gh nothing: the spawn record holds no gh call", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const from = w.record.length;
    const stubFrom = w.gh.log().length;
    assert.equal((await writer.preview(move())).status, 200);
    assert.equal((await writer.action(move())).status, 200);
    assert.equal((await writer.preview(move({ to: "planned" }))).status, 200);
    assert.deepEqual(ghCalls(w, from), [], "no gh call in the spawn record");
    assert.equal(w.gh.log().length, stubFrom, "the stub saw no call");
  });
});

// [dashboard-delivery#1]
test("dashboard delivery: of a branch's pull requests the open one decides, then a merged one, then the newest", () => {
  const open = pull("b", 5, "OPEN");
  assert.equal(decide([pull("b", 3, "CLOSED"), open, pull("b", 7, "CLOSED")]).number, 5);
  assert.equal(decide([pull("b", 3, "MERGED"), pull("b", 9, "CLOSED")]).number, 3);
  assert.equal(decide([pull("b", 3, "CLOSED"), pull("b", 9, "CLOSED")]).number, 9);
  assert.equal(decide([pull("b", 4, "merged")]).state, "MERGED", "the state in upper case");
  assert.equal(decide([]), null);
  assert.equal(decide("no list"), null);
  assert.equal(PR_FIELDS, "number,state,headRefOid,url");
});

// [dashboard-delivery#1]
test("dashboard delivery: when gh pr list answers a closed and an open pull request for the batch's branch, the open one decides, and write.batch.pull_request holds its number, state and url", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    assert.equal(writer.view().batch.pull_request, null, "null until an answer names one");
    w.gh.set({ pulls: [pull(branch, 3, "CLOSED"), pull(branch, 5, "OPEN"), pull("dashboard/other/x", 9, "OPEN")] });
    const from = w.record.length;
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.write.batch.pull_request, {
      number: 5,
      state: "OPEN",
      url: "https://github.com/acme/vault/pull/5",
    });
    assert.equal(r.body.write.batch.branch, branch, "the batch stays open");
    assert.equal(r.body.write.pull_requests, null, "null while gh answers");
    const calls = ghCalls(w, from);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["pr", "list", `--head=${branch}`, "--state=all", `--json=${PR_FIELDS}`]);
    assert.equal(calls[0].cwd, writer.paths.clone, "gh runs in the clone");
    assert.equal(calls[0].env.GH_PROMPT_DISABLED, "1");
    assert.deepEqual(writer.view(), r.body.write, "the next GET holds it as last asked");
  });
});

// [dashboard-delivery#1] [dashboard-writes#8]
test("dashboard delivery: with gh logged out and no batch open, write.pull_requests says gh cannot be asked and why, the refresh fails no step, and the spawn record holds one gh pr list for dashboard/<person>/none", async () => {
  await withWorld({}, async (w) => {
    w.gh.set({ auth: true });
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.can, true, r.body.write.reason);
    assert.equal(r.body.write.batch, null);
    assert.match(r.body.write.pull_requests, /gh cannot be asked/);
    assert.match(r.body.write.pull_requests, /gh auth login/);
    const calls = ghCalls(w);
    assert.equal(calls.length, 1, "one gh call");
    assert.deepEqual(calls[0].argv, [
      "pr",
      "list",
      "--head=dashboard/test-person/none",
      "--state=all",
      "--json=number,state,headRefOid,url",
    ]);
    // gh answering again: null.
    w.gh.set({});
    assert.equal((await writer.refresh()).body.write.pull_requests, null);
  });
});

// [dashboard-delivery#1] [dashboard-writes#8]
test("dashboard delivery: with gh logged out, or a gh pr list past its budget, and a batch open, the batch stays open and the refresh fails no step", async () => {
  await withWorld({}, async (w) => {
    // The stub answers through a Node start: the cases it answers keep gh's
    // own budget; only the hang runs on a writer with a short one.
    const { writer, branch } = await withBatch(w);
    const head = w.git(writer.paths.clone, "rev-parse", "HEAD");
    const short = await w.open({ budgets: { gh: HANG_MS } });
    for (const [table, by, why] of [
      [{ auth: true }, writer, /gh auth login/],
      [{ fail: { list: "hang" } }, short, new RegExp(`gh pr list ran past its ${HANG_MS} ms budget`)],
      [{ fail: { list: 1 } }, writer, /HTTP 502/],
    ]) {
      w.gh.set(table);
      const r = await by.refresh();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.write.batch?.branch, branch, `the batch stays open (${JSON.stringify(table)})`);
      assert.match(r.body.write.pull_requests, /gh cannot be asked/);
      assert.match(r.body.write.pull_requests, why);
      assert.equal(w.git(writer.paths.clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
      assert.equal(w.git(writer.paths.clone, "rev-parse", "HEAD"), head);
    }
  });
});

// [dashboard-delivery#1] [dashboard-delivery#6]
test("dashboard delivery: when the page is opened after the pull request was closed on the code host, no batch is open, the clone is detached at the fetched default branch, and write.kept names the branch", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    const tip = w.git(writer.paths.clone, "rev-parse", "HEAD");
    await writer.stop();
    w.gh.set({ pulls: [pull(branch, 4, "CLOSED")] });
    // The page opened again: a server's start, then the page's refresh.
    const page = await w.start();
    const state = (await call(page, "/api/state")).json;
    assert.equal(state.write.batch, null, "no batch is open");
    assert.deepEqual(state.write.kept, [{ branch, commits: 1 }]);
    const token = await tokenOf(page);
    const r = await post(page, "/api/refresh", own(page, token));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.write.batch, null);
    assert.deepEqual(r.json.write.kept, [{ branch, commits: 1 }]);
    const clone = page.writer.paths.clone;
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
    assert.equal(w.git(clone, "rev-parse", "HEAD"), w.git(clone, "rev-parse", "refs/remotes/origin/main"));
    assert.equal(w.git(clone, "rev-parse", `refs/heads/${branch}`), tip, "the branch is kept");
  });
});

// [dashboard-delivery#1]
test("dashboard delivery: with no gh and the batch's head an ancestor of the fetched default branch, the batch counts as merged: no branch is kept, and the clone is detached", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w, { env: noGh(w) });
    const clone = writer.paths.clone;
    // Merged on the code host: the default branch at the batch's head.
    w.git(clone, "push", "-q", "origin", `refs/heads/${branch}:refs/heads/main`);
    const tip = w.git(clone, "rev-parse", "HEAD");
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.batch, null);
    assert.deepEqual(r.body.write.kept, []);
    assert.match(r.body.write.pull_requests, /gh is not installed or not on PATH/);
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(w.git(clone, "rev-parse", "HEAD"), tip);
    assert.equal(tryGit(w, clone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status, 1, "deleted");

    // A batch not yet in the default branch stays open without gh.
    const a = await writer.action(move({ to: "planned", reason: "later" }));
    const open = a.body.write.batch.branch;
    const again = await writer.refresh();
    assert.equal(again.body.write.batch?.branch, open);
  });
});

// ─── Contract 2: Send ───────────────────────────────────────────────────

// [dashboard-delivery#2] [dashboard-delivery#3] [dashboard-writes#8] [dashboard-writes#9]
test("dashboard delivery: through the server, Send with no pull request yet pushes the batch branch to origin, opens one pull request into the default branch with the commit's subject as its title, and no other ref of origin moves", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    const body = JSON.stringify(move());
    const a = await post(page, "/api/action", own(page, token), body);
    assert.equal(a.status, 200, a.text);
    const branch = a.json.write.batch.branch;
    const before = refsOf(w);
    // No token: 403 and no call.
    const from = w.record.length;
    assert.equal((await post(page, "/api/send", { origin: `http://127.0.0.1:${page.port}` })).status, 403);
    assert.equal(w.record.length, from);
    const s = await post(page, "/api/send", own(page, token));
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(Object.keys(s.json), ["ok", "result", "write"]);
    assert.equal(s.json.ok, true);
    const pr = { number: 1, state: "OPEN", url: "https://github.com/acme/vault/pull/1" };
    assert.deepEqual(s.json.result, { branch, sent: true, commits: 1, merged: 0, pull_request: pr, gh: null });
    assert.deepEqual(s.json.write.batch.pull_request, pr);
    assert.equal(s.json.write.batch.branch, branch, "the batch stays open after Send");
    const clone = page.writer.paths.clone;
    const after = refsOf(w);
    assert.equal(after[`refs/heads/${branch}`], w.git(clone, "rev-parse", "HEAD"), "origin has the batch branch");
    delete after[`refs/heads/${branch}`];
    assert.deepEqual(after, before, "no other ref of origin moved");
    // One pull request, into the default branch, with contract 3's text.
    const pulls = w.gh.table().pulls;
    assert.equal(pulls.length, 1);
    assert.deepEqual([pulls[0].headRefName, pulls[0].baseRefName], [branch, "main"]);
    assert.equal(pulls[0].title, SUBJECT);
    assert.equal(pulls[0].body, `- ${SUBJECT}\n\n${SENT_LINE}`);
    const gh = ghCalls(w, from).map((e) => e.argv);
    assert.deepEqual(gh, [
      ["pr", "list", `--head=${branch}`, "--state=all", `--json=${PR_FIELDS}`],
      ["pr", "create", "--base=main", `--head=${branch}`, `--title=${SUBJECT}`, `--body=- ${SUBJECT}\n\n${SENT_LINE}`],
    ]);
    assert.ok(
      w.gh.log().every((c) => c.prompt === "1"),
      "every gh call ran with GH_PROMPT_DISABLED=1",
    );
    const push = pushes(w, from);
    assert.equal(push.length, 1);
    assert.deepEqual(push[0].argv.slice(-4), ["--porcelain", "--", "origin", `refs/heads/${branch}`]);
    assert.ok(push[0].argv.includes("push.followTags=false"));
    // The next GET holds it; a second Send pushes again and opens none.
    assert.deepEqual((await call(page, "/api/state")).json.write, s.json.write);
    const again = await post(page, "/api/send", own(page, token));
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json.result.pull_request, pr);
    assert.equal(w.gh.table().pulls.length, 1, "no second pull request");
    assert.equal(w.gh.calls("pr create").length, 1);
  });
});

// [dashboard-delivery#2]
test("dashboard delivery: when the remote batch branch has a commit the clone lacks, Send merges it without a rebase, and the push needs no force", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    assert.equal((await writer.send()).status, 200);
    // A commit on the code host's batch branch ("Update branch", or a fix there).
    const other = w.cloneInto(join(w.root, "other"));
    w.git(other, "switch", "-q", branch);
    writeFileSync(join(other, "notes.md"), "from the code host\n");
    w.git(other, "add", "-A");
    w.git(other, ...w.as, "commit", "-q", "-m", "a commit on the code host");
    w.git(other, "push", "-q", "origin", branch);
    const remote = w.git(other, "rev-parse", "HEAD");
    const sent = w.git(writer.paths.clone, "rev-parse", "HEAD");
    assert.equal((await writer.action(move({ to: "planned", reason: "later" }))).status, 200);
    const mine = w.git(writer.paths.clone, "rev-parse", "HEAD");
    const from = w.record.length;
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.merged, 1);
    const clone = writer.paths.clone;
    const head = w.git(clone, "rev-parse", "HEAD");
    assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), head, "pushed");
    assert.deepEqual(w.git(clone, "rev-parse", "HEAD^1", "HEAD^2").split("\n"), [mine, remote], "a merge commit");
    assert.equal(tryGit(w, clone, "merge-base", "--is-ancestor", sent, head).status, 0);
    for (const e of pushes(w, from))
      for (const a of ["--force", "-f", "--force-with-lease"]) assert.ok(!e.argv.includes(a));
    assert.ok(!w.record.slice(from).some((e) => e.cmd === "git" && subOf(e.argv).name === "rebase"), "no rebase");
    // The batch's remote branch fetched to an explicit destination.
    const fetch = w.record.slice(from).find((e) => e.cmd === "git" && subOf(e.argv).name === "fetch");
    assert.deepEqual(subOf(fetch.argv).rest, [
      "--quiet",
      "--no-write-fetch-head",
      "--",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    assert.equal(r.body.write.batch.commits, 4, "two of the person's, the code host's and the merge");
    assert.equal(r.body.result.commits, 3, "the commits that are no merge");
    assert.equal(porcelain(w, clone), "");
  });
});

// [dashboard-delivery#2]
test("dashboard delivery: when merging the remote batch branch conflicts, the merge is aborted, nothing is pushed, the clone is as before Send, and the answer names the unsent commits and the two ways on", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    assert.equal((await writer.send()).status, 200);
    const other = w.cloneInto(join(w.root, "other"));
    w.git(other, "switch", "-q", branch);
    const file = join(other, STORY_REL);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^status: todo$/m, "status: in-progress"));
    w.git(other, ...w.as, "commit", "-q", "-am", "started on the code host");
    w.git(other, "push", "-q", "origin", branch);
    const remote = w.git(other, "rev-parse", "HEAD");
    assert.equal((await writer.action(move({ to: "planned", reason: "later" }))).status, 200);
    const clone = writer.paths.clone;
    const head = w.git(clone, "rev-parse", "HEAD");
    const from = w.record.length;
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /conflict/);
    assert.match(r.body.error, /move PS-X\/story-a to planned: later/, "names the unsent commit");
    assert.match(r.body.error, /merge the pull request as it was sent/);
    assert.match(r.body.error, /Discard/);
    assert.deepEqual(
      r.body.result.unsent.map((c) => c.subject),
      ["move PS-X/story-a to planned: later"],
    );
    assert.deepEqual(pushes(w, from), [], "nothing is pushed");
    assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), remote);
    assert.equal(w.git(clone, "rev-parse", "HEAD"), head, "the clone is as before Send");
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(porcelain(w, clone), "");
    assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")), "no merge left");
    assert.equal(r.body.write.batch.branch, branch, "the batch stays open");
  });
});

// [dashboard-delivery#2]
test("dashboard delivery: when the pull request is closed, Send pushes nothing, the batch ends, and the answer names the kept branch and its unsent commits", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    w.gh.set({ pulls: [pull(branch, 2, "CLOSED")] });
    const before = refsOf(w);
    const from = w.record.length;
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /#2 was closed without a merge, so nothing was sent/);
    assert.ok(r.body.error.includes(branch), "names the kept branch");
    assert.ok(r.body.error.includes(SUBJECT), "names its unsent commit");
    assert.deepEqual(r.body.result.kept, { branch, commits: 1 });
    assert.deepEqual(pushes(w, from), []);
    assert.deepEqual(refsOf(w), before);
    assert.equal(w.gh.calls("pr create").length, 0);
    assert.equal(r.body.write.batch, null);
    assert.deepEqual(r.body.write.kept, [{ branch, commits: 1 }]);
    assert.equal(w.git(writer.paths.clone, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  });
});

// [dashboard-delivery#2]
test("dashboard delivery: when gh is missing, Send pushes, and the answer holds the branch's name and gh's message", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w, { env: noGh(w) });
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.branch, branch);
    assert.equal(r.body.result.pull_request, null);
    assert.match(r.body.result.gh, /gh is not installed or not on PATH/);
    assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), w.git(writer.paths.clone, "rev-parse", "HEAD"));
    assert.equal(r.body.write.batch.branch, branch, "the batch stays open");
    assert.deepEqual(w.gh.log(), [], "no gh ran");
  });
});

// [dashboard-delivery#2] [dashboard-writes#8]
test("dashboard delivery: when gh pr create fails after the push, Send answers 502 with gh's message, the branch stays on origin, and the next Send asks again and opens it", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    w.gh.set({ fail: { create: 1 } });
    const asked = w.gh.calls("pr list").length;
    const r = await writer.send();
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /Head sha can't be blank/);
    assert.ok(r.body.error.includes(branch));
    assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), w.git(writer.paths.clone, "rev-parse", "HEAD"));
    assert.equal(r.body.write.batch.branch, branch);
    assert.ok(!existsSync(writer.paths.lock), "no lock left");
    w.gh.set({});
    const again = await writer.send();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.result.pull_request.number, 1);
    assert.equal(w.gh.calls("pr list").length, asked + 2, "each Send asked, the next one again");
    assert.equal(w.gh.calls("pr create").length, 2);
  });
});

// [dashboard-delivery#2] [dashboard-writes#8]
test("dashboard delivery: a push that fails answers 502 with git's message, and no pull request is opened", async () => {
  await withWorld({}, async (w) => {
    // The vault repository pushes elsewhere; the clone copies the key.
    w.git(w.repo, "config", "remote.origin.pushurl", join(w.root, "no-such-origin.git"));
    const { writer } = await withBatch(w);
    const r = await writer.send();
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.match(r.body.error, /the push of dashboard\/test-person\/\S+ to origin failed/);
    assert.match(r.body.error, /no-such-origin\.git/);
    assert.equal(w.gh.calls("pr create").length, 0);
  });
});

// [dashboard-delivery#2]
test("dashboard delivery: when the pull request is merged and no commit is left to carry, Send sends nothing and says so, the batch ends and its branch is deleted", async () => {
  await withWorld({}, async (w) => {
    const { writer, branch } = await withBatch(w);
    assert.equal((await writer.send()).status, 200);
    const clone = writer.paths.clone;
    const head = w.git(clone, "rev-parse", "HEAD");
    w.git(clone, "push", "-q", "origin", `refs/heads/${branch}:refs/heads/main`);
    w.gh.set({ pulls: [pull(branch, 1, "MERGED", { headRefOid: head })] });
    const from = w.record.length;
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /#1 was merged, and no commit was left to carry, so nothing was sent/);
    assert.deepEqual(pushes(w, from), []);
    assert.equal(r.body.write.batch, null);
    assert.deepEqual(r.body.write.kept, []);
    assert.equal(tryGit(w, clone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status, 1);
  });
});

// ─── Contract 3: the pull request's title and body ──────────────────────

// [dashboard-delivery#3]
test("dashboard delivery: the title is the subject for a batch of one, else the count; the body lists the subjects, oldest first, and ends with the page's line", () => {
  assert.deepEqual(prText(["a"]), { title: "a", body: `- a\n\n${SENT_LINE}` });
  assert.deepEqual(prText(["a", "b", "c"]), {
    title: "Backlog changes from the dashboard (3)",
    body: `- a\n- b\n- c\n\n${SENT_LINE}`,
  });
  assert.equal(SENT_LINE, "Sent from projectstore dashboard.");
});

// [dashboard-delivery#3]
test("dashboard delivery: a batch of one commit is sent with that commit's subject as the pull request's title", async () => {
  await withWorld({}, async (w) => {
    const { writer } = await withBatch(w, {}, { reason: "this week" });
    assert.equal((await writer.send()).status, 200);
    const [pr] = w.gh.table().pulls;
    assert.equal(pr.title, "move PS-X/story-a to todo: this week");
    assert.equal(pr.body, `- move PS-X/story-a to todo: this week\n\n${SENT_LINE}`);
  });
});

// [dashboard-delivery#3]
test("dashboard delivery: a batch of three commits is sent as Backlog changes from the dashboard (3), its body listing the three subjects, oldest first", async () => {
  await withWorld({}, async (w) => {
    const { writer } = await withBatch(w, {}, { reason: "first" });
    assert.equal((await writer.action(move({ to: "planned", reason: "second" }))).status, 200);
    assert.equal((await writer.action(move({ to: "todo", reason: "third" }))).status, 200);
    assert.equal(writer.view().batch.commits, 3);
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [pr] = w.gh.table().pulls;
    assert.equal(pr.title, "Backlog changes from the dashboard (3)");
    assert.equal(
      pr.body,
      [
        "- move PS-X/story-a to todo: first",
        "- move PS-X/story-a to planned: second",
        "- move PS-X/story-a to todo: third",
        "",
        SENT_LINE,
      ].join("\n"),
    );
  });
});

// [dashboard-delivery#3] [dashboard-writes#9]
test("dashboard delivery: a commit subject that starts with - reaches gh whole, inside --title= and --body=", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    // A batch whose one commit's subject starts with a dash.
    w.git(clone, "switch", "-q", "-c", "dashboard/test-person/20261117T100000Z");
    writeFileSync(join(clone, "notes.md"), "x\n");
    w.git(clone, "add", "-A");
    w.git(clone, "commit", "-q", "--message=-f is no option here");
    assert.equal((await writer.refresh()).body.write.batch.commits, 1);
    const r = await writer.send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const create = w.gh.calls("pr create")[0];
    assert.ok(create.includes("--title=-f is no option here"), create.join(" | "));
    assert.ok(create.includes(`--body=- -f is no option here\n\n${SENT_LINE}`), create.join(" | "));
    assert.ok(!create.includes("-f"), "no argument is the bare -f");
    assert.equal(w.gh.table().pulls[0].title, "-f is no option here");
  });
});

// [dashboard-delivery#3]
test("dashboard delivery: the subjects are oldest first by ancestry, also when a later commit carries an earlier date", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    w.git(clone, "switch", "-q", "-c", "dashboard/test-person/20261117T110000Z");
    const commitAt = (name, date) => {
      writeFileSync(join(clone, `${name}.md`), `${name}\n`);
      w.git(clone, "add", "-A");
      const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", `--message=${name}`], {
        cwd: clone,
        env: { ...w.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
    };
    // A clock that went back: the parent is dated after its children.
    commitAt("first", "2026-11-17T12:00:00Z");
    commitAt("second", "2026-11-17T09:00:00Z");
    commitAt("third", "2026-11-17T10:00:00Z");
    assert.equal((await writer.refresh()).body.write.batch.commits, 3);
    assert.equal((await writer.send()).status, 200);
    const [pr] = w.gh.table().pulls;
    assert.equal(pr.body, `- first\n- second\n- third\n\n${SENT_LINE}`);
  });
});

// [dashboard-delivery#1] [dashboard-writes#9]
test("dashboard delivery: GH_REPO and GH_HOST in the server's environment never reach gh, so it asks about the clone's origin; GH_TOKEN stays", async () => {
  await withWorld({}, async (w) => {
    const env = { ...w.env, GH_REPO: "evil/elsewhere", GH_HOST: "evil.example", GH_TOKEN: "t" };
    const { writer } = await withBatch(w, { env });
    assert.equal((await writer.send()).status, 200);
    const log = w.gh.log();
    assert.ok(log.length >= 2, "gh ran");
    for (const c of log) {
      assert.deepEqual(c.env, { GH_REPO: null, GH_HOST: null }, c.argv.join(" "));
      assert.equal(c.token, true, "the token is no place: it stays");
    }
    for (const e of ghCalls(w)) {
      assert.equal(e.env.GH_REPO, undefined);
      assert.equal(e.env.GH_HOST, undefined);
    }
  });
});

// [dashboard-delivery#6] [dashboard-writes#8]
test("dashboard delivery: a kept branch git cannot count fails the refresh with 502 and git's message naming the branch, and is never left out of write.kept in silence", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    // A branch at a commit whose parent the clone lacks: listed by
    // for-each-ref, and git rev-list cannot walk it.
    const text = join(w.root, "broken-commit.txt");
    writeFileSync(
      text,
      `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${"1".repeat(40)}\nauthor A <a> 1 +0000\ncommitter A <a> 1 +0000\n\nbroken\n`,
    );
    const broken = w.git(clone, "hash-object", "-w", "-t", "commit", "--literally", text);
    const name = "dashboard/test-person/20261117T090000Z";
    mkdirSync(join(clone, ".git", "refs", "heads", "dashboard", "test-person"), { recursive: true });
    writeFileSync(join(clone, ".git", "refs", "heads", ...name.split("/")), `${broken}\n`);
    const r = await writer.refresh();
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.ok(r.body.error.includes(`git cannot count the commits of the kept branch ${name}`), r.body.error);
    for (const k of writer.view().kept) assert.equal(typeof k.commits, "number");
  });
});

// ─── Every call of the file ─────────────────────────────────────────────

// [dashboard-writes#9]
test("dashboard delivery: no push or gh call of the file forces, deletes or mirrors, none is gh pr merge, every positional argument follows an end-of-options mark, and every gh call disables gh's prompts", () => {
  assert.ok(
    ALL.some((e) => e.cmd === "gh"),
    "the record holds gh calls",
  );
  assert.ok(
    ALL.some((e) => e.cmd === "git" && subOf(e.argv).name === "merge"),
    "and a merge",
  );
  const FORCING = ["--force", "-f", "--force-with-lease", "--delete", "--mirror", "-d", "--delete-branch"];
  for (const e of ALL) {
    assert.ok(["git", "gh", process.execPath].includes(e.cmd), `no shell: ${e.cmd}`);
    if (e.cmd === process.execPath) continue;
    const { name, rest } = e.cmd === "git" ? subOf(e.argv) : { name: e.argv[0], rest: e.argv.slice(1) };
    if (e.cmd === "gh") {
      assert.notDeepEqual(e.argv.slice(0, 2), ["pr", "merge"]);
      assert.equal(e.env.GH_PROMPT_DISABLED, "1");
    }
    if (e.cmd === "gh" || name === "push") {
      for (const a of e.argv)
        assert.ok(!FORCING.includes(a) && !a.startsWith("--force-with-lease="), `${e.argv.join(" ")}: ${a}`);
      if (name === "push") assert.ok(!/[+:]/.test(e.argv.at(-1)), `a plain refspec: ${e.argv.at(-1)}`);
    }
    if (e.cmd === "git" && name === "var") continue;
    const mark = rest.findIndex((a) => a === "--" || a === "--end-of-options");
    const options = mark === -1 ? rest : rest.slice(0, mark);
    const own = e.cmd === "gh" || (e.cmd === "git" && name === "remote") ? options.slice(1) : options;
    for (const a of own) assert.ok(a.startsWith("-"), `${e.cmd} ${e.argv.join(" ")}: ${a} comes before the mark`);
  }
});

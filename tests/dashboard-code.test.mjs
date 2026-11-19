// projectstore — tests for the dashboard's Code block (PS-DASHBOARD, "The page
// shows a story's pull requests and a spec's files, each link labelled by its
// strength"; the spec "The dashboard's Code block: a story's pull requests by
// the strength of each link, and a spec's files, read from the local
// repository", alias `dashboard-code`).
//
// A world (tests/fixtures/dashboard-world.mjs) with a plain-folder vault, so
// the page reads the bound vault and cannot write. The code repository is
// built with a history of a true merge, squashes, a rebase of two commits, a
// nested merge and loose commits, each at a fixed committer time and name,
// pushed to a bare origin and cloned from it, so `refs/remotes/origin/HEAD`
// points to `main`. The server runs in process (startServer, port 0) over the
// clone, with a stub gh first on PATH; the spawn record holds every call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { HANG_MS, REPO, hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { gitRecorder, realGit } from "./fixtures/git-recorder.mjs";
import { startServer, CODE_ROUTE } from "../dashboard/server.mjs";
import { rangeOf, resolveStory, sinceWindow, LIST_LIMIT, KEEP_MS } from "../dashboard/lib/code.mjs";
import { openWriter, refusal } from "../dashboard/lib/write.mjs";
import { resolveStory as coreResolveStory } from "../scripts/move.mjs";
import { sinceWindow as coreSinceWindow } from "../scripts/diff-refs.mjs";
import * as lib from "../scripts/lib.mjs";

hermeticGit();

const REPO_URL = "https://github.com/acme/app";
const prUrl = (n) => `${REPO_URL}/pull/${n}`;

// ── the code repository ──

function gitIn(env, cwd, args, extra = {}) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// One commit: its files, its message, its time and its committer (and author).
function commit(env, dir, { files, message, at, by = "Dev" }) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  gitIn(env, dir, ["add", "--", ...Object.keys(files)]);
  const who = {
    GIT_AUTHOR_NAME: by,
    GIT_AUTHOR_EMAIL: "dev",
    GIT_COMMITTER_NAME: by,
    GIT_COMMITTER_EMAIL: "dev",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
  gitIn(env, dir, ["commit", "-q", "--allow-empty", "-m", message], who);
  return gitIn(env, dir, ["rev-parse", "HEAD"]);
}
function merge(env, dir, branch, { message, at, by = "Merger" }) {
  const who = {
    GIT_AUTHOR_NAME: by,
    GIT_AUTHOR_EMAIL: "dev",
    GIT_COMMITTER_NAME: by,
    GIT_COMMITTER_EMAIL: "dev",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
  gitIn(env, dir, ["merge", "-q", "--no-ff", "-m", message, branch], who);
  return gitIn(env, dir, ["rev-parse", "HEAD"]);
}

// The history every case reads, built in the world's code repository (the
// seed), and the commits by name.
function buildHistory(w) {
  const e = w.env;
  const d = w.main;
  const c = {};
  // #1: a true merge over three commits.
  gitIn(e, d, ["switch", "-q", "-c", "f1"]);
  c.a1 = commit(e, d, { files: { "scripts/a.mjs": "1\n" }, message: "a1", at: "2026-11-10T10:00:00Z", by: "Ann" });
  c.a2 = commit(e, d, { files: { "scripts/a.mjs": "2\n" }, message: "a2", at: "2026-11-10T10:05:00Z", by: "Ann" });
  c.a3 = commit(e, d, { files: { "tests/a.test.mjs": "t\n" }, message: "a3", at: "2026-11-10T10:10:00Z", by: "Ann" });
  gitIn(e, d, ["switch", "-q", "main"]);
  c.m1 = merge(e, d, "f1", { message: "Merge #1", at: "2026-11-10T11:00:00Z" });
  // #2: a squash.
  c.s1 = commit(e, d, {
    files: { "scripts/sub/b.mjs": "b\n" },
    message: "b (#2)",
    at: "2026-11-11T09:00:00Z",
    by: "Bot",
  });
  // A loose commit, then #3: a rebase of two commits in one second.
  c.l0 = commit(e, d, { files: { "docs/note.md": "n\n" }, message: "note", at: "2026-11-12T08:00:00Z", by: "Bot" });
  c.r1 = commit(e, d, { files: { "scripts/c.mjs": "1\n" }, message: "c1", at: "2026-11-12T09:00:00Z", by: "Rebaser" });
  c.r2 = commit(e, d, { files: { "scripts/c.mjs": "2\n" }, message: "c2", at: "2026-11-12T09:00:00Z", by: "Rebaser" });
  // A loose commit in the same second and by the same committer as #4's squash: the known error.
  c.l1 = commit(e, d, { files: { "docs/other.md": "o\n" }, message: "loose", at: "2026-11-13T09:00:00Z", by: "Bot" });
  c.s2 = commit(e, d, { files: { "scripts/d.mjs": "d\n" }, message: "d (#4)", at: "2026-11-13T09:00:00Z", by: "Bot" });
  // #5 and #6: two squashes in one second; the walk from #6 stops at #5's commit.
  c.s3 = commit(e, d, { files: { "scripts/f.mjs": "f\n" }, message: "f (#5)", at: "2026-11-14T09:00:00Z", by: "Bot" });
  c.s4 = commit(e, d, { files: { "scripts/g.mjs": "g\n" }, message: "g (#6)", at: "2026-11-14T09:00:00Z", by: "Bot" });
  // #7 merged into a feature branch, which #8 merges into main.
  gitIn(e, d, ["switch", "-q", "-c", "f2"]);
  c.n1 = commit(e, d, { files: { "scripts/e.mjs": "1\n" }, message: "e1", at: "2026-11-15T09:00:00Z", by: "Eve" });
  gitIn(e, d, ["switch", "-q", "-c", "f3"]);
  c.n2 = commit(e, d, { files: { "scripts/e.mjs": "2\n" }, message: "e2", at: "2026-11-15T09:10:00Z", by: "Eve" });
  gitIn(e, d, ["switch", "-q", "f2"]);
  c.n = merge(e, d, "f3", { message: "Merge #7", at: "2026-11-15T09:20:00Z" });
  gitIn(e, d, ["switch", "-q", "main"]);
  c.m2 = merge(e, d, "f2", { message: "Merge #8", at: "2026-11-15T10:00:00Z" });
  return c;
}

const PR = (number, fields) => ({
  number,
  title: `pull request ${number}`,
  body: "",
  state: "MERGED",
  url: prUrl(number),
  isCrossRepository: false,
  baseRefName: "main",
  mergedAt: null,
  mergeCommit: null,
  ...fields,
});
const merged = (number, oid, at, fields = {}) => PR(number, { mergeCommit: { oid }, mergedAt: at, ...fields });

function pullsOf(c) {
  return [
    merged(1, c.m1, "2026-11-10T11:00:00Z"),
    merged(2, c.s1, "2026-11-11T09:00:00Z"),
    merged(3, c.r2, "2026-11-12T09:00:00Z"),
    merged(4, c.s2, "2026-11-13T09:00:00Z"),
    merged(5, c.s3, "2026-11-14T09:00:00Z"),
    merged(6, c.s4, "2026-11-14T09:00:01Z"),
    merged(7, c.n, "2026-11-15T09:20:00Z", { baseRefName: "f2" }),
    merged(8, c.m2, "2026-11-15T10:00:00Z"),
    PR(9, { state: "OPEN" }),
    PR(10, { state: "CLOSED", closedAt: "2026-11-16T00:00:00Z" }),
  ];
}

// The story the cases read, written into the vault.
const STORY_REL = "epics/PS-X/stories/story-code.md";
function storyText({
  title = "The code block is read for this story",
  started = "2026-11-10",
  closed = null,
  refs = '["scripts/"]',
  pr = null,
  body = "",
} = {}) {
  return [
    "---",
    "type: story",
    'id: "story-code"',
    'epic: "PS-X"',
    `title: "${title}"`,
    "status: in-progress",
    "created: 2026-11-01",
    `external_refs: ${pr ? JSON.stringify({ pr }) : "{}"}`,
    `code_refs: ${refs}`,
    `started_at: ${started ? JSON.stringify(started) : "null"}`,
    `closed_at: ${closed ? JSON.stringify(closed) : "null"}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

const ALL = [];
// A world, its history pushed to a bare origin, and a clone of it bound to the
// world's vault: { w, c, project, origin, put(rel, text), start(opts) }.
async function codeWorld({ prs = null, partial = false } = {}) {
  const w = await makeWorld({ plainVault: true });
  const c = buildHistory(w);
  const origin = join(w.root, "code-origin.git");
  gitIn(w.env, w.root, ["init", "-q", "--bare", origin]);
  gitIn(w.env, origin, ["config", "uploadpack.allowFilter", "true"]);
  gitIn(w.env, w.main, ["push", "-q", origin, "main", "f1", "f2", "f3"]);
  gitIn(w.env, origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const project = join(w.root, "proj");
  gitIn(w.env, w.root, [
    "clone",
    "-q",
    ...(partial ? ["--filter=blob:none", "--no-checkout"] : []),
    `file://${origin}`,
    project,
  ]);
  if (partial) gitIn(w.env, project, ["checkout", "-q", "main"]);
  mkdirSync(join(project, ".projectstore"), { recursive: true });
  writeFileSync(
    join(project, ".projectstore", "projectstore.json"),
    JSON.stringify({ vault_path: w.vault, layout: "engineering", language: "en", default_author: "Test Person" }),
  );
  w.gh.set({ prs: prs ?? pullsOf(c) });
  const put = (rel, text) => {
    mkdirSync(dirname(join(w.vault, rel)), { recursive: true });
    writeFileSync(join(w.vault, rel), text);
  };
  put(STORY_REL, storyText());
  const pages = [];
  const start = async (opts = {}) => {
    const page = await startServer({
      core: REPO,
      project,
      port: 0,
      env: { ...w.env, TZ: "UTC" },
      record: w.record,
      ...opts,
    });
    pages.push(page);
    return page;
  };
  const cleanup = async () => {
    for (const p of pages) await p.close();
    await w.cleanup();
    ALL.push(...w.record);
  };
  return { w, c, project, origin, put, start, cleanup };
}
async function withCode(opts, fn) {
  const cw = await codeWorld(opts);
  try {
    return await fn(cw);
  } finally {
    await cw.cleanup();
  }
}

// ── the HTTP side ──

function call(page, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      // No kept-alive socket: a test that blocks the loop would find it closed.
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
          done({ status: res.statusCode, headers: res.headers, text, json });
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
async function ask(page, body, token = null) {
  const t = token ?? (await tokenOf(page));
  return call(page, CODE_ROUTE, { method: "POST", headers: own(page, t), body: JSON.stringify(body) });
}
const story = async (page, extra = {}) => {
  const r = await ask(page, { rel: STORY_REL, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.result;
};
const reads = (w, from = 0) => w.record.slice(from).filter((e) => e.via === "readCode");
const sub = (e) => {
  let i = 0;
  while (e.argv[i] === "-c" || e.argv[i] === "--literal-pathspecs") i += e.argv[i] === "-c" ? 2 : 1;
  return e.cmd === "gh" ? e.argv.slice(0, 2).join(" ") : e.argv[i];
};
const row = (result, n) => result.prs.find((p) => p.number === n);

// [dashboard-code#1]
test("dashboard code: POST /api/code passes the page's guard, answers 404 for no story or spec, and GET gets 404", async () => {
  await withCode({}, async ({ w, start }) => {
    const page = await start();
    const token = await tokenOf(page);
    const from = w.record.length;
    for (const headers of [
      {},
      { "x-projectstore-token": token, origin: "null" },
      { "x-projectstore-token": token, origin: "http://evil.example" },
    ]) {
      const r = await call(page, CODE_ROUTE, { method: "POST", headers, body: JSON.stringify({ rel: STORY_REL }) });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.ok(r.json.write, "the answer carries write");
    }
    for (const rel of ["../outside.md", "epics/PS-X/epic.md", "/etc/passwd", 7]) {
      const r = await ask(page, { rel }, token);
      assert.equal(r.status, 404, String(rel));
    }
    assert.equal(
      (await call(page, CODE_ROUTE, { method: "POST", headers: own(page, token), body: "no json" })).status,
      400,
    );
    for (const method of ["GET", "HEAD"]) assert.equal((await call(page, CODE_ROUTE, { method })).status, 404, method);
    const options = await call(page, CODE_ROUTE, { method: "OPTIONS" });
    assert.equal(options.status, 405);
    assert.equal(options.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(reads(w, from), [], "no call ran");
    // The page cannot write (a plain-folder vault), and the story is read all the same.
    const r = await ask(page, { rel: STORY_REL }, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.write.can, false);
    assert.ok(r.json.result.commitCount > 0);
  });
});

// [dashboard-code#1]
test("dashboard code: on Windows the answer says so and no process runs", async () => {
  await withCode({}, async ({ w, start }) => {
    const page = await start({ platform: "win32" });
    const from = w.record.length;
    const r = await story(page);
    assert.match(r.unknown.git, /Windows/);
    assert.match(r.unknown.prs, /Windows/);
    assert.deepEqual(w.record.slice(from), []);
  });
});

// [dashboard-code#2]
test("dashboard code: the default branch as last fetched, how far the checkout is behind, and no fetch", async () => {
  await withCode({}, async ({ w, project, start }) => {
    // Three commits on the first-parent line back; with the merged branch's own, git counts six.
    gitIn(w.env, project, ["fetch", "-q", "origin"]);
    gitIn(w.env, project, ["switch", "-q", "--detach", "HEAD~3"]);
    const lacks = Number(gitIn(w.env, project, ["rev-list", "--count", "HEAD..refs/remotes/origin/main"]));
    assert.equal(lacks, 6);
    const page = await start();
    const from = w.record.length;
    const r = await story(page);
    assert.equal(r.main.ref, "refs/remotes/origin/main");
    assert.equal(r.main.short, "main");
    assert.equal(r.main.behind, lacks);
    assert.equal(r.main.shallow, false);
    assert.match(String(r.main.fetchedAt), /^\d{4}-\d{2}-\d{2}T/, "the time of FETCH_HEAD");
    assert.equal(r.repo, "acme/app");
    assert.equal(r.main.tip, undefined, "the full hash stays on the server");
    const subs = reads(w, from).map(sub);
    for (const s of subs) assert.ok(["log", "rev-list", "rev-parse", "show", "diff", "pr list"].includes(s), s);
    for (const e of reads(w, from).filter((x) => x.cmd === "git")) {
      assert.equal(e.env.GIT_NO_LAZY_FETCH, "1");
      assert.ok(e.argv.includes("core.quotePath=false"));
      assert.equal(e.cwd, project);
    }
  });
});

// [dashboard-code#2]
test("dashboard code: no origin gives HEAD, and a repository with no commit says so", async () => {
  await withCode({}, async ({ w, project, start }) => {
    gitIn(w.env, project, ["remote", "remove", "origin"]);
    const page = await start();
    const r = await story(page);
    assert.equal(r.main.ref, "HEAD");
    assert.equal(r.main.short, "HEAD");
    assert.equal(r.main.fetched, false);
    rmSync(join(project, ".git"), { recursive: true, force: true });
    gitIn(w.env, project, ["init", "-q"]);
    const empty = await story(page);
    assert.match(empty.unknown.git, /no commit/);
    assert.deepEqual(empty.commits, []);
  });
});

// [dashboard-code#2]
test("dashboard code: a partial clone fetches nothing, and every call of the read carries GIT_NO_LAZY_FETCH", async () => {
  await withCode({ partial: true }, async ({ w, project, start }) => {
    const missing = () =>
      gitIn(w.env, project, ["rev-list", "--objects", "--all", "--missing=print"])
        .split("\n")
        .filter((l) => l.startsWith("?")).length;
    const before = missing();
    assert.ok(before > 0, "the clone lacks blobs");
    const rec = gitRecorder(join(w.root, "rec"));
    const page = await start({ env: { ...rec.env(w.env), TZ: "UTC" } });
    const at = rec.log().length;
    const r = await story(page);
    assert.ok(r.commitCount > 0, "the story's commits are read from the trees");
    const calls = rec.log().slice(at);
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.notEqual(
        c.argv.find((a) => !a.startsWith("-") && !a.includes("=")),
        "fetch",
      );
      assert.equal(c.lazy, "1", c.argv.join(" "));
    }
    assert.equal(missing(), before, "no object was fetched");
  });
});

// [dashboard-code#3]
test("dashboard code: one gh pr list kept for ten minutes, asked again with fresh or after them", async () => {
  await withCode({}, async ({ w, start }) => {
    let t = Date.parse("2026-11-19T00:00:00Z");
    const page = await start({ now: () => t });
    const from = w.record.length;
    const lists = () => reads(w, from).filter((e) => sub(e) === "pr list");
    const maps = () => reads(w, from).filter((e) => sub(e) === "log" && e.argv.includes("--topo-order"));
    await story(page);
    t += 60 * 1000;
    await story(page);
    assert.equal(lists().length, 1);
    assert.equal(maps().length, 1);
    assert.deepEqual(lists()[0].argv, [
      "pr",
      "list",
      "--state=all",
      `--limit=${LIST_LIMIT}`,
      "--json=number,title,body,state,url,mergedAt,isCrossRepository,baseRefName,mergeCommit",
    ]);
    t += KEEP_MS;
    await story(page);
    assert.equal(lists().length, 2);
    assert.equal(maps().length, 2);
    await story(page, { fresh: true });
    assert.equal(lists().length, 3);
  });
});

// [dashboard-code#3]
test("dashboard code: gh missing, logged out, past its budget, or answering no list gives unknown, never none", async () => {
  await withCode({}, async ({ w, c, start, put }) => {
    put(STORY_REL, storyText({ pr: prUrl(1) }));
    // Missing: a PATH with git alone.
    const bin = join(w.root, "only-git");
    mkdirSync(bin);
    symlinkSync(realGit(), join(bin, "git"));
    const noGh = await start({ env: { ...w.env, PATH: bin, TZ: "UTC" } });
    let r = await story(noGh);
    assert.match(r.unknown.prs, /gh is not installed/);
    assert.deepEqual(
      r.prs.map((p) => [p.number, p.how, p.state]),
      [[1, ["recorded"], null]],
    );
    assert.ok(r.commitCount > 0, "the commits are still there");
    assert.equal(r.loose, null);
    // Logged out.
    w.gh.set({ auth: true });
    const out = await start();
    r = await story(out);
    assert.match(r.unknown.prs, /not logged in/);
    // No list.
    w.gh.set({ prs: pullsOf(c) });
    const odd = gitRecorder(join(w.root, "fake-gh"));
    writeFileSync(join(odd.dir, "gh"), `#!${process.execPath}\nprocess.stdout.write('{"not":"a list"}');\n`, {
      mode: 0o755,
    });
    const nolist = await start({ env: { ...w.env, PATH: [odd.dir, w.env.PATH].join(delimiter), TZ: "UTC" } });
    r = await story(nolist);
    assert.match(r.unknown.prs, /not a JSON list/);
    // Past its budget.
    w.gh.set({ prs: pullsOf(c), fail: { list: "hang" } });
    const hung = await start({ budgets: { gh: HANG_MS } });
    r = await story(hung);
    assert.match(r.unknown.prs, /budget/);
  });
});

// [dashboard-code#3]
test("dashboard code: a list of 1000 is marked full, and no description reaches the answer", async () => {
  await withCode({}, async ({ w, c, start, put }) => {
    const prs = pullsOf(c);
    prs[0].body = "Contact: someone@example.invalid\nThe code block is read for this story.";
    w.gh.set({ prs });
    put(STORY_REL, storyText());
    const page = await start();
    const r = await ask(page, { rel: STORY_REL });
    assert.ok(!r.text.includes("@"), "no address in the answer");
    assert.ok(!r.text.includes("Contact"), "no description text in the answer");
    assert.deepEqual(row(r.json.result, 1).how.slice(0, 1), ["named"]);
    w.gh.set({ full: true });
    const full = await story(await start());
    assert.equal(full.listFull, true);
  });
});

// [dashboard-code#4]
test("dashboard code: recorded and counted Closes-story are links; a title, a number, a fork's line are leads", async () => {
  await withCode({}, async ({ w, c, start, put }) => {
    const prs = pullsOf(c);
    prs.find((p) => p.number === 2).body = "This is The code block is read for this story, done.";
    prs.find((p) => p.number === 9).body = "Closes-story: PS-X/story-code";
    prs.find((p) => p.number === 10).body = "Closes-story: PS-X/story-code";
    prs.push(PR(11, { state: "OPEN", isCrossRepository: true, body: "Closes-story: PS-X/story-code" }));
    prs.push(PR(12, { state: "OPEN", baseRefName: "release", body: "Closes-story: PS-X/story-code" }));
    w.gh.set({ prs });
    put(
      STORY_REL,
      storyText({
        pr: prUrl(1),
        body: "See PR #3 and https://github.com/acme/app/pull/4. PR 2 of the plan, and see #5.",
      }),
    );
    const r = await story(await start());
    assert.deepEqual(r.prs[0].number, 1);
    assert.deepEqual(row(r, 1).how.slice(0, 1), ["recorded"]);
    assert.equal(row(r, 1).link, true);
    assert.deepEqual(row(r, 9).how, ["closes"]);
    assert.equal(row(r, 9).link, true);
    assert.deepEqual(row(r, 2).how.slice(0, 1), ["named"]);
    assert.equal(row(r, 2).link, false);
    assert.ok(row(r, 3).how.includes("mentioned"));
    assert.ok(row(r, 4).how.includes("mentioned"));
    assert.ok(!row(r, 5)?.how.includes("mentioned"), "a bare #5 is no mention");
    assert.deepEqual(row(r, 10).how, ["closes-uncounted"]);
    assert.match(row(r, 10).why["closes-uncounted"], /closed unmerged/);
    assert.match(row(r, 11).why["closes-uncounted"], /fork/);
    assert.match(row(r, 12).why["closes-uncounted"], /release/);
    // Links first.
    const firstLead = r.prs.findIndex((p) => !p.link);
    assert.ok(r.prs.slice(firstLead).every((p) => !p.link));
  });
});

// [dashboard-code#4]
test("dashboard code: a legacy Closes-story entry resolves as the move verb resolves it, a short title names nothing, and a recorded url of another repository stays first", async () => {
  await withCode({}, async ({ w, c, start, put }) => {
    const prs = pullsOf(c);
    prs.find((p) => p.number === 9).body = "Closes-story: PS-X/story-012";
    prs.find((p) => p.number === 8).body = "Fix it";
    w.gh.set({ prs });
    put(
      "epics/PS-X/stories/story-012-cache.md",
      storyText({ title: "Fix it", pr: "https://github.com/other/repo/pull/8" }).replace(
        'id: "story-code"',
        'id: "story-012-cache"',
      ),
    );
    const page = await start();
    const r = (await ask(page, { rel: "epics/PS-X/stories/story-012-cache.md" })).json.result;
    assert.deepEqual(row(r, 9).how, ["closes"]);
    assert.equal(r.prs[0].url, "https://github.com/other/repo/pull/8");
    assert.equal(r.prs[0].state, null);
    assert.equal(r.prs[0].repo, "other/repo");
    assert.match(r.prs[0].filesReason, /not among/);
    assert.ok(
      !r.prs.some((p) => p.number === 8 && p.how.includes("named")),
      "a title under 12 characters names nothing",
    );
  });
});

// [dashboard-code#5]
test("dashboard code: the story's commits in its window, by refCovers, capped and listed", async () => {
  await withCode({}, async ({ w, project, start, put }) => {
    // A bare start day reads the whole day in UTC.
    put(STORY_REL, storyText({ started: "2026-11-11", closed: "2026-11-11", refs: '["scripts/*"]' }));
    const page = await start();
    let r = await story(page);
    assert.deepEqual(
      r.commits.map((k) => k.subject),
      ["b (#2)"],
      "scripts/* covers scripts/sub/b.mjs, as refCovers reads it",
    );
    // No start.
    put(STORY_REL, storyText({ started: null }));
    r = await story(page);
    assert.deepEqual(r.commits, []);
    assert.match(r.windowReason, /no started_at/);
    // A path outside the repository is skipped and named.
    put(STORY_REL, storyText({ refs: '["../elsewhere", "scripts/"]' }));
    r = await story(page);
    assert.deepEqual(r.skipped, ["../elsewhere"]);
    // 301 commits: 300 counted, 80 listed.
    // One git fast-import, on top of the default branch.
    const tip = gitIn(w.env, project, ["rev-parse", "refs/remotes/origin/main"]);
    const base = Date.parse("2026-11-16T10:00:00Z") / 1000;
    let stream = "";
    for (let i = 0; i < 301; i++) {
      const text = `${i}\n`;
      const msg = `many ${i}\n`;
      stream += `commit refs/remotes/origin/main\ncommitter Dev <dev> ${base + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`;
      if (i === 0) stream += `from ${tip}\n`;
      stream += `M 100644 inline scripts/many.mjs\ndata ${Buffer.byteLength(text)}\n${text}\n`;
    }
    const fi = spawnSync("git", ["fast-import", "--quiet"], {
      cwd: project,
      env: w.env,
      input: stream,
      encoding: "utf8",
    });
    assert.equal(fi.status, 0, fi.stderr);
    put(STORY_REL, storyText({ started: "2026-11-16" }));
    r = await story(page);
    assert.equal(r.truncated, true);
    assert.equal(r.commitCount, 300);
    assert.equal(r.commits.length, 80);
  });
});

// [dashboard-code#6]
test("dashboard code: which pull request brought each commit in, for a merge, a rebase, a squash and a nested merge", async () => {
  await withCode({}, async ({ start, put }) => {
    put(STORY_REL, storyText({ refs: '["scripts/", "tests/", "docs/"]' }));
    const r = await story(await start());
    const prOf = Object.fromEntries(r.commits.map((k) => [k.subject, k.pr]));
    assert.equal(prOf.a1, 1);
    assert.equal(prOf.a2, 1);
    assert.equal(prOf.a3, 1);
    assert.equal(prOf.c1, 3, "a rebase's earlier commit, same second and committer");
    assert.equal(prOf.c2, 3);
    assert.equal(prOf.note, null, "an earlier loose commit stays loose");
    assert.equal(prOf.loose, 4, "the known error: same second, same committer, just before a squash");
    assert.equal(prOf["f (#5)"], 5, "the walk from #6 stops at #5's own commit");
    assert.equal(prOf["g (#6)"], 6);
    assert.equal(prOf.e2, 7, "a commit two pull requests bring in belongs to the earlier mergedAt");
    assert.equal(prOf.e1, 8);
    assert.equal(r.loose, 1);
  });
});

// [dashboard-code#6]
test("dashboard code: rangeOf is git's <first parent>..<merge>", async () => {
  await withCode({}, async ({ w, c, project }) => {
    const log = gitIn(w.env, project, ["log", "--topo-order", "--format=%H %P", "main"]).split("\n");
    const commits = log.map((l) => {
      const [hash, ...parents] = l.split(" ");
      return { hash, parents };
    });
    const graph = { commits, index: new Map(commits.map((x, i) => [x.hash, i])) };
    for (const m of [c.m1, c.m2]) {
      const want = gitIn(w.env, project, ["rev-list", `${m}^1..${m}`])
        .split("\n")
        .filter((h) => h !== m)
        .sort();
      assert.deepEqual(rangeOf(m, graph).sort(), want);
    }
  });
});

// [dashboard-code#7]
test("dashboard code: each row's share of the story's files, its reason when it has none, and the order", async () => {
  await withCode({}, async ({ w, c, start, put }) => {
    const prs = pullsOf(c);
    prs.find((p) => p.number === 9).body = "PR for The code block is read for this story";
    prs.push(
      PR(13, {
        mergeCommit: { oid: "0".repeat(40) },
        mergedAt: "2026-11-16T00:00:00Z",
        body: "The code block is read for this story",
      }),
    );
    w.gh.set({ prs });
    put(STORY_REL, storyText({ refs: '["scripts/a.mjs"]', body: "PR #9" }));
    const r = await story(await start());
    assert.equal(row(r, 1).files, 2);
    assert.equal(row(r, 1).inside, 1);
    assert.match(row(r, 9).filesReason, /not merged/);
    assert.match(row(r, 13).filesReason, /not on the default branch/);
    const derivedOnly = r.prs.filter((p) => p.how.every((x) => x === "derived"));
    assert.ok(derivedOnly.length >= 1);
    const lastWritten = r.prs.map((p) => p.how.every((x) => x === "derived")).lastIndexOf(false);
    assert.ok(
      r.prs.findIndex((p) => p.how.every((x) => x === "derived")) > lastWritten,
      "derived rows after every written tie",
    );
  });
});

// [dashboard-code#8]
test("dashboard code: a spec's contracts grouped by their last amendment, with what touched its files since", async () => {
  await withCode({}, async ({ w, start, put }) => {
    put(STORY_REL, storyText({ refs: '["scripts/c.mjs", "scripts/e.mjs"]' }));
    const spec = (status) =>
      [
        "---",
        "type: spec",
        'id: "the-code-spec"',
        'title: "The code spec"',
        "alias: code-spec",
        `status: ${status}`,
        "date: 2026-11-09",
        'stories: ["PS-X/story-code"]',
        "---",
        "",
        "# The code spec",
        "",
        "## How we solve",
        "",
        "Read it.",
        "",
        "## Behavioral contracts",
        "",
        "1. **One.** The first.",
        "",
        "2. **Two.** The second.",
        "   > amended 2026-11-14 by PS-X/story-code: MODIFIED — moved",
        "   > was: the old text",
        "",
        "## Acceptance",
        "",
        "- [ ] It reads.",
        "",
      ].join("\n");
    put("specs/the-code-spec.md", spec("active"));
    const rec = gitRecorder(join(w.root, "rec"));
    const page = await start({ env: { ...rec.env(w.env), TZ: "UTC" } });
    const from = w.record.length;
    const at = rec.log().length;
    const r = (await ask(page, { rel: "specs/the-code-spec.md" })).json.result;
    assert.deepEqual(
      r.anchors.map((a) => [a.anchor, a.contracts.map((x) => x.n)]),
      [
        ["2026-11-14", ["2"]],
        ["2026-11-09", ["1"]],
      ],
    );
    assert.equal(r.anchors[0].commits, 2, "e1 and e2 since 2026-11-14");
    assert.equal(r.anchors[1].commits, 4, "c1, c2, e1 and e2 since 2026-11-09");
    assert.equal(r.anchors[1].prCount, 3);
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["scripts/c.mjs", "scripts/e.mjs"],
    );
    assert.equal(r.stories.length, 1);
    // Every git call the recorder saw is one of the spawn record's: the core's seams started nothing.
    const recorded = reads(w, from)
      .filter((e) => e.cmd === "git")
      .map((e) => e.argv.join(" "));
    assert.deepEqual(
      rec
        .log()
        .slice(at)
        .map((x) => x.argv.join(" ")),
      recorded,
    );
    // A draft spec: no call.
    put("specs/the-code-spec.md", spec("draft"));
    const before = w.record.length;
    const d = (await ask(page, { rel: "specs/the-code-spec.md" })).json.result;
    assert.match(d.error, /only while it is active/);
    assert.deepEqual(w.record.slice(before), [], "the spawn record shows no call");
  });
});

// [dashboard-code#9]
test("dashboard code: the module refuses a call of the read off its list, or in another folder, and starts nothing", async () => {
  const w = await makeWorld({ plainVault: true });
  try {
    const writer = await openWriter({ ctx: w.ctx, env: w.env, record: w.record });
    const r = writer.reader;
    const from = w.record.length;
    for (const args of [
      ["fetch", "--", "origin"],
      ["cat-file", "-p", "HEAD"],
      ["log", "--output=/tmp/x"],
      ["push"],
      ["-c", "core.pager=x", "log"],
    ]) {
      const a = await r.git(w.project, args);
      assert.equal(a.refused, true, args.join(" "));
    }
    assert.equal((await r.gh(w.project, ["api", "graphql"])).refused, true);
    assert.equal((await r.gh(w.project, ["pr", "merge", "1"])).refused, true);
    assert.equal((await r.gh(w.project, ["pr", "list", "--web"])).refused, true);
    assert.equal((await r.gh(w.project, ["pr", "list", "-R", "other/repo"])).refused, true);
    assert.equal((await r.git(w.root, ["log", "-1"])).refused, true, "another folder");
    assert.deepEqual(w.record.slice(from), []);
    // The refusal itself: a call marked as the read's is held to its list; others keep their rules.
    assert.equal(refusal("git", ["log"]), null);
    const win = await openWriter({ ctx: w.ctx, env: w.env, record: w.record, platform: "win32" });
    assert.match((await win.reader.git(w.project, ["log", "-1"])).reason, /Windows/);
    await writer.stop();
    await win.stop();
  } finally {
    await w.cleanup();
  }
});

// [dashboard-code#9]
test("dashboard code: the read's argv: options first, a revision after --end-of-options, pathspecs after --", async () => {
  // This case's own read, then every read the cases above left in ALL.
  await withCode({}, async ({ start, put }) => {
    put(STORY_REL, storyText({ pr: prUrl(1) }));
    await story(await start());
  });
  const logs = ALL.filter((e) => e.via === "readCode" && e.cmd === "git" && sub(e) === "log");
  assert.ok(logs.length >= 4, "the read ran");
  for (const e of logs) {
    const end = e.argv.indexOf("--end-of-options");
    assert.ok(end > 0, e.argv.join(" "));
    const dash = e.argv.indexOf("--");
    if (dash !== -1) assert.ok(dash > end);
    assert.ok(e.argv.includes("--no-show-signature"));
    if (!e.argv.includes("--topo-order") && !e.argv.includes("-1"))
      assert.ok(e.argv.includes("--no-renames"), e.argv.join(" "));
  }
});

// [dashboard-code#9]
test("dashboard code: the repeated core rules equal the core's own", () => {
  for (const d of ["2026-11-14", "2026-11-14T10:00:00Z", "last week"]) assert.equal(sinceWindow(d), coreSinceWindow(d));
  const vault = join(process.env.HOME, "rs-vault");
  const put = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  put("epics/PS-Y/stories/story-012-cache.md", '---\nid: "story-012-cache"\n---\n');
  put("epics/PS-Y/stories/story-a.md", '---\nid: "story-a"\n---\n');
  put("epics/PS-Y/stories/story-twin.md", '---\nid: "story-x"\n---\n');
  put("epics/PS-Y/stories/story-x.md", '---\nid: "story-other"\n---\n');
  for (const arg of ["PS-Y/story-012", "PS-Y/story-a", "PS-Y/story-x", "PS-Y/none", "bad"]) {
    const ours = resolveStory(arg, { vault, epicsPath: "epics" }, lib);
    const core = coreResolveStory(arg, { vault, epicsPath: "epics" });
    assert.deepEqual(ours, core, arg);
  }
  rmSync(vault, { recursive: true, force: true });
});

// [dashboard-code#10]
test("dashboard code: code_refs as a block list or a list with no quotes is read and named", async () => {
  await withCode({}, async ({ start, put }) => {
    const page = await start();
    put(STORY_REL, storyText({ refs: "\n  - scripts/a.mjs\n  - tests/a.test.mjs" }));
    let r = await story(page);
    assert.deepEqual(r.refs, ["scripts/a.mjs", "tests/a.test.mjs"]);
    assert.equal(r.refsForm, "block");
    put(STORY_REL, storyText({ refs: "[scripts/a.mjs, tests/a.test.mjs]" }));
    r = await story(page);
    assert.deepEqual(r.refs, ["scripts/a.mjs", "tests/a.test.mjs"]);
    assert.equal(r.refsForm, "bare");
  });
});

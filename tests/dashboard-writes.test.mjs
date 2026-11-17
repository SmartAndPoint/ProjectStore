// projectstore — tests/dashboard-writes.test.mjs: the dashboard's write path
// (PS-DASHBOARD, "The page writes by running core verbs, with a preview, and
// the click is the approval"; the spec "The dashboard's write path: a clone of
// its own, an action as core verbs, a batch sent as one pull request, and a
// server that runs processes only for its own page", alias `dashboard-writes`).
//
// This file holds the module's foundation: writable or read-only (contract
// 1), the place and the clone made whole (contract 2), the clone's
// configuration (contract 3), the refresh as the module runs it (contract 4),
// the step lock and its recovery (contract 5) and the processes (contract 9). Each case
// builds its own world (tests/fixtures/dashboard-world.mjs): a bare `origin`,
// a vault repository cloned from it, a project bound to that vault, with HOME,
// XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL inside the world's folder. The
// module's spawn record is read for "no call" and for every argv rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { hermeticGit, makeWorld, SSH_STUB, REPO } from "./fixtures/dashboard-world.mjs";
import { ghStub } from "./fixtures/gh-stub.mjs";
import {
  BUDGETS,
  LOCK_FILE,
  SSH_BATCH,
  StepError,
  VERB_ARGV,
  WRITE_VERBS,
  absoluteRemote,
  anchorOf,
  checkRequest,
  isBatchBranch,
  placePaths,
  redactUrls,
  refusal,
  stampFor,
  substitutePaths,
} from "../dashboard/lib/write.mjs";
import { VERBS } from "../scripts/verbs.mjs";
import { loadHarnesses } from "../scripts/harness.mjs";
import { derivedViewPaths, loadLayout, stateDir } from "../scripts/lib.mjs";
import { mainCheckoutOfProject } from "../scripts/worktree.mjs";
import { openCore } from "../dashboard/lib/core.mjs";
import { readState } from "../dashboard/lib/state.mjs";
import { START_BUDGET_MS, WRITE_ROUTES } from "../dashboard/server.mjs";

hermeticGit();

const MODULE = join(REPO, "dashboard", "lib", "write.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every record of the file, for the argv rules read at its end.
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

// git that may fail, in a world's environment.
const tryGit = (w, cwd, ...args) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", ...w.as, ...args], { cwd, env: w.env, encoding: "utf8" });

const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
};
const pgidOf = (pid) => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());

async function waitFor(check, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = check();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("timed out waiting");
}

// Point the vault repository's origin at the stub ssh command.
function sshOrigin(w, mode) {
  const report = join(w.root, `ssh-${mode}.json`);
  w.git(w.repo, "remote", "set-url", "origin", `ssh://stub.invalid${w.origin}`);
  const q = (s) => `'${s}'`;
  w.git(w.repo, "config", "core.sshCommand", [process.execPath, SSH_STUB, report, mode].map(q).join(" "));
  return report;
}

const subOf = (argv) => {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += argv[i] === "-c" || argv[i] === "-C" ? 2 : 1;
  return { name: argv[i], rest: argv.slice(i + 1) };
};

// ─── Contract 2: the place ──────────────────────────────────────────────

// [dashboard-writes#2]
test("dashboard writes: for a linked worktree the place is under the main checkout's .projectstore/state/dashboard/", async () => {
  await withWorld({ worktree: true }, async (w) => {
    const writer = await w.open();
    assert.equal(writer.anchor, w.main);
    assert.equal(writer.place, join(w.main, ".projectstore", "state", "dashboard", "test-person"));
    const r = await writer.step("probe", () => ({ result: "ran" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.result, "ran");
    assert.ok(existsSync(writer.place), "the step made the place");
    assert.ok(!existsSync(join(w.project, ".projectstore", "state", "dashboard")), "nothing under the worktree");
  });
});

// [dashboard-writes#2]
test("dashboard writes: an empty default_author puts the place at .projectstore/state/dashboard/untitled/", async () => {
  await withWorld({ author: "" }, async (w) => {
    const writer = await w.open();
    assert.equal(writer.person, "untitled");
    assert.equal(writer.place, join(w.main, ".projectstore", "state", "dashboard", "untitled"));
  });
});

// [dashboard-writes#2]
test("dashboard writes: opening the module makes no file; a step makes the gitignore line first, then <anchor>/.projectstore/state/dashboard/<person>/, which holds the lock while it runs and nothing else", async () => {
  await withWorld({}, async (w) => {
    const gitignore = join(w.main, ".projectstore", ".gitignore");
    const state = join(w.main, ".projectstore", "state");
    const writer = await w.open();
    assert.ok(!existsSync(gitignore), "no .gitignore before a step");
    assert.ok(!existsSync(state), "no place before a step");
    const r = await writer.step("probe", ({ place, paths }) => ({
      result: {
        place,
        gitignore: readFileSync(gitignore, "utf8"),
        dashboards: readdirSync(join(state, "dashboard")),
        inside: readdirSync(place),
        lock: paths.lock,
      },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.result, {
      place: join(w.main, ".projectstore", "state", "dashboard", "test-person"),
      gitignore: "state/\n",
      dashboards: ["test-person"],
      inside: [LOCK_FILE],
      lock: join(writer.place, "projectstore-dashboard.lock"),
    });
    assert.deepEqual(readdirSync(writer.place), [], "the lock is gone after the step");
    // The names a refresh and an action will use, beside the lock.
    assert.deepEqual(placePaths(writer.place), {
      place: writer.place,
      clone: join(writer.place, "clone"),
      cloneTmp: join(writer.place, "clone.tmp"),
      binding: join(writer.place, "project"),
      lock: join(writer.place, LOCK_FILE),
    });
  });
});

// [dashboard-writes#2]
test("dashboard writes: a .projectstore/.gitignore that lacks state/ gets the line, and git status lists nothing under .projectstore/state/", async () => {
  await withWorld({}, async (w) => {
    const gitignore = join(w.main, ".projectstore", ".gitignore");
    writeFileSync(gitignore, "projectstore.json\n");
    const writer = await w.open();
    const r = await writer.step("probe", ({ paths }) => {
      // What a refresh will leave there: a clone with files in it.
      mkdirSync(paths.clone, { recursive: true });
      writeFileSync(join(paths.clone, "kanban.md"), "x\n");
      return { result: null };
    });
    assert.equal(r.status, 200);
    assert.deepEqual(readFileSync(gitignore, "utf8").split("\n").filter(Boolean), ["projectstore.json", "state/"]);
    const status = w.git(w.main, "status", "--porcelain", "--untracked-files=all");
    assert.ok(existsSync(join(writer.paths.clone, "kanban.md")));
    assert.deepEqual(
      status.split("\n").filter((l) => l.includes(".projectstore/state/")),
      [],
      `git status lists nothing under .projectstore/state/:\n${status}`,
    );
  });
});

// [dashboard-writes#2]
test("dashboard writes: the module's anchor is the core's: a main checkout, a folder in it, a linked worktree, a plain folder, a separate git dir and one kept inside another repository", async () => {
  await withWorld({ worktree: true }, async (w) => {
    const sub = join(w.main, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const plain = join(w.root, "plain");
    mkdirSync(plain);
    // A checkout whose git dir is kept apart, and a worktree of it.
    const sepDir = join(w.root, "sep");
    w.git(w.root, "init", "-q", `--separate-git-dir=${join(w.root, "sep.git")}`, sepDir);
    writeFileSync(join(sepDir, "f"), "f\n");
    w.git(sepDir, "add", "-A");
    w.git(sepDir, ...w.as, "commit", "-q", "-m", "sep");
    const sepWt = join(w.root, "sep-wt");
    w.git(sepDir, "worktree", "add", "-q", "-b", "sep-wt", sepWt);
    // …and one whose git dir sits inside an unrelated repository, so the
    // candidate main checkout is that stranger.
    const other = join(w.root, "other");
    mkdirSync(other);
    w.git(other, "init", "-q");
    const inside = join(w.root, "inside");
    w.git(w.root, "init", "-q", `--separate-git-dir=${join(other, "inside.git")}`, inside);
    writeFileSync(join(inside, "f"), "f\n");
    w.git(inside, "add", "-A");
    w.git(inside, ...w.as, "commit", "-q", "-m", "inside");
    const insideWt = join(w.root, "inside-wt");
    w.git(inside, "worktree", "add", "-q", "-b", "inside-wt", insideWt);
    const cases = [
      [w.main, w.main],
      [sub, w.main],
      [w.project, w.main],
      [plain, plain],
      [sepDir, sepDir],
      [sepWt, sepWt],
      [inside, inside],
      [insideWt, insideWt],
    ];
    for (const [dir, want] of cases) {
      const mine = await anchorOf(dir, { env: w.env, record: w.record });
      const core = mainCheckoutOfProject(dir);
      assert.equal(mine, want, `the module's anchor of ${dir}`);
      assert.equal(core, want, `the core's anchor of ${dir}`);
    }
  });
});

// ─── Contract 5: one step at a time ─────────────────────────────────────

// [dashboard-writes#5]
test("dashboard writes: two steps of one server that arrive together both run, one after the other", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const events = [];
    const body = (name) => async () => {
      events.push(`${name}+`);
      assert.ok(existsSync(writer.paths.lock), "the lock is held for the whole step");
      await sleep(150);
      events.push(`${name}-`);
      return { result: name };
    };
    const [a, b] = await Promise.all([writer.step("a", body("a")), writer.step("b", body("b"))]);
    assert.deepEqual(events, ["a+", "a-", "b+", "b-"]);
    assert.deepEqual([a.status, b.status, a.body.result, b.body.result], [200, 200, "a", "b"]);
    assert.ok(!existsSync(writer.paths.lock), "no lock is left");
  });
});

// [dashboard-writes#5]
test("dashboard writes: a lock that names a dead pid on this host, or this server's pid with another start time, is broken and the step runs", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    writer.ensurePlace();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.ok(!pidAlive(dead), "the pid is dead");
    for (const holder of [
      { host: hostname(), pid: dead, started: 1 },
      { host: hostname(), pid: process.pid, started: writer.started - 1000 },
    ]) {
      writeFileSync(writer.paths.lock, JSON.stringify(holder));
      let ran = false;
      const r = await writer.step("probe", () => {
        ran = true;
        return { result: JSON.parse(readFileSync(writer.paths.lock, "utf8")) };
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(ran);
      assert.deepEqual(r.body.result, { host: hostname(), pid: process.pid, started: writer.started });
      assert.ok(!existsSync(writer.paths.lock));
    }
  });
});

// [dashboard-writes#5]
test("dashboard writes: a lock held by a live process that is not this server gets 409 naming the file and its holder, and no call starts", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    writer.ensurePlace();
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    try {
      for (const holder of [
        { host: hostname(), pid: other.pid, started: 5 },
        // Another host's process cannot be asked, so it is not broken either.
        { host: "another-host.invalid", pid: spawnSync(process.execPath, ["-e", ""]).pid, started: 5 },
      ]) {
        const text = JSON.stringify(holder);
        writeFileSync(writer.paths.lock, text);
        const before = w.record.length;
        let ran = false;
        const r = await writer.step("probe", () => {
          ran = true;
        });
        assert.equal(r.status, 409);
        assert.equal(r.body.ok, false);
        assert.ok(r.body.error.includes(writer.paths.lock), r.body.error);
        assert.ok(r.body.error.includes(`pid ${holder.pid} on ${holder.host}`), r.body.error);
        assert.equal(ran, false, "the step ran nothing");
        assert.equal(w.record.length, before, "the spawn record shows no call");
        assert.equal(readFileSync(writer.paths.lock, "utf8"), text, "the holder's lock stays");
      }
    } finally {
      other.kill("SIGKILL");
    }
  });
});

// [dashboard-writes#5]
test("dashboard writes: a stale lock that a live process took over between the read and the break is put back, and the step gets 409", async () => {
  await withWorld({}, async (w) => {
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    try {
      const live = JSON.stringify({ host: hostname(), pid: other.pid, started: 7 });
      // The other process broke the same dead holder first and made its own lock.
      const writer = await w.open({ beforeBreak: () => writeFileSync(writer.paths.lock, live) });
      writer.ensurePlace();
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      writeFileSync(writer.paths.lock, JSON.stringify({ host: hostname(), pid: dead, started: 1 }));
      let ran = false;
      const r = await writer.step("probe", () => {
        ran = true;
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.ok(r.body.error.includes(`pid ${other.pid} on ${hostname()}`), r.body.error);
      assert.equal(ran, false);
      assert.equal(readFileSync(writer.paths.lock, "utf8"), live, "the live holder's lock is back");
      assert.deepEqual(readdirSync(writer.place), [LOCK_FILE], "nothing moved aside is left");
    } finally {
      other.kill("SIGKILL");
    }
  });
});

// [dashboard-writes#5] [dashboard-writes#9]
test("dashboard writes: a clone/.git that is no repository answers 502 and never reaches the code repository the place sits in", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    writeFileSync(join(w.main, "README.md"), "uncommitted work\n");
    mkdirSync(join(writer.paths.clone, ".git"), { recursive: true });
    writeFileSync(join(writer.paths.clone, "kept.md"), "x\n");
    let ran = false;
    const r = await writer.step("probe", () => {
      ran = true;
    });
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.match(r.body.error, /is not a repository of its own/);
    assert.ok(r.body.error.includes(writer.paths.clone), r.body.error);
    assert.equal(ran, false);
    assert.equal(readFileSync(join(w.main, "README.md"), "utf8"), "uncommitted work\n", "the code keeps its change");
    assert.ok(existsSync(join(writer.paths.clone, "kept.md")));
    assert.ok(!existsSync(writer.paths.lock), "no lock is left");
    const inside = w.record.filter((e) => e.cwd.startsWith(writer.place));
    assert.ok(inside.length >= 1);
    for (const e of inside) assert.equal(e.env.GIT_CEILING_DIRECTORIES, realpathSync(writer.place), e.argv.join(" "));
    for (const e of w.record.filter((x) => !x.cwd.startsWith(writer.place)))
      assert.equal(e.env.GIT_CEILING_DIRECTORIES, undefined, `${e.cwd}: ${e.argv.join(" ")}`);
    assert.ok(!inside.some((e) => ["reset", "clean"].includes(subOf(e.argv).name)), "no reset or clean ran");
  });
});

// [dashboard-writes#9]
test("dashboard writes: a working folder that is not there is named as such, not as a missing git or gh", async () => {
  await withWorld({}, async (w) => {
    const stub = ghStub(join(w.root, "gh"), { prs: [] });
    const writer = await w.open({ env: stub.env(w.env) });
    const gone = join(w.root, "gone");
    const g = await writer.git(gone, ["status"]);
    assert.equal(g.ok, false);
    assert.equal(g.reason, `git status could not start: the folder ${gone} is not there`);
    const h = await writer.gh(gone, ["pr", "list", "--json=url"]);
    assert.deepEqual([h.ok, h.unavailable], [false, false]);
    assert.match(h.reason, /the folder .* is not there/);
  });
});

// [dashboard-writes#5]
test("dashboard writes: a step that fails leaves no lock file", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const a = await writer.step("probe", () => {
      throw new StepError(502, "git fetch: no route");
    });
    assert.deepEqual([a.status, a.body.ok, a.body.error], [502, false, "git fetch: no route"]);
    assert.ok(!existsSync(writer.paths.lock));
    const b = await writer.step("probe", () => {
      throw new Error("boom");
    });
    assert.equal(b.status, 500);
    assert.match(b.body.error, /boom/);
    assert.ok(!existsSync(writer.paths.lock));
    assert.ok("write" in a.body && "write" in b.body, "every answer carries write");
  });
});

// [dashboard-writes#5]
test("dashboard writes: an uncommitted file, a changed file and an index.lock in the clone are gone before a step, which reads the branch head", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const clone = w.cloneInto(writer.paths.clone);
    const head = w.git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "kanban.md"), "changed by hand\n");
    writeFileSync(join(clone, "stray.md"), "not committed\n");
    mkdirSync(join(clone, "notes"));
    writeFileSync(join(clone, "notes", "deep.md"), "not committed\n");
    writeFileSync(join(clone, ".git", "index.lock"), "");
    const r = await writer.step("probe", () => ({
      result: {
        board: readFileSync(join(clone, "kanban.md"), "utf8"),
        stray: existsSync(join(clone, "stray.md")) || existsSync(join(clone, "notes")),
        lock: existsSync(join(clone, ".git", "index.lock")),
      },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.result, { board: "stub board\n", stray: false, lock: false });
    assert.equal(w.git(clone, "rev-parse", "HEAD"), head);
  });
});

// [dashboard-writes#5]
test("dashboard writes: an unfinished merge or cherry-pick in the clone is aborted before a step", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const clone = w.cloneInto(writer.paths.clone);
    w.git(clone, "switch", "-q", "-c", "side");
    writeFileSync(join(clone, "kanban.md"), "side\n");
    w.git(clone, ...w.as, "commit", "-q", "-am", "side");
    w.git(clone, "switch", "-q", "main");
    writeFileSync(join(clone, "kanban.md"), "main\n");
    w.git(clone, ...w.as, "commit", "-q", "-am", "main");
    const head = w.git(clone, "rev-parse", "HEAD");
    for (const [args, marker] of [
      [["merge", "side"], "MERGE_HEAD"],
      [["cherry-pick", "side"], "CHERRY_PICK_HEAD"],
    ]) {
      assert.notEqual(tryGit(w, clone, ...args).status, 0, `${args[0]} conflicts`);
      assert.ok(existsSync(join(clone, ".git", marker)));
      const r = await writer.step("probe", () => ({
        result: { marker: existsSync(join(clone, ".git", marker)), status: w.git(clone, "status", "--porcelain") },
      }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.result, { marker: false, status: "" });
      assert.equal(w.git(clone, "rev-parse", "HEAD"), head);
      assert.equal(readFileSync(join(clone, "kanban.md"), "utf8"), "main\n");
    }
  });
});

// ─── Contract 1: writable or read-only ──────────────────────────────────

const WRITE_KEYS = ["can", "reason", "verbs", "default_branch", "fetched_at", "batch"];
const gitCalls = (w, from, sub) =>
  w.record.slice(from).filter((e) => e.cmd === "git" && (!sub || subOf(e.argv).name === sub));
const NETWORK = ["clone", "fetch", "ls-remote"];
const noPlace = (w) => {
  assert.ok(!existsSync(join(w.main, ".projectstore", "state")), "no place is made");
  assert.ok(!existsSync(join(w.main, ".projectstore", ".gitignore")), "no .gitignore line is written");
};
// A commit on origin's main, made in the vault repository: a second story.
function landUpstream(w, id = "story-b") {
  const a = readFileSync(join(w.vault, "epics", "PS-X", "stories", "story-a.md"), "utf8");
  writeFileSync(join(w.vault, "epics", "PS-X", "stories", `${id}.md`), a.replaceAll("story-a", id));
  w.git(w.repo, "add", "-A");
  w.git(w.repo, ...w.as, "commit", "-q", "-m", `add ${id}`);
  w.git(w.repo, "push", "-q", "origin", "main");
  return w.git(w.origin, "rev-parse", "refs/heads/main");
}

// [dashboard-writes#1]
test("dashboard writes: a vault that is a plain folder is read-only, the reason says it is in no git repository, and no file is made", async () => {
  await withWorld({ plainVault: true }, async (w) => {
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.write), WRITE_KEYS);
    assert.equal(r.body.write.can, false);
    assert.match(r.body.write.reason, /is not in a git repository/);
    assert.deepEqual(r.body.write.verbs, []);
    assert.equal(r.body.write.batch, null);
    noPlace(w);
    assert.equal(writer.readCtx(), w.ctx, "the page reads the bound checkout");
  });
});

// [dashboard-writes#1]
test("dashboard writes: a vault repository with no remote origin is read-only, and no file is made", async () => {
  await withWorld({}, async (w) => {
    w.git(w.repo, "remote", "remove", "origin");
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.body.write.can, false);
    assert.match(r.body.write.reason, /has no remote origin/);
    noPlace(w);
  });
});

// [dashboard-writes#1]
test("dashboard writes: a vault repository with no user.email of its own, where user.useConfigOnly makes git refuse, is read-only and the reason names the identity; a guessed identity does not count either", async () => {
  for (const useConfigOnly of [true, false]) {
    await withWorld({ identity: false }, async (w) => {
      if (useConfigOnly) w.git(w.repo, "config", "user.useConfigOnly", "true");
      const writer = await w.open();
      const r = await writer.refresh();
      assert.equal(r.status, 200);
      assert.equal(r.body.write.can, false);
      assert.match(r.body.write.reason, /identity/);
      assert.match(r.body.write.reason, /GIT_AUTHOR_IDENT/);
      assert.match(r.body.write.reason, /no email was given and auto-detection is disabled/);
      noPlace(w);
      const call = w.record.find((e) => subOf(e.argv).name === "var");
      assert.deepEqual(call.argv, ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
    });
  }
});

// [dashboard-writes#1]
test("dashboard writes: a clone whose origin differs from the vault repository's is read-only, and the reason names both URLs, the clone's path and every branch in it that holds unsent commits", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const first = await writer.refresh();
    assert.equal(first.body.write.can, true, first.body.write.reason);
    const clone = writer.paths.clone;
    const branch = "dashboard/test-person/20261117T000000Z";
    w.git(clone, "switch", "-q", "-c", branch);
    writeFileSync(join(clone, "kanban.md"), "unsent\n");
    w.git(clone, ...w.as, "commit", "-q", "-am", "unsent");
    const other = join(w.root, "other.git");
    w.git(w.root, "init", "-q", "--bare", other);
    w.git(w.repo, "remote", "set-url", "origin", other);
    const from = w.record.length;
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { can, reason } = r.body.write;
    assert.equal(can, false);
    for (const s of [w.origin, other, clone, `${branch} (1)`]) assert.ok(reason.includes(s), `${s} in: ${reason}`);
    assert.ok(!reason.includes("main ("), "the clone's main holds no unsent commit");
    for (const sub of ["fetch", "switch", "ls-remote"]) assert.equal(gitCalls(w, from, sub).length, 0, `no ${sub}`);
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), branch, "the clone is left as it is");
    assert.equal(writer.readCtx(), w.ctx);
  });
});

// [dashboard-writes#1]
test("dashboard writes: a vault folder that its repository ignores is read-only, the reason says the default branch does not hold it, and the page reads the bound checkout", async () => {
  await withWorld({ prefix: "docs/vault", ignoredVault: true }, async (w) => {
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.can, false);
    assert.match(r.body.write.reason, /the default branch main does not hold the vault's folder docs\/vault/);
    assert.ok(existsSync(join(writer.paths.clone, ".git")), "the clone was made");
    assert.equal(writer.readCtx(), w.ctx);
  });
});

// [dashboard-writes#1]
test("dashboard writes: with no network and no clone the reason is git's message from the clone that failed, and when the network comes back the next refresh makes the clone and write.can turns true", async () => {
  await withWorld({}, async (w) => {
    const away = `${w.origin}.away`;
    renameSync(w.origin, away);
    const writer = await w.open();
    const a = await writer.refresh({ start: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.write.can, false);
    assert.match(a.body.write.reason, /the page's own clone of .* could not be made: fatal: /);
    assert.ok(!existsSync(writer.paths.clone) && !existsSync(writer.paths.cloneTmp));
    assert.equal(writer.readCtx(), w.ctx);
    renameSync(away, w.origin);
    const b = await writer.refresh();
    assert.equal(b.body.write.can, true, b.body.write.reason);
    assert.equal(b.body.write.reason, null);
    assert.equal(writer.readCtx().vault, writer.paths.clone);
  });
});

// [dashboard-writes#1]
test("dashboard writes: on Windows write.can is false, the reason says writing is not supported there, no place is made and no git process runs", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open({ platform: "win32" });
    const r = await writer.refresh({ start: true });
    assert.equal(r.body.write.can, false);
    assert.match(r.body.write.reason, /not supported on Windows/);
    const s = await writer.step("probe", () => ({ result: "ran" }));
    assert.equal(s.status, 409);
    assert.match(s.body.error, /not supported on Windows/);
    assert.deepEqual(w.record, [], "no process at all, opening included");
    noPlace(w);
    assert.equal(writer.readCtx(), w.ctx);
  });
});

// [dashboard-writes#1] [dashboard-writes#4] [dashboard-writes#5]
test("dashboard writes: a refresh asked for while another live process holds the lock gets 409 and starts no call; the start's refresh then computes write from the clone as it is", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const clone = writer.paths.clone;
    const head = w.git(clone, "rev-parse", "HEAD");
    landUpstream(w);
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    try {
      const text = JSON.stringify({ host: hostname(), pid: other.pid, started: 5 });
      writeFileSync(writer.paths.lock, text);
      const from = w.record.length;
      const asked = await writer.refresh();
      assert.equal(asked.status, 409);
      assert.ok(asked.body.error.includes(writer.paths.lock), asked.body.error);
      assert.ok(asked.body.error.includes(`pid ${other.pid}`), asked.body.error);
      assert.equal(w.record.length, from, "the spawn record shows no call");
      // Without the lock the binding folder is written only when it is absent.
      const bindingFile = join(writer.paths.binding, ".projectstore", "projectstore.json");
      const bindingText = readFileSync(bindingFile, "utf8").replace("}", ', "kept": true}');
      writeFileSync(bindingFile, bindingText);
      const atStart = await writer.refresh({ start: true });
      assert.equal(readFileSync(bindingFile, "utf8"), bindingText, "the binding folder is left as it is");
      assert.equal(atStart.status, 409);
      assert.equal(atStart.body.write.can, true, atStart.body.write.reason);
      assert.equal(atStart.body.write.default_branch, "main");
      assert.equal(atStart.body.write.batch, null);
      for (const sub of [...NETWORK, "switch", "reset", "clean"])
        assert.equal(gitCalls(w, from, sub).length, 0, `no ${sub} under another's lock`);
      assert.ok(!gitCalls(w, from, "config").some((e) => e.argv.includes("--add") || e.argv.includes("--unset-all")));
      assert.equal(w.git(clone, "rev-parse", "HEAD"), head, "the clone is read as it is");
      assert.equal(readFileSync(writer.paths.lock, "utf8"), text, "the holder's lock stays");
      assert.equal(writer.readCtx().vault, clone);
    } finally {
      other.kill("SIGKILL");
    }
  });
});

// [dashboard-writes#1]
test("dashboard writes: a vault repository whose author identity is there but whose committer identity is not (and the other way round) is read-only, and the reason names the one missing", async () => {
  for (const [given, missing, variable] of [
    ["author", "committer", "GIT_COMMITTER_IDENT"],
    ["committer", "author", "GIT_AUTHOR_IDENT"],
  ]) {
    await withWorld({ identity: false }, async (w) => {
      w.git(w.repo, "config", "user.useConfigOnly", "true");
      w.git(w.repo, "config", `${given}.name`, "Half Person");
      w.git(w.repo, "config", `${given}.email`, "half-person");
      const writer = await w.open();
      const r = await writer.refresh();
      assert.equal(r.body.write.can, false);
      assert.match(r.body.write.reason, new RegExp(`no ${missing} identity`));
      assert.ok(r.body.write.reason.includes(variable), r.body.write.reason);
      noPlace(w);
    });
  }
});

// [dashboard-writes#1]
test("dashboard writes: no URL in write.reason keeps its userinfo, whether origin carries it or an insteadOf rule adds it", async () => {
  assert.equal(
    redactUrls("from https://tok:s3cret@host.invalid/v.git and ssh://git@host.invalid/v, not git@host.invalid:v"),
    "from https://host.invalid/v.git and ssh://host.invalid/v, not git@host.invalid:v",
  );
  for (const setUrl of [
    (w) => w.git(w.repo, "remote", "set-url", "origin", "https://tok:s3cret@host.invalid/vault.git"),
    (w) => {
      w.git(w.repo, "config", "url.https://x-access-token:s3cret@host.invalid/.insteadOf", "gh:");
      w.git(w.repo, "remote", "set-url", "origin", "gh:vault.git");
    },
  ]) {
    await withWorld({}, async (w) => {
      const writer = await w.open();
      assert.equal((await writer.refresh()).body.write.can, true);
      setUrl(w);
      const r = await writer.refresh();
      assert.equal(r.body.write.can, false);
      assert.ok(r.body.write.reason.includes("https://host.invalid/vault.git"), r.body.write.reason);
      assert.ok(!r.body.write.reason.includes("s3cret"), r.body.write.reason);
      assert.ok(!JSON.stringify(writer.view()).includes("s3cret"));
    });
  }
});

// [dashboard-writes#1] [dashboard-writes#2]
test("dashboard writes: the clone is made from remote.origin.url as configured, a relative path made absolute against the vault repository's top, and compared with get-url", async () => {
  assert.equal(absoluteRemote("../o.git", "/r/v"), "/r/o.git");
  for (const u of ["/abs/o.git", "https://h/o.git", "git@h:o.git", "gh:o.git", "file:///o.git"])
    assert.equal(absoluteRemote(u, "/r/v"), u);
  // A relative origin.
  await withWorld({}, async (w) => {
    w.git(w.repo, "remote", "set-url", "origin", "../origin.git");
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.body.write.can, true, r.body.write.reason);
    const call = w.record.find((e) => subOf(e.argv).name === "clone");
    assert.equal(call.argv.at(-2), w.origin);
    assert.equal(w.git(writer.paths.clone, "config", "--get", "remote.origin.url"), w.origin);
    assert.equal((await writer.refresh()).body.write.can, true, "the next refresh compares them equal too");
  });
  // An origin that an insteadOf rule rewrites: the clone keeps the rule's input.
  await withWorld({}, async (w) => {
    w.git(w.repo, "config", `url.${w.root}/.insteadOf`, "here:");
    w.git(w.repo, "remote", "set-url", "origin", "here:origin.git");
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.body.write.can, true, r.body.write.reason);
    assert.equal(w.git(writer.paths.clone, "config", "--get", "remote.origin.url"), "here:origin.git");
    assert.equal(w.git(writer.paths.clone, "remote", "get-url", "origin"), w.origin);
  });
});

// [dashboard-writes#1]
test("dashboard writes: when the clone's branches cannot be checked for unsent commits, the reason says so with git's message instead of saying none holds one", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    writeFileSync(
      join(writer.paths.clone, ".git", "refs", "heads", "ghost"),
      "1234567890abcdef1234567890abcdef12345678\n",
    );
    const other = join(w.root, "other.git");
    w.git(w.root, "init", "-q", "--bare", other);
    w.git(w.repo, "remote", "set-url", "origin", other);
    const r = await writer.refresh();
    assert.equal(r.body.write.can, false);
    assert.match(r.body.write.reason, /could not be checked for commits not sent \(.+\)/);
    assert.ok(!r.body.write.reason.includes("No branch in it holds"), r.body.write.reason);
  });
});

// [dashboard-writes#1]
test("dashboard writes: with no refs/remotes/origin/HEAD the reason tells origin not asked from origin not reached, and a default branch that is not in the clone is named as such", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const clone = writer.paths.clone;
    w.git(clone, "config", "remote.origin.followRemoteHEAD", "never");
    w.git(clone, "remote", "set-head", "origin", "--delete");
    const away = `${w.origin}.away`;
    renameSync(w.origin, away);
    const a = await writer.refresh();
    assert.equal(a.body.write.can, false);
    assert.match(a.body.write.reason, /git ls-remote could not reach origin: fatal: /);
    const b = await writer.refresh({ deadline: Date.now() - 1 });
    assert.match(b.body.write.reason, /origin was not asked this time/);
    renameSync(away, w.origin);
    // origin/HEAD names a branch the clone does not have (renamed upstream, say).
    w.git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
    const c = await writer.refresh({ deadline: Date.now() - 1 });
    assert.equal(c.body.write.can, false);
    assert.match(
      c.body.write.reason,
      /the default branch gone is not there in the clone \(refs\/remotes\/origin\/gone\)/,
    );
    assert.ok(!/does not hold/.test(c.body.write.reason), c.body.write.reason);
  });
});

// ─── Contract 2: the clone made whole, the binding folder ───────────────

// [dashboard-writes#2]
test("dashboard writes: the refresh that finds no clone makes it in clone.tmp/ beside the place with --reference-if-able and --dissociate, renames it to clone/, borrows no objects and puts it detached at origin's default branch", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.can, true, r.body.write.reason);
    const clone = writer.paths.clone;
    assert.ok(existsSync(join(clone, ".git")) && !existsSync(writer.paths.cloneTmp));
    assert.ok(!existsSync(join(clone, ".git", "objects", "info", "alternates")), "no object is borrowed afterwards");
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
    assert.equal(w.git(clone, "rev-parse", "HEAD"), w.git(w.origin, "rev-parse", "refs/heads/main"));
    const call = w.record.find((e) => subOf(e.argv).name === "clone");
    assert.equal(call.cwd, writer.place);
    assert.deepEqual(subOf(call.argv).rest, [
      "--quiet",
      `--reference-if-able=${realpathSync(join(w.repo, ".git"))}`,
      "--dissociate",
      "--",
      w.origin,
      writer.paths.cloneTmp,
    ]);
    assert.deepEqual(readdirSync(writer.place).sort(), ["clone", "project"]);
    const bound = JSON.parse(readFileSync(join(writer.paths.binding, ".projectstore", "projectstore.json"), "utf8"));
    const own = JSON.parse(readFileSync(join(w.project, ".projectstore", "projectstore.json"), "utf8"));
    assert.deepEqual(bound, { ...own, vault_path: clone });
  });
});

// [dashboard-writes#2]
test("dashboard writes: a clone ended before git exits leaves no clone/, and the next refresh removes a clone.tmp/ left behind and makes the clone again", async () => {
  await withWorld({}, async (w) => {
    const report = sshOrigin(w, "hang");
    const writer = await w.open({ budgets: { clone: 1500 } });
    const pending = writer.refresh();
    const facts = await waitFor(() => existsSync(report) && JSON.parse(readFileSync(report, "utf8")));
    assert.ok(!existsSync(writer.paths.clone), "no clone/ while git runs");
    const a = await pending;
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.write.can, false);
    assert.match(a.body.write.reason, /could not be made: git clone ran past its 1500 ms budget/);
    assert.ok(!existsSync(writer.paths.clone), "no clone/ after the clone was ended");
    assert.equal(groupAlive(facts.pgid), false, "the clone's process group is ended");
    // What a server killed in the middle of a clone leaves behind.
    mkdirSync(join(writer.paths.cloneTmp, ".git"), { recursive: true });
    writeFileSync(join(writer.paths.cloneTmp, "half.md"), "half a clone\n");
    sshOrigin(w, "serve");
    const b = await writer.refresh();
    assert.equal(b.body.write.can, true, b.body.write.reason);
    assert.ok(!existsSync(writer.paths.cloneTmp), "clone.tmp/ is gone");
    assert.ok(!existsSync(join(writer.paths.clone, "half.md")));
    assert.ok(existsSync(join(writer.paths.clone, "epics", "PS-X", "epic.md")));
    assert.equal(gitCalls(w, 0, "clone").length, 2);
  });
});

// [dashboard-writes#2]
test("dashboard writes: for a vault in docs/vault/ of its repository the binding folder's vault_path ends in clone/docs/vault, and the core reads the clone through it", async () => {
  await withWorld({ prefix: "docs/vault" }, async (w) => {
    const writer = await w.open();
    const r = await writer.refresh();
    assert.equal(r.body.write.can, true, r.body.write.reason);
    const bound = JSON.parse(readFileSync(join(writer.paths.binding, ".projectstore", "projectstore.json"), "utf8"));
    assert.equal(bound.vault_path, join(writer.paths.clone, "docs", "vault"));
    assert.ok(bound.vault_path.endsWith(`clone${sep}docs${sep}vault`));
    assert.equal(writer.readCtx().vault, bound.vault_path);
    const core = await openCore({ core: REPO, project: writer.paths.binding });
    assert.equal(core.vault, bound.vault_path);
    assert.ok(existsSync(join(core.vault, "epics", "PS-X", "stories", "story-a.md")));
  });
});

// ─── Contract 3: the clone resolves as the vault repository does ────────

// [dashboard-writes#3]
test("dashboard writes: a vault repository that sets user.email of its own gives a commit from the page that address, as author and committer", async () => {
  await withWorld({}, async (w) => {
    w.git(w.main, "config", "--global", "user.name", "Someone Else");
    w.git(w.main, "config", "--global", "user.email", "someone-else");
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const c = await writer.git(writer.paths.clone, ["commit", "--allow-empty", "--quiet", "--message=probe"]);
    assert.equal(c.ok, true, c.reason);
    assert.equal(
      w.git(writer.paths.clone, "log", "-1", "--format=%an <%ae> / %cn <%ce>"),
      "Vault Person <vault-person> / Vault Person <vault-person>",
    );
  });
});

// [dashboard-writes#3]
test("dashboard writes: the clone holds each listed key of the vault repository, two credential helpers in the same order, from its first fetch on; a key removed there is gone at the next refresh", async () => {
  await withWorld({}, async (w) => {
    const set = (...a) => w.git(w.repo, "config", ...a);
    set("--add", "credential.https://github.com.helper", "one");
    set("--add", "credential.https://github.com.helper", "two");
    set("url.https://mirror.invalid/.insteadOf", "https://up.invalid/");
    set("url.https://push.invalid/.pushInsteadOf", "https://up.invalid/");
    set("remote.origin.pushurl", "https://push.example.invalid/vault.git");
    set("commit.gpgsign", "false");
    set("user.signingkey", "ABC123");
    set("gpg.format", "ssh");
    set("ssh.variant", "ssh");
    set("core.sshCommand", "ssh -o StrictHostKeyChecking=yes");
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const clone = writer.paths.clone;
    const local = (key) => {
      const r = tryGit(w, clone, "config", "--local", "--get-all", key);
      return r.status === 0 ? r.stdout.trim().split("\n") : null;
    };
    assert.deepEqual(local("credential.https://github.com.helper"), ["one", "two"]);
    assert.deepEqual(local("url.https://mirror.invalid/.insteadOf"), ["https://up.invalid/"]);
    assert.deepEqual(local("url.https://push.invalid/.pushInsteadOf"), ["https://up.invalid/"]);
    assert.deepEqual(local("remote.origin.pushurl"), ["https://push.example.invalid/vault.git"]);
    assert.deepEqual(local("commit.gpgsign"), ["false"]);
    assert.deepEqual(local("user.signingkey"), ["ABC123"]);
    assert.deepEqual(local("gpg.format"), ["ssh"]);
    assert.deepEqual(local("ssh.variant"), ["ssh"]);
    assert.deepEqual(local("core.sshCommand"), ["ssh -o StrictHostKeyChecking=yes"]);
    assert.deepEqual(local("author.email"), ["vault-person"]);
    // The clone call carried them, so its own first fetch resolved as the vault repository does.
    const call = w.record.find((e) => subOf(e.argv).name === "clone");
    assert.deepEqual(
      call.argv.filter((a) => a.includes("github.com.helper")),
      ["--config=credential.https://github.com.helper=one", "--config=credential.https://github.com.helper=two"],
    );
    w.git(w.repo, "config", "--unset-all", "credential.https://github.com.helper");
    w.git(w.repo, "config", "--unset", "gpg.format");
    w.git(w.repo, "config", "user.signingkey", "XYZ789");
    assert.equal((await writer.refresh()).body.write.can, true);
    assert.equal(local("credential.https://github.com.helper"), null);
    assert.equal(local("gpg.format"), null);
    assert.deepEqual(local("user.signingkey"), ["XYZ789"]);
    assert.deepEqual(local("url.https://mirror.invalid/.insteadOf"), ["https://up.invalid/"]);
    // Nothing differs: nothing is written.
    const from = w.record.length;
    await writer.refresh();
    assert.ok(!gitCalls(w, from, "config").some((e) => e.argv.includes("--add") || e.argv.includes("--unset-all")));
  });
});

// [dashboard-writes#3]
test("dashboard writes: no hook of the vault repository, of the person or of a template runs in the clone, a pre-commit hook for the page's commit included", async () => {
  const hook = (dir, name, log) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\necho "$PWD ${name}" >> '${log}'\n`, { mode: 0o755 });
  };
  const HOOKS = ["pre-commit", "post-checkout", "reference-transaction", "post-commit"];
  for (const where of ["template", "hooksPath"]) {
    await withWorld({}, async (w) => {
      const log = join(w.root, "hooks.log");
      for (const h of HOOKS) hook(join(w.repo, ".git", "hooks"), h, log);
      const dir = join(w.root, where);
      for (const h of HOOKS) hook(join(dir, "hooks"), h, log);
      if (where === "template") w.git(w.main, "config", "--global", "init.templateDir", dir);
      else w.git(w.main, "config", "--global", "core.hooksPath", join(dir, "hooks"));
      const writer = await w.open();
      assert.equal((await writer.refresh()).body.write.can, true);
      const c = await writer.git(writer.paths.clone, ["commit", "--allow-empty", "--quiet", "--message=probe"]);
      assert.equal(c.ok, true, c.reason);
      landUpstream(w);
      assert.equal((await writer.refresh()).body.write.can, true);
      // The hooks are live: the vault repository's own commit ran them.
      const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      assert.ok(
        ran.some((l) => l.endsWith("pre-commit") && l.startsWith(w.repo)),
        `${where}: ${ran.join("; ")}`,
      );
      assert.deepEqual(
        ran.filter((l) => l.startsWith(writer.place)),
        [],
        `${where}: no hook ran in the place`,
      );
      const inside = w.record.filter((e) => e.cmd === "git" && e.cwd.startsWith(writer.place));
      assert.ok(inside.length > 5);
      for (const e of inside)
        assert.deepEqual(e.argv.slice(0, 2), ["-c", "core.hooksPath=/dev/null"], e.argv.join(" "));
    });
  }
});

// ─── Contract 4: the refresh and what the page reads ────────────────────

// [dashboard-writes#4]
test("dashboard writes: write holds can, reason, verbs, default_branch, fetched_at and batch; a commit that lands on the remote default branch with no batch open shows at the next refresh, through readers that name the real project", async () => {
  await withWorld({}, async (w) => {
    let t = Date.UTC(2026, 10, 17, 9, 0, 0);
    const writer = await w.open({ now: () => (t += 1000) });
    const a = await writer.refresh();
    assert.deepEqual(Object.keys(a.body.write), WRITE_KEYS);
    const { fetched_at: firstFetch, ...rest } = a.body.write;
    assert.deepEqual(rest, { can: true, reason: null, verbs: WRITE_VERBS, default_branch: "main", batch: null });
    assert.match(firstFetch, /^2026-11-17T09:00:\d\d\.000Z$/);
    assert.equal(readState(writer.readCtx()).stories.length, 1);
    const tip = landUpstream(w);
    // A GET reads what the last refresh left: no call.
    const from = w.record.length;
    assert.deepEqual(writer.view(), a.body.write);
    assert.equal(readState(writer.readCtx()).stories.length, 1, "nothing moves before the refresh");
    assert.equal(w.record.length, from);
    const b = await writer.refresh();
    assert.equal(b.body.write.can, true);
    assert.ok(b.body.write.fetched_at > firstFetch, "fetched_at is the fetch's time");
    assert.equal(w.git(writer.paths.clone, "rev-parse", "HEAD"), tip);
    assert.equal(w.git(writer.paths.clone, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    const rc = writer.readCtx();
    const state = readState(rc);
    assert.equal(state.stories.length, 2);
    assert.deepEqual(state.project, { dir: w.project, name: basename(w.project) });
    assert.deepEqual(rc.shown, { project: w.project, vault: w.vault });
    assert.equal(rc.vault, writer.paths.clone);
    assert.deepEqual(writer.view(), b.body.write);
  });
});

// [dashboard-writes#4]
test("dashboard writes: with a batch open the refresh fetches but does not move the clone, which still shows the default branch as of write.batch.started_at, and write.batch counts the commits the default branch lacks", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const clone = writer.paths.clone;
    const branch = "dashboard/test-person/20261117T081500Z";
    w.git(clone, "switch", "-q", "-c", branch);
    writeFileSync(
      join(clone, "epics", "PS-X", "epic.md"),
      readFileSync(join(clone, "epics", "PS-X", "epic.md"), "utf8") + "\n",
    );
    w.git(clone, ...w.as, "commit", "-q", "-am", "a batch's commit");
    const head = w.git(clone, "rev-parse", "HEAD");
    const tip = landUpstream(w);
    const r = await writer.refresh();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.can, true, r.body.write.reason);
    assert.deepEqual(r.body.write.batch, { branch, started_at: "2026-11-17T08:15:00.000Z", commits: 1 });
    assert.equal(w.git(clone, "rev-parse", "HEAD"), head);
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(w.git(clone, "rev-parse", "refs/remotes/origin/main"), tip, "the fetch ran");
    assert.equal(readState(writer.readCtx()).stories.length, 1, "the default branch as of the batch's start");
  });
});

// [dashboard-writes#4]
test("dashboard writes: a fetch that has not ended by the deadline ends with its group, write.fetched_at stays the last fetch that ended, past the deadline no network call starts, and a new writer starts fetched_at from FETCH_HEAD", async () => {
  await withWorld({}, async (w) => {
    sshOrigin(w, "serve");
    let t = Date.UTC(2026, 10, 17, 10, 0, 0);
    const writer = await w.open({ now: () => (t += 1000) });
    assert.equal((await writer.refresh()).body.write.can, true);
    const b = await writer.refresh();
    const fetched = b.body.write.fetched_at;
    assert.equal(gitCalls(w, 0, "fetch").length, 1);
    const report = sshOrigin(w, "hang");
    const t0 = Date.now();
    const c = await writer.refresh({ start: true, deadline: Date.now() + 1500 });
    const took = Date.now() - t0;
    assert.ok(took >= 1000 && took < 9000, `the deadline ended the fetch (${took} ms)`);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.write.can, true, "a fetch out of time fails no step");
    assert.equal(c.body.write.fetched_at, fetched);
    const facts = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(groupAlive(facts.pgid), false);
    const from = w.record.length;
    const d = await writer.refresh({ start: true, deadline: Date.now() - 1 });
    assert.equal(d.body.write.can, true);
    assert.equal(d.body.write.fetched_at, fetched);
    for (const sub of NETWORK) assert.equal(gitCalls(w, from, sub).length, 0, `no ${sub} past the deadline`);
    const mtime = Math.floor(statSync(join(writer.paths.clone, ".git", "FETCH_HEAD")).mtimeMs);
    const again = await w.open();
    const e = await again.refresh({ deadline: Date.now() - 1 });
    assert.equal(e.body.write.fetched_at, new Date(mtime).toISOString());
  });
});

// [dashboard-writes#1] [dashboard-writes#4]
test("dashboard writes: with no refs/remotes/origin/HEAD the default branch comes from ls-remote --symref and is recorded; with neither it is read-only and the page reads the bound checkout", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    assert.equal((await writer.refresh()).body.write.can, true);
    const clone = writer.paths.clone;
    // git 2.48 and newer would set it again at the fetch; older ones ignore the key.
    w.git(clone, "config", "remote.origin.followRemoteHEAD", "never");
    w.git(clone, "remote", "set-head", "origin", "--delete");
    const from = w.record.length;
    const r = await writer.refresh();
    assert.equal(r.body.write.can, true, r.body.write.reason);
    assert.equal(r.body.write.default_branch, "main");
    assert.equal(gitCalls(w, from, "ls-remote").length, 1);
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "refs/remotes/origin/HEAD"), "origin/main");
    w.git(clone, "remote", "set-head", "origin", "--delete");
    const s = await writer.refresh({ deadline: Date.now() - 1 });
    assert.equal(s.body.write.can, false);
    assert.match(s.body.write.reason, /no default branch is known/);
    assert.equal(writer.readCtx(), w.ctx);
  });
});

// ─── Contracts 4 and 8: the server ──────────────────────────────────────
//
// The server in process (startServer, through the world's start()), on port
// 0, with the world's spawn record: the moment its promise settles stands for
// the ready line.

// One request with the Host the server answers to and the headers the test names.
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
          done({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
const tokenIn = (html) => /<meta name="projectstore-token" content="([^"]*)"/.exec(html)?.[1] ?? null;
const tokenOf = async (page) => tokenIn((await call(page, "/")).text);
// The headers of the page's own request: the run's token and its Origin.
const own = (page, token, origin = `http://127.0.0.1:${page.port}`) => ({ "x-projectstore-token": token, origin });
const post = (page, path, headers = {}, body = undefined) => call(page, path, { method: "POST", headers, body });
const BODY = JSON.stringify({ verb: "move", fields: { story: "PS-X/story-a", to: "todo", reason: "r" } });

// Every file under `dir`, hashed: what "byte-identical" is checked against.
// Names in `skip` (a folder such as .git) are left out at any depth.
function treeHash(dir, skip = new Set()) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`${p}\0link\0`);
      else if (st.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

// [dashboard-writes#8]
test("dashboard writes: a POST to a write route with no token, another token, or the token with Origin null, another site's Origin or none gets 403 in the answer's shape, and no process starts", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    assert.match(token, /^[0-9a-f]{64}$/);
    const origin = `http://127.0.0.1:${page.port}`;
    const cases = [
      {},
      { origin },
      { "x-projectstore-token": "0".repeat(64), origin },
      { "x-projectstore-token": token.slice(1), origin },
      { "x-projectstore-token": token },
      { "x-projectstore-token": token, origin: "null" },
      { "x-projectstore-token": token, origin: "http://evil.example" },
      { "x-projectstore-token": token, origin: `http://127.0.0.1:${page.port + 1}` },
      { "x-projectstore-token": token, origin: `https://127.0.0.1:${page.port}` },
    ];
    const from = w.record.length;
    for (const path of WRITE_ROUTES)
      for (const headers of cases) {
        const r = await post(page, path, { "content-type": "application/json", ...headers }, BODY);
        assert.equal(r.status, 403, `${path} ${JSON.stringify(headers)}`);
        assert.equal(r.json.ok, false);
        assert.match(r.json.error, /the run's token and the page's own Origin/);
        assert.deepEqual(Object.keys(r.json.write), WRITE_KEYS);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
      }
    assert.equal(w.record.length, from, "the spawn record shows no call");
    // The token and the page's own Origin, at either name: the refresh runs.
    for (const o of [origin, `http://localhost:${page.port}`]) {
      const r = await post(page, "/api/refresh", own(page, token, o));
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.json), ["ok", "result", "write"]);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.write.can, true, r.json.write.reason);
    }
    assert.ok(gitCalls(w, from, "fetch").length >= 2, "each refresh fetched");
  });
});

// [dashboard-writes#8] [dashboard#9] [dashboard#11]
test("dashboard writes: OPTIONS to a write route gets 405 with no Access-Control-Allow-* header, a GET or HEAD to one gets 404, a POST to any other path gets 405, and none starts a process", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    const from = w.record.length;
    for (const path of WRITE_ROUTES) {
      const o = await call(page, path, {
        method: "OPTIONS",
        headers: {
          origin: "http://evil.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-projectstore-token, content-type",
        },
      });
      assert.equal(o.status, 405, path);
      assert.deepEqual(
        Object.keys(o.headers).filter((k) => k.startsWith("access-control-")),
        [],
        `${path}: no Access-Control-Allow-* header`,
      );
      for (const method of ["GET", "HEAD"])
        assert.equal((await call(page, path, { method })).status, 404, `${method} ${path}`);
      for (const method of ["PUT", "DELETE", "PATCH"])
        assert.equal((await call(page, path, { method, headers: own(page, token) })).status, 405, `${method} ${path}`);
    }
    for (const path of [
      "/",
      "/api/state",
      "/api/item?rel=epics/PS-X/epic.md",
      "/api/refresh/",
      "/api/Refresh",
      "/api/%72efresh",
      "/api/./refresh",
      "/api/x/../refresh",
      "/nowhere",
    ]) {
      const r = await post(page, path, own(page, token), BODY);
      assert.equal(r.status, 405, path);
      assert.equal(r.headers.allow, "GET, HEAD", path);
    }
    assert.equal(w.record.length, from, "the spawn record shows no call");
  });
});

// [dashboard-writes#8]
test("dashboard writes: GET / in two runs holds the meta tag with two different tokens, and a run's token is refused by the other run", async () => {
  await withWorld({}, async (w) => {
    const a = await w.start();
    const index = (await call(a, "/")).text;
    const first = tokenIn(index);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(tokenIn((await call(a, "/index.html")).text), first, "the same run, the same token");
    assert.equal(first, a.token);
    assert.equal((await call(a, "/", { method: "HEAD" })).text, "");
    assert.equal((await call(a, "/")).headers["cache-control"], "no-store");
    await a.close();
    const b = await w.start();
    const second = await tokenOf(b);
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(second, first);
    const from = w.record.length;
    assert.equal((await post(b, "/api/refresh", own(b, first))).status, 403, "the other run's token");
    assert.equal(w.record.length, from);
    assert.equal((await post(b, "/api/refresh", own(b, second))).status, 200);
  });
});

// [dashboard-writes#8] [dashboard-writes#1]
test("dashboard writes: while write.can is false, the refresh runs and the other four routes get 409 with write.reason, before a body's 400 (no JSON object, over 64 KiB, a verb outside write.verbs); Send and Discard read no body", async () => {
  await withWorld({ plainVault: true }, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    const state = (await call(page, "/api/state")).json;
    assert.equal(state.write.can, false);
    assert.match(state.write.reason, /is not in a git repository/);
    const from = w.record.length;
    for (const path of ["/api/preview", "/api/action", "/api/send", "/api/discard"]) {
      const r = await post(page, path, { ...own(page, token), "content-type": "application/json" }, BODY);
      assert.equal(r.status, 409, path);
      assert.deepEqual(r.json, { ok: false, error: state.write.reason, write: state.write });
    }
    for (const path of ["/api/send", "/api/discard"]) {
      assert.equal((await post(page, path, own(page, token), "not json")).status, 409, `${path} reads no body`);
      assert.equal((await post(page, path, own(page, token))).status, 409, `${path} with none`);
    }
    const big = JSON.stringify({
      verb: "move",
      fields: { story: "PS-X/story-a", to: "todo", reason: "x".repeat(70000) },
    });
    for (const path of ["/api/preview", "/api/action"])
      for (const bad of ["not json", "[]", "null", "3", "", big, JSON.stringify({ verb: "rank" })]) {
        const r = await post(page, path, own(page, token), bad);
        assert.equal(r.status, 409, `${path} ${bad.slice(0, 40)}: write.can false comes first`);
        assert.deepEqual(r.json, { ok: false, error: state.write.reason, write: state.write });
      }
    assert.equal(w.record.length, from, "no process for any of them");
    const r = await post(page, "/api/refresh", own(page, token));
    assert.equal(r.status, 200);
    assert.equal(r.json.write.can, false);
    assert.ok(w.record.length > from, "the refresh asked git again");
  });
});

// [dashboard-writes#8] [dashboard-writes#6]
test("dashboard writes: while write.can is true, a body that is no JSON object or is over 64 KiB, or a verb or field outside write.verbs, gets 400 and starts no process, and Send or Discard with no open batch gets 409", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    assert.equal(page.writer.view().can, true, page.writer.view().reason);
    const from = w.record.length;
    const big = JSON.stringify({
      verb: "move",
      fields: { story: "PS-X/story-a", to: "todo", reason: "x".repeat(70000) },
    });
    const bodies = [
      [JSON.stringify({ verb: "rank" }), /not a verb the page may run \(write\.verbs: move\)/],
      [JSON.stringify({}), /not a verb the page may run/],
      [
        JSON.stringify({ verb: "move", fields: { story: "PS-X/story-a", to: "done", reason: "r" } }),
        /to is one of todo, planned/,
      ],
      [
        JSON.stringify({ verb: "move", fields: { story: "PS-X/story-a", to: "todo", reason: "r", by: "x" } }),
        /"by" is not a field of move/,
      ],
      ["{oops", /no JSON object/],
      ["[]", /no JSON object/],
      [big, /over 65536 bytes/],
    ];
    for (const path of ["/api/preview", "/api/action"])
      for (const [body, why] of bodies) {
        const r = await post(page, path, own(page, token), body);
        assert.equal(r.status, 400, `${path} ${body.slice(0, 60)}`);
        assert.deepEqual(Object.keys(r.json), ["ok", "error", "write"]);
        assert.equal(r.json.ok, false);
        assert.match(r.json.error, why);
        assert.equal(r.json.write.can, true);
      }
    for (const path of ["/api/send", "/api/discard"]) {
      const r = await post(page, path, own(page, token));
      assert.equal(r.status, 409, path);
      assert.match(r.json.error, /no batch is open/);
    }
    assert.equal(w.record.length, from, "the spawn record shows no call");
    // With a batch open, Send and Discard are not built in this step: 501, still no process.
    const clone = page.writer.paths.clone;
    w.git(clone, "switch", "-q", "-c", "dashboard/test-person/20261117T090000Z");
    writeFileSync(
      join(clone, "epics", "PS-X", "epic.md"),
      readFileSync(join(clone, "epics", "PS-X", "epic.md"), "utf8") + "\n",
    );
    w.git(clone, ...w.as, "commit", "-q", "-am", "a batch's commit");
    assert.equal((await post(page, "/api/refresh", own(page, token))).json.write.batch.commits, 1);
    const at = w.record.length;
    assert.equal((await post(page, "/api/send", own(page, token))).status, 501);
    assert.equal(w.record.length, at);
  });
});

// [dashboard-writes#4] [dashboard-writes#1]
test("dashboard writes: the start's refresh ends before the ready line: the first start makes the clone, the next fetches, inside 10 s; /api/state carries write, names the real project and the bound vault, and the readers read the clone", async () => {
  await withWorld({}, async (w) => {
    let t = Date.UTC(2026, 10, 17, 12, 0, 0);
    const now = () => (t += 1000);
    const first = await w.start({ now });
    assert.equal(first.writer.view().can, true, first.writer.view().reason);
    assert.ok(existsSync(join(first.writer.paths.clone, ".git")), "the clone is there at the ready line");
    assert.equal(gitCalls(w, 0, "clone").length, 1);
    const made = first.writer.view().fetched_at;
    await first.close();
    const from = w.record.length;
    const t0 = Date.now();
    const page = await w.start({ now });
    assert.ok(Date.now() - t0 < 10000, "inside 10 s");
    assert.equal(gitCalls(w, from, "fetch").length, 1, "the start fetched before its ready line");
    assert.equal(page.vault, w.vault, "the ready line's vault is the bound vault");
    const after = w.record.length;
    // A story only in the bound checkout: the page reads its clone, which lacks it.
    const stories = join(w.vault, "epics", "PS-X", "stories");
    writeFileSync(
      join(stories, "story-c.md"),
      readFileSync(join(stories, "story-a.md"), "utf8").replaceAll("story-a", "story-c"),
    );
    const state = (await call(page, "/api/state")).json;
    assert.deepEqual(Object.keys(state.write), WRITE_KEYS);
    assert.equal(state.write.can, true);
    assert.equal(state.write.default_branch, "main");
    assert.ok(state.write.fetched_at > made, `the fetch's time (${state.write.fetched_at} after ${made})`);
    assert.equal(state.vault, w.vault);
    assert.deepEqual(state.project, { dir: w.project, name: basename(w.project) });
    assert.deepEqual(
      state.stories.map((s) => s.rel),
      ["epics/PS-X/stories/story-a.md"],
      "the clone's stories",
    );
    assert.equal((await call(page, "/api/item?rel=epics/PS-X/stories/story-c.md")).status, 404);
    assert.equal((await call(page, "/api/item?rel=epics/PS-X/stories/story-a.md")).status, 200);
    assert.ok(!(await call(page, "/api/artifacts")).json.some((a) => a.rel.includes("story-c")));
    assert.equal((await call(page, "/api/related?rel=epics/PS-X/epic.md")).status, 200);
    assert.equal(w.record.length, after, "no GET starts a process");
  });
});

// [dashboard-writes#4]
test("dashboard writes: a fetch at the start that has not ended by the start's budget ends with its group, the ready line follows, and write.fetched_at is the last fetch that ended", async () => {
  await withWorld({}, async (w) => {
    sshOrigin(w, "serve");
    const a = await w.start();
    const token = await tokenOf(a);
    assert.equal((await post(a, "/api/refresh", own(a, token))).json.write.can, true);
    await a.close();
    const mtime = Math.floor(statSync(join(a.writer.paths.clone, ".git", "FETCH_HEAD")).mtimeMs);
    const report = sshOrigin(w, "hang");
    const from = w.record.length;
    const t0 = Date.now();
    const page = await w.start({ budgets: { start: 1500 } });
    const took = Date.now() - t0;
    assert.ok(took >= 1000 && took < 9000, `the start's budget ended the fetch (${took} ms)`);
    assert.equal(gitCalls(w, from, "fetch").length, 1);
    const write = (await call(page, "/api/state")).json.write;
    assert.equal(write.can, true, "a fetch out of time fails no step");
    assert.equal(write.fetched_at, new Date(mtime).toISOString());
    const facts = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(groupAlive(facts.pgid), false, "the fetch's process group is ended");
    assert.equal(pidAlive(facts.grandchild), false);
    assert.equal(page.writer.live, 0);
  });
});

// [dashboard-writes#4]
test("dashboard writes: a GET reads what the last refresh left and starts no process; POST /api/refresh recomputes write and shows a commit that landed on the remote default branch", async () => {
  await withWorld({}, async (w) => {
    let t = Date.UTC(2026, 10, 17, 13, 0, 0);
    const page = await w.start({ now: () => (t += 1000) });
    const token = await tokenOf(page);
    const before = (await call(page, "/api/state")).json;
    assert.equal(before.stories.length, 1);
    const tip = landUpstream(w);
    const from = w.record.length;
    const again = (await call(page, "/api/state")).json;
    assert.equal(again.stories.length, 1, "nothing moves before the refresh");
    assert.deepEqual(again.write, before.write);
    assert.equal(w.record.length, from, "a GET starts no process");
    const r = await post(page, "/api/refresh", own(page, token));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.write.fetched_at > before.write.fetched_at);
    assert.equal(w.git(page.writer.paths.clone, "rev-parse", "HEAD"), tip);
    const after = (await call(page, "/api/state")).json;
    assert.equal(after.stories.length, 2);
    assert.deepEqual(after.write, r.json.write, "the next GET carries write as the step left it");
  });
});

// [dashboard-writes#8] [dashboard-writes#5]
test("dashboard writes: an error the step did not expect answers 500 in the same shape, with its message, and no lock is left", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    // The binding folder's place taken by a file: the refresh cannot write it.
    const binding = page.writer.paths.binding;
    rmSync(binding, { recursive: true, force: true });
    writeFileSync(binding, "not a folder\n");
    const r = await post(page, "/api/refresh", own(page, token));
    assert.equal(r.status, 500, r.text);
    assert.deepEqual(Object.keys(r.json), ["ok", "error", "write"]);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /^refresh: .*(ENOTDIR|EEXIST)/);
    assert.ok(!existsSync(page.writer.paths.lock), "no lock is left");
  });
});

// [dashboard-writes#9] [dashboard-writes#4]
test("dashboard writes: a server stopped during its start ends the running fetch with its process group and never says it is ready; the command line's server exits 0 on SIGTERM then", async () => {
  await withWorld({}, async (w) => {
    sshOrigin(w, "serve");
    await (await w.start()).close();
    let report = sshOrigin(w, "hang");
    const stop = new AbortController();
    const t0 = Date.now();
    const starting = w.start({ signal: stop.signal });
    const facts = await waitFor(() => existsSync(report) && JSON.parse(readFileSync(report, "utf8")));
    stop.abort();
    await assert.rejects(starting, { code: "ABORT_ERR" });
    assert.ok(Date.now() - t0 < 9000, "stopped before the start's budget");
    assert.equal(groupAlive(facts.pgid), false);
    assert.equal(pidAlive(facts.grandchild), false);

    // The same through main(): the signal heard during the start.
    rmSync(report, { force: true });
    report = sshOrigin(w, "hang");
    const child = spawn(
      process.execPath,
      [join(REPO, "dashboard", "server.mjs"), "--core", REPO, "--project", w.project, "--port", "0"],
      {
        env: w.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
    try {
      const seen = await waitFor(() => existsSync(report) && JSON.parse(readFileSync(report, "utf8")));
      child.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null }, err);
      assert.equal(out, "", "no ready line");
      assert.equal(groupAlive(seen.pgid), false);
      assert.equal(pidAlive(seen.grandchild), false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

// [dashboard-writes#4]
test("dashboard writes: the start's budget is 10 s, and with the stop's grace it ends inside the launcher's wait", () => {
  assert.equal(START_BUDGET_MS, 10000);
  const launcher = readFileSync(join(REPO, "scripts", "dashboard.mjs"), "utf8");
  const wait = Number(/const START_MS = (\d+);/.exec(launcher)?.[1]);
  // SIGTERM to the call's group at the budget, SIGKILL 2 s later, 1 s more at most.
  assert.ok(wait >= START_BUDGET_MS + 3000 + 1000, `the launcher waits ${wait} ms`);
});

// [dashboard#10]
test("dashboard writes: on a writable vault, answering every GET route after the ready line leaves the project, the vault's repository and the core byte-identical", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    assert.equal(page.writer.view().can, true);
    const snapshot = () => [
      treeHash(w.main),
      treeHash(w.repo),
      treeHash(join(REPO, "scripts")),
      treeHash(join(REPO, "dashboard")),
    ];
    const before = snapshot();
    const from = w.record.length;
    const index = (await call(page, "/")).text;
    for (const m of index.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g))
      assert.equal((await call(page, `/${m[1]}`)).status, 200, m[1]);
    const state = (await call(page, "/api/state")).json;
    const arts = (await call(page, "/api/artifacts")).json;
    const rels = [...state.stories.map((s) => s.rel), ...arts.map((a) => a.rel)].filter(Boolean);
    assert.ok(rels.length >= 2, "the crawl reads documents");
    for (const rel of rels) {
      assert.equal((await call(page, `/api/item?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
      assert.equal((await call(page, `/api/related?rel=${encodeURIComponent(rel)}`)).status, 200, rel);
      await call(page, `/vault/${rel}`, { method: "HEAD" });
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(w.record.length, from, "no GET starts a process");
  });
});

// ─── Contract 9: the module's processes ─────────────────────────────────

// [dashboard-writes#4] [dashboard-writes#8]
test("dashboard writes: a start whose refresh fails keeps its error, write.reason says the refresh failed and not that the page has not looked yet, and the command line prints it to stderr after the ready line", async () => {
  await withWorld({}, async (w) => {
    const first = await w.start();
    const binding = first.writer.paths.binding;
    await first.close();
    // The binding folder's place taken by a file: the start's refresh cannot write it.
    rmSync(binding, { recursive: true, force: true });
    writeFileSync(binding, "not a folder\n");
    const page = await w.start();
    assert.match(page.startError, /^refresh: .*(ENOTDIR|EEXIST)/);
    const write = (await call(page, "/api/state")).json.write;
    assert.equal(write.can, false);
    assert.match(write.reason, /^the refresh failed: refresh: .*(ENOTDIR|EEXIST)/);
    assert.doesNotMatch(write.reason, /has not looked/);
    assert.ok(!existsSync(page.writer.paths.lock), "no lock is left");
    await page.close();

    const child = spawn(
      process.execPath,
      [join(REPO, "dashboard", "server.mjs"), "--core", REPO, "--project", w.project, "--port", "0"],
      { env: w.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise((done) => child.on("exit", () => done()));
    try {
      await waitFor(
        () => /"ready":true/.test(out) && /dashboard: the start's refresh failed: refresh: /.test(err),
        20000,
      );
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    assert.equal(out.trim().split("\n").length, 1, "stdout carries the ready line only");
    assert.match(err, /^dashboard: the start's refresh failed: refresh: .*(ENOTDIR|EEXIST)/m);
  });
});

// ─── Contracts 6 and 7: the preview and the action ──────────────────────

const STORY_REL = "epics/PS-X/stories/story-a.md";
const EPIC_REL = "epics/PS-X/epic.md";
const move = (fields = {}) => ({
  verb: "move",
  fields: { story: "PS-X/story-a", to: "todo", reason: "next up", ...fields },
});
const cliCalls = (w, from, verb) =>
  w.record.slice(from).filter((e) => e.cmd === process.execPath && e.argv[1] === verb);
const headOf = (w, clone) => w.git(clone, "rev-parse", "HEAD");
const porcelain = (w, clone) => w.git(clone, "status", "--porcelain", "--untracked-files=all");
const batchBranches = (w, clone) => w.git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/dashboard/");
const committedFiles = (w, clone, rev = "HEAD") =>
  w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort();
const NO_GIT = new Set([".git"]);
// The clone as a step leaves it: HEAD, a clean tree, and its files.
const cloneState = (w, clone) => ({
  head: headOf(w, clone),
  status: porcelain(w, clone),
  files: treeHash(clone, NO_GIT),
});

async function writable(w, opts) {
  const writer = await w.open(opts);
  const r = await writer.refresh();
  assert.equal(r.body.write.can, true, r.body.write.reason);
  return writer;
}

// [dashboard-writes#6]
test("dashboard writes: write.verbs holds only verbs the core has, each a writing verb with a plan mode (--write), its fields the verb's positionals and options, and move's targets todo and planned", () => {
  assert.deepEqual(
    WRITE_VERBS.map((v) => v.verb),
    Object.keys(VERB_ARGV),
  );
  assert.deepEqual(
    WRITE_VERBS.map((v) => v.verb),
    ["move"],
    "this story offers move only",
  );
  for (const entry of WRITE_VERBS) {
    const row = VERBS.find((r) => r.verb === entry.verb);
    assert.ok(row, `the core has ${entry.verb}`);
    assert.equal(row.writes, true, `${entry.verb} writes`);
    const write = row.options.find((o) => o.name === "write");
    assert.ok(write && write.arg === false, `${entry.verb} has a plan mode: bare it plans, --write writes`);
    assert.ok(
      row.options.some((o) => o.name === "json"),
      `${entry.verb} answers --json`,
    );
    const call = VERB_ARGV[entry.verb];
    assert.deepEqual([...call.positionals, ...call.options].sort(), Object.keys(entry.fields).sort());
    for (const name of call.options) {
      const o = row.options.find((x) => x.name === name);
      assert.ok(o && typeof o.arg === "string", `--${name} is an option of ${entry.verb} that takes a value`);
    }
    assert.equal(row.usage[0].split(" ").length, call.positionals.length, `${entry.verb}'s positionals`);
  }
  const src = readFileSync(join(REPO, "scripts", "move.mjs"), "utf8");
  const targets = /const TARGETS = Object\.freeze\(\{([^}]*)\}\)/.exec(src)?.[1] ?? "";
  assert.deepEqual(
    [...targets.matchAll(/(\w+):/g)].map((m) => m[1]),
    WRITE_VERBS[0].fields.to.values,
  );
});

// [dashboard-writes#6]
test("dashboard writes: a move's preview answers with move's own plan, result.path is the story's path in the bound vault, no path under the place is named, and the clone's HEAD and working tree are unchanged", async () => {
  for (const prefix of ["", "docs/vault"])
    await withWorld({ prefix }, async (w) => {
      const writer = await writable(w);
      const clone = writer.paths.clone;
      const before = cloneState(w, clone);
      const from = w.record.length;
      const r = await writer.preview(move());
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body), ["ok", "result", "write"]);
      assert.equal(r.body.ok, true);
      const { result } = r.body;
      assert.equal(result.story, "PS-X/story-a");
      assert.equal(result.from, "planned");
      assert.equal(result.to, "todo");
      assert.equal(result.reason, "next up");
      assert.equal(result.written, false);
      assert.equal(result.path, join(w.vault, STORY_REL), "the story's path in the bound vault");
      assert.ok(!JSON.stringify(r.body).includes(writer.place), "no path under the place is named");
      assert.deepEqual(cloneState(w, clone), before, "HEAD and the working tree are unchanged");
      assert.equal(r.body.write.batch, null);
      const calls = cliCalls(w, from, "move");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv.slice(1), [
        "move",
        `--project=${writer.paths.binding}`,
        "--json",
        "--reason=next up",
        "--",
        "PS-X/story-a",
        "todo",
      ]);
      assert.equal(calls[0].cwd, writer.paths.binding);
      assert.match(readFileSync(join(w.vault, STORY_REL), "utf8"), /^status: planned$/m);
    });
});

// [dashboard-writes#6]
test("dashboard writes: a verb other than move, a field outside move's, to done, or a reason that is empty or holds a line break gets 400 from the preview and the action, and the spawn record shows no call", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const sep2028 = String.fromCharCode(0x2028);
    const bad = [
      { verb: "rank", fields: { story: "PS-X/story-a", to: "todo", reason: "r" } },
      { verb: "assign", fields: { story: "PS-X/story-a" } },
      { verb: "reconcile" },
      { fields: move().fields },
      { verb: "move" },
      { verb: "move", fields: [] },
      { ...move(), write: true },
      move({ write: "true" }),
      move({ to: "done" }),
      move({ to: "in-progress" }),
      move({ to: "TODO" }),
      move({ reason: "one\ntwo" }),
      move({ reason: "one\rtwo" }),
      move({ reason: `one${sep2028}two` }),
      move({ reason: "   " }),
      move({ reason: 3 }),
      move({ story: "story-a" }),
      move({ story: "PS-X/story a" }),
      move({ story: "../x/y" }),
      { verb: "move", fields: { story: "PS-X/story-a", to: "todo" } },
    ];
    const from = w.record.length;
    for (const body of bad)
      for (const fn of ["preview", "action"]) {
        const r = await writer[fn](body);
        assert.equal(r.status, 400, `${fn} ${JSON.stringify(body)}`);
        assert.deepEqual(Object.keys(r.body), ["ok", "error", "write"]);
        assert.equal(r.body.ok, false);
      }
    assert.equal(w.record.length, from, "the spawn record shows no call");
    assert.ok(!existsSync(writer.paths.lock));
    assert.deepEqual(checkRequest(move({ reason: "  padded  " })), {
      ok: true,
      verb: "move",
      fields: { story: "PS-X/story-a", to: "todo", reason: "padded" },
    });
  });
});

// [dashboard-writes#6] [dashboard-writes#7]
test("dashboard writes: a reason that starts with - reaches move as the reason, in the preview, the story's Status log and the commit's message", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const reason = "-x --write";
    const from = w.record.length;
    const p = await writer.preview(move({ reason }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.result.reason, reason);
    assert.equal(p.body.result.written, false, "the reason's --write is no option");
    assert.ok(cliCalls(w, from, "move")[0].argv.includes(`--reason=${reason}`));
    const a = await writer.action(move({ reason }));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.result.reason, reason);
    const clone = writer.paths.clone;
    assert.ok(readFileSync(join(clone, STORY_REL), "utf8").includes(reason));
    assert.equal(w.git(clone, "log", "-1", "--format=%s"), `move PS-X/story-a to todo: ${reason}`);
  });
});

// [dashboard-writes#7] [dashboard-writes#4]
test("dashboard writes: a move that succeeds is one commit of the story and its epic.md and no derived view, the first one puts the clone on dashboard/<person>/<YYYYMMDDTHHMMSSZ> at it (the next free second), the derived views go back to the branch head, and write.batch.commits is 1", async () => {
  await withWorld({}, async (w) => {
    const t = Date.UTC(2026, 10, 17, 14, 5, 9, 500);
    assert.equal(stampFor(t), "20261117T140509Z");
    const writer = await writable(w, { now: () => t });
    const clone = writer.paths.clone;
    const base = headOf(w, clone);
    // A branch of that second is there already (a batch discarded in it).
    w.git(clone, "branch", "dashboard/test-person/20261117T140509Z", base);
    const from = w.record.length;
    const r = await writer.action(move());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body), ["ok", "result", "write"]);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.written, true);
    assert.equal(r.body.result.path, join(w.vault, STORY_REL));
    assert.ok(!JSON.stringify(r.body).includes(writer.place));
    const branch = "dashboard/test-person/20261117T140510Z";
    assert.deepEqual(r.body.write.batch, { branch, started_at: "2026-11-17T14:05:10.000Z", commits: 1 });
    assert.deepEqual(writer.view().batch, r.body.write.batch, "the next /api/state holds it too");
    assert.equal(w.git(clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(w.git(clone, "rev-parse", "HEAD^"), base, "one new commit");
    assert.equal(w.git(clone, "rev-parse", `refs/heads/${branch}`), headOf(w, clone));
    const files = committedFiles(w, clone);
    assert.deepEqual(files, [EPIC_REL, STORY_REL]);
    const views = derivedViewPaths(loadLayout("engineering"));
    const derived = [views.board, views.codeMap, views.graph, ...views.indexes.map((x) => x.path)].filter(Boolean);
    assert.ok(derived.includes("kanban.md") && derived.includes("epics/README.md"));
    for (const f of files) assert.ok(!derived.includes(f), `${f} is no derived view`);
    assert.ok(r.body.result.reconcile.written > 0, "move regenerated the derived views");
    assert.equal(porcelain(w, clone), "", "the derived views are back at the branch head");
    assert.equal(readFileSync(join(clone, "kanban.md"), "utf8"), "stub board\n");
    assert.match(readFileSync(join(clone, STORY_REL), "utf8"), /^status: todo$/m);
    assert.equal(w.git(clone, "log", "-1", "--format=%s"), "move PS-X/story-a to todo: next up");
    assert.equal(
      w.git(clone, "log", "-1", "--format=%an <%ae> | %cn <%ce>"),
      "Vault Person <vault-person> | Vault Person <vault-person>",
    );
    // Staged by name, committed on the detached HEAD, then the branch made.
    const calls = gitCalls(w, from).map((e) => subOf(e.argv));
    const add = calls.find((c) => c.name === "add");
    assert.deepEqual(add.rest.slice(0, 2), ["--all", "--"]);
    assert.deepEqual(add.rest.slice(2).sort(), [EPIC_REL, STORY_REL]);
    const order = calls.map((c) => c.name);
    assert.ok(order.lastIndexOf("commit") < order.lastIndexOf("switch"), "the commit comes before the branch");
    assert.deepEqual(calls.find((c) => c.name === "switch").rest, [`--create=${branch}`, "--quiet", "--", "HEAD"]);
    assert.equal(
      readState(writer.readCtx()).stories.find((s) => s.rel === STORY_REL).status,
      "todo",
      "the readers read the clone",
    );
    assert.match(readFileSync(join(w.vault, STORY_REL), "utf8"), /^status: planned$/m, "the bound vault is as it was");

    // A second move goes on the open batch.
    const r2 = await writer.action(move({ to: "planned", reason: "not this week" }));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(r2.body.write.batch, { branch, started_at: "2026-11-17T14:05:10.000Z", commits: 2 });
    assert.deepEqual(batchBranches(w, clone).split("\n").sort(), ["dashboard/test-person/20261117T140509Z", branch]);
  });
});

// [dashboard-writes#7]
test("dashboard writes: a move that refuses leaves the clone's HEAD and working tree as they were and no batch branch, and the answer holds move's refusal with the project's paths", async () => {
  await withWorld({}, async (w) => {
    // story-a in progress on origin: move changes only planned to todo and back.
    const file = join(w.vault, STORY_REL);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^status: planned$/m, "status: in-progress"));
    w.git(w.repo, "add", "-A");
    w.git(w.repo, ...w.as, "commit", "-q", "-m", "story-a starts");
    w.git(w.repo, "push", "-q", "origin", "main");
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = cloneState(w, clone);
    for (const [body, why] of [
      [move(), /no gate moves a story from in-progress to todo/],
      [move({ story: "PS-X/story-zz" }), /no story in epics\/PS-X matches "story-zz"/],
    ]) {
      const r = await writer.action(body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body), ["ok", "result", "error", "write"]);
      assert.equal(r.body.ok, false);
      assert.match(r.body.error, why);
      assert.equal(r.body.result.written, false);
      assert.equal(r.body.write.batch, null);
      assert.ok(!JSON.stringify(r.body).includes(writer.place), "no path under the place is named");
      assert.deepEqual(cloneState(w, clone), before);
      assert.equal(batchBranches(w, clone), "", "no batch branch");
      assert.ok(!existsSync(writer.paths.lock));
    }
    const r = await writer.action(move());
    assert.equal(r.body.result.path, join(w.vault, STORY_REL), "the refusal names the story in the bound vault");
  });
});

// [dashboard-writes#7]
test("dashboard writes: a move that changes nothing outside the derived views, the story in that status already with its epic row agreeing, makes no commit and starts no batch", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = cloneState(w, clone);
    const r = await writer.action(move({ to: "planned", reason: "still later" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.written, false);
    assert.equal(r.body.result.epic.written, false, "the epic row agrees");
    assert.ok(r.body.result.reconcile.written > 0, "only the derived views changed");
    assert.equal(r.body.write.batch, null);
    assert.deepEqual(cloneState(w, clone), before);
    assert.equal(batchBranches(w, clone), "");
  });
});

// [dashboard-writes#7]
test("dashboard writes: with commit.gpgsign true and a signer that fails, no commit is made, no batch branch exists, the working tree is as before, and the answer holds git's message", async () => {
  await withWorld({}, async (w) => {
    w.git(w.repo, "config", "commit.gpgsign", "true");
    writeFileSync(w.env.GIT_CONFIG_GLOBAL, `[gpg]\n\tprogram = ${join(w.root, "no-such-signer")}\n`);
    const writer = await writable(w);
    const clone = writer.paths.clone;
    assert.equal(
      w.git(clone, "config", "--local", "commit.gpgsign"),
      "true",
      "the clone signs as the vault repository does",
    );
    const before = cloneState(w, clone);
    const r = await writer.action(move());
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body), ["ok", "error", "write"]);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /^git commit: [\s\S]*(gpg|sign)/i);
    assert.equal(r.body.write.batch, null);
    assert.deepEqual(cloneState(w, clone), before);
    assert.equal(batchBranches(w, clone), "", "no batch branch");
    assert.ok(!existsSync(writer.paths.lock));
  });
});

// [dashboard-writes#7]
test("dashboard writes: with every manifest's session id and project variable and PROJECTSTORE_PROJECT_DIR set, an action leaves the bound checkout byte-identical and no *.writes folder under the project's or the binding folder's .projectstore/state/sessions/", async () => {
  await withWorld({}, async (w) => {
    const manifests = [...loadHarnesses().values()];
    const sessionVars = manifests.map((m) => m.runtime?.session_id_env).filter(Boolean);
    const projectVars = manifests.map((m) => m.runtime?.project_dir_env).filter(Boolean);
    assert.ok(sessionVars.includes("CLAUDE_CODE_SESSION_ID"), sessionVars.join(", "));
    assert.ok(projectVars.length > 0);
    const env = { ...w.env, PROJECTSTORE_PROJECT_DIR: w.project };
    for (const k of sessionVars) env[k] = "dash-session-1";
    for (const k of projectVars) env[k] = w.project;
    const writer = await writable(w, { env });
    const bound = treeHash(w.repo);
    const r = await writer.action(move());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.write.batch.commits, 1);
    assert.equal(treeHash(w.repo), bound, "the bound checkout is byte-identical");
    for (const dir of [w.project, writer.paths.binding]) {
      const sessions = stateDir(dir);
      const found = existsSync(sessions) ? readdirSync(sessions).filter((n) => n.endsWith(".writes")) : [];
      assert.deepEqual(found, [], `no record of writes under ${sessions}`);
    }
  });
});

// [dashboard-writes#2] [dashboard-writes#7]
test("dashboard writes: for a vault in docs/vault/ of its repository an action changes files only under clone/docs/vault, and its answer names the bound vault's paths", async () => {
  await withWorld({ prefix: "docs/vault" }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const r = await writer.action(move());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(committedFiles(w, clone), [`docs/vault/${EPIC_REL}`, `docs/vault/${STORY_REL}`]);
    assert.equal(r.body.result.path, join(w.vault, STORY_REL));
    assert.equal(r.body.result.epic.path, join(w.vault, EPIC_REL));
    assert.equal(porcelain(w, clone), "");
  });
});

// [dashboard-writes#6]
test("dashboard writes: the clone's and the binding folder's paths become the bound vault's, the repository's and the project's, whole names only", () => {
  const pairs = [
    ["/p/state/clone/docs/vault", "/repo/docs/vault"],
    ["/p/state/clone", "/repo"],
    ["/p/state/project", "/code"],
  ];
  assert.deepEqual(
    substitutePaths(
      {
        a: "/p/state/clone/docs/vault/epics/x.md",
        b: ["/p/state/clone/README.md", "in /p/state/project: done"],
        c: "/p/state/clone.tmp and /p/state/projects stay",
        d: 3,
        e: null,
      },
      pairs,
    ),
    {
      a: "/repo/docs/vault/epics/x.md",
      b: ["/repo/README.md", "in /code: done"],
      c: "/p/state/clone.tmp and /p/state/projects stay",
      d: 3,
      e: null,
    },
  );
});

// [dashboard-writes#6] [dashboard-writes#7] [dashboard-writes#8] [dashboard-writes#4]
test("dashboard writes: through the server, POST /api/preview answers with move's plan and POST /api/action with one commit, both only with the token and the page's Origin and in the answer's shape; the next GET /api/state holds write.batch.commits 1 and reads the moved story from the clone", async () => {
  await withWorld({}, async (w) => {
    const page = await w.start();
    const token = await tokenOf(page);
    const from = w.record.length;
    for (const path of ["/api/preview", "/api/action"]) {
      assert.equal((await post(page, path, { "content-type": "application/json" }, BODY)).status, 403);
      assert.equal((await post(page, path, { "x-projectstore-token": token, origin: "null" }, BODY)).status, 403);
    }
    assert.equal(w.record.length, from, "no call without the token and the page's Origin");
    const p = await post(page, "/api/preview", own(page, token), BODY);
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(Object.keys(p.json), ["ok", "result", "write"]);
    assert.equal(p.json.result.path, join(w.vault, STORY_REL));
    assert.equal(p.json.result.written, false);
    assert.ok(!p.text.includes(page.writer.place));
    assert.equal(p.json.write.batch, null);
    const a = await post(page, "/api/action", own(page, token, `http://localhost:${page.port}`), BODY);
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(Object.keys(a.json), ["ok", "result", "write"]);
    assert.equal(a.json.ok, true);
    assert.equal(a.json.write.batch.commits, 1);
    const state = (await call(page, "/api/state")).json;
    assert.deepEqual(state.write, a.json.write);
    assert.equal(state.stories.find((s) => s.rel === STORY_REL).status, "todo");
    assert.equal(state.vault, w.vault);
    assert.match(readFileSync(join(w.vault, STORY_REL), "utf8"), /^status: planned$/m);
    const n = await post(page, "/api/action", own(page, token), JSON.stringify(move({ story: "PS-X/story-zz" })));
    assert.equal(n.status, 200, n.text);
    assert.equal(n.json.ok, false);
    assert.match(n.json.error, /no story in epics\/PS-X matches/);
    assert.equal(n.json.write.batch.commits, 1);
  });
});

// [dashboard-writes#9]
test("dashboard writes: the budgets are 60 s for git and a core verb, 30 s for gh and 120 s for a first clone", () => {
  assert.deepEqual({ ...BUDGETS }, { git: 60000, verb: 60000, gh: 30000, clone: 120000 });
  assert.ok(Object.isFrozen(BUDGETS));
});

// [dashboard-writes#9]
test("dashboard writes: the module's push refuses main and every name outside dashboard/, and nothing is pushed", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    w.cloneInto(writer.paths.clone);
    const refs = w.git(w.origin, "show-ref");
    const before = w.record.length;
    for (const name of [
      "main",
      "refs/heads/main",
      "dashboard/test-person",
      "dashboard/../main",
      "dashboard/x/y:main",
      "+dashboard/x/y",
      "dashboard/-x/y",
      "dashboard/x/y.lock",
      "--force",
      "",
    ]) {
      assert.ok(!isBatchBranch(name), name);
      const r = await writer.pushBatch(name);
      assert.equal(r.ok, false, name);
      assert.match(r.reason, /refused/, name);
    }
    assert.equal(w.record.length, before, "no call started");
    assert.equal(w.git(w.origin, "show-ref"), refs, "origin is as it was");
    // A push outside the push function never starts either.
    const r = await writer.run("git", ["push", "--", "origin", "refs/heads/dashboard/test-person/1"], {
      cwd: writer.paths.clone,
    });
    assert.ok(r.refused);
    assert.equal(w.record.length, before);
  });
});

// [dashboard-writes#9]
test("dashboard writes: the module's push sends refs/heads/<branch> to the same name, no tag follows, and no other ref moves", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const clone = w.cloneInto(writer.paths.clone);
    const main = w.git(w.origin, "rev-parse", "refs/heads/main");
    const branch = "dashboard/test-person/20261117T000000Z";
    w.git(clone, "switch", "-q", "-c", branch);
    writeFileSync(join(clone, "kanban.md"), "moved\n");
    w.git(clone, ...w.as, "commit", "-q", "-am", "a change");
    w.git(clone, ...w.as, "tag", "-a", "-m", "t", "a-tag");
    w.git(w.main, "config", "--global", "push.followTags", "true");
    const r = await writer.pushBatch(branch);
    assert.equal(r.ok, true, r.reason);
    assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), w.git(clone, "rev-parse", "HEAD"));
    assert.equal(w.git(w.origin, "rev-parse", "refs/heads/main"), main);
    assert.equal(tryGit(w, w.origin, "rev-parse", "--verify", "--quiet", "refs/tags/a-tag").status, 1, "no tag");
    const push = w.record.filter((e) => e.cmd === "git" && subOf(e.argv).name === "push");
    assert.equal(push.length, 1);
    assert.deepEqual(push[0].argv, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "push.followTags=false",
      "push",
      "--porcelain",
      "--",
      "origin",
      `refs/heads/${branch}`,
    ]);
    assert.equal(push[0].via, "pushBatch");
  });
});

// [dashboard-writes#9]
test("dashboard writes: no gh call is pr merge, a pr close that deletes the branch, or one that forces, and a refused call starts nothing", async () => {
  await withWorld({}, async (w) => {
    const stub = ghStub(join(w.root, "gh"), { prs: [] });
    const writer = await w.open({ env: stub.env(w.env) });
    const before = w.record.length;
    for (const argv of [
      ["pr", "merge", "--", "1"],
      ["pr", "close", "-d", "--", "1"],
      ["pr", "close", "--delete-branch", "--", "1"],
      ["pr", "list", "--force"],
      ["pr", "create", "-f"],
      ["pr", "list", "--force-with-lease=x"],
      ["repo", "delete", "--", "acme/app"],
      ["api", "--", "repos/acme/app"],
    ]) {
      assert.ok(refusal("gh", argv), argv.join(" "));
      const r = await writer.gh(w.vault, argv);
      assert.equal(r.ok, false);
      assert.ok(r.refused, argv.join(" "));
    }
    assert.equal(w.record.length, before);
    assert.deepEqual(stub.log(), []);
    for (const argv of [
      ["git", ["push", "--force", "--", "origin", "refs/heads/dashboard/a/b"]],
      ["git", ["-c", "x=y", "push", "--", "origin", "refs/heads/dashboard/a/b"]],
    ])
      assert.match(refusal(...argv), /only the push function/);
    assert.equal(refusal("git", ["fetch", "--", "origin"]), null);
  });
});

// [dashboard-writes#9]
test("dashboard writes: a stub ssh command sees no terminal on stdin, cannot open /dev/tty, runs in a process group led by the git call and not the server's, with the three prompt variables", async () => {
  await withWorld({}, async (w) => {
    const report = sshOrigin(w, "serve");
    const writer = await w.open();
    assert.equal(writer.personSsh, true, "core.sshCommand is the person's own ssh command");
    const r = await writer.git(w.vault, ["ls-remote", "--", "origin"]);
    assert.equal(r.ok, true, r.reason);
    assert.match(r.stdout, /refs\/heads\/main/);
    const facts = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(facts.stdinTTY, false);
    assert.notEqual(facts.tty, "opened", "no controlling terminal");
    const call = w.record.find((e) => e.argv.includes("ls-remote"));
    assert.equal(facts.pgid, call.pid, "the git call leads the group");
    assert.notEqual(facts.pgid, pgidOf(process.pid), "not the server's group");
    assert.deepEqual(facts.env, {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      SSH_ASKPASS_REQUIRE: "never",
      GIT_SSH_COMMAND: null,
    });
    // core.sshCommand is set: after the question, no call adds BatchMode.
    const after = w.record.slice(w.record.findIndex((e) => e.via === "askSsh") + 1);
    assert.ok(after.length >= 2);
    for (const e of after) assert.equal(e.env.GIT_SSH_COMMAND, undefined, e.argv.join(" "));
  });
});

// [dashboard-writes#9]
test("dashboard writes: with no ssh command set anywhere, each git call carries GIT_SSH_COMMAND=ssh -o BatchMode=yes and the prompt variables", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    w.cloneInto(writer.paths.clone);
    const r = await writer.step("probe", () => ({ result: null }));
    assert.equal(r.status, 200);
    const calls = w.record.filter((e) => e.cmd === "git");
    assert.ok(calls.length >= 6, `the calls: ${calls.map((e) => e.argv.join(" ")).join("; ")}`);
    for (const e of calls) {
      // eslint-disable-next-line no-unused-vars -- the ceiling is read in the clone/.git case
      const { GIT_CEILING_DIRECTORIES, ...rest } = e.env;
      assert.deepEqual(
        rest,
        {
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          SSH_ASKPASS_REQUIRE: "never",
          GIT_SSH_COMMAND: SSH_BATCH,
        },
        e.argv.join(" "),
      );
    }
    assert.equal(SSH_BATCH, "ssh -o BatchMode=yes");
  });
});

// [dashboard-writes#9]
test("dashboard writes: the ssh question keeps its last answer when git config fails for another reason than no such key", async () => {
  await withWorld({}, async (w) => {
    w.git(w.repo, "config", "core.sshCommand", "ssh -i /nonexistent/key");
    const writer = await w.open();
    assert.equal(writer.personSsh, true);
    writeFileSync(join(w.repo, ".git", "config"), readFileSync(join(w.repo, ".git", "config"), "utf8") + "[broken\n");
    const r = await writer.step("probe", () => ({ result: null }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ask = w.record.filter((e) => e.via === "askSsh");
    assert.equal(ask.length, 2);
    assert.equal(writer.personSsh, true, "a broken config does not turn BatchMode on");
    assert.equal(w.record.at(-1).env.GIT_SSH_COMMAND, undefined);
  });
});

// [dashboard-writes#9]
test("dashboard writes: the module runs git, gh and this Node only", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const before = w.record.length;
    for (const cmd of ["sh", "/bin/sh", "bash", "ssh", "node", "npm"]) {
      const r = await writer.run(cmd, ["-c", "true"], { cwd: w.root });
      assert.ok(r.refused, cmd);
      assert.match(refusal(cmd, []), /git, gh and this Node only/);
    }
    assert.equal(w.record.length, before);
  });
});

// [dashboard-writes#9]
test("dashboard writes: GIT_SSH_COMMAND or GIT_SSH in the server's environment is kept, and no call adds BatchMode", async () => {
  for (const [key, value] of [
    ["GIT_SSH_COMMAND", "ssh -i /nonexistent/key"],
    ["GIT_SSH", "/nonexistent/ssh"],
  ]) {
    await withWorld({}, async (w) => {
      const writer = await w.open({ env: { ...w.env, [key]: value } });
      w.cloneInto(writer.paths.clone);
      await writer.step("probe", () => ({ result: null }));
      const calls = w.record.filter((e) => e.cmd === "git");
      assert.ok(calls.length >= 6);
      for (const e of calls) {
        assert.equal(e.env[key], value);
        if (key === "GIT_SSH") assert.equal(e.env.GIT_SSH_COMMAND, undefined);
      }
    });
  }
});

// [dashboard-writes#9]
test("dashboard writes: a call that its step cannot go on without and that outlives its budget ends with its process group, the step answers 502, and no lock is left", async () => {
  await withWorld({}, async (w) => {
    const report = sshOrigin(w, "hang");
    const writer = await w.open({ budgets: { git: 1500 } });
    const t0 = Date.now();
    const r = await writer.step("probe", async () => {
      await writer.git(w.vault, ["ls-remote", "--", "origin"], { need: true });
      return { result: "not reached" };
    });
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /git ls-remote ran past its 1500 ms budget/);
    assert.ok(Date.now() - t0 < 10000, "the budget ended it");
    assert.ok(!existsSync(writer.paths.lock), "no lock is left");
    const facts = JSON.parse(readFileSync(report, "utf8"));
    const call = w.record.find((e) => e.argv.includes("ls-remote"));
    assert.equal(facts.pgid, call.pid);
    assert.equal(groupAlive(facts.pgid), false, "the process group is ended");
    assert.equal(pidAlive(facts.grandchild), false, "the ssh command's own child too");
    assert.equal(writer.live, 0);
  });
});

// [dashboard-writes#9]
test("dashboard writes: stopping the module ends its running calls with their process groups, and starts none after", async () => {
  await withWorld({}, async (w) => {
    const report = sshOrigin(w, "hang");
    const writer = await w.open();
    const pending = writer.git(w.vault, ["ls-remote", "--", "origin"]);
    const facts = await waitFor(() => existsSync(report) && JSON.parse(readFileSync(report, "utf8")));
    assert.equal(writer.live, 1);
    await writer.stop();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal(r.stopped, true);
    assert.match(r.reason, /stopped with the server/);
    assert.equal(groupAlive(facts.pgid), false);
    assert.equal(pidAlive(facts.grandchild), false);
    const before = w.record.length;
    const late = await writer.git(w.vault, ["status"]);
    assert.ok(late.refused);
    assert.equal(w.record.length, before);
  });
});

// [dashboard-writes#9]
test("dashboard writes: gh missing, logged out or past its budget is a gh that cannot be asked, and its group is ended", async () => {
  await withWorld({}, async (w) => {
    // A PATH with git and without gh.
    const bin = join(w.root, "bin");
    mkdirSync(bin);
    const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(which, join(bin, "git"));
    const none = await w.open({ env: { ...w.env, PATH: bin } });
    const missing = await none.gh(w.vault, ["pr", "list", "--state=all", "--json=number"]);
    assert.deepEqual([missing.ok, missing.unavailable], [false, true]);
    assert.match(missing.reason, /not installed or not on PATH/);

    const stub = ghStub(join(w.root, "gh"), { auth: true });
    const writer = await w.open({ env: stub.env(w.env), budgets: { gh: 1500 } });
    const out = await writer.gh(w.vault, ["pr", "list", "--state=all", "--json=number"]);
    assert.deepEqual([out.ok, out.unavailable], [false, true]);
    assert.match(out.reason, /gh auth login/);

    stub.set({ fail: { list: "hang" } });
    const hung = await writer.gh(w.vault, ["pr", "list", "--state=all", "--json=number"]);
    assert.deepEqual([hung.ok, hung.timedOut], [false, true]);
    assert.match(hung.reason, /gh pr list ran past its 1500 ms budget/);
    const call = w.record.filter((e) => e.cmd === "gh").at(-1);
    assert.equal(groupAlive(call.pid), false);

    stub.set({ prs: [] });
    const ok = await writer.gh(w.vault, ["pr", "list", "--state=open", "--json=url"]);
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(ok.stdout), []);
  });
});

// [dashboard-writes#9]
test("dashboard writes: the core's CLI runs through this Node with --name=value options and -- before its positionals", async () => {
  await withWorld({}, async (w) => {
    const writer = await w.open();
    const r = await writer.cli("status", { options: { project: w.project, json: true, write: false }, cwd: w.project });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.envelope.verb, "status");
    assert.equal(r.envelope.ok, true);
    const call = w.record.at(-1);
    assert.equal(call.cmd, process.execPath);
    assert.deepEqual(call.argv, [
      join(REPO, "bin", "projectstore.mjs"),
      "status",
      `--project=${w.project}`,
      "--json",
      "--",
    ]);
    assert.equal(call.via, "cli");
  });
});

// [dashboard-writes#9]
test("dashboard writes: only the module's push function names push", () => {
  const src = readFileSync(MODULE, "utf8");
  const start = src.indexOf("async function pushBatch(");
  assert.ok(start > 0, "the push function is there");
  const end = src.indexOf("\n  }\n", start);
  const hits = [...src.matchAll(/"push"/g)].map((m) => m.index);
  const outside = hits.filter((i) => i < start || i > end);
  assert.ok(
    hits.some((i) => i > start && i < end),
    "the push function names push",
  );
  // The guard names it too, to refuse a push from anywhere else.
  assert.deepEqual(
    outside.map((i) => src.slice(i - 9, i + 6)),
    ['name !== "push"'],
  );
});

// [dashboard-writes#9]
test("dashboard writes: every call of the file's tests is an argv with no shell, its options before an end-of-options mark and its positional arguments after it", () => {
  assert.ok(ALL.length > 50, `the record holds the file's calls (${ALL.length})`);
  const seen = new Set();
  for (const e of ALL) {
    assert.ok(["git", "gh", process.execPath].includes(e.cmd), `no shell: ${e.cmd}`);
    let argv = e.argv;
    if (e.cmd === process.execPath) argv = argv.slice(1);
    const { name, rest } = e.cmd === "git" ? subOf(argv) : { name: argv[0], rest: argv.slice(1) };
    seen.add(`${e.cmd === "git" ? "git" : e.cmd === "gh" ? "gh" : "cli"} ${name}`);
    const mark = rest.findIndex((a) => a === "--" || a === "--end-of-options");
    const options = mark === -1 ? rest : rest.slice(0, mark);
    if (e.cmd === "git" && name === "var") {
      // `git var <NAME>` refuses a mark: its one argument is the variable's name.
      assert.equal(mark, -1, "git var takes no mark");
      assert.equal(rest.length, 1, `git var names one variable: ${argv.join(" ")}`);
      assert.match(rest[0], /^GIT_[A-Z_]+$/);
      continue;
    }
    // `gh pr list` and `git remote get-url` name their subcommand twice: group and verb.
    const own = e.cmd === "gh" || (e.cmd === "git" && name === "remote") ? options.slice(1) : options;
    for (const a of own) assert.ok(a.startsWith("-"), `${e.cmd} ${argv.join(" ")}: ${a} comes before the mark`);
  }
  for (const s of [
    "git rev-parse",
    "git config",
    "git reset",
    "git clean",
    "git push",
    "git merge",
    "git clone",
    "git fetch",
    "git switch",
    "git var",
    "git remote",
    "git ls-remote",
    "git for-each-ref",
    "git rev-list",
    "git symbolic-ref",
    "git status",
    "git add",
    "git commit",
    "gh pr",
    "cli status",
    "cli move",
  ])
    assert.ok(seen.has(s), `${s} is among the calls read (${[...seen].join(", ")})`);
  assert.ok(!ALL.some((e) => e.cmd === "git" && subOf(e.argv).name === "checkout"), "no checkout");
  assert.ok(MODULE.endsWith(`dashboard${sep}lib${sep}write.mjs`) && dirname(MODULE).endsWith("lib"));
});

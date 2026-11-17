// projectstore — tests/dashboard-writes.test.mjs: the dashboard's write path
// (PS-DASHBOARD, "The page writes by running core verbs, with a preview, and
// the click is the approval"; the spec "The dashboard's write path: a clone of
// its own, an action as core verbs, a batch sent as one pull request, and a
// server that runs processes only for its own page", alias `dashboard-writes`).
//
// This file holds the module's foundation: the place (contract 2), the step
// lock and its recovery (contract 5) and the processes (contract 9). Each case
// builds its own world (tests/fixtures/dashboard-world.mjs): a bare `origin`,
// a vault repository cloned from it, a project bound to that vault, with HOME,
// XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL inside the world's folder. The
// module's spawn record is read for "no call" and for every argv rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, sep } from "node:path";
import { hermeticGit, makeWorld, SSH_STUB, REPO } from "./fixtures/dashboard-world.mjs";
import { ghStub } from "./fixtures/gh-stub.mjs";
import {
  BUDGETS,
  LOCK_FILE,
  SSH_BATCH,
  StepError,
  anchorOf,
  isBatchBranch,
  placePaths,
  refusal,
} from "../dashboard/lib/write.mjs";
import { mainCheckoutOfProject } from "../scripts/worktree.mjs";

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

// ─── Contract 9: the module's processes ─────────────────────────────────

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
    // `gh pr list` names its subcommand twice: group and verb.
    const own = e.cmd === "gh" ? options.slice(1) : options;
    for (const a of own) assert.ok(a.startsWith("-"), `${e.cmd} ${argv.join(" ")}: ${a} comes before the mark`);
  }
  for (const s of [
    "git rev-parse",
    "git config",
    "git reset",
    "git clean",
    "git push",
    "git merge",
    "gh pr",
    "cli status",
  ])
    assert.ok(seen.has(s), `${s} is among the calls read (${[...seen].join(", ")})`);
  assert.ok(!ALL.some((e) => e.cmd === "git" && subOf(e.argv).name === "checkout"), "no checkout");
  assert.ok(MODULE.endsWith(`dashboard${sep}lib${sep}write.mjs`) && dirname(MODULE).endsWith("lib"));
});

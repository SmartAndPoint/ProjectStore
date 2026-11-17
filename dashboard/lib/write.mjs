// The dashboard's write module: the one file of the page's package that starts
// a process or writes a file (the spec "The dashboard's write path: a clone of
// its own, an action as core verbs, a batch sent as one pull request, and a
// server that runs processes only for its own page", alias `dashboard-writes`).
//
// This part holds the process layer (contract 9), the place on disk
// (contract 2) and the step lock with its recovery (contract 5). The clone, the
// refresh, the preview, the action and the delivery build on it.
//
//   openWriter({ ctx, project, budgets, record, env, now, view }) → writer
//     writer.run(cmd, argv, opts)     the only spawn: argv, no shell, its own process group
//     writer.git(cwd, args, opts)     git, `-c` pairs from opts.config, ahead of the subcommand
//     writer.gh(cwd, args, opts)      gh, classified: ok, or unavailable / timed out, with a reason
//     writer.cli(verb, call, opts)    the core's CLI through this Node, `--name=value`, then `--`
//     writer.pushBatch(branch, opts)  the only push: refs/heads/<branch> to the same name, dashboard/ only
//     writer.step(name, fn)           queued, under the place's lock, after recover(); → { status, body }
//     writer.recover()                the clone back at its branch head
//     writer.stop()                   ends every running call with its process group
//   anchorOf(dir, opts)               the code repository's main checkout (the core's worktree rule)
//   placePaths(place)                 clone/, clone.tmp/, project/ and the lock file
//
// Every call: stdin ignored, `detached` (a session and process group of its
// own, so no controlling terminal), GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never
// and SSH_ASKPASS_REQUIRE=never, and GIT_SSH_COMMAND="ssh -o BatchMode=yes"
// when the person set no ssh command (neither GIT_SSH nor GIT_SSH_COMMAND in
// the server's environment, nor core.sshCommand or ssh.variant in the vault
// repository's configuration). A call past its budget ends with its whole
// process group. The variables that would point git at another repository
// are removed, and a call inside the place gets GIT_CEILING_DIRECTORIES set to
// the place, so it never reaches the code repository the place sits in. Only
// git, gh and this Node run. Each call is appended to the spawn record, when
// one is given.
//
// Lines of git's own that this module reads stay plain text; the git floor is
// 2.30, so no `rev-parse --path-format`: a relative answer is resolved against
// the directory git ran in.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// The budgets of contract 9, in milliseconds. A test passes smaller ones.
export const BUDGETS = Object.freeze({ git: 60000, verb: 60000, gh: 30000, clone: 120000 });
// After SIGTERM, how long a process group has before SIGKILL. Git removes its
// own lock files on SIGTERM; SIGKILL can leave one behind, which recover() clears.
const KILL_GRACE_MS = 2000;
// How long the pipes may drain after the child exits (the core's host runner
// measured a grandchild holding a pipe for seconds after `exit`).
const DRAIN_MS = 200;
const POLL_MS = 20;

export const SSH_BATCH = "ssh -o BatchMode=yes";
export const PROMPT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" });
// What would point a git call at a repository other than its working directory's.
const LOCATING_ENV = Object.freeze(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"]);
// The variables each record entry carries.
export const RECORDED_ENV = Object.freeze(["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "SSH_ASKPASS_REQUIRE", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_CEILING_DIRECTORIES"]);

export const LOCK_FILE = "projectstore-dashboard.lock";
// `gh` logged out: its documented exit for an authentication error.
const AUTH_EXIT = 4;

// The `gh` calls the module may make, by subcommand; nothing else starts.
const GH_ALLOWED = Object.freeze({ pr: Object.freeze(["list", "view", "create", "close"]) });
// Options no push and no gh call carries (contract 9).
const FORCING = Object.freeze(["--force", "-f", "--force-with-lease", "--force-if-includes", "--delete", "-d", "--mirror", "--all", "--tags", "--prune"]);
const PUSH_OPTIONS = Object.freeze(["--porcelain", "--quiet", "--dry-run"]);
// Only pushBatch holds this, so only it can make run() push.
const PUSHER = Symbol("pushBatch");

// A step's failure with the status it answers (contract 8): 502 for a call
// the step cannot go on without, 409 for the lock, and so on.
export class StepError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const lines = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean);
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The place's paths (contract 2): the clone, the folder a clone is made in,
// the binding folder and the lock.
export function placePaths(place) {
  return { place, clone: join(place, "clone"), cloneTmp: join(place, "clone.tmp"), binding: join(place, "project"), lock: join(place, LOCK_FILE) };
}

// A batch branch: dashboard/<person>/<stamp>, segments git accepts as they are.
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
export function isBatchBranch(name) {
  if (typeof name !== "string" || !name.startsWith("dashboard/")) return false;
  const parts = name.split("/");
  if (parts.length < 3) return false;
  return parts.slice(1).every((p) => SEGMENT.test(p) && !p.includes("..") && !p.endsWith(".") && !p.endsWith(".lock"));
}

// git's subcommand and what follows it, past `-c <k>=<v>`, `-C <dir>` and other global options.
function gitSubcommand(argv) {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-c" || a === "-C") i += 2;
    else if (a.startsWith("-")) i += 1;
    else break;
  }
  return { name: argv[i] ?? null, rest: argv.slice(i + 1) };
}

// Why a call may not run, or null. The module runs git, gh and this Node (the
// core's CLI) only. Pushes go through pushBatch only, to one branch under
// dashboard/ of the same name; gh runs only the subcommands of GH_ALLOWED,
// never `pr merge`, and `pr close` keeps the branch.
export function refusal(cmd, argv, via = null) {
  if (cmd !== "git" && cmd !== "gh" && cmd !== process.execPath) return `the module runs git, gh and this Node only, not ${cmd}`;
  if (cmd === "git") {
    const { name, rest } = gitSubcommand(argv);
    if (name !== "push") return null;
    if (via !== PUSHER) return "only the push function pushes";
    const mark = rest.indexOf("--");
    const opts = mark === -1 ? rest : rest.slice(0, mark);
    const positional = mark === -1 ? [] : rest.slice(mark + 1);
    for (const o of opts) if (!PUSH_OPTIONS.includes(o)) return `a push carries no ${o}`;
    if (positional.length !== 2 || positional[0] !== "origin") return "a push names origin and one branch";
    const ref = positional[1];
    if (/[+:]/.test(ref) || !ref.startsWith("refs/heads/") || !isBatchBranch(ref.slice("refs/heads/".length))) return `a push pushes refs/heads/<a branch under dashboard/>, not ${ref}`;
    return null;
  }
  if (cmd === "gh") {
    const [group, sub] = argv;
    if (!GH_ALLOWED[group] || !GH_ALLOWED[group].includes(sub)) return `gh ${[group, sub].filter(Boolean).join(" ")} is not a call of the page`;
    for (const a of argv) {
      if (FORCING.includes(a) || a.startsWith("--force-with-lease=")) return `a gh call carries no ${a}`;
      if (group === "pr" && sub === "close" && (a === "--delete-branch" || a.startsWith("--delete-branch="))) return "gh pr close keeps the branch";
    }
    return null;
  }
  return null;
}

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
};
const signalGroup = (pid, sig) => {
  try {
    process.kill(-pid, sig);
  } catch {}
};

// SIGTERM to the whole group, SIGKILL after the grace, and back when the
// group is gone (or a second after SIGKILL, whatever is left being the OS's).
async function endGroup(pid) {
  if (!pid) return;
  signalGroup(pid, "SIGTERM");
  const grace = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < grace) await sleep(POLL_MS);
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGKILL");
  const hard = Date.now() + 1000;
  while (groupAlive(pid) && Date.now() < hard) await sleep(POLL_MS);
}

// The process layer, without a place: the spawn, git, gh and the core's CLI.
function runner({ budgets = {}, record = null, env = process.env, root = null } = {}) {
  const B = { ...BUDGETS, ...budgets };
  const live = new Map();
  let stopped = false;
  // null: not asked yet, so a call adds BatchMode (asking is no network call).
  let personSsh = null;

  const stoppedPids = new Set();
  const named = (e) => Object.fromEntries(RECORDED_ENV.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
  const viaName = (via) => (via === PUSHER ? "pushBatch" : via);
  const sink = (entry) => {
    if (!record) return;
    if (typeof record === "function") record(entry);
    else if (Array.isArray(record)) record.push(entry);
  };

  // The place, once known: a git call inside it never looks for a repository
  // above it. Without this, a clone/.git that is no repository would send
  // `reset --hard` to the code repository the place sits in.
  let ceiling = null;
  const within = (dir, top) => {
    const rel = relative(top, dir);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
  };
  const ceilingFor = (cwd) => {
    if (!ceiling) return null;
    return within(resolve(cwd), ceiling.given) || within(real(cwd), ceiling.real) ? ceiling.real : null;
  };

  const envFor = (cwd) => {
    const out = { ...env };
    for (const k of LOCATING_ENV) delete out[k];
    Object.assign(out, PROMPT_ENV);
    const set = Boolean(env.GIT_SSH || env.GIT_SSH_COMMAND || personSsh);
    if (!set) out.GIT_SSH_COMMAND = SSH_BATCH;
    const top = ceilingFor(cwd);
    if (top) out.GIT_CEILING_DIRECTORIES = top;
    return out;
  };

  // The one spawn. Settles with spawnSync's shape plus `timedOut`, `stopped`,
  // `refused`, `missingCwd` and the child's `pid`; never throws.
  function run(cmd, argv, { cwd = process.cwd(), budget = B.git, via = null } = {}) {
    const why = stopped ? "the server is stopping" : refusal(cmd, argv, via);
    if (why) return Promise.resolve({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error(why), { code: "EREFUSED" }), refused: true, timedOut: false, stopped: false, missingCwd: false, pid: null });
    const callEnv = envFor(cwd);
    return new Promise((settle) => {
      const out = [], err = [];
      let child = null, done = false, timer = null, drain = null, exited = null, timedOut = false;
      const release = () => {
        for (const s of [child?.stdout, child?.stderr]) {
          try {
            s?.destroy();
          } catch {}
        }
        try {
          child?.unref?.();
        } catch {}
      };
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(drain);
        if (child?.pid) live.delete(child.pid);
        // Node says ENOENT for a working directory that is not there too.
        const missingCwd = r.error?.code === "ENOENT" && !isDir(cwd);
        settle({ status: null, signal: null, stdout: out.join(""), stderr: err.join(""), error: undefined, refused: false, timedOut, stopped: Boolean(child?.pid && stoppedPids.has(child.pid)), missingCwd, cwd, pid: child?.pid ?? null, ...r });
      };
      try {
        child = spawn(cmd, argv, { cwd, env: callEnv, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false, windowsHide: true });
      } catch (e) {
        sink({ cmd, argv: [...argv], cwd, env: named(callEnv), pid: null, via: viaName(via) });
        finish({ error: e });
        return;
      }
      sink({ cmd, argv: [...argv], cwd, env: named(callEnv), pid: child.pid ?? null, via: viaName(via) });
      if (child.pid) live.set(child.pid, child);
      const drained = () => [child.stdout, child.stderr].every((s) => !s || s.readableEnded || s.destroyed);
      for (const [s, into] of [[child.stdout, out], [child.stderr, err]]) {
        if (!s) continue;
        s.setEncoding("utf8");
        s.on("data", (d) => into.push(d));
        s.on("end", () => {
          if (exited && drained()) finish(exited);
        });
        s.on("error", () => {});
      }
      child.on("error", (e) => {
        finish({ error: e });
        release();
      });
      child.on("exit", (code, signal) => {
        exited = { status: code, signal };
        if (timedOut) return;
        if (drained()) {
          finish(exited);
          return;
        }
        drain = setTimeout(() => {
          finish(exited);
          release();
        }, DRAIN_MS);
      });
      timer = setTimeout(async () => {
        timedOut = true;
        await endGroup(child.pid);
        finish({ status: null, signal: "SIGTERM", error: Object.assign(new Error(`${cmd} ran past its ${budget} ms budget and was stopped`), { code: "ETIMEDOUT" }) });
        release();
      }, budget);
    });
  }
  // What a failed call says: git's (or gh's) own message, or what ran out.
  const failure = (cmd, sub, r, budget) => {
    if (r.refused) return `refused: ${r.error.message}`;
    if (r.timedOut) return `${cmd} ${sub} ran past its ${budget} ms budget and was stopped`;
    if (r.stopped) return `${cmd} ${sub} was stopped with the server`;
    if (r.missingCwd) return `${cmd} ${sub} could not start: the folder ${r.cwd} is not there`;
    if (r.error?.code === "ENOENT") return `${cmd} is not installed or not on PATH`;
    if (r.error) return `${cmd} ${sub}: ${r.error.message || r.error}`;
    return String(r.stderr || "").trim() || `${cmd} ${sub} exited ${r.status}`;
  };

  // git in `cwd`. `config` becomes `-c <k>=<v>` pairs ahead of the subcommand;
  // `need` makes a failure the step's 502 (contract 8).
  async function git(cwd, args, { config = null, budget = B.git, need = false, via = "git" } = {}) {
    const pairs = Object.entries(config || {}).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
    const r = await run("git", [...pairs, ...args], { cwd, budget, via });
    r.ok = r.status === 0;
    if (!r.ok) {
      r.reason = failure("git", args[0], r, budget);
      if (need) throw new StepError(502, r.reason);
    }
    return r;
  }

  // gh in `cwd`: { ok, stdout } or { ok: false, unavailable, timedOut, reason }.
  // Missing from PATH and logged out (exit 4) are `unavailable`.
  async function gh(cwd, args, { budget = B.gh, via = "gh" } = {}) {
    const r = await run("gh", args, { cwd, budget, via });
    const sub = args.slice(0, 2).join(" ");
    if (r.status === 0) return { ok: true, stdout: r.stdout, stderr: r.stderr, pid: r.pid };
    const first = String(r.stderr || "").trim().split("\n")[0].trim();
    if (r.refused) return { ok: false, unavailable: false, timedOut: false, refused: true, reason: failure("gh", sub, r, budget) };
    if (r.missingCwd) return { ok: false, unavailable: false, timedOut: false, reason: failure("gh", sub, r, budget) };
    if (r.error?.code === "ENOENT") return { ok: false, unavailable: true, timedOut: false, reason: "gh is not installed or not on PATH" };
    if (r.timedOut) return { ok: false, unavailable: false, timedOut: true, reason: failure("gh", sub, r, budget) };
    if (r.status === AUTH_EXIT) return { ok: false, unavailable: true, timedOut: false, reason: first || "gh is not logged in (exit 4)" };
    return { ok: false, unavailable: false, timedOut: false, reason: first || failure("gh", sub, r, budget) };
  }

  // The core's CLI through this Node: `<verb> --name=value… -- <positionals>`.
  // `true` is a bare `--name`; false, null and undefined are left out. The
  // answer adds `envelope`, the parsed `--json` output when there is one.
  async function cli(verb, { options = {}, positionals = [], cwd = process.cwd() } = {}, { budget = B.verb, need = false, via = "cli" } = {}) {
    if (!root) throw new Error("no core root to run the CLI from");
    const opts = Object.entries(options).flatMap(([k, v]) => (v === true ? [`--${k}`] : v === false || v === null || v === undefined ? [] : [`--${k}=${v}`]));
    const argv = [join(root, "bin", "projectstore.mjs"), verb, ...opts, "--", ...positionals.map(String)];
    const r = await run(process.execPath, argv, { cwd, budget, via });
    try {
      r.envelope = JSON.parse(r.stdout);
    } catch {
      r.envelope = null;
    }
    if (r.timedOut || r.stopped || r.refused || (r.error && r.status === null)) {
      r.reason = failure("projectstore", verb, r, budget);
      if (need) throw new StepError(502, r.reason);
    }
    return r;
  }

  async function stop() {
    stopped = true;
    const pids = [...live.keys()];
    for (const p of pids) stoppedPids.add(p);
    await Promise.all(pids.map((p) => endGroup(p)));
  }

  return {
    budgets: Object.freeze(B),
    run,
    git,
    gh,
    cli,
    stop,
    get live() {
      return live.size;
    },
    // The person's own ssh command, read from the vault repository's
    // configuration (every scope): core.sshCommand or ssh.variant.
    // Exit 1 is git's "no such key"; any other failure keeps the last answer.
    async askSsh(vault) {
      const r = await git(vault, ["config", "--get-regexp", "--", "^(core\\.sshcommand|ssh\\.variant)$"], { via: "askSsh" });
      if (r.status === 0) personSsh = lines(r.stdout).length > 0;
      else if (r.status === 1) personSsh = false;
      return personSsh;
    },
    // Every git call whose working directory is inside `place` gets
    // GIT_CEILING_DIRECTORIES=<its real path> (the place may not exist yet:
    // its real path is the real anchor's, joined with the rest).
    setCeiling(place, anchor) {
      ceiling = { given: resolve(place), real: join(real(anchor), relative(resolve(anchor), resolve(place))) };
    },
    get ceiling() {
      return ceiling ? ceiling.real : null;
    },
    get personSsh() {
      return personSsh;
    },
    pusher: PUSHER,
  };
}

// The code repository's main checkout (contract 2): for a linked worktree its
// main checkout, confirmed by asking the candidate for its own common dir;
// for a main checkout its top; for a project that is no git repository (or a
// worktree whose main checkout cannot be confirmed, as with a git dir kept
// apart from it) the project itself. The core's worktree module holds the
// same rule (mainCheckoutOfProject), and a test holds the two together.
async function anchorWith(git, dir) {
  const project = resolve(dir);
  const r = await git(project, ["rev-parse", "--git-dir", "--git-common-dir"], { via: "anchor" });
  const [gd, cd] = lines(r.stdout);
  if (!r.ok || !gd || !cd) return project;
  const gitDir = real(resolve(project, gd));
  const commonDir = real(resolve(project, cd));
  const top = async (at) => {
    const t = await git(at, ["rev-parse", "--show-toplevel"], { via: "anchor" });
    return t.ok ? lines(t.stdout)[0] || null : null;
  };
  if (gitDir === commonDir) return (await top(project)) || project;
  const candidate = await top(dirname(commonDir));
  if (!candidate) return project;
  const c = await git(candidate, ["rev-parse", "--git-common-dir"], { via: "anchor" });
  const theirs = c.ok ? lines(c.stdout)[0] : null;
  return theirs && real(resolve(candidate, theirs)) === commonDir ? candidate : project;
}

export async function anchorOf(dir, { env = process.env, record = null, budgets = {} } = {}) {
  return anchorWith(runner({ env, record, budgets }).git, dir);
}

// The writer over one bound project. `ctx` is openCore's context (the core's
// lib, the vault, the binding, the core root); `project` is the bound
// project's directory (ctx.project when left out). `now` returns the time in
// ms (a Date is taken too): the server's start time in the lock comes from it.
// `view` gives each answer's `write` (contract 8); null until the refresh has one.
// `beforeBreak(holder)` is a test seam: it runs after a stale holder is read
// and before its lock is moved aside, so a test can stand in for a race.
export async function openWriter({ ctx, project = ctx?.project, budgets = {}, record = null, env = process.env, now = () => Date.now(), view = null, beforeBreak = null } = {}) {
  if (!ctx || !ctx.lib) throw new Error("openWriter needs the core's context (openCore)");
  const lib = ctx.lib;
  const proc = runner({ budgets, record, env, root: ctx.root });
  const git = proc.git;
  const started = Number(now());
  const host = hostname();
  // The ssh question first, so the anchor's calls already carry its answer.
  await proc.askSsh(ctx.vault);
  const anchor = await anchorWith(proc.git, project);
  const person = lib.slugify(String(ctx.cfg?.default_author ?? ""));
  const place = join(anchor, lib.LAYOUT.root, lib.LAYOUT.state, "dashboard", person);
  const paths = placePaths(place);
  const gitignore = lib.layoutPaths(anchor).gitignore;
  proc.setCeiling(place, anchor);

  // The place, made only after `.projectstore/.gitignore` carries `state/`.
  function ensurePlace() {
    lib.ensureGitignoreLines(gitignore, [`${lib.LAYOUT.state}/`]);
    mkdirSync(place, { recursive: true });
    return place;
  }

  const mine = () => ({ host, pid: process.pid, started });
  function readLock() {
    try {
      const h = JSON.parse(readFileSync(paths.lock, "utf8"));
      return h && typeof h === "object" ? h : null;
    } catch {
      return null;
    }
  }
  // Broken: this host and a dead pid, or this server's pid (with another start
  // time, or its own: steps queue, so a lock of its own is one a step left).
  const breakable = (h) => h && h.host === host && Number.isInteger(h.pid) && (h.pid === process.pid || !lib.pidAlive(h.pid));
  const holderText = (h) => (h ? `pid ${h.pid} on ${h.host}${h.started ? `, started ${new Date(Number(h.started)).toISOString()}` : ""}` : "a holder that cannot be read");

  // A stale lock is moved aside atomically and read again there: two
  // processes that both saw the same dead holder cannot both break it, since
  // the second one moves the first one's fresh lock and finds it live. A lock
  // that is no longer stale is put back (unless a newer one already stands).
  // { broken: true } or { broken: false, holder }.
  function breakStale(seen) {
    if (beforeBreak) beforeBreak(seen);
    const aside = `${paths.lock}.${process.pid}.${randomBytes(6).toString("hex")}.aside`;
    try {
      renameSync(paths.lock, aside);
    } catch (e) {
      if (e?.code === "ENOENT") return { broken: true };
      throw e;
    }
    let moved = null;
    try {
      moved = JSON.parse(readFileSync(aside, "utf8"));
    } catch {}
    if (breakable(moved)) {
      rmSync(aside, { force: true });
      return { broken: true };
    }
    try {
      linkSync(aside, paths.lock);
    } catch {}
    rmSync(aside, { force: true });
    return { broken: false, holder: moved };
  }

  // { ok: true }, or { ok: false, holder } when another live process holds it.
  function acquire() {
    ensurePlace();
    const text = JSON.stringify(mine()) + "\n";
    for (let i = 0; i < 3; i++) {
      if (lib.createFileExclusive(paths.lock, text)) return { ok: true };
      const holder = readLock();
      if (!breakable(holder)) return { ok: false, holder };
      const b = breakStale(holder);
      if (!b.broken) return { ok: false, holder: b.holder };
    }
    return { ok: false, holder: readLock() };
  }
  function release() {
    const h = readLock();
    if (h && h.host === host && h.pid === process.pid && Number(h.started) === started) rmSync(paths.lock, { force: true });
  }

  // The clone back at its branch head (contract 5): an index.lock removed, an
  // unfinished merge or cherry-pick aborted, uncommitted files dropped.
  async function recover() {
    const clone = paths.clone;
    const dotgit = join(clone, ".git");
    if (!existsSync(dotgit)) return false;
    // The clone must be a repository of its own before anything is reset in
    // it; the ceiling keeps git from finding the code repository above.
    const top = await git(clone, ["rev-parse", "--show-toplevel"], { via: "recover" });
    if (!top.ok || real(lines(top.stdout)[0] || "") !== real(clone)) throw new StepError(502, `${clone} is not a repository of its own${top.ok ? "" : `: ${top.reason}`}`);
    rmSync(join(dotgit, "index.lock"), { force: true });
    if (existsSync(join(dotgit, "MERGE_HEAD"))) await git(clone, ["merge", "--abort"], { via: "recover" });
    if (existsSync(join(dotgit, "CHERRY_PICK_HEAD")) || existsSync(join(dotgit, "sequencer"))) await git(clone, ["cherry-pick", "--abort"], { via: "recover" });
    await git(clone, ["reset", "--hard", "--quiet"], { need: true, via: "recover" });
    await git(clone, ["clean", "-d", "-x", "--quiet"], { config: { "clean.requireForce": "false" }, need: true, via: "recover" });
    return true;
  }

  const answer = (status, fields) => ({ status, body: { ...fields, write: view ? view() : null } });

  // One step: queued behind this server's others, under the lock for its whole
  // run, after the clone is brought back. `fn` returns { status?, ok?, result?, error? }.
  let queue = Promise.resolve();
  function step(name, fn) {
    const go = async () => {
      let lock;
      try {
        lock = acquire();
      } catch (e) {
        return answer(500, { ok: false, error: `the place ${place} cannot be used: ${e.message}` });
      }
      if (!lock.ok) return answer(409, { ok: false, error: `another process holds ${paths.lock} (${holderText(lock.holder)}); nothing ran. Try again when it is done.` });
      try {
        await proc.askSsh(ctx.vault);
        await recover();
        const r = (await fn({ place, paths })) || {};
        const { status = 200, ...rest } = r;
        return answer(status, { ok: rest.ok ?? status === 200, ...rest });
      } catch (e) {
        if (e instanceof StepError) return answer(e.status, { ok: false, error: e.message });
        return answer(500, { ok: false, error: `${name}: ${e?.message || e}` });
      } finally {
        release();
      }
    };
    const p = queue.then(go, go);
    queue = p.then(() => {}, () => {});
    return p;
  }

  // The only push: refs/heads/<branch> to the same name, for a branch under
  // dashboard/ only, never forced, tags never followed.
  async function pushBatch(branch, { cwd = paths.clone, budget } = {}) {
    if (!isBatchBranch(branch)) return { ok: false, refused: true, reason: `refused: ${JSON.stringify(String(branch))} is not a branch under dashboard/, and nothing was pushed` };
    const r = await git(cwd, ["push", "--porcelain", "--", "origin", `refs/heads/${branch}`], { config: { "push.followTags": "false" }, budget: budget ?? proc.budgets.git, via: PUSHER });
    return { ...r, reason: r.ok ? null : r.reason };
  }

  return {
    anchor,
    person,
    place,
    paths,
    started,
    host,
    budgets: proc.budgets,
    run: proc.run,
    git: proc.git,
    gh: proc.gh,
    cli: proc.cli,
    stop: proc.stop,
    get live() {
      return proc.live;
    },
    get personSsh() {
      return proc.personSsh;
    },
    ceiling: proc.ceiling,
    ensurePlace,
    recover,
    step,
    pushBatch,
  };
}

// The dashboard's write module: the one file of the page's package that starts
// a process or writes a file (the spec "The dashboard's write path: a clone of
// its own, an action as core verbs, a batch sent as one pull request, and a
// server that runs processes only for its own page", alias `dashboard-writes`).
//
// This part holds the process layer (contract 9), the place on disk and the
// clone made whole (contract 2), the clone's configuration and identity
// (contract 3), the refresh and what the page reads (contract 4, as far as
// the module goes), whether the page can write (contract 1), and the step
// lock with its recovery (contract 5). The preview, the action and the
// delivery build on it.
//
//   openWriter({ ctx, project, budgets, record, env, now, platform }) → writer
//     writer.run(cmd, argv, opts)     the only spawn: argv, no shell, its own process group
//     writer.git(cwd, args, opts)     git, `-c` pairs from opts.config, ahead of the subcommand
//     writer.gh(cwd, args, opts)      gh, classified: ok, or unavailable / timed out, with a reason
//     writer.cli(verb, call, opts)    the core's CLI through this Node, `--name=value`, then `--`
//     writer.pushBatch(branch, opts)  the only push: refs/heads/<branch> to the same name, dashboard/ only
//     writer.step(name, fn)           queued, under the place's lock, after recover(); → { status, body }
//     writer.recover()                the clone back at its branch head
//     writer.capability()             the checks made before the place: Windows, repository, origin, identity
//     writer.identity(cwd)            the author and committer git gives in the vault repository
//     writer.makeClone(facts, opts)   git clone into clone.tmp/, renamed to clone/ when git ends with 0
//     writer.syncConfig(facts)        the vault repository's keys and identity, copied into the clone
//     writer.refresh({ start, deadline }) the refresh step: clone, config, fetch, the clone's place; → { status, body }
//     writer.view()                   `write` as the last refresh left it
//     writer.readCtx()                the context the readers take: the clone's while `write.can`, else the bound one
//     writer.writeBindingFolder(prefix) project/.projectstore/projectstore.json, its vault_path in the clone
//     writer.stop()                   ends every running call with its process group
//   anchorOf(dir, opts)               the code repository's main checkout (the core's worktree rule)
//   placePaths(place)                 clone/, clone.tmp/, project/ and the lock file
//
// No hook runs for a call inside the place: each carries
// `-c core.hooksPath=/dev/null`, which beats every configuration scope, so
// neither the person's hooks nor any a template copied into the clone run.
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
// Where a call inside the place looks for hooks: a path under which no file
// can exist, so none runs (contract 3).
export const NO_HOOKS = "/dev/null";
export const WINDOWS_REASON = "writing from the page is not supported on Windows: the page reads the vault and changes nothing";
// The verbs the page may offer (contract 6). The preview and the action fill
// it with `move`; until then a writable vault offers none.
export const WRITE_VERBS = Object.freeze([]);
// The keys the clone copies from the vault repository (contract 3), as git
// prints them: section and name in lower case, a subsection as written. The
// same text is git's pattern (`config --get-regexp`) and this file's.
export const CONFIG_KEYS = /^(core\.sshcommand|ssh\.variant|remote\.origin\.pushurl|commit\.gpgsign|user\.signingkey|gpg\.format|credential\..+|url\..+\.(insteadof|pushinsteadof))$/;
// The identity the vault repository gives, set in the clone so that every
// commit there carries it (git 2.22 and newer read these four).
export const IDENTITY_KEYS = Object.freeze(["author.name", "author.email", "committer.name", "committer.email"]);
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

// Every `<scheme>://user[:password]@` in a text, with the userinfo dropped.
export const redactUrls = (text) => String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");

// A remote URL that is a local path, relative to the repository's top: not
// `<scheme>://…`, not `host:path`, not absolute. → the absolute path, else the URL.
export function absoluteRemote(url, top) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]*:/.test(url) || isAbsolute(url)) return url;
  return resolve(top, url);
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
      // While the group is being ended (the budget ran out, or the server
      // stops), the call settles only once the group is gone: the leader's
      // exit and its pipes' end come first, and on Linux they can come while
      // the rest of its group is still alive (CI, 2026-11-17).
      let ending = null;
      const end = () => (ending ??= endGroup(child?.pid));
      const later = (r) => {
        if (timedOut) return; // the budget's own path settles it
        if (ending) ending.then(() => finish(r));
        else finish(r);
      };
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
      if (child.pid) live.set(child.pid, { end });
      const drained = () => [child.stdout, child.stderr].every((s) => !s || s.readableEnded || s.destroyed);
      for (const [s, into] of [[child.stdout, out], [child.stderr, err]]) {
        if (!s) continue;
        s.setEncoding("utf8");
        s.on("data", (d) => into.push(d));
        s.on("end", () => {
          if (exited && drained()) later(exited);
        });
        s.on("error", () => {});
      }
      child.on("error", (e) => {
        later({ error: e });
        release();
      });
      child.on("exit", (code, signal) => {
        exited = { status: code, signal };
        if (timedOut) return;
        if (drained()) {
          later(exited);
          return;
        }
        drain = setTimeout(() => {
          later(exited);
          release();
        }, DRAIN_MS);
      });
      timer = setTimeout(async () => {
        timedOut = true;
        await end();
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
    const hooks = ceilingFor(cwd) ? ["-c", `core.hooksPath=${NO_HOOKS}`] : [];
    const pairs = Object.entries(config || {}).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
    const r = await run("git", [...hooks, ...pairs, ...args], { cwd, budget, via });
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
    const calls = [...live.entries()];
    for (const [p] of calls) stoppedPids.add(p);
    await Promise.all(calls.map(([, c]) => c.end()));
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
// ms (a Date is taken too): the server's start time in the lock and the
// times in `write` come from it. `platform` is process.platform unless a test
// stands in for Windows: there the writer starts no process and makes no file
// (contract 1), and its anchor is the project itself, never used.
// `beforeBreak(holder)` is a test seam: it runs after a stale holder is read
// and before its lock is moved aside, so a test can stand in for a race.
export async function openWriter({ ctx, project = ctx?.project, budgets = {}, record = null, env = process.env, now = () => Date.now(), platform = process.platform, beforeBreak = null } = {}) {
  if (!ctx || !ctx.lib) throw new Error("openWriter needs the core's context (openCore)");
  const lib = ctx.lib;
  const proc = runner({ budgets, record, env, root: ctx.root });
  const git = proc.git;
  const started = Number(now());
  const host = hostname();
  const windows = platform === "win32";
  // The ssh question first, so the anchor's calls already carry its answer.
  if (!windows) await proc.askSsh(ctx.vault);
  const anchor = windows ? resolve(project) : await anchorWith(proc.git, project);
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
  const busyText = (h) => `another process holds ${paths.lock} (${holderText(h)}); nothing ran. Try again when it is done.`;

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

  // `write` as the last refresh left it (contract 4); a GET never recomputes it.
  const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
  let fetchedAt = null;
  // A reason is shown to anyone who can GET /api/state: no URL in it keeps its
  // userinfo (a token in an insteadOf rewrite, a user:password), git's own words included.
  const closed = (reason) => ({ can: false, reason: redactUrls(reason), verbs: [], default_branch: null, fetched_at: iso(fetchedAt), batch: null });
  let state = closed("the page has not looked at the vault's repository yet");
  // The context the readers take while the page can write; null: the bound one.
  let readable = null;
  const setView = (v) => {
    state = v;
    if (!v.can) readable = null;
    return v;
  };
  const view = () => ({ ...state, verbs: [...state.verbs], batch: state.batch ? { ...state.batch } : null });

  const answer = (status, fields) => ({ status, body: { ...fields, write: view() } });

  // One step: queued behind this server's others, under the lock for its whole
  // run, after the clone is brought back. `fn` returns { status?, ok?, result?, error? }.
  let queue = Promise.resolve();
  function step(name, fn) {
    const go = async () => {
      if (windows) return answer(409, { ok: false, error: WINDOWS_REASON });
      let lock;
      try {
        lock = acquire();
      } catch (e) {
        return answer(500, { ok: false, error: `the place ${place} cannot be used: ${e.message}` });
      }
      if (!lock.ok) return answer(409, { ok: false, error: busyText(lock.holder) });
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

  // ── the vault repository, the clone and the refresh (contracts 1–4) ──

  // git's own words from a failed call: its last `fatal:` or `error:` line,
  // else what the process layer said (a budget, a stop, a missing git).
  const said = (r) => {
    const own = lines(r.stderr).filter((l) => /^(fatal|error):/.test(l)).at(-1);
    return r.timedOut || r.stopped || r.refused || r.missingCwd || !own ? r.reason || String(r.stderr || "").trim() : own;
  };
  // `git config --null` entries: "<key>\n<value>", a key with no value alone.
  const entries = (out) =>
    String(out || "")
      .split("\0")
      .filter((e) => e !== "")
      .map((e) => {
        const i = e.indexOf("\n");
        return i === -1 ? [e, null] : [e.slice(0, i), e.slice(i + 1)];
      });
  // Values by key, in the order git gave them; a key with no value is true.
  const grouped = (list) => {
    const m = new Map();
    for (const [k, v] of list) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(v ?? "true");
    }
    return m;
  };
  // A batch branch's start: its last segment, YYYYMMDDTHHMMSSZ.
  const stampOf = (branch) => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(branch.split("/").pop());
    return m ? iso(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
  };
  const fetchHeadTime = () => {
    try {
      return Math.floor(statSync(join(paths.clone, ".git", "FETCH_HEAD")).mtimeMs);
    } catch {
      return null;
    }
  };

  // The author and committer git gives in `cwd` with user.useConfigOnly, so a
  // guessed identity does not count (contract 1). { ok, author, committer } or { ok: false, reason }.
  async function identity(cwd = ctx.vault) {
    const out = { ok: true };
    for (const [role, name] of [
      ["author", "GIT_AUTHOR_IDENT"],
      ["committer", "GIT_COMMITTER_IDENT"],
    ]) {
      const r = await git(cwd, ["var", name], { config: { "user.useConfigOnly": "true" }, via: "identity" });
      const first = lines(r.stdout)[0] || "";
      const m = r.ok ? /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(first) : null;
      if (!m) return { ok: false, role, reason: `git has no ${role} identity for the page's commits in the vault's repository (${name}: ${r.ok ? `it answered ${JSON.stringify(first)}` : said(r)}). Set user.name and user.email there, and the page can write` };
      out[role] = { name: m[1], email: m[2] };
    }
    return out;
  }

  // The checks made before the place is (contract 1): not Windows, the vault
  // in a git repository, a remote origin there, an identity. The answer holds
  // what the clone needs: the repository's top, the vault's prefix in it, its
  // git common dir, origin's URL, the identity and the keys to copy.
  async function capability() {
    if (windows) return { ok: false, reason: WINDOWS_REASON };
    const loc = await git(ctx.vault, ["rev-parse", "--show-toplevel", "--git-common-dir"], { via: "capability" });
    const [top, common] = lines(loc.stdout);
    if (loc.error?.code === "ENOENT" && !loc.missingCwd) return { ok: false, reason: "git is not installed or not on PATH, so the page cannot write" };
    if (!loc.ok || !top || !common) return { ok: false, reason: `the vault ${ctx.vault} is not in a git repository, so the page cannot write: it reads the vault and changes nothing (${loc.ok ? "git rev-parse named no top" : said(loc)})` };
    // Compared with the clone's, as git prints it (insteadOf rewrites applied);
    // a relative local path is made absolute against the repository's top, as
    // the clone's own origin is.
    const url = await git(ctx.vault, ["remote", "get-url", "--", "origin"], { via: "capability" });
    const shownUrl = url.ok ? lines(url.stdout)[0] || null : null;
    if (!shownUrl) return { ok: false, reason: `the vault's repository ${real(top)} has no remote origin, so a change from the page has nowhere to go` };
    // Cloned from as configured, so the clone's own insteadOf rules rewrite it as the vault repository's do.
    const raw = await git(ctx.vault, ["config", "--get", "--", "remote.origin.url"], { via: "capability" });
    const configured = raw.ok ? lines(raw.stdout)[0] || null : null;
    if (!configured) return { ok: false, reason: `the vault's repository ${real(top)} has no remote.origin.url, so a change from the page has nowhere to go` };
    const who = await identity(ctx.vault);
    if (!who.ok) return { ok: false, reason: who.reason };
    const cfg = await git(ctx.vault, ["config", "--null", "--get-regexp", "--", CONFIG_KEYS.source], { via: "capability" });
    if (!cfg.ok && cfg.status !== 1) return { ok: false, reason: `git cannot read the configuration of the vault's repository: ${said(cfg)}` };
    return {
      ok: true,
      top: real(top),
      prefix: relative(real(top), real(ctx.vault)).split(sep).join("/"),
      commonDir: real(resolve(ctx.vault, common)),
      url: absoluteRemote(shownUrl, real(top)),
      cloneUrl: absoluteRemote(configured, real(top)),
      author: who.author,
      committer: who.committer,
      config: cfg.ok ? entries(cfg.stdout) : [],
    };
  }

  // The clone, made whole (contract 2): into clone.tmp/, which a try that
  // ended early leaves behind and the next one removes first; renamed to
  // clone/ only when git ends with 0. It borrows the vault repository's
  // objects for the download and keeps none borrowed (`--dissociate`), and
  // starts with the keys of contract 3, so its first fetch resolves as the
  // vault repository does.
  async function makeClone(facts, { budget = proc.budgets.clone } = {}) {
    ensurePlace();
    rmSync(paths.cloneTmp, { recursive: true, force: true });
    const keys = facts.config.map(([k, v]) => `--config=${k}=${v ?? "true"}`);
    const r = await git(place, ["clone", "--quiet", `--reference-if-able=${facts.commonDir}`, "--dissociate", ...keys, "--", facts.cloneUrl, paths.cloneTmp], { budget, via: "makeClone" });
    if (!r.ok) {
      rmSync(paths.cloneTmp, { recursive: true, force: true });
      const why = r.timedOut ? `git clone ran past its ${budget} ms budget (is there a network?)` : said(r);
      return { ok: false, reason: `the page's own clone of ${facts.url} could not be made: ${why}. The next refresh tries again` };
    }
    renameSync(paths.cloneTmp, paths.clone);
    fetchedAt = Number(now());
    return { ok: true };
  }

  // The clone resolves as the vault repository does (contract 3): each key of
  // CONFIG_KEYS with the vault repository's values, in its order, and none
  // the vault repository no longer has; the author and committer it gives.
  // Only what differs is written. → the keys written.
  async function syncConfig(facts) {
    const clone = paths.clone;
    const want = grouped(facts.config);
    for (const role of ["author", "committer"]) {
      want.set(`${role}.name`, [facts[role].name]);
      want.set(`${role}.email`, [facts[role].email]);
    }
    const r = await git(clone, ["config", "--local", "--null", "--list"], { need: true, via: "syncConfig" });
    const have = grouped(entries(r.stdout).filter(([k]) => CONFIG_KEYS.test(k) || IDENTITY_KEYS.includes(k)));
    const written = [];
    for (const key of new Set([...want.keys(), ...have.keys()])) {
      const a = want.get(key) || [];
      const b = have.get(key) || [];
      if (a.length === b.length && a.every((v, i) => v === b[i])) continue;
      if (b.length) await git(clone, ["config", "--local", "--unset-all", "--", key], { need: true, via: "syncConfig" });
      for (const v of a) await git(clone, ["config", "--local", "--add", "--", key, v], { need: true, via: "syncConfig" });
      written.push(key);
    }
    return written;
  }

  // The clone's branches that hold commits no remote-tracking ref holds:
  // { ok: true, list } or, when git could not tell, { ok: false, reason }.
  async function unsentBranches() {
    const refs = await git(paths.clone, ["for-each-ref", "--format=%(refname)", "--", "refs/heads/", "refs/remotes/"], { via: "refresh" });
    if (!refs.ok) return { ok: false, reason: said(refs) };
    const all = lines(refs.stdout);
    const remotes = all.filter((x) => x.startsWith("refs/remotes/") && !x.endsWith("/HEAD")).map((x) => `^${x}`);
    const list = [];
    for (const h of all.filter((x) => x.startsWith("refs/heads/"))) {
      const c = await git(paths.clone, ["rev-list", "--count", "--end-of-options", h, ...remotes], { via: "refresh" });
      const n = c.ok ? Number(lines(c.stdout)[0]) : NaN;
      if (!Number.isInteger(n)) return { ok: false, reason: c.ok ? `git rev-list answered ${JSON.stringify(c.stdout.trim())} for ${h}` : said(c) };
      if (n > 0) list.push({ branch: h.slice("refs/heads/".length), commits: n });
    }
    return { ok: true, list };
  }

  // The default branch (contract 1): the clone's refs/remotes/origin/HEAD, else
  // the HEAD line of `ls-remote --symref`, then recorded with `remote set-head`.
  // { name } or { name: null, why }: origin not asked, not reached, or naming no HEAD.
  async function defaultBranch({ network, budget }) {
    // `symbolic-ref` names the target even when it is gone (rev-parse ignores
    // a dangling symref), so a default branch the clone lacks is named as such.
    const sym = await git(paths.clone, ["symbolic-ref", "--quiet", "--", "refs/remotes/origin/HEAD"], { via: "refresh" });
    const full = sym.ok ? lines(sym.stdout)[0] || "" : "";
    if (full.startsWith("refs/remotes/origin/")) return { name: full.slice("refs/remotes/origin/".length) };
    const none = "the clone has no refs/remotes/origin/HEAD";
    if (!network) return { name: null, why: `${none}, and origin was not asked this time (no time was left, or another process holds the lock)` };
    const ls = await git(paths.clone, ["ls-remote", "--symref", "--", "origin", "HEAD"], { budget: budget(), via: "refresh" });
    if (!ls.ok) return { name: null, why: `${none}, and git ls-remote could not reach origin: ${said(ls)}` };
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(ls.stdout);
    if (!m) return { name: null, why: `${none}, and origin's answer to git ls-remote --symref names no HEAD branch` };
    await git(paths.clone, ["remote", "set-head", "--", "origin", m[1]], { via: "refresh" });
    return { name: m[1] };
  }

  // The binding folder (contract 2): project/.projectstore/projectstore.json,
  // the project's binding with vault_path at the vault's place in the clone,
  // the repository-relative prefix included. Written only when it is absent
  // or differs; with `onlyIfAbsent` (no lock held) only when it is absent.
  function writeBindingFolder(prefix = "", { onlyIfAbsent = false } = {}) {
    const vaultPath = prefix ? join(paths.clone, ...prefix.split("/")) : paths.clone;
    const file = lib.layoutPaths(paths.binding).binding;
    const raw = lib.readConfigAt(ctx.project);
    const binding = { ...(raw && typeof raw === "object" ? raw : ctx.cfg), vault_path: vaultPath };
    const text = `${JSON.stringify(binding, null, 2)}\n`;
    let was = null;
    try {
      was = readFileSync(file, "utf8");
    } catch {}
    if (was === null || (!onlyIfAbsent && was !== text)) {
      mkdirSync(dirname(file), { recursive: true });
      lib.writeFileAtomic(file, text);
    }
    return { dir: paths.binding, file, vault_path: vaultPath };
  }

  // What a refresh does with the clone, under the lock (contracts 1–4). With
  // `inspect` (another process holds the lock at the start) it makes, copies,
  // fetches and moves nothing, and computes `write` from the clone as it is.
  // `deadline` (ms, this machine's clock): past it no call that uses the
  // network starts, and one running ends at it.
  async function update(facts, { deadline = null, inspect = false } = {}) {
    const clone = paths.clone;
    const left = () => (deadline === null || deadline === undefined ? Infinity : Number(deadline) - Date.now());
    const within = (b) => Math.max(1, Math.min(b, left()));
    let fresh = false;
    if (!existsSync(clone)) {
      if (inspect) return setView(closed(`another process holds ${paths.lock}, and the page has no clone of its own yet: it reads the bound checkout`));
      if (left() <= 0) return setView(closed("the page's own clone is not made yet: the start's time ran out first. The next refresh makes it"));
      const made = await makeClone(facts, { budget: within(proc.budgets.clone) });
      if (!made.ok) return setView(closed(made.reason));
      fresh = true;
    }
    if (!inspect) await syncConfig(facts);
    const got = await git(clone, ["remote", "get-url", "--", "origin"], { via: "refresh" });
    const printed = got.ok ? lines(got.stdout)[0] || null : null;
    const theirs = printed && absoluteRemote(printed, clone);
    if (theirs !== facts.url) {
      const unsent = await unsentBranches();
      const held = !unsent.ok
        ? `Its branches could not be checked for commits not sent (${unsent.reason}); keep the clone until they are.`
        : unsent.list.length
          ? `Its branches that hold commits not sent: ${unsent.list.map((b) => `${b.branch} (${b.commits})`).join(", ")}.`
          : "No branch in it holds a commit that was not sent.";
      return setView(closed(`the page's clone at ${clone} has origin ${theirs ?? "(none)"}, but the vault's repository has origin ${facts.url}, so the page writes nothing. ${held} Move the clone aside, and the next refresh makes a new one`));
    }
    if (fetchedAt === null) fetchedAt = fetchHeadTime();
    if (!inspect && !fresh && left() > 0) {
      const f = await git(clone, ["fetch", "--quiet", "--", "origin"], { budget: within(proc.budgets.git), via: "refresh" });
      if (f.ok) fetchedAt = Number(now());
    }
    const known = await defaultBranch({ network: !inspect && left() > 0, budget: () => within(proc.budgets.git) });
    if (!known.name) return setView(closed(`no default branch is known: ${known.why}`));
    const d = known.name;
    const base = `refs/remotes/origin/${d}`;
    const there = await git(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { via: "refresh" });
    if (!there.ok) return setView(closed(`the default branch ${d} is not there in the clone (${base}); the next refresh that reaches origin fetches it. The page reads the bound checkout`));
    const holds = await git(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}:${facts.prefix}`], { via: "refresh" });
    if (!holds.ok) return setView(closed(`the default branch ${d} does not hold the vault's folder ${facts.prefix || "(the repository's top)"}: its repository may ignore it, or it was never pushed. The page reads the bound checkout`));
    const head = await git(clone, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", "HEAD"], { need: true, via: "refresh" });
    const ref = lines(head.stdout)[0] || "HEAD";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    let batch = null;
    if (branch && branch.startsWith(`dashboard/${person}/`) && isBatchBranch(branch)) {
      // An open batch: the clone stays where it is.
      const c = await git(clone, ["rev-list", "--count", "--end-of-options", `${base}..HEAD`], { need: true, via: "refresh" });
      batch = { branch, started_at: stampOf(branch), commits: Number(lines(c.stdout)[0]) || 0 };
    } else if (!inspect) {
      await git(clone, ["switch", "--detach", "--quiet", "--", base], { need: true, via: "refresh" });
    }
    const bound = writeBindingFolder(facts.prefix, { onlyIfAbsent: inspect });
    readable = { ...ctx, cfg: { ...ctx.cfg, vault_path: bound.vault_path }, vault: bound.vault_path, binding: paths.binding, shown: { project: ctx.project, vault: ctx.vault } };
    return setView({ can: true, reason: null, verbs: [...WRITE_VERBS], default_branch: d, fetched_at: iso(fetchedAt), batch });
  }

  // The refresh step (contract 4). The checks of capability() run first, so a
  // vault that fails one gets no file; then, under the lock, the clone is made
  // when there is none, its configuration copied, origin fetched, and the
  // clone put at the fetched default branch (detached) unless a batch is open.
  // `start`: the server's own refresh before its ready line; when another
  // process holds the lock then, `write` is computed from the clone as it is.
  // `deadline`: see update(). → { status, body } like every step.
  async function refresh({ start = false, deadline = null } = {}) {
    if (windows) {
      setView(closed(WINDOWS_REASON));
      return answer(200, { ok: true, result: null });
    }
    // Held by another live process: a refresh asked for runs nothing (contract 5).
    const holder = readLock();
    if (holder && !breakable(holder) && !start) return answer(409, { ok: false, error: busyText(holder) });
    const facts = await capability();
    if (!facts.ok) {
      setView(closed(facts.reason));
      return answer(200, { ok: true, result: null });
    }
    const r = await step("refresh", async () => {
      await update(facts, { deadline });
      return { result: null };
    });
    if (r.status === 409 && start) {
      try {
        await update(facts, { inspect: true });
      } catch {}
      return { ...r, body: { ...r.body, write: view() } };
    }
    return r;
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
    capability,
    identity,
    makeClone,
    syncConfig,
    refresh,
    view,
    readCtx: () => readable ?? ctx,
    writeBindingFolder,
  };
}

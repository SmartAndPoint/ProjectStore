// The dashboard's write module: the one file of the page's package that starts
// a process or writes a file (the spec "The dashboard's write path: a clone of
// its own, an action as core verbs, a batch sent as one pull request, and a
// server that runs processes only for its own page", alias `dashboard-writes`).
//
// This part holds the process layer (contract 9), the place on disk and the
// clone made whole (contract 2), the clone's configuration and identity
// (contract 3), the refresh and what the page reads (contract 4, as far as
// the module goes), whether the page can write (contract 1), and the step
// lock with its recovery (contract 5), the preview (contract 6) and the
// action, one commit or nothing (contract 7). The delivery builds on it: the
// spec "The dashboard's delivery: Send, Discard, the pull request's state,
// the carry and kept branches" (alias `dashboard-delivery`), whose pull
// request's state (contract 1), Send (contract 2) and its title and body
// (contract 3), Discard (contract 4), the carry (contract 5) and the kept
// branches as `write.kept` lists them (contract 6) live here.
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
//     writer.preview({ verb, fields }) the verb's plan for the clone, without --write (contract 6); → { status, body }
//     writer.action({ verb, fields })  the verb with --write, then one commit on the batch branch, or nothing (contract 7)
//     writer.askState(branch, opts)   `gh pr list` for a batch branch (or the `none` probe): { ok, list } or { ok: false, missing, reason }
//     writer.send()                   Send (delivery contract 2): the state, the remote branch merged, the push, the pull request
//     writer.discard()                Discard (delivery contract 4): the state, `gh pr close` for an open one, the batch ended, its branch kept
//     writer.view()                   `write` as the last step left it
//     writer.readCtx()                the context the readers take: the clone's while `write.can`, else the bound one
//     writer.writeBindingFolder(prefix) project/.projectstore/projectstore.json, its vault_path in the clone
//     writer.stop()                   ends every running call with its process group
//   anchorOf(dir, opts)               the code repository's main checkout (the core's worktree rule)
//   placePaths(place)                 clone/, clone.tmp/, project/ and the lock file
//   WRITE_VERBS, VERB_ARGV            the verbs the page may offer, their fields, how each reaches the CLI
//   checkRequest(body, verbs)         a preview's or an action's { verb, fields }, checked before any process
//   substitutePaths(value, pairs)     the clone's and the binding folder's paths, as the person knows them
//   decide(list)                      of a branch's pull requests, the one that decides: open, then merged, then the newest
//   prText(subjects)                  a batch's pull request title and body (delivery contract 3)
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
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
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
export const RECORDED_ENV = Object.freeze(["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "SSH_ASKPASS_REQUIRE", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_CEILING_DIRECTORIES", "GH_PROMPT_DISABLED", "GH_REPO", "GH_HOST"]);
// What every gh call adds: no question asked (gh's own switch, beside the
// long-form options that leave it nothing to ask), and no look for a newer gh.
export const GH_ENV = Object.freeze({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });
// What would point a gh call at a repository or a host other than the
// clone's origin: removed, so gh finds both from the clone's remote. The
// tokens (GH_TOKEN, GH_ENTERPRISE_TOKEN and the like) stay: they say who
// asks, not where, and without them a person logged in that way is not.
export const GH_LOCATING_ENV = Object.freeze(["GH_REPO", "GH_HOST"]);

export const LOCK_FILE = "projectstore-dashboard.lock";
// Where a call inside the place looks for hooks: a path under which no file
// can exist, so none runs (contract 3).
export const NO_HOOKS = "/dev/null";
export const WINDOWS_REASON = "writing from the page is not supported on Windows: the page reads the vault and changes nothing";
// The verbs the page may offer (contract 6): only verbs of the core that have
// a plan mode (bare, the plan; `--write`, the change), each under its own rule
// that a `--write` with no terminal is the confirmation. A writable vault
// shows this list in `write.verbs`, and the page draws each verb's dialog from
// its entry (contract 10): `label` names the verb, `subject` is the commit's
// subject with `{name}` for a field's value, and each field has a kind and a
// label (a `choice` labels each value; a `person` the page fills from the
// story carries `filled` and no `max`).
const freezeDeep = (v) => {
  if (v && typeof v === "object") for (const x of Object.values(v)) freezeDeep(x);
  return Object.freeze(v);
};
export const WRITE_VERBS = freezeDeep([
  {
    verb: "move",
    label: "Move",
    subject: "move {story} to {to}: {reason}",
    fields: {
      story: { kind: "story", form: "<EPIC>/<id>", label: "Story" },
      to: {
        kind: "choice",
        label: "To",
        values: [
          { value: "todo", label: "Move to ToDo" },
          { value: "planned", label: "Back to Backlog" },
        ],
      },
      reason: { kind: "line", max: 200, label: "Why, in one line" },
    },
  },
  {
    verb: "handover",
    label: "Hand over",
    subject: "hand over {story} from {from} to {to}: {reason}",
    fields: {
      story: { kind: "story", form: "<EPIC>/<id>", label: "Story" },
      from: { kind: "person", filled: "assignee", label: "From" },
      to: { kind: "person", max: 100, label: "To" },
      reason: { kind: "line", max: 200, label: "Why, in one line" },
    },
  },
  // A reorder of the backlog tree (the spec dashboard-rank, contract 10): the
  // page offers it by a drop or a key, never by a button, and it takes no
  // reason. Exactly one of story and epic, and one of before and after.
  {
    verb: "rank",
    label: "Reorder",
    subject: ["rank {story} before {before}", "rank {story} after {after}", "rank {epic} before {before}", "rank {epic} after {after}"],
    fields: {
      story: { kind: "story", form: "<EPIC>/<id>", label: "Story", optional: true },
      epic: { kind: "epic", form: "<EPIC-ID>", label: "Epic", optional: true },
      before: { kind: "sibling", label: "Before", optional: true },
      after: { kind: "sibling", label: "After", optional: true },
    },
    one_of: [
      ["story", "epic"],
      ["before", "after"],
    ],
  },
]);
// How each verb's fields reach the core's CLI: positionals after `--`, options
// as `--name=value`. `word` names fields of which the one a request gives
// reaches the CLI as that literal word of the verb's form, then its value,
// before the positionals (`rank story <EPIC>/<id>`). The table-vs-core test
// holds these against the core's own verb table.
export const VERB_ARGV = freezeDeep({
  move: { positionals: ["story", "to"], options: ["reason"] },
  handover: { positionals: [], options: ["story", "from", "to", "reason"] },
  rank: { word: ["story", "epic"], positionals: [], options: ["before", "after"] },
});
// The positionals a checked request gives the CLI: the literal word and its
// value first, when the verb has one, then the positionals in order.
export function positionalsOf(req, argv = VERB_ARGV) {
  const call = argv[req.verb];
  const word = (call.word || []).find((k) => Object.hasOwn(req.fields, k));
  return [...(word ? [word, req.fields[word]] : []), ...call.positionals.map((k) => req.fields[k])];
}
// The commit's subject for a checked request (contract 7): the entry's
// template with each `{name}` replaced once by that field's value, so a value
// that holds `{to}` stays as typed.
export function subjectOf(req, verbs = WRITE_VERBS) {
  const entry = verbs.find((v) => v && v.verb === req.verb);
  // A list of templates: the first whose every {name} is a field the request gives.
  const given = (s) => [...s.matchAll(/\{([a-z_]+)\}/g)].every((m) => Object.hasOwn(req.fields, m[1]));
  const list = entry && Array.isArray(entry.subject) ? entry.subject.filter((s) => typeof s === "string") : [];
  const template = entry && typeof entry.subject === "string" ? entry.subject : list.find(given) || `${req.verb} {story}`;
  return template.replace(/\{([a-z_]+)\}/g, (m, name) => (Object.hasOwn(req.fields, name) ? String(req.fields[name]) : m));
}
// One line: the class the core's `--reason` refuses (status-log.mjs oneLine).
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
// `<EPIC>/<id>`: the shape only; the core resolves the story.
const STORY_REF = /^[\p{L}\p{N}][\p{L}\p{N}._-]*\/[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
// `<EPIC-ID>`: an epic folder's name, the shape only.
export const EPIC_REF = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

// A preview's or an action's request, checked against `verbs` before any
// process starts (contract 6): { ok, verb, fields } with each value as the
// core gets it, or { ok: false, error }. A verb or a field outside the list,
// a missing field, or a value outside its kind is refused.
export function checkRequest(body, verbs = WRITE_VERBS) {
  const no = (error) => ({ ok: false, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return no("the request's body is no JSON object");
  const extra = Object.keys(body).filter((k) => k !== "verb" && k !== "fields");
  if (extra.length) return no(`the request names ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a request does not take: it takes verb and fields`);
  const entry = verbs.find((v) => v && v.verb === body.verb);
  const names = verbs.map((v) => v.verb);
  if (typeof body.verb !== "string" || !entry) return no(`${JSON.stringify(body.verb ?? null)} is not a verb the page may run (write.verbs: ${names.length ? names.join(", ") : "none"})`);
  const given = body.fields;
  if (!given || typeof given !== "object" || Array.isArray(given)) return no(`${entry.verb} takes its fields as an object: ${Object.keys(entry.fields).join(", ")}`);
  const outside = Object.keys(given).filter((k) => !Object.hasOwn(entry.fields, k));
  if (outside.length) return no(`${outside.map((k) => JSON.stringify(k)).join(", ")} is not a field of ${entry.verb} (its fields: ${Object.keys(entry.fields).join(", ")})`);
  // Of each one_of group, a request gives exactly one field.
  for (const group of entry.one_of || []) {
    const there = group.filter((k) => given[k] !== undefined);
    if (there.length !== 1) return no(`${entry.verb} takes exactly one of ${group.join(", ")}; the request gives ${there.length ? there.join(" and ") : "none"}`);
  }
  // A sibling is named in the form of the item the request gives.
  const itemKind = given.story !== undefined ? entry.fields.story : given.epic !== undefined ? entry.fields.epic : null;
  const fields = {};
  for (const [name, kind] of Object.entries(entry.fields)) {
    const v = given[name];
    if (v === undefined && kind.optional) continue;
    if (typeof v !== "string") return no(`${entry.verb} needs ${name} as text`);
    if (kind.kind === "epic" || (kind.kind === "sibling" && itemKind?.kind === "epic")) {
      if (!EPIC_REF.test(v)) return no(`${name} names an epic as <EPIC-ID>, such as PS-CORE; ${JSON.stringify(v)} is not that`);
      fields[name] = v;
    } else if (kind.kind === "story" || kind.kind === "sibling") {
      if (!STORY_REF.test(v)) return no(`${name} names a story as ${kind.form || itemKind?.form || "<EPIC>/<id>"}, such as PS-CORE/story-x; ${JSON.stringify(v)} is not that`);
      fields[name] = v;
    } else if (kind.kind === "choice") {
      const values = kind.values.map((x) => (x && typeof x === "object" ? x.value : x));
      if (!values.includes(v)) return no(`${name} is one of ${values.join(", ")}, not ${JSON.stringify(v)}`);
      fields[name] = v;
    } else if (kind.kind === "person") {
      const t = v.trim();
      if (!t) return no(`${name} is empty: name a person`);
      if (CONTROL.test(t)) return no(`${name} must be one name on one line, with no line break or control character`);
      const n = [...t].length;
      if (kind.max && n > kind.max) return no(`${name} is ${n} characters long; a name takes at most ${kind.max}`);
      fields[name] = t;
    } else if (kind.kind === "line") {
      const t = v.trim();
      if (!t) return no(`${name} is empty: say in one line why`);
      if (CONTROL.test(t)) return no(`${name} must be one line, with no line break or control character`);
      // Counted in characters (code points), after the trim.
      const n = [...t].length;
      if (kind.max && n > kind.max) return no(`${name} is ${n} characters long; it takes at most ${kind.max}: say it in a shorter line`);
      fields[name] = t;
    } else return no(`${name} has a kind the page does not know: ${kind.kind}`);
  }
  return { ok: true, verb: entry.verb, fields };
}

// The paths of a core verb's answer as the person knows them (contract 6):
// each `from` (longest first) followed by no further name character becomes
// its `to`, in every string of `value`. A dot continues the name only when a
// name character follows it (`clone.tmp`); a dot that ends a sentence does
// not. Values that are not text stay.
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
export function substitutePaths(value, pairs) {
  const list = pairs.filter(([from]) => from).sort((a, b) => b[0].length - a[0].length);
  if (!list.length) return value;
  const to = new Map(list);
  const re = new RegExp(`(${list.map(([from]) => from.replace(ESCAPE, "\\$&")).join("|")})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_.-])`, "gu");
  const walk = (v) => {
    if (typeof v === "string") return v.replace(re, (m) => to.get(m));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// A batch branch's last segment for a time in ms: YYYYMMDDTHHMMSSZ.
export const stampFor = (ms) => new Date(Math.floor(Number(ms) / 1000) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// The fields `gh pr list` is asked for (delivery contract 1).
export const PR_FIELDS = "number,state,headRefOid,url";
// Of one branch's pull requests, the one that decides (delivery contract 1):
// an open one, then a merged one, then the newest (the highest number). null
// for none. Its state in upper case, as gh gives it.
export function decide(list) {
  const prs = (Array.isArray(list) ? list : []).filter((p) => p && typeof p === "object" && Number.isInteger(p.number)).map((p) => ({ ...p, state: String(p.state ?? "").toUpperCase() }));
  const newest = (xs) => xs.reduce((a, b) => (!a || b.number > a.number ? b : a), null);
  return newest(prs.filter((p) => p.state === "OPEN")) ?? newest(prs.filter((p) => p.state === "MERGED")) ?? newest(prs);
}

// A batch's pull request text (delivery contract 3), from its commits'
// subjects, oldest first: the subject for a batch of one, else the count;
// the body lists every subject and ends with the line that names the page.
export const SENT_LINE = "Sent from projectstore dashboard.";
export const TITLE_MAX = 250;
export function prText(subjects) {
  const list = subjects.map(String);
  const whole = list.length === 1 ? list[0] : `Backlog changes from the dashboard (${list.length})`;
  // A code host limits a title (about 256 on GitHub): past TITLE_MAX code
  // points the title is cut and ends with `…`, and the body keeps the whole
  // subject (delivery contract 3).
  const points = [...whole];
  const title = points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX - 1).join("")}…` : whole;
  return { title, body: [...list.map((s) => `- ${s}`), "", SENT_LINE].join("\n") };
}

// The session and project variables of every harness manifest under the
// core's `harnesses/` (runtime.session_id_env, runtime.project_dir_env).
function manifestVars(root) {
  const out = { session: [], project: [] };
  let names = [];
  try {
    names = readdirSync(join(root, "harnesses")).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(root, "harnesses", n), "utf8"))?.runtime || {};
      if (typeof r.session_id_env === "string" && r.session_id_env) out.session.push(r.session_id_env);
      if (typeof r.project_dir_env === "string" && r.project_dir_env) out.project.push(r.project_dir_env);
    } catch {}
  }
  return out;
}
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
  // The core's CLI points at the project it is given, never at a session's
  // (contract 7; the clone ADR, decision 4): no session id, so no session's
  // record of writes takes the page's writes; no neutral project variable; and
  // each harness's project variable that is set names that project too. One
  // that is not set stays unset, so no harness reads as having started the call.
  const vars = root ? manifestVars(root) : { session: [], project: [] };
  const forCore = (project) => (e) => {
    for (const k of ["PROJECTSTORE_PROJECT_DIR", ...vars.session]) delete e[k];
    for (const k of vars.project) if (e[k] !== undefined) e[k] = project;
    return e;
  };
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
  function run(cmd, argv, { cwd = process.cwd(), budget = B.git, via = null, edit = null } = {}) {
    const why = stopped ? "the server is stopping" : refusal(cmd, argv, via);
    if (why) return Promise.resolve({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error(why), { code: "EREFUSED" }), refused: true, timedOut: false, stopped: false, missingCwd: false, pid: null });
    const callEnv = edit ? edit(envFor(cwd)) : envFor(cwd);
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
  // `need` makes a failure the step's 502 (contract 8); `literal` reads every
  // pathspec as the path it is (`--literal-pathspecs`, ahead of the subcommand).
  async function git(cwd, args, { config = null, budget = B.git, need = false, via = "git", literal = false } = {}) {
    const hooks = ceilingFor(cwd) ? ["-c", `core.hooksPath=${NO_HOOKS}`] : [];
    const pairs = Object.entries(config || {}).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
    const r = await run("git", [...hooks, ...pairs, ...(literal ? ["--literal-pathspecs"] : []), ...args], { cwd, budget, via });
    r.ok = r.status === 0;
    if (!r.ok) {
      r.reason = failure("git", args[0], r, budget);
      if (need) throw new StepError(502, r.reason);
    }
    return r;
  }

  // gh in `cwd`: { ok, stdout } or { ok: false, unavailable, timedOut, reason }.
  // Missing from PATH (also `missing`) and logged out (exit 4) are `unavailable`.
  async function gh(cwd, args, { budget = B.gh, via = "gh" } = {}) {
    const edit = (e) => {
      for (const k of GH_LOCATING_ENV) delete e[k];
      return Object.assign(e, GH_ENV);
    };
    const r = await run("gh", args, { cwd, budget, via, edit });
    const sub = args.slice(0, 2).join(" ");
    if (r.status === 0) return { ok: true, stdout: r.stdout, stderr: r.stderr, pid: r.pid };
    const first = String(r.stderr || "").trim().split("\n")[0].trim();
    if (r.refused) return { ok: false, unavailable: false, timedOut: false, refused: true, reason: failure("gh", sub, r, budget) };
    if (r.missingCwd) return { ok: false, unavailable: false, timedOut: false, reason: failure("gh", sub, r, budget) };
    if (r.error?.code === "ENOENT") return { ok: false, unavailable: true, missing: true, timedOut: false, reason: "gh is not installed or not on PATH" };
    if (r.timedOut) return { ok: false, unavailable: false, timedOut: true, reason: failure("gh", sub, r, budget) };
    if (r.status === AUTH_EXIT) return { ok: false, unavailable: true, timedOut: false, reason: first || "gh is not logged in (exit 4)" };
    return { ok: false, unavailable: false, timedOut: false, reason: first || failure("gh", sub, r, budget) };
  }

  // The core's CLI through this Node: `<verb> --name=value… -- <positionals>`.
  // `true` is a bare `--name`; false, null and undefined are left out. The
  // answer adds `envelope`, the parsed `--json` output when there is one. Its
  // environment names `options.project` (else `cwd`) as above, and no session.
  async function cli(verb, { options = {}, positionals = [], cwd = process.cwd() } = {}, { budget = B.verb, need = false, via = "cli" } = {}) {
    if (!root) throw new Error("no core root to run the CLI from");
    const opts = Object.entries(options).flatMap(([k, v]) => (v === true ? [`--${k}`] : v === false || v === null || v === undefined ? [] : [`--${k}=${v}`]));
    const argv = [join(root, "bin", "projectstore.mjs"), verb, ...opts, "--", ...positionals.map(String)];
    const project = typeof options.project === "string" ? options.project : resolve(cwd);
    const r = await run(process.execPath, argv, { cwd, budget, via, edit: forCore(project) });
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
  // `pull_requests` (delivery contract 1): null while gh answers (and before
  // it is asked), else why it cannot be asked. `kept` (delivery contract 6):
  // the person's batch branches the clone has not checked out, each
  // { branch, commits, stopped_at? } (see keptOf).
  const closed = (reason) => ({ can: false, reason: redactUrls(reason), verbs: [], default_branch: null, fetched_at: iso(fetchedAt), batch: null, pull_requests: null, kept: [] });
  const initial = closed("the page has not looked at the vault's repository yet");
  let state = initial;
  // The context the readers take while the page can write; null: the bound one.
  let readable = null;
  // What the last refresh that could write found: the vault's prefix in its
  // repository, the repository's top, the default branch. null while it cannot.
  let known = null;
  const setView = (v) => {
    state = v;
    if (!v.can) {
      readable = null;
      known = null;
    }
    return v;
  };
  const view = () => ({
    ...state,
    verbs: [...state.verbs],
    batch: state.batch ? { ...state.batch, pull_request: state.batch.pull_request ? { ...state.batch.pull_request } : null } : null,
    kept: state.kept.map((k) => (k.stopped_at ? { ...k, stopped_at: { ...k.stopped_at } } : { ...k })),
  });

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
    // Whether this step has the default branch as just fetched (a carry
    // starts only from it): a clone made now has it.
    let fetched = fresh ? { ok: true } : { ok: false, reason: "the start's time ran out before git fetch could run" };
    if (!inspect && !fresh && left() > 0) {
      const f = await git(clone, ["fetch", "--quiet", "--", "origin"], { budget: within(proc.budgets.git), via: "refresh" });
      if (f.ok) fetchedAt = Number(now());
      fetched = f.ok ? { ok: true } : { ok: false, reason: `git fetch of origin failed: ${said(f)}` };
    }
    const def = await defaultBranch({ network: !inspect && left() > 0, budget: () => within(proc.budgets.git) });
    if (!def.name) return setView(closed(`no default branch is known: ${def.why}`));
    const d = def.name;
    const base = `refs/remotes/origin/${d}`;
    const there = await git(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { via: "refresh" });
    if (!there.ok) return setView(closed(`the default branch ${d} is not there in the clone (${base}); the next refresh that reaches origin fetches it. The page reads the bound checkout`));
    const holds = await git(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}:${facts.prefix}`], { via: "refresh" });
    if (!holds.ok) return setView(closed(`the default branch ${d} does not hold the vault's folder ${facts.prefix || "(the repository's top)"}: its repository may ignore it, or it was never pushed. The page reads the bound checkout`));
    // An open batch: the clone stays where it is, unless the pull request's
    // state ends it (delivery contract 1), a merge with the carry of delivery
    // contract 5, from the default branch this step just fetched. The
    // question is no step's failure, and past the deadline it is not asked; a
    // carry that has begun runs to its end, and one whose pull request's head
    // the clone lacks does not begin past the deadline.
    let { batch } = await batchOn(base, "refresh");
    let detached = false;
    if (!inspect && left() > 0) {
      const asked = await askState(batch ? batch.branch : null, { budget: within(proc.budgets.gh), via: "refresh" });
      if (batch) ({ batch, detached } = await settle(batch, asked, base, "refresh", { fetched, network: () => left() > 0, budget: within }));
    }
    if (!batch && !inspect && !detached) await git(clone, ["switch", "--detach", "--quiet", "--", base], { need: true, via: "refresh" });
    const kept = await keptOf(base, batch ? batch.branch : null, "refresh");
    const bound = writeBindingFolder(facts.prefix, { onlyIfAbsent: inspect });
    readable = { ...ctx, cfg: { ...ctx.cfg, vault_path: bound.vault_path }, vault: bound.vault_path, binding: paths.binding, shown: { project: ctx.project, vault: ctx.vault } };
    setView({ can: true, reason: null, verbs: [...WRITE_VERBS], default_branch: d, fetched_at: iso(fetchedAt), batch, pull_requests: pullRequests, kept });
    known = { prefix: facts.prefix, top: facts.top, base, vaultPath: bound.vault_path };
    return state;
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
    // A refresh that failed before it ever looked says so, not that it has
    // not looked yet; a later one leaves `write` as the last one left it.
    if (r.status >= 500 && state === initial) {
      setView(closed(`the refresh failed: ${r.body.error}. The page reads the bound checkout; the next refresh tries again`));
      return { ...r, body: { ...r.body, write: view() } };
    }
    return r;
  }

  // ── the preview and the action (contracts 6 and 7) ──

  // The clone's paths in a verb's answer, as the person knows them: the
  // binding folder is the project, the vault in the clone is the bound vault,
  // and the rest of the clone the vault's repository.
  const shown = (value) => {
    if (!known) return value;
    const pairs = [];
    const both = (from, to) => {
      pairs.push([from, to]);
      const r = real(from);
      if (r !== from) pairs.push([r, to]);
    };
    both(known.vaultPath, ctx.vault);
    both(paths.binding, resolve(project));
    both(paths.clone, known.top);
    return substitutePaths(value, pairs);
  };

  // The clone back at HEAD, the derived views and whatever a verb left included.
  async function restore(via) {
    await git(paths.clone, ["reset", "--hard", "--quiet"], { need: true, via });
    await git(paths.clone, ["clean", "-d", "-x", "--quiet"], { config: { "clean.requireForce": "false" }, need: true, via });
  }

  // One verb through the core's CLI, pointed at the clone by the binding
  // folder (rewritten first), with `--json`, and `--write` for an action.
  // → { status, ok, result?, error? }: 200 when the verb ran (ok: false when
  // it refused), 400 for its usage error, 502 when it ran past its budget.
  async function runVerb(req, { write, via }) {
    writeBindingFolder(known.prefix);
    const call = VERB_ARGV[req.verb];
    const options = { project: paths.binding, json: true, write: write || null };
    for (const k of call.options) options[k] = req.fields[k];
    const r = await proc.cli(req.verb, { options, positionals: positionalsOf(req), cwd: paths.binding }, { need: true, via });
    const env = r.envelope;
    if (!env || typeof env !== "object" || !("result" in env)) {
      const said = String(r.stderr || "").trim().split("\n")[0] || `it exited ${r.status} with no answer`;
      return { status: 500, ok: false, error: shown(`projectstore ${req.verb} gave no --json answer: ${said}`) };
    }
    const result = shown(env.result);
    const message = result && typeof result === "object" && typeof result.error === "string" ? result.error : null;
    // Exit 2 is the core's usage error, and also its catch-all for a failure
    // it did not expect, which says "<verb> failed:" on stderr: that one is
    // no usage error of the page's, so it answers 500.
    if (r.status === 2 && String(r.stderr || "").trimStart().startsWith(`${req.verb} failed:`)) return { status: 500, ok: false, result, error: `projectstore ${req.verb} failed inside the core: ${message || shown(String(r.stderr).trim())}` };
    if (r.status === 2) return { status: 400, ok: false, result, error: message || `projectstore ${req.verb}: usage error` };
    if (r.status !== 0 || env.ok !== true) return { status: 200, ok: false, result, error: message || `projectstore ${req.verb} exited ${r.status}` };
    return { status: 200, ok: true, result };
  }

  // A request checked before the step (contract 6): 409 while the page cannot
  // write, 400 for a verb or field outside write.verbs; no process starts.
  const refused = (body) => {
    if (!state.can) return answer(409, { ok: false, error: state.reason });
    const req = checkRequest(body, state.verbs);
    return req.ok ? { req } : answer(400, { ok: false, error: req.error });
  };

  // The preview (contract 6): the verb's own plan for the clone, without
  // `--write`; the clone's HEAD and working tree stay as they were.
  async function preview(body) {
    const pre = refused(body);
    if (!pre.req) return pre;
    return step("preview", async () => {
      if (!state.can || !known) return { status: 409, ok: false, error: state.reason };
      return runVerb(pre.req, { write: false, via: "preview" });
    });
  }

  // The batch the clone's HEAD is on, or null: { branch, started_at, commits,
  // pull_request }, `commits` counting what `base` lacks, `pull_request` as
  // last asked (delivery contract 1).
  async function batchOn(base, via) {
    const head = await git(paths.clone, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", "HEAD"], { need: true, via });
    const ref = lines(head.stdout)[0] || "HEAD";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    if (!branch || !branch.startsWith(`dashboard/${person}/`) || !isBatchBranch(branch)) return { branch, batch: null };
    const c = await git(paths.clone, ["rev-list", "--count", "--end-of-options", `${base}..HEAD`], { need: true, via });
    return { branch, batch: { branch, started_at: stampOf(branch), commits: Number(lines(c.stdout)[0]) || 0, pull_request: prFor(branch) } };
  }
  const batchAt = (via) => batchOn(known.base, via);

  // A batch branch for now that the clone does not have yet: the same second
  // taken, the next free one (an action, a Discard and an action in one second).
  async function freeBranch(via) {
    let t = Number(now());
    for (let i = 0; i < 3600; i++, t += 1000) {
      const name = `dashboard/${person}/${stampFor(t)}`;
      const there = await git(paths.clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${name}`], { via });
      if (!there.ok) return name;
    }
    throw new StepError(500, `no free batch branch name under dashboard/${person}/ for the hour after ${iso(Number(now()))}`);
  }

  // What the verb changed in the clone, repository-relative (no renames).
  async function changedPaths(via) {
    const st = await git(paths.clone, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { need: true, via });
    return String(st.stdout || "")
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3));
  }

  // The action (contract 7): the verb with `--write`. When it exits 0 and
  // changed a path outside derivedViewPaths(layout), exactly those paths,
  // staged by name, become one commit; the first with no open batch starts
  // the batch on dashboard/<person>/<YYYYMMDDTHHMMSSZ>: committed on the
  // detached HEAD, then `switch --create`. The derived views go back to the
  // branch head. A verb that refuses or fails, and a commit git refuses, leave
  // HEAD and the working tree as they were and no batch branch behind.
  async function action(body) {
    const pre = refused(body);
    if (!pre.req) return pre;
    const req = pre.req;
    return step("action", async () => {
      if (!state.can || !known) return { status: 409, ok: false, error: state.reason };
      const via = "action";
      const clone = paths.clone;
      const at = await batchAt(via);
      // HEAD on a branch that is no batch of this person's: detached, so no
      // other branch takes the commit.
      if (at.branch && !at.batch) await git(clone, ["switch", "--detach", "--quiet", "--", "HEAD"], { need: true, via });
      const before = lines((await git(clone, ["rev-parse", "--verify", "--end-of-options", "HEAD"], { need: true, via })).stdout)[0];
      let ran;
      try {
        ran = await runVerb(req, { write: true, via });
      } catch (e) {
        await restore(via).catch(() => {});
        throw e;
      }
      if (!ran.ok) {
        await restore(via);
        return ran;
      }
      const views = lib.derivedViewPaths(ctx.layout);
      const derived = new Set([...Object.values(views).filter((v) => typeof v === "string"), ...views.indexes.map((x) => x.path)]);
      const inVault = (p) => (known.prefix ? p.startsWith(`${known.prefix}/`) : true);
      const rel = (p) => (known.prefix ? p.slice(known.prefix.length + 1) : p);
      const changed = await changedPaths(via);
      const outside = changed.filter((p) => !inVault(p));
      if (outside.length) {
        await restore(via);
        return { status: 500, ok: false, result: ran.result, error: `${req.verb} changed ${outside.join(", ")}, outside the vault's folder ${known.prefix}; nothing was committed` };
      }
      const commit = changed.filter((p) => !derived.has(rel(p)));
      if (!commit.length) {
        await restore(via);
        return ran;
      }
      const fail = async (r, what) => {
        await restore(via).catch(() => {});
        throw new StepError(502, shown(`${what}: ${redactUrls(String(r.stderr || "").trim() || r.reason)}`));
      };
      // Each path as it is: `*`, `?`, `[` or `\` in a name matches no neighbour.
      const add = await git(clone, ["add", "--all", "--", ...commit], { via, literal: true });
      if (!add.ok) await fail(add, "git add");
      const subject = subjectOf(req);
      const made = await git(clone, ["commit", "--quiet", `--message=${subject}`], { via });
      if (!made.ok) await fail(made, "git commit");
      if (!at.batch) {
        const name = await freeBranch(via);
        const sw = await git(clone, ["switch", `--create=${name}`, "--quiet", "--", "HEAD"], { via });
        if (!sw.ok) {
          await git(clone, ["switch", "--detach", "--quiet", "--", before], { via }).catch(() => {});
          await fail(sw, "git switch");
        }
      }
      await restore(via);
      const now2 = await batchAt(via);
      setView({ ...state, batch: now2.batch });
      return ran;
    });
  }

  // ── the pull request's state and Send (delivery contracts 1–3) ──

  // `write.pull_requests`: null while gh answers, else why it cannot be asked.
  let pullRequests = null;
  // The last answer that named a pull request for a batch branch: the batch's
  // `pull_request` while that branch is the open batch.
  let lastPr = { branch: null, pr: null };
  const prFor = (branch) => (branch && lastPr.branch === branch && lastPr.pr ? { ...lastPr.pr } : null);
  const remember = (branch, pr) => {
    lastPr = { branch, pr: pr ? { number: pr.number, state: pr.state, url: typeof pr.url === "string" ? pr.url : null } : null };
  };

  // `gh pr list` for a batch branch, or, with none, for dashboard/<person>/none,
  // only to learn whether gh answers (delivery contract 1). gh runs in the
  // clone, so it finds the code host from the clone's origin. Sets
  // `pullRequests`. → { ok: true, list } or { ok: false, missing, reason }.
  async function askState(branch, { budget = proc.budgets.gh, via = "state" } = {}) {
    const head = branch || `dashboard/${person}/none`;
    const r = await proc.gh(paths.clone, ["pr", "list", `--head=${head}`, "--state=all", `--json=${PR_FIELDS}`], { budget, via });
    let out;
    if (!r.ok) out = { ok: false, missing: Boolean(r.missing), reason: r.reason };
    else {
      let list = null;
      try {
        list = JSON.parse(r.stdout);
      } catch {}
      out = Array.isArray(list) ? { ok: true, list } : { ok: false, missing: false, reason: `its answer to gh pr list is no list: ${JSON.stringify(String(r.stdout).trim().slice(0, 200))}` };
    }
    pullRequests = out.ok ? null : redactUrls(`gh cannot be asked about the batch's pull request, so the page cannot tell whether it was merged or closed: ${out.reason}`);
    return out;
  }

  // The non-merge commits of `revs` (git rev-list's own syntax), oldest first
  // by ancestry, not by commit date: [{ sha, subject }].
  async function commitsIn(revs, via) {
    const r = await git(paths.clone, ["rev-list", "--topo-order", "--reverse", "--no-merges", "--format=%x00%H%x00%s", "--end-of-options", ...revs], { need: true, via });
    return String(r.stdout || "")
      .split("\n")
      .filter((l) => l.startsWith("\0"))
      .map((l) => {
        const [, sha, subject = ""] = l.split("\0");
        return { sha, subject };
      });
  }
  const named = (commits) => commits.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`).join("; ");

  // Where a carry of this server stopped, by the kept branch it stopped on
  // (delivery contract 6): { sha, subject }. Held only in memory, so after a
  // restart the branch is listed with its count only.
  const stops = new Map();

  // The person's batch branches the clone has not checked out (delivery
  // contract 6): [{ branch, commits, stopped_at? }], `commits` counting what
  // `base` lacks, `stopped_at` the commit a carry of this server stopped at
  // ({ sha, subject, reason }: it does not apply, or git could not commit it).
  // A branch git cannot count is still listed, never left out in silence:
  // `commits` null and `reason` git's words. Only a list git cannot give
  // fails the step (502).
  async function keptOf(base, current, via) {
    const refs = await git(paths.clone, ["for-each-ref", "--format=%(refname)", "--", `refs/heads/dashboard/${person}/`], { need: true, via });
    const out = [];
    for (const ref of lines(refs.stdout)) {
      const branch = ref.slice("refs/heads/".length);
      if (branch === current || !isBatchBranch(branch) || branch.split("/").length !== 3 || !stampOf(branch)) continue;
      const c = await git(paths.clone, ["rev-list", "--count", "--end-of-options", `${base}..${ref}`], { via });
      const n = c.ok ? Number(lines(c.stdout)[0]) : NaN;
      const entry = Number.isInteger(n)
        ? { branch, commits: n }
        : { branch, commits: null, reason: redactUrls(`git cannot count the commits of the kept branch ${branch}, so the page cannot tell how many were never sent: ${c.ok ? `it answered ${JSON.stringify(String(c.stdout).trim())}` : said(c)}`) };
      const stop = stops.get(branch);
      if (stop) entry.stopped_at = { ...stop };
      out.push(entry);
    }
    for (const b of [...stops.keys()]) if (!out.some((k) => k.branch === b)) stops.delete(b);
    return out;
  }

  const detach = (base, via) => git(paths.clone, ["switch", "--detach", "--quiet", "--", base], { need: true, via });
  // A ref's commits that `base` lacks, merges included, as write.kept counts them.
  const countAhead = async (ref, base, via) => Number(lines((await git(paths.clone, ["rev-list", "--count", "--end-of-options", `${base}..${ref}`], { need: true, via })).stdout)[0]) || 0;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // A merged batch with nothing left to carry ends: the clone detached at
  // `base`, the old branch deleted (delivery contract 5). With no gh, `head`
  // is the batch's own head, which stands for headRefOid, so nothing is
  // carried. → { ended: true } or, when commits are left that it does not
  // hold (or it is not in the clone), { ended: false, unsent }.
  async function endMerged(branch, head, base, via) {
    const there = head ? await git(paths.clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{commit}`], { via }) : { ok: false };
    if (!there.ok) return { ended: false, unsent: null };
    const unsent = await commitsIn([`refs/heads/${branch}`, `^${head}`], via);
    if (unsent.length) return { ended: false, unsent };
    await detach(base, via);
    await git(paths.clone, ["branch", "--delete", "--force", "--", branch], { need: true, via });
    return { ended: true };
  }

  // The carry (delivery contract 5), in the step that learned the merge of
  // `pr`: the non-merge commits of `branch` that `pr.headRefOid` does not
  // reach are cherry-picked, in order, onto the default branch as just
  // fetched. `fetched` is this step's own fetch of origin ({ ok, reason }),
  // or null when it made none, and the carry then fetches; a fetch that
  // failed or was not made means no carry begins, since the default branch
  // would be stale. `refs/pull/<n>/head` is fetched when the head is not in
  // the clone. Past the deadline (`network()` false) no call that uses the
  // network starts, so such a carry does not begin; the next refresh runs it.
  // A carry that does not begin leaves the batch open and moves nothing. One
  // that begins runs to its end. The new batch branch is made at the first
  // commit that applies, so a carry stopped before it leaves no batch; a
  // commit already in the default branch (its pick comes out empty) counts
  // as carried; one that does not apply (a conflict), or that git cannot
  // commit, stops the carry, and the old branch is kept and named, with the
  // commit it stopped at and why. The old branch is deleted only when every
  // non-merge commit on it is in the head or was carried (merge commits are
  // Send's, holding nothing of the person's). A git call that fails past
  // the pick (a budget, the server stopping) aborts the pick, puts the clone
  // back on the old branch when no new batch was made, and fails the step.
  // → { begun: false, reason } or { begun: true, from, branch (the new batch
  // or null), carried, skipped, stopped, left, deleted }; `stopped` is
  // { sha, subject, reason }.
  async function carry(branch, pr, base, via, { fetched = null, network = () => true, budget = (b) => b } = {}) {
    const clone = paths.clone;
    const no = (reason) => ({ begun: false, reason: redactUrls(reason) });
    const head = typeof pr.headRefOid === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(pr.headRefOid) ? pr.headRefOid : null;
    if (!head) return no(`gh named no head commit for pull request #${pr.number} (${JSON.stringify(pr.headRefOid ?? null)}), so the page cannot tell which commits it holds`);
    let got = fetched;
    if (!got) {
      if (!network()) got = { ok: false, reason: "the start's time ran out before git fetch could run" };
      else {
        const f = await git(clone, ["fetch", "--quiet", "--", "origin"], { budget: budget(proc.budgets.git), via });
        if (f.ok) fetchedAt = Number(now());
        got = f.ok ? { ok: true } : { ok: false, reason: `git fetch of origin failed: ${said(f)}` };
      }
    }
    if (!got.ok) return no(`the carry starts only from the default branch as just fetched, and ${got.reason}; the next step tries again`);
    const has = async () => (await git(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{commit}`], { via })).ok;
    if (!(await has())) {
      if (!Number.isInteger(pr.number) || pr.number <= 0) return no(`its head ${head.slice(0, 12)} is not in the page's clone, and gh named no pull request number to fetch it by`);
      if (!network()) return no(`its head ${head.slice(0, 12)} is not in the page's clone, and the start's time ran out before it could be fetched; the next refresh carries`);
      const f = await git(clone, ["fetch", "--quiet", "--no-write-fetch-head", "--", "origin", `refs/pull/${pr.number}/head`], { budget: budget(proc.budgets.git), via });
      if (!(await has())) return no(`its head ${head.slice(0, 12)} is not in the page's clone, and git fetch of refs/pull/${pr.number}/head did not bring it (${f.ok ? "origin holds another commit there" : said(f)}); the next refresh tries again`);
    }
    const unsent = await commitsIn([`refs/heads/${branch}`, `^${head}`], via);
    let made = null;
    // A call the carry cannot go on without: the pick aborted, the clone
    // back at its branch head (the old branch when no batch was made), the
    // view as the clone now is, and the step's 502.
    const broke = async (what, r) => {
      if (existsSync(join(clone, ".git", "CHERRY_PICK_HEAD")) || existsSync(join(clone, ".git", "sequencer"))) await git(clone, ["cherry-pick", "--abort"], { via }).catch(() => {});
      await restore(via).catch(() => {});
      if (!made) await git(clone, ["switch", "--quiet", "--", branch], { via }).catch(() => {});
      if (state.can) {
        try {
          const now2 = await batchOn(base, via);
          setView({ ...state, batch: now2.batch, pull_requests: pullRequests, kept: await keptOf(base, now2.batch ? now2.batch.branch : null, via) });
        } catch {}
      }
      throw new StepError(502, shown(redactUrls(`the carry of ${branch} stopped: ${what}: ${said(r)}. Nothing is lost: what was not carried stays on ${branch}${made ? `, and what was carried is on ${made}` : ""}`)));
    };
    const sw = await git(clone, ["switch", "--detach", "--quiet", "--", base], { via });
    if (!sw.ok) await broke("git switch to the default branch", sw);
    let stopped = null;
    const carried = [];
    const skipped = [];
    for (const c of unsent) {
      const r = await git(clone, ["cherry-pick", "--end-of-options", c.sha], { via });
      if (r.ok) {
        carried.push(c);
        if (!made) {
          const name = await freeBranch(via);
          const sc = await git(clone, ["switch", `--create=${name}`, "--quiet", "--", "HEAD"], { via });
          if (!sc.ok) await broke(`git switch --create=${name}`, sc);
          made = name;
        }
        continue;
      }
      const picking = existsSync(join(clone, ".git", "CHERRY_PICK_HEAD"));
      if (r.timedOut || r.stopped || r.refused || r.error || r.signal || r.status === null || !picking) await broke(`git cherry-pick ${c.sha.slice(0, 12)}`, r);
      // Stopped with the pick in progress: an empty one (no path unmerged,
      // nothing staged) is a commit the default branch holds already; one
      // with a path unmerged does not apply; one with its change staged
      // and no conflict is one git could not commit (a signing that failed).
      const unmerged = await git(clone, ["ls-files", "--unmerged"], { via });
      const staged = await git(clone, ["diff", "--cached", "--quiet"], { via });
      if (!unmerged.ok || staged.status > 1) await broke(`git cherry-pick ${c.sha.slice(0, 12)}`, !unmerged.ok ? unmerged : staged);
      const ab = await git(clone, ["cherry-pick", "--abort"], { via });
      if (!ab.ok) await broke("git cherry-pick --abort", ab);
      const conflict = lines(unmerged.stdout).length > 0;
      if (!conflict && staged.status === 0) {
        skipped.push(c);
        continue;
      }
      stopped = { ...c, reason: conflict ? "it does not apply on the default branch" : `git could not commit it: ${redactUrls(said(r))}` };
      break;
    }
    const left = stopped ? unsent.slice(unsent.findIndex((x) => x.sha === stopped.sha)) : [];
    if (stopped) stops.set(branch, { sha: stopped.sha, subject: stopped.subject, reason: stopped.reason });
    else await git(clone, ["branch", "--delete", "--force", "--", branch], { need: true, via });
    return { begun: true, from: branch, branch: made, carried, skipped, stopped, left, deleted: !stopped };
  }

  // A carry in words, for Send's and Discard's answers, and its summary for `result`.
  const carryText = (c, pr) => {
    const head = `pull request #${pr.number} was merged`;
    if (!c.carried.length && !c.stopped) return `${head}, and no commit was left to carry${c.skipped.length ? ` (${plural(c.skipped.length, "commit")} made after it was sent ${c.skipped.length === 1 ? "is" : "are"} in the default branch already)` : ""}. The batch ended`;
    const parts = [`${head}`];
    parts.push(c.carried.length ? `${plural(c.carried.length, "commit")} made after it was sent ${c.carried.length === 1 ? "was" : "were"} carried into the new batch ${c.branch}: ${named(c.carried)}` : "no commit was carried");
    if (c.skipped.length) parts.push(`${plural(c.skipped.length, "commit")} ${c.skipped.length === 1 ? "is" : "are"} in the default branch already`);
    if (c.stopped) parts.push(`the carry stopped at ${named([c.stopped])}, because ${c.stopped.reason}; it and the commits after it (${named(c.left)}) stay on the kept branch ${c.from}, which the page never carries from again`);
    return parts.join("; ");
  };
  const carrySummary = (c) => ({
    from: c.from,
    branch: c.branch,
    carried: c.carried.map((x) => ({ sha: x.sha, subject: x.subject })),
    skipped: c.skipped.map((x) => ({ sha: x.sha, subject: x.subject })),
    stopped_at: c.stopped ? { sha: c.stopped.sha, subject: c.stopped.subject, reason: c.stopped.reason } : null,
    left: c.left.map((x) => ({ sha: x.sha, subject: x.subject })),
  });

  // What the state says about the open batch (delivery contract 1), in the
  // step that asked: closed ends it and keeps its branch; merged ends it by
  // the carry (delivery contract 5), which `opts` steers; a gh that is
  // missing counts the batch merged when its head is in `base`; a gh that
  // cannot be asked otherwise, or an open one, or none, leaves it open.
  // → { batch, detached, pr, ended, carry, pending }: `ended` "closed" or
  // "merged"; `carry` what a carry did; `pending` why a merge's carry could
  // not begin (the batch then stays open).
  async function settle(batch, asked, base, via, opts = {}) {
    const open = (pr = null, pending = null) => ({ batch: { ...batch, pull_request: prFor(batch.branch) }, detached: false, pr, ended: null, carry: null, pending });
    if (!asked.ok) {
      if (asked.missing && batch.commits === 0) {
        const m = await endMerged(batch.branch, "HEAD", base, via);
        if (m.ended) return { batch: null, detached: true, pr: null, ended: "merged", carry: null, pending: null };
      }
      return open();
    }
    const pr = decide(asked.list);
    remember(batch.branch, pr);
    if (pr?.state === "CLOSED") {
      await detach(base, via);
      return { batch: null, detached: true, pr, ended: "closed", carry: null, pending: null };
    }
    if (pr?.state === "MERGED") {
      const c = await carry(batch.branch, pr, base, via, opts);
      if (!c.begun) return open(pr, c.reason);
      const now2 = await batchOn(base, via);
      return { batch: now2.batch, detached: !now2.batch, pr, ended: "merged", carry: c, pending: null };
    }
    return open(pr);
  }

  // The batch's remote branch merged into it, never rebased (delivery
  // contract 2). A merge that fails is aborted and the clone restored.
  // → { ok: true, merged } or { ok: false, conflict, reason, unsent }.
  async function mergeRemote(branch, via) {
    const remote = `refs/remotes/origin/${branch}`;
    // An explicit destination: the clone's own fetch refspec is not relied on.
    const f = await git(paths.clone, ["fetch", "--quiet", "--no-write-fetch-head", "--", "origin", `refs/heads/${branch}:${remote}`], { budget: proc.budgets.git, via });
    // Not there yet, or not reached: nothing to merge; the push says the rest.
    if (!f.ok) return { ok: true, merged: 0, fetched: false, reason: said(f) };
    const ahead = await git(paths.clone, ["rev-list", "--count", "--end-of-options", `HEAD..${remote}`], { need: true, via });
    const n = Number(lines(ahead.stdout)[0]) || 0;
    if (!n) return { ok: true, merged: 0, fetched: true };
    const m = await git(paths.clone, ["merge", "--no-edit", "--quiet", "--", remote], { via });
    if (m.ok) return { ok: true, merged: n, fetched: true };
    const conflict = existsSync(join(paths.clone, ".git", "MERGE_HEAD"));
    if (conflict) await git(paths.clone, ["merge", "--abort"], { via });
    await restore(via);
    const unsent = await commitsIn(["HEAD", `^${remote}`], via);
    return { ok: false, conflict, reason: redactUrls(said(m)), unsent };
  }

  // Send (delivery contract 2), as one step: the state first; a closed pull
  // request sends nothing; a merged one ends the batch (the carry); open, none
  // or a state that cannot be asked: the remote branch merged, the push, and
  // with no pull request yet `gh pr create` with contract 3's text.
  async function send() {
    if (!state.can) return answer(409, { ok: false, error: state.reason });
    return step("send", async () => {
      const via = "send";
      if (!state.can || !known) return { status: 409, ok: false, error: state.reason };
      const base = known.base;
      const at = await batchOn(base, via);
      if (!at.batch) return { status: 409, ok: false, error: "no batch is open, so there is nothing to send" };
      const old = at.batch.branch;
      const asked = await askState(old, { via });
      const s = await settle(at.batch, asked, base, via);
      const finish = async (fields) => {
        const now2 = await batchOn(base, via);
        setView({ ...state, batch: now2.batch, pull_requests: pullRequests, kept: await keptOf(base, now2.batch ? now2.batch.branch : null, via) });
        return fields;
      };
      if (s.pending) {
        return finish({ status: 200, ok: false, result: { branch: old, sent: false, carried: 0 }, error: `pull request #${s.pr.number} was merged, but the carry of the commits made after it was sent could not begin: ${s.pending}. Nothing was sent, and the batch stays open` });
      }
      if (s.ended === "closed") {
        const left = await commitsIn([`refs/heads/${old}`, `^${base}`], via);
        return finish({
          status: 200,
          ok: false,
          result: { branch: old, sent: false, pull_request: prFor(old) ?? { number: s.pr.number, state: s.pr.state, url: s.pr.url ?? null }, kept: { branch: old, commits: left.length } },
          error: `pull request #${s.pr.number} was closed without a merge, so nothing was sent. The batch ended, and its branch ${old} is kept with ${plural(left.length, "commit")} the default branch lacks${left.length ? `: ${named(left)}` : ""}`,
        });
      }
      // Merged: the carry ran (delivery contract 5); Send delivers the new
      // batch it started as a new pull request, or says nothing was carried.
      const carried = s.ended === "merged" && s.carry ? carrySummary(s.carry) : null;
      if (s.ended === "merged" && !s.batch) {
        const c = s.carry;
        const error = c?.stopped
          ? `${carryText(c, s.pr)}. Nothing was carried, so nothing was sent`
          : `${s.pr ? `pull request #${s.pr.number} was merged` : "the batch is in the default branch"}, and no commit was left to carry, so nothing was sent. The batch ended${c?.skipped.length ? ` (${plural(c.skipped.length, "commit")} made after it was sent ${c.skipped.length === 1 ? "is" : "are"} in the default branch already)` : ""}`;
        return finish({ status: 200, ok: false, result: { branch: old, sent: false, carried: 0, ...(carried ? { carry: carried } : {}) }, error });
      }
      // The branch Send delivers: the batch's, or the new one a carry started.
      const branch = carried ? s.batch.branch : old;
      const sentAs = carried ? null : s.pr;
      const merge = await mergeRemote(branch, via);
      if (!merge.ok && merge.conflict) {
        return finish({
          status: 200,
          ok: false,
          result: { branch, sent: false, unsent: merge.unsent.map((c) => ({ sha: c.sha, subject: c.subject })) },
          error: `the code host's ${branch} holds commits that conflict with the batch, so nothing was sent and the merge was undone. Not sent: ${named(merge.unsent)}. Two ways on: merge the pull request as it was sent (the next step carries what still applies into a new batch), or Discard`,
        });
      }
      if (!merge.ok) throw new StepError(502, shown(`git merge of the code host's ${branch} failed: ${merge.reason}`));
      const pushed = await pushBatch(branch);
      if (!pushed.ok) {
        // Every fatal or error line, and the porcelain line of a rejected ref.
        const own = [...lines(pushed.stderr).filter((l) => /^(fatal|error):/.test(l)), ...lines(pushed.stdout).filter((l) => l.startsWith("!"))];
        const why = pushed.timedOut || pushed.stopped || pushed.refused || !own.length ? said(pushed) : own.join("; ");
        throw new StepError(502, shown(`the push of ${branch} to origin failed: ${redactUrls(why)}`));
      }
      const commits = await commitsIn(["HEAD", `^${base}`], via);
      const result = { branch, sent: true, commits: commits.length, merged: merge.merged, pull_request: null, gh: null };
      if (carried) result.carry = carried;
      if (!asked.ok) {
        result.gh = pullRequests;
        return finish({ status: 200, ok: true, result });
      }
      if (sentAs) {
        result.pull_request = prFor(branch);
        return finish({ status: 200, ok: true, result });
      }
      const { title, body } = prText(commits.map((c) => c.subject));
      const made = await proc.gh(paths.clone, ["pr", "create", `--base=${state.default_branch}`, `--head=${branch}`, `--title=${title}`, `--body=${body}`], { via });
      if (!made.ok) throw new StepError(502, redactUrls(`gh pr create failed after the push: ${made.reason}. The branch ${branch} is on origin, and the next Send asks again`));
      const url = lines(made.stdout).filter((l) => /^https?:\/\//.test(l)).at(-1) ?? null;
      const number = Number(/\/pull\/(\d+)/.exec(url ?? "")?.[1]) || null;
      remember(branch, { number, state: "OPEN", url });
      result.pull_request = prFor(branch);
      return finish({ status: 200, ok: true, result });
    });
  }

  // Discard (delivery contract 4), as one step: the state first. An open
  // pull request is closed with `gh pr close`, its branch kept here and on
  // origin; a closed one ends the batch, its branch kept; a merged one ends
  // it by the carry; with none, or a state that cannot be asked, the batch
  // ends on this machine, its branch kept. The clone is then detached at the
  // fetched default branch, unless a carry started a batch. No commit is
  // deleted. → 200 with `ok: true` and `result.message` saying what was
  // done, or 502 when `gh pr close` failed (the batch then stays open).
  async function discard() {
    if (!state.can) return answer(409, { ok: false, error: state.reason });
    return step("discard", async () => {
      const via = "discard";
      if (!state.can || !known) return { status: 409, ok: false, error: state.reason };
      const base = known.base;
      const at = await batchOn(base, via);
      if (!at.batch) return { status: 409, ok: false, error: "no batch is open, so there is nothing to discard" };
      const branch = at.batch.branch;
      const asked = await askState(branch, { via });
      const s = await settle(at.batch, asked, base, via);
      const finish = async (result) => {
        const now2 = await batchOn(base, via);
        setView({ ...state, batch: now2.batch, pull_requests: pullRequests, kept: await keptOf(base, now2.batch ? now2.batch.branch : null, via) });
        return { status: 200, ok: true, result };
      };
      const keptOne = async () => ({ branch, commits: await countAhead(`refs/heads/${branch}`, base, via) });
      const prOf = (pr) => (pr ? { number: pr.number, state: pr.state, url: typeof pr.url === "string" ? pr.url : null } : null);
      const stays = "a pull request for it, if one is open, stays open on the code host";
      if (s.ended === "closed") {
        const k = await keptOne();
        return finish({ branch, ended: "closed", pull_request: prOf(s.pr), kept: k, message: `pull request #${s.pr.number} was closed already, so the batch ended; its branch ${branch} is kept with ${plural(k.commits, "commit")} the default branch lacks` });
      }
      if (s.ended === "merged") {
        const c = s.carry;
        const message = c ? `${carryText(c, s.pr)}${s.batch ? `. The batch ended, and ${s.batch.branch} is the new one: Discard again to end it` : ""}` : "the batch is in the default branch already, so it ended, and its branch is gone";
        return finish({ branch, ended: "merged", pull_request: prOf(s.pr), kept: c?.stopped ? await keptOne() : null, carry: c ? carrySummary(c) : null, batch: s.batch ? s.batch.branch : null, message });
      }
      const pr = asked.ok ? s.pr : null;
      if (pr?.state === "OPEN") {
        const closed = await proc.gh(paths.clone, ["pr", "close", "--", String(pr.number)], { via });
        if (!closed.ok && !closed.unavailable) throw new StepError(502, redactUrls(`gh pr close failed: ${closed.reason}. Nothing was changed: the batch stays open, and pull request #${pr.number} stays open on the code host`));
        if (closed.ok) {
          remember(branch, { ...pr, state: "CLOSED" });
          await detach(base, via);
          const k = await keptOne();
          return finish({ branch, ended: "closed", pull_request: prOf({ ...pr, state: "CLOSED" }), kept: k, message: `pull request #${pr.number} was closed on the code host, and the batch ended; its branch ${branch} stays there and is kept here, with ${plural(k.commits, "commit")} the default branch lacks` });
        }
        pullRequests = redactUrls(`gh cannot be asked about the batch's pull request, so the page cannot tell whether it was merged or closed: ${closed.reason}`);
      }
      // None yet, or gh cannot be asked: the batch ends on this machine.
      await detach(base, via);
      const k = await keptOne();
      const why = s.pending
        ? `pull request #${pr.number} was merged, but the carry of the commits made after it was sent could not begin (${s.pending}), so `
        : pr?.state === "OPEN"
          ? `gh could not close pull request #${pr.number} (${pullRequests}), so `
          : !asked.ok
            ? `gh cannot be asked (${pullRequests}), so `
            : "";
      return finish({ branch, ended: "here", pull_request: prOf(pr), kept: k, message: `${why}the batch ended on this machine; its branch ${branch} is kept with ${plural(k.commits, "commit")} the default branch lacks${s.pending ? "" : asked.ok && !pr ? "; no pull request was opened for it" : `, and ${stays}`}` });
    });
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
    preview,
    action,
    askState,
    send,
    discard,
    view,
    readCtx: () => readable ?? ctx,
    writeBindingFolder,
  };
}

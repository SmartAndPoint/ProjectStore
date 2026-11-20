// projectstore — close-refs.mjs: the `close-refs` verb, where a closing
// story's code_refs come from, and the one normaliser every source goes
// through.
//
// `close-refs <EPIC>/<story-id> [--reviewer-refs-file <path>] [--json]`
// writes nothing. It answers {source, verified, refs, dropped, notes} from
// the first source that answers:
//
//   1. the pull request in the story's `external_refs.pr`, when it is in the
//      project's own repository (a bare `gh repo view --json url`), its
//      files read through follow-gh.mjs (`pr view`, and the paginated
//      `api …/pulls/<n>/files` when the view is short); merged or open;
//   2. the last `code_refs: [...]` line of the reviewer's report, copied by
//      the story command into the file --reviewer-refs-file names;
//   3. the files of the commits on HEAD since the story's started_at
//      (diff-refs.mjs committedFilesSince), not verified.
//
// A source that does not answer hands over to the next, and its reason is a
// note. Every source's paths go through normaliseRefs: the project's prefix
// inside its repository (`git rev-parse --show-prefix`) stripped from paths
// that come from gh and git, then a path outside the project, inside the
// vault, under SOURCE_IGNORE, removed, or (with a person) absent from the
// checkout is dropped, in that order; duplicates keep their first place.
// With a person and a merged pull request, files absent while the merge
// commit is not in HEAD's history (`git merge-base --is-ancestor`) give the
// note `checkout-behind` and no refs.
//
// Spec: "The close-refs verb: where a closing story's code_refs come from,
// one normaliser, and a cap on a close with no person" (alias `close-refs`),
// contracts 1 to 6; the ADR "A story's close writes its code_refs on every
// path and widens its epic's footprint in the same approval", decisions 2
// and 3. `follow` (contract 7) calls prSource and normaliseRefs in process
// with `person: false` and `who: "follow"`; it never starts the verb. The
// verb reads the network, so it is not an MCP tool, and no hook reaches it.
//
// runCloseRefs(ctx) follows next's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints. Loaded lazily.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SOURCE_IGNORE, loadLayout, folderByKind, parseFrontmatter, commandForm } from "./lib.mjs";
import { normaliseVaultPath, DEFAULT_LAYOUT } from "./binding.mjs";
import { resolveStory } from "./move.mjs";
import { defaultGit } from "./precommit.mjs";
import { ghFacts, repoOfUrl } from "./follow-gh.mjs";
import { committedFilesSince } from "./diff-refs.mjs";
import { vaultInside } from "./spec-drift.mjs";
import { prUrlOf } from "./follow-plan.mjs";

// More refs than `follow` writes without a person (the close-refs spec, contract 7).
export const FOLLOW_CAP = 300;

const errMsg = (e) => (e && e.message ? e.message : String(e));
const firstLine = (s) =>
  String(s || "")
    .trim()
    .split("\n")[0]
    .trim();

// ─── Note messages (the close-refs spec's table) ───────────────────────

// The message of a note, verbatim from the spec's table. `who` is "verb" or
// "follow": the two codes whose second sentence differs read it. `set` is
// the codemap command that sets the story's refs by hand.
export function noteMessage(code, f = {}, { who = "verb", set = "" } = {}) {
  switch (code) {
    case "gh-unavailable":
      return `gh cannot be run (${f.reason}), so the files of ${f.url} were not read. To read them, install gh or run "gh auth login", then run the close again.`;
    case "repo-unknown":
      return `gh could not name this project's repository (${f.reason}), so the files of ${f.url} are not used. To set this story's code_refs by hand: ${set}.`;
    case "prefix-unknown":
      return `git could not say where this project sits in its repository (${f.reason}), so paths from the pull request and the commits cannot be turned into code_refs. ${
        who === "follow"
          ? `None are written. To set them by hand: ${set}.`
          : `The reviewer's line is still read. To set them by hand: ${set}.`
      }`;
    case "files-foreign":
      return `${f.url} is in ${f.repo}, not in this project's repository ${f.own}, so its files are not used. If the story's code is in this project: ${set}.`;
    case "files-unknown":
      return `could not read the files of ${f.url}: ${f.reason}. ${
        who === "follow" ? "The story is left as it is; the next run reads again." : "The next source is used."
      }`;
    case "files-truncated":
      return `${f.url} changed ${f.n} files and gh gave ${f.m}; add the rest with ${set}.`;
    case "pr-closed":
      return `${f.url} was closed without a merge, so its files are not used. If the story's code landed another way: ${set}.`;
    case "reviewer-refs-none":
      return `${f.path} is missing, has no code_refs: line, or its last one is not of the form code_refs: ["path"], so the reviewer's report gives no files. The commits since the story started are read instead.`;
    case "unverified":
      return `these are the files of every commit on HEAD since ${f.startedAt}, other stories' included: check them before writing them.`;
    case "commits-unknown":
      return `git could not list the commits since ${f.startedAt} (${f.reason}), so no files are proposed. To set them by hand: ${set}.`;
    case "checkout-behind":
      return `this checkout is behind: pull, then run the close again. ${f.n} files of ${f.url} are not here, and its merge commit ${String(f.sha || "").slice(0, 7)} is not in this branch.`;
    case "refs-over-cap":
      return `${f.url} gives ${f.n} code_refs, more than follow writes on its own (${FOLLOW_CAP}), so none was written. To set them: ${set}.`;
    default:
      throw new Error(`unknown note code: ${code}`);
  }
}

// ─── The normaliser (contract 6) ───────────────────────────────────────

// Any source's paths as refs. `items` are paths or {path, removed}. `prefix`
// is the project's path inside its repository ("" at its root, "app/" in a
// folder) for paths relative to the repository's root (gh and git), or null
// for paths already relative to the project (the reviewer's line). `vault` is
// the vault's path relative to the project, or null when it is not inside
// it. `exists(rel)` says whether the file is in the checkout; it is asked
// only with a person. A path is dropped by the first rule it meets:
// outside-project, vault, ignored (SOURCE_IGNORE), removed, absent. A dropped
// path is relative to the project when inside it and to the repository's
// root when not. Duplicates keep their first place. Pure.
// Returns {refs, dropped: [{path, why}]}.
export function normaliseRefs(items, { prefix = null, vault = null, exists = () => true, person = true } = {}) {
  const refs = [];
  const dropped = [];
  const seen = new Set();
  const pre = prefix ? String(prefix).replace(/\/*$/, "/") : "";
  const vaultRel = vault ? String(vault).replace(/\/+$/, "") : null;
  for (const it of items) {
    const raw = String(typeof it === "string" ? it : (it?.path ?? "")).replace(/^(?:\.\/)+/, "");
    if (!raw) continue;
    const removed = typeof it === "object" && it !== null && it.removed === true;
    let path = raw;
    let why = null;
    if (prefix !== null) {
      if (pre && !raw.startsWith(pre)) why = "outside-project";
      else path = raw.slice(pre.length);
    } else if (raw.startsWith("/") || raw === ".." || raw.startsWith("../")) why = "outside-project";
    if (!path) continue;
    const key = `${why ? "r" : "p"}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!why && vaultRel && (path === vaultRel || path.startsWith(`${vaultRel}/`))) why = "vault";
    if (!why && SOURCE_IGNORE.some((rx) => rx.test(path))) why = "ignored";
    if (!why && removed) why = "removed";
    if (!why && person && !exists(path)) why = "absent";
    if (why) dropped.push({ path, why });
    else refs.push(path);
  }
  return { refs, dropped };
}

// ─── The sources ───────────────────────────────────────────────────────

// What every source reads once per run: the project's prefix (asked at most
// once), the vault's path inside the project, the codemap command, and the
// notes so far. `git` is a runner of gitRun's shape.
export function closeRun({ project, vault, git, ref, env = process.env, who = "verb", person = true }) {
  let prefix;
  const notes = [];
  const set = commandForm("codemap", { args: `set ${ref}`, env });
  const run = {
    project,
    vault: vault ? vaultInside(project, vault) : null,
    git,
    who,
    person,
    notes,
    set,
    noted: new Set(),
    note(code, facts) {
      run.noted.add(code);
      notes.push({ code, message: noteMessage(code, facts, { who, set }) });
    },
    // {ok, prefix} or {ok: false, reason}; asked at most once.
    prefix() {
      if (prefix) return prefix;
      const r = git(project, ["rev-parse", "--show-prefix"]);
      prefix =
        r.kind === "answer" && r.status === 0
          ? { ok: true, prefix: String(r.stdout).trim() }
          : {
              ok: false,
              reason:
                r.kind === "no-git"
                  ? "not a git repository"
                  : r.reason || firstLine(r.stderr) || `git rev-parse exited ${r.status}`,
            };
      if (!prefix.ok && !run.noted.has("prefix-unknown")) run.note("prefix-unknown", { reason: prefix.reason });
      return prefix;
    },
    exists: (rel) => existsSync(join(project, rel)),
  };
  return run;
}

// Source 1 (contracts 2, 3 and 6): the pull request's files. Returns
// {answered, refs, dropped, state, mergeCommit, changedFiles, read} — `read`
// the files gh gave — with the reasons it did not answer as notes on `run`.
export function prSource(run, gh, url) {
  const no = { answered: false, refs: [], dropped: [] };
  const repo = repoOfUrl(url);
  if (!repo) {
    run.note("files-unknown", { url, reason: "it is not a pull request URL" });
    return no;
  }
  const own = gh.ownRepo();
  if (!own.ok) {
    run.note(own.unavailable ? "gh-unavailable" : "repo-unknown", { url, reason: own.reason });
    return no;
  }
  if (repo !== own.repo) {
    run.note("files-foreign", { url, repo, own: own.repo });
    return no;
  }
  const pre = run.prefix();
  if (!pre.ok) return no;
  const f = gh.files(url);
  if (!f.ok) {
    run.note(f.unavailable ? "gh-unavailable" : "files-unknown", { url, reason: f.reason });
    return no;
  }
  if (f.state === "CLOSED") {
    run.note("pr-closed", { url });
    return no;
  }
  if (f.changedFiles > f.files.length) run.note("files-truncated", { url, n: f.changedFiles, m: f.files.length });
  const n = normaliseRefs(f.files, { prefix: pre.prefix, vault: run.vault, exists: run.exists, person: run.person });
  const out = {
    answered: true,
    refs: n.refs,
    dropped: n.dropped,
    state: f.state,
    mergeCommit: f.mergeCommit,
    changedFiles: f.changedFiles,
    read: f.files.length,
  };
  const absent = n.dropped.filter((d) => d.why === "absent");
  if (run.person && f.state === "MERGED" && absent.length && f.mergeCommit) {
    const { git, project } = run;
    const r = git(project, ["merge-base", "--is-ancestor", f.mergeCommit, "HEAD"]);
    if (!(r.kind === "answer" && r.status === 0)) {
      run.note("checkout-behind", { url, n: absent.length, sha: f.mergeCommit });
      return { ...out, refs: [], dropped: n.dropped.filter((d) => d.why !== "absent") };
    }
  }
  return out;
}

// The reviewer's line (contract 4): the last line that, trimmed, starts with
// `code_refs:`; its rest one JSON list of strings and nothing else. Returns
// the list, or null.
export function reviewerLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("code_refs:"));
  if (!lines.length) return null;
  try {
    const v = JSON.parse(lines.at(-1).slice("code_refs:".length).trim());
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

function reviewerSource(run, file, shown) {
  let text = null;
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  const list = text === null ? null : reviewerLine(text);
  if (list === null) {
    run.note("reviewer-refs-none", { path: shown });
    return { answered: false };
  }
  const n = normaliseRefs(list, { prefix: null, vault: run.vault, exists: run.exists, person: run.person });
  return { answered: true, ...n };
}

// Source 3 (contract 5): the commits on HEAD since started_at.
function commitsSource(run, startedAt) {
  if (!startedAt) return { answered: false };
  const pre = run.prefix();
  if (!pre.ok) return { answered: false };
  const c = committedFilesSince(run.project, startedAt, { git: run.git });
  if (c.status !== "ok") {
    run.note("commits-unknown", { startedAt, reason: c.reason });
    return { answered: false };
  }
  if (!c.files.length) return { answered: false };
  run.note("unverified", { startedAt });
  const n = normaliseRefs(c.files, { prefix: pre.prefix, vault: run.vault, exists: run.exists, person: run.person });
  return { answered: true, ...n };
}

// The three sources in order, for a run with a person. Returns the verb's
// result: {source, verified, refs, dropped, notes}.
export function closeRefs({ run, gh, url, reviewerFile = null, reviewerShown = null, startedAt = null }) {
  const answer = (source, r) => ({
    source,
    verified: source === "pr" || source === "reviewer",
    refs: r.refs,
    dropped: r.dropped,
    notes: run.notes,
  });
  if (url) {
    const r = prSource(run, gh, url);
    if (r.answered) return answer("pr", r);
  }
  if (reviewerFile !== null) {
    const r = reviewerSource(run, reviewerFile, reviewerShown ?? reviewerFile);
    if (r.answered) return answer("reviewer", r);
  }
  const r = commitsSource(run, startedAt);
  if (r.answered) return answer("commits", r);
  return answer("none", { refs: [], dropped: [] });
}

// ─── The verb (contract 1) ─────────────────────────────────────────────

export function renderCloseRefs(ref, r) {
  const lines = [
    `${ref}: source ${r.source}${r.verified ? " (verified)" : r.source === "none" ? "" : " (not verified)"}`,
  ];
  lines.push(r.refs.length ? `refs (${r.refs.length}):` : "refs: none");
  for (const p of r.refs) lines.push(`  ${p}`);
  if (r.dropped.length) {
    lines.push(`dropped (${r.dropped.length}):`);
    for (const d of r.dropped) lines.push(`  ${d.path} (${d.why})`);
  }
  if (r.notes.length) {
    lines.push("notes:");
    for (const n of r.notes) lines.push(`  ${n.code}: ${n.message}`);
  }
  return lines.join("\n") + "\n";
}

export async function runCloseRefs(ctx) {
  // gh and git are the tests' seams; the bin never passes them.
  const { values, positionals, cfg, project, env = process.env, cwd = process.cwd() } = ctx;
  const [storyArg] = positionals;
  if (!storyArg) return { usage: "close-refs takes a story, such as `close-refs PS-CORE/story-x`" };
  if (values["reviewer-refs-file"] !== undefined && !String(values["reviewer-refs-file"]).trim())
    return { usage: "--reviewer-refs-file takes a path, such as --reviewer-refs-file /tmp/reviewer-refs.txt" };
  const fail = (message) => ({ ok: false, code: 1, result: { error: message }, text: `close-refs: ${message}\n` });
  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (typeof vault !== "string" || !existsSync(vault))
    return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  let epics;
  try {
    epics = folderByKind(loadLayout(cfg.layout || DEFAULT_LAYOUT), "epic");
  } catch (e) {
    return fail(errMsg(e));
  }
  if (!epics) return fail(`layout ${cfg.layout} has no epic folder`);
  const found = resolveStory(String(storyArg).trim(), { vault, epicsPath: epics.path });
  if (found.error) return fail(found.error);
  const text = readFileSync(found.path, "utf8");
  const fm = parseFrontmatter(text).data;
  const url = prUrlOf(text);
  const startedAt = fm.started_at && fm.started_at !== "null" ? String(fm.started_at) : null;
  const git = ctx.git || defaultGit(env);
  const gh = ctx.gh || ghFacts({ cwd: project, env });
  const run = closeRun({ project, vault, git, ref: found.ref, env });
  const shown = values["reviewer-refs-file"] === undefined ? null : String(values["reviewer-refs-file"]);
  const result = closeRefs({
    run,
    gh,
    url,
    reviewerFile: shown === null ? null : resolve(cwd, shown),
    reviewerShown: shown,
    startedAt,
  });
  return { ok: true, code: 0, result, text: renderCloseRefs(found.ref, result) };
}

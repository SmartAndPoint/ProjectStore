// projectstore — follow-gh.mjs: the facts `follow` and `close-refs` read,
// from the `gh` CLI.
//
// The one module that starts `gh` (tests/disclosure.test.mjs holds it to
// that); only follow.mjs and close-refs.mjs import it. It runs in the
// project, with the caller's environment and a time limit, and reads five
// things: one pull request by its url (`pr view`, never its body), the
// repository's pull requests with their bodies (`pr list`, an explicit
// --limit of at most 1000, the search's cap: the open ones, and those merged
// or closed since a day), a repository's default branch (`repo view`, once
// per repository), the project's own repository (a bare `repo view --json
// url`, once), and a pull request's files (`pr view --json files,…`, and
// `api …/pulls/<n>/files` paginated when the view is short; the close-refs
// spec, contract 2). ProjectStore reads no token: `gh` owns the login.
//
// Spec: "The follow verb: a merged pull request closes its story through the
// close computation, and a stale review goes back" (alias `follow`),
// contract 2. Every answer is {ok: true, …} or {ok: false, unavailable,
// reason}: `gh` missing from PATH, or logged out (exit 4), is unavailable
// (`gh-unavailable`); any other failure, a time limit included, is not
// (`pr-unreadable`). A list as long as its limit is a failure too: more pull
// requests may be in the window. A failure is never "no pull request".

import { spawnSync } from "node:child_process";

// The search's cap, and the list's explicit limit.
export const LIST_LIMIT = 1000;
// The fields of a pull request, without `body`; the list adds it.
export const PR_FIELDS = Object.freeze([
  "url",
  "state",
  "isDraft",
  "isCrossRepository",
  "baseRefName",
  "createdAt",
  "mergedAt",
  "mergeCommit",
  "updatedAt",
]);
export const GH_TIMEOUT_MS = 60000;
// Bodies of a thousand pull requests fit.
const MAX_BUFFER = 256 * 1024 * 1024;
// `gh` logged out: its documented exit for an authentication error.
const AUTH_EXIT = 4;

const firstLine = (s) =>
  String(s || "")
    .trim()
    .split("\n")[0]
    .trim();

// One run of gh: {ok, stdout} or {ok: false, unavailable, reason}.
function runGh(args, { cwd, env, timeout }) {
  let r;
  try {
    r = spawnSync("gh", args, { cwd, env, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER });
  } catch (e) {
    return { ok: false, unavailable: false, reason: String((e && e.message) || e) };
  }
  if (r.error?.code === "ENOENT") return { ok: false, unavailable: true, reason: "gh is not installed or not on PATH" };
  if (r.error?.code === "ETIMEDOUT" || (r.signal && r.status === null))
    return { ok: false, unavailable: false, reason: `gh ${args.slice(0, 2).join(" ")} timed out` };
  if (r.error) return { ok: false, unavailable: false, reason: String(r.error.message || r.error) };
  if (r.status === AUTH_EXIT)
    return { ok: false, unavailable: true, reason: firstLine(r.stderr) || "gh is not logged in (exit 4)" };
  if (r.status !== 0) return { ok: false, unavailable: false, reason: firstLine(r.stderr) || `gh exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}

function parsed(r, what) {
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, unavailable: false, reason: `gh ${what} printed no JSON` };
  }
}

// The repository a pull request's url names, as the url `repo view` takes:
// `https://<host>/<owner>/<repo>`; null for another shape.
export function repoOfUrl(url) {
  const m = String(url || "").match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+\/?$/);
  return m ? m[1].toLowerCase() : null;
}

// A repository url as the comparison reads it: lower case, no trailing slash
// and no `.git` (the close-refs spec, contract 2).
export const repoKey = (url) =>
  String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

// The parts of a pull request's url the files list needs: {host, owner,
// repo, number}, as written; null for another shape.
export function prParts(url) {
  const m = String(url || "").match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  return m ? { host: m[1], owner: m[2], repo: m[3], number: m[4] } : null;
}

// The files list's page size (it gives at most 3,000 files, GitHub's cap).
export const FILES_PAGE = 100;

// `gh api --paginate` prints one JSON array per page, back to back or on
// lines of their own: every top-level value, read in order and flattened.
// Throws on anything that is not that.
export function concatenatedArrays(text) {
  const s = String(text);
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const v = JSON.parse(s.slice(start, i + 1));
        if (!Array.isArray(v)) throw new Error("a page is not a list");
        out.push(...v);
      }
    } else if (depth === 0 && !/\s/.test(c)) throw new Error("not a list of pages");
  }
  if (depth !== 0 || inString) throw new Error("a page is cut short");
  return out;
}

// The adapter: {view(url), list({since}), defaultBranch(url), ownRepo(),
// files(url)}. `since` is a UTC day `YYYY-MM-DD`, or null for the open pull
// requests only. ownRepo and files are the close-refs spec's contracts 2
// and 3, shared with `follow` (its contract 7).
export function ghFacts({ cwd, env = process.env, timeout = GH_TIMEOUT_MS } = {}) {
  const opts = { cwd, env, timeout };
  const branches = new Map();
  let own = null;
  const listOne = (state, search) => {
    const args = ["pr", "list", "--state", state, "--limit", String(LIST_LIMIT)];
    if (search) args.push("--search", search);
    args.push("--json", [...PR_FIELDS, "body"].join(","));
    const r = parsed(runGh(args, opts), "pr list");
    if (!r.ok) return r;
    if (!Array.isArray(r.value)) return { ok: false, unavailable: false, reason: "gh pr list printed no list" };
    if (r.value.length >= LIST_LIMIT)
      return {
        ok: false,
        unavailable: false,
        reason: `gh pr list returned ${r.value.length} pull requests, its limit: more may be in the window`,
      };
    return { ok: true, prs: r.value };
  };
  return {
    view(url) {
      const r = parsed(runGh(["pr", "view", url, "--json", PR_FIELDS.join(",")], opts), "pr view");
      return r.ok ? { ok: true, pr: r.value } : r;
    },
    list({ since = null } = {}) {
      const open = listOne("open", null);
      if (!open.ok || since === null) return open;
      const closed = listOne("closed", `closed:>=${since}`);
      return closed.ok ? { ok: true, prs: [...open.prs, ...closed.prs] } : closed;
    },
    defaultBranch(url) {
      const repo = repoOfUrl(url);
      if (!repo) return { ok: false, unavailable: false, reason: `not a pull request url: ${url}` };
      if (branches.has(repo)) return branches.get(repo);
      const r = parsed(runGh(["repo", "view", repo, "--json", "defaultBranchRef"], opts), "repo view");
      const name = r.ok ? r.value?.defaultBranchRef?.name : null;
      const out = !r.ok
        ? r
        : typeof name === "string" && name
          ? { ok: true, branch: name }
          : { ok: false, unavailable: false, reason: `gh repo view gave no default branch for ${repo}` };
      branches.set(repo, out);
      return out;
    },
    // The project's own repository: a bare `gh repo view --json url`, run in
    // the project, once per adapter. {ok, repo} with repo as repoKey reads it.
    ownRepo() {
      if (own) return own;
      const r = parsed(runGh(["repo", "view", "--json", "url"], opts), "repo view");
      const url = r.ok ? r.value?.url : null;
      own = !r.ok
        ? r
        : typeof url === "string" && url
          ? { ok: true, repo: repoKey(url) }
          : { ok: false, unavailable: false, reason: "gh repo view gave no url" };
      return own;
    },
    // A pull request's files: `pr view --json files,changedFiles,state,
    // mergeCommit`, and, when `changedFiles` is larger than the files it gave
    // or they carry no changeType, the paginated files list, whose answer
    // replaces the view's. {ok, state, mergeCommit, changedFiles, files:
    // [{path, removed}], listed} or a failure; a failed list is a failure,
    // never the view's files alone.
    files(url) {
      const v = parsed(runGh(["pr", "view", url, "--json", "files,changedFiles,state,mergeCommit"], opts), "pr view");
      if (!v.ok) return v;
      const pr = v.value || {};
      const viewFiles = Array.isArray(pr.files) ? pr.files : null;
      const changed = Number.isInteger(pr.changedFiles) ? pr.changedFiles : null;
      if (viewFiles === null || changed === null)
        return { ok: false, unavailable: false, reason: "gh pr view gave no files or changedFiles" };
      const base = {
        ok: true,
        state: String(pr.state || "").toUpperCase(),
        mergeCommit: pr.mergeCommit?.oid || null,
        changedFiles: changed,
      };
      // A pull request closed without a merge is judged from the view's
      // state alone: its files are not used, so no list is asked for.
      if (base.state === "CLOSED") return { ...base, listed: false, files: [] };
      const needList = changed > viewFiles.length || viewFiles.some((f) => !f?.changeType);
      if (!needList)
        return {
          ...base,
          listed: false,
          files: viewFiles.map((f) => ({ path: String(f.path), removed: f.changeType === "DELETED" })),
        };
      const parts = prParts(url);
      if (!parts) return { ok: false, unavailable: false, reason: `not a pull request url: ${url}` };
      const path = `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/files?per_page=${FILES_PAGE}`;
      const r = runGh(["api", path, "--paginate", "--hostname", parts.host], opts);
      if (!r.ok) return r;
      let list;
      try {
        list = concatenatedArrays(r.stdout);
      } catch {
        return { ok: false, unavailable: false, reason: "gh api printed no list of files" };
      }
      if (list.some((f) => typeof f?.filename !== "string"))
        return { ok: false, unavailable: false, reason: "gh api gave a file with no filename" };
      return {
        ...base,
        listed: true,
        files: list.map((f) => ({ path: f.filename, removed: f.status === "removed" })),
      };
    },
  };
}

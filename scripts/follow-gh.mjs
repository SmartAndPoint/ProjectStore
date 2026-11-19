// projectstore — follow-gh.mjs: the facts `follow` reads, from the `gh` CLI.
//
// The one module that starts `gh` (tests/disclosure.test.mjs holds it to
// that). It runs in the project, with the caller's environment and a time
// limit, and reads three things: one pull request by its url (`pr view`,
// never its body), the repository's pull requests with their bodies (`pr
// list`, an explicit --limit of at most 1000, the search's cap: the open
// ones, and those merged or closed since a day), and a repository's default
// branch (`repo view`, once per repository). ProjectStore reads no token: `gh`
// owns the login.
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

// The adapter: {view(url), list({since}), defaultBranch(url)}. `since` is a
// UTC day `YYYY-MM-DD`, or null for the open pull requests only.
export function ghFacts({ cwd, env = process.env, timeout = GH_TIMEOUT_MS } = {}) {
  const opts = { cwd, env, timeout };
  const branches = new Map();
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
  };
}

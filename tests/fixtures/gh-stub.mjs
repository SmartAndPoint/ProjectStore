// projectstore — test fixture: a `gh` first on PATH (the follow spec,
// "Testing": no test touches the network).
//
//   ghStub(dir, table)  → { bin, dir, set(table), log(), calls(sub), env(base) }
//   ghAnswer(argv, table) → { status, stdout, stderr, hang }
//
// The stub is a node script named `gh` whose interpreter is this Node's own
// path, so a PATH of the stub's folder alone runs it. It appends each argv to
// calls.jsonl beside itself and answers from table.json:
//
//   { prs: [{url, state, isDraft, isCrossRepository, baseRefName, createdAt,
//            mergedAt, mergeCommit, updatedAt, closedAt, body}],
//     branches: {"https://github.com/<owner>/<repo>": "main"},  // default "main"
//     auth: true,                     // every call exits 4 (logged out)
//     full: true,                     // a list returns exactly its --limit
//     fail: { view: {<url>: <exit>}, list: <exit>|"hang", repo: <exit>|"hang",
//             create: <exit>|"hang", close: <exit>|"hang",
//             api: <exit>|"hang",       // the paginated files list
//             ownRepo: <exit>|"hang" }, // the bare `repo view --json url`
//     ownRepo: "https://github.com/<owner>/<repo>",  // default OWN_REPO, acme/app
//     // A pull request's files (the close-refs spec, "Testing"): `prs[].files`
//     // [{path, changeType}] (changeType DELETED, ADDED, MODIFIED or none) and
//     // `prs[].changedFiles` (default: the files' count). `pr view` gives the
//     // first 100; `api …/pulls/<n>/files?per_page=<k> --paginate` gives up
//     // to 3,000 as {filename, status}, one array per page, back to back.
//     // The dashboard's delivery: the pull requests of batch branches.
//     pulls: [{number, state, headRefName, headRefOid, url, baseRefName, title, body}],
//     repo: "https://github.com/<owner>/<repo>",   // pr create's URLs; default acme/vault
//     createOid: "<sha>" }                         // the headRefOid pr create records
//
// `pr view` and `pr list` print only the fields --json names; `pr list
// --state closed --search "closed:>=<day>"` returns the merged and closed
// pull requests whose closedAt (else mergedAt) is on or after that day, and
// `pr list --state=all` (with no --head) returns every one of them.
// Options are read in both forms, `--name value` and `--name=value`.
//
// `pr list --head=<branch>` answers from `pulls`, those of that head branch
// (any state with --state=all). `pr create` adds an OPEN pull request to
// `pulls` (the next number, its --head, --base, --title and --body) and
// prints its URL; `pr close` marks the one its argument names CLOSED. Both
// write the table back, so the next `pr list` sees them. Each call's record
// holds its argv, its cwd, GH_PROMPT_DISABLED as it saw it (`prompt`), and
// GH_REPO and GH_HOST (`env`, null when unset), and whether GH_TOKEN is set
// (`token`, never its value).

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = pathToFileURL(fileURLToPath(import.meta.url)).href;
// The project's own repository a bare `repo view` names: the repository of
// the follow tests' pull requests, so none of them reads as files-foreign.
export const OWN_REPO = "https://github.com/acme/app";
const norm = (u) =>
  String(u ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

const after = (argv, flag) => {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
// The argument after `--`, else the last one that is no option.
const target = (argv) => {
  const i = argv.indexOf("--");
  return i !== -1
    ? argv[i + 1]
    : argv
        .slice(2)
        .filter((a) => !a.startsWith("-"))
        .at(-1);
};
const pick = (pr, fields) => Object.fromEntries(fields.map((f) => [f, pr[f] ?? (f === "body" ? "" : null)]));
const failed = (how, message) =>
  how === "hang" ? { hang: true } : { status: Number(how), stdout: "", stderr: `${message}\n` };

export function ghAnswer(argv, table = {}) {
  if (table.auth)
    return {
      status: 4,
      stdout: "",
      stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
    };
  const fields = String(after(argv, "--json") || "")
    .split(",")
    .filter(Boolean);
  const fail = table.fail || {};
  const prs = table.prs || [];
  if (argv[0] === "pr" && argv[1] === "view") {
    const url = argv[2];
    const how = (fail.view || {})[url];
    if (how !== undefined) return failed(how, `GraphQL: Could not resolve to a PullRequest (${url})`);
    const pr = prs.find((p) => norm(p.url) === norm(url));
    if (!pr) return { status: 1, stdout: "", stderr: `GraphQL: Could not resolve to a PullRequest (${url})\n` };
    // The view gives at most 100 files, and changedFiles counts them all.
    const shown = {
      ...pr,
      ...(Array.isArray(pr.files) ? { files: pr.files.slice(0, 100) } : {}),
      changedFiles: pr.changedFiles ?? (Array.isArray(pr.files) ? pr.files.length : null),
    };
    return { status: 0, stdout: JSON.stringify(pick(shown, fields)) + "\n", stderr: "" };
  }
  const pulls = table.pulls || [];
  if (argv[0] === "pr" && argv[1] === "list" && after(argv, "--head") !== null) {
    if (fail.list !== undefined) return failed(fail.list, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const head = after(argv, "--head");
    const state = after(argv, "--state") || "open";
    const list = pulls.filter(
      (p) => p.headRefName === head && (state === "all" || String(p.state).toLowerCase() === state),
    );
    return { status: 0, stdout: JSON.stringify(list.map((p) => pick(p, fields))) + "\n", stderr: "" };
  }
  if (argv[0] === "pr" && argv[1] === "create") {
    if (fail.create !== undefined)
      return failed(fail.create, "pull request create failed: GraphQL: Head sha can't be blank (createPullRequest)");
    const number = pulls.reduce((n, p) => Math.max(n, Number(p.number) || 0), 0) + 1;
    const url = `${table.repo || "https://github.com/acme/vault"}/pull/${number}`;
    const pr = {
      number,
      state: "OPEN",
      headRefName: after(argv, "--head"),
      headRefOid: table.createOid ?? null,
      url,
      baseRefName: after(argv, "--base"),
      title: after(argv, "--title"),
      body: after(argv, "--body"),
    };
    return { status: 0, stdout: `${url}\n`, stderr: "", table: { ...table, pulls: [...pulls, pr] } };
  }
  if (argv[0] === "pr" && argv[1] === "close") {
    if (fail.close !== undefined) return failed(fail.close, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const ref = String(target(argv) ?? "");
    const hit = pulls.find((p) => String(p.number) === ref || norm(p.url) === norm(ref) || p.headRefName === ref);
    if (!hit) return { status: 1, stdout: "", stderr: `no pull requests found for branch "${ref}"\n` };
    const next = pulls.map((p) => (p === hit ? { ...p, state: "CLOSED" } : p));
    return { status: 0, stdout: "", stderr: `Closed pull request #${hit.number}\n`, table: { ...table, pulls: next } };
  }
  if (argv[0] === "pr" && argv[1] === "list") {
    if (fail.list !== undefined) return failed(fail.list, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const limit = Number(after(argv, "--limit") || 30);
    const state = after(argv, "--state") || "open";
    if (table.full) {
      const many = Array.from({ length: limit }, (_, i) => ({
        number: 100000 + i,
        title: `pull request ${100000 + i}`,
        url: `https://github.com/acme/app/pull/${100000 + i}`,
        state: "OPEN",
        isDraft: false,
        isCrossRepository: false,
        baseRefName: "main",
        body: "",
      }));
      return { status: 0, stdout: JSON.stringify(many.map((p) => pick(p, fields))) + "\n", stderr: "" };
    }
    const since = (String(after(argv, "--search") || "").match(/closed:>=(\d{4}-\d\d-\d\d)/) || [])[1] || null;
    const list = prs.filter((p) => {
      const s = String(p.state).toUpperCase();
      // The dashboard's Code block asks for every state at once.
      if (state === "all") return true;
      if (state === "open") return s === "OPEN";
      if (s === "OPEN") return false;
      const at = String(p.closedAt || p.mergedAt || "");
      return !since || at.slice(0, 10) >= since;
    });
    return { status: 0, stdout: JSON.stringify(list.slice(0, limit).map((p) => pick(p, fields))) + "\n", stderr: "" };
  }
  // The paginated files list: `api repos/<o>/<r>/pulls/<n>/files?per_page=<k>
  // --paginate --hostname <host>`, from the pull request's `files`, at most
  // 3,000, one JSON array per page printed back to back.
  if (argv[0] === "api") {
    if (fail.api !== undefined) return failed(fail.api, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const m = String(argv[1] || "").match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files\?per_page=(\d+)$/);
    const host = after(argv, "--hostname") || "github.com";
    const pr = m && prs.find((p) => norm(p.url) === norm(`https://${host}/${m[1]}/${m[2]}/pull/${m[3]}`));
    if (!pr) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
    const list = (pr.files || []).slice(0, 3000).map((f) => ({
      filename: f.path,
      status: f.changeType === "DELETED" ? "removed" : f.changeType === "ADDED" ? "added" : "modified",
    }));
    const size = Number(m[4]);
    const pages = [];
    for (let i = 0; i < list.length; i += size) pages.push(JSON.stringify(list.slice(i, i + size)));
    if (!argv.includes("--paginate")) pages.splice(1);
    return { status: 0, stdout: (pages.length ? pages : ["[]"]).join(""), stderr: "" };
  }
  // A bare `repo view --json url`: the project's own repository.
  if (argv[0] === "repo" && argv[1] === "view" && String(argv[2] ?? "").startsWith("-")) {
    if (fail.ownRepo !== undefined)
      return failed(fail.ownRepo, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    return { status: 0, stdout: JSON.stringify({ url: table.ownRepo ?? OWN_REPO }) + "\n", stderr: "" };
  }
  if (argv[0] === "repo" && argv[1] === "view") {
    if (fail.repo !== undefined) return failed(fail.repo, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const repo = norm(argv[2]);
    const name = (table.branches || {})[repo] ?? table.defaultBranch ?? "main";
    return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name } }) + "\n", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: `unknown command "${argv.join(" ")}" for "gh"\n` };
}

export function ghStub(dir, table = {}) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "gh");
  const script = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2);
const seen = Object.fromEntries(["GH_REPO", "GH_HOST"].map((k) => [k, process.env[k] ?? null]));
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED ?? null, env: seen, token: "GH_TOKEN" in process.env }) + "\\n");
import(${JSON.stringify(SELF)}).then(({ ghAnswer }) => {
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, "table.json"), "utf8"));
  const r = ghAnswer(argv, table);
  if (r.hang) { setInterval(() => {}, 1 << 30); return; }
  if (r.table) fs.writeFileSync(path.join(__dirname, "table.json"), JSON.stringify(r.table));
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status;
});
`;
  writeFileSync(bin, script, { mode: 0o755 });
  const stub = {
    bin,
    dir,
    set(t) {
      writeFileSync(join(dir, "table.json"), JSON.stringify(t));
      return stub;
    },
    // The table as the calls left it (pr create and pr close write it back).
    table() {
      return JSON.parse(readFileSync(join(dir, "table.json"), "utf8"));
    },
    log() {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    // The calls of one subcommand: "pr view", "pr list", "repo view", "api …".
    calls(sub) {
      return stub
        .log()
        .map((c) => c.argv)
        .filter((a) => a.slice(0, 2).join(" ") === sub);
    },
    reset() {
      rmSync(join(dir, "calls.jsonl"), { force: true });
      return stub;
    },
    // An environment whose PATH finds the stub first.
    env(base = process.env) {
      return { ...base, PATH: `${dir}${delimiter}${base.PATH || ""}` };
    },
  };
  return stub.set(table);
}

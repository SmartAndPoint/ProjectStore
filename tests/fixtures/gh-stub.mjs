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
//     fail: { view: {<url>: <exit>}, list: <exit>|"hang", repo: <exit>|"hang" } }
//
// `pr view` and `pr list` print only the fields --json names; `pr list
// --state closed --search "closed:>=<day>"` returns the merged and closed
// pull requests whose closedAt (else mergedAt) is on or after that day.

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = pathToFileURL(fileURLToPath(import.meta.url)).href;
const norm = (u) =>
  String(u ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

const after = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
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
    return { status: 0, stdout: JSON.stringify(pick(pr, fields)) + "\n", stderr: "" };
  }
  if (argv[0] === "pr" && argv[1] === "list") {
    if (fail.list !== undefined) return failed(fail.list, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const limit = Number(after(argv, "--limit") || 30);
    const state = after(argv, "--state") || "open";
    if (table.full) {
      const many = Array.from({ length: limit }, (_, i) => ({
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
      if (state === "open") return s === "OPEN";
      if (s === "OPEN") return false;
      const at = String(p.closedAt || p.mergedAt || "");
      return !since || at.slice(0, 10) >= since;
    });
    return { status: 0, stdout: JSON.stringify(list.slice(0, limit).map((p) => pick(p, fields))) + "\n", stderr: "" };
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
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
import(${JSON.stringify(SELF)}).then(({ ghAnswer }) => {
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, "table.json"), "utf8"));
  const r = ghAnswer(argv, table);
  if (r.hang) { setInterval(() => {}, 1 << 30); return; }
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
    // The calls of one subcommand: "pr view", "pr list", "repo view".
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

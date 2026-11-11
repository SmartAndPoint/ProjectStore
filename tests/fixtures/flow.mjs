// projectstore — test fixture: a vault with a flow policy and stories, and a
// git repository whose commits set their author and committer names and
// dates (PS-FLOW, "Doctor checks the flow against the vault's policy…").
//
// Stories are the bundled template, changed through the writers' own pure
// changes (applyStatusChange, applyAssigneeChange), so a stamp is trusted as
// a gate would leave it; a hand edit is setFm on the status alone. No name or
// address here is real: people are `First Last`-style names, and the one
// email-shaped word a privacy test needs is built at run time (ADDRESS), so
// none is written in this source.

import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadTemplate, renderTemplate } from "../../scripts/lib.mjs";
import { applyStatusChange, applyAssigneeChange, setFm, logLine, appendLogLine } from "../../scripts/status-log.mjs";
import { runVaultChecks } from "../../scripts/doctor.mjs";
import { FLOW_CHECKS } from "../../scripts/doctor-flow.mjs";
import { makeVaultProject } from "./vault.mjs";

// The as-of instant every doctor-run test passes: Wednesday 2026-11-11, noon.
export const NOW = "2026-11-11T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const DAY = 24 * 60 * 60 * 1000;
export const daysAgo = (n, from = NOW_MS) => new Date(from - n * DAY).toISOString();
export const dayOf = (iso) => iso.slice(0, 10);

// An email-shaped word, built so that no source line holds one.
export const ADDRESS = ["first.last", "mail.invalid"].join("@");

// One story's text. `log` is a list of status changes, each {to, at, reason?,
// actor?}, applied through the writer; `assignee` is set as the template
// writes it; `fm` sets further frontmatter keys as written (JSON for strings).
export function storyText({
  id,
  epic = "PS-X",
  created = "2026-09-01",
  updated = created,
  assignee = "",
  status = null,
  log = [],
  fm = {},
}) {
  let t = renderTemplate(loadTemplate("en", "story"), {
    id,
    title: id,
    date: created,
    author: assignee,
    tags: "[]",
    epic_id: epic,
  });
  for (const step of log) t = applyStatusChange(t, { reason: "r", actor: "move", ...step, at: step.at }).text;
  if (status !== null) t = setFm(t, "status", status);
  t = setFm(t, "updated", updated);
  for (const [k, v] of Object.entries(fm)) t = setFm(t, k, v);
  return t;
}

// A hand-written Status log line appended as a writer would (the
// `review → review` awaiting line of Flow counts contract 4, which no writer
// makes yet), with `status_changed_at` stamped to it.
export function withLine(text, { at, from, to, reason, actor = "follow", stamp = true }) {
  let t = appendLogLine(text, logLine({ at, field: "status", from, to, reason, actor }));
  if (stamp) t = setFm(t, "status_changed_at", JSON.stringify(at));
  return t;
}

export function handOver(text, { to, at }) {
  return applyAssigneeChange(text, { to, at, reason: "handed over", actor: "handover" }).text;
}

// A bound project with a vault: `.projectstore.json` holds `vaultCfg`
// (omitted when null), and `stories` maps `<EPIC>/<slug>` to its text.
export function flowVault({ vaultCfg = null, stories = {} } = {}) {
  const { proj, vault } = makeVaultProject();
  if (vaultCfg !== null) writeFileSync(join(vault, ".projectstore.json"), JSON.stringify(vaultCfg));
  const epics = new Set();
  for (const [ref, text] of Object.entries(stories)) {
    const [epic, slug] = ref.split("/");
    epics.add(epic);
    const path = join(vault, "epics", epic, "stories", `${slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  for (const epic of epics) {
    const p = join(vault, "epics", epic, "epic.md");
    writeFileSync(
      p,
      `---\ntype: epic\nid: "${epic}"\ntitle: "${epic}"\nstatus: in-progress\ncreated: 2026-01-01\n---\n\n# ${epic}\n`,
    );
  }
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  return { proj, vault, cfg };
}

// A `commits` seam that answers `answer` and counts its calls.
export function commitsSeam(answer = { status: "ok", commits: [] }) {
  const seam = (proj, since) => {
    seam.calls.push({ proj, since });
    return typeof answer === "function" ? answer(proj, since) : answer;
  };
  seam.calls = [];
  return seam;
}

// One commit as commitsSince returns it.
export const commit = ({ author = "First Last", at = NOW, committer = author, committedAt = at, paths = [] } = {}) => ({
  authorName: author,
  authorMs: Date.parse(at),
  committerName: committer,
  committerMs: Date.parse(committedAt),
  paths,
});

// Doctor's vault group over the fixture, as runVaultChecks runs it.
export function doctorRun(fx, { now = NOW, commits = commitsSeam() } = {}) {
  return runVaultChecks(fx.cfg, { proj: fx.proj, now, commits });
}
export const flowOnly = (findings) => findings.filter((f) => FLOW_CHECKS.includes(f.check));
export const ids = (findings) => flowOnly(findings).map((f) => f.check);
export const byCheck = (findings, check) => findings.filter((f) => f.check === check);

// ─── A real git repository ─────────────────────────────────────────────

// git with a clean environment: no inherited GIT_*, no developer signing, no
// global config. `env` adds the identity and dates of one commit.
export function git(cwd, args, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ps-flow-git-"));
  git(dir, ["init", "-q"]);
  return dir;
}

// One commit: `files` maps paths to contents (written and added); the
// author and committer each get a name, a mail word that is not an address,
// and a date.
export function gitCommit(
  dir,
  {
    files = {},
    message = "change",
    author = "First Last",
    authorMail = "nobody",
    at = NOW,
    committer = author,
    committerMail = authorMail,
    committedAt = at,
    extra = [],
  } = {},
) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
    git(dir, ["add", "--", p]);
  }
  git(
    dir,
    ["commit", "-q", "--allow-empty", ...extra, "-m", message],
    identity({ author, authorMail, at, committer, committerMail, committedAt }),
  );
  return git(dir, ["rev-parse", "HEAD"]);
}

export function identity({
  author,
  authorMail = "nobody",
  at,
  committer = author,
  committerMail = authorMail,
  committedAt = at,
}) {
  return {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: authorMail,
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_NAME: committer,
    GIT_COMMITTER_EMAIL: committerMail,
    GIT_COMMITTER_DATE: committedAt,
  };
}

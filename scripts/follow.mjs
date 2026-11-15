// projectstore — follow.mjs: the `follow` verb, a story's status that follows
// its pull request.
//
// `follow [--story <EPIC>/<id>] [--pr <n|url>] [--write] [--json]` reads,
// through `gh` (follow-gh.mjs, the one module that starts it), the pull
// requests that stories name, plans each story's change by the ADR's
// transition table (follow-plan.mjs, pure) and, with --write, applies it to
// the canonical vault: each story through replaceWithRetry (re-planned from
// the fresh bytes and the facts already read when the file changed since the
// read), its row in its epic's Stories table, the epic rule, then the derived
// views in-process, as `move` refreshes them. Bare, it prints the plan and
// writes nothing; with --write it reads the facts and the vault again, and a
// printed plan is never replayed. A merge closes its story through the close
// computation, unless doctor's own story checks on the closed bytes refuse
// it; then the story waits in review, awaiting close.
//
// Spec: "The follow verb: a merged pull request closes its story through the
// close computation, and a stale review goes back" (alias `follow`),
// contracts 1, 7 to 9; the PS-WT record spec's contract 5 (every replace
// records with the tool `follow`). Decision 2 of the follow ADR: no hook and
// no MCP module imports this file (tests/follow.test.mjs holds it).
//
// runFollow(ctx) follows move's contract: it returns {usage} or {ok, code,
// result, text}, and the bin (cli.mjs) prints and asks. Loaded lazily.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { packageCommand } from "./harness.mjs";
import { loadLayout, folderByKind, parseFrontmatter, fromTerminalIn, nowIso, readVaultConfig } from "./lib.mjs";
import { normaliseVaultPath, shellQuote, DEFAULT_LAYOUT, DEFAULT_LANGUAGE } from "./binding.mjs";
import { statusToColumn, NOT_ACTIONABLE } from "./stages.mjs";
import { stampMs } from "./status-log.mjs";
import { replaceWithRetry, syncEpicRow, CHANGED_MEANWHILE, EPIC_ROW_MISSING } from "./status-change.mjs";
import { nodeWriteRecorder, realRoot } from "./write-record.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { flowValue } from "./flow-policy.mjs";
import { applyEpicRule } from "./epic-rule.mjs";
import { resolveStory } from "./move.mjs";
import { defaultGit } from "./precommit.mjs";
import { scanArtifacts, storyCloseFindings } from "./doctor.mjs";
import { ghFacts } from "./follow-gh.mjs";
import { planStory, closesStoryRefs, isCounted, prUrlOf, prState, normUrl } from "./follow-plan.mjs";

const lower = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
const columnOf = (fm) => {
  const s = lower(fm.status);
  return NOT_ACTIONABLE.has(s) ? null : statusToColumn(s);
};
const firstLine = (s) =>
  String(s || "")
    .trim()
    .split("\n")[0]
    .trim();
const errMsg = (e) => (e && e.message ? e.message : String(e));
const PR_URL = /^https?:\/\/\S+\/pull\/(\d+)\/?$/;
const numberOf = (url) => (String(url).match(PR_URL) || [])[1] ?? null;

// ─── Branches (contract 8) ─────────────────────────────────────────────

// Whether a directory is inside a git working tree, by the `.git` entry git
// itself looks for: a vault outside git runs no git.
function inGitTree(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

// `git worktree list --porcelain`, as blocks {path, head, branch, bare}.
function worktrees(out) {
  const list = [];
  let cur = null;
  for (const line of String(out).split("\n")) {
    if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), head: null, branch: null, bare: false }));
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith("branch "))
      cur.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    else if (cur && line === "bare") cur.bare = true;
  }
  return list;
}

// Where a story's file is on a branch: a linked worktree of the vault's
// repository holds it at the same path from the repository's root, and that
// copy differs from the file at the merge-base of the worktree's HEAD and
// the canonical checkout's (read with `git cat-file --filters`, as the
// pre-commit check reads it), or the file is absent there. A failing
// merge-base or cat-file counts as on a branch; no copy, or a copy that
// only lags trunk, does not. `git worktree list` is read once. Returns
// {known: true, onBranch(abs) → reason|null} or {known: false, reason}.
export function branchReader(vault, git) {
  const none = { known: true, onBranch: () => null };
  if (!inGitTree(vault)) return none;
  const wt = git(vault, ["worktree", "list", "--porcelain"]);
  if (wt.kind === "no-git") return none;
  if (wt.kind !== "answer" || wt.status !== 0)
    return { known: false, reason: wt.reason || firstLine(wt.stderr) || `git worktree list exited ${wt.status}` };
  const top = git(vault, ["rev-parse", "--show-toplevel"]);
  const pre = git(vault, ["rev-parse", "--show-prefix"]);
  if (top.kind !== "answer" || top.status !== 0 || pre.kind !== "answer" || pre.status !== 0)
    return {
      known: false,
      reason: top.reason || pre.reason || firstLine(top.stderr || pre.stderr) || "git rev-parse failed",
    };
  const canon = realRoot(String(top.stdout).trim());
  const prefix = String(pre.stdout).trim();
  const all = worktrees(String(wt.stdout));
  const main = all.find((w) => realRoot(w.path) === canon) || null;
  const linked = all.filter((w) => w !== main && !w.bare);
  const bases = new Map();
  const baseOf = (w) => {
    if (!bases.has(w.path)) {
      let sha = null;
      if (w.head && main && main.head) {
        const r = git(vault, ["merge-base", w.head, main.head]);
        if (r.kind === "answer" && r.status === 0) sha = String(r.stdout).trim() || null;
      }
      bases.set(w.path, sha);
    }
    return bases.get(w.path);
  };
  return {
    known: true,
    onBranch(abs) {
      const rel = relative(vault, abs).split(sep).join("/");
      for (const w of linked) {
        const copy = join(w.path, prefix, rel);
        if (!existsSync(copy)) continue;
        const where = `the worktree ${w.path}${w.branch ? ` (${w.branch})` : ""}`;
        const sha = baseOf(w);
        if (!sha) return `${where} holds a copy, and git merge-base with the canonical checkout failed`;
        const blob = git(vault, ["cat-file", "--filters", `${sha}:${prefix}${rel}`]);
        if (blob.kind !== "answer" || blob.status !== 0) return `${where} added it, or git cat-file failed`;
        let bytes;
        try {
          bytes = readFileSync(copy);
        } catch (e) {
          return `${where}: its copy cannot be read (${errMsg(e)})`;
        }
        const base = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(String(blob.stdout));
        if (!base.equals(bytes)) return `${where} changed it`;
      }
      return null;
    },
  };
}

// ─── The facts (contract 2) ────────────────────────────────────────────

// The facts a run reads: the list (body lines), the view of each story's
// `external_refs.pr` in scope, the default branch of each repository a
// counted line or a merge needs. Returns {unavailable} (gh-unavailable:
// nothing is written), or {named, factsOf, branchOf, unreadable, unknown}:
// `unreadable` the run's pr-unreadable reason (no body line is used and no
// merge is judged), `unknown` the lines naming no story, as [{pr, ref, error}].
function readFacts({ gh, stories, scopeOf, since, vault, epicsPath }) {
  const out = { named: new Map(), unknown: [], unreadable: null };
  const stop = (r) => ({ unavailable: r.reason });
  const list = gh.list({ since });
  if (list.unavailable) return stop(list);
  const lines = [];
  if (!list.ok) out.unreadable = list.reason;
  else
    for (const pr of list.prs) {
      // A pull request closed without a merge is not read for lines: no link,
      // no conflict, no pr-story-unknown (the follow spec, contract 1, 2026-11-13).
      if (prState(pr) === "closed") continue;
      const refs = closesStoryRefs(pr.body);
      if (!refs.length) continue;
      const b = gh.defaultBranch(pr.url);
      if (b.unavailable) return stop(b);
      if (!b.ok) {
        out.unreadable = out.unreadable ?? b.reason;
        continue;
      }
      if (isCounted(pr, b.branch)) lines.push({ pr, refs });
    }
  // The links the lines make, each story's pull requests once.
  const resolved = new Map();
  const at = (ref) => {
    if (!resolved.has(ref)) resolved.set(ref, resolveStory(ref, { vault, epicsPath }));
    return resolved.get(ref);
  };
  const named = new Map();
  for (const { pr, refs } of lines)
    for (const ref of refs) {
      const r = at(ref);
      if (r.error) {
        out.unknown.push({ pr, ref, error: r.error });
        continue;
      }
      const key = resolve(r.path);
      const have = named.get(key) || [];
      if (!have.some((p) => normUrl(p.url) === normUrl(pr.url))) have.push(pr);
      named.set(key, have);
    }
  // The views, one per url, for the stories in scope that hold one.
  const facts = new Map();
  if (list.ok) for (const pr of list.prs) facts.set(normUrl(pr.url), { ok: true, pr });
  const viewed = new Map();
  for (const s of stories) {
    const col = columnOf(s.fm);
    if (col === null || col === "Done" || !scopeOf(s, named.get(s.abs) || [])) continue;
    const url = prUrlOf(s.text);
    if (!url || viewed.has(normUrl(url))) continue;
    const v = gh.view(url);
    if (v.unavailable) return stop(v);
    viewed.set(normUrl(url), v.ok ? { ok: true, pr: v.pr } : { ok: false, reason: v.reason });
  }
  for (const [k, v] of viewed) facts.set(k, v);
  // The default branch of every merge a story in scope may close by.
  for (const s of stories) {
    if (!scopeOf(s, named.get(s.abs) || [])) continue;
    const prs = [
      ...(named.get(s.abs) || []),
      ...[viewed.get(normUrl(prUrlOf(s.text)))].filter((v) => v && v.ok).map((v) => v.pr),
    ];
    for (const pr of prs) {
      if (prState(pr) !== "merged") continue;
      const b = gh.defaultBranch(pr.url);
      if (b.unavailable) return stop(b);
      if (!b.ok) out.unreadable = out.unreadable ?? b.reason;
    }
  }
  if (!out.unreadable) out.named = named;
  out.factsOf = (url) => facts.get(normUrl(url)) ?? null;
  out.branchOf = (url) => {
    if (out.unreadable) return null;
    const b = gh.defaultBranch(url);
    return b.ok ? b : null;
  };
  return out;
}

// ─── The text ──────────────────────────────────────────────────────────

function renderFollow(result, { project, args, asking = false, wrote = false }) {
  const lines = [];
  const n = result.checked;
  lines.push(`follow: ${n} ${n === 1 ? "story has" : "stories have"} a closing pull request`);
  const changes = result.items.filter((i) => i.line);
  if (changes.length) {
    lines.push("", wrote ? "Written:" : "Changes:");
    for (const i of changes)
      lines.push(
        `  ${i.story}: ${i.line.replace(/^- \S+ /, "")}${wrote && !i.written ? ` — not written: ${i.error}` : ""}`,
      );
  } else lines.push("", "No story changes.");
  const listed = (title, list) => {
    if (!list.length) return;
    lines.push("", title);
    for (const f of list) lines.push(`  ${f.code}: ${f.message}`);
  };
  listed("Findings:", result.findings);
  listed("Notes:", result.notes);
  const e = result.epics;
  if (e && (e.epics.length || e.notes.length || e.error)) {
    lines.push("", "Epics:");
    for (const x of e.epics) lines.push(`  ${x.line}`);
    for (const x of e.notes) lines.push(`  ${x.code} ${x.epic}: ${x.message}`);
    if (e.error) lines.push(`  ${e.error}`);
  }
  if (wrote && result.reconcile) lines.push("", `Derived views: ${result.reconcile.written ?? 0} regenerated.`);
  if (!wrote && !asking && changes.length)
    lines.push(
      "",
      `Nothing written. To apply it, ${project ? fromTerminalIn(project) : "from a terminal in this project"}:`,
      "",
      `  ${packageCommand([], "follow", { args: [...args, "--write"].join(" ") })}`,
    );
  return lines.join("\n") + "\n";
}

// ─── The verb ──────────────────────────────────────────────────────────

// The stories a plan closes, for the epic rule's plan.
const closesOf = (plans) => plans.filter(({ p }) => p.closes).map(({ s }) => s.abs);

export async function runFollow(ctx) {
  // now, ghTimeout, git and afterCompute(attempt, story) are the tests' seams; the bin never passes them.
  const { values, cfg, project, env, confirm, ownEnv, now: nowSeam = null, ghTimeout = null, git = null } = ctx;
  const afterCompute = ctx.afterCompute || null;
  let prArg = null;
  if (values.pr !== undefined) {
    const p = String(values.pr).trim();
    if (/^\d+$/.test(p)) prArg = { number: String(Number(p)) };
    else if (PR_URL.test(p)) prArg = { url: normUrl(p) };
    else return { usage: `--pr takes a pull request's number or url, such as --pr 42; "${values.pr}" is neither` };
  }
  if (values.story !== undefined && !String(values.story).trim())
    return { usage: "--story takes a story, such as --story PS-CORE/story-x" };
  const write = Boolean(values.write);
  const now = nowSeam || nowIso();
  const day = now.slice(0, 10);
  const args = [
    ...(values.story !== undefined ? ["--story", shellQuote(String(values.story))] : []),
    ...(values.pr !== undefined ? ["--pr", shellQuote(String(values.pr))] : []),
  ];
  const result = { write, checked: 0, items: [], findings: [], notes: [], epics: null, reconcile: null, error: null };
  const fail = (message) => ({
    ok: false,
    code: 1,
    result: { ...result, error: message },
    text: `follow: ${message}\n`,
  });

  const vault = normaliseVaultPath(cfg.vault_path, project);
  if (typeof vault !== "string" || !existsSync(vault))
    return fail(`the binding names no vault directory that is there (${cfg.vault_path})`);
  let layout;
  try {
    layout = loadLayout(cfg.layout || DEFAULT_LAYOUT);
  } catch (e) {
    return fail(errMsg(e));
  }
  const epics = folderByKind(layout, "epic");
  if (!epics) return fail(`layout ${cfg.layout} has no epic folder`);
  let only = null;
  if (values.story !== undefined) {
    const found = resolveStory(String(values.story).trim(), { vault, epicsPath: epics.path });
    if (found.error) return fail(found.error);
    only = resolve(found.path);
  }
  const lang = cfg.language || DEFAULT_LANGUAGE;
  const vaultCfg = readVaultConfig(vault);
  const ageReview = flowValue(vaultCfg, "age_days.review");
  const readStories = () =>
    readFlowStories(vault, epics.path).stories.map((s) => ({
      ...s,
      abs: resolve(join(vault, s.rel)),
      ref: `${s.epic}/${s.slug}`,
    }));
  const stories = readStories();

  // Which stories a narrowed run writes: the one --story names, those --pr links.
  const prMatches = (url) =>
    !prArg || (prArg.url ? normUrl(url) === prArg.url : numberOf(url) !== null && numberOf(url) === prArg.number);
  const scopeOf = (s, named) =>
    (!only || s.abs === only) &&
    (!prArg || [prUrlOf(s.text), ...named.map((p) => p.url)].some((u) => u && prMatches(u)));

  // The list's window: the oldest started_at, else created, of a story in
  // progress or in review; --story starts it at its own story's.
  const window = only
    ? stories.filter((s) => s.abs === only)
    : stories.filter((s) => ["In Progress", "Review"].includes(columnOf(s.fm)));
  const starts = window.map((s) => stampMs(s.fm.started_at) ?? stampMs(s.fm.created)).filter((ms) => ms !== null);
  const since = starts.length ? new Date(Math.min(...starts)).toISOString().slice(0, 10) : null;

  const gh = ghFacts({ cwd: project, env, ...(ghTimeout ? { timeout: ghTimeout } : {}) });
  const facts = readFacts({ gh, stories, scopeOf, since, vault, epicsPath: epics.path });
  const finding = (code, story, pr, message) => result.findings.push({ code, story, pr, message });
  const note = (code, story, pr, message) => result.notes.push({ code, story, pr, message });
  if (facts.unavailable) {
    finding(
      "gh-unavailable",
      null,
      null,
      `gh cannot be run: ${facts.unavailable}. Nothing is read and nothing is written.`,
    );
    return { ok: false, code: 1, result, text: renderFollow(result, { project, args }) };
  }
  if (facts.unreadable)
    finding(
      "pr-unreadable",
      null,
      null,
      `the pull requests cannot be listed in full: ${facts.unreadable}. No Closes-story line is used and no merge is judged.`,
    );
  for (const u of facts.unknown) {
    if (!prMatches(u.pr.url) || only) continue;
    const open = prState(u.pr) === "open";
    (open ? finding : note)("pr-story-unknown", null, u.pr.url, `Closes-story: ${u.ref} names no story: ${u.error}`);
  }

  // The refusal of a close: doctor's story checks on the vault with the
  // story's judged bytes (follow-plan.mjs closes them at the run time).
  const refusalFor = (s) => (judged) => {
    const cfgV = { ...cfg, vault_path: vault };
    const others = scanArtifacts(cfgV, layout).filter((a) => a.rel !== s.rel);
    const self = { abs: s.abs, rel: s.rel, kind: "story", fm: parseFrontmatter(judged).data, body: judged };
    return storyCloseFindings([...others, self], vaultCfg, layout).filter((f) => f.file === s.rel);
  };
  const optsOf = (s) => ({
    named: facts.named.get(s.abs) || [],
    factsOf: facts.factsOf,
    branchOf: facts.branchOf,
    now,
    day,
    lang,
    ageReview,
    refusal: refusalFor(s),
  });
  const plans = [];
  for (const s of stories) {
    if (!scopeOf(s, facts.named.get(s.abs) || [])) continue;
    let p;
    try {
      p = planStory(s.text, optsOf(s));
    } catch (e) {
      p = { content: s.text, judged: true, pr: prUrlOf(s.text), lines: [], notes: [], findings: [], error: errMsg(e) };
    }
    plans.push({ s, p });
  }

  // One story's plan into `into` ({checked, items, findings, notes}).
  const report = (into, s, p, { written = false, error = null } = {}) => {
    if (p.judged) into.checked++;
    const err = error ?? p.error ?? null;
    const item = (l) => ({ story: s.ref, path: s.abs, pr: p.pr, ...l, written, error: err });
    for (const l of p.lines)
      into.items.push(item({ from: l.from, to: l.to, reason: l.reason, line: l.line, at: l.at }));
    if (!p.lines.length && err) into.items.push(item({ from: null, to: null, reason: null, line: null, at: null }));
    for (const f of p.findings)
      into.findings.push({ code: f.code, story: s.ref, pr: f.pr, message: `${s.ref}: ${f.message}` });
    for (const f of p.notes)
      into.notes.push({ code: f.code, story: s.ref, pr: f.pr, message: `${s.ref}: ${f.message}` });
  };

  const epicsDir = join(vault, epics.path);
  if (!write) {
    for (const { s, p } of plans) report(result, s, p);
    result.epics = applyEpicRule({ epicsDir, write: false, assume: closesOf(plans), at: now });
    return finish(result, { project, args });
  }

  const shown = { ...result, checked: 0, items: [], findings: [...result.findings], notes: [...result.notes] };
  for (const { s, p } of plans) report(shown, s, p);
  // The question shows the epics the run would move: the rule as a plan, the closes assumed done.
  shown.epics = applyEpicRule({ epicsDir, write: false, assume: closesOf(plans), at: now });
  if (confirm && !(await confirm(renderFollow(shown, { project, args, asking: true }))))
    return { ok: false, code: 1, result: { ...result, declined: true }, text: "Nothing written.\n" };

  // Each write lands in this session's record of its vault writes (the record
  // spec, contract 5), with the tool `follow`.
  const onWrite = nodeWriteRecorder({ env, project, tool: "follow" });
  const branches = branchReader(vault, git || defaultGit(env));
  if (!branches.known)
    finding(
      "branches-unknown",
      null,
      null,
      `the vault's worktrees cannot be listed (${branches.reason}): a story a branch changed may be written on trunk.`,
    );
  for (const { s, p } of plans) {
    if (p.content === s.text || p.error) {
      report(result, s, p);
      continue;
    }
    const where = branches.known ? branches.onBranch(s.abs) : null;
    if (where) {
      finding("story-on-branch", s.ref, p.pr, `${s.ref}: ${where}; it is left for that branch to merge`);
      report(result, s, { ...p, findings: [] }, { error: "story-on-branch" });
      continue;
    }
    let last = p;
    const r = replaceWithRetry(
      s.abs,
      (base) => {
        last = planStory(base, optsOf(s));
        return { content: last.content };
      },
      { afterCompute: afterCompute ? (i) => afterCompute(i, s) : null, onWrite },
    );
    if (r.error === CHANGED_MEANWHILE) {
      finding(
        CHANGED_MEANWHILE,
        s.ref,
        p.pr,
        `${s.ref} changed before each of ${r.attempts} attempts; the file is left as its last editor left it. Run follow again.`,
      );
      report(result, s, { ...last, findings: [], notes: [] }, { error: CHANGED_MEANWHILE });
    } else report(result, s, last, { written: Boolean(r.written), error: r.error ?? null });
  }

  // Every judged story's row in its epic's Stories table, also when it did not change.
  for (const { s, p } of plans) {
    if (!p.judged) continue;
    const row = syncEpicRow(s.abs, { onWrite });
    if (row.error)
      finding("epic-row-error", s.ref, p.pr, `${s.ref}: its row in ${row.path} was not updated: ${row.error}`);
    else if (row.note === EPIC_ROW_MISSING)
      note(EPIC_ROW_MISSING, s.ref, p.pr, `${s.ref}: no row in its epic's Stories table links to it`);
  }
  result.epics = applyEpicRule({ epicsDir, write: true, at: now, onWrite });
  const { refreshViews } = await import("./reconcile.mjs");
  const { ownEnv: projectEnv } = await import("./verbs.mjs");
  const rec = refreshViews({ project, env: ownEnv ? ownEnv(project) : projectEnv(env, project) });
  result.reconcile = rec.summary;
  if (rec.failed) result.error = `the derived views are left${rec.error ? `: ${rec.error}` : ""}`;
  return finish(result, { project, args, wrote: true });
}

// The exit: 0 with notes only; 1 on a finding, an item's error, an epic's
// error or views left (contract 1).
function finish(result, { project, args, wrote = false }) {
  const e = result.epics;
  const failed =
    result.findings.length > 0 ||
    result.items.some((i) => i.error) ||
    Boolean(result.error) ||
    Boolean(e && (e.error || e.epics.some((x) => x.verdict === "error")));
  return {
    ok: !failed,
    code: failed ? 1 : 0,
    result,
    text: renderFollow(result, { project, args, wrote }),
  };
}

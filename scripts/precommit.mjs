// projectstore — precommit.mjs
//
// A session's vault pre-commit check: the spec "A session's vault pre-commit
// check: its own writes traced from HEAD, and the stop" (alias precommit).
// `projectstore session check [<path>…]` runs it; `/projectstore:precommit`
// is its command.
//
// For each changed vault file it asks whether the file now can be reached
// from HEAD's content over the session's own recorded writes (the record,
// write-record.mjs): a set of before→after content pairs, walked in any
// order. A file it cannot reach carries a change the session did not make,
// and is named after the live session whose activity claims it, else
// unattributed. Derived views are judged by the files that feed them.
//
// It reads git in the vault's repository through one injected seam (`git`,
// whose default is gitRun with the stripped environment and optional locks
// off) and runs only `rev-parse`, `status` and `cat-file`, written below as
// `git(root, [...])` so tests/disclosure.test.mjs reads every call. It writes
// nothing: not the working tree, not the index, not the record. ProjectStore
// still commits nothing.
//
// Exported for the planned "Canonical git operations are serialized and
// refuse to run over foreign dirt" (PS-WT): the per-file judge (judgeFile)
// and the peer claim (peerClaims).

import { existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { vaultLocation, vaultRootOf, readActiveSessions, isWriteTool, loadLayout, derivedViewPaths } from "./lib.mjs";
import { readEvents, readBlob, hasRecord, hashOf, readFileBytes, realRoot } from "./write-record.mjs";
import { gitRun } from "./diff-refs.mjs";
import { gitEnv, DEFAULT_LAYOUT } from "./binding.mjs";
import { indexTableBounds } from "./reconcile.mjs";

export const HUNK_LINES = 10;
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const DIFF_CELLS = 4_000_000;

// The default seam: git in `root` with nothing that locates another
// repository, optional locks off (gitRun), and the runner's time limit.
export function defaultGit(env = process.env, { timeout = 10000 } = {}) {
  const clean = gitEnv(env);
  return (root, args) => gitRun(root, args, { env: clean, timeout });
}

// ─── Reachability (contract 1) ─────────────────────────────────────────

// Every state a chain of pairs reaches from `starts`, in any order of the
// pairs; a cycle ends.
export function closure(starts, pairs) {
  const next = new Map();
  for (const p of pairs) {
    if (!next.has(p.before)) next.set(p.before, []);
    next.get(p.before).push(p.after);
  }
  const reached = new Set(starts);
  const queue = [...reached];
  while (queue.length) {
    const s = queue.shift();
    for (const a of next.get(s) || [])
      if (!reached.has(a)) {
        reached.add(a);
        queue.push(a);
      }
  }
  return reached;
}

// The judge over content hashes (null is an absent file). `heads` are the
// forms of HEAD's content, `now` the state being judged. Own exactly when a
// chain leads from HEAD to it. Otherwise the gaps: a pair's before that is
// neither HEAD's content nor any pair's after, and the state now when it is no
// pair's after; each with the states it is diffed against, HEAD's content and
// the afters no chain from that gap reaches. With no such gap, the state now,
// against every reachable state. Gaps that lead to the state now come first.
export function judgeStates(heads, pairs, now) {
  const reached = closure(heads, pairs);
  if (reached.has(now)) return { own: true, reached, gaps: [] };
  const headSet = new Set(heads);
  const afters = [...new Set(pairs.map((p) => p.after))];
  const afterSet = new Set(afters);
  const states = [];
  for (const p of pairs)
    if (!headSet.has(p.before) && !afterSet.has(p.before) && !states.includes(p.before)) states.push(p.before);
  if (!afterSet.has(now) && !states.includes(now)) states.push(now);
  if (!states.length)
    return { own: false, reached, gaps: [{ state: now, in: "file", against: [...reached], leads: true }] };
  const gaps = states.map((g) => {
    const from = closure([g], pairs);
    const against = [...new Set([...heads, ...afters.filter((a) => !from.has(a))])].filter((s) => s !== g);
    return { state: g, in: g === now ? "file" : "recorded", against, leads: from.has(now) };
  });
  gaps.sort((a, b) => Number(b.leads) - Number(a.leads));
  return { own: false, reached, gaps };
}

// ─── Line diff (the hunks) ─────────────────────────────────────────────

const isText = (bytes) => !bytes.includes(0);
const linesOf = (bytes) => bytes.toString("utf8").split("\n");

// The fewest differing lines from `a` to `b`, as hunks ranged in `b`:
// {distance, hunks: [{start, count, lines}]}, each line "- " (only in a) or
// "+ " (only in b). The common head and tail are trimmed first; a middle too
// large for the table is one replacement.
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops = [];
  if ((am.length + 1) * (bm.length + 1) > DIFF_CELLS) {
    for (const l of am) ops.push(["-", l]);
    for (const l of bm) ops.push(["+", l]);
  } else {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push(["=", am[i]]);
        i++;
        j++;
      } else if (i < n && (j === m || t[(i + 1) * w + j] >= t[i * w + j + 1])) {
        ops.push(["-", am[i]]);
        i++;
      } else {
        ops.push(["+", bm[j]]);
        j++;
      }
    }
  }
  const hunks = [];
  let line = pre + 1;
  let cur = null;
  let distance = 0;
  for (const [op, text] of ops) {
    if (op === "=") {
      cur = null;
      line++;
      continue;
    }
    distance++;
    if (!cur) {
      cur = { start: line, count: 0, lines: [] };
      hunks.push(cur);
    }
    cur.lines.push(`${op} ${text}`);
    if (op === "+") {
      cur.count++;
      line++;
    }
  }
  return { distance, hunks };
}

const rangeOf = (h) => (h.count > 1 ? `${h.start}-${h.start + h.count - 1}` : `${h.start}`);

// One gap's hunks, against the nearest of its states by fewest differing
// lines. `content(hash)` is the bytes of a state, or undefined when the
// record did not keep it: then the hunk gives no lines (content-not-kept).
export function gapHunks(gap, content) {
  const blank = [{ range: null, in: gap.in, lines: [], more: 0 }];
  const mine = content(gap.state);
  const theirs = gap.against.map((s) => content(s));
  if (mine === undefined || theirs.some((c) => c === undefined)) return { hunks: blank, notKept: true };
  if (!isText(mine) || theirs.some((c) => !isText(c))) return { hunks: blank, notKept: false };
  const b = linesOf(mine);
  let best = null;
  for (const c of theirs.length ? theirs : [Buffer.alloc(0)]) {
    const d = lineDiff(linesOf(c), b);
    if (!best || d.distance < best.distance) best = d;
  }
  return {
    notKept: false,
    hunks: best.hunks.map((h) => ({
      range: rangeOf(h),
      in: gap.in,
      lines: h.lines.slice(0, HUNK_LINES),
      more: Math.max(0, h.lines.length - HUNK_LINES),
    })),
  };
}

// ─── The peer claim (contract 4) ───────────────────────────────────────

// Each path another live session claims, by `<real root>\0<rel>`: a
// write-family entry for it in that session's recent_activity, matched
// through vaultLocation. A claimer is named by the first eight characters of
// its id, its host and its last activity.
export function peerClaims(vaultPath, sid) {
  const out = new Map();
  let peers = [];
  try {
    peers = readActiveSessions(vaultPath, sid);
  } catch {}
  for (const s of peers) {
    const seen = new Set();
    for (const e of Array.isArray(s.recent_activity) ? s.recent_activity : []) {
      if (!e || typeof e.path !== "string" || !isWriteTool(e.tool || "")) continue;
      const loc = vaultLocation(e.path, vaultPath);
      if (!loc || !loc.rel) continue;
      const key = `${realRoot(loc.root)}\0${loc.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({
        session: String(s.id || "").slice(0, 8),
        host: s.host || null,
        last_active: s.last_active ? new Date(s.last_active).toISOString() : null,
      });
    }
  }
  return out;
}

// ─── One copy ──────────────────────────────────────────────────────────

const firstLine = (s) =>
  String(s || "")
    .trim()
    .split("\n")[0];
const unknown = (reason) => ({ git: "unknown", reason });

// What git says of one copy: {git: "ok", prefix, hasHead, entries} or the
// copy's verdict (no-git, merge-open, unknown with a reason).
function readCopy(root, git) {
  const pre = git(root, ["rev-parse", "--show-prefix"]);
  if (pre.kind === "no-git") return { git: "no-git" };
  if (pre.kind === "failure") return unknown(pre.reason);
  if (pre.status !== 0) return unknown(firstLine(pre.stderr) || `git rev-parse exited ${pre.status}`);
  const prefix = pre.stdout.toString("utf8").trim();
  const merge = git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (merge.kind !== "answer") return unknown(merge.reason || "git rev-parse failed");
  if (merge.status === 0) return { git: "merge-open" };
  const head = git(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (head.kind !== "answer") return unknown(head.reason || "git rev-parse failed");
  const st = git(root, ["status", "--porcelain=v1", "-z", "-uall", "--no-renames", "--", "."]);
  if (st.kind !== "answer") return unknown(st.reason || "git status failed");
  if (st.status !== 0) return unknown(firstLine(st.stderr) || `git status exited ${st.status}`);
  const entries = [];
  for (const raw of st.stdout.toString("utf8").split("\0")) {
    if (raw.length < 4) continue;
    const xy = raw.slice(0, 2);
    const path = raw.slice(3);
    // A nested repository (a worktree kept inside the vault folder) is a copy
    // of its own, not a file of this one.
    if (path.endsWith("/") || !path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (UNMERGED.has(xy)) return unknown(`an unmerged path: ${rel}`);
    entries.push({ x: xy[0], y: xy[1], rel });
  }
  return { git: "ok", prefix, hasHead: head.status === 0, entries };
}

// Both forms a blob is read in: as stored, and as checked out (the smudge
// filters and line-ending conversion a checkout applies). A state equal to
// either counts. Throws a read the check cannot answer.
function blobForms(root, git, spec) {
  const answer = (r, what) => {
    if (r.kind !== "answer" || r.status !== 0)
      throw Object.assign(new Error(r.reason || firstLine(r.stderr) || `git cat-file ${what} ${spec} failed`), {
        unknown: true,
      });
    return r.stdout;
  };
  const stored = answer(git(root, ["cat-file", "blob", spec]), "blob");
  const checkedOut = answer(git(root, ["cat-file", "--filters", spec]), "--filters");
  return [stored, checkedOut];
}

// The per-file judge (contracts 1 to 3). `file` = {rel, w, heads, staged,
// index}: the bytes now (null absent), HEAD's forms (null absent), whether the
// index differs from HEAD and its forms. `pairs` are the session's for this
// path; `content` maps a hash to bytes or undefined.
export function judgeFile({ w, heads, staged, index }, pairs, content) {
  const headHashes = heads.map((b) => hashOf(b));
  const wHash = hashOf(w);
  const j = judgeStates(headHashes, pairs, wHash);
  const reasons = [];
  if (!j.own) reasons.push("unreached");
  const indexOwn = !staged || index.some((b) => j.reached.has(hashOf(b)));
  if (!indexOwn) reasons.push("staged");
  let hunks = [];
  if (!j.own) {
    let notKept = false;
    for (const gap of j.gaps) {
      const g = gapHunks(gap, content);
      hunks.push(...g.hunks);
      notKept = notKept || g.notKept;
    }
    if (notKept) reasons.push("content-not-kept");
  }
  return { own: j.own && indexOwn, reasons, hunks };
}

// A folder README's prose: its content with the managed rows removed.
function proseOf(bytes) {
  if (bytes === null) return null;
  const lines = bytes.toString("utf8").split("\n");
  const b = indexTableBounds(lines);
  if (b.unusable) return bytes;
  return Buffer.from([...lines.slice(0, b.headIdx + 2), ...lines.slice(b.end)].join("\n"), "utf8");
}

// Null-safe: a folder README staged and then deleted (`AD`) has no content
// in the working tree or in HEAD.
const hasTable = (bytes) => Buffer.isBuffer(bytes) && !indexTableBounds(bytes.toString("utf8").split("\n")).unusable;

function judgeCopy({ root, real, selected, git, layout, project, sid, recorded, events, claims }) {
  const read = readCopy(root, git);
  const copy = { root, git: read.git, checked: 0, foreign: 0, files: [] };
  if (read.reason) copy.reason = read.reason;
  if (read.git !== "ok") return copy;

  const pairsOf = (rel) =>
    events.filter((e) => e.root === real && e.rel === rel).map((e) => ({ before: e.before, after: e.after }));
  const claimersOf = (rel) => claims.get(`${real}\0${rel}`) || [];
  const known = new Map();
  const content = (h) => {
    if (h === null) return Buffer.alloc(0);
    if (known.has(h)) return known.get(h);
    const b = sid ? readBlob(project, sid, h) : null;
    return b === null ? undefined : b;
  };
  const views = derivedViewPaths(layout);
  const globals = new Set([views.board, views.codeMap, views.graph].filter(Boolean));
  const indexes = new Map(views.indexes.map((x) => [x.path, x.folder]));
  const underLayout = (rel) => layout.folders.some((f) => rel.startsWith(`${f.path}/`));

  // Every changed path is read and judged: a view's verdict needs its sources
  // even when the person named other paths.
  const states = [];
  try {
    for (const e of read.entries) {
      const spec = `${read.prefix}${e.rel}`;
      const inHead = read.hasHead && e.x !== "A" && e.x !== "?" && e.y !== "A";
      const heads = inHead ? blobForms(root, git, `HEAD:${spec}`) : [null];
      const staged = e.x !== " " && e.x !== "?";
      const index = !staged ? [] : e.x === "D" ? [null] : blobForms(root, git, `:${spec}`);
      const w = readFileBytes(join(root, e.rel));
      for (const b of [w, ...heads, ...index]) if (b !== null) known.set(hashOf(b), b);
      states.push({ rel: e.rel, w, heads, staged, index });
    }
  } catch (err) {
    return { ...copy, git: "unknown", reason: err.unknown ? err.message : String(err.message || err) };
  }

  const byRel = new Map();
  // Decided once per path: a view is never a source of another view.
  const viewRels = new Set(
    states
      .filter(
        (s) =>
          globals.has(s.rel) || (indexes.has(s.rel) && hasTable(s.w ?? s.heads.find((h) => h !== null) ?? s.index[0])),
      )
      .map((s) => s.rel),
  );
  const isView = (s) => viewRels.has(s.rel);
  for (const s of states) {
    if (isView(s)) continue;
    const j = judgeFile(s, pairsOf(s.rel), content);
    byRel.set(s.rel, {
      path: s.rel,
      verdict: j.own ? "own" : null,
      staged: s.staged,
      claimed_by: [],
      hunks: j.hunks,
      reasons: j.reasons,
    });
  }
  const name = (f) => {
    if (f.verdict === "own") return f;
    f.claimed_by = claimersOf(f.path);
    f.verdict = f.claimed_by.length ? "another-writer" : "unattributed";
    return f;
  };
  for (const f of byRel.values()) name(f);
  // The files the views are fed by, judged before any view joins byRel: a view
  // already judged `consistent` is not a foreign source of the next one.
  const sources = [...byRel.values()];

  // Views (contract 5): consistent when no changed file that feeds them is
  // foreign; a folder index's prose is judged over the session's pairs.
  for (const s of states) {
    if (!isView(s)) continue;
    const folder = globals.has(s.rel) ? null : indexes.get(s.rel);
    const feeds = (rel) => {
      if (!folder) return underLayout(rel);
      if (folder.kind === "epic") return new RegExp(`^${escapeRe(folder.path)}/[^/]+/epic\\.md$`).test(rel);
      return rel.startsWith(`${folder.path}/`) && !rel.slice(folder.path.length + 1).includes("/");
    };
    const feeders = sources.filter((f) => feeds(f.path));
    const foreignFeeders = feeders.filter((f) => f.verdict !== "own");
    const reasons = [];
    let proseOwn = true;
    if (folder) {
      const pw = proseOf(s.w);
      const ph = s.heads.map((h) => proseOf(h));
      if (!ph.some((h) => hashOf(h) === hashOf(pw))) {
        let notKept = false;
        const proseHash = (h) => {
          if (h === null) return null;
          const c = content(h);
          if (c === undefined) {
            notKept = true;
            return `not-kept:${h}`;
          }
          return hashOf(proseOf(c));
        };
        const pairs = pairsOf(s.rel).map((p) => ({ before: proseHash(p.before), after: proseHash(p.after) }));
        if (notKept) {
          proseOwn = false;
          reasons.push("content-not-kept");
        } else proseOwn = closure(ph.map(hashOf), pairs).has(hashOf(pw));
        if (!proseOwn) reasons.unshift("unreached");
      }
    }
    const file = {
      path: s.rel,
      verdict: "consistent",
      staged: s.staged,
      claimed_by: [],
      hunks: [],
      reasons,
      rule: "sources",
      fed_by: (foreignFeeders.length || !proseOwn ? foreignFeeders : feeders).map((f) => f.path),
    };
    if (foreignFeeders.length || !proseOwn) {
      const seen = new Set();
      for (const c of [...foreignFeeders.flatMap((f) => f.claimed_by), ...(proseOwn ? [] : claimersOf(s.rel))]) {
        if (seen.has(c.session)) continue;
        seen.add(c.session);
        file.claimed_by.push(c);
      }
      file.verdict = file.claimed_by.length ? "another-writer" : "unattributed";
    }
    byRel.set(s.rel, file);
  }

  for (const s of states) {
    const f = byRel.get(s.rel);
    if (!sid) {
      f.verdict = "unattributed";
      f.claimed_by = [];
      if (!f.reasons.includes("no-session")) f.reasons.push("no-session");
    } else if (!recorded && f.verdict !== "own" && f.verdict !== "consistent") f.reasons.push("no-record");
    // With paths, those are judged, and every staged path besides: a commit
    // takes the whole index unless it names its paths (contract 8).
    if (selected && !selected.has(s.rel) && !s.staged) continue;
    copy.files.push(f);
  }
  copy.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  copy.checked = copy.files.length;
  copy.foreign = copy.files.filter((f) => f.verdict !== "own" && f.verdict !== "consistent").length;
  return copy;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── The check (contracts 6 to 10) ─────────────────────────────────────

export const LAST = Object.freeze({
  stop: "Do not commit; tell the person.",
  foreign: "Do not commit those files: commit your own by naming their paths, and tell the person what you left out.",
  commit: "Commit now, naming the paths: the check saw the files only as they were.",
  noSession:
    "The host gives no session id, so this check cannot tell this session's files from others': ask the person what to commit.",
  nothing: "Nothing to commit in the vault.",
  noGit: "Nothing checked: the vault is not in a git repository.",
});

// runPrecommit({project, cfg, sid, paths, env, git}) → {result, exit, text}
// or {usage} for a path outside every copy of the vault (exit 2).
export function runPrecommit({ project, cfg, sid = null, paths = [], env = process.env, git = null }) {
  const g = git || defaultGit(env);
  const vault = vaultRootOf(cfg.vault_path);
  const vaultReal = realRoot(vault);
  const events = sid ? readEvents(project, sid) : [];
  const recorded = sid ? hasRecord(project, sid) : false;
  let layout;
  try {
    layout = loadLayout(cfg.layout || DEFAULT_LAYOUT);
  } catch {
    layout = { folders: [], kanban: null };
  }

  // The copies: with paths, those the paths are in; with none, the bound vault
  // and every worktree of it the session's record names.
  const copies = new Map();
  const add = (root, real) => {
    if (!copies.has(real)) copies.set(real, { root, real, selected: null });
    return copies.get(real);
  };
  if (paths.length) {
    for (const p of paths) {
      const abs = isAbsolute(p) ? resolve(p) : resolve(vault, p);
      const loc = vaultLocation(abs, vault);
      if (!loc || !loc.rel)
        return { usage: `${p} is not inside the bound vault (${vault}) or a worktree of it`, path: p };
      const c = add(loc.root, realRoot(loc.root));
      (c.selected ||= new Set()).add(loc.rel);
    }
  } else {
    add(vault, vaultReal);
    for (const root of new Set(events.map((e) => e.root))) {
      if (root === vaultReal || !existsSync(root)) continue;
      const loc = vaultLocation(join(root, ".projectstore-probe"), vault);
      if (loc && realRoot(loc.root) === root) add(root, root);
    }
  }

  const claims = sid ? peerClaims(vault, sid) : new Map();
  const out = [];
  for (const c of copies.values())
    out.push(judgeCopy({ ...c, git: g, layout, project, sid, recorded, events, claims }));

  const bad = out.some((c) => c.git === "merge-open" || c.git === "unknown");
  const foreign = out.some((c) => c.foreign > 0);
  const listed = out.reduce((n, c) => n + c.files.length, 0);
  const exit = bad || foreign ? 1 : 0;
  const last = bad
    ? LAST.stop
    : !sid && listed
      ? LAST.noSession
      : foreign
        ? LAST.foreign
        : listed
          ? LAST.commit
          : out.some((c) => c.git === "no-git")
            ? LAST.noGit
            : LAST.nothing;
  const result = { session: sid, copies: out };
  return { result, exit, last, text: render(result, { vaultReal, sid, recorded, last }) };
}

function describe(f) {
  const bits = [];
  if (f.staged) bits.push("staged");
  if (f.verdict === "another-writer")
    bits.push(
      f.claimed_by
        .map(
          (c) =>
            `session ${c.session}${c.host ? ` on ${c.host}` : ""}${c.last_active ? `, active ${c.last_active}` : ""}`,
        )
        .join("; "),
    );
  if (f.rule) bits.push(`a view, judged by its sources${f.fed_by.length ? `: ${f.fed_by.join(", ")}` : ""}`);
  if (f.reasons.includes("staged")) bits.push("its staged content is not this session's");
  const h = f.hunks[0];
  if (h)
    bits.push(
      h.range === null
        ? `a hunk ${h.in === "file" ? "in the file now" : "in a recorded state"}, no lines${f.reasons.includes("content-not-kept") ? " (content not kept)" : ""}`
        : `first hunk at line ${h.range} ${h.in === "file" ? "in the file now" : "in a recorded state"}: ${h.lines[0] || ""}`,
    );
  return bits.length ? ` — ${bits.join("; ")}` : "";
}

function render(result, { vaultReal, sid, recorded, last }) {
  const lines = [];
  if (!sid) lines.push("No session id from the host: every changed file is unattributed.");
  else if (!recorded)
    lines.push(
      `Session ${sid.slice(0, 8)} has no record of vault writes: a fork starts with none, a record idle for 24 hours is reaped, and some writes no hook sees.`,
    );
  for (const c of result.copies) {
    const which = realRoot(c.root) === vaultReal ? "the bound vault" : "a worktree of the vault";
    if (c.git === "no-git") lines.push(`${c.root} (${which}): not in a git repository; nothing checked.`);
    else if (c.git === "merge-open")
      lines.push(`${c.root} (${which}): a merge is open in its repository; a commit now would conclude it.`);
    else if (c.git === "unknown") lines.push(`${c.root} (${which}): cannot tell: ${c.reason}.`);
    else {
      lines.push(`${c.root} (${which}): ${c.checked} changed, ${c.foreign} not this session's own.`);
      for (const f of c.files) lines.push(`  ${f.verdict.padEnd(14)} ${f.path}${describe(f)}`);
    }
  }
  lines.push(last);
  return lines.join("\n") + "\n";
}

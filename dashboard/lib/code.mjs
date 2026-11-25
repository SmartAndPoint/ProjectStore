// The Code block's read: what the project's code says about a story or a spec
// (the spec "The dashboard's Code block: a story's pull requests by the
// strength of each link, and a spec's files, read from the local repository",
// alias `dashboard-code`).
//
//   openCode({ reader, now }) → { read(ctx, { rel, fresh }) → { status, result | error } }
//
// This file names every call of the read and starts none: each goes through
// the write module's `reader` (lib/write.mjs), which marks it as the read's
// and refuses any call off its list (contract 9). Every git call runs in the
// project, with `core.quotePath=false` and GIT_NO_LAZY_FETCH=1; `log`, `show`
// and `diff` carry `--no-renames` and `--no-show-signature` where git takes
// it. Nothing is fetched and nothing is written: the repository is read as it
// was last fetched, and the answer says how far behind its checkout is.
//
// A pull request is tied to a story in one of these ways, strongest first
// (contract 4). The first two are the links the follow verb counts; the rest
// are leads:
//   recorded          the story's external_refs.pr names it
//   closes            a `Closes-story:` line of its description names the story, and follow would count it
//   closes-uncounted  such a line that follow would not count (a fork, another base, closed unmerged)
//   named             its title or description holds the story's title
//   mentioned         the story's text names its number
//   derived           a commit it brought in touched the story's code paths while the story was open
//
// A pull request's description is read here, in memory, for a story's title
// and its `Closes-story:` lines, and is never written to a file or sent to
// the page (contract 3).

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { readableRel, epicsPathOf } from "./state.mjs";
import { redactUrls } from "./write.mjs";

export const LIST_LIMIT = 1000;
export const KEEP_MS = 10 * 60 * 1000;
export const MAX_COMMITS = 300;
export const SHOWN_COMMITS = 80;
export const TITLE_MIN = 12;
export const SPEC_PRS = 40;
export const LIST_FIELDS = "number,title,body,state,url,mergedAt,isCrossRepository,baseRefName,mergeCommit";
const WINDOWS = "the code side is not read on Windows";
// The ties, strongest first (contract 7's order).
export const TIES = Object.freeze(["recorded", "closes", "closes-uncounted", "named", "mentioned", "derived"]);
const LINKS = new Set(["recorded", "closes"]);

const lines = (s) => String(s ?? "").split("\n").filter((l) => l.trim());
const firstLine = (s) => redactUrls(String(s ?? "").trim().split("\n")[0].trim()).slice(0, 200);
const said = (r, what) => (r.reason ? redactUrls(String(r.reason).split("\n")[0]).slice(0, 200) : `${what} failed`);

// ── two rules of the core, repeated here (the spec's How we solve) ──

// The diff-refs module's sinceWindow: a bare day gets midnight, so git does
// not read it as that day at the current time.
export function sinceWindow(since) {
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since} 00:00:00` : since;
}

// The move verb's resolveStory: `<EPIC-ID>/<story-id>` is the best tier of
// storyMatchesEntry among the epic's stories; several hits name none.
export function resolveStory(arg, { vault, epicsPath }, lib) {
  const m = String(arg).match(/^([^/]+)\/(.+)$/);
  if (!m) return { error: `name the story as <EPIC-ID>/<story-id>, such as PS-CORE/story-x; "${arg}" names none` };
  const [, epic, id] = m;
  const epicDir = join(vault, epicsPath, epic);
  let best = 0;
  let hits = [];
  for (const s of lib.listEpicStories(epicDir)) {
    let fm;
    try {
      fm = lib.parseFrontmatter(readFileSync(s.abs, "utf8")).data;
    } catch {
      continue;
    }
    const tier = lib.storyMatchesEntry(id, { id: fm.id ?? null, stem: s.slug });
    if (!tier) continue;
    if (!best || tier < best) {
      best = tier;
      hits = [s];
    } else if (tier === best) hits.push(s);
  }
  if (!hits.length) return { error: `no story in ${epicsPath}/${epic} matches "${id}"` };
  if (hits.length > 1) return { error: `"${arg}" names ${hits.length} stories: ${hits.map((h) => h.rel).join(", ")}; qualify it` };
  return { path: hits[0].abs, ref: `${epic}/${id}` };
}

// ── small readers ──

// Lower case, runs of white space as one space, curly quotes as straight ones.
export const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// A story's code paths (contract 10): the core's one-line JSON array; else a
// block list; else a one-line list with no quotes.
export function refsOf(text, fm, lib) {
  const json = lib.listOf(fm, "code_refs");
  if (json.length) return { refs: json, form: "json" };
  const head = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
  const unquote = (l) => l.trim().replace(/^(["'])(.*)\1$/, "$2");
  const block = head.match(/^code_refs:[ \t]*\r?\n((?:[ \t]+-[ \t]+.*(?:\r?\n|$))+)/m)?.[1];
  if (block) return { refs: lines(block).map((l) => unquote(l.replace(/^[ \t]+-[ \t]+/, ""))).filter(Boolean), form: "block" };
  const bare = head.match(/^code_refs:[ \t]*\[(.+)\][ \t]*$/m)?.[1];
  if (bare) return { refs: bare.split(",").map(unquote).filter(Boolean), form: "bare" };
  return { refs: [], form: "json" };
}

// A code path the read cannot hand git: absolute, or out of the repository.
const outside = (ref) => {
  const r = String(ref);
  if (isAbsolute(r) || /^[a-z]:/i.test(r) || r.includes("\0")) return true;
  const n = posix.normalize(r.replace(/^\.\//, ""));
  return n === ".." || n.startsWith("../");
};

// The literal folder before a glob's first `*` or `?`, or the path itself;
// "" when the glob starts at the top.
const narrowing = (ref, codeRefs) => {
  const r = codeRefs.normalRef(ref);
  if (!codeRefs.isGlobRef(r)) return r.replace(/\/+$/, "");
  const head = r.slice(0, r.search(/[*?]/));
  return head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
};
const pathspecs = (refs, codeRefs) => {
  const heads = refs.map((r) => narrowing(r, codeRefs));
  return heads.some((h) => !h) ? [] : [...new Set(heads)].map((h) => `:(literal)${h}`);
};

// A stamp of a story, as git reads it: a bare day is the whole day in UTC.
const dayStart = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
const dayEnd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59Z` : v);
const stamp = (v) => (v === null || v === undefined || v === "" || v === "null" ? null : String(v));

// The repository a pull request's url belongs to: `owner/name`.
const repoOfUrl = (url) => String(url ?? "").match(/^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+\/?$/i)?.[1] ?? null;
const numberOfUrl = (url) => Number(String(url ?? "").match(/(\d+)\/?\s*$/)?.[1]) || null;

// A small min-heap of numbers.
function heap() {
  const a = [];
  return {
    get size() {
      return a.length;
    },
    push(v) {
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p] <= a[i]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && a[l] < a[m]) m = l;
          if (r < a.length && a[r] < a[m]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    },
  };
}

// The commits reachable from `merge` and not from its first parent, as
// `<first parent>..<merge>`: painted down the history in topological order,
// stopping once only commits reachable from the first parent are left.
export function rangeOf(merge, graph) {
  const at = graph.index;
  const P1 = 1;
  const P2 = 2;
  const flag = new Map();
  const pending = new Set();
  const q = heap();
  let interesting = 0; // pending commits not reachable from the first parent
  const mark = (h, f) => {
    if (!at.has(h)) return;
    const had = flag.get(h) || 0;
    const now = had | f;
    if (now === had) return;
    flag.set(h, now);
    if (!pending.has(h)) {
      pending.add(h);
      q.push(at.get(h));
      if (!(now & P1)) interesting++;
    } else if (!(had & P1) && now & P1) interesting--;
  };
  const c = graph.commits[at.get(merge)];
  mark(c.parents[0], P1);
  for (const p of c.parents.slice(1)) mark(p, P2);
  const out = [];
  // Topological order: a commit is taken only after every child that could mark it.
  while (q.size && interesting > 0) {
    const commit = graph.commits[q.pop()];
    if (!pending.has(commit.hash)) continue;
    pending.delete(commit.hash);
    const f = flag.get(commit.hash);
    if (!(f & P1)) {
      interesting--;
      out.push(commit.hash);
    }
    for (const p of commit.parents) mark(p, f & P1 ? P1 : P2);
  }
  return out;
}

// ── the read ──

export function openCode({ reader, now = () => Date.now() } = {}) {
  const project = reader.project;
  const git = reader.git;
  const gh = reader.gh;
  // The list of pull requests and the mapping built from it (contract 3).
  let kept = null; // { at, list }
  let asking = null;
  let mapped = null; // { at, tip, map }
  const filesOf = new Map(); // `<tip> <number>` → string[] | null

  // The repository's facts (contract 2); { ok: false, reason } when there is none to read.
  async function mainOf() {
    const dirs = await git(project, ["rev-parse", "--git-dir", "--git-common-dir", "--is-shallow-repository"]);
    if (!dirs.ok) return { ok: false, reason: `the project is not a git repository (${firstLine(dirs.stderr) || said(dirs, "git rev-parse")})` };
    const [gitDir, commonDir, shallow] = lines(dirs.stdout);
    const head = await git(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]);
    if (!head.ok) return { ok: false, reason: "the project's repository has no commit yet" };
    let ref = null;
    const sym = await git(project, ["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", "refs/remotes/origin/HEAD"]);
    const pointed = lines(sym.stdout)[0];
    if (sym.ok && pointed && pointed.startsWith("refs/remotes/origin/") && pointed !== "refs/remotes/origin/HEAD") ref = pointed;
    for (const r of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
      if (ref) break;
      const there = await git(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`]);
      if (there.ok) ref = r;
    }
    const fetchedRef = Boolean(ref);
    if (!ref) ref = "HEAD";
    const tip = await git(project, ["log", "-1", "--no-show-signature", "--format=%H%x1f%cI", "--end-of-options", ref]);
    if (!tip.ok) return { ok: false, reason: `git log of ${ref} failed: ${firstLine(tip.stderr) || said(tip, "git log")}` };
    const [hash, date] = lines(tip.stdout)[0].split("\x1f");
    let behind = 0;
    if (ref !== "HEAD") {
      const count = await git(project, ["rev-list", "--count", "--end-of-options", `HEAD..${ref}`]);
      behind = count.ok ? Number(lines(count.stdout)[0]) || 0 : null;
    }
    const at = (d) => {
      try {
        return statSync(join(resolve(project, d), "FETCH_HEAD")).mtimeMs;
      } catch {
        return null;
      }
    };
    const times = [gitDir, commonDir].filter(Boolean).map(at).filter((t) => t !== null);
    return {
      ok: true,
      ref,
      short: ref === "HEAD" ? "HEAD" : ref.slice("refs/remotes/origin/".length),
      fetched: fetchedRef,
      tip: hash,
      hash: hash.slice(0, 9),
      date,
      fetchedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      shallow: shallow === "true",
      behind,
    };
  }

  // One `gh pr list`, kept for KEEP_MS; a failure is not kept, and a read
  // that comes while it runs waits for it.
  async function listOf(fresh) {
    if (!fresh && kept && now() - kept.at < KEEP_MS) return kept.list;
    if (asking) return asking;
    asking = (async () => {
      const r = await gh(project, ["pr", "list", "--state=all", `--limit=${LIST_LIMIT}`, `--json=${LIST_FIELDS}`]);
      if (!r.ok) {
        if (r.missing) return { ok: false, reason: "gh is not installed or not on PATH" };
        if (r.unavailable) return { ok: false, reason: "gh is not logged in (gh auth login)" };
        if (r.timedOut) return { ok: false, reason: "gh pr list ran past its budget and was stopped" };
        return { ok: false, reason: `gh pr list failed: ${redactUrls(r.reason || "no answer").slice(0, 200)}` };
      }
      let raw;
      try {
        raw = JSON.parse(r.stdout);
      } catch {
        return { ok: false, reason: "gh answered with something that is not a JSON list" };
      }
      if (!Array.isArray(raw)) return { ok: false, reason: "gh answered with something that is not a JSON list" };
      return { ok: true, at: now(), full: raw.length >= LIST_LIMIT, prs: raw.map((p) => shapePr(p)).filter(Boolean) };
    })();
    let list;
    try {
      list = await asking;
    } finally {
      asking = null;
    }
    if (list.ok) {
      kept = { at: list.at, list };
      mapped = null;
      filesOf.clear();
    } else kept = null;
    return list;
  }

  // A pull request as the read keeps it: its description only as the
  // `Closes-story:` references and the folded text a title is looked up in.
  function shapePr(p) {
    if (!p || typeof p !== "object" || !Number.isInteger(p.number)) return null;
    const body = typeof p.body === "string" ? p.body : "";
    return {
      number: p.number,
      title: typeof p.title === "string" ? p.title : "",
      url: typeof p.url === "string" ? p.url : null,
      rawState: p.state,
      mergedAt: typeof p.mergedAt === "string" && p.mergedAt ? p.mergedAt : null,
      isCrossRepository: p.isCrossRepository,
      baseRefName: p.baseRefName,
      mergeOid: p.mergeCommit && typeof p.mergeCommit.oid === "string" ? p.mergeCommit.oid : null,
      body, // dropped by index() once read
    };
  }

  // The list, read with the core's rules once per list: the references of each
  // `Closes-story:` line and the folded text, then the description dropped.
  function index(list, ctx) {
    if (list.indexed) return list.indexed;
    const fp = ctx.followPlan;
    for (const p of list.prs) {
      if (p.body !== undefined) {
        p.closes = fp.closesStoryRefs(p.body);
        p.says = fold(`${p.title}\n${p.body}`);
        delete p.body;
      }
      p.state = fp.prState({ state: p.rawState, mergedAt: p.mergedAt });
    }
    const repos = list.prs.map((p) => repoOfUrl(p.url)).filter(Boolean);
    list.indexed = {
      byUrl: new Map(list.prs.filter((p) => p.url).map((p) => [fp.normUrl(p.url), p])),
      byNumber: new Map(list.prs.map((p) => [p.number, p])),
      byOid: new Map(list.prs.filter((p) => p.mergeOid && p.state === "merged").map((p) => [p.mergeOid, p])),
      repo: repos[0] ?? null,
      // The repository's own address, as its pull requests' urls give it.
      base: list.prs.map((p) => String(p.url ?? "").match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+\/?$/i)?.[1]).find(Boolean) ?? null,
    };
    return list.indexed;
  }

  // The mapping (contract 6): which pull request brought each commit of the
  // default branch in. One `git log` of its history, kept with the list and
  // built again when the tip has moved.
  let mapping = null; // { key, promise }: two reads at once share one mapping
  function mappingOf(main, list, ix) {
    if (mapped && mapped.at === list.at && mapped.tip === main.tip) return Promise.resolve(mapped.map);
    const key = `${list.at} ${main.tip}`;
    if (mapping?.key === key) return mapping.promise;
    const promise = buildMapping(main, list, ix).finally(() => {
      if (mapping?.promise === promise) mapping = null;
    });
    mapping = { key, promise };
    return promise;
  }
  async function buildMapping(main, list, ix) {
    const r = await git(project, ["log", "--topo-order", "--no-show-signature", "--format=%H %P%x1f%ct%x1f%cn", "--end-of-options", main.ref]);
    if (!r.ok) return { ok: false, reason: `git log of ${main.ref} failed: ${firstLine(r.stderr) || said(r, "git log")}` };
    const commits = lines(r.stdout).map((l) => {
      const [ids, ct, cn] = l.split("\x1f");
      const [hash, ...parents] = ids.trim().split(" ").filter(Boolean);
      return { hash, parents, ct, cn };
    });
    const graph = { commits, index: new Map(commits.map((c, i) => [c.hash, i])) };
    // The first-parent line, newest first.
    const line = [];
    for (let h = main.tip; h && graph.index.has(h); h = graph.commits[graph.index.get(h)].parents[0]) line.push(h);
    const onLine = new Map(line.map((h, i) => [h, i]));
    const claims = new Map(); // commit → pull requests that would bring it in
    const claim = (h, p) => {
      const c = graph.commits[graph.index.get(h)];
      if (!c || c.parents.length > 1) return;
      if (!claims.has(h)) claims.set(h, []);
      claims.get(h).push(p);
    };
    for (const [oid, p] of ix.byOid) {
      if (!graph.index.has(oid)) continue;
      const c = graph.commits[graph.index.get(oid)];
      if (c.parents.length > 1) {
        for (const h of rangeOf(oid, graph)) claim(h, p);
        continue;
      }
      claim(oid, p);
      if (!onLine.has(oid)) continue;
      for (let i = onLine.get(oid) + 1; i < line.length; i++) {
        const b = graph.commits[graph.index.get(line[i])];
        if (b.parents.length !== 1 || ix.byOid.has(b.hash) || b.ct !== c.ct || b.cn !== c.cn) break;
        claim(b.hash, p);
      }
    }
    const byCommit = new Map();
    const landed = new Map(); // pull request number → its commits
    for (const [h, ps] of claims) {
      const p = ps.reduce((a, b) => (String(b.mergedAt) < String(a.mergedAt) ? b : a));
      byCommit.set(h, p.number);
      if (!landed.has(p.number)) landed.set(p.number, []);
      landed.get(p.number).push(h);
    }
    const map = { ok: true, graph, byCommit, landed };
    mapped = { at: list.at, tip: main.tip, map };
    return map;
  }

  // The files a merged pull request changed, from the local repository
  // (contract 7), or null.
  async function filesOfPr(p, main, map) {
    const key = `${main.tip} ${p.number}`;
    if (filesOf.has(key)) return filesOf.get(key);
    let files = null;
    const i = map.graph.index.get(p.mergeOid);
    const c = i === undefined ? null : map.graph.commits[i];
    if (c && c.parents.length > 1) {
      const r = await git(project, ["diff", "--no-renames", "--relative", "--name-only", "--end-of-options", c.parents[0], p.mergeOid]);
      if (r.ok) files = [...new Set(lines(r.stdout))];
    } else if (c) {
      const own = map.landed.get(p.number) || [p.mergeOid];
      const r = await git(project, ["show", "--no-renames", "--no-show-signature", "--relative", "--name-only", "--format=", "--end-of-options", ...own]);
      if (r.ok) files = [...new Set(lines(r.stdout))];
    }
    filesOf.set(key, files);
    return files;
  }

  // ── a story ──

  // The written ties of a story (contract 4): field, Closes-story line, title, number.
  // `resolved` is the memo of the stories a Closes-story line names: one for many stories (survey).
  function writtenTies(ctx, { rel, text, fm }, main, ix, list, resolved = new Map()) {
    const fp = ctx.followPlan;
    const rows = new Map(); // url (normalised) or `#n` → row
    const row = (key, base) => {
      if (!rows.has(key)) rows.set(key, { ...base, how: [], why: {} });
      return rows.get(key);
    };
    const ofPr = (p) => ({ number: p.number, url: p.url, title: p.title, state: p.state, mergedAt: p.mergedAt, pr: p });
    const tie = (r, how, why = null) => {
      if (!r.how.includes(how)) r.how.push(how);
      if (why) r.why[how] = why;
    };
    const field = fp.prUrlOf(text);
    if (field) {
      const p = ix ? ix.byUrl.get(fp.normUrl(field)) : null;
      const r = row(fp.normUrl(field), p ? ofPr(p) : { number: numberOfUrl(field), url: field, title: null, state: null, mergedAt: null, pr: null });
      tie(r, "recorded", p ? null : list?.ok ? "it is not among the pull requests read" : "the pull requests could not be read");
      if (!p && repoOfUrl(field) && ix?.repo && repoOfUrl(field).toLowerCase() !== ix.repo.toLowerCase()) r.repo = repoOfUrl(field);
    }
    if (!ix) return rows;
    const real = (p) => {
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    };
    const own = real(join(ctx.vault, rel));
    const epicsPath = epicsPathOf(ctx);
    const names = (ref) => {
      if (!resolved.has(ref)) {
        const r = epicsPath ? resolveStory(ref, { vault: ctx.vault, epicsPath }, ctx.lib) : { error: "no epic folder" };
        resolved.set(ref, r.path ? real(r.path) : null);
      }
      return resolved.get(ref) === own;
    };
    const title = fold(fm.title);
    const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const mentioned = new Set();
    for (const m of body.matchAll(/(?:\bPR|\bpull request|\bpull)\s*#(\d+)/gi)) mentioned.add(Number(m[1]));
    if (ix.base) {
      const esc = ix.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const m of body.matchAll(new RegExp(`${esc}/pull/(\\d+)`, "gi"))) mentioned.add(Number(m[1]));
    }
    for (const p of list.prs) {
      if (p.closes.some(names)) {
        const r = row(fp.normUrl(p.url), ofPr(p));
        let why = null;
        if (!main?.ok || main.short === "HEAD") why = "no default branch is known";
        else if (p.isCrossRepository !== false) why = "it comes from a fork";
        else if (p.baseRefName !== main.short) why = `it goes to ${p.baseRefName}, not ${main.short}`;
        else if (p.state === "closed") why = "it was closed unmerged";
        if (!why && fp.isCounted(p, main.short)) tie(r, "closes");
        else tie(r, "closes-uncounted", why || "follow would not count it");
      }
      if (title.length >= TITLE_MIN && p.says.includes(title)) tie(row(fp.normUrl(p.url), ofPr(p)), "named");
      if (mentioned.has(p.number)) tie(row(fp.normUrl(p.url), ofPr(p)), "mentioned");
    }
    return rows;
  }

  const rank = (r) => Math.min(...r.how.map((x) => TIES.indexOf(x)));
  const order = (a, b) => {
    const la = a.link ? 0 : 1;
    const lb = b.link ? 0 : 1;
    if (la !== lb) return la - lb;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const sa = a.files ? a.inside / a.files : -1;
    const sb = b.files ? b.inside / b.files : -1;
    if (sa !== sb) return sb - sa;
    return String(b.mergedAt || "").localeCompare(String(a.mergedAt || ""));
  };

  async function storyCode(ctx, art, base) {
    const { text, fm } = art;
    const cr = ctx.codeRefs;
    const { refs: all, form } = refsOf(text, fm, ctx.lib);
    const skipped = all.filter(outside);
    const refs = all.filter((r) => !outside(r));
    const since = stamp(fm.started_at);
    const until = stamp(fm.closed_at);
    const out = { ...base, kind: "story", refs, refsForm: form, skipped, window: null, windowReason: null, commits: [], commitCount: 0, truncated: false, loose: 0, prs: [] };
    if (!since) out.windowReason = "the story has no started_at, so no commit can be told to be its own";
    else if (!refs.length) out.windowReason = "the story names no code path";
    else out.window = { since, until };

    const main = base.main;
    const list = base.unknown.prs ? null : base.list;
    const ix = list ? index(list, ctx) : null;
    const map = main && ix ? await mappingOf(main, list, ix) : null;
    if (map && !map.ok) out.unknown.git = map.reason;
    const mapping = map?.ok ? map : null;

    // Derived: commits of the default branch in the story's window with a path its code paths cover.
    let commits = [];
    if (out.window && main && !out.unknown.git) {
      const r = await git(project, [
        "log",
        "--no-renames",
        "--no-show-signature",
        "--no-merges",
        "--relative",
        `--since=${dayStart(since)}`,
        ...(until ? [`--until=${dayEnd(until)}`] : []),
        "--format=%x1e%H%x1f%cI%x1f%s",
        "--name-only",
        "--end-of-options",
        main.ref,
        "--",
        ...pathspecs(refs, cr),
      ]);
      if (!r.ok) out.unknown.git = `git log failed: ${firstLine(r.stderr) || said(r, "git log")}`;
      else {
        for (const chunk of r.stdout.split("\x1e")) {
          if (!chunk.trim()) continue;
          const [head, ...files] = chunk.split("\n");
          const [hash, date, subject] = head.split("\x1f");
          const paths = files.map((f) => f.trim()).filter(Boolean);
          if (!paths.some((f) => refs.some((ref) => cr.refCovers(ref, f)))) continue;
          commits.push({ hash, date, subject, files: paths.length, pr: mapping?.byCommit.get(hash) ?? null });
        }
        out.truncated = commits.length > MAX_COMMITS;
        commits = commits.slice(0, MAX_COMMITS);
      }
    }
    out.commitCount = commits.length;
    out.loose = mapping ? commits.filter((c) => c.pr === null).length : null;
    out.commits = commits.slice(0, SHOWN_COMMITS).map((c) => ({ hash: c.hash.slice(0, 9), date: c.date, subject: c.subject, files: c.files, pr: c.pr }));

    const rows = writtenTies(ctx, art, main, ix, base.list);
    if (ix) {
      for (const c of commits) {
        if (c.pr === null) continue;
        const p = ix.byNumber.get(c.pr);
        const key = ctx.followPlan.normUrl(p.url);
        if (!rows.has(key)) rows.set(key, { number: p.number, url: p.url, title: p.title, state: p.state, mergedAt: p.mergedAt, pr: p, how: [], why: {} });
        const r = rows.get(key);
        if (!r.how.includes("derived")) r.how.push("derived");
        r.commits = (r.commits || 0) + 1;
      }
    }
    for (const r of rows.values()) {
      r.how.sort((a, b) => TIES.indexOf(a) - TIES.indexOf(b));
      r.link = r.how.some((x) => LINKS.has(x));
      r.files = null;
      r.inside = null;
      const p = r.pr;
      if (!p) r.filesReason = r.why.recorded || "it is not among the pull requests read";
      else if (p.state !== "merged") r.filesReason = "it is not merged";
      else if (!mapping || !mapping.graph.index.has(p.mergeOid)) r.filesReason = "it is not on the default branch of the local repository";
      else {
        const files = await filesOfPr(p, main, mapping);
        if (files) {
          r.files = files.length;
          r.inside = files.filter((f) => refs.some((ref) => cr.refCovers(ref, f))).length;
        } else r.filesReason = "git could not list its files";
      }
      delete r.pr;
      if (!Object.keys(r.why).length) delete r.why;
    }
    out.prs = [...rows.values()].sort(order);
    return out;
  }

  // ── a spec ──

  // The core's bundle of a spec, with seams that start nothing: { bundle }, or
  // { error } for a spec that is not active or that the core cannot resolve.
  function specBundle(ctx, art) {
    const query = String(art.fm.id || art.rel.split("/").pop().replace(/\.md$/, ""));
    const r = ctx.specDrift.buildSpecDrift({
      proj: project,
      cfg: ctx.cfg,
      query,
      layout: ctx.layout,
      git: () => null,
      grep: () => ({ status: "unknown", reason: "the page does not search the project", lines: [] }),
    });
    if (!r.error) return { bundle: r.bundle };
    return { error: r.error === "not-active" ? `the core reads the code behind a spec only while it is active; this one is ${r.status || "not"}` : `the core could not read this spec (${r.error})` };
  }

  async function specCode(ctx, art, base, b) {
    const out = { ...base, kind: "spec", anchors: [], stories: [], files: [], totals: b.totals };
    const files = b.files.filter((f) => !f.path.startsWith(".projectstore/"));
    out.files = files.map((f) => ({ path: f.path, class: f.class, lines: f.lines }));
    const main = base.main;
    const list = base.unknown.prs ? null : base.list;
    const ix = list ? index(list, ctx) : null;
    const map = main && ix ? await mappingOf(main, list, ix) : null;
    if (map && !map.ok) out.unknown.git = map.reason;
    const mapping = map?.ok ? map : null;

    const groups = new Map();
    for (const c of b.contracts) {
      if (c.removed || !c.anchor) continue;
      const g = groups.get(c.anchor) || { anchor: c.anchor, from: new Set(), contracts: [] };
      g.from.add(c.anchor_from);
      g.contracts.push({ n: c.n, heading: c.heading });
      groups.set(c.anchor, g);
    }
    const paths = files.map((f) => f.path);
    for (const g of [...groups.values()].sort((a, c) => String(c.anchor).localeCompare(String(a.anchor)))) {
      const row = { anchor: g.anchor, from: [...g.from], contracts: g.contracts, commits: null, files: null, prCount: null, prs: [], loose: null };
      out.anchors.push(row);
      if (!main || out.unknown.git || !paths.length) continue;
      const log = await git(project, [
        "log",
        "--no-renames",
        "--no-show-signature",
        "--no-merges",
        "--relative",
        `--since=${sinceWindow(g.anchor)}`,
        "--format=%x1e%H",
        "--name-only",
        "--end-of-options",
        main.ref,
        "--",
        ...paths.map((p) => `:(literal)${p}`),
      ]);
      if (!log.ok) {
        out.unknown.git = `git log failed: ${firstLine(log.stderr) || said(log, "git log")}`;
        continue;
      }
      const commits = log.stdout
        .split("\x1e")
        .filter((c) => c.trim())
        .map((c) => ({ hash: lines(c)[0].trim(), files: lines(c).slice(1).map((f) => f.trim()) }));
      row.commits = commits.length;
      row.files = new Set(commits.flatMap((c) => c.files)).size;
      if (!mapping) continue;
      const numbers = new Set();
      row.loose = 0;
      for (const c of commits) {
        const n = mapping.byCommit.get(c.hash);
        if (n === undefined) row.loose++;
        else numbers.add(n);
      }
      row.prCount = numbers.size;
      row.prs = [...numbers]
        .map((n) => ix.byNumber.get(n))
        .sort((a, c) => String(c.mergedAt || "").localeCompare(String(a.mergedAt || "")))
        .slice(0, SPEC_PRS)
        .map((p) => ({ number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt }));
    }

    for (const s of b.stories) {
      const row = { rel: s.rel || null, title: s.title || s.ref, status: s.status || null, refs: (s.code_refs || []).length, missing: (s.missing || []).length, prs: [] };
      out.stories.push(row);
      if (!s.rel || !readableRel(ctx, s.rel)) continue;
      const text = readFileSync(join(ctx.vault, s.rel), "utf8");
      const fm = ctx.lib.parseFrontmatter(text).data;
      const rows = writtenTies(ctx, { rel: s.rel, text, fm }, main, ix, base.list);
      row.prs = [...rows.values()]
        .map((r) => {
          r.how.sort((a, c) => TIES.indexOf(a) - TIES.indexOf(c));
          return { number: r.number, url: r.url, title: r.title, state: r.state, how: r.how, link: r.how.some((x) => LINKS.has(x)) };
        })
        .sort((a, c) => (a.link === c.link ? TIES.indexOf(a.how[0]) - TIES.indexOf(c.how[0]) || (c.number || 0) - (a.number || 0) : a.link ? -1 : 1));
    }
    return out;
  }

  // One read (contract 1): the item, then the repository and the list, then
  // the story's or the spec's side. → { status, result } or { status, error }.
  async function read(ctx, { rel, fresh = false } = {}) {
    if (typeof rel !== "string") return { status: 404, error: "no such story or spec" };
    const file = readableRel(ctx, rel);
    if (!file) return { status: 404, error: "no such story or spec" };
    const text = readFileSync(file, "utf8");
    const fm = ctx.lib.parseFrontmatter(text).data || {};
    const type = String(fm.type || "").toLowerCase();
    if (type !== "story" && type !== "spec") return { status: 404, error: "the Code block is read for a story or a spec" };
    const art = { rel, text, fm };
    // A spec the core does not read gets no call at all (contract 8).
    const spec = type === "spec" ? specBundle(ctx, art) : null;
    if (spec?.error) return { status: 200, result: { kind: "spec", rel, error: spec.error } };
    const base = { rel, repo: null, main: null, listFull: false, unknown: { git: null, prs: null }, list: null };
    if (reader.windows) {
      base.unknown = { git: WINDOWS, prs: WINDOWS };
      const result = type === "story" ? { ...base, kind: "story", refs: [], refsForm: "json", skipped: [], window: null, windowReason: WINDOWS, commits: [], commitCount: 0, truncated: false, loose: null, prs: [] } : { ...base, kind: "spec", anchors: [], stories: [], files: [], totals: null };
      delete result.list;
      return { status: 200, result };
    }
    const main = await mainOf();
    if (main.ok) base.main = main;
    else base.unknown.git = main.reason;
    const list = main.ok ? await listOf(Boolean(fresh)) : { ok: false, reason: "the project's repository cannot be read" };
    if (list.ok) {
      base.list = list;
      base.listFull = list.full;
      base.repo = index(list, ctx).repo;
    } else base.unknown.prs = list.reason;
    const result = type === "story" ? await storyCode(ctx, art, base) : await specCode(ctx, art, base, spec.bundle);
    if (result.main) {
      const { tip: _tip, ...shown } = result.main;
      result.main = shown;
    }
    delete result.list;
    return { status: 200, result };
  }

  // Many stories' written ties at once, for Reports (the spec dashboard-reports, contracts 5 to 7):
  // the main facts, the kept list and one shared memo; no history is read. Unknown is never none.
  async function survey(ctx, { stories = [], fresh = false } = {}) {
    const out = { main: null, repo: null, listFull: false, unknown: { git: null, prs: null }, prs: [], ties: new Map() };
    if (reader.windows) return { ...out, unknown: { git: WINDOWS, prs: WINDOWS } };
    const main = await mainOf();
    if (main.ok) {
      const { tip: _tip, ...shown } = main;
      out.main = shown;
    } else out.unknown.git = main.reason;
    const list = main.ok ? await listOf(Boolean(fresh)) : { ok: false, reason: "the project's repository cannot be read" };
    const ix = list.ok ? index(list, ctx) : null;
    if (list.ok) {
      out.listFull = list.full;
      out.repo = ix.repo;
      out.prs = list.prs.map(({ number, title, url, state, mergedAt }) => ({ number, title, url, state, mergedAt }));
    } else out.unknown.prs = list.reason;
    const memo = new Map();
    for (const st of stories) {
      const rows = writtenTies(ctx, st, main.ok ? main : null, ix, list.ok ? list : null, memo);
      out.ties.set(
        st.rel,
        [...rows.values()].map((r) => ({ number: r.number, url: r.url, title: r.title, state: r.state, mergedAt: r.mergedAt, how: r.how, link: r.how.some((h) => LINKS.has(h)) })),
      );
    }
    return out;
  }

  return { read, survey };
}

// projectstore — spec-stale.mjs: a spec older than its code.
//
// For each participating spec (active, in a spec tree), its *text anchor* is
// the latest day among its `date:` and its valid markers of either kind, and
// its *close anchor* the latest `closed_at` of the stories that cover it.
// A commit on the trunk counts against the spec when it changed a path one of
// the spec's refs covers, its committer day is after the text anchor and its
// committer instant after the close anchor (the spec "Spec staleness: an
// anchor per spec, code newer than its spec, a parent behind its children,
// and the checked marker", contracts 1 to 4). A spec that covers work in
// flight is not judged until that work closes.
//
// It imports lib, grammar, code-refs, diff-refs, spec-code and status-log,
// never doctor.mjs or graph.mjs, so doctor can import it.

import { isCalendarDate, extractLinks, resolveLinkTarget, citationTokenRe, CITATION_EXAMPLE_KEY } from "./lib.mjs";
import { parseSpecMarkers } from "./grammar.mjs";
import { refCovers } from "./code-refs.mjs";
import { trunkHistory } from "./diff-refs.mjs";
import { specOwnership, coveringStories, specInFlight } from "./spec-code.mjs";
import { stampMs } from "./status-log.mjs";

// The finding levels of this module's checks.
export const SPEC_STALE_LEVELS = Object.freeze({
  "spec-stale-code": "warn",
  "spec-stale-unknown": "info",
  "spec-stale-parent": "warn",
  "spec-child-unlinked": "warn",
});

const REASONS = Object.freeze({
  "no-git": "git is not installed",
  "not-a-repository": "the project is not a git repository",
  shallow: "the repository is a shallow clone",
  timeout: "git did not answer in time",
  failed: "git failed",
});

const dayAfter = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

// The anchors of each participating spec (contract 1): Map path → {text,
// close}, where `text` is a day or null and `close` epoch milliseconds or
// null. `resolveStory(ref)` gives {story} or {error}; a `checked` marker whose
// story does not resolve, a date after tomorrow and a `closed_at` after `now`
// are skipped.
export function specAnchors(
  index,
  tree,
  { layout, now = new Date().toISOString(), resolveStory = () => ({}), withClose = true } = {},
) {
  const own = specOwnership(index, tree, {});
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const covers = withClose ? coveringStories(index, layout) : new Map();
  const tomorrow = dayAfter(now, 1);
  const nowMs = Date.parse(now);
  const out = new Map();
  for (const p of own.participating) {
    const n = nodeOf.get(p);
    const days = [];
    const date = String(n.fm.date ?? "").slice(0, 10);
    if (isCalendarDate(date) && date <= tomorrow) days.push(date);
    for (const m of parseSpecMarkers(n.body)) {
      if (!m.valid || !isCalendarDate(m.date) || m.date > tomorrow) continue;
      if (m.marker === "checked" && resolveStory(m.ref)?.error) continue;
      days.push(m.date);
    }
    let close = null;
    for (const s of withClose ? covers.get(p) || [] : []) {
      const ms = stampMs(s.fm.closed_at);
      if (ms === null || ms > nowMs) continue;
      if (close === null || ms > close) close = ms;
    }
    out.set(p, { text: days.length ? days.sort().at(-1) : null, close });
  }
  return out;
}

// Doctor's checks (contracts 2 to 4). `finding(level, check, message, file,
// extra)` builds one finding; `history(proj, since)` is trunkHistory's seam.
// While the vault has no tree, or no participating spec names code, nothing
// runs and git is not started.
export function checkSpecStale(
  index,
  tree,
  { layout, proj, vault, now = new Date().toISOString(), history = trunkHistory, resolveStory, finding },
) {
  if (!tree.hasTree) return [];
  const own = specOwnership(index, tree, { proj, vault });
  if (!own.hasRefs) return [];
  const anchors = specAnchors(index, tree, { layout, now, resolveStory });
  const inFlight = specInFlight(coveringStories(index, layout));
  const out = [];
  const judged = [];
  for (const p of own.participating) {
    const refs = own.refsOf.get(p);
    if (!refs.length) continue;
    const a = anchors.get(p);
    if (!a.text) {
      out.push(
        finding(
          SPEC_STALE_LEVELS["spec-stale-unknown"],
          "spec-stale-unknown",
          `Spec ${p} has no valid date: and no valid marker, so whether its code is newer than it is not checked. Give it a date: in YYYY-MM-DD form.`,
          p,
          { reason: "no-anchor" },
        ),
      );
      continue;
    }
    if (inFlight(p)) continue;
    judged.push(p);
  }
  if (!judged.length) return out;
  const oldest = judged.map((p) => anchors.get(p).text).sort()[0];
  const h = history(proj, oldest);
  if (h.status !== "ok") {
    const reason = REASONS[h.reason] ? h.reason : "failed";
    const shown = judged.slice(0, 3).join(", ") + (judged.length > 3 ? `, and ${judged.length - 3} more` : "");
    out.push(
      finding(
        SPEC_STALE_LEVELS["spec-stale-unknown"],
        "spec-stale-unknown",
        `Whether the code of ${shown} is newer than the spec is not checked: ${REASONS[reason]} (${reason}). The check runs on a full clone with git.`,
        null,
        { reason },
      ),
    );
    return out;
  }
  for (const p of judged) {
    const { text, close } = anchors.get(p);
    const refs = own.refsOf.get(p);
    const counting = h.commits.filter(
      (c) =>
        c.day > text &&
        (close === null || c.committerMs > close) &&
        c.paths.some((f) => refs.some((r) => refCovers(r, f))),
    );
    if (!counting.length) continue;
    const newest = counting
      .map((c) => c.day)
      .sort()
      .at(-1);
    const closed = close === null ? "" : `, its last covering story closed ${new Date(close).toISOString()}`;
    out.push(
      finding(
        SPEC_STALE_LEVELS["spec-stale-code"],
        "spec-stale-code",
        `Spec ${p} was last changed or checked on ${text}${closed}, and ${counting.length} commit${counting.length === 1 ? "" : "s"} on ${h.branch ?? h.ref} since then changed its code, the newest on ${newest}. Read its contracts against the code, then amend them, or add "> checked YYYY-MM-DD by <story>: <what you compared>" if they still hold.`,
        p,
        { ref: h.ref, commits: counting.length, newest },
      ),
    );
  }
  return out;
}

// The prose of a spec body that tokens and links are read from (contracts 5
// and 6): frontmatter, HTML comments and fenced code blanked to their
// newlines, so line numbers survive. Inline code stays.
function proseOf(body) {
  const blank = (m) => m.replace(/[^\n]/g, "");
  const text = String(body || "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  // Fenced code as CommonMark reads it: ``` or ~~~, closed by the same
  // character at least as long; an unclosed fence runs to the end.
  const lines = text.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(lines[i])) fence = null;
      lines[i] = "";
    } else if (m) {
      fence = m[1];
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

// The citation tokens of a spec body, `[<key>#<n>]`, the reserved key left out.
export function citationTokensOf(body) {
  const out = [];
  for (const m of proseOf(body).matchAll(citationTokenRe())) {
    if (m[1] === CITATION_EXAMPLE_KEY) continue;
    out.push({ token: m[0], key: m[1], n: m[2] });
  }
  return out;
}

// A parent behind its children (contracts 5 and 6), as data for doctor and
// the view: per participating parent, the tokens of descendants amended after
// its text anchor, and the direct children dated after it that it neither
// links nor cites. `keyPath(key)` gives the spec path a citation key names;
// `files` is the vault's .md walk for the link resolver.
export function parentBehind(index, tree, { layout, now = new Date().toISOString(), resolveStory, keyPath, files }) {
  const out = { stale: [], unlinked: [], anchorless: [] };
  if (!tree.hasTree) return out;
  const own = specOwnership(index, tree, {});
  const part = new Set(own.participating);
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const anchors = specAnchors(index, tree, { layout, now, resolveStory, withClose: false });
  const tomorrow = dayAfter(now, 1);
  const lastAmended = (spec, n) => {
    let day = null;
    for (const m of parseSpecMarkers(nodeOf.get(spec)?.body)) {
      if (m.marker !== "amended" || !m.valid || m.contract !== n) continue;
      if (!isCalendarDate(m.date) || m.date > tomorrow) continue;
      if (day === null || m.date > day) day = m.date;
    }
    return day;
  };
  const ctx = { index, files, kinds: ["spec"] };
  for (const parent of own.participating) {
    const kids = (tree.children.get(parent) || []).filter((c) => part.has(c));
    if (!kids.length) continue;
    const text = anchors.get(parent)?.text;
    if (!text) {
      if (!own.refsOf.get(parent).length) out.anchorless.push(parent);
      continue;
    }
    const body = nodeOf.get(parent).body;
    const tokens = citationTokensOf(body);
    const seen = new Set();
    for (const t of tokens) {
      const target = keyPath(t.key);
      if (!target || target === parent || !part.has(target) || !own.isAncestor(parent, target)) continue;
      // The top-level contract, prime kept: `#4'` is not `#4`.
      const contract = String(t.n).split("/")[0];
      const key = `${target}#${contract}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const day = lastAmended(target, contract);
      if (day && day > text) out.stale.push({ parent, token: t.token, child: target, day, anchor: text });
    }
    const cited = new Set(tokens.map((t) => keyPath(t.key)).filter(Boolean));
    ctx.sourceRel = parent;
    const linked = new Set();
    for (const link of extractLinks(proseOf(body))) {
      const r = resolveLinkTarget(link.target, link.type, ctx);
      if (r.outcome === "node") linked.add(r.node.path);
    }
    for (const child of kids) {
      const date = String(nodeOf.get(child).fm.date ?? "").slice(0, 10);
      if (!isCalendarDate(date) || date <= text) continue;
      if (linked.has(child) || cited.has(child)) continue;
      out.unlinked.push({ parent, child, date, anchor: text });
    }
  }
  return out;
}

// Doctor's parent checks (contracts 5 and 6), from the vault only, and the
// no-anchor info for an anchorless parent that names no code (contract 1).
export function checkParentStale(index, tree, opts) {
  const { finding } = opts;
  const r = parentBehind(index, tree, opts);
  const out = [];
  for (const p of r.anchorless) {
    out.push(
      finding(
        SPEC_STALE_LEVELS["spec-stale-unknown"],
        "spec-stale-unknown",
        `Spec ${p} has no valid date: and no valid marker, so whether it is behind its children is not checked. Give it a date: in YYYY-MM-DD form.`,
        p,
        { reason: "no-anchor" },
      ),
    );
  }
  for (const s of r.stale) {
    out.push(
      finding(
        SPEC_STALE_LEVELS["spec-stale-parent"],
        "spec-stale-parent",
        `Spec ${s.parent} cites ${s.token}, and that contract of ${s.child} was amended on ${s.day}, after ${s.parent} last changed or was checked (${s.anchor}). Update ${s.parent}'s text to match, or, if it still holds, add "> checked YYYY-MM-DD by <story>: <what you compared>" under its contract that cites the token, or above its first contract.`,
        s.parent,
        { token: s.token, child: s.child, day: s.day },
      ),
    );
  }
  for (const u of r.unlinked) {
    out.push(
      finding(
        SPEC_STALE_LEVELS["spec-child-unlinked"],
        "spec-child-unlinked",
        `Spec ${u.child} is a child of ${u.parent}, dated ${u.date}, after ${u.parent} last changed or was checked (${u.anchor}), and ${u.parent} neither links nor cites it. Link or cite the child in ${u.parent}, or, if the overview still holds without it, add "> checked YYYY-MM-DD by <story>: <why>" above ${u.parent}'s first contract.`,
        u.parent,
        { child: u.child },
      ),
    );
  }
  return out;
}

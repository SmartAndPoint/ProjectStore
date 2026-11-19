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

import { isCalendarDate } from "./lib.mjs";
import { parseSpecMarkers } from "./grammar.mjs";
import { refCovers } from "./code-refs.mjs";
import { trunkHistory } from "./diff-refs.mjs";
import { specOwnership, coveringStories, specInFlight } from "./spec-code.mjs";
import { stampMs } from "./status-log.mjs";

// The finding levels of this module's checks.
export const SPEC_STALE_LEVELS = Object.freeze({
  "spec-stale-code": "warn",
  "spec-stale-unknown": "info",
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
export function specAnchors(index, tree, { layout, now = new Date().toISOString(), resolveStory = () => ({}) } = {}) {
  const own = specOwnership(index, tree, {});
  const nodeOf = new Map(index.nodes.map((n) => [n.path, n]));
  const covers = coveringStories(index, layout);
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
    for (const s of covers.get(p) || []) {
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

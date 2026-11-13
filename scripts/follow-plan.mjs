// projectstore — follow-plan.mjs: what `follow` writes for a merged pull
// request, as pure functions of a story's text and the pull request's facts.
//
// The follow spec ("The follow verb: a merged pull request closes its story
// through the close computation, and a stale review goes back", alias
// `follow`), contracts 5 and 6: the close's reason, the `Merged:` line under
// Final Summary, the event time of the merge held to a floor, and the close
// for a merge, through story-section.mjs's computeClose, with the bytes the
// refusal judges. The refusal's findings come from the caller (doctor's
// storyCloseFindings on the vault); the links and the transition rows join
// this module with the verb. Pure: no file, no process, no clock — every
// instant comes from the text or the caller.

import { parseFrontmatter, headingLineRe } from "./lib.mjs";
import { parseStatusLog, stampMs, setFm } from "./status-log.mjs";
import { computeClose } from "./story-section.mjs";

// An instant in nowIso() form: UTC, milliseconds, `Z`.
const iso = (ms) => new Date(ms).toISOString();

// The merge commit's id, or null: gh gives `mergeCommit` as {oid} or null.
function shaOf(pr) {
  const c = pr && pr.mergeCommit;
  if (!c) return null;
  const oid = typeof c === "string" ? c : c.oid;
  return oid ? String(oid) : null;
}

// The pull request's `mergedAt`, read by the stamp reader, in nowIso() form;
// throws when it does not read.
export function mergedAtIso(pr) {
  const ms = stampMs(pr && pr.mergedAt);
  if (ms === null)
    throw new Error(`mergedAt is not an instant the stamp reader reads: ${JSON.stringify(pr?.mergedAt)}`);
  return iso(ms);
}

// The close's reason: `merged: <url> at <sha>`, without ` at <sha>` when the
// pull request has no merge commit.
export function mergeReason(pr) {
  const sha = shaOf(pr);
  return `merged: ${pr.url}${sha ? ` at ${sha}` : ""}`;
}

// The line under Final Summary: `Merged: <url> at <sha>, <mergedAt>.`, the
// pull request's own mergedAt (never the floor), English in every locale.
export function mergedLine(pr) {
  const sha = shaOf(pr);
  return `Merged: ${pr.url}${sha ? ` at ${sha}` : ""}, ${mergedAtIso(pr)}.`;
}

// The floor of a merge's stamps, from the bytes before the run: the latest of
// the last readable Status log line (it parses and its time reads, else the
// one before it), `started_at` and `created`, each read by the stamp reader.
// Epoch milliseconds, or null when none reads.
export function closeFloor(text) {
  const fm = parseFrontmatter(text).data;
  const log = parseStatusLog(text) || [];
  let last = null;
  for (let i = log.length - 1; i >= 0 && last === null; i--) last = stampMs(log[i].at);
  const known = [last, stampMs(fm.started_at), stampMs(fm.created)].filter((ms) => ms !== null);
  return known.length ? Math.max(...known) : null;
}

// The event time a merge's stamps take: mergedAt, or the floor when mergedAt
// is earlier. Returns {at, mergedAt, floored}, both instants in nowIso() form.
export function eventStamp(text, pr) {
  const merged = mergedAtIso(pr);
  const floor = closeFloor(text);
  const floored = floor !== null && stampMs(merged) < floor;
  return { at: floored ? iso(floor) : merged, mergedAt: merged, floored };
}

// The text with `line` under the Final Summary heading, in any bundled
// language: after the section's kept text, or alone when the section holds
// only blank lines and HTML comments (the template's placeholder). The
// section ends at the next `## ` heading, else at the footer's `---` rule. A
// section that already holds the line is left. Throws with no section.
export function withMergedLine(text, line) {
  const m = text.match(headingLineRe("final_summary"));
  if (!m) throw new Error("the story has no Final Summary section");
  // The heading's pattern may take the line break after it; start at the line's end.
  const start = m.index + m[0].trimEnd().length;
  const rest = text.slice(start);
  let next = rest.search(/^## /m);
  if (next === -1) {
    const rule = rest.lastIndexOf("\n---");
    next = rule === -1 ? rest.length : rule + 1;
  }
  const end = start + next;
  const body = text.slice(start, end);
  if (body.split("\n").some((l) => l.trim() === line)) return text;
  const kept = body.replace(/\s+$/, "");
  let trail = body.slice(kept.length);
  if (!trail.includes("\n")) trail = "\n";
  const placeholder = kept.replace(/<!--[\s\S]*?-->/g, "").trim() === "";
  const section = placeholder ? `\n\n${line}${trail}` : `${kept}\n\n${line}${trail}`;
  return text.slice(0, start) + section + text.slice(end);
}

// The close of a merge: the bytes `follow` would write, closed at the event
// time held to the floor with the `Merged:` line, and the bytes the refusal
// judges, closed at the run time `now` with `closed_at` set to it even when
// the story carries an older one (so isLegacyStory never silences the
// checks). `findings(judged)` is the caller's refusal, a list; empty means
// the close may be written. `day` is the run's UTC day for `updated`.
// Returns {written, judged, stamp, reason, line, refusal, refused}.
export function closeForMerge(text, pr, { now, day, lang = "en", findings = null } = {}) {
  const nowMs = stampMs(now);
  if (nowMs === null) throw new Error(`the run time is not an instant: ${JSON.stringify(now)}`);
  if (!day) throw new Error("the run's day is required");
  const reason = mergeReason(pr);
  const line = mergedLine(pr);
  const stamp = eventStamp(text, pr);
  const closeAt = (at) => withMergedLine(computeClose(text, { reason, actor: "follow", at, day, lang }).text, line);
  const run = iso(nowMs);
  const written = closeAt(stamp.at);
  const judged = setFm(closeAt(run), "closed_at", JSON.stringify(run));
  const refusal = findings ? [...findings(judged)] : [];
  return { written, judged, stamp, reason, line, refusal, refused: refusal.length > 0 };
}

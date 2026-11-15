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
//
// Pull request B adds contracts 3, 4 and 7: which pull request closes a
// story (its `external_refs.pr`, else a `Closes-story:` line in a counted
// pull request's body), the rows of the ADR's decision 5 table before the
// close, the awaiting line of a refused close, and the `pr:` line of a link
// recorded or replaced, which comes after the status line (planStory).

import {
  parseFrontmatter,
  headingLineRe,
  sectionOf,
  checklistItems,
  linesOutsideFences,
  evidenceSuffixRe,
} from "./lib.mjs";
import {
  parseStatusLog,
  stampMs,
  setFm,
  applyStatusChange,
  touchStory,
  appendLogLine,
  logLine,
  lastStatusLine,
  statusStamp,
  sameStatus,
  AWAITING_REASON,
  EMPTY,
} from "./status-log.mjs";
import { statusToColumn, NOT_ACTIONABLE } from "./stages.mjs";
import { ageDays, meets } from "./flow-counts.mjs";
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

// ─── Contract 3: which pull request closes a story ─────────────────────

export const LINKED_REASON = "linked from Closes-story";
export const REPLACED_REASON = "replaced a closed pull request";

// A url as compared: no trailing slash, lower-cased (GitHub's owner and
// repository names are not case-sensitive).
export const normUrl = (u) =>
  String(u ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

// Every `Closes-story: <EPIC>/<story-id>` line of a pull request's body,
// outside fenced blocks, CRLF read as LF; each reference once, in order.
export function closesStoryRefs(body) {
  const refs = [];
  let fence = false;
  for (const line of String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^\s*Closes-story:\s*(\S+)\s*$/);
    if (m && !refs.includes(m[1])) refs.push(m[1]);
  }
  return refs;
}

// The story's `external_refs` map, read from its frontmatter line: JSON, or
// a flow map with unquoted keys. {map, ok}: ok false for a value neither
// reads (the map is then empty, and no link is written over it).
export function externalRefs(text) {
  const block = String(text).match(/^---\n([\s\S]*?)\n---/);
  const line = block ? block[1].split("\n").find((l) => /^external_refs:/.test(l)) : null;
  const raw = line ? line.replace(/^external_refs:\s*/, "").trim() : "";
  if (!raw || raw === "null" || raw === '""') return { map: {}, ok: true };
  for (const form of [raw, raw.replace(/([{,]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')]) {
    try {
      const v = JSON.parse(form);
      if (v && typeof v === "object" && !Array.isArray(v)) return { map: v, ok: true };
    } catch {}
  }
  return { map: {}, ok: false };
}

// The url the story's `external_refs.pr` holds, or null.
export function prUrlOf(text) {
  const { map } = externalRefs(text);
  return typeof map.pr === "string" && map.pr.trim() ? map.pr.trim() : null;
}

// The text with `external_refs.pr` set to `url`, the map's other keys kept
// in their order.
export function withPrRef(text, url) {
  const { map, ok } = externalRefs(text);
  if (!ok) throw new Error("external_refs does not read as a map: no link is written over it");
  const next = { ...map, pr: url };
  const value = `{${Object.entries(next)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")}}`;
  return setFm(text, "external_refs", value);
}

// A pull request's state: merged, closed (unmerged) or open.
export function prState(pr) {
  const s = String(pr?.state ?? "").toUpperCase();
  if (s === "MERGED" || pr?.mergedAt) return "merged";
  return s === "CLOSED" ? "closed" : "open";
}

// Whether a body line in this pull request counts: its head is in the same
// repository, and its base is the repository's default branch.
export const isCounted = (pr, defaultBranch) =>
  pr?.isCrossRepository === false && typeof defaultBranch === "string" && pr.baseRefName === defaultBranch;

// One story's link: `field` the url its external_refs.pr holds (or null),
// `fieldFacts` that pull request's facts ({ok, pr} or {ok: false, reason}),
// `named` the counted pull requests whose body lines name it, each once.
// Returns {kind: none|unreadable|conflict|field|fill|replace, pr, change}.
export function storyLink({ field = null, fieldFacts = null, named = [] }) {
  const others = named.filter((p) => normUrl(p.url) !== normUrl(field));
  if (!field) {
    if (!named.length) return { kind: "none" };
    if (named.length > 1) return { kind: "conflict", urls: named.map((p) => p.url) };
    return { kind: "fill", pr: named[0], change: { from: null, to: named[0].url, reason: LINKED_REASON } };
  }
  if (!fieldFacts || !fieldFacts.ok)
    return { kind: "unreadable", url: field, reason: fieldFacts?.reason ?? "its facts were not read" };
  const pr = fieldFacts.pr;
  if (prState(pr) !== "closed")
    return others.length ? { kind: "conflict", urls: [field, ...others.map((p) => p.url)] } : { kind: "field", pr };
  const created = stampMs(pr.createdAt);
  const newer = others
    .map((p) => ({ p, at: stampMs(p.createdAt) }))
    .filter((x) => x.at !== null && (created === null || x.at > created))
    .sort((a, b) => b.at - a.at);
  if (!newer.length) return { kind: "field", pr };
  const next = newer[0].p;
  return { kind: "replace", pr: next, change: { from: field, to: next.url, reason: REPLACED_REASON } };
}

// ─── Contracts 4 and 7: the rows, the close and the awaiting line ─────

const AWAITING_LINE = new RegExp(`^${AWAITING_REASON}(?:: .+)?$`);

// The last `status:` line's target is done: reopened by hand, as no verb reopens a story.
const reopened = (text) => {
  const last = lastStatusLine(text);
  return Boolean(last && !last.unparsed && sameStatus(last.to, "done"));
};
const awaitingAlready = (text) => {
  const last = lastStatusLine(text);
  return Boolean(last && !last.unparsed && AWAITING_LINE.test(last.reason.trim()));
};

// What a refused close waits for: each unchecked or unevidenced criterion
// by its text, and any other finding by its kind.
export function awaitingWhat(judged, refusal) {
  const kinds = new Set(refusal.map((f) => f.check));
  const items = checklistItems(linesOutsideFences(sectionOf(judged, "acceptance") ?? ""));
  const ev = evidenceSuffixRe();
  const parts = [];
  if (kinds.has("acceptance")) for (const i of items.filter((x) => !x.checked)) parts.push(`unchecked "${i.text}"`);
  if (kinds.has("evidence"))
    for (const i of items.filter((x) => x.checked && !ev.test(x.text))) parts.push(`no evidence "${i.text}"`);
  for (const k of kinds) if (k !== "acceptance" && k !== "evidence") parts.push(k);
  return parts;
}

// One story's plan: its new text and what it says, as a pure function of its
// text and the facts. `named` are the counted pull requests whose body lines
// name it; `factsOf(url)` a pull request's facts ({ok, pr}, {ok: false,
// reason}, or null when not read); `branchOf(url)` its repository's default
// branch ({ok, branch}), or null when no merge may be judged; `refusal(judged)`
// the close's findings on the bytes closed at the run time; `ageReview` the
// policy's `flow.age_days.review`, or null. `now` is the run time, `day` its
// UTC day. Returns {content, from, to, pr, judged, closes, lines, notes,
// findings}: `lines` the status line, then the `pr:` line, each {field, from,
// to, reason, at, line}; notes and findings {code, pr, message}.
export function planStory(
  text,
  {
    named: lines = [],
    factsOf = () => null,
    branchOf = () => null,
    now,
    day,
    lang = "en",
    ageReview = null,
    refusal = null,
  },
) {
  // A line in a pull request closed without a merge is no link and no
  // conflict: only open and merged pull requests link (the maintainer,
  // 2026-11-13). A closed one in external_refs.pr still drives its row.
  const named = lines.filter((p) => prState(p) !== "closed");
  const nowMs = stampMs(now);
  if (nowMs === null) throw new Error(`the run time is not an instant: ${JSON.stringify(now)}`);
  const run = iso(nowMs);
  const fm = parseFrontmatter(text).data;
  const status = String(fm.status ?? "").trim();
  const low = status.toLowerCase();
  const column = NOT_ACTIONABLE.has(low) ? null : statusToColumn(low);
  const field = prUrlOf(text);
  const out = {
    content: text,
    from: status || EMPTY,
    to: status || EMPTY,
    pr: null,
    judged: false,
    closes: false,
    lines: [],
    notes: [],
    findings: [],
  };
  const say = (list, code, pr, message) => list.push({ code, pr: pr ?? null, message });

  // A done or set-aside story is never changed: a conflict is a note. One
  // with a closing pull request is judged (its epic row converges).
  if (column === null || column === "Done") {
    out.judged = Boolean(field || named.length);
    out.pr = field ?? named[0]?.url ?? null;
    const facts = field ? factsOf(field) : null;
    const closed = Boolean(facts && facts.ok && prState(facts.pr) === "closed");
    const others = named.filter((p) => normUrl(p.url) !== normUrl(field));
    if ((!field && named.length > 1) || (field && others.length && !closed))
      say(
        out.notes,
        "pr-conflict",
        field ?? named[0].url,
        `${status || "it"}: more than one pull request names it (${[field, ...others.map((p) => p.url)].filter(Boolean).join(", ")}); it is left as it is`,
      );
    return out;
  }

  // A map neither reader takes holds no link, and none is written over it.
  if (!externalRefs(text).ok) return out;
  const link = storyLink({ field, fieldFacts: field ? factsOf(field) : null, named });
  if (link.kind === "none") return out;
  out.judged = true;
  out.pr = link.pr?.url ?? link.url ?? link.urls?.[0] ?? null;
  if (link.kind === "unreadable") {
    say(out.findings, "pr-unreadable", link.url, `its pull request could not be read: ${link.reason}; it is unchanged`);
    return out;
  }
  if (link.kind === "conflict") {
    say(
      out.findings,
      "pr-conflict",
      link.urls[0],
      `more than one pull request closes it (${link.urls.join(", ")}); it is unchanged until one is left`,
    );
    return out;
  }
  const pr = link.pr;
  let t = text;
  const move = (to, reason, { at = run, equal = false } = {}) => {
    const c = applyStatusChange(t, { to, reason, actor: "follow", at, lang, equal });
    t = c.text;
    out.to = to;
    out.lines.push({ field: "status", from: status || EMPTY, to, reason, at, line: c.line });
  };

  if (column === "Backlog" || column === "ToDo") {
    say(
      out.notes,
      "pr-before-plan",
      pr.url,
      `${status || "with no status"}: a pull request closes it before its plan gate ran (${pr.url})`,
    );
  } else {
    const state = prState(pr);
    if (state === "merged") {
      const b = branchOf(pr.url);
      if (b && b.ok && pr.baseRefName !== b.branch) {
        say(
          out.notes,
          "pr-merged-elsewhere",
          pr.url,
          `${pr.url} merged into ${pr.baseRefName}, not ${b.branch}: no merge here`,
        );
      } else if (b && b.ok && reopened(text)) {
        say(
          out.notes,
          "pr-merged-reopened",
          pr.url,
          `${pr.url} merged, but the story was reopened after a close: it is unchanged`,
        );
      } else if (b && b.ok) {
        const c = closeForMerge(text, pr, { now: run, day, lang, findings: refusal });
        if (!c.refused) {
          t = c.written;
          out.to = "done";
          out.closes = true;
          const last = lastStatusLine(t);
          out.lines.push({
            field: "status",
            from: status,
            to: "done",
            reason: c.reason,
            at: c.stamp.at,
            line: last.line,
          });
        } else {
          const what = awaitingWhat(c.judged, c.refusal);
          say(out.notes, "awaiting-close", pr.url, `${pr.url} merged; the close waits for: ${what.join("; ")}`);
          if (!(column === "Review" && awaitingAlready(text)))
            move("review", `${AWAITING_REASON}: ${pr.url}`, {
              at: eventStamp(text, pr).at,
              equal: column === "Review",
            });
        }
      }
    } else if (column === "Review") {
      const stamp = statusStamp(text);
      if (state === "closed") move("in-progress", `pull request closed unmerged: ${pr.url}`);
      else if (pr.isDraft) move("in-progress", `pull request back to draft: ${pr.url}`);
      else if (ageReview !== null && stamp.trusted && meets(ageDays(stampMs(stamp.at), nowMs), ageReview))
        move("in-progress", `review older than ${ageReview} days`);
    } else if (column === "In Progress" && state === "open" && !pr.isDraft) {
      const stamp = statusStamp(text);
      const updated = stampMs(pr.updatedAt);
      if (!stamp.trusted || (updated !== null && updated > stampMs(stamp.at)))
        move("review", `pull request ready: ${pr.url}`);
    }
  }

  // The link, after the status line, at the run time: it does not move the floor.
  if (link.change) {
    const { from, to, reason } = link.change;
    t = withPrRef(t, to);
    const line = logLine({ at: run, field: "pr", from, to, reason, actor: "follow" });
    t = appendLogLine(t, line, lang);
    out.lines.push({ field: "pr", from: from ?? EMPTY, to, reason, at: run, line });
  }
  if (t !== text) t = touchStory(t, day);
  out.content = t;
  return out;
}

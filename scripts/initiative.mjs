// projectstore — initiative.mjs: the initiative kind's rules.
//
// An initiative records an outcome that several epics serve and the decision
// taken on it. Its status records the decision only; an epic names its
// parent in `initiative:`. This module holds the four statuses, the one rule
// that reads an initiative id, and doctor's three checks over the kind.
//
// Spec: "The initiative kind and its verbs" (alias `initiative`), the id rule
// of How we solve and contracts 4 to 6; ADR "An initiative is a kind above the
// epic that records a decision, born proposed or accepted, and an epic names
// it by an initiative field". Registered by doctor.mjs runVaultChecks, never by
// runStartupChecks (ADR-005 decision 4). Imports nothing of doctor.mjs, which
// imports this module; doctor hands in its finding factory and its story
// resolver.

import { sectionOf } from "./lib.mjs";

// The decision an initiative's file records (ADR, decision 3).
export const INITIATIVE_STATUSES = Object.freeze(["proposed", "accepted", "rejected", "deferred"]);
const DECIDED = new Set(["accepted", "rejected", "deferred"]);

// A status read trimmed and lower-cased; "" when there is none.
export const statusOf = (fm) =>
  String(fm?.status ?? "")
    .trim()
    .toLowerCase();

// An initiative file's id: its frontmatter `id`, else its file stem.
export function initiativeIdOf(a) {
  const id = typeof a.fm?.id === "string" ? a.fm.id.trim() : "";
  return id || a.rel.split("/").pop().replace(/\.md$/, "");
}

// What a key such as an epic's `initiative:` holds: none (`""`, `null`, an
// absent key), a list (any value written in brackets), or one id, trimmed.
export function referenceOf(raw) {
  if (raw === null || raw === undefined) return { kind: "none" };
  if (Array.isArray(raw)) return { kind: "list", raw: JSON.stringify(raw) };
  const s = String(raw).trim();
  if (!s) return { kind: "none" };
  if (s.startsWith("[")) return { kind: "list", raw: s };
  return { kind: "id", value: s };
}

// id → the initiatives that carry it, from any list of {rel, fm} items.
export function initiativeIndex(items) {
  const byId = new Map();
  for (const a of items) {
    const id = initiativeIdOf(a);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(a);
  }
  return byId;
}

// The one id rule: a value names an initiative when exactly one file carries
// it, compared case-sensitively. Anything else is no initiative (null).
export function resolveInitiative(index, ref) {
  if (!ref || ref.kind !== "id") return null;
  const hits = index.get(ref.value) || [];
  return hits.length === 1 ? hits[0] : null;
}

// An Outcome line for a decision: `- YYYY-MM-DD <status>: <reason>`, with a
// valid date and a reason that is not blank. A full-width colon counts too.
const OUTCOME_LINE = /^\s*[-*]\s+(\d{4})-(\d{2})-(\d{2})\s+([A-Za-z]+)\s*[:：]\s*(\S.*)$/;
function validDate(y, m, d) {
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d;
}
export function outcomeLines(body) {
  const sec = sectionOf(body || "", "initiative_outcome");
  if (sec === null) return [];
  const out = [];
  for (const line of sec.split(/\r?\n/)) {
    const m = line.match(OUTCOME_LINE);
    if (m && validDate(m[1], m[2], m[3]))
      out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, status: m[4].toLowerCase(), reason: m[5].trim() });
  }
  return out;
}

// A section that holds nothing but blank lines and HTML comments is empty;
// so is a section that is not there.
export function sectionEmpty(body, id) {
  const sec = sectionOf(body || "", id);
  if (sec === null) return true;
  return sec.replace(/<!--[\s\S]*?-->/g, "").trim() === "";
}

// Doctor's three checks (contracts 4 to 6). `finding(level, check, message,
// file)` builds one finding; `resolveStory(entry)` resolves a qualified
// `<EPIC>/<story-id>` as a spec's `stories:` entry is ({story} or {error}).
// A layout with no initiative kind runs none of them.
export function checkInitiatives(layout, artifacts, { finding, resolveStory, epicIdOf }) {
  if (!(layout.folders || []).some((f) => f.kind === "initiative")) return [];
  const out = [];
  const initiatives = artifacts.filter((a) => a.kind === "initiative");
  const index = initiativeIndex(initiatives);
  const epics = artifacts.filter((a) => a.kind === "epic");
  const namedBy = new Map();

  for (const e of epics) {
    const ref = referenceOf(e.fm.initiative);
    if (ref.kind === "none") continue;
    const epic = epicIdOf(e) || e.rel;
    if (ref.kind === "list") {
      out.push(
        finding(
          "issue",
          "initiative-links",
          `Epic ${epic} has initiative: ${ref.raw}, a list; the key holds one initiative id, not a list.`,
          e.rel,
        ),
      );
      continue;
    }
    const hit = resolveInitiative(index, ref);
    if (!hit) {
      const n = (index.get(ref.value) || []).length;
      out.push(
        finding(
          "issue",
          "initiative-links",
          n > 1
            ? `Epic ${epic} names initiative "${ref.value}", which ${n} files in initiatives carry as their id.`
            : `Epic ${epic} names initiative "${ref.value}", which is the id of no file in initiatives.`,
          e.rel,
        ),
      );
      continue;
    }
    namedBy.set(hit.rel, (namedBy.get(hit.rel) || 0) + 1);
  }

  for (const a of initiatives) {
    const ref = referenceOf(a.fm.elaboration);
    if (ref.kind !== "none") {
      const r = ref.kind === "id" ? resolveStory(ref.value) : { error: "a list" };
      if (!r || !r.story) {
        out.push(
          finding(
            "issue",
            "initiative-links",
            `Initiative ${initiativeIdOf(a)} has elaboration: ${ref.kind === "id" ? `"${ref.value}"` : ref.raw}, which resolves to no story (${r && r.error ? r.error : "no match"}).`,
            a.rel,
          ),
        );
      }
    }
    const status = statusOf(a.fm);
    if (!INITIATIVE_STATUSES.includes(status)) {
      out.push(
        finding(
          "warn",
          "initiative-status",
          `Initiative ${initiativeIdOf(a)} has status ${status || "none"}; an initiative records one of ${INITIATIVE_STATUSES.join(", ")}.`,
          a.rel,
        ),
      );
      continue;
    }
    if (status === "accepted" && !namedBy.get(a.rel)) {
      out.push(
        finding(
          "warn",
          "initiative-decision",
          `Initiative ${initiativeIdOf(a)} is accepted, but no epic names it in initiative:.`,
          a.rel,
        ),
      );
    }
    if (DECIDED.has(status) && !outcomeLines(a.body).some((l) => l.status === status)) {
      out.push(
        finding(
          "warn",
          "initiative-decision",
          `Initiative ${initiativeIdOf(a)} is ${status}, but its Outcome has no line "- YYYY-MM-DD ${status}: <reason>".`,
          a.rel,
        ),
      );
    }
    if (status === "accepted" && sectionEmpty(a.body, "initiative_success")) {
      out.push(
        finding(
          "info",
          "initiative-decision",
          `Initiative ${initiativeIdOf(a)} is accepted with an empty Success criterion, so nothing says when its outcome is reached.`,
          a.rel,
        ),
      );
    }
  }
  return out;
}

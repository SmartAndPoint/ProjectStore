// projectstore — verb-mark.mjs: the not-reviewed mark a create or an edit
// verb leaves on what it writes, and the one predicate every reader asks.
//
// A file a create verb writes carries `written_by_verb: "<verb> <instant>"`
// until a review clears it (the ADR "Create and edit verbs write an artifact
// outside the harness commands, for any caller, and mark what they write not
// reviewed", decisions 5 and 6). The story gates, `follow` and doctor read it
// through isMarked and markOf below, never through the key's text; only
// item-verbs.mjs writes the key, and only its `reviewed` removes it (spec
// "Create verbs and the not-reviewed mark…", alias `create`, contract 4,
// pinned by tests/verb-mark.test.mjs).
//
// Pure, and it imports nothing: follow-plan.mjs, which may read no file,
// the clock or the process, imports it.

export const MARK_KEY = "written_by_verb";

// A file is marked when its frontmatter's key holds a non-empty string after
// trimming: `""`, `null` and an absent key are no mark.
export function isMarked(fm) {
  const v = fm ? fm[MARK_KEY] : undefined;
  return typeof v === "string" && v.trim() !== "";
}

// The mark as {verb, at, raw}, or null when the file is not marked. `verb`
// and `at` are the value's first two words; a value of another shape keeps
// them as it can, and `raw` holds it whole.
export function markOf(fm) {
  if (!isMarked(fm)) return null;
  const raw = fm[MARK_KEY].trim();
  const [verb = "", at = ""] = raw.split(/\s+/);
  return { verb, at, raw };
}

// Doctor's `verb-mark` (the create spec, contract 10): an `info` for each
// marked artifact, naming the verb, the instant and the review command that
// clears it; an `issue` instead when the file also says `review_status:
// reviewed`. It follows no gate. `finding(level, check, message, file)` and
// `reviewCommand(rel)` come from doctor, so this module stays pure.
export function checkVerbMarks(artifacts, { finding, reviewCommand }) {
  const out = [];
  for (const a of artifacts) {
    const m = markOf(a.fm);
    if (!m) continue;
    const reviewed =
      String(a.fm.review_status ?? "")
        .trim()
        .toLowerCase() === "reviewed";
    out.push(
      reviewed
        ? finding(
            "issue",
            "verb-mark",
            `This file says review_status: reviewed but still holds ${MARK_KEY} (${m.raw}): one of the two is wrong. After a review, clear the mark:\n${reviewCommand(a.rel)}`,
            a.rel,
          )
        : finding(
            "info",
            "verb-mark",
            `Written by ${m.verb || "a verb"}${m.at ? ` at ${m.at}` : ""} and not reviewed since. Review it, which clears the mark:\n${reviewCommand(a.rel)}`,
            a.rel,
          ),
    );
  }
  return out;
}

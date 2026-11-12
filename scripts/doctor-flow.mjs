// projectstore — doctor-flow.mjs: doctor's flow group.
//
// A team lead runs doctor and sees where the flow is stuck: who holds more
// work than their limit, which review or ToDo story is too old, which story
// in progress has nothing happening, who has gone quiet, whether the team
// takes in more than it closes, and whether ToDo holds more than the team can
// do. Each check reads its threshold from the vault's `flow` block
// (flow-policy.mjs); a check whose key is absent, or outside its key's set,
// does not run. The counts are flow-counts.mjs's; activity is the project's
// local commits, read once per run through the `commits` seam
// (diff-refs.mjs commitsSince). Flow is advice: every finding is a warn or an
// info in the vault group, never an issue, so doctor's exit code does not
// move. It reads the vault and the project's local git and nothing else, and
// it never throws: a failure inside it is one `flow-checks-failed`.
//
// Spec: "Doctor's flow findings: local git activity, idle work and people,
// the policy gate, levels and privacy" (alias `flow-findings`), contracts 1
// to 11, and "Flow counts…" (alias `flow-counts`), the findings of its
// contracts 2 to 7. Registered by doctor.mjs runVaultChecks, never by
// runStartupChecks (ADR-005 decision 4). Imports nothing of doctor.mjs, which
// imports this module.

import { folderByKind, fromTerminalIn, listOf } from "./lib.mjs";
import { packageCommand } from "./harness.mjs";
import {
  flowValue,
  flowDeclared,
  flowProblems,
  flowPeople,
  gitNamesOf,
  wipLimitOf,
  isEmailAddress,
} from "./flow-policy.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import {
  DAY_MS,
  storyFacts,
  ageDays,
  meets,
  agedIn,
  wipByPerson,
  windowOf,
  windowCounts,
  isYoung,
  capacityVerdict,
  oldestFirst,
} from "./flow-counts.mjs";
import { stampMs } from "./status-log.mjs";
import { refCovers } from "./code-refs.mjs";

// Each flow check's one level (the flow-findings spec, contract 9). None is
// an issue.
export const FLOW_LEVELS = Object.freeze({
  "wip-over-limit": "warn",
  "review-aged": "warn",
  "in-progress-idle": "warn",
  "assignee-idle": "warn",
  "intake-over-close": "warn",
  "todo-over-capacity": "warn",
  "flow-policy-invalid": "warn",
  "flow-checks-failed": "warn",
  "todo-aged": "info",
  "todo-under-capacity": "info",
  "todo-capacity-unknown": "info",
  "flow-window-young": "info",
  "status-unstamped": "info",
  "closed-unstamped": "info",
  "flow-policy-unset": "info",
  "flow-person-unknown": "info",
  "flow-activity-unknown": "info",
  "flow-stories-unread": "info",
});
export const FLOW_CHECKS = Object.freeze(Object.keys(FLOW_LEVELS));

// The one message per reason git could not answer (contract 3): built from
// this fixed set alone, so nothing of git's output reaches a finding.
const ACTIVITY_TEXT = Object.freeze({
  "no-git": "git is not installed",
  "not-a-repository": "the project is not a git repository",
  shallow: "the repository is a shallow clone, so an older commit may be cut off",
  timeout: "git did not answer in time",
  failed: "git failed",
});

const VAULT_REPO = "A vault kept in a repository of its own is not read, so commits made only there do not count.";
const NAMED_MAX = 8;
const EMAIL_SHAPED = "an email-shaped name";

function finding(check, message, extra = {}) {
  return { group: "vault", level: FLOW_LEVELS[check], check, message, ...extra };
}

// A person as a message names them: never an email address (contract 10).
const who = (name) => (isEmailAddress(name) ? EMAIL_SHAPED : name);
const shownKey = (key) => (isEmailAddress(key) ? `a key under flow with ${EMAIL_SHAPED}` : key);
const refOf = (f) => `${f.epic}/${f.slug}`;
const num = (n) => String(Math.round(n * 100) / 100);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// At most eight stories named, and how many more (contract 10).
function named(facts) {
  const shown = facts.slice(0, NAMED_MAX).map(refOf).join(", ");
  return facts.length > NAMED_MAX ? `${shown} and ${facts.length - NAMED_MAX} more` : shown;
}

const fromWhere = (f) =>
  f.age.trusted ? "" : ` (the age is read from ${f.age.source}, since the status stamp is not trusted)`;

// The last guard of contract 10: no email-shaped word leaves the group, in a
// message, a file or a story path.
function scrub(f) {
  const clean = (s) =>
    String(s)
      .split(/(\s+)/)
      .map((w) => (isEmailAddress(w) ? "<address>" : w))
      .join("");
  const out = { ...f, message: clean(f.message) };
  if (out.file) out.file = clean(out.file);
  if (out.stories) out.stories = out.stories.map(clean);
  return out;
}

// The group: one run over the vault's stories and policy, at `now` (an ISO
// instant or epoch ms) read once by the caller. `commits(proj, sinceIso)` is
// called at most once, and only when an activity check can run. `read` is
// the story reader's file seam (flow-stories.mjs), a test's.
export function checkFlow({ cfg, layout, vaultCfg, proj, now, commits, read }) {
  try {
    return flowFindings({ cfg, layout, vaultCfg, proj, now, commits, read }).map(scrub);
  } catch (e) {
    return [
      scrub(
        finding(
          "flow-checks-failed",
          `The flow checks failed and were skipped: ${e?.message || e}. The other findings are not affected.`,
        ),
      ),
    ];
  }
}

function flowFindings({ cfg, layout, vaultCfg, proj, now, commits, read: readFile }) {
  if (!flowDeclared(vaultCfg)) {
    return [
      finding(
        "flow-policy-unset",
        "The vault has no flow policy, so no flow check runs. Each check starts once configure sets its key, in the form --set flow.<key>=<value>.",
      ),
    ];
  }
  const asOf = typeof now === "number" ? now : stampMs(now);
  if (asOf === null) throw new Error("the run's instant does not read");
  const out = [];

  // Contracts 7 and 8: what the readers ignore, named by key, never by value.
  for (const p of flowProblems(vaultCfg)) {
    let message;
    if (p.invalidName)
      message =
        "A person key in flow.people is not a valid name: it is empty, holds @, ], = or a control character, or is __proto__. Every flow check ignores it.";
    else if (p.unknown) message = `${shownKey(p.key)} is not a flow setting this version knows, so no check reads it.`;
    else if (p.smallBound)
      message = `${p.key} takes ${p.set}: a bound must be at least 0.01, so the capacity checks do not run.`;
    else message = `${shownKey(p.key)} takes ${p.set}, so the flow checks ignore its value.`;
    out.push(finding("flow-policy-invalid", message));
  }

  const review = flowValue(vaultCfg, "age_days.review");
  const todoDays = flowValue(vaultCfg, "age_days.todo");
  const ipIdle = flowValue(vaultCfg, "age_days.in_progress_idle");
  const idleDays = flowValue(vaultCfg, "idle_days");
  const weeks = flowValue(vaultCfg, "window_weeks");
  const bounds = flowValue(vaultCfg, "capacity_weeks");
  const people = flowPeople(vaultCfg);
  const listed = vaultCfg.flow?.people;
  const peopleSet = listed !== null && typeof listed === "object" && !Array.isArray(listed);
  const anyCheck = [review, todoDays, ipIdle, idleDays, weeks].some((v) => v !== null) || people.size > 0;
  if (!anyCheck) return out;

  const epics = folderByKind(layout, "epic");
  const read = epics
    ? readFlowStories(cfg.vault_path, epics.path, readFile ? { read: readFile } : {})
    : { stories: [], unread: 0 };
  const facts = read.stories.map(storyFacts);
  if (read.unread > 0)
    out.push(
      finding(
        "flow-stories-unread",
        `${plural(read.unread, "story file or folder", "story files or folders")} could not be read and ${read.unread === 1 ? "is" : "are"} left out, so the flow counts can be low.`,
      ),
    );

  // Flow counts, contract 5: WIP per person against the limit rule.
  const wip = wipByPerson(facts);
  for (const [name, { held, awaiting }] of wip) {
    const limit = wipLimitOf(vaultCfg, name);
    if (limit === null || held.length <= limit) continue;
    const stories = oldestFirst(held);
    const apart = awaiting.length
      ? ` ${awaiting.length} more awaiting close ${awaiting.length === 1 ? "is" : "are"} counted apart.`
      : "";
    out.push(
      finding(
        "wip-over-limit",
        `${who(name)} holds ${held.length} stories in progress or review, over their WIP limit of ${limit}: ${named(stories)}.${apart}`,
        { stories: stories.map((f) => f.rel) },
      ),
    );
  }

  // Flow counts, contract 3: age in status.
  const unstamped = { untrusted: [], undated: [] };
  if (review !== null) {
    const r = agedIn(facts, "Review", review, asOf);
    for (const f of r.aged) {
      const close = f.awaiting ? " It is awaiting close: merged, with its evidence still to record." : "";
      out.push(
        finding(
          "review-aged",
          `${refOf(f)} has been in review for ${plural(f.days, "day")}, at or past flow.age_days.review of ${review}${fromWhere(f)}.${close}`,
          { file: f.rel },
        ),
      );
    }
    unstamped.untrusted.push(...r.untrusted);
    unstamped.undated.push(...r.undated);
  }
  if (todoDays !== null) {
    const t = agedIn(facts, "ToDo", todoDays, asOf);
    for (const f of t.aged) {
      const cmd = packageCommand([], "move", {
        args: `${refOf(f)} planned --reason 'in ToDo for ${f.days} days' --write`,
      });
      out.push(
        finding(
          "todo-aged",
          `${refOf(f)} has been in ToDo for ${plural(f.days, "day")}, at or past flow.age_days.todo of ${todoDays}${fromWhere(f)}. Look at it in the next grooming pass. It can go back to the backlog, ${fromTerminalIn(proj)}:\n${cmd}`,
          { file: f.rel },
        ),
      );
    }
    unstamped.untrusted.push(...t.untrusted);
    unstamped.undated.push(...t.undated);
  }
  const nUntrusted = unstamped.untrusted.length;
  const nUndated = unstamped.undated.length;
  if (nUntrusted + nUndated > 0) {
    const parts = [];
    if (nUntrusted)
      parts.push(
        `${plural(nUntrusted, "story", "stories")} ${nUntrusted === 1 ? "has its" : "have their"} age in status read from updated or created, not from a trusted status stamp, so the age can be understated`,
      );
    if (nUndated)
      parts.push(
        `${plural(nUndated, "story", "stories")} ${nUndated === 1 ? "has" : "have"} no date at all and ${nUndated === 1 ? "is" : "are"} not aged`,
      );
    out.push(
      finding("status-unstamped", `${parts.join("; ")}.`, {
        stories: [...oldestFirst(unstamped.untrusted), ...oldestFirst(unstamped.undated)].map((f) => f.rel),
      }),
    );
  }

  // The flow-findings spec, contracts 1 to 5: local git activity.
  if (ipIdle !== null || idleDays !== null) {
    const back = Math.max(ipIdle ?? 0, idleDays ?? 0) + 1;
    const r = commits(proj, new Date(asOf - back * DAY_MS).toISOString());
    if (!r || r.status !== "ok") {
      const reason = Object.hasOwn(ACTIVITY_TEXT, r?.reason) ? r.reason : "failed";
      out.push(
        finding(
          "flow-activity-unknown",
          `The idle checks did not run: ${ACTIVITY_TEXT[reason]} (${reason}). A failed read is not taken as no commit.`,
        ),
      );
    } else out.push(...idleFindings({ facts, wip, vaultCfg, asOf, ipIdle, idleDays, commits: r.commits }));
  }

  // Flow counts, contracts 6 and 7: the window, intake, closes and capacity.
  if (weeks !== null) {
    const win = windowOf(asOf, weeks);
    const counts = windowCounts(facts, win);
    const young = isYoung(facts, win);
    if (young)
      out.push(
        finding(
          "flow-window-young",
          `The vault is younger than flow.window_weeks of ${weeks}: no counted story was created on or before ${day(win.from)}, so intake against close and ToDo against capacity are not judged yet.`,
        ),
      );
    else if (counts.created.length > counts.closed.length)
      out.push(
        finding(
          "intake-over-close",
          `Over the ${plural(weeks, "week")} from ${day(win.from)} to ${day(win.to)}, ${counts.created.length} stories were created and ${counts.closed.length} closed (${num(counts.created.length / weeks)} and ${num(counts.closed.length / weeks)} a week): the team takes in more than it closes.`,
        ),
      );
    if (counts.closedUnstamped.length)
      out.push(
        finding(
          "closed-unstamped",
          `${plural(counts.closedUnstamped.length, "done story", "done stories")} updated in the window ${counts.closedUnstamped.length === 1 ? "has" : "have"} no closed_at, so no week holds the close and the closes can read low.`,
          { stories: oldestFirst(counts.closedUnstamped).map((f) => f.rel) },
        ),
      );
    if (bounds !== null && !young) {
      const todo = facts.filter((f) => f.column === "ToDo").length;
      const v = capacityVerdict({ todo, closed: counts.closed.length, weeks, bounds });
      const at = `at a throughput of ${num(v.throughput)} a week (flow.capacity_weeks ${bounds[0]},${bounds[1]})`;
      if (v.verdict === "unknown")
        out.push(
          finding(
            "todo-capacity-unknown",
            `No story was closed in the ${plural(weeks, "week")} from ${day(win.from)}, so there is no throughput to measure ToDo against.`,
          ),
        );
      else if (v.verdict === "over")
        out.push(
          finding(
            "todo-over-capacity",
            `ToDo holds ${todo} stories, above the ${num(v.high)} the team can do in ${plural(bounds[1], "week")} ${at}.`,
          ),
        );
      else if (v.verdict === "under")
        out.push(
          finding(
            "todo-under-capacity",
            `ToDo holds ${todo} stories, below the ${num(v.low)} the team can do in ${plural(bounds[0], "week")} ${at}.`,
          ),
        );
    }
  }

  // The flow-findings spec, contract 8: a listed person no story names.
  if (peopleSet) {
    const assigned = new Set(facts.map((f) => f.assignee));
    for (const name of people.keys())
      if (!assigned.has(name))
        out.push(
          finding("flow-person-unknown", `${who(name)} is listed in flow.people, but no story names them as assignee.`),
        );
  }
  return out;
}

// The names a person's commits are matched on: their assignee name, as the
// stories write it, and their git names less any email-shaped entry
// (contract 8). A name is only ever printed through who().
export function namesOf(vaultCfg, name) {
  return [...new Set([name, ...gitNamesOf(vaultCfg, name)])];
}

// A commit's activity time for a person (contract 1): its author time when
// the author name is theirs, its committer time when the committer name is,
// the later when both are; null when neither is.
export function activityTime(c, names) {
  let t = null;
  if (names.has(c.authorName)) t = c.authorMs;
  if (names.has(c.committerName)) t = t === null ? c.committerMs : Math.max(t, c.committerMs);
  return t;
}

function idleFindings({ facts, wip, vaultCfg, asOf, ipIdle, idleDays, commits }) {
  const out = [];
  const namesFor = new Map();
  const nameSet = (person) => {
    if (!namesFor.has(person)) namesFor.set(person, new Set(namesOf(vaultCfg, person)));
    return namesFor.get(person);
  };
  const latest = (person, touches) => {
    let t = null;
    const names = nameSet(person);
    for (const c of commits) {
      const at = activityTime(c, names);
      if (at !== null && (t === null || at > t) && touches(c)) t = at;
    }
    return t;
  };

  // Contract 4: idle work.
  if (ipIdle !== null)
    for (const f of oldestFirst(facts.filter((x) => x.column === "In Progress" && x.assignee && x.start !== null))) {
      const refs = listOf(f.fm, "code_refs");
      const touches = refs.length ? (c) => c.paths.some((p) => refs.some((r) => refCovers(r, p))) : () => true;
      const commit = latest(f.assignee, touches);
      const last = commit === null ? f.start : Math.max(f.start, commit);
      if (!meets(ageDays(last, asOf), ipIdle)) continue;
      const what = refs.length ? " that touches its code_refs" : "";
      const n = plural(ipIdle, "day");
      out.push(
        finding(
          "in-progress-idle",
          `${refOf(f)} is in progress, and ${who(f.assignee)} has no local commit in the last ${n}${what}. ${VAULT_REPO}`,
          { file: f.rel },
        ),
      );
    }

  // Contract 5: idle people.
  if (idleDays !== null)
    for (const [person, { held }] of wip) {
      if (!held.length) continue;
      const starts = held.map((f) => f.start).filter((s) => s !== null);
      if (!starts.length || !meets(ageDays(Math.min(...starts), asOf), idleDays)) continue;
      const commit = latest(person, () => true);
      if (commit !== null && !meets(ageDays(commit, asOf), idleDays)) continue;
      const looked = namesOf(vaultCfg, person).map(who);
      const stories = oldestFirst(held);
      out.push(
        finding(
          "assignee-idle",
          `${who(person)} holds ${plural(held.length, "story", "stories")} in progress or review and has no local commit in the last ${idleDays} days ${looked.length ? `under the names ${looked.join(", ")}` : "under any name doctor can match"}: ${named(stories)}. The work can be handed over to someone else. ${VAULT_REPO}`,
          { stories: stories.map((f) => f.rel) },
        ),
      );
    }
  return out;
}

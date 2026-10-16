// projectstore — install-preview.mjs: PLAN, the badge, the update notice and
// the APPLY lines (presentation spec contracts 6–8).
//
// Moved out of install-harness.mjs as it was (the story "The installer is
// split into modules under 200 KiB each, with every export and every test
// unchanged"). Pure: renderPreview, badgeLine and noticeText return strings,
// and applyReporter writes only to the stream it is handed. The installer
// re-exports all four under the names its callers import, and its DONE and
// STOPPED screens (renderDone) read the row helpers from here.
//
// A leaf: it imports neither the installer nor any module that reads the
// registry, fetches a shell or runs a host command.

import { dirname, basename } from "node:path";
import { homedir } from "node:os";
import {
  painter,
  icon as termIcon,
  stepReporter,
  wrap,
  plain,
  badge as badgeText,
  heading,
  rowLines,
  commandBlock,
  PLAIN,
} from "./term.mjs";
import { loadHarness } from "./harness.mjs";
import { rel, isConsequence, isWrite } from "./install-handlers.mjs";

// ─── preview ───────────────────────────────────────────────────────────
//
// PLAN (presentation spec contract 7, which revises the layout clauses of
// install spec contract 18): the badge, the project path, a summary line of
// counts, then the rows grouped under each run harness's display name, in run
// order. A row is one aligned line — glyph, action word, target, note — and
// beneath it what the reader consents to (install spec contract 9: every path
// written and every host argv, with the files it touches), the reason when
// there is one, and a consequence the reader must know. Internal words —
// kinds, provenance states, entry markers, roadmap ids — and each step's why
// are behind `--verbose`. Groups and counts are computed here, never added to
// the plan: plan --json keeps its keys. Colour and glyphs are the caller's
// stream's (`caps`, term.mjs); the default is plain text in Unicode.
const unicodeGlyph = (name) => termIcon({ ascii: false }, name);

// Every action a plan item can carry, as its glyph. A write never wears the
// skip glyph: `add` and `replace-entry` are changes as much as `create` and
// `update`.
// A copy from another marketplace turned off for this checkout is a channel
// switch, `disable` (the converge story; contract 7's `switch` word, ⇄).
const ACTION_ICON = {
  create: "create",
  add: "create",
  update: "update",
  "replace-entry": "update",
  migrate: "migrate",
  disable: "switch",
  cleanup: "cleanup",
  remove: "remove",
  prune: "remove",
  skip: "skip",
  refuse: "refuse",
};
// …and as a person's word (contract 7's table). A registration's write takes
// `register`; a skip reads `unchanged` when the item is current and carries
// no reason, and `skipped` otherwise — deferred, opted out, unsupported, or
// left in place: a current row with a reason is one the run did not act on
// for that reason (uninstall keeping a user-global registration, a host CLI
// not on PATH), and the reason beneath it is what the reader acts on.
const ACTION_WORD = {
  create: "add",
  add: "add",
  update: "update",
  "replace-entry": "update",
  migrate: "update",
  disable: "switch",
  cleanup: "remove",
  remove: "remove",
  prune: "remove",
  refuse: "refused",
};
// Each word's colour role (contract 3): a refusal's ▲, a channel switch and a
// removal are attention; red is for what failed.
const WORD_ROLE = {
  add: "done",
  register: "done",
  update: "action",
  switch: "attention",
  remove: "attention",
  refused: "attention",
  unchanged: "explanation",
  skipped: "explanation",
};
// APPLY says a word while its step runs and once it has (contract 8).
const WORD_TENSES = {
  add: ["adding", "added"],
  register: ["registering", "registered"],
  update: ["updating", "updated"],
  switch: ["switching", "switched"],
  remove: ["removing", "removed"],
};

const CURRENT_STATES = new Set(["current", "ours-current", "ours"]);
const isUnchanged = (i) => i.action === "skip" && !i.deferred && !i.reason && CURRENT_STATES.has(i.state);
// A surface this harness does not have: folded into one line per harness.
const isUnsupported = (i) => i.action === "skip" && i.state === "unsupported";
// A row of something another project wrote last (install spec contract 12):
// never collapsed, and its note says whose it is.
const writtenElsewhere = (i) => i.state === "current" && Boolean(i.writtenBy) && !i.sameProject;
// A row that writes nothing and asks nothing of the reader collapses into
// one line per group naming it (contract 7).
const isQuiet = (i) => isUnchanged(i) && !writtenElsewhere(i) && !(i.steps || []).length;
// The registration row a fetched shell's registry lines sit beneath, when the
// run fetched one from a registry that is not the user's.
const fetchedFor = (p, i) =>
  p.fetchedFrom &&
  i.kind === "registration" &&
  !String(i.surface).endsWith("_others") &&
  p.fetchedFrom.harnesses.includes(i.harness)
    ? p.fetchedFrom
    : null;

function actionWord(i) {
  if (i.action === "skip") return isUnchanged(i) ? "unchanged" : "skipped";
  if (i.kind === "registration" && ["create", "add", "update"].includes(i.action)) return "register";
  return ACTION_WORD[i.action] || "update";
}
const glyphName = (i) => ACTION_ICON[i.action] || (isWrite(i) ? "update" : "skip");
// The surface key in words: `agents_block` reads "agents block".
export const surfaceWords = (key) => String(key).replace(/_/g, " ");
// What a row names: a registration by its plugin id — its paths are the
// consent lines beneath it — anything else by its path, project-relative.
export function rowTarget(p, i, home = homedir()) {
  // …and the keep (kind `channel`) by the key of the copy it keeps.
  if ((i.kind === "registration" || i.kind === "channel") && i.entry) return i.entry;
  if (i.path === null) return `${i.surface} [${i.harness}, no filesystem path]`;
  // Setup's vault and state directories, as directories; a vault outside the
  // project — beside it, usually — by its path from home, as the project's.
  if (i.kind === "vault") {
    const r = rel(p.projectDir, i.path);
    return `${r === i.path ? tilde(i.path, home) : r}/`;
  }
  if (i.kind === "state") return `${rel(p.projectDir, i.path)}/`;
  return rel(p.projectDir, i.path);
}
// The heading of the group of rows that belong to no harness: setup's vault
// (presentation spec contract 7's VAULT group, first when present).
export const VAULT_GROUP = "Vault";
function rowNote(i, { verbose, glyph }) {
  const words = writtenElsewhere(i) ? `last written by ${i.writtenBy}` : surfaceWords(i.surface);
  if (!verbose) return words;
  return `${words} ${glyph("dot")} ${i.kind}${i.entry && i.kind !== "registration" ? ` [${i.entry}]` : ""}`;
}
// --verbose's line beneath a row: the provenance state, the reason and the
// plan's own action, as install spec contract 18 wrote them.
function transitionText(i, glyph) {
  let state = writtenElsewhere(i) ? `current, last written by ${i.writtenBy}` : i.state;
  // A reason with commands gives its prose here; the commands follow, alone.
  const reason = i.advice ? i.advice.text : i.reason;
  if (reason && i.action !== "refuse") state += ` (${reason})`;
  // A dry run's unchanged registration: right by every host fact, its
  // payload digest still to compare. Said only where the reasoning is.
  if (i.digestDeferred) state += " (the payload digest is compared when install or upgrade fetches the shell)";
  return `${state} ${glyph("transition")} ${i.action}${i.action === "refuse" && i.reason ? ": " + i.reason : ""}`;
}

// One step of an item as the lines it shows: always the action and its target,
// then — under --verbose — why it runs.
function stepLines(p, st, { verbose, paint, width = 0, glyph = unicodeGlyph, home = homedir() }) {
  const r = (x) => rel(p.projectDir, x);
  // A path outside the project — setup's vault, beside it usually — from
  // home, as its row and its APPLY lines name it.
  const t = (x) => tilde(r(x), home);
  const to = ` ${glyph("transition")} `;
  const lead = "      ";
  const sub = "          ";
  const why =
    verbose && st.why
      ? wrap(st.why, width, sub)
          .split("\n")
          .map((l, k) => (k ? "" : sub) + paint("explanation", l))
      : [];
  // A consent line (install spec contract 9): the step's verb and what it
  // touches, in the explanation role (presentation spec contracts 3 and 7).
  const said = (text) => `${lead}${paint("explanation", text)}`;
  switch (st.kind) {
    case "host": {
      // The keep step's argv is whole (its bin is the Node that runs us), and
      // its touches are the kept copy's planned writes, each with its action.
      const out = [said(`$ ${(st.bin ? [st.bin, ...st.argv] : st.argv).join(" ")}`)];
      if (st.touches.length)
        out.push(
          `${sub}${paint("explanation", `touches ${st.touches.map((t) => (typeof t === "string" ? r(t) : `${t.path ? r(t.path) : t.surface} (${t.action})`)).join(", ")}`)}`,
        );
      return [...out, ...why];
    }
    // The fetch a dry run would run first (the shell-fetch story's rule 6),
    // with the fetch glyph (presentation spec contract 4).
    case "fetch":
      return [
        `${lead}${paint("action", glyph("fetch"))} ${paint("explanation", [st.bin, ...st.argv].join(" "))}`,
        ...why,
      ];
    case "note":
      return wrap(`note: ${st.why}`, width, sub)
        .split("\n")
        .map((l, k) => (k ? l : lead + paint("attention", "note:") + l.slice(5)));
    case "write":
      return [
        said(`write ${st.path}${st.manifestOnly ? " (manifest only)" : ` (${st.files} files + the manifest)`}`),
        ...why,
      ];
    // A dry run names no file count: the payload is counted after the fetch.
    case "portable-write":
      return [
        said(
          `stage ${st.path} (${Array.isArray(st.files) ? `${st.files.length} payload files` : "the fetched payload"} + catalogue + ownership)`,
        ),
        ...why,
      ];
    case "rmdir-state":
      return [
        said(
          `remove ${r(st.path)}/ once empty${st.left?.length ? ` ${glyph("dash")} ${st.left.join(", ")} stay${st.left.length === 1 ? "s" : ""} and keep${st.left.length === 1 ? "s" : ""} it` : ""}`,
        ),
        ...why,
      ];
    case "portable-remove":
    case "remove":
      return [said(`remove ${st.path}`), ...why];
    case "unregister":
      return [said(`edit ${r(st.path)}  [${st.pointer}.${st.name}]${to}removed`), ...why];
    // The channel switch's record in the binding (the converge story's rules
    // 2 and 4): its time is the apply's, unknown to a preview.
    case "mark":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}by "setup", at the time of apply`), ...why];
    case "unmark":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}removed`), ...why];
    // A `binding` item's value (the setup story's status-line flag).
    case "set":
      return [said(`edit ${r(st.path)}  [${st.key}]${to}${JSON.stringify(st.value)}`), ...why];
    // Setup's vault (rule 10), the binding plan's own steps: every path is in
    // the default view. A scaffold step's paths are the vault's, beneath the
    // row that names it.
    case "mkdir":
      return [said(`create ${t(st.path)}/`), ...why];
    case "bind":
      return [
        said(
          `write ${r(st.path)}  (${st.from ? `the binding of ${st.from}${st.drop?.length ? `, without ${st.drop.join(" and ")}` : ""}` : `vault_path, layout ${st.layout}, language ${st.language}`})`,
        ),
        ...why,
      ];
    case "git-init":
      return [
        said(`$ ${st.argv.join(" ")}`),
        `${sub}${paint("explanation", `in ${t(st.path)}, with no commit`)}`,
        ...why,
      ];
    case "scaffold":
      return [said(`create ${st.rels.join(" and ")}`), ...why];
    case "ensure":
      return [said(`ensure ${r(st.path)}/`), ...why];
    case "move-state":
      return [said(`move ${r(st.from)}/${to}${r(st.to)}/ (${st.files} entries)`), ...why];
    case "merge-log":
      return [said(`merge ${r(st.from)}${to}${r(st.to)}`), ...why];
    case "delete":
      return [said(`delete ${r(st.path)}`), ...why];
    case "move-marker":
      return [said(`move ${r(st.from)}${to}${r(st.to)}`), ...why];
    case "move-binding":
      return [said(`move ${r(st.from)}${to}${r(st.to)}  (agents${to}${r(st.overlay)})`), ...why];
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime":
      return [said(`remove ${r(st.path)}`), ...why];
    default:
      return [];
  }
}

export const displayName = (id) => loadHarness(id)?.display_name || id;
// The harnesses a plan names, by their display names — for the badge.
function displayNames(p) {
  return p.harnesses.map(displayName).join(", ") || "(no harness)";
}

const tilde = (path, home = homedir()) =>
  path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;

// The badge (presentation spec contract 7): `projectstore <verb> · <display
// names>`, the first line of a verb's output. A run that fetches prints it
// before the fetch line, and its preview then leaves it out (`badge: false`),
// so it is printed once.
export function badgeLine(p, { verb = null, caps: c = PLAIN } = {}) {
  return badgeText(c, `projectstore ${verb || p.mode}`, [displayNames(p)]);
}

// The update notice in the badge's slot (the converge story's rule 8;
// presentation spec contracts 6 and 7): the note glyph, the text in the
// explanation role, then the command alone on its line after a blank one, in
// the action role, and a blank line before the preview.
export function noticeText(n, c = PLAIN) {
  const paint = painter(c);
  return (
    [
      `  ${paint("attention", termIcon(c, "note"))} ${paint("explanation", n.text)}`,
      ...commandBlock(c, [n.command], { indent: 4 }),
      "",
    ].join("\n") + "\n"
  );
}

// The summary line: the counts by kind of change, each in its word's role.
// Unsupported rows are not counted: they are the harness's, not the run's.
const COUNTED = [
  ["add", (n) => `${n} to add`],
  ["register", (n) => `${n} to register`],
  ["update", (n) => `${n} to update`],
  ["switch", (n) => `${n} to switch`],
  ["remove", (n) => `${n} to remove`],
  ["unchanged", (n) => `${n} unchanged`],
  ["skipped", (n) => `${n} skipped`],
];
function planSummary(p, c) {
  if (!p.ok) return heading(c, "Plan", [["refused", "attention"]]);
  const n = {};
  for (const i of p.items) if (!isUnsupported(i)) n[actionWord(i)] = (n[actionWord(i)] || 0) + 1;
  const counts = COUNTED.filter(([w]) => n[w]).map(([w, say]) => [say(n[w]), WORD_ROLE[w]]);
  return heading(c, "Plan", counts.length ? counts : [["nothing to change", "explanation"]]);
}

// `home` shortens the project path to ~ (the caller's home; a test's fixed
// one); everything else the screen needs is in `p`. `header` is a caller's
// lines beneath the project path — setup's, naming the git work tree's top
// when it runs in a subfolder (the setup story, rule 4).
export function renderPreview(
  p,
  { verbose = false, verb = null, caps: c = PLAIN, badge = true, home = homedir(), header = [] } = {},
) {
  const paint = painter(c);
  const glyph = (name) => termIcon(c, name);
  const width = c.live ? c.width : 0;
  const writes = p.items.filter(isWrite);
  // A text's lines, each of its own lines wrapped on its own, returned without
  // the indent for the caller to lay out. wrap indents only the lines it
  // breaks, so a line the text carried itself must never lose the indent's
  // width of characters (a refusal's "--harness claude-code" read "laude-code").
  const textLines = (text, indent) =>
    String(text)
      .split("\n")
      .flatMap((para) =>
        wrap(para, width, indent)
          .split("\n")
          .map((l, k) => (k ? l.slice(indent.length) : l)),
      );
  // Prose, wrapped to the terminal with every line indented; a path or a
  // command inside it is one word and never broken (term.mjs wrap).
  const prose = (indent, text, role = "explanation") => textLines(text, indent).map((l) => indent + paint(role, l));
  const lines = [
    ...(badge ? [badgeLine(p, { verb, caps: c })] : []),
    `  ${paint("explanation", tilde(p.projectDir, home))}`,
    ...(header || []).flatMap((h) => prose("  ", h)),
    "",
  ];
  if (verbose) {
    for (const [h, r] of Object.entries(p.plannedAgainst || {}))
      lines.push(
        ...prose(
          "  ",
          `${h}: the surfaces below are planned against the host's install path ${r}, not this package at ${p.root}.`,
        ),
        "",
      );
    for (const r of p.reports) lines.push(...r.split("\n").flatMap((l) => (l.trim() ? prose("  ", l) : [""])), "");
  }
  lines.push(planSummary(p, c));
  // An emptied state directory is pruned with the launcher removed from it;
  // said once, beneath the first such row.
  let pruneSaid = false;
  const beneath = (i) => {
    const out = [];
    // A user-scope registration reaches past this project: contract 7's
    // consequence line, on the line beneath its row, before anything else.
    if (isWrite(i) && i.kind === "registration" && i.scope === "user")
      out.push(
        ...prose(
          "      ",
          `user-wide: the plugin is ${i.action === "remove" ? "removed" : "registered"} for every project ${displayName(i.harness)} opens, not only this one`,
        ),
      );
    // …and a channel switch's (the converge story's rule 2), carried as its
    // note step: first, before the reason and the consent lines.
    for (const st of (i.steps || []).filter(isConsequence)) out.push(...prose("      ", st.why));
    if (verbose) out.push(...prose("      ", transitionText(i, glyph)));
    else if (i.reason && !isUnsupported(i))
      out.push(
        ...prose("      ", i.advice ? i.advice.text : i.reason, i.action === "refuse" ? "attention" : "explanation"),
      );
    // The reason's ways out (the converge story): each lead, then its command
    // alone on its line after a blank one (contract 6), and a blank line after.
    if (i.advice?.blocks?.length) {
      for (const b of i.advice.blocks)
        out.push(...prose("      ", b.lead), ...commandBlock(c, [b.command], { indent: 10 }), "");
    }
    // A shell this run fetched from a registry that is not the user's (the
    // converge story's rule 8, as amended 2026-10-09): both named. Neutral
    // words: the fetch's URL can come from the project's .npmrc or from the
    // run's own environment (`npx --registry`), and either reads the same.
    const from = fetchedFor(p, i);
    if (from)
      out.push(
        ...prose("      ", `fetched from ${from.registry}`),
        ...prose("      ", `your npm's own registry is ${from.user}`),
      );
    for (const st of (i.steps || []).filter((x) => !isConsequence(x)))
      out.push(...stepLines(p, st, { verbose, paint, width, glyph, home }));
    if (i.kind === "registration" && i.home && i.surface && !i.surface.endsWith("_others"))
      out.push(`      ${paint("explanation", `(harness home ${i.home}${i.scope ? `, scope ${i.scope}` : ""})`)}`);
    if (i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim())
      out.push(`      ${paint("explanation", "(the file would hold nothing else and is removed)")}`);
    if (!pruneSaid && i.action === "remove" && i.kind === "exclusive") {
      pruneSaid = true;
      out.push(`      ${paint("explanation", `(an emptied ${rel(p.projectDir, dirname(i.path))}/ is pruned)`)}`);
    }
    return out;
  };
  // The run's one agents block, named again where each other harness's row
  // would have been (contract 7; the story "One run plans the agents block
  // once…", rule 1): in that harness's group, before its first item at or
  // after the recorded index, else at the group's end. Not a step and not an
  // item: nothing is planned there.
  const sameBlock = () =>
    `  ${paint("explanation", glyph("skip"))} ${p.sharedBlock.file} ${glyph("dash")} the same block as ${p.sharedBlock.display}, above`;
  const hostLines = (h) => {
    const from = h.entry ? `from the registration ${h.entry}` : "from the host's own plugin system";
    return wrap(`${h.display} installs ${h.rows.join(", ")} itself, ${from}`, width, "    ")
      .split("\n")
      .map((l, k) =>
        k
          ? `    ${paint("explanation", l.slice(4))}`
          : `  ${paint("explanation", glyph("skip"))} ${paint("explanation", l)}`,
      );
  };
  // The VAULT group first, when setup plans one: the rows of no harness.
  const ids = [
    ...(p.items.some((i) => i.harness === null) ? [null] : []),
    ...p.harnesses,
    ...new Set(p.items.map((i) => i.harness).filter((h) => h !== null && !p.harnesses.includes(h))),
  ];
  for (const id of ids) {
    const entries = p.items.map((i, at) => ({ i, at })).filter((e) => e.i.harness === id);
    const others = (p.sharedBlock?.others || []).filter((o) => o.harness === id).sort((a, b) => a.at - b.at);
    const host = (p.hostManaged || []).filter((h) => h.harness === id);
    if (!entries.length && !others.length && !host.length) continue;
    const folded = verbose ? [] : entries.filter((e) => isUnsupported(e.i));
    // A registration this run fetched from another registry keeps its row, so
    // the registry lines beneath it show on every run, not only on a change.
    const quiet = verbose ? [] : entries.filter((e) => isQuiet(e.i) && !fetchedFor(p, e.i));
    const shown = entries.filter((e) => !folded.includes(e) && !quiet.includes(e));
    const specs = shown.map(({ i }) => ({
      glyph: glyphName(i),
      role: WORD_ROLE[actionWord(i)],
      action: actionWord(i),
      target: rowTarget(p, i, home),
      note: rowNote(i, { verbose, glyph }),
    }));
    if (quiet.length)
      specs.push({
        glyph: "unchanged",
        role: "explanation",
        action: "unchanged",
        target: paint("explanation", quiet.map((e) => surfaceWords(e.i.surface)).join(", ")),
      });
    // Unsupported rows keep one line per harness (contract 18), named in
    // words as the unchanged line names its rows; --verbose lists each with
    // the manifest's reason.
    if (folded.length)
      specs.push({
        glyph: "unchanged",
        role: "explanation",
        action: "skipped",
        target: paint(
          "explanation",
          `not on ${displayName(id)}: ${folded.map((e) => surfaceWords(e.i.surface)).join(", ")}`,
        ),
        note: "--verbose says why",
      });
    const drawn = rowLines(c, specs);
    lines.push("", paint("emphasis", id === null ? VAULT_GROUP : displayName(id)));
    const pending = [...others];
    shown.forEach(({ i, at }, k) => {
      while (pending.length && pending[0].at <= at) {
        pending.shift();
        lines.push(sameBlock());
      }
      lines.push(...drawn[k], ...beneath(i));
    });
    for (const _ of pending) lines.push(sameBlock());
    for (const extra of drawn.slice(shown.length)) lines.push(...extra);
    for (const h of host) lines.push(...hostLines(h));
  }
  if (p.refusals.length) lines.push("");
  // A plan-level refusal: its message in the attention role, as an item's
  // refusal reason is (presentation spec contract 3 as amended 2026-10-11).
  p.refusals.forEach((r, k) => {
    const lead = `  ${paint("attention", glyph("refuse"))} ${paint("attention", "refused")}  `;
    const pad = " ".repeat(plain(lead).length);
    // The stop (the converge story's rule 6) carries its commands apart from
    // its words: each is printed alone on its line after a blank one, with
    // nothing after it (contract 6), the way a person copies it.
    const stop = k === 0 && p.stop ? p.stop : null;
    // The same for a refusal that names its ways out (the channel "git" with
    // nothing to keep): its prose, then each lead and its command alone.
    const advice = k === 0 && !stop && p.refusalAdvice ? p.refusalAdvice : null;
    const [first, ...rest] = textLines(stop ? stop.lead : advice ? advice.text : r, pad);
    lines.push(lead + paint("attention", first), ...rest.map((l) => pad + paint("attention", l)));
    if (stop)
      lines.push(
        ...commandBlock(c, [stop.commands[0]], { indent: 4 }),
        "",
        ...prose("  ", stop.between),
        ...commandBlock(c, stop.commands.slice(1), { indent: 4 }),
      );
    if (advice)
      for (const b of advice.blocks)
        lines.push("", ...prose("  ", b.lead), ...commandBlock(c, [b.command], { indent: 4 }));
  });
  // The closing lines, in a person's words: only what is listed is written,
  // and a $ line is the host's own CLI at work.
  const closing = [];
  if (p.ok && writes.length)
    closing.push(
      ...prose(
        "  ",
        `Only the entries listed above are written ${glyph("dash")} nothing else in those files is read, rewritten or removed.`,
      ),
    );
  if (p.items.some((i) => (i.steps || []).some((s) => s.kind === "host" && s.name !== "keep")))
    closing.push(
      ...prose("  ", "Each $ line runs the host's own CLI, which writes the host-owned files named after it."),
    );
  if (p.items.some((i) => isWrite(i) && (i.steps || []).some((s) => s.kind === "host" && s.name === "keep")))
    closing.push(
      ...prose(
        "  ",
        "The kept copy's $ line runs that copy's own projectstore, which writes the files named after it.",
      ),
    );
  if (closing.length) lines.push("", ...closing);
  if (!p.ok) lines.push("", `  ${paint("attention", "Nothing will be written: resolve the refusals above first.")}`);
  // A plan that wrote nothing because part of it could not be planned never
  // reads as converged (the converge story's keep, a copy with work pending).
  else if (!writes.length)
    lines.push(
      "",
      p.incomplete
        ? "  Nothing will be written: one surface could not be planned (see above)."
        : "  Nothing to change.",
    );
  else if (p.incomplete) lines.push("", "  One surface could not be planned (see above); the rest proceeds.");
  return lines.join("\n") + "\n";
}

// APPLY, one line per step as it finishes (presentation spec contract 8):
// the glyph, what was done in the past tense — "added CLAUDE.md", having read
// "adding CLAUDE.md" while it ran on a terminal — and the duration. An item
// with steps — a registration, the layout move — prints its own line as it
// starts ("registering …"), one line per step beneath it — each host
// command, staging write, write and move — and, once all of them have run,
// its finished line in the past tense ("registered …") with the item's whole
// time, so a transcript never ends on a line that reads as still running.
// No heading: the plan's last line and the question are above it. `now` is
// the test's clock; `home` shortens paths to ~.
export function applyReporter(out, c, p, { now = Date.now, home = homedir() } = {}) {
  const paint = painter(c);
  const glyph = (name) => termIcon(c, name);
  const item = stepReporter(out, c, { indent: 2, now });
  const step = stepReporter(out, c, { indent: 6, now });
  const said = (i) => {
    const word = actionWord(i);
    const [running, done] = WORD_TENSES[word] || [word, word];
    const target = rowTarget(p, i, home);
    return { word, running: `${running} ${target}`, done: `${done} ${target}` };
  };
  // The mark too: a skip prints its reason (the project not bound, the switch
  // not done) beneath the line it started.
  // …and the keep, whose $ line and the kept copy's own items print beneath it.
  // …and setup's vault, whose binding, git and scaffold steps print beneath it.
  const stepped = (i) =>
    i.kind === "registration" ||
    i.kind === "layout" ||
    i.kind === "binding" ||
    i.kind === "channel" ||
    i.kind === "vault";
  const began = new Map();
  return {
    onItem(i, phase, r) {
      const s = said(i);
      if (stepped(i)) {
        if (phase === "start") {
          began.set(i, now());
          out.write(`  ${paint(WORD_ROLE[s.word], glyph(glyphName(i)))} ${s.running}\n`);
          return;
        }
        const t0 = began.get(i) ?? now();
        began.delete(i);
        if (phase === "abort") step.abort();
        else if (r && (r.action === "skipped" || r.action === "skip"))
          out.write(
            `      ${paint("explanation", glyph("skip"))} ${paint("explanation", `${r.action === "skip" ? "nothing to do" : "skipped"}: ${r.reason || "an earlier item failed"}`)}\n`,
          );
        else if (r && r.failed) out.write(`      ${paint("error", glyph("fail"))} ${paint("error", "stopped")}\n`);
        else item.finish(s.done, t0);
        return;
      }
      if (phase === "start") item.start(s.running);
      else if (phase === "abort") item.abort();
      else {
        // An item that failed or was skipped keeps the words it ran under.
        const failed = Boolean(r && (r.failed || r.action === "skipped"));
        item.end(!failed, r && r.action === "skipped" ? "skipped" : "", failed ? {} : { label: s.done });
      }
    },
    onStep(st, phase, r) {
      const l = stepLabel(p, st, { home, glyph });
      if (!l) return;
      if (phase === "start") {
        step.start(l.running);
        return;
      }
      const ok = r ? r.ok : true;
      const kept = Boolean(r && r.kept);
      // A step that failed without stopping the run (setup's git init) is ▲,
      // in its own words.
      if (r && r.warn) {
        step.end(true, "", { warn: true, label: r.warn });
        return;
      }
      // A step that left its target in place did not do its verb; one that
      // says why in its own words (a git init skipped) needs no note.
      const own = r && r.label ? r.label : null;
      step.end(ok, kept && !own ? "kept" : "", ok ? { kept, label: own || (kept ? l.base : l.done) } : {});
    },
    // The wrapped spawn prints each host command as a step. Its `unwrapped`
    // is the caller's own spawn, for an item that reports its commands as its
    // own steps (setup's vault: `$ git init --quiet`).
    spawn(inner) {
      const wrapped = (bin, argv, o) => {
        step.start(`$ ${basename(String(bin))} ${argv.join(" ")}`);
        let r;
        try {
          r = inner(bin, argv, o);
        } catch (e) {
          step.abort();
          throw e;
        }
        step.end(!r.error && r.status === 0);
        return r;
      };
      Object.defineProperty(wrapped, "unwrapped", { value: inner });
      return wrapped;
    },
  };
}

// A step as its APPLY line names it: the verb and the target, short — the
// full form, file counts and entry pointers, was in PLAN. `base` is the plain
// verb, for a step that left its target in place.
const STEP_TENSES = {
  stage: ["staging", "staged"],
  lift: ["lifting", "lifted"],
  write: ["writing", "wrote"],
  edit: ["editing", "edited"],
  ensure: ["ensuring", "ensured"],
  move: ["moving", "moved"],
  merge: ["merging", "merged"],
  remove: ["removing", "removed"],
  create: ["creating", "created"],
};
function stepLabel(p, st, { home = homedir(), glyph = unicodeGlyph } = {}) {
  const r = (x) => tilde(rel(p.projectDir, x), home);
  const to = ` ${glyph("transition")} `;
  const said = (verb, rest) => ({
    base: `${verb} ${rest}`,
    running: `${STEP_TENSES[verb][0]} ${rest}`,
    done: `${STEP_TENSES[verb][1]} ${rest}`,
  });
  switch (st.kind) {
    case "portable-write":
      return said("stage", r(st.path));
    case "recover":
      return said(
        "lift",
        `${r(st.path)} ${glyph("dash")} the previous state proved${st.lifted ? `; it held: ${String(st.lifted).split("\n")[0]}` : ""}`,
      );
    case "write":
      return said("write", r(st.path));
    case "unregister":
      return said("edit", `${r(st.path)} [${st.pointer}.${st.name}]`);
    case "mark":
    case "unmark":
    case "set":
      return said("edit", `${r(st.path)} [${st.key}]`);
    case "ensure":
      return said("ensure", `${r(st.path)}/`);
    // Setup's vault (rule 10): the directory, the binding, git, the scaffold
    // — a scaffold step's paths are the vault's, beneath the vault's line.
    case "mkdir":
      return said("create", `${r(st.path)}/`);
    case "bind":
      return said("write", r(st.path));
    case "git-init": {
      const line = `$ ${st.argv.join(" ")}`;
      return { base: line, running: line, done: line };
    }
    case "scaffold":
      return said("create", st.rels.join(" and "));
    case "move-state":
      return said("move", `${r(st.from)}/${to}${r(st.to)}/`);
    case "merge-log":
      return said("merge", `${r(st.from)}${to}${r(st.to)}`);
    case "move-marker":
    case "move-binding":
      return said("move", `${r(st.from)}${to}${r(st.to)}`);
    case "delete":
    case "portable-remove":
    case "remove":
    case "remove-legacy-launcher":
    case "rmdir-legacy":
    case "remove-legacy-runtime":
      return said("remove", r(st.path));
    case "rmdir-state":
      return said("remove", `${r(st.path)}/`);
    // An item the kept copy applied (the converge story's rule 5), in this
    // run's words for its action; one the preview did not list says so.
    case "kept": {
      const word = ACTION_WORD[st.action] || "update";
      const [running, done] = WORD_TENSES[word] || [word, word];
      const target = `${st.path ? r(st.path) : st.surface}${st.unplanned ? " (not in the preview)" : ""}`;
      return { base: `${word} ${target}`, running: `${running} ${target}`, done: `${done} ${target}` };
    }
    default:
      return null;
  }
}

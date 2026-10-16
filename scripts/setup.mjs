// projectstore — setup.mjs: the `setup` verb, the one documented way in (the
// story "projectstore setup asks, shows one plan and installs every harness it
// finds, with the vault", PS-HARNESS; the front-door ADR's decisions 1, 2, 6
// and 7).
//
// It composes; it re-implements nothing. In rule 3's order:
//   1. contract 19's refusal of a project that does not exist;
//   2. the git top (binding.mjs gitTop) and whether the current folder is its
//      own project (rule 4's names, from the manifests and LAYOUT);
//   3. question 1, the project — or --project, or the current folder;
//   4. the facts, read for the answered project: detection with the state
//      directories, each host's presence, the binding, the copies of ours
//      from another marketplace and the versions they run, the folder beside
//      the project, a worktree's main checkout, the status-line slot;
//   5. one pure decide* per question, answered on the question rail
//      (term.mjs openRail) at a terminal, or by the flags without one — and
//      the refusals of those flags;
//   6. the vault plan: binding.mjs planBind with `init`, or planInherit for a
//      worktree — pure, its refusals stop the run here;
//   7. runVerb("setup", …), the installer's own run: the registry read, the
//      stop, the keep's read, the fetch, plan(), PLAN, the one question,
//      apply() and DONE — with setup's DONE lines, built here.
//
// The rail closes (`└`) before any network work, in a `finally`, and what was
// typed ahead is drained before the line-mode question that follows it.
// Nothing is written before that question: before it this reads files, spawns
// `git rev-parse` (and, in a linked worktree, worktree.mjs's own git reads),
// and may read a kept copy's own plan, read the registry and fetch a shell
// into the user-level scratch — exactly what install does.
//
// Loaded lazily by cli.mjs, as the install family is, so the MCP server's
// module graph gains nothing. Every home, environment, spawn and stream is a
// parameter. No harness id is spelled here: harnesses are found by their
// manifests' surfaces, and every command a harness runs comes from
// invocation(). Pure node, no external deps.

import { existsSync, statSync, readdirSync, accessSync, realpathSync, constants } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadHarness,
  loadHarnesses,
  harnessIds,
  detectHarnesses,
  hostPresence,
  agentsBlockRow,
  insideHostSession,
  registrationDeferred,
  invocation,
  projectRootDeclared,
  harnessNameLines,
  LAYOUT,
} from "./harness.mjs";
import { readConfigAt, projectDirRefusal, selectCopy, channelKeep, cmpPrecedence } from "./lib.mjs";
import {
  planBind,
  planInherit,
  normaliseVaultPath,
  gitTop,
  shellQuote,
  bindResult,
  layoutNames,
  languageNames,
} from "./binding.mjs";
import { analyseRegistration, analyseJsonEntry } from "./surfaces.mjs";
import {
  runningCopies,
  coreCommand,
  channelChoices,
  pinFor,
  terminalRun,
  directoryConsequence,
  directoryKeepConsequence,
  DIRECTORY,
} from "./convergence.mjs";
import { runVerb, isInteractive, gateText, channelText, publicItem, planOptions } from "./install-harness.mjs";
import { resolveBinding } from "./worktree.mjs";
import * as term from "./term.mjs";

// The questions' titles (rules 4–9), each the answered line's too.
export const TITLES = Object.freeze({
  project: "Which folder is the project?",
  harnesses: "Install projectstore for",
  channel: "Channel",
  vault: "Where should this project's notes live?",
  path: "Which folder holds the vault?",
  statusline: (display) => `Show projectstore in ${display}'s status line?`,
});
// The channel question's text, the ADR's (rule 6), as the note under its title.
export const CHANNEL_TEXT =
  "This project loads projectstore from the git marketplace (updated by /plugin). Switch this project to the npm install, or keep the git marketplace?";
export const CHANNEL_ANSWERS = Object.freeze({ npm: "Switch to npm", git: "Keep the git marketplace" });
// …and for a copy synced from claude.ai (PS-DIRECTORY, "Setup and install keep
// a directory copy…", decision 6), the question's words when that copy is the
// one this project loads: the same two answers, `git` still meaning the keep.
export const DIRECTORY_TEXT = `This project loads projectstore from ${DIRECTORY} (updated from claude.ai). Keep the directory copy, or move this project to the npm install?`;
export const DIRECTORY_ANSWERS = Object.freeze({ npm: "Move to npm", git: "Keep the directory copy" });
export const channelWords = (directory) =>
  directory ? { text: DIRECTORY_TEXT, answers: DIRECTORY_ANSWERS } : { text: CHANNEL_TEXT, answers: CHANNEL_ANSWERS };
const UNRECORDED = "nothing is recorded: this project has no binding; setup asks again once it is bound";

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const tilde = (p, home) =>
  home && (p === home || String(p).startsWith(home + "/")) ? "~" + String(p).slice(home.length) : String(p);
const writableDir = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const surfaceOf = (m, test) =>
  Object.entries(m?.surfaces || {}).find(([k, s]) => !k.startsWith("_") && s && test(s)) || null;
const registrationOf = (m) => surfaceOf(m, (s) => s.kind === "registration");
// The harness whose project can switch channels: the one with a host plugin
// registration (cli.mjs's switchHarness reads it the same way).
const hostRegistrationOf = (m) => surfaceOf(m, (s) => s.format === "host-plugin-registration");
// The harness with a status-line slot of ours (install-harness.mjs's flagHarness).
const statuslineOf = (m) => {
  const s = m?.surfaces?.statusline;
  return s && s.supported !== false && s.format === "json-entry" ? s : null;
};

// ─── Rule 4: which folder is the project ───────────────────────────────

// The names that make a folder its own project (rule 4): every manifest's
// agents-block files and harness directory, and our own directory — derived,
// never a literal list.
export function ownProjectNames(manifests = [...loadHarnesses().values()]) {
  const names = new Set();
  for (const m of manifests) {
    for (const f of agentsBlockRow(m)?.[1].files || []) names.add(f);
    if (m.runtime?.harness_dir) names.add(m.runtime.harness_dir);
  }
  names.add(LAYOUT.root);
  return [...names];
}

// Question 1 (rule 4). Not asked with a project given, outside a work tree or
// at its top; asked in a subfolder of one, at a terminal, its default the top
// — unless the folder holds one of the names above, then itself.
export function decideProject({ cwd, top, given = false, own = false, home = null }) {
  if (given || !top || real(cwd) === real(top)) return { asked: false, project: cwd, top: given ? null : top };
  const choices = [
    { value: top, label: tilde(top, home), reason: "the top of this git work tree" },
    { value: cwd, label: tilde(cwd, home), reason: "the current folder" },
  ];
  if (own) choices.reverse();
  return { asked: true, project: cwd, top, choices, default: choices[0].value };
}

// ─── Rule 5: the checklist ──────────────────────────────────────────────

// Who is listed (rule 5): a harness whose registration is not conditioned on
// a distribution root (the core is its plugin root), or whose manifest names
// its published shell.
export function listedHarnesses(manifests = [...loadHarnesses().values()]) {
  return manifests.filter((m) => {
    const r = registrationOf(m);
    return !r || r[1].condition !== "distribution_root" || Boolean(m.install?.shell);
  });
}

// Each listed harness's row (rule 5's table, top to bottom): pre-ticked when
// used in this project — by its directory or our state directory — or, when
// none is, when its host's CLI is on PATH and its home exists.
export function harnessRows({ listed, detected, presence, home = null }) {
  const used = new Map(detected.map((d) => [d.id, d]));
  const anyUsed = listed.some((m) => used.has(m.id));
  return listed.map((m) => {
    const d = used.get(m.id);
    const p = presence.get(m.id) || {};
    const at = p.homeDir ? tilde(p.homeDir, home) : null;
    const row = (ticked, why) => ({
      id: m.id,
      display: m.display_name,
      ticked,
      why,
      cli: p.cli || null,
      bin: p.bin || null,
    });
    if (d) return row(true, `used in this project (${d.evidence}/)`);
    if (p.cli && anyUsed) return row(false, `not used in this project yet; ${p.bin} is on PATH`);
    if (p.cli && p.home) return row(true, `${p.bin} is on PATH`);
    if (p.cli) return row(false, `${p.bin} is on PATH but has not run on this machine yet (no ${at})`);
    if (p.home && p.bin)
      return row(false, `${at} exists, but ${p.bin} is not on PATH — install ${m.display_name} first`);
    return row(false, "not found on this machine");
  });
}

// ─── Rule 6: the channel ────────────────────────────────────────────────

// The value plan() receives, or the question, or the refusal (rule 6's
// table). `selected`: the copy contract 12's selection keeps, from another
// marketplace, with the version it runs; `kept`: the binding's channel_keep;
// `sessionCopy`: the copy the selection finds at all, for "inside a session
// running the git-marketplace copy". `directory`: the copy synced from
// claude.ai this project loads (analyseRegistration's), asked about as a git
// copy is, with the keep the default and each answer's consequence
// (PS-DIRECTORY); `display` the host's name those consequences say.
export function decideChannel({
  inSet,
  others = [],
  directory = null,
  display = null,
  flag = null,
  interactive = false,
  running = null,
  selected = null,
  kept = null,
  inSession = false,
  sessionCopy = null,
}) {
  if (flag) return { asked: false, value: flag, why: "flag" };
  if (!inSet || (!others.length && !directory)) return { asked: false, value: null, why: "none" };
  if (interactive) {
    const newer = Boolean(selected?.version && running && cmpPrecedence(selected.version, running) > 0);
    if (!others.length) {
      const stop = newer
        ? `it runs ${running} in place of ${selected.version}; if ${selected.version} is published, setup stops after these questions and names it`
        : "setup and upgrade update the npm copy from now on";
      return {
        asked: true,
        default: "git",
        newer,
        choices: [
          {
            value: "git",
            label: DIRECTORY_ANSWERS.git,
            reason: kept ? `kept on ${String(kept.at).slice(0, 10)}` : directoryKeepConsequence(display, directory.key),
          },
          { value: "npm", label: DIRECTORY_ANSWERS.npm, reason: `${directoryConsequence(display)}; ${stop}` },
        ],
      };
    }
    const keepReason = kept
      ? `kept on ${String(kept.at).slice(0, 10)}`
      : "/plugin keeps updating it; setup refreshes this project's files through that copy";
    const switchReason = newer
      ? `switching runs ${running} in place of ${selected.version}; if ${selected.version} is published, setup stops after these questions and names it`
      : "setup and upgrade update it from now on; /plugin update no longer reaches this project";
    return {
      asked: true,
      default: newer || kept ? "git" : "npm",
      newer,
      choices: [
        { value: "npm", label: CHANNEL_ANSWERS.npm, reason: switchReason },
        { value: "git", label: CHANNEL_ANSWERS.git, reason: keepReason },
      ],
    };
  }
  if (inSession && ["marketplace", "synced"].includes(sessionCopy?.channel))
    return { asked: false, value: "git", why: "session" };
  if (kept) return { asked: false, value: "git", why: "recorded" };
  return { asked: false, value: null, refuse: true };
}

// ─── Rule 7: the vault ──────────────────────────────────────────────────

// The folder beside the project, `<name>-vault`: missing, empty, full or a
// file, and whether it — or its parent, when it is missing — can be written.
export function siblingOf(project) {
  const path = join(dirname(project), `${basename(project)}-vault`);
  let state = "missing";
  try {
    const st = statSync(path);
    state = !st.isDirectory() ? "file" : readdirSync(path).length ? "full" : "empty";
  } catch {}
  return {
    path,
    state,
    writable: state === "missing" ? writableDir(dirname(path)) : state === "empty" ? writableDir(path) : null,
  };
}

// The vault question's choices (rule 7's table, read top to bottom): the
// first from the worktree's main checkout, else from the folder beside the
// project; then "Another folder…" (unless it is the first) and "Not now".
export function vaultChoices({ sibling, worktree = null, layout, home = null }) {
  const other = {
    value: "other",
    label: "Another folder…",
    reason: "a missing or empty one is created; one with files is bound",
  };
  const first = worktree
    ? {
        value: "inherit",
        label: `Use ${tilde(worktree.vault, home)}`,
        reason: `the vault of ${tilde(worktree.main, home)}, with its settings`,
      }
    : ["missing", "empty"].includes(sibling.state) && sibling.writable
      ? {
          value: "create",
          label: `Create ${tilde(sibling.path, home)}`,
          reason: `a new vault beside the project: its own git repository, with the ${layout} folders`,
        }
      : sibling.state === "full"
        ? { value: "use", label: `Use ${tilde(sibling.path, home)}`, reason: "it already exists; it is bound as it is" }
        : {
            ...other,
            reason:
              sibling.state === "file"
                ? `${tilde(sibling.path, home)} is a file`
                : `${tilde(dirname(sibling.path), home)} is not writable`,
          };
  return [
    first,
    ...(first.value === "other" ? [] : [other]),
    { value: "none", label: "Not now", reason: "installed unbound" },
  ];
}

// Why a typed vault path is refused, inline (rule 7), or null: a ~user path,
// a file, a missing folder whose parent is not a writable folder. Relative to
// the project, `~` expanded, as bind and init read it.
export function vaultPathRefusal(typed, project, home) {
  const n = normaliseVaultPath(typed, project, home);
  if (!n) return "type a path";
  if (typeof n !== "string") return n.error;
  try {
    if (!statSync(n).isDirectory()) return `${tilde(n, home)} is a file, not a folder`;
    return null;
  } catch {}
  return writableDir(dirname(n)) ? null : `${tilde(dirname(n), home)} is not a writable folder`;
}

// ─── Rule 9: the status line ────────────────────────────────────────────

// Asked when the harness with a status-line slot is in the set, the run
// leaves a binding that does not say yet, the slot is not someone else's and
// the channel is not the keep — under which DONE names the copy's own command.
export function decideStatusline({ inSet, leaves, stored, slot, channel }) {
  if (!inSet || !leaves || typeof stored === "boolean" || slot === "theirs") return { asked: false };
  if (channel === "git") return { asked: false, underKeep: true };
  return { asked: true };
}

// ─── The run ───────────────────────────────────────────────────────────

// What the run knows of the project it answered for (rule 3, step 4).
function factsOf(project, { env, home, root, version, interactive }) {
  const manifests = [...loadHarnesses().values()];
  const listed = listedHarnesses(manifests);
  const detected = detectHarnesses(project, { state: true });
  const presence = new Map(manifests.map((m) => [m.id, hostPresence(m, { env, home })]));
  const binding = readConfigAt(project);
  const channelHarness = manifests.find((m) => hostRegistrationOf(m)) || null;
  let others = [],
    directory = null,
    selected = null,
    sessionCopy = null;
  if (channelHarness) {
    const [, s] = hostRegistrationOf(channelHarness);
    ({ others, directory } = analyseRegistration(project, s, { root, home, harness: channelHarness, env }));
    const pick = selectCopy(home, project, { harness: channelHarness, only: ["marketplace", "synced"] });
    // The version it runs, as the convergence story reads it (runningCopies,
    // under no channel answer: local and read-only).
    const copies = runningCopies(project, { harnesses: [channelHarness.id], root, home, env, channel: null, version });
    selected = pick ? { ...pick, version: copies.find((c) => c.key === pick.key)?.version ?? pick.version } : null;
    sessionCopy = selectCopy(home, project, { harness: channelHarness });
  }
  const slotHarness = manifests.find((m) => statuslineOf(m)) || null;
  const slot = slotHarness
    ? analyseJsonEntry(project, statuslineOf(slotHarness), { root, home, harness: slotHarness }).state
    : null;
  // A worktree's main checkout (worktree.mjs): only where it can be offered —
  // at a terminal, unbound, in a linked worktree. Read for the project
  // answered, never from the git top, which --project leaves unread.
  let worktree = null;
  if (interactive && !binding && inLinkedWorktree(project)) {
    const w = resolveBinding(project);
    if (w.state === "inheritable" && w.mainCheckout) {
      const n = normaliseVaultPath(w.vaultPath, w.mainCheckout, home);
      if (typeof n === "string") worktree = { main: w.mainCheckout, vault: n };
    }
  }
  return {
    manifests,
    listed,
    detected,
    presence,
    binding,
    channelHarness,
    others,
    directory,
    selected,
    sessionCopy,
    slotHarness,
    slot,
    sibling: siblingOf(project),
    worktree,
  };
}

// Whether `dir` may sit in a linked git worktree, from the files alone: the
// nearest `.git` at or above it is a file (a gitdir pointer), not a folder.
// Only then does worktree.mjs spend its git reads to confirm it and find the
// main checkout, so an unbound run anywhere else spawns nothing more.
function inLinkedWorktree(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    try {
      return statSync(join(at, ".git")).isFile();
    } catch {}
    if (dirname(at) === at) return false;
  }
}

// The arguments a bare run's refusal repeats after one --harness: what named
// its vault, channel, layout and language — the channel only for the harness
// whose channel it is (`channel`), as setup refuses it in a run without that
// harness. Never --project (the ADR's decision 5).
function repeatArgs(values, vaultPath, { channel = false } = {}) {
  return [
    vaultPath ? `--vault ${shellQuote(vaultPath)}` : "",
    channel && values.channel ? `--channel ${values.channel}` : "",
    values.layout ? `--layout ${values.layout}` : "",
    values.language ? `--language ${values.language}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Questions 1 to 6 (rule 3, steps 3 to 5): on the rail when one is open,
// else from the flags and the rules for a run without a terminal. Writes
// nothing. Returns the decisions, or { cancelled } at a Ctrl+C or the end of
// input, or { early } — a refusal or a usage error — before any plan.
async function questions(rail, s) {
  const {
    start,
    top,
    given,
    own,
    values,
    named,
    flagChannel,
    layout,
    env,
    home,
    root,
    version,
    c,
    refused,
    usage,
    summary,
  } = s;
  const glyphs = (t) => term.glyphText(c, t);
  const cancelled = (a) => a === term.CANCELLED;
  const CANCEL = { cancelled: true };

  // Question 1, the project (rule 4).
  const q1 = decideProject({ cwd: start, top, given, own, home });
  let project = q1.project;
  if (rail && q1.asked) {
    const a = await rail.select(
      TITLES.project,
      q1.choices.map((x) => ({ ...x, reason: glyphs(x.reason) })),
      { default: q1.default },
    );
    if (cancelled(a)) return CANCEL;
    project = a;
  } else if (rail) rail.answered(TITLES.project, tilde(project, home));
  summary.project = project;
  // Without a terminal, in a subfolder of a work tree: PLAN's header names the top.
  const header =
    !rail && q1.asked
      ? [glyphs(`inside the git work tree ${tilde(top, home)} — this run sets up this folder only`)]
      : [];

  // The facts, for the project answered (rule 3, step 4).
  const runEnv = s.ownEnv ? s.ownEnv(project) : env;
  const f = factsOf(project, { env: runEnv, home, root, version, interactive: Boolean(rail) });
  const rows = harnessRows({ listed: f.listed, detected: f.detected, presence: f.presence, home });
  summary.harnesses = rows.map(({ id, ticked, why }) => ({ id, ticked, why }));

  // Question 2, the harnesses (rule 5), or --harness.
  let set;
  if (named.length) {
    set = named;
    if (rail) rail.answered(TITLES.harnesses, set.map((id) => loadHarness(id).display_name).join(", "));
  } else if (rail) {
    const a = await rail.multi(
      TITLES.harnesses,
      rows.map((r) => ({ value: r.id, label: r.display, reason: glyphs(r.why), on: r.ticked })),
    );
    if (cancelled(a)) return CANCEL;
    set = a;
  } else {
    set = rows.filter((r) => r.ticked).map((r) => r.id);
    // Contract 8's refusal, with rule 5's reasons: install's rows (harnessNameLines).
    if (!set.length)
      return {
        early: refused(
          project,
          [
            `No harness is used in ${project} or ready on this machine, and none named. Name one:`,
            ...harnessNameLines(rows),
          ].join("\n"),
        ),
      };
  }
  summary.harnesses = rows.map(({ id, why }) => ({ id, ticked: set.includes(id), why }));

  // Question 3, the channel (rule 6), or --channel, or rule 6's table.
  const ch = f.channelHarness;
  const chInSet = Boolean(ch && set.includes(ch.id));
  if (flagChannel && !chInSet)
    return {
      early: usage(
        `--channel chooses ${ch ? ch.display_name : "the host plugin"}'s channel; this run does not install ${ch ? ch.display_name : "it"}`,
      ),
    };
  const words = channelWords(!f.others.length && Boolean(f.directory));
  const dc = decideChannel({
    inSet: chInSet,
    others: f.others,
    directory: f.directory,
    display: ch?.display_name ?? null,
    flag: flagChannel,
    interactive: Boolean(rail),
    running: version,
    selected: f.selected,
    kept: channelKeep(f.binding),
    inSession: ch ? insideHostSession(runEnv, ch) : false,
    sessionCopy: f.sessionCopy,
  });
  if (dc.refuse) {
    const blocks = channelChoices({
      gate: {
        args: { harnesses: named },
        keys: f.others.map((o) => o.key),
        directory: f.directory ? [f.directory.key] : [],
        version: pinFor(root, version),
      },
    });
    return {
      early: refused(
        project,
        blocks
          .flatMap((b) => [b.lead, b.command])
          .filter(Boolean)
          .join("\n"),
        channelText(blocks, c) + "\n",
      ),
    };
  }
  let channel = dc.value ?? null;
  if (rail && dc.asked) {
    const a = await rail.select(
      TITLES.channel,
      dc.choices.map((x) => ({ ...x, reason: glyphs(x.reason) })),
      { default: dc.default, note: words.text },
    );
    if (cancelled(a)) return CANCEL;
    channel = a;
  } else if (rail && dc.why === "flag") rail.answered(TITLES.channel, words.answers[channel]);
  summary.channel = channel;

  // Question 4, the vault (rule 7), or --vault.
  let vault = null; // { kind: "inherit", from } | { kind: "path", path, scaffold }
  if (f.binding) {
    const n = normaliseVaultPath(f.binding.vault_path, project, home);
    const boundPath = typeof n === "string" ? n : String(f.binding.vault_path);
    const want = values.vault ? normaliseVaultPath(values.vault, project, home) : null;
    // A --vault that names no folder (a ~user path) is refused as an unbound
    // run refuses it: it is never compared with the bound vault, nor dropped.
    if (want && typeof want !== "string") return { early: refused(project, want.error) };
    if (typeof want === "string" && real(want) !== real(boundPath)) {
      const command = coreCommand("bind", { args: `${shellQuote(want)} --rebind` });
      const why = `this project is bound to ${boundPath}; setup never rebinds`;
      return {
        early: refused(
          project,
          `${why}\n${command}`,
          [
            `${why}. To point it at ${want}, from a terminal in this project:`,
            ...term.commandBlock(c, [command], { indent: 4 }),
          ].join("\n") + "\n",
        ),
      };
    }
    const ignored = [
      values.layout && values.layout !== (f.binding.layout || "engineering") ? "--layout" : null,
      values.language && values.language !== (f.binding.language || "en") ? "--language" : null,
    ].filter(Boolean);
    if (rail)
      rail.answered(
        TITLES.vault,
        [
          tilde(boundPath, home),
          f.binding.layout || "engineering",
          f.binding.language || "en",
          ...(ignored.length ? [`${ignored.join(" and ")} ignored: a bound project keeps its own`] : []),
        ].join(` ${term.icon(c, "dot")} `),
      );
  } else if (values.vault) {
    const n = normaliseVaultPath(values.vault, project, home);
    const why = vaultPathRefusal(values.vault, project, home);
    if (why) return { early: refused(project, why) };
    vault = { kind: "path", path: n };
    if (rail) rail.answered(TITLES.vault, tilde(n, home));
  } else if (rail) {
    const choices = vaultChoices({ sibling: f.sibling, worktree: f.worktree, layout, home }).map((x) => ({
      ...x,
      label: glyphs(x.label),
      reason: glyphs(x.reason),
    }));
    for (;;) {
      const a = await rail.select(TITLES.vault, choices, { default: choices[0].value });
      if (cancelled(a)) return CANCEL;
      if (a === "none") break;
      if (a === "inherit") {
        vault = { kind: "inherit", from: f.worktree.main };
        break;
      }
      if (a === "create" || a === "use") {
        vault = { kind: "path", path: f.sibling.path };
        break;
      }
      // Another folder…: a path, or Esc back to the choice (the rail erased it).
      const typed = await rail.path(TITLES.path, {
        default: tilde(f.sibling.path, home),
        check: (x) => vaultPathRefusal(x, project, home),
      });
      if (cancelled(typed)) return CANCEL;
      if (typed === term.BACK) continue;
      vault = { kind: "path", path: normaliseVaultPath(typed, project, home) };
      break;
    }
  }
  // An existing vault whose layout folders are missing: one more confirm at a
  // terminal (rule 7). Without one it is bound only, and DONE says how.
  if (vault?.kind === "path") {
    const probe = planBind(project, {
      vault: vault.path,
      layout: values.layout ?? null,
      language: values.language ?? null,
      init: true,
      scaffoldExisting: true,
      env: runEnv,
      root,
      home,
    });
    vault.missing = probe.ok && probe.scaffoldsExisting ? probe.scaffold.creates : 0;
    vault.scaffold = false;
    if (rail && vault.missing) {
      const a = await rail.confirm(
        glyphs(
          `${tilde(vault.path, home)} has no ${probe.layout} layout yet. Add its ${vault.missing} folders and indexes?`,
        ),
        { note: "Existing files are never changed." },
      );
      if (cancelled(a)) return CANCEL;
      vault.scaffold = a;
    }
  }
  // The binding the run leaves, and whether it already says the status line.
  const leaves = Boolean(f.binding || vault);
  const stored = (f.binding || (vault?.kind === "inherit" ? readConfigAt(vault.from) : null))?.statusline?.enabled;
  // A keep with no binding to record it in says so (rule 6), once the vault's
  // answer has settled that there is none.
  if (rail && channel === "git" && !leaves)
    rail.answered(TITLES.channel, `${words.answers.git} ${term.icon(c, "dot")} ${UNRECORDED}`);

  // Question 6, the status line (rule 9).
  const sh = f.slotHarness;
  const ds = decideStatusline({ inSet: Boolean(sh && set.includes(sh.id)), leaves, stored, slot: f.slot, channel });
  let statusline = null;
  if (rail && ds.asked) {
    const a = await rail.confirm(TITLES.statusline(sh.display_name), {
      note: `your current epic and story, above any status line you already use; restart ${sh.display_name} to see it`,
    });
    if (cancelled(a)) return CANCEL;
    statusline = a;
  }
  return {
    project,
    header,
    runEnv,
    f,
    set,
    namedRun: Boolean(rail) || named.length > 0,
    channel,
    vault,
    statusline,
    underKeep: rail && ds.underKeep ? sh : null,
  };
}

// Setup's DONE lines (rules 10, 11 and 13), from the run's result: the ▲ row
// of a failed git init; per harness, what a missing host or a host session
// left to do, each with its terminal command; the status line under the
// keep; an existing vault left without its layout; the bind lines when the
// project is still unbound; and the tip. Commands in the core form, pinned to
// the running version, never --project (rule 11); a harness's own commands
// from invocation().
function doneLines(r, { project, runEnv, home, version, channel, vaultPlan, underKeep, verbose }) {
  const p = r.plan;
  const blocks = [];
  for (const id of p.harnesses) {
    const m = loadHarness(id);
    if (!m) continue;
    const pr = hostPresence(m, { env: runEnv, home });
    // A missing host only when this run needed it (rule 5): its registration
    // row is a skip whose reason says the host's CLI is not on PATH, as every
    // registration planner words it. A row that needed no host (one already
    // current) says nothing, whatever PATH holds.
    const needed =
      pr.bin &&
      !pr.cli &&
      p.items.some(
        (i) =>
          i.harness === id &&
          i.kind === "registration" &&
          i.action === "skip" &&
          String(i.reason || "").includes(`\`${pr.bin}\` is not on PATH`),
      );
    if (needed) {
      blocks.push({
        lead: `${m.display_name} is not installed on this machine (${pr.bin} was not found on PATH). Install it, then run this from a terminal in this project:`,
        commands: [coreCommand("setup", { version, args: `--harness ${id}` })],
      });
      continue;
    }
    const mine = p.items.filter((i) => i.harness === id && i.deferred);
    const left = [];
    if (
      registrationDeferred(runEnv, m) &&
      mine.some((i) => i.kind === "registration" && !String(i.surface).endsWith("_others"))
    )
      left.push("the plugin registration");
    if (insideHostSession(runEnv, m) && mine.some((i) => i.kind === "channel"))
      left.push("the kept copy's own refresh");
    if (insideHostSession(runEnv, m) && p.items.some((i) => i.kind === "layout" && i.deferred && i.harness === id))
      left.push("the layout move");
    // Rule 13: `--channel npm` when that was the answer, and only for the
    // harness whose channel it is — setup refuses --channel in a run without
    // that harness (exit 2). A keep is not repeated: once recorded, it is the
    // default already (rule 6). The deferred row's reason names the same
    // command, from the same builder.
    if (left.length)
      blocks.push({
        lead: `Left for a terminal outside this ${m.display_name} session: ${left.join(", ")}. From a terminal in this project, run:`,
        commands: [terminalRun({ verb: "setup", harness: m, version, channel })],
        after: `then restart ${m.display_name}.`,
      });
  }
  if (underKeep)
    blocks.push({
      lead: `To show projectstore in the status line, run this in ${underKeep.display_name}:`,
      commands: [invocation(underKeep, "statusline", { args: "on" })],
    });
  const bp = vaultPlan;
  if (
    bp &&
    bp.ok &&
    !bp.inherit &&
    !bp.buildsVault &&
    !bp.scaffoldsExisting &&
    bp.scaffold?.ok &&
    bp.scaffold.creates > 0
  ) {
    blocks.push({
      lead: `${tilde(bp.vault, home)} has no ${bp.layout} layout yet. To add its missing folders and indexes, from a terminal in this project:`,
      commands: [coreCommand("scaffold", { version, args: "--write" })],
    });
  }
  if (!readConfigAt(project)) {
    p.harnesses.forEach((id, k) => {
      const m = loadHarness(id);
      if (m)
        blocks.push({
          lead: `${k ? "" : "This project has no vault yet. "}Bind a vault, in ${m.display_name}:`,
          commands: [invocation(m, "bind", { args: "<vault-path>" })],
        });
    });
  }
  // Doctor's fix in each run harness's own form, as the bind lines are.
  const fixes = [
    ...new Set(
      p.harnesses
        .map((id) => loadHarness(id))
        .filter(Boolean)
        .map((m) => invocation(m, "doctor", { args: "--fix" })),
    ),
  ];
  const warnings = (r.warnings || []).map((w) => ({
    text: `the vault has no git repository: git init failed (${String(w.message || "").split("\n")[0]}). Run git init in it from a terminal, or doctor's fix in a session, which offers it:`,
    commands: [`git -C ${shellQuote(w.path)} init`, ...fixes],
  }));
  const tip = {
    lead: verbose
      ? "To preview without writing:"
      : "To preview without writing (--verbose adds every row's reasoning):",
    commands: [coreCommand("setup", { args: "--dry-run" })],
  };
  return { warnings, blocks, tip };
}

// DONE's Next lines without a DONE: a run that had nothing to write still
// says what a missing host or a session left, and how to bind.
function nextText(blocks, c) {
  if (!blocks.length) return "";
  const width = c.live ? c.width : 0;
  const lines = ["", term.heading(c, "Next")];
  blocks.forEach((b, k) => {
    if (k) lines.push("");
    lines.push(
      ...term
        .wrap(b.lead, width, "  ")
        .split("\n")
        .map((l, n) => (n ? l : `  ${l}`)),
    );
    if ((b.commands || []).length) lines.push(...term.commandBlock(c, b.commands, { indent: 4 }));
    if (b.after) lines.push("", `  ${b.after}`);
  });
  return lines.join("\n") + "\n";
}

// The `setup` verb. `ctx` is cli.mjs's run context — values, the resolved
// project, env, cwd, the three streams and the tests' `ask` — plus the bin's
// own: `root` (the package root), `ownEnv(project)` (the environment the
// installer runs in) and `author(project)` (a fresh binding's
// default_author). The tests' hooks: `home`, `proc` (the rail's process),
// `escapeMs` (its Esc timeout), `gitSpawn`, `drainTicks`, and runVerb's own
// `spawn`, `fetchSpawn`, `fetch`, `now` and `timers`. Returns { code,
// project, ok, result } — `result` the envelope's, which cli.mjs writes under
// --json — or { code: 2, error } for a usage error. Exit codes (rule 1): 0 applied, nothing to do or a clean dry
// run; 1 a refusal, a declined question, an incomplete plan, a failed step or
// a failed git init; 2 usage; 130 cancelled at a question.
export async function runSetup(ctx) {
  const { values = {}, env = process.env, stdin = null, stdout = null, ask = null } = ctx;
  const root = ctx.root;
  const home = ctx.home || homedir();
  // The running version, as plan reads it for a shell-rooted row (planOptions).
  const version = planOptions({ root }).version;
  const json = Boolean(values.json);
  const dryRun = Boolean(values["dry-run"]);
  const verbose = Boolean(values.verbose);
  const named = (values.harness || []).filter(Boolean);
  const write = (text) => {
    if (!json && stdout && text) stdout.write(text);
  };
  const usage = (error) => ({ code: 2, error });

  // Usage, before anything is read (exit 2).
  const unknown = named.filter((id) => !harnessIds().includes(id));
  if (unknown.length) return usage(`unknown harness: ${unknown.join(", ")} — known: ${harnessIds().join(", ")}`);
  const flagChannel = values.channel ?? null;
  if (flagChannel !== null && !["npm", "git"].includes(flagChannel))
    return usage(`--channel takes npm or git, not ${JSON.stringify(flagChannel)}`);
  const layouts = layoutNames(root),
    languages = languageNames(root);
  if (values.layout && layouts.length && !layouts.includes(values.layout))
    return usage(`unknown layout "${values.layout}" — one of: ${layouts.join(", ")}`);
  if (values.language && languages.length && !languages.includes(values.language))
    return usage(`unknown language "${values.language}" — one of: ${languages.join(", ")}`);

  // 1. Contract 19: the project given (--project, or a variable that names
  // it), else the current folder, refused when it is not a directory.
  const given = Boolean(values.project || env.PROJECTSTORE_PROJECT_DIR || projectRootDeclared(env));
  const start = given ? resolve(ctx.project) : resolve(ctx.cwd || process.cwd());
  const summary = { project: start, git_top: null, harnesses: [], channel: null, vault: null, statusline: null };
  // A refusal before any plan: its text is written by whoever returns it,
  // once the rail (if one is open) has closed beneath the answers.
  const refused = (project, message, text = `${message}\n`) => ({
    code: 1,
    project,
    ok: false,
    text,
    result: {
      gate: { confirmed: false, why: "refused" },
      applied: [],
      failed: null,
      incomplete: false,
      plannedAgainst: {},
      items: [],
      refusals: [message],
      reports: [],
      fetched: [],
      setup: summary,
    },
  });
  const say = ({ text, ...r }) => {
    write(text);
    return r;
  };
  const missing = projectDirRefusal(start);
  if (missing) return say(refused(start, missing));

  // 2. Only the git top, and whether this folder is its own project (rule 4).
  const top = given ? null : gitTop(start, { env, spawn: ctx.gitSpawn || spawnSync });
  summary.git_top = top;
  const own = top ? ownProjectNames().some((n) => existsSync(join(start, n))) : false;

  // The rail, only where a person can answer it (rule 2): an interactive run
  // (TTYs, no CI, no --json, no session marker) on a terminal that takes raw
  // mode. Anywhere else the run is one without a terminal: no question, and
  // the confirm is --harness — the gate gets no streams to ask on.
  const c = stdout ? term.caps(stdout, env) : term.PLAIN;
  const interactive = !json && isInteractive({ stdin, stdout, env, json }) && term.railAvailable(stdin, c);
  let rail = null,
    q = null;
  try {
    if (interactive)
      rail = term.openRail({
        stdin,
        stdout,
        caps: c,
        proc: ctx.proc || process,
        head: "projectstore setup",
        ...(ctx.escapeMs ? { escapeMs: ctx.escapeMs } : {}),
      });
    q = await questions(rail, {
      start,
      top,
      given,
      own,
      values,
      named,
      flagChannel,
      layout: values.layout || "engineering",
      env,
      home,
      root,
      version,
      c,
      refused,
      usage,
      summary,
      ownEnv: ctx.ownEnv,
    });
  } finally {
    // `└` before any network work, whatever ended the questions.
    if (rail) rail.close(q?.cancelled ? `Cancelled ${term.icon(c, "dash")} nothing was written` : "");
  }
  if (q.cancelled) return { code: 130, project: summary.project, ok: false, result: null };
  if (q.early) return q.early.error ? q.early : say(q.early);
  const { project, runEnv, set, channel, vault, statusline } = q;

  // 6. The vault plan, pure; its refusals stop the run here. One spelling of
  // the project for it and for plan(), and the run's environment for both.
  let vaultPlan = null;
  if (vault?.kind === "inherit") vaultPlan = planInherit(project, { from: vault.from, env: runEnv, root, home });
  else if (vault?.kind === "path")
    vaultPlan = planBind(project, {
      vault: vault.path,
      layout: values.layout ?? null,
      language: values.language ?? null,
      init: true,
      scaffoldExisting: Boolean(vault.scaffold),
      author: dryRun || !ctx.author ? "" : ctx.author(project),
      env: runEnv,
      root,
      home,
    });
  if (vaultPlan && !vaultPlan.ok) return say(refused(project, vaultPlan.refusals.map((x) => x.message).join("\n")));
  summary.vault = vaultPlan ? bindResult(vaultPlan, null) : null;

  // 7. The installer's own run, with setup's inputs.
  const done = (r) =>
    doneLines(r, { project, runEnv, home, version, channel, vaultPlan, underKeep: q.underKeep, verbose });
  const r = await runVerb("setup", project, {
    harnesses: set,
    named: q.namedRun,
    channel,
    vault: vaultPlan,
    statusline,
    layout: vaultPlan ? vaultPlan.layout : null,
    root,
    env: runEnv,
    home,
    cwd: ctx.cwd,
    json,
    verbose,
    dryRun,
    out: json ? null : stdout,
    badged: Boolean(rail),
    header: q.header,
    stdin: rail ? stdin : null,
    stdout: rail ? stdout : null,
    ask: rail ? ask : null,
    drain: rail ? () => term.drainInput(stdin, { ticks: ctx.drainTicks ?? 2 }) : null,
    done,
    spawn: ctx.spawn,
    fetchSpawn: ctx.fetchSpawn,
    fetch: ctx.fetch,
    now: ctx.now,
    timers: ctx.timers,
  });
  const after = readConfigAt(project);
  summary.statusline = typeof after?.statusline?.enabled === "boolean" ? after.statusline.enabled : null;
  const applied = r.applied.find((a) => a && a.surface === "vault" && a.bind);
  if (applied) summary.vault = applied.bind;
  // A failed git init is no stop, but the run is not ok (rule 10).
  const warned = (r.warnings || []).length > 0;
  const ok =
    r.plan.ok &&
    !r.plan.incomplete &&
    !r.failed &&
    !warned &&
    (r.gate.confirmed || ["nothing-to-do", "dry-run"].includes(r.gate.why));
  if (!r.gate.confirmed) {
    write(
      gateText(r, {
        verb: "setup",
        harnesses: named,
        caps: c,
        args: (id) => repeatArgs(values, vault?.path || null, { channel: id === q.f.channelHarness?.id }),
      }),
    );
    if (r.gate.why === "nothing-to-do") write(nextText(done(r).blocks, c));
  }
  return {
    code: ok ? 0 : 1,
    project,
    ok,
    result: {
      gate: r.gate,
      applied: r.applied,
      failed: r.failed,
      incomplete: r.plan.incomplete,
      plannedAgainst: r.plan.plannedAgainst,
      items: r.plan.items.map(publicItem),
      refusals: r.plan.refusals,
      reports: r.plan.reports,
      fetched: r.fetched || [],
      setup: summary,
    },
  };
}

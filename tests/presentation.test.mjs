// projectstore — the bin's screens (PS-HARNESS: "The CLI's output is
// designed: grouped plans, a question rail, one glyph set, doctor grouped by
// cause"; the covering spec *Terminal presentation of the projectstore CLI:
// layout, glyphs, colour roles, questions and live lines*, contracts 2–12 and
// Testing).
//
// Golden screens — PLAN (two harness groups, an upgrade, an uninstall, a
// refusal), the confirm, APPLY, DONE, STOPPED, bind's plan, doctor, --help
// (the top level and install's) and status — in four modes at 80 columns,
// rendered from tests/fixtures/presentation.mjs with injected caps and
// clocks; the equivalence between modes; the ASCII scan; and one test per
// acceptance criterion this part of the story closes (1, 2, 3, 5, 6, 7, part
// of 8, 9), on real plans where the criterion is about what plan() produces.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/presentation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SCREENS, MODES, DIR, goldenPath, renderAll, installPlan, uninstallPlan, bindPlan, statusResult, HOME, PROJECT, VERSION, DOCTOR_FINDINGS, DOCTOR_GROUPS, doctorText, asciiOnly } from "./fixtures/presentation.mjs";
import { installedTree } from "./fixtures/json-captures.mjs";
import { fakePackageRoot, fakeClaude, noHostEnv } from "./fixtures/install.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { plan, renderPreview, renderDone, applyReporter } from "../scripts/install-harness.mjs";
import { renderBindPlan } from "../scripts/binding.mjs";
import { caps, plain, PLAIN, askApply, icon, GLYPH_ALIASES } from "../scripts/term.mjs";
import { loadHarness, sourceHarness, invocation, harnessIds } from "../scripts/harness.mjs";
import { report, CHECKS } from "../scripts/doctor-report.mjs";
import { run, usage, verbHelp, VERBS, SUMMARY_MAX } from "../scripts/cli.mjs";
import { renderStatus, startDate } from "../scripts/query.mjs";
import { OFFER_CHECKS } from "../scripts/doctor.mjs";
import { commandForm, doctorSummaryLine } from "../scripts/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CODEX = loadHarness("codex");
const SGR = /\x1b\[[0-9;]*m/;
const tty = (columns = 80) => ({ isTTY: true, columns });
const tmp = (name) => mkdtempSync(join(tmpdir(), `ps-pres-${name}-`));

// ─── Goldens and the equivalence between modes (criterion 9) ──────────

test("presentation goldens: every screen equals its committed golden in rich, rich-no-colour, plain and ascii at 80 columns", async () => {
  const all = await renderAll();
  assert.equal(all.length, SCREENS.length * Object.keys(MODES).length);
  for (const [screen, mode, text] of all) assert.equal(text, readFileSync(goldenPath(screen, mode), "utf8"), `${screen}.${mode}`);
  // The folder holds exactly these goldens: none stale, none missing.
  const want = all.map(([screen, mode]) => `${screen}.${mode}.txt`).sort();
  assert.deepEqual(readdirSync(DIR).sort(), want);
});

// The spec's equivalence transform (Testing → Equivalence): drop every
// in-flight frame (the text up to and including "\r\x1b[2K") and every
// question block; rejoin wrapped prose; collapse runs of two or more spaces
// to one. Wrapped prose is a line that continues the one above it:
//   - a note moved under its row: the row above holds a target and no note,
//     and the line starts at that target's column;
//   - a wrap continuation: the line above is prose that fits the width —
//     not a row with a note, not a line ending in a right-aligned cell —
//     this line starts where a continuation of it starts (its indent, its
//     indent plus two, or the column after its lead's gap), and this
//     line's first word would not have fitted on it: the only reason wrap()
//     breaks a line (term.mjs).
// Every other line break, and every blank line, is kept: a line missing,
// added or moved in one mode is still a difference.
const COLUMNS = MODES.plain.width;
const LEAD = /^ {2}(\S+) (\S+) {2,}(\S.*)$/;
const indentOf = (l) => l.length - l.trimStart().length;
function continues(prev, line) {
  const body = line.trim();
  if (!body || !prev.trim() || prev.length > COLUMNS || / {2,}\S+$/.test(prev)) return false;
  const row = prev.match(LEAD);
  if (row && / {2,}/.test(row[3])) return false;
  const gap = prev.trimStart().match(/^\S.*? {2,}(?=\S)/);
  const at = [indentOf(prev), indentOf(prev) + 2, gap ? indentOf(prev) + gap[0].length : -1];
  // doctor glues a path to the dash before it, so the two wrap as one word;
  // status glues each count of a heading to its words and the dot after it,
  // so a line broken after a dot carries on with one whole count.
  const count = / ·$/.test(prev) ? /^(.*? ·)(?= |$)|^.*$/.exec(body) : null;
  const first = count ? count[1] || count[0] : (/^— \S+/.exec(body) || [body.split(" ")[0]])[0];
  return at.includes(indentOf(line)) && prev.length + 1 + first.length > COLUMNS - 2;
}
function transform(text) {
  const raw = text.replace(/[^\n]*\r\x1b\[2K/g, "").split("\n").filter((l) => !l.includes("[Y/n]"));
  const out = [];
  raw.forEach((line, k) => {
    const prev = k ? raw[k - 1] : "";
    const row = prev.match(LEAD);
    const movedNote = Boolean(row && line.trim() && !/ {2,}/.test(row[3]) && indentOf(line) === prev.length - row[3].length);
    if (out.length && (movedNote || continues(prev, line))) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  });
  return out.map((l) => l.replace(/ {2,}/g, " ").trimEnd()).join("\n").trim();
}

test("presentation equivalence: SGR-stripped rich equals rich-no-colour, and plain equals rich-no-colour under the transform, for every screen", async () => {
  for (const [screen, render, { full = null } = {}] of SCREENS) {
    const rich = await render(MODES.rich), bare = await render(MODES["rich-no-colour"]), piped = await render(MODES.plain);
    assert.equal(plain(rich), bare, `${screen}: colour is the only difference`);
    // A screen a terminal compacts (doctor, contract 11) is held to the
    // terminal's uncompacted rendering — the one --verbose asks for.
    const tty = full ? await full(MODES["rich-no-colour"]) : bare;
    if (full) assert.equal(plain(await full(MODES.rich)), tty, `${screen} --verbose: colour is the only difference`);
    assert.equal(transform(piped), transform(tty), `${screen}: plain is rich-no-colour less its live frames, questions and wrapping`);
    if (screen !== "confirm") assert.ok(transform(piped).length > 0, `${screen} is not empty`);
  }
  // Not vacuous for doctor: the terminal's compact report differs from plain.
  const doctor = SCREENS.find(([s]) => s === "doctor");
  assert.notEqual(transform(await doctor[1](MODES["rich-no-colour"])), transform(await doctor[1](MODES.plain)), "the compact report is not plain's");
  // Not vacuous: rich paints, rich-no-colour wraps and moves notes, and the live screens have frames.
  const [rich, bare, piped] = await Promise.all(["rich", "rich-no-colour", "plain"].map((m) => SCREENS.find(([s]) => s === "plan-install")[1](MODES[m])));
  assert.ok(SGR.test(rich) && bare !== piped, "the modes differ before the transform");
  assert.ok((await SCREENS.find(([s]) => s === "apply")[1](MODES["rich-no-colour"])).includes("\r\x1b[2K"), "APPLY on a live terminal has in-flight frames");
  // The transform keeps line structure: one mode missing the blank line
  // before a command block (contract 6) is a difference it reports.
  const done = SCREENS.find(([s]) => s === "done")[1];
  const [donePiped, doneBare] = [await done(MODES.plain), await done(MODES["rich-no-colour"])];
  const squeezed = donePiped.replace(":\n\n  npx ", ":\n  npx ");
  assert.notEqual(squeezed, donePiped, "the mutation applies");
  assert.notEqual(transform(squeezed), transform(doneBare), "a missing blank line before the command block");
  assert.notEqual(transform(donePiped.replace("--verbose\n  npx", "--verbose  npx")), transform(doneBare), "two commands run together on one line");
});

// ─── Criterion 8, its part here: ASCII glyphs and no SGR ──────────────

const nonAscii = (text) => [...text].filter((ch) => ch.codePointAt(0) > 0x7e);

// A screen whose data is not ASCII (doctor's findings carry their own em
// dashes, printed as they are) is scanned as drawn from ASCII data: what is
// left that is not ASCII, the renderer composed.
const scanned = (screen) => { const [, render, { scan = null } = {}] = SCREENS.find(([s]) => s === screen); return scan || render; };

test("presentation ASCII: the ascii goldens hold no code point above 0x7E; no golden but rich holds SGR", async () => {
  for (const [screen, mode, text] of await renderAll()) {
    if (mode === "ascii") { const t = await scanned(screen)(MODES.ascii); assert.deepEqual(nonAscii(t), [], `${screen}.ascii: ${JSON.stringify(nonAscii(t))}`); }
    if (mode === "rich") assert.ok(SGR.test(text), `${screen}.rich is painted`);
    else assert.ok(!SGR.test(text), `${screen}.${mode} carries no SGR`);
  }
  // The doctor scan is the golden's own screen, its data aside.
  assert.equal(await scanned("doctor")(MODES.ascii), asciiOnly(readFileSync(goldenPath("doctor", "ascii"), "utf8")));
});

test("presentation ASCII: under TERM=dumb or PROJECTSTORE_ASCII, on a TTY and on a pipe, every glyph and separator is ASCII; NO_COLOR leaves no SGR", async () => {
  const modes = {
    "TERM=dumb, TTY": caps(tty(), { TERM: "dumb" }),
    "TERM=dumb, pipe": caps({}, { TERM: "dumb" }),
    "PROJECTSTORE_ASCII, TTY": caps(tty(), { PROJECTSTORE_ASCII: "1" }),
    "PROJECTSTORE_ASCII, pipe": caps({}, { PROJECTSTORE_ASCII: "1" }),
  };
  for (const [name, c] of Object.entries(modes)) {
    for (const [screen] of SCREENS) {
      const text = await scanned(screen)(c);
      assert.deepEqual(nonAscii(text), [], `${name}, ${screen}: ${JSON.stringify(nonAscii(text))}`);
    }
  }
  assert.ok(SGR.test(await SCREENS[0][1](modes["PROJECTSTORE_ASCII, TTY"])), "PROJECTSTORE_ASCII keeps the colour");
  for (const [screen, render] of SCREENS) assert.ok(!SGR.test(await render(caps(tty(), { NO_COLOR: "1" }))), `NO_COLOR, ${screen}`);
});

// ─── Criterion 1: badge, path, groups, a person's words ───────────────

// A row of a group: two spaces, the glyph, the action word, then the target
// and the note after runs of two or more spaces. Prose lines (reasons,
// consent lines, the same-block and host lines) never match: they are
// indented further or carry no double space after their first word.
const ROW = /^ {2}(\S+) (\S+) {2,}(\S.*)$/;
const WORDS = new Set(["add", "update", "remove", "register", "unchanged", "skipped", "refused", "switch", "fetch"]);
const KINDS = ["shared", "exclusive", "registration", "host"];
const STATES = ["ours-absent", "ours-current", "ours-stale", "absent-or-present", "absent", "stale", "current", "foreign", "unavailable", "unsupported", "legacy", "opt-out", "theirs", "conflict", "unparseable", "enabled", "ours", "empty"];
function rowsOf(text) {
  return text.split("\n").map((l) => l.match(ROW)).filter(Boolean).map(([, glyph, action, rest]) => { const [target, note = ""] = rest.split(/ {2,}/); return { glyph, action, target, note }; });
}
function groupsOf(text, names) {
  return text.split("\n").filter((l) => names.includes(l));
}

test("presentation criterion 1: PLAN starts with its badge and project path, groups its rows under each harness's display name in the run's order, and no default-view action or note is a kind word, a state word, an entry marker or a roadmap id", () => {
  const home = tmp("home");
  const env = noHostEnv({ HOME: home });
  const proj = tmp("proj");
  for (const m of [SRC, CODEX]) mkdirSync(join(proj, m.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: "/tmp/nowhere", layout: "engineering", statusline: { enabled: true } });
  const installed = installedTree();
  const plans = [
    ...[[SRC, CODEX], [CODEX, SRC]].map((order) => [`install ${order.map((m) => m.id).join(",")}`, plan(proj, { harnesses: order.map((m) => m.id), home, root: ROOT, env }), "install"]),
    ["upgrade of an installed tree", plan(installed.proj, { harnesses: [SRC.id], home: installed.home, root: ROOT, env: noHostEnv({ HOME: installed.home }) }), "upgrade"],
    ["uninstall of an installed tree", plan(installed.proj, { harnesses: [SRC.id], mode: "uninstall", home: installed.home, root: ROOT, env: noHostEnv({ HOME: installed.home }) }), "uninstall"],
  ];
  for (const [name, p, verb] of plans) {
    const keys = Object.keys(p);
    const text = renderPreview(p, { verb, caps: PLAIN, home });
    assert.deepEqual(Object.keys(p), keys, `${name}: rendering adds nothing to the plan`);
    const lines = text.split("\n");
    const names = p.harnesses.map((id) => loadHarness(id).display_name);
    assert.equal(lines[0], `projectstore ${verb} · ${names.join(", ")}`, name);
    assert.equal(lines[1], `  ${p.projectDir.startsWith(home + "/") ? "~" + p.projectDir.slice(home.length) : p.projectDir}`, name);
    assert.deepEqual(groupsOf(text, names), names, `${name}: one group per harness, in the run's order`);
    const rows = rowsOf(text);
    assert.ok(rows.length >= 2, `${name}:\n${text}`);
    for (const r of rows) {
      assert.ok(WORDS.has(r.action), `${name}: "${r.action}" is a person's word`);
      for (const cell of [r.action, r.note]) {
        for (const k of [...KINDS, ...STATES]) assert.ok(!new RegExp(`(^|[\\s,·])${k}($|[\\s,])`).test(cell), `${name}: "${cell}" holds the internal word ${k}`);
        assert.ok(!/\[[^\]]*\]/.test(cell) && !/roadmap|\b[A-Z]\d+\/[A-Z]\d+\b/.test(cell), `${name}: "${cell}" holds an entry marker or a roadmap id`);
      }
      assert.ok(!/\[[^\]]*\]$/.test(r.target), `${name}: the target "${r.target}" carries no entry marker`);
    }
  }
});

// ─── Criterion 2: one aligned line per row, and a consequence beneath ──

test("presentation criterion 2: within a group every row's action word and target start in the same columns; a long note moves under the target column on a live terminal; a user-wide registration states its consequence beneath its row", () => {
  const text = renderPreview(installPlan(), { verb: "install", caps: PLAIN, home: HOME });
  for (const group of text.split("\n\n").filter((b) => /^(Claude Code|Codex)\n/.test(b))) {
    const lines = group.split("\n").filter((l) => ROW.test(l));
    assert.ok(lines.length >= 2, group);
    const col = (l, k) => { const m = l.match(ROW); return k === "action" ? 2 + m[1].length + 1 : l.indexOf(m[3]); };
    assert.equal(new Set(lines.map((l) => col(l, "action"))).size, 1, `actions aligned:\n${group}`);
    assert.equal(new Set(lines.map((l) => col(l, "target"))).size, 1, `targets aligned:\n${group}`);
  }
  // The consequence of the Codex registration, on the line directly beneath its row, before its consent lines.
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^ {2}\+ register +projectstore@projectstore-npx +plugin$/.test(l));
  assert.ok(at > 0, text);
  assert.equal(lines[at + 1], "      user-wide: the plugin is registered for every project Codex opens, not only this one", text);
  assert.equal(lines[at + 2], "      $ codex plugin list --json", "the consent lines follow it");
  // A local-scope registration states none.
  assert.equal(lines.filter((l) => l.includes("user-wide")).length, 1);
  // At 80 live columns a note that would pass the row moves under the target column, whole.
  const live = renderPreview(installPlan(), { verb: "install", caps: MODES["rich-no-colour"], home: HOME }).split("\n");
  const row = live.findIndex((l) => /^ {2}\+ add +\.projectstore\/state\/claude-code\/statusline\.mjs$/.test(l));
  assert.ok(row > 0, live.join("\n"));
  assert.equal(live[row + 1], `${" ".repeat(live[row].indexOf(".projectstore"))}statusline launcher`);
  // A row that keeps its note on its line fits the row (a target alone may
  // pass it: it is never broken, and the terminal wraps it).
  for (const l of live.filter((x) => { const m = x.match(ROW); return m && m[3].split(/ {2,}/).length > 1; })) assert.ok(l.length <= 79, l);
});

// ─── Criterion 3: consent content beneath its row ─────────────────────

test("presentation criterion 3: every path a real plan writes and every host argv it runs is in the default PLAN, beneath its own row", () => {
  const home = tmp("reg-home");
  const proj = tmp("reg-proj");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: "/tmp/nowhere", layout: "engineering", statusline: { enabled: true } });
  writeFileSync(join(proj, "CLAUDE.md"), "# Mine\n");
  const root = fakePackageRoot(join(tmp("reg-npx"), "node_modules", "projectstore"), "0.30.0");
  const host = fakeClaude(tmp("reg-bin"));
  const p = plan(proj, { home, root, env: host.env({ HOME: home }) });
  assert.ok(p.ok, JSON.stringify(p.refusals));
  assert.equal(host.log().length, 0, "plan runs nothing");
  const text = renderPreview(p, { verb: "install", caps: PLAIN, home });
  const lines = text.split("\n");
  const shown = (x) => (relative(proj, x).startsWith("..") ? x : relative(proj, x));
  const writes = p.items.filter((i) => !["skip", "refuse"].includes(i.action));
  assert.ok(writes.some((i) => (i.steps || []).some((s) => s.kind === "host")), "the plan registers through the host");
  for (const i of writes) {
    const target = i.kind === "registration" ? i.entry : relative(proj, i.path);
    const at = lines.findIndex((l) => { const m = l.match(ROW); return m && m[3].split(/ {2,}/)[0] === target; });
    assert.ok(at >= 0, `${i.surface}'s row:\n${text}`);
    const end = lines.findIndex((l, k) => k > at && (ROW.test(l) || l === "" || /^\S/.test(l)));
    const beneath = lines.slice(at + 1, end).join("\n");
    for (const st of i.steps || []) {
      if (st.kind === "host") {
        assert.ok(beneath.includes(`$ ${[st.bin, ...st.argv].join(" ")}`), `${st.name}'s argv beneath ${target}`);
        if (st.touches.length) assert.ok(beneath.includes(`touches ${st.touches.map(shown).join(", ")}`), `what ${st.name} touches`);
      } else if (st.path) assert.ok(beneath.includes(st.path) || beneath.includes(shown(st.path)), `${st.kind} ${st.path} beneath ${target}`);
    }
  }
});

// ─── Criterion 5: --help in named groups ──────────────────────────────

const HELP_GROUPS = { START: ["install", "bind", "uninstall"], VAULT: ["status", "search", "show", "graph", "codemap"], "CHECK AND REPAIR": ["doctor", "reconcile", "upgrade"] };

// A stream for run(): a terminal (isTTY, 80 columns) or a pipe.
class Sink {
  constructor(tty) { this.text = ""; this.tty = tty; }
  write(s) { this.text += String(s); return true; }
  get isTTY() { return this.tty; }
  get columns() { return 80; }
}

test("presentation criterion 5: top-level --help lists the verbs in named groups, install first, each summary on one line within 80 columns; ADVANCED is one line; options, examples, tips, the harnesses and exit code 130 follow; painted at a terminal, plain on a pipe", async () => {
  // Every summary fits its column, in ASCII: it heads <verb> --help too.
  for (const v of VERBS) assert.ok(v.summary.length <= SUMMARY_MAX && !/[^\x20-\x7e]/.test(v.summary), `${v.verb}: ${v.summary.length} columns`);
  assert.equal(SUMMARY_MAX, 65);
  const shells = harnessIds().map((id) => loadHarness(id).install?.shell).filter(Boolean);
  assert.ok(shells.length >= 2, "both published shells");
  for (const env of [{}, ...shells.map((s) => ({ PROJECTSTORE_SHELL: s }))]) {
    for (const [mode, c] of Object.entries(MODES)) {
      // A prerelease version is the longest the badge carries: it fits too.
      const rc = plain(usage(env, VERBS, { caps: c, version: "0.30.0-rc.12" })).split("\n")[0];
      assert.ok(rc.length <= 80 && rc.includes(" 0.30.0-rc.12 "), `${rc.length} columns: ${rc}`);
      const text = usage(env, VERBS, { caps: c, version: VERSION });
      const lines = plain(text).split("\n");
      const name = `${env.PROJECTSTORE_SHELL || "core"} ${mode}`;
      for (const l of lines) assert.ok(l.length <= 80, `${name}: ${l.length} columns: ${l}`);
      // The sections, in the spec's order, each heading on a line of its own.
      const heads = ["Usage", ...Object.keys(HELP_GROUPS), "ADVANCED", "Options", "Examples", "Tips"];
      assert.deepEqual(heads.map((h) => lines.indexOf(h)), heads.map((h) => lines.indexOf(h)).sort((a, b) => a - b), name);
      assert.ok(heads.every((h) => lines.includes(h)), name);
      assert.match(lines[0], new RegExp(`^projectstore ${mode === "ascii" ? "\\." : "·"} ${VERSION.replace(/\./g, "\\.")} ${mode === "ascii" ? "\\." : "·"} \\S`), name);
      assert.match(lines[lines.indexOf("Usage") + 1], /run it inside your code project$/, name);
      // Each group's verbs, one line each — no description wrapped, at 80 live columns either.
      for (const [g, verbs] of Object.entries(HELP_GROUPS)) {
        const at = lines.indexOf(g);
        const block = lines.slice(at + 1, lines.indexOf("", at));
        assert.deepEqual(block.map((l) => l.trim().split(" ")[0]), verbs, `${name} ${g}`);
        block.forEach((l, k) => assert.equal(l, `  ${verbs[k].padEnd(12)} ${VERBS.find((v) => v.verb === verbs[k]).summary}`, `${name} ${g}`));
      }
      assert.equal(lines[lines.indexOf("START") + 1].trim().split(" ")[0], "install", "install first");
      // ADVANCED: the remaining verbs, in table order, on one line.
      const rest = VERBS.map((v) => v.verb).filter((v) => !Object.values(HELP_GROUPS).flat().includes(v));
      assert.deepEqual(lines.slice(lines.indexOf("ADVANCED") + 1, lines.indexOf("", lines.indexOf("ADVANCED"))), [`  ${rest.join(mode === "ascii" ? " . " : " · ")}`], name);
      assert.ok(rest.includes("init") && rest.includes("scaffold"), "init and scaffold are ADVANCED's");
      // Examples and the tips' plan command: each alone on its line, after a blank one.
      const ex = lines.indexOf("Examples");
      assert.equal(lines[ex + 1], "", name);
      for (const l of lines.slice(ex + 2, lines.indexOf("", ex + 2))) assert.match(l, /^ {2}npx projectstore\S* (install|status|doctor)( --harness <id>)?$/, name);
      // The tips: the confirmation rule and the unattended path; then the harnesses and the exit codes, 130 among them.
      assert.ok(lines.some((l) => /^ {2}Without a terminal, .* there is no --yes\.$/.test(l)), name);
      assert.ok(lines.some((l) => /^ {2}Unattended in a terminal: .*--json.*CI=1.*<\/dev\/null\.$/.test(l)), name);
      assert.equal(lines.at(-2), `Harnesses   ${harnessIds().join(", ")}`, name);
      assert.equal(lines.at(-1), "Exit codes  0 ok, 1 findings or a refusal, 2 usage, 3 not bound, 130 cancelled", name);
    }
  }
  // A group lists only the verbs this run's table has.
  const fewer = usage({}, VERBS.filter((v) => !["graph", "doctor", "reconcile", "upgrade"].includes(v.verb)), { caps: PLAIN, version: VERSION }).split("\n");
  assert.ok(!fewer.includes("CHECK AND REPAIR") && !fewer.some((l) => l.startsWith("  graph ")), fewer.join("\n"));
  assert.ok(!fewer.includes("  npx projectstore doctor"), "no example names a verb the table lacks");
  // Through the bin: painted at a terminal, plain on a pipe — the same lines.
  const at = async (tty, argv) => { const out = new Sink(tty); assert.equal(await run(argv, { env: {}, stdout: out, stderr: new Sink(false) }), 0); return out.text; };
  for (const argv of [["--help"], ["install", "--help"]]) {
    const [painted, piped] = [await at(true, argv), await at(false, argv)];
    assert.ok(SGR.test(painted) && !SGR.test(piped), argv.join(" "));
  }
  // At 80 columns nothing of the top level wraps: the terminal's text is the pipe's, painted.
  assert.equal(plain(await at(true, ["--help"])), await at(false, ["--help"]));
  assert.equal(await at(false, ["--help"]), usage({}, VERBS, { caps: PLAIN }) + "\n");
  // Under NO_COLOR at a terminal: no escape.
  const out = new Sink(true);
  await run(["--help"], { env: { NO_COLOR: "1" }, stdout: out, stderr: new Sink(false) });
  assert.ok(!SGR.test(out.text), out.text);
});

test("presentation help ASCII: every verb's help, for the core and each shell, holds no code point above 0x7E under ASCII glyphs; each example command stands alone on its line", () => {
  const shells = harnessIds().map((id) => loadHarness(id).install?.shell).filter(Boolean);
  for (const env of [{}, ...shells.map((s) => ({ PROJECTSTORE_SHELL: s }))]) {
    for (const c of [MODES.ascii, { ...MODES.ascii, live: false }]) {
      for (const v of VERBS) {
        const text = verbHelp(v, env, { caps: c });
        assert.deepEqual(nonAscii(text), [], `${env.PROJECTSTORE_SHELL || "core"} ${v.verb}: ${JSON.stringify(nonAscii(text))}`);
      }
    }
    // Contract 6 in every verb's examples: a command line holds the command and nothing after it.
    for (const v of VERBS) {
      const lines = verbHelp(v, env, { caps: PLAIN }).split("\n");
      const from = lines.indexOf("Examples");
      if (from === -1) continue;
      const block = lines.slice(from + 1, lines.findIndex((l, k) => k > from && /^Exit codes/.test(l)));
      const commands = block.filter((l) => /^ {2}npx /.test(l));
      assert.ok(commands.length > 0, v.verb);
      for (const l of commands) assert.ok(!l.includes("#"), `${v.verb}: "${l}"`);
      // Each command block starts after a blank line or after its note, which follows a blank one.
      block.forEach((l, k) => { if (/^ {2}npx /.test(l) && !/^ {2}npx /.test(block[k - 1])) assert.ok(block[k - 1] === "" || (/:$/.test(block[k - 1]) && block[k - 2] === ""), `${v.verb}: "${block[k - 1]}" / "${l}"`); });
    }
  }
  // The note that shared the command's line now stands just above it.
  const install = verbHelp(VERBS.find((v) => v.verb === "install"), {}, { caps: PLAIN });
  assert.ok(install.includes("\n\n  The same plan; nothing is written:\n  npx projectstore plan --harness <id>\n"), install);
});

// ─── Criterion 7: synchronous APPLY ───────────────────────────────────

test("presentation criterion 7: a synchronous APPLY step shows … while it runs and nothing animates; a pipe gets one finished line per step and no escape; a registration ends on its finished line, in the past tense", () => {
  const run = (c) => {
    const chunks = [];
    const p = installPlan();
    let t = 0;
    const rep = applyReporter({ write: (s) => { chunks.push(String(s)); return true; } }, c, p, { now: () => t, home: HOME });
    const reg = p.items[0];
    rep.onItem(reg, "start");
    rep.spawn(() => { t += 300; return { status: 0 }; })("claude", ["plugin", "validate", "x"], {});
    rep.onItem(reg, "end", { action: "create" });
    rep.onItem(p.items[1], "start");
    t += 40;
    rep.onItem(p.items[1], "end", { action: "create" });
    return chunks;
  };
  const live = run(MODES["rich-no-colour"]);
  // The registration's own line; then each step as an in-flight frame,
  // replaced once by its finished line; then the registration's finished
  // line, written on its own, timed over its steps.
  assert.deepEqual(live.map((s) => (s.startsWith("\r\x1b[2K") ? "finished" : s.endsWith("\n") ? "line" : "running")), ["line", "running", "finished", "line", "running", "finished"]);
  assert.ok(live[1].startsWith("      … $ claude plugin validate x") && live[4].startsWith("  … adding AGENTS.md"), JSON.stringify(live));
  assert.match(live[2], /^\r\x1b\[2K {6}✓ \$ claude plugin validate x +0\.3s\n$/);
  assert.match(live[3], /^ {2}✓ registered projectstore@projectstore-npm +0\.3s\n$/);
  assert.match(live[5], /^\r\x1b\[2K {2}✓ added AGENTS\.md +0\.0s\n$/);
  const piped = run(MODES.plain);
  assert.deepEqual(piped, ["  + registering projectstore@projectstore-npm\n", piped[1], piped[2], piped[3]]);
  assert.match(piped[1], /^ {6}✓ \$ claude plugin validate x +0\.3s\n$/);
  assert.match(piped[2], /^ {2}✓ registered projectstore@projectstore-npm +0\.3s\n$/);
  assert.match(piped[3], /^ {2}✓ added AGENTS\.md +0\.0s\n$/);
  assert.ok(piped.every((s) => !s.includes("\x1b")), "no escape into a pipe");
  // A registration that stopped says so beneath its steps, and never reads as registered.
  const chunks = [];
  const p = installPlan();
  const rep = applyReporter({ write: (s) => { chunks.push(String(s)); return true; } }, MODES.plain, p, { now: () => 0, home: HOME });
  rep.onItem(p.items[0], "start");
  rep.onItem(p.items[0], "end", { action: "create", failed: { step: "install", status: 1, stderr: "" } });
  assert.deepEqual(chunks, ["  + registering projectstore@projectstore-npm\n", "      ✕ stopped\n"]);
});

// ─── The rest of contract 7 and 8 ─────────────────────────────────────

test("presentation: the same-block line sits in the other harness's group, two spaces in; DONE's Next is one line per display name, and its one tip is each shell's plan command with --verbose, alone on its line after a blank one", () => {
  const text = renderPreview(installPlan(), { verb: "install", caps: PLAIN, home: HOME });
  const codex = text.slice(text.indexOf("\nCodex\n"));
  assert.ok(codex.includes("\n  · AGENTS.md — the same block as Claude Code, above\n"), text);
  assert.ok(!text.slice(0, text.indexOf("\nCodex\n")).includes("the same block as"));
  const done = SCREENS.find(([s]) => s === "done")[1](MODES.plain);
  const next = done.slice(done.indexOf("\nNext\n") + 6).split("\n\n")[0].split("\n");
  assert.deepEqual(next.map((l) => l.trim().split(/ {2,}/)[0]), ["Claude Code", "Codex"]);
  // After the settled facts, one tip — the --verbose tip is merged into it —
  // then its commands, each alone on its line, nothing after the flag.
  assert.deepEqual(done.slice(done.indexOf("\n  version  0.30.0\n") + 1).split("\n\n"), [
    "  version  0.30.0",
    "  To preview without writing, with every row's reasoning:",
    '  npx projectstore-claude plan --project "$PWD" --verbose\n  npx projectstore-codex plan --project "$PWD" --verbose\n',
  ]);
  // No prose line carries a command or puts punctuation after one.
  for (const l of done.split("\n").filter((x) => x.includes("--verbose") || x.includes(" plan "))) assert.match(l, /^ {2}npx \S+ plan --project \S+ --verbose$/, l);
  // A project that is not the current directory gets its real path; once
  // --verbose was given, the commands leave it out and the tip says less.
  const elsewhere = renderDone({ verb: "install", plan: installPlan(), applied: [], failed: null, elapsed: 0 }, { caps: PLAIN, cwd: "/somewhere/else" });
  assert.ok(elsewhere.includes(`\n  npx projectstore-claude plan --project "${PROJECT}" --verbose\n`), elsewhere);
  const verbose = renderDone({ verb: "install", plan: installPlan(), applied: [], failed: null, elapsed: 0 }, { caps: PLAIN, cwd: PROJECT, verbose: true });
  assert.ok(verbose.endsWith('\n  To preview without writing:\n\n  npx projectstore-claude plan --project "$PWD"\n  npx projectstore-codex plan --project "$PWD"\n'), verbose);
  assert.ok(!verbose.includes("--verbose"), verbose);
  // After an uninstall a plan would preview the opposite of what ran: no tip.
  const gone = renderDone({ verb: "uninstall", plan: installPlan(), applied: [], failed: null, elapsed: 0 }, { caps: PLAIN, cwd: PROJECT });
  assert.ok(!gone.includes("preview") && !gone.includes("--verbose"), gone);
});

test("presentation STOPPED: a host command that ran keeps its exit status, and what it said beneath", () => {
  const p = installPlan();
  const failed = { step: "preflight", argv: ["codex", "plugin", "list", "--json"], status: 2, stderr: "boom" };
  const ran = renderDone({ verb: "install", plan: p, applied: [], failed, elapsed: 0 }, { caps: PLAIN });
  assert.ok(ran.includes("\n  ✕ $ codex plugin list --json exited 2\n      boom\n"), ran);
  // A record with no status and no word of how it ended is named by its
  // argv alone: its message stays whole beneath (the cases apply() records
  // are tests/codex-registration.test.mjs's).
  const quiet = renderDone({ verb: "install", plan: p, applied: [], failed: { ...failed, status: null, stderr: "first\nsecond" }, elapsed: 0 }, { caps: PLAIN });
  assert.ok(quiet.includes("\n  ✕ $ codex plugin list --json\n      first\n      second\n"), quiet);
});

test("presentation refusals: a plan-level refusal's message is in the attention role on every line it wraps to, as an item's refusal reason is", () => {
  const lines = SCREENS.find(([s]) => s === "plan-refused")[1](MODES.rich).split("\n");
  const at = lines.findIndex((l) => plain(l).includes("refused  two bindings:"));
  assert.ok(at > 0, lines.join("\n"));
  const block = lines.slice(at, lines.indexOf("", at));
  assert.ok(block.length > 1, "the message wraps at 80 live columns");
  for (const l of block) assert.match(l, /\x1b\[33m[^\x1b]+\x1b\[39m$/, JSON.stringify(l));
  // The item's refusal reason, above it, already reads so.
  assert.ok(lines.some((l) => l.includes("\x1b[33mthe file is not ours")));
});

test("presentation skipped vs unchanged: a current row the run leaves in place for a reason reads skipped, its reason beneath, and counts so; a current row with no reason reads unchanged and folds", () => {
  const kept = uninstallPlan();
  const text = renderPreview(kept, { verb: "uninstall", caps: PLAIN, home: HOME });
  assert.match(text, /\nPlan — 2 to remove · 1 skipped\n/);
  assert.match(text, /\n {2}· skipped {2}projectstore@projectstore-npx +plugin\n {6}user-global; an ordinary uninstall keeps it, and uninstall --global removes it\n/);
  assert.ok(!text.includes("unchanged"), text);
  const quiet = uninstallPlan();
  quiet.items[0].reason = null;
  const folded = renderPreview(quiet, { verb: "uninstall", caps: PLAIN, home: HOME });
  assert.match(folded, /\nPlan — 2 to remove · 1 unchanged\n/);
  assert.match(folded, /\n {2}· unchanged +plugin\n/);
  assert.ok(!folded.includes("projectstore@projectstore-npx  "), folded);
});

test("presentation bind: the binding as key–value lines, then each command alone on its line after a blank one; already bound points at status", () => {
  const p = { ok: true, refusals: [], state: "new", vault: "/v", configPath: "/p/.projectstore/projectstore.json", layout: "engineering", language: "en", ignored: [], keptKeys: [], before: null, buildsVault: false, scaffold: { ok: true, creates: 3 } };
  const text = renderBindPlan(p, {}, { env: {}, caps: PLAIN });
  assert.ok(text.includes("\n  vault_path  /v\n  layout      engineering\n  language    en\n"), text);
  assert.match(text, /\n\n {2}\/\S+scaffold\n {2}npx projectstore scaffold --write\n$/);
  const same = renderBindPlan({ ...p, state: "same", scaffold: { ok: true, creates: 0 } }, null, { env: {}, caps: PLAIN });
  assert.equal(same, "Already bound to /v.\n\nNext: see where the project stands:\n\n  npx projectstore status\n");
  // The terminal's form is the package the run was invoked as: a shell's own name through it.
  const shells = harnessIds().map((id) => loadHarness(id).install?.shell).filter(Boolean);
  for (const s of shells) assert.ok(renderBindPlan(p, {}, { env: { PROJECTSTORE_SHELL: s }, caps: PLAIN }).endsWith(`\n  npx ${s} scaffold --write\n`), s);
  // On a live terminal the prose wraps with a hanging indent of two; on a
  // pipe it stays one line; the commands stand alone in both.
  const live = renderBindPlan(bindPlan(), {}, { env: {}, caps: MODES["rich-no-colour"] });
  assert.ok(live.split("\n").every((l) => l.length <= 80), live);
  assert.ok(live.includes("\nNext: create the layout's missing folders and READMEs, in a session or from a\n  terminal:\n\n  /"), live);
  assert.ok(renderBindPlan(bindPlan(), {}, { env: {}, caps: MODES.plain }).includes("\nNext: create the layout's missing folders and READMEs, in a session or from a terminal:\n\n  /"));
  // A long line of a whole-vault bind wraps too, and its remedy keeps its indent.
  const failed = renderBindPlan({ ...bindPlan(), buildsVault: true }, { git: { failed: "a long reason why git init could not run in the vault directory at all", remedy: "Run git init yourself in the vault directory once the cause is fixed, then run bind again." }, scaffold: null }, { env: {}, caps: MODES["rich-no-colour"] });
  assert.ok(failed.split("\n").every((l) => l.length <= 80), failed);
  assert.ok(failed.includes("\ngit init failed: a long reason why git init could not run in the vault\n  directory at all\n  Run git init yourself in the vault directory once the cause is fixed, then\n    run bind again.\n"), failed);
});

test("presentation confirm: ◆ in the action role on a terminal, * with ASCII glyphs, and the words and keys of contract 9", async () => {
  const asked = [];
  for (const c of [MODES.rich, MODES.ascii]) await askApply(2, { ask: async (q) => { asked.push(q); return "n"; }, caps: c });
  assert.deepEqual(asked, ["\x1b[36m◆\x1b[39m \x1b[1mApply 2 changes?\x1b[22m \x1b[90m[Y/n]\x1b[39m ", "* Apply 2 changes? [Y/n] "]);
});

// ─── Criterion 6: doctor grouped by cause ─────────────────────────────
//
// report() over tests/fixtures/doctor-findings.json (this repository's
// findings, trimmed and anonymised) and over the committed --json capture of
// doctor --vault on the fixture vault (index, wikilink, spec-links, notes):
// both real doctor output.

const CAPTURED_VAULT = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "json-captures.json"), "utf8"))["doctor --vault"].stdout.result;
const NO_ENV = {};
const draw = (findings, c, { groups = DOCTOR_GROUPS, verbose = false } = {}) => report(findings, groups, { caps: c, verbose, version: VERSION, project: PROJECT, env: NO_ENV });
// An entry starts two spaces in with a level glyph and the [check] id.
const ENTRY = /^ {2}(✕|▲|·) \[([a-z0-9-]+)\] /;
const entryLines = (text) => text.split("\n").map((l, k) => [k, l.match(ENTRY)]).filter(([, m]) => m).map(([k, m]) => ({ at: k, glyph: m[1], check: m[2] }));
// The lines of the entry at `at`, up to the next entry, the next heading, or
// the blank line before it.
function entryBody(lines, at) {
  let end = at + 1;
  while (end < lines.length && !ENTRY.test(lines[end]) && !/^\S/.test(lines[end]) && !(lines[end] === "" && /^\S/.test(lines[end + 1] || ""))) end++;
  return lines.slice(at + 1, end);
}
const fixLines = (body) => body.filter((l) => /^ {4}fix: /.test(l));
const PREFIX = commandForm("doctor", { env: NO_ENV }).slice(0, -"doctor".length);

test("presentation doctor criterion 6: the badge, then each section's counts — issues, warnings, notes, each in its role — before any finding", () => {
  for (const mode of ["rich-no-colour", "plain", "ascii"]) {
    const text = doctorText(MODES[mode]);
    const lines = text.split("\n");
    const dot = mode === "ascii" ? "." : "·", dash = mode === "ascii" ? "-" : "—";
    assert.equal(lines[0], `projectstore doctor ${dot} ${VERSION} ${dot} shop`, mode);
    for (const g of DOCTOR_GROUPS) {
      const fs = DOCTOR_FINDINGS.filter((f) => f.group === g);
      const n = (l) => fs.filter((f) => f.level === l).length;
      const s = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
      const head = lines.indexOf(`${g.toUpperCase()} ${dash} ${s(n("issue"), "issue")} ${dot} ${s(n("warn"), "warning")} ${dot} ${s(n("info"), "note")}`);
      assert.ok(head > 0, `${mode} ${g}:\n${text}`);
      assert.equal(lines[head - 1], "", "a blank line before each section");
      assert.match(lines[head + 1], mode === "ascii" ? /^-{79}$/ : /^─{79}$/, "a rule beneath the counts");
      assert.match(lines[head + 2], /^ {2}\S/, "the section's first finding follows the rule");
    }
  }
  const plainLines = doctorText(MODES.plain).split("\n");
  assert.ok(plainLines.indexOf("INSTALL — 1 issue · 0 warnings · 2 notes") < plainLines.indexOf("VAULT — 8 issues · 3 warnings · 0 notes"));
  // Each count in its role: issues red, a zero count green, warnings yellow, notes dim.
  const rich = doctorText(MODES.rich);
  assert.ok(rich.includes("\x1b[1mINSTALL\x1b[22m — \x1b[31m1 issue\x1b[39m · \x1b[32m0 warnings\x1b[39m · \x1b[90m2 notes\x1b[39m\n"), rich);
  assert.ok(rich.includes("\x1b[1mVAULT\x1b[22m — \x1b[31m8 issues\x1b[39m · \x1b[33m3 warnings\x1b[39m · \x1b[90m0 notes\x1b[39m\n"), rich);
  // Issues before warnings, notes last, in every section.
  for (const mode of ["plain", "rich-no-colour"]) {
    for (const s of doctorText(MODES[mode]).split(/\n(?=[A-Z]+ — )/).slice(1)) {
      const order = entryLines(s).map((e) => "✕▲·".indexOf(e.glyph));
      assert.ok(order.length > 0);
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${mode}: ${order}`);
    }
  }
});

test("presentation doctor criterion 6: the six unresolved code_refs are one entry with one fix line — every instance listed, whole in plain, capture and path on a terminal", () => {
  const issues = DOCTOR_FINDINGS.filter((f) => f.check === "code-refs" && f.level === "issue");
  assert.equal(issues.length, 6, "the fixture keeps the six renamed-skill code_refs");
  const head = "  ✕ [code-refs] code_refs path does not resolve inside the project (6)";
  const capture = (f) => f.message.match(/"([^"]+)"/)[1];
  for (const mode of ["plain", "rich-no-colour"]) {
    const text = doctorText(MODES[mode]);
    const lines = text.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("  ✕ [code-refs]")).length, 1, `${mode}: one entry\n${text}`);
    const at = lines.indexOf(head);
    assert.ok(at > 0, `${mode}:\n${text}`);
    const body = entryBody(lines, at);
    assert.equal(fixLines(body).length, 1, `${mode}: one fix line\n${body.join("\n")}`);
    const listed = body.slice(0, body.findIndex((l) => /^ {4}fix: /.test(l)));
    if (mode === "plain") {
      assert.deepEqual(listed, issues.map((f) => `      ${f.message} — ${f.file}`), "each finding whole, with its path, one line each");
      assert.equal(fixLines(body)[0], "    fix: make each code_refs path exist in the project, and keep a story's paths inside its epic's.");
    } else {
      // On a terminal each instance is a row of its own glyph and its
      // capture; the path moved beneath when the row would pass 80 columns
      // (contract 5) reads `— <path>`, so it never passes for a capture.
      assert.deepEqual(listed, issues.flatMap((f) => [`      · ${capture(f)}`, `        — ${f.file}`]));
    }
  }
  // ASCII glyphs: the row's glyph and the moved path's dash from the table's ASCII column.
  const ascii = doctorText(MODES.ascii).split("\n");
  const asciiAt = ascii.indexOf("  x [code-refs] code_refs path does not resolve inside the project (6)");
  assert.deepEqual(ascii.slice(asciiAt + 1, asciiAt + 3), [`      . ${capture(issues[0])}`, `        - ${issues[0].file}`]);
  // At 120 columns the capture and the path share one aligned line.
  const wide = draw(DOCTOR_FINDINGS, { ...MODES["rich-no-colour"], width: 120, columns: 120 }).split("\n");
  const rows = wide.slice(wide.indexOf(head) + 1, wide.indexOf(head) + 7);
  assert.deepEqual(rows.map((l) => l.trim().split(/ {2,}/)), issues.map((f) => [`· ${capture(f)}`, f.file]));
  assert.equal(new Set(rows.map((l) => l.indexOf("epics/"))).size, 1, "the paths align");
  // A finding of the same check that the pattern does not match prints on its own, its message whole.
  const plainText = doctorText(MODES.plain);
  for (const f of DOCTOR_FINDINGS.filter((x) => x.check === "code-refs" && x.level === "warn")) assert.ok(plainText.includes(`\n  ▲ [code-refs] ${f.message} — ${f.file}\n`), f.message);
  // One match is no group: the message stays whole, and the fix still follows.
  const one = draw([issues[0]], MODES.plain, { groups: ["vault"] });
  assert.ok(one.includes(`\n  ✕ [code-refs] ${issues[0].message} — ${issues[0].file}\n    fix: `), one);
});

test("presentation doctor criterion 6: a fix line only for a check whose message carries no command, once per check and level; a command fix stands alone on its line", () => {
  // The table: the spec's nine fixing checks, no other.
  assert.deepEqual(Object.entries(CHECKS).filter(([, r]) => r.fix).map(([id]) => id).sort(), ["acceptance", "code-refs", "epic-status", "index", "index-header", "rel-link", "review-status", "spec-links", "wikilink"]);
  for (const [name, findings] of [["this repository", DOCTOR_FINDINGS], ["the fixture vault", CAPTURED_VAULT]]) {
    // No finding of a fixing check names a command; the command-carrying ones get none.
    for (const f of findings) if (CHECKS[f.check]?.fix) assert.ok(!f.message.includes(PREFIX), `${name}: ${f.check} carries a command: ${f.message}`);
    assert.ok(findings.some((f) => f.message.includes(PREFIX)), `${name}: a command-carrying finding is exercised`);
    for (const mode of ["plain", "rich-no-colour"]) {
      const text = draw(findings, MODES[mode]);
      const lines = text.split("\n");
      const entries = entryLines(text);
      const seen = new Map();
      entries.forEach((e, k) => {
        const fixes = fixLines(entryBody(lines, e.at)).length;
        if (!CHECKS[e.check]?.fix) { assert.equal(fixes, 0, `${name} ${mode}: [${e.check}] gets no second fix`); return; }
        // The fix follows the last entry of its check and level.
        const last = !entries.slice(k + 1).some((x) => x.check === e.check && x.glyph === e.glyph);
        assert.equal(fixes, last ? 1 : 0, `${name} ${mode}: [${e.check}] ${e.glyph}`);
        seen.set(`${e.check} ${e.glyph}`, (seen.get(`${e.check} ${e.glyph}`) || 0) + fixes);
      });
      assert.ok(seen.size > 0, `${name}: a fixing check is exercised`);
      for (const [key, n] of seen) assert.equal(n, 1, `${name} ${mode}: one fix for ${key}`);
    }
  }
  // The index fix is a command, composed for the listening harness: alone on
  // its line after a blank one, nothing after it (contract 6).
  const text = draw(CAPTURED_VAULT, MODES.plain, { groups: ["vault"] });
  assert.ok(text.includes("\n  ▲ [index] Artifact is not listed in its folder's README index (3)\n      adr/dup.md is not listed in adr/README.md's index. — adr/dup.md\n"), text);
  assert.ok(text.includes(`\n    fix: rebuild the folder indexes from frontmatter:\n\n      ${commandForm("reconcile", { env: NO_ENV })}\n\n`), text);
  const other = loadHarness("codex");
  const codexText = report(CAPTURED_VAULT, ["vault"], { caps: PLAIN, env: { PROJECTSTORE_HARNESS: other.id } });
  assert.ok(codexText.includes(`\n      ${invocation(other, "reconcile")}\n`), "the command is the listening harness's form");
  assert.ok(codexText.endsWith(`Repairs: ${invocation(other, "doctor", { args: "--fix" })} (install), ${invocation(other, "kanban")} / reconcile (vault).\n`), codexText);
});

test("presentation doctor criterion 6: on a terminal the folding rows' notes fold into one line while their section has an issue or a warning, and the instance list stops at eight; plain and --verbose print every note and instance", () => {
  const lines = (c, findings = DOCTOR_FINDINGS, opts) => draw(findings, c, opts).split("\n");
  const tty = lines(MODES["rich-no-colour"]);
  assert.ok(tty.includes("  1 note hidden · --verbose shows them"), tty.join("\n"));
  assert.ok(!tty.some((l) => l.includes("[mcp]")), "the MCP note folds");
  assert.ok(tty.some((l) => l.startsWith("  · [auto-update] ")), "a note of a row that does not fold stays");
  assert.ok(lines(MODES.ascii).includes("  1 note hidden . --verbose shows them"));
  for (const [name, text] of [["plain", lines(MODES.plain)], ["--verbose", lines(MODES["rich-no-colour"], DOCTOR_FINDINGS, { verbose: true })]]) {
    assert.ok(!text.some((l) => l.includes("hidden")), name);
    assert.ok(text.some((l) => l.startsWith("  · [mcp] MCP read tools registered")), name);
  }
  // A section of notes alone folds nothing.
  assert.ok(lines(MODES["rich-no-colour"], DOCTOR_FINDINGS.filter((f) => f.level === "info"), { groups: ["install"] }).some((l) => l.includes("[mcp]")));
  // The rows that fold: the spec's list, each for the notes it names.
  const folding = (check, message) => { const r = CHECKS[check]; return Boolean(r?.folds) && (r.folds === true || r.folds.test(message)); };
  assert.ok(folding("surface", ".projectstore/state/x/statusline.mjs — current, last written by /p/other."));
  assert.ok(!folding("surface", ".projectstore/state/x/statusline.mjs — not produced for this installation."), "a stale surface note does not fold");
  assert.ok(folding("statusline", "Base HUD present in your user settings.json — projectstore composes above it."));
  assert.ok(!folding("statusline", "statusLine wired manually (no statusline flag in projectstore.json) — the hook will leave it alone."));
  assert.ok(folding("plugin-registration", "projectstore@projectstore-npm 0.30.0 registered from the npm package for this project (loaded from /x); refresh with y."));
  assert.ok(!folding("plugin-registration", "No npm registration of projectstore for this project, and the host CLI is not on PATH."));
  for (const id of ["mcp", "harness", "spec-policy", "identity", "artifact-name"]) assert.ok(folding(id, "any"), id);
  assert.deepEqual(Object.entries(CHECKS).filter(([, r]) => r.folds).map(([id]) => id).sort(), ["artifact-name", "harness", "identity", "mcp", "plugin-registration", "spec-policy", "statusline", "surface"]);
  for (const id of OFFER_CHECKS) assert.ok(!CHECKS[id]?.folds, `the offer ${id} never folds`);
  // The fixture vault's two folding notes fold behind its issues.
  const vault = lines(MODES["rich-no-colour"], CAPTURED_VAULT, { groups: ["vault"] });
  assert.ok(vault.includes("  2 notes hidden · --verbose shows them") && vault.some((l) => l.includes("[graph]")), vault.join("\n"));
  // Eleven instances: eight, then +3 more, on a terminal; all of them elsewhere.
  const base = DOCTOR_FINDINGS.find((f) => f.check === "code-refs" && f.level === "issue");
  const many = Array.from({ length: 11 }, (_, k) => ({ ...base, message: base.message.replace(/"[^"]+"/, `"src/gone-${k}.mjs"`), file: `epics/PS-X/s${k}.md` }));
  const capped = lines(MODES["rich-no-colour"], many, { groups: ["vault"] });
  const shown = capped.filter((l) => /^ {6}· src\/gone-\d+\.mjs/.test(l));
  assert.deepEqual(shown.map((l) => l.trim().split(/ {2,}/)), Array.from({ length: 8 }, (_, k) => [`· src/gone-${k}.mjs`, `epics/PS-X/s${k}.md`]), "short enough to share a line");
  assert.equal(capped[capped.lastIndexOf(shown.at(-1)) + 1], "      +3 more", capped.join("\n"));
  for (const [name, text] of [["plain", lines(MODES.plain, many, { groups: ["vault"] })], ["--verbose", lines(MODES["rich-no-colour"], many, { groups: ["vault"], verbose: true })]]) {
    assert.ok(!text.some((l) => l.includes("more")), name);
    const joined = text.join("\n").replace(/\n {8}/g, " ");
    for (const f of many) assert.ok(joined.includes(`${f.message} — ${f.file}`), `${name}: ${f.message}`);
  }
});

test("presentation doctor criterion 6: plain prints every finding — its message whole on one line with its path — and a finding about another harness is never grouped", () => {
  for (const [name, findings] of [["this repository", DOCTOR_FINDINGS], ["the fixture vault", CAPTURED_VAULT]]) {
    const lines = draw(findings, MODES.plain).split("\n");
    for (const f of findings) assert.ok(lines.some((l) => l.includes(f.message) && (!f.file || l.includes(f.file))), `${name}: ${f.check} ${f.message}`);
    // Every finding keeps its [check] id, on its own line or its group's.
    for (const check of new Set(findings.map((f) => f.check))) assert.ok(lines.some((l) => ENTRY.test(l) && l.includes(`[${check}] `)), `${name}: [${check}]`);
  }
  // Two findings about another harness that the code_refs pattern matches:
  // each prints whole on its own, on a terminal too, so a filter that cuts a
  // finding out by its exact message finds it.
  const base = DOCTOR_FINDINGS.find((f) => f.check === "code-refs" && f.level === "issue");
  const about = [0, 1].map((k) => ({ ...base, about: "codex", message: base.message.replace(/"[^"]+"/, `"src/about-${k}.mjs"`) }));
  for (const c of [MODES.plain, { ...MODES["rich-no-colour"], width: 400, columns: 400 }]) {
    const text = draw(about, c, { groups: ["vault"] });
    assert.ok(!text.includes("(2)"), text);
    for (const f of about) assert.ok(text.includes(`\n  ✕ [code-refs] ${f.message} — ${f.file}\n`), text);
  }
});

test("presentation doctor criterion 6: the last line is the Summary line, verbatim, counted over every section; a clean section says so", () => {
  const want = `Summary: 9 issue(s), 3 warning(s). Repairs: ${commandForm("doctor", { args: "--fix", env: NO_ENV })} (install), ${commandForm("kanban", { env: NO_ENV })} / reconcile (vault).`;
  assert.equal(doctorSummaryLine(DOCTOR_FINDINGS, { env: NO_ENV }), want);
  for (const [mode, c] of Object.entries(MODES)) {
    for (const verbose of [false, true]) assert.ok(doctorText(c, { verbose }).endsWith(`\n\n${want}\n`), `${mode}${verbose ? " --verbose" : ""}: the Summary line is last, uncoloured`);
  }
  // One section asked for: its findings drawn, the Summary still over all it was given.
  const vaultOnly = draw(DOCTOR_FINDINGS, MODES.plain, { groups: ["vault"] });
  assert.ok(!vaultOnly.includes("INSTALL") && vaultOnly.endsWith(`${want}\n`));
  assert.equal(draw([], MODES.plain), `projectstore doctor · ${VERSION} · shop\n\nINSTALL — 0 issues · 0 warnings · 0 notes\n${"─".repeat(79)}\n  ✓ clean\n\nVAULT — 0 issues · 0 warnings · 0 notes\n${"─".repeat(79)}\n  ✓ clean\n\nSummary: 0 issue(s), 0 warning(s). Vault and wiring look healthy.\n`);
  // Without a version or a project the badge says what it knows.
  assert.ok(report([], ["vault"], { env: NO_ENV }).startsWith("projectstore doctor\n\nVAULT"));
});

test("presentation doctor: wrapped on a terminal at any width, a finding's path keeps its dash on its line; a note draws the info glyph", () => {
  const withFile = [...DOCTOR_FINDINGS, ...CAPTURED_VAULT].filter((f) => f.file);
  let moved = 0;
  for (const width of [40, 48, 56, 64, 72, 80, 96, 120]) {
    for (const [ascii, dash] of [[false, "—"], [true, "-"]]) {
      for (const verbose of [false, true]) {
        const c = { ...MODES["rich-no-colour"], width, columns: width, ascii };
        const lines = draw([...DOCTOR_FINDINGS, ...CAPTURED_VAULT], c, { verbose }).split("\n");
        // A line never ends in the path's dash with the path alone below it.
        lines.forEach((l, k) => { if (l.endsWith(` ${dash}`) && k + 1 < lines.length) assert.ok(!withFile.some((f) => lines[k + 1].trim() === f.file), `${width} ${verbose}: "${l}" / "${lines[k + 1]}"`); });
        // Every finding's path is on a line with its dash before it, unless a
        // compact instance row carries it (its note column, or its target when
        // the pattern captures nothing) or its note folded.
        const dot = ascii ? "." : "·";
        for (const f of withFile) {
          if (!verbose && f.level === "info" && CHECKS[f.check]?.folds) continue;
          assert.ok(lines.some((l) => l.includes(`${dash} ${f.file}`)) || (!verbose && lines.some((l) => l.startsWith(`      ${dot} `) && l.trimEnd().endsWith(` ${f.file}`))), `${width} ${ascii} ${verbose}: ${f.file}`);
        }
        moved += lines.filter((l) => new RegExp(`^ +\\${dash} \\S`).test(l)).length;
      }
    }
  }
  assert.ok(moved > 0, "some width moves a path to a line of its own, dash first");
  // The note glyph is the table's, by its own name.
  assert.equal(GLYPH_ALIASES.info, "dot");
  assert.ok(doctorText(MODES.plain).includes(`\n  ${icon(PLAIN, "info")} [auto-update] `));
  assert.ok(doctorText(MODES.ascii).includes(`\n  ${icon(MODES.ascii, "info")} [auto-update] `) && icon(MODES.ascii, "info") === ".");
});

// ─── status (contract 12) ─────────────────────────────────────────────

test("presentation status: +N more is the stories counted less those listed, and points at the kanban view; a start is a date in the reader's zone; unbound names the bind command, alone on its line", () => {
  const r = statusResult();
  const text = renderStatus(r, { caps: PLAIN, env: {} });
  assert.ok(text.includes(`\n  +2 more — see ${r.views.kanban.path}\n`), text);
  // Every story listed sits under its epic, in the order status() gave, its path on its row.
  for (const s of r.stories.in_progress) assert.ok(text.split(`\n  ${s.epic}\n`)[1].split(/\n {2}\S/)[0].includes(` ${s.title}  `) && text.includes(` ${s.path}\n`), s.path);
  assert.deepEqual(text.split("\n").filter((l) => /^ {2}[A-Z]/.test(l)), ["  SHOP-PAY", "  SHOP-CART"], "one heading per epic, in first-listed order");
  // All listed: no more line. A kanban view with another path is named by it.
  const all = { ...r, stories: { ...r.stories, in_progress_total: r.stories.in_progress.length } };
  assert.ok(!renderStatus(all, { caps: PLAIN, env: {} }).includes("more"));
  const moved = { ...r, views: { ...r.views, kanban: { ...r.views.kanban, path: "boards/kanban.md" } } };
  assert.ok(renderStatus(moved, { caps: PLAIN, env: {} }).includes("\n  +2 more — see boards/kanban.md\n"));
  // A timestamp reads as its date where the reader is; a date stays as written.
  const at = new Date(2026, 9, 10, 23, 30);
  const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  assert.equal(startDate(at.toISOString()), local);
  assert.equal(startDate("2026-02-02"), "2026-02-02");
  assert.equal(startDate("soon"), "soon");
  // Unbound: the project, then each form of the bind command alone on its line after a blank one.
  const unbound = renderStatus({ bound: false, project: PROJECT }, { caps: PLAIN, env: {} });
  assert.equal(unbound, `Not bound — ${PROJECT}\n\nNext: bind it to a vault, in a session or from a terminal:\n\n  ${commandForm("bind", { args: "<vault>", env: {} })}\n  npx projectstore bind <vault>\n`);
  // The terminal's form is the package the run was invoked as: a shell's own name through it.
  for (const s of harnessIds().map((id) => loadHarness(id).install?.shell).filter(Boolean)) assert.ok(renderStatus({ bound: false, project: PROJECT }, { caps: PLAIN, env: { PROJECTSTORE_SHELL: s } }).endsWith(`\n  npx ${s} bind <vault>\n`), s);
  // A view stale or missing wants a reconcile: both in the attention role; fresh is done's.
  const rich = renderStatus(r, { caps: MODES.rich, env: {} });
  assert.ok(rich.includes("kanban.md \x1b[33mstale\x1b[39m") && rich.includes("code-map.md \x1b[33mmissing\x1b[39m") && rich.includes("graph.md \x1b[32mfresh\x1b[39m"), rich);
  // A vault whose directory is gone says so on its line, with the attention glyph.
  const gone = renderStatus({ ...r, vault_exists: false, spec_policy: null, lifecycle_gates: null, stories: null, views: null, sessions: null }, { caps: PLAIN, env: {} });
  assert.ok(gone.includes(`\n  vault_path     ${r.vault_path}  ▲ missing\n`) && !gone.includes("spec_policy"), gone);
});

test("presentation status on a terminal: a long title wraps at its spaces under itself, its path beneath at the same column; a counts line breaks only between counts, never between a number and its word", () => {
  const r = statusResult();
  const long = r.stories.in_progress.find((s) => s.title.length > 100);
  assert.ok(long, "the fixture carries a title longer than the terminal");
  for (const width of [48, 60, 80, 100]) {
    const c = { ...MODES["rich-no-colour"], width, columns: width };
    const lines = renderStatus(r, { caps: c, env: {} }).split("\n");
    // The title: its first line after the date, the rest at the title column, each within the row; the path beneath, at that column.
    const at = lines.findIndex((l) => l.includes(long.title.split(" ").slice(0, 3).join(" ")));
    const col = lines[at].indexOf("A cart");
    const end = lines.findIndex((l, k) => k > at && l.trim() === long.path);
    assert.ok(end > at, `${width}: the path beneath its title\n${lines.join("\n")}`);
    assert.equal(lines[end].indexOf(long.path), col, `${width}: the path at the title column`);
    const title = lines.slice(at, end);
    assert.equal(title.map((l, k) => (k ? l : l.slice(col)).trim()).join(" "), long.title, `${width}: the title whole, broken only at spaces`);
    title.forEach((l, k) => { assert.ok(l.length <= width - 1, `${width}: "${l}"`); if (k) assert.equal(l.length - l.trimStart().length, col, `${width}: "${l}"`); });
    // The counts: no line of the Stories or Views heading ends in a bare number or starts with a word parted from its number.
    for (const name of ["Stories", "Views"]) {
      const h = lines.findIndex((l) => l.startsWith(`${name} — `));
      const next = lines.findIndex((l, k) => k > h && !/^ {2}\S/.test(l));
      const block = lines.slice(h, next);
      for (const l of block) assert.ok(!/(^|\s)\d+$/.test(l) && (l === block[0] || /^ {2}(\d|\S+\.md )/.test(l)), `${width} ${name}: "${l}"`);
      if (name === "Stories" && width === 80) assert.deepEqual(block, ["Stories — 23 on the board · 12 done · 7 in-progress · 3 planned · 1 review ·", "  1 off the board (not_actionable 1)"]);
    }
  }
  // On a pipe the title is one row, whole, with its path.
  assert.ok(renderStatus(r, { caps: PLAIN, env: {} }).includes(`  ${long.title}  ${long.path}\n`));
});

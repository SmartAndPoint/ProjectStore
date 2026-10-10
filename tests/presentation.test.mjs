// projectstore — the install family's and bind's screens (PS-HARNESS: "The
// CLI's output is designed: grouped plans, a question rail, one glyph set,
// doctor grouped by cause"; the covering spec *Terminal presentation of the
// projectstore CLI: layout, glyphs, colour roles, questions and live lines*,
// contracts 2–8 and Testing).
//
// Golden screens — PLAN (two harness groups, an upgrade, an uninstall, a
// refusal), the confirm, APPLY, DONE, STOPPED and bind's plan — in four modes
// at 80 columns, rendered from tests/fixtures/presentation.mjs with injected
// caps and clocks; the equivalence between modes; the ASCII scan; and one
// test per acceptance criterion this part of the story closes (1, 2, 3, 7,
// part of 8, 9), on real plans where the criterion is about what plan()
// produces.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/presentation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SCREENS, MODES, DIR, goldenPath, renderAll, installPlan, uninstallPlan, bindPlan, HOME, PROJECT } from "./fixtures/presentation.mjs";
import { installedTree } from "./fixtures/json-captures.mjs";
import { fakePackageRoot, fakeClaude, noHostEnv } from "./fixtures/install.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { plan, renderPreview, renderDone, applyReporter } from "../scripts/install-harness.mjs";
import { renderBindPlan } from "../scripts/binding.mjs";
import { caps, plain, PLAIN, askApply } from "../scripts/term.mjs";
import { loadHarness, sourceHarness } from "../scripts/harness.mjs";

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
  return at.includes(indentOf(line)) && prev.length + 1 + body.split(" ")[0].length > COLUMNS - 2;
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
  for (const [screen, render] of SCREENS) {
    const rich = await render(MODES.rich), bare = await render(MODES["rich-no-colour"]), piped = await render(MODES.plain);
    assert.equal(plain(rich), bare, `${screen}: colour is the only difference`);
    assert.equal(transform(piped), transform(bare), `${screen}: plain is rich-no-colour less its live frames, questions and wrapping`);
    if (screen !== "confirm") assert.ok(transform(piped).length > 0, `${screen} is not empty`);
  }
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

test("presentation ASCII: the ascii goldens hold no code point above 0x7E; no golden but rich holds SGR", async () => {
  for (const [screen, mode, text] of await renderAll()) {
    if (mode === "ascii") assert.deepEqual(nonAscii(text), [], `${screen}.ascii: ${JSON.stringify(nonAscii(text))}`);
    if (mode === "rich") assert.ok(SGR.test(text), `${screen}.rich is painted`);
    else assert.ok(!SGR.test(text), `${screen}.${mode} carries no SGR`);
  }
});

test("presentation ASCII: under TERM=dumb or PROJECTSTORE_ASCII, on a TTY and on a pipe, every glyph and separator is ASCII; NO_COLOR leaves no SGR", async () => {
  const modes = {
    "TERM=dumb, TTY": caps(tty(), { TERM: "dumb" }),
    "TERM=dumb, pipe": caps({}, { TERM: "dumb" }),
    "PROJECTSTORE_ASCII, TTY": caps(tty(), { PROJECTSTORE_ASCII: "1" }),
    "PROJECTSTORE_ASCII, pipe": caps({}, { PROJECTSTORE_ASCII: "1" }),
  };
  for (const [name, c] of Object.entries(modes)) {
    for (const [screen, render] of SCREENS) {
      const text = await render(c);
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

test("presentation F1: a current row the run leaves in place for a reason reads skipped, its reason beneath, and counts so; a current row with no reason reads unchanged and folds", () => {
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
  assert.match(text, /\n\n {2}\/\S+scaffold\n {2}projectstore scaffold --write\n$/);
  const same = renderBindPlan({ ...p, state: "same", scaffold: { ok: true, creates: 0 } }, null, { env: {}, caps: PLAIN });
  assert.equal(same, "Already bound to /v.\n\nNext: see where the project stands:\n\n  projectstore status\n");
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

// projectstore — tests for term.mjs: the terminal presentation the write verbs
// use (install spec, contract 18). Colour and in-place lines are for a person
// at a terminal; a pipe — an agent's tool call, CI — gets the same layout as
// plain text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { caps, painter, icon, duration, plain, stepReporter, liveLine, wrap, askLine, askApply, GLYPHS, GLYPH_ALIASES, ROLES, badge, heading, rows, rule, kv, commandBlock } from "../scripts/term.mjs";
import { runtimeFiles, stripComments } from "./fixtures/vocabulary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tty = (columns = 80) => ({ isTTY: true, columns });
const sink = (base = {}) => {
  const chunks = [];
  return { chunks, stream: { ...base, write: (s) => { chunks.push(String(s)); return true; } } };
};

test("term: colour follows the terminal, NO_COLOR and FORCE_COLOR; a dumb terminal gets ASCII", () => {
  assert.equal(caps(tty(), {}).color, true, "a terminal");
  assert.equal(caps({}, {}).color, false, "a pipe");
  assert.equal(caps(tty(), { NO_COLOR: "1" }).color, false, "NO_COLOR");
  assert.equal(caps(tty(), { NO_COLOR: "" }).color, true, "an empty NO_COLOR is not set (no-color.org)");
  for (const v of ["", "1", "2", "3", "true"]) assert.equal(caps({}, { FORCE_COLOR: v }).color, true, `FORCE_COLOR=${v} colours a pipe`);
  for (const v of ["0", "false"]) assert.equal(caps(tty(), { FORCE_COLOR: v }).color, false, `FORCE_COLOR=${v} turns a terminal plain`);
  assert.equal(caps(tty(), { NO_COLOR: "1", FORCE_COLOR: "1" }).color, true, "FORCE_COLOR decides when it is set");
  const dumb = caps(tty(), { TERM: "dumb" });
  assert.deepEqual([dumb.color, dumb.live, dumb.ascii], [false, false, true]);
  assert.equal(icon(dumb, "ok"), "ok");
  assert.equal(icon(caps(tty(), {}), "ok"), "✓");
  assert.equal(caps(tty(300), {}).width, 120, "wide terminals are capped");
  assert.equal(caps(tty(20), {}).width, 40, "narrow ones are floored");
  assert.equal(caps({}, {}).width, 100, "a pipe has no width; 100 is assumed");
});

test("term: paint is a no-op without colour and wraps SGR with it; plain strips it again", () => {
  assert.equal(painter({ color: false })("green", "ok"), "ok");
  const green = painter({ color: true })("green", "ok");
  assert.equal(green, "\x1b[32mok\x1b[39m");
  assert.equal(plain(green), "ok");
  assert.equal(painter({ color: true })("nope", "ok"), "ok", "an unknown style is plain");
});

test("term: durations read as a person would say them", () => {
  assert.equal(duration(0), "0.0s");
  assert.equal(duration(412), "0.4s");
  assert.equal(duration(9_949), "9.9s");
  assert.equal(duration(12_400), "12s");
  assert.equal(duration(63_000), "1m 03s");
});

test("term: a step is one line — rewritten in place on a terminal, written once when finished anywhere else", () => {
  const live = sink(tty());
  const r = stepReporter(live.stream, caps(live.stream, {}));
  r.start("shared AGENTS.md");
  assert.equal(live.chunks.length, 1);
  assert.ok(plain(live.chunks[0]).startsWith("  … shared AGENTS.md"), "the running line ends nowhere: it is rewritten");
  assert.ok(!live.chunks[0].endsWith("\n"));
  r.end(true);
  assert.ok(live.chunks[1].startsWith("\r\x1b[2K"), "the finished line replaces the running one");
  assert.match(plain(live.chunks[1]), /✓ shared AGENTS\.md +\d+\.\ds\n$/);

  const piped = sink();
  const q = stepReporter(piped.stream, caps(piped.stream, {}));
  q.start("shared AGENTS.md");
  assert.equal(piped.chunks.length, 0, "nothing until the step finishes");
  q.end(false, "skipped");
  assert.equal(piped.chunks.length, 1);
  assert.ok(!piped.chunks[0].includes("\x1b"), "no escapes into a pipe");
  assert.match(piped.chunks[0], /^ {2}✕ shared AGENTS\.md +skipped {2}\d+\.\ds\n$/);
  q.end(true);
  assert.equal(piped.chunks.length, 1, "an end without a start writes nothing");
});

test("term: a live label fits one row, a nested start closes the open line, abort ends it as failed", () => {
  const live = sink(tty(40));
  const r = stepReporter(live.stream, caps(live.stream, {}), { indent: 6 });
  const long = "$ claude plugin marketplace add /a/very/long/path/that/would/wrap/the/row";
  r.start(long);
  assert.ok(plain(live.chunks[0]).length <= 39, plain(live.chunks[0]));
  // The running mark is "…" too, so the cut is pinned where it is: the label's
  // end, in the room the row leaves (39 − 6 − mark − 2 spaces − 1).
  assert.equal(plain(live.chunks[0]), `      … ${long.slice(0, 29)}… `, "cut at the row, and marked as cut");
  r.start("$ claude plugin install x");
  assert.equal(live.chunks[1], "\n", "the open line is closed where it stands, not overwritten");
  r.abort();
  assert.match(plain(live.chunks.at(-1)), /✕ \$ claude plugin install x/);
  r.abort();
  const n = live.chunks.length;
  r.abort();
  assert.equal(live.chunks.length, n, "abort with nothing open writes nothing");
});

test("term: wrap breaks prose at spaces with a hanging indent and never breaks a word", () => {
  const text = "the surfaces below are planned against the host's install path /Users/someone/.claude/plugins/cache/projectstore-npx/projectstore/0.29.0, not this package";
  const lines = wrap(text, 60, "    ").split("\n");
  assert.ok(lines.length > 1);
  for (const l of lines.slice(1)) assert.ok(l.startsWith("    "), l);
  assert.ok(lines.some((l) => l.includes("/Users/someone/.claude/plugins/cache/projectstore-npx/projectstore/0.29.0,")), "the path is one word");
  assert.equal(lines.join(" ").replace(/ +/g, " "), text, "nothing is lost");
  assert.equal(wrap("short", 60, "  "), "short");
  assert.equal(wrap(text, 0, "    "), text, "width 0 — not a terminal — breaks nothing");
});

test("term: askLine reads one line in line mode — Enter is an empty answer, end of input is null, nothing but the question is written", async () => {
  const ask = async (feed) => {
    const input = new PassThrough(), output = new PassThrough();
    let written = "";
    output.on("data", (d) => { written += d; });
    const pending = askLine("Apply 3 changes? [Y/n] ", input, output);
    feed(input);
    return { answer: await pending, written };
  };
  assert.deepEqual(await ask((i) => i.write("\n")), { answer: "", written: "Apply 3 changes? [Y/n] " });
  assert.equal((await ask((i) => i.write("n\n"))).answer, "n");
  const eof = await ask((i) => i.end());
  assert.equal(eof.answer, null, "end of input (Ctrl+D) is null — a no — and the promise settles");
  assert.equal(eof.written, "Apply 3 changes? [Y/n] \n", "and the question's line is ended, so the next message starts on its own");
  assert.equal((await ask((i) => { i.write("ye"); i.end(); })).answer, null, "a half-typed answer cut by end of input is not an answer");
});

test("term: askApply is contract 9's one question — its bytes, singular and plural, Enter/y/yes apply, anything else and end of input do not", async () => {
  const asked = [];
  const via = (answer, n = 3, c) => askApply(n, { ask: async (q) => { asked.push(q); return answer; }, ...(c ? { caps: c } : {}) });
  for (const yes of ["", "y", "Y", "yes", "YES", "  yes  "]) assert.equal(await via(yes), true, JSON.stringify(yes));
  for (const no of ["n", "no", "nope", "yess", "x"]) assert.equal(await via(no), false, JSON.stringify(no));
  for (const eof of [null, undefined]) assert.equal(await via(eof), false, `${eof} is end of input`);
  assert.equal(asked[0], "◆ Apply 3 changes? [Y/n] ", "without caps: unpainted, the Unicode question glyph");
  await via("", 1);
  assert.equal(asked.at(-1), "◆ Apply 1 change? [Y/n] ");
  // Through a stream, as at a terminal: the question is all that is written, and end of input is a no.
  const input = new PassThrough(), output = new PassThrough();
  let written = "";
  output.on("data", (d) => { written += d; });
  const pending = askApply(4, { stdin: input, stdout: output });
  input.end();
  assert.equal(await pending, false);
  assert.equal(written, "◆ Apply 4 changes? [Y/n] \n");
});

// Presentation spec contract 8: only the look changes — the question glyph in
// the action role, the question in emphasis, the keys in explanation — and
// the glyph follows the glyph switch, not the colour.
test("term: the confirm's exact bytes — rich, rich without colour, plain, and ASCII with and without colour", async () => {
  const bytes = async (c) => { let q = null; await askApply(2, { ask: async (x) => { q = x; return ""; }, caps: c }); return q; };
  const RICH = "\x1b[36m◆\x1b[39m \x1b[1mApply 2 changes?\x1b[22m \x1b[90m[Y/n]\x1b[39m ";
  assert.equal(await bytes(caps(tty(), {})), RICH, "rich: ◆ in the action role (cyan), a bold question, grey keys");
  assert.equal(await bytes(caps(tty(), { NO_COLOR: "1" })), "◆ Apply 2 changes? [Y/n] ", "rich, no colour");
  assert.equal(await bytes(caps({}, {})), "◆ Apply 2 changes? [Y/n] ", "plain: a pipe, unpainted, Unicode");
  assert.equal(await bytes(caps(tty(), { PROJECTSTORE_ASCII: "1" })), RICH.replace("◆", "*"), "PROJECTSTORE_ASCII changes the glyph and keeps the colour");
  assert.equal(await bytes(caps(tty(), { TERM: "dumb" })), "* Apply 2 changes? [Y/n] ", "TERM=dumb: ASCII and no colour");
  assert.equal(await bytes(caps({}, { PROJECTSTORE_ASCII: "1" })), "* Apply 2 changes? [Y/n] ", "ASCII on a pipe");
});

// ─── The live line (presentation spec contract 8, its asynchronous part) ──

// A clock and timers the test advances by hand: every handle records whether
// it was unref'd, and `pending` is what a forgotten line would leave behind.
function fakeClock() {
  let t = 0, seq = 0;
  const live = new Map();
  const add = (fn, ms, every) => { const h = { id: ++seq, at: t + ms, fn, every, unrefd: false, unref() { this.unrefd = true; return this; } }; live.set(h.id, h); return h; };
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearTimeout: (h) => { if (h) live.delete(h.id); },
      clearInterval: (h) => { if (h) live.delete(h.id); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...live.values()].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at;
        if (next.every) next.at += next.every; else live.delete(next.id);
        next.fn();
      }
      t = end;
    },
    pending: () => live.size,
    handles: () => [...live.values()],
  };
}
const LABEL = "fetching projectstore-codex@0.30.0 for Codex";

test("term: the live line is quiet for 300 ms, then braille frames every 80 ms with the elapsed time, redrawn in place on one row; end replaces it with one finished line and leaves no timer", () => {
  const k = fakeClock();
  const { chunks, stream } = sink(tty(80));
  const c = caps(stream, { NO_COLOR: "1" });
  const line = liveLine(stream, c, LABEL, { env: {}, now: k.now, timers: k.timers });
  k.advance(299);
  assert.deepEqual(chunks, [], "nothing before 300 ms");
  k.advance(1);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].startsWith("\r\x1b[2K  ⠋ " + LABEL), JSON.stringify(chunks[0]));
  assert.ok(chunks[0].endsWith("0.3s"), "the elapsed time, right-aligned");
  k.advance(80);
  k.advance(80);
  assert.equal(chunks.length, 3, "a frame every 80 ms");
  const ERASE = "\r\x1b[2K";
  assert.deepEqual(chunks.map((s) => s.slice(ERASE.length + 2, ERASE.length + 3)), ["⠋", "⠙", "⠹"]);
  assert.ok(chunks[2].endsWith("0.5s"));
  for (const s of chunks) {
    assert.ok(!s.includes("\n") && plain(s.slice(ERASE.length)).length < 80, "one physical row, redrawn in place");
  }
  assert.ok(k.handles().every((h) => h.unrefd), "a forgotten line never holds the process");
  line.end(true, "fetched projectstore-codex@0.30.0 for Codex");
  assert.equal(k.pending(), 0, "no timer remains");
  const last = chunks.at(-1);
  assert.ok(last.startsWith("\r\x1b[2K  ✓ fetched projectstore-codex@0.30.0 for Codex "), JSON.stringify(last));
  assert.ok(last.endsWith(" 0.5s\n"));
  k.advance(1000);
  assert.equal(chunks.length, 4, "nothing after the end");
  line.end(false);
  assert.equal(chunks.length, 4, "a second end is a no-op");
  // A label longer than the row is cut to it.
  const narrow = sink(tty(40));
  const k2 = fakeClock();
  liveLine(narrow.stream, caps(narrow.stream, { NO_COLOR: "1" }), "x".repeat(200), { env: {}, now: k2.now, timers: k2.timers });
  k2.advance(300);
  assert.ok(plain(narrow.chunks[0].slice(ERASE.length)).length <= 39, narrow.chunks[0]);
});

test("term: the live line under ASCII glyphs shows ... and the elapsed time; under PROJECTSTORE_NO_ANIMATION … then the finished line; on a pipe one finished line and no escape; abort clears it", () => {
  const ascii = { color: false, live: true, width: 80, columns: 80, ascii: true };
  const k = fakeClock();
  const a = sink(tty(80));
  const line = liveLine(a.stream, ascii, LABEL, { env: {}, now: k.now, timers: k.timers });
  k.advance(460);
  assert.ok(a.chunks.length >= 2);
  for (const s of a.chunks) {
    assert.ok(s.startsWith("\r\x1b[2K  ... " + LABEL), JSON.stringify(s));
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s), "no frame");
  }
  assert.ok(a.chunks.at(-1).endsWith("0.5s"));
  line.end(false, "fetch failed projectstore-codex@0.30.0", "ETARGET");
  assert.ok(a.chunks.at(-1).startsWith("\r\x1b[2K  x fetch failed projectstore-codex@0.30.0 "), a.chunks.at(-1));
  assert.ok(a.chunks.at(-1).endsWith("ETARGET  0.5s\n"));
  assert.equal(k.pending(), 0);
  // PROJECTSTORE_NO_ANIMATION: the "…" line at once, no frame, no timer, then the finished line.
  const q = fakeClock();
  const n = sink(tty(80));
  const still = liveLine(n.stream, caps(n.stream, { NO_COLOR: "1" }), LABEL, { env: { PROJECTSTORE_NO_ANIMATION: "1" }, now: q.now, timers: q.timers });
  assert.equal(n.chunks.length, 1);
  assert.ok(n.chunks[0].startsWith("  … " + LABEL) && !n.chunks[0].includes("\n"), JSON.stringify(n.chunks[0]));
  assert.equal(q.pending(), 0, "no timer is ever set");
  q.advance(1500);
  assert.equal(n.chunks.length, 1, "no frame");
  still.end(true, "fetched projectstore-codex@0.30.0 for Codex");
  assert.ok(n.chunks[1].startsWith("\r\x1b[2K  ✓ fetched") && n.chunks[1].endsWith("1.5s\n"));
  // A pipe: exactly one finished line and no escape, however long it ran.
  const r = fakeClock();
  const p = sink({});
  const piped = liveLine(p.stream, caps(p.stream, {}), LABEL, { env: {}, now: r.now, timers: r.timers });
  r.advance(5000);
  piped.end(true, "fetched projectstore-codex@0.30.0 for Codex");
  assert.equal(p.chunks.length, 1);
  assert.ok(!p.chunks[0].includes("\x1b") && p.chunks[0].startsWith("  ✓ fetched projectstore-codex@0.30.0 for Codex ") && p.chunks[0].endsWith(" 5.0s\n"), JSON.stringify(p.chunks[0]));
  assert.equal(r.pending(), 0);
  // abort: the timers go, and the drawn row is cleared.
  const z = fakeClock();
  const b = sink(tty(80));
  const gone = liveLine(b.stream, caps(b.stream, { NO_COLOR: "1" }), LABEL, { env: {}, now: z.now, timers: z.timers });
  z.advance(400);
  gone.abort();
  assert.equal(z.pending(), 0, "no timer remains after abort");
  assert.equal(b.chunks.at(-1), "\r\x1b[2K");
  const quietAbort = fakeClock();
  liveLine(b.stream, caps(b.stream, { NO_COLOR: "1" }), LABEL, { env: {}, now: quietAbort.now, timers: quietAbort.timers }).abort();
  assert.equal(quietAbort.pending(), 0, "an abort before 300 ms leaves no timer either");
  assert.equal(icon({ ascii: false }, "fetch"), "↓");
  assert.equal(icon({ ascii: true }, "fetch"), "v");
});

// ─── The glyph table, colour roles and layout primitives (presentation spec
// contracts 2–6; the story "The CLI's output is designed…", its term.mjs
// decomposition item) ──────────────────────────────────────────────────────

const SGR_RE = /\x1b\[[0-9;]*m/;

test("term: the glyph table is the spec's contract 4, both columns; every ASCII cell is printable ASCII and every Unicode glyph one code point", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, [...v]])), {
    ok: ["✓", "ok"], add: ["+", "+"], fail: ["✕", "x"], update: ["↻", "~"],
    warning: ["▲", "!"], switch: ["⇄", "<>"], unchanged: ["·", "."], remove: ["−", "-"],
    fetch: ["↓", "v"], running: ["…", "..."], ask: ["◆", "*"], answered: ["◇", "o"],
    choiceOn: ["●", "(*)"], choiceOff: ["○", "( )"], checkOn: ["◼", "[x]"], checkOff: ["◻", "[ ]"],
    rail: ["│", "|"], railTop: ["┌", "+"], railEnd: ["└", "+"], rule: ["─", "-"],
    progressDone: ["━", "#"], progressLeft: ["╺", "-"], dash: ["—", "-"], dot: ["·", "."],
    transition: ["→", "->"],
  });
  for (const [name, [uni, ascii]] of Object.entries(GLYPHS)) {
    assert.match(ascii, /^[\x20-\x7e]+$/, `${name}: the ASCII column is ASCII`);
    assert.equal([...uni].length, 1, `${name}: one code point`);
    assert.equal(icon({ ascii: false }, name), uni);
    assert.equal(icon({ ascii: true }, name), ascii);
  }
  // The shared rows of the spec's table and the plan's action names resolve to a glyph of the table.
  for (const [alias, name] of Object.entries(GLYPH_ALIASES)) {
    assert.ok(GLYPHS[name], `${alias} → ${name} is in the table`);
    assert.equal(icon({ ascii: true }, alias), GLYPHS[name][1]);
  }
  assert.deepEqual([icon({}, "issue"), icon({}, "refuse"), icon({}, "note"), icon({}, "skip"), icon({}, "cleanup"), icon({}, "create")], ["✕", "▲", "▲", "·", "−", "+"]);
  assert.equal(icon({ ascii: false }, "no-such-glyph"), "↻", "an unknown name draws the update glyph, as before");
});

test("term: PROJECTSTORE_ASCII set non-empty switches glyphs only — colour, live lines and the width follow the stream; TERM=dumb switches both", () => {
  const a = caps(tty(), { PROJECTSTORE_ASCII: "1" });
  assert.deepEqual([a.ascii, a.color, a.live, a.width], [true, true, true, 80]);
  assert.equal(caps(tty(), { PROJECTSTORE_ASCII: "" }).ascii, false, "an empty value is not set");
  assert.equal(caps(tty(), {}).ascii, false);
  assert.equal(caps({}, { PROJECTSTORE_ASCII: "yes" }).ascii, true, "on a pipe as well");
  const dumb = caps(tty(), { TERM: "dumb" });
  assert.deepEqual([dumb.ascii, dumb.color, dumb.live], [true, false, false]);
  assert.equal(icon(a, "ok"), "ok");
  assert.equal(icon(a, "fail"), "x");
});

test("term: the colour roles are fixed and paint with the sixteen ANSI colours, bold and dim only", () => {
  assert.deepEqual({ ...ROLES }, { action: "cyan", done: "green", attention: "yellow", error: "red", explanation: "gray", emphasis: "bold" });
  const paint = painter({ color: true });
  for (const [role, style] of Object.entries(ROLES)) {
    assert.equal(paint(role, "x"), paint(style, "x"), `${role} paints as ${style}`);
    const [, open] = paint(role, "x").match(/^\x1b\[(\d+)m/);
    const n = Number(open);
    assert.ok(n === 1 || n === 2 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97), `${role}: SGR ${n}`);
  }
  assert.equal(paint("done", "ok"), "\x1b[32mok\x1b[39m");
  assert.equal(painter({ color: false })("error", "x"), "x");
  assert.equal(paint(null, "x"), "x", "no role paints nothing");
});

test("term: badge, heading, rule, key–value and the command block — each mode's text", () => {
  const rich = caps(tty(), {}), bare = caps(tty(), { NO_COLOR: "1" }), ascii = caps(tty(), { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" });
  assert.equal(badge(bare, "projectstore install", ["Claude Code, Codex"]), "projectstore install · Claude Code, Codex");
  assert.equal(badge(ascii, "projectstore install", ["Claude Code, Codex"]), "projectstore install . Claude Code, Codex");
  assert.equal(badge(rich, "projectstore doctor", ["v0.30.0", null, "", "front-door"]), "\x1b[1mprojectstore doctor\x1b[22m · v0.30.0 · front-door", "the head in emphasis; empty parts are left out");
  const counts = [["3 to add", "done"], ["1 to update", "action"], "5 unchanged"];
  assert.equal(heading(bare, "Plan", counts), "Plan — 3 to add · 1 to update · 5 unchanged");
  assert.equal(heading(ascii, "Plan", counts), "Plan - 3 to add . 1 to update . 5 unchanged");
  assert.equal(heading(rich, "Plan", counts), "\x1b[1mPlan\x1b[22m — \x1b[32m3 to add\x1b[39m · \x1b[36m1 to update\x1b[39m · 5 unchanged", "each count in its role");
  assert.equal(heading(bare, "PLAN"), "PLAN", "no counts, no dash");
  assert.equal(rule(bare), "─".repeat(79), "one column short of an 80-column terminal");
  assert.equal(rule(ascii, 10), "-".repeat(10));
  assert.equal(rule(rich, 3), "\x1b[90m───\x1b[39m", "in the explanation role");
  assert.deepEqual(kv(bare, [["vault", "/v"], ["layout", "engineering"], ["channel", null]]), ["  vault    /v", "  layout   engineering", "  channel"]);
  assert.deepEqual(kv(rich, [["k", "v"]], { indent: 0 }), ["\x1b[90mk\x1b[39m  v"]);
  const cmd = 'npx projectstore-claude plan --project "$PWD"';
  assert.deepEqual(commandBlock(bare, [cmd]), ["", `  ${cmd}`], "a blank line, then the command alone on its line");
  assert.deepEqual(commandBlock(rich, [cmd, "restart Claude Code"]), ["", `  \x1b[36m${cmd}\x1b[39m`, "  \x1b[36mrestart Claude Code\x1b[39m"]);
  const narrow = caps(tty(40), { NO_COLOR: "1" });
  assert.equal(commandBlock(narrow, ["x".repeat(60)])[1], `  ${"x".repeat(60)}`, "a command is never broken");
});

test("term: rows align glyph · action · target · note on plain width; a note that would pass a live terminal's width moves under the target column; a pipe keeps every row whole", () => {
  const list = [
    { glyph: "add", role: "done", action: "add", target: "CLAUDE.md", note: "agents block" },
    { glyph: "update", role: "action", action: "update", target: ".claude/settings.local.json", note: "status line" },
    { glyph: "unchanged", role: "explanation", action: "unchanged", target: ".mcp.json" },
  ];
  const wide = rows(caps(tty(80), { NO_COLOR: "1" }), list);
  assert.deepEqual(wide, [
    `  + ${"add".padEnd(9)}  ${"CLAUDE.md".padEnd(27)}  agents block`,
    `  ↻ ${"update".padEnd(9)}  ${".claude/settings.local.json".padEnd(27)}  status line`,
    "  · unchanged  .mcp.json",
  ]);
  // Colour changes no column: the painted rows, stripped, are the plain ones.
  const painted = rows(caps(tty(80), {}), list);
  assert.ok(painted[0].startsWith("  \x1b[32m+\x1b[39m \x1b[32madd\x1b[39m"), JSON.stringify(painted[0]));
  assert.deepEqual(painted.map(plain), wide);
  // ASCII glyphs of different widths still align.
  const ascii = rows(caps(tty(80), { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" }), [{ glyph: "ok", action: "added", target: "a" }, { glyph: "fail", action: "failed", target: "b" }]);
  assert.deepEqual(ascii, ["  ok added   a", "  x  failed  b"]);
  // A live terminal too narrow for a row: the note moves under the target column; the target is whole.
  const narrow = rows(caps(tty(40), { NO_COLOR: "1" }), list);
  assert.deepEqual(narrow, [
    "  + add        CLAUDE.md",
    "               agents block",
    "  ↻ update     .claude/settings.local.json",
    "               status line",
    "  · unchanged  .mcp.json",
  ]);
  // A long note wraps at the target column.
  const long = rows(caps(tty(40), { NO_COLOR: "1" }), [{ glyph: "warning", action: "refused", target: "x", note: "a reason that runs past the row and past the next one too" }]);
  assert.equal(long[0], "  ▲ refused  x");
  assert.ok(long.length >= 3 && long.slice(1).every((l) => l.startsWith(" ".repeat(13)) && l[13] !== " " && l.length <= 39), JSON.stringify(long));
  assert.equal(long.slice(1).map((l) => l.trim()).join(" "), "a reason that runs past the row and past the next one too");
  // A pipe: nothing moves, however long — one line per row for a reader that greps.
  const target = `/p/${"d".repeat(150)}`;
  const piped = rows(caps({}, {}), [{ glyph: "add", action: "add", target, note: "agents block" }]);
  assert.deepEqual(piped, [`  + add  ${target}  agents block`]);
  // Empty columns take no room.
  assert.deepEqual(rows(caps({}, {}), [{ target: "a", note: "n" }, { target: "bb" }], { indent: 0 }), ["a  n", "bb"]);
});

test("term: NO_COLOR leaves no SGR in any primitive, step line, live line or question", async () => {
  const c = caps(tty(80), { NO_COLOR: "1" });
  const texts = [
    badge(c, "projectstore install", ["Codex"]), heading(c, "Plan", [["1 to add", "done"]]), rule(c),
    ...rows(c, [{ glyph: "fail", role: "error", action: "failed", target: "t", note: "n" }]), ...kv(c, [["k", "v"]]), ...commandBlock(c, ["npx x"]),
  ];
  const { chunks, stream } = sink(tty(80));
  const r = stepReporter(stream, c, { now: () => 0 });
  r.start("adding a"); r.end(false, "exited 1");
  const k = fakeClock();
  const line = liveLine(stream, c, LABEL, { env: {}, now: k.now, timers: k.timers });
  k.advance(400); line.end(true);
  let q = null;
  await askApply(1, { ask: async (x) => { q = x; return ""; }, caps: c });
  for (const s of [...texts, ...chunks, q]) assert.ok(!SGR_RE.test(s), JSON.stringify(s));
  // …and with colour the same calls do paint, so the test above is not vacuous.
  assert.ok(SGR_RE.test(heading(caps(tty(80), {}), "Plan", [["1 to add", "done"]])));
});

test("term: stepReporter with an injected clock — the exact running and finished lines on a live terminal, one finished line on a pipe, and a finished label in other words", () => {
  let t = 1000;
  const now = () => t;
  // Live, 40 columns, no colour: the running line ends nowhere; the finished line replaces it.
  const live = sink(tty(40));
  const r = stepReporter(live.stream, caps(live.stream, { NO_COLOR: "1" }), { now });
  r.start("adding AGENTS.md");
  t += 412;
  r.end(true, "", { label: "added AGENTS.md" });
  assert.deepEqual(live.chunks, ["  … adding AGENTS.md".padEnd(39), "\r\x1b[2K" + "  ✓ added AGENTS.md".padEnd(35) + "0.4s\n"]);
  // Piped: nothing until the step ends; then one line, the note and the duration right-aligned to 99.
  const piped = sink();
  const q = stepReporter(piped.stream, caps(piped.stream, {}), { now, indent: 6 });
  q.start("$ claude plugin install x");
  assert.deepEqual(piped.chunks, []);
  t += 12_400;
  q.end(false, "exited 1");
  assert.deepEqual(piped.chunks, ["      ✕ $ claude plugin install x".padEnd(86) + "exited 1  12s\n"]);
  // A kept step is neither ✓ nor ✕; without a finished label the running one stands.
  q.start("remove .projectstore/state/");
  q.end(true, "kept", { kept: true });
  assert.match(piped.chunks.at(-1), /^ {6}· remove \.projectstore\/state\/ +kept {2}0\.0s\n$/);
  // ASCII: the running mark and the fail mark come from the ASCII column.
  const a = sink(tty(40));
  const s = stepReporter(a.stream, caps(a.stream, { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" }), { now });
  s.start("adding x");
  s.end(false);
  assert.ok(a.chunks[0].startsWith("  ... adding x") && a.chunks[1].startsWith("\r\x1b[2K  x adding x"), JSON.stringify(a.chunks));
  // Rich: the marks in their roles.
  const c = sink(tty(40));
  const u = stepReporter(c.stream, caps(c.stream, {}), { now });
  u.start("adding x");
  u.end(true);
  assert.ok(c.chunks[0].startsWith("  \x1b[90m…\x1b[39m adding x") && c.chunks[1].startsWith("\r\x1b[2K  \x1b[32m✓\x1b[39m adding x"), JSON.stringify(c.chunks));
});

const LONG = "$ claude plugin marketplace add /a/very/long/path/that/would/wrap/the/row";

// Presentation spec contract 8: only the in-flight frame of a live line is cut
// to one row; the finished line that replaces it carries the whole target,
// wrapped by the terminal.
test("term: only an in-flight frame is cut — a finished step or live line carries its whole label on a live terminal", () => {
  const ERASE = "\r\x1b[2K";
  const c = caps(tty(40), { NO_COLOR: "1" });
  const s = sink(tty(40));
  const r = stepReporter(s.stream, c, { indent: 6, now: () => 0 });
  r.start(LONG);
  assert.ok(plain(s.chunks[0]).length <= 39 && !s.chunks[0].includes(LONG), "the running frame is cut");
  r.end(true);
  assert.equal(s.chunks[1], `${ERASE}      ✓ ${LONG} 0.0s\n`, "the finished line is whole");
  r.start(LONG);
  r.end(false, "exited 1", { label: `${LONG} (finished)` });
  assert.equal(s.chunks.at(-1), `${ERASE}      ✕ ${LONG} (finished) exited 1  0.0s\n`, "and so is a finished label in other words");
  // The live line: its frames are cut, its end is whole — animated and under PROJECTSTORE_NO_ANIMATION.
  for (const env of [{}, { PROJECTSTORE_NO_ANIMATION: "1" }]) {
    const k = fakeClock();
    const l = sink(tty(40));
    const line = liveLine(l.stream, c, LONG, { env, now: k.now, timers: k.timers });
    k.advance(300);
    assert.ok(l.chunks.length >= 1, JSON.stringify(env));
    for (const f of l.chunks) assert.ok(plain(f.replace(ERASE, "")).length <= 39 && !f.includes(LONG), `a frame is one row: ${JSON.stringify(f)}`);
    line.end(true, `fetched ${LONG}`);
    assert.equal(l.chunks.at(-1), `${ERASE}  ✓ fetched ${LONG} 0.3s\n`, JSON.stringify(env));
  }
  // A pipe was never cut and still is not.
  const p = sink();
  const q = stepReporter(p.stream, caps(p.stream, {}), { indent: 6, now: () => 0 });
  q.start(LONG); q.end(true);
  assert.ok(p.chunks[0].includes(LONG));
});

test("term: with ASCII glyphs on a 40-column terminal, step and live lines carry no code point above 0x7E — the cut is marked with the table's ...", () => {
  const c = caps(tty(40), { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" });
  const s = sink(tty(40));
  const r = stepReporter(s.stream, c, { indent: 6, now: () => 0 });
  r.start(LONG);
  // Room for the label: 39 − 6 − "..." − 2 spaces − 1 = 28, of which "..." takes three.
  assert.equal(s.chunks[0], `      ... ${LONG.slice(0, 25)}... `);
  r.end(false, "exited 1");
  r.start("remove x");
  r.end(true, "kept", { kept: true });
  const k = fakeClock();
  const l = liveLine(s.stream, c, LONG, { env: {}, now: k.now, timers: k.timers });
  k.advance(500);
  l.end(true, LONG);
  const k2 = fakeClock();
  liveLine(s.stream, c, LONG, { env: { PROJECTSTORE_NO_ANIMATION: "1" }, now: k2.now, timers: k2.timers }).end(false, LONG, "ETARGET");
  const all = s.chunks.join("");
  assert.ok(all.includes("...") && all.includes(" x ") && all.includes(" . ") && all.includes(" ok "), all);
  for (const ch of all) assert.ok(ch.codePointAt(0) <= 0x7e, `U+${ch.codePointAt(0).toString(16).toUpperCase()} in ${JSON.stringify(all)}`);
});

// The fallback in icon() keeps a production row drawn when a name is wrong;
// this keeps a wrong name from reaching a golden fixture, where it would be
// blessed as the update glyph. Every literal glyph name the runtime code
// passes: ACTION_ICON's values, every string in the arguments of an icon(),
// termIcon() or glyph() call, and every rows() row's `glyph:`.
function glyphNames(src) {
  const found = [];
  for (const m of src.matchAll(/\bACTION_ICON\s*=\s*\{([^}]*)\}/g)) for (const v of m[1].matchAll(/:\s*"([^"]+)"/g)) found.push(v[1]);
  for (const m of src.matchAll(/\b(?:icon|termIcon|glyph)\(/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < src.length && depth; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; }
    for (const s of src.slice(m.index + m[0].length, i - 1).matchAll(/"([^"\\]*)"/g)) found.push(s[1]);
  }
  for (const m of src.matchAll(/\bglyph:\s*"([^"]+)"/g)) found.push(m[1]);
  return found;
}

test("term: every glyph name the runtime code passes is a key of GLYPHS or GLYPH_ALIASES", () => {
  const known = (n) => Object.hasOwn(GLYPHS, n) || Object.hasOwn(GLYPH_ALIASES, n);
  // The scan itself: a typo in each form is caught.
  assert.deepEqual(glyphNames('const ACTION_ICON = { add: "creat" }; icon(c, "runing"); termIcon(c, x || "updte"); glyph(a ? "skp" : "ok"); rows(c, [{ glyph: "ad" }]);').filter((n) => !known(n)), ["creat", "runing", "updte", "skp", "ad"]);
  const seen = new Set(), unknown = [];
  for (const file of runtimeFiles(ROOT)) {
    for (const n of glyphNames(stripComments(readFileSync(join(ROOT, file), "utf8")))) {
      seen.add(n);
      if (!known(n)) unknown.push(`${file}: "${n}"`);
    }
  }
  assert.deepEqual(unknown, []);
  // Not vacuous: the names term.mjs and the installer pass today are found.
  for (const n of ["running", "ok", "fail", "skip", "ask", "dot", "dash", "rule", "refuse", "fetch", "update", "create", "remove", "cleanup", "migrate"]) assert.ok(seen.has(n), `${n} was scanned`);
});

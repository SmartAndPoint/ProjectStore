// projectstore — tests for term.mjs: the terminal presentation the write verbs
// use (install spec, contract 18). Colour and in-place lines are for a person
// at a terminal; a pipe — an agent's tool call, CI — gets the same layout as
// plain text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  caps,
  painter,
  icon,
  duration,
  plain,
  stepReporter,
  liveLine,
  wrap,
  askLine,
  askApply,
  GLYPHS,
  GLYPH_ALIASES,
  ROLES,
  badge,
  heading,
  rows,
  rule,
  kv,
  commandBlock,
  railAvailable,
  openRail,
  CANCELLED,
  BACK,
  openScreen,
  ALT_ON,
  ALT_OFF,
  PLAIN,
} from "../scripts/term.mjs";
import { runtimeFiles, stripComments } from "./fixtures/vocabulary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tty = (columns = 80) => ({ isTTY: true, columns });
const sink = (base = {}) => {
  const chunks = [];
  return {
    chunks,
    stream: {
      ...base,
      write: (s) => {
        chunks.push(String(s));
        return true;
      },
    },
  };
};

test("term: colour follows the terminal, NO_COLOR and FORCE_COLOR; a dumb terminal gets ASCII", () => {
  assert.equal(caps(tty(), {}).color, true, "a terminal");
  assert.equal(caps({}, {}).color, false, "a pipe");
  assert.equal(caps(tty(), { NO_COLOR: "1" }).color, false, "NO_COLOR");
  assert.equal(caps(tty(), { NO_COLOR: "" }).color, true, "an empty NO_COLOR is not set (no-color.org)");
  for (const v of ["", "1", "2", "3", "true"])
    assert.equal(caps({}, { FORCE_COLOR: v }).color, true, `FORCE_COLOR=${v} colours a pipe`);
  for (const v of ["0", "false"])
    assert.equal(caps(tty(), { FORCE_COLOR: v }).color, false, `FORCE_COLOR=${v} turns a terminal plain`);
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
  const text =
    "the surfaces below are planned against the host's install path /Users/someone/.claude/plugins/cache/projectstore-npx/projectstore/0.29.0, not this package";
  const lines = wrap(text, 60, "    ").split("\n");
  assert.ok(lines.length > 1);
  for (const l of lines.slice(1)) assert.ok(l.startsWith("    "), l);
  assert.ok(
    lines.some((l) => l.includes("/Users/someone/.claude/plugins/cache/projectstore-npx/projectstore/0.29.0,")),
    "the path is one word",
  );
  assert.equal(lines.join(" ").replace(/ +/g, " "), text, "nothing is lost");
  assert.equal(wrap("short", 60, "  "), "short");
  assert.equal(wrap(text, 0, "    "), text, "width 0 — not a terminal — breaks nothing");
});

test("term: askLine reads one line in line mode — Enter is an empty answer, end of input is null, nothing but the question is written", async () => {
  const ask = async (feed) => {
    const input = new PassThrough(),
      output = new PassThrough();
    let written = "";
    output.on("data", (d) => {
      written += d;
    });
    const pending = askLine("Apply 3 changes? [Y/n] ", input, output);
    feed(input);
    return { answer: await pending, written };
  };
  assert.deepEqual(await ask((i) => i.write("\n")), { answer: "", written: "Apply 3 changes? [Y/n] " });
  assert.equal((await ask((i) => i.write("n\n"))).answer, "n");
  const eof = await ask((i) => i.end());
  assert.equal(eof.answer, null, "end of input (Ctrl+D) is null — a no — and the promise settles");
  assert.equal(
    eof.written,
    "Apply 3 changes? [Y/n] \n",
    "and the question's line is ended, so the next message starts on its own",
  );
  assert.equal(
    (
      await ask((i) => {
        i.write("ye");
        i.end();
      })
    ).answer,
    null,
    "a half-typed answer cut by end of input is not an answer",
  );
});

test("term: askApply is contract 9's one question — its bytes, singular and plural, Enter/y/yes apply, anything else and end of input do not", async () => {
  const asked = [];
  const via = (answer, n = 3, c) =>
    askApply(n, {
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      ...(c ? { caps: c } : {}),
    });
  for (const yes of ["", "y", "Y", "yes", "YES", "  yes  "]) assert.equal(await via(yes), true, JSON.stringify(yes));
  for (const no of ["n", "no", "nope", "yess", "x"]) assert.equal(await via(no), false, JSON.stringify(no));
  for (const eof of [null, undefined]) assert.equal(await via(eof), false, `${eof} is end of input`);
  assert.equal(asked[0], "◆ Apply 3 changes? [Y/n] ", "without caps: unpainted, the Unicode question glyph");
  await via("", 1);
  assert.equal(asked.at(-1), "◆ Apply 1 change? [Y/n] ");
  // Through a stream, as at a terminal: the question is all that is written, and end of input is a no.
  const input = new PassThrough(),
    output = new PassThrough();
  let written = "";
  output.on("data", (d) => {
    written += d;
  });
  const pending = askApply(4, { stdin: input, stdout: output });
  input.end();
  assert.equal(await pending, false);
  assert.equal(written, "◆ Apply 4 changes? [Y/n] \n");
});

// Presentation spec contract 8: only the look changes — the question glyph in
// the action role, the question in emphasis, the keys in explanation — and
// the glyph follows the glyph switch, not the colour.
test("term: the confirm's exact bytes — rich, rich without colour, plain, and ASCII with and without colour", async () => {
  const bytes = async (c) => {
    let q = null;
    await askApply(2, {
      ask: async (x) => {
        q = x;
        return "";
      },
      caps: c,
    });
    return q;
  };
  const RICH = "\x1b[36m◆\x1b[39m \x1b[1mApply 2 changes?\x1b[22m \x1b[90m[Y/n]\x1b[39m ";
  assert.equal(await bytes(caps(tty(), {})), RICH, "rich: ◆ in the action role (cyan), a bold question, grey keys");
  assert.equal(await bytes(caps(tty(), { NO_COLOR: "1" })), "◆ Apply 2 changes? [Y/n] ", "rich, no colour");
  assert.equal(await bytes(caps({}, {})), "◆ Apply 2 changes? [Y/n] ", "plain: a pipe, unpainted, Unicode");
  assert.equal(
    await bytes(caps(tty(), { PROJECTSTORE_ASCII: "1" })),
    RICH.replace("◆", "*"),
    "PROJECTSTORE_ASCII changes the glyph and keeps the colour",
  );
  assert.equal(
    await bytes(caps(tty(), { TERM: "dumb" })),
    "* Apply 2 changes? [Y/n] ",
    "TERM=dumb: ASCII and no colour",
  );
  assert.equal(await bytes(caps({}, { PROJECTSTORE_ASCII: "1" })), "* Apply 2 changes? [Y/n] ", "ASCII on a pipe");
});

// ─── The live line (presentation spec contract 8, its asynchronous part) ──

// A clock and timers the test advances by hand: every handle records whether
// it was unref'd, and `pending` is what a forgotten line would leave behind.
function fakeClock() {
  let t = 0,
    seq = 0;
  const live = new Map();
  const add = (fn, ms, every) => {
    const h = {
      id: ++seq,
      at: t + ms,
      fn,
      every,
      unrefd: false,
      unref() {
        this.unrefd = true;
        return this;
      },
    };
    live.set(h.id, h);
    return h;
  };
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearTimeout: (h) => {
        if (h) live.delete(h.id);
      },
      clearInterval: (h) => {
        if (h) live.delete(h.id);
      },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...live.values()].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at;
        if (next.every) next.at += next.every;
        else live.delete(next.id);
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
  assert.deepEqual(
    chunks.map((s) => s.slice(ERASE.length + 2, ERASE.length + 3)),
    ["⠋", "⠙", "⠹"],
  );
  assert.ok(chunks[2].endsWith("0.5s"));
  for (const s of chunks) {
    assert.ok(!s.includes("\n") && plain(s.slice(ERASE.length)).length < 80, "one physical row, redrawn in place");
  }
  assert.ok(
    k.handles().every((h) => h.unrefd),
    "a forgotten line never holds the process",
  );
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
  liveLine(narrow.stream, caps(narrow.stream, { NO_COLOR: "1" }), "x".repeat(200), {
    env: {},
    now: k2.now,
    timers: k2.timers,
  });
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
  const still = liveLine(n.stream, caps(n.stream, { NO_COLOR: "1" }), LABEL, {
    env: { PROJECTSTORE_NO_ANIMATION: "1" },
    now: q.now,
    timers: q.timers,
  });
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
  assert.ok(
    !p.chunks[0].includes("\x1b") &&
      p.chunks[0].startsWith("  ✓ fetched projectstore-codex@0.30.0 for Codex ") &&
      p.chunks[0].endsWith(" 5.0s\n"),
    JSON.stringify(p.chunks[0]),
  );
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
  liveLine(b.stream, caps(b.stream, { NO_COLOR: "1" }), LABEL, {
    env: {},
    now: quietAbort.now,
    timers: quietAbort.timers,
  }).abort();
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
    ok: ["✓", "ok"],
    add: ["+", "+"],
    fail: ["✕", "x"],
    update: ["↻", "~"],
    warning: ["▲", "!"],
    switch: ["⇄", "<>"],
    unchanged: ["·", "."],
    remove: ["−", "-"],
    fetch: ["↓", "v"],
    running: ["…", "..."],
    ask: ["◆", "*"],
    answered: ["◇", "o"],
    choiceOn: ["●", "(*)"],
    choiceOff: ["○", "( )"],
    checkOn: ["◼", "[x]"],
    checkOff: ["◻", "[ ]"],
    rail: ["│", "|"],
    railTop: ["┌", "+"],
    railEnd: ["└", "+"],
    rule: ["─", "-"],
    progressDone: ["━", "#"],
    progressLeft: ["╺", "-"],
    dash: ["—", "-"],
    dot: ["·", "."],
    transition: ["→", "->"],
    // The settings menu's frames and marks (contract 14, amended 2026-10-13).
    frameTopLeft: ["╭", "+"],
    frameTopRight: ["╮", "+"],
    frameBottomLeft: ["╰", "+"],
    frameBottomRight: ["╯", "+"],
    cursor: ["›", ">"],
    moreAbove: ["↑", "^"],
    moreBelow: ["↓", "v"],
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
  assert.deepEqual(
    [
      icon({}, "issue"),
      icon({}, "refuse"),
      icon({}, "note"),
      icon({}, "skip"),
      icon({}, "cleanup"),
      icon({}, "create"),
    ],
    ["✕", "▲", "▲", "·", "−", "+"],
  );
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
  assert.deepEqual(
    { ...ROLES },
    { action: "cyan", done: "green", attention: "yellow", error: "red", explanation: "gray", emphasis: "bold" },
  );
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
  const rich = caps(tty(), {}),
    bare = caps(tty(), { NO_COLOR: "1" }),
    ascii = caps(tty(), { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" });
  assert.equal(
    badge(bare, "projectstore install", ["Claude Code, Codex"]),
    "projectstore install · Claude Code, Codex",
  );
  assert.equal(
    badge(ascii, "projectstore install", ["Claude Code, Codex"]),
    "projectstore install . Claude Code, Codex",
  );
  assert.equal(
    badge(rich, "projectstore doctor", ["v0.30.0", null, "", "front-door"]),
    "\x1b[1mprojectstore doctor\x1b[22m · v0.30.0 · front-door",
    "the head in emphasis; empty parts are left out",
  );
  const counts = [["3 to add", "done"], ["1 to update", "action"], "5 unchanged"];
  assert.equal(heading(bare, "Plan", counts), "Plan — 3 to add · 1 to update · 5 unchanged");
  assert.equal(heading(ascii, "Plan", counts), "Plan - 3 to add . 1 to update . 5 unchanged");
  assert.equal(
    heading(rich, "Plan", counts),
    "\x1b[1mPlan\x1b[22m — \x1b[32m3 to add\x1b[39m · \x1b[36m1 to update\x1b[39m · 5 unchanged",
    "each count in its role",
  );
  assert.equal(heading(bare, "PLAN"), "PLAN", "no counts, no dash");
  assert.equal(rule(bare), "─".repeat(79), "one column short of an 80-column terminal");
  assert.equal(rule(ascii, 10), "-".repeat(10));
  assert.equal(rule(rich, 3), "\x1b[90m───\x1b[39m", "in the explanation role");
  assert.deepEqual(
    kv(bare, [
      ["vault", "/v"],
      ["layout", "engineering"],
      ["channel", null],
    ]),
    ["  vault    /v", "  layout   engineering", "  channel"],
  );
  assert.deepEqual(kv(rich, [["k", "v"]], { indent: 0 }), ["\x1b[90mk\x1b[39m  v"]);
  const cmd = 'npx projectstore-claude plan --project "$PWD"';
  assert.deepEqual(commandBlock(bare, [cmd]), ["", `  ${cmd}`], "a blank line, then the command alone on its line");
  assert.deepEqual(commandBlock(rich, [cmd, "restart Claude Code"]), [
    "",
    `  \x1b[36m${cmd}\x1b[39m`,
    "  \x1b[36mrestart Claude Code\x1b[39m",
  ]);
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
  const ascii = rows(caps(tty(80), { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" }), [
    { glyph: "ok", action: "added", target: "a" },
    { glyph: "fail", action: "failed", target: "b" },
  ]);
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
  const long = rows(caps(tty(40), { NO_COLOR: "1" }), [
    {
      glyph: "warning",
      action: "refused",
      target: "x",
      note: "a reason that runs past the row and past the next one too",
    },
  ]);
  assert.equal(long[0], "  ▲ refused  x");
  assert.ok(
    long.length >= 3 && long.slice(1).every((l) => l.startsWith(" ".repeat(13)) && l[13] !== " " && l.length <= 39),
    JSON.stringify(long),
  );
  assert.equal(
    long
      .slice(1)
      .map((l) => l.trim())
      .join(" "),
    "a reason that runs past the row and past the next one too",
  );
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
    badge(c, "projectstore install", ["Codex"]),
    heading(c, "Plan", [["1 to add", "done"]]),
    rule(c),
    ...rows(c, [{ glyph: "fail", role: "error", action: "failed", target: "t", note: "n" }]),
    ...kv(c, [["k", "v"]]),
    ...commandBlock(c, ["npx x"]),
  ];
  const { chunks, stream } = sink(tty(80));
  const r = stepReporter(stream, c, { now: () => 0 });
  r.start("adding a");
  r.end(false, "exited 1");
  const k = fakeClock();
  const line = liveLine(stream, c, LABEL, { env: {}, now: k.now, timers: k.timers });
  k.advance(400);
  line.end(true);
  let q = null;
  await askApply(1, {
    ask: async (x) => {
      q = x;
      return "";
    },
    caps: c,
  });
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
  assert.deepEqual(live.chunks, [
    "  … adding AGENTS.md".padEnd(39),
    "\r\x1b[2K" + "  ✓ added AGENTS.md".padEnd(35) + "0.4s\n",
  ]);
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
  assert.ok(
    a.chunks[0].startsWith("  ... adding x") && a.chunks[1].startsWith("\r\x1b[2K  x adding x"),
    JSON.stringify(a.chunks),
  );
  // Rich: the marks in their roles.
  const c = sink(tty(40));
  const u = stepReporter(c.stream, caps(c.stream, {}), { now });
  u.start("adding x");
  u.end(true);
  assert.ok(
    c.chunks[0].startsWith("  \x1b[90m…\x1b[39m adding x") &&
      c.chunks[1].startsWith("\r\x1b[2K  \x1b[32m✓\x1b[39m adding x"),
    JSON.stringify(c.chunks),
  );
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
  assert.equal(
    s.chunks.at(-1),
    `${ERASE}      ✕ ${LONG} (finished) exited 1  0.0s\n`,
    "and so is a finished label in other words",
  );
  // The live line: its frames are cut, its end is whole — animated and under PROJECTSTORE_NO_ANIMATION.
  for (const env of [{}, { PROJECTSTORE_NO_ANIMATION: "1" }]) {
    const k = fakeClock();
    const l = sink(tty(40));
    const line = liveLine(l.stream, c, LONG, { env, now: k.now, timers: k.timers });
    k.advance(300);
    assert.ok(l.chunks.length >= 1, JSON.stringify(env));
    for (const f of l.chunks)
      assert.ok(
        plain(f.replace(ERASE, "")).length <= 39 && !f.includes(LONG),
        `a frame is one row: ${JSON.stringify(f)}`,
      );
    line.end(true, `fetched ${LONG}`);
    assert.equal(l.chunks.at(-1), `${ERASE}  ✓ fetched ${LONG} 0.3s\n`, JSON.stringify(env));
  }
  // A pipe was never cut and still is not.
  const p = sink();
  const q = stepReporter(p.stream, caps(p.stream, {}), { indent: 6, now: () => 0 });
  q.start(LONG);
  q.end(true);
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
  liveLine(s.stream, c, LONG, { env: { PROJECTSTORE_NO_ANIMATION: "1" }, now: k2.now, timers: k2.timers }).end(
    false,
    LONG,
    "ETARGET",
  );
  const all = s.chunks.join("");
  assert.ok(all.includes("...") && all.includes(" x ") && all.includes(" . ") && all.includes(" ok "), all);
  for (const ch of all)
    assert.ok(ch.codePointAt(0) <= 0x7e, `U+${ch.codePointAt(0).toString(16).toUpperCase()} in ${JSON.stringify(all)}`);
});

// The fallback in icon() keeps a production row drawn when a name is wrong;
// this keeps a wrong name from reaching a golden fixture, where it would be
// blessed as the update glyph. Every literal glyph name the runtime code
// passes: ACTION_ICON's values, every string in the arguments of an icon(),
// termIcon() or glyph() call, and every rows() row's `glyph:`.
function glyphNames(src) {
  const found = [];
  for (const m of src.matchAll(/\bACTION_ICON\s*=\s*\{([^}]*)\}/g))
    for (const v of m[1].matchAll(/:\s*"([^"]+)"/g)) found.push(v[1]);
  for (const m of src.matchAll(/\b(?:icon|termIcon|glyph)\(/g)) {
    let depth = 1,
      i = m.index + m[0].length;
    for (; i < src.length && depth; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    for (const s of src.slice(m.index + m[0].length, i - 1).matchAll(/"([^"\\]*)"/g)) found.push(s[1]);
  }
  for (const m of src.matchAll(/\bglyph:\s*"([^"]+)"/g)) found.push(m[1]);
  return found;
}

test("term: every glyph name the runtime code passes is a key of GLYPHS or GLYPH_ALIASES", () => {
  const known = (n) => Object.hasOwn(GLYPHS, n) || Object.hasOwn(GLYPH_ALIASES, n);
  // The scan itself: a typo in each form is caught.
  assert.deepEqual(
    glyphNames(
      'const ACTION_ICON = { add: "creat" }; icon(c, "runing"); termIcon(c, x || "updte"); glyph(a ? "skp" : "ok"); rows(c, [{ glyph: "ad" }]);',
    ).filter((n) => !known(n)),
    ["creat", "runing", "updte", "skp", "ad"],
  );
  const seen = new Set(),
    unknown = [];
  for (const file of runtimeFiles(ROOT)) {
    for (const n of glyphNames(stripComments(readFileSync(join(ROOT, file), "utf8")))) {
      seen.add(n);
      if (!known(n)) unknown.push(`${file}: "${n}"`);
    }
  }
  assert.deepEqual(unknown, []);
  // Not vacuous: the names term.mjs and the installer pass today are found.
  for (const n of [
    "running",
    "ok",
    "fail",
    "skip",
    "ask",
    "dot",
    "dash",
    "rule",
    "refuse",
    "fetch",
    "update",
    "create",
    "remove",
    "cleanup",
    "migrate",
  ])
    assert.ok(seen.has(n), `${n} was scanned`);
  // …and the question rail's.
  for (const n of ["rail", "railTop", "railEnd", "choiceOn", "choiceOff", "checkOn", "checkOff", "pointer", "warning"])
    assert.ok(seen.has(n), `${n} was scanned`);
});

// ─── The question rail (presentation spec contract 9; the story "projectstore
// setup asks, shows one plan and installs every harness it finds, with the
// vault", rule 2) ──────────────────────────────────────────────────────────

// The screen a terminal would show for what the rail wrote: CR, LF (the tty
// adds the CR, as raw mode leaves ONLCR on), cursor up, erase below and the
// wrap at the last column applied; SGR and the cursor's visibility skipped.
// A redraw that miscounted its rows leaves its garbage here.
function screen(text, columns = 80) {
  const lines = [[]];
  let row = 0,
    col = 0;
  const at = (r) => {
    while (lines.length <= r) lines.push([]);
    return lines[r];
  };
  for (let i = 0; i < text.length;) {
    const m = /^\x1b\[(\??)(\d*)([A-Za-z])/.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      if (m[1] === "?" || m[3] === "m") continue;
      if (m[3] === "A") {
        row = Math.max(0, row - (m[2] === "" ? 1 : Number(m[2])));
        col = Math.min(col, columns - 1);
        continue;
      }
      if (m[3] === "J") {
        at(row).length = Math.min(at(row).length, col);
        lines.length = row + 1;
        continue;
      }
      throw new Error(`an escape the rail should not write: ${JSON.stringify(m[0])}`);
    }
    const ch = String.fromCodePoint(text.codePointAt(i));
    i += ch.length;
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\n") {
      row++;
      col = 0;
      at(row);
      continue;
    }
    if (col >= columns) {
      row++;
      col = 0;
    }
    const line = at(row);
    while (line.length < col) line.push(" ");
    line[col++] = ch;
  }
  const out = lines.map((l) => l.join("").trimEnd());
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

// The TTY double: stdin a PassThrough that says it is a terminal, with a
// setRawMode that records each call; stdout a terminal sink; a process
// stand-in that records the handlers the rail adds and the signal it raises
// again. Keys are fed one per turn, each after the question has drawn.
function railTerm({ columns = 80, env = { NO_COLOR: "1" }, raw = true } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const modes = [];
  if (raw)
    stdin.setRawMode = (on) => {
      modes.push(on);
      stdin.isRaw = on;
      return stdin;
    };
  const chunks = [];
  const stdout = {
    isTTY: true,
    columns,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
  };
  const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: [] });
  proc.kill = (pid, sig) => {
    proc.killed.push([pid, sig]);
    return true;
  };
  const c = caps(stdout, env);
  return {
    stdin,
    stdout,
    modes,
    chunks,
    proc,
    caps: c,
    text: () => chunks.join(""),
    screen: () => screen(chunks.join(""), columns),
    open: (o = {}) => openRail({ stdin, stdout, caps: c, proc, head: "projectstore setup", escapeMs: 20, ...o }),
  };
}
const tick = () => new Promise(setImmediate);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function press(t, pending, ...keys) {
  for (const k of keys) {
    await tick();
    t.stdin.write(k);
  }
  return pending;
}
const handlers = (proc) => ["exit", "SIGTERM", "SIGHUP", "SIGINT"].map((e) => proc.listenerCount(e)).join(" ");
// A question that never settles — a key lost, a cancel missed — is a failure,
// not a suite that waits for ever: each rail test is bounded.
const RAIL = { timeout: 10_000 };
const UP = "\x1b[A",
  DOWN = "\x1b[B",
  ENTER = "\r",
  SPACE = " ",
  CTRL_C = "\x03",
  ESC = "\x1b",
  BACKSPACE = "\x7f";
const HIDE = "\x1b[?25l",
  SHOW = "\x1b[?25h";
const VAULT = [
  { value: "create", label: "Create ~/p/acme-vault", reason: "a new vault beside the project" },
  { value: "other", label: "Another folder…" },
  { value: "none", label: "Not now", reason: "installed unbound" },
];

test(
  "rail: drawn only when stdin is a terminal with setRawMode and stdout a live one — otherwise there is none, and openRail refuses before it draws or listens",
  RAIL,
  () => {
    const t = railTerm();
    assert.equal(railAvailable(t.stdin, t.caps), true);
    assert.equal(
      railAvailable(t.stdin, caps(t.stdout, { PROJECTSTORE_ASCII: "1" })),
      true,
      "ASCII glyphs keep the rail",
    );
    const bare = railTerm({ raw: false });
    assert.equal(railAvailable(bare.stdin, bare.caps), false, "no setRawMode: no rail");
    assert.equal(railAvailable(t.stdin, caps(t.stdout, { TERM: "dumb" })), false, "TERM=dumb: caps.live is false");
    assert.equal(railAvailable(t.stdin, caps({ write() {} }, {})), false, "stdout a pipe");
    assert.equal(railAvailable(new PassThrough(), t.caps), false, "stdin a pipe");
    assert.equal(railAvailable(null, t.caps), false);
    assert.equal(railAvailable(t.stdin, null), false);
    for (const [u, c] of [
      [bare, bare.caps],
      [t, caps(t.stdout, { TERM: "dumb" })],
    ]) {
      assert.throws(() => openRail({ stdin: u.stdin, stdout: u.stdout, caps: c, proc: u.proc }), /no question rail/);
      assert.deepEqual(u.chunks, [], "nothing is drawn");
      assert.equal(handlers(u.proc), "0 0 0 0", "and no handler is added");
      assert.equal(u.stdin.listenerCount("keypress"), 0);
    }
  },
);

test(
  "rail: a select draws its choices with the default on, ↓ and Enter choose, and it collapses to one ◇ line; raw mode and the hidden cursor last only while it is asked",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    assert.deepEqual(t.screen(), ["┌ projectstore setup"], "the top: ┌ and the badge");
    assert.equal(t.stdin.readableFlowing, false, "stdin reads only while a question is asked");
    const pending = rail.select("Where should this project's notes live?", VAULT);
    assert.deepEqual(t.screen(), [
      "┌ projectstore setup",
      "│",
      "◆ Where should this project's notes live?",
      "│ ● Create ~/p/acme-vault  a new vault beside the project",
      "│ ○ Another folder…",
      "│ ○ Not now                installed unbound",
      "│ up/down move · enter choose · ctrl+c cancel",
    ]);
    assert.deepEqual(t.modes, [true], "raw mode while it is asked");
    assert.ok(t.chunks.includes(HIDE), "the cursor is hidden while choosing");
    await press(t, null, DOWN);
    await tick();
    assert.deepEqual(
      t.screen().slice(3, 6),
      [
        "│ ○ Create ~/p/acme-vault  a new vault beside the project",
        "│ ● Another folder…",
        "│ ○ Not now                installed unbound",
      ],
      "redrawn in place",
    );
    assert.equal(await press(t, pending, ENTER), "other");
    assert.deepEqual(t.screen(), [
      "┌ projectstore setup",
      "│",
      "◇ Where should this project's notes live?  Another folder…",
    ]);
    assert.deepEqual(t.modes, [true, false], "raw mode off once answered");
    assert.equal(t.chunks.at(-1), SHOW, "and the cursor shown");
    assert.equal(t.stdin.readableFlowing, false, "stdin paused between questions");
    // The default is where the cursor starts; ↑ from the first wraps to the last; Esc and any other key are ignored.
    const second = rail.select("Again", VAULT, { default: "none" });
    assert.equal(t.screen().at(-2), "│ ● Not now                installed unbound");
    await press(t, null, "x", "\t", ESC);
    await sleep(60); // past the escape timeout: the Esc is reported, and ignored
    assert.equal(await press(t, second, ENTER), "none", "Enter takes the default");
    assert.equal(await press(t, rail.select("Wrap", VAULT), UP, ENTER), "none", "↑ from the first is the last");
    rail.close();
    assert.deepEqual(t.modes, [true, false, true, false, true, false], "each question restores what it set");
  },
);

test(
  "rail: a multi ticks with space and confirms with Enter; Enter with none ticked keeps the question and says how; the row under the cursor carries the → mark",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    const list = [
      { value: "claude-code", label: "Claude Code", reason: "used in this project (.claude/)" },
      { value: "codex", label: "Codex", reason: "not found on this machine" },
    ];
    const pending = rail.multi("Install projectstore for", list);
    assert.deepEqual(t.screen().slice(2), [
      "◆ Install projectstore for",
      "│ → ◻ Claude Code  used in this project (.claude/)",
      "│   ◻ Codex        not found on this machine",
      "│ up/down move · space toggle · enter confirm · ctrl+c cancel",
    ]);
    await press(t, null, ENTER);
    await tick();
    assert.deepEqual(
      t.screen().slice(5),
      ["│ ▲ tick at least one with space", "│ up/down move · space toggle · enter confirm · ctrl+c cancel"],
      "the question stays, and says how",
    );
    await press(t, null, DOWN, SPACE);
    await tick();
    assert.deepEqual(
      t.screen().slice(3),
      [
        "│   ◻ Claude Code  used in this project (.claude/)",
        "│ → ◼ Codex        not found on this machine",
        "│ up/down move · space toggle · enter confirm · ctrl+c cancel",
      ],
      "ticked, and the refusal gone",
    );
    assert.deepEqual(await press(t, pending, ENTER), ["codex"]);
    assert.deepEqual(t.screen().slice(1), ["│", "◇ Install projectstore for  Codex"]);
    // Pre-ticked rows are the default; values come back in the list's order; space unticks.
    const ticked = list.map((x) => ({ ...x, on: true }));
    assert.deepEqual(await press(t, rail.multi("Again", ticked), ENTER), ["claude-code", "codex"]);
    assert.equal(t.screen().at(-1), "◇ Again  Claude Code, Codex");
    assert.deepEqual(await press(t, rail.multi("Untick", ticked), SPACE, ENTER), ["codex"]);
    assert.deepEqual(await press(t, rail.multi("None allowed", list, { min: 0 }), ENTER), [], "min: 0 takes none");
    assert.equal(t.screen().at(-1), "◇ None allowed  none");
    // A min above the list's length is the list's length, so the question can close.
    const clamped = rail.multi("Clamped", list, { min: 5 });
    await press(t, null, SPACE, ENTER);
    await tick();
    assert.equal(t.screen().at(-2), "│ ▲ tick at least 2 with space", "the refusal names what can be ticked");
    assert.deepEqual(await press(t, clamped, DOWN, SPACE, ENTER), ["claude-code", "codex"]);
    rail.close();
  },
);

test(
  "rail: a confirm is a two-row select — Enter takes its default, ↓ moves to the other — with its reasons and a note under the title",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    const pending = rail.confirm("Show projectstore in Claude Code's status line?", {
      note: "your current epic and story; restart Claude Code to see it",
    });
    assert.deepEqual(t.screen().slice(2), [
      "◆ Show projectstore in Claude Code's status line?",
      "│ your current epic and story; restart Claude Code to see it",
      "│ ● Yes",
      "│ ○ No",
      "│ up/down move · enter choose · ctrl+c cancel",
    ]);
    assert.equal(await press(t, pending, ENTER), true);
    assert.equal(t.screen().at(-1), "◇ Show projectstore in Claude Code's status line?  Yes");
    assert.equal(await press(t, rail.confirm("Q", { default: false }), ENTER), false, "a default of no");
    assert.equal(await press(t, rail.confirm("Q"), DOWN, ENTER), false);
    const labelled = rail.confirm("Updates", {
      yes: "Yes",
      no: "No, tell me when there is a new version",
      yesReason: "run the newest at setup and upgrade",
    });
    assert.deepEqual(
      t.screen().slice(-3, -1),
      ["│ ● Yes  run the newest at setup and upgrade", "│ ○ No, tell me when there is a new version"],
      "the reason column is as wide as the labels that have one",
    );
    assert.equal(await press(t, labelled, DOWN, ENTER), false);
    assert.equal(t.screen().at(-1), "◇ Updates  No, tell me when there is a new version");
    rail.close();
  },
);

test(
  "rail: a path takes what is typed, or its default on a bare Enter; a check's reason keeps it open; Esc goes back and takes back the answered line before it",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    rail.answered("Which folder is the project?", "~/p/acme");
    const before = t.screen();
    assert.equal(await press(t, rail.select("Where should this project's notes live?", VAULT), DOWN, ENTER), "other");
    const check = (v) => (v === "/etc" ? "/etc is not writable" : null);
    const pending = rail.path("Which folder holds the vault?", { default: "~/p/acme-vault", check });
    assert.deepEqual(t.screen().slice(-5), [
      "│",
      "◆ Which folder holds the vault?",
      "│ default ~/p/acme-vault",
      "│ enter confirm · esc back · ctrl+c cancel",
      "│",
    ]);
    assert.ok(
      !t.chunks.slice(t.chunks.lastIndexOf(SHOW)).includes(HIDE),
      "the cursor stays shown, at the end of what is typed",
    );
    await press(t, null, "/", "e", "t", "c", ENTER);
    await tick();
    assert.deepEqual(
      t.screen().slice(-4),
      ["│ ▲ /etc is not writable", "│ default ~/p/acme-vault", "│ enter confirm · esc back · ctrl+c cancel", "│ /etc"],
      "refused inline; the question stays",
    );
    await press(t, null, ESC);
    assert.equal(await pending, BACK);
    assert.deepEqual(
      t.screen(),
      before,
      "the path and the vault choice before it are gone: the caller asks that choice again where it was",
    );
    assert.equal(await press(t, rail.select("Where should this project's notes live?", VAULT), DOWN, ENTER), "other");
    // Typed, edited with backspace, and confirmed; the check sees the value.
    const typed = rail.path("Which folder holds the vault?", { default: "~/p/acme-vault", check });
    assert.equal(await press(t, typed, ..."/v/x", BACKSPACE, "y", ENTER), "/v/y");
    assert.deepEqual(t.screen().slice(2), [
      "◇ Which folder is the project?  ~/p/acme",
      "│",
      "◇ Where should this project's notes live?  Another folder…",
      "│",
      "◇ Which folder holds the vault?  /v/y",
    ]);
    assert.equal(
      await press(t, rail.path("Folder", { default: "~/p/acme-vault" }), ENTER),
      "~/p/acme-vault",
      "a bare Enter takes the default",
    );
    assert.equal(
      await press(
        t,
        rail.path("Folder", {
          default: "~/p/acme-vault",
          check: (v) => (v === "/v/z" ? null : `not trimmed: ${JSON.stringify(v)}`),
        }),
        ..."  /v/z ",
        ENTER,
      ),
      "/v/z",
      "what is typed is trimmed, before the check sees it",
    );
    assert.equal(t.screen().at(-1), "◇ Folder  /v/z");
    assert.equal(
      await press(t, rail.path("Folder", { default: "~/p/acme-vault" }), ..."   ", ENTER),
      "~/p/acme-vault",
      "only spaces typed: the default",
    );
    // No default: a bare Enter asks for a path. back: false — Esc is ignored and not offered.
    const bare = rail.path("Folder", { back: false });
    assert.equal(t.screen().at(-2), "│ enter confirm · ctrl+c cancel");
    await press(t, null, ENTER, ESC);
    await sleep(60);
    assert.equal(t.screen().at(-3), "│ ▲ type a path");
    assert.equal(await press(t, bare, "a", ENTER), "a");
    rail.close();
  },
);

test(
  "rail: answered questions and the ones a flag answered collapse alike, one line each, and close draws └ with its note",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open({ parts: ["0.30.0"] });
    rail.answered("Which folder is the project?", "~/p/acme");
    rail.answered("Install projectstore for", "Codex");
    await press(t, rail.select("Where should this project's notes live?", VAULT), ENTER);
    await press(t, rail.confirm("Show projectstore in Claude Code's status line?"), ENTER);
    rail.close();
    assert.deepEqual(t.screen(), [
      "┌ projectstore setup · 0.30.0",
      "│",
      "◇ Which folder is the project?  ~/p/acme",
      "│",
      "◇ Install projectstore for  Codex",
      "│",
      "◇ Where should this project's notes live?  Create ~/p/acme-vault",
      "│",
      "◇ Show projectstore in Claude Code's status line?  Yes",
      "└",
    ]);
    // A choice's `answer` is its answered text.
    const u = railTerm();
    const r = u.open();
    await press(
      u,
      r.select("Channel", [{ value: "npm", label: "Switch to npm", answer: "switch to npm" }, "keep"]),
      ENTER,
    );
    r.close("done");
    assert.deepEqual(u.screen().slice(2), ["◇ Channel  switch to npm", "└ done"]);
    assert.throws(() => r.answered("late", "x"), /closed/);
    await assert.rejects(r.select("late", ["a"]), /closed/);
  },
);

test(
  "rail: Ctrl+C and end of input cancel — CANCELLED, raw mode off, the cursor shown, and every later question cancelled at once without drawing",
  RAIL,
  async () => {
    for (const [how, key] of [
      ["Ctrl+C", CTRL_C],
      ["end of input", null],
    ]) {
      const t = railTerm();
      const rail = t.open();
      const pending = rail.multi("Install projectstore for", ["Claude Code", "Codex"]);
      await tick();
      if (key) t.stdin.write(key);
      else t.stdin.end();
      assert.equal(await pending, CANCELLED, how);
      assert.deepEqual(t.modes, [true, false], `${how}: raw mode off`);
      assert.ok(t.chunks.lastIndexOf(SHOW) > t.chunks.lastIndexOf(HIDE), `${how}: the cursor shown`);
      assert.equal(t.screen().at(-1), "▲ Install projectstore for  cancelled", how);
      assert.equal(rail.cancelled, true);
      const n = t.chunks.length;
      assert.equal(await rail.select("Next", ["a"]), CANCELLED, `${how}: a later question`);
      assert.equal(t.chunks.length, n, "draws nothing");
      assert.deepEqual(t.modes, [true, false], "and leaves raw mode alone");
      rail.answered("Which folder is the project?", "~/p/acme");
      assert.equal(t.chunks.length, n, `${how}: answered() after a cancel draws nothing`);
      rail.close("Cancelled — nothing was written");
      assert.equal(t.screen().at(-1), "└ Cancelled — nothing was written");
      assert.equal(handlers(t.proc), "0 0 0 0");
    }
    // End of input behind keys typed before it: they are answered first.
    const t = railTerm();
    const rail = t.open();
    t.stdin.write(ENTER);
    t.stdin.end();
    assert.equal(await rail.select("First", ["a", "b"]), "a");
    assert.equal(await rail.select("Second", ["a", "b"]), CANCELLED);
    rail.close();
  },
);

test(
  "rail: a question that throws restores the terminal as an answer does — raw mode off, the cursor shown, its line ended, stdin paused — and the rail still asks",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    const boom = rail.path("Which folder holds the vault?", {
      default: "/v",
      check: () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(press(t, boom, ENTER), /boom/);
    assert.deepEqual(t.modes, [true, false]);
    assert.deepEqual(t.chunks.slice(-2), ["\n", SHOW], "the frame's line ended, then the cursor shown");
    assert.equal(t.stdin.readableFlowing, false);
    assert.equal(await press(t, rail.select("Next", ["a", "b"]), DOWN, ENTER), "b");
    rail.close();
    assert.deepEqual(t.modes, [true, false, true, false]);
  },
);

test(
  "rail: ASCII glyphs from the table's ASCII column, every byte printable ASCII; no SGR under NO_COLOR; the roles' colours with colour",
  RAIL,
  async () => {
    const drive = async (env) => {
      const t = railTerm({ env });
      const rail = t.open();
      const multi = rail.multi("Tick", [{ value: "a", label: "a", reason: "first" }, "b"]);
      await tick();
      const frame = t.screen();
      await press(t, multi, SPACE, ENTER);
      await press(t, rail.select("Pick", ["a", "b"]), DOWN, ENTER);
      await press(t, rail.path("Folder", { default: "/v" }), ENTER);
      await press(t, rail.select("Last", ["a"]), CTRL_C);
      rail.close("Cancelled - nothing was written");
      return { t, frame };
    };
    const ascii = await drive({ NO_COLOR: "1", PROJECTSTORE_ASCII: "1" });
    assert.deepEqual(ascii.frame.slice(2), [
      "* Tick",
      "| -> [ ] a  first",
      "|    [ ] b",
      "| up/down move . space toggle . enter confirm . ctrl+c cancel",
    ]);
    assert.deepEqual(ascii.t.screen(), [
      "+ projectstore setup",
      "|",
      "o Tick  a",
      "|",
      "o Pick  b",
      "|",
      "o Folder  /v",
      "|",
      "! Last  cancelled",
      "+ Cancelled - nothing was written",
    ]);
    for (const ch of ascii.t.text())
      assert.ok(ch.codePointAt(0) <= 0x7e, `U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
    const select = railTerm({ env: { NO_COLOR: "1", PROJECTSTORE_ASCII: "1" } });
    select.open().select("Pick", ["a", "b"]);
    assert.deepEqual(select.screen().slice(3, 5), ["| (*) a", "| ( ) b"]);
    const bare = await drive({ NO_COLOR: "1" });
    for (const s of bare.t.chunks) assert.ok(!SGR_RE.test(s), JSON.stringify(s));
    // With colour: ◆ in the action role, the title in emphasis, the rail in explanation, ◇ in done, the cancel in attention.
    const rich = (await drive({})).t.text();
    for (const painted of [
      "\x1b[36m◆\x1b[39m",
      "\x1b[1mTick\x1b[22m",
      "\x1b[90m│\x1b[39m",
      "\x1b[32m◇\x1b[39m",
      "\x1b[33m▲\x1b[39m",
      "\x1b[90m┌\x1b[39m",
      "\x1b[90m└\x1b[39m",
    ]) {
      assert.ok(rich.includes(painted), JSON.stringify(painted));
    }
  },
);

test(
  "rail: one keypress queue — keys typed ahead, in the chunk that answered the question before or before a question is asked, wait for theirs",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    const first = rail.select("First", ["a", "b", "c"]);
    await tick();
    t.stdin.write(`${DOWN}${ENTER}${DOWN}${DOWN}${ENTER}${SPACE}`);
    assert.equal(await first, "b");
    assert.equal(
      await rail.select("Second", ["a", "b", "c"]),
      "c",
      "the keys after the first Enter, in the same chunk",
    );
    t.stdin.write(ENTER);
    await tick();
    assert.deepEqual(
      await rail.multi("Third", ["x", "y"]),
      ["x"],
      "the space typed ahead, then the Enter typed between the questions",
    );
    assert.deepEqual(
      t
        .screen()
        .slice(2)
        .filter((l) => l.startsWith("◇")),
      ["◇ First  b", "◇ Second  c", "◇ Third  x"],
    );
    rail.close();
  },
);

test(
  "rail: close draws └, drops keys typed ahead that no question took, pauses stdin and lets go of it, so the line-mode confirm reads the next line",
  RAIL,
  async () => {
    const t = railTerm();
    const rail = t.open();
    const q = rail.select("Pick", ["a", "b"]);
    await tick();
    t.stdin.write(`${ENTER}${ENTER}`);
    assert.equal(await q, "a");
    rail.close();
    rail.close();
    assert.equal(t.screen().at(-1), "└", "drawn once");
    assert.equal(t.stdin.readableFlowing, false);
    assert.equal(t.stdin.listenerCount("keypress"), 0);
    assert.equal(t.stdin.listenerCount("end"), 0);
    const out = new PassThrough();
    const answer = askLine("◆ Apply 2 changes? [Y/n] ", t.stdin, out);
    t.stdin.write("n\n");
    assert.equal(await answer, "n", "the Enter typed ahead did not answer the confirm");
    assert.deepEqual(t.modes, [true, false], "the confirm is line mode");
  },
);

test(
  "rail: close() while a question is asked cancels it — its line drawn, raw mode off, the cursor shown, the question settled CANCELLED and its finally run — then closes",
  RAIL,
  async () => {
    for (const [title, ask] of [
      ["Pick", (r) => r.select("Pick", ["a", "b"])],
      ["Folder", (r) => r.path("Folder", { default: "/v" })],
    ]) {
      const t = railTerm();
      const rail = t.open();
      const q = ask(rail);
      await tick();
      rail.close("Cancelled — nothing was written");
      assert.equal(t.modes.at(-1), false, "raw mode off at once, before the question settles");
      assert.ok(t.chunks.lastIndexOf(SHOW) > t.chunks.lastIndexOf(HIDE), "the cursor shown at once");
      assert.equal(await q, CANCELLED, "the question settles");
      assert.equal(rail.cancelled, true);
      assert.deepEqual(
        t.screen(),
        ["┌ projectstore setup", "│", `▲ ${title}  cancelled`, "└ Cancelled — nothing was written"],
        `${title}: its frame replaced by the cancelled line`,
      );
      assert.equal(t.chunks.at(-1), SHOW, "its finally ran: the restore is the last thing written");
      assert.equal(t.stdin.readableFlowing, false);
      assert.equal(t.stdin.listenerCount("keypress"), 0);
      assert.equal(handlers(t.proc), "0 0 0 0");
    }
    // A question busy in an asynchronous check when the rail closes settles CANCELLED once the check returns, and draws nothing more.
    const t = railTerm();
    const rail = t.open();
    let release;
    const q = rail.path("Folder", {
      default: "/v",
      check: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    await press(t, null, ENTER);
    await tick();
    rail.close();
    const n = t.chunks.length;
    release(null);
    assert.equal(await q, CANCELLED);
    assert.deepEqual(t.chunks.slice(n), [SHOW], "only the finally's restore after close");
    assert.deepEqual(t.screen().slice(-2), ["▲ Folder  cancelled", "└"]);
  },
);

test(
  "rail: the exit, SIGTERM, SIGHUP and SIGINT handlers are added at open and removed at close; a signal restores the terminal, removes them and raises itself again; exit restores",
  RAIL,
  async () => {
    const t = railTerm();
    assert.equal(handlers(t.proc), "0 0 0 0");
    const rail = t.open();
    assert.equal(handlers(t.proc), "1 1 1 1");
    rail.close();
    assert.equal(handlers(t.proc), "0 0 0 0");
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
      const u = railTerm();
      const r = u.open();
      const q = r.select("Pick", ["a", "b"]);
      await tick();
      u.proc.emit(sig, sig);
      assert.deepEqual(u.modes, [true, false], `${sig}: raw mode off`);
      assert.deepEqual(u.chunks.slice(-2), [SHOW, "\n"], `${sig}: the cursor shown, the question's line ended`);
      assert.equal(handlers(u.proc), "0 0 0 0", `${sig}: the handlers gone`);
      assert.deepEqual(u.proc.killed, [[4242, sig]], `${sig}: raised again at the process`);
      // The stand-in does not die; the question still settles.
      assert.equal(await press(u, q, CTRL_C), CANCELLED);
      r.close();
    }
    const v = railTerm();
    const r = v.open();
    const q = r.select("Pick", ["a"]);
    await tick();
    v.proc.emit("exit", 0);
    assert.deepEqual(v.modes, [true, false], "exit: raw mode off");
    assert.equal(v.chunks.at(-1), SHOW, "exit: the cursor shown");
    assert.equal(handlers(v.proc), "0 1 1 1", "exit's handler runs once");
    assert.equal(await press(v, q, ENTER), "a");
    r.close();
    assert.equal(handlers(v.proc), "0 0 0 0");
    assert.deepEqual(v.proc.killed, []);
  },
);

test(
  "rail: on a narrow terminal a reason that would pass the width moves under its label, a label wider than the terminal wraps whole, and every redraw leaves nothing behind",
  RAIL,
  async () => {
    const t = railTerm({ columns: 30 });
    const rail = t.open();
    const long = "Create /a/very/long/path/to/the/acme-vault";
    const list = [
      { value: 1, label: long, reason: "a new vault beside the project" },
      { value: 2, label: "Not now", reason: "unbound" },
    ];
    const q = rail.select("Vault?", list);
    const first = t.screen();
    assert.deepEqual(first, [
      "┌ projectstore setup",
      "│",
      "◆ Vault?",
      "│ ● Create /a/very/long/path/t", // the label, whole, wrapped by the terminal at 30
      "o/the/acme-vault",
      "│   a new vault beside the",
      "│   project",
      "│ ○ Not now  unbound",
      "│ up/down move ·", // the hint breaks between its keys only
      "│ enter choose ·",
      "│ ctrl+c cancel",
    ]);
    await press(t, null, DOWN);
    await tick();
    assert.deepEqual(
      t.screen(),
      first.map((l) => l.replace("●", "◌").replace("○", "●").replace("◌", "○")),
      "the same rows, the mark moved",
    );
    await press(t, null, UP);
    await tick();
    assert.deepEqual(t.screen(), first, "and back");
    assert.equal(await press(t, q, ENTER), 1);
    assert.deepEqual(
      t.screen(),
      ["┌ projectstore setup", "│", "◇ Vault?  Create /a/very/long/", "path/to/the/acme-vault"],
      "one answered line, wrapped by the terminal",
    );
    // A path's Esc takes back an answered line that wrapped.
    const p = rail.path("Folder?", { default: "/v" });
    await press(t, null, ESC);
    assert.equal(await p, BACK);
    assert.deepEqual(t.screen(), ["┌ projectstore setup"]);
    rail.close();
  },
);

test("rail: one question at a time", RAIL, async () => {
  const t = railTerm();
  const rail = t.open();
  const q = rail.select("Pick", ["a"]);
  await assert.rejects(rail.select("Another", ["b"]), /already asking/);
  assert.equal(await press(t, q, ENTER), "a");
  await assert.rejects(
    Promise.resolve().then(() => rail.select("Empty", [])),
    /no choices/,
  );
  rail.close();
});

// ─── The settings menu's screen (contract 14, amended 2026-10-13) ───────

function screenTerm({ columns = 100, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => ((stdin.isRaw = on), stdin);
  const chunks = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (s) => (chunks.push(String(s)), true),
  });
  const kills = [];
  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: (pid, sig) => (kills.push(sig), true) });
  return { stdin, stdout, proc, kills, text: () => chunks.join("") };
}
const LIVE = { color: false, live: true, width: 100, columns: 100, ascii: false };

test("screen: the alternate screen and raw mode for its whole life; keys by name, resize, wake and drain in one queue; close restores", async () => {
  assert.throws(
    () => openScreen({ stdin: new PassThrough(), stdout: { isTTY: false, write() {} }, caps: PLAIN }),
    /no screen/,
  );
  const t = screenTerm({ rows: 3 });
  const s = openScreen({ stdin: t.stdin, stdout: t.stdout, caps: LIVE, proc: t.proc, escapeMs: 5 });
  assert.equal(t.stdin.isRaw, true);
  assert.ok(t.text().startsWith(`${ALT_ON}\x1b[?25l`), "the alternate screen, the cursor hidden");
  t.stdin.write("\x1b[A\x1b[B\x1b[C\x1b[D \rq\x7f\x03");
  const keys = [];
  for (let k = 0; k < 9; k++) keys.push(await s.next());
  assert.deepEqual(keys, ["up", "down", "right", "left", "space", "enter", { char: "q" }, "backspace", "cancel"]);
  t.stdout.emit("resize");
  s.wake("models");
  assert.deepEqual([await s.next(), await s.next()], ["resize", "models"]);
  t.stdin.write("\r\r");
  await new Promise(setImmediate);
  s.drain();
  s.wake("after");
  assert.equal(await s.next(), "after", "the queued Enters were dropped");
  s.draw(["one", "two", "three", "four"]);
  const frame = t.text().split("\x1b[H").at(-1);
  assert.equal(
    frame,
    "\x1b[2Kone\r\n\x1b[2Ktwo\r\n\x1b[2Kthree\x1b[J",
    "at most `rows` lines, each after an erase, no newline after the last",
  );
  assert.equal(t.proc.listenerCount("SIGINT"), 1);
  s.close();
  assert.equal(t.stdin.isRaw, false);
  assert.ok(t.text().endsWith(`\x1b[?25h${ALT_OFF}`), "the cursor shown and the alternate screen left");
  assert.equal(t.proc.listenerCount("SIGINT"), 0);
  assert.equal(t.proc.listenerCount("exit"), 0);
  assert.equal(t.stdin.listenerCount("keypress"), 0);
  s.close();
  assert.equal(t.text().split(ALT_OFF).length - 1, 1, "a second close does nothing");
});

test("screen: a lone Esc is escape, after the escape timeout; drain drops what is queued and what arrives in the next turns, but never Ctrl+C", async () => {
  const t = screenTerm();
  const s = openScreen({ stdin: t.stdin, stdout: t.stdout, caps: LIVE, proc: t.proc, escapeMs: 5 });
  t.stdin.write("\x1b");
  assert.equal(await s.next(), "escape");
  t.stdin.write("\r\r");
  await new Promise(setImmediate);
  s.drain(2);
  t.stdin.write("\r\x03");
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  t.stdin.write("q");
  assert.equal(await s.next(), "cancel", "Ctrl+C survives the drain");
  assert.deepEqual(await s.next(), { char: "q" }, "a key after the drain's turns arrives");
  s.close();
});

test("screen: a signal restores the terminal, removes its handlers and raises itself again; exit restores", () => {
  const t = screenTerm();
  openScreen({ stdin: t.stdin, stdout: t.stdout, caps: LIVE, proc: t.proc });
  t.proc.emit("SIGTERM");
  assert.equal(t.stdin.isRaw, false);
  assert.ok(t.text().endsWith(`\x1b[?25h${ALT_OFF}`));
  assert.deepEqual(t.kills, ["SIGTERM"]);
  assert.equal(t.proc.listenerCount("SIGTERM"), 0);
  const u = screenTerm();
  openScreen({ stdin: u.stdin, stdout: u.stdout, caps: LIVE, proc: u.proc });
  u.proc.emit("exit");
  assert.equal(u.stdin.isRaw, false);
  assert.ok(u.text().endsWith(ALT_OFF));
});

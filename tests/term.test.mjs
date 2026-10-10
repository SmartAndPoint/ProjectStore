// projectstore — tests for term.mjs: the terminal presentation the write verbs
// use (install spec, contract 18). Colour and in-place lines are for a person
// at a terminal; a pipe — an agent's tool call, CI — gets the same layout as
// plain text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { caps, painter, icon, duration, plain, stepReporter, liveLine, wrap, askLine, askApply } from "../scripts/term.mjs";

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
  assert.match(piped.chunks[0], /^ {2}✗ shared AGENTS\.md +skipped {2}\d+\.\ds\n$/);
  q.end(true);
  assert.equal(piped.chunks.length, 1, "an end without a start writes nothing");
});

test("term: a live label fits one row, a nested start closes the open line, abort ends it as failed", () => {
  const live = sink(tty(40));
  const r = stepReporter(live.stream, caps(live.stream, {}), { indent: 6 });
  r.start("$ claude plugin marketplace add /a/very/long/path/that/would/wrap/the/row");
  assert.ok(plain(live.chunks[0]).length <= 39, plain(live.chunks[0]));
  assert.ok(plain(live.chunks[0]).endsWith("…") || plain(live.chunks[0]).includes("…"), "cut, and marked as cut");
  r.start("$ claude plugin install x");
  assert.equal(live.chunks[1], "\n", "the open line is closed where it stands, not overwritten");
  r.abort();
  assert.match(plain(live.chunks.at(-1)), /✗ \$ claude plugin install x/);
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
  const via = (answer, n = 3, paint) => askApply(n, { ask: async (q) => { asked.push(q); return answer; }, ...(paint ? { paint } : {}) });
  for (const yes of ["", "y", "Y", "yes", "YES", "  yes  "]) assert.equal(await via(yes), true, JSON.stringify(yes));
  for (const no of ["n", "no", "nope", "yess", "x"]) assert.equal(await via(no), false, JSON.stringify(no));
  for (const eof of [null, undefined]) assert.equal(await via(eof), false, `${eof} is end of input`);
  assert.equal(asked[0], "Apply 3 changes? [Y/n] ");
  await via("", 1);
  assert.equal(asked.at(-1), "Apply 1 change? [Y/n] ");
  await via("", 2, painter({ color: true }));
  assert.equal(asked.at(-1), "\x1b[1mApply 2 changes?\x1b[22m \x1b[90m[Y/n]\x1b[39m ", "bold question, grey keys");
  // Through a stream, as at a terminal: the question is all that is written, and end of input is a no.
  const input = new PassThrough(), output = new PassThrough();
  let written = "";
  output.on("data", (d) => { written += d; });
  const pending = askApply(4, { stdin: input, stdout: output });
  input.end();
  assert.equal(await pending, false);
  assert.equal(written, "Apply 4 changes? [Y/n] \n");
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
  assert.ok(a.chunks.at(-1).startsWith("\r\x1b[2K  FAIL fetch failed projectstore-codex@0.30.0 "), a.chunks.at(-1));
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

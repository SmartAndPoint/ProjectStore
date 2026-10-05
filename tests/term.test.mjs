// projectstore — tests for term.mjs: the terminal presentation the write verbs
// use (install spec, contract 18). Colour and in-place lines are for a person
// at a terminal; a pipe — an agent's tool call, CI — gets the same layout as
// plain text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { caps, painter, icon, duration, plain, stepReporter, wrap, askLine } from "../scripts/term.mjs";

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
  assert.equal((await ask((i) => i.end())).answer, null, "end of input (Ctrl+D) is null — a no — and the promise settles");
  assert.equal((await ask((i) => { i.write("ye"); i.end(); })).answer, null, "a half-typed answer cut by end of input is not an answer");
});

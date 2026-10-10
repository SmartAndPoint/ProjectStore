// projectstore — term.mjs: terminal presentation for the write verbs, with no
// dependency (the zero-dependency property the MCP and link-graph ADRs keep).
//
// One question decides everything here: is this a person at a terminal? Then
// colour and in-place step lines. Otherwise — a pipe, an agent's tool call,
// CI — the same layout as plain text, so a reader that is not a terminal loses
// nothing but the escapes (install spec, contract 18).
//
//   caps(stream, env)            → { color, live, width, ascii }
//   painter(caps)                → paint(style, text)
//   icon(caps, name)             → the glyph for an action or a result
//   duration(ms)                 → "0.4s", "12s", "1m 03s"
//   wrap(text, width, indent)    → prose broken at spaces, hanging indent
//   stepReporter(stream, caps)   → { start(label), end(ok, note), abort() }
//   liveLine(stream, caps, label) → { end(ok, doneLabel, note), abort() }
//   askLine(question, in, out)   → the answer, or null on end of input
//   askApply(n, opts)            → contract 9's question; true applies

import { createInterface } from "node:readline/promises";

// FORCE_COLOR decides when it is set, as Node's own tty reads it: "", "1",
// "2", "3" or "true" turn colour on even without a terminal, anything else
// ("0", "false") turns it off. Otherwise NO_COLOR (https://no-color.org) turns
// colour off when set to anything non-empty, and TERM=dumb means a terminal
// that understands no escapes.
export function caps(stream = process.stdout, env = process.env) {
  const tty = Boolean(stream && stream.isTTY);
  const dumb = env.TERM === "dumb";
  const off = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = env.FORCE_COLOR !== undefined ? ["", "1", "2", "3", "true"].includes(String(env.FORCE_COLOR)) : tty && !dumb && !off;
  const columns = tty && Number(stream.columns) > 0 ? Number(stream.columns) : 100;
  // `width` lays out prose (never below 40); `columns` is the terminal's
  // real width, which a live line must not reach.
  return { color, live: tty && !dumb, width: Math.max(40, Math.min(columns, 120)), columns, ascii: dumb };
}

const SGR = {
  bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39],
};

// Raw SGR rather than util.styleText: that arrived in Node 20.12 and 21.7, and
// the package promises >=20.0.0.
export function painter(c) {
  return (style, text) => {
    const s = String(text);
    if (!c.color || !SGR[style] || !s) return s;
    return `\x1b[${SGR[style][0]}m${s}\x1b[${SGR[style][1]}m`;
  };
}

const ICONS = {
  create: ["+", "+"], update: ["↻", "~"], migrate: ["↻", "~"], refresh: ["↻", "~"],
  remove: ["✕", "x"], cleanup: ["✕", "x"], skip: ["·", "."], refuse: ["!", "!"],
  ok: ["✓", "ok"], fail: ["✗", "FAIL"], running: ["…", "..."], note: ["!", "!"],
  fetch: ["↓", "v"],
};

// The spinner (presentation spec contract 4): braille frames, one every 80 ms.
// ASCII glyphs get none — a live line there shows "..." and the elapsed time.
export const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const SPIN_MS = 80;
// Nothing is drawn before this: a fetch from a warm npm cache ends in about
// half a second, and a spinner that flashes for one frame is noise.
const QUIET_MS = 300;
export function icon(c, name) {
  const pair = ICONS[name] || ICONS.update;
  return c.ascii ? pair[1] : pair[0];
}

export function duration(ms) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000), s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// Strip SGR escapes — for measuring a painted string and for tests.
export const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

// Prose only: broken at spaces to `width` columns, every line after the first
// indented by `indent`. A word longer than the line — a path, a command — is
// never broken: a path cut in two cannot be copied back. Width 0 is a reader
// that is not a terminal: nothing is broken, so a search never meets a split.
export function wrap(text, width, indent = "") {
  if (!width) return String(text);
  const room = Math.max(20, width - indent.length);
  const lines = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && plain(line).length + 1 + plain(word).length > room) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.map((l, k) => (k ? indent + l : l)).join("\n");
}

// A live line must fit one physical row: "\r\x1b[2K" clears only the row the
// cursor is on, so a label that wrapped would leave its first half behind.
const fit = (text, room) => (text.length <= room ? text : text.slice(0, Math.max(1, room - 1)) + "…");

// One row of a step line: the mark, the label cut to the row on a live
// terminal, and the right-hand note aligned to the row's end. One column
// short of the terminal: a line that fills the last column leaves some
// terminals waiting to wrap.
function rowFor(c, indent) {
  const width = Math.min(c.width, c.columns || c.width, 100) - 1;
  return (mark, label, right) => {
    const room = width - indent - plain(mark).length - 1 - plain(right).length - 1;
    const left = `${" ".repeat(indent)}${mark} ${c.live ? fit(label, room) : label}`;
    const gap = Math.max(1, width - plain(left).length - plain(right).length);
    return left + " ".repeat(gap) + right;
  };
}

// One line per step. On a live terminal the line appears when the step starts
// (ending in "…") and is rewritten in place with the result and duration when
// it ends; anything else gets the finished line only. Steps run synchronously
// (spawnSync), so nothing animates in between — the "…" is the honest state.
export function stepReporter(stream = process.stdout, c = caps(stream), { indent = 2 } = {}) {
  const paint = painter(c);
  let open = null;
  const line = rowFor(c, indent);
  const self = {
    start(label) {
      // A step started while another is still open (a host command run by a
      // rollback) closes the open line where it stands rather than overwrite it.
      if (open && c.live) stream.write("\n");
      open = { label, t0: Date.now() };
      if (c.live) stream.write(line(paint("gray", icon(c, "running")), label, ""));
    },
    end(ok = true, note = "", { kept = false } = {}) {
      if (!open) return;
      const ms = Date.now() - open.t0;
      // A step that ran and left its target in place is neither ✓ nor ✗.
      const mark = !ok ? paint("red", icon(c, "fail")) : kept ? paint("gray", icon(c, "skip")) : paint("green", icon(c, "ok"));
      const right = paint("gray", [note, duration(ms)].filter(Boolean).join("  "));
      const text = line(mark, open.label, right);
      stream.write((c.live ? "\r\x1b[2K" : "") + text + "\n");
      open = null;
    },
    // An exception left a step open: end its line as failed, so whatever is
    // printed next starts on a line of its own.
    abort() { if (open) self.end(false); },
  };
  return self;
}

// A line for work that runs asynchronously, so it can animate (presentation
// spec contract 8, its asynchronous part; built for the shell fetch of
// install and upgrade, reused by an asynchronous APPLY). It starts on
// creation. On a live terminal nothing shows for the first 300 ms; then the
// spinner in the action role, the label and the elapsed time, redrawn in
// place every 80 ms and cut to one row. Under ASCII glyphs the frames are
// "..." with the elapsed time. PROJECTSTORE_NO_ANIMATION, set non-empty, draws
// the "…" line at once, as stepReporter does, and then only the finished one.
// On a pipe there is one finished line and no escape. `end` replaces the line
// with ✓ or the fail glyph, the past-tense label and the duration. No byte
// bar: npm gives a child no byte counts, and a bar is shown only when the size
// is known. The timers are unref'd and cleared by both `end` and `abort`, so
// a forgotten line never holds the process; the cursor is never hidden, so no
// exit path has anything to restore. `now` and `timers` are the test's clock.
export function liveLine(stream = process.stdout, c = caps(stream), label = "", { env = process.env, now = Date.now, timers = globalThis, indent = 2 } = {}) {
  const paint = painter(c);
  const line = rowFor(c, indent);
  const t0 = now();
  const still = Boolean(env.PROJECTSTORE_NO_ANIMATION);
  let drawn = false, frame = 0, wait = null, tick = null, settled = false;
  const unref = (h) => { try { h?.unref?.(); } catch {} return h; };
  const stop = () => {
    if (wait !== null) { timers.clearTimeout(wait); wait = null; }
    if (tick !== null) { timers.clearInterval(tick); tick = null; }
  };
  const draw = () => {
    const mark = c.ascii ? "..." : paint("cyan", SPINNER[frame++ % SPINNER.length]);
    stream.write("\r\x1b[2K" + line(mark, label, paint("gray", duration(now() - t0))));
    drawn = true;
  };
  if (c.live && still) { stream.write(line(paint("gray", icon(c, "running")), label, "")); drawn = true; }
  else if (c.live) {
    wait = unref(timers.setTimeout(() => {
      wait = null;
      draw();
      tick = unref(timers.setInterval(draw, SPIN_MS));
    }, QUIET_MS));
  }
  return {
    end(ok = true, doneLabel = label, note = "") {
      if (settled) return;
      settled = true;
      stop();
      const mark = ok ? paint("green", icon(c, "ok")) : paint("red", icon(c, "fail"));
      const right = paint("gray", [note, duration(now() - t0)].filter(Boolean).join("  "));
      stream.write((c.live && drawn ? "\r\x1b[2K" : "") + line(mark, doneLabel, right) + "\n");
    },
    // An exception mid-work: the timers go and the drawn row is cleared, so
    // whatever is printed next starts clean.
    abort() {
      if (settled) return;
      settled = true;
      stop();
      if (c.live && drawn) stream.write("\r\x1b[2K");
    },
  };
}

// One line of input, read the way a shell's own prompt is: in the terminal's
// line mode, so readline writes nothing but the question (no cursor escapes),
// the terminal does the editing, and Ctrl+C is a real SIGINT (exit 130, before
// anything is written). End of input — Ctrl+D, a closed pipe — is null, which
// every caller reads as no; it never leaves the question pending (an unsettled
// promise is exit 13 with a warning). The promise API rejects on close in
// some Node versions and stays pending in others; both settle here.
export async function askLine(question, input, output) {
  const rl = createInterface({ input, output, terminal: false });
  return await new Promise((settle) => {
    let done = false;
    const finish = (answer) => { if (done) return; done = true; settle(answer); rl.close(); };
    // End of input echoes no newline: end the question's line, so whatever is
    // printed next ("Nothing written.") starts on a line of its own.
    rl.on("close", () => { if (!done) output.write("\n"); finish(null); });
    rl.question(question).then((a) => finish(a), () => finish(null));
  });
}

// The install spec's contract 9 question, for every verb that asks it — the
// install family and `scaffold --write` at a terminal. Its bytes and its
// answer rule live here once, so two verbs cannot drift into two questions:
// `Apply N changes? [Y/n] `; Enter, y or yes (any case) applies; anything
// else is a no, and so is end of input. Whether to ask at all is the
// caller's (install-harness.mjs's isInteractive). `ask` stands in for the
// terminal in tests and means "this is one"; it gets the question and
// returns the answer.
export async function askApply(n, { stdin = null, stdout = null, ask = null, paint = (_style, text) => String(text) } = {}) {
  const question = `${paint("bold", `Apply ${n === 1 ? "1 change" : `${n} changes`}?`)} ${paint("gray", "[Y/n]")} `;
  const answer = ask ? await ask(question) : await askLine(question, stdin, stdout);
  if (answer === null || answer === undefined) return false;
  return /^(y(es)?)?$/i.test(String(answer).trim());
}

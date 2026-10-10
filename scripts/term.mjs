// projectstore — term.mjs: terminal presentation for the write verbs, with no
// dependency (the zero-dependency property the MCP and link-graph ADRs keep).
//
// One question decides everything here: is this a person at a terminal? Then
// colour and in-place step lines. Otherwise — a pipe, an agent's tool call,
// CI — the same layout as plain text, so a reader that is not a terminal loses
// nothing but the escapes (install spec, contract 18). The layout itself —
// the glyph table, the colour roles and the primitives every screen is built
// from — is the presentation spec's (*Terminal presentation of the
// projectstore CLI: layout, glyphs, colour roles, questions and live lines*,
// contracts 2–6 and 8).
//
//   caps(stream, env)            → { color, live, width, columns, ascii }
//   painter(caps)                → paint(style or role, text)
//   icon(caps, name)             → a glyph or separator from GLYPHS
//   duration(ms)                 → "0.4s", "12s", "1m 03s"
//   wrap(text, width, indent)    → prose broken at spaces, hanging indent
//   badge(caps, head, parts)     → a screen's first line
//   heading(caps, title, counts) → "Plan — 3 to add · 5 unchanged"
//   rows(caps, list, opts)       → aligned glyph · action · target · note lines
//   rule(caps, length)           → a horizontal rule
//   kv(caps, pairs, opts)        → aligned key–value lines
//   commandBlock(caps, cmds)     → commands on their own lines (contract 6)
//   stepReporter(stream, caps)   → { start(label), end(ok, note, opts), abort() }
//   liveLine(stream, caps, label) → { end(ok, doneLabel, note), abort() }
//   askLine(question, in, out)   → the answer, or null on end of input
//   askApply(n, opts)            → contract 9's question; true applies

import { createInterface } from "node:readline/promises";

// FORCE_COLOR decides when it is set, as Node's own tty reads it: "", "1",
// "2", "3" or "true" turn colour on even without a terminal, anything else
// ("0", "false") turns it off. Otherwise NO_COLOR (https://no-color.org) turns
// colour off when set to anything non-empty, and TERM=dumb means a terminal
// that understands no escapes.
//
// Glyphs are a switch of their own (presentation spec contract 2): ASCII
// under TERM=dumb or PROJECTSTORE_ASCII set non-empty, Unicode otherwise, in
// every mode. PROJECTSTORE_ASCII changes glyphs only — colour, live lines and
// questions follow the stream — so a terminal that draws ambiguous-width
// characters wide still gets aligned rows, in colour.
export function caps(stream = process.stdout, env = process.env) {
  const tty = Boolean(stream && stream.isTTY);
  const dumb = env.TERM === "dumb";
  const off = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = env.FORCE_COLOR !== undefined ? ["", "1", "2", "3", "true"].includes(String(env.FORCE_COLOR)) : tty && !dumb && !off;
  const columns = tty && Number(stream.columns) > 0 ? Number(stream.columns) : 100;
  const ascii = dumb || (env.PROJECTSTORE_ASCII !== undefined && env.PROJECTSTORE_ASCII !== "");
  // `width` lays out prose (never below 40); `columns` is the terminal's
  // real width, which a live line must not reach.
  return { color, live: tty && !dumb, width: Math.max(40, Math.min(columns, 120)), columns, ascii };
}

// The sixteen ANSI colours, bold and dim — never 256-colour or truecolor, so
// the reader's terminal theme decides the shades, light or dark.
const SGR = {
  bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39],
};

// The colour roles (presentation spec contract 3), each one style above.
// Colour never carries meaning alone: whatever wears a role also has a glyph
// or a word that says the same.
//   action       the active question, a command to run, a verb, a fetch
//   done         ✓, an added row's glyph, a zero-issue count
//   attention    ▲, a channel switch, a refusal, a warning count
//   error        ✕, a failed step, an issue count
//   explanation  notes, reasons, consent lines, the rail, the project path
//   emphasis     headings, a question's title, a finding's title
export const ROLES = Object.freeze({ action: "cyan", done: "green", attention: "yellow", error: "red", explanation: "gray", emphasis: "bold" });

// Raw SGR rather than util.styleText: that arrived in Node 20.12 and 21.7, and
// the package promises >=20.0.0. `style` is a role or a style name; anything
// else, like a null role, paints nothing.
export function painter(c) {
  return (style, text) => {
    const s = String(text);
    const sgr = SGR[ROLES[style] || style];
    if (!c.color || !sgr || !s) return s;
    return `\x1b[${sgr[0]}m${s}\x1b[${sgr[1]}m`;
  };
}

// The one glyph table (presentation spec contract 4): every glyph and
// separator a renderer composes, as [Unicode, ASCII]. The ASCII column is
// used when caps().ascii says so. Changes from 0.29.2: fail ✗ → ✕ (FAIL →
// x); remove and cleanup ✕ → − (x → -); refuse and note ! → ▲.
export const GLYPHS = Object.freeze({
  ok: Object.freeze(["✓", "ok"]),
  add: Object.freeze(["+", "+"]),
  fail: Object.freeze(["✕", "x"]),
  update: Object.freeze(["↻", "~"]),
  warning: Object.freeze(["▲", "!"]),
  switch: Object.freeze(["⇄", "<>"]),
  unchanged: Object.freeze(["·", "."]),
  remove: Object.freeze(["−", "-"]),
  fetch: Object.freeze(["↓", "v"]),
  running: Object.freeze(["…", "..."]),
  ask: Object.freeze(["◆", "*"]),
  answered: Object.freeze(["◇", "o"]),
  choiceOn: Object.freeze(["●", "(*)"]),
  choiceOff: Object.freeze(["○", "( )"]),
  checkOn: Object.freeze(["◼", "[x]"]),
  checkOff: Object.freeze(["◻", "[ ]"]),
  rail: Object.freeze(["│", "|"]),
  railTop: Object.freeze(["┌", "+"]),
  railEnd: Object.freeze(["└", "+"]),
  rule: Object.freeze(["─", "-"]),
  progressDone: Object.freeze(["━", "#"]),
  progressLeft: Object.freeze(["╺", "-"]),
  dash: Object.freeze(["—", "-"]),
  dot: Object.freeze(["·", "."]),
  // A move or a state change in a step's text: `a → b` (decided 2026-10-10,
  // added to the spec's table at the story's close-out).
  transition: Object.freeze(["→", "->"]),
});

// The other names a glyph answers to: the spec's shared rows (fail / issue,
// warning / refusal / note, unchanged / skipped) and the plan's own action
// names, so a caller says what happened rather than which shape to draw.
export const GLYPH_ALIASES = Object.freeze({
  issue: "fail", refuse: "warning", refusal: "warning", note: "warning",
  skip: "unchanged", skipped: "unchanged", create: "add", migrate: "update", refresh: "update",
  cleanup: "remove", prune: "remove",
});

// The spinner (presentation spec contract 4): braille frames, one every 80 ms.
// ASCII glyphs get none — a live line there shows "..." and the elapsed time.
export const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const SPIN_MS = 80;
// Nothing is drawn before this: a fetch from a warm npm cache ends in about
// half a second, and a spinner that flashes for one frame is noise.
const QUIET_MS = 300;
// A name the table does not know draws the update glyph, as 0.29.2's did: a
// plan row is never left without a mark.
export function icon(c, name) {
  const pair = GLYPHS[name] || GLYPHS[GLYPH_ALIASES[name]] || GLYPHS.update;
  return c && c.ascii ? pair[1] : pair[0];
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

// An in-flight frame must fit one physical row: "\r\x1b[2K" clears only the
// row the cursor is on, so a label that wrapped would leave its first half
// behind. The cut is marked with the table's running glyph — "...", room
// reserved for all three, under ASCII glyphs.
const fit = (c, text, room) => {
  if (text.length <= room) return text;
  const mark = icon(c, "running");
  return text.slice(0, Math.max(1, room - mark.length)) + mark;
};

// The columns a line may fill: one short of the terminal — a line that fills
// the last column leaves some terminals waiting to wrap — and never past 100.
const rowWidth = (c) => Math.min(c.width, c.columns || c.width, 100) - 1;

// One row of a step line: the mark, the label, and the right-hand note
// aligned to the row's end. Only an in-flight frame (`cut`) is cut to the
// row, and only on a live terminal (presentation spec contract 8): the
// finished line that replaces it carries the whole target, and the terminal
// wraps it where it must.
function rowFor(c, indent) {
  const width = rowWidth(c);
  return (mark, label, right, { cut = false } = {}) => {
    const room = width - indent - plain(mark).length - 1 - plain(right).length - 1;
    const left = `${" ".repeat(indent)}${mark} ${cut && c.live ? fit(c, label, room) : label}`;
    const gap = Math.max(1, width - plain(left).length - plain(right).length);
    return left + " ".repeat(gap) + right;
  };
}

// ─── Layout primitives (presentation spec contracts 5–7) ─────────────────
//
// Pure: each returns text for its caller to print. Cells are measured on
// plain() width, so a painted cell and an unpainted one align alike.

const separated = (c) => ` ${icon(c, "dot")} `;

// A screen's first line: the head in the emphasis role, then its parts, each
// after the dot separator — `projectstore install · Claude Code, Codex`.
export function badge(c, head, parts = []) {
  const shown = parts.filter((x) => x !== null && x !== undefined && x !== "");
  return [painter(c)("emphasis", head), ...shown].join(separated(c));
}

// A heading: the title in the emphasis role and, when there are any, its
// counts after the dash separator, joined by the dot separator. A count is a
// string or [text, role] — `Plan — 3 to add · 1 to update · 5 unchanged`,
// each number in its role's colour.
export function heading(c, title, counts = []) {
  const paint = painter(c);
  const parts = counts.filter(Boolean).map((x) => (Array.isArray(x) ? paint(x[1], x[0]) : String(x)));
  const head = paint("emphasis", title);
  return parts.length ? `${head} ${icon(c, "dash")} ${parts.join(separated(c))}` : head;
}

// Aligned rows (contract 5): glyph · action word · target · note. Each column
// is as wide as its widest cell in the block — the target column over the
// rows that carry a note, since nothing else aligns after it — and an empty
// column takes no room. Nothing is boxed and nothing is cut: a target is
// never truncated or broken. On a live terminal a row that would pass the
// width moves its note to the next line, indented to the target column, where
// a long note wraps; anywhere else each row stays one line, whole, for a
// reader that greps. A row is { glyph, role, action, target, note }: `glyph`
// a name in GLYPHS or an alias, `role` the colour of the glyph and the action
// word; the note is in the explanation role.
export function rows(c, list, { indent = 2 } = {}) {
  const paint = painter(c);
  const cells = list.map((r) => ({ glyph: r.glyph ? icon(c, r.glyph) : "", role: r.role || null, action: String(r.action ?? ""), target: String(r.target ?? ""), note: String(r.note ?? "") }));
  const widest = (xs) => Math.max(0, ...xs.map((s) => plain(s).length));
  const gw = widest(cells.map((r) => r.glyph));
  const aw = widest(cells.map((r) => r.action));
  const tw = widest(cells.filter((r) => r.note).map((r) => r.target));
  const width = c.live ? rowWidth(c) : 0;
  const cell = (text, w, role) => paint(role, text) + " ".repeat(w - plain(text).length);
  const out = [];
  for (const r of cells) {
    let lead = " ".repeat(indent);
    if (gw) lead += cell(r.glyph, gw, r.role) + " ";
    if (aw) lead += cell(r.action, aw, r.role) + "  ";
    if (!r.note) { out.push((lead + r.target).trimEnd()); continue; }
    const line = `${lead}${cell(r.target, tw, null)}  ${paint("explanation", r.note)}`;
    if (!width || plain(line).length <= width) { out.push(line); continue; }
    const col = plain(lead).length;
    const pad = " ".repeat(col);
    out.push((lead + r.target).trimEnd());
    out.push(...wrap(r.note, width, pad).split("\n").map((l, k) => pad + paint("explanation", k ? l.slice(col) : l)));
  }
  return out;
}

// A horizontal rule in the explanation role, as wide as a row may be.
export function rule(c, length = rowWidth(c)) {
  return painter(c)("explanation", icon(c, "rule").repeat(Math.max(0, length)));
}

// Key–value lines (contracts 8 and 12): each key in the explanation role,
// padded to the widest key, then two spaces and the value as it is. A key
// with no value is printed alone, with nothing after it.
export function kv(c, pairs, { indent = 2 } = {}) {
  const paint = painter(c);
  const kw = Math.max(0, ...pairs.map(([k]) => plain(k).length));
  return pairs.map(([k, v]) => {
    const value = v === null || v === undefined ? "" : String(v);
    const key = `${" ".repeat(indent)}${paint("explanation", k)}`;
    return value ? `${key}${" ".repeat(kw - plain(k).length)}  ${value}` : key;
  });
}

// Commands the renderer composes (contract 6): a blank line, then each
// command on a line of its own in the action role, with nothing after it —
// no punctuation, no prose — so a copy takes exactly the command. Never
// wrapped: a command broken in two cannot be pasted back.
export function commandBlock(c, commands, { indent = 2 } = {}) {
  const paint = painter(c);
  return ["", ...commands.map((cmd) => `${" ".repeat(indent)}${paint("action", cmd)}`)];
}

// One line per step. On a live terminal the line appears when the step starts
// (marked "…", cut to one row) and is rewritten in place with the result, the
// whole label and the duration when it ends; anything else gets the finished
// line only. Steps run synchronously
// (spawnSync), so nothing animates in between — the "…" is the honest state.
// `end` may name the finished line in other words than the running one
// (`label`: "adding …" while it runs, "added …" once it has); `now` is the
// test's clock.
export function stepReporter(stream = process.stdout, c = caps(stream), { indent = 2, now = Date.now } = {}) {
  const paint = painter(c);
  let open = null;
  const line = rowFor(c, indent);
  const self = {
    start(label) {
      // A step started while another is still open (a host command run by a
      // rollback) closes the open line where it stands rather than overwrite it.
      if (open && c.live) stream.write("\n");
      open = { label, t0: now() };
      if (c.live) stream.write(line(paint("explanation", icon(c, "running")), label, "", { cut: true }));
    },
    end(ok = true, note = "", { kept = false, label = null } = {}) {
      if (!open) return;
      const ms = now() - open.t0;
      // A step that ran and left its target in place is neither ✓ nor ✕.
      const mark = !ok ? paint("error", icon(c, "fail")) : kept ? paint("explanation", icon(c, "skip")) : paint("done", icon(c, "ok"));
      const right = paint("explanation", [note, duration(ms)].filter(Boolean).join("  "));
      const text = line(mark, label ?? open.label, right);
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
// with ✓ or the fail glyph, the whole past-tense label — never cut, wrapped by
// the terminal — and the duration. No byte
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
    const mark = c.ascii ? icon(c, "running") : paint("action", SPINNER[frame++ % SPINNER.length]);
    stream.write("\r\x1b[2K" + line(mark, label, paint("explanation", duration(now() - t0)), { cut: true }));
    drawn = true;
  };
  if (c.live && still) { stream.write(line(paint("explanation", icon(c, "running")), label, "", { cut: true })); drawn = true; }
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
      const mark = ok ? paint("done", icon(c, "ok")) : paint("error", icon(c, "fail"));
      const right = paint("explanation", [note, duration(now() - t0)].filter(Boolean).join("  "));
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
// `◆ Apply N changes? [Y/n] ` (`* Apply…` with ASCII glyphs), the question
// glyph in the action role (presentation spec contract 8); Enter, y or yes
// (any case) applies; anything else is a no, and so is end of input. Only
// the look is the presentation spec's: the line is still read by askLine, in
// line mode. Whether to ask at all is the caller's (install-harness.mjs's
// isInteractive). `caps` is the asking stream's; without one the question is
// unpainted, in Unicode. `ask` stands in for the terminal in tests and means
// "this is one"; it gets the question and returns the answer.
export async function askApply(n, { stdin = null, stdout = null, ask = null, caps: c = { color: false, ascii: false } } = {}) {
  const paint = painter(c);
  const question = `${paint("action", icon(c, "ask"))} ${paint("emphasis", `Apply ${n === 1 ? "1 change" : `${n} changes`}?`)} ${paint("explanation", "[Y/n]")} `;
  const answer = ask ? await ask(question) : await askLine(question, stdin, stdout);
  if (answer === null || answer === undefined) return false;
  return /^(y(es)?)?$/i.test(String(answer).trim());
}

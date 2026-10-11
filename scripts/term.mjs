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
//   glyphText(caps, text)        → the bin's own prose, its glyphs in caps' column
//   duration(ms)                 → "0.4s", "12s", "1m 03s"
//   wrap(text, width, indent)    → prose broken at spaces, hanging indent
//   badge(caps, head, parts)     → a screen's first line
//   heading(caps, title, counts) → "Plan — 3 to add · 5 unchanged"
//   rows(caps, list, opts)       → aligned glyph · action · target · note lines
//   rowLines(caps, list, opts)   → the same, one array of lines per row
//   PLAIN                        → the caps of a reader that is not a terminal
//   rule(caps, length)           → a horizontal rule
//   kv(caps, pairs, opts)        → aligned key–value lines
//   commandBlock(caps, cmds)     → commands on their own lines (contract 6)
//   stepReporter(stream, caps)   → { start(label), end(ok, note, opts), finish(label, t0, opts), abort() }
//   liveLine(stream, caps, label) → { end(ok, doneLabel, note), abort() }
//   askLine(question, in, out)   → the answer, or null on end of input
//   askApply(n, opts)            → contract 9's question; true applies
//   railAvailable(stdin, caps)   → true when the question rail may be drawn
//   openRail(opts)               → { select, multi, confirm, path, answered, close, cancelled }
//   CANCELLED, BACK              → what a rail question resolves to on Ctrl+C or end of input, and on Esc

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

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
  // doctor's info finding: not a warning, so not ▲ — the two would differ by
  // colour alone (decided 2026-10-11 with doctor's report).
  info: "dot",
  // The question rail's checklist cursor: the row it is on is marked by a
  // glyph, not by colour alone (contract 3).
  pointer: "transition",
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

// Prose the bin keeps in its own words — help's summaries and options, a
// usage form's `<phrase…>` — with each of the table's glyphs in it drawn from
// the column caps() picks: under ASCII glyphs — reads -, … reads ..., ·
// reads . and → reads ->. Text from the vault, a manifest or a finding never
// goes through it; that prints as it is (presentation spec, Testing).
const TO_ASCII = new Map(Object.values(GLYPHS).map(([u, a]) => [u, a]));
export function glyphText(c, text) {
  const s = String(text);
  return c && c.ascii ? [...s].map((ch) => TO_ASCII.get(ch) ?? ch).join("") : s;
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
// word; the note is in the explanation role. rowLines() gives each row's
// lines on their own, for a caller that prints more beneath each row.
// A row with `prose: true` has words for a target, not a path (status's story
// titles): on a live terminal one wider than the row wraps at its spaces,
// with the target column as its hanging indent, and a moved note goes beneath
// it at that column. Any other target is never wrapped.
export function rows(c, list, opts = {}) {
  return rowLines(c, list, opts).flat();
}

export function rowLines(c, list, { indent = 2 } = {}) {
  const paint = painter(c);
  const cells = list.map((r) => ({ glyph: r.glyph ? icon(c, r.glyph) : "", role: r.role || null, action: String(r.action ?? ""), target: String(r.target ?? ""), note: String(r.note ?? ""), prose: Boolean(r.prose) }));
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
    const col = plain(lead).length;
    const pad = " ".repeat(col);
    const alone = (r.prose && width ? lead + wrap(r.target, width, pad) : lead + r.target).split("\n").map((l) => l.trimEnd());
    if (!r.note) { out.push(alone); continue; }
    const line = `${lead}${cell(r.target, tw, null)}  ${paint("explanation", r.note)}`;
    if (!width || plain(line).length <= width) { out.push([line]); continue; }
    out.push([...alone, ...wrap(r.note, width, pad).split("\n").map((l, k) => pad + paint("explanation", k ? l.slice(col) : l))]);
  }
  return out;
}

// The capabilities of a reader that is not a terminal and asked for nothing:
// the renderers' default, so a caller that passes no caps gets plain text.
export const PLAIN = Object.freeze({ color: false, live: false, width: 100, columns: 100, ascii: false });

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
// test's clock. `finish` is the finished line of work whose own steps printed
// beneath its first line (a registration, a layout move): nothing of it is in
// flight, so its line is written on a line of its own, timed from `t0`.
export function stepReporter(stream = process.stdout, c = caps(stream), { indent = 2, now = Date.now } = {}) {
  const paint = painter(c);
  let open = null;
  const line = rowFor(c, indent);
  const finished = (ok, note, kept, label, ms, over, warn = false) => {
    // A step that ran and left its target in place is neither ✓ nor ✕; one
    // that failed without stopping the run (setup's git init) is ▲.
    const mark = !ok ? paint("error", icon(c, "fail")) : warn ? paint("attention", icon(c, "warning")) : kept ? paint("explanation", icon(c, "skip")) : paint("done", icon(c, "ok"));
    const right = paint("explanation", [note, duration(ms)].filter(Boolean).join("  "));
    stream.write((over && c.live ? "\r\x1b[2K" : "") + line(mark, label, right) + "\n");
  };
  const self = {
    start(label) {
      // A step started while another is still open (a host command run by a
      // rollback) closes the open line where it stands rather than overwrite it.
      if (open && c.live) stream.write("\n");
      open = { label, t0: now() };
      if (c.live) stream.write(line(paint("explanation", icon(c, "running")), label, "", { cut: true }));
    },
    end(ok = true, note = "", { kept = false, label = null, warn = false } = {}) {
      if (!open) return;
      finished(ok, note, kept, label ?? open.label, now() - open.t0, true, warn);
      open = null;
    },
    finish(label, t0, { ok = true, note = "" } = {}) { finished(ok, note, false, label, now() - t0, false); },
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

// ─── The question rail (presentation spec contract 9; built by the story
// "projectstore setup asks, shows one plan and installs every harness it
// finds, with the vault", its rule 2) ──────────────────────────────────────
//
// A run that asks more than one question draws them down one left margin:
// `┌` and the badge at the top, `◆` on the question being asked, `◇` and its
// answer on one line once it is answered, `└` at the end. Four kinds —
// select (one of n), multi (a checklist), confirm and path — each with its
// default, which Enter takes. The confirm that follows the rail is not one of
// them: it stays askApply's line-mode question, so every verb has one consent
// gate (contract 8).
//
// Keys come in raw mode, through node:readline's keypress decoder: ↑/↓ move,
// space toggles a checklist row, Enter confirms; Esc — reported after
// readline's escape timeout, since a bare Esc begins every arrow sequence —
// goes back from a path question; Ctrl+C, a byte in raw mode rather than a
// signal, and end of input cancel. Every other key is ignored.

// What a question resolves to when it is cancelled (Ctrl+C, or stdin ended)
// and when Esc leaves a path question. Once cancelled, a rail stays so: each
// later question resolves to CANCELLED at once and draws nothing.
export const CANCELLED = Symbol("projectstore.rail.cancelled");
export const BACK = Symbol("projectstore.rail.back");

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// readline's own default: how long a lone Esc waits for the rest of a sequence.
const ESCAPE_MS = 500;
// End of input, as the key queue carries it, behind the keys typed before it.
const EOF = Object.freeze({ name: "end of input" });

// Whether a rail may be drawn: stdin is a terminal that can be put in raw
// mode, and the caps (stdout's) are a live terminal — not a pipe, not
// TERM=dumb. Without a rail the caller runs as without a terminal: no
// question is asked (the setup story's rule 2 amends contract 9 so). Whether
// the run is interactive at all — CI, --json, a host session — is the
// caller's question (install-harness.mjs's isInteractive), asked before this.
export function railAvailable(stdin, c) {
  return Boolean(stdin && stdin.isTTY && typeof stdin.setRawMode === "function" && c && c.live);
}

// A choice as the rail draws and answers it: a string is its own value.
const choiceOf = (x) => (typeof x === "object" && x !== null
  ? { value: x.value ?? x.label, label: String(x.label ?? x.value), reason: x.reason ? String(x.reason) : "", answer: String(x.answer ?? x.label ?? x.value), on: Boolean(x.on) }
  : { value: x, label: String(x), reason: "", answer: String(x), on: false });

const isEnter = (k) => k.name === "return" || k.name === "enter";
const printable = (k) => typeof k.str === "string" && k.str !== "" && !k.ctrl && !k.meta && !/[\x00-\x1f\x7f]/.test(k.str);

// Open a rail on a terminal: draws its top line and holds the terminal for its
// questions until close(). Everything the run prints while the rail is open
// goes through it, since a redraw counts the rows it drew.
//
//   rail.select(title, choices, { default, note })         → the chosen value
//   rail.multi(title, choices, { note, min = 1 })           → the ticked values, in order
//   rail.confirm(title, { default = true, yes, no, yesReason, noReason, note }) → true or false
//   rail.path(title, { default, check, note, back = true }) → the path typed, or the default
//   rail.answered(title, text)                              → draws a question a flag answered
//   rail.close(note)                                        → `└`, then the terminal is the caller's
//
// A choice is a string, or { value, label, reason, answer, on }: `reason` is
// shown beside the label (beneath it when the row would pass the width),
// `answer` is the answered line's text (the label by default), `on` pre-ticks
// a checklist row. `default` is the value Enter takes. A path's `check(value)`
// returns a reason to refuse it — shown under the question, which stays open —
// or nothing to accept it. Each question also resolves to CANCELLED; a path
// resolves to BACK on Esc, and then its own lines and the answered line
// before it are erased, so the caller asks that question again where it was.
//
// One keypress queue per rail: keys typed ahead of a question — in the same
// chunk as the Enter that answered the one before, or while the run worked
// between two — wait for it. Raw mode is on only while a question is asked:
// each question turns it off and shows the cursor in a `finally`, so a throw
// restores the terminal as an answer does, and stdin is paused between
// questions, so an open rail never holds the process. A one-time `exit`
// handler and a SIGTERM / SIGHUP / SIGINT handler restore it too; the signal handler
// then removes the rail's handlers and raises the signal again, so the
// process ends as the signal would have ended it. `proc` is the process those
// handlers are added to, a test's emitter in tests. Never process.exit: a
// cancel is an answer, and the caller returns 130 (contract 9).
export function openRail({ stdin = process.stdin, stdout = process.stdout, caps: c = caps(stdout), proc = process, head = "projectstore", parts = [], escapeMs = ESCAPE_MS } = {}) {
  if (!railAvailable(stdin, c)) throw new Error("no question rail: stdin must be a terminal with setRawMode and stdout a live one (railAvailable)");
  const paint = painter(c);
  const bar = paint("explanation", icon(c, "rail"));
  const sep = ` ${icon(c, "dot")} `;
  const write = (s) => stdout.write(s);
  // The terminal's width now, for the layout and for counting the rows a line
  // fills: a line wider than the terminal fills more than one, and a redraw
  // that miscounted them would leave half a frame behind.
  const columns = () => (Number(stdout.columns) > 0 ? Number(stdout.columns) : c.columns || 100);
  const room = () => Math.max(20, Math.min(columns(), 100) - 1);
  const rowsOf = (lines) => { const w = columns(); return lines.reduce((n, l) => n + Math.max(1, Math.ceil([...plain(l)].length / w)), 0); };

  // ── The keys ──
  const queue = [];
  let waiter = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
  const onKey = (str, key) => { queue.push({ ...(key || {}), str }); wake(); };
  const onEnd = () => { queue.push(EOF); wake(); };
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((settle) => { waiter = () => settle(queue.shift()); }));
  emitKeypressEvents(stdin, { escapeCodeTimeout: escapeMs });
  stdin.on("keypress", onKey);
  stdin.on("end", onEnd);
  stdin.on("error", onEnd);
  if (stdin.readableEnded) queue.push(EOF);
  // Listening resumed the stream; it reads only while a question is asked.
  stdin.pause();

  // ── The restore, on every path ──
  // `live`: the question being asked, or null between questions.
  let closed = false, cancelled = false, live = null;
  const restore = () => {
    try { stdin.setRawMode(false); } catch {}
    try { write(SHOW_CURSOR); } catch {}
  };
  const onExit = () => restore();
  const onSignal = {};
  const release = () => {
    proc.removeListener("exit", onExit);
    for (const [sig, f] of Object.entries(onSignal)) proc.removeListener(sig, f);
  };
  // SIGINT too: Ctrl+C typed during a question is a byte, but `kill -INT`
  // from outside is a signal, and its default would leave the cursor hidden.
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    onSignal[sig] = () => {
      restore();
      if (live) try { write("\n"); } catch {}
      release();
      try { proc.kill(proc.pid, sig); } catch {}
    };
  }
  proc.once("exit", onExit);
  for (const [sig, f] of Object.entries(onSignal)) proc.on(sig, f);

  // ── Drawing ──
  // `shown`: the rows of the question on screen, written with no newline
  // after it, so the cursor is on its last row. `last`: the rows of the line
  // answered before it, which a path's Esc takes back.
  let shown = 0, last = 0;
  const erase = () => {
    if (!shown) return;
    write(`\r${shown > 1 ? `\x1b[${shown - 1}A` : ""}\x1b[J`);
    shown = 0;
  };
  const frame = (lines) => { erase(); write(lines.join("\n")); shown = rowsOf(lines); };
  const item = (lines) => { erase(); write(`${lines.join("\n")}\n`); last = rowsOf(lines); };

  const titled = (title) => wrap(String(title), room() - 2).split("\n").map((t, k) => `${k ? bar : paint("action", icon(c, "ask"))} ${paint("emphasis", t)}`);
  const prose = (text, role = "explanation") => wrap(String(text), room() - 2).split("\n").map((t) => `${bar} ${paint(role, t)}`);
  const warning = (text) => prose(`${icon(c, "warning")} ${text}`, "attention");
  // The key hint: one line, broken only between its keys on a terminal too
  // narrow for it, each separator ending the line it closes.
  const hint = (keys) => {
    const parts = keys.filter(Boolean).map((k, i, all) => (i < all.length - 1 ? `${k}${sep.trimEnd()}` : k));
    const lines = [];
    for (const p of parts) {
      if (lines.length && plain(`${lines.at(-1)} ${p}`).length <= room() - 2) lines[lines.length - 1] += ` ${p}`;
      else lines.push(p);
    }
    return lines.map((t) => `${bar} ${paint("explanation", t)}`);
  };
  const answeredLine = (title, text, glyph = "answered", role = "done", answerRole = "explanation") =>
    [bar, `${paint(role, icon(c, glyph))} ${title}${text ? `  ${paint(answerRole, text)}` : ""}`];
  // Choice rows: the marks (one plain width), the label, and the reason in a
  // column after the widest label that keeps its reason beside it. A row that
  // would pass the width puts its reason beneath the label, wrapped, and is
  // then left out of the column — so one wide label does not push every
  // other reason down. A label is never cut.
  const choiceLines = (marks, list) => {
    const lead = (i) => `${bar} ${marks[i]} `;
    const widest = (xs) => Math.max(0, ...xs.map((x) => plain(x.label).length));
    const fits = (x, i, w) => plain(lead(i)).length + w + 2 + plain(x.reason).length <= room();
    let beside = list.map((x, i) => Boolean(x.reason) && fits(x, i, plain(x.label).length));
    for (;;) {
      const w = widest(list.filter((_, i) => beside[i]));
      const still = beside.map((b, i) => b && fits(list[i], i, w));
      if (still.every((b, i) => b === beside[i])) break;
      beside = still;
    }
    const lw = widest(list.filter((_, i) => beside[i]));
    const out = [];
    list.forEach((x, i) => {
      if (beside[i]) { out.push(`${lead(i)}${x.label}${" ".repeat(lw - plain(x.label).length)}  ${paint("explanation", x.reason)}`); return; }
      out.push(lead(i) + x.label);
      if (!x.reason) return;
      const col = plain(lead(i)).length;
      for (const t of wrap(x.reason, room() - col).split("\n")) out.push(`${bar} ${" ".repeat(col - 2)}${paint("explanation", t)}`);
    });
    return out;
  };

  // One question: raw mode and a hidden cursor while it is asked (a path
  // shows the cursor, at the end of what is typed), its frame redrawn on each
  // key that changes it, collapsed to one answered line when it is answered.
  async function ask(q) {
    if (closed) throw new Error("the question rail is closed");
    if (live) throw new Error("the question rail is already asking");
    if (cancelled) return CANCELLED;
    live = q;
    let settled = false;
    const draw = () => frame(q.draw());
    try {
      stdin.setRawMode(true);
      if (!q.cursor) write(HIDE_CURSOR);
      stdin.resume();
      draw();
      for (;;) {
        const k = await next();
        // close() cancelled this question while it waited: it drew the line.
        if (closed) { settled = true; return CANCELLED; }
        if (k === EOF || (k.ctrl && k.name === "c")) {
          cancelled = true;
          item(answeredLine(q.title, "cancelled", "warning", "attention", "attention"));
          settled = true;
          return CANCELLED;
        }
        const r = await q.key(k);
        if (closed) { settled = true; return CANCELLED; }
        if (r === "redraw") { draw(); continue; }
        if (!r) continue;
        if (r.back) {
          erase();
          if (last) { write(`\x1b[${last}A\x1b[J`); last = 0; }
          settled = true;
          return BACK;
        }
        item(answeredLine(q.title, r.answer));
        settled = true;
        return r.value;
      }
    } finally {
      live = null;
      // A throw left the frame drawn: end its line, so what follows starts on its own.
      if (!settled && shown) { try { write("\n"); } catch {} shown = 0; }
      restore();
      try { stdin.pause(); } catch {}
    }
  }

  const choose = (title, list, at, note, keys) => {
    if (!list.length) throw new TypeError(`${title}: no choices`);
    return ask({
      title,
      draw: () => [bar, ...titled(title), ...(note ? prose(note) : []),
        ...choiceLines(list.map((_, i) => (i === at ? paint("action", icon(c, "choiceOn")) : paint("explanation", icon(c, "choiceOff")))), list),
        ...hint(keys)],
      key: (k) => {
        if (k.name === "up") { at = (at + list.length - 1) % list.length; return "redraw"; }
        if (k.name === "down") { at = (at + 1) % list.length; return "redraw"; }
        if (isEnter(k)) return { value: list[at].value, answer: list[at].answer };
        return null;
      },
    });
  };
  const defaultAt = (list, value) => Math.max(0, list.findIndex((x) => Object.is(x.value, value)));

  // The top: `┌` and the badge — `┌ projectstore setup` — in place of the
  // badge line a screen without a rail starts with.
  write(`${paint("explanation", icon(c, "railTop"))} ${badge(c, head, parts)}\n`);

  return {
    get cancelled() { return cancelled; },

    select(title, choices, { default: value, note = "" } = {}) {
      const list = choices.map(choiceOf);
      return choose(title, list, defaultAt(list, value), note, ["up/down move", "enter choose", "ctrl+c cancel"]);
    },

    // The row under the cursor carries the transition mark, so the cursor is
    // seen without colour (contract 3); a ticked row's box is ◼, an empty one ◻.
    multi(title, choices, { note = "", min = 1 } = {}) {
      const list = choices.map(choiceOf);
      if (!list.length) throw new TypeError(`${title}: no choices`);
      // More than the list holds could never be ticked: the question would never close.
      const need = Math.min(Math.max(0, Number(min) || 0), list.length);
      const on = list.map((x) => x.on);
      const pointer = icon(c, "pointer");
      let at = 0, refused = "";
      return ask({
        title,
        draw: () => [bar, ...titled(title), ...(note ? prose(note) : []),
          ...choiceLines(list.map((_, i) => `${i === at ? paint("action", pointer) : " ".repeat(pointer.length)} ${paint(on[i] ? "action" : "explanation", icon(c, on[i] ? "checkOn" : "checkOff"))}`), list),
          ...(refused ? warning(refused) : []),
          ...hint(["up/down move", "space toggle", "enter confirm", "ctrl+c cancel"])],
        key: (k) => {
          if (k.name === "up") { at = (at + list.length - 1) % list.length; return "redraw"; }
          if (k.name === "down") { at = (at + 1) % list.length; return "redraw"; }
          if (k.name === "space") { on[at] = !on[at]; refused = ""; return "redraw"; }
          if (!isEnter(k)) return null;
          const picked = list.filter((_, i) => on[i]);
          if (picked.length < need) { refused = need === 1 ? "tick at least one with space" : `tick at least ${need} with space`; return "redraw"; }
          return { value: picked.map((x) => x.value), answer: picked.length ? picked.map((x) => x.answer).join(", ") : "none" };
        },
      });
    },

    confirm(title, { default: yes = true, yes: yesLabel = "Yes", no: noLabel = "No", yesReason = "", noReason = "", note = "" } = {}) {
      const list = [choiceOf({ value: true, label: yesLabel, reason: yesReason }), choiceOf({ value: false, label: noLabel, reason: noReason })];
      return choose(title, list, yes ? 0 : 1, note, ["up/down move", "enter choose", "ctrl+c cancel"]);
    },

    // What is typed is drawn on the last line, the cursor after it. The
    // default has a line of its own, in words — a placeholder told from typed
    // text by its colour alone would not be told apart under NO_COLOR — and
    // Enter with nothing typed takes it. Backspace takes back a character;
    // Esc goes back.
    path(title, { default: fallback = "", check = null, note = "", back = true } = {}) {
      let value = "", refused = "";
      return ask({
        title,
        cursor: true,
        draw: () => [bar, ...titled(title), ...(note ? prose(note) : []), ...(refused ? warning(refused) : []),
          ...(fallback ? prose(`default ${fallback}`) : []),
          ...hint(["enter confirm", back ? "esc back" : null, "ctrl+c cancel"]),
          `${bar} ${value}`],
        key: async (k) => {
          if (k.name === "escape") return back ? { back: true } : null;
          if (isEnter(k)) {
            const chosen = value.trim() || String(fallback);
            if (!chosen) { refused = "type a path"; return "redraw"; }
            const why = check ? await check(chosen) : null;
            if (why) { refused = String(why); return "redraw"; }
            return { value: chosen, answer: chosen };
          }
          if (k.name === "backspace") {
            if (!value) return null;
            value = [...value].slice(0, -1).join("");
            refused = "";
            return "redraw";
          }
          if (!printable(k)) return null;
          value += k.str;
          refused = "";
          return "redraw";
        },
      });
    },

    // A question a flag answered, or one the run shows rather than asks: drawn
    // as an answered one, so the rail always shows the whole set of answers.
    // After a cancel it draws nothing: the run is stopping, and an answer
    // drawn under the cancelled question would read as one given.
    answered(title, text) {
      if (closed) throw new Error("the question rail is closed");
      if (cancelled) return;
      item(answeredLine(title, text));
    },

    // `└` (and a closing note beside it), then the terminal is the caller's
    // again: stdin paused and its listeners gone, so the line-mode confirm
    // (askApply → askLine) reads the next line. Keys the decoder already took
    // and no question asked for are dropped with the queue. Keys typed after
    // this, while stdin is paused and the terminal back in line mode, wait in
    // the terminal's own buffer and reach the next askLine: draining them
    // before the confirm is the caller's.
    //
    // Closed while a question is still asked, it cancels that question
    // first: its cancelled line drawn and the terminal restored here, then
    // the question woken, so it resolves to CANCELLED and its `finally` runs.
    close(note = "") {
      if (closed) return;
      closed = true;
      if (live) {
        cancelled = true;
        item(answeredLine(live.title, "cancelled", "warning", "attention", "attention"));
        restore();
      }
      erase();
      write(`${paint("explanation", icon(c, "railEnd"))}${note ? ` ${note}` : ""}\n`);
      stdin.removeListener("keypress", onKey);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      queue.length = 0;
      const woken = waiter;
      waiter = null;
      try { stdin.pause(); } catch {}
      release();
      if (woken) woken();
    },
  };
}

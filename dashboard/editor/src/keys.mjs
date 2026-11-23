// Keys in a document, answered the way Obsidian's editor answers them.
//
// The rules are read from the line, not from the syntax tree: while a person
// types, a half-written list is not yet a list to a Markdown parser (an empty
// nested item under a paragraph parses as a heading underline), and the key
// must still do the expected thing.
//
//   Enter        in a list item: a new item with the same marker (a task gets
//                an empty box, a number goes up and the ones below follow);
//                on an empty item: one level out, and at the top level the
//                marker goes; in a quote: the quote goes on, an empty quote
//                line ends it; elsewhere: a new line with the same indentation
//   Shift-Enter  a new line inside the same item
//   Tab          a list item goes one level in, with all its lines and
//                children, under the item above it; Shift-Tab brings it back.
//                Numbers follow: the item that went in starts at 1 or goes on
//                after the children already there, and the items left behind
//                close the gap
//   Backspace    right after a checkbox: the box goes, the bullet stays;
//                right after a marker: the marker goes
//   Mod-Enter    tick or untick the task; a line that is no task becomes one
//                (Mod-L does the same where the browser lets the key through)
//   Mod-Shift-8  a bullet list, and off again; Mod-Shift-7 a numbered one
//
// One thing differs from Obsidian on purpose. There an item is one long line.
// In a vault whose text is wrapped by hand an item runs over several indented
// lines, so every such line counts as the item: Enter at the end of the last
// one starts the next item instead of another indented line.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

const QUOTE = /^(?:[ \t]{0,3}>[ \t]?)+/;
const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(?:(\[[ xX]\])([ \t]+|$))?/;

// One source line read as list and quote markup. Columns count from the line start.
export function readLine(text) {
  const quote = (QUOTE.exec(text) || [""])[0];
  const rest = text.slice(quote.length);
  const m = ITEM.exec(rest);
  if (!m) return { item: false, quote, indent: /^[ \t]*/.exec(rest)[0], blank: rest.trim() === "", num: null };
  const mark = m[2] || m[3] + m[4];
  return {
    item: true,
    blank: false,
    quote,
    indent: m[1],
    mark,
    num: m[3] ? Number(m[3]) : null,
    numText: m[3] || "",
    delim: m[4] || "",
    gap: m[5],
    box: m[6] || null,
    markEnd: quote.length + m[1].length + mark.length + m[5].length, // after "- "
    textAt: quote.length + m[0].length, // where the item's text starts, after a box if there is one
    body: rest.slice(m[0].length),
  };
}

// The document's lines, with what a command has changed in them so far. A
// command reads and rewrites whole lines here; the transaction then carries
// only the part of each line that differs, so the cursor stays where it was.
function draftOf(doc) {
  const over = new Map();
  const src = {
    lines: doc.lines,
    text: (k) => (over.has(k) ? over.get(k) : doc.line(k).text),
    info: (k) => readLine(src.text(k)),
    set: (k, text) => void over.set(k, text),
    changes() {
      const out = [];
      for (const [k, now] of over) {
        const L = doc.line(k);
        const was = L.text;
        if (was === now) continue;
        let a = 0;
        while (a < was.length && a < now.length && was[a] === now[a]) a++;
        let z = 0;
        while (z < was.length - a && z < now.length - a && was[was.length - 1 - z] === now[now.length - 1 - z]) z++;
        out.push({ from: L.from + a, to: L.from + was.length - z, insert: now.slice(a, now.length - z) });
      }
      return out.sort((x, y) => x.from - y.from);
    },
  };
  return src;
}

function inCode(state, pos) {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 150) || syntaxTree(state);
  for (let n = tree.resolveInner(pos, -1); n; n = n.parent) if (n.name === "FencedCode") return true;
  return false;
}

// The item a line belongs to: the line itself, or the item whose text an
// indented line below it continues.
function ownerOf(src, n) {
  const here = src.info(n);
  if (here.item) return { n, info: here };
  if (here.blank) return null;
  for (let k = n - 1; k >= 1 && n - k < 200; k--) {
    const li = src.info(k);
    if (li.blank || li.quote !== here.quote) return null;
    if (li.item) return here.indent.length > li.indent.length ? { n: k, info: li } : null;
  }
  return null;
}
// The last line of an item: its wrapped lines and its children.
function lastLineOf(src, n, it) {
  let end = n;
  for (let k = n + 1; k <= src.lines; k++) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== it.quote || li.indent.length <= it.indent.length) break;
    end = k;
  }
  return end;
}
function siblingAbove(src, n, it) {
  for (let k = n - 1; k >= 1; k--) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== it.quote) return null;
    if (li.indent.length > it.indent.length) continue;
    return li.item && li.indent.length === it.indent.length ? { n: k, info: li } : null;
  }
  return null;
}
function parentOf(src, n, it) {
  for (let k = n - 1; k >= 1; k--) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== it.quote) return null;
    if (li.indent.length >= it.indent.length) continue;
    if (li.item) return { n: k, info: li };
    if (!li.indent.length) return null; // a paragraph at the margin: the list starts below it
  }
  return null;
}
// The items directly under an item: those at the smallest indentation below it, up to a line.
function childrenOf(src, n, it, until) {
  let kids = [];
  let min = Infinity;
  for (let k = n + 1; k <= src.lines && k <= until && k < n + 500; k++) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== it.quote || li.indent.length <= it.indent.length) break;
    if (!li.item) continue;
    if (li.indent.length < min) {
      min = li.indent.length;
      kids = [];
    }
    if (li.indent.length === min) kids.push({ k, li });
  }
  return kids;
}

// ── numbers ──
// A level of a list: the quote it stands in, its indentation, and "." or ")".
const levelOf = (it, indent = it.indent) => ({ quote: it.quote, indent, delim: it.delim });
const sameList = (a, b) => !!a && a.num !== null && b.num !== null && a.delim === b.delim;
function setNum(src, k, li, num) {
  const at = li.quote.length + li.indent.length;
  const t = src.text(k);
  src.set(k, `${t.slice(0, at)}${num}${t.slice(at + li.numText.length)}`);
}
// The first item of a level from a line on, if the list goes on there.
function firstAt(src, from, level) {
  for (let k = from; k <= src.lines && k < from + 500; k++) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== level.quote) return null;
    if (li.indent.length > level.indent.length) continue;
    return li.item && li.indent.length === level.indent.length ? li : null;
  }
  return null;
}
// Number the items that follow at a level, from `expected` on.
function numberRun(src, from, level, expected) {
  for (let k = from; k <= src.lines && k < from + 500; k++) {
    const li = src.info(k);
    if (li.blank) continue;
    if (li.quote !== level.quote) break;
    if (li.indent.length > level.indent.length) continue;
    if (!li.item || li.num === null || li.indent.length !== level.indent.length || li.delim !== level.delim) break;
    if (li.num !== expected) setNum(src, k, li, expected);
    expected++;
  }
}
// "1." on every line is a way to write a list too. Such a list is left as it is.
const repeats = (next, it, num = it.num) => sameList(next, it) && next.num === num;

const emptyBox = (it) => (it.box ? "[ ] " : "");

function newline(view, soft) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1) return false;
  const doc = state.doc;
  const src = draftOf(doc);
  const { from, to } = state.selection.main;
  const line = doc.lineAt(from);
  const col = from - line.from;
  const put = (f, t, insert, more = []) => {
    view.dispatch({ changes: [{ from: f, to: t, insert }, ...more], selection: { anchor: f + insert.length }, scrollIntoView: true, userEvent: "input" });
    return true;
  };
  const lead = /^[ \t]*/.exec(line.text)[0];
  const plain = () => (line.text.trim() === "" && from === to ? put(line.from, line.to, "\n") : put(from, to, `\n${col >= lead.length ? lead : ""}`));
  if (inCode(state, from)) return plain();

  const here = readLine(line.text);
  const own = ownerOf(src, line.number);
  if (!own) {
    if (!here.quote) return plain();
    // A quote goes on; an empty quote line ends it, one level at a time.
    if (line.text.slice(here.quote.length).trim() === "" && from === to) return put(line.from, line.to, here.quote.replace(/[ \t]{0,3}>[ \t]?$/, ""));
    return col < here.quote.length ? put(from, to, "\n") : put(from, to, `\n${here.quote}${here.indent}`);
  }

  const { n, info: it } = own;
  const first = n === line.number;
  if (first && col < it.textAt) return put(from, to, "\n"); // before the text: the item moves down

  // An empty item: Enter takes it one level out; at the top level the marker goes.
  if (first && from === to && it.body.trim() === "") {
    if (it.indent.length) return moveItems(view, -1, own, n);
    if (it.num !== null && !repeats(firstAt(src, n + 1, levelOf(it)), it)) numberRun(src, n + 1, levelOf(it), it.num);
    return put(line.from, line.to, it.quote, src.changes());
  }

  // Shift-Enter: a new line of the same item, under its text.
  if (soft) return put(from, to, `\n${it.quote}${first ? " ".repeat(it.textAt - it.quote.length) : here.indent}`);

  // A new item at the cursor. What stood after the cursor goes with it, and
  // no space is left at the end of the old line or the start of the new one.
  const textCol = first ? it.textAt : here.quote.length + here.indent.length;
  let f = from;
  let t = Math.max(to, line.from + Math.min(textCol, line.length));
  let pre = "\n";
  if (col <= textCol) {
    if (!first) {
      f = line.from; // the cursor stood in the indentation of a wrapped line: the item starts on this line
      pre = "";
    }
  } else f = from - Math.min(/[ \t]*$/.exec(line.text.slice(0, col))[0].length, col - textCol);
  const tail = doc.lineAt(t);
  t += /^[ \t]*/.exec(tail.text.slice(t - tail.from))[0].length;

  let mark = it.mark;
  if (it.num !== null && !repeats(firstAt(src, tail.number + 1, levelOf(it)), it)) {
    mark = `${it.num + 1}${it.delim}`;
    numberRun(src, tail.number + 1, levelOf(it), it.num + 2);
  }
  return put(f, t, `${pre}${it.quote}${it.indent}${mark}${it.gap}${emptyBox(it)}`, src.changes());
}

export const enter = (view) => newline(view, false);
export const shiftEnter = (view) => newline(view, true);

// A list item, with its wrapped lines and its children, one level in (under
// the item above it) or one level out. `b` is the last selected line.
function moveItems(view, dir, own, b) {
  const src = draftOf(view.state.doc);
  const { n, info: it } = own;
  const lastOwn = b > n ? ownerOf(src, b) : null;
  const end = Math.max(lastLineOf(src, n, it), b, lastOwn ? lastLineOf(src, lastOwn.n, lastOwn.info) : 0);
  const moved = []; // the items that stand at the level of the first one
  for (let k = n; k <= end; k++) {
    const li = src.info(k);
    if (li.item && li.quote === it.quote && li.indent.length === it.indent.length) moved.push(k);
  }
  const move = (delta) => {
    for (let k = n; k <= end; k++) {
      const t = src.text(k);
      const li = readLine(t);
      if (li.blank) continue;
      const at = li.quote.length;
      src.set(k, delta > 0 ? `${t.slice(0, at)}${" ".repeat(delta)}${t.slice(at)}` : `${t.slice(0, at)}${t.slice(at + Math.min(-delta, li.indent.length))}`);
    }
  };
  const number = (from) => {
    let num = from;
    for (const k of moved) {
      const li = src.info(k);
      if (li.num !== null) setNum(src, k, li, num++);
    }
    return num;
  };
  const old = levelOf(it);

  if (dir > 0) {
    // One level in means: under the item above. With no item above there is nothing to go under.
    const sib = siblingAbove(src, n, it);
    if (!sib) return true;
    const kids = childrenOf(src, sib.n, sib.info, n - 1); // it joins the children that item already has
    const last = kids[kids.length - 1];
    move(last ? last.li.indent.length - it.indent.length : sib.info.markEnd - sib.info.quote.length - sib.info.indent.length);
    if (it.num !== null && !repeats(sib.info, it) && !repeats(firstAt(src, end + 1, old), it)) {
      number(last && sameList(last.li, it) ? last.li.num + 1 : 1);
      numberRun(src, end + 1, old, sameList(sib.info, it) ? sib.info.num + 1 : it.num); // the items left behind close the gap
    }
  } else {
    if (!it.indent.length) return true;
    const par = parentOf(src, n, it);
    const target = par ? par.info.indent : "";
    move(target.length - it.indent.length);
    const up = levelOf(it, target);
    const above = par && sameList(par.info, it) ? par.info : null;
    if (it.num !== null && !(above && repeats(firstAt(src, end + 1, up), it, above.num))) {
      const next = number(above ? above.num + 1 : it.num);
      // The items that stood below it at the old level are now under it, after its own children.
      const lastMoved = moved[moved.length - 1];
      const kids = childrenOf(src, lastMoved, src.info(lastMoved), Infinity);
      if (kids.length && kids[0].li.num !== null) {
        let c = kids[0].k <= end ? kids[0].li.num : 1;
        for (const { k, li } of kids) {
          if (!sameList(li, kids[0].li)) break;
          if (li.num !== c) setNum(src, k, li, c);
          c++;
        }
      }
      numberRun(src, end + 1, up, next);
    }
  }
  const changes = src.changes();
  if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: dir > 0 ? "input.indent" : "delete.dedent" });
  return true;
}

function shift(view, dir) {
  const { state } = view;
  if (state.readOnly) return false;
  const doc = state.doc;
  const sel = state.selection.main;
  const a = doc.lineAt(sel.from).number;
  let b = doc.lineAt(sel.to).number;
  if (b > a && doc.line(b).from === sel.to) b--; // a selection that ends at a line's start does not hold that line
  const code = inCode(state, sel.from);
  const own = code ? null : ownerOf(draftOf(doc), a);
  if (own) return moveItems(view, dir, own, b);

  // Plain text and code: spaces at the cursor, or the selected lines in and out.
  const unit = code ? 2 : 4;
  if (dir > 0 && sel.empty) {
    view.dispatch({ ...state.replaceSelection(" ".repeat(unit)), scrollIntoView: true, userEvent: "input" });
    return true;
  }
  const changes = [];
  for (let k = a; k <= b; k++) {
    const L = doc.line(k);
    if (!L.text.trim()) continue;
    if (dir > 0) changes.push({ from: L.from, insert: " ".repeat(unit) });
    else {
      const cut = L.text[0] === "\t" ? 1 : Math.min(unit, /^ */.exec(L.text)[0].length);
      if (cut) changes.push({ from: L.from, to: L.from + cut });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: dir > 0 ? "input.indent" : "delete.dedent" });
  return true;
}

export const tab = (view) => shift(view, 1);
export const shiftTab = (view) => shift(view, -1);

export function backspace(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (state.readOnly || !sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.from);
  const col = sel.from - line.from;
  if (!col || inCode(state, sel.from)) return false;
  const it = readLine(line.text);
  if (!it.item) return false;
  const cut = (f, t, more = []) => (view.dispatch({ changes: [{ from: line.from + f, to: line.from + t }, ...more], scrollIntoView: true, userEvent: "delete.backward" }), true);
  if (it.box && col === it.textAt) return cut(it.markEnd, it.textAt); // the box goes, the bullet stays
  if (it.box || col !== it.markEnd) return false;
  // The marker goes; the numbers below take its place.
  const src = draftOf(state.doc);
  if (it.num !== null && !repeats(firstAt(src, line.number + 1, levelOf(it)), it)) numberRun(src, line.number + 1, levelOf(it), it.num);
  return cut(it.quote.length + it.indent.length, it.markEnd, src.changes());
}

// The lines of the selection as a list of one kind. Every item is taken by
// its first line, wherever in it the cursor stands.
//   task    tick or untick; a list item gets a box; any other line becomes a task
//   bullet  a bullet list; on a plain bullet the marker goes
//   number  a numbered list that goes on after the item above; on a numbered item the marker goes
function setList(view, kind) {
  const { state } = view;
  if (state.readOnly || inCode(state, state.selection.main.from)) return false;
  const doc = state.doc;
  const src = draftOf(doc);
  const picked = [];
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    let b = doc.lineAt(r.to).number;
    if (b > a && doc.line(b).from === r.to) b--;
    for (let k = a; k <= b; k++) {
      const own = ownerOf(src, k);
      const n = own ? own.n : k;
      if (picked.includes(n) || (src.info(n).blank && a !== b)) continue;
      picked.push(n);
    }
  }
  if (!picked.length) return true;
  const first = src.info(picked[0]);
  // Bullets and numbers: the first line decides, so a mixed selection ends up the same on every line.
  const off = kind === "bullet" ? first.item && first.num === null && !first.box : kind === "number" ? first.num !== null : false;
  const counters = new Map(); // the next number for each level of indentation
  for (const n of picked) {
    const t = src.text(n);
    const li = readLine(t);
    const head = t.slice(0, li.quote.length + li.indent.length);
    const body = li.item ? li.body : t.slice(head.length);
    if (kind === "task") {
      if (li.item && li.box) src.set(n, `${t.slice(0, li.markEnd + 1)}${li.box[1] === " " ? "x" : " "}${t.slice(li.markEnd + 2)}`);
      else if (li.item) src.set(n, `${t.slice(0, li.markEnd)}[ ] ${t.slice(li.markEnd)}`);
      else src.set(n, `${head}- [ ] ${body}`);
    } else if (off) src.set(n, `${head}${body}`);
    else if (kind === "bullet") src.set(n, `${head}- ${body}`);
    else {
      const key = `${li.quote}|${li.indent.length}`;
      if (!counters.has(key)) {
        const sib = siblingAbove(src, n, li);
        counters.set(key, sib && sib.info.num !== null ? { num: sib.info.num + 1, delim: sib.info.delim } : { num: 1, delim: "." });
      }
      const c = counters.get(key);
      src.set(n, `${head}${c.num++}${c.delim} ${li.item && li.box ? `${li.box} ` : ""}${body}`);
    }
  }
  if (kind !== "task") {
    // The numbers below follow: they go on after a new numbered item, or take the place of one that is gone.
    const lastN = picked[picked.length - 1];
    const after = lastLineOf(src, lastN, src.info(lastN)) + 1;
    const made = counters.get(`${first.quote}|${first.indent.length}`);
    if (made) numberRun(src, after, { quote: first.quote, indent: first.indent, delim: made.delim }, made.num);
    else if (first.num !== null && !repeats(firstAt(src, after, levelOf(first)), first)) numberRun(src, after, levelOf(first), first.num);
  }
  const changes = src.changes();
  if (!changes.length) return true;
  const main = state.selection.main;
  view.dispatch({ changes, selection: main.empty ? EditorSelection.cursor(state.changes(changes).mapPos(main.head, 1)) : undefined, scrollIntoView: true, userEvent: "input" });
  return true;
}

export const toggleTask = (view) => setList(view, "task");
export const toggleBullet = (view) => setList(view, "bullet");
export const toggleNumber = (view) => setList(view, "number");

export const obsidianKeymap = [
  { key: "Enter", run: enter, shift: shiftEnter },
  { key: "Tab", run: tab, shift: shiftTab },
  { key: "Backspace", run: backspace },
  { key: "Mod-Enter", run: toggleTask },
  { key: "Mod-l", run: toggleTask }, // Obsidian's own key; a browser may keep it for its address bar
  { key: "Mod-Shift-8", run: toggleBullet },
  { key: "Mod-Shift-7", run: toggleNumber },
];

// A mark typed over a selection wraps it: select a word, press * twice, and it is bold.
const WRAPS = "*_~=";
export const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  const sel = view.state.selection.main;
  if (text.length !== 1 || !WRAPS.includes(text) || sel.empty || view.state.readOnly || view.state.selection.ranges.length > 1) return false;
  if (view.state.doc.lineAt(sel.from).number !== view.state.doc.lineAt(sel.to).number) return false;
  view.dispatch({
    changes: [
      { from: sel.from, insert: text },
      { from: sel.to, insert: text },
    ],
    selection: { anchor: sel.from + 1, head: sel.to + 1 },
    userEvent: "input.type",
  });
  return true;
});

// What changed in a text against an earlier text of the same file.
//
// The marks are the writer's own edits, kept as they are made: what was typed
// is marked where it was typed, what was removed is drawn struck through where
// it stood. Nothing is compared again on a keystroke, so a mark never moves to
// another line because a shorter description of the same change exists. The
// two texts are compared once, when the earlier text is chosen: a file may
// already differ from it when the editor opens.

import { StateField, Facet, ChangeSet, Text, RangeSet } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, gutter, GutterMarker } from "@codemirror/view";
import { presentableDiff } from "@codemirror/merge";

const DIFF = { scanLimit: 2000, timeout: 400 };
const baseOf = Facet.define({ combine: (v) => (v.length ? v[0] : null) });
const canPutBack = Facet.define({ combine: (v) => (v.length ? v[0] : true) });

// Two texts compared: lines first, so that a paragraph that was moved or removed
// reads as that paragraph, then words inside the lines that changed. The answer
// is a list of edits to `a`.
function compare(a, b) {
  if (a === b) return [];
  const ta = a.match(/[^\n]*\n|[^\n]+$/g) || [];
  const tb = b.match(/[^\n]*\n|[^\n]+$/g) || [];
  let head = 0;
  while (head < ta.length && head < tb.length && ta[head] === tb[head]) head++;
  let tail = 0;
  while (tail < ta.length - head && tail < tb.length - head && ta[ta.length - 1 - tail] === tb[tb.length - 1 - tail]) tail++;
  const n = ta.length - head - tail;
  const m = tb.length - head - tail;
  if (n * m > 4e6) return words(a, b, 0); // too long to line up line by line
  // The longest run of lines the two middles share, from each pair of lines to the end.
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = ta[head + i] === tb[head + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const out = [];
  let pos = 0;
  for (let k = 0; k < head; k++) pos += ta[k].length;
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && ta[head + i] === tb[head + j]) {
      pos += ta[head + i].length;
      i++;
      j++;
      continue;
    }
    let del = "";
    let ins = "";
    while ((i < n || j < m) && !(i < n && j < m && ta[head + i] === tb[head + j])) {
      if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) ins += tb[head + j++];
      else del += ta[head + i++];
    }
    out.push(...words(del, ins, pos));
    pos += del.length;
  }
  return out;
}
// The words that differ between two pieces of text. Two pieces with little in
// common are one replacement: a mark on every third letter says nothing.
function words(del, ins, from) {
  const whole = [{ from, to: from + del.length, insert: ins }];
  if (!del || !ins) return whole;
  const parts = presentableDiff(del, ins, DIFF);
  let gone = 0;
  for (const c of parts) gone += c.toA - c.fromA;
  if ((del.length - gone) * 2 < Math.min(del.length, ins.length)) return whole;
  return parts.map((c) => ({ from: from + c.fromA, to: from + c.toA, insert: ins.slice(c.fromB, c.toB) }));
}

// The edits that turn `base` into `doc`, found by comparing the two texts.
function between(base, doc) {
  const specs = compare(base.toString(), doc.toString());
  return specs.length ? ChangeSet.of(specs, base.length) : ChangeSet.empty(base.length);
}

// One edit that swaps a long text for another long text, such as a paste over
// a selection, is compared the same way. It is done once, on that edit; typing
// afterwards does not compare anything again.
function refine(tr) {
  let cut = false;
  const specs = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const del = tr.startState.sliceDoc(fromA, toA);
    const ins = inserted.toString();
    if (del.length >= 16 && ins.length >= 16 && /\s/.test(del) && /\s/.test(ins)) {
      cut = true;
      for (const c of compare(del, ins)) specs.push({ from: fromA + c.from, to: fromA + c.to, insert: c.insert });
    } else specs.push({ from: fromA, to: toA, insert: inserted });
  });
  return cut ? ChangeSet.of(specs, tr.startState.doc.length) : tr.changes;
}

// An edit that put back exactly what stood there is no change, and a text that
// is the earlier text again has none, whatever road led back to it.
function tidy(set, base, doc) {
  if (doc.length === base.length && doc.eq(base)) return ChangeSet.empty(base.length);
  const keep = [];
  let dropped = false;
  set.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (toA - fromA === toB - fromB && base.sliceString(fromA, toA) === inserted.toString()) dropped = true;
    else keep.push({ from: fromA, to: toA, insert: inserted });
  });
  return dropped ? ChangeSet.of(keep, base.length) : set;
}

// The edits from the earlier text to the text on screen.
export const changeField = StateField.define({
  create(state) {
    const base = state.facet(baseOf);
    return base ? between(base, state.doc) : null;
  },
  update(set, tr) {
    const base = tr.state.facet(baseOf);
    if (!base) return null;
    if (set === null || base !== tr.startState.facet(baseOf) || set.newLength !== tr.startState.doc.length) return between(base, tr.newDoc);
    return tr.docChanged ? tidy(set.compose(refine(tr)), base, tr.newDoc) : set;
  },
});

// The earlier text the marks are drawn against, or null.
export const earlierText = (state) => state.facet(baseOf);

// Every changed part: what was removed (`del`), what stands there now (`ins`),
// and where it is in the text on screen.
export function partsOf(state) {
  const set = state.field(changeField, false);
  const base = state.facet(baseOf);
  const out = [];
  if (!set || !base) return out;
  set.iterChanges((fromA, toA, fromB, toB, inserted) => out.push({ fromA, toA, fromB, toB, del: base.sliceString(fromA, toA), ins: inserted.toString() }));
  return out;
}

// Parts that touch the same line are one change to a reader: one count, one
// "put it back" button.
export function hunksOf(state) {
  const hunks = [];
  for (const p of partsOf(state)) {
    const first = state.doc.lineAt(p.fromB).number;
    const end = state.doc.lineAt(p.toB);
    // An inserted line ends at the start of the next one, which it did not change.
    const lastLine = p.toB > p.fromB && end.from === p.toB && end.number > first ? end.number - 1 : end.number;
    const last = hunks[hunks.length - 1];
    if (last && first <= last.lastLine) {
      last.parts.push(p);
      last.lastLine = Math.max(last.lastLine, lastLine);
      last.to = p.toB;
    } else hunks.push({ from: p.fromB, to: p.toB, firstLine: first, lastLine, parts: [p] });
  }
  return hunks;
}

// Put one change back as it was in the earlier text.
export function putBack(view, hunk) {
  view.dispatch({ changes: hunk.parts.map((p) => ({ from: p.fromB, to: p.toB, insert: p.del })), userEvent: "input.putback" });
}

// Put the cursor on the next change and bring it into view; after the last, the first.
export function nextChange(view) {
  const hunks = hunksOf(view.state);
  if (!hunks.length) return false;
  const head = view.state.selection.main.head;
  const to = hunks.find((x) => x.from > head) || hunks[0];
  view.dispatch({ selection: { anchor: to.from }, effects: EditorView.scrollIntoView(to.from, { y: "center" }) });
  return true;
}

export const changeCount = (state) => hunksOf(state).length;

// The smallest edit that turns one text into another: what the editor is given
// when a saved file comes back from the server, so that the whole text is not
// marked as replaced.
export function smallestEdit(from, to) {
  if (from === to) return null;
  let a = 0;
  const max = Math.min(from.length, to.length);
  while (a < max && from.charCodeAt(a) === to.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && from.charCodeAt(from.length - 1 - b) === to.charCodeAt(to.length - 1 - b)) b++;
  return { from: a, to: from.length - b, insert: to.slice(a, to.length - b) };
}

// ── drawing ──
class Gone extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("del");
    el.className = "cm-deletedText";
    // A removed line break is drawn, and still breaks the line: the text below stays where it was.
    el.textContent = this.text.replace(/\n/g, "↵\n");
    el.setAttribute("aria-label", `removed: ${this.text.replace(/\s+/g, " ").trim().slice(0, 120) || "a line break"}`);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}
class PutBack extends WidgetType {
  constructor(key) {
    super();
    this.key = key;
  }
  eq(other) {
    return other.key === this.key;
  }
  toDOM(view) {
    const b = document.createElement("button");
    b.className = "cm-putback";
    b.type = "button";
    b.textContent = "↩";
    b.title = "Put this part back as it was";
    b.setAttribute("aria-label", "Put this part back as it was");
    b.onmousedown = (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(b)).number;
      const hunk = hunksOf(view.state).find((x) => x.firstLine === line);
      if (hunk) putBack(view, hunk);
    };
    return b;
  }
  ignoreEvent() {
    return true;
  }
}
const mark = (cls) =>
  new (class extends GutterMarker {
    elementClass = cls;
  })();
const addedMark = mark("cm-changedLineGutter");
const goneMark = mark("cm-deletedLineGutter");
const added = Decoration.mark({ class: "cm-changedText" });
const addedLine = Decoration.line({ class: "cm-inlineChangedLine" });
const goneLine = Decoration.line({ class: "cm-goneLine" });

// Decorations and gutter marks for the changes. Exported for the checks: `kind`
// and positions say what is drawn where, without a page.
export function drawingOf(state) {
  const out = [];
  const buttons = state.facet(canPutBack) && !state.readOnly;
  for (const hunk of hunksOf(state)) {
    const grows = new Set(); // lines that hold new text
    for (const p of hunk.parts) {
      if (p.del) out.push({ kind: "gone", at: p.fromB, text: p.del });
      if (p.toB > p.fromB) {
        out.push({ kind: "added", from: p.fromB, to: p.toB });
        const end = state.doc.lineAt(p.toB);
        const last = end.from === p.toB && end.number > state.doc.lineAt(p.fromB).number ? end.number - 1 : end.number;
        for (let n = state.doc.lineAt(p.fromB).number; n <= last; n++) grows.add(n);
      }
    }
    for (let n = hunk.firstLine; n <= hunk.lastLine; n++) out.push({ kind: "line", line: n, at: state.doc.line(n).from, added: grows.has(n) });
    if (buttons) out.push({ kind: "button", at: state.doc.line(hunk.firstLine).from, key: `${hunk.firstLine}:${hunk.parts.length}` });
  }
  return out;
}
const drawn = StateField.define({
  create: (state) => build(state),
  update: (value, tr) => (tr.state.field(changeField, false) !== tr.startState.field(changeField, false) || tr.state.readOnly !== tr.startState.readOnly ? build(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
function build(state) {
  const deco = [];
  const marks = [];
  for (const d of drawingOf(state)) {
    if (d.kind === "gone") deco.push(Decoration.widget({ widget: new Gone(d.text), side: -1 }).range(d.at));
    else if (d.kind === "added") deco.push(added.range(d.from, d.to));
    else if (d.kind === "button") deco.push(Decoration.widget({ widget: new PutBack(d.key), side: -2 }).range(d.at));
    else {
      deco.push((d.added ? addedLine : goneLine).range(d.at));
      marks.push((d.added ? addedMark : goneMark).range(d.at));
    }
  }
  return { deco: Decoration.set(deco, true), marks: RangeSet.of(marks, true) };
}

// The extension: marks against `original`. `buttons: false` leaves the "put it back" buttons out.
export function changeMarks(original, { buttons = true } = {}) {
  return [
    baseOf.of(Text.of(String(original).split(/\r\n?|\n/))),
    canPutBack.of(buttons),
    changeField,
    drawn,
    gutter({ class: "cm-changeGutter", markers: (view) => view.state.field(drawn).marks }),
    EditorView.editorAttributes.of({ class: "cm-diff" }),
  ];
}

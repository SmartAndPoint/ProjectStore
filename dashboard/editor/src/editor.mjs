// The document editor: Markdown source with a live preview, the way
// Obsidian's editor works (it is built on the same library, CodeMirror 6).
//
// The text of the file stays the source, byte for byte. Nothing is parsed
// into a tree and written back out, so a save changes only what was typed.
// What looks rendered is decoration: a heading is the same `## ` line drawn
// larger with its marks hidden; the marks come back when the cursor is there.
//
// Bundled by `npm run build` into public/editor.bundle.js as `WSEditor`.

import { EditorState, StateField, StateEffect, Compartment, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection, dropCursor, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, ensureSyntaxTree, syntaxHighlighting, HighlightStyle, StreamLanguage, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { searchKeymap, search } from "@codemirror/search";
import { changeMarks, changeCount, nextChange, smallestEdit } from "./changes.mjs";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { obsidianKeymap, wrapOnType, toggleTask, toggleBullet, toggleNumber } from "./keys.mjs";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

// Languages inside ``` fences.
const codeLanguages = [
  LanguageDescription.of({ name: "javascript", alias: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "typescript"], support: javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: "json", alias: ["jsonc"], support: json() }),
  LanguageDescription.of({ name: "bash", alias: ["sh", "shell", "zsh", "console"], support: new LanguageSupport(StreamLanguage.define(shell)) }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: new LanguageSupport(StreamLanguage.define(yaml)) }),
];

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--violet)" },
  { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--warn)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.propertyName, t.definition(t.variableName), t.function(t.variableName)], color: "var(--accent)" },
  { tag: [t.typeName, t.className], color: "var(--teal)" },
  { tag: t.operator, color: "var(--dim)" },
  { tag: t.url, color: "var(--accent)" },
]);

// ── widgets ──
class Bullet extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return false;
  }
}
class Rule extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-rule";
    return s;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return false;
  }
}
class Checkbox extends WidgetType {
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos;
  }
  eq(o) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-check";
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}
// [[target|label]]: shown as its label; a click with ⌘ or Ctrl follows it.
// The icons that say what a link leads to: the kind of an artifact, or a host and its object.
// The page names them (ctx.icons) and draws them by class; the editor only places them.
function iconsOf(names) {
  const box = document.createElement("span");
  box.className = "icos";
  box.setAttribute("aria-hidden", "true");
  for (const n of names) box.append(Object.assign(document.createElement("i"), { className: `ico ico-${n}` }));
  return box;
}
class Icons extends WidgetType {
  constructor(names) {
    super();
    this.names = names;
  }
  eq(o) {
    return o.names.join() === this.names.join();
  }
  toDOM() {
    return iconsOf(this.names);
  }
}
class Wiki extends WidgetType {
  constructor(target, label, known, icons = []) {
    super();
    this.target = target;
    this.label = label;
    this.known = known;
    this.icons = icons;
  }
  eq(o) {
    return o.target === this.target && o.label === this.label && o.known === this.known && o.icons.join() === this.icons.join();
  }
  toDOM() {
    const a = document.createElement("span");
    a.className = `cm-wiki${this.known ? "" : " cm-wiki-broken"}`;
    a.dataset.follow = this.target;
    if (this.known && this.icons.length) a.append(iconsOf(this.icons));
    a.append(this.label);
    a.title = this.known ? "⌘-click to open" : "Nothing here by that name";
    return a;
  }
  ignoreEvent() {
    return false;
  }
}
// A picture, a video, a sound or a file, drawn where its Markdown is.
class Media extends WidgetType {
  constructor(url, alt, ctx) {
    super();
    this.url = url;
    this.alt = alt;
    this.ctx = ctx;
  }
  eq(o) {
    return o.url === this.url && o.alt === this.alt;
  }
  toDOM() {
    const m = this.ctx.media ? this.ctx.media(this.url) : null;
    let el;
    if (!m) {
      el = document.createElement("span");
      el.className = "cm-wiki cm-wiki-broken";
      el.textContent = `[${this.alt || "file"}: not shown]`;
    } else if (m.kind === "image") {
      el = document.createElement("img");
      el.src = m.src;
      el.alt = this.alt || "";
      el.className = "cm-media";
    } else if (m.kind === "video" || m.kind === "audio") {
      el = document.createElement(m.kind);
      el.src = m.src;
      el.controls = true;
      el.preload = "metadata";
      el.className = "cm-media";
    } else {
      el = document.createElement("span");
      el.className = "cm-file";
      el.dataset.follow = this.url;
      el.textContent = `📎 ${this.alt || this.url.split("/").pop()}`;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}
// A table, drawn as a table while the cursor is elsewhere.
class Table extends WidgetType {
  constructor(text, ctx) {
    super();
    this.text = text;
    this.ctx = ctx;
  }
  eq(o) {
    return o.text === this.text;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-table md";
    box.append(this.ctx.render ? this.ctx.render(this.text) : document.createTextNode(this.text));
    box.title = "Click to edit the table as text";
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

// ── the live preview ──
const setFocus = StateEffect.define();
const focused = StateField.define({
  create: () => false,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setFocus)) v = e.value;
    return v;
  },
});
const HEAD = { ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6 };
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const hide = Decoration.replace({});
// A list is drawn by its structure, not by the width of its spaces: one space
// of indentation is UNIT wide, a bullet or a box with the gap after it is MARK
// wide, so a level of two spaces lands under the text of the item above.
const UNIT = 9;
const MARK = 18;
const GAP = 5;
const units = (s) => [...s].reduce((k, c) => k + (c === "\t" ? 4 : 1), 0);

function build(state, ctx) {
  const doc = state.doc;
  const sel = state.selection.main;
  const on = state.field(focused, false);
  // The cursor is "at" a range when it touches it; then the Markdown shows.
  const at = (from, to) => on && sel.from <= to && sel.to >= from;
  const atLines = (from, to) => at(doc.lineAt(from).from, doc.lineAt(to).to);
  const out = [];
  const taken = []; // ranges already replaced: nothing else may replace inside them
  const skip = []; // code, tables, comments: no wiki links are looked for there
  const free = (from, to) => !taken.some(([a, b]) => from < b && to > a);
  const replace = (from, to, deco) => {
    if (from >= to || !free(from, to)) return false;
    taken.push([from, to]);
    out.push(deco.range(from, to));
    return true;
  };
  const lineClass = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const eachLine = (from, to, fn) => {
    for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) fn(doc.line(n), n, last);
  };
  const withSpace = (to) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  const gap = (pos) => doc.sliceString(pos, pos + 1) === " " && out.push(Decoration.mark({ class: "cm-gap" }).range(pos, pos + 1));
  // Every line of an item's own text hangs under that text: a long line wraps
  // there, and a line the source wraps by hand starts there, however many
  // spaces it is indented with.
  const listItem = (item) => {
    const first = doc.lineAt(item.from);
    const lead = doc.sliceString(first.from, item.from);
    const mark = item.getChild("ListMark");
    if (!mark || /\S/.test(lead)) return; // a list inside a quote keeps its plain look
    const inPx = units(lead) * UNIT;
    const markW = item.parent?.name === "OrderedList" ? `${mark.to - mark.from}ch + ${GAP}px` : `${MARK}px`;
    const style = `padding-left: calc(2px + ${inPx}px + ${markW}); text-indent: calc(-1 * (${inPx}px + ${markW}))`;
    const space = (from, to, width) => from < to && out.push(Decoration.mark({ class: "cm-indent", attributes: { style: `width: ${width}` } }).range(from, to));
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name !== "Paragraph" && c.name !== "Task") continue;
      eachLine(c.from, c.to, (line) => {
        out.push(Decoration.line({ attributes: { style } }).range(line.from));
        if (line.number === first.number) return void space(line.from, item.from, `${inPx}px`);
        const ws = /^[ \t]*/.exec(line.text)[0].length;
        const own = Math.min(lead.length, ws);
        space(line.from, line.from + own, `${inPx}px`);
        space(line.from + own, line.from + ws, `calc(${markW})`);
      });
    }
  };

  (ensureSyntaxTree(state, doc.length, 250) || syntaxTree(state)).iterate({
    enter(n) {
      const name = n.name;
      if (HEAD[name]) return void lineClass(n.from, `cm-h cm-h${HEAD[name]}`);
      if (name === "HeaderMark") {
        if (!atLines(n.from, n.to)) replace(n.from, withSpace(n.to), hide);
        return;
      }
      if (name === "Emphasis") return void out.push(Decoration.mark({ class: "cm-em" }).range(n.from, n.to));
      if (name === "StrongEmphasis") return void out.push(Decoration.mark({ class: "cm-strong" }).range(n.from, n.to));
      if (name === "Strikethrough") return void out.push(Decoration.mark({ class: "cm-strike" }).range(n.from, n.to));
      if (name === "EmphasisMark" || name === "StrikethroughMark") {
        const p = n.node.parent;
        if (p && !at(p.from, p.to)) replace(n.from, n.to, hide);
        return;
      }
      if (name === "InlineCode") {
        skip.push([n.from, n.to]);
        out.push(Decoration.mark({ class: "cm-code" }).range(n.from, n.to));
        if (!at(n.from, n.to)) for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === "CodeMark") replace(c.from, c.to, hide);
        return false;
      }
      if (name === "FencedCode" || name === "CodeBlock") {
        skip.push([n.from, n.to]);
        eachLine(n.from, n.to, (line, k, last) => out.push(Decoration.line({ class: `cm-fence${k === doc.lineAt(n.from).number ? " cm-fence-a" : ""}${k === last ? " cm-fence-z" : ""}` }).range(line.from)));
        return; // the code inside is highlighted by its own language
      }
      if (name === "Blockquote") return void eachLine(n.from, n.to, (line) => out.push(Decoration.line({ class: "cm-quote" }).range(line.from)));
      if (name === "QuoteMark") {
        if (!atLines(n.from, n.to)) replace(n.from, withSpace(n.to), hide);
        return;
      }
      if (name === "ListItem") return void listItem(n.node);
      if (name === "ListMark") {
        const item = n.node.parent;
        const task = item?.getChild("Task");
        if (task) {
          // "- [ ] text": the dash goes, the box stands in its place.
          if (!at(n.from, task.from + 3)) replace(n.from, withSpace(n.to), hide);
        } else if (item?.parent?.name === "BulletList") {
          if (!at(n.from, n.to) && replace(n.from, n.to, Decoration.replace({ widget: new Bullet() }))) gap(n.to);
        } else if (item?.parent?.name === "OrderedList") {
          out.push(Decoration.mark({ class: "cm-ol", attributes: { style: `width: ${n.to - n.from}ch` } }).range(n.from, n.to));
          gap(n.to);
        }
        return;
      }
      if (name === "TaskMarker") {
        const checked = /x/i.test(doc.sliceString(n.from, n.to));
        const task = n.node.parent;
        const item = task?.parent;
        // A done task is struck through on every line its own text runs over; the items under it are not.
        if (checked) eachLine(n.from, task ? task.to : n.to, (line) => out.push(Decoration.line({ class: "cm-task-done" }).range(line.from)));
        const mark = item?.getChild("ListMark");
        if (!at(mark ? mark.from : n.from, n.to) && replace(n.from, n.to, Decoration.replace({ widget: new Checkbox(checked, n.from) }))) gap(n.to);
        return;
      }
      if (name === "Link") {
        // The inside of a [[wiki link]] reads as a link to the grammar. It is drawn below, as one piece.
        if (doc.sliceString(n.from - 1, n.from) === "[" && doc.sliceString(n.to, n.to + 1) === "]") return false;
        const marks = n.node.getChildren("LinkMark");
        const url = n.node.getChild("URL");
        if (marks.length < 2) return;
        const [open, close] = marks;
        out.push(Decoration.mark({ class: "cm-link", attributes: url ? { "data-follow": doc.sliceString(url.from, url.to), title: "⌘-click to open" } : {} }).range(open.to, close.from));
        if (!at(n.from, n.to)) {
          const names = url && ctx.icons ? ctx.icons(doc.sliceString(url.from, url.to)) : [];
          replace(open.from, open.to, names.length ? Decoration.replace({ widget: new Icons(names) }) : hide);
          replace(close.from, n.to, hide);
        } else if (url) out.push(Decoration.mark({ class: "cm-url" }).range(url.from, url.to));
        return;
      }
      if (name === "Image") {
        const url = n.node.getChild("URL");
        if (url && !at(n.from, n.to)) {
          const alt = doc.sliceString(n.from + 2, Math.max(n.from + 2, (n.node.getChildren("LinkMark")[1] || n.node).from));
          replace(n.from, n.to, Decoration.replace({ widget: new Media(doc.sliceString(url.from, url.to), alt, ctx) }));
        } else out.push(Decoration.mark({ class: "cm-url" }).range(n.from, n.to));
        return false;
      }
      if (name === "URL") {
        const p = n.node.parent?.name;
        if (p !== "Link" && p !== "Image") {
          const names = ctx.icons && !at(n.from, n.to) ? ctx.icons(doc.sliceString(n.from, n.to)) : [];
          if (names.length) out.push(Decoration.widget({ widget: new Icons(names), side: -1 }).range(n.from));
          out.push(Decoration.mark({ class: "cm-link", attributes: { "data-follow": doc.sliceString(n.from, n.to), title: "⌘-click to open" } }).range(n.from, n.to));
        }
        return;
      }
      if (name === "HorizontalRule") {
        if (!atLines(n.from, n.to)) {
          lineClass(n.from, "cm-hr");
          replace(n.from, n.to, Decoration.replace({ widget: new Rule() }));
        }
        return;
      }
      if (name === "Comment" || name === "CommentBlock") {
        skip.push([n.from, n.to]);
        eachLine(n.from, n.to, (line) => out.push(Decoration.line({ class: "cm-comment" }).range(line.from)));
        return false;
      }
      if (name === "Table") {
        skip.push([n.from, n.to]);
        const from = doc.lineAt(n.from).from;
        const to = doc.lineAt(n.to).to;
        if (!at(from, to)) replace(from, to, Decoration.replace({ widget: new Table(doc.sliceString(from, to), ctx), block: true }));
        else eachLine(from, to, (line) => out.push(Decoration.line({ class: "cm-table-src" }).range(line.from)));
        return false;
      }
    },
  });

  // [[wiki links]] and ![[embeds]]: not part of the Markdown grammar.
  const text = doc.toString();
  for (const m of text.matchAll(WIKI)) {
    const from = m.index;
    const to = from + m[0].length;
    if (skip.some(([a, b]) => from < b && to > a)) continue;
    const inner = m[2].replace(/\\\|/g, "|");
    const bar = inner.indexOf("|");
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const label = bar === -1 ? target.split("/").pop() : inner.slice(bar + 1).trim();
    if (at(from, to)) out.push(Decoration.mark({ class: "cm-url" }).range(from, to));
    else if (m[1] && ctx.media && ctx.media(target)) replace(from, to, Decoration.replace({ widget: new Media(target, label, ctx) }));
    else replace(from, to, Decoration.replace({ widget: new Wiki(target, label, ctx.known ? ctx.known(target) : true, ctx.icons ? ctx.icons(target) : []) }));
  }
  return Decoration.set(out, true);
}

function livePreview(ctx) {
  const field = StateField.define({
    create: (state) => build(state, ctx),
    update: (deco, tr) => (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) ? build(tr.state, ctx) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field];
}

const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "transparent", fontSize: "14.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--sans)", lineHeight: "1.6", overflow: "visible" },
  ".cm-content": { padding: "4px 0 40px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 2px" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { background: "var(--accent-bg)" },
  ".cm-panels": { background: "var(--bg-2)", color: "var(--text)", borderColor: "var(--line)" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--warn) 35%, transparent)" },
  // The list that opens after [[
  ".cm-tooltip": { background: "var(--bg-1)", color: "var(--text)", border: "1px solid var(--line-2)", borderRadius: "8px", boxShadow: "var(--shadow)", overflow: "hidden" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--sans)", fontSize: "13px", maxHeight: "280px", maxWidth: "560px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "5px 10px", lineHeight: "1.35" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-bg)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "10px", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" },
});

// Type [[ and pick a document of the vault, as in Obsidian. `ctx.suggest`
// gives the documents and the text that links each one.
function linkSource(ctx) {
  return (cx) => {
    const m = cx.matchBefore(/\[\[[^[\]\n]*$/);
    if (!m) return null;
    const closed = cx.state.sliceDoc(cx.pos, cx.pos + 2) === "]]"; // the pair the editor closed by itself
    const hits = ctx.suggest(m.text.slice(2));
    if (!hits.length) return null;
    return { from: m.from, to: cx.pos + (closed ? 2 : 0), filter: false, options: hits.map((a) => ({ label: a.title, detail: a.kind, apply: a.insert })) };
  };
}
// Brackets and quotes close themselves. Backticks and stars do not: a fence
// and a list marker are typed too often for that to help.
const pairs = Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", '"'] } }]));

// ── the editor ──
export function create({ parent, doc, readOnly = false, ctx = {}, onChange, onSave, onFiles, onPasteText }) {
  const mode = new Compartment();
  const diff = new Compartment(); // the comparison with an earlier text of the same file
  const run = (fn) => (view) => (fn(api), true);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        focused,
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        // The package's own Enter and Backspace are off: src/keys.mjs answers them the way Obsidian does.
        markdown({ base: markdownLanguage, codeLanguages, addKeymap: false, completeHTMLTags: false }),
        pairs,
        closeBrackets(),
        wrapOnType,
        ctx.suggest ? autocompletion({ override: [linkSource(ctx)], icons: false }) : [],
        syntaxHighlighting(highlight),
        search({ top: true }),
        mode.of(livePreview(ctx)),
        diff.of([]),
        theme,
        placeholder("Write here. Markdown works: ## heading, - list, - [ ] task, **bold**, `code`."),
        EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
        EditorView.updateListener.of((u) => u.docChanged && onChange && onChange()),
        keymap.of([
          { key: "Mod-s", run: () => (onSave && onSave(), true) },
          { key: "Mod-b", run: run((a) => a.wrap("**", "bold")) },
          { key: "Mod-i", run: run((a) => a.wrap("*", "italic")) },
          { key: "Mod-k", run: run((a) => a.link()) },
          { key: "Mod-e", run: run((a) => a.setLive(!a.live)) },
          { key: "Escape", run: (v) => (v.contentDOM.blur(), true) },
          ...obsidianKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            const a = e.target instanceof Element && e.target.closest("[data-follow]");
            if (a && (e.metaKey || e.ctrlKey || v.state.readOnly) && ctx.follow) {
              e.preventDefault();
              ctx.follow(a.dataset.follow);
              return true;
            }
            return false;
          },
          paste(e) {
            const cd = e.clipboardData;
            if (!cd) return false;
            if (cd.files && cd.files.length && onFiles) {
              e.preventDefault();
              onFiles(cd.files, api);
              return true;
            }
            if (onPasteText && onPasteText(cd.getData("text/plain"), cd.getData("text/html"), api)) {
              e.preventDefault();
              return true;
            }
            return false;
          },
          drop(e, v) {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length || !onFiles) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos !== null) v.dispatch({ selection: { anchor: pos } });
            onFiles(files, api);
            return true;
          },
        }),
      ],
    }),
  });

  const api = {
    view,
    live: true,
    baseline: null,
    text: () => view.state.doc.toString(),
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    // Replace the selection; `pick` selects a part of what was put in.
    insert(text, pick) {
      const at = view.state.selection.main.from;
      view.dispatch(view.state.replaceSelection(text));
      if (pick) view.dispatch({ selection: { anchor: at + pick[0], head: at + pick[1] } });
      view.focus();
    },
    wrap(mark, hint) {
      const s = api.selected() || hint;
      api.insert(`${mark}${s}${mark}`, [mark.length, mark.length + s.length]);
    },
    lines(prefix) {
      const { from, to } = view.state.selection.main;
      const changes = [];
      for (let n = view.state.doc.lineAt(from).number, last = view.state.doc.lineAt(to).number; n <= last; n++) changes.push({ from: view.state.doc.line(n).from, insert: prefix });
      view.dispatch({ changes });
      view.focus();
    },
    // The selected lines as a list: "task", "bullet" or "number". The same again takes the marker away
    // (a task is ticked instead). The toolbar and the keys go through the same code.
    list(kind) {
      (kind === "task" ? toggleTask : kind === "number" ? toggleNumber : toggleBullet)(view);
      view.focus();
    },
    link() {
      const s = api.selected();
      if (/^https?:\/\/\S+$/.test(s)) api.insert(`[link](${s})`, [1, 5]);
      else api.insert(`[${s || "text"}](https://)`, [(s || "text").length + 3, (s || "text").length + 11]);
    },
    setLive(on) {
      api.live = on;
      // The class goes in as an editor attribute: the editor rewrites its own class list on every focus change.
      view.dispatch({ effects: mode.reconfigure(on ? livePreview(ctx) : EditorView.editorAttributes.of({ class: "cm-source" })) });
    },
    // Show what changed against an earlier text of the same file: what was
    // added is marked in place, what was removed is drawn struck through where
    // it stood, and the text stays editable. `null` turns it off. The marks
    // follow the edits themselves (src/changes.mjs), so they do not move.
    setBaseline(text) {
      api.baseline = text;
      view.dispatch({ effects: diff.reconfigure(text === null || text === undefined ? [] : changeMarks(text)) });
    },
    changes: () => (api.baseline === null || api.baseline === undefined ? 0 : changeCount(view.state)),
    // Put the cursor on the next changed part and bring it into view; after the last, the first.
    nextChange() {
      if (!api.changes()) return;
      view.focus();
      nextChange(view);
    },
    // The text on screen becomes `text` (a saved file as the server wrote it, a draft that is
    // brought back). Only the part that differs is replaced, so the cursor and the marks stay.
    replaceAll(text) {
      const edit = smallestEdit(api.text(), text);
      if (edit) view.dispatch({ changes: edit });
    },
  };
  return api;
}

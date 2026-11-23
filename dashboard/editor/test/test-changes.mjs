// [dashboard-editor#3] [dashboard-editor#4] The change marks, with no page (the research note's Finding 22).
// Checks of the change marks (src/changes.mjs): what is marked as added and as
// removed after a writer's edits, and where. No page is needed.
// Run: npm test --prefix dashboard/editor

import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { changeMarks, changeField, earlierText, partsOf, hunksOf, drawingOf, putBack, smallestEdit } from "../src/changes.mjs";

const A = "With a rule, the .build folder is a finding of its own, like any other.";
const B = "The package there declares no dependencies, so it has no `Package.resolved`, and SwiftPM never writes one.";
const BASE = ["# Title", "", A, "", B, "", "## Decomposition", "", "- [ ] one", "- [ ] two"].join("\n");

// An editor without a page: a state, and the two things a command asks of a view.
function editor(doc = BASE, base = BASE) {
  let state = EditorState.create({ doc, extensions: [history(), changeMarks(base)] });
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs) {
      state = state.update(...specs).state;
      // What the marks say must always be the way from the earlier text to this one.
      assert.equal(state.field(changeField).apply(earlierText(state)).toString(), state.doc.toString());
    },
  };
  const at = (text, from = 0) => {
    const i = state.doc.toString().indexOf(text, from);
    assert.notEqual(i, -1, `no ${JSON.stringify(text)} in the text`);
    return i;
  };
  return {
    view,
    get state() {
      return state;
    },
    text: () => state.doc.toString(),
    at,
    // Typed one key at a time, as a person types.
    type(pos, text) {
      for (let i = 0; i < text.length; i++) view.dispatch({ changes: { from: pos + i, insert: text[i] }, userEvent: "input.type" });
    },
    paste: (from, to, text) => view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.paste" }),
    cut: (from, to) => view.dispatch({ changes: { from, to }, userEvent: "delete.cut" }),
    backspace(pos, n) {
      for (let i = 0; i < n; i++) view.dispatch({ changes: { from: pos - i - 1, to: pos - i }, userEvent: "delete.backward" });
    },
    parts: () => partsOf(state).map((p) => `${p.del ? `-${JSON.stringify(p.del)}` : ""}${p.del && p.ins ? " " : ""}${p.ins ? `+${JSON.stringify(p.ins)}` : ""}`),
    hunks: () => hunksOf(state),
    drawing: () => drawingOf(state),
  };
}
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  }
}

check("a text that was not touched has no marks", () => {
  const e = editor();
  assert.deepEqual(e.parts(), []);
  assert.deepEqual(e.drawing(), []);
});

check("typing on an empty line between two paragraphs marks only what was typed", () => {
  const e = editor();
  const blank = e.at(A) + A.length + 1;
  const text = "это чертовски круто!";
  for (let i = 0; i < text.length; i++) {
    e.view.dispatch({ changes: { from: blank + i, insert: text[i] }, userEvent: "input.type" });
    // After every key: one part, nothing removed. The empty line is not drawn as deleted.
    assert.deepEqual(e.parts(), [`+${JSON.stringify(text.slice(0, i + 1))}`]);
    assert.equal(e.drawing().filter((d) => d.kind === "gone").length, 0);
  }
});

check("a paragraph removed below the typed line is drawn below it, where it stood", () => {
  const e = editor();
  const blank = e.at(A) + A.length + 1;
  e.type(blank, "новая строка");
  e.cut(e.at(B), e.at(B) + B.length);
  assert.deepEqual(e.parts(), ['+"новая строка"', `-${JSON.stringify(B)}`]);
  const [typed, gone] = [e.drawing().find((d) => d.kind === "added"), e.drawing().find((d) => d.kind === "gone")];
  assert.ok(gone.at > typed.to, "the removed paragraph is after the typed text, not above it");
  assert.equal(e.state.doc.lineAt(gone.at).number, e.state.doc.lineAt(typed.from).number + 1);
});

check("putting the removed paragraph back where it stood leaves only the typed line", () => {
  const e = editor();
  const blank = e.at(A) + A.length + 1;
  e.type(blank, "новая строка");
  const from = e.at(B);
  e.cut(from, from + B.length);
  e.paste(from, from, B);
  assert.deepEqual(e.parts(), ['+"новая строка"']);
});

check("a paragraph cut and pasted elsewhere is removed in one place and added in the other", () => {
  const e = editor();
  const from = e.at(B);
  e.cut(from, from + B.length + 1); // with its line break
  e.paste(e.text().length, e.text().length, `\n${B}`);
  assert.deepEqual(e.parts(), [`-${JSON.stringify(`${B}\n`)}`, `+${JSON.stringify(`\n${B}`)}`]);
});

check("a word swapped for another keeps the same removed word while the new one is typed", () => {
  const e = editor();
  const w = e.at("declares");
  e.cut(w, w + 8);
  for (const [i, ch] of [..."decides"].entries()) {
    e.view.dispatch({ changes: { from: w + i, insert: ch }, userEvent: "input.type" });
    assert.deepEqual(e.parts(), [`-"declares" +${JSON.stringify("decides".slice(0, i + 1))}`]);
  }
});

check("typing a removed word again is no change", () => {
  const e = editor();
  const w = e.at("declares");
  e.backspace(w + 8, 8);
  assert.deepEqual(e.parts(), ['-"declares"']);
  e.type(w, "declares");
  assert.deepEqual(e.parts(), []);
});

check("typed text that is deleted again leaves no mark", () => {
  const e = editor();
  const end = e.at(A) + A.length;
  e.type(end, " And more.");
  e.backspace(end + 10, 10);
  assert.deepEqual(e.parts(), []);
});

check("undo takes the marks away with the text, redo brings them back", () => {
  const e = editor();
  e.type(e.at(A) + A.length, " More.");
  e.cut(e.at("## Decomposition"), e.at("## Decomposition") + 3);
  assert.equal(e.parts().length, 2);
  while (undo(e.view)) {}
  assert.equal(e.text(), BASE);
  assert.deepEqual(e.parts(), []);
  while (redo(e.view)) {}
  assert.equal(e.parts().length, 2);
});

check("Enter at the end of a paragraph and a new line: one added part, nothing removed", () => {
  const e = editor();
  const end = e.at(A) + A.length;
  e.view.dispatch({ changes: { from: end, insert: "\n" }, userEvent: "input" });
  e.type(end + 1, "next");
  assert.deepEqual(e.parts(), ['+"\\nnext"']);
  assert.equal(e.hunks().length, 1);
});

check("a line break removed between two lines is drawn as removed, and the lines are one change", () => {
  const e = editor();
  const at = e.at("- [ ] one") + 9;
  e.cut(at, at + 1);
  assert.deepEqual(e.parts(), ['-"\\n"']);
  assert.equal(e.hunks().length, 1);
});

check("a pasted picture is one added part", () => {
  const e = editor();
  const end = e.text().length;
  e.paste(end, end, "\n![pasted-2026-11-14-10-00-00.png](attachment:ab12cd34)\n");
  assert.deepEqual(e.parts(), ['+"\\n![pasted-2026-11-14-10-00-00.png](attachment:ab12cd34)\\n"']);
  assert.equal(e.hunks().length, 1);
});

check("the name of a pasted picture changing on save marks only the name", () => {
  const e = editor();
  const end = e.text().length;
  e.paste(end, end, "\n![shot.png](attachment:ab12cd34)\n");
  const saved = e.text().replace("attachment:ab12cd34", "attachments/shot.png");
  e.view.dispatch({ changes: smallestEdit(e.text(), saved) });
  assert.equal(e.text(), saved);
  assert.deepEqual(e.parts(), ['+"\\n![shot.png](attachments/shot.png)\\n"']);
});

check("a paragraph pasted over itself with two words changed marks the two words", () => {
  const e = editor();
  const from = e.at(B);
  e.paste(from, from + B.length, B.replace("declares", "lists").replace("never", "seldom"));
  assert.deepEqual(e.parts(), ['-"declares" +"lists"', '-"never" +"seldom"']);
});

check("text pasted into the middle of a line is one added part there", () => {
  const e = editor();
  const at = e.at("finding");
  e.paste(at, at, "real ");
  assert.deepEqual(e.parts(), ['+"real "']);
  assert.equal(e.drawing().find((d) => d.kind === "added").from, at);
});

check("a ticked box is a change of one character", () => {
  const e = editor();
  const box = e.at("- [ ] two") + 3;
  e.paste(box, box + 1, "x");
  assert.deepEqual(e.parts(), ['-" " +"x"']);
});

check("two edits on one line are one change with one button; edits on two lines are two", () => {
  const e = editor();
  e.paste(e.at("rule"), e.at("rule") + 4, "law");
  e.paste(e.at("finding"), e.at("finding"), "real ");
  assert.equal(e.hunks().length, 1);
  assert.equal(e.drawing().filter((d) => d.kind === "button").length, 1);
  e.paste(e.at("one"), e.at("one") + 3, "1");
  assert.equal(e.hunks().length, 2);
});

check("put back restores the earlier text of that change only", () => {
  const e = editor();
  e.paste(e.at("rule"), e.at("rule") + 4, "law");
  e.paste(e.at("one"), e.at("one") + 3, "1");
  putBack(e.view, e.hunks()[0]);
  assert.ok(e.text().includes(A));
  assert.deepEqual(e.parts(), ['-"one" +"1"']);
  putBack(e.view, e.hunks()[0]);
  assert.equal(e.text(), BASE);
  assert.deepEqual(e.parts(), []);
});

check("a file that already differs from the earlier text opens with those changes marked", () => {
  const saved = BASE.replace("declares", "lists").replace("- [ ] two", "- [ ] two\n- [ ] three");
  const e = editor(saved, BASE);
  assert.deepEqual(e.parts(), ['-"declares" +"lists"', '+"\\n- [ ] three"']);
  e.type(e.at(A) + A.length, "!");
  assert.deepEqual(e.parts(), ['+"!"', '-"declares" +"lists"', '+"\\n- [ ] three"']);
});

check("a removed line is drawn on the line that took its place, and that line is not marked as added", () => {
  const e = editor();
  const from = e.at("- [ ] one");
  e.cut(from, from + 10);
  const d = e.drawing();
  assert.equal(d.find((x) => x.kind === "gone").text, "- [ ] one\n");
  assert.deepEqual(d.filter((x) => x.kind === "line").map((x) => x.added), [false]);
});

check("an added line is marked as a line; the line after it is not", () => {
  const e = editor();
  const from = e.at("- [ ] two");
  e.paste(from, from, "- [ ] one and a half\n");
  const lines = e.drawing().filter((x) => x.kind === "line");
  assert.equal(lines.length, 1);
  assert.equal(e.state.doc.line(lines[0].line).text, "- [ ] one and a half");
});

check("a thousand random edits: the marks always lead from the earlier text to the text on screen, and can all be put back", () => {
  const e = editor();
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const words = ["слово", "word ", "\n", "- [ ] ", "x", " ", "`code`", "\n\n", "![a](b.png)"];
  for (let i = 0; i < 1000; i++) {
    const len = e.text().length;
    const from = rnd(len + 1);
    const kind = rnd(10);
    if (kind < 4) e.paste(from, from, words[rnd(words.length)]);
    else if (kind < 7) e.cut(from, Math.min(len, from + rnd(12)));
    else if (kind < 8) e.paste(from, Math.min(len, from + rnd(40)), words[rnd(words.length)]);
    else if (kind < 9) undo(e.view);
    else redo(e.view);
    for (const p of partsOf(e.state)) assert.notEqual(p.del, p.ins);
  }
  // Every change put back, one after another, gives the earlier text again.
  for (let n = 0; e.hunks().length; n++) {
    assert.ok(n < 5000, "putting changes back does not end");
    putBack(e.view, e.hunks()[0]);
  }
  assert.equal(e.text(), BASE);
  assert.deepEqual(e.parts(), []);
});

check("opened again after typing on an empty line: only the typed text is marked", () => {
  const e = editor(BASE.replace(`${A}\n\n${B}`, `${A}\ntyped\n${B}`), BASE);
  assert.deepEqual(e.parts(), ['+"typed"']);
});

check("opened again after a typed line and a removed paragraph: the paragraph is below the line", () => {
  const e = editor(BASE.replace(`${A}\n\n${B}\n`, `${A}\ntyped\n\n`), BASE);
  assert.deepEqual(e.parts(), ['+"typed\\n"', `-${JSON.stringify(`${B}\n`)}`]);
  const [typed, gone] = [e.drawing().find((d) => d.kind === "added"), e.drawing().find((d) => d.kind === "gone")];
  assert.ok(gone.at >= typed.to);
});

check("opened again after a paragraph was moved to the end: removed in one place, added in the other", () => {
  const e = editor(`${BASE.replace(`${B}\n\n`, "")}\n\n${B}`, BASE);
  const parts = e.parts();
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith("-") && parts[0].includes("The package there"), parts[0]);
  assert.ok(parts[1].startsWith("+") && parts[1].includes("The package there"), parts[1]);
});

check("two texts with nothing in common are one replacement, not a mark on every third letter", () => {
  const e = editor("Совсем другой текст на этом месте, без общих слов.\n", "The package there declares no dependencies at all.\n");
  assert.equal(e.parts().length, 1);
});

check("a text that is the earlier text again has no marks, whatever road led back", () => {
  const e = editor("abab", "abab");
  e.paste(0, 0, "ab");
  assert.deepEqual(e.parts(), ['+"ab"']);
  e.cut(4, 6); // the last two letters, which were there before
  assert.equal(e.text(), "abab");
  assert.deepEqual(e.parts(), []);
});

check("smallestEdit keeps what the two texts share", () => {
  assert.equal(smallestEdit("same", "same"), null);
  assert.deepEqual(smallestEdit("abc def", "abc xyz def"), { from: 4, to: 4, insert: "xyz " });
  assert.deepEqual(smallestEdit("aaa", "aa"), { from: 2, to: 3, insert: "" });
  assert.deepEqual(smallestEdit("ab", "aab"), { from: 1, to: 1, insert: "a" });
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall change-mark checks pass");

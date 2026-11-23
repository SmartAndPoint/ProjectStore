// Checks of the editor's keys (src/keys.mjs). `|` is the cursor; two of them are a selection.
// Run: npm test --prefix dashboard/editor

import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { enter, shiftEnter, tab, shiftTab, backspace, toggleTask, toggleBullet, toggleNumber } from "../src/keys.mjs";

function run(cmd, src) {
  const a = src.indexOf("|");
  const b = src.lastIndexOf("|");
  const doc = src.replaceAll("|", "");
  const selection = a === b ? EditorSelection.cursor(a) : EditorSelection.range(a, b - 1);
  let state = EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage })] });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec) {
      state = state.update(spec).state;
    },
  };
  const handled = cmd(view);
  const m = state.selection.main;
  const text = state.doc.toString();
  return { handled, text: m.empty ? `${text.slice(0, m.head)}|${text.slice(m.head)}` : `${text.slice(0, m.from)}|${text.slice(m.from, m.to)}|${text.slice(m.to)}` };
}

let failed = 0;
function check(name, cmd, src, want, handled = true) {
  const got = run(cmd, src);
  try {
    assert.equal(got.text, want);
    assert.equal(got.handled, handled);
    console.log(`ok    ${name}`);
  } catch {
    failed++;
    console.log(`FAIL  ${name}\n  from: ${JSON.stringify(src)}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got.text)} handled=${got.handled}`);
  }
}

// Enter
check("a task goes on with an empty box", enter, "- [ ] one|", "- [ ] one\n- [ ] |");
check("after a done task the new box is empty", enter, "- [x] done|", "- [x] done\n- [ ] |");
check("the end of a wrapped item starts the next item", enter, "- [ ] first line\n      wrapped tail|\n- [ ] next", "- [ ] first line\n      wrapped tail\n- [ ] |\n- [ ] next");
check("an empty item at the top level loses its marker", enter, "- [ ] one\n- [ ] |", "- [ ] one\n|");
check("an empty nested item goes one level out", enter, "- a\n  - |", "- a\n- |");
check("an empty nested task keeps its box on the way out", enter, "- [ ] a\n  - [ ] |", "- [ ] a\n- [ ] |");
check("Enter inside the text splits the item", enter, "- aaa |bbb", "- aaa\n- |bbb");
check("Enter inside a wrapped line splits the item there", enter, "- [ ] aaa\n      bbb |ccc\n      ddd", "- [ ] aaa\n      bbb\n- [ ] |ccc\n      ddd");
check("Enter in the indentation of a wrapped line starts the item on that line", enter, "- [ ] aaa\n   |   bbb", "- [ ] aaa\n- [ ] |bbb");
check("a number goes up and the ones below follow", enter, "1. a|\n2. b\n3. c", "1. a\n2. |\n3. b\n4. c");
check("a list of repeated numbers stays repeated", enter, "1. a|\n1. b", "1. a\n1. |\n1. b");
check("a star stays a star", enter, "* a|", "* a\n* |");
check("Enter at the start of the text leaves an empty item above", enter, "- |text", "- \n- |text");
check("Enter before the marker moves the item down", enter, "|- a", "\n|- a");
check("a quote goes on", enter, "> text|", "> text\n> |");
check("an empty quote line ends the quote", enter, "> text\n> |", "> text\n|");
check("a list in a quote goes on in the quote", enter, "> - a|", "> - a\n> - |");
check("plain text gets a plain line", enter, "text|", "text\n|");
check("a paragraph right under a list is not an item", enter, "- a\ntext|", "- a\ntext\n|");
check("code keeps its indentation", enter, "```\n  x|\n```", "```\n  x\n  |\n```");
check("a list marker inside code is code", enter, "```\n- x|\n```", "```\n- x\n|\n```");
check("a selection is replaced by the new item", enter, "- aaa |bbb| ccc", "- aaa\n- |ccc");

// Shift-Enter
check("Shift-Enter stays in the task, under its text", shiftEnter, "- [ ] one|", "- [ ] one\n      |");
check("Shift-Enter stays in the bullet", shiftEnter, "- a|", "- a\n  |");
check("Shift-Enter in a wrapped line keeps its indentation", shiftEnter, "- [ ] a\n      b|", "- [ ] a\n      b\n      |");

// Tab and Shift-Tab
check("Tab puts an item under the one above", tab, "- a\n- b|", "- a\n  - b|");
check("Tab on the first item does nothing", tab, "- a|", "- a|");
check("Tab takes the wrapped lines and the children along", tab, "- [ ] a\n- [ ] b|\n      tail\n  - child\n- [ ] c", "- [ ] a\n  - [ ] b|\n        tail\n    - child\n- [ ] c");
check("Tab under a numbered item goes three columns in and starts at 1", tab, "1. a\n2. b|", "1. a\n   1. b|");
check("Tab from a wrapped line moves its item", tab, "- a\n- b\n  tail|", "- a\n  - b\n    tail|");
check("Shift-Tab brings an item back", shiftTab, "- a\n  - b|", "- a\n- b|");
check("Shift-Tab at the top level does nothing", shiftTab, "- a|", "- a|");
check("Shift-Tab takes the wrapped lines along", shiftTab, "- a\n  - [ ] b|\n        tail", "- a\n- [ ] b|\n      tail");
check("Tab in plain text is four spaces", tab, "ab|", "ab    |");

// Backspace
check("Backspace after a box removes the box", backspace, "- [ ] |x", "- |x");
check("Backspace after a marker removes the marker", backspace, "- |x", "|x");
check("Backspace after a nested marker keeps the indentation", backspace, "  - |x", "  |x");
check("Backspace after a number removes it", backspace, "12. |x", "|x");
check("Backspace in the text is the usual one", backspace, "- ab|", "- ab|", false);

// The checkbox key
check("the key ticks a task", toggleTask, "- [ ] a|", "- [x] a|");
check("the key unticks a task", toggleTask, "- [x] a|", "- [ ] a|");
check("the key gives a bullet a box", toggleTask, "- a|", "- [ ] a|");
check("the key makes a task of a plain line", toggleTask, "text|", "- [ ] text|");
check("the key makes a task of an empty line", toggleTask, "|", "- [ ] |");
check("the key on a wrapped line ticks its task", toggleTask, "- [ ] a\n      b|", "- [x] a\n      b|");

// Nested lists of every kind
check("Tab nests a task under a task", tab, "- [ ] a\n- [ ] b|", "- [ ] a\n  - [ ] b|");
check("Tab nests a bullet under a task", tab, "- [ ] a\n- b|", "- [ ] a\n  - b|");
check("Tab nests a task under a number", tab, "1. a\n- [ ] b|", "1. a\n   - [ ] b|");
check("Tab joins the children the item above already has", tab, "- a\n    - x\n- b|", "- a\n    - x\n    - b|");
check("Tab on a fresh empty task nests it", tab, "- [ ] a\n- [ ] |", "- [ ] a\n  - [ ] |");
check("Tab twice does not go deeper than one level under the item above", tab, "- a\n  - b|", "- a\n  - b|");

// Numbers follow the structure
check("a number that goes in starts at 1 and the rest close the gap", tab, "1. a\n2. b|\n3. c\n4. d", "1. a\n   1. b|\n2. c\n3. d");
check("a number that goes in goes on after the children already there", tab, "1. a\n   1. x\n   2. y\n2. b|\n3. c", "1. a\n   1. x\n   2. y\n   3. b|\n2. c");
check("a number goes in with its children untouched", tab, "1. a\n2. b|\n   1. x\n   2. y\n3. c", "1. a\n   1. b|\n      1. x\n      2. y\n2. c");
check("two selected numbers go in together", tab, "1. a\n|2. b\n3. c|\n4. d", "1. a\n|   1. b\n   2. c|\n2. d");
check("a number that comes out goes on after its parent and the rest follow", shiftTab, "1. a\n   1. b|\n2. c\n3. d", "1. a\n2. b|\n3. c\n4. d");
check("the numbers that stood below it go under it, from 1", shiftTab, "1. a\n   1. b|\n   2. c\n   3. d\n2. e", "1. a\n2. b|\n   1. c\n   2. d\n3. e");
check("its own children stay first under it", shiftTab, "1. a\n   1. b|\n      1. x\n   2. c\n2. e", "1. a\n2. b|\n   1. x\n   2. c\n3. e");
check("a list of repeated numbers is left alone going in", tab, "1. a\n1. b|\n1. c", "1. a\n   1. b|\n1. c");
check("Enter on an empty nested number brings it out and the rest follow", enter, "1. a\n   1. |\n2. b", "1. a\n2. |\n3. b");
check("Enter on an empty top number ends the list there and the rest take its number", enter, "1. a\n2. |\n3. b", "1. a\n|\n2. b");
check("Backspace on a number lets the rest take its number", backspace, "1. a\n2. |x\n3. b", "1. a\n|x\n2. b");
check("Enter in a nested number counts in its own list", enter, "1. a\n   1. x|\n   2. y\n2. b", "1. a\n   1. x\n   2. |\n   3. y\n2. b");

// The list keys
check("the bullet key makes a bullet", toggleBullet, "text|", "- text|");
check("the bullet key again takes the bullet away", toggleBullet, "- text|", "text|");
check("the bullet key turns a number into a bullet and the rest take its number", toggleBullet, "1. a|\n2. b", "- a|\n1. b");
check("the bullet key takes the box off a task", toggleBullet, "- [ ] a|", "- a|");
check("the number key makes the first number", toggleNumber, "text|", "1. text|");
check("the number key goes on after the item above", toggleNumber, "1. a\ntext|\n2. b", "1. a\n2. text|\n3. b");
check("the number key turns a bullet into a number", toggleNumber, "- a|", "1. a|");
check("the number key keeps the box of a task", toggleNumber, "- [ ] a|", "1. [ ] a|");
check("the number key again takes the number away", toggleNumber, "1. a|\n2. b", "a|\n1. b");
check("the number key numbers every selected line", toggleNumber, "|a\nb\nc|", "1. |a\n2. b\n3. c|");
check("the task key gives a number a box", toggleTask, "1. a|", "1. [ ] a|");
check("the task key on an empty nested line makes a nested task", toggleTask, "- [ ] a\n  |", "- [ ] a\n  - [ ] |");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

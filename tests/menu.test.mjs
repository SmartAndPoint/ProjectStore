// projectstore — tests/menu.test.mjs: the settings menu's state machine and
// renderer (the presentation spec's contract 14; the story "configure at a
// terminal is one settings menu…", PS-HARNESS). Pure: no terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMenu, renderMenu, width, STAIRCASE } from "../scripts/menu.mjs";
import { GLYPHS, PLAIN, plain } from "../scripts/term.mjs";

const COLOR = { ...PLAIN, color: true, live: true };
const ASCII = { ...PLAIN, ascii: true };

const values = (list) => () => list.map((v) => ({ value: v, label: v, kind: "value", description: `means ${v}` }));
function groups() {
  const model = (label, value) => ({
    id: `h:${label}`,
    key: `agents.${label}`,
    harness: "h",
    label,
    kind: "choice",
    value,
    describe: (v) => `Now: ${v ?? "—"}.`,
    options: () => [
      { value: "fable", label: "fable", kind: "value", section: "follows the newest", description: "Fable." },
      { value: "opus", label: "opus", kind: "value", description: "Opus." },
      { kind: "refresh", label: "refresh the list", section: "", description: "Asks." },
      { value: null, label: "use the default", kind: "value", description: "Drops it." },
    ],
    caption: () => ({ text: "Anthropic API · checked today 09:12" }),
  });
  const toggle = (key, value) => ({
    id: key,
    key,
    label: key,
    kind: "choice",
    toggle: true,
    value,
    options: values(["on", "off"]),
  });
  return [
    {
      title: "Agents · Claude Code",
      footer: "claude-code.json",
      description: "Which model each agent runs on.",
      items: ["default", "critic", "planner", "reviewer", "librarian", "archaeologist", "clerk"].map((n) =>
        model(n, n === "critic" ? "fable" : null),
      ),
    },
    {
      title: "Status line and band",
      footer: "projectstore.json",
      description: "What it draws.",
      items: [toggle("statusline", "on"), toggle("band", "on")],
    },
    {
      title: "Vault and templates",
      footer: "projectstore.json",
      description: "Where.",
      items: [
        { id: "vault", key: "vault", label: "vault", kind: "info", value: "~/vault" },
        { id: "default_author", key: "default_author", label: "default_author", kind: "text", value: "Ann" },
        { id: "tags", key: "tags", label: "tags", kind: "text", allowEmpty: true, value: "a, b" },
      ],
    },
  ];
}

test("menu contract 14: → opens, ↑↓ move, space takes a value and goes back, Enter reviews", () => {
  const m = createMenu({ groups: groups() });
  assert.equal(m.press("right"), "redraw");
  m.press("down"); // critic
  m.press("right"); // its values, the cursor on the value in effect
  assert.equal(m.top().t, "values");
  assert.equal(m.top().opts[m.top().i].value, "fable");
  m.press("down");
  m.press("space"); // opus, back to the settings
  assert.equal(m.top().t, "items");
  assert.deepEqual(
    m.changes().map((c) => [c.item.id, c.before, c.after]),
    [["h:critic", "fable", "opus"]],
  );
  assert.equal(m.press("enter"), "review");
});

test("menu contract 14: space toggles an on/off row; choosing the value in the file again drops the change", () => {
  const m = createMenu({ groups: groups() });
  m.press({ char: "s" }); // the letter jumps to Status line and band
  assert.equal(m.top().i, 1);
  m.press("right");
  m.press("space");
  assert.equal(m.pending.get("statusline"), "off");
  m.press("space");
  assert.equal(m.pending.has("statusline"), false, "back to the file's value: no change");
});

test("menu contract 14: ← at the groups leaves with nothing changed, and reviews with a change waiting; Ctrl+C cancels", () => {
  const a = createMenu({ groups: groups() });
  assert.equal(a.press("left"), "nothing");
  const b = createMenu({ groups: groups() });
  b.press("down");
  b.press("right");
  b.press("space");
  b.press("left");
  assert.equal(b.press("escape"), "review", "Esc is ←: no key but Ctrl+C drops a change");
  assert.equal(createMenu({ groups: groups() }).press("cancel"), "cancel");
});

test("menu contract 14: the review screen writes on Enter only when it is ok; ← goes back with the changes kept", () => {
  const m = createMenu({ groups: groups() });
  m.press("down");
  m.press("right");
  m.press("space");
  m.screen = "review";
  m.review = { ok: false, lines: [] };
  assert.equal(m.press("enter"), null, "a refused review has no enter");
  m.review = { ok: true, lines: [] };
  assert.equal(m.press("enter"), "write");
  m.press("left");
  assert.equal(m.screen, "menu");
  assert.equal(m.pending.get("statusline"), "off", "kept");
});

test("menu contract 14: a text field types, keeps a required value on an empty Enter, and clears one that may be empty", () => {
  const m = createMenu({ groups: groups() });
  m.press("down");
  m.press("down");
  m.press("right");
  m.press("down"); // default_author
  m.press("right");
  for (let k = 0; k < 3; k++) m.press("backspace");
  m.press("enter");
  assert.equal(m.pending.has("default_author"), false, "nothing typed: the author stays");
  m.press("right"); // the field opens on the value in effect
  for (let k = 0; k < 3; k++) m.press("backspace");
  for (const ch of "Bob") m.press({ char: ch });
  m.press("enter");
  m.press("down"); // tags
  m.press("right");
  for (let k = 0; k < 4; k++) m.press("backspace");
  m.press("enter");
  assert.deepEqual(Object.fromEntries(m.pending), { default_author: "Bob", tags: null });
});

test("menu contract 14: onOpen fires when a values frame opens; refresh asks onRefresh; rebuild keeps the cursor on its value", () => {
  const opened = [],
    refreshed = [];
  let extra = false;
  const g = groups();
  const critic = g[0].items[1];
  const base = critic.options;
  critic.options = () => (extra ? [{ value: "haiku", label: "haiku", kind: "value" }, ...base()] : base());
  const m = createMenu({ groups: g, onOpen: (it) => opened.push(it.id), onRefresh: (it) => refreshed.push(it.id) });
  m.press("right");
  m.press("down");
  m.press("right");
  assert.deepEqual(opened, ["h:critic"]);
  m.press("down");
  m.press("down"); // refresh the list
  m.press("right");
  assert.deepEqual(refreshed, ["h:critic"]);
  extra = true;
  m.rebuild();
  assert.equal(m.top().opts[m.top().i].kind, "refresh", "the cursor stays on refresh after a row is added above it");
});

test("menu contract 14: at 100, 80 and 40 columns no line is wider than columns − 1; 100 draws the staircase, below one frame", () => {
  for (const columns of [100, 80, 40]) {
    const m = createMenu({ groups: groups() });
    const shots = [];
    for (const k of [null, "right", "down", "right"]) {
      if (k) m.press(k);
      shots.push(renderMenu(m, { caps: COLOR, columns, rows: 30, path: "~/p" }));
    }
    for (const lines of shots) {
      for (const l of lines) assert.ok(width(l) <= columns - 1, `${columns}: ${width(l)} > ${columns - 1}: ${l}`);
      assert.ok(lines.length <= 30);
    }
    const settingsLevel = plain(shots[2].join("\n"));
    if (columns >= STAIRCASE.min)
      assert.match(settingsLevel, /╭─ Settings[\s\S]*╭─ Agents · Claude Code[\s\S]*╭─ critic/);
    else assert.doesNotMatch(settingsLevel, /╭─ Settings/, "one frame only");
  }
});

test("menu contract 14: a frame taller than its rows shows a window around the cursor and says how many it hides", () => {
  const m = createMenu({ groups: groups() });
  m.press("right");
  for (let k = 0; k < 6; k++) m.press("down"); // clerk, the last
  const text = renderMenu(m, { caps: PLAIN, columns: 80, rows: 16, path: "" }).join("\n");
  assert.match(text, /↑ \d+ more/);
  assert.match(text, /› {2}clerk/);
});

test("menu contract 14: with ASCII glyphs no glyph of the table is drawn, and the hint's arrows are words", () => {
  const unicode = new Set(
    Object.values(GLYPHS)
      .map(([u]) => u)
      .filter((u) => /[^\x20-\x7e]/.test(u)),
  );
  const m = createMenu({ groups: groups() });
  for (const k of [null, "right", "down", "right"]) {
    if (k) m.press(k);
    for (const columns of [100, 60]) {
      const lines = renderMenu(m, { caps: ASCII, columns, rows: 30, path: "~/p" });
      for (const l of lines) for (const ch of l) assert.ok(!unicode.has(ch), `${ch} in ${l}`);
      assert.match(lines.join("\n"), /up\/down move/);
    }
  }
});

test("menu contract 14: without colour the cursor, the value in effect and a change are still marked", () => {
  const m = createMenu({ groups: groups() });
  m.press("right");
  m.press("down");
  m.press("right");
  m.press("down");
  m.press("space");
  m.press("right");
  const text = renderMenu(m, { caps: PLAIN, columns: 100, rows: 30, path: "" }).join("\n");
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(text, /› ● opus/);
  assert.match(text, /↻ critic {2,}fable → opus/);
});

// projectstore — menu.mjs: the settings menu (presentation spec contract 14;
// the story "configure at a terminal is one settings menu: arrow keys, a line
// that says what each row means, and model lists read from each harness").
//
//   createMenu({ groups, onRefresh })  → the state machine: press(key) → what
//                                        the driver does next; no terminal
//   renderMenu(menu, { caps, columns, rows, head, path }) → the screen's lines
//
// Pure: no terminal, no file, no clock. The driver (term.mjs openScreen)
// feeds it keys and draws its lines; the caller (configure.mjs) describes the
// groups, settings and values, and decides what a review shows.
//
// A group is { title, footer, description, items }. An item is
//   { id, label, kind: "choice" | "text" | "info", toggle, value,
//     display(v), tag, describe(v, changed), options(), caption() }
// where options() answers the values, each
//   { value, label, note, description, tag, section, kind: "value" | "text" | "refresh" }
// and caption() the values frame's footer, { text, busy } or null. A value
// of null is "none" (cleared); a pending change is kept by item id.

import { glyphText, icon, painter, plain } from "./term.mjs";

const same = (a, b) => (a ?? null) === (b ?? null);
const optKey = (o) => (o.kind === "refresh" ? "#refresh" : o.kind === "text" ? "#text" : `v:${o.value ?? ""}`);

export function createMenu({ groups, onRefresh = () => {}, onOpen = () => {} }) {
  const m = {
    groups,
    pending: new Map(),
    screen: "menu", // menu | review | done | cancelled
    stack: [{ t: "groups", i: 0 }],
    review: null, // { lines, ok } while the review screen is up
    onRefresh,
  };
  m.top = () => m.stack[m.stack.length - 1];
  m.eff = (it) => (m.pending.has(it.id) ? m.pending.get(it.id) : it.value);
  m.changed = (it) => m.pending.has(it.id);
  m.set = (it, v) => {
    if (same(v, it.value)) m.pending.delete(it.id);
    else m.pending.set(it.id, v ?? null);
  };
  m.itemAt = (f) => (f.t === "items" ? m.groups[f.g].items[f.i] : f.it || null);
  m.list = (f) => {
    if (f.t === "groups") return m.groups.map((g) => g.title);
    if (f.t === "items") return m.groups[f.g].items.map((it) => it.label);
    if (f.t === "values") return f.opts.map((o) => o.label ?? String(o.value ?? ""));
    return [];
  };
  // A values frame's options again, after a background read: the cursor
  // stays on the same value.
  m.rebuild = () => {
    for (const f of m.stack)
      if (f.t === "values") {
        const k = optKey(f.opts[f.i] || {});
        f.opts = f.it.options();
        f.i = Math.max(
          0,
          f.opts.findIndex((o) => optKey(o) === k),
        );
      }
  };
  const valuesAt = (it) => {
    const opts = it.options();
    const v = m.eff(it);
    return {
      t: "values",
      it,
      opts,
      i: Math.max(
        0,
        opts.findIndex((o) => o.kind !== "text" && o.kind !== "refresh" && same(o.value, v)),
      ),
    };
  };
  const open = (f) => {
    if (f.t === "groups") {
      m.stack.push({ t: "items", g: f.i, i: 0 });
      return;
    }
    if (f.t === "items") {
      const it = m.itemAt(f);
      if (it.kind === "text") m.stack.push({ t: "text", it, buf: String(m.eff(it) ?? "") });
      else if (it.kind === "info") m.stack.push({ t: "info", it });
      else {
        m.stack.push(valuesAt(it));
        onOpen(it);
      }
      return;
    }
    if (f.t === "values") {
      const o = f.opts[f.i];
      if (o?.kind === "text") m.stack.push({ t: "text", it: f.it, buf: String(m.eff(f.it) ?? "") });
      else if (o?.kind === "refresh") m.onRefresh(f.it);
    }
  };
  const finish = () => (m.pending.size ? "review" : "nothing");
  const jump = (f, ch) => {
    const L = m.list(f);
    for (let d = 1; d <= L.length; d++) {
      const j = (f.i + d) % L.length;
      if (String(L[j]).toLowerCase().startsWith(ch)) {
        f.i = j;
        return;
      }
    }
  };

  // One key, as the driver names it: up, down, left, right, space, enter,
  // escape, backspace, cancel, or { char }. Returns what the driver does:
  // "redraw", "review" (ask the caller for the review screen), "write",
  // "nothing" (leave: no change), "cancel", or null (ignored).
  m.press = (k) => {
    if (k === "cancel") {
      m.screen = "cancelled";
      return "cancel";
    }
    if (m.screen === "review") {
      if (k === "enter" && m.review?.ok) return "write";
      // A PLAN longer than the screen scrolls; renderMenu keeps the offset
      // inside what is there.
      if ((k === "up" || k === "down") && m.review?.long) {
        m.review.top = Math.max(0, (m.review.top || 0) + (k === "up" ? -1 : 1));
        return "redraw";
      }
      if (k === "left" || k === "escape") {
        m.screen = "menu";
        m.review = null;
        return "redraw";
      }
      return null;
    }
    const f = m.top();
    const ch = typeof k === "object" && k ? k.char : null;
    if (f.t === "text") {
      if (k === "enter") {
        // Nothing typed clears a field that may be empty, and changes nothing
        // in one that may not.
        if (f.buf.trim() || f.it.allowEmpty) m.set(f.it, f.buf.trim() || null);
        m.stack.pop();
        if (m.top().t === "values") m.stack.pop();
        return "redraw";
      }
      if (k === "escape" || k === "left") {
        m.stack.pop();
        return "redraw";
      }
      if (k === "backspace") {
        f.buf = [...f.buf].slice(0, -1).join("");
        return "redraw";
      }
      if (k === "space") {
        f.buf += " ";
        return "redraw";
      }
      if (ch) {
        f.buf += ch;
        return "redraw";
      }
      return null;
    }
    if (f.t === "info") {
      if (k === "left" || k === "escape") {
        m.stack.pop();
        return "redraw";
      }
      if (k === "enter") return finish();
      return null;
    }
    const n = m.list(f).length;
    if (k === "up") {
      if (f.i === 0) return null;
      f.i -= 1;
      return "redraw";
    }
    if (k === "down") {
      if (f.i >= n - 1) return null;
      f.i += 1;
      return "redraw";
    }
    if (k === "right") {
      open(f);
      return "redraw";
    }
    if (k === "space") {
      if (f.t === "values") {
        const o = f.opts[f.i];
        if (o.kind === "text" || o.kind === "refresh") open(f);
        else {
          m.set(f.it, o.value);
          m.stack.pop();
        }
        return "redraw";
      }
      const it = m.itemAt(f);
      if (it && it.toggle) {
        const opts = it.options().filter((o) => o.kind === "value");
        const at = opts.findIndex((o) => same(o.value, m.eff(it)));
        m.set(it, opts[(at + 1) % opts.length].value);
      } else open(f);
      return "redraw";
    }
    if (k === "left" || k === "escape") {
      if (m.stack.length > 1) {
        m.stack.pop();
        return "redraw";
      }
      return finish();
    }
    if (k === "enter") {
      if (f.t === "values") {
        const o = f.opts[f.i];
        if (o.kind === "value") m.set(f.it, o.value);
      }
      return finish();
    }
    if (ch) {
      jump(f, ch.toLowerCase());
      return "redraw";
    }
    return null;
  };

  // The changes waiting, in the groups' order: { item, before, after }.
  m.changes = () => {
    const out = [];
    for (const g of m.groups)
      for (const it of g.items) if (m.changed(it)) out.push({ item: it, before: it.value, after: m.eff(it) });
    return out;
  };
  return m;
}

// ─── Drawing ───────────────────────────────────────────────────────────
//
// A line is built from segments { t, r } — text and a colour role — so its
// width is measured before it is painted.

const S = (t, r = "") => ({ t: String(t), r });
export const seg = S;
const wlen = (s) => [...String(s)].length;
const segLen = (segs) => segs.reduce((n, s) => n + wlen(s.t), 0);
const padTo = (s, n) => (wlen(s) >= n ? s : s + " ".repeat(n - wlen(s)));

// A text in the glyph switch's column (contract 2): under ASCII glyphs every
// glyph of the table in it reads as its ASCII form, measured after.
const G = (c, t) => glyphText(c, String(t));

// Segments cut or padded to exactly `w` columns; a cut ends with the
// table's running glyph.
function fit(c, segs, w) {
  const mark = icon(c, "running");
  const out = [];
  let n = 0;
  for (const s0 of segs) {
    const s = { t: G(c, s0.t), r: s0.r };
    const cs = [...s.t];
    if (n + cs.length <= w) {
      out.push(s);
      n += cs.length;
      continue;
    }
    const room = w - n;
    if (room > 0) out.push(S(cs.slice(0, Math.max(0, room - wlen(mark))).join("") + mark.slice(0, room), s.r));
    n = w;
    break;
  }
  if (n < w) out.push(S(" ".repeat(w - n)));
  return out;
}

function wrapText(text, w) {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (!line) line = word;
    else if (wlen(line) + 1 + wlen(word) <= w) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

// A frame: a box of `w` columns around rows already laid out, its title in
// the top border and its footer in the bottom one. Taller than `h`, it shows
// a window that keeps row `cur` in view, and says how many rows it hides.
function frame(c, { title, rows, w, h, cur = 0, focus, footer, footerBusy }) {
  const b = focus ? "action" : "explanation";
  const inner = w - 4;
  const dash = icon(c, "rule");
  let top = 0;
  let shown = rows;
  const room = Math.max(1, h - 2);
  if (rows.length > room) {
    top = Math.min(Math.max(0, cur - Math.floor(room / 2)), rows.length - room);
    shown = rows.slice(top, top + room);
  }
  const above = top,
    below = rows.length - top - shown.length;
  // A border: its label in `role`, then `extra` ("↑ N more") in the
  // explanation role, cut together to the border's room.
  const edge = (l, r, label, role, extra) => {
    const max = w - 6;
    const sep = extra && label ? ` ${icon(c, "dot")} ` : "";
    let a = G(c, label || "");
    const e = G(c, extra || "");
    if (wlen(a) + wlen(sep) + wlen(e) > max) {
      const room = Math.max(0, max - wlen(sep) - wlen(e));
      a = wlen(a) > room ? [...a].slice(0, Math.max(0, room - 1)).join("") + icon(c, "running").slice(0, 1) : a;
    }
    const t = a + sep + e;
    if (!t) return [S(l + dash.repeat(w - 2) + r, b)];
    return [
      S(`${l}${dash} `, b),
      S(a, role),
      S(sep + e, "explanation"),
      S(` ${dash.repeat(Math.max(0, w - 5 - wlen(t)))}${r}`, b),
    ];
  };
  const more = (glyph, n) => (n ? `${icon(c, glyph)} ${n} more` : "");
  const lines = [
    edge(
      icon(c, "frameTopLeft"),
      icon(c, "frameTopRight"),
      title,
      focus ? "emphasis" : "explanation",
      more("moreAbove", above),
    ),
  ];
  for (const r of shown) lines.push([S(`${icon(c, "rail")} `, b), ...fit(c, r, inner), S(` ${icon(c, "rail")}`, b)]);
  lines.push(
    edge(
      icon(c, "frameBottomLeft"),
      icon(c, "frameBottomRight"),
      footer,
      footerBusy ? "action" : "explanation",
      more("moreBelow", below),
    ),
  );
  return { w, lines };
}

// Frames side by side: each { b, x, y } placed in an area `height` rows tall.
function compose(blocks, height) {
  const out = [];
  for (let r = 0; r < height; r++) {
    const line = [];
    let cur = 0;
    for (const o of blocks) {
      const k = r - o.y;
      if (k < 0 || k >= o.b.lines.length) continue;
      if (o.x > cur) line.push(S(" ".repeat(o.x - cur)));
      line.push(...o.b.lines[k]);
      cur = o.x + o.b.w;
    }
    out.push(line);
  }
  return out;
}

const show = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

// The row the keys act on: `›` and emphasis. A level above it: the row it
// opened from in emphasis, the rest explanation. A preview: all explanation.
const labelRole = (isCur, mode) =>
  mode === "focus"
    ? isCur
      ? "emphasis"
      : ""
    : mode === "parent"
      ? isCur
        ? "emphasis"
        : "explanation"
      : "explanation";
const cursorSeg = (c, isCur, mode) =>
  S(isCur && mode !== "preview" ? icon(c, "cursor") : " ", mode === "focus" ? "action" : "explanation");

function valueSegs(c, m, it, mode, room) {
  const base = mode === "focus" && it.kind !== "info" ? "" : "explanation";
  const display = (v) => G(c, it.display ? it.display(v) : show(v));
  const old = display(it.value);
  if (!m.changed(it)) return [S(old, base)];
  const now = display(m.eff(it));
  const strong = mode === "preview" ? "explanation" : "emphasis";
  const arrow = ` ${icon(c, "transition")} `;
  if (wlen(old) + wlen(arrow) + wlen(now) > room) return [S(now, strong)];
  return [S(old, "explanation"), S(arrow, "explanation"), S(now, strong)];
}

function itemRows(c, m, g, cur, mode, w) {
  const lw = Math.max(...g.items.map((it) => wlen(it.label))) + 1;
  const room = w - 4 - 3 - lw - 1;
  return g.items.map((it, k) => [
    cursorSeg(c, k === cur, mode),
    S(m.changed(it) ? icon(c, "update") : " ", "action"),
    S(" "),
    S(padTo(G(c, it.label), lw), labelRole(k === cur, mode)),
    S(" "),
    ...valueSegs(c, m, it, mode, room),
  ]);
}

function groupRows(c, m, cur, mode) {
  return m.groups.map((g, k) => [
    cursorSeg(c, k === cur, mode),
    S(g.items.some((it) => m.changed(it)) ? icon(c, "update") : " ", "action"),
    S(" "),
    S(g.title, labelRole(k === cur, mode)),
  ]);
}

function optionRows(c, m, it, opts, cur, mode, inner) {
  const wide = inner >= 40;
  const dash = icon(c, "rule");
  const lw = Math.min(22, Math.max(0, ...opts.map((o) => wlen(G(c, o.label ?? show(o.value))))));
  const rows = [];
  const at = [];
  opts.forEach((o, k) => {
    if (o.section !== undefined) {
      const name = G(c, o.section);
      rows.push([
        S(
          name ? `${dash.repeat(2)} ${name} ${dash.repeat(Math.max(2, inner - 4 - wlen(name)))}` : dash.repeat(inner),
          "explanation",
        ),
      ]);
    }
    const isCur = k === cur;
    const on = o.kind === "value" && same(o.value, m.eff(it));
    const glyph =
      o.kind === "text"
        ? icon(c, "add")
        : o.kind === "refresh"
          ? icon(c, "update")
          : icon(c, on ? "choiceOn" : "choiceOff");
    const gRole =
      o.kind === "refresh" ? (o.busy ? "action" : "explanation") : on && mode !== "preview" ? "action" : "explanation";
    const name = G(c, o.label ?? show(o.value));
    at.push(rows.length);
    const row = [
      cursorSeg(c, isCur, mode),
      S(" "),
      S(glyph, gRole),
      S(" "),
      S(wide ? padTo(name, lw) : name, o.kind === "refresh" && o.busy ? "action" : labelRole(isCur, mode)),
    ];
    if (wide && o.note) row.push(S(` ${G(c, o.note)}`, "explanation"));
    const tag = o.tag || (o.kind === "value" && m.changed(it) && same(o.value, it.value) ? "current" : "");
    if (tag && wide) {
      const room = inner - segLen(row);
      if (room >= wlen(tag) + 2)
        row.push(S(" ".repeat(room - wlen(tag)) + tag, tag === "new" ? "done" : "explanation"));
    }
    rows.push(row);
  });
  return { rows, cursorRow: cur >= 0 ? at[cur] : 0 };
}

function detailFrame(c, m, it, fr, w, h, focus) {
  const inner = w - 4;
  const mode = focus ? "focus" : "preview";
  let rows,
    cur = 0;
  if (fr && fr.t === "text") {
    let buf = G(c, fr.buf);
    const caret = c.ascii ? "_" : "█";
    if (wlen(buf) > inner - 3) buf = icon(c, "running").slice(0, 1) + [...buf].slice(-(inner - 4)).join("");
    rows = [
      [S(`${icon(c, "cursor")} `, "action"), S(buf), S(caret, "action")],
      [],
      [S("enter takes it · esc goes back", "explanation")],
    ];
  } else if (it.kind === "text") rows = [[S("  "), S(show(m.eff(it)), focus ? "" : "explanation")]];
  else if (it.kind === "info")
    rows = [
      [S(show(it.value))],
      [],
      [S("Changed by another command,", "explanation")],
      [S("named below.", "explanation")],
    ];
  else {
    const vf = fr && fr.t === "values" ? fr : null;
    const r = optionRows(c, m, it, vf ? vf.opts : it.options(), vf ? vf.i : -1, mode, inner);
    rows = r.rows;
    cur = r.cursorRow;
  }
  const cap = focus && it.caption ? it.caption() : null;
  return frame(c, {
    title: it.label,
    rows,
    w,
    h,
    cur,
    focus,
    footer: cap?.text || null,
    footerBusy: Boolean(cap?.busy),
  });
}

// What the cursor is on, for the panel under the frames: { title, tag, text }.
function about(m) {
  const f = m.top();
  if (f.t === "groups") {
    const g = m.groups[f.i];
    return { title: g.title, tag: "", text: g.description || "" };
  }
  if (f.t === "items") {
    const it = m.itemAt(f);
    return {
      title: it.title || it.label,
      tag: m.changed(it) ? "changed, not written yet" : it.tag || "",
      tagRole: m.changed(it) ? "action" : "explanation",
      text: it.describe ? it.describe(m.eff(it), m.changed(it)) : "",
    };
  }
  if (f.t === "values") {
    const o = f.opts[f.i];
    const it = f.it;
    const tag = o.tag || (o.kind === "value" && same(o.value, it.value) ? "in the file now" : "");
    return {
      title: o.label ?? show(o.value),
      tag,
      tagRole: o.tag === "new" ? "done" : "explanation",
      text: o.description || "",
    };
  }
  if (f.t === "text") return { title: f.it.title || f.it.label, tag: "typing", text: f.it.textHint || "" };
  return {
    title: f.it.title || f.it.label,
    tag: "set by another command",
    text: f.it.describe ? f.it.describe(f.it.value, false) : "",
  };
}

function hintParts(m) {
  if (m.screen === "review")
    return [
      ...(m.review?.ok ? ["enter writes it"] : []),
      ...(m.review?.long ? ["↑↓ scroll"] : []),
      "← back to the menu",
      "ctrl+c cancel",
    ];
  const f = m.top();
  if (f.t === "text") return ["type", "enter takes it", "esc back"];
  if (f.t === "info") return ["← back", "enter review", "ctrl+c cancel"];
  if (f.t === "values") return ["↑↓ move", "space choose", "← back", "enter review", "ctrl+c cancel"];
  return [
    "↑↓ move",
    "→ open",
    "space toggle",
    m.stack.length === 1 ? "← leave" : "← back",
    "enter review",
    "ctrl+c cancel",
  ];
}

// The hint's arrows in the glyph switch's column: ↑↓ ^v, → ->, ← <-.
const keyText = (c, s) => (c.ascii ? s.replace("↑↓", "up/down").replace("→", "right").replace("←", "left") : s);

function joinWrap(c, parts, w) {
  const sep = ` ${icon(c, "dot")} `;
  const out = [];
  let line = "";
  for (const p of parts) {
    const add = line ? line + sep + p : p;
    if (wlen(add) <= w) line = add;
    else {
      out.push(line);
      line = p;
    }
  }
  if (line) out.push(line);
  return out;
}

// The staircase's columns (contract 14): groups, settings and a preview at
// the first two levels; settings and values deeper. 99 columns with the
// rail's margin, one short of a 100-column terminal.
export const STAIRCASE = Object.freeze({ min: 100, groups: 27, items: 40, preview: 28, values: 56 });
export const SMALLEST = Object.freeze({ columns: 40, rows: 16 });

// The screen: an array of painted lines, none wider than `columns` - 1.
export function renderMenu(m, { caps: c, columns = 100, rows = 30, head = "projectstore configure", path = "" }) {
  const paint = painter(c);
  const W = Math.min(columns, 100) - 1;
  const bar = icon(c, "rail");
  const lines = [];
  const out = (segs) => lines.push(fit(c, segs, W));
  out([S(`${icon(c, "railTop")} `, "explanation"), S(head, "emphasis"), S(path ? `  ${path}` : "", "explanation")]);

  // Whether the review scrolls decides its hint: measured against the room
  // a two-line hint leaves, before the hint is laid out.
  if (m.screen === "review" && m.review)
    m.review.long = (m.review.lines || []).length > Math.max(3, rows - 1 - 1 - 1 - 1 - 3 - 1 - 2 - 1 - 1) + 4;
  const hints = joinWrap(
    c,
    hintParts(m).map((h) => keyText(c, h)),
    W - 2,
  );
  // The rows around the frames: the title, a blank, the panel's title and
  // three lines, the count, the hints and the end.
  const area = Math.max(3, rows - 1 - 1 - 1 - 1 - 3 - 1 - hints.length - 1 - 1);

  if (m.screen === "review") {
    out([S(`${icon(c, "ask")} `, "action"), S(m.review?.title || "Plan", "emphasis")]);
    // The PLAN's rows in a window: a PLAN longer than the room says how many
    // rows it hides above and below, and ↑/↓ move the window, so the Enter
    // that writes never confirms a row that could not be seen.
    const all = m.review?.lines || [];
    const room = area + 4;
    const fits = all.length <= room;
    const keep = fits ? all.length : room - 2;
    const top = fits ? 0 : Math.min(Math.max(0, m.review.top || 0), all.length - keep);
    if (m.review) Object.assign(m.review, { top, long: !fits });
    const hidden = (glyph, n) => [S(`${bar} `, "explanation"), S(`  ${icon(c, glyph)} ${n} more`, "explanation")];
    if (!fits) out(top ? hidden("moreAbove", top) : [S(bar, "explanation")]);
    for (const l of all.slice(top, top + keep)) lines.push(fit(c, [S(`${bar} `, "explanation"), ...l], W));
    if (!fits) {
      const below = all.length - top - keep;
      out(below ? hidden("moreBelow", below) : [S(bar, "explanation")]);
    }
    out([S(bar, "explanation")]);
    for (const h of hints) out([S(`${bar} `, "explanation"), S(h, "explanation")]);
    out([S(icon(c, "railEnd"), "explanation")]);
    return lines.map((l) =>
      l
        .map((s) => paint(s.r || null, s.t))
        .join("")
        .trimEnd(),
    );
  }

  const st = m.stack;
  const level = st.length - 1;
  const gi = st[0].i;
  const g = m.groups[gi];
  const ki = level >= 1 ? st[1].i : -1;
  const it = ki >= 0 ? g.items[ki] : null;
  const sep = ` ${icon(c, "pathSeparator")} `;
  const blocks = [];
  const clampY = (y, h) => Math.max(0, Math.min(y, area - h));
  const wideEnough = columns >= STAIRCASE.min;
  if (!wideEnough) {
    // One frame: the one the keys act on, under the whole path.
    const names = ["Settings", ...(level >= 1 ? [g.title] : []), ...(level >= 2 ? [it.label] : [])];
    out([
      S(`${icon(c, "ask")} `, "action"),
      S(names.slice(0, -1).join(sep) + (names.length > 1 ? sep : ""), "explanation"),
      S(names.at(-1), "emphasis"),
    ]);
    const w = W - 2;
    let b;
    if (level === 0)
      b = frame(c, { title: "Settings", w, h: area, cur: gi, focus: true, rows: groupRows(c, m, gi, "focus") });
    else if (level === 1)
      b = frame(c, {
        title: g.title,
        w,
        h: area,
        cur: ki,
        focus: true,
        footer: g.footer,
        rows: itemRows(c, m, g, ki, "focus", w),
      });
    else b = detailFrame(c, m, it, st[3] || st[2], w, area, true);
    blocks.push({ b, x: 0, y: 0 });
  } else if (level < 2) {
    out([S(`${icon(c, "ask")} `, "action"), S("What do you want to change?", "emphasis")]);
    const m1 = level === 0 ? "focus" : "parent";
    const m2 = level === 0 ? "preview" : "focus";
    const c1 = frame(c, {
      title: "Settings",
      w: STAIRCASE.groups,
      h: area,
      cur: gi,
      focus: level === 0,
      rows: groupRows(c, m, gi, m1),
    });
    blocks.push({ b: c1, x: 0, y: 0 });
    const c2 = frame(c, {
      title: g.title,
      w: STAIRCASE.items,
      h: area,
      cur: Math.max(0, ki),
      focus: level === 1,
      footer: g.footer,
      rows: itemRows(c, m, g, ki, m2, STAIRCASE.items),
    });
    // Its top border level with the group row it opened from.
    const y2 = clampY(1 + gi, c2.lines.length);
    blocks.push({ b: c2, x: STAIRCASE.groups + 1, y: y2 });
    if (level === 1) {
      const c3 = detailFrame(c, m, it, null, STAIRCASE.preview, area, false);
      blocks.push({ b: c3, x: STAIRCASE.groups + STAIRCASE.items + 2, y: clampY(y2 + 1 + ki, c3.lines.length) });
    }
  } else {
    out([S(`${icon(c, "ask")} `, "action"), S(`Settings${sep}`, "explanation"), S(g.title, "emphasis")]);
    const c2 = frame(c, {
      title: g.title,
      w: STAIRCASE.items,
      h: area,
      cur: ki,
      focus: false,
      footer: g.footer,
      rows: itemRows(c, m, g, ki, "parent", STAIRCASE.items),
    });
    blocks.push({ b: c2, x: 0, y: 0 });
    const c3 = detailFrame(c, m, it, st[3] || st[2], STAIRCASE.values, area, true);
    blocks.push({ b: c3, x: STAIRCASE.items + 1, y: clampY(1 + ki, c3.lines.length) });
  }
  for (const l of compose(blocks, area)) out([S(`${bar} `, "explanation"), ...l]);

  const a = about(m);
  out([S(bar, "explanation")]);
  out([S(`${bar} `, "explanation"), S(a.title, "emphasis"), S(a.tag ? `  ${a.tag}` : "", a.tagRole || "explanation")]);
  const text = wrapText(G(c, a.text), W - 2).slice(0, 3);
  while (text.length < 3) text.push("");
  for (const t of text) out([S(`${bar} `, "explanation"), S(t)]);
  const n = m.pending.size;
  out([
    S(`${bar} `, "explanation"),
    ...(n
      ? [
          S(`${icon(c, "update")} ${n} ${n === 1 ? "change" : "changes"} waiting`, "action"),
          S(` ${icon(c, "dot")} enter reviews`, "explanation"),
        ]
      : [S("nothing changed yet", "explanation")]),
  ]);
  for (const h of hints) out([S(`${bar} `, "explanation"), S(h, "explanation")]);
  out([S(icon(c, "railEnd"), "explanation")]);
  return lines.map((l) =>
    l
      .map((s) => paint(s.r || null, s.t))
      .join("")
      .trimEnd(),
  );
}

// For tests and the driver: a painted line's width.
export const width = (line) => wlen(plain(line));

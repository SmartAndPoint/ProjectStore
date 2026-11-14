// The command palette and the keyboard.
//
// One place to find anything: ⌘K opens it. Every command in it goes
// somewhere or opens something; none changes the vault, because the page
// changes nothing. The keys act on "the current item": the one open in the
// pane, or else the one selected in the view (j / k move the selection).

ui.sel = null; // "s:<story ref>", "e:<epic id>" or "i:<initiative id>"
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl+";

// ── the current item ──
function currentItem() {
  const d = ui.drawer;
  const key = d && d.kind !== "doc" ? `${d.kind[0]}:${d.id}` : ui.sel;
  if (!key) return null;
  const id = key.slice(2);
  if (key[0] === "s") return story(id) && { kind: "story", id, it: story(id) };
  if (key[0] === "e") return epic(id) && { kind: "epic", id, it: epic(id) };
  if (key[0] === "i" && id) {
    const it = S.initiatives.find((x) => x.id === id);
    return it && { kind: "initiative", id, it };
  }
  return null;
}
function applySel(scroll) {
  document.querySelectorAll("#view .sel").forEach((x) => x.classList.remove("sel"));
  document.querySelectorAll("#nav button").forEach((b, i) => i < 9 && !b.dataset.hint && ((b.dataset.hint = "1"), (b.title = `${b.title}  ·  press ${i + 1}`)));
  if (!ui.sel) return;
  const el = document.querySelector(`#view [data-key="${CSS.escape(ui.sel)}"]`);
  if (!el) return;
  el.classList.add("sel");
  if (scroll) el.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function setSel(key, scroll) {
  ui.sel = key;
  applySel(scroll);
}
const selectables = () => [...document.querySelectorAll("#view [data-key]")].filter((el) => el.offsetParent !== null);
function moveSel(delta) {
  const els = selectables();
  if (!els.length) return;
  const at = els.findIndex((el) => el.dataset.key === ui.sel);
  const next = at === -1 ? (delta > 0 ? 0 : els.length - 1) : Math.max(0, Math.min(els.length - 1, at + delta));
  setSel(els[next].dataset.key, true);
  if (ui.drawer) openSelected(); // with the pane open, j and k walk through items
}
// Left and right: the neighbour column on a board, fold and unfold in the tree.
function moveSide(delta) {
  const cur = ui.sel && document.querySelector(`#view [data-key="${CSS.escape(ui.sel)}"]`);
  if (!cur) return moveSel(delta);
  if (cur.tagName === "TR") {
    const open = ui.open.has(ui.sel);
    if (cur.querySelector(".caret:not(.none)") && (delta > 0 ? !open : open)) toggle(ui.sel);
    return;
  }
  const col = cur.closest(".col");
  if (!col) return;
  const cols = [...col.parentElement.querySelectorAll(".col")];
  const index = [...col.querySelectorAll(".card")].indexOf(cur);
  for (let k = cols.indexOf(col) + delta; k >= 0 && k < cols.length; k += delta) {
    const cards = cols[k].querySelectorAll(".card");
    if (cards.length) return setSel(cards[Math.min(index, cards.length - 1)].dataset.key, true);
  }
}
function openSelected() {
  const key = ui.sel;
  if (!key) return;
  if (key === "i:") return toggle(key);
  openDrawer({ s: "story", e: "epic", i: "initiative" }[key[0]], key.slice(2));
}
// The palette's "Copy link": to the open item, or to the view as it is filtered now. Either way
// the address carries the view's parameters (views.js), so it opens the same picture elsewhere.
function copyLink() {
  const c = currentItem();
  const view = savedDef(ui.view) ? viewLink(ui.view) : `${location.origin}${location.pathname}#/${ui.view}`;
  const [place, query] = view.split("?");
  copyText(c ? `${place}/${c.kind}/${encodeURIComponent(c.id)}${query ? `?${query}` : ""}` : view, "A link to this place");
}

// ── the palette ──
let pal = null;
// A command about an artifact carries the name of its kind; the row draws that kind's icon.
const ICON = { story: "story", epic: "epic", initiative: "initiative" };
const cmd = (label, run, more = {}) => ({ label, run, ...more });

function itemCommands(c) {
  if (!c) return [];
  const g = c.kind === "story" ? "This story" : c.kind === "epic" ? "This epic" : "This initiative";
  const out = [];
  const add = (label, run, more) => out.push(cmd(label, run, { group: g, ...more }));
  if (!ui.drawer || ui.drawer.id !== c.id) add("Open", () => openDrawer(c.kind, c.id), { key: "↵" });
  if (c.kind === "story") add(`Open its epic, ${c.it.epic}`, () => openDrawer("epic", c.it.epic), { icon: ICON.epic });
  if (c.kind === "epic" && c.it.initiative && S.initiatives.some((i) => i.id === c.it.initiative)) add("Open its initiative", () => openDrawer("initiative", c.it.initiative), { icon: ICON.initiative });
  if (ui.drawer && ui.drawer.id === c.id && ui.drawer.related) add(ui.drawer.tab === "rel" ? "Back to the text" : "Related, in full", () => showTab(ui.drawer, ui.drawer.tab === "rel" ? "doc" : "rel"));
  add("Copy a link to it", copyLink);
  return out;
}

function rootLevel(q) {
  const out = [...itemCommands(currentItem())];
  const nav = [...document.querySelectorAll("#nav button")];
  nav.forEach((b, i) => out.push(cmd(b.querySelector(".nm")?.textContent || b.textContent, () => b.click(), { group: "Go to", key: i < 9 ? String(i + 1) : "", kw: "go open view" })));
  out.push(
    cmd("Copy a link to this view", () => copyText(savedDef(ui.view) ? viewLink(ui.view) : `${location.origin}${location.pathname}#/${ui.view}`, "A link to this view"), { group: "Go to", kw: "share address url" }),
    cmd("Who am I…", null, { group: "Settings", children: () => S.people.filter((p) => p.kind === "person").map((p) => cmd(p.name, () => setMe(p.name), { mark: p.name === ui.me })) }),
    cmd("Read the vault again", load, { group: "Settings", key: "R" }),
    cmd("Keyboard shortcuts", showKeys, { group: "Settings", key: "?" }),
  );
  if (q.trim().length >= 2) {
    for (const i of S.initiatives) out.push(cmd(i.title, () => openDrawer("initiative", i.id), { group: "Initiatives", icon: ICON.initiative, hint: i.stage }));
    for (const e of S.epics) out.push(cmd(`${e.id} · ${e.title}`, () => openDrawer("epic", e.id), { group: "Epics", icon: ICON.epic, hint: e.status }));
    for (const s of S.stories) out.push(cmd(s.title, () => openDrawer("story", s.ref), { group: "Stories", icon: ICON.story, hint: `${s.epic} · ${s.column || s.status}`, kw: s.ref }));
    for (const a of ART) if (!["story", "epic", "initiative"].includes(a.type)) out.push(cmd(a.title, () => openDrawer("doc", a.rel), { group: "Documents", icon: a.type || "document", hint: `${a.type}${a.status ? ` · ${a.status}` : ""}` }));
  }
  return out;
}

function openPalette(level) {
  closePalette();
  const input = h("input", { type: "text", class: "pal-in", placeholder: "Search, or go to…", "aria-label": "Command palette", autocomplete: "off", spellcheck: false });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const crumb = h("div", { class: "pal-crumb" });
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Command palette" }, crumb, input, list, h("div", { class: "pal-foot" }, h("span", null, h("kbd", null, "↑↓"), " move"), h("span", null, h("kbd", null, "↵"), " run"), h("span", null, h("kbd", null, "esc"), " back"), h("span", { class: "grow" }), h("span", null, h("kbd", null, "?"), " all keys")));
  const back = h("div", { class: "pal-back", onmousedown: (e) => e.target === back && closePalette() }, box);
  pal = { back, stack: level ? [level] : [], idx: 0, shown: [] };
  const paint = () => {
    const top = pal.stack[pal.stack.length - 1];
    const q = input.value;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = top ? top.items : rootLevel(q);
    const score = (it) => {
      const l = it.label.toLowerCase();
      return l.startsWith(q.toLowerCase().trim()) ? 0 : words.every((w) => l.includes(w)) ? 1 : 2;
    };
    let shown = all.filter((it) => words.every((w) => `${it.label} ${it.hint || ""} ${it.kw || ""} ${it.group || ""}`.toLowerCase().includes(w)));
    if (words.length) shown = shown.map((it, i) => [score(it), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    shown = shown.slice(0, 60);
    pal.shown = shown;
    pal.idx = Math.min(pal.idx, Math.max(0, shown.length - 1));
    fill(crumb, top ? h("span", { class: "chip" }, top.title) : null);
    crumb.hidden = !top;
    input.placeholder = top ? "Type to narrow the list…" : "Search, or go to…";
    let group = null;
    const rows = [];
    shown.forEach((it, i) => {
      if (!words.length && it.group && it.group !== group) rows.push(h("div", { class: "pal-g" }, it.group));
      group = it.group;
      rows.push(
        h(
          "div",
          { class: `pal-i${i === pal.idx ? " on" : ""}`, role: "option", onmousemove: () => i !== pal.idx && ((pal.idx = i), paint()), onclick: () => run(it) },
          h("span", { class: "ic" }, it.mark ? "✓" : it.icon ? kindIco(it.icon) : ""),
          h("span", { class: "lb" }, it.label),
          words.length && it.group ? h("span", { class: "gp" }, it.group) : null,
          it.hint ? h("span", { class: "ht" }, it.hint) : null,
          it.key ? h("kbd", null, it.key) : null,
          it.children ? h("span", { class: "ht" }, "›") : null,
        ),
      );
    });
    if (!shown.length) rows.push(h("div", { class: "pal-none" }, "Nothing by that name."));
    fill(list, rows);
    list.querySelector(".pal-i.on")?.scrollIntoView({ block: "nearest" });
  };
  const run = (it) => {
    if (it.children) {
      pal.stack.push({ title: it.label.replace(/…$/, ""), items: it.children() });
      input.value = "";
      pal.idx = 0;
      return paint();
    }
    closePalette();
    it.run();
  };
  input.addEventListener("input", () => ((pal.idx = 0), paint()));
  input.addEventListener("keydown", (e) => {
    const n = pal.shown.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (e.preventDefault(), (pal.idx = n ? (pal.idx + 1) % n : 0), paint());
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (e.preventDefault(), (pal.idx = n ? (pal.idx - 1 + n) % n : 0), paint());
    else if (e.key === "Enter") (e.preventDefault(), pal.shown[pal.idx] && run(pal.shown[pal.idx]));
    else if (e.key === "Escape" || (e.key === "Backspace" && !input.value && pal.stack.length)) {
      e.preventDefault();
      e.stopPropagation();
      if (pal.stack.length && !(pal.stack.length === 1 && level)) (pal.stack.pop(), (pal.idx = 0), paint());
      else closePalette();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") (e.preventDefault(), closePalette());
    e.stopPropagation();
  });
  document.body.append(back);
  paint();
  input.focus();
}
function closePalette() {
  pal?.back.remove();
  pal = null;
}

// ── the keys ──
const KEYS = [
  [`${MOD}K`, "Search anything, go anywhere"],
  ["/", "Search in this view"],
  ["1 … 9", "Go to a view, in the order of the sidebar"],
  ["J  K", "Select the next or the previous item; with an item open, walk to it"],
  ["H  L", "Board: the column to the left or right. Backlog: fold or unfold"],
  ["↵  or  O", "Open the selected item"],
  ["Esc", "Close the item, or drop the selection"],
  ["R", "Read the vault again"],
  ["?", "This list"],
];
function showKeys() {
  dialog("Keyboard", h("div", { class: "keys" }, KEYS.flatMap(([k, t]) => [h("kbd", null, k), h("span", null, t)])), []);
}
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const t = e.target;
  // A field that is no longer on screen (a dialog just closed) can still hold
  // the focus for a moment; it is not typing.
  const typing = t instanceof HTMLElement && t.offsetParent !== null && (t.matches("input, textarea, select") || t.isContentEditable);
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return pal ? closePalette() : openPalette();
  }
  if (typing || mod || e.altKey || pal || !$("#modal").hidden || !S) return;
  const k = e.key;
  const done = () => e.preventDefault();
  if (k === "/") {
    const box = $('#view input[type="search"]');
    if (box) (done(), box.focus(), box.select());
  } else if (k === "?") (done(), showKeys());
  else if (/^[1-9]$/.test(k)) {
    const b = document.querySelectorAll("#nav button")[Number(k) - 1];
    if (b) (done(), b.click());
  } else if (k === "j" || (k === "ArrowDown" && !ui.drawer)) (done(), moveSel(1));
  else if (k === "k" || (k === "ArrowUp" && !ui.drawer)) (done(), moveSel(-1));
  else if (k === "l" || (k === "ArrowRight" && !ui.drawer)) (done(), moveSide(1));
  else if (k === "h" || (k === "ArrowLeft" && !ui.drawer)) (done(), moveSide(-1));
  else if (k === "o" || (k === "Enter" && !(t instanceof HTMLElement && t.matches("button, a, summary")))) {
    if (ui.sel) (done(), openSelected());
  } else if (k === "Escape") {
    if (!ui.drawer && ui.sel) setSel(null);
  } else if (k === "r") (done(), load());
});
// A click selects too, so the keys act on what was last touched.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element && e.target.closest("#view [data-key]");
  if (el) setSel(el.dataset.key);
});

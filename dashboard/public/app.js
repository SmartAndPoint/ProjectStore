// ProjectStore dashboard: the page. No framework, no build.
// Everything shown comes from GET /api/state and the other GET routes. The
// page only reads: nothing on it changes the vault.

const $ = (sel, el = document) => el.querySelector(sel);
// What this browser remembers for its viewer: the open view, folded rows, who is looking.
const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(`ws:${k}`)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`ws:${k}`, JSON.stringify(v));
    } catch {
      /* private window: the page works without it */
    }
  },
};

let S = null; // the state, as the server read it from the vault
const ui = {
  view: store.get("view", "backlog"),
  open: new Set(store.get("open", [])),
  seenOpen: store.get("seenOpen", false),
  filter: "",
  hideDone: store.get("hideDone", true),
  drawer: null,
};

// ── tiny DOM helper: text always goes in as text nodes ──
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (["value", "checked", "selected", "disabled", "hidden"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const PRI = ["p0", "p1", "p2", "p3"];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byOrder = (a, b) =>
  cmp(PRI.indexOf(a.priority), PRI.indexOf(b.priority)) ||
  cmp(a.rank === null ? Infinity : a.rank, b.rank === null ? Infinity : b.rank) ||
  cmp(a.title, b.title);
const initials = (name) =>
  name
    .replace(/^agent:/, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const isAgent = (name) => S.people.find((p) => p.name === name)?.kind === "agent";
const avatar = (name) => h("span", { class: `avatar${isAgent(name) ? " agent" : ""}`, title: name }, isAgent(name) ? "⚙" : initials(name));
const pillClass = (col) => (col ? col.toLowerCase().replace(" ", "-") : "aside");
const pill = (s) => h("span", { class: `pill ${pillClass(s.column)}` }, s.column || s.status);
// One word for one state, whatever the level: an epic that has not started reads "Backlog", as
// its stories do. The vault's own word stays in the tip.
const STATUS_LABEL = { planned: "Backlog", todo: "ToDo", "in-progress": "In Progress", review: "Review", done: "Done", proposed: "Proposed", elaborating: "Being worked out", accepted: "Accepted", rejected: "Rejected", deferred: "Deferred", superseded: "Superseded", parked: "Parked" };
const wordPill = (word, cls = word) => h("span", { class: `pill ${cls}`, title: `in the vault: ${word}` }, STATUS_LABEL[word] || word);
const epicPill = (e) => wordPill(e.status, e.status === "done" ? "done" : e.status === "in-progress" ? "in-progress" : "backlog");
const chipP = (p) => h("span", { class: `chip ${p}` }, p);
// Something that opens on a click opens from the keyboard too: Tab reaches it, Enter or Space
// opens it. The key stops here, so the page's own Enter (open the selected item) does not also run.
const opens = (fn, name) => ({
  tabindex: 0,
  role: "button",
  "aria-label": name,
  onclick: fn,
  onkeydown: (e) => {
    if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  },
});
const story = (ref) => S.stories.find((s) => s.ref === ref);
const epic = (id) => S.epics.find((e) => e.id === id);

// ── server ──
// The people are the flow policy's, and every assignee the policy does not
// list, so that a vault with no policy still has its people.
function withAssignees(state) {
  const known = new Set(state.people.map((p) => p.name));
  const working = (s) => s.column === "In Progress" || s.column === "Review";
  for (const name of state.assignees || []) {
    if (known.has(name)) continue;
    const mine = state.stories.filter((s) => s.assignee === name);
    state.people.push({
      name,
      kind: name.startsWith("agent:") ? "agent" : "person",
      time: null,
      limit: null,
      inPolicy: false,
      held: mine.filter((s) => working(s) && !s.awaiting).length,
      awaiting: mine.filter((s) => working(s) && s.awaiting).length,
      queued: mine.filter((s) => s.column === "ToDo").length,
    });
  }
  return state;
}
async function fetchState() {
  S = withAssignees(await (await fetch("/api/state")).json());
}
// Read the vault again: the state, the list of documents, and the open item.
async function load() {
  await fetchState();
  await loadArtifacts(); // item.js
  render();
  if (ui.drawer) fetchItem(); // item.js
}

// A short message in the corner: a link copied, or why a key did nothing.
function toast(kind, what, why) {
  const el = h(
    "div",
    { class: `toast ${kind}` },
    h("div", { class: "what" }, what, h("button", { class: "btn ghost", "aria-label": "close this message", onclick: () => el.remove() }, "✕")),
    why ? h("div", { class: "why" }, why) : null,
  );
  for (const old of document.querySelectorAll("#toasts .toast")) old.remove();
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

// ── modal ──
function dialog(title, body, actions) {
  const m = $("#modal");
  const close = () => {
    m.hidden = true;
    m.replaceChildren();
  };
  m.replaceChildren(
    h(
      "div",
      { class: "dialog", role: "dialog", "aria-label": title },
      h("h2", null, title),
      body,
      h(
        "div",
        { class: "btns" },
        h("button", { class: "btn", onclick: close }, actions.length ? "Cancel" : "Close"),
        actions.map((a) =>
          h(
            "button",
            {
              class: "btn primary",
              onclick: async () => {
                if ((await a.run()) !== false) close();
              },
            },
            a.label,
          ),
        ),
      ),
    ),
  );
  m.hidden = false;
  m.onclick = (e) => {
    if (e.target === m) close();
  };
  $("input, textarea, select, button", m)?.focus();
}

// ── Backlog: the tree of initiatives, epics, stories and subtasks ──
function toggle(key) {
  ui.open.has(key) ? ui.open.delete(key) : ui.open.add(key);
  store.set("open", [...ui.open]);
  render();
}
function progress(c) {
  const total = c.done + c.active + c.backlog;
  const w = (n) => `width:${total ? (n / total) * 100 : 0}%`;
  return h(
    "div",
    { class: "prog" },
    h("div", { class: "bar", title: `${c.done} done · ${c.active} in work · ${c.backlog} waiting` }, h("i", { class: "d", style: w(c.done) }), h("i", { class: "a", style: w(c.active) }), h("i", { class: "b", style: w(c.backlog) })),
    `${c.done}/${total}`,
  );
}
function viewBacklog() {
  if (!ui.seenOpen) {
    for (const i of S.initiatives) ui.open.add(`i:${i.id}`);
    ui.open.add("i:");
    ui.seenOpen = true;
    store.set("seenOpen", true);
    store.set("open", [...ui.open]);
  }
  const q = ui.filter.trim().toLowerCase();
  const hit = (t) => !q || t.toLowerCase().includes(q);
  const rows = [];
  const row = (cls, depth, key, kids, glyph, label, onOpen, cells, tags) =>
    h(
      "tr",
      { class: cls, "data-key": key },
      h(
        "td",
        null,
        h(
          "div",
          { class: "t", style: `padding-left:${depth * 20}px` },
          h("button", { class: `caret${kids ? "" : " none"}`, onclick: () => toggle(key), "aria-label": ui.open.has(key) || q ? "fold" : "unfold", "aria-expanded": ui.open.has(key) || q ? "true" : "false", tabindex: kids ? 0 : -1 }, ui.open.has(key) || q ? "▾" : "▸"),
          h("span", { class: "glyph", "aria-hidden": "true" }, glyph),
          h("span", { class: "label", title: label, ...opens(onOpen, `${cls}: ${label}`) }, label),
          tags,
        ),
      ),
      cells,
    );
  const storyRows = (e, depth) => {
    const list = S.stories
      .filter((s) => s.epic === e.id && (!ui.hideDone || s.column !== "Done") && hit(`${s.title} ${e.title} ${e.id}`))
      .sort((a, b) => cmp(S.coreColumns.indexOf(b.column), S.coreColumns.indexOf(a.column)) || byOrder(a, b));
    for (const s of list) {
      const done = s.subtasks.filter((t) => t.done).length;
      rows.push(
        row("story", depth, `s:${s.ref}`, s.subtasks.length, ico("story"), s.title, () => openDrawer("story", s.ref), [
          h("td", { class: "num" }, pill(s)),
          h("td", { class: "num" }, chipP(s.priority)),
          h("td", { class: "num dim" }, s.assignee || "—"),
          h("td", { class: "num" }, s.subtasks.length ? h("span", { class: "prog" }, `${done}/${s.subtasks.length} subtasks`) : ""),
        ]),
      );
      if (ui.open.has(`s:${s.ref}`) && !q)
        for (const t of s.subtasks)
          rows.push(h("tr", { class: "subtask" }, h("td", null, h("div", { class: "t", style: `padding-left:${(depth + 1) * 20 + 23}px` }, t.done ? "☑" : "☐", h("span", null, t.text))), h("td"), h("td"), h("td"), h("td")));
    }
    return list.length;
  };
  const epicRows = (list, depth) => {
    for (const e of list) {
      const mark = rows.length;
      const open = ui.open.has(`e:${e.id}`) || q;
      const shown = open ? storyRows(e, depth + 1) : 0;
      if (q && !shown && !hit(`${e.title} ${e.id}`)) continue;
      rows.splice(
        mark,
        0,
        row(
          "epic",
          depth,
          `e:${e.id}`,
          e.stories,
          ico("epic"),
          `${e.id} · ${e.title}`,
          () => openDrawer("epic", e.id),
          [
            h("td", { class: "num" }, epicPill(e)),
            h("td", { class: "num" }, chipP(e.priority)),
            h("td", { class: "num dim" }, ""),
            h("td", { class: "num" }, progress(e.counts)),
          ],
          e.standing && h("span", { class: "chip seed", title: "A standing epic: it is not done when its stories are" }, "standing"),
        ),
      );
    }
  };
  for (const i of [...S.initiatives].sort(byOrder)) {
    const mine = S.epics.filter((e) => e.initiative === i.id);
    rows.push(
      row(
        "initiative",
        0,
        `i:${i.id}`,
        mine.length,
        ico("initiative"),
        i.title,
        () => openDrawer("initiative", i.id),
        [
          h("td", { class: "num" }, wordPill(i.stage)),
          h("td", { class: "num" }, chipP(i.priority)),
          h("td", { class: "num dim" }, i.owner),
          h("td", { class: "num" }, mine.length ? progress(i.counts) : h("span", { class: "prog" }, "no epics yet")),
        ],
      ),
    );
    if (ui.open.has(`i:${i.id}`) || q) epicRows(mine, 1);
  }
  const loose = S.epics.filter((e) => !e.initiative || !S.initiatives.some((i) => i.id === e.initiative));
  if (loose.length) {
    rows.push(row("initiative none", 0, "i:", loose.length, ico("initiative"), `No initiative (${loose.length} epics)`, () => toggle("i:"), [h("td"), h("td"), h("td"), h("td")]));
    if (ui.open.has("i:") || q) epicRows(loose, 1);
  }
  return h(
    "div",
    null,
    h(
      "div",
      { class: "toolbar" },
      h("input", {
        type: "search",
        placeholder: "Filter by title or epic…",
        value: ui.filter,
        style: "width:280px",
        oninput: (e) => {
          ui.filter = e.target.value;
          const at = e.target.selectionStart;
          render();
          const box = $('#view input[type="search"]');
          box.focus();
          box.setSelectionRange(at, at);
        },
      }),
      h("label", { class: "chk" }, h("input", { type: "checkbox", checked: ui.hideDone, onchange: (e) => (store.set("hideDone", (ui.hideDone = e.target.checked)), render()) }), "Hide done stories"),
      h("button", { class: "btn ghost", onclick: () => (ui.open.clear(), store.set("open", []), render()) }, "Collapse all"),
      h("span", { class: "faint", style: "margin-left:auto" }, `${S.initiatives.length} initiatives · ${S.epics.length} epics · ${S.stories.length} stories`),
    ),
    !S.initiatives.length && h("div", { class: "note", style: "margin:0 0 10px" }, "There are no initiatives yet. An initiative names an outcome and holds the epics that deliver it; the vault keeps them in initiatives/."),
    h("table", { class: "tree" }, h("thead", null, h("tr", null, ["Work item", "Status", "Priority", "Owner / assignee", "Progress"].map((t) => h("th", null, t)))), h("tbody", null, rows)),
  );
}

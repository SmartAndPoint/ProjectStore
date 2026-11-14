// The shell and the views.
//
// A view is a name, a level (what the cards are: stories, epics or
// initiatives), a layout (board or list), a filter, lanes (or a grouping, in
// a list) and a sort. The address carries what differs from the built-in
// view, so a link opens the same picture for someone else. "Me" is a setting
// of this browser: the page has no sign-in, so it asks who is looking and
// filters by that name. Nothing of it is written to the vault.

ui.me = store.get("me", "");
ui.work = {}; // the filter being tried in each view

const GROUPS = { none: "No grouping", status: "Status", epic: "Epic", initiative: "Initiative", assignee: "Assignee", priority: "Priority" };
const SORTS = { order: "Backlog order", age: "Longest in its status", updated: "Recently updated", title: "Title" };
const WORK_FIRST = ["In Progress", "Review", "ToDo", "Backlog", "Done"];
const blankFilter = () => ({ q: "", initiative: "", epic: "", assignee: "", priority: [], columns: [], kind: "", ready: "", hideDone: false });
const BUILTIN = {
  board: { id: "board", name: "Board", level: "stories", layout: "board", group: "none", sort: "order", filter: blankFilter() },
  mine: { id: "mine", name: "My work", level: "stories", layout: "list", group: "status", sort: "order", filter: { ...blankFilter(), assignee: "@me", hideDone: true } },
  // The same board with initiatives for cards.
  initiatives: { id: "initiatives", name: "Initiatives", level: "initiatives", layout: "board", group: "none", sort: "order", filter: blankFilter() },
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const savedDef = (id) => BUILTIN[id] || null;
const workOf = (id) => (ui.work[id] ||= clone(savedDef(id)));

// ── the shell ──
// replaceChildren prints an array or a `false` as text; this drops the empty
// pieces and flattens, as h() does.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ""));
const isView = (id) => ["backlog", "board", "mine", "initiatives"].includes(id);
// On a narrow screen the menu slides over the page; a click anywhere else puts it back.
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("nav-open") && !e.target.closest(".nav, .nav-toggle")) document.body.classList.remove("nav-open");
});
function go(view) {
  document.body.classList.remove("nav-open");
  ui.drawer = null;
  ui.view = view;
  store.set("view", view);
  render();
  syncHash();
}
function render() {
  if (!S) return;
  fitBoards.disconnect(); // the boards of the last draw are gone
  if (!isView(ui.view)) ui.view = "backlog";
  const me = S.people.find((p) => p.name === ui.me);
  const open = S.stories.filter((s) => s.column && s.column !== "Done");
  // A number in the menu says what it counts, in its tip.
  const item = (id, label, n, counts) => h("button", { class: ui.view === id ? "on" : "", onclick: () => go(id), title: counts ? `${label}: ${counts}` : label }, h("span", { class: "nm" }, label), h("span", { class: "n" }, n ?? ""));
  const mineN = ui.me ? open.filter((s) => s.assignee === ui.me).length : null;
  fill(
    $("#nav"),
    h("div", { class: "nav-h" }, "Views"),
    item("backlog", "Backlog", S.epics.length, `${S.epics.length} epics under ${S.initiatives.length} initiatives`),
    item("board", "Board", open.length, `${open.length} stories that are not done`),
    item("mine", "My work", mineN ?? "?", mineN === null ? "say who you are, below" : `${mineN} stories of yours that are not done`),
    item("initiatives", "Initiatives", S.initiatives.length, `${S.initiatives.length} initiatives`),
  );
  fill(
    $("#foot"),
    h("label", { class: "f" }, h("span", null, "You are"), h("select", { onchange: (e) => setMe(e.target.value) }, h("option", { value: "", selected: !ui.me }, "— choose —"), S.people.filter((p) => p.kind === "person").map((p) => h("option", { selected: p.name === ui.me }, p.name)))),
    me && h("div", { class: "mono" }, `in work ${me.held}/${me.limit ?? "∞"} · ${me.queued} queued`),
    h("div", { style: "margin-top:10px" }, h("b", null, "Read only."), ` The vault of ${S.project.name}, as it is on disk. Nothing on this page changes it. core ${S.coreVersion}`),
  );
  const def = savedDef(ui.view);
  const title = ui.view === "backlog" ? "Backlog" : def.name;
  ui.viewTitle = title;
  const small = $(".brand small");
  if (small) small.textContent = `${S.project.name} · read only`; // two dashboards side by side must not look the same
  fill(
    $("#top"),
    h("button", { class: "btn nav-toggle", "aria-label": "menu", onclick: () => document.body.classList.toggle("nav-open") }, "☰"),
    h("h1", null, title),
    h("span", { class: "grow" }),
    h("button", { class: "btn kbtn", onclick: () => openPalette(), title: "Search anything, go anywhere" }, h("span", { class: "kt" }, "Search or go to"), h("kbd", null, `${MOD}K`)),
    h("button", { class: "btn", onclick: load, title: "Read the vault again (R)" }, "↻"),
  );
  const body = ui.view === "backlog" ? viewBacklog() : viewStories(ui.view);
  const view = $("#view");
  const focus = document.activeElement?.dataset?.keep;
  const caret = focus ? document.activeElement.selectionStart : 0;
  const scroll = view.scrollTop;
  view.replaceChildren(body);
  // The boards are fitted now, while they are drawn; the observer follows later changes of width.
  for (const b of view.querySelectorAll(".board:not(.lane-cells)")) {
    ui.boardW = b.clientWidth;
    fitBoard(b, b.clientWidth);
    b._edge();
  }
  view.scrollTop = scroll;
  if (focus) {
    const el = $(`[data-keep="${focus}"]`, view);
    el?.focus();
    el?.setSelectionRange?.(caret, caret);
  }
  applySel(); // keys.js: the selection survives a redraw
  renderDrawer();
  syncHash(true); // item.js: the address follows the filters, with no new step in the history
}
function setMe(name) {
  ui.me = name;
  store.set("me", name);
  render();
}

// ── filter, group, sort ──
function matches(s, f) {
  if (!s.column) return false; // set aside: on no board
  if (f.hideDone && s.column === "Done") return false;
  if (f.epic && s.epic !== f.epic) return false;
  if (f.initiative && (epic(s.epic)?.initiative || "-") !== f.initiative) return false;
  if (f.assignee === "@me" ? !ui.me || s.assignee !== ui.me : f.assignee === "@none" ? !!s.assignee : f.assignee && s.assignee !== f.assignee) return false;
  if (f.priority.length && !f.priority.includes(s.priority)) return false;
  if (f.columns.length && !f.columns.includes(s.column)) return false;
  if (f.kind === "elaboration" ? s.variant !== "elaboration" : f.kind === "story" && s.variant) return false;
  if (f.ready === "yes" ? !s.ready.ok : f.ready === "no" && s.ready.ok) return false;
  if (f.q) {
    const hay = `${s.title} ${s.epic} ${s.ref}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}
const SORTERS = {
  order: byOrder,
  age: (a, b) => cmp(b.ageDays ?? -1, a.ageDays ?? -1) || byOrder(a, b),
  updated: (a, b) => cmp(b.updated || "", a.updated || "") || byOrder(a, b),
  title: (a, b) => cmp(a.title, b.title),
};
function groupsOf(list, group) {
  const by = (keyOf, order, titleOf) => {
    const map = new Map();
    for (const s of list) {
      const k = keyOf(s);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    const keys = [...map.keys()].sort((a, b) => cmp(order(a), order(b)) || cmp(String(a), String(b)));
    return keys.map((k) => ({ key: k, title: titleOf(k), items: map.get(k) }));
  };
  const at = (arr, k) => (arr.indexOf(k) === -1 ? 999 : arr.indexOf(k));
  if (group === "status") return by((s) => s.column, (k) => at(WORK_FIRST, k), (k) => k);
  if (group === "priority") return by((s) => s.priority, (k) => at(PRI, k), (k) => `Priority ${k}`);
  if (group === "epic") return by((s) => s.epic, () => 0, (k) => `${k} · ${epic(k)?.title || ""}`);
  if (group === "assignee") return by((s) => s.assignee || "", (k) => (k ? at(S.people.map((p) => p.name), k) : 1000), (k) => k || "Unassigned");
  if (group === "initiative")
    return by((s) => epic(s.epic)?.initiative || "", (k) => (k ? 0 : 1), (k) => S.initiatives.find((i) => i.id === k)?.title || "No initiative");
  return [{ key: "", title: "", items: list }];
}

// ── the address: which view, and how it differs from the built-in one ──
// A link opens the same picture for someone else: the level, the layout, the
// lanes and every filter are parameters after the view's name. Only what
// differs from the built-in view is written, so a plain "#/board" is the
// board as it is built. "me" stays "me": it means whoever opens the link.
function paramsOf(def, base) {
  const p = new URLSearchParams();
  const put = (k, now, was) => String(now) !== String(was) && p.set(k, now);
  const who = (a) => a.replace(/^@/, "");
  const f = def.filter;
  const b = base.filter;
  put("level", def.level || "stories", base.level || "stories");
  put("layout", def.layout, base.layout);
  put("lanes", def.group, base.group);
  put("sort", def.sort, base.sort);
  put("q", f.q, b.q);
  put("initiative", f.initiative === "-" ? "none" : f.initiative, b.initiative === "-" ? "none" : b.initiative);
  put("epic", f.epic, b.epic);
  put("assignee", who(f.assignee), who(b.assignee));
  put("kind", f.kind, b.kind);
  put("ready", f.ready, b.ready);
  put("priority", f.priority.join(","), b.priority.join(","));
  put("status", f.columns.join(","), b.columns.join(","));
  put("done", f.hideDone ? "hide" : "show", b.hideDone ? "hide" : "show");
  return p.toString();
}
// The parameters of the open view, for the address bar (item.js writes it).
function viewQuery(id) {
  const base = savedDef(id);
  return base && ui.work[id] ? paramsOf(ui.work[id], base) : "";
}
// An address that was opened or pasted: the view becomes what it says. With
// no parameters it is the view as built, whatever was being tried before.
function applyQuery(id, query) {
  const base = savedDef(id);
  if (!base) return;
  const p = new URLSearchParams(query);
  if (![...p.keys()].length) return void delete ui.work[id];
  const def = clone(base);
  const f = def.filter;
  const csv = (k, ok) => p.get(k).split(",").filter((x) => ok.includes(x));
  if (LEVELS[p.get("level")]) def.level = p.get("level");
  if (["board", "list"].includes(p.get("layout"))) def.layout = p.get("layout");
  if (p.has("lanes")) def.group = p.get("lanes"); // a name the level does not have falls back to no lanes when the view is drawn
  if (SORTS[p.get("sort")]) def.sort = p.get("sort");
  if (p.has("q")) f.q = p.get("q").slice(0, 80);
  if (p.has("initiative")) f.initiative = p.get("initiative") === "none" ? "-" : p.get("initiative");
  if (p.has("epic")) f.epic = p.get("epic");
  if (p.has("assignee")) f.assignee = ["me", "none"].includes(p.get("assignee")) ? `@${p.get("assignee")}` : p.get("assignee");
  if (["story", "elaboration", ""].includes(p.get("kind"))) f.kind = p.get("kind");
  if (["yes", "no", ""].includes(p.get("ready"))) f.ready = p.get("ready");
  if (p.has("priority")) f.priority = csv("priority", PRI);
  if (p.has("status")) f.columns = csv("status", S.coreColumns);
  if (p.has("done")) f.hideDone = p.get("done") === "hide";
  ui.work[id] = def;
}
function viewLink(id) {
  const q = paramsOf(workOf(id), savedDef(id));
  return `${location.origin}${location.pathname}#/${id}${q ? `?${q}` : ""}`;
}
function copyText(url, what) {
  const shown = () => dialog(what, h("input", { type: "text", value: url, readonly: true, onfocus: (e) => e.target.select() }), []);
  if (!navigator.clipboard) return shown();
  navigator.clipboard.writeText(url).then(() => toast("ok", "Link copied", url), shown);
}
const copyViewLink = (id) => copyText(viewLink(id), "A link to this view");

// ── lanes ──
// What a board of each level can be cut into lanes by.
const LEVELS = { stories: "Stories", epics: "Epics", initiatives: "Initiatives" };
const LEVEL_ICON = { stories: "story", epics: "epic", initiatives: "initiative" };
const LANES = {
  stories: { none: "No lanes", initiative: "Initiative", epic: "Epic", assignee: "Person or agent", priority: "Priority" },
  epics: { none: "No lanes", initiative: "Initiative", priority: "Priority" },
  initiatives: { none: "No lanes", owner: "Owner", priority: "Priority" },
};
const LANE_KEY = {
  stories: { initiative: (s) => epic(s.epic)?.initiative || "", epic: (s) => s.epic, assignee: (s) => s.assignee || "", priority: (s) => s.priority },
  epics: { initiative: (e) => e.initiative || "", priority: (e) => e.priority },
  initiatives: { owner: (i) => i.owner || "", priority: (i) => i.priority },
};
const laneTitle = (dim, k) =>
  dim === "initiative" ? S.initiatives.find((i) => i.id === k)?.title || "No initiative" : dim === "epic" ? `${k} · ${epic(k)?.title || ""}` : dim === "assignee" ? k || "Unassigned" : dim === "owner" ? k || "No owner" : `Priority ${k}`;
function lanesOf(level, list, dim) {
  const keyOf = LANE_KEY[level][dim];
  const map = new Map();
  // Lanes that stand even when empty, so that who has nothing is seen too: every person and
  // agent, every priority, and on a board of epics every initiative.
  const always = dim === "assignee" ? S.people.map((p) => p.name) : dim === "priority" ? PRI : dim === "initiative" && level === "epics" ? [...[...S.initiatives].sort(byOrder).map((i) => i.id), ""] : [];
  for (const k of always) map.set(k, []);
  for (const x of list) {
    const k = keyOf(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  const order = (k) => (k === "" ? 9999 : always.includes(k) ? always.indexOf(k) : dim === "initiative" ? [...S.initiatives].sort(byOrder).findIndex((i) => i.id === k) : 5000);
  return [...map.keys()].sort((a, b) => cmp(order(a), order(b)) || cmp(String(a), String(b))).map((k) => ({ key: k, title: laneTitle(dim, k), items: map.get(k) }));
}
// A board with lanes: one row of column heads for all of them, then a row of
// the same columns for each lane. `cols` are builders: (items, lane) => a column.
function lanesBoard(level, dim, pool, cols) {
  if (dim === "none") return boardOf(cols.map((make) => make(pool, null)));
  const rows = [];
  const lanes = lanesOf(level, pool, dim).map((ln) => {
    const key = `${level}:${dim}:${ln.key}`;
    const closed = !!ui.laneClosed?.has(key);
    const row = closed ? null : h("div", { class: "board lane-cells" }, cols.map((make) => make(ln.items, { dim, key: ln.key })));
    if (row) rows.push(row);
    const person = dim === "assignee" && S.people.find((p) => p.name === ln.key);
    const flip = () => {
      ui.laneClosed ??= new Set();
      closed ? ui.laneClosed.delete(key) : ui.laneClosed.add(key);
      render();
    };
    return h(
      "section",
      { class: `lane${closed ? " closed" : ""}${ln.items.length ? "" : " bare"}` },
      h(
        "button",
        { class: "lane-head", type: "button", "aria-expanded": String(!closed), onclick: flip },
        h("span", { class: "tw", "aria-hidden": "true" }, closed ? "▸" : "▾"),
        (dim === "assignee" || dim === "owner") && ln.key ? avatar(ln.key) : null,
        h("span", { class: "lt" }, ln.title),
        h("span", { class: "n" }, ln.items.length),
        person ? h("span", { class: `wip${person.limit !== null && person.held > person.limit ? " over" : ""}`, title: "in work / limit" }, `${person.held}/${person.limit ?? "∞"}`) : null,
      ),
      row,
    );
  });
  const head = h("div", { class: "board heads" }, cols.map((make) => make(pool, { dim, key: null, heads: true })));
  head._rows = rows; // the lanes fold the same columns as the heads do
  head._edge = () => {};
  if (ui.boardW) fitBoard(head, ui.boardW);
  fitBoards.observe(head);
  return h("div", { class: "swim" }, head, lanes);
}

// ── a view: the filter bar, then a board (of stories, of epics or of initiatives) or a list of stories ──
function viewStories(id) {
  const def = workOf(id);
  const saved = savedDef(id);
  def.level ||= "stories";
  const level = def.level;
  if (level !== "stories") def.layout = "board"; // a list is a list of stories
  if (def.layout === "board" && !LANES[level][def.group]) def.group = "none"; // lanes this level does not have
  const f = def.filter;
  const set = (fn) => () => (fn(), render());
  const opt = (v, t, cur) => h("option", { value: v, selected: v === cur }, t);
  const pick = (name, cur, onchange, ...opts) => h("select", { "aria-label": name, title: name, onchange: (e) => (onchange(e.target.value), render()) }, opts);
  const chip = (on, label, toggle, title) => h("button", { class: `tog${on ? " on" : ""}`, type: "button", title, "aria-pressed": String(!!on), onclick: set(toggle) }, label);
  const flip = (arr, v) => (arr.includes(v) ? arr.splice(arr.indexOf(v), 1) : arr.push(v));
  const epics = S.epics.filter((e) => !f.initiative || (e.initiative || "-") === f.initiative);

  // What the view shows, at its level. The same filter reads a little differently at each:
  // "assignee" is who a story is for, who an epic has open work for, who owns an initiative.
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
  const person = f.assignee === "@me" ? ui.me : f.assignee === "@none" ? "" : f.assignee;
  const pri = (x) => !f.priority.length || f.priority.includes(x.priority);
  const pool =
    level === "stories"
      ? S.stories.filter((s) => matches(s, f))
      : level === "epics"
        ? S.epics.filter(
            (e) =>
              pri(e) &&
              hit(`${e.id} ${e.title}`) &&
              (!f.initiative || (e.initiative || "-") === f.initiative) &&
              (!f.epic || e.id === f.epic) &&
              (!f.hideDone || e.status !== "done") &&
              (!f.assignee || S.stories.some((s) => s.epic === e.id && s.column && s.column !== "Done" && (s.assignee || "") === person)),
          )
        : S.initiatives.filter((i) => pri(i) && hit(i.title) && (!f.initiative || i.id === f.initiative) && (!f.hideDone || i.stage !== "done") && (!f.assignee || (i.owner || "") === person));
  const total = level === "stories" ? S.stories.filter((s) => s.column).length : level === "epics" ? S.epics.length : S.initiatives.length;
  const dirty = !same(viewOf(def), viewOf(saved));

  // "Board" and "Initiatives" are the same board at two levels, each with its place in the menu:
  // the switch moves between them and takes the filter along. "My work" changes level in place.
  const toLevel = (k) => {
    const home = k === "initiatives" ? "initiatives" : "board";
    if ((id !== "board" && id !== "initiatives") || id === home) return void (def.level = k);
    ui.work[home] = { ...clone(BUILTIN[home]), level: k, filter: clone(f) };
    go(home);
  };

  // The filters are one line until asked for. What is set shows as chips, each taken off by a click.
  ui.fopen ??= false;
  const active = [f.initiative, f.epic, f.assignee, f.kind, f.ready].filter(Boolean).length + f.priority.length + f.columns.length;
  const off = (label, clear) => h("button", { class: "tog on fchip", type: "button", title: "Take this filter off", onclick: set(clear) }, label, h("span", { "aria-hidden": "true" }, " ✕"));
  const whoWord = level === "initiatives" ? "Owner" : level === "epics" ? "With work for" : "";
  const setChips = [
    f.initiative && off(f.initiative === "-" ? "No initiative" : `Initiative: ${(S.initiatives.find((i) => i.id === f.initiative)?.title || f.initiative).slice(0, 28)}`, () => (f.initiative = "")),
    f.epic && off(`Epic: ${f.epic}`, () => (f.epic = "")),
    f.assignee && off(`${whoWord ? `${whoWord}: ` : ""}${f.assignee === "@me" ? (whoWord ? "me" : "Mine") : f.assignee === "@none" ? (level === "initiatives" ? "nobody" : "Unassigned") : f.assignee}`, () => (f.assignee = "")),
    f.kind && off(f.kind === "story" ? "Stories" : "Initiatives to work out", () => (f.kind = "")),
    f.ready && off(f.ready === "yes" ? "Ready for ToDo" : "Not ready", () => (f.ready = "")),
    f.priority.map((p) => off(p, () => flip(f.priority, p))),
    f.columns.map((c) => off(c, () => flip(f.columns, c))),
    f.hideDone && off("Done hidden", () => (f.hideDone = false)),
    def.layout === "list" && def.group !== "none" && h("span", { class: "faint" }, `grouped by ${GROUPS[def.group].toLowerCase()}`),
  ]
    .flat()
    .filter(Boolean);
  // What a card need not repeat: the thing every card in sight shares.
  HIDE = new Set(
    [
      (f.assignee && f.assignee !== "@none") || def.group === "assignee" ? "who" : "",
      f.epic || def.group === "epic" ? "epic" : "",
      f.initiative || def.group === "initiative" ? "initiative" : "",
      (def.layout === "list" && def.group === "status") || f.columns.length === 1 ? "status" : "",
    ].filter(Boolean),
  );

  const bar = h(
    "div",
    { class: "fbar" },
    h(
      "div",
      { class: "frow" },
      h("input", { type: "search", "data-keep": "q", "aria-label": "Search titles", placeholder: "Search titles…", value: f.q, style: "flex:1 1 150px;max-width:240px", oninput: (e) => ((f.q = e.target.value), render()) }),
      h("button", { class: `tog${ui.fopen ? " on" : ""}`, type: "button", "aria-expanded": String(ui.fopen), onclick: set(() => (ui.fopen = !ui.fopen)) }, active ? `Filters · ${active}` : "Filters", ui.fopen ? " ▴" : " ▾"),
      // What the cards are: the same board over stories, over epics or over initiatives.
      h("span", { class: "seg", role: "group", "aria-label": "What the cards are" }, Object.entries(LEVELS).map(([k, t]) => chip(level === k, [ico(LEVEL_ICON[k]), t], () => toLevel(k), `A board of ${t.toLowerCase()}`))),
      level === "stories" && h("span", { class: "seg" }, chip(def.layout === "board", "Board", () => ((def.layout = "board"), LANES.stories[def.group] || (def.group = "none"))), chip(def.layout === "list", "List", () => (def.layout = "list"))),
      def.layout === "board" && pick("Lanes", def.group, (v) => (def.group = v), Object.entries(LANES[level]).map(([k, t]) => opt(k, k === "none" ? "No lanes" : `Lanes: ${t.toLowerCase()}`, def.group))),
      h("span", { class: "faint" }, `${pool.length} of ${total}`),
      h("span", { class: "grow" }),
      h("button", { class: "btn ghost", onclick: () => copyViewLink(id), title: "Copy a link that opens this view as it is now" }, "Copy link"),
      dirty && h("button", { class: "btn ghost", onclick: set(() => delete ui.work[id]) }, "Reset"),
    ),
    !ui.fopen && setChips.length > 0 && h("div", { class: "frow fchips" }, setChips),
    ui.fopen &&
      h(
        "div",
        { class: "frow" },
        level !== "initiatives" && pick("Initiative", f.initiative, (v) => ((f.initiative = v), (f.epic = "")), opt("", "All initiatives", f.initiative), S.initiatives.map((i) => opt(i.id, i.title.slice(0, 48), f.initiative)), opt("-", "No initiative", f.initiative)),
        level === "stories" && pick("Epic", f.epic, (v) => (f.epic = v), opt("", "All epics", f.epic), epics.map((e) => opt(e.id, e.id, f.epic))),
        pick(
          level === "initiatives" ? "Owner" : level === "epics" ? "With open work for" : "Assignee",
          f.assignee,
          (v) => (f.assignee = v),
          opt("", level === "initiatives" ? "Any owner" : level === "epics" ? "Work for anyone" : "Everyone", f.assignee),
          opt("@me", ui.me ? `Me (${ui.me})` : "Me", f.assignee),
          opt("@none", level === "initiatives" ? "No owner" : "Unassigned", f.assignee),
          [...new Set([...S.people.map((p) => p.name), ...(level === "initiatives" ? S.initiatives.map((i) => i.owner).filter(Boolean) : [])])].map((n) => opt(n, n, f.assignee)),
        ),
        level === "stories" && pick("Kind of story", f.kind, (v) => (f.kind = v), opt("", "Any type", f.kind), opt("story", "Stories", f.kind), opt("elaboration", "Initiatives to work out", f.kind)),
        level === "stories" && pick("Ready for ToDo or not", f.ready, (v) => (f.ready = v), opt("", "Ready or not", f.ready), opt("yes", "Ready for ToDo", f.ready), opt("no", "Not ready", f.ready)),
      ),
    ui.fopen &&
      h(
        "div",
        { class: "frow" },
        h("span", { class: "flabel" }, "Priority"),
        PRI.map((p) => chip(f.priority.includes(p), p, () => flip(f.priority, p))),
        def.layout === "list" && [h("span", { class: "flabel" }, "Status"), WORK_FIRST.filter((c) => c !== "Done" || !f.hideDone).map((c) => chip(f.columns.includes(c), c, () => flip(f.columns, c)))],
        h("label", { class: "chk" }, h("input", { type: "checkbox", checked: f.hideDone, onchange: (e) => ((f.hideDone = e.target.checked), render()) }), "Hide done"),
        h("span", { class: "grow" }),
        def.layout === "list" && [h("span", { class: "flabel" }, "Group"), pick("Group by", def.group, (v) => (def.group = v), Object.entries(GROUPS).map(([k, t]) => opt(k, t, def.group)))],
        def.layout === "list" && [h("span", { class: "flabel" }, "Sort"), pick("Sort by", def.sort, (v) => (def.sort = v), Object.entries(SORTS).map(([k, t]) => opt(k, t, def.sort)))],
      ),
  );

  // Collected first: h() drops the empty pieces, Element.append would print them.
  const kids = [];
  const lane = (g) => g.title && h("div", { class: "lane-title" }, g.title, h("span", { class: "n" }, g.items.length));
  if (f.assignee === "@me" && !ui.me) kids.push(whoAreYou());
  else if (def.layout === "board") {
    if (level === "stories") kids.push(h("div", { class: "people" }, S.people.map(personChip)));
    if (level === "epics") kids.push(h("div", { class: "board-hint" }, "An epic stands in the column its stories put it in."));
    if (level === "initiatives") kids.push(h("div", { class: "board-hint" }, "An initiative stands where its decision puts it; past the decision, the work under it moves it."));
    const make = level === "stories" ? (c) => (items, ln) => column(c, items, ln) : level === "epics" ? (c) => (items, ln) => epicColumn(c, items, ln) : (c) => (items, ln) => initiativeColumn(c, items, ln);
    kids.push(lanesBoard(level, def.group, pool, (level === "stories" ? S.board.columns : level === "epics" ? EPIC_COLS : STAGES).map(make)));
  } else {
    if (id === "mine") kids.push(mineHead());
    // One set of columns for every row, so the eye runs down a column. The narrow set drops the epic and the subtasks.
    const tracks = (narrow) => ["34px", "minmax(0, 1fr)", !narrow && "62px", !narrow && !HIDE.has("epic") && "116px", !HIDE.has("who") && (narrow ? "26px" : "150px"), !HIDE.has("status") && "96px", "44px"].filter(Boolean).join(" ");
    for (const g of groupsOf(pool, def.group)) kids.push(lane(g), h("div", { class: "list stories", style: `--cols: ${tracks(false)}; --cols-narrow: ${tracks(true)}` }, [...g.items].sort(SORTERS[def.sort] || byOrder).map(listRow)));
    if (!pool.length) kids.push(h("div", { class: "empty" }, "No story matches this filter."));
  }
  const body = h("div", null, kids);
  return h("div", null, bar, body);
}
const viewOf = (def) => ({ level: def.level || "stories", layout: def.layout, group: def.group, sort: def.sort, filter: clone(def.filter) });

function whoAreYou() {
  return h(
    "div",
    { class: "panel", style: "max-width:520px" },
    h("h2", null, "Who are you?"),
    h("div", { class: "dim" }, "The page has no sign-in. Pick your name and it shows your work. The choice stays in this browser."),
    h("div", { class: "row", style: "margin-top:12px" }, S.people.filter((p) => p.kind === "person").map((p) => h("button", { class: "btn", onclick: () => setMe(p.name) }, p.name))),
  );
}
function mineHead() {
  const me = S.people.find((p) => p.name === ui.me);
  const own = S.initiatives.filter((i) => i.owner === ui.me);
  const over = me && me.limit !== null && me.held > me.limit;
  return h(
    "div",
    { class: "people" },
    me && h("div", { class: `person${over ? " over" : ""}` }, avatar(me.name), h("span", null, "In work"), h("span", { class: "wip" }, `${me.held}/${me.limit ?? "∞"}`), over && h("span", null, "over your limit: finish before you start")),
    me && me.queued > 0 && h("div", { class: "person" }, h("span", null, "Waiting for you in ToDo"), h("span", { class: "wip" }, me.queued)),
    own.length > 0 && h("div", { class: "person" }, h("span", null, "Initiatives you own"), own.map((i) => h("button", { class: "link", onclick: () => openDrawer("initiative", i.id) }, i.title.slice(0, 36)))),
  );
}
let HIDE = new Set(); // what the view in sight already says for every card: "who", "epic", "status"
function listRow(s) {
  const done = s.subtasks.filter((t) => t.done).length;
  // Every row has the same cells, empty or not: the columns line up.
  return h(
    "div",
    { class: "lrow", "data-key": `s:${s.ref}`, ...opens(() => openDrawer("story", s.ref), `${s.title}, ${s.column}, ${s.priority}`) },
    h("span", { class: "c-pri" }, chipP(s.priority)),
    h(
      "span",
      { class: "c-ttl" },
      h("span", { class: "ttl", title: s.title }, s.title),
      s.variant ? h("span", { class: "chip agent" }, s.variant) : null,
      s.column === "Backlog" && !s.ready.ok ? h("span", { class: "chip flag", title: `needs ${s.ready.missing.join(" and ")}` }, "not ready") : null,
      s.awaiting ? h("span", { class: "chip flag" }, "awaiting close") : null,
    ),
    h("span", { class: "c-sub", title: "subtasks done" }, s.subtasks.length ? `☑ ${done}/${s.subtasks.length}` : ""),
    !HIDE.has("epic") && h("span", { class: "c-epic" }, h("span", { class: "chip" }, s.epic)),
    !HIDE.has("who") && h("span", { class: "who", title: s.assignee || "nobody" }, s.assignee ? [avatar(s.assignee), h("span", { class: "nm" }, s.assignee.replace(/^agent:/, ""))] : "—"),
    !HIDE.has("status") && h("span", { class: "c-st" }, pill(s)),
    h("span", { class: "age", title: "days in this status" }, s.ageDays !== null && s.column !== "Done" ? `${s.ageDays} d` : ""),
  );
}

// ── the board: people, columns, cards ──
function personChip(p) {
  const over = p.limit !== null && p.held > p.limit;
  const full = p.limit !== null && p.held === p.limit;
  const tip = p.inPolicy === false ? "not in the vault's flow policy: no WIP limit" : p.kind === "agent" ? "an agent of the flow policy" : `${p.time || "no"} time`;
  return h(
    "div",
    { class: `person${over ? " over" : full ? " full" : ""}`, title: tip },
    avatar(p.name),
    h("span", null, p.name),
    h("span", { class: "wip" }, `${p.held}/${p.limit ?? "∞"}`),
    p.queued ? h("span", { class: "faint" }, `+${p.queued} in ToDo`) : null,
  );
}
// A board fits its place. When its columns do not, the empty ones and Done fold into strips; a
// click opens a strip. What still does not fit scrolls, and the edge it scrolls to is shaded.
const COL_MIN = 190;
const COL_SLIM = 42;
// Fold as few columns as the width asks for: first the gate columns, from the right.
function fitBoard(b, width) {
  const cols = [...b.children];
  const n = cols.length;
  const short = n * COL_MIN + (n - 1) * 12 - width;
  const can = cols.filter((c) => c.classList.contains("can-slim") && !c.classList.contains("open"));
  can.sort((x, y) => y.classList.contains("gate") - x.classList.contains("gate") || cols.indexOf(y) - cols.indexOf(x));
  const fold = new Set(short > 0 ? can.slice(0, Math.ceil(short / (COL_MIN - COL_SLIM))) : []);
  for (const c of cols) c.classList.toggle("slim", fold.has(c));
  b.classList.toggle("tight", short > 0);
  // With lanes, every lane folds the same columns as the row of heads.
  for (const row of b._rows || []) {
    [...row.children].forEach((c, k) => c.classList.toggle("slim", fold.has(cols[k])));
    row.classList.toggle("tight", short > 0);
  }
}
const fitBoards = new ResizeObserver((entries) => {
  for (const { target: b } of entries) {
    ui.boardW = b.clientWidth;
    fitBoard(b, b.clientWidth);
    b._edge();
  }
});
function boardOf(cols) {
  const b = h("div", { class: "board" }, cols);
  const wrap = h("div", { class: "board-wrap" }, b);
  if (ui.boardW) fitBoard(b, ui.boardW); // as wide as it stood a moment ago: no flicker on a redraw
  b._edge = () => {
    wrap.classList.toggle("more-right", b.scrollLeft + b.clientWidth < b.scrollWidth - 2);
    wrap.classList.toggle("more-left", b.scrollLeft > 2);
  };
  b.addEventListener("scroll", b._edge, { passive: true });
  fitBoards.observe(b);
  return wrap;
}
// The head of a column: on a tight board a click folds or opens the column.
const colToggle = (name) => (e) => {
  if (!e.currentTarget.closest(".board.tight .col.can-slim")) return;
  ui.colOpen ??= new Set();
  ui.colOpen.has(name) ? ui.colOpen.delete(name) : ui.colOpen.add(name);
  render();
};
// The "+ N more" button of a column, or of one lane's cell of it.
function moreButton(key, total, cap, all) {
  if (total <= cap) return null;
  const flip = () => {
    ui.colAll ??= new Set();
    all ? ui.colAll.delete(key) : ui.colAll.add(key);
    render();
  };
  return h("button", { class: "more", onclick: flip }, all ? "show fewer" : `+ ${total - cap} more`);
}
const laneOf = (lane) => (lane && !lane.heads ? lane : null);

// A column of stories. `lane` is null on a board with no lanes; with lanes it
// is one lane's cell of the column, or (lane.heads) the column's head alone.
function column(c, pool, lane) {
  const isDone = c.shows.includes("Done");
  const gate = !c.shows.includes("Backlog") && !c.shows.includes("ToDo");
  const cell = laneOf(lane);
  let list = pool.filter((s) => c.shows.includes(s.column));
  list = isDone ? list.sort((a, b) => cmp(b.closedAt || b.updated || "", a.closedAt || a.updated || "")) : list.sort(byOrder);
  const total = list.length;
  const cap = cell ? 6 : isDone ? 10 : 20;
  const allKey = `${c.name}|${cell ? `${cell.dim}:${cell.key}` : ""}`;
  const all = !!ui.colAll?.has(allKey);
  const shown = !all && total > cap ? list.slice(0, cap) : list;
  // How a story comes into a gate column, in a person's words.
  const gateWhy = isDone
    ? "A story is closed by its close gate, when its work is checked."
    : c.shows.includes("In Progress")
      ? "Work starts at the plan gate, when the assignee takes the story from ToDo."
      : "A story comes here from In Progress, by its gate.";
  const cls = `col${gate ? " gate" : ""}${isDone || !total ? " can-slim" : ""}${ui.colOpen?.has(c.name) ? " open" : ""}`;
  const head = h(
    "div",
    { class: "col-head", onclick: colToggle(c.name), "aria-label": `${c.name}, ${total} stories` },
    c.name,
    h("span", { class: `n${c.limit && total > c.limit ? " over" : ""}` }, c.limit ? `${total}/${c.limit}` : total),
    gate && h("span", { class: "lock", title: gateWhy }, isDone ? "close gate" : c.shows.includes("In Progress") ? "plan gate" : "gate"),
  );
  if (lane?.heads) return h("div", { class: `${cls} head-only` }, head);
  return h("div", { class: cls }, cell ? null : head, h("div", { class: "cards" }, shown.map(card), !shown.length && !cell && h("div", { class: "empty" }, "nothing here"), moreButton(allKey, total, cap, all)));
}
function card(s) {
  const done = s.subtasks.filter((t) => t.done).length;
  return h(
    "div",
    { class: "card", "data-key": `s:${s.ref}`, ...opens(() => openDrawer("story", s.ref), `${s.title}, ${s.column}, ${s.priority}${s.assignee ? `, for ${s.assignee}` : ""}`) },
    h("div", { class: "title" }, s.title),
    h(
      "div",
      { class: "meta" },
      !HIDE.has("epic") && h("span", { class: "chip" }, s.epic),
      chipP(s.priority),
      s.subtasks.length ? h("span", { class: "chip", title: "subtasks" }, `☑ ${done}/${s.subtasks.length}`) : null,
      s.variant ? h("span", { class: "chip agent" }, s.variant) : null,
      s.column === "Backlog" && !s.ready.ok ? h("span", { class: "chip flag", title: `needs ${s.ready.missing.join(" and ")}` }, "not ready") : null,
      s.awaiting ? h("span", { class: "chip flag" }, "awaiting close") : null,
      s.assignee && !HIDE.has("who") ? h("span", { class: "who" }, avatar(s.assignee)) : null,
    ),
  );
}

// ── Initiatives: from a proposal to done ──
// A decision is recorded in the initiative; the other columns follow the work under it.
const STAGES = [
  { name: "Proposed", stages: ["proposed"], hint: "waiting for a decision" },
  { name: "Being worked out", stages: ["elaborating"], hint: "its story is in work", follows: true },
  { name: "Accepted", stages: ["accepted"], hint: "decided, work not started" },
  { name: "In Progress", stages: ["in-progress"], hint: "its epics have work started", follows: true },
  { name: "Done", stages: ["done"], hint: "all of its stories are done", follows: true },
  { name: "Set aside", stages: ["rejected", "deferred"], hint: "kept, with the reason" },
];
// A column of initiatives. With lanes it is one lane's cell, or the head alone.
function initiativeColumn(c, pool, lane) {
  const cell = laneOf(lane);
  const mine = pool.filter((i) => c.stages.includes(i.stage)).sort(byOrder);
  const follows = `This column follows the work: an initiative is here when ${c.hint}.`;
  const cls = `col${c.follows ? " gate" : ""}${mine.length ? "" : " can-slim"}${ui.colOpen?.has(c.name) ? " open" : ""}`;
  const head = h("div", { class: "col-head", onclick: colToggle(c.name) }, c.name, h("span", { class: "n" }, mine.length), c.follows && h("span", { class: "lock", title: follows }, "auto"));
  if (lane?.heads) return h("div", { class: `${cls} head-only` }, head, h("div", { class: "col-hint" }, c.hint));
  return h("div", { class: cls }, cell ? null : [head, h("div", { class: "col-hint" }, c.hint)], h("div", { class: "cards" }, mine.map(initiativeCard), !mine.length && !cell && h("div", { class: "empty" }, "nothing here")));
}
function initiativeCard(i) {
  const work = i.elaboration && story(i.elaboration);
  return h(
    "div",
    { class: "card", "data-key": `i:${i.id}`, ...opens(() => openDrawer("initiative", i.id), `initiative: ${i.title}, ${STATUS_LABEL[i.stage] || i.stage}`) },
    h("div", { class: "title" }, i.title),
    h("div", { class: "meta" }, chipP(i.priority), i.stage === "rejected" || i.stage === "deferred" ? wordPill(i.stage) : null, h("span", { class: "chip" }, `${i.epics.length} epic${i.epics.length === 1 ? "" : "s"}`), i.owner && !HIDE.has("who") ? h("span", { class: "who", title: `owner: ${i.owner}` }, avatar(i.owner)) : null),
    i.epics.length ? h("div", { style: "margin-top:8px" }, progress(i.counts)) : null,
    work ? h("div", { class: "meta" }, h("span", { class: "faint" }, "worked out by"), work.assignee ? [avatar(work.assignee), h("span", { class: "dim" }, work.assignee)] : h("span", { class: "faint" }, "nobody"), pill(work)) : null,
  );
}

// ── Epics on the board ──
// An epic stands in the column its stories put it in.
const EPIC_COLS = [
  { name: "Backlog", is: (e) => e.status !== "in-progress" && e.status !== "done" },
  { name: "In Progress", is: (e) => e.status === "in-progress" },
  { name: "Done", is: (e) => e.status === "done" },
];
function epicColumn(c, pool, lane) {
  const cell = laneOf(lane);
  const list = pool.filter(c.is).sort((a, b) => cmp(PRI.indexOf(a.priority), PRI.indexOf(b.priority)) || cmp(a.id, b.id));
  const follows = "An epic stands in the column its stories put it in.";
  const key = `epic:${c.name}`;
  const cls = `col gate${list.length ? "" : " can-slim"}${ui.colOpen?.has(key) ? " open" : ""}`;
  const head = h("div", { class: "col-head", onclick: colToggle(key), "aria-label": `${c.name}, ${list.length} epics` }, c.name, h("span", { class: "n" }, list.length), h("span", { class: "lock", title: follows }, "auto"));
  if (lane?.heads) return h("div", { class: `${cls} head-only` }, head);
  return h("div", { class: cls }, cell ? null : head, h("div", { class: "cards" }, list.map(epicCard), !list.length && !cell && h("div", { class: "empty" }, "nothing here")));
}
function epicCard(e) {
  const n = S.stories.filter((s) => s.epic === e.id).length;
  const ini = e.initiative && S.initiatives.find((i) => i.id === e.initiative);
  return h(
    "div",
    { class: "card", "data-key": `e:${e.id}`, ...opens(() => openDrawer("epic", e.id), `epic: ${e.id}, ${e.title}, ${STATUS_LABEL[e.status] || e.status}`) },
    h("div", { class: "title" }, h("b", null, e.id), ` · ${e.title}`),
    h(
      "div",
      { class: "meta" },
      chipP(e.priority),
      h("span", { class: "chip" }, `${n} stor${n === 1 ? "y" : "ies"}`),
      e.standing ? h("span", { class: "chip seed", title: "A standing epic: it is not done when its stories are" }, "standing") : null,
      ini && !HIDE.has("initiative") ? h("span", { class: "chip", title: ini.title }, ini.title.length > 26 ? `${ini.title.slice(0, 25)}…` : ini.title) : null,
    ),
    n ? h("div", { style: "margin-top:8px" }, progress(e.counts)) : null,
  );
}

// The page's writes: a story moved with a preview, the batch, Send, Discard
// and the kept branches (the specs "The dashboard's write path…", alias
// `dashboard-writes`, contracts 1, 4, 6, 7 and 8, and "The dashboard's
// delivery…", alias `dashboard-delivery`, contracts 1 to 6).
//
// Only this file speaks to the five write routes, and only by POST with the
// run's token (the meta tag of `/`); a same-origin fetch sends the page's own
// Origin. Every control here is drawn from `write`: none while `write.can` is
// false, and none for a verb that `write.verbs` does not list. The core plans
// each change and makes it: the page shows the plan, and the click on its
// button is the approval; a reorder that writes one file needs no click, its
// drop or key is the approval (the spec dashboard-rank, contract 6). Nothing here is a second gate on the vault: a change
// lands on the person's batch branch in the page's own clone, and reaches the
// vault when the pull request that Send opens is merged.
//
// Everything lives under one name, `writeUi`, because the page's scripts
// share one global scope.

const writeUi = (() => {
  const ROUTES = ["/api/refresh", "/api/preview", "/api/action", "/api/send", "/api/discard"];
  // The statuses each target of `move` comes from (the core's own rule; it
  // refuses the others): where `move` is offered stays the page's own (contract 10).
  const FROM = { todo: ["planned"], planned: ["todo", "to-do"] };
  const COLUMN_TO = { ToDo: "todo", Backlog: "planned" };
  const WORD = { planned: "Backlog", todo: "ToDo", "to-do": "ToDo" };
  let busy = null; // the step that runs now: "refresh", "preview", "action", "send", "discard"
  let note = null; // the last answer worth keeping on screen: { kind: "ok" | "warn" | "error", text }
  let dragging = null; // { ref, to: [targets] } while a card is dragged
  let wanted = null; // the data-focus of a strip button that was disabled when the focus came back

  const w = () => (S && S.write) || null;
  const can = () => !!w()?.can;
  const token = () => document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const short = (sha) => String(sha || "").slice(0, 7);
  const isUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

  // ── the one way to a write route ──
  // → the answer as the server gave it ({ ok, result?, error?, write }), with
  // `status`; a server that did not answer, or answered no JSON, is an error.
  async function post(route, body) {
    if (!ROUTES.includes(route)) throw new Error(`${route} is not a write route`);
    let r;
    try {
      r = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-projectstore-token": token() },
        body: JSON.stringify(body || {}),
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (e) {
      return { ok: false, status: 0, error: `the page's server did not answer: ${e?.message || e}` };
    }
    let answer = null;
    try {
      answer = await r.json();
    } catch {
      answer = null;
    }
    if (!answer || typeof answer !== "object") return { ok: false, status: r.status, error: `the page's server answered ${r.status} with no JSON` };
    if (answer.write && typeof answer.write === "object" && S) S.write = answer.write;
    return { ...answer, ok: answer.ok === true, status: r.status, error: answer.error || (answer.ok === true ? null : `the page's server answered ${r.status}`) };
  }

  // After every write answer: draw from its `write` now, then read the board again.
  // The element that held the focus keeps it; one that a redraw replaced is
  // found again by its data-focus, else the strip takes it.
  async function after() {
    const el = document.activeElement;
    const key = el?.getAttribute?.("data-focus") || null;
    try {
      render();
      await load(); // app.js: /api/state, the artifacts and the open item
    } catch (e) {
      say("warn", "The page could not read the backlog again, so what it shows may be out of date. Reload the page.", String(e?.message || e));
    }
    // Only a focus that a redraw took away moves: none (the page just opened) stays none.
    if (el && el !== document.body && !el.isConnected) refocus(key);
  }
  // Focus the element with this data-focus, else the strip, else the view.
  function refocus(key) {
    const found = key ? [...document.querySelectorAll("[data-focus]")].find((x) => x.getAttribute("data-focus") === key && !x.disabled) : null;
    if (found) return found.focus();
    const bar = $("#write");
    if (bar && !bar.hidden) return bar.focus();
    const view = $("#view");
    if (view) {
      if (view.getAttribute("tabindex") === null) view.setAttribute("tabindex", "-1");
      view.focus();
    }
  }
  // A step that runs: one at a time from this page (the server queues them anyway).
  async function running(name, fn) {
    busy = name;
    paint();
    try {
      return await fn();
    } finally {
      busy = null;
      settled();
      paint();
    }
  }
  // A first word that is a name, as gh, git, a path or a branch, keeps its case.
  const NAMES = new Set(["gh", "git", "origin", "main", "move", "handover", "npm", "node", "projectstore"]);
  const sentence = (t) => {
    const first = t.split(/\s/, 1)[0];
    const plain = /^[a-z][a-z'’-]*[,:;]?$/.test(first) && !NAMES.has(first.replace(/[,:;]$/, ""));
    return plain ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  };
  // `detail`, when given, is the core's or the server's own line: it stands under Details,
  // and the note says in plain words what happened.
  // A `passing` note ("wait, a step runs") goes away by itself when no step runs any more.
  const say = (kind, text, detail = null, passing = false) => {
    // The module's and the core's messages start in lower case; a note is a sentence.
    const t = text ? String(text) : "";
    note = t ? { kind, text: sentence(t), detail: detail ? String(detail) : null, passing } : null;
    paint();
  };
  const settled = () => {
    if (!busy && !ranking && note?.passing) note = null;
  };

  // ── what may be offered ──
  // A verb's entry the page may run now, or null: `write.can`, and the verb in
  // `write.verbs` with its fields (contract 10 draws the dialog from it).
  function entryOf(verb) {
    const x = w();
    if (!x || !x.can || !Array.isArray(x.verbs)) return null;
    const entry = x.verbs.find((v) => v && v.verb === verb);
    return entry && entry.fields && typeof entry.fields === "object" ? entry : null;
  }
  const valuesOf = (f) => (f && Array.isArray(f.values) ? f.values.map((v) => (v && typeof v === "object" ? v : { value: v, label: v })) : []);
  // `move` with every field the page fills: story, to (its values) and reason.
  function moveFields() {
    const f = entryOf("move")?.fields;
    return f && f.story && f.reason && f.to && Array.isArray(f.to.values) ? f : null;
  }
  // The moves a story can take from the page: [{ to, label }]. Empty while the
  // page cannot write, when `move` or one of its fields is not listed, and for
  // a target whose value `write.verbs` does not list.
  function movesOf(s) {
    const f = moveFields();
    if (!s || !f) return [];
    const status = String(s.status || "").toLowerCase();
    return valuesOf(f.to)
      .filter((v) => (FROM[v.value] || []).includes(status))
      .map((v) => ({ to: v.value, label: v.label || `Move to ${v.value}` }));
  }
  // Whether a story can be handed over from the page: `handover` listed with
  // its fields, an assignee in the state, and a column that is set and is not
  // Done (a story set aside, or done, is one the core always refuses).
  function canHandOver(s) {
    const e = entryOf("handover");
    const f = e && e.fields;
    if (!s || !f || !f.story || !f.from || !f.to || !f.reason) return false;
    return Boolean(s.assignee) && Boolean(s.column) && s.column !== "Done";
  }

  // ── drag and drop on the board ──
  const clearDrag = () => {
    dragging = null;
    document.body.classList.remove("dragging");
    for (const el of document.querySelectorAll(".drop-ok, .drop-over")) el.classList.remove("drop-ok", "drop-over");
  };
  // A story's card: draggable when the story has a move to offer.
  function dragCard(el, s) {
    const moves = movesOf(s);
    if (!moves.length) return el;
    el.draggable = true;
    el.classList.add("can-move");
    el.title = `Drag to ${moves.map((m) => WORD[m.to] || m.to).join(" or ")}, or open it for the button`;
    el.addEventListener("dragstart", (e) => {
      dragging = { ref: s.ref, to: moves.map((m) => m.to) };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", s.ref);
      document.body.classList.add("dragging");
      for (const col of document.querySelectorAll("[data-drop-to]")) if (dragging.to.includes(col.dataset.dropTo)) col.classList.add("drop-ok");
    });
    el.addEventListener("dragend", clearDrag);
    return el;
  }
  // A column of the board: a drop target when it is the Backlog or the ToDo
  // column alone and `move` may go there.
  function dropColumn(el, c) {
    const names = (c.shows || []).filter((n) => COLUMN_TO[n]);
    const to = names.length === 1 && c.shows.length === 1 ? COLUMN_TO[names[0]] : null;
    const f = moveFields();
    if (!to || !f || !valuesOf(f.to).some((v) => v.value === to)) return el;
    el.dataset.dropTo = to;
    const fits = () => dragging && dragging.to.includes(to);
    el.addEventListener("dragover", (e) => {
      if (!fits()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-over");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-over");
    });
    el.addEventListener("drop", (e) => {
      if (!fits()) return;
      e.preventDefault();
      const ref = dragging.ref;
      clearDrag();
      openMove(ref, to);
    });
    return el;
  }

  // ── reordering the backlog tree (the spec dashboard-rank) ──
  // `rank` is offered by a drop and by keys, never by a button: a drop or a key
  // asks the core for the plan at once; a one-file plan runs at once, a larger
  // one opens a confirmation (contracts 6, 8 and 11). A row moves only inside its group: an epic's open stories, or
  // the epics of one initiative (or of none).
  const STORY_REF = /^[\p{L}\p{N}][\p{L}\p{N}._-]*\/[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
  const EPIC_REF = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
  let treeDrag = null; // { item, members, idx, gap, foreign, dropped } while a tree row is dragged
  function canRank() {
    const f = entryOf("rank")?.fields;
    return Boolean(f && f.story && f.epic && f.before && f.after);
  }
  const placed = (x) => x.place !== null && x.place !== undefined;
  const byPlace = (a, b) => a.place - b.place;
  // The members of an item's group, in their order: [{ ref, title }].
  function membersOf(item) {
    if (item.kind === "story") return S.stories.filter((s) => s.epic === item.epic && placed(s)).sort(byPlace).map((s) => ({ ref: s.ref, title: s.title }));
    return S.epics.filter((e) => (e.group ?? "") === item.group && placed(e)).sort(byPlace).map((e) => ({ ref: e.id, title: e.title }));
  }
  const itemOf = (key) => {
    if (typeof key !== "string") return null;
    if (key.startsWith("s:")) {
      const s = S.stories.find((x) => x.ref === key.slice(2));
      return s && placed(s) ? { kind: "story", ref: s.ref, title: s.title, epic: s.epic } : null;
    }
    if (key.startsWith("e:")) {
      const e = S.epics.find((x) => x.id === key.slice(2));
      return e && placed(e) ? { kind: "epic", ref: e.id, title: e.title, group: e.group ?? "" } : null;
    }
    return null;
  };
  const formOk = (item) => (item.kind === "story" ? STORY_REF : EPIC_REF).test(item.ref);
  // Why a row cannot go to another group (contract 7).
  const elsewhere = (item) =>
    item.kind === "story"
      ? `A story moves only among the open stories of its own epic, ${item.epic}.`
      : "An epic moves only among the epics of its initiative. To give it another initiative, change the epic's initiative field (the command `epic <EPIC-ID> --initiative <id>` does it).";
  const clearLine = () => {
    for (const el of document.querySelectorAll(".drop-line-before, .drop-line-after")) el.classList.remove("drop-line-before", "drop-line-after");
  };
  // The rows of a member's block: its row and the rows drawn under it.
  const blockRows = (item, ref) =>
    [...document.querySelectorAll(item.kind === "story" ? "table.tree tr[data-story]" : "table.tree tr[data-epic]")].filter((r) =>
      item.kind === "story" ? r.dataset.story === ref : r.dataset.epic === ref,
    );
  // The gap a pointer over `tr` at `y` names in the dragged item's group, or
  // null when the row is another group's (contract 6).
  function gapAt(tr, y) {
    const { item, members } = treeDrag;
    if (!tr) return null;
    if (item.kind === "story") {
      if (tr.dataset.epic !== item.epic) return null;
      const ref = tr.dataset.story;
      if (!ref) return 0; // the epic's own row: before its first open story
      const at = members.findIndex((m) => m.ref === ref);
      if (at === -1) {
        const s = S.stories.find((x) => x.ref === ref);
        return s && s.column === "Done" ? 0 : members.length; // done stories stand above, set-aside ones below
      }
      const rows = blockRows(item, ref);
      const top = rows[0].getBoundingClientRect().top;
      const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
      return y < (top + bottom) / 2 ? at : at + 1;
    }
    if (!tr.dataset.epic || (tr.dataset.group ?? "") !== item.group) return null;
    const at = members.findIndex((m) => m.ref === tr.dataset.epic);
    if (at === -1) return null;
    const rows = blockRows(item, tr.dataset.epic);
    const top = rows[0].getBoundingClientRect().top;
    const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
    return y < (top + bottom) / 2 ? at : at + 1;
  }
  // The place a gap asks for: { before } or { after }, or null for the item's own place.
  function placeOf(gap) {
    const { members, idx } = treeDrag;
    if (gap === idx || gap === idx + 1) return null;
    return gap < members.length ? { before: members[gap] } : { after: members[members.length - 1] };
  }
  function drawLine(gap) {
    clearLine();
    const { item, members } = treeDrag;
    if (gap < members.length) blockRows(item, members[gap].ref)[0]?.classList.add("drop-line-before");
    else blockRows(item, members[members.length - 1].ref).at(-1)?.classList.add("drop-line-after");
  }
  // The document's two drag listeners, installed with the first draggable row.
  let listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    document.addEventListener("dragover", (e) => {
      if (!treeDrag) return;
      const tr = e.target instanceof Element ? e.target.closest("table.tree tr") : null;
      const gap = gapAt(tr, e.clientY);
      if (gap === null) {
        treeDrag.foreign = Boolean(tr);
        clearLine();
        return; // no drop here: the row goes back
      }
      treeDrag.foreign = false;
      treeDrag.gap = gap;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (placeOf(gap)) drawLine(gap);
      else clearLine();
    });
    document.addEventListener("drop", (e) => {
      if (!treeDrag || treeDrag.gap === null || treeDrag.foreign) return;
      e.preventDefault();
      const { item } = treeDrag;
      const place = placeOf(treeDrag.gap);
      treeDrag.dropped = true;
      clearLine();
      // The redraw below takes the grip away, and a browser may send its dragend to no one: end the drag here.
      const ending = treeDrag;
      treeDrag = null;
      document.body.classList.remove("dragging-row");
      if (!place) return void (ending.dropped = true);
      if (busy || ranking) say("warn", busyWords(), null, true);
      else openRank(item, place);
    });
  }
  // A tree row that may be reordered: draggable, with a grip.
  function dragTreeRow(tr, item) {
    if (!canRank() || !formOk(item)) return tr;
    listen();
    tr.classList.add("can-rank");
    // The grip is the handle: the row's text stays selectable, and its buttons stay buttons.
    const grip = h("span", { class: "grip", draggable: "true", title: `Drag to change the order ${item.kind === "story" ? "of this epic's open stories" : "of this initiative's epics"}` }, "⠿");
    tr.querySelector(".t")?.prepend(grip);
    grip.addEventListener("dragstart", (e) => {
      const members = membersOf(item);
      treeDrag = { item, members, idx: members.findIndex((m) => m.ref === item.ref), gap: null, foreign: false, dropped: false };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.ref);
      if (typeof e.dataTransfer.setDragImage === "function") e.dataTransfer.setDragImage(tr, 12, 12);
      document.body.classList.add("dragging-row");
    });
    grip.addEventListener("dragend", () => {
      const d = treeDrag;
      treeDrag = null;
      clearLine();
      document.body.classList.remove("dragging-row");
      if (d && !d.dropped && d.foreign) say("warn", elsewhere(d.item));
    });
    return tr;
  }
  // Alt+ArrowUp (-1) or Alt+ArrowDown (+1) on the selected row (contract 8):
  // true when the key is this row's (the page takes it), whether or not a
  // neighbour is there to pass.
  function rankKey(key, dir) {
    if (!canRank() || (typeof ui.filter === "string" && ui.filter.trim())) return false;
    const item = itemOf(key);
    if (!item || !formOk(item)) return false;
    // Only a row the tree draws with its handle moves by a key.
    const drawn = [...document.querySelectorAll("table.tree tr.can-rank")].some((r) => r.dataset && r.dataset.key === key);
    if (!drawn) return false;
    const members = membersOf(item);
    const at = members.findIndex((m) => m.ref === item.ref);
    const next = members[at + dir];
    // A step that runs, a plan asked and not yet answered included, takes no key.
    if (at === -1 || !next) return true;
    if (busy || ranking) {
      say("warn", busyWords(), null, true);
      return true;
    }
    openRank(item, dir < 0 ? { before: next } : { after: next });
    return true;
  }
  // Why a drop or a key does nothing now: a reorder being saved, or another step of the page.
  const busyWords = () => (ranking ? "The last move is still being saved. Try again in a moment." : `${BUSY[busy] || "Working…"} Try again in a moment.`);
  // A reorder runs from the drop or the key to the read of the state after it;
  // no other drop or key starts meanwhile (the spec dashboard-rank, contract 11).
  let ranking = false;
  // The row at its new place at once: the group's places in the state are
  // redrawn as the drop asks, before any answer. → a function that puts the
  // places back as they were before the drop.
  function showAt(item, place) {
    const sib = (place.before || place.after).ref;
    const list = item.kind === "story" ? S.stories.filter((s) => s.epic === item.epic && placed(s)) : S.epics.filter((e) => (e.group ?? "") === item.group && placed(e));
    const was = list.map((x) => [x, x.place]);
    const back = () => {
      for (const [x, p] of was) x.place = p;
      render();
    };
    const refOf = (x) => (item.kind === "story" ? x.ref : x.id);
    const order = [...list].sort(byPlace).filter((x) => refOf(x) !== item.ref);
    const moved = list.find((x) => refOf(x) === item.ref);
    const at = order.findIndex((x) => refOf(x) === sib);
    if (!moved || at === -1) return back;
    order.splice(place.before ? at : at + 1, 0, moved);
    order.forEach((x, i) => (x.place = i));
    render();
    return back;
  }
  // A step of a reorder that did not save: the places go back first, then the
  // state is read again; the note says it in words, the core's line under Details.
  async function undo(back, text, detail) {
    back();
    say("error", text, detail);
    await after();
  }
  // How many other rows a plan places: its files but the item's own.
  function othersIn(item, changes) {
    const it = item.kind === "story" ? S.stories.find((s) => s.ref === item.ref) : S.epics.find((e) => e.id === item.ref);
    const rel = it && typeof it.rel === "string" ? it.rel : null;
    const own = rel ? changes.some((c) => typeof c.path === "string" && c.path.endsWith(rel)) : true;
    return changes.length - (own ? 1 : 0);
  }
  const othersWord = (item, n) => `${n} other ${item.kind === "story" ? (n === 1 ? "story" : "stories") : n === 1 ? "epic" : "epics"}`;
  // A reorder (contract 6; the write-path spec's contract 10): the row moves at
  // once, the core's plan is asked, and a plan that writes one file is the
  // action at once. Only a plan that also places other rows asks first.
  async function openRank(item, place) {
    const entry = entryOf("rank");
    if (!entry) return say("error", "The page cannot reorder now.");
    const side = place.before ? "before" : "after";
    const sib = place.before || place.after;
    const fields = { [item.kind]: item.ref, [side]: sib.ref };
    const where = `${side === "before" ? "above" : "below"} “${sib.title}”`;
    ranking = true;
    let asked = false; // a confirmation took over, and ends the reorder itself
    try {
      const back = showAt(item, place);
      const a = await running("preview", () => post("/api/preview", { verb: "rank", fields }));
      if (!a.ok) return await undo(back, "The move could not be planned, so the row went back.", a.error);
      const changes = Array.isArray(a.result?.changes) ? a.result.changes : [];
      if (!changes.length) {
        back();
        say("ok", `“${item.title}” is already in that place: nothing changed.`);
        return await after();
      }
      if (changes.length === 1) return await rankNow(item, fields, where, back);
      try {
        const dlg = confirmRank(entry, item, fields, where, changes, back);
        asked = true; // the confirmation stands: it ends the reorder itself
        return dlg;
      } catch (e) {
        return await undo(back, "The move could not be shown, so the row went back.", String(e?.message || e));
      }
    } finally {
      if (!asked) ranking = false;
      settled();
      paint();
    }
  }
  // The action of a reorder, with no dialog.
  async function rankNow(item, fields, where, back) {
    const before = w()?.batch?.commits || 0;
    const r = await running("action", () => post("/api/action", { verb: "rank", fields }));
    if (!r.ok) return undo(back, "The move could not be saved, so the row went back.", r.error);
    const wrote = (w()?.batch?.commits || 0) > before;
    const files = Array.isArray(r.result?.written) ? r.result.written.length : 1;
    say("ok", wrote ? `Moved “${item.title}” ${where}${files > 1 ? `, and set the place of ${othersWord(item, files - 1)}` : ""}.` : `“${item.title}” is already in that place: nothing changed.`);
    await after();
  }
  // A plan that also places other rows: asked first, in words; the files under Details.
  function confirmRank(entry, item, fields, where, changes, back) {
    const label = entry.label || "Reorder";
    const subjects = [entry.subject].flat().filter((s) => typeof s === "string");
    const template = subjects.find((s) => [...s.matchAll(/\{([a-z_]+)\}/g)].every((m) => Object.hasOwn(fields, m[1]))) || "rank {story}";
    const kinds = othersWord(item, othersIn(item, changes));
    const err = h("div", { class: "write-err", role: "alert" });
    const primary = h("button", { class: "btn primary", type: "button" }, label);
    const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
    let ran = false; // the action was sent: its own answer decides what the tree shows
    const plan = h(
      "div",
      { class: "plan-box" },
      h("div", null, `To keep the order you see, this also sets the place of ${kinds} in the same group.`),
      details(
        kv(...changes.map((c) => ["File", h("span", null, h("span", { class: "mono path" }, c.path), ` rank ${c.from ?? "none"} → ${c.to}`)])),
        h("div", { class: "faint rank-count" }, `${plural(changes.length, "file")} to write. Only each file's rank: line changes; no date moves.`),
        h("div", { class: "faint subject mono" }, `Commit: ${fillSubject(template, fields)}`),
      ),
      h("div", { class: "faint" }, landing()),
    );
    let inFlight = false;
    primary.addEventListener("click", async () => {
      if (inFlight || ran) return;
      inFlight = true;
      ran = true;
      primary.disabled = true;
      primary.textContent = "Saving…";
      fill(err, null);
      const before = w()?.batch?.commits || 0;
      const r = await running("action", () => post("/api/action", { verb: "rank", fields }));
      inFlight = false;
      try {
        if (r.ok) {
          dlg.close();
          say("ok", (w()?.batch?.commits || 0) > before ? `Moved “${item.title}” ${where}, and set the place of ${kinds}.` : `“${item.title}” is already in that place: nothing changed.`);
          await after();
        } else {
          // The plan on screen is no longer the one a click would run: no button runs it again.
          primary.remove();
          cancel.textContent = "Close";
          fill(err, h("div", { class: "msg" }, "The move could not be saved, so the row went back."), details(h("div", { class: "faint" }, r.error)));
          back();
          await after();
        }
      } finally {
        ranking = false;
        settled();
        paint();
      }
    });
    cancel.addEventListener("click", () => dlg.close());
    // Cancel, Escape or a click outside before the action: the places go back, then the state is read.
    const dlg = modal(
      `Move ${item.kind === "story" ? "this story" : "this epic"}?`,
      [h("div", { class: "move-what" }, h("b", null, item.title), h("div", { class: "faint" }, `Goes ${where}`)), plan, err, h("div", { class: "btns" }, cancel, primary)],
      {
        first: primary,
        onClose: () => {
          if (ran) return;
          back();
          after().finally(() => {
            ranking = false;
            settled();
            paint();
          });
        },
      },
    );
    return dlg;
  }

  // ── a dialog that keeps the focus, and closes on Escape ──
  function modal(title, kids, { onClose, first } = {}) {
    const m = $("#modal");
    const opener = document.activeElement;
    const back = opener && opener !== document.body ? opener : null;
    const backKey = back?.getAttribute?.("data-focus") || null;
    m.close?.(); // a dialog that stands there is closed first, so its onClose runs
    const box = h("div", { class: "dialog write-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), kids);
    const close = () => {
      if (m.hidden || !m.contains(box)) return; // closed already, or another dialog stands there now
      m.hidden = true;
      m.replaceChildren();
      m.onclick = null;
      m.close = null;
      onClose?.();
      if (back && back.isConnected && typeof back.focus === "function") back.focus();
      else refocus(backKey); // the opener was redrawn, or was the palette
    };
    const focusables = () => [...box.querySelectorAll("button, input, textarea, select, a[href], [tabindex]")].filter((x) => !x.disabled && x.tabIndex !== -1 && x.offsetParent !== null);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close();
      }
      if (e.key !== "Tab") return;
      const all = focusables();
      if (!all.length) return e.preventDefault();
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    m.replaceChildren(box);
    m.hidden = false;
    m.close = close; // item.js's Escape closes through it, so onClose runs
    m.onclick = (e) => {
      if (e.target === m) close();
    };
    (first || box.querySelector("input, textarea, select") || box.querySelector("button.primary") || box.querySelector("button"))?.focus();
    return { box, close, isOpen: () => !m.hidden && m.contains(box) };
  }

  // ── a verb's dialog, with a preview ──
  // `move`'s plan, as `result` holds it: the fields it names, in words.
  function movePlan(result) {
    if (!result || typeof result !== "object") return h("div", { class: "faint" }, "The core gave no plan.");
    const shown = new Set(["story", "from", "to", "reason", "path", "written", "actor", "already", "error"]);
    const word = (st) => WORD[st] || st;
    const rest = Object.entries(result).filter(([k, v]) => !shown.has(k) && v !== null && typeof v !== "object");
    return h(
      "div",
      { class: "plan" },
      kv(result.from || result.to ? ["Status", `${word(result.from)} → ${word(result.to)}`] : null, result.reason ? ["Reason", result.reason] : null),
      result.already ? h("div", { class: "note" }, "The story is in that status already: nothing will change.") : null,
      details(kv(["Story", h("span", { class: "mono" }, result.story)], result.path ? ["File", h("span", { class: "mono path" }, result.path)] : null, ...rest.map(([k, v]) => [k, String(v)]))),
    );
  }
  // `handover`'s plan: the story, who gives it and who takes it, the
  // receiver's WIP when it would pass the limit, and each of the plan's notes.
  function handoverPlan(result) {
    if (!result || typeof result !== "object") return h("div", { class: "faint" }, "The core gave no plan.");
    const items = Array.isArray(result.items) ? result.items : [];
    const wip = result.wip && typeof result.wip === "object" ? result.wip : null;
    const notes = Array.isArray(result.notes) ? result.notes.filter((n) => n && n.message) : [];
    return h(
      "div",
      { class: "plan" },
      kv(["From → to", `${result.from} → ${result.to}`], result.reason ? ["Reason", result.reason] : null),
      !items.length && !result.error ? h("div", { class: "note" }, `The story is ${result.to}'s already: nothing will change.`) : null,
      wip && wip.over ? h("div", { class: "note warn" }, `${wip.assignee} would hold ${wip.after} stories in progress against a limit of ${wip.limit}.`) : null,
      ...notes.map((n) => h("div", { class: "note" }, String(n.message))),
      details(kv(["Story", h("span", { class: "mono" }, result.story || items[0]?.story || "")], ...items.map((x) => ["File", h("span", { class: "mono path" }, x.path)]))),
    );
  }
  // What the click on the verb's button does, in words.
  function landing() {
    const b = w()?.batch;
    const n = b?.commits || 0;
    return `It is saved as a draft change${n ? `, beside your ${plural(n, "other change")}` : ""}. Nobody else sees it until you publish your changes for review and someone approves them.`;
  }
  // The engineering facts of a dialog or the strip, folded under one toggle.
  const details = (...kids) => h("details", { class: "fold" }, h("summary", null, "Details"), kids);
  // The names a typed person field suggests: the vault's people and assignees,
  // without anyone marked left and without `except` (the person who gives).
  function namesFor(except) {
    const left = new Set((S.people || []).filter((p) => p && p.left).map((p) => p.name));
    const all = new Set([...(S.people || []).map((p) => p && p.name), ...(S.assignees || [])].filter(Boolean));
    return [...all].filter((n) => !left.has(n) && n !== except).sort();
  }
  // A template's `{name}`s filled once from `values` (the server does the same).
  const fillSubject = (template, values) => String(template || "").replace(/\{([a-z_]+)\}/g, (m, name) => (Object.hasOwn(values, name) && values[name] !== "" ? String(values[name]) : m));

  // One verb's dialog, drawn from its entry: the title and the button's word
  // (the entry's label, or the label of the preset choice), each field by its
  // kind, the subject the commit will have, and the core's plan before the
  // click. `opts` holds what stays the verb's own: what the dialog is about,
  // how the plan reads, and the words after the click.
  function openVerb(verb, s, preset, opts) {
    const entry = entryOf(verb);
    if (!entry) return toast("refused", "This change is not offered", `The page cannot run ${verb} now.`);
    const fixed = {}; // name → value shown as text
    const inputs = []; // [{ name, field, input, count }]
    let title = entry.label || verb;
    const rows = [];
    let datalists = 0;
    for (const [name, f] of Object.entries(entry.fields)) {
      if (f.kind === "story") fixed[name] = s.ref;
      else if (f.kind === "person" && f.filled === "assignee") {
        fixed[name] = s.assignee || "";
        rows.push(h("div", { class: "f fixed" }, h("span", null, `${f.label || name} `), h("b", null, fixed[name])));
      } else if (f.kind === "choice") {
        const v = valuesOf(f).find((x) => x.value === preset[name]);
        if (!v) return toast("refused", "This change is not offered", `${name} ${preset[name]} is not among ${verb}'s values.`);
        fixed[name] = v.value;
        title = v.label || title;
      } else if (f.kind === "line" || f.kind === "person") {
        const max = Number(f.max) || null;
        const label = f.label || name;
        const attrs = { type: "text", class: name === "reason" ? "reason" : `field-${name}`, "aria-label": label, placeholder: label, autocomplete: "off", spellcheck: f.kind === "line" };
        let list = null;
        if (f.kind === "person") {
          const id = `write-names-${++datalists}`;
          attrs.list = id;
          list = h("datalist", { id }, namesFor(fixed.from).map((n) => h("option", { value: n })));
        }
        const input = h("input", attrs);
        const count = max ? h("span", { class: "faint count" }, `0/${max}`) : null;
        const hint = f.kind === "line" ? `(one line${max ? `, at most ${max} characters` : ""}${name === "reason" ? "; it is kept in the story's history" : ""})` : max ? `(one name, at most ${max} characters)` : "(one name)";
        rows.push(h("label", { class: "f" }, h("span", null, `${label} `, h("i", null, hint)), input, count, list));
        inputs.push({ name, field: f, input, count, max });
      }
    }
    const subject = h("div", { class: "faint subject mono" });
    const plan = h("div", { class: "plan-box" }, h("div", { class: "faint" }, opts.hint || "Fill in the fields, then Preview to see what will change. Nothing is saved yet."));
    const err = h("div", { class: "write-err", role: "alert" });
    const primary = h("button", { class: "btn primary", type: "button" }, "Preview");
    const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
    let planned = null; // the fields, as JSON, of the plan on screen
    let inFlight = false;
    const valuesNow = () => {
      const out = { ...fixed };
      for (const x of inputs) out[x.name] = x.input.value.trim();
      return out;
    };
    const keyNow = () => JSON.stringify(valuesNow());
    const fresh = () => planned !== null && planned === keyNow();
    const valid = () => {
      for (const x of inputs) {
        const t = x.input.value.trim();
        const n = [...t].length;
        if (!t) return x.field.kind === "person" ? `Name the person for ${(x.field.label || x.name).toLowerCase()}.` : "Say in one line why.";
        if (x.max && n > x.max) return x.name === "reason" ? `The reason is ${n} characters long; it takes at most ${x.max}.` : `${x.field.label || x.name} is ${n} characters long; it takes at most ${x.max}.`;
      }
      return null;
    };
    const sync = () => {
      for (const x of inputs) {
        if (!x.count) continue;
        const n = [...x.input.value.trim()].length;
        x.count.textContent = `${n}/${x.max}`;
        x.count.classList.toggle("over", n > x.max);
      }
      subject.textContent = `Commit: ${fillSubject(entry.subject, valuesNow())}`;
      primary.textContent = fresh() ? title : "Preview";
      primary.disabled = inFlight || !!valid();
    };
    const showError = (text) => fill(err, text ? h("div", { class: "msg" }, text) : null);
    const firstInput = () => inputs[0]?.input || primary;
    const doPreview = async () => {
      const bad = valid();
      if (bad) return showError(bad);
      inFlight = true;
      showError(null);
      fill(plan, h("div", { class: "faint" }, "Checking what will change…"));
      sync();
      const sent = valuesNow();
      const key = JSON.stringify(sent);
      const a = await running("preview", () => post("/api/preview", { verb, fields: sent }));
      inFlight = false;
      if (a.ok) {
        planned = key;
        fill(plan, h("div", { class: "plan-h" }, "What will change"), opts.planView(a.result), h("div", { class: "faint" }, landing()));
      } else {
        planned = null;
        fill(plan, a.result && typeof a.result === "object" && a.result.story ? opts.planView(a.result) : null);
        showError(a.error);
      }
      sync();
      if (!dlg.isOpen()) return;
      // The button was disabled while the step ran, so the focus fell out of the dialog.
      if (a.ok) primary.focus();
      else firstInput().focus();
      render(); // the answer's write
    };
    const doAction = async () => {
      // The fields of the plan on screen, as they were previewed.
      const sent = JSON.parse(planned);
      const before = w()?.batch?.commits || 0;
      inFlight = true;
      showError(null);
      sync();
      primary.textContent = opts.busyWord || `${title}…`;
      const a = await running("action", () => post("/api/action", { verb, fields: sent }));
      inFlight = false;
      if (a.ok) {
        dlg.close();
        const b = w()?.batch;
        const wrote = (b?.commits || 0) > before;
        say("ok", wrote ? opts.doneText(sent) : `Nothing was written: ${opts.sameText(sent)}`);
      } else {
        planned = null;
        showError(a.error);
        sync();
        if (dlg.isOpen()) firstInput().focus();
        else say("error", `${title}: ${a.error}`);
      }
      await after();
    };
    primary.addEventListener("click", () => {
      if (primary.disabled) return;
      if (fresh()) doAction();
      else doPreview();
    });
    cancel.addEventListener("click", () => dlg.close());
    for (const x of inputs) {
      x.input.addEventListener("input", () => {
        if (planned !== null && !fresh()) {
          planned = null;
          fill(plan, h("div", { class: "faint" }, opts.changed || "A field changed: Preview again to see what will change."));
        }
        showError(null);
        sync();
      });
      // Enter previews; with a fresh plan it moves to the button, whose own click is the approval.
      x.input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (fresh()) primary.focus();
        else if (!primary.disabled) doPreview();
        else showError(valid());
      });
    }
    const dlg = modal(title, [opts.what(title), ...rows, plan, details(subject), err, h("div", { class: "btns" }, cancel, primary)]);
    sync();
    return dlg;
  }

  function openMove(ref, to) {
    const s = story(ref);
    const move = s && movesOf(s).find((m) => m.to === to);
    if (!move) return toast("refused", "This move is not offered", s ? `${s.title} is ${s.status}; the page offers no move to ${to} for it.` : `No story ${ref} on the board.`);
    return openVerb("move", s, { to }, {
      what: () => h("div", { class: "move-what" }, h("b", null, s.title), h("div", { class: "faint" }, `${s.column || s.status} → ${WORD[to] || to}`)),
      hint: "Say why in one line, then Preview to see what will change. Nothing is saved yet.",
      changed: "The reason changed: Preview again to see what will change.",
      planView: movePlan,
      busyWord: "Moving…",
      doneText: () => `${s.title} is in ${WORD[to] || to}.`,
      sameText: () => `${s.title} is ${WORD[to] || to} already.`,
    });
  }
  function openHandover(ref) {
    const s = story(ref);
    if (!s || !canHandOver(s)) return toast("refused", "This story cannot be handed over here", s ? `${s.title} has ${s.assignee ? `the column ${s.column || "none"}` : "no assignee"}; the page offers Hand over on an open story that someone holds.` : `No story ${ref} on the board.`);
    return openVerb("handover", s, {}, {
      what: () => h("div", { class: "move-what" }, h("b", null, s.title), h("div", { class: "faint" }, `${s.column} · assigned to ${s.assignee}`)),
      hint: "Name who takes it and why, then Preview to see what will change. Nothing is saved yet.",
      planView: handoverPlan,
      busyWord: "Handing over…",
      doneText: (f) => `${s.title} is ${f.to}'s now.`,
      sameText: (f) => `${s.title} is ${f.to}'s already.`,
    });
  }

  // ── Publish (Send) and Discard ──
  // A person sees "changes" and "a review request"; the branch, the commits and
  // the pull request's number stay under Details.
  const PR_WORD = { OPEN: "Waiting for review", MERGED: "Merged", CLOSED: "Review closed" };
  const prWords = (pr) => (pr ? `pull request #${pr.number ?? "?"} (${String(pr.state || "").toLowerCase() || "state unknown"})` : null);
  const changeWord = (n) => `${n} ${n === 1 ? "change" : "changes"}`;
  // gh that cannot be asked, in one sentence that says what to do; the raw reason under Details.
  // What to do when gh cannot be asked, by its reason: what the page knows, and nothing more.
  const ghAdvice = (reason) => {
    const r = String(reason || "");
    if (/not installed|not on PATH/i.test(r)) return "To let the page do it, install GitHub's command-line tool gh and sign in with gh auth login.";
    if (/known GitHub host/i.test(r)) return "The vault's repository does not seem to be on GitHub, so the page cannot open review requests there: open them on your code host.";
    if (/not logged in|auth login/i.test(r)) return "To let the page do it, sign in with gh auth login in a terminal.";
    return "This may pass: try again later.";
  };
  const ghLine = (reason) => h("div", { class: "note warn gh-line" }, `The page cannot ask GitHub about review requests, so it cannot open or follow one by itself. ${ghAdvice(reason)}`);
  function carryWords(c) {
    if (!c) return "";
    const parts = [];
    if (c.carried?.length) parts.push(`${changeWord(c.carried.length)} made after the last publish ${c.carried.length === 1 ? "was" : "were"} kept for your next review (moved from ${c.from} into ${c.branch})`);
    if (c.skipped?.length) parts.push(`${changeWord(c.skipped.length)} ${c.skipped.length === 1 ? "is" : "are"} in the backlog already`);
    if (c.stopped_at) parts.push(`one change could not be kept, "${c.stopped_at.subject}" (${short(c.stopped_at.sha)}), because ${c.stopped_at.reason}; it and the changes after it stay aside on ${c.from}`);
    return parts.length ? ` ${parts.join("; ")}.` : "";
  }
  function sendWords(a) {
    if (!a.ok) return a.error;
    const r = a.result || {};
    if (!r.sent) return `Nothing was published.${carryWords(r.carry)}`;
    const pr = r.pull_request;
    const where = pr ? ` Review request: ${prWords(pr)}${isUrl(pr.url) ? `, ${pr.url}` : ""}.` : r.gh ? " The page could not open the review request, because GitHub cannot be asked: open the pull request by hand on your code host." : "";
    return `Published ${changeWord(Number(r.commits) || 0)} for review.${where}${carryWords(r.carry)}`;
  }
  const waitBusy = () => toast("refused", "Please wait", `${BUSY[busy] || "Working…"} Try again when it has ended.`);
  function confirmSend() {
    const b = w()?.batch;
    if (!b || !can()) return;
    if (busy) return waitBusy();
    const x = w();
    const pr = b.pull_request;
    const open = pr && pr.state === "OPEN";
    const text = open
      ? `Your ${changeWord(b.commits)} ${b.commits === 1 ? "joins" : "join"} your open review request. Nothing changes in the backlog until someone approves it.`
      : x.pull_requests
        ? `Your ${changeWord(b.commits)} ${b.commits === 1 ? "uploads" : "upload"} for review, but the page cannot open the review request itself: open the pull request by hand on your code host. Nothing changes in the backlog until someone approves it.`
        : `Your ${changeWord(b.commits)} ${b.commits === 1 ? "goes" : "go"} to the team as one review request (a pull request on GitHub). Nothing changes in the backlog until someone approves it.`;
    const how = open
      ? `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin. Its ${prWords(pr)} gets them.`
      : x.pull_requests
        ? `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin. gh cannot be asked now, so no pull request is opened.`
        : `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin and open a pull request into ${x.default_branch || "the default branch"}.`;
    const go = h("button", { class: "btn primary", type: "button" }, "Publish");
    const dlg = modal("Publish for review", [h("div", null, text), x.pull_requests ? ghLine(x.pull_requests) : null, details(h("div", { class: "faint" }, how), x.pull_requests ? h("div", { class: "faint" }, `Why GitHub cannot be asked: ${x.pull_requests}`) : null), h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), go)]);
    go.addEventListener("click", async () => {
      dlg.close();
      const a = await running("send", () => post("/api/send"));
      say(a.ok ? "ok" : a.status >= 500 || a.status === 0 ? "error" : "warn", sendWords(a));
      await after();
    });
  }
  // The note after Discard, by how the batch ended (the delivery spec, contract 4).
  function discardWords(r) {
    const ended = r?.ended;
    if (ended === "merged")
      return `${r.pull_request ? "Your review request was merged already: your changes" : "Your changes"} are in the backlog.${r.kept?.stopped_at ? " One change made after you published could not be kept: it is kept aside on this computer." : ""}${r.batch ? " Changes made after you published are a new draft; Discard again to drop them." : ""}`;
    if (ended === "closed") return "Your changes were discarded and their review request is closed. They are kept aside on this computer.";
    if (r?.pull_request?.state === "MERGED") return "Your review request was merged already. The changes made after you published could not be carried yet, so they are kept aside on this computer.";
    if (!r?.pull_request && !w()?.pull_requests) return "Your changes were discarded and kept aside on this computer.";
    return "Your changes were discarded on this computer and kept aside. A review request for them, if one is open, stays open on your code host: close it there.";
  }
  function confirmDiscard() {
    const b = w()?.batch;
    if (!b || !can()) return;
    if (busy) return waitBusy();
    const pr = b.pull_request;
    const open = pr && pr.state === "OPEN";
    const gone = `Your ${changeWord(b.commits)} ${b.commits === 1 ? "leaves" : "leave"} this page`;
    const text = w()?.pull_requests
      ? `${gone}. GitHub cannot be asked, so a review request for them, if one is open, stays open: close it on your code host.`
      : open
        ? `${gone}, and the review request is closed.`
        : `${gone}.`;
    const how = open
      ? `End the batch on ${b.branch}: its ${prWords(pr)} is closed on the code host.`
      : !pr && !w()?.pull_requests
        ? `End the batch on ${b.branch} on this machine. No pull request was opened for it.`
        : `End the batch on ${b.branch} on this machine. A pull request for it, if one is open, stays open.`;
    const go = h("button", { class: "btn primary danger", type: "button" }, "Discard");
    const cancel = h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel");
    // The focus starts on Cancel: Enter on a dialog just opened ends nothing.
    const dlg = modal(
      "Discard your changes",
      [
        h("div", null, text),
        h("div", { class: "faint" }, "Nothing is deleted: the changes are kept aside on this computer (and on your code host, if you published them), and the page lists them under Kept aside."),
        details(h("div", { class: "faint" }, how)),
        h("div", { class: "btns" }, cancel, go),
      ],
      { first: cancel },
    );
    go.addEventListener("click", async () => {
      dlg.close();
      const a = await running("discard", () => post("/api/discard"));
      say(a.ok ? "ok" : a.status >= 500 || a.status === 0 ? "error" : "warn", a.ok ? discardWords(a.result) : a.error, a.ok ? sentence(String(a.result?.message || "The batch ended.")) : null);
      await after();
    });
  }

  // The refresh: when the page opens, and when asked from the palette.
  // The refresh answers no words of its own: a batch it ended is told from
  // `write` before and after (a merge carries, a closed pull request keeps).
  async function refresh() {
    const was = w()?.batch?.branch || null;
    const a = await running("refresh", () => post("/api/refresh"));
    const x = w();
    const now = x?.batch?.branch || null;
    const kept = (x?.kept || []).find((k) => k.branch === was);
    if (!a.ok && a.error) say("warn", `The page could not get the latest backlog: ${a.error}`);
    // The page can no longer write: the batch is not read, and its branch keeps its commits.
    else if (was && !x?.can) say("warn", `The page cannot save changes now: ${x?.reason || "the server does not say why"}. Your unpublished changes stay on this computer.`, `They are on the branch ${was} in the page's clone.`);
    // A kept branch with a stop was merged and its carry stopped (only a merge carries); one without was closed.
    else if (was && now !== was && kept && kept.stopped_at)
      say("warn", `Your review request was merged, but one change made after you published could not be kept, "${kept.stopped_at.subject}": ${kept.stopped_at.reason}. It and the changes after it are kept aside on this computer.`, `The batch ${was} is kept, stopped at ${short(kept.stopped_at.sha)}${now ? `; the new one is ${now}` : ""}.`);
    else if (was && now !== was && kept) say("warn", `Your review request was closed without being merged. Your changes are kept aside on this computer${now ? "; new changes start a fresh draft" : ""}.`, `The batch ${was} is kept.`);
    else if (was && now !== was) say("ok", `Your changes were merged into the backlog.${now ? " Changes made after you published are kept for your next review." : ""}`, `The batch ${was} was merged${now ? `; the new one is ${now}` : ""}.`);
    await after();
  }

  // ── what the page shows ──
  const BUSY = { refresh: "Getting the latest backlog…", preview: "Checking what will change…", action: "Saving…", send: "Publishing…", discard: "Discarding…" };
  function prLink(pr) {
    if (!pr) return null;
    const state = String(pr.state || "").toUpperCase();
    const label = PR_WORD[state] || `Review: ${String(pr.state || "state unknown").toLowerCase()}`;
    const cls = `chip pr ${state.toLowerCase()}`;
    const tip = `Pull request #${pr.number ?? "?"} on the code host`;
    return isUrl(pr.url) ? h("a", { class: cls, href: pr.url, target: "_blank", rel: "noopener noreferrer", title: tip }, label, " ↗") : h("span", { class: cls, title: tip }, label);
  }
  function keptList(kept) {
    if (!Array.isArray(kept) || !kept.length) return null;
    return h(
      "details",
      { class: "kept", open: kept.some((k) => k.stopped_at || k.commits === null) },
      h("summary", null, `Kept aside (${kept.length})`, h("span", { class: "faint" }, " · changes that were discarded or not merged, kept on this computer")),
      h(
        "ul",
        null,
        kept.map((k) =>
          h(
            "li",
            null,
            k.commits === null || k.commits === undefined ? h("span", { class: "chip flag", title: k.reason || "" }, "count unknown") : h("span", null, `${changeWord(k.commits)} not in the backlog`),
            " ",
            h("span", { class: "mono faint" }, k.branch),
            k.commits === null && k.reason ? h("div", { class: "faint" }, `git could not count them: ${k.reason}`) : null,
            k.stopped_at ? h("div", { class: "stopped" }, `Stopped at ${short(k.stopped_at.sha)} "${k.stopped_at.subject}": ${k.stopped_at.reason}.`) : null,
          ),
        ),
      ),
      h("div", { class: "faint" }, "The page does not publish or delete them. The dashboard's README says how to do either by hand."),
    );
  }
  // The strip above the view: your changes, their review request, Publish and
  // Discard, the changes kept aside, the last answer and what runs now.
  function paint() {
    const bar = $("#write");
    if (!bar) return;
    const x = w();
    if (!x) return void ((bar.hidden = true), bar.replaceChildren());
    const b = x.can ? x.batch : null;
    const off = !!busy;
    const open = b?.pull_request?.state === "OPEN";
    const kids = [
      b &&
        h(
          "div",
          { class: "batch", role: "group", "aria-label": "Your changes" },
          // With gh out of reach the page cannot tell a published batch from one that is not: it says only what it knows.
          h(
            "span",
            { class: "batch-h", title: x.pull_requests && !b.pull_request ? "GitHub cannot be asked, so the page cannot tell whether these changes were published." : "" },
            ico("branch"),
            !b.commits ? "No changes yet" : open ? `${changeWord(b.commits)} · review request open` : b.pull_request ? `${changeWord(b.commits)} · ${(PR_WORD[String(b.pull_request.state || "").toUpperCase()] || "review request state unknown").toLowerCase()}` : x.pull_requests && !b.pull_request ? `${changeWord(b.commits)} not in the backlog yet` : `${changeWord(b.commits)} not published yet`,
          ),
          prLink(b.pull_request),
          h("span", { class: "grow" }),
          h(
            "button",
            { class: "btn primary", type: "button", "data-focus": "send", disabled: off || !b.commits, onclick: confirmSend, title: !b.commits ? "There is no change to publish" : open ? "Add the changes made since the last publish to your open review request" : "Send your changes to the team as one review request" },
            open ? "Publish again…" : "Publish for review…",
          ),
          h("button", { class: "btn", type: "button", "data-focus": "discard", disabled: off, onclick: confirmDiscard, title: "Drop your changes from this page; nothing is deleted" }, "Discard changes…"),
          details(
            h(
              "div",
              { class: "faint" },
              h("span", { class: "mono", title: `started ${b.started_at || "?"}` }, b.branch),
              ` · ${plural(b.commits, "commit")} not in ${x.default_branch || "the default branch"}`,
              b.started_at ? ` · started ${new Date(b.started_at).toLocaleString()}` : "",
              b.pull_request ? ` · PR #${b.pull_request.number ?? "?"} · ${String(b.pull_request.state || "").toLowerCase()}` : x.pull_requests ? " · pull request: gh cannot be asked" : " · no pull request yet",
            ),
          ),
        ),
      keptList(x.kept),
      busy ? h("div", { class: "faint busy", role: "status" }, BUSY[busy] || "Working…") : null,
      note ? h("div", { class: `write-note ${note.kind}`, role: note.kind === "error" ? "alert" : "status" }, h("span", { class: "msg" }, note.text, note.detail ? details(h("div", { class: "faint" }, note.detail)) : null), h("button", { class: "btn ghost", type: "button", "data-focus": "note-close", "aria-label": "close this message", onclick: () => say(null, null) }, "✕")) : null,
    ].filter(Boolean);
    // A button of the strip that held the focus is replaced here: its new one takes it.
    // One that was disabled then (a step running) takes it back when the strip has it.
    const held = bar.contains(document.activeElement) ? document.activeElement : null;
    const key = held && held !== bar ? held.getAttribute?.("data-focus") || null : null;
    bar.hidden = !kids.length;
    fill(bar, kids);
    if (held && held !== bar && !bar.contains(held)) {
      wanted = key;
      refocus(key);
    }
    if (document.activeElement === bar && wanted) {
      const el = [...bar.querySelectorAll("button")].find((x) => x.getAttribute("data-focus") === wanted && !x.disabled);
      if (el) {
        wanted = null;
        el.focus();
      }
    }
  }

  // The foot of the menu: whether this page saves changes, and, when it does not, why (one quiet line).
  function footLine() {
    const x = w();
    const name = S.project.name;
    if (!x || !x.can)
      return h(
        "div",
        { class: "write-reason", style: "margin-top:10px" },
        h("div", null, h("b", null, "Changes are off here: "), x?.reason || "this server does not say whether the page can save changes."),
        h("div", null, `The backlog of ${name}, as it is on disk. Nothing on this page changes it. Version ${S.coreVersion}.`),
      );
    const at = x.fetched_at ? ` Fetched ${new Date(x.fetched_at).toLocaleString()}.` : "";
    return h(
      "div",
      { style: "margin-top:10px" },
      h("div", null, "What you change here stays a draft until you publish it for review and someone approves it."),
      details(h("div", { class: "faint" }, `The backlog of ${name}. A change from this page is one commit on your batch branch, in the page's own clone; it reaches ${x.default_branch || "the default branch"} when its pull request is merged.${at} Version ${S.coreVersion}.`)),
    );
  }

  // The story's side panel: its moves, as buttons (the keyboard's way to the
  // drag), and Hand over when the story can be handed over.
  function storyButtons(s) {
    const moves = movesOf(s);
    const hand = canHandOver(s) ? entryOf("handover") : null;
    if (!moves.length && !hand) return null;
    return h(
      "div",
      { class: "row write-acts" },
      moves.map((m) => h("button", { class: "btn", type: "button", "data-focus": `move-${m.to}`, disabled: !!busy, onclick: () => openMove(s.ref, m.to) }, `${m.label}…`)),
      hand ? h("button", { class: "btn", type: "button", "data-focus": "handover", disabled: !!busy, onclick: () => openHandover(s.ref) }, `${hand.label || "Hand over"}…`) : null,
    );
  }
  // The palette's commands: a story's moves and its handover, and the batch's Send and Discard.
  function storyCommands(s) {
    const out = movesOf(s).map((m) => ({ label: `${m.label}…`, run: () => openMove(s.ref, m.to), kw: "move status todo backlog planned write" }));
    const hand = canHandOver(s) ? entryOf("handover") : null;
    if (hand) out.push({ label: `${hand.label || "Hand over"}…`, run: () => openHandover(s.ref), kw: "handover assignee give person write" });
    return out;
  }
  function rootCommands() {
    const x = w();
    if (!x || !x.can) return [];
    const out = [];
    if (x.batch && x.batch.commits) out.push({ label: "Publish my changes for review…", run: confirmSend, group: "My changes", kw: "send push pull request batch" });
    if (x.batch) out.push({ label: "Discard my changes…", run: confirmDiscard, group: "My changes", kw: "end close batch" });
    out.push({ label: "Get the latest backlog", run: refresh, group: "My changes", kw: "refresh fetch pull request state code host" });
    return out;
  }

  // When the page opens: the refresh, once, then the page from its answer.
  function boot() {
    refresh();
  }

  return { post, movesOf, canHandOver, namesFor, dragCard, dropColumn, openMove, openHandover, openVerb, canRank, dragTreeRow, rankKey, openRank, confirmSend, confirmDiscard, refresh, paint, footLine, storyButtons, storyCommands, rootCommands, boot, sendWords, carryWords, ROUTES };
})();

// The item pane: one work item or document, rendered from its Markdown (a story's,
// an epic's and an initiative's text is its editor while the page can write), with its fields and what is related to it beside it. Loaded after
// app.js and views.js, and shares their helpers (h, $, S, ui, story, epic, …).

let ART = []; // every artifact: for links between documents and for the search
const artByRel = new Map();
const artByName = new Map();
async function loadArtifacts() {
  ART = await (await fetch("/api/artifacts")).json();
  artByRel.clear();
  artByName.clear();
  const stem = (rel) => rel.split("/").pop().replace(/\.md$/, "");
  for (const a of ART) {
    artByRel.set(a.rel, a);
    artByName.set(stem(a.rel), a);
    if (a.id) artByName.set(a.id, a);
    if (a.type === "epic") artByName.set(a.rel.split("/")[1], a);
  }
}

// ── addresses: a vault path from a link written in a document ──
function vaultPath(fromRel, target) {
  let t = target.split("#")[0];
  try {
    t = decodeURI(t);
  } catch {
    /* keep it as written */
  }
  const parts = t.startsWith("/") ? [] : fromRel.split("/").slice(0, -1);
  for (const seg of t.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const vaultUrl = (path) => `/vault/${path.split("/").map(encodeURIComponent).join("/")}`;

function artifactAt(fromRel, target) {
  const path = vaultPath(fromRel, target);
  const bare = target.split("#")[0].replace(/\.md$/, "");
  return artByRel.get(path) || artByRel.get(`${path}.md`) || artByRel.get(`${path}/epic.md`) || artByRel.get(`${bare}.md`) || (!bare.includes("/") ? artByName.get(bare) : null) || null;
}
function kindAndId(a) {
  if (a.type === "story") return ["story", S.stories.find((s) => s.rel === a.rel)?.ref];
  if (a.type === "epic") return ["epic", a.rel.split("/")[1]];
  if (a.type === "initiative") return ["initiative", S.initiatives.find((i) => i.rel === a.rel)?.id];
  return ["doc", a.rel];
}
// What a renderer needs to know about the document it draws.
function docCtx(rel) {
  return {
    rel,
    link(target) {
      if (/^(https?:|mailto:)/i.test(target)) return { href: target, icons: linkIcons(target), title: linkWords(target) };
      if (SCHEME.test(target)) return null; // javascript:, data:, file: … are not links here
      const a = artifactAt(rel, target);
      if (a) {
        const [kind, id] = kindAndId(a);
        return id ? { open: () => openDrawer(kind, id), icons: [kindIcon(a.type)], title: `${a.type}: ${a.title}`, href: `#/${ui.view}/${kind}/${encodeURIComponent(id)}` } : null;
      }
      const path = vaultPath(rel, target);
      return MD.kindOf(path) !== "file" || /\.pdf$/i.test(path) ? { href: vaultUrl(path) } : null;
    },
    media(url) {
      // The page loads files from itself only: a picture or a video from another site is not shown.
      if (SCHEME.test(url)) return null;
      const path = url.includes("/") ? vaultPath(rel, url) : `attachments/${url}`; // a bare name: where pasted files live
      const kind = MD.kindOf(path);
      return kind !== "file" || /\.pdf$/i.test(path) ? { src: vaultUrl(path), kind } : null;
    },
  };
}

// ── the address bar: a view and an item can be linked to, and Back works ──
let hashQuiet = false;
// "#/<view>[/<kind>/<id>][?<what differs from the built-in view>]". `quiet` is for a redraw: the
// place is the same and only its parameters moved, so the address is rewritten with no new step
// in the history. A change of view or of item is a step, and Back returns from it.
function syncHash(quiet) {
  const d = ui.drawer;
  const q = viewQuery(ui.view); // views.js
  const want = `#/${ui.view}${d ? `/${d.kind}/${encodeURIComponent(d.id)}` : ""}${q ? `?${q}` : ""}`;
  if (location.hash === want) return;
  const place = (hash) => hash.split("?")[0];
  if (quiet) {
    if (place(location.hash) === place(want)) history.replaceState(null, "", want);
    return;
  }
  hashQuiet = true;
  location.hash = want;
}
function applyHash() {
  const [path, query = ""] = location.hash.split("?");
  const [, view, kind, ...rest] = path.split("/");
  if (isView(view)) {
    ui.view = view;
    applyQuery(view, query); // views.js: the view becomes what the address says
  }
  const id = rest.length ? decodeURIComponent(rest.join("/")) : null;
  if (kind && id) openDrawer(kind, id, true);
  else ui.drawer = null;
  render();
}
window.addEventListener("hashchange", () => {
  if (hashQuiet) return void (hashQuiet = false);
  applyHash();
});

// ── open, close ──
function relOf(kind, id) {
  if (kind === "story") return story(id)?.rel;
  if (kind === "epic") return epic(id)?.rel;
  if (kind === "initiative") return S.initiatives.find((i) => i.id === id)?.rel;
  return id;
}
function openDrawer(kind, id, fromHash) {
  ui.drawer = { kind, id, item: null, tab: "doc" };
  if (!fromHash) syncHash();
  renderDrawer();
  fetchItem();
}
// The editor's base (dashboard-editor, contract 6): the one POST of item.js, to its own route, with the run's token.
const BASE_ROUTE = "/api/base";
const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null));
// The document and what belongs to it, read beside each other.
function fetchItem() {
  const d = ui.drawer;
  const rel = d && relOf(d.kind, d.id);
  if (!rel) return;
  getJson(`/api/item?rel=${encodeURIComponent(rel)}`).then((item) => {
    if (ui.drawer === d) {
      d.item = item || { missing: true };
      renderDrawer();
    }
  });
  getJson(`/api/related?rel=${encodeURIComponent(rel)}`).then((data) => {
    if (ui.drawer === d && data) {
      d.related = data;
      renderDrawer();
    }
  });
  // The Code block of a story or a spec (code.js), asked for when the item opens and on R.
  codeUi.ask(d);
}
function closeDrawer() {
  // Closing a document with an edit that is not saved keeps the edit, and says so.
  if (ED && ED.host.isConnected && ED.dirty()) toast("info", "Not saved yet", "Your edit is kept in this browser. Open the document again to save it.");
  ui.drawer = null;
  syncHash();
  renderDrawer();
  return true;
}

// The text, or Related in full in its place. The new content starts at its top.
function showTab(d, tab) {
  d.tab = tab;
  renderDrawer();
  $("#drawer").scrollTop = 0;
}

// ── the pane ──
function renderDrawer() {
  const pane = $("#drawer");
  const d = ui.drawer;
  const project = S?.project?.name || "ProjectStore";
  // The tab says what is open: the item, or the view behind it.
  document.title = `${ui.viewTitle || "Dashboard"} · ${project}`;
  if (!d) return void (pane.hidden = true);
  const side = { story: sideStory, epic: sideEpic, initiative: sideInitiative, doc: sideDoc }[d.kind] || sideDoc;
  const info = side(d);
  if (!info) return void (pane.hidden = true);
  const item = d.item;
  document.title = `${info.title} · ${project}`;
  const main = h("div", { class: "item-main" });
  // While the page can write, a story's, an epic's or an initiative's text is the editor itself, as in Obsidian (dashboard-editor).
  // Only a story, an epic or an initiative (the ADR "Create and edit verbs…"); a server started
  // before the page's code sends no `edit` or no `edit-doc`: the text is then shown with no editor, and a note says why.
  const editsHere = !!item && !item.missing && d.tab === "doc" && !!S.write?.can && ["story", "epic", "initiative"].includes(item.type);
  const canEdit = !!item?.edit && (S.write?.verbs || []).some((v) => v && v.verb === "edit-doc");
  const editable = editsHere && canEdit && typeof WSEditor !== "undefined";
  const oldServer = editsHere && !canEdit;
  // The editor's built file did not load (a failed request, a blocked script): said, never silent.
  const noEditor = editsHere && canEdit && typeof WSEditor === "undefined";
  if (!item) main.append(h("div", { class: "faint" }, "reading…"));
  else if (item.missing) main.append(h("div", { class: "faint" }, "The file could not be read."));
  else if (editable) main.append(editorFor(d, item));
  else
    // fill(), not the native append: append prints a null as the text "null".
    fill(
      main,
      // What belongs to the item stands in the side panel. Its long form opens here, in place of the text.
      d.tab !== "doc" ? h("div", { class: "doc-bar" }, h("button", { class: "tog on", onclick: () => showTab(d, "doc") }, "← Back to the text"), h("b", null, "Related, in full")) : null,
      oldServer ? h("div", { class: "ed-draft bad" }, h("b", null, "The server is older than this page. "), "Stop it (Ctrl+C), start it again and reload this page.") : null,
      noEditor ? h("div", { class: "ed-draft bad" }, h("b", null, "The editor did not load. "), "Reload this page; until then the text is shown with no editor.") : null,
      d.tab === "rel" ? relatedView(d) : MD.render(bodyOf(d, item), docCtx(item.rel)),
    );
  const scroll = pane.scrollTop;
  pane.replaceChildren(
    h(
      "div",
      { class: "item-head" },
      h("span", { class: "kind" }, kindIco(info.kind.split(" ")[0]), info.kind),
      h("span", { class: "grow" }),
      h("button", { class: "btn ghost", onclick: closeDrawer, "aria-label": "close", title: "Close (Esc)" }, "✕"),
    ),
    h("h2", null, info.title),
    // The side panel in three parts. Beside the text they stand in one column; in a narrow pane
    // the fields go above the text and the rest below it, so the text is not pushed out of sight.
    h("div", { class: "item-grid" }, main, h("div", { class: "item-side" }, h("div", { class: "side-fields" }, info.fields), item && !item.missing ? relatedSide(d) : null, item && !item.missing ? codeUi.block(d) : null, info.more ? h("div", { class: "side-more" }, info.more) : null)),
  );
  pane.hidden = false;
  pane.scrollTop = scroll;
}

// ── the document is the editor (dashboard-editor; CodeMirror, built from dashboard/editor/) ──
// One editor at a time; it outlives a redraw, so a refresh while typing keeps the text.
// Save (⌘S) runs the page's `edit-doc`: one commit in your changes, as a drag is.
// The change marks compare the text with an earlier one: by default the file where your
// changes start (the commit your batch shares with the default branch), so green is what
// this page changed and an edit made in Obsidian meanwhile is not drawn as yours.
let ED = null;
function editorFor(d, item) {
  if (ED && ED.rel === item.rel) {
    ED.sync(item);
    return ED.host;
  }
  if (ED) ED.destroy();
  ED = makeEditor(item);
  return ED.host;
}
function makeEditor(item) {
  const rel = item.rel;
  // The editor holds the `## ` sections of a story, an epic or an initiative, cut by the edit
  // verb's own module (scripts/edit-cut.mjs); the rest is kept by gates and verbs.
  const partOf = (it) => it.edit.body;
  let saved = partOf(item); // the text as your changes hold it
  let opened = item.edit?.hash || ""; // the save is refused when the file changed since
  let base = null; // where your changes start: asked of POST /api/base, null until it answers
  let saving = false;
  const ctx = docCtx(rel);
  const draftKey = `draft:${rel}`;
  const tools = h("div", { class: "ed-tools" });
  const notice = h("div", { class: "ed-draft" });
  // The file reads otherwise in the vault folder (Obsidian, or not pulled yet): said once, above the text.
  const diskNote = h("div", { class: "ed-draft ed-disk" });
  const showDisk = (disk) =>
    diskNote.replaceChildren(
      ...(disk?.differs
        ? [disk.exists ? "This file reads differently in your vault folder: an edit in Obsidian, or the folder and your changes stand at different commits. The marks show only your own changes. Both versions meet when your changes are merged." : "This file is not in your vault folder (not pulled there yet, or removed there). The marks show only your own changes."]
        : []),
    );
  // The file changed (a verb from the side panel, another tab, Get latest) while unsaved text stood:
  // the text keeps the hash it was taken from, so its save is refused instead of writing over that change.
  let latest = item;
  let stale = false;
  const changedNote = h("div", { class: "ed-draft bad" });
  // The browser keeps nothing of an unsaved text (contract 12): said for as long as it cannot.
  const keepNote = h("div", { class: "ed-draft bad" });
  const showChanged = () =>
    changedNote.replaceChildren(...(stale ? [h("b", null, "This file changed while you were typing. "), "Save will be refused: copy your text, open the document again and put your change into it."] : []));
  // The base is read from git, which no GET may start, so it is a POST of the page's own.
  // Only the latest answer counts: a save or a refresh may ask again before the first returns.
  let asked = 0;
  async function loadBase() {
    const n = ++asked;
    let r = null;
    let res = null;
    let err = "";
    try {
      const token = document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
      res = await fetch(BASE_ROUTE, { method: "POST", headers: { "content-type": "application/json", "x-projectstore-token": token }, body: JSON.stringify({ rel }) });
      r = await res.json().catch(() => null);
    } catch (e) {
      err = String(e?.message || e);
    }
    // While "Check the editor" runs on its own sample text, an answer would replace its earlier text.
    if (n !== asked || !ED || ED.ed !== ed || window.WS_SELFTEST) return;
    if (res?.status === 200 && r?.ok) {
      base = typeof r.base === "string" ? r.base : null;
      showDisk(r.disk);
    } else {
      // Unknown, and said: never drawn as "no changes".
      base = null;
      if (res?.status === 403) diskNote.replaceChildren(h("b", null, "The server was started again. "), "Reload this page to see your changes.");
      else diskNote.replaceChildren(h("b", null, "Your changes cannot be marked. "), r?.error || err || `The server answered ${res?.status}.`);
    }
    applyBase();
  }
  const body = h("div", { class: "ed-body" });
  // Above the text: what the editor does not hold, drawn as it reads (not a story's: its side panel has it).
  const headText = String(item.edit?.head || "").replace(/^\s*# [^\n]*\n?/, "").trim();
  const headBox = headText && !/\/stories\//.test(rel) ? h("div", { class: "ed-head", title: "Kept by gates and verbs: not edited here" }, MD.render(headText, ctx)) : null;
  const host = h("div", { class: "ed" }, headBox, tools, changedNote, keepNote, diskNote, notice, body, h("div", { class: "ed-note" }, "The text is Markdown, shown as it will read; the marks appear where the cursor is. Green is what you added, red what you removed, since your changes started. Save keeps it in your changes; Publish sends them for review. The title, the field table, the Status log and checked criteria are written by gates and verbs, not here."));
  // A picture or a PDF pasted or dropped is not kept yet (the PS-BACKLOG story on an attachments
  // folder): the text gets nothing, and the toast says where it can go instead.
  const addFiles = (list) => {
    const names = [...list].map((f) => f.name).filter(Boolean).join(", ");
    if (!window.WS_SELFTEST)
      toast("refused", "Not kept", `${names ? `${names}: a` : "A"} pasted picture or file is not kept by the page yet. Put it in your vault folder and link it from the text.`);
  };
  // A URL over selected words links them; rich text from a page comes in as Markdown.
  const pasteText = (plain, html) => {
    const text = String(plain || "").trim();
    if (/^https?:\/\/\S+$/.test(text)) {
      const sel = ed.selected();
      if (sel) return ed.insert(`[${sel}](${text})`), true;
      return false;
    }
    const md = html && MD.fromHtml(html);
    if (!md || md === text) return false;
    ed.insert(md.includes("\n") ? `${md}\n\n` : md);
    return true;
  };
  const trim = (t) => String(t || "").replace(/\s+$/, "");
  const dirty = () => trim(ed.text()) !== trim(saved);
  // The path from this document to another, as a link in the text writes it.
  const here = rel.split("/").slice(0, -1);
  const relTo = (r) => {
    const to = r.replace(/\.md$/, "").split("/");
    let k = 0;
    while (k < here.length && k < to.length - 1 && here[k] === to[k]) k++;
    return [...here.slice(k).map(() => ".."), ...to.slice(k)].join("/");
  };
  const linkTo = (a, label) => `[[${relTo(a.rel)}|${(label || a.title).replace(/[|\]]/g, " ")}]]`;
  const findDocs = (text, limit) => {
    const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
    return ART.filter((a) => a.rel !== rel && words.every((w) => `${a.title} ${a.type} ${a.epic || ""}`.toLowerCase().includes(w))).slice(0, limit);
  };
  let draftTimer = null;
  const writeDraft = () => {
    clearTimeout(draftTimer);
    if (window.WS_SELFTEST) return; // its sample text is not the person's
    const kept = store.set(draftKey, dirty() ? { body: ed.text(), saved, hash: opened, at: Date.now() } : null);
    // A text this browser cannot keep is said above the text, for as long as it cannot (contract 12).
    keepNote.replaceChildren(...(!kept && dirty() ? [h("b", null, "This browser does not keep your text. "), "Its storage is full or turned off: save the text before you leave this page."] : []));
  };
  // Leaving or reloading the page keeps the last keys typed, not only those of 400 ms ago.
  const onHide = () => writeDraft();
  window.addEventListener("pagehide", onHide);
  const keepDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, 400);
  };
  // Hashes of bodies this editor's own saves wrote over (contract 9).
  const superseded = new Set();
  async function save() {
    if (!dirty() || saving || window.WS_SELFTEST) return;
    // Text kept over a body that changed since (contract 9): refused here, in the page's words, with nothing sent.
    if (stale) {
      notice.classList.add("bad");
      fill(notice, h("b", null, "Not saved. "), "The file changed after you opened it. Copy your text, open the document again and put your change into it.");
      return paint();
    }
    saving = true;
    paint();
    const text = ed.text();
    const fields = { path: rel, text, base: opened };
    const a = await writeUi.saveDoc(fields);
    saving = false;
    if (a.ok) {
      saved = text;
      // The written body's hash is the one the next save carries, whatever was typed meanwhile.
      if (typeof a.result?.hash === "string") {
        // The item read before this save may still be drawn once while load() runs: its hash is not a change.
        if (opened) superseded.add(opened);
        opened = a.result.hash;
      }
      store.set(draftKey, null);
      notice.replaceChildren();
      notice.classList.remove("bad");
      await load(); // app.js: the state (the change count), the artifacts and this item, read again
    } else {
      // The reason stays above the text until the next edit, not only in a toast that fades.
      notice.classList.add("bad");
      // The edit verb's refusal of a changed file speaks to a terminal; the page says it in its own words.
      const said = /changed after it was read/.test(a.error || "") ? "The file changed after you opened it. Copy your text, open the document again and put your change into it." : a.error;
      fill(notice, h("b", null, "Not saved. "), said || "The text could not be saved.");
    }
    paint();
  }
  // The document as it is now: after a change made meanwhile, Discard and "throw it away" open it again.
  function adopt(it) {
    stale = false;
    saved = partOf(it);
    opened = it.edit?.hash || "";
    store.set(draftKey, null);
    notice.replaceChildren();
    if (trim(ed.text()) !== trim(saved)) ed.replaceAll(saved);
    showChanged();
    applyBase();
  }
  const discard = () => {
    if (!dirty()) return;
    dialog("Throw away your edit?", h("div", { class: "dim" }, "The text you have not saved goes away. What is saved stays."), [
      {
        label: "Throw it away",
        run: () => {
          if (stale) adopt(latest);
          else {
            ed.replaceAll(saved);
            store.set(draftKey, null);
            notice.replaceChildren();
          }
          paint();
        },
      },
    ]);
  };
  const ed = WSEditor.create({
    parent: body,
    doc: saved,
    ctx: {
      media: ctx.media,
      suggest: (text) => findDocs(text, 30).map((a) => ({ title: a.title, kind: a.type, insert: linkTo(a) })),
      known: (t) => !!ctx.link(t),
      icons: (t) => ctx.link(t)?.icons || [],
      render: (text) => MD.render(text, ctx),
      follow: (t) => {
        const l = ctx.link(t);
        if (l?.open) l.open();
        else if (l?.href) window.open(l.href, "_blank", "noopener");
      },
    },
    onChange: () => {
      if (notice.classList.contains("bad")) (notice.classList.remove("bad"), notice.replaceChildren());
      // Every change undone after the file changed: the editor takes the file as it is now.
      if (stale && !dirty() && !window.WS_SELFTEST) return adopt(latest);
      paint();
      keepDraft();
    },
    onSave: save,
    onFiles: addFiles,
    onPasteText: pasteText,
  });
  const tool =(label, title, run) => h("button", { class: "btn ghost", type: "button", title, onmousedown: (e) => e.preventDefault(), onclick: run }, label);
  const state = h("span", { class: "ed-state" });
  const saveBtn = h("button", { class: "btn primary", type: "button", title: `Save into your changes (${MOD}S)`, onclick: save }, "Save");
  const dropBtn = h("button", { class: "btn ghost", type: "button", onclick: discard }, "Discard");
  const modeBtn = h("button", { class: "tog", type: "button", title: `Show the Markdown as it is written (${MOD}E)`, onclick: () => (ed.setLive(!ed.live), paint()) }, "Source");
  let mode = store.get("diffMode", "vault");
  const count = h("button", { class: "ed-count", type: "button", title: "Go to the next changed part", onclick: () => ed.nextChange() });
  const opt = (v, t) => h("option", { value: v, selected: v === mode }, t);
  const baseSel = h(
    "select",
    { class: "ed-base", title: "What the marks compare the text with", onchange: (e) => ((mode = e.target.value), store.set("diffMode", mode), applyBase()) },
    opt("vault", "All your changes"),
    opt("saved", "Changes not saved yet"),
    opt("off", "Changes: off"),
  );
  const isNew = () => mode === "vault" && base !== null && !base.trim();
  // The marks follow the edits as they are made (changes.mjs); setting the earlier text compares
  // the two texts again from scratch, which redraws them by the shortest diff and makes them jump.
  // So it is set only when the earlier text really is another one, not on every save or answer.
  function applyBase() {
    const want = mode === "off" ? null : mode === "saved" ? saved : base === null || !base.trim() ? null : base;
    if ((want ?? null) !== (ed.baseline ?? null)) ed.setBaseline(want);
    body.classList.toggle("is-new", isNew());
    paint();
  }
  function paint() {
    const n = ed.changes();
    count.textContent = isNew() ? "new document" : ed.baseline === null || ed.baseline === undefined ? "" : n ? `${n} change${n === 1 ? "" : "s"} ↓` : "no changes";
    count.disabled = !n;
    count.className = `ed-count${n || isNew() ? " has" : ""}`;
    const dy = dirty();
    state.textContent = saving ? "saving…" : dy ? "not saved" : "saved";
    state.className = `ed-state${dy ? " dy" : ""}`;
    saveBtn.disabled = !dy || saving;
    // Discard keeps its place when there is nothing to throw away, so the first key typed
    // does not move the bar (and the text under it) when the bar wraps in a narrow pane.
    dropBtn.style.visibility = dy ? "visible" : "hidden";
    dropBtn.disabled = !dy;
    modeBtn.classList.toggle("on", !ed.live);
  }
  tools.append(
    tool("B", `Bold (${MOD}B)`, () => ed.wrap("**", "bold")),
    tool("I", `Italic (${MOD}I)`, () => ed.wrap("*", "italic")),
    tool("H", "Section heading", () => ed.lines("### ")),
    tool("• List", "Bullet list", () => ed.list("bullet")),
    tool("1. List", "Numbered list", () => ed.list("number")),
    tool("☐ Task", "Checklist item; on a task it ticks it", () => ed.list("task")),
    tool("❝", "Quote", () => ed.lines("> ")),
    tool("</>", "Code", () => ed.wrap("`", "code")),
    tool("▦ Table", "Table", () => ed.insert("\n| Column | Column |\n|---|---|\n|  |  |\n")),
    h("span", { class: "sep" }),
    tool("🔗 Link", `Link (${MOD}K)`, () => ed.link()),
    h("span", { class: "grow" }),
    baseSel,
    count,
    modeBtn,
    state,
    dropBtn,
    saveBtn,
  );
  // ⌘E switches the view inside the editor: the Source button follows it.
  host.addEventListener("keyup", () => paint());
  // Escape leaves the text instead of closing the item.
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && host.contains(document.activeElement)) {
      e.stopPropagation();
      document.activeElement.blur();
    }
  });
  // A draft from an earlier visit comes back over the same saved text.
  const draft = store.get(draftKey, null);
  if (draft && typeof draft.body === "string" && trim(draft.body) !== trim(saved)) {
    const same = draft.hash ? draft.hash === opened : trim(draft.saved) === trim(saved);
    if (!same) {
      // Kept over the body it was taken from: its save is refused, and the note says why.
      stale = true;
      if (typeof draft.saved === "string") saved = draft.saved;
      opened = draft.hash || "changed";
      showChanged();
    }
    ed.replaceAll(draft.body);
    const drop = h("button", { class: "link", type: "button", onclick: () => (adopt(latest), paint()) }, "throw it away");
    fill(notice, h("span", null, `This is your text from ${new Date(draft.at).toLocaleString()}. It is not saved yet. Save it, or `), drop, ".");
  }
  // The base is asked when the item opens and when its file or the batch moves (a save, Get latest), not on every redraw.
  const baseKeyOf = (it) => `${it.edit?.hash || ""}|${S.write?.batch?.head || ""}|${S.write?.fetched_at || ""}`;
  let baseKey = baseKeyOf(item);
  applyBase();
  loadBase();
  return {
    rel,
    host,
    ed, // selftest.js reads the editor and whether text is unsaved
    dirty,
    // The item read again (after a save, a refresh): the saved text and the base follow it;
    // the editor's text changes only when nothing unsaved is in it.
    sync(next) {
      if (window.WS_SELFTEST) return; // "Check the editor" owns the text and its earlier text meanwhile
      latest = next;
      const hash = next.edit?.hash || "";
      if (hash !== opened && !superseded.has(hash)) {
        // Unsaved text keeps the body it was taken from; with none, the editor takes the new one.
        if (dirty()) (stale = true), showChanged();
        else adopt(next);
      }
      const key = baseKeyOf(next);
      if (key !== baseKey) (baseKey = key), loadBase();
      applyBase();
    },
    save,
    destroy() {
      // Leaving a text that is not saved: it is kept in this browser, and the person is told so.
      if (dirty() && !window.WS_SELFTEST) toast("info", "Not saved yet", `Your edit of "${item.title || rel}" is kept in this browser. Open it again to save it.`);
      writeDraft();
      window.removeEventListener("pagehide", onHide);
      ed.destroy();
    },
  };
}
// ⌘S saves the open document wherever the focus is (a click on a checkbox or a button takes it
// out of the text); inside the text the editor answers the key itself.
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return;
  if (!ED || !ED.host.isConnected || $("#drawer").hidden) return;
  e.preventDefault();
  ED.save();
});

// The text below the title. A story's own Field/Value table repeats the side panel, so it is
// left out; an epic's, an initiative's, an ADR's or a spec's stays, since its panel does not hold the same.
const HEAD_TABLE = /^\s*\|\s*Field\s*\|\s*Value\s*\|[^\n]*\n(?:\|[^\n]*(?:\n|$))*(?:\s*---\s*(?:\n|$))?/;
function bodyOf(d, item) {
  const text = item.body.replace(/^\s*# .*\n/, "");
  return d.kind === "story" ? text.replace(HEAD_TABLE, "") : text;
}
// The file an item is read from, folded: a person who edits the vault by hand finds it here.
const fileLine = (rel) => (rel ? h("details", { class: "file-line" }, h("summary", null, "Where the file is"), h("span", { class: "mono" }, rel)) : null);
const kv = (...pairs) => h("div", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("span", null, k), h("span", null, v)]));
const who = (name) => (name ? h("span", { class: "who-line" }, avatar(name), ` ${name}`) : "—");

function sideStory(d) {
  const s = story(d.id);
  if (!s) return null;
  const done = s.subtasks.filter((t) => t.done).length;
  return {
    kind: s.variant ? `story · ${s.variant}` : "story",
    title: s.title,
    fields: [
      kv(
        ["Status", [pill(s), s.ageDays !== null && s.column !== "Done" ? h("span", { class: "faint", title: "Days in this status" }, `  ${s.ageDays} ${s.ageDays === 1 ? "day" : "days"}`) : null]],
        ["Epic", h("button", { class: "link", onclick: () => openDrawer("epic", s.epic) }, s.epic)],
        ["Priority", chipP(s.priority)],
        ["Assignee", who(s.assignee)],
        ["Subtasks", s.subtasks.length ? `${done} of ${s.subtasks.length} done` : "—"],
        ["Ready for ToDo", h("span", { style: s.ready.ok ? "color:var(--ok)" : "color:var(--warn)", title: "A story is ready for ToDo when it has a Description and at least one acceptance criterion." }, s.ready.ok ? "yes, it has a description and acceptance criteria" : `not yet: it needs ${s.ready.missing.join(" and ")}`)],
      ),
      writeUi.storyButtons(s), // write.js: the keyboard's way to a move, beside the drag
      fileLine(s.rel),
    ],
  };
}

function sideEpic(d) {
  const e = epic(d.id);
  if (!e) return null;
  // In the tree's order (the spec dashboard-rank, contract 3), done stories included.
  const mine = epicStories(e.id);
  const ini = e.initiative && S.initiatives.find((i) => i.id === e.initiative);
  return {
    kind: e.standing ? "epic · standing" : "epic",
    title: `${e.id} · ${e.title}`,
    fields: [
      kv(
        ["Status", epicPill(e)],
        ["Initiative", ini ? h("button", { class: "link", onclick: () => openDrawer("initiative", ini.id) }, ini.title) : e.initiative || "none"],
        ["Priority", chipP(e.priority)],
        ["Progress", progress(e.counts)],
      ),
      fileLine(e.rel),
    ],
    more: [h("h3", null, `Stories (${mine.length})`), h("div", { class: "linklist" }, mine.map((s) => h("div", { class: "line" }, pill(s), h("button", { class: "link", onclick: () => openDrawer("story", s.ref) }, s.title))))],
  };
}

function sideInitiative(d) {
  const i = S.initiatives.find((x) => x.id === d.id);
  if (!i) return null;
  const el = i.elaboration && story(i.elaboration);
  return {
    kind: "initiative",
    title: i.title,
    fields: [
      kv(
        ["Stage", wordPill(i.stage)],
        ["Decision", STATUS_LABEL[i.status] || i.status],
        ["Owner", i.owner && i.owner !== "unknown" ? who(i.owner) : "nobody named"],
        ["Priority", chipP(i.priority)],
        ["Worked out in", el ? [pill(el), " ", h("button", { class: "link", onclick: () => openDrawer("story", el.ref) }, `story for ${el.assignee || "nobody"}`)] : "—"],
        ["Progress", i.epics.length ? progress(i.counts) : "no epics yet"],
      ),
      fileLine(i.rel),
    ],
    more: [h("h3", null, `Epics (${i.epics.length})`), h("div", { class: "linklist" }, i.epics.map((x) => h("button", { class: "link", onclick: () => openDrawer("epic", x) }, `${x} · ${epic(x)?.title || ""}`)))],
  };
}

function sideDoc(d) {
  const a = artByRel.get(d.id);
  const item = d.item;
  return {
    kind: a?.type || item?.type || "document",
    title: a?.title || item?.title || d.id,
    fields: [kv(["Kind", a?.type || "—"], ["Status", a?.status || item?.status || "—"]), fileLine(d.id)],
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (document.querySelector(".pal-back")) return; // keys.js: Escape closes the palette first, and only it
  if (!$("#modal").hidden) $("#modal").close ? $("#modal").close() : ($("#modal").hidden = true); // a dialog of write.js closes through its own close(), so its onClose runs
  else if (ui.drawer) closeDrawer();
});

// ── start ──
(async () => {
  await fetchState(); // app.js
  await loadArtifacts();
  if (location.hash.length > 2) applyHash();
  else render();
  writeUi.boot(); // write.js: the refresh each time the page opens, then the page from its answer
})();

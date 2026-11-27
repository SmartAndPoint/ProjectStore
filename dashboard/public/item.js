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
// ── pictures and PDFs pasted or dropped, not saved yet (the spec dashboard-attachments) ──
// Kept until a reload, by item and written name (contract 4); base64, as a save sends them.
const PASTED = new Map(); // `${item}\n${name}` → { item, name, alt, type, data, url }
const pastedNamed = (name) => [...PASTED.values()].find((f) => f.name === name) || null;
// The pasted file a vault path names while it is not saved: `<A>/<written name>`.
function pastedAt(path) {
  const dir = S?.attachments;
  return dir && path.startsWith(`${dir}/`) ? pastedNamed(path.slice(dir.length + 1)) : null;
}
// The relative path from a document to a vault path, as a link in its text writes it.
function relFrom(fromRel, path) {
  const here = fromRel.split("/").slice(0, -1);
  const to = path.split("/");
  let k = 0;
  while (k < here.length && k < to.length - 1 && here[k] === to[k]) k++;
  return [...here.slice(k).map(() => ".."), ...to.slice(k)].join("/");
}
const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// The most one save request takes, as the page's server reads it (its BODY_LIMIT).
const SAVE_LIMIT = 16 * 1024 * 1024;

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
      // A PDF pasted and not saved yet shows its name and opens nothing until Save (contract 3).
      const p = pastedAt(path);
      if (p) return { open: () => toast("info", "Not saved yet", `${p.alt || p.name} is kept when the text is saved, and opens after that.`), title: `${p.alt || p.name}: kept at Save` };
      return MD.kindOf(path) !== "file" || /\.pdf$/i.test(path) ? { href: vaultUrl(path) } : null;
    },
    media(url) {
      // The page loads files from itself only: a picture or a video from another site is not shown.
      if (SCHEME.test(url)) return null;
      // A bare name is beside the note, as Obsidian reads it (contract 3).
      const path = vaultPath(rel, url);
      // A picture pasted and not saved yet is drawn from the page's memory.
      const p = pastedAt(path);
      if (p) return p.type === "pdf" ? null : { src: p.url, kind: "image" };
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
  // A new item's panel is no place: a reload ends it, and its kept text is offered again (dashboard-new, contract 2).
  const want = `#/${ui.view}${d && d.kind !== "new" ? `/${d.kind}/${encodeURIComponent(d.id)}` : ""}${q ? `?${q}` : ""}`;
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
  if (d?.kind === "new") return; // no file yet: its template is read once, by openNew
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
  if (ED && ED.host.isConnected && ED.dirty()) toast("info", "Not saved yet", ui.drawer?.kind === "new" ? `Your new ${ui.drawer.st.kind} is kept in this browser. Open New ${ui.drawer.st.kind} again to save it.` : "Your edit is kept in this browser. Open the document again to save it.");
  ui.drawer = null;
  syncHash();
  renderDrawer();
  return true;
}

// ── New in the item panel (the spec dashboard-new) ──
// One new state per kind and preset, until Save or a reload: the side panel's inputs and the editor
// read the same object (contract 2). Its unsaved text and inputs are kept in this browser under
// `new:<kind>:<preset>`, the preset being a story's epic or an epic's initiative (contract 6).
const NEW = new Map();
const newKey = (kind, preset) => `new:${kind}:${(kind === "story" ? preset.epic : kind === "epic" ? preset.initiative : "") || ""}`;
const str = (v) => (typeof v === "string" ? v : "");
// The text and the pictures typed while a new item's Save ran, and the views' note, for the made item's editor.
let CARRY = null;
function openNew(kind, preset = {}) {
  const key = newKey(kind, preset);
  let st = NEW.get(key);
  if (!st) {
    const kept = store.get(draftKeyOf(key), null);
    const was = kept && kept.inputs && typeof kept.inputs === "object" ? kept.inputs : {};
    st = { kind, preset: { ...preset }, key, fields: { title: str(was.title), id: str(was.id), epic: preset.epic || str(was.epic), initiative: preset.initiative || str(was.initiative) }, tpl: null, failed: null, made: false };
    NEW.set(key, st);
  }
  ui.drawer = { kind: "new", id: key, st, item: null, tab: "doc" };
  syncHash();
  renderDrawer();
  if (!st.tpl) askTemplate(st);
  $("#drawer").querySelector?.('[data-focus="new-title"]')?.focus?.();
  return true;
}
// The kind's template, from the core through the server (contract 3), read once per state.
function askTemplate(st) {
  st.failed = null;
  getJson(`/api/template?kind=${st.kind}`)
    .then((j) => (j && typeof j.body === "string" && typeof j.rel === "string" ? (st.tpl = j) : (st.failed = "the server gave no template")))
    .catch((e) => (st.failed = String(e?.message || e)))
    .then(() => ui.drawer?.st === st && renderDrawer());
}
const newItem = (st) => ({ rel: st.tpl.rel, type: st.kind, title: `New ${st.kind}`, fresh: st, edit: { head: "", body: st.tpl.body, hash: "" } });
// What the panel draws for a new item: "editor", or why not (contract 2).
function newMode(st) {
  if (st.made) return "made"; // saved: its file opens once the state is read again (contract 4)
  const entry = S.write?.can ? writeUi.createEntry(st.kind) : null;
  if (!entry) return "cannot-write";
  if (!entry.fields?.text) return "old-server";
  if (st.failed) return "failed";
  if (!st.tpl) return "reading";
  return typeof WSEditor !== "undefined" ? "editor" : "no-editor";
}
const oldServerNote = () => h("div", { class: "ed-draft bad" }, h("b", null, "The server is older than this page. "), "Stop it (Ctrl+C), start it again and reload this page.");
function newNote(st, mode) {
  if (mode === "made") return h("div", { class: "ed-draft" }, h("b", null, "Saved. "), `The ${st.kind} is a draft change now, in ${st.madeRel || "the vault"}. It opens here once the page reads the backlog again; if it does not, reload the page.`);
  if (mode === "reading") return h("div", { class: "faint" }, "reading the template…");
  if (mode === "old-server") return oldServerNote();
  if (mode === "no-editor") return h("div", { class: "ed-draft bad" }, h("b", null, "The editor did not load. "), "Reload this page to write a new item.");
  if (mode === "failed") return h("div", { class: "ed-draft bad" }, h("b", null, `The ${st.kind} template could not be read. `), "Reload this page; until then Save is off. ", h("span", { class: "faint" }, st.failed));
  return h("div", { class: "ed-draft bad" }, h("b", null, "This page cannot write now. "), "A new item is made only while the page can save into your changes.");
}
// The side panel of a new item: the title, an epic's ID, a story's epic, an epic's initiative, and the
// template's fields as text (contract 2). The values live in the state, so a redraw keeps them.
function sideNew(d) {
  const st = d.st;
  if (!st) return null;
  const { kind, fields: f, preset } = st;
  const changed = () => ED && ED.key === st.key && (ED.paint(), ED.keep());
  const field = (name, attrs) => h("input", { class: "new-in", type: "text", value: f[name] || "", "data-focus": `new-${name}`, autocomplete: "off", disabled: st.made, oninput: (e) => ((f[name] = e.target.value), changed()), ...attrs });
  const rows = [];
  if (kind === "epic") rows.push(["Epic ID", field("id", { placeholder: "such as PS-CORE", "aria-label": "The new epic's ID", spellcheck: "false" })]);
  if (kind === "story")
    rows.push(["Epic", preset.epic ? `${preset.epic} · ${epic(preset.epic)?.title || ""}` : [field("epic", { list: "new-epics", placeholder: "the epic's ID", "aria-label": "The epic the story goes in", spellcheck: "false" }), h("datalist", { id: "new-epics" }, (S.epics || []).filter((e) => e.status !== "done").map((e) => h("option", { value: e.id }, `${e.id} · ${e.title}`)))]]);
  if (kind === "epic")
    rows.push(["Initiative", preset.initiative ? S.initiatives.find((i) => i.id === preset.initiative)?.title || preset.initiative : h("select", { class: "new-in", "data-focus": "new-initiative", "aria-label": "The initiative the epic belongs to", disabled: st.made, onchange: (e) => ((f.initiative = e.target.value), changed()) }, h("option", { value: "" }, "none"), S.initiatives.filter((i) => i.stage !== "rejected" && i.stage !== "deferred").map((i) => h("option", { value: i.id, selected: f.initiative === i.id }, i.title)))]);
  const tf = st.tpl?.fields || {};
  if (tf.status) rows.push(["Status", tf.status]);
  if (tf.priority) rows.push(["Priority", chipP(tf.priority)]);
  if (tf.assignee) rows.push(["Assignee", who(tf.assignee)]);
  if (tf.owner) rows.push(["Owner", who(tf.owner)]);
  return {
    kind: `${kind} · new`,
    title: field("title", { class: "new-in new-title", placeholder: `The ${kind}'s title`, "aria-label": `The new ${kind}'s title` }),
    name: f.title.trim() || `New ${kind}`,
    fields: [kv(...rows), h("div", { class: "faint" }, `Save makes the ${kind} with this text. Until then nothing is written.`)],
  };
}

// The text, or Related in full in its place. The new content starts at its top.
function showTab(d, tab) {
  d.tab = tab;
  renderDrawer();
  $("#drawer").scrollTop = 0;
}

// ── the pane ──
// Where a file's unsaved text is kept in this browser (contract 12): per project, vault and file.
const draftKeyOf = (rel) => `draft:${JSON.stringify([S.project.dir, S.vault, rel])}`;
// Why a file the edit verb refuses is not an editor, and whether text not saved for it is kept
// (dashboard-editor, contract 14). The server gives the reason; the page holds no list of statuses.
function refusedNote(item) {
  const key = draftKeyOf(item.rel);
  const draft = store.get(key, null);
  const kept = !!draft && typeof draft.body === "string";
  const reason = String(item.editRefused);
  const note = h("div", { class: "ed-draft" }, h("b", null, "Not edited here. "), reason.charAt(0).toUpperCase() + reason.slice(1));
  if (kept) {
    // Text typed before the edit verb refused the file stays in this browser: shown as text, to copy or to drop.
    const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(draft.body).then(() => toast("ok", "Your text is copied"), () => toast("refused", "The text could not be copied", "Select it and copy it by hand.")) : toast("refused", "The text could not be copied", "Select it and copy it by hand."));
    const drop = () => (store.set(key, null), renderDrawer());
    note.append(
      h(
        "details",
        { class: "ed-kept" },
        h("summary", null, "Your text not saved for it is kept in this browser"),
        h("pre", { class: "ed-kept-text" }, draft.body),
        h("button", { class: "btn", type: "button", onclick: copy }, "Copy"),
        " ",
        h("button", { class: "btn ghost", type: "button", onclick: drop }, "Discard"),
      ),
    );
  }
  return note;
}

// What the drawer draws for an item's text (dashboard-editor, contracts 1, 10 and 14): "editor", "refused"
// (a file the edit verb refuses: its text and why), "old-server" (a story, an epic or an initiative with
// neither `edit` nor `editRefused`, or no `edit-doc`), "no-editor" (the editor's file did not load) or "text".
function textMode(item, tab, write, editorLoaded) {
  if (!item || item.missing || tab !== "doc" || !write?.can) return "text";
  if (typeof item.editRefused === "string") return "refused";
  if (!item.edit && !["story", "epic", "initiative"].includes(item.type)) return "text";
  if (!item.edit || !(write.verbs || []).some((v) => v && v.verb === "edit-doc")) return "old-server";
  return editorLoaded ? "editor" : "no-editor";
}

function renderDrawer() {
  const pane = $("#drawer");
  const d = ui.drawer;
  const project = S?.project?.name || "ProjectStore";
  // The tab says what is open: the item, or the view behind it.
  document.title = `${ui.viewTitle || "Dashboard"} · ${project}`;
  if (!d) return void (pane.hidden = true);
  const side = { story: sideStory, epic: sideEpic, initiative: sideInitiative, doc: sideDoc, new: sideNew }[d.kind] || sideDoc;
  const info = side(d);
  if (!info) return void (pane.hidden = true);
  // A new item (dashboard-new): its template as the editor's item, once it is read.
  const st = d.kind === "new" ? d.st : null;
  if (st) d.item = st.tpl ? newItem(st) : null;
  const item = d.item;
  document.title = `${info.name || info.title} · ${project}`;
  const main = h("div", { class: "item-main" });
  // While the page can write, a file the edit verb takes is the editor itself, as in Obsidian (dashboard-editor):
  // the server says which by `edit`, and why not by `editRefused` (contracts 1 and 14). A server started before
  // the page's code sends a story, an epic or an initiative with neither, or no `edit-doc`: the text is then
  // shown with no editor, and a note says why (contract 10).
  const mode = st ? newMode(st) : textMode(item, d.tab, S.write, typeof WSEditor !== "undefined");
  if (mode === "refused") endRefusedEditor(item);
  const editable = mode === "editor";
  const oldServer = mode === "old-server";
  // The editor's built file did not load (a failed request, a blocked script): said, never silent.
  const noEditor = mode === "no-editor";
  if (st) main.append(editable ? editorFor(d, item) : newNote(st, mode));
  else if (!item) main.append(h("div", { class: "faint" }, "reading…"));
  else if (item.missing) main.append(h("div", { class: "faint" }, "The file could not be read."));
  else if (editable) main.append(editorFor(d, item));
  else
    // fill(), not the native append: append prints a null as the text "null".
    fill(
      main,
      // What belongs to the item stands in the side panel. Its long form opens here, in place of the text.
      d.tab !== "doc" ? h("div", { class: "doc-bar" }, h("button", { class: "tog on", onclick: () => showTab(d, "doc") }, "← Back to the text"), h("b", null, "Related, in full")) : null,
      oldServer ? oldServerNote() : null,
      mode === "refused" ? refusedNote(item) : null,
      noEditor ? h("div", { class: "ed-draft bad" }, h("b", null, "The editor did not load. "), "Reload this page; until then the text is shown with no editor.") : null,
      d.tab === "rel" ? relatedView(d) : MD.render(bodyOf(d, item), docCtx(item.rel)),
    );
  const scroll = pane.scrollTop;
  // An input of a new item's panel keeps the focus and the caret over a redraw (dashboard-new, contract 2).
  const act = document.activeElement;
  const keep = st && act && pane.contains?.(act) && act.getAttribute?.("data-focus") ? [act.getAttribute("data-focus"), act.selectionStart, act.selectionEnd] : null;
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
    h("div", { class: "item-grid" }, main, h("div", { class: "item-side" }, h("div", { class: "side-fields" }, info.fields), item && !item.missing && !st ? relatedSide(d) : null, item && !item.missing ? codeUi.block(d) : null, info.more ? h("div", { class: "side-more" }, info.more) : null)),
  );
  pane.hidden = false;
  pane.scrollTop = scroll;
  if (keep) {
    const el = pane.querySelector?.(`[data-focus="${keep[0]}"]`);
    el?.focus?.();
    if (el && typeof keep[1] === "number") el.setSelectionRange?.(keep[1], keep[2]);
  }
}

// ── the document is the editor (dashboard-editor; CodeMirror, built from dashboard/editor/) ──
// One editor at a time; it outlives a redraw, so a refresh while typing keeps the text.
// Save (⌘S) runs the page's `edit-doc`: one commit in your changes, as a drag is.
// The change marks compare the text with an earlier one: by default the file where your
// changes start (the commit your batch shares with the default branch), so green is what
// this page changed and an edit made in Obsidian meanwhile is not drawn as yours.
let ED = null;
// A file the edit verb refuses since its editor was opened (Get latest brought an accepted ADR): the editor
// ends here, its unsaved text kept once, so a later Discard is not written back by it (contract 14).
function endRefusedEditor(item) {
  if (!ED || ED.rel !== item.rel) return;
  ED.destroy({ quiet: true });
  ED = null;
}
function editorFor(d, item) {
  if (ED && ED.key === (item.fresh ? item.fresh.key : item.rel)) {
    ED.sync(item);
    return ED.host;
  }
  if (ED) ED.destroy();
  ED = makeEditor(item);
  return ED.host;
}
function makeEditor(item) {
  const rel = item.rel;
  // A new item's state (the spec dashboard-new): no file yet, its path the draft's, for its links'
  // depth only. Its unsaved text and its pasted pictures are its own, under its key (`owner`).
  const fresh = item.fresh || null;
  const owner = fresh ? fresh.key : rel;
  // The editor holds the `## ` sections of a file the edit verb takes (a story, an epic, an initiative,
  // a proposed ADR, a draft spec or research note), cut by its own module (scripts/edit-cut.mjs); the
  // rest is kept by gates and verbs.
  const partOf = (it) => it.edit.body;
  let saved = partOf(item); // the text as your changes hold it
  let opened = item.edit?.hash || ""; // the save is refused when the file changed since
  let base = fresh ? "" : null; // where your changes start: asked of POST /api/base, null until it answers; a new item's is empty
  let saving = false;
  const ctx = docCtx(rel);
  // Unsaved text is kept per project, vault and file (contract 12): pages of different projects,
  // started one after another on one port, share this browser's storage, as the viewer's name
  // knows (views.js, meKey). A text kept by 0.30.22 under `draft:<path>` alone is not read, since
  // nothing in it names its project, and not removed, since a 0.30.22 page at this address reads it.
  const draftKey = draftKeyOf(owner);
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
  // One POST to the base route, with `fields` beside `rel` (contract 13's `saves` or `at`).
  async function askBase(fields) {
    try {
      const token = document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
      const res = await fetch(BASE_ROUTE, { method: "POST", headers: { "content-type": "application/json", "x-projectstore-token": token }, body: JSON.stringify({ rel, ...fields }) });
      return { status: res.status, r: await res.json().catch(() => null), err: "" };
    } catch (e) {
      return { status: 0, r: null, err: String(e?.message || e) };
    }
  }
  let asked = 0;
  async function loadBase() {
    loadSaves(); // the file's saves are asked at the same moments (contract 13)
    const n = ++asked;
    const { status, r, err } = await askBase({});
    // While "Check the editor" runs on its own sample text, an answer would replace its earlier text.
    if (n !== asked || !ED || ED.ed !== ed || window.WS_SELFTEST) return;
    if (status === 200 && r?.ok) {
      base = typeof r.base === "string" ? r.base : null;
      showDisk(r.disk);
    } else {
      // Unknown, and said: never drawn as "no changes".
      base = null;
      if (status === 403) diskNote.replaceChildren(h("b", null, "The server was started again. "), "Reload this page to see your changes.");
      else diskNote.replaceChildren(h("b", null, "Your changes cannot be marked. "), r?.error || err || `The server answered ${status}.`);
    }
    applyBase();
  }
  const body = h("div", { class: "ed-body" });
  // Above the text: what the editor does not hold, drawn as it reads (not a story's: its side panel has it).
  const headText = String(item.edit?.head || "").replace(/^\s*# [^\n]*\n?/, "").trim();
  const headBox = headText && !/\/stories\//.test(rel) ? h("div", { class: "ed-head", title: "Kept by gates and verbs: not edited here" }, MD.render(headText, ctx)) : null;
  const since = h("span", null, "since your changes started");
  const saveNote = h("div", { class: "ed-draft ed-disk" }); // a chosen save that gives no marks (contract 13)
  const host = h("div", { class: "ed" }, headBox, tools, changedNote, keepNote, diskNote, saveNote, notice, body, h("div", { class: "ed-note" }, "The text is Markdown, shown as it will read; the marks appear where the cursor is. Green is what you added, red what you removed, ", since, ". Save keeps it in your changes; Publish sends them for review. The title, the field table, the Status log and checked criteria are written by gates and verbs, not here."));
  // ── pictures (the spec dashboard-attachments) ──
  // Kept only where they can be saved (contract 2): the layout names an attachments folder, and
  // this server's save takes files.
  const picturesKept = () => !!S.attachments && !!(fresh ? writeUi.createEntry(fresh.kind) : S.write?.verbs?.find((v) => v && v.verb === "edit-doc"))?.fields?.files;
  const linkOf = (f) => relFrom(rel, `${S.attachments}/${f.name}`);
  // The remembered files whose relative path from this item appears in the text: what a Save sends (contract 4).
  // Of the same bytes pasted into two items, this item's entry is the one sent and forgotten.
  const linkedPasted = (text = ed.text()) => {
    const seen = new Map();
    if (S.attachments)
      for (const f of PASTED.values()) if ((!seen.has(f.name) || f.item === owner) && text.includes(linkOf(f))) seen.set(f.name, f);
    return [...seen.values()];
  };
  const unsaved = () => dirty() || linkedPasted().length > 0;
  // A paste is text when its HTML holds more than a single picture (a table from a spreadsheet or a
  // document carries a picture of itself too) or its plain text is more than the files' own names
  // or the picture's address (contract 2).
  const pasteIsText = (files, plain, html) => {
    const rest = String(html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<head\b[\s\S]*?<\/head>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<meta\b[^>]*>|<\/?(?:html|body)\b[^>]*>/gi, "")
      .trim();
    if (rest && !/^<img\b[^>]*>$/i.test(rest)) return true;
    const src = ((/\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(rest) || [])[1] || "").replace(/&amp;/g, "&");
    // Names in one Unicode form: a file manager may give the name and its text in two.
    const nfc = (s) => String(s || "").normalize("NFC");
    const said = nfc(plain).trim();
    if (!said || (src && said === src)) return false;
    const names = files.map((f) => nfc(f.name)).filter(Boolean);
    return said.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join("\n") !== names.join("\n");
  };
  const refuse = (why) => {
    if (!window.WS_SELFTEST) toast("refused", "Not kept", why);
  };
  // A paste's or a drop's files: false hands a paste back to the editor as text.
  const addFiles = (list, _api, { plain = "", html = "", drop = false } = {}) => {
    const files = [...list];
    if (!drop && pasteIsText(files, plain, html)) return false;
    if (!picturesKept()) {
      const names = files.map((f) => f.name).filter(Boolean).join(", ");
      refuse(`${names ? `${names}: a` : "A"} pasted picture or file is not kept here: ${S.attachments ? "this page's server keeps no files with a save" : "this vault's layout has no attachments folder"}. Put it in your vault folder and link it from the text.`);
      return true;
    }
    // One paste after another, in the order they came; a failed one says so and stops none after it.
    taking = taking.then(() => takeFiles(files)).catch((e) => refuse(`The picture could not be taken: ${e?.message || e}`));
    return true;
  };
  let taking = Promise.resolve();
  // Each file's type, size and name by the core's own module, kept in the page's memory, and a
  // link at the cursor (contract 3). `ED.taking` is the run, for the editor's check to wait on.
  async function takeFiles(files) {
    let A;
    try {
      A = await attachmentModule(); // app.js
    } catch (e) {
      return refuse(`The page could not load the rules for pictures: ${e?.message || e}`);
    }
    const links = [];
    for (const f of files) {
      const label = f.name || "the file";
      let bytes;
      try {
        bytes = new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        refuse(`${label} cannot be read: ${e?.message || e}`);
        continue;
      }
      const type = A.typeOf(bytes);
      if (!type) {
        refuse(A.refusal("type", { file: label }));
        continue;
      }
      if (bytes.length > A.MAX_BYTES) {
        refuse(A.refusal("size", { file: label, size: bytes.length }));
        continue;
      }
      const name = await A.nameOf(bytes);
      const entry = { item: owner, name, alt: (f.name || "picture").replace(/[[\]`\r\n]/g, ""), type, data: toBase64(bytes) };
      entry.url = `data:${MIME[type]};base64,${entry.data}`;
      // The save request with the text and every file it would send, under the server's limit.
      const would = new Map(linkedPasted(`${ed.text()}\n${links.join("\n")}`).map((x) => [x.name, x.data.length + x.name.length + 24]));
      would.set(name, entry.data.length + name.length + 24);
      const size = new TextEncoder().encode(JSON.stringify(ed.text())).length + 400 + [...would.values()].reduce((a, b) => a + b, 0);
      if (size > SAVE_LIMIT) {
        refuse(`${label}: with the text and the other pictures, the save would be ${size} bytes, over the ${SAVE_LIMIT} bytes (16 MiB) one save takes. Save the text first, then paste it.`);
        continue;
      }
      PASTED.set(`${owner}\n${name}`, entry);
      const path = linkOf(entry);
      // Linked already (pasted again after a reload, or twice): only the bytes are kept.
      if (ed.text().includes(path) || links.some((l) => l.includes(path))) continue;
      links.push(`${type === "pdf" ? "" : "!"}[${entry.alt}](${path})`);
    }
    if (links.length) ed.insert(links.join("\n"));
    paint();
    keepDraft();
  }
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
  // A new item's inputs count as unsaved too; once Save made it, nothing of the new state is.
  const typedIn = () => !!fresh && (!!fresh.fields.title.trim() || !!fresh.fields.id.trim() || (!fresh.preset.epic && !!fresh.fields.epic.trim()) || (!fresh.preset.initiative && !!fresh.fields.initiative));
  const dirty = () => (fresh?.made ? false : trim(ed.text()) !== trim(saved) || typedIn());
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
    // The pictures the text links go by their written names, not their bytes (contract 8).
    const pasted = linkedPasted().map((f) => ({ name: f.name, alt: f.alt }));
    const kept = store.set(draftKey, dirty() ? { body: ed.text(), saved, hash: opened, at: Date.now(), ...(fresh ? { inputs: { ...fresh.fields } } : {}), ...(pasted.length ? { pasted } : {}) } : null);
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
    if (saving || window.WS_SELFTEST) return;
    if (fresh) {
      // A new item (dashboard-new, contract 4): Save makes it, once, when its inputs are given.
      if (fresh.made) return;
      const hint = writeUi.newHint(fresh.kind, fresh.fields);
      if (hint) {
        notice.classList.add("bad");
        fill(notice, h("b", null, "Not saved. "), hint);
        return paint();
      }
    } else if (!unsaved()) return;
    // Text kept over a body that changed since (contract 9): refused here, in the page's words, with nothing sent.
    if (stale) {
      notice.classList.add("bad");
      fill(notice, h("b", null, "Not saved. "), "The file changed after you opened it. Copy your text, open the document again and put your change into it.");
      return paint();
    }
    saving = true;
    paint();
    const text = ed.text();
    // Pictures pasted into this item that its text no longer links are forgotten; those pasted into
    // other items stay. The text's own pictures go with it (contract 4).
    for (const [k, f] of PASTED) if (f.item === owner && !text.includes(linkOf(f))) PASTED.delete(k);
    const sending = linkedPasted(text);
    const files = sending.map((f) => ({ name: f.name, data: f.data }));
    // A new item's Save runs its kind's create row with the inputs, the text and its pictures (contract 4).
    const sent = fresh ? writeUi.newFields(fresh.kind, fresh.fields, text, files) : null;
    const a = fresh ? await writeUi.saveNew(fresh.kind, sent) : await writeUi.saveDoc({ path: rel, text, base: opened, ...(files.length ? { files } : {}) });
    saving = false;
    if (a.ok) {
      // Kept by the verb, in the batch now: the page's copies of those bytes go, whichever item they
      // were pasted into; any other answer keeps them for the next Save.
      const kept = new Set(sending.map((f) => f.name));
      for (const [k, f] of PASTED) if (kept.has(f.name)) PASTED.delete(k);
      saved = text;
      if (fresh) {
        // Made: the state is gone, its kept text with it; text typed while Save ran, and the views'
        // note, go to the made item's editor (contracts 4 and 6). Then the made item opens.
        fresh.made = true;
        fresh.madeRel = a.result?.rel || null;
        NEW.delete(fresh.key);
        store.set(draftKey, null);
        const typed = ed.text();
        CARRY = { rel: a.result?.rel || null, typed: trim(typed) !== trim(text) ? typed : null, note: writeUi.viewsNote(a) };
        saved = typed;
        notice.replaceChildren();
        notice.classList.remove("bad");
        paint();
        renderDrawer(); // the panel says it is saved, with no editor to type into, until the made item opens
        return writeUi.finishNew(fresh.kind, a, sent);
      }
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
      // Saved, though the core could not rebuild the derived views in the page's copy (the write
      // path's contract 7): a toast at once, and the same words above the text until the next edit.
      if (a.views_left) {
        if (!window.WS_SELFTEST) toast("info", "Saved", writeUi.viewsNote(a));
        fill(notice, h("b", null, "Saved. "), writeUi.viewsNote(a));
      }
    } else {
      // The reason stays above the text until the next edit, not only in a toast that fades.
      notice.classList.add("bad");
      // The edit verb's refusal of a changed file speaks to a terminal; the page says it in its own words.
      const said = /changed after it was read/.test(a.error || "") ? "The file changed after you opened it. Copy your text, open the document again and put your change into it." : a.error;
      // A new item's refusal in the plain words of New, the core's own under Details (contract 5).
      if (fresh) fill(notice, h("b", null, "Not saved. "), writeUi.createRefusal(fresh.kind, a.error) || a.error || `The ${fresh.kind} could not be made.`);
      else fill(notice, h("b", null, "Not saved. "), said || "The text could not be saved.");
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
    if (fresh) clearInputs();
    showChanged();
    applyBase();
  }
  function clearInputs() {
    Object.assign(fresh.fields, { title: "", id: "", epic: fresh.preset.epic || "", initiative: fresh.preset.initiative || "" });
    renderDrawer();
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
            if (fresh) clearInputs();
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
  let mode = fresh ? "vault" : store.get("diffMode", "vault");
  const count = h("button", { class: "ed-count", type: "button", title: "Go to the next changed part", onclick: () => ed.nextChange() });
  const opt = (v, t) => h("option", { value: v, selected: v === mode }, t);
  // The file's earlier saves (the spec dashboard-editor, contract 13): listed below the three
  // choices; a save's choice is "at:<commit>", and it is not kept in the browser.
  const savesGroup = h("optgroup", { label: "Compare with an earlier save" });
  let saveText = null; // the body at the chosen save, null until it is read
  const baseSel = h(
    "select",
    {
      class: "ed-base",
      title: "What the marks compare the text with",
      onchange: (e) => {
        mode = e.target.value;
        if (mode.startsWith("at:")) return loadSave(mode.slice(3));
        store.set("diffMode", mode);
        applyBase();
      },
    },
    opt("vault", "All your changes"),
    opt("saved", "Changes not saved yet"),
    opt("off", "Changes: off"),
    savesGroup,
  );
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  };
  let savesAsked = 0;
  async function loadSaves() {
    const n = ++savesAsked;
    const { r } = await askBase({ saves: true });
    if (n !== savesAsked || !ED || ED.ed !== ed || window.WS_SELFTEST) return;
    // A read that fails leaves the list and the choice as they were, and says so.
    if (!r?.ok || !Array.isArray(r.saves)) return void (savesGroup.label = "Earlier saves cannot be read now");
    savesGroup.label = "Compare with an earlier save";
    // The chosen save stays chosen while the item is open, listed or not.
    const kept = [...savesGroup.children].find((o) => o.value === mode && !r.saves.some((s) => `at:${s.commit}` === mode));
    fill(
      savesGroup,
      ...r.saves.map((s) => h("option", { value: `at:${s.commit}`, selected: mode === `at:${s.commit}` }, `${when(s.at)} · ${s.who} · ${s.subject.length > 60 ? `${s.subject.slice(0, 59)}…` : s.subject}`)),
      kept || null,
      r.more ? h("option", { disabled: true }, "Older saves are not listed") : null,
    );
  }
  let saveAsked = 0;
  async function loadSave(commit) {
    const n = ++saveAsked;
    if (window.WS_SELFTEST) return; // the check owns the earlier text meanwhile
    saveText = null;
    saveNote.replaceChildren();
    applyBase();
    const { r } = await askBase({ at: commit });
    if (n !== saveAsked || mode !== `at:${commit}` || !ED || ED.ed !== ed || window.WS_SELFTEST) return;
    // Unknown, or not in that save: no marks, and said.
    saveText = r?.ok && r.base ? r.base : null;
    saveNote.replaceChildren(...(saveText === null ? [h("b", null, "No marks. "), r?.ok && r.base === "" ? "The file is not in that save." : "That save cannot be read now."] : []));
    applyBase();
  }
  const isNew = () => mode === "vault" && base !== null && !base.trim();
  // The marks follow the edits as they are made (changes.mjs); setting the earlier text compares
  // the two texts again from scratch, which redraws them by the shortest diff and makes them jump.
  // So it is set only when the earlier text really is another one, not on every save or answer.
  function applyBase() {
    const want = mode.startsWith("at:") ? saveText : mode === "off" ? null : mode === "saved" ? saved : base === null || !base.trim() ? null : base;
    since.textContent = mode.startsWith("at:") ? "since the save you chose" : "since your changes started";
    if (!mode.startsWith("at:")) saveNote.replaceChildren();
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
    // A text that links pictures the page holds is not saved either, though it reads as saved (contract 4).
    const due = dy || linkedPasted().length > 0;
    // A new item's Save is on once its inputs are given, whatever the text (dashboard-new, contract 4).
    const hint = fresh && !fresh.made ? writeUi.newHint(fresh.kind, fresh.fields) : null;
    state.textContent = saving ? "saving…" : fresh ? (fresh.made ? "saved" : hint || "not saved") : due ? "not saved" : "saved";
    state.className = `ed-state${due || (fresh && !fresh.made) ? " dy" : ""}`;
    saveBtn.disabled = fresh ? saving || fresh.made || !!hint : !due || saving;
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
    ...(fresh ? [] : [baseSel]),
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
  // After a new item's Save (dashboard-new, contracts 4 and 6): the text typed meanwhile is offered
  // as this file's unsaved text, and the views' note is said as after an edit.
  if (!fresh && CARRY && CARRY.rel === rel) {
    const c = CARRY;
    CARRY = null;
    if (c.typed) store.set(draftKey, { body: c.typed, saved, hash: opened, at: Date.now() });
    if (c.note) {
      if (!window.WS_SELFTEST) toast("info", "Saved", c.note);
      fill(notice, h("b", null, "Saved. "), c.note);
    }
  }
  // A draft from an earlier visit comes back over the same saved text.
  const draft = store.get(draftKey, null);
  if (draft && typeof draft.body === "string" && trim(draft.body) !== trim(saved)) {
    // A new item has no file to change under it: its kept text is always its own.
    const same = fresh ? true : draft.hash ? draft.hash === opened : trim(draft.saved) === trim(saved);
    if (!same) {
      // Kept over the body it was taken from: its save is refused, and the note says why.
      stale = true;
      if (typeof draft.saved === "string") saved = draft.saved;
      opened = draft.hash || "changed";
      showChanged();
    }
    ed.replaceAll(draft.body);
    const drop = h("button", { class: "link", type: "button", onclick: () => (adopt(latest), paint()) }, "throw it away");
    // The browser keeps no picture over a reload: the ones this page no longer holds are named (contract 8).
    const again = (Array.isArray(draft.pasted) ? draft.pasted : []).filter((p) => p && typeof p.name === "string" && !pastedNamed(p.name));
    const pasteAgain = again.length ? h("div", { class: "ed-again" }, h("b", null, "Paste again before Save: "), again.map((p) => (p.alt ? `${p.alt} (${p.name})` : p.name)).join(", "), ". The page keeps no picture over a reload.") : null;
    fill(notice, h("span", null, `This is your text from ${new Date(draft.at).toLocaleString()}. It is not saved yet. Save it, or `), drop, ".", pasteAgain);
  }
  // The base is asked when the item opens and when its file or the batch moves (a save, Get latest), not on every redraw.
  const baseKeyOf = (it) => `${it.edit?.hash || ""}|${S.write?.batch?.head || ""}|${S.write?.fetched_at || ""}`;
  let baseKey = baseKeyOf(item);
  applyBase();
  if (!fresh) loadBase();
  return {
    rel,
    key: owner, // editorFor: the same file, or the same new item, keeps its editor
    paint,
    keep: keepDraft,
    host,
    ed, // selftest.js reads the editor and whether text is unsaved
    dirty,
    unsaved,
    picturesKept, // selftest.js: whether a pasted picture is kept here
    get taking() {
      return taking; // selftest.js and the page's tests wait on a paste's files
    },
    // The item read again (after a save, a refresh): the saved text and the base follow it;
    // the editor's text changes only when nothing unsaved is in it.
    sync(next) {
      if (window.WS_SELFTEST || fresh) return; // a new item has no file to follow // "Check the editor" owns the text and its earlier text meanwhile
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
    destroy({ quiet = false } = {}) {
      // Leaving a text that is not saved: it is kept in this browser, and the person is told so
      // (quiet when the edit verb now refuses the file: the drawer's note says it, contract 14).
      if (!quiet && dirty() && !window.WS_SELFTEST) toast("info", "Not saved yet", fresh ? `Your new ${fresh.kind} is kept in this browser. Open New ${fresh.kind} again to save it.` : `Your edit of "${item.title || rel}" is kept in this browser. Open it again to save it.`);
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
      writeUi.itemButtons("epic", e.id), // write.js: its initiative
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
      writeUi.itemButtons("initiative", i.id), // write.js: its decision and fields
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

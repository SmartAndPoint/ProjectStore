// The item pane: one work item or document, rendered read-only from its
// Markdown, with its fields and what is related to it beside it. Loaded after
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
}
function closeDrawer() {
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
  if (!item) main.append(h("div", { class: "faint" }, "reading…"));
  else if (item.missing) main.append(h("div", { class: "faint" }, "The file could not be read."));
  else
    main.append(
      h(
        "div",
        { class: "doc-bar" },
        // What belongs to the item stands in the side panel. Its long form opens here, in place of the text.
        d.tab !== "doc" ? h("button", { class: "tog on", onclick: () => showTab(d, "doc") }, "← Back to the text") : null,
        d.tab !== "doc" ? h("b", null, "Related, in full") : null,
        h("span", { class: "ref", title: item.rel }, item.rel),
      ),
      d.tab === "rel" ? relatedView(d) : MD.render(item.body.replace(/^\s*# .*\n/, ""), docCtx(item.rel)),
    );
  const scroll = pane.scrollTop;
  pane.replaceChildren(
    h("div", { class: "item-head" }, h("span", { class: "kind" }, kindIco(info.kind.split(" ")[0]), info.kind), h("span", { class: "grow" }), h("button", { class: "btn ghost", onclick: closeDrawer, "aria-label": "close", title: "Close (Esc)" }, "✕")),
    h("h2", null, info.title),
    // The side panel in three parts. Beside the text they stand in one column; in a narrow pane
    // the fields go above the text and the rest below it, so the text is not pushed out of sight.
    h("div", { class: "item-grid" }, main, h("div", { class: "item-side" }, h("div", { class: "side-fields" }, info.fields), item && !item.missing ? relatedSide(d) : null, info.more ? h("div", { class: "side-more" }, info.more) : null)),
  );
  pane.hidden = false;
  pane.scrollTop = scroll;
}

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
        ["Status", [pill(s), s.ageDays !== null && s.column !== "Done" ? h("span", { class: "faint" }, `  ${s.ageDays} d`) : null]],
        ["Epic", h("button", { class: "link", onclick: () => openDrawer("epic", s.epic) }, s.epic)],
        ["Priority", chipP(s.priority)],
        ["Assignee", who(s.assignee)],
        ["Subtasks", s.subtasks.length ? `${done} of ${s.subtasks.length} done` : "—"],
        ["Ready", h("span", { style: s.ready.ok ? "color:var(--ok)" : "color:var(--warn)" }, s.ready.ok ? "yes" : `needs ${s.ready.missing.join(" and ")}`)],
      ),
    ],
  };
}

function sideEpic(d) {
  const e = epic(d.id);
  if (!e) return null;
  const mine = S.stories.filter((s) => s.epic === e.id).sort((a, b) => cmp(S.coreColumns.indexOf(a.column), S.coreColumns.indexOf(b.column)) || byOrder(a, b));
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
    fields: [kv(["Kind", a?.type || "—"], ["Status", a?.status || item?.status || "—"])],
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (!$("#modal").hidden) $("#modal").hidden = true;
  else if (ui.drawer) closeDrawer();
});

// ── start ──
(async () => {
  await fetchState(); // app.js
  await loadArtifacts();
  if (location.hash.length > 2) applyHash();
  else render();
})();

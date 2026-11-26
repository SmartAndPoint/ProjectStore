// projectstore — the backlog tree's order and its drag (spec "The backlog
// tree's order and its drag: each group drawn by siblingOrder, and a drop or a
// key that runs rank", alias `dashboard-rank`; PS-DASHBOARD: "The backlog tree
// draws each group by rank, and a drag inside a group runs the rank verb").
// The state is read through the page's own reader over a fixture vault; the
// tree is drawn by the page's own app.js in a vm over a small DOM stand-in.
// The drag's geometry and the dialog ran in the built-in browser (the story's
// close records it); here their guards are held by the source. The server's
// `rank` entry is in tests/dashboard-writes.test.mjs ([dashboard-rank#10]).

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCore } from "../dashboard/lib/core.mjs";
import { readState } from "../dashboard/lib/state.mjs";
import { readFlowStories } from "../scripts/flow-stories.mjs";
import { storyGroups, epicGroups, siblingOrder } from "../scripts/rank.mjs";
import { parseFrontmatter } from "../scripts/lib.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(REPO, "dashboard", "public");
const src = (name) => readFileSync(join(PUBLIC, name), "utf8");

// ─── A fixture vault ───────────────────────────────────────────────────

const story = ({ slug, title = slug, status = "planned", priority = "p2", rank, epic }) =>
  `---\ntype: story\n${rank === undefined ? "" : `rank: ${rank}\n`}id: "${slug}"\nepic: "${epic}"\ntitle: "${title}"\nstatus: ${status}\npriority: ${priority}\ncreated: 2026-11-01\n---\n\n# ${title}\n`;
const epicText = ({ id, initiative, rank }) =>
  `---\ntype: epic\nid: "${id}"\ntitle: "${id}"\nstatus: planned\npriority: p2\n${initiative === undefined ? "" : `initiative: "${initiative}"\n`}${rank === undefined ? "" : `rank: ${rank}\n`}created: 2026-11-01\n---\n\n# ${id}\n`;

function fixture() {
  const { proj, vault } = makeVaultProject();
  const put = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  for (const stem of ["faster", "twice-a", "twice-b"])
    put(
      `initiatives/${stem}.md`,
      `---\ntype: initiative\nid: "${stem.startsWith("twice") ? "twice" : stem}"\ntitle: "${stem}"\nstatus: accepted\npriority: p2\n---\n\n# ${stem}\n`,
    );
  put("epics/PS-A/epic.md", epicText({ id: "PS-A", initiative: "faster" }));
  put("epics/PS-B/epic.md", epicText({ id: "PS-B", initiative: "faster", rank: 5 }));
  put("epics/PS-C/epic.md", epicText({ id: "PS-C" }));
  put("epics/PS-D/epic.md", epicText({ id: "PS-D", initiative: "twice" }));
  const stories = [
    { slug: "a", title: "Alpha", status: "todo" },
    { slug: "b", title: "Bravo", status: "review" },
    { slug: "c", title: "Charlie", status: "planned", rank: 5 },
    { slug: "d", title: "Delta", status: "planned", rank: "1.5" },
    { slug: "e", title: "Echo", status: "done" },
    { slug: "f", title: "Foxtrot", status: "deferred" },
  ];
  for (const s of stories) put(`epics/PS-X/stories/${s.slug}.md`, story({ ...s, epic: "PS-X" }));
  put("epics/PS-X/epic.md", epicText({ id: "PS-X", initiative: "faster" }));
  return { proj, vault };
}

// ─── Contract 1: the state carries each group's order ──────────────────

// [dashboard-rank#1]
test("dashboard rank: /api/state's places are siblingOrder's order in every group, and a story in no group has place null", async () => {
  const f = fixture();
  const ctx = await openCore({ core: REPO, project: f.proj });
  const S = readState(ctx);
  const { stories } = readFlowStories(f.vault, "epics");
  for (const [epic, members] of storyGroups(stories)) {
    const want = siblingOrder(members).map((m) => m.rel);
    const got = S.stories
      .filter((s) => s.epic === epic && s.place !== null)
      .sort((a, b) => a.place - b.place)
      .map((s) => s.rel);
    assert.deepEqual(got, want, epic);
  }
  for (const s of S.stories.filter((x) => ["done", "deferred"].includes(x.status))) assert.equal(s.place, null, s.ref);
  const read = (rel) => parseFrontmatter(readFileSync(join(f.vault, rel), "utf8")).data;
  const epics = ["PS-A", "PS-B", "PS-C", "PS-D", "PS-X"].map((id) => ({
    id,
    rel: `epics/${id}/epic.md`,
    fm: read(`epics/${id}/epic.md`),
  }));
  const inits = ["faster", "twice-a", "twice-b"].map((s) => ({
    rel: `initiatives/${s}.md`,
    fm: read(`initiatives/${s}.md`),
  }));
  for (const [group, members] of epicGroups(epics, inits)) {
    const want = siblingOrder(members).map((m) => m.id);
    const got = S.epics
      .filter((e) => e.group === group)
      .sort((a, b) => a.place - b.place)
      .map((e) => e.id);
    assert.deepEqual(got, want, String(group));
  }
  // The state keeps no rank number of its own.
  assert.ok(S.stories.every((s) => !Object.hasOwn(s, "rank")));
});

// [dashboard-rank#1]
test("dashboard rank: rank: 1.5 is unranked on the page, and an epic naming an id two files share has group null (edge)", async () => {
  const f = fixture();
  const S = readState(await openCore({ core: REPO, project: f.proj }));
  assert.equal(S.stories.find((s) => s.ref === "PS-X/d").ranked, false);
  assert.equal(S.stories.find((s) => s.ref === "PS-X/c").ranked, true);
  assert.equal(S.epics.find((e) => e.id === "PS-D").group, null);
  assert.equal(S.epics.find((e) => e.id === "PS-B").ranked, true);
});

// ─── The page's tree, drawn by app.js in a vm ──────────────────────────

class El {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.kids = [];
    this.nodeType = 1;
    this._cls = new Set();
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this._cls].join(" ");
  }
  get classList() {
    return {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      contains: (c) => this._cls.has(c),
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener() {}
  append(...k) {
    this.kids.push(...k);
  }
  all() {
    return this.kids.filter((k) => k && k.nodeType === 1).flatMap((k) => [k, ...k.all()]);
  }
  text() {
    return this.kids.map((k) => (k && k.nodeType === 3 ? k.data : k && k.nodeType === 1 ? k.text() : "")).join("");
  }
}

// app.js in a vm over the state `S`; `canRank` is what write.js would say.
function page(S, { canRank = true } = {}) {
  const dragged = [];
  const ctx = {
    document: { createElement: (t) => new El(t), createTextNode: (t) => ({ nodeType: 3, data: String(t) }) },
    ico: () => new El("i"),
    render() {},
    openDrawer() {},
    writeUi: {
      canRank: () => canRank,
      // New's controls (dashboard-create): none here, this harness draws the order.
      newOnRow: () => null,
      newInToolbar: () => [],
      dragTreeRow: (tr, item) => {
        dragged.push(item);
        tr.setAttribute("data-handle", item.ref);
        return tr;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${src("app.js")}\nglobalThis.__p = { viewBacklog, epicStories, byOrder, setS(v) { S = v; }, ui };`,
    ctx,
    { filename: "app.js" },
  );
  ctx.__p.setS(S);
  ctx.__p.ui.hideDone = false;
  ctx.__p.ui.filter = "";
  const rowsOf = () =>
    ctx.__p
      .viewBacklog()
      .all()
      .filter((e) => e.tag === "tr" && e.attrs["data-key"]);
  return { ...ctx.__p, rowsOf, dragged };
}

const S0 = async (f) => {
  const S = readState(await openCore({ core: REPO, project: f.proj }));
  return { ...S, write: { can: true } };
};
const openAll = (p, S) => {
  for (const i of S.initiatives) p.ui.open.add(`i:${i.id}`);
  p.ui.open.add("i:");
  for (const e of S.epics) p.ui.open.add(`e:${e.id}`);
};
const keys = (rows) => rows.map((r) => r.attrs["data-key"]);

// [dashboard-rank#2]
test("dashboard rank: in an epic the tree draws the done stories, then the open ones by place, then the set-aside ones; a ranked Backlog story stands above an unranked Review one", async () => {
  const f = fixture();
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  const rows = keys(p.rowsOf()).filter((k) => k.startsWith("s:PS-X/"));
  // e done; c ranked (Backlog); then b (Review), a (ToDo), d (Backlog, 1.5 unranked); f set aside.
  assert.deepEqual(rows, ["s:PS-X/e", "s:PS-X/c", "s:PS-X/b", "s:PS-X/a", "s:PS-X/d", "s:PS-X/f"]);
});

// [dashboard-rank#2]
test("dashboard rank: with no rank in the vault the tree is the page's old order: stories by column, Done first, then priority and title; epics by folder name (edge)", async () => {
  const f = fixture();
  for (const rel of ["epics/PS-X/stories/c.md", "epics/PS-B/epic.md"]) {
    const p0 = join(f.vault, rel);
    writeFileSync(p0, readFileSync(p0, "utf8").replace(/^rank: .*\n/m, ""));
  }
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  const CORE = ["Backlog", "ToDo", "In Progress", "Review", "Done"];
  const PRI = ["p0", "p1", "p2", "p3"];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const old = S.stories
    .filter((s) => s.epic === "PS-X")
    .sort(
      (a, b) =>
        cmp(CORE.indexOf(b.column), CORE.indexOf(a.column)) ||
        cmp(PRI.indexOf(a.priority), PRI.indexOf(b.priority)) ||
        cmp(a.title, b.title),
    )
    .map((s) => `s:${s.ref}`);
  assert.deepEqual(
    keys(p.rowsOf()).filter((k) => k.startsWith("s:PS-X/")),
    old,
  );
  const epicsUnderFaster = keys(p.rowsOf())
    .filter((k) => k.startsWith("e:"))
    .slice(0, 3);
  assert.deepEqual(epicsUnderFaster, ["e:PS-A", "e:PS-B", "e:PS-X"]);
});

// [dashboard-rank#2]
test("dashboard rank: an epic naming an initiative id two files share stands under No initiative and under neither initiative (edge)", async () => {
  const f = fixture();
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  const ks = keys(p.rowsOf());
  const none = ks.indexOf("i:");
  assert.ok(none > -1, "a No initiative row");
  assert.equal(ks.filter((k) => k === "e:PS-D").length, 1);
  assert.ok(ks.indexOf("e:PS-D") > none, "PS-D is drawn under No initiative");
  assert.ok(ks.indexOf("e:PS-C") > none);
});

// [dashboard-rank#3]
test("dashboard rank: an epic's own story list is the tree's order, done stories first even with Hide done on", async () => {
  const f = fixture();
  const S = await S0(f);
  const p = page(S);
  p.ui.hideDone = true;
  assert.deepEqual(
    [...p.epicStories("PS-X").map((s) => s.ref)],
    ["PS-X/e", "PS-X/c", "PS-X/b", "PS-X/a", "PS-X/d", "PS-X/f"],
  );
  assert.match(src("item.js"), /const mine = epicStories\(e\.id\);/);
});

// [dashboard-rank#4]
test("dashboard rank: the board, the list and My work order by priority, then title, whatever rank holds; the sort is named Priority and keeps its key order", async () => {
  const f = fixture();
  const p = page(await S0(f));
  const a = { priority: "p1", title: "Alpha", rank: 9 };
  const b = { priority: "p1", title: "Bravo", rank: 1 };
  assert.ok(p.byOrder(a, b) < 0);
  assert.doesNotMatch(src("app.js").match(/const byOrder = [^\n]*/)[0], /rank/);
  assert.match(src("views.js"), /const SORTS = \{ order: "Priority",/);
  assert.match(src("views.js"), /order: byOrder,/);
});

// [dashboard-rank#5]
test("dashboard rank: a page that can write gives a handle to every epic row and open story row, and none to initiatives, done or set-aside stories", async () => {
  const f = fixture();
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  const rows = p.rowsOf();
  const handled = rows.filter((r) => r.attrs["data-handle"]).map((r) => r.attrs["data-key"]);
  for (const k of ["s:PS-X/a", "s:PS-X/b", "s:PS-X/c", "s:PS-X/d", "e:PS-A", "e:PS-B", "e:PS-X", "e:PS-C", "e:PS-D"])
    assert.ok(handled.includes(k), k);
  for (const k of ["s:PS-X/e", "s:PS-X/f", "i:faster", "i:"]) assert.ok(!handled.includes(k), k);
});

// [dashboard-rank#5]
test("dashboard rank: with search text, or a page that cannot write, no row gets a handle (edge)", async () => {
  const f = fixture();
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  p.ui.filter = "Alpha";
  assert.equal(p.dragged.length, 0, "before drawing");
  p.rowsOf();
  assert.equal(p.dragged.length, 0, "search narrows the tree: no handle");
  const q = page(S, { canRank: false });
  openAll(q, S);
  q.rowsOf();
  assert.equal(q.dragged.length, 0, "a page that cannot write: no handle");
  // write.js offers the handle only with the rank entry, and keys only on a drawn handle.
  const w = src("write.js");
  assert.match(w, /function canRank\(\) \{\s*const f = entryOf\("rank"\)\?\.fields;/);
  assert.match(w, /if \(!drawn\) return false;/);
});

// ─── Contracts 6 to 8: the page's own write.js in a vm ─────────────────

// A tree row of the stand-in DOM: its data, a height of 10, and classes.
class Row {
  constructor(data, y) {
    this.dataset = { ...data };
    this.cls = new Set();
    this.y = y;
    this.listeners = {};
    this.nodeType = 1;
    this.classList = {
      add: (...c) => c.forEach((x) => this.cls.add(x)),
      remove: (...c) => c.forEach((x) => this.cls.delete(x)),
      contains: (c) => this.cls.has(c),
    };
  }
  getBoundingClientRect() {
    return { top: this.y, bottom: this.y + 10 };
  }
  closest() {
    return this;
  }
  querySelector() {
    return { prepend() {} };
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
}
// An element h() makes: its kids are kept, so a test reads the texts drawn.
class Made {
  constructor(tag, attrs, kids) {
    this.tag = tag;
    this.attrs = attrs || {};
    this.kids = kids.flat(Infinity);
    this.listeners = {};
    this.removed = false;
    this.nodeType = 1;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  remove() {
    this.removed = true;
  }
  prepend() {}
  replaceChildren() {}
  contains() {
    return true;
  }
  get text() {
    return this.kids.map((k) => (typeof k === "string" ? k : k && k.text ? k.text : "")).join("");
  }
}
const anything = () =>
  new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : anything()),
    apply: () => anything(),
    set: () => true,
  });

// The tree the tests drag in: initiative I with epics PS-A (unfolded: a done
// story d, open a1 and a2, a set-aside z), PS-B and PS-C; initiative J with PS-E.
function world({
  preview = { ok: true, result: { changes: [{ path: "x.md", from: null, to: "1048576" }] } },
  action = { ok: true, result: { written: ["x.md"] } },
  slow = false,
  loadFails = false,
} = {}) {
  const rows = [
    new Row({ key: "e:PS-A", epic: "PS-A", group: "I" }, 0),
    new Row({ key: "s:PS-A/d", epic: "PS-A", group: "I", story: "PS-A/d" }, 10),
    new Row({ key: "s:PS-A/a1", epic: "PS-A", group: "I", story: "PS-A/a1" }, 20),
    new Row({ key: "s:PS-A/a2", epic: "PS-A", group: "I", story: "PS-A/a2" }, 30),
    new Row({ key: "s:PS-A/z", epic: "PS-A", group: "I", story: "PS-A/z" }, 40),
    new Row({ key: "e:PS-B", epic: "PS-B", group: "I" }, 50),
    new Row({ key: "e:PS-C", epic: "PS-C", group: "I" }, 60),
    new Row({ key: "e:PS-E", epic: "PS-E", group: "J" }, 70),
  ];
  const S = {
    project: { name: "p" },
    write: {
      can: true,
      batch: null,
      verbs: [
        {
          verb: "rank",
          label: "Reorder",
          fields: { story: {}, epic: {}, before: {}, after: {} },
          subject: [
            "rank {story} before {before}",
            "rank {story} after {after}",
            "rank {epic} before {before}",
            "rank {epic} after {after}",
          ],
        },
      ],
    },
    stories: [
      { ref: "PS-A/d", epic: "PS-A", column: "Done", place: null, title: "D" },
      { ref: "PS-A/a1", epic: "PS-A", column: "ToDo", place: 0, title: "A1" },
      { ref: "PS-A/a2", epic: "PS-A", column: "ToDo", place: 1, title: "A2" },
      { ref: "PS-A/z", epic: "PS-A", column: null, place: null, title: "Z" },
    ],
    epics: [
      { id: "PS-A", title: "A", group: "I", place: 0 },
      { id: "PS-B", title: "B", group: "I", place: 1 },
      { id: "PS-C", title: "C", group: "I", place: 2 },
      { id: "PS-E", title: "E", group: "J", place: 0 },
    ],
  };
  const docListeners = {};
  const loads = { n: 0 };
  const posts = [];
  const made = [];
  const document = {
    addEventListener: (type, fn) => (docListeners[type] ||= []).push(fn),
    querySelectorAll: (sel) =>
      sel === "table.tree tr[data-story]"
        ? rows.filter((r) => r.dataset.story)
        : sel === "table.tree tr[data-epic]"
          ? rows.filter((r) => r.dataset.epic)
          : sel === "table.tree tr.can-rank"
            ? rows.filter((r) => r.cls.has("can-rank"))
            : rows.filter((r) => r.cls.has("drop-line-before") || r.cls.has("drop-line-after")),
    querySelector: () => null,
    body: { classList: { add() {}, remove() {} } },
    activeElement: null,
  };
  let release = null;
  const ctx = {
    document,
    S,
    ui: { filter: "" },
    h: (tag, attrs, ...kids) => {
      const el = new Made(tag, attrs, kids);
      made.push(el);
      return el;
    },
    $: () => anything(),
    render() {},
    fill() {},
    kv: (...pairs) => new Made("div", null, pairs.filter(Boolean).flat()),
    load: async () => {
      loads.n++;
      if (loadFails) throw new Error("the state could not be read");
    },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      posts.push({ url, ...body });
      if (slow && url === "/api/preview") await new Promise((r) => (release = r));
      const a = url === "/api/preview" ? preview : action;
      return { status: a.ok ? 200 : 400, json: async () => ({ ...a, write: S.write }) };
    },
    setTimeout,
    Promise,
    Element: Row,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src("write.js")}\nglobalThis.writeUi = writeUi;`, ctx, { filename: "write.js" });
  const texts = () => made.map((m) => m.text).join("\n");
  const rowOf = (key) => rows.find((r) => r.dataset.key === key);
  const itemOf = (key) => {
    const [k, ref] = [key[0], key.slice(2)];
    if (k === "s") return { kind: "story", ref, title: ref, epic: ref.split("/")[0] };
    return { kind: "epic", ref, title: ref, group: rowOf(key).dataset.group };
  };
  // Every member row gets its handle, as app.js asks.
  for (const key of ["e:PS-A", "e:PS-B", "e:PS-C", "e:PS-E", "s:PS-A/a1", "s:PS-A/a2"]) {
    const before = made.length;
    ctx.writeUi.dragTreeRow(rowOf(key), itemOf(key));
    rowOf(key).grip = made.slice(before).find((m) => m.attrs.class === "grip");
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));
  // Drag the row `from` over the row `over` at height `y`, drop, and end.
  async function drag(from, over, y) {
    for (const r of rows) (r.cls.delete("drop-line-before"), r.cls.delete("drop-line-after"));
    const grip = rowOf(from).grip;
    grip.listeners.dragstart[0]({ dataTransfer: { setData() {}, setDragImage() {} } });
    let accepted = false;
    docListeners.dragover[0]({
      target: rowOf(over),
      clientY: y,
      preventDefault: () => (accepted = true),
      dataTransfer: {},
    });
    const line = rows
      .filter((r) => r.cls.has("drop-line-before") || r.cls.has("drop-line-after"))
      .map((r) => `${[...r.cls].find((c) => c.startsWith("drop-line"))}:${r.dataset.key}`);
    if (accepted) docListeners.drop[0]({ preventDefault() {} });
    await settle();
    grip.listeners.dragend[0]();
    await settle();
    return { accepted, line, previews: posts.filter((p) => p.url === "/api/preview").map((p) => p.fields) };
  }
  return { ctx, S, posts, made, loads, texts, drag, settle, release: () => release && release() };
}

// [dashboard-rank#6]
test("dashboard rank: an epic over the lower half of an unfolded epic's block asks for before the next epic; over its upper half, for before it", async () => {
  const w = world();
  const low = await w.drag("e:PS-C", "s:PS-A/z", 45);
  assert.deepEqual(low.line, ["drop-line-before:e:PS-B"]);
  assert.deepEqual(low.previews, [{ epic: "PS-C", before: "PS-B" }]);
  const v = world();
  const high = await v.drag("e:PS-C", "s:PS-A/a1", 22);
  assert.deepEqual(high.previews, [{ epic: "PS-C", before: "PS-A" }]);
});

// [dashboard-rank#6]
test("dashboard rank: a story over a done row asks for before the first open story, over a set-aside row for after the last, and at its own place for nothing (edge)", async () => {
  const w = world();
  assert.deepEqual((await w.drag("s:PS-A/a2", "s:PS-A/d", 12)).previews, [{ story: "PS-A/a2", before: "PS-A/a1" }]);
  const v = world();
  assert.deepEqual((await v.drag("s:PS-A/a1", "s:PS-A/z", 42)).previews, [{ story: "PS-A/a1", after: "PS-A/a2" }]);
  const u = world();
  const own = await u.drag("s:PS-A/a1", "s:PS-A/d", 12);
  assert.equal(own.accepted, true);
  assert.deepEqual(own.previews, [], "the gap above its own row: no request");
  const x = world();
  assert.deepEqual((await x.drag("e:PS-A", "e:PS-A", 2)).previews, []);
});

// [dashboard-rank#6]
test("dashboard rank: the dialog shows the plan's file count and its click runs the action with the same fields; a refused action leaves no button that runs it again (failure)", async () => {
  const w = world({
    preview: {
      ok: true,
      result: {
        changes: [
          { path: "a.md", from: null, to: "1048576" },
          { path: "b.md", from: null, to: "2097152" },
        ],
      },
    },
    action: { ok: false, error: "rank: epics/PS-A/stories/a2.md: its rank is now 9, not none as the plan read it" },
  });
  await w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  assert.match(w.texts(), /2 files to write\./);
  assert.match(w.texts(), /this also sets the place of 1 other story/);
  assert.equal(w.posts.filter((p) => p.url === "/api/action").length, 0, "no action before the confirmation's button");
  const primary = w.made.find((m) => m.tag === "button" && m.text === "Reorder");
  assert.ok(primary, "the dialog's button reads the entry's label");
  primary.listeners.click[0]();
  await w.settle();
  const actions = w.posts.filter((p) => p.url === "/api/action");
  assert.deepEqual(
    actions.map((a) => a.fields),
    [{ story: "PS-A/a2", before: "PS-A/a1" }],
  );
  assert.equal(primary.removed, true);
  assert.match(w.texts(), /its rank is now 9/);
});

// [dashboard-rank#6]
test("dashboard rank: a refused preview opens no dialog and shows its error; a plan with no change says the row is already in place (failure)", async () => {
  const w = world({ preview: { ok: false, error: "rank: PS-A/a2 is not open" } });
  await w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  assert.doesNotMatch(w.texts(), /files? to write\./);
  assert.match(w.texts(), /is not open/);
  const v = world({ preview: { ok: true, result: { changes: [] } } });
  await v.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  assert.doesNotMatch(v.texts(), /files? to write\./);
  assert.match(v.texts(), /already in that place/);
});

// [dashboard-rank#6] as amended 2026-11-20 and [dashboard-writes#10] as amended: a one-file plan is the action at once, with no dialog.
test("dashboard rank: a drop whose plan writes one file draws the row at its new place before any answer, then runs the action with the same fields and opens no dialog", async () => {
  const w = world({ slow: true });
  const ended = w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  await w.settle();
  const places = Object.fromEntries(w.S.stories.filter((s) => s.place !== null).map((s) => [s.ref, s.place]));
  assert.deepEqual(places, { "PS-A/a2": 0, "PS-A/a1": 1 }, "the row stands first while the plan is asked");
  w.release();
  await ended;
  await w.settle();
  assert.deepEqual(
    w.posts.map((p) => [p.url, p.fields]),
    [
      ["/api/preview", { story: "PS-A/a2", before: "PS-A/a1" }],
      ["/api/action", { story: "PS-A/a2", before: "PS-A/a1" }],
    ],
  );
  assert.ok(!w.made.some((m) => m.tag === "button" && m.text === "Reorder"), "no dialog");
  assert.ok(w.loads.n >= 1, "the state is read again after the action");
});

// [dashboard-rank#6] as amended 2026-11-20 (failure).
test("dashboard rank: an action refused after a one-file plan opens no dialog, shows the core's line as a note, and reads the state again so the tree is as before (failure)", async () => {
  const w = world({ action: { ok: false, error: "rank: epics/PS-A/stories/a2.md: its rank is now 9" } });
  await w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  await w.settle();
  assert.equal(w.posts.filter((p) => p.url === "/api/action").length, 1);
  assert.ok(!w.made.some((m) => m.tag === "button" && m.text === "Reorder"), "no dialog");
  assert.match(w.texts(), /its rank is now 9/);
  assert.ok(w.loads.n >= 1, "the state is read again, which puts the row back");
  const v = world({ preview: { ok: false, error: "rank: PS-A/a2 is not open" } });
  await v.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  assert.equal(v.posts.filter((p) => p.url === "/api/action").length, 0);
  assert.ok(v.loads.n >= 1, "a refused plan puts the row back too");
});

// [dashboard-rank#11]
test("dashboard rank: a drop while a reorder is still being saved draws nothing, asks nothing, and the note says the last move is still being saved", async () => {
  const w = world({ slow: true });
  const first = w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  await w.settle();
  const places = () => w.S.epics.map((e) => [e.id, e.place]);
  const was = places();
  await w.drag("e:PS-C", "e:PS-A", 2);
  assert.deepEqual(places(), was, "the second drop moved no row");
  assert.equal(w.posts.length, 1, "only the first plan was asked");
  assert.match(w.texts(), /The last move is still being saved/);
  w.release();
  await first;
});

// [dashboard-rank#11]
test("dashboard rank: a refused action puts the group's places back as they were before the drop, then reads the state again (failure)", async () => {
  const w = world({ action: { ok: false, error: "rank: the clone moved" } });
  const was = w.S.stories.map((s) => [s.ref, s.place]);
  await w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  await w.settle();
  assert.deepEqual(
    w.S.stories.map((s) => [s.ref, s.place]),
    was,
  );
  assert.match(w.texts(), /could not be saved, so the row went back/);
  assert.ok(
    w.made.some((m) => m.tag === "details" && m.text.includes("the clone moved")),
    "the core's line stands under Details",
  );
  assert.ok(w.loads.n >= 1);
});

// [dashboard-rank#11]
test("dashboard rank: a refused action and a read of the state that fails leave the tree as before the drop, and the note says to reload (failure)", async () => {
  const w = world({ action: { ok: false, error: "rank: the clone moved" }, loadFails: true });
  const was = w.S.stories.map((s) => [s.ref, s.place]);
  await w.drag("s:PS-A/a2", "s:PS-A/a1", 21);
  await w.settle();
  assert.deepEqual(
    w.S.stories.map((s) => [s.ref, s.place]),
    was,
  );
  assert.match(w.texts(), /Reload the page/);
});

// [dashboard-rank#7]
test("dashboard rank: a story over another epic's row, or an epic over another initiative's, draws no line, sends nothing, and the note says why", async () => {
  const w = world();
  const s = await w.drag("s:PS-A/a2", "e:PS-B", 52);
  assert.equal(s.accepted, false);
  assert.deepEqual(s.line, []);
  assert.equal(w.posts.length, 0);
  assert.match(w.texts(), /moves only among the open stories of its own epic, PS-A/);
  const v = world();
  const e = await v.drag("e:PS-C", "e:PS-E", 72);
  assert.equal(e.accepted, false);
  assert.equal(v.posts.length, 0);
  assert.match(v.texts(), /open the epic and set its initiative there/); // [dashboard-initiative#2]
});

// [dashboard-rank#8]
test("dashboard rank: Alt+Up on the second open story asks for before the first; on the first it asks nothing; a second key while the plan is asked sends nothing", async () => {
  const w = world({ slow: true });
  assert.equal(
    w.ctx.writeUi.rankKey("s:PS-A/a1", -1),
    true,
    "the first member: the key is the row's, and nothing is asked",
  );
  assert.equal(w.posts.length, 0);
  w.ctx.writeUi.rankKey("s:PS-A/a2", -1);
  w.ctx.writeUi.rankKey("s:PS-A/a2", -1);
  await w.settle();
  assert.deepEqual(
    w.posts.map((p) => p.fields),
    [{ story: "PS-A/a2", before: "PS-A/a1" }],
  );
  w.release();
  await w.settle();
  assert.equal(w.ctx.writeUi.rankKey("e:PS-B", 1), true);
  await w.settle();
  assert.deepEqual(w.posts.at(-1).fields, { epic: "PS-B", after: "PS-C" });
});

// [dashboard-rank#8]
test("dashboard rank: keys.js routes Alt+ArrowUp and Alt+ArrowDown, Alt alone, outside fields, dialogs and the palette, only in the backlog view", () => {
  const k = src("keys.js");
  assert.match(
    k,
    /e\.altKey && !mod && !e\.shiftKey && \(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\) && !typing && !pal && \$\("#modal"\)\.hidden && S && ui\.view === "backlog"/,
  );
  assert.match(k, /if \(writeUi\.rankKey\(ui\.sel, e\.key === "ArrowUp" \? -1 : 1\)\) e\.preventDefault\(\);/);
  assert.match(k, /move the selected epic or open story above or below its neighbour/);
});

// [dashboard-rank#10]
test("dashboard rank: the page and the server check an id by the same two shapes", async () => {
  const w = src("write.js");
  const { EPIC_REF } = await import("../dashboard/lib/write.mjs");
  const server = readFileSync(join(REPO, "dashboard", "lib", "write.mjs"), "utf8");
  const storyServer = server.match(/const STORY_REF = (\/.*\/u);/)[1];
  assert.ok(w.includes(`const STORY_REF = ${storyServer};`), "STORY_REF");
  assert.ok(w.includes(`const EPIC_REF = /${EPIC_REF.source}/u;`), "EPIC_REF");
});

// [dashboard-rank#9]
test("dashboard rank: only a ranked epic row or open story row carries the mark; a done story with a rank does not", async () => {
  const f = fixture();
  writeFileSync(
    join(f.vault, "epics/PS-X/stories/e.md"),
    story({ slug: "e", title: "Echo", status: "done", rank: 3, epic: "PS-X" }),
  );
  const S = await S0(f);
  const p = page(S);
  openAll(p, S);
  const marked = p
    .rowsOf()
    .filter((r) => r.all().some((x) => x.className === "rank-mark" || x.attrs.class === "rank-mark"))
    .map((r) => r.attrs["data-key"]);
  assert.deepEqual(marked.sort(), ["e:PS-B", "s:PS-X/c"]);
});

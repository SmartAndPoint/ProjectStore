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

// ─── Contracts 6 to 8: the drop and the keys, held by write.js and keys.js ───

// [dashboard-rank#6]
test("dashboard rank: a drop at the row's own place sends nothing; a drop or key while a step runs asks for nothing; a plan with no change opens no dialog", () => {
  const w = src("write.js");
  assert.match(w, /if \(gap === idx \|\| gap === idx \+ 1\) return null;/);
  assert.match(w, /if \(place && !busy\) openRank\(item, place\);/);
  assert.match(w, /if \(at === -1 \|\| !next \|\| busy\) return true;/);
  assert.match(
    w,
    /if \(!changes\.length\) return say\("ok", `\$\{item\.title\} is already in that place: nothing to write\.`\);/,
  );
  assert.match(w, /if \(!a\.ok\) return say\("error", a\.error\);/);
});

// [dashboard-rank#6]
test("dashboard rank: the dialog counts the files, and a refused action keeps it open with no button that runs it again (failure)", () => {
  const w = src("write.js");
  assert.match(w, /`\$\{plural\(changes\.length, "file"\)\} to write\./);
  assert.match(w, /primary\.remove\(\);/);
  assert.match(w, /one commit of \$\{plural\(files, "file"\)\}/);
});

// [dashboard-rank#7]
test("dashboard rank: a drop outside the group draws no line, sends nothing and says why, naming the story's epic or epic --initiative", () => {
  const w = src("write.js");
  assert.match(w, /if \(gap === null\) \{\s*treeDrag\.foreign = Boolean\(tr\);\s*clearLine\(\);\s*return;/);
  assert.match(w, /if \(d && !d\.dropped && d\.foreign\) say\("warn", elsewhere\(d\.item\)\);/);
  assert.match(w, /A story moves only among the open stories of its own epic/);
  assert.match(w, /`epic <EPIC-ID> --initiative <id>` changes its initiative/);
});

// [dashboard-rank#8]
test("dashboard rank: Alt+ArrowUp and Alt+ArrowDown, Alt alone, outside fields, dialogs and the palette, only in the backlog view, take the key from the browser", () => {
  const k = src("keys.js");
  assert.match(
    k,
    /if \(e\.altKey && !mod && !e\.shiftKey && \(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\) && !typing && !pal && \$\("#modal"\)\.hidden && S && ui\.view === "backlog"\) \{\s*if \(writeUi\.rankKey\(ui\.sel, e\.key === "ArrowUp" \? -1 : 1\)\) e\.preventDefault\(\);/,
  );
  assert.match(k, /move the selected epic or open story above or below its neighbour/);
  assert.match(src("write.js"), /openRank\(item, dir < 0 \? \{ before: next \} : \{ after: next \}\);/);
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

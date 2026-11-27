// projectstore — tests/dashboard-create.test.mjs: New on the backlog tree
// (PS-DASHBOARD, "New on the backlog tree makes an initiative, an epic or a
// story through the create verb and opens it in the editor"; the spec "The
// page's New: an initiative, an epic or a story made by the create verb from
// the backlog tree, then opened in its editor", alias `dashboard-create`).
//
// Contracts 1 and 2 run the write module over a world of
// tests/fixtures/dashboard-world.mjs (a bare `origin`, a vault cloned from it,
// a project bound to it, HOME and git's configuration inside the world), and
// read the spawn record for "no call" and the argv. Contracts 3 and 5 load the
// page's write.js in a `vm` context with a stub document, and read what it
// draws and what it posts. Since New opens the item panel (the spec
// dashboard-new), the dialog of contract 4 is gone: the rules the panel's Save
// asks of write.js (+ New, the hints, the request, the step after Save) are
// tested here, the panel itself in tests/dashboard-page.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { hermeticGit, makeWorld, REPO } from "./fixtures/dashboard-world.mjs";
import { WRITE_VERBS, checkRequest, positionalsOf, subjectOf } from "../dashboard/lib/write.mjs";
import { loadHarnesses } from "../scripts/harness.mjs";
import { derivedViewPaths, loadLayout, stateDir } from "../scripts/lib.mjs";

hermeticGit();

async function withWorld(opts, fn) {
  const w = await makeWorld(opts);
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
  }
}
async function writable(w, opts) {
  const writer = await w.open(opts);
  const r = await writer.refresh();
  assert.equal(r.body.write.can, true, r.body.write.reason);
  return writer;
}
const cliCalls = (w, from) => w.record.slice(from).filter((e) => e.cmd === process.execPath && e.argv[1] === "create");
const headOf = (w, clone) => w.git(clone, "rev-parse", "HEAD");
const porcelain = (w, clone) => w.git(clone, "status", "--porcelain", "--untracked-files=all");
const batchBranches = (w, clone) => w.git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/dashboard/");
const committedFiles = (w, clone, rev = "HEAD") =>
  w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort();
const subjectAt = (w, clone, rev = "HEAD") => w.git(clone, "log", "-1", "--format=%s", rev);
const cloneState = (w, clone) => ({ head: headOf(w, clone), status: porcelain(w, clone) });
// Every file under `dir`, hashed, names in `skip` left out at any depth.
function treeHash(dir, skip = new Set()) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`${p}\0link\0`);
      else if (st.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}
// The paths of derivedViewPaths for the engineering layout, as a set.
const VIEWS = (() => {
  const v = derivedViewPaths(loadLayout("engineering"));
  return new Set([v.board, v.codeMap, v.graph, v.flow, v.specTree, ...v.indexes.map((x) => x.path)].filter(Boolean));
})();
const story = (fields = {}) => ({ verb: "create-story", fields: { epic: "PS-X", title: "Faster login", ...fields } });
const epic = (fields = {}) => ({ verb: "create-epic", fields: { epic: "PS-NEW", title: "Onboarding", ...fields } });
const initiative = (fields = {}) => ({ verb: "create-initiative", fields: { title: "Faster onboarding", ...fields } });

// ─── Contract 1: the three rows of the table ─────────────────────────────

// [dashboard-create#1]
test("dashboard create: the three entries are labelled, run create with the kind's word first, and fill one of its forms", () => {
  const by = Object.fromEntries(WRITE_VERBS.map((v) => [v.verb, v]));
  assert.equal(by["create-initiative"].label, "Create initiative");
  assert.equal(by["create-epic"].label, "Create epic");
  assert.equal(by["create-story"].label, "Create story");
  // [dashboard-new#7] Each create row also takes the editor's text and its pictures.
  assert.deepEqual(Object.keys(by["create-initiative"].fields), ["title", "text", "files"]);
  assert.deepEqual(Object.keys(by["create-epic"].fields), ["epic", "title", "initiative", "text", "files"]);
  assert.deepEqual(Object.keys(by["create-story"].fields), ["epic", "title", "text", "files"]);
  assert.equal(by["create-epic"].fields.initiative.optional, true);
  for (const v of ["create-initiative", "create-epic", "create-story"]) assert.equal(by[v].fields.title.max, 200);
  const ok = (req) => {
    const c = checkRequest(req);
    assert.equal(c.ok, true, c.error);
    return c;
  };
  assert.deepEqual(positionalsOf(ok(story())), ["story", "PS-X", "Faster login"]);
  assert.deepEqual(positionalsOf(ok(epic())), ["epic", "PS-NEW", "Onboarding"]);
  assert.deepEqual(positionalsOf(ok(initiative())), ["initiative", "Faster onboarding"]);
  assert.equal(subjectOf(ok(story())), "create story in PS-X: Faster login");
  assert.equal(subjectOf(ok(epic())), "create epic PS-NEW: Onboarding");
  assert.equal(
    subjectOf(ok(epic({ initiative: "faster-onboarding" }))),
    "create epic PS-NEW in faster-onboarding: Onboarding",
  );
  assert.equal(subjectOf(ok(initiative())), "create initiative Faster onboarding");
});

// [dashboard-create#1]
test("dashboard create: a title that is empty, only spaces, holds a line break or a tab, or is 201 characters, an epic id outside the folder rule, and an initiative on a story are refused before any process", () => {
  const bad = [
    story({ title: "" }),
    story({ title: "   " }),
    story({ title: "a\nb" }),
    story({ title: "a\tb" }),
    story({ title: "x".repeat(201) }),
    initiative({ title: "y".repeat(201) }),
    epic({ epic: "A B" }),
    epic({ epic: ".hidden" }),
    epic({ epic: "../X" }),
    epic({ initiative: "a b" }),
    story({ epic: "" }),
    { verb: "create-story", fields: { epic: "PS-X", title: "T", initiative: "i" } },
    { verb: "create-epic", fields: { title: "T" } },
  ];
  for (const req of bad) assert.equal(checkRequest(req).ok, false, JSON.stringify(req));
  assert.match(checkRequest(story({ title: "x".repeat(201) })).error, /201 characters long; it takes at most 200/);
  assert.match(checkRequest(story({ title: "  " })).error, /^title is empty$/);
  // 200 characters, counted in code points after the trim, pass.
  assert.equal(checkRequest(story({ title: ` ${"ё".repeat(200)} ` })).ok, true);
});

// [dashboard-create#1]
test("dashboard create: a story's preview runs `create --json -- story <EPIC> <title>` and answers its plan, with the clone unchanged; a 400 starts no process", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = cloneState(w, clone);
    let from = w.record.length;
    const r = await writer.preview(story());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const { result } = r.body;
    assert.equal(result.kind, "story");
    assert.equal(result.rel, "epics/PS-X/stories/story-faster-login.md");
    assert.equal(result.path, join(w.vault, result.rel), "the path in the bound vault");
    assert.match(String(result.row), /story-faster-login\.md/);
    assert.equal(result.write, false);
    assert.deepEqual(cloneState(w, clone), before, "HEAD and the working tree are unchanged");
    const [call] = cliCalls(w, from);
    assert.ok(call, "create ran");
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--")), ["--", "story", "PS-X", "Faster login"]);
    assert.ok(call.argv.includes("--json"));
    assert.ok(!call.argv.includes("--write"), "a preview plans");
    // A title that starts with - is the title.
    const dash = await writer.preview(story({ title: "-x title" }));
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    assert.equal(dash.body.result.rel, "epics/PS-X/stories/story-x-title.md");
    // A 400: no process.
    from = w.record.length;
    for (const req of [story({ title: "a\nb" }), epic({ epic: "A B" }), story({ title: "z".repeat(201) })]) {
      const bad = await writer.preview(req);
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      const act = await writer.action(req);
      assert.equal(act.status, 400, JSON.stringify(act.body));
    }
    assert.deepEqual(cliCalls(w, from), [], "no call");
  });
});

// ─── Contract 2: a create is one commit with the new file ────────────────

// [dashboard-create#2]
test("dashboard create: a story is one commit of the story and its epic.md, with create's subject and the mark, and no derived view", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const r = await writer.action(story());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.rel, "epics/PS-X/stories/story-faster-login.md");
    assert.equal(r.body.write.batch.commits, 1);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-X/epic.md", "epics/PS-X/stories/story-faster-login.md"]);
    assert.equal(subjectAt(w, clone), "create story in PS-X: Faster login");
    const text = w.git(clone, "show", "HEAD:epics/PS-X/stories/story-faster-login.md");
    assert.match(text, /^written_by_verb: "create /m);
    assert.match(w.git(clone, "show", "HEAD:epics/PS-X/epic.md"), /story-faster-login\.md/);
    for (const f of committedFiles(w, clone)) assert.ok(!VIEWS.has(f), `${f} is no derived view`);
    assert.equal(porcelain(w, clone), "", "the clone is clean after the action");
  });
});

// [dashboard-create#2]
test("dashboard create: an initiative, then an epic in it and an epic with none, are one commit each; the epic names its initiative", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const i = await writer.action(initiative());
    assert.equal(i.status, 200, JSON.stringify(i.body));
    assert.equal(i.body.ok, true, i.body.error);
    assert.equal(i.body.result.index, null, "an initiative has no index row");
    assert.deepEqual(committedFiles(w, clone), ["initiatives/faster-onboarding.md"]);
    assert.equal(subjectAt(w, clone), "create initiative Faster onboarding");

    const e = await writer.action(epic({ initiative: "faster-onboarding" }));
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.ok, true, e.body.error);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-NEW/epic.md"]);
    assert.equal(subjectAt(w, clone), "create epic PS-NEW in faster-onboarding: Onboarding");
    assert.match(w.git(clone, "show", "HEAD:epics/PS-NEW/epic.md"), /^initiative: "?faster-onboarding"?$/m);

    const loose = await writer.action(epic({ epic: "PS-LOOSE", title: "Loose" }));
    assert.equal(loose.body.ok, true, loose.body.error);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-LOOSE/epic.md"]);
    assert.equal(subjectAt(w, clone), "create epic PS-LOOSE: Loose");
    assert.equal(loose.body.write.batch.commits, 3);
  });
});

// [dashboard-create#2]
test("dashboard create: an epic id that exists, a story file that exists, a slug that clashes with another number, and an initiative that names none are refused with create's words, the clone as it was and no batch", async () => {
  const numbered =
    '---\ntype: story\nid: "story-006-faster-login"\nepic: "PS-X"\ntitle: "Faster login"\nstatus: planned\n---\n\n# Faster login\n';
  await withWorld({ files: { "epics/PS-X/stories/story-006-faster-login.md": numbered } }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = cloneState(w, clone);
    const cases = [
      [epic({ epic: "PS-X" }), /PS-X|exists/],
      [story({ title: "A" }), /story-a\.md/],
      [story(), /story-006-faster-login/],
      [epic({ initiative: "no-such-initiative" }), /no-such-initiative|initiative/],
    ];
    for (const [req, said] of cases) {
      const r = await writer.action(req);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, false, JSON.stringify(req));
      assert.match(r.body.error, said);
      assert.ok(!r.body.error.includes(writer.place), "the answer names the project's paths, not the place's");
      assert.deepEqual(cloneState(w, clone), before, `the clone is as it was after ${req.verb}`);
      assert.equal(batchBranches(w, clone), "", "no batch branch");
      assert.equal(r.body.write.batch, null);
    }
  });
});

// [dashboard-create#2]
test("dashboard create: a story in an epic whose story list is no table is one commit of the story alone, with the note epic-row-missing (edge)", async () => {
  const listEpic =
    '---\ntype: epic\nid: "PS-L"\ntitle: "L"\nstatus: planned\n---\n\n# PS-L: L\n\n## Stories\n\n- [a](./stories/story-a.md)\n';
  await withWorld({ files: { "epics/PS-L/epic.md": listEpic } }, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const r = await writer.action(story({ epic: "PS-L" }));
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual([...r.body.result.notes], ["epic-row-missing"]);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-L/stories/story-faster-login.md"]);
    assert.equal(w.git(clone, "show", "HEAD:epics/PS-L/epic.md"), listEpic.trimEnd(), "the epic is as it was");
  });
});

// [dashboard-create#1] [dashboard-create#4]
test("dashboard create: a title within 200 characters whose file name passes the core's byte limit is refused by create, ok false, with its words and the clone as it was", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = cloneState(w, clone);
    const req = initiative({ title: "漢".repeat(90) });
    assert.equal(checkRequest(req).ok, true, "the page's own check passes it");
    for (const step of ["preview", "action"]) {
      const r = await writer[step](req);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, false);
      assert.match(r.body.error, /file name is \d+ bytes.*shorten the title/);
      assert.deepEqual(cloneState(w, clone), before);
      assert.equal(batchBranches(w, clone), "");
    }
  });
});

// [dashboard-create#2]
test("dashboard create: with every manifest's session id and project variable set, the three creates leave the bound checkout byte-identical and no *.writes folder", async () => {
  await withWorld({}, async (w) => {
    const manifests = [...loadHarnesses().values()];
    const sessionVars = manifests.map((m) => m.runtime?.session_id_env).filter(Boolean);
    const projectVars = manifests.map((m) => m.runtime?.project_dir_env).filter(Boolean);
    const env = { ...w.env, PROJECTSTORE_PROJECT_DIR: w.project };
    for (const k of sessionVars) env[k] = "dash-session-create";
    for (const k of projectVars) env[k] = w.project;
    const writer = await writable(w, { env });
    const bound = treeHash(w.repo);
    for (const req of [initiative(), epic({ initiative: "faster-onboarding" }), story({ epic: "PS-NEW" })]) {
      const r = await writer.action(req);
      assert.equal(r.body.ok, true, `${req.verb}: ${r.body.error}`);
    }
    assert.equal(treeHash(w.repo), bound, "the bound checkout is byte-identical");
    for (const dir of [w.project, writer.paths.binding]) {
      const sessions = stateDir(dir);
      const found = existsSync(sessions) ? readdirSync(sessions).filter((n) => n.endsWith(".writes")) : [];
      assert.deepEqual(found, [], `no record of writes under ${sessions}`);
    }
  });
});

// ─── Contracts 3 to 5: the page, app.js and write.js in one vm ──────────

const PUBLIC = join(REPO, "dashboard", "public");
const src = (name) => readFileSync(join(PUBLIC, name), "utf8");

// A stand-in for the DOM: elements with parents, listeners, classes and the
// few selectors app.js and write.js ask for.
class El {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.kids = [];
    this.nodeType = 1;
    this.cls = new Set();
    this.listeners = {};
    this.parent = null;
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.classList = {
      add: (...c) => c.forEach((x) => this.cls.add(x)),
      remove: (...c) => c.forEach((x) => this.cls.delete(x)),
      contains: (c) => this.cls.has(c),
      toggle: (c, on) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)),
    };
  }
  set className(v) {
    this.cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.cls].join(" ");
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  fire(t, ev = {}) {
    const e = { target: this, key: "", preventDefault() {}, stopPropagation() {}, ...ev };
    return (this.listeners[t] || []).map((fn) => fn(e));
  }
  click() {
    return this.fire("click");
  }
  append(...kids) {
    for (const k of kids) {
      if (k && k.nodeType === 1) k.parent = this;
      this.kids.push(k);
    }
  }
  replaceChildren(...kids) {
    this.kids = [];
    this.append(...kids);
  }
  prepend(...kids) {
    const rest = this.kids;
    this.kids = [];
    this.append(...kids, ...rest);
  }
  remove() {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
  }
  focus() {
    doc.activeElement = this;
  }
  get isConnected() {
    return true;
  }
  get offsetParent() {
    return this.hidden ? null : {};
  }
  get tabIndex() {
    return this.attrs.tabindex === undefined ? 0 : Number(this.attrs.tabindex);
  }
  contains(el) {
    return el === this || this.all().includes(el);
  }
  all() {
    return this.kids.filter((k) => k && k.nodeType === 1).flatMap((k) => [k, ...k.all()]);
  }
  text() {
    return this.kids.map((k) => (k && k.nodeType === 3 ? k.data : k && k.nodeType === 1 ? k.text() : "")).join("");
  }
  set textContent(v) {
    this.kids = [{ nodeType: 3, data: String(v) }];
  }
  get textContent() {
    return this.text();
  }
  // `tag`, `.class` or `tag.class`, comma-separated.
  matches(sel) {
    return sel.split(",").some((p) => {
      const m = /^([a-z0-9]*)((?:\.[\w-]+)*)$/.exec(p.trim());
      if (!m) return false;
      return (
        (!m[1] || this.tag === m[1]) &&
        m[2]
          .split(".")
          .filter(Boolean)
          .every((c) => this.cls.has(c))
      );
    });
  }
  closest(sel) {
    for (let e = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel) {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}
const doc = { activeElement: null };

// A writable page's write.verbs: the server's own table.
const writeOf = (verbs = JSON.parse(JSON.stringify(WRITE_VERBS)), more = {}) => ({
  can: true,
  reason: null,
  verbs,
  default_branch: "main",
  fetched_at: "2026-11-25T08:00:00.000Z",
  batch: null,
  pull_requests: null,
  kept: [],
  ...more,
});
const STATE = (write) => ({
  write,
  me: "Test Person",
  coreVersion: "0.0.0",
  project: { name: "proj" },
  people: [],
  assignees: [],
  initiatives: [
    {
      id: "faster-onboarding",
      title: "Faster onboarding",
      rel: "initiatives/faster-onboarding.md",
      stage: "proposed",
      priority: "p2",
      owner: "",
      counts: { done: 0, active: 0, backlog: 1 },
    },
  ],
  epics: [
    {
      id: "PS-X",
      title: "X",
      rel: "epics/PS-X/epic.md",
      group: "faster-onboarding",
      place: 0,
      status: "planned",
      priority: "p2",
      stories: 1,
      counts: { done: 0, active: 0, backlog: 1 },
    },
    {
      id: "PS-L",
      title: "Loose",
      rel: "epics/PS-L/epic.md",
      group: null,
      place: 0,
      status: "planned",
      priority: "p2",
      stories: 0,
      counts: { done: 0, active: 0, backlog: 0 },
    },
  ],
  stories: [
    {
      ref: "PS-X/story-a",
      epic: "PS-X",
      title: "A",
      rel: "epics/PS-X/stories/story-a.md",
      status: "planned",
      column: "Backlog",
      priority: "p2",
      subtasks: [],
      place: 0,
    },
  ],
});

// The page over `S`: app.js, then write.js, in one context. `answers` gives
// the write routes' answers by path, `state` what /api/state answers next
// (or an Error, for a read that fails).
function page(S, { answers = {}, state = null } = {}) {
  const els = {
    "#write": new El("div"),
    "#modal": new El("div"),
    "#view": new El("section"),
    "#toasts": new El("div"),
  };
  els["#modal"].hidden = true;
  const posts = [];
  const opened = [];
  const toasts = [];
  const newOpened = [];
  const palettes = [];
  const meta = new El("meta");
  meta.setAttribute("content", "the-run-token");
  const document = Object.assign(doc, {
    activeElement: null,
    body: new El("body"),
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, data: String(t) }),
    querySelector: (sel) => (sel.startsWith("meta") ? meta : els[sel] || null),
    querySelectorAll: () => [],
    addEventListener() {},
  });
  const ctx = {
    document,
    ico: (name) => {
      const i = new El("i");
      i.className = `ico ${name}`;
      return i;
    },
    render() {},
    fill: (el, ...kids) =>
      el.replaceChildren(
        ...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ""),
      ),
    kv: (...pairs) => {
      const d = new El("div");
      for (const [k, v] of pairs.filter(Boolean))
        d.append(...[k, v].map((x) => (x && x.nodeType === 1 ? x : { nodeType: 3, data: String(x) })));
      return d;
    },
    openDrawer: (kind, id) => opened.push([kind, id]),
    openNew: (kind, preset) => (newOpened.push([kind, JSON.parse(JSON.stringify(preset))]), true),
    openPalette: (level) => palettes.push(level),
    loadArtifacts: async () => {},
    fetchItem() {},
    withAssignees: (s) => s,
    fetch: async (url, opts = {}) => {
      if (url === "/api/state") {
        if (state instanceof Error) throw state;
        return { status: 200, json: async () => state || ctx.__p.S() };
      }
      const body = JSON.parse(opts.body);
      posts.push({ url, ...body });
      const a = answers[url] || { ok: true, result: null };
      return {
        status: a.status || (a.ok ? 200 : 400),
        json: async () => ({ ...a, write: a.write || ctx.__p.S().write }),
      };
    },
    setTimeout,
    Promise,
    Element: El,
  };
  vm.createContext(ctx);
  vm.runInContext(src("app.js"), ctx, { filename: "app.js" });
  vm.runInContext(
    `${src("write.js")}\nglobalThis.__p = { viewBacklog, ui, S: () => S, setS(v) { S = v; }, toastOf: toast, writeUi };`,
    ctx,
    { filename: "write.js" },
  );
  // The toasts the page shows, as [kind, what, why].
  vm.runInContext("toast = (...a) => globalThis.__toasts.push(a);", Object.assign(ctx, { __toasts: toasts }));
  ctx.__p.setS(S);
  ctx.__p.ui.filter = "";
  ctx.__p.ui.hideDone = false;
  ctx.__p.ui.seenOpen = true;
  const tree = () => ctx.__p.viewBacklog();
  const rows = () =>
    tree()
      .all()
      .filter((e) => e.tag === "tr" && e.attrs["data-key"]);
  const buttons = (root) => root.all().filter((e) => e.tag === "button");
  const words = (root) => buttons(root).map((b) => b.text());
  const dialog = () => els["#modal"];
  return {
    ctx,
    ui: ctx.__p.writeUi,
    p: ctx.__p,
    els,
    posts,
    opened,
    toasts,
    newOpened,
    palettes,
    tree,
    rows,
    buttons,
    words,
    dialog,
  };
}
// A value of the page's realm as plain JSON, for deepStrictEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));
const settleUi = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// [dashboard-create#3] [dashboard-new#1]
test("dashboard create page: a writable page draws no New in the toolbar, New epic on each initiative row and on No initiative, New story on each epic row, none on a story row, and the palette's lines", () => {
  const w = page(STATE(writeOf()));
  w.p.ui.open = new Set(["i:faster-onboarding", "i:", "e:PS-X", "e:PS-L"]);
  const t = w.tree();
  const bar = t.all().find((e) => e.cls.has("toolbar"));
  assert.deepEqual(
    w.words(bar).filter((x) => /New/.test(x)),
    [],
    "the toolbar has no New of its own: + New stands in the top bar",
  );
  const byKey = Object.fromEntries(w.rows().map((r) => [r.attrs["data-key"], r]));
  const newIn = (key) =>
    w
      .buttons(byKey[key])
      .filter((b) => b.cls.has("row-new"))
      .map((b) => b.text());
  assert.deepEqual(newIn("i:faster-onboarding"), ["+ New epic"]);
  assert.deepEqual(newIn("e:PS-X"), ["+ New story"]);
  assert.deepEqual(newIn("e:PS-L"), ["+ New story"]);
  assert.deepEqual(newIn("i:"), ["+ New epic"], "the No initiative row's New makes an epic with none");
  assert.equal(
    w.buttons(byKey["i:"]).find((b) => b.cls.has("row-new")).attrs["aria-label"],
    "New epic with no initiative",
  );
  assert.equal(
    w.buttons(byKey["e:PS-X"]).find((b) => b.cls.has("row-new")).attrs["aria-label"],
    "New story in PS-X · X",
  );
  assert.deepEqual(newIn("s:PS-X/story-a"), [], "a story row has no New");
  assert.deepEqual(
    [
      ...w.ui
        .rootCommands()
        .filter((c) => c.group === "New")
        .map((c) => c.label),
    ],
    ["New initiative…", "New epic…", "New story…"],
  );
  // The palette's lines for a selected epic and initiative.
  assert.deepEqual([...w.ui.itemCreateCommands("epic", "PS-X").map((c) => c.label)], ["New story in this epic…"]);
  assert.deepEqual(
    [...w.ui.itemCreateCommands("initiative", "faster-onboarding").map((c) => c.label)],
    ["New epic in this initiative…"],
  );
  assert.equal(w.ui.itemCreateCommands("story", "PS-X/story-a").length, 0);
});

// [dashboard-create#3]
test("dashboard create page: a done epic has no New story and a rejected or deferred initiative no New epic, on the row and in the palette (edge)", () => {
  const S = STATE(writeOf());
  S.epics[0].status = "done";
  S.initiatives[0].stage = "rejected";
  const w = page(S);
  w.p.ui.open = new Set(["i:faster-onboarding", "i:"]);
  const byKey = Object.fromEntries(w.rows().map((r) => [r.attrs["data-key"], r]));
  assert.ok(!w.words(byKey["e:PS-X"]).some((x) => /New/.test(x)), "no New story on a done epic");
  assert.ok(!w.words(byKey["i:faster-onboarding"]).some((x) => /New/.test(x)), "no New epic on a rejected initiative");
  assert.equal(w.ui.itemCreateCommands("epic", "PS-X").length, 0);
  assert.equal(w.ui.itemCreateCommands("initiative", "faster-onboarding").length, 0);
  S.initiatives[0].stage = "deferred";
  assert.equal(w.ui.itemCreateCommands("initiative", "faster-onboarding").length, 0);
  S.initiatives[0].stage = "done";
  assert.equal(
    w.ui.itemCreateCommands("initiative", "faster-onboarding").length,
    1,
    "an initiative whose epics are all done takes a new one",
  );
});

// [dashboard-create#3]
test("dashboard create page: a page that cannot write draws no New and the palette offers none; with create-story alone only epic rows have New (edge)", () => {
  const ro = page(STATE({ can: false, reason: "read-only for the test", verbs: [] }));
  ro.p.ui.open = new Set(["i:faster-onboarding", "e:PS-X"]);
  assert.ok(!ro.words(ro.tree()).some((x) => /New/.test(x)), "no New anywhere");
  assert.equal(ro.ui.rootCommands().filter((c) => c.group === "New").length, 0);
  const one = page(STATE(writeOf(JSON.parse(JSON.stringify(WRITE_VERBS.filter((v) => v.verb === "create-story"))))));
  one.p.ui.open = new Set(["i:faster-onboarding", "e:PS-X"]);
  const t = one.tree();
  const bar = t.all().find((e) => e.cls.has("toolbar"));
  assert.ok(!one.words(bar).some((x) => /New/.test(x)), "no New in the toolbar");
  const byKey = Object.fromEntries(one.rows().map((r) => [r.attrs["data-key"], r]));
  assert.ok(!one.words(byKey["i:faster-onboarding"]).some((x) => /New/.test(x)), "no New epic on the initiative row");
  assert.deepEqual(
    one.words(byKey["e:PS-X"]).filter((x) => /New/.test(x)),
    ["+ New story"],
  );
});

// [dashboard-create#3]
// [dashboard-new#1]
test("dashboard create page: a search that narrows the tree keeps New on the rows it shows, and a click on a row's New opens the new state with its epic and not the row's drawer", () => {
  const w = page(STATE(writeOf()));
  w.p.ui.filter = "X";
  const row = w.rows().find((r) => r.attrs["data-key"] === "e:PS-X");
  assert.ok(row, "the epic row is shown under the search");
  const btn = w.buttons(row).find((b) => b.cls.has("row-new"));
  assert.ok(btn, "New story is there under the search");
  // The row's own click, as the browser sends it for a click on the button.
  for (const fn of row.listeners.click || []) fn({ target: btn });
  assert.deepEqual(w.opened, [], "the row's drawer does not open");
  btn.click();
  assert.equal(w.dialog().hidden, true, "no dialog");
  assert.deepEqual(w.newOpened, [["story", { epic: "PS-X" }]], "the item panel's new state, its epic preset");
});

const PLAN = {
  write: false,
  kind: "story",
  path: "/vault/epics/PS-X/stories/story-faster-login.md",
  rel: "epics/PS-X/stories/story-faster-login.md",
  fields: {},
  mark: null,
  index: null,
  row: "| [story-faster-login](./stories/story-faster-login.md) | planned | Faster login |",
  notes: [],
  reconcile: null,
  left: [],
  declined: false,
  error: null,
};
const inputsOf = (w) =>
  w
    .dialog()
    .all()
    .filter((e) => e.tag === "input");
const primaryOf = (w) =>
  w
    .dialog()
    .all()
    .find((e) => e.tag === "button" && e.cls.has("primary"));
const type = (input, text) => {
  input.value = text;
  input.fire("input");
};
const BATCH = {
  branch: "dashboard/p/20261125T080000Z",
  started_at: "2026-11-25T08:00:00Z",
  commits: 1,
  pull_request: null,
};

// [dashboard-new#1]
test("dashboard new page: + New and the key C's level offer an initiative, an epic and a story while the page can write; Story is off with no open epic; a page that cannot write, or lists no create row, has none", () => {
  const w = page(STATE(writeOf()));
  const lvl = w.ui.newLevel();
  assert.equal(lvl.title, "New");
  assert.deepEqual(plain(lvl.items.map((i) => [i.label, i.off])), [
    ["Initiative", false],
    ["Epic", false],
    ["Story", false],
  ]);
  const btn = w.ui.newButton();
  assert.equal(btn.text(), "+ New");
  assert.ok(btn.cls.has("primary"), "a primary button");
  btn.click();
  assert.equal(w.palettes.length, 1, "it opens the palette");
  assert.deepEqual(plain(w.palettes[0].items.map((i) => i.label)), ["Initiative", "Epic", "Story"]);
  lvl.items[2].run();
  lvl.items[1].run();
  assert.deepEqual(w.newOpened, [
    ["story", {}],
    ["epic", {}],
  ]);
  const S = STATE(writeOf());
  for (const e of S.epics) e.status = "done";
  const d = page(S);
  const story = d.ui.newLevel().items.find((i) => i.label === "Story");
  assert.equal(story.off, true);
  assert.equal(story.hint, "make an epic first");
  assert.ok(!d.ui.rootCommands().some((c) => c.label === "New story…"), "no palette line that cannot run");
  const ro = page(STATE({ can: false, reason: "read-only for the test", verbs: [] }));
  assert.equal(ro.ui.newLevel(), null);
  assert.equal(ro.ui.newButton(), null);
  const none = page(STATE(writeOf(plain(WRITE_VERBS.filter((v) => !v.verb.startsWith("create-"))))));
  assert.equal(none.ui.newButton(), null);
});

// [dashboard-new#1]
test("dashboard new page: an epic's panel offers New story… and an initiative's New epic…, each opening the new state with its preset; the keys list names C, and C opens the New level", () => {
  const w = page(STATE(writeOf()));
  const epicActs = w.buttons(w.ui.itemButtons("epic", "PS-X"));
  const ns = epicActs.find((b) => b.text() === "New story…");
  assert.ok(ns, w.words(w.ui.itemButtons("epic", "PS-X")).join(", "));
  ns.click();
  const ne = w.buttons(w.ui.itemButtons("initiative", "faster-onboarding")).find((b) => b.text() === "New epic…");
  ne.click();
  assert.deepEqual(w.newOpened, [
    ["story", { epic: "PS-X" }],
    ["epic", { initiative: "faster-onboarding" }],
  ]);
  const keys = src("keys.js");
  assert.match(keys, /\["C", "New: add an initiative, an epic or a story"\]/);
  assert.match(
    keys,
    /else if \(k === "c"\) \{[\s\S]{0,200}const lvl = writeUi\.newLevel\(\);\s*if \(lvl\) \(done\(\), openPalette\(lvl\)\);/,
  );
  assert.match(src("views.js"), /writeUi\.newButton\(\)/, "the top bar of every view draws + New");
  assert.doesNotMatch(src("app.js"), /newInToolbar/);
});

// [dashboard-new#4]
test("dashboard new page: Save is off with a hint for an empty or long title, an epic ID missing or outside the rule, and a story's epic missing, unknown or done; the request names the inputs, the text and the pictures", () => {
  const w = page(STATE(writeOf()));
  const hint = (kind, f) => w.ui.newHint(kind, { title: "", id: "", epic: "", initiative: "", ...f });
  assert.match(hint("story", {}), /Give the story a title\./);
  assert.match(hint("initiative", { title: "x".repeat(201) }), /201 characters long; it takes at most 200/);
  assert.equal(hint("initiative", { title: " T " }), null);
  assert.match(hint("epic", { title: "T" }), /Give the epic an ID/);
  assert.match(hint("epic", { title: "T", id: "A B" }), /A B cannot be an epic's ID/);
  assert.equal(hint("epic", { title: "T", id: "PS-NEW" }), null);
  assert.match(hint("story", { title: "T" }), /Pick the epic the story goes in\./);
  assert.match(hint("story", { title: "T", epic: "PS-NO" }), /There is no epic PS-NO\./);
  assert.equal(hint("story", { title: "T", epic: "PS-X" }), null);
  const S = STATE(writeOf());
  S.epics[0].status = "done";
  assert.match(page(S).ui.newHint("story", { title: "T", epic: "PS-X" }), /PS-X is done\./);
  const files = [{ name: "0123456789abcdef.png", data: "AAAA" }];
  const cases = [
    [
      "epic",
      { title: " On ", id: "PS-NEW", initiative: "faster-onboarding" },
      [],
      { title: "On", text: "## Description\n", epic: "PS-NEW", initiative: "faster-onboarding" },
    ],
    [
      "epic",
      { title: "On", id: "PS-NEW", initiative: "" },
      [],
      { title: "On", text: "## Description\n", epic: "PS-NEW" },
    ],
    ["story", { title: "T", epic: "PS-X" }, files, { title: "T", text: "## Description\n", epic: "PS-X", files }],
    ["initiative", { title: "I", epic: "PS-X" }, [], { title: "I", text: "## Description\n" }],
  ];
  for (const [kind, f, given, want] of cases) {
    const fields = plain(w.ui.newFields(kind, f, "## Description\n", given));
    assert.deepEqual(fields, want, kind);
    const c = checkRequest({ verb: `create-${kind}`, fields });
    assert.equal(c.ok, true, c.error);
  }
});

// [dashboard-new#5]
test("dashboard new page: a refusal is said in New's plain words with create's own under Details; a path that holds 'exists' is no taken name; a refusal keeps the reasons the core left; a story with no open epic opens nothing", async () => {
  const w = page(STATE(writeOf()));
  const words = (kind, e) => {
    const r = w.ui.createRefusal(kind, e);
    return r ? r.map((x) => x.text()).join(" | ") : null;
  };
  assert.match(
    words("epic", "epics/PS-X/epic.md exists; a create never overwrites, and the agent command asks there"),
    /There is an epic of this name already\. Choose another ID\. \| .*a create never overwrites/,
  );
  assert.match(
    words("story", "the file name is 273 bytes; it may be 239 (255 less 16 for the temporary name): shorten the title"),
    /The title is too long for a file name\. Shorten it\./,
  );
  assert.match(
    words("story", '"PS-NO" names no epic in epics: there is no epics/PS-NO/epic.md'),
    /That epic is not in the vault\./,
  );
  assert.equal(
    words("story", "epics/PS-X/stories/story-collision-course-exists-now.md could not be written: EACCES"),
    null,
    "create's own words stand",
  );
  const left = { ...PLAN, left: [{ what: "the Stories row", error: "the epic file changed meanwhile", finish: "x" }] };
  const r = page(STATE(writeOf()), {
    answers: { "/api/action": { ok: false, result: left, error: "left: the Stories row", write: writeOf() } },
  });
  const a = await r.ui.saveNew("story", { epic: "PS-X", title: "Faster login", text: "## Description\n" });
  assert.equal(a.ok, false);
  assert.match(a.error, /left: the Stories row \(the Stories row: the epic file changed meanwhile\)/);
  const S = STATE(writeOf());
  for (const e of S.epics) e.status = "done";
  const d = page(S);
  d.ui.openCreate("story", {});
  assert.deepEqual(d.newOpened, []);
  assert.match(d.toasts.at(-1)[2], /Make an epic first/);
});

// [dashboard-create#5] [dashboard-new#4]
test("dashboard new page: after Save the page reads the state again, unfolds the story's epic, opens the story's drawer and says the note in plain words", async () => {
  const after = STATE(writeOf(undefined, { batch: BATCH }));
  after.stories.push({
    ref: "PS-X/story-faster-login",
    epic: "PS-X",
    title: "Faster login",
    rel: PLAN.rel,
    status: "planned",
    column: "Backlog",
    priority: "p2",
    subtasks: [],
    place: null,
  });
  const w = page(STATE(writeOf()), {
    answers: {
      "/api/action": { ok: true, result: { ...PLAN, write: true, notes: ["epic-row-missing"] }, write: after.write },
    },
    state: after,
  });
  w.p.ui.open = new Set();
  const sent = { epic: "PS-X", title: "Faster login", text: "## Description\n\nWhy.\n" };
  const a = await w.ui.saveNew("story", sent);
  assert.deepEqual(w.posts.at(-1), { url: "/api/action", verb: "create-story", fields: sent });
  assert.equal(a.ok, true);
  assert.equal(a.wrote, true);
  await w.ui.finishNew("story", a, sent);
  assert.ok(w.p.ui.open.has("e:PS-X"), "the epic is unfolded");
  assert.ok(w.p.ui.open.has("i:faster-onboarding"), "and the epic's initiative");
  assert.deepEqual(w.opened, [["story", "PS-X/story-faster-login"]]);
  assert.match(w.els["#write"].text(), /The story Faster login is made\. The epic's story list is not a table/);
  assert.ok(
    w.rows().find((r) => r.attrs["data-key"] === "s:PS-X/story-faster-login"),
    "the tree shows the story under its epic",
  );
});

// [dashboard-create#5] [dashboard-new#4]
test("dashboard new page: an epic made in an initiative unfolds it; a state with no item at the answer's rel opens nothing and names the file; a failed read says the item is saved, names its file and opens nothing", async () => {
  const epicPlan = { ...PLAN, kind: "epic", rel: "epics/PS-NEW/epic.md", row: null };
  const sent = { epic: "PS-NEW", title: "On", initiative: "faster-onboarding", text: "## Goal\n" };
  const run = async (state) => {
    const w = page(STATE(writeOf()), {
      answers: { "/api/action": { ok: true, result: epicPlan, write: writeOf(undefined, { batch: BATCH }) } },
      state,
    });
    w.p.ui.open = new Set();
    const a = await w.ui.saveNew("epic", sent);
    await w.ui.finishNew("epic", a, sent);
    return w;
  };
  const found = STATE(writeOf(undefined, { batch: BATCH }));
  found.epics.push({
    id: "PS-NEW",
    title: "On",
    rel: "epics/PS-NEW/epic.md",
    group: "faster-onboarding",
    place: null,
    status: "planned",
    priority: "p2",
    stories: 0,
    counts: { done: 0, active: 0, backlog: 0 },
  });
  const a = await run(found);
  assert.ok(a.p.ui.open.has("i:faster-onboarding"), "the initiative is unfolded");
  assert.deepEqual(a.opened, [["epic", "PS-NEW"]]);
  const b = await run(STATE(writeOf(undefined, { batch: BATCH })));
  assert.deepEqual(b.opened, [], "nothing to open");
  assert.match(b.els["#write"].text(), /epics\/PS-NEW\/epic\.md/);
  const c = await run(new Error("the state could not be read"));
  assert.deepEqual(c.opened, [], "no drawer after a failed read");
  assert.match(
    c.els["#write"].text(),
    /The epic On is saved as a draft change, in epics\/PS-NEW\/epic\.md; the page cannot open it yet\. But the page could not read the backlog again/,
  );
});

// [dashboard-create#5] [dashboard-new#4]
test("dashboard new page: an epic with no initiative unfolds No initiative, and the drawer opens whatever view the page shows (edge)", async () => {
  const plan = { ...PLAN, kind: "epic", rel: "epics/PS-NEW/epic.md", row: null };
  const found = STATE(writeOf(undefined, { batch: BATCH }));
  found.epics.push({
    id: "PS-NEW",
    title: "On",
    rel: "epics/PS-NEW/epic.md",
    group: null,
    place: null,
    status: "planned",
    priority: "p2",
    stories: 0,
    counts: { done: 0, active: 0, backlog: 0 },
  });
  const w = page(STATE(writeOf()), {
    answers: { "/api/action": { ok: true, result: plan, write: found.write } },
    state: found,
  });
  w.p.ui.open = new Set();
  w.p.ui.view = "board";
  const sent = { epic: "PS-NEW", title: "On", text: "## Goal\n" };
  await w.ui.finishNew("epic", await w.ui.saveNew("epic", sent), sent);
  assert.ok(w.p.ui.open.has("i:"), "No initiative is unfolded");
  assert.deepEqual(w.opened, [["epic", "PS-NEW"]], "the drawer opens on the board too");
});

// ─── The page's initiative and epic rows (the spec dashboard-initiative, contract 2) ───
// They run in this file's page harness, beside New.

const linked = () => {
  const S = STATE(writeOf());
  S.epics[0].initiative = "faster-onboarding";
  S.initiatives[0].status = "proposed";
  return S;
};

// [dashboard-initiative#2]
test("dashboard initiative page: an initiative's panel offers Accept, Reject, Defer and Edit fields; an epic offers Set initiative, or Change and No initiative once it has one; the palette has the same lines; a page that cannot write offers none", () => {
  const w = page(linked());
  const words = (root) => (root ? w.words(root) : []);
  // [dashboard-new#1] Each panel also offers New in it.
  assert.deepEqual(words(w.ui.itemButtons("initiative", "faster-onboarding")), [
    "Accept…",
    "Reject…",
    "Defer…",
    "Edit fields…",
    "New epic…",
  ]);
  assert.deepEqual(words(w.ui.itemButtons("epic", "PS-L")), ["Set initiative…", "New story…"]);
  assert.deepEqual(words(w.ui.itemButtons("epic", "PS-X")), ["Change initiative…", "No initiative…", "New story…"]);
  assert.deepEqual(
    [...w.ui.itemCommands("initiative", "faster-onboarding").map((c) => c.label)],
    ["Accept…", "Reject…", "Defer…", "Edit fields…"],
  );
  assert.deepEqual(
    [...w.ui.itemCommands("epic", "PS-X").map((c) => c.label)],
    ["Change initiative…", "No initiative…"],
  );
  const ro = page(STATE(writeOf(undefined, { can: false, reason: "read-only for the test" })));
  assert.equal(ro.ui.itemButtons("initiative", "faster-onboarding"), null);
  assert.equal(ro.ui.itemButtons("epic", "PS-X"), null);
  assert.deepEqual([...ro.ui.itemCommands("epic", "PS-X")], []);
});

// [dashboard-initiative#2] [dashboard-initiative#3]
test("dashboard initiative page: Edit fields starts from the item's values, offers no Preview until a field changes, and sends only the changed field (edge)", async () => {
  const w = page(linked(), {
    answers: { "/api/preview": { ok: true, result: { changes: [{ field: "priority", from: "p2", to: "p1" }] } } },
  });
  w.ui.openFields("faster-onboarding");
  const inputs = inputsOf(w);
  assert.deepEqual(
    inputs.map((i) => i.value),
    ["Faster onboarding", "", "p2"],
  );
  assert.equal(primaryOf(w).disabled, true, "nothing changed: no preview");
  type(inputs[2], "p1");
  assert.equal(primaryOf(w).disabled, false);
  primaryOf(w).click();
  await settleUi();
  assert.deepEqual(w.posts.at(-1), {
    url: "/api/preview",
    verb: "initiative-fields",
    fields: { initiative: "faster-onboarding", priority: "p1" },
  });
  assert.match(w.dialog().text(), /Priority\s*p2 → p1/);
});

// [dashboard-initiative#2] [dashboard-initiative#3]
test("dashboard initiative page: Reject opens the decide dialog titled by its label with the decision fixed, and its preview sends the initiative, the decision and the reason", async () => {
  const w = page(linked(), {
    answers: {
      "/api/preview": { ok: true, result: { changes: [{ field: "status", from: "proposed", to: "rejected" }] } },
    },
  });
  w.ui.openDecide("faster-onboarding", "rejected");
  const inputs = inputsOf(w);
  assert.equal(inputs.length, 1, "one input, the reason");
  type(inputs[0], "not now");
  assert.match(w.dialog().text(), /Commit: decide faster-onboarding: rejected: not now/);
  primaryOf(w).click();
  await settleUi();
  assert.deepEqual(w.posts.at(-1), {
    url: "/api/preview",
    verb: "initiative-decide",
    fields: { initiative: "faster-onboarding", decision: "rejected", reason: "not now" },
  });
  assert.equal(primaryOf(w).text(), "Reject");
});

// [dashboard-initiative#2]
test("dashboard initiative page: Set initiative takes a typed id offered from the vault's initiatives; No initiative sends the epic alone", async () => {
  const w = page(linked(), { answers: { "/api/preview": { ok: true, result: { changes: [] } } } });
  w.ui.openLink("PS-L");
  const lists = w
    .dialog()
    .all()
    .filter((e) => e.tag === "option");
  assert.deepEqual(
    lists.map((o) => o.value),
    ["faster-onboarding"],
  );
  type(inputsOf(w)[0], "faster-onboarding");
  primaryOf(w).click();
  await settleUi();
  assert.deepEqual(w.posts.at(-1), {
    url: "/api/preview",
    verb: "epic-initiative",
    fields: { epic: "PS-L", initiative: "faster-onboarding" },
  });
  assert.match(w.dialog().text(), /Nothing changes/);
  const u = page(linked(), {
    answers: {
      "/api/preview": { ok: true, result: { changes: [{ field: "initiative", from: "faster-onboarding", to: null }] } },
    },
  });
  u.ui.openUnlink("PS-X");
  primaryOf(u).click();
  await settleUi();
  assert.deepEqual(u.posts.at(-1), { url: "/api/preview", verb: "epic-unlink", fields: { epic: "PS-X" } });
});

// [dashboard-writes#7] [dashboard-new#4]
test("dashboard views left: a new item the core made while the views were left says, with the core's reason, that the views were not rebuilt", async () => {
  const after = STATE(writeOf(undefined, { batch: BATCH }));
  after.stories.push({
    ref: "PS-X/story-faster-login",
    epic: "PS-X",
    title: "Faster login",
    rel: PLAN.rel,
    status: "planned",
    column: "Backlog",
    priority: "p2",
    subtasks: [],
    place: null,
  });
  const w = page(STATE(writeOf()), {
    answers: {
      "/api/action": {
        ok: true,
        result: { ...PLAN, write: true },
        views_left: "kanban.md: EISDIR: illegal operation on a directory",
        write: after.write,
      },
    },
    state: after,
  });
  const sent = { epic: "PS-X", title: "Faster login", text: "## Description\n" };
  const a = await w.ui.saveNew("story", sent);
  await w.ui.finishNew("story", a, sent);
  assert.match(w.els["#write"].text(), /were not rebuilt \(kanban\.md: EISDIR/);
  assert.match(w.els["#write"].text(), /Your change does not need them/);
  assert.deepEqual(w.opened, [["story", "PS-X/story-faster-login"]]);
});

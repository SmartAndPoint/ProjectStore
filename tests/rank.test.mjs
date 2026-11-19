// projectstore — the rank field, the sibling order and the rank verb (spec
// "The rank verb and the sibling order…", alias `rank`; PS-BACKLOG: "A rank
// verb orders a story or an epic among its siblings, and moves no date"). The
// verb runs in process through the bin's run(), on small vaults written here;
// a drift is made through runRank's afterCompute seam, as for move. Each test
// names the contract it covers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { run, VERBS } from "../scripts/cli.mjs";
import {
  RANK_STEP as S,
  rankOf,
  siblingOrder,
  storyMember,
  epicGroups,
  storyGroups,
  rankTies,
  NO_INITIATIVE,
} from "../scripts/rank.mjs";
import { runRank, planValues, setRank, unparsable } from "../scripts/rank-verb.mjs";
import { runVaultChecks, runStartupChecks } from "../scripts/doctor.mjs";
import { parseFrontmatter, stateDir } from "../scripts/lib.mjs";
import { packageCommand, sourceHarness } from "../scripts/harness.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { hookEnv } from "./fixtures/hooks.mjs";
import { readEvents } from "../scripts/write-record.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const fmOf = (p) => parseFrontmatter(read(p)).data;

// ─── Fixtures ──────────────────────────────────────────────────────────

const storyText = ({ slug, title = slug, status = "planned", priority = "p2", rank = undefined, epic = "PS-X" }) =>
  `---\ntype: story\n${rank === undefined ? "" : `rank: ${rank}\n`}id: "${slug}"\nepic: "${epic}"\ntitle: "${title}"\n` +
  `status: ${status}\npriority: ${priority}\ncreated: 2026-11-01\nupdated: 2026-11-02\n---\n\n# ${title}\n\n` +
  `## Status log\n\n- 2026-11-02T10:00:00Z planned (create)\n\n---\n\n*Last updated: 2026-11-02*\n`;

const epicText = ({ id, initiative = undefined, rank = undefined, type = true }) =>
  `---\n${type ? "type: epic\n" : ""}id: "${id}"\ntitle: "${id} title"\nstatus: in-progress\n` +
  `${initiative === undefined ? "" : `initiative: "${initiative}"\n`}${rank === undefined ? "" : `rank: ${rank}\n`}` +
  `updated: 2026-11-02\n---\n\n# ${id}\n\n---\n\n*Last updated: 2026-11-02*\n`;

// A vault with epics and stories. `epics`: {ID: {initiative, rank, stories: [{slug, …}]}};
// `initiatives`: list of stems.
function vault({ epics = {}, initiatives = [] } = {}) {
  const { proj, vault } = makeVaultProject();
  const paths = {};
  mkdirSync(join(vault, "initiatives"), { recursive: true });
  for (const stem of initiatives)
    writeFileSync(
      join(vault, "initiatives", `${stem}.md`),
      `---\ntype: initiative\nid: "${stem}"\ntitle: "${stem}"\nstatus: accepted\n---\n\n# ${stem}\n`,
    );
  for (const [id, e] of Object.entries(epics)) {
    mkdirSync(join(vault, "epics", id, "stories"), { recursive: true });
    const ep = join(vault, "epics", id, "epic.md");
    writeFileSync(ep, e.text ?? epicText({ id, initiative: e.initiative, rank: e.rank, type: e.type !== false }));
    paths[id] = ep;
    for (const s of e.stories || []) {
      const p = join(vault, "epics", id, "stories", `${s.slug}.md`);
      writeFileSync(p, s.text ?? storyText({ ...s, epic: id }));
      paths[`${id}/${s.slug}`] = p;
    }
  }
  return { proj, vault, paths, cfg: { vault_path: vault, layout: "engineering", language: "en" } };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = read(p);
    }
  };
  walk(dir);
  return out;
}

const sink = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
async function cli(proj, args, { ask = null, json = false, env = {} } = {}) {
  const stdout = sink();
  const stderr = sink();
  const base = { ...process.env, CI: "1" };
  delete base.CLAUDE_CODE_SESSION_ID;
  const code = await run([...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: { ...base, ...env },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}
const direct = (f, positionals, values, extra = {}) => {
  const env = { ...process.env, CI: "1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return runRank({ values, positionals, cfg: f.cfg, project: f.proj, env, confirm: null, ...extra });
};

// The open stories of an epic, in sibling order, by slug.
function orderOf(f, epic) {
  const stories = readdirSync(join(f.vault, "epics", epic, "stories")).map((n) => {
    const rel = `epics/${epic}/stories/${n}`;
    return { rel, epic, slug: n.replace(/\.md$/, ""), fm: parseFrontmatter(read(join(f.vault, rel))).data };
  });
  return siblingOrder(storyGroups(stories).get(epic) || []).map((m) => m.slug);
}

// A pure member for planValues tests.
const m = (id, rank = null) => ({ kind: "epic", id, rank });
const plan = (G, itemId, place) => {
  const ordered = siblingOrder(G);
  const r = planValues(
    ordered,
    ordered.find((x) => x.id === itemId),
    place,
  );
  return { ...r, values: Object.fromEntries(r.values), order: r.order.map((x) => x.id) };
};
// The order after the plan's values are applied.
const after = (G, values) =>
  siblingOrder(G.map((x) => (Object.hasOwn(values, x.id) ? { ...x, rank: values[x.id] } : x))).map((x) => x.id);

// ─── Contract 1: a ranked value and the groups ─────────────────────────

// [rank#1]
test("rank: 7 and -3 are ranked; 1.5, 0x10, 1e3, sixteen digits, a list, null, empty and absent are not", () => {
  const p = (v) => rankOf(parseFrontmatter(`---\nrank: ${v}\n---\n`).data);
  assert.equal(p("7"), 7);
  assert.equal(p("-3"), -3);
  assert.equal(p('"12"'), 12);
  assert.equal(p("999999999999999"), 999999999999999);
  for (const v of ["1.5", "0x10", "1e3", "1234567890123456", "[1]", "null", "", "+5", " "]) assert.equal(p(v), null, v);
  assert.equal(rankOf({}), null);
  assert.equal(rankOf({ rank: 5 }), null, "only the parser's string ranks");
});

// [rank#1]
test("an epic naming a missing initiative, or none, is in No initiative; one naming a file is in its group (edge)", () => {
  const epics = [
    { id: "PS-A", rel: "epics/PS-A/epic.md", fm: { initiative: "no-such-file" } },
    { id: "PS-B", rel: "epics/PS-B/epic.md", fm: {} },
    { id: "PS-C", rel: "epics/PS-C/epic.md", fm: { initiative: "faster" } },
    { id: "PS-D", rel: "epics/PS-D/epic.md", fm: { initiative: "[faster]" } },
  ];
  const g = epicGroups(epics, [{ rel: "initiatives/faster.md", fm: { id: "faster" } }]);
  assert.deepEqual(
    g.get(NO_INITIATIVE).map((x) => x.id),
    ["PS-A", "PS-B", "PS-D"],
  );
  assert.deepEqual(
    g.get("faster").map((x) => x.id),
    ["PS-C"],
  );
});

// [rank#1]
test('rank: "7", 007 and -0 are ranked at 7, 7 and 0, and the first two are equal (edge)', () => {
  const p = (v) => rankOf(parseFrontmatter(`---\nrank: ${v}\n---\n`).data);
  assert.equal(p('"7"'), 7);
  assert.equal(p("007"), 7);
  assert.equal(p("-0"), 0);
});

// [rank#1]
test("a folder named _drafts with an epic.md is no epic: the verb names no epic for it (edge)", async () => {
  const f = vault({ epics: { "PS-A": {}, _drafts: {} } });
  const r = await cli(f.proj, ["rank", "epic", "_drafts", "--first"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"_drafts" names no epic/);
  const r2 = await cli(f.proj, ["rank", "epic", "PS-A", "--after", "_drafts"]);
  assert.equal(r2.code, 1);
});

// [rank#1]
test("an epic whose initiative value is the id of two files is in No initiative (edge)", () => {
  const g = epicGroups(
    [{ id: "PS-A", rel: "epics/PS-A/epic.md", fm: { initiative: "twice" } }],
    [
      { rel: "initiatives/a.md", fm: { id: "twice" } },
      { rel: "initiatives/b.md", fm: { id: "twice" } },
    ],
  );
  assert.deepEqual(
    g.get(NO_INITIATIVE).map((x) => x.id),
    ["PS-A"],
  );
});

// [rank#1]
test("in a layout with no initiative kind every epic is in No initiative (edge)", () => {
  const g = epicGroups([{ id: "PS-A", rel: "epics/PS-A/epic.md", fm: { initiative: "faster" } }], []);
  assert.deepEqual(
    g.get(NO_INITIATIVE).map((x) => x.id),
    ["PS-A"],
  );
});

// [rank#1]
test("a done story, a deferred one and one with no status are in no group (edge)", () => {
  const s = (slug, status) => ({
    rel: `epics/PS-X/stories/${slug}.md`,
    epic: "PS-X",
    slug,
    fm: status === null ? {} : { status },
  });
  const g = storyGroups([s("a", "done"), s("b", "deferred"), s("c", null), s("d", "closed"), s("e", "in-progress")]);
  assert.deepEqual(
    g.get("PS-X").map((x) => x.slug),
    ["e"],
  );
});

// ─── Contract 2: siblingOrder ──────────────────────────────────────────

const st = (slug, column, priority, title = slug, rank = undefined) =>
  storyMember({
    rel: `epics/PS-X/stories/${slug}.md`,
    epic: "PS-X",
    slug,
    fm: {
      status: { ToDo: "todo", Review: "review", Backlog: "planned", "In Progress": "in-progress" }[column],
      priority,
      title,
      ...(rank === undefined ? {} : { rank: String(rank) }),
    },
  });

// [rank#2]
test("with no rank, open stories sort by column Review, In Progress, ToDo, Backlog, then priority, then title", () => {
  const G = [
    st("A", "ToDo", "p1", "Bravo"),
    st("B", "Review", "p3"),
    st("C", "Backlog", "p0"),
    st("D", "ToDo", "p1", "Alpha"),
  ];
  assert.deepEqual(
    siblingOrder(G).map((x) => x.slug),
    ["B", "D", "A", "C"],
  );
});

// [rank#2]
test("a tie of ranks falls to the fallback; ranked members come before unranked ones (edge)", () => {
  const G = [
    st("A", "ToDo", "p1", "Bravo", 5),
    st("B", "Review", "p3"),
    st("C", "Backlog", "p0", "C", 5),
    st("D", "ToDo", "p1", "Alpha"),
  ];
  assert.deepEqual(
    siblingOrder(G).map((x) => x.slug),
    ["A", "C", "B", "D"],
  );
});

// [rank#2]
test("a priority outside p0 to p3 reads as p2, and a story with no title sorts by its slug (edge)", () => {
  const G = [st("z", "ToDo", "P1"), st("y", "ToDo", "p2"), st("x", "ToDo", "high"), st("w", "ToDo", "p1")];
  G[0].title = "z";
  assert.deepEqual(
    siblingOrder(G).map((x) => x.slug),
    ["w", "x", "y", "z"],
  );
  assert.equal(
    storyMember({ rel: "epics/PS-X/stories/q.md", epic: "PS-X", slug: "q", fm: { status: "todo" } }).title,
    "q",
  );
});

// [rank#2]
test("stories equal in column, priority and title stand by id: story-x before story-x-2 (edge)", () => {
  const G = [st("story-x-2", "ToDo", "p1", "Same"), st("story-x", "ToDo", "p1", "Same")];
  assert.deepEqual(
    siblingOrder(G).map((x) => x.slug),
    ["story-x", "story-x-2"],
  );
});

// [rank#2]
test("epics of one group: ranked first by value, then the rest by id", () => {
  const G = [m("PS-C"), m("PS-B", 2), m("PS-A")];
  assert.deepEqual(
    siblingOrder(G).map((x) => x.id),
    ["PS-B", "PS-A", "PS-C"],
  );
});

// ─── Contract 3: the form and the place ────────────────────────────────

// [rank#3]
test("rank story Z --before Y over unranked X, Y, Z plans values that give X, Z, Y", async () => {
  const f = vault({
    epics: {
      "PS-X": {
        stories: [
          { slug: "x", title: "X" },
          { slug: "y", title: "Y" },
          { slug: "z", title: "Z" },
        ],
      },
    },
  });
  assert.deepEqual(orderOf(f, "PS-X"), ["x", "y", "z"]);
  const r = await cli(f.proj, ["rank", "story", "PS-X/z", "--before", "PS-X/y", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(orderOf(f, "PS-X"), ["x", "z", "y"]);
  assert.equal(fmOf(f.paths["PS-X/x"]).rank, String(S));
  assert.equal(fmOf(f.paths["PS-X/z"]).rank, String(2 * S));
  assert.equal(fmOf(f.paths["PS-X/y"]).rank, undefined);
});

// [rank#3]
test("a move that leaves the order as it is writes nothing, asks nothing and exits 0 (edge)", async () => {
  const f = vault({ epics: { "PS-X": { stories: [{ slug: "x" }, { slug: "y" }] } } });
  const before = snapshot(f.proj);
  let asked = false;
  for (const args of [
    ["rank", "story", "PS-X/x", "--first", "--write"],
    ["rank", "story", "PS-X/x", "--before", "PS-X/y", "--write"],
    ["rank", "story", "PS-X/y", "--last"],
  ]) {
    const r = await cli(f.proj, args, {
      ask: async () => {
        asked = true;
        return true;
      },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /already in that place; nothing to write/);
  }
  assert.equal(asked, false);
  assert.deepEqual(snapshot(f.proj), before);
});

// [rank#3]
test("a folder story (stories/<slug>/README.md) and a standalone story-*.md beside epic.md are ranked like the others (edge)", async () => {
  const f = vault({ epics: { "PS-X": { stories: [{ slug: "a" }] } } });
  const dir = join(f.vault, "epics", "PS-X", "stories", "story-folder");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), storyText({ slug: "story-folder", title: "z folder" }));
  const lone = join(f.vault, "epics", "PS-X", "story-lone.md");
  writeFileSync(lone, storyText({ slug: "story-lone", title: "b lone" }));
  const r = await cli(f.proj, ["rank", "story", "PS-X/story-folder", "--first", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fmOf(join(dir, "README.md")).rank, String(S));
  const r2 = await cli(f.proj, ["rank", "story", "PS-X/story-lone", "--after", "PS-X/story-folder", "--write"]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(fmOf(lone).rank, String(S + S));
});

// ─── Contract 4: the values ────────────────────────────────────────────

// [rank#4]
test("row 1: an item between ranked neighbours S and 2S gets 1572864, one file", () => {
  const G = [m("a", S), m("b", 2 * S), m("i")];
  const r = plan(G, "i", { after: "a" });
  assert.deepEqual(r.values, { i: 1572864 });
  assert.deepEqual(after(G, r.values), r.order);
});

// [rank#4]
test("row 1 with no L: an unranked item put first before S gets the midpoint of -S and S, 0 (edge)", () => {
  const G = [m("a", S), m("i")];
  const r = plan(G, "i", { first: true });
  assert.deepEqual(r.values, { i: 0 });
  assert.deepEqual(after(G, r.values), ["i", "a"]);
});

// [rank#4]
test("row 2: no integer between 5 and 6 renumbers the ranked part at S, 2S, …, and a member already at its value is not written (edge)", () => {
  // The spec's scenario: 5, 6, 4194304 and 5000000; the item between 5 and 6.
  const G = [m("a", 5), m("b", 6), m("c", 4194304), m("d", 5000000), m("i"), m("u")];
  const r = plan(G, "i", { after: "a" });
  // G': a, i, b, c, d, u → a S, i 2S, b 3S, c 4S (already), d 5S: four files.
  assert.deepEqual(r.values, { a: S, i: 2 * S, b: 3 * S, d: 5 * S });
  assert.deepEqual(after(G, r.values), r.order);
  // Equal values are no gap either.
  const T = [m("a", 5), m("b", 5), m("i")];
  const t = plan(T, "i", { after: "a" });
  assert.deepEqual(t.values, { a: S, i: 2 * S, b: 3 * S });
});

// [rank#4]
test("row 3: an item put first over unranked members gets S", () => {
  const G = [m("a"), m("b"), m("i")];
  const r = plan(G, "i", { first: true });
  assert.deepEqual(r.values, { i: S });
  assert.deepEqual(after(G, r.values), ["i", "a", "b"]);
});

// [rank#4]
test("row 4: an item right after the last ranked member gets L + S", () => {
  const G = [m("a", 7), m("b"), m("i")];
  const r = plan(G, "i", { after: "a" });
  assert.deepEqual(r.values, { i: 7 + S });
  assert.deepEqual(after(G, r.values), ["a", "i", "b"]);
});

// [rank#4]
test("row 5: below unranked members, they and the item get M + S, M + 2S, …; ranked ones are not written", () => {
  const G = [m("r1", S), m("r2", 2 * S), m("u1"), m("u2"), m("i")];
  const r = plan(G, "i", { after: "u1" });
  assert.deepEqual(r.values, { u1: 3 * S, i: 4 * S });
  assert.deepEqual(after(G, r.values), ["r1", "r2", "u1", "i", "u2"]);
  // Negative values: M is the largest.
  const N = [m("r", -10), m("u"), m("i")];
  assert.deepEqual(plan(N, "i", { last: true }).values, { u: -10 + S, i: -10 + 2 * S });
});

// [rank#4]
test("negative neighbours: between -3 and 0 the midpoint rounds down to -2; between -5 and -4 the ranked part renumbers (edge)", () => {
  const G = [m("a", -3), m("b", 0), m("i")];
  assert.deepEqual(plan(G, "i", { after: "a" }).values, { i: -2 });
  const H = [m("a", -5), m("b", -4), m("i")];
  const r = plan(H, "i", { after: "a" });
  assert.deepEqual(r.values, { a: S, i: 2 * S, b: 3 * S });
  assert.deepEqual(after(H, r.values), r.order);
});

// [rank#4]
test("a group of one writes nothing", () => {
  const r = plan([m("i")], "i", { first: true });
  assert.equal(r.same, true);
  assert.deepEqual(r.values, {});
});

// [rank#4]
test("a value past 15 digits from row 1 with no L, row 4 and row 5 renumbers from the first member instead (failure)", () => {
  const big = 999999999999999;
  // Row 1, no L: U at -big, the midpoint -big - S has sixteen digits.
  const G1 = [m("a", -big), m("b", 0), m("i")];
  const r1 = plan(G1, "i", { first: true });
  assert.deepEqual(r1.values, { i: S, a: 2 * S, b: 3 * S });
  assert.deepEqual(after(G1, r1.values), r1.order);
  // Row 4: L + S past fifteen digits.
  const G4 = [m("a", 5), m("b", big), m("u"), m("x")];
  const r4 = plan(G4, "x", { after: "b" });
  assert.deepEqual(r4.values, { a: S, b: 2 * S, x: 3 * S });
  assert.deepEqual(after(G4, r4.values), r4.order);
  // Row 5: M + S past fifteen digits; the renumber runs through the item.
  const G5 = [m("a", big), m("u1"), m("u2"), m("i")];
  const r5 = plan(G5, "i", { after: "u1" });
  assert.deepEqual(r5.values, { a: S, u1: 2 * S, i: 3 * S });
  assert.deepEqual(after(G5, r5.values), r5.order);
});

// [rank#4]
test("an item moved down among ranked members gets the midpoint of its new neighbours", () => {
  const G = [m("i", S), m("a", 2 * S), m("b", 3 * S)];
  const r = plan(G, "i", { after: "a" });
  assert.deepEqual(r.values, { i: 2621440 });
  assert.deepEqual(after(G, r.values), ["a", "i", "b"]);
});

// ─── Contract 5: the write ─────────────────────────────────────────────

// [rank#5]
test("a story with no rank gains one line right after type:, and every other byte stays", async () => {
  const f = vault({ epics: { "PS-X": { stories: [{ slug: "a" }, { slug: "b" }, { slug: "c" }] } } });
  const before = snapshot(f.proj);
  const r = await cli(f.proj, ["rank", "story", "PS-X/c", "--first", "--write"]);
  assert.equal(r.code, 0, r.err);
  const now = snapshot(f.proj);
  const changed = Object.keys(now).filter((k) => now[k] !== before[k]);
  assert.deepEqual(changed, ["vault/epics/PS-X/stories/c.md"]);
  const was = before["vault/epics/PS-X/stories/c.md"];
  assert.equal(now["vault/epics/PS-X/stories/c.md"], was.replace("type: story\n", `type: story\nrank: ${S}\n`));
});

// [rank#5]
test("an existing rank: line is replaced in place, and a file with no type: gains it as its first line (edge)", () => {
  const t = "---\nid: x\nrank: 5\ntitle: T\n---\nbody\n";
  assert.equal(setRank(t, 7), "---\nid: x\nrank: 7\ntitle: T\n---\nbody\n");
  assert.equal(setRank("---\nid: x\n---\n", S), `---\nrank: ${S}\nid: x\n---\n`);
});

// [rank#5]
test("an epic with no type: line gets rank: as its frontmatter's first line through the verb (edge)", async () => {
  const f = vault({
    epics: { "PS-A": { type: false }, "PS-B": {} },
  });
  const r = await cli(f.proj, ["rank", "epic", "PS-B", "--first", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(f.paths["PS-B"]).startsWith(`---\ntype: epic\nrank: ${S}\n`));
  const r2 = await cli(f.proj, ["rank", "epic", "PS-A", "--first", "--write"]);
  assert.equal(r2.code, 0, r2.err);
  assert.ok(read(f.paths["PS-A"]).startsWith(`---\nrank: 0\nid: "PS-A"\n`), read(f.paths["PS-A"]));
});

// [rank#5]
test("a plan holding a CRLF epic.md exits 1 naming it, and no file is written (failure)", async () => {
  const f = vault({
    epics: {
      "PS-A": { rank: 5 },
      "PS-B": { text: epicText({ id: "PS-B" }).replace(/\n/g, "\r\n") },
    },
  });
  const before = snapshot(f.proj);
  // PS-B --first: L none, U PS-A ranked at 5 → midpoint; the plan holds PS-B only.
  const r = await cli(f.proj, ["rank", "epic", "PS-B", "--first", "--write"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /epics\/PS-B\/epic\.md cannot take a rank: .*CRLF/);
  assert.deepEqual(snapshot(f.proj), before);
  // A plan of two files, the CRLF one second, writes neither.
  const g = vault({
    epics: {
      "PS-A": {},
      "PS-B": { text: epicText({ id: "PS-B" }).replace(/\n/g, "\r\n") },
      "PS-C": {},
    },
  });
  const before2 = snapshot(g.proj);
  // PS-B --last: G' is A, C, B, and row 5 gives all three a value; B is last in the plan.
  const r2 = await cli(g.proj, ["rank", "epic", "PS-B", "--last", "--write"]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /epics\/PS-B\/epic\.md cannot take a rank/);
  assert.deepEqual(snapshot(g.proj), before2);
});

// [rank#5]
test("a file edited once on another line between the plan and its write keeps the edit and gains the rank line (edge)", async () => {
  const f = threeUnranked();
  let once = false;
  const r = await direct(
    f,
    ["story", "PS-X/c"],
    { first: true, write: true },
    {
      afterCompute: (abs) => {
        if (abs === f.paths["PS-X/c"] && !once) {
          once = true;
          writeFileSync(abs, read(abs) + "an edit meanwhile\n");
        }
      },
    },
  );
  assert.equal(r.code, 0, r.text);
  const c = read(f.paths["PS-X/c"]);
  assert.match(c, /an edit meanwhile/);
  assert.match(c, new RegExp(`^type: story\nrank: ${S}$`, "m"));
});

// [rank#5]
test("a rank another writer set after the plan stops the move, and the file keeps it (failure)", async () => {
  const f = threeUnranked();
  const r = await direct(
    f,
    ["story", "PS-X/d"],
    { after: "PS-X/b", write: true },
    {
      afterCompute: (abs) => {
        const p = f.paths["PS-X/b"];
        if (abs === p && !/^rank: 9$/m.test(read(p)))
          writeFileSync(p, read(p).replace("type: story\n", "type: story\nrank: 9\n"));
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.text, /epics\/PS-X\/stories\/b\.md: its rank is now 9, not none as the plan read it/);
  assert.equal(fmOf(f.paths["PS-X/b"]).rank, "9");
  assert.deepEqual(r.result.restored, ["epics/PS-X/stories/a.md"]);
  assert.equal(fmOf(f.paths["PS-X/a"]).rank, undefined);
});

// [rank#5]
test("a story closed, or given a second rank: line, by another writer after the plan stops the move; that file keeps its bytes and the first file its old ones (failure)", async () => {
  for (const spoil of [
    (s) => s.replace("status: planned", "status: done"),
    (s) => s.replace("type: story\n", "type: story\nrank: 1\nrank: 2\n"),
  ]) {
    const f = threeUnranked();
    const before = read(f.paths["PS-X/a"]);
    let spoiled = null;
    const r = await direct(
      f,
      ["story", "PS-X/c"],
      { after: "PS-X/a", write: true },
      {
        afterCompute: (abs) => {
          const p = f.paths["PS-X/c"];
          if (abs === p && spoiled === null) {
            spoiled = spoil(read(p));
            writeFileSync(p, spoiled);
          }
        },
      },
    );
    assert.equal(r.code, 1);
    assert.match(
      r.text,
      /epics\/PS-X\/stories\/c\.md: (the story is no longer open|cannot take a rank: it has more than one rank: line)/,
    );
    assert.equal(read(f.paths["PS-X/c"]), spoiled);
    assert.equal(read(f.paths["PS-X/a"]), before);
  }
});

// [rank#5]
test("two rank: lines, or a rank: value over more than one line, are refused before any write (failure)", async () => {
  assert.match(unparsable("---\ntype: story\nrank: 1\nrank: 9\n---\n"), /more than one rank: line/);
  const f = vault({
    epics: {
      "PS-X": {
        stories: [
          { slug: "a" },
          {
            slug: "b",
            text: storyText({ slug: "b", epic: "PS-X" }).replace("type: story\n", "type: story\nrank:\n  - 1\n"),
          },
          { slug: "c" },
        ],
      },
    },
  });
  const before = snapshot(f.proj);
  const r = await cli(f.proj, ["rank", "story", "PS-X/b", "--last", "--write"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /epics\/PS-X\/stories\/b\.md cannot take a rank: its rank value runs over more than one line/);
  assert.deepEqual(snapshot(f.proj), before);
});

// [rank#5]
test("a rank: value over more than one line is unparsable (failure)", () => {
  assert.match(unparsable("---\ntype: story\nrank:\n  - 1\n---\n"), /more than one line/);
  assert.equal(unparsable("---\ntype: story\nrank: 3\nid: x\n---\n"), null);
  assert.match(unparsable("---\r\ntype: story\r\n---\r\n"), /CRLF/);
});

// ─── Contract 6: the restore ───────────────────────────────────────────

const threeUnranked = () =>
  vault({ epics: { "PS-X": { stories: [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }] } } });

// [rank#6]
test("a file changed on every attempt stops the move, and the file written before it gets its old bytes back (failure)", async () => {
  const f = threeUnranked();
  const before = snapshot(f.proj);
  // d --after c? no: d --after b → a, b, d, c: a S, b 2S, d 3S (three files).
  const r = await direct(
    f,
    ["story", "PS-X/d"],
    { after: "PS-X/b", write: true },
    {
      afterCompute: (abs) => {
        if (abs === f.paths["PS-X/b"]) writeFileSync(abs, read(abs) + `drift ${Math.random()}\n`);
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.match(r.text, /story-changed-meanwhile: epics\/PS-X\/stories\/b\.md/);
  assert.deepEqual(r.result.restored, ["epics/PS-X/stories/a.md"]);
  assert.deepEqual(r.result.unrestored, []);
  assert.equal(read(f.paths["PS-X/a"]), before["vault/epics/PS-X/stories/a.md"]);
  assert.equal(read(f.paths["PS-X/d"]), before["vault/epics/PS-X/stories/d.md"], "the third was never written");
});

// [rank#6]
test("a file changed again after its write is left and listed with its old value (failure)", async () => {
  const f = threeUnranked();
  const r = await direct(
    f,
    ["story", "PS-X/d"],
    { after: "PS-X/b", write: true },
    {
      afterWrite: (abs) => {
        if (abs === f.paths["PS-X/a"]) writeFileSync(abs, read(abs) + "someone else\n");
      },
      afterCompute: (abs) => {
        if (abs === f.paths["PS-X/b"]) writeFileSync(abs, read(abs) + `drift ${Math.random()}\n`);
      },
    },
  );
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.unrestored, [{ path: "epics/PS-X/stories/a.md", line: null }]);
  assert.match(
    r.text,
    /not restored \(changed since the write, or the restore failed\): epics\/PS-X\/stories\/a\.md; remove its rank: line by hand/,
  );
  assert.match(read(f.paths["PS-X/a"]), /someone else/);
});

// [rank#6]
test("a file another writer edited before its write gets that edit back, not the bytes read before the first write (failure)", async () => {
  const f = threeUnranked();
  const r = await direct(
    f,
    ["story", "PS-X/d"],
    { after: "PS-X/b", write: true },
    {
      afterCompute: (abs, i) => {
        if (abs === f.paths["PS-X/a"] && i === 0) writeFileSync(abs, read(abs) + "the other writer\n");
        if (abs === f.paths["PS-X/b"]) writeFileSync(abs, read(abs) + `drift ${Math.random()}\n`);
      },
    },
  );
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.restored, ["epics/PS-X/stories/a.md"]);
  const a = read(f.paths["PS-X/a"]);
  assert.match(a, /the other writer/);
  assert.doesNotMatch(a, /^rank:/m);
});

// [rank#6]
test("the old line of an unrestored file is given as it was, rank: 1.5 included (edge)", async () => {
  const f = vault({
    epics: {
      "PS-X": { stories: [{ slug: "a", rank: "1.5" }, { slug: "b" }, { slug: "c" }, { slug: "d" }] },
    },
  });
  const r = await direct(
    f,
    ["story", "PS-X/d"],
    { after: "PS-X/b", write: true },
    {
      afterWrite: (abs) => {
        if (abs === f.paths["PS-X/a"]) writeFileSync(abs, read(abs) + "someone else\n");
      },
      afterCompute: (abs) => {
        if (abs === f.paths["PS-X/b"]) writeFileSync(abs, read(abs) + `drift ${Math.random()}\n`);
      },
    },
  );
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.unrestored, [{ path: "epics/PS-X/stories/a.md", line: "rank: 1.5" }]);
  assert.match(r.text, /put back `rank: 1\.5` by hand/);
});

// ─── Contract 7: the refusals ──────────────────────────────────────────

const mixed = () =>
  vault({
    initiatives: ["faster", "slower"],
    epics: {
      "PS-A": {
        initiative: "faster",
        stories: [
          { slug: "open1" },
          { slug: "open2" },
          { slug: "fin", status: "done" },
          { slug: "aside", status: "deferred" },
        ],
      },
      "PS-B": { initiative: "faster", stories: [{ slug: "other" }] },
      "PS-C": { initiative: "slower" },
      "PS-D": {},
    },
  });

// [rank#7]
test("a done item, a set-aside sibling, another epic's story and the item as its own sibling each exit 1 with one line and write nothing", async () => {
  const f = mixed();
  const before = snapshot(f.proj);
  const cases = [
    [["rank", "story", "PS-A/fin", "--first"], /PS-A\/fin is not open/],
    [["rank", "story", "PS-A/open1", "--before", "PS-A/aside"], /PS-A\/aside is not open/],
    [["rank", "story", "PS-A/open1", "--before", "PS-B/other"], /a story's epic is not changed by rank/],
    [["rank", "story", "PS-A/open1", "--after", "PS-A/open1"], /is the story being ranked/],
    [["rank", "story", "PS-A/nope", "--first"], /no story in epics\/PS-A matches "nope"/],
    [["rank", "epic", "PS-Z", "--first"], /"PS-Z" names no epic/],
    [["rank", "epic", "PS-A", "--after", "PS-A", "--write"], /is the epic being ranked/],
  ];
  for (const [args, re] of cases) {
    const r = await cli(f.proj, [...args, "--write"]);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, re);
    assert.equal(r.err.trim().split("\n").length, 1, r.err);
  }
  assert.deepEqual(snapshot(f.proj), before);
});

// [rank#7]
test("every check on the item runs before any on the sibling: a done item with a sibling that names nothing says the item is not open (edge)", async () => {
  const f = mixed();
  const r = await cli(f.proj, ["rank", "story", "PS-A/fin", "--before", "PS-A/nothing-here"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /PS-A\/fin is not open/);
  const e = await cli(f.proj, ["rank", "epic", "PS-Z", "--before", "PS-Y"]);
  assert.match(e.err, /"PS-Z" names no epic/);
});

// [rank#7]
test("an epic's sibling in another initiative, or in none, is refused with the epic --initiative hint (edge)", async () => {
  const f = mixed();
  for (const sib of ["PS-C", "PS-D"]) {
    const r = await cli(f.proj, ["rank", "epic", "PS-A", "--before", sib]);
    assert.equal(r.code, 1);
    assert.match(r.err, /use `epic <EPIC-ID> --initiative <id>`/);
  }
});

// [rank#7]
test("a name two stories share is refused naming both, and a CRLF story as the item is not open (failure)", async () => {
  const f = vault({
    epics: {
      "PS-X": {
        stories: [
          { slug: "dup-a", text: storyText({ slug: "dup-a", epic: "PS-X" }).replace('id: "dup-a"', 'id: "dup"') },
          { slug: "dup-b", text: storyText({ slug: "dup-b", epic: "PS-X" }).replace('id: "dup-b"', 'id: "dup"') },
          { slug: "crlf", text: storyText({ slug: "crlf", epic: "PS-X" }).replace(/\n/g, "\r\n") },
          { slug: "c" },
        ],
      },
    },
  });
  const before = snapshot(f.proj);
  const a = await cli(f.proj, ["rank", "story", "PS-X/dup", "--first", "--write"]);
  assert.equal(a.code, 1);
  assert.match(a.err, /names 2 stories/);
  const b = await cli(f.proj, ["rank", "story", "PS-X/crlf", "--first", "--write"]);
  assert.equal(b.code, 1);
  assert.match(b.err, /PS-X\/crlf is not open/);
  assert.deepEqual(snapshot(f.proj), before);
});

// [rank#7]
test("under --json a refusal is the envelope's error with ok false, and stderr is empty (edge)", async () => {
  const f = mixed();
  const r = await cli(f.proj, ["rank", "story", "PS-A/fin", "--first"], { json: true });
  assert.equal(r.code, 1);
  assert.equal(r.err, "");
  assert.equal(r.json.ok, false);
  assert.match(r.json.result.error, /PS-A\/fin is not open/);
});

// [rank#7]
test("no place option, two of them, a kind other than story or epic, or no item exit 2 (failure)", async () => {
  const f = mixed();
  for (const args of [
    ["rank", "story", "PS-A/open1"],
    ["rank", "story", "PS-A/open1", "--first", "--last"],
    ["rank", "story", "PS-A/open1", "--first", "--before", "PS-A/open2"],
    ["rank", "initiative", "faster", "--first"],
    ["rank", "story", "--first"],
  ]) {
    const r = await cli(f.proj, args);
    assert.equal(r.code, 2, args.join(" "));
  }
});

// ─── Contract 8: the plan, the question, the surfaces ──────────────────

// [rank#8]
test("bare, the plan lists each file with its old and new value and writes nothing; --json returns them as changes", async () => {
  const f = threeUnranked();
  const before = snapshot(f.proj);
  const bare = await cli(f.proj, ["rank", "story", "PS-X/d", "--after", "PS-X/c"]);
  assert.equal(bare.code, 0, bare.err);
  // d is already after c: nothing. Use b → after c.
  const r = await cli(f.proj, ["rank", "story", "PS-X/a", "--after", "PS-X/c"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /epics\/PS-X\/stories\/b\.md: rank none → 1048576/);
  assert.match(r.out, /3 files to write/);
  assert.match(r.out, /^Nothing written\./m);
  const cmd = packageCommand([], "rank", { args: "story PS-X/a --after PS-X/c --write" });
  assert.ok(
    r.out.split("\n").some((l) => l.trim() === cmd),
    r.out,
  );
  const j = await cli(f.proj, ["rank", "story", "PS-X/a", "--after", "PS-X/c"], { json: true });
  assert.equal(j.code, 0);
  assert.deepEqual(
    j.json.result.changes.map((c) => [c.path, c.from, c.to]),
    [
      ["epics/PS-X/stories/b.md", null, String(S)],
      ["epics/PS-X/stories/c.md", null, String(2 * S)],
      ["epics/PS-X/stories/a.md", null, String(3 * S)],
    ],
  );
  assert.deepEqual(snapshot(f.proj), before);
});

// [rank#8]
test("--write --json that writes two files lists them as written; a move that changes nothing returns changes []", async () => {
  const f = threeUnranked();
  const r = await cli(f.proj, ["rank", "story", "PS-X/c", "--after", "PS-X/a", "--write"], { json: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.result.written, ["epics/PS-X/stories/a.md", "epics/PS-X/stories/c.md"]);
  const same = await cli(f.proj, ["rank", "story", "PS-X/c", "--after", "PS-X/a"], { json: true });
  assert.equal(same.code, 0);
  assert.deepEqual(same.json.result.changes, []);
});

// [rank#8]
test("at a terminal a --write answered No exits 1 and writes nothing (edge)", async () => {
  const f = threeUnranked();
  const before = snapshot(f.proj);
  let preview = "";
  const r = await cli(f.proj, ["rank", "story", "PS-X/c", "--first", "--write"], {
    ask: async (q) => {
      preview = String(q);
      return false;
    },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(snapshot(f.proj), before);
  assert.ok(preview !== undefined);
  const d = await direct(f, ["story", "PS-X/c"], { first: true, write: true }, { confirm: async () => false });
  assert.equal(d.result.declined, true);
  assert.equal(d.text, "Nothing written.\n");
  // The question names the plan's file count.
  let n = null;
  await direct(
    f,
    ["story", "PS-X/a"],
    { after: "PS-X/c", write: true },
    {
      confirm: async (_preview, count) => {
        n = count;
        return false;
      },
    },
  );
  assert.equal(n, 3);
});

// [rank#8]
test("no hook entry and no MCP module reaches rank-verb.mjs; its row writes, has no MCP tool, and rank.mjs reaches no writer", async () => {
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  assert.ok(!Object.hasOwn(READ_HANDLERS, "rank"));
  const row = VERBS.find((v) => v.verb === "rank");
  assert.equal(row.writes, true);
  assert.equal(row.requiresBinding, true);
  assert.deepEqual([...row.mcp], []);
  assert.equal(row.module, "./rank-verb.mjs");
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp];
  for (const entry of entries)
    assert.ok(
      !closure(entry, { root: REPO, dispatch }).includes("scripts/rank-verb.mjs"),
      `${entry} reaches rank-verb.mjs`,
    );
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/rank-verb.mjs"));
  assert.match(read(join(REPO, "scripts", "cli.mjs")), /await import\("\.\/rank-verb\.mjs"\)/);
  const pure = closure("scripts/rank.mjs", { root: REPO, dispatch });
  for (const w of ["scripts/status-change.mjs", "scripts/rank-verb.mjs", "scripts/write-record.mjs"])
    assert.ok(!pure.includes(w), `rank.mjs reaches ${w}`);
});

// ─── Contract 9: the session record ────────────────────────────────────

const SID_ENV = sourceHarness().runtime.session_id_env;
const sessionEnv = (proj, sid) => hookEnv(proj, { [SID_ENV]: sid });

// [rank#9] [writerecord#5]
test("each file rank writes is one event with the tool rank, and none for a derived view", async () => {
  const f = threeUnranked();
  const sid = "sess-rank-1";
  const r = await cli(f.proj, ["rank", "story", "PS-X/c", "--after", "PS-X/a", "--write"], {
    env: sessionEnv(f.proj, sid),
  });
  assert.equal(r.code, 0, r.err);
  const ev = readEvents(f.proj, sid);
  assert.deepEqual(ev.map((e) => [e.rel, e.tool]).sort(), [
    ["epics/PS-X/stories/a.md", "rank"],
    ["epics/PS-X/stories/c.md", "rank"],
  ]);
});

// [rank#9] [writerecord#5]
test("a restore after a failed write is a second event for that file, ending at its old bytes (failure)", async () => {
  const f = threeUnranked();
  const sid = "sess-rank-3";
  const before = read(f.paths["PS-X/a"]);
  const env = sessionEnv(f.proj, sid);
  const r = await runRank({
    values: { after: "PS-X/b", write: true },
    positionals: ["story", "PS-X/d"],
    cfg: f.cfg,
    project: f.proj,
    env,
    confirm: null,
    afterCompute: (abs) => {
      if (abs === f.paths["PS-X/b"]) writeFileSync(abs, read(abs) + `drift ${Math.random()}\n`);
    },
  });
  assert.equal(r.code, 1);
  const ev = readEvents(f.proj, sid).filter((e) => e.rel === "epics/PS-X/stories/a.md");
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.tool === "rank"));
  // The restore starts where the write ended and ends where it began.
  assert.equal(ev[1].before, ev[0].after);
  assert.equal(ev[1].after, ev[0].before);
  assert.equal(read(f.paths["PS-X/a"]), before);
});

// [rank#9]
test("with no session id nothing is recorded, and the output is the same (edge)", async () => {
  const f = threeUnranked();
  const g = threeUnranked();
  const a = await cli(f.proj, ["rank", "story", "PS-X/c", "--first", "--write"]);
  const b = await cli(g.proj, ["rank", "story", "PS-X/c", "--first", "--write"], {
    env: sessionEnv(g.proj, "sess-rank-2"),
  });
  assert.equal(a.code, b.code);
  assert.equal(a.out, b.out);
  assert.equal(readEvents(g.proj, "sess-rank-2").length, 1);
  // The run with no session id left no record at all.
  let kept = [];
  try {
    kept = readdirSync(stateDir(f.proj)).filter((n) => n.endsWith(".writes"));
  } catch {}
  assert.deepEqual(kept, []);
});

// ─── Contract 10: doctor's rank-tie ────────────────────────────────────

// [rank#10]
test("two open stories of one epic at 5 are one rank-tie info finding; a done one at 5 is not named", async () => {
  const f = vault({
    epics: {
      "PS-X": {
        stories: [
          { slug: "a", rank: 5 },
          { slug: "b", rank: 5 },
          { slug: "c", rank: 5, status: "done" },
          { slug: "d", rank: 6 },
        ],
      },
    },
  });
  const ties = rankTies({
    stories: ["a", "b", "c", "d"].map((s) => ({
      rel: `epics/PS-X/stories/${s}.md`,
      epic: "PS-X",
      slug: s,
      fm: fmOf(f.paths[`PS-X/${s}`]),
    })),
  });
  assert.equal(ties.length, 1);
  assert.deepEqual(
    ties[0].members.map((x) => x.slug),
    ["a", "b"],
  );
  const findings = runVaultChecks({ vault_path: f.vault, layout: "engineering", language: "en" }, f.proj).filter(
    (x) => x.check === "rank-tie",
  );
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].level, "info");
  assert.match(findings[0].message, /PS-X\/a/);
  assert.match(findings[0].message, /PS-X\/b/);
  assert.doesNotMatch(findings[0].message, /PS-X\/c\b/);
  assert.match(findings[0].message, /\b5\b/);
});

// [rank#10]
test("two epics of one initiative at 5, and two of No initiative at 7, one with no type: line, are two rank-tie findings", () => {
  const f = vault({
    initiatives: ["faster"],
    epics: {
      "PS-A": { initiative: "faster", rank: 5 },
      "PS-B": { initiative: "faster", rank: 5 },
      "PS-C": { rank: 7 },
      "PS-D": { rank: 7, type: false },
    },
  });
  const findings = runVaultChecks({ vault_path: f.vault, layout: "engineering", language: "en" }, f.proj).filter(
    (x) => x.check === "rank-tie",
  );
  assert.equal(findings.length, 2, JSON.stringify(findings));
  assert.ok(findings.some((x) => /initiative faster/.test(x.message) && /PS-A, PS-B/.test(x.message)));
  assert.ok(findings.some((x) => /"No initiative"/.test(x.message) && /PS-C, PS-D/.test(x.message)));
});

// [rank#10]
test("rank-tie is a vault check only: doctor's startup checks never report it (edge)", () => {
  const f = vault({
    epics: {
      "PS-X": {
        stories: [
          { slug: "a", rank: 5 },
          { slug: "b", rank: 5 },
        ],
      },
    },
  });
  const cfg = { vault_path: f.vault, layout: "engineering", language: "en" };
  assert.ok(runVaultChecks(cfg, f.proj).some((x) => x.check === "rank-tie"));
  const r = runStartupChecks(cfg, f.proj, 60000);
  assert.ok(!r.findings.some((x) => x.check === "rank-tie"));
  const src = read(join(REPO, "scripts", "doctor.mjs"));
  const startup = src.slice(src.indexOf("export function runStartupChecks"), src.indexOf("// ─── CLI"));
  assert.doesNotMatch(startup, /rankTie|RankTies/);
});

// [rank#10]
test("two epics at 5 in two initiatives make no rank-tie finding (edge)", () => {
  const f = vault({
    initiatives: ["faster", "slower"],
    epics: { "PS-A": { initiative: "faster", rank: 5 }, "PS-B": { initiative: "slower", rank: 5 } },
  });
  const findings = runVaultChecks({ vault_path: f.vault, layout: "engineering", language: "en" }, f.proj).filter(
    (x) => x.check === "rank-tie",
  );
  assert.deepEqual(findings, []);
});

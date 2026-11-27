// projectstore — the create verb and the reviewed verb (spec "Create verbs and
// the not-reviewed mark: a file written outside a session, its refusals, the
// reviewed verb and the gates that read the mark", alias `create`, contracts 1
// to 6; PS-BACKLOG: "Create verbs for an initiative, an epic and a story that
// run outside an agent session"). The verbs run in process through the bin's
// run(), on scratch vaults rendered from the real templates. Each test names
// the contract it covers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { run } from "../scripts/cli.mjs";
import { loadTemplate, renderTemplate, parseFrontmatter, today, loadLayout } from "../scripts/lib.mjs";
import { runCreate, withMark, clearMark, NAME_LIMIT, TEMP_ROOM } from "../scripts/item-verbs.mjs";
import { renderDraft } from "../scripts/draft.mjs";
import { splitForEdit } from "../scripts/edit-cut.mjs";
import { readEvents } from "../scripts/write-record.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { makeVaultProject, writeBinding } from "./fixtures/vault.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const fm = (p) => parseFrontmatter(read(p)).data;
const LOCALES = readdirSync(join(REPO, "templates")).filter((d) =>
  existsSync(join(REPO, "templates", d, "epic.md.tmpl")),
);

// A vault with one epic, PS-X, rendered from the bound language's template,
// with its Stories table a header and a separator; and an initiative.
function vault({ lang = "en" } = {}) {
  const { proj, vault } = makeVaultProject();
  if (lang !== "en")
    writeBinding(proj, { vault_path: vault, layout: "engineering", language: lang, default_author: "Test" });
  const epic = renderTemplate(loadTemplate(lang, "epic"), { id: "PS-X", title: "Things", date: "2026-11-14", tags: [] })
    .split("\n")
    .filter((l) => !l.includes("](./stories/story-001.md)"))
    .join("\n");
  writeFileSync(join(vault, "epics", "PS-X", "epic.md"), epic);
  mkdirSync(join(vault, "initiatives"), { recursive: true });
  writeFileSync(
    join(vault, "initiatives", "faster-onboarding.md"),
    renderTemplate(loadTemplate(lang, "initiative"), {
      id: "faster-onboarding",
      title: "Faster onboarding",
      date: "2026-11-14",
      author: "Ada",
      tags: [],
    }),
  );
  writeFileSync(
    join(vault, "epics", "README.md"),
    "# Epics\n\n## Index\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n",
  );
  return { proj, vault, epicPath: join(vault, "epics", "PS-X", "epic.md") };
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
const SID = sourceHarness().runtime.session_id_env;
async function cli(proj, args, { ask = null, json = false, sid = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const env = { ...process.env, CI: "1" };
  delete env[SID];
  if (sid) env[SID] = sid;
  const code = await run([...args, ...(json ? ["--json"] : []), "--project", proj], {
    env,
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}
const storyAt = (v, slug) => join(v, "epics", "PS-X", "stories", `story-${slug}.md`);

// The draft.mjs output for the same input, as the agent command sees it.
function draftOf(proj, args) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "draft.mjs"), ...args], { cwd: proj, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
// A text without the mark's keys and the review keys a story never had.
const MARK_LINES = /^(?:written_by_verb: .*|review_status: pending|reviewed_at: null)\n/gm;

// ─── Contract 1: the verb, its forms and its consent ─────────────────

// [create#1]
test("create: bare, a story's plan names its path and its Stories row, nothing on disk changes, exit 0", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const r = await cli(fx.proj, ["create", "story", "PS-X", "Faster login"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /create story: epics\/PS-X\/stories\/story-faster-login\.md\n/);
  assert.match(
    r.out,
    /Stories row: \| \[story-faster-login\]\(\.\/stories\/story-faster-login\.md\) \| planned \| Faster login \|/,
  );
  const lines = r.out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Nothing written. To write it, from a terminal in "));
  assert.ok(at > 0 && lines[at].endsWith(":"), r.out);
  assert.equal(lines[at + 1], "  npx projectstore create story PS-X 'Faster login' --write");
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#1]
test("create: --write --json with no terminal asks nothing, writes the story, and the envelope's rel names it", async () => {
  const fx = vault();
  let asked = 0;
  const r = await cli(fx.proj, ["create", "story", "PS-X", "Faster login", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(asked, 0);
  assert.equal(r.json.result.rel, "epics/PS-X/stories/story-faster-login.md");
  for (const k of [
    "write",
    "kind",
    "path",
    "rel",
    "fields",
    "mark",
    "index",
    "row",
    "notes",
    "reconcile",
    "left",
    "declined",
    "error",
  ])
    assert.ok(k in r.json.result, k);
  assert.ok(existsSync(storyAt(fx.vault, "faster-login")));
});

// [create#1]
test("create: another kind, no title, an empty id, an option of another kind, a bad priority, an empty --initiative exit 2 and write nothing (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  for (const args of [
    ["create", "adr", "X"],
    ["create", "story", "PS-X"],
    ["create", "story", "", "X"],
    ["create", "story", "PS-X", "X", "--owner", "Y"],
    ["create", "story", "PS-X", "X", "--priority", "high"],
    ["create", "epic", "PS-Y", "X", "--initiative", ""],
    ["create"],
  ]) {
    const r = await cli(fx.proj, args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#1]
test("create: a title or an --assignee with a line break, a tab or only spaces exits 2 and writes nothing (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  for (const args of [
    ["create", "story", "PS-X", "a\nb"],
    ["create", "story", "PS-X", "a\tb"],
    ["create", "story", "PS-X", "   "],
    ["create", "story", "PS-X", "T", "--assignee", "Ann\nLee"],
    ["create", "story", "PS-X", "T", "--assignee", "a@b.c"],
  ]) {
    const r = await cli(fx.proj, [...args, "--write"]);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.err}`);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#1]
test("create: --write at a terminal and a No exits 1 with declined: true, and the vault is byte-identical (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const r = await cli(fx.proj, ["create", "story", "PS-X", "T", "--write"], { ask: async () => false });
  assert.equal(r.code, 1);
  assert.match(r.err, /Nothing written\./);
  assert.deepEqual(snapshot(fx.proj), before);
  const j = await runCreate({
    values: { write: true },
    positionals: ["story", "PS-X", "T"],
    cfg: { vault_path: fx.vault, layout: "engineering", language: "en" },
    project: fx.proj,
    env: {},
    confirm: async () => false,
  });
  assert.equal(j.result.declined, true);
});

// ─── Contract 2: the file is the draft's ─────────────────────────────

// [create#2]
test("create: for each kind and each bundled locale, the file is draft.mjs's content but for the option fields, an epic's placeholder row and the mark", async () => {
  for (const lang of LOCALES) {
    const fx = vault({ lang });
    for (const [kind, args, path] of [
      ["initiative", ["Ship it"], join(fx.vault, "initiatives", "ship-it.md")],
      ["epic", ["PS-Z", "Ship it"], join(fx.vault, "epics", "PS-Z", "epic.md")],
      ["story", ["PS-X", "Ship it"], storyAt(fx.vault, "ship-it")],
    ]) {
      const d = draftOf(fx.proj, [kind, ...args]);
      const r = await cli(fx.proj, ["create", kind, ...args, "--write"]);
      assert.equal(r.code, 0, `${lang} ${kind}: ${r.err}`);
      let want = d.content;
      if (kind === "epic") want = want.replace(/^\|[^\n]*\]\(\.\/stories\/story-001\.md\)[^\n]*\|\n/m, "");
      const got = read(path).replace(MARK_LINES, "");
      const wantNoReview = want.replace(/^(?:review_status: pending|reviewed_at: null)\n/gm, "");
      assert.equal(got, wantNoReview, `${lang} ${kind}`);
    }
  }
});

// [create#2]
test("create: --priority and --assignee set the frontmatter and the header's Priority and Assignee rows", async () => {
  const fx = vault();
  const r = await cli(fx.proj, [
    "create",
    "story",
    "PS-X",
    "T",
    "--priority",
    "P1",
    "--assignee",
    "Ann Lee",
    "--write",
  ]);
  assert.equal(r.code, 0, r.err);
  const t = read(storyAt(fx.vault, "t"));
  assert.match(t, /^priority: p1$/m);
  assert.match(t, /^assignee: "Ann Lee"$/m);
  assert.match(t, /^\| \*\*Priority\*\* \| p1 \|$/m);
  assert.match(t, /^\| \*\*Assignee\*\* \| Ann Lee \|$/m);
});

// [create#2]
test("create: an epic with --initiative gets what epic --initiative writes, an empty Stories table, and its row in epics/README.md", async () => {
  const fx = vault();
  const r = await cli(fx.proj, ["create", "epic", "PS-Y", "T", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(r.code, 0, r.err);
  const created = read(join(fx.vault, "epics", "PS-Y", "epic.md"));
  // The same epic, made by the agent command's draft, then set by epic --initiative.
  const other = vault();
  const d = draftOf(other.proj, ["epic", "PS-Y", "T"]);
  mkdirSync(join(other.vault, "epics", "PS-Y", "stories"), { recursive: true });
  writeFileSync(join(other.vault, "epics", "PS-Y", "epic.md"), d.content);
  const e = await cli(other.proj, ["epic", "PS-Y", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(e.code, 0, e.err);
  const viaVerb = read(join(other.vault, "epics", "PS-Y", "epic.md"));
  const lineOf = (t, re) => t.split("\n").find((l) => re.test(l));
  assert.equal(lineOf(created, /^initiative: /), lineOf(viaVerb, /^initiative: /));
  assert.equal(lineOf(created, /^\| \*\*Initiative\*\* /), lineOf(viaVerb, /^\| \*\*Initiative\*\* /));
  assert.ok(!/\]\(\.\/stories\//.test(created), "no Stories row");
  assert.ok(statSync(join(fx.vault, "epics", "PS-Y", "stories")).isDirectory());
  assert.match(read(join(fx.vault, "epics", "README.md")), /\| \[PS-Y\]\(\.\/PS-Y\/epic\.md\) \|/);
});

// [create#2]
test("create: --initiative naming no initiative exits 1 and writes nothing (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const r = await cli(fx.proj, ["create", "epic", "PS-Y", "T", "--initiative", "nope", "--write"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /names no initiative/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// ─── Contract 3: the refusals ────────────────────────────────────────

// [create#3]
test("create: an existing file, or a numbered-era file of the same identity, is refused with its name, and the vault is byte-identical (failure)", async () => {
  const fx = vault();
  writeFileSync(storyAt(fx.vault, "faster-login"), "---\nid: x\n---\n");
  writeFileSync(join(fx.vault, "epics", "PS-X", "stories", "story-006-slow-login.md"), "---\nid: y\n---\n");
  const before = snapshot(fx.proj);
  const a = await cli(fx.proj, ["create", "story", "PS-X", "Faster login", "--write"]);
  assert.equal(a.code, 1);
  assert.match(a.err, /story-faster-login\.md exists/);
  const b = await cli(fx.proj, ["create", "story", "PS-X", "Slow login", "--write"]);
  assert.equal(b.code, 1);
  assert.match(b.err, /story-006-slow-login\.md/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#3]
test("create: the ids .., ., A/B, A\\B and, for a new epic, .hidden and 'A B' are refused; a new epic ЭПИК-1 is written (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  for (const [kind, id] of [
    ["epic", ".."],
    ["epic", "."],
    ["story", ".."],
    ["story", "A/B"],
    ["epic", "A\\B"],
    ["epic", ".hidden"],
    ["epic", "A B"],
  ]) {
    const r = await cli(fx.proj, ["create", kind, id, "T", "--write"]);
    assert.equal(r.code, 1, `${kind} ${id}: ${r.out}${r.err}`);
  }
  assert.deepEqual(snapshot(fx.proj), before);
  const ok = await cli(fx.proj, ["create", "epic", "ЭПИК-1", "T", "--write"]);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(existsSync(join(fx.vault, "epics", "ЭПИК-1", "epic.md")));
});

// [create#3]
test("create: an epic folder that is a link to a folder outside the vault holding an epic.md is refused, and nothing is written there or here (failure)", async () => {
  const fx = vault();
  const outside = mkdtempSync(join(tmpdir(), "ps-outside-"));
  writeFileSync(join(outside, "epic.md"), read(fx.epicPath));
  symlinkSync(outside, join(fx.vault, "epics", "LINK"));
  const before = snapshot(fx.proj);
  const r = await cli(fx.proj, ["create", "story", "LINK", "T", "--write"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /not inside the vault's epics folder/);
  assert.deepEqual(readdirSync(outside), ["epic.md"]);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#3]
test("create: a story file name of 240 bytes is refused, and one of 239 is written (edge)", async () => {
  const fx = vault();
  // story-<slug>.md: 6 + slug + 3 bytes.
  const title = (n) => "a".repeat(n - 9);
  assert.equal(NAME_LIMIT - TEMP_ROOM, 239);
  const long = await cli(fx.proj, ["create", "story", "PS-X", title(240), "--write"]);
  assert.equal(long.code, 1, long.out);
  assert.match(long.err, /240 bytes/);
  const fits = await cli(fx.proj, ["create", "story", "PS-X", title(239), "--write"]);
  assert.equal(fits.code, 0, fits.err);
});

// [create#3]
test("create: a missing stories/ or initiatives/ folder is made, and the file is written in it (edge)", async () => {
  const { proj, vault: v } = makeVaultProject();
  writeFileSync(
    join(v, "epics", "PS-X", "epic.md"),
    renderTemplate(loadTemplate("en", "epic"), { id: "PS-X", title: "T", date: "2026-11-14", tags: [] }),
  );
  spawnSync("rm", ["-rf", join(v, "epics", "PS-X", "stories")]);
  const s = await cli(proj, ["create", "story", "PS-X", "T", "--write"]);
  assert.equal(s.code, 0, s.err);
  assert.ok(existsSync(join(v, "epics", "PS-X", "stories", "story-t.md")));
  const i = await cli(proj, ["create", "initiative", "Grow", "--write"]);
  assert.equal(i.code, 0, i.err);
  assert.ok(existsSync(join(v, "initiatives", "grow.md")));
});

// [create#3]
test("create: a file made by another writer between the plan and the write is kept; exit 1, and no row or view is written (failure)", async () => {
  const fx = vault();
  const theirs = "---\nid: theirs\n---\n";
  const epicBefore = read(fx.epicPath);
  const r = await runCreate({
    values: { write: true },
    positionals: ["story", "PS-X", "Race"],
    cfg: { vault_path: fx.vault, layout: "engineering", language: "en" },
    project: fx.proj,
    env: {},
    confirm: async () => {
      writeFileSync(storyAt(fx.vault, "race"), theirs);
      return true;
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /made by another writer/);
  assert.equal(read(storyAt(fx.vault, "race")), theirs);
  assert.equal(read(fx.epicPath), epicBefore);
});

// ─── Contract 4: the mark ────────────────────────────────────────────

// [create#4]
test("create: an epic's and an initiative's mark is the line before review_status: pending, and reviewed_at: null follows", async () => {
  const fx = vault();
  await cli(fx.proj, ["create", "epic", "PS-Y", "T", "--write"]);
  await cli(fx.proj, ["create", "initiative", "Grow", "--write"]);
  for (const p of [join(fx.vault, "epics", "PS-Y", "epic.md"), join(fx.vault, "initiatives", "grow.md")]) {
    const lines = read(p).split("\n");
    const k = lines.findIndex((l) => l.startsWith("written_by_verb: "));
    assert.match(lines[k], /^written_by_verb: "create \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"$/);
    assert.equal(lines[k + 1], "review_status: pending");
    assert.equal(lines[k + 2], "reviewed_at: null");
    assert.equal(lines.filter((l) => l.startsWith("review_status:")).length, 1, p);
  }
});

// [create#4]
test("create: a story's three lines follow plan_updated_at: null; with no such key they go last", () => {
  const story = renderTemplate(loadTemplate("en", "story"), {
    id: "s",
    epic_id: "PS-X",
    title: "T",
    date: "2026-11-14",
    author: "A",
    tags: [],
  });
  const t = withMark(story, "create 2026-11-19T06:00:00Z");
  assert.match(
    t,
    /plan_updated_at: null\nwritten_by_verb: "create 2026-11-19T06:00:00Z"\nreview_status: pending\nreviewed_at: null\n---/,
  );
  const bare = withMark("---\nid: x\n---\n\n# X\n", "create 2026-11-19T06:00:00Z");
  assert.equal(
    bare,
    '---\nid: x\nwritten_by_verb: "create 2026-11-19T06:00:00Z"\nreview_status: pending\nreviewed_at: null\n---\n\n# X\n',
  );
});

// [create#4]
test("create: two creates a second apart carry different instants (edge)", async () => {
  const fx = vault();
  const make = (title, now) =>
    runCreate({
      values: { write: true },
      positionals: ["story", "PS-X", title],
      cfg: { vault_path: fx.vault, layout: "engineering", language: "en" },
      project: fx.proj,
      env: {},
      now,
    });
  await make("One", "2026-11-19T06:00:00.000Z");
  await make("Two", "2026-11-19T06:00:01.000Z");
  assert.equal(fm(storyAt(fx.vault, "one")).written_by_verb, "create 2026-11-19T06:00:00Z");
  assert.equal(fm(storyAt(fx.vault, "two")).written_by_verb, "create 2026-11-19T06:00:01Z");
});

// ─── Contract 5: the write set, the record, a failure after the write ─

// [create#5]
test("create: in an en and a ru epic whose Stories table is a header and a separator, the story gets one row and kanban.md carries it", async () => {
  for (const lang of ["en", "ru"]) {
    const fx = vault({ lang });
    const r = await cli(fx.proj, ["create", "story", "PS-X", "Faster login", "--write"], { json: true });
    assert.equal(r.code, 0, r.err);
    const rows = read(fx.epicPath)
      .split("\n")
      .filter((l) => l.includes("](./stories/"));
    assert.deepEqual(
      rows,
      ["| [story-faster-login](./stories/story-faster-login.md) | planned | Faster login |"],
      lang,
    );
    assert.match(read(join(fx.vault, "kanban.md")), /story-faster-login/);
  }
});

// [create#5]
test("create: a Stories row with no link whose Story cell is the title gets the link, and no row is added (edge)", async () => {
  const fx = vault();
  writeFileSync(
    fx.epicPath,
    read(fx.epicPath).replace(
      "|-------|--------|-------------|\n",
      "|-------|--------|-------------|\n| Faster login | planned | soon |\n",
    ),
  );
  const r = await cli(fx.proj, ["create", "story", "PS-X", "Faster login", "--write"]);
  assert.equal(r.code, 0, r.err);
  const rows = read(fx.epicPath)
    .split("\n")
    .filter((l) => l.includes("Faster login"));
  assert.deepEqual(rows, ["| [Faster login](./stories/story-faster-login.md) | planned | soon |"]);
});

// [create#5]
test("create: an epic whose Stories section is a list gets no row; the story is written, the note is epic-row-missing, exit 0 (edge)", async () => {
  const fx = vault();
  const listed = read(fx.epicPath).replace(
    /\| Story \| Status \| Description \|\n\|-------\|--------\|-------------\|\n/,
    "- the first one\n",
  );
  writeFileSync(fx.epicPath, listed);
  const r = await cli(fx.proj, ["create", "story", "PS-X", "T", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.result.notes, ["epic-row-missing"]);
  assert.equal(read(fx.epicPath), listed);
  assert.ok(existsSync(storyAt(fx.vault, "t")));
});

// [create#5] [writerecord#5]
test("create: with a session id, the record holds the story with no before and its epic.md, tool create, and no derived view; reviewed then adds the story, tool reviewed", async () => {
  const fx = vault();
  const r = await cli(fx.proj, ["create", "story", "PS-X", "T", "--write"], { sid: "s1" });
  assert.equal(r.code, 0, r.err);
  const v = await cli(fx.proj, ["reviewed", "epics/PS-X/stories/story-t.md", "--write"], { sid: "s1" });
  assert.equal(v.code, 0, v.err);
  const events = readEvents(fx.proj, "s1");
  const seen = events.map((e) => [e.rel, e.tool, e.before ?? null]);
  assert.deepEqual(
    seen.map(([rel, tool]) => [rel, tool]),
    [
      ["epics/PS-X/stories/story-t.md", "create"],
      ["epics/PS-X/epic.md", "create"],
      ["epics/PS-X/stories/story-t.md", "reviewed"],
    ],
    JSON.stringify(events),
  );
  assert.equal(seen[0][2], null, "the new file has no before");
});

// [create#5]
test("create: an epic that changes before each of the three replaces: the story stays, the views refresh, exit 1 and left names the Stories row (failure)", async () => {
  const fx = vault();
  let n = 0;
  const r = await runCreate({
    values: { write: true },
    positionals: ["story", "PS-X", "T"],
    cfg: { vault_path: fx.vault, layout: "engineering", language: "en" },
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () => writeFileSync(fx.epicPath, read(fx.epicPath) + `\n<!-- edit ${++n} -->\n`),
  });
  assert.equal(r.code, 1, r.text);
  assert.ok(existsSync(storyAt(fx.vault, "t")));
  assert.deepEqual(
    r.result.left.map((l) => l.what),
    ["the Stories row"],
  );
  assert.match(r.text, /left: the Stories row/);
  assert.match(r.text, /status-change\.mjs'? epic-row .* --add/);
  assert.match(read(fx.epicPath), /<!-- edit 3 -->/);
  assert.ok(!/\]\(\.\/stories\/story-t\.md\)/.test(read(fx.epicPath)));
  assert.ok(existsSync(join(fx.vault, "kanban.md")), "the views were refreshed");
});

// [create#5]
test("create: a derived view that cannot be written leaves the file; exit 1, left names the views, and a second run refuses the path (failure)", async () => {
  const fx = vault();
  mkdirSync(join(fx.vault, "kanban.md"));
  const r = await cli(fx.proj, ["create", "initiative", "Grow", "--write"], { json: true });
  assert.equal(r.code, 1, JSON.stringify(r.json));
  assert.ok(existsSync(join(fx.vault, "initiatives", "grow.md")));
  assert.deepEqual(
    r.json.result.left.map((l) => l.what),
    ["the derived views"],
  );
  const again = await cli(fx.proj, ["create", "initiative", "Grow", "--write"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /exists/);
});

// ─── Contract 6: reviewed ────────────────────────────────────────────

// [create#6]
test("reviewed: a created story loses its mark, review_status and reviewed_at take its place, and the rest is byte-identical", async () => {
  const fx = vault();
  await cli(fx.proj, ["create", "story", "PS-X", "T", "--write"]);
  const before = read(storyAt(fx.vault, "t"));
  const r = await cli(fx.proj, ["reviewed", storyAt(fx.vault, "t"), "--write"]);
  assert.equal(r.code, 0, r.err);
  const after = read(storyAt(fx.vault, "t"));
  assert.equal(
    after,
    before.replace(
      /^written_by_verb: .*\nreview_status: pending\nreviewed_at: null\n/m,
      `review_status: reviewed\nreviewed_at: ${today()}\n`,
    ),
  );
  // Then the file differs from the draft only by the review keys (spec Acceptance).
  const d = draftOf(fx.proj, ["story", "PS-X", "T"]);
  assert.equal(after.replace(/^review_status: reviewed\nreviewed_at: .*\n/m, ""), d.content);
});

// [create#6]
test("reviewed: an epic with review_status: pending and no mark is byte-identical, the output says so, exit 0 (edge)", async () => {
  const fx = vault();
  const before = read(fx.epicPath);
  const r = await cli(fx.proj, ["reviewed", "epics/PS-X/epic.md", "--write"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /has no written_by_verb mark; nothing to clear/);
  assert.equal(read(fx.epicPath), before);
});

// [create#6]
test("reviewed: a path outside the vault, a missing file, and a link inside the vault to a file outside are refused, exit 1 (failure)", async () => {
  const fx = vault();
  const outside = join(mkdtempSync(join(tmpdir(), "ps-out-")), "x.md");
  writeFileSync(outside, '---\nwritten_by_verb: "create 2026-11-19T06:00:00Z"\n---\n');
  symlinkSync(outside, join(fx.vault, "epics", "PS-X", "stories", "story-link.md"));
  const before = read(outside);
  for (const p of [outside, "epics/PS-X/stories/story-none.md", "epics/PS-X/stories/story-link.md"]) {
    const r = await cli(fx.proj, ["reviewed", p, "--write"]);
    assert.equal(r.code, 1, `${p}: ${r.out}`);
  }
  assert.equal(read(outside), before);
  const usage = await cli(fx.proj, ["reviewed"]);
  assert.equal(usage.code, 2);
});

// [create#6]
test("reviewed: clearMark sets the keys in place, or where the mark was when they are absent", () => {
  assert.equal(
    clearMark('---\nid: x\nwritten_by_verb: "create 2026-11-19T06:00:00Z"\ntitle: t\n---\n', "2026-11-20"),
    "---\nid: x\nreview_status: reviewed\nreviewed_at: 2026-11-20\ntitle: t\n---\n",
  );
  assert.equal(clearMark("---\nid: x\n---\n", "2026-11-20"), null);
});

// [create#1] [create#6]
test("no hook entry and no MCP module reaches item-verbs.mjs, both rows write with no MCP tool, and the module starts nothing of its own", async () => {
  const { VERBS } = await import("../scripts/cli.mjs");
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  const { closure, hookEntries, verbModuleSpecifiers } = await import("./fixtures/imports.mjs");
  for (const verb of ["create", "reviewed", "edit"]) {
    assert.ok(!Object.hasOwn(READ_HANDLERS, verb), `the read runner does not serve ${verb}`);
    const row = VERBS.find((v) => v.verb === verb);
    assert.equal(row.writes, true, verb);
    assert.equal(row.requiresBinding, true, verb);
    assert.deepEqual([...row.mcp], [], verb);
    assert.equal(row.module, "./item-verbs.mjs", verb);
  }
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
      !closure(entry, { root: REPO, dispatch }).includes("scripts/item-verbs.mjs"),
      `${entry} reaches item-verbs.mjs`,
    );
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/item-verbs.mjs"));
  const src = read(join(REPO, "scripts", "item-verbs.mjs")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /child_process|spawn|fetch\(|node:https?|\bgit\b/, "the verbs start nothing of their own");
});

// [create#3]
test("create: a story's epic id naming no folder, or a folder with no epic.md, is refused, exit 1, and the vault is byte-identical (failure)", async () => {
  const fx = vault();
  mkdirSync(join(fx.vault, "epics", "EMPTY", "stories"), { recursive: true });
  const before = snapshot(fx.proj);
  for (const id of ["NOPE", "EMPTY"]) {
    const r = await cli(fx.proj, ["create", "story", id, "T", "--write"]);
    assert.equal(r.code, 1, `${id}: ${r.out}`);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#3]
test("create: an epic id of 256 bytes is refused, exit 1, and the vault is byte-identical (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const r = await cli(fx.proj, ["create", "epic", "a".repeat(256), "T", "--write"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /256 bytes; one name holds at most 255/);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#6]
test("reviewed: with the vault bound through a link, the file's real path is inside it and its mark is cleared (edge)", async () => {
  const fx = vault();
  await cli(fx.proj, ["create", "story", "PS-X", "T", "--write"]);
  const link = join(fx.proj, "vaultlink");
  symlinkSync(fx.vault, link);
  writeBinding(fx.proj, { vault_path: link, layout: "engineering", language: "en", default_author: "Test" });
  const real = join(realpathSync(fx.vault), "epics", "PS-X", "stories", "story-t.md");
  const r = await cli(fx.proj, ["reviewed", real, "--write"], { json: true });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.result.rel, "epics/PS-X/stories/story-t.md");
  assert.equal(fm(real).review_status, "reviewed");
});

// [create#2]
test("create: in each bundled locale, a created epic's Stories table links no story (edge)", async () => {
  for (const lang of LOCALES) {
    const fx = vault({ lang });
    const r = await cli(fx.proj, ["create", "epic", "PS-Z", "T", "--write"]);
    assert.equal(r.code, 0, `${lang}: ${r.err}`);
    assert.ok(!/\]\(\.\/stories\//.test(read(join(fx.vault, "epics", "PS-Z", "epic.md"))), lang);
  }
});

// ─── Contract 12: a text and its pictures at create ──────────────────

const textFile = (content, name = "t.md") => {
  const p = join(mkdtempSync(join(tmpdir(), "create-text-")), name);
  writeFileSync(p, content);
  return p;
};
// The body a kind's draft gives after the edit verb's cut, as `edit <path>` prints it.
const bodyOfDraft = (content) => splitForEdit(parseFrontmatter(content).body).body;
const NO_MARK = (s) => s.replace(/^written_by_verb: .*\n/m, "");

// [create#12]
test("create: --from writes the draft's head with the text as its body, equal to create then edit but for the mark's value", async () => {
  for (const [kind, args, rel] of [
    ["story", ["PS-X", "Faster login"], "epics/PS-X/stories/story-faster-login.md"],
    ["epic", ["PS-Q", "Sign-in"], "epics/PS-Q/epic.md"],
    ["initiative", ["Better search"], "initiatives/better-search.md"],
  ]) {
    const a = vault();
    const b = vault();
    const made = await cli(b.proj, ["create", kind, ...args, "--write"]);
    assert.equal(made.code, 0, made.err);
    const shown = await cli(b.proj, ["edit", rel], { json: true });
    const { body, hash } = shown.json.result;
    assert.equal(body.search(/^## /m), 0, `${kind}: the template's body starts with a section`);
    const first = body.indexOf("\n");
    const text = `${body.slice(0, first + 1)}\nA line typed in the panel.\n${body.slice(first + 1)}`;
    const f = textFile(text);
    const e = await cli(b.proj, ["edit", rel, "--from", f, "--base", hash, "--write"]);
    assert.equal(e.code, 0, e.err);
    const r = await cli(a.proj, ["create", kind, ...args, "--from", f, "--write"], { json: true });
    assert.equal(r.code, 0, `${kind}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.result.rel, rel);
    assert.ok(!("files" in r.json.result), "no files key without --attach");
    const mine = read(join(a.vault, rel));
    assert.ok(mine.includes("A line typed in the panel."), kind);
    assert.match(mine, /^written_by_verb: "create \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"$/m);
    assert.equal(NO_MARK(mine), NO_MARK(read(join(b.vault, rel))), kind);
  }
});

// [create#12]
test("create: --from in the plan names the sections the text changes and the --from in the command, and writes nothing", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const body = bodyOfDraft(draftOf(fx.proj, ["story", "PS-X", "Faster login"]).content);
  const f = textFile(body.replace("## Description\n", "## Description\n\nWhy.\n"));
  const r = await cli(fx.proj, ["create", "story", "PS-X", "Faster login", "--from", f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\n {2}text: Description\n/);
  assert.ok(r.out.includes(`create story PS-X 'Faster login' --from ${f} --write`), r.out);
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#12]
test("create: a text the edit guards refuse exits 1 with the guard's words, bare and with --write, and nothing is written (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const story = bodyOfDraft(draftOf(fx.proj, ["story", "PS-X", "Faster login"]).content);
  const epic = bodyOfDraft(draftOf(fx.proj, ["epic", "PS-Q", "Sign-in"]).content);
  const ini = bodyOfDraft(draftOf(fx.proj, ["initiative", "Better search"]).content);
  const outcome = /^## Outcome[^\n]*\n/m.exec(ini)?.[0];
  assert.ok(outcome, "the initiative template has an Outcome section");
  const cases = [
    [
      ["story", "PS-X", "Faster login"],
      `${story.trimEnd()}\n\n## Status log\n\n- a line\n`,
      /the Status log is written by gates and verbs/,
    ],
    [
      ["story", "PS-X", "Faster login"],
      story.replace(/(## Acceptance Criteria[\s\S]*?)^- \[ \][^\n]*$/m, "$1- [x] It works"),
      /A checked item of the Acceptance Criteria/,
    ],
    [
      ["epic", "PS-Q", "Sign-in"],
      epic.replace(/(## Expected Results[\s\S]*?)^- \[ \][^\n]*$/m, "$1- [x] Sign-in works"),
      /A checked item of the Expected Results/,
    ],
    [
      ["initiative", "Better search"],
      ini.replace(outcome, `${outcome}\nDone already.\n`),
      /the Outcome is written by gates/,
    ],
    [["story", "PS-X", "Faster login"], `Words above the sections.\n\n${story}`, /must start with a `## ` section/],
    [
      ["story", "PS-X", "Faster login"],
      `${story.trimEnd()}\n\n---\n\n*Last updated: 2026-11-27*\n`,
      /"Last updated" line/,
    ],
  ];
  for (const [args, text, words] of cases) {
    const f = textFile(text);
    for (const write of [false, true]) {
      const r = await cli(fx.proj, ["create", ...args, "--from", f, ...(write ? ["--write"] : [])], { json: true });
      assert.equal(r.code, 1, `${args[0]} ${words}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.result.error, words);
    }
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#12]
test("create: an unreadable, non-UTF-8, empty, NUL-holding or too long --from, and --attach with no --from or a missing file, exit 2 and write nothing (failure)", async () => {
  const fx = vault();
  const before = snapshot(fx.proj);
  const dir = mkdtempSync(join(tmpdir(), "create-bad-"));
  const bin = join(dir, "bin.md");
  writeFileSync(bin, Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe, 0x0a]));
  const cases = [
    [["--from", join(dir, "missing.md")], /--from .* cannot be read/],
    [["--from", dir], /--from .* is not a file/],
    [["--from", bin], /is not UTF-8 text/],
    [["--from", textFile("  \n\n")], /the text is empty/],
    [["--from", textFile("## Description\n\0\n")], /holds a NUL character/],
    [["--from", textFile(`## Description\n\n${"a".repeat(500001)}\n`)], /create takes at most 500000/],
    [["--attach", textFile("x", "shot.png")], /create --attach needs --from <file>/],
    [["--from", textFile("## Description\n"), "--attach", join(dir, "gone.png")], /--attach .* cannot be read/],
  ];
  for (const [extra, words] of cases) {
    const r = await cli(fx.proj, ["create", "story", "PS-X", "T", ...extra, "--write"]);
    assert.equal(r.code, 2, `${words}: ${r.out}${r.err}`);
    assert.match(r.err, words);
  }
  assert.deepEqual(snapshot(fx.proj), before);
});

// [create#12]
test("create: in each bundled locale, the body a kind's draft gives after the cut is the same for two titles, IDs and epics (edge)", () => {
  for (const lang of LOCALES) {
    const fx = vault({ lang });
    mkdirSync(join(fx.vault, "epics", "PS-Y"), { recursive: true });
    writeFileSync(join(fx.vault, "epics", "PS-Y", "epic.md"), read(fx.epicPath));
    const cfg = { vault_path: fx.vault, layout: "engineering", language: lang, default_author: "Test" };
    const layout = loadLayout("engineering");
    const body = (kind, args) => bodyOfDraft(renderDraft(cfg, layout, kind, args).content);
    for (const [kind, one, two] of [
      ["story", ["PS-X", "Faster login"], ["PS-Y", "Другое название"]],
      ["epic", ["PS-Q", "Sign-in"], ["ЭПИК-2", "Something else"]],
      ["initiative", ["Better search"], ["Untitled"]],
    ]) {
      const a = body(kind, one);
      assert.ok(a.startsWith("## "), `${lang} ${kind}`);
      assert.equal(a, body(kind, two), `${lang} ${kind}`);
      for (const w of one) assert.ok(!a.includes(w), `${lang} ${kind} names ${w}`);
    }
  }
});

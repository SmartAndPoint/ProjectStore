// projectstore — the edit verb (spec "The edit verb: an item's sections
// replaced against a base hash, with guards for what gates and verbs own, and
// the not-reviewed mark", alias `edit`; PS-BACKLOG: "An edit verb writes an
// item's text with its guards and marks it not reviewed"). The verb runs in
// process through the bin's run(), on scratch vaults whose story, epic and
// initiative the create verb writes from the real templates. Each test names
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
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../scripts/cli.mjs";
import { parseFrontmatter } from "../scripts/lib.mjs";
import { runEdit } from "../scripts/item-verbs.mjs";
import { splitForEdit, bodyHash, guardEdit } from "../scripts/edit-cut.mjs";
import { readEvents } from "../scripts/write-record.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { loadTemplate, renderTemplate } from "../scripts/lib.mjs";

const read = (p) => readFileSync(p, "utf8");
const fm = (p) => parseFrontmatter(read(p)).data;
const sink = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
const SID = sourceHarness().runtime.session_id_env;
async function cli(proj, args, { ask = null, sid = null, json = true } = {}) {
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
  let parsed = null;
  try {
    parsed = JSON.parse(stdout.text);
  } catch {}
  return { code, out: stdout.text, err: stderr.text, json: parsed };
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

const STORY = "epics/PS-X/stories/story-faster-login.md";
const EPIC = "epics/PS-X/epic.md";
const INIT = "initiatives/grow.md";

// A vault with an epic PS-X, a story in it moved to ToDo (so it has a Status
// log), and an initiative; each written by the core's own verbs.
async function vault() {
  const { proj, vault } = makeVaultProject();
  const epic = renderTemplate(loadTemplate("en", "epic"), { id: "PS-X", title: "Things", date: "2026-11-14", tags: [] })
    .split("\n")
    .filter((l) => !l.includes("](./stories/story-001.md)"))
    .join("\n");
  writeFileSync(join(vault, EPIC), epic);
  writeFileSync(
    join(vault, "epics", "README.md"),
    "# Epics\n\n## Index\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n",
  );
  mkdirSync(join(vault, "initiatives"), { recursive: true });
  for (const args of [
    ["create", "story", "PS-X", "Faster login", "--write"],
    ["create", "initiative", "Grow", "--write"],
    ["move", "PS-X/story-faster-login", "todo", "--reason", "next up", "--write"],
  ]) {
    const r = await cli(proj, args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
  }
  return { proj, vault, at: (rel) => join(vault, rel) };
}
const notUtf8 = () => {
  const d = mkdtempSync(join(tmpdir(), "edit-text-"));
  const p = join(d, "text.md");
  writeFileSync(p, Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe, 0x0a]));
  return p;
};
const tmpText = (text) => {
  const d = mkdtempSync(join(tmpdir(), "edit-text-"));
  const p = join(d, "text.md");
  writeFileSync(p, text);
  return p;
};
async function readBody(fx, rel) {
  const r = await cli(fx.proj, ["edit", rel]);
  assert.equal(r.code, 0, r.err + r.out);
  return r.json.result;
}
// The body with `from` replaced by `to`, written with --write; the result.
async function edit(fx, rel, change, { write = true, base = null, sid = null, ask = null, json = true } = {}) {
  const now = await readBody(fx, rel);
  const text = typeof change === "function" ? change(now.body) : change;
  const args = ["edit", rel, "--from", tmpText(text), "--base", base ?? now.hash, ...(write ? ["--write"] : [])];
  return cli(fx.proj, args, { sid, ask, json });
}
// A refusal leaves the vault byte-identical.
async function refuses(fx, rel, change, match, opts = {}) {
  const before = snapshot(fx.vault);
  const r = await edit(fx, rel, change, opts);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.json.result.error, match);
  assert.deepEqual(snapshot(fx.vault), before);
  return r;
}

// ─── Contract 1 ───────────────────────────────────────────────────────

// [edit#1]
test("edit: the read form prints the body and its hash, by a relative and an absolute path, and writes nothing", async () => {
  const fx = await vault();
  const before = snapshot(fx.vault);
  const a = await readBody(fx, STORY);
  const b = (await cli(fx.proj, ["edit", fx.at(STORY)])).json.result;
  assert.equal(a.hash, b.hash);
  assert.match(a.body, /^## Description/);
  assert.equal(a.hash, bodyHash(a.body));
  assert.deepEqual(snapshot(fx.vault), before);
});

// [edit#1]
test("edit: bare with --from and --base prints the plan's sections and writes nothing; --write writes and gives the new body's hash", async () => {
  const fx = await vault();
  const before = snapshot(fx.vault);
  const plan = await edit(fx, STORY, (b) => b.replace("## Description\n", "## Description\n\nLogin in one step.\n"), {
    write: false,
  });
  assert.equal(plan.code, 0, plan.out);
  assert.deepEqual(plan.json.result.sections, ["Description"]);
  assert.deepEqual(snapshot(fx.vault), before);
  const w = await edit(fx, STORY, (b) => b.replace("## Description\n", "## Description\n\nLogin in one step.\n"));
  assert.equal(w.code, 0, w.out);
  assert.equal(w.json.result.written, true);
  assert.equal(w.json.result.hash, (await readBody(fx, STORY)).hash);
  assert.match(read(fx.at(STORY)), /Login in one step\./);
});

// [edit#1]
test("edit: usage errors exit 2 and write nothing (failure)", async () => {
  const fx = await vault();
  const before = snapshot(fx.vault);
  const { hash } = await readBody(fx, STORY);
  const t = tmpText("## Description\n\nx\n");
  for (const args of [
    ["edit", STORY, "--from", t],
    ["edit", STORY, "--base", hash],
    ["edit", STORY, "--write"],
    ["edit", STORY, "--from", t, "--base", "abc"],
    ["edit", STORY, "--from", tmpText("## A\n" + "x".repeat(500001)), "--base", hash],
    ["edit", STORY, "--from", tmpText("## A\n\u0000"), "--base", hash],
    ["edit", STORY, "--from", tmpText("﻿ \n\n"), "--base", hash],
    ["edit", STORY, "--from", join(tmpdir(), "no-such-edit-text.md"), "--base", hash],
    ["edit"],
    ["edit", STORY, EPIC],
    ["edit", STORY, "--from", tmpdir(), "--base", hash],
    ["edit", STORY, "--from", notUtf8(), "--base", hash],
  ]) {
    const r = await cli(fx.proj, args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
  }
  assert.deepEqual(snapshot(fx.vault), before);
});

// [edit#1]
test("edit: --write at a terminal and a No exits 1 with declined: true, and the vault is byte-identical (failure)", async () => {
  const fx = await vault();
  const before = snapshot(fx.vault);
  const r = await edit(fx, STORY, (b) => b + "\nmore\n", { ask: async () => false, json: false });
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /Nothing written/);
  assert.deepEqual(snapshot(fx.vault), before);
});

// ─── Contract 2 ───────────────────────────────────────────────────────

// [edit#2]
test("edit cut: a story's head ends before ## Description, its foot is the Last updated block, and the parts join back", async () => {
  const fx = await vault();
  const text = read(fx.at(STORY));
  const rest = text.slice(text.indexOf("\n---\n", 4) + 5);
  const p = splitForEdit(rest);
  assert.match(p.body, /^## Description/);
  assert.match(p.foot, /^\n---\n\n\*Last updated: \d{4}-\d{2}-\d{2}\*\s*$/);
  assert.equal(p.head + p.body + p.foot, rest);
});

// [edit#2]
test("edit cut: a foot with prose after its date, no ## line, no foot, and CRLF (edge)", () => {
  const prose = splitForEdit("# T\n\n## A\n\nx\n\n---\n\n*Last updated: 2026-11-01 — opened from a note*\n");
  assert.equal(prose.body, "## A\n\nx\n");
  const none = splitForEdit("# T\n\ntext\n\n---\n\n*Last updated: 2026-11-01*\n");
  assert.equal(none.body, "");
  assert.equal(none.head, "# T\n\ntext\n");
  const nofoot = splitForEdit("# T\n\n## A\n\nx\n");
  assert.equal(nofoot.body, "## A\n\nx\n");
  assert.equal(bodyHash("## A\r\nx\r\n"), bodyHash("## A\nx\n"));
});

// ─── Contract 3 ───────────────────────────────────────────────────────

// [edit#3]
test("edit: a path outside the vault, by .., by an absolute path or by a link, is refused (failure)", async () => {
  const fx = await vault();
  const out = join(mkdtempSync(join(tmpdir(), "edit-out-")), "x.md");
  writeFileSync(out, "---\ntype: story\n---\n\n# X\n\n## A\n");
  symlinkSync(out, fx.at("epics/PS-X/stories/link.md"));
  const before = snapshot(fx.vault);
  for (const p of ["../outside.md", "/etc/hosts", "epics/PS-X/stories/link.md"]) {
    const r = await cli(fx.proj, ["edit", p, "--from", tmpText("## A\n"), "--base", "0123456789abcdef", "--write"]);
    assert.equal(r.code, 1, p);
    assert.match(r.json.result.error, /outside the bound vault/);
  }
  assert.deepEqual(snapshot(fx.vault), before);
});

// [edit#3]
test("edit: on a vault bound through a link, a file's real absolute path is inside it (edge)", async () => {
  const fx = await vault();
  const { realpathSync } = await import("node:fs");
  const linked = join(mkdtempSync(join(tmpdir(), "edit-link-")), "vault");
  symlinkSync(fx.vault, linked);
  const { writeBinding } = await import("./fixtures/vault.mjs");
  writeBinding(fx.proj, { vault_path: linked, layout: "engineering", language: "en", default_author: "Test" });
  for (const p of [STORY, join(realpathSync(fx.vault), STORY), join(linked, STORY)]) {
    const r = await cli(fx.proj, ["edit", p]);
    assert.equal(r.code, 0, `${p}: ${r.out}`);
  }
});

// [edit#3]
test("edit: an ADR, a file with no frontmatter, a folder, a .txt file and a missing file are refused (failure)", async () => {
  const fx = await vault();
  mkdirSync(fx.at("adr"), { recursive: true });
  writeFileSync(fx.at("adr/x.md"), "---\ntype: adr\n---\n\n# X\n\n## Context\n");
  writeFileSync(fx.at("notes.md"), "# Notes\n\n## A\n");
  writeFileSync(fx.at("notes.txt"), "x");
  const before = snapshot(fx.vault);
  for (const p of ["adr/x.md", "notes.md", "epics/PS-X", "notes.txt", "nope.md"]) {
    const r = await cli(fx.proj, ["edit", p]);
    assert.equal(r.code, 1, p);
  }
  assert.deepEqual(snapshot(fx.vault), before);
});

// ─── Contract 4 ───────────────────────────────────────────────────────

// [edit#4]
test("edit: a story moved after it was read refuses the old hash, and the file is as move left it (failure)", async () => {
  const fx = await vault();
  const was = await readBody(fx, STORY);
  const m = await cli(fx.proj, ["move", "PS-X/story-faster-login", "planned", "--reason", "later", "--write"]);
  assert.equal(m.code, 0, m.err);
  const r = await refuses(fx, STORY, was.body + "\nmore\n", /changed after it was read/, { base: was.hash });
  assert.ok(r);
});

// [edit#4]
test("edit: a rank line written after the plan is kept beside the new body; a body changed after the plan is refused (edge, failure)", async () => {
  const fx = await vault();
  const cfg = { vault_path: fx.vault, layout: "engineering", language: "en" };
  const was = await readBody(fx, STORY);
  const text = tmpText(was.body.replace("## Description\n", "## Description\n\nNew words.\n"));
  let once = false;
  const r = await runEdit({
    values: { from: text, base: was.hash, write: true },
    positionals: [STORY],
    cfg,
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () => {
      if (once) return;
      once = true;
      writeFileSync(fx.at(STORY), read(fx.at(STORY)).replace("\npriority:", "\nrank: 5\npriority:"));
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.match(read(fx.at(STORY)), /\nrank: 5\n/);
  assert.match(read(fx.at(STORY)), /New words\./);

  const now = await readBody(fx, STORY);
  const text2 = tmpText(now.body.replace("New words.", "Other words."));
  const r2 = await runEdit({
    values: { from: text2, base: now.hash, write: true },
    positionals: [STORY],
    cfg,
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () => writeFileSync(fx.at(STORY), read(fx.at(STORY)).replace("New words.", "Their words.")),
  });
  assert.equal(r2.code, 1, r2.text);
  assert.match(r2.result.error, /changed after it was read/);
  assert.match(read(fx.at(STORY)), /Their words\./);
});

// ─── Contract 5 ───────────────────────────────────────────────────────

// [edit#5]
test("edit: a text that changes the Status log, or adds one under another heading's case, is refused naming it (failure)", async () => {
  const fx = await vault();
  await refuses(
    fx,
    STORY,
    (b) => b.replace(/(## Status log\n\n)/, "$1- 2026-01-01T00:00:00Z → done (forged)\n"),
    /Status log/,
  );
  const g = guardEdit("story", "## Description\n\nx\n", "## Description\n\nx\n\n## STATUS LOG\n\n- line\n");
  assert.equal(g.part, "status_log");
  const ru = guardEdit("story", "## Журнал статусов\n\n- a\n", "## Журнал статусов\n\n- b\n");
  assert.equal(ru.part, "status_log");
});

// [edit#5]
test("edit: checking, or rewording a checked, acceptance criterion or Expected Result is refused in every checkbox spelling (failure)", async () => {
  const was = "## Acceptance Criteria\n\n- [ ] one\n- [x] two\n";
  for (const next of [
    "## Acceptance Criteria\n\n- [x] one\n- [x] two\n",
    "## Acceptance Criteria\n\n-[x] one\n- [x] two\n",
    "## Acceptance Criteria\n\n-  [x] one\n- [x] two\n",
    "## Acceptance Criteria\n\n- [ ] one\n- [x] two words\n",
    "## Acceptance Criteria\n\n- [x] two\n- [x] two\n",
  ])
    assert.equal(guardEdit("story", was, next)?.part, "acceptance", next);
  // A story's criteria are read over the lines outside fenced blocks, as doctor
  // and follow read them: backticks inside lines hide nothing.
  const fenced = "## Acceptance Criteria\n\n- [ ] A, see ```\n- [x] Real criterion\nend ```\n";
  assert.equal(
    guardEdit("story", "## Acceptance Criteria\n\n- [ ] A, see ```\n- [ ] Real criterion\nend ```\n", fenced)?.part,
    "acceptance",
  );
  const evid = (e) => `## Acceptance Criteria\n\n- [x] Works — evidence: \`${e}\`\n`;
  assert.equal(guardEdit("story", evid("tests/a.test.mjs"), evid("nothing ran"))?.part, "acceptance");
  const epicWas = "## Expected Results\n\n- [ ] real\n";
  assert.equal(
    guardEdit("epic", epicWas, "## Expected Results\n\n- [ ] real\n\n---\n\n- [x] real\n")?.part,
    "expected_results",
  );
  assert.equal(
    guardEdit("epic", "## Ожидаемые результаты\n\n- [ ] a\n", "## Ожидаемые результаты\n\n- [x] a\n")?.part,
    "expected_results",
  );
  const fx = await vault();
  await refuses(fx, EPIC, (b) => b.replace(/(## Expected Results\n\n)/, "$1- [x] Shipped\n"), /Expected Results/);
});

// [edit#5]
test("edit: an initiative's Outcome is kept, and a text that starts with a title is refused (failure)", async () => {
  const fx = await vault();
  await refuses(fx, INIT, (b) => b.replace(/(## Outcome\n)/, "$1\n- 2026-01-01 accepted (forged)\n"), /Outcome/);
  await refuses(fx, STORY, (b) => `# New title\n\n${b}`, /title/);
});

// [edit#5]
test("edit: unchecking a criterion and changing an epic's Stories row are written (edge)", async () => {
  assert.equal(
    guardEdit("story", "## Acceptance Criteria\n\n- [x] two\n", "## Acceptance Criteria\n\n- [ ] two\n"),
    null,
  );
  const fx = await vault();
  const r = await edit(fx, EPIC, (b) => b.replace(/\| todo \|/, "| planned |"));
  assert.equal(r.code, 0, r.out + r.err);
});

// ─── Contract 6 ───────────────────────────────────────────────────────

// [edit#6]
test("edit: a written story differs by the text, the mark, and nothing else; updated and the foot stay", async () => {
  const fx = await vault();
  const before = read(fx.at(STORY));
  const r = await edit(fx, STORY, (b) => b.replace("## Description\n", "## Description\n\nOne word.\n"));
  assert.equal(r.code, 0, r.out);
  const after = read(fx.at(STORY));
  const strip = (t) =>
    t.replace(/^(?:written_by_verb: .*|review_status: .*|reviewed_at: .*)\n/gm, "").replace("\nOne word.\n", "");
  assert.equal(strip(after), strip(before));
  assert.equal(fm(fx.at(STORY)).updated, parseFrontmatter(before).data.updated);
  assert.match(fm(fx.at(STORY)).written_by_verb, /^edit \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(fm(fx.at(STORY)).review_status, "pending");
});

// [edit#6]
test("edit: an epic's mark goes before review_status, and its Updated row stays", async () => {
  const fx = await vault();
  const before = read(fx.at(EPIC));
  const r = await edit(fx, EPIC, (b) => b.replace(/(## Goal\n)/, "$1\nA goal.\n"));
  assert.equal(r.code, 0, r.out);
  const after = read(fx.at(EPIC));
  assert.match(after, /\nwritten_by_verb: "edit [^"]+"\nreview_status: pending\nreviewed_at: null\n/);
  const row = (t) => (t.match(/^\| \*\*Updated\*\* .*$/m) || [""])[0];
  assert.equal(row(after), row(before));
});

// [edit#6]
test("edit: a created story edited twice holds one mark, the later one, and one reviewed clears it (edge)", async () => {
  const fx = await vault();
  assert.equal(await (await edit(fx, STORY, (b) => b + "\nfirst\n")).code, 0);
  await new Promise((r) => setTimeout(r, 1100));
  const second = await edit(fx, STORY, (b) => b + "\nsecond\n");
  assert.equal(second.code, 0);
  const text = read(fx.at(STORY));
  assert.equal(text.match(/^written_by_verb:/gm).length, 1);
  assert.equal(fm(fx.at(STORY)).written_by_verb, second.json.result.mark);
  const v = await cli(fx.proj, ["reviewed", STORY, "--write"]);
  assert.equal(v.code, 0, v.err);
  assert.equal(fm(fx.at(STORY)).written_by_verb, undefined);
  assert.equal(fm(fx.at(STORY)).review_status, "reviewed");
});

// [edit#6]
test("edit: a text equal but for trailing blank lines writes nothing; one ending with its own foot is refused (edge, failure)", async () => {
  const fx = await vault();
  const before = snapshot(fx.vault);
  const r = await edit(fx, STORY, (b) => b.replace(/\s*$/, "\n\n\n"));
  assert.equal(r.code, 0);
  assert.equal(r.json.result.same, true);
  assert.deepEqual(snapshot(fx.vault), before);
  await refuses(fx, STORY, (b) => `${b.trimEnd()}\n\n---\n\n*Last updated: 2026-01-01*\n`, /Last updated/);
  await refuses(
    fx,
    STORY,
    (b) => b.replace("## Description\n", "## Description\n\n*Last updated: 2026-01-01*\n"),
    /Last updated/,
  );
});

// ─── Contract 7 ───────────────────────────────────────────────────────

// [edit#7]
test("edit: with graph.md, an added link is a new edge; with a session id, the record holds the story once, tool edit", async () => {
  const fx = await vault();
  const g = await cli(fx.proj, ["reconcile", "--write", "--only", "graph"]);
  assert.equal(g.code, 0, g.err + g.out);
  const r = await edit(
    fx,
    STORY,
    (b) => b.replace("## Description\n", "## Description\n\nSee [[../epic|the epic]].\n"),
    { sid: "s-edit" },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(read(fx.at("graph.md")), /epics\/PS-X\/stories\/story-faster-login\.md[^\n]*epics\/PS-X\/epic\.md/);
  const events = readEvents(fx.proj, "s-edit").filter((e) => e.tool === "edit");
  assert.deepEqual(
    events.map((e) => e.rel),
    [STORY],
  );
});

// [edit#7]
test("edit: a derived view that cannot be written leaves the new body; exit 1 and left names reconcile --write (failure)", async () => {
  const fx = await vault();
  const k = fx.at("kanban.md");
  if (existsSync(k)) writeFileSync(k, "");
  // A folder where the board is written: the refresh cannot replace it.
  const { rmSync } = await import("node:fs");
  rmSync(k, { force: true });
  mkdirSync(k);
  const r = await edit(fx, STORY, (b) => b.replace("## Description\n", "## Description\n\nKept.\n"));
  assert.equal(r.code, 1, r.out);
  assert.equal(r.json.result.written, true);
  assert.match(read(fx.at(STORY)), /Kept\./);
  assert.equal(r.json.result.left[0].what, "the derived views");
  assert.match(r.json.result.left[0].finish, /reconcile --write/);
});

// [edit#4]
test("edit: a frontmatter line changed after each of three reads exits 1 with story-changed-meanwhile, and the body is as it was (failure)", async () => {
  const fx = await vault();
  const was = await readBody(fx, STORY);
  let n = 0;
  const r = await runEdit({
    values: {
      from: tmpText(was.body.replace("## Description\n", "## Description\n\nNever.\n")),
      base: was.hash,
      write: true,
    },
    positionals: [STORY],
    cfg: { vault_path: fx.vault, layout: "engineering", language: "en" },
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () =>
      writeFileSync(fx.at(STORY), read(fx.at(STORY)).replace(/\npriority: .*\n/, `\npriority: p${++n}\n`)),
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.result.error, /story-changed-meanwhile/);
  assert.equal((await readBody(fx, STORY)).body, was.body);
});

// [edit#6]
test("edit: a story a review cleared, then edited, is marked again with review_status pending (edge)", async () => {
  const fx = await vault();
  assert.equal((await cli(fx.proj, ["reviewed", STORY, "--write"])).code, 0);
  assert.equal(fm(fx.at(STORY)).review_status, "reviewed");
  const r = await edit(fx, STORY, (b) => b + "\nagain\n");
  assert.equal(r.code, 0, r.out);
  assert.match(fm(fx.at(STORY)).written_by_verb, /^edit /);
  assert.equal(fm(fx.at(STORY)).review_status, "pending");
});

// ─── An ADR, a spec and a research note (contracts 3, 5 and 6, as amended 2026-11-25) ───

const ADR = "adr/an-adr.md";
const SPEC = "specs/a-spec.md";
const NOTE = "research/a-note.md";
// A document as its template renders it, with `status` set as written.
function doc(fx, kind, rel, status) {
  mkdirSync(join(fx.vault, rel, ".."), { recursive: true });
  let t = renderTemplate(loadTemplate("en", kind), {
    id: rel.split("/").pop().replace(/\.md$/, ""),
    title: `A ${kind}`,
    date: "2026-11-25",
    tags: [],
    author: "T",
  });
  t = status === null ? t.replace(/^status: .*\n/m, "") : t.replace(/^status: .*$/m, `status: ${status}`);
  writeFileSync(fx.at(rel), t);
}

// [edit#3]
test("edit: an accepted ADR, an active spec, a spec with no status, a final research note, a superseded ADR and a concept are refused, naming the status (failure)", async () => {
  const fx = await vault();
  doc(fx, "adr", ADR, "accepted");
  doc(fx, "spec", SPEC, "active");
  doc(fx, "spec", "specs/no-status.md", null);
  doc(fx, "concept", "concepts/a-concept.md", "draft");
  doc(fx, "research", NOTE, "final");
  doc(fx, "adr", "adr/old.md", "superseded");
  const before = snapshot(fx.vault);
  const cases = [
    [
      ADR,
      /this ADR is accepted, and edit writes an ADR only while it is proposed\. An ADR past proposed changes by a dated note/,
    ],
    [
      SPEC,
      /this spec is active, and edit writes a spec only while it is draft\. A spec past draft changes by a `> amended` marker/,
    ],
    ["specs/no-status.md", /this spec is of no status/],
    [
      "concepts/a-concept.md",
      /of the kind concept; edit writes a story, an epic, an initiative, a proposed ADR, a draft spec or a draft research note/,
    ],
    [
      NOTE,
      /this research note is final, and edit writes a research note only while it is draft\. A research note that is no longer a draft is cited by its findings/,
    ],
    ["adr/old.md", /this ADR is superseded, .* A superseded ADR is closed: nothing changes it\./],
  ];
  for (const [rel, match] of cases) {
    const r = await cli(fx.proj, ["edit", rel]);
    assert.equal(r.code, 1, rel);
    assert.match(r.json.result.error, match, rel);
  }
  assert.deepEqual(snapshot(fx.vault), before);
});

// [edit#3]
test("edit: a proposed ADR, a draft spec, a research note and a story whose type is Story are written and marked", async () => {
  const fx = await vault();
  doc(fx, "adr", ADR, "Proposed");
  doc(fx, "spec", SPEC, "draft");
  doc(fx, "research", NOTE, "draft");
  writeFileSync(fx.at(STORY), read(fx.at(STORY)).replace(/^type: story$/m, "type: Story"));
  for (const rel of [ADR, SPEC, NOTE, STORY]) {
    const r = await edit(fx, rel, (b) => b.replace(/^## (\S.*)\n/m, "## $1\n\nNew words.\n"));
    assert.equal(r.code, 0, `${rel}: ${r.out}${r.err}`);
    const t = read(fx.at(rel));
    assert.match(t, /New words\./, rel);
    assert.match(fm(fx.at(rel)).written_by_verb, /^edit /, rel);
    assert.equal(fm(fx.at(rel)).review_status, "pending", rel);
  }
  // The head and the foot are the file's own: the ADR's field table and its "Last updated" line stay.
  assert.match(read(fx.at(ADR)), /\| \*\*Status\*\* \| proposed \|/);
  // [edit#6] The ADR template carries the review keys: the mark goes just before them, as on an epic.
  assert.match(read(fx.at(ADR)), /\nwritten_by_verb: "edit [^"]+"\nreview_status: pending\nreviewed_at: null\n/);
  assert.match(read(fx.at(ADR)), /\n---\n\n\*Last updated: 2026-11-25\*\n$/);
});

// [edit#3] [edit#4]
test("edit: an ADR accepted between the plan and the write is refused naming accepted, and is as the other writer left it (failure)", async () => {
  const fx = await vault();
  doc(fx, "adr", ADR, "proposed");
  const cfg = { vault_path: fx.vault, layout: "engineering", language: "en" };
  const was = await readBody(fx, ADR);
  const text = tmpText(was.body.replace("## Context\n", "## Context\n\nNew words.\n"));
  let accepted = null;
  const r = await runEdit({
    values: { from: text, base: was.hash, write: true },
    positionals: [ADR],
    cfg,
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () => {
      if (accepted) return;
      accepted = read(fx.at(ADR)).replace(/^status: proposed$/m, "status: accepted");
      writeFileSync(fx.at(ADR), accepted);
    },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.result.error, /this ADR is accepted/);
  assert.equal(read(fx.at(ADR)), accepted);
});

// [edit#5]
test("edit: a draft spec's text that checks an Acceptance item, or rewords a checked one under ## Приёмка, is refused (failure)", async () => {
  const fx = await vault();
  doc(fx, "spec", SPEC, "draft");
  writeFileSync(
    fx.at(SPEC),
    read(fx.at(SPEC)).replace(
      /## Acceptance\n[\s\S]*?\n## References/,
      "## Acceptance\n\n- [ ] One thing holds.\n\n## References",
    ),
  );
  await refuses(
    fx,
    SPEC,
    (b) => b.replace("- [ ] One thing holds.", "- [x] One thing holds."),
    /the spec's Acceptance/,
  );
  doc(fx, "spec", "specs/ru.md", "draft");
  writeFileSync(
    fx.at("specs/ru.md"),
    read(fx.at("specs/ru.md")).replace(
      /## Acceptance\n[\s\S]*?\n## References/,
      "## Приёмка\n\n- [x] Одно держится. — evidence: test\n\n## References",
    ),
  );
  await refuses(fx, "specs/ru.md", (b) => b.replace("Одно держится.", "Другое держится."), /the spec's Acceptance/);
  // Unchecking is not refused.
  const r = await edit(fx, "specs/ru.md", (b) => b.replace("- [x] Одно", "- [ ] Одно"));
  assert.equal(r.code, 0, r.out);
});

// [edit#6]
test("edit: a research note with no review keys and no plan_updated_at gets the three mark lines last in its frontmatter (edge)", async () => {
  const fx = await vault();
  mkdirSync(fx.at("research"), { recursive: true });
  writeFileSync(
    fx.at(NOTE),
    "---\ntype: research\ntitle: An old note\nstatus: draft\ndate: 2026-01-01\n---\n\n# An old note\n\n## Question\n\nWhy?\n",
  );
  const r = await edit(fx, NOTE, (b) => b.replace("Why?", "Why not?"));
  assert.equal(r.code, 0, r.out);
  assert.match(
    read(fx.at(NOTE)),
    /\ndate: 2026-01-01\nwritten_by_verb: "edit [^"]+"\nreview_status: pending\nreviewed_at: null\n---\n/,
  );
});

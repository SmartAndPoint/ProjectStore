// projectstore — the not-reviewed mark and the readers that ask about it
// (spec "Create verbs and the not-reviewed mark…", alias `create`, contracts
// 4 and 7 to 11): the predicate and its source pin, the gates' `marked`,
// doctor's `verb-mark`, follow's note, and the review and story commands'
// text. Each test names the contract it covers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMarked, markOf, MARK_KEY } from "../scripts/verb-mark.mjs";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { loadTemplate, renderTemplate } from "../scripts/lib.mjs";
import { stripComments } from "./fixtures/vocabulary.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const MARK = 'written_by_verb: "create 2026-11-19T06:00:00Z"';
const marked = (text) => text.replace(/^---\n/, `---\n${MARK}\n`);

// ─── Contract 4: the predicate and its source pin ─────────────────────

// [create#4]
test("mark: an empty string, null and an absent key are no mark; a value is one, read as verb and instant (edge)", () => {
  for (const fm of [{ [MARK_KEY]: "" }, { [MARK_KEY]: "   " }, { [MARK_KEY]: null }, {}, null])
    assert.equal(isMarked(fm), false, JSON.stringify(fm));
  assert.deepEqual(markOf({ [MARK_KEY]: " create 2026-11-19T06:00:00Z " }), {
    verb: "create",
    at: "2026-11-19T06:00:00Z",
    raw: "create 2026-11-19T06:00:00Z",
  });
});

// [create#4]
test("mark: only item-verbs.mjs writes the key, only its reviewed removes it, and every reader asks verb-mark.mjs (edge)", () => {
  const dir = join(REPO, "scripts");
  const code = (n) => stripComments(read(join(dir, n)));
  const names = readdirSync(dir).filter((n) => n.endsWith(".mjs"));
  // The key by its constant: the writer, its home, and follow's note.
  assert.deepEqual(names.filter((n) => /\bMARK_KEY\b/.test(code(n))).sort(), [
    "follow-plan.mjs",
    "item-verbs.mjs",
    "verb-mark.mjs",
  ]);
  // The key's text: its home, and the create verb's help line in verbs.mjs.
  assert.deepEqual(names.filter((n) => /written_by_verb/.test(code(n))).sort(), ["verb-mark.mjs", "verbs.mjs"]);
  assert.ok(!/(?:setFm|unsetFm)\([^)]*written_by_verb/.test(code("verbs.mjs")));
  // follow-plan names the key in its note only; it writes nothing.
  assert.ok(!/setFm\([^)]*MARK_KEY/.test(stripComments(read(join(dir, "follow-plan.mjs")))));
  const src = stripComments(read(join(dir, "item-verbs.mjs")));
  const writers = [...src.matchAll(/export function (\w+)\(/g)].map((m) => m[1]);
  const body = (name) => {
    const at = src.indexOf(`export function ${name}(`);
    const next = src.indexOf("\nexport ", at + 1);
    return src.slice(at, next === -1 ? undefined : next);
  };
  const removes = writers.filter((w) => /lines\.splice\(at, 1\)/.test(body(w)));
  assert.deepEqual(removes, ["clearMark"]);
  const reviewed = src.slice(src.indexOf("export async function runReviewed("));
  assert.match(reviewed, /clearMark\(/);
  assert.ok(
    !/clearMark\(/.test(
      src
        .slice(0, src.indexOf("export async function runReviewed("))
        .replace(/export function clearMark[\s\S]*?\n}\n/, ""),
    ),
  );
  for (const reader of ["story-section.mjs", "doctor.mjs", "follow-plan.mjs"])
    assert.match(read(join(dir, reader)), /from "\.\/verb-mark\.mjs"/, reader);
  assert.ok(!/^import /m.test(read(join(dir, "verb-mark.mjs"))), "verb-mark.mjs imports nothing");
});

// ─── Contract 8: the gates print `marked` ────────────────────────────

function seedTree({ gates = "on", story = true, epic = true, initiative = true, link = "faster-onboarding" } = {}) {
  const { proj, vault } = makeVaultProject();
  writeFileSync(join(vault, ".projectstore.json"), JSON.stringify({ lifecycle_gates: gates }));
  let e = renderTemplate(loadTemplate("en", "epic"), { id: "PS-X", title: "T", date: "2026-11-14", tags: [] });
  e = e.replace("updated: 2026-11-14\n", `updated: 2026-11-14\ninitiative: "${link}"\n`);
  writeFileSync(join(vault, "epics", "PS-X", "epic.md"), epic ? marked(e) : e);
  mkdirSync(join(vault, "initiatives"), { recursive: true });
  const i = renderTemplate(loadTemplate("en", "initiative"), {
    id: "faster-onboarding",
    title: "F",
    date: "2026-11-14",
    author: "A",
    tags: [],
  });
  writeFileSync(join(vault, "initiatives", "faster-onboarding.md"), initiative ? marked(i) : i);
  const s = renderTemplate(loadTemplate("en", "story"), {
    id: "story-a",
    epic_id: "PS-X",
    title: "A",
    date: "2026-11-14",
    author: "Test",
    tags: [],
  });
  const path = join(vault, "epics", "PS-X", "stories", "story-a.md");
  writeFileSync(path, story ? marked(s) : s);
  return { proj, vault, path };
}
function gate(proj, mode, path) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), mode, path], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: REPO },
    cwd: proj,
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// [create#8]
test("gates: a marked story under a marked epic whose initiative is marked prints the three paths, story first", () => {
  const fx = seedTree();
  const j = gate(fx.proj, "plan", fx.path);
  assert.deepEqual(j.marked, [
    "epics/PS-X/stories/story-a.md",
    "epics/PS-X/epic.md",
    "initiatives/faster-onboarding.md",
  ]);
  assert.equal(j.outside, false);
});

// [create#8]
test("gates: the same files under lifecycle_gates: off print marked: [] (edge)", () => {
  const fx = seedTree({ gates: "off" });
  assert.deepEqual(gate(fx.proj, "plan", fx.path).marked, []);
});

// [create#8]
test("gates: a marked epic whose initiative: names no file, over an unmarked story, prints the epic alone (edge)", () => {
  const fx = seedTree({ story: false, link: "nothing-here" });
  assert.deepEqual(gate(fx.proj, "plan", fx.path).marked, ["epics/PS-X/epic.md"]);
});

// [create#8]
test("gates: on a close, a marked story under a marked epic prints the story alone", () => {
  const fx = seedTree();
  assert.deepEqual(gate(fx.proj, "close", fx.path).marked, ["epics/PS-X/stories/story-a.md"]);
});

// [create#9]
test("gates: a story outside the bound vault's folder says outside: true (edge)", () => {
  const fx = seedTree();
  // Another vault's story, gated with this project's binding: outside it.
  const other = seedTree();
  const j = gate(fx.proj, "plan", other.path);
  assert.equal(j.outside, true);
  const link = join(mkdtempSync(join(tmpdir(), "ps-link-")), "v");
  symlinkSync(fx.vault, link);
  assert.equal(
    gate(fx.proj, "plan", join(link, "epics", "PS-X", "stories", "story-a.md")).outside,
    false,
    "a link to the vault is inside it",
  );
});

// ─── Contract 10: doctor's verb-mark ─────────────────────────────────

const checks = (fx) =>
  runVaultChecks({ vault_path: fx.vault, layout: "engineering", language: "en" }, { proj: fx.proj }).filter(
    (f) => f.check === "verb-mark",
  );

// [create#10]
test("doctor: a story a create wrote is one info verb-mark under lifecycle_gates on and off, naming the review command", () => {
  for (const gates of ["on", "off"]) {
    const fx = seedTree({ gates, epic: false, initiative: false });
    const f = checks(fx);
    assert.equal(f.length, 1, `${gates}: ${JSON.stringify(f)}`);
    assert.equal(f[0].level, "info");
    assert.equal(f[0].file, "epics/PS-X/stories/story-a.md");
    assert.match(f[0].message, /Written by create at 2026-11-19T06:00:00Z/);
    assert.match(f[0].message, /:\n\S*review epics\/PS-X\/stories\/story-a\.md$/);
  }
});

// [create#10]
test("doctor: a file holding the mark and review_status: reviewed is one issue verb-mark and no info (failure)", () => {
  const fx = seedTree({ story: false, initiative: false });
  const p = join(fx.vault, "epics", "PS-X", "epic.md");
  writeFileSync(p, read(p).replace("review_status: pending", "review_status: reviewed"));
  const f = checks(fx);
  assert.deepEqual(
    f.map((x) => [x.level, x.file]),
    [["issue", "epics/PS-X/epic.md"]],
  );
});

// [create#10]
test("doctor: a vault with no mark lists no verb-mark (edge)", () => {
  const fx = seedTree({ story: false, epic: false, initiative: false });
  assert.deepEqual(checks(fx), []);
});

// ─── Contracts 7 and 9: the review and story commands ────────────────

const COPIES = (name) => [
  `commands/${name}.md`,
  `adapters/codex/skills/projectstore-${name}/SKILL.md`,
  `packaging/shells/projectstore-codex/skills/projectstore-${name}/SKILL.md`,
];

// [create#7]
test("review command: on a marked file, step 9 runs reviewed after every answer but Skip, the empty report included; a dismissed question is a Skip", () => {
  for (const f of COPIES("review")) {
    const t = read(join(REPO, f)).replace(/\s+/g, " ");
    assert.match(t, /holds `written_by_verb`/, f);
    assert.match(
      t,
      /Run it after every answer but Skip: Apply all and Apply selected after their Edits, Note for later after its section, and a report with no finding \(no question is asked then\)/,
      f,
    );
    assert.match(t, /reviewed "<path>" --write --json/, f);
    assert.match(t, /A question dismissed with no answer is a Skip: the mark stays\./, f);
  }
});

// [create#9]
test("story command: a non-empty marked runs the review for each path, then step 2 again; a Skip stops the gate; outside stops before any review; step 5 compares marked", () => {
  for (const f of COPIES("story")) {
    const t = read(join(REPO, f)).replace(/\s+/g, " ");
    assert.match(
      t,
      /When `marked` is not empty and `outside` is `true` \(the story is in a worktree of the vault\), stop the gate before any review/,
      f,
    );
    assert.match(
      t,
      /then run this step again: on a plan, step 2a and its round follow, the WIP question first; on a close, step 3 follows, and the clerk's baseline in step 5a is that second run's `content`/,
      f,
    );
    assert.match(t, /A Skip, or a dismissed question, stops the gate, names the file, and writes nothing\./, f);
    assert.match(t, /a marked story gets the critic although the story guide does not ask for one/, f);
    assert.match(t, /compare `marked` as you compare `wip.over`/, f);
  }
});

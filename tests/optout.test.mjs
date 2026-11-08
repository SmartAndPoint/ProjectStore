// projectstore — the declared opt-out from a spec, the lifecycle date under
// any policy, and the dry run (the spec policy ADR, Part B; PS-SPEC: "A story
// can declare that it needs no spec, with a reason, and spec_policy required
// accepts the declaration").

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { legacySince, noSpecOf, parseDryRunPolicy, checklistItems, isTestPath } from "../scripts/lib.mjs";
import {
  checkSpecCoverage,
  checkLifecycleGates,
  checkNoSpec,
  checkNoSpecShare,
  checkReviewBy,
  checkGatesStamp,
  sourceWeight,
  runVaultChecks,
} from "../scripts/doctor.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SINCE = "2026-06-01T00:00:00.000Z";

const story = (fm, body = "") => ({
  kind: "story",
  rel: `epics/E/stories/${fm.id || "s"}.md`,
  fm: { type: "story", epic: "E", ...fm },
  body,
});

// A project tree with real files, so the size check can tell a file from a
// directory.
function projWithFiles() {
  const { proj, vault } = makeVaultProject();
  for (const d of ["scripts", "src/deep", "tests"]) mkdirSync(join(proj, d), { recursive: true });
  for (const f of [
    "scripts/a.mjs",
    "scripts/b.mjs",
    "scripts/c.mjs",
    "tests/a.test.mjs",
    "src/x.test.ts",
    "src/deep/y.mjs",
  ]) {
    writeFileSync(join(proj, f), "// x\n");
  }
  return { proj, vault };
}

test("lib: legacySince, noSpecOf, isTestPath and the dry-run grammar", () => {
  assert.equal(legacySince({ spec_policy_since: "a", gates_since: "b" }), "a");
  assert.equal(legacySince({ gates_since: "b" }), "b");
  assert.equal(legacySince({}), null);
  assert.deepEqual(noSpecOf({ no_spec: "a release" }), { declared: true, reason: "a release" });
  assert.deepEqual(noSpecOf({ no_spec: "  " }), { declared: true, reason: "" });
  assert.deepEqual(noSpecOf({}), { declared: false, reason: "" });
  assert.ok(isTestPath("tests/a.mjs") && isTestPath("src/x.test.ts") && isTestPath("a/__tests__/b.js"));
  assert.ok(!isTestPath("scripts/testing.mjs") && !isTestPath("src/contest/a.mjs"));
  assert.deepEqual(parseDryRunPolicy("required", SINCE), {
    policy: { spec_policy: "required", spec_policy_since: SINCE },
  });
  assert.equal(parseDryRunPolicy("required@2026-10-01").policy.spec_policy_since, "2026-10-01T00:00:00.000Z");
  assert.ok(parseDryRunPolicy("optional").error);
  assert.ok(parseDryRunPolicy("required@nonsense").error);
});

test("checklistItems: a wrapped line and a nested bullet belong to the item; a new item or a blank line ends it", () => {
  const items = checklistItems([
    "- [x] first criterion that wraps",
    "      onto a second line — evidence: tests/a.test.mjs",
    "- [x] a criterion with cases:",
    "      - case one;",
    "      - case two. — evidence: tests/b.test.mjs",
    "- [ ] open",
    "",
    "  stray text after a blank line",
  ]);
  assert.equal(items.length, 3);
  assert.match(items[0].text, /second line — evidence:/);
  assert.match(items[1].text, /case two\. — evidence:/);
  assert.equal(items[2].checked, false);
  assert.doesNotMatch(items[2].text, /stray/);
});

test("checkLifecycleGates: evidence on a wrapped line counts, and gates_since makes a done story checkable under optional", () => {
  const body = [
    "## Implementation Plan",
    "",
    "plan",
    "",
    "## Acceptance Criteria",
    "",
    "- [x] wraps",
    "      here — evidence: tests/a.test.mjs",
    "- [x] no evidence at all",
    "",
    "## Final Summary",
    "",
    "done",
    "",
  ].join("\n");
  const done = story(
    { status: "done", closed_at: "2026-07-01T00:00:00Z", plan_updated_at: "2026-06-02T00:00:00Z" },
    body,
  );
  // No date: every done story is legacy, nothing is checked.
  assert.deepEqual(checkLifecycleGates([done], { lifecycle_gates: "on" }), []);
  const f = checkLifecycleGates([done], { lifecycle_gates: "on", gates_since: SINCE });
  assert.equal(f.length, 1, f.map((x) => x.message).join("; "));
  assert.match(f[0].message, /no evidence at all/);
});

test("checkSpecCoverage: under required a no_spec story passes; a story with neither is still an issue; optional is silent", () => {
  const optedOut = story({ id: "o", status: "in-progress", no_spec: "a release" });
  const bare = story({ id: "b", status: "in-progress" });
  const req = { spec_policy: "required", spec_policy_since: SINCE };
  const f = checkSpecCoverage([optedOut, bare], req);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, bare.rel);
  assert.match(f[0].message, /no_spec reason/);
  assert.deepEqual(checkSpecCoverage([optedOut, bare], { spec_policy: "optional" }), []);
});

test("checkNoSpec: an empty reason and no_spec beside specs are issues; planned and legacy stories are skipped", () => {
  const { proj, vault } = projWithFiles();
  const cfg = { gates_since: SINCE };
  const f = checkNoSpec(
    [
      story({ id: "empty", status: "in-progress", no_spec: "" }),
      story({ id: "both", status: "review", no_spec: "x", specs: '["SPEC-001"]' }),
      story({ id: "planned", status: "planned", no_spec: "" }),
      story({ id: "old", status: "done", closed_at: "2026-01-01T00:00:00Z", no_spec: "" }),
    ],
    cfg,
    proj,
    vault,
  );
  assert.deepEqual(
    f.map((x) => `${x.level}:${x.file}`),
    ["issue:epics/E/stories/empty.md", "issue:epics/E/stories/both.md"],
  );
});

test("sourceWeight and the size check: two files pass, three warn, a directory or a glob weighs three, tests weigh nothing", () => {
  const { proj, vault } = projWithFiles();
  const w = (refs) => sourceWeight({ code_refs: JSON.stringify(refs) }, proj, vault);
  assert.equal(w(["scripts/a.mjs", "scripts/b.mjs"]), 2);
  assert.equal(w(["scripts/a.mjs", "scripts/b.mjs", "scripts/c.mjs"]), 3);
  assert.equal(w(["src/deep"]), 3, "a directory");
  assert.equal(w(["scripts/*.mjs"]), 3, "a glob");
  assert.equal(w(["tests/a.test.mjs", "src/x.test.ts", "scripts/a.mjs"]), 1, "tests do not count");
  assert.equal(w([".claude/x.md", "AGENTS.md"]), 0, "paths isSourcePath ignores");
  const big = story({ id: "big", status: "in-progress", no_spec: "small", code_refs: '["scripts/"]' });
  const small = story({ id: "small", status: "in-progress", no_spec: "small", code_refs: '["scripts/a.mjs"]' });
  const text = story({
    id: "text",
    status: "done",
    closed_at: "2026-07-01T00:00:00Z",
    no_spec: "copy edit",
    code_refs: "[]",
  });
  const f = checkNoSpec([big, small, text], { gates_since: SINCE }, proj, vault);
  assert.deepEqual(
    f.map((x) => `${x.level}:${x.file}`),
    ["warn:epics/E/stories/big.md"],
  );
});

test("checkNoSpecShare: nothing without an opt-out; info below five; warn when opt-outs outnumber specs among code stories", () => {
  const { proj, vault } = projWithFiles();
  const cfg = { gates_since: SINCE };
  const code = '["scripts/a.mjs"]';
  const opt = (i) => story({ id: `o${i}`, status: "in-progress", no_spec: "r", code_refs: code });
  const cov = (i) => story({ id: `c${i}`, status: "in-progress", specs: '["S"]', code_refs: code });
  const doc = (i) => story({ id: `d${i}`, status: "in-progress", no_spec: "text", code_refs: "[]" });
  assert.deepEqual(checkNoSpecShare([cov(1), cov(2)], cfg, proj, vault), []);
  const four = checkNoSpecShare([opt(1), opt(2), opt(3), cov(1), doc(1), doc(2)], cfg, proj, vault);
  assert.equal(four[0].level, "info", "four code stories: below the floor, and stories without code do not count");
  const five = checkNoSpecShare([opt(1), opt(2), opt(3), cov(1), cov(2)], cfg, proj, vault);
  assert.equal(five[0].level, "warn");
  assert.deepEqual(five[0].per_epic, { E: { no_spec: 3, specs: 2 } });
  assert.equal(checkNoSpecShare([opt(1), opt(2), cov(1), cov(2), cov(3)], cfg, proj, vault)[0].level, "info");
  // The window counts every code story, ones with neither field included.
  const neither = story({ id: "n1", status: "in-progress", code_refs: code });
  assert.equal(checkNoSpecShare([opt(1), opt(2), opt(3), cov(1), neither], cfg, proj, vault)[0].level, "warn");
  // A legacy done story is outside the window; a done one after the date is inside.
  const oldOpt = story({ id: "old", status: "done", closed_at: "2026-01-01T00:00:00Z", no_spec: "r", code_refs: code });
  const newOpt = story({ id: "new", status: "done", closed_at: "2026-07-01T00:00:00Z", no_spec: "r", code_refs: code });
  assert.match(checkNoSpecShare([oldOpt, newOpt], cfg, proj, vault)[0].message, /^1 code story opts out/);
  // With no date at all, done stories are legacy and open ones still count.
  assert.equal(checkNoSpecShare([opt(1), newOpt], {}, proj, vault)[0].message.startsWith("1 code story"), true);
});

test("noSpecOf: a bare null is not a declaration", () => {
  assert.deepEqual(noSpecOf({ no_spec: null }), { declared: false, reason: "" });
  assert.deepEqual(noSpecOf({ no_spec: "null" }), { declared: false, reason: "" });
  assert.ok(parseDryRunPolicy("required@1").error, "ISO dates only");
  assert.ok(parseDryRunPolicy("required@2026-10-01T10:00").error, "a time needs its zone");
  assert.equal(parseDryRunPolicy("required@2026-10-01T10:00:00Z").policy.spec_policy_since, "2026-10-01T10:00:00.000Z");
});

test("bin: doctor --policy goes through the parser, and a bad rule is a usage error", () => {
  const { proj } = makeVaultProject();
  const bin = (args) =>
    spawnSync(process.execPath, [join(REPO, "bin", "projectstore.mjs"), "doctor", ...args, "--project", proj], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
  const ok = bin(["--vault", "--json", "--policy", "required"]);
  assert.ok([0, 1].includes(ok.status), ok.stderr);
  assert.ok(JSON.parse(ok.stdout).result.some((x) => x.check === "dry-run"));
  assert.notEqual(bin(["--vault", "--policy", "optional"]).status, 0);
});

test("checkReviewBy: an accepted ADR past review_by is an info until reviewed on or after that date", () => {
  const adr = (fm) => ({
    kind: "adr",
    rel: "adr/a.md",
    fm: { type: "adr", status: "accepted", review_by: "2027-05-08", ...fm },
  });
  const now = "2027-06-01T00:00:00.000Z";
  assert.equal(checkReviewBy([adr({})], now).length, 1);
  assert.deepEqual(checkReviewBy([adr({})], "2027-05-08T12:00:00.000Z"), [], "due today is not past");
  assert.deepEqual(checkReviewBy([adr({ review_status: "reviewed", reviewed_at: "2027-05-20" })], now), []);
  assert.equal(checkReviewBy([adr({ review_status: "reviewed", reviewed_at: "2026-11-08" })], now).length, 1);
  assert.deepEqual(checkReviewBy([adr({ status: "proposed" })], now), []);
});

test("checkGatesStamp: gates on with no date suggests the stamp; a date, or gates off, is silent", () => {
  const f = checkGatesStamp({ lifecycle_gates: "on" }, "/p");
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "gates-since");
  assert.match(f[0].message, /configure --set lifecycle_gates=on$/);
  assert.deepEqual(checkGatesStamp({ lifecycle_gates: "on", gates_since: SINCE }, "/p"), []);
  assert.deepEqual(checkGatesStamp({ lifecycle_gates: "off" }, "/p"), []);
});

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("dry run: --policy evaluates the vault as required and writes nothing; a bad value or --install alone exits 2", () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(join(vault, ".projectstore.json"), JSON.stringify({ spec_policy: "optional" }) + "\n");
  writeFileSync(
    join(vault, "epics", "PS-X", "stories", "story-open.md"),
    `---\ntype: story\nid: "story-open"\nepic: "PS-X"\ntitle: "Open"\nstatus: in-progress\nspecs: []\n---\n\n# Open\n`,
  );
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  const before = tree(vault);
  const f = runVaultChecks(cfg, { proj, policy: parseDryRunPolicy("required").policy });
  assert.equal(f.filter((x) => x.check === "dry-run").length, 1);
  assert.equal(f.filter((x) => x.check === "spec-coverage").length, 1);
  assert.deepEqual(tree(vault), before, "nothing written");

  const run = (args) =>
    spawnSync(process.execPath, [join(REPO, "scripts", "doctor.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      cwd: proj,
    });
  const ok = run(["--vault", "--json", "--policy", "required"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(JSON.parse(ok.stdout).some((x) => x.check === "dry-run"));
  for (const args of [
    ["--vault", "--policy", "optional"],
    ["--install", "--policy", "required"],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(tree(vault), before);
});

test("story-section plan --no-spec: writes the reason; refuses an empty reason, a close, and a story that lists specs", () => {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-n.md");
  const write = (specs) =>
    writeFileSync(
      path,
      `---\ntype: story\nid: "story-n"\nepic: "PS-X"\ntitle: "N"\nstatus: planned\nspecs: ${specs}\n---\n\n# N\n`,
    );
  const run = (args) =>
    spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      cwd: REPO,
    });
  write("[]");
  const ok = run(["plan", path, "--no-spec", "a release story"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).content, /^no_spec: "a release story"$/m);
  assert.notEqual(run(["plan", path, "--no-spec", "  "]).status, 0);
  assert.notEqual(run(["close", path, "--no-spec", "x"]).status, 0);
  write('["SPEC-001"]');
  assert.notEqual(run(["plan", path, "--no-spec", "x"]).status, 0);
});

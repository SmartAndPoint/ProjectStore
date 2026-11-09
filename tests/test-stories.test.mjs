// projectstore — test stories and scenario marks (the authoring-guides ADR,
// decisions 6 and 7; the PS-SPEC story "A test story is written from the
// spec's scenarios through the story.test guide, and doctor reports
// contracts with only happy-path scenarios").
//
// Every test here covers [SPEC-001#13].

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../scripts/lib.mjs";
import { resolveGuide } from "../scripts/guides.mjs";
import { parseSpecContracts, checkHappyPathOnly, checkScenarioShape, runVaultChecks } from "../scripts/doctor.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const spec = (body, fm = {}, rel = "specs/s.md") => ({
  kind: "spec",
  rel,
  fm: { type: "spec", status: "active", ...fm },
  body: ["## Behavioral contracts", "", ...body, "", "## Acceptance", ""].join("\n"),
});

// ─── The guide ─────────────────────────────────────────────────────────

test("story.test guide: a package variant with the four Must items of decision 6; a vault story override does not hide it", () => {
  const g = resolveGuide("story.test", { root: REPO });
  assert.equal(g.resolved, "story.test");
  assert.equal(g.source, "package");
  assert.equal(g.guide_version, 1);
  assert.equal(g.sections.Must.length, 4);
  assert.match(g.sections.Must[0], /contracts it covers by citation token/);
  assert.match(
    g.sections.Must[1],
    /boundary values.*invalid input.*state transitions.*failure of a dependency.*retry and concurrency.*partial failure.*upgrade from an older state.*rollback/,
  );
  assert.match(g.sections.Must[2], /deliberately leaves untested, and why/);
  assert.match(g.sections.Must[3], /every test it adds to cite/);
  // A vault that overrides only story.md still gets the package's story.test.
  const { vault } = makeVaultProject();
  const dir = join(vault, "guides");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "story.md"), "---\nguide_for: story\n---\n\n## Must\n\n- vault rule\n");
  assert.equal(resolveGuide("story.test", { vault, root: REPO }).resolved, "story.test");
  assert.equal(resolveGuide("story", { vault, root: REPO }).source, "vault");
});

// ─── The variant through templates, command and gates ──────────────────

test("story templates: every locale carries a commented `# variant: test` line that parses to nothing", () => {
  const langs = readdirSync(join(REPO, "templates")).filter((d) => !d.includes("."));
  assert.deepEqual(langs.sort(), ["de", "en", "es", "fr", "ru", "zh"], "the six bundled locales");
  for (const lang of langs) {
    const t = readFileSync(join(REPO, "templates", lang, "story.md.tmpl"), "utf8");
    assert.match(t, /^# variant: test {2}[(（].*story\.test/m, lang);
    assert.ok(!("variant" in parseFrontmatter(t).data), `${lang}: the comment is no key`);
    // What the command does: the comment line becomes the key.
    const filled = t.replace(/^# variant: test .*$/m, "variant: test");
    assert.equal(parseFrontmatter(filled).data.variant, "test", lang);
  }
});

test("commands/story.md: --variant test in the hint, stripped from the title with --spec, the key written, the guide read as story.test", () => {
  const t = readFileSync(join(REPO, "commands", "story.md"), "utf8");
  assert.match(t, /^argument-hint: .*\[--variant test\]/m);
  assert.match(t, /--variant test/);
  assert.match(t, /guide story\.test/);
  assert.match(t, /remove `--variant test` and `--spec SPEC-ID`/i);
  assert.match(t, /variant: test/);
});

test("variant: test survives the plan and close gates and raises no doctor finding of its own", async () => {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-t.md");
  const body = (variant) =>
    `---\ntype: story\nid: "story-t"\nepic: "PS-X"\ntitle: "T"\nstatus: planned\n${variant}specs: []\n---\n\n# T\n\n## Acceptance Criteria\n\n- [ ] one\n`;
  const gate = (verb) =>
    spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), verb, path], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      cwd: REPO,
    });
  writeFileSync(path, body("variant: test\n"));
  for (const verb of ["plan", "close"]) {
    const r = gate(verb);
    assert.equal(r.status, 0, r.stderr);
    const content = JSON.parse(r.stdout).content;
    assert.match(content, /^variant: test$/m, verb);
    writeFileSync(path, content);
  }
  // The same story with and without the key: the same findings.
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  const norm = (fs) => fs.map((f) => `${f.check} ${f.file || ""}`).sort();
  const withKey = norm(await runVaultChecks(cfg, { proj }));
  writeFileSync(path, readFileSync(path, "utf8").replace(/^variant: test\n/m, ""));
  const without = norm(await runVaultChecks(cfg, { proj }));
  assert.deepEqual(withKey, without);
});

// ─── Scenario marks ────────────────────────────────────────────────────

test("scenario marks: a WHEN or GIVEN item ending in (edge) or (failure) counts, also on its wrapped line; THEN, AND, prose and near-misses do not", () => {
  const c = (lines) => parseSpecContracts(spec(["1. **One.** A contract.", "", ...lines]))[0];
  assert.deepEqual(c(["   - GIVEN a vault (edge)", "   - WHEN doctor runs", "   - THEN it reports"]).marks, ["edge"]);
  assert.deepEqual(c(["   - GIVEN a vault", "   - WHEN doctor runs (failure)", "   - THEN it reports"]).marks, [
    "failure",
  ]);
  const wrapped = c([
    "   - GIVEN a vault",
    "   - WHEN doctor runs over a long",
    "     line that wraps (failure)",
    "   - THEN it reports",
  ]);
  assert.deepEqual(wrapped.marks, ["failure"]);
  assert.equal(wrapped.scenarios.length, 3, "the continuation joins its item; no new item");
  for (const miss of [
    ["   - GIVEN a vault", "   - WHEN doctor runs", "   - THEN it reports (edge)"],
    ["   - GIVEN a vault", "   - AND a spec (failure)", "   - WHEN doctor runs", "   - THEN it reports"],
    ["   - GIVEN a vault （edge）", "   - WHEN doctor runs", "   - THEN it reports"],
    ["   - GIVEN a vault (Edge)", "   - WHEN doctor runs", "   - THEN it reports"],
    ["   - GIVEN a vault (edge).", "   - WHEN doctor runs", "   - THEN it reports"],
    ["   - GIVEN a vault `(edge)`", "   - WHEN doctor runs", "   - THEN it reports"],
    ["   - GIVEN a vault", "", "     (edge)", "   - WHEN doctor runs", "   - THEN it reports"],
  ])
    assert.deepEqual(c(miss).marks, [], miss.join(" | "));
  // Prose of the contract does not count.
  assert.deepEqual(
    parseSpecContracts(spec(["1. **One.** Prose (edge)", "   - GIVEN a", "   - WHEN b", "   - THEN c"]))[0].marks,
    [],
  );
  // A fenced scenario is not read at all.
  assert.deepEqual(parseSpecContracts(spec(["1. **One.**", "```", "   - GIVEN a (edge)", "```"]))[0].scenarios, []);
});

test("scenario shape still reads the joined items the same way", () => {
  const ok = spec(["1. **One.**", "   - GIVEN a vault that is", "     long", "   - THEN it reports"]);
  assert.deepEqual(checkScenarioShape([ok]), [], "a wrapped GIVEN is still a GIVEN");
  // A continuation that happens to start with THEN is not a THEN item.
  const noThen = spec(["1. **One.**", "   - GIVEN a vault where", "     THEN is only a word"]);
  assert.deepEqual(
    checkScenarioShape([noThen]).map((f) => f.check),
    ["scenario-shape"],
  );
});

// ─── contract-happy-path-only ──────────────────────────────────────────

test("contract-happy-path-only: an active spec's contracts with scenarios and no mark, by number; marked, scenario-less, draft and superseded are silent", () => {
  const body = [
    "1. **Bare.**",
    "   - GIVEN a",
    "   - WHEN b",
    "   - THEN c",
    "",
    "2. **Marked.**",
    "   - GIVEN a (edge)",
    "   - WHEN b",
    "   - THEN c",
    "",
    "3. **No scenarios.** Prose only.",
    "",
    "4′. **Primed and bare.**",
    "   - WHEN b",
    "   - THEN c",
  ];
  const f = checkHappyPathOnly([spec(body)]);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
  assert.equal(f[0].file, "specs/s.md");
  assert.equal(f[0].message, "2 of 3 contracts with scenarios have no scenario marked (edge) or (failure): 1, 4'.");
  assert.deepEqual(checkHappyPathOnly([spec(body, { status: "draft" }), spec(body, { status: "superseded" })]), []);
  assert.deepEqual(checkHappyPathOnly([spec(["1. **Marked.**", "   - GIVEN a (failure)", "   - THEN c"])]), []);
});

test("contract-happy-path-only runs inside the vault checks, with no git and no registry finding", async () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(
    join(vault, "specs", "SPEC-009-t.md"),
    `---\ntype: spec\nid: "SPEC-009"\ntitle: "T"\nstatus: active\nadr: []\nstories: []\n---\n\n# T\n\n## Behavioral contracts\n\n1. **One.**\n   - GIVEN a\n   - WHEN b\n   - THEN c\n\n## Acceptance\n\n- [ ] x\n`,
  );
  const other = (id, status, mark) =>
    writeFileSync(
      join(vault, "specs", `${id}-t.md`),
      `---\ntype: spec\nid: "${id}"\ntitle: "T"\nstatus: ${status}\nadr: []\nstories: []\n---\n\n# T\n\n## Behavioral contracts\n\n1. **One.**\n   - GIVEN a${mark}\n   - WHEN b\n   - THEN c\n\n## Acceptance\n\n- [ ] x\n`,
    );
  other("SPEC-010", "active", " (edge)");
  other("SPEC-011", "draft", "");
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  const noGit = () => ({ status: "no-git", lines: [] });
  const f = await runVaultChecks(cfg, { proj, grep: noGit });
  assert.deepEqual(
    f.filter((x) => x.check === "contract-happy-path-only").map((x) => x.file),
    ["specs/SPEC-009-t.md"],
    "the marked active spec and the draft spec are silent",
  );
  assert.ok(!f.some((x) => x.check === "registry"));
});

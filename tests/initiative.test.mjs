// projectstore — the initiative kind (spec "The initiative kind and its
// verbs", alias `initiative`, contracts 1 to 8; ADR "An initiative is a kind
// above the epic that records a decision, born proposed or accepted, and an
// epic names it by an initiative field"; PS-BACKLOG: "An initiative kind
// above the epic: its folder, template and guide, and the epic's initiative
// field"). Each test names the contract it covers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadLayout, gatherVaultFacts, renderVaultSkeleton } from "../scripts/lib.mjs";
import { planScaffold, applyScaffold } from "../scripts/scaffold.mjs";
import { runReconcile } from "../scripts/reconcile.mjs";
import { resolveGuide } from "../scripts/guides.mjs";
import { runVaultChecks, scanArtifacts } from "../scripts/doctor.mjs";
import { buildGraph } from "../scripts/graph.mjs";
import { lineage, LINEAGE_KINDS } from "../scripts/query.mjs";
import { initiativeStage } from "../scripts/stages.mjs";
import { checkInitiatives, INITIATIVE_STATUSES } from "../scripts/initiative.mjs";
import { seedInitiativeFixture, initiativeDoc, epicDoc, makeVaultProject } from "./fixtures/vault.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "projectstore.mjs");
const LAYOUT = loadLayout("engineering");
const LANGS = ["en", "ru", "es", "de", "fr", "zh"];
const cfgOf = (vault, language = "en") => ({ vault_path: vault, layout: "engineering", language });
const initiativeFindings = (vault, proj) =>
  runVaultChecks(cfgOf(vault), { proj }).filter((f) => f.check.startsWith("initiative-"));

// ─── Contract 1: the folder ─────────────────────────────────────────────

// [initiative#1]
test("the layout declares initiatives immediately before epics, and initiative among its commands", () => {
  const paths = LAYOUT.folders.map((f) => f.path);
  assert.equal(paths[paths.indexOf("epics") - 1], "initiatives");
  assert.deepEqual(
    LAYOUT.folders.find((f) => f.kind === "initiative"),
    { path: "initiatives", kind: "initiative", readme: true },
  );
  assert.ok(LAYOUT.commands.includes("initiative"));
  for (const lang of LANGS) {
    const s = JSON.parse(readFileSync(join(REPO, "templates", lang, "strings.json"), "utf8"));
    assert.ok(s.folders.initiative?.name, lang);
    assert.ok(s.folders.initiative.description.length <= 160 && !s.folders.initiative.description.includes("|"), lang);
  }
});

// [initiative#1]
test("scaffold on an empty vault creates initiatives/README.md, and the vault README lists Initiatives before Epics", () => {
  const vault = join(mkdtempSync(join(tmpdir(), "ps-init-")), "vault");
  mkdirSync(vault);
  const plan = planScaffold(vault, { layout: "engineering", language: "en", root: REPO });
  assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
  applyScaffold(plan);
  assert.ok(existsSync(join(vault, "initiatives", "README.md")));
  const readme = readFileSync(join(vault, "README.md"), "utf8");
  assert.ok(readme.indexOf("Initiatives") > 0 && readme.indexOf("Initiatives") < readme.indexOf("Epics"), readme);
});

// [initiative#1]
test("scaffold on a vault that has the other eight folders plans two create rows and writes nothing", () => {
  const vault = join(mkdtempSync(join(tmpdir(), "ps-init-")), "vault");
  mkdirSync(vault);
  applyScaffold(planScaffold(vault, { layout: "engineering", language: "en", root: REPO }));
  rmSync(join(vault, "initiatives"), { recursive: true });
  const before = readFileSync(join(vault, "README.md"), "utf8");
  const plan = planScaffold(vault, { layout: "engineering", language: "en", root: REPO });
  assert.deepEqual(
    plan.rows.filter((r) => r.action === "create").map((r) => r.rel),
    ["initiatives", "initiatives/README.md"],
  );
  assert.equal(plan.creates, 2);
  assert.equal(existsSync(join(vault, "initiatives")), false, "a plan writes nothing");
  assert.equal(readFileSync(join(vault, "README.md"), "utf8"), before);
});

// [initiative#1]
test("reconcile writes the initiative's index row, and the SessionStart skeleton has an initiatives row", async () => {
  const vault = join(mkdtempSync(join(tmpdir(), "ps-init-")), "vault");
  mkdirSync(vault);
  applyScaffold(planScaffold(vault, { layout: "engineering", language: "en", root: REPO }));
  writeFileSync(
    join(vault, "initiatives", "faster-onboarding.md"),
    initiativeDoc("faster-onboarding", "accepted", { outcome: "- 2026-11-14 accepted: grouped existing work" }),
  );
  const proj = dirname(vault);
  mkdirSync(join(proj, ".projectstore"), { recursive: true });
  writeFileSync(join(proj, ".projectstore", "projectstore.json"), JSON.stringify(cfgOf(vault)));
  runReconcile({
    write: true,
    only: "indexes=initiatives",
    projectDir: proj,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO },
  });
  const index = readFileSync(join(vault, "initiatives", "README.md"), "utf8");
  const row = index.split("\n").find((l) => l.includes("faster-onboarding"));
  assert.ok(row && row.includes("| accepted |") && row.includes("2026-11-14"), index);
  const skeleton = renderVaultSkeleton(await gatherVaultFacts(cfgOf(vault)));
  assert.match(skeleton, /\| `initiatives\/` \| initiative \|/);
});

// [initiative#1]
test("scaffold refuses a language whose strings lack folders.initiative, naming the key", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-init-root-"));
  for (const d of ["scaffold/layouts", "templates/en"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(
    join(root, "scaffold/layouts/engineering.json"),
    readFileSync(join(REPO, "scaffold/layouts/engineering.json")),
  );
  for (const f of ["vault-readme.md.tmpl", "folder-readme.md.tmpl"])
    writeFileSync(join(root, "templates/en", f), readFileSync(join(REPO, "templates/en", f)));
  const s = JSON.parse(readFileSync(join(REPO, "templates/en/strings.json"), "utf8"));
  delete s.folders.initiative;
  writeFileSync(join(root, "templates/en/strings.json"), JSON.stringify(s));
  const plan = planScaffold(join(root, "vault"), { layout: "engineering", language: "en", root });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.refusals.some((r) => r.message.includes("folders.initiative")),
    JSON.stringify(plan.refusals),
  );
});

// ─── Contract 2: the template, the command and the guide ────────────────

const KEYS = [
  "type",
  "id",
  "title",
  "status",
  "priority",
  "owner",
  "created",
  "updated",
  "elaboration",
  "external_refs",
  "tags",
  "review_status",
  "reviewed_at",
];
const frontmatterKeys = (md) =>
  md
    .split("\n---")[0]
    .split("\n")
    .map((l) => (l.match(/^(\w+):/) || [])[1])
    .filter(Boolean);
const headingsOf = (md) =>
  md
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3));

function draft(proj, title) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "draft.mjs"), "initiative", title], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: REPO },
    cwd: REPO,
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// [initiative#2]
test("draft initiative renders initiatives/<slug>.md with the ADR's keys, values, rows and sections", () => {
  const { proj } = makeVaultProject();
  const out = draft(proj, "Faster onboarding");
  assert.ok(out.path.endsWith(join("initiatives", "faster-onboarding.md")), out.path);
  assert.deepEqual(frontmatterKeys(out.content), KEYS);
  for (const line of [
    "status: proposed",
    "priority: p2",
    'owner: "Test"',
    'elaboration: ""',
    "external_refs: {}",
    "review_status: pending",
  ])
    assert.ok(out.content.split("\n").includes(line), line);
  for (const row of ["| **Status** | proposed |", "| **Priority** | p2 |", "| **Owner** | Test |"])
    assert.ok(out.content.includes(row), row);
  assert.deepEqual(headingsOf(out.content), [
    "Problem",
    "Who asks and why",
    "Success criterion",
    "Out of scope",
    "Open questions",
    "Outcome",
    "Related",
  ]);
});

// [initiative#2]
test("every locale's template has the same English keys and its own headings; the Success criterion heading is the registry's first form", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "scaffold", "headings.json"), "utf8")).headings;
  for (const lang of LANGS) {
    const t = readFileSync(join(REPO, "templates", lang, "initiative.md.tmpl"), "utf8");
    assert.deepEqual(frontmatterKeys(t), KEYS, lang);
    const h = headingsOf(t);
    assert.equal(h.length, 7, lang);
    assert.equal(h[2], registry.initiative_success[lang][0], lang);
    assert.equal(h[5], registry.initiative_outcome[lang][0], lang);
  }
  const { proj, vault } = makeVaultProject();
  writeFileSync(
    join(proj, ".projectstore", "projectstore.json"),
    JSON.stringify({ ...cfgOf(vault, "ru"), default_author: "Test" }),
  );
  const out = draft(proj, "Быстрый старт");
  assert.deepEqual(frontmatterKeys(out.content), KEYS);
  assert.ok(headingsOf(out.content).includes(registry.initiative_success.ru[0]));
});

// [initiative#2]
test("guide initiative prints the package guide, and a vault override wins as for any kind; a command exists for each harness", () => {
  const pkg = resolveGuide("initiative", { root: REPO });
  assert.equal(pkg.source, "package");
  const r = spawnSync(process.execPath, [BIN, "guide", "initiative"], { encoding: "utf8", cwd: REPO, timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /guide_for: initiative/);
  const { vault } = makeVaultProject();
  mkdirSync(join(vault, "guides"), { recursive: true });
  writeFileSync(
    join(vault, "guides", "initiative.md"),
    readFileSync(join(REPO, "scaffold", "guides", "initiative.md")),
  );
  assert.equal(resolveGuide("initiative", { vault, root: REPO }).source, "vault");
  assert.ok(existsSync(join(REPO, "commands", "initiative.md")));
  assert.ok(existsSync(join(REPO, "adapters", "codex", "skills", "projectstore-initiative", "SKILL.md")));
});

// ─── Contract 3: the section registry ───────────────────────────────────

// [initiative#3]
test("doctor reads the Success criterion and Outcome by any registered form: German headings in an English vault", () => {
  const de = initiativeDoc("faster-onboarding", "accepted", {
    success: "",
    outcome: "- 2026-11-14 accepted: grouped existing work",
  })
    .replace("## Success criterion", "## Erfolgskriterium")
    .replace("## Outcome", "## Ergebnis");
  const { proj, vault } = seedInitiativeFixture({ "initiatives/faster-onboarding.md": de });
  const f = initiativeFindings(vault, proj).filter((x) => x.file === "initiatives/faster-onboarding.md");
  assert.deepEqual(
    f.map((x) => `${x.level} ${x.check}`),
    ["info initiative-decision"],
    "the Outcome line is found under Ergebnis; the empty Erfolgskriterium is the note",
  );
});

// ─── Contracts 4 to 6: doctor ───────────────────────────────────────────

// [initiative#4] [initiative#5] [initiative#6]
test("the fixture's two accepted initiatives give only the empty-criterion note", () => {
  const { proj, vault } = seedInitiativeFixture();
  const f = initiativeFindings(vault, proj);
  assert.deepEqual(
    f.map((x) => `${x.level} ${x.check} ${x.file}`),
    ["info initiative-decision initiatives/empty-criterion.md"],
  );
});

// [initiative#4]
test("an epic naming no initiative, or naming one with the wrong case, is an initiative-links issue", () => {
  const { proj, vault } = seedInitiativeFixture({
    "epics/PS-C/epic.md": epicDoc("PS-C", 'initiative: "no-such-initiative"\n'),
    "epics/PS-D/epic.md": epicDoc("PS-D", 'initiative: "Faster-Onboarding"\n'),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-links");
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.level === "issue"));
  assert.match(f.find((x) => x.file.includes("PS-C")).message, /PS-C.*no-such-initiative/);
  assert.match(f.find((x) => x.file.includes("PS-D")).message, /PS-D.*Faster-Onboarding/);
});

// [initiative#4]
test("an empty, null or absent initiative key, and a layout with no initiative kind, give no initiative-links finding", () => {
  const { proj, vault } = seedInitiativeFixture({
    "epics/PS-C/epic.md": epicDoc("PS-C", 'initiative: ""\n'),
    "epics/PS-D/epic.md": epicDoc("PS-D", "initiative: null\n"),
    "epics/PS-E/epic.md": epicDoc("PS-E"),
  });
  assert.equal(initiativeFindings(vault, proj).filter((x) => x.check === "initiative-links").length, 0);
  const noKind = { ...LAYOUT, folders: LAYOUT.folders.filter((f) => f.kind !== "initiative") };
  const artifacts = scanArtifacts(cfgOf(vault), LAYOUT).concat([
    { kind: "epic", rel: "epics/PS-Z/epic.md", fm: { initiative: "gone" }, body: "" },
  ]);
  const hooks = { finding: (level, check) => ({ level, check }), resolveStory: () => ({}), epicIdOf: () => "PS-Z" };
  assert.deepEqual(checkInitiatives(noKind, artifacts, hooks), []);
});

// [initiative#4]
test("a list in initiative: is one initiative-links issue that says the key holds one id", () => {
  const { proj, vault } = seedInitiativeFixture({
    "epics/PS-C/epic.md": epicDoc("PS-C", 'initiative: ["a", "b"]\n'),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-links");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "issue");
  assert.match(f[0].message, /one initiative id, not a list/);
});

// [initiative#4]
test("an elaboration that names no story is an initiative-links issue on the initiative", () => {
  const { proj, vault } = seedInitiativeFixture({
    "initiatives/stray.md": initiativeDoc("stray", "proposed", { elaboration: "PS-X/story-none" }),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-links");
  assert.equal(f.length, 1);
  assert.equal(f[0].file, "initiatives/stray.md");
  assert.match(f[0].message, /stray.*PS-X\/story-none/);
});

// [initiative#5]
test("a status outside the four, or none, is an initiative-status warning; Accepted is read lower-cased", () => {
  assert.deepEqual([...INITIATIVE_STATUSES], ["proposed", "accepted", "rejected", "deferred"]);
  const { proj, vault } = seedInitiativeFixture({
    "initiatives/working.md": initiativeDoc("working", "in-progress"),
    "initiatives/bare.md": initiativeDoc("bare", "proposed").replace("status: proposed\n", ""),
    "initiatives/faster-onboarding.md": initiativeDoc("faster-onboarding", "Accepted", {
      outcome: "- 2026-11-14 accepted: grouped existing work",
    }),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-status");
  assert.deepEqual(f.map((x) => `${x.level} ${x.file}`).sort(), [
    "warn initiatives/bare.md",
    "warn initiatives/working.md",
  ]);
  assert.match(f.find((x) => x.file === "initiatives/working.md").message, /status in-progress/);
  assert.match(f.find((x) => x.file === "initiatives/bare.md").message, /status none/);
});

// [initiative#6]
test("an accepted initiative no epic names, and a rejected one whose only Outcome line says accepted, each get one warning", () => {
  const { proj, vault } = seedInitiativeFixture({
    "initiatives/orphan.md": initiativeDoc("orphan", "accepted", { outcome: "- 2026-11-14 accepted: x" }),
    "initiatives/turned-down.md": initiativeDoc("turned-down", "rejected", { outcome: "- 2026-11-14 accepted: x" }),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-decision" && x.level === "warn");
  assert.deepEqual(f.map((x) => x.file).sort(), ["initiatives/orphan.md", "initiatives/turned-down.md"]);
  assert.match(f.find((x) => x.file === "initiatives/orphan.md").message, /no epic names it/);
  assert.match(f.find((x) => x.file === "initiatives/turned-down.md").message, /no line "- YYYY-MM-DD rejected/);
});

// [initiative#6]
test("an Outcome line needs a valid date and a reason; a proposed initiative gets no decision finding", () => {
  const { proj, vault } = seedInitiativeFixture({
    "initiatives/bad-date.md": initiativeDoc("bad-date", "deferred", { outcome: "- 2026-02-30 deferred: later" }),
    "initiatives/no-reason.md": initiativeDoc("no-reason", "deferred", { outcome: "- 2026-02-03 deferred:   " }),
    "initiatives/idea.md": initiativeDoc("idea", "proposed", { success: "" }),
  });
  const f = initiativeFindings(vault, proj).filter((x) => x.check === "initiative-decision");
  assert.deepEqual(
    f
      .filter((x) => x.level === "warn")
      .map((x) => x.file)
      .sort(),
    ["initiatives/bad-date.md", "initiatives/no-reason.md"],
  );
  assert.equal(f.filter((x) => x.file === "initiatives/idea.md").length, 0);
});

// [initiative#6]
test("an accepted initiative with the template's empty Success criterion is a note, and doctor exits 0", () => {
  const { proj } = seedInitiativeFixture();
  const r = spawnSync(process.execPath, [BIN, "doctor", "--vault", "--json", "--project", proj], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO },
    timeout: 60000,
  });
  const out = JSON.parse(r.stdout);
  const findings = Array.isArray(out.result) ? out.result : [];
  const mine = findings.filter((x) => String(x.check).startsWith("initiative-"));
  assert.deepEqual(
    mine.map((x) => `${x.level} ${x.check}`),
    ["info initiative-decision"],
  );
  assert.equal(
    findings.some((x) => x.level === "issue"),
    r.status !== 0,
    "the exit follows issues only; the note does not move it",
  );
});

// ─── Contract 7: the graph ──────────────────────────────────────────────

const edgesOf = (vault) => buildGraph(cfgOf(vault), LAYOUT).edges.map((e) => `${e.from} | ${e.kind} | ${e.to}`);

// [initiative#7] [vault-link-graph-derived-view-and-shared-link-resolver#2] [vault-link-graph-derived-view-and-shared-link-resolver#4]
test("an epic's initiative: gives one initiative-contains edge from the initiative; a body link to it is a wikilink, not out-of-scope", () => {
  const { vault } = seedInitiativeFixture();
  const g = buildGraph(cfgOf(vault), LAYOUT);
  const e = g.edges.map((x) => `${x.from} | ${x.kind} | ${x.to}`);
  assert.ok(e.includes("initiatives/faster-onboarding.md | initiative-contains | epics/PS-A/epic.md"), e.join("\n"));
  assert.ok(e.includes("initiatives/empty-criterion.md | initiative-contains | epics/PS-B/epic.md"));
  assert.ok(e.includes("epics/PS-B/epic.md | wikilink | initiatives/faster-onboarding.md"));
  assert.equal(
    e.filter((x) => x.endsWith("| initiatives/faster-onboarding.md") && x.includes("out-of-scope")).length,
    0,
  );
  const node = g.nodes.find((n) => n.path === "initiatives/faster-onboarding.md");
  assert.equal(node.type, "initiative");
  assert.equal(node.status, "accepted");
});

// [initiative#7] [vault-link-graph-derived-view-and-shared-link-resolver#3]
test("an initiative: that names nothing, or a list, is a dead edge from the epic and no initiative-contains", () => {
  const { vault } = seedInitiativeFixture({
    "epics/PS-C/epic.md": epicDoc("PS-C", 'initiative: "gone"\n'),
    "epics/PS-D/epic.md": epicDoc("PS-D", 'initiative: ["a", "b"]\n'),
  });
  const e = edgesOf(vault);
  assert.ok(e.includes("epics/PS-C/epic.md | dead | gone"), e.join("\n"));
  assert.ok(e.includes('epics/PS-D/epic.md | dead | ["a", "b"]'), e.join("\n"));
  assert.equal(e.filter((x) => x.includes("initiative-contains") && /PS-[CD]/.test(x)).length, 0);
});

// [initiative#7]
test("lineage does not walk initiative-contains: asking for it is a usage error that lists the lineage kinds", () => {
  assert.deepEqual(LINEAGE_KINDS, ["supersedes", "spec-covers", "spec-implements-adr", "epic-contains", "amends"]);
  const { vault } = seedInitiativeFixture();
  assert.throws(
    () => lineage(cfgOf(vault), "epics/PS-A/epic.md", { kinds: ["initiative-contains"] }),
    /--kind for lineage takes one of supersedes, spec-covers/,
  );
});

// ─── Contract 8: the derived state ──────────────────────────────────────

const zero = { done: 0, active: 0, backlog: 0 };

// [initiative#8]
test("rejected and deferred are as recorded, read trimmed and lower-cased", () => {
  assert.equal(initiativeStage("rejected", { done: 3, active: 1, backlog: 0 }, 2, "Review"), "rejected");
  assert.equal(initiativeStage(" Deferred ", zero, 0, null), "deferred");
});

// [initiative#8]
test("a proposed initiative is elaborating while its story is In Progress or Review, else proposed", () => {
  assert.equal(initiativeStage("proposed", zero, 0, "Review"), "elaborating");
  assert.equal(initiativeStage("proposed", zero, 0, "In Progress"), "elaborating");
  assert.equal(initiativeStage("proposed", zero, 0, "ToDo"), "proposed");
  assert.equal(initiativeStage("in-progress", zero, 1, null), "proposed", "a status outside the four is not accepted");
});

// [initiative#8]
test("an accepted initiative is done when every counted story is done, in progress when one is active", () => {
  assert.equal(initiativeStage("accepted", { done: 3, active: 0, backlog: 0 }, 1, null), "done");
  assert.equal(initiativeStage("accepted", { done: 1, active: 1, backlog: 0 }, 1, null), "in-progress");
  assert.equal(initiativeStage("accepted", { done: 1, active: 0, backlog: 2 }, 1, null), "accepted");
});

// [initiative#8]
test("an accepted initiative with no counted story, or with no epic, stays accepted", () => {
  assert.equal(initiativeStage("accepted", zero, 1, null), "accepted");
  assert.equal(initiativeStage("accepted", { done: 2, active: 0, backlog: 0 }, 0, null), "accepted");
});

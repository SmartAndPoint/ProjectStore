// projectstore — authoring guides: one guide per kind, read by the author
// before the draft and by the critic after it, overridable from the vault
// (the authoring-guides ADR, decisions 1-5 and 8; SPEC-001 contract 12; the
// PS-SPEC story "Each artifact kind has one authoring guide that the author
// reads before the draft and the critic checks after, and a vault can
// override it").
//
// Every test here covers [SPEC-001#12].

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guideItems } from "../scripts/lib.mjs";
import { parseGuide, resolveGuide, guideKinds, planEject, GUIDE_SECTIONS } from "../scripts/guides.mjs";
import { checkGuides, walkVaultFiles, runVaultChecks } from "../scripts/doctor.mjs";
import { run } from "../scripts/cli.mjs";
import { runRead } from "../scripts/read-verbs.mjs";
import { createServer, TOOLS, TOOL_CEILING } from "../scripts/mcp.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = JSON.parse(readFileSync(join(REPO, "scaffold", "layouts", "engineering.json"), "utf8"));
const KINDS = ["adr", "concept", "epic", "meeting", "research", "runbook", "spec", "story"];

class Sink {
  constructor() {
    this.text = "";
  }
  write(s) {
    this.text += String(s);
    return true;
  }
  get isTTY() {
    return false;
  }
}

const guideText = (name, { must = ["One rule."], extra = "", fm = "" } = {}) =>
  `---\nguide_for: ${name}\nguide_version: 1\ndefault_review: true\n${fm}---\n\n## Must\n\n${must.map((m) => `- ${m}`).join("\n")}\n${extra}`;

// A package root of its own, so the resolver's order can be shown with files
// the real package will never ship.
function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "ps-guides-root-"));
  mkdirSync(join(root, "scaffold", "guides"), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, "scaffold", "guides", `${n}.md`), t);
  return root;
}
function putGuide(vault, name, text) {
  mkdirSync(join(vault, "guides"), { recursive: true });
  writeFileSync(join(vault, "guides", `${name}.md`), text);
}
async function cli(argv, opts = {}) {
  const stdout = new Sink(),
    stderr = new Sink();
  const code = await run(argv, { env: {}, cwd: opts.cwd || REPO, stdout, stderr, ask: opts.ask });
  return { code, out: stdout.text, err: stderr.text, json: argv.includes("--json") ? JSON.parse(stdout.text) : null };
}

// ─── The item parser and the parse rule ───────────────────────────────

test("guideItems: a bullet with its wrapped and nested lines is one item; a blank line or a same-depth bullet ends it", () => {
  const items = guideItems(["- one", "  wrapped", "  - nested", "- two", "", "  stray", "- three", "not an item"]);
  assert.deepEqual(items, ["one wrapped - nested", "two", "three"]);
  assert.deepEqual(guideItems(["- [ ] a checkbox is still a bullet"]), ["[ ] a checkbox is still a bullet"]);
});

test("parseGuide: frontmatter, guide_for equal to the file name and a ## Must item; a trailing comment breaks guide_for", () => {
  assert.equal(parseGuide(guideText("spec"), "spec").ok, true);
  assert.match(parseGuide("## Must\n\n- x\n", "spec").reason, /no frontmatter/);
  assert.match(parseGuide(guideText("adr"), "spec").reason, /guide_for/);
  assert.match(parseGuide(guideText("spec", { must: [] }), "spec").reason, /## Must has no item/);
  const commented = guideText("spec").replace("guide_for: spec", "guide_for: spec   # a kind");
  assert.equal(parseGuide(commented, "spec").ok, false, "values are bare");
  const fenced = guideText("spec", { must: [] }) + "\n```\n## Must\n- inside a fence\n```\n";
  assert.equal(parseGuide(fenced, "spec").ok, false, "a fenced heading is not a section");
});

// ─── The package defaults ──────────────────────────────────────────────

test("package guides: one per kind with a checklist, each parses, at most 80 lines, scaffold/checklists.json is gone", () => {
  const files = readdirSync(join(REPO, "scaffold", "guides")).filter((f) => f.endsWith(".md"));
  for (const k of KINDS) assert.ok(files.includes(`${k}.md`), k);
  for (const f of files) {
    const name = f.slice(0, -3);
    const text = readFileSync(join(REPO, "scaffold", "guides", f), "utf8");
    assert.ok(parseGuide(text, name).ok, f);
    assert.ok(text.split("\n").length <= 80, `${f} is ${text.split("\n").length} lines`);
    assert.match(text, /^guide_version: \d+$/m, f);
  }
  assert.equal(existsSync(join(REPO, "scaffold", "checklists.json")), false);
});

test("package guides: the 0.30.9 checklist items moved verbatim under ## Must, with default_review", () => {
  // The last checklists.json, read from git history (the release that shipped it).
  let old;
  try {
    old = JSON.parse(
      execFileSync("git", ["show", "v0.30.9:scaffold/checklists.json"], { cwd: REPO, encoding: "utf8" }),
    );
  } catch {
    return; // a tarball without history: the hash test below still pins the files
  }
  for (const [k, v] of Object.entries(old)) {
    if (k.startsWith("_")) continue;
    const g = resolveGuide(k, { root: REPO });
    // The spec guide keeps the eight and adds the amendment items after them
    // (SPEC-001 contract 12, *Readers*, as amended 2026-11-10): a prefix.
    if (k === "spec") {
      assert.deepEqual(g.sections.Must.slice(0, v.items.length), v.items, k);
      assert.ok(g.sections.Must.length > v.items.length, k);
    } else assert.deepEqual(g.sections.Must, v.items, k);
    assert.equal(g.default_review, v.default_review, k);
  }
});

test("package guides: a content change bumps guide_version (recorded hashes)", async () => {
  const { guideHashes } = await import("./fixtures/guides.mjs");
  const recorded = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "guide-hashes.json"), "utf8"));
  const now = guideHashes(REPO);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(recorded).sort(), "every guide is recorded");
  for (const [name, r] of Object.entries(now)) {
    const was = recorded[name];
    if (r.hash !== was.hash)
      assert.ok(
        r.guide_version > was.guide_version,
        `${name}.md changed without a guide_version bump; bump it, then node tests/fixtures/guides.mjs --write`,
      );
    assert.deepEqual(r, was, `${name}: record the new hash with node tests/fixtures/guides.mjs --write`);
  }
});

// ─── Resolution ────────────────────────────────────────────────────────

test("resolveGuide: vault variant > package variant > vault base > package base, pairwise", () => {
  const { vault } = makeVaultProject();
  const tag = (n, who) => guideText(n, { must: [`${who} ${n}`] });
  const pick = (root) => resolveGuide("story.local", { vault, root }).sections.Must[0];
  // package base only
  let root = fixtureRoot({ story: tag("story", "package") });
  assert.equal(pick(root), "package story");
  // vault base beats package base
  putGuide(vault, "story", tag("story", "vault"));
  assert.equal(pick(root), "vault story");
  // package variant beats vault base
  root = fixtureRoot({ story: tag("story", "package"), "story.local": tag("story.local", "package") });
  assert.equal(pick(root), "package story.local");
  // vault variant beats package variant
  putGuide(vault, "story.local", tag("story.local", "vault"));
  assert.equal(pick(root), "vault story.local");
  const g = resolveGuide("story.local", { vault, root });
  assert.equal(g.kind, "story.local");
  assert.equal(g.source, "vault");
  assert.equal(g.guide_version, null, "a vault file's guide_version is ignored");
});

test("resolveGuide: a vault file that does not parse or cannot be read is skipped with a warning; --source keeps one side; an edit is seen at once", () => {
  const { vault } = makeVaultProject();
  putGuide(vault, "spec", guideText("spec", { must: [] }));
  let g = resolveGuide("spec", { vault, root: REPO });
  assert.equal(g.source, "package");
  assert.match(g.warnings[0], /guides\/spec\.md: ## Must has no item/);
  // A directory named like a guide is unreadable, not a crash.
  mkdirSync(join(vault, "guides", "adr.md"));
  g = resolveGuide("adr", { vault, root: REPO });
  assert.equal(g.source, "package");
  assert.match(g.warnings[0], /guides\/adr\.md: not a file/);
  // An edit between two calls is visible: no cache.
  putGuide(vault, "spec", guideText("spec", { must: ["edited"] }));
  assert.deepEqual(resolveGuide("spec", { vault, root: REPO }).sections.Must, ["edited"]);
  assert.equal(resolveGuide("spec", { vault, root: REPO, source: "package" }).source, "package");
  assert.equal(resolveGuide("research", { vault, root: REPO, source: "vault" }).resolved, null);
  assert.deepEqual(guideKinds({ vault, root: REPO }), [...KINDS, "story.test"].sort());
  assert.throws(() => resolveGuide("../x", { root: REPO }), /guide takes a kind/);
  assert.throws(() => resolveGuide("a/b", { root: REPO }), /guide takes a kind/);
});

// ─── The verb ──────────────────────────────────────────────────────────

test("guide verb: text and --json; --section; --source package behind an override; a stderr warning; exit codes", async () => {
  const { proj, vault } = makeVaultProject();
  const t = await cli(["guide", "spec", "--project", proj]);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /^guide spec · source package · .*scaffold\/guides\/spec\.md\n/);
  const j = await cli(["guide", "spec", "--json", "--project", proj]);
  assert.deepEqual(Object.keys(j.json.result).sort(), [
    "based_on",
    "default_review",
    "guide_version",
    "kind",
    "path",
    "sections",
    "source",
    "warnings",
  ]);
  assert.deepEqual(Object.keys(j.json.result.sections), GUIDE_SECTIONS);
  const one = await cli(["guide", "spec", "--section", "Must", "--json", "--project", proj]);
  assert.deepEqual(Object.keys(one.json.result.sections), ["Must"]);
  const must = await cli(["guide", "spec", "--section", "Must", "--project", proj]);
  assert.match(must.out, /\n## Must\n/);
  assert.ok(!must.out.includes("## Lens"));
  assert.match(
    (await cli(["guide", "research", "--section", "Lens", "--project", proj])).out,
    /no ## Lens in this guide/,
  );
  assert.equal((await cli(["guide", "spec", "--section", "Nope", "--project", proj])).code, 2);
  assert.equal((await cli(["guide", "spec", "--source", "both", "--project", proj])).code, 2);
  assert.equal((await cli(["guide", "../x", "--project", proj])).code, 2);
  const none = await cli(["guide", "diagram", "--project", proj]);
  assert.equal(none.code, 1);
  assert.match(none.err, /Kinds with a guide: adr, concept, epic, meeting, research, runbook, spec, story/);
  // eject, then the vault side wins and the package stays readable behind it.
  assert.equal((await cli(["guide", "eject", "spec", "--write", "--json", "--project", proj])).code, 0);
  assert.equal((await cli(["guide", "spec", "--json", "--project", proj])).json.result.source, "vault");
  assert.equal(
    (await cli(["guide", "spec", "--source", "package", "--json", "--project", proj])).json.result.source,
    "package",
  );
  // A broken override: the default, and a warning on stderr (text) or in result.warnings (json).
  putGuide(vault, "adr", "---\nguide_for: adr\n---\n");
  const w = await cli(["guide", "adr", "--project", proj]);
  assert.match(w.err, /guide: skipped guides\/adr\.md/);
  assert.match((await cli(["guide", "adr", "--json", "--project", proj])).json.result.warnings[0], /guides\/adr\.md/);
  // An unbound project still reads the package default.
  const bare = mkdtempSync(join(tmpdir(), "ps-guides-bare-"));
  assert.equal((await cli(["guide", "epic", "--json", "--project", bare])).json.result.source, "package");
});

test("guide eject: a preview writes nothing; --write creates package bytes plus based_on; a second run refuses; the read runner refuses eject", async () => {
  const { proj, vault } = makeVaultProject();
  const p = await cli(["guide", "eject", "spec", "--project", proj]);
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /Nothing written\./);
  assert.match(p.out, /\nnpx projectstore guide eject spec --write\n$/);
  assert.equal(existsSync(join(vault, "guides")), false);
  const w = await cli(["guide", "eject", "spec", "--write", "--project", proj]);
  assert.equal(w.code, 0, w.err);
  const pkg = readFileSync(join(REPO, "scaffold", "guides", "spec.md"), "utf8");
  const copy = readFileSync(join(vault, "guides", "spec.md"), "utf8");
  const v = pkg.match(/^guide_version: (\d+)$/m)[1];
  assert.equal(copy, pkg.replace(`guide_version: ${v}\n`, `guide_version: ${v}\nbased_on: ${v}\n`));
  const again = await cli(["guide", "eject", "spec", "--write", "--project", proj]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  assert.equal(readFileSync(join(vault, "guides", "spec.md"), "utf8"), copy, "byte-identical");
  assert.equal(
    (await cli(["guide", "eject", "story.nope", "--write", "--project", proj])).code,
    1,
    "no package file of that name",
  );
  // A variant with a package file ejects like a kind.
  assert.equal((await cli(["guide", "eject", "story.test", "--write", "--project", proj])).code, 0);
  assert.match(readFileSync(join(vault, "guides", "story.test.md"), "utf8"), /^based_on: 1$/m);
  assert.equal(planEject("spec", { vault: null, root: REPO }).ok, false);
  // The runner the MCP server runs: eject is a usage error, and nothing is written.
  const { proj: p2, vault: v2 } = makeVaultProject();
  const r = await runRead(["guide", "eject", "spec", "--write", "--project", p2], {
    env: {},
    cwd: p2,
    stdout: new Sink(),
    stderr: new Sink(),
  });
  assert.equal(r, 2);
  assert.equal(existsSync(join(v2, "guides")), false);
});

test("guide eject at a terminal (injected ask): the copy, then the question; n writes nothing and exits 1; --json never asks", async () => {
  const { proj, vault } = makeVaultProject();
  const asked = [];
  const no = await cli(["guide", "eject", "story", "--write", "--project", proj], {
    ask: async (q) => (asked.push(q), "n"),
  });
  assert.equal(no.code, 1);
  assert.equal(asked.length, 1);
  assert.match(no.out, /Nothing written\.\n$/);
  assert.equal(existsSync(join(vault, "guides", "story.md")), false);
  const yes = await cli(["guide", "eject", "story", "--write", "--json", "--project", proj], {
    ask: async () => assert.fail("--json asked"),
  });
  assert.equal(yes.code, 0);
  assert.equal(yes.json.result.written, true);
});

// ─── Doctor ────────────────────────────────────────────────────────────

test("doctor: guide-shape, guide-unknown and guide-stale; nothing without guides/; a guide with no based_on is never stale", () => {
  const { proj, vault } = makeVaultProject();
  assert.deepEqual(checkGuides(vault, LAYOUT, { proj, root: REPO }), []);
  putGuide(vault, "spec", guideText("spec", { must: [] }));
  putGuide(vault, "foo", guideText("foo"));
  putGuide(vault, "foo.test", guideText("foo.test"));
  putGuide(vault, "adr", guideText("adr", { fm: "based_on: 1\n" }));
  putGuide(vault, "epic", guideText("epic"));
  const root = fixtureRoot({ adr: guideText("adr").replace("guide_version: 1", "guide_version: 2") });
  const f = checkGuides(vault, LAYOUT, { proj, root });
  const by = (c) => f.filter((x) => x.check === c).map((x) => x.file);
  assert.deepEqual(by("guide-shape"), ["guides/spec.md"]);
  assert.deepEqual(by("guide-unknown"), ["guides/foo.md", "guides/foo.test.md"]);
  assert.deepEqual(by("guide-stale"), ["guides/adr.md"]);
  const stale = f.find((x) => x.check === "guide-stale");
  assert.equal(stale.level, "info");
  assert.match(stale.message, /version 1.*version 2/);
  assert.match(stale.message, /\nnpx projectstore guide adr --source package$/);
  assert.ok(!by("guide-stale").includes("guides/epic.md"), "no based_on, never stale");
});

test("doctor: the vault-root guides/ is not an artifact — no walk entry, no name collision, a nested guides/ stays", async () => {
  const { proj, vault } = makeVaultProject();
  mkdirSync(join(vault, "concepts"), { recursive: true });
  writeFileSync(join(vault, "concepts", "spec.md"), "---\ntype: concept\nslug: spec\ntitle: Spec\n---\n\n# Spec\n");
  putGuide(vault, "spec", guideText("spec"));
  mkdirSync(join(vault, "epics", "PS-X", "guides"), { recursive: true });
  writeFileSync(join(vault, "epics", "PS-X", "guides", "note.md"), "# a note\n");
  const rels = walkVaultFiles(vault).map((f) => f.rel);
  assert.ok(!rels.some((r) => r.startsWith("guides/")));
  assert.ok(rels.includes("epics/PS-X/guides/note.md"));
  // A note whose [[spec]] has no artifact behind it: the guide must not make it resolve.
  writeFileSync(
    join(vault, "concepts", "linker.md"),
    "---\ntype: concept\nslug: linker\ntitle: Linker\n---\n\nSee [[spek]] and [[spec]].\n",
  );
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  const before = await runVaultChecks(cfg, { proj });
  assert.ok(
    !before.some((x) => x.check === "artifact-name"),
    "guides/spec.md beside concepts/spec.md is no name collision",
  );
  assert.ok(!before.some((x) => /guides/.test(x.message) && !x.check.startsWith("guide-")));
  const s = await cli(["search", "One rule", "--json", "--project", proj]);
  assert.ok(!JSON.stringify(s.json.result).includes("guides/"), "search finds nothing in guides/");
  // Regenerate the views, then touch a guide: status does not call them stale.
  for (const only of ["kanban", "graph"])
    assert.equal((await cli(["reconcile", "--write", "--only", only, "--json", "--project", proj])).code, 0, only);
  putGuide(vault, "adr", guideText("adr"));
  const st = await cli(["status", "--json", "--project", proj]);
  const views = st.json.result.views;
  for (const name of ["kanban", "graph"]) assert.equal(views[name].stale, false, `${name} is not stale`);
});

// ─── MCP ───────────────────────────────────────────────────────────────

test("mcp guide tool: nine tools; the tool returns the verb's envelope; kind eject is an error that writes nothing", async () => {
  assert.equal(TOOL_CEILING, 9);
  assert.ok(TOOLS.guide);
  assert.match(TOOLS.guide.description, /before drafting an artifact of that kind and before reviewing one/);
  const { proj, vault } = makeVaultProject();
  const s = createServer({ project: proj, env: {} });
  await s.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = (args) =>
    s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guide", arguments: args } });
  const r = await call({ kind: "spec", source: "package" });
  const viaTool = JSON.parse(r.result.content[0].text);
  const viaCli = (await cli(["guide", "spec", "--source", "package", "--json", "--project", proj])).json;
  assert.deepEqual(viaTool, viaCli);
  const e = await call({ kind: "eject" });
  assert.equal(e.result.isError, true);
  assert.equal(existsSync(join(vault, "guides")), false);
  assert.equal((await call({ kind: "spec", source: "--help" })).error.code, -32602);
});

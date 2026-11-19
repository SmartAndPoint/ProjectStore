// projectstore — a spec older than its code (spec "Spec staleness: an anchor
// per spec, code newer than its spec, a parent behind its children, and the
// checked marker", alias `spec-stale`; PS-SPECTREE: "Code newer than its
// spec"). Each test names the contract it covers.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/spec-stale.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { buildGraph } from "../scripts/graph.mjs";
import { loadLayout } from "../scripts/lib.mjs";
import { parseSpecMarkers, parseAmendmentMarkers } from "../scripts/grammar.mjs";
import { trunkHistory } from "../scripts/diff-refs.mjs";
import { specTreeOf } from "../scripts/spec-code.mjs";
import { specAnchors } from "../scripts/spec-stale.mjs";
import { buildSpecDrift } from "../scripts/spec-drift.mjs";
import { git, gitCommit } from "./fixtures/flow.mjs";
import { seedSpecCodeFixture, REFS, SOURCES } from "./fixtures/spec-code.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = "2026-11-19T12:00:00.000Z";
const quiet = { commits: () => ({ status: "ok", commits: [] }), grep: () => ({ status: "ok", lines: [] }) };
const doctorOf = (fx, opts = {}) => runVaultChecks(fx.cfg, { proj: fx.proj, now: NOW, ...quiet, ...opts });
const stale = (fx, opts) => doctorOf(fx, opts).filter((f) => f.check.startsWith("spec-stale"));
const failingSeam = () => {
  throw new Error("git must not run");
};

// A spec file with its parent, refs, date and markers. A marker under 0 sits
// above the first contract.
function writeSpec(fx, id, { parent = null, refs = [], date = "2026-11-01", markers = [], stories = [], title = id }) {
  const fm = ["---", "type: spec", `id: "${id}"`, `title: "${title}"`, "status: active", `date: ${date}`];
  fm.push("adr: []", `stories: ${JSON.stringify(stories)}`);
  if (parent) fm.push(`parent: "${parent}"`);
  fm.push(`code_refs: ${JSON.stringify(refs)}`, "---", "");
  const at = (n) => markers.filter((m) => m.under === n).map((m) => `> ${m.text}\n`);
  const body = [`# ${title}`, "", "## How we solve", "", "Fixture.", "", "## Behavioral contracts", ""];
  body.push(...at(0), "1. **One.** A thing happens.", "", ...at(1), "2. **Two.** Another.", "", ...at(2));
  body.push("## Acceptance", "", "- [ ] It happens", "");
  writeFileSync(join(fx.vault, "specs", `${id}.md`), fm.join("\n") + body.join("\n"));
}

// The story the fixture covers `api-queue` with.
function writeStory(fx, { status = "in-progress", closedAt = null, specs = ["api-queue"], extra = "" } = {}) {
  const lines = ["---", "type: story", 'id: "story-t"', 'epic: "PS-X"', 'title: "T"', `status: ${status}`];
  lines.push("priority: p2", `specs: ${JSON.stringify(specs)}`, "code_refs: []");
  if (closedAt) lines.push(`closed_at: "${closedAt}"`);
  if (extra) lines.push(extra);
  lines.push("---", "", "# T", "");
  writeFileSync(join(fx.vault, "epics", "PS-X", "stories", "story-t.md"), lines.join("\n"));
}

// The fixture tree in a repository whose first commit is before every anchor.
function staleFixture() {
  const fx = seedSpecCodeFixture({ commit: false });
  git(fx.proj, ["init", "-q"]);
  gitCommit(fx.proj, { files: SOURCES, message: "sources", at: "2026-10-01T09:00:00Z" });
  writeSpec(fx, "web", { parent: "app", refs: REFS.web });
  return fx;
}
const commitAt = (fx, at, files) => gitCommit(fx.proj, { files, at, message: `change at ${at}` });

// [spec-stale#1]
test("anchors: the text anchor is the latest of date: and the markers, the close anchor the latest covering close", () => {
  const fx = staleFixture();
  writeSpec(fx, "api-queue", {
    parent: "api",
    refs: REFS["api-queue"],
    markers: [{ under: 1, text: "amended 2026-11-05 by PS-X/story-t: MODIFIED — a change" }],
    stories: ["PS-X/story-t"],
  });
  writeStory(fx, { status: "done", closedAt: "2026-11-07T10:00:00.000Z" });
  const { index, layout, tree } = specTreeOf(fx.cfg);
  const a = specAnchors(index, tree, { layout, now: NOW }).get("specs/api-queue.md");
  assert.equal(a.text, "2026-11-05");
  assert.equal(a.close, Date.parse("2026-11-07T10:00:00.000Z"));
});

// [spec-stale#1]
test("anchors: a checked marker dated far ahead, or naming no story, is skipped and doctor names it", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", {
    parent: "app",
    refs: REFS.web,
    markers: [
      { under: 1, text: "checked 2099-01-01 by PS-X/story-t: compared the cart with the code" },
      { under: 2, text: "checked 2026-11-10 by PS-X/no-such-story: compared the totals" },
    ],
  });
  const { index, layout, tree } = specTreeOf(fx.cfg);
  const resolveStory = (ref) => (ref === "PS-X/story-t" ? { story: {} } : { error: "no story" });
  assert.equal(specAnchors(index, tree, { layout, now: NOW, resolveStory }).get("specs/web.md").text, "2026-11-01");
  const found = doctorOf(fx);
  assert.ok(found.some((f) => f.check === "amendment-date" && f.level === "warn" && /^Checked marker/.test(f.message)));
  assert.ok(
    found.some((f) => f.check === "amendment-story" && f.level === "issue" && /^Checked marker/.test(f.message)),
  );
});

// [spec-stale#1]
test("anchors: a spec with no valid date and no marker is one info no-anchor", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", { parent: "app", refs: REFS.web, date: "soon" });
  const info = stale(fx).filter((f) => f.reason === "no-anchor");
  assert.deepEqual(
    info.map((f) => [f.level, f.file]),
    [["info", "specs/web.md"]],
  );
});

// [spec-stale#2]
test("work in flight: a spec covering a story in progress is not judged, and its close after the merge leaves it fresh", () => {
  const fx = staleFixture();
  commitAt(fx, "2026-11-12T09:00:00Z", { "src/api/queue.mjs": "v2\n" });
  assert.deepEqual(
    stale(fx).filter((f) => f.file === "specs/api-queue.md"),
    [],
    "story-t is in progress",
  );
  writeStory(fx, { status: "done", closedAt: "2026-11-12T10:00:00.000Z" });
  assert.deepEqual(
    stale(fx).filter((f) => f.file === "specs/api-queue.md"),
    [],
  );
});

// [spec-stale#2]
test("work in flight: a story closed before its pull request merged leaves a warn that names the checked remedy", () => {
  const fx = staleFixture();
  writeStory(fx, { status: "done", closedAt: "2026-11-12T10:00:00.000Z" });
  commitAt(fx, "2026-11-13T09:00:00Z", { "src/api/queue.mjs": "v2\n" });
  const found = stale(fx).filter((f) => f.file === "specs/api-queue.md");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /newest on 2026-11-13.*> checked YYYY-MM-DD by <story>/);
});

// [spec-stale#3]
test("history: on a work branch that merged main, the trunk is read and the merge is not", () => {
  const fx = staleFixture();
  git(fx.proj, ["checkout", "-q", "-b", "work"]);
  git(fx.proj, ["checkout", "-q", "main"]);
  commitAt(fx, "2026-10-15T09:00:00Z", { "src/web/cart.mjs": "v2\n" });
  git(fx.proj, ["checkout", "-q", "work"]);
  git(fx.proj, ["merge", "-q", "--no-ff", "-m", "merge main", "main"], {
    GIT_AUTHOR_DATE: "2026-11-12T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-12T09:00:00Z",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "nobody",
    GIT_COMMITTER_NAME: "A",
    GIT_COMMITTER_EMAIL: "nobody",
  });
  const h = trunkHistory(fx.proj, "2026-11-01");
  assert.equal(h.ref, "refs/heads/main");
  assert.deepEqual(h.commits, []);
  assert.deepEqual(
    stale(fx).filter((f) => f.file === "specs/web.md"),
    [],
  );
});

// [spec-stale#3]
test("history: the remote's default branch wins over the local main, and a project in a subfolder reads its own paths", () => {
  const fx = staleFixture();
  const sha = git(fx.proj, ["rev-parse", "HEAD"]);
  git(fx.proj, ["update-ref", "refs/remotes/origin/main", sha]);
  git(fx.proj, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  assert.equal(trunkHistory(fx.proj, "2026-09-01").ref, "refs/remotes/origin/HEAD");
  const repo = mkdtempSync(join(tmpdir(), "ps-stale-sub-"));
  git(repo, ["init", "-q"]);
  gitCommit(repo, { files: { "sub/src/a.mjs": "a\n", "other/b.mjs": "b\n" }, at: "2026-11-02T09:00:00Z" });
  const sub = trunkHistory(join(repo, "sub"), "2026-11-01");
  assert.deepEqual(
    sub.commits.map((c) => c.paths),
    [["src/a.mjs"]],
  );
});

// [spec-stale#3]
test("history: a shallow clone gives one spec-stale-unknown info, and no spec-stale-code", () => {
  const fx = staleFixture();
  commitAt(fx, "2026-11-12T09:00:00Z", { "src/web/cart.mjs": "v2\n" });
  commitAt(fx, "2026-11-13T09:00:00Z", { "src/web/cart.mjs": "v3\n" });
  const clone = mkdtempSync(join(tmpdir(), "ps-stale-shallow-"));
  git(clone, ["clone", "-q", "--depth", "1", `file://${fx.proj}`, "."]);
  const h = trunkHistory(clone, "2026-11-01");
  assert.deepEqual(h, { status: "unknown", reason: "shallow" });
  const found = stale(fx, { history: () => h });
  assert.deepEqual(
    found.map((f) => [f.level, f.check, f.reason]),
    [["info", "spec-stale-unknown", "shallow"]],
  );
  assert.match(found[0].message, /shallow clone.*runs on a full clone/);
});

// [spec-stale#3] [spec-stale#4]
test("history: no tree, or a tree whose specs name no code, starts no git", () => {
  const flat = seedSpecCodeFixture({ refs: {}, commit: false });
  assert.deepEqual(stale(flat, { history: failingSeam, lsFiles: failingSeam }), []);
});

// [spec-stale#4]
test("code newer: a commit to a leaf's file after its anchor is one warn naming the spec, the anchor, the count and the day", () => {
  const fx = staleFixture();
  commitAt(fx, "2026-11-11T09:00:00Z", { "src/web/cart.mjs": "v2\n" });
  const found = stale(fx).filter((f) => f.check === "spec-stale-code" && f.file === "specs/web.md");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.match(
    found[0].message,
    /^Spec specs\/web\.md was last changed or checked on 2026-11-01, and 1 commit on main/,
  );
  assert.match(found[0].message, /newest on 2026-11-11/);
});

// [spec-stale#4]
test("code newer: a merge after local midnight on the close's UTC day does not count", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", { parent: "app", refs: REFS.web, stories: ["PS-X/story-t"] });
  writeStory(fx, { status: "done", closedAt: "2026-11-17T19:14:00.000Z", specs: ["web"] });
  commitAt(fx, "2026-11-17T19:00:00Z", { "src/web/cart.mjs": "v2\n" });
  gitCommit(fx.proj, {
    files: { "src/web/cart.mjs": "v3\n" },
    at: "2026-11-18T01:14:00+06:00",
    message: "merge",
  });
  const h = trunkHistory(fx.proj, "2026-11-01");
  assert.equal(h.commits[0].day, "2026-11-18", "the committer's own day");
  assert.deepEqual(
    stale(fx).filter((f) => f.file === "specs/web.md"),
    [],
  );
});

// [spec-stale#4] [spec-stale#7]
test("code newer: a checked marker dated the commit's day or later removes the warn", () => {
  const fx = staleFixture();
  commitAt(fx, "2026-11-11T09:00:00Z", { "src/web/cart.mjs": "v2\n" });
  writeSpec(fx, "web", {
    parent: "app",
    refs: REFS.web,
    markers: [{ under: 0, text: "checked 2026-11-11 by PS-X/story-t: compared the cart rules with src/web/cart.mjs" }],
  });
  assert.deepEqual(
    stale(fx).filter((f) => f.file === "specs/web.md"),
    [],
  );
});

// [spec-stale#7]
test("checked marker: valid under a contract or above the first, no amendment finding, no graph edge", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", {
    parent: "app",
    refs: REFS.web,
    markers: [
      { under: 0, text: "checked 2026-11-12 by PS-X/story-t: every contract against src/web/" },
      { under: 2, text: "checked 2026-11-12 by PS-X/story-t: queue defaults match the code" },
    ],
  });
  const body = readFileSync(join(fx.vault, "specs", "web.md"), "utf8");
  const markers = parseSpecMarkers(body);
  assert.deepEqual(
    markers.map((m) => [m.marker, m.kind, m.contract, m.valid]),
    [
      ["checked", "checked", null, true],
      ["checked", "checked", "2", true],
    ],
  );
  assert.deepEqual(parseAmendmentMarkers(body), []);
  const found = doctorOf(fx).filter((f) => f.file === "specs/web.md" && /^(amendment|checked)-/.test(f.check));
  assert.deepEqual(found, [], "story-t does not list web: no link rule for a check");
  const g = buildGraph(fx.cfg, loadLayout("engineering"));
  assert.ok(!g.edges.some((e) => e.kind === "amends" && e.to === "specs/web.md"));
});

// [spec-stale#7]
test("checked marker: a malformed one is checked-form, never amendment-form", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", {
    parent: "app",
    refs: REFS.web,
    markers: [{ under: 1, text: "checked 12-11-2026 by PS-X/story-t: x" }],
  });
  const found = doctorOf(fx).filter((f) => f.file === "specs/web.md" && /-form$/.test(f.check));
  assert.deepEqual(
    found.map((f) => [f.level, f.check]),
    [["warn", "checked-form"]],
  );
  assert.match(found[0].message, /^Checked marker at contract 1/);
});

// [spec-stale#8]
test("spec-drift: a checked marker above contract 1 anchors a contract amended earlier, and says it is a check", () => {
  const fx = staleFixture();
  writeSpec(fx, "web", {
    parent: "app",
    refs: REFS.web,
    stories: ["PS-X/story-t"],
    markers: [
      { under: 0, text: "checked 2026-11-14 by PS-X/story-t: every contract against src/web/" },
      { under: 2, text: "amended 2026-11-05 by PS-X/story-t: MODIFIED — a change" },
    ],
  });
  writeStory(fx, { specs: ["web", "api-queue"] });
  const r = buildSpecDrift({ proj: fx.proj, cfg: fx.cfg, query: "web" });
  const c2 = r.bundle.contracts.find((c) => c.n === "2");
  assert.equal(c2.anchor, "2026-11-14");
  assert.equal(c2.anchor_from, "checked");
});

// [spec-stale#9]
test("reviewer: every shipped copy reports a checked marker whose why names no comparison", () => {
  for (const rel of [
    "agents/reviewer.md",
    "adapters/codex/skills/projectstore-reviewer/SKILL.md",
    "packaging/shells/projectstore-codex/skills/projectstore-reviewer/SKILL.md",
  ]) {
    const text = readFileSync(join(REPO, rel), "utf8").replace(/\s+/g, " ");
    assert.match(text, /any `checked` marker whose `<why>` does not say what was compared with what/, rel);
  }
});

// [spec-stale#3]
test("history: a pull request merged into main counts once, on its own day, with the paths it changed against its first parent", () => {
  const fx = staleFixture();
  git(fx.proj, ["checkout", "-q", "-b", "feature"]);
  commitAt(fx, "2026-11-10T09:00:00Z", { "src/web/cart.mjs": "v2\n" });
  commitAt(fx, "2026-11-10T10:00:00Z", { "src/api/http.mjs": "v2\n" });
  git(fx.proj, ["checkout", "-q", "main"]);
  const when = "2026-11-12T09:00:00Z";
  const id = {
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "nobody",
    GIT_COMMITTER_NAME: "A",
    GIT_COMMITTER_EMAIL: "nobody",
  };
  git(fx.proj, ["merge", "-q", "--no-ff", "-m", "Merge pull request", "feature"], {
    ...id,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  const h = trunkHistory(fx.proj, "2026-11-01");
  assert.deepEqual(
    h.commits.map((c) => [c.day, c.paths]),
    [["2026-11-12", ["src/api/http.mjs", "src/web/cart.mjs"]]],
  );
});

// [spec-stale#3]
test("history: a remote default branch that points nowhere is passed over, and the local main is read", () => {
  const fx = staleFixture();
  git(fx.proj, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"]);
  const h = trunkHistory(fx.proj, "2026-09-01");
  assert.equal(h.ref, "refs/heads/main");
  assert.equal(h.branch, "main");
});

// [spec-stale#2] [spec-stale#3]
test("history: when every spec with code covers work in flight, git is not started", () => {
  const fx = staleFixture();
  writeSpec(fx, "app", { refs: [] });
  writeSpec(fx, "api", { parent: "app", refs: [] });
  writeSpec(fx, "web", { parent: "app", refs: [] });
  assert.deepEqual(stale(fx, { history: failingSeam }), [], "only api-queue names code, and story-t is in progress");
});

// projectstore — the spec-drift bundle and the reviewer's spec-drift mode
// (PS-SPEC: "The reviewer can run against an active spec and its code_refs
// and report where the code drifted from the contracts").
//
// The bundle script, its six scenarios and the reviewer's mode text cover
// [SPEC-001#10]; the docs section covers [SPEC-001#11].
//
// Every token for a fixture spec is built at run time (tok), never written
// as a literal: this repository's own doctor scans its tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSpecDrift, resolveSpec, globRe, classOf } from "../scripts/spec-drift.mjs";
import { sinceWindow } from "../scripts/diff-refs.mjs";
import { readConfigAt } from "../scripts/lib.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";
import { git as fixtureGit } from "./fixtures/git-vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "spec-drift.mjs");
const tok = (key, n) => "[" + key + "#" + n + "]";
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

// ─── Fixture ───────────────────────────────────────────────────────────

const CONTRACTS = [
  "1. **One.** The thing is built.",
  "   - GIVEN a vault",
  "   - WHEN it runs (edge)",
  "   - THEN the thing is there",
  "",
  "2. **Two.** The thing is changed.",
  "",
  "   > amended 2026-02-01 by PS-X/story-open: MODIFIED — the change, still open.",
  "",
  "3. **Three.** Removed, see below.",
  "",
  "   > amended 2026-01-15 by PS-X/story-built: REMOVED — the rule is gone.",
  "",
  "4. **Four.** (verified: live) Seen on a host only.",
  "",
  "   > amended 2026-01-20 by PS-X/story-nowhere: MODIFIED — names no story.",
  "",
  "   > amended 2026-01-21 by PS-X/story-built: CHANGED — not a kind.",
];

const specMd = (fm, contracts = CONTRACTS) =>
  `---\ntype: spec\n${fm}\n---\n\n# Spec\n\n## Behavioral contracts\n\n${contracts.join("\n")}\n\n## Acceptance\n\n- [ ] one\n`;

const storyMd = (id, status, refs) =>
  `---\ntype: story\nid: "${id}"\ntitle: "${id} title"\nstatus: ${status}\ncreated: 2026-01-01\nspecs: ["drift-me"]\ncode_refs: ${JSON.stringify(refs)}\n---\n\n# ${id}\n`;

function seed({ alias = "dm" } = {}) {
  const { proj, vault } = makeVaultProject();
  const put = (root, rel, content) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  put(vault, "epics/PS-X/epic.md", `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\n---\n\n# X\n`);
  put(
    vault,
    "epics/PS-X/stories/story-built.md",
    storyMd("story-built", "done", [
      "src/a.mjs",
      "src/lib/",
      "docs/*.md",
      "tests/**/*.test.mjs",
      "**/README.md",
      "gone/missing.mjs",
      "nomatch/*.js",
    ]),
  );
  put(vault, "epics/PS-X/stories/story-open.md", storyMd("story-open", "in-progress", ["./src/b.mjs"]));
  put(vault, "epics/PS-X/stories/story-empty.md", storyMd("story-empty", "done", []));
  const stories = '["PS-X/story-built", "PS-X/story-open", "PS-X/story-empty", "PS-X/story-ghost"]';
  put(
    vault,
    "specs/drift-me.md",
    specMd(
      `id: "drift-me"\nalias: "${alias}"\ntitle: "Drift me"\nstatus: active\ndate: 2026-01-01\nstories: ${stories}`,
    ),
  );
  put(vault, "specs/drafty.md", specMd(`id: "drafty"\ntitle: "Drafty"\nstatus: draft\ndate: 2026-01-01`));
  put(vault, "specs/old.md", specMd(`id: "old"\ntitle: "Old"\nstatus: superseded\ndate: 2026-01-01`));
  put(vault, "specs/README.md", "# Specs\n");
  put(proj, "src/a.mjs", "one\ntwo\nthree\n");
  put(proj, "src/b.mjs", "b\n");
  put(proj, "src/lib/x.mjs", "x\nx\n");
  put(proj, "src/lib/y.mjs", "y");
  put(proj, "src/lib/node_modules/z.js", "ignored\n");
  put(proj, "docs/guide.md", "# Guide\n\nText.\n");
  put(proj, "docs/sub/README.md", "# Deep\n");
  put(proj, "docs/sub/deep.md", "not matched by docs/*.md\n");
  put(proj, "tests/unit/a.test.mjs", "t1\nt2\nt3\nt4\n");
  put(proj, "README.md", "# Project\n");
  return { proj, vault, cfg: readConfigAt(proj) };
}

// Stub git: answers `git log --since=<window> … -- <paths>` from a commit list,
// newest first. A bare date given without the window rule reads as that day at
// the current time of day, as git's approxidate does, so a same-day commit is
// lost.
const COMMITS = [
  { sha: "a".repeat(40), date: "2026-02-05T10:00:00+00:00", subject: "c2", files: ["src/a.mjs", "src/b.mjs"] },
  { sha: "b".repeat(40), date: "2026-02-01T08:00:00+00:00", subject: "c3 same day", files: ["src/lib/x.mjs"] },
  { sha: "c".repeat(40), date: "2026-01-20T10:00:00+00:00", subject: "c4", files: ["src/a.mjs"] },
  { sha: "d".repeat(40), date: "2026-01-12T10:00:00+00:00", subject: "c5", files: ["docs/guide.md"] },
  { sha: "e".repeat(40), date: "2026-01-10T10:00:00+00:00", subject: "c1", files: ["src/a.mjs"] },
  { sha: "f".repeat(40), date: "2026-01-05T10:00:00+00:00", subject: "c0", files: ["src/a.mjs"] },
];
function stubGit(commits = COMMITS) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push(args);
    if (!args.includes("log")) return null;
    const since = args.find((a) => a.startsWith("--since=")).slice("--since=".length);
    const cutoff = / 00:00:00$/.test(since)
      ? since.slice(0, 10)
      : /^\d{4}-\d{2}-\d{2}$/.test(since)
        ? `${since}T23:59`
        : since;
    const paths = new Set(args.slice(args.indexOf("--") + 1));
    return commits
      .filter((c) => c.date >= cutoff)
      .map((c) => ({ ...c, files: c.files.filter((f) => paths.has(f)) }))
      .filter((c) => c.files.length)
      .map((c) => `\x1e${c.sha}\x1f${c.date}\x1f${c.subject}\n\n${c.files.join("\n")}\n`)
      .join("");
  };
  fn.calls = calls;
  return fn;
}
const okGrep =
  (lines = []) =>
  () => ({ status: "ok", lines });
const CITES = [
  { file: "tests/unit/a.test.mjs", line: 3, text: `covers ${tok("drift-me", "1")} by id` },
  { file: "tests/unit/a.test.mjs", line: 4, text: `covers ${tok("dm", "2")} by alias` },
  { file: "tests/unit/a.test.mjs", line: 5, text: `and ${tok("example", "1")}, docs only` },
  { file: "tests/unit/a.test.mjs", line: 6, text: `and ${tok("old", "1")}, another spec` },
  { file: "src/a.mjs", line: 1, text: `a step ${tok("drift-me", "1/1")}` },
];

function bundle(opts = {}) {
  const { proj, cfg } = opts.fixture || seed();
  const r = buildSpecDrift({
    proj,
    cfg,
    query: opts.query ?? "drift-me",
    since: opts.since ?? null,
    git: opts.git || stubGit(),
    grep: opts.grep || okGrep(CITES),
  });
  return r;
}
const contract = (b, n) => b.contracts.find((c) => c.n === n);

function runCli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...clean, ...env },
    cwd: REPO,
    timeout: 30000,
  });
}

// ─── Contract 10's scenarios ───────────────────────────────────────────

test("scenario: an active spec's bundle has one row per contract and states the input size", () => {
  const { bundle: b } = bundle();
  assert.deepEqual(
    b.contracts.map((c) => [c.n, c.heading, c.removed]),
    [
      ["1", "One", false],
      ["2", "Two", false],
      ["3", "Three", true],
      ["4", "Four", false],
    ],
  );
  assert.equal(contract(b, "3").why, "the rule is gone.", "a removed contract keeps its marker's why");
  assert.equal(contract(b, "4").verified, "live");
  assert.deepEqual(contract(b, "1").marks, ["edge"]);
  assert.equal(contract(b, "1").scenarios.length, 3);
  assert.deepEqual(b.totals.files_by_class, { source: 4, tests: 1, surface: 3 });
  assert.deepEqual(b.totals.lines, { source: 7, tests: 4, surface: 5, total: 16 });
  assert.equal(b.totals.files, 8);
  assert.equal(b.totals.contracts, 4);
  assert.equal(b.totals.contracts_open, 3);
  assert.equal(b.totals.contracts_removed, 1);
  assert.equal(b.scan.status, "ok");
});

test("scenario: a spec with nine contracts that are not removed gives the size and the contract list", () => {
  const fx = seed();
  const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. **Rule ${i + 1}.** Text.\n`);
  writeFileSync(
    join(fx.vault, "specs", "nine.md"),
    specMd(`id: "nine"\ntitle: "Nine"\nstatus: active\ndate: 2026-01-01\nstories: ["PS-X/story-open"]`, nine),
  );
  const { bundle: b } = bundle({ fixture: fx, query: "nine" });
  assert.equal(b.totals.contracts_open, 9, "over the default budget of 8");
  assert.deepEqual(
    b.contracts.map((c) => `${c.n} ${c.heading}`),
    nine.map((_, i) => `${i + 1} Rule ${i + 1}`),
  );
});

test("scenario: a marker whose story is not done carries that story's status; a dead ref and an invalid marker say so", () => {
  const { bundle: b } = bundle();
  const m2 = contract(b, "2").markers;
  assert.equal(m2.length, 1);
  assert.deepEqual(m2[0].story, { rel: "epics/PS-X/stories/story-open.md", status: "in-progress" });
  assert.equal(m2[0].kind, "MODIFIED");
  assert.equal(m2[0].date, "2026-02-01");
  const m4 = contract(b, "4").markers;
  assert.deepEqual(
    m4.map((m) => [m.valid, m.story, Boolean(m.story_error), Boolean(m.form)]),
    [
      [true, null, true, false],
      [false, { rel: "epics/PS-X/stories/story-built.md", status: "done" }, false, true],
    ],
  );
  assert.deepEqual(contract(b, "3").markers[0].story, { rel: "epics/PS-X/stories/story-built.md", status: "done" });
});

test("scenario: a code_refs path that no longer exists is listed as missing, and so is a glob that matches nothing", () => {
  const { bundle: b } = bundle();
  assert.deepEqual(b.refs.missing, [
    { story: "PS-X/story-built", ref: "gone/missing.mjs" },
    { story: "PS-X/story-built", ref: "nomatch/*.js" },
  ]);
  const built = b.stories.find((s) => s.ref === "PS-X/story-built");
  assert.deepEqual(built.missing, ["gone/missing.mjs", "nomatch/*.js"]);
  assert.equal(built.status, "done");
  assert.deepEqual(b.refs.empty, ["PS-X/story-empty"], "an empty code_refs is a fact of its own");
  assert.equal(b.refs.unresolved.length, 1);
  assert.equal(b.refs.unresolved[0].story, "PS-X/story-ghost");
  assert.equal(b.totals.refs_missing, 2);
  assert.equal(b.totals.stories, 4);
});

test("scenario: a project that is not a git repository has scan status no-git, and history and citations are null, not empty", () => {
  const git = stubGit();
  const { bundle: b } = bundle({ grep: () => ({ status: "no-git", lines: [] }), git });
  assert.equal(b.scan.status, "no-git");
  for (const c of b.contracts) {
    assert.equal(c.cited_by, null, `contract ${c.n}: citations unknown`);
    assert.equal(c.files_changed, null, `contract ${c.n}: history unknown`);
  }
  for (const f of b.files) assert.equal(f.changed_since, null, f.path);
  assert.equal(b.totals.files_changed, null);
  assert.equal(git.calls.length, 0, "no git log once the scan says no-git");
});

test("a spec with no anchor at all (no date:, no marker, no --since) reports history unknown, not none", () => {
  const fixture = seed();
  writeFileSync(
    join(fixture.vault, "specs/noanchor.md"),
    specMd(`id: "noanchor"\ntitle: "No anchor"\nstatus: active\nstories: ["PS-X/story-built"]`, [
      "1. **One.** It does one thing.",
    ]),
  );
  const { bundle: b } = bundle({ fixture, query: "noanchor" });
  assert.ok(b, "the bundle is built");
  for (const f of b.files) assert.equal(f.changed_since, null, f.path);
  assert.equal(b.totals.files_changed, null);
});

test("scenario: the script itself, on a real directory that is no repository, says no-git", () => {
  const { proj } = seed();
  const r = runCli(["drift-me", "--project", proj]);
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.equal(b.scan.status, "no-git");
  assert.ok(b.files.every((f) => f.changed_since === null));
  assert.ok(b.contracts.every((c) => c.cited_by === null));
});

test("scenario: a draft or a superseded spec exits 1 naming its status", () => {
  const { proj } = seed();
  for (const [q, status] of [
    ["drafty", "draft"],
    ["old", "superseded"],
  ]) {
    const r = runCli([q, "--project", proj]);
    assert.equal(r.status, 1, q);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`is ${status}, not active`), q);
  }
  const fx = seed();
  assert.deepEqual(bundle({ fixture: fx, query: "drafty" }).error, "not-active");
});

// ─── Anchors, --since and the window ───────────────────────────────────

test("anchor: the last valid marker's date, else the spec's date; a removed contract's anchor asks no history", () => {
  const git = stubGit();
  const { bundle: b } = bundle({ git });
  assert.deepEqual(
    b.contracts.map((c) => [c.n, c.anchor, c.anchor_from]),
    [
      ["1", "2026-01-01", "date"],
      ["2", "2026-02-01", "marker"],
      ["3", "2026-01-15", "marker"],
      ["4", "2026-01-20", "marker"],
    ],
    "a valid marker counts for the anchor even when its ref names no story; the invalid one after it does not",
  );
  const windows = git.calls.map((a) => a.find((x) => x.startsWith("--since=")));
  assert.deepEqual(windows, [
    "--since=2026-01-01 00:00:00",
    "--since=2026-01-20 00:00:00",
    "--since=2026-02-01 00:00:00",
  ]);
});

test("--since overrides every anchor, and goes through the bare-date window", () => {
  const git = stubGit();
  const { bundle: b } = bundle({ git, since: "2026-02-01" });
  assert.equal(b.since, "2026-02-01");
  assert.ok(b.contracts.every((c) => c.anchor === "2026-02-01" && c.anchor_from === "since"));
  assert.deepEqual(
    git.calls.map((a) => a.find((x) => x.startsWith("--since="))),
    ["--since=2026-02-01 00:00:00"],
  );
  const x = b.files.find((f) => f.path === "src/lib/x.mjs");
  assert.equal(x.changed_since["2026-02-01"].count, 1, "a commit on the anchor's own day counts");
});

test("the bare-date window: midnight for a bare date, anything else as given", () => {
  assert.equal(sinceWindow("2026-02-01"), "2026-02-01 00:00:00");
  assert.equal(sinceWindow("2026-02-01T09:49:09.068Z"), "2026-02-01T09:49:09.068Z");
  // Without the rule the stub reads the date at the time of day, as git does.
  const raw = stubGit()(".", ["log", "--since=2026-02-01", "--", "src/lib/x.mjs"]);
  assert.equal(raw, "", "the same-day commit is lost without the window");
});

test("changed_since: per file and per anchor, a count and the last three, newest first; files_changed per contract", () => {
  const { bundle: b } = bundle();
  const a = b.files.find((f) => f.path === "src/a.mjs");
  assert.deepEqual(Object.keys(a.changed_since), ["2026-01-01", "2026-01-20", "2026-02-01"]);
  assert.equal(a.changed_since["2026-01-01"].count, 4);
  assert.deepEqual(
    a.changed_since["2026-01-01"].last.map((c) => c.subject),
    ["c2", "c4", "c1"],
  );
  assert.equal(a.changed_since["2026-01-01"].last[0].commit, "a".repeat(12));
  assert.equal(a.changed_since["2026-02-01"].count, 1);
  const y = b.files.find((f) => f.path === "src/lib/y.mjs");
  assert.deepEqual(y.changed_since, {
    "2026-01-01": { count: 0, last: [] },
    "2026-01-20": { count: 0, last: [] },
    "2026-02-01": { count: 0, last: [] },
  });
  assert.equal(contract(b, "1").files_changed, 4);
  assert.equal(contract(b, "2").files_changed, 3);
  assert.equal(contract(b, "4").files_changed, 3);
  assert.equal(contract(b, "3").files_changed, null, "a removed contract is not judged");
  assert.equal(b.totals.files_changed, 4);
});

// ─── Files ─────────────────────────────────────────────────────────────

test("files: a directory, a trailing slash, `*`, `**` and `?` expand; SOURCE_IGNORE and the vault drop out; classes split the size", () => {
  const { bundle: b } = bundle();
  assert.deepEqual(
    b.files.map((f) => [f.path, f.class, f.lines]),
    [
      ["README.md", "surface", 1],
      ["docs/guide.md", "surface", 3],
      ["docs/sub/README.md", "surface", 1],
      ["src/a.mjs", "source", 3],
      ["src/b.mjs", "source", 1],
      ["src/lib/x.mjs", "source", 2],
      ["src/lib/y.mjs", "source", 1],
      ["tests/unit/a.test.mjs", "tests", 4],
      // Not in the list: src/lib/node_modules/z.js (SOURCE_IGNORE), docs/sub/deep.md
      // (`*` stays in one segment), vault/specs/README.md (the vault).
    ],
  );
  assert.deepEqual(b.files.find((f) => f.path === "src/b.mjs").refs, ["./src/b.mjs"], "the ref as the story wrote it");
  assert.ok(!b.files.some((f) => f.path.startsWith("vault/")));
  assert.match("src/q.mjs", globRe("src/?.mjs"));
  assert.doesNotMatch("src/qq.mjs", globRe("src/?.mjs"));
  assert.match("a/b/c.test.mjs", globRe("**/*.test.mjs"));
  assert.match("c.test.mjs", globRe("**/*.test.mjs"));
  assert.equal(classOf("packaging/shells/x/package.json"), "surface");
  assert.equal(classOf("scripts/x.mjs"), "source");
  assert.equal(classOf("scripts/x.test.mjs"), "tests");
});

// ─── Citations ─────────────────────────────────────────────────────────

test("citations: keyed by id and by alias, a step counts for its contract, `example` and other specs are ignored", () => {
  const { bundle: b } = bundle();
  assert.deepEqual(contract(b, "1").cited_by, [
    { file: "src/a.mjs", line: 1, n: "1/1" },
    { file: "tests/unit/a.test.mjs", line: 3, n: "1" },
  ]);
  assert.deepEqual(contract(b, "2").cited_by, [{ file: "tests/unit/a.test.mjs", line: 4, n: "2" }]);
  assert.deepEqual(contract(b, "4").cited_by, [], "uncited is an empty list, not null");
});

test("citations: a spec whose alias is the reserved key still ignores `example` tokens", () => {
  const { bundle: b } = bundle({ fixture: seed({ alias: "example" }) });
  assert.deepEqual(contract(b, "1").cited_by, [
    { file: "src/a.mjs", line: 1, n: "1/1" },
    { file: "tests/unit/a.test.mjs", line: 3, n: "1" },
  ]);
  assert.deepEqual(contract(b, "2").cited_by, [], "the alias token went with `dm`; the `example` one is docs");
});

// ─── Scan status ───────────────────────────────────────────────────────

test("scan status unknown: a scan that did not finish leaves citations null; a git log that did not answer leaves history null", () => {
  const timedOut = bundle({ grep: () => ({ status: "unknown", reason: "the scan timed out", lines: [] }) }).bundle;
  assert.deepEqual(timedOut.scan, { status: "unknown", reason: "the scan timed out" });
  assert.ok(timedOut.contracts.every((c) => c.cited_by === null));
  assert.equal(timedOut.files.find((f) => f.path === "src/a.mjs").changed_since["2026-01-01"].count, 4);

  const noLog = bundle({ git: () => null }).bundle;
  assert.deepEqual(noLog.scan, { status: "unknown", reason: "git log did not answer" });
  assert.ok(noLog.files.every((f) => Object.values(f.changed_since).every((v) => v === null)));
  assert.ok(noLog.contracts.every((c) => c.files_changed === null));
  assert.equal(noLog.totals.files_changed, null);
  assert.equal(contract(noLog, "1").cited_by.length, 2, "citations are still known");
});

// ─── Which spec ────────────────────────────────────────────────────────

test("which spec: by id, alias or stem; unknown and ambiguous give candidates and exit 1", () => {
  const fx = seed();
  writeFileSync(
    join(fx.vault, "specs", "dm.md"),
    specMd(`id: "dm-two"\ntitle: "Another"\nstatus: active\ndate: 2026-01-01`),
  );
  assert.equal(bundle({ fixture: fx, query: "drift-me" }).bundle.spec.id, "drift-me");
  assert.equal(bundle({ fixture: fx, query: "DRIFT-ME" }).bundle.spec.id, "drift-me", "case-insensitive fallback");
  assert.equal(bundle({ fixture: fx, query: "dm-two" }).bundle.spec.id, "dm-two");
  const amb = bundle({ fixture: fx, query: "dm" });
  assert.equal(amb.error, "ambiguous");
  assert.deepEqual(
    amb.candidates.map((c) => c.id),
    ["dm-two", "drift-me"],
  );
  const unk = bundle({ fixture: fx, query: "drif" });
  assert.equal(unk.error, "unknown");
  assert.deepEqual(
    unk.candidates.map((c) => c.id),
    ["drift-me"],
  );

  let r = runCli(["dm", "--project", fx.proj]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"dm" names more than one spec; name one of: dm-two \(specs\/dm\.md, active\); drift-me/);
  r = runCli(["nothing-like-it", "--project", fx.proj]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No spec answers to "nothing-like-it" by id, alias or filename\. Candidates: /);
  assert.match(r.stderr, /drafty \(specs\/drafty\.md, draft\)/, "with no near match, every spec is a candidate");
  assert.equal(resolveSpec([], "x").error, "unknown");
});

test("an unbound project is told to bind first", () => {
  const empty = mkdtempSync(join(tmpdir(), "ps-drift-unbound-"));
  const r = runCli(["drift-me", "--project", empty]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No projectstore config\. Run \S*bind\S* first\./);
  assert.equal(r.stdout, "");
});

test("two runs print byte-identical JSON, in a real repository too", () => {
  const { proj } = seed();
  fixtureGit(proj, "init", "-q");
  fixtureGit(proj, "add", "-A");
  fixtureGit(proj, "commit", "-qm", "seed");
  const one = runCli(["drift-me", "--project", proj]);
  const two = runCli(["dm", "--project", proj]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, two.stdout, "by id and by alias, the same bytes");
  const b = JSON.parse(one.stdout);
  assert.equal(b.scan.status, "ok");
  assert.ok(!/generated_at/.test(one.stdout));
  assert.equal(b.files.find((f) => f.path === "src/a.mjs").changed_since["2026-01-01"].count, 1);
  assert.equal(b.files.find((f) => f.path === "src/a.mjs").changed_since["2026-01-01"].last[0].subject, "seed");
});

// ─── The reviewer's mode and the docs ──────────────────────────────────

test("agents/reviewer.md: the which-job paragraph, the mode before Phase 0, the bundle call and the description", () => {
  const t = read("agents", "reviewer.md");
  const which = t.indexOf("**Which job.**");
  const inspect = t.indexOf("Inspect everything yourself");
  const mode = t.indexOf("## Spec-drift mode");
  const phase0 = t.indexOf("## Phase 0");
  assert.ok(which > 0 && which < inspect, "which job comes before the inspection paragraph");
  assert.ok(mode > inspect && mode < phase0, "the mode section comes before Phase 0");
  assert.match(flat(t.slice(which, inspect)), /Given a diff or a story, you check story conformance/);
  assert.match(flat(t.slice(which, inspect)), /Asked for spec drift on a named spec/);
  assert.ok(t.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-drift.mjs" <spec id, alias or file stem>`'));
  const desc = (t.match(/^description: (.+)$/m) || [])[1];
  assert.match(desc, /Asked for spec drift on a named active spec, it checks that spec's contracts/);
});

test("agents/reviewer.md: the budget is in contracts, 8 by default, and above it no verdict", () => {
  const m = flat(read("agents", "reviewer.md").split("## Spec-drift mode")[1].split("## Phase 0")[0]);
  assert.match(m, /The report states the input size/);
  assert.match(
    m,
    /more contracts that are not removed \(`totals\.contracts_open`\) than the caller's budget, 8 when none is named/,
  );
  assert.match(
    m,
    /return the size and the contract list \(number and heading\), ask your caller for contract numbers and give no verdict/,
  );
  assert.match(m, /Given numbers \(up to the budget\), judge those and list the rest as `not checked`/);
});

test("agents/reviewer.md: the verdicts, the proposals, facts not drift, its own report, and nothing written", () => {
  const m = flat(read("agents", "reviewer.md").split("## Spec-drift mode")[1].split("## Phase 0")[0]);
  assert.match(m, /`holds`: a line of code, quoted verbatim with its file:line, produces the contract's outcome/);
  assert.match(m, /A `holds` without a quoted line is `cannot tell`/);
  assert.match(m, /`\(outside the bundle\)`/);
  assert.match(
    m,
    /`drifted`: the code contradicts the contract as written, a named file, command or token that is gone included/,
  );
  assert.match(m, /the search that found nothing/);
  assert.match(m, /`cannot tell`, with its reason/);
  assert.match(m, /a scan status of `unknown`/);
  assert.match(m, /has not reached `review`, the verdict is `cannot tell \(pending\)`/);
  assert.match(m, /A contract amended by a story in `review` or `done` is judged as usual/);
  assert.match(m, /A removed contract is listed as `removed` and not judged/);
  assert.match(m, /Each `drifted` comes with a proposal and a lean/);
  assert.match(m, /never a closed story/);
  assert.match(m, /are listed as facts, not drift/);
  assert.match(m, /History is a hint: an empty one is no evidence that a contract holds/);
  assert.match(m, /in place of the Output section/);
  assert.match(m, /You write nothing in this mode/);
  assert.match(m, /A spec that is not `active` is refused with exit 1/);
});

test("docs/contracts-and-tests.md: checking a spec against the code, after amending, with the reserved key only", () => {
  const d = read("docs", "contracts-and-tests.md");
  const at = d.indexOf("\n## Checking a spec against the code\n");
  assert.ok(at > d.indexOf("\n## Amending a contract\n"), "after Amending a contract");
  assert.ok(at < d.indexOf("\n## What doctor reports\n"));
  const sec = flat(d.slice(at, d.indexOf("\n## What doctor reports\n")));
  assert.match(sec, /node scripts\/spec-drift\.mjs example/);
  for (const v of ["`holds`", "`drifted`", "`cannot tell`", "`cannot tell (pending)`", "`no-git`", "`unknown`"])
    assert.ok(sec.includes(v), v);
  assert.match(sec, /up to eight contracts per run/);
  assert.match(sec, /The reviewer writes nothing/);
  for (const m of sec.matchAll(/(?<!\[)\[([A-Za-z0-9][A-Za-z0-9._-]*)#[0-9]/g)) assert.equal(m[1], "example");
});

// projectstore — contract scenarios and test citations (the spec policy ADR,
// Part A; PS-SPEC: "A spec contract can carry WHEN/THEN scenarios, a test
// cites it as spec-id#n, and doctor reports the contracts no test cites").
//
// Every citation token in this file is built at run time, never written as a
// literal: this repository's own doctor scans its tests, and a literal token
// for a spec that does not exist would be reported as unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { citationTokenRe, contractNumberAscii } from "../scripts/lib.mjs";
import { grepProjectLines } from "../scripts/diff-refs.mjs";
import {
  parseSpecContracts,
  checkSpecAliases,
  checkScenarioShape,
  scanCitations,
  checkContractCitations,
  checkEvidenceCitations,
  runVaultChecks,
} from "../scripts/doctor.mjs";
import { git } from "./fixtures/git-vault.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const tok = (key, n) => "[" + key + "#" + n + "]";

// The install spec's real forms: contract 0, a bold heading that wraps, steps
// 1′ and 1″ nested under 4, 4′ after 6, a plain-text contract, and a
// template-style comment whose "1." must not become a contract.
const CONTRACTS = [
  "## Behavioral contracts",
  "",
  "<!-- Numbered.",
  "1. not a contract: inside a comment -->",
  "",
  "0. **The zeroth contract has a bold heading that",
  "   wraps.** (verified： live) It is observed on a host.",
  "",
  "1. Plain text contract with no bold heading.",
  "   - GIVEN a vault",
  "   - WHEN doctor runs",
  "   - THEN it reports the row",
  "",
  "4. **Steps.** The contract has steps:",
  "   1′. the first step",
  "   1″. the second step",
  "      1. too deep, belongs to 1″",
  "",
  "6. **Six.** Scenario without a THEN:",
  "   - WHEN something happens",
  "",
  "4′. **Four prime.** Comes after six.",
  "",
  "10. **Ten.** (verified: manual)",
  "",
  "```",
  "11. fenced, not a contract",
  "```",
  "",
  "## Acceptance",
  "",
].join("\n");

const spec = (fm, body = CONTRACTS, rel = "specs/s.md") => ({
  kind: "spec",
  rel,
  fm: { type: "spec", status: "active", ...fm },
  body,
});

test("citation token grammar: ASCII primes, one nested level, and the closing bracket ends it", () => {
  const found = (s) => [...s.matchAll(citationTokenRe())].map((m) => `${m[1]}#${m[2]}`);
  assert.deepEqual(found(`a ${tok("install", "4")} b ${tok("install", "4'")} c ${tok("install", "4/1''")}`), [
    "install#4",
    "install#4'",
    "install#4/1''",
  ]);
  assert.deepEqual(found(`${tok("SPEC-001", "0")}`), ["SPEC-001#0"]);
  // A Markdown link and a wikilink are not citations; a status tag is not either.
  assert.deepEqual(found(`${tok("x", "1")}(https://e.com) [${tok("x", "1")}] [PS#0.29.3]`), []);
  assert.equal(contractNumberAscii("4′"), "4'");
  assert.equal(contractNumberAscii("1″"), "1''");
});

test("parseSpecContracts: numbers by value, steps one level deep, comments and fences skipped, marker in the first paragraph", () => {
  const cs = parseSpecContracts(spec({ id: "s" }));
  assert.deepEqual(
    cs.map((c) => c.n),
    ["0", "1", "4", "6", "4'", "10"],
  );
  const byN = Object.fromEntries(cs.map((c) => [c.n, c]));
  assert.deepEqual([...byN["4"].steps], ["1'", "1''"]);
  assert.equal(byN["0"].marker, "live", "a full-width colon and a wrapped heading still find the marker");
  assert.equal(byN["10"].marker, "manual");
  assert.equal(byN["1"].marker, null);
  assert.equal(byN["1"].scenarios.length, 3);
});

test("checkScenarioShape: a scenario without WHEN or THEN is an info; a complete one is silent", () => {
  const f = checkScenarioShape([spec({ id: "s" })]);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
  assert.match(f[0].message, /Contract 6's scenario has no THEN/);
});

test("checkSpecAliases: duplicate, another spec's id, and the reserved key are issues", () => {
  const a = spec({ id: "SPEC-001", alias: "inst" }, "", "specs/a.md");
  const b = spec({ id: "long-slug", alias: "inst" }, "", "specs/b.md");
  const c = spec({ id: "third", alias: "SPEC-001" }, "", "specs/c.md");
  const d = spec({ id: "fourth", alias: "example" }, "", "specs/d.md");
  const f = checkSpecAliases([a, b, c, d]);
  assert.equal(f.length, 3);
  assert.ok(f.every((x) => x.level === "issue" && x.check === "spec-alias"));
  assert.deepEqual(f.map((x) => x.file).sort(), ["specs/b.md", "specs/c.md", "specs/d.md"]);
});

// Coverage over a stub scan, so the rules are tested without git.
const scanOf = (tokens) => ({
  status: "ok",
  checkout: "proj",
  tokens: tokens.map(([key, n]) => ({ key, n, file: "t.test.mjs", line: 1 })),
});

test("checkContractCitations: one line for an uncited spec, the uncited list once something is cited", () => {
  const s = spec({ id: "s" });
  const none = checkContractCitations([s], scanOf([]));
  assert.equal(none.length, 1);
  assert.match(none[0].message, /^6 contracts, 0 cited \(checkout proj\)\.$/);

  // #4 covers 4 only — not 4′, and a cited step does not cover its parent.
  const some = checkContractCitations(
    [s],
    scanOf([
      ["s", "4"],
      ["s", "1"],
      ["s", "6/1'"],
    ]),
  );
  const cov = some.filter((x) => x.check === "contract-coverage");
  assert.equal(cov.length, 1);
  // 0 and 10 are marked (live, manual), so they are not counted.
  assert.match(cov[0].message, /^2 of 6 contracts uncited \(checkout proj\): 6, 4'\.$/);

  const report = checkContractCitations([spec({ id: "s", coverage: "report" })], scanOf([]));
  assert.match(report[0].message, /4 of 6 contracts uncited/);
});

test("checkContractCitations: unknown keys and numbers warn; #1 never matches #10; example and superseded", () => {
  const s = spec({ id: "s", alias: "short" });
  const old = spec({ id: "old", status: "superseded" }, CONTRACTS, "specs/old.md");
  const f = checkContractCitations(
    [s, old],
    scanOf([
      ["nope", "1"],
      ["short", "7"],
      ["s", "4/9"],
      ["example", "3"],
      ["old", "1"],
      ["short", "10"],
    ]),
  );
  const unknown = f.filter((x) => x.check === "citation-unknown");
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((x) => x.level === "warn"));
  assert.equal(f.filter((x) => x.check === "citation-superseded").length, 1);
  // short#10 resolved to contract 10, so 1 is still listed as uncited.
  const cov = f.find((x) => x.check === "contract-coverage" && x.file === "specs/s.md");
  assert.match(cov.message, /: 1, 4, 6, 4'\.$/);
});

test("checkContractCitations: no git, or a timeout, is one info and no guess", () => {
  for (const status of ["no-git", "unknown"]) {
    const f = checkContractCitations([spec({ id: "s" })], { status, tokens: [], checkout: "p" });
    assert.equal(f.length, 1);
    assert.equal(f[0].level, "info");
  }
  assert.deepEqual(checkContractCitations([spec({ id: "s" })], null), []);
});

const story = (status, closed, line) => ({
  kind: "story",
  rel: `epics/E/stories/${status}.md`,
  fm: { type: "story", status, closed_at: closed },
  body: ["## Acceptance Criteria", "", line, ""].join("\n"),
});

test("checkEvidenceCitations: a missing token warns for open and non-legacy done stories, behind the gates", () => {
  const line = `- [x] works — evidence: ${tok("s", "4")} and ${tok("s", "6")} and ${tok("example", "1")} and tests/a.test.mjs "title"`;
  const stories = [
    story("in-progress", null, line),
    story("done", "2026-12-01T00:00:00Z", line),
    story("done", "2026-01-01T00:00:00Z", line),
  ];
  const scan = scanOf([["s", "4"]]);
  const cfg = { lifecycle_gates: "on", spec_policy_since: "2026-06-01T00:00:00Z" };
  const f = checkEvidenceCitations(stories, cfg, scan);
  // s#6 is missing in the open story and in the done one after `since`; the
  // done story before `since` is legacy, example is skipped, free text is not checked.
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.check === "evidence-citation" && x.level === "warn" && /#6\]/.test(x.message)));
  assert.deepEqual(checkEvidenceCitations(stories, { lifecycle_gates: "off" }, scan), []);
  assert.deepEqual(checkEvidenceCitations(stories, cfg, { status: "no-git", tokens: [] }), []);
});

test("scan: git grep finds untracked tests, skips the vault and node_modules, and no active spec means no scan", () => {
  const proj = mkdtempSync(join(tmpdir(), "ps-cite-"));
  git(proj, "init", "-q");
  mkdirSync(join(proj, "tests"), { recursive: true });
  mkdirSync(join(proj, "node_modules", "x"), { recursive: true });
  mkdirSync(join(proj, "vault", "specs"), { recursive: true });
  writeFileSync(join(proj, "tests", "a.test.mjs"), `// ${tok("s", "4")}\ntest("x", () => {});\n`); // untracked
  writeFileSync(join(proj, "node_modules", "x", "i.js"), `// ${tok("s", "6")}\n`);
  writeFileSync(join(proj, "vault", "specs", "note.md"), `${tok("s", "1")}\n`);
  writeFileSync(join(proj, "README.md"), `see ${tok("s", "0")}(https://e.com)\n`);
  const cfg = { vault_path: join(proj, "vault") };
  const scan = scanCitations(cfg, [spec({ id: "s" })], proj);
  assert.equal(scan.status, "ok");
  assert.deepEqual(
    scan.tokens.map((t) => `${t.file}:${t.key}#${t.n}`),
    ["tests/a.test.mjs:s#4"],
  );
  assert.equal(
    scanCitations(cfg, [spec({ id: "s", status: "draft" })], proj),
    null,
    "no active spec with contracts: git never runs",
  );
});

test("scan: a directory that is not a repository reports no-git", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-nogit-"));
  assert.equal(grepProjectLines(dir, "x").status, "no-git");
});

test("scan: a token with typographic primes is flagged for ASCII, not dropped", () => {
  const scan = {
    status: "ok",
    checkout: "p",
    tokens: [{ key: "s", n: "4′", file: "t.mjs", line: 3, typographic: true }],
  };
  const f = checkContractCitations([spec({ id: "s" })], scan).filter((x) => x.check === "citation-unknown");
  assert.equal(f.length, 1);
  assert.ok(f[0].message.includes(tok("s", "4'")), f[0].message);
});

// The wiring: runVaultChecks runs the new checks through its guarded list,
// where a broken registration would otherwise fail silently.
test("runVaultChecks: aliases, coverage with citing files, and unknown tokens reach the vault report", () => {
  const { proj, vault } = makeVaultProject();
  const body = (id, extra = "") =>
    `---\ntype: spec\nid: "${id}"\ntitle: "T"\nstatus: active\n${extra}---\n\n# T\n\n${CONTRACTS}`;
  writeFileSync(join(vault, "specs", "a.md"), body("spec-a", "alias: dup\n"));
  writeFileSync(join(vault, "specs", "b.md"), body("spec-b", "alias: dup\n"));
  const grep = () => ({
    status: "ok",
    lines: [
      { file: "tests/a.test.mjs", line: 1, text: `// ${tok("dup", "4")}` },
      { file: "tests/a.test.mjs", line: 9, text: `// ${tok("ghost", "1")}` },
    ],
  });
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  const f = runVaultChecks(cfg, { proj, grep });
  const by = (c) => f.filter((x) => x.check === c);
  assert.equal(by("spec-alias").length, 1, "the second spec's duplicate alias is an issue");
  assert.equal(by("citation-unknown").length, 1);
  const covA = by("contract-coverage").find((x) => x.file.endsWith("a.md"));
  assert.match(covA.message, /^3 of 6 contracts uncited/);
  assert.deepEqual(covA.cites, ["tests/a.test.mjs"]);
  assert.equal(by("registry").length, 0, "no check threw");
});

test("checkEvidenceCitations: a token on a wrapped line of the item is read, and gates_since reaches a done story", () => {
  const body = [
    "## Acceptance Criteria",
    "",
    "- [x] works, and the evidence",
    `      wraps — evidence: ${tok("s", "6")}`,
    "",
  ].join("\n");
  const done = {
    kind: "story",
    rel: "epics/E/stories/d.md",
    fm: { type: "story", status: "done", closed_at: "2026-12-01T00:00:00Z" },
    body,
  };
  const f = checkEvidenceCitations(
    [done],
    { lifecycle_gates: "on", gates_since: "2026-06-01T00:00:00Z" },
    scanOf([["s", "4"]]),
  );
  assert.equal(f.length, 1);
  assert.match(f[0].message, /#6\]/);
});

// projectstore — the bin's `--json` output against the branch point's captures
// (PS-HARNESS: "The CLI's output is designed: grouped plans, a question rail,
// one glyph set, doctor grouped by cause"; the covering spec, *Terminal
// presentation of the projectstore CLI: layout, glyphs, colour roles,
// questions and live lines*, Testing → JSON and the acceptance item
// "Normalised `--json` output of the install family, `doctor` and `status`
// equals the normalised 0.29.2 captures", as amended 2026-10-10: the captures
// are the branch point's).
//
// The story re-lays out every text screen and must change no envelope and no
// exit code. tests/fixtures/json-captures.mjs runs each scenario through the
// bin, hermetically, and normalises it; this compares the result with the
// committed tests/fixtures/json-captures.json, scenario by scenario for a
// readable failure, then byte for byte.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/json-captures.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAPTURES, captureAll, serialise, normaliser } from "./fixtures/json-captures.mjs";

test("json captures: the normaliser replaces the paths and their realpaths, the version whole and ISO timestamps, and nothing else", () => {
  // A path reached through a symlink: its realpath is replaced too, before
  // the path it may end with.
  const target = mkdtempSync(join(tmpdir(), "ps-capture-target-"));
  const link = join(mkdtempSync(join(tmpdir(), "ps-capture-link-")), "proj");
  symlinkSync(target, link);
  const home = mkdtempSync(join(tmpdir(), "ps-capture-home-"));
  const n = normaliser({ paths: { "<project>": [link], "<home>": [home] }, version: "1.2.3" });
  const input = {
    [`${link}/key`]: [`${link}/CLAUDE.md`, `${realpathSync(target)}/AGENTS.md`, `${home}/.claude`],
    versions: "v1.2.3, projectstore@1.2.3; 11.2.3, 1.2.30 and 1.2.3.4 stay; this package (1.2.3).",
    times: ["2026-10-10T17:56:11.452Z", "2026-10-10T17:56:11+03:00", "2026-10-10T17:56Z"],
    kept: ["2026-02-02", "/tmp/nowhere", 3, true, null],
  };
  assert.deepEqual(n(input), {
    "<project>/key": ["<project>/CLAUDE.md", "<project>/AGENTS.md", "<home>/.claude"],
    versions: "v<version>, projectstore@<version>; 11.2.3, 1.2.30 and 1.2.3.4 stay; this package (<version>).",
    times: ["<time>", "<time>", "<time>"],
    kept: ["2026-02-02", "/tmp/nowhere", 3, true, null],
  });
});

test("json captures: the install family, doctor and status answer --json as the branch point did — normalised envelopes and exit codes", () => {
  const text = readFileSync(CAPTURES, "utf8");
  const want = JSON.parse(text);
  const got = captureAll();
  assert.deepEqual(Object.keys(got), Object.keys(want), "the same scenarios, in the same order");
  for (const name of Object.keys(want)) assert.deepEqual(got[name], want[name], name);
  assert.equal(serialise(got), text, "byte-equal to the committed captures");
});

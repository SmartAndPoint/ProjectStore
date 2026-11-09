// projectstore — the optional Independent test line (the PS-SPEC story "A
// story can say how it is checked on its own, in one optional Independent
// test line"; borrow 4 of the SDD research note).
//
// The silence and the gates cover [SPEC-001#13]; the prompt texts cover [SPEC-001#10].

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER =
  "**Independent test:** <!-- Optional. One sentence on how this story is checked on its own: a command to run and what to see. Delete the line if there is none. -->";
const FILLED = "**Independent test:** run `npm test` and see the fixture vault's index finding.";

const story = (id, line, status = "planned") =>
  `---\ntype: story\nid: "${id}"\nepic: "PS-X"\ntitle: "${id}"\nstatus: ${status}\nspecs: []\nstarted_at: null\nclosed_at: null\nplan_updated_at: null\n---\n\n# ${id}\n\n## Description\n\nA story.\n${line === null ? "" : `\n${line}\n`}\n## Acceptance Criteria\n\n- [ ] one\n`;

test("an absent, a placeholder and a filled Independent test line get the same findings, under required with the gates on", async () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(
    join(vault, ".projectstore.json"),
    JSON.stringify({ spec_policy: "required", lifecycle_gates: "on", spec_policy_since: "2026-01-01T00:00:00.000Z" }),
  );
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  const path = join(vault, "epics", "PS-X", "stories", "story-s.md");
  // In progress and done: the states whose stories spec-coverage and acceptance read.
  for (const status of ["in-progress", "done"]) {
    const findingsWith = async (line) => {
      writeFileSync(path, story("story-s", line, status));
      return (await runVaultChecks(cfg, { proj })).map((f) => `${f.level} ${f.check} ${f.file || ""}`).sort();
    };
    const absent = await findingsWith(null);
    assert.ok(
      absent.some((f) => f.includes("story-s.md")),
      `${status}: the fixture reaches the story checks (${absent})`,
    );
    assert.deepEqual(await findingsWith(PLACEHOLDER), absent, status);
    assert.deepEqual(await findingsWith(FILLED), absent, status);
  }
});

test("a filled Independent test line passes the plan and close gates byte-identical", () => {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-g.md");
  writeFileSync(path, story("story-g", FILLED));
  for (const verb of ["plan", "close"]) {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), verb, path], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      cwd: REPO,
    });
    assert.equal(r.status, 0, r.stderr);
    const content = JSON.parse(r.stdout).content;
    assert.equal(content.split("\n").filter((l) => l === FILLED).length, 1, verb);
    writeFileSync(path, content);
  }
});

test("commands/story.md: step 3b fills the line or leaves it, step 7 keeps it, the close reports it", () => {
  const t = readFileSync(join(REPO, "commands", "story.md"), "utf8");
  const b3 = t.indexOf("3b. **The Independent test line**");
  assert.ok(b3 > 0 && b3 < t.indexOf("4. **Preview**"), "3b comes before the preview");
  assert.match(t.slice(b3, t.indexOf("4. **Preview**")), /invent nothing/);
  assert.match(t, /step-3b edits \(`specs:`, `variant: test`, the Independent test\s+line\)/);
  assert.match(t, /in the Final Summary's\s+tests executed, say whether the Independent test ran and how/);
});

test("agents/reviewer.md: a filled line gets an evidence line, or not run with a reason; a should-fix at most", () => {
  const t = readFileSync(join(REPO, "agents", "reviewer.md"), "utf8");
  const i = t.indexOf("**An Independent test line.**");
  assert.ok(i > 0);
  const para = t.slice(i, t.indexOf("\n\n", i));
  assert.match(para, /— evidence:/);
  assert.match(para, /not run — <why>/);
  assert.match(para, /🟡 should-fix, never a 🔴/);
  assert.match(para, /a hint,\s+not a gate/);
});

// projectstore — the plan gate's one round of open questions (the PS-SPEC
// story "The plan gate asks at most five open questions and records the
// answers before the plan is written"; borrow 5 of the SDD research note).
//
// The subsection through the gate and doctor covers [SPEC-001#7]; the planner's item covers [SPEC-001#10].

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flat = (s) => s.replace(/\s+/g, " ");
const CLARIFICATIONS = [
  "### Clarifications",
  "",
  "2026-11-09:",
  "- Where does it go? Last in the plan.",
  "- Docs now? No (assumed).",
].join("\n");

const story = (status, clar) =>
  `---\ntype: story\nid: "story-c"\nepic: "PS-X"\ntitle: "C"\nstatus: ${status}\nspecs: []\nstarted_at: "2026-11-09T10:00:00.000Z"\nclosed_at: ${status === "done" ? '"2026-11-09T12:00:00.000Z"' : "null"}\nplan_updated_at: "2026-11-09T10:00:00.000Z"\n---\n\n# C\n\n## Description\n\nA story.\n\n## Implementation Plan\n\n1. Do it.\n${clar ? `\n${CLARIFICATIONS}\n` : ""}\n## Acceptance Criteria\n\n- [ ] one\n`;

test("a plan ending with ### Clarifications passes the plan gate byte-identical", () => {
  const { proj, vault } = makeVaultProject();
  const path = join(vault, "epics", "PS-X", "stories", "story-c.md");
  writeFileSync(path, story("in-progress", true));
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "story-section.mjs"), "plan", path], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    cwd: REPO,
  });
  assert.equal(r.status, 0, r.stderr);
  const content = JSON.parse(r.stdout).content;
  assert.ok(content.includes(CLARIFICATIONS), "the subsection is kept whole");
  assert.equal(content.split("\n").filter((l) => l === "## Implementation Plan").length, 1, "no second plan");
});

test("doctor's findings are the same with and without ### Clarifications, in progress and done, under required with the gates on", async () => {
  const { proj, vault } = makeVaultProject();
  writeFileSync(
    join(vault, ".projectstore.json"),
    JSON.stringify({ spec_policy: "required", lifecycle_gates: "on", spec_policy_since: "2026-01-01T00:00:00.000Z" }),
  );
  const cfg = JSON.parse(readFileSync(join(proj, ".projectstore", "projectstore.json"), "utf8"));
  const path = join(vault, "epics", "PS-X", "stories", "story-c.md");
  for (const status of ["in-progress", "done"]) {
    const findings = async (clar) => {
      writeFileSync(path, story(status, clar));
      return (await runVaultChecks(cfg, { proj }))
        .map((f) => `${f.level} ${f.check} ${f.file || ""} ${f.message}`)
        .sort();
    };
    const without = await findings(false);
    assert.ok(
      without.some((f) => f.includes("story-c.md")),
      `${status}: the fixture reaches the story checks (${without})`,
    );
    // A done story closed after the policy date reaches the lifecycle checks, which read the plan.
    if (status === "done")
      assert.ok(
        without.some((f) => f.includes(" final-summary ")),
        `done: the gates ran (${without})`,
      );
    assert.deepEqual(await findings(true), without, status);
  }
});

test("commands/story.md: step 2a asks one round of at most five before the plan, and records it", () => {
  const t = readFileSync(join(REPO, "commands", "story.md"), "utf8");
  const life = t.slice(t.indexOf("# Lifecycle gate flow"));
  const a = life.indexOf("2a. **(plan only) Open questions, one round.**");
  const s2 = life.indexOf("2. **Run the compute script**");
  const s3 = life.indexOf("3. **Fill the section content**");
  assert.ok(s2 > 0 && s2 < a && a < s3 && s3 < life.indexOf("4. **Preview**"), "2a sits between steps 2 and 3");
  const step = flat(life.slice(a, s3));
  for (const needle of [
    "do not start the planner here",
    "None is the normal case",
    "Keep at most five",
    "say how many were dropped",
    "suggest splitting the story",
    "one round",
    "one call of AskUserQuestion for up to four questions",
    "every question of a dismissed call",
    "two to four options",
    "says which one, and the spec is amended",
    "when the planner says it left questions out",
    "appends its own dated line",
    "one plain-text message",
    "Ask once per gate run",
    "(assumed)",
    "`### Clarifications`, last in the plan",
    "today's date",
  ])
    assert.ok(step.includes(needle), needle);
  assert.match(flat(life.slice(s3)), /End the plan with the step 2a round/);
});

test("agents/planner.md: an Open questions item, at most five with options and a recommendation; the planner asks nothing", () => {
  const t = readFileSync(join(REPO, "agents", "planner.md"), "utf8");
  const i = t.indexOf("9. **Open questions**");
  assert.ok(i > t.indexOf("8. **Proposed `code_refs`**") && i < t.indexOf("Rules:"), "item 9 after item 8");
  const item = flat(t.slice(i, t.indexOf("Rules:")));
  for (const needle of [
    "at most five",
    "Options:",
    "Recommend (b)",
    '"None" is the normal case',
    "suggest how to split it",
    "You ask the user nothing",
  ])
    assert.ok(item.includes(needle), needle);
  const fm = t.slice(0, t.indexOf("\n---", 4));
  assert.ok(!/AskUserQuestion/.test(fm), "the planner has no question tool");
});

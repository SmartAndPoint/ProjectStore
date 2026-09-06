// projectstore — test fixtures: a bound project with a vault.
//
// makeVaultProject and seedGraphFixture moved here from tests/scripts.test.mjs
// unchanged (three golden tests deepEqual seedGraphFixture's exact edge lists
// — do not extend it; compose on top of it instead, as seedCliVault does).

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { layoutPaths } from "../../scripts/lib.mjs";
import { tmpdir } from "node:os";

export function makeVaultProject() {
  const proj = mkdtempSync(join(tmpdir(), "ps-draft-"));
  const vault = join(proj, "vault");
  for (const d of ["adr", "specs", join("epics", "PS-X", "stories")]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  mkdirSync(join(proj, ".claude"), { recursive: true }); // the harness's own directory: detection
  mkdirSync(join(proj, ".projectstore"), { recursive: true });
  writeFileSync(join(proj, ".projectstore", "projectstore.json"), JSON.stringify({
    vault_path: vault, layout: "engineering", language: "en", default_author: "Test",
  }));
  return { proj, vault };
}

export function seedGraphFixture() {
  const { proj, vault } = makeVaultProject();
  const put = (rel, content) => {
    mkdirSync(join(vault, dirname(rel)), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  const fm = (extra, body = "") => `---\n${extra}\n---\n\n# T\n${body}`;
  put(join("adr", "old-way.md"),
    fm('type: adr\nid: "old-way"\ntitle: "Old way"\nstatus: superseded\ndate: 2026-01-01\nsuperseded_by: "new-way"'));
  put(join("adr", "new-way.md"),
    fm('type: adr\nid: "new-way"\ntitle: "New way"\nstatus: accepted\ndate: 2026-01-02\nsupersedes: "old-way"',
      "\n[[kanban]] twice: [[kanban]]\n[[missing-target]]\n[[dup]]\n"));
  put(join("adr", "dup.md"), fm('type: adr\nid: "dup-adr"\ntitle: "Dup A"\nstatus: proposed\ndate: 2026-01-03'));
  put(join("specs", "dup.md"), fm('type: spec\nid: "dup-spec"\ntitle: "Dup S"\nstatus: draft\ndate: 2026-01-03'));
  put(join("specs", "covering.md"),
    fm('type: spec\nid: "covering"\ntitle: "Covering"\nstatus: active\ndate: 2026-01-01\nstories: ["PS-X/story-ship-it"]\nadr: ["new-way"]'));
  put(join("specs", "one-sided.md"),
    fm('type: spec\nid: "one-sided"\ntitle: "One sided"\nstatus: draft\ndate: 2026-01-04\nstories: ["PS-X/story-loose"]'));
  put(join("epics", "PS-X", "epic.md"),
    fm('type: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-01-01\ncode_refs: ["scripts/"]'));
  put(join("epics", "PS-X", "stories", "story-ship-it.md"),
    fm('type: story\nid: "story-ship-it"\ntitle: "Ship it"\nstatus: planned\ncreated: 2026-01-01\nspecs: ["covering"]',
      "\n[[new-way]]\n"));
  put(join("epics", "PS-X", "stories", "story-nested", "README.md"),
    fm('type: story\nid: "story-nested"\ntitle: "Nested"\nstatus: planned\ncreated: 2026-01-02'));
  put(join("epics", "PS-X", "story-loose.md"),
    fm('type: story\nid: "story-loose"\ntitle: "Loose | Pipe"\nstatus: planned\ncreated: 2026-01-02'));
  writeFileSync(join(vault, "kanban.md"), "stub board\n");
  return { proj, vault };
}

// The graph fixture plus what the read verbs need: a story in progress with
// code_refs and a searchable phrase, a research folder, and a second epic.
export function seedCliVault() {
  const { proj, vault } = seedGraphFixture();
  const put = (rel, content) => {
    mkdirSync(join(vault, dirname(rel)), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  put(join("epics", "PS-X", "stories", "story-in-flight.md"),
    `---\ntype: story\nid: "story-in-flight"\ntitle: "In flight"\nstatus: in-progress\ncreated: 2026-02-01\nstarted_at: 2026-02-02\ncode_refs: ["scripts/cli.mjs", "tests/cli.test.mjs"]\n---\n\n# In flight\n\n## Description\n\nThe zebra crossing phrase lives here.\n\n## Acceptance Criteria\n\n- [ ] one\n`);
  put(join("epics", "PS-Y", "epic.md"),
    `---\ntype: epic\nid: "PS-Y"\ntitle: "Y"\nstatus: planned\ncreated: 2026-02-01\ncode_refs: ["bin/"]\n---\n\n# Y\n`);
  put(join("research", "zebra-note.md"),
    `---\ntype: research\nslug: "zebra-note"\ntitle: "Zebra note"\nstatus: draft\ndate: 2026-02-03\n---\n\n# Zebra note\n\nA zebra crossing, again, and a Zebra Crossing in caps.\nSecond zebra line.\nThird zebra line.\nFourth zebra line, past the per-file cap.\n`);
  put(join("epics", "PS-Y", "stories", "story-parked.md"),
    `---\ntype: story\nid: "story-parked"\ntitle: "Parked"\nstatus: parked\ncreated: 2026-02-01\n---\n\n# Parked\n`);
  put(join("adr", "README.md"), "# ADRs\n\nDecisions that stick.\n\n## Index\n");
  return { proj, vault };
}

// Write a project's binding in the harness-neutral layout (the layout ADR,
// 2026-09-06), creating .projectstore/ on the way — what every test that used
// to write .claude/projectstore.json calls now.
export function writeBinding(proj, cfg) {
  const p = layoutPaths(proj).binding;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2) + "\n");
  return p;
}

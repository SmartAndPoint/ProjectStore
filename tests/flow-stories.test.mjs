// projectstore — tests/flow-stories.test.mjs: the one story reader of the flow
// counts (PS-FLOW, "Doctor checks the flow against the vault's policy…"; the
// spec "Flow counts…", alias `flow-counts`, contract 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFlowStories } from "../scripts/flow-stories.mjs";
import { findStories } from "../scripts/kanban.mjs";

const put = (root, rel, status = "planned") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `---\ntype: story\ntitle: "${rel}"\nstatus: ${status}\n---\n\n# ${rel}\n`);
};

// [flow-counts#2]
test("which stories count: a flat file, a folder with a README and a standalone story are read; epics/_templates/ is not (edge)", () => {
  const vault = mkdtempSync(join(tmpdir(), "ps-flow-stories-"));
  put(vault, "epics/PS-A/stories/story-flat.md");
  put(vault, "epics/PS-A/stories/story-folder/README.md");
  put(vault, "epics/PS-B/story-standalone.md");
  put(vault, "epics/_templates/stories/story-blank.md");
  put(vault, "epics/.hidden/stories/story-dot.md");
  const { stories, unread } = readFlowStories(vault, "epics");
  assert.equal(unread, 0);
  assert.deepEqual(
    stories.map((s) => s.rel),
    ["epics/PS-A/stories/story-flat.md", "epics/PS-A/stories/story-folder/README.md", "epics/PS-B/story-standalone.md"],
  );
  assert.deepEqual(
    stories.map((s) => s.slug),
    ["story-flat", "story-folder", "story-standalone"],
  );
  // As the board reads them.
  assert.deepEqual(
    findStories(vault, "epics")
      .stories.map((s) => s.relPath)
      .sort(),
    stories.map((s) => s.rel).sort(),
  );
});

// [flow-counts#2]
test("which stories count: a file that cannot be read is left out and counted, and the reader does not throw (failure)", () => {
  const vault = mkdtempSync(join(tmpdir(), "ps-flow-stories-"));
  put(vault, "epics/PS-A/stories/story-a.md");
  put(vault, "epics/PS-A/stories/story-b.md");
  const read = (p) => {
    if (p.endsWith("story-b.md")) throw new Error("EACCES");
    return `---\nstatus: planned\n---\n`;
  };
  const { stories, unread } = readFlowStories(vault, "epics", { read });
  assert.deepEqual(
    stories.map((s) => s.slug),
    ["story-a"],
  );
  assert.equal(unread, 1);
  assert.deepEqual(readFlowStories(join(vault, "nowhere"), "epics"), { stories: [], unread: 0 });
});

// [flow-counts#2]
test(
  "which stories count: an epic folder, or the epics folder, that cannot be read is counted in unread (failure)",
  { skip: process.getuid?.() === 0 },
  () => {
    const vault = mkdtempSync(join(tmpdir(), "ps-flow-stories-"));
    put(vault, "epics/PS-A/stories/story-a.md");
    put(vault, "epics/PS-B/stories/story-b.md");
    const locked = join(vault, "epics", "PS-B");
    chmodSync(locked, 0o000);
    try {
      const { stories, unread } = readFlowStories(vault, "epics");
      assert.deepEqual(
        stories.map((s) => s.slug),
        ["story-a"],
      );
      assert.equal(unread, 1);
    } finally {
      chmodSync(locked, 0o755);
    }
    const epics = join(vault, "epics");
    chmodSync(epics, 0o000);
    try {
      assert.deepEqual(readFlowStories(vault, "epics"), { stories: [], unread: 1 });
    } finally {
      chmodSync(epics, 0o755);
    }
  },
);

// [epic-rule#5]
test("one epic's stories: `only` reads that epic folder alone, all three shapes, and counts its unreadable file against it (failure)", () => {
  const vault = mkdtempSync(join(tmpdir(), "ps-flow-stories-"));
  put(vault, "epics/PS-A/stories/story-flat.md");
  put(vault, "epics/PS-A/stories/story-folder/README.md");
  put(vault, "epics/PS-A/story-standalone.md");
  put(vault, "epics/PS-B/stories/story-b.md");
  const a = readFlowStories(vault, "epics", { only: "PS-A" });
  assert.deepEqual(
    a.stories.map((s) => [s.epic, s.slug]),
    [
      ["PS-A", "story-flat"],
      ["PS-A", "story-folder"],
      ["PS-A", "story-standalone"],
    ],
  );
  assert.equal(a.unread, 0);
  const read = (p) => {
    if (p.endsWith("story-b.md")) throw new Error("EACCES");
    return `---\nstatus: done\n---\n`;
  };
  assert.deepEqual(readFlowStories(vault, "epics", { only: "PS-A", read }).unread, 0, "PS-B's file is not read");
  const b = readFlowStories(vault, "epics", { only: "PS-B", read });
  assert.deepEqual([b.stories, b.unread], [[], 1]);
  assert.deepEqual(readFlowStories(vault, "epics", { only: "PS-NONE" }), { stories: [], unread: 0 });
});

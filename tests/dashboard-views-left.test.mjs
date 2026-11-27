// projectstore — tests/dashboard-views-left.test.mjs: a write whose only
// failure is the derived views is committed (PS-DASHBOARD, "A write whose
// only failure is the derived views is committed, and the page shows the
// core's reason"). Contract 7 of "The dashboard's write path…", as amended
// 2026-11-27, with the real core in a test world: a folder named `kanban.md`
// in the vault keeps the core from rebuilding the board in the page's clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { viewsLeftOnly } from "../dashboard/lib/write.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitForEdit, bodyHash } from "../scripts/edit-cut.mjs";

hermeticGit();

async function withWorld(opts, fn) {
  const w = await makeWorld(opts);
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
  }
}
async function writable(w, opts) {
  const writer = await w.open(opts);
  const r = await writer.refresh();
  assert.equal(r.body.write.can, true, r.body.write.reason);
  return writer;
}
const committedFiles = (w, clone, rev = "HEAD") =>
  w.git(clone, "diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort();
const subjectAt = (w, clone, rev = "HEAD") => w.git(clone, "log", "-1", "--format=%s", rev);
const count = (w, clone) => Number(w.git(clone, "rev-list", "--count", "HEAD"));
// The board's file becomes a folder on origin, so the core cannot write it in the clone.
function blockBoard(w) {
  const board = join(w.vault, "kanban.md");
  rmSync(board, { force: true });
  mkdirSync(board);
  writeFileSync(join(board, "keep"), "a folder where the board's file would be\n");
  w.git(w.repo, "add", "-A");
  w.git(w.repo, ...w.as, "commit", "-q", "-m", "a folder named kanban.md");
  w.git(w.repo, "push", "-q", "origin", "main");
}
const BLOCKED = {};

// [dashboard-writes#7]
test("views left: the reason comes from the brackets or from left[].error, and any other message is a failed verb", () => {
  const ran = (error, result = {}) => ({ status: 200, ok: false, result, error });
  assert.equal(viewsLeftOnly(ran("left: the derived views (kanban.md: EISDIR)")), "kanban.md: EISDIR");
  assert.equal(
    viewsLeftOnly(ran("left: the derived views", { left: [{ what: "the derived views", error: "graph.md: EACCES" }] })),
    "graph.md: EACCES",
  );
  assert.equal(viewsLeftOnly(ran("left: the derived views")), "the core gave no reason");
  // move's own words when its epic row is left too (scripts/move.mjs), and create's (scripts/item-verbs.mjs).
  assert.equal(
    viewsLeftOnly(ran("left: its row in the epic's Stories table (EACCES) and the derived views (kanban.md: EISDIR)")),
    null,
    "an epic row left too is a failure",
  );
  assert.equal(viewsLeftOnly(ran("left: the Stories row, the derived views")), null);
  // handover names only the views even when a story's own write failed (scripts/handover.mjs).
  assert.equal(
    viewsLeftOnly(
      ran("left: the derived views (kanban.md: EISDIR)", { items: [{ story: "PS-X/story-a", error: "EACCES" }] }),
    ),
    null,
    "a story's write that failed is a failure",
  );
  assert.equal(
    viewsLeftOnly(ran("left: the derived views (x)", { items: [{ story: "PS-X/story-a", error: null }] })),
    "x",
  );
  assert.equal(viewsLeftOnly(ran("PS-X/story-a is done")), null);
  assert.equal(
    viewsLeftOnly({ status: 400, ok: false, result: {}, error: "left: the derived views" }),
    null,
    "a usage error is not this",
  );
  assert.equal(viewsLeftOnly({ status: 200, ok: true, result: {} }), null);
});

// [dashboard-writes#7]
test("views left: New epic, a move and an editor Save each commit their own files when the core cannot rebuild the board, and say why", async () => {
  await withWorld(BLOCKED, async (w) => {
    blockBoard(w);
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = count(w, clone);

    const made = await writer.action({ verb: "create-epic", fields: { epic: "PS-NEW", title: "Onboarding" } });
    assert.equal(made.status, 200);
    assert.equal(made.body.ok, true, made.body.error);
    assert.match(made.body.views_left, /kanban\.md/, "the core's reason names the board");
    assert.equal(made.body.error, undefined, "no error on a write that landed");
    assert.equal(count(w, clone), before + 1, "one commit");
    assert.equal(subjectAt(w, clone), "create epic PS-NEW: Onboarding");
    const files = committedFiles(w, clone);
    assert.ok(
      files.some((f) => f.endsWith("epics/PS-NEW/epic.md")),
      files.join(", "),
    );
    assert.ok(
      !files.some((f) => /(^|\/)(kanban|code-map|graph)\.md$|README\.md$/.test(f)),
      `no derived view: ${files.join(", ")}`,
    );

    const moved = await writer.action({
      verb: "move",
      fields: { story: "PS-X/story-a", to: "todo", reason: "next up" },
    });
    assert.equal(moved.body.ok, true, moved.body.error);
    assert.match(moved.body.views_left, /kanban\.md/);
    assert.equal(count(w, clone), before + 2);
    assert.ok(committedFiles(w, clone).some((f) => f.endsWith("epics/PS-X/stories/story-a.md")));

    // The editor's Save: the core's edit verb, which refreshes the views too.
    const rel = "epics/PS-X/stories/story-a.md";
    const raw = readFileSync(join(writer.readCtx().vault, rel), "utf8");
    const cut = splitForEdit(raw.slice(raw.indexOf("\n---\n", 4) + 5));
    const saved = await writer.action({
      verb: "edit-doc",
      fields: { path: rel, text: `${cut.body.trimEnd()}\n\nSaved from the page.\n`, base: bodyHash(cut.body) },
    });
    assert.equal(saved.body.ok, true, saved.body.error);
    assert.match(saved.body.views_left, /kanban\.md/);
    assert.equal(count(w, clone), before + 3);
    assert.deepEqual(
      committedFiles(w, clone).filter((f) => /(^|\/)(kanban|code-map|graph)\.md$|README\.md$/.test(f)),
      [],
    );
  });
});

// [dashboard-writes#7]
test("views left: a refusal of the core still commits nothing, whatever the views", async () => {
  await withWorld(BLOCKED, async (w) => {
    blockBoard(w);
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const before = count(w, clone);
    const r = await writer.action({ verb: "create-epic", fields: { epic: "PS-X", title: "Already there" } });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.views_left, undefined);
    assert.equal(count(w, clone), before, "no commit");
    assert.equal(w.git(clone, "status", "--porcelain"), "", "the clone is put back");

    // A move to the status the story has: nothing to commit, and the views' reason still said.
    const same = await writer.action({
      verb: "move",
      fields: { story: "PS-X/story-a", to: "planned", reason: "stays" },
    });
    assert.equal(same.body.ok, true, same.body.error);
    assert.match(same.body.views_left, /kanban\.md/);
    assert.equal(count(w, clone), before, "no commit");
    assert.equal(same.body.write.batch, null, "no batch starts");
    assert.equal(w.git(clone, "status", "--porcelain"), "", "the clone is put back");
  });
});

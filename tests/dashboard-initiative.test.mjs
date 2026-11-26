// projectstore — tests/dashboard-initiative.test.mjs: the page's initiative and
// epic rows (PS-DASHBOARD, "The page decides an initiative, edits its title,
// owner and priority, and sets an epic's initiative, through the core's
// initiative and epic verbs"). The scenarios are those of "The page's
// initiative and epic rows…" (alias `dashboard-initiative`), contracts 1 and
// 3 here, with the real core in a test world (tests/fixtures/dashboard-world.mjs);
// contract 2, the panel's buttons and the dialog, runs in the page harness of
// tests/dashboard-create.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hermeticGit, makeWorld } from "./fixtures/dashboard-world.mjs";
import { WRITE_VERBS, VERB_ARGV, checkRequest, positionalsOf, subjectOf } from "../dashboard/lib/write.mjs";

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
const entry = (verb) => WRITE_VERBS.find((v) => v.verb === verb);

// ─── Contract 1: four rows ─────────────────────────────────────────────

// [dashboard-initiative#1]
test("dashboard initiative: the four rows are labelled, run the core's initiative and epic verbs, and give their subjects", () => {
  assert.deepEqual(
    ["initiative-decide", "initiative-fields", "epic-initiative", "epic-unlink"].map((v) => entry(v)?.label),
    ["Decide", "Edit fields", "Set initiative", "No initiative"],
  );
  assert.deepEqual(
    entry("initiative-decide").fields.decision.values.map((v) => [v.value, v.label]),
    [
      ["accepted", "Accept"],
      ["rejected", "Reject"],
      ["deferred", "Defer"],
    ],
  );
  for (const k of ["title", "owner", "priority"]) assert.equal(entry("initiative-fields").fields[k].optional, true, k);
  const decide = {
    verb: "initiative-decide",
    fields: { initiative: "faster-onboarding", decision: "rejected", reason: "not now" },
  };
  assert.deepEqual(positionalsOf(decide), ["faster-onboarding", "rejected"]);
  assert.equal(subjectOf(decide), "decide faster-onboarding: rejected: not now");
  const fields = { verb: "initiative-fields", fields: { initiative: "faster-onboarding", priority: "p1" } };
  assert.deepEqual(positionalsOf(fields), ["faster-onboarding"]);
  assert.equal(subjectOf(fields), "edit fields of faster-onboarding");
  const link = { verb: "epic-initiative", fields: { epic: "PS-X", initiative: "faster-onboarding" } };
  assert.deepEqual(positionalsOf(link), ["PS-X"]);
  assert.equal(subjectOf(link), "set the initiative of PS-X to faster-onboarding");
  assert.deepEqual(VERB_ARGV["epic-unlink"].set, { initiative: "" });
  assert.equal(subjectOf({ verb: "epic-unlink", fields: { epic: "PS-X" } }), "clear the initiative of PS-X");
});

// [dashboard-initiative#1]
test("dashboard initiative: a decision outside the three and an initiative on epic-unlink are refused before any process (failure)", () => {
  const bad = checkRequest({
    verb: "initiative-decide",
    fields: { initiative: "x", decision: "approved", reason: "y" },
  });
  assert.ok(bad.error, JSON.stringify(bad));
  const extra = checkRequest({ verb: "epic-unlink", fields: { epic: "PS-X", initiative: "x" } });
  assert.ok(extra.error, JSON.stringify(extra));
  const none = checkRequest({ verb: "epic-unlink", fields: { epic: "PS-X" } });
  assert.ok(!none.error, JSON.stringify(none));
});

// ─── Contract 3: the preview, the action, one commit ───────────────────

// [dashboard-initiative#1] [dashboard-initiative#3]
test("dashboard initiative: Accept for an initiative no epic names is the core's refusal with no commit; Set initiative, then Accept, Edit fields and No initiative are one commit of one file each", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const made = await writer.action({ verb: "create-initiative", fields: { title: "Faster onboarding" } });
    assert.equal(made.body.ok, true, made.body.error);
    const before = count(w, clone);

    const early = await writer.action({
      verb: "initiative-decide",
      fields: { initiative: "faster-onboarding", decision: "accepted", reason: "go" },
    });
    assert.equal(early.status, 200);
    assert.equal(early.body.ok, false);
    assert.match(early.body.error, /epic/);
    assert.equal(count(w, clone), before, "no commit");

    const preview = await writer.preview({
      verb: "epic-initiative",
      fields: { epic: "PS-X", initiative: "faster-onboarding" },
    });
    assert.equal(preview.body.ok, true, preview.body.error);
    assert.equal(count(w, clone), before, "a preview commits nothing");

    const link = await writer.action({
      verb: "epic-initiative",
      fields: { epic: "PS-X", initiative: "faster-onboarding" },
    });
    assert.equal(link.body.ok, true, link.body.error);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-X/epic.md"]);
    assert.equal(subjectAt(w, clone), "set the initiative of PS-X to faster-onboarding");
    assert.match(w.git(clone, "show", "HEAD:epics/PS-X/epic.md"), /^initiative: "?faster-onboarding"?$/m);

    const accept = await writer.action({
      verb: "initiative-decide",
      fields: { initiative: "faster-onboarding", decision: "accepted", reason: "grouped work" },
    });
    assert.equal(accept.body.ok, true, accept.body.error);
    assert.deepEqual(committedFiles(w, clone), ["initiatives/faster-onboarding.md"]);
    assert.equal(subjectAt(w, clone), "decide faster-onboarding: accepted: grouped work");
    assert.match(w.git(clone, "show", "HEAD:initiatives/faster-onboarding.md"), /^status: "?accepted"?$/m);

    const fields = await writer.action({
      verb: "initiative-fields",
      fields: { initiative: "faster-onboarding", priority: "p1" },
    });
    assert.equal(fields.body.ok, true, fields.body.error);
    assert.deepEqual(committedFiles(w, clone), ["initiatives/faster-onboarding.md"]);
    assert.match(w.git(clone, "show", "HEAD:initiatives/faster-onboarding.md"), /^priority: "?p1"?$/m);

    const unlink = await writer.action({ verb: "epic-unlink", fields: { epic: "PS-X" } });
    assert.equal(unlink.body.ok, true, unlink.body.error);
    assert.deepEqual(committedFiles(w, clone), ["epics/PS-X/epic.md"]);
    assert.equal(subjectAt(w, clone), "clear the initiative of PS-X");
    assert.doesNotMatch(w.git(clone, "show", "HEAD:epics/PS-X/epic.md"), /^initiative:/m);
    const calls = w.record.filter((e) => e.cmd === process.execPath && e.argv[1] === "epic");
    assert.ok(
      calls.some((e) => e.argv.includes("--initiative=")),
      "epic-unlink runs epic with --initiative=",
    );
    assert.equal(count(w, clone), before + 4);
  });
});

// [dashboard-initiative#3]
test("dashboard initiative: a priority that is not p and digits is the core's usage error, 400, with no commit (failure)", async () => {
  await withWorld({}, async (w) => {
    const writer = await writable(w);
    const clone = writer.paths.clone;
    const made = await writer.action({ verb: "create-initiative", fields: { title: "Faster onboarding" } });
    assert.equal(made.body.ok, true, made.body.error);
    const before = count(w, clone);
    const r = await writer.action({
      verb: "initiative-fields",
      fields: { initiative: "faster-onboarding", priority: "high" },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(count(w, clone), before);
  });
});

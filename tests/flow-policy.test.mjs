// projectstore — tests/flow-policy.test.mjs: the vault's flow policy as data
// (PS-FLOW, "The vault declares its flow policy, and configure writes it").
// The grammar of the `flow` keys, their `--set` parse, the view's rows, the
// WIP limit rule, and the nested merge the vault-config writer uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlowSet,
  wipLimitOf,
  flowValue,
  flowRows,
  flowForm,
  blockedAt,
  isFlowSet,
  isEmailAddress,
  FLOW_FIXED,
} from "../scripts/flow-policy.mjs";
import { mergeConfig, nextVaultConfig } from "../scripts/lib.mjs";

const ok = (raw) => {
  const r = parseFlowSet(raw);
  assert.ok(r.change, `${raw}: ${r.usage}`);
  return r.change;
};
const usage = (raw, re) => {
  const r = parseFlowSet(raw);
  assert.ok(r.usage, `${raw} should be refused`);
  assert.match(r.usage, re, raw);
};

// [configure#2]
test("flow keys: every fixed key parses to its path and stored type, and - clears it", () => {
  assert.deepEqual(ok("flow.wip.full=3"), { key: "flow.wip.full", path: ["wip", "full"], value: 3 });
  assert.deepEqual(ok("flow.age_days.review=5").path, ["age_days", "review"]);
  assert.equal(ok("flow.window_weeks=4").value, 4);
  assert.deepEqual(ok("flow.capacity_weeks=2,3").value, [2, 3], "stored as an array");
  assert.deepEqual(ok("flow.capacity_weeks=2, 2.5").value, [2, 2.5]);
  assert.deepEqual(ok("flow.capacity_weeks=2,2").value, [2, 2], "equal bounds are a range");
  for (const k of FLOW_FIXED) assert.equal(ok(`${k.key}=-`).value, null, `${k.key} clears`);
});

// [configure#2]
test("flow keys: a person is named in brackets, with a space or a dot in the name", () => {
  assert.deepEqual(ok("flow.people[First Last].time=part"), {
    key: "flow.people[First Last].time",
    path: ["people", "First Last", "time"],
    value: "part",
  });
  assert.deepEqual(ok("flow.people[Dr. Who].wip=4").path, ["people", "Dr. Who", "wip"]);
  assert.deepEqual(ok("flow.people[First Last].git_names=a, b ,").value, ["a", "b"], "a comma list, as an array");
  assert.deepEqual(ok("flow.people[First Last].git_names=me@laptop").value, ["me@laptop"], "@ is allowed in git names");
  assert.equal(ok("flow.people[First Last].left=2026-12-31").value, "2026-12-31");
  assert.equal(ok("flow.people[First Last].left=-").value, null);
});

// [configure#11]
test("flow keys: values outside their key's set are usage, naming the set (failure)", () => {
  for (const v of ["0", "-1", "2.5", "1e2", "007", "123456789012345678901", "", "x"])
    usage(`flow.wip.full=${v}`, /flow\.wip\.full takes a positive whole number, or - to clear it, got /);
  usage("flow.age_days.review=0", /takes a whole number of days, 1 or more/);
  usage("flow.window_weeks=", /takes a whole number of weeks, 1 or more, or - to clear it, got nothing/);
  for (const v of ["half", "Full"]) usage(`flow.people[First Last].time=${v}`, /takes full or part/);
  for (const v of ["2026-02-30", "2026-1-5"]) usage(`flow.people[First Last].left=${v}`, /takes a date as YYYY-MM-DD/);
  for (const v of ["4,2", "2", "2,3,4", "0,3", "a,b"])
    usage(`flow.capacity_weeks=${v}`, /takes two positive numbers, low then high/);
  usage("flow.people[First Last].git_names= , ", /takes a comma list of git author names/);
});

// [configure#11]
test("flow keys: a person's name with @, ], =, a line break or nothing is refused, and so are a bare person key and unknown keys (failure)", () => {
  for (const name of ["a@b.c", "a=b", "x\ny", "x\ty", "x\u2028y", "", "__proto__"])
    usage(`flow.people[${name}].time=full`, /takes a name with no @, \] or =, and no line break/);
  usage("flow.people[a]b].time=full", /takes a name with no @, \] or =/);
  usage("flow.people[First Last]=full", /flow\.people\[First Last\] takes \.time, \.wip, \.git_names or \.left/);
  usage("flow.people[First Last].tim=full", /unknown setting flow\.people\[First Last\]\.tim/);
  usage("flow.wip.fulll=3", /unknown setting flow\.wip\.fulll/);
  usage(
    "flow.groomed_at=2026-11-10",
    /unknown setting flow\.groomed_at — a stamp that groom writes, never set by hand/,
  );
  const hinted = parseFlowSet("flow.wip.fulll=3", {
    nearest: (w, names) => names.find((n) => n.startsWith("flow.wip.f")),
  });
  assert.match(hinted.usage, /did you mean flow\.wip\.full\?/);
  assert.equal(isFlowSet("flow.wip.full=3"), true);
  assert.equal(isFlowSet("flowers=3"), false);
});

// [SPEC-001#4]
test("the WIP limit rule: own wip, else the time class, else none", () => {
  const cfg = {
    flow: {
      wip: { full: 3, part: 2 },
      people: { A: { time: "part", wip: 4 }, B: { time: "part" }, C: { time: "full" }, D: {} },
    },
  };
  assert.equal(wipLimitOf(cfg, "A"), 4, "own wip beats the class");
  assert.equal(wipLimitOf(cfg, "B"), 2);
  assert.equal(wipLimitOf(cfg, "C"), 3);
  assert.equal(wipLimitOf(cfg, "D"), null, "no time, no wip");
  assert.equal(wipLimitOf(cfg, "E"), null, "a person not listed has no limit");
});

// [SPEC-001#4]
test("the WIP limit rule: a missing class, no flow, odd names and hand-edited values give no limit (edge)", () => {
  assert.equal(wipLimitOf({ flow: { people: { C: { time: "full" } } } }, "C"), null);
  assert.equal(wipLimitOf({}, "C"), null);
  assert.equal(wipLimitOf(null, "C"), null);
  assert.equal(wipLimitOf({ flow: { people: {} } }, "constructor"), null);
  assert.equal(wipLimitOf({ flow: { people: { C: { time: "full" } }, wip: { full: 3 } } }, "c"), null, "exact match");
  for (const bad of [0, "3", 2.5, -1])
    assert.equal(wipLimitOf({ flow: { people: { X: { wip: bad } } } }, "X"), null, `wip ${JSON.stringify(bad)}`);
  assert.equal(wipLimitOf({ flow: { wip: { full: "3" }, people: { X: { time: "full" } } } }, "X"), null);
  assert.equal(flowValue({ flow: { age_days: { review: 5 } } }, "age_days.review"), 5);
  assert.equal(flowValue({ flow: { age_days: { review: "5" } } }, "age_days.review"), null);
  assert.deepEqual(flowValue({ flow: { capacity_weeks: [2, 3] } }, "capacity_weeks"), [2, 3]);
  assert.equal(flowValue({ flow: { capacity_weeks: [3, 2] } }, "capacity_weeks"), null);
});

// [configure#3]
test("the view's rows: set keys only, fixed keys in table order, people in file order", () => {
  const rows = flowRows({
    window_weeks: 4,
    people: { Z: { left: "2026-12-31", time: "full" }, "First Last": { wip: 2 } },
    wip: { full: 3 },
  });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["flow.wip.full", "flow.window_weeks", "flow.people[Z].time", "flow.people[Z].left", "flow.people[First Last].wip"],
  );
  assert.deepEqual(flowRows(undefined), []);
  assert.equal(flowForm("flow.wip.full"), "--set flow.wip.full=<n>");
  assert.equal(flowForm("flow.people[First Last].time"), "--set flow.people[First Last].time=<full|part>");
});

// [configure#7]
test("the merge: objects merge key by key, arrays replace, null deletes and prunes, before is untouched", () => {
  const before = {
    spec_policy: "optional",
    flow: { window_weeks: 4, capacity_weeks: [1, 2], people: { A: { time: "full" } } },
  };
  const frozen = structuredClone(before);
  const after = mergeConfig(before, { flow: { wip: { full: 3 }, capacity_weeks: [2, 3] } });
  assert.deepEqual(after, {
    spec_policy: "optional",
    flow: { window_weeks: 4, capacity_weeks: [2, 3], people: { A: { time: "full" } }, wip: { full: 3 } },
  });
  assert.deepEqual(before, frozen, "pure");
  const pruned = mergeConfig(before, {
    flow: { people: { A: { time: null } }, window_weeks: null, capacity_weeks: null },
  });
  assert.deepEqual(pruned, { spec_policy: "optional" }, "the emptied person, people and flow go");
  assert.deepEqual(
    mergeConfig({}, { flow: { people: { X: { wip: null } } } }),
    {},
    "clearing an absent key adds nothing",
  );
  assert.deepEqual(
    mergeConfig({ flow: { age_days: { review: 1, todo: 2 } } }, { flow: { age_days: { review: null } } }),
    { flow: { age_days: { todo: 2 } } },
    "a clear removes that key only, and keeps its siblings",
  );
  const proto = mergeConfig({}, JSON.parse('{"flow":{"people":{"__proto__":{"wip":2}}}}'));
  assert.ok(Object.hasOwn(proto.flow.people, "__proto__"), "an own __proto__ stays a key");
  const stamped = nextVaultConfig(
    { lifecycle_gates: "off" },
    { lifecycle_gates: "on", flow: { idle_days: 9 } },
    "2026-11-10T00:00:00.000Z",
  );
  assert.equal(stamped.gates_since, "2026-11-10T00:00:00.000Z", "the stamps still apply beside a flow change");
  assert.equal(stamped.flow.idle_days, 9);
});

// [configure#11]
test("a node on a flow path that is not an object is named (failure)", () => {
  assert.equal(blockedAt({ flow: "x" }, ["wip", "full"]), "flow");
  assert.equal(blockedAt({ flow: { people: [] } }, ["people", "A", "time"]), "flow.people");
  assert.equal(blockedAt({ flow: { people: { A: 3 } } }, ["people", "A", "time"]), "flow.people[A]");
  assert.equal(blockedAt({ flow: { wip: { full: 2 } } }, ["wip", "full"]), null, "a leaf is replaced");
  assert.equal(blockedAt({}, ["wip", "full"]), null);
});

// [configure#2]
test("git names: an @ with no dot after it is a name, not an address", () => {
  assert.deepEqual(ok("flow.people[First Last].git_names=me@laptop, First Last").value, ["me@laptop", "First Last"]);
  for (const n of ["me@laptop", "@octocat", "a@b", "user@", "first.last", "First Last"])
    assert.equal(isEmailAddress(n), false, n);
  for (const n of [
    "first.last@example.com",
    "A@B.C",
    "x+tag@sub.example.co.uk",
    "First Last <first.last@example.com>",
    "a@b@c.com",
    "<a@b.c>;",
  ])
    assert.equal(isEmailAddress(n), true, n);
});

// [configure#2] [configure#11]
test("git names: an entry that is, or holds, an email address is refused, and the message never repeats it (failure)", () => {
  for (const v of [
    "first.last@example.com",
    "First Last <first.last@example.com>",
    "me@laptop, first.last@example.com",
    "a@b.co, x\ty",
  ]) {
    const r = parseFlowSet(`flow.people[First Last].git_names=${v}`);
    assert.ok(r.usage, v);
    assert.match(
      r.usage,
      /^flow\.people\[First Last\]\.git_names takes git author names, and email addresses are not kept in the vault$/,
    );
    assert.doesNotMatch(r.usage, /@/, "the address is not repeated");
  }
});

// [SPEC-001#4]
test("limit rule: a flow.people key the configure spec refuses as a name gives no one a limit (edge)", () => {
  const at = ["a", "b"].join("@");
  for (const name of [`First ${at}`, "x]y", "a=b", "tab\there", "", "__proto__"]) {
    const people = JSON.parse(`{${JSON.stringify(name)}: {"wip": 3, "time": "full"}}`);
    const cfg = { flow: { wip: { full: 2 }, people } };
    assert.ok(Object.hasOwn(cfg.flow.people, name), `${JSON.stringify(name)} is an own key`);
    assert.equal(wipLimitOf(cfg, name), null, JSON.stringify(name));
  }
  assert.equal(
    wipLimitOf({ flow: { people: { "First Last": { wip: 3 } } } }, "First Last"),
    3,
    "a valid name keeps it",
  );
});

// [SPEC-001#4]
test("flow policy: a capacity_weeks bound below 0.01 counts as absent in every reader, though configure accepts it (edge)", () => {
  assert.ok(ok("flow.capacity_weeks=0.005,3"), "configure accepts it");
  assert.equal(flowValue({ flow: { capacity_weeks: [0.005, 3] } }, "capacity_weeks"), null);
  assert.deepEqual(flowValue({ flow: { capacity_weeks: [0.01, 3] } }, "capacity_weeks"), [0.01, 3]);
});

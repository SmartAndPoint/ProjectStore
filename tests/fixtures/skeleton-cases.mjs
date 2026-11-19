// projectstore — fixed fact sets for the SessionStart skeleton's renderer.
//
// tests/lib-modules.test.mjs renders each case and compares it with
// tests/fixtures/skeleton-golden.json, recorded before the renderer left
// lib.mjs (the PS-SPECTREE story "The marker parser and the skeleton leave
// lib.mjs"). Later stories that add a line to the skeleton test that every
// case here still renders as recorded.

const ADR = { path: "adr", kind: "adr", counts: { artifacts: 3 }, readme: "# ADRs\n\nDecisions with context.\n" };
const EPICS = {
  path: "epics",
  kind: "epic",
  counts: { epics: 2, stories: 7 },
  readme: "# Epics\n\nEpics and stories.\n",
};
const SPECS = { path: "specs", kind: "spec", counts: { artifacts: 4 }, readme: "# Specs\n\nNormative how.\n" };

const base = (rest = {}) => ({
  vaultPath: "/v",
  layoutName: "engineering",
  language: "en",
  specPolicy: "optional",
  lifecycleGates: "on",
  kanbanFile: "kanban.md",
  adrIndex: "adr/README.md",
  epicFile: "epics/<EPIC>/epic.md",
  folders: [ADR, EPICS],
  inFlight: { status: "ok", entries: [], total: 0 },
  ...rest,
});

const entry = (i) => ({ epic: `PS-E${i}`, title: `Story number ${i}` });

export const CASES = {
  "vault missing": { vaultMissing: true, vaultPath: "/nowhere/vault" },
  bare: { vaultPath: "/v", layoutName: "engineering", kanbanFile: "kanban.md" },
  "nothing in progress": base(),
  "three in progress": base({ inFlight: { status: "ok", entries: [1, 2, 3].map(entry), total: 3 } }),
  "seven in progress": base({ inFlight: { status: "ok", entries: [1, 2, 3, 4, 5, 6, 7].map(entry), total: 7 } }),
  "in-flight timeout": base({ inFlight: { status: "timeout" } }),
  "required policy, three folders, ru": base({
    specPolicy: "required",
    language: "ru",
    lifecycleGates: "off",
    folders: [ADR, SPECS, EPICS],
  }),
  "long cells": base({
    vaultPath: `/${"deep/".repeat(60)}vault`,
    language: "x".repeat(300),
    inFlight: { status: "ok", entries: [{ epic: "E".repeat(120), title: "T".repeat(200) }], total: 1 },
  }),
  "continuity paths": base({
    continuity: {
      status: "ok",
      paths: ["epics/PS-A/stories/story-a.md", "adr/b.md", "specs/c.md", "d.md", "e.md", "f.md", "g.md"],
      total: 9,
      artifact: "epics/PS-A/stories/story-a.md",
    },
  }),
  "continuity timeout": base({ continuity: { status: "timeout" } }),
};

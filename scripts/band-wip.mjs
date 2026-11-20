// projectstore — band-wip.mjs: the band's WIP count, written for it.
//
// The band above the prompt (hooks/band.tsx) ends its head row with the
// session's person's WIP against their limit, `WIP 2/3`. The band runs with no
// Node and reads only the focused epic, while the count needs every story of
// the vault. So the core counts here and writes one small file per project,
// <project>/.projectstore/state/wip.json, and the band reads it on each tick.
// The file's bytes and the band's reading rule are band-shared.mjs's
// (wipBody, wipShown); the count, the gate and the write are here.
//
// The count is Flow counts' (wipByPerson) and the limit SPEC-001's
// (wipLimitOf), composed as `next` composes them in personWip. That function
// lives in next.mjs, which no hook may reach, so a parity test holds the two
// equal (tests/band-wip.test.mjs).
//
// Writers: the SessionStart hook, from the story scan it already runs
// (wipFromScan); `move`, `follow` and `handover` once per --write run, and
// `session refresh` (refreshWip). `next` and doctor never write the file.
// A writer never throws and prints nothing.
//
// Spec: "The band's WIP state file: its count, its gate, its writers, and a
// write only when it changes" (alias `band-wip`), contracts 1 to 7, added
// 2026-11-20 by PS-FLOW/story-the-band-above-the-prompt-shows-the-session-
// assignees-wip-against-their-limit.

import { readFileSync, unlinkSync } from "node:fs";
import { hasBand, speakingHarness } from "./harness.mjs";
import { layoutPaths, ensureStateRoot, writeFileAtomic, loadLayout, folderByKind, readVaultConfig } from "./lib.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import { storyFacts, wipByPerson } from "./flow-counts.mjs";
import { wipLimitOf, flowDeclared } from "./flow-policy.mjs";
import { wipBody } from "./band-shared.mjs";

// The layout a binding with none names: binding.mjs's DEFAULT_LAYOUT, which
// this file may not import (a hook reaches it); a test holds the two equal.
export const DEFAULT_LAYOUT = "engineering";

// The session's person: the binding's `default_author`, trimmed ("" for none).
export const personOf = (cfg) => String(cfg?.default_author ?? "").trim();

// The view the file holds, from the stories' facts (storyFacts), the vault
// config and the person (contract 3). Pure.
export function wipView(facts, vaultCfg, name) {
  const mine = wipByPerson(facts).get(name) || { held: [], awaiting: [] };
  return {
    assignee: name,
    count: mine.held.length,
    awaiting_close: mine.awaiting.length,
    limit: wipLimitOf(vaultCfg, name),
  };
}

// The first three of contract 4's gate, judged before the vault config or
// any story is read: a harness with a band, the band not switched off, a
// person. False means nothing is touched, a stale file included.
export function wipWanted({ cfg, harness }) {
  return hasBand(harness) && cfg?.band?.enabled !== false && personOf(cfg) !== "";
}

// The whole gate (contract 4): "write", "remove" (the vault declares no flow
// policy, so a file left would show a stale count) or "skip".
export function wipGate({ cfg, vaultCfg, harness }) {
  if (!wipWanted({ cfg, harness })) return "skip";
  return flowDeclared(vaultCfg) ? "write" : "remove";
}

// The file, written only when its bytes change (contract 4): "unchanged"
// touches nothing; "written" went through a temp and a rename; "failed" is
// ignored, the next writer tries again.
export function writeWip(project, view) {
  const path = layoutPaths(project).wip;
  const body = wipBody(view);
  let before = null;
  try {
    before = readFileSync(path, "utf8");
  } catch {}
  if (before === body) return "unchanged";
  try {
    ensureStateRoot(project);
    writeFileAtomic(path, body);
    return "written";
  } catch {
    return "failed";
  }
}

export function removeWip(project) {
  try {
    unlinkSync(layoutPaths(project).wip);
    return "removed";
  } catch (e) {
    return e?.code === "ENOENT" ? "unchanged" : "failed";
  }
}

const write = (project, facts, vaultCfg, cfg) => writeWip(project, wipView(facts, vaultCfg, personOf(cfg)));

// The verbs' writer (contract 7): `move`, `follow` and `handover` just
// before their refreshViews, `session refresh` when it is not refused. The
// stories are read once, through readFlowStories (`read` is a test's seam),
// as `next` reads them; a read that is not whole writes nothing (contract 5).
// `project` is the run's own (ctx.project), never one from the environment.
export function refreshWip({ project, cfg, env = process.env, read = null, load = loadLayout }) {
  try {
    if (!project || !cfg?.vault_path || !wipWanted({ cfg, harness: speakingHarness(env) })) return "skip";
    const vaultCfg = readVaultConfig(cfg.vault_path);
    if (!flowDeclared(vaultCfg)) return removeWip(project);
    const epics = folderByKind(load(cfg.layout || DEFAULT_LAYOUT), "epic");
    if (!epics) return "skip";
    const r = readFlowStories(cfg.vault_path, epics.path, read ? { read } : {});
    if (r.unread > 0) return "incomplete";
    return write(project, r.stories.map(storyFacts), vaultCfg, cfg);
  } catch {
    return "failed";
  }
}

// The SessionStart writer (contract 6): from the scan gatherVaultFacts ran
// with `wip: true`, its `wip` part `{complete, stories, vaultConfig}`. A scan
// that did not finish, or could not read a story, writes nothing.
export function wipFromScan({ project, cfg, scan, env = process.env }) {
  try {
    if (!project || !scan) return "skip";
    const gate = wipGate({ cfg, vaultCfg: scan.vaultConfig, harness: speakingHarness(env) });
    if (gate === "skip") return "skip";
    if (gate === "remove") return removeWip(project);
    if (!scan.complete) return "incomplete";
    return write(project, scan.stories.map(storyFacts), scan.vaultConfig, cfg);
  } catch {
    return "failed";
  }
}

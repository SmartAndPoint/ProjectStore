#!/usr/bin/env node
// projectstore — install-harness.mjs
//
// The verbs that put projectstore's surfaces where a harness reads them —
// install, uninstall, upgrade — and the one thing that makes them safe: every
// write is planned first, shown, and applied only on explicit confirmation.
//
// Two grains of ownership (install spec, contract 0). An EXCLUSIVE file is
// wholly ours and carries the provenance line; provenance.mjs derives its
// state — current, stale with a reason, absent, foreign — and a foreign file
// is refused by these verbs, never repaired (contract 5). A SHARED file is
// the user's; we own one entry in it, recognised by the marker the manifest
// names, and nothing outside that entry is read, rewritten or removed
// (contract 6). A JSON file cannot carry the line, so it is always shared.
//
// The STATE of each surface comes from surfaces.mjs, which doctor reads too,
// so the verbs and the report can never disagree about a file. This file
// adds only policy — what a mode does with a state — and the writes.
//
// plan() writes nothing and reads no terminal: it is a pure description of
// what install/uninstall would do, per surface, so the preview, the states and
// the refusals are unit-tested without a subprocess. renderPreview() is a
// pure string. confirm() takes its streams as parameters. apply() is the only
// function that writes, and it writes only through lib.mjs writeFileAtomic.
//
// The gate (contract 9, distribution ADR decision 6): an interactive call
// prints the plan and asks; a non-interactive call that NAMES its harness
// counts as the confirmation; a bare install in a non-TTY refuses. There is
// no --yes flag. --surface narrows the plan (by prefix, so `statusline`
// covers the launcher too); it confirms nothing — except that naming the
// statusline surface is how a user opts into it without the config flag.
//
// Surface handlers are keyed by the manifest's surfaces.<kind>.format, never
// by a harness id: adding a harness is adding harnesses/<id>.json, and this
// file gains no branch. Claude Code's own plugin surfaces are host-managed
// (contract 14) — the plan reports the marketplace steps the manifest
// carries and writes none of them.
//
// Direction: installer → surfaces ← doctor; installer → provenance ← doctor.
// Doctor never imports this file.
//
// Normative: the spec "Installing, refreshing and disowning a harness
// surface", contracts 0, 5–10, 13–15. The plan/apply split, the refusal
// without a detected harness and the four-state model are Ivan Morozov's
// (MultiProjectStore); the host-managed report shape is Maxim
// Podreshetnikov's (PR #13, installElsewhere). Pure node, no external deps.

import { mkdirSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadHarness, harnessIds, sourceHarness, detectHarnesses, harnessRefusal } from "./harness.mjs";
import { FOREIGN_TEXT } from "./provenance.mjs";
import { analyseBlock, analyseJsonEntry, analyseStampedFile } from "./surfaces.mjs";
import { pluginRoot, writeFileAtomic, ensureRuntimeDir, removeAgentsBlock, replaceAgentsBlock, readConfigAt, isPluginCacheRoot } from "./lib.mjs";

export { GENERATOR } from "./surfaces.mjs";

function rel(projectDir, p) {
  const r = relative(projectDir, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

function inside(dir, parent) {
  const r = relative(parent, dir);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// ─── Surface handlers, keyed by format ─────────────────────────────────
//
// Each handler answers plan(ctx) → PlanItem[] for one surface row, in one
// mode, from the state surfaces.mjs derived. A PlanItem carries everything
// the preview and apply need; apply never re-derives a state.

const HANDLERS = {
  "markdown-block": planAgentsBlock,
  "json-entry": planJsonEntry,
  "mjs": planStampedFile,
};

function planAgentsBlock(ctx, key, s) {
  const { projectDir, mode, root } = ctx;
  const a = analyseBlock(projectDir, s, { root });
  const { withBlock, preferred, claude, importLine, PREFERRED, FALLBACK } = a;
  const items = [];
  if (a.refusal) return [{ surface: key, kind: "shared", path: a.files[0].path, entry: "projectstore:agents", state: "refused", action: "refuse", reason: a.refusal }];

  const hasImport = (text) => String(text ?? "").split("\n").some((l) => l.trim() === importLine);
  // A CLAUDE.md that is nothing but the import registration added is ours to
  // delete when the block goes (ADR-002 decision 4); anything else stays.
  const onlyImport = (text) => String(text ?? "").split("\n").every((l) => !l.trim() || l.trim() === importLine);
  const removal = (e, extra = {}) => ({ surface: key, kind: "shared", path: e.path, entry: `projectstore:agents v${e.block.v}`, state: "ours-current", action: "remove", reason: null,
    before: e.text, after: removeAgentsBlock(e.text), deleteIfEmpty: e.file === FALLBACK, ...extra });

  if (mode === "uninstall") {
    if (!withBlock.length) return [{ surface: key, kind: "shared", path: preferred.path, entry: "projectstore:agents", state: "ours-absent", action: "skip", reason: "no block to remove" }];
    for (const e of withBlock) items.push(removal(e));
    // The import line registration inserted, when it is all CLAUDE.md holds.
    if (withBlock.some((e) => e.file === PREFERRED) && claude && claude.present && claude.text !== null && hasImport(claude.text) && onlyImport(claude.text) && !withBlock.some((e) => e.file === FALLBACK)) {
      items.push({ surface: `${key}_import`, kind: "shared", path: claude.path, entry: importLine, state: "ours-current", action: "remove", reason: `${claude.file} holds only the import registration added`, before: claude.text, after: "", deleteIfEmpty: true });
    }
    return items;
  }

  const entry = `projectstore:agents v${a.version}`;
  const current = a.current;
  // Two files, one block each: resolve in favour of the preferred file —
  // register migrates, never duplicates (ADR-002 decision 3).
  for (const e of a.duplicates || []) items.push(removal(e, { state: "ours-stale", reason: `duplicate of the block in ${current.file}` }));

  if (!current) {
    const target = preferred;
    items.push({ surface: key, kind: "shared", path: target.path, entry, state: "ours-absent", action: target.present ? "add" : "create", reason: null,
      before: target.present ? target.text : null, after: replaceAgentsBlock(target.present ? target.text : "", a.desired) });
  } else if (current.file !== preferred.file && preferred.present) {
    // Present in the non-preferred file: migrate — remove there, add here.
    items.push(removal(current, { state: "ours-stale", reason: `migrating to ${preferred.file}` }));
    items.push({ surface: key, kind: "shared", path: preferred.path, entry, state: "ours-absent", action: "add", reason: `migrated from ${current.file}`,
      before: preferred.text, after: replaceAgentsBlock(preferred.text, a.desired) });
  } else if (current.block.v === a.version && current.block.block === a.desired) {
    items.push({ surface: key, kind: "shared", path: current.path, entry, state: "ours-current", action: "skip", reason: null });
  } else {
    items.push({ surface: key, kind: "shared", path: current.path, entry, state: "ours-stale", action: "replace-entry",
      reason: current.block.v !== a.version ? `v${current.block.v} → v${a.version}` : "content differs from the current source",
      before: current.text, after: replaceAgentsBlock(current.text, a.desired) });
  }

  // The @AGENTS.md import in CLAUDE.md (ADR-002 decision 3), only when the
  // block lives in AGENTS.md and CLAUDE.md exists without it. A removal
  // already rewriting CLAUDE.md in this plan takes the import onto its own
  // text, or the two items would race.
  const written = items.find((i) => ["add", "create", "replace-entry", "skip"].includes(i.action) && i.surface === key);
  const blockFile = written ? rel(projectDir, written.path) : null;
  if (blockFile === PREFERRED && a.files.length > 1 && claude) {
    const rewrite = items.find((i) => i.action === "remove" && i.path === claude.path);
    const text = rewrite ? rewrite.after : (claude.present ? claude.text : null);
    if (typeof text === "string" && !hasImport(text)) {
      const after = importLine + "\n" + (text.startsWith("\n") || !text.trim() ? "" : "\n") + text;
      if (rewrite) { rewrite.after = after; rewrite.deleteIfEmpty = false; rewrite.reason += `; ${importLine} import added`; }
      else items.push({ surface: `${key}_import`, kind: "shared", path: claude.path, entry: importLine, state: "ours-absent", action: "add", reason: `${PREFERRED} carries the block; ${claude.file} must import it`, before: text, after });
    }
  }
  return items;
}

function planJsonEntry(ctx, key, s) {
  const { projectDir, mode, root, home } = ctx;
  if (s.supported === false) {
    return [{ surface: key, kind: "shared", path: join(projectDir, s.file), entry: s.marker?.pointer || null, state: "unsupported", action: "skip", reason: s.why_unsupported || "not supported for this harness yet" }];
  }
  const path = join(projectDir, s.file);
  const entryKey = (s.marker?.pointer || "statusLine.command").split(".")[0];
  // The status line is opt-in (projectstore.json → statusline.enabled), as
  // the SessionStart refresh already honours; naming the surface explicitly
  // is the other way to opt in.
  if (mode === "install" && !ctx.optIn.has(key)) {
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "opt-out", action: "skip", reason: "statusline.enabled is not true in projectstore.json — name --surface statusline to wire it anyway" }];
  }
  const a = analyseJsonEntry(projectDir, s, { root, home });
  if (a.state === "unparseable") return [{ surface: key, kind: "shared", path, entry: entryKey, state: "unparseable", action: "refuse", reason: a.reason }];

  if (mode === "uninstall") {
    if (!a.curEntry) return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-absent", action: "skip", reason: null }];
    if (!a.ours) return [{ surface: key, kind: "shared", path, entry: entryKey, state: "theirs", action: "skip", reason: "the entry is not ours — left in place" }];
    const after = { ...a.settings }; delete after[entryKey];
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-current", action: "remove", reason: null, before: a.settings, after }];
  }
  if (a.state === "theirs") {
    ctx.slotForeign.add(key);
    return [{ surface: key, kind: "shared", path, entry: entryKey, state: "theirs", action: "skip", reason: "a status line we did not write owns the slot — left to its owner, and nothing else is wired for it" }];
  }
  if (a.state === "ours-current") return [{ surface: key, kind: "shared", path, entry: entryKey, state: "ours-current", action: "skip", reason: null }];
  const after = { ...a.settings, [entryKey]: { ...(a.curEntry && typeof a.curEntry === "object" ? a.curEntry : {}), type: "command", command: a.desired } };
  return [{ surface: key, kind: "shared", path, entry: entryKey, state: a.state, action: a.curEntry ? "replace-entry" : (a.cur.present ? "add" : "create"),
    reason: a.curEntry ? a.reason : null, before: a.cur.present ? a.settings : null, after }];
}

function planStampedFile(ctx, key, s) {
  const { projectDir, mode, root, home, harness } = ctx;
  const path = join(projectDir, s.file);
  const produced = !(s.condition === "plugin_cache_install" && !isPluginCacheRoot(root, home));
  // The policy early-outs come before the render-and-hash, which they make
  // unnecessary.
  if (produced && mode === "install" && !ctx.optIn.has(s.condition ? "statusline" : key) && !ctx.optIn.has(key)) {
    return [{ surface: key, kind: "exclusive", path, entry: null, state: "opt-out", action: "skip", reason: "statusline.enabled is not true in projectstore.json" }];
  }
  if (produced && mode === "install" && ctx.slotForeign.size) {
    return [{ surface: key, kind: "exclusive", path, entry: null, state: "absent-or-present", action: "skip", reason: "the status line slot is foreign; a launcher nothing points at is not written" }];
  }
  const a = analyseStampedFile(projectDir, s, { root, home, harness });
  // Not produced for this installation (a dev checkout is wired directly):
  // a root that cannot produce a file has, by construction, never written it,
  // so install and upgrade REPORT it and leave it (contract 13's wording;
  // contract 7 as amended 2026-09-05 — a dev checkout's plan used to prune a
  // cache install's launcher, the maintainer's habitual loop). Only uninstall
  // removes it: the user asked to disown, and the file is recognisably ours.
  // `prune` stays an action for the day a surface leaves the roster.
  if (!a.produced) {
    if (!a.file.present) return [];
    if (!a.ours) return [{ surface: key, kind: "exclusive", path, entry: null, state: "foreign", action: "skip", reason: "not produced for a dev checkout, and not ours — left in place" }];
    return [{ surface: key, kind: "exclusive", path, entry: null, state: "stale", action: mode === "uninstall" ? "remove" : "skip", reason: a.reason }];
  }
  if (a.refusal) return [{ surface: key, kind: "exclusive", path, state: "refused", action: "refuse", reason: a.refusal }];
  const base = { surface: key, kind: "exclusive", path, entry: null, state: a.state, reason: a.reason, writtenBy: a.writtenBy, sameProject: a.sameProject };
  if (mode === "uninstall") {
    if (a.state === "absent") return [{ ...base, action: "skip" }];
    if (a.state === "foreign") return [{ ...base, action: "refuse", reason: FOREIGN_TEXT }];
    return [{ ...base, action: "remove" }];
  }
  if (a.state === "foreign") return [{ ...base, action: "refuse", reason: FOREIGN_TEXT }];
  if (a.state === "current") return [{ ...base, action: "skip" }];
  return [{ ...base, action: a.state === "absent" ? "create" : "update", after: a.stamped.text }];
}

// ─── plan ──────────────────────────────────────────────────────────────

export function plan(projectDir, { harnesses = [], mode = "install", env = process.env, home = homedir(), root = pluginRoot(), surfaces = null } = {}) {
  projectDir = resolve(projectDir);
  const detected = detectHarnesses(projectDir);
  const named = harnesses.filter(Boolean);
  const ids = named.length ? named : detected.map((d) => d.id);
  const out = { projectDir, mode, named: named.length > 0, detected, harnesses: [], reports: [], items: [], refusals: [], ok: true };
  const unknown = named.filter((id) => !harnessIds().includes(id));
  if (unknown.length) {
    out.refusals.push(`unknown harness: ${unknown.join(", ")} — known: ${harnessIds().join(", ")}`);
    out.ok = false;
    return out;
  }
  if (!ids.length) {
    out.refusals.push(harnessRefusal(projectDir));
    out.ok = false;
    return out;
  }
  const cfg = readConfigAt(projectDir);
  const optIn = new Set(surfaces || []);
  if (cfg?.statusline?.enabled === true) optIn.add("statusline");
  for (const id of ids) {
    const harness = loadHarness(id);
    out.harnesses.push(id);
    const ctx = { projectDir, mode, env, home, root, harness, optIn, slotForeign: new Set() };
    const hostRows = [];
    for (const [key, s] of Object.entries(harness.surfaces || {})) {
      if (key.startsWith("_")) continue;
      if (surfaces && !surfaces.some((x) => key === x || key.startsWith(x + "_"))) continue;
      if (s.kind === "host") { hostRows.push(key); continue; }
      const handler = HANDLERS[s.format];
      if (!handler) { out.refusals.push(`${id}: surface ${key} has format ${s.format}, which this installer cannot handle`); continue; }
      for (const item of handler(ctx, key, s)) out.items.push({ harness: id, ...item });
    }
    if (hostRows.length && !surfaces) out.reports.push(hostManagedReport(harness, hostRows));
  }
  if (out.items.some((i) => i.action === "refuse")) out.ok = false;
  if (out.refusals.length) out.ok = false;
  return out;
}

// Contract 14: the host installs and updates these itself; say how, from the
// manifest, and write nothing. (PR #13's installElsewhere, as a plan line.)
function hostManagedReport(m, rows) {
  const inst = m.install || {};
  const lines = [`${m.display_name}: ${rows.join(", ")} are installed by ${inst.mechanism || "the host"} — nothing to write.`];
  if (inst.why_not_scripted) lines.push(`  ${inst.why_not_scripted}`);
  for (const s of inst.steps || []) lines.push(`    ${s}`);
  for (const n of inst.notes || []) lines.push(`  ${n}`);
  if (inst.docs) lines.push(`  ${inst.docs}`);
  return lines.join("\n");
}

const isWrite = (i) => !["skip", "refuse"].includes(i.action);

// ─── preview ───────────────────────────────────────────────────────────

export function renderPreview(p) {
  const lines = [`projectstore ${p.mode} — ${p.harnesses.join(", ") || "(no harness)"} — ${p.projectDir}`, ""];
  for (const r of p.reports) lines.push(...r.split("\n").map((l) => "  " + l), "");
  const writes = p.items.filter(isWrite);
  for (const i of p.items) {
    const where = rel(p.projectDir, i.path) + (i.entry ? `  [${i.entry}]` : "");
    let state = i.state;
    if (i.state === "current" && i.writtenBy && !i.sameProject) state = `current, last written by ${i.writtenBy}`;
    if (i.reason && i.action !== "refuse") state += ` (${i.reason})`;
    lines.push(`  ${i.kind.padEnd(9)} ${where}`);
    lines.push(`            ${state.padEnd(44)} → ${i.action}${i.action === "refuse" && i.reason ? ": " + i.reason : ""}`);
    if (i.deleteIfEmpty && typeof i.after === "string" && !i.after.trim()) lines.push(`            (the file would hold nothing else and is removed)`);
  }
  const exclusiveRemoval = p.items.find((i) => i.action === "remove" && i.kind === "exclusive");
  if (exclusiveRemoval) lines.push(`            (an emptied ${rel(p.projectDir, dirname(exclusiveRemoval.path))}/ is pruned)`);
  for (const r of p.refusals) lines.push(`  refused   ${r}`);
  lines.push("", "  Nothing outside a marked entry is read, rewritten or removed.");
  if (!p.ok) lines.push("", "  Nothing will be written: resolve the refusals above first.");
  else if (!writes.length) lines.push("", "  Nothing to change.");
  else lines.push("", `  ${writes.length} change(s) to apply.`);
  return lines.join("\n") + "\n";
}

// ─── gate ──────────────────────────────────────────────────────────────

// A named harness is the explicit confirmation (contract 9). Otherwise ask on
// a TTY, and refuse without one. Streams are parameters so the TTY branch is
// testable without a pseudo-terminal.
export async function confirm(p, { stdin = process.stdin, stdout = process.stdout, ask = null } = {}) {
  if (!p.ok) return { confirmed: false, why: "refused" };
  const writes = p.items.filter(isWrite);
  if (!writes.length) return { confirmed: false, why: "nothing-to-do" };
  if (p.named) return { confirmed: true, why: "named" };
  const interactive = Boolean(stdin && stdin.isTTY && stdout && stdout.isTTY);
  if (!interactive && !ask) return { confirmed: false, why: "non-tty" };
  const answer = ask ? await ask(`Apply these ${writes.length} change(s)? [y/N] `) : await (async () => {
    const rl = createInterface({ input: stdin, output: stdout });
    try { return await rl.question(`Apply these ${writes.length} change(s)? [y/N] `); } finally { rl.close(); }
  })();
  return /^y(es)?$/i.test(String(answer).trim()) ? { confirmed: true, why: "answered" } : { confirmed: false, why: "declined" };
}

// ─── apply ─────────────────────────────────────────────────────────────

export function apply(p) {
  if (!p.ok) throw new Error("apply: the plan carries refusals; nothing is written");
  const done = [];
  for (const i of p.items) {
    if (!isWrite(i)) continue;
    if (i.kind === "shared" && typeof i.after === "object" && i.after !== null && !Array.isArray(i.after)) {
      mkdirSync(dirname(i.path), { recursive: true });
      writeFileAtomic(i.path, JSON.stringify(i.after, null, 2) + "\n", { sweep: false });
    } else if ((i.action === "remove" || i.action === "prune") && i.kind === "exclusive") {
      try { unlinkSync(i.path); } catch {}
      pruneEmptyDir(dirname(i.path), p.projectDir);
    } else if (i.action === "remove" && i.kind === "shared" && typeof i.after === "string") {
      if (i.deleteIfEmpty && !i.after.trim()) { try { unlinkSync(i.path); } catch {} }
      else writeFileAtomic(i.path, i.after, { sweep: false });
    } else if (typeof i.after === "string") {
      if (i.kind === "exclusive") ensureRuntimeDir(p.projectDir); // carries the nested .gitignore
      else mkdirSync(dirname(i.path), { recursive: true });
      writeFileAtomic(i.path, i.after, { sweep: false });
    }
    done.push({ path: i.path, action: i.action, surface: i.surface });
  }
  return done;
}

// rmdirSync refuses a non-empty directory — that refusal IS the guarantee
// (contract 13): we prune only a directory we emptied. The runtime dir's own
// .gitignore does not count as content.
function pruneEmptyDir(dir, projectDir) {
  if (!inside(dir, projectDir)) return;
  try {
    const left = readdirSync(dir).filter((n) => n !== ".gitignore");
    if (left.length) return;
    try { unlinkSync(join(dir, ".gitignore")); } catch {}
    rmdirSync(dir);
  } catch {}
}

// ─── verbs ─────────────────────────────────────────────────────────────

export async function runVerb(verb, projectDir, opts = {}) {
  const mode = verb === "uninstall" ? "uninstall" : "install"; // upgrade is install re-run (contract 14)
  const p = plan(projectDir, { ...opts, mode });
  const preview = renderPreview(p);
  const gate = await confirm(p, opts);
  const result = { verb, plan: p, preview, gate, applied: [] };
  if (gate.confirmed) result.applied = apply(p);
  return result;
}

// ─── main ──────────────────────────────────────────────────────────────

function usage() {
  return [
    "usage: install-harness.mjs <install|uninstall|upgrade|plan> [--harness <id>]... [--surface <key>]... [--project <dir>] [--json]",
    `  harnesses: ${harnessIds().join(", ")}`,
    "  --surface narrows the plan to a surface and the surfaces beneath it (statusline covers statusline_launcher)",
    "  --harness names the harness — and, non-interactively, is the confirmation; there is no --yes",
  ].join("\n");
}

// The JSON envelope carries states and actions, never file bodies: a model
// reading a status report must not receive the whole of CLAUDE.md twice.
export const publicItem = ({ before, after, ...rest }) => rest;

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!["install", "uninstall", "upgrade", "plan"].includes(verb)) { process.stderr.write(usage() + "\n"); process.exit(2); }
  const harnesses = [], surfaces = [];
  let projectDir = null, json = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) { process.stderr.write(`${a} needs a value\n${usage()}\n`); process.exit(2); } return v; };
    if (a === "--harness") harnesses.push(value());
    else if (a === "--surface") surfaces.push(value());
    else if (a === "--project") projectDir = value();
    else if (a === "--json") json = true;
    else { process.stderr.write(`unknown argument ${a}\n${usage()}\n`); process.exit(2); }
  }
  const src = sourceHarness();
  projectDir = resolve(projectDir || (src && process.env[src.runtime?.project_dir_env]) || process.cwd());
  const opts = { harnesses, surfaces: surfaces.length ? surfaces : null };
  if (verb === "plan") {
    const p = plan(projectDir, opts);
    process.stdout.write(json ? JSON.stringify({ ...p, items: p.items.map(publicItem) }, null, 2) + "\n" : renderPreview(p));
    process.exit(p.ok ? 0 : 1);
  }
  const r = await runVerb(verb, projectDir, opts);
  if (json) {
    process.stdout.write(JSON.stringify({ verb, ok: r.plan.ok, gate: r.gate, applied: r.applied, items: r.plan.items.map(publicItem), refusals: r.plan.refusals, reports: r.plan.reports }, null, 2) + "\n");
  } else {
    process.stdout.write(r.preview);
    if (r.gate.confirmed) process.stdout.write(`applied ${r.applied.length} change(s).\n`);
    else if (r.gate.why === "non-tty") process.stdout.write(`a bare ${verb} in a non-TTY refuses; name a harness to confirm: --harness ${r.plan.detected.map((d) => d.id).join(" | ") || harnessIds().join(" | ")}\n`);
    else if (r.gate.why === "declined") process.stdout.write("nothing written.\n");
  }
  process.exit(r.plan.ok && (r.gate.confirmed || r.gate.why === "nothing-to-do") ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

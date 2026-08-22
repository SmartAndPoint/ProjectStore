#!/usr/bin/env node
// projectstore — build-adapters.mjs
//
// Renders every source surface (commands/, agents/, skills/, hooks/hooks.json)
// for every harness in harnesses/ that asks to be emitted, and writes the
// result under that harness's output_dir.
//
// This file is the reason a feature written once reaches every harness. The
// guarantee is not that the author remembers to port it — it is that
// tests/portability.test.mjs re-runs `renderAll()` in memory and compares the
// bytes to what is committed, so a new command that was never rendered fails
// the suite with the path it should have produced. The lint half of the same
// suite closes the other direction: a surface may not contain a harness-branded
// fragment that some emitting harness has no rewrite rule for.
//
// Usage:
//   node scripts/build-adapters.mjs            # write the trees
//   node scripts/build-adapters.mjs --check    # exit 1 if anything is stale
//   node scripts/build-adapters.mjs --harness codex
//
// Pure node, no external deps.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { emittingHarnesses, loadHarness, sourceHarness, applyRewrites, REPO_ROOT } from "./harness.mjs";

// ─── Frontmatter (raw-preserving) ──────────────────────────────────────

// lib.mjs's parseFrontmatter keys on /^(\w+):/ and so cannot see `argument-hint`,
// and it discards the original block. Both matter here: the generator has to
// round-trip a command file's frontmatter unchanged except for rewrites, and it
// has to read hyphenated keys to do it.
export function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { raw: null, keys: {}, body: text };
  const keys = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    keys[kv[1]] = v;
  }
  return { raw: m[1], keys, body: text.slice(m[0].length) };
}

// ─── Harness gating ────────────────────────────────────────────────────
//
// String rewriting can rename a token; it cannot delete a paragraph. Some
// content is not translatable because the concept does not exist on the other
// side — Claude Code's marketplace auto-update has no Codex counterpart, and
// Codex's installer step has no Claude Code counterpart. Pretending otherwise
// is how a prompt ends up instructing Codex to open a menu it does not have.
//
// Two escape hatches, both declarative:
//
//   * a BLOCK, for a section inside an otherwise portable file:
//
//       <!-- projectstore:harness only=claude-code -->
//       …Claude Code only…
//       <!-- /projectstore:harness -->
//
//     `only=` and `except=` both accept a comma-separated list. Markers are
//     HTML comments, so the source file still renders correctly on the harness
//     that reads it directly.
//
//   * a WHOLE FILE, via frontmatter `harness-only:` / `harness-except:`, for a
//     surface that is meaningless elsewhere (the status line is a Claude Code
//     slot with no Codex equivalent).
//
// The coverage invariant in tests/portability.test.mjs treats a file that
// renders for no harness as a failure, so these hatches cannot be used to
// quietly drop a surface everywhere.

const BLOCK_RE =
  /[ \t]*<!--\s*projectstore:harness\s+([^>]*?)\s*-->\r?\n?([\s\S]*?)[ \t]*<!--\s*\/projectstore:harness\s*-->\r?\n?/g;

// The COMMENTED form, and the reason it has to exist.
//
// The source layout is not just where surfaces are authored — Claude Code reads
// commands/, agents/ and skills/ directly, markers and all. So content inside a
// plain `except=claude-code` block is still delivered to Claude Code as ordinary
// prose, which is how a command ends up carrying two contradictory placement
// rules and following whichever it reads last.
//
// Content meant for OTHER harnesses therefore lives inside the comment:
//
//     <!-- projectstore:harness-alt only=codex
//     2. **Scan `AGENTS.md`** — this harness reads it natively.
//     -->
//
// The source harness sees an HTML comment and ignores it. A matching harness
// gets the body inlined with the wrapper stripped. tests/portability.test.mjs
// enforces the split: a visible block may not exclude the source harness.
const ALT_BLOCK_RE =
  /[ \t]*<!--\s*projectstore:harness-alt\s+([^\n]*?)\s*\r?\n([\s\S]*?)\r?\n[ \t]*-->\r?\n?/g;

function listAttr(attrs, name) {
  const m = attrs.match(new RegExp(name + "=([^\\s]+)"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
}

// Every `key=` in a gate's attribute string. A gate is only meaningful with
// `only` or `except`; anything else is a typo, and a typo is silent in the
// worst direction — `onl=claude-code` parses to no constraint at all, so a
// block meant for one harness renders into every one of them. The test below
// uses this to reject a gate that constrains nothing.
export function attrKeys(attrs) {
  return [...String(attrs).matchAll(/([A-Za-z_-]+)=/g)].map((m) => m[1]);
}

export function harnessAllows(only, except, id) {
  if (only && only.length && !only.includes(id)) return false;
  if (except && except.length && except.includes(id)) return false;
  return true;
}

export function applyHarnessBlocks(text, id) {
  const visible = String(text).replace(BLOCK_RE, (_all, attrs, inner) =>
    harnessAllows(listAttr(attrs, "only"), listAttr(attrs, "except"), id) ? inner : "",
  );
  // Alt blocks resolve after the visible ones so a visible block may contain an
  // alt block, not the other way round — the reverse would need the comment
  // wrapper to survive its own removal.
  // The leading separator matters: an alt block often replaces a clause
  // mid-sentence, and without it the inlined body fuses onto the word before
  // it ("…at high effort."*Do NOT offer…").
  return visible.replace(ALT_BLOCK_RE, (_all, attrs, inner) =>
    harnessAllows(listAttr(attrs, "only"), listAttr(attrs, "except"), id) ? " " + inner + "\n" : "",
  );
}

// Both marker forms, for the lint and for the gate-name check.
export function harnessBlockAttrs(text) {
  const out = [];
  for (const m of String(text).matchAll(BLOCK_RE)) out.push({ form: "visible", attrs: m[1], body: m[2] });
  for (const m of String(text).matchAll(ALT_BLOCK_RE)) out.push({ form: "alt", attrs: m[1], body: m[2] });
  return out;
}

export function blockTargets(attrs) {
  return { only: listAttr(attrs, "only"), except: listAttr(attrs, "except") };
}

// Whole-file gate, read from frontmatter.
function fileAllowed(keys, id) {
  const split = (v) => (typeof v === "string" && v ? v.split(",").map((s) => s.trim()) : null);
  return harnessAllows(split(keys["harness-only"]), split(keys["harness-except"]), id);
}

// The gating keys are projectstore's own; no harness reads them, and leaving
// them in the emitted frontmatter would be noise in a file the user may open.
function stripGatingKeys(raw) {
  return raw
    .split(/\r?\n/)
    .filter((l) => !/^harness-(only|except):/.test(l))
    .join("\n");
}

// ─── TOML emission ─────────────────────────────────────────────────────

export function tomlString(s) {
  return JSON.stringify(String(s));
}

// TOML multi-line basic strings process escapes exactly like basic strings, so
// a backslash in the prose (and projectstore's agent prompts contain them, in
// regex and path examples) would be read as an escape sequence and either
// mangle the text or fail the parse outright. A literal `"""` inside the body
// would end the string early; a trailing quote would fuse with the delimiter.
export function tomlMultiline(s) {
  let v = String(s).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  if (v.endsWith('"')) v = v.slice(0, -1) + '\\"';
  return '"""\n' + v + '\n"""';
}

// ─── Generated-file banners ────────────────────────────────────────────
//
// Deliberately carries no version and no timestamp: the staleness test compares
// bytes, and a banner that changed every build would make every commit dirty
// and train everyone to regenerate without reading the diff.

const BANNER_LINES = (harness, source) => [
  `GENERATED by scripts/build-adapters.mjs from ${source} for the ${harness} harness.`,
  `Do not edit this file — edit the source and re-run the generator.`,
  `tests/portability.test.mjs fails while this file is out of date.`,
];

function mdBanner(harness, source) {
  return "<!--\n" + BANNER_LINES(harness, source).map((l) => "  " + l).join("\n") + "\n-->\n";
}

function hashBanner(harness, source) {
  return BANNER_LINES(harness, source).map((l) => "# " + l).join("\n") + "\n";
}

// The wrapper is JavaScript, where `#` is a syntax error rather than a comment.
// Emitting the hash banner into it produced a file that parsed nowhere and took
// every hook down with it.
function slashBanner(harness, source) {
  return BANNER_LINES(harness, source).map((l) => "// " + l).join("\n") + "\n";
}

// ─── Surface renderers ─────────────────────────────────────────────────

function listDir(dir, pred) {
  try { return readdirSync(dir).filter(pred).sort(); } catch { return []; }
}

function outPath(harness, surfaceKey, name) {
  const s = harness.surfaces?.[surfaceKey];
  if (!s || !s.supported) return null;
  const file = String(s.file).replace(/<name>/g, name);
  const dir = s.dir && s.dir !== "." ? s.dir : "";
  return join(harness.output_dir, dir, file);
}

// commands/<name>.md → the harness's prompt/command surface, prose rewritten.
function renderCommands(root, harness, out) {
  for (const f of listDir(join(root, "commands"), (n) => n.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    const src = readFileSync(join(root, "commands", f), "utf8");
    const { raw, keys, body } = splitFrontmatter(src);
    if (!fileAllowed(keys, harness.id)) continue;
    const fm = raw === null ? "" : "---\n" + applyRewrites(stripGatingKeys(raw), harness) + "\n---\n";
    const pre = harness.surfaces?.commands?.preamble;
    const text =
      fm +
      mdBanner(harness.id, `commands/${f}`) +
      (pre ? "\n" + pre.trimEnd() + "\n" : "") +
      applyRewrites(applyHarnessBlocks(body, harness.id), harness);
    const p = outPath(harness, "commands", name);
    if (p) out.set(p, text);
  }
}

// skills/<name>/SKILL.md → same shape everywhere, but Codex requires a `name:`
// key that Claude Code infers from the directory. Added when the manifest says
// the harness needs it, rather than added to the source: the source is Claude
// Code's tree, and a key it ignores is a key its own doctor would not check.
function renderSkills(root, harness, out) {
  const base = join(root, "skills");
  for (const name of listDir(base, (n) => {
    try { return statSync(join(base, n)).isDirectory() && existsSync(join(base, n, "SKILL.md")); }
    catch { return false; }
  })) {
    const src = readFileSync(join(base, name, "SKILL.md"), "utf8");
    const { raw, keys, body } = splitFrontmatter(src);
    if (!fileAllowed(keys, harness.id)) continue;
    let fmLines = raw === null ? [] : applyRewrites(stripGatingKeys(raw), harness).split("\n");
    if (harness.surfaces?.skills?.requires_name_frontmatter) {
      const hasName = fmLines.some((l) => /^name:\s*/.test(l));
      if (!hasName) fmLines = [`name: projectstore-${name}`, ...fmLines];
    }
    const fm = fmLines.length ? "---\n" + fmLines.join("\n") + "\n---\n" : "";
    // Skills fire autonomously, with no /projectstore-* prompt in context — so
    // they are the surface most likely to be the ONLY projectstore text the
    // model has, and the one where an undefined "approval prompt" costs most.
    const pre = harness.surfaces?.skills?.preamble;
    const text =
      fm +
      mdBanner(harness.id, `skills/${name}/SKILL.md`) +
      (pre ? "\n" + pre.trimEnd() + "\n\n" : "") +
      applyRewrites(applyHarnessBlocks(body, harness.id), harness);
    const p = outPath(harness, "skills", name);
    if (p) out.set(p, text);
  }
}

// agents/<name>.md (YAML frontmatter + markdown body) → the harness's agent
// format. For Codex that is TOML with `developer_instructions`; the mapping
// rules — which keys survive, which are dropped, how `tools:` becomes a sandbox
// mode — live in the manifest's agent_translation block, not here.
function renderAgents(root, harness, out) {
  const tr = harness.agent_translation || {};
  const fmt = harness.surfaces?.agents?.format;
  for (const f of listDir(join(root, "agents"), (n) => n.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    const src = readFileSync(join(root, "agents", f), "utf8");
    const { keys, body } = splitFrontmatter(src);
    if (!fileAllowed(keys, harness.id)) continue;
    const p = outPath(harness, "agents", name);
    if (!p) continue;

    if (fmt !== "agent-toml") {
      out.set(p, applyRewrites(src, harness));
      continue;
    }

    const lines = [hashBanner(harness.id, `agents/${f}`), ""];
    const prefix = harness.surfaces?.agents?.name_prefix || "";
    lines.push(`name = ${tomlString(prefix + (keys.name || name))}`);
    lines.push(`description = ${tomlString(applyRewrites(keys.description || "", harness))}`);

    // Omitted when unmapped, and the bundled map is empty on purpose: Codex
    // model IDs are a different namespace, and guessing one would pin every
    // agent to a model the user never chose. Absent means "inherit the session".
    const model = (tr.model_map || {})[keys.model];
    if (model) lines.push(`model = ${tomlString(model)}`);

    const effort = (tr.effort_map || {})[keys.effort];
    if (effort && tr.effort_key) lines.push(`${tr.effort_key} = ${tomlString(effort)}`);

    // `tools:` has no Codex analogue. Every bundled agent uses it to say
    // read-only, so that is what it translates into — and an agent that DOES
    // list a write tool must not silently become read-only, so it is left
    // unconstrained instead.
    if (tr.readonly_sandbox_mode) {
      const declared = String(keys.tools || "").split(",").map((s) => s.trim()).filter(Boolean);
      const writers = tr.write_tools_implying_workspace_write || [];
      if (declared.length && !declared.some((t) => writers.includes(t))) {
        lines.push(`sandbox_mode = ${tomlString(tr.readonly_sandbox_mode)}`);
      }
    }

    lines.push("");
    const apre = harness.surfaces?.agents?.preamble;
    const instructions =
      (apre ? apre.trimEnd() + "\n\n" : "") +
      applyRewrites(applyHarnessBlocks(body, harness.id).trim(), harness);
    lines.push(`developer_instructions = ${tomlMultiline(instructions)}`);
    out.set(p, lines.join("\n") + "\n");
  }
}

// hooks/hooks.json → the harness's hook config. Event names come from the
// manifest's map (identity today, but a harness that renames one only edits
// JSON), unsupported events are dropped rather than emitted dead, and the
// source's write matcher is swapped for the target's tool vocabulary.
function renderHooks(root, harness, out, src) {
  const p = outPath(harness, "hooks", "hooks");
  if (!p) return;
  const cfg = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  const map = harness.hooks?.events || {};
  const unsupported = new Set(harness.hooks?.unsupported_events || []);
  const srcWrite = src.hooks?.matchers?.write;
  const dstWrite = harness.hooks?.matchers?.write;
  const srcRoot = src.hooks?.root_placeholder;
  const dstRoot = harness.hooks?.root_placeholder;

  const outHooks = {};
  for (const [event, entries] of Object.entries(cfg.hooks || {})) {
    if (unsupported.has(event)) continue;
    const target = map[event];
    if (!target) continue; // not expressible on this harness — dropped, not faked
    outHooks[target] = entries.map((entry) => {
      const e = {};
      if (typeof entry.matcher === "string") {
        e.matcher = entry.matcher === srcWrite && dstWrite ? dstWrite : applyRewrites(entry.matcher, harness);
      }
      e.hooks = (entry.hooks || []).map((h) => {
        const cmd = String(h.command || "");
        // The plugin-root token is replaced structurally rather than by the
        // prose rewrite table, because the target is a wrapper path and not a
        // renamed variable — see wrapperInvocation.
        const rel = cmd.replace(srcRoot + "/", "").replace(/^node\s+/, "").replace(/^["']|["']$/g, "");
        return { ...h, command: wrapperInvocation(harness, dstRoot, rel) };
      });
      return e;
    });
  }
  out.set(p, JSON.stringify({ hooks: outHooks }, null, 2) + "\n");
}

// Every hook goes through a generated wrapper instead of being launched
// directly. The wrapper's whole job is to stamp PROJECTSTORE_HARNESS before the
// real hook module loads: detection reads environment variables the harness may
// or may not export (Codex only sets CODEX_HOME when the user overrode it), and
// a hook that guesses the wrong harness picks the wrong write-tool vocabulary
// and silently logs nothing. Stamping it at the entry point removes the guess.
function wrapperInvocation(harness, rootToken, relPath) {
  const dir = harness.surfaces?.hooks?.dir;
  const prefix = dir && dir !== "." ? dir + "/" : "";
  return `node "${rootToken}/${harness.output_dir}/bin/ps-hook.mjs" ${relPath}`.replace(/\s+$/, "");
}

function renderWrapper(harness, out) {
  const depth = harness.output_dir.split("/").filter(Boolean).length + 1; // + bin/
  const ups = Array(depth).fill("..").join('", "');
  const text = `#!/usr/bin/env node
${slashBanner(harness.id, "scripts/build-adapters.mjs (wrapper)")}//
// Launches a projectstore hook with this harness's identity already stamped.
//
// Without it, hooks/*.mjs would have to infer the harness from environment
// variables the harness does not promise to export — and inferring wrong is
// not visible as an error, it is an activity log that quietly stays empty.
//
// argv[2] is a path relative to the plugin root. stdin is deliberately
// untouched: the hook module reads the payload itself.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "${ups}");

process.env.PROJECTSTORE_HARNESS = ${JSON.stringify(harness.id)};
if (!process.env.${harness.runtime.plugin_root_env}) process.env.${harness.runtime.plugin_root_env} = root;

const target = process.argv[2];
if (!target) process.exit(0);

try {
  await import(pathToFileURL(join(root, target)).href);
} catch (e) {
  // A hook must never break the user's session, so this stays a no-op and exits
  // zero. But swallowing it silently is how a hook that throws on every single
  // turn stays invisible: nothing in the session reports it, and \`doctor\` only
  // checks whether the ADAPTERS are stale, never whether a hook actually runs.
  // The breadcrumb is what makes it detectable at all — doctor reports the
  // file's presence, and it is the only evidence a user or a bug report has.
  try {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const dir = join(root, ".projectstore");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "hook-errors.log"),
      new Date().toISOString() + "\\t" + target + "\\t" + ((e && e.message) || e) + "\\n",
      "utf8",
    );
  } catch {}
  process.exit(0);
}
`;
  out.set(join(harness.output_dir, "bin", "ps-hook.mjs"), text);
}

// The SECOND entry point, and the one the review found missing. Hooks were
// stamped; the commands were not. A generated prompt says
// `node "<root>/scripts/doctor.mjs"`, Codex runs that through its shell tool,
// and nothing in that process names a harness: Codex exports CODEX_HOME only
// when the user overrode it, so detection falls through to "whichever harness
// directory holds a bind file". For a project a colleague bound under Claude
// Code — the exact case the shared-vault feature exists for — that answers
// `claude-code` while the hooks in the same session answer `codex`. The result
// is not an error: the script prints the other harness's command spelling and
// writes runtime state under the other harness's directory, and the two halves
// of one session disagree with nobody reporting it.
//
// Unlike the hook wrapper this one must NOT swallow failures. A hook that
// throws should never break a session; a command the user ran is read for its
// output and branched on by its exit code, so both have to pass through.
function renderRunWrapper(harness, out) {
  const depth = harness.output_dir.split("/").filter(Boolean).length + 1; // + bin/
  const ups = Array(depth).fill("..").join('", "');
  const text = `#!/usr/bin/env node
${slashBanner(harness.id, "scripts/build-adapters.mjs (run wrapper)")}//
// Launches a projectstore script with this harness's identity already stamped.
//
// argv[2] is a path relative to the plugin root; everything after it is the
// script's own arguments.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "${ups}");

process.env.PROJECTSTORE_HARNESS = ${JSON.stringify(harness.id)};
if (!process.env.${harness.runtime.plugin_root_env}) process.env.${harness.runtime.plugin_root_env} = root;

const target = process.argv[2];
if (!target) {
  console.error("usage: ps-run.mjs <script-path-relative-to-plugin-root> [args...]");
  process.exit(2);
}

// Every script guards its main() on \`resolve(process.argv[1])\` matching its own
// file. Left pointing at this wrapper, each one would import cleanly and then do
// nothing at all — a command that prints nothing and exits zero, which reads as
// "there was nothing to report" rather than as a broken launcher.
const abs = resolve(root, target);
process.argv = [process.argv[0], abs, ...process.argv.slice(3)];

await import(pathToFileURL(abs).href);
`;
  out.set(join(harness.output_dir, "bin", "ps-run.mjs"), text);
}

// ─── Public API ────────────────────────────────────────────────────────

// The full generated tree as a path → content map. The test calls this and
// compares against disk; `main` calls it and writes. One code path, so "what
// the test checked" and "what the build produced" cannot diverge.
export function renderAll(root = REPO_ROOT, only = null) {
  const src = sourceHarness();
  const out = new Map();
  for (const harness of emittingHarnesses()) {
    if (only && harness.id !== only) continue;
    renderCommands(root, harness, out);
    renderSkills(root, harness, out);
    renderAgents(root, harness, out);
    renderHooks(root, harness, out, src);
    renderWrapper(harness, out);
    renderRunWrapper(harness, out);
  }
  return out;
}

// Paths that are currently on disk under an emitting harness's output_dir —
// so the writer can delete a file whose source surface was removed. Without
// this, deleting a command would leave its Codex prompt behind forever.
function existingOutputs(root, only = null) {
  const found = new Set();
  for (const harness of emittingHarnesses()) {
    if (only && harness.id !== only) continue;
    const base = join(root, harness.output_dir);
    const walk = (dir) => {
      let names = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else found.add(relative(root, p).split("\\").join("/"));
      }
    };
    walk(base);
  }
  return found;
}

export function diffAgainstDisk(root = REPO_ROOT, only = null) {
  const want = renderAll(root, only);
  const have = existingOutputs(root, only);
  const changed = [];
  const missing = [];
  const stale = [];
  for (const [rel, content] of want) {
    const abs = join(root, rel);
    if (!existsSync(abs)) { missing.push(rel); continue; }
    if (readFileSync(abs, "utf8") !== content) changed.push(rel);
  }
  for (const rel of have) if (!want.has(rel)) stale.push(rel);
  return { missing, changed, stale, ok: !missing.length && !changed.length && !stale.length };
}

function write(root, only) {
  const want = renderAll(root, only);
  const have = existingOutputs(root, only);
  let n = 0;
  for (const [rel, content] of want) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) { writeFileSync(abs, content, "utf8"); n++; }
  }
  let removed = 0;
  for (const rel of have) {
    if (want.has(rel)) continue;
    try { rmSync(join(root, rel)); removed++; } catch {}
  }
  // Removing the file is not removing the surface: a renamed skill leaves its
  // old directory behind, and Codex discovers skills by walking for SKILL.md —
  // so an empty leftover is invisible to it but very visible in a diff, where
  // it reads as a surface that still exists.
  for (const harness of emittingHarnesses()) {
    if (only && harness.id !== only) continue;
    pruneEmptyDirs(join(root, harness.output_dir));
  }
  return { written: n, total: want.size, removed };
}

// Depth-first so a directory emptied by pruning its children is itself pruned.
// Never removes the output root: an adapter tree that legitimately renders
// nothing should still exist as an empty directory rather than vanish.
function pruneEmptyDirs(dir, isRoot = true) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) pruneEmptyDirs(p, false);
  }
  if (isRoot) return;
  // rmdirSync, not rmSync: rmSync refuses a directory unless recursive:true is
  // passed, and passing it would turn a race (a file created between the check
  // and the call) into silent data loss. rmdirSync fails closed instead.
  try { rmdirSync(dir); } catch {}
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--harness") ? argv[argv.indexOf("--harness") + 1] : null;
  if (only && !loadHarness(only)) {
    console.error(`Unknown harness "${only}". Known: ${emittingHarnesses().map((h) => h.id).join(", ")}`);
    process.exit(2);
  }

  if (argv.includes("--check")) {
    const d = diffAgainstDisk(REPO_ROOT, only);
    if (d.ok) { console.log(`adapters up to date (${renderAll(REPO_ROOT, only).size} files)`); return; }
    for (const p of d.missing) console.error(`missing:  ${p}`);
    for (const p of d.changed) console.error(`stale:    ${p}`);
    for (const p of d.stale)   console.error(`orphaned: ${p}`);
    console.error("\nRun: node scripts/build-adapters.mjs");
    process.exit(1);
  }

  const r = write(REPO_ROOT, only);
  console.log(`adapters: ${r.written} written, ${r.total - r.written} unchanged, ${r.removed} removed`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

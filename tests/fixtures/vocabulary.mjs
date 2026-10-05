// projectstore — tests/fixtures/vocabulary.mjs: the runtime vocabulary lint
// (generation spec, contract 18), as pure functions the tests share.
//
// Invariant two keeps a foreign harness's vocabulary out of the GENERATED
// tree. These keep it out of what the core PRINTS: every command or role a
// message names goes through commandForm/roleForm (scripts/lib.mjs), so a
// literal in any harness's invocation form in hooks/ or scripts/ is a message
// that will be wrong on every other harness. Nothing here names a harness:
// the patterns come from the manifests' templates and the names from the
// source harness's own command and agent directories.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { loadHarnesses, sourceHarness, invocation, uiWordPatterns } from "../../scripts/harness.mjs";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The names a message can point at: the source harness's commands and roles,
// by file name (commands/<name>.md, agents/<name>.md).
export function sourceNames(root) {
  const src = sourceHarness();
  const names = {};
  for (const kind of ["commands", "agents"]) {
    const s = src.surfaces[kind];
    const dir = join(root, s.dir);
    const suffix = s.file.replace("<name>", "");
    names[kind] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => f.slice(0, -suffix.length)).sort() : [];
  }
  return names;
}

// Every manifest's invocation form for commands and roles, as one regex per
// (harness, kind): the template's literal text before `<name>`, followed by a
// source name, the family `*`, or an interpolation `${`. A template that is
// only `<name>` (no literal) yields no pattern — it would match everything.
export function invocationPatterns(root) {
  const names = sourceNames(root);
  const out = [];
  for (const m of loadHarnesses().values()) {
    for (const kind of ["commands", "agents"]) {
      const sample = invocation(m, "\u0000", { kind });
      if (sample === "\u0000") continue; // no template on this harness
      const [prefix] = sample.split("\u0000");
      if (!prefix || !/projectstore/.test(prefix)) continue; // never a bare `$` or `/`
      const alts = [...names[kind].map((n) => `${escape(n)}(?![a-z0-9-])`), "\\*", "\\$\\{"];
      // A prefix that starts with a word (`projectstore:`) must not match inside
      // another form that ends with it (`/projectstore:`, `$projectstore-`).
      const guard = /^\w/.test(prefix) ? "(?<![\\w/$:-])" : "";
      out.push({ harness: m.id, kind, prefix, re: new RegExp(`${guard}${escape(prefix)}(?:${alts.join("|")})`, "g") });
    }
  }
  return out;
}

// Literal text a message may carry although it looks like an invocation, each
// with the reason a reader can check (contract 8 of the generation spec).
// Markers come from the manifests; files whose text is vault content are named.
export function exemptions() {
  const list = [];
  for (const m of loadHarnesses().values()) {
    const marker = m.surfaces?.agents_block?.marker;
    if (marker?.close) list.push({ phrase: marker.close, why: "the agents block's close marker: a marker in a file, not a command anyone runs" });
  }
  list.push(
    { phrase: "\\/projectstore:agents", why: "the agents-block parser's regex source — it matches the close marker, it names no command" },
    { phrase: "Regenerate via `/projectstore:codemap`", file: "scripts/codemap.mjs", why: "written into code-map.md, a derived vault view doctor compares byte for byte; a harness-dependent sentence would read stale whenever the other harness last wrote it" },
    { phrase: "edit refs via `/projectstore:codemap set`", file: "scripts/codemap.mjs", why: "the same code-map.md header line" },
    { phrase: "Regenerate via `/projectstore:graph`", file: "scripts/graph.mjs", why: "written into graph.md, a derived vault view doctor compares byte for byte" },
  );
  return list;
}

// Line-preserving: comments become spaces, so a hit keeps its line number.
// Three passes, in this order: a block comment that opens and closes on one
// line, so a `//` inside it cannot cut its close; then line comments, so a
// `/*` inside one (`stories/*.md`) cannot open a block — that hid 455 lines of
// lib.mjs from the lint; then the block comments that span lines. A `//`
// inside a string still blanks the rest of its line; no runtime line has one
// (audited 2026-10-05).
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[^\n]*?\*\//g, blank)
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/\/\*[\s\S]*?\*\//g, blank);
}

// Every literal in an invocation form, as { file, line, text, harness, kind }.
export function scanLiterals(root, files, { patterns = invocationPatterns(root), exempt = exemptions(), read = (f) => readFileSync(join(root, f), "utf8") } = {}) {
  const hits = [];
  for (const file of files) {
    const lines = stripComments(read(file)).split("\n");
    lines.forEach((raw, k) => {
      let line = raw;
      for (const e of exempt) if (!e.file || e.file === file) line = line.split(e.phrase).join(" ".repeat(e.phrase.length));
      for (const p of patterns) {
        p.re.lastIndex = 0;
        for (const m of line.matchAll(p.re)) hits.push({ file, line: k + 1, text: m[0], harness: p.harness, kind: p.kind });
      }
    });
  }
  return hits;
}

// ─── Layer 1, UI words ──────────────────────────────────────────────────

// The source harness's UI affordances (ui_vocabulary) written into runtime
// code. Each must say why it reaches only a harness that has it: a check gated
// on that harness's surface, or a finding marked `about` it (aboutHarness).
export function uiExemptions() {
  const gated = "checkAutoUpdate, gated on a host-plugin-registration surface";
  return [
    { phrase: "a /plugin update no longer reaches the project", file: "scripts/doctor.mjs", why: "a finding about the source harness's own registration; under another harness it is marked `about` it" },
    { phrase: "(in Claude Code: /plugin marketplace update, then /plugin update, then restart)", file: "scripts/doctor.mjs", why: "the layout move's advice for an old copy of the source harness; under another harness the finding is marked `about` it" },
    { phrase: "Re-add it: /plugin marketplace add <owner/repo>.", file: "scripts/doctor.mjs", why: gated },
    { phrase: "(set via /plugin → Marketplaces → ", file: "scripts/doctor.mjs", why: gated },
    { phrase: "Manual path: /plugin marketplace update ${marketplace}, then /reload-plugins.", file: "scripts/doctor.mjs", why: gated },
    { phrase: "run /plugin marketplace update ${marketplace}, then /reload-plugins.", file: "scripts/doctor.mjs", why: gated },
  ];
}

export function scanUiWords(root, files, { patterns = uiWordPatterns(sourceHarness()), exempt = uiExemptions(), read = (f) => readFileSync(join(root, f), "utf8") } = {}) {
  const hits = [];
  for (const file of files) {
    stripComments(read(file)).split("\n").forEach((raw, k) => {
      let line = raw;
      for (const e of exempt) if (!e.file || e.file === file) line = line.split(e.phrase).join(" ".repeat(e.phrase.length));
      for (const p of patterns) {
        p.re.lastIndex = 0;
        for (const m of line.matchAll(p.re)) hits.push({ file, line: k + 1, text: m[0] });
      }
    });
  }
  return hits;
}

// The runtime code a session can execute: hooks and scripts, the generator
// aside (it holds the source vocabulary on purpose, to rewrite it).
export function runtimeFiles(root) {
  const pick = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".mjs")).map((f) => `${dir}/${f}`) : []);
  return [...pick("bin"), ...pick("hooks"), ...pick("scripts")].filter((f) => f !== "scripts/build-adapters.mjs").sort();
}

export const relTo = (root, p) => relative(root, p);

// ─── Layer 2: every name resolves on every harness ─────────────────────

// Every commandForm/roleForm call in the runtime code, as { file, line, kind,
// name } — or { …, name: null } when the first argument is not a string
// literal, which the lint refuses: a name it cannot read is a name it cannot
// resolve. sharedRoleForm is not scanned: it names the source harness's own
// registration of an agent found on disk, never a command for another harness.
export function helperCalls(root, files, { read = (f) => readFileSync(join(root, f), "utf8") } = {}) {
  const calls = [];
  for (const file of files) {
    const src = read(file);
    // A direct invocation(harness, "<name>") — a step said in another
    // harness's form (doctor's aboutHarness) — is held to the same rule, in
    // the files that import the helper. The two that define the helper and
    // its wrappers pass a `name` parameter through, and are skipped.
    const direct = !["scripts/harness.mjs", "scripts/lib.mjs"].includes(file) && /import\s*\{[^}]*\binvocation\b[^}]*\}\s*from\s*["']\.\/harness\.mjs["']/.test(src);
    stripComments(src).split("\n").forEach((line, k) => {
      if (direct) {
        for (const m of line.matchAll(/(?<![\w.])invocation\(([^;]*)/g)) {
          const lit = /^[^"'`]*?,\s*(["'`])([a-z0-9*-]+)\1/.exec(m[1]);
          calls.push({ file, line: k + 1, kind: /kind:\s*["']agents["']/.test(m[1]) ? "agents" : "commands", name: lit ? lit[2] : null, raw: m[1].slice(0, 60) });
        }
      }
      for (const m of line.matchAll(/(?<![\w.])(commandForm|roleForm)\(\s*([^,)\s]+)?/g)) {
        if (/^export function/.test(line.trim())) continue;
        const lit = m[2] && /^(["'`])([a-z0-9*-]+)\1$/.exec(m[2]);
        calls.push({ file, line: k + 1, kind: m[1] === "roleForm" ? "agents" : "commands", name: lit ? lit[2] : null, raw: m[2] || "" });
      }
    });
  }
  return calls;
}

// For each call, the harnesses on which the name it uses does not exist:
// the source must have it (commands/<name>.md, agents/<name>.md), and every
// emitting harness must have it in its own surface or — when that surface is
// rendered as skills — as the rendered skill in its committed tree.
export function unresolved(root, calls, { exists = (p) => existsSync(join(root, p)) } = {}) {
  const src = sourceHarness();
  const out = [];
  for (const c of calls) {
    if (c.name === null) { out.push({ ...c, harness: null, why: `the name is not a string literal (${c.raw || "nothing"})` }); continue; }
    if (c.name === "*") continue;
    const s = src.surfaces[c.kind];
    const srcPath = join(s.dir, s.file.replace("<name>", c.name));
    if (!exists(srcPath)) out.push({ ...c, harness: src.id, why: `no ${srcPath} in the source` });
    for (const m of loadHarnesses().values()) {
      if (!m.emit || m.source_layout) continue;
      const t = m.surfaces?.[c.kind] || {};
      if (t.supported !== false) continue; // the harness loads the source surface itself
      if (t.rendered_as !== "skill" || !t.rendered_name) { out.push({ ...c, harness: m.id, why: `${m.id} has no ${c.kind} surface and renders none` }); continue; }
      const skill = t.rendered_name.split("<name>").join(c.name);
      const rel = join(m.output_dir, "skills", skill, "SKILL.md");
      if (!exists(rel)) out.push({ ...c, harness: m.id, why: `${invocation(m, c.name, { kind: c.kind })} has no ${rel}` });
    }
  }
  return out;
}

// ─── Layer 3: what one harness's run must not carry ────────────────────

// The forms of every OTHER harness, plus — when the speaker is not the source
// harness — the source harness's UI words. Built from the manifests; the
// speaker's own forms are never in it. A product NAME is not refused: a finding
// about another harness in the same project ("…which Claude Code does not
// see…") names it rightly; what must not reach a harness is a command or an
// affordance it cannot use.
export function foreignPatterns(root, speakerId) {
  const src = sourceHarness();
  const pats = invocationPatterns(root).filter((p) => p.harness !== speakerId).map((p) => ({ ...p, what: `${p.harness} ${p.kind} form` }));
  if (speakerId !== src.id) {
    for (const { re } of uiWordPatterns(src)) pats.push({ harness: src.id, kind: "ui", what: `${src.id} UI word`, re });
  }
  return pats;
}

// An environment no harness has touched: every variable a manifest declares
// (detection, session markers, shared names, project and plugin roots, homes)
// and the three PROJECTSTORE_* identity names are dropped, so a test run from
// inside a live session cannot answer for the fixture.
export function hermeticEnv(extra = {}, base = process.env) {
  const drop = new Set(["PROJECTSTORE_HARNESS", "PROJECTSTORE_IDENTIFIED", "PROJECTSTORE_SHELL", "FORCE_COLOR", "NO_COLOR", "CI"]);
  for (const m of loadHarnesses().values()) {
    const r = m.runtime || {};
    for (const k of [...(r.detect_env || []), ...(r.session_env || []), ...(r.shared_env || []), r.project_dir_env, r.plugin_root_env, r.home_env]) if (k) drop.add(k);
  }
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!drop.has(k)) env[k] = v;
  return { ...env, ...extra };
}

// Text a run may carry although it matches: the session rules' one sentence
// that names the shared AGENTS.md block's form, so the model reads both forms
// as one role (generation spec, contract 18).
export const RUN_EXEMPT = [
  { phrase: /The `AGENTS\.md` block may name roles as `[^`]+`; that is the same role, called `[^`]+` here\./g, why: "the session rules' bridge to the shared block's form, by design" },
];

// A finding ABOUT another harness in the same project (doctor marks it
// `about` and opens its message with that harness's name) speaks that
// harness's forms and words on purpose: its steps happen there. Such findings
// are taken out before a run is scanned — exactly those, nothing more:
// - from doctor's JSON report, by their `about` field;
// - from any other output, by removing the messages that report marked,
//   verbatim: inside a hook's JSON strings, or in doctor's text. A hook prints
//   its whole output as one line, so a filter by line, or by a harness's name
//   anywhere in it, blanked the lot (the reviewer's re-pass, 2026-10-05).
export function aboutMessages(doctorJson, speakerId) {
  try { return JSON.parse(doctorJson).result.filter((f) => f.about && f.about !== speakerId).map((f) => f.message); } catch { return []; }
}

export function withoutAboutFindings(text, speakerId, about = []) {
  const t = String(text);
  const cut = (v) => about.reduce((acc, msg) => acc.split(msg).join(""), v);
  let parsed;
  try { parsed = JSON.parse(t); } catch { return cut(t); }
  if (parsed && Array.isArray(parsed.result)) return JSON.stringify({ ...parsed, result: parsed.result.filter((f) => !f.about || f.about === speakerId) }, null, 2);
  const deep = (v) => (typeof v === "string" ? cut(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return JSON.stringify(deep(parsed), null, 2);
}

export function foreignHits(text, patterns) {
  let t = String(text);
  for (const e of RUN_EXEMPT) t = t.replace(e.phrase, "");
  const hits = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    for (const m of t.matchAll(p.re)) hits.push({ text: m[0], what: p.what });
  }
  return hits;
}

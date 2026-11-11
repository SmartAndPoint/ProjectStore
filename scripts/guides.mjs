// projectstore — guides.mjs
//
// Authoring guides: one markdown file per artifact kind that the author reads
// before a draft and the critic checks after it. The package ships the
// defaults in scaffold/guides/<kind>.md; a vault may override one, whole, in
// <vault>/guides/<kind>.md. Resolved at every read, never cached and never
// copied into the project tree: an edit in Obsidian reaches the next reader.
// Normative: the ADR "One authoring guide per artifact kind, read by the
// author before the draft and by the critic after, overridable from the
// vault" (decisions 1-5) and SPEC-001 contract 12.
//
// A leaf: lib.mjs, harness.mjs and node built-ins only. The read side serves
// the `guide` verb and the MCP `guide` tool (read-verbs.mjs); eject is the one
// writer, reached only through the CLI's own handler (cli.mjs).

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot, parseFrontmatter, guideItems, linesOutsideFences, createFileExclusive } from "./lib.mjs";
import { LAYOUT } from "./harness.mjs";

// The five sections, read by name; English in every vault language.
export const GUIDE_SECTIONS = Object.freeze(["Lens", "Must", "Common mistakes", "Do not write", "Length"]);
const LIST_SECTIONS = new Set(["Must", "Common mistakes", "Do not write"]);
// A kind, or <kind>.<variant>. Checked before any path is built.
export const GUIDE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

export const guidesDir = (vault) => join(vault, LAYOUT.guides);
export const packageGuidesDir = (root = pluginRoot()) => join(root, "scaffold", "guides");

const usageError = (msg) => Object.assign(new Error(msg), { code: "USAGE" });

export function checkGuideName(name) {
  if (typeof name !== "string" || !GUIDE_NAME.test(name))
    throw usageError(`guide takes a kind such as \`spec\` or \`story.test\`, not "${name ?? ""}"`);
  return name;
}

// A file read that never throws: an iCloud placeholder, a directory named
// spec.md or a permission error is "unreadable", reported, not a crash.
function readText(p) {
  try {
    if (!statSync(p).isFile()) return { error: "not a file" };
    return { text: readFileSync(p, "utf8").replace(/\r\n/g, "\n") };
  } catch (e) {
    return { error: e && e.code === "ENOENT" ? "absent" : `unreadable (${e && e.code ? e.code : "error"})` };
  }
}

// The sections of a guide body: `## <name>` headings outside fences. A list
// section is its items; Lens and Length are their trimmed text. A section that
// is absent is null; a heading that is not one of the five is ignored.
function sectionsOf(body) {
  const raw = {};
  let cur = null;
  for (const line of linesOutsideFences(body)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = GUIDE_SECTIONS.includes(h[1]) ? h[1] : null;
      if (cur) raw[cur] = [];
      continue;
    }
    if (cur) raw[cur].push(line);
  }
  const sections = {};
  for (const s of GUIDE_SECTIONS) {
    if (!raw[s]) sections[s] = null;
    else if (LIST_SECTIONS.has(s)) sections[s] = guideItems(raw[s]);
    else sections[s] = raw[s].join("\n").trim() || null;
  }
  return { sections, raw };
}

const intOrNull = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isInteger(n) ? n : null;
};
const boolOrNull = (v) => (v === "true" ? true : v === "false" ? false : null);

// The parse rule (decision 1): frontmatter whose guide_for equals the file's
// name, and a ## Must with at least one item.
export function parseGuide(text, name) {
  if (!/^---\n/.test(text)) return { ok: false, reason: "no frontmatter" };
  const { data, body } = parseFrontmatter(text);
  if (data.guide_for !== name)
    return { ok: false, reason: `guide_for is "${data.guide_for ?? ""}", not "${name}"`, fm: data };
  const { sections, raw } = sectionsOf(body);
  if (!sections.Must || sections.Must.length === 0) return { ok: false, reason: "## Must has no item", fm: data };
  return { ok: true, fm: data, sections, raw, body };
}

// The candidates for a name, in decision 2's order: vault variant, package
// variant, vault base, package base. `source` keeps one side.
function candidates(name, { vault, root, source }) {
  const base = name.includes(".") ? name.split(".")[0] : null;
  const names = base ? [name, base] : [name];
  const out = [];
  for (const n of names) {
    if (vault && source !== "package") out.push({ name: n, source: "vault", path: join(guidesDir(vault), `${n}.md`) });
    if (source !== "vault") out.push({ name: n, source: "package", path: join(packageGuidesDir(root), `${n}.md`) });
  }
  return out;
}

// The resolved guide, or null when no candidate parses. Every vault file that
// exists and does not parse is a warning, and the next candidate is tried.
export function resolveGuide(name, { vault = null, root = pluginRoot(), source = null } = {}) {
  checkGuideName(name);
  const warnings = [];
  for (const c of candidates(name, { vault, root, source })) {
    const r = readText(c.path);
    if (r.error === "absent") continue;
    if (r.error) {
      if (c.source === "vault") warnings.push(`skipped ${LAYOUT.guides}/${c.name}.md: ${r.error}`);
      continue;
    }
    const g = parseGuide(r.text, c.name);
    if (!g.ok) {
      if (c.source === "vault") warnings.push(`skipped ${LAYOUT.guides}/${c.name}.md: ${g.reason}`);
      continue;
    }
    return {
      kind: name,
      resolved: c.name,
      source: c.source,
      path: c.path,
      guide_version: c.source === "package" ? intOrNull(g.fm.guide_version) : null,
      based_on: intOrNull(g.fm.based_on),
      default_review: boolOrNull(g.fm.default_review),
      sections: g.sections,
      warnings,
      text: r.text,
      raw: g.raw,
    };
  }
  return { kind: name, resolved: null, warnings };
}

// The names that have a guide on either side (for the "no guide" message).
export function guideKinds({ vault = null, root = pluginRoot() } = {}) {
  const names = new Set();
  const scan = (dir, side) => {
    let list;
    try {
      list = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of list) {
      if (!f.endsWith(".md") || f.startsWith(".")) continue;
      const n = f.slice(0, -3);
      if (!GUIDE_NAME.test(n)) continue;
      const r = readText(join(dir, f));
      if (side === "vault" && (r.error || !parseGuide(r.text, n).ok)) continue;
      names.add(n);
    }
  };
  scan(packageGuidesDir(root), "package");
  if (vault) scan(guidesDir(vault), "vault");
  return [...names].sort();
}

// The JSON result of the read (decision 3, plus default_review at the plan
// gate): the internals (text, raw) stay out.
export function guideResult(g) {
  return {
    kind: g.kind,
    source: g.source,
    path: g.path,
    guide_version: g.guide_version,
    based_on: g.based_on,
    default_review: g.default_review,
    sections: g.sections,
    warnings: g.warnings,
  };
}

// The text form: a header line, then the guide's body or one raw section.
export function renderGuide(g, section = null) {
  const head = `guide ${g.resolved} · source ${g.source} · ${g.path}\n`;
  if (!section) return head + "\n" + g.text.replace(/\n*$/, "\n");
  if (!g.raw[section]) return head + `\n(no ## ${section} in this guide)\n`;
  return head + `\n## ${section}\n` + g.raw[section].join("\n").replace(/\n*$/, "\n");
}

// ─── eject: the one writer ─────────────────────────────────────────────
//
// Copies a package guide into <vault>/guides/<name>.md with `based_on` set to
// its guide_version, create-only (decision 5). A plan first, so the preview
// and the write are the same thing.

export function planEject(name, { vault, root = pluginRoot() } = {}) {
  checkGuideName(name);
  const src = join(packageGuidesDir(root), `${name}.md`);
  const target = vault ? join(guidesDir(vault), `${name}.md`) : null;
  const refuse = (why) => ({ ok: false, name, target, refusal: why });
  if (!vault || !existsSync(vault) || !statSync(vault).isDirectory())
    return refuse("the binding names no vault directory to write the guide into");
  const r = readText(src);
  if (r.error) return refuse(`the package has no guide named "${name}" (eject copies a package guide)`);
  const dir = guidesDir(vault);
  if (existsSync(dir) && !statSync(dir).isDirectory())
    return refuse(`${LAYOUT.guides} exists in the vault and is not a folder`);
  if (existsSync(target)) return refuse(`${LAYOUT.guides}/${name}.md already exists; eject never overwrites it`);
  const version = intOrNull(parseFrontmatter(r.text).data.guide_version);
  const content = r.text.replace(/^(guide_version:.*)$/m, `$1\nbased_on: ${version}`);
  return { ok: true, name, target, content, based_on: version };
}

// `onWrite(path, before, after)`: the session's record of its vault writes
// (the record spec, contract 5), before absent. A throw from it is swallowed.
export function applyEject(plan, { onWrite = null } = {}) {
  if (!plan.ok) return { written: false };
  mkdirSync(join(plan.target, ".."), { recursive: true });
  // Create-only for real (lib.mjs's exclusive create): a file made meanwhile
  // is never replaced.
  if (!createFileExclusive(plan.target, plan.content))
    return { written: false, refusal: `${plan.target} appeared meanwhile` };
  if (onWrite) {
    try {
      onWrite(plan.target, null, plan.content);
    } catch {}
  }
  return { written: true };
}

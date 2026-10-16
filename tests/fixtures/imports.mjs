// projectstore — test fixture: the modules a source file imports, read as text.
// Some tests pin a module's import graph without loading it. Prettier wraps an
// import longer than 120 columns across lines, and a one-line pattern would drop
// it without a word; this one spans lines and stops at the statement's `;`.
// Static imports and `export … from` re-exports; a side-effect import
// (`import "x";`) and a dynamic import() stay each test's own check, except in
// closure() below, which reads every class.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stripComments } from "./vocabulary.mjs";

const IMPORT_FROM = /^(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)";/gm;

export const importSpecifiers = (src) => [...String(src).matchAll(IMPORT_FROM)].map((m) => m[1]);

// ─── A module's closure (the story "The MCP server's entry reaches no install
// verb…", PS-DIRECTORY, decision 1) ─────────────────────────────────────────
//
// A fence over static imports alone passes on 0.30.5 already: the hooks reach
// models.mjs statically, but the MCP server reaches the installer only through
// cli.mjs's import() calls and its VERBS rows. So a closure here has three
// import classes, followed transitively:
//   - static imports and re-exports, in either quote, with or without the
//     closing `;` (the band module is written single-quoted and
//     semicolon-free), and a side-effect `import "./x.mjs";`;
//   - literal import() calls (dynamicSpecifiers);
//   - the module strings of a verb table (verbModuleSpecifiers): each row's
//     `module: "./x.mjs"` counts as an import of the runner that dispatches
//     through it. By default every module counts the strings in its own code,
//     which on 0.30.5 is cli.mjs alone, the table and its runner in one file;
//     since the table moved to verbs.mjs, the MCP fence passes a `dispatch`
//     that says which runner serves which rows.
// All three read the code with its comments blanked, so a comment that names
// an import() is not an edge. A string that spells one still is: the safe
// direction for a fence. And the blanking is checked (hiddenByComments): a
// `//` inside a string blanks the rest of its line, which could hide a call.

// Either quote, with or without the `;`. Neither a quote nor a `;` can sit
// before `from`, so a match never runs from one statement into a string of
// the next. `import type` is erased before the module runs (its target is a
// .d.ts), so it is no edge.
const IMPORT_FROM_ANY = /^(?:import|export)\s(?!type\s)[^;'"]*?\sfrom\s+(["'])([^"'\n]+)\1/gm;
const IMPORT_BARE = /^import\s*(?:"([^"\n]+)"|'([^'\n]+)')/gm;

// import("x"), import('x') or import(`x`) without an interpolation. A dotted
// or word-prefixed `import(` (a method named import) is not one.
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`$\n]+)`)\s*[,)]/g;
const ANY_DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g;

// A verb table row's `module: "./x.mjs"` or `module: './x.mjs'`; `module:
// null` names nothing.
const VERB_MODULE = /(?<![\w$.])module:\s*(["'])(\.{1,2}\/[^"'\n]+)\1/g;

export const dynamicSpecifiers = (src) =>
  [...stripComments(String(src)).matchAll(DYNAMIC_IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]);

// The import() calls whose argument is not a literal, as their count: a
// closure cannot follow them, so a fence that meets one must say so.
export const opaqueDynamicImports = (src) =>
  [...stripComments(String(src)).matchAll(ANY_DYNAMIC_IMPORT)].length - dynamicSpecifiers(src).length;

export const verbModuleSpecifiers = (src) => [...stripComments(String(src)).matchAll(VERB_MODULE)].map((m) => m[2]);

// Whether a module's code reaches fetch: a call (`fetch(`, a dotted
// `globalThis.fetch(`), the global taken as a value (`globalThis.fetch`), an
// indirect call (`fetch.call(`, `.apply(`, `.bind(`) or a computed name
// (`["fetch"]`). A comment that says "the shell fetch (contract 19)" does not.
const FETCH =
  /\bfetch\s*\(|\bglobalThis\s*\.\s*fetch\b|\bfetch\s*\.\s*(?:call|apply|bind)\s*\(|\[\s*(["'`])fetch\1\s*\]/;
export const callsFetch = (src) => FETCH.test(stripComments(String(src)));

// What the blanking might hide: a fetch( or an import( on a line that does not
// open as a comment. hiddenByComments(src) is how many more of those the raw
// text holds than the blanked code — 0 unless a `//` inside a string (or a
// comment closed mid-line) blanked code that calls one.
const HIDDEN = /\bfetch\s*\(|(?<![\w$.])import\s*\(/g;
export function hiddenByComments(src) {
  const raw = String(src)
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
    .join("\n");
  return Math.max(0, [...raw.matchAll(HIDDEN)].length - [...stripComments(String(src)).matchAll(HIDDEN)].length);
}

const toPosix = (p) => p.split(sep).join("/");

const staticSpecifiers = (code) => [
  ...importSpecifiers(code),
  ...[...code.matchAll(IMPORT_FROM_ANY)].map((m) => m[2]),
  ...[...code.matchAll(IMPORT_BARE)].map((m) => m[1] ?? m[2]),
];

// Every specifier a module names, of the first two classes: what the walk
// follows and what it skips (a builtin, a bare package).
const specifiersOf = (src) => [...new Set([...staticSpecifiers(stripComments(src)), ...dynamicSpecifiers(src)])];

// closure(entry, { root, dispatch }) → the repository files `entry` reaches,
// sorted, as root-relative paths with `/` separators, the entry among them.
//   entry     a root-relative path (or an absolute one under root)
//   dispatch  (rel, src) → the verb-table module strings `rel` dispatches
//             through. The default counts every one in its own code. A runner
//             that dispatches only some rows of a table another module holds
//             passes those rows' strings for itself and none for the holder.
// Only relative specifiers are followed: `node:` builtins and bare packages
// (the band module's host import) are outside the repository, and
// networkImports() below reads them. A relative one that names no file
// throws, and so does a module whose comment blanking hid a call: an edge the
// walk cannot see would let a fence pass by not looking.
export function closure(entry, { root, dispatch = (rel, src) => verbModuleSpecifiers(src) } = {}) {
  if (!root) throw new Error("closure: root is required");
  const toRel = (abs) => toPosix(relative(root, abs));
  const seen = new Set();
  const walk = (abs) => {
    const rel = toRel(abs);
    if (seen.has(rel)) return;
    if (!existsSync(abs)) throw new Error(`closure: ${rel} is imported but does not exist`);
    seen.add(rel);
    const src = readFileSync(abs, "utf8");
    if (hiddenByComments(src) > 0) throw new Error(`closure: comment stripping hid code in ${rel}`);
    const specs = [...specifiersOf(src), ...dispatch(rel, src)];
    for (const s of specs) if (s.startsWith("./") || s.startsWith("../")) walk(resolve(dirname(abs), s));
  };
  walk(resolve(root, entry));
  return [...seen].sort();
}

// The network modules a fence refuses among the specifiers a closure skips:
// node's sockets and HTTP clients, bare or `node:`-prefixed, and undici (the
// package behind node's fetch).
export const NETWORK_MODULE = /^(?:(?:node:)?(?:http|https|http2|net|tls|dgram)|undici)(?:\/.*)?$/;

// networkImports(files, { root }) → `<file> imports <specifier>` for each
// network module one of `files` (a closure) imports, statically or by a
// literal import().
export function networkImports(files, { root }) {
  return files.flatMap((f) =>
    specifiersOf(readFileSync(join(root, f), "utf8"))
      .filter((s) => NETWORK_MODULE.test(s))
      .map((s) => `${f} imports ${s}`),
  );
}

// The entries a hooks.json registers, as root-relative paths: the file each
// command runs under the plugin-root placeholder, quoted or not (the story
// "Every hook command quotes its plugin root…", PS-DIRECTORY), and each
// in-process module, relative to the hooks.json's own folder.
export function hookEntries(root, { placeholder, file = join("hooks", "hooks.json") } = {}) {
  if (!placeholder) throw new Error("hookEntries: placeholder is required");
  const reg = JSON.parse(readFileSync(join(root, file), "utf8"));
  const lead = `${placeholder}/`;
  const commands = Object.values(reg.hooks || {}).flatMap((entries) =>
    entries.flatMap((e) => (e.hooks || []).map((h) => h.command || "")),
  );
  const files = commands.map((c) => {
    const at = c.indexOf(lead);
    if (at < 0) throw new Error(`hookEntries: "${c}" runs no file under ${placeholder}`);
    // The path ends at the closing quote, or at the first space when unquoted.
    return c.slice(at + lead.length).split(/["\s]/)[0];
  });
  const modules = (reg.modules || []).map((m) => toPosix(join(dirname(file), m)));
  return [...new Set([...files, ...modules])];
}

// The install family, as root-relative paths: the installer and its split
// (every scripts/install*.mjs, so a new leaf joins without an edit here), the
// shell fetch that runs `npm install` and the runner it spawns through, the
// release fetch, and setup. What a hook or the MCP server must never reach.
export function installFamily(root) {
  const split = readdirSync(join(root, "scripts"))
    .filter((f) => /^install.*\.mjs$/.test(f))
    .map((f) => `scripts/${f}`);
  const named = ["fetch-shell.mjs", "run-host.mjs", "convergence.mjs", "setup.mjs"].map((f) => `scripts/${f}`);
  return [...new Set([...split, ...named])].sort();
}

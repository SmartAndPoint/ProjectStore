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
//   - static imports and re-exports (importSpecifiers above, the
//     single-quoted, semicolon-free form the band module is written in, and
//     a side-effect `import "./x.mjs";`);
//   - literal import() calls (dynamicSpecifiers);
//   - the module strings of a verb table (verbModuleSpecifiers): each row's
//     `module: "./x.mjs"` counts as an import of the runner that dispatches
//     through it. By default every module counts the strings in its own code,
//     which on 0.30.5 is cli.mjs alone, the table and its runner in one file.
// All three read the code with its comments blanked, so a comment that names
// an import() is not an edge. A string that spells one still is: the safe
// direction for a fence.

// The band module (hooks/band.tsx) imports with single quotes and no `;`.
// Neither a quote nor a `;` can sit inside the match, so it never runs from
// one statement into a string of the next. `import type` is erased before the
// module runs (its target is a .d.ts), so it is no edge.
const IMPORT_FROM_SINGLE = /^(?:import|export)\s(?!type\s)[^;'"]*?\sfrom\s+'([^']+)'/gm;
const IMPORT_BARE = /^import\s*(?:"([^"\n]+)"|'([^'\n]+)')/gm;

// import("x"), import('x') or import(`x`) without an interpolation. A dotted
// or word-prefixed `import(` (a method named import) is not one.
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`$\n]+)`)\s*[,)]/g;
const ANY_DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g;

// A verb table row's `module: "./x.mjs"`; `module: null` names nothing.
const VERB_MODULE = /(?<![\w$.])module:\s*"(\.{1,2}\/[^"]+)"/g;

export const dynamicSpecifiers = (src) =>
  [...stripComments(String(src)).matchAll(DYNAMIC_IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]);

// The import() calls whose argument is not a literal, as their count: a
// closure cannot follow them, so a fence that meets one must say so.
export const opaqueDynamicImports = (src) =>
  [...stripComments(String(src)).matchAll(ANY_DYNAMIC_IMPORT)].length - dynamicSpecifiers(src).length;

export const verbModuleSpecifiers = (src) => [...stripComments(String(src)).matchAll(VERB_MODULE)].map((m) => m[1]);

// Whether a module's code calls fetch: a comment that says "the shell fetch
// (contract 19)" does not, a dotted `globalThis.fetch(` does.
export const callsFetch = (src) => /\bfetch\s*\(/.test(stripComments(String(src)));

const toPosix = (p) => p.split(sep).join("/");

const staticSpecifiers = (code) => [
  ...importSpecifiers(code),
  ...[...code.matchAll(IMPORT_FROM_SINGLE)].map((m) => m[1]),
  ...[...code.matchAll(IMPORT_BARE)].map((m) => m[1] ?? m[2]),
];

// closure(entry, { root, dispatch }) → the repository files `entry` reaches,
// sorted, as root-relative paths with `/` separators, the entry among them.
//   entry     a root-relative path (or an absolute one under root)
//   dispatch  (rel, src) → the verb-table module strings `rel` dispatches
//             through. The default counts every one in its own code. A runner
//             that dispatches only some rows of a table another module holds
//             passes those rows' strings for itself and none for the holder.
// Only relative specifiers are followed: `node:` builtins and bare packages
// (the band module's host import) are outside the repository. A relative one
// that names no file throws: an edge the walk cannot follow would let a fence
// pass by not looking.
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
    const code = stripComments(src);
    const specs = [...staticSpecifiers(code), ...dynamicSpecifiers(src), ...dispatch(rel, src)];
    for (const s of specs) if (s.startsWith("./") || s.startsWith("../")) walk(resolve(dirname(abs), s));
  };
  walk(resolve(root, entry));
  return [...seen].sort();
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

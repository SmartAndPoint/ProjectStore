// projectstore — test fixture: the modules a source file imports, read as text.
// Some tests pin a module's import graph without loading it. Prettier wraps an
// import longer than 120 columns across lines, and a one-line pattern would drop
// it without a word; this one spans lines and stops at the statement's `;`.
// Static imports and `export … from` re-exports; a side-effect import
// (`import "x";`) and a dynamic import() stay each test's own check.

const IMPORT_FROM = /^(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)";/gm;

export const importSpecifiers = (src) => [...String(src).matchAll(IMPORT_FROM)].map((m) => m[1]);

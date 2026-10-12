// projectstore — tests/fixtures/markdown.mjs: how the tests read Markdown and
// command lines, shared by the site check (tests/site.test.mjs) and the lint of
// user-facing text (tests/user-text.test.mjs; the story "User-facing text says
// where to run and names no project path and no shell", Technical Notes,
// "Shared helpers, lint and format").
//
//   markdownLines(md)  → each line, its number, the heading it is or whether a fence holds it
//   cut(line)          → a command line trimmed and cut at its first " #" comment
//   unprompt(line)     → a command line without the shell prompt in front of it
//   npxCommand(line)   → { command, verb, packages } past npx's own options, or null
//
// The helpers live in tests/, not in scripts/: a file there ships, and the
// runtime vocabulary lint would read their command literals.

// Each line with the heading it is, or whether a fence holds it, and its
// number in the file (1-based). A fence opens with three backticks or tildes
// and closes with a bare run of the same character at least as long; a line
// inside one is never a heading, and the fence's own lines are not yielded.
export function* markdownLines(md) {
  let fence = null;
  for (const [i, line] of md.split("\n").entries()) {
    const n = i + 1;
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      else yield { line, n, fenced: true, heading: null };
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    yield { line, n, fenced: false, heading: h ? { level: h[1].length, text: h[2] } : null };
  }
}

// A command line as README and the site are compared: trimmed, and cut at
// the first " #" (README's comments on a fenced line).
export const cut = (line) => {
  const t = line.trim();
  const i = t.indexOf(" #");
  return (i === -1 ? t : t.slice(0, i)).trim();
};

// A shell prompt in front of a command is not part of it.
export const unprompt = (line) => line.trim().replace(/^[$%>]\s+/, "");

// npx's own options come before the command: `npx -y …`, `npx --yes -p
// <pkg>@<v> <bin> …`. Returns the command (a package or bin name, an
// @<version> allowed), its first argument, and the packages -p names. Leading
// NAME=value assignments are the shell's, not npx's: README's registry-mirror
// line, `npm_config_registry=… npx projectstore@<version> setup`, is an npx line.
const NPX_VALUE_OPTIONS = new Set([
  "-p",
  "--package",
  "--registry",
  "--cache",
  "--userconfig",
  "-c",
  "--call",
  "-w",
  "--workspace",
  "--node-options",
  "--script-shell",
]);
// The package runners the install runbook observed running setup: npx, bunx,
// `pnpm dlx`, and deno's `npm:` specifier. Each is read as npx is: its own
// options skipped, then the package and its verb.
export function npxCommand(line) {
  const toks = unprompt(line).split(/\s+/);
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
  let i;
  if (toks[0] === "npx" || toks[0] === "bunx") i = 1;
  else if ((toks[0] === "pnpm" && toks[1] === "dlx") || (toks[0] === "deno" && toks[1] === "run")) i = 2;
  else return null;
  const deno = toks[0] === "deno";
  const packages = [];
  for (; i < toks.length && toks[i].startsWith("-"); i++) {
    const eq = toks[i].indexOf("=");
    const name = eq === -1 ? toks[i] : toks[i].slice(0, eq);
    if (!NPX_VALUE_OPTIONS.has(name)) continue;
    const value = eq === -1 ? toks[++i] : toks[i].slice(eq + 1);
    if (name === "-p" || name === "--package") packages.push((value || "").replace(/^["']|["']$/g, ""));
  }
  if (i >= toks.length) return null;
  // deno runs a package only through its npm: specifier; anything else is a script.
  if (deno && !toks[i].startsWith("npm:")) return null;
  return { command: deno ? toks[i].slice(4) : toks[i], verb: toks[i + 1] ?? null, packages };
}

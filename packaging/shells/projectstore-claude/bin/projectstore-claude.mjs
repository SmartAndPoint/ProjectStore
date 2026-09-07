#!/usr/bin/env node
// projectstore-claude — the Claude Code distribution shell of projectstore.
// RENDERED by packaging/shells.mjs from its template: edit the template, then
// `node packaging/shells.mjs --write`. A hand edit here fails --check.
//
// A shell is a bin and a pin, never logic (the layout spec, contract 10): this
// file locates the core the tarball bundles and execs it with
// `--harness claude-code` inserted after a verb that takes it. Every other
// argument passes through, so `projectstore-claude <verb> …` is exactly
// `projectstore <verb> --harness claude-code …` — the same preview, the
// same files, the same exit code. Naming the shell is the confirmation the
// core's install gate asks for, exactly as naming --harness is.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL = "projectstore-claude";
const HARNESS = "claude-code";
// The verbs of the core's table that declare --harness (rendered from
// scripts/cli.mjs; the packaging test pins it). Any other verb — doctor,
// status, search, --version — passes through untouched: the core refuses an
// option a verb does not declare, so a blanket insert would break `doctor`.
const HARNESS_VERBS = new Set(["plan","install","uninstall","upgrade","agents"]);

// The bundled core, by path — never by package resolution: a hoisted or global
// copy at another version is exactly the pairing the pin exists to prevent,
// and the core's file layout is not an API (the shells ADR, decision 5).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [
  resolve(root, "node_modules", "projectstore", "bin", "projectstore.mjs"), // bundled — the release shape
  resolve(root, "core", "bin", "projectstore.mjs"), // vendored — the shells ADR's fallback
];

// Inserts --harness after the verb (the first positional) when that verb takes
// it; refuses another harness; never duplicates one already given. Scans up to
// a bare "--". A verb that is not the first positional (`--project x install`)
// is left alone: the core then asks for --harness itself, a usage error, never
// a wrong write.
function fixHarness(argv) {
  const stop = argv.indexOf("--");
  const scan = stop === -1 ? argv : argv.slice(0, stop);
  const given = [];
  const dangling = { error: `\`--harness\` is given without a value — this shell fixes it to ${HARNESS}; drop the flag` };
  for (let i = 0; i < scan.length; i++) {
    if (scan[i] === "--harness") {
      const v = scan[i + 1];
      if (v === undefined || v.startsWith("-")) return dangling;
      given.push(v); i++;
    } else if (scan[i].startsWith("--harness=")) {
      const v = scan[i].slice("--harness=".length);
      if (!v) return dangling;
      given.push(v);
    }
  }
  const other = given.find((g) => g !== HARNESS);
  if (other !== undefined) return { error: `installs for ${HARNESS} only — \`--harness ${other}\` names another harness. Run that harness's shell, or the core: npx projectstore <verb> --harness ${other} …` };
  if (given.length) return { argv }; // named already: pass through, never twice (the core's option repeats)
  const at = scan.findIndex((a) => !a.startsWith("-"));
  if (at === -1 || !HARNESS_VERBS.has(scan[at])) return { argv };
  return { argv: [...argv.slice(0, at + 1), "--harness", HARNESS, ...argv.slice(at + 1)] };
}

const core = CANDIDATES.find((p) => existsSync(p));
if (!core) {
  process.stderr.write(`${SHELL}: the bundled core is missing — looked at:\n${CANDIDATES.map((c) => "  " + c).join("\n")}\n`);
  process.exitCode = 2;
} else {
  const fixed = fixHarness(process.argv.slice(2));
  if (fixed.error) {
    process.stderr.write(`${SHELL}: ${fixed.error}\n`);
    process.exitCode = 2;
  } else {
    // stdio inherited: the core's install gate asks on a terminal and refuses
    // without one, so the child must see the real stdin and stdout. No
    // timeout — the child waits on a human at the preview. exitCode, not
    // exit(): the core's own bin says why (a pending write on a pipe).
    const r = spawnSync(process.execPath, [core, ...fixed.argv], { stdio: "inherit" });
    if (r.error) process.stderr.write(`${SHELL}: ${r.error.message}\n`);
    // A signal is relayed the shell way (128 + its number): Ctrl-C at the
    // preview is 130 here as it would be on the core itself.
    process.exitCode = r.status ?? (r.signal ? 128 + (osConstants.signals[r.signal] || 0) : 2);
  }
}

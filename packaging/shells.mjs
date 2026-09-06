#!/usr/bin/env node
// projectstore — shells.mjs (PS-HARNESS: "Distribution shells as the one
// install entry point: projectstore-claude first, the guard on every package")
//
//   node packaging/shells.mjs                    list the shells: name, harness, private, version, pin
//   node packaging/shells.mjs --list --json      the publishable (non-private) names as a JSON array — release.yml's matrix
//   node packaging/shells.mjs --write            render every shell's package.json and bin from SHELLS and the core's package.json
//   node packaging/shells.mjs --check            the committed package.json and bin equal their render (JSON; exit 1 on drift)
//   node packaging/shells.mjs --build [--only <name>] [--out <dir>]
//                                                pack the core, install it into a scratch copy of each shell, pack the shell,
//                                                compare with packaging/shells/<name>/packlist.json; --out keeps the tarballs
//
// The layout ADR's decision 6 and the shells ADR: every harness installs
// through `npx projectstore-<shell> install --project <dir>` — a shell that
// pins the core at exactly its own version, BUNDLES it (the tarball carries
// node_modules/projectstore/, so no host and no registry ever pairs the shell
// with another core) and fixes --harness. A shell is a bin and a pin, never
// logic (the layout spec, contract 10): the bin locates the bundled core and
// execs it. The shell's name is data, not `projectstore-<harness id>` — the
// id is `claude-code` and the reserved, published name is `projectstore-claude`
// — so the mapping lives here and in the manifest's `install.shell`.
//
// Rendered, then committed: package.json and the bin are written by --write
// and --check fails when a hand edit drifts from the render (the pin, the
// bin's verb set). The README is hand-written. The packlist fixture is written
// by `npm run packlist` (scripts/version-guard.mjs --write-packlist), which
// imports this module lazily: scripts/ ships, packaging/ does not.
//
// The build installs the core from the core's OWN pack tarball, never from the
// registry: at release time the registry copy is seconds old or not there yet.
// `--no-save` keeps the committed "=<version>" pin as written (npm would
// rewrite it to file:…). Measured 2026-09-06 (npm 11.19.0, node 26.8.1): the
// pin survives, no lockfile is written, `npm pack --json` reports
// bundled: ["projectstore"] and lists node_modules/projectstore/** — and a
// shell packed WITHOUT node_modules/ exits 0 with three files and
// bundled: [], which is why the build asserts `bundled` before comparing.
//
// Nothing here ships inside `projectstore`: `packaging/` is not on the root
// package.json's files allowlist, and tests/packaging.test.mjs keeps it so.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const SHELLS_DIR = "packaging/shells";
export const CORE = "projectstore";

// One row per harness that installs from npm. `private` shells are rendered
// and guarded but never published: their plugin roots arrive with the stories
// named in `plugin_root`, and until then the release matrix does not list them.
export const SHELLS = Object.freeze([
  Object.freeze({
    name: "projectstore-claude",
    harness: "claude-code",
    display: "Claude Code",
    private: false,
    plugin_root: null, // the core IS Claude Code's plugin root; this shell is the installer only
    description: "Installs projectstore for Claude Code from npm: the core pinned and bundled, the harness fixed — npx projectstore-claude install --project \"$PWD\".",
  }),
  Object.freeze({
    name: "projectstore-codex",
    harness: "codex",
    display: "Codex",
    private: true,
    plugin_root: "rendered by roadmap B5 (the Codex plugin root: .codex-plugin/plugin.json, hooks/, skills/, .mcp.json)",
    description: "Installs projectstore for Codex from npm: the core pinned and bundled, the harness fixed. Not published until its plugin root is rendered.",
  }),
  Object.freeze({
    name: "projectstore-opencode",
    harness: "opencode",
    display: "opencode",
    private: true,
    plugin_root: "rendered by roadmap C4 (the opencode plugin entry point and the rendered adapters/opencode/ surfaces)",
    description: "Installs projectstore for opencode from npm: the core pinned and bundled, the harness fixed. Not published until its plugin root is rendered.",
  }),
]);

export const shellDir = (name, root = ROOT) => resolve(root, SHELLS_DIR, name);
export const shellPacklistPath = (name) => `${SHELLS_DIR}/${name}/packlist.json`;
export const publishable = () => SHELLS.filter((s) => !s.private).map((s) => s.name);
export const shellFor = (harnessId) => SHELLS.find((s) => s.harness === harnessId) || null;

export function corePackage(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

// The verbs of the core's table that declare --harness. Computed from the
// table, never copied: a verb that gains the option re-renders every bin.
export async function harnessVerbs(root = ROOT) {
  const { VERBS } = await import(pathToFileURL(resolve(root, "scripts", "cli.mjs")).href);
  return VERBS.filter((v) => (v.options || []).some((o) => o.name === "harness")).map((v) => v.verb);
}

// The shell's package.json, from the core's: the identity fields are copied so
// they never drift, the pin is exact and the core is bundled (the shells ADR
// decision 2), the bin is the only code, and nothing else ships.
export function renderShellPackageJson(shell, core) {
  const pkg = {
    name: shell.name,
    version: core.version,
    ...(shell.private ? { private: true } : {}),
    description: shell.description,
    keywords: ["projectstore", "installer", shell.harness, "project-management", "adr", "markdown", "agentic"],
    homepage: core.homepage,
    bugs: core.bugs,
    repository: core.repository,
    license: core.license,
    author: core.author,
    type: "module",
    engines: core.engines,
    bin: { [shell.name]: `bin/${shell.name}.mjs` },
    files: ["bin/", "README.md"],
    dependencies: { [CORE]: `=${core.version}` },
    bundleDependencies: [CORE],
    publishConfig: { access: "public" },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

// The bin. One template for every shell; only the two constants differ.
export function renderShellBin(shell, verbs) {
  return `#!/usr/bin/env node
// ${shell.name} — the ${shell.display} distribution shell of projectstore.
// RENDERED by packaging/shells.mjs from its template: edit the template, then
// \`node packaging/shells.mjs --write\`. A hand edit here fails --check.
//
// A shell is a bin and a pin, never logic (the layout spec, contract 10): this
// file locates the core the tarball bundles and execs it with
// \`--harness ${shell.harness}\` inserted after a verb that takes it. Every other
// argument passes through, so \`${shell.name} <verb> …\` is exactly
// \`projectstore <verb> --harness ${shell.harness} …\` — the same preview, the
// same files, the same exit code. Naming the shell is the confirmation the
// core's install gate asks for, exactly as naming --harness is.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL = ${JSON.stringify(shell.name)};
const HARNESS = ${JSON.stringify(shell.harness)};
// The verbs of the core's table that declare --harness (rendered from
// scripts/cli.mjs; the packaging test pins it). Any other verb — doctor,
// status, search, --version — passes through untouched: the core refuses an
// option a verb does not declare, so a blanket insert would break \`doctor\`.
const HARNESS_VERBS = new Set(${JSON.stringify(verbs)});

// The bundled core, by path — never by package resolution: a hoisted or global
// copy at another version is exactly the pairing the pin exists to prevent,
// and the core's file layout is not an API (the shells ADR, decision 5).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [
  resolve(root, "node_modules", ${JSON.stringify(CORE)}, "bin", "projectstore.mjs"), // bundled — the release shape
  resolve(root, "core", "bin", "projectstore.mjs"), // vendored — the shells ADR's fallback
];

// Inserts --harness after the verb (the first positional) when that verb takes
// it; refuses another harness; never duplicates one already given. Scans up to
// a bare "--". A verb that is not the first positional (\`--project x install\`)
// is left alone: the core then asks for --harness itself, a usage error, never
// a wrong write.
function fixHarness(argv) {
  const stop = argv.indexOf("--");
  const scan = stop === -1 ? argv : argv.slice(0, stop);
  const given = [];
  const dangling = { error: \`\\\`--harness\\\` is given without a value — this shell fixes it to \${HARNESS}; drop the flag\` };
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
  if (other !== undefined) return { error: \`installs for \${HARNESS} only — \\\`--harness \${other}\\\` names another harness. Run that harness's shell, or the core: npx projectstore <verb> --harness \${other} …\` };
  if (given.length) return { argv }; // named already: pass through, never twice (the core's option repeats)
  const at = scan.findIndex((a) => !a.startsWith("-"));
  if (at === -1 || !HARNESS_VERBS.has(scan[at])) return { argv };
  return { argv: [...argv.slice(0, at + 1), "--harness", HARNESS, ...argv.slice(at + 1)] };
}

const core = CANDIDATES.find((p) => existsSync(p));
if (!core) {
  process.stderr.write(\`\${SHELL}: the bundled core is missing — looked at:\\n\${CANDIDATES.map((c) => "  " + c).join("\\n")}\\n\`);
  process.exitCode = 2;
} else {
  const fixed = fixHarness(process.argv.slice(2));
  if (fixed.error) {
    process.stderr.write(\`\${SHELL}: \${fixed.error}\\n\`);
    process.exitCode = 2;
  } else {
    // stdio inherited: the core's install gate asks on a terminal and refuses
    // without one, so the child must see the real stdin and stdout. No
    // timeout — the child waits on a human at the preview. exitCode, not
    // exit(): the core's own bin says why (a pending write on a pipe).
    const r = spawnSync(process.execPath, [core, ...fixed.argv], { stdio: "inherit" });
    if (r.error) process.stderr.write(\`\${SHELL}: \${r.error.message}\\n\`);
    // A signal is relayed the shell way (128 + its number): Ctrl-C at the
    // preview is 130 here as it would be on the core itself.
    process.exitCode = r.status ?? (r.signal ? 128 + (osConstants.signals[r.signal] || 0) : 2);
  }
}
`;
}

export function renderShell(shell, { root = ROOT, verbs }) {
  const core = corePackage(root);
  return {
    "package.json": renderShellPackageJson(shell, core),
    [`bin/${shell.name}.mjs`]: renderShellBin(shell, verbs),
  };
}

// --write: every shell's rendered files, in place.
export async function writeShells(root = ROOT) {
  const verbs = await harnessVerbs(root);
  const wrote = [];
  for (const s of SHELLS) {
    const dir = shellDir(s.name, root);
    mkdirSync(join(dir, "bin"), { recursive: true });
    for (const [rel, text] of Object.entries(renderShell(s, { root, verbs }))) {
      writeFileSync(join(dir, rel), text);
      wrote.push(`${SHELLS_DIR}/${s.name}/${rel}`);
    }
  }
  return { ok: true, wrote, verbs };
}

// --check: the committed files equal their render. Pure over the tree.
export async function checkShells(root = ROOT) {
  const verbs = await harnessVerbs(root);
  const shells = [];
  let ok = true;
  for (const s of SHELLS) {
    const dir = shellDir(s.name, root);
    const row = { name: s.name, private: s.private, files: {} };
    for (const [rel, text] of Object.entries(renderShell(s, { root, verbs }))) {
      const p = join(dir, rel);
      const state = !existsSync(p) ? "missing" : readFileSync(p, "utf8") === text ? "equal" : "drift";
      row.files[rel] = state;
      if (state !== "equal") ok = false;
    }
    for (const rel of ["README.md"]) {
      const state = existsSync(join(dir, rel)) ? "present" : "missing";
      row.files[rel] = state;
      if (state === "missing") ok = false;
    }
    shells.push(row);
  }
  return { ok, shells, hint: ok ? undefined : "run `node packaging/shells.mjs --write` (a README is hand-written)" };
}

// The core's own pack tarball — the only source a shell is ever built from.
// `dest` is the caller's to keep or remove; buildShells owns its own.
export function packCore({ root = ROOT, dest = mkdtempSync(join(tmpdir(), "ps-core-")) } = {}) {
  const r = spawnSync("npm", ["pack", "--pack-destination", dest, "--json", "--loglevel=error"], { cwd: root, encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) return { error: `npm pack (the core) failed: ${r.stderr?.trim()}` };
  try {
    const [p] = JSON.parse(r.stdout);
    return { tgz: resolve(dest, p.filename), version: p.version, files: p.files.map((f) => f.path).sort() };
  } catch (e) {
    return { error: `npm pack output unparseable: ${e.message}` };
  }
}

// Build one shell in a scratch copy: install the core's tarball, pack, and
// report the listing. Never in place — a dirty working tree during a release
// is a hazard nobody needs. `{error}` on any failure, like currentPacklist.
// `scratch` is the caller's to keep or remove (buildShells owns its own): the
// built directory is what a publish-from-directory fallback needs.
export function buildShell(name, { coreTgz, root = ROOT, out = null, scratch = mkdtempSync(join(tmpdir(), "ps-shell-")) } = {}) {
  const shell = SHELLS.find((s) => s.name === name);
  if (!shell) return { error: `no shell named ${name} — known: ${SHELLS.map((s) => s.name).join(", ")}` };
  if (!coreTgz || !existsSync(coreTgz)) return { error: `the core's tarball is missing: ${coreTgz}` };
  const src = shellDir(name, root);
  if (!existsSync(join(src, "package.json"))) return { error: `${SHELLS_DIR}/${name}/package.json is missing — run \`node packaging/shells.mjs --write\`` };
  const dst = join(scratch, name);
  cpSync(src, dst, { recursive: true, filter: (p) => { const b = basename(p); return b !== "node_modules" && b !== "packlist.json"; } });
  const before = readFileSync(join(dst, "package.json"), "utf8");
  const inst = spawnSync("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", coreTgz], { cwd: dst, encoding: "utf8", timeout: 180000 });
  if (inst.status !== 0) return { error: `npm install of the core into ${name} failed: ${inst.stderr?.trim()}` };
  if (readFileSync(join(dst, "package.json"), "utf8") !== before) return { error: `${name}: npm install rewrote package.json — the "=<version>" pin must survive the build (--no-save)` };
  const dry = spawnSync("npm", ["pack", "--dry-run", "--json", "--loglevel=error"], { cwd: dst, encoding: "utf8", timeout: 120000 });
  if (dry.status !== 0) return { error: `npm pack --dry-run (${name}) failed: ${dry.stderr?.trim()}` };
  let pkg;
  try { [pkg] = JSON.parse(dry.stdout); } catch (e) { return { error: `npm pack output unparseable (${name}): ${e.message}` }; }
  const bundled = pkg.bundled || [];
  if (!bundled.includes(CORE)) return { error: `${name}: the pack bundles ${JSON.stringify(bundled)} — node_modules/${CORE} is not in the tree, so the tarball would carry no core (a shell packed without its install exits 0 and ships three files)` };
  const files = pkg.files.map((f) => f.path).sort();
  let tgz = null;
  if (out) {
    mkdirSync(out, { recursive: true });
    const real = spawnSync("npm", ["pack", "--pack-destination", out, "--json", "--loglevel=error"], { cwd: dst, encoding: "utf8", timeout: 120000 });
    if (real.status !== 0) return { error: `npm pack (${name}) failed: ${real.stderr?.trim()}` };
    try { tgz = resolve(out, JSON.parse(real.stdout)[0].filename); } catch (e) { return { error: `npm pack output unparseable (${name}): ${e.message}` }; }
  }
  return { name, dir: dst, files, bundled, tgz };
}

// The fixture comparison, both ways — the same two questions the core's
// packaging contract asks, with the same two answers.
export function compareWithFixture(name, files, root = ROOT) {
  const p = resolve(root, shellPacklistPath(name));
  if (!existsSync(p)) return { fixture: shellPacklistPath(name), present: false, unexpected: files, missing: [] };
  const expected = JSON.parse(readFileSync(p, "utf8"));
  const shipped = new Set(files), listed = new Set(expected);
  return { fixture: shellPacklistPath(name), present: true, unexpected: files.filter((f) => !listed.has(f)), missing: expected.filter((f) => !shipped.has(f)) };
}

// --build: every shell (or --only one) from one core tarball. With --out the
// scratch lives at <out>/build/ and stays — the built directory beside the
// tarball is the publish-from-directory fallback; without it the scratch is
// removed on the way out (the guard's --write-packlist leaves nothing behind).
export function buildShells({ root = ROOT, only = null, out = null } = {}) {
  const keep = Boolean(out);
  const scratch = keep ? join(out, "build") : mkdtempSync(join(tmpdir(), "ps-shells-"));
  // npm pack requires --pack-destination to exist; the core's own directory
  // under the scratch is created here, not by npm (an ENOENT otherwise).
  mkdirSync(join(scratch, "core"), { recursive: true });
  try {
    const core = packCore({ root, dest: join(scratch, "core") });
    if (core.error) return { ok: false, error: core.error };
    const shells = [];
    let ok = true;
    for (const s of SHELLS) {
      if (only && s.name !== only) continue;
      const b = buildShell(s.name, { coreTgz: core.tgz, root, out, scratch });
      if (b.error) { ok = false; shells.push({ name: s.name, error: b.error }); continue; }
      const cmp = compareWithFixture(s.name, b.files, root);
      if (!cmp.present || cmp.unexpected.length || cmp.missing.length) ok = false;
      shells.push({ name: s.name, count: b.files.length, bundled: b.bundled, tgz: b.tgz, dir: keep ? b.dir : null, files: b.files, fixture: cmp });
    }
    if (only && !shells.length) return { ok: false, error: `no shell named ${only}` };
    return { ok, core: { tgz: keep ? core.tgz : null, version: core.version, count: core.files.length, files: core.files }, shells, hint: ok ? undefined : "a fixture drifted — run `npm run packlist` if the change is intended" };
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}

function list() {
  const core = corePackage();
  for (const s of SHELLS) {
    const p = join(shellDir(s.name), "package.json");
    const pkg = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    process.stdout.write(`${s.name.padEnd(24)} ${s.harness.padEnd(12)} ${s.private ? "private " : "publish "} ${pkg ? `${pkg.version} pin ${pkg.dependencies?.[CORE]}` : "(not rendered)"}   core ${core.version}\n`);
  }
}

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const value = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1] || null; };
  const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
  if (flag("--list")) { if (flag("--json")) process.stdout.write(JSON.stringify(publishable()) + "\n"); else list(); return 0; }
  if (flag("--write")) { emit(await writeShells()); return 0; }
  if (flag("--check")) { const r = await checkShells(); emit(r); return r.ok ? 0 : 1; }
  if (flag("--build")) {
    const r = buildShells({ only: value("--only"), out: value("--out") ? resolve(value("--out")) : null });
    // The listings stay out of the report — 148 lines per shell say nothing a count and a fixture diff do not.
    emit({ ...r, core: r.core && { ...r.core, files: undefined }, shells: (r.shells || []).map((s) => ({ ...s, files: undefined })) });
    return r.ok ? 0 : 1;
  }
  list();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

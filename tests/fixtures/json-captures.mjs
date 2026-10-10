// projectstore — test fixture: the bin's `--json` output, captured before the
// presentation work (PS-HARNESS: "The CLI's output is designed: grouped plans,
// a question rail, one glyph set, doctor grouped by cause", its first
// decomposition item; the covering spec *Terminal presentation of the
// projectstore CLI: layout, glyphs, colour roles, questions and live lines*,
// Testing → JSON).
//
// That story re-lays out every human-facing screen of the bin and changes no
// `--json` envelope and no exit code. These captures are what "no envelope
// changed" compares against: each scenario is the bin, spawned, its stdout
// parsed, put through the one normaliser below, and kept with its exit code.
//
// The scenarios come from the test fixtures:
//   - the install family (plan, install, upgrade, uninstall) and doctor's
//     install group, each on a fresh `installed()` tree: the shape of
//     tests/install.test.mjs's helper of that name, built here because a test
//     file cannot be imported. That tree is bound to a vault that does not
//     exist, where doctor's install group stops at its first check, so doctor
//     also runs on the same tree bound to an existing, empty vault;
//   - a Codex plan with no `codex` CLI on PATH;
//   - doctor's vault group on tests/fixtures/vault.mjs's seedCliVault, and
//     status on a second one with its graph view written first, as
//     tests/cli.test.mjs's cliVault() does.
// None fetches: plan and uninstall never do, and the install family runs the
// source harness, whose registration is not shell-rooted.
//
// Every spawn is hermetic: a temp home, an environment built from nothing (no
// PATH, so no host CLI; no harness variable; no colour, ASCII or animation
// switch), and the repository's own bin, so the package root is this
// checkout. The in-process install that builds a tree runs in that same
// environment (inCaptureEnv, below).
//
// The normaliser is the only transform. It replaces the fixture's project,
// home and package-root paths, and their realpaths, with `<project>`,
// `<home>` and `<root>`; the running version with `<version>`; ISO timestamps
// with `<time>`. Nothing is sorted or dropped.
//
// The committed snapshot, tests/fixtures/json-captures.json, was taken at the
// story's branch point (ed081ff), never from the code under test, with
//   node tests/fixtures/json-captures.mjs --write
// Regenerating it is a decision, not a refresh: it re-baselines what "the
// `--json` output is unchanged" compares against.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sourceHarness, loadHarness } from "../../scripts/harness.mjs";
import { plan, apply } from "../../scripts/install-harness.mjs";
import { walkVaultFiles } from "../../scripts/doctor.mjs";
import { fakeInstall } from "./install.mjs";
import { seedCliVault, writeBinding } from "./vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const BIN = join(REPO, "bin", "projectstore.mjs");
export const CAPTURES = join(HERE, "json-captures.json");

const SRC = sourceHarness();
const CODEX = loadHarness("codex");

export const packageVersion = () => JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An ISO 8601 timestamp: a date with a time, optional seconds, fraction and
// zone. A bare date (`2026-02-02`, a story's started_at) is data, not a clock.
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// The one normaliser. `paths` maps a placeholder to the paths it stands for;
// each path's realpath is added (macOS's tmpdir is a symlink, and a child's
// cwd comes back resolved). Longest first, so a realpath is replaced before
// the path it ends with. The version is matched whole: not inside a longer
// number, and a trailing full stop still ends it.
export function normaliser({ paths = {}, version = packageVersion() } = {}) {
  const pairs = [];
  for (const [placeholder, list] of Object.entries(paths)) {
    for (const p of list) for (const from of new Set([real(p), p])) pairs.push([from, placeholder]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const ver = new RegExp(`(?<![\\d.])${literal(version)}(?!\\.?\\d)`, "g");
  const text = (s) => pairs.reduce((t, [from, to]) => t.split(from).join(to), s).replace(ver, "<version>").replace(ISO, "<time>");
  const walk = (v) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk;
}

// The environment every capture spawns the bin with, built from nothing: the
// temp home, no PATH (no host CLI can run), the user cache inside the home.
// No harness variable, no FORCE_COLOR, NO_COLOR, TERM, PROJECTSTORE_ASCII or
// PROJECTSTORE_NO_ANIMATION reaches it; TMPDIR is kept so the child's temp
// files land where the parent's do.
export function captureEnv(home) {
  const env = { HOME: home, PATH: "", XDG_CACHE_HOME: join(home, ".cache"), npm_config_offline: "true" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function spawnBin(args, { home, cwd = REPO }) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: captureEnv(home), timeout: 60000, maxBuffer: 1 << 24 });
  if (r.error) throw r.error;
  return r;
}

function bin(args, opts) {
  const r = spawnBin(args, opts);
  let stdout;
  try { stdout = JSON.parse(r.stdout); } catch { throw new Error(`projectstore ${args.join(" ")}: stdout is not JSON (exit ${r.status})\n${r.stdout}\n${r.stderr}`); }
  return { exit: r.status, stdout };
}

// plan() and apply() read some names from process.env whatever `env` they are
// handed: claudeHome() reads the harness's home variable and the active
// harness, homedir() reads HOME. A developer's exported CLAUDE_CONFIG_DIR
// took the fake cache root out of the cache and the launcher out of the tree.
// So the in-process install runs with process.env swapped for the captures'
// own environment, synchronously, and put back.
function inCaptureEnv(home, fn) {
  const env = captureEnv(home);
  const saved = { ...process.env };
  const swap = (to) => { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, to); };
  swap(env);
  try { return fn(env); } finally { swap(saved); }
}

// tests/install.test.mjs's installed(): its fixture() — a temp home holding a
// four-file cache install at 0.28.0 — and its project() — the harness's own
// directory and a binding with the status line enabled — with install applied
// from that cache root. Planned and applied in the captures' own environment
// with the home named, so no host CLI runs and nothing outside the two temp
// directories is read or written. `vault: true` binds an existing, empty vault
// inside the project instead of the helper's /tmp/nowhere: doctor's install
// group stops at a vault path that does not exist.
export function installedTree({ vault = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"));
  const root = fakeInstall(home, "0.28.0");
  const proj = mkdtempSync(join(tmpdir(), "ps-inst-"));
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  const vaultPath = vault ? join(proj, "vault") : "/tmp/nowhere";
  if (vault) mkdirSync(vaultPath);
  writeBinding(proj, JSON.stringify({ vault_path: vaultPath, layout: "engineering", statusline: { enabled: true } }));
  inCaptureEnv(home, (env) => apply(plan(proj, { harnesses: [SRC.id], home, root, env }), { env, home }));
  return { home, proj };
}

// cli.test.mjs's projectForHarness(): a project holding only the harness's
// own directory, bound.
function harnessProject(harness) {
  const proj = mkdtempSync(join(tmpdir(), "ps-cli-harness-"));
  mkdirSync(join(proj, harness.runtime.harness_dir), { recursive: true });
  writeBinding(proj, JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering" }));
  return proj;
}

const tempHome = () => mkdtempSync(join(tmpdir(), "ps-home-"));

// cli.test.mjs's cliVault(): seedCliVault with the graph view written through
// the bin, so status reports one view that exists, its stamp and its freshness.
// Freshness compares mtimes, and a seed written within one millisecond made
// kanban.md stale on one machine and fresh on CI. Every file gets one fixed
// mtime and kanban.md a minute less, so both answers are captured, always.
const SEED_MTIME = new Date("2026-01-01T00:00:00Z");
function cliVault(home) {
  const { proj, vault } = seedCliVault();
  const r = spawnBin(["reconcile", "--write", "--only", "graph", "--project", proj], { home });
  if (r.status !== 0) throw new Error(`reconcile --write --only graph: exit ${r.status}\n${r.stderr}`);
  for (const f of walkVaultFiles(vault)) utimesSync(join(vault, f.rel), SEED_MTIME, SEED_MTIME);
  const older = new Date(SEED_MTIME.getTime() - 60_000);
  utimesSync(join(vault, "kanban.md"), older, older);
  return proj;
}

// The scenarios, in the order they are written: [name, () → { proj, home,
// args }]. Each builds its own tree and home, so no capture depends on
// another's writes.
export const SCENARIOS = Object.freeze([
  ["plan", () => ({ ...installedTree(), args: ["plan", "--harness", SRC.id] })],
  ["install", () => ({ ...installedTree(), args: ["install", "--harness", SRC.id] })],
  ["upgrade", () => ({ ...installedTree(), args: ["upgrade", "--harness", SRC.id] })],
  ["uninstall", () => ({ ...installedTree(), args: ["uninstall", "--harness", SRC.id] })],
  ["plan codex, no codex CLI", () => ({ proj: harnessProject(CODEX), home: tempHome(), args: ["plan", "--harness", CODEX.id] })],
  ["doctor --install", () => ({ ...installedTree(), args: ["doctor", "--install"] })],
  ["doctor --install, vault present", () => ({ ...installedTree({ vault: true }), args: ["doctor", "--install"] })],
  ["doctor --vault", () => ({ proj: seedCliVault().proj, home: tempHome(), args: ["doctor", "--vault"] })],
  ["status", () => { const home = tempHome(); return { proj: cliVault(home), home, args: ["status"] }; }],
]);

// Every scenario's capture, normalised: name → { argv, exit, stdout }.
export function captureAll({ version = packageVersion() } = {}) {
  const out = {};
  for (const [name, make] of SCENARIOS) {
    const { proj, home, args } = make();
    const argv = [...args, "--json", "--project", proj];
    const r = bin(argv, { home });
    const norm = normaliser({ paths: { "<project>": [proj], "<home>": [home], "<root>": [REPO] }, version });
    out[name] = { argv: norm(argv), exit: r.exit, stdout: norm(r.stdout) };
  }
  return out;
}

export const serialise = (captures) => JSON.stringify(captures, null, 2) + "\n";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  writeFileSync(CAPTURES, serialise(captureAll()));
  process.stdout.write(`wrote ${CAPTURES}\n`);
}

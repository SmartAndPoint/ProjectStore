// projectstore — the `setup` verb (PS-HARNESS: "projectstore setup asks,
// shows one plan and installs every harness it finds, with the vault"; the
// front-door ADR's decisions 1, 2, 6 and 7). One test per acceptance
// criterion in scope; the updates question is the maintainer's to land later
// (2026-10-11) and has none.
//
// In process, through scripts/setup.mjs's runSetup with the TTY double (a
// PassThrough that says it is a terminal, with a recording setRawMode), the
// fake hosts on a temp PATH (tests/fixtures/install.mjs's fakeClaude,
// tests/fixtures/fetch.mjs's fakeCodexBin), the in-process fake npm, the
// converge story's stub copy, and temporary homes: nothing here reads the
// developer's own configuration or runs a real host CLI. Git is the real
// one, alone on PATH through a symlink, with no user or system configuration.
//
//   node --test --import ./tests/fixtures/hermetic.mjs tests/setup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  runSetup,
  ownProjectNames,
  decideProject,
  listedHarnesses,
  harnessRows,
  decideChannel,
  vaultChoices,
  siblingOf,
  vaultPathRefusal,
  decideStatusline,
  TITLES,
  CHANNEL_TEXT,
} from "../scripts/setup.mjs";
import { run, VERBS, HANDLERS } from "../scripts/cli.mjs";
import { runVerb, plan, gateText } from "../scripts/install-harness.mjs";
import { checkLayout } from "../scripts/doctor.mjs";
import { planBind, applyBind, shellQuote } from "../scripts/binding.mjs";
import { planScaffold } from "../scripts/scaffold.mjs";
import {
  sourceHarness,
  loadHarnesses,
  invocation,
  LAYOUT,
  RUNTIME_GITIGNORE_HEADER,
  hostPresence,
} from "../scripts/harness.mjs";
import { layoutPaths, whichOnPath } from "../scripts/lib.mjs";
import { fakeClaude, fakeInstall, noHostEnv, writeRegistry, stubCopy, stubCalls } from "./fixtures/install.mjs";
import { fakeCodexBin, fakeNpmSpawn, registryFetch } from "./fixtures/fetch.mjs";
import { writeBinding } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const V = PKG.version;
const SRC = sourceHarness();
// The other harness: the one whose registration is a portable one (its shell's).
const CODEX = [...loadHarnesses().values()].find((m) =>
  Object.values(m.surfaces || {}).some((s) => s?.format === "portable-plugin-registration"),
);
const CC_DIR = SRC.runtime.harness_dir;
const REAL_GIT = whichOnPath("git", process.env);
const GIT_COPY = "projectstore@SmartAndPoint";
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const read = (p) => readFileSync(p, "utf8");
const bindingOf = (proj) => JSON.parse(read(layoutPaths(proj).binding));
const writes = (items) => items.filter((i) => !["skip", "refuse"].includes(i.action));
const sessionMarker = (m) => m.runtime.session_env[0];
const deferMarker = (m) => m.runtime.registration_defer_env[0];
const KEYS = { UP: "\x1b[A", DOWN: "\x1b[B", ENTER: "\r", SPACE: " ", CTRL_C: "\x03", ESC: "\x1b" };
const { UP, DOWN, ENTER, SPACE, CTRL_C, ESC } = KEYS;
const SHOW = "\x1b[?25h";
const RAIL = { timeout: 60_000 };

// A machine and a project: a temporary home with both hosts' homes, the fake
// claude and codex on PATH (unless left out), git, node; the project at
// <home>/src/<name>, its folder beside it named but not made.
function sandbox({
  claude = true,
  codex = true,
  homes = [SRC, CODEX],
  git = REAL_GIT,
  name = "acme",
  ccDir = true,
} = {}) {
  const base = tmp("ps-setup-");
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  for (const m of homes) mkdirSync(join(home, m.runtime.home_default), { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  if (git) symlinkSync(git, join(bin, "git"));
  const fc = claude ? fakeClaude(join(base, "claude-bin")) : null;
  const fx = codex ? fakeCodexBin(join(base, "codex-bin")) : null;
  const env = noHostEnv({
    HOME: home,
    PATH: [bin, fc?.dir, fx?.dir, dirname(process.execPath)].filter(Boolean).join(":"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
    XDG_CACHE_HOME: join(base, "cache"),
  });
  for (const k of ["CI", "FORCE_COLOR", "PROJECTSTORE_ASCII", "PROJECTSTORE_PROJECT_DIR"]) delete env[k];
  const proj = join(home, "src", name);
  mkdirSync(proj, { recursive: true });
  if (ccDir) mkdirSync(join(proj, CC_DIR), { recursive: true });
  return { base, home, bin, env, proj, fc, fx, vault: join(home, "src", `${name}-vault`), cache: join(base, "cache") };
}
// The git marketplace's copy, enabled at user scope (the converge story's fixture).
function withGitCopy(sb, version = "0.27.1") {
  const git = fakeInstall(sb.home, version);
  writeRegistry(sb.home, [{ scope: "user", installPath: git, version, lastUpdated: "2026-09-01T00:00:00Z" }]);
  return git;
}
// The stub copy (the converge story's keep, rule 5), whose own plan lists these
// writes while their files are missing; enabled at user scope.
const STUB_WRITES = [
  {
    surface: "statusline_launcher",
    kind: "exclusive",
    action: "create",
    file: join(".projectstore", "stub-launcher.mjs"),
    body: "// written by the stub copy\n",
  },
  { surface: "statusline", kind: "shared", action: "create", file: join(CC_DIR, "stub-settings.json"), body: "{}\n" },
];
function withStub(sb, version = "0.29.0", writes = STUB_WRITES) {
  const copy = stubCopy(sb.home, version, { writes });
  writeRegistry(sb.home, [{ scope: "user", installPath: copy, version, lastUpdated: "2026-10-01T00:00:00Z" }]);
  return copy;
}
const bind = (sb, extra = {}) => {
  mkdirSync(sb.vault, { recursive: true });
  writeBinding(sb.proj, { vault_path: sb.vault, layout: "engineering", language: "en", ...extra });
};

// The screen a terminal shows for what was written (term.test.mjs's, with an
// erase-line for the step lines that follow the rail).
function screen(text, columns = 80) {
  const lines = [[]];
  let row = 0,
    col = 0;
  const at = (r) => {
    while (lines.length <= r) lines.push([]);
    return lines[r];
  };
  for (let i = 0; i < text.length;) {
    const m = /^\x1b\[(\??)(\d*)([A-Za-z])/.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      if (m[1] === "?" || m[3] === "m") continue;
      if (m[3] === "A") {
        row = Math.max(0, row - (m[2] === "" ? 1 : Number(m[2])));
        col = Math.min(col, columns - 1);
        continue;
      }
      if (m[3] === "J") {
        at(row).length = Math.min(at(row).length, col);
        lines.length = row + 1;
        continue;
      }
      if (m[3] === "K") {
        at(row).length = 0;
        continue;
      }
      throw new Error(`an unexpected escape: ${JSON.stringify(m[0])}`);
    }
    const ch = String.fromCodePoint(text.codePointAt(i));
    i += ch.length;
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\n") {
      row++;
      col = 0;
      at(row);
      continue;
    }
    if (col >= columns) {
      row++;
      col = 0;
    }
    const line = at(row);
    while (line.length < col) line.push(" ");
    line[col++] = ch;
  }
  const out = lines.map((l) => l.join("").trimEnd());
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

// The TTY double: stdin a PassThrough that says it is a terminal, with a
// setRawMode that records each call; stdout a terminal sink, 80 columns; a
// process stand-in for the rail's exit and signal handlers.
function tty({ raw = true, columns = 80, stdinTTY = true, stdoutTTY = true } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = stdinTTY;
  const modes = [];
  if (raw)
    stdin.setRawMode = (on) => {
      modes.push(on);
      stdin.isRaw = on;
      return stdin;
    };
  const chunks = [];
  const stdout = {
    isTTY: stdoutTTY,
    columns,
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
  };
  const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: [] });
  proc.kill = (pid, sig) => {
    proc.killed.push([pid, sig]);
    return true;
  };
  return {
    stdin,
    stdout,
    modes,
    chunks,
    proc,
    text: () => chunks.join(""),
    screen: () => screen(chunks.join(""), columns),
  };
}
// The rail's part of the screen: from `┌` to `└`.
const railOf = (t) => {
  const s = t.screen();
  const a = s.findIndex((l) => l.startsWith("┌") || l.startsWith("+ projectstore"));
  const b = s.findIndex((l, k) => k > a && /^[└+]( |$)/.test(l));
  return s.slice(a, b + 1);
};

// One setup run, in process. `keys` are typed ahead into the TTY double, all
// at once (the rail keeps one key queue); `answer` is the line-mode confirm's.
// Without keys and without `term`, there is no terminal: stdout is a pipe.
async function setup(
  sb,
  {
    keys = null,
    term = null,
    values = {},
    answer = "y",
    cwd = sb.proj,
    env = sb.env,
    npm = fakeNpmSpawn(),
    ...extra
  } = {},
) {
  const t = term || (keys ? tty() : null);
  if (t && keys && keys.length) t.stdin.write(keys.join(""));
  const pipe = [];
  const stdout = t
    ? t.stdout
    : {
        isTTY: false,
        write: (s) => {
          pipe.push(String(s));
          return true;
        },
      };
  const asked = [];
  const gitCalls = [];
  const gitSpawn = (bin, argv, o) => {
    gitCalls.push([bin, ...argv].join(" "));
    return spawnSync(bin, argv, o);
  };
  const project = values.project ? resolve(cwd, values.project) : cwd;
  const r = await runSetup({
    values,
    project,
    env,
    cwd,
    stdin: t ? t.stdin : null,
    stdout,
    stderr: stdout,
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    root: ROOT,
    home: sb.home,
    proc: t ? t.proc : new EventEmitter(),
    escapeMs: 20,
    gitSpawn,
    fetchSpawn: npm.spawn,
    ...extra,
  });
  return { r, t, asked, npm, gitCalls, text: t ? t.text() : pipe.join("") };
}
// One run through the bin's own parse, in process: cli.mjs's run() over its
// verb table, with no terminal. run() takes no home (homedir() would be the
// developer's), so setup's row carries its own run — cli.mjs's setup handler
// handed the sandbox's home, and the fake npm.
async function cli(sb, argv, { env = sb.env, cwd = sb.proj, npm = fakeNpmSpawn() } = {}) {
  const verbs = VERBS.map((v) =>
    v.verb === "setup"
      ? {
          ...v,
          run: (ctx) => HANDLERS.setup({ ...ctx, home: sb.home, fetchSpawn: npm.spawn, proc: new EventEmitter() }),
        }
      : v,
  );
  const out = [];
  const sink = {
    isTTY: false,
    write: (s) => {
      out.push(String(s));
      return true;
    },
  };
  const code = await run(argv, { verbs, env, cwd, stdin: null, stdout: sink, stderr: sink });
  return { code, text: out.join("") };
}

// Everything under `dir`, each file's bytes; `.git` left out when asked.
function treeOf(dir, { git = true } = {}) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = (at) => {
    for (const n of readdirSync(join(dir, at)).sort()) {
      if (!git && !at && n === ".git") continue;
      const rel = at ? join(at, n) : n;
      const st = statSync(join(dir, rel));
      if (st.isDirectory()) {
        out[`${rel}/`] = null;
        walk(rel);
      } else out[rel] = read(join(dir, rel));
    }
  };
  walk("");
  return out;
}
// The whole machine a run may touch: the project, the folder beside it, the homes and the cache.
const machine = (sb) => ({
  proj: treeOf(sb.proj),
  vault: treeOf(sb.vault),
  home: treeOf(sb.home),
  cache: treeOf(sb.cache),
});
// Prose a live terminal wrapped, as one line: every line trimmed, joined by a space.
const flat = (text) =>
  String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
// A command alone on its line, after a blank one (contract 6), at `indent`.
const alone = (text, command, indent = 4) => String(text).includes(`\n\n${" ".repeat(indent)}${command}\n`);
const tick = () => new Promise(setImmediate);
const until = async (ok, ms = 10_000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ─── The row (rule 1) ───────────────────────────────────────────────────

test("setup 'The row': setup --help prints its usage and the seven options; setup extra exits 2 naming extra; setup --vault <path> hands the verb a string while doctor --vault stays a flag; top-level help lists setup first in START", async () => {
  const sink = () => {
    const s = {
      text: "",
      isTTY: false,
      write(x) {
        s.text += String(x);
        return true;
      },
    };
    return s;
  };
  const out = sink();
  assert.equal(await run(["setup", "--help"], { env: {}, stdout: out, stderr: sink() }), 0);
  assert.ok(out.text.includes("\nUsage\n  npx projectstore setup [options]\n"), out.text);
  for (const o of [
    "--harness <id>",
    "--vault <path>",
    "--layout <name>",
    "--language <code>",
    "--channel <npm|git>",
    "--dry-run",
    "--verbose",
  ])
    assert.match(out.text, new RegExp(`\\n  ${o.replace(/[|]/g, "\\|")} +\\S`), o);
  for (const e of [
    "npx projectstore setup",
    "npx projectstore setup --dry-run",
    "npx projectstore setup --harness <id> --vault ~/vaults/my-project",
  ])
    assert.ok(out.text.includes(`\n  ${e}\n`), e);
  const err = sink();
  assert.equal(await run(["setup", "extra"], { env: {}, stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /setup takes no argument `extra`/);
  // The per-verb parse: --vault is setup's string and doctor's flag.
  const proj = tmp("ps-setup-row-");
  const bad = sink();
  assert.equal(await run(["setup", "--vault"], { env: {}, cwd: proj, stdout: sink(), stderr: bad }), 2);
  assert.match(bad.text, /`--vault` needs a value: `--vault <path>`/);
  const flag = sink();
  assert.equal(await run(["doctor", "--vault", "extra"], { env: {}, cwd: proj, stdout: sink(), stderr: flag }), 2);
  assert.match(flag.text, /doctor takes no argument `extra` — `--vault` takes no value/);
  // With a value, the verb gets a string, through the bin's own parse: a
  // --vault that names a file is refused by setup itself, by its path.
  writeFileSync(join(proj, "notes"), "x\n");
  const sb = sandbox({ claude: false, codex: false });
  const r = await cli(sb, ["setup", "--vault", join(proj, "notes"), "--harness", SRC.id, "--project", sb.proj]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /notes is a file, not a folder\n$/);
  const top = sink();
  await run(["--help"], { env: {}, stdout: top, stderr: sink() });
  const lines = top.text.split("\n");
  assert.deepEqual(
    lines.slice(lines.indexOf("START") + 1, lines.indexOf("START") + 4).map((l) => l.trim().split(" ")[0]),
    ["setup", "configure", "uninstall"],
  );
});

// ─── The rail (rule 2) ──────────────────────────────────────────────────

test(
  "setup 'The rail': ↓, space and Enter tick and confirm; each answered question collapses to one ◇ line, and one a flag answered is drawn answered; raw mode lasts only while a question is asked; the rail closes before PLAN",
  RAIL,
  async () => {
    const sb = sandbox();
    // Claude Code is used here (its directory); Codex is on PATH but not used here: unticked.
    const { r, t, asked } = await setup(sb, {
      keys: [DOWN, SPACE, ENTER, DOWN, DOWN, ENTER, ENTER],
      values: { "dry-run": true },
    });
    assert.equal(r.code, 0, "a clean dry run");
    assert.deepEqual(r.result.gate, { confirmed: false, why: "dry-run" });
    assert.deepEqual(railOf(t), [
      "┌ projectstore setup",
      "│",
      `◇ ${TITLES.project}  ~/src/acme`,
      "│",
      `◇ ${TITLES.harnesses}  ${SRC.display_name}, ${CODEX.display_name}`,
      "│",
      `◇ ${TITLES.vault}  Not now`,
      "└",
    ]);
    assert.equal(asked.length, 0, "a dry run asks no confirm");
    assert.equal(
      t.modes.filter((m) => m).length,
      2,
      "raw mode on for each question asked, the checklist and the vault",
    );
    assert.equal(t.modes.at(-1), false, "and off again");
    const text = t.text();
    assert.ok(text.indexOf("└") < text.indexOf("Plan —"), "PLAN after the rail closed");
    assert.ok(!/projectstore setup · /.test(text), "the rail's top is the badge: PLAN prints none");
    assert.deepEqual(
      r.result.setup.harnesses.map((h) => [h.id, h.ticked]),
      [
        [SRC.id, true],
        [CODEX.id, true],
      ],
    );
    // A flag answers the question: drawn answered, and not asked.
    const f = await setup(sandbox(), { keys: [ENTER, ENTER], values: { harness: [CODEX.id], "dry-run": true } });
    assert.equal(railOf(f.t)[4], `◇ ${TITLES.harnesses}  ${CODEX.display_name}`);
    assert.ok(!f.t.text().includes("space toggle"), "the checklist was never drawn");
  },
);

test(
  "setup 'The rail': Ctrl+C at any question restores raw mode and the cursor, prints Cancelled — nothing was written, returns 130, and the project tree, the homes and the cache are byte-identical",
  RAIL,
  async () => {
    // The questions of a run on this fixture: the checklist, the vault, the status line.
    for (const before of [[], [ENTER], [ENTER, ENTER]]) {
      const sb = sandbox();
      const was = machine(sb);
      const { r, t, asked } = await setup(sb, { keys: [...before, CTRL_C] });
      assert.equal(r.code, 130, `after ${before.length} answers`);
      assert.equal(asked.length, 0);
      assert.equal(t.modes.at(-1), false, "raw mode off");
      assert.equal(
        t.chunks.filter((c) => c === SHOW).length >= 1 &&
          t.chunks.lastIndexOf(SHOW) > t.chunks.findLastIndex((c) => c === "\x1b[?25l"),
        true,
        "the cursor shown last",
      );
      assert.equal(railOf(t).at(-1), "└ Cancelled — nothing was written");
      assert.deepEqual(machine(sb), was, "nothing written");
      assert.equal(
        t.proc.listenerCount("exit") + t.proc.listenerCount("SIGTERM") + t.proc.listenerCount("SIGINT"),
        0,
        "the rail's handlers are gone",
      );
    }
    // End of input at a question is a cancel too.
    const sb = sandbox();
    const t = tty();
    t.stdin.end();
    const e = await setup(sb, { term: t });
    assert.equal(e.r.code, 130);
  },
);

test(
  "setup 'The rail': a question that throws restores the terminal the same way — raw mode off, the cursor shown, the rail closed — and nothing is written",
  RAIL,
  async () => {
    const sb = sandbox();
    const was = machine(sb);
    const t = tty();
    let n = 0;
    t.stdin.setRawMode = (on) => {
      t.modes.push(on);
      if (on && ++n === 2) throw new Error("the terminal went away");
      return t.stdin;
    };
    t.stdin.write(ENTER);
    await assert.rejects(setup(sb, { term: t }), /the terminal went away/);
    assert.equal(t.modes.at(-1), false);
    assert.equal(t.chunks.at(-2), SHOW, "the cursor shown, then the rail's end");
    assert.match(t.chunks.at(-1), /^└/);
    assert.deepEqual(machine(sb), was);
  },
);

test(
  "setup 'The rail': after the rail, Enter at the line-mode confirm applies; n prints Nothing written. and exits 1; what was typed ahead is drained, never read as the answer",
  RAIL,
  async () => {
    const yes = await setup(sandbox({ codex: false }), { keys: [ENTER, DOWN, DOWN, ENTER, ENTER], answer: "" });
    assert.equal(yes.asked.length, 1);
    assert.match(yes.asked[0], /^◆ Apply \d+ changes\? \[Y\/n\] $/);
    assert.equal(yes.r.code, 0, yes.text);
    assert.match(yes.text, /\nDone — /);
    const sb = sandbox({ codex: false });
    const no = await setup(sb, { keys: [ENTER, DOWN, DOWN, ENTER, ENTER], answer: "n" });
    assert.equal(no.r.code, 1);
    assert.ok(no.text.endsWith("Nothing written.\n"), no.text);
    assert.ok(!existsSync(join(sb.proj, "CLAUDE.md")));
    // Type-ahead: keys typed after the rail closed, before the question, are
    // drained in raw mode — the real line-mode question reads only what follows.
    // The key typed ahead is an Enter, which alone would apply: only a drain
    // that works leaves the question to the "n" typed once it is shown.
    const ta = sandbox({ codex: false });
    const t = tty();
    t.stdin.write([ENTER, DOWN, DOWN, ENTER, ENTER].join(""));
    const pending = runSetup({
      values: {},
      project: ta.proj,
      env: ta.env,
      cwd: ta.proj,
      stdin: t.stdin,
      stdout: t.stdout,
      root: ROOT,
      home: ta.home,
      proc: t.proc,
      escapeMs: 20,
      drainTicks: 2,
    });
    await until(() => t.text().includes("└"));
    t.stdin.write(ENTER); // an Enter double-tapped into the fetch and PLAN
    await until(() => t.text().includes("Apply "));
    await tick();
    t.stdin.write("n\n"); // the answer to the question shown
    const r = await pending;
    assert.equal(r.code, 1, t.text());
    assert.equal(r.result.gate.why, "declined", "the drained Enter did not answer");
    assert.ok(!existsSync(join(ta.proj, "CLAUDE.md")), "nothing applied");
    assert.deepEqual(t.modes.slice(-2), [true, false], "drained in raw mode, then line mode again");
  },
);

test(
  "setup 'The rail': Esc on the path question returns to the vault choice, which is asked again where it was",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const t = tty();
    t.stdin.write([ENTER, DOWN, ENTER].join("")); // the checklist; the vault: Another folder…
    const pending = setup(sb, { term: t, values: { "dry-run": true } });
    await until(() => t.text().includes(TITLES.path));
    t.stdin.write(ESC);
    await until(() => t.screen().at(-1)?.includes("ctrl+c cancel") && !t.screen().some((l) => l.includes(TITLES.path)));
    t.stdin.write([DOWN, DOWN, ENTER].join("")); // the vault again: Not now
    const { r } = await pending;
    assert.deepEqual(railOf(t).slice(-3), ["│", `◇ ${TITLES.vault}  Not now`, "└"]);
    assert.ok(!railOf(t).some((l) => l.includes(TITLES.path)), "the path question and its choice are gone");
    assert.equal(r.result.setup.vault, null);
  },
);

test(
  "setup 'The rail': with PROJECTSTORE_ASCII=1 every rail glyph is from contract 4's ASCII column",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const t = tty();
    t.stdin.write([ENTER, DOWN, DOWN, ENTER].join(""));
    await setup(sb, { term: t, env: { ...sb.env, PROJECTSTORE_ASCII: "1" }, values: { "dry-run": true } });
    const rail = railOf(t);
    assert.equal(rail[0], "+ projectstore setup");
    assert.ok(
      rail.slice(1).every((l) => /^[|o+]( |$)/.test(l)),
      rail.join("\n"),
    );
    const drawn = t.text().slice(0, t.text().indexOf("Plan"));
    for (const g of ["┌", "│", "◇", "◆", "●", "○", "◼", "◻", "└", "→", "…", "—"])
      assert.ok(!drawn.includes(g), `${g} drawn under ASCII`);
    assert.ok(drawn.includes("Another folder...") && drawn.includes("[x]") && drawn.includes("(*)"), drawn);
  },
);

test(
  "setup 'The rail': no question is printed with stdin or stdout not a TTY, CI=1, --json, a session marker, or no setRawMode — the run is one without a terminal",
  RAIL,
  async () => {
    const cases = [
      ["stdin not a TTY", { term: tty({ stdinTTY: false }) }],
      ["stdout not a TTY", { term: tty({ stdoutTTY: false }) }],
      ["CI=1", { term: tty(), env: (sb) => ({ ...sb.env, CI: "1" }) }],
      ["--json", { term: tty(), values: { json: true } }],
      [`${sessionMarker(SRC)}=1`, { term: tty(), env: (sb) => ({ ...sb.env, [sessionMarker(SRC)]: "1" }) }],
      ["no setRawMode", { term: tty({ raw: false }) }],
      ["TERM=dumb", { term: tty(), env: (sb) => ({ ...sb.env, TERM: "dumb" }) }],
    ];
    for (const [label, o] of cases) {
      const sb = sandbox({ codex: false });
      const { r, t, asked } = await setup(sb, {
        ...o,
        env: typeof o.env === "function" ? o.env(sb) : sb.env,
        values: o.values || {},
      });
      assert.ok(
        !t.text().includes("┌") && !t.text().includes("◆ ") && !t.text().includes("ctrl+c"),
        `${label}: ${t.text()}`,
      );
      assert.equal(asked.length, 0, `${label}: the confirm is not asked either`);
      assert.deepEqual(t.modes, [], `${label}: raw mode untouched`);
      assert.equal(r.result.gate.why, "non-tty", `${label}: a bare run without a terminal refuses`);
    }
  },
);

// ─── Without a terminal; --json (rule 12) ───────────────────────────────

test("setup 'Without a terminal': a bare setup prints the pre-tick set's plan, refuses with gate.why non-tty and names npx projectstore setup --harness <id> per pre-ticked harness, each alone on its line; with --json one envelope, the write verbs' keys plus setup", async () => {
  const sb = sandbox();
  mkdirSync(layoutPaths(sb.proj).harnessState(CODEX.id), { recursive: true });
  const was = machine(sb);
  const { r, text, npm } = await setup(sb);
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.gate, { confirmed: false, why: "non-tty" });
  assert.ok(text.startsWith(`projectstore setup · ${SRC.display_name}, ${CODEX.display_name}\n`), text);
  assert.ok(
    text.endsWith(
      [
        "Nothing written: without a terminal, a bare setup refuses. Name the harness to confirm — repeat --harness for more than one:",
        "",
        `    npx projectstore setup --harness ${SRC.id}`,
        `    npx projectstore setup --harness ${CODEX.id}`,
        "",
      ].join("\n"),
    ),
    text,
  );
  assert.deepEqual(npm.calls, [], "a bare run that will refuse fetches nothing");
  assert.deepEqual(machine(sb), was);
  // What named the run's vault, layout and language is repeated after each
  // --harness, so the command printed is the run just seen, confirmed.
  const named = await setup(sb, { values: { vault: sb.vault, layout: "engineering", language: "en" } });
  assert.equal(named.r.result.gate.why, "non-tty", named.text);
  const tail = `--vault ${shellQuote(sb.vault)} --layout engineering --language en`;
  assert.ok(
    named.text.endsWith(
      [
        "",
        `    npx projectstore setup --harness ${SRC.id} ${tail}`,
        `    npx projectstore setup --harness ${CODEX.id} ${tail}`,
        "",
      ].join("\n"),
    ),
    named.text,
  );
  assert.deepEqual(machine(sb), was);
  // From a checkout those commands name no version; from a package root they
  // name the running one, as the channel gate's do (pinFor).
  const npx = join(tmp("ps-setup-npx-"), "node_modules", "projectstore");
  const pinned = gateText(
    { gate: { why: "non-tty" }, plan: { harnesses: [SRC.id, CODEX.id], root: npx, version: "0.30.0" } },
    { verb: "setup" },
  );
  assert.ok(
    pinned.endsWith(
      [
        "",
        `    npx projectstore@0.30.0 setup --harness ${SRC.id}`,
        `    npx projectstore@0.30.0 setup --harness ${CODEX.id}`,
        "",
      ].join("\n"),
    ),
    pinned,
  );
  // --json: one envelope, through the bin's own wrapper.
  const env = { ...sb.env };
  const bin = spawnSync(process.execPath, [join(ROOT, "bin", "projectstore.mjs"), "setup", "--json"], {
    cwd: sb.proj,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(bin.status, 1, bin.stderr);
  const envelope = JSON.parse(bin.stdout);
  assert.deepEqual(Object.keys(envelope), ["schema_version", "verb", "project", "ok", "result"]);
  assert.deepEqual([envelope.verb, envelope.ok, envelope.project], ["setup", false, sb.proj]);
  const captures = JSON.parse(read(join(ROOT, "tests", "fixtures", "json-captures.json")));
  assert.deepEqual(Object.keys(envelope.result), [...Object.keys(captures.install.stdout.result), "setup"]);
  assert.deepEqual(Object.keys(envelope.result.setup), [
    "project",
    "git_top",
    "harnesses",
    "channel",
    "vault",
    "statusline",
  ]);
  assert.deepEqual(
    envelope.result.setup.harnesses.map((h) => [h.id, h.ticked]),
    [
      [SRC.id, true],
      [CODEX.id, true],
    ],
  );
  assert.deepEqual(envelope.result.gate, { confirmed: false, why: "non-tty" });
  // An empty pre-tick set: contract 8's refusal, with the rows' reasons.
  const none = sandbox({ claude: false, codex: false, homes: [], ccDir: false });
  const n = await setup(none);
  assert.equal(n.r.code, 1);
  assert.match(
    n.text,
    new RegExp(
      `^No harness is used in \\S+ or ready on this machine, and none named\\. Name one:\\n  --harness ${SRC.id} +\\(${SRC.display_name}; not found on this machine\\)`,
    ),
  );
  // One row per listed harness, the ids padded to one width: every reason starts in one column.
  const rows = n.text.split("\n").filter((l) => l.startsWith("  --harness "));
  assert.equal(rows.length, 2, n.text);
  assert.equal(new Set(rows.map((l) => l.indexOf("("))).size, 1, n.text);
});

// ─── The order and question 1 (rules 3 and 4) ───────────────────────────

const gitInit = (dir, env) =>
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: dir, env, encoding: "utf8" }).status, 0);

test(
  "setup 'The order': from an unbound sub/ of a bound, set-up top, the question offers the top first; Enter asks no vault question, every fact is the top's, and the plan is zero-change",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    gitInit(sb.proj, sb.env);
    // Set up the top, at a terminal: the checklist, a new vault, the status line.
    const first = await setup(sb, { keys: [ENTER, ENTER, ENTER] });
    assert.equal(first.r.code, 0, first.text);
    const sub = join(sb.proj, "sub");
    mkdirSync(sub);
    const { r, t, gitCalls } = await setup(sb, { cwd: sub, keys: [ENTER, ENTER] });
    assert.deepEqual(gitCalls, ["git rev-parse --show-toplevel"]);
    const frame = t.text();
    assert.ok(
      frame.indexOf("● ~/src/acme  ") > 0 && frame.indexOf("● ~/src/acme  ") < frame.indexOf("○ ~/src/acme/sub"),
      "the top first, and the default",
    );
    const rail = railOf(t);
    assert.equal(rail[2], `◇ ${TITLES.project}  ~/src/acme`);
    assert.equal(rail[6], `◇ ${TITLES.vault}  ~/src/acme-vault · engineering · en`, "shown, not asked");
    assert.ok(
      !frame.includes("Create ~/src/acme-vault") && !frame.includes(TITLES.statusline(SRC.display_name)),
      "neither the vault nor the status line asked",
    );
    assert.equal(r.project, sb.proj);
    assert.deepEqual([r.result.setup.project, r.result.setup.git_top], [sb.proj, sb.proj]);
    assert.match(r.result.setup.harnesses[0].why, /^used in this project/, "the top's harness directory");
    assert.deepEqual(r.result.gate, { confirmed: false, why: "nothing-to-do" });
    assert.deepEqual(writes(r.result.items), []);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(sub, LAYOUT.root)) && !existsSync(join(sub, "CLAUDE.md")), "nothing in sub/");
  },
);

test(
  "setup 'The project question': from sub/ the top is the default; a sub/ that holds any one of rule 4's names — derived from the manifests and LAYOUT — is its own default, the top second; not asked at the top, outside a work tree or with --project; without a terminal the project is sub/ and PLAN names the top",
  RAIL,
  async () => {
    const manifests = [...loadHarnesses().values()];
    const blockFiles = manifests.flatMap((m) =>
      Object.entries(m.surfaces || {})
        .filter(([k, s]) => !k.startsWith("_") && s?.format === "markdown-block")
        .flatMap(([, s]) => s.files || []),
    );
    const names = [
      ...new Set([...blockFiles, ...manifests.map((m) => m.runtime?.harness_dir).filter(Boolean), LAYOUT.root]),
    ];
    assert.deepEqual([...ownProjectNames()].sort(), [...names].sort());
    assert.ok(names.length >= 5, names.join(", "));
    // One more harness_dir, in a test manifest list, is one more name.
    assert.ok(ownProjectNames([...manifests, { id: "extra", runtime: { harness_dir: ".extra" } }]).includes(".extra"));
    assert.deepEqual(
      decideProject({ cwd: "/r/sub", top: "/r", own: true }).choices.map((x) => x.value),
      ["/r/sub", "/r"],
    );
    // The default the question is drawn with (●), for a sub/ holding `holds`.
    const defaultOf = async (holds) => {
      const sb = sandbox({ codex: false, ccDir: false });
      gitInit(sb.proj, sb.env);
      const sub = join(sb.proj, "sub");
      mkdirSync(sub);
      if (holds && blockFiles.includes(holds)) writeFileSync(join(sub, holds), "");
      else if (holds) mkdirSync(join(sub, holds));
      const { r, t } = await setup(sb, { cwd: sub, keys: [CTRL_C] });
      assert.equal(r.code, 130);
      const drawn = t.text().split(TITLES.project)[1];
      return /● ~\/src\/acme\/sub +the current folder/.test(drawn) &&
        drawn.indexOf("● ~/src/acme/sub") < drawn.indexOf("○ ~/src/acme  ")
        ? "sub"
        : /● ~\/src\/acme +the top/.test(drawn)
          ? "top"
          : drawn;
    };
    assert.equal(await defaultOf(null), "top");
    for (const n of names) assert.equal(await defaultOf(n), "sub", n);
    // Not asked: at the top, outside a work tree, with --project (and no git spawned then).
    const top = sandbox({ codex: false });
    gitInit(top.proj, top.env);
    const atTop = await setup(top, { keys: [ENTER, DOWN, DOWN, ENTER], values: { "dry-run": true } });
    assert.equal(railOf(atTop.t)[2], `◇ ${TITLES.project}  ~/src/acme`);
    const outside = await setup(sandbox({ codex: false }), {
      keys: [ENTER, DOWN, DOWN, ENTER],
      values: { "dry-run": true },
    });
    assert.equal(railOf(outside.t)[2], `◇ ${TITLES.project}  ~/src/acme`);
    assert.deepEqual(outside.gitCalls, ["git rev-parse --show-toplevel"]);
    const sub = join(top.proj, "sub");
    mkdirSync(sub);
    const given = await setup(top, {
      cwd: sub,
      keys: [ENTER, DOWN, DOWN, ENTER],
      values: { project: ".", "dry-run": true },
    });
    assert.deepEqual(given.gitCalls, [], "--project: no git top is read");
    assert.equal(railOf(given.t)[2], `◇ ${TITLES.project}  ~/src/acme/sub`);
    // Without a terminal, from sub/: sub/ is the project, and PLAN's header names the top.
    const headless = await setup(top, { cwd: sub, values: { harness: [SRC.id], "dry-run": true } });
    assert.equal(headless.r.project, sub);
    assert.ok(
      headless.text.includes(
        "\n  ~/src/acme/sub\n  inside the git work tree ~/src/acme — this run sets up this folder only\n",
      ),
      headless.text,
    );
  },
);

// ─── Question 2, the checklist (rule 5) ─────────────────────────────────

test(
  "setup 'The checklist': every row of rule 5's table gets its tick and reason; our state directory alone pre-ticks; a distribution-root harness with no shell is not listed; Enter with nothing ticked keeps the question",
  RAIL,
  async () => {
    const home = "/h";
    const listed = [SRC, CODEX];
    const P = (cli, homeDir, bin) => ({
      cli: cli ? `/bin/${bin}` : null,
      home: homeDir ? `/h/.${bin}` : null,
      bin,
      homeDir: `/h/.${bin}`,
    });
    const row = (detected, presence) =>
      harnessRows({ listed, detected, presence: new Map(presence), home }).map((r) => [r.ticked, r.why]);
    const ccBin = SRC.surfaces.plugin.cli.bin,
      cxBin = CODEX.surfaces.plugin.cli.bin;
    const ccUsed = { id: SRC.id, why: "directory", evidence: CC_DIR };
    // Used here, by its directory and by our state directory.
    assert.deepEqual(
      row(
        [ccUsed, { id: CODEX.id, why: "state", evidence: `.projectstore/state/${CODEX.id}` }],
        [
          [SRC.id, P(1, 1, ccBin)],
          [CODEX.id, P(0, 0, cxBin)],
        ],
      ),
      [
        [true, `used in this project (${CC_DIR}/)`],
        [true, `used in this project (.projectstore/state/${CODEX.id}/)`],
      ],
    );
    // None used here: the CLI and the home, both, pre-tick; either alone does not.
    assert.deepEqual(
      row(
        [],
        [
          [SRC.id, P(1, 1, ccBin)],
          [CODEX.id, P(1, 0, cxBin)],
        ],
      ),
      [
        [true, `${ccBin} is on PATH`],
        [false, `${cxBin} is on PATH but has not run on this machine yet (no ~/.${cxBin})`],
      ],
    );
    assert.deepEqual(
      row(
        [],
        [
          [SRC.id, P(0, 1, ccBin)],
          [CODEX.id, P(0, 0, cxBin)],
        ],
      ),
      [
        [false, `~/.${ccBin} exists, but ${ccBin} is not on PATH — install ${SRC.display_name} first`],
        [false, "not found on this machine"],
      ],
    );
    // Another harness used here: this one's CLI on PATH does not pre-tick it.
    assert.deepEqual(
      row(
        [ccUsed],
        [
          [SRC.id, P(1, 1, ccBin)],
          [CODEX.id, P(1, 1, cxBin)],
        ],
      )[1],
      [false, `not used in this project yet; ${cxBin} is on PATH`],
    );
    // On the machine's own facts: the state directory alone pre-ticks Codex.
    const sb = sandbox({ codex: false, homes: [] });
    mkdirSync(layoutPaths(sb.proj).harnessState(CODEX.id), { recursive: true });
    const s = await setup(sb, { values: { "dry-run": true } });
    assert.deepEqual(
      s.r.result.setup.harnesses.find((h) => h.id === CODEX.id),
      { id: CODEX.id, ticked: true, why: `used in this project (.projectstore/state/${CODEX.id}/)` },
    );
    // Who is listed: a distribution-root registration with no published shell is not.
    const hidden = {
      id: "hidden",
      display_name: "Hidden",
      surfaces: {
        plugin: { kind: "registration", format: "portable-plugin-registration", condition: "distribution_root" },
      },
      install: {},
    };
    const shelled = { ...hidden, id: "shelled", install: { shell: "projectstore-shelled" } };
    assert.deepEqual(
      listedHarnesses([SRC, CODEX, hidden, shelled]).map((m) => m.id),
      [SRC.id, CODEX.id, "shelled"],
    );
    assert.deepEqual(
      listedHarnesses().map((m) => m.id),
      [SRC.id, CODEX.id],
    );
    // Enter with nothing ticked keeps the question and says how.
    const bare = sandbox({ claude: false, codex: false, homes: [], ccDir: false });
    const { r, t } = await setup(bare, { keys: [ENTER, CTRL_C] });
    assert.equal(r.code, 130);
    assert.ok(t.text().includes("│ ▲ tick at least one with space"), t.text());
  },
);

test(
  "setup 'The checklist': Codex ticked with no codex on PATH is planned as a skip with that reason, the plan is incomplete, and DONE says to install Codex first with npx projectstore@<v> setup --harness codex alone on its line",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const { r, text } = await setup(sb, { keys: [DOWN, SPACE, ENTER, ENTER, ENTER] });
    const reg = r.result.items.find((i) => i.harness === CODEX.id && i.kind === "registration");
    assert.equal(reg.action, "skip");
    assert.match(reg.reason, new RegExp(`\`?${CODEX.surfaces.plugin.cli.bin}\`? is not on PATH`));
    assert.equal(r.result.incomplete, true);
    assert.equal(r.code, 1);
    const done = text.slice(text.indexOf("Done — "));
    assert.ok(
      flat(done).includes(
        `${CODEX.display_name} is not installed on this machine (${CODEX.surfaces.plugin.cli.bin} was not found on PATH). Install it, then run this from a terminal in this project: npx projectstore@${V} setup --harness ${CODEX.id}`,
      ),
      done,
    );
    assert.ok(alone(done, `npx projectstore@${V} setup --harness ${CODEX.id}`), done);
    // A host this run did not need — its registration already current — is
    // never said to be missing, though its CLI has left PATH since.
    const cur = sandbox({ codex: false });
    assert.equal((await setup(cur, { values: { harness: [SRC.id], vault: cur.vault } })).r.code, 0);
    const noHost = {
      ...cur.env,
      PATH: cur.env.PATH.split(":")
        .filter((d) => d !== cur.fc.dir)
        .join(":"),
    };
    assert.equal(hostPresence(SRC, { env: noHost, home: cur.home }).cli, null);
    const quiet = await setup(cur, { env: noHost, values: { harness: [SRC.id] } });
    assert.equal(quiet.r.result.gate.why, "nothing-to-do", quiet.text);
    assert.ok(!quiet.text.includes("is not installed on this machine"), quiet.text);
  },
);

// ─── One add per file (the presentation spec, contract 7 as amended 2026-10-14) ───

test(
  "setup 'One add per file': in a fresh project with the status line and a channel switch, the vault item adds the binding once and the flag and the mark update it — in PLAN, the envelope, the counts and APPLY; a bound project's flag keeps add",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    withGitCopy(sb);
    const { r, text } = await setup(sb, { keys: [ENTER, ENTER, ENTER, ENTER] });
    assert.equal(r.code, 0, text);
    const binding = join(sb.proj, LAYOUT.root, "projectstore.json");
    const vault = r.result.items.find((i) => i.kind === "vault");
    assert.ok(
      vault.steps.some((s) => s.path === binding),
      "the vault item writes the binding",
    );
    assert.deepEqual(
      r.result.items.filter((i) => i.kind === "binding").map((i) => [i.surface, i.action]),
      [
        ["statusline_flag", "update"],
        ["channel_switch", "update"],
      ],
    );
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    const rel = `${LAYOUT.root}/projectstore.json`;
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(plain, new RegExp(`\\badd\\s+${esc}`), "PLAN never adds the binding as a row of its own");
    assert.equal((plain.match(new RegExp(`update\\s+${esc}`, "g")) || []).length, 2, plain);
    assert.match(
      plain,
      /Plan — 4 to add · 1 to register · 2 to update · 1 to switch/,
      "the counts line counts them as updates",
    );
    assert.doesNotMatch(plain, new RegExp(`added ${esc}`), "APPLY never says the binding was added");
    assert.equal((plain.match(new RegExp(`updated ${esc}`, "g")) || []).length, 2, "APPLY says updated, twice");
    assert.match(plain, /Done — 8 changes/, "the run's N counts writes, unchanged");
    assert.equal(bindingOf(sb.proj).statusline.enabled, true);
    assert.equal(bindingOf(sb.proj).channel_switch.by, "setup");
    // A project bound before the run: the flag adds our key to a file that is there.
    const b = sandbox({ codex: false });
    bind(b);
    const br = await setup(b, { keys: [ENTER, ENTER], values: { "dry-run": true } });
    const bf = br.r.result.items.find((i) => i.surface === "statusline_flag");
    assert.deepEqual([bf.kind, bf.action], ["binding", "add"], br.text);
    // A pre-0.28 layout: the move makes the binding, so no binding row is a
    // creator — the flag must not turn the switch after it into an update.
    const lg = sandbox({ codex: false });
    withGitCopy(lg);
    mkdirSync(lg.vault, { recursive: true });
    writeFileSync(layoutPaths(lg.proj).legacy.binding, JSON.stringify({ vault_path: lg.vault, layout: "engineering" }));
    const lr = await setup(lg, { keys: [ENTER, ENTER, ENTER, ENTER, ENTER], values: { "dry-run": true } });
    assert.deepEqual(
      lr.r.result.items.filter((i) => i.kind === "binding").map((i) => [i.surface, i.action]),
      [
        ["statusline_flag", "add"],
        ["channel_switch", "add"],
      ],
      lr.text,
    );
    // Without a terminal: --json --channel npm --vault, the vault item writes
    // the binding and the switch's mark updates it.
    const j = sandbox({ codex: false });
    withGitCopy(j);
    const jr = await setup(j, { values: { json: true, channel: "npm", vault: j.vault, harness: [SRC.id] } });
    assert.equal(jr.r.code, 0, jr.text);
    assert.deepEqual(
      jr.r.result.items.filter((i) => i.kind === "binding").map((i) => [i.surface, i.action]),
      [["channel_switch", "update"]],
    );
  },
);

// ─── Question 3, the channel (rule 6) ───────────────────────────────────

test(
  "setup 'The channel': with a git copy enabled the question is asked, switch the default, and Enter plans what channel npm plans — the switch and the mark; with Claude Code unticked it is not asked and plan() receives null",
  RAIL,
  async () => {
    const sb = sandbox();
    bind(sb, { statusline: { enabled: true } });
    withGitCopy(sb);
    const { r, t } = await setup(sb, { keys: [ENTER, ENTER], values: { "dry-run": true } });
    const frame = t.text();
    assert.ok(
      frame.includes(`◆ ${TITLES.channel}`) &&
        frame.includes("This project loads projectstore from the git marketplace"),
      frame,
    );
    const drawn = flat(
      frame
        .slice(frame.indexOf(`◆ ${TITLES.channel}`))
        .split("◇")[0]
        .replace(/│/g, ""),
    ).replace(/ +/g, " ");
    assert.ok(drawn.includes(CHANNEL_TEXT), drawn);
    assert.ok(
      drawn.includes(
        "● Switch to npm setup and upgrade update it from now on; /plugin update no longer reaches this project",
      ),
      drawn,
    );
    assert.ok(
      drawn.includes(
        "○ Keep the git marketplace /plugin keeps updating it; setup refreshes this project's files through that copy",
      ),
      drawn,
    );
    assert.ok(railOf(t).includes(`◇ ${TITLES.channel}  Switch to npm`), railOf(t).join("\n"));
    assert.equal(r.result.setup.channel, "npm");
    assert.deepEqual(
      r.result.items
        .filter((i) => i.surface === "plugin_others" || i.kind === "binding")
        .map((i) => [i.surface, i.action]),
      [
        ["plugin_others", "disable"],
        ["channel_switch", "add"],
      ],
    );
    // Claude Code unticked: no question, null.
    const u = await setup(sb, { keys: [SPACE, DOWN, SPACE, ENTER], values: { "dry-run": true } });
    assert.ok(!u.t.text().includes(`◆ ${TITLES.channel}`), u.t.text());
    assert.equal(u.r.result.setup.channel, null);
  },
);

test(
  "setup 'The channel': a stub copy newer than the running version makes keep the default, and the switch choice says the stop; Enter plans the keep and no stop; choosing switch with latest at the copy's version stops after the rail",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    bind(sb, { statusline: { enabled: true } });
    withStub(sb, "99.0.0");
    const { r, t } = await setup(sb, { keys: [ENTER, ENTER], values: { "dry-run": true } });
    const flat = t.text().replace(/\n│ +/g, " ");
    assert.ok(
      flat.includes(
        `switching runs ${V} in place of 99.0.0; if 99.0.0 is published, setup stops after these questions and names it`,
      ),
      t.text(),
    );
    assert.match(t.text(), /● Keep the git marketplace/);
    assert.equal(r.result.setup.channel, "git");
    assert.equal(r.result.items.find((i) => i.kind === "channel").action, "update", "the keep");
    assert.equal(r.result.refusals.length, 0, "no stop");
    // Switch, with the registry's latest at the copy's version: the stop, after the rail.
    const env = { ...sb.env, PROJECTSTORE_NO_UPDATE_CHECK: "" };
    const reg = registryFetch({ latest: "99.0.0" });
    const s = await setup(sb, { keys: [ENTER, UP, ENTER], env, fetch: reg.fetch });
    assert.equal(s.r.code, 1);
    assert.equal(reg.calls.length, 1);
    assert.ok(s.t.text().indexOf("└") < s.t.text().indexOf("Plan — refused"), "the stop is after the rail");
    assert.match(
      s.r.result.refusals[0],
      /this project runs projectstore 99\.0\.0 .* and 99\.0\.0 is published\. Nothing is written\./,
    );
    assert.ok(
      s.r.result.refusals[0].split("\n").includes(`npx projectstore@latest setup --harness ${SRC.id}`),
      s.r.result.refusals[0],
    );
    assert.equal(s.asked.length, 0, "nothing asked");
  },
);

test(
  "setup 'The channel': keep plans the keep step and a binding item adding channel_keep; after it the default is keep and Enter-through plans zero changes; unbound with Not now records nothing and says so, and the re-run asks again with switch the default",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    bind(sb, { statusline: { enabled: true } });
    const copy = withStub(sb);
    const { r } = await setup(sb, { keys: [ENTER, DOWN, ENTER] });
    assert.equal(r.code, 0, JSON.stringify(r.result.failed));
    assert.deepEqual(
      r.result.items
        .filter((i) => i.harness === SRC.id && ["channel", "binding"].includes(i.kind))
        .map((i) => [i.kind, i.surface]),
      [
        ["channel", "channel"],
        ["binding", "channel_keep"],
      ],
    );
    assert.equal(bindingOf(sb.proj).channel_keep.by, "setup");
    assert.deepEqual(
      stubCalls(copy).map((c) => c.argv[0]),
      ["plan", "upgrade"],
    );
    const again = await setup(sb, { keys: [ENTER, ENTER] });
    assert.match(
      again.t.text(),
      new RegExp(`● Keep the git marketplace +kept on ${bindingOf(sb.proj).channel_keep.at.slice(0, 10)}`),
    );
    assert.deepEqual(writes(again.r.result.items), [], "zero changes");
    assert.equal(again.r.code, 0);
    // Unbound, "Not now": nothing recorded, said beneath the vault's answer; the re-run asks again, switch the default.
    const ub = sandbox({ codex: false });
    withStub(ub);
    const n = await setup(ub, { keys: [ENTER, DOWN, ENTER, DOWN, DOWN, ENTER] });
    assert.ok(!n.r.result.items.some((i) => i.kind === "binding"), "no channel_keep item");
    const rail = n.t.text().slice(0, n.t.text().indexOf("└"));
    assert.ok(
      rail.endsWith(
        `◇ ${TITLES.channel}  Keep the git marketplace · nothing is recorded: this project has no binding; setup asks again once it is bound\n`,
      ),
      rail,
    );
    assert.ok(
      rail.indexOf(`◇ ${TITLES.vault}  Not now`) < rail.lastIndexOf(`◇ ${TITLES.channel}`),
      "beneath the vault's answer",
    );
    const re = await setup(ub, { keys: [ENTER, CTRL_C] });
    assert.match(re.t.text(), /● Switch to npm/);
  },
);

test("setup 'The channel' without a terminal: no --channel is refused before the plan with the three commands alone on their lines, no host call and no npm; channel_keep reads git; a session running the git copy reads git, its items deferred; --channel npm with only Codex, and --channel nope, exit 2", async () => {
  const sb = sandbox();
  bind(sb, { statusline: { enabled: true } });
  withGitCopy(sb);
  const was = machine(sb);
  const { r, text, npm } = await setup(sb, { values: { harness: [SRC.id] } });
  assert.equal(r.code, 1);
  assert.equal(
    text,
    [
      `Nothing written: this project loads projectstore from the git marketplace (${GIT_COPY}), and moving it to the npm install is a choice made at a terminal in this project:`,
      "",
      `    npx projectstore setup --harness ${SRC.id}`,
      "",
      "Without a terminal, name the channel:",
      "",
      `    npx projectstore setup --harness ${SRC.id} --channel npm`,
      "",
      `    npx projectstore setup --harness ${SRC.id} --channel git`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(r.result.items, []);
  assert.equal(r.result.refusals.length, 1);
  assert.deepEqual(sb.fc.log(), [], "no host call");
  assert.deepEqual(npm.calls, [], "no npm");
  assert.deepEqual(machine(sb), was);
  // channel_keep in the binding: git.
  writeBinding(sb.proj, { ...bindingOf(sb.proj), channel_keep: { by: "setup", at: "2026-10-01T00:00:00.000Z" } });
  const k = await setup(sb, { values: { harness: [SRC.id], "dry-run": true } });
  assert.equal(k.r.result.setup.channel, "git");
  // A session running the git copy: git, its items deferred.
  const ses = sandbox({ codex: false });
  bind(ses, { statusline: { enabled: true } });
  withStub(ses);
  const s = await setup(ses, { env: { ...ses.env, [sessionMarker(SRC)]: "1" }, values: { harness: [SRC.id] } });
  assert.equal(s.r.result.setup.channel, "git");
  const keepRow = s.r.result.items.find((i) => i.kind === "channel");
  assert.equal(keepRow.deferred, true);
  // The keep's deferral names the run as any deferral does (the install
  // spec, contract 6, as amended 2026-10-14): the keep is a setup item.
  // The copy (0.29.0) is behind: its line comes after the prose and before
  // where to run (contract 21, rule 9, as amended 2026-10-14).
  const keepLines = keepRow.reason.split("\n");
  assert.match(keepLines[1], /is older than this package/, keepRow.reason);
  assert.match(keepLines[2], /^From a terminal in ".+":$/, keepRow.reason);
  assert.equal(keepLines[3], `npx projectstore@${V} setup --harness ${SRC.id}`, keepRow.reason);
  // Usage: exit 2.
  const only = await setup(sb, { values: { harness: [CODEX.id], channel: "npm" } });
  assert.equal(only.r.code, 2);
  assert.equal(
    only.r.error,
    `--channel chooses ${SRC.display_name}'s channel; this run does not install ${SRC.display_name}`,
  );
  assert.equal((await setup(sb, { values: { channel: "nope" } })).r.code, 2);
  const err = {
    text: "",
    isTTY: false,
    write(x) {
      this.text += x;
      return true;
    },
  };
  assert.equal(
    await run(["setup", "--channel", "nope", "--project", sb.proj], { env: sb.env, stdout: err, stderr: err }),
    2,
  );
  assert.match(err.text, /--channel takes npm or git, not "nope"/);
});

// ─── Question 4, the vault (rules 7 and 10) ─────────────────────────────

// A git whose init fails as a read-only parent makes it fail (install.test.mjs's stub).
function failingGit() {
  const dir = tmp("ps-setup-fakegit-");
  writeFileSync(
    join(dir, "git"),
    '#!/bin/sh\nif [ "$1" = init ]; then echo "fatal: cannot mkdir .git: Read-only file system" >&2; exit 128; fi\necho "fatal: not a git repository" >&2\nexit 128\n',
    { mode: 0o755 },
  );
  return join(dir, "git");
}
// The scaffold lines a vault's default view lists: one per folder with its README, then the vault's README.
const scaffoldLines = (sp) =>
  sp.rows
    .filter((r) => r.type === "folder")
    .map((r) => `      create ${r.rel}/ and ${r.rel}/README.md`)
    .concat(["      create README.md"]);

test(
  "setup 'The vault: create': Enter at every question plans one vault item, first, listing the mkdir, the binding, $ git init --quiet and every scaffold path; after apply the vault has its .git, folders, READMEs and the binding, its tree outside .git is init's byte for byte, and doctor --install has no vault-git finding; an empty folder is created into without mkdir",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const { r, text } = await setup(sb, { keys: [ENTER, ENTER, ENTER] });
    assert.equal(r.code, 0, text);
    const v = r.result.items[0];
    assert.deepEqual([v.kind, v.harness, v.action, v.path], ["vault", null, "create", sb.vault]);
    const plan = text.slice(text.indexOf("Plan —"), text.indexOf("◆ Apply"));
    const lines = plan.split("\n");
    const at = lines.indexOf("Vault");
    assert.ok(at > 0 && at < lines.indexOf(SRC.display_name), "the Vault group first");
    const sp = planScaffold(sb.vault, { layout: "engineering", language: "en", root: ROOT });
    assert.deepEqual(lines.slice(at + 1, at + 6 + sp.rows.filter((x) => x.type === "folder").length + 1), [
      "  + add  ~/src/acme-vault/  vault",
      "      create ~/src/acme-vault/",
      "      write .projectstore/projectstore.json  (vault_path, layout engineering, language en)",
      "      $ git init --quiet",
      "          in ~/src/acme-vault, with no commit",
      ...scaffoldLines(sp),
    ]);
    assert.ok(existsSync(join(sb.vault, ".git", "HEAD")), "its own repository");
    for (const row of sp.rows) assert.ok(existsSync(row.abs), row.rel);
    assert.equal(bindingOf(sb.proj).vault_path, sb.vault);
    // init's vault, for the same name, layout and language.
    const other = sandbox({ codex: false, claude: false });
    assert.equal(
      applyBind(
        planBind(other.proj, { vault: other.vault, init: true, env: other.env, home: other.home, root: ROOT }),
        { env: other.env },
      ).git.done,
      true,
    );
    assert.deepEqual(treeOf(sb.vault, { git: false }), treeOf(other.vault, { git: false }));
    // doctor --install: no vault-git finding.
    const doctor = spawnSync(
      process.execPath,
      [join(ROOT, "bin", "projectstore.mjs"), "doctor", "--install", "--json", "--project", sb.proj],
      { cwd: sb.proj, env: sb.env, encoding: "utf8", timeout: 60000, maxBuffer: 1 << 24 },
    );
    const found = JSON.parse(doctor.stdout).result;
    assert.ok(
      found.length > 0 && !found.some((f) => f.check === "vault-git"),
      JSON.stringify(found.map((f) => f.check)),
    );
    // An empty folder beside the project: created into, with no mkdir.
    const e = sandbox({ codex: false });
    mkdirSync(e.vault);
    const er = await setup(e, { keys: [ENTER, ENTER, ENTER], values: { "dry-run": true } });
    assert.match(er.t.text(), /● Create ~\/src\/acme-vault\b/);
    assert.deepEqual(
      [er.r.result.items[0].action, er.r.result.items[0].state, er.r.result.items[0].steps[0].kind],
      ["create", "empty", "bind"],
    );
  },
);

test("setup 'The vault: create' with a failing git init: the APPLY line and DONE carry the ▲ rows, the scaffold still runs, ok is false and the exit is 1", async () => {
  const sb = sandbox({ codex: false, git: failingGit() });
  const { r, text } = await setup(sb, { values: { harness: [SRC.id], vault: sb.vault } });
  const message = "fatal: cannot mkdir .git: Read-only file system";
  assert.ok(text.includes(`      ▲ git init failed: ${message}`), text);
  const done = text.slice(text.indexOf("Done — "));
  assert.ok(
    done.startsWith(`Done — `) && done.includes("\nVault\n  ▲ the vault has no git repository: git init failed"),
    done,
  );
  assert.ok(
    flat(done).includes(
      `the vault has no git repository: git init failed (${message}). Run git init in it from a terminal, or doctor's fix in a session, which offers it:`,
    ),
    done,
  );
  assert.ok(
    done.includes(`\n\n    git -C ${sb.vault} init\n    ${invocation(SRC, "doctor", { args: "--fix" })}\n`),
    done,
  );
  assert.ok(existsSync(join(sb.vault, "README.md")), "the scaffold still runs");
  assert.ok(!existsSync(join(sb.vault, ".git")));
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.equal(r.result.setup.vault.git.failed, message);
  // Doctor's fix in the run's own harness's form, never the speaking one's:
  // a Codex-only run names Codex's.
  const cx = sandbox({ claude: false, git: failingGit() });
  const c = await setup(cx, { values: { harness: [CODEX.id], vault: cx.vault } });
  const cd = c.text.slice(c.text.indexOf("Done — "));
  assert.ok(cd.includes("\nVault\n  ▲ the vault has no git repository"), c.text);
  assert.ok(
    cd.includes(`\n\n    git -C ${cx.vault} init\n    ${invocation(CODEX, "doctor", { args: "--fix" })}\n`),
    cd,
  );
  assert.ok(!cd.includes(invocation(SRC, "doctor", { args: "--fix" })), cd);
});

test(
  "setup 'The vault: other cases' at a terminal: a non-empty folder is offered as Use and bound without a byte written in it; a read-only parent offers Another folder… first; a worktree takes its checkout's binding but the channel keys; Not now plans no vault and asks no status line; the path refuses a file and a ~user path inline; a missing layout asks one more confirm",
  RAIL,
  async () => {
    // A non-empty folder beside the project: "Use"; No at the layout's confirm writes nothing in it.
    const sb = sandbox({ codex: false });
    mkdirSync(sb.vault);
    writeFileSync(join(sb.vault, "notes.md"), "mine\n");
    const was = treeOf(sb.vault);
    const u = await setup(sb, { keys: [ENTER, ENTER, DOWN, ENTER, ENTER] });
    assert.equal(u.r.code, 0, u.text);
    assert.match(u.t.text(), /● Use ~\/src\/acme-vault +it already exists; it is bound as it is/);
    assert.ok(u.t.text().includes("~/src/acme-vault has no engineering layout yet. Add its"), "the layout's confirm");
    assert.deepEqual(treeOf(sb.vault), was, "not one byte written inside it");
    assert.equal(bindingOf(sb.proj).vault_path, sb.vault);
    const done = u.text.slice(u.text.indexOf("Done — "));
    assert.ok(
      flat(done).includes(
        "~/src/acme-vault has no engineering layout yet. To add its missing folders and indexes, from a terminal in this project:",
      ),
      done,
    );
    assert.ok(alone(done, `npx projectstore@${V} scaffold --write`), done);
    // Yes at that confirm plans the scaffold rows.
    const y = sandbox({ codex: false });
    mkdirSync(y.vault);
    writeFileSync(join(y.vault, "notes.md"), "mine\n");
    const yr = await setup(y, { keys: [ENTER, ENTER, ENTER, ENTER], values: { "dry-run": true } });
    assert.deepEqual([...new Set(yr.r.result.items[0].steps.map((st) => st.kind))], ["bind", "scaffold"]);
    // A read-only parent: Another folder… first, with the reason.
    if (process.getuid?.() !== 0) {
      const ro = sandbox({ codex: false });
      chmodSync(dirname(ro.proj), 0o555);
      try {
        const rr = await setup(ro, { keys: [ENTER, CTRL_C] });
        assert.match(rr.t.text(), /● Another folder… +~\/src is not writable/);
      } finally {
        chmodSync(dirname(ro.proj), 0o755);
      }
    }
    // Not now: no vault item, no status-line question; DONE prints a bind line per harness, in its host's form.
    const n = sandbox({ ccDir: false });
    const nr = await setup(n, { keys: [ENTER, DOWN, DOWN, ENTER] });
    assert.equal(nr.r.code, 0, nr.text);
    assert.ok(!nr.r.result.items.some((i) => i.kind === "vault"));
    assert.ok(!nr.t.text().includes(TITLES.statusline(SRC.display_name)));
    const nd = nr.text.slice(nr.text.indexOf("Done — "));
    assert.ok(nd.includes(`\n  This project has no vault yet. Bind a vault, in ${SRC.display_name}:\n`), nd);
    for (const m of [SRC, CODEX])
      assert.ok(alone(nd, invocation(m, "bind", { args: "<vault-path>" })), `${m.id}:\n${nd}`);
    assert.deepEqual(
      [SRC, CODEX].map((m) => invocation(m, "bind", { args: "<vault-path>" })),
      ["/projectstore:bind <vault-path>", "$projectstore-bind <vault-path>"],
    );
    // The path question refuses a file and a ~user path inline, and stays open.
    const p = sandbox({ codex: false });
    writeFileSync(join(p.home, "afile"), "x\n");
    const t = tty();
    t.stdin.write([ENTER, DOWN, ENTER].join(""));
    const pending = setup(p, { term: t });
    await until(() => t.text().includes(TITLES.path));
    t.stdin.write(`${join(p.home, "afile")}\r`);
    await until(() => t.text().includes("is a file, not a folder"));
    t.stdin.write(CTRL_C);
    assert.equal((await pending).r.code, 130);
    assert.equal(
      vaultPathRefusal("~nobody/v", p.proj, p.home),
      `~nobody/v: "~user" paths are not expanded — pass the absolute path`,
    );
    assert.equal(vaultPathRefusal(join(p.home, "afile"), p.proj, p.home), "~/afile is a file, not a folder");
    assert.equal(vaultPathRefusal("../fresh", p.proj, p.home), null, "relative to the project, its parent writable");
    chmodSync(join(p.home, "src"), 0o555);
    try {
      if (process.getuid?.() !== 0)
        assert.equal(vaultPathRefusal("../fresh", p.proj, p.home), "~/src is not a writable folder");
    } finally {
      chmodSync(join(p.home, "src"), 0o755);
    }
  },
);

test(
  "setup 'The vault: a worktree': the default copies the main checkout's binding without channel_switch and channel_keep, proposes no sibling, and asks no status line — also with --project, which reads no git top",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    gitInit(sb.proj, sb.env);
    assert.equal(
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"], {
        cwd: sb.proj,
        env: sb.env,
        encoding: "utf8",
      }).status,
      0,
    );
    const wt = join(sb.home, "src", "acme-wt");
    assert.equal(
      spawnSync("git", ["worktree", "add", "-q", "-b", "wt", wt], { cwd: sb.proj, env: sb.env, encoding: "utf8" })
        .status,
      0,
    );
    mkdirSync(join(wt, CC_DIR), { recursive: true });
    mkdirSync(sb.vault);
    const parent = {
      vault_path: sb.vault,
      layout: "engineering",
      language: "en",
      tags: ["x"],
      statusline: { enabled: true },
      channel_switch: { by: "setup", at: "2026-10-01T00:00:00.000Z" },
      channel_keep: { by: "setup", at: "2026-10-02T00:00:00.000Z" },
    };
    writeBinding(sb.proj, parent);
    // Named with --project from elsewhere, at a terminal: no git top is read,
    // and the worktree is still read for the project answered.
    const given = await setup(sb, { cwd: sb.home, keys: [ENTER, ENTER], values: { project: wt, "dry-run": true } });
    assert.deepEqual(given.gitCalls, []);
    assert.match(given.t.text(), /● Use ~\/src\/acme-vault +the vault of ~\/src\/acme, with its settings/);
    assert.ok(!given.t.text().includes("acme-wt-vault"), "no sibling");
    assert.deepEqual(
      given.r.result.items[0].steps.map((st) => [st.kind, st.from]),
      [["bind", sb.proj]],
    );
    const { r, t } = await setup(sb, { cwd: wt, keys: [ENTER, ENTER] });
    assert.equal(r.code, 0, t.text());
    const frame = t.text();
    assert.match(frame, /● Use ~\/src\/acme-vault +the vault of ~\/src\/acme, with its settings/);
    assert.ok(
      !frame.includes("Create ~/src/acme-wt-vault") && !frame.includes(TITLES.statusline(SRC.display_name)),
      "no sibling, no status-line question",
    );
    const v = r.result.items[0];
    assert.deepEqual(
      v.steps.map((st) => [st.kind, st.from, st.drop]),
      [["bind", sb.proj, ["channel_switch", "channel_keep"]]],
    );
    const { channel_switch: _switch, channel_keep: _keep, ...kept } = parent;
    assert.deepEqual(bindingOf(wt), kept);
    assert.deepEqual(readdirSync(sb.vault), [], "the shared vault is not touched");
  },
);

test(
  "setup 'The vault: other cases' bound, and without a terminal: a bound project is shown, not asked, and --vault naming another refuses before the plan with bind <new> --rebind alone on its line, and one that names no folder (~user) is refused as an unbound run refuses it; --vault <missing> creates, --vault <non-empty> binds only, a relative --vault resolves against --project, and no --vault leaves the project unbound",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    bind(sb, { statusline: { enabled: true } });
    const shown = await setup(sb, { keys: [ENTER], values: { "dry-run": true } });
    assert.equal(railOf(shown.t)[6], `◇ ${TITLES.vault}  ~/src/acme-vault · engineering · en`);
    const elsewhere = join(sb.home, "other-vault");
    const was = machine(sb);
    const re = await setup(sb, { values: { harness: [SRC.id], vault: elsewhere } });
    assert.equal(re.r.code, 1);
    assert.equal(
      re.text,
      [
        `this project is bound to ${sb.vault}; setup never rebinds. To point it at ${elsewhere}, from a terminal in this project:`,
        "",
        `    npx projectstore bind ${elsewhere} --rebind`,
        "",
      ].join("\n"),
    );
    assert.deepEqual(re.r.result.items, []);
    assert.deepEqual(machine(sb), was);
    // At a terminal, the refusal follows the rail's end, never inside it.
    const rt = await setup(sb, { keys: [ENTER], values: { vault: elsewhere } });
    assert.equal(rt.r.code, 1);
    assert.ok(
      rt.t.text().indexOf("└") >= 0 && rt.t.text().indexOf("└") < rt.t.text().indexOf("setup never rebinds"),
      rt.t.text(),
    );
    assert.deepEqual(machine(sb), was);
    // The same vault named again changes nothing.
    assert.equal(
      (await setup(sb, { values: { harness: [SRC.id], vault: sb.vault, "dry-run": true } })).r.result.setup.vault,
      null,
    );
    // A --vault that names no folder is refused as an unbound run refuses it, never dropped.
    const tu = await setup(sb, { values: { harness: [SRC.id], vault: "~nobody/v" } });
    assert.equal(tu.r.code, 1);
    assert.equal(tu.text, `~nobody/v: "~user" paths are not expanded — pass the absolute path\n`);
    assert.deepEqual(tu.r.result.items, []);
    assert.deepEqual(machine(sb), was);
    // Without a terminal: a missing one is created, a non-empty one is bound only.
    const m = sandbox({ codex: false });
    const mr = await setup(m, { values: { harness: [SRC.id], vault: m.vault } });
    assert.equal(mr.r.code, 0, mr.text);
    assert.ok(existsSync(join(m.vault, ".git")) && existsSync(join(m.vault, "README.md")));
    const f = sandbox({ codex: false });
    mkdirSync(f.vault);
    writeFileSync(join(f.vault, "notes.md"), "mine\n");
    const fr = await setup(f, { values: { harness: [SRC.id], vault: f.vault } });
    assert.deepEqual(readdirSync(f.vault), ["notes.md"]);
    assert.ok(alone(fr.text, `npx projectstore@${V} scaffold --write`), fr.text);
    // A relative --vault against --project, never the current folder.
    const g = sandbox({ codex: false });
    const elsewhereCwd = tmp("ps-setup-cwd-");
    const gr = await setup(g, {
      cwd: elsewhereCwd,
      values: { project: g.proj, harness: [SRC.id], vault: "../v", "dry-run": true },
    });
    assert.equal(gr.r.result.items[0].path, join(g.home, "src", "v"));
    assert.equal(
      gr.r.result.setup.vault.vault_path,
      join(g.home, "src", "v"),
      "the envelope's vault_path is absolute, never the form typed",
    );
    // No --vault: unbound, and DONE says how to bind.
    const n = sandbox({ codex: false });
    const nr = await setup(n, { values: { harness: [SRC.id] } });
    assert.ok(!existsSync(layoutPaths(n.proj).binding));
    assert.ok(alone(nr.text, invocation(SRC, "bind", { args: "<vault-path>" })), nr.text);
  },
);

// ─── Question 6, the status line (rule 9) ───────────────────────────────

test(
  "setup 'The status line': asked with Claude Code ticked and no flag — yes plans the flag, the entry and the launcher against the registration's install path, and apply wires them; no stores false and wires nothing; not asked over a foreign entry, without Claude Code, with Not now, with the key present, or under keep (DONE names the copy's own command); without a terminal nothing is stored, and the skip names install's --surface command",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const { r, text } = await setup(sb, { keys: [ENTER, ENTER, ENTER] });
    assert.equal(r.code, 0, text);
    const flag = r.result.items.find((i) => i.surface === "statusline_flag");
    // The vault item writes the binding in this run, so the flag changes it
    // (the presentation spec, contract 7 as amended 2026-10-14: one add per file).
    assert.deepEqual([flag.kind, flag.action], ["binding", "update"]);
    const reg = r.result.items.find((i) => i.surface === "plugin");
    for (const k of ["statusline", "statusline_launcher"])
      assert.equal(r.result.items.find((i) => i.surface === k).plannedAgainst, reg.root, k);
    assert.equal(bindingOf(sb.proj).statusline.enabled, true);
    assert.ok(
      JSON.parse(read(join(sb.proj, CC_DIR, "settings.local.json"))).statusLine.command.includes(LAYOUT.root),
      "our entry",
    );
    // No.
    const no = sandbox({ codex: false });
    const nr = await setup(no, { keys: [ENTER, ENTER, DOWN, ENTER] });
    assert.equal(bindingOf(no.proj).statusline.enabled, false);
    assert.equal(nr.r.result.items.find((i) => i.surface === "statusline").state, "opt-out");
    assert.ok(
      !existsSync(join(no.proj, CC_DIR, "settings.local.json")) ||
        !JSON.parse(read(join(no.proj, CC_DIR, "settings.local.json"))).statusLine,
    );
    // Not asked: a foreign entry, without Claude Code, Not now, the key present.
    const asks = async (sbx, keys, values = {}) =>
      (await setup(sbx, { keys, values: { "dry-run": true, ...values } })).t
        .text()
        .includes(TITLES.statusline(SRC.display_name));
    const foreign = sandbox({ codex: false });
    writeFileSync(
      join(foreign.proj, CC_DIR, "settings.local.json"),
      JSON.stringify({ statusLine: { type: "command", command: "echo mine" } }),
    );
    assert.equal(await asks(foreign, [ENTER, ENTER]), false, "a foreign entry");
    assert.equal(await asks(sandbox(), [ENTER, ENTER], { harness: [CODEX.id] }), false, "without Claude Code");
    assert.equal(await asks(sandbox({ codex: false }), [ENTER, DOWN, DOWN, ENTER]), false, "Not now");
    const kp = sandbox({ codex: false });
    bind(kp, { statusline: { enabled: false } });
    assert.equal(await asks(kp, [ENTER]), false, "the key present");
    // Under keep: not asked; DONE names the copy's own command, from invocation().
    const k = sandbox({ codex: false });
    bind(k);
    withStub(k);
    const kr = await setup(k, { keys: [ENTER, DOWN, ENTER] });
    assert.ok(!kr.t.text().includes(TITLES.statusline(SRC.display_name)));
    const kd = kr.text.slice(kr.text.indexOf("Done — "));
    assert.ok(kd.includes(`To show projectstore in the status line, run this in ${SRC.display_name}:`), kd);
    assert.ok(alone(kd, invocation(SRC, "statusline", { args: "on" })), kd);
    assert.equal(invocation(SRC, "statusline", { args: "on" }), "/projectstore:statusline on");
    // Without a terminal: nothing stored, nothing wired.
    const h = sandbox({ codex: false });
    const hr = await setup(h, { values: { harness: [SRC.id], vault: h.vault } });
    assert.equal(bindingOf(h.proj).statusline, undefined);
    assert.ok(!hr.r.result.items.some((i) => i.surface === "statusline_flag"));
    assert.equal(hr.r.result.items.find((i) => i.surface === "statusline").state, "opt-out");
    // Setup takes no --surface: its skip names install's command, which does
    // (rule 9's opt-in, in the core form); install's own words are unchanged.
    assert.equal(
      hr.r.result.items.find((i) => i.surface === "statusline").reason,
      `statusline.enabled is not true in projectstore.json — to wire it anyway: npx projectstore install --harness ${SRC.id} --surface statusline`,
    );
    assert.equal(
      plan(h.proj, { harnesses: [SRC.id], root: ROOT, home: h.home, env: h.env }).items.find(
        (i) => i.surface === "statusline",
      ).reason,
      "statusline.enabled is not true in projectstore.json — name --surface statusline to wire it anyway",
    );
  },
);

// ─── One plan; the keep; the first session (rules 10 and 13) ────────────

test(
  "setup 'One plan, two harnesses': the rail, then the confirm once; one PLAN with the Vault group first, one APPLY, one DONE; both state directories present with no welcome marker and state/.gitignore ours; a second run plans zero changes with the same harness set",
  RAIL,
  async () => {
    // An empty project: both hosts pre-ticked by their CLI and home.
    const sb = sandbox({ ccDir: false });
    const { r, text, asked, npm } = await setup(sb, { keys: [ENTER, ENTER, ENTER] });
    assert.equal(r.code, 0, text);
    assert.equal(asked.length, 1, "the confirm, once");
    assert.equal(text.split("Plan —").length, 2);
    assert.match(asked[0], /^◆ Apply \d+ changes\? \[Y\/n\] $/);
    assert.equal(text.split("\nDone — ").length, 2);
    const plan = text.slice(text.indexOf("Plan —"));
    assert.ok(
      plan.indexOf("\nVault\n") < plan.indexOf(`\n${SRC.display_name}\n`) &&
        plan.indexOf(`\n${SRC.display_name}\n`) < plan.indexOf(`\n${CODEX.display_name}\n`),
    );
    assert.equal(npm.installs().length, 1, "Codex's shell fetched once");
    const lp = layoutPaths(sb.proj);
    for (const m of [SRC, CODEX]) {
      assert.ok(statSync(lp.harnessState(m.id)).isDirectory(), m.id);
      assert.ok(!existsSync(lp.welcomed(m.id)), `${m.id}: no welcome marker`);
    }
    const ignore = read(lp.stateGitignore);
    assert.ok(ignore.includes(RUNTIME_GITIGNORE_HEADER) && ignore.trim().split("\n").at(-1) === "*", ignore);
    // DONE: each harness's next step once, no bind line on a bound result, the tip alone.
    const done = text.slice(text.indexOf("\nDone — "));
    for (const m of [SRC, CODEX])
      for (const s of m.install.next) assert.equal(flat(done).split(s).length, 2, `${m.id}: ${s}`);
    assert.equal(CODEX.install.next.length, 1, "Codex's manifest has one next step");
    assert.ok(!done.includes("<vault-path>"), "bound: no bind line");
    assert.ok(alone(done, "npx projectstore setup --dry-run", 2), done);
    // The second run: zero changes, the same set.
    const again = await setup(sb, { keys: [ENTER] });
    assert.deepEqual(writes(again.r.result.items), [], again.text);
    assert.deepEqual(
      again.r.result.setup.harnesses.filter((h) => h.ticked).map((h) => h.id),
      [SRC.id, CODEX.id],
    );
    assert.equal(again.r.result.gate.why, "nothing-to-do");
    assert.equal(again.r.code, 0);
  },
);

test(
  "setup 'Keep, two harnesses, an empty project': the run's block comes before the keep step, whose touches carry no block rows; after apply AGENTS.md holds one block and CLAUDE.md imports it; a second run plans zero changes",
  RAIL,
  async () => {
    const sb = sandbox({ ccDir: false });
    const copy = withStub(sb, "0.29.0", [
      {
        surface: "agents_block",
        kind: "shared",
        action: "create",
        file: "CLAUDE.md",
        body: "<!-- projectstore:agents v4 the stub's own block -->\n",
      },
      ...STUB_WRITES,
    ]);
    const { r, text } = await setup(sb, { keys: [ENTER, DOWN, ENTER, ENTER] });
    assert.equal(r.code, 0, text);
    const items = r.result.items;
    const block = items.findIndex((i) => i.surface === "agents_block");
    const keep = items.findIndex((i) => i.kind === "channel");
    assert.ok(block >= 0 && keep > block, items.map((i) => i.surface).join(", "));
    assert.deepEqual(
      items[keep].steps[0].touches.map((t) => t.surface).sort(),
      STUB_WRITES.map((w) => w.surface).sort(),
      "no block rows among the keep's touches",
    );
    const agents = read(join(sb.proj, "AGENTS.md"));
    assert.equal(agents.split("<!-- projectstore:agents").length, 2, "one block");
    assert.ok(read(join(sb.proj, "CLAUDE.md")).includes("@AGENTS.md"));
    assert.ok(!read(join(sb.proj, "CLAUDE.md")).includes("the stub's own block"));
    assert.deepEqual(
      stubCalls(copy).map((c) => c.argv[0]),
      ["plan", "upgrade"],
    );
    const again = await setup(sb, { keys: [ENTER, ENTER] });
    assert.deepEqual(writes(again.r.result.items), [], again.text);
    assert.equal(again.r.code, 0);
  },
);

test(
  "setup 'The first session after setup': the SessionStart hook, run as Codex, shows the first-run welcome and writes state/codex/welcomed; on a run with no session, a bare uninstall plans both harnesses and leaves neither state directory, the empty one with no marker step",
  RAIL,
  async () => {
    const sb = sandbox({ ccDir: false });
    assert.equal((await setup(sb, { keys: [ENTER, ENTER, ENTER] })).r.code, 0);
    const env = { ...sb.env, PROJECTSTORE_HARNESS: CODEX.id };
    for (const m of loadHarnesses().values()) if (m.runtime?.project_dir_env) delete env[m.runtime.project_dir_env];
    const hook = spawnSync(process.execPath, [join(ROOT, "hooks", "session-start.mjs")], {
      cwd: sb.proj,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "s-first",
        source: "startup",
        cwd: sb.proj,
      }),
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(hook.stdout.includes("projectstore is loaded for the first time in this project"), hook.stdout);
    assert.ok(existsSync(layoutPaths(sb.proj).welcomed(CODEX.id)), "the marker, in the directory setup made");
    // Another project, set up the same way, no session: a bare uninstall.
    const u = sandbox({ ccDir: false });
    assert.equal((await setup(u, { keys: [ENTER, ENTER, ENTER] })).r.code, 0);
    // Bare, at the terminal double: its one question, answered yes.
    const un = await runVerb("uninstall", u.proj, { env: u.env, home: u.home, root: ROOT, ask: async () => "y" });
    assert.equal(un.gate.confirmed, true, JSON.stringify(un.gate));
    assert.deepEqual(un.plan.harnesses, [SRC.id, CODEX.id]);
    const codexState = un.plan.items.find((i) => i.harness === CODEX.id && i.surface === "harness_state");
    assert.deepEqual(
      codexState.steps.map((st) => st.kind),
      ["rmdir-state"],
      "an empty directory: no marker step",
    );
    assert.equal(un.failed, null, JSON.stringify(un.failed));
    for (const m of [SRC, CODEX])
      assert.ok(
        !existsSync(layoutPaths(u.proj).harnessState(m.id)),
        `${m.id}: ${JSON.stringify(treeOf(layoutPaths(u.proj).state))} ${JSON.stringify(un.plan.items.filter((i) => i.harness === m.id).map((i) => [i.surface, i.action, i.path]))}`,
      );
  },
);

// ─── --dry-run (rule 12) ────────────────────────────────────────────────

test(
  "setup '--dry-run': at a terminal it asks the rail and no confirm, without one it plans --harness or the pre-tick set; both write nothing, call no npm, read no registry, show Codex's version-only row, end with Nothing written: this was a dry run. and exit as plan does; the only child is git rev-parse --show-toplevel, none with --project",
  RAIL,
  async () => {
    for (const mode of ["terminal", "pipe", "pipe, named", "pipe, --project"]) {
      const sb = sandbox({ ccDir: false });
      const was = machine(sb);
      const env = { ...sb.env, PROJECTSTORE_NO_UPDATE_CHECK: "" };
      const reg = registryFetch({ latest: "99.0.0" });
      const values = {
        "dry-run": true,
        ...(mode === "pipe, named" ? { harness: [CODEX.id] } : {}),
        ...(mode === "pipe, --project" ? { project: sb.proj } : {}),
      };
      const { r, text, asked, npm, gitCalls } = await setup(sb, {
        env,
        fetch: reg.fetch,
        values,
        ...(mode === "terminal" ? { keys: [ENTER, ENTER, ENTER] } : {}),
      });
      assert.equal(asked.length, 0, `${mode}: no confirm`);
      assert.deepEqual(r.result.gate, { confirmed: false, why: "dry-run" }, mode);
      assert.ok(text.endsWith("Nothing written: this was a dry run.\n"), `${mode}:\n${text}`);
      assert.equal(r.code, r.result.incomplete ? 1 : 0, mode);
      assert.deepEqual(
        r.result.setup.harnesses.filter((h) => h.ticked).map((h) => h.id),
        mode === "pipe, named" ? [CODEX.id] : [SRC.id, CODEX.id],
        mode,
      );
      assert.deepEqual(machine(sb), was, `${mode}: nothing written`);
      assert.deepEqual(npm.calls, [], `${mode}: no npm`);
      assert.equal(reg.calls.length, 0, `${mode}: no registry read`);
      assert.deepEqual(sb.fc.log(), [], mode);
      assert.deepEqual(sb.fx.log(), [], mode);
      const cx = r.result.items.find((i) => i.harness === CODEX.id && i.kind === "registration");
      assert.ok(
        cx.steps.some((st) => st.kind === "fetch"),
        `${mode}: the version-only row names the fetch it would run`,
      );
      assert.deepEqual(gitCalls, mode === "pipe, --project" ? [] : ["git rev-parse --show-toplevel"], mode);
    }
  },
);

test(
  "setup '--dry-run' under a keep: the stub copy's own plan --json is spawned exactly once, never its upgrade, and its writes are the keep step's touches; nothing else runs",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    bind(sb, { statusline: { enabled: true } });
    const copy = withStub(sb);
    const before = machine(sb);
    const { r, gitCalls, npm } = await setup(sb, { keys: [ENTER, DOWN, ENTER], values: { "dry-run": true } });
    assert.deepEqual(
      stubCalls(copy).map((c) => c.argv[0]),
      ["plan"],
    );
    assert.deepEqual(
      r.result.items.find((i) => i.kind === "channel").steps[0].touches.map((t) => t.surface),
      STUB_WRITES.map((w) => w.surface),
    );
    assert.deepEqual(gitCalls, ["git rev-parse --show-toplevel"]);
    assert.deepEqual(npm.calls, []);
    assert.deepEqual(sb.fc.log(), []);
    const after = machine(sb);
    const log = relative(sb.home, join(copy, "calls.jsonl"));
    delete after.home[log];
    assert.deepEqual(after, before, "nothing written but the stub's own call log");
  },
);

// ─── Inside a host session (rules 13 and 15) ────────────────────────────

test("setup 'Inside a Claude Code session' (its marker, no TTY): --harness claude-code --harness codex --vault <missing> creates the vault, the state directories and the agents block, defers Claude Code's registration, fetches and registers Codex through the fakes, and DONE names what is left with npx projectstore@<v> setup --harness claude-code alone on its line and then restart Claude Code; the exit is 1. In the pre-0.28 layout the move is left too, the state directory is made beside it, doctor still says layout-legacy, and an upgrade from a terminal then migrates", async () => {
  const sb = sandbox({ ccDir: false });
  const env = { ...sb.env, [sessionMarker(SRC)]: "1" };
  const { r, text, npm } = await setup(sb, { env, values: { harness: [SRC.id, CODEX.id], vault: sb.vault } });
  assert.equal(r.code, 1);
  assert.equal(r.result.incomplete, true);
  assert.ok(existsSync(join(sb.vault, ".git")) && existsSync(join(sb.vault, "README.md")), "the vault");
  for (const m of [SRC, CODEX]) assert.ok(existsSync(layoutPaths(sb.proj).harnessState(m.id)), m.id);
  assert.ok(read(join(sb.proj, "AGENTS.md")).includes("<!-- projectstore:agents"), "the agents block");
  const cc = r.result.items.find((i) => i.harness === SRC.id && i.surface === "plugin");
  assert.deepEqual([cc.action, cc.deferred], ["skip", true]);
  // Its reason names the run (the install spec, contract 6, as amended
  // 2026-10-14): the prose, where, then the command alone — in PLAN too.
  const [, where, run, ...rest] = cc.reason.split("\n");
  assert.match(where, /^From a terminal in ".+":$/, cc.reason);
  assert.equal(run, `npx projectstore@${V} setup --harness ${SRC.id}`, cc.reason);
  assert.deepEqual(rest, []);
  const planned = text.slice(0, text.indexOf("\nDone — ")).split("\n");
  const at = planned.findIndex((l) => l.trim() === run);
  assert.ok(at > 0 && planned[at - 1].trim() === "" && planned[at] === planned[at].trimEnd(), text);
  assert.deepEqual(sb.fc.log(), [], "no claude call");
  assert.equal(npm.installs().length, 1, "Codex's shell is fetched");
  assert.ok(
    sb.fx.log().some((c) => c.argv.join(" ").startsWith("plugin add")),
    "and registered",
  );
  const done = text.slice(text.indexOf("\nDone — "));
  assert.ok(
    done.includes(
      `Left for a terminal outside this ${SRC.display_name} session: the plugin registration. From a terminal in this project, run:\n\n    npx projectstore@${V} setup --harness ${SRC.id}\n\n  then restart ${SRC.display_name}.`,
    ),
    done,
  );
  // A project in the pre-0.28 layout: the layout move is left too, and said so.
  const lg = sandbox({ codex: false });
  mkdirSync(lg.vault);
  const lp = layoutPaths(lg.proj);
  writeFileSync(
    lp.legacy.binding,
    JSON.stringify({ vault_path: lg.vault, layout: "engineering", statusline: { enabled: false } }),
  );
  writeFileSync(lp.legacy.welcomed, "");
  const l = await setup(lg, { env: { ...lg.env, [sessionMarker(SRC)]: "1" }, values: { harness: [SRC.id] } });
  assert.equal(l.r.result.items.find((i) => i.kind === "layout").deferred, true);
  assert.ok(
    flat(l.text).includes(
      `Left for a terminal outside this ${SRC.display_name} session: the plugin registration, the layout move.`,
    ),
    l.text,
  );
  // The state directory is made in the new layout while the move waits; it
  // is no second binding, so doctor still names the legacy layout alone.
  assert.ok(statSync(lp.harnessState(SRC.id)).isDirectory());
  assert.ok(!existsSync(lp.binding));
  assert.deepEqual(
    checkLayout(lg.proj, SRC, { root: ROOT, home: lg.home }).map((f) => f.check),
    ["layout-legacy"],
  );
  // From a terminal, an upgrade then moves the rest in beside it: the welcome marker lands in state/<id>/.
  const up = await runVerb("upgrade", lg.proj, {
    harnesses: [SRC.id],
    root: ROOT,
    home: lg.home,
    env: lg.env,
    ask: async () => "y",
    fetchSpawn: fakeNpmSpawn().spawn,
  });
  assert.equal(up.failed, null, JSON.stringify(up.failed));
  assert.equal(up.plan.items.find((i) => i.kind === "layout" && i.surface === "layout").action, "migrate");
  assert.ok(existsSync(lp.welcomed(SRC.id)), "the marker, in the directory setup made");
  assert.ok(!existsSync(lp.legacy.binding) && !existsSync(lp.legacy.welcomed));
  assert.deepEqual(checkLayout(lg.proj, SRC, { root: ROOT, home: lg.home }), []);
});

test("setup 'Inside a Codex session' (its deferral variable, no TTY): Codex's fetch and registration defer and npm is never called, DONE names npx projectstore@<v> setup --harness codex; Claude Code's registration proceeds through the fake host, and the layout move is not deferred by that variable", async () => {
  const sb = sandbox({ ccDir: false });
  mkdirSync(sb.vault);
  mkdirSync(join(sb.proj, CC_DIR));
  writeFileSync(
    join(sb.proj, CC_DIR, "projectstore.json"),
    JSON.stringify({ vault_path: sb.vault, layout: "engineering", statusline: { enabled: false } }),
  );
  const env = { ...sb.env, [deferMarker(CODEX)]: "thread-1" };
  const { r, text, npm } = await setup(sb, { env, values: { harness: [SRC.id, CODEX.id] } });
  assert.equal(r.code, 1);
  assert.deepEqual(npm.calls, [], "no npm");
  assert.deepEqual(sb.fx.log(), [], "no codex call");
  const cx = r.result.items.find((i) => i.harness === CODEX.id && i.kind === "registration");
  assert.equal(cx.deferred, true);
  assert.ok(
    sb.fc.log().some((c) => c.argv.slice(0, 2).join(" ") === "plugin install"),
    "Claude Code's registration ran",
  );
  assert.equal(
    r.result.items.find((i) => i.kind === "layout" && i.surface === "layout").action,
    "migrate",
    "the layout move is not deferred",
  );
  assert.ok(
    existsSync(layoutPaths(sb.proj).binding) && !existsSync(join(sb.proj, CC_DIR, "projectstore.json")),
    "and it ran",
  );
  const done = text.slice(text.indexOf("\nDone — "));
  assert.ok(alone(done, `npx projectstore@${V} setup --harness ${CODEX.id}`), done);
  assert.ok(
    flat(done).includes(`Left for a terminal outside this ${CODEX.display_name} session: the plugin registration.`),
    done,
  );
});

test("setup inside a session, with Claude Code's channel answered: DONE repeats --channel npm for Claude Code alone, and never the keep — a Codex session's command, after a recorded keep or a --channel npm, carries no --channel and runs; a bare run's refusal repeats --channel on Claude Code's line alone", async () => {
  const leftCommand = (text, m) =>
    text
      .slice(text.indexOf("\nDone — "))
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`npx projectstore@${V} setup --harness ${m.id}`));
  const inCodex = (sb) => ({ ...sb.env, [deferMarker(CODEX)]: "thread-1" });
  // A Codex session, the keep recorded: the channel is git, from the record.
  const k = sandbox();
  bind(k, { statusline: { enabled: true }, channel_keep: { by: "setup", at: "2026-10-01T00:00:00.000Z" } });
  withStub(k);
  const kr = await setup(k, { env: inCodex(k), values: { harness: [SRC.id, CODEX.id] } });
  assert.equal(kr.r.result.setup.channel, "git");
  assert.equal(kr.r.result.items.find((i) => i.harness === CODEX.id && i.kind === "registration").deferred, true);
  assert.equal(leftCommand(kr.text, CODEX), `npx projectstore@${V} setup --harness ${CODEX.id}`, kr.text);
  assert.ok(alone(kr.text, `npx projectstore@${V} setup --harness ${CODEX.id}`), kr.text);
  // …and that command runs from a terminal: the bin's parse takes it, no usage error.
  const again = await cli(k, [...leftCommand(kr.text, CODEX).split(" ").slice(2), "--dry-run"]);
  assert.notEqual(again.code, 2, again.text);
  assert.ok(again.text.endsWith("Nothing written: this was a dry run.\n"), again.text);
  // A Codex session with --channel npm: the switch is Claude Code's; Codex's command names none.
  const n = sandbox();
  bind(n, { statusline: { enabled: true } });
  withGitCopy(n);
  const nr = await setup(n, { env: inCodex(n), values: { harness: [SRC.id, CODEX.id], channel: "npm" } });
  assert.equal(nr.r.result.setup.channel, "npm");
  assert.equal(leftCommand(nr.text, CODEX), `npx projectstore@${V} setup --harness ${CODEX.id}`, nr.text);
  // A Claude Code session with --channel npm: its own command repeats the answer (rule 13).
  const c = sandbox({ codex: false });
  bind(c, { statusline: { enabled: true } });
  withGitCopy(c);
  const cr = await setup(c, {
    env: { ...c.env, [sessionMarker(SRC)]: "1" },
    values: { harness: [SRC.id], channel: "npm" },
  });
  assert.ok(alone(cr.text, `npx projectstore@${V} setup --harness ${SRC.id} --channel npm`), cr.text);
  // The deferred row's reason names the same run, from the same builder.
  const crow = cr.r.result.items.find((i) => i.harness === SRC.id && i.surface === "plugin");
  assert.equal(
    crow.reason.split("\n").at(-1),
    `npx projectstore@${V} setup --harness ${SRC.id} --channel npm`,
    crow.reason,
  );
  const krow = kr.r.result.items.find((i) => i.harness === CODEX.id && i.kind === "registration");
  assert.equal(krow.reason.split("\n").at(-1), `npx projectstore@${V} setup --harness ${CODEX.id}`, krow.reason);
  // A Claude Code session running the git copy: the keep is recorded, not repeated.
  const s = sandbox({ codex: false });
  bind(s, { statusline: { enabled: true } });
  withStub(s);
  const sr = await setup(s, { env: { ...s.env, [sessionMarker(SRC)]: "1" }, values: { harness: [SRC.id] } });
  assert.equal(sr.r.result.setup.channel, "git");
  assert.equal(leftCommand(sr.text, SRC), `npx projectstore@${V} setup --harness ${SRC.id}`, sr.text);
  // A bare run's refusal, --channel given: repeated on Claude Code's line alone.
  const b = sandbox();
  bind(b, { statusline: { enabled: true } });
  withGitCopy(b);
  mkdirSync(layoutPaths(b.proj).harnessState(CODEX.id), { recursive: true });
  const br = await setup(b, { values: { channel: "npm" } });
  assert.equal(br.r.result.gate.why, "non-tty", br.text);
  assert.ok(
    br.text.endsWith(
      [
        "",
        `    npx projectstore setup --harness ${SRC.id} --channel npm`,
        `    npx projectstore setup --harness ${CODEX.id}`,
        "",
      ].join("\n"),
    ),
    br.text,
  );
});

// ─── Idempotence (rule 14) ──────────────────────────────────────────────

test(
  "setup 'Idempotence': after a switch, at the terminal double and without a terminal with the same flags, the second run plans nothing to change and the logging fake host records no call; the same after a keep",
  RAIL,
  async () => {
    // At a terminal: the checklist, then the channel (switch, its default).
    const t = sandbox({ codex: false });
    bind(t, { statusline: { enabled: true } });
    withGitCopy(t);
    assert.equal((await setup(t, { keys: [ENTER, ENTER] })).r.code, 0);
    assert.equal(bindingOf(t.proj).channel_switch.by, "setup");
    t.fc.reset();
    const again = await setup(t, { keys: [ENTER] });
    assert.ok(!again.t.text().includes(`◆ ${TITLES.channel}`), "the copy is off: no question");
    assert.equal(again.r.result.gate.why, "nothing-to-do", again.text);
    assert.ok(again.text.includes("Nothing to change."));
    assert.deepEqual(t.fc.log(), []);
    // Without a terminal, the same flags twice.
    const h = sandbox({ codex: false });
    bind(h, { statusline: { enabled: true } });
    withGitCopy(h);
    const flags = { harness: [SRC.id], channel: "npm" };
    assert.equal((await setup(h, { values: flags })).r.code, 0);
    h.fc.reset();
    const second = await setup(h, { values: flags });
    assert.equal(second.r.result.gate.why, "nothing-to-do");
    assert.equal(second.r.code, 0);
    assert.deepEqual(h.fc.log(), []);
    // After a keep.
    const k = sandbox({ codex: false });
    bind(k, { statusline: { enabled: true } });
    withStub(k);
    assert.equal((await setup(k, { keys: [ENTER, DOWN, ENTER] })).r.code, 0);
    k.fc.reset();
    const kept = await setup(k, { keys: [ENTER, ENTER] });
    assert.equal(kept.r.result.gate.why, "nothing-to-do", kept.text);
    assert.deepEqual(k.fc.log(), []);
    // After a keep, without a terminal, the same flags twice.
    const kh = sandbox({ codex: false });
    bind(kh, { statusline: { enabled: true } });
    const copy = withStub(kh);
    const keepFlags = { harness: [SRC.id], channel: "git" };
    assert.equal((await setup(kh, { values: keepFlags })).r.code, 0);
    assert.equal(bindingOf(kh.proj).channel_keep.by, "setup");
    kh.fc.reset();
    const keptAgain = await setup(kh, { values: keepFlags });
    assert.equal(keptAgain.r.result.gate.why, "nothing-to-do", keptAgain.text);
    assert.deepEqual(writes(keptAgain.r.result.items), []);
    assert.equal(keptAgain.r.code, 0);
    assert.deepEqual(kh.fc.log(), []);
    assert.deepEqual(
      stubCalls(copy).map((c) => c.argv[0]),
      ["plan", "upgrade", "plan"],
      "the second run reads the copy's plan and runs nothing of it",
    );
  },
);

test("setup 'Idempotence' on the two-harness fixture, without a terminal: the same flags twice — the second run plans nothing to change, neither fake host records a call, and its harness set equals the first's", async () => {
  const sb = sandbox({ ccDir: false });
  const flags = { harness: [SRC.id, CODEX.id], vault: sb.vault };
  const first = await setup(sb, { values: flags });
  assert.equal(first.r.code, 0, first.text);
  sb.fc.reset();
  const codexCalls = sb.fx.log().length;
  const second = await setup(sb, { values: flags });
  assert.equal(second.r.result.gate.why, "nothing-to-do", second.text);
  assert.deepEqual(writes(second.r.result.items), []);
  assert.equal(second.r.code, 0);
  assert.deepEqual(sb.fc.log(), []);
  assert.equal(sb.fx.log().length, codexCalls);
  const set = (r) => r.result.setup.harnesses.map((h) => [h.id, h.ticked]);
  assert.deepEqual(set(second.r), set(first.r));
  assert.deepEqual(set(second.r), [
    [SRC.id, true],
    [CODEX.id, true],
  ]);
  // Bare, the second run's pre-ticked set is the same: the state directories hold it.
  const bare = await setup(sb, { values: { "dry-run": true } });
  assert.deepEqual(set(bare.r), set(first.r));
});

test(
  "setup 'Idempotence': a binding from before setup — autoupdate_asked, no statusline key — plans zero changes without a terminal; at one it asks only the status-line question, plus the channel with a git copy enabled, and plans zero changes after those answers",
  RAIL,
  async () => {
    const sb = sandbox({ codex: false });
    const flags = { harness: [SRC.id], vault: sb.vault };
    assert.equal((await setup(sb, { values: flags })).r.code, 0);
    const old = { ...bindingOf(sb.proj), autoupdate_asked: true };
    delete old.statusline;
    writeBinding(sb.proj, old);
    const headless = await setup(sb, { values: flags });
    assert.equal(headless.r.result.gate.why, "nothing-to-do", headless.text);
    assert.deepEqual(bindingOf(sb.proj), old, "nothing stored without a person");
    // At a terminal, the harness named: only the status line is asked.
    withGitCopy(sb);
    const asked = await setup(sb, { keys: [ENTER, ENTER], values: { harness: [SRC.id] } });
    const questions = asked.t.text().match(/◆ [^\n]+/g);
    assert.deepEqual(questions, [`◆ ${TITLES.channel}`, `◆ ${TITLES.statusline(SRC.display_name)}`], asked.t.text());
    assert.equal(asked.r.code, 0, asked.text);
    const after = await setup(sb, { values: { harness: [SRC.id] }, keys: [], term: tty() });
    assert.equal(after.r.result.gate.why, "nothing-to-do", after.text);
    assert.ok(!(after.t.text().match(/◆ /g) || []).length, "nothing asked any more");
  },
);

// ─── Retired, and the package (rules 17 and 18) ─────────────────────────

test("setup 'Retired': commands/bind.md has no auto-update step and no autoupdate_asked, its status-line step is 11, its step 0a drops channel_switch and channel_keep; the Codex render's --check passes; package.json gains no dependency and engines stays >=20.0.0", () => {
  const bind = read(join(ROOT, "commands", "bind.md"));
  assert.ok(!/autoupdate_asked|Auto-update reminder/.test(bind), "the step and its stamp are gone");
  assert.match(bind, /\n11\. \*\*Status line offer\*\*/);
  assert.ok(!/\n12\. /.test(bind), "no step 12");
  const step0a = bind.slice(bind.indexOf("\n0a. "), bind.indexOf("\n1. "));
  assert.match(step0a, /without `channel_switch` and `channel_keep`/);
  assert.ok(!/auto-update/.test(step0a));
  const check = spawnSync(process.execPath, [join(ROOT, "scripts", "build-adapters.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(JSON.parse(check.stdout).ok, true);
  assert.equal(PKG.dependencies, undefined);
  assert.equal(PKG.engines.node, ">=20.0.0");
  // The verb's own module is loaded lazily: the bin's table imports it only to run it.
  const cli = read(join(ROOT, "scripts", "cli.mjs"));
  assert.ok(!/^import .*"\.\/setup\.mjs";$/m.test(cli) && /await import\("\.\/setup\.mjs"\)/.test(cli));
});

test("setup's pure decisions: the channel's table (rule 6), the vault's first choice (rule 7) and the status line's preconditions (rule 9)", () => {
  const others = [{ key: GIT_COPY, version: "0.27.1" }];
  assert.deepEqual(decideChannel({ inSet: false, others }), { asked: false, value: null, why: "none" });
  assert.deepEqual(decideChannel({ inSet: true, others: [] }), { asked: false, value: null, why: "none" });
  assert.deepEqual(decideChannel({ inSet: true, others, flag: "git" }), { asked: false, value: "git", why: "flag" });
  assert.equal(
    decideChannel({ inSet: true, others, interactive: true, running: "0.30.0", selected: { version: "0.27.1" } })
      .default,
    "npm",
  );
  assert.equal(
    decideChannel({ inSet: true, others, interactive: true, running: "0.30.0", selected: { version: "0.31.0" } })
      .default,
    "git",
  );
  assert.equal(
    decideChannel({
      inSet: true,
      others,
      interactive: true,
      running: "0.30.0",
      selected: { version: "0.27.1" },
      kept: { by: "setup", at: "2026-10-01T00:00:00Z" },
    }).choices[1].reason,
    "kept on 2026-10-01",
  );
  assert.deepEqual(decideChannel({ inSet: true, others, inSession: true, sessionCopy: { channel: "marketplace" } }), {
    asked: false,
    value: "git",
    why: "session",
  });
  assert.deepEqual(decideChannel({ inSet: true, others, kept: { by: "setup", at: "x" } }), {
    asked: false,
    value: "git",
    why: "recorded",
  });
  assert.deepEqual(decideChannel({ inSet: true, others }), { asked: false, value: null, refuse: true });
  const home = "/h";
  const first = (sibling, worktree = null) => vaultChoices({ sibling, worktree, layout: "engineering", home })[0];
  assert.deepEqual(first({ path: "/h/src/a-vault", state: "missing", writable: true }), {
    value: "create",
    label: "Create ~/src/a-vault",
    reason: "a new vault beside the project: its own git repository, with the engineering folders",
  });
  assert.equal(first({ path: "/h/src/a-vault", state: "empty", writable: true }).value, "create");
  assert.deepEqual(first({ path: "/h/src/a-vault", state: "full" }), {
    value: "use",
    label: "Use ~/src/a-vault",
    reason: "it already exists; it is bound as it is",
  });
  assert.deepEqual(
    [
      first({ path: "/h/src/a-vault", state: "missing", writable: false }).value,
      first({ path: "/h/src/a-vault", state: "missing", writable: false }).reason,
    ],
    ["other", "~/src is not writable"],
  );
  assert.equal(
    first({ path: "/h/src/a-vault", state: "missing", writable: true }, { main: "/h/src/a", vault: "/h/v" }).reason,
    "the vault of ~/src/a, with its settings",
  );
  assert.deepEqual(
    vaultChoices({
      sibling: { path: "/h/src/a-vault", state: "missing", writable: true },
      layout: "engineering",
      home,
    }).map((x) => x.value),
    ["create", "other", "none"],
  );
  assert.deepEqual(
    vaultChoices({
      sibling: { path: "/h/src/a-vault", state: "missing", writable: false },
      layout: "engineering",
      home,
    }).map((x) => x.value),
    ["other", "none"],
  );
  const base = { inSet: true, leaves: true, stored: undefined, slot: "ours-absent", channel: null };
  assert.deepEqual(decideStatusline(base), { asked: true });
  for (const [k, v] of [
    ["inSet", false],
    ["leaves", false],
    ["stored", true],
    ["stored", false],
    ["slot", "theirs"],
  ])
    assert.deepEqual(decideStatusline({ ...base, [k]: v }), { asked: false }, `${k}=${v}`);
  assert.deepEqual(decideStatusline({ ...base, channel: "git" }), { asked: false, underKeep: true });
  // siblingOf reads the folder beside the project.
  const sb = sandbox({ claude: false, codex: false });
  assert.deepEqual(siblingOf(sb.proj), { path: sb.vault, state: "missing", writable: true });
  mkdirSync(sb.vault);
  assert.equal(siblingOf(sb.proj).state, "empty");
  writeFileSync(join(sb.vault, "x"), "");
  assert.equal(siblingOf(sb.proj).state, "full");
  void hostPresence;
});

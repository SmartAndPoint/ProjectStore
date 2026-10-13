// projectstore — tests/configure.test.mjs: the configure verb (the spec
// "Changing a project's settings after setup: the configure verb, its setting
// set and one writer per key", PS-HARNESS). Each contract is tested through
// runConfigure in process, or the bin's own run(); every refusal compares the
// project's and the vault's files before and after.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { runConfigure, settingsOf, readFacts } from "../scripts/configure.mjs";
import { menuGroups, runMenu } from "../scripts/configure-menu.mjs";
import { knownModels } from "../scripts/models.mjs";
import { ALT_ON, ALT_OFF } from "../scripts/term.mjs";
import { nextVaultConfig, layoutPaths } from "../scripts/lib.mjs";
import { sourceHarness, loadHarness } from "../scripts/harness.mjs";
import { run } from "../scripts/cli.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { fakePackageRoot } from "./fixtures/install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CODEX = loadHarness("codex");
const KEYS = { DOWN: "\x1b[B", RIGHT: "\x1b[C", LEFT: "\x1b[D", ENTER: "\r", SPACE: " ", CTRL_C: "\x03" };
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));

// A bound project and its vault. `harnesses` makes each harness's directory
// (`.claude/`) or, for a harness with none in the project, its state
// directory, so detection finds it; `binding` adds keys to the binding.
function project({ harnesses = [SRC], binding = {}, vaultCfg = null, epics = [] } = {}) {
  const proj = tmp("ps-cfg-");
  const vault = tmp("ps-cfg-vault-");
  for (const e of epics) mkdirSync(join(vault, "epics", e), { recursive: true });
  for (const h of harnesses)
    if (h === SRC) mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
    else mkdirSync(layoutPaths(proj).harnessState(h.id), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", ...binding });
  if (vaultCfg !== null) writeFileSync(join(vault, ".projectstore.json"), vaultCfg);
  return { proj, vault, home: tmp("ps-cfg-home-") };
}

// Every file under the project and the vault, with its bytes: the "nothing
// written" check every refusal makes.
function tree(...dirs) {
  const out = {};
  const walk = (base, d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(base, p);
      else out[`${base}:${relative(base, p)}`] = read(p);
    }
  };
  for (const d of dirs) walk(d, d);
  return out;
}

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (s) => (chunks.push(String(s)), true), text: () => chunks.join("") };
};

// One run in process, without a terminal unless `term` is given.
async function configure(
  p,
  values = {},
  { term = null, answer = "y", root = ROOT, env = {}, fetch = null, spawn = null } = {},
) {
  const out = term ? term.stdout : sink();
  const err = sink();
  const asked = [];
  const r = await runConfigure({
    values,
    project: p.proj,
    env,
    stdin: term ? term.stdin : null,
    stdout: out,
    stderr: err,
    ask: term
      ? async (q) => {
          asked.push(q);
          return answer;
        }
      : null,
    root,
    home: p.home,
    proc: term ? term.proc : new EventEmitter(),
    escapeMs: 20,
    ...(fetch ? { fetch } : {}),
    ...(spawn ? { spawn } : {}),
    nearest: (w, names) => names.find((n) => n.startsWith(w.slice(0, 4))) || null,
  });
  return { r, text: term ? term.text() : out.text(), err: err.text(), asked };
}

// The TTY double setup's tests use: stdin a PassThrough that says it is a
// terminal; stdout an 80-column terminal sink.
function tty(keys = []) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => ((stdin.isRaw = on), stdin);
  const chunks = [];
  const stdout = { isTTY: true, columns: 80, write: (s) => (chunks.push(String(s)), true) };
  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true });
  if (keys.length) stdin.write(keys.join(""));
  return { stdin, stdout, proc, text: () => chunks.join("") };
}

// ─── Contract 2 and 3: the set, and the view ───────────────────────────

test("configure contract 2: the set's classes — changeable, other-verb — and the surfaces only where a harness has them", () => {
  const cc = project();
  const keys = settingsOf(readFacts(cc.proj, { root: ROOT, home: cc.home }));
  const byKey = Object.fromEntries(keys.map((s) => [s.key, s]));
  assert.equal(byKey.vault.class, "other-verb");
  assert.equal(byKey.layout.class, "other-verb");
  for (const k of [
    "agents.default",
    "agents.critic",
    "statusline",
    "band",
    "language",
    "active_skills",
    "auto_inject",
    "default_author",
    "tags",
    "spec_policy",
    "lifecycle_gates",
  ])
    assert.equal(byKey[k]?.class, "changeable", k);
  for (const k of ["approval_mode", "updates", "channel_switch", "spec_policy_since", "band.hint_seen"])
    assert.equal(byKey[k], undefined, `${k} is not a setting`);
  assert.equal(byKey["agents.critic"].team, true, "the overlay is committed");
  assert.equal(byKey.lifecycle_gates.value, "not set", "an absent gate reads as not set, with source default");
  const codexOnly = project({ harnesses: [CODEX] });
  const ck = settingsOf(readFacts(codexOnly.proj, { root: ROOT, home: codexOnly.home })).map((s) => s.key);
  assert.ok(!ck.includes("statusline") && !ck.includes("band"), "a Codex-only project has no status line or band");
  assert.ok(ck.includes("agents.default"), "but it has its overlay");
});

test("configure contract 3: without a terminal and without --set it prints the view and writes nothing; --json carries result.settings", async () => {
  const p = project({ binding: { language: "ru" } });
  const before = tree(p.proj, p.vault);
  const { r, text } = await configure(p);
  assert.equal(r.code, 0);
  assert.deepEqual(tree(p.proj, p.vault), before, "nothing written");
  assert.match(text, /^projectstore configure/);
  assert.match(text, /Agents · Claude Code/);
  assert.match(text, /Vault and templates/);
  assert.match(text, /\n {2}language +ru +binding\n/);
  assert.match(text, /\n {2}npx projectstore configure --set <key>=<value>\n/, "each command alone on its line");
  const j = await configure(p, { json: true });
  assert.equal(j.text, "", "--json prints nothing itself: the bin writes the envelope");
  const lang = j.r.result.settings.find((s) => s.key === "language");
  assert.deepEqual(
    { value: lang.value, source: lang.source, class: lang.class, team: lang.team, set: lang.set },
    { value: "ru", source: "binding", class: "changeable", team: false, set: "--set language=<language>" },
  );
});

// ─── Contract 5, 7, 8: the writers ─────────────────────────────────────

test("configure contract 5: binding keys are written by the one writer, which keeps every other key", async () => {
  const p = project({ binding: { custom: { x: 1 }, band: { enabled: false }, statusline: { enabled: true } } });
  const { r } = await configure(p, {
    set: ["language=de", "tags=a, b", "active_skills=off", "auto_inject=off", "default_author=Ann"],
  });
  assert.equal(r.code, 0);
  const b = json(layoutPaths(p.proj).binding);
  assert.equal(b.language, "de");
  assert.deepEqual(b.tags, ["a", "b"]);
  assert.equal(b.active_skills, false);
  assert.equal(b.auto_inject, false);
  assert.equal(b.default_author, "Ann");
  assert.deepEqual(b.custom, { x: 1 }, "a key no writer owns is kept");
  assert.deepEqual(b.band, { enabled: false });
  assert.deepEqual(b.statusline, { enabled: true });
  const again = await configure(p, { set: ["language=de"] });
  assert.equal(again.r.code, 0);
  assert.match(again.text, /Nothing to change/);
  const fresh = project();
  const before = tree(fresh.proj, fresh.vault);
  const same = await configure(fresh, { set: ["language=en", "active_skills=on"] });
  assert.match(same.text, /Nothing to change/, "a value already in effect by default is no change");
  assert.deepEqual(tree(fresh.proj, fresh.vault), before);
});

test("configure contract 7: the stamp — set on a change to required, kept on required again and on optional, set anew on a return", () => {
  const t1 = "2026-01-01T00:00:00.000Z";
  const t2 = "2026-02-01T00:00:00.000Z";
  const a = nextVaultConfig({}, { spec_policy: "required" }, t1);
  assert.equal(a.spec_policy_since, t1, "absent → required stamps");
  assert.equal(nextVaultConfig(a, { spec_policy: "required" }, t2).spec_policy_since, t1, "required again keeps");
  const b = nextVaultConfig(a, { spec_policy: "optional" }, t2);
  assert.equal(b.spec_policy_since, t1, "optional keeps the stamp");
  const c = nextVaultConfig(b, { spec_policy: "required" }, t2);
  assert.equal(c.spec_policy_since, t2, "a return re-stamps, so the exemption only grows");
  assert.equal(nextVaultConfig({ x: 1 }, { lifecycle_gates: "on" }, t1).x, 1, "every other key is kept");
});

test("configure contract 7: the vault config is written with its stamp and kept keys; a corrupt one and a missing vault refuse with nothing written", async () => {
  const p = project({ vaultCfg: JSON.stringify({ keep: true }) });
  const { r, text } = await configure(p, { set: ["spec_policy=required", "lifecycle_gates=on"] });
  assert.equal(r.code, 0);
  const v = json(join(p.vault, ".projectstore.json"));
  assert.equal(v.spec_policy, "required");
  assert.equal(v.lifecycle_gates, "on", "the gate is stored in the form its key uses on disk");
  assert.equal(v.keep, true);
  assert.match(v.spec_policy_since, /^\d{4}-\d\d-\d\dT/);
  assert.match(text, /team change/);
  assert.match(text, /stories closed before now are exempt/);
  const bad = project({ vaultCfg: "{not json" });
  const before = tree(bad.proj, bad.vault);
  const refused = await configure(bad, { set: ["spec_policy=required"] });
  assert.equal(refused.r.code, 1);
  assert.match(refused.r.message, /is not valid JSON/);
  assert.deepEqual(tree(bad.proj, bad.vault), before);
  const gone = project();
  writeBinding(gone.proj, { vault_path: join(gone.vault, "missing"), layout: "engineering" });
  const g = await configure(gone, { set: ["lifecycle_gates=off"] });
  assert.equal(g.r.code, 1);
  assert.match(g.r.message, /does not exist/);
});

test("configure contract 8: agents keys go through the agents core — the clerk pin, clearing, and the overlay named when two harnesses share the project", async () => {
  const p = project();
  const { r, text } = await configure(p, { set: ["agents.default=opus", "agents.critic.model=fable"] });
  assert.equal(r.code, 0);
  const o = json(layoutPaths(p.proj).overlay(SRC.id));
  assert.equal(o.agents.default.model, "opus");
  assert.equal(o.agents.per_agent.critic.model, "fable");
  assert.equal(o.agents.per_agent.clerk.model, "sonnet", "the clerk pin, as agents configure applies it");
  assert.match(text, /pinned: the clerk stays cheap/);
  await configure(p, { set: ["agents.critic=-"] });
  assert.equal(json(layoutPaths(p.proj).overlay(SRC.id)).agents.per_agent.critic, undefined, "- clears");
  const two = project({ harnesses: [SRC, CODEX] });
  const before = tree(two.proj, two.vault);
  const u = await configure(two, { set: ["agents.critic=fable"] });
  assert.equal(u.r.code, 2);
  assert.match(u.r.usage, /name the overlay: --harness <id>/);
  assert.deepEqual(tree(two.proj, two.vault), before);
  const named = await configure(two, { set: ["agents.critic=gpt-x"], harness: [CODEX.id] });
  assert.equal(named.r.code, 0);
  assert.equal(json(layoutPaths(two.proj).overlay(CODEX.id)).agents.per_agent.critic.model, "gpt-x");
  const ignored = await configure(project(), { set: ["language=fr"], harness: [SRC.id] });
  assert.equal(ignored.r.code, 0, "--harness with no agents key is accepted and ignored (a shell always names it)");
});

// ─── Contract 6: the status line ───────────────────────────────────────

test("configure contract 6: statusline=on wires the line and records the flag; off removes it and records off; a foreign slot refuses", async () => {
  const p = project();
  const on = await configure(p, { set: ["statusline=on"] });
  assert.equal(on.r.code, 0, on.text + on.r.message);
  assert.equal(json(layoutPaths(p.proj).binding).statusline.enabled, true);
  const settings = join(p.proj, SRC.runtime.harness_dir, "settings.local.json");
  assert.ok(json(settings).statusLine, "the entry is wired");
  assert.match(on.text, /restart Claude Code in this project/, "DONE names the restart");
  const off = await configure(p, { set: ["statusline=off"] });
  assert.equal(off.r.code, 0);
  assert.equal(json(layoutPaths(p.proj).binding).statusline.enabled, false);
  assert.equal(json(settings).statusLine, undefined, "our entry is removed");
  const foreign = project();
  mkdirSync(join(foreign.proj, SRC.runtime.harness_dir), { recursive: true });
  writeFileSync(
    join(foreign.proj, SRC.runtime.harness_dir, "settings.local.json"),
    JSON.stringify({ statusLine: { type: "command", command: "node /x/hud.mjs" } }),
  );
  const before = tree(foreign.proj, foreign.vault);
  const f = await configure(foreign, { set: ["statusline=on", "language=ru"] });
  assert.equal(f.r.code, 1);
  assert.match(f.r.message, /owns the slot/);
  assert.deepEqual(tree(foreign.proj, foreign.vault), before, "refused at PLAN: the binding key is not written either");
  const codexOnly = project({ harnesses: [CODEX] });
  const c = await configure(codexOnly, { set: ["statusline=on"] });
  assert.equal(c.r.code, 2);
  assert.match(c.r.usage, /statusline is a surface of Claude Code; this project uses Codex/);
});

// ─── Contract 11: refusals ─────────────────────────────────────────────

test("configure contract 11: usage errors exit 2 and write nothing", async () => {
  const p = project({ epics: ["PS-ONE"] });
  const before = tree(p.proj, p.vault);
  const cases = [
    [["langage=ru"], /unknown setting langage — did you mean language\?/],
    [["language=xx"], /language takes de, en, es, fr, ru, zh, got xx/],
    [["language=ru", "language=en"], /language is named twice/],
    [["vault=/x"], /the vault is changed by rebind[^\n]*:\nnpx projectstore bind <vault> --rebind$/],
    [["layout=x"], /changing it means a new vault/],
    [["agents.bogus=x"], /no agent named bogus in the engineering roster/],
    [["band.epic=NOPE"], /band\.epic takes PS-ONE, got NOPE/],
    [["active_skills=maybe"], /active_skills takes on or off/],
    [["approval_mode=never"], /unknown setting approval_mode/],
    [["agents.critic.effort=high"], /unknown setting agents\.critic\.effort/],
    [["foo"], /--set takes <key>=<value>, got foo/],
  ];
  for (const [set, re] of cases) {
    const { r } = await configure(p, { set });
    assert.equal(r.code, 2, set.join(" "));
    assert.match(r.usage, re, set.join(" "));
  }
  const two = await configure(p, { set: ["band=on"], harness: [SRC.id, CODEX.id] });
  assert.equal(two.r.code, 2);
  assert.deepEqual(tree(p.proj, p.vault), before, "nothing written by any of them");
});

test("configure contract 11: the refusals decided at PLAN write nothing — an unparseable overlay or settings file, a pending layout move, a root never wired, a Codex-only status line, a missing vault", async () => {
  const check = async (p, values, code, re, opts = {}) => {
    const before = tree(p.proj, p.vault);
    const { r } = await configure(p, values, opts);
    assert.equal(r.code, code, JSON.stringify(values));
    assert.match(r.message || r.usage || "", re, JSON.stringify(values));
    assert.deepEqual(tree(p.proj, p.vault), before, `nothing written: ${JSON.stringify(values)}`);
  };
  const overlay = project();
  mkdirSync(dirname(layoutPaths(overlay.proj).overlay(SRC.id)), { recursive: true });
  writeFileSync(layoutPaths(overlay.proj).overlay(SRC.id), "{not json");
  await check(overlay, { set: ["agents.critic=fable"] }, 1, /is not valid JSON/);
  const settings = project();
  writeFileSync(join(settings.proj, SRC.runtime.harness_dir, "settings.local.json"), "{ // a comment\n}");
  await check(settings, { set: ["statusline=on"] }, 1, /settings\.local\.json: /);
  await check(settings, { set: ["statusline=off"] }, 1, /settings\.local\.json: /);
  const legacy = project();
  mkdirSync(join(legacy.proj, SRC.runtime.harness_dir, ".projectstore"), { recursive: true });
  await check(
    legacy,
    { set: ["statusline=on"] },
    1,
    /layout from before 0\.28[^\n]*:\nnpx projectstore upgrade --harness /,
  );
  await check(legacy, { set: ["statusline=off"] }, 1, /layout from before 0\.28/);
  const npx = fakePackageRoot(join(tmp("ps-cfg-npx-"), "node_modules", "projectstore"), "0.30.0");
  await check(
    project(),
    { set: ["statusline=on"] },
    1,
    /cannot be wired from this copy[^\n]*In a session in this project:\n\/projectstore:statusline on\nOr register the package[^\n]*:\nnpx projectstore setup$/,
    { root: npx },
  );
  await check(project({ harnesses: [CODEX] }), { set: ["statusline=on"] }, 2, /a surface of Claude Code/);
  const gone = project();
  writeBinding(gone.proj, { vault_path: join(gone.vault, "missing"), layout: "engineering" });
  await check(gone, { set: ["lifecycle_gates=off"] }, 1, /does not exist/);
});

test("configure contracts 1 and 11: an unbound project exits 3 with the bin's not-bound text; a corrupt binding exits 1", async () => {
  const empty = tmp("ps-cfg-empty-");
  const out = sink();
  const code = await run(["configure", "--project", empty], {
    env: {},
    cwd: empty,
    stdin: null,
    stdout: out,
    stderr: out,
  });
  assert.equal(code, 3);
  assert.match(out.text(), /is not bound to a vault/);
  assert.match(out.text(), /\nnpx projectstore init <vault>\n/);
  const p = project();
  writeFileSync(layoutPaths(p.proj).binding, "{broken");
  const before = tree(p.proj, p.vault);
  const { r } = await configure(p, { set: ["language=ru"] });
  assert.equal(r.code, 1);
  assert.match(r.message, /is not valid JSON/);
  assert.deepEqual(tree(p.proj, p.vault), before);
});

test("configure: --dry-run shows the PLAN and writes nothing; the bin's --json envelope carries plan and wrote", async () => {
  const p = project();
  const before = tree(p.proj, p.vault);
  const { r, text } = await configure(p, { set: ["language=ru"], "dry-run": true });
  assert.equal(r.code, 0);
  assert.match(text, /Plan — 1 change/);
  assert.match(text, /Nothing written: this was a dry run/);
  assert.deepEqual(tree(p.proj, p.vault), before);
  const out = sink();
  const code = await run(["configure", "--set", "language=ru", "--json", "--project", p.proj], {
    env: {},
    cwd: p.proj,
    stdin: null,
    stdout: out,
    stderr: sink(),
  });
  assert.equal(code, 0);
  const env = JSON.parse(out.text());
  assert.equal(env.verb, "configure");
  assert.deepEqual(
    env.result.plan.map((i) => [i.key, i.before, i.after]),
    [["language", "en", "ru"]],
  );
  assert.deepEqual(env.result.wrote, [".projectstore/projectstore.json"]);
});

// ─── Contract 4: at a terminal, the settings menu (amended 2026-10-13) ──

// A terminal that types in stages: the first stage at once, each later one
// when the screen has drawn what it waits for since the stage before — so a
// key meant for the review is typed after the review is on screen, as a
// person types it.
function screenTty(stages, { columns = 100, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => ((stdin.isRaw = on), stdin);
  const chunks = [];
  let since = "";
  const queue = stages.slice();
  // A later stage is typed 30 ms after its screen, as a person types: the
  // review drops what reaches the terminal in the turns right after its draw.
  let first = true;
  const feed = () => {
    const s = queue.shift();
    since = "";
    if (!s) return;
    const type = () => stdin.write(s.keys.join(""));
    if (first) setImmediate(type);
    else setTimeout(type, 30);
    first = false;
  };
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (x) => {
      chunks.push(String(x));
      since += String(x);
      if (queue.length && queue[0].after && queue[0].after.test(since.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) feed();
      return true;
    },
  });
  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true });
  feed();
  const text = () => chunks.join("");
  // What stays in the scrollback: everything after the alternate screen is left.
  const after = () =>
    text()
      .split(ALT_OFF)
      .at(-1)
      .replace(/\x1b\[[0-9;]*m/g, "");
  return { stdin, stdout, proc, text, after };
}

const agentsIndex = (p, name) =>
  settingsOf(readFacts(p.proj, { root: ROOT, home: p.home }))
    .filter((s) => s.group.startsWith("agents:"))
    .findIndex((s) => s.key === `agents.${name}`);

test("configure contract 4 (amended 2026-10-13): the menu changes an agent's model behind the review's second Enter; the scrollback holds the PLAN and DONE, no frame", async () => {
  const p = project();
  const down = Array(agentsIndex(p, "critic")).fill(KEYS.DOWN);
  const t = screenTty([
    { keys: [KEYS.RIGHT, ...down, KEYS.RIGHT, "o", KEYS.SPACE, KEYS.ENTER] },
    { after: /Plan — 1 change/, keys: [KEYS.ENTER] },
  ]);
  const { r, asked } = await configure(p, {}, { term: t });
  assert.equal(r.code, 0, t.after());
  assert.equal(json(layoutPaths(p.proj).overlay(SRC.id)).agents.per_agent.critic.model, "opus");
  assert.equal(asked.length, 0, "the review's Enter is the confirmation: no line-mode question");
  assert.equal(t.text().split(ALT_ON).length - 1, 1, "the alternate screen is entered once");
  assert.equal(t.text().split(ALT_OFF).length - 1, 1, "and left once");
  assert.match(t.after(), /Plan — 1 change[\s\S]*agents\.critic[\s\S]*Done — 1 change/);
  assert.doesNotMatch(t.after(), /[╭╮╰╯]/, "no frame is left in the scrollback");
  assert.doesNotMatch(t.text(), /To change a setting/, "no view is printed first");
  assert.equal(t.stdin.isRaw, false);
});

test("configure contract 4 (amended 2026-10-13): an Enter queued with the one that opens the review is not the second", async () => {
  const p = project({ harnesses: [] });
  const before = tree(p.proj, p.vault);
  const t = screenTty([
    { keys: [KEYS.RIGHT, "l", "l", KEYS.RIGHT, "r", KEYS.ENTER, KEYS.ENTER] },
    { after: /Plan — 1 change/, keys: [KEYS.CTRL_C] },
  ]);
  const { r } = await configure(p, {}, { term: t });
  assert.equal(r.code, 130);
  assert.match(t.after(), /Cancelled — nothing was written/);
  assert.deepEqual(tree(p.proj, p.vault), before);
});

test("configure contract 4 (amended 2026-10-13): ← back from the review keeps the change, and the next review writes it", async () => {
  const p = project({ harnesses: [] });
  const t = screenTty([
    { keys: [KEYS.RIGHT, "l", "l", KEYS.RIGHT, "r", KEYS.ENTER] },
    { after: /Plan — 1 change/, keys: [KEYS.LEFT] },
    { after: /1 change waiting/, keys: [KEYS.ENTER] },
    { after: /Plan — 1 change/, keys: [KEYS.ENTER] },
  ]);
  const { r } = await configure(p, {}, { term: t });
  assert.equal(r.code, 0, t.after());
  assert.equal(json(layoutPaths(p.proj).binding).language, "ru");
});

test("configure contract 4 (amended 2026-10-13): ← at the groups with nothing changed leaves; Ctrl+C cancels; both write nothing and restore the terminal", async () => {
  const p = project();
  const before = tree(p.proj, p.vault);
  const a = screenTty([{ keys: [KEYS.LEFT] }]);
  const ra = await configure(p, {}, { term: a });
  assert.equal(ra.r.code, 0);
  assert.match(a.after(), /No change — nothing was written/);
  const b = screenTty([{ keys: [KEYS.RIGHT, KEYS.DOWN, KEYS.CTRL_C] }]);
  const rb = await configure(p, {}, { term: b });
  assert.equal(rb.r.code, 130);
  assert.match(b.after(), /Cancelled — nothing was written/);
  for (const t of [a, b]) {
    assert.equal(t.stdin.isRaw, false);
    assert.match(t.text(), /\x1b\[\?25h\x1b\[\?1049l/, "the cursor shown and the alternate screen left");
  }
  assert.deepEqual(tree(p.proj, p.vault), before);
});

test("configure contract 4 (amended 2026-10-13): --dry-run stops at the first Enter, prints the PLAN and writes nothing", async () => {
  const p = project({ harnesses: [] });
  const before = tree(p.proj, p.vault);
  const t = screenTty([{ keys: [KEYS.RIGHT, "l", "l", KEYS.RIGHT, "r", KEYS.ENTER] }]);
  const { r } = await configure(p, { "dry-run": true }, { term: t });
  assert.equal(r.code, 0);
  assert.match(t.after(), /Plan — 1 change[\s\S]*language[\s\S]*Nothing written: this was a dry run/);
  assert.deepEqual(tree(p.proj, p.vault), before);
});

test("configure contract 4 (amended 2026-10-13): a terminal below 40×16 prints the view, as without one", async () => {
  const p = project();
  const t = screenTty([], { columns: 30, rows: 30 });
  const { r } = await configure(p, {}, { term: t });
  assert.equal(r.code, 0);
  assert.doesNotMatch(t.text(), /\x1b\[\?1049h/, "no alternate screen");
  assert.match(t.text(), /To change a setting/);
});

test("configure contract 2 (amended 2026-10-13): Claude Code's model list is its four aliases with no free text; Codex's is its own catalog", async () => {
  const p = project({ harnesses: [SRC, CODEX] });
  const codexHome = tmp("ps-cfg-codex-");
  writeFileSync(
    join(codexHome, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-10-13T06:32:57Z",
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier.", visibility: "list", priority: 2 },
        {
          slug: "gpt-6.1-sol",
          display_name: "GPT-6.1-Sol",
          description: "Workhorse.",
          visibility: "list",
          priority: 1,
        },
        { slug: "gpt-reserve", display_name: "GPT-Reserve", description: "Hidden.", visibility: "hide", priority: 3 },
      ],
    }),
  );
  const f = readFacts(p.proj, { root: ROOT, home: p.home, env: { CODEX_HOME: codexHome } });
  const settings = settingsOf(f);
  const catalogs = Object.fromEntries(
    f.used.map((h) => [h.id, { known: knownModels(h, { env: { CODEX_HOME: codexHome }, home: p.home }) }]),
  );
  const groups = menuGroups(f, settings, catalogs);
  const optionsOf = (title, key) =>
    groups
      .find((g) => g.title === title)
      .items.find((i) => i.key === key)
      .options();
  const cc = optionsOf("Agents · Claude Code", "agents.critic");
  assert.deepEqual(
    cc.filter((o) => o.kind === "value" && o.value).map((o) => o.value),
    ["fable", "opus", "sonnet", "haiku"],
  );
  assert.equal(
    cc.some((o) => o.kind === "text"),
    false,
    "no free text where the spawn takes aliases",
  );
  const cx = optionsOf("Agents · Codex", "agents.critic");
  assert.deepEqual(
    cx.filter((o) => o.kind === "value" && o.value).map((o) => o.value),
    ["gpt-6.1-sol", "gpt-6-astra"],
  );
  assert.equal(cx.find((o) => o.value === "gpt-6.1-sol").description, "GPT-6.1-Sol. Workhorse.");
  assert.ok(
    cx.some((o) => o.kind === "text"),
    "Codex takes a typed name",
  );
  const caption = groups.find((g) => g.title === "Agents · Codex").items[0].caption();
  assert.match(caption.text, /^Codex · checked /);
});

test("configure contract 4 (amended 2026-10-13): opening a stale model list starts one read, in the background, that names what each alias follows", async () => {
  const p = project();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, key: init?.headers?.["x-api-key"] });
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: "claude-fable-5-1",
            display_name: "Claude Fable 5.1",
            created_at: "2026-08-28T00:00:00Z",
            line: "fable",
            lifecycle: "active",
          },
        ],
      }),
    };
  };
  const t = screenTty([{ keys: [KEYS.RIGHT, KEYS.RIGHT] }, { after: /→ claude-fable-5-1/, keys: [KEYS.CTRL_C] }]);
  const env = { ANTHROPIC_API_KEY: "sk-test", XDG_CACHE_HOME: join(p.home, "cache") };
  const { r } = await configure(p, {}, { term: t, env, fetch });
  assert.equal(r.code, 130);
  assert.equal(calls.length, 1, "one read");
  assert.equal(calls[0].key, "sk-test");
  const cache = read(join(p.home, "cache", "projectstore", "models", `${SRC.id}.json`));
  assert.doesNotMatch(cache, /sk-test/);
});

// A terminal a test drives step by step: it waits for what the screen draws,
// types 30 ms later as a person would, and resizes. setRawMode is recorded.
function driver({ columns = 100, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const raw = [];
  stdin.setRawMode = (on) => (raw.push(on), (stdin.isRaw = on), stdin);
  const chunks = [];
  const waiters = new Set();
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (x) => {
      chunks.push(String(x));
      for (const w of [...waiters]) w();
      return true;
    },
  });
  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true });
  const text = () => chunks.join("");
  let mark = 0;
  const waitFor = (re) =>
    new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        const screen = text()
          .split("\x1b[H")
          .at(-1)
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        fail(new Error(`no ${re} on the screen:\n${screen}`));
      }, 5000);
      const check = () => {
        const since = text()
          .slice(mark)
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        if (!re.test(since)) return;
        waiters.delete(check);
        clearTimeout(timer);
        mark = text().length;
        ok();
      };
      waiters.add(check);
      check();
    });
  const type = (...keys) =>
    new Promise((ok) =>
      setTimeout(() => {
        stdin.write(keys.join(""));
        ok();
      }, 30),
    );
  const resize = (c, r) => {
    stdout.columns = c;
    stdout.rows = r;
    stdout.emit("resize");
  };
  const after = () =>
    text()
      .split(ALT_OFF)
      .at(-1)
      .replace(/\x1b\[[0-9;]*m/g, "");
  return { stdin, stdout, proc, raw, text, waitFor, type, resize, after };
}

test("configure contract 4 (amended 2026-10-13): raw mode is held from the menu's open to its close, once", async () => {
  const p = project({ harnesses: [] });
  const t = driver();
  const run = configure(p, {}, { term: t });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, "l", "l", KEYS.RIGHT, "r", KEYS.ENTER);
  await t.waitFor(/Plan — 1 change/);
  await t.type(KEYS.ENTER);
  const { r } = await run;
  assert.equal(r.code, 0);
  assert.deepEqual(t.raw, [true, false], "on at open, off at close, and nothing between");
});

test("configure contract 8 (amended 2026-10-13): a name typed in the menu off Codex's list carries the note in the review, the PLAN and --json", async () => {
  const p = project({ harnesses: [CODEX] });
  const codexHome = tmp("ps-cfg-codex-");
  writeFileSync(
    join(codexHome, "models_cache.json"),
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      models: [
        {
          slug: "gpt-6.1-sol",
          display_name: "GPT-6.1-Sol",
          description: "Workhorse.",
          visibility: "list",
          priority: 1,
        },
      ],
    }),
  );
  const down = Array(agentsIndex(p, "critic")).fill(KEYS.DOWN);
  const t = driver();
  const run = configure(p, { json: false }, { term: t, env: { CODEX_HOME: codexHome } });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, ...down, KEYS.RIGHT, "t", KEYS.RIGHT);
  await t.waitFor(/typing/);
  await t.type("gpt-x", KEYS.ENTER, KEYS.ENTER);
  await t.waitFor(/not in Codex's list as of/);
  await t.type(KEYS.ENTER);
  const { r } = await run;
  assert.equal(r.code, 0, t.after());
  assert.match(t.after(), /agents\.critic[\s\S]*not in Codex's list as of \d{4}-\d\d-\d\d; written as typed/);
  assert.match(r.result.plan[0].note, /^not in Codex's list as of/);
  assert.equal(json(layoutPaths(p.proj).overlay(CODEX.id)).agents.per_agent.critic.model, "gpt-x");
});

test("configure contract 4 (amended 2026-10-13): a refusal at the review is drawn there, has no Enter, and Ctrl+C leaves with nothing written", async () => {
  const p = project({ harnesses: [] });
  rmSync(p.vault, { recursive: true, force: true });
  const before = tree(p.proj);
  const t = driver();
  const run = configure(p, {}, { term: t });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.DOWN, KEYS.RIGHT, KEYS.RIGHT, KEYS.DOWN, KEYS.ENTER);
  await t.waitFor(/the vault [\s\S]*not exist[\s\S]*← back to the menu/);
  assert.doesNotMatch(t.text().split("\x1b[H").at(-1), /enter writes it/);
  await t.type(KEYS.ENTER, KEYS.CTRL_C);
  const { r } = await run;
  assert.equal(r.code, 130);
  assert.deepEqual(tree(p.proj), before);
});

test("configure contract 4 (amended 2026-10-13): a resize redraws at the new width — the staircase, then one frame — and a terminal made too small takes no key but Ctrl+C", async () => {
  const p = project({ harnesses: [] });
  const before = tree(p.proj, p.vault);
  const t = driver();
  const run = configure(p, {}, { term: t });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT);
  await t.waitFor(/╭─ Settings[\s\S]*╭─ Vault and templates/);
  t.resize(80, 30);
  await t.waitFor(/Settings › Vault and templates/);
  assert.doesNotMatch(t.text().split("\x1b[H").at(-1), /╭─ Settings/, "one frame below 100 columns");
  await t.type("l", "l", KEYS.RIGHT, "r", KEYS.SPACE);
  await t.waitFor(/1 change waiting/);
  t.resize(30, 10);
  await t.waitFor(/The menu needs 40 columns/);
  await t.type(KEYS.ENTER, KEYS.ENTER);
  await new Promise((ok) => setTimeout(ok, 50));
  await t.type(KEYS.CTRL_C);
  const { r } = await run;
  assert.equal(r.code, 130, "Enter did nothing while the terminal was too small");
  assert.deepEqual(tree(p.proj, p.vault), before);
});

test("configure contract 4 (amended 2026-10-13): a throw in the menu restores the terminal and goes on as the error", async () => {
  const p = project({ harnesses: [] });
  const t = driver();
  const f = readFacts(p.proj, { root: ROOT, home: p.home });
  const run = runMenu({
    f,
    settings: settingsOf(f),
    stdin: t.stdin,
    stdout: t.stdout,
    caps: { color: false, live: true, width: 100, columns: 100, ascii: false },
    proc: t.proc,
    env: {},
    home: p.home,
    review: () => {
      throw new Error("boom");
    },
  });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, "l", "l", KEYS.RIGHT, "r", KEYS.ENTER);
  await assert.rejects(run, /boom/);
  assert.equal(t.stdin.isRaw, false);
  assert.ok(t.text().endsWith(`\x1b[?25h${ALT_OFF}`));
  assert.equal(t.proc.listenerCount("SIGINT"), 0);
});

test("configure contract 4 (amended 2026-10-13): no read at open; a fresh list is not read again; refresh reads once; a failed read keeps the list and caches nothing", async () => {
  const p = project();
  const calls = [];
  const spawned = [];
  let status = 200;
  const fetch = async (url) => {
    calls.push(url);
    return status === 200
      ? {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "claude-opus-5-5",
                display_name: "Claude Opus 5.5",
                created_at: "2026-09-21T00:00:00Z",
                line: "opus",
                lifecycle: "active",
              },
            ],
          }),
        }
      : { ok: false, status, body: { cancel: async () => {} } };
  };
  const spawn = () => {
    spawned.push(1);
    throw new Error("no spawn in this test");
  };
  const env = { ANTHROPIC_API_KEY: "k", XDG_CACHE_HOME: join(p.home, "cache") };
  const cache = join(p.home, "cache", "projectstore", "models", `${SRC.id}.json`);
  // Open to the settings level: nothing is read.
  let t = driver();
  let run = configure(p, {}, { term: t, env, fetch, spawn });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, KEYS.DOWN);
  await t.waitFor(/critic/);
  await t.type(KEYS.CTRL_C);
  await run;
  assert.deepEqual([calls.length, spawned.length], [0, 0], "no request and no subprocess before a model list opens");
  // A failed read: the list stays, the caption says why, nothing is cached.
  status = 401;
  t = driver();
  run = configure(p, {}, { term: t, env, fetch, spawn });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, KEYS.RIGHT);
  await t.waitFor(/the key was refused \(HTTP 401\)/);
  assert.match(t.text().split("\x1b[H").at(-1), /fable[\s\S]*opus[\s\S]*sonnet[\s\S]*haiku/);
  await t.type(KEYS.CTRL_C);
  await run;
  assert.equal(existsSync(cache), false);
  // A good read is cached; opening the list again does not read.
  status = 200;
  t = driver();
  run = configure(p, {}, { term: t, env, fetch, spawn });
  await t.waitFor(/What do you want to change/);
  await t.type(KEYS.RIGHT, KEYS.RIGHT);
  await t.waitFor(/Anthropic API · checked today/);
  await t.type(KEYS.LEFT, KEYS.RIGHT);
  await t.waitFor(/↻ refresh the list/);
  const before = calls.length;
  // refresh the list reads, fresh or not.
  await t.type("r", KEYS.RIGHT);
  await t.waitFor(/asking api\.anthropic\.com/);
  await t.waitFor(/Anthropic API · checked today/);
  await t.type(KEYS.CTRL_C);
  await run;
  assert.equal(before, 2, "the 401 and the first good read; reopening a fresh list read nothing");
  assert.equal(calls.length, 3, "refresh read once");
  assert.equal(spawned.length, 0);
});

test("configure contract 4 (amended 2026-10-13): every group, setting and value has a description", () => {
  const p = project({ harnesses: [SRC, CODEX], epics: ["PS-ONE"] });
  const f = readFacts(p.proj, { root: ROOT, home: p.home });
  const catalogs = Object.fromEntries(f.used.map((h) => [h.id, { known: knownModels(h, { env: {}, home: p.home }) }]));
  const groups = menuGroups(f, settingsOf(f), catalogs);
  const missing = [];
  for (const g of groups) {
    if (!g.description) missing.push(g.title);
    for (const it of g.items) {
      if (!it.describe || !it.describe(it.value, false)) missing.push(`${g.title} › ${it.label}`);
      if (it.kind === "choice")
        for (const o of it.options()) if (!o.description) missing.push(`${g.title} › ${it.label} › ${o.label}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("configure contract 8 (amended 2026-10-13): a model off the list is written with the PLAN's note, and --json carries it as note", async () => {
  const p = project();
  const text = await configure(p, { set: ["agents.critic=claude-opus-5-5"] });
  assert.equal(text.r.code, 0, text.text);
  assert.match(
    text.text,
    /claude-opus-5-5 is not one of Claude Code's aliases \(fable, opus, sonnet, haiku\); written as typed, and Claude Code refuses it at spawn/,
  );
  const q = project();
  const env = await configure(q, { set: ["agents.critic=claude-opus-5-5"], json: true });
  assert.match(env.r.result.plan[0].note, /not one of Claude Code's aliases/);
  const ok = await configure(project(), { set: ["agents.critic=opus", "language=ru"], json: true });
  assert.ok(
    ok.r.result.plan.every((i) => !("note" in i)),
    "no note where none applies: every other item reads as before",
  );
});

test("configure contract 4: a cancel exits 130 with nothing written; a declined confirmation writes nothing", async () => {
  const p = project({ harnesses: [] });
  const before = tree(p.proj, p.vault);
  const c = await configure(p, {}, { term: tty([KEYS.CTRL_C]) });
  assert.equal(c.r.code, 130);
  assert.deepEqual(tree(p.proj, p.vault), before);
  const d = await configure(p, { set: ["language=ru"] }, { term: tty(), answer: "n" });
  assert.equal(d.r.code, 1);
  assert.match(d.text, /Nothing written/);
  assert.deepEqual(tree(p.proj, p.vault), before);
});

// ─── The module's place, and the texts (contract 9) ─────────────────────

test("configure: the bin loads the module on first use only", () => {
  const cli = read(join(ROOT, "scripts", "cli.mjs"));
  assert.doesNotMatch(cli, /^import [^;]*"\.\/configure\.mjs";/m, "no static import");
  assert.match(cli, /await import\("\.\/configure\.mjs"\)/);
});

test("configure contract 9: no bundled command or agent writes a changeable key with Write or Edit; bind's step 0a copy is the one exemption", () => {
  const KEYS_WRITTEN =
    /\b(statusline\.enabled|"statusline"|spec_policy|lifecycle_gates|active_skills|auto_inject|default_author)\b/;
  const WRITES = /\b(Write|Edit)\b/;
  const found = [];
  for (const dir of ["commands", "agents"]) {
    for (const n of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".md"))) {
      const lines = read(join(ROOT, dir, n)).split("\n");
      lines.forEach((l, k) => {
        if (KEYS_WRITTEN.test(l) && WRITES.test(l) && !/step 0a|the inherit path/i.test(l))
          found.push(`${dir}/${n}:${k + 1}: ${l.trim().slice(0, 140)}`);
      });
    }
  }
  assert.deepEqual(found, []);
  for (const n of readdirSync(join(ROOT, "commands")).filter((x) => x.endsWith(".md")))
    assert.doesNotMatch(read(join(ROOT, "commands", n)), /`Edit`s/, `commands/${n} edits a file a writer owns`);
  assert.ok(existsSync(join(ROOT, "commands", "statusline.md")));
});

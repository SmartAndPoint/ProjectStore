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
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { runConfigure, settingsOf, readFacts } from "../scripts/configure.mjs";
import { nextVaultConfig, layoutPaths } from "../scripts/lib.mjs";
import { sourceHarness, loadHarness } from "../scripts/harness.mjs";
import { run } from "../scripts/cli.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { fakePackageRoot } from "./fixtures/install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const CODEX = loadHarness("codex");
const KEYS = { DOWN: "\x1b[B", ENTER: "\r", SPACE: " ", CTRL_C: "\x03" };
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
async function configure(p, values = {}, { term = null, answer = "y", root = ROOT } = {}) {
  const out = term ? term.stdout : sink();
  const err = sink();
  const asked = [];
  const r = await runConfigure({
    values,
    project: p.proj,
    env: {},
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

// ─── Contract 4: at a terminal ─────────────────────────────────────────

test("configure contract 4: at a terminal the view, a checklist, one select per ticked key, one PLAN and one confirmation", async () => {
  // No harness in the project: the checklist is language, active_skills,
  // auto_inject, spec_policy, lifecycle_gates. Tick the first, then pick ru
  // from de, en, es, fr, ru, zh, starting at en.
  const p = project({ harnesses: [] });
  const t = tty([KEYS.SPACE, KEYS.ENTER, KEYS.DOWN, KEYS.DOWN, KEYS.DOWN, KEYS.ENTER]);
  const { r, asked, text } = await configure(p, {}, { term: t });
  assert.equal(r.code, 0, text);
  assert.equal(json(layoutPaths(p.proj).binding).language, "ru");
  assert.equal(asked.length, 1, "one confirmation");
  assert.match(asked[0], /Apply 1 change\?/);
  assert.match(text, /What do you want to change\?/);
  assert.doesNotMatch(text, /restart/, "nothing to restart for a language");
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

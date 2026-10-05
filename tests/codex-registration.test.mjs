import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan, apply, publicItem, renderPreview, runVerb } from "../scripts/install-harness.mjs";
import { surfaceStates } from "../scripts/surfaces.mjs";
import { checkHarnessSurfaces, checkPluginRegistration } from "../scripts/doctor.mjs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("..", import.meta.url));

function fixture(version = "0.28.0+codex.dev.one") {
  const base = mkdtempSync(join(tmpdir(), "ps-codex-registration-"));
  const home = join(base, "home"), project = join(base, "project"), root = join(base, "shell"), bin = join(base, "bin");
  for (const dir of [home, project, root, bin, join(root, ".codex-plugin"), join(root, "skills", "projectstore-status")]) mkdirSync(dir, { recursive: true });
  // The shipped shape from 0.28.2: one legacy manifest, no root plugin.json.
  writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version }) + "\n");
  writeFileSync(join(root, "skills", "projectstore-status", "SKILL.md"), `---\nname: projectstore-status\n---\n${version}\n`);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n"); chmodSync(codex, 0o755);
  const env = { PATH: bin, CODEX_HOME: home, PROJECTSTORE_DISTRIBUTION_ROOT: root };
  return { base, home, project, root, env };
}

function fakeCodex(f, { fail = null } = {}) {
  return (_bin, argv) => {
    const op = argv.join(" ");
    if (fail && op.includes(fail)) return { status: 17, stdout: "", stderr: "injected host failure" };
    const config = join(f.home, "config.toml");
    let text = existsSync(config) ? readFileSync(config, "utf8") : "";
    if (op.startsWith("plugin marketplace add ")) {
      text = `[marketplaces.projectstore-npx]\nsource_type = "local"\nsource = "${join(f.home, "projectstore", "marketplace")}"\n\n` + text.replace(/\[marketplaces\.projectstore-npx][\s\S]*?(?=\n\[|$)/, "");
      writeFileSync(config, text);
    } else if (op === "plugin add projectstore@projectstore-npx") {
      const payload = join(f.home, "projectstore", "marketplace", "plugins", "projectstore");
      const version = JSON.parse(readFileSync(join(payload, ".codex-plugin", "plugin.json"), "utf8")).version;
      const cache = join(f.home, "plugins", "cache", "projectstore-npx", "projectstore", version);
      mkdirSync(cache, { recursive: true }); cpSync(payload, cache, { recursive: true });
      if (!text.includes('[plugins."projectstore@projectstore-npx"]')) text += `\n[plugins."projectstore@projectstore-npx"]\nenabled = true\n`;
      writeFileSync(config, text);
    } else if (op === "plugin remove projectstore@projectstore-npx") {
      text = text.replace(/\n?\[plugins\."projectstore@projectstore-npx"]\n(?:[^\[]|\n(?!\[))*?(?=\n\[|$)/, "\n");
      writeFileSync(config, text);
      rmSync(join(f.home, "plugins", "cache", "projectstore-npx", "projectstore"), { recursive: true, force: true });
    } else if (op === "plugin marketplace remove projectstore-npx") {
      text = text.replace(/\n?\[marketplaces\.projectstore-npx]\n(?:[^\[]|\n(?!\[))*?(?=\n\[|$)/, "\n");
      writeFileSync(config, text);
    } else if (op === "plugin list") {
      return { status: 0, stderr: "", stdout: "Marketplace  Plugin  Status\nprojectstore-npx  projectstore  enabled\n" };
    } else if (op === "plugin list --json") {
      if (!text.includes('[plugins."projectstore@projectstore-npx"]')) return { status: 0, stderr: "", stdout: JSON.stringify({ installed: [] }) };
      const cacheBase = join(f.home, "plugins", "cache", "projectstore-npx", "projectstore");
      const version = readdirSync(cacheBase).sort().at(-1);
      return { status: 0, stderr: "", stdout: JSON.stringify({ installed: [{
        pluginId: "projectstore@projectstore-npx",
        version,
        installed: true,
        enabled: true,
        marketplaceSource: { source: join(f.home, "projectstore", "marketplace") },
      }] }) };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

const registration = (p) => p.items.find((i) => i.surface === "plugin");
const opts = (f, extra = {}) => ({ harnesses: ["codex"], surfaces: ["plugin"], root: f.root, home: f.home, env: f.env, ...extra });

test("Codex portable registration: install is verified and the next plan is idempotent", () => {
  const f = fixture();
  const p = plan(f.project, opts(f));
  assert.equal(registration(p).action, "create");
  const result = apply(p, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(result.failed, undefined);
  assert.equal(result[0].verified.version, "0.28.0+codex.dev.one");
  const next = plan(f.project, opts(f));
  assert.equal(registration(next).state, "current");
  assert.equal(registration(next).action, "skip");
  writeFileSync(join(f.root, "skills", "projectstore-status", "SKILL.md"), "same identity, different bytes\n");
  const conflict = plan(f.project, opts(f));
  assert.equal(registration(conflict).action, "refuse");
  assert.match(registration(conflict).reason, /same.*different payload|different payload digest/i);
});

// S8 of the 2026-10-03 review: the consent preview listed the cache it touches
// but never config.toml, the file `marketplace add`, `plugin add` and the
// global removals actually rewrite. The file is the manifest's
// registry.global_config, so a host that keeps its registry elsewhere names that.
test("Codex portable registration: every host step that rewrites the global config names it in the preview (S8)", () => {
  const f = fixture();
  const config = join(f.home, "config.toml");
  const touches = (p, name) => registration(p).steps.find((s) => s.kind === "host" && s.name === name)?.touches;
  const create = plan(f.project, opts(f));
  assert.ok(touches(create, "marketplace_add").includes(config), "marketplace add writes [marketplaces.<name>]");
  assert.ok(touches(create, "install").includes(config), "plugin add writes the enablement stanza");
  assert.ok(touches(create, "install").includes(join(f.home, "plugins", "cache")), "and still materialises the cache");
  assert.deepEqual(touches(create, "list"), [], "the read-back touches nothing");
  // …and the default preview says so in its text, beneath each $ line (contract 18 keeps it out of --verbose).
  const text = renderPreview(create);
  for (const name of ["marketplace_add", "install"]) {
    const st = registration(create).steps.find((s) => s.kind === "host" && s.name === name);
    const at = text.indexOf(`$ ${[st.bin, ...st.argv].join(" ")}`);
    assert.ok(at >= 0, `${name}: its argv is shown`);
    assert.ok(text.slice(at).split("\n")[1].includes(`touches ${st.touches.join(", ")}`), `${name}: what it touches is the next line`);
  }
  apply(create, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const global = plan(f.project, opts(f, { mode: "uninstall", globalRemoval: true }));
  assert.ok(touches(global, "uninstall").includes(config), "plugin remove drops the enablement stanza");
  assert.ok(touches(global, "marketplace_remove").includes(config), "marketplace remove drops the marketplace stanza");
});

// Contract 18: APPLY names every step of the registration as it runs — the
// staging write and each host command — beneath the registration's own line,
// and DONE follows. A named run without a terminal is never asked.
test("Codex portable registration: APPLY reports the staging write and each host command, then DONE", async () => {
  const f = fixture();
  const chunks = [];
  const out = { isTTY: false, write: (s) => { chunks.push(String(s)); return true; } };
  const r = await runVerb("install", f.project, { ...opts(f), spawn: fakeCodex(f), out });
  assert.equal(r.gate.why, "named");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const text = chunks.join("");
  const apply_ = text.slice(text.indexOf("\nAPPLY\n"));
  // The preflight is the registration's first line: the host is asked
  // before anything is staged (issue #28).
  assert.match(apply_, /\n {2}\+ registration .+\n {6}✓ \$ codex plugin list --json +\d.*\n {6}✓ stage \S+ +\d/, apply_);
  for (const st of registration(r.plan).steps.filter((s) => s.kind === "host")) {
    assert.match(apply_, new RegExp(`\\n {6}✓ \\$ ${[st.bin, ...st.argv].join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +\\d`), `${st.name} has its APPLY line`);
  }
  assert.match(text, /\nDONE — 1 change in \d/);
});

test("Codex portable registration: the public envelope drops the staged payload's bodies, root and listing, and keeps its count", () => {
  const f = fixture();
  const step = registration(plan(f.project, opts(f))).steps.find((s) => s.kind === "portable-write");
  assert.ok(step && Array.isArray(step.files) && step.from && step.catalog && step.ownership, "the private plan carries them");
  const pub = publicItem(registration(plan(f.project, opts(f)))).steps.find((s) => s.kind === "portable-write");
  for (const k of ["catalog", "ownership", "from", "manifest"]) assert.ok(!(k in pub), `${k} is not public`);
  assert.equal(pub.files, step.files.length, "the listing becomes its count, as a registration write reports it");
});

// S2 of the 2026-10-03 review: doctor read this registration from the core,
// fell back to the core as the payload, and told every project that merely
// contained .codex/ that "<core> is not a portable plugin root". The installer
// already deferred the surface in that run; doctor now does the same, and only
// a run whose distribution root IS a portable plugin root reads its state.
test("Codex portable registration, doctor half: a run with no portable payload has no registration row, and nothing names the core", async () => {
  const f = fixture();
  mkdirSync(join(f.project, ".codex"), { recursive: true });
  mkdirSync(join(f.project, ".claude"), { recursive: true });
  const rows = (env) => surfaceStates(f.project, { home: f.home, root: CORE, env }).states.filter((x) => x.harness === "codex" && x.kind === "registration");
  const { PROJECTSTORE_DISTRIBUTION_ROOT: _named, ...bare } = f.env;
  assert.deepEqual(rows(bare), [], "the core alone: no row");
  const otherShell = mkdtempSync(join(tmpdir(), "ps-other-shell-"));
  writeFileSync(join(otherShell, "package.json"), "{}\n");
  assert.deepEqual(rows({ ...bare, PROJECTSTORE_DISTRIBUTION_ROOT: otherShell }), [], "a shell whose root is not a plugin root names no payload either");
  const read = rows(f.env);
  assert.equal(read.length, 1, "the portable root: the row is read");
  assert.equal(read[0].state, "absent", "and analysed against that root, not the core");
  // The S2 line came from checkPluginRegistration, which reads every state;
  // checkHarnessSurfaces skips registration rows, so asserting on it alone
  // could not fail.
  const states = surfaceStates(f.project, { home: f.home, root: CORE, env: bare }).states;
  const lines = [...checkPluginRegistration(f.project, states), ...await checkHarnessSurfaces(null, f.project, { home: f.home, root: CORE, env: bare })];
  assert.ok(!lines.some((x) => /portable plugin root/.test(x.message)), JSON.stringify(lines.map((x) => x.message)));
  // The installer's half: the core run defers without failing; a shell that
  // names a root which is not a plugin root is broken, and says so.
  const p = plan(f.project, opts(f, { env: bare }));
  assert.equal(registration(p).action, "skip"); assert.equal(registration(p).deferred, true); assert.ok(!p.incomplete);
  const broken = plan(f.project, opts(f, { env: { ...bare, PROJECTSTORE_DISTRIBUTION_ROOT: otherShell } }));
  assert.equal(registration(broken).action, "skip"); assert.equal(broken.incomplete, true);
  assert.match(registration(broken).reason, /is not a portable plugin root/);
});

// A host that reports the plugin disabled, or a cache that does not match:
// the run fails at verify, and the first install's rollback is clean. The
// compensation removed what it added, the proof finds nothing of ours left,
// and no journal stays; the next run installs. (Until 2026-10-05 both fakes
// threw inside the rollback's proof on an empty list, which read as
// recovery-required; that path has its own test below.)
test("Codex portable registration: verification requires host-reported enablement and the materialised cache digest", () => {
  const tampers = {
    "0.28.0+codex.dev.disabled": (f, r) => {
      const body = JSON.parse(r.stdout);
      if (body.installed[0]) body.installed[0].enabled = false;
      return { ...r, stdout: JSON.stringify(body) };
    },
    "0.28.0+codex.dev.corrupt": (f, r) => {
      const cached = join(f.home, "plugins", "cache", "projectstore-npx", "projectstore", "0.28.0+codex.dev.corrupt", "skills", "projectstore-status", "SKILL.md");
      if (existsSync(cached)) writeFileSync(cached, "tampered cache\n");
      return r;
    },
  };
  for (const [version, tamper] of Object.entries(tampers)) {
    const f = fixture(version);
    const base = fakeCodex(f);
    const spawn = (bin, argv) => { const r = base(bin, argv); return argv.join(" ") === "plugin list --json" && r.status === 0 ? tamper(f, r) : r; };
    const first = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn });
    assert.equal(first.failed.step, "verify", version);
    assert.equal(existsSync(join(f.home, "projectstore", "projectstore-npx.journal.json")), false, `${version}: a proven rollback keeps no journal`);
    const again = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: base });
    assert.equal(again.failed, undefined, `${version}: ${JSON.stringify(again.failed)}`);
    assert.equal(again[0].verified.version, version);
  }
});

// An exception inside the rollback's own proof leaves the state unproven: the
// journal stays recovery-required, with its error and its time. The next
// confirmed run proves it (for a first install, that nothing of ours remains),
// lifts it, says so in APPLY and installs (the install spec's 2026-09-29
// amendment, as amended 2026-10-05).
test("Codex portable registration: a first install's recovery the next run can prove is lifted, named, and the run installs", async () => {
  const f = fixture("0.28.0+codex.dev.lift");
  const base = fakeCodex(f);
  let removed = false;
  const throwing = (bin, argv) => {
    const op = argv.join(" ");
    if (op === "plugin remove projectstore@projectstore-npx") removed = true;
    if (op === "plugin list --json" && removed) throw new Error("injected: the host list broke during the rollback's proof");
    const r = base(bin, argv);
    if (op === "plugin list --json" && r.status === 0) {
      const body = JSON.parse(r.stdout);
      if (body.installed[0]) body.installed[0].enabled = false;
      return { ...r, stdout: JSON.stringify(body) };
    }
    return r;
  };
  const first = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: throwing });
  assert.equal(first.failed.step, "recovery-required");
  const journalPath = join(f.home, "projectstore", "projectstore-npx.journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(journal.previous, null);
  assert.match(journal.error, /injected/);
  assert.ok(journal.failed_at, "the first failure's time is kept");
  // The plan names the previous run, when, its error and the journal; its keys are unchanged.
  const p = plan(f.project, opts(f));
  const reason = registration(p).reason;
  assert.ok(reason.startsWith(`a previous run (${journal.failed_at}) could not prove its restore: `), reason);
  assert.match(reason, /injected.*this run re-proves the previous state before applying this plan, and refuses if it cannot/);
  assert.ok(reason.includes(journalPath), reason);
  // The next run, with a host that answers: proven, lifted, installed.
  const chunks = [];
  const out = { isTTY: false, write: (s) => { chunks.push(String(s)); return true; } };
  const r = await runVerb("install", f.project, { ...opts(f), spawn: base, out });
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.equal(existsSync(journalPath), false, "the journal is lifted");
  const rec = r.applied[0].steps.find((s) => s.kind === "portable-recover");
  assert.equal(rec.phase, "recovery-required");
  assert.match(rec.lifted, /injected/);
  assert.match(chunks.join(""), /\n {6}✓ lift \S*projectstore-npx\.journal\.json — the previous state proved; it held: .*injected/);
});

// The incident's class on a refresh: the rollback restored the previous
// version, but the host could not confirm it at the time. The next run proves
// the source digest, the cache digest and the host's own row, lifts the
// journal, and the refresh applies.
test("Codex portable registration: a refresh whose rollback could not be confirmed is lifted once the previous state proves, and the refresh applies", () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  writeFileSync(join(f.root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version: "0.28.0+codex.dev.two" }) + "\n");
  const base = fakeCodex(f);
  let refused = false;
  const flaky = (bin, argv) => {
    const op = argv.join(" ");
    if (op === "plugin add projectstore@projectstore-npx") { refused = true; return { status: 17, stdout: "", stderr: "add refused, nothing changed" }; }
    if (op === "plugin list --json" && refused) return { status: 1, stdout: "", stderr: "transient: the host list is unavailable" };
    return base(bin, argv);
  };
  const first = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: flaky });
  assert.equal(first.failed.step, "recovery-required");
  const journalPath = join(f.home, "projectstore", "projectstore-npx.journal.json");
  assert.ok(JSON.parse(readFileSync(journalPath, "utf8")).previous, "a refresh records the previous state");
  const r = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: base });
  assert.equal(r.failed, undefined, JSON.stringify(r.failed));
  assert.equal(existsSync(journalPath), false);
  assert.equal(r[0].verified.version, "0.28.0+codex.dev.two");
  assert.ok(r[0].steps.some((s) => s.kind === "portable-recover" && s.phase === "recovery-required" && /transient/.test(s.lifted || "")));
});

// Issue #28, problem 1: a host too old to answer the registration's own
// verification is caught before anything changes.
test("Codex portable registration: a host that cannot answer the preflight stops the run with nothing changed (issue #28)", () => {
  const f = fixture();
  const calls = [];
  const old = (bin, argv) => {
    calls.push(argv.join(" "));
    if (argv.join(" ") === "plugin list --json") return { status: 2, stdout: "", stderr: "error: unexpected argument '--json' found\n\nUsage: codex plugin list [OPTIONS]" };
    return fakeCodex(f)(bin, argv);
  };
  const p = plan(f.project, opts(f));
  const first = registration(p).steps[0];
  assert.equal(first.kind, "host");
  assert.equal(first.name, "preflight");
  assert.deepEqual(first.argv, ["plugin", "list", "--json"]);
  assert.ok(renderPreview(p).includes("$ codex plugin list --json"), "the preview shows it");
  const result = apply(p, { env: f.env, home: f.home, spawn: old });
  assert.equal(result.failed.step, "preflight");
  assert.match(result.failed.stderr, /unexpected argument '--json'/);
  assert.match(result.failed.stderr, /so it changed nothing\. Upgrade Codex, then run this again\./);
  assert.deepEqual(calls, ["plugin list --json"], "no marketplace add, no plugin add");
  assert.equal(existsSync(join(f.home, "projectstore", "projectstore-npx.journal.json")), false, "no journal");
  assert.equal(existsSync(join(f.home, "projectstore", "marketplace")), false, "nothing staged");
  assert.equal(existsSync(join(f.home, "config.toml")), false, "the host's config is untouched");
});

// Issue #28, problem 2: a journal 0.29.0 left after a first install (no time,
// no previous state) is named in the plan, and lifted once nothing of ours
// remains.
test("Codex portable registration: a 0.29.0 first-install journal is named in the plan and lifted once nothing of ours remains (issue #28)", () => {
  const f = fixture();
  const dir = join(f.home, "projectstore", "marketplace");
  const journalPath = join(f.home, "projectstore", "projectstore-npx.journal.json");
  mkdirSync(join(f.home, "projectstore"), { recursive: true });
  writeFileSync(journalPath, JSON.stringify({ version: 1, target: dir, stage: `${dir}.none`, backup: null, previous: null, phase: "recovery-required", error: "error: unexpected argument '--json' found\n\nUsage: codex plugin list [OPTIONS]" }, null, 2) + "\n");
  const p = plan(f.project, opts(f));
  assert.match(registration(p).reason, /^a previous run could not prove its restore: error: unexpected argument '--json' found; this run re-proves/);
  // While the host is still too old, the re-check cannot ask it: refused,
  // the history kept (a 0.29.0 journal has no time), and told to upgrade.
  const tooOld = (bin, argv) => argv.join(" ") === "plugin list --json"
    ? { status: 2, stdout: "", stderr: "error: unexpected argument '--json' found" }
    : fakeCodex(f)(bin, argv);
  const still = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: tooOld });
  assert.equal(still.failed.step, "recovery-required");
  assert.ok(still.failed.stderr.startsWith("a previous run (time not recorded) could not prove its restore: error: unexpected argument '--json' found"), still.failed.stderr);
  assert.match(still.failed.stderr, /The re-check could not ask Codex \(`codex plugin list --json`\); if it is too old to answer, upgrade it, then run this again\./);
  const kept = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.match(kept.error, /^error: unexpected argument '--json' found\n\nUsage/, "the first error is kept");
  assert.equal(kept.failed_at, undefined, "no time is invented for it");
  assert.ok(kept.rechecked_at && /could not ask Codex/.test(kept.recheck_error));
  // Once the host answers, the journal lifts.
  const r = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(r.failed, undefined, JSON.stringify(r.failed));
  assert.equal(existsSync(journalPath), false);
  assert.ok(r[0].steps.some((s) => s.kind === "portable-recover" && s.phase === "recovery-required"));
});

// Node reports a working directory that does not exist and a binary not on
// PATH alike (`spawnSync <bin> ENOENT`); the run names which (contract 19).
test("Codex portable registration: a host command that cannot start names its cause", () => {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A binary gone after the plan: the apply-time recheck finds it missing
  // before anything is spawned (the Claude-format case, which has no recheck,
  // is in registration.test.mjs).
  const gone = fixture();
  const p1 = plan(gone.project, opts(gone));
  rmSync(join(gone.base, "bin", "codex"));
  const r1 = apply(p1, { env: gone.env, home: gone.home });
  assert.equal(r1.failed.step, "recheck");
  assert.match(r1.failed.stderr, /`codex` is not on PATH/);
  // A binary that exists but cannot run: its interpreter is missing.
  const broken = fixture();
  const p2 = plan(broken.project, opts(broken));
  writeFileSync(join(broken.base, "bin", "codex"), "#!/nonexistent/interpreter\n");
  chmodSync(join(broken.base, "bin", "codex"), 0o755);
  const r2 = apply(p2, { env: broken.env, home: broken.home });
  assert.match(r2.failed.stderr, new RegExp(`^codex could not start: ${esc(join(broken.base, "bin", "codex"))} exists but could not be run \\(E[A-Z]+\\)`), r2.failed.stderr);
  assert.ok(!/Upgrade/.test(r2.failed.stderr), "a host that never started is not told to upgrade");
  // A project removed after the plan, through the real spawnSync.
  const moved = fixture();
  const p3 = plan(moved.project, opts(moved));
  rmSync(moved.project, { recursive: true, force: true });
  const r3 = apply(p3, { env: moved.env, home: moved.home });
  assert.match(r3.failed.stderr, new RegExp(`^codex could not start: the working directory ${esc(JSON.stringify(moved.project))} is not an existing directory`));
  assert.ok(!/Upgrade/.test(r3.failed.stderr), "a missing directory is not an old host");
  // Mid-run, with the fake host taught Node's behaviour: the planned step, the
  // compensation and the proof all name the directory, never `spawnSync`.
  const mid = fixture();
  const base = fakeCodex(mid);
  const nodeLike = (bin, argv, o) => {
    if (argv.join(" ") === "plugin add projectstore@projectstore-npx") rmSync(mid.project, { recursive: true, force: true });
    if (!existsSync(o.cwd)) return { status: null, stdout: null, stderr: null, error: Object.assign(new Error(`spawnSync ${bin} ENOENT`), { code: "ENOENT" }) };
    return base(bin, argv);
  };
  const r4 = apply(plan(mid.project, opts(mid)), { env: mid.env, home: mid.home, spawn: nodeLike });
  const seen = JSON.stringify({ steps: r4[0].steps, failed: r4.failed });
  assert.ok(!/spawnSync/.test(seen), seen);
  const comp = r4[0].steps.filter((s) => s.kind === "portable-compensate");
  assert.ok(comp.length && comp.every((s) => /working directory/.test(s.stderr || "")), JSON.stringify(comp));
  assert.match(r4.failed.stderr, /working directory/);
});


test("Codex portable registration: a failed refresh restores the prior stable source", () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const ownership = join(f.home, "projectstore", "marketplace", ".projectstore-registration.json");
  const before = readFileSync(ownership, "utf8");
  writeFileSync(join(f.root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version: "0.28.0+codex.dev.two" }) + "\n");
  const p = plan(f.project, opts(f));
  assert.equal(registration(p).action, "update");
  const result = apply(p, { env: f.env, home: f.home, spawn: fakeCodex(f, { fail: "plugin add" }) });
  assert.equal(result.failed.step, "install");
  assert.equal(readFileSync(ownership, "utf8"), before);
  assert.ok(result[0].steps.some((step) => step.kind === "portable-rollback" && step.ok));
  assert.ok(result[0].steps.some((step) => step.kind === "portable-recovery-list" && step.ok));
});

test("Codex portable registration: a partially mutating failed refresh becomes recovery-required", () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  writeFileSync(join(f.root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "projectstore", version: "0.28.0+codex.dev.two" }) + "\n");
  const base = fakeCodex(f);
  const partial = (bin, argv) => {
    const r = base(bin, argv);
    return argv.join(" ") === "plugin add projectstore@projectstore-npx" ? { ...r, status: 17, stderr: "failed after mutation" } : r;
  };
  const result = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: partial });
  assert.equal(result.failed.step, "recovery-required");
  const journal = join(f.home, "projectstore", "projectstore-npx.journal.json");
  assert.equal(JSON.parse(readFileSync(journal, "utf8")).phase, "recovery-required");
  const firstRecord = JSON.parse(readFileSync(journal, "utf8"));
  assert.ok(firstRecord.failed_at, "the first failure's time");
  const retry = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: base });
  assert.equal(retry.failed.step, "recovery-required");
  // Refused as before, and the journal keeps its history: the first error and
  // time unchanged, the re-check's own reason and time beside them (issue #28).
  const kept = JSON.parse(readFileSync(journal, "utf8"));
  assert.equal(kept.phase, "recovery-required");
  assert.equal(kept.error, firstRecord.error);
  assert.equal(kept.failed_at, firstRecord.failed_at);
  assert.deepEqual(kept.previous, firstRecord.previous);
  assert.ok(kept.rechecked_at && kept.recheck_error, JSON.stringify(kept));
  assert.ok(retry.failed.stderr.startsWith(`a previous run (${firstRecord.failed_at}) could not prove its restore: ${firstRecord.error}. This run re-checked the previous state and could not prove it either: `), retry.failed.stderr);
  assert.ok(retry.failed.stderr.includes(`${journal} is kept: a later run lifts it once the previous state proves, or inspect the registration and remove the journal to start over`), retry.failed.stderr);
});

test("Codex portable registration: the home-scoped lock rejects a concurrent mutation", () => {
  const f = fixture();
  const lockDir = join(f.home, "projectstore"); mkdirSync(lockDir, { recursive: true });
  const lock = join(lockDir, "projectstore-npx.lock"); writeFileSync(lock, JSON.stringify({ pid: process.pid }) + "\n");
  const result = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(result.failed.step, "lock");
  assert.equal(existsSync(join(f.home, "projectstore", "marketplace")), false);
  assert.equal(existsSync(lock), true);
});

test("Codex portable registration: a plan waiting on the lock rechecks and becomes a no-op", () => {
  const f = fixture();
  const first = plan(f.project, opts(f));
  const waiting = plan(f.project, opts(f));
  let calls = 0;
  const base = fakeCodex(f);
  const spawn = (bin, argv) => { calls++; return base(bin, argv); };
  apply(first, { env: f.env, home: f.home, spawn });
  const before = calls;
  const result = apply(waiting, { env: f.env, home: f.home, spawn });
  assert.equal(result.failed, undefined);
  assert.equal(result[0].action, "skip");
  assert.equal(calls, before, "the stale waiter must not run plugin add/list again");
  assert.ok(result[0].steps.some((step) => step.kind === "portable-recheck" && step.action === "skip"));
});

test("Codex portable registration: a foreign target appearing after preview is never replaced", () => {
  const f = fixture();
  const p = plan(f.project, opts(f));
  const target = join(f.home, "projectstore", "marketplace");
  mkdirSync(target, { recursive: true });
  const foreign = join(target, "foreign.txt"); writeFileSync(foreign, "keep me\n");
  const result = apply(p, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(result.failed.step, "recheck");
  assert.equal(readFileSync(foreign, "utf8"), "keep me\n");
});

test("Codex portable registration: an interrupted stage is recovered from its durable journal", () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const target = join(f.home, "projectstore", "marketplace");
  const stage = `${target}.staging-interrupted`;
  mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, "partial"), "partial");
  const journal = join(f.home, "projectstore", "projectstore-npx.journal.json");
  const owned = JSON.parse(readFileSync(join(target, ".projectstore-registration.json"), "utf8")).projectstore;
  writeFileSync(journal, JSON.stringify({ version: 1, phase: "prepare", target, stage, backup: `${target}.previous-interrupted`, previous: { version: owned.version, digest: owned.digest, enabled: true }, next: { version: owned.version, digest: owned.digest } }));
  const lock = join(f.home, "projectstore", "projectstore-npx.lock");
  writeFileSync(lock, JSON.stringify({ pid: 99_999_999, started_at: "2026-09-30T00:00:00.000Z" }) + "\n");
  const p = plan(f.project, opts(f));
  assert.equal(registration(p).state, "stale");
  assert.match(registration(p).reason, /recovery journal/);
  const result = apply(p, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(result.failed, undefined);
  assert.deepEqual(result[0].steps.slice(0, 3).map((s) => s.kind), ["portable-stale-lock", "portable-recovery-list", "portable-recover"]);
  assert.equal(existsSync(stage), false);
  assert.equal(existsSync(journal), false);
  assert.equal(existsSync(lock), false);
});

test("Codex portable registration: first-install crash after swap restores absence before retry", () => {
  const f = fixture();
  const p = plan(f.project, opts(f));
  const item = registration(p);
  const write = item.steps.find((step) => step.kind === "portable-write");
  const target = write.path;
  mkdirSync(join(target, write.subdir), { recursive: true });
  cpSync(f.root, join(target, write.subdir), { recursive: true });
  mkdirSync(join(target, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(target, write.catalogRel), JSON.stringify(write.catalog) + "\n");
  writeFileSync(join(target, write.ownershipRel), JSON.stringify(write.ownership) + "\n");
  const journal = join(f.home, "projectstore", "projectstore-npx.journal.json");
  writeFileSync(journal, JSON.stringify({
    version: 1,
    phase: "prepare",
    target,
    stage: `${target}.staging-crashed-after-rename`,
    backup: null,
    previous: null,
    next: item.verify,
  }));
  const result = apply(p, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  assert.equal(result.failed, undefined);
  assert.ok(result[0].steps.some((step) => step.kind === "portable-recover" && step.phase === "prepare"));
  assert.equal(existsSync(journal), false);
  assert.equal(plan(f.project, opts(f)).items.find((row) => row.surface === "plugin").state, "current");
});

test("Codex portable registration: a partially mutating marketplace add retains recovery-required", () => {
  const f = fixture();
  const base = fakeCodex(f);
  const partial = (bin, argv) => {
    const op = argv.join(" ");
    if (op.startsWith("plugin marketplace add ")) {
      base(bin, argv);
      return { status: 17, stdout: "", stderr: "failed after marketplace mutation" };
    }
    if (op === "plugin marketplace remove projectstore-npx") return { status: 17, stdout: "", stderr: "cleanup also failed" };
    return base(bin, argv);
  };
  const result = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: partial });
  assert.equal(result.failed.step, "recovery-required");
  const journal = join(f.home, "projectstore", "projectstore-npx.journal.json");
  assert.equal(JSON.parse(readFileSync(journal, "utf8")).phase, "recovery-required");
});

test("Codex portable registration: uninstall is project-safe unless --global is explicit", () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const local = plan(f.project, opts(f, { mode: "uninstall" }));
  assert.equal(registration(local).action, "skip");
  assert.match(registration(local).reason, /--global/);
  const global = plan(f.project, opts(f, { mode: "uninstall", globalRemoval: true }));
  assert.equal(registration(global).action, "remove");
  assert.ok(registration(global).steps.some((s) => s.kind === "portable-remove"));
  const called = [];
  const base = fakeCodex(f);
  const result = apply(global, { env: f.env, home: f.home, spawn: (bin, argv) => { called.push(argv.join(" ")); return base(bin, argv); } });
  assert.equal(result.failed, undefined);
  assert.ok(called.includes("plugin remove projectstore@projectstore-npx"));
  assert.ok(called.includes("plugin marketplace remove projectstore-npx"));
  assert.equal(existsSync(join(f.home, "projectstore", "marketplace")), false);
  assert.equal(plan(f.project, opts(f)).items.find((row) => row.surface === "plugin").state, "absent");
});

test("Codex portable registration: a second enabled ProjectStore marketplace is refused", () => {
  const f = fixture();
  writeFileSync(join(f.home, "config.toml"), '[plugins."projectstore@old-marketplace"]\nenabled = true\n');
  const p = plan(f.project, opts(f));
  assert.equal(p.ok, false);
  assert.equal(registration(p).state, "conflict");
  assert.equal(registration(p).action, "refuse");
  assert.match(registration(p).reason, /two ProjectStore plugins/);
});

// The preflight reads its answer, not only its status: a host that exits 0
// with text where the registration reads JSON is as unable to verify as one
// that refuses the flag (the reviewer's probe, 2026-10-05).
test("Codex portable registration: a preflight answered with text, not JSON, stops the registration before it changes anything", () => {
  const f = fixture();
  const calls = [];
  const texty = (bin, argv) => {
    calls.push(argv.join(" "));
    if (argv.join(" ") === "plugin list --json") return { status: 0, stderr: "", stdout: "Marketplace  Plugin  Status\n" };
    return fakeCodex(f)(bin, argv);
  };
  const result = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: texty });
  assert.equal(result.failed.step, "preflight");
  assert.equal(result.failed.status, null, "an answer in text is not reported as \"exited 0\"");
  assert.match(result.failed.stderr, /^codex plugin list --json answered, but not with the JSON the registration reads\nThe registration needs `codex plugin list --json` to verify what it installs, so it changed nothing\. Upgrade Codex/);
  assert.deepEqual(calls, ["plugin list --json"]);
  assert.equal(existsSync(join(f.home, "projectstore", "projectstore-npx.journal.json")), false);
});

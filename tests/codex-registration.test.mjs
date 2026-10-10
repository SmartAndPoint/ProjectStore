import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { plan, apply, publicItem, renderPreview, runVerb, planOptions } from "../scripts/install-harness.mjs";
import { surfaceStates } from "../scripts/surfaces.mjs";
import { checkHarnessSurfaces, checkPluginRegistration } from "../scripts/doctor.mjs";
import { loadHarness, cachePaths } from "../scripts/harness.mjs";
import { fetchDecision, fetchRefusal, sweepFetchRuns, rootVersion, REGISTRY_BUDGET_MS } from "../scripts/fetch-shell.mjs";
import { codexHost, fakeNpmSpawn, FAKE_REGISTRY } from "./fixtures/fetch.mjs";
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

// The host, in the shapes measured on codex-cli 0.153.4 — moved to
// tests/fixtures/fetch.mjs unchanged, so the bin's PATH stub runs the same one.
function fakeCodex(f, { fail = null } = {}) {
  return codexHost(f.home, { fail });
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

// ─── The shell fetch (the story "Install and upgrade fetch a shell-rooted
// harness at the bin's own version, once per run; plan and uninstall never
// fetch") ─────────────────────────────────────────────────────────────────
//
// From the core: no distribution root, `codex` on PATH (a no-op stub; the
// host is the in-process codexHost), and npm the in-process fakeNpmSpawn.

const CODEX = loadHarness("codex");
const SHELL = CODEX.install.shell;
const V = rootVersion(CORE);

function coreFixture() {
  const base = mkdtempSync(join(tmpdir(), "ps-codex-fetch-"));
  const home = join(base, "home"), project = join(base, "project"), bin = join(base, "bin"), cache = join(base, "cache");
  for (const dir of [home, project, bin]) mkdirSync(dir, { recursive: true });
  const codex = join(bin, CODEX.surfaces.plugin.cli.bin);
  writeFileSync(codex, "#!/bin/sh\nexit 0\n"); chmodSync(codex, 0o755);
  const env = { PATH: bin, [CODEX.runtime.home_env]: home, XDG_CACHE_HOME: cache };
  const fetchDir = cachePaths({ env, home }).fetch;
  return { base, home, project, bin, cache, env, fetchDir };
}
const coreOpts = (f, extra = {}) => ({ harnesses: ["codex"], root: CORE, home: f.home, env: f.env, spawn: fakeCodex(f), ...extra });
const leftovers = (f) => (existsSync(f.fetchDir) ? readdirSync(f.fetchDir) : []);
const rule2Argv = (prefix, registry = FAKE_REGISTRY) => ["install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--json", "--registry", registry, "--fetch-timeout=30000", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=5000", `${SHELL}@${V}`];

test("shell fetch: upgrade --harness codex --json from the core reads the registry once, fetches once at the core's version, plans from the fetched root, rechecks, applies and reports it", async () => {
  const f = coreFixture();
  const npm = fakeNpmSpawn();
  const r = await runVerb("upgrade", f.project, { ...coreOpts(f), json: true, fetchSpawn: npm.spawn });
  assert.equal(r.gate.why, "named");
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  const registry = npm.calls.filter((c) => c.argv[0] === "config");
  assert.equal(registry.length, 1, "the registry is read once");
  assert.deepEqual(registry[0].argv, ["config", "get", "registry", "--no-update-notifier"]);
  assert.equal(registry[0].cwd, f.project, "in the project, so its .npmrc counts");
  const installs = npm.installs();
  assert.equal(installs.length, 1, "one fetch");
  const [call] = installs;
  assert.equal(dirname(call.cwd), f.fetchDir);
  assert.match(basename(call.cwd), new RegExp(`^${process.pid}-\\d+$`), "<cache>/fetch/<pid>-<ms>");
  assert.deepEqual(call.argv, rule2Argv(call.cwd), "rule 2's argv, at <root>/package.json's version");
  assert.deepEqual(call.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(call.env, f.env, "the run's environment");
  const item = registration(r.plan);
  const stage = item.steps.find((s) => s.kind === "portable-write");
  assert.equal(stage.from, join(call.cwd, "node_modules", SHELL), "the staging source is inside the fetched root");
  assert.ok(Array.isArray(stage.files) && stage.files.length > 0, "a fetched payload is counted");
  assert.ok(!item.steps.some((s) => s.kind === "fetch"), "a fetched run's plan carries no dry-run fetch step");
  const applied = r.applied.find((a) => a.surface === "plugin");
  assert.equal(applied.verified.version, V, "the recheck passed and the read-back verified");
  assert.equal(r.fetched.length, 1);
  const { ms, ...fetched } = r.fetched[0];
  assert.deepEqual(fetched, { harness: CODEX.id, package: SHELL, version: V });
  assert.ok(Number.isFinite(ms) && ms >= 0);
  assert.deepEqual(leftovers(f), [], "the run's fetch directory is gone after DONE");
});

test("shell fetch: the fetch directory is gone after STOPPED, after n at the question, after a refusal, and after an exception", async () => {
  const stopped = coreFixture();
  const r1 = await runVerb("install", stopped.project, { ...coreOpts(stopped, { spawn: fakeCodex(stopped, { fail: "plugin add" }) }), json: true, fetchSpawn: fakeNpmSpawn().spawn });
  assert.equal(r1.failed.step, "install", JSON.stringify(r1.failed));
  assert.deepEqual(leftovers(stopped), [], "STOPPED");
  const declined = coreFixture();
  const npm = fakeNpmSpawn();
  let asked = false;
  const r2 = await runVerb("install", declined.project, { ...coreOpts(declined), fetchSpawn: npm.spawn, ask: async () => { asked = true; assert.equal(leftovers(declined).length, 1, "the scratch exists while the question waits"); return "n"; } });
  assert.ok(asked && r2.gate.why === "declined" && npm.installs().length === 1);
  assert.deepEqual(leftovers(declined), [], "n at the question");
  const refused = coreFixture();
  const r3 = await runVerb("install", refused.project, { ...coreOpts(refused), json: true, fetchSpawn: fakeNpmSpawn({ mode: "ETARGET" }).spawn });
  assert.equal(r3.gate.why, "refused");
  assert.deepEqual(leftovers(refused), [], "a refusal");
  // An exception after the fetch: the stream the preview is written to breaks.
  const thrown = coreFixture();
  const out = { isTTY: false, write: (s) => { if (String(s).includes("PLAN")) throw new Error("injected: the terminal went away"); return true; } };
  await assert.rejects(runVerb("install", thrown.project, { ...coreOpts(thrown), out, fetchSpawn: fakeNpmSpawn().spawn }), /injected/);
  assert.deepEqual(leftovers(thrown), [], "an exception");
});

test("shell fetch: a payload changed between plan and apply fails the recheck before anything is staged", async () => {
  const f = coreFixture();
  const host = [];
  const base = fakeCodex(f);
  const r = await runVerb("install", f.project, {
    ...coreOpts(f, { spawn: (bin, argv, o) => { host.push(argv.join(" ")); return base(bin, argv, o); } }),
    fetchSpawn: fakeNpmSpawn().spawn,
    ask: async () => {
      const [run] = readdirSync(f.fetchDir);
      writeFileSync(join(f.fetchDir, run, "node_modules", SHELL, "skills", "projectstore-status", "SKILL.md"), "changed under the plan\n");
      return "y";
    },
  });
  assert.equal(r.failed.step, "recheck", JSON.stringify(r.failed));
  assert.deepEqual(host, [], "no host command ran");
  assert.equal(existsSync(join(f.home, "projectstore", "marketplace")), false, "nothing staged");
  assert.equal(existsSync(join(f.home, "projectstore", "projectstore-npx.journal.json")), false, "no journal");
  assert.deepEqual(leftovers(f), []);
});

test("shell fetch: a version the registry lacks (ETARGET, E404) is a refusal before the plan, naming the package and the registry, no other version, and three ways out", async () => {
  for (const mode of ["ETARGET", "E404"]) {
    const f = coreFixture();
    const npm = fakeNpmSpawn({ mode });
    const host = [];
    const r = await runVerb("upgrade", f.project, { ...coreOpts(f, { spawn: (...a) => { host.push(a[1].join(" ")); return { status: 0, stdout: "", stderr: "" }; } }), json: true, fetchSpawn: npm.spawn });
    assert.equal(r.plan.ok, false, mode);
    assert.deepEqual(r.plan.items, [], `${mode}: refused before the plan`);
    assert.equal(r.gate.why, "refused");
    const [refusal] = r.plan.refusals;
    assert.ok(refusal.startsWith(`${SHELL}@${V} is not on ${FAKE_REGISTRY} (npm ${mode})`), refusal);
    assert.deepEqual([...new Set(refusal.match(/\d+\.\d+\.\d+[\w.+-]*/g))], [V], `${mode}: names no other version`);
    assert.match(refusal, /Just released\? The shell is published after the core, so retry/);
    assert.ok(refusal.includes("PROJECTSTORE_DISTRIBUTION_ROOT") && refusal.includes("npm run shells:build -- --dev") && refusal.includes(`dist/build/${SHELL}`), refusal);
    assert.ok(refusal.includes(`name --harness without ${CODEX.display_name}`), refusal);
    assert.equal(npm.installs().length, 1);
    assert.deepEqual(host, [], `${mode}: nothing spawned after npm`);
    assert.equal(existsSync(join(f.home, "projectstore")), false, `${mode}: nothing staged or locked`);
    assert.deepEqual(leftovers(f), [], `${mode}: no fetch directory remains`);
    assert.ok(!/npm error|_logs/.test(refusal), "npm's raw stderr is never shown");
  }
});

test("shell fetch: a hang past the budget is stopped with SIGTERM and names the bound; npm's request timeout names its URL", async () => {
  const f = coreFixture();
  const npm = fakeNpmSpawn({ mode: "hang" });
  const r = await runVerb("install", f.project, { ...coreOpts(f), json: true, fetchSpawn: npm.spawn, fetchBudget: 200 });
  assert.equal(npm.installs()[0].killed, "SIGTERM");
  assert.equal(r.plan.refusals[0], `fetching ${SHELL}@${V} from ${FAKE_REGISTRY} took longer than 0.2 s and was stopped. Retry, or name --harness without ${CODEX.display_name}.`);
  assert.deepEqual(leftovers(f), []);
  // The text is built from the budget, which is 120 s unless a test injects one.
  assert.match(fetchRefusal("EBUDGET", { pkg: `${SHELL}@${V}`, registry: FAKE_REGISTRY, display: CODEX.display_name }), /took longer than 120 s and was stopped/);
  const t = coreFixture();
  const timeout = await runVerb("install", t.project, { ...coreOpts(t), json: true, fetchSpawn: fakeNpmSpawn({ mode: "FETCH_ERROR" }).spawn });
  assert.equal(timeout.plan.refusals[0], `npm gave up on ${FAKE_REGISTRY}${SHELL} (network timeout) while fetching ${SHELL}@${V}. Retry, or name --harness without ${CODEX.display_name}.`);
  // The registry read has a short budget of its own; past it, the fetch runs with no --registry.
  assert.equal(REGISTRY_BUDGET_MS, 10000);
  const h = coreFixture();
  const slow = fakeNpmSpawn({ registryMode: "hang" });
  const read = await runVerb("install", h.project, { ...coreOpts(h), json: true, fetchSpawn: slow.spawn, fetchBudget: 300 });
  assert.equal(read.failed, null, JSON.stringify(read.failed));
  assert.equal(slow.calls.find((c) => c.argv[0] === "config").killed, "SIGTERM");
  assert.ok(!slow.installs()[0].argv.includes("--registry"), "a timed-out read omits --registry");
});

test("shell fetch: refused credentials, a refused connection, npm missing and an unwritable cache each refuse with their own cause, and no stack trace", async () => {
  for (const mode of ["E401", "E403"]) {
    const f = coreFixture();
    const r = await runVerb("install", f.project, { ...coreOpts(f), json: true, fetchSpawn: fakeNpmSpawn({ mode }).spawn });
    const [refusal] = r.plan.refusals;
    assert.ok(refusal.startsWith(`${FAKE_REGISTRY} refused the credentials for ${SHELL}@${V} (npm ${mode})`), refusal);
    assert.ok(refusal.includes("~/.npmrc") && refusal.includes("NPM_CONFIG_") && refusal.includes("PROJECTSTORE_DISTRIBUTION_ROOT"), refusal);
  }
  const c = coreFixture();
  const t0 = Date.now();
  const refused = await runVerb("install", c.project, { ...coreOpts(c), json: true, fetchSpawn: fakeNpmSpawn({ mode: "ECONNREFUSED" }).spawn });
  assert.ok(Date.now() - t0 < 10_000, "within 10 s");
  assert.match(refused.plan.refusals[0], new RegExp(`^npm could not fetch ${SHELL}@${V} from ${FAKE_REGISTRY.replace(/[.]/g, "\\.")}: ECONNREFUSED — .*needs the network`));
  // npm missing from PATH: the real spawn, contract 19's cause.
  const m = coreFixture();
  const missing = await runVerb("install", m.project, { ...coreOpts(m), json: true });
  assert.ok(missing.plan.refusals[0].startsWith("npm could not start: it was not found on PATH; Codex is registered from its shell"), missing.plan.refusals[0]);
  assert.ok(!/spawn npm ENOENT/.test(missing.plan.refusals[0]));
  // A read-only cache root: the path and the variable it came from.
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root writes anywhere
  const ro = coreFixture();
  mkdirSync(ro.cache, { recursive: true });
  chmodSync(ro.cache, 0o555);
  try {
    const npm = fakeNpmSpawn();
    const r = await runVerb("install", ro.project, { ...coreOpts(ro), json: true, fetchSpawn: npm.spawn });
    const [refusal] = r.plan.refusals;
    assert.ok(refusal.startsWith(`the cache directory ${join(ro.cache, "projectstore")} cannot be written (EACCES); it comes from XDG_CACHE_HOME. Set XDG_CACHE_HOME to a writable directory`), refusal);
    assert.ok(!/\n\s+at /.test(refusal), "no stack trace");
    assert.deepEqual(npm.calls, [], "nothing spawned");
  } finally { chmodSync(ro.cache, 0o755); }
});

test("shell fetch: a fetched tree with the wrong name, version, plugin manifest or bundled core is refused before the plan, naming the file and both values", async () => {
  const cases = {
    "wrong-name": (dir) => `${join(dir, "package.json")} has name "${SHELL}-other", expected "${SHELL}"`,
    "wrong-version": (dir) => `${join(dir, "package.json")} has version "${V}-other", expected "${V}"`,
    "no-plugin-manifest": (dir) => `is not a plugin root: neither ${join(dir, "plugin.json")} nor ${join(dir, ".codex-plugin", "plugin.json")} exists`,
    // A root manifest is a plugin root to the analyser, but not the shell's one manifest.
    "root-manifest": (dir) => `carries ${join(dir, "plugin.json")}, which the host reads before ${join(dir, ".codex-plugin", "plugin.json")} and loads no hooks from`,
    "plugin-version": (dir) => `${join(dir, ".codex-plugin", "plugin.json")} has version "${V}-other", expected "${V}"`,
    "core-version": (dir) => `${join(dir, "node_modules", "projectstore", "package.json")} has version "${V}-other", expected "${V}"`,
  };
  for (const [mode, want] of Object.entries(cases)) {
    const f = coreFixture();
    const npm = fakeNpmSpawn({ mode });
    const r = await runVerb("install", f.project, { ...coreOpts(f), json: true, fetchSpawn: npm.spawn });
    const dir = join(npm.installs()[0].cwd, "node_modules", SHELL);
    assert.equal(r.plan.ok, false, mode);
    assert.ok(r.plan.refusals[0].includes(want(dir)), `${mode}: ${r.plan.refusals[0]}`);
    assert.match(r.plan.refusals[0], /nothing is staged$/);
    assert.equal(existsSync(join(f.home, "projectstore")), false, `${mode}: nothing staged`);
  }
});

test("shell fetch: a named distribution root is used as is and npm is never called; one that is not a plugin root keeps the incomplete row", async () => {
  const f = fixture(V);
  const npm = fakeNpmSpawn();
  const r = await runVerb("install", f.project, { ...opts(f), root: CORE, json: true, fetchSpawn: npm.spawn, spawn: fakeCodex(f) });
  assert.deepEqual(npm.calls, [], "nothing fetched");
  assert.deepEqual(r.fetched, []);
  assert.equal(registration(r.plan).steps.find((s) => s.kind === "portable-write").from, f.root);
  // The plan a shell's run makes, as it did before this story: the same rows for that root.
  const g = fixture(V);
  const before = plan(g.project, { ...opts(g), root: CORE });
  const after = plan(g.project, planOptions({ ...opts(g), root: CORE }));
  const norm = (p) => JSON.stringify(p.items.map(publicItem)).split(g.base).join("<base>");
  assert.equal(norm(after), norm(before), "a version changes nothing when a payload is named");
  const other = mkdtempSync(join(tmpdir(), "ps-other-shell-"));
  const broken = await runVerb("install", g.project, { ...opts(g, { env: { ...g.env, PROJECTSTORE_DISTRIBUTION_ROOT: other } }), root: CORE, json: true, fetchSpawn: npm.spawn });
  assert.deepEqual(npm.calls, []);
  assert.equal(broken.plan.incomplete, true);
  assert.match(registration(broken.plan).reason, /is not a portable plugin root/);
});

test("shell fetch: npm is never called by uninstall, a Claude Code-only run, --no-register, --surface agents_block, a bare upgrade that cannot ask, the own shell's core, or a run with no codex and nothing of ours", async () => {
  const runs = [];
  const check = async (what, verb, f, extra) => {
    const npm = fakeNpmSpawn();
    const r = await runVerb(verb, f.project, { ...coreOpts(f), fetchSpawn: npm.spawn, ...extra });
    assert.deepEqual(npm.calls, [], `${what}: npm was called`);
    assert.deepEqual(r.fetched, [], what);
    runs.push(what);
    return r;
  };
  await check("uninstall", "uninstall", coreFixture(), { json: true });
  await check("uninstall --global", "uninstall", coreFixture(), { json: true, globalRemoval: true });
  const claude = coreFixture();
  mkdirSync(join(claude.project, loadHarness("claude-code").runtime.harness_dir));
  await check("a Claude Code-only run", "install", claude, { harnesses: ["claude-code"], json: true });
  await check("--no-register", "upgrade", coreFixture(), { register: false, json: true });
  await check("--surface agents_block", "upgrade", coreFixture(), { surfaces: ["agents_block"], json: true });
  // A bare upgrade selects Codex by its directory, and cannot be asked.
  const bare = () => { const f = coreFixture(); mkdirSync(join(f.project, CODEX.runtime.harness_dir)); return f; };
  const tty = { isTTY: true };
  for (const [what, extra] of [
    ["no terminal", {}],
    ["CI=1", { stdin: tty, stdout: tty }],
    ["--json", { json: true, ask: async () => "y" }],
    ["a session marker", { stdin: tty, stdout: tty }],
  ]) {
    const f = bare();
    if (what === "CI=1") f.env.CI = "1";
    if (what === "a session marker") f.env[loadHarness("claude-code").runtime.session_env[0]] = "1";
    const r = await check(`a bare upgrade, ${what}`, "upgrade", f, { harnesses: [], ...extra });
    assert.deepEqual(r.plan.harnesses, [CODEX.id]);
    assert.ok(registration(r.plan).steps.some((s) => s.kind === "fetch"), `${what}: the preview is the dry run`);
  }
  // The core the Codex shell bundles: <dir>/node_modules/projectstore under its package.json.
  const shellDir = mkdtempSync(join(tmpdir(), "ps-own-shell-"));
  writeFileSync(join(shellDir, "package.json"), JSON.stringify({ name: SHELL, version: V }) + "\n");
  const own = join(shellDir, "node_modules", "projectstore");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "package.json"), JSON.stringify({ name: "projectstore", version: V }) + "\n");
  const ownRun = await check("the own shell's core", "upgrade", coreFixture(), { root: own, surfaces: ["plugin"], json: true });
  assert.equal(registration(ownRun.plan).deferred, true);
  assert.equal(registration(ownRun.plan).reason, "this run is from the plugin's own copy, which does not fetch");
  assert.equal(ownRun.plan.incomplete, false, "deferred, as before, not incomplete");
  // No codex on PATH and nothing of ours: the host's reason, after no fetch.
  const absent = coreFixture();
  rmSync(join(absent.bin, CODEX.surfaces.plugin.cli.bin));
  const gone = await check("codex absent", "install", absent, { json: true });
  assert.match(registration(gone.plan).reason, /^`codex` is not on PATH/);
  // …and with something of ours on the machine: the row defers, and a fetch could only have refused.
  const ours = coreFixture();
  rmSync(join(ours.bin, CODEX.surfaces.plugin.cli.bin));
  writeFileSync(join(ours.home, "config.toml"), '[plugins."projectstore@projectstore-npx"]\nenabled = true\n');
  const deferred = await check("codex absent, ours present", "upgrade", ours, { json: true });
  assert.equal(registration(deferred.plan).deferred, true);
  assert.equal(registration(deferred.plan).reason, "`codex` is not on PATH; no registration mutation was attempted");
  assert.equal(runs.length, 12);
});

test("shell fetch, rule 1: the decision skips a harness whose session marker is set, and fetches the same harness without it", () => {
  const marked = { ...CODEX, runtime: { ...CODEX.runtime, session_env: ["PS_TEST_CODEX_SESSION"] } };
  const go = { verb: "install", harness: marked, s: marked.surfaces.plugin, named: true, analysis: { state: "absent", bin: "/usr/local/bin/codex" } };
  assert.deepEqual(fetchDecision({ ...go, env: { PS_TEST_CODEX_SESSION: "1" } }), { fetch: false, why: "in-session" });
  assert.deepEqual(fetchDecision({ ...go, env: {} }), { fetch: true, why: null });
  // Every other condition, once each.
  assert.equal(fetchDecision({ ...go, env: {}, verb: "plan" }).why, "verb");
  assert.equal(fetchDecision({ ...go, env: {}, verb: "uninstall" }).why, "verb");
  assert.equal(fetchDecision({ ...go, env: {}, excluded: true }).why, "excluded");
  assert.equal(fetchDecision({ ...go, env: { PROJECTSTORE_DISTRIBUTION_ROOT: "/x" } }).why, "root-named");
  assert.equal(fetchDecision({ ...go, env: {}, named: false }).why, "not-interactive");
  assert.equal(fetchDecision({ ...go, env: {}, named: false, interactive: true }).fetch, true);
  for (const state of ["unavailable", "foreign", "conflict"]) assert.equal(fetchDecision({ ...go, env: {}, analysis: { state } }).why, state);
  // No host CLI, though something of ours exists: the row defers, so nothing is fetched.
  assert.deepEqual(fetchDecision({ ...go, env: {}, analysis: { state: "stale", bin: null } }), { fetch: false, why: "no-host-cli" });
  assert.equal(fetchDecision({ ...go, env: {}, ownShell: true }).why, "own-shell");
  assert.equal(fetchDecision({ ...go, env: {}, harness: loadHarness("claude-code"), s: loadHarness("claude-code").surfaces.plugin }).why, "not-shell-rooted");
});

test("shell fetch: plan() given payloadRoots plans Codex from its root and Claude Code from the core; an entry under another id leaves Codex deferred", () => {
  const f = fixture(V);
  for (const d of [loadHarness("claude-code").runtime.harness_dir, CODEX.runtime.harness_dir]) mkdirSync(join(f.project, d));
  const { PROJECTSTORE_DISTRIBUTION_ROOT: _named, ...env } = f.env;
  const p = plan(f.project, { root: CORE, home: f.home, env, payloadRoots: { [CODEX.id]: f.root } });
  assert.deepEqual(p.harnesses, ["claude-code", CODEX.id]);
  const codexRow = p.items.find((i) => i.harness === CODEX.id && i.surface === "plugin");
  assert.equal(codexRow.steps.find((s) => s.kind === "portable-write").from, f.root);
  const claude = p.items.find((i) => i.harness === "claude-code" && i.surface === "plugin");
  assert.ok(claude && !JSON.stringify(claude).includes(f.root), "Claude Code's registration is planned from the core, not the fetched root");
  assert.equal(p.root, CORE);
  const elsewhere = plan(f.project, { root: CORE, home: f.home, env, payloadRoots: { "claude-code": f.root } });
  const row = elsewhere.items.find((i) => i.harness === CODEX.id && i.surface === "plugin");
  assert.equal(row.deferred, true);
  assert.match(row.reason, /the core package is not Codex's plugin root/);
});

test("shell fetch: uninstall --global from the core plans the host's removal, the marketplace removal and the source removal from its facts, rechecks and applies; a project uninstall reads global", async () => {
  const f = fixture();
  apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const { PROJECTSTORE_DISTRIBUTION_ROOT: _named, ...env } = f.env;
  const local = await runVerb("uninstall", f.project, { harnesses: ["codex"], root: CORE, home: f.home, env, json: true, spawn: fakeCodex(f) });
  assert.match(registration(local.plan).reason, /^the plugin package and cache are global/);
  assert.ok(!/the core package is not/.test(JSON.stringify(local.plan.items)));
  const called = [];
  const base = fakeCodex(f);
  const r = await runVerb("uninstall", f.project, { harnesses: ["codex"], surfaces: ["plugin"], root: CORE, home: f.home, env, json: true, globalRemoval: true, spawn: (bin, argv) => { called.push(argv.join(" ")); return base(bin, argv); } });
  const item = registration(r.plan);
  assert.equal(item.action, "remove", JSON.stringify(item));
  assert.deepEqual(item.steps.map((s) => s.name || s.kind), ["uninstall", "marketplace_remove", "portable-remove"]);
  assert.equal(r.failed, null, JSON.stringify(r.failed));
  assert.deepEqual(called, ["plugin remove projectstore@projectstore-npx", "plugin marketplace remove projectstore-npx"]);
  assert.equal(existsSync(join(f.home, "projectstore", "marketplace")), false);
  assert.equal(registration(plan(f.project, opts(f))).state, "absent");
});

test("shell fetch, plan: a dry run calls no npm and makes no cache; create leads with the fetch, another version updates, the same version is unchanged with a note under --verbose only", () => {
  const f = coreFixture();
  const create = plan(f.project, planOptions(coreOpts(f, { surfaces: ["plugin"] })));
  const row = registration(create);
  assert.equal(row.action, "create");
  assert.equal(row.steps[0].kind, "fetch", "the fetch it would run comes first");
  assert.deepEqual(row.steps[0].argv, rule2Argv(join(f.fetchDir, "<run-id>"), "<registry>"));
  assert.equal(row.steps[1].name, "preflight");
  const stage = row.steps.find((s) => s.kind === "portable-write");
  assert.equal(stage.files, null, "no file count before the fetch");
  const text = renderPreview(create, { icon: (n) => ({ fetch: "↓" }[n] || "·") });
  assert.ok(text.includes(`↓ npm ${rule2Argv(join(f.fetchDir, "<run-id>"), "<registry>").join(" ")}`), text);
  assert.ok(text.includes("(the fetched payload + catalogue + ownership)"), text);
  assert.equal(existsSync(f.cache), false, "plan makes nothing under the cache");
  // A dry-run row handed to apply() stages nothing: there is no payload to copy.
  const host = [];
  const dry = apply(create, { env: f.env, home: f.home, spawn: (_b, argv) => { host.push(argv.join(" ")); return { status: 0, stdout: "", stderr: "" }; } });
  assert.equal(dry.failed.step, "portable-write");
  assert.match(dry.failed.stderr, /planned without Codex's payload — its shell was not fetched — so there is nothing to stage; nothing is written/);
  assert.deepEqual(host, [], "nothing spawned");
  assert.equal(existsSync(join(f.home, "projectstore")), false, "nothing staged or locked");
  assert.deepEqual(Object.keys(create).sort(), ["detected", "harnesses", "incomplete", "items", "mode", "named", "ok", "plannedAgainst", "projectDir", "refusals", "reports", "root"], "the 12-key plan object");
  // A registration at another version: update.
  const other = fixture("0.28.0+codex.dev.one");
  apply(plan(other.project, opts(other)), { env: other.env, home: other.home, spawn: fakeCodex(other) });
  const { PROJECTSTORE_DISTRIBUTION_ROOT: _a, ...otherEnv } = other.env;
  const update = registration(plan(other.project, planOptions({ ...opts(other), env: otherEnv, root: CORE })));
  assert.equal(update.action, "update");
  assert.match(update.reason, new RegExp(`installed 0\\.28\\.0\\+codex\\.dev\\.one; package offers ${V.replace(/\./g, "\\.")}`));
  // At the package's version, source and cache matching their digest: unchanged.
  const same = fixture(V);
  apply(plan(same.project, opts(same)), { env: same.env, home: same.home, spawn: fakeCodex(same) });
  const { PROJECTSTORE_DISTRIBUTION_ROOT: _b, ...sameEnv } = same.env;
  const current = plan(same.project, planOptions({ ...opts(same), env: sameEnv, root: CORE }));
  assert.equal(registration(current).state, "current");
  assert.equal(registration(current).action, "skip");
  assert.equal(registration(current).reason, null, "no note in the default view");
  assert.ok(!("digestDeferred" in publicItem(registration(current))), "a private flag");
  const quiet = renderPreview(current);
  assert.ok(!/payload digest is compared/.test(quiet), quiet);
  assert.match(renderPreview(current, { verbose: true }), /current \(the payload digest is compared when install or upgrade fetches the shell\) → skip/);
});

test("shell fetch, rule 9: the sweep removes a dead run's directory and keeps a live one's and any other name", async () => {
  const f = coreFixture();
  mkdirSync(f.fetchDir, { recursive: true });
  const dead = "99999999-1700000000000", live = `${process.ppid}-1700000000000`, other = "keep-me", near = "123-abc";
  for (const n of [dead, live, other, near]) { mkdirSync(join(f.fetchDir, n)); writeFileSync(join(f.fetchDir, n, "x"), "x"); }
  const r = await runVerb("install", f.project, { ...coreOpts(f), json: true, fetchSpawn: fakeNpmSpawn().spawn });
  assert.equal(r.failed, null);
  assert.deepEqual(readdirSync(f.fetchDir).sort(), [live, near, other].sort(), "the fetching run swept the dead one, and removed its own");
  assert.deepEqual(sweepFetchRuns(f.fetchDir), [], "nothing else is dead");
  assert.deepEqual(sweepFetchRuns(join(f.base, "nowhere")), [], "no directory, nothing to do");
});

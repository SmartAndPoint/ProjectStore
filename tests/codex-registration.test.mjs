import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan, apply, publicItem } from "../scripts/install-harness.mjs";
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
  apply(create, { env: f.env, home: f.home, spawn: fakeCodex(f) });
  const global = plan(f.project, opts(f, { mode: "uninstall", globalRemoval: true }));
  assert.ok(touches(global, "uninstall").includes(config), "plugin remove drops the enablement stanza");
  assert.ok(touches(global, "marketplace_remove").includes(config), "marketplace remove drops the marketplace stanza");
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

test("Codex portable registration: verification requires host-reported enablement and the materialised cache digest", () => {
  const disabled = fixture("0.28.0+codex.dev.disabled");
  const disabledBase = fakeCodex(disabled);
  const disabledSpawn = (bin, argv) => {
    const r = disabledBase(bin, argv);
    if (argv.join(" ") !== "plugin list --json" || r.status !== 0) return r;
    const body = JSON.parse(r.stdout); body.installed[0].enabled = false;
    return { ...r, stdout: JSON.stringify(body) };
  };
  const disabledResult = apply(plan(disabled.project, opts(disabled)), { env: disabled.env, home: disabled.home, spawn: disabledSpawn });
  assert.equal(disabledResult.failed.step, "recovery-required");
  assert.equal(existsSync(join(disabled.home, "projectstore", "projectstore-npx.journal.json")), true);
  const blocked = apply(plan(disabled.project, opts(disabled)), { env: disabled.env, home: disabled.home, spawn: disabledBase });
  assert.equal(blocked.failed.step, "recovery-required");

  const corrupt = fixture("0.28.0+codex.dev.corrupt");
  const corruptBase = fakeCodex(corrupt);
  const corruptSpawn = (bin, argv) => {
    const r = corruptBase(bin, argv);
    if (argv.join(" ") === "plugin list --json" && r.status === 0) {
      const cached = join(corrupt.home, "plugins", "cache", "projectstore-npx", "projectstore", "0.28.0+codex.dev.corrupt", "skills", "projectstore-status", "SKILL.md");
      writeFileSync(cached, "tampered cache\n");
    }
    return r;
  };
  const corruptResult = apply(plan(corrupt.project, opts(corrupt)), { env: corrupt.env, home: corrupt.home, spawn: corruptSpawn });
  assert.equal(corruptResult.failed.step, "recovery-required");
  assert.equal(existsSync(join(corrupt.home, "projectstore", "projectstore-npx.journal.json")), true);
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
  const retry = apply(plan(f.project, opts(f)), { env: f.env, home: f.home, spawn: base });
  assert.equal(retry.failed.step, "recovery-required");
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

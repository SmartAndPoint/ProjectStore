// projectstore — opening a project that is not bound writes nothing into it
// (PS-DIRECTORY, the story "Opening a project that is not bound writes nothing
// into it: the first-run welcome is remembered on the machine").
//
// Measured on 0.30.5 (6a0e375): the first SessionStart in an unbound project
// wrote .projectstore/.gitignore, .projectstore/state/.gitignore and
// .projectstore/state/<id>/welcomed, so `git status` showed `?? .projectstore/`
// in every repository a user-scope install was opened in. The welcome now
// remembers itself on the machine (the user-level cache's welcomed/<id>) when
// the project is not bound, and in the project (state/<id>/welcomed, layout
// spec contract 5) when it is. Both markers are read on both branches.
//
// The band writes its heartbeat only after a draw (band spec, contract 10);
// tests/band-model.test.mjs pins `heartbeatNext("nothing", false, 5) === null`,
// so it is not driven here.
//
// Every run is hermetic: a fixture home, a fixture cache, no host CLI on PATH,
// the harness forced by our own override.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadHarnesses, sourceHarness, cachePaths } from "../scripts/harness.mjs";
import { layoutPaths, ensureStateRoot, RUNTIME_GITIGNORE_HEADER } from "../scripts/lib.mjs";
import { noHostEnv } from "./fixtures/install.mjs";
import { writeBinding } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "projectstore.mjs");
const SRC = sourceHarness();
const MANIFESTS = [...loadHarnesses().values()];
const CODEX = MANIFESTS.find((m) => m.id !== SRC.id) || null;
const TMP = realpathSync(tmpdir());
const MADE = [];
const tmp = (p) => {
  const d = mkdtempSync(join(TMP, p));
  MADE.push(d);
  return d;
};
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
});
const WELCOME = /projectstore is loaded for the first time/;
const PER_PROJECT = "_This message appears once per project._";
const PER_MACHINE = "_This message appears once on this machine._";
// git, and node for the hooks' own spawns; never a host CLI.
const PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);

// ─── Fixtures ──────────────────────────────────────────────────────────

// A machine: a home and a cache of its own, so no test reads another's marker.
function machine() {
  const base = tmp("ps-unbound-machine-");
  const home = join(base, "home"),
    cache = join(base, "cache");
  mkdirSync(home, { recursive: true });
  return { base, home, cache };
}

// An unbound project that is a git repository with one commit, and nothing of
// ours in it. `harnessDir` adds a harness's own directory, as a project that
// has run that harness has.
function repo({ harnessDir = null } = {}) {
  const proj = tmp("ps-unbound-repo-");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf8", env: { PATH, HOME: proj } });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q");
  writeFileSync(join(proj, "README.md"), "# A repository nobody set up for projectstore\n");
  if (harnessDir) {
    mkdirSync(join(proj, harnessDir), { recursive: true });
    writeFileSync(join(proj, harnessDir, "settings.json"), "{}\n");
  }
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return proj;
}

// A bound project: its binding, and a vault with one folder.
function boundProject(binding = {}) {
  const proj = tmp("ps-unbound-bound-");
  const vault = tmp("ps-unbound-vault-");
  mkdirSync(join(vault, "epics"), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en", ...binding });
  return { proj, vault };
}

// Every path under the project but .git/, with its type and its bytes' hash:
// a directory made and left empty counts as a change, as git would not show it.
function tree(proj) {
  const out = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      const rel = relative(proj, p);
      if (rel === ".git") continue;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.push(`${rel}/`);
        walk(p);
      } else out.push(`${rel} ${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`);
    }
  };
  walk(proj);
  return out;
}

const gitStatus = (proj) => {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: proj, encoding: "utf8", env: { PATH, HOME: proj } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

// How a host runs our hooks: the plugin root and (where the harness has one)
// the project directory in the environment, the payload on stdin, the project
// as the working directory. The harness is forced, so the identity is the
// fixture's and never the developer's.
function hookEnv(m, mc, proj, extra = {}) {
  const env = noHostEnv({ PATH, HOME: mc.home, XDG_CACHE_HOME: mc.cache, PROJECTSTORE_HARNESS: m.id });
  if (m.runtime.plugin_root_env) env[m.runtime.plugin_root_env] = ROOT;
  if (m.runtime.project_dir_env) env[m.runtime.project_dir_env] = proj;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runScript(rel, m, mc, proj, payload, extra = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, rel)], {
    input: JSON.stringify({ session_id: `unbound-${m.id}`, cwd: proj, ...payload }),
    env: hookEnv(m, mc, proj, extra),
    cwd: proj,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, `${m.id} ${rel}: exit ${r.status}\n${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const sessionStart = (m, mc, proj, extra = {}) =>
  runScript("hooks/session-start.mjs", m, mc, proj, { hook_event_name: "SessionStart", source: "startup" }, extra);
const contextOf = (out) => out?.hookSpecificOutput?.additionalContext || "";

// Every entry of hooks/hooks.json, by event: the script each command runs,
// whether the root is quoted or not (`node ${ROOT}/x` or `node "${ROOT}/x"`).
function hookEntries() {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  const out = [];
  for (const [event, groups] of Object.entries(hooks))
    for (const g of groups)
      for (const h of g.hooks) {
        const m = /^node\s+"?\$\{[A-Za-z_][A-Za-z0-9_]*\}\/([^"\s]+)"?\s*$/.exec(h.command);
        assert.ok(m, `a hook command this test can run: ${h.command}`);
        out.push({ event, script: m[1] });
      }
  return out;
}

// The payload a host sends for each event, a write in the harness's own shape.
function payloadFor(m, event, proj) {
  const file = join(proj, "src", "a.mjs");
  const t = m.tools;
  const write = {
    tool_name: t.write_tools[0],
    tool_input: t.patch_envelope_field
      ? { [t.patch_envelope_field]: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` }
      : { [t.path_fields[0]]: file, content: "x\n" },
  };
  const name = m.hooks?.events?.[event] || event;
  if (event === "SessionStart") return { hook_event_name: name, source: "startup" };
  if (event === "PreToolUse") return { hook_event_name: name, ...write };
  if (event === "PostToolUse") return { hook_event_name: name, ...write, tool_response: { success: true } };
  if (event === "Stop") return { hook_event_name: name, stop_hook_active: false };
  if (event === "PreCompact") return { hook_event_name: name, trigger: "manual" };
  return { hook_event_name: name };
}

// The MCP server as the host starts it: the handshake and one read tool.
function mcpSession(m, mc, proj) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [BIN, "mcp", "--project", proj], {
      cwd: proj,
      env: hookEnv(m, mc, proj),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "",
      stderr = "";
    const got = new Map();
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error(`mcp: no answer in 30s; stderr: ${stderr}`));
    }, 30000);
    const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        got.set(msg.id, msg);
        if (msg.id === 0) {
          send({ method: "notifications/initialized" });
          send({ id: 1, method: "tools/call", params: { name: "status", arguments: {} } });
        } else if (msg.id === 1) child.stdin.end();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      res({ code, init: got.get(0), status: got.get(1), stderr });
    });
    send({
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
  });
}

// What a first SessionStart of 0.30.5 or earlier left in a project, bound or
// not: the state directory's header and the welcome marker.
function plant0305(proj, id) {
  ensureStateRoot(proj);
  const marker = layoutPaths(proj).welcomed(id);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "2026-10-14T12:00:00.000Z\n");
  return marker;
}

const machineMarker = (mc, id) => join(mc.cache, "projectstore", "welcomed", id);

// ─── Nothing lands in an unbound project ───────────────────────────────

test("unbound: every hooks.json entry, the MCP handshake and a read tool leave an unbound git repository's tree and git status unchanged, under every harness", async () => {
  const entries = hookEntries();
  const events = new Set(entries.map((e) => e.event));
  for (const ev of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "PreCompact"])
    assert.ok(events.has(ev), `hooks.json registers ${ev}, so this test drives it`);
  for (const m of MANIFESTS) {
    const mc = machine();
    const proj = repo();
    const before = tree(proj);
    const statusBefore = gitStatus(proj);
    assert.equal(statusBefore, "", "a clean repository to start from");
    let welcomed = 0;
    for (const { event, script } of entries) {
      const out = runScript(script, m, mc, proj, payloadFor(m, event, proj));
      if (script === "hooks/session-start.mjs" && WELCOME.test(contextOf(out))) welcomed++;
    }
    // Not vacuous: the hook did run its welcome path, which is the one that wrote.
    assert.equal(welcomed, 1, `${m.id}: the first SessionStart carries the welcome`);
    const mcp = await mcpSession(m, mc, proj);
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.equal(mcp.init?.result?.serverInfo?.name, "projectstore", "the handshake answered");
    assert.equal(mcp.status?.result?.isError, false, "the read tool answered");
    assert.equal(JSON.parse(mcp.status.result.content[0].text).result.bound, false, "and says the project is unbound");
    assert.deepEqual(tree(proj), before, `${m.id}: nothing was written into the project`);
    assert.equal(gitStatus(proj), statusBefore, `${m.id}: git status is as it was`);
    assert.ok(existsSync(machineMarker(mc, m.id)), `${m.id}: the welcome is remembered on the machine instead`);
  }
});

// ─── Once per machine ─────────────────────────────────────────────────

test("unbound: the welcome shows once per machine — the marker lands under XDG_CACHE_HOME, a second repository shows none, and Codex keeps its own marker", () => {
  const mc = machine();
  const a = repo(),
    b = repo(),
    c = repo();
  const first = sessionStart(SRC, mc, a);
  assert.match(contextOf(first), WELCOME, "the first unbound session is welcomed");
  assert.match(first.systemMessage, /first-run welcome shown/);
  assert.equal(sessionStart(SRC, mc, b), null, "a second unbound repository on the machine: no welcome, no payload");
  assert.equal(sessionStart(SRC, mc, a), null, "nor the first one again");
  const marker = machineMarker(mc, SRC.id);
  assert.equal(cachePaths({ env: { XDG_CACHE_HOME: mc.cache }, home: mc.home }).welcomed(SRC.id), marker);
  assert.ok(existsSync(marker), "the machine marker, under the absolute XDG_CACHE_HOME");
  assert.match(readFileSync(marker, "utf8"), /^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/, "one ISO line");
  assert.ok(!existsSync(join(mc.home, ".cache")), "and not under the home when XDG_CACHE_HOME is set");
  // The footer follows the binding (decided at the plan gate).
  assert.ok(contextOf(first).includes(PER_MACHINE), "the welcome says it appears once on this machine");
  assert.ok(!contextOf(first).includes(PER_PROJECT));
  if (CODEX) {
    const cx = sessionStart(CODEX, mc, b);
    assert.match(contextOf(cx), WELCOME, `${CODEX.id} has its own marker, so its first session is welcomed`);
    assert.ok(existsSync(machineMarker(mc, CODEX.id)));
    assert.equal(sessionStart(CODEX, mc, c), null, `${CODEX.id}: once per machine too`);
  }
  for (const p of [a, b, c]) assert.equal(gitStatus(p), "", "and every repository's status stays clean");
});

test("unbound: without XDG_CACHE_HOME the marker lands under <home>/.cache/projectstore", () => {
  const mc = machine();
  const proj = repo();
  const out = sessionStart(SRC, mc, proj, { XDG_CACHE_HOME: undefined });
  assert.match(contextOf(out), WELCOME);
  assert.ok(existsSync(join(mc.home, ".cache", "projectstore", "welcomed", SRC.id)), "the home's cache");
  assert.equal(sessionStart(SRC, mc, repo(), { XDG_CACHE_HOME: undefined }), null, "and it is read there too");
  assert.equal(gitStatus(proj), "");
});

// ─── An earlier marker still counts ───────────────────────────────────

test("unbound: a project that holds 0.30.5's marker, or the legacy one, prints no welcome with no machine marker, and gains nothing", () => {
  const mc = machine();
  const proj = repo();
  plant0305(proj, SRC.id);
  const before = tree(proj);
  assert.equal(sessionStart(SRC, mc, proj), null, "state/<id>/welcomed counts on the unbound branch");
  assert.deepEqual(tree(proj), before);
  assert.ok(!existsSync(machineMarker(mc, SRC.id)), "a welcome not shown writes no marker");
  const legacy = repo();
  const lp = layoutPaths(legacy);
  mkdirSync(dirname(lp.legacy.welcomed), { recursive: true });
  writeFileSync(lp.legacy.welcomed, "2026-09-01T00:00:00Z\n");
  assert.equal(sessionStart(SRC, mc, legacy), null, "the legacy marker counts while the window is open");
});

// ─── Bound projects ───────────────────────────────────────────────────

test("bound: with neither marker the welcome shows once and the project's marker is written (contract 5); on a machine that has shown the unbound welcome a bound project shows none", () => {
  const mc = machine();
  const { proj } = boundProject();
  const first = sessionStart(SRC, mc, proj);
  assert.match(contextOf(first), WELCOME);
  assert.ok(contextOf(first).includes(PER_PROJECT), "a bound project's welcome stays once per project");
  assert.ok(!contextOf(first).includes(PER_MACHINE));
  const lp = layoutPaths(proj);
  assert.ok(existsSync(lp.welcomed(SRC.id)), "the project's marker, under state/<id>/");
  assert.ok(readFileSync(lp.stateGitignore, "utf8").includes(RUNTIME_GITIGNORE_HEADER), "with its header beside it");
  assert.ok(!existsSync(machineMarker(mc, SRC.id)), "and no machine marker from a bound project");
  assert.ok(!WELCOME.test(contextOf(sessionStart(SRC, mc, proj))), "once per project");
  // The unbound welcome, seen on this machine, covers the bound project too (decision 3).
  assert.match(contextOf(sessionStart(SRC, mc, repo())), WELCOME);
  const other = boundProject();
  const second = sessionStart(SRC, mc, other.proj);
  assert.ok(second, "a bound project still gets its skeleton");
  assert.ok(!WELCOME.test(contextOf(second)), "but no welcome on a machine that has shown it");
  assert.ok(contextOf(second).includes("Projectstore vault:"), "the skeleton's header names the vault instead");
});

test("bound: under auto_inject false the welcome still shows on the first run (skeleton spec, contract 16)", () => {
  const mc = machine();
  const { proj } = boundProject({ auto_inject: false });
  const out = sessionStart(SRC, mc, proj);
  assert.match(contextOf(out), WELCOME);
  assert.equal(sessionStart(SRC, mc, proj), null, "and then the opted-out session is silent");
});

// ─── The CLI reads no harness from an unbound visit ───────────────────

test("unbound: after sessions of every harness, a bare upgrade and a bare uninstall select no harness from state/ (install spec contracts 13 and 14)", () => {
  const mc = machine();
  const proj = repo();
  for (const m of MANIFESTS)
    for (const { event, script } of hookEntries()) runScript(script, m, mc, proj, payloadFor(m, event, proj));
  for (const verb of ["upgrade", "uninstall"]) {
    const r = spawnSync(process.execPath, [BIN, verb, "--json", "--project", proj], {
      cwd: proj,
      env: noHostEnv({ PATH, HOME: mc.home, XDG_CACHE_HOME: mc.cache }),
      encoding: "utf8",
      timeout: 60000,
    });
    const env = JSON.parse(r.stdout);
    assert.deepEqual(
      env.result.items.map((i) => i.harness),
      [],
      `${verb}: plans no harness\n${r.stdout.slice(0, 600)}`,
    );
    assert.match(env.result.refusals[0], /^No harness detected in /, `${verb}: and says so`);
  }
  assert.equal(existsSync(layoutPaths(proj).state), false, "there is no state directory to read");
});

// ─── The posture holds ────────────────────────────────────────────────

test("unbound: an unwritable cache root, or none at all, still exits 0 with the welcome, writes nothing into the project, and welcomes again next time", () => {
  for (const [what, extra] of [
    // A file where the cache directory would be: the mkdir fails.
    [
      "an unwritable cache",
      (mc) => {
        writeFileSync(mc.cache, "not a directory\n");
        return {};
      },
    ],
    // No absolute XDG_CACHE_HOME and an empty HOME: cachePaths has no root.
    ["no cache root", () => ({ XDG_CACHE_HOME: "relative", HOME: "" })],
  ]) {
    const mc = machine();
    const env = extra(mc);
    const proj = repo();
    const before = tree(proj);
    const out = sessionStart(SRC, mc, proj, env);
    assert.match(contextOf(out), WELCOME, `${what}: the welcome, and exit 0 (runScript asserts it)`);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart", `${what}: a usable payload`);
    assert.deepEqual(tree(proj), before, `${what}: nothing in the project`);
    assert.match(contextOf(sessionStart(SRC, mc, proj, env)), WELCOME, `${what}: the welcome shows again (decision 5)`);
    assert.deepEqual(tree(proj), before);
  }
});

// ─── Decision 7: a project 0.30.5 already wrote into ──────────────────

test("unbound, 0.30.5's files: uninstall --harness removes the marker and its directory and leaves the two .gitignore files, so git status still shows .projectstore/ until the folder is deleted", () => {
  const mc = machine();
  const proj = repo();
  const marker = plant0305(proj, SRC.id);
  const lp = layoutPaths(proj);
  assert.equal(gitStatus(proj), "?? .projectstore/\n", "what 0.30.5 left: the untracked folder");
  const r = spawnSync(process.execPath, [BIN, "uninstall", "--harness", SRC.id, "--json", "--project", proj], {
    cwd: proj,
    env: noHostEnv({ PATH, HOME: mc.home, XDG_CACHE_HOME: mc.cache }),
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(marker), false, "the marker is recognised and removed (install spec contract 13)");
  assert.equal(existsSync(lp.harnessState(SRC.id)), false, "and its emptied directory");
  assert.deepEqual(
    tree(proj)
      .filter((p) => p.startsWith(".projectstore"))
      .map((p) => p.split(" ")[0]),
    [".projectstore/", ".projectstore/.gitignore", ".projectstore/state/", ".projectstore/state/.gitignore"],
  );
  assert.equal(gitStatus(proj), "?? .projectstore/\n", "the two ignore files keep the folder untracked");
  rmSync(lp.root, { recursive: true });
  assert.equal(gitStatus(proj), "", "deleting the folder is the way back to a clean status");
});

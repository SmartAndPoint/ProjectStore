// projectstore — the band's command, its manifests and its packaging.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield, contracts 1 and 13.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/cli.mjs";
import { sourceHarness, loadHarness, hasBand, hostSessionId, layoutPaths } from "../scripts/harness.mjs";
import { renderHooks } from "../scripts/build-adapters.mjs";
import { heartbeatFile, heartbeatBody } from "../scripts/band-shared.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const TEMP = [];
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }); });

function project() {
  const { proj, vault } = makeVaultProject();
  TEMP.push(proj);
  mkdirSync(join(vault, "epics", "PS-Y"), { recursive: true });
  return { proj, vault };
}

const SID = "band-test-session";
const envFor = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, [SRC.runtime.session_id_env]: SID, ...extra });

function sink() {
  let text = "";
  return { write: (s) => { text += s; return true; }, isTTY: false, get text() { return text; } };
}

async function band(proj, args, { env = envFor(), ask = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["band", ...args, "--project", proj], { env, cwd: proj, stdout, stderr, stdin: { isTTY: false }, ask });
  let json = null;
  try { json = JSON.parse(stdout.text); } catch {}
  return { code, out: stdout.text, err: stderr.text, json };
}

const bindingOf = (proj) => JSON.parse(readFileSync(layoutPaths(proj).binding, "utf8"));

// ─── Contract 13: the verb ─────────────────────────────────────────────

test("contract 13: on, off, epic <ID> and bare epic each write the binding once, and remember the hint", async () => {
  const { proj } = project();
  const before = bindingOf(proj);

  let r = await band(proj, ["off", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.result.wrote, true);
  assert.deepEqual(bindingOf(proj).band, { enabled: false, hint_seen: true });
  for (const k of Object.keys(before)) assert.deepEqual(bindingOf(proj)[k], before[k], `${k} is kept`);

  const mtime = statSync(layoutPaths(proj).binding).mtimeMs;
  r = await band(proj, ["off", "--json"]);
  assert.equal(r.json.result.wrote, false, "nothing to change is no write");
  assert.equal(statSync(layoutPaths(proj).binding).mtimeMs, mtime);

  r = await band(proj, ["epic", "ps-y", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(bindingOf(proj).band.epic, "PS-Y", "matched case-insensitively, written as the folder is named");

  r = await band(proj, ["epic", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal("epic" in bindingOf(proj).band, false);

  r = await band(proj, ["on", "--json"]);
  assert.deepEqual(bindingOf(proj).band, { enabled: true, hint_seen: true });
});

test("contract 13: an unknown epic is refused and names the ones that exist; nothing is written", async () => {
  const { proj } = project();
  const before = readFileSync(layoutPaths(proj).binding, "utf8");
  const r = await band(proj, ["epic", "NOPE", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.json.result.error, /no epic NOPE — epics: PS-X, PS-Y/);
  assert.equal(readFileSync(layoutPaths(proj).binding, "utf8"), before);
});

test("contract 13: without --json a terminal is asked; without a terminal the write is refused", async () => {
  const { proj } = project();
  const asked = [];
  let r = await band(proj, ["off"], { ask: async (q) => { asked.push(q); return "n"; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /switch the band off/);
  assert.equal(bindingOf(proj).band, undefined, "a no writes nothing");
  r = await band(proj, ["off"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /passes --json/);
  r = await band(proj, ["off", "--json"], { ask: async () => { throw new Error("--json never asks"); } });
  assert.equal(r.code, 0);
});

test("contract 13: status writes nothing and names one reason", async () => {
  const { proj, vault } = project();
  const path = layoutPaths(proj).binding;
  const status = async (env) => (await band(proj, ["status", "--json"], { env })).json.result;

  let s = await status(envFor());
  assert.equal(s.reason, "no_epic");
  assert.equal(s.session_id, SID);

  const sessions = layoutPaths(proj).sessions;
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${SID}.json`), JSON.stringify({ active_epic: "PS-X" }));
  s = await status(envFor());
  assert.equal(s.session_epic, "PS-X");
  assert.equal(s.reason, "not_drawing");

  writeFileSync(join(sessions, heartbeatFile(SID)), JSON.stringify(heartbeatBody(true, Date.now())));
  s = await status(envFor());
  assert.equal(s.reason, null);
  assert.equal(s.yielding, true);

  const cfg = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...cfg, band: { enabled: false } }));
  rmSync(join(sessions, heartbeatFile(SID)));
  s = await status(envFor());
  assert.equal(s.reason, "off");

  writeFileSync(path, JSON.stringify({ ...cfg, band: { epic: "PS-GONE" } }));
  rmSync(join(sessions, `${SID}.json`));
  s = await status(envFor());
  assert.equal(s.reason, "pin_missing");

  s = await status(envFor({ PROJECTSTORE_HARNESS: "codex" }));
  assert.equal(s.reason, "harness");

  const before = readFileSync(path, "utf8");
  s = await status({ PATH: process.env.PATH, HOME: process.env.HOME });
  assert.equal(s.session_id, null, "no session variable: the session is unknown");
  assert.equal(s.reason, "session_unknown", "an unknown session is the reason, never a guess at its epic");
  assert.equal(readFileSync(path, "utf8"), before, "status wrote nothing");
  assert.equal((await band(proj, ["status"])).out.includes("not drawing:"), true);
  void vault;
});

test("contract 13: the host's session id is read through the manifest, never by name in scripts/", () => {
  assert.equal(typeof SRC.runtime.session_id_env, "string");
  assert.equal(hostSessionId({ [SRC.runtime.session_id_env]: "abc" }, SRC), "abc");
  assert.equal(hostSessionId({}, SRC), null);
  assert.equal(hostSessionId({ X: "abc" }, loadHarness("codex")), null);
});

// ─── Contract 1: manifests, generator, packaging ───────────────────────

test("contract 1: Claude Code declares the band, Codex states why it has none", () => {
  const cc = SRC.surfaces.band;
  assert.equal(cc.supported, true);
  assert.equal(cc.kind, "host");
  assert.equal(cc.registered_by, "plugin");
  assert.equal(cc.verified, null, "experimental until the live measurement");
  assert.ok(cc.scope && cc.scope_reason && cc.verified_reason);
  const cx = loadHarness("codex").surfaces.band;
  assert.equal(cx.supported, false);
  assert.ok(cx.why_unsupported && cx.scope_reason);
  assert.equal(hasBand(SRC), true);
  assert.equal(hasBand(loadHarness("codex")), false);
});

test("contract 1: the module rides hooks.json beside the classic hooks, which it leaves as they were", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(reg.modules, ["./band.tsx"]);
  const classic = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "hooks-classic.json"), "utf8"));
  assert.deepEqual(reg.hooks, classic, "the classic hook entries are byte-for-byte the pre-band ones");
  const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.types, "./hooks/band-state.d.ts");
});

test("contract 1: the generator keeps the module out of a harness without a band", () => {
  const [, codexText] = renderHooks(loadHarness("codex"));
  const codex = JSON.parse(codexText);
  assert.equal("modules" in codex, false);
  assert.ok(codex.hooks.SessionStart, "the classic hooks are still rendered");
  const committed = JSON.parse(readFileSync(join(ROOT, "adapters", "codex", "hooks", "hooks.json"), "utf8"));
  assert.equal("modules" in committed, false, "the committed Codex tree carries no module");
  const withBand = { ...loadHarness("codex"), surfaces: { ...loadHarness("codex").surfaces, band: { supported: true } } };
  assert.deepEqual(JSON.parse(renderHooks(withBand)[1]).modules, ["./band.tsx"], "a harness with a band keeps it");
});

test("contract 1: the module ships; the host-laid declarations and tsconfig do not", () => {
  const packlist = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "packlist.json"), "utf8"));
  const files = Array.isArray(packlist) ? packlist : packlist.files || packlist.paths || [];
  for (const f of ["hooks/band.tsx", "hooks/band-state.d.ts", "scripts/band-shared.mjs", "scripts/stages.mjs", "scripts/band.mjs", "commands/bar.md"]) {
    assert.ok(files.includes(f), `${f} ships`);
  }
  assert.equal(files.some((f) => f.startsWith(".claude-plugin/types/") || f === "tsconfig.json"), false);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("!.claude-plugin/types/"));
  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
  assert.ok(ignore.includes(".claude-plugin/types/") && ignore.includes("/tsconfig.json"));
});

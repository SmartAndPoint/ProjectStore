// projectstore — the status line gives way to the band above the prompt.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield, contract 11. The renderer runs as its own process here, as the
// host runs it: JSON on stdin, the line on stdout. Every case that must NOT
// yield is compared byte for byte with a run that has no heartbeat at all.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { sourceHarness, layoutPaths } from "../scripts/harness.mjs";
import { cleanupStaleSessionState } from "../scripts/lib.mjs";
import { checkStatusline } from "../scripts/doctor.mjs";
import {
  HEARTBEAT_WINDOW_MS,
  heartbeatFile,
  heartbeatBody,
  heartbeatState,
  heartbeatYields,
} from "../scripts/band-shared.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const VERSION = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
const TEMP = [];
after(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(d);
  return d;
};

const SID = "5e55-10n";

// ─── The predicate ─────────────────────────────────────────────────────

test("contract 11: the heartbeat yields only while it says drawing and is younger than the window", () => {
  const now = 1_000_000;
  assert.equal(HEARTBEAT_WINDOW_MS, 30_000);
  assert.equal(heartbeatYields(heartbeatBody(true, now), now), true);
  assert.equal(heartbeatYields({ drawn: true, drawn_at: now - 29_999 }, now), true);
  for (const [why, value] of [
    ["at the window", { drawn: true, drawn_at: now - 30_000 }],
    ["stale", { drawn: true, drawn_at: now - 60_000 }],
    ["future-dated", { drawn: true, drawn_at: now + 1 }],
    ["stopped", heartbeatBody(false, now)],
    ["no time", { drawn: true }],
    ["a string time", { drawn: true, drawn_at: String(now) }],
    ["not a boolean", { drawn: "true", drawn_at: now }],
    ["null", null],
    ["a number", 42],
  ])
    assert.equal(heartbeatYields(value, now), false, why);
  assert.equal(heartbeatState({ drawn: true, drawn_at: now }, now), "drawing");
  assert.equal(heartbeatState({ drawn: false, drawn_at: now }, now), "stopped");
  assert.equal(heartbeatState({ drawn: true, drawn_at: now - 30_000 }, now), "stale");
  assert.equal(heartbeatState(undefined, now), "none");
});

test("contract 11: the heartbeat's name is dot-prefixed and refuses an id that cannot name a file", () => {
  assert.equal(heartbeatFile("abc"), ".band-abc.json");
  for (const bad of ["", null, undefined, "a/b", "a\\b", "..", "."])
    assert.equal(heartbeatFile(bad), null, String(bad));
});

// ─── The renderer ──────────────────────────────────────────────────────

function project({ base }) {
  const { proj } = makeVaultProject();
  TEMP.push(proj);
  if (base)
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "printf BASE" } }),
    );
  return proj;
}

function heartbeat(proj, value) {
  const dir = layoutPaths(proj).sessions;
  mkdirSync(dir, { recursive: true });
  const p = join(dir, heartbeatFile(SID));
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return p;
}

function render(proj) {
  const env = { ...process.env, [SRC.runtime.plugin_root_env]: ROOT, [SRC.runtime.home_env]: tmp("ps-sl-home-") };
  const input = { session_id: SID, workspace: { project_dir: proj }, model: { display_name: "Opus" } };
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "statusline.mjs")], {
    cwd: proj,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const breadcrumb = (proj) => JSON.parse(readFileSync(join(layoutPaths(proj).sessions, ".last-render.json"), "utf8"));

for (const base of [true, false]) {
  const mode = base ? "composed" : "standalone";

  test(`contract 11, ${mode}: with no heartbeat the line is ProjectStore's own`, () => {
    const proj = project({ base });
    const out = render(proj);
    assert.match(out, new RegExp(`\\[PS#${VERSION.replace(/\./g, "\\.")}\\]`));
    assert.match(out, /📚 /);
    if (base) assert.match(out, /^\[PS#[^\n]*\nBASE\n$/);
    assert.equal(breadcrumb(proj).session_id, SID);
  });

  test(`contract 11, ${mode}: a fresh heartbeat takes ProjectStore's line away and nothing else`, () => {
    const proj = project({ base });
    heartbeat(proj, heartbeatBody(true, Date.now()));
    const out = render(proj);
    if (base) assert.equal(out, "BASE\n");
    else assert.equal(out, `Opus · ${basename(proj)}\n`);
    assert.doesNotMatch(out, /\[PS#|📚/);
    assert.equal(breadcrumb(proj).session_id, SID, "the breadcrumb is written while the band is up");
  });

  test(`contract 11, ${mode}: a heartbeat that is not drawing changes nothing, byte for byte`, () => {
    const proj = project({ base });
    const plain = render(proj);
    const now = Date.now();
    for (const [why, value] of [
      ["unparseable", "{not json"],
      ["stale", heartbeatBody(true, now - 60_000)],
      ["future-dated", heartbeatBody(true, now + 60_000)],
      ["stopped", heartbeatBody(false, now)],
    ]) {
      const p = heartbeat(proj, value);
      assert.equal(render(proj), plain, why);
      assert.equal(breadcrumb(proj).session_id, SID, why);
      rmSync(p);
    }
  });
}

test("contract 11: another session's heartbeat does not make this one yield", () => {
  const proj = project({ base: true });
  const dir = layoutPaths(proj).sessions;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, heartbeatFile("other-session")), JSON.stringify(heartbeatBody(true, Date.now())));
  assert.match(render(proj), /📚 /);
});

// ─── Doctor and the sweep ──────────────────────────────────────────────

test("a heartbeat with no pointer raises no session-id divergence in doctor", () => {
  const proj = project({ base: false });
  heartbeat(proj, heartbeatBody(true, Date.now()));
  render(proj); // writes the breadcrumb for SID; no pointer file exists
  const home = tmp("ps-sl-doctor-home-");
  const findings = checkStatusline({ vault_path: join(proj, "vault"), statusline: { enabled: false } }, proj, home);
  assert.deepEqual(
    findings.filter((f) => /divergence/.test(f.message)),
    [],
  );
});

test("the session-state sweep reaps an aged heartbeat", () => {
  const proj = project({ base: false });
  const p = heartbeat(proj, heartbeatBody(true, Date.now()));
  const old = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(p, old, old);
  cleanupStaleSessionState(proj, 24);
  assert.equal(existsSync(p), false);
});

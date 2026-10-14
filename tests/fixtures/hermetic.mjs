// projectstore — tests/fixtures/hermetic.mjs: loaded before every test file
// (package.json: `node --test --import ./tests/fixtures/hermetic.mjs …`).
//
// A developer's shell may export the identity overrides. A test that needs one
// sets it on the process it spawns; none may inherit it. Without this,
// `PROJECTSTORE_HARNESS=codex npm test` failed some eighty tests on v0.29.0
// and hung the MCP suite — every message, state key and overlay followed the
// exported harness instead of the fixture's (generation spec, contract 18).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarnesses } from "../../scripts/harness.mjs";

for (const k of ["PROJECTSTORE_HARNESS", "PROJECTSTORE_IDENTIFIED", "PROJECTSTORE_SHELL"]) delete process.env[k];
// Every harness's home variable, named by its manifest (Claude Code's config
// directory, Codex's home): a developer's exported one would point a test's
// host reads, and every child it spawns, at the developer's own home. A test
// that needs a home passes it.
for (const m of loadHarnesses().values()) if (m.runtime?.home_env) delete process.env[m.runtime.home_env];
// Every harness's plugin-root variable (runtime.plugin_root_env): a host session
// that runs the suite exports its own, and the welcome reads which channel that
// copy came from. CI never sets it; a test that needs one passes it.
for (const m of loadHarnesses().values()) if (m.runtime?.plugin_root_env) delete process.env[m.runtime.plugin_root_env];
// Every harness's registration deferral marker (runtime.registration_defer_env):
// a host session that runs the suite carries its own, and every registration
// of that harness a test plans would defer. A test of the deferral sets it on
// the environment it passes.
for (const m of loadHarnesses().values())
  for (const k of m.runtime?.registration_defer_env || []) delete process.env[k];
// Every model catalog's key and base variable (agent_translation.models): a
// developer's exported ANTHROPIC_API_KEY would let a test that forgot its fake
// fetch send a real key, and a base URL would move where it goes (the ADR
// "Agent model lists are read from each harness's own catalog…"). A test of
// the read passes its own environment.
for (const m of loadHarnesses().values())
  for (const c of m.agent_translation?.models?.catalogs || [])
    for (const k of [c.key_env, c.base_env]) if (k) delete process.env[k];
// Every agent override a harness names (runtime.agent_overrides:
// CLAUDE_CODE_EFFORT_LEVEL, CLAUDE_CODE_SUBAGENT_MODEL): a developer's exported
// one adds a finding to every doctor run, and names the overlay a test wrote
// (the effort ADR, decision 7). A test of the finding passes its own.
for (const m of loadHarnesses().values())
  for (const o of m.runtime?.agent_overrides || []) if (o?.env) delete process.env[o.env];
// A shell's named root would stand in for every fetch, and the animation
// switch would change every live line a test reads (the shell-fetch story).
for (const k of ["PROJECTSTORE_DISTRIBUTION_ROOT", "PROJECTSTORE_NO_ANIMATION"]) delete process.env[k];
// The glyph switch would turn every glyph a test reads into its ASCII form
// (the presentation spec's glyph table; the story "The CLI's output is
// designed…").
delete process.env.PROJECTSTORE_ASCII;
// The user-level cache and npm's own: per test process, never the
// developer's. Offline with an empty cache, a fetch a test forgot to fake
// fails the same way every time (ENOTCACHED) instead of reaching a registry.
const scratch = mkdtempSync(join(tmpdir(), "ps-hermetic-"));
process.env.XDG_CACHE_HOME = join(scratch, "cache");
process.env.npm_config_cache = join(scratch, "npm-cache");
process.env.npm_config_offline = "true";
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 2 });
  } catch {}
});
// The registry read of install and upgrade (the converge story's rules 6 and
// 8) is off for every test and every child that inherits this environment; a
// test of the read passes its own environment without it, and its own fetch.
process.env.PROJECTSTORE_NO_UPDATE_CHECK = "1";
// …and a test that forgets to inject `fetch` never reaches the network: Node's
// fetch answers only the loopback here (the bin tests' 127.0.0.1 registry).
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- test-only: the global fetch is experimental but present at Node 20 and stable from 21, and the suite runs on Node 20 in CI
if (typeof globalThis.fetch === "function") {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- test-only: the global fetch is present at Node 20, stable from 21
  const loopback = globalThis.fetch;
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- test-only: the global fetch is present at Node 20, stable from 21
  globalThis.fetch = (input, init) => {
    let host = null;
    try {
      host = new URL(typeof input === "string" || input instanceof URL ? String(input) : input?.url).hostname;
    } catch {}
    if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) return loopback(input, init);
    return Promise.reject(new TypeError(`hermetic: the suite reaches no network (${host || "an unparseable URL"})`));
  };
}

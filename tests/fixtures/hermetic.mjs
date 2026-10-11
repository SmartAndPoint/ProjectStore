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
// Every harness's registration deferral marker (runtime.registration_defer_env):
// a host session that runs the suite carries its own, and every registration
// of that harness a test plans would defer. A test of the deferral sets it on
// the environment it passes.
for (const m of loadHarnesses().values())
  for (const k of m.runtime?.registration_defer_env || []) delete process.env[k];
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

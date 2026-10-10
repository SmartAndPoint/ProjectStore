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

for (const k of ["PROJECTSTORE_HARNESS", "PROJECTSTORE_IDENTIFIED", "PROJECTSTORE_SHELL"]) delete process.env[k];
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
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 2 }); } catch {} });

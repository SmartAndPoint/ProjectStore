// projectstore — tests/fixtures/hermetic.mjs: loaded before every test file
// (package.json: `node --test --import ./tests/fixtures/hermetic.mjs …`).
//
// A developer's shell may export the identity overrides. A test that needs one
// sets it on the process it spawns; none may inherit it. Without this,
// `PROJECTSTORE_HARNESS=codex npm test` failed some eighty tests on v0.29.0
// and hung the MCP suite — every message, state key and overlay followed the
// exported harness instead of the fixture's (generation spec, contract 18).
for (const k of ["PROJECTSTORE_HARNESS", "PROJECTSTORE_IDENTIFIED", "PROJECTSTORE_SHELL"]) delete process.env[k];

// projectstore — model-spec.mjs: a harness manifest's model and effort blocks,
// read as they are.
//
//   modelSpec(manifest)  → agent_translation.models, or null
//   effortSpec(manifest) → agent_translation.effort, or null
//
// Pure readers, split from models.mjs (which re-exports them) so a hook can
// read the manifest without loading the module that reads a live catalog.
// models.mjs starts a harness's catalog command as a subprocess, and reads
// no credential from the environment (the 0.30.7 story, PS-DIRECTORY);
// doctor, which the SessionStart hook imports, needs only effortSpec. The
// portability suite fences every hook's imports off any module with a fetch
// call, and holds models.mjs out of SessionStart's: the story "The MCP
// server's entry reaches no install verb…", PS-DIRECTORY, decision 4.
// This file imports nothing: keep it that way.

export function modelSpec(manifest) {
  const m = manifest?.agent_translation?.models;
  return m && typeof m === "object" ? m : null;
}

export function effortSpec(manifest) {
  const e = manifest?.agent_translation?.effort;
  return e && typeof e === "object" ? e : null;
}

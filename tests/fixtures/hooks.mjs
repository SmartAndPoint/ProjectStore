// projectstore — tests/fixtures/hooks.mjs: the tool-call hook driven with
// synthetic payloads, as the host sends them (the record spec's Testing:
// "driven with synthetic PreToolUse and PostToolUse payloads, each carrying
// a tool_use_id"). The environment is passed explicitly: the hermetic fixture
// clears every harness's session variables, so nothing here is the
// developer's live session.

import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHarness } from "../../scripts/harness.mjs";
import { hermeticEnv } from "./vocabulary.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOUCH = join(REPO, "scripts", "touch-session.mjs");
const SRC = sourceHarness();

// The environment a hook process of `proj` runs in, on the source harness
// unless `extra` names another.
export function hookEnv(proj, extra = {}) {
  return hermeticEnv({ [SRC.runtime.project_dir_env]: proj, [SRC.runtime.plugin_root_env]: REPO, ...extra });
}

export function payload(event, { sid, tool = "Edit", file, callId, agent = null, response = { success: true } }) {
  return {
    hook_event_name: event,
    session_id: sid,
    tool_name: tool,
    tool_input: { file_path: file },
    ...(callId ? { tool_use_id: callId } : {}),
    ...(agent ? { agent_id: `agent-${agent}`, agent_type: agent } : {}),
    ...(event === "PostToolUse" ? { tool_response: response } : {}),
  };
}

// One run of touch-session.mjs: {status, stdout}.
export function fireTouch(proj, body, { env = hookEnv(proj), cwd = proj } = {}) {
  const r = spawnSync(process.execPath, [TOUCH], {
    encoding: "utf8",
    input: JSON.stringify(body),
    timeout: 20000,
    env,
    cwd,
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

// The same, as a process that runs beside others (the concurrent cases).
export function fireTouchAsync(proj, body, { env = hookEnv(proj), cwd = proj } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TOUCH], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", (status) => done({ status, stdout: stdout.trim() }));
    child.stdin.end(JSON.stringify(body));
  });
}

// A write tool call as the host makes it: PreToolUse, the write, PostToolUse.
export function toolWrite(proj, { sid, file, callId, tool = "Edit", write, env, agent = null }) {
  const pre = fireTouch(proj, payload("PreToolUse", { sid, tool, file, callId, agent }), { env });
  write();
  const post = fireTouch(proj, payload("PostToolUse", { sid, tool, file, callId, agent }), { env });
  return { pre, post };
}

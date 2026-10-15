// projectstore — the band's command, its manifests and its packaging.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield, contracts 1 and 13.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/cli.mjs";
import { sourceHarness, loadHarness, hasBand, hostSessionId, layoutPaths } from "../scripts/harness.mjs";
import { renderHooks } from "../scripts/build-adapters.mjs";
import { heartbeatFile, heartbeatBody } from "../scripts/band-shared.mjs";
import { makeVaultProject } from "./fixtures/vault.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = sourceHarness();
const TEMP = [];
after(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});

function project() {
  const { proj, vault } = makeVaultProject();
  TEMP.push(proj);
  mkdirSync(join(vault, "epics", "PS-Y"), { recursive: true });
  return { proj, vault };
}

const SID = "band-test-session";
const envFor = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  [SRC.runtime.session_id_env]: SID,
  ...extra,
});

function sink() {
  let text = "";
  return {
    write: (s) => {
      text += s;
      return true;
    },
    isTTY: false,
    get text() {
      return text;
    },
  };
}

async function band(proj, args, { env = envFor(), ask = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["band", ...args, "--project", proj], {
    env,
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  let json = null;
  try {
    json = JSON.parse(stdout.text);
  } catch {}
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

  await band(proj, ["on", "--json"]);
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
  await band(proj, ["off"], {
    ask: async (q) => {
      asked.push(q);
      return "n";
    },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /switch the band off/);
  assert.equal(bindingOf(proj).band, undefined, "a no writes nothing");
  let r = await band(proj, ["off"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /passes --json/);
  r = await band(proj, ["off", "--json"], {
    ask: async () => {
      throw new Error("--json never asks");
    },
  });
  assert.equal(r.code, 0);
});

test("contract 13: status writes nothing and names one reason", async () => {
  const { proj, vault } = project();
  const path = layoutPaths(proj).binding;
  const status = async (env) => (await band(proj, ["status", "--json"], { env })).json.result;

  let s = await status(envFor());
  assert.equal(s.reason, "no_epic");
  assert.equal(s.session_id, SID);
  assert.match(s.session_hint, /a Read or an edit of a story file/, "the way to set it");

  const sessions = layoutPaths(proj).sessions;
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${SID}.json`), JSON.stringify({ active_epic: "PS-X" }));
  s = await status(envFor());
  assert.equal(s.session_epic, "PS-X");
  assert.equal(s.reason, "not_drawing");
  assert.equal(s.session_hint, null, "a session with its own epic needs no hint");
  assert.equal(s.session_story, null);
  assert.equal(s.session_root, null);
  // A story worked in a worktree of the vault (issue #87): status names it and
  // the copy it lives in.
  const copy = join(proj, "wt-copy");
  mkdirSync(copy, { recursive: true });
  writeFileSync(
    join(sessions, `${SID}.json`),
    JSON.stringify({ active_epic: "PS-X", active_story: "story-a", story_title: "Story A", story_root: copy }),
  );
  s = await status(envFor());
  assert.equal(s.session_story, "Story A");
  assert.equal(s.session_root, copy);
  assert.ok((await band(proj, ["status"], { env: envFor() })).out.includes(`epic PS-X · story Story A · in ${copy}`));
  rmSync(copy, { recursive: true });
  s = await status(envFor());
  assert.equal(s.session_root, null, "a removed worktree is not named");
  writeFileSync(join(sessions, `${SID}.json`), JSON.stringify({ active_epic: "PS-X" }));

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
  assert.match(
    s.session_hint,
    /a Read or an edit of a story file/,
    "pinned or not, an epic-less session hears how to set its own",
  );

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
  // The pre-band entries, changed since only by quoting their plugin root
  // (contract 1 as amended by the story "Every hook command quotes its plugin
  // root…", PS-DIRECTORY).
  assert.deepEqual(reg.hooks, classic, "the classic hook entries are byte-for-byte the pinned ones");
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
  const withBand = {
    ...loadHarness("codex"),
    surfaces: { ...loadHarness("codex").surfaces, band: { supported: true } },
  };
  assert.deepEqual(JSON.parse(renderHooks(withBand)[1]).modules, ["./band.tsx"], "a harness with a band keeps it");
});

// Codex keys hook trust to the rendered command text (`trusted_hash` under
// `[hooks.state]`, measured in *Codex hook contract measured in a live
// session*, PS-HARNESS), so how the source quotes its plugin root must never
// reach the Codex render. The host's two documentation pages quote it two ways;
// a source written in either, or bare, renders the committed tree byte for
// byte (the story "Every hook command quotes its plugin root…", PS-DIRECTORY,
// decision 2).
test("contract 1: the Codex hooks render byte-identically whether the source quotes its plugin root bare, whole-path or variable-only", () => {
  const source = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  const placeholder = SRC.hooks.root_placeholder;
  const committed = readFileSync(join(ROOT, "adapters", "codex", "hooks", "hooks.json"), "utf8");
  const forms = {
    bare: (p) => `node ${placeholder}/${p}`,
    "whole-path": (p) => `node "${placeholder}/${p}"`,
    "variable-only": (p) => `node "${placeholder}"/${p}`,
  };
  const differ = [];
  for (const [name, form] of Object.entries(forms)) {
    const root = mkdtempSync(join(tmpdir(), `ps-hooks-${name}-`));
    TEMP.push(root);
    mkdirSync(join(root, "hooks"));
    const hooks = structuredClone(source);
    let rewritten = 0;
    for (const groups of Object.values(hooks.hooks))
      for (const group of groups)
        for (const h of group.hooks || []) {
          const path = h.command.replaceAll('"', "").split(`${placeholder}/`)[1];
          h.command = form(path);
          rewritten++;
        }
    assert.ok(rewritten > 0, `${name}: the scratch source carries no command`);
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
    const [rel, text] = renderHooks(loadHarness("codex"), root);
    assert.equal(rel, join("hooks", "hooks.json"));
    if (text !== committed) differ.push(name);
  }
  assert.deepEqual(differ, [], "every quoting form renders the committed Codex hooks.json");
});

// The pin itself: the six command strings Codex users have trusted. A change
// here is a change every one of them is asked to approve again.
test("contract 1: the Codex hook commands are the six trusted strings, in the adapter and in the Codex shell", () => {
  const trusted = [
    'SessionStart node "${PLUGIN_ROOT}/node_modules/projectstore/hooks/session-start.mjs"',
    'SessionStart node "${PLUGIN_ROOT}/node_modules/projectstore/hooks/session-rules.mjs"',
    'PreToolUse node "${PLUGIN_ROOT}/node_modules/projectstore/scripts/touch-session.mjs"',
    'PostToolUse node "${PLUGIN_ROOT}/node_modules/projectstore/scripts/touch-session.mjs"',
    'Stop node "${PLUGIN_ROOT}/node_modules/projectstore/hooks/session-stop.mjs"',
    'PreCompact node "${PLUGIN_ROOT}/node_modules/projectstore/hooks/pre-compact.mjs"',
  ];
  for (const rel of [
    join("adapters", "codex", "hooks", "hooks.json"),
    join("packaging", "shells", "projectstore-codex", "hooks", "hooks.json"),
  ]) {
    const hooks = JSON.parse(readFileSync(join(ROOT, rel), "utf8")).hooks;
    const commands = Object.entries(hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => (g.hooks || []).map((h) => `${event} ${h.command}`)),
    );
    assert.deepEqual(commands, trusted, rel);
  }
});

test("contract 1: the module ships; the host-laid declarations and tsconfig do not", () => {
  const packlist = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "packlist.json"), "utf8"));
  const files = Array.isArray(packlist) ? packlist : packlist.files || packlist.paths || [];
  for (const f of [
    "hooks/band.tsx",
    "hooks/band-state.d.ts",
    "scripts/band-shared.mjs",
    "scripts/stages.mjs",
    "scripts/band.mjs",
    "commands/bar.md",
  ]) {
    assert.ok(files.includes(f), `${f} ships`);
  }
  assert.equal(
    files.some((f) => f.startsWith(".claude-plugin/types/") || f === "tsconfig.json"),
    false,
  );
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("!.claude-plugin/types/"));
  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
  assert.ok(ignore.includes(".claude-plugin/types/") && ignore.includes("/tsconfig.json"));
});

// ─── The story command's refresh (ADR-006, amended 2026-10-12) ─────────
// The close ceremony copies the story through Bash, which no hook sees; the
// story command then runs `session refresh`, so the session's band and status
// line stop naming a closed story.

async function session(proj, args, { env = envFor() } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(["session", ...args, "--project", proj], {
    env,
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  let json = null;
  try {
    json = JSON.parse(stdout.text);
  } catch {}
  return { code, out: stdout.text, err: stderr.text, json };
}

test("session refresh: this session's pointer takes the closed story's status from the file", async () => {
  const { proj, vault } = project();
  mkdirSync(join(vault, "epics", "PS-Y", "stories"), { recursive: true });
  const rel = "epics/PS-Y/stories/story-closed.md";
  writeFileSync(join(vault, rel), '---\ntype: story\ntitle: "Closed one"\nstatus: done\n---\n', "utf8");
  const pointer = join(layoutPaths(proj).sessions, `${SID}.json`);
  mkdirSync(dirname(pointer), { recursive: true });
  writeFileSync(
    pointer,
    JSON.stringify({
      active_epic: "PS-Y",
      active_story: "story-closed",
      story_title: "Closed one",
      story_status: "in-progress",
    }),
  );
  const r = await session(proj, ["refresh", rel, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.result.refreshed, true);
  assert.equal(JSON.parse(readFileSync(pointer, "utf8")).story_status, "done");
  // An absolute path inside the vault is the same file.
  assert.equal((await session(proj, ["refresh", join(vault, rel), "--json"])).code, 0);
});

test("session refresh: with no session from the host it writes nothing and exits 0", async () => {
  const { proj, vault } = project();
  mkdirSync(join(vault, "epics", "PS-Y", "stories"), { recursive: true });
  const rel = "epics/PS-Y/stories/story-closed.md";
  writeFileSync(join(vault, rel), "---\ntype: story\nstatus: done\n---\n", "utf8");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const r = await session(proj, ["refresh", rel, "--json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.result.refreshed, false);
  assert.equal(r.json.result.reason, "no-session");
  assert.throws(() => statSync(join(layoutPaths(proj).sessions, `${SID}.json`)), "no pointer appears");
});

test("session refresh: a path that is not a story, or not in the vault, is refused", async () => {
  const { proj, vault } = project();
  writeFileSync(join(vault, "epics", "PS-Y", "epic.md"), "---\ntype: epic\n---\n", "utf8");
  for (const [path, code] of [
    ["epics/PS-Y/epic.md", "NOT_A_STORY"],
    ["epics/PS-Y/stories/missing.md", "NOT_FOUND"],
    ["/etc/hosts", "NOT_IN_VAULT"],
  ]) {
    const r = await session(proj, ["refresh", path, "--json"]);
    assert.equal(r.code, 1, path);
    assert.equal(r.json.result.code, code, path);
  }
  assert.equal((await session(proj, ["refresh"])).code, 2, "a missing path is a usage error");
});

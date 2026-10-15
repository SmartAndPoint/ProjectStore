// projectstore — a vault file found through any worktree of the vault's
// repository (PS-PRESENCE: "A session working in a worktree of the vault gets
// its epic and story on the band: a vault file is found through any worktree
// of the vault's repository", issue #87).
//
// Every case runs on real `git worktree add` repositories in temp directories.
//
//   node --test tests/vault-location.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  vaultLocation,
  resetVaultLocation,
  pointerPatchFor,
  refreshStoryPointer,
  resolveOpenStory,
  resolveInFlightArtifact,
  isSourcePath,
  writeSessionState,
  readSessionState,
  entryScore,
  refreshSessionPointer,
  gatherVaultFacts,
  readAnchorState,
  sessionFilePath,
} from "../scripts/lib.mjs";
import { sourceHarness, loadHarnesses } from "../scripts/harness.mjs";
import { importSpecifiers } from "./fixtures/imports.mjs";
import { hermeticEnv } from "./fixtures/vocabulary.mjs";
import { writeBinding } from "./fixtures/vault.mjs";
import { git, gitVault, addWorktree, writeStory, seedVaultFiles } from "./fixtures/git-vault.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = sourceHarness();
const CODEX_LIKE = [...loadHarnesses().values()].find((m) => !m.runtime.project_dir_env);
const TEMP = [];
after(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
// Real paths throughout, unless a test is about the other spelling.
const base = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ps-vloc-")));
  TEMP.push(d);
  return d;
};
const STORY = join("epics", "PS-A", "stories", "story-a.md");
const fresh = () => resetVaultLocation();

// ─── The resolver ───────────────────────────────────────────────────────

test("a worktree inside the vault folder answers for its own copy; the bound checkout answers as today", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const inside = addWorktree(vault, join(vault, ".worktrees", "topic"), "topic");
  assert.deepEqual(vaultLocation(join(inside, STORY), vault), { root: inside, rel: STORY });
  assert.deepEqual(vaultLocation(join(vault, STORY), vault), { root: vault, rel: STORY });
  assert.equal(isSourcePath(join(inside, STORY), b, vault), false);
});

test("a worktree outside the vault folder is the vault too; a new file there is placed from its nearest parent", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const out = addWorktree(vault, join(b, "elsewhere", "vault-topic"), "topic");
  assert.deepEqual(vaultLocation(join(out, STORY), vault), { root: out, rel: STORY });
  const created = join(out, "epics", "PS-NEW", "stories", "story-new.md");
  assert.ok(!existsSync(dirname(created)));
  assert.deepEqual(vaultLocation(created, vault), {
    root: out,
    rel: join("epics", "PS-NEW", "stories", "story-new.md"),
  });
});

test("a relative path is taken against cwd", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const out = addWorktree(vault, join(b, "wt"), "topic");
  assert.deepEqual(vaultLocation(STORY, vault, { cwd: out }), { root: out, rel: STORY });
  assert.deepEqual(vaultLocation(STORY, vault, { cwd: vault }), { root: vault, rel: STORY });
});

test("a vault bound through a symlink: its worktrees are placed, and its real spelling is the bound checkout", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "real", "vault"));
  symlinkSync(join(b, "real"), join(b, "link"));
  const bound = join(b, "link", "vault");
  const out = addWorktree(vault, join(b, "wt"), "topic");
  assert.deepEqual(vaultLocation(join(out, STORY), bound), { root: out, rel: STORY });
  assert.deepEqual(vaultLocation(join(vault, STORY), bound), { root: bound, rel: STORY }, "the identity rule");
});

test("the macOS tmpdir spelling: a vault bound under the unresolved tmpdir still places its worktrees", () => {
  fresh();
  const raw = mkdtempSync(join(tmpdir(), "ps-vloc-raw-")); // not realpath'd on purpose
  TEMP.push(raw);
  const vault = gitVault(join(raw, "vault"));
  const out = addWorktree(vault, join(raw, "wt"), "topic");
  assert.deepEqual(vaultLocation(join(out, STORY), vault), { root: out, rel: STORY });
  const real = realpathSync(vault);
  if (real !== vault) assert.deepEqual(vaultLocation(join(real, STORY), vault), { root: vault, rel: STORY });
});

test("a vault that is itself a linked worktree: the repository's other checkouts are its copies", () => {
  fresh();
  const b = base();
  const main = gitVault(join(b, "main"));
  const vault = addWorktree(main, join(b, "vault-wt"), "vault");
  const other = addWorktree(main, join(b, "other"), "other");
  assert.deepEqual(vaultLocation(join(other, STORY), vault), { root: other, rel: STORY });
  assert.deepEqual(vaultLocation(join(main, STORY), vault), { root: main, rel: STORY });
});

test("a --separate-git-dir vault (a .git file, no commondir) places its worktrees", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"), { separateGitDir: join(b, "vault.git") });
  assert.ok(readFileSync(join(vault, ".git"), "utf8").startsWith("gitdir:"));
  const out = addWorktree(vault, join(b, "wt"), "topic");
  assert.deepEqual(vaultLocation(join(out, STORY), vault), { root: out, rel: STORY });
});

test("a relative gitdir: line (submodules, worktree.useRelativePaths) is resolved against the .git file", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const out = addWorktree(vault, join(b, "wt"), "topic");
  const abs = readFileSync(join(out, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)[1];
  writeFileSync(join(out, ".git"), `gitdir: ${relative(out, abs)}\n`);
  assert.deepEqual(vaultLocation(join(out, STORY), vault), { root: out, rel: STORY });
});

test("a nested foreign repository under the vault is still placed by the prefix; a foreign repository elsewhere is not", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const plugin = join(vault, ".obsidian", "plugins", "p");
  mkdirSync(plugin, { recursive: true });
  git(plugin, "init", "-q");
  writeFileSync(join(plugin, "main.js"), "x\n");
  assert.deepEqual(vaultLocation(join(plugin, "main.js"), vault), {
    root: vault,
    rel: join(".obsidian", "plugins", "p", "main.js"),
  });
  // A submodule-shaped checkout of another repository: its own common dir.
  const other = gitVault(join(b, "other"));
  const sub = join(b, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, ".git"), `gitdir: ${relative(sub, join(other, ".git"))}\n`);
  seedVaultFiles(sub);
  assert.equal(vaultLocation(join(sub, STORY), vault), null);
});

test("a vault kept inside the project's repository: a project worktree's copy of the vault is placed, its source is not", () => {
  fresh();
  const b = base();
  const proj = join(b, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "a.mjs"), "export {};\n");
  seedVaultFiles(join(proj, "vault"));
  git(proj, "init", "-q");
  git(proj, "add", "-A");
  git(proj, "commit", "-qm", "seed");
  const vault = join(proj, "vault");
  const pw = addWorktree(proj, join(b, "proj-wt"), "feature");
  assert.deepEqual(vaultLocation(join(pw, "vault", STORY), vault), { root: join(pw, "vault"), rel: STORY });
  assert.equal(vaultLocation(join(pw, "src", "a.mjs"), vault), null, "the project worktree's source is not the vault");
  assert.equal(isSourcePath(join(pw, "src", "a.mjs"), pw, vault), true);
  assert.equal(isSourcePath(join(pw, "vault", STORY), pw, vault), false);
});

test("a bound path with a trailing slash, and a file path with // or .., resolve to clean roots", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const out = addWorktree(vault, join(b, "wt"), "topic");
  assert.deepEqual(vaultLocation(join(vault, STORY), vault + "/"), { root: vault, rel: STORY });
  assert.deepEqual(vaultLocation(`${out}//${STORY}`, vault + "/"), { root: out, rel: STORY });
  assert.deepEqual(vaultLocation(join(vault, "epics", "..", "..", "wt", STORY), vault), { root: out, rel: STORY });
  assert.equal(pointerPatchFor(vault + "/", join(vault, STORY), null).story_root, null, "the bound vault is null");
});

test("a vault that is not a git repository, and a file in no repository, behave as the prefix always did", () => {
  fresh();
  const b = base();
  const vault = join(b, "plain");
  seedVaultFiles(vault);
  assert.deepEqual(vaultLocation(join(vault, STORY), vault), { root: vault, rel: STORY });
  assert.equal(vaultLocation(join(b, "elsewhere", STORY), vault), null);
  const gv = gitVault(join(b, "vault"));
  assert.equal(vaultLocation(join(b, "nowhere", "x.md"), gv), null);
  assert.equal(vaultLocation(null, gv), null);
});

test("a removed worktree is no longer placed", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const out = addWorktree(vault, join(b, "wt"), "topic");
  assert.ok(vaultLocation(join(out, STORY), vault));
  git(vault, "worktree", "remove", "--force", out);
  assert.equal(vaultLocation(join(out, STORY), vault), null);
});

test("the resolver spawns no process, and its module graph imports no child_process", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"), { separateGitDir: join(b, "vault.git") });
  const inside = addWorktree(vault, join(vault, ".worktrees", "x"), "x");
  const out = addWorktree(vault, join(b, "wt"), "y");
  const cp = createRequire(import.meta.url)("node:child_process");
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const saved = Object.fromEntries(names.map((n) => [n, cp[n]]));
  try {
    for (const n of names)
      cp[n] = () => {
        throw new Error(`the resolver spawned ${n}`);
      };
    syncBuiltinESMExports();
    fresh();
    assert.equal(vaultLocation(join(inside, STORY), vault).root, inside);
    assert.equal(vaultLocation(join(out, STORY), vault).root, out);
    assert.equal(vaultLocation(join(vault, STORY), vault).root, vault);
  } finally {
    Object.assign(cp, saved);
    syncBuiltinESMExports();
  }
  // lib.mjs and every module it imports, transitively, by text.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const s of importSpecifiers(readFileSync(file, "utf8"))) {
      assert.ok(!/^(node:)?child_process$/.test(s), `${relative(REPO, file)} imports ${s}`);
      if (s.startsWith("./") || s.startsWith("../")) walk(join(dirname(file), s));
    }
  };
  walk(join(REPO, "scripts", "lib.mjs"));
});

// ─── The pointer and its readers ───────────────────────────────────────

function worktreeWithOwnStory() {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const wt = addWorktree(vault, join(b, "wt"), "topic");
  writeFileSync(join(wt, "epics", "PS-A", "epic.md"), '---\ntype: epic\ntitle: "Epic A, in the worktree"\n---\n');
  writeStory(wt, { story: "story-wt", status: "in-progress", title: "Only in the worktree" });
  const proj = join(b, "proj");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  return { b, vault, wt, proj, story: join(wt, "epics", "PS-A", "stories", "story-wt.md") };
}

test("pointerPatchFor: a worktree story names its copy, and its epic's title comes from that copy", () => {
  const { vault, wt, story } = worktreeWithOwnStory();
  const p = pointerPatchFor(vault, story, null);
  assert.equal(p.active_epic, "PS-A");
  assert.equal(p.active_story, "story-wt");
  assert.equal(p.story_status, "in-progress");
  assert.equal(p.story_root, wt);
  assert.equal(p.epic_title, "Epic A, in the worktree");
  assert.equal(pointerPatchFor(vault, join(vault, STORY), null).story_root, null, "the bound checkout is null");
  // A touch of the same epic's other file (its epic.md, in the bound checkout)
  // leaves story_root — or the band would look for the story where it is not.
  const sameEpic = pointerPatchFor(vault, join(vault, "epics", "PS-A", "epic.md"), p);
  assert.ok(!("story_root" in sameEpic), JSON.stringify(sameEpic));
});

test("refreshStoryPointer: a worktree-only story survives the refresh; a removed worktree falls back; main's done wins", async () => {
  const { vault, wt, proj } = worktreeWithOwnStory();
  const sid = "s-refresh";
  writeSessionState(proj, sid, {
    active_epic: "PS-A",
    active_story: "story-wt",
    story_title: "Only in the worktree",
    story_status: "planned",
    story_root: wt,
  });
  assert.equal(await refreshStoryPointer(proj, vault, sid), "refreshed");
  let s = readSessionState(proj, sid);
  assert.equal(s.active_story, "story-wt", "kept: the story lives in the worktree");
  assert.equal(s.story_status, "in-progress");
  assert.equal(s.story_root, wt);

  // The same story merged and closed on main while the worktree is stale.
  writeStory(vault, { story: "story-wt", status: "done", title: "Only in the worktree" });
  assert.equal(await refreshStoryPointer(proj, vault, sid), "refreshed");
  s = readSessionState(proj, sid);
  assert.equal(s.story_status, "done", "main's done wins over a stale worktree copy");
  assert.equal(s.story_root, null);

  // A worktree-only story whose worktree is then removed.
  writeSessionState(proj, sid, { active_story: "story-gone", story_root: wt, story_status: "planned" });
  writeStory(wt, { story: "story-gone", status: "in-progress" });
  git(vault, "worktree", "remove", "--force", wt);
  assert.equal(await refreshStoryPointer(proj, vault, sid), "refreshed");
  s = readSessionState(proj, sid);
  assert.equal(s.active_story, null, "the bound checkout has no such story");
  assert.equal(s.story_root, null);
});

test("resolveOpenStory: a story open only in the session's worktree counts as open", async () => {
  const { vault, wt } = worktreeWithOwnStory();
  assert.equal(await resolveOpenStory(vault), false, "the bound checkout alone has none open");
  assert.equal(await resolveOpenStory(vault, { storyRoot: wt }), true);
  assert.equal(await resolveOpenStory(vault, { storyRoot: join(wt, "gone") }), false, "a missing root lists nothing");
});

test("resolveInFlightArtifact and session refresh read a worktree path by its place in the vault", () => {
  const { vault, wt, story, proj } = worktreeWithOwnStory();
  const layout = { folders: [{ path: "epics" }] };
  const tool = SRC.tools?.write_tools?.[0] || "Write";
  assert.equal(
    resolveInFlightArtifact([{ path: story, tool }], layout, vault),
    join("epics", "PS-A", "stories", "story-wt.md"),
  );
  const r = refreshSessionPointer(proj, { vault_path: vault }, story, {
    env: { [SRC.runtime.session_id_env || "NONE"]: "s-sr" },
  });
  assert.ok(!r.refusal, JSON.stringify(r));
  assert.equal(r.refreshed, true, JSON.stringify(r));
  assert.equal(r.pointer.story_root, wt);
});

// ─── The hook, end to end ──────────────────────────────────────────────

function fire(script, proj, payload, env) {
  const r = spawnSync(process.execPath, [join(REPO, ...script)], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: 20000,
    env,
    cwd: proj,
  });
  assert.equal(r.status, 0, `${script.join("/")} must exit 0; stderr: ${r.stderr}`);
  return r.stdout.trim();
}
const claudeEnv = (proj, sessions) =>
  hermeticEnv({
    [SRC.runtime.project_dir_env]: proj,
    [SRC.runtime.plugin_root_env]: REPO,
    PROJECTSTORE_SESSIONS_DIR: sessions,
  });

test("hook: an edit of a worktree story sets the epic, the story and its copy, and SessionStart's refresh keeps them", () => {
  const { b, wt, proj, story } = worktreeWithOwnStory();
  const sessions = join(b, "sessions");
  const env = claudeEnv(proj, sessions);
  fire(
    ["scripts", "touch-session.mjs"],
    proj,
    {
      hook_event_name: "PostToolUse",
      session_id: "s-e2e",
      tool_name: "Edit",
      tool_input: { file_path: story },
      tool_response: { success: true },
      cwd: proj,
    },
    env,
  );
  let s = readSessionState(proj, "s-e2e");
  assert.equal(s.active_epic, "PS-A");
  assert.equal(s.active_story, "story-wt");
  assert.equal(s.story_root, wt);

  fire(
    ["hooks", "session-start.mjs"],
    proj,
    { hook_event_name: "SessionStart", session_id: "s-e2e", source: "startup", cwd: proj },
    env,
  );
  s = readSessionState(proj, "s-e2e");
  assert.equal(s.active_story, "story-wt", "the refresh reads the story where it lives");
  assert.equal(s.story_root, wt);

  // A Read sets it too.
  fire(
    ["scripts", "touch-session.mjs"],
    proj,
    {
      hook_event_name: "PreToolUse",
      session_id: "s-read",
      tool_name: "Read",
      tool_input: { file_path: story },
      cwd: proj,
    },
    env,
  );
  assert.equal(readSessionState(proj, "s-read").story_root, wt);
});

test("hook: a worktree edit reaches recent_activity, the continuity gather, the session-name tally and the worktree nudge", async () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const inside = addWorktree(vault, join(vault, ".worktrees", "x"), "x");
  writeStory(inside, { story: "story-wt", status: "in-progress" });
  const story = join(inside, "epics", "PS-A", "stories", "story-wt.md");
  const proj = join(b, "proj");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const sessions = join(b, "sessions");
  const env = claudeEnv(proj, sessions);
  const call = { session_id: "s-all", tool_name: "Edit", tool_input: { file_path: story }, cwd: proj };
  fire(
    ["hooks", "session-start.mjs"],
    proj,
    { hook_event_name: "SessionStart", session_id: "s-all", source: "startup", cwd: proj },
    env,
  );
  fire(["scripts", "touch-session.mjs"], proj, { hook_event_name: "PreToolUse", ...call }, env);
  const said = fire(
    ["scripts", "touch-session.mjs"],
    proj,
    {
      hook_event_name: "PostToolUse",
      ...call,
      tool_response: { success: true },
    },
    env,
  );

  // The activity log keeps the absolute path; its readers see the vault path.
  process.env.PROJECTSTORE_SESSIONS_DIR = sessions;
  try {
    const activity = JSON.parse(readFileSync(sessionFilePath(vault, "s-all"), "utf8")).recent_activity;
    assert.equal(activity[0].path, story);
    const facts = await gatherVaultFacts(
      { vault_path: vault, layout: "engineering" },
      { sessionId: "s-all", source: "compact" },
    );
    assert.deepEqual(facts.continuity.paths, [join("epics", "PS-A", "stories", "story-wt.md")]);
  } finally {
    delete process.env.PROJECTSTORE_SESSIONS_DIR;
  }
  assert.equal(
    readAnchorState(proj, "s-all").counts["epic:PS-A"],
    1,
    "the tally keys the worktree story as the vault's",
  );
  assert.match(said, /edited in a worktree of the vault/);
  assert.match(said, /in the bound vault after the merge/);
});

test("hook: a relative apply_patch path on a harness with no project variable sets the pointer from the payload's cwd", () => {
  assert.ok(CODEX_LIKE, "a manifest with no project-dir variable");
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const proj = join(b, "proj");
  mkdirSync(proj, { recursive: true });
  const wt = addWorktree(vault, join(proj, ".vault-wt", "t"), "t");
  writeStory(wt, { story: "story-wt", status: "in-progress" });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const env = hermeticEnv({
    [CODEX_LIKE.runtime.plugin_root_env]: REPO,
    PROJECTSTORE_SESSIONS_DIR: join(b, "sessions"),
  });
  const rel = join(".vault-wt", "t", "epics", "PS-A", "stories", "story-wt.md");
  fire(
    ["scripts", "touch-session.mjs"],
    proj,
    {
      hook_event_name: "PostToolUse",
      session_id: "s-codex",
      tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${rel}\n@@\n+x\n*** End Patch` },
      tool_response: "Exit code: 0",
      cwd: proj,
    },
    env,
  );
  const s = readSessionState(proj, "s-codex");
  assert.equal(s?.active_story, "story-wt", JSON.stringify(s));
  assert.equal(s.story_root, wt);
});

test("hook: vault-worktree edits inside the project are not source, and a story open in the session's worktree silences the reminder", () => {
  fresh();
  const b = base();
  const vault = gitVault(join(b, "vault"));
  const proj = join(b, "proj");
  mkdirSync(join(proj, SRC.runtime.harness_dir), { recursive: true });
  const wt = addWorktree(vault, join(proj, ".vault-wt"), "t");
  writeStory(wt, { story: "story-wt", status: "in-progress" });
  writeBinding(proj, { vault_path: vault, layout: "engineering", language: "en" });
  const env = claudeEnv(proj, join(b, "sessions"));
  const write = (sid, file) =>
    fire(
      ["scripts", "touch-session.mjs"],
      proj,
      {
        hook_event_name: "PostToolUse",
        session_id: sid,
        tool_name: "Write",
        tool_input: { file_path: file },
        tool_response: { success: true },
        cwd: proj,
      },
      env,
    );
  for (const f of ["a.md", "b.md", "c.md"]) write("s-vault", join(wt, "epics", "PS-A", f));
  assert.equal(entryScore(proj, "s-vault"), 0, "a vault worktree's files are not source");

  // The session touches its worktree story first, then writes three source files.
  write("s-src", join(wt, "epics", "PS-A", "stories", "story-wt.md"));
  let said = "";
  for (const f of ["a.mjs", "b.mjs", "c.mjs"]) said += write("s-src", join(proj, f));
  assert.equal(entryScore(proj, "s-src"), 3);
  assert.ok(!said.includes("no story"), `the story open in its worktree counts: ${said}`);
});

// projectstore — test fixture: a scratch world for the dashboard's write path
// (the spec with alias `dashboard-writes`, "Testing").
//
//   hermeticGit()          → the test file's own HOME, XDG_CONFIG_HOME and
//                            GIT_CONFIG_GLOBAL, under the OS temp dir; every
//                            inherited GIT_* removed. Call it once, first.
//   makeWorld(options)     → { root, env, origin, repo, vault, prefix, project,
//                            main, ctx, record, git(cwd, ...args), gh, open(opts),
//                            start(opts), cloneInto(dir), cleanup() }
//
// `gh` is a stub gh (tests/fixtures/gh-stub.mjs) first on the world's PATH,
// with an empty table: no call of a world reaches the person's own gh.
//
// A world is a bare repository as `origin`, a vault repository cloned from it
// with an identity of its own (the vault at `prefix` inside it), and a code
// repository whose project is bound to that vault, all in one temporary
// folder. Its `env` points HOME, XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL inside
// that folder, so the person's own git configuration is never read or
// changed. `open()` opens the write module over it, with the world's `record`
// as the spawn record. The vault holds a story, its epic with a Stories row,
// and committed stubs of the derived views.
//
// Options: `prefix` ("" or a path such as "docs/vault"), `author` (the
// binding's default_author; "" for none), `worktree` (the project is a linked
// worktree of the code repository), `codeRepo` (false: the project is a plain
// folder), `identity` (false: the vault repository has no user.name or
// user.email of its own), `plainVault` (the vault is a plain folder, in no
// git repository), `ignoredVault` (with a `prefix`: the vault repository's
// .gitignore names the vault's folder, so no commit holds it).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplate, renderTemplate } from "../../scripts/lib.mjs";
import { openCore } from "../../dashboard/lib/core.mjs";
import { openWriter } from "../../dashboard/lib/write.mjs";
import { startServer } from "../../dashboard/server.mjs";
import { ghStub } from "./gh-stub.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SSH_STUB = join(dirname(fileURLToPath(import.meta.url)), "dashboard-ssh.mjs");
export const SSH_HANG = join(dirname(fileURLToPath(import.meta.url)), "dashboard-ssh-hang.sh");
// The budget of the cases that end a hung call: short, and wider under CI,
// where a loaded runner starts git and its ssh more slowly.
export const HANG_MS = process.env.CI ? 4000 : 1500;

const STORY = renderTemplate(loadTemplate("en", "story"), {
  id: "story-a",
  title: "A",
  date: "2026-11-01",
  author: "Other",
  tags: "[]",
  epic_id: "PS-X",
});
const EPIC = `---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\ncreated: 2026-11-01\n---\n\n# PS-X: X\n\n## Stories\n\n| Story | Status | Description |\n|-------|--------|-------------|\n| [a](./stories/story-a.md) | planned | the a |\n`;

const homeFor = (root) => {
  const home = join(root, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "");
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
};

// No GIT_* variable, and no EMAIL, which git would take as an identity.
const withoutGit = (env) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_") && k !== "EMAIL"));

export function hermeticGit() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-dash-home-")));
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_") || k === "EMAIL") delete process.env[k];
  Object.assign(process.env, homeFor(root));
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });
  return root;
}

export async function makeWorld({
  prefix = "",
  author = "Test Person",
  worktree = false,
  codeRepo = true,
  identity = true,
  plainVault = false,
  ignoredVault = false,
  // <vault>/.projectstore.json, when a case needs the vault's settings (its flow policy).
  vaultSettings = null,
  // More files of the vault, { "<vault-relative path>": "<text>" }, put before the seed commit.
  files = {},
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-dash-world-")));
  // A stub gh first on PATH, so no call reaches the person's own gh.
  const gh = ghStub(join(root, "gh"), {});
  const env = gh.env({ ...withoutGit(process.env), ...homeFor(root) });
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const as = ["-c", "user.name=World Fixture", "-c", "user.email=world-fixture"];

  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  const repo = join(root, "vault-repo");
  git(root, "clone", "-q", origin, repo);
  if (identity) {
    git(repo, "config", "user.name", "Vault Person");
    git(repo, "config", "user.email", "vault-person");
  }
  const vault = plainVault ? join(root, "plain-vault") : prefix ? join(repo, prefix) : repo;
  const put = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  put("epics/PS-X/stories/story-a.md", STORY);
  put("epics/PS-X/epic.md", EPIC);
  put("kanban.md", "stub board\n");
  put("graph.md", "stub graph\n");
  put("code-map.md", "stub code map\n");
  if (vaultSettings) put(".projectstore.json", `${JSON.stringify(vaultSettings, null, 2)}\n`);
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  for (const f of ["adr", "specs", "epics"]) put(`${f}/README.md`, `# ${f}\n`);
  if (ignoredVault) {
    writeFileSync(join(repo, ".gitignore"), `${prefix}/\n`);
    writeFileSync(join(repo, "README.md"), "# the vault's repository\n");
  }
  if (plainVault) writeFileSync(join(repo, "README.md"), "# not the vault\n");
  git(repo, "add", "-A");
  git(repo, ...as, "commit", "-q", "-m", "seed the vault");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-q", "-u", "origin", "main");

  const main = join(root, "code");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "README.md"), "# code\n");
  if (codeRepo) {
    git(main, "init", "-q");
    git(main, "add", "-A");
    git(main, ...as, "commit", "-q", "-m", "code");
  }
  let project = main;
  if (worktree) {
    project = join(root, "code-wt");
    git(main, "worktree", "add", "-q", "-b", "wt", project);
  }
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".projectstore"), { recursive: true });
  writeFileSync(
    join(project, ".projectstore", "projectstore.json"),
    JSON.stringify({ vault_path: vault, layout: "engineering", language: "en", default_author: author }),
  );

  const ctx = await openCore({ core: REPO, project });
  const record = [];
  const writers = [];
  const pages = [];
  const world = {
    root,
    env,
    origin,
    repo,
    vault,
    prefix,
    project,
    main,
    ctx,
    record,
    git,
    gh,
    as,
    async open(opts = {}) {
      const w = await openWriter({ ctx, env, record, ...opts });
      writers.push(w);
      return w;
    },
    // The page's server, in process, on port 0, with the world's record: its
    // promise settling stands for the ready line.
    async start(opts = {}) {
      const page = await startServer({ core: REPO, project, port: 0, env, record, ...opts });
      pages.push(page);
      return page;
    },
    // A plain clone of origin at `dir`, as the refresh will make one.
    cloneInto(dir) {
      mkdirSync(dirname(dir), { recursive: true });
      git(root, "clone", "-q", origin, dir);
      return dir;
    },
    async cleanup() {
      for (const p of pages) await p.close();
      for (const w of writers) await w.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

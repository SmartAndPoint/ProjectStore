// projectstore — test fixture: vaults that are real git repositories, and
// their worktrees (PS-PRESENCE: "A session working in a worktree of the vault
// gets its epic and story on the band…", issue #87). git runs with a clean
// environment — no inherited GIT_DIR, no developer gpgsign — so a fixture
// never touches the repository the tests run in.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GIT_CONFIG = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.email=fixture@example.com",
  "-c",
  "user.name=fixture",
  "-c",
  "init.defaultBranch=main",
];

export function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", [...GIT_CONFIG, ...args], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// One epic with one story, as the band and the pointer read them.
export function seedVaultFiles(dir, { epic = "PS-A", story = "story-a", status = "planned", title = "Epic A" } = {}) {
  mkdirSync(join(dir, "epics", epic, "stories"), { recursive: true });
  writeFileSync(
    join(dir, "epics", epic, "epic.md"),
    `---\ntype: epic\nid: "${epic}"\ntitle: "${title}"\n---\n\n# ${title}\n`,
  );
  writeStory(dir, { epic, story, status });
}

export function writeStory(dir, { epic = "PS-A", story = "story-a", status = "planned", title = "Story A" } = {}) {
  mkdirSync(join(dir, "epics", epic, "stories"), { recursive: true });
  writeFileSync(
    join(dir, "epics", epic, "stories", `${story}.md`),
    `---\ntype: story\ntitle: "${title}"\nstatus: ${status}\n---\n\n# ${title}\n`,
  );
}

// A vault that is its own repository (optionally with its git directory kept
// elsewhere, as `git init --separate-git-dir` does), seeded and committed.
export function gitVault(dir, { separateGitDir = null, seed = true } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ...(separateGitDir ? ["--separate-git-dir", separateGitDir] : []));
  if (seed) seedVaultFiles(dir);
  writeFileSync(join(dir, "README.md"), "# vault\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return dir;
}

export function addWorktree(repo, path, branch) {
  git(repo, "worktree", "add", "-q", "-b", branch, path);
  return path;
}

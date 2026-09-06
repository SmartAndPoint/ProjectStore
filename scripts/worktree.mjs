#!/usr/bin/env node
// projectstore — worktree.mjs
// Answers one question: is this project an unbound git worktree of a checkout
// that IS bound, and therefore able to adopt its binding?
//
// `.gitignore` ignores `.claude/`, so a worktree created from a bound checkout
// starts with no projectstore.json: the hooks run, find nothing, and every
// /projectstore:* command is dead there. That is ADR decision 12 — the cheap,
// independent half of the parallel-session problem.
//
// Compute-only: spawns git, reads config files, writes nothing. The write path
// is /projectstore:bind --inherit, approval-gated like every other write.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, readConfigAt, truncFront, PATH_CELL } from "./lib.mjs";
import { gitIn } from "./diff-refs.mjs";

// SessionStart is user-facing and budgets its gather in hundreds of
// milliseconds; diff-refs' 15 s batch default would be fifteen seconds of a
// hung session start.
const GIT_TIMEOUT_MS = 2000;

const git = (cwd, args) => gitIn(cwd, args, { timeout: GIT_TIMEOUT_MS });

const trim = (s) => (typeof s === "string" ? s.trim() : null);

// Every branch returns every field. A caller reading a field that only exists on
// the happy path throws, and a hook swallows that into silence — which looks
// exactly like the mechanism deciding it had nothing to say.
function record(state, worktree, mainCheckout, vaultPath) {
  return { state, worktree, mainCheckout, vaultPath };
}

// The main checkout behind a linked worktree.
//
// `dirname(<git-common-dir>)` is right for an ordinary repository and WRONG for
// one created with --separate-git-dir, where the common dir sits outside any
// checkout — the vault on this machine has exactly that shape, and there both
// this and `git worktree list` name the git directory rather than a checkout.
//
// So the candidate is never trusted. Note what confirmation has to mean:
// `--show-toplevel` answering only proves the candidate sits inside *a* working
// tree, which is not the same as being the main checkout of *this* repository —
// and when a separate git dir happens to live inside an unrelated repository,
// that weaker check names the stranger and we would offer its vault. Identity is
// therefore confirmed by asking the candidate for its own common dir and
// requiring it to be the one we started from. Not knowing yields null, and null
// must never produce an offer.
function mainCheckoutOf(commonDir) {
  const candidate = dirname(commonDir);
  const top = trim(git(candidate, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  if (!top) return null;
  const topCommon = trim(git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return topCommon === commonDir ? top : null;
}

export function resolveBinding(projectDir = projectRoot()) {
  // A bound project has nothing to ask, so it never pays for a git spawn. The
  // `worktree` field therefore means "detected as a linked worktree", and
  // detection only runs when unbound — `false` here is "not asked", not "no".
  if (readConfigAt(projectDir)) return record("bound", false, null, null);

  const gitDir = trim(git(projectDir, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  const commonDir = trim(git(projectDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  // Git missing (ENOENT → status null) and a non-repository (exit 128) both land
  // here, and both are ordinary unbound projects with the ordinary advice.
  if (!gitDir || !commonDir) return record("unbound", false, null, null);

  // --path-format=absolute matters: in a main checkout the common dir comes back
  // as the relative `.git`, and dirname() of that is `.`.
  if (gitDir === commonDir) return record("unbound", false, null, null);

  const main = mainCheckoutOf(commonDir);
  if (!main) return record("unbound", true, null, null);

  const parent = readConfigAt(main);
  if (!parent || !parent.vault_path) return record("unbound", true, main, null);

  return record("inheritable", true, main, parent.vault_path);
}

// Pure: record in, block out. Both interpolated paths are user-controlled and
// unbounded, so both go through the same cell truncation the sibling warning
// uses — the composed SessionStart value is capped and this is one of its terms.
export function bindingOfferText(b) {
  return [
    "# projectstore — this worktree is not bound",
    "",
    "This checkout has no `.projectstore/projectstore.json`, so `/projectstore:*` commands",
    "cannot run here. The checkout it was forked from is bound:",
    "",
    `- main checkout: \`${truncFront(String(b.mainCheckout), PATH_CELL)}\``,
    `- its vault: \`${truncFront(String(b.vaultPath), PATH_CELL)}\``,
    "",
    "Run `/projectstore:bind --inherit` to adopt that binding. It copies the binding",
    "only — the vault is shared and unchanged, and no session state travels with it.",
    "",
    "",
  ].join("\n");
}

function main() {
  process.stdout.write(JSON.stringify(resolveBinding(projectRoot()), null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// projectstore — test fixtures: a spec tree whose specs own code, in a
// project that is its own git repository.
//
// The spec tree fixture (tests/fixtures/spec-tree.mjs) with `code_refs` on
// its specs and a few source files committed: the root `app` owns `src/`,
// `api` owns `src/api/`, `web` owns `src/web/`, the leaf `api-queue` owns
// `src/api/queue.mjs`. The vault sits inside the project and is committed
// too, so a test sees that ownership leaves it out.

import { git, gitCommit } from "./flow.mjs";
import { seedSpecTreeFixture, SPECS } from "./spec-tree.mjs";

export const REFS = {
  app: ["src/"],
  api: ["src/api/"],
  web: ["src/web/"],
  "api-queue": ["src/api/queue.mjs"],
};

export const SOURCES = {
  "src/cli.mjs": "export const cli = 1;\n",
  "src/api/queue.mjs": "export const queue = 1;\n",
  "src/api/http.mjs": "export const http = 1;\n",
  "src/web/cart.mjs": "export const cart = 1;\n",
  "README.md": "# Shop\n",
};

// `refs` maps a spec id to its code_refs; `sources` the files committed.
export function seedSpecCodeFixture({ refs = REFS, sources = SOURCES, specs = SPECS, commit = true } = {}) {
  const withRefs = specs.map((s) => (refs[s.id] ? { ...s, extra: `code_refs: ${JSON.stringify(refs[s.id])}` } : s));
  const fx = seedSpecTreeFixture({ specs: withRefs });
  if (commit) {
    git(fx.proj, ["init", "-q"]);
    gitCommit(fx.proj, { files: sources, message: "sources" });
    git(fx.proj, ["add", "--", "vault"]);
    gitCommit(fx.proj, { message: "vault" });
  }
  return fx;
}

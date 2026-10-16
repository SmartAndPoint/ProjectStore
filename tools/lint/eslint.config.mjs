// ESLint, flat config (the ADR "Lint and format: ESLint and Prettier as pinned
// dev dependencies; the published package stays dependency-free"): the two
// recommended sets and five exceptions, each for an idiom this code uses on
// purpose. The npm scripts name what is linted; `ignores` keeps a bare
// `eslint .` out of what is not ours.
//
// It lives in tools/lint/, beside the tools' own package.json and lockfile, so
// the plugin root holds no lockfile for Claude Code to install from (the
// PS-DIRECTORY story "Dev dependencies stay out of every user's plugin copy").
// The root's eslint.config.mjs re-exports it: ESLint takes the base path from
// the config file it finds, so `ignores` and the linted set stay relative to
// the repository root, and the imports below resolve from
// tools/lint/node_modules.
//
// The Node range is `engines`: eslint-plugin-n reads `engines.node` from the
// package.json nearest each file, the root's or a shell's (rendered from the
// root's by packaging/shells.mjs), so the floor check moves with `engines`.
import js from "@eslint/js";
import n from "eslint-plugin-n";

export default [
  {
    // .claude/ holds worktrees, whole copies of this repository; .projectstore/
    // is this checkout's untracked binding; dist/ is build output; site/ is
    // generated, and its site.js is browser code; tools/lint/node_modules/ is
    // the toolchain itself.
    ignores: [".claude/", ".projectstore/", "dist/", "site/", "**/node_modules/"],
  },
  js.configs.recommended,
  n.configs["flat/recommended-module"],
  {
    linterOptions: {
      // A disable that suppresses nothing fails the lint: once the floor moves
      // past an API, its Node-floor disable has to go.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Best-effort I/O must never throw: an empty catch is how it says so.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The terminal code matches ANSI escapes.
      "no-control-regex": "off",
      // A name a signature or a destructuring needs but the code does not use
      // is spelled _x.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The bin and the hooks are processes that end with an exit code.
      "n/no-process-exit": "off",
      // The #!/usr/bin/env node lines are harmless: nothing executes these files
      // directly (the hooks run as `node <path>`, the status-line launcher as
      // `node "<path>"`), insertStamp handles a file with or without one, and
      // tests/packaging.test.mjs pins the bin's own.
      "n/hashbang": "off",
    },
  },
];

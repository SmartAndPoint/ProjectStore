// `npm run lint` (and the format scripts) before `npm run lint:setup` would die on
// Node's raw "Cannot find module …/tools/lint/node_modules/…", which names no way
// out. This runs first (the pre-scripts in the root package.json) and names it.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const missing = ["eslint/bin/eslint.js", "prettier/bin/prettier.cjs"].filter(
  (bin) => !existsSync(join(here, "node_modules", bin)),
);
if (missing.length) {
  console.error(
    "The lint tools are not installed in this checkout. Run this once, then try again:\n\n  npm run lint:setup\n",
  );
  process.exit(1);
}

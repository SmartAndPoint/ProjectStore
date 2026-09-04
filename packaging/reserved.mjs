#!/usr/bin/env node
// projectstore — reserved.mjs (PS-HARNESS: "Claim the npm name and ship the
// first release")
//
//   node packaging/reserved.mjs --write     materialize the stub packages
//   node packaging/reserved.mjs             list them and what they are for
//
// The accepted ADR "One package, N manifests" settles the DISTRIBUTION shape —
// one package, `projectstore`, carrying every harness's manifest — and says in
// as many words that whether to *reserve* other names defensively is a
// separate question it does not settle. This file is that separate answer:
// the names are claimed so nobody else takes them, and every one of them says
// out loud that it is not the package you want.
//
// These are not empty placeholders. npm's dispute policy treats content-free
// name-holding as squatting, and a package that resolves to nothing is a
// worse experience than a 404. Each stub carries a real README explaining
// where the product is, and is deprecated on publish so `npm install` prints
// the pointer.
//
// Nothing here ships inside `projectstore`: the root package.json uses a
// `files` allowlist, `packaging/` is not on it, and tests/packaging.test.mjs
// asserts that it never becomes so.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = "projectstore";

const SHARED = {
  version: "0.0.1",
  license: "MIT",
  author: {
    name: "Evgenii Konev",
    email: "ekonev@smartandpoint.com",
    url: "https://github.com/SmartAndPoint",
  },
  homepage: "https://github.com/SmartAndPoint/ProjectStore#readme",
  bugs: { url: "https://github.com/SmartAndPoint/ProjectStore/issues" },
  repository: {
    type: "git",
    url: "git+https://github.com/SmartAndPoint/ProjectStore.git",
  },
  keywords: ["projectstore", "placeholder", "reserved"],
  files: ["README.md"],
  publishConfig: { access: "public" },
};

// `why` is published prose, not a code comment — it lands in the README a
// human reads on npmjs.com, so it says what the name is for rather than what
// we decided internally.
export const RESERVED = [
  {
    name: "opencode-projectstore",
    why: "opencode discovers plugins by the `opencode-` name prefix. This name is reserved for the thin re-export that will make projectstore installable in opencode; until then, the plugin lives in `projectstore`.",
    fate: "becomes a real re-export of `projectstore`",
  },
  {
    name: "projectstore-claude",
    why: "Claude Code installs projectstore from its plugin marketplace, and the npm package is the same one every other harness uses. This name is reserved so it cannot be taken and made to look official.",
    fate: "defensive only — no such package is planned",
  },
  {
    name: "projectstore-codex",
    why: "Codex installs the very same `projectstore` package through a marketplace entry. This name is reserved so it cannot be taken and made to look official.",
    fate: "defensive only — no such package is planned",
  },
  {
    name: "projectstore-opencode",
    why: "opencode discovers plugins by a `opencode-` prefix, not by a `-opencode` suffix, so this name would never be found by the mechanism it appears to name. Reserved so it cannot mislead.",
    fate: "defensive only — the working name is `opencode-projectstore`",
  },
  {
    name: "projectstore-gemini",
    why: "Gemini CLI was retired on 2026-06-18 in favour of Antigravity CLI, so there is no Gemini target to build for. Reserved so the name cannot be taken and made to look official.",
    fate: "defensive only — the harness it names no longer exists",
  },
  {
    name: "projectstore-antigravity",
    why: "Antigravity CLI is Google's terminal agent, and the successor to the retired Gemini CLI. Its plugin format has not been researched yet, so nothing is built against it — the name is held so it is available when something is.",
    fate: "held for work that is planned but not started",
  },
  {
    name: "projectstore-deepseek",
    why: "DeepSeek Harness entered developer preview in August 2026 with an architecture in which every layer is a replaceable plugin. That makes it a plausible integration target; the name is held until there is something real to put behind it.",
    fate: "held for work that is likely, not yet scheduled",
  },
  {
    name: "projectstore-qwen",
    why: "Qwen Code is a terminal agent harness you host yourself. Reserved so the name cannot be taken and made to look official.",
    fate: "defensive only — no such package is planned",
  },
  {
    name: "projectstore-hermes",
    why: "Hermes Agent is another terminal agent harness in the 2026 field. Reserved so the name cannot be taken and made to look official.",
    fate: "defensive only — no such package is planned",
  },
  {
    name: "projectstore-mcp",
    why: "ProjectStore's MCP read surface ships inside `projectstore` itself rather than as a separate package. This name is held so nothing else can present itself as it.",
    fate: "defensive only — the MCP surface ships inside the one package",
  },
  {
    name: "projectstore-speckit",
    why: "GitHub's Spec Kit is a spec-driven development toolkit. No integration between it and ProjectStore is designed — the name is held so it is available if one is ever built.",
    fate: "held — no integration designed yet",
  },
  {
    name: "projectstore-sdd",
    why: "Spec-driven development is a practice, not a product, and ProjectStore already ships specs as a first-class artifact kind. Reserved so the name cannot be taken and made to look official.",
    fate: "held — no integration designed yet",
  },
  {
    name: "projectstore-github",
    why: "Anything ProjectStore does with GitHub — issue references, CI checks — ships inside `projectstore` itself. Reserved so the name cannot be taken and made to look official.",
    fate: "held — no integration designed yet",
  },
];

const manifest = (r) => ({
  name: r.name,
  description: `Reserved name. The package you want is \`${REAL}\`.`,
  ...SHARED,
});

const readme = (r) => `# ${r.name}

**This is a reserved name, not a product.** Install [\`${REAL}\`](https://www.npmjs.com/package/${REAL}) instead:

\`\`\`sh
npm install ${REAL}
\`\`\`

${r.why}

ProjectStore ships as **one package carrying every harness's manifest** —
Claude Code, Codex, opencode and an MCP server all install the same tree. That
decision is recorded in the project's architecture decision records.

- Source: https://github.com/SmartAndPoint/ProjectStore
- Issues: https://github.com/SmartAndPoint/ProjectStore/issues
- Author: Evgenii Konev (SmartAndPoint)

MIT licensed.
`;

function write() {
  for (const r of RESERVED) {
    const dir = resolve(HERE, "reserved", r.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify(manifest(r), null, 2) + "\n");
    writeFileSync(resolve(dir, "README.md"), readme(r));
  }
  process.stdout.write(
    JSON.stringify({ ok: true, wrote: RESERVED.length, names: RESERVED.map((r) => r.name) }) + "\n",
  );
}

function list() {
  for (const r of RESERVED) process.stdout.write(`${r.name.padEnd(24)} ${r.fate}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.argv.includes("--write") ? write() : list();
}

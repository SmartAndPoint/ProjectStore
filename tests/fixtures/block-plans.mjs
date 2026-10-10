// projectstore — test fixture: the agents-block items of every single-harness
// plan, as a table (PS-HARNESS: "One run plans the agents block once, and a
// bare uninstall selects every harness the project uses", the "One harness"
// criterion).
//
// The table is every manifest × install/uninstall × with and without
// `--surface agents_block` × nine file states, each planned for that harness
// alone in a temp project and home. Only the block's own items are kept
// (`agents_block`, `agents_block_import`): the other surfaces depend on the
// home and the root, and are not what the story changes.
//
// Paths are placeholders (`<project>`, `<home>`, `<root>`), and so are the
// block bodies (`<block>`, `<stale-block>`): the snapshot pins what the plan
// does with the files, not the template's prose, which another story bumps.
//
// The committed snapshot, tests/fixtures/block-plans-single-harness.json, was
// taken at the branch point (375ddbd), never from the code under test: that
// tree exported to a scratch directory, this file copied into its
// tests/fixtures/, and run there with
//   node tests/fixtures/block-plans.mjs --write
// Regenerating it is a decision, not a refresh: it re-baselines what "a
// single-harness plan is unchanged" compares against.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses } from "../../scripts/harness.mjs";
import { plan } from "../../scripts/install-harness.mjs";
import { renderAgentsBlock, agentsBlockVersion, agentsBlockTemplatePath, loadLayout } from "../../scripts/lib.mjs";
import { fakeInstall, noHostEnv } from "./install.mjs";
import { writeBinding } from "./vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT = join(HERE, "block-plans-single-harness.json");

// The block a bound `engineering` project renders, and the same block one
// version below the template's.
export function blockTexts(root) {
  const tmpl = readFileSync(agentsBlockTemplatePath(root), "utf8");
  const v = agentsBlockVersion(tmpl);
  const block = renderAgentsBlock(tmpl, loadLayout("engineering", root).agents || null);
  const stale = block.replace(`projectstore:agents v${v} `, `projectstore:agents v${v - 1} `);
  return { block, stale, version: v };
}

// The nine file states: what CLAUDE.md and AGENTS.md hold before the plan
// (null: absent).
export const STATES = Object.freeze({
  "empty": () => ({}),
  "prose in CLAUDE.md": () => ({ "CLAUDE.md": "# Mine\n" }),
  "prose in AGENTS.md": () => ({ "AGENTS.md": "# Agents\n" }),
  "block in CLAUDE.md": ({ block }) => ({ "CLAUDE.md": "# Mine\n\n" + block + "\n" }),
  "block in AGENTS.md + import": ({ block }) => ({ "AGENTS.md": block + "\n", "CLAUDE.md": "@AGENTS.md\n\n# Mine\n" }),
  "block in AGENTS.md + CLAUDE.md holding only the import": ({ block }) => ({ "AGENTS.md": block + "\n", "CLAUDE.md": "@AGENTS.md\n" }),
  "block in both": ({ block }) => ({ "CLAUDE.md": "# Mine\n\n" + block + "\n", "AGENTS.md": "# Agents\n\n" + block + "\n" }),
  "stale block": ({ stale }) => ({ "AGENTS.md": stale + "\n" }),
  "unclosed block": () => ({ "CLAUDE.md": "<!-- projectstore:agents v3 -->\n## half\n" }),
});

const MODES = ["install", "uninstall"];
const NARROW = [null, ["agents_block"]];

// A bound project holding `files`, and no harness directory: the harness is
// named, so detection decides nothing here.
function stateProject(files) {
  const proj = mkdtempSync(join(tmpdir(), "ps-block-plans-"));
  writeBinding(proj, JSON.stringify({ vault_path: "/tmp/nowhere", layout: "engineering" }));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(proj, f), text);
  return proj;
}

// Every string in `v` with each [from, to] pair replaced, longest first.
function scrub(v, pairs) {
  if (typeof v === "string") return pairs.reduce((s, [from, to]) => (from ? s.split(from).join(to) : s), v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, pairs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, pairs)]));
  return v;
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

export const caseKey = (id, mode, surfaces, state) => `${id} | ${mode} | ${surfaces ? surfaces.join(",") : "-"} | ${state}`;

// The table, keyed by caseKey: each case's block items, scrubbed. `planFn` is
// the plan() under test (the default: the installer's own).
export function blockPlanTable({ planFn = plan } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ps-block-plans-home-"));
  mkdirSync(home, { recursive: true });
  const root = fakeInstall(home, "0.28.0");
  const texts = blockTexts(root);
  const env = noHostEnv();
  const out = {};
  for (const m of loadHarnesses().values()) {
    for (const mode of MODES) {
      for (const surfaces of NARROW) {
        for (const [state, files] of Object.entries(STATES)) {
          const proj = resolve(stateProject(files(texts)));
          const p = planFn(proj, { harnesses: [m.id], mode, surfaces, home, root, env });
          const items = JSON.parse(JSON.stringify(p.items.filter((i) => i.surface === "agents_block" || i.surface === "agents_block_import")));
          out[caseKey(m.id, mode, surfaces, state)] = scrub(items, [
            [texts.block, "<block>"], [texts.stale, "<stale-block>"],
            [real(root), "<root>"], [root, "<root>"],
            [real(proj), "<project>"], [proj, "<project>"],
            [real(home), "<home>"], [home, "<home>"],
          ]);
        }
      }
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  writeFileSync(SNAPSHOT, JSON.stringify(blockPlanTable(), null, 2) + "\n");
  process.stdout.write(`wrote ${SNAPSHOT}\n`);
}

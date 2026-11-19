// projectstore — test fixtures: a vault with a spec tree.
//
// seedSpecTreeFixture() writes the spec tree spec's fixture: a root `app`,
// components `api` and `web`, leaves `api-queue`, `api-auth` and `web-cart`,
// a cycle `loop-a` ⇄ `loop-b` with `below-loop` under it, a lone spec, and a
// story covered by `api-queue`. specText's `adr`, `refs`, `prose` and
// `marker` change nothing at their defaults. With `parents: false` every `parent:` is
// left out, which is the vault the goldens in tests/fixtures/spec-tree-golden/
// were recorded from, with the code before the PS-SPECTREE story "A spec
// names its parent" (3d7337a). Later stories test that this vault still gives
// those bytes.
//
//   node tests/fixtures/spec-tree.mjs --write   records the goldens again

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeVaultProject } from "./vault.mjs";

export const FIXED_NOW = "2026-11-19T12:00:00.000Z";
const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "spec-tree-golden");

export const SPECS = [
  { id: "app", title: "Shop app", parent: null },
  { id: "api", title: "API service", parent: "app" },
  { id: "web", title: "Web front end", parent: "app" },
  { id: "api-queue", title: "API job queue", parent: "api", stories: ["PS-X/story-t"] },
  { id: "api-auth", title: "API sign-in", parent: "api" },
  { id: "web-cart", title: "Web cart", parent: "web" },
  { id: "loop-a", title: "Loop A", parent: "loop-b" },
  { id: "loop-b", title: "Loop B", parent: "loop-a" },
  { id: "below-loop", title: "Below the loop", parent: "loop-a" },
  { id: "lone", title: "A lone spec", parent: null },
];

export function specText({
  id,
  title,
  parent = null,
  status = "active",
  date = "2026-11-01",
  stories = [],
  adr = [],
  refs = null,
  prose = "Fixture.",
  marker = null,
  extra = "",
}) {
  const lines = [
    "---",
    "type: spec",
    `id: "${id}"`,
    `title: "${title}"`,
    `status: ${status}`,
    `date: ${date}`,
    `adr: ${JSON.stringify(adr)}`,
    `stories: ${JSON.stringify(stories)}`,
  ];
  if (parent !== undefined && parent !== null) lines.push(`parent: ${parent.startsWith("[") ? parent : `"${parent}"`}`);
  if (refs) lines.push(`code_refs: ${JSON.stringify(refs)}`);
  if (extra) lines.push(extra);
  lines.push("---", "", `# ${title}`, "", "## How we solve", "", prose, "", "## Behavioral contracts", "");
  lines.push("1. **One.** A thing happens.", "");
  // A marker under contract 1, as `amended YYYY-MM-DD by <story>: <KIND> — <why>`.
  if (marker) lines.push(`> ${marker}`, "");
  lines.push("## Acceptance", "", "- [ ] It happens", "");
  return lines.join("\n");
}

export function seedSpecTreeFixture({ parents = true, specs = SPECS } = {}) {
  const { proj, vault } = makeVaultProject();
  const put = (rel, content) => {
    mkdirSync(join(vault, dirname(rel)), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  for (const s of specs) put(join("specs", `${s.id}.md`), specText({ ...s, parent: parents ? s.parent : null }));
  put(
    join("epics", "PS-X", "epic.md"),
    '---\ntype: epic\nid: "PS-X"\ntitle: "X"\nstatus: in-progress\n---\n\n# PS-X\n\n## Stories\n\n| Story | Status | Description |\n|---|---|---|\n| [T](./stories/story-t.md) | in-progress | t |\n',
  );
  put(
    join("epics", "PS-X", "stories", "story-t.md"),
    '---\ntype: story\nid: "story-t"\nepic: "PS-X"\ntitle: "T"\nstatus: in-progress\npriority: p2\nspecs: ["api-queue"]\ncode_refs: []\n---\n\n# T\n',
  );
  const cfg = { vault_path: vault, layout: "engineering", language: "en" };
  return { proj, vault, cfg };
}

// What the goldens hold, for the vault `seedSpecTreeFixture({ parents: false })`.
export async function goldenFacts({ proj, vault, cfg }) {
  const { buildGraph } = await import("../../scripts/graph.mjs");
  const { runVaultChecks } = await import("../../scripts/doctor.mjs");
  const { loadLayout, gatherVaultFacts, renderVaultSkeleton } = await import("../../scripts/lib.mjs");
  const base = proj.split("/").pop();
  const mask = (s) => String(s).split(vault).join("<vault>").split(proj).join("<proj>").split(base).join("<proj>");
  const graph = buildGraph(cfg, loadLayout(cfg.layout)).content.replace(/^generated_at: .*$/m, "generated_at: <t>");
  const doctor = runVaultChecks(cfg, {
    proj,
    now: FIXED_NOW,
    commits: () => ({ status: "ok", commits: [] }),
    grep: () => ({ status: "ok", lines: [] }),
  })
    .filter((f) => !["kanban", "code-map", "graph", "index"].includes(f.check))
    .map((f) => ({ level: f.level, check: f.check, message: mask(f.message), file: f.file ? mask(f.file) : null }));
  const skeleton = mask(renderVaultSkeleton(await gatherVaultFacts(cfg)));
  return { graph, doctor, skeleton };
}

export function readGolden() {
  const at = (n) => readFileSync(join(GOLDEN, n), "utf8");
  return { graph: at("graph.md"), doctor: JSON.parse(at("doctor.json")), skeleton: at("skeleton.txt") };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes("--write")
) {
  const facts = await goldenFacts(seedSpecTreeFixture({ parents: false }));
  mkdirSync(GOLDEN, { recursive: true });
  writeFileSync(join(GOLDEN, "graph.md"), facts.graph);
  writeFileSync(join(GOLDEN, "doctor.json"), JSON.stringify(facts.doctor, null, 2) + "\n");
  writeFileSync(join(GOLDEN, "skeleton.txt"), facts.skeleton);
  process.stdout.write(`wrote ${GOLDEN}\n`);
}

// projectstore — the recorded content hash of each package guide, so a change
// to a default's text cannot ship without a guide_version bump (the
// authoring-guides ADR, decision 1). `node tests/fixtures/guides.mjs --write`
// records the current hashes; it refuses one whose content changed while its
// guide_version did not.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, "guide-hashes.json");

export function guideHashes(root) {
  const dir = join(root, "scaffold", "guides");
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const m = text.match(/^guide_version:\s*(\d+)\s*$/m);
    const body = text.replace(/^guide_version:.*\n/m, "");
    out[f.slice(0, -3)] = {
      guide_version: m ? Number(m[1]) : null,
      hash: createHash("sha256").update(body).digest("hex"),
    };
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  const root = resolve(HERE, "..", "..");
  const now = guideHashes(root);
  const was = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
  const stuck = Object.entries(now).filter(
    ([n, r]) => was[n] && was[n].hash !== r.hash && !(r.guide_version > was[n].guide_version),
  );
  if (stuck.length) {
    console.error(`changed without a guide_version bump: ${stuck.map(([n]) => n).join(", ")}`);
    process.exit(1);
  }
  writeFileSync(RECORD, JSON.stringify(now, null, 2) + "\n");
  console.log(`recorded ${Object.keys(now).length} guides`);
}

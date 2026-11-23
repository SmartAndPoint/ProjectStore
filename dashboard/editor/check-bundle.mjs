// The dashboard's editor, built from these sources: dashboard/public/editor.bundle.js,
// and dashboard/THIRD-PARTY-NOTICES.txt, the licence texts of every package the
// build put into it (CodeMirror's, Lezer's and their own dependencies'), which
// MIT asks to travel with each copy. A checkout and a git-channel copy run the
// committed files, so this is what ties them to their sources.
//
//   node check-bundle.mjs           builds into a temporary folder and fails when
//                                   either committed file differs by a byte
//   node check-bundle.mjs --write   writes both (npm run build)
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "public", "editor.bundle.js");
const NOTICES = join(here, "..", "THIRD-PARTY-NOTICES.txt");
const write = process.argv.includes("--write");

// The package folder of each node_modules input, once each, sorted.
function packagesOf(meta) {
  const dirs = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf("node_modules");
    if (at === -1) continue;
    const name = parts[at + 1].startsWith("@") ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
    dirs.add(join(here, ...parts.slice(0, at + 1), ...name.split("/")));
  }
  return [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function noticesOf(meta) {
  const blocks = [
    "Third-party software in dashboard/public/editor.bundle.js",
    "",
    "The dashboard's editor is built from dashboard/editor/src with esbuild and",
    "carries the packages below. Each one's licence text follows its name.",
    "This file is written by `npm run build --prefix dashboard/editor`.",
  ];
  for (const dir of packagesOf(meta)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
    if (!file) throw new Error(`${pkg.name}@${pkg.version} carries no licence file; it cannot go into the bundle`);
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n").trim();
    blocks.push("", "-".repeat(72), `${pkg.name}@${pkg.version} (${pkg.license || "see below"})`, "-".repeat(72), "", text);
  }
  return `${blocks.join("\n")}\n`;
}

const dir = mkdtempSync(join(tmpdir(), "ps-editor-"));
try {
  const out = join(dir, "editor.bundle.js");
  const r = await build({
    entryPoints: [join(here, "src", "editor.mjs")],
    bundle: true,
    format: "iife",
    globalName: "WSEditor",
    minify: true,
    target: "es2022",
    outfile: out,
    metafile: true,
    logLevel: "warning",
  });
  const bundle = readFileSync(out);
  const notices = Buffer.from(noticesOf(r.metafile), "utf8");
  if (write) {
    writeFileSync(BUNDLE, bundle);
    writeFileSync(NOTICES, notices);
    console.log(`wrote ${relative(join(here, ".."), BUNDLE)} (${bundle.length} bytes) and ${relative(join(here, ".."), NOTICES)}`);
  } else {
    let bad = 0;
    for (const [file, built] of [
      [BUNDLE, bundle],
      [NOTICES, notices],
    ]) {
      const committed = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
      if (!committed.equals(built)) {
        console.error(`dashboard/${relative(join(here, ".."), file).split(sep).join("/")} is not what dashboard/editor builds (${committed.length} bytes committed, ${built.length} built). Run: npm run build --prefix dashboard/editor`);
        bad++;
      }
    }
    if (bad) process.exitCode = 1;
    else console.log(`dashboard/public/editor.bundle.js (${bundle.length} bytes) and dashboard/THIRD-PARTY-NOTICES.txt match their sources`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

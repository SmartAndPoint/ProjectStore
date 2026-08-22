#!/usr/bin/env node
// Evidence tooling for the ADR "A session name is offered from the settled
// vault anchor". NOT shipped code and not imported by the plugin: it reads
// Claude Code transcripts, which are a harness file format this plugin must not
// take a dependency on.
//
// It exists because the ADR claims its constants "can be re-measured by anyone
// who doubts them", and that claim is false without a committed extractor —
// nobody, the author six months from now included, could regenerate the
// fixtures or extend them with new sessions.
//
// Anonymisation: cluster and leaf identities are renumbered per session in
// first-appearance order, so no artifact name from anyone's vault ships in this
// public repo. Folder KIND is kept (`doc:adr/D1`), because the rule's key space
// distinguishes epics from documents and a fixture that erased the kind could
// not test that distinction.
//
//   node tests/fixtures/extract-session-shapes.mjs <transcript-dir> <vault-path> > out.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ = new Set(["Read", "Grep", "Glob"]);
const DOC_FOLDERS = ["adr", "specs", "research", "concepts", "meetings", "ops"];

const [dir, vault] = process.argv.slice(2);
if (!dir || !vault) {
  process.stderr.write("usage: extract-session-shapes.mjs <transcript-dir> <vault-path>\n");
  process.exit(2);
}

const out = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const ev = [];
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line || line.indexOf(vault) === -1) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const sub = o.isSidechain === true;
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const x of content) {
      if (x?.type !== "tool_use") continue;
      const w = WRITE.has(x.name), r = READ.has(x.name);
      if (!w && !r) continue;
      const p = x.input?.file_path || x.input?.path;
      if (typeof p !== "string" || !p.startsWith(vault + "/")) continue;
      const rel = p.slice(vault.length + 1);
      const m = rel.match(/^epics\/([^/]+)\//);
      let cluster = null, leaf = null;
      if (m) {
        cluster = `epic:${m[1]}`;
        const lm = rel.match(/\/stories\/(.+)\.md$/);
        leaf = lm ? lm[1] : null;
      } else {
        const folder = DOC_FOLDERS.find((d) => rel.startsWith(d + "/"));
        const base = folder ? rel.slice(folder.length + 1) : null;
        if (!folder || !base || base.includes("/") || !base.endsWith(".md")) continue;
        if (base.toLowerCase() === "readme.md") continue;
        cluster = `doc:${folder}/${base}`;
      }
      ev.push({ cluster, leaf, write: w, sub });
    }
  }
  if (ev.length < 5) continue;
  const cm = new Map(), lm = new Map();
  const anon = ev.map((e) => {
    if (!cm.has(e.cluster)) {
      const kind = e.cluster.startsWith("epic:") ? "epic:E" : `doc:${e.cluster.slice(4).split("/")[0]}/D`;
      cm.set(e.cluster, kind + (cm.size + 1));
    }
    let leaf = null;
    if (e.leaf) {
      const k = `${e.cluster}|${e.leaf}`;
      if (!lm.has(k)) lm.set(k, `a${lm.size + 1}`);
      leaf = lm.get(k);
    }
    // [cluster, leaf, write?, subagent?] — order within a session is the
    // transcript's own chronological order, which the rule depends on.
    return [cm.get(e.cluster), leaf, e.write ? 1 : 0, e.sub ? 1 : 0];
  });
  out.push({ session: `S${out.length + 1}`, events: anon });
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");

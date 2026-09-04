// projectstore — provenance tests (PS-HARNESS: "Install, refresh and disown a
// harness surface: provenance, four states, the gate", slice 1; co-owned by
// "Capability manifests, the generator and the three invariants").
//
// Everything here runs over string literals: deriveState is a pure function
// over explicit inputs, so no fixture directory is needed. The last two tests
// are the ones that keep the module honest a year from now — "one emitter"
// and "the leaf stays a leaf" are asserted over the source tree, not stated.
//
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRAMMAR_VERSION,
  PROVENANCE_TOKEN,
  DELIMITERS,
  STALE,
  STALE_TEXT,
  hash12,
  sourceHash,
  renderHash,
  provenanceLine,
  banner,
  insertStamp,
  substituteProvenance,
  stamp,
  parseProvenance,
  tokenizeProvenance,
  renderHashOf,
  deriveState,
} from "../scripts/provenance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROJECT = '/Users/someone/Projects/Smart "Quoted" Store';
const OTHER_PROJECT = "/Users/someone/Projects/Other Project";
const SRC = "agents/critic.md";
const SOURCE_TEXT = "---\nname: critic\n---\n\nYou are the critic.\n";
const BODY = "---\nname: critic\nmodel: gpt-5\n---\n\n# Critic\n\nYou are the critic.\n";

function fresh(over = {}) {
  const srcHash = sourceHash(SOURCE_TEXT);
  const opts = { format: "markdown", src: SRC, srcHash, pkg: "0.27.2", project: PROJECT, harness: "codex", ...over };
  const out = stamp(BODY, opts);
  return { ...out, opts, srcHash };
}

function derive(text, over = {}) {
  const { srcHash, render } = fresh();
  return deriveState({
    file: { present: true, text },
    sourceHash: srcHash,
    pkg: "0.27.2",
    renderNowHash: render,
    project: PROJECT,
    ...over,
  });
}

test("provenance contract 1: emit → parse round-trips every field, spaces and quotes included", () => {
  const { text, render, srcHash } = fresh();
  const p = parseProvenance(text);
  assert.ok(p, "the stamped text parses");
  assert.equal(p.v, GRAMMAR_VERSION);
  assert.equal(p.src, SRC);
  assert.equal(p.srcHash, srcHash);
  assert.equal(p.pkg, "0.27.2");
  assert.equal(p.project, PROJECT, "project= survives a space and a double quote");
  assert.equal(p.render, render);
  assert.match(p.line, /^<!-- projectstore: v1 .* --> ?$/, "markdown delimiters wrap the line");
  assert.match(p.line, /— generated; edit the source, then reinstall/);
  assert.equal(hash12("x").length, 12);
});

test("provenance contract 1: the render hash is stable across the two passes and across delimiters", () => {
  const { text, tokenized, render } = fresh();
  const check = renderHashOf(text);
  assert.equal(check.claimed, render);
  assert.equal(check.actual, render, "substituting the line does not move the hash");
  assert.equal(renderHash(tokenized), render);
  // A hand-changed delimiter around the same line hashes the same: the whole
  // physical line is what the token replaces.
  const rewrapped = text.replace(/^<!-- (projectstore: v1 .*) -->$/m, "# $1");
  assert.equal(renderHashOf(rewrapped).actual, render);
  assert.equal(tokenizeProvenance(text).split(PROVENANCE_TOKEN).length, 2, "exactly one token line");
});

test("provenance contract 4: an untouched, matching file is current", () => {
  const { text } = fresh();
  const s = derive(text);
  assert.equal(s.state, "current");
  assert.equal(s.reason, null);
  assert.equal(s.writtenBy, PROJECT);
  assert.equal(s.sameProject, true);
});

test("provenance contract 4: a hand edit reports stale — edited by hand", () => {
  const { text } = fresh();
  const s = derive(text + "\nHAND EDIT\n");
  assert.equal(s.state, "stale");
  assert.equal(s.reason, STALE.EDITED);
  assert.equal(STALE_TEXT[s.reason], "edited by hand");
});

test("provenance contract 4: a changed source reports stale — source changed", () => {
  const { text } = fresh();
  const s = derive(text, { sourceHash: sourceHash(SOURCE_TEXT + "\nchanged\n") });
  assert.equal(s.state, "stale");
  assert.equal(s.reason, STALE.SOURCE);
});

test("provenance contract 4: a bumped package reports stale — plugin updated", () => {
  const { text } = fresh();
  const s = derive(text, { pkg: "0.28.0" });
  assert.equal(s.state, "stale");
  assert.equal(s.reason, STALE.PLUGIN);
});

test("provenance contract 4: a self-consistent file that differs from the current render reports stale — configuration changed", () => {
  const { text } = fresh();
  const now = stamp(BODY.replace("gpt-5", "gpt-5-mini"), fresh().opts).render;
  const s = derive(text, { renderNowHash: now });
  assert.equal(s.state, "stale");
  assert.equal(s.reason, STALE.CONFIG, "current means more than 'still describes itself'");
});

test("provenance contract 4: the ladder is ordered — a hand edit wins over a package bump", () => {
  const { text } = fresh();
  const s = derive(text + "\nHAND EDIT\n", { pkg: "0.28.0" });
  assert.equal(s.reason, STALE.EDITED);
});

test("provenance contract 3: a file under our prefix with no line is foreign", () => {
  const s = derive(BODY);
  assert.equal(s.state, "foreign");
  assert.equal(s.provenance, null);
  assert.equal(s.writtenBy, null);
});

test("provenance contract 3: an unreadable file is foreign — the safe action is identical", () => {
  const s = derive(null);
  assert.equal(s.state, "foreign");
});

test("provenance contract 3: a file in the roster but not on disk is absent", () => {
  const s = deriveState({ file: { present: false, text: null }, sourceHash: "0".repeat(12), pkg: "0.27.2", renderNowHash: "0".repeat(12), project: PROJECT });
  assert.equal(s.state, "absent");
  assert.equal(s.reason, null);
});

test("provenance contract 12: an identical render written by another project is current, last written by it", () => {
  const theirs = fresh({ project: OTHER_PROJECT });
  const s = derive(theirs.text);
  assert.equal(s.state, "current", "project= does not churn render=");
  assert.equal(s.writtenBy, OTHER_PROJECT);
  assert.equal(s.sameProject, false);
  // The same path with a trailing slash still counts as this project.
  const mine = derive(fresh().text, { project: PROJECT + "/" });
  assert.equal(mine.sameProject, true);
});

test("provenance: CRLF line endings do not report edited by hand, nor source changed", () => {
  const { text } = fresh();
  const crlf = text.replace(/\n/g, "\r\n");
  assert.equal(derive(crlf).state, "current");
  assert.equal(sourceHash(SOURCE_TEXT.replace(/\n/g, "\r\n")), sourceHash(SOURCE_TEXT));
  const stampedFromCrlf = stamp(BODY.replace(/\n/g, "\r\n"), fresh().opts);
  assert.equal(stampedFromCrlf.render, fresh().render, "a CRLF body renders to the same hash");
  assert.ok(!stampedFromCrlf.text.includes("\r"), "the rendered file is LF");
});

test("provenance: a source that quotes the grammar is still current when freshly stamped", () => {
  const example = provenanceLine({ src: "agents/x.md", srcHash: "a".repeat(12), pkg: "0.1.0", project: "/p", render: "b".repeat(12) });
  const body = BODY + "\nThe line looks like this:\n\n    " + example + "\n";
  const { text, render } = stamp(body, fresh().opts);
  assert.equal(parseProvenance(text).src, SRC, "ours is the first line, not the quoted one");
  const s = deriveState({ file: { present: true, text }, sourceHash: fresh().srcHash, pkg: "0.27.2", renderNowHash: render, project: PROJECT });
  assert.equal(s.state, "current");
  assert.equal(s.reason, null);
});

test("provenance: the emitter refuses what the parser could not read back", () => {
  assert.throws(() => provenanceLine({ src: "agents/my agent.md", srcHash: "0".repeat(12), pkg: "1", project: PROJECT, render: "0".repeat(12) }), /may not contain whitespace/);
  assert.throws(() => provenanceLine({ src: SRC, srcHash: "0".repeat(12), pkg: "1 beta", project: PROJECT, render: "0".repeat(12) }), /may not contain whitespace/);
  assert.throws(() => hash12(undefined), /expected a string/);
  assert.throws(() => insertStamp(BODY + PROVENANCE_TOKEN + "\n", { format: "markdown", harness: "codex", source: SRC }), /already carries a bare/);
});

test("provenance: an unknown grammar version reports stale — plugin updated, never foreign", () => {
  const { text } = fresh();
  const v2 = text.replace("projectstore: v1 ", "projectstore: v2 ");
  const s = derive(v2);
  assert.equal(s.state, "stale");
  assert.equal(s.reason, STALE.PLUGIN, "a downgrade must not orphan our own files against uninstall");
});

test("generation contract 15: one banner per format, each naming the remedy", () => {
  const md = banner("markdown", { harness: "codex", source: SRC });
  assert.ok(md.startsWith("<!--\n") && md.endsWith("-->\n"));
  const toml = banner("toml", { harness: "codex", source: SRC });
  assert.ok(toml.split("\n").filter(Boolean).every((l) => l.startsWith("# ")));
  const mjs = banner("mjs", { harness: "codex", source: SRC });
  assert.ok(mjs.split("\n").filter(Boolean).every((l) => l.startsWith("// ")));
  for (const b of [md, toml, mjs]) {
    assert.match(b, /GENERATED by scripts\/build-adapters\.mjs from agents\/critic\.md for the codex harness/);
    assert.match(b, /edit the source and re-run the generator/);
  }
  assert.equal(DELIMITERS.json, null);
});

test("provenance contract 1: the stamp goes after the frontmatter, after a shebang, else at line 1", () => {
  const withFm = insertStamp(BODY, { format: "markdown", harness: "codex", source: SRC });
  const fmEnd = "---\nname: critic\nmodel: gpt-5\n---\n";
  assert.ok(withFm.startsWith(fmEnd + "<!--\n"), "banner immediately after the frontmatter close");
  assert.ok(withFm.includes("-->\n" + PROVENANCE_TOKEN + "\n\n# Critic"), "token line, then the body");
  const noFm = insertStamp("# Title\n", { format: "markdown", harness: "codex", source: SRC });
  assert.ok(noFm.startsWith("<!--\n"));
  // The same close shapes lib.mjs parseFrontmatter accepts: no trailing
  // newline, an empty block, and CRLF (normalised on the way in).
  assert.ok(insertStamp("---\nname: x\n---", { format: "markdown", harness: "codex", source: SRC }).startsWith("---\nname: x\n---\n<!--\n"));
  assert.ok(insertStamp("---\n---\n# T\n", { format: "markdown", harness: "codex", source: SRC }).startsWith("---\n---\n<!--\n"));
  assert.ok(insertStamp("---\r\nname: x\r\n---\r\n# T\r\n", { format: "markdown", harness: "codex", source: SRC }).startsWith("---\nname: x\n---\n<!--\n"));
  assert.throws(() => insertStamp("---\nname: x\n# never closed\n", { format: "markdown", harness: "codex", source: SRC }), /never closes/);
  const script = insertStamp("#!/usr/bin/env node\nconsole.log(1);\n", { format: "mjs", harness: "codex", source: "hooks/x.mjs" });
  assert.ok(script.startsWith("#!/usr/bin/env node\n// GENERATED by"));
  const cfg = insertStamp("[a]\nb = 1\n", { format: "toml", harness: "codex", source: SRC });
  assert.ok(cfg.startsWith("# GENERATED by"));
});

test("provenance contract 2: a JSON surface cannot be stamped — it is shared, and the error says so", () => {
  assert.throws(() => insertStamp("{}", { format: "json", harness: "codex", source: SRC }), /SHARED surface/);
  assert.throws(() => banner("json", { harness: "codex", source: SRC }), /SHARED surface/);
  assert.throws(() => substituteProvenance(PROVENANCE_TOKEN + "\n", { format: "yaml", src: SRC, srcHash: "0".repeat(12), pkg: "1", project: PROJECT, render: "0".repeat(12) }), /cannot carry a provenance line/);
  assert.throws(() => substituteProvenance("no token here\n", { format: "toml", src: SRC, srcHash: "0".repeat(12), pkg: "1", project: PROJECT, render: "0".repeat(12) }), /run insertStamp first/);
  assert.throws(() => provenanceLine({ src: SRC, srcHash: "xyz", pkg: "1", project: PROJECT, render: "0".repeat(12) }), /12 lowercase hex/);
});

test("install spec acceptance: one emitter, one parser — no other script or hook carries the grammar", () => {
  for (const dir of ["scripts", "hooks"]) {
    for (const n of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".mjs") && f !== "provenance.mjs")) {
      const src = readFileSync(join(ROOT, dir, n), "utf8");
      // The grammar proper, not the prose prefix ("projectstore: vault not
      // found" is a statusline line in lib.mjs).
      assert.ok(!/projectstore: v\d+ src=/.test(src), `${dir}/${n} emits or parses the provenance grammar itself`);
      assert.ok(!src.includes("GENERATED by"), `${dir}/${n} renders a banner itself`);
    }
  }
});

test("install spec modules: the leaf stays a leaf — node:crypto only, and no hook imports it", () => {
  const src = readFileSync(join(ROOT, "scripts", "provenance.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto"]);
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!/^import\s+"/m.test(src) && !/from '/.test(src), "no side-effect or single-quoted import");
  for (const n of readdirSync(join(ROOT, "hooks")).filter((f) => f.endsWith(".mjs"))) {
    assert.ok(!readFileSync(join(ROOT, "hooks", n), "utf8").includes("provenance.mjs"), `hooks/${n} pulls the leaf into the SessionStart graph`);
  }
});

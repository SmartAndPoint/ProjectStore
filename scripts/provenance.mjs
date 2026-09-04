// projectstore — the provenance line: one emitter, one parser, one state ladder.
//
// Every file projectstore places into a harness (a Codex prompt, an opencode
// agent, a generated hook wrapper) carries one line that says what produced
// it and lets a later run decide whether it may touch the file again:
//
//   projectstore: v1 src=agents/critic.md@1a2b3c4d5e6f pkg=0.27.2 project="/abs/path" render=9f8e7d6c5b4a — generated; edit the source, then reinstall
//
// Two hashes. `src=` is the source bytes, so a stale copy of a changed source
// is detectable. `render=` is the rendered file with THIS WHOLE LINE replaced
// by the literal token %PROJECTSTORE-PROVENANCE%, so the hash never covers
// the hash it is about and no field of the line — `project=` included — can
// churn it. Rendering is therefore two-pass: render with the token line, hash,
// substitute. A file two projects rendered identically differs only in the
// line, which is what makes "current, last written by <project>" reportable.
//
// This module is deliberately a LEAF. It imports node:crypto and nothing else;
// it opens no file, reads no environment variable and has no clock. Every
// "current" input the state ladder needs — the source hash, the package
// version, the hash of what we would render now — is handed in by the
// caller, so the ladder is a pure function testable with string literals.
// It is not part of scripts/lib.mjs on purpose: lib.mjs is parsed on every
// SessionStart, and the installer and doctor are the only consumers here.
// The direction is installer → provenance ← doctor; nothing in this file may
// ever import the installer, harness.mjs or lib.mjs.
//
// Normative: the spec "Installing, refreshing and disowning a harness
// surface" (contract 1 — the grammar; 3 and 4 — the four states and the
// ordered derivation) and "Generated harness surfaces" (contract 15 — every
// generated non-JSON file is stamped, and the banner says to edit the source).
// The two-hash line, the two-pass render and the four-state model are
// contributed by Ivan Morozov (MultiProjectStore, scripts/agents.mjs:
// provenance(), renderHashOf(), status()); the generated-file banner and its
// three per-format renderers are contributed by Maxim Podreshetnikov (PR #13,
// scripts/build-adapters.mjs: BANNER_LINES, mdBanner, hashBanner,
// slashBanner). `v1`, `pkg=`, `project=` and the four-reason stale split are
// ours.

import { createHash } from "node:crypto";

// ─── Constants ─────────────────────────────────────────────────────────

export const GRAMMAR_VERSION = 1;
export const PROVENANCE_TOKEN = "%PROJECTSTORE-PROVENANCE%";
export const HASH_LEN = 12;
export const DEFAULT_GENERATOR = "scripts/build-adapters.mjs";

// Per-format delimiters around the provenance line. `json` is null on
// purpose: a format that cannot carry a comment is a SHARED surface (install
// spec contracts 2 and 6), owned per entry, and is never stamped — emitting
// an empty banner for it would let a caller ship an unowned file in silence.
export const DELIMITERS = Object.freeze({
  markdown: Object.freeze(["<!-- ", " -->"]),
  toml: Object.freeze(["# ", ""]),
  // The hook wrappers are JavaScript, where `#` is a syntax error rather than
  // a comment. PR #13 records that emitting the hash banner into the wrapper
  // produced a file that parsed nowhere — hence its third renderer.
  mjs: Object.freeze(["// ", ""]),
  json: null,
});

export const STALE = Object.freeze({
  EDITED: "edited-by-hand",
  SOURCE: "source-changed",
  PLUGIN: "plugin-updated",
  CONFIG: "configuration-changed",
});

// Doctor's exact wording, in one place, so the report and the tests read the
// same source. A stale finding with no reason is a bug report the user cannot
// act on (install spec, contract 4).
export const STALE_TEXT = Object.freeze({
  [STALE.EDITED]: "edited by hand",
  [STALE.SOURCE]: "source changed",
  [STALE.PLUGIN]: "plugin updated",
  [STALE.CONFIG]: "configuration changed",
});

// Contract 5's resolution wording (Ivan Morozov's), in one place for the
// verbs that refuse and the report that names.
export const FOREIGN_TEXT = "a file we did not write sits at our path — rename it if it is yours, or delete it to let install take the name";

const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

function unsupportedFormat(format) {
  return new Error(
    `format "${format}" cannot carry a provenance line — a JSON surface is a ` +
    `SHARED surface (install spec contracts 2 and 6), owned per entry, not stamped; ` +
    `known stampable formats: ${Object.keys(DELIMITERS).filter((k) => DELIMITERS[k]).join(", ")}`,
  );
}

function delimitersFor(format) {
  const d = DELIMITERS[format];
  if (!d) throw unsupportedFormat(format);
  return d;
}

// ─── Hashing ───────────────────────────────────────────────────────────

// The one truncation point. `src=` and `render=` must never truncate
// differently, and the parser's `[0-9a-f]{12}` is this length.
export function hash12(text) {
  if (typeof text !== "string") {
    // A caller bug (an unread file, an undefined field) must not produce a
    // well-formed hash that looks exactly like a legitimate one.
    throw new TypeError(`hash12: expected a string, got ${text === null ? "null" : typeof text}`);
  }
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LEN);
}

// The source bytes, as read by the caller. EOL-normalised like renderHash,
// for the same reason: a CRLF checkout must not report every installed file
// as "source changed" one ladder step after "edited by hand" was ruled out.
export function sourceHash(text) {
  return hash12(normalizeEol(String(text)));
}

// The ONLY function that computes `render=`. Both the emitting pass and the
// checking pass go through it, so they cannot disagree — and the EOL
// normalisation lives here, once, so a Windows checkout with autocrlf does not
// report every installed file as "edited by hand".
export function renderHash(tokenizedText) {
  return hash12(normalizeEol(String(tokenizedText)));
}

// ─── Emit ──────────────────────────────────────────────────────────────

// The bare line, no delimiters. One emitter (install spec, contract 1).
// `project` is JSON-quoted because real vault and project paths carry spaces
// (and the maintainer's own does); the parser JSON-decodes it back.
export function provenanceLine({ src, srcHash, pkg, project, render }) {
  for (const [k, v] of Object.entries({ src, srcHash, pkg, project, render })) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`provenanceLine: field "${k}" must be a non-empty string`);
    }
  }
  // `src` and `pkg` are bare tokens in the grammar (`\S+`). A value with
  // whitespace would be emitted, fail to parse back, derive `foreign`, and
  // make our own file immune to uninstall — refuse it here instead.
  for (const [k, v] of Object.entries({ src, pkg })) {
    if (/\s/.test(v)) throw new Error(`provenanceLine: field "${k}" may not contain whitespace (got ${JSON.stringify(v)})`);
  }
  if (!/^[0-9a-f]{12}$/.test(srcHash) || !/^[0-9a-f]{12}$/.test(render)) {
    throw new Error("provenanceLine: srcHash and render must be 12 lowercase hex characters");
  }
  return (
    `projectstore: v${GRAMMAR_VERSION} src=${src}@${srcHash} pkg=${pkg} ` +
    `project=${JSON.stringify(project)} render=${render} — generated; edit the source, then reinstall`
  );
}

export const DEFAULT_REMEDY = "tests/portability.test.mjs fails while this file is out of date.";

// The third line is the remedy, and it differs by who wrote the file: a
// committed generated tree is caught by the portability suite, an installed
// file on a user's machine is caught by doctor and refreshed by install.
export const BANNER_LINES = (harness, source, generator = DEFAULT_GENERATOR, remedy = DEFAULT_REMEDY) => [
  `GENERATED by ${generator} from ${source} for the ${harness} harness.`,
  "Do not edit this file — edit the source and re-run the generator.",
  remedy,
];

// The generated-file banner for one format. Markdown gets a block comment,
// the line formats get one comment per line.
export function banner(format, { harness, source, generator = DEFAULT_GENERATOR, remedy = DEFAULT_REMEDY }) {
  const lines = BANNER_LINES(harness, source, generator, remedy);
  if (format === "markdown") {
    return "<!--\n" + lines.map((l) => "  " + l).join("\n") + "\n-->\n";
  }
  const [open] = delimitersFor(format);
  return lines.map((l) => open + l).join("\n") + "\n";
}

// Where the stamp goes: after a leading frontmatter block for markdown (the
// same `---` shape lib.mjs parseFrontmatter recognises — a close with or
// without a trailing newline; this detector must agree with it, not improve on
// it), after a shebang for `.mjs`, else line 1. `body` is already
// EOL-normalised by the caller. A markdown body that opens a frontmatter block
// and never closes it is refused rather than stamped at line 1: a banner
// before the `---` is a file the harness silently stops loading.
function insertionOffset(body, format) {
  if (format === "markdown") {
    // The optional group admits an empty block (`---\n---`), which
    // parseFrontmatter does not match at all — that is the one place this
    // detector is wider, so that a harness reading it as frontmatter never
    // sees our banner inside it.
    const m = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/.exec(body);
    if (m) return m[0].length;
    if (body.startsWith("---\n") || body === "---") {
      throw new Error("insertStamp: markdown body opens a frontmatter block that never closes — refusing to stamp before it");
    }
  }
  if (format === "mjs" && body.startsWith("#!")) {
    const nl = body.indexOf("\n");
    return nl === -1 ? body.length : nl + 1;
  }
  return 0;
}

const bareTokenRe = () => new RegExp(`^${PROVENANCE_TOKEN.replace(/[%]/g, "\\$&")}$`, "m");

// Pass 1: banner plus the bare token ALONE on its own physical line, with no
// delimiter and no indentation — because the checker replaces the entire
// physical line, delimiters included, with the bare token, and the two
// must hash the same. The body is EOL-normalised here, once: what we render
// is ours to normalise, and every hash path already assumes LF.
export function insertStamp(body, { format, harness, source, generator = DEFAULT_GENERATOR, remedy = DEFAULT_REMEDY }) {
  delimitersFor(format);
  const text = normalizeEol(String(body));
  if (bareTokenRe().test(text)) {
    throw new Error(`insertStamp: the body already carries a bare ${PROVENANCE_TOKEN} line — it would survive into the installed file`);
  }
  const at = insertionOffset(text, format);
  const block = banner(format, { harness, source, generator, remedy }) + PROVENANCE_TOKEN + "\n";
  // A frontmatter close with no trailing newline (which parseFrontmatter
  // accepts) still needs the banner on its own line.
  const glue = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
  return text.slice(0, at) + glue + block + text.slice(at);
}

// Pass 2: the token line becomes the delimited real line.
export function substituteProvenance(tokenized, { format, src, srcHash, pkg, project, render }) {
  const [open, close] = delimitersFor(format);
  const line = open + provenanceLine({ src, srcHash, pkg, project, render }) + close;
  const re = bareTokenRe();
  if (!re.test(tokenized)) {
    throw new Error("substituteProvenance: no bare token line to substitute — run insertStamp first");
  }
  return String(tokenized).replace(re, () => line);
}

// The whole two-pass render. Returns the stamped text, the hash that went into
// `render=`, and the tokenized pass-1 text — so a generator that also needs
// "what would we render now" has it without rendering twice.
//
// The hash input is the pass-1 text run through the SAME tokenizer the checker
// uses. A body that quotes a grammar-shaped line (commands/doctor.md will,
// per install contract 5) would otherwise hash differently on write and on
// read and be born "edited by hand" — a false accusation reinstalling cannot
// clear. The cost: an edit confined to such a quoted line does not move
// `render=`; strictly narrower harm than a permanent false positive.
export function stamp(body, { format, src, srcHash, pkg, project, harness, generator = DEFAULT_GENERATOR, remedy = DEFAULT_REMEDY }) {
  const tokenized = insertStamp(body, { format, harness, source: src, generator, remedy });
  const render = renderHash(tokenizeProvenance(tokenized) ?? tokenized);
  const text = substituteProvenance(tokenized, { format, src, srcHash, pkg, project, render });
  return { text, render, tokenized };
}

// ─── Parse ─────────────────────────────────────────────────────────────

// One grammar string, two RegExp constructors — never one shared /g literal,
// whose lastIndex survives between calls. `[^\n]*?` … `[^\n]*$` make the match
// cover the whole physical line, whatever delimiter wraps it; `src=(\S+?)` is
// lazy because a greedy `\S+` swallows `@<hash>`.
const GRAMMAR =
  String.raw`^[^\n]*?projectstore: v(\d+) src=(\S+?)@([0-9a-f]{12}) pkg=(\S+) ` +
  String.raw`project="((?:[^"\\]|\\.)*)" render=([0-9a-f]{12})[^\n]*$`;
const parseRe = () => new RegExp(GRAMMAR, "m");
const tokenizeRe = () => new RegExp(GRAMMAR, "gm");

// The first provenance line in `text`, decoded; null when there is none.
export function parseProvenance(text) {
  if (typeof text !== "string") return null;
  const m = parseRe().exec(normalizeEol(text));
  if (!m) return null;
  let project;
  try {
    project = JSON.parse(`"${m[5]}"`);
  } catch {
    return null;
  }
  return {
    v: Number(m[1]),
    src: m[2],
    srcHash: m[3],
    pkg: m[4],
    project,
    render: m[6],
    line: m[0],
    index: m.index,
  };
}

// Every provenance line replaced by the bare token (all of them, so a pasted
// duplicate still hashes deterministically and reports "edited by hand"
// rather than depending on which line won). Null when there is none.
export function tokenizeProvenance(text) {
  if (typeof text !== "string") return null;
  const normalized = normalizeEol(text);
  if (!parseRe().test(normalized)) return null;
  return normalized.replace(tokenizeRe(), PROVENANCE_TOKEN);
}

// The claimed `render=` against what the file hashes to now.
export function renderHashOf(text) {
  const parsed = parseProvenance(text);
  if (!parsed) return null;
  return { claimed: parsed.render, actual: renderHash(tokenizeProvenance(text)) };
}

// ─── Derive (install spec, contracts 3 and 4) ──────────────────────────

const stripTrailingSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

// The four states as a total, ordered function over explicit inputs:
//
//   file          { present: boolean, text: string | null }  — null text = unreadable
//   sourceHash    hash12 of the current source bytes (caller reads them)
//   pkg           the current package version (caller resolves it)
//   renderNowHash renderHash of what we would render now — stamp().render
//   project       this project's absolute path
//
// Step 5 compares HASHES, never bytes. Comparing bytes (as MultiProjectStore's
// status() does) makes step 6 unreachable: on a shared user-level path the
// `project=` field differs, so the bytes differ, and every file another
// project wrote would report "configuration changed" instead of "current,
// last written by <project>". The leaf never decides whether a path is shared
// — that is manifest data (contract 10) — so it always returns `writtenBy` and
// `sameProject`, and doctor composes the sentence.
export function deriveState({ file, sourceHash: srcNow, pkg, renderNowHash, project }) {
  const result = (state, reason = null, provenance = null) => ({
    state,
    reason,
    provenance,
    writtenBy: provenance ? provenance.project : null,
    sameProject: Boolean(
      provenance && typeof project === "string" &&
      stripTrailingSlash(provenance.project) === stripTrailingSlash(project),
    ),
  });

  if (!file || !file.present) return result("absent");
  if (typeof file.text !== "string") return result("foreign");

  // 1. no parseable line → foreign
  const parsed = parseProvenance(file.text);
  if (!parsed) return result("foreign");
  const provenance = {
    v: parsed.v, src: parsed.src, srcHash: parsed.srcHash,
    pkg: parsed.pkg, project: parsed.project, render: parsed.render,
  };

  // A newer grammar than this parser knows. The spec does not say; reporting
  // it as foreign would make our own files immune to uninstall after a
  // downgrade (contract 13), so it is the plugin that changed.
  if (parsed.v !== GRAMMAR_VERSION) return result("stale", STALE.PLUGIN, provenance);

  // 2. claimed render ≠ recomputed(file, line→token) → stale: edited by hand
  const actual = renderHash(tokenizeProvenance(file.text));
  if (parsed.render !== actual) return result("stale", STALE.EDITED, provenance);

  // 3. parsed src hash ≠ current source hash → stale: source changed
  if (parsed.srcHash !== srcNow) return result("stale", STALE.SOURCE, provenance);

  // 4. parsed pkg ≠ current package version → stale: plugin updated
  if (parsed.pkg !== pkg) return result("stale", STALE.PLUGIN, provenance);

  // 5. render-now ≠ file → stale: configuration changed
  if (actual !== renderNowHash) return result("stale", STALE.CONFIG, provenance);

  // 6. current — and `writtenBy` says who, for a shared path
  return result("current", null, provenance);
}

#!/usr/bin/env node
// projectstore — directory-guard.mjs (PS-DIRECTORY: "A guard holds the tracked
// plugin tree to the directory's file rules, so CI fails before the portal
// would hold a version")
//
//   node packaging/directory-guard.mjs [--set packed|repository]
//
// Anthropic's directory checks the plugin folder's files twice: Validate, in
// the submission form, and a scan of each new commit on the branch it tracks.
// Some findings hold a version for a reviewer, some block it, and some stop
// validation before there is a report (the pre-submission checklist,
// https://claude.com/docs/plugins/pre-submission-checklist, read 2026-10-16).
// Without this guard the first anyone would see of a breach is a held version
// in the portal, days after the merge. Here it fails `npm run release:check`
// and CI's test job instead, like the version guard does for the manifests.
//
// Which tree: the set the directory scans. `packed` (the default) is the npm
// packlist, tests/fixtures/packlist.json — what the `directory` branch carries
// (packaging/directory-branch.mjs), with each file read from the checkout and
// lstat'ed, so a symbolic link stays one. `repository` is `git ls-files -s`,
// for a maintainer who has the directory track `main`: every tracked entry,
// its mode (120000 a symbolic link, 160000 a submodule) and its bytes, read
// from the checkout (the staged blob where the checkout has no such file).
// trackedSet() is the one function that names the set.
//
// check() is pure: it reads nothing, the entries carry their bytes. One row
// per checklist rule, plus one of ours (the headroom rule below). Each finding
// names the file (and line, where there is one), the rule, its limit and the
// checklist's result for it. A credential finding names the file, the line and
// the key's shape, never its value.
//
// Our headroom rule: no shipped .mjs over 200 KiB (204,800 bytes), stricter
// than the directory's 256 KiB, so a module is split long before the limit
// where the checklist holds a version. "Shipped" is the packlist under either
// set: in the repository set the tests' own .mjs files are held to the
// directory's 256 KiB only. There is no exemption — the installer was split
// first (PS-DIRECTORY: "The installer is split into modules under 200 KiB
// each…"), and the report names the next file in line.
//
// Where the checklist leaves a reading open, the guard takes the stricter one:
// SVG is text, so the 256 KiB limit holds for it; a symbolic link, a submodule
// or an LFS pointer fails wherever it is, not only where the plugin loads it;
// a package source in an .npmrc fails whether or not the plugin runs a
// launcher; the attributes text, eol, crlf, ident and working-tree-encoding
// count as rewriting contents, as filter does (so `* text=auto eol=lf` fails
// here); JPEG and GIF completeness is a heuristic (the end marker), PNG and
// WebP are walked; the archive's size is bounded by the unpacked bytes plus a
// 512-byte header per entry; and front matter is read as the subset of YAML our
// files use, so some text a parser could read fails here: an indented
// continuation of a value already on its line, a quoted value or a flow
// collection that does not close on its line, a value starting with an anchor,
// alias, tag, `,` or `]`, a `? ` key, and a description YAML 1.1 reads as a
// boolean (yes, no, on, off) or a number with `_`.
//
// Output is JSON on stdout, always: every row with its findings, and each
// limit's headroom. Exit 0 when every row passes, 1 when one fails or the set
// cannot be read. Never shipped: packaging/ is in NOT_SHIPPED, and so are the
// credential shapes and the git call.

import { readFileSync, lstatSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKLIST } from "../scripts/version-guard.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHECKLIST = "https://claude.com/docs/plugins/pre-submission-checklist";
export const SETS = ["packed", "repository"];

const KiB = 1024;
const MiB = 1024 * KiB;
export const LIMITS = {
  files: 512, // 512 files or fewer
  size: 256 * KiB, // under it, for a file that is not an image or a font
  headroom: 200 * KiB, // ours: at most this, for a shipped .mjs
  readmeWords: 40, // at least this many, outside code blocks
  fileMax: 5 * MiB, // every file under it
  unpacked: 256 * MiB, // the repository under it, unpacked
  archived: 50 * MiB, // and under it, as GitHub archives it
  entries: 10000, // fewer files and folders than this
};

const n = (x) => x.toLocaleString("en-US");

// ─── The set ────────────────────────────────────────────────────────────

function readPacklist(root) {
  const abs = resolve(root, PACKLIST);
  if (!existsSync(abs)) return null;
  const list = JSON.parse(readFileSync(abs, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${PACKLIST}: not a list of paths`);
  return list;
}

// One entry: { path, kind: "file" | "symlink" | "submodule", size, bytes,
// shipped }. `bytes` is set for a file only.
function fromDisk(root, path, shipped) {
  let st;
  try {
    st = lstatSync(join(root, path));
  } catch {
    throw new Error(`${path}: on the packlist but not in the tree — ${PACKLIST} is stale`);
  }
  if (st.isSymbolicLink()) return { path, kind: "symlink", size: st.size, shipped };
  if (!st.isFile()) throw new Error(`${path}: on the packlist but not a file`);
  const bytes = readFileSync(join(root, path));
  return { path, kind: "file", size: bytes.length, bytes, shipped };
}

function git(root, args, input) {
  const r = spawnSync("git", ["-C", root, ...args], {
    input,
    maxBuffer: 1024 * MiB,
    timeout: 120000,
  });
  if (r.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${String(r.stderr || r.error?.message || "").trim() || `exit ${r.status}`}`,
    );
  return r.stdout;
}

function fromGit(root, shipped) {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8");
  const seen = new Map();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, sha] = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (!seen.has(path)) seen.set(path, { mode, sha });
  }
  const entries = [];
  const blobs = [];
  for (const [path, { mode, sha }] of seen) {
    const e = { path, mode, shipped: shipped.has(path) };
    if (mode === "160000") Object.assign(e, { kind: "submodule", size: 0 });
    else if (mode === "120000") Object.assign(e, { kind: "symlink", size: 0 });
    else {
      e.kind = "file";
      // The bytes about to be committed: the checkout's file, or the staged
      // blob when the checkout has none (deleted, or a name a case-insensitive
      // disk cannot hold beside another).
      let st = null;
      try {
        st = lstatSync(join(root, path));
      } catch {}
      if (st?.isFile()) {
        e.bytes = readFileSync(join(root, path));
        e.size = e.bytes.length;
      } else blobs.push({ e, sha });
    }
    entries.push(e);
  }
  if (blobs.length) {
    // The staged bytes, in one cat-file: each answer is "<sha> blob <size>\n",
    // the bytes, and "\n".
    const buf = git(root, ["cat-file", "--batch"], blobs.map((b) => b.sha).join("\n") + "\n");
    let at = 0;
    for (const { e, sha } of blobs) {
      const nl = buf.indexOf(0x0a, at);
      const [got, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
      if (got !== sha || type !== "blob") throw new Error(`${e.path}: git cat-file answered "${got} ${type}"`);
      e.bytes = buf.subarray(nl + 1, nl + 1 + Number(size));
      e.size = e.bytes.length;
      at = nl + 1 + Number(size) + 1;
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The tracked set. `packlist` stands in for tests/fixtures/packlist.json (a
// test's own tree); in the repository set it only marks what ships.
export function trackedSet(root = ROOT, { set = "packed", packlist } = {}) {
  if (!SETS.includes(set)) throw new Error(`--set ${set}: the set is ${SETS.join(" or ")}`);
  const list = packlist ?? readPacklist(root);
  if (set === "packed") {
    if (!list) throw new Error(`${PACKLIST}: missing — the packed set is the packlist`);
    return [...new Set(list)].sort().map((p) => fromDisk(root, p, true));
  }
  return fromGit(root, new Set(list || []));
}

// ─── What a file is ─────────────────────────────────────────────────────

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const FONT_EXT = /\.(?:woff2?|ttf|otf|ttc)$/i;
const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const starts = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const ascii = (b, at, s) => b.length >= at + s.length && b.subarray(at, at + s.length).toString("latin1") === s;

// A PNG is complete when its chunks run, inside the file, to IEND.
function pngComplete(b) {
  let at = 8;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString("latin1");
    at += 12 + len;
    if (at > b.length) return false;
    if (type === "IEND") return true;
  }
  return false;
}

// { kind: "image" | "font" | "text" | "binary", format, complete }.
export function sniff(path, b) {
  if (starts(b, PNG_SIG)) return { kind: "image", format: "PNG", complete: pngComplete(b) };
  if (starts(b, [0xff, 0xd8, 0xff]))
    return { kind: "image", format: "JPEG", complete: b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 };
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))
    return { kind: "image", format: "GIF", complete: b[b.length - 1] === 0x3b };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"))
    return { kind: "image", format: "WebP", complete: 8 + b.readUInt32LE(4) <= b.length };
  if (
    FONT_EXT.test(path) &&
    (["wOFF", "wOF2", "OTTO", "ttcf", "true"].some((s) => ascii(b, 0, s)) || starts(b, [0, 1, 0, 0]))
  )
    return { kind: "font", format: "font", complete: true };
  if (!b.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      return { kind: "text", format: "text", complete: true };
    } catch {}
  }
  return { kind: "binary", format: "binary", complete: false };
}

// The lines of a Markdown text, with whether a fence holds each (the fence's
// own lines are not yielded) — the same reading as tests/fixtures/markdown.mjs,
// which a file under packaging/ does not import.
function* markdownLines(md) {
  let fence = null;
  for (const [i, line] of md.split("\n").entries()) {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      else yield { line, n: i + 1, fenced: true };
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    yield { line, n: i + 1, fenced: false };
  }
}

const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

// The words a reader of the listing sees: none from a fenced code block, an
// HTML comment or tag, or a link's target.
export function proseWords(md) {
  const prose = [...markdownLines(md)]
    .filter((l) => !l.fenced)
    .map((l) => l.line)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\]\([^)]*\)/g, "] ");
  return (prose.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

// ─── The rows ───────────────────────────────────────────────────────────

// The checklist's rows, each with its section, its result if broken and the
// title its report shows. `ours` is the one rule that is not the checklist's.
export const ROWS = [
  {
    id: "regular-files",
    section: "Repository and folder layout",
    rule: "regular files and folders, not symbolic links, Git submodules or Git LFS pointer files",
    limit: "regular files only",
    result: "Blocks where the plugin loads the entry, Warning elsewhere",
  },
  {
    id: "system-files",
    section: "Repository and folder layout",
    rule: "no .DS_Store, Thumbs.db, desktop.ini or __MACOSX entries in the plugin folder",
    limit: "none of them",
    result:
      "Blocks (This is a macOS or Windows system file; after submitting, Files in the repository the scanner won’t accept)",
  },
  {
    id: "names",
    section: "Repository and folder layout",
    rule: "file and folder names valid on Windows and macOS: no colon or other character Windows refuses, no trailing dot or space, no Windows device name, no two names that differ only by capitalization",
    limit: "every path segment",
    result: "Validation stops (Couldn’t validate that repository)",
  },
  {
    id: "gitattributes",
    section: "Repository and folder layout",
    rule: "no export-ignore or export-subst in any .gitattributes, and no filter or other attribute that rewrites file contents",
    limit: "none of those attributes",
    result: "Validation stops (Couldn’t validate that repository)",
  },
  {
    id: "repository-size",
    section: "Repository and folder layout",
    rule: "the repository under 50 MiB archived and 256 MiB unpacked, with fewer than 10,000 files and folders, and every file under 5 MiB",
    limit: `archive under ${n(LIMITS.archived)} bytes, unpacked under ${n(LIMITS.unpacked)}, under ${n(LIMITS.entries)} entries, each file under ${n(LIMITS.fileMax)}`,
    result: "Validation stops (Repository too large to validate)",
  },
  {
    id: "readme",
    section: "README and license",
    rule: "a README of at least 40 words in the plugin folder, words inside code blocks not counted",
    limit: `${LIMITS.readmeWords} words`,
    result: "Blocks (README missing, README too short)",
  },
  {
    id: "license",
    section: "README and license",
    rule: "a LICENSE file in the plugin folder, or license set in .claude-plugin/plugin.json",
    limit: "one of them",
    result: "Blocks (License missing)",
  },
  {
    id: "file-size",
    section: "Files in the plugin folder",
    rule: "every file that is not an image or a font under 256 KiB",
    limit: `under ${n(LIMITS.size)} bytes`,
    result: "Held for a reviewer (Files or downloads the validator couldn’t inspect)",
  },
  {
    id: "file-count",
    section: "Files in the plugin folder",
    rule: "the plugin keeps to 512 files or fewer",
    limit: `${n(LIMITS.files)} files`,
    result: "Held for a reviewer (Files or downloads the validator couldn’t inspect)",
  },
  {
    id: "file-types",
    section: "Files in the plugin folder",
    rule: "only text files (SVG included), complete PNG, JPEG, GIF and WebP images, and font files",
    limit: "those kinds only",
    result: "Held for a reviewer (Files or downloads the validator couldn’t inspect)",
  },
  {
    id: "readme-images",
    section: "Files in the plugin folder",
    rule: "a bundled image shown in the README uses Markdown image syntax, not HTML <img>, <picture> or srcset",
    limit: "Markdown image syntax only",
    result: "Held for a reviewer",
  },
  {
    id: "bundled-references",
    section: "Files in the plugin folder",
    rule: "no bundled image or font named from commands, hooks or scripts, or written in backticks or a code block",
    limit: "named nowhere but the README's Markdown images and the manifest",
    result: "Held for a reviewer",
  },
  {
    id: "package-source",
    section: "Review what the plugin runs and connects to",
    rule: "no .npmrc, bunfig.toml, uv.toml or other package-manager configuration that sets a registry, index, proxy or other package source",
    limit: "no package source set",
    result:
      "Blocks with a launcher, Held for a reviewer with a package install (Install may use a custom registry or package source)",
  },
  {
    id: "credentials",
    section: "Review what the plugin runs and connects to",
    rule: "real credentials kept out of every file, documentation and examples included: no sk- key, no ghp_ or github_pat_ token, no private key block",
    limit: "no key-shaped value",
    result: "Blocks",
  },
  {
    id: "front-matter",
    section: "Hooks, skills, commands, and agents",
    rule: "valid YAML front matter in each skill, command and agent file, with description a single text value, not a list",
    limit: "front matter a YAML parser reads; description text",
    result:
      "Blocks for front matter that doesn't parse or a description that isn't text; Warning for no front matter or no description",
  },
  {
    id: "headroom",
    section: "ours",
    ours: true,
    rule: "every shipped .mjs at most 200 KiB, so a module is split long before the directory's 256 KiB",
    limit: `${n(LIMITS.headroom)} bytes`,
    result: "ours: npm run release:check and CI's test job fail",
  },
];

const ROW = Object.fromEntries(ROWS.map((r) => [r.id, r]));

// One finding's message: where, what, the rule, its limit, the result.
function say(id, where, what) {
  const r = ROW[id];
  const result = r.ours ? `our rule, stricter than the checklist: ${r.result}` : `the checklist's result: ${r.result}`;
  return `${where}: ${what} — the rule: ${r.rule} (limit: ${r.limit}); ${result}`;
}

const base = (p) => posix.basename(p);
const segments = (p) => p.split("/");

// Every path in the set, and every folder above one.
function allPaths(entries) {
  const out = new Set();
  for (const e of entries) {
    const s = segments(e.path);
    for (let i = 1; i <= s.length; i++) out.add(s.slice(0, i).join("/"));
  }
  return [...out].sort();
}

const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "__macosx"]);
// Windows refuses these in a name; macOS's Finder refuses the colon.
const BAD_CHAR = /[<>:"|?*\\\u0000-\u001f]/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const LFS = "version https://git-lfs.github.com/spec/v1";
// Attributes that change what a checkout or an archive holds.
const ARCHIVE_ATTRS = new Set(["export-ignore", "export-subst"]);
const REWRITE_ATTRS = new Set(["filter", "ident", "working-tree-encoding", "text", "eol", "crlf"]);

// Package-manager configuration, by file name: the keys that set a source.
const PACKAGE_SOURCES = [
  [/^\.npmrc$/, /^\s*(?:@[^:\s]+:)?(registry|(?:https-)?proxy|noproxy|replace-registry-host)\s*=/i],
  [/^\.yarnrc$/, /^\s*"?(registry|(?:https-)?proxy)"?\s/i],
  [/^\.yarnrc\.yml$/, /^\s*(npmRegistryServer|npmScopes|httpProxy|httpsProxy|unsafeHttpWhitelist)\s*:/],
  [/^bunfig\.toml$/, /^\s*(registry|\[install\.scopes\]|\[install\.registry\])/],
  [/^(?:uv\.toml|pip\.conf|pip\.ini)$/, /^\s*(index-url|extra-index-url|find-links|index|no-index|\[\[index\]\])/],
];

// Key shapes: Anthropic's sk- prefix with a key's length (20 or more key
// characters, so a language tag such as sk-SK or a class such as sk-spinner
// is not a key), GitHub's token prefixes (ghp_, gho_, ghu_, ghs_, ghr_ and
// github_pat_), and a private key block. The pattern sources hold none of
// them (a test checks).
const CREDENTIALS = [
  ["an sk- key (Anthropic's prefix)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a GitHub token (ghp_, gho_, ghu_, ghs_ or ghr_)", /\bgh[pousr]_[A-Za-z0-9]/],
  ["a github_pat_ token (GitHub's prefix)", /\bgithub_pat_[A-Za-z0-9]/],
  ["a private key block", /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}/],
];

// The credential findings of one text, as [line, shape]: never the value.
export function credentialLines(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries())
    for (const [shape, re] of CREDENTIALS) if (re.test(line)) out.push([i + 1, shape]);
  return out;
}

// The component files whose front matter the checklist parses: each agent,
// command and skill of the plugin, a namespaced command or agent included.
const COMPONENT = /^(?:agents\/.+\.md|commands\/.+\.md|skills\/[^/]+\/SKILL\.md)$/;
// What a plain value cannot start with: YAML reads each as syntax.
const PLAIN_START = /^(?:[-?:](?:\s|$)|[,[\]{}#&*!|>%@`])/;
// A double-quoted value closed on its line, with only the escapes YAML knows;
// a single-quoted one, its quote doubled inside.
const DOUBLE = /^"(?:[^"\\]|\\(?:[0abtnvfre "/\\N_LP\t]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}))*"(?:\s+#.*)?$/;
const SINGLE = /^'(?:[^']|'')*'(?:\s+#.*)?$/;
// What a parser reads as no text: null, a boolean (YAML 1.1's yes/no/on/off
// too) or a number, in either YAML's forms.
const NOT_TEXT =
  /^(?:~|null|Null|NULL|(?:true|false|yes|no|on|off|y|n)|(?:True|False|Yes|No|On|Off|Y|N)|(?:TRUE|FALSE|YES|NO|ON|OFF)|[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|0x[\da-fA-F_]+|0o[0-7_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

// What a parser refuses in one value on its line, or null.
function valueProblem(key, v) {
  if (v.startsWith('"'))
    return DOUBLE.test(v)
      ? null
      : `${key}'s double-quoted value does not close on its line, or holds an escape YAML does not know`;
  if (v.startsWith("'")) return SINGLE.test(v) ? null : `${key}'s single-quoted value does not close on its line`;
  if (v.startsWith("[")) return /\]\s*(?:#.*)?$/.test(v) ? null : `${key}'s flow list does not close on its line`;
  if (v.startsWith("{")) return /\}\s*(?:#.*)?$/.test(v) ? null : `${key}'s flow mapping does not close on its line`;
  if (PLAIN_START.test(v)) return `${key}'s value starts with ${JSON.stringify(v[0])}, which YAML reads as syntax`;
  if (/:(?:\s|$)/.test(v.replace(/\s+#.*$/, "")))
    return `${key}'s plain value holds ": ", which YAML reads as a second key: quote the value`;
  return null;
}

// The front matter's problems, as [line, what]. It is read as the subset of
// YAML our files use: one `key: value` per line, the value plain, quoted or a
// flow collection closed on its line, or a block under its key — a block
// scalar (`|`, `>`), or an empty value with an indented list or mapping, whose
// entries are held to the same rules. A file with no front matter has none:
// the checklist warns of that, it does not block it.
export function frontMatterProblems(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  const lines = m[1].split(/\r?\n/);
  const content = (l) => l.trim() && !/^\s*#/.test(l);
  let open = null;
  for (const [i, line] of lines.entries()) {
    const at = i + 2;
    if (/^[ \t]/.test(line)) {
      if (!line.trim()) continue;
      if (!open) {
        if (content(line)) out.push([at, "an indented line under a key whose value is already on its line"]);
        continue;
      }
      if (open.block) {
        if (/^\t/.test(line)) out.push([at, "a tab in the indentation, which YAML refuses"]);
        continue;
      }
      if (!content(line)) continue;
      if (/^ *\t/.test(line)) out.push([at, "a tab in the indentation, which YAML refuses"]);
      else {
        const body = line.trim();
        const item = body.replace(/^-(?:\s+|$)/, "");
        const nk = /^([^\s:#"'][^:]*?):(?:\s+(.*))?$/.exec(item);
        if (open.key === "description" && open.first && (body !== item || nk))
          out.push([at, "description is a list or a mapping, not text"]);
        const problem = nk
          ? nk[2] && valueProblem(nk[1], nk[2].trim())
          : body !== item && item && valueProblem("a list item", item);
        if (problem) out.push([at, problem]);
      }
      open.first = false;
      continue;
    }
    open = null;
    if (!content(line)) continue;
    const kv = /^([^\s:#][^:]*?):(?:[ \t]+(.*))?$/.exec(line);
    if (!kv) {
      out.push([at, "a line that is not a key and its value"]);
      continue;
    }
    const key = kv[1].replace(/^(["'])(.*)\1$/, "$2");
    const v = (kv[2] || "").trim();
    if (seen.has(key)) out.push([at, `${key} is set twice`]);
    seen.add(key);
    if (!v || /^[|>][-+0-9]*(?:\s+#.*)?$/.test(v)) {
      open = { key, block: !!v, first: true };
      const next = lines.slice(i + 1).find(content);
      if (key === "description" && !v && !(next && /^[ \t]/.test(next))) out.push([at, "description has no value"]);
      continue;
    }
    const problem = valueProblem(key, v);
    if (problem) out.push([at, problem]);
    else if (key === "description" && /^[[{]/.test(v)) out.push([at, "description is a list or a mapping, not text"]);
    else if (key === "description" && NOT_TEXT.test(v.replace(/\s+#.*$/, "")))
      out.push([at, "description is a number, a boolean or null, not text"]);
  }
  return out;
}

// A URL in the tree, not on the web: no scheme, no `//`, no fragment alone.
const local = (u) => !!u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

const ROOT_README = /^readme(?:\.(?:md|markdown|txt|rst))?$/i;
const ROOT_LICENSE = /^licen[cs]e(?:\.(?:md|txt))?$/i;

export function check(entries) {
  const found = Object.fromEntries(ROWS.map((r) => [r.id, new Set()]));
  const add = (id, where, what) => found[id].add(say(id, where, what));
  const files = entries.filter((e) => e.kind === "file");
  const info = new Map(files.map((e) => [e.path, sniff(e.path, e.bytes)]));
  const textOf = new Map();
  for (const e of files) if (info.get(e.path).kind === "text") textOf.set(e.path, e.bytes.toString("utf8"));
  const text = (p) => textOf.get(p);
  const paths = allPaths(entries);
  const folders = paths.length - entries.length;
  const headroom = {};

  // Regular files only.
  for (const e of entries) {
    if (e.kind === "symlink") add("regular-files", e.path, "a symbolic link");
    else if (e.kind === "submodule") add("regular-files", e.path, "a Git submodule");
    else if (e.bytes.subarray(0, LFS.length).toString("latin1") === LFS)
      add("regular-files", e.path, "a Git LFS pointer file");
  }

  // System files, as any path segment.
  for (const p of paths)
    if (SYSTEM_FILES.has(base(p).toLowerCase())) add("system-files", p, "a macOS or Windows system file");

  // Names, per segment, and case-only pairs over every file and folder.
  const byKey = new Map();
  for (const p of paths) {
    const seg = base(p);
    const bad = BAD_CHAR.exec(seg);
    if (bad) add("names", p, `the name "${seg}" holds ${JSON.stringify(bad[0])}, which Windows refuses`);
    if (/[. ]$/.test(seg)) add("names", p, `the name "${seg}" ends in a ${seg.endsWith(".") ? "dot" : "space"}`);
    if (DEVICE.test(seg.split(".")[0].replace(/ +$/, "")))
      add("names", p, `the name "${seg}" is a Windows device name`);
    const key = p.normalize("NFC").toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  for (const same of byKey.values())
    if (same.length > 1) add("names", same.join(", "), "names that differ only by capitalization");

  // .gitattributes.
  for (const e of files.filter((f) => base(f.path) === ".gitattributes" && text(f.path) !== undefined))
    for (const [i, line] of text(e.path).split("\n").entries()) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      for (const tok of line.trim().split(/\s+/).slice(1)) {
        if (tok.startsWith("-") || tok.startsWith("!")) continue;
        const attr = tok.split("=")[0];
        if (ARCHIVE_ATTRS.has(attr)) add("gitattributes", `${e.path}:${i + 1}`, `sets ${attr}`);
        else if (REWRITE_ATTRS.has(attr))
          add("gitattributes", `${e.path}:${i + 1}`, `sets ${attr}, which rewrites file contents`);
      }
    }

  // The repository's size.
  const unpacked = files.reduce((s, e) => s + e.size, 0);
  const archive = unpacked + 512 * paths.length;
  if (archive >= LIMITS.archived)
    add(
      "repository-size",
      "the tree",
      `${n(unpacked)} bytes unpacked and ${n(paths.length)} entries bound the archive at ${n(archive)} bytes`,
    );
  if (unpacked >= LIMITS.unpacked) add("repository-size", "the tree", `${n(unpacked)} bytes unpacked`);
  if (paths.length >= LIMITS.entries) add("repository-size", "the tree", `${n(paths.length)} files and folders`);
  for (const e of files) if (e.size >= LIMITS.fileMax) add("repository-size", e.path, `${n(e.size)} bytes`);
  headroom["repository-size"] = {
    unpacked: { bytes: unpacked, limit: LIMITS.unpacked, left: LIMITS.unpacked - unpacked },
    archive: { bound: archive, limit: LIMITS.archived, left: LIMITS.archived - archive },
    entries: {
      count: paths.length,
      files: entries.length,
      folders,
      limit: LIMITS.entries,
      left: LIMITS.entries - paths.length,
    },
  };

  // The README.
  const readmes = files.filter((e) => !e.path.includes("/") && ROOT_README.test(e.path));
  const readme = readmes.find((e) => e.path === "README.md") ?? readmes[0];
  if (!readme) add("readme", "the plugin folder", "no README");
  else {
    const words = text(readme.path) === undefined ? 0 : proseWords(text(readme.path));
    if (words < LIMITS.readmeWords) add("readme", readme.path, `${words} words outside code blocks`);
    headroom.readme = { file: readme.path, words, limit: LIMITS.readmeWords, over: words - LIMITS.readmeWords };
  }

  // The license: a file, or the manifest's field.
  const licensed = files.some((e) => !e.path.includes("/") && ROOT_LICENSE.test(e.path));
  let declared = false;
  const manifest = text(".claude-plugin/plugin.json");
  if (manifest !== undefined)
    try {
      const l = JSON.parse(manifest).license;
      declared = typeof l === "string" && !!l.trim();
    } catch {}
  if (!licensed && !declared)
    add("license", "the plugin folder", "no LICENSE file, and no license in .claude-plugin/plugin.json");

  // The 256 KiB limit, for what is not an image or a font.
  const sized = files.filter((e) => !["image", "font"].includes(info.get(e.path).kind));
  for (const e of sized) if (e.size >= LIMITS.size) add("file-size", e.path, `${n(e.size)} bytes`);
  const largest = sized.filter((e) => e.size < LIMITS.size).sort((a, b) => b.size - a.size)[0];
  if (largest)
    headroom["file-size"] = {
      file: largest.path,
      bytes: largest.size,
      limit: LIMITS.size,
      left: LIMITS.size - largest.size,
    };

  // 512 files.
  if (entries.length > LIMITS.files) add("file-count", "the tree", `${n(entries.length)} files`);
  headroom["file-count"] = { files: entries.length, limit: LIMITS.files, left: LIMITS.files - entries.length };

  // Kinds.
  for (const e of files) {
    const s = info.get(e.path);
    if (s.kind === "binary")
      add("file-types", e.path, "a binary file that is not a PNG, JPEG, GIF or WebP image or a font");
    else if (s.kind === "image" && !s.complete) add("file-types", e.path, `an incomplete ${s.format} image`);
  }

  // The README's images: Markdown syntax for a bundled one.
  if (readme && text(readme.path) !== undefined) {
    const lines = [...markdownLines(text(readme.path))];
    const md = Array(text(readme.path).split("\n").length).fill("");
    for (const l of lines) if (!l.fenced) md[l.n - 1] = l.line;
    const prose = md.join("\n");
    const lineAt = (i) => prose.slice(0, i).split("\n").length;
    for (const m of prose.matchAll(/<(img|source)\b[^>]*>/gi)) {
      const urls = [];
      for (const a of m[0].matchAll(/\b(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const v = a[2] ?? a[3] ?? a[4] ?? "";
        if (a[1].toLowerCase() === "src") urls.push(v.trim());
        else for (const c of v.split(",")) urls.push(c.trim().split(/\s+/)[0]);
      }
      const bundled = urls.filter(local);
      if (bundled.length)
        add(
          "readme-images",
          `${readme.path}:${lineAt(m.index)}`,
          `HTML <${m[1].toLowerCase()}> shows ${bundled.join(", ")}`,
        );
    }
  }

  // Bundled images and fonts, named where the checklist holds them.
  const bundled = files.filter((e) => IMAGE_EXT.test(e.path) || FONT_EXT.test(e.path)).map((e) => e.path);
  const names = (s) => bundled.filter((b) => s.includes(b) || s.includes(base(b)));
  for (const [p, t] of textOf) {
    if (IMAGE_EXT.test(p)) continue;
    if (/^(?:commands|hooks|scripts)\//.test(p))
      for (const [i, line] of t.split("\n").entries())
        for (const b of names(line)) add("bundled-references", `${p}:${i + 1}`, `names ${b} from ${p.split("/")[0]}/`);
    if (MARKDOWN_EXT.test(p))
      for (const { line, n: at, fenced } of markdownLines(t)) {
        const spans = fenced ? [line] : [...line.matchAll(CODE_SPAN)].map((x) => x[2]);
        for (const s of spans)
          for (const b of names(s))
            add("bundled-references", `${p}:${at}`, `writes ${b} in ${fenced ? "a code block" : "backticks"}`);
      }
  }

  // Package sources.
  for (const [p, t] of textOf) {
    const rule = PACKAGE_SOURCES.find(([name]) => name.test(base(p)));
    if (!rule) continue;
    for (const [i, line] of t.split("\n").entries()) {
      if (/^\s*[#;]/.test(line)) continue;
      const m = rule[1].exec(line);
      if (m) add("package-source", `${p}:${i + 1}`, `sets ${m[1]}`);
    }
  }

  // Credentials: file and line, never the value.
  for (const [p, t] of textOf)
    for (const [line, shape] of credentialLines(t)) add("credentials", `${p}:${line}`, shape);

  // Front matter, in each agent, command and skill.
  for (const [p, t] of textOf)
    if (COMPONENT.test(p)) for (const [line, what] of frontMatterProblems(t)) add("front-matter", `${p}:${line}`, what);

  // Ours: the shipped .mjs files.
  const modules = files.filter((e) => e.shipped && e.path.endsWith(".mjs")).sort((a, b) => b.size - a.size);
  for (const e of modules)
    if (e.size > LIMITS.headroom) add("headroom", e.path, `${n(e.size)} bytes, ${n(e.size - LIMITS.headroom)} over`);
  const next = modules.find((e) => e.size <= LIMITS.headroom);
  headroom.headroom = {
    limit: LIMITS.headroom,
    why: "a shipped module is split long before the directory's 256 KiB",
    next: next ? { file: next.path, bytes: next.size, left: LIMITS.headroom - next.size } : null,
  };

  const rows = ROWS.map((r) => ({
    id: r.id,
    section: r.section,
    rule: r.rule,
    limit: r.limit,
    result: r.result,
    ok: found[r.id].size === 0,
    findings: [...found[r.id]].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
  }));
  const failed = rows.filter((r) => !r.ok).map((r) => r.id);
  return { ok: failed.length === 0, files: entries.length, failed, rows, headroom, checklist: CHECKLIST };
}

// ─── CLI ────────────────────────────────────────────────────────────────

export function main(argv, { root = ROOT, stdout = process.stdout } = {}) {
  let set = "packed";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--set") set = argv[++i];
    else if (argv[i].startsWith("--set=")) set = argv[i].slice("--set=".length);
    else {
      stdout.write(
        JSON.stringify({ ok: false, error: `unknown argument ${argv[i]}; usage: --set packed|repository` }) + "\n",
      );
      return 1;
    }
  }
  let report;
  try {
    report = { set, ...check(trackedSet(root, { set })) };
  } catch (e) {
    report = { ok: false, set, error: e.message };
  }
  stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

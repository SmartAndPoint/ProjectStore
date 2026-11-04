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
// per checklist rule, plus six of ours (the headroom, credential-variable and
// policy-hold rules below). Each finding names the file (and line, where there
// is one), the rule, its limit and the checklist's result for it. A credential
// finding names the file, the line and the key's shape, never its value.
//
// Our headroom rule: no shipped .mjs over 200 KiB (204,800 bytes), stricter
// than the directory's 256 KiB, so a module is split long before the limit
// where the checklist holds a version. "Shipped" is the packlist under either
// set: in the repository set the tests' own .mjs files are held to the
// directory's 256 KiB only. There is no exemption — the installer was split
// first (PS-DIRECTORY: "The installer is split into modules under 200 KiB
// each…"), and the report names the next file in line.
//
// Our credential-variable rule: no shipped file names the variables 0.30.6's
// model menu read a key and its base from, ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL, or the catalog fields that named them, key_env, base_env
// and key_header — comments and prose included, by file and line. The
// checklist holds a version that reads a credential already set in the
// user's environment and sends it ("Uses a credential from the user's
// machine"), and its scan reads the source, so a name left in a comment or an
// unused branch is a finding too (the 0.30.7 story, PS-DIRECTORY). Shipped
// files only, under either set: the tests that plant the names do not ship.
// The `credentials` row is a different rule: a key-shaped value, which Blocks.
//
// Our policy-hold rules: the patterns behind the nine holds the portal's
// Validate raised on the 0.30.7 `directory` tree (PS-DIRECTORY: "The portal's
// policy holds on the directory branch are fixed in 0.30.8 or kept with a
// reason, and CI fails on their patterns"). The portal does not publish its
// rules, so each row is what that report showed and no more: a row can pass
// while the portal still holds, and the portal's re-Validate stays the proof.
// - mod-policy-hooks: in each module hooks/hooks.json lists, a hook on
//   agent.spawn, config.set, agent.register, command.run or fs.write takes
//   plain parameters, and its event and next names are bound nowhere else in
//   the file but in other hooks' own parameter lists; the file never uses
//   `arguments`. Otherwise the scan cannot tell which event the hook passes
//   on, and holds it as one that may take a permission decision.
// - mod-write-paths: each fs.write in such a module spells its path as fixed
//   text, one leading ${…}/ for the project root, then literal folders, then a
//   file name whose only hole is the session id. A path the scan cannot read
//   may be a build, start-up or settings file.
// - credential-beside-url: a shipped .mjs or .tsx file that holds an http(s)
//   URL names no key, pin, pwd, token, secret or password, comments included,
//   and a shipped Markdown file that holds one has no $NAME or ${NAME} whose
//   name holds PWD, PASS, TOKEN, SECRET, KEY, PIN or AUTH. JSON is not read:
//   the portal did not report the manifests, which hold both. KEPT names the
//   files the row matches on purpose, each with the reason a reviewer
//   confirms; a kept file the row no longer matches fails, so the list cannot
//   outlive its reasons.
// - credential-read-phrase: no command, skill or agent and no hook file holds
//   "vault", white space, then "read": the scan read "<vault README" as a
//   secrets store's `vault read`.
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
// credential shapes, the credential variables' names and the git call.

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
// title its report shows. `ours` marks the six rules that are not the
// checklist's.
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
  {
    id: "credential-variables",
    section: "ours",
    ours: true,
    rule: "no shipped file names ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL, or the catalog fields key_env, base_env and key_header that named them, so the scan finds no key read from the user's environment (the checklist's hold: Uses a credential from the user's machine)",
    limit: "none of those names, comments included",
    result: "ours: npm run release:check and CI's test job fail",
  },
  {
    id: "mod-policy-hooks",
    section: "ours",
    ours: true,
    rule: "in each module hooks/hooks.json lists, a hook on agent.spawn, config.set, agent.register, command.run or fs.write takes plain parameters, its event and next names are bound nowhere else in the file but in other hooks' own parameter lists, and the file never uses arguments, so the scan reads the hook as passing its own event on (the portal's hold: MOD_ANSWERS_PERMISSION)",
    limit: "plain parameters, bound once",
    result: "ours: npm run release:check and CI's test job fail",
  },
  {
    id: "mod-write-paths",
    section: "ours",
    ours: true,
    rule: "each fs.write in a module hooks/hooks.json lists spells its path as fixed text: one leading ${…}/ for the project root, every folder as literal text, then a file name whose only ${…} hole is the session id (the portal's hold: MOD_WRITES_BUILD_FILE)",
    limit: "`${root}/<literal folders>/<file name, ${sid} at most>`",
    result: "ours: npm run release:check and CI's test job fail",
  },
  {
    id: "credential-beside-url",
    section: "ours",
    ours: true,
    rule: "a shipped .mjs or .tsx file that holds an http(s):// URL names no key, pin, pwd, token, secret or password as a word, comments included, and a shipped Markdown file that holds one has no $NAME or ${NAME} whose name holds PWD, PASS, TOKEN, SECRET, KEY, PIN or AUTH, but in a file KEPT names with its reason (the portal's hold: MCP_FORWARDS_CREDENTIAL_ENV)",
    limit: "no such name beside a URL, but in a kept file; no kept file the row no longer matches",
    result: "ours: npm run release:check and CI's test job fail",
  },
  {
    id: "credential-read-phrase",
    section: "ours",
    ours: true,
    rule: 'no command, skill or agent and no hook file hooks/hooks.json names holds "vault", white space, then "read", which the scan reads as a secrets store\'s read (the portal\'s hold: MCP_FORWARDS_CREDENTIAL_ENV, across surfaces)',
    limit: "no such phrase",
    result: "ours: npm run release:check and CI's test job fail",
  },
];

// The files the credential-beside-url row matches on purpose, each with the
// reason a reviewer confirms (the portal holds them, once per version).
export const KEPT = {
  "hooks/band.tsx":
    "its one URL is the SVG namespace of the Desktop progress bar's drawing, which the host draws as an image and never fetches; none of its three words is a credential: `token` is the hint's command token (/projectstore:bar off), `key` names the band's own state (an atom's key, a render's cache key) and `pin` is the pinned epic's id, read from the binding; the band starts no program and makes no request",
  "scripts/fetch-shell.mjs":
    "its one URL is npm's public registry, PUBLIC_REGISTRY, which is also DEFAULT_REGISTRY, the installer's registry read: one GET for the newest release that sends no credential; its `token` is a refusal's advice on where npm keeps the user's own registry token, which ProjectStore never reads; setup runs npm with the user's environment, so npm reads its own registry, proxy and login settings and fetches the Codex package from the registry the user's npm is set to, npm's own vendor's case",
};

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

// The names our credential-variable rule refuses in a shipped file: the two
// variables 0.30.6 read, and the catalog fields that named them.
const CREDENTIAL_VARIABLES = /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|key_env|base_env|key_header)\b/g;

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

// ─── Ours: the portal's policy holds ────────────────────────────────────

// The hook files hooks/hooks.json names: its modules (paths under hooks/) and
// the scripts its command hooks run (after ${CLAUDE_PLUGIN_ROOT}/), as paths
// in the plugin folder. None when it does not parse.
export function hookFiles(json) {
  let reg = null;
  try {
    reg = JSON.parse(json);
  } catch {}
  const modules = new Set();
  const scripts = new Set();
  for (const m of Array.isArray(reg?.modules) ? reg.modules : [])
    if (typeof m === "string") modules.add(posix.join("hooks", m));
  const events = reg?.hooks && typeof reg.hooks === "object" ? Object.values(reg.hooks) : [];
  for (const entries of events)
    for (const entry of Array.isArray(entries) ? entries : [])
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        const run = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/.exec(String(h?.command ?? ""));
        if (run) scripts.add(posix.normalize(run[1]));
      }
  return { modules: [...modules], scripts: [...scripts] };
}

// Where a `/` starts a regular expression rather than a division: after one
// of these characters, or one of these words. Not after `<` or `>`, so a
// closing JSX tag stays a tag.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%~^]/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw)$/;

// A module's code with its comments, and the text of its strings, templates
// and regular expressions, blanked: the same length and the same lines, so an
// offset still names its line. A template's ${…} holes stay code. It is read
// for names and nothing else, so a lexer this small is enough: JSX text is
// read as code, and a string does not run past its line.
export function codeOnly(src) {
  const out = src.split("");
  const blank = (at) => {
    if (out[at] !== "\n") out[at] = " ";
  };
  const holes = []; // the brace depth each open ${ was opened at
  let depth = 0;
  let last = -1; // the offset of the last code character
  let i = 0;
  // Template text, from just inside a backtick or a hole's closing brace to
  // the closing backtick or the next hole.
  const template = () => {
    while (i < src.length && src[i] !== "`" && !(src[i] === "$" && src[i + 1] === "{")) {
      if (src[i] === "\\") blank(i++);
      blank(i++);
    }
    if (src[i] === "$") {
      holes.push(depth);
      i += 2;
    } else i++;
    last = i - 1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
    } else if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") blank(i++);
        blank(i++);
      }
      last = i++;
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "}" && holes.length && holes[holes.length - 1] === depth) {
      holes.pop();
      i++;
      template();
    } else if (
      c === "/" &&
      (last < 0 || REGEX_AFTER.test(src[last]) || REGEX_AFTER_WORD.test(src.slice(Math.max(0, last - 7), last + 1)))
    ) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") blank(i++);
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        blank(i++);
      }
      last = i++;
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (!/\s/.test(c)) last = i;
      i++;
    }
  }
  return out.join("");
}

// The offset of the bracket that closes the one at `at`, or -1.
function closing(code, at) {
  const open = code[at];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let d = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === open) d++;
    else if (code[i] === close && --d === 0) return i;
  }
  return -1;
}

// A parameter list split at its top-level commas (a type's <…> included).
function splitParams(s) {
  const out = [];
  let d = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ("([{<".includes(c)) d++;
    else if (")]}".includes(c) || (c === ">" && s[i - 1] !== "=")) d--;
    else if (c === "," && d === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out.map((p) => p.trim()).filter(Boolean);
}

const lineAt = (text, at) => text.slice(0, at).split("\n").length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The events whose hooks can take a decision out of the user's hands (the
// portal's MOD_ANSWERS_PERMISSION hint names these five).
const POLICY_EVENTS = new Set(["agent.spawn", "config.set", "agent.register", "command.run", "fs.write"]);
// A plain parameter: a name, with a type at most.
const PLAIN_PARAM = /^([A-Za-z_$][\w$]*)\s*(?::[\s\S]*)?$/;
// Words that take a parenthesis and are not a function's name.
const NOT_A_NAME = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "await",
  "function",
  "new",
  "in",
  "of",
  "void",
  "delete",
  "yield",
  "do",
  "else",
  "case",
  "throw",
]);

// What may stand before a method's name: the start of a body or a member, or
// a modifier. A name after anything else (`?`, an operator) is a call.
const METHOD_LEAD = /(?:[{,;}*]|(?<![\w$.])(?:async|get|set|static|public|private|protected|readonly|override))\s*$/;
// A JSX tag up to an attribute's name: the tag's name, then attributes with
// no value, a quoted one or a one-level braced one.
const JSX_ATTRIBUTE_LEAD = /<[A-Za-z][\w.:-]*(?:\s+[\w$:-]+(?:=(?:"[^"]*"|'[^']*'|\{[^{}]*\}))?)*\s+$/;

// Whether `at` sits directly in a class body, where `name = …` is a field.
function inClassBody(code, at) {
  let d = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === "}") d++;
    else if (code[i] === "{") {
      if (d === 0) return /(?<![\w$.])class\b[^{};]*$/.test(code.slice(Math.max(0, i - 120), i));
      d--;
    }
  }
  return false;
}

// The hooks a module registers as on('<event>', [filter,] handler): each
// one's event, the offset of its opening quote, its line and parameters, and
// where its parameter list sits (`open`, `close`), in `code` (codeOnly's)
// with the event read from `src`.
export function hooksOf(src, code) {
  const out = [];
  for (const m of code.matchAll(/(?<![\w$.])on\s*\(\s*(['"])/g)) {
    const q = m.index + m[0].length - 1;
    const end = src.indexOf(src[q], q + 1);
    if (end < 0) continue;
    const event = src.slice(q + 1, end);
    let at = end + 1;
    const skip = () => {
      while (/\s/.test(code[at] ?? "")) at++;
    };
    const comma = () => {
      skip();
      if (code[at] !== ",") return false;
      at++;
      skip();
      return true;
    };
    if (!comma()) continue;
    if (code[at] === "{") {
      at = closing(code, at) + 1;
      if (!at || !comma()) continue;
    }
    at += /^(?:async\b\s*)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*\s*)?)?/.exec(code.slice(at))[0].length;
    const hook = { event, quote: q, line: lineAt(code, at), open: at };
    if (code[at] === "(") {
      const close = closing(code, at);
      if (close < 0) continue;
      out.push({ ...hook, close, params: splitParams(code.slice(at + 1, close)) });
    } else {
      const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(code.slice(at));
      if (single) out.push({ ...hook, close: at + single[1].length, params: [single[1]] });
    }
  }
  return out;
}

// Where `name` is bound in `code` outside the hooks' own parameter lists, as
// [offset, what]: declared, destructured into, taken as a parameter (a
// function's, an arrow's, a method's or a catch's), assigned or imported.
export function bindingsOf(code, name, hooks) {
  const w = `(?<![\\w$])${escapeRe(name)}(?![\\w$])`;
  const word = new RegExp(w);
  const inHead = (at) => hooks.some((h) => at >= h.open && at <= h.close);
  const out = [];
  const add = (at, what) => {
    if (!inHead(at)) out.push([at, what]);
  };
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var|class|function\\s*\\*?)\\s*${w}`, "g")))
    add(m.index, `declares ${name}`);
  for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s*([[{])/g)) {
    const open = m.index + m[0].length - 1;
    const hit = word.exec(code.slice(open, closing(code, open) + 1));
    if (hit) add(open + hit.index, `destructures into ${name}`);
  }
  for (let i = code.indexOf("("); i >= 0; i = code.indexOf("(", i + 1)) {
    if (hooks.some((h) => h.open === i)) continue;
    const close = closing(code, i);
    if (close < 0) continue;
    const before = code.slice(Math.max(0, i - 60), i);
    const after = code.slice(close + 1, close + 120);
    // The word just before the parenthesis, and what stands before it.
    const named = /(?<![\w$])([A-Za-z_$][\w$]*)\s*$/.exec(before);
    const lead = named ? before.slice(0, named.index) : before;
    const member = /\.\s*$/.test(lead);
    const keyword = named && !member && (NOT_A_NAME.has(named[1]) || named[1] === "async");
    // A call's arguments: after a name, a member, or a call's or an index's
    // result.
    const call = (named && !keyword) || /[)\]]\s*$/.test(before);
    const params =
      /(?<![\w$.])function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*$/.test(before) ||
      /(?<![\w$.])catch\s*$/.test(before) ||
      // An arrow's: never a call's; after `?`, only a bare `=>`, so a
      // ternary's `: x =>` is not read as a return type.
      (!call && (/^\s*=>/.test(after) || (!/\?\s*$/.test(before) && /^\s*:[^;{}()=]*=>/.test(after)))) ||
      // A method's: a name where a member starts, then its body.
      (named && !keyword && !member && METHOD_LEAD.test(lead) && /^\s*(?::[^;{}()=]*)?\{/.test(after));
    if (!params) continue;
    const hit = word.exec(code.slice(i + 1, close));
    if (hit) add(i + 1 + hit.index, `takes ${name} as a parameter`);
  }
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*=>`, "g")))
    add(m.index, `takes ${name} as a parameter`);
  // An assignment, but not a JSX attribute's value or a class field: each is
  // a property, not a binding.
  const assign = `(?<![\\w$.])(?<!(?:const|let|var)\\s+)${escapeRe(name)}\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`;
  for (const m of code.matchAll(new RegExp(assign, "g"))) {
    const attribute =
      /^\s*["'{]/.test(code.slice(m.index + m[0].length)) &&
      JSX_ATTRIBUTE_LEAD.test(code.slice(Math.max(0, m.index - 300), m.index));
    if (!attribute && !inClassBody(code, m.index)) add(m.index, `assigns ${name}`);
  }
  for (const m of code.matchAll(
    new RegExp(`(?:\\+\\+|--)\\s*${w}|(?<![\\w$.])${escapeRe(name)}\\s*(?:\\+\\+|--)`, "g"),
  ))
    add(m.index, `assigns ${name}`);
  // An import clause: a default name, then braces or a namespace (a module
  // may have no semicolons, so nothing wider than the clause is read).
  const clause =
    /(?<![\w$.])import\s+(?:type\s+)?((?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)?)\s*from\b/g;
  for (const m of code.matchAll(clause)) {
    const hit = word.exec(m[1]);
    if (hit) add(m.index + m[0].indexOf(m[1]) + hit.index, `imports ${name}`);
  }
  return out;
}

// What keeps a module's policy hook from reading as passing its own event
// on, as [line, what].
export function policyHookProblems(src) {
  const code = codeOnly(src);
  const hooks = hooksOf(src, code);
  const out = [];
  for (const m of code.matchAll(/(?<![\w$.])arguments(?![\w$])/g)) out.push([lineAt(code, m.index), "uses arguments"]);
  // A policy event named in a string no hook was read from: a hook the guard
  // cannot read fails the row, so the row never passes for want of a hook.
  const read = new Set(hooks.map((h) => h.quote));
  const named = new RegExp(`(['"\`])(${[...POLICY_EVENTS].map(escapeRe).join("|")})\\1`, "g");
  for (const m of src.matchAll(named))
    if (code[m.index] === m[1] && !read.has(m.index))
      out.push([
        lineAt(code, m.index),
        `names ${m[2]} where the guard reads no hook: register it as on('${m[2]}', ($, e, next) => …)`,
      ]);
  for (const h of hooks.filter((x) => POLICY_EVENTS.has(x.event))) {
    const plain = h.params.map((p) => PLAIN_PARAM.exec(p)?.[1] ?? null);
    for (const [k, p] of h.params.entries())
      if (!plain[k]) out.push([h.line, `the ${h.event} hook's parameter ${JSON.stringify(p)} is not a plain name`]);
    if (h.params.length < 3) {
      out.push([h.line, `the ${h.event} hook takes ${h.params.length} parameters, not ($, event, next)`]);
      continue;
    }
    for (const [role, name] of [
      ["event", plain[1]],
      ["next", plain[2]],
    ])
      if (name)
        for (const [at, what] of bindingsOf(code, name, hooks))
          out.push([lineAt(code, at), `${what}, the name the ${h.event} hook (line ${h.line}) gives its ${role}`]);
  }
  return out;
}

// A path of fixed text: one leading ${…}/ for the project root, every folder
// literal, then a file name whose only hole is the session id.
const SESSION_HOLE = /^\$\{\s*(?:sid|sessionId)\s*\}$/;
export function writePathProblem(path) {
  const root = /^\$\{[^{}]+\}\//.exec(path);
  if (!root) return "it does not start with one ${…}/ for the project root";
  const parts = path.slice(root[0].length).split("/");
  const name = parts.pop();
  for (const f of parts)
    if (!f || f === "." || f === ".." || /[$`{}]/.test(f)) return `the folder ${JSON.stringify(f)} is not literal text`;
  const holes = name.match(/\$\{[^{}]*\}/g) || [];
  if (holes.length > 1 || holes.some((h) => !SESSION_HOLE.test(h)) || /[`{}]/.test(name.replace(/\$\{[^{}]*\}/g, "")))
    return `the file name ${JSON.stringify(name)} holds a hole that is not the session id`;
  if (!name) return "it names no file";
  return null;
}

// Each fs.write in a module whose path is not fixed text, as [line, what].
export function writePathProblems(src) {
  const code = codeOnly(src);
  const out = [];
  for (const m of code.matchAll(/(?<![\w$])fs\s*\.\s*write\s*\(\s*/g)) {
    const at = m.index + m[0].length;
    const line = lineAt(code, m.index);
    if (src[at] !== "`") {
      const arg = src
        .slice(at)
        .split(/[,\n)]/)[0]
        .trim();
      out.push([line, `fs.write's path ${arg} is not a template of fixed text`]);
      continue;
    }
    const path = src.slice(at + 1, code.indexOf("`", at + 1));
    const why = writePathProblem(path);
    if (why) out.push([line, `fs.write's path \`${path}\` is not fixed text: ${why}`]);
  }
  return out;
}

// A URL a scan reads as a place to send to, and the names it reads beside
// one as a credential: in code, the word (comments included; `_` separates
// words, so API_KEY names KEY); in Markdown, a shell variable's name.
const WEB_URL = /\bhttps?:\/\/[^\s'"`<>()]+/;
const CREDENTIAL_WORDS = /(?<![A-Za-z0-9])(?:key|pin|pwd|token|secret|password)(?![A-Za-z0-9])/gi;
const SHELL_VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const CREDENTIAL_NAME = /PWD|PASS|TOKEN|SECRET|KEY|PIN|AUTH/;
const CODE_FILE = /\.(?:mjs|tsx)$/;

// A file's credential-shaped names beside its URL, as [line, what]: each
// name's first line. None when the file holds no URL, or is neither code nor
// Markdown.
export function besideUrl(path, text) {
  const url = WEB_URL.exec(text);
  if (!url || !(CODE_FILE.test(path) || MARKDOWN_EXT.test(path))) return [];
  const where = `line ${lineAt(text, url.index)} holds ${url[0]}`;
  const seen = new Map();
  if (CODE_FILE.test(path)) {
    for (const m of text.matchAll(CREDENTIAL_WORDS)) if (!seen.has(m[0])) seen.set(m[0], m.index);
    return [...seen].map(([w, at]) => [lineAt(text, at), `names ${w}, and ${where}`]);
  }
  for (const m of text.matchAll(SHELL_VARIABLE))
    if (CREDENTIAL_NAME.test(m[1]) && !seen.has(m[0])) seen.set(m[0], m.index);
  return [...seen].map(([v, at]) => [lineAt(text, at), `holds ${v}${v.startsWith("${") ? "}" : ""}, and ${where}`]);
}

// "vault", white space, "read": what the scan read as a secrets store's
// `vault read` in the review command's "<vault README excerpt>".
const VAULT_READ = /\bvault\s+read/gi;

// A URL in the tree, not on the web: no scheme, no `//`, no fragment alone.
const local = (u) => !!u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

const ROOT_README = /^readme(?:\.(?:md|markdown|txt|rst))?$/i;
const ROOT_LICENSE = /^licen[cs]e(?:\.(?:md|txt))?$/i;

// `kept` stands in for KEPT (a test's own list).
export function check(entries, { kept = KEPT } = {}) {
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

  // Ours: the credential variables, in the shipped text files, by file and line.
  for (const e of files.filter((f) => f.shipped && textOf.has(f.path)))
    for (const [i, line] of text(e.path).split("\n").entries())
      for (const name of new Set(line.match(CREDENTIAL_VARIABLES) || []))
        add("credential-variables", `${e.path}:${i + 1}`, `names ${name}`);

  // Ours: the portal's policy holds, in the shipped text files.
  const shipped = new Map(files.filter((f) => f.shipped && textOf.has(f.path)).map((f) => [f.path, text(f.path)]));
  const hooked = shipped.has("hooks/hooks.json") ? hookFiles(shipped.get("hooks/hooks.json")) : null;
  for (const p of hooked?.modules ?? []) {
    if (!shipped.has(p)) continue;
    for (const [line, what] of policyHookProblems(shipped.get(p))) add("mod-policy-hooks", `${p}:${line}`, what);
    for (const [line, what] of writePathProblems(shipped.get(p))) add("mod-write-paths", `${p}:${line}`, what);
  }
  const matched = new Set();
  for (const [p, t] of shipped) {
    const hits = besideUrl(p, t);
    if (hits.length) matched.add(p);
    if (!Object.hasOwn(kept, p)) for (const [line, what] of hits) add("credential-beside-url", `${p}:${line}`, what);
  }
  for (const p of Object.keys(kept))
    if (shipped.has(p) && !matched.has(p))
      add("credential-beside-url", p, `is kept (${kept[p]}), but the row no longer matches it: take it out of KEPT`);
  const hookFile = new Set([...(hooked?.modules ?? []), ...(hooked?.scripts ?? [])]);
  for (const [p, t] of shipped)
    if (COMPONENT.test(p) || hookFile.has(p))
      for (const m of t.matchAll(VAULT_READ))
        add("credential-read-phrase", `${p}:${lineAt(t, m.index)}`, `holds "${m[0].replace(/\s+/g, " ")}"`);

  const rows = ROWS.map((r) => ({
    id: r.id,
    section: r.section,
    rule: r.rule,
    limit: r.limit,
    result: r.result,
    ok: found[r.id].size === 0,
    findings: [...found[r.id]].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    // The holds a reviewer confirms: each kept file the row matches, and why.
    ...(r.id === "credential-beside-url"
      ? {
          kept: Object.keys(kept)
            .filter((p) => matched.has(p))
            .map((p) => `${p}: ${kept[p]}`),
        }
      : {}),
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

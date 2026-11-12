// projectstore — write-record.mjs
//
// A session's record of its own vault writes: the spec "A session's record of
// its own vault writes: the hook, the plugin's writers and the close bracket"
// (alias writerecord). Its one reader is the pre-commit check (precommit.mjs).
//
// The record is `<project>/.projectstore/state/sessions/<session_id>.writes/`:
//
//   <13-digit ms>-<pid>-<random>.json   one event per write: the time, the
//                                       tool, the agent, the vault copy's
//                                       real root, the vault-relative path,
//                                       and the content hashes before and
//                                       after (null for an absent file)
//   blobs/<sha256>                      each content once, by hash
//   pending-call-<key>.json             the hook's snapshot, PreToolUse to
//                                       PostToolUse of one call
//   pending-copy-<key>.json             `session snapshot`'s, for a copy
//                                       no hook sees
//
// An event is an exclusively created file and is never rewritten, so two
// subagents of one session writing at once each add their own (contract 1);
// nothing here goes through writeSessionState, the unlocked read-modify-write
// the entry-rule state avoids. Each event is created in the directory itself,
// which advances its mtime: the session-start reap reads that (contract 2).
// A content over 512 KiB, and any content once the stored contents pass
// 64 MiB, keeps its hash and not its bytes.
//
// Nothing is recorded unless the speaking harness's manifest declares
// runtime.session_id_env (only there can the check find the record), and a
// failure here never fails a write: every entry point swallows its errors.
//
// Imports lib.mjs and harness.mjs only and starts no process, so the hook's
// closure gains no module that runs git.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stateDir, ensureStateDir, createFileExclusive, writeFileAtomic, vaultLocation, readConfigAt } from "./lib.mjs";
import { speakingHarness, hostSessionId, projectRoot as harnessProjectRoot } from "./harness.mjs";

export const RECORD_FILE_CAP = 512 * 1024;
export const RECORD_TOTAL_CAP = 64 * 1024 * 1024;
const EVENT_RE = /^\d{13}-\d+-[0-9a-f]+\.json$/;

// The gate (contract 1): the speaking harness names a session-id variable.
export function recordingOn(env = process.env) {
  return Boolean(speakingHarness(env)?.runtime?.session_id_env);
}

// The session id the record is kept under: the speaking harness's, the one
// the gate reads, or null where it declares none.
export function recordSessionId(env = process.env) {
  return hostSessionId(env, speakingHarness(env));
}

export function recordDir(project, sid) {
  return join(stateDir(project), `${sid}.writes`);
}

export function hashOf(bytes) {
  return bytes === null || bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
}

const toBytes = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8"));

// A file's bytes, or null when it is absent. Any other failure throws: a read
// that cannot answer is not "absent".
export function readFileBytes(abs) {
  try {
    return readFileSync(abs);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

// The copy's root as the record spells it: realpath'd, so two spellings of
// one folder (/var and /private/var, a symlink) are one root.
export function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function openDir(project, sid) {
  ensureStateDir(project);
  const dir = recordDir(project, sid);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  return dir;
}

const SIZE_CACHE = "blobs.size.json";

// The stored contents' total, measured: {count, bytes} over the blobs listed.
function measure(dir, names) {
  let bytes = 0;
  let count = 0;
  for (const n of names) {
    try {
      bytes += statSync(join(dir, "blobs", n)).size;
      count++;
    } catch {}
  }
  const m = { count, bytes };
  try {
    writeFileAtomic(join(dir, SIZE_CACHE), JSON.stringify(m), { sweep: false });
  } catch {}
  return m;
}

// Whether `size` more bytes stay within the total cap. Blobs are only ever
// added and none is over the file cap, so `count` blobs hold at most count ×
// fileCap: while that bound holds, nothing is measured (128 × 512 KiB is the
// 64 MiB cap exactly). Past it, the last measurement plus fileCap for every
// blob added since bounds the total, and only a bound that would pass the cap
// is measured again — not every write, which made a long session's writes
// O(N²) in its blobs.
function withinTotal(dir, size, { file, total }) {
  let names;
  try {
    names = readdirSync(join(dir, "blobs"));
  } catch {
    names = [];
  }
  if ((names.length + 1) * file <= total) return true;
  let last = null;
  try {
    last = JSON.parse(readFileSync(join(dir, SIZE_CACHE), "utf8"));
  } catch {}
  if (last && Number.isFinite(last.count) && Number.isFinite(last.bytes)) {
    const bound = last.bytes + Math.max(0, names.length - last.count) * file;
    if (bound + size <= total) return true;
  }
  return measure(dir, names).bytes + size <= total;
}

// Stores a content once, by hash, unless a cap says no; returns its hash.
// `caps` is for tests at the boundary.
export function storeBlob(dir, bytes, caps = { file: RECORD_FILE_CAP, total: RECORD_TOTAL_CAP }) {
  const h = hashOf(bytes);
  if (h === null || bytes.length > caps.file) return h;
  const p = join(dir, "blobs", h);
  if (existsSync(p)) return h;
  if (!withinTotal(dir, bytes.length, caps)) return h;
  createFileExclusive(p, bytes);
  return h;
}

function appendEvent(dir, event) {
  const name = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}.json`;
  const body = JSON.stringify({ v: 1, at: new Date().toISOString(), ...event }) + "\n";
  if (!createFileExclusive(join(dir, name), body)) throw new Error(`event ${name} exists`);
}

const pendingName = (kind, key, root, rel) =>
  `pending-${kind}-${createHash("sha256").update(`${key}\0${root}\0${rel}`).digest("hex").slice(0, 40)}.json`;

function readPending(dir, name) {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

function dropPending(dir, name) {
  try {
    unlinkSync(join(dir, name));
  } catch {}
}

// The session's events, any order; [] when there is no record. Read-only: the
// check lists the record and writes nothing to it (check spec, contract 6).
export function readEvents(project, sid) {
  const dir = recordDir(project, sid);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!EVENT_RE.test(n)) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (e && typeof e.root === "string" && typeof e.rel === "string") out.push(e);
    } catch {}
  }
  return out;
}

export function hasRecord(project, sid) {
  return Boolean(sid) && existsSync(recordDir(project, sid));
}

// A stored content by hash, or null when it was not kept.
export function readBlob(project, sid, hash) {
  if (!hash) return null;
  try {
    return readFileSync(join(recordDir(project, sid), "blobs", hash));
  } catch {
    return null;
  }
}

// ─── The hook (contracts 3 and 4) ──────────────────────────────────────

// PreToolUse of a write tool on a vault file: the file as it is, keyed by the
// call's tool_use_id and the path. No id, no snapshot.
export function snapshotForCall(project, sid, { callId, root, rel, abs }) {
  if (!callId || !sid) return false;
  const dir = openDir(project, sid);
  const r = realRoot(root);
  const before = readFileBytes(abs);
  const h = before === null ? null : storeBlob(dir, before);
  writeFileAtomic(
    join(dir, pendingName("call", callId, r, rel)),
    JSON.stringify({ root: r, rel, before: h, at: new Date().toISOString() }),
    { sweep: false },
  );
  return true;
}

// PostToolUse of that call: one event from the snapshot to the file as it is
// now, and the snapshot removed. No snapshot for this call and path, no event.
export function recordForCall(project, sid, { callId, root, rel, abs, tool, agent = null }) {
  if (!callId || !sid) return false;
  const dir = recordDir(project, sid);
  const r = realRoot(root);
  const name = pendingName("call", callId, r, rel);
  const snap = readPending(dir, name);
  if (!snap) return false;
  try {
    const after = readFileBytes(abs);
    const h = after === null ? null : storeBlob(dir, after);
    appendEvent(dir, { tool, agent, root: r, rel, before: snap.before ?? null, after: h });
  } finally {
    dropPending(dir, name);
  }
  return true;
}

// ─── The plugin's node writers (contract 5) ────────────────────────────

// One event from what a writer read to what it wrote. The session is the
// host's, the project the one the writer resolves; with no session id, or a
// path outside every copy of the vault, nothing. Never throws.
export function recordNodeWrite({ env = process.env, project = null, cfg = null, path, before, after, tool }) {
  try {
    if (!recordingOn(env)) return false;
    // The id from the same harness the gate read, so the two cannot disagree.
    const sid = recordSessionId(env);
    if (!sid) return false;
    const proj = project || harnessProjectRoot(env);
    const c = cfg || readConfigAt(proj);
    if (!c || !c.vault_path) return false;
    const loc = vaultLocation(resolve(path), c.vault_path);
    if (!loc || !loc.rel) return false;
    const dir = openDir(proj, sid);
    const b = toBytes(before);
    const a = toBytes(after);
    if (b !== null) storeBlob(dir, b);
    if (a !== null) storeBlob(dir, a);
    appendEvent(dir, {
      tool,
      agent: null,
      root: realRoot(loc.root),
      rel: loc.rel,
      before: hashOf(b),
      after: hashOf(a),
    });
    return true;
  } catch {
    return false;
  }
}

// The callback a writer's seam takes: (path, before, after).
export function nodeWriteRecorder({ env = process.env, project = null, tool }) {
  return (path, before, after) => recordNodeWrite({ env, project, path, before, after, tool });
}

// ─── The bracket around a copy no hook sees (contract 6) ───────────────

// Where a path names a vault file: {root, rel, abs} or null (outside every
// copy). A relative path is taken against the bound vault.
export function placeInVault(vaultPath, path) {
  const abs = resolve(vaultPath, path);
  const loc = vaultLocation(abs, vaultPath);
  if (!loc || !loc.rel) return null;
  return { root: loc.root, rel: loc.rel, abs };
}

// `session snapshot <path> --for <scratch>`: the vault file's content (absent
// for a file not yet there) as the pending snapshot for that path, with the
// hash of the scratch it is taken for. A later snapshot replaces an earlier.
export function takeCopySnapshot(project, sid, { root, rel, abs, scratch }) {
  const forBytes = readFileBytes(scratch);
  if (forBytes === null) return { recorded: false, reason: "scratch-missing" };
  const dir = openDir(project, sid);
  const r = realRoot(root);
  const before = readFileBytes(abs);
  const h = before === null ? null : storeBlob(dir, before);
  writeFileAtomic(
    join(dir, pendingName("copy", "snapshot", r, rel)),
    JSON.stringify({ root: r, rel, before: h, for: hashOf(forBytes), at: new Date().toISOString() }),
    { sweep: false },
  );
  return { recorded: true, before: h };
}

// `session record <path> --from <scratch>`: one event from that snapshot to
// the scratch, only when the snapshot was taken for this scratch, the vault
// file is the scratch, and no event of the session already ends at the file.
// The snapshot is removed on every exit. Returns {recorded, reason}.
export function recordCopy(project, sid, { root, rel, abs, scratch, tool = "session record" }) {
  const dir = recordDir(project, sid);
  const r = realRoot(root);
  const name = pendingName("copy", "snapshot", r, rel);
  const snap = readPending(dir, name);
  if (!snap) return { recorded: false, reason: "no-snapshot" };
  try {
    const from = readFileBytes(scratch);
    if (from === null) return { recorded: false, reason: "scratch-missing" };
    const fromHash = hashOf(from);
    if (snap.for !== fromHash) return { recorded: false, reason: "snapshot-for-other-content" };
    const now = readFileBytes(abs);
    if (hashOf(now) !== fromHash) return { recorded: false, reason: "file-differs-from-scratch" };
    if (readEvents(project, sid).some((e) => e.root === r && e.rel === rel && e.after === fromHash))
      return { recorded: false, reason: "already-recorded" };
    storeBlob(dir, from);
    appendEvent(dir, { tool, agent: null, root: r, rel, before: snap.before ?? null, after: fromHash });
    return { recorded: true, before: snap.before ?? null, after: fromHash };
  } finally {
    dropPending(dir, name);
  }
}

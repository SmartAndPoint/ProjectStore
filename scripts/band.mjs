// projectstore — band.mjs: the `band` verb, the one writer of the binding's
// `band` keys, and the reader that says why the band is or is not drawing.
//
// The band above the prompt is a Claude Code hooks module (hooks/band.tsx);
// it only READS the binding. Everything that changes what it shows — on, off,
// a pinned epic, the hint's memory — is written here, atomically, so the one
// file every hook reads is never torn (a torn binding reads as "not bound").
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield, contract 13.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, loadLayout, folderByKind, sessionStatePath, stateDir } from "./lib.mjs";
import { configPath as harnessConfigPath, activeHarness, hasBand, hostSessionId } from "./harness.mjs";
import { heartbeatFile, heartbeatState, isEpicName } from "./band-shared.mjs";

export const SUBCOMMANDS = Object.freeze(["on", "off", "status", "epic"]);

// The band keys as the module reads them: absent `enabled` means on.
export function bandKeys(cfg) {
  const b = cfg && cfg.band && typeof cfg.band === "object" ? cfg.band : {};
  return {
    enabled: b.enabled !== false,
    epic: typeof b.epic === "string" && b.epic ? b.epic : null,
    hint_seen: b.hint_seen === true,
  };
}

// The epic folders of the bound vault, as the board lists them.
export function epicIds(cfg, root) {
  if (!cfg || !cfg.vault_path) return [];
  let folder;
  try {
    folder = folderByKind(loadLayout(cfg.layout || "engineering", root), "epic");
  } catch {
    folder = null;
  }
  if (!folder) return [];
  const dir = join(cfg.vault_path, folder.path);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      if (!isEpicName(n)) return false;
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readBinding(path) {
  if (!existsSync(path)) return { raw: null, corrupt: false };
  try {
    return { raw: JSON.parse(readFileSync(path, "utf8")), corrupt: false };
  } catch {
    return { raw: null, corrupt: true };
  }
}

// What a write would do: the binding's path, its band keys before and after,
// and whether anything changes. Refusals carry a code and a message; a
// refused plan writes nothing.
export function planBand(projectDir, sub, arg, { env = process.env, root } = {}) {
  const path = harnessConfigPath(projectDir, env);
  const { raw, corrupt } = readBinding(path);
  if (corrupt)
    return {
      path,
      refusal: {
        code: "UNREADABLE",
        message: `${path} is not valid JSON — fix or remove it first; nothing is written`,
      },
    };
  // A bare `{ band: {} }` file would read as a binding: never create one.
  if (!raw)
    return {
      path,
      refusal: { code: "UNBOUND", message: `${projectDir} is not bound to a vault; there is no band to switch` },
    };
  const before = bandKeys(raw);
  const next = { ...(raw.band && typeof raw.band === "object" ? raw.band : {}) };
  if (sub === "on") next.enabled = true;
  else if (sub === "off") next.enabled = false;
  else if (sub === "epic" && arg) {
    const ids = epicIds(raw, root);
    const hit = ids.find((id) => id.toLowerCase() === String(arg).toLowerCase());
    if (!hit)
      return {
        path,
        refusal: {
          code: "UNKNOWN_EPIC",
          message: `no epic ${arg}${ids.length ? ` — epics: ${ids.join(", ")}` : " — the vault has no epics"}`,
        },
      };
    next.epic = hit;
  } else if (sub === "epic") delete next.epic;
  else return { path, refusal: { code: "USAGE", message: `band takes ${SUBCOMMANDS.join(", ")}` } };
  // Every write remembers that the person has used the command: the hint goes.
  next.hint_seen = true;
  const after = { ...raw, band: next };
  const changed = JSON.stringify(raw.band ?? null) !== JSON.stringify(next);
  return { path, before, after: bandKeys(after), changed, content: JSON.stringify(after, null, 2) + "\n" };
}

export function applyBand(plan) {
  if (plan.refusal || !plan.changed) return { wrote: false };
  writeFileAtomic(plan.path, plan.content);
  return { wrote: true };
}

const REASONS = Object.freeze({
  harness: "this harness has no band",
  off: "switched off (projectstore band on)",
  session_unknown:
    "this session is unknown here (no session id from the host), so neither its epic nor its heartbeat can be read",
  pin_missing: "the pinned epic no longer exists",
  no_epic: "this session has no epic, and none is pinned",
  not_drawing:
    "the module is not drawing (modules switched off by the host, an older Claude Code, or a crashed module)",
});

// Why the band is or is not drawing in this session, read-only. The session
// comes from the host's variable; without it the session is unknown and the
// pointer and heartbeat cannot be read.
export function bandStatus(projectDir, cfg, { env = process.env, now = Date.now(), root } = {}) {
  const harness = activeHarness(env);
  const keys = bandKeys(cfg);
  const sessionId = hostSessionId(env, harness);
  let sessionEpic = null;
  let heartbeat = "none";
  if (sessionId) {
    try {
      const p = JSON.parse(readFileSync(sessionStatePath(projectDir, sessionId), "utf8"));
      if (p && isEpicName(p.active_epic)) sessionEpic = p.active_epic;
    } catch {}
    const name = heartbeatFile(sessionId);
    if (name) {
      try {
        heartbeat = heartbeatState(JSON.parse(readFileSync(join(stateDir(projectDir), name), "utf8")), now);
      } catch {
        heartbeat = "none";
      }
    }
  }
  const ids = epicIds(cfg, root);
  const pinExists = keys.epic ? ids.includes(keys.epic) : null;
  const drawing = heartbeat === "drawing";
  let reason = null;
  if (!drawing) {
    if (!hasBand(harness)) reason = "harness";
    else if (!keys.enabled) reason = "off";
    else if (!sessionId) reason = "session_unknown";
    else if (!sessionEpic && keys.epic && !pinExists) reason = "pin_missing";
    else if (!sessionEpic && !keys.epic) reason = "no_epic";
    else reason = "not_drawing";
  }
  return {
    harness: harness?.id ?? null,
    enabled: keys.enabled,
    pin: keys.epic,
    pin_exists: pinExists,
    session_id: sessionId,
    session_epic: sessionEpic,
    heartbeat,
    drawing,
    yielding: drawing,
    reason,
    reason_text: reason ? REASONS[reason] : null,
  };
}

export function renderBandStatus(s) {
  const lines = [
    `band: ${s.enabled ? "on" : "off"}${s.pin ? ` · pinned ${s.pin}${s.pin_exists ? "" : " (missing)"}` : ""}`,
    `session: ${s.session_id ? `${s.session_id.slice(0, 8)}… · ${s.session_epic ? `epic ${s.session_epic}` : "no epic of its own"}` : "session unknown"}`,
    `heartbeat: ${s.heartbeat} · the status line ${s.yielding ? "is giving way to the band" : "shows its own line"}`,
  ];
  if (s.reason_text) lines.push(`not drawing: ${s.reason_text}`);
  return lines.join("\n") + "\n";
}

export function renderBandPlan(plan, sub, arg) {
  const what =
    sub === "on"
      ? "switch the band on"
      : sub === "off"
        ? "switch the band off"
        : arg
          ? `pin the band to ${plan.after.epic}`
          : "release the pinned epic";
  return (
    [
      `band ${sub}${arg ? ` ${arg}` : ""} — ${plan.path}`,
      `  ${what}`,
      `  enabled: ${plan.before.enabled ? "on" : "off"} → ${plan.after.enabled ? "on" : "off"}`,
      `  pinned: ${plan.before.epic || "—"} → ${plan.after.epic || "—"}`,
    ].join("\n") + "\n"
  );
}

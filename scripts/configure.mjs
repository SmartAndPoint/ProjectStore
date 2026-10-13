// projectstore configure — the way back to a project's settings after setup
// (the spec "Changing a project's settings after setup: the configure verb,
// its setting set and one writer per key"). It reads the settings from the
// three places they live — the binding, the harness overlays, the vault's
// config — shows them, and changes the ones named through each key's one
// writer: one PLAN, one confirmation, APPLY, DONE. It never registers,
// fetches or moves the layout, so nothing it does defers inside a session
// (contract 10), and it calls the planners directly, never runVerb.
import { existsSync, readFileSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import * as term from "./term.mjs";
import {
  loadHarness,
  harnessIds,
  detectHarnesses,
  hasBand,
  hasStatusLine,
  configPath as bindingPathOf,
  packageCommand,
} from "./harness.mjs";
import {
  readOverlayAt,
  resolveAgentModel,
  layoutRoster,
  readVaultConfigStrict,
  nextVaultConfig,
  writeVaultConfig,
  vaultConfigPath,
  fromTerminalIn,
  commandForm,
} from "./lib.mjs";
import { planBindingKeys, applyBindingKeys, languageNames } from "./binding.mjs";
import { bandKeys, epicIds, planBand, applyBand } from "./band.mjs";
import { planAgentsChange, applyAgentsChange } from "./agents-change.mjs";
import { plan as planInstall, apply as applyInstall, planOptions, isInteractive } from "./install-harness.mjs";
import { analyseLayout } from "./surfaces.mjs";
import { knownModels, offListNote } from "./models.mjs";
import { runMenu } from "./configure-menu.mjs";
import { SMALLEST } from "./menu.mjs";

const CLEAR = "-";

const LANGUAGE_NOTE =
  "new artifacts, the derived views on their next reconcile, the plan and close sections of stories still in flight, the session header and the status line take the new language; existing artifacts and the vault's READMEs are untouched";
const STAMP_NOTE = "stories closed before now are exempt from the spec and lifecycle gates";

const parseBool = (v) => {
  const s = String(v).trim().toLowerCase();
  if (s === "on" || s === "true") return true;
  if (s === "off" || s === "false") return false;
  return null;
};
const onOff = (b) => (b === true ? "on" : b === false ? "off" : "not set");
const shown = (v) =>
  v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") || "—" : String(v);
const tildeOf = (p, home) =>
  home && (p === home || String(p).startsWith(home + "/")) ? "~" + String(p).slice(home.length) : String(p);

// ─── The facts ─────────────────────────────────────────────────────────

// What the project holds: the binding (absent and corrupt are different
// answers — exit 3 and exit 1, contract 11), the harnesses it uses, the
// vault and its config, the roster and the languages.
export function readFacts(project, { env = process.env, root, home = homedir() } = {}) {
  const path = bindingPathOf(project, env);
  if (!existsSync(path)) return { unbound: true, path };
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { corrupt: true, path };
  const used = detectHarnesses(project, { state: true }).map((d) => loadHarness(d.id));
  const vault = typeof cfg.vault_path === "string" && cfg.vault_path ? cfg.vault_path : null;
  const vaultExists = Boolean(vault && existsSync(vault));
  return {
    project,
    home,
    path,
    cfg,
    used,
    vault,
    vaultExists,
    vaultCfg: vaultExists ? readVaultConfigStrict(vault) : null,
    roster: layoutRoster(cfg, root),
    languages: languageNames(root),
    epics: epicIds(cfg, root),
    slot: used.find(hasStatusLine) || null,
    band: used.find(hasBand) || null,
  };
}

// A path as the view prints it: inside the project relative to it, else
// absolute with the home as ~.
function where(f, p) {
  const rel = relative(f.project, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : tildeOf(p, f.home);
}

// ─── The setting set (contract 2) ──────────────────────────────────────

// Every shown setting, in the view's groups. `rail` is the select a terminal
// answers it with (null: --set only); `writer` names its one writer.
export function settingsOf(f) {
  const out = [];
  const binding = where(f, f.path);
  for (const h of f.used) {
    const o = readOverlayAt(f.project, h.id);
    const file = where(f, o.path);
    const base = { group: `agents:${h.id}`, harness: h.id, file, class: "changeable", team: true, writer: "overlay" };
    out.push({
      ...base,
      key: "agents.default",
      value: o.agents.default || null,
      source: o.unparseable ? "unparseable" : o.agents.default ? "overlay" : "frontmatter",
      rail: "model",
    });
    const names = [...new Set([...(f.roster || []), ...Object.keys(o.agents.per_agent)])];
    for (const n of names) {
      const r = resolveAgentModel(f.project, n, { harness: h.id });
      out.push({
        ...base,
        key: `agents.${n}`,
        value: r.model,
        source: o.unparseable ? "unparseable" : r.source || "frontmatter",
        rail: "model",
      });
    }
  }
  if (f.slot)
    out.push({
      group: "surfaces",
      key: "statusline",
      value: onOff(typeof f.cfg.statusline?.enabled === "boolean" ? f.cfg.statusline.enabled : null),
      source: typeof f.cfg.statusline?.enabled === "boolean" ? "binding" : "default",
      file: binding,
      class: "changeable",
      team: false,
      writer: "statusline",
      rail: "bool",
    });
  if (f.band) {
    const b = bandKeys(f.cfg);
    const set = f.cfg.band && typeof f.cfg.band === "object";
    out.push(
      {
        group: "surfaces",
        key: "band",
        value: onOff(b.enabled),
        source: set && typeof f.cfg.band.enabled === "boolean" ? "binding" : "default",
        file: binding,
        class: "changeable",
        team: false,
        writer: "band",
        rail: "bool",
      },
      {
        group: "surfaces",
        key: "band.epic",
        value: b.epic,
        source: b.epic ? "binding" : "default",
        file: binding,
        class: "changeable",
        team: false,
        writer: "band",
        rail: f.epics.length ? "epic" : null,
      },
    );
  }
  const plain = (key, value, rail, dflt) => ({
    group: "vault",
    key,
    value,
    source: Object.hasOwn(f.cfg, key) ? "binding" : "default",
    file: binding,
    class: "changeable",
    team: false,
    writer: "binding",
    rail,
    dflt,
  });
  out.push(
    {
      group: "vault",
      key: "vault",
      value: f.vault ? tildeOf(f.vault, f.home) : null,
      source: "binding",
      file: binding,
      class: "other-verb",
      team: false,
      writer: null,
      rail: null,
    },
    {
      group: "vault",
      key: "layout",
      value: f.cfg.layout || null,
      source: "binding",
      file: binding,
      class: "other-verb",
      team: false,
      writer: null,
      rail: null,
    },
    plain("language", f.cfg.language || "en", "language"),
    plain("active_skills", onOff(f.cfg.active_skills !== false), "bool"),
    plain("auto_inject", onOff(f.cfg.auto_inject !== false), "bool"),
    plain("default_author", f.cfg.default_author || null, null),
    plain("tags", Array.isArray(f.cfg.tags) ? f.cfg.tags : [], null),
  );
  if (f.vault) {
    const v = f.vaultCfg && !f.vaultCfg.corrupt ? f.vaultCfg.cfg : {};
    const file = tildeOf(vaultConfigPath(f.vault), f.home);
    const pol = (key, value, rail) => ({
      group: "policy",
      key,
      value,
      source: f.vaultCfg?.corrupt ? "unparseable" : Object.hasOwn(v, key) ? "vault_config" : "default",
      file,
      class: "changeable",
      team: true,
      writer: "vault",
      rail,
    });
    out.push(
      pol("spec_policy", v.spec_policy || "optional", "policy"),
      pol("lifecycle_gates", Object.hasOwn(v, "lifecycle_gates") ? String(v.lifecycle_gates) : "not set", "bool"),
    );
  }
  for (const s of out) s.set = setForm(s, f);
  return out;
}

// The --set form a key is changed with, for the view and the envelope.
function setForm(s, f) {
  if (s.class !== "changeable") return null;
  const value =
    s.rail === "bool"
      ? "on|off"
      : s.key === "tags"
        ? "<a,b>"
        : s.key.startsWith("agents.")
          ? "<model>"
          : s.key === "band.epic"
            ? "<epic>"
            : `<${s.key}>`;
  const h = s.harness && f.used.length > 1 ? ` --harness ${s.harness}` : "";
  return `--set ${s.key}=${value}${h}`;
}

// ─── Reading --set (contract 11's usage class) ─────────────────────────

// Each named change resolved against the set: its key, its harness (for an
// agents key), its value as the writer takes it. The first problem is a
// usage error (exit 2), and nothing is planned.
export function resolveSets(f, sets, { harness = null, nearest = null } = {}) {
  const seen = new Set();
  const out = [];
  const keys = settingsOf(f);
  const known = [...new Set(keys.map((s) => s.key))];
  const harnessesNamed = f.used.map((h) => h.display_name || h.id).join(", ") || "none";
  for (const raw of sets) {
    const at = String(raw).indexOf("=");
    if (at < 1) return { usage: `--set takes <key>=<value>, got ${raw}` };
    let key = String(raw).slice(0, at).trim();
    const value = String(raw)
      .slice(at + 1)
      .trim();
    const m = /^agents\.([a-z][a-z0-9-]*)(?:\.model)?$/.exec(key);
    if (m) key = `agents.${m[1]}`;
    if (seen.has(key)) return { usage: `${key} is named twice` };
    seen.add(key);
    if (m) {
      const name = m[1];
      if (name !== "default" && f.roster && !f.roster.includes(name))
        return { usage: `no agent named ${name} in the ${f.cfg.layout} roster — known: ${f.roster.join(", ")}` };
      let h = harness;
      if (!h) {
        if (f.used.length === 1) h = f.used[0].id;
        else return { usage: `name the overlay: --harness <id> (this project uses ${harnessesNamed})` };
      }
      if (!harnessIds().includes(h)) return { usage: `unknown harness: ${h} — known: ${harnessIds().join(", ")}` };
      if (!value) return { usage: `${key} takes a model, or ${CLEAR} to clear it` };
      out.push({ key, writer: "overlay", harness: h, name, value: value === CLEAR ? null : value });
      continue;
    }
    if (key === "vault")
      return {
        usage: `the vault is changed by rebind, ${fromTerminalIn(f.project)}:\n${packageCommand([], "bind", { args: "<vault> --rebind" })}`,
      };
    if (key === "layout") return { usage: "the layout is a vault's: changing it means a new vault" };
    const s = keys.find((x) => x.key === key);
    if (!s) {
      if (["statusline", "band", "band.epic"].includes(key))
        return {
          usage: `${key} is a surface of ${[...harnessIds()].map((id) => loadHarness(id)).find((x) => (key === "statusline" ? hasStatusLine(x) : hasBand(x)))?.display_name || "another harness"}; this project uses ${harnessesNamed}`,
        };
      if (["spec_policy", "lifecycle_gates"].includes(key))
        return { usage: `${key} lives in the vault's config, and this binding names no vault` };
      const hint = nearest ? nearest(key, known) : null;
      return { usage: `unknown setting ${key}${hint ? ` — did you mean ${hint}?` : ""}` };
    }
    const bad = (set) => ({ usage: `${key} takes ${set}, got ${value || "nothing"}` });
    if (s.rail === "bool") {
      const b = parseBool(value);
      if (b === null) return bad("on or off");
      out.push({ key, writer: s.writer, value: key === "lifecycle_gates" ? (b ? "on" : "off") : b });
    } else if (key === "language") {
      if (!f.languages.includes(value)) return bad(f.languages.join(", "));
      out.push({ key, writer: "binding", value });
    } else if (key === "spec_policy") {
      if (!["optional", "required"].includes(value)) return bad("optional or required");
      out.push({ key, writer: "vault", value });
    } else if (key === "default_author") {
      if (!value) return bad("a name");
      out.push({ key, writer: "binding", value });
    } else if (key === "tags") {
      const tags =
        value === CLEAR
          ? []
          : value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
      out.push({ key, writer: "binding", value: tags });
    } else if (key === "band.epic") {
      if (!value) return bad(`an epic id, or ${CLEAR} to release the pin`);
      if (value !== CLEAR) {
        const hit = f.epics.find((id) => id.toLowerCase() === value.toLowerCase());
        if (!hit) return bad(f.epics.length ? f.epics.join(", ") : "an epic id, and the vault has no epics");
        out.push({ key, writer: "band", value: hit });
      } else out.push({ key, writer: "band", value: null });
    }
  }
  return { changes: out };
}

// ─── The plan ──────────────────────────────────────────────────────────

// One PLAN over the writers. Refusals here are contract 11's exit-1 class:
// nothing is written. `items` are the rows a person reads; `steps` what APPLY
// runs, in the contract's order.
export function planChanges(f, changes, { env = process.env, home = homedir(), root, ownEnv = () => env } = {}) {
  const items = [];
  const steps = [];
  const refuse = (message) => ({ refusal: message });
  const byWriter = (w) => changes.filter((c) => c.writer === w);

  // The binding's plain keys.
  const effective = (k) =>
    k === "language"
      ? (f.cfg.language ?? "en")
      : k === "active_skills" || k === "auto_inject"
        ? f.cfg[k] !== false
        : k === "tags"
          ? (f.cfg.tags ?? [])
          : f.cfg[k];
  const plainKeys = byWriter("binding").filter((c) => JSON.stringify(effective(c.key)) !== JSON.stringify(c.value));
  if (plainKeys.length) {
    const p = planBindingKeys(f.project, Object.fromEntries(plainKeys.map((c) => [c.key, c.value])), { env });
    if (p.refusal) return refuse(p.refusal.message);
    for (const k of p.keys)
      items.push({
        key: k,
        file: where(f, p.path),
        before: shown(
          k === "active_skills" || k === "auto_inject"
            ? onOff(p.before[k] !== false)
            : k === "language"
              ? (p.before[k] ?? "en")
              : p.before[k],
        ),
        after: shown(k === "active_skills" || k === "auto_inject" ? onOff(p.after[k]) : p.after[k]),
        team: false,
        note: k === "language" ? LANGUAGE_NOTE : null,
      });
    if (p.changed) steps.push({ writer: "binding", plan: p, keys: p.keys });
  }

  // The band: planned again at APPLY for each change, so its writes and the
  // binding's never overwrite one another; decided here on values, not on
  // planBand's `changed`, which also flips on the hint it records.
  const band = byWriter("band");
  if (band.length) {
    const now = bandKeys(f.cfg);
    for (const c of band) {
      const before = c.key === "band" ? now.enabled : now.epic;
      if (before === c.value) continue;
      const sub = c.key === "band" ? (c.value ? "on" : "off") : "epic";
      items.push({
        key: c.key,
        file: where(f, f.path),
        before: c.key === "band" ? onOff(before) : shown(before),
        after: c.key === "band" ? onOff(c.value) : shown(c.value),
        team: false,
      });
      steps.push({ writer: "band", sub, arg: c.key === "band.epic" ? c.value : null, key: c.key });
    }
  }

  // The vault's config: its folder must exist (writeFileAtomic makes none),
  // and a file that does not parse is never replaced.
  const policy = byWriter("vault");
  if (policy.length) {
    if (!f.vault || !f.vaultExists)
      return refuse(
        `the vault ${f.vault ? tildeOf(f.vault, f.home) : "(none)"} does not exist — rebind or restore it first`,
      );
    const strict = readVaultConfigStrict(f.vault);
    if (strict.corrupt) return refuse(`${strict.path} is not valid JSON — fix or remove it first`);
    const patch = Object.fromEntries(policy.map((c) => [c.key, c.value]));
    const next = nextVaultConfig(strict.cfg, patch, new Date().toISOString());
    const inEffect = (k) => strict.cfg[k] ?? (k === "spec_policy" ? "optional" : undefined);
    const changed = policy.filter((c) => inEffect(c.key) !== c.value);
    for (const c of changed)
      items.push({
        key: c.key,
        file: tildeOf(strict.path, f.home),
        before: shown(strict.cfg[c.key] ?? (c.key === "spec_policy" ? "optional" : "not set")),
        after: shown(c.value),
        team: true,
        note: c.key === "spec_policy" && next.spec_policy_since !== strict.cfg.spec_policy_since ? STAMP_NOTE : null,
      });
    if (changed.length) steps.push({ writer: "vault", patch, keys: changed.map((c) => c.key) });
  }

  // The overlays: one agents change per harness, through the core
  // `agents configure` uses, so the clerk pin and the precedence agree.
  const byHarness = new Map();
  for (const c of byWriter("overlay")) {
    if (!byHarness.has(c.harness)) byHarness.set(c.harness, []);
    byHarness.get(c.harness).push(c);
  }
  for (const [h, list] of byHarness) {
    const before = readOverlayAt(f.project, h);
    if (before.unparseable) return refuse(`${before.path} is not valid JSON — fix or remove it first`);
    const def = list.find((c) => c.name === "default");
    const change = planAgentsChange({
      before,
      harness: h,
      layout: f.cfg.layout,
      roster: f.roster,
      defaultModel: def ? def.value || "" : undefined,
      agents: list.filter((c) => c.name !== "default").map((c) => `${c.name}=${c.value || ""}`),
    });
    if (change.usage) return { usage: change.usage };
    if (change.same) continue;
    const file = where(f, before.path);
    const manifest = loadHarness(h);
    const display = manifest.display_name || h;
    // A model no list of the harness holds is written, with a note (contract
    // 8 as amended 2026-10-13): the model may be newer than the list.
    // Only a model the run names gets the note: the clerk's pin does not.
    const known = knownModels(manifest, { env, home });
    const named = new Map(list.map((c) => [c.name, c.value]));
    const offList = (name, model) => (model && named.get(name) === model ? offListNote(manifest, model, known) : null);
    const notes = (...xs) => xs.filter(Boolean).join("; ") || null;
    if (before.agents.default !== change.next.default) {
      const listNote = offList("default", change.next.default);
      items.push({
        key: "agents.default",
        harness: h,
        display,
        file,
        before: shown(before.agents.default),
        after: shown(change.next.default),
        team: true,
        note: listNote,
        listNote,
      });
    }
    const names = new Set([...Object.keys(before.agents.per_agent), ...Object.keys(change.next.per_agent)]);
    for (const n of [...names].sort()) {
      const a = before.agents.per_agent[n] || null;
      const b = change.next.per_agent[n] || null;
      if (a === b) continue;
      const listNote = offList(n, b);
      items.push({
        key: `agents.${n}`,
        harness: h,
        display,
        file,
        before: shown(a),
        after: shown(b),
        team: true,
        note: notes(
          change.pinnedClerk && n === "clerk" ? "pinned: the clerk stays cheap under a strong default" : null,
          listNote,
        ),
        listNote,
      });
    }
    if (change.clerkPinUnavailable)
      items.push({
        key: "agents.clerk",
        harness: h,
        display,
        file,
        before: shown(before.agents.per_agent.clerk),
        after: "the default",
        team: true,
        note: `${display} declares no cheap model to pin the clerk to; set agents.clerk to name one`,
      });
    steps.push({ writer: "overlay", harness: h, next: change.next });
  }

  // The status line: install's own plan for the surface, with its flag item
  // (contract 6). A pending layout move, a foreign slot and a root that is
  // never wired are refusals; configure plans none of them.
  const sl = byWriter("statusline")[0];
  if (sl) {
    const m = f.slot;
    const current = typeof f.cfg.statusline?.enabled === "boolean" ? f.cfg.statusline.enabled : null;
    if (analyseLayout(f.project, { harness: m }).pending)
      return refuse(
        [
          `${f.project} still uses the layout from before 0.28; ${fromTerminalIn(f.project)}, move it first:`,
          packageCommand([m], "upgrade"),
        ].join("\n"),
      );
    const p = planInstall(
      f.project,
      planOptions({
        harnesses: [m.id],
        mode: sl.value ? "install" : "uninstall",
        surfaces: ["statusline"],
        root,
        env: ownEnv(f.project),
        home,
      }),
    );
    if (!p.ok) {
      // A refusal can be a row of the plan (an unparseable settings file, a
      // launcher that is not ours) as well as a plan-level one.
      const why = [
        ...p.refusals.map((r) => r.message || r.reason || String(r)),
        ...p.items
          .filter((i) => i.action === "refuse")
          .map((i) => `${typeof i.path === "string" ? where(f, i.path) : i.surface}: ${i.reason}`),
      ].filter(Boolean);
      return refuse(why.join("\n") || "the status line's plan refused");
    }
    const row = p.items.find((i) => i.surface === "statusline");
    if (sl.value && row && row.state === "theirs")
      return refuse(
        `a status line ${m.display_name || m.id} did not get from us owns the slot in ${where(f, row.path)} — clear it first`,
      );
    if (sl.value && row && row.action === "skip" && row.state !== "ours-current")
      return refuse(
        [
          // A copy run from a package manager's cache has no install path of its
          // own to wire the line against. The copy a session runs has one: the
          // in-session command reaches this same writer from it, whichever
          // channel installed it; the package's registration is the other way.
          `the status line cannot be wired from this copy: ${String(row.reason).replace(/ \(see the registration above\)$/, "")}. In a session in this project:`,
          commandForm("statusline", { args: "on", env }),
          `Or register the package ${fromTerminalIn(f.project)}:`,
          packageCommand([], "setup"),
        ].join("\n"),
      );
    const writes = p.items.filter((i) => i.action !== "skip");
    if (writes.length || current !== sl.value) {
      items.push({
        key: "statusline",
        file: writes
          .map((i) => i.path)
          .filter((x) => typeof x === "string")
          .map((x) => where(f, x))
          .join(", "),
        before: onOff(current),
        after: onOff(sl.value),
        team: false,
      });
      const wires = writes.some((i) => i.surface !== "statusline_flag");
      steps.push({ writer: "statusline", plan: p, restart: wires ? m.display_name || m.id : null });
    }
  }
  return { items, steps };
}

// Runs the steps in the plan's order. An I/O failure stops the run; what was
// written and what was not are both named.
export function applyChanges(f, steps, { env = process.env, home = homedir(), root } = {}) {
  const wrote = [];
  const removed = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    try {
      if (s.writer === "binding") {
        applyBindingKeys(s.plan);
        wrote.push(s.plan.path);
      } else if (s.writer === "band") {
        const p = planBand(f.project, s.sub, s.arg, { env, root });
        if (p.refusal) throw new Error(p.refusal.message);
        applyBand(p);
        wrote.push(p.path);
      } else if (s.writer === "vault") {
        // Read again, as the binding's writer does: the vault config is shared
        // by every checkout, and a change made while the question waited is kept.
        const now = readVaultConfigStrict(f.vault);
        if (now.corrupt) throw new Error(`${now.path} stopped being valid JSON after the plan`);
        writeVaultConfig(f.vault, nextVaultConfig(now.cfg, s.patch, new Date().toISOString()));
        wrote.push(vaultConfigPath(f.vault));
      } else if (s.writer === "overlay") {
        wrote.push(applyAgentsChange(f.project, s.harness, s.next).path);
      } else if (s.writer === "statusline") {
        const finished = [];
        try {
          const done = applyInstall(s.plan, {
            env,
            home,
            onItem: (i, phase, rec) => {
              if (phase === "end" && !rec?.failed && typeof i.path === "string")
                (["remove", "prune"].includes(i.action) ? removed : finished).push(i.path);
            },
          });
          const bad = (done || []).find((r) => r && r.failed);
          if (bad) throw new Error(bad.failed.stderr || bad.failed.message || `${bad.surface} failed`);
        } finally {
          wrote.push(...finished);
        }
      }
    } catch (e) {
      return {
        wrote: [...new Set(wrote)],
        removed,
        failed: { step: s.writer, message: e?.message || String(e) },
        left: steps.slice(k),
      };
    }
  }
  return { wrote: [...new Set(wrote)], removed, failed: null, left: [] };
}

// ─── Rendering ─────────────────────────────────────────────────────────

// What a source token reads as in the view.
const SOURCE_TEXT = Object.freeze({
  overlay: "overlay",
  per_agent: "per agent",
  default: "default",
  frontmatter: "its frontmatter",
  binding: "binding",
  vault_config: "vault config",
  unparseable: "not valid JSON: fix the file to change it",
});

const GROUP_TITLES = (f) => ({
  surfaces: "Status line and band",
  vault: "Vault and templates",
  policy: "Policy",
  ...Object.fromEntries(f.used.map((h) => [`agents:${h.id}`, `Agents · ${h.display_name || h.id}`])),
});

// The view (contract 3): the settings by group, each with its value and
// where it comes from; then the commands that change them, each alone.
export function renderView(f, settings, { caps: c = term.PLAIN } = {}) {
  const titles = GROUP_TITLES(f);
  const lines = [term.badge(c, "projectstore configure"), `  ${tildeOf(f.project, f.home)}`];
  const groups = [...new Set(settings.map((s) => s.group))];
  for (const g of groups) {
    const list = settings.filter((s) => s.group === g);
    const files = [...new Set(list.map((s) => s.file))];
    const team = list.some((s) => s.team);
    lines.push(
      "",
      `${term.heading(c, titles[g] || g)}  ${term.painter(c)("explanation", files.join(", ") + (team ? " (committed)" : ""))}`,
    );
    lines.push(
      ...term.rows(
        c,
        list.map((s) => ({
          action: s.key,
          target: shown(s.value),
          note:
            s.class === "other-verb"
              ? "changed by another command, below"
              : s.class === "changeable" && !s.rail
                ? `${SOURCE_TEXT[s.source] || s.source}; change it with ${s.set}`
                : SOURCE_TEXT[s.source] || s.source,
        })),
      ),
    );
  }
  lines.push(
    "",
    `  To change a setting ${fromTerminalIn(f.project)}:`,
    ...term.commandBlock(c, [
      packageCommand([], "configure"),
      packageCommand([], "configure", { args: "--set <key>=<value>" }),
    ]),
    "",
    "  The vault is changed by rebind, and a new vault by init:",
    ...term.commandBlock(c, [
      packageCommand([], "bind", { args: "<vault> --rebind" }),
      packageCommand([], "init", { args: "<vault> --rebind" }),
    ]),
  );
  return lines.join("\n") + "\n";
}

// The PLAN: one row per changed key, its file, and "team change" for a
// committed file; a note beneath where the change reaches further.
export function renderPlan(f, items, { caps: c = term.PLAIN } = {}) {
  const n = items.length;
  const lines = ["", term.heading(c, "Plan", [[`${n} ${n === 1 ? "change" : "changes"}`, "action"]]), ""];
  const twoHarnesses = f.used.length > 1;
  const rowsOf = term.rowLines(
    c,
    items.map((i) => ({
      glyph: "update",
      role: "action",
      action: twoHarnesses && i.display ? `${i.display} · ${i.key}` : i.key,
      target: `${i.before} ${term.icon(c, "transition")} ${i.after}`,
      note: `${i.file}${i.team ? " · team change" : ""}`,
    })),
  );
  const paint = term.painter(c);
  items.forEach((i, k) => {
    lines.push(...rowsOf[k]);
    if (i.note) {
      const width = c.live ? Math.min(Number(c.columns) || 100, 100) - 1 : 0;
      lines.push(paint("explanation", "      " + term.wrap(i.note, width, "      ")));
    }
  });
  return lines.join("\n") + "\n";
}

// ─── The run ───────────────────────────────────────────────────────────

// ctx: { values, project, env, stdin, stdout, ask, root, home, ownEnv,
// nearest, proc, escapeMs, drainTicks, now }. Returns { code, ok, result }
// or { code: 2, usage } or { code: 3, unbound: true }; the bin writes the
// envelope and the usage line.
export async function runConfigure(ctx) {
  const { values = {}, env = process.env, stdin = null, stdout = null, ask = null } = ctx;
  const project = ctx.project;
  const root = ctx.root;
  const home = ctx.home || homedir();
  const now = ctx.now || Date.now;
  const json = Boolean(values.json);
  const dryRun = Boolean(values["dry-run"]);
  const sets = values.set || [];
  const named = (values.harness || []).filter(Boolean);
  if (named.length > 1) return { code: 2, usage: "--harness names exactly one overlay; given twice" };
  const write = (text) => {
    if (!json && stdout && text) stdout.write(text);
  };
  const c = stdout ? term.caps(stdout, env) : term.PLAIN;

  const f = readFacts(project, { env, root, home });
  if (f.unbound) return { code: 3, unbound: true };
  if (f.corrupt) {
    const message = `${f.path} is not valid JSON — fix or remove it first; nothing is written`;
    return { code: 1, ok: false, message, result: { error: message } };
  }
  const settings = settingsOf(f);
  const publicSettings = settings.map((s) => ({
    key: s.key,
    value: s.value,
    source: s.source,
    file: s.file,
    class: s.class,
    harness: s.harness || null,
    team: s.team,
    set: s.set,
  }));
  const interactive =
    !json && (ask ? true : isInteractive({ stdin, stdout, env, json })) && term.railAvailable(stdin, c);
  // The menu needs a screen of its own size (contract 4 as amended
  // 2026-10-13): smaller, the run is as without a terminal.
  const fits =
    (Number(stdout?.columns) || c.columns || 100) >= SMALLEST.columns && (Number(stdout?.rows) || 24) >= SMALLEST.rows;

  // Nothing named and no terminal: the view, and nothing written.
  if (!sets.length && (!interactive || !fits)) {
    write(renderView(f, settings, { caps: c }));
    return { code: 0, ok: true, result: { settings: publicSettings, plan: [], wrote: [], removed: [] } };
  }

  let resolved;
  // The menu's review screen confirms; a --set run at a terminal asks once.
  let confirmed = false,
    reviewed = null;
  if (sets.length) {
    resolved = resolveSets(f, sets, { harness: named[0] || null, nearest: ctx.nearest });
    if (resolved.usage) return { code: 2, usage: resolved.usage };
    write(`${term.badge(c, "projectstore configure")}\n  ${tildeOf(f.project, f.home)}\n`);
  } else {
    // The settings menu (contract 4 as amended 2026-10-13). Its changes come
    // back as --set strings and go through the same resolve, plan and apply;
    // its review screen's second Enter is the confirmation.
    const resolveAll = (list) => {
      const changes = [];
      for (const x of list) {
        const r = resolveSets(f, [x.set], { harness: x.harness, nearest: ctx.nearest });
        if (r.usage) return { usage: r.usage };
        changes.push(...r.changes);
      }
      return { changes };
    };
    const a = await runMenu({
      f,
      settings,
      stdin,
      stdout,
      caps: c,
      proc: ctx.proc || process,
      escapeMs: ctx.escapeMs,
      env,
      home,
      now,
      path: tildeOf(f.project, f.home),
      dryRun,
      fetch: ctx.fetch,
      spawn: ctx.spawn,
      timers: ctx.timers,
      review: (list) => {
        const r = resolveAll(list);
        if (r.usage) return { ok: false, message: r.usage };
        const p = planChanges(f, r.changes, { env, home, root, ownEnv: ctx.ownEnv || (() => env) });
        if (p.usage) return { ok: false, message: p.usage };
        if (p.refusal !== undefined) return { ok: false, message: p.refusal };
        return { ok: true, items: p.items, plan: p };
      },
    });
    const head = `${term.badge(c, "projectstore configure")}\n  ${tildeOf(f.project, f.home)}\n`;
    if (a.cancelled) {
      write(`${head}\n  Cancelled ${term.icon(c, "dash")} nothing was written\n`);
      return { code: 130, ok: false, result: null };
    }
    if (a.nothing) {
      write(`${head}\n  No change ${term.icon(c, "dash")} nothing was written\n`);
      return { code: 0, ok: true, result: { settings: publicSettings, plan: [], wrote: [], removed: [] } };
    }
    write(head);
    const r = resolveAll(a.sets);
    if (r.usage) return { code: 2, usage: r.usage };
    resolved = r;
    confirmed = !a.dryRun;
    // What the review showed is what APPLY runs: the plan is not made again
    // after its confirmation.
    reviewed = a.planned || null;
  }

  const planned = reviewed || planChanges(f, resolved.changes, { env, home, root, ownEnv: ctx.ownEnv || (() => env) });
  if (planned.usage) return { code: 2, usage: planned.usage };
  const planOut = (items) =>
    items.map((i) => ({
      key: i.key,
      harness: i.harness || null,
      file: i.file,
      before: i.before,
      after: i.after,
      team: i.team,
      // Contract 3 as amended 2026-10-13: the off-list note only.
      ...(i.listNote ? { note: i.listNote } : {}),
    }));
  if (planned.refusal !== undefined)
    return {
      code: 1,
      ok: false,
      message: planned.refusal,
      result: { settings: publicSettings, error: planned.refusal, plan: [], wrote: [], removed: [] },
    };
  const result = { settings: publicSettings, plan: planOut(planned.items), wrote: [], removed: [] };
  if (!planned.items.length) {
    write("\n  Nothing to change.\n");
    return { code: 0, ok: true, result };
  }
  write(renderPlan(f, planned.items, { caps: c }));
  if (dryRun) {
    write("\n  Nothing written: this was a dry run.\n");
    return { code: 0, ok: true, result: { ...result, dry_run: true } };
  }
  if (interactive && !confirmed) {
    if (stdin && !ask) await term.drainInput(stdin, { ticks: ctx.drainTicks ?? 2 });
    write("\n");
    const yes = await term.askApply(planned.items.length, { stdin, stdout, ask, caps: c });
    if (!yes) {
      write("  Nothing written.\n");
      return { code: 1, ok: false, result: { ...result, declined: true } };
    }
  }
  const t0 = now();
  const r = applyChanges(f, planned.steps, { env, home, root });
  result.wrote = r.wrote.map((p) => where(f, p));
  result.removed = r.removed.map((p) => where(f, p));
  const paint = term.painter(c);
  if (r.failed) {
    write(
      [
        "",
        `${paint("error", term.icon(c, "fail"))} ${r.failed.step}: ${r.failed.message}`,
        ...(r.wrote.length ? ["  written:", ...r.wrote.map((p) => `    ${where(f, p)}`)] : []),
        ...(r.removed.length ? ["  removed:", ...r.removed.map((p) => `    ${where(f, p)}`)] : []),
        `  not written: ${r.left.map((s) => s.writer).join(", ")}`,
        "",
      ].join("\n"),
    );
    return { code: 1, ok: false, result: { ...result, failed: r.failed } };
  }
  const restart = planned.steps.find((s) => s.writer === "statusline")?.restart || null;
  const n = planned.items.length;
  write(
    [
      "",
      ...result.wrote.map((p) => `  ${paint("done", term.icon(c, "ok"))} wrote ${p}`),
      ...result.removed.map((p) => `  ${paint("done", term.icon(c, "ok"))} removed ${p}`),
      "",
      term.heading(c, "Done", [`${n} ${n === 1 ? "change" : "changes"} in ${term.duration(now() - t0)}`]),
      ...(restart
        ? ["", term.heading(c, "Next"), ...term.kv(c, [[restart, `restart ${restart} in this project`]])]
        : []),
      "",
    ].join("\n"),
  );
  return { code: 0, ok: true, result };
}

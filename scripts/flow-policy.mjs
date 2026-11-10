// projectstore — flow-policy.mjs: the vault's flow policy, as data.
//
// The `flow` block of <vault>/.projectstore.json holds a team's flow
// thresholds: WIP limits by a person's time on the project, ages in status,
// windows for throughput and capacity. This module is its grammar: the keys
// and their value forms, the `--set` parse `configure` uses, the view's rows,
// and the WIP limit rule doctor, `next` and the band read. Pure: no I/O.
//
// Spec: "Changing a project's settings after setup…" (alias `configure`),
// contracts 2, 3, 7 and 11 as amended 2026-11-10, and SPEC-001 contract 4
// as amended the same day, by PS-FLOW/story-the-vault-declares-its-flow-
// policy-and-configure-writes-it. No key has a default in code: a check whose
// key is absent does not run, and a value of the wrong type counts as absent.

import { isCalendarDate } from "./lib.mjs";

export const CLEAR = "-";

// The fixed keys, in the view's order. `kind` picks the value form.
export const FLOW_FIXED = Object.freeze([
  { key: "flow.wip.full", path: ["wip", "full"], kind: "count" },
  { key: "flow.wip.part", path: ["wip", "part"], kind: "count" },
  { key: "flow.age_days.review", path: ["age_days", "review"], kind: "days" },
  { key: "flow.age_days.in_progress_idle", path: ["age_days", "in_progress_idle"], kind: "days" },
  { key: "flow.age_days.todo", path: ["age_days", "todo"], kind: "days" },
  { key: "flow.idle_days", path: ["idle_days"], kind: "days" },
  { key: "flow.window_weeks", path: ["window_weeks"], kind: "weeks" },
  { key: "flow.capacity_weeks", path: ["capacity_weeks"], kind: "range" },
  { key: "flow.active_epics_max", path: ["active_epics_max"], kind: "count" },
  { key: "flow.grooming_days", path: ["grooming_days"], kind: "days" },
]);

// A person's fields, in the view's order.
export const PERSON_FIELDS = Object.freeze(["time", "wip", "git_names", "left"]);
const PERSON_KIND = Object.freeze({ time: "time", wip: "count", git_names: "names", left: "date" });

// Stamps under `flow`: never set by hand (contract 2's "Not settings").
export const FLOW_STAMPS = Object.freeze(["flow.groomed_at"]);

const SET_OF = Object.freeze({
  count: "a positive whole number",
  days: "a whole number of days, 1 or more",
  weeks: "a whole number of weeks, 1 or more",
  range: "two positive numbers, low then high, like 2,3",
  time: "full or part",
  names: "a comma list of git author names",
  date: "a date as YYYY-MM-DD",
});

const FORM_OF = Object.freeze({
  count: "<n>",
  days: "<days>",
  weeks: "<weeks>",
  range: "<low,high>",
  time: "<full|part>",
  names: "<a,b>",
  date: "<YYYY-MM-DD>",
});

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const PERSON_KEY = /^flow\.people\[([\s\S]*?)\]\.([A-Za-z_]+)=([\s\S]*)$/;
const BARE_PERSON = /^flow\.people\[([\s\S]*?)\]\s*(=|$)/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A positive safe integer written in plain decimal: no sign, no leading zero,
// no exponent, no fraction.
function positiveInt(raw) {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function positiveNumber(raw) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A value as typed → the value stored, or null when it is outside the set.
function parseValue(kind, raw) {
  switch (kind) {
    case "count":
    case "days":
    case "weeks":
      return positiveInt(raw);
    case "range": {
      const parts = raw.split(",").map((p) => p.trim());
      if (parts.length !== 2) return null;
      const [lo, hi] = parts.map(positiveNumber);
      return lo !== null && hi !== null && lo <= hi ? [lo, hi] : null;
    }
    case "time":
      return raw === "full" || raw === "part" ? raw : null;
    case "names": {
      const names = raw
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      return names.length && !names.some((n) => CONTROL.test(n)) ? names : null;
    }
    case "date":
      return isCalendarDate(raw) ? raw : null;
    default:
      return null;
  }
}

const shownName = (name) => (CONTROL.test(name) ? JSON.stringify(name) : name);

// A person's name as `flow.people[<name>]` takes it: the assignee as stories
// write it, never an email address.
function badName(name) {
  return !name || /[@\]=]/.test(name) || CONTROL.test(name) || name === "__proto__";
}

// Whether a raw `--set` argument is a flow key: these are parsed here, before
// configure splits at the first `=` (a person's name may hold a dot).
export const isFlowSet = (raw) => /^\s*flow(?:[.[=]|$)/.test(String(raw));

// The every-key list a typo is measured against.
export function flowKnownKeys(flow) {
  const keys = FLOW_FIXED.map((k) => k.key);
  if (isPlainObject(flow) && isPlainObject(flow.people))
    for (const name of Object.keys(flow.people)) for (const f of PERSON_FIELDS) keys.push(personKey(name, f));
  return keys;
}

export const personKey = (name, field) => `flow.people[${name}].${field}`;

// One `--set` argument → `{ change: { key, path, value } }`, `value: null`
// meaning "remove that key", or `{ usage }` (exit 2).
export function parseFlowSet(raw, { nearest = null, flow = null } = {}) {
  const text = String(raw).trim();
  const unknown = (key) => {
    if (FLOW_STAMPS.includes(key))
      return { usage: `unknown setting ${key} — a stamp that groom writes, never set by hand` };
    const hint = nearest ? nearest(key, flowKnownKeys(flow)) : null;
    return { usage: `unknown setting ${key}${hint ? ` — did you mean ${hint}?` : ""}` };
  };
  const p = PERSON_KEY.exec(text);
  if (p) {
    const name = p[1].trim();
    const field = p[2];
    const value = p[3].trim();
    if (badName(name))
      return {
        usage: `flow.people[${shownName(name)}] takes a name with no @, ] or =, and no line break (the assignee as stories write it, never an email address), got ${JSON.stringify(name)}`,
      };
    const key = personKey(name, field);
    if (!PERSON_FIELDS.includes(field)) return unknown(key);
    return change(key, ["people", name, field], PERSON_KIND[field], value);
  }
  const bare = BARE_PERSON.exec(text);
  if (bare) {
    const name = bare[1].trim();
    return {
      usage: `flow.people[${shownName(name)}] takes ${PERSON_FIELDS.map((f) => `.${f}`)
        .join(", ")
        .replace(/, ([^,]*)$/, " or $1")}`,
    };
  }
  const at = text.indexOf("=");
  if (at < 1) return { usage: `--set takes <key>=<value>, got ${raw}` };
  const key = text.slice(0, at).trim();
  const value = text.slice(at + 1).trim();
  const fixed = FLOW_FIXED.find((k) => k.key === key);
  if (!fixed) return unknown(key);
  return change(key, fixed.path, fixed.kind, value);
}

function change(key, path, kind, value) {
  if (value === CLEAR) return { change: { key, path, value: null } };
  const parsed = value ? parseValue(kind, value) : null;
  if (parsed === null)
    return { usage: `${key} takes ${SET_OF[kind]}, or ${CLEAR} to clear it, got ${value || "nothing"}` };
  return { change: { key, path, value: parsed } };
}

// The `--set` form a flow key is changed with; a person's form is quoted by
// the caller for the shell.
export function flowForm(key) {
  const fixed = FLOW_FIXED.find((k) => k.key === key);
  if (fixed) return `--set ${key}=${FORM_OF[fixed.kind]}`;
  const m = /^flow\.people\[([\s\S]*)\]\.([a-z_]+)$/.exec(key);
  return m ? `--set ${key}=${FORM_OF[PERSON_KIND[m[2]]]}` : null;
}

// The value at a path of the flow block, own keys only; undefined when absent.
export function flowAt(flow, path) {
  let node = flow;
  for (const step of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, step)) return undefined;
    node = node[step];
  }
  return node;
}

// The first node on a path that exists and is not an object, as a dotted
// key; null when the path can be written.
export function blockedAt(vaultCfg, path) {
  if (!isPlainObject(vaultCfg) || !Object.hasOwn(vaultCfg, "flow")) return null;
  let node = vaultCfg.flow;
  let label = "flow";
  for (let i = 0; i < path.length; i++) {
    if (!isPlainObject(node)) return label;
    if (i === path.length - 1 || !Object.hasOwn(node, path[i])) return null;
    label += path[0] === "people" && i === 1 ? `[${path[i]}]` : `.${path[i]}`;
    node = node[path[i]];
  }
  return null;
}

// The rows the view lists: every set key, fixed keys in table order, then
// people in file order, each person's fields in table order. A value of the
// wrong type is listed as it is: the view shows the file.
export function flowRows(flow) {
  if (!isPlainObject(flow)) return [];
  const rows = [];
  for (const k of FLOW_FIXED) {
    const v = flowAt(flow, k.path);
    if (v !== undefined) rows.push({ key: k.key, value: v, person: null });
  }
  if (isPlainObject(flow.people))
    for (const [name, fields] of Object.entries(flow.people)) {
      if (!isPlainObject(fields)) continue;
      for (const f of PERSON_FIELDS)
        if (Object.hasOwn(fields, f)) rows.push({ key: personKey(name, f), value: fields[f], person: name });
    }
  return rows;
}

const goodCount = (v) => Number.isSafeInteger(v) && v > 0;

// A fixed key's value when it is of its key's type, else null: how every
// reader of the policy takes it (SPEC-001 contract 4, as amended).
export function flowValue(vaultCfg, key) {
  const fixed = FLOW_FIXED.find((k) => k.key === key || k.key === `flow.${key}`);
  if (!fixed || !isPlainObject(vaultCfg)) return null;
  const v = flowAt(vaultCfg.flow, fixed.path);
  if (fixed.kind === "range")
    return Array.isArray(v) &&
      v.length === 2 &&
      v.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) &&
      v[0] <= v[1]
      ? [v[0], v[1]]
      : null;
  return goodCount(v) ? v : null;
}

// The WIP limit rule (SPEC-001 contract 4, as amended): a person's own `wip`,
// else `flow.wip.<time>` for their `time`, else no limit. A person not listed
// has none. The name matches exactly, as an own key.
export function wipLimitOf(vaultCfg, name) {
  if (!isPlainObject(vaultCfg)) return null;
  const people = flowAt(vaultCfg.flow, ["people"]);
  if (!isPlainObject(people) || typeof name !== "string" || !Object.hasOwn(people, name)) return null;
  const person = people[name];
  if (!isPlainObject(person)) return null;
  if (goodCount(person.wip)) return person.wip;
  if (person.time !== "full" && person.time !== "part") return null;
  const byTime = flowAt(vaultCfg.flow, ["wip", person.time]);
  return goodCount(byTime) ? byTime : null;
}

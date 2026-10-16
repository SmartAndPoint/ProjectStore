// projectstore — configure-menu.mjs: configure's settings menu at a terminal
// (the story "configure at a terminal is one settings menu: arrow keys, a
// line that says what each row means, and model lists read from each
// harness"; the configure spec's contracts 2, 4 and 8 and the presentation
// spec's contract 14, as amended 2026-10-13).
//
//   menuGroups(f, settings, catalogs)  → the menu's groups: every shown
//                                        setting, its values and what each means
//   pendingSets(changes)               → the menu's changes as --set strings
//   runMenu(ctx)                       → { cancelled } | { nothing } | { sets }
//
// The menu decides nothing a --set run does not: its changes become --set
// strings, which configure resolves, plans and applies through the same
// writers. Every text a row shows is here, except a model's description,
// which comes from its harness's list (scripts/models.mjs).

import * as term from "./term.mjs";
import { createMenu, renderMenu, seg, SMALLEST } from "./menu.mjs";
import { knownModels, readLive, effortSpec, effortLevels } from "./models.mjs";
import { loadHarness } from "./harness.mjs";
import { readOverlayAt } from "./lib.mjs";

const CLEAR = "-";

// What an effort row sets: the settings panel's first sentence for it.
const EFFORT = "How long the agent thinks before it answers: a higher level is slower and costs more.";

// What each agent of the roster does: the settings panel's first sentence.
const ROLE = Object.freeze({
  default: "The model for every agent that has none of its own.",
  critic: "Reviews ADRs, specs, stories and designs before they are treated as final.",
  planner: "Plans where an epic's or a story's code goes, before it is written.",
  reviewer: "Checks that a diff closes its story's acceptance criteria, before a commit.",
  librarian: "Looks for duplicates, contradictions and missing links across the vault.",
  archaeologist: "Finds decisions an existing codebase made but never wrote down.",
  clerk: "Copies an approved artifact into the vault and runs the write ceremony.",
});

// The bundled template languages' names; a code without one reads as itself.
const LANGUAGE = Object.freeze({
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  ru: "Russian",
  zh: "Simplified Chinese",
});

// What a setting does, and what each of its values means.
const KEY = Object.freeze({
  statusline: {
    text: (h) =>
      `projectstore's line under the prompt. Turning it on or off changes ${h}'s settings, so the change shows after a restart.`,
    values: {
      on: (h) => `Wires the line into ${h}'s settings. It shows after a restart.`,
      off: (h) => `Removes the line from ${h}'s settings. It goes after a restart.`,
    },
  },
  band: {
    text: () => "The band above the prompt: this session's epic, how far it is, its story and the agent at work.",
    values: {
      on: () => "The band shows above the prompt within a few seconds.",
      off: () => "The band goes, and the status line takes its place again within 30 seconds.",
    },
  },
  "band.epic": { text: () => "The epic the band shows in a session that has no epic of its own." },
  vault: {
    text: () =>
      "The vault this project is bound to. Another command changes it: npx projectstore bind <vault> --rebind.",
  },
  layout: {
    text: () =>
      "The vault's folder layout. It comes with the vault, so a new layout means a new vault: npx projectstore init <vault> --rebind.",
  },
  language: {
    text: () =>
      "The language of new artifacts, the derived views, the session header and the status line. Existing artifacts stay as they are.",
  },
  active_skills: {
    text: () =>
      "Skills that notice a decision or a finished story in the conversation and suggest the command. They never write.",
    values: {
      on: () => "The skills suggest a command when the conversation records a decision or finishes a story.",
      off: () => "The skills stay quiet. The commands still work when you run them.",
    },
  },
  auto_inject: {
    text: () => "At session start, what is in flight and where the last session left off go into the agent's context.",
    values: {
      on: () => "Each session starts knowing what is in flight and where the last one left off.",
      off: () => "Sessions start without it. The status command still shows what is in flight.",
    },
  },
  default_author: { text: () => "The author written into new artifacts." },
  tags: { text: () => "Tags every new artifact starts with, as a comma list: a, b." },
  spec_policy: {
    text: () => "Whether a story needs an active spec before implementation.",
    values: {
      required: () =>
        "A story needs an active spec before implementation, and doctor checks it. Stories closed before now are exempt.",
      optional: () => "Specs where they help. doctor does not require them.",
    },
  },
  lifecycle_gates: {
    text: () => "Whether doctor checks a story's plan and close sections.",
    values: {
      on: () => "doctor checks a story's plan when it starts, and its final summary and evidence when it closes.",
      off: () => "The plan and close sections are still written; doctor does not check them.",
    },
  },
});

// Where a value comes from, as the panel's tag says it.
const SOURCE = Object.freeze({
  per_agent: "set per agent",
  overlay: "the overlay's default",
  default: "not set",
  frontmatter: "from its frontmatter",
  binding: "from the binding",
  vault_config: "from the vault's config",
  unparseable: "not valid JSON: fix the file to change it",
});

const show = (v) =>
  v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") || "—" : String(v);

// A list's age, as a caption says it: today 13:50, yesterday, 3 days ago.
export function checkedWhen(at, now) {
  const d = new Date(at),
    n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400000);
  if (days <= 0) return `today ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// The menu's groups (contract 14), from the setting set. `catalogs` holds,
// per harness id, what its lists know and whether a read is out:
// { known, busy, error }; `menu()` answers the menu, for values that depend
// on another row's pending change (an agent's default).
export function menuGroups(f, settings, catalogs, { menu, now = Date.now, caps: c = term.PLAIN } = {}) {
  const groups = [];
  const byGroup = new Map();
  for (const s of settings) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }
  // The binding's file, as the settings name it: its basename is the footer.
  const bindingFile = settings.find((s) => s.writer === "binding")?.file || "";
  const bind = bindingFile.split("/").pop();
  for (const [g, list] of byGroup) {
    if (g.startsWith("agents:")) groups.push(agentsGroup(f, g.slice(7), list, catalogs, { menu, now, caps: c }));
    else if (g === "surfaces") {
      const host = (f.slot || f.band)?.display_name || "the harness";
      groups.push({
        title: "Status line and band",
        footer: bind,
        description: `What projectstore draws in ${host}: its line under the prompt, and the band above the prompt with this session's epic, story and the agent at work. Kept in ${bindingFile}, on this machine only.`,
        items: list.map((s) => plainItem(f, s, host)),
      });
    } else if (g === "vault")
      groups.push({
        title: "Vault and templates",
        footer: bind,
        description: `Where this project's vault is, and how new artifacts are written: their language, author and tags, and whether the skills and the session-start context are on. Kept in ${bindingFile}, on this machine only.`,
        items: list.map((s) => plainItem(f, s, null)),
      });
    else if (g === "policy")
      groups.push({
        title: "Policy",
        footer: "<vault>/.projectstore.json",
        description:
          "The vault's own rules, shared by everyone who uses the vault: whether a story needs a spec, and whether doctor checks a story's plan and close. Kept in the vault's .projectstore.json; commit the vault after a change.",
        items: list.map((s) => plainItem(f, s, null)),
      });
  }
  return groups;
}

function plainItem(f, s, host) {
  const k = KEY[s.key] || { text: () => "" };
  const base = {
    id: s.key,
    key: s.key,
    label: s.key,
    value: s.value,
    tag: SOURCE[s.source] || s.source,
    display: show,
  };
  const now = (v, changed, it) =>
    changed ? `In the file: ${show(it.value)}. After the change: ${show(v)}.` : `Now: ${show(v)}.`;
  if (s.class === "other-verb" || s.source === "unparseable")
    return {
      ...base,
      kind: "info",
      tag: s.source === "unparseable" ? SOURCE.unparseable : "set by another command",
      describe: () =>
        s.source === "unparseable"
          ? `${k.text(host)} ${s.file} is not valid JSON: fix it to change this.`
          : k.text(host),
    };
  if (s.key === "default_author" || s.key === "tags") {
    const item = {
      ...base,
      kind: "text",
      allowEmpty: s.key === "tags",
      value: s.key === "tags" ? (Array.isArray(s.value) && s.value.length ? s.value.join(", ") : null) : s.value,
      textHint:
        s.key === "tags"
          ? "Type the tags as a comma list. Enter with nothing typed clears them."
          : "Type the name to write into new artifacts.",
    };
    item.describe = (v, changed) => `${k.text(host)} ${now(v, changed, item)}`;
    return item;
  }
  const valueText = (v) => k.values?.[v]?.(host) || "";
  let options;
  if (s.rail === "bool")
    options = () => ["on", "off"].map((v) => ({ value: v, label: v, kind: "value", description: valueText(v) }));
  else if (s.rail === "language")
    options = () =>
      f.languages.map((v) => ({
        value: v,
        label: v,
        note: LANGUAGE[v] || "",
        kind: "value",
        description: `${LANGUAGE[v] || v}. ${k.text(host)}`,
      }));
  else if (s.rail === "policy")
    options = () =>
      ["optional", "required"].map((v) => ({ value: v, label: v, kind: "value", description: valueText(v) }));
  else if (s.rail === "epic")
    options = () => [
      ...f.epics.map((v) => ({
        value: v,
        label: v,
        kind: "value",
        description: `Sessions that have no epic of their own show ${v} on the band.`,
      })),
      {
        value: null,
        label: "release the pin",
        kind: "value",
        section: "",
        description: "No pin: a session without an epic of its own shows no band.",
      },
    ];
  else return { ...base, kind: "info", describe: () => `${k.text(host)} Change it with ${s.set}.` };
  const item = { ...base, kind: "choice", toggle: s.rail === "bool", options };
  item.describe = (v, changed) => `${k.text(host)} ${now(v, changed, item)}`;
  return item;
}

// One harness's agents: its overlay's own values (an agent's own model, or
// none), each row showing what runs today, and the model lists of
// scripts/models.mjs as the values.
function agentsGroup(f, id, list, catalogs, { menu, now, caps: c }) {
  const h = loadHarness(id);
  const display = h?.display_name || id;
  const o = readOverlayAt(f.project, id);
  const file = list[0]?.file || "";
  const own = (key) => (key === "agents.default" ? o.agents.default || null : o.agents.per_agent[key.slice(7)] || null);
  const items = [];
  const defaultItem = () => items.find((x) => x.key === "agents.default");
  const defaultNow = () => {
    const d = defaultItem();
    return d ? (menu?.() ? menu().eff(d) : d.value) : null;
  };
  for (const s of list) {
    const isEffort = s.rail === "effort";
    const name = isEffort ? s.key.slice(7, -7) : s.key.slice(7);
    const isDefault = name === "default";
    if (s.source === "unparseable") {
      items.push({
        id: `${id}:${s.key}`,
        key: s.key,
        harness: id,
        label: isEffort ? "effort" : name,
        ...(isEffort ? { indent: 2, path: `${name} · effort` } : {}),
        title: `${display} · ${name}${isEffort ? " · effort" : ""}`,
        kind: "info",
        value: null,
        tag: SOURCE.unparseable,
        describe: () => `${file} is not valid JSON: fix it to change the agents' models.`,
      });
      continue;
    }
    if (isEffort) {
      items.push(effortItem(h, display, id, s, name, isDefault, o, items, catalogs, { defaultNow, menu, now }));
      continue;
    }
    const item = {
      id: `${id}:${s.key}`,
      key: s.key,
      harness: id,
      label: name,
      title: `${display} · ${name}`,
      kind: "choice",
      value: own(s.key),
      tag: own(s.key) ? (isDefault ? SOURCE.overlay : SOURCE.per_agent) : isDefault ? SOURCE.default : "",
      display: (v) => {
        if (v) return v;
        if (isDefault) return "—";
        const d = defaultNow();
        return d ? `${d} (default)` : "frontmatter";
      },
    };
    item.describe = (v, changed) => {
      const role = ROLE[name] || "A projectstore agent.";
      if (changed) return `${role} In the file: ${item.display(item.value)}. After the change: ${item.display(v)}.`;
      if (isDefault)
        return `${role} ${v ? `Now: ${v}, for every agent without its own.` : "Now: not set, so each agent's frontmatter decides."}`;
      if (v) return `${role} Now: ${v}, its own.`;
      const d = defaultNow();
      return `${role} ${d ? `Now: ${d}, from default.` : "Now: its frontmatter decides."}`;
    };
    item.options = () =>
      modelOptions(h, display, item, catalogs[id] || {}, { isDefault, defaultNow, menu, now, caps: c });
    item.caption = () => caption(catalogs[id] || {}, now);
    item.textHint = `Type the model's name as ${display} spells it. A name that is not in the list is written with a warning, not refused.`;
    items.push(item);
  }
  return {
    title: `Agents · ${display}`,
    footer: file.split("/").pop(),
    description: `Which model each projectstore agent runs on in ${display}${h?.agent_translation?.models?.spawn_takes === "id" ? `, in ${display}'s own model names` : ""}, and at what effort. A model or an effort set here goes to ${file}, which is committed, so it applies to everyone on this project. default covers every agent without one of its own.`,
    items,
  };
}

// An agent's effort row (the effort ADR, decision 4): under its model row,
// its value its own level, else the default's, else what the harness does
// with none; its values the levels of the model it will run on, a model
// change waiting in the menu counted.
function effortItem(h, display, id, s, name, isDefault, o, items, catalogs, { defaultNow, menu, now }) {
  const es = effortSpec(h);
  const own = isDefault ? o.efforts.default || null : o.efforts.per_agent[name] || null;
  const eff = (it) => (it ? (menu?.() ? menu().eff(it) : it.value) : null);
  const modelItem = items.find((x) => x.key === (isDefault ? "agents.default" : `agents.${name}`));
  const defaultEffortItem = () => items.find((x) => x.key === "agents.default.effort");
  // The model this agent will run on: its own, else the default's.
  const runModel = () => eff(modelItem) || (isDefault ? null : defaultNow()) || null;
  const defaultEffortNow = () => (isDefault ? null : eff(defaultEffortItem()));
  const levelsNow = () => effortLevels(h, runModel(), catalogs[id]?.known || null);
  // What runs when nothing is configured: the frontmatter's level, or, where
  // a passed model's own default runs, that level when its list names it.
  const unsetText = () => {
    const m = runModel();
    const d = es.unset.model_default && m ? levelsNow()?.default : null;
    return d ? `${d} (${m}'s default)` : es.unset.value;
  };
  const unsetMeaning = es.unset.model_default
    ? "each agent runs at its model's own default level"
    : "each agent runs at its frontmatter's effort";
  const item = {
    id: `${id}:${s.key}`,
    key: s.key,
    harness: id,
    label: "effort",
    indent: 2,
    path: `${name} · effort`,
    title: `${display} · ${name} · effort`,
    kind: "choice",
    value: own,
    tag: own ? (isDefault ? SOURCE.overlay : SOURCE.per_agent) : isDefault ? SOURCE.default : "",
    display: (v) => {
      if (v) return v;
      const d = defaultEffortNow();
      return d ? `${d} (default)` : unsetText();
    },
  };
  item.describe = (v, changed) => {
    if (changed) return `${EFFORT} In the file: ${item.display(item.value)}. After the change: ${item.display(v)}.`;
    if (isDefault)
      return `${EFFORT} ${v ? `Now: ${v}, for every agent without its own.` : `Now: not set, so ${unsetMeaning}.`}`;
    if (v) return `${EFFORT} Now: ${v}, its own.`;
    const d = defaultEffortNow();
    return `${EFFORT} ${d ? `Now: ${d}, from default.` : `Now: ${item.display(null)}.`}`;
  };
  item.options = () =>
    effortOptions(es, display, item, name, isDefault, levelsNow(), runModel(), defaultEffortNow(), menu);
  item.caption = () => {
    const l = levelsNow();
    if (!l) return null;
    if (l.from === "catalog")
      return {
        text: `levels of ${l.model}${l.source ? ` · ${l.source}` : ""}${l.at ? ` · checked ${checkedWhen(l.at, now())}` : ""}`,
      };
    return { text: `${display}'s levels` };
  };
  return item;
}

// An effort row's values: the levels, the value in the file when the list
// lacks it, then the way back to the default. No free text and no refresh:
// the levels come with the model list, whose frame refreshes it.
function effortOptions(es, display, item, name, isDefault, levels, model, d, menu) {
  const opts = (levels?.levels || []).map((l, i) => ({
    value: l.id,
    label: l.id,
    kind: "value",
    note: l.id === levels.default ? "default" : "",
    section: i === 0 ? (levels.from === "catalog" ? `levels of ${model}` : `${display}'s levels`) : undefined,
    description: [
      l.description ? (/[.!?]$/.test(l.description) ? l.description : `${l.description}.`) : "",
      l.id === levels.default ? `${model}'s own default.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  }));
  const m = menu?.();
  for (const v of [item.value, m ? m.eff(item) : null])
    if (v && !opts.some((o) => o.value === v))
      opts.push({
        value: v,
        label: v,
        note: "not in the list",
        kind: "value",
        section: opts.length ? undefined : "",
        description: model
          ? `Not a level ${model} lists. It is kept as it is.`
          : `Not one of ${display}'s levels. It is kept as it is.`,
      });
  const meaning = es.unset.model_default ? "its model's own default level" : "its frontmatter's effort";
  opts.push(
    isDefault
      ? {
          value: null,
          label: es.unset.row,
          kind: "value",
          section: "",
          description: `Drops the default effort: each agent without its own runs at ${meaning}.`,
        }
      : {
          value: null,
          label: "use the default",
          kind: "value",
          section: "",
          description: d
            ? `Drops ${name}'s own effort: it runs at the default, ${d}.`
            : `Drops ${name}'s own effort: it runs at ${meaning}.`,
        },
  );
  return opts;
}

// The values frame's footer: the list's source and age, the host being
// asked, or why nothing can be asked (the ADR, decisions 3 and 6).
function caption(cat, now) {
  const k = cat.known;
  if (!k) return null;
  const name = k.caption || k.live?.caption || "";
  if (cat.busy) return { text: `asking ${k.live?.host || k.live?.caption || name}…`, busy: true };
  if (cat.error) return { text: `${k.live?.caption || name} · ${cat.error}` };
  if (k.at) return { text: `${name} · checked ${checkedWhen(k.at, now())}` };
  if (k.why && k.spawnTakes === "alias") return { text: `aliases only · ${k.why}` };
  return k.why ? { text: k.why } : null;
}

// A model setting's values (the ADR's decisions 1 and 5): the list, the
// value in the file when the list lacks it, then "type a name…", "refresh
// the list" and the way back to the default.
function modelOptions(h, display, item, cat, { isDefault, defaultNow, menu, now, caps: c }) {
  const k = cat.known;
  const opts = [];
  const source = k?.source || "";
  if (k) {
    k.offered.forEach((o, i) => {
      const section =
        i === 0 ? (k.spawnTakes === "alias" ? "follows the newest" : `from ${source || display}`) : undefined;
      if (k.spawnTakes === "alias") {
        // The newest of its line in the catalog: the best local account of
        // what the alias starts; the harness resolves the alias itself.
        const newest = o.follows
          ? `Newest ${o.family} in ${source}: ${o.follows.label || o.follows.id}, ${o.follows.id}.`
          : "";
        opts.push({
          value: o.id,
          label: o.id,
          note: o.follows ? `${term.icon(c, "transition")} ${o.follows.id}` : "",
          kind: "value",
          section,
          description: [o.description, newest].filter(Boolean).join(" "),
        });
      } else
        opts.push({
          value: o.id,
          label: o.id,
          kind: "value",
          section,
          description: [o.label && o.label !== o.id ? `${o.label}.` : "", o.description].filter(Boolean).join(" "),
        });
    });
  }
  const m = menu?.();
  for (const v of [item.value, m ? m.eff(item) : null])
    if (v && !opts.some((o) => o.value === v))
      opts.push({
        value: v,
        label: v,
        note: k?.hidden?.has(v) ? `hidden by ${display}` : "not in the list",
        kind: "value",
        section: opts.length ? undefined : "",
        description: k?.hidden?.has(v)
          ? `${display} hides it from its own picker. It is kept as it is.`
          : `Not in ${source ? `${source}'s list` : "any list"}. It is kept as it is.`,
      });
  // No free text where the spawn takes aliases: every other name fails at
  // spawn, and --set is the way to name one (the ADR, decision 5).
  if (k?.spawnTakes !== "alias")
    opts.push({
      kind: "text",
      label: "type a name…",
      section: "",
      description: `Any name ${display} accepts. A name that is not in the list is written with a warning, not refused: the model may be newer than the list.`,
    });
  const liveSource = k?.live?.source || source;
  if (k)
    opts.push({
      kind: "refresh",
      ...(k.spawnTakes === "alias" ? { section: "" } : {}),
      label: cat.busy ? "asking…" : "refresh the list",
      busy: Boolean(cat.busy),
      description: cat.busy
        ? `Asking ${liveSource} for its list now.`
        : !k?.live
          ? `Nothing to ask: ${k?.why || "this harness declares no list to read"}.`
          : cat.error
            ? `The last ask failed: ${cat.error}. The list is as it was.`
            : `Asks ${liveSource} for its list now.${k.at ? ` Last checked ${checkedWhen(k.at, now())}.` : ""} A list is kept for a day, so opening it never waits on the network.`,
    });
  const d = defaultNow();
  opts.push(
    isDefault
      ? {
          value: null,
          label: "use frontmatter",
          kind: "value",
          description: "Drops the default: each agent without a model of its own runs on its frontmatter's model.",
        }
      : {
          value: null,
          label: "use the default",
          kind: "value",
          description: d
            ? `Drops ${item.label}'s own model: it runs on the default, ${d}.`
            : `Drops ${item.label}'s own model: it runs on its frontmatter's model.`,
        },
  );
  return opts;
}

// The menu's changes as --set strings, each with its harness: configure
// resolves them as it resolves a named run's.
export function pendingSets(changes) {
  return changes.map(({ item, after }) => {
    const v = after === null || after === undefined || after === "" ? CLEAR : String(after);
    return { set: `${item.key}=${v}`, harness: item.harness || null };
  });
}

// The review screen's rows: the PLAN's, as configure's renderPlan reads.
export function reviewLines(items, { caps: c = term.PLAIN, twoHarnesses = false, width = 96 } = {}) {
  const lines = [];
  const kw = Math.max(0, ...items.map((i) => (twoHarnesses && i.display ? `${i.display} · ${i.key}` : i.key).length));
  for (const i of items) {
    const key = twoHarnesses && i.display ? `${i.display} · ${i.key}` : i.key;
    lines.push([
      seg("  "),
      seg(term.icon(c, "update"), "action"),
      seg(` ${key.padEnd(kw)}  `),
      seg(i.before, "explanation"),
      seg(` ${term.icon(c, "transition")} `, "explanation"),
      seg(i.after, "emphasis"),
      seg(`  ${i.file}${i.team ? " · team change" : ""}`, "explanation"),
    ]);
    // A note beneath its row, wrapped as the PLAN wraps it, never split at
    // its own punctuation.
    if (i.note)
      for (const part of term.wrap(String(i.note), Math.max(30, width - 8)).split("\n"))
        lines.push([seg("      "), seg(part, "explanation")]);
  }
  return lines;
}

// The menu at a terminal: open the screen, read the keys, draw, and answer
// what the person chose. `review(sets)` is configure's plan of those sets:
// { ok, items, message }. Background reads of a harness's model list are
// started here, bounded, and stopped when the menu closes.
export async function runMenu(ctx) {
  const { f, settings, stdin, stdout, caps: c, proc, escapeMs, env, home, path, review, dryRun = false } = ctx;
  const now = ctx.now || Date.now;
  const catalogs = {};
  for (const h of f.used) {
    const manifest = loadHarness(h.id);
    catalogs[h.id] = { known: knownModels(manifest, { env, home, now }), busy: false, error: null };
  }
  let menu = null;
  const groups = menuGroups(f, settings, catalogs, { menu: () => menu, now, caps: c });
  if (!groups.length) return { nothing: true };
  const stops = new Set();
  let screen = null;
  const read = (id) => {
    const cat = catalogs[id];
    if (!cat || cat.busy || !cat.known?.live) return;
    cat.busy = true;
    cat.error = null;
    const ac = new AbortController();
    stops.add(ac);
    readLive(loadHarness(id), {
      env,
      home,
      now,
      signal: ac.signal,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
      ...(ctx.timers ? { timers: ctx.timers } : {}),
    }).then((r) => {
      stops.delete(ac);
      cat.busy = false;
      if (r.error) cat.error = r.error;
      else cat.known = knownModels(loadHarness(id), { env, home, now });
      if (menu) menu.rebuild();
      if (screen) screen.wake("models");
    });
  };
  menu = createMenu({
    groups,
    onRefresh: (it) => it.harness && read(it.harness),
    // A list is read from a model's frame only: an effort frame shows what is
    // known, and its levels follow when a model's list is refreshed.
    onOpen: (it) => {
      const cat = it.harness && !it.key?.endsWith(".effort") ? catalogs[it.harness] : null;
      if (cat?.known?.stale) read(it.harness);
    },
  });
  screen = term.openScreen({ stdin, stdout, caps: c, proc, ...(escapeMs ? { escapeMs } : {}) });
  let planned = null;
  // After the review is drawn, keys already in the terminal's buffer were
  // typed before it was seen: they are dropped (contract 14's review screen).
  let drainAfterDraw = false;
  try {
    for (;;) {
      const size = screen.size();
      // A terminal made smaller than the menu after it opened: one line says
      // what it needs, and no key but Ctrl+C acts until it grows again.
      const small = size.columns < SMALLEST.columns || size.rows < SMALLEST.rows;
      if (small) {
        const line = `${term.icon(c, "warning")} The menu needs ${SMALLEST.columns} columns and ${SMALLEST.rows} rows. Ctrl+C leaves.`;
        const room = Math.max(1, size.columns - 1);
        screen.draw(
          term
            .wrap(line, Math.max(20, room))
            .split("\n")
            .map((l) => [...l].slice(0, room).join("")),
        );
      } else screen.draw(renderMenu(menu, { caps: c, ...size, path }));
      if (drainAfterDraw) {
        screen.drain(2);
        drainAfterDraw = false;
      }
      const ev = await screen.next();
      if (ev === "resize" || ev === "models") continue;
      if (small && ev !== "cancel") continue;
      const r = menu.press(ev);
      if (r === "cancel") return { cancelled: true };
      if (r === "nothing") return { nothing: true };
      if (r === "write") return { sets: pendingSets(menu.changes()), planned: planned.plan };
      if (r === "review") {
        const sets = pendingSets(menu.changes());
        if (dryRun) return { sets, dryRun: true };
        planned = review(sets);
        // Changes that plan to nothing (a value typed back as it was) are no
        // change: the menu leaves as with nothing waiting (rule 4).
        if (planned.ok && !planned.items.length) return { nothing: true };
        // An Enter typed with the one that opened the review is not the
        // second: what was queued is dropped now, and what reaches the
        // terminal's buffer before the PLAN is on screen after the draw.
        screen.drain();
        drainAfterDraw = true;
        const n = planned.ok ? planned.items.length : 0;
        menu.screen = "review";
        menu.review = planned.ok
          ? {
              ok: true,
              title: `Plan ${term.icon(c, "dash")} ${n} ${n === 1 ? "change" : "changes"}`,
              lines: reviewLines(planned.items, {
                caps: c,
                twoHarnesses: f.used.length > 1,
                width: Math.min(screen.size().columns, 100) - 1,
              }),
            }
          : {
              ok: false,
              title: "Plan",
              // The refusal's lines wrapped to the screen, never cut: its
              // first line is the reason, the rest its ways out.
              lines: String(planned.message)
                .split("\n")
                .flatMap((l, k) =>
                  term
                    .wrap(l, Math.max(30, Math.min(screen.size().columns, 100) - 7))
                    .split("\n")
                    .map((part, n) => [
                      seg(k || n ? "    " : `  ${term.icon(c, "warning")} `, "attention"),
                      seg(part, k ? "" : "attention"),
                    ]),
                ),
            };
      }
    }
  } finally {
    for (const ac of stops) ac.abort();
    screen.close();
  }
}

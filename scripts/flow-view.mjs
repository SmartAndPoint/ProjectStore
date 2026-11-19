#!/usr/bin/env node
// projectstore — flow-view.mjs: flow.md, the flow page beside the kanban.
//
// A team lead opens the vault and sees the flow on one page: WIP per person
// against the limit, the date each open story entered its status, the closes
// per week and the cumulative flow. The page is a derived view, a pure
// function of the stories and the vault's flow policy. It is dated by the
// vault, never by the clock: its as-of instant is the newest stamp a story
// carries, every count takes that instant, and only the `generated_at:` line
// of main() reads the clock, which reconcile and doctor drop before they
// compare. It counts nothing itself: the counts are flow-counts.mjs's, the
// stories flow-stories.mjs's.
//
// Spec: "The flow page: dated by the vault, with WIP, the date in status,
// weekly throughput and the cumulative flow" (alias `flow-view`), contracts
// 1 to 8 (the page) and 10 (doctor's `flow-view` finding). Reconcile spawns
// main() like the other generators (contract 9); doctor.mjs imports
// checkFlowView and runs it in its vault group only, never at session start
// (ADR-005 decision 4). Imports nothing of doctor.mjs, which imports this
// module, and writes no file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  loadLayout,
  readVaultConfig,
  folderByKind,
  derivedViewPaths,
  fromTerminalIn,
  nowIso,
  isMain,
  commandForm,
} from "./lib.mjs";
import { packageCommand } from "./harness.mjs";
import { flowValue, flowDeclared, wipLimitOf, isEmailAddress } from "./flow-policy.mjs";
import { readFlowStories } from "./flow-stories.mjs";
import {
  WEEK_MS,
  storyFacts,
  oldestFirst,
  wipByPerson,
  windowOf,
  windowCounts,
  weeklyCounts,
  isYoung,
  columnPath,
  cumulativeFlow,
  weekStart,
} from "./flow-counts.mjs";
import { stampMs } from "./status-log.mjs";

// The board's columns when a layout names none.
const BOARD = ["Backlog", "ToDo", "In Progress", "Review", "Done"];
const OPEN = new Set(["ToDo", "In Progress", "Review"]);
const MAX_WEEKS = 104;
const EMAIL_SHAPED = "an email-shaped name";
// The rebuild command, the core's form with no harness in it: a pure value.
const REBUILD = packageCommand([], "reconcile", { args: "--write --only flow" });
const SET_WINDOW = "npx projectstore configure --set flow.window_weeks=<weeks>";

function die(msg) {
  process.stderr.write(`projectstore/flow-view: ${msg}\n`);
  process.exit(1);
}

// ─── Text helpers (contract 2) ─────────────────────────────────────────

// A UTC date; null for an instant no Date can hold.
const day = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A table cell: on one line, and a `|` escaped, since either would end it.
const cell = (s) =>
  String(s)
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\|/g, "\\|");
// A person as the page names them: never an email-shaped word.
const person = (name) => (isEmailAddress(name) ? EMAIL_SHAPED : cell(name));
// A wikilink alias inside a table: on one line, a backslash turned to `/` (a
// trailing one would escape the link's close), `|` escaped, brackets turned
// round, so a title cannot close the link.
const alias = (s) =>
  cell(
    String(s)
      .replace(/\s*[\r\n]+\s*/g, " ")
      .replace(/\\/g, "/"),
  )
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");

// A story linked as the board links it: its path without .md, the epic its
// frontmatter claims (else its folder) and its title (else its slug).
function storyLink(f) {
  const claimed = f.fm?.epic === null || f.fm?.epic === undefined ? "" : String(f.fm.epic).trim();
  const epic = claimed && claimed !== "null" ? claimed : f.epic;
  const title = f.fm?.title ? String(f.fm.title) : f.slug;
  return `[[${f.rel.replace(/\.md$/, "")}\\|${alias(`${epic}: ${title}`)}]]`;
}

const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

// ─── Contract 1: the as-of instant ─────────────────────────────────────

// The newest stamp over every story, set-aside ones and ones with no status
// included: status_changed_at, closed_at, started_at, created (else the
// board's date) and updated, each as stampMs reads it. null when none reads.
export function asOfOf(facts) {
  let max = null;
  for (const f of facts)
    for (const ms of [stampMs(f.fm?.status_changed_at), f.closedAt, f.startedAt, f.created, f.updatedAt])
      if (ms !== null && ms !== undefined && (max === null || ms > max)) max = ms;
  return max;
}

// ─── The model: the numbers the page prints ────────────────────────────

// The page's numbers from the stories' facts, the vault config and the
// board's columns. Pure: no clock, no file.
export function flowModel(facts, vaultCfg, { columns = BOARD, unread = 0 } = {}) {
  const asOf = asOfOf(facts);
  const flow = vaultCfg && typeof vaultCfg.flow === "object" ? vaultCfg.flow : null;
  const model = {
    asOf,
    unread,
    columns,
    weeks: flowValue(vaultCfg, "window_weeks"),
    // A window_weeks that is there but not a whole number of weeks above 0.
    weeksInvalid: Boolean(flow && Object.hasOwn(flow, "window_weeks")) && flowValue(vaultCfg, "window_weeks") === null,
  };
  if (asOf === null) return model;

  model.wip = [...wipByPerson(facts)]
    .map(([name, w]) => ({ name, held: w.held.length, awaiting: w.awaiting.length, limit: wipLimitOf(vaultCfg, name) }))
    .sort((a, b) => b.held - a.held || cmp(a.name, b.name));
  model.open = oldestFirst(facts.filter((f) => OPEN.has(f.column)));
  model.backlog = facts.filter((f) => f.column === "Backlog").length;
  if (model.weeks === null) return model;

  const win = windowOf(asOf, model.weeks);
  const total = windowCounts(facts, win);
  // Weeks before the week of the earliest date a counted story carries hold
  // nothing; at most the last MAX_WEEKS of the rest are shown.
  let earliest = null;
  for (const f of facts) {
    if (f.column === null) continue;
    const first = columnPath(f).steps[0];
    for (const ms of [f.created, f.closedAt, first ? first.at : null])
      if (ms !== null && ms !== undefined && (earliest === null || ms < earliest)) earliest = ms;
  }
  let from = earliest === null ? win.to : Math.max(win.from, weekStart(earliest));
  if (from > win.to) from = win.to;
  const left = Math.round((win.to - from) / WEEK_MS);
  const hidden = Math.max(0, left - MAX_WEEKS);
  from += hidden * WEEK_MS;
  const shown = { from, to: win.to };
  model.window = {
    weeks: weeklyCounts(facts, shown).map((w) => ({
      from: w.from,
      created: w.created.length,
      closed: w.closed.length,
    })),
    created: total.created.length,
    closed: total.closed.length,
    closedUnstamped: total.closedUnstamped.length,
    young: isYoung(facts, win),
    from: win.from,
    hidden,
  };
  const cf = cumulativeFlow(facts, shown, asOf, columns);
  model.cumulative = {
    rows: cf.rows,
    approximate: cf.approximate.length,
    counted: facts.filter((f) => f.column !== null).length,
  };
  return model;
}

// ─── The page (contracts 2 to 7) ───────────────────────────────────────

export function renderFlowView(m, { generatedAt = null } = {}) {
  const asOf = m.asOf === null ? null : day(m.asOf);
  const out = [
    "---",
    "projectstore: derived",
    `generated_at: ${generatedAt === null ? "null" : generatedAt}`,
    `as_of: ${asOf === null ? "null" : asOf}`,
    "---",
    "",
    "# Flow",
    "",
  ];
  if (asOf === null) {
    out.push(
      "No story in this vault carries a date yet, so there is nothing to show. No one edits this page by hand, since this command rebuilds it:",
      ...block(REBUILD),
    );
    if (m.unread > 0) out.push("", unreadLine(m.unread));
    return `${out.join("\n")}\n`;
  }
  out.push(
    `This page shows the flow of the vault's stories as of ${asOf}, the newest date a story carries. Do not edit it by hand. To rebuild it, run:`,
    ...block(REBUILD),
  );
  if (m.unread > 0) out.push("", unreadLine(m.unread));
  if (m.weeks === null)
    out.push(
      "",
      `The weekly throughput and the cumulative flow are not shown, because the window of weeks they count over (\`flow.window_weeks\`) ${m.weeksInvalid ? "is not a whole number of weeks above 0" : "is not set"}; set it with:`,
      ...block(SET_WINDOW),
    );

  // Contract 3: WIP per person.
  out.push("", "## WIP", "");
  if (!m.wip.length) out.push("No one holds a story in In Progress or Review.");
  else
    out.push(
      "A person's WIP (work in progress) is the stories they hold in In Progress or Review, less the ones awaiting close (merged, not yet closed), which are counted apart. The limit comes from the vault's flow policy (`flow.people`, `flow.wip`); a blank limit means none is set.",
      "",
      table(
        ["Person", "WIP", "Awaiting close", "Limit"],
        m.wip.map((w) => [person(w.name), w.held, w.awaiting, w.limit === null ? "" : w.limit]),
      ),
    );

  // Contract 4: open stories and the date they entered their status.
  out.push("", "## In status since", "");
  if (!m.open.length) out.push("No story is in ToDo, In Progress or Review.");
  else
    out.push(
      "The stories in ToDo, In Progress and Review, oldest first, with the date each one entered its status. A date marked (from updated) or (from created) is read from that field, because the status stamp is missing or the status was changed by hand.",
      "",
      table(
        ["Story", "Status", "Assignee", "In status since"],
        m.open.map((f) => [
          storyLink(f),
          f.awaiting ? `${cell(f.status)} (awaiting close)` : cell(f.status),
          f.assignee ? person(f.assignee) : "",
          sinceCell(f),
        ]),
      ),
    );
  out.push("", `The Backlog holds ${plural(m.backlog, "story", "stories")}, not listed here.`);

  if (m.window) renderWindow(out, m);
  return `${out.join("\n")}\n`;
}

// A command alone in its own block, after a blank line.
const block = (cmd) => ["", "```", cmd, "```"];

const unreadLine = (n) =>
  `${plural(n, "story file", "story files")} could not be read and ${n === 1 ? "is" : "are"} left out, so the counts can be low.`;

function sinceCell(f) {
  if (f.age.at === null) return "no date";
  const d = day(f.age.at);
  return f.age.trusted ? d : `${d} (from ${f.age.source})`;
}

// Contracts 5 to 7: the throughput, the cumulative flow and its chart.
function renderWindow(out, m) {
  const w = m.window;
  const cf = m.cumulative;
  out.push(
    "",
    "## Throughput",
    "",
    `The stories created and closed in each week (Monday to Sunday, UTC) of the ${plural(m.weeks, "complete week")} before the week that holds ${day(m.asOf)} (\`flow.window_weeks\`). A story counts in the week of its \`created\` date and in the week of its \`closed_at\`.`,
  );
  if (w.young) {
    const from = day(w.from);
    out.push(
      "",
      `The vault is younger than the window: no story was created ${from ? `on or before ${from}` : "that early"}, so the weeks before its first dated week are left out.`,
    );
  }
  if (w.hidden > 0)
    out.push("", `${plural(w.hidden, "earlier week is", "earlier weeks are")} hidden; the totals cover them.`);
  out.push(
    "",
    table(
      ["Week of", "Created", "Closed"],
      [...w.weeks.map((r) => [day(r.from), r.created, r.closed]), ["Total", w.created, w.closed]],
    ),
  );
  if (w.closedUnstamped > 0)
    out.push(
      "",
      `${plural(w.closedUnstamped, "Done story has", "Done stories have")} no readable \`closed_at\`, so no week counts the close.`,
    );

  const label = (r) => (r.from === null ? `as of ${day(r.at)}` : day(r.from));
  out.push(
    "",
    "## Cumulative flow",
    "",
    "How many stories stood in each board column at the end of each week above, and now. A band that widens week after week is a queue that grows.",
    "",
    table(
      ["Week of", ...m.columns.map(cell)],
      cf.rows.map((r) => [label(r), ...m.columns.map((c) => r.counts.get(c))]),
    ),
    "",
    `${cf.approximate} of ${plural(cf.counted, "story", "stories")} ${cf.approximate === 1 ? "is placed from its dates" : "are placed from their dates"} (\`created\`, \`started_at\`, \`closed_at\`), not from a Status log, so their past weeks are approximate, and a story set aside today (parked, deferred or superseded) is in no row.`,
  );
  if (!w.weeks.length) return;

  // Contract 7: one unnamed line per running sum, Done first.
  const rev = [...m.columns].reverse();
  const sums = rev.map((_, j) => cf.rows.map((r) => rev.slice(0, j + 1).reduce((s, c) => s + r.counts.get(c), 0)));
  const max = Math.max(...sums[sums.length - 1]);
  out.push(
    "",
    `The chart draws one line per column, bottom to top: ${rev.map((c, j) => (j === 0 ? c : `plus ${c}`)).join(", ")}, so the top line is every story; the gap between two lines is a column's band, and two lines meet where a column is empty.`,
    "",
    "```mermaid",
    "xychart-beta",
    `    x-axis [${cf.rows.map((r) => JSON.stringify(label(r))).join(", ")}]`,
    `    y-axis "Stories" 0 --> ${max}`,
    ...sums.map((s) => `    line [${s.join(", ")}]`),
    "```",
  );
}

// ─── Building it from the vault ────────────────────────────────────────

// The page for a bound project's vault: the stories through readFlowStories,
// the flow keys from the vault's own `.projectstore.json`, the board's
// columns from the layout. Never throws on the vault's content: a story that
// cannot be read, or whose facts cannot be read, is left out and counted, and
// a model or a render that throws gives a page of one paragraph that says so,
// with `error` set for doctor. `read`, `model` and `render` are tests' seams.
export function buildFlowView(
  cfg,
  layout,
  { read = null, generatedAt = null, model = flowModel, render = renderFlowView } = {},
) {
  const epicsPath = folderByKind(layout, "epic")?.path ?? "epics";
  const got = readFlowStories(cfg.vault_path, epicsPath, read ? { read } : {});
  let unread = got.unread;
  const facts = [];
  for (const s of got.stories) {
    try {
      facts.push(storyFacts(s));
    } catch {
      unread++;
    }
  }
  const columns = Array.isArray(layout.kanban?.columns) && layout.kanban.columns.length ? layout.kanban.columns : BOARD;
  let m;
  let content;
  try {
    m = model(facts, readVaultConfig(cfg.vault_path), { columns, unread });
    content = render(m, { generatedAt });
  } catch (e) {
    const error = String(e?.message || e).replace(/\s*[\r\n]+\s*/g, " ");
    return {
      content: failedPage(error, generatedAt),
      stats: { as_of: null, people: 0, open: 0, backlog: 0, weeks: 0, approximate: 0, unread },
      error,
    };
  }
  return {
    content,
    stats: {
      as_of: m.asOf === null ? null : day(m.asOf),
      people: m.wip ? m.wip.length : 0,
      open: m.open ? m.open.length : 0,
      backlog: m.backlog ?? 0,
      weeks: m.window ? m.window.weeks.length : 0,
      approximate: m.cumulative ? m.cumulative.approximate : 0,
      unread,
    },
  };
}

// The page when building it threw: frontmatter as always, one paragraph.
function failedPage(error, generatedAt) {
  return [
    "---",
    "projectstore: derived",
    `generated_at: ${generatedAt === null ? "null" : generatedAt}`,
    "as_of: null",
    "---",
    "",
    "# Flow",
    "",
    `This page could not be built from the vault (${error}). Run doctor on the vault to see why; once that is fixed, this command rebuilds it:`,
    ...block(REBUILD),
    "",
  ].join("\n");
}

// ─── Contract 10: doctor's `flow-view` finding ─────────────────────────

const norm = (s) =>
  String(s)
    .split("\n")
    .filter((l) => !l.startsWith("generated_at:"))
    .join("\n")
    .trimEnd();

// Doctor's check, beside the graph's: an info when flow.md is absent and the
// vault declares a flow policy; an issue when it differs from a fresh build,
// compared as reconcile compares; a warn when the build throws. Nothing when
// the layout has no flow view block.
export function checkFlowView(cfg, layout, proj) {
  const file = derivedViewPaths(layout).flow;
  if (!file) return [];
  const finding = (level, message, extra = {}) => ({ group: "vault", level, check: "flow-view", message, ...extra });
  const cmd = REBUILD;
  const p = join(cfg.vault_path, file);
  if (!existsSync(p)) {
    if (!flowDeclared(readVaultConfig(cfg.vault_path))) return [];
    return [
      finding(
        "info",
        `No ${file} yet. It shows WIP per person, the date each open story entered its status, the weekly throughput and the cumulative flow. Create it ${fromTerminalIn(proj)}:\n${cmd}`,
      ),
    ];
  }
  let built;
  try {
    built = buildFlowView(cfg, layout);
  } catch (e) {
    built = { error: String(e?.message || e) };
  }
  if (built.error)
    return [
      finding(
        "warn",
        `${file} could not be built from the vault: ${built.error}. Fix what the error names, then rebuild it ${fromTerminalIn(proj)}:\n${cmd}`,
      ),
    ];
  let onDisk;
  try {
    onDisk = readFileSync(p, "utf8");
  } catch (e) {
    return [
      finding(
        "warn",
        `${file} could not be read: ${e?.message || e}. If it is not a plain file, move it out of the vault, then rebuild it ${fromTerminalIn(proj)}:\n${cmd}`,
        { file },
      ),
    ];
  }
  if (norm(built.content) === norm(onDisk)) return [];
  return [
    finding(
      "issue",
      `${file} is out of sync with the vault's stories or its flow policy. Rebuild it ${fromTerminalIn(proj)}:\n${cmd}`,
      { file },
    ),
  ];
}

// ─── The generator ─────────────────────────────────────────────────────

// Prints {path, content, stats}, compute only, like kanban.mjs and graph.mjs;
// reconcile --write applies it. Exits nonzero only when the project is not
// bound or the layout has no flow view block.
function main() {
  const cfg = readConfig();
  if (!cfg) die(`No projectstore config. Run ${commandForm("bind")} first.`);
  const layout = loadLayout(cfg.layout);
  const file = derivedViewPaths(layout).flow;
  if (!file) die(`Layout ${cfg.layout} declares no flow view block.`);
  const page = buildFlowView(cfg, layout, { generatedAt: nowIso() });
  process.stdout.write(
    JSON.stringify({ path: join(cfg.vault_path, file), content: page.content, stats: page.stats }, null, 2) + "\n",
  );
}

if (isMain(import.meta.url)) {
  main();
}

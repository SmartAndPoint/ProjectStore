// projectstore — skeleton.mjs: the SessionStart navigation skeleton's renderer,
// with the cells and the truncation it draws by.
//
// Moved out of lib.mjs as it was (the PS-SPECTREE story "The marker parser and
// the skeleton leave lib.mjs"). gatherVaultFacts, which reads the vault, stays
// in lib.mjs; lib.mjs re-exports every name moved here, so no importer changes.
//
// A leaf: it imports nothing of lib.mjs. harness.mjs, itself a leaf, says the
// command a message names, the same call lib.mjs's commandForm makes.

import { invocation, speakingHarness } from "./harness.mjs";

// The command a message names, in the form of the harness it is printed for
// (generation spec, contract 18).
const statusCommand = () => invocation(speakingHarness(process.env), "status", { kind: "commands" });

// (spec: the-sessionstart-navigation-skeleton-bounded-layout-derived-vault-localized)
//
// renderVaultSkeleton(facts) is pure — no filesystem, no clock. Every read it
// depends on was already made, under one deadline, by gatherVaultFacts. The
// split is what makes the bounds unit-testable without a slow filesystem, and
// what stops a second convenience being paid for out of the same budget later.

export const PURPOSE_CELL = 160; // contract 1
export const TITLE_CELL = 80; // contract 1
export const PATH_CELL = 200; // contracts 1, 19 — measured: longest path here is 123
export const INFLIGHT_CAP = 5; // contracts 1, 19
export const ERROR_CELL = 500; // contract 3

// A truncation marks itself, and the mark counts toward the budget (contract 1).
export function truncEnd(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  // Never orphan a table-cell escape: a `\|` sliced in half leaves a stray
  // backslash AND un-escapes the pipe that follows it, breaking the row.
  const tail = cut.match(/\\+$/);
  if (tail && tail[0].length % 2 === 1) cut = cut.slice(0, -1);
  return cut + "…";
}

// Front-truncation keeps the tail. For a path that is the discriminating half —
// siblings share their folder prefix and differ only in slug — and it keeps the
// filename, so the line still names the artifact to a reader (contract 19).
export function truncFront(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return "…" + t.slice(t.length - (max - 1));
}

// Contract 6: a folder's purpose is its README's own prose — the slice above the
// first `## ` heading. A README that opens with `## ` at byte 0 has no preamble.
// Missing, empty or unreadable yields the folder's KIND, never an empty cell.
export function folderPurpose(readmeText, kind) {
  const text = readmeText == null ? "" : String(readmeText);
  const m = text.match(/(^|\n)## /);
  const head = m ? text.slice(0, m.index) : text;
  const prose = head
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
  return prose ? truncEnd(prose, PURPOSE_CELL) : String(kind);
}

// Contract 19 — a path cell, with the truncation mark OUTSIDE the copyable
// token, so what a reader copies out of the backticks is a clean substring of
// the real path. `graph.md` contains zero `…` characters, so a pasted cell
// carrying one matches nothing and grep exits 1 — which reads as "this artifact
// has no graph entries", a silently false answer. Decided by equality against
// the untruncated string rather than by a leading "…", which is a character a
// path is entitled to contain.
export function pathCell(p) {
  const s = String(p ?? "");
  const t = truncFront(s, PATH_CELL);
  return t === s ? `\`${s}\`` : `…\`${t.slice(1)}\``;
}

function renderCount(counts) {
  if (!counts) return "0";
  if (counts.epics != null) {
    return `${counts.epics} epics · ${counts.stories ?? 0} stories`;
  }
  return String(counts.artifacts ?? 0);
}

function descentOrder({ kanbanFile, adrIndex, epicFile }) {
  return [
    `1. **What is in flight** — the list below, or \`${kanbanFile}\` for the whole board.`,
    `2. **The epic** — \`${epicFile}\` names its stories and how they map to code.`,
    "3. **A folder's index** — its `README.md` lists every artifact with title, status and date. One read, complete.",
    `4. **Before authoring an ADR or spec, or making an architectural choice — read \`${adrIndex}\`.** This step fires on *deciding*, not on searching: it is the one moment the decision index is load-bearing, and skipping it is how a settled question gets re-decided.`,
    "5. **An artifact's neighbourhood** — `grep '<vault-relative-path>' graph.md` returns its typed links in both directions, in one call.",
  ];
}

export function renderVaultSkeleton(facts) {
  const f = facts || {};
  const L = [];

  if (f.vaultMissing) {
    return `# projectstore: vault not found at ${truncFront(String(f.vaultPath ?? ""), PATH_CELL)}\n`;
  }

  // Contract 10 — the header carries the session-relevant policy. Absent vault
  // config renders the documented defaults rather than blanks.
  // Contract 3 — the vault path is bounded only by PATH_MAX, so it is a term of
  // the composed cap like any other. Front-truncated for contract 19's second
  // reason: the tail is the discriminating half of a path.
  L.push(`# Projectstore vault: ${truncFront(String(f.vaultPath ?? ""), PATH_CELL)}`);
  // Contract 3 — these four are user-supplied config, and config is free text.
  // The previous revision interpolated them raw, which put the 10,000-character
  // breach back into the very line this change added: a 3,000-character
  // `language` composed a 12,049-character payload. A structural bound is
  // exactly as good as its enumeration, and this was the third miss.
  const cell = (v, dflt) => truncEnd(String(v || dflt), TITLE_CELL);
  L.push(
    `# Layout: ${cell(f.layoutName, "unknown")} · language: ${cell(f.language, "en")}` +
      ` · spec_policy: ${cell(f.specPolicy, "optional")}` +
      ` · lifecycle_gates: ${cell(f.lifecycleGates, "on")}`,
  );
  L.push("");

  // Contract 9 — all five steps, resolved through the layout, never typed.
  L.push("## How to work with this vault");
  L.push("");
  L.push("Descend on demand. Nothing below is a copy of the vault; it is the order to read it in.");
  L.push("");
  for (const step of descentOrder(f)) L.push(step);
  L.push("");

  // Contract 4 — one row per layout folder, iterated, never listed literally.
  L.push("## Where things live");
  L.push("");
  L.push("| Folder | Kind | Count | Purpose |");
  L.push("|---|---|---|---|");
  for (const folder of f.folders || []) {
    L.push(
      `| \`${folder.path}/\` | ${folder.kind} | ${renderCount(folder.counts)} | ` +
        `${folderPurpose(folder.readme, folder.kind)} |`,
    );
  }
  L.push("");

  // Contracts 15, 21 — ordered most-recently-started first, capped, and the
  // expired case says so rather than rendering an empty list, which would be a
  // different and possibly false claim.
  L.push("## In flight now");
  L.push("");
  const inf = f.inFlight || {};
  if (inf.status === "timeout") {
    L.push(`- in-flight work not resolved within budget — see \`${f.kanbanFile}\` § In Progress`);
  } else {
    const entries = inf.entries || [];
    if (entries.length === 0) {
      L.push("- nothing in progress");
    } else {
      for (const e of entries.slice(0, INFLIGHT_CAP)) {
        // `epic` is a directory name — bounded only by NAME_MAX, five times over.
        L.push(`- ${truncEnd(e.epic, TITLE_CELL)} · ${truncEnd(e.title, TITLE_CELL)}`);
      }
      const more = (inf.total ?? entries.length) - Math.min(entries.length, INFLIGHT_CAP);
      if (more > 0) L.push(`- …and ${more} more; see \`${f.kanbanFile}\``);
    }
  }
  L.push("");

  // Contracts 19, 21 — the continuity section. Present only when the gather was
  // asked for it, which is only on `source === "compact"`: a positive test, in
  // one place. Absence here asserts nothing at all, which is why empty and
  // unreadable may share it while an empty in-flight list may not.
  const cont = f.continuity;
  if (cont) {
    if (cont.status === "timeout") {
      L.push("## Where this session left off");
      L.push("");
      L.push(`- recent activity not resolved within budget — run \`${statusCommand()}\``);
      L.push("");
    } else if (cont.paths && cont.paths.length > 0) {
      L.push("## Where this session left off");
      L.push("");
      L.push("Vault files this conversation touched before it was compacted, newest first.");
      L.push("");
      for (const p of cont.paths.slice(0, INFLIGHT_CAP)) L.push(`- ${pathCell(p)}`);
      const more = (cont.total ?? cont.paths.length) - Math.min(cont.paths.length, INFLIGHT_CAP);
      if (more > 0) L.push(`- …and ${more} more; see \`${statusCommand()}\``);
      if (cont.artifact) {
        L.push("");
        L.push(
          `**In flight**: ${pathCell(cont.artifact)} was the newest structured write before` +
            " compaction. If we were drafting it, continue from there.",
        );
      }
      L.push("");
    }
  }

  // Contracts 8, 11 — the recipe, the prohibition, and the staleness clause.
  L.push("## Derived views");
  L.push("");
  L.push(
    `\`${f.kanbanFile}\`, \`code-map.md\` and \`graph.md\` are **regenerated** from artifact` +
      " frontmatter. They can lag a very recent edit, they are never hand-edited, and the" +
      " artifact is the source of truth when they disagree.",
  );
  L.push("");
  L.push(
    "`graph.md` is queried, **never read whole** — it is far larger than this payload's" +
      " whole budget. Grep it by **vault-relative path**, which is its node key; a bare slug" +
      " is not a key and returns a flood (on one real vault, 22 lines by path against 101 by" +
      " slug). `code-map.md` answers where code for an epic already lives — read it before" +
      " deciding where new code goes.",
  );

  return L.join("\n") + "\n";
}

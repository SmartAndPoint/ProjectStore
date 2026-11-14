// What belongs to an item: its specs, ADRs and other documents, and which
// contracts of a spec (or decisions of an ADR) it touches. The server reads
// it from the core's link graph and from the amendment marks inside specs.
// The side panel shows it short, beside the text; the long form, with every
// changed contract spelled out, opens in place of the text.

const DOC_KINDS = ["spec", "adr", "research", "concept", "runbook", "meeting"];
const relatedCount = (r) => r.groups.filter((g) => DOC_KINDS.includes(g.kind)).reduce((n, g) => n + g.items.length, 0);

function openByRel(rel) {
  const a = artByRel.get(rel);
  if (!a) return;
  const [kind, id] = kindAndId(a);
  if (id) openDrawer(kind, id);
}

// A row of numbered cells, one per contract or decision.
function partsStrip(parts, many) {
  if (!parts || !parts.total) return null;
  const touched = parts.items.filter((p) => p.marks.length);
  const named = parts.items.filter((p) => !p.marks.length && p.cites.length);
  const tip = (p) =>
    [`${parts.word} ${p.n}: ${p.title}`, ...p.marks.map((m) => `${m.op.toLowerCase()} ${m.date} by ${m.story.title}`), p.cites.length ? `named in the text of: ${[...new Set(p.cites.map((c) => c.title))].join("; ")}` : ""].filter(Boolean).join("\n");
  return h(
    "div",
    { class: "parts-box" },
    h(
      "div",
      { class: "parts", role: "list", "aria-label": `${parts.word}s` },
      parts.items.map((p) => h("span", { class: `part${p.marks.length ? " am" : p.cites.length ? " ci" : ""}`, title: tip(p), role: "listitem" }, p.n)),
      h("span", { class: "parts-sum" }, touched.length ? `${touched.length} of ${parts.total} ${parts.word}s changed` : named.length ? `${named.length} of ${parts.total} named` : `${parts.total} ${parts.word}s, none touched`),
    ),
    touched.map((p) =>
      h(
        "div",
        { class: "part-row" },
        h("div", { class: "part-h" }, h("span", { class: "part am" }, p.n), h("b", null, p.title)),
        p.marks.map((m) =>
          h(
            "div",
            { class: "part-m" },
            h("span", { class: "chip" }, `${m.op.toLowerCase()} ${m.date}`),
            many && m.story.rel ? h("button", { class: "link", onclick: () => openByRel(m.story.rel) }, m.story.title) : many ? h("span", { class: "dim" }, m.story.title) : null,
            h("span", { class: "dim" }, m.what.length > 220 ? `${m.what.slice(0, 220)}…` : m.what),
          ),
        ),
      ),
    ),
    named.length ? h("div", { class: "part-named" }, `Named in the text, with no mark: ${parts.word}${named.length > 1 ? "s" : ""} ${named.map((p) => p.n).join(", ")}`) : null,
  );
}

const statusPill = (status) =>
  status ? h("span", { class: `pill ${status === "accepted" || status === "active" || status === "final" || status === "done" ? "done" : status === "superseded" || status === "deferred" ? "aside" : "backlog"}` }, status) : null;

// The same cells with no text under them: for the side panel. The tip of a cell says what the text would.
function partsMini(parts) {
  if (!parts || !parts.total) return null;
  const touched = parts.items.filter((p) => p.marks.length).length;
  const named = parts.items.filter((p) => !p.marks.length && p.cites.length).length;
  const tip = (p) =>
    [`${parts.word} ${p.n}: ${p.title}`, ...p.marks.map((m) => `${m.op.toLowerCase()} ${m.date} by ${m.story.title}`), p.cites.length ? `named in the text of: ${[...new Set(p.cites.map((c) => c.title))].join("; ")}` : ""].filter(Boolean).join("\n");
  return h(
    "div",
    { class: "parts-mini" },
    h("div", { class: "parts", role: "list", "aria-label": `${parts.word}s` }, parts.items.map((p) => h("span", { class: `part${p.marks.length ? " am" : p.cites.length ? " ci" : ""}`, title: tip(p), role: "listitem" }, p.n))),
    h("div", { class: "faint" }, touched ? `${touched} of ${parts.total} ${parts.word}s changed` : named ? `${named} of ${parts.total} named in a text` : `${parts.total} ${parts.word}s, none touched`),
  );
}

// The side panel's Related block: the item's specs, ADRs and other documents,
// short, beside the text. A group with many entries starts closed.
const SIDE_OPEN = 6;
function relatedSide(d) {
  const r = d.related;
  const full = h("button", { class: "link", onclick: () => showTab(d, d.tab === "rel" ? "doc" : "rel") }, d.tab === "rel" ? "back to the text" : "in full");
  if (!r) return h("div", { class: "side-rel" }, h("h3", null, "Related"), h("div", { class: "faint" }, "reading the graph…"));
  ui.relOpen ??= {};
  const group = (g, body) => {
    // What a person opened or closed is kept for this kind of item. The click is recorded, not the
    // toggle event: a group drawn open fires that event by itself.
    const key = `${d.kind}:${g.kind}`;
    const open = ui.relOpen[key] ?? g.items.length <= SIDE_OPEN;
    const remember = (e) => setTimeout(() => (ui.relOpen[key] = e.target.closest("details").open));
    return h("details", { open }, h("summary", { onclick: remember }, kindIco(g.kind), g.label, h("span", { class: "faint" }, g.items.length)), body);
  };
  const doc = (it) =>
    h(
      "div",
      { class: "srel" },
      h("button", { class: "link", onclick: () => openByRel(it.rel), title: it.title }, it.title),
      h("div", { class: "srel-meta" }, statusPill(it.status), h("span", null, it.how.join(" · ")), it.through ? h("span", { title: `through the spec “${it.through}”` }, "through a spec") : null),
      partsMini(it.parts),
    );
  const docs = r.groups.filter((g) => DOC_KINDS.includes(g.kind));
  const rest = r.groups.filter((g) => !DOC_KINDS.includes(g.kind));
  return h(
    "div",
    { class: "side-rel" },
    h("h3", { class: "side-h" }, h("span", null, `Related${relatedCount(r) ? ` · ${relatedCount(r)}` : ""}`), r.groups.length ? full : null),
    r.self && r.self.total ? [h("div", { class: "srel-self" }, r.type === "spec" ? "This spec's contracts" : "This ADR's decisions"), partsMini(r.self)] : null,
    docs.map((g) => group(g, g.items.map(doc))),
    rest.map((g) =>
      group(
        g,
        h(
          "div",
          { class: "srel-list" },
          g.items.slice(0, 30).map((it) => h("button", { class: "link", onclick: () => openByRel(it.rel), title: it.how.join(", ") }, it.title)),
          g.items.length > 30 ? h("span", { class: "faint" }, `and ${g.items.length - 30} more, in full`) : null,
        ),
      ),
    ),
    !r.groups.length ? h("div", { class: "faint" }, "No other artifact links to this one, and it links to none.") : null,
  );
}

function relatedView(d) {
  const r = d.related;
  if (!r) return h("div", { class: "faint", style: "padding:14px 0" }, "reading the graph…");
  const many = r.scope.stories > 1 || r.type === "spec" || r.type === "adr";
  const scope =
    r.type === "epic"
      ? `For this epic and its ${r.scope.stories} stories.`
      : r.type === "initiative"
        ? `For this initiative, its ${r.scope.epics} epic${r.scope.epics === 1 ? "" : "s"} and their ${r.scope.stories} stories.`
        : r.type === "spec"
          ? `The ${r.scope.stories} stories this spec covers or was changed by.`
          : r.type === "adr"
            ? `The ${r.scope.stories} stories that link to this ADR.`
            : "For this story.";
  const card = (it) =>
    h(
      "div",
      { class: "rel-card" },
      h(
        "div",
        { class: "rel-h" },
        h("button", { class: "link rel-t", onclick: () => openByRel(it.rel) }, it.title),
        statusPill(it.status),
      ),
      h(
        "div",
        { class: "rel-how" },
        it.how.map((x) => h("span", { class: `chip${/amend/.test(x) ? " flag" : ""}` }, x)),
        it.through ? h("span", { class: "chip" }, `through the spec “${it.through.slice(0, 44)}${it.through.length > 44 ? "…" : ""}”`) : null,
        it.covers > 1 ? h("span", { class: "chip" }, `covers ${it.covers} of the stories`) : null,
        many && it.fromCount ? h("span", { class: "faint", title: it.from.join("\n") }, `from ${it.fromCount} item${it.fromCount === 1 ? "" : "s"}`) : null,
      ),
      partsStrip(it.parts, many),
    );
  return h(
    "div",
    { class: "rel" },
    h("div", { class: "rel-note" }, scope, " Documents come from the vault's link graph. Changed contracts come from the amendment marks inside each spec."),
    h(
      "div",
      { class: "rel-legend" },
      h("span", { class: "part am" }, "n"),
      " changed by a story: a mark in the spec says so",
      h("span", { class: "part ci" }, "n"),
      " only named in a text",
      h("span", { class: "part" }, "n"),
      " not touched",
    ),
    r.self && r.self.total ? [h("h3", null, r.type === "spec" ? "This spec's contracts" : "This ADR's decisions"), partsStrip(r.self, true)] : null,
    r.groups.map((g) => [h("h3", null, kindIco(g.kind), `${g.label} · ${g.items.length}`), DOC_KINDS.includes(g.kind) ? g.items.map(card) : h("div", { class: "linklist" }, g.items.slice(0, 40).map((it) => h("div", { class: "line" }, h("button", { class: "link", onclick: () => openByRel(it.rel) }, it.title), h("span", { class: "faint" }, it.how.join(", ")))))]),
    !r.groups.length ? h("div", { class: "empty" }, "No other artifact links to this one, and it links to none.") : null,
    h("div", { class: "rel-foot" }, `Edges: ${r.read.graph} (${r.read.nodes} nodes, ${r.read.edges} edges, ${r.read.ms} ms). Contracts: ${r.read.marks}.`),
  );
}

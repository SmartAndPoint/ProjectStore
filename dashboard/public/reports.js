// Reports: how the work flows, and the board against the code (the spec "The
// dashboard's Reports…", alias `dashboard-reports`, contracts 9 and 10). The
// server counts with the core's own flow functions (GET /api/reports, no
// process) and reads the board against the project's pull requests through the
// Code block's read (POST /api/reports/code); this file asks for a day, a
// window and a filter, and draws. Loaded after views.js and code.js, and
// shares their helpers (h, fill, ui, S, render, syncHash, openByRel, ico).
//
// The day, the window and the filter are in the address, so a picture can be
// shared: #/reports?asof=2026-11-02&weeks=8&epic=PS-FLOW. Every date is UTC.
// Every title is drawn as text; a link out is only an https: address gh gave.

const reportsUi = (() => {
  const KEYS = ["asof", "weeks", "epic", "initiative", "assignee", "priority"];
  const CODE_ROUTE = "/api/reports/code";
  const token = () => document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const validDay = (s) => day.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
  // What each filter accepts; a value outside it is dropped from the address (contract 10).
  const VALID = {
    asof: validDay,
    weeks: (s) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 26,
    epic: (s) => /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(s),
    initiative: (s) => s === "none" || /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(s),
    assignee: (s) => s.length <= 100 && !s.includes("@") && !/[\u0000-\u001f\u007f]/.test(s),
    priority: (s) => /^p[0-3]$/.test(s),
  };
  let want = {}; // the filters, as the address spells them
  let flow = null; // the last flow answer: it stays drawn, dimmed, while the next is read
  let flowAsked = null;
  let flowFor = null; // the query the drawn answer belongs to
  let code = null; // { ok, result } or { ok: false, error }
  let codeAsked = null;
  let codeBusy = false;
  let seq = 0;

  const query = () => new URLSearchParams(KEYS.filter((k) => want[k]).map((k) => [k, want[k]])).toString();
  function apply(q) {
    const p = new URLSearchParams(q || "");
    want = {};
    for (const k of KEYS) if (p.has(k) && VALID[k](p.get(k))) want[k] = p.get(k);
  }
  function set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || v === null || v === undefined) delete want[k];
      else want[k] = String(v);
    }
    render();
  }
  const link = () => `${location.origin}${location.pathname}#/reports${query() ? `?${query()}` : ""}`;

  // ── the two reads ──
  async function askFlow(q) {
    flowAsked = q;
    let a;
    try {
      const r = await fetch(`/api/reports${q ? `?${q}` : ""}`, { cache: "no-store" });
      a = await r.json();
    } catch (e) {
      a = { error: `the page's server did not answer: ${e?.message || e}` };
    }
    if (flowAsked !== q) return;
    flow = a;
    flowFor = q;
    if (ui.view === "reports") render();
  }
  async function askCode(q, fresh = false) {
    codeAsked = q;
    codeBusy = true;
    const mine = ++seq;
    if (fresh && ui.view === "reports") render();
    let a;
    try {
      const r = await fetch(CODE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", "x-projectstore-token": token() },
        body: JSON.stringify({ ...want, ...(fresh ? { fresh: true } : {}) }),
        cache: "no-store",
        credentials: "same-origin",
      });
      a = await r.json();
    } catch (e) {
      a = { ok: false, error: `the page's server did not answer: ${e?.message || e}` };
    }
    if (mine !== seq) return;
    codeBusy = false;
    code = a;
    if (ui.view === "reports") render();
  }
  // R and ↻: both reads again; "Check again" sends `fresh` for a new list of pull requests.
  function again({ fresh = false } = {}) {
    flowAsked = null;
    flowFor = null;
    codeAsked = null;
    if (fresh) askCode(query(), true);
    else if (ui.view === "reports") render();
  }

  // ── small pieces ──
  const SVG = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const shortDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const longDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const val = (t) => (t && typeof t === "object" && "value" in t ? t.value : t);
  const shown = (v, unit = "") => (v === null || v === undefined ? "–" : `${v}${unit}`);
  const own = (t) => (t?.by === "page" ? h("span", { class: "chip own", title: t.basis }, "this page's own") : null);
  // A number with its basis in the tip, and "this page's own" when the page made it up (contract 9).
  const numEl = (t, unit = "") => h("span", { class: "rep-n", title: t?.basis ? `Counted by ${t.basis}` : null }, shown(val(t), unit), own(t));
  const storyBtn = (s) => h("button", { class: "link", onclick: () => openByRel(s.rel), title: s.rel }, s.title);
  const isHttps = (u) => typeof u === "string" && /^https:\/\//i.test(u);
  const ext = (url, text) => (isHttps(url) ? h("a", { class: "link ext", href: url, target: "_blank", rel: "noopener noreferrer" }, text) : h("span", null, text));
  const prLine = (p) => h("span", { class: "rep-pr" }, ext(p.url, p.number ? `#${p.number}` : "a pull request"), " ", h("span", { class: "faint" }, p.title || ""));
  // The Monday after a week: the as-of day whose window ends with that week (contract 10).
  const mondayAfter = (fromIso) => new Date(Date.parse(fromIso) + 7 * 864e5).toISOString().slice(0, 10);

  // One tip for every chart: the value leads, the name follows.
  const tip = h("div", { class: "viz-tip", role: "status", hidden: true });
  function showTip(e, title, rows) {
    if (!tip.isConnected) document.body.append(tip);
    fill(tip, h("div", { class: "viz-tip-t" }, title), rows.map(([key, value, name]) => h("div", { class: "viz-tip-r" }, key ? h("i", { class: `key ${key}` }) : null, h("b", null, value), h("span", null, name))));
    tip.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    const at = e.type === "focus" || e.clientX === undefined ? { x: r.left + r.width / 2, y: r.top } : { x: e.clientX, y: e.clientY };
    tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, at.x + 14))}px`;
    tip.style.top = `${Math.max(8, at.y - tip.offsetHeight - 12)}px`;
  }
  const hideTip = () => (tip.hidden = true);
  const tipOn = (title, rows) => ({ onpointermove: (e) => showTip(e, title, rows), onpointerleave: hideTip, onfocus: (e) => showTip(e, title, rows), onblur: hideTip });

  // A chart is drawn at the width it has, and drawn again when that changes.
  function chartBox(draw) {
    const box = h("div", { class: "viz-plot" });
    let last = 0;
    const paint = (w) => {
      if (!w || Math.abs(w - last) < 2) return;
      last = w;
      box.replaceChildren(draw(Math.round(w)));
    };
    paint(520);
    if (typeof ResizeObserver === "function") new ResizeObserver((es) => paint(es[0].contentRect.width)).observe(box);
    requestAnimationFrame(() => paint(box.clientWidth));
    return box;
  }
  function ticks(max) {
    if (!(max > 0)) return [0, 1];
    const raw = max / 4;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw);
    const out = [];
    for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }
  const H = 200;
  const PAD = { l: 34, r: 10, t: 10, b: 24 };
  function frame(w, max, weeks) {
    const ys = ticks(max);
    const top = ys[ys.length - 1];
    const x1 = w - PAD.r;
    const y0 = H - PAD.b;
    const band = (x1 - PAD.l) / Math.max(1, weeks.length);
    const y = (v) => y0 - ((y0 - PAD.t) * v) / top;
    const every = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor((x1 - PAD.l) / 54))));
    const g = svgEl(
      "g",
      null,
      ys.map((v) => [svgEl("line", { class: v ? "viz-grid" : "viz-axis", x1: PAD.l, x2: x1, y1: y(v), y2: y(v) }), svgEl("text", { class: "viz-tick", x: PAD.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, v)]),
      weeks.map((wk, i) => (i % every === 0 ? svgEl("text", { class: "viz-tick", x: PAD.l + band * (i + 0.5), y: H - 7, "text-anchor": "middle" }, shortDay(wk.from)) : null)),
    );
    return { g, x0: PAD.l, band, y, y0 };
  }
  const colPath = (x, yTop, w, hgt, round) => {
    const r = round ? Math.min(4, w / 2, hgt) : 0;
    return `M${x} ${yTop + hgt}V${yTop + r}${r ? `Q${x} ${yTop} ${x + r} ${yTop}` : ""}H${x + w - r}${r ? `Q${x + w} ${yTop} ${x + w} ${yTop + r}` : ""}V${yTop + hgt}Z`;
  };
  const weekTitle = (wk) => `Week of ${shortDay(wk.from)}`;
  const pick = (wk) => () => set({ asof: mondayAfter(wk.from) });
  // The hit area is the whole week; a click reads the page as of the Monday after it.
  const hit = (f, i, wk, rows) =>
    svgEl("rect", { class: "viz-hit", x: f.x0 + f.band * i, y: PAD.t, width: f.band, height: f.y0 - PAD.t, tabindex: 0, role: "button", "aria-label": `${weekTitle(wk)}: ${rows.map(([, v, n]) => `${v} ${n}`).join(", ")}. Read the page as of the Monday after it.`, ...tipOn(weekTitle(wk), rows), onclick: pick(wk), onkeydown: (e) => e.key === "Enter" && pick(wk)() });
  // Stacked columns, one per week: the parts are given bottom first.
  function stacked(weeks, parts, label) {
    return chartBox((w) => {
      const max = Math.max(1, ...weeks.map((wk) => parts.reduce((n, p) => n + wk[p.key], 0)));
      const f = frame(w, max, weeks);
      const bw = Math.min(24, Math.max(4, f.band - 6));
      const svg = svgEl("svg", { width: w, height: H, role: "img", "aria-label": label }, f.g);
      weeks.forEach((wk, i) => {
        const x = f.x0 + f.band * i + (f.band - bw) / 2;
        let base = 0;
        const live = parts.filter((p) => wk[p.key] > 0);
        live.forEach((p, k) => {
          const yTop = f.y(base + wk[p.key]);
          const hgt = Math.max(0, f.y(base) - yTop - (k < live.length - 1 ? 2 : 0));
          svg.append(svgEl("path", { class: `viz-fill ${p.cls}`, d: colPath(x, f.y(base) - hgt, bw, hgt, k === live.length - 1) }));
          base += wk[p.key];
        });
        svg.append(hit(f, i, wk, [...parts].reverse().map((p) => [p.cls, wk[p.key], p.name])));
      });
      return svg;
    });
  }
  // Two columns side by side per week.
  function paired(weeks, a, b, label) {
    return chartBox((w) => {
      const max = Math.max(1, ...weeks.map((wk) => Math.max(wk[a.key], wk[b.key])));
      const f = frame(w, max, weeks);
      const bw = Math.min(14, Math.max(3, (f.band - 8) / 2));
      const svg = svgEl("svg", { width: w, height: H, role: "img", "aria-label": label }, f.g);
      weeks.forEach((wk, i) => {
        const mid = f.x0 + f.band * (i + 0.5);
        [a, b].forEach((p, k) => {
          if (!wk[p.key]) return;
          const yTop = f.y(wk[p.key]);
          svg.append(svgEl("path", { class: `viz-fill ${p.cls}`, d: colPath(k ? mid + 1 : mid - bw - 1, yTop, bw, f.y0 - yTop, true) }));
        });
        svg.append(hit(f, i, wk, [[a.cls, wk[a.key], a.name], [b.cls, wk[b.key], b.name]]));
      });
      return svg;
    });
  }
  const legend = (...items) => h("div", { class: "viz-legend" }, items.map(([cls, name]) => h("span", null, h("i", { class: `key ${cls}` }), name)));
  const card = (title, sub, ...kids) => h("div", { class: "panel viz-card" }, h("h2", null, title), sub ? h("div", { class: "viz-sub" }, sub) : null, kids);
  function tile(label, t, prev, unit, note) {
    const v = val(t);
    const p = val(prev);
    return h("div", { class: "panel kpi" }, h("div", { class: "kpi-l" }, label), h("div", { class: "kpi-v" }, numEl(t), unit && v !== null ? h("small", null, unit) : null), h("div", { class: "kpi-d" }, p === null || p === undefined ? note || "" : [numEl(prev), " in the window before"]));
  }

  // ── the filters ──
  function filters(F) {
    const sel = (key, label, options, title) =>
      h("label", { class: "rep-f", title }, h("span", null, label), h("select", { "aria-label": label, onchange: (e) => set({ [key]: e.target.value }) }, (want[key] && !options.some(([v]) => v === want[key]) ? [...options, [want[key], want[key]]] : options).map(([v, t]) => h("option", { value: v, selected: (want[key] || "") === v }, t))));
    const ends = (F?.weekly || []).map((wk) => [mondayAfter(wk.from), `the week of ${shortDay(wk.from)}`]).reverse();
    if (want.asof && !ends.some(([v]) => v === want.asof)) ends.unshift([want.asof, longDay(`${want.asof}T00:00:00Z`)]);
    const names = [...new Set([...S.people.map((p) => p.name), ...S.stories.map((s) => s.assignee).filter(Boolean)])].filter((n) => VALID.assignee(n)).sort();
    const any = KEYS.some((k) => want[k]);
    const fw = F?.weeks;
    return h(
      "div",
      { class: "toolbar rep-filters" },
      sel("asof", "As of", [["", "today"], ...ends], "The day the page is read as of; its own week is not counted. A click on a week in a chart sets it."),
      sel("weeks", "Window", [["", fw && !want.weeks ? `${fw.value} weeks${fw.from === "page" ? ", this page's own" : ""}` : "as the vault sets it"], ...[2, 4, 8, 12, 26].map((n) => [String(n), `${n} weeks`])], "How many whole weeks before the as-of week are counted"),
      sel("epic", "Epic", [["", "all epics"], ...S.epics.map((e) => [e.id, `${e.id} · ${String(e.title).slice(0, 40)}`])]),
      S.initiatives.length ? sel("initiative", "Initiative", [["", "all"], ["none", "no initiative"], ...S.initiatives.map((i) => [i.id, String(i.title).slice(0, 44)])]) : null,
      sel("assignee", "Who", [["", "everyone"], ...names.map((n) => [n, n])], "A name shaped like an email address cannot be chosen: the page reads no addresses."),
      sel("priority", "Priority", [["", "any"], ...PRI.map((p) => [p, p])]),
      any ? h("button", { class: "link", onclick: () => ((want = {}), render()) }, "Clear") : null,
      h("span", { class: "grow" }),
      h("button", { class: "btn ghost", onclick: () => copyText(link(), "A link to this report"), title: "The address of this report, with its day, window and filters" }, "Copy link"),
    );
  }

  // ── the flow part (contracts 1 to 4) ──
  const fetchedAt = () => (S.write?.fetched_at ? `${longDay(S.write.fetched_at)}, ${new Date(S.write.fetched_at).toISOString().slice(11, 16)} UTC` : null);
  // A key of the flow policy that is absent: no verdict, and how to set it (contract 3).
  const unsetLine = (u) => h("div", { class: "sig-w" }, `The vault sets no ${u.unset}, so nothing is judged. To set it:`, h("code", { class: "rep-cmd" }, `projectstore configure ${u.form || `--set ${u.unset}=…`}`));
  const marksLine = (c) => (val(c.untrusted) || val(c.undated) ? h("div", { class: "sig-basis" }, [val(c.untrusted) ? `${plural(val(c.untrusted), "age")} read from a date that is not a status stamp` : null, val(c.undated) ? `${plural(val(c.undated), "story", "stories")} with no date` : null].filter(Boolean).join("; "), ".") : null);
  const COLUMN_LABEL = { review: "Waiting in Review", todo: "Waiting in ToDo", in_progress: "Long in In Progress" };
  function standRow(label, count, u, items, extra) {
    const unset = u?.unset;
    const cls = unset ? "info" : val(count) ? "watch" : "ok";
    const [mark, word] = unset ? ["i", "No threshold"] : val(count) ? ["◆", "Watch"] : ["✓", "Fine"];
    return h(
      "div",
      { class: `sig sig-${cls}` },
      h("div", { class: "sig-v" }, h("span", { class: "sig-mark", "aria-hidden": "true" }, mark), word),
      h(
        "div",
        { class: "sig-b" },
        h("div", { class: "sig-t" }, h("b", null, label), count ? h("span", { class: "sig-n" }, numEl(count)) : null),
        unset ? unsetLine(u) : h("div", { class: "sig-basis" }, `Counted by ${count.basis}.`),
        extra,
        items.length ? h("details", null, h("summary", null, unset ? `the oldest ${items.length}` : plural(items.length, "item")), h("div", { class: "linklist sig-items" }, items.map((x) => h("div", { class: "line" }, storyBtn(x), x.epic && x.rel.includes("/stories/") ? h("span", { class: "chip" }, x.epic) : null, x.days ? h("span", { class: "faint" }, numEl(x.days, " days")) : null)))) : null,
      ),
    );
  }
  function standing(T) {
    const rows = T.columns.map((c) => standRow(COLUMN_LABEL[c.id], c.count, c, c.stories, marksLine(c)));
    if (T.epics) rows.push(standRow("Epics without movement", T.epics.count, T.epics, T.epics.epics, h("div", { class: "sig-basis" }, `Each epic is judged over all its stories${T.epics.narrowed ? "; the person and priority filters do not narrow it" : ""}. ${plural(val(T.epics.watched), "epic")} in progress watched.`)));
    const V = T.verdicts;
    let verdicts;
    if (V.left) verdicts = h("div", { class: "sig-w" }, `Arrivals and capacity: ${V.left}.`);
    else if (V.unset) verdicts = h("div", null, h("b", null, "Arrivals and capacity"), unsetLine(V));
    else
      verdicts = h(
        "div",
        { class: "sig-w" },
        `Arrivals and capacity, as doctor judges them over the ${val(V.weeks)} weeks from ${longDay(V.from)}: `,
        V.young ? "the vault is younger than that window, so neither is judged." : [`${val(V.created)} created, ${val(V.closed)} closed`, V.intakeOverClose ? ": more come in than are closed. " : ". "],
        V.capacity?.unset ? ["ToDo against capacity: ", h("code", { class: "rep-cmd" }, `projectstore configure ${V.capacity.form}`)] : V.capacity ? `ToDo against capacity: ${V.capacity.verdict}, at ${val(V.capacity.throughput)} closed a week.` : null,
      );
    return h("div", { class: "panel" }, h("h2", null, "What stands still"), h("div", { class: "viz-sub" }, "As of now. A threshold is the vault's flow policy; the days in In Progress have no key, so they are this page's own."), rows, h("div", { class: "sig-quiet" }, verdicts));
  }
  function flowPart(F) {
    const copy = F.copy === "clone" ? `the page's changes, on the vault as last fetched${fetchedAt() ? ` (${fetchedAt()})` : ""}` : "the vault folder";
    const scope = h(
      "div",
      { class: "rep-scope" },
      `Counted over ${longDay(F.window.from)} to ${longDay(Date.parse(F.window.to) - 864e5)}: the ${F.weeks.value} whole weeks${F.weeks.from === "page" ? " (this page's own window: the vault sets no flow.window_weeks)" : ""} before the week of ${longDay(F.asOf)}, which is not counted. `,
      F.young.value ? "The vault is younger than the window, so there is no cycle time and nothing earlier to compare with. " : "",
      F.today ? "" : "A past day reads the files as they are now: an anchor, not a time machine. ",
      `Dates are UTC. Counting ${copy}.`,
      val(F.unread) ? ` ${plural(val(F.unread), "story file")} could not be read.` : "",
      F.policyUnread ? " The vault's .projectstore.json could not be read, so no key of the flow policy is taken." : "",
      val(F.policyProblems) ? ` ${plural(val(F.policyProblems), "key")} of the flow policy ${val(F.policyProblems) === 1 ? "is" : "are"} set wrong and read as absent.` : "",
    );
    const prev = (t) => (F.young.value || F.previous.young ? null : t);
    const tiles = h(
      "div",
      { class: "kpis" },
      tile("Created", F.window.created, prev(F.previous.created)),
      tile("Closed", F.window.closed, prev(F.previous.closed)),
      tile("Cycle time, median", F.window.cycle, null, "days", val(F.window.placed) === null ? "none while the vault is young" : `of ${val(F.window.placed)} closed with a start`),
      val(F.window.closedUnstamped) ? tile("Done with no closed_at", F.window.closedUnstamped, null, "", "counted in no week") : null,
      F.window.unplaced.length ? tile("Closed with no start", { value: F.window.unplaced.length, by: "core", basis: "cycleTime, unplaced" }, null, "", "no cycle time") : null,
    );
    const people = F.standing?.people.length
      ? h(
          "div",
          { class: "panel" },
          h("h2", null, "Who holds what"),
          F.standing.peopleWhole ? h("div", { class: "viz-sub" }, "Each person's work in progress counts all their stories, whatever the filter, against their limit.") : null,
          h(
            "table",
            { class: "plain num" },
            h("thead", null, h("tr", null, ["Who", "In work", "Waiting to close", "Limit"].map((t) => h("th", null, t)))),
            h("tbody", null, F.standing.people.map((p) => h("tr", null, h("td", null, p.name), h("td", { class: p.over ? "over" : "" }, numEl(p.wip)), h("td", null, numEl(p.awaiting)), h("td", null, p.limit ? numEl(p.limit) : "–")))),
          ),
        )
      : null;
    const weeks = F.weekly.map((wk) => ({ from: wk.from, created: val(wk.created), closed: val(wk.closed), cycle: val(wk.cycle) }));
    const rows = F.flow.rows
      .filter((r) => !r.now)
      .map((r, i) => {
        const c = (k) => val(r.counts[k]) || 0;
        return { from: F.weekly[i]?.from ?? r.at, backlog: c("Backlog"), todo: c("ToDo"), progress: c("In Progress"), review: c("Review"), done: c("Done") };
      });
    const blank = !weeks.length || (weeks.every((wk) => !wk.created && !wk.closed) && rows.every((r) => !(r.backlog || r.todo || r.progress || r.review || r.done)));
    const charts = blank
      ? h("div", { class: "panel empty" }, "No story matches, or nothing happened in these weeks, so there is nothing to draw.")
      : h(
          "div",
          { class: "viz-grid2" },
          card("Flow, week by week", `Where each story stood at the end of each week${val(F.flow.approximate) ? `; ${plural(val(F.flow.approximate), "story", "stories")} placed from their dates, not their Status log` : ""}. A click on a week reads the page as of the Monday after it.`, legend(["v1", "Backlog and ToDo"], ["v2", "In Progress and Review"], ["v3", "Done"]), stacked(rows, [{ key: "done", cls: "v3", name: "Done" }, { key: "review", cls: "v2", name: "Review" }, { key: "progress", cls: "v2", name: "In Progress" }, { key: "todo", cls: "v1", name: "ToDo" }, { key: "backlog", cls: "v1", name: "Backlog" }], "Stories in each column at the end of each week")),
          card("In and out", "Stories created and stories closed in each week.", legend(["v1", "created"], ["v3", "closed"]), paired(weeks, { key: "created", cls: "v1", name: "created" }, { key: "closed", cls: "v3", name: "closed" }, "Stories created and closed in each week")),
        );
    const table = h(
      "details",
      { class: "panel rep-table" },
      h("summary", null, "The weeks as a table"),
      val(F.hiddenWeeks) ? h("div", { class: "faint" }, `${plural(val(F.hiddenWeeks), "earlier week")} not listed; the totals count them.`) : null,
      h("table", { class: "plain num" }, h("thead", null, h("tr", null, ["Week of", "Created", "Closed", "Median cycle, days"].map((t) => h("th", null, t)))), h("tbody", null, weeks.map((wk) => h("tr", null, h("td", null, longDay(wk.from)), h("td", null, wk.created), h("td", null, wk.closed), h("td", null, shown(wk.cycle)))))),
    );
    return [scope, tiles, F.standing ? standing(F.standing) : h("div", { class: "note" }, F.ofToday), people, charts, table];
  }

  // ── the code part (contracts 5 to 8) ──
  const LEVEL = { bad: ["▲", "Stumbles"], warn: ["◆", "Watch"], ok: ["✓", "Fine"] };
  function check(c) {
    const none = !c.unknown && c.level === null && val(c.value) === null; // no share and no level (contract 11)
    const lv = c.unknown ? ["?", "Unknown"] : none ? ["–", "Nothing to count"] : LEVEL[c.level] || (val(c.value) ? LEVEL.warn : LEVEL.ok);
    const cls = c.unknown ? "unknown" : none ? "info" : c.level || (val(c.value) ? "warn" : "ok");
    const list = (items, what) => (items?.length ? h("details", null, h("summary", null, what), h("div", { class: "linklist sig-items" }, items)) : null);
    const storyRow = (s, lead) => h("div", { class: "line" }, storyBtn(s), s.epic ? h("span", { class: "chip" }, s.epic) : null, lead ? h("span", { class: "chip flag", title: "Named by a title or a mention, or a Closes-story line the follow verb would not count: a lead to check, not a link" }, "lead") : null, (s.prs || s.leads || []).map(prLine), s.days ? numEl(s.days, " days") : null, s.early ? h("span", { class: "chip flag", title: "closed_at is before the merge" }, "closed before the merge") : null);
    let detail = null;
    let n = numEl(c.value, c.id.endsWith("unlinked") ? "%" : "");
    if (c.id === "merged_open") {
      n = h("span", { class: "rep-n", title: `Counted by ${c.value.basis}` }, `${c.counted.length} by a counted link, ${c.leads.length} by a lead`, own(c.value));
      detail = [list(c.counted.map((s) => storyRow(s, false)), plural(c.counted.length, "story with a counted link", "stories with a counted link")), list(c.leads.map((s) => storyRow(s, true)), plural(c.leads.length, "lead"))];
    } else if (c.stories) detail = list(c.stories.map((s) => storyRow(s, Boolean(s.leads?.length))), plural(c.stories.length, "story", "stories"));
    else if (c.prs) detail = list(c.prs.map((p) => h("div", { class: "line" }, prLine(p))), plural(c.prs.length, "pull request"));
    return h(
      "div",
      { class: `sig sig-${cls}` },
      h("div", { class: "sig-v" }, h("span", { class: "sig-mark", "aria-hidden": "true" }, lv[0]), lv[1]),
      h("div", { class: "sig-b" }, h("div", { class: "sig-t" }, h("b", null, c.label), h("span", { class: "sig-n" }, n)), h("div", { class: "sig-basis" }, `Counted by ${c.value.basis}.`), c.unknown ? h("div", { class: "sig-w" }, `Not complete: ${c.unknown}.`) : null, detail),
    );
  }
  function codePart() {
    const head = h("div", { class: "rep-code-h" }, h("h2", null, "The board against the code"), h("span", { class: "grow" }), h("button", { class: "btn ghost", onclick: () => again({ fresh: true }), disabled: codeBusy, title: "Ask GitHub for the list of pull requests again" }, codeBusy ? "Checking…" : "Check again"));
    const sub = h("div", { class: "viz-sub" }, "A pull request counts for a story only by a link the follow verb counts: the story's external_refs.pr, or a Closes-story line. A title or a mention is a lead, listed apart.");
    if (!code) return h("div", { class: "panel" }, head, sub, h("div", { class: "faint" }, "counting…"));
    if (!code.ok) return h("div", { class: `panel${codeBusy ? " stale" : ""}` }, head, sub, h("div", { class: "note warn" }, `The board against the code could not be read: ${code.error}`));
    const R = code.result;
    const unknown = [R.unknown.git && `The project's repository: ${R.unknown.git}.`, R.unknown.prs && `The pull requests: ${R.unknown.prs}. No check is made without them.`].filter(Boolean);
    const foot = R.main ? h("div", { class: "rel-foot" }, `Pull requests${R.repo ? ` of ${R.repo}` : ""}, and the default branch ${R.main.short} at ${R.main.hash} as the repository was last fetched; nothing is fetched or written.`) : null;
    return h("div", { class: `panel${codeBusy ? " stale" : ""}` }, head, sub, unknown.map((u) => h("div", { class: "note warn" }, u)), R.openLeft && !R.unknown.prs ? h("div", { class: "sig-w" }, R.openLeft) : null, R.checks.map(check), foot);
  }

  // ── the view ──
  function view() {
    const q = query();
    if (flowAsked !== q) askFlow(q);
    if (codeAsked !== q) askCode(q);
    // The last answer stays, dimmed, while the next one is read (contract 9).
    const wrap = h("div", { class: `reports${flow && flowFor !== q ? " stale" : ""}` });
    const F = flow && !flow.error ? flow : null;
    fill(wrap, filters(F), flow?.error ? h("div", { class: "note warn" }, flow.error) : F ? flowPart(F) : h("div", { class: "faint" }, "counting…"), codePart());
    return wrap;
  }

  return { view, query, apply, again, link };
})();

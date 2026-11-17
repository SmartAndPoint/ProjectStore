// The page's writes: a story moved with a preview, the batch, Send, Discard
// and the kept branches (the specs "The dashboard's write path…", alias
// `dashboard-writes`, contracts 1, 4, 6, 7 and 8, and "The dashboard's
// delivery…", alias `dashboard-delivery`, contracts 1 to 6).
//
// Only this file speaks to the five write routes, and only by POST with the
// run's token (the meta tag of `/`); a same-origin fetch sends the page's own
// Origin. Every control here is drawn from `write`: none while `write.can` is
// false, and none for a verb that `write.verbs` does not list. The core plans
// each change and makes it: the page shows the plan, and the click on its
// button is the approval. Nothing here is a second gate on the vault: a change
// lands on the person's batch branch in the page's own clone, and reaches the
// vault when the pull request that Send opens is merged.
//
// Everything lives under one name, `writeUi`, because the page's scripts
// share one global scope.

const writeUi = (() => {
  const ROUTES = ["/api/refresh", "/api/preview", "/api/action", "/api/send", "/api/discard"];
  // The statuses each target of `move` comes from (the core's own rule; it refuses the others).
  const FROM = { todo: ["planned"], planned: ["todo", "to-do"] };
  const LABEL = { todo: "Move to ToDo", planned: "Back to Backlog" };
  const COLUMN_TO = { ToDo: "todo", Backlog: "planned" };
  const WORD = { planned: "Backlog", todo: "ToDo", "to-do": "ToDo" };
  let busy = null; // the step that runs now: "refresh", "preview", "action", "send", "discard"
  let note = null; // the last answer worth keeping on screen: { kind: "ok" | "warn" | "error", text }
  let dragging = null; // { ref, to: [targets] } while a card is dragged

  const w = () => (S && S.write) || null;
  const can = () => !!w()?.can;
  const token = () => document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const short = (sha) => String(sha || "").slice(0, 7);
  const isUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

  // ── the one way to a write route ──
  // → the answer as the server gave it ({ ok, result?, error?, write }), with
  // `status`; a server that did not answer, or answered no JSON, is an error.
  async function post(route, body) {
    if (!ROUTES.includes(route)) throw new Error(`${route} is not a write route`);
    let r;
    try {
      r = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-projectstore-token": token() },
        body: JSON.stringify(body || {}),
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (e) {
      return { ok: false, status: 0, error: `the page's server did not answer: ${e?.message || e}` };
    }
    let answer = null;
    try {
      answer = await r.json();
    } catch {
      answer = null;
    }
    if (!answer || typeof answer !== "object") return { ok: false, status: r.status, error: `the page's server answered ${r.status} with no JSON` };
    if (answer.write && typeof answer.write === "object" && S) S.write = answer.write;
    return { ...answer, ok: answer.ok === true, status: r.status, error: answer.error || (answer.ok === true ? null : `the page's server answered ${r.status}`) };
  }

  // After every write answer: draw from its `write` now, then read the board again.
  async function after() {
    render();
    await load(); // app.js: /api/state, the artifacts and the open item
  }
  // A step that runs: one at a time from this page (the server queues them anyway).
  async function running(name, fn) {
    busy = name;
    paint();
    try {
      return await fn();
    } finally {
      busy = null;
      paint();
    }
  }
  const say = (kind, text) => {
    // The module's and the core's messages start in lower case; a note is a sentence.
    const t = text ? String(text) : "";
    note = t ? { kind, text: t.charAt(0).toUpperCase() + t.slice(1) } : null;
    paint();
  };

  // ── what may be offered ──
  // The fields of a verb the page may run now, or null: `write.can`, and the verb in `write.verbs`.
  function verbFields(verb) {
    const x = w();
    if (!x || !x.can || !Array.isArray(x.verbs)) return null;
    const entry = x.verbs.find((v) => v && v.verb === verb);
    return entry && entry.fields && typeof entry.fields === "object" ? entry.fields : null;
  }
  // The moves a story can take from the page: [{ to, label }]. Empty while the
  // page cannot write, when `move` or one of its fields is not listed, and for
  // a target whose value `write.verbs` does not list.
  // `move` with every field the page fills: story, to (its values) and reason.
  function moveFields() {
    const f = verbFields("move");
    return f && f.story && f.reason && f.to && Array.isArray(f.to.values) ? f : null;
  }
  function movesOf(s) {
    const f = moveFields();
    if (!s || !f) return [];
    const status = String(s.status || "").toLowerCase();
    return f.to.values.filter((to) => (FROM[to] || []).includes(status)).map((to) => ({ to, label: LABEL[to] || `Move to ${to}` }));
  }
  const maxReason = () => Number(moveFields()?.reason?.max) || 200;

  // ── drag and drop on the board ──
  const clearDrag = () => {
    dragging = null;
    document.body.classList.remove("dragging");
    for (const el of document.querySelectorAll(".drop-ok, .drop-over")) el.classList.remove("drop-ok", "drop-over");
  };
  // A story's card: draggable when the story has a move to offer.
  function dragCard(el, s) {
    const moves = movesOf(s);
    if (!moves.length) return el;
    el.draggable = true;
    el.classList.add("can-move");
    el.title = `Drag to ${moves.map((m) => WORD[m.to] || m.to).join(" or ")}, or open it for the button`;
    el.addEventListener("dragstart", (e) => {
      dragging = { ref: s.ref, to: moves.map((m) => m.to) };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", s.ref);
      document.body.classList.add("dragging");
      for (const col of document.querySelectorAll("[data-drop-to]")) if (dragging.to.includes(col.dataset.dropTo)) col.classList.add("drop-ok");
    });
    el.addEventListener("dragend", clearDrag);
    return el;
  }
  // A column of the board: a drop target when it is the Backlog or the ToDo
  // column alone and `move` may go there.
  function dropColumn(el, c) {
    const names = (c.shows || []).filter((n) => COLUMN_TO[n]);
    const to = names.length === 1 && c.shows.length === 1 ? COLUMN_TO[names[0]] : null;
    const f = moveFields();
    if (!to || !f || !f.to.values.includes(to)) return el;
    el.dataset.dropTo = to;
    const fits = () => dragging && dragging.to.includes(to);
    el.addEventListener("dragover", (e) => {
      if (!fits()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-over");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-over");
    });
    el.addEventListener("drop", (e) => {
      if (!fits()) return;
      e.preventDefault();
      const ref = dragging.ref;
      clearDrag();
      openMove(ref, to);
    });
    return el;
  }

  // ── a dialog that keeps the focus, and closes on Escape ──
  function modal(title, kids, { onClose } = {}) {
    const m = $("#modal");
    const back = document.activeElement;
    const box = h("div", { class: "dialog write-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), kids);
    const close = () => {
      if (m.hidden || !m.contains(box)) return; // closed already, or another dialog stands there now
      m.hidden = true;
      m.replaceChildren();
      m.onclick = null;
      onClose?.();
      if (back && back.isConnected && typeof back.focus === "function") back.focus();
    };
    const focusables = () => [...box.querySelectorAll("button, input, textarea, select, a[href], [tabindex]")].filter((x) => !x.disabled && x.tabIndex !== -1 && x.offsetParent !== null);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close();
      }
      if (e.key !== "Tab") return;
      const all = focusables();
      if (!all.length) return e.preventDefault();
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    m.replaceChildren(box);
    m.hidden = false;
    m.onclick = (e) => {
      if (e.target === m) close();
    };
    (box.querySelector("input, textarea, select") || box.querySelector("button.primary") || box.querySelector("button"))?.focus();
    return { box, close, isOpen: () => !m.hidden && m.contains(box) };
  }

  // ── move, with a preview ──
  // The core's plan, as `result` holds it: the fields it names, in words.
  function planView(result) {
    if (!result || typeof result !== "object") return h("div", { class: "faint" }, "The core gave no plan.");
    const shown = new Set(["story", "from", "to", "reason", "path", "written", "actor", "already", "error"]);
    const word = (st) => `${WORD[st] || st} (${st})`;
    const rest = Object.entries(result).filter(([k, v]) => !shown.has(k) && v !== null && typeof v !== "object");
    return h(
      "div",
      { class: "plan" },
      kv(
        ["Story", h("span", { class: "mono" }, result.story)],
        result.from || result.to ? ["Status", `${word(result.from)} → ${word(result.to)}`] : null,
        result.reason ? ["Reason", result.reason] : null,
        result.path ? ["File", h("span", { class: "mono path" }, result.path)] : null,
        ...rest.map(([k, v]) => [k, String(v)]),
      ),
      result.already ? h("div", { class: "note" }, "The story is in that status already: the core will write nothing.") : null,
    );
  }
  // What the click on the move button does, in words.
  function landing() {
    const b = w()?.batch;
    return b
      ? `The click commits this change to the batch branch ${b.branch}, beside its ${plural(b.commits, "commit")}. Nothing reaches the vault before Send and a merge of the pull request.`
      : "The click commits this change to a new batch branch in the page's own clone. Nothing reaches the vault before Send and a merge of the pull request.";
  }

  function openMove(ref, to) {
    const s = story(ref);
    const move = s && movesOf(s).find((m) => m.to === to);
    if (!move) return toast("refused", "This move is not offered", s ? `${s.title} is ${s.status}; the page offers no move to ${to} for it.` : `No story ${ref} on the board.`);
    const max = maxReason();
    const input = h("input", { type: "text", class: "reason", "aria-label": "Why, in one line", placeholder: "Why, in one line", autocomplete: "off", spellcheck: true });
    const count = h("span", { class: "faint count" }, `0/${max}`);
    const plan = h("div", { class: "plan-box" }, h("div", { class: "faint" }, "Write why, then Preview: the core shows what it will change, and nothing is written yet."));
    const err = h("div", { class: "write-err", role: "alert" });
    const primary = h("button", { class: "btn primary", type: "button" }, "Preview");
    const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
    let planned = null; // the reason the plan on screen was made for
    let inFlight = false;
    const reasonNow = () => input.value.trim();
    const valid = () => {
      const t = reasonNow();
      const n = [...t].length;
      if (!t) return "Say in one line why.";
      if (n > max) return `The reason is ${n} characters long; it takes at most ${max}.`;
      return null;
    };
    const sync = () => {
      const n = [...reasonNow()].length;
      count.textContent = `${n}/${max}`;
      count.classList.toggle("over", n > max);
      const fresh = planned !== null && planned === reasonNow();
      primary.textContent = fresh ? move.label : "Preview";
      primary.disabled = inFlight || !!valid();
    };
    const fields = () => ({ story: s.ref, to, reason: reasonNow() });
    const showError = (text) => fill(err, text ? h("div", { class: "msg" }, text) : null);
    const doPreview = async () => {
      const bad = valid();
      if (bad) return showError(bad);
      inFlight = true;
      showError(null);
      fill(plan, h("div", { class: "faint" }, "Asking the core for its plan…"));
      sync();
      const reason = reasonNow();
      const a = await running("preview", () => post("/api/preview", { verb: "move", fields: fields() }));
      inFlight = false;
      if (a.ok) {
        planned = reason;
        fill(plan, h("div", { class: "plan-h" }, "What the core will change"), planView(a.result), h("div", { class: "faint" }, landing()));
      } else {
        planned = null;
        fill(plan, a.result && typeof a.result === "object" && a.result.story ? planView(a.result) : null);
        showError(a.error);
      }
      sync();
      if (!dlg.isOpen()) return;
      if (a.ok) primary.focus();
      render(); // the answer's write
    };
    const doAction = async () => {
      inFlight = true;
      showError(null);
      sync();
      primary.textContent = "Moving…";
      const a = await running("action", () => post("/api/action", { verb: "move", fields: fields() }));
      inFlight = false;
      if (a.ok) {
        dlg.close();
        const b = w()?.batch;
        const done = a.result && a.result.written === false ? `The core wrote nothing: ${s.title} is ${WORD[to] || to} already.` : `${s.title} is in ${WORD[to] || to}.${b ? ` The batch ${b.branch} holds ${plural(b.commits, "commit")}.` : ""}`;
        say("ok", done);
      } else {
        planned = null;
        showError(a.error);
        sync();
        if (!dlg.isOpen()) say("error", `${move.label}: ${a.error}`);
      }
      await after();
    };
    primary.addEventListener("click", () => {
      if (primary.disabled) return;
      if (planned !== null && planned === reasonNow()) doAction();
      else doPreview();
    });
    cancel.addEventListener("click", () => dlg.close());
    input.addEventListener("input", () => {
      if (planned !== null && planned !== reasonNow()) {
        planned = null;
        fill(plan, h("div", { class: "faint" }, "The reason changed: Preview again to see the plan with it."));
      }
      showError(null);
      sync();
    });
    // Enter previews; with a fresh plan it moves to the button, whose own click is the approval.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (planned !== null && planned === reasonNow()) primary.focus();
      else if (!primary.disabled) doPreview();
      else showError(valid());
    });
    const dlg = modal(move.label, [
      h("div", { class: "move-what" }, h("b", null, s.title), h("div", { class: "faint" }, h("span", { class: "mono" }, s.ref), ` · ${s.column || s.status} → ${WORD[to] || to}`)),
      h("label", { class: "f" }, h("span", null, "Why ", h("i", null, `(one line, at most ${max} characters; it goes into the story's status log and the commit)`)), input, count),
      plan,
      err,
      h("div", { class: "btns" }, cancel, primary),
    ]);
    sync();
  }

  // ── Send and Discard ──
  const prWords = (pr) => (pr ? `pull request #${pr.number ?? "?"} (${String(pr.state || "").toLowerCase() || "state unknown"})` : null);
  function carryWords(c) {
    if (!c) return "";
    const parts = [];
    if (c.carried?.length) parts.push(`${plural(c.carried.length, "commit")} made after it was sent ${c.carried.length === 1 ? "was" : "were"} carried from ${c.from} into the new batch ${c.branch}`);
    if (c.skipped?.length) parts.push(`${plural(c.skipped.length, "commit")} ${c.skipped.length === 1 ? "is" : "are"} in the default branch already`);
    if (c.stopped_at) parts.push(`the carry stopped at ${short(c.stopped_at.sha)} "${c.stopped_at.subject}", because ${c.stopped_at.reason}; it and the commits after it stay on the kept branch ${c.from}`);
    return parts.length ? ` ${parts.join("; ")}.` : "";
  }
  function sendWords(a) {
    if (!a.ok) return a.error;
    const r = a.result || {};
    if (!r.sent) return `Nothing was sent.${carryWords(r.carry)}`;
    const pr = r.pull_request;
    const where = pr ? ` ${prWords(pr)}${isUrl(pr.url) ? ` is at ${pr.url}` : ""}.` : r.gh ? ` No pull request was opened, because gh cannot be asked: ${r.gh}` : "";
    return `Sent ${r.branch}: ${plural(Number(r.commits) || 0, "commit")} pushed to origin.${where}${carryWords(r.carry)}`;
  }
  function confirmSend() {
    const b = w()?.batch;
    if (!b || !can()) return;
    const x = w();
    const pr = b.pull_request;
    const text = pr && pr.state === "OPEN" ? `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin. Its ${prWords(pr)} is open already and gets them.` : x.pull_requests ? `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin. gh cannot be asked now (${x.pull_requests}), so no pull request is opened: you open one on the code host.` : `Push branch ${b.branch} with ${plural(b.commits, "commit")} to origin and open a pull request into ${x.default_branch || "the default branch"}.`;
    const go = h("button", { class: "btn primary", type: "button" }, "Send");
    const dlg = modal("Send the batch", [h("div", null, text), h("div", { class: "faint" }, "The pull request is the review: the vault changes when someone merges it."), h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), go)]);
    go.addEventListener("click", async () => {
      dlg.close();
      const a = await running("send", () => post("/api/send"));
      say(a.ok ? "ok" : a.status >= 500 || a.status === 0 ? "error" : "warn", sendWords(a));
      await after();
    });
  }
  function confirmDiscard() {
    const b = w()?.batch;
    if (!b || !can()) return;
    const pr = b.pull_request;
    const text = pr && pr.state === "OPEN" ? `End the batch on ${b.branch}: its ${prWords(pr)} is closed on the code host.` : !pr && !w()?.pull_requests ? `End the batch on ${b.branch} on this machine. No pull request was opened for it.` : `End the batch on ${b.branch} on this machine. A pull request for it, if one is open, stays open.`;
    const go = h("button", { class: "btn primary danger", type: "button" }, "Discard");
    const dlg = modal("Discard the batch", [
      h("div", null, text),
      h("div", { class: "faint" }, `Nothing is deleted: the branch and its ${plural(b.commits, "commit")} are kept here (and on origin, if it was sent), and the page lists it under Kept branches.`),
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), go),
    ]);
    go.addEventListener("click", async () => {
      dlg.close();
      const a = await running("discard", () => post("/api/discard"));
      say(a.ok ? "ok" : a.status >= 500 || a.status === 0 ? "error" : "warn", a.ok ? `${a.result?.message || "The batch ended."}` : a.error);
      await after();
    });
  }

  // The refresh: when the page opens, and when asked from the palette.
  // The refresh answers no words of its own: a batch it ended is told from
  // `write` before and after (a merge carries, a closed pull request keeps).
  async function refresh() {
    const was = w()?.batch?.branch || null;
    const a = await running("refresh", () => post("/api/refresh"));
    const x = w();
    const now = x?.batch?.branch || null;
    const kept = (x?.kept || []).find((k) => k.branch === was);
    if (!a.ok && a.error) say("warn", `The refresh did not end well: ${a.error}`);
    else if (was && now !== was && kept)
      say("warn", `The batch ${was} ended: its pull request was closed, or a carry stopped${kept.stopped_at ? ` at ${short(kept.stopped_at.sha)} "${kept.stopped_at.subject}" (${kept.stopped_at.reason})` : ""}. Its branch is kept${now ? `, and ${now} is the new batch` : ""}.`);
    else if (was && now !== was) say("ok", `The batch ${was} was merged.${now ? ` The commits made after it was sent are in the new batch ${now}.` : ""}`);
    await after();
  }

  // ── what the page shows ──
  const BUSY = { refresh: "Fetching the vault's repository and asking the code host…", preview: "Asking the core for its plan…", action: "Committing the change…", send: "Sending the batch…", discard: "Ending the batch…" };
  function prLink(pr) {
    if (!pr) return h("span", { class: "faint" }, "no pull request yet");
    const label = `PR #${pr.number ?? "?"} · ${String(pr.state || "").toLowerCase()}`;
    const cls = `chip pr ${String(pr.state || "").toLowerCase()}`;
    return isUrl(pr.url) ? h("a", { class: cls, href: pr.url, target: "_blank", rel: "noopener noreferrer", title: pr.url }, label, " ↗") : h("span", { class: cls }, label);
  }
  function keptList(kept) {
    if (!Array.isArray(kept) || !kept.length) return null;
    return h(
      "details",
      { class: "kept" },
      h("summary", null, `Kept branches (${kept.length})`, h("span", { class: "faint" }, " · commits that may never have been sent")),
      h(
        "ul",
        null,
        kept.map((k) =>
          h(
            "li",
            null,
            h("span", { class: "mono" }, k.branch),
            " ",
            k.commits === null || k.commits === undefined ? h("span", { class: "chip flag", title: k.reason || "" }, "count unknown") : h("span", { class: "faint" }, `${plural(k.commits, "commit")} the default branch lacks`),
            k.commits === null && k.reason ? h("div", { class: "faint" }, `git could not count them: ${k.reason}`) : null,
            k.stopped_at ? h("div", { class: "stopped" }, `A carry stopped at ${short(k.stopped_at.sha)} "${k.stopped_at.subject}": ${k.stopped_at.reason}.`) : null,
          ),
        ),
      ),
      h("div", { class: "faint" }, "The page does not send or delete a kept branch. The dashboard's README says how to do either by hand."),
    );
  }
  // The strip above the view: the batch, its pull request, Send and Discard,
  // what gh says, the kept branches, the last answer and what runs now.
  function paint() {
    const bar = $("#write");
    if (!bar) return;
    const x = w();
    if (!x) return void ((bar.hidden = true), bar.replaceChildren());
    const b = x.can ? x.batch : null;
    const off = !!busy;
    const kids = [
      b &&
        h(
          "div",
          { class: "batch", role: "group", "aria-label": "The batch" },
          h("span", { class: "batch-h" }, ico("branch"), "Batch"),
          h("span", { class: "mono", title: `started ${b.started_at || "?"}` }, b.branch),
          h("span", { class: "chip" }, `${plural(b.commits, "commit")} not in ${x.default_branch || "the default branch"}`),
          prLink(b.pull_request),
          h("span", { class: "grow" }),
          h("button", { class: "btn primary", type: "button", disabled: off || !b.commits, onclick: confirmSend, title: b.commits ? "Push the batch and open its pull request" : "The batch holds no commit to send" }, "Send…"),
          h("button", { class: "btn", type: "button", disabled: off, onclick: confirmDiscard, title: "End the batch; nothing is deleted" }, "Discard…"),
        ),
      x.can && x.pull_requests ? h("div", { class: "note warn" }, `The code host cannot be asked about pull requests: ${x.pull_requests}`) : null,
      keptList(x.kept),
      busy ? h("div", { class: "faint busy", role: "status" }, BUSY[busy] || "Working…") : null,
      note ? h("div", { class: `write-note ${note.kind}`, role: note.kind === "error" ? "alert" : "status" }, h("span", { class: "msg" }, note.text), h("button", { class: "btn ghost", type: "button", "aria-label": "close this message", onclick: () => say(null, null) }, "✕")) : null,
    ].filter(Boolean);
    bar.hidden = !kids.length;
    fill(bar, kids);
  }

  // The foot of the menu: whether this page writes, and, when it does not, why (one quiet line).
  function footLine() {
    const x = w();
    const name = S.project.name;
    if (!x || !x.can)
      return h(
        "div",
        { class: "write-reason", style: "margin-top:10px" },
        h("div", null, h("b", null, "No writes: "), x?.reason || "this server does not say whether the page can write."),
        h("div", null, `The vault of ${name}, as it is on disk. Nothing on this page changes it. core ${S.coreVersion}`),
      );
    const at = x.fetched_at ? ` Fetched ${new Date(x.fetched_at).toLocaleString()}.` : "";
    return h("div", { style: "margin-top:10px" }, `The vault of ${name}. A change from this page is one commit on your batch branch, in the page's own clone; it reaches ${x.default_branch || "the default branch"} when its pull request is merged.${at} core ${S.coreVersion}`);
  }

  // The story's side panel: its moves, as buttons (the keyboard's way to the drag).
  function storyButtons(s) {
    const moves = movesOf(s);
    if (!moves.length) return null;
    return h(
      "div",
      { class: "row write-acts" },
      moves.map((m) => h("button", { class: "btn", type: "button", disabled: !!busy, onclick: () => openMove(s.ref, m.to) }, `${m.label}…`)),
    );
  }
  // The palette's commands: a story's moves, and the batch's Send and Discard.
  function storyCommands(s) {
    return movesOf(s).map((m) => ({ label: `${m.label}…`, run: () => openMove(s.ref, m.to), kw: "move status todo backlog planned write" }));
  }
  function rootCommands() {
    const x = w();
    if (!x || !x.can) return [];
    const out = [];
    if (x.batch && x.batch.commits) out.push({ label: "Send the batch…", run: confirmSend, group: "Batch", kw: "push pull request" });
    if (x.batch) out.push({ label: "Discard the batch…", run: confirmDiscard, group: "Batch", kw: "end close" });
    out.push({ label: "Fetch the vault's repository again", run: refresh, group: "Batch", kw: "refresh fetch pull request state code host" });
    return out;
  }

  // When the page opens: the refresh, once, then the page from its answer.
  function boot() {
    refresh();
  }

  return { post, movesOf, dragCard, dropColumn, openMove, confirmSend, confirmDiscard, refresh, paint, footLine, storyButtons, storyCommands, rootCommands, boot, sendWords, carryWords, ROUTES };
})();

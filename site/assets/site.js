/* ProjectStore site (Fable × Astra) — tabs, diagram ↔ tabs, board demo, copy buttons.
   Vanilla, no dependencies, no build. */
(function () {
  "use strict";

  /* ---------- generic tabs: [data-tabs] > [role=tablist] > button[data-tab], panels [data-panel] ---------- */
  function initTabs(root) {
    var triggers = Array.prototype.slice.call(root.querySelectorAll("[role=tab][data-tab]"));
    var panels = Array.prototype.slice.call(root.querySelectorAll("[data-panel]"));
    function select(id, focus) {
      triggers.forEach(function (t) {
        var on = t.getAttribute("data-tab") === id;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.setAttribute("tabindex", on ? "0" : "-1");
        if (on && focus) t.focus();
      });
      panels.forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-panel") === id); });
      root.dispatchEvent(new CustomEvent("tabchange", { detail: { id: id } }));
    }
    triggers.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t.getAttribute("data-tab")); });
      t.addEventListener("keydown", function (ev) {
        var dir = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!dir) return;
        ev.preventDefault();
        var n = (i + dir + triggers.length) % triggers.length;
        select(triggers[n].getAttribute("data-tab"), true);
      });
    });
    root.__select = select;
    var initial = root.getAttribute("data-initial") || (triggers[0] && triggers[0].getAttribute("data-tab"));
    if (initial) select(initial);
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-tabs]"), initTabs);

  /* ---------- loop diagram nodes drive the workflow tabs ---------- */
  var workflow = document.getElementById("workflow-tabs");
  var nodes = Array.prototype.slice.call(document.querySelectorAll("svg .node[data-step]"));
  function markNodes(id) {
    nodes.forEach(function (g) { g.classList.toggle("active", g.getAttribute("data-step") === id); });
  }
  if (workflow) {
    workflow.addEventListener("tabchange", function (ev) { markNodes(ev.detail.id); });
    var current = workflow.querySelector("[role=tab][aria-selected=true]");
    if (current) markNodes(current.getAttribute("data-tab"));
  }
  nodes.forEach(function (g) {
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    function go() {
      if (!workflow) return;
      workflow.__select(g.getAttribute("data-step"));
      if (window.innerWidth < 900) workflow.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    g.addEventListener("click", go);
    g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
  });

  /* ---------- frontmatter → board demo ---------- */
  var statusSel = document.getElementById("demo-status");
  var prioSel = document.getElementById("demo-priority");
  var card = document.getElementById("demo-card");
  var src = document.getElementById("demo-src");
  var cols = {};
  Array.prototype.forEach.call(document.querySelectorAll(".board .col"), function (c) { cols[c.getAttribute("data-col")] = c; });
  var columnOf = { planned: "Backlog", todo: "ToDo", "in-progress": "In Progress", review: "Review", done: "Done" };
  function renderDemo() {
    if (!statusSel || !prioSel || !card) return;
    var status = statusSel.value, prio = prioSel.value;
    var col = cols[columnOf[status]];
    if (col) col.appendChild(card);
    card.classList.toggle("done", status === "done");
    var tags = ["#" + prio];
    if (status === "done") tags.push("#done");
    if (status === "review") tags.push("#review");
    var tagEl = card.querySelector(".tags");
    if (tagEl) tagEl.textContent = tags.join(" ");
    if (src) {
      var check = status === "done" ? "[x]" : "[ ]";
      var pathEl = document.querySelector(".fm-edit .path");
      var titleEl = card.querySelector(".kt");
      var link = pathEl ? pathEl.textContent.trim().replace(/\.md$/, "") : "";
      var title = titleEl ? titleEl.textContent.trim() : "";
      src.textContent = "- " + check + " [[" + link + "|PAY-001: " + title + "]] ";
      var tagSpan = document.createElement("span");
      tagSpan.className = "c";
      tagSpan.textContent = tags.join(" ");
      src.appendChild(tagSpan);
    }
    Object.keys(cols).forEach(function (k) {
      var i = cols[k].querySelector("h5 i");
      if (i) i.textContent = String(cols[k].querySelectorAll(".kcard").length);
    });
  }
  if (statusSel) statusSel.addEventListener("change", renderDemo);
  if (prioSel) prioSel.addEventListener("change", renderDemo);
  renderDemo();

  /* ---------- language switcher: remembers an explicit choice in a cookie ---------- */
  var sw = document.querySelector(".lang-switch");
  if (sw) {
    var lbtn = sw.querySelector("button.lang");
    var menu = sw.querySelector(".lang-menu");
    var links = Array.prototype.slice.call(menu.querySelectorAll("a[data-lang]"));
    var setOpen = function (open) {
      lbtn.setAttribute("aria-expanded", open ? "true" : "false");
      menu.hidden = !open;
    };
    lbtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var open = menu.hidden;
      setOpen(open);
      if (open) (menu.querySelector("[aria-current]") || links[0]).focus();
    });
    document.addEventListener("click", function (ev) { if (!sw.contains(ev.target)) setOpen(false); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !menu.hidden) { setOpen(false); lbtn.focus(); }
    });
    menu.addEventListener("keydown", function (ev) {
      var i = links.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); links[(i + 1) % links.length].focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); links[(i - 1 + links.length) % links.length].focus(); }
    });
    links.forEach(function (a) {
      var href = a.getAttribute("href");
      if (location.protocol === "file:" && /\/$/.test(href)) a.setAttribute("href", href + "index.html");
      a.addEventListener("click", function () {
        try { document.cookie = "ps_lang=" + a.getAttribute("data-lang") + "; path=/; max-age=31536000; SameSite=Lax"; } catch (e) { /* cookies off */ }
      });
    });
  }

  /* ---------- copy buttons: [data-copy-target] or .cmd ---------- */
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    } else { fallback(text); done(); }
  }
  function fallback(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing */ }
    document.body.removeChild(ta);
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy-from]"), function (btn) {
    btn.addEventListener("click", function () {
      var label = btn.innerHTML;
      if (btn.classList.contains("ok")) return;
      var pre = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!pre) return;
      var text = pre.getAttribute("data-copy") || pre.textContent;
      copyText(text, function () {
        btn.textContent = btn.getAttribute("data-done") || "copied";
        btn.classList.add("ok");
        setTimeout(function () { btn.innerHTML = label; btn.classList.remove("ok"); }, 1400);
      });
    });
  });
})();

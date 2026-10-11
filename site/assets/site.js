/* ProjectStore site (Fable × Astra) — tabs, diagram ↔ tabs, the loop's cartoon, board demo, copy buttons.
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

  /* ---------- the loop diagram plays its steps until the reader takes over ---------- */
  /* Keep this block below initTabs' first select: registered earlier, that initial
     tabchange would count as the reader's and stop the cartoon before it starts. */
  (function () {
    var figure = document.querySelector(".loop-figure");
    var scroller = figure && figure.querySelector(".fig-scroll");
    if (!figure || !scroller || !workflow || !nodes.length || !window.matchMedia || !("IntersectionObserver" in window)) return;
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    var wide = window.matchMedia("(min-width: 950px)"); /* style.css gives the six panels one height from here */
    var PRESS_MS = 2000;
    var HOVER = "svg .node[data-step], #workflow-tabs [role=tab], #workflow-tabs .workflow-panel";
    var index = -1, timer = null, stopped = false, inView = false, hovering = false, pressing = false, lastX = null, lastY = null;

    function fits() { return scroller.scrollWidth <= scroller.clientWidth; }
    function focusInside() { var a = document.activeElement; return !!a && (figure.contains(a) || workflow.contains(a)); }
    function canPress() { return !stopped && inView && !hovering && !document.hidden && !focusInside() && !reduce.matches && wide.matches && fits(); }
    function pause() { if (timer) { clearTimeout(timer); timer = null; } }
    /* a fresh 2 s once nothing holds it back; a pause drops the pending press */
    function settle() { if (!canPress()) pause(); else if (!timer) timer = setTimeout(press, PRESS_MS); }
    function press() {
      timer = null;
      if (!canPress()) return;
      index = (index + 1) % nodes.length;
      var g = nodes[index];
      g.classList.remove("pressed");
      void g.getBoundingClientRect(); /* restarts the pulse */
      g.classList.add("pressed");
      pressing = true;
      try { workflow.__select(g.getAttribute("data-step")); } finally { pressing = false; }
      settle();
    }

    var header = document.querySelector(".site-header");
    var io = new IntersectionObserver(function (entries) {
      var e = entries[entries.length - 1];
      inView = e.isIntersecting && e.intersectionRatio >= 0.5;
      settle();
    }, { threshold: 0.5, rootMargin: "-" + (header ? header.offsetHeight : 0) + "px 0px 0px 0px" });
    io.observe(figure);
    function stop() { if (stopped) return; stopped = true; pause(); io.disconnect(); }

    nodes.forEach(function (g) {
      g.addEventListener("animationend", function (ev) { if (ev.animationName === "node-press") g.classList.remove("pressed"); });
    });

    /* the reader takes over: a step selected by anything but a press, or a click anywhere in the figure or the tabs */
    workflow.addEventListener("tabchange", function () { if (!pressing) stop(); });
    figure.addEventListener("click", stop);
    workflow.addEventListener("click", stop);

    /* pauses: a pointer that really moves onto a block, a tab or a panel; focus inside; out of view; a hidden page */
    document.addEventListener("mousemove", function (ev) {
      if (stopped) return;
      var moved = lastX === null ? !!(ev.movementX || ev.movementY) : ev.clientX !== lastX || ev.clientY !== lastY;
      lastX = ev.clientX; lastY = ev.clientY;
      if (!moved) return;
      var over = !!(ev.target && ev.target.closest && ev.target.closest(HOVER));
      if (over !== hovering) { hovering = over; settle(); }
    }, { passive: true });
    document.addEventListener("mouseout", function (ev) { if (!ev.relatedTarget && hovering) { hovering = false; settle(); } });
    /* the page scrolling a block, a tab or a panel out from under a resting pointer ends that pause; a scroll never starts one */
    window.addEventListener("scroll", function () {
      if (!hovering || lastX === null) return;
      var el = document.elementFromPoint(lastX, lastY);
      if (!(el && el.closest && el.closest(HOVER))) { hovering = false; settle(); }
    }, { passive: true });
    [figure, workflow].forEach(function (el) {
      el.addEventListener("focusin", settle);
      el.addEventListener("focusout", function () { setTimeout(settle, 0); }); /* activeElement is settled only after focusout */
    });
    document.addEventListener("visibilitychange", settle);
    window.addEventListener("resize", settle);
    if (reduce.addEventListener) { reduce.addEventListener("change", settle); wide.addEventListener("change", settle); }
  })();

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

/* ProjectStore site — tabs, the loop's steps and cartoon, copy buttons, the language switcher, the tone switch.
   Vanilla, no dependencies, no build. */
(function () {
  "use strict";
  var each = function (sel, fn, root) { Array.prototype.forEach.call((root || document).querySelectorAll(sel), fn); };

  /* ---------- tabs: [data-tabs] > [role=tablist] > button[data-tab], panels [data-panel] ----------
     The root carries the selected id as data-mode, so a figure beside the panels can follow it. */
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
      root.setAttribute("data-mode", id);
    }
    triggers.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t.getAttribute("data-tab")); });
      t.addEventListener("keydown", function (ev) {
        var dir = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!dir) return;
        ev.preventDefault();
        select(triggers[(i + dir + triggers.length) % triggers.length].getAttribute("data-tab"), true);
      });
    });
    var initial = root.getAttribute("data-initial") || (triggers[0] && triggers[0].getAttribute("data-tab"));
    if (initial) select(initial);
  }
  each("[data-tabs]", initTabs);

  /* ---------- the loop: a block shows its step's line; the blocks play until the reader takes over ----------
     The contract of 2026-10-10: once the diagram is in view, every block is pressed in turn along the
     arrows, again and again; the reader's first click there ends it for good; a pointer on a block or
     focus inside pauses it; a diagram that scrolls sideways (a narrow screen) and reduced motion get none. */
  each("figure.loop", function (figure) {
    var scroller = figure.querySelector(".diagram") || figure;
    var nodes = Array.prototype.slice.call(figure.querySelectorAll(".node[data-step]"));
    var lines = Array.prototype.slice.call(figure.querySelectorAll("[data-line]"));
    if (!nodes.length) return;
    figure.classList.add("js"); /* one line at a time from here; without script every line shows */
    function select(g) {
      var step = g.getAttribute("data-step");
      nodes.forEach(function (n) { n.classList.toggle("active", n === g); });
      lines.forEach(function (l) { l.hidden = l.getAttribute("data-line") !== step; });
    }
    nodes.forEach(function (g) {
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.addEventListener("click", function () { select(g); });
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(g); } });
      g.addEventListener("animationend", function () { g.classList.remove("pressed"); });
    });
    select(nodes[0]);

    if (!window.matchMedia || !("IntersectionObserver" in window)) return;
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    var PRESS_MS = 2000;
    var index = -1, timer = null, stopped = false, inView = false, hovering = false; /* the first press is block 1 */
    function fits() { return scroller.scrollWidth <= scroller.clientWidth + 1; }
    function focusInside() { var a = document.activeElement; return !!a && figure.contains(a); }
    function canPress() { return !stopped && inView && !hovering && !document.hidden && !focusInside() && !reduce.matches && fits(); }
    function pause() { if (timer) { clearTimeout(timer); timer = null; } }
    function settle() { if (!canPress()) pause(); else if (!timer) timer = setTimeout(press, PRESS_MS); }
    function press() {
      timer = null;
      if (!canPress()) return;
      index = (index + 1) % nodes.length;
      var g = nodes[index];
      g.classList.remove("pressed");
      void g.getBoundingClientRect(); /* restarts the pulse */
      g.classList.add("pressed");
      select(g);
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
    figure.addEventListener("click", stop);
    /* a block chosen from the keyboard is the reader taking over, as a click is */
    figure.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") stop(); });
    nodes.forEach(function (g) {
      g.addEventListener("mouseenter", function () { hovering = true; settle(); });
      g.addEventListener("mouseleave", function () { hovering = false; settle(); });
    });
    figure.addEventListener("focusin", settle);
    figure.addEventListener("focusout", function () { setTimeout(settle, 0); }); /* activeElement is settled only after focusout */
    document.addEventListener("visibilitychange", settle);
    window.addEventListener("resize", settle);
    if (reduce.addEventListener) reduce.addEventListener("change", settle);
  });

  /* ---------- copy buttons: [data-copy-from] copies its target's data-copy, else the target's text ---------- */
  function fallback(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing */ }
    document.body.removeChild(ta);
  }
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    } else { fallback(text); done(); }
  }
  each("[data-copy-from]", function (btn) {
    var label = btn.getAttribute("aria-label");
    var timer = null;
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!target) return;
      copyText(target.getAttribute("data-copy") || target.textContent, function () {
        btn.classList.add("ok");
        btn.setAttribute("aria-label", btn.getAttribute("data-done") || label);
        clearTimeout(timer);
        timer = setTimeout(function () { btn.classList.remove("ok"); btn.setAttribute("aria-label", label); }, 2000);
      });
    });
  });

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

  /* ---------- tone switch: midnight or graphite, remembered in localStorage ----------
     The early script in <head> applies the saved tone before the first paint; this keeps the
     buttons and theme-color in step, and re-reads the choice when the page returns from the
     back-forward cache. theme-color is read from the computed --bg, never written here. */
  var toneSwitch = document.querySelector(".tone-switch");
  if (toneSwitch) {
    var docEl = document.documentElement;
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    var toneBtns = Array.prototype.slice.call(toneSwitch.querySelectorAll("button[data-tone-set]"));
    var applyTone = function (tone) {
      docEl.setAttribute("data-tone", tone);
      toneBtns.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-tone-set") === tone ? "true" : "false"); });
      if (themeMeta) themeMeta.setAttribute("content", getComputedStyle(docEl).getPropertyValue("--bg").trim());
    };
    var savedTone = function () {
      try { return localStorage.getItem("ps_tone") === "graphite" ? "graphite" : "midnight"; } catch (e) { return docEl.getAttribute("data-tone") || "midnight"; }
    };
    applyTone(savedTone());
    toneBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        var tone = b.getAttribute("data-tone-set");
        try { localStorage.setItem("ps_tone", tone); } catch (e) { /* storage off: this page only */ }
        applyTone(tone);
      });
    });
    window.addEventListener("pageshow", function (ev) { if (ev.persisted) applyTone(savedTone()); });
  }
})();

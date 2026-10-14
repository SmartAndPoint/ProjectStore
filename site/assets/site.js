/* ProjectStore site — tabs, the loop's steps and cartoon, copy buttons, the language switcher, the tone switch,
   the graph behind the page.
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

  /* ---------- tone switch: midnight, graphite or light, remembered in localStorage ----------
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
    // a stored tone counts only if a button offers it, so this script keeps no list of tones
    var offered = function (tone) { return toneBtns.some(function (b) { return b.getAttribute("data-tone-set") === tone; }); };
    var savedTone = function () {
      try { var s = localStorage.getItem("ps_tone"); return offered(s) ? s : "midnight"; } catch (e) { return docEl.getAttribute("data-tone") || "midnight"; }
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

  /* ---------- the graph behind the page: links that draw themselves as the page scrolls ----------
     One JSON literal the site test reads, cut from this project's own vault by site/tools/graph-slice.mjs
     (rerun it rather than edit by hand): a slice of the vault's graph.md around ADR-010, accepted, done,
     active, final and in-progress artifacts only. Nodes as [x, y, kind, label] in a 1000 x 1000 box that
     the script stretches to the window (so strokes stay 1 px and dots round), the label the artifact's
     number or kind and its slug; lines as [from, to] node indexes, the vault's own links, in growth
     order (each starts at a seed or at a node an earlier line reached), and "open", the lines drawn at
     the top. Each node is two circles, its beacon and the node, and a ring in a layer of HTML over the
     svg (an HTML ring breathes by transform without a layout per frame; an SVG one does not). The script
     writes no colour: geometry, lengths (--len), progress (--p), ring places (--x, --y) and class names.
     Reduced motion, and a page with nothing to scroll, show the graph whole. */
  var GRAPH = {"seeds":[0],"open":5,"nodes":[[905,165,"adr","ADR-010 slug-first-artifa…"],[627,186,"epic","epic PS-CORE"],[948,429,"spec","spec atomic-regeneration-…"],[904,352,"spec","spec creation-time-index-…"],[503,350,"story","story-001 slug-first-arti…"],[251,241,"story","story adr-for-the-mcp-rea…"],[612,290,"story","story atomic-regeneration…"],[741,858,"spec","spec entry-rule-detection…"],[670,499,"spec","spec vault-link-graph-der…"],[706,214,"story","story creation-time-index…"],[563,437,"spec","SPEC-002 slug-first-artif…"],[231,352,"adr","adr one-package-n-manifes…"],[69,509,"story","story adr-amendment-one-p…"],[662,751,"adr","ADR-002 managed-agent-reg…"],[537,872,"adr","ADR-006 statusline-per-se…"],[798,901,"adr","adr artifact-first-order-…"],[421,613,"story","story mcp-read-surface-ha…"],[705,595,"story","story vault-link-graph-de…"],[564,606,"adr","ADR-005 umbrella-doctor-i…"],[800,721,"adr","adr vault-link-graph-as-a…"],[208,643,"story","story token-free-cli-the-…"],[124,218,"story","story install-refresh-and…"],[243,458,"story","story install-upgrade-and…"],[65,738,"story","story claim-the-npm-name-…"],[279,825,"research","research v013-design-ques…"],[919,877,"epic","epic PS-AGENTS"],[870,579,"story","story-007 agents-registra…"],[447,838,"research","research foundational-dec…"]],"lines":[[0,1],[0,2],[0,3],[2,3],[1,4],[1,5],[1,6],[2,6],[2,7],[2,8],[0,8],[3,9],[1,9],[3,10],[0,10],[4,10],[8,10],[5,11],[5,12],[7,13],[7,14],[7,15],[8,16],[8,17],[8,18],[10,19],[11,20],[11,21],[11,22],[12,23],[13,24],[13,25],[13,26],[14,27]]};
  (function () {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "graph");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var lines = GRAPH.lines.map(function (l) {
      var el = document.createElementNS(NS, "line");
      svg.appendChild(el);
      return { el: el, from: GRAPH.nodes[l[0]], to: l[1] };
    });
    function circles(name) {
      return GRAPH.nodes.map(function () {
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "4");
        c.setAttribute("class", name);
        svg.appendChild(c);
        return c;
      });
    }
    /* under each node a beacon, large and light while a line heads for it */
    var beacons = circles("beacon"), dots = circles("node");
    var labels = GRAPH.nodes.map(function (n) {
      var t = document.createElementNS(NS, "text");
      t.setAttribute("class", "label");
      t.textContent = n[3];
      svg.appendChild(t);
      return t;
    });
    var ringBox = document.createElement("div");
    ringBox.setAttribute("class", "graph-rings");
    ringBox.setAttribute("aria-hidden", "true");
    var rings = GRAPH.nodes.map(function () {
      var s = document.createElement("span");
      s.setAttribute("class", "ring");
      ringBox.appendChild(s);
      return s;
    });
    document.body.insertBefore(svg, document.body.firstChild); /* after body::before: above the glow */
    document.body.insertBefore(ringBox, svg.nextSibling);
    var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var range = 0, frame = 0, live = false;
    function layout() {
      var box = svg.getBoundingClientRect(), sx = box.width / 1000, sy = box.height / 1000;
      lines.forEach(function (l) {
        var b = GRAPH.nodes[l.to], x1 = l.from[0] * sx, y1 = l.from[1] * sy, x2 = b[0] * sx, y2 = b[1] * sy;
        l.el.setAttribute("x1", x1); l.el.setAttribute("y1", y1);
        l.el.setAttribute("x2", x2); l.el.setAttribute("y2", y2);
        l.el.style.setProperty("--len", Math.ceil(Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))) + "px");
      });
      var shown = [];
      GRAPH.nodes.forEach(function (n, i) {
        var x = n[0] * sx, y = n[1] * sy;
        [beacons[i], dots[i]].forEach(function (c) { c.setAttribute("cx", x); c.setAttribute("cy", y); });
        /* a label reads rightward, or leftward where it would leave the window (about 6.6 px a character);
           in growth order, it shows only where it covers no label shown before it and no other node, so a
           short or narrow window drops a few labels rather than piling them up */
        var w = n[3].length * 6.6, right = x + 10 + w > box.width - 8;
        var at = right ? [x - 10 - w, y - 6, x - 10, y + 6] : [x + 10, y - 6, x + 10 + w, y + 6];
        var clear = shown.every(function (o) { return at[0] >= o[2] || o[0] >= at[2] || at[1] >= o[3] || o[1] >= at[3]; }) &&
          GRAPH.nodes.every(function (m, j) {
            var mx = m[0] * sx, my = m[1] * sy;
            return j === i || mx < at[0] - 4 || mx > at[2] + 4 || my < at[1] - 4 || my > at[3] + 4;
          });
        if (clear) shown.push(at);
        labels[i].setAttribute("class", clear ? "label" : "label off");
        labels[i].setAttribute("x", x + (right ? -10 : 10));
        labels[i].setAttribute("y", y + 3.5);
        labels[i].setAttribute("text-anchor", right ? "end" : "start");
        rings[i].style.setProperty("--x", x + "px");
        rings[i].style.setProperty("--y", y + "px");
      });
      range = document.documentElement.scrollHeight - window.innerHeight; /* read here, never per scroll */
    }
    function draw() {
      frame = 0;
      var whole = (reduce && reduce.matches) || range < 1;
      var p = whole ? 1 : Math.min(1, Math.max(0, window.scrollY / range));
      var rest = lines.length - GRAPH.open, step = 0.9 / Math.max(rest + 1, 1), reached = [];
      GRAPH.seeds.forEach(function (i) { reached[i] = 1; });
      lines.forEach(function (l, i) {
        var q = whole || i < GRAPH.open ? 1 : Math.min(1, Math.max(0, (p - (i - GRAPH.open) * step) / (2 * step)));
        l.el.style.setProperty("--p", q.toFixed(3));
        reached[l.to] = Math.max(reached[l.to] || 0, q);
        l.done = mark(l.el, l.done, q >= 0.999, "", "fresh");
      });
      dots.forEach(function (c, i) {
        var q = (reached[i] || 0).toFixed(3), on = q >= 0.999;
        [beacons[i], c, labels[i]].forEach(function (el) { el.style.setProperty("--p", q); });
        c.done = mark(c, c.done, on, "node", "ping");
        if (on !== !!rings[i].on) rings[i].setAttribute("class", on ? "ring on" : "ring"); /* a reached node breathes */
        rings[i].on = on;
      });
    }
    /* a line the scroll has just drawn pulses, and its node pings; none does before the page has loaded,
       so the lines drawn when it opened, or by a jump to an anchor, stay still */
    function mark(el, was, now, base, name) {
      if (now !== !!was) el.setAttribute("class", now && live ? (base + " " + name).trim() : base);
      return now;
    }
    function redraw() { layout(); draw(); }
    redraw();
    window.addEventListener("scroll", function () { if (!frame) frame = window.requestAnimationFrame(draw); }, { passive: true });
    window.addEventListener("resize", redraw);
    window.addEventListener("load", function () { redraw(); live = true; });
    window.addEventListener("pageshow", redraw);
    if (window.ResizeObserver) new window.ResizeObserver(redraw).observe(document.body); /* a page that grows, as <details> open */
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", draw);
  })();
})();

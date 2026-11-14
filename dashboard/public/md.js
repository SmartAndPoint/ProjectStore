// Markdown, as the vault writes it, to DOM nodes, for reading. Hand-rolled
// so that the page has no dependencies and nothing is downloaded.
//
// Nothing here uses innerHTML: every piece of text becomes a text node, and
// a link or a file is shown only when its address is one the page allows.
//
// ctx: { rel, link(target) → {open} | {href} | null, media(url) → {src, kind} | null }

const MD = (() => {
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled" || k === "controls") n[k] = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  const IMG = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;
  const VIDEO = /\.(mp4|webm|mov)(\?|#|$)/i;
  const AUDIO = /\.(mp3|wav|m4a|ogg)(\?|#|$)/i;
  const kindOf = (url) => (IMG.test(url) ? "image" : VIDEO.test(url) ? "video" : AUDIO.test(url) ? "audio" : "file");

  // A picture, a video, a sound, or a link to a file.
  function media(url, alt, ctx) {
    const m = ctx.media ? ctx.media(url) : null;
    if (!m) return el("span", { class: "md-broken", title: url }, `[${alt || "file"}: not shown]`);
    if (m.kind === "image") return el("img", { src: m.src, alt: alt || "", loading: "lazy", class: "md-media" });
    if (m.kind === "video") return el("video", { src: m.src, controls: true, preload: "metadata", class: "md-media" });
    if (m.kind === "audio") return el("audio", { src: m.src, controls: true, preload: "metadata" });
    return el("a", { href: m.src, target: "_blank", rel: "noopener noreferrer", class: "md-file" }, `📎 ${alt || url.split("/").pop()}`);
  }

  function anchor(target, label, ctx) {
    const l = ctx.link ? ctx.link(target) : null;
    if (!l) return el("span", { class: "md-broken", title: `${target}: nothing here by that name` }, label);
    // What the link leads to stands before its text: the kind of an artifact, or the host and the object.
    const marks = l.icons?.length && typeof icons === "function" ? el("span", { class: "icos" }, icons(l.icons)) : null;
    if (l.open) return el("a", { href: l.href || "#", class: "md-internal", title: l.title || "", onclick: (e) => (e.preventDefault(), l.open()) }, marks, label);
    return el("a", { href: l.href, target: "_blank", rel: "noopener noreferrer", title: l.title || "" }, marks, label);
  }

  const INLINE =
    // A paragraph wrapped by hand breaks its lines anywhere, so bold, a link's text, code and the
    // other marks may run over a line break. A paragraph never holds an empty line. Italic text
    // may hold bold inside it: *a note with **one strong** word*.
    /(!?\[\[[^\]\n]+\]\])|(!\[[^\]\n]*\]\([^)\n]+\))|(\[[^\]]+\]\([^)\n]+\))|(`[^`]+`)|(\*\*[\s\S]+?\*\*)|(~~[^~]+~~)|(\*(?!\*)[^*\s](?:[^*]|\*\*[^*]+\*\*)*\*(?!\*))|((?<![\w/])_[^_]+_(?![\w/]))|(https?:\/\/[^\s<>)\]]+)/g;

  function inline(text, ctx) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (m[1]) {
        // [[target|label]], with the bar escaped inside a table, or ![[file]]
        const embed = t.startsWith("!");
        const inner = t.slice(embed ? 3 : 2, -2).replace(/\\\|/g, "|");
        const bar = inner.indexOf("|");
        const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
        const label = bar === -1 ? target.split("/").pop() : inner.slice(bar + 1).trim();
        out.push(embed && kindOf(target) !== "file" ? media(target, label, ctx) : anchor(target, label, ctx));
      } else if (m[2]) {
        const p = t.match(/^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/);
        out.push(p ? media(p[2], p[1], ctx) : t);
      } else if (m[3]) {
        const p = t.match(/^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/);
        out.push(p ? anchor(p[2], inline(p[1], ctx), ctx) : t);
      } else if (m[4]) out.push(el("code", null, t.slice(1, -1)));
      else if (m[5]) out.push(el("strong", null, inline(t.slice(2, -2), ctx)));
      else if (m[6]) out.push(el("del", null, inline(t.slice(2, -2), ctx)));
      else if (m[7] || m[8]) out.push(el("em", null, inline(t.slice(1, -1), ctx)));
      else if (m[9]) {
        const url = t.replace(/[.,;:!?]+$/, "");
        out.push(anchor(url, url, ctx), t.slice(url.length));
      }
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());

  function list(buf, ctx) {
    const items = [];
    for (const raw of buf) {
      const m = raw.match(/^(\s*)([-*+]|\d+[.)])(?:\s+(.*))?$/);
      if (m) items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), text: m[3] || "" });
      else if (items.length) items[items.length - 1].text += `\n${raw.trim()}`;
    }
    const base = Math.min(...items.map((i) => i.indent));
    const build = (start, indent) => {
      const node = el(items[start].ordered ? "ol" : "ul");
      let k = start;
      while (k < items.length && items[k].indent >= indent) {
        if (items[k].indent > indent) {
          const [sub, next] = build(k, items[k].indent);
          (node.lastChild || node.appendChild(el("li"))).append(sub);
          k = next;
          continue;
        }
        const it = items[k];
        const task = it.text.match(/^\[( |x|X)\](?:\s+([\s\S]*))?$/);
        if (task) node.append(el("li", { class: `task${task[1] === " " ? "" : " done"}` }, el("input", { type: "checkbox", checked: task[1] !== " ", disabled: true }), el("span", null, inline(task[2] || "", ctx))));
        else if (it.text.trim()) node.append(el("li", null, inline(it.text, ctx)));
        k++;
      }
      return [node, k];
    };
    const [node] = build(0, base);
    return node.childNodes.length ? node : null;
  }

  function render(src, ctx = {}) {
    const lines = String(src)
      .replace(/<!--[\s\S]*?-->/g, "")
      .split("\n");
    const out = el("div", { class: "md" });
    const para = [];
    const flush = () => {
      if (para.length) out.append(el("p", null, inline(para.join("\n"), ctx)));
      para.length = 0;
    };
    const isItem = (l) => /^\s*([-*+]|\d+[.)])(\s+|$)/.test(l);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^\s*(```|~~~)/))) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
        i++;
        out.append(el("pre", null, el("code", null, buf.join("\n"))));
      } else if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
        flush();
        out.append(el(`h${m[1].length}`, null, inline(m[2], ctx)));
        i++;
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush();
        out.append(el("hr"));
        i++;
      } else if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.append(el("blockquote", null, ...render(buf.join("\n"), ctx).childNodes));
      } else if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const head = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.append(
          el(
            "div",
            { class: "md-table" },
            el("table", null, el("thead", null, el("tr", null, head.map((c) => el("th", null, inline(c, ctx))))), el("tbody", null, rows.map((r) => el("tr", null, head.map((_, k) => el("td", null, inline(r[k] || "", ctx))))))),
          ),
        );
      } else if (isItem(line)) {
        flush();
        const buf = [];
        while (i < lines.length && (isItem(lines[i]) || (buf.length && /^\s+\S/.test(lines[i])))) buf.push(lines[i++]);
        const node = list(buf, ctx);
        if (node) out.append(node);
      } else if (!line.trim()) {
        flush();
        i++;
      } else {
        para.push(line);
        i++;
      }
    }
    flush();
    return out;
  }

  return { render, kindOf };
})();

// A check of the editor in the page itself: it types, pastes and removes text in the
// item that is open, looks at what is drawn and where, and puts the text back.
// Nothing is saved: Save is shut while it runs (the spec dashboard-editor, contract 11). Run it
// from the palette ("Check the editor"). What needs no page (which parts are marked after which
// edits) is checked in dashboard/editor/test/.

// The flag that shuts Save and the redraws is cleared however the run ends.
async function selfTest() {
  try {
    return await selfTestRun();
  } finally {
    window.WS_SELFTEST = false;
  }
}

async function selfTestRun() {
  const d = ED; // item.js: the editor of the open item
  const out = [];
  if (!d?.ed || !d.host?.isConnected) return [{ name: "an item is open in the editor", ok: false, detail: "open a story first" }];
  if (d.unsaved()) return [{ name: "the open item has no unsaved text", ok: false, detail: "save or discard it first: the check rewrites the text and puts it back" }];
  const ed = d.ed;
  const v = ed.view;
  const body = ed.text();
  // item.js: a redraw of the drawer (the Code block's answer, a refresh) leaves the editor alone meanwhile.
  window.WS_SELFTEST = true;
  const keptBase = ed.baseline;
  const text = () => v.state.doc.toString();
  const pause = () => new Promise((r) => setTimeout(r, 40));
  const topOf = (pos) => (v.measure(), Math.round(v.coordsAtPos(pos)?.top ?? NaN));
  const marks = () => ({ added: [...v.dom.querySelectorAll(".cm-changedText")].map((x) => x.textContent).join("").trim(), gone: [...v.dom.querySelectorAll("del.cm-deletedText")].map((x) => x.textContent) });
  const key = (name, more = {}) => v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...more }));
  const paste = (fill) => {
    const dt = new DataTransfer();
    fill(dt);
    v.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  const type = (s) => {
    for (const ch of s) v.dispatch(v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" }));
  };
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      out.push({ name, ok: true, detail: detail || "" });
    } catch (e) {
      out.push({ name, ok: false, detail: String(e.message || e) });
    }
    ed.replaceAll(body);
    await pause();
  };
  const must = (ok, why) => {
    if (!ok) throw new Error(why);
  };

  // A fixed text, so the check reads the same in any vault.
  const P1 = "First paragraph of the check, long enough to wrap when the pane is narrow.";
  const P2 = "Second paragraph of the check. It is removed, moved and put back.";
  const SAMPLE = `## Check\n\n${P1}\n\n${P2}\n\n## After\n\n- [ ] one\n- [ ] two\n`;
  const fresh = async () => {
    ed.replaceAll(SAMPLE);
    ed.setBaseline(SAMPLE);
    v.focus();
    await pause();
  };

  await check("typing on an empty line moves nothing below it and draws nothing as removed", async () => {
    await fresh();
    const blank = text().indexOf(P2) - 1;
    v.dispatch({ selection: { anchor: blank }, scrollIntoView: true });
    const at = () => [topOf(text().indexOf(P2)), topOf(text().indexOf("## After"))];
    const before = at();
    must(!before.some(Number.isNaN), "the page is not laid out: the pane is hidden or too small");
    for (const ch of "это чертовски круто!") {
      type(ch);
      const now = at();
      must(now[0] === before[0] && now[1] === before[1], `the text below moved by ${now[0] - before[0]}px after "${ch}"`);
      must(!marks().gone.length, "something is drawn as removed");
    }
    must(marks().added === "это чертовски круто!", `marked as added: "${marks().added}"`);
    return "20 keys, 0 px";
  });

  await check("a removed paragraph stays struck through where it stood", async () => {
    await fresh();
    const from = text().indexOf(P2);
    const was = [topOf(from), topOf(text().indexOf("## After"))];
    v.dispatch({ selection: { anchor: from - 1 } });
    type("new line");
    v.dispatch({ changes: { from: text().indexOf(P2), to: text().indexOf(P2) + P2.length }, userEvent: "delete.cut" });
    await pause();
    const gone = v.dom.querySelector("del.cm-deletedText");
    must(gone && gone.textContent === P2, "the paragraph is not drawn as removed");
    must(Math.abs(Math.round(gone.getBoundingClientRect().top) - was[0]) <= 2, `the removed paragraph is drawn ${Math.round(gone.getBoundingClientRect().top) - was[0]}px from where it stood`);
    must(topOf(text().indexOf("## After")) === was[1], "the heading below moved");
  });

  await check("a line removed with its line break leaves the lines below where they were", async () => {
    await fresh();
    const from = text().indexOf("- [ ] one");
    const below = () => [topOf(text().indexOf("two") + 1)];
    const was = below();
    v.dispatch({ changes: { from, to: from + "- [ ] one\n".length }, userEvent: "delete.cut" });
    await pause();
    const gone = v.dom.querySelector("del.cm-deletedText");
    must(gone && gone.textContent.startsWith("- [ ] one"), "the line is not drawn as removed");
    must(Math.abs(below()[0] - was[0]) <= 1, `the line below moved by ${below()[0] - was[0]}px`);
  });

  await check("Enter in a task list starts the next task (the key itself)", async () => {
    await fresh();
    v.dispatch({ selection: { anchor: text().indexOf("- [ ] two") + 9 } });
    key("Enter");
    type("three");
    must(text().includes("- [ ] two\n- [ ] three"), "no new task line");
    must(marks().added === "- [ ] three" || marks().added === "three", `marked as added: "${marks().added}"`);
  });

  await check("pasted plain text goes in at the cursor and is the only mark", async () => {
    await fresh();
    v.dispatch({ selection: { anchor: text().indexOf("paragraph of") } });
    paste((dt) => dt.setData("text/plain", "pasted "));
    await pause();
    must(text().includes("First pasted paragraph of"), "the text is not where the cursor was");
    must(marks().added === "pasted" && !marks().gone.length, `marks: +"${marks().added}" −${marks().gone.length}`);
  });

  await check("text copied from a page comes in as Markdown", async () => {
    await fresh();
    v.dispatch({ selection: { anchor: text().length } });
    paste((dt) => {
      dt.setData("text/plain", "Bold and a link");
      dt.setData("text/html", '<p><b>Bold</b> and <a href="https://example.com/x">a link</a></p>');
    });
    await pause();
    must(text().includes("**Bold** and [a link](https://example.com/x)"), `got: ${JSON.stringify(text().slice(SAMPLE.length))}`);
  });

  await check("a URL pasted over selected words links them", async () => {
    await fresh();
    const from = text().indexOf("Second paragraph");
    v.dispatch({ selection: { anchor: from, head: from + 16 } });
    paste((dt) => dt.setData("text/plain", "https://example.com/doc"));
    await pause();
    must(text().includes("[Second paragraph](https://example.com/doc)"), "no link");
  });

  const png = () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    return new File([bytes], "check-shot.png", { type: "image/png" });
  };
  // Pictures (the spec dashboard-attachments, contract 9): a pasted or a dropped one puts a link at
  // the cursor and is drawn from the page's memory, ↩ puts the text back, and nothing is saved.
  // Where pictures are not kept (no attachments folder, or a server whose save takes no files),
  // the text stays as it was and the check says so. The page's memory is as before afterwards.
  const pastedBefore = new Map(PASTED); // item.js
  const kept = d.picturesKept();
  const pictureCheck = async (put) => {
    await fresh();
    const at = put();
    await d.taking;
    await pause();
    if (!kept) {
      must(text() === SAMPLE, "the text changed");
      must(d.ed.changes() === 0, `${d.ed.changes()} changes counted`);
      return "pictures are not kept here: the text stays as it was";
    }
    const m = /!\[check-shot\.png\]\(([^)\s]+)\)/.exec(text());
    must(m, "no link to the picture in the text");
    must(Math.abs(m.index - at) <= 1, `the link is at ${m.index}, the cursor was at ${at}`);
    // Drawn while the cursor is elsewhere; its ↩ shows where the cursor is.
    v.dispatch({ selection: { anchor: 0 } });
    await pause();
    must(v.dom.querySelector('img.cm-media[src^="data:image/png"]'), "the picture is not drawn");
    v.dispatch({ selection: { anchor: m.index + 2 } });
    await pause();
    const b = v.dom.querySelector("button.cm-putback");
    must(b, "no ↩ button");
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await pause();
    must(text() === SAMPLE, "↩ did not put the text back");
    return "";
  };
  await check("a pasted picture becomes a link at the cursor, drawn, and ↩ puts the text back", () =>
    pictureCheck(() => {
      const at = text().indexOf(P1) + P1.length;
      v.dispatch({ selection: { anchor: at } });
      paste((dt) => dt.items.add(png()));
      return at;
    }),
  );
  await check("a dropped picture becomes a link where it was dropped, drawn, and ↩ puts the text back", () =>
    pictureCheck(() => {
      const pos = text().indexOf(P2);
      const c = (v.measure(), v.coordsAtPos(pos));
      must(c, "the page is not laid out");
      const dt = new DataTransfer();
      dt.items.add(png());
      v.contentDOM.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: c.left + 1, clientY: (c.top + c.bottom) / 2, bubbles: true, cancelable: true }));
      return pos;
    }),
  );
  PASTED.clear();
  for (const [k, x] of pastedBefore) PASTED.set(k, x);

  await check("the ↩ button puts a change back", async () => {
    await fresh();
    v.dispatch({ changes: { from: text().indexOf("First"), to: text().indexOf("First") + 5, insert: "Changed" }, userEvent: "input.paste" });
    await pause();
    const b = v.dom.querySelector("button.cm-putback");
    must(b, "no button");
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await pause();
    must(text() === SAMPLE, "the text is not as it was");
    must(d.ed.changes() === 0, "a mark is left");
  });

  await check("undo takes the mark away with the text", async () => {
    await fresh();
    v.dispatch({ selection: { anchor: text().indexOf(P1) + P1.length } });
    type(" More.");
    await new Promise((r) => setTimeout(r, 600)); // typed text is one undo step after a pause
    must(d.ed.changes() === 1, "no mark after typing");
    key("z", { metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform) });
    await pause();
    must(text() === SAMPLE, "undo did not take the text back");
    must(d.ed.changes() === 0, "a mark is left after undo");
  });

  // Back to the file as it is, and to the comparison that was chosen.
  ed.setBaseline(keptBase);
  ed.replaceAll(`${body}\n`); // a change and its undoing, so the page counts the marks again
  ed.replaceAll(body);
  await pause();
  window.WS_SELFTEST = false;
  out.push({ name: "the item is as it was, nothing to save", ok: !d.unsaved() && ed.text() === body, detail: "" });
  return out;
}

async function selfTestDialog() {
  const r = await selfTest();
  const bad = r.filter((x) => !x.ok).length;
  dialog(
    bad ? `The editor check: ${bad} of ${r.length} failed` : `The editor check: all ${r.length} pass`,
    h("div", { class: "selftest" }, r.map((x) => h("div", { class: `st ${x.ok ? "ok" : "bad"}` }, h("b", null, x.ok ? "ok" : "FAIL"), h("span", null, x.name), x.detail && h("i", null, x.detail)))),
    [],
  );
  return r;
}

// The Code block: what the project's code says about a story or a spec (the
// spec "The dashboard's Code block…", alias `dashboard-code`, contract 11).
// The server reads the project's repository as last fetched and one list of
// its pull requests from gh, and changes nothing there; this file asks for it
// with one POST of the page's own and draws it in the item's side panel.
// Loaded after item.js and related.js, and shares their helpers (h, ui, ico,
// statusPill, openByRel, renderDrawer).
//
// Every text from the code host or from git is drawn as text, and a link out
// of the page is only an https: url that gh gave.

const codeUi = (() => {
  const ROUTE = "/api/code";
  const HOW = {
    recorded: ["recorded", "The story's own field external_refs.pr names this pull request. The follow verb counts this link."],
    closes: ["Closes-story", "A line Closes-story: in the pull request's description names this story. The follow verb counts this link."],
    "closes-uncounted": ["Closes-story, not counted", "A line Closes-story: names this story, but the follow verb would not count it."],
    named: ["named", "The pull request's title or description names this story by its title. That says the two belong together, not that it delivers the story."],
    mentioned: ["in the story's text", "The story's text names this pull request by its number."],
    derived: ["by its commits", "A commit it brought in touched one of the story's code paths while the story was open. Nobody wrote this link down."],
  };
  const token = () => document.querySelector('meta[name="projectstore-token"]')?.getAttribute("content") || "";
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const isHttps = (u) => typeof u === "string" && /^https:\/\//i.test(u);
  const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  // A capital first letter, unless the sentence starts with a command's name.
  const sentence = (s) => (!s ? "" : /^(gh|git)\b/.test(s) ? String(s) : String(s).charAt(0).toUpperCase() + String(s).slice(1));
  let seq = 0;

  // The one POST of this file. → the answer, or { ok: false, error }.
  async function post(body) {
    let r;
    try {
      r = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", "x-projectstore-token": token() },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (e) {
      return { ok: false, error: `the page's server did not answer: ${e?.message || e}` };
    }
    try {
      const a = await r.json();
      return a && typeof a === "object" ? a : { ok: false, error: `the page's server answered ${r.status} with no JSON` };
    } catch {
      return { ok: false, error: `the page's server answered ${r.status} with no JSON` };
    }
  }

  // Whether an open item has a Code block, and its file.
  function relFor(d) {
    if (!d) return null;
    if (d.kind === "story") return story(d.id)?.rel || null;
    if (d.kind === "doc" && artByRel.get(d.id)?.type === "spec") return d.id;
    return null;
  }

  // Ask for the block; the last answer stays drawn until the next one comes.
  async function ask(d, { fresh = false } = {}) {
    const rel = relFor(d);
    if (!rel) return;
    const mine = ++seq;
    d.codeAsking = true;
    if (fresh) renderDrawer();
    const a = await post(fresh ? { rel, fresh: true } : { rel });
    if (mine !== seq || ui.drawer !== d) return;
    d.codeAsking = false;
    d.code = a.ok ? a.result : { failed: a.error || "the Code block could not be read" };
    renderDrawer();
  }

  // ── pieces ──
  function ext(url, text, title) {
    if (!isHttps(url)) return h("span", null, text);
    return h("a", { class: "link ext", href: url, target: "_blank", rel: "noopener noreferrer", title: title || "Opens on the code host" }, text);
  }
  const prIco = (state) => {
    const el = ico(state === "merged" ? "merged" : "pull", state ? `${state} pull request` : "pull request");
    el.classList.add(`s-${state || "unknown"}`);
    return el;
  };
  const howChips = (how, why) => how.map((x) => h("span", { class: `chip how how-${x}`, title: [HOW[x]?.[1], why?.[x]].filter(Boolean).join("\n") }, HOW[x]?.[0] || x));
  const share = (p) => (p.files === null || p.files === undefined ? (p.filesReason ? `Its files: unknown, ${p.filesReason}.` : null) : `${p.inside} of ${plural(p.files, "file")} in the story's code paths`);
  const unknownLine = (what, why) => h("div", { class: "code-unknown" }, `${what}: unknown. ${sentence(why)}.`);

  function where(c) {
    const m = c.main;
    if (!m) return null;
    const bits = [];
    bits.push(m.fetched ? `${c.repo ? `${c.repo}, ` : ""}${m.short} at ${m.hash}, ${dayOf(m.date)}` : `no fetched default branch is known; the checkout's HEAD at ${m.hash}`);
    bits.push("the local repository as last fetched; the page fetches nothing");
    if (m.fetchedAt) bits.push(`last fetched ${dayOf(m.fetchedAt)}`);
    if (m.fetched) bits.push(m.behind === null || m.behind === undefined ? "how far the checkout is behind is unknown" : m.behind ? `the checkout is ${plural(m.behind, "commit")} behind` : "the checkout is not behind it");
    if (m.shallow) bits.push("the repository is shallow, so older commits are unknown");
    return h("div", { class: "code-where faint" }, `${sentence(bits.join("; "))}.`);
  }

  function prRow(p) {
    return h(
      "div",
      { class: `srel code-pr${p.link ? "" : " code-lead"}` },
      h("div", { class: "code-pr-t" }, prIco(p.state), ext(p.url, p.number ? `#${p.number}` : "a pull request"), p.repo ? h("span", { class: "faint" }, p.repo) : null, h("span", { class: "code-title", title: p.title || "" }, p.title || "")),
      h("div", { class: "srel-meta" }, p.state ? h("span", { class: "faint" }, p.state) : h("span", { class: "faint" }, "state unknown"), howChips(p.how, p.why)),
      share(p) ? h("div", { class: "faint code-share" }, share(p)) : null,
    );
  }

  function storyBlock(d, c) {
    const links = c.prs.filter((p) => p.link);
    const leads = c.prs.filter((p) => !p.link && p.how.some((x) => x !== "derived"));
    const derived = c.prs.filter((p) => !p.link && p.how.every((x) => x === "derived"));
    ui.codeOpen ??= {};
    const remember = (key) => (e) => setTimeout(() => (ui.codeOpen[key] = e.target.closest("details").open));
    const commits = !c.window
      ? h("div", { class: "faint" }, sentence(c.windowReason || "no commit can be tied to it") + ".")
      : c.unknown.git
        ? unknownLine("Commits", c.unknown.git)
        : h(
            "details",
            { open: ui.codeOpen.commits ?? false },
            h("summary", { onclick: remember("commits") }, ico("commit"), "Commits while it was open", h("span", { class: "faint" }, `${c.truncated ? "over " : ""}${c.commitCount}`)),
            c.loose ? h("div", { class: "faint" }, `${plural(c.loose, "commit")} came with no pull request.`) : null,
            h("div", { class: "code-commits" }, c.commits.map((k) => h("div", { class: "code-commit" }, h("code", null, k.hash), h("span", { class: "code-subj", title: k.subject }, k.subject), h("span", { class: "faint" }, k.pr ? `#${k.pr}` : c.unknown.prs ? "PR unknown" : "no PR")))),
            c.commitCount > c.commits.length ? h("div", { class: "faint" }, `and ${c.commitCount - c.commits.length} more`) : null,
          );
    return [
      c.unknown.prs ? unknownLine("Pull requests", c.unknown.prs) : null,
      c.listFull ? h("div", { class: "faint" }, "Only the newest 1000 pull requests were read.") : null,
      h("div", { class: "code-h" }, "Links"),
      links.length ? links.map(prRow) : h("div", { class: "faint" }, "None: no pull request is named in the story's field or by a counted Closes-story line."),
      leads.length ? [h("div", { class: "code-h" }, "Leads, not links"), leads.map(prRow)] : null,
      derived.length ? h("details", { open: ui.codeOpen.derived ?? false }, h("summary", { onclick: remember("derived") }, "Found by commits alone", h("span", { class: "faint" }, derived.length)), h("div", { class: "faint" }, "Nobody wrote these down. A file shared with other stories brings their pull requests here."), derived.map(prRow)) : null,
      commits,
      c.skipped?.length ? h("div", { class: "code-unknown" }, `Skipped code paths outside the repository: ${c.skipped.join(", ")}.`) : null,
      c.refsForm && c.refsForm !== "json" ? h("div", { class: "code-unknown" }, `code_refs is written as ${c.refsForm === "block" ? "a block list" : "a list with no quotes"}. The page reads it; the core does not see these paths.`) : null,
    ];
  }

  function specBlock(d, c) {
    if (c.error) return h("div", { class: "faint" }, `${sentence(c.error)}.`);
    const group = (a) =>
      h(
        "div",
        { class: "srel code-anchor" },
        h("div", null, h("b", null, `${a.contracts.length === 1 ? "Contract" : "Contracts"} ${a.contracts.map((x) => x.n).join(", ")}`)),
        h("div", { class: "faint" }, a.from.includes("marker") ? `amended ${a.anchor}` : `as written ${a.anchor}`),
        h("div", { class: "faint" }, a.commits === null ? "Commits since: unknown." : a.commits ? `Since then ${plural(a.commits, "commit")} touched ${plural(a.files, "file")}${a.prCount === null ? "" : `, in ${plural(a.prCount, "pull request")}`}${a.loose ? `; ${a.loose} with none` : ""}.` : "No commit since."),
        a.prs.length ? h("div", { class: "code-prs" }, a.prs.map((p) => ext(p.url, `#${p.number}`, p.title || ""))) : null,
      );
    return [
      c.unknown.prs ? unknownLine("Pull requests", c.unknown.prs) : null,
      c.unknown.git ? unknownLine("Commits", c.unknown.git) : null,
      h("div", { class: "faint" }, `${plural(c.files.length, "file")} behind ${plural(c.stories.length, "story", "stories")}, read from the checkout. A change after an amendment is a place to look, not drift: the reviewer's spec-drift mode judges that.`),
      c.anchors.map(group),
      h("div", { class: "code-h" }, "Stories it covers"),
      c.stories.map((s) =>
        h(
          "div",
          { class: "srel" },
          s.rel ? h("button", { class: "link", onclick: () => openByRel(s.rel), title: s.title }, s.title) : h("span", null, s.title),
          h("div", { class: "srel-meta" }, s.status ? statusPill(s.status) : null, s.prs.length ? s.prs.map((p) => h("span", { class: "code-pr-chip" }, ext(p.url, `#${p.number}`, p.title || ""), howChips([p.how[0]]))) : h("span", { class: "faint" }, "no pull request written down"), s.missing ? h("span", { class: "chip flag" }, `${s.missing} not in the checkout`) : null),
        ),
      ),
    ];
  }

  // The block in the side panel, or null for an item that has none.
  function block(d) {
    if (!relFor(d)) return null;
    const c = d.code;
    const again = h("button", { class: "link", onclick: () => ask(d, { fresh: true }), title: "Read the pull requests from gh again" }, d.codeAsking && c ? "asking…" : "Ask gh again");
    const head = h("h3", { class: "side-h" }, h("span", null, ico("github"), " Code"), c && !c.failed ? again : null);
    if (!c) return h("div", { class: "side-rel side-code" }, head, h("div", { class: "faint" }, "reading the repository…"));
    if (c.failed) return h("div", { class: "side-rel side-code" }, head, h("div", { class: "code-unknown" }, `${sentence(c.failed)}.`));
    return h("div", { class: "side-rel side-code" }, head, c.kind === "spec" ? specBlock(d, c) : storyBlock(d, c), where(c));
  }

  return { ask, block, relFor, HOW };
})();

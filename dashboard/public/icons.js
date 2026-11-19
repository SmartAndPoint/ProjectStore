// One set of icons for the whole page: an artifact's kind, a code host, a git
// object. Each is drawn once here and used by its name, so a kind has the same
// picture in the tree, in Related, in the search and in a link inside a text.
//
// An icon is a mask over the text colour: it follows the theme and the colour
// of what it stands beside. It never stands alone for a meaning: a word is
// beside it, or it carries a label.
//
// The pictures of kinds and git objects are drawn for this page. The two host
// marks are the hosts' own (GitHub's from its Octicons, GitLab's from Simple
// Icons) and are used only on a link that leads to that host.
const STROKE = 'fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  // kinds of artifacts
  initiative: ['<path d="M3.75 14.25V2.25M3.75 2.75h8.5l-2 3 2 3h-8.5"/>'],
  epic: ['<path d="M9.25 1.75 3.5 9h4l-.75 5.25L12.5 7h-4z"/>'],
  story: ['<path d="M4.25 2.25h7.5v11.5L8 10.75l-3.75 3z"/>'],
  spec: ['<rect x="3" y="2.75" width="10" height="11.5" rx="1.5"/><path d="M6 2.75v-1h4v1M6 7h4M6 9.5h4M6 12h2.25"/>'],
  adr: ['<path d="M8 1.5 14.5 8 8 14.5 1.5 8z"/><path d="m5.75 8.1 1.5 1.5 3-3.1"/>'],
  research: ['<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.75 3.75"/>'],
  concept: ['<path d="M5.6 10a4.25 4.25 0 1 1 4.8 0v1.75H5.6zM6.5 14.25h3"/>'],
  runbook: ['<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="m4.5 6.25 2 1.75-2 1.75M8.25 10h3"/>'],
  meeting: ['<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5"/><path d="M2.25 6.75h11.5M5.25 1.75v2.5M10.75 1.75v2.5"/>'],
  diagram: ['<rect x="1.75" y="2" width="5" height="4" rx="1"/><rect x="9.25" y="10" width="5" height="4" rx="1"/><path d="M4.25 6v3.5a2 2 0 0 0 2 2h3"/>'],
  document: ['<path d="M4 1.75h5l3.25 3.25v9.25H4zM9 1.75V5h3.25M6 8.5h4M6 11h4"/>'],
  // git objects
  pull: ['<circle cx="4" cy="3.75" r="1.75"/><circle cx="4" cy="12.25" r="1.75"/><circle cx="12" cy="12.25" r="1.75"/><path d="M4 5.5v5M12 10.5V6.25a2 2 0 0 0-2-2H8.25M9.75 2.5 8 4.25 9.75 6"/>'],
  merged: ['<circle cx="4" cy="3.75" r="1.75"/><circle cx="4" cy="12.25" r="1.75"/><circle cx="12" cy="8.5" r="1.75"/><path d="M4 5.5v5M4.2 5.5c.3 1.8 1.9 3 3.8 3h2.25"/>'],
  commit: ['<circle cx="8" cy="8" r="2.75"/><path d="M1.25 8h4M10.75 8h4"/>'],
  branch: ['<circle cx="4" cy="3.75" r="1.75"/><circle cx="4" cy="12.25" r="1.75"/><circle cx="12" cy="4.75" r="1.75"/><path d="M4 5.5v5M12 6.5c0 1.9-1.4 2.75-3.25 2.75H6.5A2.5 2.5 0 0 0 4 10.5"/>'],
  issue: ['<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.1" fill="black" stroke="none"/>'],
  tag: ['<path d="M2.25 2.25h5.5l6 6-5.5 5.5-6-6z"/><circle cx="5.4" cy="5.4" r="1" fill="black" stroke="none"/>'],
  file: ['<path d="M4 1.75h5l3.25 3.25v9.25H4zM9 1.75V5h3.25"/>'],
  // links
  external: ['<path d="M9.5 2.5h4v4M13.5 2.5 7.75 8.25M11.5 9.5v3.25a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75H6.5"/>'],
  mail: ['<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="m2.25 4.5 5.75 4.25 5.75-4.25"/>'],
  // hosts: their own marks, filled
  github: ['<path fill="black" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>', 16, true],
  gitlab: ['<path fill="black" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/>', 24, true],
};
{
  const uri = ([body, box = 16, filled]) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"${filled ? "" : ` ${STROKE}`}>${body}</svg>`)}")`;
  const css = Object.entries(ICONS)
    .map(([name, def]) => `.ico-${name}{--i:${uri(def)}}`)
    .join("\n");
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
}

// The picture of a kind. An artifact of a kind this page does not know is a plain document.
const KIND_ICON = { initiative: "initiative", epic: "epic", story: "story", spec: "spec", adr: "adr", research: "research", concept: "concept", runbook: "runbook", meeting: "meeting", diagram: "diagram" };
const kindIcon = (type) => KIND_ICON[String(type || "").toLowerCase()] || "document";

// An icon as an element. With a label it is an image a screen reader names; without one it is decoration.
function ico(name, label) {
  const el = document.createElement("i");
  el.className = `ico ico-${ICONS[name] ? name : "document"}`;
  if (label) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
    el.title = label;
  } else el.setAttribute("aria-hidden", "true");
  return el;
}
const kindIco = (type, label) => {
  const el = ico(kindIcon(type), label);
  el.classList.add(`k-${String(type || "document").toLowerCase()}`);
  return el;
};

// What a link leads to, read from its address alone: the host, and the object when the path
// says it. A GitLab under a name with no "gitlab" in it is not known to be one.
const HOST_NAME = { github: "GitHub", gitlab: "GitLab" };
const WHAT_NAME = { pull: "pull request", commit: "commit", issue: "issue", branch: "branch", file: "file", tag: "release" };
function linkParts(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:") return { host: null, what: "mail" };
  if (!/^https?:$/.test(u.protocol)) return null;
  const name = u.hostname.replace(/^www\./, "");
  const host = name === "github.com" || name.endsWith(".github.com") ? "github" : /(^|\.)gitlab\./.test(name) ? "gitlab" : null;
  const p = u.pathname;
  const is = (re) => re.test(p);
  let what = null;
  if (host === "github") what = is(/\/pull\/\d+/) ? "pull" : is(/\/commits?\/[0-9a-f]{7,40}/) ? "commit" : is(/\/issues\/\d+/) ? "issue" : is(/\/tree\//) ? "branch" : is(/\/blob\//) ? "file" : is(/\/releases\//) ? "tag" : null;
  if (host === "gitlab") what = is(/\/-\/merge_requests\/\d+/) ? "pull" : is(/\/-\/commit\/[0-9a-f]{7,40}/) ? "commit" : is(/\/-\/issues\/\d+/) ? "issue" : is(/\/-\/tree\//) ? "branch" : is(/\/-\/blob\//) ? "file" : is(/\/-\/(tags|releases)\//) ? "tag" : null;
  return { host, what };
}
// The names of the icons a link gets, host first: ["github", "pull"], ["gitlab"], ["external"].
function linkIcons(url) {
  const p = linkParts(url);
  if (!p) return [];
  if (p.what === "mail") return ["mail"];
  return p.host ? [p.host, p.what].filter(Boolean) : ["external"];
}
// The same in words, for a tip: "pull request on GitHub".
function linkWords(url) {
  const p = linkParts(url);
  if (!p || !p.host) return "";
  return `${p.what === "pull" && p.host === "gitlab" ? "merge request" : WHAT_NAME[p.what] || "page"} on ${HOST_NAME[p.host]}`;
}
const icons = (names) => names.map((n) => ico(n));

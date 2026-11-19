// projectstore — code-refs.mjs: whether one path is covered by one code_refs
// entry, as a pure test.
//
// One rule for two readers: spec-drift.mjs expands a ref to the files it
// covers, and doctor's flow group (doctor-flow.mjs) asks whether a commit's
// path touches a story's refs. Kept in a leaf of its own, importing nothing,
// so the two cannot drift and the flow modules never load spec-drift's
// file walk. Spec: "Doctor's flow findings…" (alias `flow-findings`),
// contract 2. A third rule, doctor's story ⊆ epic prefix (prefixCovers,
// below), lives here too, for doctor and the close's epic widening.
//
// A leading `./` is dropped. A ref with no glob character covers the path
// equal to it and every path under it as a folder; one that ends in `/`
// covers only the paths under it. A ref with `*`, `**` or `?` covers each
// path it matches and every path under a folder it matches, and one that
// ends in `/` only the paths under a folder it matches. Paths are compared as
// written: a non-ASCII path is never in git's quoted form here.

// `**/` is any number of directories, `**` anything, `*` and `?` stay inside
// one path segment. Everything else is literal.
export function globRe(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        s += "(?:.*/)?";
      } else s += ".*";
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`);
}

export const isGlobRef = (ref) => /[*?]/.test(String(ref));

// The ref as the rule reads it: a leading `./` dropped.
export const normalRef = (ref) => String(ref).replace(/^\.\//, "");

// Whether a glob ref covers `path`: the path matches it, or one of its
// folders does; a ref ending in `/` covers only paths under a matched folder.
// One compiled pattern per glob: a caller may test thousands of paths
// against a few refs.
const GLOB_CACHE = new Map();
const compiled = (glob) => {
  let re = GLOB_CACHE.get(glob);
  if (!re) GLOB_CACHE.set(glob, (re = globRe(glob)));
  return re;
};

export function globCovers(ref, path) {
  const r = normalRef(ref);
  const dirGlob = r.endsWith("/");
  const re = compiled(dirGlob ? r.slice(0, -1) : r);
  if (re.test(path)) return !dirGlob;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join("/"))) return true;
  return false;
}

// Whether `ref` covers the project-relative `path`.
export function refCovers(ref, path) {
  const r = normalRef(ref);
  const p = String(path).replace(/^\.\//, "");
  if (!r || !p) return false;
  if (isGlobRef(r)) return globCovers(r, p);
  const bare = r.replace(/\/+$/, "");
  if (!bare) return false;
  if (p.startsWith(`${bare}/`)) return true;
  return !r.endsWith("/") && p === bare;
}

// Doctor's story ⊆ epic rule, a plain string prefix: `ref` is inside
// `epicRef` when, trailing slashes dropped from both, it starts with it. It
// is not refCovers: no glob is read and no folder boundary is asked for.
// Doctor's code_refs check and the close's widening of an epic
// (status-change.mjs epic-refs) read the same rule, so a widened epic never
// leaves the warning it was widened for. Spec: the ADR "A story's close
// writes its code_refs on every path…", decision 6.
const bareRef = (r) => String(r).replace(/\/+$/, "");
export function prefixCovers(epicRef, ref) {
  return bareRef(ref).startsWith(bareRef(epicRef));
}

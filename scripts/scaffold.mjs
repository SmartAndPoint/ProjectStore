// projectstore — scaffold.mjs
//
// A vault's skeleton — the layout's folders, their README indexes and the
// vault's own README — as a plan and an apply: the one place it is written,
// for the CLI's `scaffold` verb, for `init` (binding.mjs) and, through the
// bin, for the session command and the Codex skill. So a vault made in a
// session, by `init` and by `setup` is the same bytes (the front-door ADR's
// decision 7). Before this module a session wrote the READMEs itself, picking
// each folder's name and description "based on the folder kind": two sessions
// wrote two vaults, and the SessionStart skeleton's Purpose column, which
// reads a folder's README prose, repeated whatever words the model chose.
// The names and descriptions are data now: templates/<lang>/strings.json →
// folders.<kind>, in the binding's language, with no English fallback.
//
// The shape is binding.mjs's. planScaffold() is pure over the filesystem: one
// row per folder, per folder README and for the vault README, each `create`
// or `exists`, and the reasons it refuses before anything is written.
// applyScaffold() writes the `create` rows and nothing else. A file that
// exists is never rewritten, whatever its content: the index rows inside a
// README are reconcile's, and a README edited by hand is the person's. "The
// layout's folders are missing" means the plan has a `create` row — a folder
// that is there without its README counts, because reconcile drops an index
// it cannot find without a word (the locale spec, contract 5).
//
// A leaf: lib.mjs and node built-ins only. binding.mjs imports this module,
// so the reverse import would be a cycle. Normative: the story "Scaffold is a
// core verb, and init creates a whole vault…" (PS-CORE).

import { existsSync, statSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { pluginRoot, loadLayout, loadTemplate, loadStrings, renderTemplate, writeFileAtomic, commandForm } from "./lib.mjs";

const README = "README.md";

const kindsOf = (layout) => [...new Set((layout.folders || []).map((f) => f.kind))];
const usable = (v) => typeof v === "string" && v.trim() !== "";
const pathKind = (p) => { try { return statSync(p).isDirectory() ? "dir" : "file"; } catch { return null; } };

// What a layout needs from a language before anything is written: the vault
// README's template, the folder README's when a folder asks for one, and a
// name and a description for every kind the layout's folders declare —
// `diagram` included, though no command creates one. planScaffold refuses on
// exactly this list and doctor's checkLayoutTemplates warns on it, so the two
// cannot disagree about what a language lacks.
export function missingScaffoldRequirements(layout, lang, root = pluginRoot()) {
  const missing = [];
  const templates = ["vault-readme", ...((layout.folders || []).some((f) => f.readme) ? ["folder-readme"] : [])];
  for (const name of templates) {
    if (!existsSync(join(root, "templates", String(lang), `${name}.md.tmpl`))) {
      missing.push({ what: "template", name, message: `language "${lang}" has no ${name} template (templates/${lang}/${name}.md.tmpl)` });
    }
  }
  const strings = loadStrings(lang, root);
  for (const kind of kindsOf(layout)) {
    const s = strings && strings.folders && strings.folders[kind];
    if (!s || !usable(s.name) || !usable(s.description)) {
      missing.push({ what: "string", name: kind, message: `language "${lang}" has no name and description for the folder kind "${kind}" (templates/${lang}/strings.json → folders.${kind})` });
    }
  }
  return missing;
}

// The vault README's folder table: a row per layout folder, its name linked
// to the folder's README (to the folder, when the layout asks for none) and
// its description — the same strings the folder READMEs carry, so the two
// never call one folder by two names.
function folderRows(layout, strings) {
  return layout.folders.map((f) => {
    const s = strings.folders[f.kind];
    return `| [${s.name}](${f.path}/${f.readme ? README : ""}) | ${s.description} |`;
  }).join("\n");
}

// What `scaffold` would write into `vault`. A vault that does not exist yet
// is planned as all `create` — what `init` plans before its mkdir. Refusal
// codes: LAYOUT, TEMPLATE, STRINGS, NOT_A_DIRECTORY, FOLDER_IS_FILE; every
// one is exit 1 upstream, and any one means nothing is written. A `create`
// row carries the bytes it would write; an `exists` row carries none.
export function planScaffold(vault, { layout, language, root = pluginRoot() } = {}) {
  const refusals = [];
  const rows = [];
  const plan = { vault, layout, language, rows, creates: 0, refusals, ok: false };
  let spec;
  try {
    spec = loadLayout(layout, root);
    if (!spec || !Array.isArray(spec.folders)) throw new Error("it declares no folders");
  } catch (e) {
    refusals.push({ code: "LAYOUT", message: `the layout "${layout}" does not load: ${e.message}` });
    return plan;
  }
  for (const m of missingScaffoldRequirements(spec, language, root)) refusals.push({ code: m.what === "template" ? "TEMPLATE" : "STRINGS", message: m.message });
  if (pathKind(vault) === "file") refusals.push({ code: "NOT_A_DIRECTORY", message: `${vault} is a file, not a vault directory` });
  if (refusals.length) return plan;
  const strings = loadStrings(language, root);
  const folderTemplate = spec.folders.some((f) => f.readme) ? loadTemplate(language, "folder-readme", root) : null;
  const row = (type, rel, render = null) => {
    const abs = join(vault, rel);
    const action = existsSync(abs) ? "exists" : "create";
    rows.push({ type, rel, abs, action, ...(render && action === "create" ? { content: render() } : {}) });
  };
  for (const f of spec.folders) {
    if (pathKind(join(vault, f.path)) === "file") refusals.push({ code: "FOLDER_IS_FILE", message: `${f.path} exists in ${vault} as a file — the layout's ${f.kind} folder cannot be created there` });
    row("folder", f.path);
    if (f.readme) {
      const s = strings.folders[f.kind];
      row("readme", `${f.path}/${README}`, () => renderTemplate(folderTemplate, { folder_name: s.name, folder_description: s.description }));
    }
  }
  // Last, and from the basename alone: nothing path-dependent beyond the
  // directory's name, so a vault made here and one made by `init` elsewhere
  // under the same name are byte-identical.
  row("vault-readme", README, () => renderTemplate(loadTemplate(language, "vault-readme", root), { vault_name: basename(vault), folder_rows: folderRows(spec, strings) }));
  plan.creates = rows.filter((r) => r.action === "create").length;
  plan.ok = refusals.length === 0;
  return plan;
}

// Writes the plan's `create` rows and nothing else: every folder first —
// writeFileAtomic never mkdirs — then each README, its absence checked again
// at the moment of writing, so a file that appeared after the plan (another
// session, a hand) is reported as there and never rewritten. The vault root is
// the caller's to make: `init` makes it, and a binding whose vault vanished is
// refused upstream, never recreated here behind the person's back.
export function applyScaffold(plan) {
  if (!plan.ok) throw Object.assign(new Error(plan.refusals.map((r) => r.message).join("; ")), { code: plan.refusals[0] ? plan.refusals[0].code : "REFUSED" });
  if (pathKind(plan.vault) !== "dir") throw Object.assign(new Error(`${plan.vault} does not exist — scaffold never creates the vault itself`), { code: "MISSING" });
  const made = new Set();
  for (const r of plan.rows) {
    if (r.type !== "folder" || r.action !== "create" || existsSync(r.abs)) continue;
    mkdirSync(r.abs, { recursive: true });
    made.add(r.rel);
  }
  for (const r of plan.rows) {
    if (r.type === "folder" || r.action !== "create" || existsSync(r.abs)) continue;
    writeFileAtomic(r.abs, r.content);
    made.add(r.rel);
  }
  return {
    created: plan.rows.filter((r) => made.has(r.rel)).map((r) => r.rel),
    exists: plan.rows.filter((r) => !made.has(r.rel)).map((r) => r.rel),
  };
}

// The result a front-end reports: the rows and what became of them, never a
// file body. `path` is vault-relative.
export function scaffoldResult(plan, done = null) {
  return {
    vault_path: plan.vault, layout: plan.layout, language: plan.language,
    rows: plan.rows.map((r) => ({ type: r.type, path: r.rel, action: r.action })),
    creates: plan.creates, wrote: Boolean(done),
    created: done ? done.created : [],
    exists: done ? done.exists : plan.rows.filter((r) => r.action === "exists").map((r) => r.rel),
    refusals: plan.refusals,
  };
}

const shown = (r) => (r.type === "folder" ? `${r.rel}/` : r.rel);

// The plan as text. A bare plan ends with the command that writes it, in both
// forms — the session's and the bin's, since a git-marketplace install has no
// bin on PATH — and with `--write`, because at a terminal that form shows this
// plan again and asks. `asking`: the question follows on the same stream, so
// the closing line is left out. After an apply, what was created and what was
// already there.
export function renderScaffoldPlan(plan, done = null, { env = process.env, asking = false } = {}) {
  if (!plan.ok) return [...plan.refusals.map((r) => r.message), "Nothing written."].join("\n") + "\n";
  const where = `${plan.vault} (layout ${plan.layout}, language ${plan.language})`;
  if (done) {
    const lines = [`Scaffolded ${where}`, ...plan.rows.filter((r) => done.created.includes(r.rel)).map((r) => `  created  ${shown(r)}`)];
    lines.push(done.exists.length
      ? `Created ${done.created.length}; ${done.exists.length} already there, left as ${done.exists.length === 1 ? "it was" : "they were"}.`
      : `Created ${done.created.length}.`);
    return lines.join("\n") + "\n";
  }
  const lines = [`Scaffold ${where}`, ...plan.rows.map((r) => `  ${r.action}  ${shown(r)}`), ""];
  const there = plan.rows.length - plan.creates;
  if (!plan.creates) lines.push("Nothing to create: every folder and README the layout declares is there.");
  else {
    lines.push(`${plan.creates} to create${there ? `; ${there} already there, never rewritten` : ""}.`);
    if (!asking) lines.push(`To write them: ${commandForm("scaffold", { env })} in a session, or \`projectstore scaffold --write\`.`);
  }
  return lines.join("\n") + "\n";
}

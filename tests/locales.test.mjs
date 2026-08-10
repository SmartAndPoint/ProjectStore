// projectstore — bundled-locale tests (PS-I18N, spec "Adding a bundled locale").
// Two layers, both run over EVERY bundled locale rather than only the newest, because
// scaffold/headings.json builds ONE alternation across all registered languages: an
// edit made for a new locale can change matching for a locale that was already green.
//   node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadTemplate,
  renderTemplate,
  heading,
  headingLineRe,
  indexHeaderRe,
  footerDateRe,
  evidenceSuffixRe,
  storiesAttributionRe,
  loadHeadingsRegistry,
  parseFrontmatter,
} from "../scripts/lib.mjs";
import { checkLayoutTemplates } from "../scripts/doctor.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO };

// The bundled set, DERIVED from the templates directory rather than hand-listed.
// A hardcoded list has the same failure shape as the bug this suite exists to catch:
// drop a locale from it and the sweep silently stops covering that locale while
// staying green. Deriving it means adding templates/<lang>/ is enough to be held to
// every contract.
const LOCALES = readdirSync(join(REPO, "templates"))
  .filter((d) => statSync(join(REPO, "templates", d)).isDirectory())
  .sort();

// Kinds the engineering layout declares a command for, plus folder-readme.
const KINDS = ["adr", "concept", "epic", "folder-readme", "kanban", "meeting",
  "research", "runbook", "spec", "story"];

const VARS = {
  id: "ADR-001", title: "T", date: "2026-01-01", author: "A", tags: "[]",
  slug: "s", epic_id: "EPIC-1", alternative_a_name: "Alt",
  generated_at: "2026-01-01T00:00:00Z", folder_name: "adr", folder_description: "d",
  backlog_items: "", todo_items: "", in_progress_items: "", review_items: "",
  done_items: "",
};

const STATUSLINE_KEYS = ["statusline_no_work", "statusline_state_error",
  "statusline_example_epic", "statusline_example_story"];

const registry = loadHeadingsRegistry();

// Which registry ids each EN template uses; every locale must match the same set.
const idsPerKind = Object.fromEntries(KINDS.map((kind) => {
  const en = loadTemplate("en", kind);
  return [kind, Object.keys(registry.headings).filter((id) => headingLineRe(id).test(en))];
}));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Contract 4 — no registered form may match two heading ids ─────────
// Whole-line matching keeps a prefix relationship safe (Acceptance vs Acceptance
// Criteria); equality in some language would silently merge two sections.
test("locales: no heading form matches more than one registry id (contract 4)", () => {
  const ids = Object.keys(registry.headings);
  for (const a of ids) {
    for (const form of Object.values(registry.headings[a]).flat()) {
      for (const b of ids) {
        if (a === b) continue;
        assert.ok(!headingLineRe(b).test(`## ${form}`),
          `"${form}" is registered for "${a}" but also matches "${b}"`);
      }
    }
  }
});

test("locales: the derived set is the one we think it is (contract 11)", () => {
  // Guards the derivation itself: a stray file or a renamed directory would quietly
  // shrink or pad the sweep.
  assert.ok(LOCALES.includes("en"), "en is missing from the bundled set");
  assert.ok(LOCALES.length >= 2, `only ${LOCALES.length} locale(s) found`);
  for (const lang of LOCALES) {
    assert.match(lang, /^[a-z]{2}$/, `"${lang}" is not a bare language code (ADR: no subtags)`);
  }
});

test("locales: every bundled language covers every registry entry (contract 3)", () => {
  for (const section of ["headings", "keywords", "index_columns", "footers"]) {
    for (const [id, entry] of Object.entries(registry[section])) {
      for (const lang of LOCALES) {
        const forms = entry[lang];
        assert.ok(Array.isArray(forms) && forms.length > 0 && forms.every((f) => f.trim()),
          `${section}.${id} has no ${lang} form`);
      }
    }
  }
});

for (const lang of LOCALES) {
  test(`locale ${lang}: templates complete, doctor clean (contract 1)`, () => {
    const findings = checkLayoutTemplates({ layout: "engineering", language: lang });
    assert.deepEqual(findings, [],
      findings.map((f) => f.message).join("; "));
  });

  test(`locale ${lang}: templates render, frontmatter survives (contracts 2, 9)`, () => {
    for (const kind of KINDS) {
      const out = renderTemplate(loadTemplate(lang, kind), VARS);
      assert.ok(!/\{\{/.test(out), `${kind}: unsubstituted {{...}} left`);
      if (kind === "folder-readme" || kind === "kanban") continue;
      const { data } = parseFrontmatter(out);
      assert.ok(data && data.type, `${kind}: frontmatter lost its type:`);
      // Enum values are machine-read and stay English in every locale.
      if (data.status) {
        assert.match(String(data.status), /^(proposed|draft|planned)$/,
          `${kind}: status "${data.status}" is not an English enum value`);
      }
    }
  });

  test(`locale ${lang}: template headings equal the canonical write form (contract 3)`, () => {
    for (const kind of KINDS) {
      const raw = loadTemplate(lang, kind);
      for (const id of idsPerKind[kind]) {
        assert.ok(headingLineRe(id).test(raw),
          `${kind}: heading "${id}" is not matched by the registry`);
        // story-section writes heading(id, lang); a template spelled differently
        // makes the plan/close gate append a SECOND section instead of filling it.
        const canon = heading(id, lang);
        assert.match(raw, new RegExp(`^##\\s+${escapeRe(canon)}\\s*$`, "m"),
          `${kind}: template heading differs from the canonical write form "${canon}"`);
      }
    }
  });

  test(`locale ${lang}: folder-readme index header is rebuildable (contract 5)`, () => {
    const lines = loadTemplate(lang, "folder-readme").split("\n");
    const i = lines.findIndex((l) => indexHeaderRe().test(l));
    assert.notEqual(i, -1, "index header row not recognized by indexHeaderRe()");
    // reconcile's rebuildIndexRows refuses an index whose separator is malformed.
    assert.match(lines[i + 1] || "", /^\|[-\s|]+\|$/,
      "malformed separator row under the index header");
  });

  test(`locale ${lang}: story evidence example satisfies the gate (contract 6)`, () => {
    // The SAME regex the gate uses, imported rather than mirrored — a copy here
    // could drift from doctor.mjs and the drift would be undetectable.
    assert.match(loadTemplate(lang, "story"), evidenceSuffixRe(),
      "the story template's evidence example would read as MISSING evidence");
  });

  test(`locale ${lang}: kanban placeholders and statusline strings (contracts 7, 8)`, () => {
    const kb = loadTemplate(lang, "kanban");
    for (const p of ["backlog_items", "todo_items", "in_progress_items",
      "review_items", "done_items"]) {
      assert.ok(kb.includes(`{{${p}}}`), `kanban: missing {{${p}}}`);
    }
    const p = join(REPO, "templates", lang, "strings.json");
    assert.ok(existsSync(p), "strings.json missing");
    const s = JSON.parse(readFileSync(p, "utf8"));
    for (const k of STATUSLINE_KEYS) assert.ok(s[k], `strings.json missing ${k}`);
  });
}

// ─── End to end ────────────────────────────────────────────────────────
// Templates that satisfy every static contract can still fail in composition: the
// gates write into them, reconcile rebuilds around them, doctor reads the result.

function runScript(proj, script, args) {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    encoding: "utf8", env: { ...ENV, CLAUDE_PROJECT_DIR: proj }, cwd: REPO, timeout: 30000,
  });
  assert.equal(r.status, 0, `${script} ${args.join(" ")}: ${r.stderr}`);
  // A checker that greps a text report for a JSON field passes vacuously — parse,
  // and fail loudly when the output is not JSON.
  try {
    return JSON.parse(r.stdout);
  } catch {
    assert.fail(`${script} ${args.join(" ")}: stdout is not JSON`);
  }
}

function makeLocaleVault(lang) {
  const proj = mkdtempSync(join(tmpdir(), `ps-${lang}-`));
  const vault = join(proj, "vault");
  for (const d of ["adr", "specs", "research", "concepts", "meetings", "ops",
    "diagrams", join("epics", "PS-X", "stories")]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "projectstore.json"), JSON.stringify({
    vault_path: vault, layout: "engineering", language: lang, default_author: "Test",
  }));
  writeFileSync(join(vault, ".projectstore.json"), JSON.stringify({
    spec_policy: "optional", lifecycle_gates: "on",
  }));
  const readme = loadTemplate(lang, "folder-readme");
  for (const f of ["adr", "specs", "epics", "research", "concepts", "meetings",
    "ops", "diagrams"]) {
    writeFileSync(join(vault, f, "README.md"),
      renderTemplate(readme, { folder_name: f, folder_description: "d" }));
  }
  return { proj, vault };
}

// Localized evidence suffixes, as a native writer would type them.
const EVIDENCE = {
  en: "— evidence: tests/x.test.mjs",
  ru: "— подтверждение: tests/x.test.mjs",
  es: "— evidencia: tests/x.test.mjs",
  de: "— Nachweis: tests/x.test.mjs",
  fr: "— preuve : tests/x.test.mjs",
  zh: "— 证据：tests/x.test.mjs",
};

for (const lang of LOCALES) {
  test(`locale ${lang}: draft → gates → reconcile → doctor, no localization finding`, () => {
    const { proj } = makeLocaleVault(lang);

    for (const args of [["adr", "Use Postgres"], ["epic", "PS-X", "Payments"]]) {
      const d = runScript(proj, "draft.mjs", args);
      writeFileSync(d.path, d.content);
    }
    const story = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);
    writeFileSync(story.path, story.content);

    // The lifecycle gates write the localized heading forms.
    for (const gate of ["plan", "close"]) {
      const r = runScript(proj, "story-section.mjs", [gate, story.path]);
      if (r.content) writeFileSync(story.path, r.content);
    }
    for (const id of ["implementation_plan", "final_summary"]) {
      assert.match(readFileSync(story.path, "utf8"),
        new RegExp(`^##\\s+${escapeRe(heading(id, lang))}\\s*$`, "m"),
        `the ${gateLabel(id)} gate did not write the ${lang} form`);
    }

    // Close the story for real: every acceptance criterion checked, with evidence.
    const lines = readFileSync(story.path, "utf8")
      .replace(/^status: .*$/m, "status: done")
      .split("\n");
    const acc = lines.findIndex((l) => headingLineRe("acceptance").test(l));
    assert.notEqual(acc, -1, "acceptance heading not found in the drafted story");
    for (let i = acc + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
      if (/^- \[ \]/.test(lines[i])) lines[i] = `- [x] ok ${EVIDENCE[lang]}`;
    }
    writeFileSync(story.path, lines.join("\n"));

    const rec = runScript(proj, "reconcile.mjs", ["--write"]);
    assert.equal(rec.summary.failed, 0, JSON.stringify(rec.summary));
    // An index reconcile cannot rebuild is dropped SILENTLY on this path
    // (rebuildIndex returns null, the write path `continue`s unless the target was
    // named), so absence of an error proves nothing. Assert presence instead: every
    // scaffolded folder must come back as a rebuilt index.
    const rebuilt = new Set((rec.indexes || []).map((i) => i.folder));
    for (const folder of ["adr", "specs", "epics", "research", "concepts",
      "meetings", "ops", "diagrams"]) {
      assert.ok(rebuilt.has(folder),
        `reconcile skipped ${folder}/README.md — its localized index header was not recognized`);
    }

    const findings = runScript(proj, "doctor.mjs", ["--json"]);
    assert.ok(Array.isArray(findings), "doctor --json did not return an array");
    const localization = findings.filter((f) =>
      /templates|index|heading|evidence|acceptance|plan-gate|summary/i
        .test(`${f.check} ${f.message}`));
    assert.deepEqual(localization, [],
      localization.map((f) => `[${f.check}] ${f.message}`).join("; "));
  });
}

function gateLabel(id) {
  return id === "implementation_plan" ? "plan" : "close";
}

// Remove a section (heading line through the next `## `) so the gate has to insert
// it. Templates ship both gate sections pre-rendered, so an e2e that only drafts a
// story never exercises insertSection at all — it re-verifies the template.
function dropSection(text, id) {
  const m = text.match(headingLineRe(id));
  assert.ok(m, `cannot drop absent section ${id}`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return text.slice(0, m.index) + (next === -1 ? "" : rest.slice(next));
}

function countHeadings(text, id) {
  const forms = Object.values(loadHeadingsRegistry().headings[id]).flat();
  return text.split("\n").filter((l) =>
    forms.some((f) => new RegExp(`^##\\s+${escapeRe(f)}\\s*$`, "i").test(l))).length;
}

for (const lang of LOCALES) {
  test(`locale ${lang}: the gates INSERT the localized heading when it is absent`, () => {
    const { proj } = makeLocaleVault(lang);
    const epic = runScript(proj, "draft.mjs", ["epic", "PS-X", "Payments"]);
    writeFileSync(epic.path, epic.content);
    const story = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);

    let text = story.content;
    for (const id of ["implementation_plan", "final_summary"]) text = dropSection(text, id);
    writeFileSync(story.path, text);
    for (const id of ["implementation_plan", "final_summary"]) {
      assert.equal(countHeadings(text, id), 0, `${id} survived the strip`);
    }

    for (const gate of ["plan", "close"]) {
      const r = runScript(proj, "story-section.mjs", [gate, story.path]);
      assert.ok(r.content, `${gate} gate produced no content`);
      writeFileSync(story.path, r.content);
    }

    const final = readFileSync(story.path, "utf8");
    for (const id of ["implementation_plan", "final_summary"]) {
      assert.equal(countHeadings(final, id), 1,
        `${gateLabel(id)} gate did not insert exactly one ${id} heading`);
      assert.match(final, new RegExp(`^##\\s+${escapeRe(heading(id, lang))}\\s*$`, "m"),
        `${gateLabel(id)} gate did not write the ${lang} form`);
    }
  });
}

for (const lang of LOCALES) {
  test(`locale ${lang}: the gates refresh the body footer, not just frontmatter`, () => {
    const { proj } = makeLocaleVault(lang);
    const epic = runScript(proj, "draft.mjs", ["epic", "PS-X", "Payments"]);
    writeFileSync(epic.path, epic.content);
    const story = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);

    // Backdate both carriers, then let the gate bring them forward together.
    writeFileSync(story.path, story.content
      .replace(/^updated: .*$/m, "updated: 2020-01-01")
      .replace(footerDateRe(), (_m, pre, post) => `${pre}2020-01-01${post}`));
    assert.match(readFileSync(story.path, "utf8"), /2020-01-01/, "backdating did not take");

    const r = runScript(proj, "story-section.mjs", ["plan", story.path]);
    assert.ok(!/2020-01-01/.test(r.content),
      `the ${lang} footer kept its stale date while frontmatter moved — the refresh is not registry-driven`);
    const footer = r.content.match(footerDateRe());
    assert.ok(footer, `the ${lang} footer stopped matching the registry form`);
  });
}

// The mechanism behind "no duplicate section": insertSection's guard is
// headingLineRe, which accepts EVERY registered form of EVERY language. A heading in
// another locale's form is therefore recognized and filled, not duplicated — only a
// heading matching no registered form gets a second section appended.
test("gates: a heading in another language's registered form is not duplicated", () => {
  const { proj } = makeLocaleVault("en");
  const epic = runScript(proj, "draft.mjs", ["epic", "PS-X", "Payments"]);
  writeFileSync(epic.path, epic.content);
  const story = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);
  writeFileSync(story.path, story.content.replace(
    /^## Implementation Plan$/m, `## ${heading("implementation_plan", "ru")}`));

  const r = runScript(proj, "story-section.mjs", ["plan", story.path]);
  assert.equal(countHeadings(r.content, "implementation_plan"), 1,
    "the ru-form heading was not recognized and a duplicate English section was appended");
});

test("gates: a heading matching NO registered form does get a second section", () => {
  const { proj } = makeLocaleVault("en");
  const epic = runScript(proj, "draft.mjs", ["epic", "PS-X", "Payments"]);
  writeFileSync(epic.path, epic.content);
  const story = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);
  writeFileSync(story.path, story.content.replace(
    /^## Implementation Plan$/m, "## Plan of Implementation"));

  const r = runScript(proj, "story-section.mjs", ["plan", story.path]);
  assert.equal(countHeadings(r.content, "implementation_plan"), 1,
    "expected the unregistered spelling to be ignored and the canonical section inserted");
  assert.match(r.content, /^## Plan of Implementation$/m,
    "the unregistered heading should survive untouched beside the inserted one");
});

// Epic PS-I18N's third expected result: a vault holding files authored under two
// different bound languages still lints and reconciles. Nothing else covers this —
// the per-locale e2e above is single-language by construction.
test("mixed-language vault: ru-headed files lint and reconcile in an en-bound vault", () => {
  const { proj, vault } = makeLocaleVault("en");
  const epic = runScript(proj, "draft.mjs", ["epic", "PS-X", "Payments"]);
  writeFileSync(epic.path, epic.content);

  // One story authored in en, one whose author worked in a ru-bound session.
  const enStory = runScript(proj, "draft.mjs", ["story", "PS-X", "Refunds"]);
  writeFileSync(enStory.path, enStory.content);
  const ruStory = runScript(proj, "draft.mjs", ["story", "PS-X", "Chargebacks"]);
  writeFileSync(ruStory.path, renderTemplate(loadTemplate("ru", "story"), {
    ...VARS, id: "story-chargebacks", epic_id: "PS-X", title: "Chargebacks",
  }));
  // And a folder README carrying ru column names.
  writeFileSync(join(vault, "adr", "README.md"),
    renderTemplate(loadTemplate("ru", "folder-readme"),
      { folder_name: "adr", folder_description: "d" }));
  const adr = runScript(proj, "draft.mjs", ["adr", "Use Postgres"]);
  writeFileSync(adr.path, adr.content);

  const rec = runScript(proj, "reconcile.mjs", ["--write"]);
  assert.equal(rec.summary.failed, 0, JSON.stringify(rec.summary));
  assert.ok((rec.indexes || []).some((i) => i.folder === "adr"),
    "the ru-headed adr index was skipped in an en-bound vault");
  assert.match(readFileSync(join(vault, "adr", "README.md"), "utf8"), /use-postgres/,
    "the ru-headed index was not populated with the new artifact");

  const findings = runScript(proj, "doctor.mjs", ["--json"]);
  const localization = findings.filter((f) =>
    /templates|index|heading|evidence|acceptance|plan-gate|summary/i
      .test(`${f.check} ${f.message}`));
  assert.deepEqual(localization, [],
    localization.map((f) => `[${f.check}] ${f.message}`).join("; "));
});

// Contract 6 applies to both inline grammars, not just the evidence suffix: a spec
// acceptance item attributed with a full-width colon must bind to the named story
// rather than silently widening to every covered story.
test("inline grammars accept the CJK-width colon in both directions (contract 6)", () => {
  assert.match("- [x] ok — 证据：tests/x.test.mjs", evidenceSuffixRe());
  assert.match("- [x] ok — evidence: tests/x.test.mjs", evidenceSuffixRe());

  const wide = "ok — stories：PS-X/story-foo".match(storiesAttributionRe());
  assert.ok(wide, "full-width attribution colon was not recognized");
  assert.equal(wide[1].trim(), "PS-X/story-foo");
  const ascii = "ok — stories: PS-X/story-foo".match(storiesAttributionRe());
  assert.ok(ascii, "ASCII attribution colon regressed");
  assert.equal(ascii[1].trim(), "PS-X/story-foo");
});

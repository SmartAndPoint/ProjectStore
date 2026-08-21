// projectstore — portability.test.mjs
//
// The three invariants that make "write a feature once, get it on every
// harness" a property of the repository rather than a habit of its authors.
//
//   1. STALENESS  — the committed adapter trees are byte-identical to what the
//                   generator produces right now. A new command that was never
//                   rendered fails here, naming the file it should have made.
//   2. LINT       — no harness-branded fragment survives into a generated file.
//                   Catches the reverse mistake: a feature that WAS rendered but
//                   still tells Codex to press a Claude Code button.
//   3. COVERAGE   — every source surface reaches every registered harness, or
//                   says in the file itself why it does not.
//
// Together they close both directions: a new feature must reach every harness,
// and a new harness must receive every feature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHarnesses, harnessIds, emittingHarnesses, sourceHarness, loadHarness,
} from "../scripts/harness.mjs";
import {
  renderAll, diffAgainstDisk, splitFrontmatter, harnessAllows, tomlMultiline,
  harnessBlockAttrs, blockTargets,
} from "../scripts/build-adapters.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles() {
  const out = [];
  for (const f of readdirSync(join(REPO, "commands")).filter((n) => n.endsWith(".md")).sort()) {
    out.push({ kind: "commands", name: f.replace(/\.md$/, ""), path: join("commands", f) });
  }
  for (const f of readdirSync(join(REPO, "agents")).filter((n) => n.endsWith(".md")).sort()) {
    out.push({ kind: "agents", name: f.replace(/\.md$/, ""), path: join("agents", f) });
  }
  const sk = join(REPO, "skills");
  for (const d of readdirSync(sk).sort()) {
    if (!existsSync(join(sk, d, "SKILL.md"))) continue;
    out.push({ kind: "skills", name: d, path: join("skills", d, "SKILL.md") });
  }
  return out;
}

function fileAllowedFor(keys, id) {
  const split = (v) => (typeof v === "string" && v ? v.split(",").map((s) => s.trim()) : null);
  return harnessAllows(split(keys["harness-only"]), split(keys["harness-except"]), id);
}

// ─── Manifests ─────────────────────────────────────────────────────────

test("every harness manifest parses and declares what the generator relies on", () => {
  const dir = join(REPO, "harnesses");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  assert.ok(names.length >= 2, "at least one source harness and one emitting harness");

  for (const n of names) {
    // Strict parse here rather than the tolerant one loadHarnesses does: a
    // malformed manifest must never break a live session, so it is swallowed
    // there and has to be caught somewhere a human is looking. This is it.
    const m = JSON.parse(readFileSync(join(dir, n), "utf8"));
    assert.equal(typeof m.id, "string", `${n}: id`);
    assert.equal(`${m.id}.json`, n, `${n}: filename must match id (detection is id-keyed)`);
    for (const k of ["project_dir_env", "plugin_root_env", "home_env", "home_default",
                     "project_config_dir", "config_basename"]) {
      assert.equal(typeof m.runtime?.[k], "string", `${n}: runtime.${k}`);
    }
    assert.ok(Array.isArray(m.tools?.write_tools), `${n}: tools.write_tools`);
    assert.ok(m.hooks?.events && typeof m.hooks.events === "object", `${n}: hooks.events`);
    assert.equal(typeof m.hooks?.root_placeholder, "string", `${n}: hooks.root_placeholder`);
    for (const s of ["commands", "agents", "skills", "hooks"]) {
      assert.ok(m.surfaces?.[s], `${n}: surfaces.${s}`);
    }
    if (m.emit) {
      assert.equal(typeof m.output_dir, "string", `${n}: an emitting harness needs output_dir`);
      assert.ok(Array.isArray(m.rewrites), `${n}: rewrites`);
      assert.ok(Array.isArray(m.lint?.forbidden_unmapped), `${n}: lint.forbidden_unmapped`);
    }
  }

  assert.ok(sourceHarness(), "exactly one manifest must be the source layout");
  assert.equal(
    [...loadHarnesses().values()].filter((m) => m.source_layout).length, 1,
    "two source layouts would make 'which tree is authored by hand' ambiguous",
  );
});

test("no two harnesses claim the same output directory", () => {
  const seen = new Map();
  for (const m of emittingHarnesses()) {
    assert.ok(!seen.has(m.output_dir), `${m.id} and ${seen.get(m.output_dir)} both write ${m.output_dir}`);
    seen.set(m.output_dir, m.id);
  }
});

test("rewrite rules are ordered so a specific rule fires before its catch-all", () => {
  // applyRewrites replaces in declared order, so a rule whose `from` is a prefix
  // of a later rule's `from` consumes the text the later rule was written for —
  // silently, and only in the emitted file. ".claude/" declared before
  // ".claude/projectstore.json" would be exactly that bug.
  for (const m of emittingHarnesses()) {
    const froms = m.rewrites.map((r) => r.from);
    for (let i = 0; i < froms.length; i++) {
      for (let j = i + 1; j < froms.length; j++) {
        assert.ok(
          !froms[j].includes(froms[i]),
          `${m.id}: rule "${froms[i]}" (#${i}) is a substring of "${froms[j]}" (#${j}) ` +
          `and is declared first, so #${j} can never fire — move the longer rule earlier`,
        );
      }
    }
  }
});

// ─── Invariant 1 — staleness ───────────────────────────────────────────

test("INVARIANT 1: committed adapter trees match what the generator produces", () => {
  const d = diffAgainstDisk(REPO);
  const lines = [
    ...d.missing.map((p) => `  never generated: ${p}`),
    ...d.changed.map((p) => `  out of date:     ${p}`),
    ...d.stale.map((p) => `  no longer built: ${p}`),
  ];
  assert.ok(
    d.ok,
    `the adapter trees are out of sync with the source surfaces:\n${lines.join("\n")}\n\n` +
    `  Run: node scripts/build-adapters.mjs\n\n` +
    `  This is the check that makes a new feature reach every harness. If you\n` +
    `  added or edited a command, agent or skill, regenerate and commit both.`,
  );
});

test("the generator is idempotent — rendering twice yields identical bytes", () => {
  const a = renderAll(REPO);
  const b = renderAll(REPO);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [k, v] of a) assert.equal(b.get(k), v, `${k} is not deterministic`);
});

test("every generated file that CAN carry a provenance banner does", () => {
  for (const [p, content] of renderAll(REPO)) {
    // JSON has no comment syntax, and inventing a "_generated" key would put an
    // unrecognised field into a config a harness parses strictly. Those files
    // are protected by invariant 1 instead: a hand-edit fails the staleness
    // check, which is the outcome the banner is only a polite warning about.
    if (p.endsWith(".json")) continue;
    assert.ok(
      content.includes("GENERATED by scripts/build-adapters.mjs"),
      `${p} has no provenance banner — someone will hand-edit it and lose the change`,
    );
  }
});

// ─── Invariant 2 — lint ────────────────────────────────────────────────

test("INVARIANT 2: no harness-branded fragment survives into a generated file", () => {
  const problems = [];
  for (const m of emittingHarnesses()) {
    const patterns = m.lint.forbidden_unmapped.map((p) => new RegExp(p, "g"));
    const preamble = m.surfaces?.commands?.preamble || "";
    for (const [p, content] of renderAll(REPO)) {
      if (!p.startsWith(m.output_dir)) continue;
      // The preamble is manifest-authored prose that names the missing tool on
      // purpose ("Codex has no AskUserQuestion tool"). Linting it would forbid
      // the one place the difference is allowed to be explained.
      const body = preamble ? content.split(preamble).join("") : content;
      for (const re of patterns) {
        re.lastIndex = 0;
        const hit = re.exec(body);
        if (hit) problems.push(`  ${p}\n    leaked: ${JSON.stringify(hit[0])}  (pattern /${re.source}/)`);
      }
    }
  }
  assert.equal(
    problems.length, 0,
    `harness-specific fragments reached a generated file untranslated:\n${problems.join("\n")}\n\n` +
    `  Fix one of:\n` +
    `    • add a rewrite rule to harnesses/<id>.json if the token has an equivalent;\n` +
    `    • wrap the passage in <!-- projectstore:harness only=… --> … <!-- /projectstore:harness -->\n` +
    `      if the concept does not exist on the other harness;\n` +
    `    • rephrase the source so it names no harness at all.\n`,
  );
});

test("harness gate markers are balanced in every source surface", () => {
  // An unbalanced marker does not error — the non-greedy block regex simply
  // pairs the wrong open with the wrong close and deletes a passage nobody
  // meant to gate. The damage shows up only in the generated file.
  const OPEN = /<!--\s*projectstore:harness\s+[^>]*?-->/g;
  const CLOSE = /<!--\s*\/projectstore:harness\s*-->/g;
  for (const f of sourceFiles()) {
    const src = readFileSync(join(REPO, f.path), "utf8");
    const o = (src.match(OPEN) || []).length;
    const c = (src.match(CLOSE) || []).length;
    assert.equal(o, c, `${f.path}: ${o} opening gate marker(s), ${c} closing`);
  }
});

test("every harness gate names a harness that actually exists", () => {
  const known = new Set(harnessIds());
  for (const f of sourceFiles()) {
    const src = readFileSync(join(REPO, f.path), "utf8");
    for (const m of src.matchAll(/<!--\s*projectstore:harness\s+(only|except)=([^\s>]+)\s*-->/g)) {
      for (const id of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
        assert.ok(known.has(id),
          `${f.path}: gate names unknown harness "${id}" — a typo here silently gates the passage ` +
          `out of every harness (only=) or into every harness (except=)`);
      }
    }
    const { keys } = splitFrontmatter(src);
    for (const k of ["harness-only", "harness-except"]) {
      if (!keys[k]) continue;
      for (const id of String(keys[k]).split(",").map((s) => s.trim())) {
        assert.ok(known.has(id), `${f.path}: frontmatter ${k} names unknown harness "${id}"`);
      }
    }
  }
});

// ─── Invariant 3 — coverage ────────────────────────────────────────────

test("INVARIANT 3: every source surface reaches every harness, or says why not", () => {
  const rendered = renderAll(REPO);
  const gaps = [];
  for (const f of sourceFiles()) {
    const { keys } = splitFrontmatter(readFileSync(join(REPO, f.path), "utf8"));
    for (const m of emittingHarnesses()) {
      const intentionallyAbsent = !fileAllowedFor(keys, m.id);
      const present = [...rendered.keys()].some(
        (p) => p.startsWith(m.output_dir) && p.includes(f.name),
      );
      if (!present && !intentionallyAbsent) {
        gaps.push(`  ${f.path} produces nothing for "${m.id}"`);
      }
      if (present && intentionallyAbsent) {
        gaps.push(`  ${f.path} is gated out of "${m.id}" but was rendered for it anyway`);
      }
    }
  }
  assert.equal(
    gaps.length, 0,
    `surfaces missing from a harness:\n${gaps.join("\n")}\n\n` +
    `  Every command, agent and skill must render for every registered harness.\n` +
    `  If one genuinely does not apply, say so in its frontmatter:\n` +
    `    harness-only: claude-code      (or  harness-except: codex)\n` +
    `  so the omission is a decision in the file rather than an oversight.\n`,
  );
});

test("a surface gated out of every harness is a deleted surface, not a portable one", () => {
  const ids = harnessIds();
  for (const f of sourceFiles()) {
    const { keys } = splitFrontmatter(readFileSync(join(REPO, f.path), "utf8"));
    const reaches = ids.filter((id) => fileAllowedFor(keys, id));
    assert.ok(reaches.length > 0,
      `${f.path} is gated out of every harness — delete it, or widen the gate`);
  }
});

test("each emitting harness receives the full surface count it should", () => {
  const rendered = renderAll(REPO);
  for (const m of emittingHarnesses()) {
    const mine = [...rendered.keys()].filter((p) => p.startsWith(m.output_dir));
    for (const kind of ["commands", "agents", "skills"]) {
      const expected = sourceFiles().filter((f) => {
        if (f.kind !== kind) return false;
        const { keys } = splitFrontmatter(readFileSync(join(REPO, f.path), "utf8"));
        return fileAllowedFor(keys, m.id);
      }).length;
      const dir = m.surfaces[kind].dir;
      const got = mine.filter((p) => p.startsWith(join(m.output_dir, dir) + "/")).length;
      assert.equal(got, expected, `${m.id}: expected ${expected} ${kind}, generated ${got}`);
    }
    assert.ok(mine.some((p) => p.endsWith(m.hooks.config_file)), `${m.id}: no hook config generated`);
    assert.ok(mine.some((p) => p.includes("/bin/ps-hook.mjs")), `${m.id}: no hook wrapper generated`);
  }
});

// ─── Format correctness of the emitted trees ───────────────────────────

test("generated agent files are well-formed for their harness's format", () => {
  for (const m of emittingHarnesses()) {
    if (m.surfaces.agents.format !== "agent-toml") continue;
    for (const [p, content] of renderAll(REPO)) {
      if (!p.startsWith(join(m.output_dir, m.surfaces.agents.dir))) continue;
      for (const k of ["name", "description", "developer_instructions"]) {
        assert.match(content, new RegExp(`^${k} = `, "m"), `${p}: missing required key ${k}`);
      }
      // Exactly one opening and one closing delimiter. A `"""` that leaked out
      // of the body unescaped would give three, and the file would parse as a
      // truncated agent with the rest of its instructions read as TOML.
      const delims = content.match(/"""/g) || [];
      assert.equal(delims.length, 2, `${p}: ${delims.length} """ delimiters, expected 2`);
      const body = content.split('"""')[1];
      assert.ok(!/(^|[^\\])\\(?![\\"ntru])/.test(body),
        `${p}: an unescaped backslash in developer_instructions would be read as a TOML escape`);
    }
  }
});

test("tomlMultiline escapes what TOML would otherwise interpret", () => {
  assert.equal(tomlMultiline("a\\b"), '"""\na\\\\b\n"""');
  assert.equal(tomlMultiline('x"""y'), '"""\nx\\"\\"\\"y\n"""');
  assert.equal(tomlMultiline('ends"'), '"""\nends\\"\n"""');
});

test("generated hook configs reference only events their harness supports", () => {
  for (const m of emittingHarnesses()) {
    const p = join(m.output_dir, m.surfaces.hooks.dir === "." ? "" : m.surfaces.hooks.dir, m.hooks.config_file);
    const content = renderAll(REPO).get(p);
    assert.ok(content, `${m.id}: no hook config at ${p}`);
    const cfg = JSON.parse(content);
    const allowed = new Set(Object.values(m.hooks.events));
    const unsupported = new Set(m.hooks.unsupported_events || []);
    for (const event of Object.keys(cfg.hooks)) {
      assert.ok(allowed.has(event), `${m.id}: hook config declares unmapped event "${event}"`);
      assert.ok(!unsupported.has(event), `${m.id}: hook config declares unsupported event "${event}"`);
    }
    // Every source event must survive unless the manifest says it cannot.
    const src = JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf8"));
    for (const event of Object.keys(src.hooks)) {
      if (unsupported.has(event)) continue;
      const mapped = m.hooks.events[event];
      assert.ok(mapped, `${m.id}: source event "${event}" has no mapping and is not listed unsupported`);
      assert.ok(cfg.hooks[mapped], `${m.id}: source event "${event}" vanished from the generated config`);
    }
  }
});

test("generated hook commands go through the wrapper, so harness identity is stamped", () => {
  // Detection reads environment variables the harness does not promise to set.
  // A hook launched directly would guess, and guessing wrong picks the wrong
  // write-tool vocabulary — which fails as an empty activity log, not an error.
  for (const m of emittingHarnesses()) {
    const p = join(m.output_dir, m.surfaces.hooks.dir === "." ? "" : m.surfaces.hooks.dir, m.hooks.config_file);
    const cfg = JSON.parse(renderAll(REPO).get(p));
    for (const [event, entries] of Object.entries(cfg.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          assert.ok(h.command.includes("/bin/ps-hook.mjs"),
            `${m.id}: ${event} hook bypasses the wrapper: ${h.command}`);
          assert.ok(h.command.includes(m.hooks.root_placeholder),
            `${m.id}: ${event} hook has no root placeholder for the installer to substitute`);
        }
      }
    }
  }
});

test("the write matcher is translated into each harness's own tool vocabulary", () => {
  const src = sourceHarness();
  for (const m of emittingHarnesses()) {
    const p = join(m.output_dir, m.surfaces.hooks.dir === "." ? "" : m.surfaces.hooks.dir, m.hooks.config_file);
    const cfg = JSON.parse(renderAll(REPO).get(p));
    const post = cfg.hooks[m.hooks.events.PostToolUse];
    assert.ok(post, `${m.id}: no PostToolUse entry`);
    const matcher = post[0].matcher;
    assert.equal(matcher, m.hooks.matchers.write,
      `${m.id}: PostToolUse matcher is "${matcher}", not this harness's write matcher`);
    assert.notEqual(matcher, src.hooks.matchers.write,
      `${m.id}: PostToolUse still matches ${src.id}'s tool names, which do not exist here`);
    for (const t of m.tools.write_tools) {
      assert.ok(new RegExp(matcher).test(t),
        `${m.id}: matcher "${matcher}" does not match declared write tool "${t}" — ` +
        `the hook would never fire, and nothing would report it`);
    }
  }
});

test("generated skills carry the frontmatter keys their harness requires", () => {
  for (const m of emittingHarnesses()) {
    if (!m.surfaces.skills.requires_name_frontmatter) continue;
    for (const [p, content] of renderAll(REPO)) {
      if (!p.startsWith(join(m.output_dir, m.surfaces.skills.dir))) continue;
      const { keys } = splitFrontmatter(content);
      assert.equal(typeof keys.name, "string", `${p}: no name: — this harness will not load the skill`);
      assert.ok(keys.description, `${p}: no description: — the harness cannot decide when to trigger it`);
    }
  }
});

// ─── Runtime resolution ────────────────────────────────────────────────

test("PROJECTSTORE_HARNESS pins detection, and each harness's own variables detect it", async () => {
  const { detectHarnessId, projectRoot, agentHome, configCandidates } = await import("../scripts/harness.mjs");
  for (const m of loadHarnesses().values()) {
    assert.equal(detectHarnessId({ PROJECTSTORE_HARNESS: m.id }), m.id, `${m.id}: explicit pin`);
    assert.equal(
      detectHarnessId({ [m.runtime.plugin_root_env]: "/x" }), m.id,
      `${m.id}: ${m.runtime.plugin_root_env} should identify it`,
    );
    assert.equal(projectRoot({ [m.runtime.project_dir_env]: "/p" }), "/p", `${m.id}: project dir`);
    assert.equal(agentHome({ [m.runtime.home_env]: "/h" }, "/home/u"), "/h", `${m.id}: home override`);
    assert.equal(
      agentHome({ PROJECTSTORE_HARNESS: m.id }, "/home/u"),
      join("/home/u", m.runtime.home_default),
      `${m.id}: home default`,
    );
  }
  assert.equal(detectHarnessId({}), sourceHarness().id, "no signal falls back to the source layout");
});

test("config lookup covers every harness's directory, active one first", async () => {
  const { configCandidates } = await import("../scripts/harness.mjs");
  for (const m of loadHarnesses().values()) {
    const cands = configCandidates("/proj", { PROJECTSTORE_HARNESS: m.id });
    const own = join("/proj", m.runtime.project_config_dir, m.runtime.config_basename);
    assert.ok(cands.includes(own), `${m.id}: own config path missing from candidates`);
    for (const other of loadHarnesses().values()) {
      const p = join("/proj", other.runtime.project_config_dir, other.runtime.config_basename);
      assert.ok(cands.includes(p),
        `${m.id}: cannot see a bind made under ${other.id} — the project would look unbound`);
    }
    // Active harness before the others, so a project bound under both resolves
    // to the one the user is actually running.
    const mine = cands.indexOf(own);
    for (const other of loadHarnesses().values()) {
      if (other.id === m.id) continue;
      const p = join("/proj", other.runtime.project_config_dir, other.runtime.config_basename);
      assert.ok(mine < cands.indexOf(p), `${m.id}: ${other.id}'s config outranks its own`);
    }
  }
});

test("write-tool detection admits every harness's tools without collisions", async () => {
  const { isWriteTool } = await import("../scripts/lib.mjs");
  const seen = new Map();
  for (const m of loadHarnesses().values()) {
    for (const t of m.tools.write_tools) {
      assert.ok(isWriteTool(t), `${t} (${m.id}) is not recognised as a write tool`);
      // Overlap would make the union unsafe: a tool that writes on one harness
      // and reads on another would be scored on both.
      if (seen.has(t)) assert.equal(seen.get(t), m.id, `write tool "${t}" claimed by two harnesses`);
      seen.set(t, m.id);
    }
  }
  for (const t of ["Read", "Grep", "Glob", "shell", "list_dir", "view_image"]) {
    assert.ok(!isWriteTool(t), `${t} must not count as a write`);
  }
});

test("apply_patch envelopes yield every path the patch touches", async () => {
  const { extractPaths, parsePatchEnvelopePaths } = await import("../scripts/harness.mjs");
  const envelope = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "*** Add File: docs/new.md",
    "*** Delete File: old.txt",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(parsePatchEnvelopePaths(envelope), ["src/app.ts", "docs/new.md", "old.txt"]);

  // One call, three files, and every one of them ABSOLUTE. Two separate
  // requirements, both learned the hard way:
  //   * returning only the first path would undercount the entry score and log
  //     one activity entry where three belonged;
  //   * returning them relative — as the envelope writes them — makes
  //     isSourcePath and isInsideVault reject all three, so Codex edits score
  //     nothing and log nothing, with no error raised anywhere.
  const got = extractPaths(
    { tool_name: "apply_patch", cwd: "/proj", tool_input: { command: envelope } },
    { PROJECTSTORE_HARNESS: "codex" },
  );
  assert.deepEqual(got, ["/proj/src/app.ts", "/proj/docs/new.md", "/proj/old.txt"]);
  for (const g of got) {
    assert.ok(isAbsolute(g), `${g} is relative; isSourcePath/isInsideVault would silently reject it`);
  }

  // An envelope that already names an absolute path is left alone rather than
  // being re-rooted under cwd.
  const abs = extractPaths(
    {
      tool_name: "apply_patch",
      cwd: "/proj",
      tool_input: { command: "*** Begin Patch\n*** Update File: /elsewhere/x.ts\n*** End Patch" },
    },
    { PROJECTSTORE_HARNESS: "codex" },
  );
  assert.deepEqual(abs, ["/elsewhere/x.ts"]);

  const cc = extractPaths(
    { tool_name: "Write", tool_input: { file_path: "/a/b.ts" } },
    { PROJECTSTORE_HARNESS: "claude-code" },
  );
  assert.deepEqual(cc, ["/a/b.ts"], "single-path harnesses still yield a one-element list");
  assert.deepEqual(parsePatchEnvelopePaths("nothing recognisable here"), [],
    "an unrecognised envelope yields nothing rather than throwing");
});

test("the hook payload's cwd is what resolves the project root when nothing exports one", async () => {
  // Codex exports no project-dir variable, and a hook process's own cwd is not
  // reliably the project. The payload's `cwd` is the only trustworthy source —
  // and it only exists after stdin has been read, which is why every hook adopts
  // it before calling readConfig. Resolving wrong here does not raise: it
  // reports the project as unbound and the hook does nothing at all.
  const { adoptHookInput, resetHookInput, projectRoot } = await import("../scripts/harness.mjs");
  try {
    resetHookInput();
    adoptHookInput({ session_id: "s", cwd: "/from/payload" });
    assert.equal(projectRoot({ PROJECTSTORE_HARNESS: "codex" }), "/from/payload");

    // An explicitly exported project directory is the harness stating the
    // answer, where cwd is us inferring it — so it still wins.
    assert.equal(
      projectRoot({ PROJECTSTORE_HARNESS: "codex", CODEX_PROJECT_DIR: "/explicit" }),
      "/explicit",
    );
  } finally {
    resetHookInput();
  }
});

test("every hook adopts the payload cwd before it reads config", () => {
  // Ordering is the whole fix, and it is invisible in behaviour until it is
  // wrong: config lookup resolves against the project root, so reading config
  // first searches the hook process's working directory and silently finds
  // nothing.
  const files = [
    "hooks/session-start.mjs",
    "hooks/session-rules.mjs",
    "hooks/session-stop.mjs",
    "hooks/pre-compact.mjs",
    "scripts/touch-session.mjs",
  ];
  for (const f of files) {
    const src = readFileSync(join(REPO, f), "utf8");
    const adopt = src.indexOf("adoptHookInput(readStdinJson())");
    const cfg = src.indexOf("readConfig()");
    assert.ok(adopt >= 0, `${f}: never adopts the hook payload cwd`);
    assert.ok(cfg >= 0, `${f}: expected a readConfig() call`);
    assert.ok(adopt < cfg, `${f}: reads config before adopting the payload cwd`);
  }
});

test("harness-only prose helpers render each harness's own spelling", async () => {
  const { commandRef, agentRef } = await import("../scripts/harness.mjs");
  for (const m of loadHarnesses().values()) {
    const env = { PROJECTSTORE_HARNESS: m.id };
    const cmd = commandRef("adr", env);
    assert.ok(cmd.includes("adr"), `${m.id}: command reference lost the name`);
    assert.equal(cmd, m.surfaces.commands.invocation.replace("<name>", "adr"));
    assert.equal(agentRef("critic", env), m.surfaces.agents.invocation.replace("<name>", "critic"));
  }
});

test("only harnesses that have a status line may have it wired", async () => {
  const { syncStatusLine } = await import("../scripts/lib.mjs");
  for (const m of loadHarnesses().values()) {
    if (m.capabilities?.statusline) continue;
    const prev = process.env.PROJECTSTORE_HARNESS;
    process.env.PROJECTSTORE_HARNESS = m.id;
    try {
      assert.equal(
        syncStatusLine({ statusline: { enabled: true } }, "/nonexistent-project"),
        "unsupported-harness",
        `${m.id} has no status line slot, so nothing may be written to its settings`,
      );
    } finally {
      if (prev === undefined) delete process.env.PROJECTSTORE_HARNESS;
      else process.env.PROJECTSTORE_HARNESS = prev;
    }
  }
});

test("user-facing command references are localized to the active harness", async () => {
  const { localizeCommands } = await import("../scripts/harness.mjs");
  for (const m of loadHarnesses().values()) {
    const env = { PROJECTSTORE_HARNESS: m.id };
    const tpl = m.surfaces.commands.invocation;
    assert.equal(localizeCommands("run /projectstore:reconcile now", env),
      `run ${tpl.replace("<name>", "reconcile")} now`, `${m.id}: plain command`);
    assert.equal(localizeCommands("any /projectstore:* command", env),
      `any ${tpl.replace("<name>", "*")} command`, `${m.id}: wildcard form`);
    // Hyphenated names must survive whole: /projectstore:story-plan is one
    // command, not "story" followed by stray text.
    assert.equal(localizeCommands("/projectstore:code-map", env),
      tpl.replace("<name>", "code-map"), `${m.id}: hyphenated name`);
    assert.equal(localizeCommands("no commands here", env), "no commands here",
      `${m.id}: unrelated prose is untouched`);
  }
});

test("content not meant for the source harness is hidden from it", () => {
  // The source layout is read directly by its harness — Claude Code loads
  // commands/, agents/ and skills/ as they are on disk, markers included. A
  // VISIBLE gate block that excludes the source harness therefore still
  // delivers its body to that harness as ordinary prose, which is how one
  // command ends up carrying two contradictory rules. Content for other
  // harnesses has to use the commented `harness-alt` form.
  const src = sourceHarness().id;
  const problems = [];
  for (const f of sourceFiles()) {
    const text = readFileSync(join(REPO, f.path), "utf8");
    for (const b of harnessBlockAttrs(text)) {
      if (b.form !== "visible") continue;
      const { only, except } = blockTargets(b.attrs);
      const reachesSource = harnessAllows(only, except, src);
      if (!reachesSource) {
        problems.push(
          `  ${f.path}: visible block "${b.attrs}" excludes the source harness (${src}),\n` +
          `    so ${src} still reads its body as prose. Use the commented form:\n` +
          `      <!-- projectstore:harness-alt ${b.attrs}\n      …body…\n      -->`,
        );
      }
    }
    // The inverse: an alt block that DOES apply to the source harness is
    // content that harness will never see, because it stays inside a comment.
    for (const b of harnessBlockAttrs(text)) {
      if (b.form !== "alt") continue;
      const { only, except } = blockTargets(b.attrs);
      if (harnessAllows(only, except, src)) {
        problems.push(
          `  ${f.path}: alt block "${b.attrs}" includes the source harness (${src}),\n` +
          `    but an alt block stays commented out in the source — ${src} would never read it.`,
        );
      }
      if (b.body.includes("-->")) {
        problems.push(`  ${f.path}: alt block body contains "-->", which closes the comment early.`);
      }
    }
  }
  assert.equal(problems.length, 0, `harness gate blocks are on the wrong side:\n${problems.join("\n")}`);
});

// ─── Installer ─────────────────────────────────────────────────────────

test("a Windows checkout path survives hook-config substitution", async () => {
  // Substituting the root into the JSON SOURCE text works on every path without
  // a backslash and throws on Windows, where `C:\workspace` becomes invalid
  // escape sequences inside a JSON string literal and JSON.parse fails before
  // anything is installed. Substituting into the parsed structure means the
  // path is never read as JSON syntax.
  const { substituteRootDeep } = await import("../scripts/install-codex.mjs");
  const m = loadHarness("codex");
  const win = "C:\\Users\\dev\\ProjectStore";
  const parsed = JSON.parse(
    readFileSync(join(REPO, m.output_dir, m.hooks.config_file), "utf8"),
  );
  const out = substituteRootDeep(parsed, m, win);

  // Round-trips: the serializer escapes the backslashes, and reading it back
  // yields the same path rather than a parse error.
  const text = JSON.stringify(out, null, 2);
  const back = JSON.parse(text);
  const cmd = back.hooks[m.hooks.events.SessionStart][0].hooks[0].command;
  assert.ok(cmd.includes(win), `substituted command lost the checkout path: ${cmd}`);
  assert.ok(!cmd.includes(m.hooks.root_placeholder), "placeholder survived substitution");

  // And nothing outside strings was disturbed.
  assert.deepEqual(Object.keys(back.hooks).sort(), Object.keys(parsed.hooks).sort());
});

test("substituteRootDeep only rewrites strings, at any depth", async () => {
  const { substituteRootDeep } = await import("../scripts/install-codex.mjs");
  const m = loadHarness("codex");
  const tok = m.hooks.root_placeholder;
  const input = { a: `${tok}/x`, b: [1, true, null, `${tok}/y`], c: { d: 7, e: `${tok}` } };
  const out = substituteRootDeep(input, m, "/R");
  assert.deepEqual(out, { a: "/R/x", b: [1, true, null, "/R/y"], c: { d: 7, e: "/R" } });
});

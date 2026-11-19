// projectstore — the verbs that write an initiative's decision and fields, and
// an epic's initiative (spec "The initiative kind and its verbs", alias
// `initiative`, contracts 9 to 12; PS-BACKLOG: "An initiative's decision and
// fields are written by verbs: accepted, rejected or deferred with a reason,
// and its title, owner and priority"). The verbs run in process through the
// bin's run(), on vaults rendered from the real templates; a drift is made
// through runInitiative's afterCompute seam, as for move. Each test names the
// contract it covers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run, VERBS } from "../scripts/cli.mjs";
import { runInitiative, runEpic, appendOutcomeLine } from "../scripts/initiative-verbs.mjs";
import { outcomeLines } from "../scripts/initiative.mjs";
import { runVaultChecks } from "../scripts/doctor.mjs";
import { loadTemplate, renderTemplate, parseFrontmatter, today, fromTerminalIn } from "../scripts/lib.mjs";
import { packageCommand, sourceHarness } from "../scripts/harness.mjs";
import { makeVaultProject, writeBinding } from "./fixtures/vault.mjs";
import { closure, hookEntries, verbModuleSpecifiers } from "./fixtures/imports.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, "utf8");
const fm = (p) => parseFrontmatter(read(p)).data;
const DAY = today();

// A vault with one initiative and one epic, both rendered from the bound
// language's templates. `named`: the epic names the initiative.
function vault({ lang = "en", status = "proposed", named = true, stem = "faster-onboarding", id = null } = {}) {
  const { proj, vault } = makeVaultProject();
  if (lang !== "en")
    writeBinding(proj, { vault_path: vault, layout: "engineering", language: lang, default_author: "Test" });
  mkdirSync(join(vault, "initiatives"), { recursive: true });
  let init = renderTemplate(loadTemplate(lang, "initiative"), {
    id: id || stem,
    title: "Faster onboarding",
    date: "2026-11-14",
    author: "Ada",
    tags: [],
  });
  init = init.replace("status: proposed", `status: ${status}`);
  const initPath = join(vault, "initiatives", `${stem}.md`);
  writeFileSync(initPath, init);
  let epic = renderTemplate(loadTemplate(lang, "epic"), {
    id: "PS-X",
    title: "Onboarding",
    date: "2026-11-14",
    tags: [],
  });
  if (named) epic = epic.replace("updated: 2026-11-14\n", `updated: 2026-11-14\ninitiative: "${id || stem}"\n`);
  const epicPath = join(vault, "epics", "PS-X", "epic.md");
  writeFileSync(epicPath, epic);
  writeFileSync(join(vault, "kanban.md"), "stub board\n");
  writeFileSync(join(vault, "graph.md"), "stub graph\n");
  return { proj, vault, initPath, epicPath, cfg: { vault_path: vault, layout: "engineering", language: lang } };
}

// Every file of the project, path → bytes: what "nothing written" compares.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = read(p);
    }
  };
  walk(dir);
  return out;
}

const sink = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
async function cli(proj, args, { ask = null, json = false } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run([...args, ...(json ? ["--json"] : []), "--project", proj], {
    env: { ...process.env, CI: "1" },
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
    ask,
  });
  return { code, out: stdout.text, err: stderr.text, json: json ? JSON.parse(stdout.text) : null };
}
const direct = (f, run, positionals, values, extra = {}) =>
  run({ values, positionals, cfg: f.cfg, project: f.proj, env: { ...process.env, CI: "1" }, confirm: null, ...extra });

const lastOutcome = (p) => outcomeLines(parseFrontmatter(read(p)).body).at(-1);

// ─── Contract 9: the decision verb ──────────────────────────────────────

// [initiative#9]
test("a bare decision says Nothing written and changes no byte; with --write it sets status, the Status row and ends Outcome with today's line", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  const bare = await cli(f.proj, ["initiative", "faster-onboarding", "accepted", "--reason", "grouped existing work"]);
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /^Nothing written\./m);
  const cmd = packageCommand([], "initiative", {
    args: "faster-onboarding accepted --reason 'grouped existing work' --write",
  });
  assert.ok(
    bare.out.split("\n").some((l) => l.trim() === cmd),
    bare.out,
  );
  assert.deepEqual(snapshot(f.proj), before);
  const w = await cli(f.proj, [
    "initiative",
    "faster-onboarding",
    "accepted",
    "--reason",
    "grouped existing work",
    "--write",
  ]);
  assert.equal(w.code, 0, w.err);
  assert.equal(fm(f.initPath).status, "accepted");
  assert.match(read(f.initPath), /^\| \*\*Status\*\* \| accepted \|$/m);
  assert.deepEqual(lastOutcome(f.initPath), { date: DAY, status: "accepted", reason: "grouped existing work" });
  assert.equal(fm(f.initPath).updated, DAY);
  assert.ok(read(f.initPath).trimEnd().endsWith(`*Last updated: ${DAY}*`));
  // The line is the section's last, before Related.
  const body = read(f.initPath);
  assert.ok(body.indexOf(`- ${DAY} accepted: grouped existing work`) < body.indexOf("## Related"));
});

// [initiative#9]
test("the same decision again with a new reason appends a second line and exits 0 (edge)", async () => {
  const f = vault();
  const args = (reason) => ["initiative", "faster-onboarding", "accepted", "--reason", reason, "--write"];
  assert.equal((await cli(f.proj, args("first"))).code, 0);
  const again = await cli(f.proj, args("second"));
  assert.equal(again.code, 0, again.err);
  const lines = outcomeLines(parseFrontmatter(read(f.initPath)).body);
  assert.deepEqual(
    lines.map((l) => [l.status, l.reason]),
    [
      ["accepted", "first"],
      ["accepted", "second"],
    ],
  );
});

// [initiative#9]
test("no --reason, a blank one, or one with a line break exits 2, names --reason, and writes nothing (failure)", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  for (const extra of [[], ["--reason", "  "], ["--reason", "one\ntwo"]]) {
    const r = await cli(f.proj, ["initiative", "faster-onboarding", "accepted", ...extra, "--write"]);
    assert.equal(r.code, 2, `${JSON.stringify(extra)}: ${r.err}`);
    assert.match(r.err, /--reason/);
  }
  assert.deepEqual(snapshot(f.proj), before);
});

// [initiative#9]
test("a decision word outside the three, proposed included, is a usage error, exit 2 (failure)", async () => {
  const f = vault();
  for (const word of ["proposed", "approved"]) {
    const r = await cli(f.proj, ["initiative", "faster-onboarding", word, "--reason", "x", "--write"]);
    assert.equal(r.code, 2, r.err);
  }
});

// [initiative#9]
test("accepted for an initiative no epic names exits 1 and writes nothing; rejected with the same reason writes (failure)", async () => {
  const f = vault({ named: false });
  const before = snapshot(f.proj);
  const r = await cli(f.proj, ["initiative", "faster-onboarding", "accepted", "--reason", "x", "--write"]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /name it from an epic first/i);
  assert.deepEqual(snapshot(f.proj), before);
  const rej = await cli(f.proj, ["initiative", "faster-onboarding", "rejected", "--reason", "x", "--write"]);
  assert.equal(rej.code, 0, rej.err);
  assert.equal(fm(f.initPath).status, "rejected");
});

// [initiative#9]
test("an id that names no initiative, and an initiative with no Outcome section, each exit 1 naming what is missing (failure)", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  const none = await cli(f.proj, ["initiative", "no-such", "rejected", "--reason", "x", "--write"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no-such/);
  writeFileSync(f.initPath, read(f.initPath).replace(/## Outcome\n\n<!--.*-->\n\n/, ""));
  const cut = snapshot(f.proj);
  const noSection = await cli(f.proj, ["initiative", "faster-onboarding", "rejected", "--reason", "x", "--write"]);
  assert.equal(noSection.code, 1);
  assert.match(noSection.err, /no Outcome section/);
  assert.deepEqual(snapshot(f.proj), cut);
  assert.notDeepEqual(cut, before);
});

// [initiative#9]
test("a decision leaves the vault with no initiative-decision or initiative-links warning or issue", async () => {
  const f = vault();
  const w = await cli(f.proj, [
    "initiative",
    "faster-onboarding",
    "accepted",
    "--reason",
    "grouped existing work",
    "--write",
  ]);
  assert.equal(w.code, 0, w.err);
  const found = runVaultChecks(f.cfg, { proj: f.proj }).filter(
    (x) => x.check.startsWith("initiative-") && x.level !== "info",
  );
  assert.deepEqual(found, []);
});

// [initiative#9]
test("an Outcome that ends in a multi-line list item gets the new line straight after it, and doctor reads both", () => {
  const text =
    "---\nstatus: accepted\n---\n\n# T\n\n## Outcome\n\n- 2026-11-14 accepted: the maintainer asked\n  for the package.\n\n## Related\n\n-\n";
  const out = appendOutcomeLine(text, "- 2026-11-18 deferred: after the release");
  assert.match(out, /for the package\.\n- 2026-11-18 deferred: after the release\n\n## Related/);
  assert.equal(outcomeLines(out).length, 2);
});

// [initiative#9]
test("an Outcome that is the last section before the footer, or empty, gets the line inside it, with a blank line each side", () => {
  const last =
    "---\nstatus: proposed\n---\n\n# T\n\n## Outcome\n\n<!-- comment -->\n\n---\n\n*Last updated: 2026-11-14*\n";
  const out = appendOutcomeLine(last, "- 2026-11-18 rejected: no");
  assert.match(out, /<!-- comment -->\n\n- 2026-11-18 rejected: no\n\n---\n/);
  const empty = "---\nstatus: proposed\n---\n\n# T\n\n## Outcome\n\n## Related\n\n-\n";
  assert.match(
    appendOutcomeLine(empty, "- 2026-11-18 rejected: no"),
    /## Outcome\n\n- 2026-11-18 rejected: no\n\n## Related\n/,
  );
  assert.equal(appendOutcomeLine("# T\n\n## Outcome\n", "- x"), "# T\n\n## Outcome\n\n- x\n");
});

// [initiative#9]
test("a file the writers cannot read, CRLF line ends, exits 1 and writes nothing (failure)", async () => {
  const f = vault();
  writeFileSync(f.initPath, read(f.initPath).replace(/\n/g, "\r\n"));
  writeFileSync(f.epicPath, read(f.epicPath).replace(/\n/g, "\r\n"));
  const before = snapshot(f.proj);
  const d = await cli(f.proj, ["initiative", "faster-onboarding", "rejected", "--reason", "x", "--write"]);
  assert.equal(d.code, 1, d.err);
  const e = await cli(f.proj, ["epic", "PS-X", "--initiative", "", "--write"]);
  assert.equal(e.code, 1, e.err);
  assert.deepEqual(snapshot(f.proj), before);
});

// ─── Contract 10: the fields verb ───────────────────────────────────────

// [initiative#10]
test("--title and --priority set title:, the H1, priority: and the Priority row; the file name stays", async () => {
  const f = vault();
  const r = await cli(f.proj, [
    "initiative",
    "faster-onboarding",
    "--title",
    "New title",
    "--priority",
    "P1",
    "--write",
  ]);
  assert.equal(r.code, 0, r.err);
  const t = read(f.initPath);
  assert.equal(fm(f.initPath).title, "New title");
  assert.match(t, /^# New title$/m);
  assert.equal(fm(f.initPath).priority, "p1");
  assert.match(t, /^\| \*\*Priority\*\* \| p1 \|$/m);
  assert.deepEqual(readdirSync(join(f.vault, "initiatives")), ["faster-onboarding.md"]);
});

// [initiative#10]
test("--owner sets owner: and the Owner row", async () => {
  const f = vault();
  const r = await cli(f.proj, ["initiative", "faster-onboarding", "--owner", "Grace Hopper", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fm(f.initPath).owner, "Grace Hopper");
  assert.match(read(f.initPath), /^\| \*\*Owner\*\* \| Grace Hopper \|$/m);
});

// [initiative#10]
test("a priority not p and digits, an owner with @ or blank, and a blank or two-line title exit 2, naming the option and not the value (failure)", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  const cases = [
    [["--priority", "high"], "--priority", "high"],
    [["--priority", "p"], "--priority", null],
    [["--owner", "a@b"], "--owner", "a@b"],
    [["--owner", ""], "--owner", null],
    [["--title", ""], "--title", null],
    [["--title", "one\ntwo"], "--title", "one\ntwo"],
  ];
  for (const [args, option, value] of cases) {
    const r = await cli(f.proj, ["initiative", "faster-onboarding", ...args, "--write"]);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.err}`);
    assert.ok(r.err.includes(option), `${JSON.stringify(args)} names ${option}: ${r.err}`);
    if (value) assert.ok(!r.err.includes(value), `${JSON.stringify(args)}: the value is not named`);
  }
  assert.deepEqual(snapshot(f.proj), before);
});

// [initiative#10]
test("no option and no decision, a decision with a field option, and --reason with the fields form each exit 2 (failure)", async () => {
  const f = vault();
  for (const args of [
    ["faster-onboarding"],
    ["faster-onboarding", "rejected", "--owner", "Ada", "--reason", "x"],
    ["faster-onboarding", "--owner", "Ada", "--reason", "x"],
  ]) {
    const r = await cli(f.proj, ["initiative", ...args]);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.err}`);
  }
});

// [initiative#10]
test("the same values as the file's write nothing and exit 0 (edge)", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  const r = await cli(
    f.proj,
    [
      "initiative",
      "faster-onboarding",
      "--title",
      "Faster onboarding",
      "--owner",
      "Ada",
      "--priority",
      "p2",
      "--write",
    ],
    { json: true },
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.result.changes, []);
  assert.deepEqual(snapshot(f.proj), before);
});

// ─── Contract 11: the epic's initiative verb ────────────────────────────

// [initiative#11]
test('epic --initiative sets initiative: and an Initiative row after Priority that links to the file; "" removes both, back to the bytes but for updated and the footer', async () => {
  const f = vault({ named: false });
  const original = read(f.epicPath);
  const r = await cli(f.proj, ["epic", "PS-X", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(r.code, 0, r.err);
  const t = read(f.epicPath);
  assert.equal(fm(f.epicPath).initiative, "faster-onboarding");
  assert.match(
    t,
    /^\| \*\*Priority\*\* \| p2 \|\n\| \*\*Initiative\*\* \| \[\[\.\.\/\.\.\/initiatives\/faster-onboarding\\\|Faster onboarding\]\] \|$/m,
  );
  const clear = await cli(f.proj, ["epic", "PS-X", "--initiative", "  ", "--write"]);
  assert.equal(clear.code, 0, clear.err);
  const norm = (s) => s.replace(/^updated: .*$/m, "updated: X").replace(/\*Last updated: .*\*/, "*Last updated: X*");
  assert.equal(norm(read(f.epicPath)), norm(original));
});

// [initiative#11]
test("the Initiative row links to the file's stem when it differs from the id, and a stale link text is rewritten (edge)", async () => {
  const f = vault({ named: false, stem: "onboarding-file", id: "faster-onboarding" });
  assert.equal((await cli(f.proj, ["epic", "PS-X", "--initiative", "faster-onboarding", "--write"])).code, 0);
  assert.match(read(f.epicPath), /\[\[\.\.\/\.\.\/initiatives\/onboarding-file\\\|Faster onboarding\]\]/);
  writeFileSync(f.initPath, read(f.initPath).replace('title: "Faster onboarding"', 'title: "Quicker onboarding"'));
  const again = await cli(f.proj, ["epic", "PS-X", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(again.code, 0, again.err);
  assert.match(read(f.epicPath), /\\\|Quicker onboarding\]\]/);
  const before = snapshot(f.proj);
  const noop = await cli(f.proj, ["epic", "PS-X", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(noop.code, 0, noop.err);
  assert.deepEqual(snapshot(f.proj), before);
});

// [initiative#11]
test("--initiative no-such and an epic id that names no epic exit 1 naming the value; epic with no --initiative exits 2; nothing is written (failure)", async () => {
  const f = vault({ named: false });
  const before = snapshot(f.proj);
  const none = await cli(f.proj, ["epic", "PS-X", "--initiative", "no-such", "--write"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no-such/);
  const noEpic = await cli(f.proj, ["epic", "PS-NONE", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(noEpic.code, 1);
  assert.match(noEpic.err, /PS-NONE/);
  const bare = await cli(f.proj, ["epic", "PS-X", "--write"]);
  assert.equal(bare.code, 2, bare.err);
  for (const bad of ["../PS-X", "."]) {
    const r = await cli(f.proj, ["epic", bad, "--initiative", "faster-onboarding", "--write"]);
    assert.equal(r.code, 1, `${bad}: ${r.err}`);
  }
  assert.deepEqual(snapshot(f.proj), before);
});

// ─── Contract 12: what the three verbs share ────────────────────────────

// [initiative#12]
test("a project with no binding exits 3", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ps-initverb-unbound-"));
  mkdirSync(join(bare, ".claude"));
  assert.equal((await cli(bare, ["initiative", "x", "accepted", "--reason", "y"])).code, 3);
  assert.equal((await cli(bare, ["epic", "PS-X", "--initiative", "y"])).code, 3);
});

// [initiative#12]
test("at a terminal a --write answered No exits 1 with declined true and writes nothing (edge)", async () => {
  const f = vault();
  const before = snapshot(f.proj);
  const asked = [];
  const no = await cli(f.proj, ["initiative", "faster-onboarding", "deferred", "--reason", "later", "--write"], {
    ask: async (q) => (asked.push(q), "n"),
  });
  assert.equal(no.code, 1, no.err);
  assert.equal(asked.length, 1);
  assert.match(no.err, /^Nothing written\.$/m);
  assert.deepEqual(snapshot(f.proj), before);
  const r = await direct(
    f,
    runInitiative,
    ["faster-onboarding", "deferred"],
    { reason: "later", write: true },
    {
      confirm: async () => false,
    },
  );
  assert.equal(r.code, 1);
  assert.equal(r.result.declined, true);
  const e = await direct(f, runEpic, ["PS-X"], { initiative: "", write: true }, { confirm: async () => false });
  assert.equal(e.result.declined, true);
  assert.deepEqual(snapshot(f.proj), before);
});

// [initiative#12]
test("in a vault bound in Russian, --priority p1 rewrites the **Приоритет** row, and epic adds the **Инициатива** row (edge)", async () => {
  const f = vault({ lang: "ru", named: false });
  const r = await cli(f.proj, ["initiative", "faster-onboarding", "--priority", "p1", "--write"]);
  assert.equal(r.code, 0, r.err);
  assert.match(read(f.initPath), /^\| \*\*Приоритет\*\* \| p1 \|$/m);
  const e = await cli(f.proj, ["epic", "PS-X", "--initiative", "faster-onboarding", "--write"]);
  assert.equal(e.code, 0, e.err);
  assert.match(read(f.epicPath), /^\| \*\*Инициатива\*\* \| \[\[/m);
});

// [initiative#12]
test("another writer's edit made once between the read and the write is kept and the change applied over it; one made before every attempt exits 1 leaving that writer's text (failure)", async () => {
  const f = vault();
  const values = { reason: "later", write: true };
  const once = await direct(f, runInitiative, ["faster-onboarding", "deferred"], values, {
    afterCompute: (i) => {
      if (i === 0)
        writeFileSync(f.initPath, read(f.initPath).replace("## Problem\n", "## Problem\n\nedited meanwhile\n"));
    },
  });
  assert.equal(once.code, 0, once.text);
  assert.ok(read(f.initPath).includes("edited meanwhile"));
  assert.equal(fm(f.initPath).status, "deferred");
  let last = null;
  const always = await direct(
    f,
    runInitiative,
    ["faster-onboarding", "rejected"],
    { reason: "no", write: true },
    {
      afterCompute: (i) => {
        last = read(f.initPath) + `\nedit ${i}\n`;
        writeFileSync(f.initPath, last);
      },
    },
  );
  assert.equal(always.code, 1, always.text);
  assert.match(always.result.error, /^story-changed-meanwhile|changed before each/);
  assert.equal(read(f.initPath), last);
});

// [initiative#12]
test("a refresh of the derived views that fails after the write keeps the file written, exits 1 and says to run reconcile (failure)", async () => {
  const f = vault();
  rmSync(join(f.vault, "kanban.md"));
  mkdirSync(join(f.vault, "kanban.md"));
  writeFileSync(join(f.vault, "kanban.md", "blocker"), "x\n");
  const r = await cli(f.proj, ["initiative", "faster-onboarding", "deferred", "--reason", "later", "--write"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(fm(f.initPath).status, "deferred");
  const lines = r.err.split("\n");
  const k = lines.indexOf(packageCommand([], "reconcile", { args: "--write" }));
  assert.ok(k > 0, r.err);
  assert.ok(lines[k - 1].endsWith(`${fromTerminalIn(f.proj)}:`), lines[k - 1]);
  assert.doesNotMatch(r.err, /same initiative again/);
});

// [initiative#12]
test("under --json the result is {write, path, changes, reconcile, declined, error}, changes a list of {field, from, to}", async () => {
  const f = vault();
  const r = await cli(f.proj, ["initiative", "faster-onboarding", "--priority", "p1", "--write"], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(r.json.result).sort(), ["changes", "declined", "error", "path", "reconcile", "write"]);
  assert.deepEqual(r.json.result.changes, [{ field: "priority", from: "p2", to: "p1" }]);
  assert.equal(r.json.result.path, f.initPath);
  assert.ok(r.json.result.reconcile, "the views were refreshed");
  const e = await cli(f.proj, ["epic", "PS-X", "--initiative", ""], { json: true });
  assert.deepEqual(e.json.result.changes, [{ field: "initiative", from: "faster-onboarding", to: null }]);
  assert.equal(e.json.result.write, false);
});

// [initiative#12]
test("headings.json has priority, owner and initiative fields with a form for every bundled language", () => {
  const fields = JSON.parse(read(join(REPO, "scaffold", "headings.json"))).fields;
  for (const id of ["priority", "owner", "initiative"])
    for (const lang of ["en", "ru", "es", "de", "fr", "zh"]) assert.ok(fields[id]?.[lang]?.[0], `${id}.${lang}`);
});

// [initiative#9]
test("no hook entry and no MCP module reaches initiative-verbs.mjs, initiative.mjs imports only lib.mjs, and both rows write with no MCP tool", async () => {
  const { READ_HANDLERS } = await import("../scripts/read-verbs.mjs");
  for (const verb of ["initiative", "epic"]) {
    assert.ok(!Object.hasOwn(READ_HANDLERS, verb), `the read runner does not serve ${verb}`);
    const row = VERBS.find((v) => v.verb === verb);
    assert.equal(row.writes, true, verb);
    assert.equal(row.requiresBinding, true, verb);
    assert.deepEqual([...row.mcp], [], verb);
    assert.equal(row.module, "./initiative-verbs.mjs", verb);
  }
  const rows = (list) => list.map((v) => v.module).filter(Boolean);
  const dispatch = (rel, s) => {
    if (rel === "scripts/verbs.mjs") return [];
    if (rel === "scripts/read-verbs.mjs") return rows(VERBS.filter((v) => Object.hasOwn(READ_HANDLERS, v.verb)));
    if (rel === "scripts/cli.mjs") return rows(VERBS);
    return verbModuleSpecifiers(s);
  };
  const server = JSON.parse(read(join(REPO, ".mcp.json"))).mcpServers.projectstore;
  const mcp = server.args[0].replace(/^\$\{[A-Z_]+\}\//, "");
  const entries = [...hookEntries(REPO, { placeholder: sourceHarness().hooks.root_placeholder }), mcp];
  assert.ok(entries.includes("hooks/session-start.mjs") && entries.includes("scripts/mcp-server.mjs"));
  for (const entry of entries)
    assert.ok(
      !closure(entry, { root: REPO, dispatch }).includes("scripts/initiative-verbs.mjs"),
      `${entry} reaches initiative-verbs.mjs`,
    );
  assert.ok(closure("scripts/cli.mjs", { root: REPO, dispatch }).includes("scripts/initiative-verbs.mjs"));
  assert.match(read(join(REPO, "scripts", "cli.mjs")), /await import\("\.\/initiative-verbs\.mjs"\)/);
  const imports = [...read(join(REPO, "scripts", "initiative.mjs")).matchAll(/^import .* from "([^"]+)";$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(imports, ["./lib.mjs"]);
  const src = read(join(REPO, "scripts", "initiative-verbs.mjs")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /child_process|spawn|fetch\(|node:https?/, "the verbs start nothing of their own");
});

// [initiative#9]
test("the help's ADVANCED line lists initiative and epic", async () => {
  const out = sink();
  await run(["--help"], { env: { ...process.env, CI: "1" }, stdout: out, stderr: sink(), stdin: { isTTY: false } });
  const block = out.text.match(/^ADVANCED\n((?: {2}.*\n)+)/m);
  assert.ok(block, out.text);
  assert.match(block[1].replace(/\n\s+/g, " "), /\bmove · initiative · epic\b/);
});

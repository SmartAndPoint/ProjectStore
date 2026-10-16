// projectstore — cli.mjs
//
// The token-free front-end: `projectstore <verb>` as a thin argv/output
// shell over the same core operations the hooks and the command files call
// (distribution ADR decisions 3 and 5). No logic lives here: the verb table,
// the envelope and the per-verb parse are verbs.mjs's, the read verbs'
// handlers are read-verbs.mjs's, and this module holds the handlers of the
// verbs that write (and of mcp), and run(), which dispatches every verb of
// the one table through both halves. It re-exports what it exported before
// the split — the table is a CONTRACT that packaging/shells.mjs and the
// tests read from here — and the MCP server imports none of it: it runs the
// read runner (the story "The MCP server's entry reaches no install verb
// through a read-verb runner that shares the CLI's verb table…",
// PS-DIRECTORY).
//
// The gate (distribution ADR decision 6) binds every write verb this bin
// exposes: the install family through install-harness.mjs's own preview and
// confirmation, and `reconcile --write` through the same rule — naming what
// is written (`--only <target>`) is the non-interactive confirmation, a bare
// `--write` asks on a terminal and refuses without one. `scaffold --write`
// differs on purpose: its write set is closed — create-only, what the layout
// declares, in the vault the binding names — so it asks at a terminal and,
// without one, `--write` is the confirmation. There is no --yes.
//
// The install verbs, setup, configure, reconcile and the MCP server are
// imported lazily, on the run that needs them: hooks never import this module
// (the suite asserts it), and a verb that runs none of them loads none.
// Pure node, no external deps.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as term from "./term.mjs";
import { harnessIds, packageCommand } from "./harness.mjs";
import {
  readConfigAt,
  readOverlayAt,
  resolveAgentModel,
  resolveAgentEffort,
  overlayId,
  layoutRoster,
  commandForm,
  projectDirRefusal,
  fromTerminalIn,
  refreshSessionPointer,
} from "./lib.mjs";
// binding.mjs and scaffold.mjs beneath it are write modules imported
// statically where the install family is lazy: dependency-free, with no side
// effects at import.
import {
  planBind,
  applyBind,
  renderBindPlan,
  bindResult,
  bindFailed,
  normaliseVaultPath,
  shellQuote,
  DEFAULT_LAYOUT,
  DEFAULT_LANGUAGE,
} from "./binding.mjs";
import { planScaffold, applyScaffold, scaffoldResult, renderScaffoldPlan } from "./scaffold.mjs";
import { planAgentsChange, applyAgentsChange } from "./agents-change.mjs";
import {
  planBand,
  applyBand,
  bandStatus,
  renderBandStatus,
  renderBandPlan,
  SUBCOMMANDS as BAND_SUBCOMMANDS,
} from "./band.mjs";
import { dispatch, envelope, usageFail, ownEnv, nearest, notBoundText, PACKAGE_ROOT } from "./verbs.mjs";
import { READ_HANDLERS } from "./read-verbs.mjs";

// What this module exported before the table moved, from where it lives now.
export {
  SCHEMA_VERSION,
  PACKAGE_ROOT,
  packageVersion,
  envelope,
  resolveProject,
  opt,
  VERBS,
  PLANNED_VERBS,
  SUMMARY_MAX,
  usage,
  verbHelp,
  nearest,
  notBoundText,
} from "./verbs.mjs";
export { doctorText } from "./read-verbs.mjs";

// The one interactive question every write verb asks when nothing named the
// write. Streams and `ask` are parameters so it is testable without a tty.
async function confirmWrite(question, { stdin, stdout, ask }) {
  if (ask) return /^y(es)?$/i.test(String(await ask(question)).trim());
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) return null; // no terminal: refuse
  // End of input is a no (term.mjs askLine), never a question left pending.
  const answer = await term.askLine(question, stdin, stdout);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

// ─── The write verbs' handlers ─────────────────────────────────────────

// The MCP server, imported lazily like the install family: no other verb
// carries the protocol code. It serves the project the flag names, else the
// one the environment supplies, never this process's cwd — mcp.mjs's
// serveSupplied, the one path scripts/mcp-server.mjs (what .mcp.json runs)
// takes too.
async function runMcp({ values, env, cwd, stdin, stdout, stderr }) {
  const { serveSupplied } = await import("./mcp.mjs");
  return serveSupplied({ project: values.project ?? null, env, cwd, stdin, stdout, stderr });
}

// git's user.name for a fresh config's default_author, from the project's
// own repository — never from the process cwd; the login name otherwise.
function gitAuthor(project, env) {
  if (existsSync(project)) {
    try {
      const r = spawnSync("git", ["config", "--get", "user.name"], { cwd: project, encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {}
  }
  return env.USER || env.USERNAME || "";
}

// bind / init: the vault named on the command line is the confirmation (the
// distribution ADR's decision 6 read for a binding — there is no --yes and
// nothing to ask, at a terminal either: init's command line names what it
// writes); a change of vault needs --rebind. Exit 1 on a refusal with the
// reason, or when init's git or scaffold step failed after the binding was
// written; 2 on usage; 0 when already bound to the same vault.
function runBind(init) {
  return async (ctx) => {
    const { row, values, positionals, project, env, stdout, stderr } = ctx;
    const vault = positionals[0];
    if (!vault)
      return usageFail(Object.assign(new Error(`${row.verb} takes the vault path`), { code: "USAGE" }), {
        verb: row.verb,
        ...ctx,
      });
    // The author is the caller's to find: the plan reads nothing ambient.
    const plan = planBind(project, {
      vault,
      layout: values.layout ?? null,
      language: values.language ?? null,
      rebind: Boolean(values.rebind),
      init,
      author: gitAuthor(project, env),
      env,
      root: PACKAGE_ROOT,
    });
    const usage = plan.refusals.find((r) => r.code === "USAGE");
    if (usage) return usageFail(Object.assign(new Error(usage.message), { code: "USAGE" }), { verb: row.verb, ...ctx });
    let done = null;
    if (plan.ok && (plan.writes || plan.buildsVault)) done = applyBind(plan, { env });
    const ok = plan.ok && !bindFailed(done);
    const result = bindResult(plan, done);
    if (values.json) stdout.write(JSON.stringify(envelope(row.verb, project, ok, result), null, 2) + "\n");
    else {
      const stream = plan.ok ? stdout : stderr;
      stream.write(renderBindPlan(plan, done, { env, caps: term.caps(stream, env) }));
    }
    return ok ? 0 : 1;
  };
}

// scaffold: the bound vault's skeleton, from the binding's layout and
// language (`bind --rebind` changes them; the verb takes no layout). Bare, the
// plan, and nothing is written. --write creates the `create` rows: at an
// interactive terminal (install spec contract 9's definition) after the plan
// and `Apply N changes? [Y/n]`; without one, --write is the confirmation —
// the write set is closed, so `scaffold --write --json` writes at a terminal
// too, which is how the session command and the Codex skill confirm. A plan
// with nothing to create asks nothing and exits 0. A vault directory that
// is gone is refused: recreating it here would hide that it vanished, and
// `init` is the verb that makes a vault.
async function runScaffold(ctx) {
  const { row, values, cfg, project, env, stdin, stdout, stderr, ask } = ctx;
  const emit = (ok, result, text, code) => {
    if (values.json) stdout.write(JSON.stringify(envelope(row.verb, project, ok, result), null, 2) + "\n");
    else (ok ? stdout : stderr).write(text);
    return code;
  };
  // readConfigAt hands back the stored path raw: `~`, relative, a trailing slash.
  const norm = normaliseVaultPath(cfg.vault_path, project);
  const vault = typeof norm === "string" ? norm : null;
  // Each refusal ends with its command alone on its line, in the core's form,
  // the directory in the lead (the story "User-facing text says where to
  // run…", rules 1, 4 and 6). In a session, bind asks before a rebind.
  if (!vault) {
    const why = [
      `the binding names no usable vault path${norm && norm.error ? ` (${norm.error})` : ""}. Rebind it in a session, or ${fromTerminalIn(project)}:`,
      commandForm("bind", { args: "<vault>", env }),
      packageCommand([], "bind", { args: "<vault> --rebind" }),
    ].join("\n");
    return emit(false, { error: why }, why + "\n", 1);
  }
  if (!existsSync(vault)) {
    const why = [
      `${vault} does not exist: the binding names a vault directory that is not there. init creates it under this binding — the directory, its git repository and the layout's folders — ${fromTerminalIn(project)}:`,
      packageCommand([], "init", { args: shellQuote(vault) }),
    ].join("\n");
    return emit(false, { error: why, vault_path: vault }, why + "\n", 1);
  }
  const plan = planScaffold(vault, {
    layout: cfg.layout || DEFAULT_LAYOUT,
    language: cfg.language || DEFAULT_LANGUAGE,
    root: PACKAGE_ROOT,
  });
  if (!plan.ok) return emit(false, scaffoldResult(plan), renderScaffoldPlan(plan, null, { env }), 1);
  if (!values.write || plan.creates === 0)
    return emit(true, scaffoldResult(plan), renderScaffoldPlan(plan, null, { env, project }), 0);
  // An injected `ask` is a terminal, as for install. Otherwise the installer's
  // definition of one (TTYs, CI, a host session's markers) is the one
  // contract 9 names — imported lazily, as runInstallVerb imports it.
  const interactive =
    !values.json &&
    (ask ? true : (await import("./install-harness.mjs")).isInteractive({ stdin, stdout, env, json: false }));
  if (interactive) {
    stdout.write(renderScaffoldPlan(plan, null, { env, asking: true }));
    if (!(await term.askApply(plan.creates, { stdin, stdout, ask, caps: term.caps(stdout, env) }))) {
      stdout.write("Nothing written.\n");
      return 1;
    }
  }
  const done = applyScaffold(plan);
  return emit(true, scaffoldResult(plan, done), renderScaffoldPlan(plan, done, { env }), 0);
}

// agents model <name> — the model and effort a plugin surface passes for that
// agent, from the active harness's overlay (ADR-008's two terms, once per
// field; the effort ADR, decision 2); agents show — the overlay
// as read, with the keys the allowlist rejected; agents configure — the one
// writer, behind the same gate as install: naming --harness is the
// confirmation, a bare non-TTY call refuses (layout spec, contracts 2–4).
async function runAgents(ctx) {
  const { row, values, positionals, project, env, stdout, stderr, stdin, ask } = ctx;
  const sub = positionals[0];
  const usage = (m) => usageFail(Object.assign(new Error(m), { code: "USAGE" }), { verb: row.verb, ...ctx });
  if (!["model", "show", "configure"].includes(sub)) return usage("agents takes model <name>, show, or configure");
  // The flag IS the confirmation, so it names exactly one overlay: two are a
  // question, not an answer.
  if (values.harness && values.harness.length > 1)
    return usage("--harness names exactly one overlay (it is the confirmation); given twice");
  const named = values.harness && values.harness[0];
  if (named && !harnessIds().includes(named))
    return usage(`unknown harness: ${named} — known: ${harnessIds().join(", ")}`);
  const harness = named || overlayId(env);
  const forConfigure = ["default", "agent", "reset"].filter((o) => values[o] !== undefined);
  if (sub !== "configure" && forConfigure.length) return usage(`--${forConfigure[0]} is an option of agents configure`);
  // A refusal goes to stderr, as bind's does; --json keeps its envelope on stdout.
  const emit = (verb, ok, result, text) => {
    if (values.json) stdout.write(JSON.stringify(envelope(verb, project, ok, result), null, 2) + "\n");
    else (ok ? stdout : stderr).write(text);
    return ok ? 0 : 1;
  };
  const cfg = readConfigAt(project);
  const roster = layoutRoster(cfg);
  if (sub === "model") {
    const name = positionals[1];
    if (!name) return usage("agents model takes the agent's bare name (critic, planner, …)");
    const r = resolveAgentModel(project, name, { harness });
    const e = resolveAgentEffort(project, name, { harness });
    // The effort clause only when one resolves, so the line reads as it did
    // for an overlay of models alone.
    const effortText = e.effort ? `; effort ${e.effort} (${e.source})` : "";
    return emit(
      "agents model",
      true,
      { ...r, effort: e.effort, effort_source: e.source },
      `${name}: ${r.model ? `${r.model} (${r.source}, ${r.overlay})` : "no model configured — the agent's frontmatter decides"}${effortText}\n`,
    );
  }
  const before = readOverlayAt(project, harness);
  const inBinding = Boolean(cfg && cfg.agents && typeof cfg.agents === "object");
  if (sub === "show") {
    // Resolved per roster agent (per configured name when no layout loads), so
    // a reader reports what would run without restating the two-term rule.
    const configured = [
      ...new Set([...Object.keys(before.agents.per_agent), ...Object.keys(before.efforts.per_agent)]),
    ];
    const names = [...new Set([...(roster || []), ...configured])].sort();
    const resolved = Object.fromEntries(
      names.map((n) => {
        const r = resolveAgentModel(project, n, { harness });
        const e = resolveAgentEffort(project, n, { harness });
        return [n, { model: r.model, source: r.source, effort: e.effort, effort_source: e.source }];
      }),
    );
    const unknown = roster ? configured.filter((n) => !roster.includes(n)) : [];
    const lines = [
      `overlay: ${before.path || "(none: no harness detected and none named)"}${before.path && !before.present ? " (absent)" : ""}`,
    ];
    if (before.unparseable) lines.push("  not valid JSON");
    if (before.agents.default) lines.push(`  default: ${before.agents.default}`);
    if (before.efforts.default) lines.push(`  default effort: ${before.efforts.default}`);
    const effortOf = (n) => (resolved[n].effort ? `, effort ${resolved[n].effort} (${resolved[n].effort_source})` : "");
    for (const n of names)
      lines.push(
        `  ${n}: ${resolved[n].model ? `${resolved[n].model} (${resolved[n].source})` : "— (the agent's frontmatter)"}${effortOf(n)}${unknown.includes(n) ? " — not in the roster: nothing runs under this name" : ""}`,
      );
    if (before.rejected.length) lines.push(`  ignored (not an overlay key): ${before.rejected.join(", ")}`);
    if (inBinding) lines.push("  the binding still carries an agents block — a pre-0.28 leftover; run upgrade");
    return emit(
      "agents show",
      true,
      {
        harness,
        path: before.path,
        present: before.present,
        unparseable: before.unparseable,
        agents: before.agents,
        efforts: before.efforts,
        resolved,
        roster,
        unknown,
        rejected: before.rejected,
        agents_in_binding: inBinding,
      },
      lines.join("\n") + "\n",
    );
  }
  // configure — in a project that exists (the install spec, contract 19;
  // the layout spec, contract 4): refused before the preview and the gate.
  const missingProject = projectDirRefusal(project);
  if (missingProject) return emit("agents configure", false, { error: missingProject }, `${missingProject}\n`);
  if (!harness) return usage("no harness detected and none named: agents configure names --harness <id>");
  if (before.unparseable)
    return emit(
      "agents configure",
      false,
      { error: `${before.path} is not valid JSON; fix or remove it first`, harness, path: before.path },
      `${before.path} is not valid JSON; fix or remove it first\n`,
    );
  if (!values.reset && values.default === undefined && !(values.agent || []).length)
    return usage("agents configure takes --default <model>, --agent <name>=<model> (repeatable) or --reset");
  const change = planAgentsChange({
    before,
    harness,
    layout: cfg && cfg.layout,
    roster,
    defaultModel: values.default,
    agents: values.agent || [],
    reset: Boolean(values.reset),
  });
  if (change.usage) return usage(change.usage);
  const { next, pinnedClerk, clerkPinUnavailable, dropped, same, preview } = change;
  if (same)
    return emit(
      "agents configure",
      true,
      { harness, path: before.path, wrote: false, agents: next, pinnedClerk, clerkPinUnavailable, dropped },
      preview.join("\n") + "\n  Nothing to change.\n",
    );
  // The gate: a named harness confirms; otherwise ask, and refuse without a terminal.
  let confirmed = Boolean(named);
  if (!confirmed) {
    const a = await confirmWrite(preview.join("\n") + `\nWrite ${before.path}? [y/N] `, { stdin, stdout, ask });
    if (a === null)
      return usage("a non-interactive agents configure names --harness <id> to confirm; there is no --yes");
    confirmed = a;
  }
  if (!confirmed)
    return emit(
      "agents configure",
      false,
      { harness, path: before.path, wrote: false, declined: true, agents: next, dropped },
      preview.join("\n") + "\n  nothing written.\n",
    );
  const { path, after } = applyAgentsChange(project, harness, next, change.nextEfforts);
  // Efforts join the envelope only where the overlay holds one, so a run over
  // models alone answers exactly as it did before efforts existed.
  const withEfforts =
    after.efforts.default ||
    Object.keys(after.efforts.per_agent).length ||
    before.efforts.default ||
    Object.keys(before.efforts.per_agent).length
      ? { efforts: after.efforts, pinnedClerkEffort: change.pinnedClerkEffort }
      : {};
  return emit(
    "agents configure",
    true,
    {
      harness,
      path,
      wrote: true,
      agents: after.agents,
      ...withEfforts,
      pinnedClerk,
      clerkPinUnavailable,
      dropped,
      rejected: after.rejected,
      agents_in_binding: inBinding,
    },
    preview.join("\n") +
      `\n  wrote ${path}.${inBinding ? " The binding still carries an agents block (pre-0.28); run upgrade to move it." : ""}\n`,
  );
}

// The band's switch (the band spec, contract 13): one atomic binding write per
// change, previewed; a terminal is asked, --json is the confirmation (the
// command that runs it has asked already), and without either it refuses.
// `status` writes nothing.
async function runBand(ctx) {
  const { row, values, positionals, cfg, project, env, stdout, stderr, stdin, ask } = ctx;
  const sub = positionals[0];
  const arg = positionals[1];
  const usage = (m) => usageFail(Object.assign(new Error(m), { code: "USAGE" }), { verb: row.verb, ...ctx });
  if (!BAND_SUBCOMMANDS.includes(sub))
    return usage(`band takes ${BAND_SUBCOMMANDS.join(", ")} (epic takes an epic id, or none to release the pin)`);
  const emit = (verb, ok, result, text) => {
    if (values.json) stdout.write(JSON.stringify(envelope(verb, project, ok, result), null, 2) + "\n");
    else (ok ? stdout : stderr).write(text);
    return ok ? 0 : 1;
  };
  if (sub === "status") {
    const s = bandStatus(project, cfg, { env, root: PACKAGE_ROOT });
    return emit("band status", true, s, renderBandStatus(s));
  }
  const plan = planBand(project, sub, arg, { env, root: PACKAGE_ROOT });
  if (plan.refusal)
    return emit(
      `band ${sub}`,
      false,
      { error: plan.refusal.message, code: plan.refusal.code, path: plan.path },
      `${plan.refusal.message}\n`,
    );
  const preview = renderBandPlan(plan, sub, arg);
  if (!plan.changed)
    return emit(
      `band ${sub}`,
      true,
      { path: plan.path, wrote: false, band: plan.after },
      preview + "  Nothing to change.\n",
    );
  let confirmed = Boolean(values.json);
  if (!confirmed) {
    const a = await confirmWrite(preview + `Write ${plan.path}? [y/N] `, { stdin, stdout, ask });
    if (a === null) return usage("a non-interactive band write passes --json; there is no --yes");
    confirmed = a;
  }
  if (!confirmed)
    return emit(
      `band ${sub}`,
      false,
      { path: plan.path, wrote: false, declined: true, band: plan.after },
      preview + "  nothing written.\n",
    );
  const done = applyBand(plan);
  return emit(
    `band ${sub}`,
    true,
    { path: plan.path, wrote: done.wrote, band: plan.after },
    preview + `  wrote ${plan.path}. The band follows within a few seconds; no restart.\n`,
  );
}

// `session refresh <path>`: this session's pointer from a story file, after a
// write no hook saw (the close ceremony's copy). Machine-local state, like the
// hooks' own writes — no confirmation. No session: nothing written, exit 0.
async function runSession(ctx) {
  const { row, values, positionals, cfg, project, env, stdout, stderr } = ctx;
  if (positionals[0] !== "refresh" || !positionals[1] || positionals.length > 2)
    return usageFail(
      Object.assign(new Error("session takes refresh <path> (a story file in the vault)"), { code: "USAGE" }),
      {
        verb: row.verb,
        ...ctx,
      },
    );
  const r = refreshSessionPointer(project, cfg, positionals[1], { env });
  const ok = !r.refusal;
  const result = ok ? r : { error: r.refusal.message, code: r.refusal.code };
  if (values.json) stdout.write(JSON.stringify(envelope("session refresh", project, ok, result), null, 2) + "\n");
  else if (!ok) stderr.write(`${r.refusal.message}\n`);
  else if (!r.refreshed) stdout.write("No session id from the host: nothing written.\n");
  else {
    const p = r.pointer;
    stdout.write(
      `This session's story: ${p.story_title || p.active_story}${p.story_status ? ` (${p.story_status})` : ""}.\n`,
    );
  }
  return ok ? 0 : 1;
}

async function runReconcile({ values, project, env, stdin, stdout, stderr, ask }) {
  const write = Boolean(values.write);
  const only = values.only ?? null;
  // The gate: --only names what is written and confirms headless; a bare
  // --write asks on a terminal and refuses without one.
  if (write && !only) {
    const yes = await confirmWrite(`Regenerate every derived view of ${project}'s vault? [y/N] `, {
      stdin,
      stdout,
      ask,
    });
    if (yes === null) {
      stderr.write("a bare reconcile --write in a non-TTY refuses; name what is written to confirm: --only <target>\n");
      if (values.json)
        stdout.write(JSON.stringify(envelope("reconcile", project, false, { refused: "non-tty" }), null, 2) + "\n");
      return 1;
    }
    if (!yes) {
      stdout.write("nothing written.\n");
      return 0;
    }
  }
  const { runReconcile: core } = await import("./reconcile.mjs");
  let out;
  try {
    out = core({ write, only, projectDir: project, env: ownEnv(env, project) });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    stderr.write(msg + "\n");
    if (values.json)
      stdout.write(JSON.stringify(envelope("reconcile", project, false, { error: msg }), null, 2) + "\n");
    return e && e.code === "UNBOUND" ? 3 : 2;
  }
  const failed = write && out.summary && out.summary.failed > 0;
  stdout.write(JSON.stringify(values.json ? envelope("reconcile", project, !failed, out) : out, null, 2) + "\n");
  return failed ? 1 : 0;
}

// configure (its spec): loaded on first use, like setup. The module returns a
// usage error, an unbound project, a refusal's message, or a result; the bin
// writes the line, the envelope and the exit code.
async function runConfigureVerb(ctx) {
  const { runConfigure } = await import("./configure.mjs");
  const { values, env, stdout, stderr, project } = ctx;
  const r = await runConfigure({
    ...ctx,
    root: PACKAGE_ROOT,
    ownEnv: (p) => ownEnv(env, p),
    nearest,
  });
  if (r.usage) return usageFail(Object.assign(new Error(r.usage), { code: "USAGE" }), { verb: "configure", ...ctx });
  if (r.unbound) {
    const text = notBoundText(project, env);
    if (values.json)
      stdout.write(JSON.stringify(envelope("configure", project, false, { error: text, exit: 3 }), null, 2) + "\n");
    else stderr.write(text + "\n");
    return 3;
  }
  if (r.message && !values.json) stderr.write(r.message + "\n");
  if (values.json && r.result)
    stdout.write(JSON.stringify(envelope("configure", project, r.ok, r.result), null, 2) + "\n");
  return r.code;
}

// setup (the setup story): its own module, imported lazily as the install
// family is, run with this package as its root and in the environment every
// installer run gets (ownEnv, for the project setup settles on). The envelope
// is written here, as every verb's is: its result is the write verbs' keys
// plus `setup`. A usage error is exit 2 with its envelope.
async function runSetupVerb(ctx) {
  const { runSetup } = await import("./setup.mjs");
  const { values, env, stdout } = ctx;
  const r = await runSetup({
    ...ctx,
    root: PACKAGE_ROOT,
    ownEnv: (p) => ownEnv(env, p),
    author: (p) => gitAuthor(p, env),
  });
  if (r.error) return usageFail(Object.assign(new Error(r.error), { code: "USAGE" }), { verb: "setup", ...ctx });
  if (values.json && r.result)
    stdout.write(JSON.stringify(envelope("setup", r.project, r.ok, r.result), null, 2) + "\n");
  return r.code;
}

async function runInstallVerb({ row, values, project, env, cwd, stdin, stdout, ask }) {
  const ih = await import("./install-harness.mjs");
  const opts = {
    harnesses: values.harness || [],
    surfaces: values.surface && values.surface.length ? values.surface : null,
    globalRemoval: Boolean(values.global),
    register: !values["no-register"],
    root: PACKAGE_ROOT,
    env: ownEnv(env, project),
    cwd,
    stdin,
    stdout,
    ask,
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
  };
  // plan goes through the installer's own planOptions, as its main() does, so
  // the two entry points read the same root version for a dry-run row.
  if (row.verb === "plan") {
    const p = ih.plan(project, ih.planOptions(opts));
    if (values.json)
      stdout.write(
        JSON.stringify(
          envelope("plan", project, p.ok && !p.incomplete, { ...p, items: p.items.map(ih.publicItem) }),
          null,
          2,
        ) + "\n",
      );
    else {
      const c = term.caps(stdout, env);
      stdout.write(ih.renderPreview(p, { verbose: opts.verbose, verb: "plan", caps: c }));
    }
    return p.ok && !p.incomplete ? 0 : 1;
  }
  // Text mode hands runVerb the stream: the plan is printed before any
  // question, then each step, then DONE (install spec contracts 9 and 18).
  const r = await ih.runVerb(row.verb, project, values.json ? opts : { ...opts, out: stdout });
  // A registration the plan could not make (no host CLI) or a host command
  // that failed is exit 1 with the rest applied (install spec contract 4′).
  const ok = r.plan.ok && !r.plan.incomplete && !r.failed && (r.gate.confirmed || r.gate.why === "nothing-to-do");
  if (values.json) {
    // `fetched` is additive: the shells a run fetched before its plan, [] for
    // a run that fetched none (uninstall always).
    stdout.write(
      JSON.stringify(
        envelope(row.verb, project, ok, {
          gate: r.gate,
          applied: r.applied,
          failed: r.failed,
          incomplete: r.plan.incomplete,
          plannedAgainst: r.plan.plannedAgainst,
          items: r.plan.items.map(ih.publicItem),
          refusals: r.plan.refusals,
          reports: r.plan.reports,
          fetched: r.fetched || [],
        }),
        null,
        2,
      ) + "\n",
    );
  } else {
    // The installer's own words for a gate that wrote nothing — a bare run
    // without a terminal, a declined question, a channel switch without a
    // terminal — shared with its main(), so the two entries say the same.
    stdout.write(ih.gateText(r, { verb: row.verb, harnesses: opts.harnesses, caps: term.caps(stdout, env) }));
  }
  return ok ? 0 : 1;
}

// ─── run ───────────────────────────────────────────────────────────────

// Every verb's handler, keyed by verb: the read half from read-verbs.mjs,
// the rest here. Exported so a test can wrap one (setup's sandboxed home) in
// a table of its own.
export const HANDLERS = Object.freeze({
  ...READ_HANDLERS,
  setup: runSetupVerb,
  configure: runConfigureVerb,
  reconcile: runReconcile,
  plan: runInstallVerb,
  install: runInstallVerb,
  uninstall: runInstallVerb,
  upgrade: runInstallVerb,
  agents: runAgents,
  band: runBand,
  session: runSession,
  bind: runBind(false),
  init: runBind(true),
  scaffold: runScaffold,
  mcp: runMcp,
});

// run(argv, opts) — the bin's one call: the parse over the one table, every
// verb served. `opts` as dispatch()'s (verbs.mjs): `verbs` is the table this
// run answers for, VERBS or a test's own, whose rows may carry their own run.
export function run(argv, opts = {}) {
  return dispatch(argv, HANDLERS, opts);
}

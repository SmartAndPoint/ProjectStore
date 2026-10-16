// projectstore — read-verbs.mjs
//
// The read-verb runner: the handlers of the verbs that write nothing (status,
// orientation, search, show, graph, codemap, doctor and version), and
// runRead(), which dispatches through the one verb table (scripts/verbs.mjs)
// with these handlers alone. The CLI's run() hands dispatch() these and its
// write handlers; the MCP server (scripts/mcp.mjs) runs runRead() and imports
// nothing from cli.mjs. So every MCP tool is a call into the same code its CLI
// verb runs, with the same envelope (MCP ADR decisions 1 and 2), and no module
// this one reaches is the installer or what it spawns — the story "The MCP
// server's entry reaches no install verb through a read-verb runner that
// shares the CLI's verb table…" (PS-DIRECTORY), whose fence
// (tests/portability.test.mjs) walks this module's imports.
//
// The one import() here is doctor's text renderer, doctor-report.mjs, which
// imports term.mjs and lib.mjs only.

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as term from "./term.mjs";
import { doctorFallbackText } from "./lib.mjs";
import { READ_OPERATIONS, LINEAGE_KINDS } from "./query.mjs";
import { dispatch, envelope, packageVersion, usageFail, ownEnv, runVersion } from "./verbs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DOCTOR_SCRIPT = resolve(HERE, "doctor.mjs");
export const DOCTOR_TIMEOUT_MS = 60000;

// The read verbs: one call into query.mjs, the result in the envelope or
// rendered. A usage error from the operation (a bad path, a missing query)
// is exit 2 with the message, never a stack trace. A renderer gets the
// stream's caps — painted at a terminal, plain on a pipe — and the env its
// command forms are named for; one that takes neither ignores them.
function emitRead({ verb, values, project, stdout, env }, op, result, ok = true) {
  if (values.json) stdout.write(JSON.stringify(envelope(verb, project, ok, result), null, 2) + "\n");
  else stdout.write(op.render(result, { caps: term.caps(stdout, env), env }));
  return ok ? 0 : 1;
}

function readVerb(name) {
  return async (ctx) => {
    const { row, values, positionals, cfg, project } = ctx;
    const op = READ_OPERATIONS[name];
    try {
      let result;
      if (name === "status") result = op.fn(cfg, { project });
      else if (name === "orientation") result = await op.fn(cfg);
      else if (name === "search")
        result = op.fn(cfg, positionals.join(" "), {
          kinds: values.kind || null,
          status: values.status ?? null,
          limit: values.limit,
          includeDerived: Boolean(values["include-derived"]),
          caseSensitive: Boolean(values["case-sensitive"]),
        });
      else if (name === "show")
        result = op.fn(cfg, positionals[0], { body: Boolean(values.body), section: values.section ?? null });
      return emitRead({ verb: row.verb, ...ctx }, op, result);
    } catch (e) {
      if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
      throw e;
    }
  };
}

async function runGraph(ctx) {
  const { row, values, positionals, cfg } = ctx;
  const sub = positionals[0];
  const path = positionals[1];
  if (!["neighbors", "lineage"].includes(sub))
    return usageFail(Object.assign(new Error("graph takes neighbors <path> or lineage <path>"), { code: "USAGE" }), {
      verb: row.verb,
      ...ctx,
    });
  const op = READ_OPERATIONS[sub];
  try {
    // The row declares the union; each mode takes its own — an option the
    // mode would ignore is a usage error, not a silent no-op.
    const notFor = sub === "neighbors" ? ["depth"] : ["direction", "limit"];
    for (const o of notFor)
      if (values[o] !== undefined)
        throw Object.assign(new Error(`--${o} is not an option of graph ${sub}`), { code: "USAGE" });
    const result =
      sub === "neighbors"
        ? op.fn(cfg, path, { kinds: values.kind || null, direction: values.direction, limit: values.limit })
        : op.fn(cfg, path, {
            depth: values.depth,
            kinds: values.kind && values.kind.length ? values.kind : LINEAGE_KINDS,
          });
    return emitRead({ verb: `graph ${sub}`, ...ctx }, op, result);
  } catch (e) {
    if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
    throw e;
  }
}

async function runCodemap(ctx) {
  const { row, values, cfg } = ctx;
  const op = READ_OPERATIONS.codeRefs;
  try {
    if (!values.for)
      throw Object.assign(new Error("codemap takes --for <selector>; regeneration is reconcile --only codemap"), {
        code: "USAGE",
      });
    return emitRead({ verb: row.verb, ...ctx }, op, op.fn(cfg, values.for, { reverse: Boolean(values.reverse) }));
  } catch (e) {
    if (e && e.code === "USAGE") return usageFail(e, { verb: row.verb, ...ctx });
    throw e;
  }
}

// ─── doctor ────────────────────────────────────────────────────────────
//
// Spawned, never imported (MCP ADR decision 2): doctor's main writes to
// stdout and is not exported, and importing its checks would be a second
// doctor. One spawn of scripts/doctor.mjs, always --json: its findings decide
// the exit code (doctor.mjs sets none of its own). The CLI spawns it
// synchronously; the MCP server, whose loop must keep answering, spawns it
// asynchronously (doctorAsync). Both read the child through doctorOutcome
// and answer doctorEnvelope, so the tool's result is the verb's by
// construction.

// The child's argv: --json, and the sections the flags name.
export const doctorArgs = (values) => [
  DOCTOR_SCRIPT,
  "--json",
  ...[values.install && "--install", values.vault && "--vault"].filter(Boolean),
];

// Where the child runs: in the project when it exists — a project that does
// not exist is still one doctor can report on ("not bound") — in the
// environment every child of this package gets (ownEnv).
const doctorSpawnOptions = (project, env) => ({
  cwd: existsSync(project) ? project : undefined,
  env: ownEnv(env, project),
});

// The child's result → { ok, findings } or { error }.
export function doctorOutcome({ error = null, status, stdout = "", stderr = "" }) {
  if (error) return { error: error.message || String(error) };
  if (status !== 0 && !stdout) return { error: (stderr || "").trim() || `exit ${status}` };
  let findings;
  try {
    findings = JSON.parse(stdout);
  } catch {
    return { error: "unparseable output" };
  }
  return { ok: !findings.some((f) => f.level === "issue"), findings };
}

// The verb's envelope and exit code for an outcome: 0 clean, 1 findings, 2
// when doctor could not answer.
export function doctorEnvelope(project, outcome) {
  if (outcome.error) return { code: 2, envelope: envelope("doctor", project, false, { error: outcome.error }) };
  return { code: outcome.ok ? 0 : 1, envelope: envelope("doctor", project, outcome.ok, outcome.findings) };
}

// The MCP server's doctor: the same child, asynchronous, killed after
// `timeoutMs` or when the caller kills it (onChild hands it over, for
// notifications/cancelled). Resolves with doctorEnvelope's answer.
export function doctorAsync(values, { project, env, timeoutMs = DOCTOR_TIMEOUT_MS, onChild = null }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, doctorArgs(values), {
      ...doctorSpawnOptions(project, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (onChild) onChild(child);
    let out = "",
      err = "",
      timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (r) => {
      clearTimeout(timer);
      done(doctorEnvelope(project, doctorOutcome(r)));
    };
    child.on("error", (e) => finish({ error: e }));
    child.on("close", (status, signal) =>
      finish(
        status === null
          ? { error: new Error(timedOut ? `timed out after ${timeoutMs} ms` : `ended by ${signal}`) }
          : { status, stdout: out, stderr: err },
      ),
    );
  });
}

// The CLI's doctor: the text a person reads is drawn from the findings here,
// in this process, by doctor-report.mjs — a renderer that imports no check
// (the presentation spec, contract 11). So a terminal gets colour, which a
// piped child could not tell it had, and the report and the exit code can
// never come from two different runs.
async function runDoctor({ values, project, env, stdout, stderr }) {
  const r = spawnSync(process.execPath, doctorArgs(values), {
    ...doctorSpawnOptions(project, env),
    encoding: "utf8",
    timeout: DOCTOR_TIMEOUT_MS,
    maxBuffer: 1 << 24,
  });
  const outcome = doctorOutcome(r);
  const answer = doctorEnvelope(project, outcome);
  if (values.json) stdout.write(JSON.stringify(answer.envelope, null, 2) + "\n");
  if (outcome.error) {
    stderr.write(`doctor failed: ${outcome.error}\n`);
    return answer.code;
  }
  if (!values.json) {
    // The sections as doctor.mjs derives them: no flag is both.
    const named = [values.install && "install", values.vault && "vault"].filter(Boolean);
    stdout.write(
      await doctorText(outcome.findings, named.length ? named : ["install", "vault"], {
        caps: term.caps(stdout, env),
        verbose: Boolean(values.verbose),
        project,
        env: ownEnv(env, project),
        stderr,
      }),
    );
  }
  return answer.code;
}

// doctor's text from its findings. `env` is the child's environment
// (ownEnv), so every command form the report names is the one doctor itself
// would name. A renderer that cannot load, or throws, must not cost the
// reader the findings: they are printed one per line, `level check message
// — file`, and the Summary line still ends them (lib.mjs). `load` stands in
// for the import in a test.
export async function doctorText(
  findings,
  groups,
  { caps, verbose = false, project = null, env = process.env, stderr = null } = {},
  { load = () => import("./doctor-report.mjs") } = {},
) {
  try {
    const { report } = await load();
    return report(findings, groups, { caps, verbose, version: packageVersion(), project, env });
  } catch (e) {
    if (stderr)
      stderr.write(
        `doctor: the report could not be drawn (${e && e.message ? e.message : e}); its findings follow, one per line.\n`,
      );
    return doctorFallbackText(findings, { env });
  }
}

// ─── The runner ────────────────────────────────────────────────────────

// The read verbs' handlers, keyed by verb: what the read runner serves, and
// the half of cli.mjs's HANDLERS that writes nothing.
export const READ_HANDLERS = Object.freeze({
  status: readVerb("status"),
  orientation: readVerb("orientation"),
  search: readVerb("search"),
  show: readVerb("show"),
  graph: runGraph,
  codemap: runCodemap,
  doctor: runDoctor,
  version: runVersion,
});

// runRead(argv, opts) — the CLI's parse over the one table, serving the read
// verbs only: any other verb of the table is refused, exit 2. `opts` as
// dispatch()'s (verbs.mjs).
export function runRead(argv, opts = {}) {
  return dispatch(argv, READ_HANDLERS, opts);
}

// projectstore — test fixtures for the shell fetch (the story "Install and
// upgrade fetch a shell-rooted harness at the bin's own version, once per run;
// plan and uninstall never fetch"). Node built-ins only: the PATH stubs below
// import this file back, so a spawned stub loads nothing of the core.
//
//   layShellTree(prefix, spec, mode)  → what `npm install --prefix` lays down
//   NPM_ERRORS                        → npm's --json error bodies, by mode
//   fakeNpm(dir)                      → a PATH stub: { bin, env(extra), log(), reset() }
//   fakeNpmSpawn({ mode, registry })  → an in-process spawn: ChildProcess-like
//   codexHost(home, { fail })         → the Codex CLI's measured shapes, in-process
//   fakeCodexBin(dir)                 → the same host as a PATH stub
//
// Modes (FAKE_NPM_MODE for the stub, `mode` in-process): ok (default),
// wrong-name, wrong-version, no-plugin-manifest, plugin-version,
// core-version, ETARGET, E404, E401, E403, ECONNREFUSED, FETCH_ERROR, hang.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync, statSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const SELF = pathToFileURL(fileURLToPath(import.meta.url)).href;
export const FAKE_REGISTRY = "https://registry.example.test/";

// npm's --json failure bodies (stdout), as npm 11.19 prints them, with the
// stderr line it prints beside them.
export const NPM_ERRORS = {
  ETARGET: { code: "ETARGET", summary: "No matching version found for <spec>.", detail: "In most cases you or one of your dependencies are requesting\na package version that doesn't exist." },
  E404: { code: "E404", summary: "Not Found - GET <registry><name> - Not found", detail: "The requested resource '<spec>' could not be found or you do not have permission to access it." },
  E401: { code: "E401", summary: "Unable to authenticate, your authentication token seems to be invalid.", detail: "To correct this please try logging in again with:\n  npm login" },
  E403: { code: "E403", summary: "403 Forbidden - GET <registry><name> - forbidden", detail: "" },
  ECONNREFUSED: { code: "ECONNREFUSED", summary: "request to <registry><name> failed, reason: connect ECONNREFUSED 127.0.0.1:9", detail: "" },
  FETCH_ERROR: { code: "FETCH_ERROR", summary: "network timeout at: <registry><name>", detail: "" },
};

// The argv's last word, `<name>@<version>`, and its --prefix.
function parseInstall(argv) {
  const at = argv.indexOf("--prefix");
  const spec = argv[argv.length - 1];
  const i = spec.lastIndexOf("@");
  return { prefix: at >= 0 ? argv[at + 1] : null, spec, name: spec.slice(0, i), version: spec.slice(i + 1), registry: argv.includes("--registry") ? argv[argv.indexOf("--registry") + 1] : FAKE_REGISTRY };
}

// The tree a published shell lays: its package.json, the legacy plugin
// manifest Codex validates, one skill, and the bundled core — plus what npm
// writes beside it at the prefix top. Each mode breaks one of rule 3's checks.
export function layShellTree(prefix, { name, version, pluginName = "projectstore", coreName = "projectstore" }, mode = "ok") {
  const root = join(prefix, "node_modules", name);
  const put = (rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n"); };
  put("package.json", { name: mode === "wrong-name" ? `${name}-other` : name, version: mode === "wrong-version" ? `${version}-other` : version, bundleDependencies: [coreName] });
  if (mode === "root-manifest") put("plugin.json", { name: pluginName, version });
  else if (mode !== "no-plugin-manifest") put(join(".codex-plugin", "plugin.json"), { name: pluginName, version: mode === "plugin-version" ? `${version}-other` : version });
  put(join("skills", "projectstore-status", "SKILL.md"), `---\nname: projectstore-status\ndescription: status\n---\n${version}\n`);
  put(join("node_modules", coreName, "package.json"), { name: coreName, version: mode === "core-version" ? `${version}-other` : version });
  writeFileSync(join(prefix, "node_modules", ".package-lock.json"), JSON.stringify({ name: "fetch", lockfileVersion: 3 }) + "\n");
  return root;
}

const errorBody = (mode, { name, spec, registry }) => {
  const e = NPM_ERRORS[mode];
  const fill = (t) => t.split("<spec>").join(spec).split("<name>").join(name).split("<registry>").join(registry);
  return { stdout: JSON.stringify({ error: { code: e.code, summary: fill(e.summary), detail: fill(e.detail) } }, null, 2) + "\n", stderr: `npm error code ${e.code}\nnpm error ${fill(e.summary)}\nnpm error A complete log of this run can be found in: /secret/_logs/debug-0.log\n` };
};

// One npm call, decided: what it prints and how it exits. `hang` never exits.
export function npmAnswer(argv, { mode = "ok", registry = FAKE_REGISTRY } = {}) {
  if (argv[0] === "config" && argv[1] === "get" && argv[2] === "registry") return mode === "hang" ? { hang: true } : { status: 0, stdout: registry + "\n", stderr: "" };
  if (argv[0] !== "install") return { status: 1, stdout: "", stderr: `fake npm: ${argv.join(" ")} is not faked\n` };
  const call = parseInstall(argv);
  if (mode === "hang") return { hang: true };
  if (NPM_ERRORS[mode]) return { status: 1, ...errorBody(mode, call) };
  layShellTree(call.prefix, call, mode);
  return { status: 0, stdout: JSON.stringify({ add: [{ name: call.name, version: call.version, path: `${call.prefix}/node_modules/***/${call.name}` }], added: 1 }, null, 2) + "\n", stderr: "" };
}

// The in-process stand-in for child_process.spawn, after fakeCodex's pattern
// in tests/codex-registration.test.mjs: an EventEmitter with piped stdout and
// stderr, `kill` and `unref`. Every call is recorded with its argv, cwd and
// env; a hung child exits only when killed, as a real one does on SIGTERM.
// `registryMode: "hang"` hangs the `config get registry` read instead.
export function fakeNpmSpawn({ mode = "ok", registry = FAKE_REGISTRY, onInstall = null, registryMode = "ok" } = {}) {
  const calls = [];
  const spawn = (bin, argv, opts = {}) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = null;
    child.unref = () => {};
    const call = { bin, argv: [...argv], cwd: opts.cwd, env: opts.env, stdio: opts.stdio };
    calls.push(call);
    child.kill = (signal = "SIGTERM") => { child.killed = signal; call.killed = signal; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("exit", null, signal); }); return true; };
    setImmediate(() => {
      const r = npmAnswer(argv, { mode: argv[0] === "install" ? mode : registryMode, registry });
      if (r.hang) return;
      if (argv[0] === "install" && onInstall) onInstall(call);
      child.stdout.end(r.stdout);
      child.stderr.end(r.stderr);
      child.emit("exit", r.status, null);
    });
    return child;
  };
  return { spawn, calls, installs: () => calls.filter((c) => c.argv[0] === "install") };
}

// The PATH stub: a node script named npm that logs argv and cwd to
// <dir>/calls.jsonl and answers as npmAnswer does, its mode from
// FAKE_NPM_MODE. `config get registry` is the REAL npm's, run in the same
// cwd, so a project's .npmrc and npm_config_registry decide it as they would.
export function fakeNpm(dir, { realNpm = whichReal("npm") } = {}) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
  const script = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), registryEnv: process.env.npm_config_registry || null }) + "\\n");
if (argv[0] === "config" && argv[1] === "get" && argv[2] === "registry" && ${JSON.stringify(Boolean(realNpm))}) {
  const r = spawnSync(${JSON.stringify(realNpm)}, argv, { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || ""); process.exit(r.status ?? 1);
}
import(${JSON.stringify(SELF)}).then(({ npmAnswer }) => {
  const r = npmAnswer(argv, { mode: argv[0] === "install" ? (process.env.FAKE_NPM_MODE || "ok") : "ok" });
  if (r.hang) { setInterval(() => {}, 1 << 30); return; }
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status;
});
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return {
    bin,
    dir,
    log: () => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    installs() { return this.log().filter((c) => c.argv[0] === "install"); },
    reset: () => { try { rmSync(join(dir, "calls.jsonl")); } catch {} },
  };
}

function whichReal(name) {
  for (const d of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(d, name);
    try { if (statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// Codex's plugin CLI in the shapes measured on codex-cli 0.153.4 — marketplace
// add/remove, plugin add/remove, plugin list [--json] — editing an isolated
// CODEX_HOME's config.toml and cache. Moved here from
// tests/codex-registration.test.mjs so the PATH stub below runs the same host.
export function codexHost(home, { fail = null } = {}) {
  return (_bin, argv) => {
    const op = argv.join(" ");
    if (fail && op.includes(fail)) return { status: 17, stdout: "", stderr: "injected host failure" };
    const config = join(home, "config.toml");
    let text = existsSync(config) ? readFileSync(config, "utf8") : "";
    if (op.startsWith("plugin marketplace add ")) {
      text = `[marketplaces.projectstore-npx]\nsource_type = "local"\nsource = "${join(home, "projectstore", "marketplace")}"\n\n` + text.replace(/\[marketplaces\.projectstore-npx][\s\S]*?(?=\n\[|$)/, "");
      writeFileSync(config, text);
    } else if (op === "plugin add projectstore@projectstore-npx") {
      const payload = join(home, "projectstore", "marketplace", "plugins", "projectstore");
      const version = JSON.parse(readFileSync(join(payload, ".codex-plugin", "plugin.json"), "utf8")).version;
      const cache = join(home, "plugins", "cache", "projectstore-npx", "projectstore", version);
      mkdirSync(cache, { recursive: true }); cpSync(payload, cache, { recursive: true });
      if (!text.includes('[plugins."projectstore@projectstore-npx"]')) text += `\n[plugins."projectstore@projectstore-npx"]\nenabled = true\n`;
      writeFileSync(config, text);
    } else if (op === "plugin remove projectstore@projectstore-npx") {
      text = text.replace(/\n?\[plugins\."projectstore@projectstore-npx"]\n(?:[^\[]|\n(?!\[))*?(?=\n\[|$)/, "\n");
      writeFileSync(config, text);
      rmSync(join(home, "plugins", "cache", "projectstore-npx", "projectstore"), { recursive: true, force: true });
    } else if (op === "plugin marketplace remove projectstore-npx") {
      text = text.replace(/\n?\[marketplaces\.projectstore-npx]\n(?:[^\[]|\n(?!\[))*?(?=\n\[|$)/, "\n");
      writeFileSync(config, text);
    } else if (op === "plugin list") {
      return { status: 0, stderr: "", stdout: "Marketplace  Plugin  Status\nprojectstore-npx  projectstore  enabled\n" };
    } else if (op === "plugin list --json") {
      if (!text.includes('[plugins."projectstore@projectstore-npx"]')) return { status: 0, stderr: "", stdout: JSON.stringify({ installed: [] }) };
      const cacheBase = join(home, "plugins", "cache", "projectstore-npx", "projectstore");
      const version = readdirSync(cacheBase).sort().at(-1);
      return { status: 0, stderr: "", stdout: JSON.stringify({ installed: [{
        pluginId: "projectstore@projectstore-npx",
        version,
        installed: true,
        enabled: true,
        marketplaceSource: { source: join(home, "projectstore", "marketplace") },
      }] }) };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

// codexHost as a PATH stub for runs of the bin: the home is the pinned
// CODEX_HOME the installer hands its child; FAKE_CODEX_FAIL=<op> fails it.
// Every call is logged to <dir>/calls.jsonl.
export function fakeCodexBin(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "codex-calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
import(${JSON.stringify(SELF)}).then(({ codexHost }) => {
  const r = codexHost(process.env.CODEX_HOME, { fail: process.env.FAKE_CODEX_FAIL || null })("codex", argv);
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || ""); process.exitCode = r.status;
});
`, { mode: 0o755 });
  return { bin, dir, log: () => { try { return readFileSync(join(dir, "codex-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}

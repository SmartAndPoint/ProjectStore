#!/usr/bin/env node
// Deterministic harness adapter renderer. The source commands, agents and
// passive skills stay Claude-shaped; emitting harnesses receive a committed
// tree in their own vocabulary.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emittingHarnesses, sourceHarness } from "./harness.mjs";
import { writeFileAtomic } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = sourceHarness();
const TARGETS = emittingHarnesses();
if (TARGETS.length !== 1) throw new Error(`this renderer currently requires exactly one emitting harness; found ${TARGETS.length}`);
const TARGET = TARGETS[0];
const OUT = resolve(ROOT, TARGET.output_dir);

const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const files = (dir, suffix = ".md") => readdirSync(dir)
  .filter((name) => name.endsWith(suffix))
  .sort()
  .map((name) => join(dir, name));

function frontmatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${relative(ROOT, file)}: missing YAML frontmatter`);
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[kv[1]] = value;
  }
  return { data, body: m[2].replace(/^\n+/, "") };
}

function yamlString(value) {
  return JSON.stringify(String(value).replace(/\s+/g, " ").trim());
}

function runtimePreamble() {
  return `## Runtime path\n\nResolve paths from this skill's own directory, never from the checkout or a\nremembered cache path. The plugin root is two directories above this SKILL.md;\nthe bundled core is \`<plugin-root>/node_modules/projectstore\`. Before running\nany ProjectStore command, export \`PROJECTSTORE_CORE_ROOT\` to that bundled-core\npath in its own shell statement, then use \`node "\${PROJECTSTORE_CORE_ROOT}/…"\`.\nDo not prefix the command with the assignment: a shell expands the quoted path\nbefore that inline assignment takes effect. If the bundled core is missing, stop\nand report a broken plugin install; do not fetch a different version from npm.\n\n## User arguments\n\nThe source command's host-substituted argument token is rendered here as\n\`<user-arguments>\` (or \`<user-arguments-without-fix>\`). Before executing a\nshown command, replace that token with the actual arguments from the user's\nrequest and shell-quote values safely. Never pass the angle-bracket token\nliterally and never treat it as a shell variable.\n`;
}

function rewriteBody(body) {
  const variable = (name) => "${" + name + "}";
  const sourceRoot = variable(SOURCE.runtime.plugin_root_env);
  const sourceProject = SOURCE.runtime.project_dir_env ? variable(SOURCE.runtime.project_dir_env) : null;
  const sourceWord = SOURCE.id.split("-")[0];
  return body
    .replaceAll("$ARGUMENTS_WITHOUT_FIX", "<user-arguments-without-fix>")
    .replaceAll("$ARGUMENTS", "<user-arguments>")
    .replaceAll(sourceRoot, "${PROJECTSTORE_CORE_ROOT}")
    .replaceAll(sourceProject || "<no-project-variable>", "$PWD")
    .replaceAll(`--harness ${SOURCE.id}`, `--harness ${TARGET.id}`)
    .replaceAll(SOURCE.display_name, TARGET.display_name)
    .replaceAll(SOURCE.display_name.split(" ")[0], TARGET.display_name)
    .replaceAll(sourceWord, TARGET.id)
    .replaceAll(SOURCE.surfaces.agents_block.reads_natively, TARGET.surfaces.agents_block.reads_natively)
    .replaceAll(SOURCE.runtime.harness_dir + "/", TARGET.runtime.harness_dir + "/")
    .replaceAll("/projectstore:*", "$projectstore-*")
    .replace(/\/projectstore:([a-z0-9-]+)/g, "$projectstore-$1")
    .replaceAll("AskUserQuestion", "the harness's user-input mechanism")
    .replaceAll("Read tool", "file-reading tool")
    .replaceAll("Write tool", "file-writing tool")
    .replaceAll("Edit tools", "file-editing tools");
}

function skill(name, description, body, { runtime = true } = {}) {
  return `---\nname: ${name}\ndescription: ${yamlString(rewriteBody(description))}\n---\n\n${runtime ? runtimePreamble() + "\n" : ""}${rewriteBody(body).trim()}\n`;
}

const COMMAND_OVERRIDES = {
  agents: {
    description: "Register or remove ProjectStore's shared agents block, inspect its Codex model overlay, or configure per-role models. Arguments: <register | unregister | status | configure>.",
    body: `You are managing ProjectStore's Codex agent integration. Require a bound project.

## register / unregister

Preview the requested change and ask for explicit approval. On approval, run the
core's \`install\` or \`uninstall\` verb with \`--harness codex --surface
agents_block --project "$PWD"\`. Print its output verbatim. Never edit the
managed block by hand.

## status

Run \`plan --json --harness codex --surface agents_block --project "$PWD"\`,
then \`agents show --json --project "$PWD"\`. Report the block state and each
role's resolved model and source. The active overlay path returned by the core
is authoritative.

## configure

Ask for a default model and optional per-role model ids. Use actual Codex model
ids supplied by the user or visible in the current host; do not translate model
names from another harness. Preview the exact argv, ask for approval, then run
\`agents configure --harness codex [--default <model>] [--agent
<role>=<model> ...] --project "$PWD"\`. The core is the only writer. Do not pass
an effort override: per-role effort is outside this integration's current
contract. A configured model is consumed by the role-orchestration skills on
their next spawn; no restart is needed.`,
  },
  bind: {
    description: "Bind this project to an existing ProjectStore vault, or initialize and bind a new vault, using the harness-neutral core. Arguments: [vault-path].",
    body: `Bind the current project through the core; never write the binding by
hand.

1. Resolve the requested vault path. If it exists, use \`bind\`; if the user
   explicitly asks to create it, use \`init\`. Ask for layout and language only
   when the user has not supplied them.
2. Show the resolved project, vault, verb, layout and language. Ask for explicit
   approval. Naming the vault is the core's non-interactive confirmation.
3. Run \`node "\${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" <bind|init>
   "<vault-path>" --layout <layout> --language <language> --project "$PWD"
   --json\` and report the result. Use \`--rebind\` only when the user explicitly
   approved replacing an existing binding.
4. Run \`status --json\` to verify the stored path and policies. Offer
   \`$projectstore-scaffold\` only for a newly initialized empty vault.

Codex plugin updates are performed with the \`projectstore-codex upgrade\`
installer command; this skill never sends the user to another harness's plugin
UI. Codex has no ProjectStore status-line surface, so binding does not offer or
write one. Model choices, when requested, go through \`$projectstore-agents
configure\` and the Codex overlay.`,
  },
  doctor: {
    description: "Diagnose the ProjectStore install and vault through the harness-neutral doctor; fixes remain previewed and approval-gated. Arguments: [--install | --vault] [--fix].",
    body: `Run the deterministic doctor through the bundled core with the user's
arguments and \`--json\`. Summarize every finding without re-deriving it.

When \`--fix\` is absent, remain read-only. When it is present, separate fixes
by owner: derived vault views use \`$projectstore-reconcile\`; Codex plugin or
agents-block drift uses the core's \`upgrade --harness codex\` path. Preview
each mutation and ask for explicit approval before running it. Unsupported
surfaces remain unsupported; do not create host configuration by hand. Never
claim a fix after a non-zero exit.`,
  },
  statusline: {
    description: "Explain ProjectStore status-line availability for Codex. This surface is unsupported and the skill never writes configuration. Arguments: on | off | status.",
    body: `ProjectStore's status-line surface is not supported by the Codex
harness. Do not run install or uninstall for \`--surface statusline\`, and do
not edit project or host configuration. Report the surface as unsupported.
For project state use \`$projectstore-status\`; for a compact live view use the
Codex application's own task and terminal UI.`,
  },
};

function renderCommand(file) {
  const { data, body } = frontmatter(read(file), file);
  const verb = file.split("/").pop().replace(/\.md$/, "");
  const name = `projectstore-${verb}`;
  const override = COMMAND_OVERRIDES[verb];
  if (override) return [join("skills", name, "SKILL.md"), skill(name, override.description, override.body)];
  const hint = data["argument-hint"] ? ` Arguments: ${data["argument-hint"]}.` : "";
  return [join("skills", name, "SKILL.md"), skill(name, `${data.description || `Run the ProjectStore ${verb} workflow.`}${hint}`, body)];
}

function renderPassive(file) {
  const { data, body } = frontmatter(read(file), file);
  const dir = file.split("/").at(-2);
  const name = data.name || dir;
  if (!name.startsWith("projectstore-")) throw new Error(`${relative(ROOT, file)}: skill name must be projectstore-*`);
  return [join("skills", name, "SKILL.md"), skill(name, data.description || name, body)];
}

function renderRole(file) {
  const { data, body } = frontmatter(read(file), file);
  const role = file.split("/").pop().replace(/\.md$/, "");
  const name = `projectstore-${role}`;
  const orchestration = `## Codex orchestration\n\nThis is a role-orchestration skill, not a native agent registration. Resolve the\nrole model by running:\n\n\`\`\`bash\nnode "\${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" agents model ${role} --json --project "$PWD"\n\`\`\`\n\nSpawn a collaboration agent for the bounded task. If the result names a model,\npass that model and use an empty or bounded context fork; otherwise inherit the\ncurrent model. Do not pass a reasoning-effort override: per-role effort belongs\nto a separate accepted story. Give the spawned agent the role contract below\nand the exact artifact/diff it must inspect. Wait for its final result.\n\n## Role contract\n\n`;
  const description = (data.description || `Run the ProjectStore ${role} role in a fresh collaboration agent.`)
    .replace(/^(?:Opus|Sonnet) \(max-effort\)\s+/, "");
  return [join("skills", name, "SKILL.md"), skill(name, description, orchestration + body)];
}

function renderHooks(manifest, root = ROOT) {
  const source = json(join(root, "hooks", "hooks.json"));
  const post = source.hooks?.PostToolUse || [];
  for (const group of post) if (group.matcher) group.matcher = (manifest.tools?.write_tools || []).join("|");
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    if (typeof value !== "string") return value;
    const sourceRoot = "${" + SOURCE.runtime.plugin_root_env + "}";
    const targetRoot = "${" + manifest.runtime.plugin_root_env + "}";
    const command = value.startsWith(`node ${sourceRoot}/`) ? value.slice(`node ${sourceRoot}/`.length) : null;
    return command ? `node "${targetRoot}/node_modules/projectstore/${command}"` : value.replaceAll(sourceRoot, `${targetRoot}/node_modules/projectstore`);
  };
  const text = JSON.stringify(rewrite(source), null, 2) + "\n";
  return [join("hooks", "hooks.json"), text];
}

export function renderCodexAdapter(root = ROOT) {
  const manifest = json(join(root, "harnesses", `${TARGET.id}.json`));
  if (!manifest.emit || !manifest.output_dir) throw new Error(`${TARGET.id} must declare an output_dir when emit is true`);
  const rows = [
    ...files(join(root, "commands")).map(renderCommand),
    ...files(join(root, "agents")).map(renderRole),
    ...readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("projectstore-"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => renderPassive(join(root, "skills", e.name, "SKILL.md"))),
    renderHooks(manifest, root),
  ];
  const out = new Map();
  for (const [rel, text] of rows) {
    if (rel.startsWith("..") || resolve(OUT, rel).slice(0, OUT.length + 1) !== OUT + "/") throw new Error(`adapter path escapes output root: ${rel}`);
    if (out.has(rel)) throw new Error(`adapter collision: ${rel}`);
    out.set(rel, text);
  }
  for (const [rel, text] of out) {
    const sourceTokens = [SOURCE.runtime.plugin_root_env, SOURCE.runtime.project_dir_env, SOURCE.display_name, SOURCE.runtime.harness_dir + "/"].filter(Boolean);
    const sourceAgentEnvs = (SOURCE.runtime.agent_overrides || []).map((row) => row.env).filter(Boolean);
    if (sourceTokens.some((token) => text.includes(token)) || sourceAgentEnvs.some((token) => text.includes(token)) || /\$ARGUMENTS|\/projectstore:|\bAskUserQuestion\b/.test(text)) throw new Error(`${rel}: source-harness vocabulary leaked into ${TARGET.display_name} adapter`);
    if (/\/reload-plugins\b|\/plugin(?:\s|\b)|harness\/codex-code\.json|\b(?:opus|sonnet|fable)\b/i.test(text)) throw new Error(`${rel}: source-harness model, environment or UI semantics leaked into ${TARGET.display_name} adapter`);
  }
  return out;
}

function currentTree(dir) {
  const out = new Map();
  const walk = (at) => {
    if (!existsSync(at)) return;
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(at, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), read(p));
    }
  };
  walk(dir);
  return out;
}

export function checkCodexAdapter(root = ROOT) {
  const wanted = renderCodexAdapter(root);
  const actual = currentTree(resolve(root, TARGET.output_dir));
  const missing = [...wanted.keys()].filter((k) => !actual.has(k));
  const unexpected = [...actual.keys()].filter((k) => !wanted.has(k));
  const drift = [...wanted.keys()].filter((k) => actual.has(k) && actual.get(k) !== wanted.get(k));
  return { ok: !missing.length && !unexpected.length && !drift.length, count: wanted.size, missing, unexpected, drift };
}

export function writeCodexAdapter(root = ROOT) {
  const wanted = renderCodexAdapter(root);
  const out = resolve(root, TARGET.output_dir);
  rmSync(out, { recursive: true, force: true });
  for (const [rel, text] of wanted) {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileAtomic(p, text, { sweep: false });
  }
  return { ok: true, count: wanted.size, output: relative(root, out) };
}

function main(argv) {
  const result = argv.includes("--write") ? writeCodexAdapter() : checkCodexAdapter();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

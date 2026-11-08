#!/usr/bin/env node
// projectstore — mcp-server.mjs
//
// The MCP server's entry: what the plugin's .mcp.json runs, as `node
// <plugin root>/scripts/mcp-server.mjs` with no other argument. The project
// comes from the directory the host declares in the server's environment
// (projectRootDeclared), since 0.30.9: Anthropic's plugin portal blocks any
// variable but the plugin root in a server's command (PS-DIRECTORY: "The MCP
// server's entry names no variable but ${CLAUDE_PLUGIN_ROOT}…"). That
// directory comes before PROJECTSTORE_PROJECT_DIR, as 0.30.8's --project
// did; --project still wins, for a test or a start by hand. It starts the
// server through mcp.mjs's serveSupplied, the path the CLI's `mcp` verb
// takes too, so the two entries serve alike.
// It lives under scripts/, never bin/: a file in the plugin's top-level bin/
// is on the host's Bash PATH, and it imports nothing from cli.mjs, so its
// imports reach no install verb (the PS-DIRECTORY story "The MCP server's
// entry reaches no install verb through a read-verb runner that shares the
// CLI's verb table…", decision 3; the MCP ADR's decision 1 as amended).
//
// process.exitCode, never process.exit(): stdout is the protocol channel,
// and exit() can truncate a pending write on a pipe. A bad argument is exit
// 2 with its reason on stderr, and nothing on stdout.

import { parseArgs } from "node:util";
import { serveSupplied } from "./mcp.mjs";
import { projectRootDeclared } from "./harness.mjs";

let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { project: { type: "string" } },
    strict: true,
    allowPositionals: false,
  }));
} catch (e) {
  process.stderr.write(`mcp-server: ${e.message} — it takes --project <dir> alone\n`);
  process.exitCode = 2;
}
if (values) process.exitCode = await serveSupplied({ project: values.project ?? projectRootDeclared(process.env) });

#!/usr/bin/env node
// projectstore — the bin. Delegates to scripts/cli.mjs and sets the exit code;
// nothing else lives here. process.exitCode, not process.exit(): the output is
// piped (`| jq`), and exit() can truncate a pending write on a pipe.
import { run } from "../scripts/cli.mjs";

process.exitCode = await run(process.argv.slice(2));

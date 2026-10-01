---
name: projectstore-search
description: "Search the bound vault for a phrase — literal, bounded, grouped by folder. Arguments: <query> [--kind <type>] [--status <status>] [--limit <n>] [--case-sensitive] [--include-derived]."
---

## Runtime path

Resolve paths from this skill's own directory, never from the checkout or a
remembered cache path. The plugin root is two directories above this SKILL.md;
the bundled core is `<plugin-root>/node_modules/projectstore`. Before running
any ProjectStore command, export `PROJECTSTORE_CORE_ROOT` to that bundled-core
path in its own shell statement, then use `node "${PROJECTSTORE_CORE_ROOT}/…"`.
Do not prefix the command with the assignment: a shell expands the quoted path
before that inline assignment takes effect. If the bundled core is missing, stop
and report a broken plugin install; do not fetch a different version from npm.

## User arguments

The source command's host-substituted argument token is rendered here as
`<user-arguments>` (or `<user-arguments-without-fix>`). Before executing a
shown command, replace that token with the actual arguments from the user's
request and shell-quote values safely. Never pass the angle-bracket token
literally and never treat it as a shell variable.

You are searching the vault for the user's query through the core's `search` verb (roadmap A8: the command is a thin front-end; the deterministic search lives in `scripts/query.mjs` and answers identically over MCP).

Steps:

1. Run the verb. The query is a positional and travels **behind `--`**, so a phrase that starts with `-` (a flag name, say) is searched for rather than parsed; the options, if the user gave any, go before it:

   ```bash
   node "${PROJECTSTORE_CORE_ROOT}/bin/projectstore.mjs" search [--kind <type>] [--status <status>] [--limit <n>] [--case-sensitive] [--include-derived] -- "<query>"
   ```

   The project resolves from the session's project directory; do not pass `--project`. Exit 3 means the project is unbound — say so and point at `$projectstore-bind <vault-path>`; exit 2 is a usage error — relay its message.

2. Print the output verbatim. It is already grouped by the vault's top-level folder with a count per group and `path:line  snippet` lines; the header says how many matches there are, whether the list was cut (`--limit`, default 20, cap 100) and whether a file hit the per-file cap (`[N in file]`). The search is literal substring, case-insensitive unless `--case-sensitive`, over artifact bodies and `title:` lines; the derived views (the board, `code-map.md`, `graph.md`) are excluded unless `--include-derived`.

3. Zero matches is exit 0 and the output already suggests a shorter or case-insensitive phrase. Do not fall back to a shell `grep`: the verb is the search.

4. At the end, print a hint: "Open a file with the file-reading tool: `Read <vault_path>/<path>`" — `vault_path` is in `.projectstore/projectstore.json` (or `status --json` → `result.vault_path`); the search output prints vault-relative paths.

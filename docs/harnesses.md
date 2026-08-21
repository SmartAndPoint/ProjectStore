# Harnesses — one source, every agent CLI

projectstore runs on more than one agentic harness. Claude Code and Codex are
bundled; a third is a JSON file away.

This page is the contract for anyone adding a feature or a harness. The short
version: **you write a feature once, in Claude Code's shapes, and the repository
makes sure it reaches everywhere else.** That is enforced by tests, not by
remembering.

## The layers

```
commands/  agents/  skills/  hooks/hooks.json     ← SOURCE. Hand-written.
scaffold/  templates/  scripts/*.mjs             ← CORE. Harness-neutral compute.
harnesses/<id>.json                              ← One capability manifest per harness.
        │
        │  node scripts/build-adapters.mjs
        ▼
adapters/<id>/**                                 ← GENERATED. Never hand-edited.
        │
        │  node scripts/install-<id>.mjs
        ▼
~/.<id>/  (or <project>/.<id>/)                  ← What the harness actually reads.
```

`scripts/harness.mjs` is the only module allowed to read a harness-branded
environment variable. Everything else asks it for a path, a tool name or a
command spelling, and gets the active harness's answer.

## What each harness gets

| Surface | Claude Code | Codex |
|---|---|---|
| Project instructions | `CLAUDE.md` → `@AGENTS.md` | `AGENTS.md`, read natively |
| Hooks | `hooks/hooks.json` | `~/.codex/hooks.json` (identical JSON contract) |
| Slash commands | `commands/*.md` → `/projectstore:adr` | `prompts/*.md` → `/projectstore-adr` |
| Subagents | `agents/*.md` (YAML + markdown) | `agents/*.toml` (`developer_instructions`) |
| Skills | `skills/<n>/SKILL.md` | same, plus a required `name:` key |
| Approval gate | `AskUserQuestion` | a plain-text numbered prompt (model-honoured — see below) |
| Status line | `statusLine` slot | — no equivalent; not ported |

The hook event names and the stdin/stdout JSON are the same on both, which is
why the core hooks are shared verbatim rather than reimplemented.

## The three invariants

`tests/portability.test.mjs` is the whole mechanism. Each invariant closes a
different way for a feature to end up on one harness only.

**1 — Staleness.** The committed `adapters/` trees must be byte-identical to
what the generator produces right now. Add a command and forget to regenerate,
and the suite fails naming the file you did not produce.

```
✖ INVARIANT 1: committed adapter trees match what the generator produces
    never generated: adapters/codex/prompts/projectstore-zztest.md
    Run: node scripts/build-adapters.mjs
```

**2 — Lint.** No harness-branded fragment may survive into a generated file. It
checks the *output*, not the source, so a token with a rewrite rule passes and
an unmapped one fails:

```
✖ INVARIANT 2: no harness-branded fragment survives into a generated file
    adapters/codex/prompts/projectstore-status.md
      leaked: "$CLAUDE_SESSION_ID"  (pattern /\$\{?CLAUDE_[A-Z_]+\}?/)
```

**3 — Coverage.** Every surface must reach every registered harness, or say in
its own frontmatter why it does not. This is the direction that matters when a
harness is *added*: the new one cannot quietly receive a subset.

## Adding a feature

Write it in `commands/`, `agents/` or `skills/` exactly as you would have
before, then:

```bash
node scripts/build-adapters.mjs
node --test tests/portability.test.mjs
```

Commit the source and the regenerated tree together. If the lint objects, you
have three options and should pick honestly:

* **The token has an equivalent** → add a rewrite rule to `harnesses/<id>.json`.
  Rules apply in declared order by plain substring replacement, so a specific
  rule must precede its catch-all. A test enforces that ordering.
* **The concept does not exist elsewhere** → gate the passage:

  ```markdown
  <!-- projectstore:harness only=claude-code -->
  Open `/plugin` → Marketplaces and toggle auto-update.
  <!-- /projectstore:harness -->
  <!-- projectstore:harness except=claude-code -->
  Pull the checkout and re-run `node scripts/install-codex.mjs`.
  <!-- /projectstore:harness -->
  ```

  **Which side of the comment the body goes on matters.** Claude Code reads
  `commands/`, `agents/` and `skills/` directly, markers and all — so a visible
  block that *excludes* it still delivers its body as prose, and the command
  ends up carrying two contradictory rules. Content for the source harness goes
  in a visible block; content for the others goes inside the comment:

  ```markdown
  <!-- projectstore:harness-alt only=codex
  2. **Scan `AGENTS.md`** — this harness reads it natively.
  -->
  ```

  A test enforces the split in both directions, so you cannot get it backwards
  silently.

  For a whole file, use frontmatter instead — `harness-only: claude-code`, as
  `commands/statusline.md` does. A surface gated out of *every* harness fails
  the suite: that is a deleted feature, not a portable one.
* **The prose did not need to name a harness** → rephrase it.

## Adding a harness

Copy `harnesses/codex.json`, change the values, run the generator. No source
surface and no code changes — that is the claim the design makes, and it was
verified by adding a throwaway third harness and watching all 30 surfaces
appear from a values-only manifest.

What the manifest has to answer:

* `runtime` — the environment variables and config directories it uses.
* `tools` — its write-tool names, where a tool call carries its target path, and
  whether it has an interactive approval tool.
* `hooks` — event-name mapping, unsupported events, the write matcher, and the
  placeholder the installer substitutes with an absolute path.
* `surfaces` — where each surface lives, in what format, and how it is invoked.
* `rewrites` — the token translation table. Rules apply in declared order by
  substring replacement; tests enforce both that a specific rule precedes its
  catch-all and that no rule rewrites another's output.
* `lint.forbidden_unmapped` — regexes for what CANNOT be derived: product
  names, command namespaces, UI affordances. Every other harness's write-tool
  names and environment variables are generated by `lintPatterns()`, because a
  hand-written list only ever contains what someone already thought of — which
  is how `Write`/`Edit` reached Codex carrying a safety prohibition that named
  nothing there.
* `lint.allow` — literal phrases exempt from the derived patterns, each one a
  place where a tool name is not a tool reference (an approval-option label, an
  English verb). Keep it short: it is a hole in the guard, and rephrasing the
  source is always the better fix.
* `capabilities` — what it can and cannot do, so prose stops promising features
  it does not have. Record these from the harness's documentation, not from
  memory: `claude-code.json` shipped with `permission_decision_hook: false`,
  which was simply false, and a doc paragraph was then written to justify the
  asymmetry it invented.

Set `emit: false` only for the harness whose shapes the source is already in —
today that is Claude Code, and exactly one manifest may claim it.

## Installing on Codex

```bash
node scripts/install-codex.mjs                 # scope to this project (default)
node scripts/install-codex.mjs /path/to/repo   # scope to another project
node scripts/install-codex.mjs --user          # everything into $CODEX_HOME
node scripts/install-codex.mjs --dry-run
node scripts/install-codex.mjs --uninstall
```

**Two gates, and only the second one decides whether hooks run.** Project trust
(above) gets them *discovered*. Each hook definition must then be *reviewed and
trusted individually* before Codex will execute it — and until that happens they
appear in the hooks list while being skipped. Six hooks visible in Settings and
nothing firing is what a pending approval looks like, which is why it reads as a
broken install.

```
CLI:     /hooks
Desktop: Settings → Hooks → From Projects → <your project>
```

Approval is recorded against the hook's **hash**, so anything that rewrites a
definition — reinstalling after moving the checkout, an update that changes the
command — revokes it and the hooks stop again, silently. Expect to re-review
after an update.

This is deliberate: a repository cannot make you execute arbitrary commands by
shipping a `.codex/` directory. projectstore therefore never writes into that
trust store and never will — the review is the user's to give, and an installer
that forged it would be defeating the mechanism that protects its own users.

**Project trust is part of the install, not a detail.** Codex loads a project's
`.codex/` layer — its config *and its hooks* — only when the project is marked
trusted in `~/.codex/config.toml`, and skips the whole layer in silence
otherwise. A project-scoped install into an untrusted project therefore writes
hooks that can never fire, with nothing reporting it. `--trust` adds the stanza:

```toml
[projects."/path/to/repo"]
trust_level = "trusted"
```

The installer exits nonzero rather than claim a success it cannot deliver,
`smoke-codex` fails on it, and `doctor`'s `hooks` finding names it — but only on
a harness that has such a gate and only when this project actually fails it, so
it never appears as noise elsewhere. `--user` installs are unaffected: user-level
hooks do not depend on project trust.

**The install is split, and the split is not a choice.** Skills, agents and
hooks go into `<project>/.codex/` — scoping the hooks is the point, since
home-level hooks fire in *every* Codex project, costing a node process per tool
call in repositories with no vault bound. Slash commands cannot be scoped:
Codex discovers custom prompts only under `$CODEX_HOME/prompts`, with no
project-level equivalent ([openai/codex#4734](https://github.com/openai/codex/issues/4734),
[#9848](https://github.com/openai/codex/issues/9848)), so a project-only install
would ship no `/projectstore-*` commands at all. Each surface declares its scope
in the manifest and the installer prints both destinations every run.

Two things resolve at install time rather than being committed:
`{{PROJECTSTORE_ROOT}}` and `$PROJECTSTORE_ROOT` become this checkout's absolute
path, and `hooks.json` is **merged** rather than replaced — it is a shared file,
and clobbering a user's own hooks is damage nobody would attribute to a plugin
installer. Uninstall removes only entries whose command names our wrapper.

Hooks run from the checkout, so keep it in place or re-run the installer after
moving it. Restart Codex afterwards: it reads skills, prompts and agents at
startup.

## Verifying it actually works on Codex

Two halves, and the split is the point.

```bash
node scripts/smoke-codex.mjs            # the half that can be checked here
```

Checks that the adapter is current, that the surfaces landed where Codex looks
in the numbers expected, that the hook paths still resolve (they are absolute —
moving the checkout breaks them), and that each hook runs and produces the right
JSON, including a three-file relative `apply_patch` scoring all three paths. Exit
code 1 on any failure.

**What it cannot check is the contract itself.** Everything projectstore believes
about Codex's hook payload was verified against payloads this repository wrote —
an assumption checking an assumption. Only a real session settles it:

```bash
export PROJECTSTORE_HOOK_TRACE=~/.codex/hook-trace.jsonl
# start Codex, edit two files, run /compact, exit
node scripts/smoke-codex.mjs --trace ~/.codex/hook-trace.jsonl
unset PROJECTSTORE_HOOK_TRACE
```

`PROJECTSTORE_HOOK_TRACE` appends every raw hook payload as it arrives. The
summary then answers the three questions everything else rests on: does Codex
set `cwd` (project-root resolution needs it when `CODEX_PROJECT_DIR` is unset),
does `apply_patch` carry its envelope in `tool_input.command`, and do the paths
parse. When one is wrong it names the manifest key to change:

```
✗ apply_patch envelope is NOT in tool_input.command
    Found keys: patch, changes
    Update tools.patch_envelope_field in harnesses/codex.json.
```

Tracing is off unless the variable is set, appends only, and never throws — a
diagnostic that can break a hook is worse than no diagnostic.

Four things stay manual, because they are about Codex's own behaviour:

* **Discovery** — type `/` and look for `/projectstore-adr`; ask Codex which
  projectstore skills and agents it can see. Missing usually means Codex was not
  restarted, or reads a different `CODEX_HOME`.
* **The approval gate** — run `/projectstore-adr "test"` and check Codex stops
  and asks before writing. Here it is prose, not a tool; if it writes without
  asking, that is the known weakness above, not a bug.
* **Agents** — ask it to use the `projectstore-critic` subagent, confirming the
  TOML translation loads and its model/effort keys are accepted.
* **`doctor`** — `node scripts/doctor.mjs --install` inside a Codex session
  should report no statusline and no adapter findings.

### Two Codex differences worth knowing

**The approval gate is prose, not a tool — and on Codex that is all it is.**
Codex has no `AskUserQuestion`, so generated prompts carry a preamble telling
the model to ask in plain text and stop for an answer.

State this plainly rather than around it: projectstore's central promise is *"you
approve every write"*, and on Codex that promise is **honoured by the model, not
enforced by the harness**. A model that ignores the preamble writes without
asking, and nothing detects it.

An earlier version of this page claimed Codex offered a structural gate Claude
Code lacked. That was wrong in both directions. `PreToolUse` accepts
`hookSpecificOutput.permissionDecision: "deny"` on **both** harnesses, and
projectstore uses it on **neither**. So this is not an unavoidable Codex
degradation — it is one unimplemented feature, equally available on both, and
the honest next step for the whole plugin rather than a Codex catch-up item.

**One `apply_patch` call can write many files.** Claude Code's write tools carry
one path each; Codex reports a whole patch as a single call. Path extraction is
manifest-driven and returns a list, because taking the first path would
undercount the entry-rule score and log one activity entry where four belonged.

## Binding once, working everywhere

Config lookup searches a neutral location and *every* registered harness's
directory, active one first. A project bound in Claude Code
(`.claude/projectstore.json`) is found unchanged when the same checkout is
opened in Codex — no second bind, no divergent vault.

## What is deliberately not ported

The status line. Codex has no equivalent slot, and `syncStatusLine` returns
`unsupported-harness` rather than writing a settings file the harness never
reads. Faking it with a `systemMessage` line was considered and rejected: a
status line that is actually a message appears once per turn instead of
persisting, which is a different feature wearing the same name.

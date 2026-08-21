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
| Approval gate | `AskUserQuestion` | a plain-text numbered prompt |
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
* `rewrites` — the token translation table.
* `lint.forbidden_unmapped` — regexes marking a fragment as harness-branded.
* `capabilities` — what it can and cannot do, so prose stops promising features
  it does not have.

Set `emit: false` only for the harness whose shapes the source is already in —
today that is Claude Code, and exactly one manifest may claim it.

## Installing on Codex

```bash
node scripts/install-codex.mjs              # into $CODEX_HOME (default ~/.codex)
node scripts/install-codex.mjs --project    # into <cwd>/.codex
node scripts/install-codex.mjs --dry-run
node scripts/install-codex.mjs --uninstall
```

Two things resolve at install time rather than being committed:
`{{PROJECTSTORE_ROOT}}` and `$PROJECTSTORE_ROOT` become this checkout's absolute
path, and `hooks.json` is **merged** rather than replaced — it is a shared file,
and clobbering a user's own hooks is damage nobody would attribute to a plugin
installer. Uninstall removes only entries whose command names our wrapper.

Hooks run from the checkout, so keep it in place or re-run the installer after
moving it. Restart Codex afterwards: it reads skills, prompts and agents at
startup.

### Two Codex differences worth knowing

**The approval gate is prose, not a tool.** Codex has no `AskUserQuestion`, so
generated prompts carry a preamble telling the model to ask in plain text and
stop for an answer. That is weaker than a tool-enforced gate. Codex does offer a
`PermissionRequest` hook that can return `permissionDecision: "deny"`, which
would make the gate *stronger* than Claude Code's — projectstore does not use it
yet, and that is the obvious next step for this harness.

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

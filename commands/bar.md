---
description: The band above the prompt — this session's epic, its progress, its story and its ProjectStore agents. Switch it on or off, pin an epic for sessions with none, or ask why it is not drawing.
argument-hint: "on | off | status | epic [<ID>]"
---

You are managing the band above the prompt through the core's `band` verb. The band is drawn by the plugin's hooks module; it shows this session's epic (from this session's own state), how far that epic is, its goal, this session's story and the ProjectStore agent at work. While it draws, the status line gives way to it, and it comes back within 30 s of the band stopping. Never edit `.projectstore/projectstore.json` yourself: the verb is the one writer of its `band` keys, and writes atomically.

Read `$ARGUMENTS`: `on`, `off`, `status`, `epic <ID>`, or `epic` alone (releases the pin). Nothing, or anything else, is `status`.

## status — read-only

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" band status --project "${CLAUDE_PROJECT_DIR}"
```

Relay its lines. Exit 3: the project is not bound — tell the user to run `/projectstore:bind <vault-path>` and stop. When it says the band is not drawing, the reason is one of: switched off; this session has no epic and none is pinned; the pinned epic no longer exists; the module is not drawing (the host has modules switched off, an older Claude Code, or a crashed module — the status line keeps its own line then); a harness without a band.

## on, off, epic

1. **Ask** via AskUserQuestion, naming the change — "Switch the band off?", "Switch the band on?", "Pin the band to `<ID>` for sessions with no epic of their own?", or "Release the pinned epic?" — **Yes** / **No**. On **No**, stop: nothing is written.

2. **Write**, on **Yes**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/projectstore.mjs" band <on|off|epic> [<ID>] --json --project "${CLAUDE_PROJECT_DIR}"
   ```

   The question above is the confirmation; `--json` never asks again. Report `result.band` and whether `result.wrote`. Exit 1 is a refusal — an unknown epic id (the message names the existing ones), or a binding that is not valid JSON: relay it. The band follows within a few seconds; no restart.

A pin shows only in a session that has no epic of its own: a session working on an epic always shows that one.

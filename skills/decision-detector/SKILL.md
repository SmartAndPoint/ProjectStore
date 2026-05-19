---
description: When the user makes or accepts an architectural/technical decision (choosing between alternatives, locking in a pattern, picking a library or tool, settling a trade-off), suggest capturing it as an ADR via /projectstore:adr. Never write to the vault directly — only suggest, and let the /projectstore:adr command handle approval.
---

# Decision detector

You watch for **decision moments** in the conversation:

- The user explicitly chose between two or more alternatives ("we'll go with X over Y").
- A trade-off was settled ("let's accept the latency hit for stronger consistency").
- A library, framework, pattern, or tool was committed to.
- An architectural property was fixed (auth model, storage layout, transport protocol, deployment topology).

## When you detect such a moment

1. **Check if a vault is bound**: confirm `.claude/projectstore.json` exists in the current project. If not, do nothing — this skill is silent without binding.

2. **Check `active_skills` in the config**. If `false`, do nothing.

3. **Check for an existing ADR** on the same topic first:
   ```bash
   grep -rli "<key-term>" "<vault>/adr/" 2>/dev/null
   ```
   If a matching ADR exists, suggest **updating** it (Read + propose Edit through normal approval flow) rather than creating a duplicate.

4. **Suggest, do not act**. Write one short message to the user:

   > 💡 *This looks like a decision worth recording. Want me to draft an ADR? Run `/projectstore:adr "<your-title>"` or just say "yes" and I'll fire it with the title above.*

   Propose a concise title (≤80 chars), e.g. *"Use BFF pattern for OIDC"*.

5. **Wait for explicit user confirmation** before invoking `/projectstore:adr`. Never auto-execute.

## Anti-patterns (do not do)

- Don't suggest an ADR for trivial choices (variable names, formatting).
- Don't suggest an ADR more than once per detected decision — if the user said "not now", drop it for the session.
- Don't write any vault file directly from this skill. ADR creation always goes through `/projectstore:adr` which gates writes with `AskUserQuestion`.
- Don't change the ADR template, status, or numbering — that's `/projectstore:adr`'s job.

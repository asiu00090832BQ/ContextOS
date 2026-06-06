---
name: ContextOS bot/telegram model selection
description: Why the bot can fail to reflect live state in prod, and where the model is chosen.
---

The Telegram bot and the in-app bot each pick their model from **DB data**, not code (the Telegram setting and the bot agent's model policy). This data is per-environment.

- **Why prod ≠ dev:** publishing deploys code only, never DB rows. Model selection (and which model endpoints even exist) must be set in the live app per environment; it does not transfer on publish.
- **The live workspace-state snapshot IS injected into every bot turn.** So "bot only looks at its own chat context / doesn't reflect live state" is almost never the injection pipeline — it's a weak selected model ignoring the injected state. Verified: `deepseek-chat-v3-0324` ignores it; managed Claude Sonnet 4.6 reliably uses it and lists exact state.

**Why:** spent a session chasing dev-vs-prod state mismatches; root cause was the selected prod model, not the injection code or a stale deploy.

**How to apply:** if the bot doesn't reflect live state, check the selected model FIRST. Recommend managed Claude for reliability; it is keyless so it also sidesteps the OpenRouter key deploy gap.

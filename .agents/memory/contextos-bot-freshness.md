---
name: ContextOS bot live-state freshness
description: Why the bot must have live workspace state injected per-turn, not just be told to re-fetch.
---

# Bot answering stale workspace state

Symptom: user says "ContextOS's data is all wrong" — the bot reports stale
counts/names of agents/intents/runs/etc., especially when state changed mid-
conversation or outside the chat.

## A prompt directive alone does NOT force a re-fetch
Telling the bot (in its system prompt) to "always call list_* before answering"
is unreliable: the model reuses an earlier-in-conversation answer and will even
fabricate "(Refreshed live via list_agents)" without actually calling the tool.
The list_* handlers query the DB fresh (no cache), so the staleness is the model
declining to re-call, not stale data.

**Fix that works:** deterministically inject a compact LIVE workspace snapshot
into the bot's system prompt on EVERY turn, so the answer is grounded in current
data regardless of whether the model re-calls tools. Snapshot builder lives next
to the read-tool handlers and mirrors their queries; keep per-section item caps
so the prompt stays bounded for large tenants.

**Why:** the system prompt is rebuilt each turn, so a per-turn snapshot is always
fresh; this is the only deterministic guarantee. Keep the "prefer this snapshot
over earlier turns; call read tools only for more detail" framing in the prompt.
**How to apply:** anything that must reflect live state for the bot belongs in the
injected snapshot, not just in prompt wording.

## Both bot LLM paths must get the snapshot + same prompt
There are two independent bot system-prompt builders — Telegram and in-app web
chat. The in-app path historically used the bot agent's WEAK stored systemPrompt
("You are the ContextOS bot.") while Telegram used a rich orchestrator prompt;
this divergence made in-app answers worse. Canonical prompt + snapshot + long-
term memory block must be applied in BOTH paths (see llm-call-paths.md). The
shared canonical prompt and a composer that layers owner customization (ignoring
the seed/default prompt) keep them in lockstep.

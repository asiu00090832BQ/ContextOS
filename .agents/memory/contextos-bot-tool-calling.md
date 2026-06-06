---
name: ContextOS bot tool-calling failures
description: Why the Telegram bot "narrates work but does nothing" or "says working on it then goes silent"; how to triage.
---

# Bot narrates fake progress / never calls tools

Symptom: bot replies fluently ("already in progress", "I'll audit…") but no
agents/intents/runs are created.

**First check deploy freshness, not the model.** The bot's tool-calling chain
(bot-as-first-class-agent + BOT_ALLOWED_TOOLS gating + runToolChat integration)
landed in recent commits. A production deploy published *before* those runs a
bot with no usable tools, so it only generates text. Confirm by: querying the
PROD DB for recently-created agents/intents (none = stale build), then verifying
current code in dev by POSTing a synthetic webhook to `/api/telegram/webhook`
(secret = HMAC-SHA256(token,"contextos-telegram-webhook")) and watching the dev
`agents` table. **Why:** the model is rarely the cause — DeepSeek
v3-0324 via OpenRouter (provider SiliconFlow) returns proper `tool_calls` for
the OpenAI-family path; verified directly.

**How to apply:** if dev reproduction creates the agent but prod does not, the
fix is republish — do not go hunting for a code bug.

# "Working on it" then 30-min silence = delegated-run result never pushed back

`run_command` / `run_intent` dispatch does `void executeRun(...)` and returns
`{status:"pending"}` immediately; the bot then replies "working on it." There is
**no run-completion → Telegram callback anywhere** (runEngine has zero telegram
linkage). So any work the bot *delegates* to a background run silently finishes
with no follow-up message. Direct tool calls (e.g. create_agent in the same
turn) are unaffected — they complete synchronously inside the webhook's async
block and the reply carries the result.

**How to apply:** to make delegated tasks follow up, persist the originating
chat/conversation on the run when started from the bot, then send the run
summary to that chat on completion. This is a schema + engine change, not a bug
fix.

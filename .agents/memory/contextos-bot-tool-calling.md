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

# "Working on it" then silence = delegated-run result pushed back via run.telegram_chat_id

Delegated work runs async (`run_command`/`run_intent` do `void executeRun(...)`
and return `pending`), so the bot replies "working on it" and the run finishes
later. The follow-up mechanism: bot-originated runs persist the originating chat
in `runs.telegram_chat_id` (threaded via the `ToolCaller` bot variant's
`telegramChatId`), and `notifyTelegramOfRunOutcome(tenantId, runId)` in runEngine
re-reads the run on every terminal transition and best-effort `sendMessage`s the
outcome to that chat. Null `telegram_chat_id` (web-UI runs) is skipped. Direct
tool calls (e.g. create_agent) are synchronous and unaffected — their result
rides the normal webhook reply.

**Why:** without this, delegated runs end silently (the original 30-min-silence
report).

**How to apply:** the notifier must be invoked from EVERY path that drives a run
to a terminal status, or that path goes silent again. Known paths wired:
executeRun (completed/failed/waiting_approval), resumeFinalizeNode (post-approval
completed), resumeRun catch (failed), and the routes that set status directly —
run cancel (cancelled) and approval deny (failed). Any NEW terminal status setter
must call `notifyTelegramOfRunOutcome`, and any new terminal status string must
get a branch in the notifier (it returns silently for unhandled statuses).

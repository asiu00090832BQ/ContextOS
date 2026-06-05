---
name: ContextOS bot as first-class agent
description: How the ContextOS bot is modeled as a restricted agent with its own memory partition, and the caching trap when editing its policy.
---

# ContextOS bot = restricted first-class agent

The conversational ContextOS bot is a reserved agent row ("ContextOS Bot",
role router, `metadataJson.isSystemBot=true`) bootstrapped in `lib/context.ts`
and exposed as `botAgent` on the owner context. Its identity is reused across
every surface (Telegram, web Chat, `/mcp`).

## Command-only restriction is fail-closed by caller kind
Tool access is gated by a `ToolCaller` discriminant in `lib/mcpServer.ts`. For
`caller.kind === "bot"`: `listToolsForTenant` filters to `BOT_ALLOWED_TOOLS`
(orchestration + own-memory only) and `callTool` has a TOP guard that throws for
any non-allowed tool BEFORE the switch. Telegram (`telegramEngine.ts`) and
`/mcp` (`routes/mcp.ts`) pass the bot caller; `runEngine` passes NO caller so
agents inside runs keep full access. **Why:** the bot must never execute work
itself — it only commands agents via intents (`run_intent`/`run_command` is
allowed and acceptable). **How to apply:** any NEW surface that lets the bot
call tools must thread a bot `ToolCaller`; never widen `BOT_ALLOWED_TOOLS` to
include action/constructed/dynamic-capability tools.

## Memory partition keyed on agentId
`working_memories.agent_id` (nullable FK) partitions memory. `remember` writes
`agentId=botId` for bot callers; tenant-shared memory is `agentId IS NULL`.
`loadOwnedLongTermMemories(tenantId, agentId, includeShared, limit)` is the one
read helper; `includeShared = contextPolicy !== "isolated"`. The `/bot/*` routes
mutate ONLY rows scoped to `tenantId + agentId=botId`.

## Stale-cache trap
`getContext()` caches the full `botAgent` row, and Telegram reads
`botAgent.contextPolicy` when building the long-term memory block. After
`PUT /bot/policy` updates the DB, that cached policy is STALE until restart.
**Fix:** call `clearContextCache()` at the end of the policy update handler.
**How to apply:** any handler that mutates the bot agent row (policy, prompt)
must invalidate the context cache, or cached runtime paths use old values.
`recall_memories` already re-reads policy fresh from DB, so only the cached
Telegram path was affected — but treat the cache as authoritative for all
botAgent fields and invalidate on every write.

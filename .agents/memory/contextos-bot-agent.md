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

## Concierge "never acts itself" needs TWO layers, not one
The bot-as-concierge rule (create/delegate to agents, never do work itself) must
be enforced at two independent places — the tool allow-list alone is NOT enough:
1. **Tool layer** — `BOT_ALLOWED_TOOLS` + bot-caller TOP guard (above).
2. **Run workforce layer** — `runEngine` builds `workforce` from active agents and
   picks lead as `workforce.find(role==='lead') ?? workforce[0]`. The bot is the
   earliest-created agent, so without a guard it lands in `workforce[0]` and
   becomes lead → it executes the run itself. Fix: filter `isSystemBot` out of the
   workforce (alongside the existing `verifier`/QA exclusion).
**Why:** a delegated run can route back to the bot by *identity* even though the
bot never directly called an action tool — the allow-list permits `run_command`,
but the orchestrator chooses who runs it. **How to apply:** any change to lead/
worker selection in `runEngine` must keep `isSystemBot` agents out of the
workforce; verify with `agent_runs` (bot must never appear) + `runs.lead_agent_id`
(never the bot id) after a delegated run.

## Deleting an agent: protect the bot + clear non-cascading memories
`delete_agent` (tool) and any agent-deletion path must (1) refuse to delete the
system bot — guard on `metadataJson.isSystemBot === true` (rename-proof), with
name === "ContextOS Bot" only as a legacy fallback; and (2) explicitly delete
`working_memories` rows for `(tenantId, agentId)` BEFORE deleting the agent.
**Why:** `working_memories.agent_id` has NO FK cascade, so a bare
`DELETE FROM agents` orphans the agent's memories; FK-linked rows
(agent_model_policies, run participation, shared_context_grants) DO cascade.
**How to apply:** `delete_agent` lives in both `TOOLS` and `BOT_ALLOWED_TOOLS`
(bot + all agents can create/delete agents); the bare REST `DELETE /agents/:id`
does NOT clear memories or guard the bot — prefer the tool path or replicate both
steps if hardening the route.

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

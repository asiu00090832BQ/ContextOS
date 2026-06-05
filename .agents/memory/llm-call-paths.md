---
name: ContextOS LLM call paths
description: There are two independent LLM execution paths; endpoint routing changes must be applied to BOTH.
---

# Two independent LLM execution paths

ContextOS reaches model providers through **two separate code paths** that do NOT share dispatch logic:

1. **Telegram bot** → `toolChat.ts` `runToolChat()` (agentic, tool-calling loop).
2. **Agents (run engine + chat engine)** → `llm.ts` `complete()` → `callProvider()` (single-shot completion, with a deterministic `stubComplete` fallback).

**Why this matters:** Any change to "how an endpoint is routed to a provider" (new provider type, a managed/keyless sentinel, auth handling, base-URL logic) must be implemented in **both** places or it silently works in one surface and not the other. A reviewer caught exactly this: a managed-Anthropic sentinel added only to `runToolChat` made the endpoint work for the bot but fall through to the stub for agents.

**How to apply:** When wiring a new endpoint/provider behavior, grep for both `runToolChat` (toolChat.ts) and `complete(` / `callProvider` (llm.ts) and update both. The managed sentinel (`MANAGED_ANTHROPIC_REF = "managed://replit-anthropic"`, defined in toolChat.ts) is the shared marker; `llm.ts` imports it to avoid string drift. `resolveSecret()` returns null for any non-`secret://` ref, so a managed endpoint has no API key — its routing branch must short-circuit the `requiresApiKey` stub guard.

# Which model each surface uses (two separate selectors)

The "ContextOS assistant" picks its model differently per surface, and **both must be set** to make the assistant run on a given endpoint:
- **Web Chat** → `chatEngine.resolveConversationAgent()` resolves the conversation's agent (no explicit agentId now defaults to the **bot agent**), then `resolveAgentModel(agent)` reads that agent's row in **`agent_model_policies`**. No policy row ⇒ stub.
- **Telegram** → `resolveTelegramEndpoint()` reads `tenants.settingsJson.telegramModelEndpointId`; unset ⇒ managed-Anthropic default (it does NOT consult `agent_model_policies`).

**Config surfaces:** users set per-agent model via `PUT /agents/:id/model-policy` (agent-detail UI) and Telegram model via its settings UI. The bot can self-configure via MCP tools `list_model_endpoints` + `set_agent_model` (both in `BOT_ALLOWED_TOOLS`). `secretStore` lives at the api-server cwd: `artifacts/api-server/.local/state/model-secrets.json`.
**Caveat:** `agent_model_policies` has no unique constraint on `(tenant_id, agent_id)`; both the route and `set_agent_model` do select-then-upsert, so concurrent writes could duplicate (reads take the first row).

**Tool-calling is NOT in web Chat:** the web Chat path (`chatEngine` → `complete()`) is single-shot text only — it never invokes MCP tools. Tool execution (e.g. `create_agent`, `set_agent_model`, `create_intent`) happens only through the Telegram bot loop (`toolChat.runToolChat`) and the `/mcp` JSON-RPC endpoint (bot caller, gated by `BOT_ALLOWED_TOOLS`). So "ask the assistant in web Chat to do X" produces prose, not an action; to actually run a tool use Telegram or an MCP client. Adding a new agent-facing capability = define it in `TOOLS`, add a `callTool` case, and (for the bot) add it to `BOT_ALLOWED_TOOLS`.

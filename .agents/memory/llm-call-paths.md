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

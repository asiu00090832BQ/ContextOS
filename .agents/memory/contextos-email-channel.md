---
name: ContextOS email channel (AgentMail)
description: How the two-way email bot channel works and the non-obvious decisions behind it (mirrors Telegram).
---

# ContextOS email channel

Email is just another inbox into the SAME ContextOS Bot — it reuses the bot agent's
model/tools/memory/orchestration-only guardrails exactly like Telegram. `emailEngine.ts`
mirrors `telegramEngine.ts` (same `getContext().botAgent`, `resolveAgentModel`, `runToolChat`
loop, `buildLongTermMemoryBlock`, and `{ kind: "bot", agentId, emailThreadId }` caller).

## AgentMail via Replit Connectors proxy
Provider is AgentMail, reached through `new ReplitConnectors().proxy("agentmail", path, {method,headers,body})`
(`lib/agentmail.ts`) — there is NO AgentMail API key in env. **The proxy returns 401 "No connection
found" until the connection is bound to this Repl via `proposeIntegration("connection:conn_agentmail_…")`**
(addIntegration alone is not enough — see integrations skill: addIntegration = code wiring,
proposeIntegration = platform-side binding). So `isAgentMailConnected()` returns false (status panel
shows "not connected") until binding is done.

## Webhook secret IS stored (unlike Telegram)
Telegram derives its webhook secret from the bot token, but AgentMail webhooks are Svix-signed and the
per-webhook `secret` (`whsec_…`) is returned by AgentMail at webhook-creation time — there is no single
token to derive from. So it is persisted in `email_config.webhook_secret` (a signing key, not a user
credential). **Why:** inbound verification needs it and it cannot be recomputed.

## Svix verification needs the RAW body
`verifyWebhookSignature` = base64(HMAC-SHA256(decode(whsec key), `${svix-id}.${svix-timestamp}.${rawBody}`)),
constant-time compared against any `v1,<sig>` entry in `svix-signature` (space-separated), PLUS a ±5min
`svix-timestamp` freshness check (replay resistance). Requires the byte-exact body, so `app.ts` adds a
`express.json({ verify })` hook stashing `req.rawBody`. The webhook router is mounted OUTSIDE
`tenantContext` (authenticated solely by the signature), like the Telegram webhook.

## Allow-list = silent ignore
Only senders in `email_allowed_senders` (bare, lowercased address via `normalizeAddress`) are processed;
everyone else is dropped with NO reply (never confirm the inbox to strangers). Process only
`event_type === "message.received"` (ignore .spam/.blocked/.unauthenticated). Loop guard: skip mail
from our own inbox address. Ack 200 immediately after signature check, then process async so AgentMail
doesn't retry during the model call.

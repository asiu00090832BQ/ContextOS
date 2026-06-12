---
name: ContextOS Telegram webhook
description: Why the Telegram bot periodically "stops working" and how to restore it; webhook secret derivation; durable fix.
---

# ContextOS Telegram webhook

Telegram delivers updates to a **registered webhook URL**. ContextOS registers that URL pointing at the **ephemeral Replit dev domain** (`$REPLIT_DEV_DOMAIN`, e.g. `*.pike.replit.dev`).

**Recurring failure:** when the repl sleeps or the dev domain rotates/restarts, Telegram POSTs to the now-dead URL and gets `404 Not Found` (visible as `last_error_message` in `getWebhookInfo`). The user experiences this as "the bot stopped running my commands." `pending_update_count` may be 0 because Telegram drops after retries.

**Diagnose:** `GET /api/telegram/status` returns `{bot, webhook:{url,last_error_message,last_error_date,pending_update_count}}`. Compare `webhook.url` host to the current `$REPLIT_DEV_DOMAIN`. A bare unauthenticated `POST /api/telegram/webhook` returns **401** when the route is healthy (it requires the secret header) — 401 is GOOD, 404 means wrong URL/route down.

**Restore (operational, no code change):** `POST /api/telegram/set-webhook {"url":"https://$REPLIT_DEV_DOMAIN/api/telegram/webhook"}` (owner-auth; curl auto-bootstraps owner session). `setWebhook` uses `drop_pending_updates:true`, so this also clears the stale error state.

**Webhook secret:** there is no separate stored secret — it is derived deterministically as `HMAC_SHA256(TELEGRAM_BOT_TOKEN, "contextos-telegram-webhook")` (hex). To test the webhook end-to-end without exposing the secret, compute it in a `node -e` one-liner (env has the token) and pass it as the `x-telegram-bot-api-secret-token` header. Never print it.

**Durable fix:** point the webhook at the **published deployment** URL (stable `.replit.app`) instead of the dev domain, so it survives dev sleeps/rotations. The deployed api-server runs the same webhook + tool loop with the same `TELEGRAM_BOT_TOKEN`. After publishing, repoint: `getDeploymentInfo().primaryUrl` + `/api/telegram/webhook` via the set-webhook admin route (or the bot client `setWebhook`).

**Deployment target MUST be VM (Reserved VM), not Autoscale.** The webhook handler ACKs Telegram with `200` immediately and then does the LLM/tool work + `sendMessage` in a fire-and-forget `void (async () => …)()`. On autoscale the instance can scale down right after the response, killing that pending async work — the bot would receive messages but never reply. VM is always-on so the async reply always completes. The machine type is chosen by the **user in the Publish dialog** — the agent cannot set `deploymentTarget` (`.replit` is edit-locked; no `deployConfig` callback exists in this env).

**Local auto-tunnel hazard:** `./run.sh` on a non-Replit host auto-opens a tunnel and registers it as the bot's webhook; it is gated to SKIP on Replit on purpose. Never run that local tunnel/webhook setup inside the Replit workspace — `TELEGRAM_BOT_TOKEN` is live there, so it would re-point the real bot's webhook at a throwaway tunnel and break it.

**Note:** Telegram already executes commands via the agentic tool loop (`handleTelegramMessage` → `runToolChat`, bot caller, `BOT_ALLOWED_TOOLS`). When the bot "won't do anything," check the webhook registration first — it is almost always delivery, not the model/tool path.

**Environment targeting (dev vs prod data confusion):** the bot reads the DB of whichever domain its webhook points at. dev and prod are **separate databases**; publishing copies code+schema but NEVER row data (agents, agent_model_policies, context_policy, model_endpoints). So edits made in the dev workspace (swap bot to Claude, create agents, change context_policy) do NOT reach a bot whose webhook points at the published `.replit.app`, and vice-versa. Symptom: "I changed the model / added an agent but Telegram shows the old model / fewer agents." Fix: either make the change in the env the webhook targets, or repoint the webhook (`set-webhook`) at the env whose DB you're editing. Bot agent is resolved by `name = BOT_AGENT_NAME` (not an `is_bot` column — prod schema has none); its model comes from `resolveAgentModel(tenantId, botAgent.id)` (single source for both in-app + Telegram since unification).

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

**Durable fix:** point the webhook at the **published deployment** URL (stable `.replit.app`) instead of the dev domain, so it survives dev sleeps/rotations. The deployed api-server runs the same webhook + tool loop with the same `TELEGRAM_BOT_TOKEN`.

**Note:** Telegram already executes commands via the agentic tool loop (`handleTelegramMessage` → `runToolChat`, bot caller, `BOT_ALLOWED_TOOLS`). When the bot "won't do anything," check the webhook registration first — it is almost always delivery, not the model/tool path.

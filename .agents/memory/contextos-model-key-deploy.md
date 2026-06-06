---
name: ContextOS model-key deployment gap
description: Why model-endpoint API keys 401 in production and how key resolution must work for deployments.
---

# ContextOS model-endpoint keys in deployments

Model-endpoint API keys are kept OUT of DB rows: the row holds an opaque
`secret://<uuid>` ref and the raw value lives in a **local gitignored file store**
(`.local/state/model-secrets.json`, path overridable via `MODEL_SECRET_STORE_PATH`).

**The trap:** that file never ships to a published deployment. In production the DB
ref resolves to nothing → empty Bearer key → the provider rejects it. With OpenRouter
this surfaces as `provider 401: {"error":{"message":"No cookie auth credentials found","code":401}}`.
The bot's user-facing symptom is the generic "Sorry, I couldn't reach the configured model" reply.

**Resolution rule:** never resolve an endpoint key with bare `resolveSecret(endpoint.apiKeyRef)`.
Use `resolveEndpointApiKey(endpoint)` (secretStore.ts) — file store first, then a
per-provider **environment secret** fallback (`openrouter → OPENROUTER_API_KEY`,
`openai → OPENAI_API_KEY`, etc.). Deployments get the key by setting that env secret
(global/shared so it exists in prod). Any NEW endpoint key-resolution call site must use
this helper. `resolveSecret` is still correct for the Telegram **bot token** (telegram.ts)
and the web-tool **credentialRef** (webTools.ts) — those are not model endpoints.

**Why:** keeps the dev workflow (file store) intact while making deployments work via
env secrets, without writing raw keys into the DB or the prod DB.

**Caveat (single-user, accepted):** the env fallback is keyed only by `providerType`,
not by a trusted host, so the shared env key would be sent to ANY same-provider endpoint
regardless of its `baseUrl`/`host`. Acceptable here because only the owner creates
endpoints; harden (restrict fallback to default provider hosts) if multi-user.

**Managed Anthropic sentinel unaffected:** `apiKeyRef === MANAGED_ANTHROPIC_REF`
(`managed://…`) is short-circuited in both `llm.complete()` and `toolChat.runToolChat()`
before key resolution and routes through the managed proxy (no key needed).

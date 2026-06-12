---
name: ContextOS startup auto-provisioning (two-step run)
description: How a fresh clone runs an agent in two steps — boot-time schema apply + bot-model auto-provision from an env key — and why Azure/openai_compatible are excluded.
---

# Startup auto-provisioning (run an agent in two steps)

Goal: running an agent must require only (1) set values in root `.env`, (2) start the
API server. No manual `db push`, `seed`, or model-endpoint/policy setup.

Implementation lives in `artifacts/api-server/src/lib/provisioning.ts`, wired into
`index.ts` `prepare()` which runs `ensureSchema()` → `bootstrapContext()` →
`ensureBotModel()` before `listen`, then `ensureTelegramWebhook()` after.

## Schema apply on boot
`ensureSchema()` is development-only (`NODE_ENV !== "production"`) and spawns the existing
`pnpm --filter @workspace/db run push-force` child process (same drizzle config, which loads
root `.env`). Opt-out: `CONTEXTOS_SKIP_DB_PUSH=1`. Failures are logged and boot continues —
a genuinely missing schema then surfaces as a clear query error, not a crash.
**Why a child process / push, not migrations:** the project has NO SQL migrations; schema is
applied via `drizzle-kit push` only.

## Bot-model auto-provision
`ensureBotModel(tenantId, botAgentId)` is idempotent + non-destructive:
- No-ops if the bot's `agent_model_policies` row already has a `primaryEndpointId`.
- Otherwise picks the first provider whose key is present, in precedence order
  **OpenAI > Anthropic > Google > OpenRouter**, creating a `model_endpoints` row with
  `apiKeyRef = null` (key resolved at call time from the matching env var by
  `resolveEndpointApiKey`, so nothing is stored) and attaching it to the bot policy.
- Dedupes the endpoint by its stable name (`"<Label> (from .env)"`) so repeated boots never
  duplicate.
- Fallback when no key is set but on Replit dev (`REPL_ID`): keyless managed Anthropic
  (`MANAGED_ANTHROPIC_REF`/`MODEL`). Never provisions managed in production.

**Why Azure OpenAI and openai_compatible are NOT in the keyless precedence:** they cannot be
provisioned from a key alone — Azure needs a resource endpoint + deployment + api-version, and
openai_compatible requires a Base URL. Auto-creating one with no base URL would silently point
at `api.openai.com` and break. They remain UI-configured providers (documented as such in
README/.env.example), and their env vars act only as fallback keys for endpoints created in the UI.

## Verifying the auto-provision path safely
To test without losing the user's config: capture the bot policy's `primary_endpoint_id`, set it
to NULL, restart the api-server, confirm a `"<Provider> (from .env)"` endpoint was created and
attached, then restore by setting `primary_endpoint_id` back and deleting the test endpoint, and
restart again. A clean boot with the policy already set shows no "Auto-provisioned" log line
(skip path) — that absence is the non-destructive proof.

## Docs/port reconciliation
README/.env.example/replit.md were rewritten to the two-step Quickstart; the API server PORT
defaults to **8080** (older docs said 5000). Env precedence: vars already in the environment win
over `.env`, so platform-injected secrets are never overridden (on Replit a `.env` is usually
unnecessary).

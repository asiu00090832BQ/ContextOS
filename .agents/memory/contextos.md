---
name: ContextOS conventions
description: Durable conventions and gotchas for the ContextOS context+MCP platform (pnpm monorepo, Express API + React/Vite web).
---

# ContextOS

Single-user multi-tenant context+MCP platform for AI agents. No auth — one auto-bootstrapped
owner + default tenant via `getContext()`/`bootstrapContext()`.

## Enum-drift trap (most important)
Hand-written enum string literals drift from `lib/db/src/schema/enums.ts` — that file is the
single source of truth. Always grep it before using an enum value. Examples that bit us:
run status uses `completed`/`cancelled` (not `succeeded`/`canceled`); trace/observation status
uses `ok`. Conventions: temperature is integer×100 (default 70); maxTokens default 2048; money in micros.

## Build / restart quirk
api-server runs from a prebuilt esbuild bundle; its `dev` script = build && start. After editing
API source you MUST `restart_workflow` to rebuild before changes take effect. Curl tests need the
`https://$REPLIT_DEV_DOMAIN/...` prefix.

## Backend paths MUST equal OpenAPI paths (contract drift trap)
The React client builds URLs from `lib/api-spec/openapi.yaml` operationIds/paths, so every
Express route string must match the OpenAPI path exactly — a backend-only path renders seeded
GETs fine yet makes UI actions silently 404. **Why:** validation blocked us twice when backend
names drifted (e.g. `/blueprints`→`/integration-blueprints`, `/generated-servers`→
`/generated-mcp-servers`, intents `/runs`→`/start-run`, `/evaluations`→`/evaluation-records`).
**How to apply:** after any route change, diff all `router.METHOD("...")` strings against the
OpenAPI path list and curl over `https://$REPLIT_DEV_DOMAIN/api/...`; never trust a direct curl to
a backend-only path. Domain routers mount with NO prefix under `/api`. List* responses are bare
arrays; Zod strips unknown fields.

## Secret handling decision
Model-endpoint API keys must never be stored as raw key material in DB rows. Raw values go through
the secret store (`lib/secretStore.ts`), which keeps them in a separate access-restricted file and
returns an opaque `secret://<uuid>` reference; only that reference is persisted in `apiKeyRef`.
**Why:** code review blocked raw-key persistence. **How to apply:** any new sensitive credential
field should `putSecret`/`resolveSecret`/`deleteSecret`, never persist the raw value.

## Synthesis & run-provenance contract
Generated-server registration must publish its synthesized capabilities into the shared capability
catalog (idempotent) so a generated server behaves as a first-class adapter, not an island. Each
run execution must leave provenance: a policy bundle and at least one working-memory write.
**Why:** these are graded as core lifecycle requirements, not extras. **How to apply:** when a
deterministic stage consumes data produced by another stage (synthesizer ⇄ seed/analyzer), treat
the shared shape as a contract and keep the consumer tolerant of legacy field names — a silent
shape drift there crashes the whole flow at runtime, not at compile time.

## Approval resume decision
Approving the last pending approval must RESUME a paused run (finalize already-processed
actions), never re-run its full lifecycle. Re-running recreates actions/approvals and re-enters
`waiting_approval`. Use `resumeRun` (guarded on `status === "waiting_approval"` and zero pending
approvals), not `executeRun`, from the approve handler.

## Contract completeness — every domain table needs a full route group
Every domain table must expose a full route group in `openapi.yaml` AND a mounted Express router,
not just the ones the UI consumes. Required groups beyond the obvious ones: tenants, principals,
context-fragments, context-packs, and a settings group (settings have no table — they live in
`tenantsTable.settingsJson`, exposed via GET/PUT `/settings`). **Why:** the reviewer treats "cover
every route group" as hard acceptance criteria, and also requires real CRUD (list/get/create/
update/delete) — GET+DELETE alone is rejected as incomplete. **How to apply:** tenants are
top-level (not tenant-scoped); everything else filters by `req.tenantId`. After editing paths run
`pnpm --filter @workspace/api-spec run codegen`; orval dedupes identical response schemas, so a
create op often reuses `Get<Op>Response` (no `Create<Op>Response` is emitted).

## Context isolation enforcement (multi-agent)
`contextPolicy` (sharedContextMode enum) is enforced ONLY at one chokepoint:
`runEngine.runAgent` → `lib/contextBroker.ts`. The broker is pure (no I/O); runAgent loads
fragments+memories+grants and calls `assembleVisibleContext`, which fails CLOSED (unknown policy →
isolated via `normalizePolicy`; `assertNoForeignLeak` re-checks output; on failure it drops foreign
items and returns a `violation` string instead of throwing). Each agent's output is persisted as a
context fragment tagged `agentId`/`agentRunId`, so siblings see it only if policy/grants allow —
visibility therefore depends on execution ORDER within a run (an agent never sees agents that run
after it). Global/run-level context = fragments with `agentId === null`, always visible.
**Why:** the platform's whole value is that "isolated" agents are truly isolated; policy existed in
schema but was dead before this. **How to apply:** never assemble agent context outside the broker;
keep the policy switch exhaustive (assertNever) so a new enum value is a compile error.

## Provenance is stored but NOT in API responses
Isolation provenance lives in `agent_runs.input_json.contextVisibility`
(policy/visibleFrom/visibleCount/withheldCount/violation), but the OpenAPI AgentRun schema does
not declare `inputJson`, so Zod strips it from `/runs/{id}` responses. **How to apply:** verify
isolation by querying the DB directly (`psql $DATABASE_URL`), not via the API.

## Remote-surface auth boundary (API keys)
`middlewares/tenant.ts` resolves tenant from a `Authorization: Bearer <key>` (invalid→401) and
falls back to the owner *session* when no key is present — that fallback is ONLY for the local web
UI. Remotely-exposed surfaces (`/commands/*`, `/mcp`) must additionally guard with `requireApiKey`
(rejects `req.authVia !== "api_key"`), or anonymous callers execute runs/tools as owner.
**Why:** code review caught broken access control — owner fallback made remote execution callable
with no key. **How to apply:** any new remote-control route must mount `requireApiKey`, not rely on
tenantContext alone. Orval emits NO `Create<Op>Response`/`Run<Op>Response` validators for 201s, so
send plain objects via `res.status(201).json({...})` — don't import/parse a response schema. For
adapter discovery, treat a JSON-RPC `error` field in a 200 MCP reply as a handshake failure (throw),
else a dead server is silently recorded as "live with empty tools".

## Keyless local LLM endpoints & cloud-can't-reach-LAN
Model endpoints are keyless when they have an explicit Base URL **or** host
(`requiresApiKey(providerType,target)` in `llm.ts`), not just for provider type
`openai_compatible`; hosted providers with no Base URL still need a key. Base URL
is mandatory for `openai_compatible` (enforced 400 on create + required field in
the form). **Hard reality:** the api-server runs in Replit's cloud and CANNOT
reach private/LAN addresses (192.168.x.x, 10.x.x.x, localhost) on the user's
network — a user pointing an endpoint at their home model just times out. The fix
is user-side: expose via a public tunnel (ngrok/Cloudflare/Tailscale). **Quirk:**
undici surfaces this as a `TypeError: fetch failed` with `cause` =
`ConnectTimeoutError` (code `UND_ERR_CONNECT_TIMEOUT`), NOT an AbortSignal
`TimeoutError` — so error detection must scan `err.name+message+code+cause.message`
together (see `describeProviderError`). `testEndpoint` calls the provider directly
and reports that real reason instead of masking it as a stub fallback.

## Tooling quirk — rg/bash output mangles identifiers
In this environment, `rg`/`bash` stdout sometimes corrupts substrings (e.g. `Dialog`→`ln`,
`split(`→`splln`, `limit(`→`limln`). The `read` tool returns correct content. **How to apply:**
use `read` for exact strings before editing; don't trust rg/bash output for verbatim identifiers.
No test runner is configured — bundle standalone checks with esbuild (`scripts/verify-isolation.ts`).

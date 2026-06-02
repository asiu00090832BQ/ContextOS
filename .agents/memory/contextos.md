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

## Approval resume decision
Approving the last pending approval must RESUME a paused run (finalize already-processed
actions), never re-run its full lifecycle. Re-running recreates actions/approvals and re-enters
`waiting_approval`. Use `resumeRun` (guarded on `status === "waiting_approval"` and zero pending
approvals), not `executeRun`, from the approve handler.

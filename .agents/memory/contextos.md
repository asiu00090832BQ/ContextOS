---
name: ContextOS conventions
description: Durable conventions and gotchas for the ContextOS context+MCP platform (pnpm monorepo, Express API + React/Vite web).
---

# ContextOS

Single-user multi-tenant context+MCP platform for AI agents. No auth — one auto-bootstrapped
owner (`owner@contextos.local`) + default tenant via `getContext()`/`bootstrapContext()` in
`artifacts/api-server/src/lib/context.ts`.

## Enum-drift trap (most important)
Hand-written enum string literals drift from `lib/db/src/schema/enums.ts` — that file is the
single source of truth. Always grep it before using an enum value. Examples that bit us:
run status uses `completed`/`cancelled` (not `succeeded`/`canceled`); trace/observation status
uses `ok`; orchestrationMode is `static_graph`|`dynamic_delegation`; adapter/account/endpoint
status is `active`. temperature is integer×100 (default 70); maxTokens default 2048; money in micros.

## API route mounting
Domain routers in `artifacts/api-server/src/routes/index.ts` are mounted with NO path prefix
(`router.use(integrationsRouter)`), so synthesis paths are `/api/blueprints`,
`/api/generated-servers`, `/api/deployment-targets` — NOT under `/api/integrations/...`.
Health is `/api/healthz`; memory is `/api/memory`; traces `/api/traces`. List* responses are
bare arrays. Zod strips unknown fields.

## Build / restart quirk
api-server runs from prebuilt `dist/index.mjs` (esbuild via build.mjs); its `dev` script =
build && start. After editing API source you MUST `restart_workflow` to rebuild. Test endpoints
with `curl -s "https://$REPLIT_DEV_DOMAIN/api/..."` (needs https:// prefix).

## Web routing
React app (artifact `contextos`) uses wouter with `base={BASE_URL}`. Traces live at
`/observability` and `/observability/traces/:id` (there is no `/traces` route in the web app).

## Seed script
`scripts/src/seed.ts` (run `pnpm --filter @workspace/scripts run seed`). Idempotent: clears all
tenant-scoped tables in FK-safe child→parent order, then reinserts a full demo dataset incl. a
completed run with a 6-observation parent-linked trace tree. Bootstrap membership/principal
lookups must be scoped by `tenantId + userId` (not userId alone) to stay deterministic.

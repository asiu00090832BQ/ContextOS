# ContextOS

A single-user, multi-tenant context + MCP platform for AI agents: define agents, give them isolated or shared context, connect tools via MCP, construct new web-service tools, and run agents over a web UI or external channels (Telegram, email).

## Run & Operate

- Two-step Quickstart (see README): (1) set `DATABASE_URL` + one model key in root `.env`; (2) `pnpm --filter @workspace/api-server run dev`.
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080; reads `PORT`, default 8080)
- `pnpm --filter @workspace/contextos run dev` — run the web UI (Vite)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only; the API server also does this on boot)
- Required env: `DATABASE_URL` plus one model-provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Web: React 19 + Vite + Tailwind CSS
- Build: esbuild

## Where things live

- DB schema (source of truth): `lib/db/src/schema/` (`@workspace/db`)
- API server: `artifacts/api-server/src` (routes in `routes/`, business logic in `lib/`)
- Startup provisioning (schema apply, bot-model auto-provision, telegram webhook): `artifacts/api-server/src/lib/provisioning.ts`, wired in `index.ts`
- Owner/tenant/bot bootstrap: `artifacts/api-server/src/lib/context.ts`
- Web UI: `artifacts/contextos/src`
- Dev scripts (seed/clear/push-prod): `scripts/`

## Architecture decisions

- No SQL migrations: schema is applied via `drizzle-kit push`. In development the API server runs `push-force` on boot so a clone needs no manual schema step (gated off in production; opt-out via `CONTEXTOS_SKIP_DB_PUSH=1`).
- On boot the server auto-provisions the ContextOS Bot's model endpoint from the highest-precedence provider key in `.env` (OpenAI > Anthropic > Google > OpenRouter; managed Anthropic as a dev/Replit fallback). Idempotent and non-destructive — never overrides a model the user already configured.
- Model-endpoint API keys resolve from a local gitignored secret-store file first, then a per-provider env var (so deployments supply keys via env, since the local file is not shipped).
- The ContextOS Bot is a first-class agent; the in-app chat, Telegram, and email channels all share its single model policy as the source of truth.

## Product

ContextOS lets a single owner orchestrate multiple AI agents with controlled context sharing, MCP tool access, and on-the-fly integration building, driven from a web UI or via Telegram/email channels.

## User preferences

- No emojis.
- Technical, concise communication.

## Gotchas

- Provider/endpoint routing changes must be applied in BOTH LLM call paths (bot `runToolChat` in `toolChat.ts` and agent `complete` in `llm.ts`).
- Auto schema-apply on boot requires `pnpm` on PATH; it logs and continues if it can't run, so a missing schema surfaces as a clear query error rather than a crash.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

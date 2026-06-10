# ContextOS

ContextOS is a single-user, multi-tenant **context + MCP platform for AI agents**. It lets you
define agents, give them isolated or shared context, connect tools via the Model Context Protocol
(MCP), construct new web-service tools on the fly, and run agents over a web UI or external
channels (e.g. Telegram, email).

This repository is a [pnpm](https://pnpm.io/) monorepo containing the backend API, the web app,
shared libraries, and developer tooling.

## Monorepo layout

The workspace is split into deployable **artifacts** and shared **libraries**.

### Artifacts (`artifacts/*`)

| Path | Package | Description |
| --- | --- | --- |
| `artifacts/api-server` | `@workspace/api-server` | Express 5 API server (agents, runs, MCP, tools, channels). |
| `artifacts/contextos` | `@workspace/contextos` | React + Vite web app — the ContextOS UI. |
| `artifacts/mockup-sandbox` | `@workspace/mockup-sandbox` | Component preview / design sandbox (Vite). |

### Libraries (`lib/*`)

| Package | Description |
| --- | --- |
| `@workspace/db` | PostgreSQL schema and access layer (Drizzle ORM). |
| `@workspace/api-spec` | OpenAPI spec + codegen (Orval) for client hooks and Zod schemas. |
| `@workspace/api-zod` | Generated Zod validation schemas. |
| `@workspace/api-client-react` | Generated React Query client hooks. |
| `@workspace/integrations-anthropic-ai` | Anthropic AI integration helpers. |

Developer scripts (seed, clear, dev→prod sync) live in `scripts/` (`@workspace/scripts`).

## Stack

- pnpm workspaces, Node.js, TypeScript 5.9
- API: Express 5
- Database: PostgreSQL + Drizzle ORM
- Validation: Zod
- API codegen: Orval (from the OpenAPI spec)
- Web: React 19 + Vite + Tailwind CSS
- Build: esbuild

## Prerequisites

- **Node.js** (Node 24 recommended)
- **pnpm** — this repo enforces pnpm via a `preinstall` check; npm and yarn are rejected.
  Install it with `npm install -g pnpm` or `corepack enable`.

## Install

From the repository root:

```bash
pnpm install
```

### Environment

The API server requires a Postgres connection string:

- `DATABASE_URL` — Postgres connection string

Set this in your environment before running the API server. Do not commit secret values.

## Running in development

Each artifact has its own dev script. Run them from the repository root with `--filter`:

```bash
# API server
pnpm --filter @workspace/api-server run dev

# Web app (ContextOS UI)
pnpm --filter @workspace/contextos run dev

# Component preview / design sandbox
pnpm --filter @workspace/mockup-sandbox run dev
```

## Useful workspace commands

```bash
# Full typecheck across all packages
pnpm run typecheck

# Typecheck + build all packages
pnpm run build

# Regenerate API client hooks and Zod schemas from the OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Push DB schema changes (dev only)
pnpm --filter @workspace/db run push
```

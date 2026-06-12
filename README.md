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

## Initialization guide

This is the end-to-end path from a fresh checkout to a working ContextOS workspace with
agents, model endpoints, and (optionally) the Telegram and email channels, web tools, and
agents that can build their own MCP integrations.

The steps are ordered. The minimum to get a usable workspace is steps 1–4; the channels and
web tooling in steps 5–8 are optional and can be enabled at any time.

### 1. Configure credentials and secrets

ContextOS reads all credentials from environment variables — never commit secret values to the
repository. Depending on where you run it, those variables come from one of three places:

- **Local / GitHub clone** — a `.env` file in the repository root (see
  [Setup from a GitHub clone](#setup-from-a-github-clone) below). The API server and the
  `seed` / `clear` / `push` / `push-prod` commands load it automatically.
- **Replit** — the Secrets pane. `DATABASE_URL` is provided automatically; add the rest as needed.
- **Other hosted deployments** — that platform's environment / secret manager.

Variables already present in the environment always take precedence over the `.env` file, so a
platform's injected secrets are never overridden.

**Required**

- `DATABASE_URL` — Postgres connection string. The API server will not start without it.
- `PORT` — the port the API server listens on. Replit and most hosts inject this automatically;
  set it yourself only for a local/GitHub-clone run (the template defaults to `8080`).

**Optional — channels and web tools**

- `TELEGRAM_BOT_TOKEN` — the token from BotFather. Enables the Telegram channel (step 6). The
  Telegram webhook secret is **derived** from this token (HMAC) and is never stored separately,
  so there is no second variable to set.
- `FIRECRAWL_API_KEY` — enables the built-in web tools (scrape, search, map, crawl; step 7).
  When unset, the web tools are present but report themselves as unavailable rather than failing
  mid-task.
- `FIRECRAWL_API_BASE` — optional override for the Firecrawl API host (defaults to
  `https://api.firecrawl.dev`).

> The email channel (step 5) uses the **AgentMail** Replit connector and has **no** API-key
> environment variable — it is authorized through the connector, not a secret you set here.

**Optional — model-endpoint API keys (deployments)**

Model-endpoint API keys are normally entered through the UI and kept in a local, gitignored
secret-store file (`MODEL_SECRET_STORE_PATH`, default `.local/state/model-secrets.json`). That
file does **not** ship to a deployment, so in production an endpoint resolves its key from a
per-provider environment secret instead. Set whichever you use:

| Provider | Environment secret |
| --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google (Gemini) | `GEMINI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` |

An endpoint resolves its key from the file store first, then falls back to the matching
per-provider environment secret. The managed Anthropic endpoint (see step 3) needs no key at all.

**Optional — operational**

- `MODEL_SECRET_STORE_PATH` — where model-endpoint keys are stored locally (see above).
- `LOG_LEVEL` — logger verbosity.
- `NODE_ENV` — `development` / `production`.

#### Setup from a GitHub clone

If you cloned this repository outside Replit, copy the committed template and fill in your values:

```bash
cp .env.example .env
# then edit .env and set at least DATABASE_URL and PORT
```

The API server and the `seed` / `clear` / `push` / `push-prod` commands read this root `.env`
automatically — you do not need to export each variable by hand. `.env` is gitignored, so your
secrets stay out of version control. From here, continue with steps 2–4 to bootstrap the database,
start the services, and configure model endpoints.

### 2. Bootstrap the database

Apply the Drizzle schema to the database named in `DATABASE_URL`, then seed the initial
single-user tenant, the system **ContextOS Bot** agent, and starter data:

```bash
# Create / update all tables from the Drizzle schema (dev)
pnpm --filter @workspace/db run push

# Seed the tenant, bot agent, and starter rows
pnpm --filter @workspace/scripts run seed
```

To wipe seeded/working data and start over, use `pnpm --filter @workspace/scripts run clear`.

### 3. Start the services and configure model endpoints

Start the API server and web app (see [Running in development](#running-in-development)), then
open the web UI.

Agents need a model. Out of the box ContextOS includes a **Managed Anthropic (Claude Sonnet 4.6)**
endpoint that requires no API key. To add your own provider, go to **Model Endpoints**
(`/model-endpoints`) and create an endpoint:

- Pick a provider: OpenAI, Anthropic, Google, OpenRouter, Azure OpenAI, or OpenAI-compatible.
- Enter the model name (the UI can list available models from the provider), and the API key.
- For self-hosted / local OpenAI-compatible servers, set a Base URL (or host/port) instead of a
  key. Note that a cloud deployment cannot reach a private/LAN address — expose such a server
  through a public tunnel and use that HTTPS URL.
- Use **Test** to confirm connectivity. Until a usable key/endpoint is configured, runs fall
  back to a deterministic stub rather than a live model.

Keys entered here are written to the local secret store in development; for deployments, supply
the per-provider environment secret from step 1.

### 4. Create and configure agents

Go to **Agents** (`/agents`) to create agents (`/agents/:id` for detail). Each agent has:

- **Role** — one of `lead`, `specialist`, `verifier`, `executor`, `summarizer`, `router`,
  `memory_manager`.
- **Context policy** — how it shares context with other agents: `isolated`, `shared_summary`,
  `shared_readonly`, `shared_full`, or `brokered`.
- **System prompt** and **description**.
- **Expose as capability provider** — lets other agents call this agent as a capability.
- **Can build integrations** — lets this agent build new MCP integrations (see step 8).
- **Model** — assign a primary (and optional fallback) endpoint, with temperature and max-tokens.

Drive work by creating an **Intent** (`/intents`) and starting a **Run** (`/runs/:id` shows
progress), or chat directly with the bot in **Chat** (`/chat`).

### 5. (Optional) Email channel

The email channel gives the ContextOS bot its own inbox via the **AgentMail** Replit connector.
There is no API key to set — the connector authorizes the requests. Until the connector is bound,
AgentMail calls return 401/403.

1. Bind the AgentMail connector to the workspace (the integration must be connected).
2. Open **Email** (`/email`) and use **Set webhook** to provision the inbox and register the
   inbound webhook. Inbound mail is verified by its Svix signature against a per-webhook secret
   stored at connect time.
3. Add approved senders to the **allow-list**. Mail from anyone not on the allow-list is
   **silently dropped** (recorded for review, but never answered, so the inbox is not confirmed
   to strangers).
4. Toggle the channel on/off with the enabled switch.

The email bot uses the ContextOS Bot agent's own model — change it on the agent, not here.

### 6. (Optional) Telegram channel

1. Set `TELEGRAM_BOT_TOKEN` (step 1) and restart the API server.
2. Open **Telegram** (`/telegram`). The status view shows whether the token is configured and the
   current webhook.
3. Use **Set webhook** to point Telegram at this server's public HTTPS URL. (Equivalent API:
   `POST /api/telegram/set-webhook` with a public `https` `url`.) The webhook must target a
   publicly reachable URL — on Replit, that is the deployed/VM URL, not the dev preview.
4. The webhook secret Telegram echoes back is derived from the bot token automatically; you do
   not set or store it.

The Telegram bot shares the ContextOS Bot agent's model (read-only here; change it on the agent).

### 7. (Optional) Web tools

Setting `FIRECRAWL_API_KEY` (step 1) enables the built-in web tools — `firecrawl_scrape`,
`firecrawl_search`, `firecrawl_map`, and `firecrawl_crawl` — for the bot and for agents. These
are a ready-made, general-purpose web capability, so you do not have to construct a per-site web
MCP just to read the web. When the key is unset, the tools advertise themselves as unavailable
instead of failing when called.

### 8. (Optional) Let agents build MCP integrations

Agents created with **Can build integrations** enabled (step 4) can teach ContextOS to use new
services on the fly:

- **Register an existing MCP server** — point ContextOS at an MCP server URL and auto-discover
  its tools (`register_mcp_server`).
- **Construct a web MCP** — for an ordinary REST/HTTP service that is not already an MCP server,
  create a constructed server with a base URL, then add HTTP tools by hand
  (`create_web_mcp_server` + `add_web_mcp_tool`) or import them from an OpenAPI spec
  (`import_openapi_tools`).

Manage connected and constructed servers in **MCP Servers** (`/servers`); the guided builder is at
`/build-mcp`. Constructed-tool fetches are SSRF-guarded and only reach private/internal addresses
when a server is explicitly created with that option enabled.

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

# Seed / clear workspace data
pnpm --filter @workspace/scripts run seed
pnpm --filter @workspace/scripts run clear
```

## Development vs. production data

Publishing ships your **code and database schema**, but **not your row data**. A deployment
starts with the schema applied but no agents, model endpoints, intents, or channel configuration —
those live as rows in each environment's own database and must be created (or synced) per
environment. Likewise, secrets do not transfer: set the per-provider model-endpoint environment
secrets (step 1) in the deployment, since the local secret-store file is not shipped.

To copy configuration (agents, policies, the bot) from development to production by name, use the
sync helper — it upserts by name over HTTP and never copies secrets, and defaults to a dry run:

```bash
pnpm --filter @workspace/scripts run push-prod
```

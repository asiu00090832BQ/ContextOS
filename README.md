# ContextOS

ContextOS is a single-user, multi-tenant **context + MCP platform for AI agents**. It lets you
define agents, give them isolated or shared context, connect tools via the Model Context Protocol
(MCP), construct new web-service tools on the fly, and run agents over a web UI or external
channels (e.g. Telegram, email).

This repository is a [pnpm](https://pnpm.io/) monorepo containing the backend API, the web app,
shared libraries, and developer tooling.

## Quickstart — run an agent in two steps

Running an agent takes exactly two steps. (One-time: install [pnpm](https://pnpm.io/) with
`npm install -g pnpm` or `corepack enable`, then run `pnpm install` from the repo root. Node 24 is
recommended.)

### Step 1 — Set values in the root `.env`

Copy the template and fill in two things: a Postgres `DATABASE_URL` and **one** model-provider key.

```bash
cp .env.example .env
# then edit .env:
#   DATABASE_URL=postgresql://user:password@host:5432/contextos
#   and ONE provider key, e.g. OPENAI_API_KEY=...  (or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY)
```

`.env` is gitignored, so your secrets stay out of version control. `PORT` is optional (defaults to
`8080`). Variables already present in the environment always take precedence over `.env`, so
platform-injected secrets (e.g. Replit's Secrets pane, where `DATABASE_URL` is provided
automatically) are never overridden — on Replit you typically do not need a `.env` at all.

### Step 2 — Run the server

```bash
pnpm --filter @workspace/api-server run dev
```

That's it. On startup the server (in development) applies the database schema, ensures the single
tenant and the **ContextOS Bot** agent exist, and auto-provisions a model endpoint for the bot from
the provider key in your `.env`. The agent will respond — no `db push`, no `seed`, and no manual
model-endpoint or model-policy setup required.

> Talk to the agent over HTTP via the chat API, or open the web UI (below) and use **Chat**.

#### Provider precedence and default models

When more than one provider key is present in `.env`, the first match in this order wins. Each
provider has a sensible default model (changeable later in the UI under **Model Endpoints**):

| Order | Provider | Env var | Default model |
| --- | --- | --- | --- |
| 1 | OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| 2 | Anthropic | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest` |
| 3 | Google (Gemini) | `GEMINI_API_KEY` | `gemini-1.5-pro` |
| 4 | OpenRouter | `OPENROUTER_API_KEY` | `anthropic/claude-3.5-sonnet` |

If no provider key is set but you are running on Replit (development), the keyless
**Replit-managed Anthropic** endpoint is used as a fallback. Auto-provisioning is idempotent and
non-destructive: once the bot has a model it is never changed automatically, so you can override
the endpoint/model/policy in the UI and it will stick.

### Run the web UI (optional)

The Quickstart above runs the agent via the API. To use the web UI as well, start it alongside the
API server:

```bash
pnpm --filter @workspace/contextos run dev
```

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

- pnpm workspaces, Node.js (Node 24 recommended), TypeScript 5.9
- API: Express 5
- Database: PostgreSQL + Drizzle ORM
- Validation: Zod
- API codegen: Orval (from the OpenAPI spec)
- Web: React 19 + Vite + Tailwind CSS
- Build: esbuild

## Running in development

Each artifact has its own dev script. Run them from the repository root with `--filter`:

```bash
# API server (this is Step 2 of the Quickstart)
pnpm --filter @workspace/api-server run dev

# Web app (ContextOS UI)
pnpm --filter @workspace/contextos run dev

# Component preview / design sandbox
pnpm --filter @workspace/mockup-sandbox run dev
```

The API server listens on `PORT` (default `8080`).

---

## Optional / advanced

Nothing below is required to run an agent — the two-step Quickstart covers that. These sections add
channels, web tooling, integration building, and operational controls.

### Environment variables (full reference)

The Quickstart needs only `DATABASE_URL` and one model-provider key. The remaining variables are
optional:

**Channels & web tools**

- `TELEGRAM_BOT_TOKEN` — the token from BotFather. Enables the Telegram channel. The Telegram
  webhook secret is **derived** from this token (HMAC) and is never stored separately.
- `TELEGRAM_WEBHOOK_URL` — a public `https` URL (e.g. `https://<your-host>/api/telegram/webhook`).
  When set together with `TELEGRAM_BOT_TOKEN`, the server registers the Telegram webhook on boot;
  otherwise use the manual path below.
- `FIRECRAWL_API_KEY` — enables the built-in web tools (scrape, search, map, crawl). When unset,
  the web tools are present but report themselves as unavailable rather than failing mid-task.
- `FIRECRAWL_API_BASE` — optional override for the Firecrawl API host (defaults to
  `https://api.firecrawl.dev`).

> The email channel uses the **AgentMail** Replit connector and has **no** API-key environment
> variable — it is authorized through the connector, not a secret you set here.

**Model-endpoint API keys**

Beyond the Quickstart's single key, you can set any of the per-provider keys below. A model
endpoint resolves its key from the local secret-store file first (set in the UI), then falls back
to the matching environment secret — which is also how deployments supply keys, since the local
store file is not shipped.

| Provider | Environment secret |
| --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google (Gemini) | `GEMINI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` |

**Operational**

- `PORT` — the API server port (default `8080`). Replit and most hosts inject this automatically.
- `MODEL_SECRET_STORE_PATH` — where model-endpoint keys are stored locally (default
  `.local/state/model-secrets.json`).
- `LOG_LEVEL` — logger verbosity.
- `NODE_ENV` — `development` / `production`. Auto schema-apply on boot runs only in development.
- `CONTEXTOS_SKIP_DB_PUSH=1` — skip the automatic schema apply on boot (development).

### Seeding demo data (optional)

The Quickstart produces a working agent with no demo rows. To load sample agents, intents, runs,
and integrations for exploring the UI, seed (and clear) the workspace:

```bash
pnpm --filter @workspace/scripts run seed
pnpm --filter @workspace/scripts run clear
```

### Configuring agents and model endpoints in the UI

- **Model Endpoints** (`/model-endpoints`) — add providers beyond the auto-provisioned one. Pick a
  provider, enter the model name (the UI can list available models) and the API key. For
  self-hosted / local OpenAI-compatible servers, set a Base URL (or host/port) instead of a key —
  a cloud deployment cannot reach a private/LAN address, so expose such a server through a public
  tunnel and use that HTTPS URL. Use **Test** to confirm connectivity.
- **Agents** (`/agents`, detail at `/agents/:id`) — each agent has a **role** (`lead`,
  `specialist`, `verifier`, `executor`, `summarizer`, `router`, `memory_manager`), a **context
  policy** (`isolated`, `shared_summary`, `shared_readonly`, `shared_full`, `brokered`), a system
  prompt, **expose as capability provider**, **can build integrations**, and a **model** (primary +
  optional fallback, with temperature and max-tokens).
- Drive work by creating an **Intent** (`/intents`) and starting a **Run** (`/runs/:id`), or chat
  directly with the bot in **Chat** (`/chat`).

### Email channel

The email channel gives the ContextOS bot its own inbox via the **AgentMail** Replit connector.
There is no API key to set — the connector authorizes the requests. Until the connector is bound,
AgentMail calls return 401/403.

1. Bind the AgentMail connector to the workspace (the integration must be connected).
2. Open **Email** (`/email`) and use **Set webhook** to provision the inbox and register the
   inbound webhook. Inbound mail is verified by its Svix signature against a per-webhook secret
   stored at connect time.
3. Add approved senders to the **allow-list**. Mail from anyone not on the allow-list is
   **silently dropped** (recorded for review, but never answered).
4. Toggle the channel on/off with the enabled switch.

The email bot uses the ContextOS Bot agent's own model — change it on the agent, not here.

### Telegram channel

1. Set `TELEGRAM_BOT_TOKEN` and restart the API server.
2. Either set `TELEGRAM_WEBHOOK_URL` to a public `https` URL so the webhook registers on boot, or
   open **Telegram** (`/telegram`) and use **Set webhook** (equivalent API:
   `POST /api/telegram/set-webhook` with a public `https` `url`). The webhook must target a
   publicly reachable URL — on Replit, that is the deployed/VM URL, not the dev preview.
3. The webhook secret Telegram echoes back is derived from the bot token automatically; you do not
   set or store it.

The Telegram bot shares the ContextOS Bot agent's model (read-only here; change it on the agent).

### Web tools

Setting `FIRECRAWL_API_KEY` enables the built-in web tools — `firecrawl_scrape`, `firecrawl_search`,
`firecrawl_map`, and `firecrawl_crawl` — for the bot and for agents, so you do not have to construct
a per-site web MCP just to read the web. When the key is unset, the tools advertise themselves as
unavailable instead of failing when called.

### Let agents build MCP integrations

Agents created with **Can build integrations** enabled can teach ContextOS to use new services on
the fly:

- **Register an existing MCP server** — point ContextOS at an MCP server URL and auto-discover its
  tools (`register_mcp_server`).
- **Construct a web MCP** — for an ordinary REST/HTTP service that is not already an MCP server,
  create a constructed server with a base URL, then add HTTP tools by hand
  (`create_web_mcp_server` + `add_web_mcp_tool`) or import them from an OpenAPI spec
  (`import_openapi_tools`).

Manage connected and constructed servers in **MCP Servers** (`/servers`); the guided builder is at
`/build-mcp`. Constructed-tool fetches are SSRF-guarded and only reach private/internal addresses
when a server is explicitly created with that option enabled.

### Useful workspace commands

```bash
# Full typecheck across all packages
pnpm run typecheck

# Typecheck + build all packages
pnpm run build

# Regenerate API client hooks and Zod schemas from the OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Push DB schema changes manually (the dev server also does this on boot)
pnpm --filter @workspace/db run push
```

### Development vs. production data

Publishing ships your **code and database schema**, but **not your row data**. A deployment starts
with the schema applied but no agents, model endpoints, intents, or channel configuration — those
live as rows in each environment's own database. Likewise, secrets do not transfer: set the
per-provider model-endpoint environment secrets in the deployment, since the local secret-store
file is not shipped. (Auto schema-apply on boot is a development convenience and does not run in
production.)

To copy configuration (agents, policies, the bot) from development to production by name, use the
sync helper — it upserts by name over HTTP, never copies secrets, and defaults to a dry run:

```bash
pnpm --filter @workspace/scripts run push-prod
```

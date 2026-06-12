# ContextOS

A single-user, multi-tenant context + MCP platform for AI agents: define agents, give them
isolated or shared context, connect tools via the Model Context Protocol (MCP), and run agents
over a web UI or external channels (Telegram, email). pnpm monorepo — Express API, React + Vite
web, PostgreSQL + Drizzle.

## Setup

Prerequisite: [pnpm](https://pnpm.io/) (`npm install -g pnpm` or `corepack enable`). Node 24
recommended.

1. **Set config** in the root `.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in two values:
   - `DATABASE_URL` — a Postgres connection string
   - one model-provider key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`

2. **Run:**
   ```bash
   ./run.sh
   ```

`./run.sh` installs dependencies and starts the API server, which applies the database schema and
auto-provisions the bot's model from your `.env` key on first boot. It prints the URL once the
agent is ready on `PORT` (default `8080`).

> On Replit, `DATABASE_URL` and provider keys are injected as secrets, so you can skip step 1 and
> just run `./run.sh`.

## Use the agent

- **Web UI:** with the API server running, start the web app:
  ```bash
  pnpm --filter @workspace/contextos run dev
  ```
  It serves at `http://localhost:5173` and proxies `/api` to the API server
  (default `http://localhost:8080`). Open the **Chat** page at `/chat`. Override
  the port with `WEB_PORT` or the API target with `API_PROXY_TARGET` if needed.
- **API:** create a conversation, then send it a message:
  ```bash
  # 1. create a conversation -> returns { "id": "<conversationId>" }
  curl -sX POST http://localhost:8080/api/conversations

  # 2. send a message
  curl -sX POST http://localhost:8080/api/conversations/<conversationId>/messages \
    -H 'content-type: application/json' \
    -d '{"content":"Hello"}'
  ```
- **Telegram:** chat with the bot from Telegram.
  1. Add `TELEGRAM_BOT_TOKEN` (from BotFather) to `.env`, then restart.
  2. Give Telegram a public **https** URL for the webhook (it can't reach
     localhost/dev preview), then register it: set `TELEGRAM_WEBHOOK_URL` so it
     registers on boot, or use the **Telegram** page (`/telegram`) or
     `POST /api/telegram/set-webhook`.

  Then DM your bot. It uses the same model as the web/API agent, and the webhook
  secret is derived from the token (nothing to set).

  **Get a public https URL with localtunnel:** with the server running on `PORT`
  (default 8080), open a second terminal and run:
  ```bash
  pnpm dlx localtunnel --port 8080
  ```
  It prints a public URL like `https://xyz.loca.lt`. Point the webhook at it:
  ```bash
  export TELEGRAM_WEBHOOK_URL=https://xyz.loca.lt/api/telegram/webhook
  ```
  Add `--subdomain <name>` to keep a stable URL across restarts. For a permanent
  setup, host the server publicly instead — run `./run.sh` behind HTTPS, or on
  Replit Publish the app and use its `.replit.app` URL.

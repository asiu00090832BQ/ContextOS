# ContextOS

[![Cross-platform setup](https://github.com/asiu00090832BQ/ContextOS/actions/workflows/cross-platform-setup.yml/badge.svg)](https://github.com/asiu00090832BQ/ContextOS/actions/workflows/cross-platform-setup.yml)

A single-user, multi-tenant context + MCP platform for AI agents: define agents, give them
isolated or shared context, connect tools via the Model Context Protocol (MCP), and run agents
over a web UI or external channels (Telegram, email). pnpm monorepo — Express API, React + Vite
web, PostgreSQL + Drizzle.

The clone-and-run steps below are exercised on every push by CI on Linux, macOS, and Windows
(see the badge above), so a fresh clone is verified to install and build on all three.

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

`./run.sh` installs dependencies, builds the web UI, and starts the server. On first boot it
applies the database schema and auto-provisions the bot's model from your `.env` key. Once it's
ready it prints a single URL (default `http://localhost:8080`) that serves **both the web UI and
the API** — open it in your browser.

> On Replit, `DATABASE_URL` and provider keys are injected as secrets, so you can skip step 1 and
> just run `./run.sh`.

### Advanced: run the web and API separately

For front-end development with hot reload, run the API alone and start the web dev server
yourself:

```bash
./run.sh --api-only                          # API only, on PORT (default 8080)
pnpm --filter @workspace/contextos run dev   # web dev server on :5173
```

The web dev server serves at `http://localhost:5173` and proxies `/api` to the API
(`http://localhost:8080`). Override the web port with `WEB_PORT` or the API target with
`API_PROXY_TARGET` if needed.

## Use the agent

- **Web UI:** open the URL from `./run.sh` (default `http://localhost:8080`, or
  `http://localhost:5173` in `--api-only` mode). Use the **Chat** page at `/chat`.
- **API:** the agent replies **asynchronously** — `POST .../messages` accepts your message and
  returns immediately; the reply arrives over a Server-Sent Events stream (or you can poll for it).
  Replace `8080` with `5173`'s API target if you're in `--api-only` mode.
  ```bash
  # 1. create a conversation -> returns { "id": "<conversationId>" }
  curl -sX POST http://localhost:8080/api/conversations

  # 2. (optional) in another terminal, stream replies for that conversation
  curl -N -H 'accept: text/event-stream' \
    http://localhost:8080/api/conversations/<conversationId>/events

  # 3. send a message (returns your own message; the agent reply is async)
  curl -sX POST http://localhost:8080/api/conversations/<conversationId>/messages \
    -H 'content-type: application/json' \
    -d '{"content":"Hello"}'

  # 4. or just poll the full transcript a moment later to read the reply
  curl -s http://localhost:8080/api/conversations/<conversationId>/messages
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
  It prints a public URL like `https://xyz.loca.lt` (leave this terminal open —
  closing it drops the tunnel). Then register the webhook against it. The tunnel
  terminal is busy, so do this from a **third** terminal:
  ```bash
  curl -sX POST http://localhost:8080/api/telegram/set-webhook \
    -H 'content-type: application/json' \
    -d '{"url":"https://xyz.loca.lt/api/telegram/webhook"}'
  ```
  Alternatively, put `TELEGRAM_WEBHOOK_URL=https://xyz.loca.lt/api/telegram/webhook`
  in `.env` and restart the server so it registers on boot (note: a free
  localtunnel URL changes each run — use `--subdomain <name>` to keep it stable).
  You can also register from the **Telegram** page (`/telegram`) in the web UI.

  For a permanent setup, host the server publicly instead — run `./run.sh` behind
  HTTPS, or on Replit Publish the app and use its `.replit.app` URL.

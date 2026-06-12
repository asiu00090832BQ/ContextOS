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
  1. Add `TELEGRAM_BOT_TOKEN` (from BotFather) to `.env`.
  2. Run `./run.sh`. On a local (non-Replit) run, when a bot token is present it
     automatically opens a public tunnel and registers it as the Telegram webhook
     — no extra terminals or commands. If no webhook is set yet (or it points
     elsewhere) it is set to the generated tunnel URL; if it already matches,
     nothing changes.

  Then DM your bot. It uses the same model as the web/API agent, and the webhook
  secret is derived from the token (nothing to set).

  **Choose a tunnel backend** with `TUNNEL_PROVIDER` in `.env`:
  - `localtunnel` (default) — the bundled
    [localtunnel](https://github.com/localtunnel/localtunnel) package
    (`https://<name>.loca.lt`). No account, but loca.lt may show a one-time
    browser reminder page and occasionally drops connections, which can
    intermittently break webhook delivery.
  - `cloudflared` — a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
    (`https://<random>.trycloudflare.com`). Valid TLS, no account, and generally
    more dependable — recommended if localtunnel is flaky. Requires the
    `cloudflared` binary on your PATH; if it isn't installed, `./run.sh` prints a
    clear message instead of silently failing. The URL is random per run and
    `TUNNEL_SUBDOMAIN` does not apply.

  **Keep the URL stable (localtunnel only):** set `TUNNEL_SUBDOMAIN=<name>` in
  `.env` to request a fixed `https://<name>.loca.lt` URL. `./run.sh` re-requests
  the same subdomain on every run, so the tunnel URL stays the same across
  restarts. Disable the auto-tunnel with `ENABLE_TUNNEL=0`, or change the tunnel
  server with `TUNNEL_HOST`. Note: loca.lt grants a requested subdomain only if
  it's free — pick a unique name and check the printed URL, since a taken name
  falls back to a random one.

  **Pin it so the webhook never goes stale (recommended for localtunnel):** once
  the subdomain is fixed the URL is predictable, so you can register it at boot:
  1. Set `TUNNEL_SUBDOMAIN=contextos-bot` (any unique name) in `.env`.
  2. Run `./run.sh` once and copy the printed `[tunnel] public URL:`
     (e.g. `https://contextos-bot.loca.lt`).
  3. Add `TELEGRAM_WEBHOOK_URL=https://contextos-bot.loca.lt/api/telegram/webhook`
     to `.env`.
  Every later run reuses the same URL, so the webhook is registered on startup and
  won't break when the tunnel reconnects. (The auto-tunnel also re-checks and
  corrects the webhook at runtime, so this step is a convenience, not required.)

  **Self-hosted option:** if you host the server publicly yourself, set
  `TELEGRAM_WEBHOOK_URL=https://<your-host>/api/telegram/webhook` in `.env` to
  register a webhook on boot, or use the **Telegram** page (`/telegram`) or
  `POST /api/telegram/set-webhook`.

  For a permanent setup, host the server publicly instead — run `./run.sh` behind
  HTTPS, or on Replit Publish the app and use its `.replit.app` URL.

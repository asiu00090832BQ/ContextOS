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

- **Web UI:** run it alongside the API, then open the **Chat** page at `/chat`:
  ```bash
  pnpm --filter @workspace/contextos run dev
  ```
- **API:** create a conversation, then send it a message:
  ```bash
  # 1. create a conversation -> returns { "id": "<conversationId>" }
  curl -sX POST http://localhost:8080/api/conversations

  # 2. send a message
  curl -sX POST http://localhost:8080/api/conversations/<conversationId>/messages \
    -H 'content-type: application/json' \
    -d '{"content":"Hello"}'
  ```

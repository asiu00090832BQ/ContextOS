#!/usr/bin/env bash
set -euo pipefail

# ContextOS — one-command setup + run.
# Bundles: ensure pnpm -> ensure config -> install deps -> run the API server.

cd "$(dirname "$0")"

# 1. Ensure pnpm is available.
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  else
    echo "pnpm not found. Install it: npm install -g pnpm" >&2
    exit 1
  fi
fi

# 2. Ensure config exists. Skip the .env requirement when DATABASE_URL is already
#    injected by the environment (e.g. Replit secrets).
if [ ! -f .env ] && [ -z "${DATABASE_URL:-}" ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "Set DATABASE_URL and one model-provider key in .env, then re-run ./run.sh" >&2
  exit 1
fi

# 3. Warn if no model-provider key is configured (in the environment or .env).
#    On Replit dev a keyless managed model is used as a fallback, so skip there.
has_provider_key() {
  local v val
  for v in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && return 0
    if [ -f .env ] && grep -Eq "^[[:space:]]*${v}[[:space:]]*=[[:space:]]*[^[:space:]\"']" .env; then
      return 0
    fi
  done
  return 1
}

if ! has_provider_key && [ -z "${REPL_ID:-}" ]; then
  echo "Warning: no model-provider key found (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY)." >&2
  echo "         The server will start, but the agent will have no model until you set one in .env." >&2
fi

# 4. Install dependencies.
pnpm install

# 5. Run the API server: builds, applies the DB schema, auto-provisions the bot
#    model from your .env key, and serves on PORT (default 8080).
PORT="${PORT:-8080}"
URL="http://localhost:${PORT}"

pnpm --filter @workspace/api-server run dev &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null; exit' INT TERM

# Announce the URL once the server is accepting connections.
for _ in $(seq 1 90); do
  if curl -sS -o /dev/null "${URL}/" 2>/dev/null; then
    echo ""
    echo "ContextOS is up: ${URL}"
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done

wait "$SERVER_PID"

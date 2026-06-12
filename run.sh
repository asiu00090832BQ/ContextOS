#!/usr/bin/env bash
set -euo pipefail

# ContextOS — one-command setup + run.
#
# Default (beginner) mode: install deps -> build the web UI -> start the API
# server, which serves BOTH the API and the web UI at a single URL.
#
# Advanced mode (--api-only): start the API server alone and run the web app as
# a separate process (pnpm --filter @workspace/contextos run dev). Useful for
# front-end development with hot reload.

cd "$(dirname "$0")"

API_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --api-only) API_ONLY=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./run.sh [--api-only]

  (default)    Build the web UI and serve the full app (UI + API) at one URL.
  --api-only   Start only the API server; run the web app separately with
               `pnpm --filter @workspace/contextos run dev`.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done

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

# 5. Default mode: build the web UI and have the API serve it at the root path.
#    --api-only skips this; you run the web dev server yourself.
if [ "$API_ONLY" -eq 0 ]; then
  echo "Building the web UI..."
  pnpm --filter @workspace/contextos run build
  export CONTEXTOS_WEB_DIR="${PWD}/artifacts/contextos/dist/public"
fi

# 6. Run the API server: builds, applies the DB schema, auto-provisions the bot
#    model from your .env key, and serves on PORT (default 8080). In default mode
#    it also serves the web UI (via CONTEXTOS_WEB_DIR) at the same URL.
PORT="${PORT:-8080}"
URL="http://localhost:${PORT}"

pnpm --filter @workspace/api-server run dev &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null; exit' INT TERM

# Announce the URL once the server is accepting connections.
for _ in $(seq 1 90); do
  if curl -sS -o /dev/null "${URL}/api/healthz" 2>/dev/null; then
    echo ""
    if [ "$API_ONLY" -eq 0 ]; then
      echo "ContextOS is up: ${URL}  (open this in your browser)"
    else
      echo "ContextOS API is up: ${URL}/api"
      echo "Start the web UI with: pnpm --filter @workspace/contextos run dev"
    fi
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done

wait "$SERVER_PID"

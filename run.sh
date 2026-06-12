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

# 3. Install dependencies.
pnpm install

# 4. Run the API server: builds, applies the DB schema, auto-provisions the bot
#    model from your .env key, and serves on PORT (default 8080).
exec pnpm --filter @workspace/api-server run dev

#!/usr/bin/env bash
#
# Open a public tunnel to the local server with the `localtunnel` package and
# register the resulting URL as the Telegram webhook. Designed to be launched in
# the background by run.sh, but it can also be run on its own while the server is
# already up.
#
# Behaviour:
#   - Tunnels the same PORT the server binds to (default 8080).
#   - Requests a fixed subdomain (TUNNEL_SUBDOMAIN) so the URL is stable across
#     restarts; loca.lt grants it when free, otherwise it assigns one and we use
#     whatever URL it actually returns.
#   - Reads the currently-registered Telegram webhook and, if it is missing or
#     points somewhere else, sets it to the generated tunnel URL. If it already
#     matches, nothing changes.
#
# Note: loca.lt may serve a one-time browser reminder page; non-browser callers
# such as Telegram generally pass through. For a rock-solid setup, host the
# server publicly instead (see the README).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
LOCAL_URL="http://localhost:${PORT}"
SUBDOMAIN="${TUNNEL_SUBDOMAIN:-}"
TUNNEL_HOST="${TUNNEL_HOST:-https://localtunnel.me}"
LT_LOG="${TMPDIR:-/tmp}/contextos-tunnel.log"

# Prefer the binary installed at the workspace root; fall back to `pnpm exec`.
run_lt() {
  if [ -x "node_modules/.bin/lt" ]; then
    node_modules/.bin/lt "$@"
  else
    pnpm exec lt "$@"
  fi
}

LT_ARGS=(--port "$PORT" --host "$TUNNEL_HOST")
if [ -n "$SUBDOMAIN" ]; then
  LT_ARGS+=(--subdomain "$SUBDOMAIN")
fi

echo "[tunnel] opening public tunnel to ${LOCAL_URL} ..."
: > "$LT_LOG"
run_lt "${LT_ARGS[@]}" >"$LT_LOG" 2>&1 &
LT_PID=$!

# Always tear the tunnel down when this script stops.
trap 'kill -TERM "$LT_PID" 2>/dev/null || true' INT TERM EXIT

# Wait for localtunnel to print its public URL.
PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -oE 'https://[A-Za-z0-9.-]+' "$LT_LOG" | head -n1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$LT_PID" 2>/dev/null; then
    echo "[tunnel] localtunnel exited before printing a URL:" >&2
    cat "$LT_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "[tunnel] could not determine the tunnel URL. localtunnel output:" >&2
  cat "$LT_LOG" >&2 || true
  exit 1
fi

WEBHOOK_URL="${PUBLIC_URL}/api/telegram/webhook"
echo "[tunnel] public URL: ${PUBLIC_URL}"

# Wait until the local API is healthy before touching the webhook; abort if it
# never comes up rather than reporting a half-configured webhook.
HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${LOCAL_URL}/api/healthz" 2>/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  echo "[tunnel] local API never became healthy at ${LOCAL_URL}; aborting webhook setup" >&2
  exit 1
fi

# Read the currently-registered webhook (empty if none).
CURRENT_URL="$(curl -fsS "${LOCAL_URL}/api/telegram/status" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.webhook&&j.webhook.url)||"")}catch{process.stdout.write("")}})' 2>/dev/null || true)"

if [ "$CURRENT_URL" = "$WEBHOOK_URL" ]; then
  echo "[tunnel] Telegram webhook already set to ${WEBHOOK_URL}"
else
  if [ -n "$CURRENT_URL" ]; then
    echo "[tunnel] updating Telegram webhook: ${CURRENT_URL} -> ${WEBHOOK_URL}"
  else
    echo "[tunnel] no Telegram webhook set; registering ${WEBHOOK_URL}"
  fi
  if RESP="$(curl -fsS -X POST "${LOCAL_URL}/api/telegram/set-webhook" \
    -H 'content-type: application/json' \
    -d "{\"url\":\"${WEBHOOK_URL}\"}" 2>&1)"; then
    echo "[tunnel] webhook registered: ${RESP}"
  else
    echo "[tunnel] FAILED to register Telegram webhook: ${RESP}" >&2
    exit 1
  fi
fi

echo "[tunnel] webhook ready: ${WEBHOOK_URL} (tunnel pid ${LT_PID}; keep ./run.sh running)"

# Keep the tunnel alive; run.sh terminates this script (and thus the tunnel) on exit.
wait "$LT_PID"

#!/usr/bin/env bash
#
# Open a public tunnel to the local server and register the resulting URL as the
# Telegram webhook. Designed to be launched in the background by run.sh, but it
# can also be run on its own while the server is already up.
#
# Two tunnel backends are supported, chosen with TUNNEL_PROVIDER:
#   - localtunnel (default) — the bundled `lt` package; URLs look like
#     https://<subdomain>.loca.lt. No account needed, but loca.lt may serve a
#     one-time browser "reminder" interstitial and occasionally drops
#     connections, which can intermittently break webhook delivery.
#   - cloudflared — Cloudflare's quick tunnel (`cloudflared tunnel --url ...`);
#     URLs look like https://<random>.trycloudflare.com. Valid TLS, no account,
#     and generally more dependable. Requires the `cloudflared` binary on PATH.
#
# Behaviour (both providers):
#   - Tunnels the same PORT the server binds to (default 8080).
#   - Waits for the provider to print its public https URL, then waits until the
#     local API is healthy.
#   - Reads the currently-registered Telegram webhook and, if it is missing or
#     points somewhere else, sets it to the generated tunnel URL. If it already
#     matches, nothing changes (idempotent).
#
# For a rock-solid setup, host the server publicly instead (see the README).
set -euo pipefail
cd "$(dirname "$0")/.."

# Pull tunnel-related config from the root .env when it isn't already present in
# the environment. Environment values always take precedence (matching run.sh
# and the API server), so this only fills the gaps — which means selecting a
# backend with TUNNEL_PROVIDER=... in .env works whether this script is launched
# by run.sh or on its own.
load_from_env_file() {
  local var="$1" file=".env" line val
  [ -n "${!var:-}" ] && return 0
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*${var}[[:space:]]*=" "$file" | tail -n1 || true)"
  [ -n "$line" ] || return 0
  val="${line#*=}"
  val="${val%%$'\r'}"
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  export "$var=$val"
}
for _v in PORT TUNNEL_PROVIDER TUNNEL_SUBDOMAIN TUNNEL_HOST TELEGRAM_WEBHOOK_URL; do
  load_from_env_file "$_v"
done

PORT="${PORT:-8080}"
LOCAL_URL="http://localhost:${PORT}"
PROVIDER="${TUNNEL_PROVIDER:-localtunnel}"
SUBDOMAIN="${TUNNEL_SUBDOMAIN:-}"
TUNNEL_HOST="${TUNNEL_HOST:-https://localtunnel.me}"
TUNNEL_LOG="${TMPDIR:-/tmp}/contextos-tunnel.log"

# Prefer the localtunnel binary installed at the workspace root; fall back to
# `pnpm exec`.
run_lt() {
  if [ -x "node_modules/.bin/lt" ]; then
    node_modules/.bin/lt "$@"
  else
    pnpm exec lt "$@"
  fi
}

# Launch the chosen provider in the background, writing its output to TUNNEL_LOG.
# Sets TUNNEL_PID and URL_REGEX (the pattern used to scrape the public URL).
start_provider() {
  : > "$TUNNEL_LOG"
  case "$PROVIDER" in
    localtunnel|lt)
      if [ ! -x "node_modules/.bin/lt" ] && ! pnpm exec lt --version >/dev/null 2>&1; then
        echo "[tunnel] TUNNEL_PROVIDER=localtunnel but the 'lt' binary isn't available." >&2
        echo "[tunnel] Run 'pnpm install' first, or set TUNNEL_PROVIDER=cloudflared." >&2
        exit 1
      fi
      local lt_args=(--port "$PORT" --host "$TUNNEL_HOST")
      [ -n "$SUBDOMAIN" ] && lt_args+=(--subdomain "$SUBDOMAIN")
      echo "[tunnel] opening localtunnel to ${LOCAL_URL} ..."
      run_lt "${lt_args[@]}" >"$TUNNEL_LOG" 2>&1 &
      TUNNEL_PID=$!
      # localtunnel only prints its own URL, so match the first https URL. This
      # stays correct when TUNNEL_HOST points at a non-loca.lt localtunnel server.
      URL_REGEX='https://[A-Za-z0-9.-]+'
      ;;
    cloudflared|cloudflare)
      if ! command -v cloudflared >/dev/null 2>&1; then
        echo "[tunnel] TUNNEL_PROVIDER=cloudflared but the 'cloudflared' binary isn't installed." >&2
        echo "[tunnel] Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)" >&2
        echo "[tunnel] or set TUNNEL_PROVIDER=localtunnel to use the bundled tunnel." >&2
        exit 1
      fi
      [ -n "$SUBDOMAIN" ] && echo "[tunnel] note: TUNNEL_SUBDOMAIN is ignored for cloudflared quick tunnels (a random *.trycloudflare.com URL is assigned)." >&2
      echo "[tunnel] opening cloudflared quick tunnel to ${LOCAL_URL} ..."
      cloudflared tunnel --no-autoupdate --url "$LOCAL_URL" >"$TUNNEL_LOG" 2>&1 &
      TUNNEL_PID=$!
      URL_REGEX='https://[A-Za-z0-9.-]+\.trycloudflare\.com'
      ;;
    *)
      echo "[tunnel] unknown TUNNEL_PROVIDER='${PROVIDER}' (expected 'localtunnel' or 'cloudflared')." >&2
      exit 1
      ;;
  esac
}

start_provider

# Always tear the tunnel down when this script stops.
trap 'kill -TERM "$TUNNEL_PID" 2>/dev/null || true' INT TERM EXIT

# Wait for the provider to print its public URL.
PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -oE "$URL_REGEX" "$TUNNEL_LOG" | head -n1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "[tunnel] ${PROVIDER} exited before printing a URL:" >&2
    cat "$TUNNEL_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "[tunnel] could not determine the tunnel URL. ${PROVIDER} output:" >&2
  cat "$TUNNEL_LOG" >&2 || true
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

echo "[tunnel] webhook ready: ${WEBHOOK_URL} (${PROVIDER} pid ${TUNNEL_PID}; keep ./run.sh running)"

# Warn when localtunnel could not grant the requested subdomain and fell back to a
# different (random) URL. loca.lt subdomains are globally unique, so a requested
# name that is already taken yields a random URL — which is NOT stable across runs.
if [ "$PROVIDER" = "localtunnel" ] && [ -n "$SUBDOMAIN" ]; then
  GRANTED_HOST="${PUBLIC_URL#https://}"
  GRANTED_HOST="${GRANTED_HOST#http://}"
  GRANTED_SUBDOMAIN="${GRANTED_HOST%%.*}"
  if [ "$GRANTED_SUBDOMAIN" != "$SUBDOMAIN" ]; then
    echo "[tunnel] WARNING: requested subdomain '${SUBDOMAIN}' was unavailable, so loca.lt"
    echo "[tunnel]          assigned '${GRANTED_SUBDOMAIN}' instead. This URL is NOT stable"
    echo "[tunnel]          across runs. Set TUNNEL_SUBDOMAIN in .env to a unique name to"
    echo "[tunnel]          claim a stable URL."
  fi
fi

# Always print the exact webhook URL to copy into .env, in a clearly delimited
# block, so it is easy to find even when TELEGRAM_WEBHOOK_URL is already set (e.g.
# to a now-stale value you need to update).
echo "[tunnel] ----------------------------------------------------------------"
echo "[tunnel] Telegram webhook URL — paste this line into .env:"
echo "[tunnel]"
echo "[tunnel]   TELEGRAM_WEBHOOK_URL=${WEBHOOK_URL}"
echo "[tunnel]"
echo "[tunnel] ----------------------------------------------------------------"

# Keep the tunnel alive; run.sh terminates this script (and thus the tunnel) on exit.
wait "$TUNNEL_PID"

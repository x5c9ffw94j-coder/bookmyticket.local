#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-auto}" # auto | cloudflare | serveo | localtunnel
SERVER_STARTED_BY_SCRIPT="false"
SERVER_PID=""

cleanup() {
  if [ "${SERVER_STARTED_BY_SCRIPT}" = "true" ] && [ -n "${SERVER_PID}" ]; then
    if kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
      kill "${SERVER_PID}" >/dev/null 2>&1 || true
    fi
  fi
}

trap cleanup EXIT INT TERM

wait_for_health() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Server not running on port ${PORT}. Starting it now..."
  HOST="${HOST}" PORT="${PORT}" node server/index.js >/tmp/bookmyticket-server.log 2>&1 &
  SERVER_PID="$!"
  SERVER_STARTED_BY_SCRIPT="true"
  if ! wait_for_health; then
    echo "Server failed to start. Last log lines:"
    tail -n 30 /tmp/bookmyticket-server.log || true
    exit 1
  fi
fi

PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
EDGE_IP_VERSION="${CLOUDFLARED_EDGE_IP_VERSION:-4}"
CLOUDFLARED_RETRIES="${CLOUDFLARED_RETRIES:-2}"

if [ "${TUNNEL_PROVIDER}" = "auto" ] || [ "${TUNNEL_PROVIDER}" = "cloudflare" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
  echo "Creating public URL via Cloudflare for http://localhost:${PORT} ..."
  echo "Using protocol=${PROTOCOL}, edge-ip-version=${EDGE_IP_VERSION}, retries=${CLOUDFLARED_RETRIES}"
  echo "Keep this terminal open while sharing the URL."
  if cloudflared tunnel \
    --url "http://127.0.0.1:${PORT}" \
    --protocol "${PROTOCOL}" \
    --edge-ip-version "${EDGE_IP_VERSION}" \
    --retries "${CLOUDFLARED_RETRIES}" \
    --no-autoupdate; then
    exit 0
  fi
  echo "Cloudflare tunnel failed. Trying free fallback..."
  else
    echo "cloudflared not installed, skipping Cloudflare."
  fi
fi

if { [ "${TUNNEL_PROVIDER}" = "auto" ] || [ "${TUNNEL_PROVIDER}" = "serveo" ]; } && \
  [ -x "scripts/start-stable-mobile-tunnel.sh" ] && command -v ssh >/dev/null 2>&1; then
  echo "Starting Serveo fallback tunnel..."
  exec bash scripts/start-stable-mobile-tunnel.sh "${SERVEO_SUBDOMAIN:-bookmyticket}"
fi

if { [ "${TUNNEL_PROVIDER}" = "auto" ] || [ "${TUNNEL_PROVIDER}" = "localtunnel" ]; } && \
  command -v npx >/dev/null 2>&1; then
  echo "Starting LocalTunnel fallback..."
  exec npx --yes localtunnel --port "${PORT}"
fi

echo "No tunnel method available."
echo "Install one of: cloudflared, ssh (Serveo), or Node+npx (LocalTunnel)."
exit 1
